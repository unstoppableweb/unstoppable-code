import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  PipelinePackageAnalysisBlocker,
  PipelinePackageAnalysisSummary,
  PipelinePackageInvocationDismissal,
  PipelinePackageLimit,
  PipelinePackagePackagedPipeline,
  PipelinePackageReferenceDismissal,
  PipelinePackageWithheldFile,
  PipelinePackageWithheldReason,
  Pipeline,
  PipelineInputValue,
  RepoLocalInvocableEntry,
  RepoLocalInvocableIndex,
} from '@canopy/execution-engine/types/pipeline';
import type {
  InvocableInventoryCache,
  InvocableInventoryEntry,
} from '@canopy/execution-engine/types/invocable-inventory';
import type {
  PipelineAssetInstallMode,
  PipelinePackageFileEntry,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageManifestV1,
  PipelinePackageResource,
  PipelinePackageBinding,
  PipelinePackagePublisherNote,
  PipelineDependencyInput,
} from '@canopy/protocol/pipelines';
import {
  AUTOMATION_PIPELINE_TREE_ENTRY_PATH,
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  capabilityPackageBindingFromKey,
  capabilityPackageStepBindingKey,
  detectPipelinePackageNativeExecutable,
  isPipelinePackageExecutableScript,
  PIPELINE_PACKAGE_MAX_FILES,
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  PIPELINE_PACKAGE_MAX_TOTAL_BYTES,
  validatePipelinePackageManifest,
} from '@canopy/protocol/pipelines';
import {
  collectPipelineCapabilityRefs,
  getPipelinePluginDefaultRef,
} from '@canopy/execution-engine/pipelines/plugin-collections';
import { getShareablePluginRefKey } from '@canopy/execution-engine/plugin-refs';
import {
  containsSecretMaterial,
  SECRET_ASSIGNMENT_KEYS_SOURCE,
} from '@canopy/execution-engine/lib/redaction';
import { hashPipelinePackageYaml } from '@canopy/execution-engine/node/pipelines/package-contract';
import { assignStepIds } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  extractInvocationTokens,
  isExplicitPathInvocationToken,
  isPathShapedInvocationToken,
  type InvocationTokenContext,
} from '../../lib/invocation-tokens';
import { interpolateKnownInputs } from '@canopy/execution-engine/node/pipelines/executor/expression-evaluator';
import {
  AUTOMATION_ACTION_PIPELINE_KEY,
  automationPipelineResourceId,
  createAutomationPipelineReferenceCollector,
  fileAssetResourceId,
  type AutomationPipelineInventoryEntry,
  type AutomationPipelineRequest,
  type AutomationPipelineSource,
} from './automation-pipeline-references';
import { expandPipelineAssetPath } from './pipeline-assets';
import {
  SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
  parseSharedContainerDefinitionDocument,
  type SharedContainerDefinitionKind,
} from '@canopy/protocol/shared-containers';

