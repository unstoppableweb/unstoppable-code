'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton } from '../../../../primitives/Notice';

export type LifetimeLimitNoticeDisplayProps =
  | { readonly state: 'gated' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'full';
      readonly canExtend: boolean;
      readonly atCap: boolean;
      readonly extension?: 'idle' | 'pending' | 'failed' | 'uncertain';
      readonly onExtend?: () => void;
    };

export const LIFETIME_LIMIT_NOTICE_COPY = {
  fullTitle: 'Lifetime limit reached',
  fullMessage:
    "Extend this worktree's lifetime limit to start new managed delegates. Refused starts aren't retried.",
  readOnlyMessage: "New managed delegates can't start in this worktree.",
  atCapMessage:
    "This worktree has reached this build's maximum lifetime limit for managed delegates.",
  unavailableTitle: 'Lifetime limit unavailable',
  unavailableMessage: "Couldn't read this worktree's lifetime limit.",
  gatedTitle: 'Lifetime limit not shown here',
  gatedMessage:
    "This view can't show or change this worktree's lifetime limit.",
  failed: "The extension didn't apply.",
  uncertain: "Couldn't confirm the extension.",
  extend: 'Extend',
} as const;

export function LifetimeLimitNoticeDisplay(
  props: LifetimeLimitNoticeDisplayProps,
): JSX.Element {
  const copy = LIFETIME_LIMIT_NOTICE_COPY;
  if (props.state === 'gated') {
    return (
      <Notice
        data-testid="lifetime-limit-notice"
        data-state="gated"
        role="none"
        title={copy.gatedTitle}
      >
        {copy.gatedMessage}
      </Notice>
    );
  }
  if (props.state === 'unavailable') {
    return (
      <Notice
        data-testid="lifetime-limit-notice"
        data-state="unavailable"
        title={copy.unavailableTitle}
      >
        {copy.unavailableMessage}
      </Notice>
    );
  }
  const actionable =
    props.canExtend && !props.atCap && props.onExtend !== undefined;
  const detail =
    props.extension === 'failed'
      ? copy.failed
      : props.extension === 'uncertain'
        ? copy.uncertain
        : undefined;
  return (
    <Notice
      data-testid="lifetime-limit-notice"
      data-state="full"
      intent="attention"
      title={copy.fullTitle}
      detail={detail}
      actions={
        actionable ? (
          <NoticeButton
            variant="primary"
            disabled={props.extension === 'pending'}
            aria-busy={props.extension === 'pending'}
            onClick={props.onExtend}
          >
            {copy.extend}
          </NoticeButton>
        ) : undefined
      }
    >
      {props.atCap
        ? copy.atCapMessage
        : actionable
          ? copy.fullMessage
          : copy.readOnlyMessage}
    </Notice>
  );
}
