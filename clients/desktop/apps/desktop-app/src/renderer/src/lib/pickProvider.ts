import {
  getProviderForModel,
  pinInheritingAgentModel,
  type AgentProviderType,
  type ChatModel,
} from '@canopy/desktop-shared/types';

/**
 * The provider a picked model runs on. An Agent on the default model runs on
 * the chat's default, so it is judged by that model's provider.
 */
export function pickProvider(
  model: ChatModel,
  defaultModel: ChatModel | undefined,
): AgentProviderType | undefined {
  return getProviderForModel(pinInheritingAgentModel(model, defaultModel));
}
