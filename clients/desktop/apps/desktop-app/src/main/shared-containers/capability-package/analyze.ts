/**
 * One capability package for a shared worktree or Cowork revision (CAN-4655,
 * plan §4 "Add analyzeSharedContainerCapabilityPackage").
 *
 * The composer collects the container's capability usage, resolves every
 * reference unambiguously against the local inventory, repo-local commands
 * and the portable definition builders, and runs the existing package
 * analyzer once over all of it. Resources that cannot be resolved, built or
 * analyzed without a blocker are omitted together with every definition that
 * depends on them; existing package caps are enforced by deterministic
 * pruning. Counts and executable paths come from the final validated
 * manifest only.
 *
 * Diagnostics are counts. No name, path or definition content is logged.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  analyzeCapabilityPackage,
  computePipelinePackageDigestSync,
  pipelinePackageAnalysisIsStale,
  type AnalyzeCapabilityPackageInput,
  type CapabilityPackageAnalysisInternal,
  type CapabilityPackagePromptSource,
  type CapabilityPackageRequest,
  type PipelinePackageSourceDescriptor,
} from '@canopy/desktop-shared/node';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type {
  InvocableInventoryCache,
  InvocableInventoryEntry,
} from '@canopy/execution-engine/types/invocable-inventory';
import type { McpServerRef } from '@canopy/execution-engine/types/mcp-servers';
import type {
  RepoLocalInvocableEntry,
  RepoLocalInvocableIndex,
} from '@canopy/execution-engine/types/pipeline';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  PIPELINE_PACKAGE_MAX_FILES,
  PIPELINE_PACKAGE_MAX_TOTAL_BYTES,
  validatePipelinePackageManifest,
  type PipelinePackageEnvironmentRequirement,
  type PipelinePackageManifestV1,
} from '@canopy/protocol/pipelines';
import {
  summarizeSharedContainerCapabilityPackage,
  type SharedContainerRevisionPackage,
} from '@canopy/protocol/shared-containers';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { isErrnoException } from '../../lib/type-guards';
import {
  collectSharedContainerCapabilityUsage,
  readSharedContainerAgentModel,
  readSharedContainerUserPipeline,
  type CollectSharedContainerCapabilityUsageInput,
  type SharedContainerCapabilityReference,
  type SharedContainerCapabilityUsage,
  type SharedContainerCapabilityUsagePriority,
  type SharedContainerSnapshotPathIndex,
} from '../publish/capability-usage';
import {
  buildAgentDefinitionResource,
  buildAutomationDefinitionResource,
  buildPipelineDefinitionResource,
  toCapabilityPackageDefinitionResourceInput,
  type SharedContainerDefinitionBuildResult,
  type SharedContainerDefinitionBuilderDependencies,
  type SharedContainerDefinitionResourceDraft,
} from './definitions';

/** Bump whenever composition changes; cached analyses then miss. */
export const SHARED_CONTAINER_CAPABILITY_PACKAGE_ANALYSIS_VERSION = 1;

/** Definitions reachable by dependency expansion, bounding a cyclic store. */
const MAX_DEFINITIONS = 500;
/**
 * Analyzer runs one composition may make (the combined analysis, per-unit
 * isolation and pruning re-analyses together) before the package is
 * reported failed.
 */
const MAX_PRUNE_ANALYSES = 24;

export type SharedContainerCapabilityPackageContainerType =
  | 'CODE_WORKTREE'
  | 'COWORK_WORK_ENTRY';

/** A checkout whose repo-local skills and commands may travel. */
export interface SharedContainerCapabilityPackageRepository {
  repoId: string;
  repoPath: string;
}

export interface AnalyzeSharedContainerCapabilityPackageInput {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerCapabilityPackageContainerType;
  includedChatIds: readonly string[];
  /** Paths this revision's code snapshot carries. Code containers only. */
  snapshotPaths?: SharedContainerSnapshotPathIndex;
  /**
   * Repo-local resolution context. Code containers only. Repo-local skills
   * and commands absent from {@link snapshotPaths} are packaged; those the
   * snapshot carries are left to the code.
   */
  repositories?: readonly SharedContainerCapabilityPackageRepository[];
  signal?: AbortSignal;
}

/** Counts only, for diagnostics. */
export interface SharedContainerCapabilityPackageAnalysisDiagnostics {
  references: number;
  unresolved: number;
  ambiguous: number;
  unpackageable: number;
  definitionsOmitted: number;
  dependentsOmitted: number;
  blockedOmitted: number;
  prunedForCaps: number;
  mcpRequirementsOmitted: number;
  /** Hook references; never packaged (see `resolveUnits`). */
  hooksSkipped: number;
  /** Existing sources that could not be read; any one fails the analysis. */
  sourcesUnreadable: number;
  analyses: number;
  reused: boolean;
}

export interface ReadySharedContainerCapabilityPackageAnalysis {
  state: 'ready';
  /** Identity of everything that determined this analysis except file bytes. */
  contentKey: string;
  summary: SharedContainerRevisionPackage;
  manifest: PipelinePackageManifestV1;
  /** Final analysis; its blobs back the upload. */
  analysis: CapabilityPackageAnalysisInternal;
  /** Every source file and directory any attempt read, for staleness. */
  observedSources: Pick<
    CapabilityPackageAnalysisInternal,
    'sourceStats' | 'sourceDirectories'
  >;
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics;
}

export interface EmptySharedContainerCapabilityPackageAnalysis {
  state: 'empty';
  contentKey: string;
  observedSources: Pick<
    CapabilityPackageAnalysisInternal,
    'sourceStats' | 'sourceDirectories'
  >;
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics;
}

export type CompletedSharedContainerCapabilityPackageAnalysis =
  | ReadySharedContainerCapabilityPackageAnalysis
  | EmptySharedContainerCapabilityPackageAnalysis;

export type SharedContainerCapabilityPackageAnalysis =
  | CompletedSharedContainerCapabilityPackageAnalysis
  | { state: 'failed'; reason: string };

export interface StoredUserPipelineDefinition {
  name: string;
  description?: string;
  rawYaml: string;
  /** Stored file, for relative child pipelines. */
  filePath?: string;
}

export interface DiscoveredRepoLocalInvocables {
  entries: Array<{
    name: string;
    kind: 'command' | 'skill';
    absolutePath: string;
  }>;
  scannedDirectories: string[];
}

/**
 * Readers resolve null (or undefined) only when a source is absent and
 * reject when it exists but cannot be read; a rejection fails the analysis
 * rather than shrinking the package.
 */
