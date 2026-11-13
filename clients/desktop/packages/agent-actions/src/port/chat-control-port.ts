import type { AgentActionCall } from '../surface/family';

/** A chat the family already found in the calling chat's workspace. */
export interface AgentChatControlTarget {
  chatId: string;
  /** The target's worktree (a cloud task), as `chat.get` reports it. */
  worktreeId: string | null;
  /** The write's idempotency key, for the host's own replay. */
  idempotencyKey: string;
}

export interface AgentChatInterruptResult {
  chatId: string;
  /** False when no turn was running, so nothing was stopped. */
  interrupted: boolean;
}

export interface AgentChatCancelResult extends AgentChatInterruptResult {
  /** Queued messages taken off the chat before they ran. */
  cancelledQueued: number;
}

export interface AgentChatArchiveResult {
  chatId: string;
  /** False when the chat was already archived. */
  archived: boolean;
}

/**
 * The backend the chat control actions run on, as the calling chat's owner.
 * The family resolves the target in the caller's workspace and refuses the
 * calling chat before any member runs. Every member stops or archives work
 * and never starts any; an agent-originated stop is recorded as the agent's
 * where the backend can tell it apart from the user's Stop. Failures are
 * `AgentPortError`s with agent-facing messages.
 */
export interface AgentChatControlPort<H> {
  /**
   * Ends the target's running turn; input queued behind it still runs.
   * Target operation: `core.chat.turn.cancel`, with an agent origin.
   */
  interrupt(
    target: AgentChatControlTarget,
    call: AgentActionCall<H>,
  ): Promise<AgentChatInterruptResult>;
  /**
   * Takes the target's queued input off, then ends its running turn.
   * Target operations: `core.chat.queue.entry.cancel` for each queued
   * entry, then `core.chat.turn.cancel`, with an agent origin.
   */
  cancel(
    target: AgentChatControlTarget,
    call: AgentActionCall<H>,
  ): Promise<AgentChatCancelResult>;
  /**
   * Archives the target as the user's own archive would, so the user can
   * restore it. A host refuses a target whose archive would take the
   * calling chat with it. Target operation: `core.chat.archive`
   * (`chat.archive_tab`).
   */
  archive(
    target: AgentChatControlTarget,
    call: AgentActionCall<H>,
  ): Promise<AgentChatArchiveResult>;
}
