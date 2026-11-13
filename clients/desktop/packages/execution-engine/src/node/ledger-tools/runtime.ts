import { createHash, randomUUID } from 'node:crypto';
import {
  type LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_LIMITS,
  type LEDGER_QUERY_DEFINITIONS,
  LedgerAddEntryToolInputSchema,
  LedgerErrorDetailsSchema,
  LedgerSearchEntriesToolInputSchema,
  LedgerUpdateEntryToolInputSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type LedgerAuthorDetails,
  type LedgerCommandReceipt,
  type LedgerContainer,
  type LedgerEntriesSearchResult,
  type LedgerEntry,
  type LedgerEntryUpdateResult,
  type LedgerEntrySearchItem,
  type LedgerEntryType,
  type LedgerErrorDetails,
  type LedgerOwnerCandidatePage,
  type LedgerOwnerTarget,
  type LedgerSearchEntriesToolInput,
  type LedgerStatus,
  type LedgerToolFailureSite,
  type LedgerToolTextResult,
  type LedgerToolsUnavailableReason,
  type LedgerWorkSummaryGetResult,
  LEDGER_TOOLS_UNAVAILABLE_MESSAGES,
  ledgerCommandResult,
  ledgerFailureResult,
  ledgerOpenOperationsHint,
  ledgerSearchResult,
  ledgerUnavailableResult,
  parseLedgerToolArgs,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import type { CanopyInjectedToolKey } from '../../lib/canopy-injected-tools';
import {
  ledgerToolNames,
  type LedgerToolNames,
} from '../../lib/ledger-tools/prompt';
import type { AssistantMode } from '../../types/assistant-mode';
import type { WorkspaceType } from '../../types/workspace-type';
import type { LedgerCallerBindingRegistration } from './caller-bindings';

/*
 * The Feed (Agent Ledger) tools runtime: AddFeedEntry, SearchFeedEntries and
 * UpdateFeedEntry for one provider session (a chat, a managed delegate's run
 * or a pipeline agent's attempt). It turns each tool call into `core.ledger.*`
 * operations on its host's dispatcher, as the caller its host binds, and
 * renders the result. Scope, actor, author details and time come from that
 * binding, never from tool arguments; the protocol tool schemas reject
 * unknown keys.
 *
 * Hosts supply the dispatcher, the binding registry, the exposure gate's
 * reads and the prompt (`LedgerToolsHost`): Electron main on desktop
 * (`apps/desktop-app/src/main/canopy-tools/ledger-tools-runtime.ts`), and the
 * pipeline runner for cloud runs (CAN-6422).
 */

// The tool result shapes are the protocol's, shared with the cloud surface.
export {
  ledgerUnavailableResult,
  type LedgerToolTextResult,
  type LedgerToolsUnavailableReason,
} from '@canopy/protocol/canopy-core';

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
  ): Promise<LedgerToolTextResult>;
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

/** The Ledger operations a session dispatches, as its host serves them. */
export type LedgerToolsDispatcher = Pick<
  CanopyDispatcher<
    typeof LEDGER_QUERY_DEFINITIONS,
    typeof LEDGER_INSTRUCTION_DEFINITIONS
  >,
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
  /**
   * What the agent tools' calls go through: the host's table of the
   * operations agents are granted (CAN-4125), over its dispatcher.
   */
  readonly agentDispatcher: (
    dispatcher: LedgerToolsDispatcher,
  ) => LedgerToolsDispatcher;
  /** The caller a binding's calls are made as. */
  readonly caller: (bindingId: string) => CanopyCallerDescriptor;
  /** The Feed block of a session's system prompt. */
  readonly systemPrompt: (options: LedgerChatToolsSessionOptions) => string;
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

/** Open statuses: the ones an owner keeps current. */
const OPEN_LEDGER_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];
const DELEGATION_FEED_SUBTASK_LIMIT = 200;
const DELEGATION_FEED_AUTHORIZATION_BATCH_SIZE = 25;

/** Matches the dispatcher's request-metadata bound on idempotency keys. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 512;
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
  readonly host: LedgerToolsHost;
}

let lastRuntimeGeneration = 0;

type CallerResolution =
  | { readonly kind: 'caller'; readonly caller: CanopyCallerDescriptor }
  | {
      readonly kind: 'unavailable';
      readonly reason: LedgerToolsUnavailableReason;
    };

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
    this.host = options.host;
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
    return this.host.systemPrompt(this.options);
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
  ): Promise<LedgerToolTextResult> {
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
      throw new Error(LEDGER_TOOLS_UNAVAILABLE_MESSAGES[unavailable]);
    const dispatcher = this.agentDispatcher();
    if (dispatcher === null)
      throw new Error(
        LEDGER_TOOLS_UNAVAILABLE_MESSAGES.ledger_runtime_unavailable,
      );
    const resolution = await this.resolveCaller();
    if (resolution.kind !== 'caller')
      throw new Error(LEDGER_TOOLS_UNAVAILABLE_MESSAGES[resolution.reason]);
    if (this.hasEnded())
      throw new Error(LEDGER_TOOLS_UNAVAILABLE_MESSAGES.session_ended);
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
    return dispatcher === null ? null : this.host.agentDispatcher(dispatcher);
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
  ): Promise<LedgerToolTextResult> {
    const parsed = parseLedgerToolArgs(
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
  ): Promise<LedgerToolTextResult> {
    const parsed = parseLedgerToolArgs(
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
  ): Promise<LedgerToolTextResult> {
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
      return ledgerCommandResult(receipt, this.selfActorId, additionalLine);
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
      if (signal?.aborted) return undefined;
      return ledgerOpenOperationsHint(
        result.entries,
        result.hasMore,
        (this.options.toolNames ?? ledgerToolNames(this.options.harness))
          .search,
      );
    } catch {
      // The write already committed; a failed or cancelled hint is best effort.
      return undefined;
    }
  }

  private async searchEntries(
    rawArgs: unknown,
    invocation: LedgerToolInvocation,
  ): Promise<LedgerToolTextResult> {
    const parsed = parseLedgerToolArgs(
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
      return ledgerSearchResult(result, this.selfActorId);
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
        return { kind: 'caller', caller: this.host.caller(current.id) };
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
    return { kind: 'caller', caller: this.host.caller(id) };
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
  ): LedgerToolTextResult {
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
): Promise<LedgerToolTextResult> {
  if (runtime === undefined) {
    return Promise.resolve(ledgerUnavailableResult('no_ledger_scope'));
  }
  return runtime.execute(key, rawArgs, invocation);
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

function readLedgerErrorDetails(
  payload: CanopyErrorPayload,
): LedgerErrorDetails | null {
  const parsed = LedgerErrorDetailsSchema.safeParse(payload.details);
  return parsed.success ? parsed.data : null;
}

/**
 * Maps a Ledger failure to the protocol's tool result. A failure that is not
 * an operation error carries no refusal: its outcome is unknown.
 */
function ledgerErrorResult(
  error: unknown,
  site: LedgerToolFailureSite,
  selfActorId: string | null,
): LedgerToolTextResult {
  return ledgerFailureResult(
    error instanceof CanopyOperationError
      ? {
          details: readLedgerErrorDetails(error.payload),
          kind: error.payload.kind,
        }
      : null,
    site,
    selfActorId,
  );
}
