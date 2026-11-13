import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  configureResumeQueue,
  getResumeQueue,
} from '../services/resume-queue-host';
import { resumeTargetKey } from '../services/resume-queue-service';
import { getAccountProxyStatus } from '../account-proxy/service';
import {
  readAccountProxyPipelineInterruptions,
  canResumeAccountProxyPipelineEntry,
} from '../account-proxy/pipeline-recovery';
import { isAccountProxyFlagEnabled } from '../account-proxy/feature-flag';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import {
  AccountProxyQuotaRecovery,
  type AccountProxyPipelineInterruption,
  canResumeAccountProxyChat,
  proxyQueueInterruption,
} from '../account-proxy/quota-recovery';
import { codexLoginManager } from '../auth/codex-login';
import { getChatQueueService } from '../services/chat-queue-service';
import type { BrowserWindow } from 'electron';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type WorkspaceIndexEntry,
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
  type ChatActiveSessions,
  type ChatTabsFile,
  type PersistedChatMessage,
  type ResumeQueueEntry,
  type ResumeQueueItem,
  type ResumeQueueControl,
  type ResumeQueueSnapshot,
  type UsageLimitedSessionTarget,
  type ListUsageLimitedIdleChatsRequest,
  type ListUsageLimitedIdleChatsResponse,
  type ListUsageLimitedIdleSessionsRequest,
  type ListUsageLimitedIdleSessionsResponse,
  type ResumeUsageLimitedChatsRequest,
  type ResumeUsageLimitedChatsResponse,
  type ResumeUsageLimitedSessionsRequest,
  type ResumeUsageLimitedSessionsResponse,
  type UsageLimitedChatGroup,
  type UsageLimitedChatEntry,
  type UsageLimitedChatTarget,
  type UsageLimitedSessionGroup,
  type UsageLimitedPipelineSessionItem,
} from '@canopy/desktop-shared/types';
import {
  buildTrustedAutoResume,
  claimTrustedChatResume,
} from '../lib/trusted-auto-resume';
import { describeUsageLimitResumePromptKind } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { describeLastAgentStep } from '@canopy/desktop-shared/lib/interrupted-chat-step';
import {
  buildUsageLimitedChatGroups,
  claimCodexAuthenticationResume,
  clearAuthenticationInterruptedChat,
  clearCodexAuthenticationResumeClaim,
  clearUsageLimitedChat,
  readUsageLimitedChats,
  suppressDismissedAccountProxyRecovery,
} from '../lib/usage-limited-chats-registry';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  capturePersistedUsageLimitBannerSnapshot,
  clearPersistedUsageLimitBanner,
  type PersistedUsageLimitBannerSnapshot,
} from '../lib/chat-usage-limit-cleanup';
import { getAllActiveSessionInfos } from '../agents/session-manager';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { readWorkEntriesFile } from '../lib/cowork-work-entries-file';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  buildExistingTabDispatchOptions,
  sendWorktreeChatMessage,
} from '../services/chat-service';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import {
  listExecutionSummaries,
  loadExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { isRealWorkspaceTarget } from '../lib/chat-targets';
import { getCodeReviewTarget } from '../lib/code-review-registry';
import type { ChatReadSelection } from '../services/chat-state-v2-backend';

export { isRealWorkspaceTarget } from '../lib/chat-targets';

function validateUsageLimitedChatTarget(target: UsageLimitedChatTarget): void {
  validateId(target.projectId, 'projectId');
  validateId(target.worktreeId, 'worktreeId');
  validateId(target.chatId, 'chatId');
}

interface ResumeWorkspace {
  entry: WorkspaceIndexEntry;
  worktreeNames: Map<string, string>;
  worktreePaths: Map<string, string>;
}

/** Keep the registry/queue identity while locating the chat's current storage. */
async function resolveResumeChatTarget(
  target: UsageLimitedChatTarget,
): Promise<UsageLimitedChatTarget | null> {
  if (target.projectId !== STANDALONE_CHAT_PROJECT_ID) return target;
  const projectId = resolveCoworkWorkspaceId(target.worktreeId);
  const { resolveWorkEntryForChat } =
    await import('../lib/cowork-work-entries');
  const owner = await resolveWorkEntryForChat(projectId, target.chatId);
  if (owner.archivedInEntryId && !owner.entryId) return null;
  return {
    projectId,
    worktreeId: owner.entryId ?? COWORK_HOME_WORKTREE_ID,
    chatId: target.chatId,
  };
}

async function requireResumeChatTarget(
  target: UsageLimitedChatTarget,
): Promise<UsageLimitedChatTarget> {
  const resolved = await resolveResumeChatTarget(target);
  if (!resolved)
    throw new Error('Restore this archived chat before resuming it.');
  return resolved;
}

async function readResumeChatTabsFile(
  target: UsageLimitedChatTarget,
  selection: ChatReadSelection,
): Promise<ChatTabsFile> {
  const resolved = await requireResumeChatTarget(target);
  return readChatTabsFile(resolved.projectId, resolved.worktreeId, selection);
}

type ResumeWorkspaceLookup = (
  projectId: string,
  worktreeId?: string,
  chatId?: string,
) => Promise<{
  entry: WorkspaceIndexEntry;
  worktreeName?: string;
  worktreePath?: string;
  chatTarget?: UsageLimitedChatTarget;
} | null>;

/** Metadata is shared within one listing, then reread on the next refresh. */
function createResumeWorkspaceLookup(): ResumeWorkspaceLookup {
  const workspaces = new Map<string, Promise<ResumeWorkspace | null>>();
  async function readWorkspace(
    workspaceId: string,
  ): Promise<ResumeWorkspace | null> {
    const entry = await readWorkspaceIndexEntry(workspaceId);
    if (!entry) return null;
    const worktreeNames = new Map<string, string>();
    const worktreePaths = new Map<string, string>();
    if (entry.type === 'cowork') {
      // The legacy home slot remains a readable chat scope after Work Entries
      // replace it; it is never listed in the Work Entry registry.
      worktreeNames.set(COWORK_HOME_WORKTREE_ID, '');
      const file = await readWorkEntriesFile(workspaceId);
      for (const workEntry of file.entries) worktreeNames.set(workEntry.id, '');
    } else {
      for (const worktree of await readWorkspaceWorktrees(workspaceId)) {
        worktreePaths.set(
          worktree.id,
          getWorkspaceWorktreeDir(workspaceId, worktree.id),
        );
        worktreeNames.set(
          worktree.id,
          worktree.label ?? worktree.branchName ?? worktree.id,
        );
      }
    }
    return { entry, worktreeNames, worktreePaths };
  }
  return async (projectId, worktreeId, chatId) => {
    const standaloneTarget =
      projectId === STANDALONE_CHAT_PROJECT_ID && worktreeId && chatId
        ? { projectId, worktreeId, chatId }
        : undefined;
    if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
      const target = worktreeId ? await getCodeReviewTarget(worktreeId) : null;
      if (!target) return null;
      projectId = target.projectId;
      worktreeId = target.worktreeId;
    } else if (projectId === STANDALONE_CHAT_PROJECT_ID) {
      if (!worktreeId) return null;
      projectId = resolveCoworkWorkspaceId(worktreeId);
      // Legacy directory pipelines belong to the workspace, not a Work Entry.
      worktreeId = undefined;
    }
    let pending = workspaces.get(projectId);
    if (!pending) {
      pending = readWorkspace(projectId);
      workspaces.set(projectId, pending);
    }
    const workspace = await pending;
    if (!workspace) return null;
    const chatTarget = standaloneTarget
      ? await resolveResumeChatTarget(standaloneTarget)
      : undefined;
    if (standaloneTarget && !chatTarget) return null;
    if (chatTarget) worktreeId = chatTarget.worktreeId;
    if (worktreeId && !workspace.worktreeNames.has(worktreeId)) return null;
    return {
      entry: workspace.entry,
      ...(chatTarget ? { chatTarget } : {}),
      worktreeName: worktreeId
        ? workspace.worktreeNames.get(worktreeId)
        : undefined,
      worktreePath: worktreeId
        ? workspace.worktreePaths.get(worktreeId)
        : undefined,
    };
  };
}

