'use client';

import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import {
  HeaderActionButton,
  OverlayScrollArea,
} from '@canopy/ui-shared/components';
import {
  CostLegend,
  CostRow,
  CostSplitBar,
  costBarScale,
  costTotalsSegments,
  formatCostTotalIn,
  useCostCurrency,
} from '@canopy/ui-shared/components/cost';
import { useCostScopeStore } from './use-cost-view-store';
import { useCostInsightsEnabled } from './CostInsightsGate';
import { CostViewFrame } from './CostViewFrame';
import { COST_SCOPE_VIEW_SAMPLE } from './cost-view-samples';
import {
  costScopeScaleMax,
  hasUnattachedCost,
  sortCostChats,
  sortCostRuns,
} from './cost-scope-model';
import { withCostCoverage } from './cost-coverage';

export interface CostActivityPreviewProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  /** Rows shown before the list scrolls: 6 in the rail, 5 in the Advanced card. */
  readonly maxRows?: number;
  readonly store?: CostScopeStore;
  readonly now?: number;
}

const COST_ACTIVITY_CARD_ROW_HEIGHT_PX = 34;

function CostActivityPreviewContent({
  store,
  navigator,
  scope,
  maxRows,
}: Omit<CostActivityPreviewProps, 'client' | 'store'> & {
  readonly store: CostScopeStore;
}): JSX.Element {
  const currency = useCostCurrency();
  const { value, status, problem, load } = store(
    useShallow((state) => ({
      value: state.value,
      status: state.status,
      problem: state.problem,
      load: state.load,
    })),
  );

  return (
    <div data-testid="cost-activity-preview" className="flex flex-col gap-2">
      <CostViewFrame
        value={value}
        status={status}
        problem={problem}
        onRetry={() => void load()}
        loadingSample={COST_SCOPE_VIEW_SAMPLE}
        testId="cost-activity-preview"
      >
        {(view) => {
          const chats = sortCostChats(view.chats, 'cost', true);
          const runs = sortCostRuns(view.pipelineRuns, 'cost');
          const unattachedVisible = hasUnattachedCost(view.unattached);
          const scaleMax = costScopeScaleMax(chats, runs, view.unattached);
          const capRows =
            maxRows === undefined || !Number.isFinite(maxRows)
              ? 6
              : Math.max(0, maxRows);
          const capHeight = capRows * COST_ACTIVITY_CARD_ROW_HEIGHT_PX;
          const isEmpty =
            chats.length === 0 && runs.length === 0 && !unattachedVisible;
          return (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 px-2">
                <CostSplitBar
                  segments={costTotalsSegments(view.totals, 'source')}
                  label="Cost in this entry"
                  size="summary"
                  testId="cost-activity-bar"
                />
                <CostLegend
                  segments={costTotalsSegments(view.totals, 'source')}
                  layout="inline"
                  testId="cost-activity-legend"
                />
              </div>
              {isEmpty ? (
                <p
                  data-testid="cost-empty"
                  className="px-2 text-xs fg-secondary"
                >
                  Costs appear after the first reply.
                </p>
              ) : null}
              {isEmpty ? null : (
                <div
                  data-testid="cost-activity-scroll-cap"
                  className="flex min-h-0 flex-col"
                  style={{ maxHeight: capHeight }}
                >
                  <OverlayScrollArea className="min-h-0 flex-1">
                    <div className="flex flex-col">
                      <div className="flex min-h-7 items-center gap-2 px-2 pt-1">
                        <span className="text-xs fg-secondary">
                          Chats{' '}
                          <span className="tabular-nums fg-tertiary">
                            {chats.length}
                          </span>
                        </span>
                      </div>
                      {chats.map((chat) => (
                        <CostRow
                          key={chat.chatId}
                          name={chat.label}
                          maskName
                          archived={chat.state === 'archived'}
                          running={chat.running}
                          amountLabel={withCostCoverage(
                            formatCostTotalIn(chat.totals, currency),
                            chat.coverageStart,
                          )}
                          segments={costTotalsSegments(chat.totals, 'source')}
                          scale={costBarScale(chat.totals.usd, scaleMax)}
                          density="card"
                          onOpen={
                            navigator.openSessionBreakdown === undefined
                              ? undefined
                              : (): void => {
                                  navigator.openSessionBreakdown?.(
                                    scope,
                                    chat.chatId,
                                  );
                                }
                          }
                          testId={`cost-chat-row-${chat.chatId}`}
                        />
                      ))}
                      {runs.length > 0 ? (
                        <div className="flex min-h-7 items-center gap-2 px-2 pt-1">
                          <span className="text-xs fg-secondary">
                            Workflow runs{' '}
                            <span className="tabular-nums fg-tertiary">
                              {runs.length}
                            </span>
                          </span>
                        </div>
                      ) : null}
                      {runs.map((run) => (
                        <CostRow
                          key={run.executionId}
                          name={run.pipelineName}
                          running={run.status === 'running'}
                          amountLabel={formatCostTotalIn(run.totals, currency)}
                          segments={costTotalsSegments(run.totals, 'source')}
                          scale={costBarScale(run.totals.usd, scaleMax)}
                          density="card"
                          onOpen={
                            navigator.openPipelineRun === undefined
                              ? undefined
                              : (): void => {
                                  navigator.openPipelineRun?.(
                                    scope,
                                    run.executionId,
                                  );
                                }
                          }
                          testId={`cost-run-row-${run.executionId}`}
                        />
                      ))}
                      {unattachedVisible && view.unattached !== undefined ? (
                        <CostRow
                          name="Not tied to a chat"
                          amountLabel={formatCostTotalIn(
                            view.unattached,
                            currency,
                          )}
                          segments={costTotalsSegments(
                            view.unattached,
                            'source',
                          )}
                          scale={costBarScale(view.unattached.usd, scaleMax)}
                          density="card"
                          muted
                          testId="cost-unattached-row"
                        />
                      ) : null}
                    </div>
                  </OverlayScrollArea>
                </div>
              )}
              {navigator.openCostPanel !== undefined ? (
                <div className="px-1">
                  <HeaderActionButton
                    tone="neutral"
                    data-testid="cost-open-panel"
                    onClick={() => navigator.openCostPanel?.(scope)}
                  >
                    Open Cost panel
                  </HeaderActionButton>
                </div>
              ) : null}
            </div>
          );
        }}
      </CostViewFrame>
    </div>
  );
}

function OwnedCostActivityPreview({
  client,
  ...props
}: Omit<CostActivityPreviewProps, 'store'>): JSX.Element {
  const store = useCostScopeStore(client, props.scope);
  return <CostActivityPreviewContent {...props} store={store} />;
}

export function CostActivityPreview(
  props: CostActivityPreviewProps,
): JSX.Element | null {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return null;
  if (props.store !== undefined) {
    return <CostActivityPreviewContent {...props} store={props.store} />;
  }
  return <OwnedCostActivityPreview {...props} />;
}
