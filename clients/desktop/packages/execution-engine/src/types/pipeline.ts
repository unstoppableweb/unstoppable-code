import type { CuratedPipelineOrigin } from '@canopy/protocol/pipelines';
import type {
  PublicShareVersion,
  ShareFailure,
} from '@canopy/protocol/sharing';
// Definition types and semantic helpers have one environment-neutral implementation.
import type {
  PipelineScalar,
  PipelineJsonValue,
  PipelineMatrixCombination,
  LogFormatHint,
  Step,
  NormalizedJob,
  NormalizedPipeline,
  PipelineTriggerConfig,
  PipelineTrigger,
  Pipeline,
  PipelineInputValue,
  PipelineInputDef,
} from '@canopy/pipeline-interop/document';
export type {
  PipelineScopeConfig,
  PipelineScalar,
  PipelineIntegerOrExpression,
  PipelineJsonValue,
  PipelineMatrixCombination,
  PipelineMatrixAxis,
  PipelineMatrixDefinition,
  JobStrategy,
  ShellType,
  LogFormatHint,
  RunDefaults,
  PipelineDefaults,
  PipelineRunTarget,
  Step,
  Job,
  NormalizedStep,
  NormalizedJob,
  NormalizedMatrixStrategy,
  NormalizedPipeline,
  PipelineDependencyAffectedStep,
  NormalizedPipelineDependency,
  PipelineDispatchTrigger,
  PipelinePlanReadyTrigger,
  PipelineTaskReadyTrigger,
  PipelineTriggerConfig,
  PipelineTrigger,
  Pipeline,
  PipelinePluginDefault,
  PipelinePluginCollection,
  PipelineInlineModelAliasDefaults,
  PipelineAgentModelAliasDefaults,
  PipelineModelAliasDefaults,
  PipelineModelAlias,
  PipelineInputValue,
  PauseInputType,
  PipelineInputType,
  PipelineInputDef,
  PipelineAssetInstallMode,
  PipelineAssetDeclaration,
  NormalizedPipelineAssetDeclaration,
} from '@canopy/pipeline-interop/document';
import { getTriggerTypes } from '@canopy/pipeline-interop/document';
export {
  parseLogFormatHint,
  getTriggerTypes,
  normalizeNeeds,
  getJobOrder,
} from '@canopy/pipeline-interop/document';
import { PIPELINE_EXECUTION_SCOPES } from '@canopy/protocol/pipelines';
import type {
  PipelineDependency,
  PipelineDependencyFallback,
  PipelineDependencyInput,
  PipelineDependencyKind,
} from '@canopy/protocol/pipelines';
import type {
  PipelineDistributionMode,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageManifestV1,
  PipelinePackagePublisherNote,
  PipelinePackageResource,
  PipelinePackageBinding,
  PipelinePackageStepBinding,
  PipelinePackageSubjectBinding,
  PipelinePackageSummary,
} from '@canopy/protocol/pipelines';
import type {
  CanopyOrganizationSummary as ProtocolCanopyOrganizationSummary,
  CanopyTeamSummary as ProtocolCanopyTeamSummary,
  ListSharedPipelinesResponse as ProtocolListSharedPipelinesResponse,
  ListSharedOrganizationsResponse as ProtocolListSharedOrganizationsResponse,
  ListSharedTeamsResponse as ProtocolListSharedTeamsResponse,
  PipelineExecutionScope,
  PipelineIndexEntry,
  PipelineInfo,
  PipelineShareOwner as ProtocolPipelineShareOwner,
  PipelineShareScope as ProtocolPipelineShareScope,
  PipelineTriggerType,
  SharedPipelineDetail as ProtocolSharedPipelineDetail,
  SharedPipelinePublicShareInfo as ProtocolSharedPipelinePublicShareInfo,
  SharedPipelineSummary as ProtocolSharedPipelineSummary,
  SharedPipelineTriggerType as ProtocolSharedPipelineTriggerType,
} from '@canopy/protocol/pipelines';

// Re-export the cross-package execution-scope and pipeline catalog types so
// desktop-shared consumers depend on one source of truth (mirrors how
// `PipelineShareScope` is re-exported below). `apps/web`/`packages/protocol`
// must not import these from desktop-shared — they import directly from
// `@canopy/protocol`.
export { PIPELINE_EXECUTION_SCOPES };
export type {
  PipelineExecutionScope,
  PipelineIndexEntry,
  PipelineInfo,
  PipelineTriggerType,
};

// Re-export the cross-package dependency-manifest contracts (CAN-1314) so
// desktop-shared consumers depend on one source of truth. `apps/web` and
// `packages/protocol` import these directly from `@canopy/protocol`.
export type {
  PipelineDependency,
  PipelineDependencyFallback,
  PipelineDependencyInput,
  PipelineDependencyKind,
  PipelineDistributionMode,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageManifestV1,
  PipelinePackagePublisherNote,
  PipelinePackageResource,
  PipelinePackageBinding,
  PipelinePackageStepBinding,
  PipelinePackageSubjectBinding,
  PipelinePackageSummary,
};

/**
 * Publisher-side package-analysis contracts live in `@canopy/protocol/pipelines`
 * so the shared share dialog (`@canopy/ui-app/sharing`) can render the
 * dependency review in both hosts; re-exported here for existing callers.
 */
export type {
  PipelinePackageAnalysisBlocker,
  PipelinePackageAnalysisState,
  PipelinePackageAnalysisSummary,
  PipelinePackageBlockerCode,
  PipelinePackageInvocationDismissal,
  PipelinePackageLimit,
  PipelinePackagePackagedPipeline,
  PipelinePackageProgressEvent,
  PipelinePackagePromptSpan,
  PipelinePackageReferenceDismissal,
  PipelinePackageWithheldFile,
  PipelinePackageWithheldReason,
} from '@canopy/protocol/pipelines';
import type {
  PipelinePackageInvocationDismissal,
  PipelinePackageReferenceDismissal,
} from '@canopy/protocol/pipelines';

export interface RepoLocalInvocableEntry {
  id: string;
  provider: 'claude';
  kind: 'plugin_command' | 'standalone_skill';
  invocationKey: string;
  displayName: string;
  sourceLabel: string;
}

export interface RepoLocalInvocableIndex {
  entries: RepoLocalInvocableEntry[];
  scannedDirectories: string[];
}

export interface PipelinePackageExecutionSnapshot {
  digest: string;
  pipelineContentHash: string;
  cachedPackagePath: string;
  bindings: PipelinePackageBinding[];
  capturedAt: string;
}

export interface PipelinePackageCapabilityOverlay {
  packageDigest: string;
  resources: Array<{
    installedItemRef?: InstalledItemRef;
    virtualSourceId: string;
    resourceId: string;
    provider: 'claude' | 'codex';
    rootPath: string;
    kind: PipelinePackageResource['kind'];
    displayName: string;
    invocationKeys: string[];
  }>;
}

interface PipelinePackageInstallRecordCommonV1 {
  localPipelineId: string;
  originExternalId?: string;
  pipelineContentHash: string;
  installedAt: string;
}

/**
 * What a capability-package install belongs to.
 *
 * The `pipeline` and `automation` shapes keep their original field names
 * verbatim: ledger rows written by earlier builds carry them, and renaming
 * would orphan every existing install. Subjects added since use the uniform
 * `localId` field.
 */
export type CapabilityPackageInstallOwner =
  | { kind: 'pipeline'; localPipelineId: string }
  | { kind: 'automation'; localAutomationId: string }
  | { kind: CapabilityPackageInstallOwnerKind; localId: string };

/** Owner kinds that use the uniform `localId` field. */
export type CapabilityPackageInstallOwnerKind =
  | 'skill'
  | 'agent'
  | 'collection'
  | 'blueprint'
  | 'shared-container';

export const CAPABILITY_PACKAGE_INSTALL_OWNER_KINDS: readonly CapabilityPackageInstallOwnerKind[] =
  ['skill', 'agent', 'collection', 'blueprint', 'shared-container'];

interface CapabilityPackageInstallRecordCommonV1 {
  owner: CapabilityPackageInstallOwner;
  originExternalId?: string;
  /** Hash of the recipient-bound local content when it differs from the package manifest. */
  localContentHash?: string;
  pipelineContentHash: string;
  installedAt: string;
  /** False when recipient-modified supporting files prevented full materialization. */
  supportingFilesComplete?: boolean;
}

export type CapabilityPackageInstallRecordV1 =
  | (CapabilityPackageInstallRecordCommonV1 & {
      distributionMode?: 'package';
      packageDigest: string;
    })
  | (CapabilityPackageInstallRecordCommonV1 & {
      distributionMode: 'definition_only';
      packageDigest?: never;
    });

export type PipelinePackageInstallRecordV1 =
  | (PipelinePackageInstallRecordCommonV1 & {
      /** Missing on records written before distribution mode was persisted. */
      distributionMode?: 'package';
      packageDigest: string;
    })
  | (PipelinePackageInstallRecordCommonV1 & {
      distributionMode: 'definition_only';
      packageDigest?: never;
    });

