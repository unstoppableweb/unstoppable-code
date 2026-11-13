import type {
  CanopyInstructionName,
  CanopyQueryHandler,
  CanopyQueryName,
  CanopyQueryParams,
  CanopyQueryResult,
  PlaneQualifiedName,
} from '@canopy/protocol/canopy-core';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type { AgentActionErrorCode } from '../response';
import type { AgentChatCreatePlacement } from '../surface/capabilities';
import type { AgentActionCall } from '../surface/family';

/** The registered `core.*` reads the environment port exposes unchanged. */
export const AGENT_PORT_QUERY_NAMES = [
  'core.workspace.get',
  'core.worktree.list',
  'core.worktree.get',
  'core.chat.list',
] as const satisfies readonly CanopyQueryName[];

export type AgentPortQueryName = (typeof AGENT_PORT_QUERY_NAMES)[number];

export type AgentChatState =
  CanopyQueryResult<'core.chat.list'>['items'][number]['state'];

export interface AgentWorkspaceScope {
  workspaceId: string;
}

export interface AgentWorktreeScope extends AgentWorkspaceScope {
  worktreeId: string;
}

export interface AgentChatDetail {
  chatId: string;
  workspaceId: string;
  worktreeId: string | null;
  title: string;
  state: AgentChatState;
  modelId: string | null;
  /** Text of the latest visible assistant response, when there is one. */
  lastResponse?: string;
  /**
   * False when the host cannot deliver a chat.send_message to this chat (for
   * example, its turns run in a terminal whose permissions the host cannot
   * check). Absent means messageable.
   */
  messageable?: boolean;
  /** The refusal a chat.send_message to an unmessageable chat returns. */
  unmessageableReason?: string;
}

export interface AgentGetChatInput {
  scope: AgentWorkspaceScope;
  chatId: string;
}

export interface AgentStartChatInput {
  scope: AgentWorktreeScope;
  placement: AgentChatCreatePlacement;
  model?: { id: string; thinkingLevel?: ThinkingLevel };
  title?: string;
  message: { text: string };
  lineage: { parentChatId: string; depth: number };
  idempotencyKey: string;
  /**
   * Called once the new chat's id is fixed and before its first message is
   * sent, so its watchers cannot miss a fast first turn. A host that cannot
   * call it leaves the watchers to be armed from the receipt.
   */
  beforeFirstMessage?: (target: AgentStartedChat) => Promise<void>;
}

export interface AgentStartedChat {
  chatId: string;
  worktreeId: string;
}

export interface AgentStartChatReceipt {
  chatId: string;
  worktreeId: string;
  /**
   * `queued_for_setup` when the message waits for a new worktree's setup; a
   * host whose new worktree needs no setup reports `submitted`.
   */
  delivery: 'submitted' | 'queued_for_setup';
}

export interface AgentPostMessageInput {
  scope: AgentWorktreeScope;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export interface AgentPostMessageReceipt {
  chatId: string;
  delivery: 'submitted' | 'queued';
}

export interface AgentModelList {
  models: readonly ModelCatalogOption[];
  defaultModelId: string | null;
}

/**
 * The backend an environment action runs on. Reads are the registered
 * `core.*` queries with their protocol DTOs; writes are compositions listed
 * in {@link AGENT_PORT_COMPOSITIONS}. Scope always comes from the trusted
 * call, never from the model.
 */
export interface AgentEnvironmentPort<H> {
  query<N extends AgentPortQueryName>(
    name: N,
    params: CanopyQueryParams<N>,
    call: AgentActionCall<H>,
  ): Promise<CanopyQueryResult<N>>;
  /** Null when no chat with this id is visible to the caller. */
  getChat(
    input: AgentGetChatInput,
    call: AgentActionCall<H>,
  ): Promise<AgentChatDetail | null>;
  startChat(
    input: AgentStartChatInput,
    call: AgentActionCall<H>,
  ): Promise<AgentStartChatReceipt>;
  postMessage(
    input: AgentPostMessageInput,
    call: AgentActionCall<H>,
  ): Promise<AgentPostMessageReceipt>;
  listModels(
    input: { scope: AgentWorktreeScope },
    call: AgentActionCall<H>,
  ): Promise<AgentModelList>;
  /** Spawn depth of the calling chat; user-started chats are depth 0. */
  callerDepth(call: AgentActionCall<H>): Promise<number>;
  /**
   * Which of these chats in one worktree cannot receive chat.send_message,
   * as `getChat` reports through `messageable`. A host without the method
   * can message every chat it lists.
   */
  unmessageableChatIds?(
    input: { scope: AgentWorktreeScope; chatIds: readonly string[] },
    call: AgentActionCall<H>,
  ): Promise<readonly string[]>;
}

/**
 * A port failure the caller can act on. Any other thrown error becomes
 * `execution_failed`.
 */
export class AgentPortError extends Error {
  readonly code: AgentActionErrorCode;
  readonly retryable: boolean;

  constructor(code: AgentActionErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AgentPortError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Whether a failed write's outcome is unknown: a retryable `timeout` or
 * `surface_unavailable` may come after the write happened. Anything else
 * means it did not happen. A write with an unknown outcome keeps what it
 * armed for its message, so the message's turn is still watched and a retry
 * of the write reuses it.
 */
export function isUnknownWriteOutcome(error: unknown): boolean {
  return (
    error instanceof AgentPortError &&
    error.retryable &&
    (error.code === 'timeout' || error.code === 'surface_unavailable')
  );
}

type AgentComposedOperation = CanopyQueryName | CanopyInstructionName;

export interface AgentPortComposition {
  /** Registered operations the composition is built from. */
  composes: readonly AgentComposedOperation[];
  /** Destination operations that are not registered yet. */
  planned: readonly PlaneQualifiedName[];
}

/**
 * The `core.*` / `worker.*` operations each port write composes. When an
 * operation becomes registered and equivalent, the composition is replaced
 * by that operation and its entry is deleted.
 */
export const AGENT_PORT_COMPOSITIONS = {
  getChat: {
    composes: ['core.chat.list', 'core.chat.transcript.page'],
    planned: [],
  },
  startChat: {
    composes: ['core.chat.create', 'core.chat.message.send'],
    // Not core.worktree.create: the web core serves it outside the shared
    // catalog, and it makes the worktree's own first chat without answering
    // its id, so it is not this composition's step (CAN-4158).
    planned: [],
  },
  postMessage: {
    composes: ['core.chat.message.send'],
    planned: [],
  },
  listModels: {
    composes: [],
    // worker.agent.provider.list (CAN-4121) is registered but not yet
    // equivalent: this projects the owner-scoped cloud model catalog, and no
    // interface principal holds worker.agent.read until CAN-4095.
    planned: [],
  },
  forkChat: {
    composes: ['core.chat.fork', 'core.chat.message.send'],
    planned: [],
  },
} as const satisfies Record<string, AgentPortComposition>;

export type AgentPortQueryHandlers<Context> = {
  [N in AgentPortQueryName]: CanopyQueryHandler<N, Context>;
};

/**
 * Back the port's reads with protocol query handlers, such as the handler
 * map a host later passes unchanged to `createCanopyDispatcher`.
 */
export function portQueriesFromHandlerMap<H, Context>(
  handlers: AgentPortQueryHandlers<Context>,
  context: (call: AgentActionCall<H>) => Context,
): AgentEnvironmentPort<H>['query'] {
  return async (name, params, call) => handlers[name](params, context(call));
}
