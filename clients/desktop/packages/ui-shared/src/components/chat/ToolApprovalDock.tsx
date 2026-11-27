'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ApprovalPromptDecision,
  ApprovalPromptRequest,
} from '@canopy/protocol/approvals';
import {
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
} from '../../icons/AppIcons';
import { getDocument } from '../../lib/window-registry';
import { Button } from '../../primitives/Button';
import {
  STATUS_ANNOUNCEMENT_DURATION_MS,
  type StatusAnnouncement,
  StatusAnnouncer,
} from './StatusAnnouncer';
import {
  ToolApprovalCard,
  type ToolApprovalCardHandle,
} from './ToolApprovalCard';
import { approvalAnnouncementText } from './approval-content-preview';
import { SecretInputApprovalCard } from './SecretInputApprovalCard';

/** The approval a dock displays, for hosts that report UI state. */
export interface ToolApprovalDockDisplayed {
  request: ApprovalPromptRequest;
  index: number;
  count: number;
}

export interface ToolApprovalDockProps {
  /**
   * The active chat's identity. Selection, announcements, and focus
   * ownership never carry over from another chat.
   */
  chatKey: string;
  /** The chat's pending approvals in arrival order. */
  pending: readonly ApprovalPromptRequest[];
  /** Records a decision; the host owns the request and what it does. */
  onRespond: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
  /**
   * Whether a newly displayed card may take focus now. The desktop composer
   * applies `canApprovalTakeFocus` to the live focus and draft. Without it
   * the dock never takes focus on arrival.
   */
  canTakeFocus?: () => boolean;
  /**
   * Returns focus to the composer, keeping its draft, after the last card
   * that owned focus is answered. The host declines when it is hidden.
   */
  focusComposer?: () => void;
  /**
   * Allows a secret-input approval with its secret, through the host's
   * dedicated channel. Without it such an approval can only be denied.
   */
  onRespondSecretInput?: (
    requestId: string,
    bindingId: string,
    secret: string,
  ) => Promise<void>;
  /** Reports the displayed approval whenever it changes. */
  onDisplayedChange?: (displayed: ToolApprovalDockDisplayed | null) => void;
  /** Card capabilities; see `ToolApprovalCardProps`. */
  ruleScopes?: boolean;
  denyReason?: boolean;
  denyAndStop?: boolean;
  reasonMaxLength?: number;
  readOnlyHint?: ReactNode;
}

interface ArrivalQueue {
  chatKey: string;
  items: readonly StatusAnnouncement[];
}

/**
 * Polite announcements for newly pending approvals, one per request id and
 * chat activation (CAN-4997). Arrivals behind the displayed card are
 * announced too; simultaneous arrivals queue so a later one never overwrites
 * an earlier one before it is heard. Navigation, rerenders, and Strict Mode
 * effect replays announce nothing new; a request that resolves drops out of
 * the queue, and a chat switch discards it.
 */
function useApprovalArrivalAnnouncement(
  chatKey: string,
  pending: readonly ApprovalPromptRequest[],
): StatusAnnouncement | null {
  const [queue, setQueue] = useState<ArrivalQueue>({ chatKey, items: [] });
  const announcedRef = useRef<{ chatKey: string; ids: Set<string> }>({
    chatKey,
    ids: new Set(),
  });

  useEffect(() => {
    if (announcedRef.current.chatKey !== chatKey) {
      announcedRef.current = { chatKey, ids: new Set() };
    }
    const announced = announcedRef.current.ids;
    const pendingIds = new Set(pending.map((p) => p.requestId));
    const arrivals = pending.filter((p) => !announced.has(p.requestId));
    for (const arrival of arrivals) announced.add(arrival.requestId);
    setQueue((previous) => {
      const kept =
        previous.chatKey === chatKey
          ? previous.items.filter((item) => pendingIds.has(String(item.id)))
          : [];
      if (
        previous.chatKey === chatKey &&
        arrivals.length === 0 &&
        kept.length === previous.items.length
      ) {
        return previous;
      }
      return {
        chatKey,
        items: [
          ...kept,
          ...arrivals.map(
            (p): StatusAnnouncement => ({
              id: p.requestId,
              text: approvalAnnouncementText(p),
            }),
          ),
        ],
      };
    });
  }, [chatKey, pending]);

  const head = queue.chatKey === chatKey ? (queue.items[0] ?? null) : null;
  const headId = head?.id;
  // Each announcement holds the region for its full display time, then the
  // next one takes over.
  useEffect(() => {
    if (headId === undefined) return undefined;
    const advance = setTimeout(() => {
      setQueue((previous) =>
        previous.items[0]?.id === headId
          ? { chatKey: previous.chatKey, items: previous.items.slice(1) }
          : previous,
      );
    }, STATUS_ANNOUNCEMENT_DURATION_MS);
    return (): void => {
      clearTimeout(advance);
    };
  }, [headId]);

  return head;
}