const ANALYSIS_TTL_MS = 15 * 60 * 1_000;
const DENIED_BASENAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials.*|secrets.*|token.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/i;
// A pipeline expression such as `${{ secrets.API_TOKEN }}` names a value the
// run supplies; it is not the value. The inner text is still scanned.
const PIPELINE_EXPRESSION_PATTERN = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_PLACEHOLDER_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})\\s*(?:=|:)\\s*(?:<[^>\\r\\n]+>|\\{\\{?[^}\\r\\n]+\\}?\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\})`,
  'gi',
);

export interface PipelinePackageSourceDescriptor {
  sourceRoot: string;
  memberPath: string;
  /** Restricts package file collection while preserving source-root output paths. */
  exportRoot?: string;
  sourceVisibility: PipelinePackageResource['sourceVisibility'];
  runtimeKind: 'plugin_fragment' | 'standalone_skill';
  rootName: string;
  syntheticManifestName?: string;
}

/** What the analyzer resolves invocations against, for any subject. */
export interface CapabilityPackageResolutionInput {
  invocableInventory: InvocableInventoryCache;
  capabilityInventoryEntryIdsByKey?: Record<string, string[]>;
  sourceByInventoryEntryId?: Record<string, PipelinePackageSourceDescriptor>;
  repoLocalInvocables?: RepoLocalInvocableIndex;
  sourceByRepoLocalEntryId?: Record<string, PipelinePackageSourceDescriptor>;
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
  /**
   * Pipelines a prompt source with `pipelineReferences` may name, from
   * `automationPipelineKey`. Classified in the prompt scan by
   * `classifyPipelineReference`, exactly as `resolveAutomationPipelineReferences`
   * does for the host before it builds resources.
   */
  pipelineInventory?: AutomationPipelineInventoryEntry[];
  /** Stored and manually added pipeline dependencies; always required. */
  pipelineRequests?: AutomationPipelineRequest[];
  /** Keys of optional (name-matched) pipelines the author selected. */
  pipelineSelections?: string[];
}

export type PipelinePackageProvider = 'claude' | 'codex';

/**
 * One way a step can run. A step whose model is a run-time expression can run
 * under more than one provider; each variant names the provider one selection
 * of trigger inputs resolves to, and those inputs, so the step's prompt is
 * scanned as that selection would render it.
 */
export interface PipelinePackageStepVariant {
  provider: PipelinePackageProvider;
  /** The input selection behind this variant; absent when it is unknown. */
  inputs?: Readonly<Record<string, PipelineInputValue>>;
  /** Inputs this variant runs without, so their expressions render empty. */
  absentInputs?: readonly string[];
  /**
   * The step may run under this provider, but its model could not be
   * resolved to confirm it. Dependencies found for it are packaged; missing
   * ones are not reported, so an undeterminable model never blocks a share
   * the confirmed provider alone would allow.
   */
  unconfirmed?: boolean;
}

/**
 * The provider a step runs under: a single provider for a fixed model, or
 * every variant a run-time model expression can select.
 */
export type PipelinePackageStepProviders =
  | PipelinePackageProvider
  | readonly PipelinePackageStepVariant[];

export interface AnalyzePipelinePackageInput extends CapabilityPackageResolutionInput {
  rawPipeline: string;
  pipeline: Pipeline;
  providerByStep: Record<string, PipelinePackageStepProviders>;
  portableResources?: CapabilityPackagePortableResourceInput[];
  additionalRequests?: CapabilityPackageRequest[];
  additionalPromptSources?: CapabilityPackagePromptSource[];
  additionalEnvironmentRequirements?: PipelinePackageEnvironmentRequirement[];
  hostBlockers?: AnalyzeCapabilityPackageInput['hostBlockers'];
  dismissedReferences?: AnalyzeCapabilityPackageInput['dismissedReferences'];
}

export interface CapabilityPackagePortableResourceInput {
  kind: 'pipeline_action' | 'child_pipeline';
  displayName: string;
  /**
   * Every key a run may look this resource up by, the authored one first. A
   * child pipeline written as `${{ env.X }}` carries both the expression and
   * the value a run interpolates. Emitted deduplicated, in this order.
   */
  invocationKeys: string[];
  bindingKey: string;
  descriptor: PipelinePackageSourceDescriptor;
  /**
   * The packaged pipeline that reaches this resource, when an analysis
   * packages several: two pipelines with the same job and step ids that call
   * the same ref still get distinct resources.
   */
  idScope?: string;
}

/**
 * One pipeline an automation share packages as an `automation_pipeline`
 * resource: its YAML travels as a single `pipeline.yaml` blob. The content
 * hash is the analyzer's to compute from `rawContent`, so the resource, the
 * blob and the summary can't disagree.
 */
export interface AutomationPipelinePortableInput {
  /** `action` for a `worktree_pipeline` action's pipeline, else the inventory key. */
  pipelineKey: string;
  name: string;
  source: AutomationPipelineSource;
  /** The exact YAML bytes that travel. */
  rawContent: string;
  /** The binding the pipeline is reached from, usually the automation action. */
  bindingKey: string;
  /** The YAML file, so editing it after analysis makes the analysis stale. */
  sourcePath?: string;
}

/** A directory a packaged pipeline declares under `assets`. */
export interface FileAssetPortableInput {
  /** Key of the packaged pipeline that declares it. */
  pipelineKey: string;
  assetId: string;
  /** The declared `path`; `~` is expanded against the analyzer's `homedir`. */
  sourcePath: string;
  required: boolean;
  installMode: PipelineAssetInstallMode;
  /** The declaring pipeline's `local_state` entries, declared or expanded. */
  localState: string[];
}

export interface CapabilityPackageRequest {
  key: string;
  provider: 'claude' | 'codex';
  required: boolean;
  bindingKey: string;
  /**
   * The subject may run under this provider, but that could not be confirmed.
   * A match is still packaged; a miss is not reported as a blocker.
   */
  unconfirmed?: boolean;
}

interface CapabilityPackagePromptSourceCommon {
  /**
   * Base provider for unprefixed tokens. A `$`-prefixed token self-selects
   * Codex regardless, mirroring the per-step rule pipelines already use.
   */
  provider: 'claude' | 'codex';
  text: string;
  /**
   * The text may run under this provider, but that could not be confirmed.
   * Tokens that resolve are packaged; tokens that don't are not reported.
   */
  unconfirmed?: boolean;
  /**
   * Also scan the text for pipeline references against `pipelineInventory`.
   * Set on the automation's own prompt only: recorded spans index into this
   * text, so at most one source should set it.
   */
  pipelineReferences?: boolean;
}

/**
 * Free-text a publisher authored that the agent will execute, scanned for
 * invocation tokens. Prompt text is a package DISCOVERY source, not only a
 * validation source: a resolved `/skill` token is packaged and bound even
 * when no structured capability request named it. A pipeline derives one
 * source per agent step; an automation has exactly one, its action prompt.
 *
 * A step-less subject — a skill body, an Agent's instructions, a Blueprint's
 * prompts — uses the `subject` form and binds what it discovers to the whole
 * share instead of to a synthetic step.
 */
export type CapabilityPackagePromptSource =
  | (CapabilityPackagePromptSourceCommon & { jobId: string; stepId: string })
  | (CapabilityPackagePromptSourceCommon & { target: 'subject' });

function isSubjectPromptSource(
  source: CapabilityPackagePromptSource,
): source is CapabilityPackagePromptSourceCommon & { target: 'subject' } {
  return 'target' in source;
}

function promptSourceBindingKey(source: CapabilityPackagePromptSource): string {
  return isSubjectPromptSource(source)
    ? CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY
    : capabilityPackageStepBindingKey(source.jobId, source.stepId);
}

/** Where a blocker or occurrence happened, or nothing for a step-less subject. */
function promptSourceLocation(
  source: CapabilityPackagePromptSource,
): { jobId: string; stepId: string } | undefined {
  return isSubjectPromptSource(source)
    ? undefined
    : { jobId: source.jobId, stepId: source.stepId };
}

export interface AnalyzeCapabilityPackageInput extends CapabilityPackageResolutionInput {
  /** The subject's content; the manifest is keyed to its hash. */
  rawContent: string;
  requests: CapabilityPackageRequest[];
  promptSources?: CapabilityPackagePromptSource[];
  /**
   * Requirements the host already knows about, merged into the ones the
   * analyzer derives. A step-less subject has no `dependencies:` manifest to
   * read, so this is how a skill's extracted MCP and plugin names reach the
   * package. An id the analyzer also derives wins, so a declared requirement
   * is never silently replaced by a heuristic one.
   */
  environmentRequirements?: PipelinePackageEnvironmentRequirement[];
  portableResources?: CapabilityPackagePortableResourceInput[];
  /**
   * Problems the host found while discovering portable resources, such as a
   * child pipeline ref it cannot resolve before a run. They block the
   * analysis like the analyzer's own.
   */
  hostBlockers?: PipelinePackageAnalysisBlocker[];
  /**
   * Reference dismissals. `child_pipeline_ref` entries are ones the host
   * applied and are echoed as given; `pipeline_reference` entries are
   * candidates the analyzer applies to ambiguous prompt references and echoes
   * only when one matched.
   */
  dismissedReferences?: PipelinePackageReferenceDismissal[];
  /** Pipelines an automation share carries, including the action pipeline. */
  automationPipelines?: AutomationPipelinePortableInput[];
  /** Asset directories the packaged pipelines declare. */
  fileAssets?: FileAssetPortableInput[];
  /** Home folder asset paths expand against and must stay inside. */
  homedir?: string;
  /**
   * Portable definitions (pipelines, automations, Agents, hooks) carried as
   * one canonical document each. Omitted by every pre-existing subject, which
   * keeps their analysis byte-identical.
   */
  definitionResources?: CapabilityPackageDefinitionResourceInput[];
}

export type CapabilityPackageDefinitionKind = SharedContainerDefinitionKind;

/**
 * A structured capability a definition needs. `key` is either a key present
 * in `capabilityInventoryEntryIdsByKey` (for example a shareable plugin ref
 * key) or a local selection key, `skill:<sourceId>:<skillName>` or
 * `plugin:<marketplaceId>:<pluginName>`, resolved against inventory enable
 * refs.
 */
export interface CapabilityPackageDefinitionRequest {
  key: string;
  provider: PipelinePackageProvider;
  /** A required request that resolves nothing blocks the analysis. */
  required: boolean;
  /** Best effort, as for {@link CapabilityPackageRequest.unconfirmed}. */
  unconfirmed?: boolean;
}

/** Author text a definition executes, scanned like a prompt source. */
export interface CapabilityPackageDefinitionPromptText {
  provider: PipelinePackageProvider;
  text: string;
  unconfirmed?: boolean;
}

/**
 * One portable definition resource. The analyzer stores `document` (its
 * canonical bytes) as the resource's single read-only file, and makes every
 * capability its prompt texts and requests resolve to, plus every definition
 * it depends on, part of its dependency closure.
 */
export interface CapabilityPackageDefinitionResourceInput {
  kind: CapabilityPackageDefinitionKind;
  displayName: string;
  /**
   * Stable canonical identity, unique per kind. The resource id derives from
   * it, so the same definition keeps the same id across analyses.
   */
  identity: string;
  /** Canonical document bytes, as produced by the protocol encoder. */
  document: Uint8Array;
  bindingKey: string;
  sourceLabel?: string;
  sourceVisibility?: Extract<
    PipelinePackageResource['sourceVisibility'],
    'private' | 'local'
  >;
  promptTexts?: CapabilityPackageDefinitionPromptText[];
  requestKeys?: CapabilityPackageDefinitionRequest[];
  /** Identities of other definitions in the same input this one needs. */
  dependsOnIdentities?: string[];
  /**
   * Child pipelines and project actions the definition runs. They are
   * packaged as `child_pipeline` / `pipeline_action` resources, bound with the
   * definition, and made part of its dependency closure.
   */
  portableResources?: Array<
    Omit<CapabilityPackagePortableResourceInput, 'bindingKey'>
  >;
}

/** Deterministic manifest resource id of a definition resource. */
export function capabilityPackageDefinitionResourceId(
  kind: CapabilityPackageDefinitionKind,
  identity: string,
): string {
  return createHash('sha256')
    .update(`${kind}\0${identity}`)
    .digest('hex')
    .slice(0, 24);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Matches a local selection key such as `skill:custom:app:helper`. */
function inventoryEntryMatchesSelectionKey(
  entry: InvocableInventoryEntry,
  key: string,
): boolean {
  const separator = key.lastIndexOf(':');
  if (separator <= 0) return false;
  const head = key.slice(0, separator);
  const name = key.slice(separator + 1);
  if (name.length === 0) return false;
  if (head.startsWith('skill:'))
    return (
      entry.enableRef.kind === 'skill' &&
      entry.enableRef.sourceId === head.slice('skill:'.length) &&
      entry.enableRef.skillName === name
    );
  if (head.startsWith('plugin:'))
    return (
      entry.enableRef.kind === 'plugin' &&
      entry.enableRef.marketplaceId === head.slice('plugin:'.length) &&
      entry.enableRef.pluginName === name
    );
  return false;
}

function definitionRequestCandidates(
  input: CapabilityPackageResolutionInput,
  request: CapabilityPackageDefinitionRequest,
): InvocableInventoryEntry[] {
  const ids = new Set(input.capabilityInventoryEntryIdsByKey?.[request.key]);
  return input.invocableInventory.entries.filter(
    (entry) =>
      entry.provider === request.provider &&
      (ids.has(entry.id) ||
        inventoryEntryMatchesSelectionKey(entry, request.key)),
  );
}

/**
 * The analysis of any shareable subject. A pipeline is one subject among
 * several; its analysis carries no pipeline-specific state.
 */
export interface CapabilityPackageAnalysisInternal {
  summary: PipelinePackageAnalysisSummary;
  optionalBindings: PipelinePackageBinding[];
  /** Internal-only source closure used to filter notes after optional selection. */
  publisherNoteSources?: Record<
    string,
    { direct: boolean; resourceIds: string[] }
  >;
  blobs: Map<string, Uint8Array>;
  sourceStats: Array<{
    path: string;
    size: number;
    mtimeMs: number;
    sha256: string;
  }>;
  sourceDirectories: Array<{
    path: string;
    entries: string[];
    /** The path was absent when analyzed; its creation makes this stale. */
    missing?: true;
  }>;
}

/** Pipeline-named alias kept for existing callers. */
export type PipelinePackageAnalysisInternal = CapabilityPackageAnalysisInternal;

type ResolvedInvocable =
  | { origin: 'inventory'; entry: InvocableInventoryEntry }
  | { origin: 'repo'; entry: RepoLocalInvocableEntry };

type PendingBlocker = Omit<PipelinePackageAnalysisBlocker, 'occurrences'> & {
  provider?: 'claude' | 'codex';
  occurrences?: Array<{ jobId: string; stepId: string }>;
  occurrenceResourceKeys?: string[];
};

interface CollectionBudget {
  files: number;
  bytes: number;
  exhausted: boolean;
  /** The biggest file reserved so far, named when the total cap is hit. */
  largest?: { subject: string; relativePath: string; size: number };
}

function logicalEntryKey(resolved: ResolvedInvocable): string {
  if (resolved.origin === 'repo') return resolved.entry.id;
  const { entry } = resolved;
  if (entry.enableRef.kind === 'none')
    return `${entry.provider}:inherited:${entry.kind}:${entry.name}`;
  return entry.enableRef.kind === 'skill'
    ? `${entry.provider}:skill:${entry.enableRef.sourceId}:${entry.enableRef.skillName}:${entry.kind}:${entry.name}`
    : `${entry.provider}:plugin:${entry.enableRef.marketplaceId}:${entry.enableRef.pluginName}:${entry.kind}:${entry.name}`;
}

function resolvedProvider(resolved: ResolvedInvocable): 'claude' | 'codex' {
  return resolved.entry.provider === 'codex' ? 'codex' : 'claude';
}

function invocationDismissalKey(
  provider: 'claude' | 'codex',
  token: string,
): string {
  return `${provider}\0${token}`;
}

function invocationCandidates(
  inventory: InvocableInventoryCache,
  provider: 'claude' | 'codex',
  invocation: string,
): InvocableInventoryEntry[] {
  const exact = inventory.entries.filter(
    (entry) =>
      entry.provider === provider && entry.invocationKey === invocation,
  );
  if (exact.length > 0 || provider !== 'claude') return exact;

  const qualified = invocation.match(/^\/([^:]+):([^:]+)$/);
  if (!qualified) return exact;
  const [, pluginName, memberName] = qualified;
  return inventory.entries.filter(
    (entry) =>
      entry.provider === provider &&
      entry.enableRef.kind === 'plugin' &&
      entry.enableRef.pluginName === pluginName &&
      entry.name === memberName,
  );
}

function resolveInvocationTarget(
  input: CapabilityPackageResolutionInput,
  provider: 'claude' | 'codex',
  invocation: string,
): ResolvedInvocable[] {
  const repoMatches =
    provider === 'claude'
      ? (input.repoLocalInvocables?.entries ?? [])
          .filter((entry) => entry.invocationKey === invocation)
          .map((entry): ResolvedInvocable => ({ origin: 'repo', entry }))
      : [];
  if (repoMatches.length > 0) return repoMatches;
  return invocationCandidates(
    input.invocableInventory,
    provider,
    invocation,
  ).map((entry): ResolvedInvocable => ({ origin: 'inventory', entry }));
}

function sourceDescriptor(
  input: CapabilityPackageResolutionInput,
  resolved: ResolvedInvocable,
): PipelinePackageSourceDescriptor | undefined {
  return resolved.origin === 'repo'
    ? input.sourceByRepoLocalEntryId?.[resolved.entry.id]
    : input.sourceByInventoryEntryId?.[resolved.entry.id];
}

function classifyInvocation(
  input: CapabilityPackageResolutionInput,
  token: InvocationTokenContext,
  provider: 'claude' | 'codex',
  origin: 'prompt' | 'body' | 'frontmatter',
  requiresResolution: boolean,
):
  | { kind: 'resolved'; target: ResolvedInvocable }
  | { kind: 'ambiguous' }
  | { kind: 'ignored'; dismissed: boolean }
  | { kind: 'unresolved'; dismissible: boolean } {
  const dismissible = origin === 'prompt' || origin === 'body';
  if (isExplicitPathInvocationToken(token)) {
    return { kind: 'ignored', dismissed: false };
  }
  const logical = new Map(
    resolveInvocationTarget(input, provider, token.value).map((target) => [
      logicalEntryKey(target),
      target,
    ]),
  );
  if (logical.size === 1) {
    const target = Array.from(logical.values())[0];
    if (target) return { kind: 'resolved', target };
  }
  if (logical.size > 1) return { kind: 'ambiguous' };
  if (
    dismissible &&
    input.dismissedInvocations?.some(
      (dismissal) =>
        dismissal.provider === provider && dismissal.token === token.value,
    )
  ) {
    return { kind: 'ignored', dismissed: true };
  }
  if (origin !== 'frontmatter' && isPathShapedInvocationToken(token)) {
    return { kind: 'ignored', dismissed: false };
  }
  if (!requiresResolution) {
    return { kind: 'ignored', dismissed: false };
  }
  return { kind: 'unresolved', dismissible };
}

function finalizeBlockers(
  pending: readonly PendingBlocker[],
  occurrencesForResourceKey: (
    resourceKey: string,
  ) => Array<{ jobId: string; stepId: string }>,
): PipelinePackageAnalysisBlocker[] {
  const deduped = new Map<string, PipelinePackageAnalysisBlocker>();
  for (const blocker of pending) {
    const {
      occurrences: directOccurrences = [],
      occurrenceResourceKeys = [],
      provider,
      ...publicBlocker
    } = blocker;
    const occurrences = [
      ...directOccurrences,
      ...occurrenceResourceKeys.flatMap(occurrencesForResourceKey),
      ...(blocker.jobId && blocker.stepId
        ? [{ jobId: blocker.jobId, stepId: blocker.stepId }]
        : []),
    ];
    const key = `${blocker.code}\0${provider ?? ''}\0${blocker.subject ?? blocker.relativePath ?? blocker.message}`;
    const existing = deduped.get(key);
    if (existing) {
      // A grouped blocker is dismissible only when every occurrence is. In
      // particular, a prompt mention must not make a matching structured
      // frontmatter reference dismissible.
      if (!existing.dismissal || !publicBlocker.dismissal) {
        delete existing.dismissal;
      }
      if (
        existing.origin === 'transitive' ||
        publicBlocker.origin === 'transitive'
      ) {
        existing.origin = 'transitive';
        if (publicBlocker.origin === 'transitive') {
          existing.message = publicBlocker.message;
        }
      }
      const seen = new Set(
        existing.occurrences.map(({ jobId, stepId }) => `${jobId}\0${stepId}`),
      );
      for (const occurrence of occurrences) {
        const occurrenceKey = `${occurrence.jobId}\0${occurrence.stepId}`;
        if (!seen.has(occurrenceKey)) {
          existing.occurrences.push(occurrence);
          seen.add(occurrenceKey);
        }
      }
      continue;
    }
    deduped.set(key, { ...publicBlocker, occurrences });
  }
  return Array.from(deduped.values());
}

function frontmatterFieldValues(
  value: string,
  keys: ReadonlySet<string>,
): string[] {
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return [];
  const values: string[] = [];
  let activeKey = false;
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      activeKey = keys.has(keyMatch[1] ?? '');
    }
    const raw = keyMatch
      ? activeKey
        ? keyMatch[2]
        : undefined
      : activeKey
        ? line.match(/^\s*-\s*(.+)$/)?.[1]
        : undefined;
    if (!raw) continue;
    for (const item of raw.match(/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*/g) ??
      []) {
      values.push(item);
    }
  }
  return values;
}

function frontmatterInvocationStrings(
  value: string,
  provider: 'claude' | 'codex',
  pluginName: string | undefined,
): string[] {
  return frontmatterFieldValues(
    value,
    new Set(['skills', 'skill', 'commands', 'command']),
  ).map((item) => {
    const qualified = item.includes(':')
      ? item
      : pluginName
        ? `${pluginName}:${item}`
        : item;
    return `${provider === 'codex' ? '$' : '/'}${qualified}`;
  });
}

function stepPromptText(
  pipeline: Pipeline,
  step: Pipeline['jobs'][string]['steps'][number],
): string {
  const configuredModel =
    typeof step.with?.model === 'string' ? step.with.model : undefined;
  const aliasInstructions = configuredModel
    ? pipeline.model_aliases?.find((alias) => alias.id === configuredModel)
        ?.defaults
    : undefined;
  return [
    typeof step.with?.prompt === 'string' ? step.with.prompt : undefined,
    typeof step.with?.system_prompt === 'string'
      ? step.with.system_prompt
      : undefined,
    aliasInstructions && !('agent_id' in aliasInstructions)
      ? aliasInstructions.instructions
      : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function canonicalStepIds(
  jobId: string,
  steps: Pipeline['jobs'][string]['steps'],
): string[] {
  return assignStepIds(steps, jobId).map((step) => step.id);
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? '' : character;
  }).join('');
}

function containsPipelinePackageSecretMaterial(text: string): boolean {
  const withoutExpressions = text.replace(
    PIPELINE_EXPRESSION_PATTERN,
    (expression, inner: string) =>
      containsSecretMaterial(inner) ? expression : '""',
  );
  return containsSecretMaterial(
    withoutExpressions.replace(
      SECRET_PLACEHOLDER_ASSIGNMENT_PATTERN,
      'placeholder=example',
    ),
  );
}

function affectedStepsForIds(
  pipeline: Pipeline,
  stepIds: readonly string[] | undefined,
): Array<{ jobId: string; stepId: string }> {
  const filter = stepIds ? new Set(stepIds) : null;
  return Object.entries(pipeline.jobs).flatMap(([jobId, job]) =>
    canonicalStepIds(jobId, job.steps).flatMap((stepId) => {
      return !filter || filter.has(stepId) ? [{ jobId, stepId }] : [];
    }),
  );
}

function affectedStepsForCollection(
  pipeline: Pipeline,
  collectionId: string,
): Array<{ jobId: string; stepId: string }> {
  const aliasIds = new Set(
    (pipeline.model_aliases ?? [])
      .filter(
        (alias) =>
          alias.defaults &&
          !('agent_id' in alias.defaults) &&
          alias.defaults.plugin_collection_id === collectionId,
      )
      .map((alias) => alias.id),
  );
  return Object.entries(pipeline.jobs).flatMap(([jobId, job]) =>
    job.steps.flatMap((step, index) => {
      const stepId = canonicalStepIds(jobId, job.steps)[index];
      if (!stepId) return [];
      return step.with?.plugin_collection_id === collectionId ||
        (typeof step.with?.model === 'string' && aliasIds.has(step.with.model))
        ? [{ jobId, stepId }]
        : [];
    }),
  );
}

function structuredCapabilities(pipeline: Pipeline): Array<{
  key: string;
  required: boolean;
  affectedSteps: Array<{ jobId: string; stepId: string }>;
}> {
  const capabilities = new Map<
    string,
    {
      key: string;
      required: boolean;
      affectedSteps: Map<string, { jobId: string; stepId: string }>;
    }
  >();
  const add = (
    key: string,
    required: boolean,
    affectedSteps: Array<{ jobId: string; stepId: string }>,
  ): void => {
    const existing = capabilities.get(key) ?? {
      key,
      required: false,
      affectedSteps: new Map(),
    };
    existing.required ||= required;
    for (const affectedStep of affectedSteps) {
      existing.affectedSteps.set(
        `${affectedStep.jobId}\0${affectedStep.stepId}`,
        affectedStep,
      );
    }
    capabilities.set(key, existing);
  };
  for (const dependency of pipeline.dependencies ?? []) {
    if (dependency.kind !== 'skill' && dependency.kind !== 'plugin') continue;
    add(
      getShareablePluginRefKey(dependency.ref),
      dependency.required === true,
      affectedStepsForIds(pipeline, dependency.steps),
    );
  }
  for (const capability of collectPipelineCapabilityRefs(pipeline)) {
    add(
      getShareablePluginRefKey(
        getPipelinePluginDefaultRef(capability.defaultRef),
      ),
      capability.required,
      affectedStepsForCollection(pipeline, capability.collectionId),
    );
  }
  return Array.from(capabilities.values()).map((capability) => ({
    ...capability,
    affectedSteps: Array.from(capability.affectedSteps.values()),
  }));
}

export function dependenciesToEnvironmentRequirements(
  dependencies: readonly PipelineDependencyInput[],
  affectedStepsForDependency: (
    dependency: PipelineDependencyInput,
  ) => Array<{ jobId: string; stepId: string }> = () => [],
): PipelinePackageEnvironmentRequirement[] {
  const requirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const dependency of dependencies) {
    if (dependency.kind === 'skill' || dependency.kind === 'plugin') continue;
    const common = {
      id: dependency.id,
      required: dependency.required ?? false,
      affectedSteps: affectedStepsForDependency(dependency),
      setupHint:
        dependency.install?.instructions ??
        dependency.capability ??
        'Configure this dependency before running the affected steps.',
    };
    if (dependency.kind === 'connector') {
      requirements.push({
        ...common,
        kind: 'connector',
        displayName: dependency.connector,
      });
    } else if (dependency.kind === 'mcp') {
      requirements.push({
        ...common,
        kind: 'mcp',
        displayName: dependency.server.catalog_id,
      });
    } else if (dependency.kind === 'local_runtime') {
      requirements.push({
        ...common,
        kind: 'runtime',
        displayName: dependency.runtime,
      });
    } else {
      requirements.push({
        ...common,
        kind: 'command',
        displayName: dependency.package.probe,
      });
    }
  }
  return requirements;
}

function declaredEnvironmentRequirements(
  pipeline: Pipeline,
): PipelinePackageEnvironmentRequirement[] {
  const requirements = dependenciesToEnvironmentRequirements(
    pipeline.dependencies ?? [],
    (dependency) => affectedStepsForIds(pipeline, dependency.steps),
  );
  for (const alias of pipeline.model_aliases ?? []) {
    const affectedSteps = Object.entries(pipeline.jobs).flatMap(
      ([jobId, job]) =>
        job.steps.flatMap((step, index) => {
          const stepId = canonicalStepIds(jobId, job.steps)[index];
          if (!stepId) return [];
          return step.with?.model === alias.id ? [{ jobId, stepId }] : [];
        }),
    );
    if (affectedSteps.length === 0) continue;
    const model =
      alias.defaults &&
      'base' in alias.defaults &&
      alias.defaults.base !== undefined
        ? alias.defaults.base
        : alias.name;
    requirements.push({
      id: `model:${alias.id}`,
      kind: 'model',
      displayName: model,
      required: true,
      affectedSteps,
      setupHint: `Choose an available model for ${alias.name}.`,
    });
  }
  return requirements;
}

/**
 * Reserve one file against the package caps, recording the blocker that names
 * the file to leave out when a cap is hit. Once a cap is hit the budget is
 * exhausted and every later reservation fails without another blocker.
 */
function reserveCollectionFile(
  budget: CollectionBudget,
  blockers: PendingBlocker[],
  current: { subject: string; relativePath: string; size: number },
): boolean {
  if (budget.exhausted) return false;
  const { size } = current;
  let exceeded:
    | { limit: PipelinePackageLimit; file: typeof current; message: string }
    | undefined;
  if (size > PIPELINE_PACKAGE_MAX_FILE_BYTES) {
    exceeded = {
      limit: 'file_size',
      file: current,
      message: `${current.subject} exceeds the per-file limit.`,
    };
  } else if (budget.files + 1 > PIPELINE_PACKAGE_MAX_FILES) {
    exceeded = {
      limit: 'file_count',
      file: current,
      message: `${current.subject} exceeds the file-count limit.`,
    };
  } else if (budget.bytes + size > PIPELINE_PACKAGE_MAX_TOTAL_BYTES) {
    // The file that tipped the total over is arbitrary: it is whichever was
    // read last. The largest one is what leaving out actually helps.
    const largest =
      budget.largest && budget.largest.size >= size ? budget.largest : current;
    exceeded = {
      limit: 'total_size',
      file: largest,
      message: `${largest.subject} is the largest file in a package that exceeds the total-size limit.`,
    };
  }
  if (exceeded) {
    blockers.push({
      code: 'PACKAGE_LIMIT_EXCEEDED',
      limit: exceeded.limit,
      message: exceeded.message,
      subject: exceeded.file.subject,
      relativePath: exceeded.file.relativePath,
    });
    budget.exhausted = true;
    return false;
  }
  budget.files += 1;
  budget.bytes += size;
  if (!budget.largest || size > budget.largest.size) budget.largest = current;
  return true;
}

interface CollectMemberFilesOptions {
  /**
   * Withhold mode, for file assets. Denied names, `.git` directories,
   * symlinks and files whose content trips the secret scan are left out and
   * reported here instead of blocking; native and opaque executables,
   * escapes and package limits still block. Asset files are data, so their
   * contents are not followed as references and return no texts.
   */
  withhold?: (file: {
    relativePath: string;
    reason: Exclude<PipelinePackageWithheldReason, 'missing_optional_asset'>;
  }) => void;
}

async function collectMemberFiles(
  descriptor: PipelinePackageSourceDescriptor,
  provider: 'claude' | 'codex',
  blockers: PendingBlocker[],
  blobs: Map<string, Uint8Array>,
  sourceStats: CapabilityPackageAnalysisInternal['sourceStats'],
  sourceDirectories: CapabilityPackageAnalysisInternal['sourceDirectories'],
  budget: CollectionBudget,
  options: CollectMemberFilesOptions = {},
): Promise<{ entries: PipelinePackageFileEntry[]; texts: string[] }> {
  const { withhold } = options;
  const sourceRoot = path.resolve(descriptor.sourceRoot);
  const memberRoot = path.resolve(sourceRoot, descriptor.memberPath);
  const exportRoot = descriptor.exportRoot
    ? path.resolve(descriptor.exportRoot)
    : sourceRoot;
  const relativeMember = path.relative(sourceRoot, memberRoot);
  if (relativeMember.startsWith('..') || path.isAbsolute(relativeMember)) {
    blockers.push({
      code: 'SOURCE_PATH_ESCAPE',
      message: 'A dependency path escapes its source root.',
    });
    return { entries: [], texts: [] };
  }
  const entries: PipelinePackageFileEntry[] = [];
  const texts: string[] = [];
  const visited = new Set<string>();
  const outputPath = (absolutePath: string): string =>
    path
      .relative(
        descriptor.runtimeKind === 'plugin_fragment' ? sourceRoot : memberRoot,
        absolutePath,
      )
      .split(path.sep)
      .join('/');
  const canonicalSourceRoot = await fs
    .realpath(sourceRoot)
    .catch(() => sourceRoot);
  const sourcePathIsSafe = async (normalized: string): Promise<boolean> => {
    const relativeToSource = path.relative(sourceRoot, normalized);
    let current = sourceRoot;
    for (const segment of relativeToSource.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          const relativePath = path
            .relative(sourceRoot, current)
            .split(path.sep)
            .join('/');
          if (withhold) {
            withhold({ relativePath, reason: 'symlink' });
            return false;
          }
          blockers.push({
            code: 'SYMLINK_BLOCKED',
            message: 'Symbolic links cannot be included.',
            subject: relativePath,
            relativePath,
          });
          return false;
        }
      } catch {
        // The caller owns missing-path handling and whether absence blocks.
        return true;
      }
    }
    try {
      const canonicalPath = await fs.realpath(normalized);
      const canonicalRelative = path.relative(
        canonicalSourceRoot,
        canonicalPath,
      );
      if (
        canonicalRelative.startsWith('..') ||
        path.isAbsolute(canonicalRelative)
      ) {
        const relativePath = relativeToSource.split(path.sep).join('/');
        blockers.push({
          code: 'SOURCE_PATH_ESCAPE',
          message: 'A dependency path escapes its source root.',
          subject: relativePath,
          relativePath,
        });
        return false;
      }
    } catch {
      // The caller owns missing-path handling and whether absence blocks.
    }
    return true;
  };
  const releaseFile = (relativePath: string, size: number): void => {
    budget.files -= 1;
    budget.bytes -= size;
    if (budget.largest?.subject === `${descriptor.rootName}/${relativePath}`)
      budget.largest = undefined;
  };
  const reserveFile = (relativePath: string, size: number): boolean =>
    reserveCollectionFile(budget, blockers, {
      // Prefixed with the resource's root so a publisher with several
      // packaged dependencies can tell which folder the file lives in.
      subject: `${descriptor.rootName}/${relativePath}`,
      relativePath,
      size,
    });
  const includeSanitizedPluginManifest = async (
    manifestPath: string,
  ): Promise<void> => {
    const normalized = path.resolve(manifestPath);
    if (!(await sourcePathIsSafe(normalized))) return;
    const stat = await fs.lstat(normalized);
    if (stat.isSymbolicLink()) {
      const relativePath = outputPath(normalized);
      blockers.push({
        code: 'SYMLINK_BLOCKED',
        message: 'Symbolic links cannot be included.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    if (!stat.isFile()) return;
    const relativePath = outputPath(normalized);
    if (!reserveFile(relativePath, stat.size)) return;
    const sourceBytes = new Uint8Array(await fs.readFile(normalized));
    const sourceText = new TextDecoder('utf-8', { fatal: false }).decode(
      sourceBytes,
    );
    if (
      containsPipelinePackageSecretMaterial(stripControlCharacters(sourceText))
    ) {
      blockers.push({
        code: 'SUSPECTED_SECRET',
        message: 'A dependency file may contain a credential.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    sourceStats.push({
      path: normalized,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: sourceSha256,
    });
    let sourceManifest: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(sourceText);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        sourceManifest = parsed as Record<string, unknown>;
      }
    } catch {
      // The provider inventory already validated discoverable manifests. Fall
      // back to the descriptor identity rather than exporting malformed bytes.
    }
    const identity = {
      name:
        typeof sourceManifest.name === 'string' && sourceManifest.name.trim()
          ? sourceManifest.name
          : descriptor.rootName,
      ...(typeof sourceManifest.version === 'string'
        ? { version: sourceManifest.version }
        : {}),
      ...(typeof sourceManifest.description === 'string'
        ? { description: sourceManifest.description }
        : {}),
    };
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(identity, null, 2)}\n`,
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    entries.push({
      path: outputPath(normalized),
      sha256,
      size: bytes.byteLength,
      mode: 'read',
    });
    texts.push(new TextDecoder().decode(bytes));
    visited.add(normalized);
  };
  const includeSyntheticPluginManifest = (manifestPath: string): void => {
    const normalized = path.resolve(manifestPath);
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ name: descriptor.syntheticManifestName }, null, 2)}\n`,
    );
    const relativePath = outputPath(normalized);
    if (!reserveFile(relativePath, bytes.byteLength)) return;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    entries.push({
      path: relativePath,
      sha256,
      size: bytes.byteLength,
      mode: 'read',
    });
    texts.push(new TextDecoder().decode(bytes));
    visited.add(normalized);
    sourceDirectories.push({ path: normalized, entries: [], missing: true });
  };
  const includePath = async (
    absolutePath: string,
    missingIsBlocker = true,
  ): Promise<void> => {
    if (budget.exhausted) return;
    const normalized = path.resolve(absolutePath);
    if (visited.has(normalized)) return;
    const relativeToExportRoot = path.relative(exportRoot, normalized);
    if (
      relativeToExportRoot.startsWith('..') ||
      path.isAbsolute(relativeToExportRoot)
    ) {
      blockers.push({
        code: 'SOURCE_PATH_ESCAPE',
        message: 'A dependency path escapes its export root.',
        subject: path
          .relative(sourceRoot, normalized)
          .split(path.sep)
          .join('/'),
      });
      return;
    }
    const relativeToSource = path.relative(sourceRoot, normalized);
    if (
      relativeToSource.startsWith('..') ||
      path.isAbsolute(relativeToSource)
    ) {
      blockers.push({
        code: 'SOURCE_PATH_ESCAPE',
        message: 'A dependency path escapes its source root.',
      });
      return;
    }
    if (!(await sourcePathIsSafe(normalized))) return;
    let stat;
    try {
      stat = await fs.lstat(normalized);
    } catch {
      if (missingIsBlocker) {
        const relativePath = relativeToSource.split(path.sep).join('/');
        blockers.push({
          code: 'MISSING_DEPENDENCY_SOURCE',
          message: 'A referenced dependency file is missing.',
          subject: relativePath,
          relativePath,
        });
      }
      return;
    }
    visited.add(normalized);
    if (stat.isSymbolicLink()) {
      const relativePath = outputPath(normalized);
      if (withhold) {
        withhold({ relativePath, reason: 'symlink' });
        return;
      }
      blockers.push({
        code: 'SYMLINK_BLOCKED',
        message: 'Symbolic links cannot be included.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    if (
      withhold &&
      normalized !== memberRoot &&
      path.basename(normalized) === '.git'
    ) {
      // Listed once for the whole repository rather than file by file.
      withhold({
        relativePath: outputPath(normalized),
        reason: 'git_directory',
      });
      return;
    }
    if (stat.isDirectory()) {
      const children = await fs.readdir(normalized, { withFileTypes: true });
      sourceDirectories.push({
        path: normalized,
        entries: children
          .map((child) =>
            [
              child.name,
              child.isDirectory()
                ? 'directory'
                : child.isFile()
                  ? 'file'
                  : child.isSymbolicLink()
                    ? 'symlink'
                    : 'other',
            ].join('\0'),
          )
          .sort(),
      });
      for (const child of children) {
        await includePath(path.join(normalized, child.name));
        if (budget.exhausted) break;
      }
      return;
    }
    if (!stat.isFile()) return;
    const relativePath = outputPath(normalized);
    const basename = path.basename(normalized);
    if (
      DENIED_BASENAME.test(basename) ||
      relativePath.split('/').includes('.git')
    ) {
      if (withhold) {
        withhold({
          relativePath,
          reason: DENIED_BASENAME.test(basename)
            ? 'denied_name'
            : 'git_directory',
        });
        return;
      }
      blockers.push({
        code: 'EXPORT_DENIED_FILE',
        message: 'A dependency contains a file that cannot be exported.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    if (!reserveFile(relativePath, stat.size)) return;
    const bytes = new Uint8Array(await fs.readFile(normalized));
    if (detectPipelinePackageNativeExecutable(bytes) !== null) {
      blockers.push({
        code: 'NATIVE_EXECUTABLE_BLOCKED',
        message: 'Native executable files cannot be included.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    const executable = (stat.mode & 0o111) !== 0;
    if (executable && !isPipelinePackageExecutableScript(bytes)) {
      blockers.push({
        code: 'OPAQUE_EXECUTABLE_BLOCKED',
        message: 'Opaque executable files cannot be included.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const normalizedSecretScan = stripControlCharacters(text);
    if (containsPipelinePackageSecretMaterial(normalizedSecretScan)) {
      if (withhold) {
        releaseFile(relativePath, stat.size);
        withhold({ relativePath, reason: 'suspected_secret' });
        return;
      }
      blockers.push({
        code: 'SUSPECTED_SECRET',
        message: 'A dependency file may contain a credential.',
        subject: relativePath,
        relativePath,
      });
      return;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    sourceStats.push({
      path: normalized,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256,
    });
    entries.push({
      path: relativePath,
      sha256,
      size: bytes.byteLength,
      mode: executable ? 'execute' : 'read',
    });
    if (withhold) return;
    if (!text.includes('\u0000')) {
      texts.push(text);
      const references = new Set<string>();
      for (const match of Array.from(
        text.matchAll(/\]\(([^)#?]+)(?:#[^)]*)?\)/g),
      )) {
        if (match[1]) references.add(match[1]);
      }
      for (const match of Array.from(
        text.matchAll(
          /(?:^|[\s'"`(])((?:\.\.\/|\.\/)?(?:scripts|references|assets|docs)\/[A-Za-z0-9._/ -]+)/gm,
        ),
      )) {
        if (match[1]) references.add(match[1].trim().replace(/[.,;:!?]+$/, ''));
      }
      for (const reference of Array.from(references)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) continue;
        // Free-form prose and Markdown commonly mention paths in the target
        // repository or use placeholders. Package them when they resolve to a
        // real local source, but do not turn absent examples into blockers.
        await includePath(
          path.resolve(path.dirname(normalized), reference),
          false,
        );
      }
      for (const agentRef of frontmatterFieldValues(
        text,
        new Set(['agent', 'agents']),
      )) {
        const [qualifiedPlugin, agentName] = agentRef.includes(':')
          ? agentRef.split(':', 2)
          : [descriptor.rootName, agentRef];
        if (qualifiedPlugin !== descriptor.rootName || !agentName) {
          blockers.push({
            code: 'UNRESOLVED_INVOCATION',
            message: `Transitive agent ${agentRef} could not be resolved.`,
            subject: agentRef,
            origin: 'transitive',
          });
          continue;
        }
        await includePath(path.join(sourceRoot, 'agents', `${agentName}.md`));
      }
    }
  };
  try {
    if (descriptor.runtimeKind === 'plugin_fragment') {
      const manifestPath = path.join(
        sourceRoot,
        provider === 'codex' ? '.codex-plugin' : '.claude-plugin',
        'plugin.json',
      );
      try {
        await fs.access(manifestPath);
        await includeSanitizedPluginManifest(manifestPath);
      } catch {
        if (descriptor.syntheticManifestName) {
          includeSyntheticPluginManifest(manifestPath);
        }
      }
    }
    await includePath(memberRoot);
  } catch {
    blockers.push({
      code: 'MISSING_DEPENDENCY_SOURCE',
      message: 'A dependency source file is missing.',
    });
  }
  return { entries, texts };
}

function isPathWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isPathStrictlyInside(parent: string, child: string): boolean {
  return (
    path.relative(parent, child) !== '' && isPathWithinOrEqual(parent, child)
  );
}

interface CollectionContext {
  blockers: PendingBlocker[];
  blobs: Map<string, Uint8Array>;
  sourceStats: CapabilityPackageAnalysisInternal['sourceStats'];
  sourceDirectories: CapabilityPackageAnalysisInternal['sourceDirectories'];
  budget: CollectionBudget;
}

interface CollectedAutomationPipelines {
  /** A pipeline is bound; its assets are reached through its dependencies. */
  resources: Array<{ resource: PipelinePackageResource; bindingKey?: string }>;
  packagedPipelines: PipelinePackagePackagedPipeline[];
  withheldFiles: PipelinePackageWithheldFile[];
}

/**
 * One declared asset directory as a `file_asset` resource, collected in
 * withhold mode. Returns nothing when the asset blocks or is absent.
 */
async function collectFileAsset(
  asset: FileAssetPortableInput,
  pipelineName: string,
  homedir: string,
  context: CollectionContext,
  withheldFiles: PipelinePackageWithheldFile[],
): Promise<PipelinePackageResource | undefined> {
  const { blockers } = context;
  const subject = `${asset.pipelineKey}/${asset.assetId}`;
  const home = path.resolve(homedir);
  const expanded = expandPipelineAssetPath(asset.sourcePath, home);
  if (expanded === undefined || !isPathStrictlyInside(home, expanded)) {
    blockers.push({
      code: 'ASSET_PATH_OUTSIDE_HOME',
      subject,
      message: `Asset "${asset.assetId}" in "${pipelineName}" points at ${asset.sourcePath}. Asset folders must be inside your home folder, written as an absolute path or starting with ~.`,
    });
    return undefined;
  }
  const realHome = await fs.realpath(home).catch(() => home);
  const realExpanded = await fs.realpath(expanded).catch(() => expanded);
  for (const declaredLocalState of asset.localState) {
    const localState = expandPipelineAssetPath(declaredLocalState, home);
    if (localState === undefined) continue;
    const realLocalState = await fs
      .realpath(localState)
      .catch(() => localState);
    if (
      isPathWithinOrEqual(expanded, localState) ||
      isPathWithinOrEqual(localState, expanded) ||
      isPathWithinOrEqual(realExpanded, realLocalState) ||
      isPathWithinOrEqual(realLocalState, realExpanded)
    ) {
      blockers.push({
        code: 'ASSET_OVERLAPS_LOCAL_STATE',
        subject,
        message: `Asset "${asset.assetId}" in "${pipelineName}" (${asset.sourcePath}) overlaps its local_state entry ${declaredLocalState}. Keep shared assets and per-runner state in separate folders.`,
      });
      return undefined;
    }
  }
  let stat;
  try {
    stat = await fs.stat(expanded);
  } catch {
    stat = undefined;
  }
  if (!stat?.isDirectory()) {
    if (!stat) {
      context.sourceDirectories.push({
        path: expanded,
        entries: [],
        missing: true,
      });
    }
    if (asset.required) {
      blockers.push({
        code: 'MISSING_REQUIRED_ASSET',
        subject,
        message: `Asset "${asset.assetId}" in "${pipelineName}" has no folder at ${asset.sourcePath}. Create it, or mark the asset as not required.`,
      });
    } else {
      withheldFiles.push({
        pipelineKey: asset.pipelineKey,
        assetId: asset.assetId,
        relativePath: '',
        reason: 'missing_optional_asset',
      });
    }
    return undefined;
  }
  if (!isPathStrictlyInside(realHome, realExpanded)) {
    blockers.push({
      code: 'ASSET_PATH_OUTSIDE_HOME',
      subject,
      message: `Asset "${asset.assetId}" in "${pipelineName}" resolves outside your home folder. Asset folders must be inside your home folder.`,
    });
    return undefined;
  }
  const collected = await collectMemberFiles(
    {
      // The resolved root, so a symlinked asset folder is read in place and
      // anything under it that leaves it is an escape.
      sourceRoot: realExpanded,
      memberPath: '.',
      sourceVisibility: 'local',
      // Paths relative to the member root; nothing else of a skill applies.
      runtimeKind: 'standalone_skill',
      rootName: asset.assetId,
    },
    'claude',
    blockers,
    context.blobs,
    context.sourceStats,
    context.sourceDirectories,
    context.budget,
    {
      withhold: ({ relativePath, reason }) => {
        withheldFiles.push({
          pipelineKey: asset.pipelineKey,
          assetId: asset.assetId,
          relativePath,
          reason,
        });
      },
    },
  );
  return {
    id: fileAssetResourceId(asset.pipelineKey, asset.assetId),
    kind: 'file_asset',
    displayName: asset.assetId,
    sourceLabel: pipelineName,
    sourceVisibility: 'local',
    invocationKeys: [],
    dependencyResourceIds: [],
    pipelineKey: asset.pipelineKey,
    assetId: asset.assetId,
    installMode: asset.installMode,
    required: asset.required,
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'pipeline_asset',
        rootName: asset.assetId,
        entries: collected.entries.sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
      },
    ],
  };
}

