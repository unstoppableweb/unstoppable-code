// Pending tool-approval prompt persistence and lookup helpers. Mirrors
// pending-questions.ts: pending approvals are tracked by request id at the
// store level while the transcript matches a card to a `tool_use` block by
// `toolUseId` (see `ask-user-pending-match.ts` for the analogous question
// matcher).
import type {
  ApprovalRequestEvent,
  PersistedPendingApproval,
} from '@canopy/desktop-shared/types';
import { closeOpenTurnTimers } from './event-transforms';
import { isRecord } from './utils';
import type { ChatTab, WorktreeChatState } from './types';

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** Mirrors `ApprovalFileChange`; a malformed change rejects the event. */
function isOptionalApprovalFileChange(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isOptionalBoolean(value.truncated)) return false;
  switch (value.kind) {
    case 'edit':
      return (
        typeof value.oldText === 'string' &&
        typeof value.newText === 'string' &&
        isOptionalBoolean(value.replaceAll)
      );
    case 'write':
      return typeof value.content === 'string';
    default:
      return false;
  }
}

function isApprovalRequestDetails(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'command':
      return (
        typeof value.command === 'string' &&
        isOptionalString(value.cwd) &&
        isOptionalString(value.reason)
      );
    case 'file-write':
      return (
        isOptionalString(value.path) &&
        isOptionalString(value.displayPath) &&
        isOptionalApprovalFileChange(value.change) &&
        isOptionalString(value.reason) &&
        isOptionalString(value.itemId)
      );
    case 'mcp':
      return (
        typeof value.server === 'string' &&
        typeof value.tool === 'string' &&
        isOptionalString(value.paramsDisplay) &&
        isOptionalString(value.reason)
      );
    case 'network':
      return typeof value.host === 'string' && isOptionalString(value.reason);
    case 'tool':
      return (
        typeof value.toolName === 'string' &&
        isOptionalString(value.path) &&
        isOptionalString(value.displayPath) &&
        isOptionalString(value.inputSummary) &&
        isOptionalString(value.reason)
      );
    case 'browser-upload':
      return (
        typeof value.origin === 'string' &&
        isOptionalString(value.topOrigin) &&
        Array.isArray(value.files) &&
        value.files.every(
          (file) =>
            isRecord(file) &&
            typeof file.displayPath === 'string' &&
            typeof file.sizeBytes === 'number',
        ) &&
        isOptionalString(value.reason)
      );
    case 'browser-file-request':
      return (
        typeof value.origin === 'string' &&
        isOptionalString(value.topOrigin) &&
        isOptionalString(value.purpose) &&
        typeof value.multiple === 'boolean'
      );
    default:
      return false;
  }
}

function isApprovalRequestEvent(value: unknown): value is ApprovalRequestEvent {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    (value.provider === 'claude' ||
      value.provider === 'codex' ||
      value.provider === 'ollama') &&
    typeof value.title === 'string' &&
    isOptionalString(value.description) &&
    isOptionalString(value.toolUseId) &&
    isApprovalRequestDetails(value.details)
  );
}

export function isPersistablePendingApproval(
  pending: ApprovalRequestEvent,
  projectId: string,
  worktreeId: string,
  chatIds: Set<string>,
): boolean {
  return (
    pending.projectId === projectId &&
    pending.worktreeId === worktreeId &&
    chatIds.has(pending.chatId)
  );
}

export function toPersistedPendingApprovals(
  projectId: string,
  worktreeId: string,
  chatState: WorktreeChatState,
  pendingApprovals: Record<string, ApprovalRequestEvent>,
): PersistedPendingApproval[] | undefined {
  const chatIds = new Set(chatState.tabs.map((tab) => tab.id));
  const persisted = Object.values(pendingApprovals)
    .filter((pending) =>
      isPersistablePendingApproval(pending, projectId, worktreeId, chatIds),
    )
    .map((pending) => ({
      requestId: pending.requestId,
      chatId: pending.chatId,
      event: pending,
    }));

  return persisted.length > 0 ? persisted : undefined;
}

