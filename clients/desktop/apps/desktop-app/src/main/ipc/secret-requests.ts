import { z } from 'zod';
import {
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_LENGTH,
} from '@canopy/protocol/agent-secrets';
import {
  IPC_CHANNELS,
  type AgentSecretsActionResponse,
  type AgentSecretsChatScope,
  type AgentSecretsListResponse,
  type SecretRequestSettleResponse,
} from '@canopy/desktop-shared/types';
import {
  declineSecretRequest,
  submitSecretRequest,
} from '../agent-secrets/request-secrets';
import { startChatSecretExpirySweep } from '../agent-secrets/lifecycle';
import { sweepStaleAmbientSecretEnv } from '../agent-secrets/ambient-env';
import {
  listChatSecrets,
  restartChatForSecrets,
  revokeChatSecret,
  startChatSecretNotifications,
} from '../agent-secrets/secrets-chip';
import { storePastedSecret } from '../agent-secrets/pasted-secrets';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import { registerIpcHandler } from './register';

const secretName = z.string().regex(AGENT_SECRET_NAME_PATTERN);

const submitSchema = z.strictObject({
  requestId: z.uuid(),
  values: z
    .record(secretName, z.string().min(1).max(AGENT_SECRET_VALUE_MAX_LENGTH))
    .refine((values) => Object.keys(values).length <= 10),
  useHeld: z.array(secretName).max(10),
});

const declineSchema = z.strictObject({ requestId: z.uuid() });

const chatScopeSchema = z.strictObject({
  projectId: z.string(),
  worktreeId: z.string(),
  chatId: z.string(),
});
const revokeSchema = chatScopeSchema.extend({ name: secretName });
const storePastedSchema = chatScopeSchema.extend({
  name: secretName,
  value: z
    .string()
    .max(AGENT_SECRET_VALUE_MAX_LENGTH)
    .refine((value) => value.trim().length > 0),
});

/** Parses a chat scope with the shared id validators; null when invalid. */
function chatScope<T extends AgentSecretsChatScope>(
  value: unknown,
  schema: z.ZodType<T>,
): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  try {
    validateId(parsed.data.projectId, 'projectId');
    validateId(parsed.data.worktreeId, 'worktreeId');
    validateId(parsed.data.chatId, 'chatId');
  } catch {
    return null;
  }
  return parsed.data;
}

/**
 * The secret request form's channels (CONTRACTS.md §8). Private and blocked
 * from remote control, so only this computer's window reaches them; only the
 * form sends them, so a person answered. A malformed request is refused
 * without echoing anything it carried.
 */
export function registerSecretRequestHandlers(): void {
  startChatSecretExpirySweep();
  registerIpcHandler(
    IPC_CHANNELS.secretRequestSubmit,
    (_event, value: unknown): Promise<SecretRequestSettleResponse> => {
      const request = submitSchema.safeParse(value);
      if (!request.success)
        return Promise.resolve({
          accepted: false,
          error: 'Check the secrets and try again.',
        });
      return submitSecretRequest(request.data);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.secretRequestDecline,
    (_event, value: unknown): Promise<SecretRequestSettleResponse> => {
      const request = declineSchema.safeParse(value);
      if (!request.success)
        return Promise.resolve({ accepted: false, error: 'Unknown request.' });
      return declineSecretRequest(request.data.requestId);
    },
  );
  // The Secrets chip (U3): metadata, Revoke and Codex's Restart to apply.
  void sweepStaleAmbientSecretEnv();
  startChatSecretNotifications((scope) =>
    sendToAllWindows(IPC_CHANNELS.agentSecretsChanged, scope),
  );
  registerIpcHandler(
    IPC_CHANNELS.agentSecretsList,
    (_event, value: unknown): Promise<AgentSecretsListResponse> => {
      const scope = chatScope(value, chatScopeSchema);
      if (!scope) return Promise.resolve({ secrets: [], ambient: 'none' });
      return listChatSecrets(scope);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentSecretsRevoke,
    (_event, value: unknown): Promise<AgentSecretsActionResponse> => {
      const request = chatScope(value, revokeSchema);
      if (!request)
        return Promise.resolve({ ok: false, error: 'Unknown secret.' });
      return revokeChatSecret(request);
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.agentSecretsRestart,
    (_event, value: unknown): Promise<AgentSecretsActionResponse> => {
      const scope = chatScope(value, chatScopeSchema);
      if (!scope) return Promise.resolve({ ok: false, error: 'Unknown chat.' });
      return Promise.resolve(restartChatForSecrets(scope));
    },
  );
  // The composer paste guard's "Send as secret" (U6b).
  registerIpcHandler(
    IPC_CHANNELS.agentSecretsStorePasted,
    (_event, value: unknown): Promise<AgentSecretsActionResponse> => {
      const request = chatScope(value, storePastedSchema);
      if (!request)
        return Promise.resolve({
          ok: false,
          error: "Couldn't keep the secret. Check its name and length.",
        });
      return storePastedSecret(request);
    },
  );
}
