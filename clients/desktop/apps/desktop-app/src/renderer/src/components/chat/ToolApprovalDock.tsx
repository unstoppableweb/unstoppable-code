import { memo, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import {
  ToolApprovalDock as SharedToolApprovalDock,
  type ToolApprovalDockDisplayed,
} from '@canopy/ui-shared/components';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';

const EMPTY_PENDING_APPROVALS: ApprovalRequestEvent[] = [];
const PAIRED_COMPUTER_APPROVAL_READ_ONLY_HINT =
  'Answer on the paired computer.';

export interface ToolApprovalDockProps {
  /** Complete active-chat identity used to isolate pending approvals. */
  projectId: string;
  worktreeId: string;
  chatId: string;
  /**
   * Whether a newly displayed card may take focus now. The composer applies
   * `canApprovalTakeFocus` (`approval-focus-policy.ts`) to the live focus and
   * draft. Without it the dock never takes focus on arrival.
   */
  canTakeFocus?: () => boolean;
  /**
   * Returns focus to the composer, keeping its draft, after the last card
   * that owned focus is answered. The host declines when it is hidden.
   */
  focusComposer?: () => void;
}

/**
 * The chat's pending approvals from the store, in the shared approval dock
 * (`@canopy/ui-shared`, see `docs/tool-approvals.md` "The prompt flow"), and
 * the displayed one reported to the App Advisor's UI state.
 */
export const ToolApprovalDock = memo(function ToolApprovalDock({
  projectId,
  worktreeId,
  chatId,
  canTakeFocus,
  focusComposer,
}: ToolApprovalDockProps): JSX.Element {
  const pending = useChatStore(
    useShallow((s): ApprovalRequestEvent[] => {
      const forChat = Object.values(s.pendingApprovals).filter(
        (p) =>
          p.projectId === projectId &&
          p.worktreeId === worktreeId &&
          p.chatId === chatId,
      );
      return forChat.length > 0 ? forChat : EMPTY_PENDING_APPROVALS;
    }),
  );
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const { chatApprovalMode, chatApprovalRespond } = useScopeCapabilities({
    projectId,
  });
  // Approval rules live where approval modes do: a cloud chat keeps neither,
  // so its card offers Allow once and Deny only, as the web's does.
  const ruleScopes = chatApprovalMode === true;
  const readOnlyHint =
    chatApprovalRespond === false
      ? PAIRED_COMPUTER_APPROVAL_READ_ONLY_HINT
      : undefined;
  const respondToSecretApproval = useChatStore(
    (s) => s.respondToSecretApproval,
  );
  const [displayed, setDisplayed] = useState<ToolApprovalDockDisplayed | null>(
    null,
  );
  const current = displayed
    ? pending.find((p) => p.requestId === displayed.request.requestId)
    : undefined;

  useCurrentUiStateReporter(
    'chat.toolApprovalDock',
    displayed && current
      ? {
          visible: true,
          pendingCount: displayed.count,
          selectedIndex: displayed.index,
          provider: current.provider,
          requestKind: current.details.kind,
          subagent: Boolean(current.subagentId),
        }
      : null,
  );
  return (
    <SharedToolApprovalDock
      chatKey={`${projectId}\u0000${worktreeId}\u0000${chatId}`}
      pending={pending}
      onRespond={respondToApproval}
      onRespondSecretInput={respondToSecretApproval}
      canTakeFocus={canTakeFocus}
      focusComposer={focusComposer}
      onDisplayedChange={setDisplayed}
      ruleScopes={ruleScopes}
      {...(readOnlyHint !== undefined ? { readOnlyHint } : {})}
    />
  );
});
