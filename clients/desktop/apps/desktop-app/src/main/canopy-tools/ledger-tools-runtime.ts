import { createHash, randomUUID } from 'node:crypto';
import {
  LEDGER_GRANTS,
  LEDGER_LIMITS,
  LedgerAddEntryToolInputSchema,
  LedgerErrorDetailsSchema,
  LedgerSearchEntriesToolInputSchema,
  LedgerUpdateEntryToolInputSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type LedgerActorKind,
  type LedgerActorRef,
  type LedgerAttributionKind,
  type LedgerAuthorDetails,
  type LedgerCommandReceipt,
  type LedgerContainer,
  type LedgerEntriesSearchResult,
  type LedgerEntry,
  type LedgerEntryUpdateResult,
  type LedgerEntrySearchItem,
  type LedgerEntryType,
  type LedgerErrorDetails,
  type LedgerFileRef,
  type LedgerGlobalOwner,
  type LedgerOwnerCandidatePage,
  type LedgerOwnerTarget,
  type LedgerSearchEntriesToolInput,
  type LedgerSourceAvailability,
  type LedgerStatus,
  type LedgerWorkSummaryGetResult,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type AssistantMode,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { z } from 'zod';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getFeatureFlagService } from '../feature-flags';
import { readLedgerContainerLiveChats } from '../ledger/actor-directory';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from '../ledger/caller-bindings';
import { ledgerDatabaseMayExist } from '../ledger/lifecycle';
import { isSafeLedgerContainerId } from '../ledger/lifecycle-containers';
import { resolveLedgerContainerCreatedAt } from '../ledger/scope-bindings';
import {
  peekPreferencesLoadError,
  readPreferencesFile,
} from '../lib/preferences-store';
import { getWorkspaceType } from '../lib/workspace-registry';
import type { CanopyInjectedToolTextResult } from './core';
import {
  buildLedgerToolPrompt,
  ledgerToolNames,
  type LedgerToolNames,
} from './prompting';
import { agentCoreOperations } from './agent-core-operations';

/*
 * The Agent Ledger tools for chat sessions (native Code and Cowork chats,
 * Cursor, the Claude Code terminal and App Advisor), for the runs of managed
 * delegates and for the attempts of desktop-run pipeline agents: the exposure
 * gate, the per-session caller binding and the tool runtime behind
 * AddLedgerEntry, SearchLedgerEntries and UpdateLedgerEntry.
 *
 * Every call goes through the desktop dispatcher (`core.ledger.*`) as a
 * trusted in-process host caller. Scope, actor, author details and time come
 * from the binding this module registers, never from tool arguments; the
 * protocol tool schemas reject unknown keys.
 */

/** The three Ledger tools' canonical keys. */
export type LedgerToolKey = Extract<
  CanopyInjectedToolKey,
  'add_ledger_entry' | 'search_ledger_entries' | 'update_ledger_entry'
>;

/** The harness a session's agent runs on, recorded in author details. */
export type LedgerHarness = 'claude' | 'codex' | 'cursor' | 'opencode';

/** The chat a session's Ledger tools speak for. */
export interface LedgerChatTarget {
  readonly projectId: string;
  /**
   * A code worktree ID, or a Cowork or App Advisor Work Entry ID in the
   * worktree slot.
   */
  readonly worktreeId: string;
  readonly chatId: string;
  readonly assistantMode?: AssistantMode;
}

/** A container incarnation, as the exposure gate resolved it. */
export interface LedgerChatScope {
  readonly container: LedgerContainer;
  readonly containerCreatedAt: string;
}

/** The session settings recorded as an entry's author details. */
export interface LedgerChatSettings {
  readonly model: string | null;
  readonly thinkingEffort: string | null;
  readonly planMode: boolean;
  /**
   * The effective mode when the surface has its own (a pipeline step's
   * permission preset); otherwise `planMode` decides plan or default.
   */
  readonly mode?: string;
}

/** Who spawned a managed delegate. */
export type LedgerDelegateParent =
  /** The chat the session targets: the root chat of the delegation. */
  | { readonly kind: 'chat' }
  /** For a nested delegate, the delegate one level up. */
  | {
      readonly kind: 'managed_delegation';
      readonly delegationId: string;
      readonly description: string | null;
    };

/**
 * A managed delegate a session's Ledger tools speak for: one run of the
 * delegation, in the Ledger of its root chat's scope. The delegate records as
 * its own actor, never as the chat or delegate that spawned it.
 */
export interface LedgerDelegateCaller {
  /** The durable delegation ID: the delegate's actor, kept across follow-ups. */
  readonly delegationId: string;
  /** The delegate's task description, shown as its name. */
  readonly description: string;
  /** The run generation holding the tools, and the binding's generation. */
  readonly runGeneration: number;
  readonly parent: LedgerDelegateParent;
  /**
   * False once the run is stopping or its parent session released it, so the
   * tools refuse every call from then on.
   */
  readonly isLive: () => boolean;
}

/**
 * A desktop-run pipeline agent a session's Ledger tools speak for: one
 * attempt of an agent step, in the Ledger of the worktree its execution runs
 * in. It records as its own actor, the attempt's agent session, never as the
 * person or chat that ran the pipeline.
 */
export interface LedgerPipelineAgentCaller {
  readonly executionId: string;
  /** The job as it ran; each matrix variant is its own. */
  readonly physicalJobId: string;
  readonly logicalJobId: string;
  readonly stepId: string;
  /** 1-based. */
  readonly attempt: number;
  readonly iteration: number;
  /** The host-minted agent session: the actor, kept when its checkpoint resumes. */
  readonly agentSessionId: string;
  /** The session of the attempt this retry replaces. */
  readonly predecessorAgentSessionId?: string;
  /** The recovery checkpoint this run resumes. */
  readonly checkpointId?: string;
  /** The agent's name as the Ledger shows it. */
  readonly displayName: string;
  /**
   * The step's configured secret values, masked out of every entry the agent
   * writes, whatever their shape.
   */
  readonly secretValues?: readonly string[];
  /** False once the attempt settled or paused, so the tools refuse calls. */
  readonly isLive: () => boolean;
}

/** The provider invocation behind one tool call. */
export interface LedgerToolInvocation {
  /**
   * The exact provider invocation identity (a Claude tool_use ID, or a Codex
   * thread/turn/call ID). Retries and replays of one invocation carry the
   * same value, so a key derived from it deduplicates them.
   */
  readonly invocationId?: string;
  readonly signal?: AbortSignal;
}

/** What `executeCanopyInjectedTool` needs from a session's Ledger tools. */
export interface LedgerToolsRuntime {
  execute(
    key: LedgerToolKey,
    rawArgs: unknown,
    invocation?: LedgerToolInvocation,
  ): Promise<CanopyInjectedToolTextResult>;
  /** Host-owned dispatcher operations for delegation Feed hand-off. */
  readonly delegationFeed?: LedgerDelegationFeedRuntime;
}

/** A content-free revision snapshot retained from spawn preflight. */
export interface LedgerDelegationFeedEntrySnapshot {
  readonly entryId: string;
  readonly revision: number;
  readonly type: LedgerEntryType;
  readonly status: LedgerStatus;
  readonly ownerActorId: string;
  readonly parentEntryId?: string;
}

export interface LedgerDelegationFeedValidation {
  /** Invalid listed IDs are all reported, so the caller can repair one call. */
  readonly invalid: readonly {
    readonly entryId: string;
    readonly reason: string;
  }[];
  /** Snapshots include the listed roots and permitted open descendants. */
  readonly listed: readonly LedgerDelegationFeedEntrySnapshot[];
  readonly subtasks: readonly LedgerDelegationFeedEntrySnapshot[];
}

export interface LedgerDelegationFeedUpdate {
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly owner: LedgerOwnerTarget;
  readonly idempotencyKey: string;
}

/** Dispatcher-only authorization filters; never part of injected tool input. */
export type LedgerDelegationFeedSearch = LedgerSearchEntriesToolInput & {
  readonly updatableByCaller?: true;
  readonly ownerDelegationId?: string;
};

/**
 * The only Feed surface delegation host code may use. Each member resolves
 * this session's trusted caller and dispatches core.ledger.*; it never exposes
 * the dispatcher, store, or actor binding to delegation code.
 */
