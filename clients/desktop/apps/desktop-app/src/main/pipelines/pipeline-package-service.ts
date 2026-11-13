import {
  LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
  pipelineDeclaresLocalOnlyTrigger,
} from '@canopy/pipeline-interop/portability';
import {
  authorizeProjectPipelineRequest,
  assertStoredPipelineContext,
  assertPipelineShareSourceContext,
  readPipelineShareSource,
  recordSharedPipelineInstall,
} from './pipeline-install-context';
import {
  beginPipelineInstallIntent,
  isPipelineDefinitionClaimed,
  type PipelineInstallIntent,
} from './pipeline-install-intents';
import {
  assertPipelineContext,
  assertPipelineContextSnapshot,
  pipelineContextSnapshot,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import type { BrowserWindow } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PipelineDefinitionSourceError,
  type PipelineDefinitionInstall,
} from '@canopy/core-runtime/node/pipeline';
import {
  recordSharedItemInstall,
  type SharedItemInstallRecord,
} from '../canopy-cloud/shared-item-subscriptions';
import { createHash, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  analyzeCapabilityPackage,
  analyzePipelinePackage,
  buildPipelineCapabilityPackageSources,
  pipelinePackageAnalysisIsStale,
  type PipelinePackageAnalysisInternal,
  type PipelinePackageProvider,
  type PipelinePackageStepProviders,
  type PipelinePackageStepVariant,
  type CapabilityPackagePortableResourceInput,
  type CapabilityPackageRequest,
  type CapabilityPackagePromptSource,
  type AutomationPipelinePortableInput,
  type FileAssetPortableInput,
} from '@canopy/desktop-shared/node';
import {
  AUTOMATION_ACTION_PIPELINE_KEY,
  resolveAutomationPipelineReferences,
  type AutomationPipelineSource,
} from '@canopy/desktop-shared/node/pipelines/automation-pipeline-references';
import { canonicalizeSharedAutomationPrompt } from '@canopy/protocol/automations';
import {
  computePipelinePackageDigestSync,
  buildPipelinePackageOverlay,
  filterPackageOverlayForBindingKey,
  hashPipelinePackageYaml,
  installPipelinePackageAtomically,
  leasePipelinePackage,
  type PipelinePackageLease,
  pipelinePackageCarriesPipeline,
  removePipelinePackageUnlessRetained,
  verifyCachedPipelinePackage,
} from '@canopy/desktop-shared/node';
import type {
  Pipeline,
  PipelineData,
  PipelineInputDef,
  PipelineInputValue,
  PipelinePackageAnalysisSummary,
  PipelinePackageCapabilityOverlay,
  PipelinePackageAnalyzeRequest,
  PipelineShareSource,
  PipelinePackageCreateSharedRequest,
  PipelinePackageInstallRecordV1,
  PipelinePackageInstallRequest,
  PipelinePackageInstallResult,
  PipelinePackageAnalysisBlocker,
  PipelinePackageInvocationDismissal,
  PipelinePackageProgressEvent,
  PipelinePackageReadiness,
  PipelinePackageReferenceDismissal,
  PipelinePackageReadinessRequest,
  PipelineInfo,
  SharedPipelineDetail,
} from '@canopy/execution-engine/types/pipeline';
import type {
  AutomationPipelineDependency,
  ChatTabPluginSelections,
  CommitAutomationCapabilityPackageRequest,
} from '@canopy/desktop-shared/types';
import type { InvocableInventoryEnableRef } from '@canopy/execution-engine/types/invocable-inventory';
import type {
  PipelinePackageBinding,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageManifestV1,
  PipelinePackageRef,
  PipelinePackageResource,
  PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import {
  buildPublicPipelineShareId,
  parsePublicPipelineShareId,
  parsePublicPipelineShareVersion,
  publicPipelineShareVersion,
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  capabilityPackageBindingFromKey,
  capabilityPackageBindingKey,
  capabilityPackageStepBindingKey,
  groupCapabilityPackageProviderTwins,
  listCapabilityPackageExecutablePaths,
} from '@canopy/protocol/pipelines';
import { isSafeCapabilityRelativePath } from '@canopy/protocol/capability-files';
import {
  extractSkillDependencies,
  skillDependenciesToEnvironmentRequirements,
} from '@canopy/protocol/skills';
import { BRAND } from '@canopy/brand/current';
import { parseFrontmatterAndBody } from '../lib/frontmatter';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  assignStepIds,
  resolvePipelineModelAliasLenient,
} from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  interpolateExpression,
  templateInputReferences,
} from '@canopy/execution-engine/node/pipelines/executor/expression-evaluator';
import {
  buildExpressionContext,
  cascadeEnv,
} from '@canopy/execution-engine/node/pipelines/executor/execution-context';
import {
  resolveChildPipelineRef,
  type ChildPipelineRefResolution,
} from '@canopy/desktop-shared/node/pipelines/child-pipeline-ref';
import { getStoredPipelinePathWithSource } from '@canopy/execution-engine/pipelines/store';
import {
  collectPipelineCapabilityRefs,
  getPipelinePluginDefaultRef,
} from '@canopy/execution-engine/pipelines/plugin-collections';
import { getShareablePluginRefKey } from '@canopy/execution-engine/plugin-refs';
import {
  DEFAULT_CLAUDE_MODEL,
  getProviderForModel,
  ModelHarnessPolicyError,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import {
  getTriggerInputDefs,
  getTriggerTypes,
} from '@canopy/execution-engine/types/pipeline';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import type { ExecutionOptions } from '@canopy/execution-engine/node/pipelines/executor/types';
import { loadPipelinePackageInventorySources } from '../plugins/invocable-inventory-service';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../plugins/shareable-plugin-resolution';
import { resolveEffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import {
  getPipelinePackageDismissalStorePath,
  getPipelinePackageInstallStorePath,
  getPipelinePackagesDir,
} from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { discoverProjectInvocableSources } from '../agents/project-slash-command-discovery';
import * as localPipelineService from './pipeline-service';
import {
  buildAutomationPipelineInventory,
  packagedPipelineFileAssets,
  pipelineFileDir,
  publicAudienceAssetsBlockers,
  type PackagedAutomationPipeline,
} from './automation-pipeline-sources';
import {
  deleteUserPipelineLocalMetadata,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
  setUserPipelineAgentAuthor,
} from './pipeline-local-metadata-store';
import {
  getUserPipelineOwner,
  selectedOwnerContext,
} from './pipeline-owner-policy';
import {
  commitPipelinePackageUpload,
  createSharedPipeline,
  authorizeSharedPipelineCreate,
  getPublicPipelinePackage,
  getPublicPipelinePackageBlob,
  getPipelinePackage,
  getPipelinePackageBlob,
  getAutomationPackage,
  getAutomationPackageBlob,
  getCuratedAutomationPackage,
  getCuratedAutomationPackageBlob,
  getPublicAutomationPackage,
  getPublicAutomationPackageBlob,
  getSharedPipeline,
  PACKAGE_REQUEST_TIMEOUT_MS,
  preparePipelinePackageUpload,
  refuseLocalOnlyTrigger,
  updateSharedPipeline,
  uploadPipelinePackageBlob,
} from './canopy-server-client';
import { getPublicPipelineShareSnapshot } from '../canopy-cloud/public-share-client';
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  ShareOperationError,
  ShareStageError,
  shareFailureFromError,
  withShareStage,
} from '../sharing/share-operation-result';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import type { ShareFailureStage } from '@canopy/protocol/sharing';
import { resolveGitHubTokenWithSource } from '../lib/github-auth';
import {
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
} from '../mcp/connection-status';
import { mcpSelectionToEnvironmentRequirement } from '../mcp/share-requirement';
import type { McpServerStatusEntry } from '@canopy/execution-engine/types/mcp-servers';
import { getOllamaService } from '../ollama/service';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import {
  getCachedClaudeAuthStatusObserved,
  getCachedCodexAuthStatusObserved,
} from '../auth/provider-auth-state';
import { getAiCreditsRoutingContextWithStatus } from '../agents/ai-credits-routing';
import { resolveNavigationWorkOwner } from '../agents/work-owner';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import { AUTOMATION_SHARE_BLOCK_MESSAGES } from '@canopy/desktop-shared/lib/automation-sharing';
import {
  getEnhancedEnv,
  getProjectActionsDirCandidates,
  getProjectPipelinesDirCandidates,
} from './config-paths';
import {
  findPipelinePackageInstall,
  findCapabilityPackageInstallByOwner,
  listCapabilityPackageInstalls,
  listPipelinePackageInstalls,
  removeCapabilityPackageInstall,
  removePipelinePackageInstall,
  repinCapabilityPackageInstallLocalContent,
  upsertPipelinePackageInstall,
  upsertCapabilityPackageInstall,
} from './pipeline-package-install-store';
import {
  listPipelinePackageDismissals,
  replacePipelinePackageDismissals,
} from './pipeline-package-dismissal-store';
import { sendToWebContents } from '../lib/web-contents-send';

const ANALYSIS_LIMIT = 8;
/** Attempts per blob PUT. Writes are content-addressed, so repeats are safe. */
const RETRY_ATTEMPTS = 3;
/** Attempts to prepare an upload; an abandoned prepared upload expires. */
const PREPARE_ATTEMPTS = 2;
/**
 * Attempts to commit the same upload id. Safe because the server returns the
 * existing result for an already `COMMITTED` upload.
 */
const COMMIT_ATTEMPTS = 2;
const UPLOAD_CONCURRENCY = 4;
const RETRY_AFTER_CAP_MS = 5_000;
/**
 * Overall bound for one package attempt, including backoff: a base plus a
 * per-blob allowance so large legitimate uploads are not cut off, capped.
 */
const PACKAGE_DEADLINE_BASE_MS = 120_000;
const PACKAGE_DEADLINE_PER_BLOB_MS = 10_000;
const PACKAGE_DEADLINE_MAX_MS = 10 * 60_000;
const PACKAGE_DEADLINE_MESSAGE =
  "Couldn't upload the included files in time. Check your connection and try again.";
const AUTOMATION_ACTION_BINDING_JOB_ID = 'automation';
const AUTOMATION_ACTION_BINDING_STEP_ID = 'action';
const AUTOMATION_ACTION_BINDING_KEY = `${AUTOMATION_ACTION_BINDING_JOB_ID}\0${AUTOMATION_ACTION_BINDING_STEP_ID}`;
/** Resources an automation install materializes rather than hands an agent. */
const AUTOMATION_INSTALLED_RESOURCE_KINDS: ReadonlySet<
  PipelinePackageResource['kind']
> = new Set<PipelinePackageResource['kind']>([
  'automation_pipeline',
  'file_asset',
]);
const analyses = new Map<
  string,
  PipelinePackageAnalysisInternal & {
    shareSource?: PipelineShareSource;
    shareBytes?: string;
    /** The skill a skill analysis read its folder from. */
    skill?: { sourceId: string; skillName: string };
  }
>();
const activeAnalysisRequests = new Map<string, symbol>();
const dismissalWriteQueues = new Map<string, Promise<void>>();
const publicPackageInstalls = new Map<
  string,
  Promise<PipelinePackageInstallResult>
>();
let publicPackageInstallQueue: Promise<void> = Promise.resolve();

interface PackageWorktreeContext {
  projectId: string;
  worktreeId: string;
  repoId?: string;
}

type RepoLocalInvocables = {
  index: NonNullable<
    Parameters<typeof analyzePipelinePackage>[0]['repoLocalInvocables']
  >;
  sources: NonNullable<
    Parameters<typeof analyzePipelinePackage>[0]['sourceByRepoLocalEntryId']
  >;
};

function inventoryEnableRefsEqual(
  left: InvocableInventoryEnableRef,
  right:
    | { kind: 'skill'; sourceId: string; skillName: string }
    | { kind: 'plugin'; marketplaceId: string; pluginName: string },
): boolean {
  if (left.kind === 'skill' && right.kind === 'skill') {
    return (
      left.sourceId === right.sourceId && left.skillName === right.skillName
    );
  }
  return (
    left.kind === 'plugin' &&
    right.kind === 'plugin' &&
    left.marketplaceId === right.marketplaceId &&
    left.pluginName === right.pluginName
  );
}

function emitProgress(
  getWindow: (() => BrowserWindow | null) | undefined,
  event: PipelinePackageProgressEvent,
): void {
  const window = getWindow?.();
  if (window && !window.isDestroyed()) {
    sendToWebContents(window.webContents, 'pipelines:package-progress', event);
  }
}

/** Above this many input combinations a model expression is not enumerated. */
const MAX_MODEL_EXPRESSION_VARIANTS = 32;

/**
 * The provider a configured model id runs under, after pipeline model aliases
 * and built-in `$` references such as `$sol`. A model no provider claims keeps
 * the Claude default; `undefined` means the model-id validator rejected it.
 */
function providerForConfiguredModel(
  pipeline: Pipeline,
  configuredModel: string,
): PipelinePackageProvider | undefined {
  const alias = pipeline.model_aliases?.find(
    (candidate) => candidate.id === configuredModel,
  );
  // An alias without defaults has no model until a run's preference supplies
  // one, so its provider can't be known here. A preference can also override
  // an alias that has defaults; those defaults are what the pipeline ships
  // with, so they stay the analyzed (confirmed) model.
  if (alias && !alias.defaults) return undefined;
  const concreteModel =
    alias?.defaults &&
    'base' in alias.defaults &&
    alias.defaults.base !== undefined
      ? alias.defaults.base
      : alias?.defaults && 'agent_id' in alias.defaults
        ? alias.defaults.agent_id
        : configuredModel;
  try {
    // Package analysis distinguishes Codex from Claude-runtime dependencies
    // only; other harnesses (Cursor, Copilot, Ollama) keep the Claude side,
    // as they always have here.
    return getProviderForModel(
      resolvePipelineModelAliasLenient(concreteModel),
    ) === 'codex'
      ? 'codex'
      : 'claude';
  } catch (error) {
    // Malformed ids (for example, ones with whitespace) are rejected by
    // throwing. Anything else is a real failure for the caller to report.
    if (error instanceof ModelHarnessPolicyError) return undefined;
    throw error;
  }
}

/**
 * The values an input is analyzed with. A `closed` domain is every value the
 * input can take; an open one is only its default, since a run can supply
 * any other value. `absent` adds the run where the input has no value at all.
 */
interface InputDomain {
  values: readonly PipelineInputValue[];
  closed: boolean;
  absent: boolean;
}

function inputDomain(definition: PipelineInputDef): InputDomain | undefined {
  // A run resolves an input it isn't given to its default; without one, an
  // optional input stays absent.
  const absent = definition.default === undefined && !definition.required;
  if (definition.type === 'choice' && definition.options?.length) {
    return { values: definition.options, closed: true, absent };
  }
  if (definition.type === 'boolean') {
    return { values: [true, false], closed: true, absent };
  }
  return definition.default !== undefined
    ? { values: [definition.default], closed: false, absent: false }
    : undefined;
}

function mergeInputDomains(
  known: InputDomain,
  domain: InputDomain,
): InputDomain {
  return {
    values: [
      ...known.values,
      ...domain.values.filter(
        (value) =>
          !known.values.some((existing) => isDeepStrictEqual(existing, value)),
      ),
    ],
    closed: known.closed && domain.closed,
    absent: known.absent || domain.absent,
  };
}

function declareInputDomain(
  domains: Map<string, InputDomain | undefined>,
  name: string,
  definition: PipelineInputDef,
): void {
  const domain = inputDomain(definition);
  const known = domains.has(name)
    ? domains.get(name)
    : { values: [], closed: true, absent: false };
  domains.set(
    name,
    known && domain ? mergeInputDomains(known, domain) : undefined,
  );
}

/**
 * Domains per trigger input across the pipeline's triggers. An input is
 * unknown when any declaration of it has no values, and open when any is
 * open. A trigger that doesn't declare an input runs without it.
 */
function pipelineInputDomains(
  pipeline: Pipeline,
): Map<string, InputDomain | undefined> {
  const triggerTypes = getTriggerTypes(pipeline.on);
  const domains = new Map<string, InputDomain | undefined>();
  const declarations = new Map<string, number>();
  for (const type of triggerTypes) {
    const definitions = getTriggerInputDefs(pipeline.on, type) ?? {};
    for (const [name, definition] of Object.entries(definitions)) {
      declarations.set(name, (declarations.get(name) ?? 0) + 1);
      declareInputDomain(domains, name, definition);
    }
  }
  for (const [name, domain] of Array.from(domains)) {
    if (domain && (declarations.get(name) ?? 0) < triggerTypes.length) {
      domains.set(name, { ...domain, absent: true });
    }
  }
  return domains;
}

/**
 * Every combination of the named inputs' values. An absent input is left out
 * of the combination, as a run leaves it out of `inputs`.
 */
function inputCombinations(
  names: readonly string[],
  domains: ReadonlyMap<string, InputDomain | undefined>,
): Array<Record<string, PipelineInputValue>> | undefined {
  let combinations: Array<Record<string, PipelineInputValue>> = [{}];
  for (const name of names) {
    const domain = domains.get(name);
    if (!domain?.values.length) return undefined;
    const choices = domain.values.length + (domain.absent ? 1 : 0);
    if (combinations.length * choices > MAX_MODEL_EXPRESSION_VARIANTS) {
      return undefined;
    }
    combinations = combinations.flatMap((combination) => [
      ...domain.values.map((value) => ({ ...combination, [name]: value })),
      ...(domain.absent ? [combination] : []),
    ]);
  }
  return combinations;
}

/** The closed inputs a variant was selected with, present or absent. */
type InputSelection = Pick<
  PipelinePackageStepVariant,
  'inputs' | 'absentInputs'
>;

function stepVariant(
  provider: PipelinePackageProvider,
  selection: InputSelection = {},
  unconfirmed = false,
): PipelinePackageStepVariant {
  return {
    provider,
    ...(selection.inputs ? { inputs: selection.inputs } : {}),
    ...(selection.absentInputs ? { absentInputs: selection.absentInputs } : {}),
    ...(unconfirmed ? { unconfirmed } : {}),
  };
}

/**
 * A step whose model could not be resolved keeps the Claude analysis it has
 * always had and is also analyzed for Codex, unconfirmed: Codex dependencies
 * that resolve are packaged, but a missing one does not block the share.
 */
function unresolvedModelVariants(
  selection?: InputSelection,
): PipelinePackageStepVariant[] {
  return [
    stepVariant('claude', selection),
    stepVariant('codex', selection, true),
  ];
}

/**
 * Resolve a `${{ }}` model to the provider of every value it can take, by
 * interpolating it exactly as a run would, once per combination of the inputs
 * it reads. A choice or boolean input is enumerated in full. Any other input
 * is analyzed with its default, and because a run can supply another value,
 * the provider its default doesn't select is added as unconfirmed.
 */
function resolveModelExpressionVariants(
  pipeline: Pipeline,
  model: string,
  domains: ReadonlyMap<string, InputDomain | undefined>,
): PipelinePackageStepVariant[] {
  const references = templateInputReferences(model);
  const names = references ? Array.from(references) : [];
  const combinations = references
    ? inputCombinations(names, domains)
    : undefined;
  if (!combinations) return unresolvedModelVariants();
  const closedNames = names.filter((name) => domains.get(name)?.closed);
  const variants = combinations.flatMap((combination) => {
    // Only a closed selection is substituted into the step's prompt; an open
    // input's default would hide text another value could produce.
    // An absent input is part of the selection too: the run leaves it out,
    // so its expressions render empty rather than as authored.
    const present = closedNames.filter((name) =>
      Object.prototype.hasOwnProperty.call(combination, name),
    );
    const absent = closedNames.filter((name) => !present.includes(name));
    const selection: InputSelection = {
      ...(present.length > 0
        ? {
            inputs: Object.fromEntries(
              present.map((name) => [name, combination[name] ?? null]),
            ),
          }
        : {}),
      ...(absent.length > 0 ? { absentInputs: absent } : {}),
    };
    let value: string;
    try {
      value = interpolateExpression(
        model,
        buildExpressionContext({ inputs: combination }),
      ).trim();
    } catch {
      return unresolvedModelVariants(selection);
    }
    // An empty model runs on the default model, as a step without one does.
    const provider = providerForConfiguredModel(
      pipeline,
      value || DEFAULT_CLAUDE_MODEL,
    );
    return provider
      ? [stepVariant(provider, selection)]
      : unresolvedModelVariants(selection);
  });
  if (closedNames.length === names.length) return variants;
  const covered = new Set(variants.map((variant) => variant.provider));
  return [
    ...variants,
    ...(['claude', 'codex'] as const)
      .filter((provider) => !covered.has(provider))
      .map((provider) => stepVariant(provider, {}, true)),
  ];
}

export function resolvePipelinePackageProviderByStep(
  pipeline: Pipeline,
): Record<string, PipelinePackageStepProviders> {
  const result: Record<string, PipelinePackageStepProviders> = {};
  let domains: Map<string, InputDomain | undefined> | undefined;
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const stepIds = assignStepIds(job.steps, jobId).map((step) => step.id);
    job.steps.forEach((step, index) => {
      const stepId = stepIds[index];
      if (!stepId) return;
      const configuredModel =
        typeof step.with?.model === 'string'
          ? step.with.model
          : DEFAULT_CLAUDE_MODEL;
      if (configuredModel.includes('${{')) {
        domains ??= pipelineInputDomains(pipeline);
        result[`${jobId}.${stepId}`] = resolveModelExpressionVariants(
          pipeline,
          configuredModel,
          domains,
        );
        return;
      }
      result[`${jobId}.${stepId}`] =
        providerForConfiguredModel(pipeline, configuredModel) ??
        unresolvedModelVariants();
    });
  }
  return result;
}

