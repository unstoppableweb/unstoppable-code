import {
  AgentPortError,
  lookAtLaterCloudRuns,
  lookAtWatchedCloudRun,
  readCloudRun,
  type CloudRunAccess,
  type CloudRunTerminalStatus,
  type CloudRunWatchFilter,
  type CloudRunWatchLook,
} from '@canopy/agent-actions';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { PipelineContextResource } from '@canopy/desktop-shared/node/background-execution-context';
import { logMainProcessError } from '../lib/main-process-logging';

/**
 * Desktop chat watchers on cloud runs (CAN-6391, plan CP-49): a
 * `worktree_pipeline_completion` watcher with `runOn: 'cloud'` follows one
 * cloud run, or the cloud runs of its project's owner that start after it is
 * armed. Cloud runs emit no events into this process, so an observer reads
 * them through the signed-in account's web core (`desktopCloudRunAccess`,
 * as the cloud run execution actions do) on an interval, and hands what it
 * finds to the watcher service as cloud run events. The shared look helpers
 * decide what a look reports, so cloud chats and desktop chats report the
 * same pauses and ends.
 */

/** How often a live cloud run watcher looks at its runs. */
export const CLOUD_RUN_WATCHER_POLL_MS = 30_000;

/** A cloud run's pause or end, as a watcher fires on it. */
export interface AppAdvisorCloudRunEvent {
  readonly type: 'cloud_run.paused' | 'cloud_run.completed';
  readonly runOn: 'cloud';
  readonly executionId: string;
  readonly pipelineId: string;
  readonly pipelineName: string;
  /**
   * The run's terminal status, `paused` (which leaves the watcher armed),
   * or `unavailable` once the run can no longer be read.
   */
  readonly status: 'paused' | CloudRunTerminalStatus | 'unavailable';
  /** A paused run's checkpoints a resume may answer. */
  readonly pendingPauseCount?: number;
  /**
   * The owner the run was recorded with (`personal` or `org:<id>`), which
   * its notice is authorized as; never part of the notice. Absent when the
   * run can no longer be read.
   */
  readonly owner?: string;
  /** The pause reported (`cloudRunPauseKey`); never part of the notice. */
  readonly pauseKey?: string;
  readonly error?: string;
  readonly completedAt?: string;
  readonly timestamp: string;
}

export function isCloudRunEvent(
  event: object,
): event is AppAdvisorCloudRunEvent {
  return 'runOn' in event && event.runOn === 'cloud';
}

/** The event as a watcher notice shows it: without its pause key. */
export function notifiedCloudRunEvent(
  event: AppAdvisorCloudRunEvent,
): Omit<AppAdvisorCloudRunEvent, 'pauseKey'> {
  const { pendingPauseCount, error, completedAt } = event;
  return {
    type: event.type,
    runOn: event.runOn,
    executionId: event.executionId,
    pipelineId: event.pipelineId,
    pipelineName: event.pipelineName,
    status: event.status,
    ...(pendingPauseCount === undefined ? {} : { pendingPauseCount }),
    ...(error === undefined ? {} : { error }),
    ...(completedAt === undefined ? {} : { completedAt }),
    timestamp: event.timestamp,
  };
}

/** What the observer reads of one live cloud run watcher. */
export interface CloudRunWatchSubscription {
  readonly watcherId: string;
  /** The destination chat's project and task, whose owner's runs it reads. */
  readonly projectId: string;
  readonly worktreeId: string;
  readonly executionId?: string;
  readonly pipelineId?: string;
  readonly terminalStatuses: readonly CloudRunTerminalStatus[];
  readonly armedAt: string;
  /** The pause each run last reported, by execution id. */
  readonly reportedPauses: Readonly<Record<string, string>>;
  /**
   * A notification of the watcher is still being delivered: its runs are
   * not looked at until it is, but it stays live, so the runs it tracks are
   * kept and the observer keeps its timer.
   */
  readonly held?: boolean;
}

