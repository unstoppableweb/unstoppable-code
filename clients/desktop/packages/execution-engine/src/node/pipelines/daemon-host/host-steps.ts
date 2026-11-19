import type { PipelineHostStepSettlement } from '@canopy/core-runtime/node/pipeline/host';
import {
  WorkerPipelineHostActionRequestSchema,
  type WorkerPipelineHostActionRequest,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import {
  EVERY_PIPELINE_HOST_ACTION,
  PIPELINE_NEEDS_DESKTOP_MESSAGE,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { PipelineChatSendRecord } from '@canopy/execution-engine/types/pipeline';
import { PUBLISH_REVIEW_PAYLOAD_MAX_BYTES } from '@canopy/execution-engine/pipelines/host-publish-review';
import { PIPELINE_SESSION_MAX_PLAINTEXT_BYTES } from '@canopy/protocol/pipeline-relay';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '../executor/types';
import {
  deriveHostPathOutputs,
  fromPortableHostResult,
  hostAttachmentCopies,
  hostPathsOf,
  hostRequestEnvelope,
  portableHostActionRequest,
  UNPORTABLE_HOST_RESULT,
  withHostAttachmentCopies,
} from '../host-request-portable';

/**
 * The most a request with attachment copies may take as JSON: one relay
 * message's plaintext, less room for the request envelope and the session
 * frame around it.
 */
export const HOST_REQUEST_MAX_BYTES =
  PIPELINE_SESSION_MAX_PLAINTEXT_BYTES - 64 * 1024;

// A fitted `github-publish-review` request must cross as one relay message,
// with room left for its envelope and the request's other fields.
if (PUBLISH_REVIEW_PAYLOAD_MAX_BYTES + 64 * 1024 > HOST_REQUEST_MAX_BYTES) {
  throw new Error(
    'The github-publish-review payload limit must stay below the daemon host request limit.',
  );
}

/** How long a host step waits past its deadline for its owner's finalized answer. */
export const DAEMON_HOST_STEP_FINALIZE_GRACE_MS = 5_000;

/**
 * How early the executor's deadline abort may land before `deadlineAt`: its
 * timer is scheduled from the event loop's cached time, which lags the clock
 * under load. A cancel inside this window waits for the owner's own deadline
 * answer, which comes at `deadlineAt`.
 */
const DEADLINE_CLOCK_SLACK_MS = 1_000;

export interface DaemonHostStepChannel {
  /** Posts `{ kind: 'hostRequest', request }`. */
  raise(request: WorkerPipelineHostRequest): void;
  /** Posts `{ kind: 'hostRequestWithdrawn', executionId, requestId }`. */
  withdraw(executionId: string, requestId: string): void;
}

/** A child workflow on another target, as its owner runs it (CAN-6868). */
export type DaemonDelegatedChildRequest = Extract<
  WorkerPipelineHostActionRequest,
  { action: 'run-pipeline' }
>;

/** The pipeline host's host-step port (CAN-5771): each call is raised to the supervisor. */
export interface DaemonHostStepPort extends PipelineHostActions {
  /**
   * Raises a child workflow on another target to the owner, which runs it as
   * a run of its own; settles with the child's end (CAN-6868 part 3).
   */
  delegateChild(
    request: DaemonDelegatedChildRequest,
    caller: PipelineHostActionCaller,
    signal: AbortSignal,
    controls?: PipelineHostActionControls,
  ): Promise<PipelineHostActionResult>;
  /** The supervisor's `hostSettled` for one request; ignored when nothing waits for it. */
  settle(requestId: string, settlement: PipelineHostStepSettlement): void;
  /** The host is exiting: every waiting call ends as withdrawn. */
  close(): void;
}

/**
 * A send record the protocol refuses, so the executor reports the receipt as
 * invalid, as in process (section 6, stop 9).
 */
const INVALID_CHAT_SEND: PipelineChatSendRecord =
  Object.freeze<PipelineChatSendRecord>({
    version: 1,
    address: { kind: 'project', projectId: '', taskId: '', chatId: '' },
    userMessageId: '',
    state: 'sent',
    chatCreated: false,
    acceptedAt: '',
  });

const NEEDS_DESKTOP: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'needs_desktop',
  error: PIPELINE_NEEDS_DESKTOP_MESSAGE,
  outputs: {},
};

const WITHDRAWN_MESSAGE = 'The workflow host step was withdrawn.';

interface WaitingCall {
  settle(settlement: PipelineHostStepSettlement): void;
  close(): void;
}

interface SettlementExtras {
  readonly pathOutputs: Readonly<Record<string, string>>;
  readonly errorMessage?: string;
  readonly invalidChatSend?: PipelineChatSendRecord;
}

function extrasOf(
  values: WorkerPipelineHostStepValues | null,
  derivedPathOutputs: Readonly<Record<string, string>> = {},
): SettlementExtras {
  return {
    pathOutputs: values?.pathOutputs ?? derivedPathOutputs,
    ...(values?.errorMessage !== undefined && {
      errorMessage: values.errorMessage,
    }),
    ...(values?.invalidChatSend && { invalidChatSend: INVALID_CHAT_SEND }),
  };
}

/** Where a host step writes the files its owner returns, and which action it is. */
interface HostStepFiles {
  readonly action: string;
  /** The step's host folder, or null when the host has no executions folder. */
  readonly dir: string | null;
}

/**
 * The settlement's extras. An owner that sent no host values can't name
 * host paths (the cloud, CAN-6780): this host derives them from the files
 * the result carries.
 */
async function extrasFor(
  settlement: Extract<PipelineHostStepSettlement, { kind: 'settled' }>,
  files: HostStepFiles,
): Promise<SettlementExtras> {
  if (settlement.values !== null) return extrasOf(settlement.values);
  return extrasOf(
    null,
    await deriveHostPathOutputs(
      files.action,
      settlement.result.files,
      files.dir,
    ),
  );
}

/** The finalizer's answer for a settlement that came at the deadline. */
async function finalizedResult(
  settlement: PipelineHostStepSettlement,
  files: HostStepFiles,
): Promise<PipelineHostActionResult | undefined> {
  if (
    settlement.kind !== 'settled' ||
    settlement.values?.timeout !== 'finalized'
  )
    return undefined;
  try {
    return fromPortableHostResult(
      settlement.result,
      await extrasFor(settlement, files),
    );
  } catch {
    return undefined;
  }
}

export interface DaemonHostStepPortOptions {
  /**
   * The owner can't read this host's paths (a cloud runner's web core), so
   * a `send-agent-message` step's attachments cross as copies (CAN-6857,
   * G6). Without it they are refused, as every other host path is.
   */
  readonly carryAttachments?: boolean;
}

export function createDaemonHostStepPort(
  channel: DaemonHostStepChannel,
  options: DaemonHostStepPortOptions = {},
): DaemonHostStepPort {
  const waiting = new Map<string, WaitingCall>();
  /**
   * The request as it crosses: host paths never do, and a step's
   * attachments only as copies, for an owner that can't read them.
   */
  const crossing = (
    request: PipelineHostActionRequest,
  ):
    | {
        readonly kind: 'ready';
        readonly portable: WorkerPipelineHostActionRequest;
      }
    | {
        readonly kind: 'copy';
        readonly portable: WorkerPipelineHostActionRequest;
        readonly attachments: readonly string[];
      }
    | {
        readonly kind: 'refused';
        readonly result: PipelineHostActionResult;
      } => {
    const portable = portableHostActionRequest(request);
    if (portable === null)
      return { kind: 'refused', result: UNPORTABLE_HOST_RESULT };
    const { attachments, ...others } = hostPathsOf(request) ?? {};
    if (
      Object.values(others).some(
        (paths) => paths !== undefined && paths.length > 0,
      )
    )
      return { kind: 'refused', result: UNPORTABLE_HOST_RESULT };
    if (attachments === undefined || attachments.length === 0)
      return { kind: 'ready', portable };
    if (options.carryAttachments !== true)
      return { kind: 'refused', result: UNPORTABLE_HOST_RESULT };
    return { kind: 'copy', portable, attachments };
  };
  /** The portable request with a copy of each attached file. */
  const withCopies = async (
    portable: WorkerPipelineHostActionRequest,
    attachments: readonly string[],
  ): Promise<
    | { readonly ok: true; readonly portable: WorkerPipelineHostActionRequest }
    | { readonly ok: false; readonly result: PipelineHostActionResult }
  > => {
    const copies = await hostAttachmentCopies(attachments);
    if (!copies.ok)
      return {
        ok: false,
        result: {
          status: 'failure',
          failureReason: 'validation_failed',
          error: copies.message,
          outputs: {},
        },
      };
    const carried = withHostAttachmentCopies(portable, copies.files);
    if (carried === null) return { ok: false, result: UNPORTABLE_HOST_RESULT };
    // The text and the files are bounded apart; together, as the request
    // crosses, they must still fit one relay message, or the relay would
    // close the owner's whole request stream instead of failing this step.
    if (
      Buffer.byteLength(JSON.stringify(carried), 'utf8') >
      HOST_REQUEST_MAX_BYTES
    )
      return {
        ok: false,
        result: {
          status: 'failure',
          failureReason: 'validation_failed',
          error:
            'This message and its attachments are too large together for a cloud run. Send less text or fewer files.',
          outputs: {},
        },
      };
    return { ok: true, portable: carried };
  };
  const raiseCall = (
    portable: WorkerPipelineHostActionRequest,
    action: string,
    caller: PipelineHostActionCaller,
    signal: AbortSignal,
    controls: PipelineHostActionControls | undefined,
  ): Promise<PipelineHostActionResult> => {
    const requestId = caller.idempotencyKey;
    const { executionId } = caller;
    // The executor never runs one key twice at once.
    if (waiting.has(requestId)) return Promise.resolve(UNPORTABLE_HOST_RESULT);
    let resolveFinalized: (
      result:
        | PipelineHostActionResult
        | undefined
        | Promise<PipelineHostActionResult | undefined>,
    ) => void = () => undefined;
    const finalized = new Promise<PipelineHostActionResult | undefined>(
      (resolve) => {
        resolveFinalized = resolve;
      },
    );
    controls?.registerTimeoutFinalizer(() => finalized);
    // The step's host folder, where files its owner returns are kept.
    const files: HostStepFiles = {
      action,
      dir: controls?.artifactsDir ?? null,
    };
    return new Promise<PipelineHostActionResult>((resolve, reject) => {
      let done = false;
      let atDeadline = false;
      let held: PipelineHostStepSettlement | null = null;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        done = true;
        if (waiting.get(requestId) === call) waiting.delete(requestId);
        signal.removeEventListener('abort', aborted);
        if (grace !== undefined) clearTimeout(grace);
      };
      const call: WaitingCall = {
        settle(settlement): void {
          if (done) return;
          if (atDeadline) {
            finish();
            resolveFinalized(finalizedResult(settlement, files));
            return;
          }
          if (settlement.kind === 'unavailable') {
            finish();
            resolveFinalized(undefined);
            resolve(NEEDS_DESKTOP);
            return;
          }
          // The owner's deadline fired a moment before the executor's.
          if (settlement.values && settlement.values.timeout !== 'none') {
            held = settlement;
            return;
          }
          finish();
          resolveFinalized(undefined);
          void extrasFor(settlement, files).then(
            (extras) => {
              try {
                resolve(fromPortableHostResult(settlement.result, extras));
              } catch (error) {
                reject(
                  error instanceof Error ? error : new Error(WITHDRAWN_MESSAGE),
                );
              }
            },
            (error: unknown) => {
              reject(
                error instanceof Error ? error : new Error(WITHDRAWN_MESSAGE),
              );
            },
          );
        },
        close(): void {
          if (done) return;
          finish();
          resolveFinalized(undefined);
          if (!atDeadline) reject(new Error(WITHDRAWN_MESSAGE));
        },
      };
      function aborted(): void {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error(WITHDRAWN_MESSAGE));
        if (
          controls &&
          Date.now() >= controls.deadlineAt - DEADLINE_CLOCK_SLACK_MS
        ) {
          if (held) {
            const settled = held;
            finish();
            resolveFinalized(finalizedResult(settled, files));
            return;
          }
          atDeadline = true;
          grace = setTimeout(() => {
            if (done) return;
            finish();
            resolveFinalized(undefined);
            channel.withdraw(executionId, requestId);
          }, DAEMON_HOST_STEP_FINALIZE_GRACE_MS);
          return;
        }
        const settledEarlier = held !== null;
        finish();
        resolveFinalized(undefined);
        if (!settledEarlier) channel.withdraw(executionId, requestId);
      }
      waiting.set(requestId, call);
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener('abort', aborted, { once: true });
      channel.raise(hostRequestEnvelope(portable, caller, controls));
    });
  };
  return {
    // Every host step is raised to the owner, which answers what it can.
    support: {
      hostName: 'the background workflow service',
      actions: EVERY_PIPELINE_HOST_ACTION,
    },
    run(request, caller, signal, controls): Promise<PipelineHostActionResult> {
      const crossed = crossing(request);
      switch (crossed.kind) {
        case 'refused':
          return Promise.resolve(crossed.result);
        case 'ready':
          // Raised at once, so the finalizer and the waiting call exist
          // before anything can settle or withdraw it.
          return raiseCall(
            crossed.portable,
            request.action,
            caller,
            signal,
            controls,
          );
        case 'copy':
          return withCopies(crossed.portable, crossed.attachments).then(
            (carried) => {
              if (!carried.ok) return carried.result;
              // A step withdrawn while its files were read raises nothing.
              if (signal.aborted)
                return Promise.reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error(WITHDRAWN_MESSAGE),
                );
              return raiseCall(
                carried.portable,
                request.action,
                caller,
                signal,
                controls,
              );
            },
          );
      }
    },
    delegateChild(request, caller, signal, controls) {
      // A request its owner would refuse to read fails the step now, as a
      // host step's does, rather than waiting out the step's deadline.
      const parsed = WorkerPipelineHostActionRequestSchema.safeParse(request);
      if (
        !parsed.success ||
        Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') >
          HOST_REQUEST_MAX_BYTES
      )
        return Promise.resolve({
          status: 'failure',
          failureReason: 'validation_failed',
          error:
            "This child workflow can't be handed to its target: its target, inputs or definition are not valid or too large.",
          outputs: {},
        });
      return raiseCall(parsed.data, request.action, caller, signal, controls);
    },
    settle(requestId, settlement): void {
      waiting.get(requestId)?.settle(settlement);
    },
    close(): void {
      for (const call of [...waiting.values()]) call.close();
      waiting.clear();
    },
  };
}
