import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

export const IPC_PRIVATE_CHANNELS = new Set<string>([
  // Startup already has its own loading state; do not emit slow-action UI for it.
  IPC_CHANNELS.appWorkspaceStartupWait,
  // Even a decision count would disclose that a private relationship exists.
  IPC_CHANNELS.orgProjectLinksList,
  IPC_CHANNELS.orgProjectLinksDecide,
  IPC_CHANNELS.scriptRun,
  IPC_CHANNELS.approvalSecretInput,
  IPC_CHANNELS.slowActionSnapshot,
  IPC_CHANNELS.slowActionClear,
]);