export interface PipelinePackageReadiness {
  status: 'ready' | 'setup_required' | 'invalid';
  /** Present when readiness is tied to installed/shared distribution content. */
  distributionMode?: 'package' | 'definition_only';
  requirements: Array<
    PipelinePackageEnvironmentRequirement & {
      status: 'available' | 'missing' | 'unknown';
      detail?: string;
    }
  >;
  /** Publisher assertions that are informational and never block a run. */
  publisherNotes?: PipelinePackagePublisherNote[];
  /** Embedded resources shown during automation install review. */
  includedResources?: Array<
    Pick<PipelinePackageResource, 'id' | 'displayName' | 'kind'> & {
      executableFiles?: string[];
    }
  >;
}

/**
 * Renderer -> main request for a local dependency analysis of the in-memory
 * pipeline document. Pipeline identity/content, an optional worktree identity,
 * and the publisher's package choices cross the boundary; private dependency
 * bytes and checkout paths never reach the renderer.
 */
export interface PipelinePackageAnalyzeRequest {
  sourcePipeline?: PipelineShareSource;
  /** Canonical YAML of the document being shared. */
  rawPipeline: string;
  /** Local catalog id of the pipeline, when it has one. */
  pipelineId?: string;
  worktree?: { projectId: string; worktreeId: string; repoId?: string };
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
  /**
   * Reference blockers the publisher dismissed. A dismissed
   * `child_pipeline_ref` shares the pipeline without that child.
   */
  dismissedReferences?: PipelinePackageReferenceDismissal[];
  /** Optional resource ids the publisher has opted in to including. */
  selectedOptionalResourceIds?: string[];
}

/** Renderer -> main cancellation for an in-flight analysis. */
export interface PipelinePackageCancelAnalysisRequest {
  analysisId: string;
}

/**
 * Renderer -> main request to create a `package` shared pipeline. Carries the
 * normal shared-pipeline write fields plus the analysis the publisher
 * reviewed and consented to; the main process re-reads dependency bytes from
 * disk, uploads them, and commits the package before creating the pipeline.
 */
export interface PipelinePackageCreateSharedRequest extends SharedPipelineWriteRequest {
  /** Existing cloud row to update in place; omitted for the first share. */
  remoteId?: string;
  /** Always `'package'` — the packaged create has no definition-only mode. */
  distributionMode: 'package';
  analysisId: string;
  selectedOptionalResourceIds: string[];
}

/** Renderer -> main request for the local readiness of a pipeline's package. */
export interface PipelinePackageReadinessRequest {
  pipeline: PipelineLookupRequest;
}

/**
 * Renderer -> main request to install a reviewed public package share. The
 * main process downloads and verifies every blob against the pinned digest
 * before writing anything; a failure leaves no local pipeline behind.
 */
export type PipelinePackageInstallRequest = {
  externalId: string;
  expectedPipelineContentHash: string;
} & (
  | {
      expectedDistributionMode: 'package';
      expectedPackageDigest: string;
    }
  | {
      expectedDistributionMode: 'definition_only';
      expectedPackageDigest?: never;
    }
);

export type PipelinePackageInstallResult =
  | {
      localPipelineId: string;
      distributionMode: 'package';
      packageDigest: string;
      /** Number of packaged resources written, for terminal status copy. */
      resourceCount: number;
    }
  | {
      localPipelineId: string;
      distributionMode: 'definition_only';
      resourceCount: 0;
    };

import type { ThinkingLevel } from './thinking';
import type { ModelHarness } from './model-harnesses';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type {
  AgentModelConfig,
  ChatTabPluginSelections,
} from '../execution-types';
import type { UsageInitiationSource } from './observability';

export type MatrixContext = Record<string, PipelineJsonValue>;

export interface MaterializedJob extends Omit<NormalizedJob, 'strategy'> {
  physical_job_id: string;
  logical_job_id: string;
  matrix?: {
    index: number;
    total: number;
    values: PipelineMatrixCombination;
  };
  artifact_locator?: {
    /** Original v7 job id used only when reading migrated execution artifacts. */
    job_id: string;
    /** Original v7 child id used only when reading migrated execution artifacts. */
    matrix_child_id?: string;
  };
}

export interface JobGroupResult {
  job_id: string;
  kind: 'single' | 'matrix';
  expansion: 'pending' | 'expanded' | 'failure';
  variant_job_ids: string[];
  status: JobResult['status'];
  conclusion?: StepConclusion;
  outcome?: StepConclusion;
  error?: string;
  started_at?: string;
  completed_at?: string;
  resolved_max_parallel?: number;
  fail_fast?: boolean;
  legacy_foreach_v7?: boolean;
}

/**
 * Read the input definitions for a specific trigger type from a trigger value.
 * Returns `undefined` when the trigger type is not present or has no inputs.
 */
export function getTriggerInputDefs(
  trigger: PipelineTrigger | undefined | null,
  type: PipelineTriggerType,
): Record<string, PipelineInputDef> | undefined {
  if (trigger == null || typeof trigger === 'string') {
    return undefined;
  }

  const triggerConfig = trigger[type];
  if (!triggerConfig || typeof triggerConfig !== 'object') {
    return undefined;
  }

  return triggerConfig.inputs;
}

/**
 * Build a new PipelineTrigger from the given trigger types.
 *
 * When multiple trigger types are selected, dispatch, plan_ready, task_ready
 * and workflow configuration (e.g. inputs) is preserved from `current`. When switching
 * to a single trigger, only that trigger's config is preserved.
 */
export function setTriggerTypes(
  current: PipelineTrigger,
  nextTypes: PipelineTriggerType[],
): PipelineTrigger {
  const uniqueTypes = Array.from(new Set(nextTypes));

  if (uniqueTypes.length === 0) {
    return 'dispatch';
  }

  if (uniqueTypes.length === 1 && uniqueTypes[0] === 'dispatch') {
    const hasInputs =
      typeof current !== 'string' && current.dispatch?.inputs !== undefined;
    if (!hasInputs) {
      return 'dispatch';
    }
  }

  if (uniqueTypes.length === 1 && uniqueTypes[0] === 'plan_ready') {
    const existingPlanReady =
      typeof current !== 'string' ? current.plan_ready : undefined;
    if (existingPlanReady && Object.keys(existingPlanReady).length > 0) {
      return { plan_ready: existingPlanReady };
    }
    return 'plan_ready';
  }

  if (uniqueTypes.length === 1 && uniqueTypes[0] === 'task_ready') {
    const existingTaskReady =
      typeof current !== 'string' ? current.task_ready : undefined;
    if (existingTaskReady && Object.keys(existingTaskReady).length > 0) {
      return { task_ready: existingTaskReady };
    }
    return 'task_ready';
  }

  if (uniqueTypes.length === 1 && uniqueTypes[0] === 'workflow') {
    const existingWorkflow =
      typeof current !== 'string' ? current.workflow : undefined;
    if (existingWorkflow && Object.keys(existingWorkflow).length > 0) {
      return { workflow: existingWorkflow };
    }
    return 'workflow';
  }

  const config: PipelineTriggerConfig = {};

  if (uniqueTypes.includes('dispatch')) {
    const existingDispatch =
      typeof current !== 'string' ? current.dispatch : undefined;
    config.dispatch = existingDispatch ?? {};
  }

  if (uniqueTypes.includes('plan_ready')) {
    const existingPlanReady =
      typeof current !== 'string' ? current.plan_ready : undefined;
    config.plan_ready = existingPlanReady ?? {};
  }

  if (uniqueTypes.includes('task_ready')) {
    const existingTaskReady =
      typeof current !== 'string' ? current.task_ready : undefined;
    config.task_ready = existingTaskReady ?? {};
  }

  if (uniqueTypes.includes('workflow')) {
    const existingWorkflow =
      typeof current !== 'string' ? current.workflow : undefined;
    config.workflow = existingWorkflow ?? {};
  }

  return config;
}

/**
 * Update the input definitions for a specific trigger type on a PipelineTrigger.
 *
 * Ensures the target trigger type is present in the resulting value, preserves
 * sibling trigger configuration (including other inputs), and collapses to a
 * simple trigger-type string when no inputs are defined anywhere.
 */
export function setTriggerInputDefs(
  current: PipelineTrigger,
  type: PipelineTriggerType,
  inputs: Record<string, PipelineInputDef> | undefined,
): PipelineTrigger {
  const currentTypes = getTriggerTypes(current);
  const activeTypes: PipelineTriggerType[] = currentTypes.includes(type)
    ? currentTypes
    : [...currentTypes, type];

  const normalizedInputs =
    inputs && Object.keys(inputs).length > 0 ? inputs : undefined;

  const config: PipelineTriggerConfig = {};
  for (const t of activeTypes) {
    const existingInputs =
      t === type ? normalizedInputs : getTriggerInputDefs(current, t);
    if (t === 'dispatch') {
      config.dispatch = existingInputs ? { inputs: existingInputs } : {};
    } else if (t === 'plan_ready') {
      config.plan_ready = existingInputs ? { inputs: existingInputs } : {};
    } else if (t === 'task_ready') {
      config.task_ready = existingInputs ? { inputs: existingInputs } : {};
    } else if (t === 'workflow') {
      config.workflow = existingInputs ? { inputs: existingInputs } : {};
    }
  }

  if (activeTypes.length === 1) {
    const only = activeTypes[0];
    const onlyConfig = config[only];
    if (!onlyConfig?.inputs) {
      return only;
    }
  }

  return config;
}

/**
 * Per-run/per-automation inline override for a single alias id.
 */
export interface PipelineInlineModelAliasPreference {
  mode: 'inline';
  base: string;
  instructions?: string;
  plugin_collection_id?: string;
}

