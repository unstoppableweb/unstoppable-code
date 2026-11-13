/**
 * Discovers the capabilities a shared worktree or Cowork revision used, so
 * the publisher can build that revision's capability package (CAN-4655).
 *
 * The collector reads only the container's own included chats, pipeline
 * runs, automations and hook runs. It returns normalized references with
 * provenance and priority; resolving them against the local inventory,
 * building portable definitions and enforcing caps belong to the package
 * analyzer.
 *
 * Transcript parsing is the only expensive step, so its normalized result is
 * cached per chat beside the share publication state, keyed by the
 * transcript's content identity and the parser version. Every other source
 * (selections, definitions, executions, automations, hooks) is cheap and is
 * read again on each call, so editing a capability without a new chat message
 * still changes {@link SharedContainerCapabilityUsage.sourceVersion}.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { dump } from 'js-yaml';
import { BRAND } from '@canopy/brand/current';
import {
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import { CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME } from '@canopy/protocol/capability-bundle';
import {
  readMcpActivationRecord,
  type McpCapabilityIdentity,
} from '@canopy/protocol/mcp-servers';
import type { AgentDelegationStatus } from '@canopy/protocol/delegation';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type {
  ExecutionState,
  ExecutionSummary,
  PipelineData,
} from '@canopy/execution-engine/types/pipeline';
import type {
  AutomationAction,
  AutomationRunHistoryRequest,
  AutomationRunHistoryResponse,
  ChatTabPluginSelections,
  ChatTabsFile,
  HookRunSnapshot,
  HookSourceInfoRequest,
  HookSourceInfoResponse,
  PersistedChatMessage,
  PersistedChatTab,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { readStoredPipelinePresence } from '@canopy/execution-engine/pipelines/store';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import {
  getDataDir,
  getWorktreeShareCapabilityUsageCachePath,
} from '../../lib/paths';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { isErrnoException, isRecord } from '../../lib/type-guards';
import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import { mapWithConcurrency } from '../../lib/concurrency';
import { isBuiltinSourceId } from '../../skills/paths';
import {
  leadingSkillInvocation,
  toolShapeEntry,
} from '../../skill-suggestions/normalize';

/** Bump whenever transcript recognition changes; old cache entries then miss. */
export const SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION = 1;
const CACHE_FILE_VERSION = 1;

const MAX_TRANSCRIPT_REFERENCES_PER_CHAT = 2_000;
const MAX_PIPELINES = 500;
const MAX_HISTORICAL_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_PIPELINE_FILE_BYTES = 1024 * 1024;
const MAX_AUTOMATION_RUN_PAGES = 5;
const AUTOMATION_RUN_PAGE_SIZE = 200;
const SOURCE_READ_CONCURRENCY = 4;
const ABORT_CHECK_INTERVAL = 64;
const MAX_DELEGATION_DEPTH = 64;
const MAX_TOOL_INPUT_CHARS = 4_000;

const TERMINAL_DELEGATION_STATUSES: ReadonlySet<AgentDelegationStatus> =
  new Set<AgentDelegationStatus>([
    'completed',
    'failed',
    'cancelled',
    'deadline_exceeded',
  ]);

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type SharedContainerCapabilityUsageSource =
  | 'transcript'
  | 'mcp_activation'
  | 'selection_fallback'
  | 'agent_route'
  | 'pipeline_execution'
  | 'automation'
  | 'hook_run';

/** Directly observed usage always outranks selection fallback. */
export type SharedContainerCapabilityUsagePriority = 'observed' | 'fallback';

export type SharedContainerCapabilityInvocationProvider = 'claude' | 'codex';

/**
 * How an invocation token was observed: a leading `/name` or `$name` prompt,
 * a `Skill` tool call, or a namespaced Claude subagent dispatch.
 */
export type SharedContainerCapabilityInvocationVia =
  | 'leading'
  | 'skill_tool'
  | 'subagent';

/**
 * An MCP server identity. Never carries configuration, URLs or credentials.
 * `tool_namespace` is the server segment of an `mcp__<server>__<tool>` call,
 * left for the analyzer to resolve against the local inventory.
 */
export type SharedContainerMcpServerIdentity =
  | McpCapabilityIdentity
  | { kind: 'tool_namespace'; namespace: string };

/**
 * Where a used pipeline's definition comes from. Bundled pipelines ship with
 * the app and are never reported.
 */
export type SharedContainerPipelineSourceKind =
  | 'user'
  | 'curated'
  | 'file'
  | 'shared'
  | 'inline';

/** A run's own pipeline snapshot, used when no current source exists. */
export interface SharedContainerHistoricalPipelineSnapshot {
  /** YAML of the execution's `NormalizedPipeline` snapshot, keys sorted. */
  format: 'normalized_pipeline_yaml';
  yaml: string;
  executionId: string;
  capturedAt: string;
}

/** Repository-relative paths present in one repository of the snapshot. */
export interface SharedContainerSnapshotRepositoryPaths {
  repoId: string;
  /** Local checkout root; used only to map local file locators. */
  repoPath: string;
  /** POSIX paths relative to `repoPath` that this revision carries. */
  paths: Iterable<string>;
}

export interface SharedContainerSnapshotPathIndex {
  repositories: readonly SharedContainerSnapshotRepositoryPaths[];
}

export type SharedContainerCapabilityReferenceTarget =
  | { kind: 'skill'; sourceId: string; skillName: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string }
  | {
      kind: 'invocation';
      /** Lowercased name without its `/` or `$` sigil, e.g. `review` or `plugin:skill`. */
      token: string;
      provider: SharedContainerCapabilityInvocationProvider;
      via: readonly SharedContainerCapabilityInvocationVia[];
    }
  | { kind: 'mcp_server'; identity: SharedContainerMcpServerIdentity }
  | {
      kind: 'agent';
      /** Local Agent model id (`agent_model_*`). */
      agentId: string;
      /** Content identity of the current local definition. */
      definitionVersion: string;
    }
  | {
      kind: 'pipeline';
      pipelineId: string;
      sourceKind: SharedContainerPipelineSourceKind;
      /** Local absolute path of a `file` pipeline. Never exported. */
      filePath?: string;
      /** Content identity of the current definition, when one exists. */
      definitionVersion?: string;
      /** The source definition is gone (or never existed: inline runs). */
      historical?: true;
      historicalSnapshot?: SharedContainerHistoricalPipelineSnapshot;
    }
  | {
      kind: 'automation';
      automationId: string;
      definitionVersion: string;
    }
  | {
      kind: 'hook';
      /** Hooks-service key: `project:<trigger>`, `workspace-root:<trigger>` or `workspace-repo:<repoId>:<trigger>`. */
      hookKey: string;
      scope: 'project' | 'workspace-root' | 'workspace-repo';
      triggerName: string;
      repoId?: string;
      repoName?: string;
      definitionVersion: string;
    };

export type SharedContainerCapabilityReference =
  SharedContainerCapabilityReferenceTarget & {
    /** Stable identity of the referenced capability within this result. */
    key: string;
    /** Sources that reported it, in a fixed order. */
    provenance: readonly SharedContainerCapabilityUsageSource[];
    priority: SharedContainerCapabilityUsagePriority;
  };

/** Counts only; never names, paths or private content. */
export interface SharedContainerCapabilityUsageDiagnostics {
  chatsRequested: number;
  chatsRead: number;
  chatsFromCache: number;
  chatsMissing: number;
  chatsUnreadable: number;
  duplicateChatIds: number;
  duplicateVisitsSkipped: number;
  delegationRunsVisited: number;
  delegationCyclesSkipped: number;
  transcriptReferencesTruncated: number;
  excludedBuiltin: number;
  excludedCanopyMcp: number;
  excludedRepoLocal: number;
  excludedCarriedHooks: number;
  agentsUnavailable: number;
  agentsUnreadable: number;
  pipelineExecutionsMissing: number;
  pipelineExecutionsUnreadable: number;
  pipelineDefinitionsUnreadable: number;
  pipelineChildExecutionsSkipped: number;
  pipelinesHistorical: number;
  pipelinesTruncated: number;
  pipelineSnapshotsUnavailable: number;
  automationsUnreadable: number;
  automationSystemSkipped: number;
  automationRunHistoryTruncated: number;
  hooksUnavailable: number;
  cacheDiscarded: number;
  cacheWriteFailed: number;
}

