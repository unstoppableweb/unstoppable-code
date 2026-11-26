'use client';

import type { JSX, MouseEvent, ReactNode } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';

/** One button on a suggestion card. */
export interface SuggestionCardAction {
  label: ReactNode;
  /** Receives the click, so a host can open UI in the card's own document. */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Sets `aria-busy` while this action's answer is being saved. */
  busy?: boolean;
  /** Accessible progress copy; keep label as the resting sizing content. */
  busyLabel?: ReactNode;
  testId?: string;
}

export interface SuggestionCardProps {
  title: ReactNode;
  body: ReactNode;
  /** Leading glyph; omit for the neutral notice's default. */
  icon?: ReactNode;
  /** A line under the body, such as a save error. */
  detail?: { text: ReactNode; testId?: string };
  primaryAction: SuggestionCardAction;
  secondaryAction: SuggestionCardAction;
  /**
   * Don't show again: retires the whole suggestion category. Omitted for a
   * suggestion whose two answers are already final (the notification offer).
   */
  permanentDismiss?: SuggestionCardAction;
  /** Extra attributes on the card root, such as a kind marker. */
  attributes?: Readonly<Record<`data-${string}`, string>>;
  testId: string;
}

/**
 * The one floating suggestion card in the host's notification corner
 * (CAN-4343). Two answers, optionally a Don't show again, and no close
 * control, timer or Escape dismissal. It announces politely and never takes
 * focus.
 *
 * Pure display: the host decides when to show it and owns persistence.
 */
export function SuggestionCard({
  title,
  body,
  icon,
  detail,
  primaryAction,
  secondaryAction,
  permanentDismiss,
  attributes,
  testId,
}: SuggestionCardProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="pointer-events-auto rounded-2xl bg-quaternary shadow-xl"
      {...attributes}
    >
      <Notice
        shape="toast"
        surface="none"
        titleLayout="stacked"
        actionsPlacement="below"
        {...(icon === undefined ? {} : { icon })}
        title={title}
        detail={
          detail === undefined ? undefined : (
            <span data-testid={detail.testId}>{detail.text}</span>
          )
        }
        actions={
          <>
            <NoticeButton
              variant="secondary"
              disabled={secondaryAction.disabled}
              busy={secondaryAction.busy}
              busyLabel={secondaryAction.busyLabel}
              onClick={secondaryAction.onClick}
              data-testid={secondaryAction.testId}
            >
              {secondaryAction.label}
            </NoticeButton>
            <NoticeButton
              variant="primary"
              disabled={primaryAction.disabled}
              busy={primaryAction.busy}
              busyLabel={primaryAction.busyLabel}
              onClick={primaryAction.onClick}
              data-testid={primaryAction.testId}
            >
              {primaryAction.label}
            </NoticeButton>
            {permanentDismiss ? (
              <div className="basis-full">
                <NoticeButton
                  variant="secondary"
                  disabled={permanentDismiss.disabled}
                  busy={permanentDismiss.busy}
                  onClick={permanentDismiss.onClick}
                  data-testid={permanentDismiss.testId}
                >
                  {permanentDismiss.label}
                </NoticeButton>
              </div>
            ) : null}
          </>
        }
      >
        {body}
      </Notice>
    </div>
  );
}