/**
 * Per-run/per-automation Agent override for a single alias id.
 */
export interface PipelineAgentModelAliasPreference {
  mode: 'agent';
  agent_id: string;
  base?: string;
}

/**
 * Transient run-scoped tombstone (see "Reset tombstone contract"): force the
 * pipeline `alias.defaults` for this run, overriding any stored preference.
 * Never persisted to the per-pipeline preference store — the store normalizer
 * strips it on write, which IS the saved-default-deletion mechanism.
 */
export interface PipelineResetModelAliasPreference {
  mode: 'reset';
}

/**
 * A per-alias preference keyed by alias id, carrying a `mode` discriminator.
 * The `reset` variant is valid on the execute wire, the save-preferences
 * request, the automation-action field, and persisted
 * `ExecutionState.model_alias_preferences`, but NEVER on the load-preferences
 * response.
 */
export type PipelineModelAliasPreference =
  | PipelineInlineModelAliasPreference
  | PipelineAgentModelAliasPreference
  | PipelineResetModelAliasPreference;

/**
 * Canonical identifier used by the local preference store and by every
 * consumer that maps a pipeline execution back to its saved defaults.
 *
 * Wire/string serialization:
 *   { type: 'stored', source: 'bundled', value: 'plan-review' }
 *     -> "stored:bundled:plan-review"
 *   { type: 'stored', source: 'user', value: 'plan-review' }
 *     -> "stored:user:plan-review"
 *   { type: 'file', value: '/abs/foo.yaml' } -> "file:/abs/foo.yaml"
 *   { type: 'shared', value: 'srv-uuid:pipeline-uuid' }
 *     -> "shared:srv-uuid:pipeline-uuid"
 *
 * Inline pipelines (no source identity) omit the locator entirely. Shared
 * pipelines must NEVER fall back to `file:` — the cached file path is
 * per-execution and the canonical identity is the internal Cloud
 * `serverId:remoteId` pair.
 */
export type PipelinePreferenceLocator =
  | {
      type: 'stored';
      source: 'bundled' | 'user' | 'curated';
      value: string;
      /** Optional revision reviewed by a curated launch form; excluded from preference identity. */
      contentHash?: string;
    }
  | {
      type: 'file';
      value: string;
    }
  | {
      type: 'shared';
      value: string;
    };

/**
 * A per-pipeline override of a single collection: users can disable specific
 * default keys and/or add local-only extras (bundles, locally installed
 * skills/plugins/etc.).
 *
 * `extraSelections` reuses the existing shared `ChatTabPluginSelections` type.
 * The plugin-collection feature ignores `mcpServerRefs` on reads but does not
 * remove the field from the shared type.
 */
export interface PipelinePluginCollectionPreference {
  disabledDefaultKeys: string[];
  extraSelections: ChatTabPluginSelections;
}

/**
 * Preview-row shape surfaced to the trigger modal and to CLI previews.
 * One entry per pipeline-default, whether matched or not.
 */
export interface PipelinePluginDefaultPreviewItem {
  defaultKey: string;
  collectionId: string;
  kind: 'skill' | 'plugin';
  required: boolean;
  enabledByDefault: boolean;
  matchState: 'matched' | 'unmatched';
  matchedCatalogKey?: string;
  displayName: string;
  displayDescription: string;
  displaySource: string;
  displaySourceSubtitle?: string;
  warning?: string;
}

/**
 * Resolved snapshot for one collection: the effective selections after
 * applying defaults, per-pipeline preferences, and local extras. Persisted
 * into `ExecutionState` so `rerun` can re-use the original first-run
 * resolution instead of re-reading the store.
 */
