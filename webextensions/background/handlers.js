/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

function onToolbarButtonClick(aTab) {
  if (gSidebarOpenState[aTab.windowId]) {
    // "unload" event doesn't fire for sidebar closed by this method,
    // thus we need update the flag manually for now...
    delete gSidebarOpenState[aTab.windowId];
    browser.sidebarAction.close();
  }
  else
    browser.sidebarAction.open();
}

// raw event handlers

async function onTabOpening(aTab, aInfo = {}) {
  log('onTabOpening ', dumpTab(aTab), aInfo);
  var container = aTab.parentNode;
  if (container.openedNewTabsTimeout)
    clearTimeout(container.openedNewTabsTimeout);

  // ignore tabs opened from others
  if (configs.autoGroupNewTabs &&
      !aTab.apiTab.openerTabId &&
      !aInfo.maybeOrphan) {
    container.openedNewTabs.push(aTab.id);
    container.openedNewTabsTimeout = setTimeout(
      onNewTabsTimeout,
      configs.autoGroupNewTabsTimeout,
      container
    );
  }

  var opener = getTabById({ tab: aTab.apiTab.openerTabId, window: aTab.apiTab.windowId });
  if (opener &&
      configs.autoAttach &&
      !aInfo.duplicatedInternally) {
    log('opener: ', dumpTab(opener), aInfo.maybeOpenedWithPosition);
    behaveAutoAttachedTab(aTab, {
      baseTab:  opener,
      behavior: configs.autoAttachOnOpenedWithOwner,
      dontMove: aInfo.maybeOpenedWithPosition
    });
  }
}

async function behaveAutoAttachedTab(aTab, aOptions = {}) {
  var baseTab = aOptions.baseTab || getCurrentTab();
  switch (aOptions.behavior) {
    case kNEWTAB_OPEN_AS_ORPHAN:
    default:
      break;

    case kNEWTAB_OPEN_AS_CHILD:
      await attachTabTo(aTab, baseTab, {
        dontMove: aOptions.dontMove,
        broadcast: true
      });
      return true;
      break;

    case kNEWTAB_OPEN_AS_SIBLING: {
      let parent = getParentTab(baseTab);
      if (parent) {
        await attachTabTo(aTab, parent, {
          broadcast: true
        });
      }
      else {
        detachTab(aTab, {
          broadcast: true
        });
        await moveTabInternallyAfter(aTab, baseTab || getLastTab());
      }
      return true;
    }; break;

    case kNEWTAB_OPEN_AS_NEXT_SIBLING: {
      let nextSibling = getNextSiblingTab(baseTab);
      let parent = getParentTab(baseTab);
      if (parent)
        await attachTabTo(aTab, parent, {
          insertBefore: nextSibling,
          insertAfter: !nextSibling && baseTab,
          broadcast: true
        });
      else {
        detachTab(aTab, {
          broadcast: true
        });
        if (nextSibling)
          await moveTabInternallyBefore(aTab, nextSibling);
        else
          await moveTabInternallyAfter(aTab, baseTab);
      }
   }; break;
  }
}

async function onNewTabsTimeout(aContainer) {
  var newRootTabs = collectRootTabs(aContainer.openedNewTabs.map(getTabById));
  aContainer.openedNewTabs = [];
  if (newRootTabs.length <= 1)
    return;

  log(`onNewTabsTimeout: ${newRootTabs.length} root tabs are opened`);
  var title = browser.i18n.getMessage('groupTab.label', newRootTabs[0].apiTab.title);
  var uri = makeGroupTabURI(title, {
    temporary: true
  });
  var groupTab = await openURIInTab(uri, {
    windowId: aContainer.windowId,
    insertBefore: newRootTabs[0],
    insertAfter: getPreviousTab(newRootTabs[0])
  });
  for (let tab of newRootTabs) {
    await attachTabTo(tab, groupTab, {
      dontMove: true,
      broadcast: true
    });
  }
}

