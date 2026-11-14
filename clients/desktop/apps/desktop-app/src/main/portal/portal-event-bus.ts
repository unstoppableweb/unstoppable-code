import type { CoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { worktreeScopedParentLocalId } from '@canopy/protocol';
import type { PortalWorktreeCreateRefusal } from '@canopy/protocol/portal';
import type {
  PortalCommandCompletedPayload,
  PortalCommandEnvelope,
  PortalCommandFailedPayload,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  PortalStateSnapshotPayload,
} from '@canopy/desktop-shared/types';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { projectNewTaskControls } from './worktree-new-task-controls';
import { acquirePortalOverviewSnapshot } from './portal-overview-build';
import { subscribeAutoDeleteAttention } from '../lib/auto-delete-attention';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
// Zero top-level imports of its own — defers `runtime-status` (and the
// `__CANOPY_CURSOR_CLI__` build constant it reads) internally, matching
// every other static importer of this module (`ipc/cursor-connection.ts`,
// `ipc/preferences.ts`). Safe here for the same reason.
import {
  peekCursorRuntimeAvailability,
  refreshCursorRuntimeAvailability,
} from '../cursor/runtime-availability';

let active = false;
let eventSink: ((event: PortalEventEnvelope) => void) | null = null;
let unsubscribeAutoDeleteAttention: (() => void) | null = null;
let overviewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let overviewPush: Promise<void> | null = null;
// Arrival mark of the latest push requested while one was in flight; the
// follow-up may reuse any build that started at or after it.
let overviewPushDirtySince: number | null = null;
// Bumped whenever the sink changes or its owner invalidates emissions, so a
// build that spans a session transition never publishes into the next one.
let sinkGeneration = 0;
let diffStatsRefreshTimer: ReturnType<typeof setInterval> | null = null;
const catalogWorktrees = new Map<
  string,
  { workspaceId: string; worktreeId: string }
>();
let advisorCatalogPublished = false;
let catalogRevision = 0;
let copilotCatalogWarmup: AbortController | undefined;
let opencodeCatalogWarmup: AbortController | undefined;

type PublishedDiffStats = { insertions: number; deletions: number } | 'absent';

// This belongs at the transport boundary, rather than in the cache: it tracks
// what the current browser session was told, not what desktop most recently
// computed. Keeping it here also avoids making cache storage own publication
// ordering semantics.
const lastPublishedDiffStats = new Map<string, PublishedDiffStats>();

export interface PortalEmissionContext {
  readonly generation: number;
}

const OVERVIEW_REFRESH_DEBOUNCE_MS = 250;
const DIFF_STATS_REFRESH_TTL_MS = 60_000;

/**
 * Whether a browser session is currently attached to the event sink.
 *
 * Read by producers that would otherwise pay a projection cost for events
 * nobody can receive — see the ambient pipeline run observers, which are
 * attached to every execution but must stay free when no browser is connected.
 * Deliberately re-read per event rather than sampled once at attach time, so a
 * browser that connects mid-run starts receiving updates immediately.
 */
export function isPortalEventSinkActive(): boolean {
  return active;
}

/** Capture the currently installed Portal sink generation, if any. */
export function capturePortalEmissionContext():
  | PortalEmissionContext
  | undefined {
  if (!active || eventSink === null) return undefined;
  return Object.freeze({ generation: sinkGeneration });
}

/** Whether this emission still belongs to the current Portal sink lifetime. */
export function isPortalEmissionContextCurrent(
  context: PortalEmissionContext,
): boolean {
  return active && eventSink !== null && context.generation === sinkGeneration;
}

export function setCanopyPortalEventSink(
  sink: ((event: PortalEventEnvelope) => void) | null,
): void {
  const wasActive = active;
  const sinkChanged = eventSink !== sink;
  if (sinkChanged) {
    sinkGeneration++;
    opencodeCatalogWarmup?.abort();
    opencodeCatalogWarmup = undefined;
    copilotCatalogWarmup?.abort();
    copilotCatalogWarmup = undefined;
    catalogWorktrees.clear();
    advisorCatalogPublished = false;
    catalogRevision++;
  }
  eventSink = sink;
  active = sink !== null;
  // Inactivity sweeps can finish before renderer startup unlocks the armed
  // scheduler. Portal delivery belongs to the connected sink, not that scheduler.
  if (active && unsubscribeAutoDeleteAttention === null) {
    unsubscribeAutoDeleteAttention = subscribeAutoDeleteAttention(
      notifyPortalStructureChanged,
    );
  } else if (!active) {
    unsubscribeAutoDeleteAttention?.();
    unsubscribeAutoDeleteAttention = null;
  }
  // A sweep can commit before subscription. Replay through an authorized
  // overview, even if the browser hydrates from an already-fresh hosted cache.
  if (active && sinkChanged) notifyPortalStructureChanged();
  if (!active && overviewRefreshTimer) {
    clearTimeout(overviewRefreshTimer);
    overviewRefreshTimer = null;
  }
  if (!active) overviewPushDirtySince = null;
  if (!active && diffStatsRefreshTimer) {
    clearInterval(diffStatsRefreshTimer);
    diffStatsRefreshTimer = null;
  }
  if (!active) {
    lastPublishedDiffStats.clear();
    void import('../services/worktree-diff-stats-cache')
      .then((cache) => cache.cancelPendingWorktreeDiffStatsRefreshes())
      .catch(() => undefined);
  }
  if (active && !wasActive) {
    warmCursorRuntimeAvailabilityIfCold();
    const controller = new AbortController();
    copilotCatalogWarmup = controller;
    void import('../copilot/runtime-availability')
      .then(async (copilot) => {
        if (
          !(await copilot.isCopilotRuntimeAvailable()) ||
          controller.signal.aborted
        )
          return;
        // Account models are discovered, not persisted. A desktop restart
        // must hydrate them even when no local model picker has been opened.
        const { listCopilotModels } = await import('../copilot/connection');
        await listCopilotModels(
          AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
        );
        if (!controller.signal.aborted) await notifyPortalModelCatalogChanged();
      })
      .catch(() => undefined)
      .finally(() => {
        if (copilotCatalogWarmup === controller)
          copilotCatalogWarmup = undefined;
      });
    const opencodeController = new AbortController();
    opencodeCatalogWarmup = opencodeController;
    void import('../opencode/runtime-availability')
      .then(async (opencode) => {
        if (
          !(await opencode.isOpenCodeRuntimeAvailable()) ||
          opencodeController.signal.aborted
        )
          return;
        // Account models are discovered, not persisted. A desktop restart
        // must hydrate them even when no local model picker has been opened.
        const { listOpenCodeModels } = await import('../opencode/connection');
        await listOpenCodeModels(
          AbortSignal.any([
            opencodeController.signal,
            AbortSignal.timeout(45_000),
          ]),
        );
        if (!opencodeController.signal.aborted)
          await notifyPortalModelCatalogChanged();
      })
      .catch(() => undefined)
      .finally(() => {
        if (opencodeCatalogWarmup === opencodeController)
          opencodeCatalogWarmup = undefined;
      });
  }
}

/** Invalidate delayed emissions before the owning Portal session is changed. */
export function invalidatePortalEmissionContexts(): void {
  sinkGeneration += 1;
}

/**
 * Deduplicates concurrent warm-up attempts triggered by this function; the
 * shared generation guard inside `refreshCursorRuntimeAvailability()` is
 * what actually protects the cache write from a real Connect/Disconnect/
 * status-IPC race, so this flag only exists to avoid firing a redundant
 * extra probe if several Portal sessions attach in quick succession before
 * the first warm resolves.
 */
let cursorWarmupInFlight = false;

/**
 * A user whose Cursor runtime is already connected, who restarts the
 * desktop and opens the Portal before any local surface (Settings, a
 * `ModelPicker` mount) has probed the runtime, would otherwise see
 * `providerAvailability.cursor` omitted on every projected summary until an
 * unrelated desktop interaction happens to warm it — showing "Connect
 * Cursor in the desktop app" even though the runtime is already connected
 * and selectable through the Portal itself. A Portal session's first
 * activation is the smallest lifecycle point that both (a) is guaranteed to
 * run before the first real snapshot a Portal client can observe, and (b)
 * only fires while the cache is cold — every settled probe warms it, on
 * success and on failure alike, so it adds no hot-path or repeated-probe
 * cost (the warm-up re-arms on each `inactive -> active` transition, but
 * finds a warm cache and no-ops on every one after the first).
 *
 * Fire-and-forget and read-cheap by design: `peekCursorRuntimeAvailability()`
 * callers (Portal snapshot projection) stay fully synchronous and never
 * await this. `setCanopyPortalEventSink` is also reached from
 * `resumeCanopyPortalIfPossible()` at startup, so this runs on every boot
 * that auto-resumes a session — pushing a full overview rebuild (plus its
 * diff-stats sweep and refresh timer) is only justified when the answer
 * actually changes what the next projection shows. `cursor: false` renders
 * identically to the omitted key on every consumer (`PortalModelPicker`,
 * mobile's `RemoteProviderAvailability`), so only a `true` result — the
 * rarer case, and the only one anything downstream can observe — pushes
 * `notifyPortalStructureChanged()`.
 */
function warmCursorRuntimeAvailabilityIfCold(): void {
  if (peekCursorRuntimeAvailability() !== undefined || cursorWarmupInFlight) {
    return;
  }
  cursorWarmupInFlight = true;
  void refreshCursorRuntimeAvailability()
    .then((available) => {
      if (available) {
        notifyPortalStructureChanged();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      cursorWarmupInFlight = false;
    });
}

export function armWorktreeDiffStatsRefreshTimer(): void {
  if (!active || diffStatsRefreshTimer) return;
  diffStatsRefreshTimer = setInterval(() => {
    // Dynamic import intentionally breaks the cache -> event-bus -> cache cycle.
    void import('../services/worktree-diff-stats-cache').then((cache) =>
      cache.requestAllWorktreeDiffStatsRefresh(),
    );
  }, DIFF_STATS_REFRESH_TTL_MS);
}

function diffStatsKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

function entityDiffStats(entity: PortalEntityEnvelope): PublishedDiffStats {
  if (!isRecord(entity.payload)) return 'absent';
  const diffStats = entity.payload.diffStats;
  if (!isRecord(diffStats)) return 'absent';
  const { insertions, deletions } = diffStats;
  return typeof insertions === 'number' && typeof deletions === 'number'
    ? { insertions, deletions }
    : 'absent';
}

function diffStatsEqual(
  left: PublishedDiffStats | undefined,
  right: PublishedDiffStats,
): boolean {
  if (left === 'absent' || right === 'absent') return left === right;
  return (
    left?.insertions === right.insertions && left.deletions === right.deletions
  );
}

export function getPortalModelCatalogRevision(): number {
  return catalogRevision;
}

export function recordPublishedWorktreeDiffStats(
  snapshot: PortalStateSnapshotPayload,
  builtCatalogRevision = catalogRevision,
): void {
  // Keep only identities of scopes the browser has hydrated. Overview no
  // longer carries chat catalogs, and must not subscribe every worktree.
  const workspaceId = snapshot.target?.workspaceLocalId;
  const worktreeId = snapshot.target?.worktreeLocalId;
  if (
    active &&
    (snapshot.scope === 'chat' || snapshot.scope === 'worktree') &&
    workspaceId &&
    worktreeId
  ) {
    catalogWorktrees.set(diffStatsKey(workspaceId, worktreeId), {
      workspaceId,
      worktreeId,
    });
  }
  if (active && snapshot.scope === 'app_advisor')
    advisorCatalogPublished = true;
  // A catalog can settle after projection but before the snapshot is queued.
  // Repair only after publication so the stale snapshot cannot erase the delta.
  if (
    active &&
    builtCatalogRevision !== catalogRevision &&
    (snapshot.scope === 'chat' ||
      snapshot.scope === 'worktree' ||
      snapshot.scope === 'app_advisor')
  ) {
    void notifyPortalModelCatalogChanged();
  }
  const carriedWorktrees: Array<{ workspaceId: string; worktreeId: string }> =
    [];
  for (const entity of snapshot.entities) {
    if (entity.entityType !== 'worktree' || !entity.parentLocalId) continue;
    const workspaceId = entity.parentLocalId;
    const worktreeId = entity.localId;
    lastPublishedDiffStats.set(
      diffStatsKey(workspaceId, worktreeId),
      entityDiffStats(entity),
    );
    carriedWorktrees.push({ workspaceId, worktreeId });
  }

  // Reconcile against the live cache only after every snapshot value is
  // recorded. Any repair delta therefore queues after the snapshot it repairs.
  void import('../services/worktree-diff-stats-cache').then((cache) => {
    for (const { workspaceId, worktreeId } of carriedWorktrees) {
      const cached = cache.getCachedWorktreeDiffStats(workspaceId, worktreeId);
      if (!cached) continue;
      const published = lastPublishedDiffStats.get(
        diffStatsKey(workspaceId, worktreeId),
      );
      if (!diffStatsEqual(published, cached)) {
        void emitWorktreeDiffStatsDelta(
          workspaceId,
          worktreeId,
          cached.generation,
        );
      }
    }
  });
}

export async function emitWorktreeDiffStatsDelta(
  workspaceId: string,
  worktreeId: string,
  generation: number,
): Promise<void> {
  if (!active) return;
  try {
    // Dynamic import intentionally breaks the cache -> event-bus -> cache cycle.
    const cache = await import('../services/worktree-diff-stats-cache');
    const cacheKey = diffStatsKey(workspaceId, worktreeId);
    const cached = cache.getCachedWorktreeDiffStats(workspaceId, worktreeId);
    if (
      cached?.generation !== generation ||
      diffStatsEqual(lastPublishedDiffStats.get(cacheKey), cached)
    ) {
      return;
    }
    // Dynamic import intentionally breaks the workspace service -> cache ->
    // event-bus -> workspace service cycle.
    const {
      getWorkspacePortalWorktreeEntity,
      getWorkspacePortalWorktreeRuntimeStatus,
    } = await import('../services/workspace-portal-service');
    let runtimeStatus = await getWorkspacePortalWorktreeRuntimeStatus(
      workspaceId,
      worktreeId,
    );
    let entity = await getWorkspacePortalWorktreeEntity(
      workspaceId,
      worktreeId,
      runtimeStatus,
    );
    const refreshedRuntimeStatus =
      await getWorkspacePortalWorktreeRuntimeStatus(workspaceId, worktreeId);
    if (!isDeepStrictEqual(refreshedRuntimeStatus, runtimeStatus)) {
      runtimeStatus = refreshedRuntimeStatus;
      entity = await getWorkspacePortalWorktreeEntity(
        workspaceId,
        worktreeId,
        runtimeStatus,
      );
      // One rebuild is enough: if status changes again while it awaits IO, drop
      // this diff-only delta and let the dedicated runtime-status emitter win.
      const finalRuntimeStatus = await getWorkspacePortalWorktreeRuntimeStatus(
        workspaceId,
        worktreeId,
      );
      if (!isDeepStrictEqual(finalRuntimeStatus, runtimeStatus)) {
        return;
      }
    }
    const finalCached = cache.getCachedWorktreeDiffStats(
      workspaceId,
      worktreeId,
    );
    if (
      !active ||
      entity === null ||
      finalCached?.generation !== generation ||
      finalCached.insertions !== cached.insertions ||
      finalCached.deletions !== cached.deletions ||
      diffStatsEqual(lastPublishedDiffStats.get(cacheKey), finalCached)
    ) {
      return;
    }
    const owner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: workspaceId,
      worktreeId,
    });
    const enrichedEntity = projectNewTaskControls(
      [entity],
      worktreeId,
      owner,
      await catalogAgentDefaultModel(workspaceId),
    )[0];
    if (!enrichedEntity) return;
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'worktree',
        target: { workspaceLocalId: workspaceId, worktreeLocalId: worktreeId },
        entities: [enrichedEntity],
        generatedAt: new Date().toISOString(),
      }),
    );
    lastPublishedDiffStats.set(cacheKey, {
      insertions: finalCached.insertions,
      deletions: finalCached.deletions,
    });
  } catch {
    // Delta publication is best-effort. Leave the published tracker unchanged
    // so a later refresh retries the same cache value.
  }
}

