import { renderProviderSwitchSeed } from '@canopy/agent-transcript';
import { getListedModelContextWindow } from '@canopy/desktop-shared/types';
import { readChatTranscript } from './chat-tabs-reader';

/** A seed a turn owes, and its receipt once the provider accepts the turn. */
export interface ProviderSwitchSeed {
  /** Undefined when there is nothing to carry; the debt is still settled. */
  text: string | undefined;
  /** Clears the chat's pending flag; call only after the turn is accepted. */
  delivered: () => Promise<void>;
}

/**
 * The conversation so far, for the first turn on a provider the chat just
 * switched to (CAN-6445): the transcript, without the turn's own user
 * message when its prompt sends that message, rendered for the new model's
 * context window. A continuation (a stopped turn's Resume, a deferred-tools
 * reload) sends only a continuation prompt, so its seed keeps the message it
 * continues. Every send path that composes a prompt calls this, so worktree,
 * cowork, standalone and Portal sends carry the same seed.
 *
 * `pending` is the canonical tab's main-owned `providerSwitchSeedPending`,
 * read with the turn's dispatch metadata, never a caller's request field,
 * because several dispatch paths build their own request. It is honoured even
 * when the turn has a session id: a new provider can record its id before
 * the seeded prompt is accepted (CAN-6519), and a resumed parked session never
 * leaves the flag set. The flag stays set until the caller reports the turn
 * accepted, so a turn that fails before then still owes it. Undefined when no
 * seed is owed.
 */
export async function loadProviderSwitchSeed(options: {
  pending: boolean;
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  /** A hidden continuation of `userMessageId`'s turn. */
  continuation?: boolean;
  model: string | undefined;
}): Promise<ProviderSwitchSeed | undefined> {
  if (!options.pending) return;
  const messages = await readChatTranscript(
    options.projectId,
    options.worktreeId,
    options.chatId,
    true,
  );
  const seed = renderProviderSwitchSeed({
    messages: messages.filter(
      (message) =>
        options.continuation === true || message.id !== options.userMessageId,
    ),
    contextWindowTokens: options.model
      ? getListedModelContextWindow(options.model)
      : undefined,
  });
  return {
    text: seed.text || undefined,
    delivered: async (): Promise<void> => {
      // Lazy import breaks the chat state and turn dispatch import cycle.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      await getChatStateService().consumeProviderSwitchSeed(
        { projectId: options.projectId, worktreeId: options.worktreeId },
        options.chatId,
      );
    },
  };
}