export interface LedgerDelegationFeedRuntime {
  validateTaskIds(
    entryIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<LedgerDelegationFeedValidation>;
  searchEntries(
    params: LedgerDelegationFeedSearch,
    signal?: AbortSignal,
  ): Promise<LedgerEntriesSearchResult>;
  owners(
    delegationId: string,
    signal?: AbortSignal,
  ): Promise<LedgerOwnerCandidatePage>;
  updateEntry(
    update: LedgerDelegationFeedUpdate,
    signal?: AbortSignal,
  ): Promise<LedgerEntryUpdateResult>;
  workSummary(
    delegationId: string,
    signal?: AbortSignal,
  ): Promise<LedgerWorkSummaryGetResult>;
  readAssignedEntries(
    entryIds: readonly string[],
  ): Promise<readonly { readonly entryId: string; readonly title: string }[]>;
}

export type LedgerToolsDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/** The caller-binding registry operations a session uses. */
export interface LedgerToolsBindingRegistry {
  register(registration: LedgerCallerBindingRegistration): string;
  resolve(bindingId: string): unknown;
  revoke(bindingId: string): boolean;
}

/**
 * Host capabilities behind the gate and the runtime. The desktop host reads
 * the app's flag service, preferences, registries and persistence; tests
 * substitute their own.
 */
export interface LedgerToolsHost {
  readonly dispatcher: () => LedgerToolsDispatcher | null;
  readonly registry: () => LedgerToolsBindingRegistry;
  /** `canopy-ledger-enabled`. */
  readonly isFlagEnabled: () => boolean;
  /** The "Agents add to the Feed" setting; fails closed. */
  readonly isRecordingEnabled: () => Promise<boolean>;
  readonly workspaceType: (projectId: string) => WorkspaceType | null;
  readonly containerCreatedAt: (
    container: LedgerContainer,
  ) => Promise<string | null>;
  /**
   * A container's creation time, looked up without binding a scope: what an
   * open session's recheck reads. Defaults to `containerCreatedAt`.
   */
  readonly findContainerCreatedAt?: (
    container: LedgerContainer,
  ) => Promise<string | null>;
  readonly chatTitle: (
    container: LedgerContainer,
    chatId: string,
  ) => Promise<string | null>;
  /** False only once a `stat` shows the database does not exist. */
  readonly databaseMayExist: () => Promise<boolean>;
}

/** Why a session has no usable Ledger tools (E05). */
export type LedgerToolsUnavailableReason =
  | 'ledger_disabled'
  | 'agent_recording_off'
  | 'no_ledger_scope'
  | 'ledger_runtime_unavailable'
  | 'session_ended';

const UNAVAILABLE_MESSAGES: {
  readonly [Reason in LedgerToolsUnavailableReason]: string;
} = {
  ledger_disabled: 'The Feed is not available. Continue without recording.',
  agent_recording_off:
    '"Agents add to the Feed" is turned off in Settings. Continue without recording.',
  no_ledger_scope: 'This chat has no Feed. Continue without recording.',
  ledger_runtime_unavailable:
    'The Feed is not available right now. Continue without recording.',
  session_ended:
    'The Feed is not available right now. Continue without recording.',
};

/** Open statuses: the ones an owner keeps current. */
const OPEN_LEDGER_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];
const DELEGATION_FEED_SUBTASK_LIMIT = 200;
const DELEGATION_FEED_AUTHORIZATION_BATCH_SIZE = 25;

/**
 * App-managed chats without a Ledger scope in v1 (LD07). App Advisor chats
 * have one: their Work Entry.
 */
const NON_LEDGER_PROJECT_IDS: ReadonlySet<string> = new Set([
  STANDALONE_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

/** Matches the dispatcher's request-metadata bound on idempotency keys. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 512;
/** Keeps a tool result well inside provider tool-output limits. */
const MAX_RESULT_CHARACTERS = 40_000;
/** Open entries the turn-start assignment hint reads. */
const ASSIGNMENT_HINT_PAGE_SIZE = 25;
const ASSIGNMENT_HINT_TIMEOUT_MS = 1_000;
const ASSIGNMENT_OPERATION_LIMIT = 3;
const ASSIGNMENT_HISTORY_READ_LIMIT = 3;
const OPEN_OPERATION_HINT_LIMIT = 3;
const SETTING_VALUE_MAX_CODE_POINTS = 256;
const DEFAULT_CHAT_DISPLAY_NAME = 'Chat';
const DEFAULT_DELEGATE_DISPLAY_NAME = 'Delegate';
const DEFAULT_PIPELINE_AGENT_DISPLAY_NAME = 'Workflow agent';

let boundDispatcher: LedgerToolsDispatcher | null = null;

/** The host supplies the already-running desktop dispatcher, or null at shutdown. */
export function bindLedgerToolsDispatcher(
  dispatcher: LedgerToolsDispatcher | null,
): void {
  boundDispatcher = dispatcher;
}

function isLedgerFlagEnabled(): boolean {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    );
  } catch {
    return false;
  }
}

/**
 * Fails closed on a degraded read. When the preferences file is corrupt,
 * unreadable or on an unsupported version, `readPreferencesFile()` returns
 * recovered or default preferences, where recording is on, so a person's
 * earlier "off" could silently come back. Until the app has shown the
 * recovery notice, recording stays off: the safeguard approval defaults use
 * (`approvalDefaultsFromPreferences`). A fresh install has no load error and
 * keeps the default.
 */
async function readAgentRecordingEnabled(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    if (peekPreferencesLoadError() !== null) return false;
    return preferences.ledgerAgentRecordingEnabled !== false;
  } catch {
    return false;
  }
}

async function readChatTitle(
  container: LedgerContainer,
  chatId: string,
): Promise<string | null> {
  const chats = await readLedgerContainerLiveChats(container);
  return chats.find((chat) => chat.chatId === chatId)?.title ?? null;
}

export const DESKTOP_LEDGER_TOOLS_HOST: LedgerToolsHost = {
  dispatcher: (): LedgerToolsDispatcher | null => boundDispatcher,
  registry: getLedgerCallerBindingRegistry,
  isFlagEnabled: isLedgerFlagEnabled,
  isRecordingEnabled: readAgentRecordingEnabled,
  workspaceType: getWorkspaceType,
  containerCreatedAt: (container): Promise<string | null> =>
    resolveLedgerContainerCreatedAt(container),
  chatTitle: readChatTitle,
  databaseMayExist: ledgerDatabaseMayExist,
};

/**
 * The container a chat's Ledger tools bind to, from synchronous checks only:
 * a default-mode chat in a known code workspace (its worktree) or Cowork
 * workspace (its Work Entry), or an App Advisor chat (the Work Entry its
 * session started in, never the entry selected later). Other app-managed
 * chats get none in v1 (LD07).
 */
export function ledgerChatContainerFor(
  target: Pick<LedgerChatTarget, 'projectId' | 'worktreeId' | 'assistantMode'>,
  host: Pick<LedgerToolsHost, 'workspaceType'> = DESKTOP_LEDGER_TOOLS_HOST,
): LedgerContainer | null {
  if (target.projectId === APP_ADVISOR_PROJECT_ID) {
    return target.assistantMode === 'app-advisor' &&
      isSafeLedgerContainerId(target.worktreeId)
      ? {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: target.worktreeId,
        }
      : null;
  }
  if ((target.assistantMode ?? 'default') !== 'default') return null;
  if (NON_LEDGER_PROJECT_IDS.has(target.projectId)) return null;
  if (
    !isSafeLedgerContainerId(target.projectId) ||
    !isSafeLedgerContainerId(target.worktreeId)
  ) {
    return null;
  }
  switch (host.workspaceType(target.projectId)) {
    case 'cowork':
      return {
        kind: 'cowork_entry',
        workspaceId: target.projectId,
        entryId: target.worktreeId,
      };
    case 'single-repo':
    case 'multi-repo':
      return {
        kind: 'code_worktree',
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
      };
    case null:
      return null;
  }
}

/**
 * The synchronous half of the exposure gate: the flag, and a chat that can
 * have a Ledger scope. False means the session gets no Ledger tools without
 * any I/O; true still needs `resolveLedgerToolExposure`.
 */
export function mayExposeLedgerTools(
  target: LedgerChatTarget,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): boolean {
  return host.isFlagEnabled() && ledgerChatContainerFor(target, host) !== null;
}

/**
 * The advertisement gate: `canopy-ledger-enabled`, the "Agents add to the
 * Feed" setting, and a resolvable scope binding (a known container with a
 * creation time). Null when any fails. Reads no Ledger storage.
 */
export async function resolveLedgerToolExposure(
  target: LedgerChatTarget,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): Promise<LedgerChatScope | null> {
  try {
    if (!host.isFlagEnabled()) return null;
    const container = ledgerChatContainerFor(target, host);
    if (container === null) return null;
    if (!(await host.isRecordingEnabled())) return null;
    const containerCreatedAt = await host.containerCreatedAt(container);
    return containerCreatedAt === null
      ? null
      : { container, containerCreatedAt };
  } catch {
    return null;
  }
}

/**
 * The advertisement gate of a pipeline agent with no task, recording to its
 * run owner's global (workflow) Ledger: `canopy-ledger-enabled`, the "Agents
 * add to the Feed" setting, and the owner's global Ledger for the signed-in
 * account, which binding mints on first use. Null when any fails.
 */
export async function resolveLedgerGlobalToolExposure(
  owner: LedgerGlobalOwner,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): Promise<LedgerChatScope | null> {
  try {
    if (!host.isFlagEnabled()) return null;
    if (!(await host.isRecordingEnabled())) return null;
    const container: LedgerContainer = { kind: 'global', owner };
    const containerCreatedAt = await host.containerCreatedAt(container);
    return containerCreatedAt === null
      ? null
      : { container, containerCreatedAt };
  } catch {
    return null;
  }
}

/**
 * The file root a session's working directory belongs to, for Ledger
 * reference files: the App Advisor or Cowork folder, the selected repository
 * of a multi-repository project, or the single repository.
 */
export function ledgerReferenceRootIdFor(
  target: LedgerChatTarget,
  container: LedgerContainer,
  selectedRepoId: string | undefined,
  host: LedgerToolsHost = DESKTOP_LEDGER_TOOLS_HOST,
): string {
  if (container.kind === 'advisor_entry') return APP_ADVISOR_PROJECT_ID;
  if (container.kind === 'cowork_entry') return COWORK_WORKSPACE_FILE_ROOT_ID;
  return host.workspaceType(target.projectId) === 'multi-repo'
    ? (selectedRepoId ?? WORKSPACE_ROOT_REPO_ID)
    : target.projectId;
}

