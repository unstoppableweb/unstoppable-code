// Turn-level thumbs up/down hosts (CAN-1521).
//
// Extracted out of `TurnGroupRenderer` so that file grows a handful of lines
// rather than ~80. The control host owns the store read + rate dispatch; the
// dialog host owns the thumbs-down detail step.
import {
  useCallback,
  useState,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { TurnFeedbackControl, TurnFeedbackDialog } from '@canopy/ui-shared';
import type { TurnFeedbackRating } from '@canopy/protocol/turn-feedback';
import { useChatStore, useChatTabRenderState } from '@/stores/chatStore';
import { Tooltip } from '@canopy/ui-shared/components';
import { FeedbackModal } from '../feedback/FeedbackModal';

export interface TurnFeedbackTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Reads only primitives out of the store (`rating`, `syncState`) so the
 * `incremental-turn-groups` referential cache is not defeated by a fresh
 * object identity on every store update.
 */
function useTurnFeedbackState(
  target: TurnFeedbackTarget,
  userMessageId: string,
): {
  rating?: TurnFeedbackRating;
  syncState?: 'pending' | 'synced' | 'failed';
} {
  return useChatTabRenderState(
    target,
    useShallow(({ tab }) => {
      if (!tab || tab.kind === 'file') return {};
      const entry = tab.turnFeedback?.[userMessageId];
      if (!entry) return {};
      return { rating: entry.rating, syncState: entry.syncState };
    }),
  );
}

export function TurnFeedbackControlHost({
  target,
  userMessageId,
  onRequestDetail,
}: {
  target: TurnFeedbackTarget;
  userMessageId: string;
  /** Called after a thumbs-down is recorded, to open the detail dialog. */
  onRequestDetail: () => void;
}): JSX.Element {
  const { rating, syncState } = useTurnFeedbackState(target, userMessageId);
  const setTurnFeedback = useChatStore((s) => s.setTurnFeedback);

  const handleRate = useCallback(
    (next: TurnFeedbackRating | null): void => {
      // The rating is recorded immediately and independently of the dialog,
      // so skipping or dismissing the dialog can never undo it.
      void setTurnFeedback(userMessageId, next, target);
      if (next === 'down') {
        onRequestDetail();
      }
    },
    [onRequestDetail, setTurnFeedback, target, userMessageId],
  );

  const renderTooltip = useCallback(
    (node: ReactElement, label: string): ReactNode => (
      <Tooltip
        label={label}
        description="Rate this turn so we know what to improve."
      >
        <span className="flex">{node}</span>
      </Tooltip>
    ),
    [],
  );

  return (
    <TurnFeedbackControl
      {...(rating ? { rating } : {})}
      {...(syncState ? { syncState } : {})}
      onRate={handleRate}
      renderTooltip={renderTooltip}
    />
  );
}

export function TurnFeedbackDialogHost({
  target,
  userMessageId,
  onClose,
}: {
  target: TurnFeedbackTarget;
  userMessageId: string;
  onClose: () => void;
}): JSX.Element {
  const submitTurnFeedbackDetail = useChatStore(
    (s) => s.submitTurnFeedbackDetail,
  );
  // The app-level bug-report modal has no global open mechanism (it is local
  // state in `SidebarAccountMenu`), so the "send logs instead" link renders it
  // here directly rather than introducing a cross-component event bus.
  const [appFeedbackOpen, setAppFeedbackOpen] = useState(false);

  if (appFeedbackOpen) {
    return <FeedbackModal onClose={onClose} />;
  }

  return (
    <TurnFeedbackDialog
      onClose={onClose}
      onSubmit={(detail): void => {
        void submitTurnFeedbackDetail(userMessageId, detail, target);
        onClose();
      }}
      onOpenAppFeedback={(): void => {
        setAppFeedbackOpen(true);
      }}
    />
  );
}

/**
 * Convenience wrapper pairing the control with its dialog, so the call site in
 * `TurnGroupRenderer` is a single element.
 */
export function TurnFeedbackSlot({
  target,
  userMessageId,
}: {
  target: TurnFeedbackTarget;
  userMessageId: string;
}): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <TurnFeedbackControlHost
        target={target}
        userMessageId={userMessageId}
        onRequestDetail={(): void => {
          setDialogOpen(true);
        }}
      />
      {dialogOpen && (
        <TurnFeedbackDialogHost
          target={target}
          userMessageId={userMessageId}
          onClose={(): void => {
            setDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