export function isPersistedPendingApproval(
  value: unknown,
): value is PersistedPendingApproval {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === 'string' &&
    typeof value.chatId === 'string' &&
    isApprovalRequestEvent(value.event) &&
    value.event.requestId === value.requestId &&
    value.event.chatId === value.chatId
  );
}

export function hydratePendingApprovalsFromFile(
  file: { pendingApprovals?: unknown },
  projectId: string,
  worktreeId: string,
  chatState: WorktreeChatState,
): Record<string, ApprovalRequestEvent> {
  const chatIds = new Set(chatState.tabs.map((tab) => tab.id));
  const pendingApprovals: Record<string, ApprovalRequestEvent> = {};
  const persisted = Array.isArray(file.pendingApprovals)
    ? file.pendingApprovals
    : [];
  for (const pending of persisted) {
    if (!isPersistedPendingApproval(pending)) continue;
    if (!chatIds.has(pending.chatId)) continue;
    if (
      pending.event.projectId !== projectId ||
      pending.event.worktreeId !== worktreeId
    ) {
      continue;
    }
    pendingApprovals[pending.requestId] = pending.event;
  }
  return pendingApprovals;
}

export function reconcileLivePendingApprovals(
  persisted: Record<string, ApprovalRequestEvent>,
  liveEvents: readonly ApprovalRequestEvent[],
  projectId: string,
  worktreeId: string,
  chatState: WorktreeChatState,
): {
  pendingApprovals: Record<string, ApprovalRequestEvent>;
  removedStaleApprovals: boolean;
} {
  const liveRequestIds = new Set(liveEvents.map((event) => event.requestId));
  const removedStaleApprovals = Object.keys(persisted).some(
    (requestId) => !liveRequestIds.has(requestId),
  );
  const chatIds = new Set(chatState.tabs.map((tab) => tab.id));
  const pendingApprovals: Record<string, ApprovalRequestEvent> = {};
  for (const event of liveEvents) {
    if (
      event.projectId === projectId &&
      event.worktreeId === worktreeId &&
      chatIds.has(event.chatId)
    ) {
      pendingApprovals[event.requestId] = event;
    }
  }
  return { pendingApprovals, removedStaleApprovals };
}

export function closeTimersForRemovedApprovals(
  tabs: ChatTab[],
  persisted: Record<string, { chatId: string }>,
  live: Record<string, unknown>,
): ChatTab[] {
  const staleChatIds = new Set(
    Object.entries(persisted)
      .filter(([requestId]) => live[requestId] === undefined)
      .map(([, approval]) => approval.chatId),
  );
  if (staleChatIds.size === 0) {
    return tabs;
  }
  let changed = false;
  const nextTabs = tabs.map((tab) => {
    if (!staleChatIds.has(tab.id)) {
      return tab;
    }
    const messages = closeOpenTurnTimers(tab.messages, { closePaused: true });
    if (messages === tab.messages) {
      return tab;
    }
    changed = true;
    return { ...tab, messages };
  });
  return changed ? nextTabs : tabs;
}

export function hasPendingApprovalForChat(
  pendingApprovals: Record<string, ApprovalRequestEvent>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return Object.values(pendingApprovals).some(
    (pending) =>
      pending.projectId === projectId &&
      pending.worktreeId === worktreeId &&
      pending.chatId === chatId,
  );
}

export function removePendingApprovalsForChats(
  pendingApprovals: Record<string, ApprovalRequestEvent>,
  projectId: string,
  worktreeId: string,
  chatIds: Iterable<string>,
): Record<string, ApprovalRequestEvent> {
  const chatIdSet = new Set(chatIds);
  if (chatIdSet.size === 0) {
    return pendingApprovals;
  }

  let changed = false;
  const next = { ...pendingApprovals };
  for (const [id, pending] of Object.entries(next)) {
    if (
      pending.projectId === projectId &&
      pending.worktreeId === worktreeId &&
      chatIdSet.has(pending.chatId)
    ) {
      delete next[id];
      changed = true;
    }
  }

  return changed ? next : pendingApprovals;
}
