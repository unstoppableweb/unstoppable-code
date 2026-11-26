// Compact eye-tracking icon button used by pipeline cards, the pipeline
// details modal, and chat panels. The button is intentionally driven by a
// prop-supplied watcher list so the caller controls filtering and the
// component stays stateless apart from local tooltip/modal toggles.
//
// The button:
//  - renders nothing when `watchers.length === 0` (so unwatched surfaces
//    don't reserve dead space),
//  - shows a count badge when the surface has more than one matching
//    watcher,
//  - opens a hover/focus preview (the shared `HoverCard`) listing up
//    to five rows so the user can decide whether to click in,
//  - opens the shared `WatcherManagementModal` on click, which handles all
//    jump and delete interactions.

import { Button } from '@canopy/ui-shared/primitives/Button';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import {
  ChatComposerToolbarChip,
  DrawerWatcherControl,
  HoverCard,
} from '@canopy/ui-shared';
import { AppAdvisorWatcherIcon, WatcherEyeIcon } from '@canopy/ui-shared/icons';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import {
  formatGitHubRunSampleLabel,
  githubRunSampleOverflow,
  githubWatcherTargetDisplay,
  liveWatcherDestinationTitle,
  triggerTitle,
  watcherDestinationDisplay,
  watcherOwnerDelegateDisplay,
  watcherTargetDisplay,
} from './watcherDisplay';
import { formatRelativeTime } from '@/lib/format';
import { WatcherManagementModal } from './WatcherManagementModal';

export interface WatcherManagementButtonProps {
  /** Pre-filtered watcher list this button manages. */
  watchers: AppAdvisorWatcherSummary[];
  /** Title rendered in the management modal header. */
  modalTitle: string;
  /** Body text rendered in the modal when no watchers remain. */
  modalEmptyMessage: string;
  /** Accessible label for the icon button. */
  ariaLabel: string;
  /** Optional visible label for the drawer action. */
  actionLabel?: string;
  /** `data-testid` for the button. */
  dataTestId: string;
  /** Icon used in the button. Defaults to the target-side eye tracking icon. */
  icon?: 'eye' | 'bigtop';
  /** Upper tooltip title. Defaults to the target-side copy. */
  tooltipTitle?: string;
  /** Extra classes appended to the button container (optional). */
  className?: string;
  /**
   * `composer-chip` draws the chat composer's capsule chip beside +, the
   * Plan chip's shape: the glyph alone in a circle for one watcher, the
   * glyph and the count past one. `icon` (the default) is the compact icon
   * button other surfaces use.
   */
  appearance?: 'icon' | 'composer-chip' | 'drawer';
  /**
   * Optional override for the jump-to-chat handler. Forwarded to the modal.
   * Useful for the Automations Watchers tab which wants a different
   * close/navigation flow than the default management button.
   */
  onJumpToChat?: (
    watcher: AppAdvisorWatcherSummary,
  ) => { ok: true } | { ok: false; error: string };
}

const MAX_TOOLTIP_ROWS = 5;
// One grouped GitHub watcher is a single tooltip row; inside that row we sample
// at most three of its watched runs before collapsing the rest into `+N more`.
const MAX_TOOLTIP_SAMPLE_RUNS = 3;