export interface SharedContainerCapabilityPackageAnalysisDependencies {
  collectUsage: (
    input: CollectSharedContainerCapabilityUsageInput,
  ) => Promise<SharedContainerCapabilityUsage>;
  loadInventory: () => Promise<{
    inventory: InvocableInventoryCache;
    sources: Record<string, PipelinePackageSourceDescriptor>;
  }>;
  discoverRepoLocalInvocables: (
    repoPath: string,
    signal?: AbortSignal,
  ) => Promise<DiscoveredRepoLocalInvocables>;
  getAgentModel: (
    agentId: string,
    projectId: string,
  ) => Promise<AgentModelDefinition | null>;
  readUserPipeline: (
    pipelineId: string,
  ) => Promise<StoredUserPipelineDefinition | null>;
  readPipelineFile: (filePath: string) => Promise<string | null>;
  findCuratedPipelineKey: (pipelineId: string) => Promise<string | undefined>;
  listAutomations: () => Promise<ScheduledActivity[]>;
  mcpSelectionToEnvironmentRequirement: (
    selection: McpServerRef,
  ) => Promise<PipelinePackageEnvironmentRequirement>;
  /** Passed to the definition builders; their defaults when absent. */
  definitionBuilders?: SharedContainerDefinitionBuilderDependencies;
  analyze: (
    input: AnalyzeCapabilityPackageInput,
  ) => Promise<CapabilityPackageAnalysisInternal>;
}

