import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  CHAT_EXTRACTION_SCHEMA,
  TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
  isChatExtraction,
  type ChatEvidence,
} from '@canopy/memory-consolidation/transcript-extraction';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../../agents/session-manager';
import { getDataDir } from '../../lib/paths';
import { readPreferencesFile } from '../../lib/preferences-store';
import { readLearningTranscript } from './transcript-learning-source';
import { runChatLearningWorker } from './transcript-learning-runner';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../../lib/helper-observed-task';
import {
  getStructuredHelperQueryErrorUsage,
  StructuredHelperQueryError,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import { localMemoryStore } from './memory-store';
import { resolveLocalMemoryRunModel } from './helper-model';
import { resolveLocalMemoryPolicy } from './policy';
import { resolveLocalMemoryScope } from './scope-resolver';
import {
  chatLearningEnabled,
  isChatLearningFlagEnabled,
  onChatLearningDisabled,
  chatLearningAccountId,
} from './transcript-learning-recorder';
import { onChatLearningFlagChanged } from './transcript-learning-gate';
import { linkHelperAbort } from '../../helper-runs/helper-runs';
import { subscribeCanopyCloudAccountChanges } from '../../lib/canopy-cloud-account-store';
import {
  CHAT_LEARNING_INTERVAL_MS,
  readLearningState,
  reserveLearningBudget,
  updateLearningState,
  type LearningTurn,
  type LearningChatRef,
} from './transcript-learning-state';
import { runLocalMemoryStructuredHelper } from './structured-helper';
import { broadcastLocalMemoryChanged } from './change-events';
import { requestLocalMemoryConsolidation } from './consolidation-scheduler';
import { isHelperNoBillingSourceError } from '../../agents/helper-no-billing-source';

const active = new Set<string>();

/** Global idle is deliberately stricter than project idle for this initial rollout. */
export function chatsAreIdle(): boolean {
  return !getAllActiveSessionInfos().some(
    (session) => session.turnActive || session.pendingMessageCount > 0,
  );
}

export { collectChatEvidence } from './transcript-learning-evidence';

async function turnStillAllowed(
  turn: LearningTurn,
  scope: LocalMemoryScopeRequest,
): Promise<boolean> {
  const resolved = resolveLocalMemoryScope(scope);
  if (
    turn.accountBindingVersion !== 1 ||
    chatLearningAccountId() !== turn.accountId ||
    (resolved.signedInAccountId !== null &&
      resolved.signedInAccountId !== turn.accountId)
  )
    return false;
  const policy = await resolveLocalMemoryPolicy(turn);
  const current = resolveLocalMemoryScope(scope);
  if (
    current.dir !== resolved.dir ||
    current.signedInAccountId !== resolved.signedInAccountId ||
    chatLearningAccountId() !== turn.accountId
  )
    return false;
  if (scope.scope === 'user')
    return policy.kind === 'unscoped' && turn.owner === undefined;
  return (
    policy.kind === 'scoped' &&
    policy.workspaceId === scope.workspaceId &&
    JSON.stringify(policy.owner) === JSON.stringify(turn.owner)
  );
}

function sameChat(left: LearningChatRef, right: LearningChatRef): boolean {
  return (
    left.chatId === right.chatId &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId
  );
}

/** A durable cursor keeps bounded passes fair without changing FIFO retention. */
async function readLearningEvidence(
  eligible: LearningTurn[],
  scope: LocalMemoryScopeRequest,
  dir: string,
  mayContinue: () => Promise<boolean>,
  canRead: () => boolean,
  cancellation: AbortSignal,
  after?: LearningChatRef,
): Promise<{
  first: LearningTurn;
  turns: LearningTurn[];
  evidence: ChatEvidence[];
  prompt: string;
} | null> {
  const seen = new Set<string>();
  const candidates = eligible.filter((turn) => {
    const id = JSON.stringify([turn.projectId, turn.worktreeId, turn.chatId]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // A removed/expired cursor starts at the first remaining candidate. Turn
  // insertion order stays intact, so the 200-turn cap still drops oldest IDs.
  const start = after
    ? candidates.findIndex((turn) => sameChat(turn, after)) + 1
    : 0;
  let lastConsidered: LearningChatRef | undefined;
  try {
    for (
      let offset = 0;
      offset < Math.min(10, candidates.length);
      offset += 1
    ) {
      const first = candidates[(start + offset) % candidates.length];
      if (!first || !(await mayContinue())) return null;
      const turns = eligible.filter((turn) => sameChat(turn, first));
      for (const turn of turns)
        if (!(await turnStillAllowed(turn, scope))) return null;
      if (!canRead()) return null;
      lastConsidered = {
        projectId: first.projectId,
        worktreeId: first.worktreeId,
        chatId: first.chatId,
      };
      try {
        const { evidence, prompt } = await readLearningTranscript(
          first,
          async (snapshot, signal) => {
            const result = await runChatLearningWorker(
              {
                kind: 'extract',
                snapshot,
                allowed: turns.map((turn) => turn.userMessageId),
              },
              AbortSignal.any([signal, cancellation]),
            );
            if (result.kind !== 'evidence')
              throw new Error('Invalid learning evidence response');
            return result;
          },
          canRead,
        );
        if (evidence.length) return { first, turns, evidence, prompt };
      } catch (error) {
        // Only deletion retires references. Cold, oversized, empty and failed
        // reads retain theirs, but the next pass advances beyond this chat.
        if (
          error instanceof Error &&
          error.message === `Unknown chat: ${first.chatId}`
        ) {
          await updateLearningState(dir, (state) => {
            state.turns = state.turns.filter((turn) => !sameChat(turn, first));
          });
        }
      }
    }
    return null;
  } finally {
    const cursor = lastConsidered;
    if (cursor && canRead())
      await updateLearningState(dir, (state) => {
        if (canRead()) state.lastConsideredChat = cursor;
      });
  }
}

export interface ChatLearningResult {
  status: 'learned' | 'skipped';
  notes: number;
}

/** Core-owned two-stage learning; host dependencies remain in the desktop composition. */
export async function learnFromChats(
  scope: LocalMemoryScopeRequest,
  signal?: AbortSignal,
): Promise<ChatLearningResult> {
  const skipped: ChatLearningResult = { status: 'skipped', notes: 0 };
  if (!isChatLearningFlagEnabled()) return skipped;
  const accountId = chatLearningAccountId();
  if (accountId === undefined) return skipped;
  if (signal?.aborted || active.size > 0 || !chatsAreIdle()) return skipped;
  const resolved = resolveLocalMemoryScope(scope);
  const key = resolved.dir;
  active.add(key);
  const controller = new AbortController();
  const unlinkCaller = signal
    ? linkHelperAbort(signal, controller)
    : (): void => {};
  const unsubscribe = subscribeChatSessionActivity(() => {
    if (!chatsAreIdle()) controller.abort();
  });
  const unsubscribePreference = onChatLearningDisabled(() =>
    controller.abort(),
  );
  const unsubscribeFlag = onChatLearningFlagChanged(() => {
    if (!isChatLearningFlagEnabled()) controller.abort();
  });
  const sourceStillBound = (): boolean => {
    const current = resolveLocalMemoryScope(scope);
    return (
      current.dir === key &&
      chatLearningAccountId() === accountId &&
      current.signedInAccountId === resolved.signedInAccountId
    );
  };
  const canRead = (): boolean =>
    !controller.signal.aborted && chatsAreIdle() && sourceStillBound();
  const mayContinue = async (): Promise<boolean> =>
    !controller.signal.aborted &&
    chatsAreIdle() &&
    (await chatLearningEnabled()) &&
    !controller.signal.aborted &&
    sourceStillBound();
  const unsubscribeAccount = subscribeCanopyCloudAccountChanges(() => {
    if (!sourceStillBound()) controller.abort();
  });
  try {
    if (!(await mayContinue())) return skipped;
    const state = await readLearningState(key);
    if (
      state.lastAttemptAt !== undefined &&
      Date.now() - state.lastAttemptAt < CHAT_LEARNING_INTERVAL_MS
    )
      return skipped;
    const eligible: LearningTurn[] = [];
    for (const turn of state.turns) {
      if (!(await mayContinue())) return skipped;
      if (
        Date.now() - turn.at <= 7 * 24 * 60 * 60_000 &&
        (await turnStillAllowed(turn, scope))
      )
        eligible.push(turn);
    }
    const oldest = eligible[0];
    if (!oldest) return skipped;
    const workOwner: WorkOwner = oldest.owner
      ? { kind: 'organization', organizationId: oldest.owner.organizationId }
      : { kind: 'personal' };
    const run = await resolveLocalMemoryRunModel(
      await readPreferencesFile(),
      scope.scope === 'workspace' ? scope.workspaceId : undefined,
      { workOwner },
    );
    if ('refusal' in run || !(await mayContinue())) return skipped;
    const selected = await readLearningEvidence(
      eligible,
      scope,
      key,
      mayContinue,
      canRead,
      controller.signal,
      state.lastConsideredChat,
    );
    if (!selected || !(await mayContinue())) return skipped;
    const { first, turns, evidence, prompt } = selected;
    // Ownership/policy can change while the thread reads its pinned prefix.
    for (const turn of turns)
      if (!(await turnStillAllowed(turn, scope))) return skipped;
    // Persist the interval and global spending reservation BEFORE model dispatch.
    let claimed = false;
    await updateLearningState(key, (latest) => {
      if (
        latest.lastAttemptAt !== undefined &&
        Date.now() - latest.lastAttemptAt < CHAT_LEARNING_INTERVAL_MS
      )
        return;
      latest.lastAttemptAt = Date.now();
      claimed = true;
    });
    if (
      !claimed ||
      !(await reserveLearningBudget(
        join(getDataDir(), 'memory-learning-budget'),
        Date.now(),
      )) ||
      !(await mayContinue())
    )
      return skipped;
    const taskKey = `helper:local-memory-chat-extraction:${randomUUID()}`;
    startObservedHelperTask({
      taskKey,
      eventType: 'local_memory_consolidation',
      label: 'Learn from chats',
      model: run.helperModel.model,
      modelConfig: run.helperModel.modelConfig,
      auditContext: {
        projectId: first.projectId,
        worktreeId: first.worktreeId,
      },
      chatId: first.chatId,
    });
    let notes = 0;
    try {
      const generation = await runLocalMemoryStructuredHelper({
        taskKey,
        kind: 'local-memory-consolidation',
        label: 'Learn from chats',
        scopeDir: key,
        workspaceId:
          scope.scope === 'workspace' ? scope.workspaceId : undefined,
        workOwner,
        helperModel: run.helperModel,
        systemPrompt: TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
        userMessage: prompt,
        schema: CHAT_EXTRACTION_SCHEMA,
        isResult: isChatExtraction,
        signal: controller.signal,
        preserveModelSelection: true,
      });
      if (!(await mayContinue())) {
        finalizeObservedHelperTask(
          taskKey,
          'failure',
          'Chat learning cancelled',
          generation.usage,
        );
        return skipped;
      }
      for (const turn of turns)
        if (!(await turnStillAllowed(turn, scope))) {
          finalizeObservedHelperTask(
            taskKey,
            'failure',
            'Chat learning cancelled',
            generation.usage,
          );
          return skipped;
        }
      if (generation.value === null)
        throw new StructuredHelperQueryError(
          'Chat learning returned no valid structured result',
          generation.usage,
        );
      const rendered = await runChatLearningWorker(
        {
          kind: 'render',
          evidence,
          value: generation.value,
          source: { provider: 'chat-extraction', chatId: first.chatId },
          ...(first.owner ? { origin: first.owner } : {}),
        },
        controller.signal,
      );
      if (rendered.kind !== 'notes')
        throw new Error('Invalid learning notes response');
      // At-most-once publication: crash after this checkpoint may lose a derived
      // note, but must never reintroduce a note the user deleted or corrected.
      const ids = new Set(evidence.map((entry) => entry.turnId));
      await updateLearningState(key, (latest) => {
        latest.turns = latest.turns.filter(
          (turn) =>
            turn.chatId !== first.chatId ||
            turn.projectId !== first.projectId ||
            turn.worktreeId !== first.worktreeId ||
            !ids.has(turn.userMessageId),
        );
      });
      for (const note of rendered.notes) {
        if (!(await mayContinue()) || !(await turnStillAllowed(first, scope)))
          break;
        // No await between the final identity fence and saveNote, which
        // captures its target synchronously and guards later scope moves.
        if (!canRead()) break;
        const fileKey = await localMemoryStore.savePreparedNote(
          scope,
          note,
          async () =>
            (await mayContinue()) &&
            (await turnStillAllowed(first, scope)) &&
            canRead(),
        );
        if (fileKey) {
          notes += 1;
          if (canRead()) await localMemoryStore.seedUsage(scope, fileKey);
        }
      }
      finalizeObservedHelperTask(
        taskKey,
        'success',
        undefined,
        generation.usage,
      );
    } catch (error) {
      if (isHelperNoBillingSourceError(error)) {
        // Refused before any spawn: the provider is signed out with no
        // billing source (CAN-7062). The turns stay pending for a later run.
        finalizeObservedHelperTask(taskKey, 'cancelled', error.message);
        return skipped;
      }
      finalizeObservedHelperTask(
        taskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
        getStructuredHelperQueryErrorUsage(error),
      );
      throw error;
    }
    if (notes && canRead()) {
      broadcastLocalMemoryChanged(scope);
      await requestLocalMemoryConsolidation(
        scope.scope === 'workspace' ? { workspaceId: scope.workspaceId } : {},
      );
    }
    return { status: 'learned', notes };
  } finally {
    unlinkCaller();
    unsubscribeAccount();
    unsubscribe();
    unsubscribePreference();
    unsubscribeFlag();
    active.delete(key);
  }
}