/**
 * The Ledger block for the system prompt or developer instructions of a
 * session whose Ledger tools are exposed.
 */
export function ledgerToolPromptFor(options: {
  readonly target: LedgerChatTarget;
  readonly scope: LedgerChatScope;
  readonly harness: LedgerHarness;
  readonly toolNames?: LedgerToolNames;
  readonly selectedRepoId?: string;
  readonly delegate?: LedgerDelegateCaller;
  readonly pipelineAgent?: LedgerPipelineAgentCaller;
  readonly host?: LedgerToolsHost;
}): string {
  // A global (workflow) Ledger's entries reference no files.
  if (options.scope.container.kind === 'global') {
    return buildLedgerToolPrompt(options.harness, {
      ...(options.toolNames ? { toolNames: options.toolNames } : {}),
      planModeException: false,
      pipelineAgent: true,
      globalScope: true,
    });
  }
  return buildLedgerToolPrompt(options.harness, {
    referenceRootId: ledgerReferenceRootIdFor(
      options.target,
      options.scope.container,
      options.selectedRepoId,
      options.host,
    ),
    ...(options.toolNames ? { toolNames: options.toolNames } : {}),
    // Neither App Advisor, a managed delegate nor a pipeline agent has a
    // Plan mode, so their prompts need no exception.
    ...(options.scope.container.kind === 'advisor_entry' ||
    options.delegate !== undefined ||
    options.pipelineAgent !== undefined
      ? { planModeException: false }
      : {}),
    ...(options.delegate !== undefined ? { delegate: true } : {}),
    ...(options.pipelineAgent !== undefined ? { pipelineAgent: true } : {}),
  });
}

export interface LedgerChatToolsSessionOptions {
  readonly target: LedgerChatTarget;
  readonly scope: LedgerChatScope;
  readonly harness: LedgerHarness;
  /**
   * The names the session's agent calls the tools by, when its surface
   * renames them (App Advisor's own server). Defaults to the harness's
   * injected-tool names.
   */
  readonly toolNames?: LedgerToolNames;
  /** The session's live settings, read when a binding is (re)registered. */
  readonly readSettings: () => LedgerChatSettings;
  readonly selectedRepoId?: string;
  /**
   * Set for a managed delegate's run: the tools then speak for the delegate
   * (role `managed_delegation`) in the target chat's scope, not for the chat.
   */
  readonly delegate?: LedgerDelegateCaller;
  /**
   * Set for a pipeline agent's attempt: the tools speak for that agent (role
   * `pipeline_agent`) in the Ledger of the target's worktree.
   */
  readonly pipelineAgent?: LedgerPipelineAgentCaller;
  readonly host?: LedgerToolsHost;
}

async function openLedgerToolsSession(
  options: Omit<LedgerChatToolsSessionOptions, 'scope'>,
): Promise<LedgerChatToolsSession | null> {
  const scope = await resolveLedgerToolExposure(options.target, options.host);
  return scope === null
    ? null
    : new LedgerChatToolsSession({ ...options, scope });
}

/** Opens a session's Ledger tools when the exposure gate passes. */
export function openLedgerChatTools(
  options: Omit<
    LedgerChatToolsSessionOptions,
    'scope' | 'delegate' | 'pipelineAgent'
  >,
): Promise<LedgerChatToolsSession | null> {
  return openLedgerToolsSession(options);
}

/**
 * Opens the Ledger tools of one managed delegate run when the same gate as
 * its root chat's passes: `canopy-ledger-enabled`, the "Agents add to the
 * Feed" setting, and a Ledger scope for the chat (`target`) the delegation
 * belongs to. Null otherwise, so the child gets no Ledger tools.
 */
export function openLedgerDelegateTools(
  options: Omit<
    LedgerChatToolsSessionOptions,
    'scope' | 'delegate' | 'pipelineAgent'
  > & {
    readonly delegate: LedgerDelegateCaller;
  },
): Promise<LedgerChatToolsSession | null> {
  return openLedgerToolsSession(options);
}

/**
 * Opens the Ledger tools of one pipeline agent attempt when the gate passes:
 * `canopy-ledger-enabled`, the "Agents add to the Feed" setting and a Ledger
 * scope. An execution with a worktree records to it (`target`; its chat ID
 * only labels the route), and only code worktrees qualify; one without
 * (`globalOwner` set: a global or directory run) records to its owner's
 * global (workflow) Ledger. Null otherwise, and the step then runs without
 * Ledger tools.
 */
export async function openLedgerPipelineAgentTools(
  options: Omit<
    LedgerChatToolsSessionOptions,
    'scope' | 'delegate' | 'pipelineAgent'
  > & {
    readonly pipelineAgent: LedgerPipelineAgentCaller;
    /** The run's owner, for an execution without a worktree. */
    readonly globalOwner?: LedgerGlobalOwner;
  },
): Promise<LedgerChatToolsSession | null> {
  const { globalOwner, ...session } = options;
  if (globalOwner !== undefined) {
    const scope = await resolveLedgerGlobalToolExposure(
      globalOwner,
      options.host,
    );
    return scope === null
      ? null
      : new LedgerChatToolsSession({ ...session, scope });
  }
  const scope = await resolveLedgerToolExposure(options.target, options.host);
  return scope === null || scope.container.kind !== 'code_worktree'
    ? null
    : new LedgerChatToolsSession({ ...session, scope });
}

let lastRuntimeGeneration = 0;

type CallerResolution =
  | { readonly kind: 'caller'; readonly caller: CanopyCallerDescriptor }
  | {
      readonly kind: 'unavailable';
      readonly reason: LedgerToolsUnavailableReason;
    };

type ParsedArgs<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false; readonly result: CanopyInjectedToolTextResult };

/**
 * One provider session's Ledger tools, for a chat, one run of a managed
 * delegate or one attempt of a pipeline agent. The session registers a caller
 * binding on first use and reuses it; a settings change replaces it, and
 * `dispose` revokes it. Bindings never persist.
 */
export class LedgerChatToolsSession implements LedgerToolsRuntime {
  /**
   * Unique per session in this process; keys derived from provider
   * invocations include it. A chat's binding carries it as its generation;
   * a delegate's carries the run generation instead.
   */
  readonly runtimeGeneration: number;
  private readonly options: LedgerChatToolsSessionOptions;
  private readonly host: LedgerToolsHost;
  private binding: { readonly id: string; readonly detailsKey: string } | null =
    null;
  private callerQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private selfActorId: string | null = null;
  /** Open entries owned by this chat, by ID, at the revision it last saw. */
  private knownAssignments = new Map<string, number>();
  private assignmentBaseline = false;
  private readyOperations = new Map<string, boolean>();
  private operationHintOffset = 0;
  private seenHandbacks = new Map<string, number>();
  /** Changed entries whose handback history a capped or failed turn did not read. */
  private pendingHandbackChecks = new Set<string>();
  private readonly delegationFeedPort: LedgerDelegationFeedRuntime | undefined;

  constructor(options: LedgerChatToolsSessionOptions) {
    this.options = options;
    this.host = options.host ?? DESKTOP_LEDGER_TOOLS_HOST;
    this.delegationFeedPort =
      options.pipelineAgent === undefined
        ? this.createDelegationFeedPort()
        : undefined;
    lastRuntimeGeneration += 1;
    this.runtimeGeneration = lastRuntimeGeneration;
  }

  private createDelegationFeedPort(): LedgerDelegationFeedRuntime {
    return {
      validateTaskIds: (entryIds, signal) =>
        this.validateDelegationTaskIds(entryIds, signal),
      searchEntries: (params, signal) =>
        this.dispatchFeedSearch(params, signal),
      owners: (delegationId, signal) =>
        this.dispatchDelegationOwnerQuery(delegationId, signal),
      updateEntry: (update, signal) => this.dispatchFeedUpdate(update, signal),
      workSummary: (delegationId, signal) =>
        this.dispatchFeedWorkSummary(delegationId, signal),
      readAssignedEntries: (entryIds) =>
        this.readCurrentAssignedEntries(entryIds),
    };
  }

  get delegationFeed(): LedgerDelegationFeedRuntime | undefined {
    return this.delegationFeedPort;
  }

  get scope(): LedgerChatScope {
    return this.options.scope;
  }

  /** The Ledger block for this session's system prompt or developer instructions. */
  systemPrompt(): string {
    return ledgerToolPromptFor({ ...this.options, host: this.host });
  }

  /** Revokes the binding. Later calls answer that the Ledger is unavailable. */
  dispose(): void {
    this.disposed = true;
    const binding = this.binding;
    this.binding = null;
    if (binding === null) return;
    try {
      this.host.registry().revoke(binding.id);
    } catch {
      // A registry failure must not escape session teardown.
    }
  }

  async execute(
    key: LedgerToolKey,
    rawArgs: unknown,
    invocation: LedgerToolInvocation = {},
  ): Promise<CanopyInjectedToolTextResult> {
    const gate = await this.executionGate();
    if (gate !== null) return ledgerUnavailableResult(gate);
    switch (key) {
      case 'add_ledger_entry':
        return this.addEntry(rawArgs, invocation);
      case 'update_ledger_entry':
        return this.updateEntry(rawArgs, invocation);
      case 'search_ledger_entries':
        return this.searchEntries(rawArgs, invocation);
    }
  }