export async function capabilityInventoryEntryIdsByKey(
  pipeline: Pipeline,
  inventory: Awaited<
    ReturnType<typeof loadPipelinePackageInventorySources>
  >['inventory'],
): Promise<Record<string, string[]>> {
  const refs = [
    ...(pipeline.dependencies ?? []).flatMap((dependency) =>
      dependency.kind === 'skill' || dependency.kind === 'plugin'
        ? [dependency.ref]
        : [],
    ),
    ...collectPipelineCapabilityRefs(pipeline).map((capability) =>
      getPipelinePluginDefaultRef(capability.defaultRef),
    ),
  ];
  if (refs.length === 0) return {};
  const catalog = await loadShareablePluginCatalog();
  const result: Record<string, string[]> = {};
  for (const ref of refs) {
    const key = getShareablePluginRefKey(ref);
    const ids = new Set(result[key] ?? []);
    for (const providerType of ['claude', 'codex'] as const) {
      const match = matchShareablePluginRef(ref, catalog, { providerType });
      if (match.matchState !== 'matched') continue;
      for (const entry of inventory.entries) {
        if (
          entry.provider === providerType &&
          inventoryEnableRefsEqual(entry.enableRef, match.selection)
        ) {
          ids.add(entry.id);
        }
      }
    }
    result[key] = Array.from(ids);
  }
  return result;
}

function pruneAnalyses(): void {
  const now = Date.now();
  for (const [id, analysis] of Array.from(analyses.entries())) {
    if (Date.parse(analysis.summary.expiresAt) <= now) analyses.delete(id);
  }
  while (analyses.size > ANALYSIS_LIMIT) {
    const oldest = analyses.keys().next().value;
    if (!oldest) break;
    analyses.delete(oldest);
  }
}

function portableRepoRuntimeName(cwd: string): string {
  const sourceName = path.basename(cwd);
  const sanitized = sourceName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[. ]+$/, '');
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(
    sanitized,
  );
  if (sanitized === sourceName && !reserved && sanitized.length <= 255) {
    return sanitized;
  }
  const suffix = createHash('sha256')
    .update(sourceName)
    .digest('hex')
    .slice(0, 8);
  return `${sanitized.slice(0, 246) || 'repo'}-${suffix}`;
}

async function replaceDismissalsIfCurrent(
  storePath: string,
  scopeKey: string,
  requestToken: symbol,
  records: Parameters<typeof replacePipelinePackageDismissals>[2],
): Promise<'replaced' | 'refused' | 'superseded'> {
  const previous = dismissalWriteQueues.get(scopeKey) ?? Promise.resolve();
  const write = previous.then(async () => {
    if (activeAnalysisRequests.get(scopeKey) !== requestToken)
      return 'superseded' as const;
    return replacePipelinePackageDismissals(storePath, scopeKey, records);
  });
  const tail = write.then(
    () => undefined,
    () => undefined,
  );
  dismissalWriteQueues.set(scopeKey, tail);
  try {
    return await write;
  } finally {
    if (dismissalWriteQueues.get(scopeKey) === tail) {
      dismissalWriteQueues.delete(scopeKey);
    }
  }
}

/**
 * Saves a request's dismissals and returns the scope's current ones. When the
 * store refuses the save (a newer or unreadable file), the request's own
 * dismissals still apply to this analysis.
 */
async function resolveDismissedInvocations(
  storePath: string,
  scopeKey: string,
  requestToken: symbol,
  requested: Parameters<typeof replacePipelinePackageDismissals>[2] | undefined,
): Promise<Parameters<typeof replacePipelinePackageDismissals>[2]> {
  if (
    requested !== undefined &&
    (await replaceDismissalsIfCurrent(
      storePath,
      scopeKey,
      requestToken,
      requested,
    )) === 'refused'
  )
    return requested;
  return (await listPipelinePackageDismissals(storePath, scopeKey)).map(
    ({ provider, token }) => ({ provider, token }),
  );
}

async function buildRepoLocalInvocables(
  worktree: PackageWorktreeContext,
): Promise<RepoLocalInvocables> {
  const cwd = resolveWorktreeCwd(
    worktree.projectId,
    worktree.worktreeId,
    worktree.repoId,
  );
  const discovered = await discoverProjectInvocableSources(cwd);
  const sourceLabel = path.basename(cwd);
  const rootName = portableRepoRuntimeName(cwd);
  const entries = discovered.entries.map((source) => {
    const kind =
      source.kind === 'command'
        ? ('plugin_command' as const)
        : ('standalone_skill' as const);
    const invocationKey = `/${source.name}`;
    return {
      id: `repo:claude:${kind}:${source.name}`,
      provider: 'claude' as const,
      kind,
      invocationKey,
      displayName: invocationKey,
      sourceLabel,
    };
  });
  return {
    index: { entries, scannedDirectories: discovered.scannedDirectories },
    sources: Object.fromEntries(
      entries.map((entry, index) => {
        const source = discovered.entries[index];
        if (!source) throw new Error('Missing repo-local invocable source');
        return [
          entry.id,
          source.kind === 'command'
            ? {
                sourceRoot: path.join(cwd, '.claude'),
                memberPath: path.relative(
                  path.join(cwd, '.claude'),
                  source.absolutePath,
                ),
                exportRoot: path.join(cwd, '.claude', 'commands'),
                sourceVisibility: 'local' as const,
                runtimeKind: 'plugin_fragment' as const,
                rootName,
                syntheticManifestName: rootName,
              }
            : {
                sourceRoot: source.absolutePath,
                memberPath: '.',
                sourceVisibility: 'local' as const,
                runtimeKind: 'standalone_skill' as const,
                rootName: source.name,
              },
        ];
      }),
    ),
  };
}

async function firstExistingPath(
  candidates: string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the same ordered roots used by the executor.
    }
  }
  return undefined;
}

export interface PortablePipelineDiscovery {
  resources: CapabilityPackagePortableResourceInput[];
  requests: CapabilityPackageRequest[];
  promptSources: CapabilityPackagePromptSource[];
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
  capabilityInventoryEntryIdsByKey: Record<string, string[]>;
  /** Child refs that can't be resolved before a run, not dismissed. */
  blockers: PipelinePackageAnalysisBlocker[];
  /** Child ref dismissals that matched a ref, so the child was left out. */
  dismissedReferences: PipelinePackageReferenceDismissal[];
  /** Authored refs of packaged children that declare their own `assets`. */
  childrenWithAssets: string[];
}

/**
 * A shared or packaged pipeline that declares `workflow` can't leave this
 * machine yet (CAN-5782); web never parses packaged pipelines, so the share
 * is blocked here.
 */
function localOnlyTriggerBlocker(
  subject: string,
): PipelinePackageAnalysisBlocker {
  return {
    code: 'LOCAL_ONLY_PIPELINE_TRIGGER',
    subject,
    message: LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
    occurrences: [],
  };
}

function emptyPortablePipelineDiscovery(): PortablePipelineDiscovery {
  return {
    resources: [],
    requests: [],
    promptSources: [],
    environmentRequirements: [],
    capabilityInventoryEntryIdsByKey: {},
    blockers: [],
    dismissedReferences: [],
    childrenWithAssets: [],
  };
}

/**
 * Only a pipeline that gets a local id on install resolves `assets` (v1), so
 * a packaged child that declares them can't be shared with its parent.
 */
function childAssetsBlockers(
  childRefs: readonly string[],
): PipelinePackageAnalysisBlocker[] {
  return Array.from(new Set(childRefs)).map((ref) => ({
    code: 'ASSETS_ON_PACKAGED_CHILD',
    subject: ref,
    message: `Child pipeline ${ref} declares assets. Declare them on the pipeline the share starts from instead.`,
    occurrences: [],
  }));
}

function declaresAssets(pipeline: Pipeline): boolean {
  return Array.isArray(pipeline.assets) && pipeline.assets.length > 0;
}

type PipelineEnv = Pipeline['env'];

/** What a `builtin/run-pipeline` step's `with.pipeline` resolves to before a run. */
function childPipelineRefResolution(
  step: { env?: PipelineEnv; with?: Record<string, unknown> },
  pipelineEnv: PipelineEnv,
  jobEnv: PipelineEnv,
): ChildPipelineRefResolution | undefined {
  const childRefValue = step.with?.pipeline;
  if (typeof childRefValue !== 'string' || !childRefValue.trim())
    return undefined;
  return resolveChildPipelineRef({
    ref: childRefValue,
    pipelineEnv,
    jobEnv,
    stepEnv: step.env,
  });
}

function unresolvedChildPipelineRefMessage(
  location: string,
  raw: string,
): string {
  return `Step ${location} picks its child pipeline with ${raw}, which is only known when the pipeline runs, so the child can't be shared with it. Define the pipeline ID as a literal in \`env\` and reference it as \`\${{ env.NAME }}\`, or dismiss this to share without the child.`;
}

/**
 * A user pipeline the store resolves `ref` to, as a run resolves a child by
 * id before any file root. Only a file named for one of the candidate refs
 * is returned: the packaged child is found again by that name at run time.
 */
function storedUserChildPipelinePath(
  ref: string,
  candidateRefs: readonly string[],
): string | undefined {
  const stored = getStoredPipelinePathWithSource(ref);
  if (!stored.success || !stored.data || stored.data.source !== 'user')
    return undefined;
  return candidateRefs.includes(path.basename(stored.data.filePath))
    ? stored.data.filePath
    : undefined;
}

export async function buildPortablePipelineResources(input: {
  pipeline: Pipeline;
  inventory: Awaited<
    ReturnType<typeof loadPipelinePackageInventorySources>
  >['inventory'];
  pipelineFileDir?: string;
  repoPath?: string;
  bindingKey?: string;
  /** Env a parent run passes down to this (child) pipeline. */
  inheritedEnv?: Record<string, string>;
  dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
  visited?: Set<string>;
}): Promise<PortablePipelineDiscovery> {
  const discovered = emptyPortablePipelineDiscovery();
  const visited = input.visited ?? new Set<string>();
  const pipelineEnv = cascadeEnv(input.inheritedEnv, input.pipeline.env);
  for (const [jobId, job] of Object.entries(input.pipeline.jobs)) {
    const steps = assignStepIds(job.steps, jobId);
    for (const step of steps) {
      const bindingKey =
        input.bindingKey ?? capabilityPackageStepBindingKey(jobId, step.id);
      if (step.uses?.startsWith('project/')) {
        const actionRef = step.uses;
        const relativeAction = actionRef.slice('project/'.length);
        const roots = input.repoPath
          ? getProjectActionsDirCandidates(input.repoPath)
          : [];
        const safeRelativeAction = isSafeCapabilityRelativePath(relativeAction);
        const actionDir = safeRelativeAction
          ? await firstExistingPath(
              roots.map((root) =>
                path.resolve(root, relativeAction, 'action.yml'),
              ),
            )
          : undefined;
        if (!actionDir) continue;
        const sourceRoot = path.dirname(actionDir);
        discovered.resources.push({
          kind: 'pipeline_action',
          displayName: actionRef,
          invocationKeys: [actionRef],
          bindingKey,
          descriptor: {
            sourceRoot,
            memberPath: '.',
            sourceVisibility: 'local',
            runtimeKind: 'standalone_skill',
            rootName: path.basename(sourceRoot),
          },
        });
      }
      if (step.uses !== 'builtin/run-pipeline') continue;
      const resolution = childPipelineRefResolution(step, pipelineEnv, job.env);
      if (!resolution) continue;
      const [parentJobId, parentStepId] = bindingKey.split('\0');
      if (resolution.kind === 'unresolved') {
        const dismissal = input.dismissedReferences?.find(
          (candidate) =>
            candidate.kind === 'child_pipeline_ref' &&
            candidate.token === resolution.raw,
        );
        if (dismissal) {
          discovered.dismissedReferences.push(dismissal);
          continue;
        }
        discovered.blockers.push({
          code: 'UNRESOLVED_CHILD_PIPELINE_REF',
          subject: resolution.raw,
          origin: input.bindingKey ? 'transitive' : 'direct',
          message: unresolvedChildPipelineRefMessage(
            `${jobId}.${step.id}`,
            resolution.raw,
          ),
          ...(parentJobId && parentStepId
            ? { jobId: parentJobId, stepId: parentStepId }
            : {}),
          occurrences: [],
          referenceDismissal: {
            kind: 'child_pipeline_ref',
            token: resolution.raw,
          },
        });
        continue;
      }
      // The display name stays the authored ref; the share UI and save-time
      // repackaging match on it. A run looks the child up by the value it
      // interpolates.
      const displayName = resolution.raw;
      const childRef =
        resolution.kind === 'resolved' ? resolution.evaluated : resolution.raw;
      if (path.isAbsolute(childRef) || !isSafeCapabilityRelativePath(childRef))
        continue;
      const candidateRefs = path.extname(childRef)
        ? [childRef]
        : [childRef, `${childRef}.yaml`, `${childRef}.yml`];
      const roots = [
        ...(input.pipelineFileDir ? [input.pipelineFileDir] : []),
        ...(input.repoPath
          ? [
              ...getProjectPipelinesDirCandidates(input.repoPath),
              input.repoPath,
            ]
          : []),
      ];
      const storedChildPath = storedUserChildPipelinePath(
        childRef,
        candidateRefs,
      );
      const childPath =
        storedChildPath ??
        (await firstExistingPath(
          roots.flatMap((root) =>
            candidateRefs.map((candidate) => path.resolve(root, candidate)),
          ),
        ));
      const sourceRoot = storedChildPath
        ? path.dirname(storedChildPath)
        : childPath
          ? roots.find((root) => {
              const relative = path.relative(root, childPath);
              return !relative.startsWith('..') && !path.isAbsolute(relative);
            })
          : roots[0];
      if (!sourceRoot) continue;
      const memberPath = childPath
        ? path.relative(sourceRoot, childPath)
        : childRef;
      discovered.resources.push({
        kind: 'child_pipeline',
        displayName,
        invocationKeys: [displayName, childRef],
        bindingKey,
        descriptor: {
          sourceRoot,
          memberPath,
          exportRoot: sourceRoot,
          sourceVisibility: 'local',
          runtimeKind: 'plugin_fragment',
          rootName: `pipelines-${createHash('sha256')
            .update(sourceRoot)
            .digest('hex')
            .slice(0, 8)}`,
        },
      });
      if (!childPath || visited.has(childPath)) continue;
      visited.add(childPath);
      try {
        const childPipeline = parsePipelineText(
          await readFile(childPath, 'utf8'),
        );
        // Web never parses a `child_pipeline` resource, so a child that
        // declares `workflow` would reach it unchecked (CAN-5782).
        if (pipelineDeclaresLocalOnlyTrigger(childPipeline)) {
          discovered.blockers.push({
            code: 'LOCAL_ONLY_PIPELINE_TRIGGER',
            subject: displayName,
            origin: input.bindingKey ? 'transitive' : 'direct',
            message: LOCAL_ONLY_PIPELINE_TRIGGER_MESSAGE,
            ...(parentJobId && parentStepId
              ? { jobId: parentJobId, stepId: parentStepId }
              : {}),
            occurrences: [],
          });
        }
        if (declaresAssets(childPipeline))
          discovered.childrenWithAssets.push(displayName);
        const providerByStep =
          resolvePipelinePackageProviderByStep(childPipeline);
        const sources = buildPipelineCapabilityPackageSources(
          childPipeline,
          providerByStep,
        );
        discovered.requests.push(
          ...sources.requests.map((request) => ({ ...request, bindingKey })),
        );
        if (parentJobId && parentStepId) {
          discovered.promptSources.push(
            ...sources.promptSources.map((source) => ({
              jobId: parentJobId,
              stepId: parentStepId,
              provider: source.provider,
              text: source.text,
              ...(source.unconfirmed ? { unconfirmed: true } : {}),
            })),
          );
          discovered.environmentRequirements.push(
            ...sources.environmentRequirements.map((requirement) => ({
              ...requirement,
              affectedSteps: [{ jobId: parentJobId, stepId: parentStepId }],
            })),
          );
        }
        Object.assign(
          discovered.capabilityInventoryEntryIdsByKey,
          await capabilityInventoryEntryIdsByKey(
            childPipeline,
            input.inventory,
          ),
        );
        // A child run starts from the env of the step that launched it.
        const nested = await buildPortablePipelineResources({
          pipeline: childPipeline,
          inventory: input.inventory,
          pipelineFileDir: path.dirname(childPath),
          repoPath: input.repoPath,
          bindingKey,
          inheritedEnv: cascadeEnv(pipelineEnv, job.env, step.env),
          dismissedReferences: input.dismissedReferences,
          visited,
        });
        discovered.resources.push(...nested.resources);
        discovered.requests.push(...nested.requests);
        discovered.promptSources.push(...nested.promptSources);
        discovered.environmentRequirements.push(
          ...nested.environmentRequirements,
        );
        Object.assign(
          discovered.capabilityInventoryEntryIdsByKey,
          nested.capabilityInventoryEntryIdsByKey,
        );
        discovered.blockers.push(...nested.blockers);
        discovered.dismissedReferences.push(...nested.dismissedReferences);
        discovered.childrenWithAssets.push(...nested.childrenWithAssets);
      } catch {
        // The normal analyzer reports the missing/invalid child resource.
      }
    }
  }
  return discovered;
}

