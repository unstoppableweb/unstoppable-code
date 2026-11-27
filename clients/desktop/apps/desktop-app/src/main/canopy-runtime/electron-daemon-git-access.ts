import { getDesktopInstrumentationConfig } from '@canopy/desktop-instrumentation';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import {
  diffScopeAdmitted,
  workspaceManifestReadable,
} from '../lib/worktree-health';
import { createDaemonGitRoute, type DaemonGitRoute } from './daemon-git-route';
import {
  getElectronDaemonCallerLifetime,
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
  isElectronW5HandoffPending,
} from './electron-daemon-access';
import {
  createReachableDaemonGitRoute,
  type DaemonGitReachability,
  type DaemonGitRouteInputs,
  type ReachableDaemonGitRouteOptions,
} from './daemon-git-reachability';
import type { ElectronDaemonCallerLifetime } from './electron-daemon-caller-lifetime';
import { getElectronDaemonHealth } from './electron-daemon-health';
import { recordDaemonRoute } from './daemon-route-telemetry';
import { resolveRepository } from './worker-git-adapter';

let route: DaemonGitRoute | undefined;

/** What the host supplies; everything else is production's own wiring. */
export interface DesktopDaemonGitRouteHost {
  readonly hostContext: DaemonGitRouteInputs['hostContext'];
  readonly connections: DaemonGitRouteInputs['connections'];
  readonly reachability: DaemonGitReachability;
  readonly lifetime: ElectronDaemonCallerLifetime;
  readonly record: ReachableDaemonGitRouteOptions['record'];
}

/**
 * The production Git route over `host`'s daemon connection: its selection,
 * admission, reachability rule and app version, shared with the goldens so a
 * miswired input fails them.
 */
export function createDesktopDaemonGitRoute(
  host: DesktopDaemonGitRouteHost,
): DaemonGitRoute {
  return createReachableDaemonGitRoute({
    inputs: {
      repositoryPath: resolveRepository,
      hostContext: host.hostContext,
      connections: host.connections,
    },
    reachability: host.reachability,
    createRoute: (inputs) =>
      createDaemonGitRoute({
        lifetime: host.lifetime,
        workspaceType: getWorkspaceType,
        resolveWorktreeTargetIds,
        workspaceManifestReadable,
        diffScopeAdmitted,
        ...inputs,
      }),
    record: host.record,
    // __CANOPY_APP_VERSION__: CANOPY_VERSION, else the root version, the
    // expression scripts/build-core-daemon.mjs stamps the daemon's buildVersion with.
    appVersion: getDesktopInstrumentationConfig().appVersion,
  });
}

/**
 * Selects branch list, worktree health and changed files on macOS and Linux (CAN-4729) under the shared
 * background-service rule (CAN-5541); constructing the route makes no contact.
 */
export function getDesktopDaemonGitRoute(): DaemonGitRoute {
  if (route) return route;
  const health = getElectronDaemonHealth();
  health.setConsumerEnabled('git_reads', true);
  route = createDesktopDaemonGitRoute({
    hostContext: getElectronDaemonFilesContext,
    connections: getElectronDaemonConnections,
    reachability: {
      // The W5 flip handoff is a restart window: read in-process, show nothing.
      isLatched: () => health.isLatched() || isElectronW5HandoffPending(),
      noteFallback: (reason) => health.noteFallback('git_reads', reason),
    },
    lifetime: getElectronDaemonCallerLifetime(),
    record: (reason) => recordDaemonRoute('git_reads', reason),
  });
  return route;
}

export function disposeDesktopDaemonGitRoute(): void {
  route?.dispose();
}
