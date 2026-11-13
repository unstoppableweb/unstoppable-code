'use client';

import { useId, type JSX, type ReactNode } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import {
  AppErrorDetails,
  Notice,
  NoticeButton,
  Tooltip,
  type NoticeIntent,
} from '@canopy/ui-shared/components';
import {
  standingConditionCountLabel,
  standingConditionTitle,
  visibleStandingConditions,
  type StandingCondition,
} from './standing-conditions';

export interface StandingConditionsBannerProps {
  readonly conditions: readonly StandingCondition[];
  /** Offered only beside a defect. A host without reporting omits it. */
  readonly reportAction?: (error: AppError) => ReactNode;
  /** Placement only. */
  readonly className?: string;
}

function intentFor(condition: StandingCondition): NoticeIntent {
  if (condition.error.kind === 'defect') return 'destructive';
  return condition.kind === 'sync-paused' ? 'neutral' : 'attention';
}

/**
 * The one app-level banner for standing conditions: the highest-ranked active
 * condition, and a count of the rest. Hosts own detection and reporting.
 */
export function StandingConditionsBanner({
  conditions,
  reportAction,
  className,
}: StandingConditionsBannerProps): JSX.Element | null {
  const remainingId = useId();
  const [top, ...remaining] = visibleStandingConditions(conditions);
  if (!top) return null;

  const defect = top.error.kind === 'defect';
  const report = defect && reportAction ? reportAction(top.error) : null;
  const actionCount =
    (remaining.length > 0 ? 1 : 0) +
    (top.action ? 1 : 0) +
    (report === null ? 0 : 1);
  const remainingTitles = remaining.map(standingConditionTitle);

  return (
    <Notice
      intent={intentFor(top)}
      title={standingConditionTitle(top)}
      // The host already reported this episode, under this reference.
      errorRecordingDisabled
      liveRegionScope="content"
      className={className}
      data-testid="standing-conditions-banner"
      data-standing-condition={top.id}
      actionsPlacement={actionCount >= 3 ? 'below' : 'trailing'}
      detail={
        defect ? (
          <AppErrorDetails
            presentation={{ referenceId: top.error.referenceId }}
            dataTestId="standing-conditions-banner-details"
          />
        ) : undefined
      }
      actions={
        actionCount === 0 ? undefined : (
          <>
            {remaining.length > 0 ? (
              <Tooltip
                // Above would cover the message in a narrow notice.
                placement="left"
                contentClassName="flex max-w-64 flex-col whitespace-normal"
                label={remainingTitles.map((title) => (
                  <span key={title}>{title}</span>
                ))}
              >
                <span
                  tabIndex={0}
                  aria-describedby={remainingId}
                  className="fg-secondary"
                  data-testid="standing-conditions-banner-count"
                >
                  {standingConditionCountLabel(remaining.length)}
                </span>
              </Tooltip>
            ) : null}
            {remaining.length > 0 ? (
              <span id={remainingId} className="sr-only">
                {remainingTitles.join(' ')}
              </span>
            ) : null}
            {top.action ? (
              <NoticeButton
                busy={top.action.busy === true}
                busyLabel={top.action.busyLabel}
                onClick={top.action.onAction}
                data-testid="standing-conditions-banner-action"
              >
                {top.action.label}
              </NoticeButton>
            ) : null}
            {report}
          </>
        )
      }
    >
      {top.error.copy.description}
    </Notice>
  );
}
