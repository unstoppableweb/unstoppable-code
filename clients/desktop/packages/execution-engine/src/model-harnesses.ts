import {
  isAgentDefaultBaseModel,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import { isSyntacticallyValidModelId } from './lib/model-id';
export { isSyntacticallyValidModelId } from './lib/model-id';
import { isCursorModel } from './lib/cursor-models';
import { isCopilotModel } from './lib/copilot-models';
import { isOpenCodeModel } from './lib/opencode-models';
import type {
  BuildModelHarnessAssignmentsInput,
  ModelHarness,
  ModelHarnessAssignment,
  ModelHarnessAssignmentSnapshot,
  ModelHarnessCatalog,
  ModelHarnessSource,
} from './types/model-harnesses';
export type {
  BuildModelHarnessAssignmentsInput,
  BuiltinModelCatalogPayload,
  HarnessAssignmentsApi,
  ModelHarness,
  ModelHarnessAssignment,
  ModelHarnessAssignmentSnapshot,
  ModelHarnessCatalog,
  ModelHarnessInvocation,
  ModelHarnessOverridesFile,
  ModelHarnessSource,
  ResetModelHarnessAssignmentInput,
  SetModelHarnessAssignmentInput,
} from './types/model-harnesses';

export const MODEL_HARNESS_OVERRIDES_VERSION = 1 as const;

export class ModelHarnessPolicyError extends Error {
  constructor(
    readonly code:
      | 'INVALID_MODEL_ID'
      | 'UNKNOWN_MODEL'
      | 'NOT_CONFIGURABLE'
      | 'INVALID_HARNESS',
    message: string,
  ) {
    super(message);
    this.name = 'ModelHarnessPolicyError';
  }
}

export const DEFAULT_OLLAMA_HARNESS: ModelHarness = 'codex';

export function isModelHarness(value: unknown): value is ModelHarness {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
  );
}

/** Persist valid preferences even while a harness is disconnected. */
export function isAssignableModelHarness(
  value: unknown,
): value is ModelHarness {
  return isModelHarness(value);
}

export function isModelHarnessSource(
  value: unknown,
): value is ModelHarnessSource {
  return (
    value === 'claude-managed' ||
    value === 'codex-managed' ||
    value === 'cursor-managed' ||
    value === 'copilot-managed' ||
    value === 'opencode-managed' ||
    value === 'ai-gateway' ||
    value === 'ollama'
  );
}

/** Resolve aliases transitively while failing closed on alias cycles. */
export function canonicalizeModelAlias(
  modelId: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  if (!isSyntacticallyValidModelId(modelId)) {
    throw new ModelHarnessPolicyError(
      'INVALID_MODEL_ID',
      'modelId must be a non-empty model identifier without whitespace',
    );
  }
  let current = modelId;
  const visited = new Set<string>();
  while (
    Object.prototype.hasOwnProperty.call(aliases, current) &&
    aliases[current] !== undefined
  ) {
    if (visited.has(current)) {
      throw new ModelHarnessPolicyError(
        'INVALID_MODEL_ID',
        `Model alias cycle contains "${modelId}"`,
      );
    }
    visited.add(current);
    const next = aliases[current];
    if (!isSyntacticallyValidModelId(next)) {
      throw new ModelHarnessPolicyError(
        'INVALID_MODEL_ID',
        `Model alias "${current}" has an invalid target`,
      );
    }
    current = next;
  }
  return current;
}

/** Drop malformed entries while retaining syntactically valid stale keys. */
export function normalizeModelHarnessOverrides(
  value: unknown,
  aliases: Readonly<Record<string, string>> = {},
): Record<string, ModelHarness> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, ModelHarness> = {};
  for (const [modelId, harness] of Object.entries(value)) {
    if (!isSyntacticallyValidModelId(modelId) || !isModelHarness(harness)) {
      continue;
    }
    try {
      normalized[canonicalizeModelAlias(modelId, aliases)] = harness;
    } catch {
      // An invalid/cyclic alias is not safe to persist as an effective key.
    }
  }
  return normalized;
}

/**
 * Base of a chat route id: the route's own base for an inheriting Agent, the
 * Agent's configured base for a pinned one.
 */
