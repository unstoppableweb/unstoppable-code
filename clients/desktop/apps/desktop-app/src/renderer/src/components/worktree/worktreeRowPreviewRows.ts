import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import type { ChatPreviewRow, RunBadgeRow } from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import type { ScriptRunState } from '@/stores/scriptsStore';
import type { HookRunState } from '@/stores/hooksStore';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import {
  useChatStore,
  getChatTabAgentResponsePreview,
} from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import {
  formatScheduledCadence,
  formatScheduledSendLabel,
  type ScheduledQueuedMessage,
} from '@/lib/worktreeSessionPromptAutomations';

/*
 * Hover-time preview rows for a worktree row's attention popovers (unread,
 * plan review, tool approval, scheduled messages). Shared by the legacy
 * `WorktreeItem` and the shared rail's desktop row overrides so both rails
 * name the same chats. Every builder reads the stores non-reactively, so no
 * row subscribes to streaming chat state for its tooltip. A popover may re-run
 * its builder while it is open (the desktop tool-approval popover does).
 */

export type ChatPreviewKind = 'unread' | 'approval';

/**
 * One-line summary of what an approval prompt is actually asking for. The
 * prompt's `title` is a generic verb ("Run a command"); this is the specific
 * thing the user is being asked to allow, which is what makes the popover
 * worth opening rather than just clicking through to the chat.
 */
function summarizeApprovalRequest(event: ApprovalRequestEvent): string {
  const details = event.details;
  switch (details.kind) {
    case 'command':
      return details.command;
    case 'file-write':
      return details.path ? `Write ${details.path}` : 'Write a file';
    case 'mcp':
      return `${details.server}: ${details.tool}`;
    case 'network':
      return `Fetch ${details.host}`;
    case 'tool': {
      // A read tool names its target, like the approval card. A search of the
      // whole worktree (`.`) says more through its pattern.
      const target = details.displayPath ?? details.path;
      const subject =
        target === '.'
          ? (details.inputSummary ?? target)
          : (target ?? details.inputSummary);
      return subject ? `${details.toolName}: ${subject}` : details.toolName;
    }
    default:
      return event.title;
  }
}

/**
 * Snapshot the pending tool-approval prompts for a worktree into preview rows.
 * Read non-reactively, like {@link buildChatPreviewRows}, so a closed popover
 * never subscribes to live approval state. The desktop row re-runs it while
 * its popover is open, because the approval can arrive before the worktree's
 * chats hydrate and the title would otherwise stay "New Chat".
 *
 * Keyed by chat rather than by prompt: several prompts can queue on one chat,
 * and the user resolves them in the dock once they land there, so the popover
 * names the chat and the prompt currently at the front of its queue.
 */
export function buildToolApprovalPreviewRows(
  wtKey: string,
  projectId: string,
  worktreeId: string,
): ChatPreviewRow[] {
  const state = useChatStore.getState();
  const tabs = state.worktreeChats[wtKey]?.tabs ?? [];
  const byChat = new Map<string, ApprovalRequestEvent[]>();
  for (const approval of Object.values(state.pendingApprovals)) {
    if (approval.projectId !== projectId) continue;
    if (approval.worktreeId !== worktreeId) continue;
    const existing = byChat.get(approval.chatId);
    if (existing) {
      existing.push(approval);
    } else {
      byChat.set(approval.chatId, [approval]);
    }
  }

  const rows: ChatPreviewRow[] = [];
  for (const [chatId, approvals] of Array.from(byChat.entries())) {
    const first = approvals[0];
    if (!first) continue;
    const tab = tabs.find((candidate) => candidate.id === chatId);
    const trimmedTitle = tab?.title?.trim();
    const summary = summarizeApprovalRequest(first);
    rows.push({
      chatId,
      title:
        trimmedTitle && trimmedTitle.length > 0
          ? trimmedTitle
          : `New ${CHAT_UNIT_LABEL}`,
      providerType: tab?.providerType ?? first.provider,
      preview:
        approvals.length > 1
          ? `${summary} · ${approvals.length - 1} more pending`
          : summary,
    });
  }
  return rows;
}

/**
 * Snapshot the chat tabs that drive the unread / awaiting-approval badge for a
 * worktree into compact preview rows. Read non-reactively from the chat store
 * on hover so the per-row component never subscribes to streaming chat state
 * (which would re-render every worktree row on every token).
 */
