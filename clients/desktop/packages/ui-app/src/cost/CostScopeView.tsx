'use client';

import { useId, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import { type CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import {
  Surface,
  FloatingPickerMenu,
  HeaderActionButton,
  Notice,
  OverlayScrollArea,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSection,
  SegmentedControl,
} from '@canopy/ui-shared/components';
import {
  CostFreshness,
  CostLegend,
  CostObservedTotal,
  CostRow,
  CostSplitBar,
  costBarScale,
  costTotalsSegments,
  formatCostRunStart,
  formatCostTotalIn,
  type CostDimension,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { ChevronDownMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useCostScopeStore } from './use-cost-view-store';
import {
  CostUnavailableState,
  useCostInsightsEnabled,
} from './CostInsightsGate';
import { CostViewFrame, costRefreshFailureReason } from './CostViewFrame';
import { COST_SCOPE_VIEW_SAMPLE } from './cost-view-samples';
import {
  type CostScopeRowTarget,
  costScopeScaleMax,
  type CostScopeSort,
  hasUnattachedCost,
  isSameCostRowTarget,
  sortCostChats,
  sortCostRuns,
} from './cost-scope-model';
import { Divider } from '@canopy/ui-shared/components';
import { withCostCoverage } from './cost-coverage';

export interface CostScopeViewProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  /** Retained entries: `Final as of Oct 6`, no refresh, nothing running. Defaults to `scope.kind === 'retained'`. */
  readonly sealed?: boolean;
  /** The archived viewer's selection: rows call this instead of the navigator, and the matching row carries aria-current. */
  readonly onSelectRow?: (target: CostScopeRowTarget) => void;
  readonly selectedRow?: CostScopeRowTarget | null;
  /** A store the host already holds (shared with the Activity section); otherwise the view creates its own. */
  readonly store?: CostScopeStore;
  /** Clock for relative times; tests pass a fixed value. Default Date.now() per render. */
  readonly now?: number;
}

const SORT_LABELS: Readonly<Record<CostScopeSort, string>> = {
  cost: 'Highest cost',
  recent: 'Most recent',
};

function CostSortMenu({
  sort,
  showArchived,
  onSortChange,
  onShowArchivedChange,
}: {
  readonly sort: CostScopeSort;
  readonly showArchived: boolean;
  readonly onSortChange: (sort: CostScopeSort) => void;
  readonly onShowArchivedChange: (show: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative shrink-0">
      <HeaderActionButton
        ref={triggerRef}
        tone="neutral"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="cost-sort"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {SORT_LABELS[sort]}
        <ChevronDownMediumIcon size={16} aria-hidden="true" />
      </HeaderActionButton>
      <FloatingPickerMenu
        id={menuId}
        data-testid="cost-sort-menu"
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        interaction="menu"
        initialFocusRef={firstOptionRef}
        heightLimit={180}
      >
        <PickerMenuOption
          ref={firstOptionRef}
          role="menuitemradio"
          aria-checked={sort === 'cost'}
          selected={sort === 'cost'}
          data-testid="cost-sort-option-cost"
          onClick={() => onSortChange('cost')}
        >
          <PickerMenuOptionCheck selected={sort === 'cost'} />
          <PickerMenuOptionContent>
            <PickerMenuOptionLabel>Highest cost</PickerMenuOptionLabel>
          </PickerMenuOptionContent>
        </PickerMenuOption>
        <PickerMenuOption
          role="menuitemradio"
          aria-checked={sort === 'recent'}
          selected={sort === 'recent'}
          data-testid="cost-sort-option-recent"
          onClick={() => onSortChange('recent')}
        >
          <PickerMenuOptionCheck selected={sort === 'recent'} />
          <PickerMenuOptionContent>
            <PickerMenuOptionLabel>Most recent</PickerMenuOptionLabel>
          </PickerMenuOptionContent>
        </PickerMenuOption>
        <PickerMenuSection>
          <PickerMenuOption
            role="menuitemcheckbox"
            aria-checked={showArchived}
            selected={showArchived}
            data-testid="cost-sort-show-archived"
            onClick={(event) => {
              event.preventDefault();
              onShowArchivedChange(!showArchived);
            }}
          >
            <PickerMenuOptionCheck selected={showArchived} reserveSpace />
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>Show archived</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
          </PickerMenuOption>
        </PickerMenuSection>
      </FloatingPickerMenu>
    </div>
  );
}

function ListHeading({
  label,
  count,
  testId,
  trailing,
}: {
  readonly label: string;
  readonly count: number;
  readonly testId: string;
  readonly trailing?: JSX.Element;
}): JSX.Element {
  return (
    <div data-testid={testId} className="flex min-h-7 items-center gap-2 px-2">
      <span className="text-xs fg-secondary">
        {label} <span className="tabular-nums fg-tertiary">{count}</span>
      </span>
      {trailing !== undefined ? (
        <span className="ml-auto">{trailing}</span>
      ) : null}
    </div>
  );
}

function CostScopeViewContent({
  store,
  navigator,
  scope,
  sealed: sealedProp,
  onSelectRow,
  selectedRow,
  now,
}: Omit<CostScopeViewProps, 'client' | 'store'> & {
  readonly store: CostScopeStore;
}): JSX.Element {
  const currency = useCostCurrency();
  const { value, status, problem, updatedAt, refresh, load, requestRefresh } =
    store(
      useShallow((state) => ({
        value: state.value,
        status: state.status,
        problem: state.problem,
        updatedAt: state.updatedAt,
        refresh: state.refresh,
        load: state.load,
        requestRefresh: state.requestRefresh,
      })),
    );
  const [dimension, setDimension] = useState<CostDimension>('source');
  const [sort, setSort] = useState<CostScopeSort>('cost');
  const [showArchived, setShowArchived] = useState(true);
  const sealed = sealedProp ?? scope.kind === 'retained';
  const currentTime = now ?? Date.now();

  return (
    <Surface
      variant="pane"
      extent="parent"
      data-testid="cost-scope-view"
      data-dimension={dimension}
      className="min-h-0"
    >
      <CostViewFrame
        value={value}
        status={status}
        problem={problem}
        onRetry={() => void load()}
        loadingSample={COST_SCOPE_VIEW_SAMPLE}
        testId="cost-scope-view"
      >
        {(view) => {
          const chats = sortCostChats(view.chats, sort, showArchived);
          const runs = sortCostRuns(view.pipelineRuns, sort);
          const scaleMax = costScopeScaleMax(chats, runs, view.unattached);
          const unattachedVisible = hasUnattachedCost(view.unattached);
          const hasRows =
            chats.length > 0 || runs.length > 0 || unattachedVisible;
          // The filter can hide every row; its control must stay reachable.
          const archivedHidden = view.chats.length > chats.length;
          const showList = hasRows || archivedHidden;
          const isEmpty = !view.building && !showList;
          const noticeText = view.building
            ? `Reading the last ${view.retentionDays} ${view.retentionDays === 1 ? 'day' : 'days'} of activity, as Retention days allows. Figures fill in as it goes.`
            : null;
          const sealedAt = sealed
            ? (view.sealedAt ?? updatedAt ?? undefined)
            : undefined;

          return (
            <Surface
              variant="pane"
              extent="parent"
              gap="group"
              className="min-h-0"
            >
              <div className="flex flex-col gap-3 px-3 pt-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <CostObservedTotal
                      amountLabel={formatCostTotalIn(view.totals, currency)}
                      coverageStart={view.coverageStart}
                      testId="cost-total"
                    />
                  </span>
                  <CostFreshness
                    updatedAt={updatedAt}
                    now={currentTime}
                    refreshing={refresh.status === 'refreshing'}
                    failureReason={
                      refresh.status === 'failed'
                        ? costRefreshFailureReason(refresh.problem)
                        : null
                    }
                    sealedAt={sealedAt}
                    onRefresh={
                      sealed
                        ? undefined
                        : (): void => {
                            void requestRefresh('manual');
                          }
                    }
                    completedRefreshes={refresh.completedManual}
                  />
                </div>
                <SegmentedControl
                  value={dimension}
                  options={[
                    {
                      value: 'source',
                      label: 'By source',
                      dataTestId: 'cost-split-source',
                    },
                    {
                      value: 'billing',
                      label: 'By billing',
                      dataTestId: 'cost-split-billing',
                    },
                  ]}
                  onChange={setDimension}
                  label="Split cost by"
                  width="fill"
                  dataTestId="cost-split"
                />
                <div className="flex flex-col gap-2">
                  <CostSplitBar
                    segments={costTotalsSegments(view.totals, dimension)}
                    label="Cost in this entry"
                    size="summary"
                    testId="cost-entry-bar"
                  />
                  <CostLegend
                    segments={costTotalsSegments(view.totals, dimension)}
                    layout="inline"
                    showShare
                    testId="cost-entry-legend"
                  />
                </div>
              </div>

              {noticeText !== null ? (
                <div data-testid="cost-notice" className="px-3">
                  <Notice title="Building cost history.">{noticeText}</Notice>
                </div>
              ) : view.hasCodexEstimate ? (
                <div data-testid="cost-notice" className="px-3">
                  <Notice>Codex cost is an estimate.</Notice>
                </div>
              ) : null}

              {isEmpty ? (
                <p
                  data-testid="cost-empty"
                  className="px-3 text-xs fg-secondary"
                >
                  Costs appear after the first reply.
                </p>
              ) : null}

              {showList ? (
                <OverlayScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col px-1 pb-3">
                    <ListHeading
                      label="Chats"
                      count={chats.length}
                      testId="cost-chats-heading"
                      trailing={
                        <CostSortMenu
                          sort={sort}
                          showArchived={showArchived}
                          onSortChange={setSort}
                          onShowArchivedChange={setShowArchived}
                        />
                      }
                    />
                    {chats.length === 0 && archivedHidden ? (
                      <p
                        data-testid="cost-archived-hidden"
                        className="px-2 py-2 text-xs fg-secondary"
                      >
                        Archived chats are hidden.
                      </p>
                    ) : null}
                    {chats.map((chat) => {
                      const target: CostScopeRowTarget = {
                        kind: 'chat',
                        chatId: chat.chatId,
                      };
                      const onOpen =
                        onSelectRow !== undefined
                          ? (): void => {
                              onSelectRow(target);
                            }
                          : navigator.openSessionBreakdown === undefined
                            ? undefined
                            : (): void => {
                                navigator.openSessionBreakdown?.(
                                  scope,
                                  chat.chatId,
                                );
                              };
                      return (
                        <CostRow
                          key={chat.chatId}
                          name={chat.label}
                          maskName
                          archived={chat.state === 'archived'}
                          running={chat.running && !sealed}
                          amountLabel={withCostCoverage(
                            formatCostTotalIn(chat.totals, currency),
                            chat.coverageStart,
                          )}
                          segments={costTotalsSegments(chat.totals, dimension)}
                          scale={costBarScale(chat.totals.usd, scaleMax)}
                          density="panel"
                          selected={isSameCostRowTarget(selectedRow, target)}
                          onOpen={onOpen}
                          testId={`cost-chat-row-${chat.chatId}`}
                        />
                      );
                    })}
                    {runs.length > 0 ? (
                      <div className="pt-2">
                        <ListHeading
                          label="Workflow runs"
                          count={runs.length}
                          testId="cost-runs-heading"
                        />
                      </div>
                    ) : null}
                    {runs.map((run) => {
                      const target: CostScopeRowTarget = {
                        kind: 'pipeline-run',
                        executionId: run.executionId,
                      };
                      const onOpen =
                        onSelectRow !== undefined
                          ? (): void => {
                              onSelectRow(target);
                            }
                          : navigator.openPipelineRun === undefined
                            ? undefined
                            : (): void => {
                                navigator.openPipelineRun?.(
                                  scope,
                                  run.executionId,
                                );
                              };
                      return (
                        <CostRow
                          key={run.executionId}
                          name={run.pipelineName}
                          running={run.status === 'running' && !sealed}
                          startedLabel={formatCostRunStart(
                            run.startedAt,
                            currentTime,
                          )}
                          amountLabel={formatCostTotalIn(run.totals, currency)}
                          segments={costTotalsSegments(run.totals, dimension)}
                          scale={costBarScale(run.totals.usd, scaleMax)}
                          density="panel"
                          selected={isSameCostRowTarget(selectedRow, target)}
                          onOpen={onOpen}
                          testId={`cost-run-row-${run.executionId}`}
                        />
                      );
                    })}
                    {unattachedVisible && view.unattached !== undefined ? (
                      <>
                        <Divider className="mx-2 my-1" />
                        <CostRow
                          name="Not tied to a chat"
                          amountLabel={formatCostTotalIn(
                            view.unattached,
                            currency,
                          )}
                          segments={costTotalsSegments(
                            view.unattached,
                            dimension,
                          )}
                          scale={costBarScale(view.unattached.usd, scaleMax)}
                          density="panel"
                          muted
                          testId="cost-unattached-row"
                        />
                      </>
                    ) : null}
                  </div>
                </OverlayScrollArea>
              ) : null}
            </Surface>
          );
        }}
      </CostViewFrame>
    </Surface>
  );
}

function OwnedCostScopeView({
  client,
  ...props
}: Omit<CostScopeViewProps, 'store'>): JSX.Element {
  const store = useCostScopeStore(client, props.scope);
  return <CostScopeViewContent {...props} store={store} />;
}

export function CostScopeView(props: CostScopeViewProps): JSX.Element {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return <CostUnavailableState />;
  if (props.store !== undefined) {
    return <CostScopeViewContent {...props} store={props.store} />;
  }
  return <OwnedCostScopeView {...props} />;
}
