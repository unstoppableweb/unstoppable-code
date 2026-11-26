'use client';

import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { useMemo, type JSX, type ReactNode } from 'react';
import {
  selectAwaitingApprovalWorktrees,
  selectInProgressChatWorktrees,
  selectRunningPipelineRuns,
  selectUnreadPipelineRuns,
  selectUnreadWorktrees,
  selectWorktreeLabel,
  useOverviewStore,
  useCapabilities,
  type OverviewState,
} from '@canopy/app-state';
import type { RemoteControlPipelineRunProjection } from '@canopy/protocol/remote-control/shell';
import {
  LoadingSpinner,
  PageHeader,
  Count,
  Heading,
} from '@canopy/ui-shared/components';
import { PlanModeIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { OverviewCard } from './OverviewCard';

const OVERVIEW_DESCRIPTION =
  'What needs your attention across every project and worktree.';

/**
 * The write-once home / overview dashboard — "what needs your attention across
 * every workspace and worktree." Aggregates the neutral shell snapshot via the
 * shared {@link useOverviewStore} selectors (CAN-755) into read-only attention
 * sections for chats, approvals, pipelines, and capability-gated host
 * notifications. Rendered identically by desktop and the web home page (which
 * composes it *alongside* its web-only Download/Team/Invite panels, never
 * inside).
 *
 * Every card navigates to its worktree through the injected
 * {@link OverviewProps.onSelectWorktree} — the host adapter turns that into the
 * real navigation + selection.
 *
 * Notifications use a host-neutral render slot. The capability contract decides
 * whether the section exists; the host owns notification state and interaction
 * semantics, so local desktop notifications and future relayed notifications
 * can share this layout without leaking either transport into `ui-app`.
 * - "Unread pipelines" (terminal-status runs) is modelled by
 *   `selectUnreadPipelineRuns` (CAN-756). Desktop adoption via a snapshot
 *   projector — which also applies the per-worktree seen-state and card cap —
 *   is CAN-757; web adoption is CAN-758.
 * - "Awaiting approval" is a first-class section here (the store models it).
 */
export interface OverviewProps {
  /**
   * Navigate to a worktree. Both ids are passed because worktree ids are scoped
   * to their workspace and cannot be resolved safely on their own.
   */
  readonly onSelectWorktree: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /** Open a specific pipeline run; falls back to worktree navigation. */
  readonly onSelectPipelineRun?: (
    run: RemoteControlPipelineRunProjection,
    unread: boolean,
  ) => void;
  /** Dismiss a host-projected unread chat card. */
  readonly onDismissWorktree?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /** Dismiss a host-projected unread pipeline card. */
  readonly onDismissPipelineRun?: (
    run: RemoteControlPipelineRunProjection,
  ) => void;
  /** Host-neutral slot for progress, job navigation, or other run details. */
  readonly renderPipelineRunDetails?: (
    run: RemoteControlPipelineRunProjection,
    unread: boolean,
  ) => ReactNode;
  /** Host-owned notification content, rendered only when capability allows. */
  readonly notifications?: ReactNode;
  /**
   * Host-owned recommendations rendered beside unread pipelines. Hosts must
   * pass `undefined` when the slot is empty; a node that renders `null` still
   * reserves the wrapper's grid cell.
   */
  readonly recommendations?: ReactNode;
  readonly className?: string;
  /** Full-page hosts use the shared page gutter and heading scale. */
  readonly layout?: 'panel' | 'page';
}

export interface OverviewSectionHeaderProps {
  readonly title: string;
  readonly count?: number;
  readonly countLabel?: string;
  readonly actions?: ReactNode;
}

export function OverviewSectionHeader({
  title,
  count,
  countLabel,
  actions,
}: OverviewSectionHeaderProps): JSX.Element {
  return (
    <div className="pb-1.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Heading level={2} variant="label">
          {title}
        </Heading>
        {count !== undefined && count > 0 && (
          <span aria-label={countLabel ?? `${count} ${title.toLowerCase()}`}>
            <Count value={count} />
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}

function Section({
  title,
  count,
  emptyLabel,
  dataTestId,
  children,
}: {
  title: string;
  count?: number;
  emptyLabel?: string;
  dataTestId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="min-w-0" data-testid={dataTestId}>
      <OverviewSectionHeader title={title} count={count} />
      {count === 0 ? (
        <p className="text-xs fg-secondary" data-testid={`${dataTestId}-empty`}>
          {emptyLabel ?? 'Nothing to show.'}
        </p>
      ) : (
        <div className="max-h-96 grid grid-cols-1 content-start gap-1.5 overflow-y-auto">
          {children}
        </div>
      )}
    </section>
  );
}

export function Overview({
  onSelectWorktree,
  onSelectPipelineRun,
  onDismissWorktree,
  onDismissPipelineRun,
  renderPipelineRunDetails,
  notifications,
  recommendations,
  className,
  layout = 'panel',
}: OverviewProps): JSX.Element {
  // Selecting the whole store is stable: zustand only allocates a new state
  // object on `hydrate` (`set({ snapshot })`), so the memos below recompute
  // exactly when the snapshot changes and hold their array identity otherwise.
  const state: OverviewState = useOverviewStore((s) => s);
  const capabilities = useCapabilities();

  const unread = useMemo(() => selectUnreadWorktrees(state), [state]);
  const inProgress = useMemo(
    () => selectInProgressChatWorktrees(state),
    [state],
  );
  const awaiting = useMemo(
    () => selectAwaitingApprovalWorktrees(state),
    [state],
  );
  const pipelines = useMemo(() => selectRunningPipelineRuns(state), [state]);
  const unreadPipelines = useMemo(
    () => selectUnreadPipelineRuns(state),
    [state],
  );
  const chatSummariesBySyntheticWorktree = useMemo(
    () =>
      new Map(
        (state.snapshot?.chatSummaries ?? [])
          .filter((summary) => summary.scope === 'worktree')
          .map((summary) => [summary.chatId, summary]),
      ),
    [state],
  );

  const rootClass = [
    layout === 'page'
      ? 'mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col overflow-auto px-8 pb-8'
      : 'flex h-full min-h-0 flex-col overflow-auto p-4',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} data-testid="overview">
      {layout === 'page' ? (
        <div className="pb-6 empty:hidden">
          <PageHeader title="Overview" description={OVERVIEW_DESCRIPTION} />
        </div>
      ) : (
        <header className="pb-4">
          <Heading level={1} variant="page">
            Overview
          </Heading>
          <p className="text-xs fg-secondary">{OVERVIEW_DESCRIPTION}</p>
        </header>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2">
        <Section
          title="Unread"
          count={unread.length}
          emptyLabel="No unread chats."
          dataTestId="overview-unread"
        >
          {unread.map((worktree) => {
            const summary = chatSummariesBySyntheticWorktree.get(
              worktree.localId,
            );
            return (
              <OverviewCard
                key={worktree.localId}
                label={selectWorktreeLabel(
                  state,
                  worktree.localId,
                  worktree.workspaceLocalId,
                )}
                title={summary?.title ?? 'Unread messages'}
                titleReplayMasked={summary?.title !== undefined}
                subtitle={
                  summary?.description ? (
                    <span className={REPLAY_BLOCK_CLASS}>
                      {summary.description}
                    </span>
                  ) : (
                    <span className="italic opacity-70">
                      No preview available
                    </span>
                  )
                }
                leadingIcon={
                  summary?.planMode ? <PlanModeIcon size="sm" /> : undefined
                }
                badge={
                  worktree.awaitingApproval ? (
                    <Badge
                      tone="warning"
                      data-testid="overview-unread-chat-review-plan-badge"
                    >
                      Review plan
                    </Badge>
                  ) : (
                    <Badge tone="info">Unread</Badge>
                  )
                }
                onClick={(): void =>
                  onSelectWorktree(worktree.workspaceLocalId, worktree.localId)
                }
                onDismiss={
                  onDismissWorktree
                    ? (): void =>
                        onDismissWorktree(
                          worktree.workspaceLocalId,
                          worktree.localId,
                        )
                    : undefined
                }
                dismissLabel="Dismiss chat from overview"
                dataTestId="overview-unread-chat-card"
              />
            );
          })}
        </Section>

        <Section
          title="In progress"
          count={inProgress.length}
          emptyLabel="No chats in progress."
          dataTestId="overview-in-progress"
        >
          {inProgress.map((worktree) => {
            const summary = chatSummariesBySyntheticWorktree.get(
              worktree.localId,
            );
            return (
              <OverviewCard
                key={worktree.localId}
                label={selectWorktreeLabel(
                  state,
                  worktree.localId,
                  worktree.workspaceLocalId,
                )}
                title={summary?.title ?? 'Working…'}
                titleReplayMasked={summary?.title !== undefined}
                subtitle={
                  summary?.description ? (
                    <span className={REPLAY_BLOCK_CLASS}>
                      {summary.description}
                    </span>
                  ) : (
                    <span className="italic opacity-70">
                      Waiting for agent output…
                    </span>
                  )
                }
                leadingIcon={
                  summary?.planMode ? <PlanModeIcon size="sm" /> : undefined
                }
                badge={
                  <Badge tone="info">
                    <LoadingSpinner sizePx={12} />
                    Streaming
                  </Badge>
                }
                onClick={(): void =>
                  onSelectWorktree(worktree.workspaceLocalId, worktree.localId)
                }
                dataTestId="overview-in-progress-chat-card"
              />
            );
          })}
        </Section>

        <Section
          title="Awaiting approval"
          count={awaiting.length}
          emptyLabel="Nothing awaiting approval."
          dataTestId="overview-awaiting"
        >
          {awaiting.map((worktree) => (
            <OverviewCard
              key={worktree.localId}
              label={selectWorktreeLabel(
                state,
                worktree.localId,
                worktree.workspaceLocalId,
              )}
              title="Awaiting your approval"
              onClick={(): void =>
                onSelectWorktree(worktree.workspaceLocalId, worktree.localId)
              }
              dataTestId="overview-awaiting-card"
            />
          ))}
        </Section>

        <Section
          title="Running workflows"
          count={pipelines.length}
          emptyLabel="No workflows running."
          dataTestId="overview-pipelines"
        >
          {pipelines.map((run, i) => {
            const worktreeLocalId = run.worktreeLocalId;
            const workspaceLocalId = run.workspaceLocalId;
            // Prefer stable ids; the composite (name + worktree) is far more
            // reconciliation-stable than a bare index if runs lack `localId`.
            const key =
              run.localId ??
              run.pipelineLocalId ??
              `${run.pipelineName}:${worktreeLocalId ?? ''}:${i}`;
            return (
              <OverviewCard
                key={key}
                label={
                  worktreeLocalId
                    ? selectWorktreeLabel(
                        state,
                        worktreeLocalId,
                        run.workspaceLocalId,
                      )
                    : null
                }
                title={run.pipelineName}
                subtitle={run.status}
                onClick={
                  worktreeLocalId && workspaceLocalId
                    ? (): void =>
                        onSelectPipelineRun
                          ? onSelectPipelineRun(run, false)
                          : onSelectWorktree(workspaceLocalId, worktreeLocalId)
                    : undefined
                }
                dataTestId="overview-in-progress-pipeline-card"
              >
                {renderPipelineRunDetails?.(run, false)}
              </OverviewCard>
            );
          })}
        </Section>

        <Section
          title="Unread workflows"
          count={unreadPipelines.length}
          emptyLabel="No workflows to review."
          dataTestId="overview-unread-pipelines"
        >
          {unreadPipelines.map((run, i) => {
            const worktreeLocalId = run.worktreeLocalId;
            const workspaceLocalId = run.workspaceLocalId;
            const key =
              run.localId ??
              run.pipelineLocalId ??
              `${run.pipelineName}:${worktreeLocalId ?? ''}:${i}`;
            return (
              <OverviewCard
                key={key}
                label={
                  worktreeLocalId
                    ? selectWorktreeLabel(
                        state,
                        worktreeLocalId,
                        run.workspaceLocalId,
                      )
                    : null
                }
                title={run.pipelineName}
                subtitle={run.status}
                onClick={
                  worktreeLocalId && workspaceLocalId
                    ? (): void =>
                        onSelectPipelineRun
                          ? onSelectPipelineRun(run, true)
                          : onSelectWorktree(workspaceLocalId, worktreeLocalId)
                    : undefined
                }
                onDismiss={
                  onDismissPipelineRun
                    ? (): void => onDismissPipelineRun(run)
                    : undefined
                }
                dismissLabel="Mark workflow activity as seen"
                dataTestId="overview-unread-pipeline-card"
              >
                {renderPipelineRunDetails?.(run, true)}
              </OverviewCard>
            );
          })}
        </Section>

        {recommendations && (
          <div
            className="order-first min-w-0 md:order-none"
            data-testid="overview-recommendations"
          >
            {recommendations}
          </div>
        )}

        {capabilities.overviewNotifications && notifications !== undefined && (
          <Section title="Notifications" dataTestId="overview-notifications">
            {notifications}
          </Section>
        )}
      </div>
    </div>
  );
}
