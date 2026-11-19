import type {
  AgentSecretStorePastedRequest,
  AgentSecretsActionResponse,
} from '@canopy/desktop-shared/types';
import { settleAmbientSecretEnv } from './ambient-env';
import { getChatSecretStore, type ChatSecretScope } from './chat-secret-store';
import { isAgentSecretRequestsEnabled } from './feature-gate';

/*
 * The composer paste guard's "Send as secret" (agent secret requests U6b,
 * PLAN.md §6.9): a value the person pasted into a local chat's composer is
 * kept as that chat's secret, so the message can name it instead of holding
 * it. Only the local window reaches the channel (it is blocked from remote
 * control), and nothing echoes the value back.
 */

export async function storePastedSecret(
  request: AgentSecretStorePastedRequest,
): Promise<AgentSecretsActionResponse> {
  if (!isAgentSecretRequestsEnabled())
    return { ok: false, error: 'Agent secrets are turned off.' };
  const scope: ChatSecretScope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  };
  const store = getChatSecretStore();
  try {
    await store.put(scope, { [request.name]: request.value });
  } catch {
    return { ok: false, error: "Couldn't keep the secret. Try again." };
  }
  // In Full access the chat's own commands get it before the message goes.
  await settleAmbientSecretEnv(scope);
  void store.audit({
    event: 'provided',
    scope,
    names: [request.name],
    sources: { [request.name]: 'entered' },
    reason: 'pasted',
  });
  return { ok: true };
}
