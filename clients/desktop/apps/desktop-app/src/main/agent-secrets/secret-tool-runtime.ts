import type {
  RunWithSecretsInput,
  RunWithSecretsResult,
  WriteSecretsFileInput,
  WriteSecretsFileResult,
} from '@canopy/agent-actions';
import { runWithSecrets } from './run-with-secrets';
import type {
  AgentSecretToolCallOptions,
  AgentSecretToolHost,
} from './secret-tool-host';
import { writeSecretsFile } from './write-secrets-file';

/**
 * The RunWithSecrets and WriteSecretsFile members of a chat's injected-tool
 * runtime, bound to that chat. Hosts add them beside `requestSecrets`, for
 * the same root local chats only.
 */
export function agentSecretUseTools(host: AgentSecretToolHost): {
  runWithSecrets: (
    input: RunWithSecretsInput,
    options: AgentSecretToolCallOptions,
  ) => Promise<RunWithSecretsResult>;
  writeSecretsFile: (
    input: WriteSecretsFileInput,
    options: AgentSecretToolCallOptions,
  ) => Promise<WriteSecretsFileResult>;
} {
  const bound: AgentSecretToolHost = {
    ...host,
    stopTurn:
      host.stopTurn ??
      ((): void => {
        // Loaded on use: the session manager imports the provider sessions,
        // which import this module.
        void import('../agents/session-manager')
          .then(({ cancelCurrentChatTurn }) =>
            cancelCurrentChatTurn(
              host.scope.projectId,
              host.scope.worktreeId,
              host.scope.chatId,
            ),
          )
          .catch(() => undefined);
      }),
  };
  return {
    runWithSecrets: (input, options) => runWithSecrets(bound, input, options),
    writeSecretsFile: (input, options) =>
      writeSecretsFile(bound, input, options),
  };
}
