import { describeReviewCommentContext } from '@canopy/desktop-shared/types/code-review';
import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type AgentProviderType,
  type ChatModel,
  type CodeReviewUpdatedEvent,
  type McpAskUserEvent,
  type McpQuestion,
  type McpQuestionAnswer,
  type ReviewCommentAnchor,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  sendToAllWindows,
  sendToWindow,
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getAttentionTracker } from '../services/attention-tracker';
import {
  clearAskUserRequestCancellation,
  createPendingRequest,
  isPendingRequestOpen,
  rejectRequest,
} from '../mcp/pending-requests';
import {
  loadScriptOutputSnapshot,
  type ScriptOutputSnapshot,
} from '../mcp/script-output';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  isPlanCommentThreadSubmitted,
  PLAN_COMMENT_HANDOFF_GRACE_MS,
  readScopedPlanCommentThreads,
  waitForSubmittedPlanCommentThread,
  type PlanCommentThreadOwner,
  type ReadScopedPlanCommentThreadsResult,
} from '../lib/plan-persistence';
import { replyToPlanCommentThread } from '../lib/plan-comment-reply';
import { getPlanFileSyncService } from '../lib/plan-file-sync';
import {
  formatPlanCommentSummaryLine,
  formatPlanCommentThread,
  hasTrackedPlanCommentStorage,
} from './plan-comment-threads';
import { getCodeReviewTarget } from '../lib/code-review-registry';
import {
  appendReviewCommentReply,
  readReviewCommentThread,
} from '../lib/code-review-persistence';
import {
  readFileCommentThreads,
  respondToFileComment,
} from './file-comment-core-client';
import {
  computeReviewFingerprint,
  listReviewRepos,
} from '../lib/code-review-diff';
import {
  readWorktreePipelineYaml,
  type PipelineYamlReadRequest,
  type PipelineYamlReadResult,
} from './pipeline-yaml-reader';
import type {
  GetGitPreferencesInput,
  ReadLocalMemoryInput,
  SaveLocalMemoryInput,
  SearchLocalMemoryInput,
} from './core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CONFIG_GIT_NAMESPACE,
  CONFIG_GRANTS,
  ConfigGitValueSchema,
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
  type MemorySearchResult,
} from '@canopy/protocol/canopy-core';
import { activeAgentCoreOperations } from './active-agent-core-operations';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getChatStateService } from '../services/chat-state-service';

/** GetGitPreferences reads as its own principal, with only the config read grant (CAN-5992). */
const AGENT_GIT_PREFERENCES_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-git-preferences',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [CONFIG_GRANTS.read],
};

export async function loadGitPreferences(
  request: GetGitPreferencesInput,
): Promise<string> {
  const { value } = await activeAgentCoreOperations('gitPreferences').query(
    'core.config.get',
    { namespace: CONFIG_GIT_NAMESPACE },
    { caller: AGENT_GIT_PREFERENCES_CALLER },
  );
  const preferences = ConfigGitValueSchema.parse(value);

  if (request.type === 'branch-name') {
    const { instructions, prefixMode, prefix } = preferences.branchName;
    const lines = ['Git preferences for branch-name:'];
    if (instructions.length > 0) {
      lines.push(`Branch naming instructions:\n${instructions}`);
    } else {
      lines.push('No branch naming instructions are set.');
    }

    if (prefixMode === 'none') {
      lines.push('Do not prefix the branch name.');
    } else if (prefix) {
      lines.push(`Prefix the branch with ${prefix}`);
    } else if (prefixMode === 'github') {
      lines.push(
        'GitHub username branch prefix is enabled, but no GitHub username is available. Do not invent a prefix.',
      );
    } else {
      lines.push(
        'Custom branch prefix is enabled, but no custom prefix is set. Do not invent a prefix.',
      );
    }

    return lines.join('\n\n');
  }

  if (request.type === 'pr-generation') {
    const effectiveInstructions = preferences.pullRequest.instructions;
    return [
      'Git preferences for pr-generation:',
      effectiveInstructions.length > 0
        ? `Effective PR generation instructions:\n${effectiveInstructions}`
        : 'No PR generation instructions are set.',
    ].join('\n\n');
  }

  const effectiveInstructions = preferences.commitMessage.instructions;
  return [
    'Git preferences for commit-message:',
    effectiveInstructions.length > 0
      ? `Effective commit message instructions:\n${effectiveInstructions}`
      : 'No commit message instructions are set.',
  ].join('\n\n');
}