export function buildChatPreviewRows(
  wtKey: string,
  kind: ChatPreviewKind,
): ChatPreviewRow[] {
  const worktreeChat = useChatStore.getState().worktreeChats[wtKey];
  const rows: ChatPreviewRow[] = [];
  if (worktreeChat) {
    const tabs = worktreeChat.tabs.filter((tab) =>
      kind === 'unread'
        ? tab.unread === true
        : tab.pendingPlanExit !== undefined,
    );
    for (const tab of tabs) {
      const trimmedTitle = tab.title?.trim();
      rows.push({
        chatId: tab.id,
        title:
          trimmedTitle && trimmedTitle.length > 0
            ? trimmedTitle
            : `New ${CHAT_UNIT_LABEL}`,
        providerType: tab.providerType,
        preview: getChatTabAgentResponsePreview(tab),
        ...(kind === 'unread' &&
        tab.unread === true &&
        tab.unreadMarkedManually === true
          ? { markedUnread: true }
          : {}),
      });
    }
  } else {
    // Not hydrated: fall back to the persisted badge summary seeded from
    // worktrees.json so hover previews work without loading transcripts.
    const persisted = useChatStore.getState().persistedWorktreeBadges[wtKey];
    const refs =
      kind === 'unread'
        ? (persisted?.unreadChats ?? [])
        : (persisted?.approvalChats ?? []);
    for (const ref of refs) {
      const trimmedTitle = ref.title?.trim();
      rows.push({
        chatId: ref.chatId,
        title:
          trimmedTitle && trimmedTitle.length > 0
            ? trimmedTitle
            : `New ${CHAT_UNIT_LABEL}`,
        providerType: ref.providerType,
        preview: ref.preview,
        ...(kind === 'unread' && ref.markedUnread === true
          ? { markedUnread: true }
          : {}),
      });
    }
  }

  // Fold in plan-explore chats whose unread completion happened while the
  // Explore modal was closed. Those chats live under a dedicated scope keyed by
  // plan id, so resolve this worktree's tracked plans and check each scope.
  if (kind === 'unread') {
    const plans = useActivityStore.getState().trackedPlans[wtKey] ?? [];
    for (const plan of plans) {
      const planChat =
        useChatStore.getState().worktreeChats[
          `${PLAN_EXPLORE_CHAT_PROJECT_ID}/${plan.id}`
        ];
      if (!planChat) continue;
      for (const tab of planChat.tabs) {
        if (tab.unread !== true) continue;
        const trimmedPlanTitle = plan.title?.trim();
        rows.push({
          chatId: `${PLAN_EXPLORE_CHAT_PROJECT_ID}/${plan.id}/${tab.id}`,
          title:
            trimmedPlanTitle && trimmedPlanTitle.length > 0
              ? trimmedPlanTitle
              : `Plan ${CHAT_UNIT_LABEL}`,
          providerType: tab.providerType,
          preview: getChatTabAgentResponsePreview(tab),
          isPlan: true,
        });
      }
    }
  }

  return rows;
}

export function buildScheduledMessagePreviewRows(args: {
  wtKey: string;
  messages: ScheduledQueuedMessage[];
}): ChatPreviewRow[] {
  if (args.messages.length === 0) return [];

  const worktreeChat = useChatStore.getState().worktreeChats[args.wtKey];
  return args.messages.map((message) => {
    const tab = worktreeChat?.tabs.find((candidate) => {
      return candidate.id === message.chatId;
    });
    const trimmedTabTitle = tab?.title?.trim();
    const trimmedActionTitle = message.chatTitle?.trim();
    return {
      chatId: message.automationId,
      title:
        trimmedTabTitle && trimmedTabTitle.length > 0
          ? trimmedTabTitle
          : trimmedActionTitle && trimmedActionTitle.length > 0
            ? trimmedActionTitle
            : message.activityName,
      providerType: tab?.providerType,
      preview: message.text.trim(),
      scheduledAt: message.scheduledAt,
      ...scheduledMessageLabelField(message),
    };
  });
}

/**
 * Popover schedule line, worded like the chat surfaces: recurring rows read
 * `Every hour · next 6:00 PM`, one-time rows `Sends Tue 9:00 AM`. Omitted
 * when the time cannot be formatted so the popover keeps its generic line.
 */
function scheduledMessageLabelField(message: ScheduledQueuedMessage): {
  scheduleLabel?: string;
} {
  const sendLabel = formatScheduledSendLabel(message.scheduledAt);
  const cadence = formatScheduledCadence(message);
  if (cadence !== null) {
    return {
      scheduleLabel: sendLabel ? `${cadence} · next ${sendLabel}` : cadence,
    };
  }
  return sendLabel ? { scheduleLabel: `Sends ${sendLabel}` } : {};
}

/** Popover rows for a row's active script runs (the rocket badge). */
export function buildScriptRunBadgeRows(
  runs: readonly ScriptRunState[],
): RunBadgeRow[] {
  return runs.map((run, index): RunBadgeRow => {
    const isStopping = run.status === 'stopping';
    return {
      id: `${run.scriptName}-${run.target}-${run.repoId ?? ''}-${index}`,
      label: run.repoName ? `${run.label} · ${run.repoName}` : run.label,
      statusText: isStopping ? 'Stopping' : 'Running',
      statusClass: isStopping
        ? OPERATIONAL_STATUS_COLORS.unread.foreground
        : OPERATIONAL_STATUS_COLORS.active.foreground,
      // Stopping is still running.
      dotTone: 'working',
    };
  });
}

/** Popover rows for a row's running hooks (the link badge). */
export function buildHookRunBadgeRows(
  runs: readonly HookRunState[],
): RunBadgeRow[] {
  return runs.map(
    (run, index): RunBadgeRow => ({
      id: `${run.triggerName}-${run.target}-${run.repoId ?? ''}-${index}`,
      label: run.repoName ? `${run.label} · ${run.repoName}` : run.label,
      statusText: 'Running',
      statusClass: OPERATIONAL_STATUS_COLORS.active.foreground,
      dotTone: 'working',
    }),
  );
}
