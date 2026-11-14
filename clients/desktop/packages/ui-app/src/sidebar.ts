/**
 * Sidebar surfaces shared by the desktop rail and the web portal: the layout
 * primitives plus the DOM-geometry helpers that drive sticky stacking, the
 * selected-item pin, and the Projects/Chats reachability affordances.
 */
export * from './code/shell/sidebar';
// Pure sidebar search models, importable without the full `@canopy/ui-app`
// barrel (the Portal search palette loads in the sidebar frame).
export {
  buildSidebarChatSearchCandidates,
  type SidebarChatSearchResult,
} from './code/shell/sidebar-chat-search-model';
export { snapshotWorkspaceMatchesContext } from './code/shell/workspace-sections-model';