const DEFAULT_DEPENDENCIES: SharedContainerCapabilityPackageAnalysisDependencies =
  {
    collectUsage: (input) => collectSharedContainerCapabilityUsage(input),
    loadInventory: async () => {
      const { loadPipelinePackageInventorySources } =
        await import('../../plugins/invocable-inventory-service');
      return loadPipelinePackageInventorySources();
    },
    discoverRepoLocalInvocables: async (repoPath, signal) => {
      const { discoverProjectInvocableSources } =
        await import('../../agents/project-slash-command-discovery');
      return discoverProjectInvocableSources(repoPath, signal);
    },
    getAgentModel: readSharedContainerAgentModel,
    readUserPipeline: async (pipelineId) => {
      const stored = await readSharedContainerUserPipeline(pipelineId);
      if (!stored) return null;
      const { getPipelinePath } =
        await import('../../pipelines/pipeline-service');
      const filePath = getPipelinePath(pipelineId);
      return {
        name: stored.info.name,
        ...(stored.info.description
          ? { description: stored.info.description }
          : {}),
        rawYaml: stored.rawContent ?? stableStringify(stored.content),
        ...(filePath.success && filePath.data
          ? { filePath: filePath.data }
          : {}),
      };
    },
    readPipelineFile: async (filePath) => {
      try {
        return await readFile(filePath, 'utf8');
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    findCuratedPipelineKey: async (pipelineId) => {
      const { listPipelines } =
        await import('../../pipelines/pipeline-service');
      const listed = listPipelines();
      const match = listed.data?.find((entry) => entry.id === pipelineId);
      return match?.curatedOrigin?.key ?? match?.curatedKey;
    },
    listAutomations: async () => {
      const { getAutomationsService } =
        await import('../../automations/service');
      return (await getAutomationsService().list()).activities;
    },
    mcpSelectionToEnvironmentRequirement: async (selection) => {
      const { mcpSelectionToEnvironmentRequirement } =
        await import('../../mcp/share-requirement');
      return mcpSelectionToEnvironmentRequirement(selection);
    },
    analyze: analyzeCapabilityPackage,
  };

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

type Provider = 'claude' | 'codex';

/**
 * One independently removable root of the package: a used skill, plugin or
 * invocation, or one portable definition. Resources two units share stay as
 * long as either unit does; the analyzer rebuilds the closure each time.
 */
interface PackageUnit {
  key: string;
  priority: SharedContainerCapabilityUsagePriority;
  requests: CapabilityPackageRequest[];
  promptSources: CapabilityPackagePromptSource[];
  entryIdsByKey: Record<string, string[]>;
  definition?: SharedContainerDefinitionResourceDraft;
  /** Keys of definition units this one needs. */
  dependsOn: string[];
}

interface ResolutionContext {
  input: AnalyzeSharedContainerCapabilityPackageInput;
  deps: SharedContainerCapabilityPackageAnalysisDependencies;
  inventory: InvocableInventoryCache;
  sources: Record<string, PipelinePackageSourceDescriptor>;
  repoLocal: RepoLocalResolution;
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics;
  /** Lazily loaded automation list. */
  automations?: Promise<ScheduledActivity[]>;
  localRepositories: readonly SharedContainerCapabilityPackageRepository[];
}

interface RepoLocalResolution {
  index: RepoLocalInvocableIndex;
  sources: Record<string, PipelinePackageSourceDescriptor>;
  /** Invocations the snapshot already carries in code. */
  dismissals: Array<{ provider: Provider; token: string }>;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function definitionUnitKey(identity: string): string {
  return `definition:${identity}`;
}

function strongerPriority(
  left: SharedContainerCapabilityUsagePriority,
  right: SharedContainerCapabilityUsagePriority,
): SharedContainerCapabilityUsagePriority {
  return left === 'observed' || right === 'observed' ? 'observed' : 'fallback';
}

function emptyDiagnostics(): SharedContainerCapabilityPackageAnalysisDiagnostics {
  return {
    references: 0,
    unresolved: 0,
    ambiguous: 0,
    unpackageable: 0,
    definitionsOmitted: 0,
    dependentsOmitted: 0,
    blockedOmitted: 0,
    prunedForCaps: 0,
    mcpRequirementsOmitted: 0,
    hooksSkipped: 0,
    sourcesUnreadable: 0,
    analyses: 0,
    reused: false,
  };
}

/**
 * Runs one source read. A rejection that is not cancellation counts the
 * source as unreadable, which fails the whole analysis, and yields
 * undefined so resolution can finish counting.
 */
async function readSource<T>(
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  try {
    return { value: await read() };
  } catch {
    signal?.throwIfAborted();
    diagnostics.sourcesUnreadable += 1;
    return undefined;
  }
}

function isProvider(value: string): value is Provider {
  return value === 'claude' || value === 'codex';
}

/** The analyzer's own identity of one inventory row. */
function logicalInventoryKey(entry: InvocableInventoryEntry): string {
  const ref = entry.enableRef;
  if (ref.kind === 'none')
    return `${entry.provider}:inherited:${entry.kind}:${entry.name}`;
  return ref.kind === 'skill'
    ? `${entry.provider}:skill:${ref.sourceId}:${ref.skillName}:${entry.kind}:${entry.name}`
    : `${entry.provider}:plugin:${ref.marketplaceId}:${ref.pluginName}:${entry.kind}:${entry.name}`;
}

function subjectRequests(
  key: string,
  providers: Iterable<Provider>,
): CapabilityPackageRequest[] {
  return Array.from(new Set(providers))
    .sort()
    .map((provider) => ({
      key,
      provider,
      required: true,
      bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
    }));
}

/** Selection-shaped units: every packageable row of one skill or plugin. */
function selectionUnit(
  context: ResolutionContext,
  reference: SharedContainerCapabilityReference,
  requestKey: string,
  matches: (entry: InvocableInventoryEntry) => boolean,
): PackageUnit | undefined {
  const all = context.inventory.entries.filter(
    (entry) => isProvider(entry.provider) && matches(entry),
  );
  if (all.length === 0) {
    context.diagnostics.unresolved += 1;
    return undefined;
  }
  const packageable = all.filter((entry) => context.sources[entry.id]);
  if (packageable.length === 0) {
    context.diagnostics.unpackageable += 1;
    return undefined;
  }
  return {
    key: reference.key,
    priority: reference.priority,
    requests: subjectRequests(
      requestKey,
      packageable.flatMap((entry) =>
        isProvider(entry.provider) ? [entry.provider] : [],
      ),
    ),
    promptSources: [],
    entryIdsByKey: {
      [requestKey]: packageable.map((entry) => entry.id).sort(),
    },
    dependsOn: [],
  };
}

/**
 * Mirrors the analyzer's invocation resolution: a repo-local Claude command
 * wins, then an exact inventory key, then a qualified `plugin:member` name.
 * More than one logical match is ambiguous and is never guessed.
 */
function invocationUnit(
  context: ResolutionContext,
  reference: Extract<
    SharedContainerCapabilityReference,
    { kind: 'invocation' }
  >,
): PackageUnit | undefined {
  const { provider, token } = reference;
  const invocationKey = `${provider === 'codex' ? '$' : '/'}${token}`;
  if (provider === 'claude') {
    const repoMatches = context.repoLocal.index.entries.filter(
      (entry) => entry.invocationKey.toLowerCase() === invocationKey,
    );
    // The same invocation in two repositories names two different files.
    if (repoMatches.length > 1) {
      context.diagnostics.ambiguous += 1;
      return undefined;
    }
    const repoMatch = repoMatches[0];
    if (repoMatch) {
      return {
        key: reference.key,
        priority: reference.priority,
        requests: [],
        promptSources: [
          {
            target: 'subject',
            provider: 'claude',
            text: repoMatch.invocationKey,
          },
        ],
        entryIdsByKey: {},
        dependsOn: [],
      };
    }
  }
  let candidates = context.inventory.entries.filter(
    (entry) =>
      entry.provider === provider &&
      entry.invocationKey.toLowerCase() === invocationKey,
  );
  if (candidates.length === 0 && provider === 'claude') {
    const qualified = /^([^:]+):([^:]+)$/.exec(token);
    if (qualified) {
      const [, pluginName, memberName] = qualified;
      candidates = context.inventory.entries.filter(
        (entry) =>
          entry.provider === provider &&
          entry.enableRef.kind === 'plugin' &&
          entry.enableRef.pluginName.toLowerCase() === pluginName &&
          entry.name.toLowerCase() === memberName,
      );
    }
  }
  const logical = new Map<string, InvocableInventoryEntry[]>();
  for (const entry of candidates) {
    const key = logicalInventoryKey(entry);
    logical.set(key, [...(logical.get(key) ?? []), entry]);
  }
  if (logical.size === 0) {
    context.diagnostics.unresolved += 1;
    return undefined;
  }
  if (logical.size > 1) {
    context.diagnostics.ambiguous += 1;
    return undefined;
  }
  const entries = Array.from(logical.values())[0] ?? [];
  const packageable = entries.filter((entry) => context.sources[entry.id]);
  if (packageable.length === 0) {
    context.diagnostics.unpackageable += 1;
    return undefined;
  }
  const requestKey = `invocation:${provider}:${token}`;
  return {
    key: reference.key,
    priority: reference.priority,
    requests: subjectRequests(requestKey, [provider]),
    promptSources: [],
    entryIdsByKey: {
      [requestKey]: packageable.map((entry) => entry.id).sort(),
    },
    dependsOn: [],
  };
}

// ---------------------------------------------------------------------------
// Repo-local commands and skills
// ---------------------------------------------------------------------------

const CLAUDE_REPO_SKILL = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/i;
const CLAUDE_REPO_COMMAND = /^\.claude\/commands\/(.+)\.md$/i;
const CODEX_REPO_SKILL = /^\.(?:codex|agents)\/skills\/([^/]+)\/SKILL\.md$/i;

function portableRepoRuntimeName(cwd: string): string {
  const sourceName = basename(cwd);
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
  return `${sanitized.slice(0, 246) || 'repo'}-${sha256Hex(sourceName).slice(0, 8)}`;
}

function snapshotPathSet(
  snapshot: SharedContainerSnapshotPathIndex | undefined,
): Array<{ repoPath: string; paths: ReadonlySet<string> }> {
  return (snapshot?.repositories ?? []).map((repository) => ({
    repoPath: repository.repoPath,
    paths: new Set(
      Array.from(repository.paths, (path) =>
        path.replace(/\\/g, '/').replace(/^\.\//, ''),
      ),
    ),
  }));
}

function inSnapshot(
  absolutePath: string,
  snapshot: ReadonlyArray<{ repoPath: string; paths: ReadonlySet<string> }>,
): boolean {
  for (const repository of snapshot) {
    const path = relative(repository.repoPath, absolutePath);
    if (!path || path.startsWith('..') || isAbsolute(path)) continue;
    if (repository.paths.has(path.split(sep).join('/'))) return true;
  }
  return false;
}

/**
 * Repo-local Claude commands and skills the snapshot does not carry, from
 * every repository of the worktree. Each keeps a repository-specific id, so
 * an invocation two repositories offer stays ambiguous for both this
 * composer and the analyzer instead of resolving to either. Commands and
 * skills the snapshot carries become dismissals: definitions may still name
 * them without the package copying them.
 */
async function buildRepoLocalResolution(
  input: AnalyzeSharedContainerCapabilityPackageInput,
  deps: SharedContainerCapabilityPackageAnalysisDependencies,
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics,
): Promise<RepoLocalResolution> {
  const snapshot = snapshotPathSet(input.snapshotPaths);
  const dismissals = new Map<string, { provider: Provider; token: string }>();
  for (const repository of snapshot) {
    for (const path of Array.from(repository.paths)) {
      const skill = CLAUDE_REPO_SKILL.exec(path)?.[1];
      const command = CLAUDE_REPO_COMMAND.exec(path)?.[1];
      const codexSkill = CODEX_REPO_SKILL.exec(path)?.[1];
      if (skill)
        dismissals.set(`claude\0/${skill}`, {
          provider: 'claude',
          token: `/${skill}`,
        });
      if (command) {
        const token = `/${command.split('/').join(':')}`;
        dismissals.set(`claude\0${token}`, { provider: 'claude', token });
      }
      if (codexSkill)
        dismissals.set(`codex\0$${codexSkill}`, {
          provider: 'codex',
          token: `$${codexSkill}`,
        });
    }
  }
  const entries: RepoLocalInvocableEntry[] = [];
  const sources: Record<string, PipelinePackageSourceDescriptor> = {};
  const scannedDirectories = new Set<string>();
  if (input.containerType === 'CODE_WORKTREE') {
    const repositories = [...(input.repositories ?? [])].sort((left, right) =>
      compareCodeUnits(left.repoId, right.repoId),
    );
    for (const repository of repositories) {
      input.signal?.throwIfAborted();
      const read = await readSource(diagnostics, input.signal, () =>
        deps.discoverRepoLocalInvocables(repository.repoPath, input.signal),
      );
      const discovered: DiscoveredRepoLocalInvocables = read?.value ?? {
        entries: [],
        scannedDirectories: [],
      };
      for (const directory of discovered.scannedDirectories)
        scannedDirectories.add(directory);
      const sourceLabel = basename(repository.repoPath);
      const rootName = portableRepoRuntimeName(repository.repoPath);
      for (const source of discovered.entries) {
        const carried = inSnapshot(
          source.kind === 'skill'
            ? join(source.absolutePath, 'SKILL.md')
            : source.absolutePath,
          snapshot,
        );
        if (carried) continue;
        const kind =
          source.kind === 'command'
            ? ('plugin_command' as const)
            : ('standalone_skill' as const);
        const invocationKey = `/${source.name}`;
        const entry: RepoLocalInvocableEntry = {
          id: `repo:${sha256Hex(repository.repoId).slice(0, 16)}:claude:${kind}:${source.name}`,
          provider: 'claude',
          kind,
          invocationKey,
          displayName: invocationKey,
          sourceLabel,
        };
        const claudeDir = join(repository.repoPath, '.claude');
        const descriptor: PipelinePackageSourceDescriptor =
          source.kind === 'command'
            ? {
                sourceRoot: claudeDir,
                memberPath: relative(claudeDir, source.absolutePath),
                exportRoot: join(claudeDir, 'commands'),
                sourceVisibility: 'local',
                runtimeKind: 'plugin_fragment',
                rootName,
                syntheticManifestName: rootName,
              }
            : {
                sourceRoot: source.absolutePath,
                memberPath: '.',
                sourceVisibility: 'local',
                runtimeKind: 'standalone_skill',
                rootName: source.name,
              };
        entries.push(entry);
        sources[entry.id] = descriptor;
      }
    }
  }
  return {
    index: {
      entries: entries.sort((left, right) =>
        compareCodeUnits(left.id, right.id),
      ),
      scannedDirectories: Array.from(scannedDirectories).sort(),
    },
    sources,
    dismissals: Array.from(dismissals.entries())
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, dismissal]) => dismissal),
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function definitionUnit(
  context: ResolutionContext,
  result: SharedContainerDefinitionBuildResult,
  priority: SharedContainerCapabilityUsagePriority,
): PackageUnit | undefined {
  if (!result.resource) {
    context.diagnostics.definitionsOmitted += 1;
    return undefined;
  }
  const draft = result.resource;
  return {
    key: definitionUnitKey(draft.identity),
    priority,
    requests: [],
    promptSources: [],
    entryIdsByKey: draft.capabilityInventoryEntryIdsByKey,
    definition: draft,
    dependsOn: draft.dependsOnIdentities.map(definitionUnitKey),
  };
}

function repositoryForPath(
  context: ResolutionContext,
  filePath: string,
): string | undefined {
  return context.localRepositories.find((repository) => {
    const path = relative(repository.repoPath, filePath);
    return path.length > 0 && !path.startsWith('..') && !isAbsolute(path);
  })?.repoPath;
}

function pipelineName(rawYaml: string, fallback: string): string {
  try {
    const name = parsePipelineText(rawYaml).name;
    return typeof name === 'string' && name.trim().length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}

async function userPipelineUnit(
  context: ResolutionContext,
  pipelineId: string,
  priority: SharedContainerCapabilityUsagePriority,
): Promise<PackageUnit | undefined> {
  const stored = (
    await readSource(context.diagnostics, context.input.signal, () =>
      context.deps.readUserPipeline(pipelineId),
    )
  )?.value;
  if (!stored) {
    context.diagnostics.definitionsOmitted += 1;
    return undefined;
  }
  return definitionUnit(
    context,
    await buildPipelineDefinitionResource(
      {
        pipeline: {
          id: pipelineId,
          source: 'user',
          name: stored.name,
          ...(stored.description ? { description: stored.description } : {}),
        },
        rawYaml: stored.rawYaml,
        origin: 'current',
        ...(stored.filePath
          ? { pipelineFileDir: dirname(stored.filePath) }
          : {}),
      },
      context.deps.definitionBuilders,
    ),
    priority,
  );
}

async function pipelineUnit(
  context: ResolutionContext,
  reference: Extract<SharedContainerCapabilityReference, { kind: 'pipeline' }>,
): Promise<PackageUnit | undefined> {
  const snapshot = reference.historicalSnapshot;
  if (reference.historical) {
    // The definition is gone (or never existed: an inline run). What ran
    // travels as a user pipeline marked as a historical snapshot.
    if (
      !snapshot ||
      reference.sourceKind === 'curated' ||
      reference.sourceKind === 'shared'
    ) {
      context.diagnostics.definitionsOmitted += 1;
      return undefined;
    }
    const source = reference.sourceKind === 'file' ? 'project' : 'user';
    return definitionUnit(
      context,
      await buildPipelineDefinitionResource(
        {
          pipeline: {
            id: reference.pipelineId,
            source,
            name: pipelineName(snapshot.yaml, reference.pipelineId),
          },
          rawYaml: snapshot.yaml,
          origin: 'historical-snapshot',
        },
        context.deps.definitionBuilders,
      ),
      reference.priority,
    );
  }
  switch (reference.sourceKind) {
    case 'user':
      return userPipelineUnit(
        context,
        reference.pipelineId,
        reference.priority,
      );
    case 'file': {
      const filePath = reference.filePath;
      const rawYaml = filePath
        ? ((
            await readSource(context.diagnostics, context.input.signal, () =>
              context.deps.readPipelineFile(filePath),
            )
          )?.value ?? null)
        : null;
      if (!filePath || rawYaml === null) {
        context.diagnostics.definitionsOmitted += 1;
        return undefined;
      }
      const repoPath = repositoryForPath(context, filePath);
      return definitionUnit(
        context,
        await buildPipelineDefinitionResource(
          {
            pipeline: {
              id: reference.pipelineId,
              source: 'project',
              name: pipelineName(rawYaml, reference.pipelineId),
            },
            rawYaml,
            origin: 'current',
            pipelineFileDir: dirname(filePath),
            ...(repoPath ? { repoPath } : {}),
          },
          context.deps.definitionBuilders,
        ),
        reference.priority,
      );
    }
    case 'curated':
    case 'shared':
    case 'inline':
      // Curated and shared pipelines travel by portable reference.
      return undefined;
  }
}

async function agentUnit(
  context: ResolutionContext,
  agentId: string,
  priority: SharedContainerCapabilityUsagePriority,
): Promise<PackageUnit | undefined> {
  const agent = (
    await readSource(context.diagnostics, context.input.signal, () =>
      context.deps.getAgentModel(agentId, context.input.projectId),
    )
  )?.value;
  if (!agent) {
    context.diagnostics.definitionsOmitted += 1;
    return undefined;
  }
  return definitionUnit(
    context,
    await buildAgentDefinitionResource(
      { agent, origin: 'current' },
      context.deps.definitionBuilders,
    ),
    priority,
  );
}

async function automationUnit(
  context: ResolutionContext,
  reference: Extract<
    SharedContainerCapabilityReference,
    { kind: 'automation' }
  >,
): Promise<PackageUnit | undefined> {
  context.automations ??= context.deps.listAutomations();
  const automations = context.automations;
  const activity = (
    await readSource(
      context.diagnostics,
      context.input.signal,
      () => automations,
    )
  )?.value.find((candidate) => candidate.id === reference.automationId);
  if (!activity) {
    context.diagnostics.definitionsOmitted += 1;
    return undefined;
  }
  const action = activity.action;
  let pipelineYaml: string | undefined;
  let curatedPipelineKey: string | undefined;
  if (action.type === 'worktree_pipeline') {
    if (action.pipelineSource === 'user') {
      const pipelineId = action.pipelineId;
      pipelineYaml = (
        await readSource(context.diagnostics, context.input.signal, () =>
          context.deps.readUserPipeline(pipelineId),
        )
      )?.value?.rawYaml;
    } else if (action.pipelineSource === 'curated') {
      const pipelineId = action.pipelineId;
      curatedPipelineKey = (
        await readSource(context.diagnostics, context.input.signal, () =>
          context.deps.findCuratedPipelineKey(pipelineId),
        )
      )?.value;
    }
  }
  return definitionUnit(
    context,
    await buildAutomationDefinitionResource(
      {
        activity,
        containerType:
          context.input.containerType === 'CODE_WORKTREE' ? 'code' : 'cowork',
        ...(pipelineYaml !== undefined ? { pipelineYaml } : {}),
        ...(curatedPipelineKey ? { curatedPipelineKey } : {}),
        origin: 'current',
      },
      context.deps.definitionBuilders,
    ),
    reference.priority,
  );
}

/** A definition another definition needs that usage did not report. */
async function dependencyUnit(
  context: ResolutionContext,
  identity: string,
  priority: SharedContainerCapabilityUsagePriority,
): Promise<PackageUnit | undefined> {
  if (identity.startsWith('agent:'))
    return agentUnit(context, identity.slice('agent:'.length), priority);
  if (identity.startsWith('pipeline:user:'))
    return userPipelineUnit(
      context,
      identity.slice('pipeline:user:'.length),
      priority,
    );
  // Project pipelines and automations are never implicit.
  return undefined;
}

async function mcpRequirement(
  context: ResolutionContext,
  reference: Extract<
    SharedContainerCapabilityReference,
    { kind: 'mcp_server' }
  >,
): Promise<PipelinePackageEnvironmentRequirement | undefined> {
  const identity = reference.identity;
  // Plugin servers travel with their plugin; account connections and bare
  // tool namespaces have no portable identity.
  if (identity.kind !== 'standalone') {
    context.diagnostics.mcpRequirementsOmitted += 1;
    return undefined;
  }
  const read = await readSource(context.diagnostics, context.input.signal, () =>
    context.deps.mcpSelectionToEnvironmentRequirement({
      serverId: identity.serverId,
      configId: identity.configId,
    }),
  );
  if (!read) context.diagnostics.mcpRequirementsOmitted += 1;
  return read?.value;
}

// ---------------------------------------------------------------------------
// Analyzer input
// ---------------------------------------------------------------------------

/**
 * Definition requirements are informational and keyed by id. A model alias
 * is local to its definition, so two definitions that disagree about one id
 * each keep theirs under an id namespaced by their resource id instead of
 * the first silently winning.
 */
function mergeEnvironmentRequirements(
  shared: readonly PipelinePackageEnvironmentRequirement[],
  units: readonly PackageUnit[],
): PipelinePackageEnvironmentRequirement[] {
  const candidates: Array<{
    owner: string | undefined;
    requirement: PipelinePackageEnvironmentRequirement;
  }> = [
    ...shared.map((requirement) => ({ owner: undefined, requirement })),
    ...units
      .flatMap((unit) =>
        unit.definition
          ? unit.definition.environmentRequirements.map((requirement) => ({
              owner: unit.definition?.resourceId,
              requirement,
            }))
          : [],
      )
      .sort(
        (left, right) =>
          compareCodeUnits(left.owner ?? '', right.owner ?? '') ||
          compareCodeUnits(left.requirement.id, right.requirement.id),
      ),
  ];
  const byId = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    byId.set(candidate.requirement.id, [
      ...(byId.get(candidate.requirement.id) ?? []),
      candidate,
    ]);
  }
  const shape = (requirement: PipelinePackageEnvironmentRequirement): string =>
    stableStringify({ ...requirement, required: false, affectedSteps: [] });
  const merged = new Map<string, PipelinePackageEnvironmentRequirement>();
  for (const [id, group] of Array.from(byId.entries())) {
    const first = group[0]?.requirement;
    if (!first) continue;
    const firstShape = shape(first);
    if (
      group.every((candidate) => shape(candidate.requirement) === firstShape)
    ) {
      merged.set(id, {
        ...first,
        required: group.some((candidate) => candidate.requirement.required),
        affectedSteps: [],
      });
      continue;
    }
    for (const candidate of group) {
      const namespaced = candidate.owner ? `${id}:${candidate.owner}` : id;
      const existing = merged.get(namespaced);
      merged.set(namespaced, {
        ...candidate.requirement,
        id: namespaced,
        required:
          (existing?.required ?? false) || candidate.requirement.required,
        affectedSteps: [],
      });
    }
  }
  return Array.from(merged.values()).sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
}

interface AnalyzerContext {
  inventory: InvocableInventoryCache;
  sources: Record<string, PipelinePackageSourceDescriptor>;
  repoLocal: RepoLocalResolution;
  containerType: SharedContainerCapabilityPackageContainerType;
  mcpRequirements: PipelinePackageEnvironmentRequirement[];
}

function analyzerInput(
  context: AnalyzerContext,
  units: readonly PackageUnit[],
): AnalyzeCapabilityPackageInput {
  const sorted = [...units].sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  );
  const entryIdsByKey: Record<string, string[]> = {};
  for (const unit of sorted) {
    for (const [key, ids] of Object.entries(unit.entryIdsByKey)) {
      entryIdsByKey[key] = Array.from(
        new Set([...(entryIdsByKey[key] ?? []), ...ids]),
      ).sort();
    }
  }
  const requests = new Map<string, CapabilityPackageRequest>();
  for (const request of sorted.flatMap((unit) => unit.requests))
    requests.set(`${request.provider}\0${request.key}`, request);
  const promptSources = new Map<string, CapabilityPackagePromptSource>();
  for (const source of sorted.flatMap((unit) => unit.promptSources))
    promptSources.set(`${source.provider}\0${source.text}`, source);
  return {
    rawContent: stableStringify({
      kind: 'shared-container-capability-package',
      version: SHARED_CONTAINER_CAPABILITY_PACKAGE_ANALYSIS_VERSION,
      containerType: context.containerType,
    }),
    invocableInventory: context.inventory,
    capabilityInventoryEntryIdsByKey: entryIdsByKey,
    sourceByInventoryEntryId: context.sources,
    repoLocalInvocables: context.repoLocal.index,
    sourceByRepoLocalEntryId: context.repoLocal.sources,
    dismissedInvocations: context.repoLocal.dismissals,
    requests: Array.from(requests.entries())
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, request]) => request),
    promptSources: Array.from(promptSources.entries())
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, source]) => source),
    environmentRequirements: mergeEnvironmentRequirements(
      context.mcpRequirements,
      sorted,
    ),
    definitionResources: sorted
      .flatMap((unit) => (unit.definition ? [unit.definition] : []))
      .sort((left, right) =>
        compareCodeUnits(left.resourceId, right.resourceId),
      )
      .map((definition) =>
        toCapabilityPackageDefinitionResourceInput(definition),
      ),
  };
}

