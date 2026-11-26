import type {
  AiGatewayModelEntry,
  GatewayRouteEntry,
} from '../../execution-types';
import {
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelAliases,
  initOllamaModels,
  REQUIRED_OLLAMA_CAPABILITIES,
  resolveModelAlias,
  stripOllamaModelPrefix,
} from '../../model-catalog';
import type {
  ClaudeModelEntry,
  CodexModelEntry,
  OllamaModelEntry,
} from '../../model-catalog';
import { initModelHarnessAssignments } from '../../model-harnesses';
import { isThinkingLevel } from '../../thinking';
import type {
  ModelHarnessAssignmentSnapshot,
  ModelHarnessAssignment,
  BuiltinModelCatalogPayload,
} from '../../types/model-harnesses';
import type { ThinkingLevel } from '../../types/thinking';
import { getBrandEnv } from '../../brand/env';
import { isAiGatewayModelFamily } from '@canopy/protocol/ai-gateway-models';

let hydrated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelHarnessAssignment(
  value: unknown,
): value is ModelHarnessAssignment {
  return (
    isRecord(value) &&
    typeof value.modelId === 'string' &&
    (value.source === 'claude-managed' ||
      value.source === 'codex-managed' ||
      value.source === 'ai-gateway' ||
      value.source === 'ollama') &&
    (value.harness === 'claude' || value.harness === 'codex') &&
    (value.defaultHarness === 'claude' || value.defaultHarness === 'codex') &&
    typeof value.configurable === 'boolean' &&
    typeof value.overridden === 'boolean'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isBuiltinGatewayRoute(
  value: unknown,
): value is BuiltinModelCatalogPayload['gatewayRoutes'][number] {
  return (
    isRecord(value) &&
    typeof value.modelId === 'string' &&
    typeof value.gatewayId === 'string' &&
    isAiGatewayModelFamily(value.family) &&
    (value.recommendedHarness === 'claude' ||
      value.recommendedHarness === 'codex') &&
    typeof value.gatewayOnly === 'boolean' &&
    (value.contextWindow === undefined ||
      typeof value.contextWindow === 'number') &&
    (value.supportsPromptCaching === undefined ||
      typeof value.supportsPromptCaching === 'boolean') &&
    (value.supportedThinkingLevels === undefined ||
      isStringArray(value.supportedThinkingLevels)) &&
    (value.toolSchemaProfile === undefined ||
      value.toolSchemaProfile === 'standard' ||
      value.toolSchemaProfile === 'flat')
  );
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function parseStringRecord(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        record[key] = value;
      }
    }
    return record;
  } catch {
    return {};
  }
}

function parseThinkingLevelsRecord(
  raw: string | undefined,
): Record<string, ThinkingLevel[]> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const record: Record<string, ThinkingLevel[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const levels = value.filter(
        (level): level is ThinkingLevel =>
          typeof level === 'string' && isThinkingLevel(level),
      );
      record[key] = levels;
    }
    return record;
  } catch {
    return {};
  }
}

function parseHarnessAssignments(
  raw: string | undefined,
): ModelHarnessAssignmentSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.revision !== 'number' ||
      !Array.isArray(value.assignments)
    ) {
      return undefined;
    }
    const assignments = value.assignments;
    if (!assignments.every(isModelHarnessAssignment)) {
      return undefined;
    }
    return { revision: value.revision, assignments };
  } catch {
    return undefined;
  }
}

/**
 * A launch's assignment snapshot (CAN-5095): Electron main's registry also
 * holds assignments this parser does not apply (Cursor, Copilot, OpenCode),
 * so those entries are dropped rather than the whole snapshot.
 */
function parseLaunchHarnessAssignments(
  raw: string | undefined,
): ModelHarnessAssignmentSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.revision !== 'number' ||
      !Array.isArray(value.assignments)
    )
      return undefined;
    const assignments: unknown[] = value.assignments;
    return {
      revision: value.revision,
      assignments: assignments.filter(isModelHarnessAssignment),
    };
  } catch {
    return undefined;
  }
}