/**
 * The pipelines an automation share carries, each as one `pipeline.yaml`
 * blob, with the asset folders they declare. Only the action pipeline and
 * pipelines the reference resolution selected are packaged; unselected
 * suggestions are listed in the summary but carry no resource.
 */
async function collectAutomationPipelines(
  input: AnalyzeCapabilityPackageInput,
  resolved: ReadonlyArray<{
    key: string;
    name: string;
    required: boolean;
    selected: boolean;
    promptSpans: PipelinePackagePackagedPipeline['promptSpans'];
  }>,
  context: CollectionContext,
): Promise<CollectedAutomationPipelines> {
  const { blockers } = context;
  const collected: CollectedAutomationPipelines = {
    resources: [],
    packagedPipelines: [],
    withheldFiles: [],
  };
  const resolvedByKey = new Map(resolved.map((entry) => [entry.key, entry]));
  const inputsByKey = new Map<string, AutomationPipelinePortableInput>();
  for (const pipeline of input.automationPipelines ?? []) {
    const existing = inputsByKey.get(pipeline.pipelineKey);
    if (existing) {
      blockers.push({
        code: 'DUPLICATE_PIPELINE_KEY',
        subject: pipeline.pipelineKey,
        message: `"${existing.name}" and "${pipeline.name}" would travel under the same key, ${pipeline.pipelineKey}. Rename one of the pipeline files.`,
      });
      continue;
    }
    inputsByKey.set(pipeline.pipelineKey, pipeline);
  }
  for (const entry of resolved) {
    if (entry.selected && !inputsByKey.has(entry.key)) {
      blockers.push({
        code: 'MISSING_DEPENDENCY_SOURCE',
        subject: entry.name,
        message: `"${entry.name}" could not be read, so it can't be included.`,
      });
    }
  }
  const homedir = input.homedir ?? os.homedir();
  const keys = Array.from(inputsByKey.keys()).sort();
  for (const key of keys) {
    const pipeline = inputsByKey.get(key);
    if (!pipeline) continue;
    const isActionPipeline = key === AUTOMATION_ACTION_PIPELINE_KEY;
    const resolution = resolvedByKey.get(key);
    // Only pipelines the automation resolves travel.
    if (!isActionPipeline && !resolution) continue;
    const name = pipeline.name.trim() || key;
    const resourceId = automationPipelineResourceId(key);
    const pipelineContentHash = hashPipelinePackageYaml(pipeline.rawContent);
    collected.packagedPipelines.push({
      key,
      resourceId,
      name,
      pipelineContentHash,
      source: pipeline.source,
      isActionPipeline,
      optional: !isActionPipeline && resolution?.required !== true,
      promptSpans: resolution?.promptSpans ?? [],
    });
    if (!isActionPipeline && resolution?.selected !== true) continue;
    const bytes = new TextEncoder().encode(pipeline.rawContent);
    if (
      !reserveCollectionFile(context.budget, blockers, {
        subject: `${key}/${AUTOMATION_PIPELINE_TREE_ENTRY_PATH}`,
        relativePath: AUTOMATION_PIPELINE_TREE_ENTRY_PATH,
        size: bytes.byteLength,
      })
    )
      continue;
    // The root YAML is scanned like any packaged file, so a literal token in
    // `env` blocks while `${{ secrets.NAME }}` does not.
    if (
      containsPipelinePackageSecretMaterial(
        stripControlCharacters(pipeline.rawContent),
      )
    ) {
      blockers.push({
        code: 'SUSPECTED_SECRET',
        subject: name,
        relativePath: AUTOMATION_PIPELINE_TREE_ENTRY_PATH,
        message: `"${name}" may contain a credential. Move it into a secret and reference it as \${{ secrets.NAME }}.`,
      });
      continue;
    }
    context.blobs.set(pipelineContentHash, bytes);
    if (pipeline.sourcePath) {
      try {
        const stat = await fs.stat(pipeline.sourcePath);
        context.sourceStats.push({
          path: path.resolve(pipeline.sourcePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: pipelineContentHash,
        });
      } catch {
        // Analyzed from content the host already read; nothing to watch.
      }
    }
    const assetResourceIds: string[] = [];
    for (const asset of input.fileAssets ?? []) {
      if (asset.pipelineKey !== key) continue;
      const resource = await collectFileAsset(
        asset,
        name,
        homedir,
        context,
        collected.withheldFiles,
      );
      if (!resource) continue;
      assetResourceIds.push(resource.id);
      collected.resources.push({ resource });
    }
    collected.resources.push({
      resource: {
        id: resourceId,
        kind: 'automation_pipeline',
        displayName: name,
        sourceLabel:
          pipeline.source === 'user' ? 'Your pipelines' : 'Project pipelines',
        sourceVisibility: 'local',
        invocationKeys: [],
        dependencyResourceIds: assetResourceIds,
        pipelineKey: key,
        pipelineContentHash,
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'automation_pipeline',
            rootName: key,
            entries: [
              {
                path: AUTOMATION_PIPELINE_TREE_ENTRY_PATH,
                sha256: pipelineContentHash,
                size: bytes.byteLength,
                mode: 'read',
              },
            ],
          },
        ],
      },
      bindingKey: pipeline.bindingKey,
    });
  }
  return collected;
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