export interface CloudRunWatcherObserverDeps {
  /** Whether the signed-in account's web core serves cloud runs. */
  readonly available: () => Promise<boolean>;
  readonly access: (chat: {
    projectId: string;
    worktreeId: string;
  }) => Promise<CloudRunAccess>;
}

export interface CloudRunWatcherObserverCallbacks {
  listSubscriptions(): Promise<CloudRunWatchSubscription[]>;
  applyEvent(watcherId: string, event: AppAdvisorCloudRunEvent): Promise<void>;
}

/**
 * Why a cloud run watcher may not be armed, or null. One run must be one
 * the destination chat reaches and still live, and of `pipelineId` when it
 * names one; a watcher on later runs needs the account's web core to serve
 * cloud runs now.
 */
export async function cloudRunWatcherRefusal(
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly executionId?: string;
    readonly pipelineId?: string;
  },
  deps: CloudRunWatcherObserverDeps,
): Promise<string | null> {
  try {
    if (!(await deps.available()))
      return "Cloud runs aren't available right now: sign in, or try again later.";
    const access = await deps.access(target);
    if (target.executionId === undefined) return null;
    const view = await readCloudRun(access, target.executionId);
    const { execution } = view;
    if (target.pipelineId && execution.pipelineId !== target.pipelineId)
      return 'Watcher target execution does not belong to the supplied project scope or pipeline.';
    if (
      execution.status === 'success' ||
      execution.status === 'failure' ||
      execution.status === 'cancelled'
    )
      return `Watcher target cloud run is already ${execution.status}. Completion watchers only fire for future transitions; choose a live run or omit executionId to watch later cloud runs.`;
    return null;
  } catch (error) {
    if (error instanceof AgentPortError) return error.message;
    throw error;
  }
}

/**
 * What a cloud run watcher's target shows of its run: its workflow name,
 * status and start. Best effort: a run that cannot be read now shows only
 * what the caller gave.
 */
export async function cloudRunTargetDisplay(
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly executionId?: string;
  },
  deps: CloudRunWatcherObserverDeps,
): Promise<{
  pipelineName?: string;
  executionStatus?: string;
  executionStartedAt?: string;
}> {
  if (target.executionId === undefined) return {};
  try {
    const { execution } = await readCloudRun(
      await deps.access(target),
      target.executionId,
    );
    return {
      pipelineName: execution.name,
      executionStatus: execution.status,
      executionStartedAt: execution.startedAt,
    };
  } catch {
    return {};
  }
}

/** A look that found something to report, as the event it fires. */
function lookEvent(
  look: Extract<CloudRunWatchLook, { kind: 'paused' | 'ended' }>,
  now: Date,
): AppAdvisorCloudRunEvent {
  const { execution } = look.view;
  const base = {
    runOn: 'cloud',
    executionId: execution.executionId,
    pipelineId: execution.pipelineId,
    pipelineName: execution.name,
    // A run recorded without an owner is Personal, as the access reaches it.
    owner: execution.owner ?? 'personal',
    timestamp: now.toISOString(),
  } as const;
  if (look.kind === 'paused')
    return {
      ...base,
      type: 'cloud_run.paused',
      status: 'paused',
      pendingPauseCount: execution.pendingPauseCount,
      pauseKey: look.pauseKey,
    };
  return {
    ...base,
    type: 'cloud_run.completed',
    status: look.status,
    ...(execution.error === null ? {} : { error: execution.error }),
    ...(execution.completedAt === null
      ? {}
      : { completedAt: execution.completedAt }),
  };
}

function watchFilter(
  subscription: CloudRunWatchSubscription,
): CloudRunWatchFilter {
  return {
    terminalStatuses: subscription.terminalStatuses,
    reported: (executionId, pauseKey) =>
      subscription.reportedPauses[executionId] === pauseKey,
    armedAt: subscription.armedAt,
  };
}