function onTabOpened(aTab, aInfo = {}) {
  log('onTabOpened ', dumpTab(aTab), aInfo);
  if (aInfo.duplicated) {
    let original = aInfo.originalTab;
    log('duplicated ', dumpTab(aTab), dumpTab(original));
    if (aInfo.duplicatedInternally) {
      log('duplicated by internal operation');
      aTab.classList.add(kTAB_STATE_DUPLICATING);
      broadcastTabState(aTab, {
        add: [kTAB_STATE_DUPLICATING]
      });
    }
    else {
      behaveAutoAttachedTab(aTab, {
        baseTab:  original,
        behavior: configs.autoAttachOnDuplicated,
        dontMove: aInfo.openedWithPosition
      });
    }
  }
  else {
    // if the tab is opened inside existing tree by someone, we must fixup the tree.
    if (!aInfo.openedWithPosition &&
        aTab.nextSibling)
      tryFixupTreeForInsertedTab(aTab, {
        toIndex:   aTab.apiTab.index,
        fromIndex: getTabIndex(aTab.nextSibling)
      });
  }

  reserveToSaveTreeStructure(aTab);
}

function onTabRestored(aTab) {
  log('restored ', dumpTab(aTab), aTab.apiTab);
  return attachTabFromRestoredInfo(aTab, {
           children: true
         });
}

async function onTabClosed(aTab, aCloseInfo = {}) {
  var ancestors = getAncestorTabs(aTab);
  var closeParentBehavior = getCloseParentBehaviorForTab(aTab);
  if (closeParentBehavior == kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN)
    await closeChildTabs(aTab);

  if (closeParentBehavior == kCLOSE_PARENT_BEHAVIOR_REPLACE_WITH_GROUP_TAB &&
      getChildTabs(aTab).length > 1) {
    log('trying to replace the closing tab with a new group tab');
    let firstChild = getFirstChildTab(aTab);
    let label = browser.i18n.getMessage('groupTab.label', firstChild.apiTab.title);
    let uri = makeGroupTabURI(label, {
      temporary: true
    });
    let groupTab = await openURIInTab(uri, {
      insertBefore: aTab // not firstChild, because the "aTab" is disappeared from tree.
    });
    log('group tab: ', dumpTab(groupTab));
    await attachTabTo(groupTab, aTab, {
      insertBefore: firstChild
    });
    closeParentBehavior = kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;
  }

  detachAllChildren(aTab, {
    behavior: closeParentBehavior,
    broadcast: true
  });
  //reserveCloseRelatedTabs(toBeClosedTabs);
  detachTab(aTab, {
    dontUpdateIndent: true,
    broadcast: true
  });

  setTimeout(() => {
    log('trying to clanup needless temporary group tabs from ', ancestors.map(dumpTab));
    var tabsToBeRemoved = [];
    for (let ancestor of ancestors) {
      if (!isTemporaryGroupTab(ancestor))
        break;
      if (getChildTabs(ancestor).length > 1)
        break;
      let lastChild = getFirstChildTab(ancestor);
      if (lastChild && !isTemporaryGroupTab(lastChild))
        break;
      tabsToBeRemoved.push(ancestor);
    }
    log('=> to be removed: ', tabsToBeRemoved.map(dumpTab));
    for (let tab of tabsToBeRemoved) {
      browser.tabs.remove(tab.apiTab.id);
    }
  }, 0);

  reserveToSaveTreeStructure(aTab);
}

async function closeChildTabs(aParent) {
  var tabs = getDescendantTabs(aParent);
  //if (!fireTabSubtreeClosingEvent(aParent, tabs))
  //  return;

  aParent.parentNode.toBeClosedTabs += tabs.length;

  //markAsClosedSet([aParent].concat(tabs));
  await Promise.all(tabs.reverse().map(aTab => {
    return browser.tabs.remove(aTab.apiTab.id)
             .catch(handleMissingTabError);
  }));
  //fireTabSubtreeClosedEvent(aParent, tabs);
}

function onTabMoving(aTab, aMoveInfo) {
  var container = getTabsContainer(aTab);
  var positionControlled = configs.insertNewChildAt != kINSERT_NO_CONTROL;
  if (container.openingCount > 0 &&
      !aMoveInfo.byInternalOperation &&
      positionControlled) {
    log('onTabMove for new child tab: move back '+aMoveInfo.toIndex+' => '+aMoveInfo.fromIndex);
    moveBack(aTab, aMoveInfo);
    return true;
  }
}