/**
 * Lists idle (no in-flight turn), real-workspace chats recorded for
 * account-change recovery (usage limits or authentication failures), grouped
 * by workspace.
 * Backs the account-change resume modal: display names/types and chat titles
 * are refreshed at read time rather than trusting the snapshot values
 * captured when the usage-limit was first detected. Only current workspaces
 * and work containers are eligible; retained records for archived work stay
 * intact for restoration. Chats whose tab no longer exists are pruned.
 */
export async function handleListUsageLimitedIdleChats(
  req: ListUsageLimitedIdleChatsRequest,
): Promise<ListUsageLimitedIdleChatsResponse> {
  validateIncludeResumePreview(req.includeResumePreview);
  const groups = await listUsageLimitedIdleChats(
    req,
    createResumeWorkspaceLookup(),
    createUsageLimitedListingReads(),
  );
  // The provider-account-change modal is exclusively native recovery.
  return groups
    .map((group) => ({
      ...group,
      chats: group.chats.filter((chat) => !chat.accountProxyConnectionId),
    }))
    .filter((group) => group.chats.length > 0);
}

function validateIncludeResumePreview(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean')
    throw new Error('includeResumePreview must be a boolean');
}

/**
 * Registry and chat-scope reads shared by every provider pass of one listing,
 * so an all-provider request reads each once. Like the workspace lookup, they
 * are discarded with the request.
 */
interface UsageLimitedListingReads {
  entries: () => ReturnType<typeof readUsageLimitedChats>;
  tabs: (projectId: string, worktreeId: string) => Promise<ChatTabsFile>;
  transcript: (
    target: UsageLimitedChatTarget,
  ) => Promise<PersistedChatMessage[] | undefined>;
}

function createUsageLimitedListingReads(): UsageLimitedListingReads {
  let entries: ReturnType<typeof readUsageLimitedChats> | undefined;
  const tabs = new Map<string, Promise<ChatTabsFile>>();
  const transcripts = new Map<
    string,
    Promise<PersistedChatMessage[] | undefined>
  >();
  return {
    entries: () => (entries ??= readUsageLimitedChats()),
    tabs: (projectId, worktreeId): Promise<ChatTabsFile> => {
      const key = `${projectId}\0${worktreeId}`;
      const pending = tabs.get(key) ?? readChatTabsFile(projectId, worktreeId);
      tabs.set(key, pending);
      return pending;
    },
    transcript: (target): Promise<PersistedChatMessage[] | undefined> => {
      const key = `${target.projectId}\0${target.worktreeId}\0${target.chatId}`;
      let pending = transcripts.get(key);
      if (!pending) {
        // The ordinary tabs projection is metadata-only. A latest page may
        // omit the current turn's earlier activity, so read the selected chat
        // in full through the same canonical reader used at dispatch.
        pending = readChatTabsFile(target.projectId, target.worktreeId, {
          chatIds: [target.chatId],
          fullTranscript: true,
        })
          .then(
            (file) =>
              file.tabs.find((tab) => tab.id === target.chatId)?.messages,
          )
          .catch(() => undefined);
        transcripts.set(key, pending);
      }
      return pending;
    },
  };
}

async function listUsageLimitedIdleChats(
  req: ListUsageLimitedIdleChatsRequest,
  lookupWorkspace: ResumeWorkspaceLookup,
  reads: UsageLimitedListingReads,
): Promise<ListUsageLimitedIdleChatsResponse> {
  const entries = await reads.entries();

  // Aggregate live sessions across every workspace so the group builder can
  // exclude chats with an active in-flight turn anywhere in the app, not just
  // within a single project/worktree.
  const sessions = getAllActiveSessionInfos();
  const activeSessions: ChatActiveSessions = {
    activeChatIds: sessions.map((session) => session.chatId),
    sessions,
  };

  const groups = buildUsageLimitedChatGroups(
    entries,
    req.provider,
    activeSessions,
    isRealWorkspaceTarget,
  );

  const refreshedGroups = new Map<string, UsageLimitedChatGroup>();
  for (const group of groups) {
    for (const chat of group.chats) {
      const context = await lookupWorkspace(
        chat.projectId,
        chat.worktreeId,
        chat.chatId,
      );
      if (!context) continue;
      const readTarget = context.chatTarget ?? chat;
      if (
        context.chatTarget &&
        sessions.some(
          (session) =>
            session.projectId === readTarget.projectId &&
            session.worktreeId === readTarget.worktreeId &&
            session.chatId === readTarget.chatId &&
            session.turnActive,
        )
      )
        continue;
      const tabsFile = await reads.tabs(
        readTarget.projectId,
        readTarget.worktreeId,
      );
      const tab = tabsFile.tabs.find(
        (candidate) => candidate.id === chat.chatId,
      );
      if (!tab) {
        // The container is current, but its chat tab was archived/deleted.
        void clearUsageLimitedChat(chat);
        continue;
      }
      // Home polls this listing for counts and dispatch re-reads it to
      // resolve targets; only the open resume dialog pays for full histories.
      const messages = req.includeResumePreview
        ? await reads.transcript(readTarget)
        : undefined;
      const resumePromptKind = messages
        ? describeUsageLimitResumePromptKind(messages)
        : undefined;
      const lastStep = messages
        ? describeLastAgentStep(messages, context.worktreePath)
        : undefined;
      const { entry, worktreeName } = context;
      let refreshed = refreshedGroups.get(entry.id);
      if (!refreshed) {
        refreshed = {
          workspaceId: entry.id,
          workspaceName: entry.name,
          workspaceType: entry.type,
          ...(entry.color ? { workspaceColor: entry.color } : {}),
          chats: [],
        };
        refreshedGroups.set(entry.id, refreshed);
      }
      refreshed.chats.push({
        ...chat,
        chatTitle: tab.title,
        worktreeName: worktreeName ?? chat.worktreeId,
        ...(resumePromptKind ? { resumePromptKind } : {}),
        ...(lastStep ? { lastStep } : {}),
      });
    }
  }
  return Array.from(refreshedGroups.values()).sort((a, b) =>
    a.workspaceName.localeCompare(b.workspaceName),
  );
}