export interface ResolvedPipelinePluginCollectionSnapshot {
  selections: ChatTabPluginSelections;
  /**
   * What a `send-agent-message` step sends (CAN-5479): the matched defaults
   * and the preference's own selections as stored, collections unexpanded,
   * since the chat resolves them itself. Absent in a run resolved before it.
   */
  chatSelections?: ChatTabPluginSelections;
  /** Collection identities expanded into selections, retained for replay authorization. */
  sourceCollectionIds?: string[];
  mcpServers?: Record<string, unknown>;
  missingOptionalDefaults: Array<{ defaultKey: string; warning: string }>;
  unresolvedRequiredDefaults: Array<{ defaultKey: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Pipeline plugin-collection IPC contracts (Phase T5)
// ---------------------------------------------------------------------------

/**
 * Request for `window.pipelines.resolvePluginCollections(...)`.
 *
 * `pipeline` may be an already-parsed `Pipeline` or raw YAML; when raw, the
 * handler normalizes it before resolving.
 *
 * `draftPreferences` are optional unsaved overrides originating from the
 * trigger modal.
 */
export interface ResolvePluginCollectionsRequest {
  pipeline: Pipeline | { yaml: string };
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  draftPreferences?: Record<string, PipelinePluginCollectionPreference>;
}

/**
 * Response for `window.pipelines.resolvePluginCollections(...)`.
 *
 * `effectivePreferences` are the merged preferences actually used to compute
 * `previewItems`. Merge order:
 *   1. stored prefs (if `pipelinePreferenceLocator` is set)
 *   2. `draftPreferences` overlays per-collection id (draft entries fully
 *      replace stored entries for that collection)
 *
 * When `draftPreferences` is omitted, `effectivePreferences` equals the
 * stored prefs verbatim.
 */
export interface ResolvePluginCollectionsResponse {
  previewItems: PipelinePluginDefaultPreviewItem[];
  effectivePreferences: Record<string, PipelinePluginCollectionPreference>;
  validation: {
    hasBlockingErrors: boolean;
    messages: Array<{
      collectionId?: string;
      severity: 'error' | 'warning';
      text: string;
    }>;
  };
}

/**
 * Request for `window.pipelines.savePluginCollectionPreferences(...)`.
 */
export interface SavePluginCollectionPreferencesRequest {
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  preferences: Record<string, PipelinePluginCollectionPreference>;
  /**
   * The stored preferences the caller's view was seeded from, as a
   * compare-and-set base. When another writer (such as the CLI) changed them
   * since, only the collections the caller changed from this base are saved
   * and the rest keep their stored values. Omitted, the save replaces the
   * stored preferences.
   */
  basePreferences?: Record<string, PipelinePluginCollectionPreference>;
}

/**
 * Response for `window.pipelines.savePluginCollectionPreferences(...)`.
 *
 * `reason: 'missing-locator'` is returned when the locator is omitted, which
 * happens for inline pipelines. Callers can use this to disable their Save
 * button rather than silently failing.
 *
 * On success, `preferences` holds the stored preferences as saved, and
 * `merged` is true when they had changed since `basePreferences`, so the
 * caller's view should show `preferences`.
 */
export type SavePluginCollectionPreferencesResponse =
  | {
      ok: true;
      preferences?: Record<string, PipelinePluginCollectionPreference>;
      merged?: boolean;
    }
  | { ok: false; reason: 'missing-locator' };

// ---------------------------------------------------------------------------
// Pipeline model-alias preference IPC contracts
// ---------------------------------------------------------------------------

/**
 * Request for `window.pipelines.loadModelAliasPreferences(...)`.
 *
 * Model aliases use a plain load + save pair (no resolve round-trip): their
 * defaults live in the pipeline YAML the renderer already has, and base-model /
 * Agent options come from renderer-accessible registries.
 */
export interface LoadModelAliasPreferencesRequest {
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
}

/**
 * Response for `window.pipelines.loadModelAliasPreferences(...)`.
 *
 * `preferences` NEVER contains `reset` markers — the backend store normalizer
 * strips them on save (see "Reset tombstone contract").
 */
export interface LoadModelAliasPreferencesResponse {
  preferences: Record<string, PipelineModelAliasPreference>;
}

/**
 * Request for `window.pipelines.saveModelAliasPreferences(...)`.
 *
 * `preferences` sent by the modal MAY contain `reset` markers; the store
 * normalizer strips them on write, which is how a saved default is deleted.
 */
export interface SaveModelAliasPreferencesRequest {
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  preferences: Record<string, PipelineModelAliasPreference>;
  aliasIds?: string[];
  /**
   * The stored preferences the caller's view was seeded from, as a
   * compare-and-set base. When another writer changed them since, only the
   * aliases the caller changed from this base are saved; see
   * {@link SavePluginCollectionPreferencesRequest.basePreferences}.
   */
  basePreferences?: Record<string, PipelineModelAliasPreference>;
}

/**
 * Response for `window.pipelines.saveModelAliasPreferences(...)`.
 *
 * `reason: 'missing-locator'` is returned when the locator is omitted (inline
 * pipelines). The frontend uses this to disable "save as defaults".
 *
 * On success, `preferences` and `merged` are as for
 * {@link SavePluginCollectionPreferencesResponse}; `preferences` never
 * contains `reset` markers.
 */
export type SaveModelAliasPreferencesResponse =
  | {
      ok: true;
      preferences?: Record<string, PipelineModelAliasPreference>;
      merged?: boolean;
    }
  | { ok: false; reason: 'missing-locator' };

import type {
  PauseInputField,
  PauseInputRequest,
} from '@canopy/pipeline-interop/pause-input-validation';
export type { PauseInputField, PauseInputRequest };

export interface ActionInputDef {
  description?: string;
  required?: boolean;
  default?: PipelineScalar;
}

export interface ActionOutputDef {
  description?: string;
  value?: string;
}

export interface NodeActionRuns {
  using: 'node';
  main: string;
}

export interface PythonActionRuns {
  using: 'python';
  main: string;
}

export interface TsxActionRuns {
  using: 'tsx';
  main: string;
}

export interface CompositeActionRuns {
  using: 'composite';
  steps: Step[];
}

export interface PipelineActionRuns {
  using: 'pipeline';
}

/** Node entry point a bundled host action runs when no host port takes it. */
export interface HostActionNodeFallback {
  using: 'node';
  main: string;
}

/**
 * A desktop host action behind `ExecutionRuntime.pipelineHostActions`; bundled
 * actions only. With a `fallback`, runtimes whose host port doesn't take the
 * action (no port, or one that doesn't declare it) run the Node entry point
 * instead; a port that takes the action never runs the fallback.
 */
export interface HostActionRuns {
  using: 'host';
  fallback?: HostActionNodeFallback;
}

export type ActionRuns =
  | NodeActionRuns
  | PythonActionRuns
  | TsxActionRuns
  | CompositeActionRuns
  | PipelineActionRuns
  | HostActionRuns;

export interface ActionDefinition {
  name: string;
  description?: string;
  /**
   * Normalized execution scopes for this action (always present after parse).
   * Action YAML declares `scope` (string or string array); the parser
   * normalizes it into `scopes`. An action with no declared `scope` is
   * compatible with all scopes (`global`, `directory`, `worktree`).
   */
  scopes: PipelineExecutionScope[];
  log_format_hint?: LogFormatHint;
  inputs?: Record<string, ActionInputDef>;
  outputs?: Record<string, ActionOutputDef>;
  runs: ActionRuns;
}

export type StepConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

/**
 * Identifies the originating hook that triggered a pipeline execution.
 *
 * Persisted on `ExecutionState.trigger_source` and surfaced through
 * `ExecutionSummary.trigger_source` so renderers can attribute pipeline
 * runs to the hook that launched them (hook name, timestamp, repo, etc.)
 * on details views and activity cards.
 */
export interface PipelineHookTriggerSource {
  kind: 'hook';
  /** Composite hook key (see `createHookKey()` in `src/shared/hooks.ts`). */
  hook_key: string;
  /** Human-friendly label for the hook (e.g. trigger display name). */
  hook_label: string;
  /** Trigger name that fired the hook (e.g. `pr:create`). */
  trigger_name: string;
  /** Scope of the hook that fired. */
  target: 'project' | 'workspace-root' | 'workspace-repo';
  /** Repo id when the hook fires from a workspace child repo. */
  repo_id?: string;
  /** Human-friendly repo name for activity attribution. */
  repo_name?: string;
  /** Index of the action within the hook's action list. */
  action_index: number;
  /** ISO timestamp captured at hook fire time. */
  triggered_at: string;
}

export type PipelineTriggerSource = PipelineHookTriggerSource;

export interface PlanReadyEventData {
  plan_path: string;
  planId?: string;
}

export interface TaskReadyEventData {
  task_path: string;
  plan_path: string;
}

export interface CanopyEventData {
  plan_ready?: PlanReadyEventData;
  task_ready?: TaskReadyEventData;
}

/**
 * Callers must provide at least one of `plan_text` or `plan_path`.
 * When only `plan_text` is provided, the executor writes it to a temp file.
 * When only `plan_path` is provided (e.g. nested pipelines), the existing
 * file is reused. Only `plan_path` is persisted into execution state.
 */
export interface PlanReadyEventInput {
  plan_text?: string;
  plan_path?: string;
  planId?: string;
}

/**
 * Callers must provide at least one of `task_text` or `task_path`.
 * When only `task_text` is provided, the executor writes it to a durable
 * execution-scoped file under the execution output directory.
 * When `plan_path` is omitted, the executor allocates a durable execution-
 * scoped plan path without creating the file.
 */
export interface TaskReadyEventInput {
  task_text?: string;
  task_path?: string;
  plan_path?: string;
}

export interface CanopyEventInput {
  plan_ready?: PlanReadyEventInput;
  task_ready?: TaskReadyEventInput;
}

export interface PlanReadyReplayData {
  plan_text: string;
}

export interface TaskReadyReplayData {
  task_text: string;
}

export interface CanopyReplayEventData {
  plan_ready?: PlanReadyReplayData;
  task_ready?: TaskReadyReplayData;
}

export interface ExecutionRerunContext {
  event_data?: CanopyReplayEventData;
}

export type PipelineStatusReasonKind =
  | 'provider_sign_in'
  | 'app_shutdown'
  /** A remote owner's delegation lease lapsed or it stopped answering (CAN-6102). */
  | 'owner_lost'
  /**
   * The run was checkpointed on request, after its running steps had until
   * a deadline to finish, so its host can roll over (CAN-6199).
   */
  | 'host_rollover'
  /**
   * The daemon core hosting the run was lost; its host ended the steps and
   * checkpointed the run (CAN-6481).
   */
  | 'core_lost'
  | 'input_required'
  | 'action_paused'
  | 'provider_authentication_required'
  | 'provider_usage_limit'
  | 'provider_temporarily_unavailable';

export type PipelineStatusReasonCode =
  | 'provider_sign_in'
  | 'app_shutdown'
  | 'owner_lost'
  | 'host_rollover'
  | 'core_lost'
  | 'input_requested'
  | 'action_requested_pause'
  | 'authentication_failed'
  | 'unauthorized'
  | 'oauth_organization_forbidden'
  | 'http_401'
  | 'rate_limit'
  | 'usage_limit_exceeded'
  | 'credits_depleted'
  | 'http_429'
  | 'model_capacity'
  | 'server_overloaded'
  | 'internal_server_error'
  | 'http_5xx'
  | 'connection_failed'
  | 'stream_disconnected'
  | 'provider_timeout';

/**
 * Addresses the step run that produced a status reason.
 *
 * Matrix variants use distinct physical `job_id` values, so this tuple remains
 * unambiguous even when multiple variants pause at the same step.
 */
export interface PipelineStatusReasonSource {
  job_id: string;
  step_id: string;
  attempt: number;
  iteration: number;
  /**
   * Nested child-pipeline execution id. Matrix variants do not use this field.
   */
  child_execution_id?: string;
  /** Status-reason id inside a nested **child execution** (pre-existing meaning). */
  child_reason_id?: string;
}

export interface PipelineStatusReason {
  /** Proxy quota belongs to this connection, never to the native account. */
  account_proxy_connection_id?: string;
  auto_resume_suppressed?: boolean;
  authentication_attempt_id?: string;
  id: string;
  kind: PipelineStatusReasonKind;
  code: PipelineStatusReasonCode;
  provider?: AgentProviderType;
  agent_harness?: ModelHarness;
  account_scope?: 'native' | 'ai_credits' | 'local';
  model?: string;
  detected_at: string;
  resets_at?: string;
  diagnostic_message?: string;
  source: PipelineStatusReasonSource;
}

export type PipelineStatusReasonSummary = Omit<
  PipelineStatusReason,
  'diagnostic_message'
>;

export interface AgentRecoveryCheckpoint {
  account_proxy_connection_id?: string;
  version: 1 | 2;
  reason_id: string;
  action: 'agent-prompt' | 'agent-resume';
  provider: AgentProviderType;
  /** Required on v2 checkpoints; optional only while reading legacy v1 data. */
  harness?: ModelHarness;
  /** Exact step path that produced this checkpoint, including composite nesting. */
  step_id?: string;
  session_id?: string;
  had_agent_activity: boolean;
  strategy: 'continue_session' | 'restart_step';
  recovery_count: number;
  paused_at: string;
  transcript_file?: string;
  failure_message: string;
}

export interface AgentRecoveryAttempt {
  reason: PipelineStatusReason;
  strategy: AgentRecoveryCheckpoint['strategy'];
  recovery_number: number;
  started_at: string;
  completed_at?: string;
  status: 'running' | 'paused' | 'success' | 'failure' | 'cancelled';
  log_file?: string;
}

export interface ResumeExecutionSelection {
  statusReasonIds?: string[];
}

/**
 * Compatibility projection populated only when exactly one input checkpoint
 * is pending. New code must use `pending_pauses`, which supports concurrent
 * input and action-pause checkpoints.
 */
export interface ExecutionStatePendingInput {
  job_id: string;
  step_id: string;
  request: PauseInputRequest;
}

export interface PipelinePauseCheckpoint {
  id: string;
  kind: 'input' | 'action';
  job_id: string;
  logical_job_id: string;
  step_id: string;
  attempt: number;
  iteration: number;
  detected_at: string;
  request?: PauseInputRequest;
}

export interface PipelinePauseResponse {
  checkpoint_id?: string;
  job_id: string;
  step_id: string;
  answers?: Record<string, PipelineScalar>;
}

export interface StepResult {
  status:
    | 'pending'
    /** Held before it starts while its host's memory is tight (CAN-6325). */
    | 'waiting_for_capacity'
    | 'running'
    | 'paused'
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped';
  conclusion?: StepConclusion;
  outcome?: StepConclusion;
  outputs: Record<string, string>;
  dynamic_env: Record<string, string>;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  error?: string;
  log_file?: string;
  resolved_run?: string;
  log_format_hint?: LogFormatHint;
  agent_provider?: AgentProviderType;
  agent_harness?: ModelHarness;
  agent_model?: string;
  agent_runtime_model?: string;
  agent_model_config?: PipelineAgentModelConfig;
  model_alias?: string;
  model_alias_name?: string;
  model_alias_plugin_collection_ids?: string[];
  /**
   * True when this `agent-prompt` step is running as a managed Claude Code
   * terminal worker (pipelines "Terminal" mode) rather than the in-process
   * Claude SDK. Published at worker launch on the still-`running` step so the
   * renderer can show the "Running in Terminal Mode" banner while the step is
   * in flight.
   */
  agentTerminalMode?: boolean;
  /**
   * Identifier of the Claude Worker terminal session backing this step when
   * {@link agentTerminalMode} is true. Lets the renderer target the live worker
   * card (e.g. a "View worker" jump). Set at worker launch alongside
   * {@link agentTerminalMode}, not at completion.
   */
  workerId?: string;
  /**
   * True while the backing Claude Worker is waiting on the concurrency cap
   * (queued, not yet launched). Set alongside {@link workerId}/{@link
   * agentTerminalMode} when the worker is enqueued and cleared once it launches,
   * so the renderer can show a "Queued" banner (with a live "View worker" jump
   * to the queued card) instead of "Running in Terminal Mode".
   */
  workerQueued?: boolean;
  report_outputs?: ReportOutputs;
  input_request?: PauseInputRequest;
  pause_requested?: boolean;
  agent_recovery?: AgentRecoveryCheckpoint;
  agent_recovery_history?: AgentRecoveryAttempt[];
  recovery_count?: number;
  /**
   * The Agent Ledger agent session of this step's attempt, present only when
   * the step's agent ran with Ledger tools. Resuming the step's recovery
   * checkpoint keeps it; a retried attempt mints another and records this
   * one as its predecessor.
   */
  ledger_agent_session_id?: string;
  /** Executor handoff for a newly paused step; mirrors the active top-level reason. */
  pause_reason?: PipelineStatusReason;
  pause_reasons?: PipelineStatusReason[];
  child_execution_id?: string;
  selected_child_reason_ids?: string[];
  /**
   * The chat send a `send-agent-message` host step recorded. Set whenever the
   * host returned one, including on a failed step whose message was already
   * accepted (a refused steer).
   */
  chat_send?: PipelineChatSendRecord;
}

/** A message a pipeline step sent to a project or bot chat. */
export interface PipelineChatSendRecord {
  version: 1;
  address:
    | { kind: 'project'; projectId: string; taskId: string; chatId: string }
    | { kind: 'bot'; botId: string; taskId: string; chatId: string };
  /** The accepted input id; `automation_run` watchers match it as `userMessageId`. */
  userMessageId: string;
  queuedMessageId?: string;
  state: 'sent' | 'queued' | 'steered';
  chatCreated: boolean;
  acceptedAt: string;
  turnId?: string;
}

export interface RetryAttempt {
  attempt: number;
  status: JobResult['status'];
  conclusion?: StepConclusion;
  outcome?: StepConclusion;
  steps: Record<string, StepResult>;
  started_at?: string;
  completed_at?: string;
  iteration_history?: IterationSnapshot[];
}

export interface IterationSnapshot {
  iteration: number;
  status: JobResult['status'];
  conclusion?: StepConclusion;
  outcome?: StepConclusion;
  steps: Record<string, StepResult>;
  started_at?: string;
  completed_at?: string;
}

export interface ReportOutputs {
  report_file?: string;
  report_json_file?: string;
}

export interface JobResult {
  status:
    | 'pending'
    | 'queued'
    /** A step that would start next is held for memory (CAN-6325). */
    | 'waiting_for_capacity'
    | 'running'
    | 'restarting'
    | 'paused'
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped';
  conclusion?: StepConclusion;
  outcome?: StepConclusion;
  steps: Record<string, StepResult>;
  outputs: Record<string, string>;
  started_at?: string;
  completed_at?: string;
  retry_count?: number;
  retry_history?: RetryAttempt[];
  iteration_count?: number;
  iteration_history?: IterationSnapshot[];
  report_outputs?: ReportOutputs;
}

/** Immutable managed source captured for replay, independent of subsequent catalog updates. */
export interface CuratedPipelineExecutionSource {
  key: string;
  contentHash: string;
  revision: number;
  cachedPipelinePath: string;
}

/**
 * Snapshot of the Canopy Cloud pipeline source captured at execute time so
 * subsequent retries / rerun-from-state execute the same pipeline body.
 * Replay authorization still contacts Cloud to check the share's current owner.
 *
 * Persisted into `ExecutionState.shared_pipeline_source` only when a pipeline
 * is launched from a shared source (`PipelineInfo.source === 'shared'`).
 */
export interface SharedPipelineExecutionSource {
  type: 'shared';
  /** Internal singleton Cloud source id. */
  serverId: string;
  /** Display name of the Cloud source (cached for execution metadata). */
  serverName: string;
  /** External UUID of the pipeline on Canopy Cloud. */
  remoteId: string;
  /** Absolute path to the cached raw pipeline file inside this execution's directory. */
  cachedPipelinePath: string;
  /** ISO 8601 timestamp the snapshot was captured. */
  fetchedAt: string;
}

/**
 * Resolved, concrete execution target persisted onto `ExecutionState` and
 * carried on `ExecutionOptions`. Unlike `PipelineRunTarget` (the step-level
 * *request*, which may be `inherit` or a not-yet-created worktree), this is
 * the fully resolved location an execution actually runs in.
 */
export type ResolvedPipelineExecutionTarget =
  | { scope: 'global' }
  | { scope: 'directory'; path: string }
  | {
      scope: 'worktree';
      workspace_id: string;
      worktree_id: string;
      path: string;
      created: boolean;
    };

/** Live scheduler state for desktop displays; never persisted in execution files. */
export interface PipelineTransientRetryState {
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  exhausted: boolean;
}

export interface ChildPipelineAuthorization {
  request: string;
  identity: string;
  contentHash: string;
}

/** The agent chat that started a run or wrote a pipeline or automation. */
export interface PipelineAgentChatAddress {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Who started a run, recorded by main from a trusted caller. Identity, not
 * usage attribution: `initiation_source` keeps its usage values.
 */
export type PipelineExecutionInitiator =
  | { kind: 'user' }
  | { kind: 'hook' }
  | { kind: 'portal' }
  | {
      kind: 'automation';
      automationId: string;
      automationName?: string;
      /**
       * The run's gate command output (`ifCommand` stdout, truncated), which
       * `send-agent-message` puts into the prompt's gate tokens as the native
       * chat actions do (CAN-4551). Host-only: expressions and step
       * environments never read it, and summaries drop it.
       */
      ifCommandOutput?: string;
      /**
       * A scheduled run, whose chats stay behind the current tab as the
       * native chat actions' did; absent for Run now (CAN-4551). Host-only.
       */
      background?: true;
    }
  | { kind: 'app_advisor'; chat?: PipelineAgentChatAddress }
  | { kind: 'agent'; chat: PipelineAgentChatAddress };

/** Marker for a pipeline or automation an agent wrote. */
export interface PipelineAgentAuthor {
  chat: PipelineAgentChatAddress;
  recordedAt: string;
}

/** Run-time asset context; local paths only, never shared. */
export interface PipelineAssetExecutionContext {
  /** Resolved directory per declared asset id (`''` for a missing optional asset). */
  asset_paths: Record<string, string>;
  /** `<data>/pipeline-data/<key>/state`. */
  pipeline_data_dir?: string;
  /** `<data>/pipeline-data/<key>/assets`, the installed asset root. */
  assets_dir?: string;
}

export interface ExecutionState {
  /**
   * Serialized owner of the run (`personal` / `org:<uuid>`). Main sets it for
   * every top-level run; children inherit it. Older runs may omit it, which
   * every consumer treats as Personal.
   */
  execution_context?: string;
  /** Who started the run. Replays keep the source run's initiator. */
  initiator?: PipelineExecutionInitiator;
  /**
   * The agent chat whose admission rules apply to this run: the initiating
   * agent or App Advisor chat, else the stored pipeline's agent author.
   */
  agent_origin?: PipelineAgentChatAddress;
  child_pipeline_authorizations?: readonly ChildPipelineAuthorization[];
  authentication_pause?: { attempt_id: string; reason_ids: string[] };
  /** Ephemeral automatic recovery countdown, attached by the desktop scheduler. */
  transient_retry?: PipelineTransientRetryState;
  /** Resume token when shutdown precedes materialization of any physical step. */
  shutdown_checkpoint?: { id: string; detected_at: string };

  /**
   * Persistence-format version.
   *
   * - `6` introduced first-class active pause reasons and executor-only agent
   *   recovery checkpoints.
   * - `7` was the short-lived nested `foreach` representation from PR 2047.
   * - `8` stores matrix variants as flat physical jobs, logical job groups,
   *   materialized definitions, and multiple pause checkpoints.
   * - `9` records the execution harness on agent results, status reasons, and
   *   recovery checkpoints. The v8 -> v9 migration is a pure version bump;
   *   the new transport metadata remains optional for older executions.
   *
   * The optional `scope`/`target` fields below are additive and do NOT bump
   * the version: states persisted before they existed simply omit them and
   * are treated as `directory` by display/helper code.
   *
   * `CURRENT_EXECUTION_STATE_VERSION` and the migration ladder live in
   * `execution-state.ts`; this declaration is the type contract only.
   */
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  id: string;
  pipeline_id: string;
  pipeline_snapshot: NormalizedPipeline;
  status:
    | 'pending'
    | 'running'
    | 'paused'
    | 'success'
    | 'failure'
    | 'cancelled';
  /** Physical runtime jobs, keyed by physical job id. */
  jobs: Record<string, JobResult>;
  /** Materialized definitions for every physical runtime job. */
  job_definitions: Record<string, MaterializedJob>;
  /** Aggregate state for the logical jobs in {@link pipeline_snapshot}. */
  job_groups: Record<string, JobGroupResult>;
  started_at: string;
  completed_at?: string;
  /**
   * Instant the *execution* entered its current whole-run pause, cleared when
   * it leaves that pause. A single paused job or step inside an otherwise
   * running execution does not set this: the run clock only stops when the
   * whole run does. Display code freezes the run duration here.
   */
  paused_at?: string;
  /**
   * Milliseconds banked by whole-run pauses that have already closed, summed
   * across every pause in this run. Subtracted from wall-clock elapsed so the
   * reported duration is time the pipeline actually spent working.
   */
  paused_ms?: number;
  owner_pid?: number;
  /**
   * The owner's OS start identity when the host can prove it; a live
   * `owner_pid` with a different identity is a reused PID.
   */
  owner_start_identity?: string;
  /**
   * The delegation lease epoch of the cloud runner incarnation that owns the
   * run (CAN-6198). Absent for a local owner. A write from an older epoch is
   * refused; a run an older epoch recorded is this incarnation's to take.
   */
  owner_lease_epoch?: number;
  cwd: string;
  env: Record<string, string>;
  /**
   * Resolved trigger inputs for this run. Widened to
   * {@link PipelineInputValue} so `type: 'json'` inputs persist their
   * structured value verbatim. Scalar inputs keep their exact previous
   * serialization.
   */
  inputs: Record<string, PipelineInputValue>;
  pipeline_file_dir?: string;
  /**
   * Asset and data-dir paths main resolved before the run started. Persisted
   * so resumes, retries and child runs read the same `assets` and
   * `canopy.pipeline_data_dir` values as the original run.
   */
  pipeline_assets?: PipelineAssetExecutionContext;
  /** `ExecutionOptions.globalWorkspaceDir`, when its host named one (CAN-6317). */
  global_workspace_dir?: string;
  /** False when `inputs` was backfilled from a legacy execution that never persisted it. */
  inputs_persisted?: boolean;
  event_name?: PipelineTriggerType;
  event_data?: CanopyEventData;
  model_config?: AgentModelConfig;
  /** @deprecated Read only during migration. */
  codex_fast_mode_enabled?: boolean;
  repo_path?: string;
  /** Retained checkout boundary; null means unavailable, never inferred from narrowed cwd. */
  execution_checkout_root?: string | null;
  project_id?: string;
  worktree_id?: string;
  planId?: string;
  plan_hash_before?: string;
  plan_hash_after?: string;
  error?: string;
  report_outputs?: ReportOutputs;
  /** @deprecated Version 1-7 migration input only. */
  pending_input?: ExecutionStatePendingInput;
  pending_pauses: PipelinePauseCheckpoint[];
  /** Active blockers only. Consumed blockers live in step recovery history. */
  status_reasons: PipelineStatusReason[];
  rerun_context?: ExecutionRerunContext;
  rerun_source_id?: string;
  /**
   * Command receipts for accepted in-place Portal controls. They are persisted
   * with the resume or retry transition so command redelivery can return the
   * current run without repeating the action.
   */
  portal_command_ids?: string[];
  parent_execution_id?: string;
  parent_step_id?: string;
  parent_attempt?: number;
  parent_iteration?: number;
  hidden?: boolean;
  /**
   * Attribution for the hook (or other automated trigger) that launched
   * this execution. Used by the renderer to render hook-source badges on
   * pipeline activity cards and details views.
   */
  trigger_source?: PipelineTriggerSource;
  /**
   * Surface that initiated the execution. Forward-looking only; older
   * persisted executions omit this and usage recording defaults them to user
   * unless `trigger_source` identifies a hook.
   */
  initiation_source?: UsageInitiationSource;
  /**
   * Plugin-collection fields added at version 3. All three default to
   * `undefined` when a pipeline has no `plugin_collections`.
   */
  pipeline_preference_locator?: PipelinePreferenceLocator;
  plugin_collection_preferences?: Record<
    string,
    PipelinePluginCollectionPreference
  >;
  resolved_plugin_collections?: Record<
    string,
    ResolvedPipelinePluginCollectionSnapshot
  >;
  /**
   * Per-run model-alias overrides keyed by alias id.
   * - `undefined` means no aliases or no overrides.
   * - An empty object should be treated as no overrides.
   * - May carry `reset` markers (run-scoped), unlike the on-disk preference
   *   store which strips them on write.
   *
   * `ExecutionState.pipeline_snapshot` is a `NormalizedPipeline`, so
   * `pipeline_snapshot.model_aliases` is available to the executor with no
   * extra plumbing. The migration logic that defaults/normalizes this field
   * lives in the backend plan (`execution-state.ts`); the transport layer only
   * declares the field shape.
   */
  model_alias_preferences?: Record<string, PipelineModelAliasPreference>;
  /**
   * Snapshot of the shared pipeline source (added at version 4). Populated
   * only when the execution was launched from a Canopy Cloud shared pipeline.
   * Carries the cached raw-pipeline file path so retry / rerun can replay the
   * snapshot without replacing it with a newer Cloud definition. Replay
   * authorization still contacts Cloud for the current owner.
   */
  shared_pipeline_source?: SharedPipelineExecutionSource;
  curated_pipeline_source?: CuratedPipelineExecutionSource;
  pipeline_package_snapshot?: PipelinePackageExecutionSnapshot;
  /**
   * Execution scope this run resolved to. Additive/optional: older persisted
   * states omit it and are treated as `directory` by display/helper code.
   */
  scope?: PipelineExecutionScope;
  /**
   * Resolved execution target for this run. Additive/optional: when absent,
   * infer `{ scope: 'directory', path: cwd }` in display/helper code only;
   * do not rewrite old state files unless they are resumed/rerun and
   * persisted through normal execution.
   */
  target?: ResolvedPipelineExecutionTarget;
}

export interface ExecutionSummary {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  status: ExecutionState['status'];
  status_reasons: PipelineStatusReasonSummary[];
  started_at: string;
  completed_at?: string;
  /** Mirrors {@link ExecutionState.paused_at} so list views can stop the clock. */
  paused_at?: string;
  /** Mirrors {@link ExecutionState.paused_ms} so list views can discount pauses. */
  paused_ms?: number;
  cwd: string;
  event_name?: PipelineTriggerType;
  project_id?: string;
  worktree_id?: string;
  planId?: string;
  plan_modified?: boolean;
  has_plan?: boolean;
  has_report?: boolean;
  rerun_source_id?: string;
  parent_execution_id?: string;
  parent_step_id?: string;
  parent_attempt?: number;
  parent_iteration?: number;
  child_count?: number;
  hidden?: boolean;
  /**
   * Mirrors `ExecutionState.trigger_source` so list views can render hook
   * attribution without loading full execution state.
   */
  trigger_source?: PipelineTriggerSource;
  /** Mirrors {@link ExecutionState.execution_context} for owner filing. */
  execution_context?: string;
  /** Mirrors {@link ExecutionState.initiator} for initiator-scoped access. */
  initiator?: PipelineExecutionInitiator;
}

// ---------------------------------------------------------------------------
// Pipeline Advisor (Persistent Supervisor) transport types
// ---------------------------------------------------------------------------

/**
 * Kind of advisor turn that produced the report. The supervisor runs an
 * `initial` turn shortly after a pipeline starts, `periodic` turns while it is
 * still in flight, and a `final` turn after the pipeline reaches a terminal
 * state.
 */
export type PipelineAdvisorTurnKind = 'initial' | 'periodic' | 'final';

/**
 * Overall health verdict surfaced on each advisor report. The backend
 * normalizes the SDK output to one of these values; consumers can treat any
 * other string as `'unknown'`.
 */
export type PipelineAdvisorHealthStatus =
  | 'healthy'
  | 'watch'
  | 'degraded'
  | 'blocked'
  | 'complete'
  | 'unknown';

export type PipelineAdvisorSeverity = 'info' | 'warning' | 'critical';

export interface PipelineAdvisorEta {
  status: 'available' | 'unknown' | 'complete';
  expectedCompletionAt?: string;
  remainingSeconds?: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface PipelineAdvisorInefficiency {
  severity: PipelineAdvisorSeverity;
  title: string;
  evidence: string;
  recommendation?: string;
  relatedJobId?: string;
  relatedStepId?: string;
}

/**
 * One advisor report produced by a single supervisor SDK turn. The backend
 * overwrites the trusted scalar fields (`version`, `reportId`, `executionId`,
 * `kind`, `generatedAt`, `pipelineStatus`) after validating the SDK output, so
 * consumers can rely on those fields even when the SDK returns malformed data.
 */
export interface PipelineAdvisorReport {
  version: 1;
  reportId: string;
  executionId: string;
  kind: PipelineAdvisorTurnKind;
  generatedAt: string;
  pipelineStatus: ExecutionState['status'];
  health: {
    status: PipelineAdvisorHealthStatus;
    /** Integer 0-100 — normalized and clamped by the main process. */
    score: number;
    summary: string;
    evidence: string[];
    blockers: string[];
  };
  eta: PipelineAdvisorEta;
  inefficiencies: PipelineAdvisorInefficiency[];
  summary: string;
  recommendations: string[];
}

/**
 * Persistent supervisor snapshot for a single pipeline execution. Stored at
 * `<executionsDir>/<executionId>/pipeline-advisor.json` and pushed to the
 * renderer via `PIPELINE_CHANNELS.ADVISOR_EVENT`.
 *
 * Snapshot status semantics:
 *   - `starting`  : created, no successful report yet.
 *   - `running`   : an SDK turn is active.
 *   - `waiting`   : between turns; `nextUpdateAt` is set. Retryable non-final
 *                   turn failures keep this status and populate `lastError`
 *                   until a later successful turn clears it.
 *   - `failed`    : advisor has stopped after a non-retryable or exhausted
 *                   turn failure.
 *   - `completed` : final advisor report succeeded for a success or failure
 *                   pipeline terminal state.
 *   - `cancelled` : final advisor report succeeded for a cancelled pipeline
 *                   terminal state.
 *
 * `sdkSessionId` is optional because the first turn allocates it; subsequent
 * turns resume the same session and must keep it stable.
 */
export interface PipelineAdvisorSnapshot {
  version: 1;
  executionId: string;
  executionDataDir: string;
  stateFilePath: string;
  provider: 'claude' | 'codex';
  model: string;
  thinkingLevel: ThinkingLevel;
  sdkSessionId?: string;
  status:
    | 'starting'
    | 'running'
    | 'waiting'
    | 'failed'
    | 'completed'
    | 'cancelled';
  turnCount: number;
  backoffIndex: number;
  lastUpdatedAt: string;
  /** Pipeline execution start time, used to label report history after restart. */
  pipelineStartedAt?: string;
  nextUpdateAt?: string;
  finalizedCompletedAt?: string;
  reports: PipelineAdvisorReport[];
  latestReport?: PipelineAdvisorReport;
  lastError?: {
    message: string;
    at: string;
    retryable: boolean;
    consecutiveFailures: number;
  };
}

/**
 * Push event emitted on `PIPELINE_CHANNELS.ADVISOR_EVENT` whenever the
 * supervisor mutates a snapshot (state change, new report, error).
 */
export interface PipelineAdvisorEvent {
  executionId: string;
  snapshot: PipelineAdvisorSnapshot;
  timestamp: string;
}

export interface ExecutionEvent {
  executionId: string;
  type:
    | 'execution.started'
    | 'execution.paused'
    | 'execution.updated'
    | 'execution.completed'
    | 'execution.cancelled'
    | 'execution.failed';
  state: ExecutionState;
  timestamp: string;
}

/**
 * Where one step output chunk sits in its persisted step log.
 *
 * A writer stamps this only when the chunk's UTF-8 bytes are exactly the bytes
 * it persisted, in the same order, to the log file of the event's identity
 * (execution, physical job, step path, attempt, iteration, recovery). The
 * offset may name bytes that are still queued for writing: every positioned
 * log has one serialized writer, so a reader always observes a prefix of the
 * generation's final content and never a gap that is filled out of order.
 */
export interface StepOutputLogPosition {
  /**
   * Content generation of the log file. A new generation starts whenever a
   * writer replaces or truncates the file (a new run of the same identity),
   * and generations only increase within one app process. Offsets from
   * different generations are unrelated.
   */
  generation: number;
  /** Byte offset in the log file where this chunk's UTF-8 bytes begin. */
  offset: number;
  /** UTF-8 byte length of the chunk as persisted. */
  byteLength: number;
}

export interface StepOutputEvent {
  executionId: string;
  jobId: string;
  jobName: string;
  stepId: string;
  stepName: string;
  attempt: number;
  iteration?: number;
  recovery?: number;
  stream: 'stdout' | 'stderr';
  data: string;
  /**
   * Byte position of `data` in the persisted log for this identity. Absent
   * when the writer cannot guarantee emitted bytes equal persisted bytes
   * (unpositioned writers, projected nested-pipeline output, and records that
   * are emitted but never persisted); consumers then fall back to textual
   * reconciliation.
   */
  logPosition?: StepOutputLogPosition;
}

export interface SpawnedProcessSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  scriptPath?: string;
}

export interface SpawnedProcessResult {
  status: StepResult['status'];
  conclusion: StepResult['conclusion'];
  outcome: StepResult['outcome'];
  exit_code?: number;
  error?: string;
  outputs: Record<string, string>;
  dynamic_env: Record<string, string>;
  log_file: string;
}

export interface SpawnedProcessResourceOptions {
  executionId: string;
  pipelineId?: string;
  pipelineName?: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
  childId?: string;
  label: string;
}

export interface SpawnedProcessRunOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeout_minutes: number;
  agentTerminalResultGraceMs?: number;
  logFile: string;
  outputFile: string;
  envFile: string;
  secretValues?: string[];
  onOutput?: (stream: StepOutputEvent['stream'], data: string) => void;
  resource?: SpawnedProcessResourceOptions;
}

export type SpawnedProcessRunner = (
  processSpec: SpawnedProcessSpec,
  options: SpawnedProcessRunOptions,
) => Promise<SpawnedProcessResult>;

/**
 * Addresses one step log file.
 *
 * Shared log path template (the writer is `getStepLogFilePath()` in
 * `step-runner.ts`; the readers are the renderer and the CLI):
 *
 * ```text
 * <executionsDir>/<executionId>/logs/{physicalJob}--{step}[--attemptN][--iterN][--recoveryN].log
 * ```
 *
 * Migrated v7 executions can retain an internal artifact locator that points
 * readers at their historical `{job}--{childId}--{step}` file.
 */
export interface StepLogLocator {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt?: number;
  iteration?: number;
  recovery?: number;
  logFilePath?: string;
}

/** Optional read shape for `readStepLog`; the default stays `lines`. */
export interface StepLogReadOptions {
  /**
   * `lines` (default) returns CRLF-normalized lines. `text` returns the raw
   * decoded content in `text` instead, ending at a complete UTF-8 character,
   * so a reader can join it byte-exactly with positioned output events;
   * `lines` is then empty so the content is not sent twice.
   */
  format?: 'lines' | 'text';
}

export interface StepLogReadResult {
  lines: string[];
  /** Raw decoded content; present only for `format: 'text'`. */
  text?: string;
  /**
   * File bytes this result represents. For `text`, a trailing partially
   * written UTF-8 character is excluded, so this is always a character
   * boundary; for `lines`, every byte read.
   */
  byteLength?: number;
  /**
   * Content generation of the file, present only when this process owns the
   * file's live positioned writer and no truncation or replacement overlapped
   * the read. `StepOutputEvent.logPosition` offsets with this generation can
   * be joined exactly against `byteLength`.
   */
  generation?: number;
}

// ---------------------------------------------------------------------------
// Matrix request interfaces. Both operations resolve with the updated
// `ExecutionState` and reject with an error carrying a MatrixIpcErrorCode.
// The code is the contract:
// consumers branch on it and never on message text. Message strings are
// advisory display copy owned by the main process.
// ---------------------------------------------------------------------------

export interface RetryMatrixJobRequest {
  executionId: string;
  jobId: string;
  mode: 'all' | 'failed' | 'variants' | 'expansion';
  variantJobIds?: string[];
}

export interface CancelMatrixVariantRequest {
  executionId: string;
  jobId: string;
  variantJobId: string;
}

export type MatrixIpcErrorCode =
  | 'matrix/execution-not-terminal'
  | 'matrix/group-not-terminal'
  | 'matrix/not-a-matrix-job'
  | 'matrix/unknown-variant'
  | 'matrix/variant-not-retryable'
  | 'matrix/empty-variant-selection'
  | 'matrix/execution-terminal'
  | 'matrix/running-variant-unowned'
  | 'matrix/retry-in-progress';

/**
 * A person's global start refused because the pipeline gained a saved owner
 * after the Run dialog read it; the dialog re-reads the pipeline on it.
 */
export const PIPELINE_NOW_OWNED_MESSAGE =
  'This pipeline now has an owner. Reopen it to run under that owner.';

/** The start refusal that carries {@link PIPELINE_NOW_OWNED_MESSAGE}. */
export const PIPELINE_NOW_OWNED_ERROR_CODE = 'pipeline_now_owned';

export const MATRIX_IPC_ERROR_CODES = [
  'matrix/execution-not-terminal',
  'matrix/group-not-terminal',
  'matrix/not-a-matrix-job',
  'matrix/unknown-variant',
  'matrix/variant-not-retryable',
  'matrix/empty-variant-selection',
  'matrix/execution-terminal',
  'matrix/running-variant-unowned',
  'matrix/retry-in-progress',
] as const satisfies readonly MatrixIpcErrorCode[];

const MATRIX_IPC_ERROR_MESSAGE_PATTERN = /\[(matrix\/[a-z-]+)\]\s*/;

export function isMatrixIpcErrorCode(
  value: unknown,
): value is MatrixIpcErrorCode {
  return (
    typeof value === 'string' &&
    MATRIX_IPC_ERROR_CODES.some((code) => code === value)
  );
}

export function encodeMatrixIpcErrorMessage(
  code: MatrixIpcErrorCode,
  message: string,
): string {
  return `[${code}] ${message}`;
}

export function decodeMatrixIpcErrorMessage(message: string): {
  code: MatrixIpcErrorCode | null;
  message: string;
} {
  const match = MATRIX_IPC_ERROR_MESSAGE_PATTERN.exec(message);
  if (!match || !isMatrixIpcErrorCode(match[1])) {
    return { code: null, message };
  }
  return {
    code: match[1],
    message: message.replace(MATRIX_IPC_ERROR_MESSAGE_PATTERN, '').trim(),
  };
}

export interface QueuedPipelineExecutionEntry {
  /** Unique identifier for this queue entry (distinct from executionId). */
  queueId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  /** Why the entry is queued. Currently only pipeline-concurrency is used. */
  reason: 'pipeline-concurrency';
  /** Human-readable reason label for tooltips/details. */
  reasonLabel: string;
  /** ISO timestamp captured when the entry was enqueued. */
  enqueuedAt: string;
  trigger_source?: PipelineTriggerSource;
}

/**
 * Queue lifecycle events emitted on `PIPELINE_QUEUE_EVENT`. The renderer
 * mirrors these into `pipelineRunsStore` so queued cards appear, transition
 * to running when picked up, or disappear when cancelled or failed.
 */
export type PipelineQueueEvent =
  | { type: 'queued'; entry: QueuedPipelineExecutionEntry }
  | { type: 'started'; queueId: string }
  | { type: 'cancelled'; queueId: string }
  | {
      type: 'failed';
      queueId: string;
      entry: QueuedPipelineExecutionEntry;
      error: string;
    };

export interface PipelineIndex {
  pipelines: PipelineIndexEntry[];
}

export type PipelineShareScope = ProtocolPipelineShareScope;
export type CanopyOrganizationSummary = ProtocolCanopyOrganizationSummary;
export type CanopyTeamSummary = ProtocolCanopyTeamSummary;
export type PipelineShareOwner = ProtocolPipelineShareOwner;
export type SharedPipelinePublicShareInfo =
  ProtocolSharedPipelinePublicShareInfo;

export interface PipelineData {
  info: PipelineInfo;
  content: Pipeline;
  /** Exact stored document bytes, when the backing source exposes them. */
  rawContent?: string;
  /**
   * Saved local owner of a user pipeline (`personal` / `org:<uuid>`), set on
   * the single-pipeline read. Absent for unowned or non-local definitions.
   * Main-only metadata; never in YAML or shared publication payloads.
   */
  localRunOwner?: string;
  /**
   * Set instead of `localRunOwner` when saved owners can't be read, so the
   * pipeline never appears unowned; the Run dialog blocks a run with no
   * project, and main refuses one.
   */
  localRunOwnerUnreadable?: true;
}

export interface IPCResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  /** Structured share failure, set by share handlers alongside `error`. */
  failure?: ShareFailure;
}

export type PipelineExecutionStartResult =
  | { success: true; data: ExecutionState }
  | {
      success: false;
      error: string;
      errorCode?:
        | 'shared_pipeline_changed'
        | typeof PIPELINE_NOW_OWNED_ERROR_CODE;
    };

export interface PipelineSaveInput {
  /** Shared source resolved again in main before a local install. */
  sourceRemoteId?: string;
  curatedOrigin?: CuratedPipelineOrigin;
  id?: string;
  name: string;
  description: string;
  icon: string;
  content: Pipeline;
  /**
   * Validated document bytes to persist verbatim. Used when an integrity pin
   * covers the serialization itself rather than only the parsed pipeline.
   */
  rawContent?: string;
  /**
   * Revision of the user pipeline the caller loaded. A save of an existing
   * pipeline whose stored revision differs is refused as a conflict.
   */
  expectedRevision?: number;
}

export interface ProjectPipelineRequest {
  id: string;
  cwd: string;
  filePath: string;
}

/**
 * Lookup variant for pipelines hosted on the configured Canopy Cloud backend.
 *
 * Identity over the IPC boundary is `remoteId` alone — the desktop app is
 * bound to a single Canopy Cloud backend at build time, so the renderer must
 * not pass a `serverId`. The internal local-id form for shared pipelines may
 * still be persisted as `shared:canopy-cloud:${remoteId}` to minimize churn
 * in executor/preference state on the main-process side, but the renderer
 * never assembles it.
 */
export interface SharedPipelineRequest {
  source: 'shared';
  remoteId: string;
}

export interface StoredPipelineLookupRequest {
  id: string;
  source: 'bundled' | 'user' | 'curated';
}

export type PipelineLookupRequest =
  | string
  | ProjectPipelineRequest
  | SharedPipelineRequest
  | StoredPipelineLookupRequest;

/**
 * Local-catalog identity of a capability a pipeline declares. Mirrors the
 * `selection` arm of the main-process shareable-plugin match so renderer
 * surfaces can join a pipeline's declared refs against installed skills
 * (`sourceId`/`skillName`) and marketplace plugins
 * (`marketplaceId`/`pluginName`) without re-implementing ref matching.
 */
export type PipelineCapabilitySelection =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string };