  private async validateDelegationTaskIds(
    entryIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<LedgerDelegationFeedValidation> {
    if (entryIds.length === 0) {
      return { invalid: [], listed: [], subtasks: [] };
    }

    const requestedIds = Array.from(new Set(entryIds));
    const listedResult = await this.dispatchFeedSearch(
      { entryIds: requestedIds, limit: requestedIds.length },
      signal,
    );
    const listedById = new Map(
      listedResult.entries.map((entry) => [entry.entryId, entry]),
    );
    const invalid: { entryId: string; reason: string }[] = [];
    const listedCandidates: LedgerEntrySearchItem[] = [];
    for (const entryId of requestedIds) {
      const entry = listedById.get(entryId);
      if (entry === undefined) {
        invalid.push({
          entryId,
          reason: 'this entry is not available in the caller’s Feed',
        });
      } else if (entry.type !== 'OPERATION' && entry.type !== 'TASK') {
        invalid.push({
          entryId,
          reason: 'only OPERATION or TASK entries can be handed off',
        });
      } else if (!OPEN_LEDGER_STATUSES.includes(entry.status)) {
        invalid.push({ entryId, reason: 'this entry is not open' });
      } else {
        listedCandidates.push(entry);
      }
    }

    const listedIds = listedCandidates.map((entry) => entry.entryId);
    const authorizedListedEntries =
      listedIds.length === 0
        ? []
        : await this.dispatchFeedSearch(
            {
              entryIds: listedIds,
              updatableByCaller: true,
              limit: listedIds.length,
            },
            signal,
          ).then((result) => result.entries);
    const authorizedListedIds = new Set(
      authorizedListedEntries.map((entry) => entry.entryId),
    );

    const listed: LedgerDelegationFeedEntrySnapshot[] = [];
    const validRoots: LedgerEntrySearchItem[] = [];
    for (const entry of listedCandidates) {
      if (!authorizedListedIds.has(entry.entryId)) {
        invalid.push({
          entryId: entry.entryId,
          reason: 'the caller cannot update this entry',
        });
        continue;
      }
      validRoots.push(entry);
    }

    const subtaskRows: LedgerEntrySearchItem[] = [];
    for (const entry of validRoots) {
      if (signal?.aborted) throw new Error('Feed validation was cancelled');
      const subtree = await this.readOpenSubtasks(entry.entryId, signal);
      if (subtree.overflow) {
        invalid.push({
          entryId: entry.entryId,
          reason: `its subtask tree has more than ${DELEGATION_FEED_SUBTASK_LIMIT} entries, the hand-off limit; split the work before delegating`,
        });
        continue;
      }
      listed.push(toDelegationFeedEntrySnapshot(entry));
      subtaskRows.push(...subtree.entries);
    }

    const uniqueSubtasks = Array.from(
      new Map(subtaskRows.map((entry) => [entry.entryId, entry])).values(),
    );
    const subtasks = uniqueSubtasks.map(toDelegationFeedEntrySnapshot);
    return { invalid, listed, subtasks };
  }

  private async readOpenSubtasks(
    rootEntryId: string,
    signal?: AbortSignal,
  ): Promise<{ entries: LedgerEntrySearchItem[]; overflow: boolean }> {
    const entries: LedgerEntrySearchItem[] = [];
    const visited = new Set<string>([rootEntryId]);
    const parents = [rootEntryId];
    let queueOffset = 0;

    while (queueOffset < parents.length) {
      if (signal?.aborted) throw new Error('Feed validation was cancelled');
      const parentEntryId = parents[queueOffset];
      queueOffset += 1;
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const result = await this.dispatchFeedSearch(
          {
            parentEntryId,
            limit: LEDGER_LIMITS.searchPageMax,
            ...(cursor === undefined ? {} : { cursor }),
          },
          signal,
        );
        for (const entry of result.entries) {
          if (visited.has(entry.entryId)) continue;
          visited.add(entry.entryId);
          // Walk closed tasks too: an open subtask may sit under one.
          parents.push(entry.entryId);
          if (OPEN_LEDGER_STATUSES.includes(entry.status)) entries.push(entry);
          if (parents.length - 1 > DELEGATION_FEED_SUBTASK_LIMIT) {
            return { entries: [], overflow: true };
          }
        }
        if (!result.hasMore) break;
        if (result.nextCursor === null || seenCursors.has(result.nextCursor))
          return { entries: [], overflow: true };
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
    }

    // Traverse every branch before applying authority. Filtering during
    // the walk would hide an authorized grandchild below an entry the caller
    // cannot itself update.
    const authorized = new Map<string, LedgerEntrySearchItem>();
    for (
      let offset = 0;
      offset < entries.length;
      offset += DELEGATION_FEED_AUTHORIZATION_BATCH_SIZE
    ) {
      if (signal?.aborted) throw new Error('Feed validation was cancelled');
      const batch = entries.slice(
        offset,
        offset + DELEGATION_FEED_AUTHORIZATION_BATCH_SIZE,
      );
      const result = await this.dispatchFeedSearch(
        {
          entryIds: batch.map((entry) => entry.entryId),
          updatableByCaller: true,
          limit: batch.length,
        },
        signal,
      );
      for (const entry of result.entries) authorized.set(entry.entryId, entry);
    }
    return {
      entries: entries.flatMap((entry) => {
        const permitted = authorized.get(entry.entryId);
        return permitted === undefined ? [] : [permitted];
      }),
      overflow: false,
    };
  }

  private async dispatchFeedSearch(
    params: LedgerDelegationFeedSearch,
    signal?: AbortSignal,
  ): Promise<LedgerEntriesSearchResult> {
    return this.withDelegationFeedCaller((dispatcher, caller) =>
      dispatcher.query('core.ledger.entries.search', params, {
        caller,
        ...(signal ? { signal } : {}),
      }),
    );
  }

  private async dispatchFeedWorkSummary(
    delegationId: string,
    signal?: AbortSignal,
  ): Promise<LedgerWorkSummaryGetResult> {
    return this.withDelegationFeedCaller((dispatcher, caller) =>
      dispatcher.query(
        'core.ledger.workSummary.get',
        { delegationId },
        { caller, ...(signal ? { signal } : {}) },
      ),
    );
  }

  private async dispatchDelegationOwnerQuery(
    delegationId: string,
    signal?: AbortSignal,
  ): Promise<LedgerOwnerCandidatePage> {
    // The dispatcher narrows the owner lookup to this exact durable delegate.
    const params = { delegationId };
    return this.withDelegationFeedCaller((dispatcher, caller) =>
      dispatcher.query('core.ledger.owners.list', params, {
        caller,
        ...(signal ? { signal } : {}),
      }),
    );
  }

  private async dispatchFeedUpdate(
    update: LedgerDelegationFeedUpdate,
    signal?: AbortSignal,
  ): Promise<LedgerEntryUpdateResult> {
    return this.withDelegationFeedCaller((dispatcher, caller) =>
      dispatcher.instruction(
        'core.ledger.entry.update',
        {
          entryId: update.entryId,
          expectedRevision: update.expectedRevision,
          owner: update.owner,
          _meta: { idempotencyKey: update.idempotencyKey },
        },
        {
          caller,
          metadata: { idempotencyKey: update.idempotencyKey },
          ...(signal ? { signal } : {}),
        },
      ),
    );
  }

  private async readCurrentAssignedEntries(
    entryIds: readonly string[],
  ): Promise<readonly { readonly entryId: string; readonly title: string }[]> {
    if (entryIds.length === 0) return [];
    if (entryIds.length > LEDGER_LIMITS.searchEntryIdsMax) return [];
    const result = await this.dispatchFeedSearch({
      entryIds: [...entryIds],
      owner: 'self',
      statuses: [...OPEN_LEDGER_STATUSES],
      limit: entryIds.length,
    });
    return result.entries.map(({ entryId, title }) => ({ entryId, title }));
  }

  private async withDelegationFeedCaller<Result>(
    run: (
      dispatcher: LedgerToolsDispatcher,
      caller: CanopyCallerDescriptor,
    ) => Promise<Result>,
  ): Promise<Result> {
    const unavailable = await this.executionGate();
    if (unavailable !== null)
      throw new Error(UNAVAILABLE_MESSAGES[unavailable]);
    const dispatcher = this.agentDispatcher();
    if (dispatcher === null)
      throw new Error(UNAVAILABLE_MESSAGES.ledger_runtime_unavailable);
    const resolution = await this.resolveCaller();
    if (resolution.kind !== 'caller')
      throw new Error(UNAVAILABLE_MESSAGES[resolution.reason]);
    if (this.hasEnded()) throw new Error(UNAVAILABLE_MESSAGES.session_ended);
    return run(dispatcher, resolution.caller);
  }

  /**
   * A short note at the start of a normal turn when entries assigned to this
   * chat changed since it last saw them, so the agent refreshes owner=self.
   * Bounded queries; never opens storage when the database does not exist
   * and never delays a turn beyond its timeout. Undefined when there is
   * nothing to say.
   */
  async assignmentHint(
    timeoutMs: number = ASSIGNMENT_HINT_TIMEOUT_MS,
  ): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.computeAssignmentHint(controller.signal),
        timeout,
      ]);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async computeAssignmentHint(
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if ((await this.executionGate()) !== null) return undefined;
    if (!(await this.host.databaseMayExist())) return undefined;
    const dispatcher = this.agentDispatcher();
    if (dispatcher === null || signal.aborted) return undefined;
    const resolution = await this.resolveCaller();
    if (resolution.kind !== 'caller' || signal.aborted) return undefined;
    const result = await dispatcher.query(
      'core.ledger.entries.search',
      {
        owner: 'self',
        statuses: [...OPEN_LEDGER_STATUSES],
        sort: 'updated_desc',
        limit: ASSIGNMENT_HINT_PAGE_SIZE,
      },
      { caller: resolution.caller, signal },
    );
    // A result that arrives after the timeout was never shown, so it must
    // not become the baseline the next turn compares against.
    if (signal.aborted) return undefined;
    const seenHandbacks = new Map(this.seenHandbacks);
    const readyOperations = new Map(this.readyOperations);
    const checkedAssignments = new Set<string>();
    const handbacks = await this.handbackHints(
      dispatcher,
      resolution.caller,
      result,
      signal,
      seenHandbacks,
      checkedAssignments,
    );
    if (signal.aborted) return undefined;
    const readiness = await this.operationReadinessHints(
      dispatcher,
      resolution.caller,
      result,
      signal,
      readyOperations,
    );
    if (signal.aborted) return undefined;
    this.seenHandbacks = seenHandbacks;
    this.readyOperations = readyOperations;
    const operationCount = result.entries.filter(
      (entry) => entry.type === 'OPERATION',
    ).length;
    this.operationHintOffset =
      operationCount === 0
        ? 0
        : (this.operationHintOffset + ASSIGNMENT_OPERATION_LIMIT) %
          operationCount;
    return this.noteAssignmentSnapshot(result, checkedAssignments, [
      ...handbacks,
      ...readiness,
    ]);
  }

  private async handbackHints(
    dispatcher: LedgerToolsDispatcher,
    caller: CanopyCallerDescriptor,
    result: LedgerEntriesSearchResult,
    signal: AbortSignal,
    seen: Map<string, number>,
    checked: Set<string>,
  ): Promise<string[]> {
    const changed = result.entries
      .filter((entry) => {
        // shortcut: entry.get only exposes ascending history pages. Skip entries
        // beyond historyPageMax; newest-first or afterRevision reads would lift this limit.
        if (
          (this.knownAssignments.get(entry.entryId) === entry.revision &&
            !this.pendingHandbackChecks.has(entry.entryId)) ||
          entry.revision > LEDGER_LIMITS.historyPageMax
        ) {
          checked.add(entry.entryId);
          return false;
        }
        return true;
      })
      .slice(0, ASSIGNMENT_HISTORY_READ_LIMIT);
    const lines: string[] = [];
    for (const entry of changed) {
      if (signal.aborted) return [];
      try {
        const detail = await dispatcher.query(
          'core.ledger.entry.get',
          {
            entryId: entry.entryId,
            includeHistory: true,
            historyLimit: LEDGER_LIMITS.historyPageMax,
          },
          { caller, signal },
        );
        if (signal.aborted) return [];
        let handbackRevision = seen.get(entry.entryId) ?? 0;
        for (const mutation of detail.history?.mutations ?? []) {
          if (
            mutation.leftOpen !== undefined &&
            mutation.owner?.to.actorId === entry.owner.actorId &&
            mutation.revision > handbackRevision
          ) {
            handbackRevision = mutation.revision;
          }
        }
        if (handbackRevision > (seen.get(entry.entryId) ?? 0)) {
          lines.push(
            `Handed back to you: ${JSON.stringify(entry.title)} (${entry.entryId}); review and close or hand off the unfinished work.`,
          );
          seen.set(entry.entryId, handbackRevision);
        }
        checked.add(entry.entryId);
      } catch {
        // History is best effort, not a reason to delay or refuse the turn.
      }
    }
    return lines;
  }

  private async operationReadinessHints(
    dispatcher: LedgerToolsDispatcher,
    caller: CanopyCallerDescriptor,
    result: LedgerEntriesSearchResult,
    signal: AbortSignal,
    next: Map<string, boolean>,
  ): Promise<string[]> {
    const operations = result.entries.filter(
      (entry) => entry.type === 'OPERATION',
    );
    if (!result.hasMore) {
      for (const entryId of Array.from(next.keys())) {
        if (!operations.some((entry) => entry.entryId === entryId))
          next.delete(entryId);
      }
    }
    const lines: string[] = [];
    const count = Math.min(operations.length, ASSIGNMENT_OPERATION_LIMIT);
    for (let index = 0; index < count; index += 1) {
      if (signal.aborted) return [];
      const operation =
        operations[(this.operationHintOffset + index) % operations.length];
      if (operation === undefined) continue;
      try {
        const children = await dispatcher.query(
          'core.ledger.entries.search',
          { parentEntryId: operation.entryId, limit: 1 },
          { caller, signal },
        );
        if (signal.aborted) return [];
        let ready = false;
        // An empty operation may still be being laid out, not ready to close.
        if (children.entries.length > 0) {
          // Operations are always roots, so this sees open entries at every
          // depth, as the close check does. The open operation is one of them.
          const open = await dispatcher.query(
            'core.ledger.entries.search',
            {
              rootEntryId: operation.entryId,
              statuses: [...OPEN_LEDGER_STATUSES],
              limit: 2,
            },
            { caller, signal },
          );
          if (signal.aborted) return [];
          ready = open.entries.every(
            (entry) => entry.entryId === operation.entryId,
          );
        }
        if (ready && next.get(operation.entryId) !== true) {
          lines.push(
            `Ready to close: ${JSON.stringify(operation.title)} (${operation.entryId}); all its children are closed.`,
          );
        }
        next.set(operation.entryId, ready);
      } catch {
        // Keep the previous transition state when a best-effort read fails.
      }
    }
    if (signal.aborted) return [];
    return lines;
  }

  private noteAssignmentSnapshot(
    result: LedgerEntriesSearchResult,
    checkedAssignments: ReadonlySet<string>,
    lines: readonly string[] = [],
  ): string | undefined {
    const current = new Map<string, number>();
    for (const entry of result.entries) {
      current.set(entry.entryId, entry.revision);
      this.selfActorId ??= entry.owner.actorId;
    }
    let changed = 0;
    current.forEach((revision, entryId): void => {
      if (this.knownAssignments.get(entryId) !== revision) changed += 1;
    });
    let removed = 0;
    if (!result.hasMore) {
      this.knownAssignments.forEach((_revision, entryId): void => {
        if (!current.has(entryId)) removed += 1;
      });
    } else {
      // Unchanged entries can sit beyond the page; keep what was known.
      this.knownAssignments.forEach((revision, entryId): void => {
        if (!current.has(entryId)) current.set(entryId, revision);
      });
    }
    const firstLook = !this.assignmentBaseline;
    this.assignmentBaseline = true;
    // Deferred or failed history checks are retried on a later turn without
    // announcing the entry as changed again.
    this.pendingHandbackChecks = new Set(
      result.entries
        .map((entry) => entry.entryId)
        .filter((entryId) => !checkedAssignments.has(entryId)),
    );
    this.knownAssignments = current;
    const open = `${result.entries.length}${result.hasMore ? '+' : ''}`;
    const searchName = (
      this.options.toolNames ?? ledgerToolNames(this.options.harness)
    ).search;
    const revision = digestAssignments(result);
    if (firstLook) {
      return result.entries.length === 0
        ? undefined
        : `<feed_assignments revision="${revision}" open="${open}">You have ${open} open Feed entries assigned to you. Use ${searchName} with owner "self" to review them before continuing.${lines.length === 0 ? '' : `\n${lines.join('\n')}`}</feed_assignments>`;
    }
    if (changed === 0 && removed === 0 && lines.length === 0) return undefined;
    const changeNote =
      changed === 0 && removed === 0
        ? ''
        : `Feed entries assigned to you changed since your last turn (${changed} new or updated, ${removed} no longer open for you). `;
    return `<feed_assignments revision="${revision}" open="${open}">${changeNote}Use ${searchName} with owner "self" to refresh them before continuing.${lines.length === 0 ? '' : `\n${lines.join('\n')}`}</feed_assignments>`;
  }

  /** The host's dispatcher behind the agent tools' table of granted operations (CAN-4125). */
  private agentDispatcher(): LedgerToolsDispatcher | null {
    const dispatcher = this.host.dispatcher();
    return dispatcher === null
      ? null
      : agentCoreOperations('ledger', dispatcher);
  }

  private async executionGate(): Promise<LedgerToolsUnavailableReason | null> {
    if (this.hasEnded()) return 'session_ended';
    try {
      if (!this.host.isFlagEnabled()) return 'ledger_disabled';
      if (!(await this.host.isRecordingEnabled())) return 'agent_recording_off';
    } catch {
      return 'ledger_disabled';
    }
    // A delegate's run can stop while the setting is read.
    if (this.hasEnded()) return 'session_ended';
    if (this.agentDispatcher() === null) return 'ledger_runtime_unavailable';
    return null;
  }

  private async addEntry(
    rawArgs: unknown,
    invocation: LedgerToolInvocation,
  ): Promise<CanopyInjectedToolTextResult> {
    const parsed = parseToolArgs(
      LedgerAddEntryToolInputSchema,
      rawArgs,
      'AddFeedEntry',
    );
    if (!parsed.success) return parsed.result;
    const { requestKey, ...params } = parsed.data;
    return this.runCommand(
      requestKey,
      invocation,
      async (dispatcher, caller, idempotencyKey) => {
        const receipt = await dispatcher.instruction(
          'core.ledger.entry.add',
          { ...params, _meta: { idempotencyKey } },
          {
            caller,
            metadata: { idempotencyKey },
            ...(invocation.signal ? { signal: invocation.signal } : {}),
          },
        );
        // The author of an entry this chat added is this chat.
        this.selfActorId ??= receipt.entry.author.actorId;
        return receipt;
      },
      params.type === 'TASK' && params.parentEntryId === undefined
        ? (dispatcher, caller): Promise<string | undefined> =>
            this.openOperationsHint(dispatcher, caller, invocation.signal)
        : undefined,
    );
  }

  private async updateEntry(
    rawArgs: unknown,
    invocation: LedgerToolInvocation,
  ): Promise<CanopyInjectedToolTextResult> {
    const parsed = parseToolArgs(
      LedgerUpdateEntryToolInputSchema,
      rawArgs,
      'UpdateFeedEntry',
    );
    if (!parsed.success) return parsed.result;
    const { requestKey, ...params } = parsed.data;
    return this.runCommand(
      requestKey,
      invocation,
      (dispatcher, caller, idempotencyKey) =>
        dispatcher.instruction(
          'core.ledger.entry.update',
          { ...params, _meta: { idempotencyKey } },
          {
            caller,
            metadata: { idempotencyKey },
            ...(invocation.signal ? { signal: invocation.signal } : {}),
          },
        ),
    );
  }

  private async runCommand(
    requestKey: string | undefined,
    invocation: LedgerToolInvocation,
    run: (
      dispatcher: LedgerToolsDispatcher,
      caller: CanopyCallerDescriptor,
      idempotencyKey: string,
    ) => Promise<LedgerCommandReceipt>,
    afterSuccess?: (
      dispatcher: LedgerToolsDispatcher,
      caller: CanopyCallerDescriptor,
    ) => Promise<string | undefined>,
  ): Promise<CanopyInjectedToolTextResult> {
    const dispatcher = this.agentDispatcher();
    if (dispatcher === null) {
      return ledgerUnavailableResult('ledger_runtime_unavailable');
    }
    const resolution = await this.resolveCaller();
    if (resolution.kind !== 'caller') {
      return ledgerUnavailableResult(resolution.reason);
    }
    // Checked again with nothing left to await before the dispatch.
    if (this.hasEnded()) return ledgerUnavailableResult('session_ended');
    const idempotencyKey = this.idempotencyKey(requestKey, invocation);
    try {
      const receipt = await run(dispatcher, resolution.caller, idempotencyKey);
      this.noteOwnEntry(receipt.entry);
      let additionalLine: string | undefined;
      if (afterSuccess !== undefined) {
        try {
          additionalLine = await afterSuccess(dispatcher, resolution.caller);
        } catch {
          // A follow-up hint must never turn a committed write into a failure.
          additionalLine = undefined;
        }
      }
      return {
        text: `${JSON.stringify({
          ok: true,
          changed: receipt.changed,
          entry: projectEntry(receipt.entry, this.selfActorId),
        })}${additionalLine === undefined ? '' : `\n${additionalLine}`}`,
      };
    } catch (error) {
      return this.errorResult(error, {
        mode: 'command',
        explicitKey: requestKey !== undefined,
      });
    }
  }

  /** Suggests open operation parents for a newly added top-level task. */
  private async openOperationsHint(
    dispatcher: LedgerToolsDispatcher,
    caller: CanopyCallerDescriptor,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    try {
      const result = await dispatcher.query(
        'core.ledger.entries.search',
        {
          types: ['OPERATION'],
          statuses: [...OPEN_LEDGER_STATUSES],
          sort: 'updated_desc',
          limit: OPEN_OPERATION_HINT_LIMIT,
        },
        { caller, ...(signal ? { signal } : {}) },
      );
      if (signal?.aborted || result.entries.length === 0) return undefined;
      const namedOperations = result.entries
        .map((entry) => `${JSON.stringify(entry.title)} (${entry.entryId})`)
        .join('; ');
      const more = result.hasMore ? '; and more' : '';
      const searchName = (
        this.options.toolNames ?? ledgerToolNames(this.options.harness)
      ).search;
      return `Open operations in this Feed: ${namedOperations}${more}. Set parentEntryId to one of these IDs if this task belongs under an operation, or use ${searchName} to choose.`;
    } catch {
      // The write already committed; a failed or cancelled hint is best effort.
      return undefined;
    }
  }

  private async searchEntries(
    rawArgs: unknown,
    invocation: LedgerToolInvocation,
  ): Promise<CanopyInjectedToolTextResult> {
    const parsed = parseToolArgs(
      LedgerSearchEntriesToolInputSchema,
      rawArgs,
      'SearchFeedEntries',
    );
    if (!parsed.success) return parsed.result;
    const dispatcher = this.agentDispatcher();
    if (dispatcher === null) {
      return ledgerUnavailableResult('ledger_runtime_unavailable');
    }
    const resolution = await this.resolveCaller();
    if (resolution.kind !== 'caller') {
      return ledgerUnavailableResult(resolution.reason);
    }
    // Checked again with nothing left to await before the dispatch.
    if (this.hasEnded()) return ledgerUnavailableResult('session_ended');
    try {
      const result = await dispatcher.query(
        'core.ledger.entries.search',
        parsed.data,
        {
          caller: resolution.caller,
          ...(invocation.signal ? { signal: invocation.signal } : {}),
        },
      );
      this.learnSelf(parsed.data, result);
      return { text: formatSearchResult(result, this.selfActorId) };
    } catch (error) {
      return this.errorResult(error, { mode: 'query', explicitKey: false });
    }
  }

  private learnSelf(
    params: LedgerSearchEntriesToolInput,
    result: LedgerEntriesSearchResult,
  ): void {
    const first = result.entries[0];
    if (params.owner === 'self' && first !== undefined) {
      this.selfActorId ??= first.owner.actorId;
    } else if (params.author === 'self' && first !== undefined) {
      this.selfActorId ??= first.author.actorId;
    }
    const self = result.owners?.candidates.find(
      (candidate) => candidate.isSelf,
    );
    if (self !== undefined) this.selfActorId ??= self.actor.actorId;
  }

  /** Keeps the assignment baseline current with this chat's own changes. */
  private noteOwnEntry(entry: LedgerEntry): void {
    if (this.selfActorId === null) return;
    if (
      entry.owner.actorId === this.selfActorId &&
      OPEN_LEDGER_STATUSES.includes(entry.status)
    ) {
      this.knownAssignments.set(entry.entryId, entry.revision);
    } else {
      this.knownAssignments.delete(entry.entryId);
    }
  }

  /**
   * An explicit requestKey is the model's retry key, and it holds across
   * sessions. Otherwise the key comes from the exact provider invocation, so
   * a retry of that call within this session dedupes (the Claude CLI resends
   * its tool_use ID after MCP session recovery) while a new call never
   * aliases an earlier receipt. The session generation stays in the key
   * because the fallback JSON-RPC request IDs are unique only per
   * connection, so a replay in a later session needs a requestKey to dedupe.
   * Receipts are already scoped to this ledger, actor and operation.
   */
  private idempotencyKey(
    requestKey: string | undefined,
    invocation: LedgerToolInvocation,
  ): string {
    if (requestKey !== undefined) return `request:${requestKey}`;
    const key =
      invocation.invocationId !== undefined &&
      invocation.invocationId.length > 0
        ? `invocation:${this.options.harness}:${this.runtimeGeneration}:${invocation.invocationId}`
        : // No provider identity: a fresh key is safe but cannot dedupe.
          `call:${randomUUID()}`;
    return key.length <= IDEMPOTENCY_KEY_MAX_LENGTH
      ? key
      : `invocation-sha256:${createHash('sha256').update(key).digest('hex')}`;
  }

  /** Serializes binding registration so concurrent calls share one binding. */
  private resolveCaller(): Promise<CallerResolution> {
    const next = this.callerQueue.then(() => this.ensureBinding());
    this.callerQueue = next.catch(() => undefined);
    return next.catch(
      (): CallerResolution => ({
        kind: 'unavailable',
        reason: 'ledger_runtime_unavailable',
      }),
    );
  }

  private async ensureBinding(): Promise<CallerResolution> {
    if (this.hasEnded())
      return { kind: 'unavailable', reason: 'session_ended' };
    const registry = this.host.registry();
    const authorDetails = this.authorDetails();
    const detailsKey = JSON.stringify(authorDetails);
    const current = this.binding;
    if (current !== null) {
      const live = registry.resolve(current.id) !== undefined;
      if (live && current.detailsKey === detailsKey) {
        // A global (workflow) Ledger is the signed-in account's: after an
        // account switch, the session's binding speaks for no Ledger.
        if (!(await this.isGlobalScopeCurrent())) {
          registry.revoke(current.id);
          this.binding = null;
          return { kind: 'unavailable', reason: 'no_ledger_scope' };
        }
        return { kind: 'caller', caller: callerFor(current.id) };
      }
      // A settings change replaces the binding; one revoked elsewhere (the
      // container's incarnation ended) is re-registered only while the
      // container is still the incarnation this session was bound to.
      if (live) registry.revoke(current.id);
      this.binding = null;
    }
    const { container, containerCreatedAt } = this.options.scope;
    // A global Ledger was bound when the session opened, so a rebind only
    // looks it up and never mints another account's.
    const createdAt =
      container.kind === 'global'
        ? await this.findContainerCreatedAt(container)
        : await this.host.containerCreatedAt(container);
    if (createdAt !== containerCreatedAt) {
      return { kind: 'unavailable', reason: 'no_ledger_scope' };
    }
    const delegate = this.options.delegate;
    // The chat's name labels the chat itself, or the root chat that spawned
    // a delegate; a nested delegate's parent is named by its delegation, and
    // a pipeline agent names itself.
    const chatName =
      this.options.pipelineAgent === undefined &&
      (delegate === undefined || delegate.parent.kind === 'chat')
        ? (nonBlank(
            await this.host
              .chatTitle(container, this.options.target.chatId)
              .catch((): null => null),
          ) ?? DEFAULT_CHAT_DISPLAY_NAME)
        : DEFAULT_CHAT_DISPLAY_NAME;
    if (this.hasEnded()) {
      return { kind: 'unavailable', reason: 'session_ended' };
    }
    const id = registry.register(this.registration(authorDetails, chatName));
    this.binding = { id, detailsKey };
    return { kind: 'caller', caller: callerFor(id) };
  }

  /**
   * Whether a global (workflow) session's Ledger is still the signed-in
   * account's own. True for any other session, whose container decides.
   */
  private async isGlobalScopeCurrent(): Promise<boolean> {
    const { container, containerCreatedAt } = this.options.scope;
    if (container.kind !== 'global') return true;
    return (
      (await this.findContainerCreatedAt(container)) === containerCreatedAt
    );
  }

  private findContainerCreatedAt(
    container: LedgerContainer,
  ): Promise<string | null> {
    const find =
      this.host.findContainerCreatedAt ?? this.host.containerCreatedAt;
    return find(container);
  }

  /**
   * The binding this session registers: its chat, or its delegate's run with
   * the delegation as actor and the lineage the host alone supplies. A
   * delegate's binding generation is its run generation, so each run
   * generation registers its own binding.
   */
  private registration(
    authorDetails: LedgerAuthorDetails,
    chatName: string,
  ): LedgerCallerBindingRegistration {
    const { container, containerCreatedAt } = this.options.scope;
    const chatId = this.options.target.chatId;
    const pipelineAgent = this.options.pipelineAgent;
    if (pipelineAgent !== undefined) {
      return {
        container,
        containerCreatedAt,
        actor: {
          kind: 'pipeline_agent',
          originKey: pipelineAgent.agentSessionId,
          displayName:
            nonBlank(pipelineAgent.displayName) ??
            DEFAULT_PIPELINE_AGENT_DISPLAY_NAME,
        },
        role: 'pipeline_agent',
        authorDetails,
        runtimeGeneration: this.runtimeGeneration,
        origin: {
          kind: 'pipeline_agent',
          executionId: pipelineAgent.executionId,
          physicalJobId: pipelineAgent.physicalJobId,
          logicalJobId: pipelineAgent.logicalJobId,
          stepId: pipelineAgent.stepId,
          attempt: pipelineAgent.attempt,
          iteration: pipelineAgent.iteration,
          agentSessionId: pipelineAgent.agentSessionId,
          ...(pipelineAgent.predecessorAgentSessionId === undefined
            ? {}
            : {
                predecessorAgentSessionId:
                  pipelineAgent.predecessorAgentSessionId,
              }),
          ...(pipelineAgent.checkpointId === undefined
            ? {}
            : { checkpointId: pipelineAgent.checkpointId }),
        },
        ...(pipelineAgent.secretValues === undefined
          ? {}
          : { secretValues: pipelineAgent.secretValues }),
      };
    }
    const delegate = this.options.delegate;
    if (delegate === undefined) {
      return {
        container,
        containerCreatedAt,
        actor: { kind: 'chat', originKey: chatId, displayName: chatName },
        role: 'interactive_chat',
        authorDetails,
        runtimeGeneration: this.runtimeGeneration,
      };
    }
    const parent = delegate.parent;
    return {
      container,
      containerCreatedAt,
      actor: {
        kind: 'managed_delegation',
        originKey: delegate.delegationId,
        displayName:
          nonBlank(delegate.description) ?? DEFAULT_DELEGATE_DISPLAY_NAME,
      },
      role: 'managed_delegation',
      authorDetails,
      runtimeGeneration: delegate.runGeneration,
      origin: {
        kind: 'managed_delegation',
        delegationId: delegate.delegationId,
        parent:
          parent.kind === 'chat'
            ? { kind: 'chat', originKey: chatId, displayName: chatName }
            : {
                kind: 'managed_delegation',
                originKey: parent.delegationId,
                displayName:
                  nonBlank(parent.description) ?? DEFAULT_DELEGATE_DISPLAY_NAME,
              },
        root: { kind: 'chat', chatId },
        runGeneration: delegate.runGeneration,
      },
    };
  }

  /**
   * Disposed, or a delegate whose run stopped or was released, or a pipeline
   * agent whose attempt settled or paused. Checked as a call starts, after
   * the reads it awaits and again just before its dispatch, so a call in
   * flight when the run stops reaches no Ledger operation.
   */
  private hasEnded(): boolean {
    return this.disposed || !this.callerIsLive();
  }

  /**
   * A chat session is live until disposed; a delegate's run or a pipeline
   * agent's attempt can end sooner.
   */
  private callerIsLive(): boolean {
    const caller = this.options.delegate ?? this.options.pipelineAgent;
    if (caller === undefined) return true;
    try {
      return caller.isLive();
    } catch {
      return false;
    }
  }

  private authorDetails(): LedgerAuthorDetails {
    let settings: LedgerChatSettings;
    try {
      settings = this.options.readSettings();
    } catch {
      settings = { model: null, thinkingEffort: null, planMode: false };
    }
    return {
      harness: this.options.harness,
      model: boundedSetting(settings.model),
      thinkingEffort: boundedSetting(settings.thinkingEffort),
      mode:
        boundedSetting(settings.mode ?? null) ??
        (settings.planMode ? 'plan' : 'default'),
      pipelineExecutionId: this.options.pipelineAgent?.executionId ?? null,
      // Chats have no settings revision to record.
      settingsRevision: null,
      unavailableReason: null,
    };
  }

  private errorResult(
    error: unknown,
    site: { readonly mode: 'command' | 'query'; readonly explicitKey: boolean },
  ): CanopyInjectedToolTextResult {
    return ledgerErrorResult(error, site, this.selfActorId);
  }
}