export async function handleListUsageLimitedIdleSessions(
  req: ListUsageLimitedIdleSessionsRequest,
): Promise<ListUsageLimitedIdleSessionsResponse> {
  return (await listUsageLimitedIdleSessionsWithProviders(req)).groups;
}

type QueueProvider = NonNullable<ResumeQueueItem['providers']>[number];

async function listUsageLimitedIdleSessionsWithProviders(
  req: ListUsageLimitedIdleSessionsRequest,
): Promise<{
  groups: ListUsageLimitedIdleSessionsResponse;
  providersByExecution: Map<string, Map<string, QueueProvider>>;
}> {
  if (req.authenticationAttemptId)
    validateId(req.authenticationAttemptId, 'authenticationAttemptId');
  if (
    req.provider !== undefined &&
    req.provider !== 'claude' &&
    req.provider !== 'codex' &&
    req.provider !== 'ollama' &&
    req.provider !== 'cursor'
  ) {
    throw new Error('Provider must be claude, codex, ollama, or cursor');
  }
  validateIncludeResumePreview(req.includeResumePreview);
  const lookupWorkspace = createResumeWorkspaceLookup();
  const reads = createUsageLimitedListingReads();
  const chatGroups = (
    await Promise.all(
      (req.provider
        ? [req.provider]
        : (['claude', 'codex', 'ollama', 'cursor'] as const)
      ).map((provider) =>
        listUsageLimitedIdleChats(
          {
            provider,
            ...(req.includeResumePreview ? { includeResumePreview: true } : {}),
          },
          lookupWorkspace,
          reads,
        ),
      ),
    )
  ).flat();
  const groups = new Map<string, UsageLimitedSessionGroup>();
  for (const group of chatGroups) {
    const chats = group.chats.filter(
      (chat) =>
        (!req.provider || !chat.accountProxyConnectionId) &&
        (!req.resumeReason || chat.resumeReason === req.resumeReason) &&
        (!req.authenticationAttemptId ||
          chat.authenticationAttemptId === req.authenticationAttemptId),
    );
    const existingGroup = groups.get(group.workspaceId);
    groups.set(group.workspaceId, {
      groupId: group.workspaceId,
      groupKind: 'workspace',
      workspaceId: group.workspaceId,
      workspaceName: group.workspaceName,
      workspaceType: group.workspaceType,
      workspaceColor: group.workspaceColor,
      sessions: [
        ...(existingGroup?.sessions ?? []),
        ...chats.map((chat) => ({ ...chat, kind: 'chat' as const })),
      ],
    });
  }

  const runtime = createElectronExecutionRuntime();
  const summaries = await listExecutionSummaries(runtime.executionsDir);
  const providersByExecution = new Map<string, Map<string, QueueProvider>>();
  for (const summary of summaries) {
    if (
      (summary.status !== 'paused' && summary.status !== 'running') ||
      summary.hidden ||
      summary.parent_execution_id
    ) {
      continue;
    }
    const state = await loadExecutionState(
      summary.id,
      runtime.executionsDir,
    ).catch(() => null);
    if (!state) continue;
    const providersByReason = new Map<string, QueueProvider>();
    for (const reason of state.status_reasons) {
      if (reason.provider) providersByReason.set(reason.id, reason.provider);
    }
    providersByExecution.set(state.id, providersByReason);
    const matching = state.status_reasons.filter((reason) =>
      req.authenticationAttemptId
        ? state.authentication_pause?.attempt_id ===
            req.authenticationAttemptId &&
          state.authentication_pause.reason_ids.includes(reason.id)
        : reason.kind === 'app_shutdown' || reason.kind === 'provider_sign_in'
          ? !req.provider || reason.provider === req.provider
          : !req.resumeReason &&
            (reason.kind === 'provider_usage_limit' ||
              reason.kind === 'provider_authentication_required') &&
            (!req.provider || reason.provider === req.provider) &&
            reason.account_scope === 'native' &&
            (!req.provider || !reason.account_proxy_connection_id),
    );
    const executionCheckpoint =
      !req.provider &&
      state.status === 'paused' &&
      (!req.authenticationAttemptId ||
        state.authentication_pause?.attempt_id === req.authenticationAttemptId)
        ? state.shutdown_checkpoint
        : undefined;
    if (matching.length === 0 && !executionCheckpoint) continue;
    const workspace = state.project_id
      ? await lookupWorkspace(state.project_id, state.worktree_id)
      : null;
    if (state.project_id && !workspace) continue;
    const resetTimes = matching
      .map((reason) => (reason.resets_at ? Date.parse(reason.resets_at) : NaN))
      .filter(Number.isFinite);
    const item: UsageLimitedPipelineSessionItem = {
      kind: 'pipeline',
      executionId: state.id,
      statusReasonIds: [
        ...matching.map((reason) => reason.id),
        ...(executionCheckpoint ? [executionCheckpoint.id] : []),
      ],
      provider:
        req.provider ?? matching.find((reason) => reason.provider)?.provider,
      pipelineName: state.pipeline_snapshot.name,
      detectedAt: Math.min(
        ...matching.map((reason) => Date.parse(reason.detected_at)),
        ...(executionCheckpoint
          ? [Date.parse(executionCheckpoint.detected_at)]
          : []),
      ),
      ...(resetTimes.length ? { resetsAt: Math.min(...resetTimes) } : {}),
      resumeReasons: Array.from(
        new Set([
          ...(executionCheckpoint ? ['app_shutdown' as const] : []),
          ...matching.map((reason) =>
            reason.kind === 'provider_sign_in'
              ? ('provider_sign_in' as const)
              : reason.kind === 'app_shutdown'
                ? ('app_shutdown' as const)
                : reason.kind === 'provider_authentication_required'
                  ? ('authentication' as const)
                  : ('usage_limit' as const),
          ),
        ]),
      ),
      pausedStepCount: new Set(
        matching.map(
          (reason) => `${reason.source.job_id}.${reason.source.step_id}`,
        ),
      ).size,
      modelLabels: Array.from(
        new Set(
          matching
            .map((reason) => reason.model)
            .filter((model): model is string => Boolean(model)),
        ),
      ),
      otherBlockingReasonCount: state.status_reasons.length - matching.length,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
    };
    if (workspace) {
      const { entry, worktreeName } = workspace;
      let group = groups.get(entry.id);
      if (!group) {
        group = {
          groupId: entry.id,
          groupKind: 'workspace',
          workspaceId: entry.id,
          workspaceName: entry.name,
          workspaceType: entry.type,
          workspaceColor: entry.color,
          sessions: [],
        };
        groups.set(entry.id, group);
      }
      item.worktreeName = worktreeName;
      group.sessions.push(item);
    } else {
      const localId = '__local_pipelines__';
      const group = groups.get(localId) ?? {
        groupId: localId,
        groupKind: 'local' as const,
        workspaceName: 'Local workflows',
        sessions: [],
      };
      group.sessions.push(item);
      groups.set(localId, group);
    }
  }
  return {
    groups: Array.from(groups.values())
      .filter((group) => group.sessions.length > 0)
      .sort((left, right) =>
        left.workspaceName.localeCompare(right.workspaceName),
      ),
    providersByExecution,
  };
}