/** Dismissals in first-seen order, one per kind and token. */
function uniqueReferenceDismissals(
  dismissals: readonly PipelinePackageReferenceDismissal[],
): PipelinePackageReferenceDismissal[] {
  const seen = new Set<string>();
  return dismissals.filter(({ kind, token }) => {
    const key = `${kind}\0${token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function analyzePackageRequest(
  input: PipelinePackageAnalyzeRequest,
  options: { persistDismissals?: boolean } = {},
): Promise<PipelinePackageAnalysisSummary> {
  pruneAnalyses();
  const source: PipelineShareSource | undefined =
    pipelineResourceContextEnabled()
      ? (input.sourcePipeline ??
        (input.pipelineId
          ? { kind: 'stored', id: input.pipelineId }
          : undefined))
      : undefined;
  if (source) {
    await assertPipelineShareSourceContext(source);
    input = { ...input, rawPipeline: await readPipelineShareSource(source) };
  }
  const pipeline = parsePipelineText(input.rawPipeline);
  if (input.worktree) {
    validateId(input.worktree.projectId, 'projectId');
    validateId(input.worktree.worktreeId, 'worktreeId');
    validateOptionalRepoId(input.worktree.repoId, 'repoId');
  }
  // Saved pipelines retain dismissals by id. Unsaved drafts use their content
  // hash, so editing the draft intentionally starts a fresh dismissal scope.
  const pipelineScopeKey =
    input.pipelineId ?? hashPipelinePackageYaml(input.rawPipeline);
  const scopeKey = input.worktree
    ? `worktree:${input.worktree.projectId}:${input.worktree.worktreeId}:${input.worktree.repoId ?? ''}:${pipelineScopeKey}`
    : pipelineScopeKey;
  const requestToken = Symbol(scopeKey);
  if (options.persistDismissals !== false)
    activeAnalysisRequests.set(scopeKey, requestToken);
  try {
    const { inventory, sources } = await loadPipelinePackageInventorySources();
    const repoLocal = input.worktree
      ? await buildRepoLocalInvocables(input.worktree)
      : undefined;
    const repoPath = input.worktree
      ? resolveWorktreeCwd(
          input.worktree.projectId,
          input.worktree.worktreeId,
          input.worktree.repoId,
        )
      : undefined;
    const storedPipelinePath = input.pipelineId
      ? localPipelineService.getPipelinePath(input.pipelineId)
      : undefined;
    const pipelineFileDir =
      storedPipelinePath?.success && storedPipelinePath.data
        ? path.dirname(storedPipelinePath.data)
        : undefined;
    const dismissedInvocations =
      options.persistDismissals === false &&
      input.dismissedInvocations !== undefined
        ? input.dismissedInvocations
        : await resolveDismissedInvocations(
            getPipelinePackageDismissalStorePath(),
            scopeKey,
            requestToken,
            input.dismissedInvocations,
          );
    const portable = await buildPortablePipelineResources({
      pipeline,
      inventory,
      pipelineFileDir,
      repoPath,
      dismissedReferences: input.dismissedReferences,
    });
    // The share dialog shows this during review, so nothing is uploaded for
    // a pipeline that declares `workflow` (CAN-5782).
    if (pipelineDeclaresLocalOnlyTrigger(pipeline))
      portable.blockers.push(localOnlyTriggerBlocker(pipeline.name));
    const rootInventoryEntryIds = await capabilityInventoryEntryIdsByKey(
      pipeline,
      inventory,
    );
    const analysis = await analyzePipelinePackage({
      rawPipeline: input.rawPipeline,
      pipeline,
      providerByStep: resolvePipelinePackageProviderByStep(pipeline),
      invocableInventory: inventory,
      capabilityInventoryEntryIdsByKey: {
        ...rootInventoryEntryIds,
        ...portable.capabilityInventoryEntryIdsByKey,
      },
      sourceByInventoryEntryId: sources,
      repoLocalInvocables: repoLocal?.index,
      sourceByRepoLocalEntryId: repoLocal?.sources,
      dismissedInvocations,
      portableResources: portable.resources,
      additionalRequests: portable.requests,
      additionalPromptSources: portable.promptSources,
      additionalEnvironmentRequirements: portable.environmentRequirements,
      hostBlockers: [
        ...portable.blockers,
        // Assets install into a pipeline's data dir, which only an automation
        // install sets up in v1.
        ...(declaresAssets(pipeline)
          ? [
              {
                code: 'ASSETS_REQUIRE_AUTOMATION_SHARE' as const,
                subject: pipeline.name,
                message:
                  'This pipeline declares assets, which only travel with an automation. Share the automation that runs this pipeline instead.',
                occurrences: [],
              },
            ]
          : []),
        ...childAssetsBlockers(portable.childrenWithAssets),
      ],
      dismissedReferences: uniqueReferenceDismissals(
        portable.dismissedReferences,
      ),
    });
    if (options.persistDismissals !== false)
      await replaceDismissalsIfCurrent(
        getPipelinePackageDismissalStorePath(),
        scopeKey,
        requestToken,
        analysis.summary.dismissedInvocations ?? [],
      );
    analyses.set(analysis.summary.analysisId, {
      ...analysis,
      ...(source ? { shareSource: source, shareBytes: input.rawPipeline } : {}),
    });
    pruneAnalyses();
    return analysis.summary;
  } finally {
    if (activeAnalysisRequests.get(scopeKey) === requestToken) {
      activeAnalysisRequests.delete(scopeKey);
    }
  }
}

export interface AnalyzeAutomationCapabilityPackageInput {
  rawContent: string;
  activityId?: string;
  selections: ChatTabPluginSelections;
  /**
   * The automation action's prompt. Scanned for invocation tokens exactly as a
   * pipeline step prompt is, so a `/skill` the author typed is packaged even
   * when it was never added to `selections`, and an unresolvable one blocks.
   * Also scanned for pipeline references; spans index into the canonical,
   * untrimmed prompt the shared document carries.
   */
  promptText?: string;
  worktree?: PackageWorktreeContext;
  pipelineContent?: string;
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
  /** The automation's stored `dependencies.pipelines` plus manual adds. */
  pipelineDependencies?: AutomationPipelineDependency[];
  /** Keys of the optional (name-matched) pipelines the author selected. */
  pipelineSelections?: string[];
  /** Share audience; Public shares can't carry file assets. */
  audience?: 'private' | 'team' | 'organization' | 'public';
  /** Reference blockers the author dismissed. */
  dismissedReferences?: PipelinePackageReferenceDismissal[];
  /** False when the server can't publish v5 documents: no pipelines travel. */
  packagePipelines?: boolean;
}

/**
 * Trusted host facts for an automation analysis. Main derives them; they are
 * never read from the renderer's request.
 */
export interface AnalyzeAutomationCapabilityPackageOptions {
  /**
   * The stored `worktree_pipeline` action's own pipeline, when it is a user
   * or project pipeline. Its YAML (`pipelineContent`) then travels as the
   * `action` packaged pipeline, with its children, actions and assets.
   */
  actionPipeline?: {
    source: AutomationPipelineSource;
    pipelineId: string;
    name?: string;
  };
  /** Home folder asset paths expand against; defaults to the user's. */
  homedir?: string;
}

function storedPipelineFilePath(pipelineId: string): string | undefined {
  const stored = localPipelineService.getPipelinePath(pipelineId);
  return stored.success ? stored.data : undefined;
}

/** A pipeline whose children, actions, skills and assets travel with it. */
interface PackagedPipelineSource extends PackagedAutomationPipeline {
  fileDir?: string;
}

export async function analyzeAutomationCapabilityPackage(
  input: AnalyzeAutomationCapabilityPackageInput,
  options: AnalyzeAutomationCapabilityPackageOptions = {},
): Promise<PipelinePackageAnalysisSummary> {
  pruneAnalyses();
  if (input.activityId !== undefined)
    validateId(input.activityId, 'activityId');
  if (input.worktree) {
    validateId(input.worktree.projectId, 'projectId');
    validateId(input.worktree.worktreeId, 'worktreeId');
    validateOptionalRepoId(input.worktree.repoId, 'repoId');
  }
  const automationScopeKey = input.activityId
    ? `automation:${input.activityId}`
    : hashPipelinePackageYaml(input.rawContent);
  const scopeKey = input.worktree
    ? `worktree:${input.worktree.projectId}:${input.worktree.worktreeId}:${input.worktree.repoId ?? ''}:${automationScopeKey}`
    : automationScopeKey;
  const requestToken = Symbol(scopeKey);
  activeAnalysisRequests.set(scopeKey, requestToken);
  try {
    const { inventory, sources } = await loadPipelinePackageInventorySources();
    const repoLocal = input.worktree
      ? await buildRepoLocalInvocables(input.worktree)
      : undefined;
    const repoPath = input.worktree
      ? resolveWorktreeCwd(
          input.worktree.projectId,
          input.worktree.worktreeId,
          input.worktree.repoId,
        )
      : undefined;
    const homedir = options.homedir ?? os.homedir();
    const effectiveSelections = await resolveEffectivePluginSelectionRefs(
      input.selections,
    );
    const inventoryEntryIdsByKey: Record<string, string[]> = {};
    const mergeInventoryEntryIds = (
      entryIds: Record<string, string[]>,
    ): void => {
      for (const [key, ids] of Object.entries(entryIds)) {
        inventoryEntryIdsByKey[key] = Array.from(
          new Set([...(inventoryEntryIdsByKey[key] ?? []), ...ids]),
        );
      }
    };
    const requestedKeys: string[] = [];
    for (const skill of effectiveSelections.skillRefs) {
      const key = `skill:${skill.sourceId}:${skill.skillName}`;
      requestedKeys.push(key);
      inventoryEntryIdsByKey[key] = inventory.entries
        .filter(
          (entry) =>
            entry.enableRef.kind === 'skill' &&
            entry.enableRef.sourceId === skill.sourceId &&
            entry.enableRef.skillName === skill.skillName,
        )
        .map((entry) => entry.id);
    }
    for (const plugin of effectiveSelections.pluginRefs) {
      const key = `plugin:${plugin.marketplaceId}:${plugin.pluginName}`;
      requestedKeys.push(key);
      inventoryEntryIdsByKey[key] = inventory.entries
        .filter(
          (entry) =>
            entry.enableRef.kind === 'plugin' &&
            entry.enableRef.marketplaceId === plugin.marketplaceId &&
            entry.enableRef.pluginName === plugin.pluginName,
        )
        .map((entry) => entry.id);
    }
    const requests: CapabilityPackageRequest[] = Array.from(
      new Set(requestedKeys),
    ).flatMap((key) =>
      (['claude', 'codex'] as const).map((provider) => ({
        key,
        provider,
        required: true,
        bindingKey: AUTOMATION_ACTION_BINDING_KEY,
      })),
    );
    const promptSources: CapabilityPackagePromptSource[] = [];
    const environmentRequirements: PipelinePackageEnvironmentRequirement[] = [];
    const portableResources: CapabilityPackagePortableResourceInput[] = [];
    const hostBlockers: PipelinePackageAnalysisBlocker[] = [];
    const childReferenceDismissals: PipelinePackageReferenceDismissal[] = [];
    // Without server support for v5 documents the share keeps its pre-v5
    // shape: no pipeline is detected or packaged, and the action pipeline
    // takes the inline path below.
    const packagePipelines = input.packagePipelines !== false;
    // The canonical prompt, untrimmed: pipeline reference spans index into the
    // exact string the shared document carries. A blank prompt is no source.
    const promptText =
      input.promptText === undefined
        ? undefined
        : canonicalizeSharedAutomationPrompt(input.promptText);
    if (promptText?.trim()) {
      promptSources.push({
        jobId: AUTOMATION_ACTION_BINDING_JOB_ID,
        stepId: AUTOMATION_ACTION_BINDING_STEP_ID,
        provider: 'claude',
        text: promptText,
        pipelineReferences: packagePipelines,
      });
    }
    const pipelineInventory = await buildAutomationPipelineInventory({
      repoPath,
    });
    const pipelineRequests = packagePipelines
      ? input.pipelineDependencies?.map(({ pipelineId, source }) => ({
          pipelineId,
          source,
        }))
      : undefined;
    const pipelineReferences = resolveAutomationPipelineReferences(
      {
        ...(promptText ? { promptText } : {}),
        inventory: pipelineInventory,
        ...(pipelineRequests ? { requests: pipelineRequests } : {}),
        ...(input.pipelineSelections
          ? { selections: input.pipelineSelections }
          : {}),
        ...(input.dismissedReferences
          ? { dismissedReferences: input.dismissedReferences }
          : {}),
      },
      {
        jobId: AUTOMATION_ACTION_BINDING_JOB_ID,
        stepId: AUTOMATION_ACTION_BINDING_STEP_ID,
      },
    );
    const automationPipelines: AutomationPipelinePortableInput[] = [];
    const packagedPipelines: PackagedPipelineSource[] = [];
    for (const resolved of packagePipelines
      ? pipelineReferences.pipelines
      : []) {
      let rawPipeline: string;
      try {
        rawPipeline = await readFile(resolved.path, 'utf8');
      } catch {
        // The analyzer reports a selected pipeline it gets no YAML for.
        continue;
      }
      automationPipelines.push({
        pipelineKey: resolved.key,
        name: resolved.name,
        source: resolved.source,
        rawContent: rawPipeline,
        bindingKey: AUTOMATION_ACTION_BINDING_KEY,
        sourcePath: resolved.path,
      });
      // Unselected suggestions only feed the summary.
      if (!resolved.selected) continue;
      try {
        const selected = parsePipelineText(rawPipeline);
        if (pipelineDeclaresLocalOnlyTrigger(selected))
          hostBlockers.push(localOnlyTriggerBlocker(resolved.name));
        packagedPipelines.push({
          key: resolved.key,
          name: resolved.name,
          pipeline: selected,
          fileDir: pipelineFileDir(resolved.path),
        });
      } catch (error) {
        hostBlockers.push({
          code: 'INVALID_PACKAGE',
          subject: resolved.name,
          message: `"${resolved.name}" could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          occurrences: [],
        });
      }
    }
    if (input.pipelineContent !== undefined) {
      const pipeline = parsePipelineText(input.pipelineContent);
      if (pipelineDeclaresLocalOnlyTrigger(pipeline))
        hostBlockers.push(localOnlyTriggerBlocker(pipeline.name));
      const actionPipeline = packagePipelines
        ? options.actionPipeline
        : undefined;
      if (actionPipeline) {
        // A user or project action pipeline travels as the `action` packaged
        // pipeline, so its children, actions and assets come along.
        const actionPath =
          actionPipeline.source === 'user'
            ? storedPipelineFilePath(actionPipeline.pipelineId)
            : pipelineInventory.find(
                (entry) =>
                  entry.source === 'project' &&
                  entry.pipelineId === actionPipeline.pipelineId,
              )?.path;
        const name =
          actionPipeline.name?.trim() || pipeline.name.trim() || 'Pipeline';
        automationPipelines.push({
          pipelineKey: AUTOMATION_ACTION_PIPELINE_KEY,
          name,
          source: actionPipeline.source,
          rawContent: input.pipelineContent,
          bindingKey: AUTOMATION_ACTION_BINDING_KEY,
          ...(actionPath ? { sourcePath: actionPath } : {}),
        });
        packagedPipelines.push({
          key: AUTOMATION_ACTION_PIPELINE_KEY,
          name,
          pipeline,
          fileDir: pipelineFileDir(actionPath),
        });
      } else {
        // Shared and other pipelines keep the inline handling: their skills
        // and plugins travel under their real step bindings.
        const pipelineSources = buildPipelineCapabilityPackageSources(
          pipeline,
          resolvePipelinePackageProviderByStep(pipeline),
        );
        requests.push(...pipelineSources.requests);
        promptSources.push(...pipelineSources.promptSources);
        environmentRequirements.push(
          ...pipelineSources.environmentRequirements,
        );
        mergeInventoryEntryIds(
          await capabilityInventoryEntryIdsByKey(pipeline, inventory),
        );
      }
    }
    const fileAssets: FileAssetPortableInput[] = [];
    const childrenWithAssets: string[] = [];
    for (const packaged of packagedPipelines) {
      // Each packaged pipeline keeps its own job/step bindings, as an inline
      // pipeline does; the `automation_pipeline` resource itself is bound to
      // the automation action.
      const pipelineSources = buildPipelineCapabilityPackageSources(
        packaged.pipeline,
        resolvePipelinePackageProviderByStep(packaged.pipeline),
      );
      requests.push(...pipelineSources.requests);
      promptSources.push(...pipelineSources.promptSources);
      // Declared `local_runtime` / `local_package` dependencies surface as
      // setup requirements, next to connectors and MCP servers.
      environmentRequirements.push(...pipelineSources.environmentRequirements);
      mergeInventoryEntryIds(
        await capabilityInventoryEntryIdsByKey(packaged.pipeline, inventory),
      );
      const portable = await buildPortablePipelineResources({
        pipeline: packaged.pipeline,
        inventory,
        pipelineFileDir: packaged.fileDir,
        repoPath,
        dismissedReferences: input.dismissedReferences,
      });
      portableResources.push(
        ...portable.resources.map((resource) => ({
          ...resource,
          idScope: packaged.key,
        })),
      );
      requests.push(...portable.requests);
      promptSources.push(...portable.promptSources);
      environmentRequirements.push(...portable.environmentRequirements);
      mergeInventoryEntryIds(portable.capabilityInventoryEntryIdsByKey);
      hostBlockers.push(...portable.blockers);
      childReferenceDismissals.push(...portable.dismissedReferences);
      childrenWithAssets.push(...portable.childrenWithAssets);
      // Public shares carry no files, so their assets are never collected.
      if (input.audience === 'public') continue;
      const assets = packagedPipelineFileAssets(packaged, homedir);
      if (assets.ok) fileAssets.push(...assets.assets);
      else hostBlockers.push(assets.blocker);
    }
    hostBlockers.push(
      ...childAssetsBlockers(childrenWithAssets),
      ...publicAudienceAssetsBlockers(input.audience, packagedPipelines),
    );
    const dismissedInvocations = await resolveDismissedInvocations(
      getPipelinePackageDismissalStorePath(),
      scopeKey,
      requestToken,
      input.dismissedInvocations,
    );
    const analysis = await analyzeCapabilityPackage({
      // Pipeline-driving automations execute these exact bundled YAML bytes.
      // Keying the manifest to them lets the normal pipeline executor verify
      // and snapshot the package at run time. Prompt automations retain their
      // existing automation-document key.
      rawContent: input.pipelineContent ?? input.rawContent,
      invocableInventory: inventory,
      capabilityInventoryEntryIdsByKey: inventoryEntryIdsByKey,
      sourceByInventoryEntryId: sources,
      repoLocalInvocables: repoLocal?.index,
      sourceByRepoLocalEntryId: repoLocal?.sources,
      requests,
      promptSources,
      environmentRequirements,
      dismissedInvocations,
      portableResources,
      ...(packagePipelines
        ? {
            pipelineInventory,
            ...(pipelineRequests ? { pipelineRequests } : {}),
            ...(input.pipelineSelections
              ? { pipelineSelections: input.pipelineSelections }
              : {}),
            automationPipelines,
            fileAssets,
          }
        : {}),
      homedir,
      hostBlockers,
      dismissedReferences: uniqueReferenceDismissals([
        ...childReferenceDismissals,
        ...(input.dismissedReferences ?? []).filter(
          (dismissal) => dismissal.kind === 'pipeline_reference',
        ),
      ]),
    });
    await replaceDismissalsIfCurrent(
      getPipelinePackageDismissalStorePath(),
      scopeKey,
      requestToken,
      analysis.summary.dismissedInvocations ?? [],
    );
    analyses.set(analysis.summary.analysisId, analysis);
    pruneAnalyses();
    const unpackageableSelectionLabels = Array.from(
      new Set([
        ...effectiveSelections.mcpServerRefs.map((server) => server.serverId),
        ...effectiveSelections.warnings,
      ]),
    );
    return {
      ...analysis.summary,
      ...(unpackageableSelectionLabels.length > 0
        ? { unpackageableSelectionLabels }
        : {}),
    };
  } finally {
    if (activeAnalysisRequests.get(scopeKey) === requestToken) {
      activeAnalysisRequests.delete(scopeKey);
    }
  }
}

