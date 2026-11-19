import { z } from 'zod';
import { PipelineRunOwnerSchema } from './pipeline-values';

const id = z.string().min(1).max(512);
const dependency = z.enum(['absent', 'required', 'unknown']);
const route = z.strictObject({
  harness: z.enum(['claude', 'codex']),
  /** Null means the caller omitted the model; it is not a wildcard. */
  selection: id.nullable(),
  /** Exact policy/invocation identity; selection remains authored/display data. */
  requestModel: id,
  runtimeModel: id,
  source: z.enum([
    'claude-managed',
    'codex-managed',
    'ai-gateway',
    'ollama',
    'unknown',
  ]),
  effectiveRoute: z.enum([
    'native',
    'ai-credits',
    'gateway',
    'account-proxy',
    'ollama',
    'unknown',
  ]),
  authentication: z.enum(['vendor-profile', 'explicit-environment', 'unknown']),
});

/**
 * Non-secret evidence supplied only by trusted launch admission, never by an
 * owner request or ordinary observer. A native provider name is not evidence.
 * The desktop records resolver observations at launch; a daemon composition
 * must independently validate their epochs before granting authority.
 */
export const WorkerPipelineNativeRouteEvidenceSchema = z.strictObject({
  version: z.literal(1),
  identity: z.strictObject({
    executionId: id,
    owner: PipelineRunOwnerSchema,
    runScope: z.enum(['global', 'directory', 'worktree']),
    workspaceId: id.nullable(),
    worktreeId: id.nullable(),
  }),
  configurationEpoch: id,
  catalogFingerprint: id,
  policy: z.enum(['account-independent-personal', 'required', 'unknown']),
  gateway: dependency,
  accountProxy: dependency,
  aiCredits: dependency,
  futureSelections: z.enum(['closed', 'dynamic', 'unknown']),
  routes: z.array(route).min(1).max(256),
});

export type WorkerPipelineNativeRouteEvidence = z.infer<
  typeof WorkerPipelineNativeRouteEvidenceSchema
>;

const nativeCatalog = z.object({
  version: z.literal(1),
  claudeModels: z.array(id),
  codexModels: z.array(id),
  modelAliases: z.record(z.string(), id),
});
const harnessAssignments = z.object({
  revision: z.number(),
  assignments: z.array(z.object({ modelId: id, harness: id, source: id })),
});

/** Stable input for host-local catalog digests and active-host compatibility. */
export function pipelineModelCatalogIdentity(
  snapshot: Readonly<Record<string, string | undefined>>,
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(snapshot)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

/** Pure launch-snapshot resolution, shared below core and the executor. */
export function resolveNativePipelineModel(
  selection: string,
  snapshot: Readonly<Record<string, string | undefined>> | undefined,
):
  | Pick<
      WorkerPipelineNativeRouteEvidence['routes'][number],
      'selection' | 'requestModel' | 'runtimeModel' | 'harness' | 'source'
    >
  | undefined {
  try {
    const catalog = nativeCatalog.parse(
      JSON.parse(snapshot?.MODEL_CATALOG ?? ''),
    );
    const assignments = harnessAssignments.parse(
      JSON.parse(snapshot?.MODEL_HARNESS_ASSIGNMENTS ?? ''),
    );
    const requestModel = catalog.modelAliases[selection] ?? selection;
    // The ordinary executor's alias lookup is one hop. Chained/cyclic or
    // ambiguous catalogs need resolution support before native admission.
    if ((catalog.modelAliases[requestModel] ?? requestModel) !== requestModel)
      return undefined;
    const claude = catalog.claudeModels.includes(requestModel);
    const codex = catalog.codexModels.includes(requestModel);
    if (claude === codex) return undefined;
    const harness = claude ? 'claude' : 'codex';
    const source = claude ? 'claude-managed' : 'codex-managed';
    if (
      assignments.assignments.some(
        (assignment) =>
          assignment.modelId === requestModel &&
          (assignment.harness !== harness || assignment.source !== source),
      )
    )
      return undefined;
    return {
      selection,
      requestModel,
      runtimeModel: requestModel,
      harness,
      source,
    };
  } catch {
    return undefined;
  }
}

export const PIPELINE_SURVIVAL_BLOCKER_CODES = [
  'policy',
  'gateway',
  'account-proxy',
  'ai-credits',
  'environment-route',
  'native-auth-unknown',
  'dynamic-selection',
  'unsupported-route',
  'ollama',
  'network-proxy',
  'host-step',
  'owner-mcp',
  'managed-configuration',
  'setup-lease',
  'configuration-unverified',
  'unknown',
] as const;

/** Stored through execution authority, never accepted from an observing client. */
export const WorkerPipelineSurvivalAssessmentSchema = z
  .strictObject({
    version: z.literal(1),
    identity: WorkerPipelineNativeRouteEvidenceSchema.shape.identity,
    assessedAt: z.string().datetime({ offset: true }),
    disposition: z.enum(['continues', 'pauses']),
    routes: z.array(route).max(256),
    credentialFamilies: z
      .array(z.enum(['vendor-profile', 'explicit-environment']))
      .max(2),
    coveredOwnerKinds: z.array(id).max(32),
    startLeaseRefs: z.array(id).max(256),
    blockers: z
      .array(
        z.strictObject({
          code: z.enum(PIPELINE_SURVIVAL_BLOCKER_CODES),
          explanation: z.string().min(1).max(512),
        }),
      )
      .max(32),
    ledgerAfterQuit: z.literal('unavailable'),
    assumptions: z.array(z.string().min(1).max(512)).max(8).optional(),
    epochs: z.array(z.strictObject({ authority: id, version: id })).max(256),
  })
  .refine(
    (value) =>
      value.disposition === 'continues'
        ? value.blockers.length === 0
        : value.blockers.length > 0,
    'Continuing runs have no blockers; paused runs must explain their blocker.',
  );

export type WorkerPipelineSurvivalAssessment = z.infer<
  typeof WorkerPipelineSurvivalAssessmentSchema
>;