export interface ResumeDeps {
  dispatchContinue: (target: UsageLimitedChatTarget) => Promise<void>;
  /**
   * `resumeStartedAt` is epoch ms captured *before* the dispatch, so the clear
   * can tell a stale registry entry from one the resumed turn just recorded by
   * re-hitting the usage limit.
   */
  clearRegistryAndBanner: (
    target: UsageLimitedChatTarget,
    resumeStartedAt: number,
  ) => Promise<void>;
}

/**
 * Pure orchestration for resuming usage-limited chats: dispatches `Continue`
 * into each target and, only on a successful dispatch, clears the registry
 * entry and persisted banner for that target. Per-target failures are
 * isolated — one target's failure does not abort the rest of the batch.
 */
export async function resumeUsageLimitedChatsWith(
  req: ResumeUsageLimitedChatsRequest,
  deps: ResumeDeps,
): Promise<ResumeUsageLimitedChatsResponse> {
  const failedTargets: UsageLimitedChatTarget[] = [];
  let resumedCount = 0;
  for (const target of req.targets) {
    const release = claimTrustedChatResume(target);
    if (!release) {
      failedTargets.push(target);
      continue;
    }
    try {
      // Captured before the dispatch: every usage-limit record the resumed
      // turn writes is necessarily at or after this instant, which is what
      // lets the clear leave it alone.
      const resumeStartedAt = Date.now();
      await deps.dispatchContinue(target);
      await deps.clearRegistryAndBanner(target, resumeStartedAt);
      resumedCount += 1;
    } catch {
      failedTargets.push(target);
    } finally {
      release();
    }
  }
  return { resumedCount, failedTargets };
}

/**
 * Backs the account-change resume modal's resume action: dispatches a resume
 * prompt into each target chat using its own persisted provider/model/session,
 * then clears the usage-limited registry entry and persisted banner for chats
 * that resumed successfully.
 *
 * The resume prompt is `'Continue'` unless the last turn was simply the user's
 * message hitting the usage limit before the agent did anything — in that case
 * the user's last message is re-sent so the never-processed prompt actually
 * runs (see {@link computeUsageLimitResumePrompt}).
 */