function parseBuiltinModelCatalog(
  raw: string | undefined,
): BuiltinModelCatalogPayload | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) {
      return undefined;
    }
    if (
      value.version !== 1 ||
      !isStringArray(value.claudeModels) ||
      !isStringArray(value.codexModels) ||
      (value.policyModelIds !== undefined &&
        !isStringRecord(value.policyModelIds)) ||
      !isStringArray(value.ollamaModels) ||
      !isStringArray(value.aiGatewayModels) ||
      !Array.isArray(value.gatewayRoutes) ||
      !value.gatewayRoutes.every(isBuiltinGatewayRoute) ||
      !isStringRecord(value.modelAliases)
    ) {
      return undefined;
    }
    return {
      version: value.version,
      claudeModels: value.claudeModels,
      codexModels: value.codexModels,
      ...(value.policyModelIds !== undefined && {
        policyModelIds: value.policyModelIds,
      }),
      ollamaModels: value.ollamaModels,
      aiGatewayModels: value.aiGatewayModels,
      gatewayRoutes: value.gatewayRoutes,
      modelAliases: value.modelAliases,
    };
  } catch {
    return undefined;
  }
}

/** The branded environment names the model registry reaches action subprocesses under. */
export type ModelRegistryKey =
  | 'CLAUDE_MODELS'
  | 'CODEX_MODELS'
  | 'OLLAMA_MODELS'
  | 'MODEL_ALIASES'
  | 'MODEL_CATALOG'
  | 'MODEL_HARNESS_ASSIGNMENTS'
  | 'MODEL_THINKING_LEVELS';

/** The model registry as the step runner serializes it, by branded environment name. */
export type ModelRegistrySnapshot = Partial<Record<ModelRegistryKey, string>>;

export function hydrateModelRegistryFromEnv(): void {
  if (hydrated) {
    return;
  }
  applyModelRegistry((key) => getBrandEnv(process.env, key), false);
  hydrated = true;
}

/**
 * Applies a launch's model registry snapshot (CAN-5095), so a daemon
 * pipeline host resolves models as its core does. A later snapshot replaces
 * the earlier one: absent model lists clear. Nothing is applied, and false is
 * returned, when its catalog or harness assignments do not parse.
 */
export function applyModelRegistrySnapshot(
  snapshot: ModelRegistrySnapshot,
): boolean {
  const assignments = parseLaunchHarnessAssignments(
    snapshot.MODEL_HARNESS_ASSIGNMENTS,
  );
  if (!parseBuiltinModelCatalog(snapshot.MODEL_CATALOG) || !assignments)
    return false;
  applyModelRegistry((key) => snapshot[key], true, true);
  initModelHarnessAssignments(assignments);
  return true;
}

/**
 * `listedOllamaSupported`: a launch snapshot lists only the Ollama models its
 * core found supported, without their capabilities, so each is applied as
 * supported (CAN-5831). Action subprocess hydration keeps its own behaviour.
 */
