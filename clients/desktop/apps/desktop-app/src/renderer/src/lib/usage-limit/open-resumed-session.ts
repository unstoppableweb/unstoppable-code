/**
 * Destinations for resume-queue entries (CAN-4894). Confirming one chat, a
 * queue row, Done, and the sidebar chip all open the session a queue entry
 * resumes through the automation-run opener, so destination validation and
 * cowork normalization stay in one place. Nothing here changes the queue.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ResumeQueueEntry,
  type ResumeQueueSnapshot,
  type UsageLimitedChatTarget,
  type UsageLimitedSessionTarget,
} from '@canopy/desktop-shared/types';
import {
  automationRunDestinationLabel,
  openAutomationRunDestination,
  type AutomationRunDestination,
  type OpenAutomationRunDestinationResult,
} from '@/components/automations/resolveAutomationRunDestination';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';

export const RESUME_DESTINATION_ERROR =
  'Couldn’t open this session. Try again from the queue.';

/**
 * The chat an interrupted-session target names. App Advisor and standalone
 * chats map to their own destinations; a standalone chat's cowork workspace
 * occupies the worktree slot. Navigation only: a resumed turn is the caller's.
 */
export function usageLimitedChatDestination(
  target: UsageLimitedChatTarget,
  userMessageId?: string,
): AutomationRunDestination {
  if (!target.projectId.trim() || !target.chatId.trim()) {
    return { kind: 'none', reason: 'That chat is no longer available.' };
  }
  const turn = userMessageId ? { userMessageId } : {};
  if (target.projectId === APP_ADVISOR_PROJECT_ID) {
    return { kind: 'app-advisor-chat', chatId: target.chatId, ...turn };
  }
  if (!target.worktreeId.trim()) {
    return { kind: 'none', reason: 'That chat is no longer available.' };
  }
  if (target.projectId === STANDALONE_CHAT_PROJECT_ID) {
    return {
      kind: 'cowork-chat',
      workspaceId: target.worktreeId,
      chatId: target.chatId,
      ...turn,
    };
  }
  return {
    kind: 'worktree-chat',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    ...turn,
  };
}

/**
 * Map an entry to its session. Focus only a resumed chat, using an accepted
 * message identity supplied by the chat read, never the queue's random id.
 */
export function resumeQueueEntryDestination(
  entry: ResumeQueueEntry,
  userMessageId?: string,
): AutomationRunDestination {
  const { target } = entry;
  switch (target.kind) {
    case 'pipeline':
      return { kind: 'pipeline-execution', executionId: target.executionId };
    case 'chat':
      return usageLimitedChatDestination(
        target,
        entry.status === 'resumed' ? userMessageId : undefined,
      );
  }
}

/** Label for the control that opens an entry's destination. */
export function resumeQueueEntryDestinationLabel(
  entry: ResumeQueueEntry,
): string {
  return automationRunDestinationLabel(resumeQueueEntryDestination(entry));
}

/** Open an entry's destination; a rejected navigation is an unsuccessful result. */
export async function openResumeQueueEntry(
  entry: ResumeQueueEntry,
): Promise<OpenAutomationRunDestinationResult> {
  const queue = useResumeQueueStore.getState();
  queue.beginNavigation();
  try {
    let userMessageId: string | undefined;
    if (entry.status === 'resumed' && entry.target.kind === 'chat') {
      let { projectId, worktreeId } = entry.target;
      const { chatId } = entry.target;
      if (projectId === STANDALONE_CHAT_PROJECT_ID) {
        projectId = worktreeId;
        const owner = await window.api.workEntries.resolveChat({
          projectId,
          chatId,
        });
        worktreeId =
          owner.entryId ?? owner.archivedInEntryId ?? COWORK_HOME_WORKTREE_ID;
      }
      const file = await window.api.chat.loadTabs({ projectId, worktreeId });
      const tab = file.tabs.find((candidate) => candidate.id === chatId);
      // Ordinary resumes use a deterministic message id; provider sign-in
      // recovery can use the queue id. Reveal the latest accepted turn in
      // either case, including results completed while this chat was offscreen.
      // Legacy tabs without a receipt retain their latest user turn in messages.
      userMessageId =
        tab?.lastAcceptedUserMessageId ??
        tab?.messages
          .slice()
          .reverse()
          .find((message) => message.role === 'user')?.id;
    }
    const result = await openAutomationRunDestination(
      resumeQueueEntryDestination(entry, userMessageId),
    );
    return result.ok
      ? result
      : { ok: false, error: result.error || RESUME_DESTINATION_ERROR };
  } catch {
    return { ok: false, error: RESUME_DESTINATION_ERROR };
  } finally {
    queue.endNavigation();
  }
}

function sameTarget(
  a: UsageLimitedSessionTarget,
  b: UsageLimitedSessionTarget,
): boolean {
  if (a.kind === 'chat' && b.kind === 'chat') {
    return (
      a.projectId === b.projectId &&
      a.worktreeId === b.worktreeId &&
      a.chatId === b.chatId
    );
  }
  if (a.kind === 'pipeline' && b.kind === 'pipeline') {
    return a.executionId === b.executionId;
  }
  return false;
}

const isPending = (entry: ResumeQueueEntry): boolean =>
  entry.status === 'waiting' || entry.status === 'resuming';

/**
 * The entry a single confirmed chat may open directly, or null when the queue
 * dialog should open instead: more than one target, a pipeline, a paused or
 * erroring queue, a failed entry, another pending entry, or a missing or
 * ambiguous match. A matching `resumed` entry stays eligible, because a fast
 * provider can finish before enqueue returns.
 */
export function directResumeEntry(
  snapshot: ResumeQueueSnapshot,
  targets: readonly UsageLimitedSessionTarget[],
): ResumeQueueEntry | null {
  const [target] = targets;
  if (targets.length !== 1 || !target || target.kind !== 'chat') return null;
  if (snapshot.paused || snapshot.error) return null;
  if (snapshot.entries.some((entry) => entry.status === 'failed')) return null;
  const matches = snapshot.entries.filter(
    (entry) =>
      sameTarget(entry.target, target) &&
      (isPending(entry) || entry.status === 'resumed'),
  );
  const [match] = matches;
  if (matches.length !== 1 || !match) return null;
  if (snapshot.entries.some((entry) => entry !== match && isPending(entry))) {
    return null;
  }
  return match;
}

/** The chat Done opens: the queue's only resumed entry, when it is a chat. */
export function soleResumedChatEntry(
  snapshot: ResumeQueueSnapshot,
): ResumeQueueEntry | null {
  const resumed = snapshot.entries.filter(
    (entry) => entry.status === 'resumed',
  );
  const [entry] = resumed;
  return resumed.length === 1 && entry?.target.kind === 'chat' ? entry : null;
}
