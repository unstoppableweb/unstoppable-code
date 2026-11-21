import type { JSX, ReactNode } from 'react';
import { ListRowFrame } from './ListRow';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';

export function OpenAppSplitSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`electron-no-drag inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-full ${SECONDARY_SURFACE_SHELL_CLASS}`}
    >
      {children}
    </div>
  );
}

export function WorktreeApplyControlSurface({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <div className="inline-flex rounded-full shadow-sm">{children}</div>;
}

export function RepositoryReadinessMark({
  ready,
  children,
}: {
  readonly ready: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full ${ready ? 'bg-success-subtle fg-success' : 'bg-accent-subtle fg-accent-strong'}`}
    >
      {children}
    </span>
  );
}

export function SplitWorkflowStepNumber({
  active,
  done,
  number,
}: {
  readonly active: boolean;
  readonly done: boolean;
  readonly number: number;
}): JSX.Element {
  const state = active
    ? 'bg-accent-subtle fg-accent-strong ring-1 ring-line-accent/40'
    : done
      ? 'bg-success-subtle fg-success-strong'
      : 'bg-fg-primary/[0.06] fg-secondary';
  return (
    <span
      className={`inline-flex size-5 items-center justify-center rounded-full text-3xs font-semibold ${state}`}
    >
      {done ? '✓' : number}
    </span>
  );
}

export function RepositoryAttentionCard({
  compact = false,
  children,
}: {
  readonly compact?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const density = compact
    ? 'gap-2 rounded-md p-2.5 text-xs'
    : 'gap-1 rounded-lg p-4';
  return (
    <div
      className={`flex flex-col border border-line-attention bg-warning/5 ${density}`}
    >
      {children}
    </div>
  );
}

export function WorkspaceRepositoryRow({
  pendingRemoval = false,
  children,
}: {
  readonly pendingRemoval?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ListRowFrame
      layout="workspace-repository"
      state={pendingRemoval ? 'repo-removing' : 'repo-idle'}
    >
      {children}
    </ListRowFrame>
  );
}