/** Focus was lost rather than moved: nothing, the body, or a detached node. */
function focusIsUnowned(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || !active.isConnected;
}

/** Lost, or left on a dock button that just became disabled. */
function focusDropped(doc: Document, host: HTMLElement | null): boolean {
  if (focusIsUnowned(doc)) return true;
  const active = doc.activeElement;
  return (
    active instanceof HTMLButtonElement &&
    active.disabled &&
    host?.contains(active) === true
  );
}

interface DockSelection {
  chatKey: string;
  index: number;
  requestId: string | null;
}

/**
 * Docked tool-approval surface rendered directly above the chat composer
 * (see `docs/tool-approvals.md` "The prompt flow"). Replaces the previous
 * in-transcript `ToolApprovalCard` mount inside `ChatBlockRenderer.tsx`: the
 * card no longer needs to match itself to a specific `tool_use` block by
 * `toolUseId`, because the dock shows every pending approval for the active
 * chat regardless of transcript position (main-turn or subagent-originated).
 *
 * With exactly one pending approval, the dock renders just the card. With
 * two or more (restart-hydrated pendings, or a mixture of main-turn and
 * subagent requests queued up together), a header row shows a non-wrapping
 * "Approval N of M" count plus ← → navigation, and the currently-selected
 * approval's card renders below it.
 *
 * Selection is local component state — the displayed request id plus its
 * index into the chat's pending-approvals array, ordered by store insertion
 * order (stable arrival order; hydration re-populates the store in
 * persisted-array order, so a restored dock's ordering is deterministic
 * too). Selection resets to the first approval when the chat changes.
 * Removing another request keeps the displayed one on screen. Resolving the
 * currently-viewed approval removes it from the record, the list shifts up
 * beneath the same index, clamped to the list length, and the user lands on
 * whatever is now at that position — the next unresolved approval, or the
 * new last approval if the one they resolved was previously last. When the
 * list empties entirely the card unmounts; the empty live region stays so
 * the next arrival's announcement is heard.
 *
 * Keyboard focus (CAN-4997, `docs/tool-approvals.md`): a newly displayed
 * card takes focus on its primary action only when `canTakeFocus` allows
 * it. When the card that owned focus is answered or removed, focus moves to
 * the next displayed card, or to the composer after the last one. Ownership
 * is tracked from focus events, so it is known before the card's DOM is
 * gone: a focus inside the dock's React tree (including the card's portaled
 * menus and modal) claims it, and a focus anywhere else releases it, which
 * preserves focus the user moved elsewhere while a response was in flight.
 * Entering a chat announces its approvals but leaves focus to the
 * composer's own startup focus.
 */