function agentRouteBaseModel(
  modelId: string,
  agentBaseModels: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const route = parseAgentRouteModelId(modelId);
  if (!route) return undefined;
  const agentBase =
    agentBaseModels &&
    Object.prototype.hasOwnProperty.call(agentBaseModels, route.agentId)
      ? agentBaseModels[route.agentId]
      : undefined;
  return agentBase && !isAgentDefaultBaseModel(agentBase)
    ? agentBase
    : route.baseModel;
}

function resolveCatalogModelId(
  modelId: string,
  catalog: ModelHarnessCatalog,
): string {
  const canonical = canonicalizeModelAlias(modelId, catalog.modelAliases);
  const baseModel =
    catalog.agentBaseModels &&
    Object.prototype.hasOwnProperty.call(catalog.agentBaseModels, canonical)
      ? catalog.agentBaseModels[canonical]
      : agentRouteBaseModel(canonical, catalog.agentBaseModels);
  return baseModel
    ? canonicalizeModelAlias(baseModel, catalog.modelAliases)
    : canonical;
}

export function getModelHarnessSource(
  modelId: string,
  catalog: ModelHarnessCatalog,
): ModelHarnessSource | undefined {
  const resolved = resolveCatalogModelId(modelId, catalog);
  if (isCopilotModel(resolved)) return 'copilot-managed';
  if (isOpenCodeModel(resolved)) return 'opencode-managed';
  if (catalog.claudeModels.includes(resolved)) return 'claude-managed';
  if (catalog.codexModels.includes(resolved)) return 'codex-managed';
  if (isCursorModel(resolved) || catalog.cursorModels?.includes(resolved))
    return 'cursor-managed';
  if (catalog.aiGatewayModels.some((entry) => entry.id === resolved)) {
    return 'ai-gateway';
  }
  if (catalog.ollamaModels.includes(resolved)) return 'ollama';
  return undefined;
}

export function getDefaultModelHarness(
  modelId: string,
  catalog: ModelHarnessCatalog,
): ModelHarness | undefined {
  const resolved = resolveCatalogModelId(modelId, catalog);
  const source = getModelHarnessSource(resolved, catalog);
  if (source === 'claude-managed') return 'claude';
  if (source === 'codex-managed') return 'codex';
  if (source === 'cursor-managed') return 'cursor';
  if (source === 'copilot-managed') return 'copilot';
  if (source === 'opencode-managed') return 'opencode';
  if (source === 'ollama') return DEFAULT_OLLAMA_HARNESS;
  if (source === 'ai-gateway') {
    return catalog.aiGatewayModels.find((entry) => entry.id === resolved)
      ?.recommendedHarness;
  }
  return undefined;
}

export function getAvailableModelHarnesses(
  modelId: string,
  catalog: ModelHarnessCatalog,
): ModelHarness[] {
  const resolved = resolveCatalogModelId(modelId, catalog);
  const source = getModelHarnessSource(resolved, catalog);
  const native = getDefaultModelHarness(resolved, catalog);
  if (!native) return [];
  if (native === 'copilot') return ['copilot'];
  if (native === 'opencode') return ['opencode'];
  const choices: ModelHarness[] =
    source === 'ai-gateway' || source === 'ollama'
      ? ['claude', 'codex']
      : [native];
  if (
    source === 'ai-gateway' &&
    catalog.openCodeGatewayModels?.includes(resolved)
  ) {
    choices.push('opencode');
  }
  const cursorId = catalog.cursorModelMappings?.[resolved];
  return native !== 'cursor' &&
    cursorId &&
    catalog.cursorModels?.includes(cursorId)
    ? [...choices, 'cursor']
    : choices;
}

export function isModelHarnessConfigurable(
  modelId: string,
  catalog: ModelHarnessCatalog,
): boolean {
  return getAvailableModelHarnesses(modelId, catalog).length > 1;
}

