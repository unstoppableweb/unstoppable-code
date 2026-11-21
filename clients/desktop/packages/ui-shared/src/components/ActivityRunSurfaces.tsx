import type { JSX, ReactNode } from 'react';
import { Dot } from './Badge';
import { CometSpinner } from './CometSpinner';

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

export function FailedQueuedRunSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-line-destructive/30 bg-destructive/5 px-2.5 py-1.5">
      {children}
    </div>
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
