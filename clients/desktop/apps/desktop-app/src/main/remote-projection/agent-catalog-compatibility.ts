import { AGENT_MODELS, type ModelHarness } from '@canopy/desktop-shared/types';

const HARNESSES: readonly ModelHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
];
const prepared = new Map<
  string,
  {
    key: string;
    at: number;
    result: Map<string, ReadonlySet<ModelHarness>>;
  }
>();

const pending = new Map<string, { key: string; promise: Promise<void> }>();

export function invalidateAgentCatalogCompatibility(): void {
  for (const entry of prepared.values()) entry.at = Number.NEGATIVE_INFINITY;
  pending.clear();
}

type ModelCatalogListener = () => Promise<void>;
const modelCatalogListeners = new Set<ModelCatalogListener>();

/**
 * Subscribes to model catalog changes (provider accounts, default models,
 * local runtimes). Returns the removal. Portal's catalog refresh is the one
 * listener until CAN-5986 deletes it.
 */
export function onModelCatalogChanged(
  listener: ModelCatalogListener,
): () => void {
  modelCatalogListeners.add(listener);
  return () => {
    modelCatalogListeners.delete(listener);
  };
}

/**
 * The model catalog changed: drops the prepared Agent compatibility so the
 * next catalog projection re-inspects it, then awaits each listener in turn.
 */
export async function notifyModelCatalogChanged(): Promise<void> {
  invalidateAgentCatalogCompatibility();
  for (const listener of [...modelCatalogListeners]) await listener();
}

/** Read-only inspection, deduplicated per destination/Agent/harness, never materialization. */
export async function prepareAgentCatalogCompatibility(
  projectId: string,
): Promise<void> {
  const agentIds = [...AGENT_MODELS];
  const key = JSON.stringify(agentIds);
  const cached = prepared.get(projectId);
  if (cached?.key === key && Date.now() - cached.at < 30_000) return;
  const preparing = pending.get(projectId);
  if (preparing?.key === key) return preparing.promise;
  const result = new Map<string, ReadonlySet<ModelHarness>>();
  const entry = { key, promise: Promise.resolve() };
  entry.promise = (async (): Promise<void> => {
    const { getAgentModel } = await import('../agents/agent-model-store');
    const { agentModelPluginIncompatibility } =
      await import('../plugins/agent-model-compatibility');
    // Sequential Agents bound filesystem pressure; each harness is inspected once.
    for (const id of agentIds) {
      try {
        const agent = await getAgentModel(id, projectId);
        if (!agent) continue;
        const compatible = new Set<ModelHarness>();
        for (const harness of HARNESSES) {
          if (
            !(await agentModelPluginIncompatibility(
              agent.pluginSelections,
              harness,
              projectId,
            ))
          )
            compatible.add(harness);
        }
        result.set(id, compatible);
      } catch {
        result.set(id, new Set());
      }
    }
    // Invalidated or superseded scans must not replace a newer snapshot.
    if (pending.get(projectId) !== entry) return;
    if (prepared.size >= 64 && !prepared.has(projectId))
      prepared.delete(prepared.keys().next().value ?? '');
    prepared.set(projectId, { key, at: Date.now(), result });
  })().finally(() => {
    if (pending.get(projectId) === entry) pending.delete(projectId);
  });
  pending.set(projectId, entry);
  return entry.promise;
}

export function agentCatalogHarnesses(
  projectId: string | undefined,
  agentId: string,
): ReadonlySet<ModelHarness> | undefined {
  return projectId ? prepared.get(projectId)?.result.get(agentId) : undefined;
}