export interface AnalyzeSubjectCapabilityPackageInput {
  rawContent: string;
  scopeKey: string;
  selections: ChatTabPluginSelections;
  promptTexts?: string[];
  environmentRequirements?: PipelinePackageEnvironmentRequirement[];
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
  /** Reference review discovers setup requirements but never packages files. */
  mode?: 'package' | 'reference';
}

/** Analyze a step-less Agent, Collection or Blueprint through the shared package engine. */
export async function analyzeSubjectCapabilityPackage(
  input: AnalyzeSubjectCapabilityPackageInput,
): Promise<PipelinePackageAnalysisSummary> {
  pruneAnalyses();
  const requestToken = Symbol(input.scopeKey);
  activeAnalysisRequests.set(input.scopeKey, requestToken);
  try {
    const { inventory, sources } = await loadPipelinePackageInventorySources();
    const effectiveSelections = await resolveEffectivePluginSelectionRefs(
      input.selections,
    );
    const capabilityInventoryEntryIdsByKey: Record<string, string[]> = {};
    const requestedKeys: string[] = [];
    for (const skill of effectiveSelections.skillRefs) {
      const key = `skill:${skill.sourceId}:${skill.skillName}`;
      requestedKeys.push(key);
      capabilityInventoryEntryIdsByKey[key] = inventory.entries
        .filter(
          (entry) =>
            entry.enableRef.kind === 'skill' &&
            entry.enableRef.sourceId === skill.sourceId &&
            entry.enableRef.skillName === skill.skillName,
        )
        .map((entry) => entry.id);
    }
    for (const plugin of effectiveSelections.pluginRefs) {
      const key = `plugin:${plugin.marketplaceId}:${plugin.pluginName}`;
      requestedKeys.push(key);
      capabilityInventoryEntryIdsByKey[key] = inventory.entries
        .filter(
          (entry) =>
            entry.enableRef.kind === 'plugin' &&
            entry.enableRef.marketplaceId === plugin.marketplaceId &&
            entry.enableRef.pluginName === plugin.pluginName,
        )
        .map((entry) => entry.id);
    }
    const dismissedInvocations = await resolveDismissedInvocations(
      getPipelinePackageDismissalStorePath(),
      input.scopeKey,
      requestToken,
      input.dismissedInvocations,
    );
    const analysis = await analyzeCapabilityPackage({
      rawContent: input.rawContent,
      invocableInventory: inventory,
      capabilityInventoryEntryIdsByKey,
      sourceByInventoryEntryId: sources,
      requests: Array.from(new Set(requestedKeys)).flatMap((key) =>
        (['claude', 'codex'] as const).map((provider) => ({
          key,
          provider,
          required: true,
          bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
        })),
      ),
      promptSources: (input.promptTexts ?? [])
        .filter((text) => text.trim().length > 0)
        .map((text) => ({
          target: 'subject' as const,
          provider: 'claude' as const,
          text,
        })),
      environmentRequirements: [
        ...(input.environmentRequirements ?? []),
        ...(await Promise.all(
          effectiveSelections.mcpServerRefs.map((server) =>
            mcpSelectionToEnvironmentRequirement(server),
          ),
        )),
      ],
      dismissedInvocations,
    });
    await replaceDismissalsIfCurrent(
      getPipelinePackageDismissalStorePath(),
      input.scopeKey,
      requestToken,
      analysis.summary.dismissedInvocations ?? [],
    );
    analyses.set(analysis.summary.analysisId, analysis);
    const summary: PipelinePackageAnalysisSummary = {
      ...analysis.summary,
      ...(effectiveSelections.warnings.length > 0
        ? { unpackageableSelectionLabels: effectiveSelections.warnings }
        : {}),
    };
    if (input.mode !== 'reference') return summary;
    return {
      ...summary,
      state: 'ready',
      blockers: [],
      ...(summary.manifest
        ? {
            manifest: {
              ...summary.manifest,
              resources: [],
              bindings: [],
              totalFiles: 0,
              totalBytes: 0,
            },
          }
        : {}),
      ...(summary.package
        ? {
            package: {
              ...summary.package,
              resources: [],
              totalFiles: 0,
              totalBytes: 0,
            },
          }
        : {}),
    };
  } finally {
    if (activeAnalysisRequests.get(input.scopeKey) === requestToken) {
      activeAnalysisRequests.delete(input.scopeKey);
    }
  }
}

export interface AnalyzeSkillCapabilityPackageInput {
  /** Local skill source, e.g. `custom:app`. */
  sourceId: string;
  skillName: string;
  /** Exact SKILL.md bytes, the same ones the share hashes. */
  rawSkill: string;
  worktree?: PackageWorktreeContext;
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
}

/**
 * Analyze what travels with a shared skill.
 *
 * The skill being shared is itself a packaged resource: an inventory skill
 * entry already points at its whole folder, so the supporting files the share
 * modal could previously only *detect* are collected by the same code that
 * collects a pipeline's dependencies. Its SKILL.md body is a prompt source, so
 * a sibling skill or command it invokes is packaged transitively. Everything
 * binds to the subject rather than to a synthetic step, because a skill has no
 * steps.
 *
 * MCP and plugin names extracted from the body become environment
 * requirements: disclosed, never blocking, and never carrying configuration or
 * credentials.
 */
export async function analyzeSkillCapabilityPackage(
  input: AnalyzeSkillCapabilityPackageInput,
  options: { persistDismissals?: boolean } = {},
): Promise<PipelinePackageAnalysisSummary> {
  pruneAnalyses();
  if (input.worktree) {
    validateId(input.worktree.projectId, 'projectId');
    validateId(input.worktree.worktreeId, 'worktreeId');
    validateOptionalRepoId(input.worktree.repoId, 'repoId');
  }
  const skillScopeKey = `skill:${input.sourceId}:${input.skillName}`;
  const scopeKey = input.worktree
    ? `worktree:${input.worktree.projectId}:${input.worktree.worktreeId}:${input.worktree.repoId ?? ''}:${skillScopeKey}`
    : skillScopeKey;
  const requestToken = Symbol(scopeKey);
  if (options.persistDismissals !== false)
    activeAnalysisRequests.set(scopeKey, requestToken);
  try {
    const { inventory, sources } = await loadPipelinePackageInventorySources();
    const repoLocal = input.worktree
      ? await buildRepoLocalInvocables(input.worktree)
      : undefined;
    const capabilityInventoryEntryIdsByKey: Record<string, string[]> = {
      [skillScopeKey]: inventory.entries
        .filter(
          (entry) =>
            entry.enableRef.kind === 'skill' &&
            entry.enableRef.sourceId === input.sourceId &&
            entry.enableRef.skillName === input.skillName,
        )
        .map((entry) => entry.id),
    };
    const requests = (['claude', 'codex'] as const).map((provider) => ({
      key: skillScopeKey,
      provider,
      required: true,
      bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    }));
    const dismissedInvocations =
      options.persistDismissals === false &&
      input.dismissedInvocations !== undefined
        ? input.dismissedInvocations
        : await resolveDismissedInvocations(
            getPipelinePackageDismissalStorePath(),
            scopeKey,
            requestToken,
            input.dismissedInvocations,
          );
    const analysis = await analyzeCapabilityPackage({
      rawContent: input.rawSkill,
      invocableInventory: inventory,
      capabilityInventoryEntryIdsByKey,
      sourceByInventoryEntryId: sources,
      ...(repoLocal?.index ? { repoLocalInvocables: repoLocal.index } : {}),
      ...(repoLocal?.sources
        ? { sourceByRepoLocalEntryId: repoLocal.sources }
        : {}),
      requests,
      promptSources: [
        {
          target: 'subject',
          // Unprefixed tokens read as Claude; a `$`-prefixed one still
          // self-selects Codex, matching the per-step rule pipelines use.
          provider: 'claude',
          text: input.rawSkill,
        },
      ],
      environmentRequirements: skillEnvironmentRequirements(input.rawSkill),
      dismissedInvocations,
    });
    if (options.persistDismissals !== false)
      await replaceDismissalsIfCurrent(
        getPipelinePackageDismissalStorePath(),
        scopeKey,
        requestToken,
        analysis.summary.dismissedInvocations ?? [],
      );
    analyses.set(analysis.summary.analysisId, {
      ...analysis,
      skill: { sourceId: input.sourceId, skillName: input.skillName },
    });
    pruneAnalyses();
    return analysis.summary;
  } finally {
    if (activeAnalysisRequests.get(scopeKey) === requestToken) {
      activeAnalysisRequests.delete(scopeKey);
    }
  }
}

function skillEnvironmentRequirements(
  rawSkill: string,
): PipelinePackageEnvironmentRequirement[] {
  return skillDependenciesToEnvironmentRequirements(
    extractSkillDependencies(rawSkill, {
      builtinToolNamespaces: [BRAND.tools.namespace],
      frontmatter: parseFrontmatterAndBody(rawSkill).frontmatter,
    }),
  );
}

/** The skill a live skill analysis covered and the content hash it was made over. */
export interface SkillAnalysisSubject {
  sourceId: string;
  skillName: string;
  contentHash: string;
}

/**
 * What a live skill analysis covered, or null when it expired, never existed
 * or analysed a pipeline. A skill publish (CAN-6176) checks both against the
 * skill it publishes and its local file before committing: the caller chose
 * the skill and supplied the content separately, so an analysis of one skill's
 * folder must not vouch for another skill's bytes.
 */
export function skillAnalysisSubject(
  analysisId: string,
): SkillAnalysisSubject | null {
  pruneAnalyses();
  const analysis = analyses.get(analysisId);
  return analysis?.skill && Date.parse(analysis.summary.expiresAt) > Date.now()
    ? { ...analysis.skill, contentHash: analysis.summary.pipelineContentHash }
    : null;
}

export function cancelPackageAnalysis(analysisId: string): void {
  analyses.delete(analysisId);
}

export function selectPipelinePackageManifest(
  manifest: PipelinePackageManifestV1,
  selectedOptionalResourceIds: readonly string[],
  optionalBindings: readonly PipelinePackageBinding[] = [],
  publisherNoteSources?: PipelinePackageAnalysisInternal['publisherNoteSources'],
): PipelinePackageManifestV1 {
  const selectedOptional = new Set(selectedOptionalResourceIds);
  const included = new Set<string>();
  const pending = [
    ...manifest.bindings.flatMap((binding) => binding.resourceIds),
    ...selectedOptionalResourceIds,
  ];
  const resourcesById = new Map(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const addClosure = (ids: readonly string[], target: Set<string>): void => {
    const closurePending = [...ids];
    while (closurePending.length > 0) {
      const id = closurePending.pop();
      if (!id || target.has(id)) continue;
      const resource = resourcesById.get(id);
      if (!resource) continue;
      target.add(id);
      closurePending.push(...resource.dependencyResourceIds);
    }
  };
  addClosure(pending, included);
  const bindings = new Map<string, Set<string>>();
  for (const binding of manifest.bindings) {
    bindings.set(
      capabilityPackageBindingKey(binding),
      new Set(binding.resourceIds.filter((id) => included.has(id))),
    );
  }
  for (const binding of optionalBindings) {
    const selectedRoots = binding.resourceIds.filter((id) =>
      selectedOptional.has(id),
    );
    if (selectedRoots.length === 0) continue;
    const selectedClosure = new Set<string>();
    addClosure(selectedRoots, selectedClosure);
    const key = capabilityPackageBindingKey(binding);
    const resourceIds = bindings.get(key) ?? new Set<string>();
    for (const id of Array.from(selectedClosure)) resourceIds.add(id);
    bindings.set(key, resourceIds);
  }
  const resources = manifest.resources.filter((resource) =>
    included.has(resource.id),
  );
  const publisherNotes = manifest.publisherNotes?.filter((note) => {
    const source = publisherNoteSources?.[note.id];
    return (
      source === undefined ||
      source.direct ||
      source.resourceIds.some((resourceId) => included.has(resourceId))
    );
  });
  const selectedManifest: PipelinePackageManifestV1 = {
    ...manifest,
    resources,
    bindings: Array.from(bindings.entries()).map(([key, resourceIds]) =>
      capabilityPackageBindingFromKey(key, Array.from(resourceIds).sort()),
    ),
    totalFiles: resources.reduce(
      (sum, resource) =>
        sum +
        resource.trees.reduce(
          (treeSum, tree) => treeSum + tree.entries.length,
          0,
        ),
      0,
    ),
    totalBytes: resources.reduce(
      (sum, resource) =>
        sum +
        resource.trees.reduce(
          (treeSum, tree) =>
            treeSum +
            tree.entries.reduce((entrySum, entry) => entrySum + entry.size, 0),
          0,
        ),
      0,
    ),
  };
  if (publisherNotes && publisherNotes.length > 0) {
    selectedManifest.publisherNotes = publisherNotes;
  } else {
    delete selectedManifest.publisherNotes;
  }
  return selectedManifest;
}

/**
 * Whether a package request failure is transient: a network failure, timeout,
 * throttle, or server error. Refusals and validation failures never retry.
 */
function retryable(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    (error.code === 'network-error' ||
      (error.code === 'http-error' &&
        (error.status === 408 ||
          error.status === 429 ||
          (error.status !== undefined && error.status >= 500))))
  );
}

interface PackageAttempt {
  /** Epoch ms after which no further request or backoff may start. */
  readonly deadline: number;
  readonly credentialContext?: CanopyCloudCredentialContext;
  readonly getWindow?: () => BrowserWindow | null;
}

function packageDeadline(missingBlobCount: number, startedAt: number): number {
  return (
    startedAt +
    Math.min(
      PACKAGE_DEADLINE_BASE_MS +
        PACKAGE_DEADLINE_PER_BLOB_MS * missingBlobCount,
      PACKAGE_DEADLINE_MAX_MS,
    )
  );
}

function retryDelayMs(error: unknown, attempt: number): number {
  if (
    error instanceof CanopyCloudClientError &&
    error.retryAfterMs !== undefined
  ) {
    return Math.min(error.retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  return 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 75);
}

/** Sanitized diagnostics: no credentials, contents, or local paths. */
function logPackageRequestFailure(
  stage: ShareFailureStage,
  attempt: number,
  startedAt: number,
  error: unknown,
  willRetry: boolean,
): void {
  // Package prepare, upload and commit requests are themselves writes.
  const failure = shareFailureFromError(error, stage, { writeSent: true });
  logMainProcessInfo('[pipelines] Package request failed', {
    stage,
    attempt,
    durationMs: Date.now() - startedAt,
    willRetry,
    kind: failure.kind,
    commitState: failure.commitState,
    ...(failure.httpStatus !== undefined ? { status: failure.httpStatus } : {}),
    ...(failure.serverCode !== undefined ? { code: failure.serverCode } : {}),
    ...(failure.requestId !== undefined
      ? { requestId: failure.requestId }
      : {}),
  });
}

/**
 * Run one package request with bounded retries of transient failures,
 * honoring Retry-After (capped) and the attempt's overall deadline. Each
 * request's timeout is bounded by the remaining time. Exhausting the deadline
 * is a connection failure for the stage in progress; it never restarts.
 */
async function withRetry<T>(
  stage: ShareFailureStage,
  attempts: number,
  packageAttempt: PackageAttempt,
  task: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const remaining = packageAttempt.deadline - Date.now();
    if (remaining <= 0) {
      throw new ShareOperationError(
        'connection',
        PACKAGE_DEADLINE_MESSAGE,
        stage,
      );
    }
    const startedAt = Date.now();
    try {
      return await task(Math.min(PACKAGE_REQUEST_TIMEOUT_MS, remaining));
    } catch (error) {
      const delay = retryDelayMs(error, attempt);
      const willRetry =
        retryable(error) &&
        attempt < attempts &&
        Date.now() + delay < packageAttempt.deadline;
      logPackageRequestFailure(stage, attempt, startedAt, error, willRetry);
      if (!willRetry) {
        // Tag the original failure with its stage rather than replacing it,
        // so its request id, status and Retry-After still reach the dialog.
        throw new ShareStageError(stage, error);
      }
      emitProgress(packageAttempt.getWindow, { stage: 'Retrying upload…' });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function runBounded<T>(
  values: readonly T[],
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, values.length) },
      async () => {
        while (next < values.length) {
          const index = next;
          next += 1;
          const value = values[index];
          if (value !== undefined) await worker(value);
        }
      },
    ),
  );
}

