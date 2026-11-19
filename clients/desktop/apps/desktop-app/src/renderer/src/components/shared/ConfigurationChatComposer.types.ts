import type {
  AgentModelConfig,
  ApprovalMode,
  ChatModel,
  ChatTabPluginSelections,
  RepoFileIndex,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import type { ConfigurationComposerContext } from '@/lib/configurationComposerTargets';
import type { CodexSpeedRouteContext } from '@canopy/execution-engine/types/codex-speed-capabilities';

export interface ConfigurationChatComposerValue {
  prompt: string;
  promptReferences?: ConfiguredPromptReference[];
  model?: ChatModel;
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  /** Local additional selections. Source hooks persist `plugins` instead. */
  pluginSelections?: ChatTabPluginSelections;
  /** Source-portable additional selections. */
  plugins?: ShareablePluginRef[];
}

export interface ConfigurationComposerVariable {
  name: string;
  token: string;
  description?: string;
  disabledReason?: string;
}

export interface ConfigurationChatComposerProps {
  /** Stable per action. Changing this or draftGeneration resets editor ownership. */
  editorId: string;
  draftGeneration?: number;
  value: ConfigurationChatComposerValue;
  onChange: (next: ConfigurationChatComposerValue) => void;
  context: ConfigurationComposerContext;
  selectionMode: 'local' | 'source';
  /** Exact test id on the Slate editable; controls use this as their prefix. */
  dataTestId: string;
  effectiveModel?: ChatModel;
  effectiveModelConfig?: AgentModelConfig;
  effectivePlanMode?: boolean;
  effectiveApprovalMode?: ApprovalMode;
  inheritedSelections?: ChatTabPluginSelections;
  executionHarness?: 'claude' | 'codex';
  /** Existing-chat actions qualify against that chat's canonical routing state. */
  speedRouteContext?: CodexSpeedRouteContext;
  /** An inherited Auto choice remains blocked until an explicit model is chosen. */
  speedRouteModelSelection?: 'explicit' | 'auto';
  variables?: readonly ConfigurationComposerVariable[];
  disabled?: boolean;
  readOnly?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onValidityChange?: (state: { valid: boolean; reason?: string }) => void;
  /** Optional form-owned full capability picker. */
  onOpenPlugins?: () => void;
  /** Optional Advisor read adapter; no Home workspace or chat state is touched. */
  loadAdvisorEnvironment?: (request: {
    providerType?: 'claude' | 'codex';
    pluginSelections?: ChatTabPluginSelections;
  }) => Promise<{
    discovery: WorktreeDiscovery | null;
    repos: RepoFileIndex[];
  }>;
}