function blockerIdentity(blocker: PipelinePackageAnalysisBlocker): string {
  return [
    blocker.code,
    blocker.origin ?? '',
    blocker.subject ?? '',
    blocker.relativePath ?? '',
    blocker.subject || blocker.relativePath ? '' : blocker.message,
    blocker.dismissal ? `dismissible:${blocker.dismissal.provider}` : 'fixed',
  ].join('\0');
}

/**
 * The package analyzer. Every subject reaches it as neutral input: the content
 * the manifest is keyed to, the capabilities it requests, the prompt text it
 * executes, and the requirements its host already knows about. A pipeline is
 * translated into that input by `buildPipelineCapabilityPackageSources`.
 *
 * Unconfirmed requests and prompt sources are best effort: what they find is
 * packaged only when it adds no blocker to the analysis of the confirmed
 * input alone. Otherwise that confirmed analysis is the result, so an
 * unconfirmed provider can never block a share.
 *
 * The fallback is all or nothing: one new blocker drops every unconfirmed
 * find, including clean ones, because blockers aren't attributed to the
 * sources that reached them. It also analyzes twice, collecting member files
 * again, but only when unconfirmed input is present and blockers exist.
 */
export async function analyzeCapabilityPackage(
  input: AnalyzeCapabilityPackageInput,
): Promise<CapabilityPackageAnalysisInternal> {
  const promptSources = input.promptSources ?? [];
  const hasUnconfirmed =
    input.requests.some((request) => request.unconfirmed) ||
    promptSources.some((source) => source.unconfirmed) ||
    (input.definitionResources ?? []).some(
      (definition) =>
        (definition.requestKeys ?? []).some((request) => request.unconfirmed) ||
        (definition.promptTexts ?? []).some((text) => text.unconfirmed),
    );
  const withUnconfirmed = await analyzeCapabilityPackageOnce(input);
  if (!hasUnconfirmed || withUnconfirmed.summary.blockers.length === 0) {
    return withUnconfirmed;
  }
  const confirmed = await analyzeCapabilityPackageOnce({
    ...input,
    requests: input.requests.filter((request) => !request.unconfirmed),
    promptSources: promptSources.filter((source) => !source.unconfirmed),
    ...(input.definitionResources
      ? {
          definitionResources: input.definitionResources.map((definition) => ({
            ...definition,
            requestKeys: (definition.requestKeys ?? []).filter(
              (request) => !request.unconfirmed,
            ),
            promptTexts: (definition.promptTexts ?? []).filter(
              (text) => !text.unconfirmed,
            ),
          })),
        }
      : {}),
  });
  const confirmedBlockers = new Set(
    confirmed.summary.blockers.map(blockerIdentity),
  );
  return withUnconfirmed.summary.blockers.every((blocker) =>
    confirmedBlockers.has(blockerIdentity(blocker)),
  )
    ? withUnconfirmed
    : confirmed;
}