/** Everything that determines the analysis except member file bytes. */
function computeContentKey(
  usage: SharedContainerCapabilityUsage,
  context: AnalyzerContext,
  units: readonly PackageUnit[],
): string {
  const input = analyzerInput(context, units);
  return `scp:v${String(SHARED_CONTAINER_CAPABILITY_PACKAGE_ANALYSIS_VERSION)}:${sha256Hex(
    stableStringify({
      sourceVersion: usage.sourceVersion,
      units: [...units]
        .sort((left, right) => compareCodeUnits(left.key, right.key))
        .map((unit) => ({
          key: unit.key,
          priority: unit.priority,
          dependsOn: unit.dependsOn,
        })),
      inventory: context.inventory.entries.map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        kind: entry.kind,
        name: entry.name,
        invocationKey: entry.invocationKey,
        enableRef: entry.enableRef,
      })),
      input: {
        ...input,
        invocableInventory: undefined,
        definitionResources: (input.definitionResources ?? []).map(
          (definition) => ({
            ...definition,
            document: sha256Hex(definition.document),
          }),
        ),
      },
    }),
  )}`;
}

// ---------------------------------------------------------------------------
// Closure, attribution and pruning
// ---------------------------------------------------------------------------

/** Removes `removed` and, transitively, every unit that needs one of them. */
function withoutDependents(
  units: readonly PackageUnit[],
  removed: ReadonlySet<string>,
): { kept: PackageUnit[]; dependents: number } {
  const gone = new Set(removed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      if (gone.has(unit.key)) continue;
      if (unit.dependsOn.some((key) => gone.has(key))) {
        gone.add(unit.key);
        changed = true;
      }
    }
  }
  const kept = units.filter((unit) => !gone.has(unit.key));
  const dependents = units.length - kept.length - removed.size;
  return { kept, dependents: Math.max(0, dependents) };
}

