/**
 * Desktop main's `github-publish-review` host step: a packaged code review
 * posted as the GitHub App through `core.pullRequest.review.publish` on the
 * web core. Runs for in-process runs and for daemon runs Electron main owns.
 *
 * Every other host action applies `assertTargetOwner`; this one does no owner
 * check of its own, deliberately: the web core authorizes the caller, the
 * run's owner, the installation and the repository itself, and acts only as
 * the signed-in account.
 *
 * The answer is always a successful host step whose `status` output the
 * preset branches on. `unavailable` is answered only when the server provably
 * did not run the operation, so the preset's `gh` step may post instead; once
 * a request may have reached the server, nothing falls back.
 *
 * Review text is user data: never logged.
 */
import { createHash } from 'node:crypto';
import { app } from 'electron';
import {
  CORE_PULL_REQUEST_REVIEW_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  REVIEW_APPROVAL_REASONS,
  REVIEW_PUBLISH_CLIENT_NAME,
  composeCanopyInstructionRegistries,
  type CanopyErrorPayload,
  type ReviewPublishParams,
  type ReviewPublishResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import {
  publishReviewOutputs,
  type PublishReviewRequestInputs,
} from '@canopy/execution-engine/pipelines/host-publish-review';
import { portableOwner } from '@canopy/execution-engine/node/pipelines/host-request-portable';
import type {
  PipelineHostActionCaller,
  PipelineHostActionResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { WebCoreBindingOptions } from '../canopy-cloud/web-core-connection';
import { logMainProcessWarn } from '../lib/main-process-logging';

const DEFINITIONS = {
  queries: CORE_TRANSPORT_QUERY_DEFINITIONS,
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_PULL_REQUEST_REVIEW_PUBLISH_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
} as const;

/** The operation's params with the publication's idempotency key. */
type PublishParams = ReviewPublishParams & {
  readonly _meta: { readonly idempotencyKey: string };
};

type PublishClient = CanopyClient<
  typeof DEFINITIONS.queries,
  typeof DEFINITIONS.instructions
>;

/**
 * One attempt's deadline: above the publisher's worst case (four review
 * POSTs at 20 s, 45 s of replies and dismissals, and up to 15 s waiting on a
 * key another request holds), with room for the connection.
 */
export const PUBLISH_REVIEW_CALL_TIMEOUT_MS = 180_000;

/** The web core's bound on `_meta.idempotencyKey`. */
const WIRE_IDEMPOTENCY_KEY_MAX_LENGTH = 512;

/**
 * A host request key can be 3,072 characters; the web core accepts 512. A
 * longer key crosses as its SHA-256, which is as stable across the retry and
 * a replayed run as the key itself.
 */
function wireIdempotencyKey(key: string): string {
  return key.length <= WIRE_IDEMPOTENCY_KEY_MAX_LENGTH
    ? key
    : `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

export interface PublishReviewHostDeps {
  /**
   * Main's web core binding, with the cloud chats gate lifted: the server's
   * `canopy-github-app-reviews` flag is the gate. Injected in tests.
   */
  readonly binding?: () => Promise<WebCoreBindingOptions>;
  readonly clientVersion?: () => Promise<string>;
  /** Injected in tests; production opens a web core connection per call. */
  readonly openClient?: (
    binding: WebCoreBindingOptions,
    clientVersion: string,
    signal: AbortSignal,
  ) => Promise<PublishClient>;
}

async function defaultBinding(): Promise<WebCoreBindingOptions> {
  // Deferred so main's startup graph never loads cloud chats through the
  // pipeline host.
  const { desktopWebCoreBindingOptions } = await import('../ipc/cloud-chats');
  return { ...desktopWebCoreBindingOptions(), isEnabled: () => true };
}

function defaultClientVersion(): Promise<string> {
  return Promise.resolve(app.getVersion());
}

async function defaultOpenClient(
  binding: WebCoreBindingOptions,
  clientVersion: string,
  signal: AbortSignal,
): Promise<PublishClient> {
  const { connectWebCore } =
    await import('../canopy-cloud/web-core-connection');
  return createCanopyClient({
    connection: await connectWebCore(binding, signal),
    clientName: REVIEW_PUBLISH_CLIENT_NAME,
    clientVersion,
    definitions: DEFINITIONS,
    signal,
  });
}

function payloadOf(error: unknown): CanopyErrorPayload | null {
  return error instanceof CanopyClientError ||
    error instanceof CanopyTransportError
    ? error.payload
    : null;
}

/**
 * Every `flag_off` answer has a different cause: say which, since the result
 * can't. A local `capability_unavailable` means the handshake's manifest left
 * the operation out. Never the review text.
 */
function logUnavailable(
  stage: 'setup' | 'connect' | 'call',
  error: unknown,
): void {
  const payload = payloadOf(error);
  logMainProcessWarn('[review-publish] Unavailable before publishing', {
    stage,
    kind: payload?.kind ?? null,
    message:
      payload?.message ??
      (error instanceof Error ? error.message : String(error)),
  });
}

type Attempt =
  | { readonly kind: 'answered'; readonly result: ReviewPublishResult }
  /** The request may have reached the server; its answer was lost. */
  | { readonly kind: 'lost' }
  /**
   * The server refused the parameters before running the operation. The
   * handler itself never answers `invalid_argument`: it always settles to a
   * result, so nothing was posted.
   */
  | { readonly kind: 'params_refused' };

/** Kinds that say the server never ran the operation. */
const NOT_RUN_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'capability_unavailable',
  'permission_denied',
]);
/** Kinds after which the request may have run, with its answer lost. */
const LOST_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'deadline_exceeded',
  'unavailable',
  'cancelled',
]);

async function attempt(
  deps: Required<PublishReviewHostDeps>,
  binding: WebCoreBindingOptions,
  clientVersion: string,
  params: PublishParams,
  signal: AbortSignal,
): Promise<Attempt> {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(PUBLISH_REVIEW_CALL_TIMEOUT_MS),
  ]);
  let client: PublishClient;
  try {
    client = await deps.openClient(binding, clientVersion, deadline);
  } catch (error) {
    // Nothing was sent: a connection that could not be opened.
    logUnavailable('connect', error);
    return {
      kind: 'answered',
      result: {
        status: 'unavailable',
        reason:
          payloadOf(error)?.kind === 'unauthenticated'
            ? 'not_signed_in'
            : 'flag_off',
      },
    };
  }
  try {
    const result = await client.instruction(
      'core.pullRequest.review.publish',
      params,
    );
    return { kind: 'answered', result };
  } catch (error) {
    const payload = payloadOf(error);
    if (payload === null || LOST_KINDS.has(payload.kind))
      return { kind: 'lost' };
    if (payload.kind === 'unauthenticated' || NOT_RUN_KINDS.has(payload.kind))
      logUnavailable('call', error);
    if (payload.kind === 'unauthenticated')
      return {
        kind: 'answered',
        result: { status: 'unavailable', reason: 'not_signed_in' },
      };
    if (payload.kind === 'invalid_argument') return { kind: 'params_refused' };
    // An older server, the flag off, or a refused grant.
    if (NOT_RUN_KINDS.has(payload.kind))
      return {
        kind: 'answered',
        result: { status: 'unavailable', reason: 'flag_off' },
      };
    return {
      kind: 'answered',
      result: { status: 'failed', reason: 'github_error' },
    };
  } finally {
    await client.close().catch((): undefined => undefined);
  }
}

function settled(result: ReviewPublishResult): PipelineHostActionResult {
  return { status: 'success', outputs: publishReviewOutputs(result) };
}

/** One publication, as `publishReviewOverWebCore` sends it. */
export interface WebCoreReviewPublication {
  readonly owner: ReviewPublishParams['owner'];
  readonly pr: ReviewPublishParams['pr'];
  readonly reviewedHead: string;
  readonly reviewedUncommitted: boolean;
  readonly payload: ReviewPublishParams['payload'];
  readonly approvalFacts: ReviewPublishParams['approvalFacts'];
  readonly executionRef: string;
  /** Any length: a key over the web core's bound crosses as its SHA-256. */
  readonly idempotencyKey: string;
}

const PARAMS_REFUSED: ReviewPublishResult = {
  status: 'failed',
  reason: 'github_error',
};

/**
 * One attempt, resent once without `knownApprovalReasons` when the server
 * refuses the parameters: a server older than that field refuses it before
 * the handler runs, so nothing was posted. Only a refusal of a request that
 * carried the field is resent; a second refusal is reported as before.
 */
async function attemptNegotiated(
  deps: Required<PublishReviewHostDeps>,
  binding: WebCoreBindingOptions,
  clientVersion: string,
  params: PublishParams,
  signal: AbortSignal,
): Promise<Exclude<Attempt, { kind: 'params_refused' }>> {
  const first = await attempt(deps, binding, clientVersion, params, signal);
  if (first.kind !== 'params_refused') return first;
  if (params.knownApprovalReasons === undefined) {
    return { kind: 'answered', result: PARAMS_REFUSED };
  }
  signal.throwIfAborted();
  // Omit only the negotiated field, so every other parameter is resent.
  const { knownApprovalReasons: _knownApprovalReasons, ...withoutReasons } =
    params;
  void _knownApprovalReasons;
  const second = await attempt(
    deps,
    binding,
    clientVersion,
    withoutReasons,
    signal,
  );
  return second.kind === 'params_refused'
    ? { kind: 'answered', result: PARAMS_REFUSED }
    : second;
}

/**
 * Send one publication to the web core as the signed-in account, retrying a
 * lost answer once with the same key. Shared by the pipeline host step and
 * the `pull_request.review.publish` agent action. `unavailable` only when
 * the server provably never ran the operation.
 */
export async function publishReviewOverWebCore(
  publication: WebCoreReviewPublication,
  deps: PublishReviewHostDeps,
  signal: AbortSignal,
): Promise<ReviewPublishResult> {
  const resolved: Required<PublishReviewHostDeps> = {
    binding: deps.binding ?? defaultBinding,
    clientVersion: deps.clientVersion ?? defaultClientVersion,
    openClient: deps.openClient ?? defaultOpenClient,
  };
  let binding: WebCoreBindingOptions;
  let clientVersion: string;
  try {
    [binding, clientVersion] = await Promise.all([
      resolved.binding(),
      resolved.clientVersion(),
    ]);
  } catch (error) {
    // Nothing was sent: no connection could be set up.
    logUnavailable('setup', error);
    return { status: 'unavailable', reason: 'flag_off' };
  }
  const params: PublishParams = {
    owner: publication.owner,
    pr: publication.pr,
    reviewedHead: publication.reviewedHead,
    reviewedUncommitted: publication.reviewedUncommitted,
    payload: publication.payload,
    approvalFacts: publication.approvalFacts,
    executionRef: publication.executionRef,
    // Every reason this build reads; the server answers a later one as its
    // fallback.
    knownApprovalReasons: [...REVIEW_APPROVAL_REASONS],
    // The publisher's key; the server waits on a key another request holds.
    _meta: { idempotencyKey: wireIdempotencyKey(publication.idempotencyKey) },
  };
  const first = await attemptNegotiated(
    resolved,
    binding,
    clientVersion,
    params,
    signal,
  );
  if (first.kind === 'answered') return first.result;
  signal.throwIfAborted();
  // Once more with the same key: a request that did run answers its result.
  const second = await attemptNegotiated(
    resolved,
    binding,
    clientVersion,
    params,
    signal,
  );
  if (second.kind === 'answered') {
    // A retry that can't reach the server says nothing about the first try.
    return second.result.status === 'unavailable'
      ? { status: 'failed', reason: 'outcome_unknown' }
      : second.result;
  }
  return { status: 'failed', reason: 'outcome_unknown' };
}

export async function runPublishReviewHostAction(
  inputs: PublishReviewRequestInputs,
  caller: PipelineHostActionCaller,
  deps: PublishReviewHostDeps,
  signal: AbortSignal,
): Promise<PipelineHostActionResult> {
  const owner = portableOwner(caller.executionContext);
  // An owner that isn't a workspace context names no installation.
  if (owner === null)
    return settled({ status: 'unavailable', reason: 'no_org_connection' });
  return settled(
    await publishReviewOverWebCore(
      {
        owner,
        pr: inputs.pr,
        reviewedHead: inputs.reviewedHead,
        reviewedUncommitted: inputs.reviewedUncommitted,
        payload: inputs.payload,
        approvalFacts: inputs.approvalFacts,
        executionRef: caller.executionId,
        idempotencyKey: caller.idempotencyKey,
      },
      deps,
      signal,
    ),
  );
}
