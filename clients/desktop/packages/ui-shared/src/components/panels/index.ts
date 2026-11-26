// Controlled React wrappers around the imperative panels engine
// (packages/ui-shared/src/panels/). Display-only: props + intent callbacks,
// no stores, no window.api, no Electron, no data fetching. The owning app
// feeds these components state and persists committed sizes.
export { Sash } from './Sash';
export type { SashDragEvent, SashOrientation, SashProps } from './Sash';
export { SplitView } from './SplitView';
export type {
  SplitViewOrientation,
  SplitViewPane,
  SplitViewPanePriority,
  SplitViewProps,
} from './SplitView';
export type { PanelGridController } from './grid-host-types';
export { PanelGridHost } from './PanelGridHost';
export type { PanelGridHostProps } from './PanelGridHost';
export { PanelGridLoadingCard } from './PanelGridLoadingCard';
export type { PanelGridLoadingCardProps } from './PanelGridLoadingCard';
export { PanelGroup } from './PanelGroup';
export type { PanelGroupProps } from './PanelGroup';
export { PanelCollapsedBar } from './PanelCollapsedBar';
export type { PanelCollapsedBarProps } from './PanelCollapsedBar';
export {
  PANEL_TAB_BUSY_ATTRIBUTE,
  PanelChatTabBackgroundGlyph,
  PanelChatTabQuestionMarker,
  PanelFillChatTabGlyph,
  PanelTabBar,
  PanelTabStyleProvider,
  usePanelTabStyle,
} from './PanelTabBar';
export type {
  PanelTabBarAddTab,
  PanelTabBarProps,
  PanelTabStyle,
} from './PanelTabBar';
export {
  BrowserTabPreviewCard,
  browserTabPreviewLocation,
} from './BrowserTabPreviewCard';
export type { BrowserTabPreviewCardProps } from './BrowserTabPreviewCard';
export {
  ChatTabPreviewCard,
  formatChatTabPreviewElapsed,
} from './ChatTabPreviewCard';
export type {
  ChatTabPreviewCardProps,
  ChatTabPreviewStatus,
} from './ChatTabPreviewCard';
export { ChatTabPreviewReplyTicker } from './ChatTabPreviewReplyTicker';
export type { ChatTabPreviewReplyTickerProps } from './ChatTabPreviewReplyTicker';
export { DEFAULT_PANEL_CHROME_LABELS, PanelChrome } from './PanelChrome';
export {
  PanelCloseIcon,
  PanelFullScreenIcon,
  PanelNewWindowIcon,
  PanelSplitDirectionIcon,
} from '../../icons/PanelMenuIcons';
export type { PanelChromeLabels, PanelChromeProps } from './PanelChrome';
export { PANEL_DROP_ZONE_EDGES, PanelDropOverlay } from './PanelDropOverlay';
export type {
  PanelDropOverlayProps,
  PanelDropZoneEdge,
} from './PanelDropOverlay';
export {
  PanelAddTabMenuView,
  type PanelAddTabMenuViewEntry,
  type PanelAddTabMenuViewProps,
  type PanelAddTabMenuViewSection,
  type PanelAddTabMenuViewSubsection,
} from './PanelAddTabMenuView';
export {
  PanelEmptyGroupCatalog,
  type PanelEmptyGroupCatalogEntry,
  type PanelEmptyGroupCatalogProps,
} from './PanelEmptyGroupCatalog';
export {
  clearPanelTabDrag,
  dropDirectionToDropEdge,
  hasActivePanelTabDrag,
  PanelTabTransferIdentifier,
  readPanelTabDrag,
  startPanelTabDrag,
} from './panel-dnd';
export type { DraggedPanelTab } from './panel-dnd';

export {
  PANEL_TAB_UNREAD_ATTRIBUTE,
  UNREAD_DOT_DELAY_MS,
} from './usePanelTabStripState';
