import { isValidSharedAgentModelId, parseAgentRouteModelId } from '../agents';
import {
  providerFallbackThinkingLevels,
  type ThinkingLevel,
} from '../thinking';
import type { AgentExecutionHarness, ModelCatalogOption } from './index';

export interface ModelSelectionMetadata {
  readonly selection: string | undefined;
  readonly agentRow: ModelCatalogOption | undefined;
  readonly concreteModelId: string | undefined;
  readonly modelRow: ModelCatalogOption | undefined;
  readonly metadataRow: ModelCatalogOption | undefined;
  readonly executionHarness: AgentExecutionHarness | undefined;
  readonly thinkingLevels: readonly ThinkingLevel[];
}

function executionHarness(
  value: string | undefined,
): AgentExecutionHarness | undefined {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'opencode':
    case 'copilot':
    case 'antigravity':
      return value;
    default:
      return undefined;
  }
}

/** Describes existing state, independently of current admission or availability. */
export function resolveModelSelectionMetadata(input: {
  readonly catalog: readonly ModelCatalogOption[] | undefined;
  readonly selection: string | undefined;
  readonly executionHarness?: string;
  readonly providerHint?: string;
  readonly defaultModelId?: string;
}): ModelSelectionMetadata {
  const { catalog, selection } = input;
  const route = selection ? parseAgentRouteModelId(selection) : undefined;
  const agentId =
    route?.agentId ??
    (selection && isValidSharedAgentModelId(selection) ? selection : undefined);
  const agentRow = catalog?.find(
    (row) => row.kind === 'agent' && row.id === agentId,
  );
  const requestedModelId =
    route?.baseModel ??
    (agentId
      ? agentRow?.agentSelection?.preferredModel
      : (selection ??
        input.defaultModelId ??
        catalog?.find((row) => row.kind === 'model' && row.isDefault)?.id));
  const modelRow =
    catalog?.find(
      (row) => row.kind === 'model' && row.id === requestedModelId,
    ) ??
    catalog?.find(
      (row) =>
        row.kind === 'model' &&
        requestedModelId !== undefined &&
        row.aliases?.includes(requestedModelId),
    );
  const concreteModelId = modelRow?.id ?? requestedModelId;
  const source = modelRow ?? (agentId && !route ? agentRow : undefined);
  const support = agentRow?.agentSelection?.supportedModels.find(
    (row) => row.modelId === concreteModelId,
  );
  const baseHarness = executionHarness(source?.harness ?? source?.provider);
  const harness =
    executionHarness(input.executionHarness) ??
    (support
      ? baseHarness && support.harnesses.includes(baseHarness)
        ? baseHarness
        : support.harnesses[0]
      : baseHarness);
  const choice = source?.harnessChoices?.find((row) => row.harness === harness);
  // Never borrow capabilities from another runtime, even for historical captures.
  const metadataRow =
    source && harness !== baseHarness
      ? {
          ...source,
          harness,
          provider:
            source.provider === 'ollama'
              ? source.provider
              : (choice?.provider ?? harness ?? 'unknown'),
          supportedThinkingLevels: choice?.supportedThinkingLevels,
          thinkingLevels: undefined,
          contextWindow: choice?.contextWindow,
          supportsFastMode: choice?.supportsFastMode,
          supportsImages: choice?.supportsImages,
          funding: choice?.funding,
        }
      : source && choice
        ? {
            ...source,
            ...choice,
            provider:
              source.provider === 'ollama' ? source.provider : choice.provider,
          }
        : source;
  return {
    selection,
    agentRow,
    concreteModelId,
    modelRow,
    metadataRow,
    executionHarness: harness,
    thinkingLevels:
      metadataRow?.supportedThinkingLevels ??
      (metadataRow?.thinkingLevels?.length
        ? metadataRow.thinkingLevels
        : undefined) ??
      providerFallbackThinkingLevels(
        harness ??
          metadataRow?.provider ??
          input.providerHint ??
          input.executionHarness,
      ),
  };
}