export async function handleResumeUsageLimitedChats(
  req: ResumeUsageLimitedChatsRequest,
  getWindow: () => BrowserWindow | null,
  resumeContext?:
    | string
    | {
        attemptId: string;
        userMessageId: string;
        onDispatched: () => void;
      },
): Promise<ResumeUsageLimitedChatsResponse> {
  const userMessageId =
    typeof resumeContext === 'string' ? resumeContext : undefined;
  const authentication =
    typeof resumeContext === 'object' ? resumeContext : undefined;
  const bannerSnapshots = new Map<string, PersistedUsageLimitBannerSnapshot>();
  const dispatchTargets = new Map<string, UsageLimitedChatTarget>();
  const targetKey = (target: UsageLimitedChatTarget): string =>
    `${target.projectId}\0${target.worktreeId}\0${target.chatId}`;
  return resumeUsageLimitedChatsWith(req, {
    dispatchContinue: async (target) => {
      validateUsageLimitedChatTarget(target);
      const dispatchTarget = await requireResumeChatTarget(target);
      dispatchTargets.set(targetKey(target), dispatchTarget);
      const tabOptions = await buildExistingTabDispatchOptions(
        dispatchTarget.projectId,
        dispatchTarget.worktreeId,
        target.chatId,
      );
      const tabsFile = await readChatTabsFile(
        dispatchTarget.projectId,
        dispatchTarget.worktreeId,
        { chatIds: [target.chatId] },
      );
      const tab = tabsFile.tabs.find(
        (candidate) => candidate.id === target.chatId,
      );
      bannerSnapshots.set(
        targetKey(target),
        capturePersistedUsageLimitBannerSnapshot(tab),
      );
      const interrupted = (await readUsageLimitedChats()).find(
        (entry) =>
          entry.projectId === target.projectId &&
          entry.worktreeId === target.worktreeId &&
          entry.chatId === target.chatId,
      );
      const legacyBanner = tab?.llmProviderUsageLimitBanner;
      const awaitingRestart = Object.values(tab?.interruptedTurns ?? {}).some(
        (turn) => !turn.resumedBy && !turn.abandoned,
      );
      if (!interrupted && !legacyBanner && !awaitingRestart)
        throw new Error('This chat no longer has an eligible interruption.');
      if (interrupted?.resumeReason === 'provider_sign_in' && !authentication)
        throw new Error(
          'Codex sign-in recovery requires an attempt-scoped resume request.',
        );
      if (
        authentication &&
        interrupted?.authenticationAttemptId !== authentication.attemptId
      )
        throw new Error(
          'This chat belongs to a different Codex authentication attempt.',
        );
      const pauseAttemptId =
        authentication?.attemptId ?? interrupted?.authenticationAttemptId;
      if (pauseAttemptId)
        getChatQueueService().releaseAuthenticationPause(
          dispatchTarget,
          pauseAttemptId,
        );
      if (!tab) throw new Error('The chat no longer exists.');
      // A previous dispatch may have succeeded before registry/banner cleanup
      // failed. Reconcile its exact accepted prompt instead of sending again.
      if (
        interrupted?.interruptedUserMessageId &&
        tab.messages.some(
          (message) =>
            message.id === tab.lastAcceptedUserMessageId &&
            message.userMessageSource === 'auto_resume' &&
            message.autoResume?.resumesUserMessageId ===
              interrupted.interruptedUserMessageId &&
            message.timestamp >= interrupted.detectedAt,
        )
      )
        return;
      const resumePrompt = buildTrustedAutoResume(
        { ...tab, providerType: interrupted?.provider ?? tab.providerType },
        interrupted?.resumeReason ??
          (legacyBanner ? 'usage_limit' : 'app_shutdown'),
        interrupted?.detectedAt ?? legacyBanner?.detectedAt,
        interrupted?.interruptedUserMessageId,
      );
      const durableResumeMessageId =
        authentication?.userMessageId ??
        userMessageId ??
        (interrupted
          ? deterministicResumeMessageId(
              JSON.stringify([
                'resume',
                target,
                interrupted.detectedAt,
                resumePrompt.autoResume.resumesUserMessageId,
              ]),
            )
          : undefined);
      try {
        await sendWorktreeChatMessage(
          {
            projectId: dispatchTarget.projectId,
            worktreeId: dispatchTarget.worktreeId,
            chatId: target.chatId,
            text: resumePrompt.text,
            ...(resumePrompt.fileReferences?.length
              ? { fileReferences: resumePrompt.fileReferences }
              : {}),
            ...(resumePrompt.attachmentPaths?.length
              ? { attachmentPaths: resumePrompt.attachmentPaths }
              : {}),
            ...(resumePrompt.attachmentPromptContexts?.length
              ? {
                  attachmentPromptContexts:
                    resumePrompt.attachmentPromptContexts,
                }
              : {}),
            userMessageId: durableResumeMessageId ?? randomUUID(),
            resumesInterruptedTurn: true,
            autoResume: resumePrompt.autoResume,
            initiationSource: 'automation',
            ...(resumePrompt.resendsUserMessage && resumePrompt.inputMode
              ? { inputMode: resumePrompt.inputMode }
              : {}),
            ...tabOptions,
          },
          {
            getWindow,
            requiredAccountProxyConnectionId:
              interrupted?.accountProxyConnectionId,
            ...(durableResumeMessageId
              ? { preserveUsageLimitRegistry: true }
              : {}),
          },
        );
        if (
          durableResumeMessageId &&
          isTerminalBackedInterfaceMode(tabOptions.interfaceMode)
        ) {
          const deadline = Date.now() + 30000;
          for (;;) {
            const current = await readChatTabsFile(
              dispatchTarget.projectId,
              dispatchTarget.worktreeId,
              { chatIds: [target.chatId], pageOnly: true },
            );
            const delivered = current.tabs
              .find((candidate) => candidate.id === target.chatId)
              ?.messages.some(
                (message) => message.id === durableResumeMessageId,
              );
            if (delivered) break;
            if (Date.now() >= deadline || getResumeQueue().isStopping())
              throw new Error(
                'Terminal resume delivery has not been confirmed.',
              );
            await delay(250);
          }
        }
        authentication?.onDispatched();
      } catch (error) {
        if (pauseAttemptId)
          await getChatQueueService().pauseForAuthentication(
            dispatchTarget,
            pauseAttemptId,
          );
        throw error;
      }
    },
    clearRegistryAndBanner: async (target, resumeStartedAt) => {
      // A successful `Continue` dispatch must always count as resumed, even
      // if this best-effort cleanup fails (e.g. a readChatTabsFile/
      // writeChatTabsFile I/O error). Letting a cleanup failure propagate
      // would wrongly report an already-resumed chat as failed and risk a
      // retry re-dispatching `Continue` into it. Log and move on instead.
      if (authentication) {
        try {
          await clearAuthenticationInterruptedChat(
            target,
            authentication.attemptId,
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            '[usage-limited-chats] Failed to clear authentication-interrupted registry entry after a successful dispatch',
            error,
          );
        }
      } else
        try {
          await clearUsageLimitedChat(target, {
            onlyIfDetectedBefore: resumeStartedAt,
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            '[usage-limited-chats] Failed to clear usage-limited registry entry after a successful dispatch',
            error,
          );
        }
      try {
        await clearPersistedUsageLimitBanner({
          ...(dispatchTargets.get(targetKey(target)) ?? target),
          expectedBannerState: bannerSnapshots.get(targetKey(target)) ?? {},
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          '[usage-limited-chats] Failed to clear persisted usage-limit banner after a successful dispatch',
          error,
        );
      }
    },
  });
}

const authenticationResumeClaims = new Map<
  string,
  'in-flight' | 'cleanup-pending'
>();

function authenticationResumeMessageId(claim: string): string {
  return deterministicResumeMessageId(claim);
}

function deterministicResumeMessageId(claim: string): string {
  const digest = createHash('sha256').update(claim, 'utf8').digest('hex');
  const variant = (
    (Number.parseInt(digest[16] ?? '0', 16) & 0x3) |
    0x8
  ).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function usageLimitResumeMessageId(entry: ResumeQueueEntry): string {
  return deterministicResumeMessageId(
    JSON.stringify(['usage-limit', entry.target, entry.interruptionId]),
  );
}

async function hasAcceptedResumeReceipt(
  target: Extract<ResumeQueueEntry['target'], { kind: 'chat' }>,
  messageIds: ReadonlySet<string>,
): Promise<boolean> {
  const tabs = await readResumeChatTabsFile(target, {
    chatIds: [target.chatId],
    pageOnly: true,
  });
  const tab = tabs.tabs.find((candidate) => candidate.id === target.chatId);
  if (!tab) return false;
  return (
    (tab.lastAcceptedUserMessageId !== undefined &&
      messageIds.has(tab.lastAcceptedUserMessageId)) ||
    (isTerminalBackedInterfaceMode(tab.interfaceMode) &&
      tab.messages.some((message) => messageIds.has(message.id)))
  );
}

async function hasPersistedResumeMessage(
  target: Extract<
    ResumeUsageLimitedSessionsRequest['targets'][number],
    { kind: 'chat' }
  >,
  userMessageId: string,
): Promise<boolean> {
  const tabs = await readResumeChatTabsFile(target, {
    chatIds: [target.chatId],
  });
  return (
    tabs.tabs
      .find((tab) => tab.id === target.chatId)
      ?.messages.some((message) => message.id === userMessageId) ?? false
  );
}

async function resolveAuthenticationAttemptId(
  target: ResumeUsageLimitedSessionsRequest['targets'][number],
): Promise<string | undefined> {
  if (target.kind === 'chat') {
    const chatTarget: UsageLimitedChatTarget = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    };
    validateUsageLimitedChatTarget(chatTarget);
    const interrupted = (await readUsageLimitedChats(true)).find(
      (entry) =>
        entry.projectId === target.projectId &&
        entry.worktreeId === target.worktreeId &&
        entry.chatId === target.chatId,
    );
    if (interrupted?.resumeReason !== 'provider_sign_in') return undefined;
    if (!interrupted.authenticationAttemptId)
      throw new Error(
        'This Codex sign-in recovery record has no authentication attempt.',
      );
    validateId(interrupted.authenticationAttemptId, 'authenticationAttemptId');
    return interrupted.authenticationAttemptId;
  }

  validateId(target.executionId, 'executionId');
  const runtime = createElectronExecutionRuntime();
  const state = await loadExecutionState(
    target.executionId,
    runtime.executionsDir,
  ).catch(() => null);
  if (!state) return undefined;
  const hasProviderSignInReason = state.status_reasons.some(
    (reason) =>
      target.statusReasonIds.includes(reason.id) &&
      reason.kind === 'provider_sign_in',
  );
  if (!hasProviderSignInReason) return undefined;
  const attemptId = state.authentication_pause?.attempt_id;
  if (!attemptId)
    throw new Error(
      'This Codex sign-in pipeline has no authentication attempt.',
    );
  validateId(attemptId, 'authenticationAttemptId');
  return attemptId;
}

export async function handleResumeUsageLimitedSessions(
  req: ResumeUsageLimitedSessionsRequest,
  getWindow: () => BrowserWindow | null,
  queuedResumeMessageId?: string,
): Promise<ResumeUsageLimitedSessionsResponse> {
  if (req.authenticationAttemptId)
    validateId(req.authenticationAttemptId, 'authenticationAttemptId');
  let resumedCount = 0;
  let staleCount = 0;
  const failedTargets: ResumeUsageLimitedSessionsResponse['failedTargets'] = [];
  for (const target of req.targets) {
    let claim: string | undefined;
    let durableClaim = false;
    let dispatched = false;
    let resumeMessageId = queuedResumeMessageId;
    try {
      const persistedAttemptId = await resolveAuthenticationAttemptId(target);
      if (
        req.authenticationAttemptId &&
        persistedAttemptId !== req.authenticationAttemptId
      ) {
        staleCount += 1;
        continue;
      }
      const authenticationAttemptId =
        persistedAttemptId ?? req.authenticationAttemptId;
      if (authenticationAttemptId) {
        await codexLoginManager.assertResumeAllowed(authenticationAttemptId);
        const candidateClaim = JSON.stringify([
          authenticationAttemptId,
          target,
        ]);
        resumeMessageId ??= authenticationResumeMessageId(candidateClaim);
        const existingClaim = authenticationResumeClaims.get(candidateClaim);
        if (existingClaim) {
          if (existingClaim === 'cleanup-pending' && target.kind === 'chat') {
            await clearAuthenticationInterruptedChat(
              {
                projectId: target.projectId,
                worktreeId: target.worktreeId,
                chatId: target.chatId,
              },
              authenticationAttemptId,
            );
            await clearCodexAuthenticationResumeClaim(candidateClaim);
            authenticationResumeClaims.delete(candidateClaim);
          }
          staleCount += 1;
          continue;
        }
        // Reserve the target before any further async work. A second renderer
        // request can otherwise pass the durable-message probe while the first
        // request is still awaiting the registry claim and dispatch twice.
        claim = candidateClaim;
        authenticationResumeClaims.set(claim, 'in-flight');
        if (target.kind === 'chat') {
          if (await hasPersistedResumeMessage(target, resumeMessageId)) {
            try {
              await clearAuthenticationInterruptedChat(
                {
                  projectId: target.projectId,
                  worktreeId: target.worktreeId,
                  chatId: target.chatId,
                },
                authenticationAttemptId,
              );
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(
                '[usage-limited-chats] Failed to reconcile an already-dispatched authentication resume',
                error,
              );
            }
            await clearCodexAuthenticationResumeClaim(candidateClaim);
            staleCount += 1;
            continue;
          }
          durableClaim = await claimCodexAuthenticationResume(candidateClaim);
        }
        await codexLoginManager.assertResumeAllowed(authenticationAttemptId);
      }
      if (target.kind === 'chat') {
        const chatTarget: UsageLimitedChatTarget = {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        };
        validateUsageLimitedChatTarget(chatTarget);
        const response = await handleResumeUsageLimitedChats(
          { targets: [chatTarget] },
          getWindow,
          authenticationAttemptId
            ? {
                attemptId: authenticationAttemptId,
                userMessageId:
                  resumeMessageId ??
                  authenticationResumeMessageId(
                    JSON.stringify([authenticationAttemptId, target]),
                  ),
                onDispatched: (): void => {
                  dispatched = true;
                  if (claim)
                    authenticationResumeClaims.set(claim, 'cleanup-pending');
                },
              }
            : undefined,
        );
        if (response.failedTargets.length > 0) {
          throw new Error('Chat resume dispatch failed');
        }
        resumedCount += 1;
        if (claim) {
          await clearCodexAuthenticationResumeClaim(claim);
          authenticationResumeClaims.delete(claim);
        }
        continue;
      }
      if (target.kind !== 'pipeline') {
        throw new Error('Usage-limited session target kind is invalid');
      }
      validateId(target.executionId, 'executionId');
      if (
        !Array.isArray(target.statusReasonIds) ||
        target.statusReasonIds.length === 0
      ) {
        throw new Error('Pipeline statusReasonIds must not be empty');
      }
      const result = await resumePipelineExecutionFromMain({
        executionId: target.executionId,
        statusReasonIds: target.statusReasonIds,
        allowStaleNoop: true,
        initiationSource: 'automation',
        getWindow,
      });
      if (result.status === 'started') resumedCount += 1;
      else staleCount += 1;
      if (claim) authenticationResumeClaims.delete(claim);
    } catch (error) {
      failedTargets.push({
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (claim && !dispatched) {
        if (durableClaim)
          await clearCodexAuthenticationResumeClaim(claim).catch(
            () => undefined,
          );
        authenticationResumeClaims.delete(claim);
      }
    }
  }
  return { resumedCount, staleCount, failedTargets };
}

export function validateResumeQueueRequestTargets(
  req: ResumeUsageLimitedSessionsRequest,
): Map<string, ResumeUsageLimitedSessionsRequest['targets'][number]> {
  if (!Array.isArray(req.targets) || req.targets.length > 500)
    throw new Error('Select at most 500 sessions to resume.');
  return new Map(
    req.targets.map((target) => {
      if (target.kind === 'chat') validateUsageLimitedChatTarget(target);
      else if (target.kind === 'pipeline') {
        validateId(target.executionId, 'executionId');
        if (
          !Array.isArray(target.statusReasonIds) ||
          target.statusReasonIds.length === 0
        )
          throw new Error('Pipeline statusReasonIds must not be empty');
        for (const id of target.statusReasonIds)
          validateId(id, 'statusReasonIds');
      } else throw new Error('Invalid resume target.');
      return [resumeTargetKey(target), target] as const;
    }),
  );
}

export async function resolveResumeQueueItems(
  req: ResumeUsageLimitedSessionsRequest,
): Promise<ResumeQueueItem[]> {
  const requested = validateResumeQueueRequestTargets(req);
  const { groups, providersByExecution } =
    await listUsageLimitedIdleSessionsWithProviders(
      req.authenticationAttemptId
        ? { authenticationAttemptId: req.authenticationAttemptId }
        : {},
    );
  const items = groups.flatMap((group) =>
    group.sessions.flatMap((session): ResumeQueueItem[] => {
      if (!requested.has(resumeTargetKey(session))) return [];
      const selected = requested.get(resumeTargetKey(session));
      const target: UsageLimitedSessionTarget =
        session.kind === 'chat'
          ? {
              kind: 'chat',
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              chatId: session.chatId,
            }
          : {
              kind: 'pipeline',
              executionId: session.executionId,
              statusReasonIds: session.statusReasonIds.filter(
                (id) =>
                  selected?.kind === 'pipeline' &&
                  selected.statusReasonIds.includes(id),
              ),
            };
      if (target.kind === 'pipeline' && !target.statusReasonIds.length)
        return [];
      const providers =
        target.kind === 'pipeline'
          ? Array.from(
              new Set(
                target.statusReasonIds
                  .map((id) =>
                    providersByExecution.get(target.executionId)?.get(id),
                  )
                  .filter((provider): provider is QueueProvider =>
                    Boolean(provider),
                  ),
              ),
            )
          : session.provider
            ? [session.provider]
            : [];
      return [
        {
          target,
          ...(session.kind === 'chat' && session.accountProxyConnectionId
            ? { accountProxyConnectionId: session.accountProxyConnectionId }
            : {}),
          title:
            session.kind === 'chat' ? session.chatTitle : session.pipelineName,
          workspaceName: group.workspaceName,
          providers,
          interruptionId:
            session.kind === 'chat'
              ? String(session.detectedAt)
              : target.kind === 'pipeline'
                ? [...target.statusReasonIds].sort().join(',')
                : '',
        },
      ];
    }),
  );
  return items;
}

async function reconcileResumeQueueEntry(entry: ResumeQueueEntry): Promise<{
  status: 'waiting' | 'resumed' | 'skipped' | 'failed';
  error?: string;
}> {
  const target = entry.target;
  if (target.kind === 'pipeline') {
    const state = await loadExecutionState(
      target.executionId,
      createElectronExecutionRuntime().executionsDir,
    );
    if (!state) return { status: 'skipped' };
    const reasons = new Set([
      ...state.status_reasons.map((reason) => reason.id),
      ...(state.shutdown_checkpoint ? [state.shutdown_checkpoint.id] : []),
    ]);
    return {
      status: target.statusReasonIds.some((id) => reasons.has(id))
        ? 'waiting'
        : 'resumed',
    };
  }
  const tabs = await readResumeChatTabsFile(target, {
    chatIds: [target.chatId],
    pageOnly: true,
  });
  const tab = tabs.tabs.find((candidate) => candidate.id === target.chatId);
  if (!tab) return { status: 'skipped' };
  const durableMessageId = usageLimitResumeMessageId(entry);
  const canonicallyResumed =
    tab.lastAcceptedUserMessageId === entry.id ||
    tab.lastAcceptedUserMessageId === durableMessageId ||
    (isTerminalBackedInterfaceMode(tab.interfaceMode) &&
      tab.messages.some(
        (message) => message.id === entry.id || message.id === durableMessageId,
      ));
  if (canonicallyResumed) {
    const current = (await readUsageLimitedChats(true)).find(
      (candidate) =>
        resumeTargetKey({ kind: 'chat', ...candidate }) ===
          resumeTargetKey(target) &&
        String(candidate.detectedAt) === entry.interruptionId,
    );
    if (current?.resumeReason === 'provider_sign_in') {
      const attemptId = current.authenticationAttemptId;
      if (attemptId) {
        const claim = JSON.stringify([attemptId, target]);
        await clearAuthenticationInterruptedChat(target, attemptId);
        await clearCodexAuthenticationResumeClaim(claim);
        authenticationResumeClaims.delete(claim);
      }
    } else if (current) {
      await clearUsageLimitedChat(target, {
        onlyIfDetectedAt: current.detectedAt,
      });
    }
    return { status: 'resumed' };
  }
  // A persisted user prompt without acceptance is an ambiguous external-send
  // window. Never automatically replay it. Other waiting entries can continue.
  if (
    tab.messages.some(
      (message) => message.id === entry.id || message.id === durableMessageId,
    ) ||
    (tab.transcript?.lastMessageAt ?? 0) > entry.createdAt
  )
    return {
      status: 'failed',
      error:
        'The app stopped during this resume. Check the session before trying again.',
    };
  return { status: 'waiting' };
}

export async function dispatchResumeQueueEntry(
  entry: ResumeQueueEntry,
  getWindow: () => BrowserWindow | null,
): Promise<'resumed' | 'skipped'> {
  const target = entry.target;
  if (target.kind === 'chat') {
    const registry = await readUsageLimitedChats(true);
    const current = registry.find(
      (candidate) =>
        resumeTargetKey({ kind: 'chat', ...candidate }) ===
        resumeTargetKey(target),
    );
    if (
      !current ||
      String(current.detectedAt) !== entry.interruptionId ||
      current.accountProxyConnectionId !== entry.accountProxyConnectionId
    )
      return 'skipped';
    const resumeMessageId = usageLimitResumeMessageId(entry);
    if (
      current.resumeReason !== 'provider_sign_in' &&
      (await hasAcceptedResumeReceipt(
        target,
        new Set([entry.id, resumeMessageId]),
      ))
    ) {
      await clearUsageLimitedChat(target, {
        onlyIfDetectedAt: current.detectedAt,
      });
      return 'resumed';
    }
    const dispatchTarget = await requireResumeChatTarget(target);
    if (
      getAllActiveSessionInfos().some(
        (session) =>
          session.projectId === dispatchTarget.projectId &&
          session.worktreeId === dispatchTarget.worktreeId &&
          session.chatId === target.chatId &&
          (session.turnActive || session.pendingMessageCount > 0),
      )
    )
      return 'skipped';
    if (current.resumeReason === 'provider_sign_in') {
      const response = await handleResumeUsageLimitedSessions(
        {
          targets: [target],
          ...(current.authenticationAttemptId
            ? { authenticationAttemptId: current.authenticationAttemptId }
            : {}),
        },
        getWindow,
        entry.id,
      );
      if (response.failedTargets.length)
        throw new Error(response.failedTargets[0].error);
      return response.resumedCount ? 'resumed' : 'skipped';
    }
    const response = await handleResumeUsageLimitedChats(
      { targets: [target] },
      getWindow,
      resumeMessageId,
    );
    if (response.failedTargets.length)
      throw new Error(
        'Could not resume the session. It remains available in interrupted sessions.',
      );
    return 'resumed';
  }
  const response = await handleResumeUsageLimitedSessions(
    { targets: [target] },
    getWindow,
  );
  if (response.failedTargets.length)
    throw new Error(response.failedTargets[0].error);
  return response.resumedCount ? 'resumed' : 'skipped';
}

function configureUsageLimitResumeQueue(
  getWindow: () => BrowserWindow | null,
  isRendererReady: () => boolean = (): boolean => true,
): void {
  const proxyRecovery = new AccountProxyQuotaRecovery({
    now: Date.now,
    readInterrupted: (): Promise<UsageLimitedChatEntry[]> =>
      readUsageLimitedChats(true),
    readStatus: getAccountProxyStatus,
    readPipelines: (): Promise<AccountProxyPipelineInterruption[]> => {
      const lookupWorkspace = createResumeWorkspaceLookup();
      return readAccountProxyPipelineInterruptions(
        createElectronExecutionRuntime().executionsDir,
        async (projectId, worktreeId) =>
          (await lookupWorkspace(projectId, worktreeId))?.entry.name,
      );
    },
    resolveItems: async (entries): Promise<ResumeQueueItem[]> => {
      const items: ResumeQueueItem[] = [];
      // Bound each existing resolver call to its public admission size.
      for (let offset = 0; offset < entries.length; offset += 500) {
        items.push(
          ...(await resolveResumeQueueItems({
            targets: entries.slice(offset, offset + 500).map((entry) => ({
              kind: 'chat',
              projectId: entry.projectId,
              worktreeId: entry.worktreeId,
              chatId: entry.chatId,
            })),
          })),
        );
      }
      return items;
    },
  });
  let admissionStatus: ReturnType<typeof getAccountProxyStatus> | undefined;
  let admissionCheckedAt = 0;
  let admissionInterruptions:
    | Promise<ReadonlyMap<string, string> | null>
    | undefined;
  let interruptionsCheckedAt = 0;
  const readAdmissionInterruptions = (): Promise<ReadonlyMap<
    string,
    string
  > | null> => {
    if (
      !admissionInterruptions ||
      Date.now() - interruptionsCheckedAt >= 5000
    ) {
      interruptionsCheckedAt = Date.now();
      admissionInterruptions = readUsageLimitedChats(true).then(
        (entries) =>
          new Map(
            entries
              .filter((entry) => entry.accountProxyConnectionId)
              .map((entry) => [
                resumeTargetKey({ kind: 'chat', ...entry }),
                `${entry.detectedAt}:${entry.accountProxyConnectionId}`,
              ]),
          ),
        () => null,
      );
    }
    return admissionInterruptions;
  };
  const readAdmissionStatus = (): ReturnType<typeof getAccountProxyStatus> => {
    if (!admissionStatus || Date.now() - admissionCheckedAt >= 5000) {
      admissionCheckedAt = Date.now();
      admissionStatus = getAccountProxyStatus({
        refresh: true,
        maxAgeMs: 30_000,
      });
    }
    return admissionStatus;
  };
  configureResumeQueue({
    readLiveAutomaticResumeInterruptionKeys: async (suppressed) => {
      const interrupted = await readUsageLimitedChats(true);
      const live = new Set(
        interrupted
          .filter((entry) => entry.accountProxyConnectionId)
          .map(
            (entry) =>
              `${resumeTargetKey({ kind: 'chat', ...entry })}:${entry.detectedAt}`,
          ),
      );
      const executionIds = new Set(
        suppressed
          .filter((entry) => entry.targetKey.startsWith('pipeline:'))
          .map((entry) => entry.targetKey.slice('pipeline:'.length)),
      );
      for (const executionId of Array.from(executionIds)) {
        // Read the canonical file directly, including hidden/terminal runs.
        // An unreadable file fails closed; it cannot erase a user's Stop.
        const state = await loadExecutionState(
          executionId,
          createElectronExecutionRuntime().executionsDir,
        ).catch(() => undefined);
        if (state === undefined) {
          for (const entry of suppressed) {
            if (entry.targetKey === `pipeline:${executionId}`)
              live.add(`${entry.targetKey}:${entry.interruptionId}`);
          }
          continue;
        }
        if (!state) continue;
        const reasons = new Set(
          state.status_reasons.map((reason) => reason.id),
        );
        for (const entry of suppressed) {
          if (
            entry.targetKey === `pipeline:${executionId}` &&
            entry.interruptionId.split(',').some((id) => reasons.has(id))
          ) {
            live.add(`${entry.targetKey}:${entry.interruptionId}`);
          }
        }
      }
      return live;
    },
    collect: async (queue) => {
      if (isAccountProxyFlagEnabled()) await proxyRecovery.collect(queue);
    },
    reconcile: reconcileResumeQueueEntry,
    dispatch: (entry) => dispatchResumeQueueEntry(entry, getWindow),
    canDispatch: async (entries) => {
      const nextWaitingChat = entries.find(
        (entry) => entry.status === 'waiting',
      );
      if (
        nextWaitingChat?.accountProxyConnectionId &&
        nextWaitingChat.target.kind === 'pipeline'
      ) {
        const state = await loadExecutionState(
          nextWaitingChat.target.executionId,
          createElectronExecutionRuntime().executionsDir,
        ).catch(() => null);
        const selectedReasons = new Set(nextWaitingChat.target.statusReasonIds);
        if (
          !state ||
          !state.status_reasons.some((reason) => selectedReasons.has(reason.id))
        ) {
          // Final dispatch rechecks canonical state and records a stale no-op.
          // An obsolete entry must not remain permanently waiting for quota.
          return true;
        }
        return canResumeAccountProxyPipelineEntry(
          nextWaitingChat,
          state,
          await readAdmissionStatus(),
          Date.now(),
        );
      }
      if (nextWaitingChat?.accountProxyConnectionId) {
        const interrupted = await readAdmissionInterruptions();
        if (!interrupted) return false;
        if (
          interrupted.get(resumeTargetKey(nextWaitingChat.target)) !==
          `${nextWaitingChat.interruptionId}:${nextWaitingChat.accountProxyConnectionId}`
        )
          return true;
        const interruption = proxyQueueInterruption(nextWaitingChat);
        if (
          !interruption ||
          !canResumeAccountProxyChat(
            interruption,
            await readAdmissionStatus(),
            Date.now(),
          )
        )
          return false;
      }
      if (nextWaitingChat?.target.kind === 'chat') {
        const target = nextWaitingChat.target;
        if (nextWaitingChat.accountProxyConnectionId) {
          const resolved = await resolveResumeChatTarget(target);
          if (!resolved) return false;
          const options = await buildExistingTabDispatchOptions(
            resolved.projectId,
            resolved.worktreeId,
            resolved.chatId,
          ).catch(() => null);
          if (!options) return false;
          const provider = nextWaitingChat.providers?.[0];
          if (
            (provider !== 'claude' && provider !== 'codex') ||
            (options.providerType && options.providerType !== provider) ||
            options.aiCreditsRouting?.active ||
            !(await previewAccountProxySessionRoute({
              harness: provider,
              requiredConnectionId: nextWaitingChat.accountProxyConnectionId,
              model: options.model,
              resolveWorkOwner: () =>
                resolveAiCreditsScopeOwner({ kind: 'work', ...resolved }),
            }))
          )
            return false;
        }
        const tabs = await readResumeChatTabsFile(target, {
          chatIds: [target.chatId],
          pageOnly: true,
        });
        const interfaceMode = tabs.tabs.find(
          (tab) => tab.id === target.chatId,
        )?.interfaceMode;
        if (isTerminalBackedInterfaceMode(interfaceMode)) {
          const window = getWindow();
          if (
            !isRendererReady() ||
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed()
          )
            return false;
        }
      }
      return true;
    },
  });
}

export function registerUsageLimitedChatsHandlers(
  getMainWindow: () => BrowserWindow | null,
  isRendererReady?: () => boolean,
): void {
  configureUsageLimitResumeQueue(getMainWindow, isRendererReady);
  registerIpcHandler<[], ResumeQueueSnapshot>(
    IPC_CHANNELS.getResumeQueue,
    async () => {
      const queue = getResumeQueue();
      await queue.initialize().catch(() => undefined);
      return queue.snapshot();
    },
  );
  registerIpcHandler<[ResumeUsageLimitedSessionsRequest], ResumeQueueSnapshot>(
    IPC_CHANNELS.enqueueResumeQueue,
    async (_event, req) =>
      getResumeQueue().enqueue(await resolveResumeQueueItems(req)),
  );
  registerIpcHandler<[ResumeQueueControl], ResumeQueueSnapshot>(
    IPC_CHANNELS.controlResumeQueue,
    async (_event, action) => {
      const queue = getResumeQueue();
      await queue.initialize();
      if (action === 'dismiss')
        await suppressDismissedAccountProxyRecovery(queue.snapshot().entries);
      return queue.control(action);
    },
  );
  registerIpcHandler<
    [ListUsageLimitedIdleChatsRequest],
    ListUsageLimitedIdleChatsResponse
  >(IPC_CHANNELS.listUsageLimitedIdleChats, (_event, req) =>
    handleListUsageLimitedIdleChats(req),
  );
  registerIpcHandler<
    [ResumeUsageLimitedChatsRequest],
    ResumeUsageLimitedChatsResponse
  >(IPC_CHANNELS.resumeUsageLimitedChats, (_event, req) =>
    handleResumeUsageLimitedChats(req, getMainWindow),
  );
  registerIpcHandler<
    [ListUsageLimitedIdleSessionsRequest],
    ListUsageLimitedIdleSessionsResponse
  >(IPC_CHANNELS.listUsageLimitedIdleSessions, (_event, req) =>
    handleListUsageLimitedIdleSessions(req),
  );
  registerIpcHandler<
    [ResumeUsageLimitedSessionsRequest],
    ResumeUsageLimitedSessionsResponse
  >(IPC_CHANNELS.resumeUsageLimitedSessions, (_event, req) =>
    handleResumeUsageLimitedSessions(req, getMainWindow),
  );
}
