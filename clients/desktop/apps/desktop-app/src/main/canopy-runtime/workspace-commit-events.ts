import {
  createCanopyWorkspaceEventBridge,
  type CanopyClientLeaseState,
  type CanopyEventsConnection,
  type CanopyWorkspaceInvalidationPlan,
} from '@canopy/core-client';
import {
  CORE_WORKSPACE_COMMITTED_EVENT,
  CoreWorkspaceCommittedPayloadSchema,
  type CanopyEvent,
} from '@canopy/protocol/canopy-core';
import type { WorktreeMembershipRow } from '../lib/worktree-lifecycle-signals';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';

/*
 * The Electron subscriber for W5e workspace commit events (CAN-5497). It maps
 * each commit another origin made (a daemon-hosted command, the CLI through
 * the daemon) onto the caches Electron's own writers refresh after their
 * commits. Electron's own commits, which W6g routes through the daemon under
 * this process's client instance ids, keep publishing locally and are
 * skipped here. It records no self-write: the worktrees.json watcher's
 * external path still runs for a list another origin wrote (W8 owns both).
 * It only attaches to a daemon session that already exists, so production,
 * whose daemon withholds `core.events.*`, never subscribes.
 */

/**
 * A list read; only `ok` and `absent` are a membership to remember. Any
 * other read publishes a membership change and resolves: the branch
 * observer re-reads membership itself, so there is nothing to retry.
 */
export interface WorktreeListRead {
  readonly authority: 'ok' | 'absent' | 'partial' | 'unreadable';
  readonly worktrees: readonly WorktreeMembershipRow[];
}

/**
 * The caches and pushes a commit invalidates; production binds main's own.
 * A re-read rejects when it could not read with authority, so the bridge
 * retries instead of acknowledging; the pushes read nothing.
 */
export interface WorkspaceCommitEventHandlers {
  scheduleDesktopStructureChanged(): void;
  /**
   * Re-reads the index and manifests into the type, external-path and id
   * registries, keeping what an unreadable index or manifest cannot decide,
   * and rejects for one.
   */
  refreshWorkspaceRegistries(): Promise<void>;
  /**
   * The lost-response reconcile: drops the cached layer, advances only on
   * change; rejects when no read of the manifest decided it within its
   * bound.
   */
  reconcileManifestPluginDefaults(workspaceId: string): Promise<void>;
  /** Every workspace the registries know, for a broad reconcile. */
  listWorkspaceIds(): readonly string[];
  readWorktreeList(workspaceId: string): Promise<WorktreeListRead>;
  publishWorktreeListWrite(
    previous: readonly WorktreeMembershipRow[],
    next: readonly WorktreeMembershipRow[],
  ): void;
  /** Membership may have changed in ways no remembered list can tell. */
  publishWorktreeMembershipChange(): void;
}

/** What the binding reads from an existing daemon session; it opens none. */
export interface WorkspaceCommitEventSession {
  /** The session's current connection; throws once the session closed. */
  readonly client: CanopyEventsConnection;
  readonly lease: { readonly state: CanopyClientLeaseState };
}

/**
 * While no observed session has a live connection, how often the binding
 * rechecks for one its lease adopted after a drop (no Files read needed).
 */
export const WORKSPACE_COMMIT_EVENTS_RECHECK_MS = 250;

export interface WorkspaceCommitEventBindingOptions {
  readonly handlers: WorkspaceCommitEventHandlers;
  /** Whether a `publishedBy` client instance id is this process's own. */
  readonly isOwnOrigin: (clientInstanceId: string) => boolean;
  /**
   * The read cache's step (CAN-7155), run before every handler so they read
   * what it captured; it rejects when its capture failed.
   */
  readonly readCache?: (plan: CanopyWorkspaceInvalidationPlan) => Promise<void>;
  readonly onStreamChanged?: (live: boolean) => void;
  readonly onInvalidated?: () => void;
  /** The bridge's first broad re-read retry delay; tests inject their clock. */
  readonly retryDelayMs?: number;
}

export interface WorkspaceCommitEventBinding {
  /** Subscribes on an existing daemon session's client; never connects. */
  attach(connection: CanopyEventsConnection): Promise<void>;
  /**
   * Rides a session main already holds. The subscription stays on one live
   * connection; after it drops, the binding moves to the first observed
   * session whose lease is active on a live connection again, rechecking
   * every `WORKSPACE_COMMIT_EVENTS_RECHECK_MS` while a lease reconnects.
   */
  observe(session: WorkspaceCommitEventSession): void;
  /** Applies one plan, rejecting if any handler failed; exposed for tests. */
  apply(plan: CanopyWorkspaceInvalidationPlan): Promise<void>;
  close(): Promise<void>;
}

type Step = (name: string, run: () => void | Promise<void>) => Promise<void>;

/** More than one handler of a plan failed; each failure, in handler order. */
export class WorkspaceCommitHandlersError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super('Workspace commit handlers failed.');
    this.name = 'WorkspaceCommitHandlersError';
  }
}

// Once per process (CAN-7155 q-45): proves `core.workspace.committed`
// delivery is live in a shipped build. The commit id only; no paths or names.
let committedDeliveryLogged = false;
function noteFirstCommittedDelivery(
  isOwnOrigin: (clientInstanceId: string) => boolean,
): (event: CanopyEvent) => void {
  return (event): void => {
    if (
      committedDeliveryLogged ||
      event.name !== CORE_WORKSPACE_COMMITTED_EVENT
    )
      return;
    committedDeliveryLogged = true;
    const payload = CoreWorkspaceCommittedPayloadSchema.safeParse(
      event.payload,
    );
    const publishedBy = payload.success ? payload.data.publishedBy : undefined;
    logMainProcessInfo(
      '[workspace-commit-events] first core.workspace.committed delivered',
      {
        commit: payload.success ? payload.data.commit : null,
        ownOrigin: publishedBy !== undefined && isOwnOrigin(publishedBy),
      },
    );
  };
}