/**
 * Runs a Ledger tool for `executeCanopyInjectedTool`. A session without Ledger
 * tools (the gate failed when it started) answers that the Ledger is
 * unavailable, which also covers a resumed Codex thread that kept tools the
 * current session did not advertise.
 */
export function executeLedgerInjectedTool(
  key: LedgerToolKey,
  rawArgs: unknown,
  runtime: LedgerToolsRuntime | undefined,
  invocation?: LedgerToolInvocation,
): Promise<CanopyInjectedToolTextResult> {
  if (runtime === undefined) {
    return Promise.resolve(ledgerUnavailableResult('no_ledger_scope'));
  }
  return runtime.execute(key, rawArgs, invocation);
}

/** The result a Ledger tool returns when the Ledger is unavailable. */
export function ledgerUnavailableResult(
  reason: LedgerToolsUnavailableReason,
): CanopyInjectedToolTextResult {
  return {
    text: JSON.stringify({
      ok: false,
      error: {
        code: 'FEED_UNAVAILABLE',
        reason,
        message: UNAVAILABLE_MESSAGES[reason],
      },
    }),
    isError: true,
  };
}

function callerFor(bindingId: string): CanopyCallerDescriptor {
  return {
    principalId: bindingId,
    clientInstanceId: 'desktop-main',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    // A trusted in-process host call, as other main-process callers make;
    // the agent's own transport (MCP or Codex dynamic tools) stays upstream.
    interfaceKind: 'daemon',
    grants: [LEDGER_GRANTS.read, LEDGER_GRANTS.write],
  };
}