export interface SharedContainerCapabilityUsage {
  containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
  /** Sorted by `key`. */
  references: readonly SharedContainerCapabilityReference[];
  /**
   * True when a source that exists could not be read (counted in the
   * `*Unreadable` diagnostics). `references` may then miss capabilities that
   * were used, so it must not be treated as the complete usage: a package
   * built from it could silently drop them. Absent sources (deleted chats,
   * Agents, executions or pipelines) never set it.
   */
  incomplete: boolean;
  /**
   * Digest of everything that determines `references`: parser version,
   * container type and every normalized reference including its provenance,
   * priority and definition identity. Skill and plugin content is resolved
   * later by the analyzer and is not part of it.
   */
  sourceVersion: string;
  diagnostics: SharedContainerCapabilityUsageDiagnostics;
}

export interface CollectSharedContainerCapabilityUsageInput {
  projectId: string;
  worktreeId: string;
  containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
  includedChatIds: readonly string[];
  /** Repository-relative paths actually present in this revision's snapshot, per repository; used for snapshot-aware exclusions. Absent for Cowork. */
  snapshotPaths?: SharedContainerSnapshotPathIndex;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Service boundaries
// ---------------------------------------------------------------------------

export interface SharedContainerTranscriptScope {
  projectId: string;
  worktreeId: string;
}

export interface SharedContainerCapabilityUsageDependencies {
  readChatTabs: (
    projectId: string,
    worktreeId: string,
  ) => Promise<ChatTabsFile>;
  /** Streams one chat's transcript with delegation children inlined. */
  consumeTranscript: <T>(
    scope: SharedContainerTranscriptScope,
    chatId: string,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
  ) => Promise<T>;
  resolveBackgroundSelections: (
    local: ChatTabPluginSelections | undefined,
    target: { projectId: string; worktreeId: string; chatId: string },
  ) => Promise<ChatTabPluginSelections | undefined>;
  /**
   * Null only when the Agent is gone or unavailable here; rejects when it
   * could not be read. The same contract holds for every reader below:
   * null (or a missing entry) means absent, a rejection means unreadable.
   */
  getAgentModel: (
    agentId: string,
    projectId: string,
  ) => Promise<AgentModelDefinition | null>;
  listExecutionSummaries: () => Promise<ExecutionSummary[]>;
  /** Null when the execution state no longer exists. */
  loadExecutionState: (executionId: string) => Promise<ExecutionState | null>;
  /** Raw YAML of a stored user pipeline, or null when it is gone. */
  readUserPipeline: (pipelineId: string) => Promise<string | null>;
  /** Raw YAML of a file pipeline, or null when it is gone or too large. */
  readPipelineFile: (filePath: string) => Promise<string | null>;
  listAutomations: () => Promise<ScheduledActivity[]>;
  listAutomationRuns: (
    request: AutomationRunHistoryRequest,
  ) => Promise<AutomationRunHistoryResponse>;
  loadHookRuns: (
    projectId: string,
    worktreeId: string,
  ) => Promise<HookRunSnapshot[]>;
  getHookSourceInfo: (
    request: HookSourceInfoRequest,
  ) => Promise<HookSourceInfoResponse>;
  listBuiltinSkillNames: () => Promise<readonly string[]>;
  resolveCoworkProjectId: (projectId: string) => string;
}

/** The agent store's refusal for an Agent this context may not use. */
const AGENT_UNAVAILABLE_MESSAGE = /^Agent unavailable \(/;

/**
 * A stored Agent, or null when it is gone or unavailable in this project.
 * Any other failure rejects: it is unreadable, not absent.
 */
export async function readSharedContainerAgentModel(
  agentId: string,
  projectId: string,
): Promise<AgentModelDefinition | null> {
  const { getAgentModel } = await import('../../agents/agent-model-store');
  try {
    return await getAgentModel(agentId, projectId);
  } catch (error) {
    if (error instanceof Error && AGENT_UNAVAILABLE_MESSAGE.test(error.message))
      return null;
    throw error;
  }
}

class SharedContainerSourceUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedContainerSourceUnreadableError';
  }
}

/**
 * Whether the user pipeline `pipelineId` is genuinely gone: no index, no
 * index entry, or no file. Rejects when the index or file exists but cannot
 * be read.
 */
function userPipelineIsAbsent(pipelineId: string): boolean {
  const presence = readStoredPipelinePresence(pipelineId);
  if (presence === 'unreadable')
    throw new SharedContainerSourceUnreadableError(
      'The user pipeline index is unreadable',
    );
  return presence === 'absent';
}

/**
 * A stored user pipeline, or null only when it is genuinely gone. The store
 * reports every failure as "not found" (and may then prune the index entry),
 * so absence is established from the index and file first: a pipeline that
 * exists but cannot be read or parsed rejects instead of passing for a
 * deleted one.
 */
export async function readSharedContainerUserPipeline(
  pipelineId: string,
): Promise<PipelineData | null> {
  if (userPipelineIsAbsent(pipelineId)) return null;
  const { getStoredPipelineBySource } =
    await import('../../pipelines/pipeline-service');
  const stored = getStoredPipelineBySource('user', pipelineId);
  if (stored.success && stored.data) return stored.data;
  throw new SharedContainerSourceUnreadableError(
    'A stored user pipeline is unreadable',
  );
}

