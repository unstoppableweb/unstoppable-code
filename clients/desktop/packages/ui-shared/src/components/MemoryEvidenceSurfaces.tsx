import type { JSX, ReactNode, Ref } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Dot } from './Badge';

export function MemoryEvidenceQuote({
  children,
  compact = false,
  blockReplay = false,
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
  readonly blockReplay?: boolean;
}): JSX.Element {
  const privacyClass = blockReplay ? REPLAY_BLOCK_CLASS : '';
  if (compact) {
    return (
      <p
        className={`line-clamp-2 border-l-2 border-line-accent pl-3 text-xs italic fg-secondary ${privacyClass}`}
      >
        {children}
      </p>
    );
  }
  return (
    <blockquote
      className={`rounded-lg border-l-2 border-line-accent bg-accent/5 px-4 py-3 text-s italic fg-secondary ${privacyClass}`}
    >
      {children}
    </blockquote>
  );
}

export function MemoryTranscriptEntry({
  children,
  highlighted,
  ref,
}: {
  readonly children: ReactNode;
  readonly highlighted: boolean;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <div
      ref={ref}
      className={
        highlighted
          ? 'rounded-lg border border-line-accent bg-accent/5 p-3'
          : 'rounded-lg p-3'
      }
    >
      {children}
    </div>
  );
}

export function MemoryEvidenceMatch({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="pb-3">
      <mark className="block rounded bg-warning-subtle px-2 py-1 text-xs fg-primary">
        {children}
      </mark>
    </div>
  );
}

export function MemoryGraphLegend({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-xs fg-secondary">
      {children}
    </div>
  );
}

export function MemoryGraphSwatch({
  color,
}: {
  readonly color: string;
}): JSX.Element {
  return (
    <i
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: color }}
    />
  );
}

type MemoryJobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DEAD';

const JOB_STATUS_CLASSES: Record<MemoryJobStatus, string> = {
  PENDING: 'bg-base fg-secondary',
  RUNNING: 'bg-accent-subtle fg-accent-strong',
  DONE: 'bg-success-subtle fg-success',
  FAILED: 'bg-destructive-subtle fg-destructive',
  DEAD: 'bg-destructive-subtle fg-destructive',
};

export function MemoryJobStatusLabel({
  status,
}: {
  readonly status: MemoryJobStatus;
}): JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${JOB_STATUS_CLASSES[status]}`}
    >
      {status}
    </span>
  );
}

export function MemoryTimelineMark({
  gatePassed,
}: {
  /** Omit for the neutral supersession timeline dot. */
  readonly gatePassed?: boolean;
}): JSX.Element {
  return (
    <Dot
      size="large"
      tone={gatePassed ? 'success' : 'filter'}
      className="absolute -left-4.75 top-1"
    />
  );
}