function nonBlank(value: string | null): string | null {
  return value !== null && value.trim().length > 0 ? value : null;
}

function boundedSetting(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return Array.from(trimmed).slice(0, SETTING_VALUE_MAX_CODE_POINTS).join('');
}

function parseToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  rawArgs: unknown,
  toolName: string,
): ParsedArgs<z.output<Schema>> {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (parsed.success) return { success: true, data: parsed.data };
  const details = parsed.error.issues.slice(0, 5).map((issue): string => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
    return `${path}: ${issue.message}`;
  });
  return {
    success: false,
    result: {
      text: [
        `Invalid arguments for ${toolName}.`,
        ...details.map((line) => `- ${line}`),
      ].join('\n'),
      isError: true,
    },
  };
}

function digestAssignments(result: LedgerEntriesSearchResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        result.entries.map((entry) => [entry.entryId, entry.revision]),
        result.hasMore,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
}

interface LedgerActorView {
  readonly actorId: string;
  readonly kind: LedgerActorKind;
  readonly isSelf?: true;
}

interface LedgerEntryView {
  readonly entryId: string;
  readonly revision: number;
  readonly type: LedgerEntryType;
  readonly status: LedgerStatus;
  readonly title: string;
  readonly content?: string;
  readonly highlights?: readonly string[];
  readonly referenceFiles?: readonly LedgerFileRef[];
  readonly owner: LedgerActorView;
  readonly author?: LedgerActorView;
  readonly attribution?: LedgerAttributionKind;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly supersedesEntryId?: string;
  readonly parentEntryId?: string;
  readonly source?: LedgerSourceAvailability;
}