async function commitAnalyzedCapabilityPackage(
  request: {
    analysisId: string;
    selectedOptionalResourceIds: string[];
  },
  getWindow?: () => BrowserWindow | null,
  beforeCommit?: () => Promise<void>,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<{ uploadId: string; packageRef: PipelinePackageRef }> {
  pruneAnalyses();
  const analysis = analyses.get(request.analysisId);
  if (!analysis || Date.parse(analysis.summary.expiresAt) <= Date.now()) {
    throw new ShareOperationError(
      'dependency-review',
      'Dependency analysis expired. Run the analysis again.',
      'prepare',
    );
  }
  // This state check is load-bearing even though blocked analyses now retain
  // a partial manifest for publisher review.
  if (analysis.summary.state !== 'ready' || !analysis.summary.manifest) {
    throw new ShareOperationError(
      'dependency-review',
      'Dependencies are not ready to package. Resolve the listed problems first.',
      'prepare',
    );
  }
  if (await pipelinePackageAnalysisIsStale(analysis)) {
    analyses.delete(request.analysisId);
    throw new ShareOperationError(
      'dependency-review',
      'Dependency files changed since analysis. Review the updated dependency list before sharing.',
      'prepare',
    );
  }
  const manifest = selectPipelinePackageManifest(
    analysis.summary.manifest,
    request.selectedOptionalResourceIds,
    analysis.optionalBindings,
    analysis.publisherNoteSources,
  );
  return commitCapabilityPackageUpload(
    manifest,
    (sha256) => {
      const bytes = analysis.blobs.get(sha256);
      if (!bytes) throw new Error(`Analyzed package blob ${sha256} is missing`);
      return bytes;
    },
    getWindow,
    beforeCommit,
    credentialContext,
  );
}

export async function commitCapabilityPackageUpload(
  manifest: PipelinePackageManifestV1,
  readBlob: (sha256: string) => Uint8Array | Promise<Uint8Array>,
  getWindow?: () => BrowserWindow | null,
  beforeCommit?: () => Promise<void>,
  /** The publishing account's context; resolved here when absent. */
  givenCredentialContext?: CanopyCloudCredentialContext,
): Promise<{ uploadId: string; packageRef: PipelinePackageRef }> {
  const startedAt = Date.now();
  emitProgress(getWindow, { stage: 'Preparing files…' });
  // One credential context for every package request (prepare, blobs,
  // commit), so an account switch mid-upload cannot split the package across
  // accounts. The publication that follows resolves its own credentials; the
  // server only attaches an upload owned by the publishing account. When the
  // context can't be resolved here, each request resolves (and fails) on its
  // own.
  const credentialContext =
    givenCredentialContext ??
    (await resolveCanopyCloudCredentialContext().catch(() => undefined));
  const digest = computePipelinePackageDigestSync(manifest);
  // The deadline scales with the blob count, which is unknown until the
  // upload is prepared; preparation runs under the base allowance.
  const prepareAttempt: PackageAttempt = {
    deadline: packageDeadline(0, startedAt),
    getWindow,
    ...(credentialContext ? { credentialContext } : {}),
  };
  const upload = await withShareStage('prepare', () =>
    withRetry('prepare', PREPARE_ATTEMPTS, prepareAttempt, (timeoutMs) =>
      preparePipelinePackageUpload(
        { manifest, expectedDigest: digest },
        { timeoutMs, credentialContext },
      ),
    ),
  );
  const packageAttempt: PackageAttempt = {
    ...prepareAttempt,
    deadline: packageDeadline(upload.missingBlobs.length, startedAt),
  };
  const total = upload.missingBlobs.length;
  if (total > 0) {
    let completed = 0;
    emitProgress(getWindow, { stage: 'Uploading files…', completed, total });
    await withShareStage('upload', () =>
      runBounded(upload.missingBlobs, async (sha256) => {
        const bytes = await readBlob(sha256);
        await withRetry('upload', RETRY_ATTEMPTS, packageAttempt, (timeoutMs) =>
          uploadPipelinePackageBlob(upload.uploadId, sha256, bytes, {
            timeoutMs,
            credentialContext,
          }),
        );
        completed += 1;
        emitProgress(getWindow, {
          stage: 'Uploading files…',
          completed,
          total,
        });
      }),
    );
  }
  if (beforeCommit) await withShareStage('access', beforeCommit);
  emitProgress(getWindow, { stage: 'Finishing upload…' });
  const committed = await withShareStage('commit', () =>
    withRetry('commit', COMMIT_ATTEMPTS, packageAttempt, (timeoutMs) =>
      commitPipelinePackageUpload(upload.uploadId, {
        timeoutMs,
        credentialContext,
      }),
    ),
  );
  return {
    uploadId: committed.uploadId,
    packageRef: { version: 1, digest: committed.digest },
  };
}

/**
 * Every resource with files is reachable from a binding: bound directly, or
 * a dependency of a reachable resource (a `file_asset` is listed by its
 * `automation_pipeline` resource, never bound itself).
 */
function automationPackageHasValidBindings(
  manifest: PipelinePackageManifestV1,
): boolean {
  const resourcesById = new Map(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const reachable = new Set<string>();
  const pending = manifest.bindings.flatMap((binding) => binding.resourceIds);
  for (let index = 0; index < pending.length; index += 1) {
    const resourceId = pending[index];
    if (resourceId === undefined || reachable.has(resourceId)) continue;
    reachable.add(resourceId);
    pending.push(
      ...(resourcesById.get(resourceId)?.dependencyResourceIds ?? []),
    );
  }
  return manifest.resources.every(
    (resource) => resource.trees.length === 0 || reachable.has(resource.id),
  );
}

function assertAutomationPackageHasValidBindings(
  manifest: PipelinePackageManifestV1,
): void {
  if (!automationPackageHasValidBindings(manifest)) {
    throw new Error(
      'The automation capability package contains an unbound resource.',
    );
  }
}

async function commitInstalledAutomationCapabilityPackage(
  request: {
    localAutomationId: string;
    packageRef: PipelinePackageRef;
    expectedPackageContentHash?: string | null;
  },
  getWindow?: () => BrowserWindow | null,
): Promise<{ uploadId: string; packageRef: PipelinePackageRef }> {
  const install = await findCapabilityPackageInstallByOwner(
    getPipelinePackageInstallStorePath(),
    { kind: 'automation', localAutomationId: request.localAutomationId },
  );
  if (
    !install ||
    install.distributionMode === 'definition_only' ||
    install.packageDigest !== request.packageRef.digest
  ) {
    throw new ShareOperationError(
      'unavailable',
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  if (
    request.expectedPackageContentHash !== undefined &&
    request.expectedPackageContentHash !==
      (install.localContentHash ?? install.pipelineContentHash)
  ) {
    throw new ShareOperationError(
      'unavailable',
      'The automation changed since this capability package was installed. Reinstall the automation or share without local skills and plugins.',
    );
  }
  const packagePath = packagePathForDigest(install.packageDigest);
  const manifest = await verifyCachedPipelinePackage(
    packagePath,
    install.packageDigest,
  );
  if (
    !manifest ||
    manifest.pipelineContentHash !== install.pipelineContentHash
  ) {
    throw new ShareOperationError(
      'unavailable',
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  // Packaged pipelines and files install only through the `packaged` refs of
  // the document they came with. A re-share rebuilds the document without
  // them, so its recipients would never install them.
  if (
    manifest.resources.some(
      (resource) =>
        resource.kind === 'automation_pipeline' ||
        resource.kind === 'file_asset',
    )
  ) {
    throw new ShareOperationError(
      'unavailable',
      AUTOMATION_SHARE_BLOCK_MESSAGES.installed_pipeline_dependencies,
    );
  }
  assertAutomationPackageHasValidBindings(manifest);
  return commitCapabilityPackageUpload(
    manifest,
    (sha256) => readFile(path.join(packagePath, 'blobs', sha256)),
    getWindow,
  );
}

export async function createPackagedSharedPipeline(
  request: PipelinePackageCreateSharedRequest,
  getWindow?: () => BrowserWindow | null,
): Promise<SharedPipelineDetail> {
  const scoped = pipelineResourceContextEnabled();
  const source: PipelineShareSource | undefined = scoped
    ? (request.sourcePipeline ??
      (request.sourcePipelineId
        ? { kind: 'stored', id: request.sourcePipelineId }
        : undefined))
    : undefined;
  const analysis = analyses.get(request.analysisId);
  if (scoped && (source || analysis?.shareSource)) {
    if (
      !source ||
      !analysis?.shareSource ||
      !isDeepStrictEqual(source, analysis.shareSource) ||
      analysis.shareBytes === undefined
    )
      throw new Error('Workflow unavailable (unknown-provenance)');
    await withShareStage('access', () =>
      assertPipelineShareSourceContext(source),
    );
  }
  const rawPipeline = source ? analysis?.shareBytes : request.rawPipeline;
  if (rawPipeline === undefined)
    throw new Error('Workflow unavailable (unknown-provenance)');
  // Refused before anything is uploaded, not at publication.
  refuseLocalOnlyTrigger(rawPipeline);
  const authorize = async (): Promise<void> => {
    if (source)
      await authorizeSharedPipelineCreate(
        request,
        (): Promise<string> => Promise.resolve(rawPipeline),
      );
    else await authorizeSharedPipelineCreate(request);
  };
  if (scoped) await withShareStage('access', authorize);
  const committed = await commitAnalyzedCapabilityPackage(
    request,
    getWindow,
    scoped ? authorize : undefined,
  );
  emitProgress(getWindow, { stage: 'Publishing pipeline…' });
  const publication: Parameters<typeof createSharedPipeline>[0] = {
    rawPipeline,
    sourcePipelineId: request.sourcePipelineId,
    ...(source ? { sourcePipeline: source } : {}),
    shareScope: request.shareScope,
    teamId: request.teamId,
    organizationId: request.organizationId,
    distributionMode: 'package',
    committedPackageUploadId: committed.uploadId,
  };
  const created = request.remoteId
    ? await updateSharedPipeline(request.remoteId, rawPipeline, {
        expectedContentHash: request.expectedContentHash,
        shareScope: request.shareScope,
        teamId: request.teamId,
        organizationId: request.organizationId,
        distributionMode: 'package',
        committedPackageUploadId: committed.uploadId,
        revokePublicShare: request.revokePublicShare,
      })
    : await (source
        ? createSharedPipeline(publication, () => Promise.resolve(rawPipeline))
        : createSharedPipeline(publication));
  analyses.delete(request.analysisId);
  return created;
}

export const SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE =
  'This workflow is shared with its dependencies, and this edit changes what would be packaged. Open Share to review the dependencies and re-share it; the edit was not saved.';

function hasUnresolvedPortableResourceReference(
  rawPipeline: string,
  manifest: PipelinePackageManifestV1,
): boolean {
  const pipeline = parsePipelineText(rawPipeline);
  return Object.entries(pipeline.jobs).some(([jobId, job]) =>
    assignStepIds(job.steps, jobId).some((step) => {
      if (step.uses?.startsWith('project/')) {
        return !manifest.resources.some(
          (resource) =>
            resource.kind === 'pipeline_action' &&
            resource.displayName === step.uses,
        );
      }
      if (step.uses !== 'builtin/run-pipeline') return false;
      const resolution = childPipelineRefResolution(
        step,
        pipeline.env,
        job.env,
      );
      if (!resolution) return false;
      // A ref only a run can resolve has nothing to bind to.
      if (resolution.kind === 'unresolved') return true;
      const childRef =
        resolution.kind === 'resolved' ? resolution.evaluated : resolution.raw;
      return !manifest.resources.some(
        (resource) =>
          resource.kind === 'child_pipeline' &&
          resource.displayName === resolution.raw &&
          resource.invocationKeys.includes(childRef),
      );
    }),
  );
}

/**
 * Saves new YAML to a shared pipeline without demoting a `package` share.
 *
 * The server detaches the package on any YAML update that does not carry a
 * new one, because the package pins the previous content hash. Every in-place
 * save (pipeline editor, app actions, MCP) goes through here, so a package
 * share is re-analyzed and re-uploaded with its edit instead of silently
 * becoming `definition_only`, which the Run dialog would then refuse.
 *
 * The author consented to the previous package only. A save that needs a
 * fresh review — unresolved blockers, or a private or local resource the
 * previous package did not already carry — is refused rather than
 * downgraded, and points them at the Share dialog. Optional resources the
 * previous package included stay included.
 */
export async function updateSharedPipelinePreservingPackage(
  remoteId: string,
  rawPipeline: string,
  current?: SharedPipelineDetail,
  options: Parameters<typeof updateSharedPipeline>[2] = {},
): Promise<SharedPipelineDetail> {
  refuseLocalOnlyTrigger(rawPipeline);
  const scoped = pipelineResourceContextEnabled();
  const contextSnapshot = scoped ? await pipelineContextSnapshot() : undefined;
  const currentDetail = current ?? (await getSharedPipeline(remoteId));
  if (currentDetail.distributionMode !== 'package') {
    return Object.values(options).some((value) => value !== undefined)
      ? updateSharedPipeline(remoteId, rawPipeline, options)
      : updateSharedPipeline(remoteId, rawPipeline);
  }
  if (contextSnapshot !== undefined) {
    await assertPipelineContext({ owner: currentDetail.owner });
    await assertPipelineContextSnapshot(contextSnapshot);
  }
  const authorize = async (): Promise<void> => {
    if (contextSnapshot === undefined) return;
    await getSharedPipeline(remoteId);
    await assertPipelineContextSnapshot(contextSnapshot);
  };
  const summary = await analyzePackageRequest({ rawPipeline });
  try {
    const analysis = analyses.get(summary.analysisId);
    if (
      !analysis ||
      summary.state !== 'ready' ||
      !summary.manifest ||
      summary.blockers.length > 0
    ) {
      throw new Error(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
    }
    if (hasUnresolvedPortableResourceReference(rawPipeline, summary.manifest)) {
      throw new Error(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
    }
    // The server summary lists provider twins (one skill folder packaged for
    // Claude and Codex) as a single row named by its lead, so a twin of a
    // previously carried resource counts as carried too.
    const summaryResourceIds = new Set(
      (currentDetail.package?.resources ?? []).map((resource) => resource.id),
    );
    const previousResourceIds = new Set(
      groupCapabilityPackageProviderTwins(summary.manifest.resources)
        .filter((group) =>
          group.some((resource) => summaryResourceIds.has(resource.id)),
        )
        .flatMap((group) => group.map((resource) => resource.id)),
    );
    const selectedOptionalResourceIds = analysis.optionalBindings
      .flatMap((binding) => binding.resourceIds)
      .filter((id) => previousResourceIds.has(id));
    const included = selectPipelinePackageManifest(
      summary.manifest,
      selectedOptionalResourceIds,
      analysis.optionalBindings,
      analysis.publisherNoteSources,
    ).resources;
    const needsConsent = included.some(
      (resource) =>
        (resource.sourceVisibility === 'private' ||
          resource.sourceVisibility === 'local') &&
        !previousResourceIds.has(resource.id),
    );
    if (needsConsent) throw new Error(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
    const committed = await commitAnalyzedCapabilityPackage(
      {
        analysisId: summary.analysisId,
        selectedOptionalResourceIds,
      },
      undefined,
      scoped ? authorize : undefined,
    );
    return await updateSharedPipeline(remoteId, rawPipeline, {
      ...options,
      distributionMode: 'package',
      committedPackageUploadId: committed.uploadId,
    });
  } finally {
    analyses.delete(summary.analysisId);
  }
}

export async function createPackagedAutomationCapabilityPackage(
  request: CommitAutomationCapabilityPackageRequest,
  getWindow?: () => BrowserWindow | null,
): Promise<{
  capabilityPackage: PipelinePackageRef;
  committedPackageUploadId: string;
}> {
  const committed =
    'analysisId' in request
      ? await commitAnalyzedCapabilityPackage(
          {
            analysisId: request.analysisId,
            selectedOptionalResourceIds:
              request.selectedOptionalResourceIds ?? [],
          },
          getWindow,
        )
      : await commitInstalledAutomationCapabilityPackage(request, getWindow);
  // The package commit is only the first half of an automation share. Keep the
  // analysis until the modal cancels it so a failed create/update can retry
  // with the same reviewed dependency set.
  return {
    capabilityPackage: committed.packageRef,
    committedPackageUploadId: committed.uploadId,
  };
}

/**
 * Commit a reviewed analysis for any step-less subject.
 *
 * The analysis already carries everything the subject contributed, so the
 * commit is subject-agnostic: it uploads the blobs and returns the ref the
 * share writer attaches. Like the automation path, the analysis is retained so
 * a failed share can retry with the same reviewed dependency set rather than
 * re-analyzing and possibly producing a different one.
 */
export async function createSubjectCapabilityPackage(
  request: {
    analysisId: string;
    selectedOptionalResourceIds?: string[];
  },
  getWindow?: () => BrowserWindow | null,
  /** The publishing account's context, so the package lands in that account. */
  credentialContext?: CanopyCloudCredentialContext,
): Promise<{
  capabilityPackage: PipelinePackageRef;
  committedPackageUploadId: string;
}> {
  const committed = await commitAnalyzedCapabilityPackage(
    {
      analysisId: request.analysisId,
      selectedOptionalResourceIds: request.selectedOptionalResourceIds ?? [],
    },
    getWindow,
    undefined,
    credentialContext,
  );
  return {
    capabilityPackage: committed.packageRef,
    committedPackageUploadId: committed.uploadId,
  };
}

export function packagePathForDigest(digest: string): string {
  return `${getPipelinePackagesDir()}/packages/${digest.slice('pp:v1:'.length)}`;
}

export async function listPackageInstalls(): Promise<
  PipelinePackageInstallRecordV1[]
> {
  return listPipelinePackageInstalls(getPipelinePackageInstallStorePath());
}

export async function removePackageInstall(
  localPipelineId: string,
): Promise<void> {
  await removePipelinePackageInstall(
    getPipelinePackageInstallStorePath(),
    localPipelineId,
  );
}

/**
 * Drops a definition's install record after an edit or delete without failing
 * that effect. A record left behind is harmless: execution drops a record
 * whose workflow is gone or no longer matches its pinned hash.
 */
export function dropPackageInstallInBackground(localPipelineId: string): void {
  void removePackageInstall(localPipelineId).catch((error: unknown) => {
    logMainProcessWarn(
      '[pipelines] Could not drop a package install record',
      error,
    );
  });
}

/**
 * The installed package a stored run executes with. With the document core
 * admitted, the install record must bind exactly that document; without one
 * the stored file is read, as for a run core has no definition for.
 */
export async function resolveInstalledPipelinePackageForExecution(
  localPipelineId: string,
  admittedDocument?: string,
): Promise<
  | {
      digest: string;
      rawPipeline: string;
      manifest: PipelinePackageManifestV1;
      cachedPackagePath: string;
    }
  | undefined
> {
  const install = (await listPackageInstalls()).find(
    (record) => record.localPipelineId === localPipelineId,
  );
  if (!install || install.distributionMode === 'definition_only') {
    return undefined;
  }
  let rawPipeline = admittedDocument;
  if (rawPipeline === undefined) {
    const pipelinePath = localPipelineService.getPipelinePath(localPipelineId);
    if (!pipelinePath.success || !pipelinePath.data) {
      await removePackageInstall(localPipelineId);
      return undefined;
    }
    rawPipeline = await readFile(pipelinePath.data, 'utf8');
  }
  if (hashPipelinePackageYaml(rawPipeline) !== install.pipelineContentHash) {
    await removePackageInstall(localPipelineId);
    return undefined;
  }
  const cachedPackagePath = packagePathForDigest(install.packageDigest);
  const manifest = await verifyCachedPipelinePackage(
    cachedPackagePath,
    install.packageDigest,
  );
  // A pipeline an automation install materialized runs under the automation's
  // package, which carries its YAML as an `automation_pipeline` resource.
  if (
    !manifest ||
    !pipelinePackageCarriesPipeline(manifest, install.pipelineContentHash)
  ) {
    throw new Error(
      'The installed workflow package is missing or invalid. Reinstall it from the share link.',
    );
  }
  return {
    digest: install.packageDigest,
    rawPipeline,
    manifest,
    cachedPackagePath,
  };
}

export interface AutomationCapabilityPackageSource {
  remoteId: string;
  packageRef: PipelinePackageRef;
  publicShare?: boolean;
  source?: 'shared' | 'public' | 'curated';
}

export interface DownloadedAutomationCapabilityPackage {
  digest: string;
  manifest: PipelinePackageManifestV1;
  fetchBlob: (sha256: string) => Promise<Uint8Array>;
}

/**
 * Fetch an automation's package manifest from its source and check it is the
 * reviewed package. Writes nothing; {@link cacheAutomationCapabilityPackage}
 * stores it.
 */
export async function downloadAutomationCapabilityPackage(
  input: AutomationCapabilityPackageSource,
): Promise<DownloadedAutomationCapabilityPackage> {
  const source = input.source ?? (input.publicShare ? 'public' : 'shared');
  const download =
    source === 'public'
      ? await getPublicAutomationPackage(
          input.remoteId,
          input.packageRef.digest,
        )
      : source === 'curated'
        ? await getCuratedAutomationPackage(
            input.remoteId,
            input.packageRef.digest,
          )
        : await getAutomationPackage(input.remoteId, input.packageRef.digest);
  if (download.digest !== input.packageRef.digest) {
    throw new Error(
      'The automation capability package changed. Refresh and review it before installing.',
    );
  }
  assertAutomationPackageHasValidBindings(download.manifest);
  return {
    digest: download.digest,
    manifest: download.manifest,
    fetchBlob: (sha256) =>
      source === 'public'
        ? getPublicAutomationPackageBlob(
            input.remoteId,
            input.packageRef.digest,
            sha256,
          )
        : source === 'curated'
          ? getCuratedAutomationPackageBlob(
              input.remoteId,
              input.packageRef.digest,
              sha256,
            )
          : getAutomationPackageBlob(
              input.remoteId,
              input.packageRef.digest,
              sha256,
            ),
  };
}

/** Verify and store a downloaded package in the cache; idempotent. */
export async function cacheAutomationCapabilityPackage(
  download: DownloadedAutomationCapabilityPackage,
): Promise<string> {
  return installPipelinePackageAtomically({
    packagesRoot: getPipelinePackagesDir(),
    digest: download.digest,
    manifest: download.manifest,
    fetchBlob: download.fetchBlob,
  });
}

/**
 * Stage B of an automation install: record the automation-owner install.
 * When this replaces an install of another package (an update), the
 * pipelines the old package materialized lose their link to it once nothing
 * else references it; a dependency the new share still lists was already
 * relinked to the new package by Stage A.
 */
export async function installAutomationCapabilityPackage(
  input: AutomationCapabilityPackageSource & {
    localAutomationId: string;
    localContentHash?: string;
  },
): Promise<void> {
  const download = await downloadAutomationCapabilityPackage(input);
  const storePath = getPipelinePackageInstallStorePath();
  const previous = await findCapabilityPackageInstallByOwner(storePath, {
    kind: 'automation',
    localAutomationId: input.localAutomationId,
  });
  const lease = leasePipelinePackage(getPipelinePackagesDir(), download.digest);
  try {
    await cacheAutomationCapabilityPackage(download);
    await upsertCapabilityPackageInstall(storePath, {
      owner: { kind: 'automation', localAutomationId: input.localAutomationId },
      originExternalId: input.remoteId,
      ...(input.localContentHash !== undefined
        ? { localContentHash: input.localContentHash }
        : {}),
      pipelineContentHash: download.manifest.pipelineContentHash,
      packageDigest: download.digest,
      installedAt: new Date().toISOString(),
    });
  } finally {
    lease.release();
  }
  if (
    previous &&
    previous.distributionMode !== 'definition_only' &&
    previous.packageDigest !== download.digest
  ) {
    await releaseAutomationPackagePipelineInstalls(previous.packageDigest);
  }
}

/**
 * Unlink the pipelines an automation install materialized for
 * `packageDigest` once no automation (or other non-pipeline owner) install
 * references that package. The local pipelines stay; only their
 * pipeline-owner records go, so they run as plain user pipelines.
 */
export async function releaseAutomationPackagePipelineInstalls(
  packageDigest: string,
): Promise<void> {
  const storePath = getPipelinePackageInstallStorePath();
  const records = await listCapabilityPackageInstalls(storePath);
  const isPackageRecord = (record: (typeof records)[number]): boolean =>
    record.distributionMode !== 'definition_only' &&
    record.packageDigest === packageDigest;
  if (
    records.some(
      (record) => record.owner.kind !== 'pipeline' && isPackageRecord(record),
    )
  ) {
    return;
  }
  for (const record of records) {
    if (record.owner.kind !== 'pipeline' || !isPackageRecord(record)) continue;
    await removePipelinePackageInstall(storePath, record.owner.localPipelineId);
  }
}

export async function resolveInstalledAutomationPackageOverlay(
  localAutomationId: string,
  requiredPackage?: PipelinePackageRef,
): Promise<PipelinePackageCapabilityOverlay | undefined> {
  if (!requiredPackage) {
    return undefined;
  }
  const install = await findCapabilityPackageInstallByOwner(
    getPipelinePackageInstallStorePath(),
    { kind: 'automation', localAutomationId },
  );
  if (!install || install.distributionMode === 'definition_only') {
    throw new Error(
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  if (install.packageDigest !== requiredPackage.digest) {
    throw new Error(
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  const packagePath = packagePathForDigest(install.packageDigest);
  const manifest = await verifyCachedPipelinePackage(
    packagePath,
    install.packageDigest,
  );
  if (
    !manifest ||
    manifest.pipelineContentHash !== install.pipelineContentHash
  ) {
    throw new Error(
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  // Packaged pipelines and their assets are bound to the action for display
  // and validation, but they install as local pipelines; the prompt's agent
  // sees only skills and plugins.
  const overlay = filterPackageOverlayForBindingKey(
    buildPipelinePackageOverlay(install.packageDigest, packagePath, manifest),
    manifest.bindings,
    AUTOMATION_ACTION_BINDING_KEY,
  );
  const actionResources =
    overlay?.resources.filter(
      (resource) => !AUTOMATION_INSTALLED_RESOURCE_KINDS.has(resource.kind),
    ) ?? [];
  // A package may hold nothing for the action (a prompt automation whose
  // only content is pipelines). It is invalid only when a resource the action
  // binding names, with files, is missing from the overlay.
  const boundResourceIds = new Set(
    manifest.bindings
      .filter(
        (binding) =>
          capabilityPackageBindingKey(binding) ===
          AUTOMATION_ACTION_BINDING_KEY,
      )
      .flatMap((binding) => binding.resourceIds),
  );
  const overlaidResourceIds = new Set(
    overlay?.resources.map((resource) => resource.resourceId) ?? [],
  );
  if (
    !automationPackageHasValidBindings(manifest) ||
    manifest.resources.some(
      (resource) =>
        boundResourceIds.has(resource.id) &&
        resource.trees.length > 0 &&
        !overlaidResourceIds.has(resource.id),
    ) ||
    Array.from(boundResourceIds).some(
      (resourceId) =>
        !manifest.resources.some((resource) => resource.id === resourceId),
    )
  ) {
    throw new Error(
      'The automation capability package is missing its automation action binding.',
    );
  }
  return actionResources.length > 0
    ? { packageDigest: install.packageDigest, resources: actionResources }
    : undefined;
}

/**
 * Resolve an automation-owned package for execution by its bundled pipeline.
 * The manifest keeps the pipeline's real job/step bindings, so handing the
 * normal package input to the executor preserves its per-step filtering and
 * execution snapshot behavior.
 */
export async function resolveInstalledAutomationPipelinePackage(
  localAutomationId: string,
  localPipelineId: string,
  requiredPackage?: PipelinePackageRef,
): Promise<ExecutionOptions['pipelinePackage'] | undefined> {
  if (!requiredPackage) return undefined;
  const install = await findCapabilityPackageInstallByOwner(
    getPipelinePackageInstallStorePath(),
    { kind: 'automation', localAutomationId },
  );
  if (
    !install ||
    install.distributionMode === 'definition_only' ||
    install.packageDigest !== requiredPackage.digest
  ) {
    throw new Error(
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  const pipelinePath = localPipelineService.getPipelinePath(localPipelineId);
  if (!pipelinePath.success || !pipelinePath.data) {
    throw new Error(
      'The workflow bundled with this automation is missing. Reinstall the automation.',
    );
  }
  const rawPipeline = await readFile(pipelinePath.data, 'utf8');
  if (hashPipelinePackageYaml(rawPipeline) !== install.pipelineContentHash) {
    throw new Error(
      'The workflow bundled with this automation changed. Reinstall the automation to restore its packaged dependencies.',
    );
  }
  const cachedPackagePath = packagePathForDigest(install.packageDigest);
  const manifest = await verifyCachedPipelinePackage(
    cachedPackagePath,
    install.packageDigest,
  );
  if (
    !manifest ||
    manifest.pipelineContentHash !== install.pipelineContentHash
  ) {
    throw new Error(
      'The installed automation capability package is missing or invalid. Reinstall the automation.',
    );
  }
  assertAutomationPackageHasValidBindings(manifest);
  return {
    digest: install.packageDigest,
    rawPipeline,
    manifest,
    cachedPackagePath,
  };
}

/**
 * Moves an automation's package install to `next` local content while it
 * still pins `expected`, so a re-share of the automation, which hashes what
 * the automation now shows, still matches its install (CAN-5479: a converted
 * chat automation shows the chat action its own workflow stands for).
 */
export async function repinAutomationCapabilityPackageContent(
  localAutomationId: string,
  expected: string,
  next: string,
): Promise<boolean> {
  return repinCapabilityPackageInstallLocalContent(
    getPipelinePackageInstallStorePath(),
    { kind: 'automation', localAutomationId },
    expected,
    next,
  );
}

/**
 * CAN-6065: gives `toAutomationId` the package install `fromAutomationId`
 * has, when a workflow's installed schedule hands it to another. Resolves to
 * whether `to` holds it, read back; with nothing to copy, `to` holds what
 * `from` did. `from`'s own install stays until its record is deleted.
 */
export async function copyAutomationCapabilityPackageInstall(
  fromAutomationId: string,
  toAutomationId: string,
): Promise<boolean> {
  const storePath = getPipelinePackageInstallStorePath();
  const to = { kind: 'automation' as const, localAutomationId: toAutomationId };
  try {
    const install = await findCapabilityPackageInstallByOwner(storePath, {
      kind: 'automation',
      localAutomationId: fromAutomationId,
    });
    if (!install) return true;
    await upsertCapabilityPackageInstall(storePath, { ...install, owner: to });
    return (await findCapabilityPackageInstallByOwner(storePath, to)) !== null;
  } catch {
    return false;
  }
}

/**
 * Remove an automation's package install. The pipelines its install
 * materialized stay as local pipelines; their pipeline-owner records go
 * when no other install references the same package.
 */
export async function removeAutomationCapabilityPackageInstall(
  localAutomationId: string,
): Promise<void> {
  const storePath = getPipelinePackageInstallStorePath();
  const owner = { kind: 'automation' as const, localAutomationId };
  const previous = await findCapabilityPackageInstallByOwner(storePath, owner);
  await removeCapabilityPackageInstall(storePath, owner);
  if (previous && previous.distributionMode !== 'definition_only') {
    await releaseAutomationPackagePipelineInstalls(previous.packageDigest);
  }
}

export async function getAutomationCapabilityPackageReadiness(input: {
  remoteId: string;
  packageRef: PipelinePackageRef;
  publicShare?: boolean;
  source?: 'shared' | 'public' | 'curated';
}): Promise<PipelinePackageReadiness> {
  const source = input.source ?? (input.publicShare ? 'public' : 'shared');
  const download =
    source === 'public'
      ? await getPublicAutomationPackage(
          input.remoteId,
          input.packageRef.digest,
        )
      : source === 'curated'
        ? await getCuratedAutomationPackage(
            input.remoteId,
            input.packageRef.digest,
          )
        : await getAutomationPackage(input.remoteId, input.packageRef.digest);
  if (download.digest !== input.packageRef.digest) {
    return { status: 'invalid', requirements: [] };
  }
  if (!automationPackageHasValidBindings(download.manifest)) {
    return { status: 'invalid', requirements: [] };
  }
  return {
    ...(await evaluatePipelinePackageRequirements(
      download.manifest.environmentRequirements,
      probePipelinePackageRequirement,
    )),
    includedResources: download.manifest.resources.map((resource) => ({
      id: resource.id,
      displayName: resource.displayName,
      kind: resource.kind,
      ...(listCapabilityPackageExecutablePaths(resource).length > 0
        ? {
            executableFiles: listCapabilityPackageExecutablePaths(resource),
          }
        : {}),
    })),
  };
}

export async function downloadSharedPipelinePackageForExecution(input: {
  remoteId: string;
  rawPipeline: string;
  packageDigest: string;
}): Promise<NonNullable<ExecutionOptions['pipelinePackage']>> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  const download = await getPipelinePackage(
    input.remoteId,
    input.packageDigest,
  );
  if (
    download.digest !== input.packageDigest ||
    download.manifest.pipelineContentHash !==
      hashPipelinePackageYaml(input.rawPipeline)
  ) {
    throw new Error('Shared workflow package does not match its workflow YAML');
  }
  const cachedPackagePath = await installPipelinePackageAtomically({
    packagesRoot:
      snapshot === undefined
        ? getPipelinePackagesDir()
        : path.join(
            getPipelinePackagesDir(),
            'lanes',
            createHash('sha256').update(snapshot).digest('hex'),
          ),
    digest: download.digest,
    manifest: download.manifest,
    fetchBlob: (sha256) =>
      getPipelinePackageBlob(input.remoteId, download.digest, sha256),
  });
  if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
  return {
    digest: download.digest,
    rawPipeline: input.rawPipeline,
    manifest: download.manifest,
    cachedPackagePath,
  };
}

export async function copyPackageInstall(
  sourceLocalPipelineId: string,
  targetLocalPipelineId: string,
): Promise<void> {
  const source = (await listPackageInstalls()).find(
    (record) => record.localPipelineId === sourceLocalPipelineId,
  );
  if (!source) return;
  const rawPipeline = localPipelineService.getPipelineText(
    sourceLocalPipelineId,
  );
  if (!rawPipeline.success || !rawPipeline.data) {
    throw new Error(rawPipeline.error ?? 'Failed to read source workflow');
  }
  if (
    hashPipelinePackageYaml(rawPipeline.data) !== source.pipelineContentHash
  ) {
    throw new Error('Source workflow no longer matches its installed package');
  }
  await replaceStoredPipelineYaml(targetLocalPipelineId, rawPipeline.data);
  await upsertPipelinePackageInstall(getPipelinePackageInstallStorePath(), {
    ...source,
    localPipelineId: targetLocalPipelineId,
    installedAt: new Date().toISOString(),
  });
}

/**
 * A writable local pipeline with exactly this YAML and no package link, so an
 * install can adopt it instead of saving a duplicate. A copy another install
 * is still creating is not adopted: its rollback would remove it.
 */
export async function findReusableUnlinkedPipeline(
  pipelineContentHash: string,
  excludedPipelineIds: ReadonlySet<string> = new Set(),
): Promise<string | undefined> {
  const linkedPipelineIds = new Set(
    (await listPackageInstalls()).map((install) => install.localPipelineId),
  );
  const listed = localPipelineService.listPipelines();
  if (!listed.success || !listed.data) return undefined;
  for (const pipeline of listed.data) {
    if (
      pipeline.readonly ||
      linkedPipelineIds.has(pipeline.id) ||
      excludedPipelineIds.has(pipeline.id) ||
      isPipelineDefinitionClaimed(pipeline.id)
    )
      continue;
    const raw = localPipelineService.getPipelineText(pipeline.id);
    if (
      raw.success &&
      raw.data &&
      hashPipelinePackageYaml(raw.data) === pipelineContentHash
    ) {
      return pipeline.id;
    }
  }
  return undefined;
}

async function findPackageUpdateTarget(originExternalId: string): Promise<
  | {
      record: PipelinePackageInstallRecordV1;
      pipeline: PipelineData;
      rawPipeline: string;
    }
  | undefined
> {
  for (const record of await listPackageInstalls()) {
    if (
      record.originExternalId !== originExternalId ||
      isPipelineDefinitionClaimed(record.localPipelineId)
    )
      continue;
    const pipeline = localPipelineService.getPipeline(record.localPipelineId);
    const rawPipeline = localPipelineService.getPipelineText(
      record.localPipelineId,
    );
    if (
      pipeline.success &&
      pipeline.data &&
      rawPipeline.success &&
      rawPipeline.data
    ) {
      if (
        hashPipelinePackageYaml(rawPipeline.data) !== record.pipelineContentHash
      ) {
        await removePackageInstall(record.localPipelineId);
        continue;
      }
      return { record, pipeline: pipeline.data, rawPipeline: rawPipeline.data };
    }
  }
  return undefined;
}

async function replaceStoredPipelineYaml(
  localPipelineId: string,
  rawPipeline: string,
): Promise<void> {
  const storedPath = localPipelineService.getPipelinePath(localPipelineId);
  if (!storedPath.success || !storedPath.data) {
    throw new Error(storedPath.error ?? 'Failed to resolve saved workflow');
  }
  const temporaryPath = `${storedPath.data}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, rawPipeline, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, storedPath.data);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

interface PipelineInstallTransaction {
  check: () => Promise<void>;
  onRollback: (undo: () => Promise<void>) => void;
  onReceiptRollback: (undo: () => Promise<void>) => void;
}

async function trackPipelineInstallRollback(
  transaction: PipelineInstallTransaction | undefined,
  localPipelineId: string,
  created: boolean,
): Promise<void> {
  if (!transaction) return;
  const previous = created
    ? undefined
    : localPipelineService.getPipeline(localPipelineId);
  const raw = created
    ? undefined
    : localPipelineService.getPipelineText(localPipelineId);
  const record = created
    ? undefined
    : (await listPackageInstalls()).find(
        (row) => row.localPipelineId === localPipelineId,
      );
  transaction.onRollback(async () => {
    if (created) {
      const removed = localPipelineService.deletePipeline(localPipelineId);
      if (!removed.success)
        throw new Error(removed.error ?? 'Failed to roll back workflow');
    } else if (previous?.success && previous.data && raw?.success && raw.data) {
      const restored = localPipelineService.savePipeline({
        id: localPipelineId,
        name: previous.data.info.name,
        description: previous.data.info.description,
        icon: previous.data.info.icon,
        content: previous.data.content,
      });
      if (!restored.success)
        throw new Error('Failed to restore workflow install');
      await replaceStoredPipelineYaml(localPipelineId, raw.data);
    }
    if (record)
      await upsertPipelinePackageInstall(
        getPipelinePackageInstallStorePath(),
        record,
      );
    else await removePackageInstall(localPipelineId);
  });
  await transaction.check();
}

/** The share an install from a share link subscribes to for update emails. */
type PublicPackageShareSubscription = Pick<
  SharedItemInstallRecord,
  'remoteId' | 'sourceKind' | 'contentHash'
>;

/** A public share install the queue is running, which its remote serves. */
interface PublicShareInstallSession {
  readonly remoteDefinitionId: string;
  /** The install's intent record (CAN-5633), finished or rolled back by the queue. */
  readonly intent: PipelineInstallIntent;
  /** Package leases held until the install record names the package. */
  readonly leases: PipelinePackageLease[];
  readonly transaction?: PipelineInstallTransaction;
  readonly getWindow?: () => BrowserWindow | null;
  subscription?: PublicPackageShareSubscription;
  outcome?: PipelinePackageInstallResult;
}

/** Installs are queued one at a time, so at most one session is running. */
let activePublicShareInstall: PublicShareInstallSession | undefined;

const PUBLIC_SHARE_CHANGED_MESSAGE =
  'This shared workflow changed. Return to the share page to review the updated dependencies.';

/** Where a public share install lands, chosen once its pin has passed. */
type PublicShareInstallPlan =
  | {
      kind: 'existing';
      localPipelineId: string;
      manifest?: PipelinePackageManifestV1;
    }
  | {
      kind: 'update';
      localPipelineId: string;
      previous: { pipeline: PipelineData; rawPipeline: string };
    }
  | { kind: 'reuse'; localPipelineId: string }
  | { kind: 'create' };

/**
 * A public share, addressed by its external id, as a remote core installs
 * from (`public-share:<externalId>`). Its version holds the document, the
 * distribution mode and the package the share page reviewed, which the
 * public resolve itself also refuses to serve once changed. The install
 * lands in the copy an earlier install of the share left unchanged, in that
 * copy's update, in an identical unlinked copy, or in a new one; it installs
 * the share's package (its skills, plugins and MCP servers) before the
 * definition, and records the package install, receipt and subscription
 * with it, rolling back with the running install's transaction.
 */
export async function readPublicPipelineShareRemote(
  remoteDefinitionId: string,
  expectedRemoteVersion: string | null,
): Promise<PublicPipelineShareRemote | null> {
  const externalId = parsePublicPipelineShareId(remoteDefinitionId);
  if (externalId === null) return null;
  const session =
    activePublicShareInstall?.remoteDefinitionId === remoteDefinitionId
      ? activePublicShareInstall
      : undefined;
  const transaction = session?.transaction;
  const pin =
    expectedRemoteVersion === null
      ? null
      : parsePublicPipelineShareVersion(expectedRemoteVersion);
  const snapshot = await getPublicPipelineShareSnapshot(
    externalId,
    pin === null
      ? undefined
      : {
          expectedPipelineContentHash: pin.pipelineContentHash,
          expectedDistributionMode: pin.distributionMode,
          expectedPackageDigest: pin.packageDigest,
        },
  );
  await transaction?.check();
  const scopedDetail =
    pipelineResourceContextEnabled() && snapshot.sourceRemoteId
      ? await getSharedPipeline(snapshot.sourceRemoteId)
      : undefined;
  // A share link can resolve to a team or organization pipeline rather than
  // a Public share; that install follows the pipeline itself.
  const subscription: PublicPackageShareSubscription = scopedDetail
    ? {
        remoteId: scopedDetail.id,
        sourceKind: 'shared',
        contentHash: scopedDetail.contentHash,
      }
    : {
        remoteId: externalId,
        sourceKind: 'public',
        contentHash: snapshot.contentHash,
      };
  // A resolve that names no distribution mode matches no reviewed pin.
  if (snapshot.distributionMode === undefined)
    throw new PipelineDefinitionSourceError(
      'core.pipeline.remoteVersionConflict',
      PUBLIC_SHARE_CHANGED_MESSAGE,
    );
  const distributionMode = snapshot.distributionMode;
  const sharePackage = snapshot.package;
  const packageDigest =
    distributionMode === 'package' ? sharePackage?.digest : undefined;
  const pipeline = parsePipelineText(snapshot.rawPipeline);
  let plan: PublicShareInstallPlan = { kind: 'create' };

  // An unchanged earlier install, checked before the package downloads so
  // its verified cache is reused.
  const findExistingInstall = async (): Promise<
    PublicShareInstallPlan | undefined
  > => {
    if (distributionMode === 'definition_only') {
      const existing = (await listPackageInstalls()).find(
        (record) =>
          record.distributionMode === 'definition_only' &&
          record.originExternalId === externalId &&
          record.pipelineContentHash === snapshot.contentHash &&
          !isPipelineDefinitionClaimed(record.localPipelineId),
      );
      if (existing) {
        await assertStoredPipelineContext(existing.localPipelineId);
        const current = localPipelineService.getPipelineText(
          existing.localPipelineId,
        );
        if (
          current.success &&
          current.data &&
          hashPipelinePackageYaml(current.data) === existing.pipelineContentHash
        )
          return {
            kind: 'existing',
            localPipelineId: existing.localPipelineId,
          };
        await removePackageInstall(existing.localPipelineId);
      }
    } else {
      if (!sharePackage || packageDigest === undefined)
        throw new PipelineDefinitionSourceError(
          'core.pipeline.remoteVersionConflict',
          PUBLIC_SHARE_CHANGED_MESSAGE,
        );
      const recorded = await findPipelinePackageInstall(
        getPipelinePackageInstallStorePath(),
        {
          originExternalId: externalId,
          pipelineContentHash: snapshot.contentHash,
          packageDigest,
        },
      );
      // A copy an unfinished install created is that install's to roll back.
      const existing =
        recorded && !isPipelineDefinitionClaimed(recorded.localPipelineId)
          ? recorded
          : null;
      if (existing) {
        await assertStoredPipelineContext(existing.localPipelineId);
        const stored = localPipelineService.getPipeline(
          existing.localPipelineId,
        );
        const rawPipeline = localPipelineService.getPipelineText(
          existing.localPipelineId,
        );
        if (
          !stored.success ||
          !rawPipeline.success ||
          !rawPipeline.data ||
          hashPipelinePackageYaml(rawPipeline.data) !==
            existing.pipelineContentHash
        ) {
          await removePackageInstall(existing.localPipelineId);
        } else {
          const cachedManifest = await verifyCachedPipelinePackage(
            packagePathForDigest(packageDigest),
            packageDigest,
          );
          if (
            cachedManifest?.pipelineContentHash === existing.pipelineContentHash
          )
            return {
              kind: 'existing',
              localPipelineId: existing.localPipelineId,
              manifest: cachedManifest,
            };
        }
      }
    }
    return undefined;
  };

  // Where a new revision lands, read after the package downloads so the
  // copy it updates is the current one.
  const planInstallTarget = async (): Promise<PublicShareInstallPlan> => {
    const updateTarget = await findPackageUpdateTarget(externalId);
    if (updateTarget)
      return {
        kind: 'update',
        localPipelineId: updateTarget.record.localPipelineId,
        previous: {
          pipeline: updateTarget.pipeline,
          rawPipeline: updateTarget.rawPipeline,
        },
      };
    const reusable = scopedDetail
      ? undefined
      : await findReusableUnlinkedPipeline(snapshot.contentHash);
    return reusable === undefined
      ? { kind: 'create' }
      : { kind: 'reuse', localPipelineId: reusable };
  };

  let packageManifest: PipelinePackageManifestV1 | undefined;
  const ownLeases: PipelinePackageLease[] = [];
  const preparePackage = async (): Promise<
    PipelinePackageManifestV1 | undefined
  > => {
    const existing = await findExistingInstall();
    if (existing?.kind === 'existing') {
      plan = existing;
      return existing.manifest;
    }
    if (distributionMode !== 'package' || packageDigest === undefined)
      return undefined;
    const download = await (
      scopedDetail ? getPipelinePackage : getPublicPipelinePackage
    )(externalId, packageDigest);
    if (download.manifest.pipelineContentHash !== snapshot.contentHash) {
      throw new Error(
        'Workflow package content hash does not match the reviewed YAML',
      );
    }
    let transferred = 0;
    emitProgress(session?.getWindow, {
      stage: 'Uploading dependencies…',
      completed: 0,
      total: download.manifest.totalFiles,
    });
    // Held until the install record names the package, so a concurrent
    // install's rollback cannot remove the directory under this one.
    const lease = leasePipelinePackage(
      getPipelinePackagesDir(),
      download.digest,
    );
    (session?.leases ?? ownLeases).push(lease);
    await installPipelinePackageAtomically({
      ...(transaction
        ? {
            beforeCommit: transaction.check,
            onCreated: (destination: string): void =>
              transaction.onRollback(async () => {
                await removePipelinePackageUnlessRetained({
                  destination,
                  lease,
                  isRecorded: async () =>
                    (await listPackageInstalls()).some(
                      (record) => record.packageDigest === download.digest,
                    ),
                });
              }),
          }
        : {}),
      packagesRoot: getPipelinePackagesDir(),
      digest: download.digest,
      manifest: download.manifest,
      fetchBlob: async (sha256) => {
        const bytes = await (
          scopedDetail ? getPipelinePackageBlob : getPublicPipelinePackageBlob
        )(externalId, packageDigest, sha256);
        transferred += 1;
        emitProgress(session?.getWindow, {
          stage: 'Uploading dependencies…',
          completed: transferred,
          total: download.manifest.totalFiles,
        });
        return bytes;
      },
    });
    packageManifest = download.manifest;
    return download.manifest;
  };

  const namedReplacement = async (
    localPipelineId: string,
  ): Promise<PublicShareInstallPlan> => {
    await assertStoredPipelineContext(localPipelineId);
    const stored = localPipelineService.getPipeline(localPipelineId);
    const rawPipeline = localPipelineService.getPipelineText(localPipelineId);
    if (
      !stored.success ||
      !stored.data ||
      !rawPipeline.success ||
      !rawPipeline.data
    )
      throw new Error('Workflow unavailable (unknown-provenance)');
    return {
      kind: 'update',
      localPipelineId,
      previous: { pipeline: stored.data, rawPipeline: rawPipeline.data },
    };
  };

  const installWith = async (
    intent: PipelineInstallIntent,
    write: PipelineDefinitionInstall,
  ): Promise<PipelineInfo> => {
    if (session) session.subscription = subscription;
    const localPipelineId = write.definitionId;
    const outcome = (): PipelinePackageInstallResult =>
      packageDigest === undefined
        ? {
            localPipelineId,
            distributionMode: 'definition_only',
            resourceCount: 0,
          }
        : {
            localPipelineId,
            distributionMode: 'package',
            packageDigest,
            resourceCount:
              packageManifest?.resources.length ??
              sharePackage?.resources.length ??
              0,
          };
    // A definition the caller named replaces whatever copy this remote chose.
    const target =
      write.replaces &&
      (plan.kind === 'create' || plan.localPipelineId !== localPipelineId)
        ? await namedReplacement(localPipelineId)
        : plan;
    if (target.kind === 'existing') {
      if (scopedDetail)
        await recordSharedPipelineInstall(
          scopedDetail,
          localPipelineId,
          transaction?.onReceiptRollback,
        );
      if (session) session.outcome = outcome();
      return storedPipelineInfo(localPipelineId);
    }
    // Core holds the definition's lock from here; an edit saved since the
    // copy was chosen is kept rather than overwritten.
    if (
      target.kind === 'update' &&
      localPipelineService.getPipelineText(localPipelineId).data !==
        target.previous.rawPipeline
    )
      throw new Error(
        'This workflow changed while the shared workflow was installing. Try again.',
      );
    const created = target.kind === 'create';
    const updated = target.kind === 'update' ? target.previous : undefined;
    await transaction?.check();
    // Each write is noted first, so an exit partway is rolled back at the
    // next start instead of leaving a copy a reinstall would duplicate.
    await intent.noteDefinition({
      definitionId: localPipelineId,
      change: created ? 'created' : updated ? 'replaced' : 'linked',
      contentHash: hashPipelinePackageYaml(write.text),
    });
    let savedInfo: PipelineInfo | undefined;
    if (created) {
      const saved = localPipelineService.savePipeline(
        {
          name: write.name,
          description: write.description,
          icon: write.icon,
          content: write.pipeline,
          rawContent: write.text,
        },
        { id: localPipelineId },
      );
      if (!saved.success || !saved.data) {
        throw new Error(saved.error ?? 'Failed to save the workflow');
      }
      if (saved.data.id !== localPipelineId)
        throw new Error('Pipeline create identity mismatch');
      savedInfo = saved.data;
    }
    await trackPipelineInstallRollback(transaction, localPipelineId, created);
    if (scopedDetail)
      await recordSharedPipelineInstall(
        scopedDetail,
        localPipelineId,
        transaction?.onReceiptRollback,
        (effect) => intent.noteReceipt(localPipelineId, effect),
      );
    await transaction?.check();
    try {
      if (updated) {
        const saved = localPipelineService.savePipeline({
          id: localPipelineId,
          name: write.name,
          description: write.description,
          icon: write.icon,
          content: write.pipeline,
          rawContent: write.text,
        });
        if (!saved.success) {
          throw new Error(saved.error ?? 'Failed to update the workflow');
        }
      }
      // The pin holds the exact shared YAML bytes. The local store serializes
      // parsed content, so replace that serialization atomically with the
      // reviewed snapshot before recording the package link.
      if (created || updated) {
        await replaceStoredPipelineYaml(localPipelineId, write.text);
      }
      const installedAt = new Date().toISOString();
      const record: PipelinePackageInstallRecordV1 =
        packageDigest === undefined
          ? {
              localPipelineId,
              originExternalId: externalId,
              pipelineContentHash: snapshot.contentHash,
              distributionMode: 'definition_only',
              installedAt,
            }
          : {
              localPipelineId,
              originExternalId: externalId,
              pipelineContentHash: snapshot.contentHash,
              distributionMode: 'package',
              packageDigest,
              installedAt,
            };
      await intent.noteInstallRecord(localPipelineId, record);
      await upsertPipelinePackageInstall(
        getPipelinePackageInstallStorePath(),
        record,
      );
    } catch (error) {
      if (transaction) throw error;
      if (created) {
        localPipelineService.deletePipeline(localPipelineId);
      } else if (updated) {
        try {
          const restored = localPipelineService.savePipeline({
            id: localPipelineId,
            name: updated.pipeline.info.name,
            description: updated.pipeline.info.description,
            icon: updated.pipeline.info.icon,
            content: updated.pipeline.content,
          });
          if (!restored.success) {
            throw new Error(
              restored.error ?? 'Failed to restore the previous workflow',
            );
          }
          await replaceStoredPipelineYaml(localPipelineId, updated.rawPipeline);
        } catch (rollbackError) {
          const installMessage =
            error instanceof Error ? error.message : String(error);
          const rollbackMessage =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          throw new Error(
            distributionMode === 'package'
              ? `Workflow package update failed (${installMessage}) and the previous workflow could not be restored (${rollbackMessage})`
              : `Definition-only workflow update failed (${installMessage}) and the previous workflow could not be restored (${rollbackMessage})`,
          );
        }
      }
      throw error;
    }
    await recordInstalledPipelineMetadata(
      localPipelineId,
      created,
      created || Boolean(updated),
      transaction,
    );
    if (session) session.outcome = outcome();
    return savedInfo ?? storedPipelineInfo(localPipelineId);
  };

  // Without a queued session (whose queue settles its intent and leases),
  // the install keeps its own.
  const install = async (
    write: PipelineDefinitionInstall,
  ): Promise<PipelineInfo> => {
    if (session) {
      // Committed before core records the import's replay receipt, so a
      // record never outlives an install core reported done.
      const installed = await installWith(session.intent, write);
      await session.transaction?.check();
      await session.intent.finish();
      return installed;
    }
    const intent = await beginPipelineInstallIntent('package_share');
    try {
      const installed = await installWith(intent, write);
      await intent.finish();
      return installed;
    } catch (error) {
      await intent.rollBack().catch((rollbackError: unknown) => {
        logMainProcessWarn(
          '[pipeline-packages] Install intent rollback failed',
          rollbackError,
        );
      });
      throw error;
    } finally {
      for (const lease of ownLeases.splice(0)) lease.release();
    }
  };

  return {
    name: pipeline.name,
    description: pipeline.description ?? snapshot.description,
    icon: pipeline.icon ?? '',
    rawPipeline: snapshot.rawPipeline,
    remoteVersion: publicPipelineShareVersion({
      pipelineContentHash: snapshot.contentHash,
      distributionMode,
      ...(packageDigest === undefined ? {} : { packageDigest }),
    }),
    installTarget: async (): Promise<string | null> => {
      if (plan.kind !== 'existing') plan = await planInstallTarget();
      return plan.kind === 'create' ? null : plan.localPipelineId;
    },
    packageManifest: preparePackage,
    install,
  };
}

/** A public share as the desktop's remote reader hands it to core. */
export interface PublicPipelineShareRemote {
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly rawPipeline: string;
  readonly remoteVersion: string;
  installTarget(): Promise<string | null>;
  packageManifest(): Promise<PipelinePackageManifestV1 | undefined>;
  install(write: PipelineDefinitionInstall): Promise<PipelineInfo>;
}

function storedPipelineInfo(localPipelineId: string): PipelineInfo {
  const stored = localPipelineService.getPipeline(localPipelineId);
  if (!stored.success || !stored.data)
    throw new Error(stored.error ?? 'Failed to read the installed workflow');
  return stored.data.info;
}

/**
 * An install keeps the owner it was installed in; reinstalling over an
 * existing pipeline keeps that pipeline's owner. Installed content carries no
 * agent marker. A metadata failure is logged rather than failing the install,
 * and a rolled-back install undoes these changes once the pipeline itself was
 * removed or restored.
 */
export async function recordInstalledPipelineMetadata(
  localPipelineId: string,
  created: boolean,
  contentWritten: boolean,
  transaction?: PipelineInstallTransaction,
): Promise<void> {
  try {
    const previousAuthor = readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: localPipelineId,
    }).agentAuthor;
    if (created)
      recordUserPipelineOwner(localPipelineId, await selectedOwnerContext());
    else await getUserPipelineOwner(localPipelineId);
    if (contentWritten) setUserPipelineAgentAuthor(localPipelineId, null);
    transaction?.onReceiptRollback(() => {
      if (created) deleteUserPipelineLocalMetadata(localPipelineId);
      else if (contentWritten && previousAuthor)
        setUserPipelineAgentAuthor(localPipelineId, previousAuthor);
      return Promise.resolve();
    });
  } catch (error) {
    logMainProcessWarn(
      '[pipeline-packages] could not record installed pipeline metadata',
      error,
    );
  }
}

/**
 * A user pipeline installed from a shared container's capability package
 * (CAN-4655). The caller chooses the id so an attempt journal can name the
 * pipeline before it exists. The packaged YAML bytes are stored verbatim.
 *
 * When the definition carries child pipelines or project actions, `overlay`
 * is a manifest derived from the already verified container package: the
 * same files, bound to this pipeline's YAML hash, so the existing run-time
 * package resolution overlays them without a container-specific path.
 *
 * The install record carries no `originExternalId`: that field names a
 * Public pipeline share, and the shared item backfill subscribes to every
 * such origin. The container install's provenance is its ledger row and
 * attempt journal.
 */
export async function createContainerInstalledPipeline(input: {
  localPipelineId: string;
  name: string;
  description?: string;
  rawPipeline: string;
  overlay?: {
    digest: string;
    manifest: PipelinePackageManifestV1;
    /** The container package whose cached blobs back the overlay. */
    sourcePackageDigest: string;
  };
}): Promise<{ localPipelineId: string; contentHash: string }> {
  const pipeline = parsePipelineText(input.rawPipeline);
  const contentHash = hashPipelinePackageYaml(input.rawPipeline);
  const saved = localPipelineService.savePipeline(
    {
      name: input.name,
      description: input.description ?? pipeline.description ?? '',
      icon: pipeline.icon ?? '',
      content: pipeline,
      rawContent: input.rawPipeline,
    },
    { id: input.localPipelineId },
  );
  if (!saved.success || !saved.data) {
    throw new Error(saved.error ?? 'Failed to save the pipeline');
  }
  try {
    const overlay = input.overlay;
    if (overlay) {
      if (overlay.manifest.pipelineContentHash !== contentHash) {
        throw new Error(
          'Pipeline package content hash does not match the pipeline YAML',
        );
      }
      const sourcePath = packagePathForDigest(overlay.sourcePackageDigest);
      const lease = leasePipelinePackage(
        getPipelinePackagesDir(),
        overlay.digest,
      );
      try {
        await installPipelinePackageAtomically({
          packagesRoot: getPipelinePackagesDir(),
          digest: overlay.digest,
          manifest: overlay.manifest,
          fetchBlob: (sha256) =>
            readFile(path.join(sourcePath, 'blobs', sha256)).then(
              (bytes) => new Uint8Array(bytes),
            ),
        });
        await upsertPipelinePackageInstall(
          getPipelinePackageInstallStorePath(),
          {
            localPipelineId: input.localPipelineId,
            pipelineContentHash: contentHash,
            distributionMode: 'package',
            packageDigest: overlay.digest,
            installedAt: new Date().toISOString(),
          },
        );
      } finally {
        lease.release();
      }
    }
  } catch (error) {
    await removeContainerInstalledPipeline(
      input.localPipelineId,
      contentHash,
    ).catch(() => undefined);
    throw error;
  }
  await recordInstalledPipelineMetadata(input.localPipelineId, true, true);
  return { localPipelineId: input.localPipelineId, contentHash };
}

/**
 * Compensation for {@link createContainerInstalledPipeline}. A pipeline whose
 * YAML no longer matches what the install wrote was edited by the user and
 * is kept; only an untouched copy is removed.
 */
export async function removeContainerInstalledPipeline(
  localPipelineId: string,
  expectedContentHash: string,
): Promise<'removed' | 'kept' | 'missing'> {
  const raw = localPipelineService.getPipelineText(localPipelineId);
  if (!raw.success || raw.data === undefined) {
    await removePackageInstall(localPipelineId);
    return 'missing';
  }
  if (hashPipelinePackageYaml(raw.data) !== expectedContentHash) return 'kept';
  const removed = localPipelineService.deletePipeline(localPipelineId);
  if (!removed.success) {
    throw new Error(removed.error ?? 'Failed to remove the pipeline');
  }
  await removePackageInstall(localPipelineId);
  deleteUserPipelineLocalMetadata(localPipelineId);
  return 'removed';
}

export async function installPublicPackageShare(
  request: PipelinePackageInstallRequest,
  getWindow?: () => BrowserWindow | null,
): Promise<PipelinePackageInstallResult> {
  const snapshot = pipelineResourceContextEnabled()
    ? await pipelineContextSnapshot()
    : undefined;
  const identity =
    [
      request.externalId,
      request.expectedPipelineContentHash,
      request.expectedDistributionMode,
      request.expectedPackageDigest,
    ].join('\0') + (snapshot ?? '');
  const existing = publicPackageInstalls.get(identity);
  if (existing) return existing;
  const operation = publicPackageInstallQueue
    .catch(() => undefined)
    .then(async () => {
      if (snapshot !== undefined) await assertPipelineContextSnapshot(snapshot);
      const intent = await beginPipelineInstallIntent('package_share');
      const undos: Array<() => Promise<void>> = [];
      const receiptUndos: Array<() => Promise<void>> = [];
      const transaction: PipelineInstallTransaction | undefined =
        snapshot === undefined
          ? undefined
          : {
              check: () => assertPipelineContextSnapshot(snapshot),
              onReceiptRollback: (undo): void => {
                receiptUndos.push(undo);
              },
              onRollback: (undo): void => {
                undos.push(undo);
              },
            };
      const session: PublicShareInstallSession = {
        remoteDefinitionId: buildPublicPipelineShareId(request.externalId),
        intent,
        leases: [],
        ...(transaction ? { transaction } : {}),
        ...(getWindow ? { getWindow } : {}),
      };
      try {
        const { importRemotePipeline } =
          await import('../canopy-runtime/pipeline-definition-dispatch');
        activePublicShareInstall = session;
        let installed: PipelineInfo;
        try {
          installed = await importRemotePipeline({
            remoteDefinitionId: session.remoteDefinitionId,
            expectedRemoteVersion: publicPipelineShareVersion({
              pipelineContentHash: request.expectedPipelineContentHash,
              distributionMode: request.expectedDistributionMode,
              ...(request.expectedPackageDigest === undefined
                ? {}
                : { packageDigest: request.expectedPackageDigest }),
            }),
            nameOverride: null,
          });
        } catch (error) {
          throw publicShareInstallError(error);
        } finally {
          activePublicShareInstall = undefined;
        }
        const { outcome, subscription } = session;
        if (outcome?.localPipelineId !== installed.id)
          throw new Error('Workflow install failed');
        await transaction?.check();
        // Already finished by the remote's install; a no-op then.
        await intent.finish();
        if (subscription !== undefined)
          recordSharedItemInstall({
            kind: 'pipeline',
            ...subscription,
            localId: installed.id,
          });
        return outcome;
      } catch (error) {
        const failures: unknown[] = [];
        for (const undo of undos.reverse()) {
          try {
            await undo();
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        // Never strip provenance from a definition we failed to remove/restore.
        if (!failures.length) {
          for (const undo of receiptUndos.reverse()) {
            try {
              await undo();
            } catch (rollbackError) {
              failures.push(rollbackError);
            }
          }
        }
        // Whatever the steps above left, or a failure without a transaction
        // never tracked, is undone from the intent record; on failure it
        // stays for startup recovery, and is news only when the steps above
        // reported none.
        try {
          await intent.rollBack();
        } catch (rollbackError) {
          if (failures.length)
            logMainProcessWarn(
              '[pipeline-packages] Install intent rollback failed',
              rollbackError,
            );
          else failures.push(rollbackError);
        }
        if (failures.length)
          throw Object.assign(
            new Error(
              error instanceof Error
                ? `${error.message}; rollback failed: ${failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')}`
                : 'Workflow install failed',
            ),
            { cause: error, rollbackErrors: failures },
          );
        throw error;
      } finally {
        for (const lease of session.leases.splice(0)) lease.release();
      }
    });
  publicPackageInstallQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  publicPackageInstalls.set(identity, operation);
  const clearInFlight = (): void => {
    if (publicPackageInstalls.get(identity) === operation) {
      publicPackageInstalls.delete(identity);
    }
  };
  void operation.then(clearInFlight, clearInFlight);
  return operation;
}

/** Core's refusal worded as the share page has always shown it. */
function publicShareInstallError(error: unknown): Error {
  if (!(error instanceof CanopyOperationError))
    return error instanceof Error ? error : new Error(String(error));
  if (error.payload.code === 'core.pipeline.remoteVersionConflict')
    return new Error(PUBLIC_SHARE_CHANGED_MESSAGE);
  return new Error(error.payload.message);
}

/**
 * Readiness for a shared pipeline whose detail the caller already holds.
 *
 * `getPackageReadiness` fetches the detail itself, which is the right shape
 * for the IPC handler but a second round trip for a caller that just fetched
 * it (`runPipeline` reads `distributionMode` off the same detail to decide
 * whether readiness is even relevant). Taking the detail as an argument keeps
 * the wire request type unchanged while letting that caller pay for one fetch
 * instead of two.
 */
export async function getSharedPackageReadinessFromDetail(
  detail: SharedPipelineDetail,
): Promise<PipelinePackageReadiness> {
  if (detail.distributionMode !== 'package') {
    return {
      status: 'invalid',
      distributionMode: 'definition_only',
      requirements: [],
    };
  }
  if (!detail.package) {
    return {
      status: 'invalid',
      distributionMode: 'package',
      requirements: [],
    };
  }
  return {
    ...(await evaluatePipelinePackageRequirements(
      detail.package.environmentRequirements,
      probePipelinePackageRequirement,
    )),
    distributionMode: 'package',
    ...(detail.package.publisherNotes
      ? { publisherNotes: detail.package.publisherNotes }
      : {}),
  };
}

export class SharedPipelinePinMismatchError extends Error {
  readonly remoteId: string;
  readonly pipelineName: string;

  constructor(remoteId: string, pipelineName: string) {
    super(
      `The pinned version of "${pipelineName}" could not be verified. Refresh and try again.`,
    );
    this.name = 'SharedPipelinePinMismatchError';
    this.remoteId = remoteId;
    this.pipelineName = pipelineName;
  }
}

export function assertSharedPipelineMatchesAutomationInstallPin(
  detail: SharedPipelineDetail,
  expected: PipelineShareInstallPin,
): void {
  const contentHash = hashPipelinePackageYaml(detail.rawPipeline);
  const distributionMode = detail.distributionMode ?? 'definition_only';
  const packageDigest = detail.package?.digest;
  if (
    contentHash !== expected.pipelineContentHash ||
    distributionMode !== expected.distributionMode ||
    packageDigest !== expected.packageDigest
  ) {
    throw new SharedPipelinePinMismatchError(detail.id, detail.name);
  }
}

export async function getSharedPipelineAutomationInstallPin(
  remoteId: string,
): Promise<{ installPin: PipelineShareInstallPin; rawPipeline: string }> {
  const detail = await getSharedPipeline(remoteId);
  const distributionMode = detail.distributionMode ?? 'definition_only';
  if (distributionMode === 'package') {
    const packageDigest = detail.package?.digest;
    if (!packageDigest) {
      throw new Error(
        `The current version of "${detail.name}" could not be pinned. Refresh and try again.`,
      );
    }
    return {
      installPin: {
        pipelineContentHash: hashPipelinePackageYaml(detail.rawPipeline),
        distributionMode,
        packageDigest,
      },
      rawPipeline: detail.rawPipeline,
    };
  }
  return {
    installPin: {
      pipelineContentHash: hashPipelinePackageYaml(detail.rawPipeline),
      distributionMode,
    },
    rawPipeline: detail.rawPipeline,
  };
}

export async function verifySharedPipelineAutomationInstallPin(
  remoteId: string,
  expected: PipelineShareInstallPin,
): Promise<PipelineShareInstallPin> {
  const detail = await getSharedPipeline(remoteId);
  assertSharedPipelineMatchesAutomationInstallPin(detail, expected);
  if (expected.distributionMode === 'package') {
    if (!expected.packageDigest) {
      throw new Error(
        `The pinned version of "${detail.name}" could not be verified. Refresh and try again.`,
      );
    }
    await downloadSharedPipelinePackageForExecution({
      remoteId,
      rawPipeline: detail.rawPipeline,
      packageDigest: expected.packageDigest,
    });
  }
  return expected;
}

export async function getPackageReadiness(
  request: PipelinePackageReadinessRequest,
): Promise<PipelinePackageReadiness> {
  if (
    typeof request.pipeline === 'object' &&
    request.pipeline !== null &&
    'source' in request.pipeline &&
    request.pipeline.source === 'shared'
  ) {
    return getSharedPackageReadinessFromDetail(
      await getSharedPipeline(request.pipeline.remoteId),
    );
  }
  const localPipelineId =
    typeof request.pipeline === 'string'
      ? request.pipeline
      : typeof request.pipeline === 'object' &&
          request.pipeline !== null &&
          'id' in request.pipeline &&
          typeof request.pipeline.id === 'string'
        ? request.pipeline.id
        : null;
  if (!localPipelineId) {
    return { status: 'ready', requirements: [] };
  }
  if (pipelineResourceContextEnabled()) {
    if (
      typeof request.pipeline === 'object' &&
      'cwd' in request.pipeline &&
      'filePath' in request.pipeline
    ) {
      await authorizeProjectPipelineRequest(request.pipeline);
      return { status: 'ready', requirements: [] };
    }
    if (localPipelineId.startsWith('project--'))
      throw new Error('Workflow unavailable (unknown-provenance)');
    await assertStoredPipelineContext(localPipelineId);
  }
  const install = (await listPackageInstalls()).find(
    (record) => record.localPipelineId === localPipelineId,
  );
  if (!install) return { status: 'ready', requirements: [] };
  if (install.distributionMode === 'definition_only') {
    const rawPipeline = localPipelineService.getPipelineText(localPipelineId);
    if (
      !rawPipeline.success ||
      !rawPipeline.data ||
      hashPipelinePackageYaml(rawPipeline.data) !== install.pipelineContentHash
    ) {
      await removePackageInstall(localPipelineId);
      return { status: 'ready', requirements: [] };
    }
    return {
      status: 'invalid',
      distributionMode: 'definition_only',
      requirements: [],
    };
  }
  const rawPipeline = localPipelineService.getPipelineText(localPipelineId);
  if (
    !rawPipeline.success ||
    !rawPipeline.data ||
    hashPipelinePackageYaml(rawPipeline.data) !== install.pipelineContentHash
  ) {
    await removePackageInstall(localPipelineId);
    return { status: 'ready', requirements: [] };
  }
  const manifest = await verifyCachedPipelinePackage(
    packagePathForDigest(install.packageDigest),
    install.packageDigest,
  );
  if (!manifest) {
    return {
      status: 'invalid',
      distributionMode: 'package',
      requirements: [],
    };
  }
  if (!pipelinePackageCarriesPipeline(manifest, install.pipelineContentHash)) {
    await removePackageInstall(localPipelineId);
    return { status: 'ready', requirements: [] };
  }
  return {
    ...(await evaluatePipelinePackageRequirements(
      manifest.environmentRequirements,
      probePipelinePackageRequirement,
    )),
    distributionMode: 'package',
    ...(manifest.publisherNotes
      ? { publisherNotes: manifest.publisherNotes }
      : {}),
  };
}

export type RequirementAvailability = Pick<
  PipelinePackageReadiness['requirements'][number],
  'status' | 'detail'
>;

export async function evaluatePipelinePackageRequirements(
  requirements: readonly PipelinePackageEnvironmentRequirement[],
  probe: (
    requirement: PipelinePackageEnvironmentRequirement,
  ) => Promise<RequirementAvailability>,
): Promise<PipelinePackageReadiness> {
  const resolved = await Promise.all(
    requirements.map(async (requirement) => ({
      ...requirement,
      ...(await probe(requirement)),
    })),
  );
  return {
    status: resolved.some(
      (requirement) => requirement.required && requirement.status === 'missing',
    )
      ? 'setup_required'
      : 'ready',
    requirements: resolved,
  };
}

export const UNKNOWN_REQUIREMENT: RequirementAvailability = {
  status: 'unknown',
  detail: 'Availability could not be verified automatically.',
};

/** How a local MCP server's state reads as a requirement, for any subject. */
export function mcpRequirementAvailability(
  status: McpServerStatusEntry | null,
): RequirementAvailability {
  if (!status) {
    return { status: 'missing', detail: 'MCP server is not installed.' };
  }
  if (status.connectionStatus === 'connected') {
    return { status: 'available', detail: 'MCP server is connected.' };
  }
  if (
    status.connectionStatus === 'auth_required' ||
    status.connectionStatus === 'unreachable'
  ) {
    return {
      status: 'missing',
      detail:
        status.connectionStatus === 'auth_required'
          ? 'MCP server authentication is required.'
          : 'MCP server is unreachable.',
    };
  }
  return UNKNOWN_REQUIREMENT;
}

async function probePipelinePackageModel(
  displayName: string,
): Promise<RequirementAvailability> {
  const model = resolveKnownModel(displayName);
  const provider = model ? getProviderForModel(model) : undefined;
  if (!model || !provider) {
    return { status: 'missing', detail: 'Model is not available.' };
  }
  if (provider === 'cursor') {
    return (await isCursorRuntimeAvailable())
      ? { status: 'available', detail: 'Cursor is connected.' }
      : {
          status: 'missing',
          detail: 'Connect Cursor in Settings to run this workflow.',
        };
  }
  if (provider === 'ollama') {
    const state = await getOllamaService().getState();
    const installed = state.models.some(
      (candidate) =>
        candidate.id === model || candidate.rawModelId === displayName,
    );
    return state.installation.ready && installed
      ? { status: 'available', detail: 'Model is installed.' }
      : { status: 'missing', detail: 'Model is not installed.' };
  }

  const gatewayRoute = resolveGatewayModelEntry(model);
  const ownerPromise = resolveNavigationWorkOwner();
  const [nativeAuth, credits] = await Promise.all([
    gatewayRoute?.gatewayOnly
      ? Promise.resolve(null)
      : provider === 'claude'
        ? getCachedClaudeAuthStatusObserved('pipeline-package-readiness')
        : getCachedCodexAuthStatusObserved('pipeline-package-readiness'),
    gatewayRoute
      ? ownerPromise.then((owner) =>
          getAiCreditsRoutingContextWithStatus({ owner }),
        )
      : Promise.resolve(null),
  ]);
  if (nativeAuth?.authenticated === true) {
    return { status: 'available', detail: 'Provider is connected.' };
  }
  if (credits?.context?.creditsEligible === true) {
    return { status: 'available', detail: 'AI Credits are available.' };
  }
  if (
    nativeAuth?.probeFailed === true ||
    credits?.degraded === true ||
    credits?.context?.creditsEligibilityKnown === false
  ) {
    return UNKNOWN_REQUIREMENT;
  }
  return {
    status: 'missing',
    detail: gatewayRoute?.gatewayOnly
      ? 'AI Credits are required for this model.'
      : 'Connect the model provider or enable AI Credits.',
  };
}

export async function probePipelinePackageRequirement(
  requirement: PipelinePackageEnvironmentRequirement,
): Promise<RequirementAvailability> {
  try {
    if (requirement.kind === 'connector') {
      if (!/^github(?: authentication)?$/i.test(requirement.displayName)) {
        return UNKNOWN_REQUIREMENT;
      }
      const auth = await resolveGitHubTokenWithSource();
      return auth.token
        ? { status: 'available', detail: 'GitHub is connected.' }
        : { status: 'missing', detail: 'GitHub is not connected.' };
    }

    if (requirement.kind === 'model') {
      return probePipelinePackageModel(requirement.displayName);
    }

    if (requirement.kind === 'mcp') {
      const byCatalogId = await getMcpServerStatusByCatalogId(
        requirement.displayName,
      );
      return mcpRequirementAvailability(
        byCatalogId ??
          (await getMcpServerStatusByName(requirement.displayName)),
      );
    }

    if (
      requirement.kind === 'runtime' &&
      requirement.displayName === 'ollama'
    ) {
      const state = await getOllamaService().getState();
      return state.installation.ready
        ? { status: 'available', detail: 'Runtime is installed.' }
        : { status: 'missing', detail: 'Runtime is not installed.' };
    }

    if (requirement.kind === 'runtime' || requirement.kind === 'command') {
      const executable = requirement.displayName;
      if (!/^[A-Za-z0-9._+-]+$/.test(executable)) {
        return { status: 'missing', detail: 'Executable probe is invalid.' };
      }
      const enhancedPath = getEnhancedEnv({
        includeCanopySecrets: false,
        environment: false,
      }).PATH;
      return findExecutableOnPath(executable, enhancedPath)
        ? { status: 'available', detail: 'Executable is installed.' }
        : { status: 'missing', detail: 'Executable is not installed.' };
    }
  } catch {
    return UNKNOWN_REQUIREMENT;
  }
  return UNKNOWN_REQUIREMENT;
}
