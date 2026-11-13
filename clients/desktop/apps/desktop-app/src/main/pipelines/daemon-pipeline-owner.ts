import type { CanopyClientStreamHandle } from '@canopy/core-client';
import {
  isWorkerPipelineHostWithdrawal,
  type CanopyHostExecution,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import {
  applyPortableHostRequest,
  type PortableHostRunContext,
} from '@canopy/desktop-shared/node/pipelines/host-request-apply';
import type { PipelineHostActions } from '@canopy/execution-engine/node/pipelines/executor/types';
import { portableOwner } from '@canopy/execution-engine/node/pipelines/host-request-portable';
import {
  disposeDaemonPipelineOwner,
  getDaemonPipelineOwnerClient,
  type ElectronDaemonOwnerClient,
} from '../canopy-runtime/electron-daemon-owner';
import { daemonUnreachableReason } from '../canopy-runtime/electron-daemon-connection';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  getDaemonPipelineExecutionHandle,
  hasOwnerBoundDaemonPipelineRuns,
} from './daemon-pipeline-execution';

/*
 * Electron main settles the host requests of the daemon it spawned
 * (CAN-5771) over its one owner subscription: each host step of a run main
 * follows is applied with the desktop host of the run's start. This is the
 * only owner subscription in main; CAN-5095's owner requests route through
 * it too, because the daemon keeps one and a second would replace the first.
 */

export const DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE =
  'This app did not start this workflow run.';

/** The answer to one routed request; `execution` excludes `childEnvironment`, which `respond` adds as `{}`. */
export type DaemonPipelineOwnerAnswer = {
  readonly result: WorkerPipelineHostResult;
  readonly execution?: Omit<CanopyHostExecution, 'childEnvironment'>;
};

type OwnerRequestHandler = (
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
) => Promise<DaemonPipelineOwnerAnswer>;

const NOT_STARTED_HERE: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE,
  outputs: {},
};

const OWNER_REQUEST_UNHANDLED: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: 'This workflow step cannot run in the background service.',
  outputs: {},
};

const FAILED_UNEXPECTEDLY_MESSAGE = 'The host step failed unexpectedly.';

const FAILED_UNEXPECTEDLY: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: null,
  message: FAILED_UNEXPECTEDLY_MESSAGE,
  outputs: {},
};

const RETRY_DELAY_MS = 1_000;
const RETRY_ATTEMPTS = 3;

interface InFlightApply {
  readonly abort: AbortController;
  readonly executionId: string;
  /** The daemon replayed the request meanwhile. */
  replayed?: boolean;
}

interface OwnerSubscription {
  readonly client: ElectronDaemonOwnerClient;
  stream?: CanopyClientStreamHandle<WorkerPipelineHostRequestsItem, object>;
}

const inFlight = new Map<string, InFlightApply>();
/**
 * Answers no daemon has acknowledged yet, by request id: a replayed request
 * resends its answer instead of running the host step again.
 */
const unsent = new Map<
  string,
  {
    readonly request: WorkerPipelineHostRequest;
    readonly answer: DaemonPipelineOwnerAnswer;
  }
>();
let ownerRequestHandler: OwnerRequestHandler | null = null;
let subscription: OwnerSubscription | null = null;
/** Counts the owner subscriptions opened; a capability bound under one ends with it (CAN-6168). */
let generation = 0;
let opening: Promise<void> | undefined;
let retries = 0;
let disposed = false;

/**
 * CAN-5095's handler for `owner.*` requests, set once by its settlement
 * module; `null` clears it. Without one, an owner request is answered
 * `{ status: 'failure', failureReason: null, message: 'This workflow step cannot run in the background service.', outputs: {} }`.
 */
/** The current owner subscription's generation (CAN-6168). */
export function daemonPipelineOwnerGeneration(): number {
  return generation;
}

export function setDaemonPipelineOwnerRequestHandler(
  handler: OwnerRequestHandler | null,
): void {
  ownerRequestHandler = handler;
}

/** Opens the owner session and its host request subscription once; resolves when it is open. */
export function ensureDaemonPipelineOwnerSettlement(): Promise<void> {
  if (disposed)
    return Promise.reject(new Error('Workflow host steps are closed.'));
  if (subscription?.stream) return Promise.resolve();
  opening ??= open().finally(() => {
    opening = undefined;
  });
  return opening;
}

