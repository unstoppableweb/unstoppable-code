import type { JSX } from 'react';
import {
  getProviderForModel,
  resolveAgentModelDefinition,
  resolveKnownModel,
  type ChatModel,
  type ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import type {
  UiAgentProvider,
  UiTrackedPlanSource,
} from '@/lib/providerLabels';
import { ModelProviderIcon } from '@canopy/ui-shared';
import { PipelineIcon } from '@canopy/ui-shared/icons';
import {
  FileDownIcon as AppCatalogFileDownIcon,
  DocumentSearchIcon as AppCatalogDocumentSearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';

type ChatProviderFields = {
  providerType?: UiAgentProvider;
  model?: ChatModel;
  importedFrom?: ExternalProjectProvider;
};

export function resolveChatTabProvider(
  tab: ChatProviderFields,
  defaultWorktreeModel: ChatModel | undefined,
): UiAgentProvider | undefined {
  if (tab.providerType !== undefined) {
    return tab.providerType;
  }
  // An imported chat run on an agent Canopy cannot name (Grok, Kiro, …)
  // has no provider; the worktree's default model would badge it wrongly.
  if (tab.importedFrom !== undefined) {
    return undefined;
  }
  const model = tab.model ?? defaultWorktreeModel;
  if (model === undefined) {
    return undefined;
  }
  const knownModel = resolveKnownModel(model);
  if (knownModel === undefined) {
    return undefined;
  }
  const agent = resolveAgentModelDefinition(knownModel);
  if (agent && !agent.available) {
    return undefined;
  }
  return getProviderForModel(knownModel);
}

/** A tracked plan's source glyph, drawn at the compact 14px step. */
export const PLAN_SOURCE_GLYPHS: Readonly<
  Record<UiTrackedPlanSource, JSX.Element>
> = {
  antigravity: <ModelProviderIcon provider="antigravity" size="sm" />,
  opencode: <ModelProviderIcon provider="opencode" size="sm" />,
  copilot: <ModelProviderIcon provider="copilot" size="sm" />,
  cursor: <ModelProviderIcon provider="cursor" size="sm" />,
  claude: <ModelProviderIcon provider="claude" size="sm" />,
  codex: <ModelProviderIcon provider="codex" size="sm" />,
  ollama: <ModelProviderIcon provider="ollama" size="sm" />,
  pipeline: <PipelineIcon size="sm" />,
  imported: <AppCatalogFileDownIcon size="sm" />,
  detected: <AppCatalogDocumentSearchIcon size="sm" />,
};