async function analyzeCapabilityPackageOnce(
  input: AnalyzeCapabilityPackageInput,
): Promise<CapabilityPackageAnalysisInternal> {
  const promptSources = input.promptSources ?? [];
  const blockers: PendingBlocker[] = [];
  const suppressedInvocations = new Map<
    string,
    {
      provider: 'claude' | 'codex';
      token: string;
      /** The token appeared in a prompt source, not only via a dependency. */
      direct: boolean;
      occurrences: Array<{ jobId: string; stepId: string }>;
      resourceKeys: Set<string>;
    }
  >();
  const bindings = new Map<string, Set<string>>();
  const optionalBindings = new Map<string, Set<string>>();
  const selected = new Map<string, ResolvedInvocable>();
  const matchedRequestIds = new Set<string>();
  for (const request of input.requests) {
    const requestId = `${request.provider}\0${request.key}`;
    const candidateIds = new Set(
      input.capabilityInventoryEntryIdsByKey?.[request.key] ?? [],
    );
    const candidates = input.invocableInventory.entries.filter(
      (entry) =>
        candidateIds.has(entry.id) && entry.provider === request.provider,
    );
    for (const entry of candidates) {
      matchedRequestIds.add(requestId);
      const resolved: ResolvedInvocable = { origin: 'inventory', entry };
      const key = logicalEntryKey(resolved);
      selected.set(key, resolved);
      const targetBindings = request.required ? bindings : optionalBindings;
      const ids = targetBindings.get(request.bindingKey) ?? new Set<string>();
      ids.add(key);
      targetBindings.set(request.bindingKey, ids);
    }
  }
  const requiredRequests = new Map(
    input.requests
      .filter((request) => request.required && !request.unconfirmed)
      .map((request) => [`${request.provider}\0${request.key}`, request]),
  );
  const pipelineReferenceCollector =
    input.pipelineInventory !== undefined ||
    input.pipelineRequests !== undefined ||
    input.automationPipelines !== undefined
      ? createAutomationPipelineReferenceCollector({
          inventory: input.pipelineInventory ?? [],
          requests: input.pipelineRequests,
          selections: input.pipelineSelections,
          dismissedReferences: input.dismissedReferences,
        })
      : undefined;
  for (const [requestId, request] of Array.from(requiredRequests)) {
    if (!matchedRequestIds.has(requestId)) {
      blockers.push({
        code: 'MISSING_DEPENDENCY_SOURCE',
        message: `Required ${request.provider} structured dependency ${request.key} could not be resolved.`,
        subject: request.key,
      });
    }
  }
  for (const promptSource of promptSources) {
    const location = promptSourceLocation(promptSource);
    const bindingKey = promptSourceBindingKey(promptSource);
    if (promptSource.pipelineReferences) {
      pipelineReferenceCollector?.addPromptText(promptSource.text, location);
    }
    for (const token of extractInvocationTokens(promptSource.text)) {
      const invocation = token.value;
      const provider = invocation.startsWith('$')
        ? 'codex'
        : promptSource.provider;
      const decision = classifyInvocation(
        input,
        token,
        provider,
        'prompt',
        !promptSource.unconfirmed,
      );
      if (decision.kind === 'ignored') {
        if (decision.dismissed) {
          const dismissalKey = invocationDismissalKey(provider, invocation);
          const dismissed = suppressedInvocations.get(dismissalKey) ?? {
            provider,
            token: invocation,
            direct: false,
            occurrences: [],
            resourceKeys: new Set<string>(),
          };
          // A step-less subject contributes no location, but the token was
          // still dismissed here rather than reached transitively, so the note
          // must stay attributed as direct.
          dismissed.direct = true;
          if (location) dismissed.occurrences.push(location);
          suppressedInvocations.set(dismissalKey, dismissed);
        }
        continue;
      }
      if (decision.kind === 'unresolved') {
        blockers.push({
          code: 'UNRESOLVED_INVOCATION',
          message: `Required invocation ${invocation} could not be resolved.`,
          subject: invocation,
          origin: 'direct',
          provider,
          ...location,
          ...(decision.dismissible
            ? { dismissal: { provider, token: invocation } }
            : {}),
        });
        continue;
      }
      if (decision.kind === 'ambiguous') {
        blockers.push({
          code: 'AMBIGUOUS_INVOCATION',
          message: `Required invocation ${invocation} is ambiguous.`,
          subject: invocation,
          origin: 'direct',
          provider,
          ...location,
        });
        continue;
      }
      const key = logicalEntryKey(decision.target);
      selected.set(key, decision.target);
      const ids = bindings.get(bindingKey) ?? new Set<string>();
      ids.add(key);
      bindings.set(bindingKey, ids);
    }
  }
  // Portable definitions. Each document is validated before anything it
  // needs is resolved, so an invalid definition contributes no dependency.
  // Inputs are processed in resource-id order, which keeps blocker order and
  // resource selection independent of caller ordering.
  const definitions: Array<{
    input: CapabilityPackageDefinitionResourceInput;
    id: string;
    references: string[];
    directKeys: Set<string>;
  }> = [];
  const definitionIds = new Set<string>();
  for (const definition of [...(input.definitionResources ?? [])]
    .map((candidate) => ({
      candidate,
      id: capabilityPackageDefinitionResourceId(
        candidate.kind,
        candidate.identity,
      ),
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const { candidate, id } = definition;
    if (definitionIds.has(id)) {
      blockers.push({
        code: 'INVALID_PACKAGE',
        message: `${candidate.displayName} is listed more than once.`,
        subject: candidate.identity,
      });
      continue;
    }
    definitionIds.add(id);
    const parsed = parseSharedContainerDefinitionDocument(candidate.document);
    if (!parsed.ok || parsed.value.kind !== candidate.kind) {
      blockers.push({
        code: 'INVALID_PACKAGE',
        message: `${candidate.displayName} is not a valid portable definition${
          parsed.ok ? '.' : `: ${parsed.errors.join('; ')}`
        }`,
        subject: candidate.identity,
      });
      continue;
    }
    const directKeys = new Set<string>();
    for (const request of candidate.requestKeys ?? []) {
      const candidates = definitionRequestCandidates(input, request);
      if (candidates.length === 0) {
        if (request.required && !request.unconfirmed)
          blockers.push({
            code: 'MISSING_DEPENDENCY_SOURCE',
            message: `Required ${request.provider} dependency ${request.key} of ${candidate.displayName} could not be resolved.`,
            subject: request.key,
          });
        continue;
      }
      for (const entry of candidates) {
        const resolved: ResolvedInvocable = { origin: 'inventory', entry };
        const key = logicalEntryKey(resolved);
        selected.set(key, resolved);
        directKeys.add(key);
      }
    }
    for (const promptText of candidate.promptTexts ?? []) {
      for (const token of extractInvocationTokens(promptText.text)) {
        const invocation = token.value;
        const provider = invocation.startsWith('$')
          ? 'codex'
          : promptText.provider;
        const decision = classifyInvocation(
          input,
          token,
          provider,
          'prompt',
          !promptText.unconfirmed,
        );
        if (decision.kind === 'ignored') {
          if (decision.dismissed) {
            const dismissalKey = invocationDismissalKey(provider, invocation);
            const dismissed = suppressedInvocations.get(dismissalKey) ?? {
              provider,
              token: invocation,
              direct: false,
              occurrences: [],
              resourceKeys: new Set<string>(),
            };
            dismissed.direct = true;
            suppressedInvocations.set(dismissalKey, dismissed);
          }
          continue;
        }
        if (decision.kind === 'unresolved') {
          blockers.push({
            code: 'UNRESOLVED_INVOCATION',
            message: `Required invocation ${invocation} in ${candidate.displayName} could not be resolved.`,
            subject: invocation,
            origin: 'direct',
            provider,
            ...(decision.dismissible
              ? { dismissal: { provider, token: invocation } }
              : {}),
          });
          continue;
        }
        if (decision.kind === 'ambiguous') {
          blockers.push({
            code: 'AMBIGUOUS_INVOCATION',
            message: `Required invocation ${invocation} in ${candidate.displayName} is ambiguous.`,
            subject: invocation,
            origin: 'direct',
            provider,
          });
          continue;
        }
        const key = logicalEntryKey(decision.target);
        selected.set(key, decision.target);
        directKeys.add(key);
      }
    }
    definitions.push({
      input: candidate,
      id,
      references: parsed.value.references,
      directKeys,
    });
  }
  const blobs = new Map<string, Uint8Array>();
  const sourceStats: CapabilityPackageAnalysisInternal['sourceStats'] = [];
  const sourceDirectories: CapabilityPackageAnalysisInternal['sourceDirectories'] =
    [];
  const collectionBudget: CollectionBudget = {
    files: 0,
    bytes: 0,
    exhausted: false,
  };
  const portableResources: Array<{
    input: CapabilityPackagePortableResourceInput;
    id: string;
    files: PipelinePackageFileEntry[];
  }> = [];
  for (const resource of input.portableResources ?? []) {
    const collected = await collectMemberFiles(
      resource.descriptor,
      'claude',
      blockers,
      blobs,
      sourceStats,
      sourceDirectories,
      collectionBudget,
    );
    portableResources.push({
      input: resource,
      // Keyed by the authored ref, so a literal child keeps the id it had
      // before evaluated keys existed.
      id: createHash('sha256')
        .update(
          `${resource.kind}\0${resource.invocationKeys[0] ?? ''}\0${resource.bindingKey}${
            resource.idScope === undefined ? '' : `\0${resource.idScope}`
          }`,
        )
        .digest('hex')
        .slice(0, 24),
      files: collected.entries,
    });
  }
  const pipelineReferences = pipelineReferenceCollector?.finish();
  blockers.push(...(pipelineReferences?.blockers ?? []));
  const automationPipelines = pipelineReferenceCollector
    ? await collectAutomationPipelines(
        input,
        pipelineReferences?.pipelines ?? [],
        {
          blockers,
          blobs,
          sourceStats,
          sourceDirectories,
          budget: collectionBudget,
        },
      )
    : undefined;
  // Child pipelines and actions a definition carries. Their ids include the
  // owning definition's id: two definitions can name the same relative child
  // path while meaning different files.
  const portableIdsByDefinitionId = new Map<string, string[]>();
  for (const definition of definitions) {
    const ids: string[] = [];
    for (const resource of definition.input.portableResources ?? []) {
      const id = createHash('sha256')
        .update(
          `${resource.kind}\0${resource.invocationKeys[0] ?? ''}\0${definition.input.bindingKey}\0${definition.id}`,
        )
        .digest('hex')
        .slice(0, 24);
      if (ids.includes(id)) continue;
      ids.push(id);
      const collected = await collectMemberFiles(
        resource.descriptor,
        'claude',
        blockers,
        blobs,
        sourceStats,
        sourceDirectories,
        collectionBudget,
      );
      portableResources.push({
        input: { ...resource, bindingKey: definition.input.bindingKey },
        id,
        files: collected.entries,
      });
    }
    portableIdsByDefinitionId.set(definition.id, ids);
  }
  for (const directoryPath of input.repoLocalInvocables?.scannedDirectories ??
    []) {
    try {
      const children = await fs.readdir(directoryPath, { withFileTypes: true });
      sourceDirectories.push({
        path: directoryPath,
        entries: children
          .map((child) =>
            [
              child.name,
              child.isDirectory()
                ? 'directory'
                : child.isFile()
                  ? 'file'
                  : child.isSymbolicLink()
                    ? 'symlink'
                    : 'other',
            ].join('\0'),
          )
          .sort(),
      });
    } catch {
      sourceDirectories.push({
        path: directoryPath,
        entries: [],
        missing: true,
      });
    }
  }
  const discoveredText: string[] = [];
  const collectedByKey = new Map<
    string,
    { target: ResolvedInvocable; files: PipelinePackageFileEntry[] }
  >();
  const dependencyKeys = new Map<string, Set<string>>();
  const pending = Array.from(selected.keys());
  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
    const key = pending[pendingIndex];
    if (!key || collectedByKey.has(key)) continue;
    const target = selected.get(key);
    if (!target) continue;
    const { entry } = target;
    const descriptor = sourceDescriptor(input, target);
    if (!descriptor) {
      blockers.push({
        code: 'MISSING_DEPENDENCY_SOURCE',
        message: `The source for ${entry.displayName} is unavailable.`,
        subject: entry.invocationKey,
      });
      continue;
    }
    const provider = resolvedProvider(target);
    const collected =
      descriptor.sourceVisibility === 'builtin'
        ? { entries: [], texts: [] }
        : await collectMemberFiles(
            descriptor,
            provider,
            blockers,
            blobs,
            sourceStats,
            sourceDirectories,
            collectionBudget,
          );
    discoveredText.push(...collected.texts);
    collectedByKey.set(key, { target, files: collected.entries });
    const dependencies = dependencyKeys.get(key) ?? new Set<string>();
    dependencyKeys.set(key, dependencies);
    const transitiveInvocations = new Map<
      string,
      {
        token: InvocationTokenContext;
        requiresResolution: boolean;
        origin: 'body' | 'frontmatter';
      }
    >();
    for (const text of collected.texts) {
      for (const token of extractInvocationTokens(text)) {
        const invocation = token.value;
        // Unqualified body tokens are indistinguishable from shell variables and
        // path fragments. Follow them when inventory proves they are invocations;
        // only unresolved, explicitly qualified references are blockers.
        const requiresResolution = invocation.includes(':');
        const previous = transitiveInvocations.get(invocation);
        transitiveInvocations.set(invocation, {
          token:
            previous && !isPathShapedInvocationToken(previous.token)
              ? previous.token
              : token,
          requiresResolution:
            (previous?.requiresResolution ?? false) || requiresResolution,
          origin: previous?.origin ?? 'body',
        });
      }
      for (const invocation of frontmatterInvocationStrings(
        text,
        provider,
        target.origin === 'inventory' &&
          target.entry.enableRef.kind === 'plugin'
          ? target.entry.enableRef.pluginName
          : undefined,
      )) {
        // Frontmatter declarations are structured invocation references, so a
        // missing inventory match must remain visible even when unqualified.
        transitiveInvocations.set(invocation, {
          token: { value: invocation, before: '', after: '' },
          requiresResolution: true,
          origin: 'frontmatter',
        });
      }
    }
    for (const [invocation, reference] of Array.from(
      transitiveInvocations.entries(),
    )) {
      const provider = invocation.startsWith('$')
        ? 'codex'
        : resolvedProvider(target);
      const decision = classifyInvocation(
        input,
        reference.token,
        provider,
        reference.origin,
        reference.requiresResolution,
      );
      if (decision.kind === 'ignored') {
        if (decision.dismissed) {
          const dismissalKey = invocationDismissalKey(provider, invocation);
          const dismissed = suppressedInvocations.get(dismissalKey) ?? {
            provider,
            token: invocation,
            direct: false,
            occurrences: [] as Array<{ jobId: string; stepId: string }>,
            resourceKeys: new Set<string>(),
          };
          dismissed.resourceKeys.add(key);
          suppressedInvocations.set(dismissalKey, dismissed);
        }
        continue;
      }
      if (decision.kind === 'unresolved') {
        blockers.push({
          code: 'UNRESOLVED_INVOCATION',
          message: `Transitive invocation ${invocation} could not be resolved.`,
          subject: invocation,
          origin: 'transitive',
          provider,
          occurrenceResourceKeys: [key],
          ...(decision.dismissible
            ? { dismissal: { provider, token: invocation } }
            : {}),
        });
        continue;
      }
      if (decision.kind === 'ambiguous') {
        blockers.push({
          code: 'AMBIGUOUS_INVOCATION',
          message: `Transitive invocation ${invocation} is ambiguous.`,
          subject: invocation,
          origin: 'transitive',
          provider,
          occurrenceResourceKeys: [key],
        });
        continue;
      }
      const dependencyKey = logicalEntryKey(decision.target);
      dependencies.add(dependencyKey);
      if (!selected.has(dependencyKey)) {
        selected.set(dependencyKey, decision.target);
        pending.push(dependencyKey);
      }
    }
  }
  const occurrencesByResourceKey = new Map<
    string,
    Map<string, { jobId: string; stepId: string }>
  >();
  for (const targetBindings of [bindings, optionalBindings]) {
    for (const [stepKey, rootKeys] of Array.from(targetBindings.entries())) {
      const [jobId, stepId] = stepKey.split('\0');
      if (!jobId || !stepId) continue;
      const closure = new Set<string>(rootKeys);
      const pendingDependencies: string[] = Array.from(rootKeys);
      while (pendingDependencies.length > 0) {
        const resourceKey = pendingDependencies.pop();
        if (!resourceKey) continue;
        for (const dependencyKey of Array.from(
          dependencyKeys.get(resourceKey) ?? [],
        )) {
          if (closure.has(dependencyKey)) continue;
          closure.add(dependencyKey);
          pendingDependencies.push(dependencyKey);
        }
      }
      for (const resourceKey of Array.from(closure)) {
        const occurrences =
          occurrencesByResourceKey.get(resourceKey) ??
          new Map<string, { jobId: string; stepId: string }>();
        occurrences.set(stepKey, { jobId, stepId });
        occurrencesByResourceKey.set(resourceKey, occurrences);
      }
    }
  }
  const occurrencesForResourceKey = (
    resourceKey: string,
  ): Array<{ jobId: string; stepId: string }> =>
    Array.from(occurrencesByResourceKey.get(resourceKey)?.values() ?? []);
  const resourceIdByKey = new Map(
    Array.from(collectedByKey.keys()).map((key) => [
      key,
      createHash('sha256').update(key).digest('hex').slice(0, 24),
    ]),
  );
  const resources: PipelinePackageResource[] = [];
  for (const [key, collected] of Array.from(collectedByKey.entries())) {
    const { entry } = collected.target;
    // A Cursor chat's inherited home-folder row has no package source: it is
    // the user's own file, not a Canopy resource a pipeline can carry.
    if (entry.kind === 'inherited_skill' || entry.kind === 'inherited_command')
      continue;
    const descriptor = sourceDescriptor(input, collected.target);
    const id = resourceIdByKey.get(key);
    if (!descriptor || !id) continue;
    resources.push({
      id,
      ...('enableRef' in entry &&
      (entry.enableRef.kind === 'plugin' || entry.enableRef.kind === 'skill')
        ? { installedItemRef: entry.enableRef }
        : {}),
      kind: entry.kind === 'skill' ? 'standalone_skill' : entry.kind,
      displayName: entry.displayName,
      sourceLabel: entry.sourceLabel ?? descriptor.rootName,
      sourceVisibility: descriptor.sourceVisibility,
      invocationKeys: [entry.invocationKey],
      dependencyResourceIds: Array.from(dependencyKeys.get(key) ?? [])
        .filter((dependencyKey) => collectedByKey.has(dependencyKey))
        .map((dependencyKey) => resourceIdByKey.get(dependencyKey))
        .filter((dependencyId): dependencyId is string =>
          Boolean(dependencyId),
        ),
      trees:
        descriptor.sourceVisibility === 'builtin'
          ? []
          : [
              {
                provider: resolvedProvider(collected.target),
                runtimeKind: descriptor.runtimeKind,
                rootName: descriptor.rootName,
                entries: collected.files,
              },
            ],
    });
  }
  for (const portable of portableResources) {
    const { descriptor } = portable.input;
    resources.push({
      id: portable.id,
      kind: portable.input.kind,
      displayName: portable.input.displayName,
      sourceLabel: descriptor.rootName,
      sourceVisibility: descriptor.sourceVisibility,
      invocationKeys: Array.from(new Set(portable.input.invocationKeys)),
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: descriptor.runtimeKind,
          rootName: descriptor.rootName,
          entries: portable.files,
        },
      ],
    });
  }
  // Definition resources, after every other resource so their files reserve
  // budget only once skills and portable files have.
  const emittedResourceIds = new Set(resources.map((resource) => resource.id));
  const emittedDefinitions = definitions.filter((definition) => {
    const size = definition.input.document.byteLength;
    if (
      !reserveCollectionFile(collectionBudget, blockers, {
        subject: `${definition.input.displayName}/${SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH}`,
        relativePath: SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
        size,
      })
    )
      return false;
    emittedResourceIds.add(definition.id);
    return true;
  });
  const definitionsByIdentity = new Map<string, string[]>();
  for (const definition of emittedDefinitions) {
    const ids = definitionsByIdentity.get(definition.input.identity) ?? [];
    ids.push(definition.id);
    definitionsByIdentity.set(definition.input.identity, ids);
  }
  const definitionDependencies = new Map<string, Set<string>>();
  for (const definition of emittedDefinitions) {
    const dependencies = new Set<string>();
    for (const identity of definition.input.dependsOnIdentities ?? []) {
      const matches = (definitionsByIdentity.get(identity) ?? []).filter(
        (id) => id !== definition.id,
      );
      if (matches.length === 1 && matches[0]) {
        dependencies.add(matches[0]);
        continue;
      }
      blockers.push(
        matches.length === 0
          ? {
              code: 'MISSING_DEPENDENCY_SOURCE',
              message: `${definition.input.displayName} depends on a definition that is not packaged.`,
              subject: identity,
            }
          : {
              code: 'INVALID_PACKAGE',
              message: `${definition.input.displayName} depends on an ambiguous definition.`,
              subject: identity,
            },
      );
    }
    definitionDependencies.set(definition.id, dependencies);
  }
  const directKeysByDefinitionId = new Map(
    emittedDefinitions.map((definition) => [
      definition.id,
      definition.directKeys,
    ]),
  );
  const definitionClosure = (definitionId: string): string[] => {
    const closure = new Set<string>();
    const visitedDefinitions = new Set<string>([definitionId]);
    const pendingDefinitions = [definitionId];
    const capabilityKeys = new Set<string>();
    while (pendingDefinitions.length > 0) {
      const current = pendingDefinitions.pop();
      if (current === undefined) continue;
      for (const key of Array.from(
        directKeysByDefinitionId.get(current) ?? [],
      )) {
        capabilityKeys.add(key);
      }
      for (const dependency of Array.from(
        definitionDependencies.get(current) ?? [],
      )) {
        if (dependency !== definitionId) closure.add(dependency);
        if (visitedDefinitions.has(dependency)) continue;
        visitedDefinitions.add(dependency);
        pendingDefinitions.push(dependency);
      }
    }
    for (const portableId of portableIdsByDefinitionId.get(definitionId) ?? [])
      closure.add(portableId);
    for (const dependency of Array.from(visitedDefinitions)) {
      if (dependency === definitionId) continue;
      for (const portableId of portableIdsByDefinitionId.get(dependency) ?? [])
        closure.add(portableId);
    }
    const pendingKeys = Array.from(capabilityKeys);
    while (pendingKeys.length > 0) {
      const key = pendingKeys.pop();
      if (key === undefined) continue;
      for (const dependencyKey of Array.from(dependencyKeys.get(key) ?? [])) {
        if (capabilityKeys.has(dependencyKey)) continue;
        capabilityKeys.add(dependencyKey);
        pendingKeys.push(dependencyKey);
      }
    }
    for (const key of Array.from(capabilityKeys)) {
      const resourceId = resourceIdByKey.get(key);
      if (
        resourceId !== undefined &&
        collectedByKey.has(key) &&
        emittedResourceIds.has(resourceId)
      )
        closure.add(resourceId);
    }
    return Array.from(closure).sort(compareCodeUnits);
  };
  const definitionClosures = new Map<string, string[]>();
  for (const definition of emittedDefinitions) {
    const closure = definitionClosure(definition.id);
    definitionClosures.set(definition.id, closure);
    for (const reference of definition.references) {
      if (!closure.includes(reference))
        blockers.push({
          code: 'INVALID_PACKAGE',
          message: `${definition.input.displayName} references a resource that is not one of its packaged dependencies.`,
          subject: reference,
        });
    }
    const sha256 = createHash('sha256')
      .update(definition.input.document)
      .digest('hex');
    blobs.set(sha256, definition.input.document);
    resources.push({
      id: definition.id,
      kind: definition.input.kind,
      displayName: definition.input.displayName,
      sourceLabel: definition.input.sourceLabel ?? definition.input.displayName,
      sourceVisibility: definition.input.sourceVisibility ?? 'local',
      invocationKeys: [],
      dependencyResourceIds: closure,
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'standalone_skill',
          rootName: definition.id,
          entries: [
            {
              path: SHARED_CONTAINER_DEFINITION_DOCUMENT_PATH,
              sha256,
              size: definition.input.document.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    });
  }
  if (definitions.length > 0)
    resources.sort((left, right) => compareCodeUnits(left.id, right.id));
  const environmentRequirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const requirement of input.environmentRequirements ?? []) {
    if (
      environmentRequirements.some((existing) => existing.id === requirement.id)
    )
      continue;
    environmentRequirements.push(requirement);
  }
  if (
    discoveredText.some((text) => /(?:^|\s)gh(?:\s|$)/m.test(text)) &&
    !environmentRequirements.some(
      (requirement) =>
        requirement.kind === 'connector' && requirement.id === 'github',
    )
  ) {
    environmentRequirements.push({
      id: 'github',
      kind: 'connector',
      displayName: 'GitHub authentication',
      required: true,
      // The subject binding key deliberately has no job id, so a step-less
      // share lists the requirement with no location rather than a bogus one.
      affectedSteps: Array.from(bindings.keys()).flatMap((stepKey) => {
        const [jobId, stepId] = stepKey.split('\0');
        return jobId && stepId ? [{ jobId, stepId }] : [];
      }),
      setupHint: 'Connect GitHub in Settings.',
    });
  }
  const publisherNotesWithSources = Array.from(
    suppressedInvocations.values(),
  ).map((dismissed) => {
    const note: PipelinePackagePublisherNote = {
      id: `not-a-command-${createHash('sha256')
        .update(`${dismissed.provider}\0${dismissed.token}`)
        .digest('hex')
        .slice(0, 20)}`,
      kind: 'not_a_command',
      label: dismissed.token,
      affectedSteps: Array.from(
        new Map(
          [
            ...dismissed.occurrences,
            ...Array.from(dismissed.resourceKeys).flatMap(
              occurrencesForResourceKey,
            ),
          ].map((occurrence) => [
            `${occurrence.jobId}\0${occurrence.stepId}`,
            occurrence,
          ]),
        ).values(),
      ),
    };
    return { dismissed, note };
  });
  const publisherNotes = publisherNotesWithSources.map(({ note }) => note);
  const publisherNoteSources = Object.fromEntries(
    publisherNotesWithSources.map(({ dismissed, note }) => {
      return [
        note.id,
        {
          direct: dismissed.direct,
          resourceIds: Array.from(dismissed.resourceKeys)
            .map((key) => resourceIdByKey.get(key))
            .filter((id): id is string => id !== undefined),
        },
      ];
    }),
  );
  const manifestBindings = new Map<string, Set<string>>();
  for (const [bindingKey, keys] of Array.from(bindings.entries())) {
    const closure = new Set(keys);
    const pendingDependencies = Array.from(keys);
    while (pendingDependencies.length > 0) {
      const key = pendingDependencies.pop();
      if (!key) continue;
      for (const dependencyKey of Array.from(dependencyKeys.get(key) ?? [])) {
        if (closure.has(dependencyKey)) continue;
        closure.add(dependencyKey);
        pendingDependencies.push(dependencyKey);
      }
    }
    manifestBindings.set(
      bindingKey,
      new Set(
        Array.from(closure)
          .filter((key) => collectedByKey.has(key))
          .map((key) => resourceIdByKey.get(key))
          .filter((id): id is string => Boolean(id)),
      ),
    );
  }
  for (const portable of portableResources) {
    const ids = manifestBindings.get(portable.input.bindingKey) ?? new Set();
    ids.add(portable.id);
    manifestBindings.set(portable.input.bindingKey, ids);
  }
  for (const { resource, bindingKey } of automationPipelines?.resources ?? []) {
    resources.push(resource);
    if (bindingKey === undefined) continue;
    const ids = manifestBindings.get(bindingKey) ?? new Set<string>();
    ids.add(resource.id);
    manifestBindings.set(bindingKey, ids);
  }
  for (const definition of emittedDefinitions) {
    const ids = manifestBindings.get(definition.input.bindingKey) ?? new Set();
    ids.add(definition.id);
    for (const dependencyId of definitionClosures.get(definition.id) ?? [])
      ids.add(dependencyId);
    manifestBindings.set(definition.input.bindingKey, ids);
  }
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml(input.rawContent),
    resources,
    bindings: Array.from(manifestBindings.entries()).map(
      ([bindingKey, resourceIds]) =>
        capabilityPackageBindingFromKey(
          bindingKey,
          definitions.length > 0
            ? Array.from(resourceIds).sort(compareCodeUnits)
            : Array.from(resourceIds),
        ),
    ),
    environmentRequirements,
    ...(publisherNotes.length > 0 ? { publisherNotes } : {}),
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
  const validation = validatePipelinePackageManifest(manifest);
  if (!validation.ok)
    blockers.push(
      ...validation.errors.map((message) => ({
        code: 'INVALID_PACKAGE' as const,
        message,
      })),
    );
  blockers.push(...(input.hostBlockers ?? []));
  const expiresAt = new Date(Date.now() + ANALYSIS_TTL_MS).toISOString();
  const finalizedBlockers = finalizeBlockers(
    blockers,
    occurrencesForResourceKey,
  );
  const dismissedReferences = uniqueReferenceDismissals([
    ...(input.dismissedReferences ?? []).filter(
      (dismissal) => dismissal.kind !== 'pipeline_reference',
    ),
    ...(pipelineReferences?.dismissedReferences ?? []),
  ]);
  return {
    summary: {
      analysisId: randomUUID(),
      state: finalizedBlockers.length === 0 ? 'ready' : 'blocked',
      pipelineContentHash: manifest.pipelineContentHash,
      manifest,
      blockers: finalizedBlockers,
      dismissedInvocations: Array.from(suppressedInvocations.values()).map(
        ({ provider, token }) => ({ provider, token }),
      ),
      ...(dismissedReferences.length > 0 ? { dismissedReferences } : {}),
      ...(automationPipelines
        ? { packagedPipelines: automationPipelines.packagedPipelines }
        : {}),
      ...(automationPipelines && automationPipelines.withheldFiles.length > 0
        ? { withheldFiles: automationPipelines.withheldFiles }
        : {}),
      ...(input.repoLocalInvocables
        ? {
            repoLocalScope: {
              entryCount: input.repoLocalInvocables.entries.length,
              scannedDirectoryCount:
                input.repoLocalInvocables.scannedDirectories.length,
            },
          }
        : {}),
      expiresAt,
    },
    optionalBindings: Array.from(optionalBindings.entries()).map(
      ([bindingKey, keys]) =>
        capabilityPackageBindingFromKey(
          bindingKey,
          Array.from(keys)
            .filter((key) => collectedByKey.has(key))
            .map((key) => resourceIdByKey.get(key))
            .filter((id): id is string => Boolean(id)),
        ),
    ),
    ...(publisherNotes.length > 0 ? { publisherNoteSources } : {}),
    blobs,
    sourceStats,
    sourceDirectories,
  };
}

/**
 * A pipeline analyzed as a capability package: its steps, prompts, and
 * `dependencies:` manifest become neutral analyzer input.
 */
export async function analyzePipelinePackage(
  input: AnalyzePipelinePackageInput,
): Promise<CapabilityPackageAnalysisInternal> {
  const {
    rawPipeline,
    pipeline,
    providerByStep,
    additionalRequests = [],
    additionalPromptSources = [],
    additionalEnvironmentRequirements = [],
    ...shared
  } = input;
  const sources = buildPipelineCapabilityPackageSources(
    pipeline,
    providerByStep,
  );
  return analyzeCapabilityPackage({
    ...shared,
    rawContent: rawPipeline,
    requests: [...sources.requests, ...additionalRequests],
    promptSources: [...sources.promptSources, ...additionalPromptSources],
    environmentRequirements: [
      ...sources.environmentRequirements,
      ...additionalEnvironmentRequirements,
    ],
  });
}

function stepVariants(
  providers: PipelinePackageStepProviders | undefined,
): readonly PipelinePackageStepVariant[] {
  if (providers === undefined) return [];
  return typeof providers === 'string' ? [{ provider: providers }] : providers;
}

/** The analyzer input a pipeline contributes: requests, prompts, requirements. */
export function buildPipelineCapabilityPackageSources(
  pipeline: Pipeline,
  providerByStep: Record<string, PipelinePackageStepProviders>,
): {
  requests: CapabilityPackageRequest[];
  promptSources: CapabilityPackagePromptSource[];
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
} {
  // A step that can run under several providers needs its structured
  // capabilities under each of them.
  const requests = structuredCapabilities(pipeline).flatMap((capability) =>
    capability.affectedSteps.flatMap((affectedStep) => {
      // A provider is confirmed when any variant confirms it.
      const unconfirmedByProvider = new Map<PipelinePackageProvider, boolean>();
      for (const variant of stepVariants(
        providerByStep[`${affectedStep.jobId}.${affectedStep.stepId}`],
      )) {
        unconfirmedByProvider.set(
          variant.provider,
          (unconfirmedByProvider.get(variant.provider) ?? true) &&
            variant.unconfirmed === true,
        );
      }
      return Array.from(
        unconfirmedByProvider,
        ([provider, unconfirmed]): CapabilityPackageRequest => ({
          key: capability.key,
          provider,
          required: capability.required,
          bindingKey: `${affectedStep.jobId}\0${affectedStep.stepId}`,
          ...(unconfirmed ? { unconfirmed } : {}),
        }),
      );
    }),
  );
  const promptSources = Object.entries(pipeline.jobs).flatMap(
    ([jobId, job]) => {
      const stepIds = canonicalStepIds(jobId, job.steps);
      return job.steps.flatMap((step, index) => {
        const stepId = stepIds[index];
        if (!stepId) return [];
        // Only agent steps have a configured provider, and a step without one
        // has no prompt the analyzer can attribute to an inventory. A variant
        // with a known input selection scans the prompt as it would render,
        // so a command only another provider's variant runs is not reported
        // under this one.
        const text = stepPromptText(pipeline, step);
        const sources = new Map<string, CapabilityPackagePromptSource>();
        for (const variant of stepVariants(
          providerByStep[`${jobId}.${stepId}`],
        )) {
          const variantText =
            variant.inputs || variant.absentInputs
              ? interpolateKnownInputs(
                  text,
                  variant.inputs ?? {},
                  variant.absentInputs,
                )
              : text;
          const key = `${variant.provider}\0${variantText}`;
          const existing = sources.get(key);
          // Confirmed by any variant that renders the same text.
          const unconfirmed =
            (existing ? existing.unconfirmed === true : true) &&
            variant.unconfirmed === true;
          sources.set(key, {
            jobId,
            stepId,
            provider: variant.provider,
            text: variantText,
            ...(unconfirmed ? { unconfirmed } : {}),
          });
        }
        return Array.from(sources.values());
      });
    },
  );
  return {
    requests,
    promptSources,
    environmentRequirements: declaredEnvironmentRequirements(pipeline),
  };
}

export async function pipelinePackageAnalysisIsStale(
  analysis: CapabilityPackageAnalysisInternal,
): Promise<boolean> {
  for (const directory of analysis.sourceDirectories) {
    if (directory.missing) {
      try {
        await fs.lstat(directory.path);
        return true;
      } catch {
        continue;
      }
    }
    try {
      const children = await fs.readdir(directory.path, {
        withFileTypes: true,
      });
      const entries = children
        .map((child) =>
          [
            child.name,
            child.isDirectory()
              ? 'directory'
              : child.isFile()
                ? 'file'
                : child.isSymbolicLink()
                  ? 'symlink'
                  : 'other',
          ].join('\0'),
        )
        .sort();
      if (
        entries.length !== directory.entries.length ||
        entries.some((entry, index) => entry !== directory.entries[index])
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  for (const source of analysis.sourceStats) {
    try {
      const stat = await fs.stat(source.path);
      if (stat.size !== source.size || stat.mtimeMs !== source.mtimeMs)
        return true;
      const sha256 = createHash('sha256')
        .update(await fs.readFile(source.path))
        .digest('hex');
      if (sha256 !== source.sha256) return true;
    } catch {
      return true;
    }
  }
  return false;
}