async function onTabMoved(aTab, aMoveInfo) {
  reserveToSaveTreeStructure(aTab);
  reserveToUpdateInsertionPosition([
    aTab,
    aMoveInfo.oldPreviousTab,
    aMoveInfo.oldNextTab
  ]);

  var container = getTabsContainer(aTab);
  if (aMoveInfo.byInternalOperation ||
      isDuplicating(aTab)) {
    log('internal move');
    return;
  }
  log('process moved tab');

  tryFixupTreeForInsertedTab(aTab, aMoveInfo);
}

async function tryFixupTreeForInsertedTab(aTab, aMoveInfo) {
  log('the tab can be placed inside existing tab unexpectedly, so now we are trying to fixup tree.');
  var action = await detectTabActionFromNewPosition(aTab, aMoveInfo);
  if (!action) {
    log('no action');
    return;
  }

  log('action: ', action);
  switch (action.action) {
    case 'moveBack':
      moveBack(aTab, aMoveInfo);
      return;

    case 'attach': {
      await attachTabTo(aTab, getTabById(action.parent), {
        insertBefore: getTabById(action.insertBefore),
        insertAfter:  getTabById(action.insertAfter),
        broadcast: true
      });
      followDescendantsToMovedRoot(aTab);
    }; break;

    case 'detach': {
      detachTab(aTab, { broadcast: true });
      followDescendantsToMovedRoot(aTab);
    }; break;

    default:
      followDescendantsToMovedRoot(aTab);
      break;
  }
}

async function moveBack(aTab, aMoveInfo) {
  log('Move back tab from unexpected move: ', dumpTab(aTab), aMoveInfo);
  var container = aTab.parentNode;
  container.internalMovingCount++;
  await browser.tabs.move(aTab.apiTab.id, {
    windowId: aMoveInfo.windowId,
    index: aMoveInfo.fromIndex
  });
}

async function detectTabActionFromNewPosition(aTab, aMoveInfo) {
  log('detectTabActionFromNewPosition: ', dumpTab(aTab), aMoveInfo);
  var toIndex = aMoveInfo.toIndex;
  var fromIndex = aMoveInfo.fromIndex;
  var delta;
  if (toIndex == fromIndex) { // no move?
    log('=> no move');
    return { action: null };
  }
  else if (toIndex < 0 || fromIndex < 0) {
    delta = 2;
  }
  else {
    delta = Math.abs(toIndex - fromIndex);
  }

  var prevTab = getPreviousNormalTab(aTab);
  var nextTab = getNextNormalTab(aTab);

  log('prevTab: ', dumpTab(prevTab));
  log('nextTab: ', dumpTab(nextTab));

  var prevParent = getParentTab(prevTab);
  var nextParent = getParentTab(nextTab);

  var prevLevel  = prevTab ? Number(prevTab.getAttribute(kLEVEL)) : -1 ;
  var nextLevel  = nextTab ? Number(nextTab.getAttribute(kLEVEL)) : -1 ;
  log('prevLevel: '+prevLevel);
  log('nextLevel: '+nextLevel);

  var oldParent = getParentTab(aTab);
  var newParent;

  if (oldParent &&
      prevTab &&
      oldParent == prevTab) {
    log('=> no need to fix case');
    newParent = oldParent;
  }
  else if (!prevTab) {
    log('=> moved to topmost position');
    newParent = null;
  }
  else if (!nextTab) {
    log('=> moved to last position');
    newParent = prevParent;
  }
  else if (prevParent == nextParent) {
    log('=> moved into existing tree');
    newParent = prevParent;
  }
  else if (prevLevel > nextLevel) {
    log('=> moved to end of existing tree');
    if (!isActive(aTab)) {
      log('=> maybe newly opened tab');
      newParent = prevParent;
    }
    else {
      log('=> maybe drag and drop');
      let realDelta = Math.abs(toIndex - fromIndex);
      newParent = realDelta < 2 ? prevParent : (oldParent || nextParent) ;
    }
  }
  else if (prevLevel < nextLevel) {
    log('=> moved to first child position of existing tree');
    newParent = prevTab || oldParent || nextParent;
  }

  log('calculated parent: ', {
    old: dumpTab(oldParent),
    new: dumpTab(newParent)
  });

  if (newParent == aTab ||
      getAncestorTabs(newParent).indexOf(aTab) > -1) {
    log('=> invalid move: a parent is moved inside its own tree, thus move back!');
    return { action: 'moveBack' };
  }

  if (newParent != oldParent) {
    if (newParent) {
      if (isHidden(newParent) == isHidden(aTab)) {
        return {
          action: 'attach',
          parent: newParent.id,
          insertBefore: nextTab && nextTab.id,
          insertAfter:  prevTab && prevTab.id
        };
      }
    }
    else {
      return { action: 'detach' };
    }
  }
  return { action: 'move' };
}

