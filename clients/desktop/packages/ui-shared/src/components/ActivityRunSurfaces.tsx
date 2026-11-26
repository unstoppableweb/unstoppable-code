import type { JSX, ReactNode } from 'react';
import { Dot } from '../primitives/Badge';
import { Notice } from '../primitives/Notice';
import { CometSpinner } from '../primitives/CometSpinner';

const RESULT_TONES = {
  neutral: 'bg-fg-primary/[0.015]',
  stopped: 'border-line-attention bg-warning/[0.06]',
  failed: 'border-fg-destructive-strong/20 bg-fg-destructive-strong/[0.06]',
} as const;

export function CompletedRunSurface({
  children,
  tone,
  stack = false,
}: {
  readonly children: ReactNode;
  readonly tone: keyof typeof RESULT_TONES;
  readonly stack?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border p-2.5 text-xs ${RESULT_TONES[tone]}${stack ? ' flex flex-col gap-2' : ''}`}
    >
      {children}
    </div>
  );
}

/** A queued run that failed: a destructive notice the close icon dismisses. */
export function FailedQueuedRunSurface({
  title,
  children,
  onDismiss,
  dismissLabel,
  actions,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly onDismiss: () => void;
  readonly dismissLabel: string;
  /** Recovery actions, such as Try again, as `NoticeButton`s. */
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <Notice
      errorSource="failed-queued-run"
      intent="destructive"
      title={title}
      onDismiss={onDismiss}
      dismissLabel={dismissLabel}
      actions={actions}
    >
      {children}
    </Notice>
  );
}

export function RunStepTimeline({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="pt-2 pl-1">
      <div className="flex flex-col gap-1.5 border-l-2 pl-2.5">{children}</div>
    </div>
  );
}

export function SummaryHighlightMark(): JSX.Element {
  return (
    <Dot
      tone="unread"
      size="large"
      className="relative top-1"
      data-testid="summary-highlight-dot"
    />
  );
}

export function FileViewControls({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-base">
      {children}
    </div>
  );
}

export function PendingAttachmentSpinner(): JSX.Element {
  return <CometSpinner tone="secondary" ariaLabel="Uploading" />;
}