/**
 * One capability declared by a pipeline's `plugin_collections`, resolved
 * against the local catalog (CAN-2382). `matchState: 'unmatched'` means the
 * declared ref does not resolve to an installed skill/plugin; such entries
 * carry display strings but no `selection`.
 */
export interface PipelineCapabilitySummary {
  /** Stable portable-ref key (`getPipelinePluginDefaultKey`). */
  key: string;
  kind: 'skill' | 'plugin';
  required: boolean;
  collectionId: string;
  collectionName: string;
  displayName: string;
  displaySource: string;
  matchState: 'matched' | 'unmatched';
  selection?: PipelineCapabilitySelection;
}

/** Per-pipeline capability summary returned by `pipelines:list-capability-refs`. */
export interface PipelineCapabilityRefsEntry {
  id: string;
  source: 'bundled' | 'user' | 'project';
  name: string;
  /** Pipeline icon (emoji), empty when the pipeline declares none. */
  icon: string;
  /** Present for project pipelines so lookups can round-trip to the editor. */
  filePath?: string;
  capabilities: PipelineCapabilitySummary[];
}

export interface ListPipelineCapabilityRefsRequest {
  /** Include project pipelines discovered under this absolute path. */
  cwd?: string;
}

export interface ListPipelineCapabilityRefsResponse {
  pipelines: PipelineCapabilityRefsEntry[];
}