function onTabFocusing(aTab, aInfo = {}) {
  if (isCollapsed(aTab)) {
    if (configs.autoExpandOnCollapsedChildFocused) {
      for (let ancestor of getAncestorTabs(aTab)) {
        collapseExpandSubtree(ancestor, {
          collapsed: false,
          broadcast: true
        });
      }
      handleNewActiveTab(aTab, aInfo);
    }
    else {
      selectTabInternally(getRootTab(aTab));
      return true;
    }
  }
  else if (/**
            * Focus movings by closing of the old current tab should be handled
            * only when it is activated by user preference expressly.
            */
           aInfo.byCurrentTabRemove &&
           configs.autoCollapseExpandSubtreeOnSelectExceptCurrentTabRemove) {
    return true;
  }
  else if (hasChildTabs(aTab) && isSubtreeCollapsed(aTab)) {
    handleNewActiveTab(aTab, aInfo);
  }
  return false;
}
function handleNewActiveTab(aTab, aInfo = {}) {
  if (aTab.parentNode.doingCollapseExpandCount != 0)
    return;

  log('handleNewActiveTab: ', dumpTab(aTab));

  if (handleNewActiveTab.timer)
    clearTimeout(handleNewActiveTab.timer);

  /**
   * First, we wait until all event listeners for tabs.onSelect
   * were processed.
   */
  handleNewActiveTab.timer = setTimeout(() => {
    if (!aTab.parentNode) // it was removed while waiting
      return;
    delete handleNewActiveTab.timer;
    var shouldCollapseExpandNow = configs.autoCollapseExpandSubtreeOnSelect;
    var canCollapseTree = shouldCollapseExpandNow;
    var canExpandTree   = shouldCollapseExpandNow && !aInfo.byInternalOperation;
    log('handleNewActiveTab[delayed]: ', dumpTab(aTab), {
      canCollapseTree, canExpandTree, byInternalOperation: aInfo.byInternalOperation });
    if (canExpandTree) {
      if (canCollapseTree &&
          configs.autoExpandIntelligently)
        collapseExpandTreesIntelligentlyFor(aTab, {
          broadcast: true
        });
      else
        collapseExpandSubtree(aTab, {
          collapsed: false,
          broadcast: true
        });
    }
  }, 0);
}

function onTabFocused(aTab, aInfo = {}) {
  var tab = aInfo.previouslyFocusedTab;
  if (!tab)
    return;
  tab.classList.add(kTAB_STATE_POSSIBLE_CLOSING_CURRENT);
  setTimeout(() => {
    var possibleClosingCurrents = document.querySelectorAll(`.${kTAB_STATE_POSSIBLE_CLOSING_CURRENT}`);
    for (let tab of possibleClosingCurrents) {
      tab.classList.remove(kTAB_STATE_POSSIBLE_CLOSING_CURRENT);
    }
  }, 100);
}

function onTabUpdated(aTab) {
  reserveToSaveTreeStructure(aTab);
}

function onTabCollapsedStateChanging(aTab, aInfo = {}) {
  if (aInfo.collapsed)
    aTab.classList.add(kTAB_STATE_COLLAPSED_DONE);
  else
    aTab.classList.remove(kTAB_STATE_COLLAPSED_DONE);
}

function onTabAttached(aTab) {
  reserveToSaveTreeStructure(aTab);
  reserveToUpdateAncestors([aTab].concat(getDescendantTabs(aTab)));
  reserveToUpdateChildren(getParentTab(aTab));
  reserveToUpdateInsertionPosition([
    aTab,
    getNextTab(aTab),
    getPreviousTab(aTab)
  ]);
}