async function open(): Promise<void> {
  const client = await getDaemonPipelineOwnerClient();
  // A stop while the client was coming must not leave a live subscription.
  if (disposed) throw new Error('Workflow host steps are closed.');
  const opened: OwnerSubscription = { client };
  // Set before the stream opens: its first frames can precede the open result.
  subscription = opened;
  generation += 1;
  try {
    opened.stream = await client.openStream(
      'worker.pipeline.hostRequests',
      {},
      {
        onFrame: (frame) => {
          if (subscription !== opened) return;
          if (frame.kind === 'end') closed(opened);
          else receive(opened.client, frame.item);
        },
      },
    );
  } catch (error) {
    if (subscription === opened) subscription = null;
    throw error;
  }
  if (subscription !== opened) {
    opened.stream.close();
    return;
  }
  retries = 0;
  client.signal.addEventListener('abort', () => closed(opened), {
    once: true,
  });
  if (client.signal.aborted) closed(opened);
}

/** The stream ended or its connection dropped. */
function closed(ended: OwnerSubscription): void {
  if (subscription !== ended) return;
  subscription = null;
  ended.stream?.close();
  retryLater();
}

/** The daemon pauses owner-bound runs 10 s after the owner goes (D17). */
function retryLater(): void {
  if (disposed || retries >= RETRY_ATTEMPTS) return;
  if (!hasOwnerBoundDaemonPipelineRuns()) return;
  retries += 1;
  setTimeout(() => {
    if (disposed || subscription) return;
    ensureDaemonPipelineOwnerSettlement().catch(() => retryLater());
  }, RETRY_DELAY_MS).unref?.();
}

function receive(
  client: ElectronDaemonOwnerClient,
  item: WorkerPipelineHostRequestsItem,
): void {
  if (isWorkerPipelineHostWithdrawal(item)) {
    const apply = inFlight.get(item.requestId);
    if (apply?.executionId === item.executionId) apply.abort.abort();
    return;
  }
  // The daemon replays pending requests to a new subscription; a replay of
  // a request in flight joins it.
  const running = inFlight.get(item.requestId);
  if (running) {
    running.replayed = true;
    return;
  }
  const apply: InFlightApply = {
    abort: new AbortController(),
    executionId: item.executionId,
  };
  inFlight.set(item.requestId, apply);
  const held = unsent.get(item.requestId);
  const work =
    held?.request.executionId === item.executionId
      ? respond(client, held.request, held.answer)
      : settle(client, item, apply);
  void work.finally(() => {
    if (inFlight.get(item.requestId) !== apply) return;
    inFlight.delete(item.requestId);
    // A replay that came meanwhile gets the answer if it ended up held.
    const unanswered = unsent.get(item.requestId);
    if (apply.replayed && unanswered && subscription?.stream)
      receive(subscription.client, unanswered.request);
  });
}

async function settle(
  client: ElectronDaemonOwnerClient,
  request: WorkerPipelineHostRequest,
  apply: InFlightApply,
): Promise<void> {
  let answer: DaemonPipelineOwnerAnswer;
  try {
    answer = await routeDaemonPipelineHostRequest(request, apply.abort.signal);
  } catch (error) {
    logMainProcessError('Pipeline host request failed', error);
    answer = { result: FAILED_UNEXPECTEDLY };
  }
  // A call the abort ended (withdrawn, its mirror settled, or the app is
  // quitting) gets no answer: its failure would fail a run the daemon pauses
  // once its owner is gone (CAN-6033). A call that finished first still
  // answers, so its effects are not repeated on a replay.
  if (apply.abort.signal.aborted && answer.result.status === 'failure') return;
  await respond(client, request, answer);
}

function isRedactedFailure(result: WorkerPipelineHostResult): boolean {
  return (
    result.status === 'failure' &&
    result.failureReason === null &&
    result.message === FAILED_UNEXPECTEDLY_MESSAGE
  );
}

/**
 * What may be sent again for `answer` on another session or a replay. An MCP
 * authorization header goes only to the session it was issued for
 * (CAN-6168): a resend carries no header, so the step authorizes again
 * under the current owner subscription.
 */
function resendableAnswer(
  answer: DaemonPipelineOwnerAnswer,
): DaemonPipelineOwnerAnswer {
  if (answer.execution?.pipelineOwnerValues?.mcpAuthorization === undefined)
    return answer;
  return {
    result: {
      status: 'owner',
      value: { kind: 'mcp.authorize', grantId: null },
    },
  };
}