export function createDefaultStep(): Step {
  return {};
}
export function createDefaultPipeline(): Pipeline {
  return {
    name: 'New workflow',
    version: '3.0',
    description: '',
    icon: '✨',
    on: 'dispatch',
    jobs: {},
  };
}

export function getAllSteps(pipeline: Pipeline): Step[] {
  return Object.values(pipeline.jobs).flatMap((job) => job.steps);
}

export type SharedPipelineTriggerType = ProtocolSharedPipelineTriggerType;
export type SharedPipelineSummary = ProtocolSharedPipelineSummary;
export type SharedPipelineDetail = ProtocolSharedPipelineDetail;

/**
 * Desktop-local shared-pipeline request shapes.
 *
 * The desktop app is bound to a single Canopy Cloud backend, so the local
 * IPC layer never needs to identify a server. These types intentionally
 * shadow the `serverId`-carrying request types in `@canopy/protocol/pipelines`
 * (which still describe the wire shape between desktop and Canopy Cloud, and
 * are also consumed unchanged by `apps/web`).
 */
export interface ListSharedPipelinesRequest {
  limit?: number;
  cursor?: string;
  q?: string;
  triggerType?: SharedPipelineTriggerType;
  createdBy?: string;
}

export type ListSharedPipelinesResponse = ProtocolListSharedPipelinesResponse;

