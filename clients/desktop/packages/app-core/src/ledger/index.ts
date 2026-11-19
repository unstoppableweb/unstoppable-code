import type { LedgerFileRef } from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedEntryRequest,
  LedgerFeedPage,
  LedgerFeedRequest,
  LedgerFeedWorkPage,
  LedgerFeedWorkRequest,
  LedgerTaskViewScope,
  LedgerViewAddRequest,
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewEntryRequest,
  LedgerViewFileCandidate,
  LedgerViewOpenResult,
  LedgerViewOwnerPage,
  LedgerViewOwnersRequest,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerViewScope,
  LedgerViewActorHost,
  LedgerViewSearchRequest,
  LedgerViewSourceTarget,
  LedgerViewUpdateRequest,
} from '@canopy/protocol/ledger-view';
import type { LedgerEntriesSearchResult } from '@canopy/protocol/canopy-core';
import type { RemoteControlQuestionControl } from '@canopy/protocol/remote-control/shell';
import type { Unsubscribe } from '../events/domain-events';

/**
 * The seam the shared Ledger views depend on. Desktop implements it over IPC
 * to `core.ledger.*`; the stores and components never see a transport. Every
 * call resolves, never rejects: failures arrive as {@link LedgerViewResult}
 * errors so a view can never mistake one for an empty Ledger or a saved
 * change.
 */