async function readPipelineFileBounded(
  filePath: string,
): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    return Buffer.byteLength(content) > MAX_PIPELINE_FILE_BYTES
      ? null
      : content;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listBuiltinSkillNames(): Promise<readonly string[]> {
  const { getBundledSkillsDir } =
    await import('@canopy/execution-engine/pipelines/config-paths');
  try {
    const entries = await readdir(getBundledSkillsDir(), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const DEFAULT_DEPENDENCIES: SharedContainerCapabilityUsageDependencies = {
  readChatTabs: async (projectId, worktreeId) => {
    const { readChatTabsFileForIndex } =
      await import('../../lib/chat-tabs-reader');
    return readChatTabsFileForIndex(projectId, worktreeId);
  },
  consumeTranscript: async <T>(
    scope: SharedContainerTranscriptScope,
    chatId: string,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
  ): Promise<T> => {
    // Deferred like publication inventory: the state service is heavy.
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().consumeTranscript(
      scope,
      chatId,
      false,
      consume,
      { inlineDelegationChildren: true },
    );
  },
  resolveBackgroundSelections: async (local, target) => {
    const { resolveBackgroundChatPluginSelections } =
      await import('../../plugins/global-plugin-overlay');
    return resolveBackgroundChatPluginSelections(local, target);
  },
  getAgentModel: readSharedContainerAgentModel,
  listExecutionSummaries: async () => {
    const { listExecutionSummaries } =
      await import('@canopy/execution-engine/node/pipelines/executor/execution-state');
    return listExecutionSummaries(join(getDataDir(), 'pipeline-executions'));
  },
  loadExecutionState: async (executionId) => {
    const { loadExecutionState } =
      await import('@canopy/execution-engine/node/pipelines/executor/execution-state');
    return loadExecutionState(
      executionId,
      join(getDataDir(), 'pipeline-executions'),
    );
  },
  readUserPipeline: async (pipelineId) => {
    const stored = await readSharedContainerUserPipeline(pipelineId);
    if (!stored) return null;
    return stored.rawContent ?? stableStringify(stored.content);
  },
  readPipelineFile: readPipelineFileBounded,
  listAutomations: async () => {
    const { getAutomationsService } = await import('../../automations/service');
    return (await getAutomationsService().list()).activities;
  },
  listAutomationRuns: async (request) => {
    const { getAutomationsService } = await import('../../automations/service');
    return getAutomationsService().listRuns(request);
  },
  loadHookRuns: async (projectId, worktreeId) => {
    const { loadWorktreeHookRuns } =
      await import('../../services/hooks-service');
    // Identity only: no output lines are read.
    return loadWorktreeHookRuns({ projectId, worktreeId, maxLines: 0 });
  },
  getHookSourceInfo: async (request) => {
    const { getHookSourceInfo } = await import('../../services/hooks-service');
    return getHookSourceInfo(request);
  },
  listBuiltinSkillNames,
  resolveCoworkProjectId: resolveCoworkWorkspaceId,
};

// ---------------------------------------------------------------------------
// Reference accumulation
// ---------------------------------------------------------------------------

const SOURCE_ORDER: readonly SharedContainerCapabilityUsageSource[] = [
  'transcript',
  'mcp_activation',
  'agent_route',
  'pipeline_execution',
  'automation',
  'hook_run',
  'selection_fallback',
];

const VIA_ORDER: readonly SharedContainerCapabilityInvocationVia[] = [
  'leading',
  'skill_tool',
  'subagent',
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mcpIdentityKey(identity: SharedContainerMcpServerIdentity): string {
  switch (identity.kind) {
    case 'standalone':
      return stableStringify([
        identity.kind,
        identity.serverId,
        identity.configId,
      ]);
    case 'plugin':
      return stableStringify([
        identity.kind,
        identity.marketplaceId,
        identity.pluginName,
        identity.serverName,
      ]);
    case 'account':
      return stableStringify([
        identity.kind,
        identity.connectionId,
        identity.configId,
      ]);
    case 'tool_namespace':
      return stableStringify([identity.kind, identity.namespace]);
  }
}

function referenceKey(
  target: SharedContainerCapabilityReferenceTarget,
): string {
  switch (target.kind) {
    case 'skill':
      return `skill:${stableStringify([target.sourceId, target.skillName])}`;
    case 'plugin':
      return `plugin:${stableStringify([target.marketplaceId, target.pluginName])}`;
    case 'invocation':
      return `invocation:${stableStringify([target.provider, target.token])}`;
    case 'mcp_server':
      return `mcp_server:${mcpIdentityKey(target.identity)}`;
    case 'agent':
      return `agent:${stableStringify([target.agentId])}`;
    case 'pipeline':
      return `pipeline:${stableStringify([
        target.sourceKind,
        target.pipelineId,
        target.filePath ?? null,
      ])}`;
    case 'automation':
      return `automation:${stableStringify([target.automationId])}`;
    case 'hook':
      return `hook:${stableStringify([target.hookKey])}`;
  }
}

interface AccumulatedReference {
  target: SharedContainerCapabilityReferenceTarget;
  sources: Set<SharedContainerCapabilityUsageSource>;
}

class ReferenceAccumulator {
  private readonly entries = new Map<string, AccumulatedReference>();

  add(
    target: SharedContainerCapabilityReferenceTarget,
    source: SharedContainerCapabilityUsageSource,
  ): void {
    const key = referenceKey(target);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { target, sources: new Set([source]) });
      return;
    }
    existing.sources.add(source);
    if (existing.target.kind === 'invocation' && target.kind === 'invocation') {
      const via = new Set([...existing.target.via, ...target.via]);
      existing.target = {
        ...existing.target,
        via: VIA_ORDER.filter((entry) => via.has(entry)),
      };
    }
  }

  list(): SharedContainerCapabilityReference[] {
    return Array.from(this.entries.entries())
      .map(([key, entry]): SharedContainerCapabilityReference => {
        const provenance = SOURCE_ORDER.filter((source) =>
          entry.sources.has(source),
        );
        const priority: SharedContainerCapabilityUsagePriority =
          provenance.some((source) => source !== 'selection_fallback')
            ? 'observed'
            : 'fallback';
        return { ...entry.target, key, provenance, priority };
      })
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
  }
}

function emptyDiagnostics(): SharedContainerCapabilityUsageDiagnostics {
  return {
    chatsRequested: 0,
    chatsRead: 0,
    chatsFromCache: 0,
    chatsMissing: 0,
    chatsUnreadable: 0,
    duplicateChatIds: 0,
    duplicateVisitsSkipped: 0,
    delegationRunsVisited: 0,
    delegationCyclesSkipped: 0,
    transcriptReferencesTruncated: 0,
    excludedBuiltin: 0,
    excludedCanopyMcp: 0,
    excludedRepoLocal: 0,
    excludedCarriedHooks: 0,
    agentsUnavailable: 0,
    agentsUnreadable: 0,
    pipelineExecutionsMissing: 0,
    pipelineExecutionsUnreadable: 0,
    pipelineDefinitionsUnreadable: 0,
    pipelineChildExecutionsSkipped: 0,
    pipelinesHistorical: 0,
    pipelinesTruncated: 0,
    pipelineSnapshotsUnavailable: 0,
    automationsUnreadable: 0,
    automationSystemSkipped: 0,
    automationRunHistoryTruncated: 0,
    hooksUnavailable: 0,
    cacheDiscarded: 0,
    cacheWriteFailed: 0,
  };
}

// ---------------------------------------------------------------------------
// Transcript parsing (cached)
// ---------------------------------------------------------------------------

type TranscriptTarget =
  | Extract<SharedContainerCapabilityReferenceTarget, { kind: 'invocation' }>
  | Extract<SharedContainerCapabilityReferenceTarget, { kind: 'mcp_server' }>
  | { kind: 'agent'; agentId: string };

interface TranscriptReference {
  source: 'transcript' | 'mcp_activation';
  target: TranscriptTarget;
}

interface DelegationIdentity {
  id: string;
  runGeneration: number;
  sequence: number;
  status: string;
}

interface ParsedChatUsage {
  references: TranscriptReference[];
  /** Delegation children seen, so their identities key the entry. */
  delegations: DelegationIdentity[];
  /** A child or the chat itself may still change without a new revision. */
  volatile: boolean;
  duplicateVisitsSkipped: number;
  delegationRunsVisited: number;
  delegationCyclesSkipped: number;
  referencesTruncated: number;
}

interface CachedChatUsage {
  identity: string;
  usage: ParsedChatUsage;
}

interface CacheFile {
  version: typeof CACHE_FILE_VERSION;
  parserVersion: number;
  chats: Record<string, CachedChatUsage>;
}

function agentIdFromModel(model: unknown): string | null {
  if (typeof model !== 'string' || model.length === 0) return null;
  const route = parseAgentRouteModelId(model);
  if (route) return route.agentId;
  return isValidSharedAgentModelId(model) ? model : null;
}

function parseToolInput(input: string): Record<string, unknown> | undefined {
  if (input.length > MAX_TOOL_INPUT_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function transcriptTargetKey(target: TranscriptTarget): string {
  return target.kind === 'agent'
    ? `agent:${stableStringify([target.agentId])}`
    : referenceKey(target);
}

function leadingText(message: PersistedChatMessage): string {
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text.trim().length > 0)
      return block.text;
  }
  return '';
}

class TranscriptParser {
  private readonly references = new Map<string, TranscriptReference>();
  private readonly seenMessages = new Set<string>();
  private readonly parentOf = new Map<string, string | null>();
  private readonly cyclicBlocks = new Set<string>();
  private readonly delegations = new Map<string, DelegationIdentity>();
  private volatile = false;
  private duplicateVisitsSkipped = 0;
  private delegationCyclesSkipped = 0;
  private referencesTruncated = 0;

  constructor(volatile: boolean) {
    this.volatile = volatile;
  }

  private add(reference: TranscriptReference): void {
    const key = `${reference.source}|${transcriptTargetKey(reference.target)}`;
    const existing = this.references.get(key);
    if (existing) {
      if (
        existing.target.kind === 'invocation' &&
        reference.target.kind === 'invocation'
      ) {
        const via = new Set([...existing.target.via, ...reference.target.via]);
        existing.target = {
          ...existing.target,
          via: VIA_ORDER.filter((entry) => via.has(entry)),
        };
      }
      return;
    }
    if (this.references.size >= MAX_TRANSCRIPT_REFERENCES_PER_CHAT) {
      this.referencesTruncated += 1;
      return;
    }
    this.references.set(key, reference);
  }

  private addAgent(model: unknown): void {
    const agentId = agentIdFromModel(model);
    if (agentId)
      this.add({ source: 'transcript', target: { kind: 'agent', agentId } });
  }

  /**
   * Records a delegation card's place in the delegation tree. A card that
   * would become its own ancestor, or that reappears under a different
   * parent, is a cycle and is not followed again.
   */
  private enterDelegation(blockId: string, parent: string | null): boolean {
    if (this.parentOf.has(blockId)) {
      if (this.parentOf.get(blockId) !== parent) {
        this.delegationCyclesSkipped += 1;
        return false;
      }
      return true;
    }
    let current = parent;
    for (let depth = 0; current !== null; depth += 1) {
      if (current === blockId || depth >= MAX_DELEGATION_DEPTH) {
        this.cyclicBlocks.add(blockId);
        this.delegationCyclesSkipped += 1;
        return false;
      }
      current = this.parentOf.get(current) ?? null;
    }
    this.parentOf.set(blockId, parent);
    return true;
  }

  consume(message: PersistedChatMessage): void {
    if (this.seenMessages.has(message.id)) {
      this.duplicateVisitsSkipped += 1;
      return;
    }
    this.seenMessages.add(message.id);
    const parent = message.parentBlockId ?? null;
    if (parent !== null && this.cyclicBlocks.has(parent)) return;

    if (message.role === 'user' && message.hidden !== true) {
      const text = leadingText(message);
      const token = leadingSkillInvocation(text);
      if (token) {
        this.add({
          source: 'transcript',
          target: {
            kind: 'invocation',
            token,
            provider: text.trimStart().startsWith('$') ? 'codex' : 'claude',
            via: ['leading'],
          },
        });
      }
    }

    for (const block of message.blocks) {
      switch (block.type) {
        case 'tool_use':
          this.consumeToolUse(block.toolName, block.input);
          break;
        case 'mcp_activation': {
          const record = readMcpActivationRecord(block.record);
          if (!record || record.cancelled) break;
          for (const identity of record.requiredTargets)
            this.add({
              source: 'mcp_activation',
              target: { kind: 'mcp_server', identity },
            });
          break;
        }
        case 'delegated_agent_call': {
          if (!this.enterDelegation(block.agentBlockId, parent)) break;
          const previous = this.delegations.get(block.agentBlockId);
          if (
            previous &&
            previous.runGeneration === block.runGeneration &&
            previous.sequence >= block.sequence
          ) {
            this.duplicateVisitsSkipped += 1;
          } else {
            this.delegations.set(block.agentBlockId, {
              id: block.agentBlockId,
              runGeneration: block.runGeneration,
              sequence: block.sequence,
              status: block.status,
            });
          }
          if (!TERMINAL_DELEGATION_STATUSES.has(block.status))
            this.volatile = true;
          this.addAgent(block.selectedModelId);
          this.addAgent(block.routeSnapshot?.selectedModelId);
          this.addAgent(block.requestedModelId);
          break;
        }
        case 'codex_agent_call': {
          if (!this.enterDelegation(block.agentBlockId, parent)) break;
          this.addAgent(block.model);
          for (const receiver of Object.values(block.receiverAgents ?? {}))
            this.addAgent(receiver.model);
          break;
        }
        default:
          break;
      }
    }
  }

  private consumeToolUse(toolName: string, rawInput: string): void {
    const input =
      toolName === 'Skill' || toolName === 'Task' || toolName === 'Agent'
        ? parseToolInput(rawInput)
        : undefined;
    if (toolName === 'Task' || toolName === 'Agent') {
      // Only namespaced subagents come from installable plugins; bare types
      // are provider built-ins.
      const subagent =
        typeof input?.subagent_type === 'string'
          ? input.subagent_type.trim().toLowerCase()
          : '';
      if (subagent.includes(':'))
        this.add({
          source: 'transcript',
          target: {
            kind: 'invocation',
            token: subagent,
            provider: 'claude',
            via: ['subagent'],
          },
        });
      return;
    }
    const entry = toolShapeEntry(
      toolName,
      toolName === 'Skill' ? { skill: input?.skill } : undefined,
    );
    if (entry?.startsWith('skill:')) {
      this.add({
        source: 'transcript',
        target: {
          kind: 'invocation',
          token: entry.slice('skill:'.length),
          provider: 'claude',
          via: ['skill_tool'],
        },
      });
    } else if (entry?.startsWith('mcp:')) {
      this.add({
        source: 'transcript',
        target: {
          kind: 'mcp_server',
          identity: {
            kind: 'tool_namespace',
            namespace: entry.slice('mcp:'.length),
          },
        },
      });
    }
  }

  result(): ParsedChatUsage {
    const delegations = Array.from(this.delegations.values()).sort(
      (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    return {
      references: Array.from(this.references.entries())
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, reference]) => reference),
      delegations,
      volatile: this.volatile,
      duplicateVisitsSkipped: this.duplicateVisitsSkipped,
      delegationRunsVisited: delegations.length,
      delegationCyclesSkipped: this.delegationCyclesSkipped,
      referencesTruncated: this.referencesTruncated,
    };
  }
}

async function parseMessages(
  messages:
    | AsyncIterable<PersistedChatMessage>
    | Iterable<PersistedChatMessage>,
  volatile: boolean,
  signal: AbortSignal | undefined,
): Promise<ParsedChatUsage> {
  const parser = new TranscriptParser(volatile);
  let count = 0;
  for await (const message of messages) {
    count += 1;
    if (count % ABORT_CHECK_INTERVAL === 0) signal?.throwIfAborted();
    parser.consume(message);
  }
  signal?.throwIfAborted();
  return parser.result();
}

/**
 * Content identity of a chat's transcript. Uses the descriptor's revision and
 * committed hash chain, never length alone. A tab without a descriptor
 * carries its rows inline and is hashed directly.
 */
function transcriptIdentity(tab: PersistedChatTab): {
  identity: string;
  volatile: boolean;
} {
  const descriptor = tab.transcript;
  if (!descriptor) {
    return {
      identity: sha256(
        stableStringify({
          parser: SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION,
          chatId: tab.id,
          inline: tab.messages,
        }),
      ),
      volatile: false,
    };
  }
  return {
    identity: sha256(
      stableStringify({
        parser: SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION,
        chatId: tab.id,
        transcriptRevision: descriptor.transcriptRevision,
        committedDigest: descriptor.committedDigest ?? null,
        committedByteLength: descriptor.committedByteLength,
        committedMessageCount: descriptor.committedMessageCount,
        messageCount: descriptor.messageCount ?? null,
        lastMessageId: descriptor.lastMessageId ?? null,
        lastMessageAt: descriptor.lastMessageAt ?? null,
        hasActiveSidecar: descriptor.hasActiveSidecar,
      }),
    ),
    // Active rows change without a committed revision.
    volatile: descriptor.hasActiveSidecar,
  };
}

// ---------------------------------------------------------------------------
// Cache file
// ---------------------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readMcpIdentity(
  value: unknown,
): SharedContainerMcpServerIdentity | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'standalone':
      return typeof value.serverId === 'string' &&
        typeof value.configId === 'string'
        ? {
            kind: 'standalone',
            serverId: value.serverId,
            configId: value.configId,
          }
        : null;
    case 'plugin':
      return typeof value.marketplaceId === 'string' &&
        typeof value.pluginName === 'string' &&
        typeof value.serverName === 'string'
        ? {
            kind: 'plugin',
            marketplaceId: value.marketplaceId,
            pluginName: value.pluginName,
            serverName: value.serverName,
          }
        : null;
    case 'account':
      return typeof value.connectionId === 'string' &&
        typeof value.configId === 'string'
        ? {
            kind: 'account',
            connectionId: value.connectionId,
            configId: value.configId,
          }
        : null;
    case 'tool_namespace':
      return typeof value.namespace === 'string'
        ? { kind: 'tool_namespace', namespace: value.namespace }
        : null;
    default:
      return null;
  }
}

