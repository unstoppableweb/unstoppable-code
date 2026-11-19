import type {
  AgentSecretsActionResponse,
  AgentSecretsChatScope,
  AgentSecretsListResponse,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  ambientSecretEnvStatus,
  restartForAmbientSecrets,
  settleAmbientSecretEnv,
  subscribeAmbientSecretEnvStatus,
} from './ambient-env';
import { getChatSecretStore, type ChatSecretScope } from './chat-secret-store';
import { isAgentSecretRequestsEnabled } from './feature-gate';

/*
 * The Secrets chip (PLAN.md §6.8, mockups §2): the chat's held secrets by
 * name, scope and last use, with Revoke, and Codex's Restart to apply. Only
 * metadata crosses to the renderer; values never leave the store but through
 * execution grants.
 */

function scopeOf(request: AgentSecretsChatScope): ChatSecretScope {
  return {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
}

/** The chat's held secrets and what its own commands get. */
export async function listChatSecrets(
  request: AgentSecretsChatScope,
): Promise<AgentSecretsListResponse> {
  if (!isAgentSecretRequestsEnabled()) return { secrets: [], ambient: 'none' };
  const scope = scopeOf(request);
  try {
    const [secrets, ambient] = await Promise.all([
      getChatSecretStore().describe(scope),
      ambientSecretEnvStatus(scope),
    ]);
    return {
      secrets: secrets.map((secret) => ({
        name: secret.name,
        scope: 'chat',
        createdAt: secret.createdAt,
        expiresAt: secret.expiresAt,
        ...(secret.lastUsedAt !== undefined
          ? { lastUsedAt: secret.lastUsedAt }
          : {}),
        storage: secret.storage,
      })),
      ambient,
    };
  } catch {
    logMainProcessWarn("[agent-secrets] Couldn't list a chat's secrets");
    return { secrets: [], ambient: 'none' };
  }
}

/**
 * Revoke: the chat can no longer use the value. Its commands lose it from
 * their next run (the ambient env follows the store), and an audit `revoked`
 * event is recorded. Kept encrypted for redaction only where CONTRACTS.md
 * §4a's retired values are kept.
 */
export async function revokeChatSecret(
  request: AgentSecretsChatScope & { name: string },
): Promise<AgentSecretsActionResponse> {
  const scope = scopeOf(request);
  const store = getChatSecretStore();
  let removed: string[];
  try {
    removed = await store.remove(scope, [request.name]);
  } catch {
    // The store retries a revocation it couldn't apply on its next read.
    return { ok: false, error: "Couldn't revoke the secret. Try again." };
  }
  if (removed.length)
    await store.audit({
      event: 'revoked',
      scope,
      names: removed,
      reason: 'person',
    });
  // The chat's commands lose it before Revoke reports success; if its
  // values file can't be removed, say so rather than claim it.
  if (!(await settleAmbientSecretEnv(scope, request.name)))
    return {
      ok: false,
      // No name: the chip's notice isn't blocked from session replay.
      error:
        "Revoked, but this chat's commands may still read it until the chat stops. Stop the chat to be sure.",
    };
  return { ok: true };
}

/** Codex's Restart to apply. */
export function restartChatForSecrets(
  request: AgentSecretsChatScope,
): AgentSecretsActionResponse {
  return restartForAmbientSecrets(scopeOf(request))
    ? { ok: true }
    : { ok: false, error: 'Nothing to restart in this chat.' };
}

let stopNotifications: (() => void) | null = null;

/**
 * Tells windows a chat's secrets or ambient status changed, by scope only, so
 * the chip refetches. Idempotent.
 */
export function startChatSecretNotifications(
  send: (scope: AgentSecretsChatScope) => void,
): void {
  if (stopNotifications) return;
  const forward = (scope: ChatSecretScope): void => {
    try {
      send({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      });
    } catch {
      logMainProcessWarn("[agent-secrets] Couldn't notify a chat's secrets");
    }
  };
  stopNotifications = getChatSecretStore().subscribe((scope) => forward(scope));
  const stopStore = stopNotifications;
  const stopAmbient = subscribeAmbientSecretEnvStatus(forward);
  stopNotifications = (): void => {
    stopStore();
    stopAmbient();
  };
}
