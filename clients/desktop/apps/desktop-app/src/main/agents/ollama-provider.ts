import type { AgentInterfacePort } from './agent-interface-port';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';
import {
  isSelectableOllamaModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import {
  ClaudeCodeProvider,
  type ClaudeCodeProviderOptions,
  type ClaudeCompatibleInvocation,
} from './claude-session';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE } from '../ollama/service';

export class OllamaProvider implements AgentProvider {
  private readonly delegate: ClaudeCodeProvider;

  constructor(options?: {
    prepareInvocation?: ClaudeCodeProviderOptions['prepareInvocation'];
  }) {
    this.delegate = new ClaudeCodeProvider({
      providerType: 'ollama',
      prepareInvocation:
        options?.prepareInvocation ??
        ((
          model: ChatModel | undefined,
          reason: 'session-start' | 'model-change',
        ): Promise<ClaudeCompatibleInvocation> =>
          resolveClaudeCompatibleInvocation(model, {
            ensureRunningReason: 'chat',
            assertInstalled:
              reason === 'session-start' || reason === 'model-change',
          })),
    });
  }

  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    interfacePort: AgentInterfacePort,
  ): AgentSession {
    if (!isOllamaSupportedOnPlatform()) {
      throw new Error(OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE);
    }

    if (!isSelectableOllamaModel(opts.model)) {
      throw new Error(
        'OllamaProvider requires a supported Ollama model with completion and tools capabilities',
      );
    }

    return this.delegate.createSession(
      {
        ...opts,
        providerType: 'ollama',
      },
      onEvent,
      interfacePort,
    );
  }
}