/** Refresh already-hydrated composer catalogs after a provider account changes. */
export async function notifyPortalModelCatalogChanged(): Promise<void> {
  if (!active) return;
  const revision = ++catalogRevision;
  const current = (): boolean => active && revision === catalogRevision;
  notifyPortalStructureChanged(); // Cowork and sidebar metadata retain their existing path.
  const { listWorktreeChatSummaries, projectAllAppAdvisorChatSummaries } =
    await import('../services/chat-service');
  const {
    getWorkspacePortalWorktreeEntity,
    getWorkspacePortalWorktreeRuntimeStatus,
  } = await import('../services/workspace-portal-service');
  for (const { workspaceId, worktreeId } of Array.from(
    catalogWorktrees.values(),
  )) {
    if (!current()) return;
    try {
      const summaries = await listWorktreeChatSummaries({
        workspaceId,
        worktreeId,
      });
      const status = await getWorkspacePortalWorktreeRuntimeStatus(
        workspaceId,
        worktreeId,
      );
      const worktree = await getWorkspacePortalWorktreeEntity(
        workspaceId,
        worktreeId,
        status,
      );
      const owner = await resolveAiCreditsScopeOwner({
        kind: 'work',
        projectId: workspaceId,
        worktreeId,
      });
      if (!current()) return;
      // Use full canonical entities: a delta is an upsert, not a field patch.
      const entities: PortalEntityEnvelope[] = summaries.map((summary) => ({
        entityType: 'chat_summary',
        localId: summary.chatId,
        parentLocalId: worktreeScopedParentLocalId(workspaceId, worktreeId),
        payload: summary,
      }));
      if (worktree)
        entities.push(
          ...projectNewTaskControls(
            [worktree],
            worktreeId,
            owner,
            await catalogAgentDefaultModel(workspaceId),
          ),
        );
      enqueuePortalEvent(
        createPortalEvent('portal.state.delta', {
          scope: 'worktree',
          target: {
            workspaceLocalId: workspaceId,
            worktreeLocalId: worktreeId,
          },
          entities,
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch {
      // A failed scope recovers on its next state request; other scopes still refresh.
    }
  }
  if (current() && advisorCatalogPublished)
    await projectAllAppAdvisorChatSummaries(current);
}

async function catalogAgentDefaultModel(
  workspaceId: string,
): Promise<string | undefined> {
  // Lazy: the default-model resolver reaches services that import this bus.
  const { resolveCatalogAgentDefaultModel } =
    await import('../agents/agent-default-model');
  return resolveCatalogAgentDefaultModel(workspaceId);
}

export function isCanopyPortalActive(): boolean {
  return active;
}

export function createPortalEvent(
  type: PortalEventEnvelope['type'],
  payload: unknown,
  options: {
    commandId?: string;
    occurredAt?: string;
    eventId?: string;
    clientEventId?: string;
  } = {},
): PortalEventEnvelope {
  const eventId = options.eventId ?? options.clientEventId ?? randomUUID();
  return {
    type,
    ...(options.commandId ? { commandId: options.commandId } : {}),
    eventId,
    clientEventId: eventId,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    payload,
  };
}

export function enqueuePortalEvent(event: PortalEventEnvelope): void {
  eventSink?.(event);
}

/** Enqueue an event only while the captured Portal sink generation is current. */
export function enqueuePortalEventIfCurrent(
  context: PortalEmissionContext,
  event: PortalEventEnvelope,
): boolean {
  if (!isPortalEmissionContextCurrent(context)) return false;
  enqueuePortalEvent(event);
  return true;
}

/** Push a fresh authoritative overview after persisted sidebar structure changes. */
export function notifyPortalStructureChanged(): void {
  if (!active) return;
  if (overviewRefreshTimer) {
    clearTimeout(overviewRefreshTimer);
  }
  overviewRefreshTimer = setTimeout(() => {
    overviewRefreshTimer = null;
    pushPortalOverviewSnapshot();
  }, OVERVIEW_REFRESH_DEBOUNCE_MS);
}

/**
 * Enqueue an uncorrelated overview snapshot. At most one push is in flight; a
 * trigger during it marks the push dirty and runs exactly one more after it.
 */
export function pushPortalOverviewSnapshot(
  arrivedAt = performance.now(),
): void {
  if (!active) return;
  if (overviewPush) {
    overviewPushDirtySince = arrivedAt;
    return;
  }
  overviewPushDirtySince = null;
  overviewPush = runOverviewPush(arrivedAt).finally(() => {
    overviewPush = null;
    if (overviewPushDirtySince !== null) {
      pushPortalOverviewSnapshot(overviewPushDirtySince);
    }
  });
}

async function runOverviewPush(arrivedAt: number): Promise<void> {
  const generation = sinkGeneration;
  try {
    const built = await acquirePortalOverviewSnapshot(arrivedAt);
    if (!active || generation !== sinkGeneration) return;
    enqueuePortalEvent(
      createPortalEvent('portal.state.snapshot', built.snapshot),
    );
    recordPublishedWorktreeDiffStats(built.snapshot);
    // The snapshot is now ordered ahead of any cache-fill delta it starts.
    armWorktreeDiffStatsRefreshTimer();
    void import('../services/worktree-diff-stats-cache')
      .then((cache) => cache.refreshMissingWorktreeDiffStats())
      .catch(() => undefined);
    // Mirror the portal.state.request handler: any follow-up events the
    // builder attaches to an overview snapshot must reach the portal on
    // this push path too, or the two refresh paths diverge.
    for (const event of built.followUpEvents) {
      enqueuePortalEvent(event);
    }
  } catch (error) {
    // Best-effort: the browser recovers through its own state request. The
    // trace separates a failed push from one that never fired. Loaded
    // lazily, like the builders, to keep this module's eager graph small.
    try {
      const { getObservabilityService } =
        await import('../observability/index');
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'portal_structural_sync_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Diagnostics are themselves best-effort.
    }
  }
}

export function createPortalCommandEvent(
  command: PortalCommandEnvelope,
  type: PortalEventEnvelope['type'],
  payload: unknown,
): PortalEventEnvelope {
  return createPortalEvent(type, payload, { commandId: command.id });
}

export function createCommandCompletedPayload<TResult = unknown>(
  command: PortalCommandEnvelope,
  result?: TResult,
): PortalCommandCompletedPayload<TResult> {
  return {
    commandId: command.id,
    sequenceNumber: command.sequence,
    ...(result === undefined ? {} : { result }),
    generatedAt: new Date().toISOString(),
  };
}

export function createCommandFailedPayload(
  command: PortalCommandEnvelope,
  code: string,
  message: string,
  retryable = false,
  details?: {
    refusal?: PortalWorktreeCreateRefusal;
    coworkFolderMissing?: CoworkFolderMissing;
  },
): PortalCommandFailedPayload {
  return {
    commandId: command.id,
    sequenceNumber: command.sequence,
    error: {
      code,
      message,
      ...(details?.coworkFolderMissing
        ? { coworkFolderMissing: details.coworkFolderMissing }
        : {}),
    },
    ...(details?.refusal === undefined ? {} : { refusal: details.refusal }),
    ...(command.type.startsWith('portal.script_actions.') ||
    command.type === 'portal.collections.save' ||
    command.type === 'portal.task_refs.list'
      ? { response: { code, message } }
      : {}),
    retryable,
    generatedAt: new Date().toISOString(),
  };
}
