import { create } from 'zustand';
import type {
  ModelCatalog,
  ModelCatalogOption,
  ModelCatalogProvider,
} from '@canopy/protocol/models';
import type { ModelRegistrySnapshot } from '@canopy/desktop-shared/types';
import { pairedComputerAddress } from '@/stores/remoteControlStore';

export interface PairedComputerModelCatalogState {
  readonly byDevice: Readonly<
    Record<string, ReadonlyMap<string, ModelCatalogOption>>
  >;
  readonly aliasesByDevice: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly failed: Readonly<Record<string, true>>;
}

export const usePairedComputerModelCatalogStore =
  create<PairedComputerModelCatalogState>(() => ({
    byDevice: {},
    aliasesByDevice: {},
    failed: {},
  }));

interface SnapshotModelRow {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly available?: boolean;
  readonly deprecated?: boolean;
  readonly supportsImages?: boolean;
  readonly contextWindow?: number;
  readonly vendor?: string;
}

function projectRow(
  row: SnapshotModelRow,
  provider: ModelCatalogProvider,
  extra?: Partial<ModelCatalogOption>,
): ModelCatalogOption {
  const label =
    typeof row.label === 'string' && row.label.trim().length > 0
      ? row.label
      : row.id;
  return {
    id: row.id,
    label,
    kind: 'model',
    provider,
    available: row.available !== false,
    ...(typeof row.description === 'string' && row.description.length > 0
      ? { description: row.description }
      : {}),
    ...(row.deprecated === true ? { deprecated: true } : {}),
    ...(typeof row.supportsImages === 'boolean'
      ? { supportsImages: row.supportsImages }
      : {}),
    ...(typeof row.contextWindow === 'number'
      ? { contextWindow: row.contextWindow }
      : {}),
    ...(typeof row.vendor === 'string' && row.vendor.length > 0
      ? { vendor: row.vendor }
      : {}),
    ...extra,
  };
}

/**
 * Projects a paired computer's `model-registry:get` snapshot onto `ModelCatalog`
 * using only the snapshot's own entries, never this computer's global registry.
 */
export function projectPairedModelRegistrySnapshot(
  snapshot: ModelRegistrySnapshot,
): Map<string, ModelCatalogOption> {
  const options = new Map<string, ModelCatalogOption>();
  const add = (option: ModelCatalogOption): void => {
    if (!options.has(option.id)) options.set(option.id, option);
  };

  for (const row of snapshot.claude ?? []) {
    add(projectRow(row, 'claude', { harness: 'claude', source: 'claude' }));
  }
  for (const row of snapshot.codex ?? []) {
    add(projectRow(row, 'codex', { harness: 'codex', source: 'codex' }));
  }
  for (const row of snapshot.ollama ?? []) {
    add(projectRow(row, 'ollama', { harness: 'claude', source: 'ollama' }));
  }
  for (const row of snapshot.cursor ?? []) {
    add(projectRow(row, 'cursor', { harness: 'cursor', source: 'cursor' }));
  }
  for (const row of snapshot.antigravity ?? []) {
    add(
      projectRow(row, 'antigravity', {
        harness: 'antigravity',
        source: 'antigravity',
      }),
    );
  }
  for (const row of snapshot.copilot ?? []) {
    add(projectRow(row, 'copilot', { harness: 'copilot', source: 'copilot' }));
  }
  for (const row of snapshot.opencode ?? []) {
    add(
      projectRow(row, 'opencode', { harness: 'opencode', source: 'opencode' }),
    );
  }
  for (const row of snapshot.aiGatewayModels ?? []) {
    const provider: ModelCatalogProvider =
      row.recommendedHarness === 'codex' ? 'codex' : 'claude';
    add(
      projectRow(row, provider, {
        harness: row.recommendedHarness,
        source: 'ai-gateway',
      }),
    );
  }
  for (const agent of snapshot.agents ?? []) {
    add(
      projectRow(
        {
          id: agent.id,
          label: agent.name,
          available: agent.available,
        },
        'claude',
        { kind: 'agent' },
      ),
    );
  }

  return options;
}