function onTabDetached(aTab, aDetachInfo) {
  reserveToSaveTreeStructure(aTab);
  reserveToUpdateAncestors([aTab].concat(getDescendantTabs(aTab)));
  reserveToUpdateChildren(aDetachInfo.oldParentTab);
}

function onTabDetachedFromWindow(aTab) {
  var closeParentBehavior = getCloseParentBehaviorForTab(aTab);
  if (closeParentBehavior == kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN)
    closeParentBehavior = kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;

  detachAllChildren(aTab, {
    behavior: closeParentBehavior,
    broadcast: true
  });
  //reserveCloseRelatedTabs(toBeClosedTabs);
  detachTab(aTab, {
    dontUpdateIndent: true,
    broadcast: true
  });
  //restoreTabAttributes(aTab, backupAttributes);
}

function onTabPinned(aTab) {
  collapseExpandSubtree(aTab, {
    collapsed: false,
    broadcast: true
  });
  detachAllChildren(aTab, {
    behavior: getCloseParentBehaviorForTab(
      aTab,
      kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD
    ),
    broadcast: true
  });
  detachTab(aTab, {
    broadcast: true
  });
  collapseExpandTab(aTab, { collapsed: false });
}


/* message observer */

function onMessage(aMessage, aSender) {
  if (!aMessage ||
      typeof aMessage.type != 'string' ||
      aMessage.type.indexOf('treestyletab:') != 0)
    return;

  var timeout = setTimeout(() => {
    log('onMessage: timeout! ', aMessage, aSender);
  }, 10 * 1000);

  //log('onMessage: ', aMessage, aSender);
  switch (aMessage.type) {
    case kCOMMAND_PING:
      return Promise.resolve(true);

    case kCOMMAND_SIDEBAR_OPENED:
      gSidebarOpenState[aMessage.windowId] = true;
      break;

    case kCOMMAND_SIDEBAR_CLOSED:
      delete gSidebarOpenState[aMessage.windowId];
      break;

    case kCOMMAND_REQUEST_UNIQUE_ID:
      return (async () => {
        let id = await requestUniqueId(aMessage.id, {
          forceNew: aMessage.forceNew
        });
        clearTimeout(timeout);
        return id;
      })();

    case kCOMMAND_PULL_TREE_STRUCTURE:
      return (async () => {
        while (gInitializing) {
          await wait(10);
        }
        let structure = getTreeStructureFromTabs(getAllTabs(aMessage.windowId));
        clearTimeout(timeout);
        return { structure: structure };
      })();

    case kCOMMAND_CHANGE_SUBTREE_COLLAPSED_STATE: {
      let tab = getTabById(aMessage.tab);
      if (!tab) {
        clearTimeout(timeout);
        return;
      }
      let params = {
        collapsed: aMessage.collapsed,
        justNow:   aMessage.justNow,
        broadcast: true
      };
      if (aMessage.manualOperation)
        manualCollapseExpandSubtree(tab, params);
      else
        collapseExpandSubtree(tab, params);
      reserveToSaveTreeStructure(tab);
    }; break;

    case kCOMMAND_LOAD_URI: {
      // not implemented yet.
    }; break;

    case kCOMMAND_NEW_TABS:
      return (async () => {
        log('new tabs requested: ', aMessage);
        return await openURIsInTabs(aMessage.uris, clone(aMessage, {
          parent:       getTabById(aMessage.parent),
          insertBefore: getTabById(aMessage.insertBefore),
          insertAfter:  getTabById(aMessage.insertAfter)
        }));
      })();

    case kCOMMAND_NEW_WINDOW_FROM_TABS:
      return (async () => {
        log('new window requested: ', aMessage);
        let movedTabs = await openNewWindowFromTabs(
                                aMessage.tabs.map(getTabById),
                                aMessage
                              );
        clearTimeout(timeout);
        return { movedTabs: movedTabs.map(aTab => aTab.id) };
      })();

    case kCOMMAND_MOVE_TABS:
      return (async () => {
        log('move tabs requested: ', aMessage);
        let movedTabs = await moveTabs(
                                aMessage.tabs.map(getTabById),
                                aMessage
                              );
        clearTimeout(timeout);
        return { movedTabs: movedTabs.map(aTab => aTab.id) };
      })();

    case kCOMMAND_REMOVE_TAB:
      return (async () => {
        let tab = getTabById(aMessage.tab);
        if (!tab) {
          clearTimeout(timeout);
          return;
        }
        if (isActive(tab))
          await tryMoveFocusFromClosingCurrentTab(tab);
        browser.tabs.remove(tab.apiTab.id)
          .catch(handleMissingTabError);
      })();

    case kCOMMAND_SELECT_TAB: {
      let tab = getTabById(aMessage.tab);
      if (!tab) {
        clearTimeout(timeout);
        return;
      }
      browser.tabs.update(tab.apiTab.id, { active: true })
        .catch(handleMissingTabError);
    }; break;

    case kCOMMAND_SELECT_TAB_INTERNALLY: {
      let tab = getTabById(aMessage.tab);
      if (!tab) {
        clearTimeout(timeout);
        return;
      }
      selectTabInternally(tab);
    }; break;

    case kCOMMAND_SET_SUBTREE_MUTED: {
      log('set muted state: ', aMessage);
      let root = getTabById(aMessage.tab);
      if (!root) {
        clearTimeout(timeout);
        return;
      }
      let tabs = [root].concat(getDescendantTabs(root));
      for (let tab of tabs) {
        let playing = isSoundPlaying(tab);
        let muted = isMuted(tab);
        log(`tab ${tab.id}: playing=${playing}, muted=${muted}`);
        if (playing != aMessage.muted)
          continue;

        log(` => set muted=${aMessage.muted}`);

        browser.tabs.update(tab.apiTab.id, {
          muted: aMessage.muted
        }).catch(handleMissingTabError);

        let add = [];
        let remove = [];
        if (aMessage.muted) {
          add.push(kTAB_STATE_MUTED);
          tab.classList.add(kTAB_STATE_MUTED);
        }
        else {
          remove.push(kTAB_STATE_MUTED);
          tab.classList.remove(kTAB_STATE_MUTED);
        }

        if (isAudible(tab) && !aMessage.muted) {
          add.push(kTAB_STATE_SOUND_PLAYING);
          tab.classList.add(kTAB_STATE_SOUND_PLAYING);
        }
        else {
          remove.push(kTAB_STATE_SOUND_PLAYING);
          tab.classList.remove(kTAB_STATE_SOUND_PLAYING);
        }

        // tabs.onUpdated is too slow, so users will be confused
        // from still-not-updated tabs (in other words, they tabs
        // are unresponsive for quick-clicks).
        broadcastTabState(tab, {
          add, remove,
          bubbles: !hasChildTabs(tab)
        });
      }
    }; break;

    case kCOMMAND_MOVE_TABS_INTERNALLY_BEFORE:
      return moveTabsInternallyBefore(
        aMessage.tabs.map(getTabById),
        getTabById(aMessage.nextTab)
      ).map(aTab => aTab.id);

    case kCOMMAND_MOVE_TABS_INTERNALLY_AFTER:
      return moveTabsInternallyAfter(
        aMessage.tabs.map(getTabById),
        getTabById(aMessage.previousTab)
      ).map(aTab => aTab.id);

    case kCOMMAND_ATTACH_TAB_TO:
      return (async () => {
        let child = getTabById(aMessage.child);
        let parent = getTabById(aMessage.parent);
        let insertBefore = getTabById(aMessage.insertBefore);
        let insertAfter = getTabById(aMessage.insertAfter);
        if (child && parent)
          await attachTabTo(child, parent, clone(aMessage, {
            insertBefore, insertAfter
          }));
      })();

    case kCOMMAND_DETACH_TAB:
      return (async () => {
        let tab = getTabById(aMessage.tab);
        if (tab)
          await detachTab(tab);
      })();

    case kCOMMAND_PERFORM_TABS_DRAG_DROP:
      log('perform tabs dragdrop requested: ', aMessage);
      return performTabsDragDrop(clone(aMessage, {
        attachTo:     getTabById(aMessage.attachTo),
        insertBefore: getTabById(aMessage.insertBefore),
        insertAfter:  getTabById(aMessage.insertAfter)
      }));
  }
  clearTimeout(timeout);
}
