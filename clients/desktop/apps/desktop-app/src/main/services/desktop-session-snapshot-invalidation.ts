import { recordStaleWork } from '@canopy/desktop-shared/node/work-counters';

const INVALIDATION_DELAY_MS = 50;

/**
 * Every source that may ask for a session-stale broadcast (CAN-6970), with
 * the counter key its requests are recorded under. The table is the closed
 * set of sources, so a new emitter must be named here, and the keys are
 * built once, never per request.
 */
const STALE_REQUEST_KEYS = {
  'structural.workspace-persistence.worktrees':
    'request.structural.workspace-persistence.worktrees',
  'structural.workspace-metadata': 'request.structural.workspace-metadata',
  'structural.workspace-deletion': 'request.structural.workspace-deletion',
  'structural.worktree-service': 'request.structural.worktree-service',
  'structural.work-entry-archive': 'request.structural.work-entry-archive',
  'structural.work-entry-delete': 'request.structural.work-entry-delete',
  'structural.cowork-workspace': 'request.structural.cowork-workspace',
  'structural.cowork-workspace-records':
    'request.structural.cowork-workspace-records',
  'structural.sidebar-items': 'request.structural.sidebar-items',
  'structural.w5-commit-event': 'request.structural.w5-commit-event',
  'structural.w5-recovery': 'request.structural.w5-recovery',
  'structural.background-service': 'request.structural.background-service',
  'structural.pr-merge-progress': 'request.structural.pr-merge-progress',
  'structural.project-avatar': 'request.structural.project-avatar',
  'structural.project-repository-identity':
    'request.structural.project-repository-identity',
  'structural.space-notification-policy':
    'request.structural.space-notification-policy',
  'chat.session-activity': 'request.chat.session-activity',
  'runtime-status.session-refresh': 'request.runtime-status.session-refresh',
  'delegation.activity': 'request.delegation.activity',
  'standalone-chat.tab-summary': 'request.standalone-chat.tab-summary',
  'standalone-chat.work-entry-summary':
    'request.standalone-chat.work-entry-summary',
  'standalone-chat.workspace-summaries':
    'request.standalone-chat.workspace-summaries',
  'standalone-chat.removals': 'request.standalone-chat.removals',
  'standalone-chat.summary-entity': 'request.standalone-chat.summary-entity',
  'split-pr.set': 'request.split-pr.set',
  'split-pr.clear': 'request.split-pr.clear',
  'archived-containers': 'request.archived-containers',
  'sidebar-item-groups': 'request.sidebar-item-groups',
  'org-project': 'request.org-project',
  'renderer.invalidate': 'request.renderer.invalidate',
  'worktree-setup.begin': 'request.worktree-setup.begin',
  'worktree-setup.end': 'request.worktree-setup.end',
} as const;

export type StaleSignalSource = keyof typeof STALE_REQUEST_KEYS;

/** The structural writers, which stale the snapshot through the desktop structural signal. */
export type StructuralStaleSource = Extract<
  StaleSignalSource,
  `structural.${string}`
>;

const staleListeners = new Set<() => void>();
let staleTimer: ReturnType<typeof setTimeout> | null = null;

export function requestDesktopSessionSnapshotInvalidation(
  source: StaleSignalSource,
): void {
  recordStaleWork(STALE_REQUEST_KEYS[source]);
  if (staleTimer !== null) {
    return;
  }
  staleTimer = setTimeout((): void => {
    staleTimer = null;
    recordStaleWork('broadcast');
    staleListeners.forEach((listener): void => {
      listener();
    });
  }, INVALIDATION_DELAY_MS);
}

/**
 * The sidebar item groups' request, under its source. Sidebar groups are
 * maintained outside this change, so their call keeps this argument-free
 * name; every other emitter names its source through
 * {@link requestDesktopSessionSnapshotInvalidation}.
 */
export function scheduleDesktopSessionSnapshotInvalidation(): void {
  requestDesktopSessionSnapshotInvalidation('sidebar-item-groups');
}

export function subscribeDesktopSessionSnapshotInvalidation(
  listener: () => void,
): () => void {
  staleListeners.add(listener);
  return (): void => {
    staleListeners.delete(listener);
  };
}

export function cancelDesktopSessionSnapshotInvalidation(): void {
  if (staleTimer !== null) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  staleListeners.clear();
}
