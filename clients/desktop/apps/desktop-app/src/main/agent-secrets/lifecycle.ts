import { logMainProcessWarn } from '../lib/main-process-logging';
import { getChatSecretStore, type ChatSecretScope } from './chat-secret-store';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;

/** Deletes a closed or archived chat's agent secrets. Never throws. */
export async function revokeClosedChatSecrets(
  scope: ChatSecretScope,
): Promise<void> {
  try {
    const store = getChatSecretStore();
    const removed = await store.remove(scope);
    if (removed.length)
      await store.audit({
        event: 'revoked',
        scope,
        names: removed,
        reason: 'chat_closed',
      });
  } catch {
    logMainProcessWarn(
      "[agent-secrets] Couldn't delete a closed chat's secrets",
    );
  }
}

/** Deletes every chat secret of a worktree or work entry being removed. Never throws. */
export async function revokeScopeChatSecrets(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<void> {
  try {
    const store = getChatSecretStore();
    for (const { scope: chat, names } of await store.removeScope(scope))
      await store.audit({
        event: 'revoked',
        scope: chat,
        names,
        reason: 'scope_removed',
      });
  } catch {
    logMainProcessWarn(
      "[agent-secrets] Couldn't delete a removed scope's secrets",
    );
  }
}

async function sweep(): Promise<void> {
  try {
    const store = getChatSecretStore();
    for (const { scope, names } of await store.sweepExpired())
      await store.audit({ event: 'expired', scope, names, reason: 'ttl' });
  } catch {
    logMainProcessWarn("[agent-secrets] Couldn't delete expired chat secrets");
  }
}

/**
 * Deletes chat secrets seven days after they were given: shortly after
 * startup, then hourly. Reads also skip expired values, so the sweep only
 * bounds how long ciphertext stays on disk.
 */
export function startChatSecretExpirySweep(): void {
  if (sweepTimer) return;
  const first = setTimeout(() => {
    void sweep();
    sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, FIRST_SWEEP_DELAY_MS);
  first.unref();
  sweepTimer = first;
}
