import { agentModelRegistryContextCurrent } from '../lib/agent-models';
import {
  AGENT_MODELS,
  CLAUDE_MODELS,
  getConfiguredGatewayId,
  getConfiguredCursorModelId,
  getCursorModelEntries,
  getCopilotModelEntries,
  getOpenCodeModelEntries,
  initCursorModels,
  CODEX_MODELS,
  buildModelHarnessAssignmentSnapshot,
  getAiGatewayModelEntries,
  getConfiguredSupportedThinkingLevels,
  getCurrentModelHarnessCatalog,
  getModelAliases,
  getModelBillingMetadata,
  getListedModelContextWindow,
  getModelContextWindow,
  getModelDescription,
  getModelDisplayName,
  getModelGatewayConfig,
  getModelShowMoreOnly,
  getGatewayModelEntries,
  getModelHarnessAssignmentSnapshot,
  initModelHarnessAssignments,
  ModelHarnessPolicyError,
  resolveAgentModelDefinition,
  type ClaudeModelEntry,
  type CodexModelEntry,
  type ModelRegistrySnapshot,
  type OllamaModelEntry,
} from '@canopy/desktop-shared/types';
import { getModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import {
  ModelHarnessOverrideStore,
  type ModelHarnessOverrideMutationResult,
} from '@canopy/desktop-shared/node/model-harnesses';
import type { AgentModelRegistryEntry } from '@canopy/execution-engine/types/agent-models';
import { getOllamaService } from '../ollama';
import { isOpenCodeGatewayRouteSupported } from '@canopy/desktop-shared/lib/opencode-gateway-models';
import { peekOpenCodeRuntimeAvailability } from '../opencode/runtime-availability';
import { getAiGatewayCatalogStatus } from '../ai-gateway-models/status';

type ModelRegistryBroadcastHandler = (snapshot: ModelRegistrySnapshot) => void;

let broadcastHandler: ModelRegistryBroadcastHandler | undefined;
let cachedSnapshot: ModelRegistrySnapshot = {
  claude: [],
  codex: [],
  ollama: [],
  agents: [],
  aliases: {},
};
let assignmentRevision = 0;
let assignmentStore: ModelHarnessOverrideStore | undefined;
let assignmentInitialization: Promise<void> | undefined;

function getHostModelHarnessCatalog(): ReturnType<
  typeof getCurrentModelHarnessCatalog
> {
  return {
    ...getCurrentModelHarnessCatalog(),
    openCodeGatewayModels:
      peekOpenCodeRuntimeAvailability() === true
        ? getGatewayModelEntries()
            .filter(isOpenCodeGatewayRouteSupported)
            .map((entry) => entry.modelId)
        : [],
  };
}

function getAssignmentStore(): ModelHarnessOverrideStore {
  assignmentStore ??= new ModelHarnessOverrideStore({
    getCatalog: getHostModelHarnessCatalog,
  });
  return assignmentStore;
}

function assignmentsEqual(
  left: ModelRegistrySnapshot['harnessAssignments'],
  right: ModelRegistrySnapshot['harnessAssignments'],
): boolean {
  return (
    JSON.stringify(left?.assignments ?? []) ===
    JSON.stringify(right?.assignments ?? [])
  );
}

export function refreshModelHarnessAssignments(
  overrides = getAssignmentStore().getCachedOverrides(),
): ReturnType<typeof getModelHarnessAssignmentSnapshot> {
  const previous = getModelHarnessAssignmentSnapshot();
  const candidate = buildModelHarnessAssignmentSnapshot({
    catalog: getHostModelHarnessCatalog(),
    overrides,
    revision: assignmentRevision,
  });
  if (!assignmentsEqual(previous, candidate)) {
    assignmentRevision += 1;
    candidate.revision = assignmentRevision;
  } else {
    candidate.revision = previous.revision;
  }
  initModelHarnessAssignments(candidate);
  return candidate;
}

/** Load the brand-scoped file once after all source catalogs are initialized. */
export async function initializeModelHarnessRegistry(): Promise<void> {
  assignmentInitialization ??= (async (): Promise<void> => {
    const overrides = await getAssignmentStore().load();
    if (Object.values(overrides).includes('opencode')) {
      const { isOpenCodeRuntimeAvailable } =
        await import('../opencode/runtime-availability');
      await isOpenCodeRuntimeAvailable();
    }
    refreshModelHarnessAssignments(overrides);
    if (Object.values(overrides).includes('cursor')) {
      // Give saved defaults a short opportunity to hydrate before the window
      // opens. Slow vendor processes continue in the background; their 45s
      // discovery deadline must never become the desktop startup deadline.
      const discovery = (async (): Promise<void> => {
        try {
          const { listCursorModels } = await import('../cursor/models');
          initCursorModels(await listCursorModels());
        } catch {
          // Keep the override on disk; unavailable Cursor falls back to native.
          initCursorModels([]);
        }
        // Read current overrides: the user can change them while discovery runs.
        refreshModelHarnessAssignments();
        broadcastModelRegistryUpdated();
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          discovery,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  })();
  await assignmentInitialization;
}

async function applyAssignmentMutation(
  mutation: Promise<ModelHarnessOverrideMutationResult>,
): Promise<ReturnType<typeof getModelHarnessAssignmentSnapshot>> {
  await initializeModelHarnessRegistry();
  const result = await mutation;
  return refreshModelHarnessAssignments(result.overrides);
}

export const modelHarnessAssignmentController = {
  async load(): Promise<ReturnType<typeof getModelHarnessAssignmentSnapshot>> {
    await initializeModelHarnessRegistry();
    return refreshModelHarnessAssignments();
  },
  async set(input: {
    modelId: string;
    harness: 'claude' | 'codex' | 'cursor' | 'opencode';
  }): Promise<ReturnType<typeof getModelHarnessAssignmentSnapshot>> {
    if (input.harness === 'opencode') {
      const { isOpenCodeRuntimeAvailable } =
        await import('../opencode/runtime-availability');
      if (!(await isOpenCodeRuntimeAvailable())) {
        throw new ModelHarnessPolicyError(
          'INVALID_HARNESS',
          'OpenCode is unavailable for this model',
        );
      }
    }
    if (input.harness === 'cursor') {
      // Runtime status is local filesystem/provider plumbing. Defer that graph
      // until a Cursor assignment is requested; native assignments stay light.
      const { assertCursorHarnessEnabled } =
        await import('../cursor/feature-flag');
      assertCursorHarnessEnabled();
      const { cursorConnectionStatus } =
        await import('../cursor/runtime-status');
      const status = await cursorConnectionStatus();
      if (!status.enabled || !status.supported || !status.installed) {
        throw new ModelHarnessPolicyError(
          'INVALID_HARNESS',
          'Cursor is unavailable for this model',
        );
      }
      const { getModelGatewayRequirementForOwner } =
        await import('../lib/model-gateway-state');
      const { resolveNavigationWorkOwner } =
        await import('../agents/work-owner');
      const owner = await resolveNavigationWorkOwner();
      if (
        (
          await getModelGatewayRequirementForOwner(
            owner,
            'modelHarnessAssignment.set',
          )
        ).kind !== 'unrestricted'
      ) {
        throw new ModelHarnessPolicyError(
          'INVALID_HARNESS',
          'Your organization requires model traffic to use its configured gateway.',
        );
      }
    }
    return applyAssignmentMutation(
      getAssignmentStore().set(input.modelId, input.harness),
    );
  },
  reset(input: {
    modelId: string;
  }): Promise<ReturnType<typeof getModelHarnessAssignmentSnapshot>> {
    return applyAssignmentMutation(getAssignmentStore().reset(input.modelId));
  },
};

export function resetModelHarnessRegistryForTests(): void {
  assignmentStore = undefined;
  assignmentInitialization = undefined;
  assignmentRevision = 0;
  initModelHarnessAssignments({ revision: 0, assignments: [] });
}

function buildSnapshotFromOllamaModels(
  ollamaModels: OllamaModelEntry[],
): ModelRegistrySnapshot {
  const claudeEntries: ClaudeModelEntry[] = CLAUDE_MODELS.map(
    (id): ClaudeModelEntry => {
      const contextWindow = getModelContextWindow(id);
      const description = getModelDescription(id);
      const supportedThinkingLevels = getConfiguredSupportedThinkingLevels(id);
      const gateway = getModelGatewayConfig(id);
      const showMoreOnly = getModelShowMoreOnly(id);
      const familyMetadata = getModelFamilyMetadata(id);
      return {
        id,
        label: getModelDisplayName(id),
        gatewayId: getConfiguredGatewayId(id),
        cursorModelId: getConfiguredCursorModelId(id),
        ...(familyMetadata ?? {}),
        ...(description ? { description } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(supportedThinkingLevels ? { supportedThinkingLevels } : {}),
        ...(showMoreOnly ? { showMoreOnly: true } : {}),
        ...(gateway ? { gateway } : {}),
        ...(getModelBillingMetadata(id) ?? {}),
      };
    },
  );
  const codexEntries: CodexModelEntry[] = CODEX_MODELS.map(
    (id): CodexModelEntry => {
      const contextWindow = getListedModelContextWindow(id);
      const description = getModelDescription(id);
      const supportedThinkingLevels = getConfiguredSupportedThinkingLevels(id);
      const gateway = getModelGatewayConfig(id);
      const showMoreOnly = getModelShowMoreOnly(id);
      const familyMetadata = getModelFamilyMetadata(id);
      return {
        id,
        label: getModelDisplayName(id),
        gatewayId: getConfiguredGatewayId(id),
        cursorModelId: getConfiguredCursorModelId(id),
        ...(familyMetadata ?? {}),
        ...(description ? { description } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(supportedThinkingLevels ? { supportedThinkingLevels } : {}),
        ...(showMoreOnly ? { showMoreOnly: true } : {}),
        ...(gateway ? { gateway } : {}),
        ...(getModelBillingMetadata(id) ?? {}),
      };
    },
  );
  const agents: AgentModelRegistryEntry[] = (
    agentModelRegistryContextCurrent() ? AGENT_MODELS : []
  ).flatMap((id) => {
    const entry = resolveAgentModelDefinition(id);
    return entry ? [entry] : [];
  });
  const gatewayRoutes = getGatewayModelEntries();
  const aiGatewayModels = getAiGatewayModelEntries();

  // Catalog refreshes and Ollama discovery update assignments from the
  // already-loaded in-memory override map; no execution path rereads disk.
  refreshModelHarnessAssignments();
  const aiGatewayCatalogStatus = getAiGatewayCatalogStatus();

  return {
    cursor: getCursorModelEntries(),
    copilot: getCopilotModelEntries(),
    opencode: getOpenCodeModelEntries(),
    claude: claudeEntries,
    codex: codexEntries,
    ollama: ollamaModels,
    agents,
    aliases: getModelAliases(),
    aiGatewayModels,
    gatewayRoutes,
    harnessAssignments: refreshModelHarnessAssignments(),
    ...(aiGatewayCatalogStatus ? { aiGatewayCatalogStatus } : {}),
  };
}

export function setModelRegistryBroadcastHandler(
  handler: ModelRegistryBroadcastHandler | undefined,
): void {
  broadcastHandler = handler;
}

export function buildModelRegistrySnapshot(): ModelRegistrySnapshot {
  cachedSnapshot = buildSnapshotFromOllamaModels(
    getOllamaService().getCachedModels(),
  );
  return cachedSnapshot;
}

export function getSynchronousModelRegistrySnapshot(): ModelRegistrySnapshot {
  cachedSnapshot = buildSnapshotFromOllamaModels(
    getOllamaService().getCachedModels(),
  );
  return cachedSnapshot;
}

export function getCachedModelRegistrySnapshot(): ModelRegistrySnapshot {
  return cachedSnapshot;
}

export function broadcastModelRegistryUpdated(): void {
  if (!broadcastHandler) {
    return;
  }
  broadcastHandler(buildModelRegistrySnapshot());
}
