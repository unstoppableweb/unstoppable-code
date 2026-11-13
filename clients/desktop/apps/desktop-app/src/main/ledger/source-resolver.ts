import { join } from 'node:path';
import type {
  LedgerOrigin,
  LedgerSourceAvailability,
} from '@canopy/protocol/canopy-core';
import {
  isLedgerTaskViewScope,
  type LedgerTaskViewScope,
  type LedgerViewScope,
  type LedgerViewSource,
  type LedgerViewSummarySnapshot,
} from '@canopy/protocol/ledger-view';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import { readChatArchivesFile } from '../lib/chat-archives';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { getDataDir } from '../lib/paths';
import { readWorktreeSummaryFile } from '../lib/worktree-summary-persistence';
import type { LedgerSourceAvailabilityRequest } from './service';
import { ledgerViewScopeForContainer } from './view-scope';

/*
 * Source resolution for Ledger views (phase 10). An entry stores only logical
 * origin IDs; this decides, when the entry is read, whether this device still
 * has that source and where it opens. Opening is the renderer's job, and it
 * never starts, resumes or restores anything.
 */

/** Whether a chat is a live tab, an archived chat, or gone. */
export type LedgerChatPresence = 'live' | 'archived' | 'missing';

/**
 * A pipeline execution this device still keeps, and where it ran: a global
 * or directory run has no worktree, and a global one no project either.
 */
export interface LedgerKeptExecution {
  readonly projectId?: string;
  readonly worktreeId?: string;
}

/** What resolution reads; tests substitute their own. */
export interface LedgerSourceHost {
  /**
   * A host for one page of reads, free to read each store once for the whole
   * page. Omitted, every read of the page goes through this host.
   */
  readonly forPage?: () => LedgerSourceHost;
  readonly chatPresence: (
    scope: LedgerTaskViewScope,
    chatId: string,
  ) => Promise<LedgerChatPresence>;
  /** Null when the execution is no longer kept. */
  readonly keptExecution: (
    executionId: string,
  ) => Promise<LedgerKeptExecution | null>;
  /**
   * The App Advisor work entry holding a chat, or null. App Advisor records
   * entries in other work's Feed as its own chat (CAN-6007), so a chat the
   * entry's own scope doesn't have may be one of its chats.
   */
  readonly advisorChatScope?: (
    chatId: string,
  ) => Promise<LedgerTaskViewScope | null>;
  /** Null when the scope's summary history no longer holds the snapshot. */
  readonly summarySnapshot: (
    scope: LedgerTaskViewScope,
    snapshotId: string,
  ) => Promise<LedgerViewSummarySnapshot | null>;
}

/** Execution IDs are host-minted; anything else is never used as a path. */
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A scope's live and archived chat IDs, each store read at most once. */
interface ChatPresenceIndex {
  readonly live: Promise<ReadonlySet<string>>;
  archived: Promise<ReadonlySet<string>> | null;
}

async function readLiveChatIds(
  scope: LedgerTaskViewScope,
): Promise<ReadonlySet<string>> {
  // Metadata only: no transcript is selected.
  const tabs = await readChatTabsFile(scope.projectId, scope.worktreeId);
  return new Set(
    tabs.tabs.filter((tab) => tab.kind !== 'file').map((tab) => tab.id),
  );
}

async function readArchivedChatIds(
  scope: LedgerTaskViewScope,
): Promise<ReadonlySet<string>> {
  const archives = await readChatArchivesFile(
    scope.projectId,
    scope.worktreeId,
  );
  return new Set(archives.archived.map((entry) => entry.tab.id));
}

/**
 * Reads chat presence, keeping what it read: a scope's tabs are read once,
 * and its archives once, only when a chat is not a live tab.
 */
function createChatPresenceReader(): LedgerSourceHost['chatPresence'] {
  const scopes = new Map<string, ChatPresenceIndex>();
  return async (scope, chatId): Promise<LedgerChatPresence> => {
    const key = JSON.stringify([scope.projectId, scope.worktreeId]);
    let index = scopes.get(key);
    if (index === undefined) {
      index = { live: readLiveChatIds(scope), archived: null };
      scopes.set(key, index);
    }
    if ((await index.live).has(chatId)) return 'live';
    index.archived ??= readArchivedChatIds(scope);
    return (await index.archived).has(chatId) ? 'archived' : 'missing';
  };
}