function projectActor(
  actor: LedgerActorRef,
  selfActorId: string | null,
): LedgerActorView {
  return actor.actorId === selfActorId
    ? { actorId: actor.actorId, kind: actor.kind, isSelf: true }
    : { actorId: actor.actorId, kind: actor.kind };
}

function toDelegationFeedEntrySnapshot(
  entry: LedgerEntrySearchItem,
): LedgerDelegationFeedEntrySnapshot {
  return {
    entryId: entry.entryId,
    revision: entry.revision,
    type: entry.type,
    status: entry.status,
    ownerActorId: entry.owner.actorId,
    ...(entry.parentEntryId === undefined
      ? {}
      : { parentEntryId: entry.parentEntryId }),
  };
}

/** A receipt's entry, without the content its author just wrote. */
function projectEntry(
  entry: LedgerEntry,
  selfActorId: string | null,
): LedgerEntryView {
  return {
    entryId: entry.entryId,
    revision: entry.revision,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    owner: projectActor(entry.owner, selfActorId),
    updatedAt: entry.updatedAt,
    ...(entry.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: entry.supersedesEntryId }),
    ...(entry.parentEntryId === undefined
      ? {}
      : { parentEntryId: entry.parentEntryId }),
  };
}

function projectSearchItem(
  item: LedgerEntrySearchItem,
  selfActorId: string | null,
): LedgerEntryView {
  return {
    entryId: item.entryId,
    revision: item.revision,
    type: item.type,
    status: item.status,
    title: item.title,
    content: item.content,
    ...(item.highlights.length > 0 ? { highlights: item.highlights } : {}),
    ...(item.referenceFiles.length > 0
      ? { referenceFiles: item.referenceFiles }
      : {}),
    owner: projectActor(item.owner, selfActorId),
    author: projectActor(item.author, selfActorId),
    attribution: item.attributionKind,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: item.supersedesEntryId }),
    ...(item.parentEntryId === undefined
      ? {}
      : { parentEntryId: item.parentEntryId }),
    ...(item.sourceAvailability === 'available'
      ? {}
      : { source: item.sourceAvailability }),
  };
}