/** Units that name a definition no unit provides, and their dependents. */
function withResolvedDependencies(units: readonly PackageUnit[]): {
  kept: PackageUnit[];
  dependents: number;
} {
  const present = new Set(units.map((unit) => unit.key));
  const missing = new Set(
    units
      .filter((unit) => unit.dependsOn.some((key) => !present.has(key)))
      .map((unit) => unit.key),
  );
  const result = withoutDependents(units, missing);
  return { kept: result.kept, dependents: result.dependents + missing.size };
}

function closureOf(
  unit: PackageUnit,
  byKey: ReadonlyMap<string, PackageUnit>,
): PackageUnit[] {
  const seen = new Map<string, PackageUnit>();
  const pending = [unit];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current.key)) continue;
    seen.set(current.key, current);
    for (const key of current.dependsOn) {
      const dependency = byKey.get(key);
      if (dependency) pending.push(dependency);
    }
  }
  return Array.from(seen.values());
}

function manifestSize(manifest: PipelinePackageManifestV1 | undefined): {
  files: number;
  bytes: number;
} {
  return manifest
    ? { files: manifest.totalFiles, bytes: manifest.totalBytes }
    : { files: 0, bytes: 0 };
}

function analysisIsValid(analysis: CapabilityPackageAnalysisInternal): boolean {
  const manifest = analysis.summary.manifest;
  return (
    analysis.summary.state === 'ready' &&
    analysis.summary.blockers.length === 0 &&
    manifest !== undefined &&
    validatePipelinePackageManifest(manifest).ok
  );
}