function readChatPresence(
  scope: LedgerTaskViewScope,
  chatId: string,
): Promise<LedgerChatPresence> {
  return createChatPresenceReader()(scope, chatId);
}

async function readKeptExecution(
  executionId: string,
): Promise<LedgerKeptExecution | null> {
  if (!SAFE_EXECUTION_ID.test(executionId)) return null;
  const state = await loadExecutionState(
    executionId,
    join(getDataDir(), 'pipeline-executions'),
  );
  if (state === null) return null;
  return {
    ...(state.project_id === undefined ? {} : { projectId: state.project_id }),
    ...(state.worktree_id === undefined
      ? {}
      : { worktreeId: state.worktree_id }),
  };
}

async function readSummarySnapshot(
  scope: LedgerTaskViewScope,
  snapshotId: string,
): Promise<LedgerViewSummarySnapshot | null> {
  const file = await readWorktreeSummaryFile(scope.projectId, scope.worktreeId);
  const snapshot = file?.history.find(
    (candidate) => candidate.snapshotId === snapshotId,
  );
  if (snapshot === undefined) return null;
  return {
    title: snapshot.summary.title,
    description: snapshot.summary.description,
    highlights: [...snapshot.summary.highlights],
    generatedAt: snapshot.summary.generatedAt,
  };
}

async function readAdvisorChatScope(
  chatId: string,
): Promise<LedgerTaskViewScope | null> {
  const { resolveWorkEntryForChat } =
    await import('../lib/cowork-work-entries');
  const { entryId, archivedInEntryId } = await resolveWorkEntryForChat(
    APP_ADVISOR_PROJECT_ID,
    chatId,
  );
  const entry = entryId ?? archivedInEntryId;
  return entry === null
    ? null
    : { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: entry };
}

/** Reads each chat's App Advisor work entry once for a page. */
function createAdvisorChatScopeReader(): NonNullable<
  LedgerSourceHost['advisorChatScope']
> {
  const scopes = new Map<string, Promise<LedgerTaskViewScope | null>>();
  return (chatId) => {
    let scope = scopes.get(chatId);
    if (scope === undefined) {
      scope = readAdvisorChatScope(chatId);
      scopes.set(chatId, scope);
    }
    return scope;
  };
}

export const DESKTOP_LEDGER_SOURCE_HOST: LedgerSourceHost = {
  chatPresence: readChatPresence,
  keptExecution: readKeptExecution,
  advisorChatScope: readAdvisorChatScope,
  summarySnapshot: readSummarySnapshot,
  forPage: (): LedgerSourceHost => ({
    chatPresence: createChatPresenceReader(),
    keptExecution: readKeptExecution,
    advisorChatScope: createAdvisorChatScopeReader(),
    summarySnapshot: readSummarySnapshot,
  }),
};

async function chatSource(
  scope: LedgerTaskViewScope,
  chatId: string,
  delegationId: string | undefined,
  host: LedgerSourceHost,
): Promise<LedgerViewSource> {
  const presence = await host.chatPresence(scope, chatId);
  if (presence === 'missing') return { availability: 'deleted', target: null };
  return {
    availability: presence === 'live' ? 'available' : 'archived',
    target: {
      kind: 'chat',
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId,
      archived: presence === 'archived',
      ...(delegationId === undefined ? {} : { delegationId }),
    },
  };
}

async function pipelineSource(
  executionId: string,
  attempt: {
    readonly jobId: string;
    readonly stepId: string;
    readonly attempt: number;
  } | null,
  host: LedgerSourceHost,
): Promise<LedgerViewSource> {
  const kept = await host.keptExecution(executionId);
  // Pruned runs leave nothing to open but the entry itself.
  if (kept === null) return { availability: 'expired', target: null };
  return {
    availability: 'available',
    target: {
      kind: 'pipeline',
      ...(kept.projectId === undefined ? {} : { projectId: kept.projectId }),
      ...(kept.worktreeId === undefined ? {} : { worktreeId: kept.worktreeId }),
      executionId,
      ...(attempt === null ? {} : attempt),
    },
  };
}

/**
 * Where an entry's source opens from this scope, read now. A user's entry has
 * no source to open; a Summary entry opens the snapshot it recorded, never the
 * latest summary. A global (workflow) Ledger has no chats or summaries, so
 * only its pipeline runs open. Rejects when the stores cannot be read.
 */
