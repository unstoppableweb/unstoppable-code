import { useCallback, useEffect, useState } from 'react';
import type {
  AgentSecretSummary,
  AgentSecretsChatScope,
  AgentSecretsListResponse,
} from '@canopy/desktop-shared/types';
import { toAppError } from '@canopy/protocol/app-errors';
import { localChatBackend } from '@/stores/chat/backend';

/*
 * A local chat's held agent secrets for the Secrets chip (U3): names and
 * metadata only, read over private IPC blocked from remote control, and read
 * again whenever main says the chat's secrets or ambient status changed.
 */

const EMPTY: AgentSecretsListResponse = { secrets: [], ambient: 'none' };

function sameScope(
  a: AgentSecretsChatScope,
  b: AgentSecretsChatScope,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.chatId === b.chatId
  );
}

// No name in the text: the chip's notice isn't blocked from session replay,
// and the row still shows which secret it was.
const REVOKE_FAILED = "Couldn't revoke the secret. Try again.";

/**
 * What the composer's Secrets chip shows and does: a local chat's
 * (`useChatAgentSecrets`) or a cloud chat's (`useWebCoreChatSecrets`).
 */
export interface ComposerAgentSecrets {
  readonly state: {
    readonly secrets: readonly Pick<
      AgentSecretSummary,
      'name' | 'scope' | 'lastUsedAt'
    >[];
    readonly ambient: AgentSecretsListResponse['ambient'];
  };
  /** Resolves what went wrong when the revoke failed, else undefined. */
  readonly revoke: (name: string) => Promise<string | undefined>;
  readonly restart: () => Promise<void>;
  /** Reads the list again, as the chip opens; local chats are pushed. */
  readonly refresh?: () => void;
}

export interface ChatAgentSecrets extends ComposerAgentSecrets {
  readonly state: AgentSecretsListResponse;
}

/** The chat's held secrets, refetched whenever main says they changed. */
export function useChatAgentSecrets(
  scope: AgentSecretsChatScope | undefined,
): ChatAgentSecrets {
  const [state, setState] = useState<AgentSecretsListResponse>(EMPTY);
  const projectId = scope?.projectId;
  const worktreeId = scope?.worktreeId;
  const chatId = scope?.chatId;

  useEffect(() => {
    setState(EMPTY);
    if (!projectId || !worktreeId || !chatId) return undefined;
    const target = { projectId, worktreeId, chatId };
    const chat = localChatBackend().chat;
    let cancelled = false;
    let generation = 0;
    const load = (): void => {
      const current = (generation += 1);
      void chat
        .listAgentSecrets(target)
        .then((next) => {
          if (!cancelled && current === generation) {
            // An answer equal to the held one keeps it, so the composer does
            // not render again when its chat opens.
            setState((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next,
            );
          }
        })
        .catch((error: unknown) => {
          // A list that can't be read for now keeps what shows; the next
          // change notice reads it again. Classified only: the reply holds
          // names, never a value.
          toAppError(error);
        });
    };
    load();
    const stop = chat.onAgentSecretsChanged((changed) => {
      if (sameScope(changed, target)) load();
    });
    return (): void => {
      cancelled = true;
      stop();
    };
  }, [projectId, worktreeId, chatId]);

  const revoke = useCallback(
    async (name: string): Promise<string | undefined> => {
      if (!projectId || !worktreeId || !chatId) return REVOKE_FAILED;
      return localChatBackend()
        .chat.revokeAgentSecret({ projectId, worktreeId, chatId, name })
        .then((response) =>
          response.ok ? undefined : (response.error ?? REVOKE_FAILED),
        )
        .catch((error: unknown): string => {
          // The chip says it couldn't revoke; the store retries a revocation
          // it couldn't write.
          toAppError(error);
          return REVOKE_FAILED;
        });
    },
    [projectId, worktreeId, chatId],
  );
  const restart = useCallback(async (): Promise<void> => {
    if (!projectId || !worktreeId || !chatId) return;
    await localChatBackend()
      .chat.restartForAgentSecrets({ projectId, worktreeId, chatId })
      .catch((error: unknown) => {
        // Restart to apply stays offered while the chip still says restart.
        toAppError(error);
      });
  }, [projectId, worktreeId, chatId]);

  return { state, revoke, restart };
}