/**
 * The runs a watcher on later runs follows: the owner's cloud runs a chat of
 * its own task started, as the start recorded that chat (CAN-6391), as a
 * local watcher without a run follows its own worktree's runs.
 */
function startedFromTask(
  access: CloudRunAccess,
  task: { readonly projectId: string; readonly worktreeId: string },
): CloudRunAccess {
  return {
    ...access,
    reaches: (view) => {
      const initiator = view.detail?.initiation.initiator;
      return (
        access.reaches(view) &&
        initiator?.kind === 'agent' &&
        initiator.chat.projectId === task.projectId &&
        initiator.chat.worktreeId === task.worktreeId
      );
    },
  };
}

type SubscriptionLook =
  | { readonly kind: 'fire'; readonly event: AppAdvisorCloudRunEvent }
  | { readonly kind: 'wait' }
  /** The watched run ended with a status its watcher does not fire on. */
  | { readonly kind: 'settled' };

/**
 * Looks at the runs of live cloud run watchers on an interval while any
 * exists, and hands each pause or end it finds to the watcher service. A
 * watcher's look that fails is retried on the next interval. A watched run
 * that ended with a status its watcher does not fire on can never fire it,
 * so it is not read again until the app restarts; the watcher stays armed,
 * as a local one does.
 */
export class CloudRunWatcherObserver {
  private callbacks: CloudRunWatcherObserverCallbacks | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private readonly settled = new Set<string>();
  /** The live runs each watcher on later runs found, for its next look. */
  private readonly tracked = new Map<string, readonly string[]>();

  constructor(private readonly deps: CloudRunWatcherObserverDeps) {}

  configure(callbacks: CloudRunWatcherObserverCallbacks): void {
    this.callbacks = callbacks;
    this.running = true;
    void this.rescan();
  }

