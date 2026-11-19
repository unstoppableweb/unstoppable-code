import { useEffect, useLayoutEffect, useRef } from 'react';
import { clearPanelTabDrag, readPanelTabDrag } from './panel-dnd';
import {
  LiveTabReorder,
  transparentTabDragImage,
} from './panel-tab-live-reorder';
import type {
  PanelTabLiveReorderHandle,
  PanelTabLiveReorderHost,
} from './panel-tab-live-reorder-context';

/**
 * How long a dropped live reorder waits for the reordered tabs to render
 * before settling anyway (the layout owner may refuse or defer the move).
 */
const LIVE_REORDER_SETTLE_FALLBACK_MS = 250;

/**
 * Fill tabs reorder live ({@link LiveTabReorder}): a tab dragged along its
 * own title row follows the pointer while its neighbours slide aside, and
 * settles into place on release. Leaving the row hands the drag back to the
 * panel drop targets, so moving a tab to another group is unchanged.
 *
 * A host offers this through `PanelTabLiveReorderContext`.
 */
export function usePanelTabLiveReorder({
  fill,
  draggingPanelId,
  tabs,
  barRef,
  tabElementsRef,
  stripRef,
  setDropIndicatorIndex,
  getTabTitle,
  isTabTitlePrivate,
}: PanelTabLiveReorderHost): PanelTabLiveReorderHandle {
  // The live reorder of the tab being dragged, if any, and whether its drop
  // is waiting for the reordered tabs to render.
  const liveReorderRef = useRef<LiveTabReorder | null>(null);
  const liveSettleTimerRef = useRef<number | null>(null);
  const finishLiveReorder = (): void => {
    if (liveSettleTimerRef.current !== null) {
      barRef.current?.ownerDocument.defaultView?.clearTimeout(
        liveSettleTimerRef.current,
      );
      liveSettleTimerRef.current = null;
    }
    liveReorderRef.current?.finish();
    liveReorderRef.current = null;
  };
  const finishLiveReorderRef = useRef(finishLiveReorder);
  finishLiveReorderRef.current = finishLiveReorder;

  // While one of the bar's tabs is dragged: the document reports the pointer
  // wherever it is, so the tab keeps following it past the strip's ends and
  // over the row's other controls. Inside the title row the reorder owns the
  // drag: it accepts the drop itself and no other drop target sees it.
  // Outside the row these listeners only watch, and the panel drop targets
  // work as they always have.
  useEffect(() => {
    const ownerDocument = barRef.current?.ownerDocument;
    if (!fill || draggingPanelId === null || ownerDocument === undefined) {
      return undefined;
    }
    const onDragOver = (event: DragEvent): void => {
      const live = liveReorderRef.current;
      if (live === null || liveSettleTimerRef.current !== null) {
        return;
      }
      if (live.pointerMoved(event.clientX, event.clientY) !== 'strip') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      setDropIndicatorIndex(null);
    };
    const onDrop = (event: DragEvent): void => {
      const live = liveReorderRef.current;
      if (
        live === null ||
        liveSettleTimerRef.current !== null ||
        live.pointerMoved(event.clientX, event.clientY) !== 'strip'
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDropIndicatorIndex(null);
      const dragged = readPanelTabDrag();
      clearPanelTabDrag();
      const {
        groupId: stripGroupId,
        tabs: currentTabs,
        onReorderTab: reorder,
      } = stripRef.current;
      const draggedTab = currentTabs.find(
        (tab) => tab.panelId === dragged?.panelId,
      );
      if (
        dragged === null ||
        draggedTab === undefined ||
        reorder === undefined ||
        !live.moved
      ) {
        finishLiveReorderRef.current();
        return;
      }
      // The target counts the dragged tab's own strip; unpinned tabs follow
      // every pinned one in the full list.
      const stripStart =
        draggedTab.pinned === true
          ? 0
          : currentTabs.filter((tab) => tab.pinned === true).length;
      // Where the tabs are drawn now is where the settle starts from; after
      // the reorder renders it can no longer be measured.
      live.hold();
      reorder(stripGroupId, dragged.panelId, stripStart + live.targetIndex);
      // The reordered tabs settle as soon as they render (the layout effect
      // below). If the owner refuses the move, they settle back instead.
      liveSettleTimerRef.current =
        ownerDocument.defaultView?.setTimeout((): void => {
          liveSettleTimerRef.current = null;
          finishLiveReorderRef.current();
        }, LIVE_REORDER_SETTLE_FALLBACK_MS) ?? null;
    };
    ownerDocument.addEventListener('dragover', onDragOver, true);
    ownerDocument.addEventListener('drop', onDrop, true);
    return (): void => {
      ownerDocument.removeEventListener('dragover', onDragOver, true);
      ownerDocument.removeEventListener('drop', onDrop, true);
    };
  }, [fill, draggingPanelId]);

  // The tabs changed order: a live reorder waiting on its drop settles into
  // the new layout before paint. One still in flight ends too, since its
  // measurements describe the old order.
  const tabOrderKey = tabs.map((tab) => tab.panelId).join('\u0000');
  useLayoutEffect(() => {
    finishLiveReorderRef.current();
  }, [tabOrderKey]);

  useEffect(
    () => (): void => {
      liveReorderRef.current?.dispose();
      liveReorderRef.current = null;
    },
    [],
  );

  return {
    // Decodes the drag image ahead of the drag, which has to be set up
    // inside `dragstart` and cannot wait for it.
    prepare: fill
      ? (event): void => {
          transparentTabDragImage(event.currentTarget.ownerDocument);
        }
      : undefined,
    dragStart: (event, panelId): void => {
      if (!fill) {
        return;
      }
      // The tab itself is the drag feedback.
      const draggedTab = tabs.find((tab) => tab.panelId === panelId);
      const stripTabs = tabs.filter(
        (tab) => (tab.pinned === true) === (draggedTab?.pinned === true),
      );
      const stripElements = stripTabs
        .map((tab) => tabElementsRef.current.get(tab.panelId))
        .filter((element): element is HTMLDivElement => element !== undefined);
      const bar = barRef.current;
      if (
        bar === null ||
        draggedTab === undefined ||
        stripElements.length !== stripTabs.length
      ) {
        return;
      }
      finishLiveReorder();
      const live = LiveTabReorder.start({
        bar,
        dragged: event.currentTarget,
        tabs: stripElements,
        grabClientX: event.clientX,
        title: getTabTitle?.(draggedTab) ?? draggedTab.title,
        maskTitle: isTabTitlePrivate?.(draggedTab) === true,
      });
      if (live === null) {
        return;
      }
      liveReorderRef.current = live;
      // Guard: synthetic test events lack dataTransfer.
      const dataTransfer: DataTransfer | null = event.dataTransfer;
      if (dataTransfer && typeof dataTransfer.setDragImage === 'function') {
        dataTransfer.setDragImage(
          transparentTabDragImage(bar.ownerDocument),
          0,
          0,
        );
      }
    },
    dragEnd: (): void => {
      // A live reorder that did not drop in its row (moved elsewhere, or
      // cancelled) puts its tabs back; one that did is waiting to settle.
      if (liveSettleTimerRef.current === null) {
        finishLiveReorder();
      }
    },
  };
}
