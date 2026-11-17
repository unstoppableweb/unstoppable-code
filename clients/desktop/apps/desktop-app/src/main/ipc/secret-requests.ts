import { z } from 'zod';
import {
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_LENGTH,
} from '@canopy/protocol/agent-secrets';
import {
  IPC_CHANNELS,
  type SecretRequestSettleResponse,
} from '@canopy/desktop-shared/types';
import {
  declineSecretRequest,
  submitSecretRequest,
} from '../agent-secrets/request-secrets';
import { startChatSecretExpirySweep } from '../agent-secrets/lifecycle';
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
}