export const ToolApprovalDock = memo(function ToolApprovalDock({
  chatKey,
  pending,
  onRespond,
  onRespondSecretInput,
  canTakeFocus,
  focusComposer,
  onDisplayedChange,
  ruleScopes,
  denyReason,
  denyAndStop,
  reasonMaxLength,
  readOnlyHint,
}: ToolApprovalDockProps): JSX.Element {
  // The displayed request is followed by identity, so removing another
  // request keeps it on screen; the index is the fallback when the displayed
  // request itself goes. Another chat's selection never carries over.
  const [selection, setSelection] = useState<DockSelection>({
    chatKey,
    index: 0,
    requestId: null,
  });
  const ownSelection =
    selection.chatKey === chatKey
      ? selection
      : { chatKey, index: 0, requestId: null };
  const selectedById =
    ownSelection.requestId === null
      ? -1
      : pending.findIndex((p) => p.requestId === ownSelection.requestId);
  const activeIndex =
    pending.length === 0
      ? 0
      : selectedById >= 0
        ? selectedById
        : Math.min(ownSelection.index, pending.length - 1);
  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex < pending.length - 1;
  const current = pending[activeIndex];
  const currentRequestId = current?.requestId ?? null;
  if (
    selection.chatKey !== chatKey ||
    selection.index !== activeIndex ||
    selection.requestId !== currentRequestId
  ) {
    setSelection({ chatKey, index: activeIndex, requestId: currentRequestId });
  }

  const select = useCallback(
    (index: number): void => {
      setSelection({
        chatKey,
        index,
        requestId: pending[index]?.requestId ?? null,
      });
    },
    [chatKey, pending],
  );
  const goPrev = useCallback((): void => {
    select(Math.max(0, activeIndex - 1));
  }, [activeIndex, select]);
  const goNext = useCallback((): void => {
    select(Math.min(pending.length - 1, activeIndex + 1));
  }, [activeIndex, pending.length, select]);

  const announcement = useApprovalArrivalAnnouncement(chatKey, pending);

  const hostRef = useRef<HTMLDivElement>(null);
  const cardHandleRef = useRef<ToolApprovalCardHandle>(null);
  const ownsFocusRef = useRef(false);
  const displayedRef = useRef<{
    chatKey: string | null;
    requestId: string | null;
  }>({ chatKey: null, requestId: null });

  // A focus anywhere releases ownership in the capture phase; the dock's
  // own React `onFocus` (bubbling, so after this) claims it back when the
  // focus landed inside the dock's tree.
  useEffect(() => {
    const doc = getDocument(hostRef.current);
    const release = (): void => {
      ownsFocusRef.current = false;
    };
    doc.addEventListener('focusin', release, true);
    return (): void => {
      doc.removeEventListener('focusin', release, true);
    };
  }, []);
  const claimFocus = useCallback((): void => {
    ownsFocusRef.current = true;
  }, []);

  const pendingIdsKey = pending.map((p) => p.requestId).join('\u0000');
  useLayoutEffect(() => {
    const previous = displayedRef.current;
    displayedRef.current = { chatKey, requestId: currentRequestId };
    const doc = getDocument(hostRef.current);
    if (previous.chatKey !== chatKey) {
      ownsFocusRef.current = false;
      return;
    }
    const previousStillPending =
      previous.requestId !== null &&
      pendingIdsKey.split('\u0000').includes(previous.requestId);
    if (previous.requestId === currentRequestId || previousStillPending) {
      // The same card, or arrow navigation: focus stays where it is unless a
      // count change removed or disabled the navigation button that had it.
      // Then it lands on the displayed card instead of the body.
      if (
        currentRequestId !== null &&
        ownsFocusRef.current &&
        focusDropped(doc, hostRef.current)
      ) {
        cardHandleRef.current?.focusPrimaryAction();
      }
      return;
    }
    if (
      previous.requestId !== null &&
      ownsFocusRef.current &&
      focusDropped(doc, hostRef.current)
    ) {
      if (currentRequestId !== null) {
        cardHandleRef.current?.focusPrimaryAction();
      } else {
        focusComposer?.();
      }
      return;
    }
    if (currentRequestId !== null && canTakeFocus?.() === true) {
      cardHandleRef.current?.focusPrimaryAction();
    }
  }, [canTakeFocus, chatKey, currentRequestId, focusComposer, pendingIdsKey]);

  const count = pending.length;
  useEffect(() => {
    onDisplayedChange?.(
      current ? { request: current, index: activeIndex, count } : null,
    );
  }, [activeIndex, count, current, onDisplayedChange]);
  return (
    <div ref={hostRef} onFocus={claimFocus}>
      {/* Mounted while empty so the first arrival is heard. The text names
          the command or path, so it is blocked from session replay. */}
      <StatusAnnouncer
        announcement={announcement}
        privacy="block"
        data-testid="tool-approval-announcer"
      />
      {current && (
        // The dock chrome is recorded; the card blocks the command, path, or
        // input the agent asks to run.
        <div
          data-testid="tool-approval-dock"
          className="pb-1.5 flex flex-col gap-1"
        >
          {pending.length > 1 && (
            <div className="flex items-center justify-between px-0.5">
              <span
                data-testid="tool-approval-count"
                className="text-2xs fg-secondary"
              >
                Approval {activeIndex + 1} of {pending.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  data-testid="tool-approval-nav-prev"
                  aria-label="Previous approval"
                  disabled={!canGoPrev}
                  onClick={goPrev}
                >
                  <AppCatalogChevronLeftMediumIcon
                    aria-hidden="true"
                    size="sm"
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  data-testid="tool-approval-nav-next"
                  aria-label="Next approval"
                  disabled={!canGoNext}
                  onClick={goNext}
                >
                  <AppCatalogChevronRightMediumIcon
                    aria-hidden="true"
                    size="sm"
                  />
                </Button>
              </div>
            </div>
          )}
          {current.secretInput ? (
            <SecretInputApprovalCard
              key={current.requestId}
              pending={{ ...current, secretInput: current.secretInput }}
              onRespond={onRespond}
              onRespondSecretInput={onRespondSecretInput}
              focusHandleRef={cardHandleRef}
              readOnlyHint={readOnlyHint}
            />
          ) : (
            <ToolApprovalCard
              key={current.requestId}
              pending={current}
              onRespond={onRespond}
              focusHandleRef={cardHandleRef}
              ruleScopes={ruleScopes}
              denyReason={denyReason}
              denyAndStop={denyAndStop}
              reasonMaxLength={reasonMaxLength}
              readOnlyHint={readOnlyHint}
            />
          )}
        </div>
      )}
    </div>
  );
});