function readVia(
  value: unknown,
): SharedContainerCapabilityInvocationVia[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const via: SharedContainerCapabilityInvocationVia[] = [];
  for (const entry of value) {
    const known = VIA_ORDER.find((candidate) => candidate === entry);
    if (!known) return null;
    via.push(known);
  }
  return via;
}

function readTranscriptTarget(value: unknown): TranscriptTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'agent') {
    return typeof value.agentId === 'string'
      ? { kind: 'agent', agentId: value.agentId }
      : null;
  }
  if (value.kind === 'mcp_server') {
    const identity = readMcpIdentity(value.identity);
    return identity ? { kind: 'mcp_server', identity } : null;
  }
  if (value.kind === 'invocation') {
    const via = readVia(value.via);
    return typeof value.token === 'string' &&
      (value.provider === 'claude' || value.provider === 'codex') &&
      via
      ? {
          kind: 'invocation',
          token: value.token,
          provider: value.provider,
          via,
        }
      : null;
  }
  return null;
}

function readParsedChatUsage(value: unknown): ParsedChatUsage | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.references) ||
    !Array.isArray(value.delegations) ||
    value.volatile !== false ||
    !isCount(value.duplicateVisitsSkipped) ||
    !isCount(value.delegationRunsVisited) ||
    !isCount(value.delegationCyclesSkipped) ||
    !isCount(value.referencesTruncated) ||
    value.references.length > MAX_TRANSCRIPT_REFERENCES_PER_CHAT
  )
    return null;
  const references: TranscriptReference[] = [];
  for (const entry of value.references) {
    if (!isRecord(entry)) return null;
    const source = entry.source;
    if (source !== 'transcript' && source !== 'mcp_activation') return null;
    const target = readTranscriptTarget(entry.target);
    if (!target) return null;
    references.push({ source, target });
  }
  const delegations: DelegationIdentity[] = [];
  for (const entry of value.delegations) {
    if (
      !isRecord(entry) ||
      !isCount(entry.runGeneration) ||
      !isCount(entry.sequence) ||
      typeof entry.id !== 'string' ||
      typeof entry.status !== 'string'
    )
      return null;
    delegations.push({
      id: entry.id,
      runGeneration: entry.runGeneration,
      sequence: entry.sequence,
      status: entry.status,
    });
  }
  return {
    references,
    delegations,
    volatile: false,
    duplicateVisitsSkipped: value.duplicateVisitsSkipped,
    delegationRunsVisited: value.delegationRunsVisited,
    delegationCyclesSkipped: value.delegationCyclesSkipped,
    referencesTruncated: value.referencesTruncated,
  };
}