export interface LedgerClient {
  searchEntries(
    request: LedgerViewSearchRequest,
  ): Promise<LedgerViewResult<LedgerEntriesSearchResult>>;
  getEntry(
    request: LedgerViewEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>>;
  /** Adds an entry as the person using the view. */
  addEntry(
    request: LedgerViewAddRequest,
  ): Promise<LedgerViewResult<LedgerViewReceipt>>;
  /** Changes an entry's status or owner as the person using the view. */
  updateEntry(
    request: LedgerViewUpdateRequest,
  ): Promise<LedgerViewResult<LedgerViewReceipt>>;
  /** One page of the owners the person may assign. */
  listOwners(
    request: LedgerViewOwnersRequest,
  ): Promise<LedgerViewResult<LedgerViewOwnerPage>>;
  /** Committed changes, coalesced by the host. */
  subscribeChanges(
    handler: (event: LedgerViewChangedEvent) => void,
  ): Unsubscribe;
}

/**
 * Host navigation for Ledger sources. Opening never starts, resumes or
 * restores anything as a side effect; an unavailable target resolves with
 * a message instead.
 */
export interface LedgerNavigator {
  openSource(
    scope: LedgerViewScope,
    target: LedgerViewSourceTarget,
  ): Promise<LedgerViewOpenResult>;
  /**
   * Opens a reference file of the task in the file panel, at its line. A
   * global (workflow) scope has no files.
   */
  openFile(
    scope: LedgerTaskViewScope,
    file: LedgerFileRef,
  ): Promise<LedgerViewOpenResult>;
}

/**
 * Host file search for an entry's references: files under the scope's logical
 * roots, as root IDs and relative paths. Choosing one never uploads it. Only a
 * task has files; a global (workflow) scope is never searched.
 */
export interface LedgerFilePicker {
  searchFiles(
    scope: LedgerTaskViewScope,
    query: string,
    limit: number,
  ): Promise<readonly LedgerViewFileCandidate[]>;
}

/**
 * The global Feed's reads (LD03): the person's entries on every device and,
 * when asked, their teammates', merged with this device's own scopes. Like
 * {@link LedgerClient}, every call resolves; a failure is a result.
 */
export interface LedgerFeedClient {
  searchFeed(
    request: LedgerFeedRequest,
  ): Promise<LedgerViewResult<LedgerFeedPage>>;
  /** A row of another device or a teammate, read only. */
  getFeedEntry(
    request: LedgerFeedEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>>;
  /** This device's operations and top-level tasks with their rollups (L07). */
  listFeedWork(
    request: LedgerFeedWorkRequest,
  ): Promise<LedgerViewResult<LedgerFeedWorkPage>>;
}

// ---------------------------------------------------------------------------
// Feed variant E (L06, L12, L17): live agent state and in-place answers. A
// host offers them only with `capabilities.ledgerLiveAgentStates`; without
// it the Feed page shows its rows with no live state and no waits.
// ---------------------------------------------------------------------------

/** What an agent waits on the person for, in Needs you's order (L06). */
export const LEDGER_AGENT_WAIT_KINDS = [
  'question',
  'plan',
  'approval',
  'failed_run',
] as const;

export type LedgerAgentWaitKind = (typeof LEDGER_AGENT_WAIT_KINDS)[number];

/** One question of a pending question, as the chat shows it. */
export interface LedgerLiveQuestion {
  /** The question's own ID, when the agent gave one. */
  readonly id?: string;
  readonly header?: string;
  readonly question: string;
  readonly options: readonly string[];
  /** Parallel to `options`; absent when none has a description. */
  readonly optionDescriptions?: readonly string[];
  readonly multiSelect: boolean;
  /**
   * Whether a typed answer is accepted beside the options. The chat accepts
   * one unless the agent set `allowOther: false`.
   */
  readonly allowOther: boolean;
  /** The answer is a secret: typed masked, never shown back. */
  readonly secret: boolean;
  /** The agent's explicit control: options, or a typed field of this kind. */
  readonly control?: RemoteControlQuestionControl['control'];
  /** The question must be answered before the answers are sent. */
  readonly required?: boolean;
  /** Hint text for a typed answer. */
  readonly placeholder?: string;
}

/** The person's answer to one {@link LedgerLiveQuestion}. */
export interface LedgerLiveQuestionAnswer {
  readonly questionId?: string;
  readonly question: string;
  readonly selectedOptions: readonly string[];
  readonly freeformText?: string;
}

/**
 * One thing waiting on the person, read from the host's canonical state: a
 * chat's pending question, plan exit or tool approval, or a failed pipeline
 * run. Logical IDs only.
 */
export interface LedgerLiveWait {
  readonly kind: LedgerAgentWaitKind;
  /**
   * Stable per wait: the question's or plan exit's request ID, the approval's
   * ID, or the failed run's execution ID.
   */
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  /** The waiting chat; null for a pipeline run no chat started. */
  readonly chatId: string | null;
  /** The run's execution ID, for `failed_run`. */
  readonly executionId?: string;
  /**
   * The Ledger actor this wait belongs to, by the actor hosts the snapshot
   * was read for; null when none of them runs there.
   */
  readonly actorId: string | null;
  /**
   * One line naming the wait: the first question, the plan's first heading
   * or line, the tool asking for approval, or the pipeline's name.
   */
  readonly title: string;
  /** When it began waiting (ISO 8601); null when the host doesn't know. */
  readonly since: string | null;
  /** A pending question's questions, for answering in place. */
  readonly questions?: readonly LedgerLiveQuestion[];
  /** A plan's text (markdown), for reading in place. */
  readonly detail?: string;
}

/**
 * One actor's live state, projected from the host's canonical chat state
 * (L12). Never derived from tool inputs or transcript rows.
 */
export interface LedgerAgentLiveState {
  /**
   * `working`: a chat in a foreground turn, a running delegate or pipeline
   * run. `background`: no turn, but background tasks run. `waiting`: parked
   * on the person. `idle`: none of these.
   */
  readonly phase: 'working' | 'background' | 'waiting' | 'idle';
  /** Why it waits, the first in L06's order; null unless `waiting`. */
  readonly waitingOn: LedgerAgentWaitKind | null;
  /** Background tasks running (D11); 0 when none. */
  readonly backgroundTasks: number;
  /** The chat has unread output (D9). */
  readonly unread: boolean;
  /** The working chat's lag sample is fresh and catching up (desktop only). */
  readonly catchingUp: boolean;
  /**
   * The actor and every agent above it: its parent delegates and root chat, or
   * its pipeline run. Absent when the host doesn't track them (only desktop
   * does).
   */
  readonly ancestry?: LedgerAgentAncestryState;
}

/** Whether an actor's whole line of agents rests, and since when. */
export interface LedgerAgentAncestryState {
  /** None of them works, runs background tasks or waits on the person. */
  readonly idle: boolean;
  /**
   * When this host last saw one of them active (ISO 8601); absent when it
   * hasn't seen them active since it started watching.
   */
  readonly lastActiveAt?: string;
}

/** Live state for the Feed page: per actor, and everything waiting. */
export interface LedgerLiveSnapshot {
  /** By actor ID; an actor with no live session here is absent. */
  readonly agents: Readonly<Record<string, LedgerAgentLiveState>>;
  /**
   * Everything waiting on the person across this device's tasks, including
   * waits no Ledger actor owns (`actorId` null), in L06's kind order and
   * oldest first within a kind.
   */
  readonly waits: readonly LedgerLiveWait[];
}

/**
 * The host's live agent state for the Feed page, read through the same
 * stores and helpers as its sidebar, tabs and tray. `getSnapshot` returns the
 * same object while nothing it holds changed, so streaming never re-renders
 * the page; `subscribe` fires only when it would return a new one.
 */
export interface LedgerLiveStateSource {
  subscribe(listener: () => void): Unsubscribe;
  getSnapshot(
    actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
  ): LedgerLiveSnapshot;
}

/** A chat a Feed message goes to. */
export interface LedgerChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** The plan answers a waiting plan's chat offers, by the chat's own rules. */
export interface LedgerFeedPlanAnswers {
  /** **Yes, implement this plan**; when false it shows as unavailable. */
  readonly implement: boolean;
  /** **Run it as a workflow**. */
  readonly workflow: boolean;
}

/**
 * In-place answers (L17): each calls the path the chat and Agent activity
 * already use, never a Feed-only write, so the chat's own prompt clears too.
 * Every call resolves; a failure is `{ ok: false, message }`. There is no
 * stop or interrupt.
 */
export interface LedgerFeedAnswerActions {
  answerQuestion(
    wait: LedgerLiveWait,
    answers: readonly LedgerLiveQuestionAnswer[],
  ): Promise<LedgerViewOpenResult>;
  /** **Yes, implement this plan**. */
  approvePlan(wait: LedgerLiveWait): Promise<LedgerViewOpenResult>;
  /** A reply saying what to change; the plan is not approved. */
  rejectPlan(
    wait: LedgerLiveWait,
    reply: string,
  ): Promise<LedgerViewOpenResult>;
  /**
   * Which plan answers the plan's chat offers. Absent: approval and a reply
   * only, as a host without workflows offers.
   */
  planAnswers?(wait: LedgerLiveWait): LedgerFeedPlanAnswers;
  /**
   * **Run it as a workflow**: opens the plan's chat at its workflow picker,
   * where the person chooses and starts the workflow.
   */
  runPlanAsWorkflow?(wait: LedgerLiveWait): Promise<LedgerViewOpenResult>;
  /** **Retry** a failed run. */
  retryRun(wait: LedgerLiveWait): Promise<LedgerViewOpenResult>;
  /**
   * Sends to a chat as its composer would, queued while a turn runs.
   */
  sendMessage(
    target: LedgerChatTarget,
    text: string,
  ): Promise<LedgerViewOpenResult>;
  /** **Open chat** or **Open run**: navigates, starts nothing. */
  openWait(wait: LedgerLiveWait): Promise<LedgerViewOpenResult>;
  /** Opens a chat, such as a row owner's; starts nothing. */
  openChat(target: LedgerChatTarget): Promise<LedgerViewOpenResult>;
}