export function getEffectiveModelHarness(
  modelId: string,
  catalog: ModelHarnessCatalog,
  overrides: Readonly<Record<string, ModelHarness>> = {},
): ModelHarness | undefined {
  const resolved = resolveCatalogModelId(modelId, catalog);
  const defaultHarness = getDefaultModelHarness(resolved, catalog);
  if (!defaultHarness) return undefined;
  const override = overrides[resolved];
  return override &&
    getAvailableModelHarnesses(resolved, catalog).includes(override)
    ? override
    : defaultHarness;
}

export function requireEffectiveModelHarness(
  modelId: string,
  catalog: ModelHarnessCatalog,
  overrides: Readonly<Record<string, ModelHarness>> = {},
): ModelHarness {
  const harness = getEffectiveModelHarness(modelId, catalog, overrides);
  if (!harness) {
    throw new ModelHarnessPolicyError(
      'UNKNOWN_MODEL',
      `Unknown model "${modelId}"`,
    );
  }
  return harness;
}

export function buildModelHarnessAssignmentSnapshot(
  input: BuildModelHarnessAssignmentsInput,
): ModelHarnessAssignmentSnapshot {
  const { catalog } = input;
  const overrides = normalizeModelHarnessOverrides(
    input.overrides ?? {},
    catalog.modelAliases,
  );
  const ids = [
    ...catalog.claudeModels,
    ...catalog.codexModels,
    ...(catalog.copilotModels ?? []),
    ...(catalog.opencodeModels ?? []),
    ...(catalog.cursorModels ?? []).filter(
      (id) => !Object.values(catalog.cursorModelMappings ?? {}).includes(id),
    ),
    ...catalog.aiGatewayModels.map((entry) => entry.id),
    ...catalog.ollamaModels,
  ];
  const seen = new Set<string>();
  const assignments: ModelHarnessAssignment[] = [];
  for (const candidate of ids) {
    const modelId = canonicalizeModelAlias(candidate, catalog.modelAliases);
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const source = getModelHarnessSource(modelId, catalog);
    const defaultHarness = getDefaultModelHarness(modelId, catalog);
    if (!source || !defaultHarness) continue;
    const configurable = isModelHarnessConfigurable(modelId, catalog);
    const availableHarnesses = getAvailableModelHarnesses(modelId, catalog);
    const explicit =
      configurable && availableHarnesses.includes(overrides[modelId])
        ? overrides[modelId]
        : undefined;
    assignments.push({
      modelId,
      source,
      harness: explicit ?? defaultHarness,
      defaultHarness,
      configurable,
      overridden: explicit !== undefined,
      availableHarnesses,
      ...(catalog.openCodeGatewayModels?.includes(modelId)
        ? {
            chatHarnesses: availableHarnesses.includes('opencode')
              ? [...availableHarnesses]
              : [...availableHarnesses, 'opencode'],
          }
        : {}),
    });
  }
  return {
    revision: input.revision ?? 0,
    assignments,
  };
}

/**
 * Validate and normalize one mutation. A target equal to the live default is
 * represented as a reset; an existing explicit override remains explicit
 * across later recommendation changes until such a mutation occurs.
 */
export function applyModelHarnessOverrideMutation(input: {
  modelId: string;
  harness?: unknown;
  reset?: boolean;
  catalog: ModelHarnessCatalog;
  overrides: Readonly<Record<string, ModelHarness>>;
}): { modelId: string; overrides: Record<string, ModelHarness> } {
  const modelId = canonicalizeModelAlias(
    input.modelId,
    input.catalog.modelAliases,
  );
  const source = getModelHarnessSource(modelId, input.catalog);
  if (!source) {
    throw new ModelHarnessPolicyError(
      'UNKNOWN_MODEL',
      `Unknown model "${input.modelId}"`,
    );
  }
  if (!isModelHarnessConfigurable(modelId, input.catalog)) {
    throw new ModelHarnessPolicyError(
      'NOT_CONFIGURABLE',
      `Model "${modelId}" is locked to its managed harness`,
    );
  }
  if (
    !input.reset &&
    (!isModelHarness(input.harness) ||
      !getAvailableModelHarnesses(modelId, input.catalog).includes(
        input.harness,
      ))
  ) {
    throw new ModelHarnessPolicyError(
      'INVALID_HARNESS',
      'The selected harness does not support this model',
    );
  }
  const next = normalizeModelHarnessOverrides(
    input.overrides,
    input.catalog.modelAliases,
  );
  const defaultHarness = getDefaultModelHarness(modelId, input.catalog);
  if (input.reset || input.harness === defaultHarness) {
    delete next[modelId];
  } else if (isModelHarness(input.harness)) {
    next[modelId] = input.harness;
  }
  return { modelId, overrides: next };
}