async function respond(
  client: ElectronDaemonOwnerClient,
  request: WorkerPipelineHostRequest,
  answer: DaemonPipelineOwnerAnswer,
): Promise<void> {
  const send = (
    target: ElectronDaemonOwnerClient,
    result: WorkerPipelineHostResult,
    execution: DaemonPipelineOwnerAnswer['execution'],
  ): Promise<unknown> =>
    target.instruction(
      'worker.pipeline.hostRequest.respond',
      {
        executionId: request.executionId,
        requestId: request.requestId,
        result,
      },
      {
        metadata: {},
        ...(execution && { execution: { childEnvironment: {}, ...execution } }),
      },
    );
  const { requestId } = request;
  try {
    await send(client, answer.result, answer.execution);
    unsent.delete(requestId);
    return;
  } catch (error) {
    let refusedBy = client;
    if (daemonUnreachableReason(error) !== null || client.signal.aborted) {
      // The session dropped: the same answer, once, on a new client.
      const resend = resendableAnswer(answer);
      let next: ElectronDaemonOwnerClient | undefined;
      try {
        next = await getDaemonPipelineOwnerClient();
        await send(next, resend.result, resend.execution);
        unsent.delete(requestId);
        return;
      } catch (resendError) {
        if (
          next === undefined ||
          daemonUnreachableReason(resendError) !== null ||
          next.signal.aborted
        ) {
          // Held for the daemon's replay of this request.
          unsent.set(requestId, { request, answer: resend });
          return;
        }
        refusedBy = next;
      }
    }
    unsent.delete(requestId);
    try {
      // The daemon refused the answer: it learns the step failed instead.
      if (!isRedactedFailure(answer.result))
        await send(refusedBy, FAILED_UNEXPECTEDLY, undefined);
    } catch {
      // The daemon answers the step itself once its deadline passes.
    }
  }
}

/**
 * One daemon host request, routed (CAN-5771). CAN-5095 PR 7 adds one branch
 * before the host-step branch: `request.request.action.startsWith('owner.')`
 * goes to `applyPipelineOwnerRequest`.
 */
/** What an owner-bound start applies its host steps with. */
export interface DaemonPipelineHostStepsTarget {
  readonly executionsDir: string;
  readonly hostSteps: {
    readonly context: Omit<PortableHostRunContext, 'executionsDir'>;
    readonly actions: PipelineHostActions;
  };
}

/** Owner-bound starts sent to the daemon whose mirror is not registered yet. */
const startingRuns = new Map<string, DaemonPipelineHostStepsTarget>();

/**
 * Registers an owner-bound start's host steps before it is sent, so a host
 * request the daemon raises before the start returns is settled, not
 * refused. The returned release runs once the mirror is registered or the
 * start fails.
 */
export function expectDaemonPipelineHostSteps(
  executionId: string,
  target: DaemonPipelineHostStepsTarget,
): () => void {
  startingRuns.set(executionId, target);
  return (): void => {
    if (startingRuns.get(executionId) === target)
      startingRuns.delete(executionId);
  };
}

function hostStepsTargetOf(
  executionId: string,
): DaemonPipelineHostStepsTarget | undefined {
  const handle = getDaemonPipelineExecutionHandle(executionId);
  const hostSteps = handle?.hostSteps;
  if (handle && hostSteps)
    return { executionsDir: handle.executionsDir, hostSteps };
  return startingRuns.get(executionId);
}

export async function routeDaemonPipelineHostRequest(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<DaemonPipelineOwnerAnswer> {
  if (request.request.action.startsWith('owner.'))
    return ownerRequestHandler
      ? ownerRequestHandler(request, signal)
      : { result: OWNER_REQUEST_UNHANDLED };
  const target = hostStepsTargetOf(request.executionId);
  if (
    !target ||
    portableOwner(target.hostSteps.context.executionContext) !== request.owner
  )
    return { result: NOT_STARTED_HERE };
  const { hostSteps } = target;
  const { result, values } = await applyPortableHostRequest({
    request,
    host: hostSteps.actions,
    run: { executionsDir: target.executionsDir, ...hostSteps.context },
    signal,
    onError: (error) => logMainProcessError('Pipeline host step failed', error),
  });
  return { result, execution: { pipelineHostStep: values } };
}

/** Aborts this execution's in-flight host calls and drops its held answers (the mirror settled). */
export function abortDaemonPipelineHostCalls(executionId: string): void {
  for (const apply of inFlight.values())
    if (apply.executionId === executionId) apply.abort.abort();
  for (const [requestId, held] of unsent)
    if (held.request.executionId === executionId) unsent.delete(requestId);
}

/**
 * Stops settling host requests: aborts every in-flight host call, which then
 * sends no answer, and closes the owner subscription. The daemon pauses its
 * owner-bound runs once the owner has been gone a while (CAN-6033).
 */
export function stopDaemonPipelineOwnerSettlement(): void {
  disposed = true;
  for (const apply of inFlight.values()) apply.abort.abort();
  unsent.clear();
  const current = subscription;
  subscription = null;
  current?.stream?.close();
}

export async function disposeDaemonPipelineOwnerSettlement(): Promise<void> {
  stopDaemonPipelineOwnerSettlement();
  await disposeDaemonPipelineOwner();
}