type CacheReadResult =
  | { status: 'ok'; file: CacheFile }
  | { status: 'absent' | 'stale' | 'corrupt' };

function parseCacheFile(text: string): CacheReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'corrupt' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.chats))
    return { status: 'corrupt' };
  if (
    parsed.version !== CACHE_FILE_VERSION ||
    parsed.parserVersion !== SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION
  )
    return { status: 'stale' };
  const chats: Record<string, CachedChatUsage> = {};
  for (const [chatId, entry] of Object.entries(parsed.chats)) {
    if (!isRecord(entry) || typeof entry.identity !== 'string')
      return { status: 'corrupt' };
    const usage = readParsedChatUsage(entry.usage);
    if (!usage) return { status: 'corrupt' };
    chats[chatId] = { identity: entry.identity, usage };
  }
  return {
    status: 'ok',
    file: {
      version: CACHE_FILE_VERSION,
      parserVersion: SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION,
      chats,
    },
  };
}

async function readCache(
  path: string,
  diagnostics: SharedContainerCapabilityUsageDiagnostics,
): Promise<CacheFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT')
      logMainProcessWarn(
        '[shared-containers] could not read the capability usage cache',
      );
    return null;
  }
  const result = parseCacheFile(text);
  if (result.status === 'ok') return result.file;
  if (result.status === 'corrupt') {
    diagnostics.cacheDiscarded += 1;
    logMainProcessWarn(
      '[shared-containers] discarded an unreadable capability usage cache',
    );
    await rm(path, { force: true }).catch(() => undefined);
  }
  return null;
}

const cacheWriteTails = new Map<string, Promise<void>>();