/** The memory tools act as their own principal, each call with only its operation's grant (CAN-5993). */
const AGENT_MEMORY_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-memory',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [MEMORY_GRANTS.read, MEMORY_GRANTS.write],
};

/** The text of a core refusal the tools showed before (CAN-5993); else rethrows. */
function memoryRefusalText(error: unknown): string {
  if (
    error instanceof CanopyOperationError &&
    error.payload.code?.startsWith('core.memory.') === true &&
    error.payload.kind !== 'internal'
  )
    return error.payload.message;
  throw error;
}

export async function saveLocalMemory(
  options: SaveLocalMemoryInput & {
    projectId: string;
    worktreeId: string;
    provider: string;
    chatId: string;
    sessionId?: string;
  },
): Promise<string> {
  const idempotencyKey = `agent-memory-save:${options.chatId}:${options.invocationId ?? randomUUID()}`;
  try {
    const { fileKey } = await activeAgentCoreOperations('memory').instruction(
      'core.memory.entry.append',
      {
        scope: {
          workspaceId: options.projectId,
          worktreeId: options.worktreeId,
        },
        memory: options.scope,
        content: options.text,
        source: {
          provider: options.provider,
          chatId: options.chatId,
          ...(options.sessionId !== undefined
            ? { sessionId: options.sessionId }
            : {}),
        },
        _meta: { idempotencyKey },
      },
      { caller: AGENT_MEMORY_CALLER, metadata: { idempotencyKey } },
    );
    return `Saved ${options.scope} memory to ${fileKey}`;
  } catch (error) {
    return memoryRefusalText(error);
  }
}

function formatMemorySearchHit(
  hit: MemorySearchResult['hits'][number],
  index: number,
): string {
  const context = hit.heading ? ` > ${hit.heading}` : '';
  return `${index + 1}. [${hit.memory}] ${hit.fileKey}${context}\n${hit.snippet}`;
}

export async function searchLocalMemory(
  options: SearchLocalMemoryInput & { projectId: string; worktreeId: string },
): Promise<string> {
  let hits: MemorySearchResult['hits'];
  try {
    ({ hits } = await activeAgentCoreOperations('memory').query(
      'core.memory.search',
      {
        scope: {
          workspaceId: options.projectId,
          worktreeId: options.worktreeId,
        },
        query: options.query,
      },
      { caller: AGENT_MEMORY_CALLER },
    ));
  } catch (error) {
    return memoryRefusalText(error);
  }
  if (hits.length === 0) {
    return `No local memory found for "${options.query}".`;
  }
  return [
    'Local memory search results:',
    '',
    ...hits.map(formatMemorySearchHit),
  ].join('\n');
}

export async function readLocalMemory(
  options: ReadLocalMemoryInput & { projectId: string; worktreeId: string },
): Promise<string> {
  try {
    const { content } = await activeAgentCoreOperations('memory').query(
      'core.memory.entry.get',
      {
        scope: {
          workspaceId: options.projectId,
          worktreeId: options.worktreeId,
        },
        memory: options.scope,
        fileKey: options.file,
      },
      { caller: AGENT_MEMORY_CALLER },
    );
    return content;
  } catch (error) {
    return memoryRefusalText(error);
  }
}

