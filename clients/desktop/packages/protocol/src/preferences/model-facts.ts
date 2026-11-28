import type { AgentProviderType } from '../agent-providers';
import type { ChatModel } from '../chat-models';
import type { ShortcutPlatform } from '../shortcuts';
import type { ThinkingLevel } from '../thinking';

/**
 * Whether the core doing the normalizing can run a model now. `unknown`: its
 * facts cannot tell, so a changed model choice is kept as sent.
 */
export type PreferencesModelStatus = 'available' | 'unavailable' | 'unknown';

/** Mirrors execution-engine `ModelHarness`. */
export type PreferencesModelHarness = Exclude<AgentProviderType, 'ollama'>;

/** Mirrors execution-engine `ModelHarnessSource`. */
export type PreferencesModelSource =
  | 'claude-managed'
  | 'codex-managed'
  | 'cursor-managed'
  | 'copilot-managed'
  | 'antigravity-managed'
  | 'opencode-managed'
  | 'ai-gateway'
  | 'ollama';

/**
 * The model and host facts preference normalization reads at call time, from
 * the core doing the normalizing. Not on the wire.
 */
export interface PreferencesModelFacts {
  status(model: string): PreferencesModelStatus;
  /** Canonical id of an alias; any other input unchanged. */
  resolveModelAlias(model: string): ChatModel;
  /** Canonical id when the model is registered, after alias resolution. */
  resolveKnownModel(model: string): ChatModel | undefined;
  executionHarness(model: ChatModel): PreferencesModelHarness | undefined;
  modelSource(model: ChatModel): PreferencesModelSource | undefined;
  provider(model: ChatModel): AgentProviderType | undefined;
  isOllamaModel(model: string): boolean;
  /** The level clamped to what the model supports. */
  clampThinkingLevel(level: ThinkingLevel, model: ChatModel): ThinkingLevel;
  /** Whether AI Credits can route the model. */
  isGatewayRoutable(model: ChatModel): boolean;
  /** Whether a model preference row offers the model (Claude, Codex, optionally Ollama). */
  isNativePreferenceOption(model: ChatModel, includeOllama: boolean): boolean;
  /** Whether this build runs Ollama models. */
  ollamaEnabled(): boolean;
  /** Platform the saved global focus shortcut is validated for. */
  shortcutPlatform(): ShortcutPlatform;
}