function copyAssignment(
  assignment: ModelHarnessAssignment,
): ModelHarnessAssignment {
  const { availableHarnesses, chatHarnesses, ...rest } = assignment;
  return {
    ...rest,
    ...(Array.isArray(availableHarnesses)
      ? { availableHarnesses: availableHarnesses.filter(isModelHarness) }
      : {}),
    ...(Array.isArray(chatHarnesses)
      ? { chatHarnesses: chatHarnesses.filter(isModelHarness) }
      : {}),
  };
}

let hydratedAssignmentSnapshot: ModelHarnessAssignmentSnapshot = {
  revision: 0,
  assignments: [],
};

/** Initialize assignment transport state before a subprocess resolves models. */
export function initModelHarnessAssignments(
  snapshot: ModelHarnessAssignmentSnapshot,
): void {
  hydratedAssignmentSnapshot = {
    revision:
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
        ? snapshot.revision
        : 0,
    assignments: snapshot.assignments
      .filter(
        (assignment) =>
          isSyntacticallyValidModelId(assignment.modelId) &&
          isModelHarnessSource(assignment.source) &&
          isModelHarness(assignment.harness) &&
          isModelHarness(assignment.defaultHarness) &&
          typeof assignment.configurable === 'boolean' &&
          typeof assignment.overridden === 'boolean',
      )
      .map(copyAssignment),
  };
}

export function getModelHarnessAssignmentSnapshot(): ModelHarnessAssignmentSnapshot {
  return {
    revision: hydratedAssignmentSnapshot.revision,
    assignments: hydratedAssignmentSnapshot.assignments.map(copyAssignment),
  };
}

export function getHydratedModelHarnessAssignment(
  modelId: string,
  aliases: Readonly<Record<string, string>> = {},
  agentBaseModels: Readonly<Record<string, string>> = {},
): ModelHarnessAssignment | undefined {
  const canonical = canonicalizeModelAlias(modelId, aliases);
  const baseModel = Object.prototype.hasOwnProperty.call(
    agentBaseModels,
    canonical,
  )
    ? agentBaseModels[canonical]
    : agentRouteBaseModel(canonical, agentBaseModels);
  const resolved = baseModel
    ? canonicalizeModelAlias(baseModel, aliases)
    : canonical;
  const assignment = hydratedAssignmentSnapshot.assignments.find(
    (candidate) => candidate.modelId === resolved,
  );
  return assignment ? copyAssignment(assignment) : undefined;
}

/**
 * Reject a Cursor harness on a dispatch path that cannot run it.
 *
 * Cursor IS headless-capable now: pipeline steps run it through its own host
 * runner. What this guard protects are the paths with no Cursor support -
 * AI-Credits routing, the generic Claude worker, Ollama env resolution - whose
 * call sites decide Cursor before reaching here (see `step-runner.ts`). The
 * message therefore describes the dispatch, not the product.
 */
export function requireHeadlessHarness(
  harness: ModelHarness,
): Exclude<ModelHarness, 'cursor' | 'copilot' | 'opencode'>;
export function requireHeadlessHarness(
  harness: ModelHarness | undefined,
): Exclude<ModelHarness, 'cursor' | 'copilot' | 'opencode'> | undefined;
export function requireHeadlessHarness(
  harness: ModelHarness | undefined,
): Exclude<ModelHarness, 'cursor' | 'copilot' | 'opencode'> | undefined {
  if (harness === 'opencode')
    throw new Error('OpenCode does not run on this dispatch path.');
  if (harness === 'copilot')
    throw new Error('Copilot does not run on this dispatch path.');
  if (harness === 'cursor')
    throw new Error('Cursor does not run on this dispatch path.');
  return harness;
}