interface ObservedSources {
  sourceStats: CapabilityPackageAnalysisInternal['sourceStats'];
  sourceDirectories: CapabilityPackageAnalysisInternal['sourceDirectories'];
}

function recordSources(
  observed: ObservedSources,
  analysis: CapabilityPackageAnalysisInternal,
): void {
  observed.sourceStats.push(...analysis.sourceStats);
  observed.sourceDirectories.push(...analysis.sourceDirectories);
}

function dedupeSources(observed: ObservedSources): ObservedSources {
  const stats = new Map<string, ObservedSources['sourceStats'][number]>();
  for (const stat of observed.sourceStats) stats.set(stat.path, stat);
  const directories = new Map<
    string,
    ObservedSources['sourceDirectories'][number]
  >();
  for (const directory of observed.sourceDirectories)
    directories.set(directory.path, directory);
  return {
    sourceStats: Array.from(stats.values()).sort((left, right) =>
      compareCodeUnits(left.path, right.path),
    ),
    sourceDirectories: Array.from(directories.values()).sort((left, right) =>
      compareCodeUnits(left.path, right.path),
    ),
  };
}

/**
 * Prune order: fallback-only units before any directly observed unit, then
 * the largest first (by bytes, then files), then key order. A removed unit
 * takes every definition that needs it along.
 */
function pruneOrder(
  units: readonly PackageUnit[],
  sizes: ReadonlyMap<string, { files: number; bytes: number }>,
): PackageUnit[] {
  return [...units].sort((left, right) => {
    const priority =
      Number(left.priority === 'observed') -
      Number(right.priority === 'observed');
    if (priority !== 0) return priority;
    const leftSize = sizes.get(left.key) ?? { files: 0, bytes: 0 };
    const rightSize = sizes.get(right.key) ?? { files: 0, bytes: 0 };
    if (leftSize.bytes !== rightSize.bytes)
      return rightSize.bytes - leftSize.bytes;
    if (leftSize.files !== rightSize.files)
      return rightSize.files - leftSize.files;
    return compareCodeUnits(left.key, right.key);
  });
}

