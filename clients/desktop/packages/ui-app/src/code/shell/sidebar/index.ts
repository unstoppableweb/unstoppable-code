export { SidebarContextHeader } from './SidebarContextHeader';
export {
  SidebarChrome,
  type SidebarChromeProps,
  type SidebarChromeScroll,
  type SidebarChromeVariant,
  type SidebarChromeWidth,
  type SidebarDensity,
} from './SidebarChrome';
export {
  SidebarList,
  type SidebarListProps,
  type SidebarListRowGap,
} from './SidebarList';
export {
  SidebarNoneFoundRow,
  type SidebarNoneFoundRowProps,
} from './SidebarNoneFoundRow';
export {
  SidebarOfflineRow,
  type SidebarOfflineRowProps,
} from './SidebarOfflineRow';
export {
  SidebarScrollArea,
  SIDEBAR_SCROLLBAR_HIDE_DELAY_MS,
} from './SidebarScrollArea';
export {
  SidebarRowFrame,
  type SidebarRowFrameProps,
  type SidebarRowFrameVariant,
} from './SidebarRowFrame';
export { SidebarSection, type SidebarSectionProps } from './SidebarSection';
export {
  activateSidebarNavItem,
  type SidebarNavItemActivation,
} from './sidebar-nav-activation';
export {
  createSidebarSectionRootRegistry,
  returnSidebarSectionToRoot,
  scrollSectionToTop,
  useSidebarSectionRoot,
  type SidebarSectionRootRegistry,
  type SidebarSectionRootReset,
  type SidebarSectionRootReturn,
} from './sidebar-section-root';
export { SHARED_WITH_YOU_SECTION_LABEL } from './shared-with-you-label';
export {
  SidebarPageNav,
  SidebarPageNavGroup,
  type SidebarPageNavGroupProps,
  type SidebarPageNavProps,
  type SidebarPageNavSurface,
} from './SidebarPageNav';
export { ChatsSelectedPinSeat } from './ChatsSelectedPinSeat';
export {
  chatsContentHasRows,
  CHATS_CONTENT_SELECTOR,
  CHATS_HEADER_SELECTOR,
  CHATS_HEADER_STUCK_ATTR,
  CHATS_ROW_ATTR,
  CHATS_ROW_SELECTOR,
  chatsOcclusionBottom,
  isChatsContentOccluded,
  revealOccludedChats,
  type ChatsOcclusionMetrics,
} from './chats-header-reveal';
export {
  shouldShowProjectsPin,
  type ProjectsPinVisibilityMetrics,
} from './projects-pin';
export * from './sidebar-surfaces';
export * from './sidebar-ordering';
export * from './standalone-work-entries';
export { useProjectListPagination } from './useProjectListPagination';
export { scheduleStickyCollapseScrollAdjust } from './sticky-collapse-scroll';
export * from './sticky-selected-item';
export * from './sticky-workspace-slot';
export * from './use-sticky-workspace-slot-host';
export {
  WorkspaceStickyPins,
  type WorkspaceStickyPinsProps,
} from './WorkspaceStickyPins';

export {
  CodeSidebarItemGroups,
  type CodeSidebarItemGroupCommands,
} from './CodeSidebarItemGroups';
export * from './sidebar-item-groups-model';
export { WorktreeSortableStateContext } from '../sortable-state-context';
export * from './sidebar-row-selection';
export * from './use-sidebar-batch-removal';
export * from './use-sidebar-bulk';
export * from './use-sidebar-work-entry-bulk';
export * from '../work-entry-removal-labels';

export {
  useSidebarAutoDelete,
  SidebarAutoDeleteProvider,
  SidebarAutoDeleteNotice,
} from '../SidebarAutoDelete';