export function WatcherManagementButton({
  watchers,
  modalTitle,
  modalEmptyMessage,
  ariaLabel,
  actionLabel,
  dataTestId,
  icon = 'eye',
  tooltipTitle = 'Active watchers',
  className,
  appearance = 'icon',
  onJumpToChat,
}: WatcherManagementButtonProps): JSX.Element | null {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const visibleTooltipRows = useMemo(
    () => watchers.slice(0, MAX_TOOLTIP_ROWS),
    [watchers],
  );
  const liveDestinationTitles = useChatSidebarStore(
    useShallow((s) =>
      visibleTooltipRows.map((watcher) =>
        liveWatcherDestinationTitle(s.worktrees, watcher.destination),
      ),
    ),
  );
  const overflowCount = Math.max(0, watchers.length - MAX_TOOLTIP_ROWS);

  // When the underlying list goes empty (e.g. the last watcher was deleted
  // while the modal was open) close the modal so the caller can unmount us.
  useEffect(() => {
    if (watchers.length === 0) {
      setTooltipOpen(false);
      setModalOpen(false);
    }
  }, [watchers.length]);

  const closeModal = useCallback((): void => {
    setModalOpen(false);
  }, []);

  if (watchers.length === 0) return null;

  const openModal = (): void => {
    setTooltipOpen(false);
    setModalOpen(true);
  };

  if (appearance === 'drawer')
    return (
      <>
        <DrawerWatcherControl
          count={watchers.length}
          label={actionLabel}
          ariaLabel={ariaLabel}
          dataTestId={dataTestId}
          heading={tooltipTitle}
          onClick={openModal}
          rows={visibleTooltipRows.map((watcher, index) => {
            const target = watcherTargetDisplay(watcher.target);
            const github = githubWatcherTargetDisplay(watcher.target);
            const sample =
              github?.sample.slice(0, MAX_TOOLTIP_SAMPLE_RUNS) ?? [];
            const owner = watcher.ownerDelegate
              ? watcherOwnerDelegateDisplay(watcher.ownerDelegate)
              : null;
            const more = github
              ? githubRunSampleOverflow(github, sample.length)
              : 0;
            return {
              id: watcher.id,
              name: watcher.label || target.title,
              details: [
                triggerTitle(watcher.trigger),
                `Subscribed chat: ${watcherDestinationDisplay(watcher.destination, liveDestinationTitles[index])}`,
                ...(owner
                  ? [
                      `Delegate: ${owner.name}${owner.detail ? ` · ${owner.detail}` : ''}`,
                    ]
                  : []),
                ...(github?.subtitle ? [github.subtitle] : []),
                ...sample.map(formatGitHubRunSampleLabel),
                ...(more > 0 ? [`+${more} more`] : []),
              ],
            };
          })}
        />
        {modalOpen && (
          <WatcherManagementModal
            title={modalTitle}
            emptyMessage={modalEmptyMessage}
            watchers={watchers}
            onClose={closeModal}
            onJumpToChat={onJumpToChat}
          />
        )}
      </>
    );

  const preview = (
    <div className="flex flex-col gap-1.5 text-xs font-normal fg-primary">
      <div className="text-xs font-normal fg-secondary">{tooltipTitle}</div>
      <ul className="flex flex-col gap-1.5">
        {visibleTooltipRows.map((watcher, index) => {
          const target = watcherTargetDisplay(watcher.target);
          const github = githubWatcherTargetDisplay(watcher.target);
          const sampleRows =
            github?.sample.slice(0, MAX_TOOLTIP_SAMPLE_RUNS) ?? [];
          const sampleOverflow = github
            ? githubRunSampleOverflow(github, sampleRows.length)
            : 0;
          const owner = watcher.ownerDelegate
            ? watcherOwnerDelegateDisplay(watcher.ownerDelegate)
            : null;
          return (
            <li
              key={watcher.id}
              className="flex flex-col gap-0.5 text-xs leading-tight"
            >
              <span className="truncate font-medium fg-primary">
                {watcher.label || target.title}
              </span>
              <span className="truncate text-2xs fg-secondary">
                {triggerTitle(watcher.trigger)}
              </span>
              <span
                className="truncate text-2xs fg-secondary"
                data-testid={`${dataTestId}-destination-${watcher.id}`}
              >
                Subscribed chat:{' '}
                {watcherDestinationDisplay(
                  watcher.destination,
                  liveDestinationTitles[index],
                )}
              </span>
              {owner && (
                <span
                  className="truncate text-2xs fg-secondary"
                  data-testid={`${dataTestId}-owner-${watcher.id}`}
                >
                  Delegate: {owner.name}
                  {owner.detail ? ` · ${owner.detail}` : ''}
                </span>
              )}
              {github ? (
                <>
                  {github.subtitle && (
                    <span className="truncate text-2xs fg-secondary">
                      {github.subtitle}
                    </span>
                  )}
                  {sampleRows.map((run) => (
                    <span
                      key={`${run.repository}#${run.runId}`}
                      className="truncate text-3xs fg-secondary/80"
                    >
                      {formatGitHubRunSampleLabel(run)}
                    </span>
                  ))}
                  {sampleOverflow > 0 && (
                    <span className="text-3xs fg-secondary/80">
                      +{sampleOverflow} more
                    </span>
                  )}
                </>
              ) : (
                <span className="text-3xs fg-secondary/80">
                  {formatRelativeTime(watcher.createdAt)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {overflowCount > 0 && (
        <div className="text-2xs fg-secondary">+{overflowCount} more</div>
      )}
    </div>
  );

  return (
    <>
      <HoverCard
        open={tooltipOpen}
        onOpenChange={setTooltipOpen}
        dataTestId={`${dataTestId}-tooltip`}
        surfacePadding="card"
        surfaceClassName="w-72"
        triggerWrapperClassName="shrink-0"
        content={preview}
      >
        {appearance === 'composer-chip' ? (
          // The wrapper carries the hover preview and stops the click from
          // reaching the composer, which would refocus its editor.
          <span
            className="inline-flex shrink-0"
            onClick={(event): void => event.stopPropagation()}
          >
            <ChatComposerToolbarChip
              variant="capsule"
              active
              activeTone="status-active"
              ariaLabel={ariaLabel}
              ariaHasPopup="dialog"
              dataTestId={dataTestId}
              onClick={openModal}
              icon={
                icon === 'bigtop' ? (
                  <AppAdvisorWatcherIcon size="sm" />
                ) : (
                  <WatcherEyeIcon size="sm" />
                )
              }
              {...(watchers.length > 1
                ? {
                    trailing: (
                      <span
                        data-testid={`${dataTestId}-count`}
                        className="tabular-nums"
                      >
                        {watchers.length}
                      </span>
                    ),
                  }
                : {})}
            />
          </span>
        ) : (
          <span className={className}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly={watchers.length === 1}
              aria-label={ariaLabel}
              data-testid={dataTestId}
              onClick={(event): void => {
                // Pipeline rows and chat panels treat the surrounding click area as
                // their own selection target — stop propagation so opening the
                // watcher modal does not also open the pipeline detail modal /
                // refocus the chat composer.
                event.stopPropagation();
                openModal();
              }}
            >
              {icon === 'bigtop' ? (
                <AppAdvisorWatcherIcon size="sm" />
              ) : (
                <WatcherEyeIcon size="sm" />
              )}
              {watchers.length > 1 && (
                <span data-testid={`${dataTestId}-count`}>
                  {watchers.length}
                </span>
              )}
            </Button>
          </span>
        )}
      </HoverCard>

      {modalOpen && (
        <WatcherManagementModal
          title={modalTitle}
          emptyMessage={modalEmptyMessage}
          watchers={watchers}
          onClose={closeModal}
          onJumpToChat={onJumpToChat}
        />
      )}
    </>
  );
}