function estimatedSize(
  units: readonly PackageUnit[],
  sizes: ReadonlyMap<string, { files: number; bytes: number }>,
): { files: number; bytes: number } {
  return units.reduce(
    (total, unit) => {
      const size = sizes.get(unit.key) ?? { files: 0, bytes: 0 };
      return {
        files: total.files + size.files,
        bytes: total.bytes + size.bytes,
      };
    },
    { files: 0, bytes: 0 },
  );
}

async function analyzeWithPruning(
  context: AnalyzerContext,
  units: readonly PackageUnit[],
  deps: SharedContainerCapabilityPackageAnalysisDependencies,
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics,
  observed: ObservedSources,
  signal: AbortSignal | undefined,
): Promise<
  | { state: 'ready'; analysis: CapabilityPackageAnalysisInternal }
  | { state: 'empty' }
  | { state: 'failed'; reason: string }
> {
  const run = async (
    selected: readonly PackageUnit[],
  ): Promise<CapabilityPackageAnalysisInternal> => {
    signal?.throwIfAborted();
    attempts += 1;
    diagnostics.analyses += 1;
    const analysis = await deps.analyze(analyzerInput(context, selected));
    recordSources(observed, analysis);
    signal?.throwIfAborted();
    return analysis;
  };
  // Every analyzer run counts, so a container with many units cannot
  // multiply full analyses (each up to the package byte cap).
  let attempts = 0;
  const exhausted = {
    state: 'failed',
    reason: 'prune_budget_exhausted',
  } as const;
  if (units.length === 0) return { state: 'empty' };
  const combined = await run(units);
  if (analysisIsValid(combined)) return { state: 'ready', analysis: combined };

  // Blockers name no unit. Analyze each unit with the definitions it needs to
  // find the ones that cannot travel at all, and size the rest for pruning.
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const blocked = new Set<string>();
  const sizes = new Map<string, { files: number; bytes: number }>();
  for (const unit of [...units].sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  )) {
    signal?.throwIfAborted();
    if (attempts >= MAX_PRUNE_ANALYSES) return exhausted;
    const isolated = await run(closureOf(unit, byKey));
    if (isolated.summary.blockers.length > 0 || !analysisIsValid(isolated))
      blocked.add(unit.key);
    else sizes.set(unit.key, manifestSize(isolated.summary.manifest));
  }
  const unblocked = withoutDependents(units, blocked);
  diagnostics.blockedOmitted += blocked.size;
  diagnostics.dependentsOmitted += unblocked.dependents;
  let remaining = unblocked.kept;

  // What is left fails only together: an aggregate cap. Drop units in prune
  // order until the estimate fits, then verify, then continue one at a time.
  const pruneOne = (): boolean => {
    const victim = pruneOrder(remaining, sizes)[0];
    if (!victim) return false;
    const next = withoutDependents(remaining, new Set([victim.key]));
    diagnostics.prunedForCaps += 1;
    diagnostics.dependentsOmitted += next.dependents;
    remaining = next.kept;
    return true;
  };
  for (;;) {
    const estimate = estimatedSize(remaining, sizes);
    if (
      estimate.files <= PIPELINE_PACKAGE_MAX_FILES &&
      estimate.bytes <= PIPELINE_PACKAGE_MAX_TOTAL_BYTES
    )
      break;
    if (!pruneOne()) break;
  }
  // `remaining` only shrinks, so its length identifies what was analyzed.
  let analyzedCount = units.length;
  let current = combined;
  while (remaining.length > 0) {
    if (remaining.length !== analyzedCount) {
      if (attempts >= MAX_PRUNE_ANALYSES) return exhausted;
      current = await run(remaining);
      analyzedCount = remaining.length;
    }
    if (analysisIsValid(current)) return { state: 'ready', analysis: current };
    if (!pruneOne()) break;
  }
  return { state: 'empty' };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function resolveUnits(
  context: ResolutionContext,
  usage: SharedContainerCapabilityUsage,
): Promise<{
  units: PackageUnit[];
  mcpRequirements: PipelinePackageEnvironmentRequirement[];
}> {
  const units = new Map<string, PackageUnit>();
  const mcpRequirements: PipelinePackageEnvironmentRequirement[] = [];
  const add = (unit: PackageUnit | undefined): void => {
    if (!unit) return;
    const existing = units.get(unit.key);
    units.set(
      unit.key,
      existing
        ? {
            ...existing,
            priority: strongerPriority(existing.priority, unit.priority),
          }
        : unit,
    );
  };
  for (const reference of usage.references) {
    context.input.signal?.throwIfAborted();
    switch (reference.kind) {
      case 'skill': {
        const { sourceId, skillName } = reference;
        add(
          selectionUnit(
            context,
            reference,
            `skill:${sourceId}:${skillName}`,
            (entry) =>
              entry.enableRef.kind === 'skill' &&
              entry.enableRef.sourceId === sourceId &&
              entry.enableRef.skillName === skillName,
          ),
        );
        break;
      }
      case 'plugin': {
        const { marketplaceId, pluginName } = reference;
        add(
          selectionUnit(
            context,
            reference,
            `plugin:${marketplaceId}:${pluginName}`,
            (entry) =>
              entry.enableRef.kind === 'plugin' &&
              entry.enableRef.marketplaceId === marketplaceId &&
              entry.enableRef.pluginName === pluginName,
          ),
        );
        break;
      }
      case 'invocation':
        add(invocationUnit(context, reference));
        break;
      case 'mcp_server': {
        const requirement = await mcpRequirement(context, reference);
        if (requirement) mcpRequirements.push(requirement);
        break;
      }
      case 'agent':
        add(await agentUnit(context, reference.agentId, reference.priority));
        break;
      case 'pipeline':
        add(await pipelineUnit(context, reference));
        break;
      case 'automation':
        add(await automationUnit(context, reference));
        break;
      case 'hook':
        // No installer can guarantee a hook starts paused in every future
        // worktree, so hooks never travel; their commands stay private.
        context.diagnostics.hooksSkipped += 1;
        break;
    }
  }
  // Definitions an automation or pipeline needs travel with it even
  // when usage never reported them, at the priority of what needs them.
  const attempted = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const unit of Array.from(units.values()).sort((left, right) =>
      compareCodeUnits(left.key, right.key),
    )) {
      for (const dependency of unit.dependsOn) {
        const existing = units.get(dependency);
        if (existing) {
          const priority = strongerPriority(existing.priority, unit.priority);
          if (priority !== existing.priority) {
            units.set(dependency, { ...existing, priority });
            changed = true;
          }
          continue;
        }
        if (attempted.has(dependency) || units.size >= MAX_DEFINITIONS)
          continue;
        attempted.add(dependency);
        context.input.signal?.throwIfAborted();
        const built = await dependencyUnit(
          context,
          dependency.slice('definition:'.length),
          unit.priority,
        );
        if (built && built.key === dependency) {
          units.set(built.key, built);
          changed = true;
        }
      }
    }
  }
  return {
    units: Array.from(units.values()).sort((left, right) =>
      compareCodeUnits(left.key, right.key),
    ),
    mcpRequirements,
  };
}