export function createWorkspaceCommitEventBinding({
  handlers,
  isOwnOrigin,
  readCache,
  onStreamChanged,
  onInvalidated,
  retryDelayMs,
}: WorkspaceCommitEventBindingOptions): WorkspaceCommitEventBinding {
  // Each list's membership as this subscriber last read it.
  const memberships = new Map<string, readonly WorktreeMembershipRow[]>();
  /** Runs one handler; a failure is collected and its siblings still run. */
  const stepper =
    (failures: unknown[]): Step =>
    async (name, run) => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
        logMainProcessWarn('[workspace-commit-events] handler failed', {
          handler: name,
          error,
        });
      }
    };

  const refreshList = async (workspaceId: string): Promise<void> => {
    const read = await handlers.readWorktreeList(workspaceId);
    const previous = memberships.get(workspaceId);
    if (read.authority !== 'ok' && read.authority !== 'absent') {
      memberships.delete(workspaceId);
      handlers.publishWorktreeMembershipChange();
      return;
    }
    memberships.set(workspaceId, read.worktrees);
    if (previous === undefined) handlers.publishWorktreeMembershipChange();
    else handlers.publishWorktreeListWrite(previous, read.worktrees);
  };

  /** Rejects when any handler failed, so the bridge never acknowledges it. */
  const apply = async (
    plan: CanopyWorkspaceInvalidationPlan,
  ): Promise<void> => {
    const failures: unknown[] = [];
    await applyPlan(plan, stepper(failures));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new WorkspaceCommitHandlersError(failures);
  };
  const applyPlan = async (
    plan: CanopyWorkspaceInvalidationPlan,
    step: Step,
  ): Promise<void> => {
    // First: a broad plan's last step re-runs the branch observer.
    if (readCache) await step('readCache', () => readCache(plan));
    if (plan.broad) {
      memberships.clear();
      for (const workspaceId of handlers.listWorkspaceIds())
        await step('reconcileManifestPluginDefaults', () =>
          handlers.reconcileManifestPluginDefaults(workspaceId),
        );
      await step('refreshWorkspaceRegistries', () =>
        handlers.refreshWorkspaceRegistries(),
      );
      await step('scheduleDesktopStructureChanged', () =>
        handlers.scheduleDesktopStructureChanged(),
      );
      await step('publishWorktreeMembershipChange', () =>
        handlers.publishWorktreeMembershipChange(),
      );
      return;
    }
    // External paths live in each manifest, so a manifest commit re-reads
    // the registries and pushes structure, as Electron's manifest writers do.
    const registries = plan.index || plan.manifests.length > 0;
    if (registries || plan.worktreeLists.length > 0)
      await step('scheduleDesktopStructureChanged', () =>
        handlers.scheduleDesktopStructureChanged(),
      );
    if (registries)
      await step('refreshWorkspaceRegistries', () =>
        handlers.refreshWorkspaceRegistries(),
      );
    for (const workspaceId of plan.manifests)
      await step('reconcileManifestPluginDefaults', () =>
        handlers.reconcileManifestPluginDefaults(workspaceId),
      );
    for (const workspaceId of plan.worktreeLists)
      await step('refreshWorktreeList', () => refreshList(workspaceId));
  };

  const bridge = createCanopyWorkspaceEventBridge({
    isOwnOrigin,
    apply,
    ...(retryDelayMs !== undefined && { retryDelayMs }),
    onDelivered: noteFirstCommittedDelivery(isOwnOrigin),
    ...(onStreamChanged && { onStreamChanged }),
    ...(onInvalidated && { onInvalidated }),
    onError: (error) =>
      logMainProcessWarn(
        '[workspace-commit-events] delivery or subscription failed',
        {
          error,
        },
      ),
  });

  const sessions = new Set<WorkspaceCommitEventSession>();
  let attached: CanopyEventsConnection | null = null;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** The session's live connection, or null; forgets an ended session. */
  const liveClient = (
    session: WorkspaceCommitEventSession,
  ): CanopyEventsConnection | null => {
    try {
      const { state } = session.lease;
      if (state === 'failed' || state === 'released') {
        sessions.delete(session);
        return null;
      }
      if (state !== 'active') return null;
      const { client } = session;
      return client.signal.aborted ? null : client;
    } catch {
      sessions.delete(session);
      return null;
    }
  };
  const ensure = (): void => {
    if (closed) return;
    if (attached?.signal.aborted) attached = null;
    if (!attached)
      for (const session of Array.from(sessions)) {
        const client = liveClient(session);
        if (!client) continue;
        attached = client;
        client.signal.addEventListener('abort', ensure, { once: true });
        break;
      }
    if (attached) {
      // Idempotent while open; resumes a stream that failed on this connection.
      void bridge.attach(attached);
      return;
    }
    if (sessions.size === 0 || recheck !== undefined) return;
    recheck = setTimeout(() => {
      recheck = undefined;
      ensure();
    }, WORKSPACE_COMMIT_EVENTS_RECHECK_MS);
    recheck.unref?.();
  };

  return {
    attach: (connection) => bridge.attach(connection),
    observe(session): void {
      if (closed) return;
      sessions.add(session);
      ensure();
    },
    apply,
    close: (): Promise<void> => {
      closed = true;
      clearTimeout(recheck);
      recheck = undefined;
      sessions.clear();
      attached = null;
      return bridge.close();
    },
  };
}