export function publishPairedComputerModelCatalog(
  deviceId: string,
  snapshot: ModelRegistrySnapshot,
): void {
  const models = projectPairedModelRegistrySnapshot(snapshot);
  const aliases: Record<string, string> = {};
  if (
    typeof snapshot.aliases === 'object' &&
    snapshot.aliases !== null &&
    !Array.isArray(snapshot.aliases)
  ) {
    for (const [alias, target] of Object.entries(snapshot.aliases)) {
      if (typeof target === 'string') {
        aliases[alias] = target;
      }
    }
  }
  usePairedComputerModelCatalogStore.setState((current) => {
    const failed = { ...current.failed };
    delete failed[deviceId];
    return {
      byDevice: { ...current.byDevice, [deviceId]: models },
      aliasesByDevice: { ...current.aliasesByDevice, [deviceId]: aliases },
      failed,
    };
  });
}

export function markPairedComputerModelCatalogFailed(deviceId: string): void {
  usePairedComputerModelCatalogStore.setState((current) => ({
    failed: { ...current.failed, [deviceId]: true },
  }));
}

export function clearPairedComputerModelCatalog(deviceId?: string): void {
  usePairedComputerModelCatalogStore.setState((current) => {
    if (deviceId === undefined) {
      return Object.keys(current.byDevice).length === 0 &&
        Object.keys(current.failed).length === 0
        ? current
        : { byDevice: {}, aliasesByDevice: {}, failed: {} };
    }
    const byDevice = { ...current.byDevice };
    const aliasesByDevice = { ...current.aliasesByDevice };
    const failed = { ...current.failed };
    delete byDevice[deviceId];
    delete aliasesByDevice[deviceId];
    delete failed[deviceId];
    return { byDevice, aliasesByDevice, failed };
  });
}

function resolveOption(
  state: PairedComputerModelCatalogState,
  deviceId: string,
  modelId: string | undefined,
): ModelCatalogOption | undefined {
  if (modelId === undefined) return undefined;
  const models = state.byDevice[deviceId];
  if (models === undefined) return undefined;
  const direct = models.get(modelId);
  if (direct !== undefined) return direct;
  const canonical = state.aliasesByDevice[deviceId]?.[modelId];
  return canonical !== undefined ? models.get(canonical) : undefined;
}

export function pairedComputerModelList(
  state: PairedComputerModelCatalogState,
  projectId: string,
): ModelCatalog | undefined {
  const parsed = pairedComputerAddress(projectId);
  if (parsed === null) return undefined;
  const models = state.byDevice[parsed.deviceId];
  return models === undefined ? undefined : Array.from(models.values());
}

export function pairedComputerModelLabel(
  state: PairedComputerModelCatalogState,
  projectId: string,
  modelId: string | undefined,
): string | undefined {
  const parsed = pairedComputerAddress(projectId);
  if (parsed === null || modelId === undefined) return undefined;
  return resolveOption(state, parsed.deviceId, modelId)?.label ?? modelId;
}

/**
 * Picker catalog for a paired computer chat: lists the paired computer's own
 * models, and preserves the chat's current model as an unavailable row if it
 * is not present in the snapshot (never falls back to this computer's catalog).
 */
export function pairedComputerPickerModels(
  models: ModelCatalog | undefined,
  currentModel: string | undefined,
): ModelCatalog {
  const base = models ?? [];
  if (
    currentModel === undefined ||
    currentModel.length === 0 ||
    base.some((option) => option.id === currentModel)
  ) {
    return base;
  }
  return [
    ...base,
    {
      id: currentModel,
      label: currentModel,
      kind: 'model',
      provider: 'unknown',
      available: false,
    },
  ];
}
