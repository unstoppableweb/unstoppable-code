import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import { workspaceManifestReadable } from '../lib/worktree-health';
import { createDaemonGitRoute, type DaemonGitRoute } from './daemon-git-route';
import {
  getElectronDaemonCallerLifetime,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
  isElectronW5HandoffPending,
} from './electron-daemon-access';
import { createReachableDaemonGitRoute } from './daemon-git-reachability';
import { getElectronDaemonHealth } from './electron-daemon-health';
import { recordDaemonRoute } from './daemon-route-telemetry';
import { resolveRepository } from './worker-git-adapter';

let route: DaemonGitRoute | undefined;

/**
 * Selects branch list and worktree health on macOS and Linux (CAN-4729) under the shared
 * background-service rule (CAN-5541); constructing the route makes no contact.
 */
export function getDesktopDaemonGitRoute(): DaemonGitRoute {
  if (route) return route;
  const health = getElectronDaemonHealth();
  health.setConsumerEnabled('git_reads', true);
  route = createReachableDaemonGitRoute({
    inputs: {
      repositoryPath: resolveRepository,
      hostContext: getElectronDaemonFilesContext,
      connections: getElectronDaemonConnections,
    },
    reachability: {
      // The W5 flip handoff is a restart window: read in-process, show nothing.
      isLatched: () => health.isLatched() || isElectronW5HandoffPending(),
      noteFallback: (reason) => health.noteFallback('git_reads', reason),
    },
    createRoute: (inputs) =>
      createDaemonGitRoute({
        lifetime: getElectronDaemonCallerLifetime(),
        workspaceType: getWorkspaceType,
        resolveWorktreeTargetIds,
        workspaceManifestReadable,
        ...inputs,
      }),
    record: (reason) => recordDaemonRoute('git_reads', reason),
  });
  return route;
}

export function disposeDesktopDaemonGitRoute(): void {
  route?.dispose();
}