export async function resolveLedgerViewSource(
  scope: LedgerViewScope,
  origin: LedgerOrigin,
  host: LedgerSourceHost = DESKTOP_LEDGER_SOURCE_HOST,
): Promise<LedgerViewSource> {
  const task = isLedgerTaskViewScope(scope) ? scope : null;
  switch (origin.kind) {
    case 'user':
      return { availability: 'available', target: null };
    case 'chat': {
      if (task === null) return { availability: 'deleted', target: null };
      const source = await chatSource(task, origin.chatId, undefined, host);
      if (
        source.availability !== 'deleted' ||
        host.advisorChatScope === undefined
      )
        return source;
      const advisor = await host.advisorChatScope(origin.chatId);
      return advisor === null ||
        (advisor.projectId === task.projectId &&
          advisor.worktreeId === task.worktreeId)
        ? source
        : chatSource(advisor, origin.chatId, undefined, host);
    }
    case 'managed_delegation':
      if (origin.root.kind !== 'chat') {
        return pipelineSource(origin.root.executionId, null, host);
      }
      return task === null
        ? { availability: 'deleted', target: null }
        : chatSource(task, origin.root.chatId, origin.delegationId, host);
    case 'pipeline_agent':
      return pipelineSource(
        origin.executionId,
        {
          jobId: origin.physicalJobId,
          stepId: origin.stepId,
          attempt: origin.attempt,
        },
        host,
      );
    case 'summary': {
      if (task === null) return { availability: 'expired', target: null };
      const snapshot = await host.summarySnapshot(task, origin.snapshotId);
      return snapshot === null
        ? { availability: 'expired', target: null }
        : { availability: 'available', target: { kind: 'summary', snapshot } };
    }
  }
}

/** The chat an origin's source opens in, or null when it opens elsewhere. */
function sourceChatIdOfOrigin(origin: LedgerOrigin): string | null {
  switch (origin.kind) {
    case 'chat':
      return origin.chatId;
    case 'managed_delegation':
      return origin.root.kind === 'chat' ? origin.root.chatId : null;
    case 'pipeline_agent':
    case 'summary':
    case 'user':
      return null;
  }
}

/** The page host of each read in flight, dropped with its page. */
const PAGE_HOSTS = new WeakMap<
  object,
  Map<LedgerSourceHost, LedgerSourceHost>
>();

function pageHostFor(page: object, host: LedgerSourceHost): LedgerSourceHost {
  let hosts = PAGE_HOSTS.get(page);
  if (hosts === undefined) {
    hosts = new Map();
    PAGE_HOSTS.set(page, hosts);
  }
  let pageHost = hosts.get(host);
  if (pageHost === undefined) {
    pageHost = host.forPage?.() ?? host;
    hosts.set(host, pageHost);
  }
  return pageHost;
}

/**
 * The Ledger service's availability override: where a source can be opened,
 * read now, in the scope's current container. An entry read resolves its
 * whole source. A search item resolves only a chat, its own or the one that
 * started its delegate, so a list can say that chat is archived or gone: a
 * page reads the scope's chats once, and never a pipeline run or a summary.
 * An unreadable store keeps the stored value.
 */
export async function resolveDesktopLedgerSourceAvailability(
  request: LedgerSourceAvailabilityRequest,
  host: LedgerSourceHost = DESKTOP_LEDGER_SOURCE_HOST,
): Promise<LedgerSourceAvailability> {
  const scope = ledgerViewScopeForContainer(
    request.scope.container,
    request.scope.ledgerId,
  );
  try {
    if (request.subject.kind === 'entry') {
      const source = await resolveLedgerViewSource(
        scope,
        request.subject.entry.origin,
        host,
      );
      return source.availability;
    }
    // A chat's own entries may be App Advisor's, whose chat is elsewhere.
    if (
      request.subject.origin.kind === 'chat' &&
      isLedgerTaskViewScope(scope)
    ) {
      const source = await resolveLedgerViewSource(
        scope,
        request.subject.origin,
        pageHostFor(request.page, host),
      );
      return source.availability;
    }
    const chatId = sourceChatIdOfOrigin(request.subject.origin);
    if (chatId === null || !isLedgerTaskViewScope(scope)) {
      return request.stored;
    }
    const presence = await pageHostFor(request.page, host).chatPresence(
      scope,
      chatId,
    );
    switch (presence) {
      case 'live':
        return 'available';
      case 'archived':
        return 'archived';
      case 'missing':
        return 'deleted';
    }
  } catch {
    return request.stored;
  }
}