function observedSourcesStale(
  observed: Pick<
    CapabilityPackageAnalysisInternal,
    'sourceStats' | 'sourceDirectories'
  >,
  isStale: (analysis: CapabilityPackageAnalysisInternal) => Promise<boolean>,
): Promise<boolean> {
  return isStale({
    summary: {
      analysisId: 'shared-container-staleness',
      state: 'ready',
      pipelineContentHash: '',
      blockers: [],
      expiresAt: new Date(0).toISOString(),
    },
    optionalBindings: [],
    blobs: new Map(),
    sourceStats: observed.sourceStats,
    sourceDirectories: observed.sourceDirectories,
  });
}

export interface AnalyzeSharedContainerCapabilityPackageOptions {
  /**
   * The last completed analysis for this container. Reused without running
   * the analyzer when its content key matches and none of its sources
   * changed.
   */
  previous?: CompletedSharedContainerCapabilityPackageAnalysis;
  isStale?: (analysis: CapabilityPackageAnalysisInternal) => Promise<boolean>;
}

/**
 * Analyzes the capability package of one shared container revision.
 *
 * Returns `ready` with the finalized summary and its upload source, `empty`
 * when no valid resource remains, or `failed` when the analysis itself could
 * not complete. Throws the signal's reason when aborted.
 */
export async function analyzeSharedContainerCapabilityPackage(
  input: AnalyzeSharedContainerCapabilityPackageInput,
  deps: SharedContainerCapabilityPackageAnalysisDependencies = DEFAULT_DEPENDENCIES,
  options: AnalyzeSharedContainerCapabilityPackageOptions = {},
): Promise<SharedContainerCapabilityPackageAnalysis> {
  const { signal } = input;
  signal?.throwIfAborted();
  const diagnostics = emptyDiagnostics();
  try {
    const usage = await deps.collectUsage({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      containerType: input.containerType,
      includedChatIds: input.includedChatIds,
      ...(input.containerType === 'CODE_WORKTREE' && input.snapshotPaths
        ? { snapshotPaths: input.snapshotPaths }
        : {}),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    diagnostics.references = usage.references.length;
    // Usage that missed a source could omit capabilities that were used; a
    // package built from it would replace the published one with less.
    if (usage.incomplete) return failedForUnreadableSources(diagnostics);
    const { inventory, sources } = await deps.loadInventory();
    signal?.throwIfAborted();
    const repoLocal = await buildRepoLocalResolution(input, deps, diagnostics);
    const context: ResolutionContext = {
      input,
      deps,
      inventory,
      sources,
      repoLocal,
      diagnostics,
      localRepositories:
        input.containerType === 'CODE_WORKTREE'
          ? (input.repositories ?? [])
          : [],
    };
    const resolved = await resolveUnits(context, usage);
    signal?.throwIfAborted();
    if (diagnostics.sourcesUnreadable > 0)
      return failedForUnreadableSources(diagnostics);
    const closed = withResolvedDependencies(resolved.units);
    diagnostics.dependentsOmitted += closed.dependents;
    const analyzerContext: AnalyzerContext = {
      inventory,
      sources,
      repoLocal,
      containerType: input.containerType,
      mcpRequirements: resolved.mcpRequirements,
    };
    const contentKey = computeContentKey(usage, analyzerContext, closed.kept);
    const isStale = options.isStale ?? pipelinePackageAnalysisIsStale;
    const previous = options.previous;
    if (
      previous?.contentKey === contentKey &&
      !(await observedSourcesStale(previous.observedSources, isStale))
    ) {
      signal?.throwIfAborted();
      return {
        ...previous,
        diagnostics: { ...previous.diagnostics, reused: true },
      };
    }
    const observed: ObservedSources = {
      sourceStats: [],
      sourceDirectories: [],
    };
    const outcome = await analyzeWithPruning(
      analyzerContext,
      closed.kept,
      deps,
      diagnostics,
      observed,
      signal,
    );
    logOmissions(diagnostics);
    if (outcome.state === 'failed') return outcome;
    const observedSources = dedupeSources(observed);
    const manifest =
      outcome.state === 'ready' ? outcome.analysis.summary.manifest : undefined;
    if (
      outcome.state === 'empty' ||
      !manifest ||
      manifest.resources.length === 0
    ) {
      return { state: 'empty', contentKey, observedSources, diagnostics };
    }
    // Revalidate the complete final manifest before anything reads it.
    if (!validatePipelinePackageManifest(manifest).ok)
      return { state: 'failed', reason: 'invalid_manifest' };
    const digest = computePipelinePackageDigestSync(manifest);
    return {
      state: 'ready',
      contentKey,
      summary: summarizeSharedContainerCapabilityPackage(digest, manifest),
      manifest,
      analysis: outcome.analysis,
      observedSources,
      diagnostics,
    };
  } catch (error) {
    signal?.throwIfAborted();
    logMainProcessWarn(
      '[shared-containers] capability package analysis failed',
      { error: error instanceof Error ? error.name : typeof error },
    );
    return { state: 'failed', reason: 'analysis_error' };
  }
}

function failedForUnreadableSources(
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics,
): SharedContainerCapabilityPackageAnalysis {
  // Counts only, like every other analysis diagnostic.
  logMainProcessWarn(
    '[shared-containers] capability package analysis skipped unreadable sources',
    { sourcesUnreadable: diagnostics.sourcesUnreadable },
  );
  return { state: 'failed', reason: 'sources_unreadable' };
}

function logOmissions(
  diagnostics: SharedContainerCapabilityPackageAnalysisDiagnostics,
): void {
  const omitted =
    diagnostics.unresolved +
    diagnostics.ambiguous +
    diagnostics.unpackageable +
    diagnostics.definitionsOmitted +
    diagnostics.dependentsOmitted +
    diagnostics.blockedOmitted +
    diagnostics.prunedForCaps;
  if (omitted === 0) return;
  // Counts only: names, paths and definition content stay private.
  logMainProcessWarn(
    '[shared-containers] capability package omitted resources',
    {
      unresolved: diagnostics.unresolved,
      ambiguous: diagnostics.ambiguous,
      unpackageable: diagnostics.unpackageable,
      definitionsOmitted: diagnostics.definitionsOmitted,
      dependentsOmitted: diagnostics.dependentsOmitted,
      blockedOmitted: diagnostics.blockedOmitted,
      prunedForCaps: diagnostics.prunedForCaps,
    },
  );
}