interface LedgerOwnerView {
  readonly actorId: string;
  readonly kind: LedgerActorKind;
  readonly displayName: string;
  readonly eligibilityToken: string;
  readonly isSelf: boolean;
}

function projectOwners(page: LedgerOwnerCandidatePage): {
  readonly candidates: readonly LedgerOwnerView[];
  readonly nextCursor: string | null;
} {
  return {
    candidates: page.candidates.map(
      (candidate): LedgerOwnerView => ({
        actorId: candidate.actor.actorId,
        kind: candidate.actor.kind,
        displayName: candidate.displayName,
        eligibilityToken: candidate.eligibilityToken,
        isSelf: candidate.isSelf,
      }),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * A bounded search result: entry projections without provenance detail, and
 * the owner page when requested. Entries past the size budget are dropped
 * from the end with a note, and the cursor with them, so nothing is skipped.
 */
function formatSearchResult(
  result: LedgerEntriesSearchResult,
  selfActorId: string | null,
): string {
  const entries = result.entries.map((item) =>
    projectSearchItem(item, selfActorId),
  );
  const owners =
    result.owners === undefined ? undefined : projectOwners(result.owners);
  const render = (shown: readonly LedgerEntryView[], omitted: number): string =>
    JSON.stringify({
      entries: shown,
      nextCursor: omitted > 0 ? null : result.nextCursor,
      hasMore: result.hasMore || omitted > 0,
      watermark: result.watermark,
      ...(omitted > 0
        ? {
            omittedEntries: omitted,
            note: 'Some entries were left out to keep this result small. Repeat the search with a smaller limit to see them.',
          }
        : {}),
      ...(owners === undefined ? {} : { owners }),
    });
  let shown = entries;
  let text = render(shown, 0);
  while (text.length > MAX_RESULT_CHARACTERS && shown.length > 0) {
    shown = shown.slice(0, Math.max(0, Math.floor(shown.length * 0.75)));
    text = render(shown, entries.length - shown.length);
  }
  return text;
}

function readLedgerErrorDetails(
  payload: CanopyErrorPayload,
): LedgerErrorDetails | null {
  const parsed = LedgerErrorDetailsSchema.safeParse(payload.details);
  return parsed.success ? parsed.data : null;
}

function errorResult(
  code: string,
  message: string,
  extra: {
    readonly currentEntry?: LedgerEntryView;
    readonly openChildEntryIds?: readonly string[];
  } = {},
): CanopyInjectedToolTextResult {
  return {
    text: JSON.stringify({
      ok: false,
      error: { code, message },
      ...(extra.currentEntry === undefined
        ? {}
        : { currentEntry: extra.currentEntry }),
      ...(extra.openChildEntryIds === undefined
        ? {}
        : { openChildEntryIds: extra.openChildEntryIds }),
    }),
    isError: true,
  };
}

/**
 * Maps a Ledger failure to a short result the model can act on. A command
 * whose outcome is unknown points at a search (or the same requestKey)
 * instead of a blind retry that could duplicate the entry.
 */
function ledgerErrorResult(
  error: unknown,
  site: { readonly mode: 'command' | 'query'; readonly explicitKey: boolean },
  selfActorId: string | null,
): CanopyInjectedToolTextResult {
  const outcomeUnknown =
    site.mode === 'query'
      ? 'The Feed search failed. Try again later.'
      : site.explicitKey
        ? 'The change may or may not have been saved. Retry later with the same requestKey.'
        : 'The change may or may not have been saved. Search for the entry before trying again.';
  if (!(error instanceof CanopyOperationError)) {
    return errorResult('FEED_FAILED', outcomeUnknown);
  }
  const payload = error.payload;
  const details = readLedgerErrorDetails(payload);
  switch (details?.reason) {
    case 'WRITER_UNAVAILABLE':
    case 'UNSUPPORTED_SCHEMA':
      return errorResult(
        details.reason,
        'The Feed is not available right now. Continue without recording.',
      );
    case 'NOT_FOUND':
      return errorResult(
        details.reason,
        "No entry with that ID is in this chat's Feed. Search to find the right entry.",
      );
    case 'FORBIDDEN':
      // `owner` is the one permission an agent can act on; every other
      // field names a binding or scope this chat cannot use.
      return errorResult(
        details.reason,
        details.field === 'owner'
          ? 'Only the current owner of an entry can change it. Leave it to its owner, or ask the user.'
          : 'The Feed is not available to this chat. Continue without recording.',
      );
    case 'TERMINAL_ENTRY':
      return errorResult(
        details.reason,
        'That entry is Completed, Failed or Info and cannot change. To correct it, add a new entry with supersedesEntryId set to it.',
        details.currentEntry === undefined
          ? {}
          : { currentEntry: projectEntry(details.currentEntry, selfActorId) },
      );
    case 'REVISION_CONFLICT': {
      const current = details.currentEntry;
      return errorResult(
        details.reason,
        current === undefined
          ? 'The entry changed since you read it. Search for its current revision and reconsider the change instead of overwriting it.'
          : `The entry changed since you read it and is now at revision ${current.revision}. Reconsider the change against the current entry; if it still applies, retry with expectedRevision ${current.revision}.`,
        current === undefined
          ? {}
          : { currentEntry: projectEntry(current, selfActorId) },
      );
    }
    case 'OWNER_UNAVAILABLE':
      return errorResult(
        details.reason,
        'That owner can no longer be assigned. Search with includeAssignableOwners set to true for current owners and eligibility tokens.',
      );
    case 'PARENT_INVALID':
      return errorResult(
        details.reason,
        'That parent cannot contain this entry. Search the Feed and choose a valid open Operation or Task, or set parentEntryId to null when updating to leave the entry at top level (omit parentEntryId when adding).',
      );
    case 'PARENT_CLOSED':
      return errorResult(
        details.reason,
        'That parent is closed. Search the Feed and choose an open parent, or set parentEntryId to null when updating to detach the entry (omit parentEntryId when adding).',
      );
    case 'OPEN_CHILDREN':
      return errorResult(
        details.reason,
        'This entry has open children. Review openChildEntryIds and retry with openChildren set to "complete", "fail" or "detach".',
        details.openChildEntryIds === undefined
          ? {}
          : { openChildEntryIds: details.openChildEntryIds },
      );
    case 'SCOPE_RETIRED':
      return errorResult(
        details.reason,
        'This Feed no longer accepts changes. Continue without recording.',
      );
    case 'IDEMPOTENCY_KEY_REUSED':
      return errorResult(
        details.reason,
        'That requestKey was already used for a different request. Use a new requestKey; to check the earlier request, search for its entry.',
      );
    case 'CURSOR_EXPIRED':
      return errorResult(
        details.reason,
        `The ${details.field ?? 'cursor'} expired. Repeat the search without it.`,
      );
    case 'INVALID_INPUT':
      return errorResult(
        details.reason,
        details.field === undefined
          ? 'The Feed request is invalid.'
          : `The Feed request is invalid: ${details.field}${details.limit === undefined ? '' : ` (limit ${details.limit})`}.`,
      );
    case 'STORAGE_UNAVAILABLE':
    case 'RATE_LIMITED':
      return errorResult(
        details.reason,
        site.mode === 'query'
          ? 'The Feed is busy or unavailable. Try the search again later.'
          : outcomeUnknown,
      );
    case undefined:
      break;
  }
  switch (payload.kind) {
    case 'invalid_argument':
      return errorResult('INVALID_INPUT', 'The Feed request is invalid.');
    case 'capability_unavailable':
    case 'permission_denied':
    case 'unauthenticated':
      return errorResult(
        'FEED_UNAVAILABLE',
        'The Feed is not available right now. Continue without recording.',
      );
    default:
      return errorResult('FEED_FAILED', outcomeUnknown);
  }
}
