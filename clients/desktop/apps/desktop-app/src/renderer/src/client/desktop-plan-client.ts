import {
  DetectedPlanListResultSchema,
  DetectedPlanScanResultSchema,
  DetectedPlanUpdateResultSchema,
  PlanGetResultSchema,
  PlanImportResultSchema,
  PlanListResultSchema,
  PlanWriteResultSchema,
  type PlanRecord,
} from '@canopy/protocol/canopy-core';
import {
  isTrackedPlanData,
  type CreateTrackedPlanRequest,
  type DeleteTrackedPlanRequest,
  type DetectedPlanEntry,
  type DetectedPlanUpdateRequest,
  type DetectedPlansListRequest,
  type DetectedPlansScanRequest,
  type DetectedPlansScanResponse,
  type ImportTrackedPlanRequest,
  type TrackedPlanData,
  type TrackedPlanGetRequest,
  type TrackedPlanListRequest,
  type TrackedPlanListWithSkippedResult,
  type UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import {
  detectedPlanScanParams,
  detectedPlanUpdateParams,
  trackedPlanImportParams,
  trackedPlanCreateParams,
  trackedPlanUpdateParams,
} from '@canopy/desktop-shared/lib/tracked-plan-params';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { isCoworkChatTarget } from '../lib/cowork';

/*
 * The main window's plan reads and plan writes, as core.plan calls through
 * the renderer relay (CAN-4165 PRs 7a, 7b and 7c). They answer what the tracked-plans and
 * detected-plans channels answer. A remote window can't use the relay (its
 * channel is blocked there), so it keeps the channels, which reach the
 * computer it shows; a read too large for the relay does too.
 */

function isRemoteWindow(): boolean {
  return window.api.remoteControl.getContext().mode === 'remote';
}

type RelayReply = Awaited<ReturnType<typeof window.canopyCore.invoke>>;

/** A read, with the same bounded busy re-sends as a write. */
function query(
  method: string,
  params: Record<string, unknown>,
): Promise<RelayReply> {
  return send({ kind: 'request', method, params });
}

/** The value, or the refusal's own message, as the channel answered it. */
function valueOf(reply: RelayReply): unknown {
  if (!reply.ok)
    throw Object.assign(new Error(reply.error.message), { cause: reply.error });
  return reply.value;
}

/*
 * The relay's 1 MiB reply cap or the in-memory binding's 2 MiB frame cap
 * refused the answer for its size; the channels have no cap. Only a size
 * refusal falls back to the channel: every other relay failure still fails
 * with its own message and no fallback, so a guard failure or a busy relay
 * never reads the channel.
 * shortcut: a scope this large reads twice, until bounded plan reads (a
 * summary list plus each plan's body on request) replace the whole-scope list.
 */
function refusedForSize(reply: RelayReply): boolean {
  if (reply.ok) return false;
  const { kind, retry } = reply.error;
  return (
    kind === 'resource_exhausted' &&
    retry.kind === 'after_refresh' &&
    (retry.resource === 'reply' || retry.resource === 'relay.frame')
  );
}

function scopeOf(request: TrackedPlanListRequest): {
  projectId: string;
  worktreeId: string;
} {
  return { projectId: request.projectId, worktreeId: request.worktreeId };
}

/**
 * The list over the channels, for a remote window or a scope too large for
 * the relay: the host's count of records it left out
 * (CAN-6666), or the plain list from a host on an older release, which
 * refuses the newer read.
 */
async function listOverChannels(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanListWithSkippedResult> {
  const plans = window.api.activity.plans;
  if (typeof plans.listWithSkipped !== 'function')
    return { plans: await plans.list(request) };
  try {
    return await plans.listWithSkipped(request);
  } catch (error) {
    reportClientAppError(error);
    return { plans: await plans.list(request) };
  }
}

/** A worktree's tracked plans, and how many stored records were left out. */
export async function listTrackedPlans(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanListWithSkippedResult> {
  if (isRemoteWindow()) return listOverChannels(request);
  const reply = await query('core.plan.list', { scope: scopeOf(request) });
  if (refusedForSize(reply)) return listOverChannels(request);
  const listed = PlanListResultSchema.parse(valueOf(reply));
  const plans: TrackedPlanData[] = [];
  for (const record of listed.plans)
    if (isTrackedPlanData(record)) plans.push(record);
  const skipped = (listed.skipped ?? 0) + listed.plans.length - plans.length;
  return skipped > 0 ? { plans, skipped } : { plans };
}

/** The plan, or null when the scope has none by that id. */
export async function getTrackedPlan(
  request: TrackedPlanGetRequest,
): Promise<TrackedPlanData | null> {
  if (isRemoteWindow()) return window.api.activity.plans.get(request);
  const reply = await query('core.plan.get', {
    scope: scopeOf(request),
    planId: request.planId,
  });
  if (refusedForSize(reply)) return window.api.activity.plans.get(request);
  const { plan } = PlanGetResultSchema.parse(valueOf(reply));
  return plan && isTrackedPlanData(plan) ? plan : null;
}

/** A worktree's detected plan files. */
export async function listDetectedPlans(
  request: DetectedPlansListRequest,
): Promise<DetectedPlanEntry[]> {
  if (isRemoteWindow()) return window.api.activity.detectedPlans.list(request);
  const reply = await query('core.plan.detected.list', {
    scope: scopeOf(request),
  });
  if (refusedForSize(reply))
    return window.api.activity.detectedPlans.list(request);
  return DetectedPlanListResultSchema.parse(valueOf(reply)).detected;
}

/**
 * A worktree's detected plan files, read back after a committed write: over
 * the channel when the relay's read fails, since only a write never falls
 * back.
 */
async function readBackDetectedPlans(
  request: DetectedPlansListRequest,
): Promise<DetectedPlanEntry[]> {
  try {
    return await listDetectedPlans(request);
  } catch (error) {
    reportClientAppError(error);
    return window.api.activity.detectedPlans.list(request);
  }
}

/*
 * A keyed write whose reply the relay's reply cap or the binding's frame cap
 * refused: the write committed, and only its answer is too large to cross.
 * A refusal before dispatch (a busy relay, an oversize request) names
 * after_refresh instead.
 */
function committedTooLarge(reply: RelayReply): boolean {
  return (
    !reply.ok &&
    reply.error.kind === 'resource_exhausted' &&
    reply.error.retry.kind === 'same_idempotency_key'
  );
}

/** The relay's request cap turned it away, before dispatching anything. */
function requestTooLarge(reply: RelayReply): boolean {
  return (
    !reply.ok &&
    reply.error.kind === 'resource_exhausted' &&
    reply.error.retry.kind === 'after_refresh' &&
    reply.error.retry.resource === 'request'
  );
}

/** The relay's own call cap turned it away, before dispatching anything. */
function turnedAwayBusy(reply: RelayReply): boolean {
  return (
    !reply.ok &&
    reply.error.kind === 'resource_exhausted' &&
    reply.error.retry.kind === 'after_refresh' &&
    reply.error.retry.resource === 'relay'
  );
}

const BUSY_BACKOFF_MS = [50, 150, 400];
/*
 * A detected-plan update, about 7.6 s: the banner sends every pending
 * dismissal at once, past the relay's 32-call cap, and each waits here for
 * admission.
 */
const DETECTED_UPDATE_BACKOFF_MS = [50, 150, 400, 1_000, 2_000, 4_000];

/** One send, re-sent at each delay while the relay turns it away busy. */
async function send(
  request: Parameters<typeof window.canopyCore.invoke>[0],
  backoffMs: readonly number[] = BUSY_BACKOFF_MS,
): Promise<RelayReply> {
  let reply = await window.canopyCore.invoke(request);
  for (const delayMs of backoffMs) {
    if (!turnedAwayBusy(reply)) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    reply = await window.canopyCore.invoke(request);
  }
  return reply;
}

/*
 * A keyed write. A busy relay's refusal is re-sent at each delay (three by
 * default), since nothing was dispatched. A reply lost on its way back (the relay asks for
 * the same key) is re-sent once under that key, which answers the first
 * outcome, with the same busy re-sends, since the relay checks its call cap
 * before the key; one refused for its size isn't, since its replay is just
 * as large. A write never falls back to its channel.
 */
async function instruct(
  method: string,
  params: Record<string, unknown>,
  backoffMs?: readonly number[],
): Promise<RelayReply> {
  const request = {
    kind: 'request' as const,
    method,
    params: { ...params, _meta: { idempotencyKey: crypto.randomUUID() } },
  };
  const reply = await send(request, backoffMs);
  return !reply.ok &&
    reply.error.retry.kind === 'same_idempotency_key' &&
    !committedTooLarge(reply)
    ? send(request, backoffMs)
    : reply;
}

/** The plan a write stored, which the main window can only show if tracked. */
function writtenPlan(record: PlanRecord | null): TrackedPlanData {
  if (!record || !isTrackedPlanData(record))
    throw new Error('The stored plan could not be read.');
  return record;
}

export async function createTrackedPlan(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  if (isRemoteWindow()) return window.api.activity.plans.create(request);
  // Its own id lets a create whose reply is too large read its plan back. A
  // Cursor proposal without one merges into its chat's pending plan, so it
  // keeps none and is found by its proposal request instead.
  const planId =
    request.id ??
    (request.source === 'cursor' && request.proposalRequestId
      ? undefined
      : crypto.randomUUID());
  const reply = await instruct(
    'core.plan.create',
    trackedPlanCreateParams(scopeOf(request), {
      ...request,
      ...(planId ? { id: planId } : {}),
    }),
  );
  if (committedTooLarge(reply)) {
    // A proposal re-save answers the plan its request already stored, which
    // may have another id, so it is found by that request instead.
    const stored =
      (planId && (await getTrackedPlan({ ...scopeOf(request), planId }))) ||
      (request.proposalRequestId &&
        (await listTrackedPlans(scopeOf(request))).plans.find((plan) =>
          plan.revisions.some(
            (revision) =>
              revision.proposalRequestId === request.proposalRequestId,
          ),
        ));
    if (stored) return stored;
  }
  return writtenPlan(PlanWriteResultSchema.parse(valueOf(reply)).plan);
}

/** The updated plan, or null when the scope has none by that id. */
export async function updateTrackedPlan(
  request: UpdateTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  if (isRemoteWindow()) return window.api.activity.plans.update(request);
  const reply = await instruct(
    'core.plan.update',
    trackedPlanUpdateParams(scopeOf(request), request),
  );
  if (committedTooLarge(reply))
    return getTrackedPlan({ ...scopeOf(request), planId: request.planId });
  const { plan } = PlanWriteResultSchema.parse(valueOf(reply));
  return plan ? writtenPlan(plan) : null;
}

export async function deleteTrackedPlan(
  request: DeleteTrackedPlanRequest,
): Promise<void> {
  if (isRemoteWindow()) return window.api.activity.plans.delete(request);
  valueOf(
    await instruct('core.plan.delete', {
      scope: scopeOf(request),
      planId: request.planId,
    }),
  );
}

/**
 * The imported plan. Browsing for the file (no path) stays on the channel:
 * a file the native dialog picks may be anywhere, which no portable path
 * names (CAN-4165 5a debt). Null when the person cancels that dialog.
 */
export async function importTrackedPlan(
  request: ImportTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const { filePath } = request;
  if (isRemoteWindow() || !filePath)
    return (await window.api.activity.plans.import(request)).plan;
  const params = trackedPlanImportParams(scopeOf(request), {
    ...request,
    filePath,
  });
  const { plan } = PlanImportResultSchema.parse(
    valueOf(await instruct('core.plan.import', params)),
  );
  return writtenPlan(plan);
}

/**
 * The scan's whole list and what it added. A cowork chat has no detected
 * plans, so it answers nothing without asking, as the channel does.
 */
export async function scanDetectedPlans(
  request: DetectedPlansScanRequest,
): Promise<DetectedPlansScanResponse> {
  if (isRemoteWindow()) return window.api.activity.detectedPlans.scan(request);
  if (isCoworkChatTarget(request.projectId))
    return { entries: [], newlyDetected: [] };
  const reply = await instruct(
    'core.plan.detected.scan',
    detectedPlanScanParams(scopeOf(request), request),
  );
  // Nothing ran, so the channel, which has no cap, scans it instead. Only a
  // scan: an update is small, and a write that ran never falls back.
  if (requestTooLarge(reply))
    return window.api.activity.detectedPlans.scan(request);
  // Its additions are in the list read back; no caller reads newlyDetected.
  if (committedTooLarge(reply))
    return {
      entries: await readBackDetectedPlans(scopeOf(request)),
      newlyDetected: [],
    };
  const { detected, newlyDetected } = DetectedPlanScanResultSchema.parse(
    valueOf(reply),
  );
  return { entries: detected, newlyDetected };
}

/** The worktree's detected plans after the update. */
export async function updateDetectedPlan(
  request: DetectedPlanUpdateRequest,
): Promise<DetectedPlanEntry[]> {
  if (isRemoteWindow())
    return window.api.activity.detectedPlans.update(request);
  const reply = await instruct(
    'core.plan.detected.update',
    detectedPlanUpdateParams(scopeOf(request), request),
    DETECTED_UPDATE_BACKOFF_MS,
  );
  if (committedTooLarge(reply)) return readBackDetectedPlans(scopeOf(request));
  return DetectedPlanUpdateResultSchema.parse(valueOf(reply)).detected;
}