export interface SharedPipelineGetRequest {
  remoteId: string;
}

export type PipelineShareSource =
  | { kind: 'stored'; id: string; source?: 'user' | 'bundled' | 'curated' }
  | {
      kind: 'project';
      projectId: string;
      worktreeId: string;
      repoId?: string;
      pipelineFilePath: string;
    };

export interface SharedPipelineWriteRequest {
  sourcePipeline?: PipelineShareSource;
  sourcePipelineId?: string;
  rawPipeline: string;
  shareScope?: PipelineShareScope;
  teamId?: string;
  organizationId?: string;
  expectedContentHash?: string;
  distributionMode?: PipelineDistributionMode;
  committedPackageUploadId?: string;
  revokePublicShare?: PublicShareVersion;
}

export interface SharedPipelineSaveImpact {
  automations: Array<{
    id: string;
    name: string;
    kind: 'shared' | 'installed';
  }>;
}

export interface SharedPipelineDeleteRequest {
  remoteId: string;
}

export interface ListSharedOrganizationsRequest {
  q?: string;
  limit?: number;
}

export type ListSharedOrganizationsResponse =
  ProtocolListSharedOrganizationsResponse;

export interface ListSharedTeamsRequest {
  /** Exact public team ID; filtered before the list limit. */
  id?: string;
  q?: string;
  limit?: number;
}

export type ListSharedTeamsResponse = ProtocolListSharedTeamsResponse;
import type { InstalledItemRef } from '@canopy/protocol/installed-items';

/** Step identity augments, rather than replaces, the effective model options. */
export interface PipelineAgentModelConfig extends AgentModelConfig {
  agentId?: string;
  baseModel?: string;
  requestedModel?: string;
}