export async function requestAnswersFromRenderer(options: {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  questions: McpQuestion[];
  getWindow: () => SendableBrowserWindow | null;
  toolUseId?: string;
  providerType?: AgentProviderType;
  model?: ChatModel;
  onAwaitingUser?: () => void;
  askUserTimeoutMs?: number;
  onRequestCreated?: (requestId: string) => void;
  signal?: AbortSignal;
}): Promise<McpQuestionAnswer[]> {
  if (options.signal?.aborted) throw new Error('ask_user_cancelled');

  const requestId = randomUUID();
  const payload: McpAskUserEvent = {
    requestId,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    questions: options.questions,
    ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
  };
  let consumePromise: Promise<void> | undefined;
  const consumePending = (): Promise<void> => {
    consumePromise ??= getChatStateService().consumePendingQuestion(
      { projectId: options.projectId, worktreeId: options.worktreeId },
      options.chatId,
      requestId,
    );
    return consumePromise;
  };
  const consumeAndExpire = async (): Promise<void> => {
    await consumePending();
    sendToWindow(options.getWindow(), IPC_CHANNELS.mcpExpireAskUser, {
      requestId,
    });
  };

  let cancelled = false;
  let persistenceStarted = false;
  let upsertPromise: Promise<void> | undefined;
  let rejectAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = (): void => reject(new Error('ask_user_cancelled'));
  });
  const cleanupAfterAbort = async (): Promise<void> => {
    await Promise.resolve();
    if (!persistenceStarted) {
      clearAskUserRequestCancellation(requestId);
      return;
    }
    await upsertPromise?.catch(() => undefined);
    await consumeAndExpire();
  };

  const pendingAnswers = createPendingRequest(requestId, options.sessionKey, {
    scope: {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    },
    ...(options.askUserTimeoutMs !== undefined && options.askUserTimeoutMs > 0
      ? {
          timeoutMs: options.askUserTimeoutMs,
          onTimeout: (): void => {
            void consumeAndExpire().catch(() => undefined);
          },
        }
      : {}),
  });
  void pendingAnswers.catch(() => undefined);
  if (!isPendingRequestOpen(requestId)) throw new Error('ask_user_no_client');
  const abortPendingRequest = (): void => {
    if (cancelled) return;
    if (!rejectRequest(requestId, 'ask_user_cancelled')) return;
    cancelled = true;
    rejectAbort?.();
    void cleanupAfterAbort().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortPendingRequest, {
    once: true,
  });
  try {
    try {
      if (options.signal?.aborted) abortPendingRequest();
      if (cancelled) throw new Error('ask_user_cancelled');
      persistenceStarted = true;
      try {
        upsertPromise = getChatStateService().upsertPendingQuestion(
          { projectId: options.projectId, worktreeId: options.worktreeId },
          {
            requestId,
            chatId: options.chatId,
            questions: options.questions,
            ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
          },
        );
      } catch (error) {
        upsertPromise = Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      if (options.signal?.aborted) abortPendingRequest();
      if (options.signal) await Promise.race([upsertPromise, abortPromise]);
      else await upsertPromise;
    } catch (error) {
      if (cancelled) throw new Error('ask_user_cancelled');
      rejectRequest(requestId, 'ask_user_persistence_failed');
      throw error;
    }
    if (cancelled || options.signal?.aborted) {
      abortPendingRequest();
      throw new Error('ask_user_cancelled');
    }
    options.onRequestCreated?.(requestId);

    const win = options.getWindow();
    if (cancelled || options.signal?.aborted) {
      abortPendingRequest();
      throw new Error('ask_user_cancelled');
    }
    const delivery = sendToWindowDetailed(
      win,
      IPC_CHANNELS.mcpAskUser,
      payload,
    );
    if (!delivery.delivered) {
      getExecutionObservabilityIngest().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'ask_user_request_undelivered',
        sessionKey: options.sessionKey,
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType ?? 'unknown',
        ...(options.model ? { model: options.model } : {}),
        sendFailureReason: delivery.reason,
      });
    }
    options.onAwaitingUser?.();
    getExecutionObservabilityIngest().pauseChatTurn(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
    // Second of the two human-blocking chokepoints (see `prompt-bridge.ts`). A
    // `secret: true` question is a credential prompt, so its text never leaves
    // the machine as push context even though the block itself still notifies.
    const askUserDetail = options.questions.find(
      (question) => question.secret !== true,
    )?.question;
    getAttentionTracker().mark({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      state: 'needs_input',
      reason: 'ask_user',
      sourceId: `ask-user:${requestId}`,
      ...(askUserDetail !== undefined ? { detail: askUserDetail } : {}),
    });
    try {
      return await pendingAnswers;
    } finally {
      if (!cancelled) await consumePending().catch(() => undefined);
      getExecutionObservabilityIngest().resumeChatTurn(
        options.projectId,
        options.worktreeId,
        options.chatId,
      );
      getAttentionTracker().clear(
        options.projectId,
        options.worktreeId,
        options.chatId,
        `ask-user:${requestId}`,
      );
    }
  } finally {
    options.signal?.removeEventListener('abort', abortPendingRequest);
  }
}

