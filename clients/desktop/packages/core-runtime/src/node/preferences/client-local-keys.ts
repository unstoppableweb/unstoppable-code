/**
 * Preference keys a client keeps in its own document (CAN-4472): window
 * geometry, appearance and pure panel and sidebar view state. The domain
 * preferences document keeps a frozen copy of whatever it stored for them and
 * never writes them otherwise (see `preserveStoredKeys`). Every domain codec,
 * desktop or daemon, wraps with this same list.
 */
export const CLIENT_LOCAL_PREFERENCE_KEYS = [
  'windowBounds',
  'windowMaximized',
  'windowFullScreen',
  'appAdvisorDialogBounds',
  'theme',
  'colorMode',
  'sidebarAppearance',
  'scrollbarBehavior',
  'worktreeDiffStatsStyle',
  'uiScale',
  'sidebarWidth',
  'sidebarCollapsed',
  'sidebarCodeSectionCollapsed',
  'sidebarCoworkSectionCollapsed',
  'sidebarOrchestratorCollapsed',
  'appAdvisorNavCollapsed',
  'worktreePanelPercent',
  'kanbanWorktreePanelPercent',
  'activityPanelExpanded',
  'kanbanActivityPanelExpanded',
  'activityPanelWidthPercent',
  'kanbanActivityPanelWidthPercent',
  'kanbanChatPanelVisible',
  'pipelineChatPanelVisible',
  'pipelineChatPanelWidthPercent',
  'terminalDrawerCollapsed',
  'terminalDrawerHeight',
] as const;

export type ClientLocalPreferenceKey =
  (typeof CLIENT_LOCAL_PREFERENCE_KEYS)[number];