function applyModelRegistry(
  read: (key: ModelRegistryKey) => string | undefined,
  absentClears: boolean,
  listedOllamaSupported = false,
): void {
  const rawThinkingLevels = read('MODEL_THINKING_LEVELS');
  const rawClaudeModels = read('CLAUDE_MODELS');
  const rawCodexModels = read('CODEX_MODELS');
  const rawOllamaModels = read('OLLAMA_MODELS');
  const rawModelAliases = read('MODEL_ALIASES');
  const modelCatalog = parseBuiltinModelCatalog(read('MODEL_CATALOG'));
  const assignmentSnapshot = parseHarnessAssignments(
    read('MODEL_HARNESS_ASSIGNMENTS'),
  );
  const thinkingLevelsByModel = parseThinkingLevelsRecord(rawThinkingLevels);
  const policyModelIds = new Map(
    Object.entries(modelCatalog?.policyModelIds ?? {}),
  );
  const withThinkingLevels = (
    id: string,
  ): { supportedThinkingLevels?: ThinkingLevel[] } => {
    const levels = thinkingLevelsByModel[id];
    return levels ? { supportedThinkingLevels: levels } : {};
  };

  if (rawClaudeModels !== undefined || absentClears) {
    const claudeEntries: ClaudeModelEntry[] = parseStringArray(
      rawClaudeModels,
    ).map((id) => ({
      id,
      label: id,
      gatewayId: policyModelIds.get(id),
      ...withThinkingLevels(id),
    }));
    initClaudeModels(claudeEntries);
  }
  if (rawCodexModels !== undefined || absentClears) {
    const codexEntries: CodexModelEntry[] = parseStringArray(
      rawCodexModels,
    ).map((id) => ({
      id,
      label: id,
      gatewayId: policyModelIds.get(id),
      ...withThinkingLevels(id),
    }));
    initCodexModels(codexEntries);
  }
  if (rawOllamaModels !== undefined || absentClears) {
    const ollamaEntries: OllamaModelEntry[] = parseStringArray(
      rawOllamaModels,
    ).map((id) => ({
      id,
      rawModelId: stripOllamaModelPrefix(id),
      label: stripOllamaModelPrefix(id),
      ...(listedOllamaSupported && {
        show: { capabilities: [...REQUIRED_OLLAMA_CAPABILITIES] },
      }),
    }));
    initOllamaModels(ollamaEntries);
  }
  if (rawModelAliases !== undefined || absentClears) {
    initModelAliases(parseStringRecord(rawModelAliases));
  }
  if (modelCatalog) {
    const routes: GatewayRouteEntry[] = modelCatalog.gatewayRoutes.flatMap(
      (route) => {
        if (
          !route ||
          typeof route.modelId !== 'string' ||
          typeof route.gatewayId !== 'string' ||
          !isAiGatewayModelFamily(route.family) ||
          (route.recommendedHarness !== 'claude' &&
            route.recommendedHarness !== 'codex') ||
          typeof route.gatewayOnly !== 'boolean'
        ) {
          return [];
        }
        // Keep `off` when the propagated route declares it: gateway route
        // level sets are materialized with an explicit `off` by the catalog
        // merge, and stripping it here would clamp a requested `off` up to the
        // lowest thinking tier for AI-Credits-routed action models.
        const supportedThinkingLevels = (
          route.supportedThinkingLevels ??
          thinkingLevelsByModel[route.modelId] ??
          []
        ).filter((level): level is ThinkingLevel => isThinkingLevel(level));
        return [
          {
            modelId: route.modelId,
            gatewayId: route.gatewayId,
            family: route.family,
            recommendedHarness: route.recommendedHarness,
            gatewayOnly: route.gatewayOnly,
            contextWindow:
              typeof route.contextWindow === 'number' &&
              Number.isFinite(route.contextWindow)
                ? route.contextWindow
                : 0,
            supportsPromptCaching: route.supportsPromptCaching === true,
            supportedThinkingLevels,
            toolSchemaProfile:
              route.toolSchemaProfile === 'flat' ? 'flat' : 'standard',
          },
        ];
      },
    );
    const routeById = new Map(routes.map((route) => [route.modelId, route]));
    const entries: AiGatewayModelEntry[] = modelCatalog.aiGatewayModels.flatMap(
      (id) => {
        if (typeof id !== 'string') return [];
        const route = routeById.get(id);
        if (!route) return [];
        return [
          {
            id,
            label: id,
            recommendedHarness: route.recommendedHarness,
            contextWindow: route.contextWindow,
            supportsPromptCaching: route.supportsPromptCaching,
            supportedThinkingLevels: [...route.supportedThinkingLevels],
            toolSchemaProfile: route.toolSchemaProfile,
          },
        ];
      },
    );
    initAiGatewayModels(entries, routes);
    initModelAliases(modelCatalog.modelAliases);
  }
  if (assignmentSnapshot) {
    initModelHarnessAssignments(assignmentSnapshot);
  }
}

export function resolveConfiguredModel(
  raw: string | undefined,
  fallback: string,
): string {
  hydrateModelRegistryFromEnv();
  const candidate = raw?.trim();
  if (!candidate) {
    return resolveModelAlias(fallback);
  }
  return resolveModelAlias(candidate);
}