export async function loadWorktreeScriptOutput(options: {
  projectId: string;
  worktreeId: string;
  scriptId: string;
  repo?: string;
  maxLines?: number;
}): Promise<ScriptOutputSnapshot> {
  if (isCoworkWorkspace(options.projectId)) {
    return {
      found: false,
      lines: [],
      error:
        'GetScriptOutput is only available for worktree chats, not standalone chats.',
    };
  }
  if (
    options.projectId === APP_ADVISOR_PROJECT_ID ||
    (options.projectId === PIPELINE_EDITOR_PROJECT_ID &&
      options.worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  ) {
    return {
      found: false,
      lines: [],
      error:
        'GetScriptOutput requires a real worktree; assistant sentinel ids are not valid script targets.',
    };
  }

  return loadScriptOutputSnapshot({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    scriptId: options.scriptId,
    repo: options.repo,
    maxLines: options.maxLines,
  });
}

/** Which comment store a `RespondToFileComment` reply was written to. */
export type FileCommentThreadStore = 'file' | 'review' | 'plan';

export interface RespondToCommentInSessionResult {
  ok: boolean;
  resolved: boolean;
  error?: string;
  /** Set on a successful ordinary file-comment reply. */
  store?: FileCommentThreadStore;
}

function snippet(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export interface GetCommentThreadInSessionResult {
  ok: boolean;
  text: string;
  error?: string;
}

async function resolveFileCommentSessionScope(options: {
  projectId: string;
  worktreeId: string;
}): Promise<{ projectId: string; worktreeId: string } | null> {
  if (options.projectId !== CODE_REVIEW_CHAT_PROJECT_ID) {
    return options;
  }
  return getCodeReviewTarget(options.worktreeId);
}

const AMBIGUOUS_COMMENT_THREAD_ERROR = 'Ambiguous comment thread id.';

/**
 * Tracked-plan comment threads for a RESOLVED file-comment scope, or null when
 * the scope cannot own tracked plans (assistant sentinels, Cowork).
 */
async function readSessionPlanCommentThreads(
  scope: { projectId: string; worktreeId: string },
  threadId: string | undefined,
): Promise<ReadScopedPlanCommentThreadsResult | null> {
  if (!hasTrackedPlanCommentStorage(scope.projectId)) {
    return null;
  }
  return readScopedPlanCommentThreads({
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    ...(threadId !== undefined ? { threadId } : {}),
  });
}

/**
 * A single-thread lookup is ambiguous when the plan store itself matched more
 * than one plan, or when more than one store matched. Thread ids are only
 * unique within their own store.
 */
function isAmbiguousThreadLookup(
  plan: ReadScopedPlanCommentThreadsResult | null,
  storeMatches: readonly boolean[],
): boolean {
  if (plan && !plan.ok && plan.reason === 'ambiguous') {
    return true;
  }
  return storeMatches.filter(Boolean).length > 1;
}

type SinglePlanCommentThread = Extract<
  ReadScopedPlanCommentThreadsResult,
  { mode: 'single' }
>;

/**
 * A draft-only plan thread can be one the owner just handed off to this chat:
 * the renderer acknowledges the sent comments only after the send was
 * accepted, which can be after the agent's first tool call. Give such a thread
 * the hand-off grace to become submitted and re-read it, so the agent sees
 * the bodies it was sent instead of redacted drafts. A thread that stays
 * draft-only is returned unchanged (and stays redacted).
 */
async function awaitPlanThreadHandoff(
  scope: { projectId: string; worktreeId: string },
  match: SinglePlanCommentThread,
): Promise<SinglePlanCommentThread> {
  if (isPlanCommentThreadSubmitted(match.thread)) {
    return match;
  }
  const submitted = await waitForSubmittedPlanCommentThread(
    {
      projectId: match.owner.projectId,
      worktreeId: match.owner.worktreeId,
      planId: match.owner.planId,
      threadId: match.thread.id,
    },
    PLAN_COMMENT_HANDOFF_GRACE_MS,
  );
  if (!submitted) {
    return match;
  }
  const reread = await readSessionPlanCommentThreads(scope, match.thread.id);
  return reread && reread.ok && reread.mode === 'single' ? reread : match;
}

/**
 * The plan's editable working copy for a single-thread plan view (phase 05
 * D-K). Materializes without flushing: a missing or unedited file is
 * (re)written from the latest content, an edited file is left as the agent
 * or user wrote it, and no plan revision is ever created here. Null only when
 * the scope has no editable plan file.
 */
async function readPlanFileForAgent(
  owner: PlanCommentThreadOwner,
): Promise<string | null> {
  try {
    const materialized = await getPlanFileSyncService().materializePlanFile(
      {
        projectId: owner.projectId,
        worktreeId: owner.worktreeId,
        planId: owner.planId,
      },
      { flush: false },
    );
    return materialized?.filePath ?? null;
  } catch {
    // Reporting the editable file is best-effort; the thread stays readable.
    return null;
  }
}

export async function respondToFileCommentInSession(options: {
  projectId: string;
  worktreeId: string;
  threadId: string;
  body: string;
  resolve: boolean;
  getWindow: () => SendableBrowserWindow | null;
}): Promise<RespondToCommentInSessionResult> {
  const scope = await resolveFileCommentSessionScope(options);
  if (!scope) {
    return {
      ok: false,
      resolved: false,
      error: 'No code-review target registered.',
    };
  }
  const scopedOptions = { ...options, ...scope };
  const [fileThread, reviewThread, planThread] = await Promise.all([
    readFileCommentThreads(scopedOptions),
    readReviewCommentThread(scopedOptions),
    readSessionPlanCommentThreads(scope, options.threadId),
  ]);
  const planMatch =
    planThread && planThread.ok && planThread.mode === 'single'
      ? planThread
      : null;
  if (
    isAmbiguousThreadLookup(planThread, [
      fileThread.ok,
      reviewThread.ok,
      planMatch !== null,
    ])
  )
    return {
      ok: false,
      resolved: false,
      error: AMBIGUOUS_COMMENT_THREAD_ERROR,
    };
  if (planMatch) {
    // The shared reply path checks submission under the plan file lock and
    // gives a just-handed-off draft-only thread the hand-off grace before it
    // rejects with "Comment thread has not been submitted."
    const reply = await replyToPlanCommentThread({
      projectId: planMatch.owner.projectId,
      worktreeId: planMatch.owner.worktreeId,
      planId: planMatch.owner.planId,
      threadId: options.threadId,
      body: options.body,
      resolve: options.resolve,
      requireSubmittedThread: true,
    });
    if (!reply.ok || !reply.plan)
      return {
        ok: false,
        resolved: false,
        error: reply.error ?? 'Failed to post plan comment reply.',
      };
    return { ok: true, resolved: options.resolve, store: 'plan' };
  }
  if (!fileThread.ok && reviewThread.ok && reviewThread.mode === 'single') {
    if (!reviewThread.thread.comments.some((comment) => !comment.staged))
      return {
        ok: false,
        resolved: false,
        error: 'Comment thread has not been submitted.',
      };
    const reply = await appendReviewCommentReply(scopedOptions);
    if (!reply.ok || !reply.review)
      return { ok: false, resolved: false, error: reply.error };
    const event: CodeReviewUpdatedEvent = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      fingerprint: await computeReviewFingerprint(
        await listReviewRepos(scope.projectId, scope.worktreeId),
      ),
      review: reply.review,
    };
    sendToAllWindows(IPC_CHANNELS.codeReviewUpdated, event);
    return { ok: true, resolved: options.resolve, store: 'review' };
  }
  // The core.annotation adapter publishes the committed reply.
  const result = await respondToFileComment(scopedOptions);
  if (!result.ok || !result.document) {
    return {
      ok: false,
      resolved: false,
      error: result.error ?? 'Failed to post file comment reply.',
    };
  }
  return { ok: true, resolved: result.resolved, store: 'file' };
}

export async function getFileCommentsInSession(options: {
  projectId: string;
  worktreeId: string;
  threadId?: string;
}): Promise<GetCommentThreadInSessionResult> {
  const scope = await resolveFileCommentSessionScope(options);
  if (!scope) {
    return {
      ok: false,
      text: '',
      error: 'No code-review target registered.',
    };
  }
  const scopedOptions = { ...options, ...scope };
  const threadId = options.threadId ? options.threadId : undefined;
  const [result, review, plan] = await Promise.all([
    readFileCommentThreads(scopedOptions),
    readReviewCommentThread(scopedOptions),
    readSessionPlanCommentThreads(scope, threadId),
  ]);
  if (threadId) {
    const planMatch = plan && plan.ok && plan.mode === 'single' ? plan : null;
    if (
      isAmbiguousThreadLookup(plan, [result.ok, review.ok, planMatch !== null])
    )
      return { ok: false, text: '', error: AMBIGUOUS_COMMENT_THREAD_ERROR };
    if (planMatch) {
      const current = await awaitPlanThreadHandoff(scope, planMatch);
      return {
        ok: true,
        text: formatPlanCommentThread({
          owner: current.owner,
          thread: current.thread,
          planFile: await readPlanFileForAgent(current.owner),
        }),
      };
    }
    if (result.ok && result.mode === 'single')
      return {
        ok: true,
        text: [
          `File: ${result.filePath}`,
          formatSingleReviewThread(result.thread),
        ].join('\n'),
      };
    if (review.ok && review.mode === 'single')
      return {
        ok: true,
        text: [
          'Review storage (diff/diagram view; legacy coordinates may be outdated)',
          formatSingleReviewThread(reviewThreadForDisplay(review.thread)),
        ].join('\n'),
      };
    return { ok: false, text: '', error: 'Comment thread not found.' };
  }
  if (!result.ok) return { ok: false, text: '', error: result.error };
  const files = result.mode === 'all' ? result.threads : [];
  const reviews = review.ok && review.mode === 'all' ? review.threads : [];
  // Draft-only plan threads have nothing submitted for the agent to act on.
  const plans =
    plan && plan.ok && plan.mode === 'all'
      ? plan.threads.filter(({ thread }) =>
          isPlanCommentThreadSubmitted(thread),
        )
      : [];
  const summaries = [
    ...files.map(
      ({ filePath, thread }) =>
        `- ${thread.id} [${thread.status}] ${thread.comments.length} comment(s): ${filePath} ${formatReviewAnchorLocation(thread.anchor)} [${describeReviewCommentContext(thread.anchor)}; anchor ${thread.anchorState}]`,
    ),
    ...reviews.map(
      (thread) =>
        `- ${thread.id} [${thread.status}] Review: ${formatReviewAnchorLocation(thread.anchor)} [${describeReviewCommentContext(reviewThreadForDisplay(thread).anchor)}; anchor ${reviewThreadForDisplay(thread).anchorState}]`,
    ),
    ...plans.map(({ owner, thread }) =>
      formatPlanCommentSummaryLine(owner, thread),
    ),
  ];
  return {
    ok: true,
    text: summaries.length
      ? [
          `${summaries.length} open file/diff/diagram/plan comment thread(s):`,
          ...summaries,
        ].join('\n')
      : 'No open file or plan comment threads.',
  };
}

/**
 * Post an agent reply to a code-review comment thread, optionally resolving
 * it. The code-review sentinel's `worktreeId` is the composite scope key
 * (`projectId--worktreeId`); the code-review registry supplies the real
 * `(projectId, worktreeId)` pair used for persistence and event emission. Emits
 * `codeReviewUpdated` after persisting so the review modal updates live.
 */
export async function respondToReviewCommentInSession(options: {
  worktreeId: string;
  threadId: string;
  body: string;
  resolve: boolean;
  getWindow: () => SendableBrowserWindow | null;
}): Promise<RespondToCommentInSessionResult> {
  const ref = await getCodeReviewTarget(options.worktreeId);
  if (!ref) {
    return {
      ok: false,
      resolved: false,
      error: 'No code-review target registered.',
    };
  }

  const result = await appendReviewCommentReply({
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    threadId: options.threadId,
    body: options.body,
    resolve: options.resolve,
  });
  if (!result.ok || !result.review) {
    return {
      ok: false,
      resolved: false,
      error: result.error ?? 'Failed to post comment reply.',
    };
  }

  const repos = await listReviewRepos(ref.projectId, ref.worktreeId);
  const event: CodeReviewUpdatedEvent = {
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    fingerprint: await computeReviewFingerprint(repos),
    review: result.review,
  };
  sendToAllWindows(IPC_CHANNELS.codeReviewUpdated, event);

  return { ok: true, resolved: options.resolve };
}

function formatReviewAnchorLocation(anchor: ReviewCommentAnchor): string {
  if (anchor.unanchored === true) {
    return 'unanchored (general note)';
  }
  if (anchor.source === 'diagram') {
    const kind = anchor.diagramKind ?? 'diagram';
    return `${kind} diagram node "${snippet(anchor.quote, 120)}"`;
  }
  const path = anchor.repoId
    ? `${anchor.repoId}/${anchor.filePath ?? '(unknown file)'}`
    : (anchor.filePath ?? '(unknown file)');
  const lines =
    anchor.lineStart !== undefined
      ? anchor.lineEnd !== undefined
        ? `:${anchor.lineStart}-${anchor.lineEnd}`
        : `:${anchor.lineStart}`
      : '';
  const side = anchor.side ? ` (${anchor.side})` : '';
  return `${path}${lines}${side}`;
}

function reviewThreadForDisplay(
  thread: ReviewCommentThread,
): ReviewCommentThread {
  if (thread.anchor.source === 'diagram') return thread;
  return {
    ...thread,
    anchor: { ...thread.anchor, view: 'diff' },
    anchorState: thread.anchor.diff ? thread.anchorState : 'outdated',
  };
}

function formatSingleReviewThread(thread: ReviewCommentThread): string {
  const lines = [
    `Thread ${thread.id} [${thread.status}] (anchor ${thread.anchorState})`,
    `Anchor: ${formatReviewAnchorLocation(thread.anchor)}`,
    `Context: ${describeReviewCommentContext(thread.anchor)}`,
    'Quote:',
    '```',
    thread.anchor.quote,
    '```',
    '',
    'Comments:',
  ];
  if (thread.comments.length === 0) {
    lines.push('(no comments yet)');
  } else {
    for (const comment of thread.comments) {
      const body = comment.staged === true ? '[redacted draft]' : comment.body;
      lines.push(
        `- [${comment.author}] ${comment.createdAt}${comment.staged ? ' (staged draft)' : ''}: ${body}`,
      );
    }
  }
  return lines.join('\n');
}

function formatOpenReviewThreadSummary(threads: ReviewCommentThread[]): string {
  const open = threads.filter((thread) => thread.status === 'open');
  if (open.length === 0) {
    return 'No open comment threads.';
  }
  const lines = [`${open.length} open comment thread(s):`];
  for (const thread of open) {
    lines.push(
      `- ${thread.id} [${thread.status}] ${thread.comments.length} comment(s): ${formatReviewAnchorLocation(thread.anchor)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Read code-review comment thread history for the agent. The code-review
 * sentinel's `worktreeId` is the composite scope key (`projectId--worktreeId`);
 * the code-review registry supplies the real `(projectId, worktreeId)` pair.
 * Returns a pre-formatted text view: a single thread's anchored excerpt and
 * history when `threadId` is given, or an open-thread summary otherwise.
 * Read-only — mirrors the read side of the plan-explore tooling.
 */
export async function getReviewCommentThreadInSession(options: {
  worktreeId: string;
  threadId?: string;
}): Promise<GetCommentThreadInSessionResult> {
  const ref = await getCodeReviewTarget(options.worktreeId);
  if (!ref) {
    return {
      ok: false,
      text: '',
      error: 'No code-review target registered.',
    };
  }

  const result = await readReviewCommentThread({
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
  });
  if (!result.ok) {
    return { ok: false, text: '', error: result.error };
  }

  return {
    ok: true,
    text:
      result.mode === 'single'
        ? formatSingleReviewThread(result.thread)
        : formatOpenReviewThreadSummary(result.threads),
  };
}

export async function loadWorktreePipelineYaml(
  options: PipelineYamlReadRequest,
): Promise<PipelineYamlReadResult> {
  // Cowork chats are allowed: the reader resolves the cowork workspace root
  // via `resolveWorktreeCwd`, and stored/bundled pipeline YAML is directory-
  // safe to read from there.
  if (
    options.projectId === APP_ADVISOR_PROJECT_ID ||
    (options.projectId === PIPELINE_EDITOR_PROJECT_ID &&
      options.worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  ) {
    return {
      ok: false,
      error:
        'ReadPipelineYaml requires a real worktree; assistant sentinel ids are not valid pipeline targets.',
    };
  }

  return readWorktreePipelineYaml(options);
}
