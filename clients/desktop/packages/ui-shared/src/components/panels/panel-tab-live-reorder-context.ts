import {
  createContext,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { PanelTabModel } from '../../panels/registry-types';

/** What a tab bar hands the live reorder on every render. */
export interface PanelTabLiveReorderHost {
  /** Only fill tabs reorder live. */
  readonly fill: boolean;
  /** Which of the bar's own tabs is being dragged, if any. */
  readonly draggingPanelId: string | null;
  readonly tabs: readonly PanelTabModel[];
  readonly barRef: RefObject<HTMLDivElement | null>;
  readonly tabElementsRef: RefObject<Map<string, HTMLDivElement>>;
  /** The bar's group as last rendered. */
  readonly stripRef: {
    readonly current: {
      readonly groupId: string;
      readonly tabs: readonly PanelTabModel[];
      readonly onReorderTab?: (
        groupId: string,
        panelId: string,
        toIndex: number,
      ) => void;
    };
  };
  readonly setDropIndicatorIndex: (index: number | null) => void;
  readonly getTabTitle?: (tab: PanelTabModel) => string;
  readonly isTabTitlePrivate?: (tab: PanelTabModel) => boolean;
}

/** What the tab bar calls back as a tab is pressed, dragged and released. */
export interface PanelTabLiveReorderHandle {
  /** Readies the drag ahead of `dragstart`; absent when nothing reorders. */
  readonly prepare?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly dragStart: (
    event: ReactDragEvent<HTMLDivElement>,
    panelId: string,
  ) => void;
  readonly dragEnd: () => void;
}

export type UsePanelTabLiveReorder = (
  host: PanelTabLiveReorderHost,
) => PanelTabLiveReorderHandle;

const NO_LIVE_REORDER: PanelTabLiveReorderHandle = {
  dragStart: (): void => {},
  dragEnd: (): void => {},
};

function useNoPanelTabLiveReorder(): PanelTabLiveReorderHandle {
  return NO_LIVE_REORDER;
}

/**
 * The live reorder of fill tabs, supplied by the host as a hook. Without a
 * provider a dragged tab reorders with the insertion marker. The host
 * (`usePanelTabLiveReorder`) brings the drag code with it, so a host that
 * does not offer the live reorder does not load it.
 *
 * The value is called as a hook: provide one for the app's whole lifetime
 * and never swap it under mounted tab bars.
 */
export const PanelTabLiveReorderContext = createContext<UsePanelTabLiveReorder>(
  useNoPanelTabLiveReorder,
);