  stop(): void {
    this.running = false;
    this.callbacks = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Arm the next look when a live watcher remains, after a change. */
  async rescan(): Promise<void> {
    if (!this.running || this.polling || !this.callbacks) return;
    let live: CloudRunWatchSubscription[];
    try {
      live = await this.liveSubscriptions(this.callbacks);
    } catch (error) {
      logMainProcessError('Failed to list cloud run watchers:', error);
      live = [];
    }
    if (live.length === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, CLOUD_RUN_WATCHER_POLL_MS);
    this.timer.unref?.();
  }

  /** One look at every live cloud run watcher's runs. */
  async poll(now: Date = new Date()): Promise<void> {
    const callbacks = this.callbacks;
    if (!this.running || this.polling || !callbacks) return;
    this.polling = true;
    try {
      const live = await this.liveSubscriptions(callbacks);
      if (live.length > 0 && (await this.deps.available())) {
        for (const subscription of live) {
          if (!this.running) return;
          if (subscription.held === true) continue;
          const look = await this.look(subscription, now).catch(
            (error: unknown): SubscriptionLook => {
              logMainProcessError(
                `Failed to read the cloud runs of watcher ${subscription.watcherId}:`,
                error,
              );
              return { kind: 'wait' };
            },
          );
          if (look.kind === 'settled') this.settled.add(subscription.watcherId);
          if (look.kind !== 'fire') continue;
          await callbacks
            .applyEvent(subscription.watcherId, look.event)
            .catch((error: unknown) => {
              logMainProcessError(
                `Failed to fire cloud run watcher ${subscription.watcherId}:`,
                error,
              );
            });
        }
      }
    } catch (error) {
      logMainProcessError('Failed to look at cloud run watchers:', error);
    } finally {
      this.polling = false;
    }
    await this.rescan();
  }

  private async liveSubscriptions(
    callbacks: CloudRunWatcherObserverCallbacks,
  ): Promise<CloudRunWatchSubscription[]> {
    const live = (await callbacks.listSubscriptions()).filter(
      (subscription) => !this.settled.has(subscription.watcherId),
    );
    // A watcher no longer live has no runs to keep reading.
    const ids = new Set(live.map((subscription) => subscription.watcherId));
    for (const watcherId of Array.from(this.tracked.keys()))
      if (!ids.has(watcherId)) this.tracked.delete(watcherId);
    return live;
  }

  private async look(
    subscription: CloudRunWatchSubscription,
    now: Date,
  ): Promise<SubscriptionLook> {
    const access = await this.deps.access(subscription);
    const filter = watchFilter(subscription);
    if (subscription.executionId === undefined) {
      const later = await lookAtLaterCloudRuns(
        startedFromTask(access, subscription),
        {
          since: subscription.armedAt,
          ...(subscription.pipelineId === undefined
            ? {}
            : { pipelineId: subscription.pipelineId }),
          tracked: this.tracked.get(subscription.watcherId) ?? [],
        },
        filter,
      );
      this.tracked.set(subscription.watcherId, later.tracked);
      const { look } = later;
      return look.kind === 'paused' || look.kind === 'ended'
        ? { kind: 'fire', event: lookEvent(look, now) }
        : { kind: 'wait' };
    }
    const { executionId } = subscription;
    let look: CloudRunWatchLook;
    try {
      look = lookAtWatchedCloudRun(
        await readCloudRun(access, executionId),
        filter,
      );
    } catch (error) {
      if (!(error instanceof AgentPortError) || error.code !== 'not_found')
        throw error;
      return {
        kind: 'fire',
        event: {
          type: 'cloud_run.completed',
          runOn: 'cloud',
          executionId,
          pipelineId: subscription.pipelineId ?? executionId,
          pipelineName: 'Workflow',
          status: 'unavailable',
          timestamp: now.toISOString(),
        },
      };
    }
    if (look.kind === 'unwatched') return { kind: 'settled' };
    if (look.kind === 'live') return { kind: 'wait' };
    return { kind: 'fire', event: lookEvent(look, now) };
  }
}

/**
 * The desktop's reach into cloud runs: the signed-in account's web core, as
 * the destination chat's project owner. Loaded lazily, as the watcher
 * service loads the services only some watchers use.
 */
export function cloudRunWatcherDeps(): CloudRunWatcherObserverDeps {
  return {
    available: async () =>
      (
        await import('../agent-actions/desktop-cloud-runs')
      ).cloudRunsAvailable(),
    access: async (chat) =>
      (
        await import('../agent-actions/desktop-cloud-runs')
      ).desktopCloudRunAccess(chat),
  };
}

/**
 * A cloud run watcher's pipeline resource, which its arming and delivery
 * authorize (CAN-6391). A cloud run has no local execution record to read
 * its provenance from; it runs as the destination project's owner, the only
 * owner whose runs the watcher reaches (`desktopCloudRunAccess`), so that
 * owner is the resource's. An owner that can't be read stays unknown, which
 * a strict policy refuses.
 */
export async function cloudRunWatcherResource(target: {
  readonly projectId: string;
  readonly worktreeId: string;
}): Promise<PipelineContextResource> {
  const { agentPipelineOwnerContext } =
    await import('../pipelines/pipeline-owner-policy');
  const result = await agentPipelineOwnerContext(target);
  return 'owner' in result
    ? cloudRunOwnerResource(result.owner)
    : { owner: undefined };
}

/**
 * A cloud run owner (`personal` or `org:<id>`) as a pipeline resource's
 * owner; one that can't be parsed stays unknown.
 */
export function cloudRunOwnerResource(owner: string): PipelineContextResource {
  const context = parseWorkspaceContext(owner);
  if (context === null) return { owner: undefined };
  return context.kind === 'personal'
    ? { owner: { shareScope: 'private' } }
    : {
        owner: {
          type: 'organization',
          id: context.organizationId,
          name: null,
        },
      };
}

let observer: CloudRunWatcherObserver | null = null;

/** The app's one cloud run watcher observer. */
export function getCloudRunWatcherObserver(): CloudRunWatcherObserver {
  observer ??= new CloudRunWatcherObserver(cloudRunWatcherDeps());
  return observer;
}