async function writeCache(path: string, file: CacheFile): Promise<void> {
  const previous = cacheWriteTails.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(path, JSON.stringify(file), {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
  cacheWriteTails.set(path, next);
  try {
    await next;
  } finally {
    if (cacheWriteTails.get(path) === next) cacheWriteTails.delete(path);
  }
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

function canopyMcpNamespaces(): ReadonlySet<string> {
  return new Set([
    CAPABILITY_BUNDLE_RESERVED_MCP_SERVER_NAME,
    ...[BRAND.tools.namespace, 'canopy'].flatMap((namespace) => [
      namespace,
      `${namespace}_app_advisor`,
      `${namespace}_ui`,
      `${namespace}_pipeline_editor`,
    ]),
  ]);
}

const CLAUDE_REPO_SKILL = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/i;
const CLAUDE_REPO_COMMAND = /^\.claude\/commands\/(.+)\.md$/i;
const CODEX_REPO_SKILL = /^\.(?:codex|agents)\/skills\/([^/]+)\/SKILL\.md$/i;

interface SnapshotIndex {
  claude: ReadonlySet<string>;
  codex: ReadonlySet<string>;
  repositories: ReadonlyArray<{ repoPath: string; paths: ReadonlySet<string> }>;
}

function buildSnapshotIndex(
  snapshot: SharedContainerSnapshotPathIndex | undefined,
): SnapshotIndex {
  const claude = new Set<string>();
  const codex = new Set<string>();
  const repositories: Array<{ repoPath: string; paths: ReadonlySet<string> }> =
    [];
  for (const repository of snapshot?.repositories ?? []) {
    const paths = new Set<string>();
    for (const raw of Array.from(repository.paths)) {
      const path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
      paths.add(path);
      const skill = CLAUDE_REPO_SKILL.exec(path)?.[1];
      if (skill) claude.add(skill.toLowerCase());
      const command = CLAUDE_REPO_COMMAND.exec(path)?.[1];
      if (command) claude.add(command.split('/').join(':').toLowerCase());
      const codexSkill = CODEX_REPO_SKILL.exec(path)?.[1];
      if (codexSkill) codex.add(codexSkill.toLowerCase());
    }
    repositories.push({ repoPath: repository.repoPath, paths });
  }
  return { claude, codex, repositories };
}

function isRepoLocalFileInSnapshot(
  filePath: string,
  index: SnapshotIndex,
): boolean {
  for (const repository of index.repositories) {
    const path = relative(repository.repoPath, filePath);
    if (!path || path.startsWith('..') || isAbsolute(path)) continue;
    if (repository.paths.has(path.split(sep).join('/'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface CollectorContext {
  input: CollectSharedContainerCapabilityUsageInput;
  deps: SharedContainerCapabilityUsageDependencies;
  accumulator: ReferenceAccumulator;
  diagnostics: SharedContainerCapabilityUsageDiagnostics;
  includedChatIds: ReadonlySet<string>;
  snapshot: SnapshotIndex;
  builtinSkills: ReadonlySet<string>;
  canopyMcp: ReadonlySet<string>;
  /** Agent ids seen, with every source that reported each. */
  agentRoutes: Map<string, Set<SharedContainerCapabilityUsageSource>>;
}

function addAgentRoute(
  context: CollectorContext,
  agentId: string,
  source: SharedContainerCapabilityUsageSource,
): void {
  const sources = context.agentRoutes.get(agentId);
  if (sources) sources.add(source);
  else context.agentRoutes.set(agentId, new Set([source]));
}

function addTranscriptReference(
  context: CollectorContext,
  reference: TranscriptReference,
): void {
  const { target } = reference;
  if (target.kind === 'agent') {
    addAgentRoute(context, target.agentId, reference.source);
    return;
  }
  context.accumulator.add(target, reference.source);
}

async function collectTranscripts(
  context: CollectorContext,
  tabs: readonly PersistedChatTab[],
): Promise<void> {
  const { input, deps, diagnostics } = context;
  const cachePath = getWorktreeShareCapabilityUsageCachePath(
    input.projectId,
    input.worktreeId,
  );
  const previous = await readCache(cachePath, diagnostics);
  const next: CacheFile = {
    version: CACHE_FILE_VERSION,
    parserVersion: SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION,
    chats: {},
  };
  for (const tab of tabs) {
    input.signal?.throwIfAborted();
    const { identity, volatile } = transcriptIdentity(tab);
    const cached = previous?.chats[tab.id];
    let usage: ParsedChatUsage;
    if (cached && cached.identity === identity && !volatile) {
      usage = cached.usage;
      diagnostics.chatsFromCache += 1;
    } else {
      try {
        usage = tab.transcript
          ? await deps.consumeTranscript(
              { projectId: input.projectId, worktreeId: input.worktreeId },
              tab.id,
              (messages) => parseMessages(messages, volatile, input.signal),
            )
          : await parseMessages(tab.messages, volatile, input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // A transcript removed since the tabs were read is absent; any other
        // failure leaves this chat's usage unknown, never empty.
        if (isErrnoException(error) && error.code === 'ENOENT') {
          diagnostics.chatsMissing += 1;
          continue;
        }
        diagnostics.chatsUnreadable += 1;
        logMainProcessWarn(
          '[shared-containers] an included transcript is unreadable; capability usage is incomplete',
        );
        continue;
      }
      diagnostics.chatsRead += 1;
    }
    if (!usage.volatile) next.chats[tab.id] = { identity, usage };
    diagnostics.duplicateVisitsSkipped += usage.duplicateVisitsSkipped;
    diagnostics.delegationRunsVisited += usage.delegationRunsVisited;
    diagnostics.delegationCyclesSkipped += usage.delegationCyclesSkipped;
    diagnostics.transcriptReferencesTruncated += usage.referencesTruncated;
    for (const reference of usage.references)
      addTranscriptReference(context, reference);
  }
  input.signal?.throwIfAborted();
  // Removed and excluded chats drop out because only included ones are kept.
  if (previous && stableStringify(previous) === stableStringify(next)) return;
  try {
    await writeCache(cachePath, next);
  } catch {
    diagnostics.cacheWriteFailed += 1;
    logMainProcessWarn(
      '[shared-containers] could not write the capability usage cache',
    );
  }
}

function addMcpActivation(
  context: CollectorContext,
  tab: PersistedChatTab,
): void {
  const record = readMcpActivationRecord(tab.mcpActivation);
  if (!record || record.cancelled) return;
  for (const identity of record.requiredTargets)
    context.accumulator.add({ kind: 'mcp_server', identity }, 'mcp_activation');
}

function chatProvider(tab: PersistedChatTab): string | undefined {
  return tab.providerType ?? tab.executionHarness;
}

async function addSelectionFallback(
  context: CollectorContext,
  tab: PersistedChatTab,
): Promise<void> {
  const provider = chatProvider(tab);
  if (provider !== 'codex' && provider !== 'cursor') return;
  const selections = await context.deps.resolveBackgroundSelections(
    tab.pluginSelections,
    {
      projectId: context.input.projectId,
      worktreeId: context.input.worktreeId,
      chatId: tab.id,
    },
  );
  if (!selections) return;
  for (const plugin of selections.pluginRefs ?? [])
    context.accumulator.add(
      {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
      },
      'selection_fallback',
    );
  if (provider === 'codex') {
    for (const skill of selections.skillRefs ?? []) {
      if (isBuiltinSourceId(skill.sourceId)) {
        context.diagnostics.excludedBuiltin += 1;
        continue;
      }
      context.accumulator.add(
        { kind: 'skill', sourceId: skill.sourceId, skillName: skill.skillName },
        'selection_fallback',
      );
    }
    return;
  }
  for (const server of selections.mcpServerRefs ?? [])
    context.accumulator.add(
      {
        kind: 'mcp_server',
        identity: {
          kind: 'standalone',
          serverId: server.serverId,
          configId: server.configId,
        },
      },
      'selection_fallback',
    );
}

function addChatAgentRoutes(
  context: CollectorContext,
  tab: PersistedChatTab,
): void {
  const models = [tab.model, ...Object.values(tab.autoRoutedModels ?? {})];
  for (const model of models) {
    const agentId = agentIdFromModel(model);
    if (agentId) addAgentRoute(context, agentId, 'agent_route');
  }
}

function agentDefinitionVersion(agent: AgentModelDefinition): string {
  return (
    agent.contentHash ??
    sha256(
      stableStringify({
        id: agent.id,
        name: agent.name,
        baseModel: agent.baseModel,
        instructions: agent.instructions,
        pluginSelections: agent.pluginSelections,
        updatedAt: agent.updatedAt,
      }),
    )
  );
}

async function resolveAgents(context: CollectorContext): Promise<void> {
  const entries = Array.from(context.agentRoutes.entries()).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const definitions = await mapWithConcurrency(
    entries,
    SOURCE_READ_CONCURRENCY,
    async ([agentId]): Promise<AgentModelDefinition | null | 'unreadable'> => {
      try {
        return await context.deps.getAgentModel(
          agentId,
          context.input.projectId,
        );
      } catch (error) {
        if (context.input.signal?.aborted) throw error;
        return 'unreadable';
      }
    },
  );
  entries.forEach(([agentId, sources], index) => {
    const agent = definitions[index];
    if (agent === 'unreadable') {
      context.diagnostics.agentsUnreadable += 1;
      return;
    }
    if (!agent) {
      context.diagnostics.agentsUnavailable += 1;
      return;
    }
    const target: SharedContainerCapabilityReferenceTarget = {
      kind: 'agent',
      agentId,
      definitionVersion: agentDefinitionVersion(agent),
    };
    for (const source of Array.from(sources))
      context.accumulator.add(target, source);
  });
}

function historicalSnapshot(
  state: ExecutionState,
): SharedContainerHistoricalPipelineSnapshot | null {
  try {
    const yaml = dump(state.pipeline_snapshot, {
      sortKeys: true,
      noRefs: true,
      skipInvalid: true,
      lineWidth: -1,
    });
    if (Buffer.byteLength(yaml) > MAX_HISTORICAL_SNAPSHOT_BYTES) return null;
    return {
      format: 'normalized_pipeline_yaml',
      yaml,
      executionId: state.id,
      capturedAt: state.started_at,
    };
  } catch {
    return null;
  }
}

function addHistoricalPipeline(
  context: CollectorContext,
  state: ExecutionState,
  target: {
    pipelineId: string;
    sourceKind: SharedContainerPipelineSourceKind;
    filePath?: string;
  },
): void {
  const snapshot = historicalSnapshot(state);
  if (!snapshot) {
    context.diagnostics.pipelineSnapshotsUnavailable += 1;
    return;
  }
  context.diagnostics.pipelinesHistorical += 1;
  context.accumulator.add(
    {
      kind: 'pipeline',
      ...target,
      historical: true,
      historicalSnapshot: snapshot,
    },
    'pipeline_execution',
  );
}

/**
 * A pipeline definition read. Null means the definition is gone, so its
 * last run's snapshot stands in; a read error is never taken for deletion.
 */
async function readDefinition(
  context: CollectorContext,
  read: () => Promise<string | null>,
): Promise<{ raw: string | null } | undefined> {
  try {
    return { raw: await read() };
  } catch (error) {
    if (context.input.signal?.aborted) throw error;
    context.diagnostics.pipelineDefinitionsUnreadable += 1;
    return undefined;
  }
}

async function addExecutedPipeline(
  context: CollectorContext,
  state: ExecutionState,
): Promise<void> {
  const { deps, diagnostics, accumulator } = context;
  const locator = state.pipeline_preference_locator;
  if (!locator) {
    if (state.shared_pipeline_source) {
      accumulator.add(
        {
          kind: 'pipeline',
          pipelineId: `${state.shared_pipeline_source.serverId}:${state.shared_pipeline_source.remoteId}`,
          sourceKind: 'shared',
        },
        'pipeline_execution',
      );
      return;
    }
    addHistoricalPipeline(context, state, {
      pipelineId: state.pipeline_id,
      sourceKind: 'inline',
    });
    return;
  }
  switch (locator.type) {
    case 'stored': {
      if (locator.source === 'bundled') {
        diagnostics.excludedBuiltin += 1;
        return;
      }
      if (locator.source === 'curated') {
        accumulator.add(
          {
            kind: 'pipeline',
            pipelineId: locator.value,
            sourceKind: 'curated',
            ...(locator.contentHash
              ? { definitionVersion: locator.contentHash }
              : {}),
          },
          'pipeline_execution',
        );
        return;
      }
      const read = await readDefinition(context, () =>
        deps.readUserPipeline(locator.value),
      );
      if (!read) return;
      const raw = read.raw;
      if (raw === null) {
        addHistoricalPipeline(context, state, {
          pipelineId: locator.value,
          sourceKind: 'user',
        });
        return;
      }
      accumulator.add(
        {
          kind: 'pipeline',
          pipelineId: locator.value,
          sourceKind: 'user',
          definitionVersion: sha256(raw),
        },
        'pipeline_execution',
      );
      return;
    }
    case 'file': {
      // Carried in code only when the file itself is in this revision.
      if (isRepoLocalFileInSnapshot(locator.value, context.snapshot)) {
        diagnostics.excludedRepoLocal += 1;
        return;
      }
      const read = await readDefinition(context, () =>
        deps.readPipelineFile(locator.value),
      );
      if (!read) return;
      const raw = read.raw;
      if (raw === null) {
        addHistoricalPipeline(context, state, {
          pipelineId: state.pipeline_id,
          sourceKind: 'file',
          filePath: locator.value,
        });
        return;
      }
      accumulator.add(
        {
          kind: 'pipeline',
          pipelineId: state.pipeline_id,
          sourceKind: 'file',
          filePath: locator.value,
          definitionVersion: sha256(raw),
        },
        'pipeline_execution',
      );
      return;
    }
    case 'shared':
      accumulator.add(
        { kind: 'pipeline', pipelineId: locator.value, sourceKind: 'shared' },
        'pipeline_execution',
      );
      return;
  }
}

function sameProject(context: CollectorContext, projectId: unknown): boolean {
  if (typeof projectId !== 'string' || projectId.length === 0) return false;
  if (projectId === context.input.projectId) return true;
  return (
    context.deps.resolveCoworkProjectId(projectId) ===
    context.deps.resolveCoworkProjectId(context.input.projectId)
  );
}

async function collectPipelineExecutions(
  context: CollectorContext,
): Promise<void> {
  const { input, deps, diagnostics } = context;
  const summaries = (await deps.listExecutionSummaries()).filter(
    (summary) =>
      summary.worktree_id === input.worktreeId &&
      sameProject(context, summary.project_id),
  );
  // One state per pipeline: the newest run names its current source and
  // holds the most recent snapshot.
  const latestByPipeline = new Map<string, ExecutionSummary>();
  for (const summary of summaries) {
    if (summary.parent_execution_id) {
      diagnostics.pipelineChildExecutionsSkipped += 1;
      continue;
    }
    const existing = latestByPipeline.get(summary.pipeline_id);
    if (!existing || summary.started_at > existing.started_at)
      latestByPipeline.set(summary.pipeline_id, summary);
  }
  const selected = Array.from(latestByPipeline.values()).sort((left, right) =>
    left.pipeline_id < right.pipeline_id
      ? -1
      : left.pipeline_id > right.pipeline_id
        ? 1
        : 0,
  );
  if (selected.length > MAX_PIPELINES)
    diagnostics.pipelinesTruncated += selected.length - MAX_PIPELINES;
  const states = await mapWithConcurrency(
    selected.slice(0, MAX_PIPELINES),
    SOURCE_READ_CONCURRENCY,
    async (summary): Promise<ExecutionState | null | 'unreadable'> => {
      input.signal?.throwIfAborted();
      try {
        return await deps.loadExecutionState(summary.id);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return 'unreadable';
      }
    },
  );
  input.signal?.throwIfAborted();
  for (const state of states) {
    if (state === 'unreadable') {
      diagnostics.pipelineExecutionsUnreadable += 1;
      continue;
    }
    if (!state) {
      // Removed since it was listed.
      diagnostics.pipelineExecutionsMissing += 1;
      continue;
    }
    await addExecutedPipeline(context, state);
  }
}

/**
 * The project and worktree an automation's action runs in, as the
 * automations service reserves them (`automationTarget` in
 * `automations/service.ts`). Null when each run picks a new destination.
 */
function automationTargetOf(
  action: AutomationAction,
): { projectId: string; worktreeId: string } | null {
  switch (action.type) {
    case 'worktree_session_prompt':
      return { projectId: action.workspaceId, worktreeId: action.worktreeId };
    case 'worktree_prompt': {
      const worktreeId = action.existingWorktreeId ?? action.baseWorktreeId;
      return worktreeId ? { projectId: action.workspaceId, worktreeId } : null;
    }
    case 'worktree_pipeline': {
      // An existing task is reserved; so is a fresh worktree's base.
      const projectId = pipelineAutomationWorkspaceId(action);
      const worktreeId =
        pipelineAutomationTaskId(action) ?? action.baseWorktreeId;
      return projectId && worktreeId ? { projectId, worktreeId } : null;
    }
    case 'standalone_prompt':
      return action.workEntryId
        ? { projectId: action.chatProjectId, worktreeId: action.workEntryId }
        : null;
    default:
      return null;
  }
}

/** Recovery automations the app schedules itself; not user capabilities. */
function isSystemAutomation(action: AutomationAction): boolean {
  return (
    action.type === 'pipeline_execution_resume' ||
    (action.type === 'worktree_session_prompt' &&
      action.purpose === 'usage_limit_resume')
  );
}

function runReachedContainer(
  context: CollectorContext,
  run: ScheduledActivityRun,
): boolean {
  const target = run.target;
  const result = run.result;
  const projectId = target?.workspaceId ?? result?.projectId;
  if (!sameProject(context, projectId)) return false;
  const worktreeId = target?.worktreeId ?? result?.worktreeId;
  if (worktreeId === context.input.worktreeId) return true;
  const chatId =
    target?.chatId ??
    result?.chatId ??
    result?.standaloneChatId ??
    result?.appAdvisorChatId;
  return chatId !== undefined && context.includedChatIds.has(chatId);
}

async function automationRanIntoContainer(
  context: CollectorContext,
  activityId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTOMATION_RUN_PAGES; page += 1) {
    context.input.signal?.throwIfAborted();
    const response = await context.deps.listAutomationRuns({
      activityId,
      limit: AUTOMATION_RUN_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (response.runs.some((run) => runReachedContainer(context, run)))
      return true;
    if (!response.nextCursor) return false;
    cursor = response.nextCursor;
  }
  context.diagnostics.automationRunHistoryTruncated += 1;
  return false;
}

function automationDefinitionVersion(activity: ScheduledActivity): string {
  return sha256(
    stableStringify({
      name: activity.name,
      schedule: activity.schedule,
      action: activity.action,
      ifCommand: activity.ifCommand ?? null,
      targetRequirement: activity.targetRequirement ?? null,
      updatedAt: activity.updatedAt,
    }),
  );
}

async function collectAutomations(context: CollectorContext): Promise<void> {
  const activities = await context.deps.listAutomations();
  const relevant = await mapWithConcurrency(
    activities,
    SOURCE_READ_CONCURRENCY,
    async (activity): Promise<boolean> => {
      if (isSystemAutomation(activity.action)) {
        context.diagnostics.automationSystemSkipped += 1;
        return false;
      }
      const target = automationTargetOf(activity.action);
      if (
        target &&
        target.worktreeId === context.input.worktreeId &&
        sameProject(context, target.projectId)
      )
        return true;
      // A retargeted automation still counts when it ran into this container.
      try {
        return await automationRanIntoContainer(context, activity.id);
      } catch (error) {
        if (context.input.signal?.aborted) throw error;
        context.diagnostics.automationsUnreadable += 1;
        return false;
      }
    },
  );
  context.input.signal?.throwIfAborted();
  activities.forEach((activity, index) => {
    if (!relevant[index]) return;
    context.accumulator.add(
      {
        kind: 'automation',
        automationId: activity.id,
        definitionVersion: automationDefinitionVersion(activity),
      },
      'automation',
    );
  });
}

function hookSourceRequest(
  context: CollectorContext,
  run: HookRunSnapshot,
): HookSourceInfoRequest | null {
  const { hook } = run;
  const { projectId, worktreeId } = context.input;
  switch (hook.target) {
    case 'project':
      return {
        target: 'project',
        triggerName: hook.triggerName,
        projectId,
        worktreeId,
      };
    case 'workspace-root':
      return {
        target: 'workspace-root',
        triggerName: hook.triggerName,
        workspaceId: projectId,
        worktreeId,
      };
    case 'workspace-repo':
      return hook.repoId
        ? {
            target: 'workspace-repo',
            triggerName: hook.triggerName,
            workspaceId: projectId,
            repoId: hook.repoId,
            worktreeId,
          }
        : null;
  }
}

async function collectHooks(context: CollectorContext): Promise<void> {
  const { input, deps, diagnostics } = context;
  const runs = await deps.loadHookRuns(input.projectId, input.worktreeId);
  const byKey = new Map<string, HookRunSnapshot>();
  for (const run of runs) byKey.set(run.hook.hookKey, run);
  for (const run of Array.from(byKey.values())) {
    input.signal?.throwIfAborted();
    const request = hookSourceRequest(context, run);
    // Hooks are reported but never packaged, so an unreadable hook does not
    // make the usage incomplete.
    const info = request
      ? await deps.getHookSourceInfo(request).catch(() => null)
      : null;
    const active = info?.layers.find((layer) => layer.status === 'active');
    if (!info || !active || !info.effectiveActions) {
      diagnostics.hooksUnavailable += 1;
      continue;
    }
    // Only the workspace's own configuration is workspace-owned; every
    // other layer is a `canopy.json` already carried in code.
    if (active.sourceKey !== 'local-override') {
      diagnostics.excludedCarriedHooks += 1;
      continue;
    }
    context.accumulator.add(
      {
        kind: 'hook',
        hookKey: run.hook.hookKey,
        scope: run.hook.target,
        triggerName: run.hook.triggerName,
        ...(run.hook.repoId ? { repoId: run.hook.repoId } : {}),
        ...(run.hook.repoName ? { repoName: run.hook.repoName } : {}),
        definitionVersion: sha256(stableStringify(info.effectiveActions)),
      },
      'hook_run',
    );
  }
}

/** Drops built-in, Canopy-owned and code-carried references. */
function applyExclusions(
  context: CollectorContext,
  references: readonly SharedContainerCapabilityReference[],
): SharedContainerCapabilityReference[] {
  const { diagnostics } = context;
  return references.filter((reference) => {
    if (reference.kind === 'invocation') {
      const bare = reference.token;
      if (context.builtinSkills.has(bare)) {
        diagnostics.excludedBuiltin += 1;
        return false;
      }
      const repoLocal =
        reference.provider === 'codex'
          ? context.snapshot.codex
          : context.snapshot.claude;
      if (repoLocal.has(bare)) {
        diagnostics.excludedRepoLocal += 1;
        return false;
      }
      return true;
    }
    if (reference.kind === 'skill' && isBuiltinSourceId(reference.sourceId)) {
      diagnostics.excludedBuiltin += 1;
      return false;
    }
    if (
      reference.kind === 'mcp_server' &&
      reference.identity.kind === 'tool_namespace' &&
      context.canopyMcp.has(reference.identity.namespace)
    ) {
      diagnostics.excludedCanopyMcp += 1;
      return false;
    }
    return true;
  });
}

function computeSourceVersion(
  containerType: SharedContainerCapabilityUsage['containerType'],
  references: readonly SharedContainerCapabilityReference[],
): string {
  return `scu:v${String(SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION)}:${sha256(
    stableStringify({
      parserVersion: SHARED_CONTAINER_CAPABILITY_USAGE_PARSER_VERSION,
      containerType,
      references,
    }),
  )}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Collects the normalized capability usage of one shared container revision.
 * Throws the signal's reason when aborted. Absent sources are skipped; an
 * unreadable source is counted in diagnostics and sets `incomplete`, so a
 * caller never mistakes a transient read failure for unused capabilities.
 */
export async function collectSharedContainerCapabilityUsage(
  input: CollectSharedContainerCapabilityUsageInput,
  deps: SharedContainerCapabilityUsageDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedContainerCapabilityUsage> {
  input.signal?.throwIfAborted();
  const diagnostics = emptyDiagnostics();
  const includedChatIds = new Set<string>();
  for (const chatId of input.includedChatIds) {
    if (includedChatIds.has(chatId)) diagnostics.duplicateChatIds += 1;
    includedChatIds.add(chatId);
  }
  diagnostics.chatsRequested = includedChatIds.size;
  const context: CollectorContext = {
    input,
    deps,
    accumulator: new ReferenceAccumulator(),
    diagnostics,
    includedChatIds,
    snapshot: buildSnapshotIndex(
      input.containerType === 'CODE_WORKTREE' ? input.snapshotPaths : undefined,
    ),
    builtinSkills: new Set(
      (await deps.listBuiltinSkillNames()).map((name) => name.toLowerCase()),
    ),
    canopyMcp: canopyMcpNamespaces(),
    agentRoutes: new Map(),
  };

  const chatTabs = await deps.readChatTabs(input.projectId, input.worktreeId);
  const tabsById = new Map<string, PersistedChatTab>();
  for (const tab of chatTabs.tabs)
    if (tab.kind !== 'file' && includedChatIds.has(tab.id))
      tabsById.set(tab.id, tab);
  const tabs = Array.from(includedChatIds)
    .sort()
    .flatMap((chatId) => {
      const tab = tabsById.get(chatId);
      if (!tab) diagnostics.chatsMissing += 1;
      return tab ? [tab] : [];
    });

  await collectTranscripts(context, tabs);
  for (const tab of tabs) {
    input.signal?.throwIfAborted();
    addMcpActivation(context, tab);
    addChatAgentRoutes(context, tab);
    await addSelectionFallback(context, tab);
  }
  await resolveAgents(context);
  input.signal?.throwIfAborted();
  await collectPipelineExecutions(context);
  input.signal?.throwIfAborted();
  await collectAutomations(context);
  if (input.containerType === 'CODE_WORKTREE') {
    input.signal?.throwIfAborted();
    await collectHooks(context);
  }
  input.signal?.throwIfAborted();

  const references = applyExclusions(context, context.accumulator.list());
  const incomplete =
    diagnostics.chatsUnreadable +
      diagnostics.agentsUnreadable +
      diagnostics.pipelineExecutionsUnreadable +
      diagnostics.pipelineDefinitionsUnreadable +
      diagnostics.automationsUnreadable >
    0;
  return {
    containerType: input.containerType,
    references,
    incomplete,
    sourceVersion: computeSourceVersion(input.containerType, references),
    diagnostics,
  };
}
