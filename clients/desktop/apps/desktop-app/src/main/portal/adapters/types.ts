import type { CoworkFolderMissing } from '@canopy/protocol/canopy-core';
/**
 * Shared adapter primitives for the local Canopy Portal worker.
 *
 * Each Portal feature (chat, terminal, scripts, hooks, plans, pipelines,
 * diff, files, …) plugs in a single command adapter that the dispatcher
 * invokes when a matching `PortalCommandEnvelope` lands. Adapters MUST stay
 * decoupled from the worker internals; the only seam they may touch is the
 * {@link PortalAdapterContext} they receive from the dispatcher.
 *
 * The context exposes the renderer window accessor plus three thin helpers:
 * `enqueueEvent` for spontaneous events (e.g. streamed terminal output, state
 * deltas), and the canonical `complete` / `fail` helpers that produce the
 * correct `portal.command.*` envelopes so adapters never assemble the result
 * framing by hand. These helpers correspond exactly to the contracts pinned in
 * `repos/canopy/src/shared/types/portal.ts`:
 *
 * - `complete` produces `portal.command.completed` with
 *   `{ commandId, sequenceNumber, result?, generatedAt }`.
 * - `fail` produces `portal.command.failed` with
 *   `{ commandId, sequenceNumber, error: { code, message }, retryable?, generatedAt }`.
 *
 * Adapter signatures should use `PortalCommandPayloadMap[T]` to type their
 * payload rather than re-declaring the shape locally; that keeps every
 * adapter in lockstep with the closed `PortalCommandType` enum and the
 * mirrored server `types.ts`.
 */
import type { BrowserWindow } from 'electron';
import type {
  CoreChatSendReceiptParams,
  CoreChatSendReceiptResult,
} from '@canopy/protocol/canopy-core';
import type {
  ChatCommandRequest,
  ChatCommandExecutionOptions,
  ChatCommandResult,
  ChatStateCommandPort,
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type {
  ExternalAgentSender,
  PortalWorktreeCreateRefusal,
  PortalWorktreeCreateRefusalReason,
} from '@canopy/protocol/portal';

/**
 * Stable error codes emitted by adapters via {@link PortalAdapterContext.fail}.
 *
 * These match the failure codes pinned by the transport plan so the browser
 * can route on `error.code` rather than parsing free-form messages:
 *
 * - `invalid_payload` — known feature command with bad payload; `retryable: false`
 * - `invalid_target` — known feature command with bad target
 * - `not_found` — local resource missing
 * - `execution_failed` — runtime error; `retryable: false` unless transient
 *   transport issue (then `retryable: true`)
 * - `unsupported_command` — command type not implemented
 *
 * Adapters MAY emit codes outside this set (the field is `string` for
 * forward compatibility), but any new code added here MUST also be reflected
 * in the cross-repo parity test so the browser stays aware of it.
 */
export type PortalAdapterFailureCode =
  | 'invalid_payload'
  | 'invalid_target'
  | 'not_found'
  | 'conflict'
  | 'permission_denied'
  | 'not_found_or_firing'
  | 'forbidden'
  | 'execution_failed'
  | 'github_not_connected'
  | 'unsupported_command'
  | PortalWorktreeCreateRefusalReason;

/**
 * Runtime context handed to every adapter by the dispatcher. Adapters
 * interact with the transport exclusively through this surface so the
 * dispatcher can serialize events, attach session metadata, and translate
 * thrown errors into canonical failure envelopes in one place.
 *
 * Implementations MUST guarantee that:
 *
 * - `enqueueEvent` accepts any `PortalEventEnvelope` (the dispatcher fills
 *   in `eventId`/`occurredAt` if the adapter omitted them).
 * - `complete` and `fail` always emit canonical `portal.command.completed`
 *   / `portal.command.failed` envelopes for the *given* command. Calling
 *   either more than once for the same command is a programmer error.
 * - Neither helper throws — adapters can call them inside a `catch` block
 *   without worrying about cascading failures.
 */
export interface PortalAdapterContext {
  sessionId?: string | null;
  /** Validated server-attested sender metadata from the Portal envelope. */
  origin?: ExternalAgentSender;
  /** Trusted active paired-session authority; asset-read access is insufficient. */
  canArchiveStandaloneChats?: () => boolean;
  /**
   * Confirms the pairing with the server (a live heartbeat) right before an
   * archive's first destructive step. Missing or false fails closed.
   */
  confirmArchivePairing?: () => Promise<boolean>;
  canReadAssets?: () => boolean;
  canMutateResources?: () => boolean;
  canReadTranscripts?: () => boolean;
  /**
   * Main-owned revisioned chat command service. When present, chat mutations
   * are acknowledged from its committed result and never routed via renderer.
   */
  chatStatePort?: ChatStateCommandPort;
  queryChatSendReceipt?: (
    request: CoreChatSendReceiptParams,
  ) => Promise<CoreChatSendReceiptResult>;
  dispatchChatCommand?: (
    request: ChatCommandRequest,
    options?: ChatCommandExecutionOptions & {
      agentSent?: ExternalAgentSender;
    },
  ) => Promise<ChatCommandResult>;
  /**
   * Current local renderer window accessor. Chat-like services use this to
   * mirror Portal-originated turns into the same IPC stream as local turns.
   */
  getWindow: () => BrowserWindow | null;

  /**
   * Publish a spontaneous (non-result) event onto the worker's outbound
   * queue. Use this for streamed feature events such as terminal output,
   * chat frames, state deltas, file/diff snapshots, etc.
   */
  enqueueEvent(event: PortalEventEnvelope): void;

  /**
   * Emit the canonical `portal.command.completed` envelope for `command`.
   *
   * `result` is the IPC return value of the underlying handler; pass
   * `undefined` for handlers that produce no return value. The dispatcher
   * fills in `commandId`, `sequenceNumber`, and `generatedAt` automatically
   * to match the wire contract.
   */
  complete<TResult = unknown>(
    command: PortalCommandEnvelope,
    result?: TResult,
  ): void;

  /**
   * Emit the canonical `portal.command.failed` envelope for `command`.
   *
   * `code` SHOULD be one of the {@link PortalAdapterFailureCode} values so
   * the browser can route on a stable string. The signature accepts a bare
   * `string` for forward compatibility with future codes added to the plan;
   * any new code added in code review MUST also be reflected in
   * {@link PortalAdapterFailureCode}.
   *
   * `retryable` defaults to `false`; set it to `true` only for transient
   * transport-level failures the browser may safely resubmit.
   */
  fail(
    command: PortalCommandEnvelope,
    code: string,
    message: string,
    retryable?: boolean,
    details?: {
      refusal?: PortalWorktreeCreateRefusal;
      coworkFolderMissing?: CoworkFolderMissing;
    },
  ): void;
}

/**
 * Signature for a single feature adapter. Adapters MUST be declared with the
 * matching `PortalCommandPayloadMap[T]` payload alias (see
 * `@canopy/desktop-shared/types/portal`) so the closed `PortalCommandType` enum gates the
 * payload shape at compile time.
 *
 * Adapters MUST NOT bypass `complete`/`fail` — every command MUST be
 * acknowledged via one of the two helpers. The dispatcher is responsible
 * for catching uncaught exceptions and translating them into a canonical
 * `portal.command.failed` envelope with code `execution_failed`.
 */
export type PortalCommandAdapter<TPayload = unknown> = (
  command: PortalCommandEnvelope<TPayload>,
  context: PortalAdapterContext,
) => Promise<void> | void;
