import { ListRowFrame } from '../primitives/ListRow';
import type { ComponentPropsWithRef, JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

export function AuthLoginStatusBar(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="flex items-center gap-2 px-6 py-3 border-t bg-base/40"
    />
  );
}

export function AuthLoginTerminalFrame(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="relative overflow-hidden rounded-lg ring-[length:var(--border-hairline)] ring-line-base"
    />
  );
}

export function AuthLoginSnapshotRail(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div {...props} className="relative w-80 shrink-0 border-l bg-base/20" />
  );
}

export function ThemeAccentSwatch({
  dark,
  color,
  ...props
}: Omit<ComponentPropsWithRef<'span'>, 'className' | 'style'> & {
  readonly dark?: boolean;
  readonly color: string;
}): JSX.Element {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full${dark ? ' dark' : ''}`}
      style={{ background: color }}
    />
  );
}

export function HarnessDragPreview({
  keyboard,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly keyboard?: boolean;
}): JSX.Element {
  const placement = keyboard
    ? 'pointer-events-none fixed left-1/2 top-6 z-toast -translate-x-1/2'
    : 'cursor-grabbing';
  return (
    <div
      {...props}
      className={`flex h-8 items-center rounded-md bg-card px-2 text-s fg-primary shadow-lg ${placement}`}
    />
  );
}

export function HarnessBoardColumn({
  highlighted,
  ...props
}: Omit<ComponentPropsWithRef<'section'>, 'className'> & {
  readonly highlighted: boolean;
}): JSX.Element {
  return (
    <section
      {...props}
      className={`flex flex-col gap-2 rounded-lg bg-secondary p-3 transition-colors ${highlighted ? 'ring-1 ring-line-accent' : 'ring-[length:var(--border-hairline)] ring-line-base'}`}
    />
  );
}

export function HarnessBoardRow({
  dragging,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly dragging: boolean;
}): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout="harness-board"
      state={dragging ? 'harness-dragging' : 'harness-idle'}
      {...props}
    />
  );
}

export function WorkerCardSurface({
  modal,
  highlighted,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly modal: boolean;
  readonly highlighted: boolean;
}): JSX.Element {
  const treatment = modal
    ? 'min-h-0 flex-1 rounded-none border-0 bg-transparent'
    : `rounded-xl border bg-card/60${highlighted ? ' border-transparent ring-1 ring-line-accent' : ''}`;
  return (
    <div
      {...props}
      className={`flex flex-col overflow-hidden transition-shadow ${treatment}`}
    />
  );
}

export function WorkerTerminalSurface({
  layout,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly layout: string;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-col border-y ${layout}`}
    />
  );
}

export function McpScopeControlFrame(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="inline-flex items-center gap-1 rounded-full bg-base p-1 ring-[length:var(--border-hairline)] ring-inset ring-line-base"
    />
  );
}

export function OverviewWorkflowPlaceholder(): JSX.Element {
  return (
    <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-muted/50" />
  );
}

export function QuestionPlaygroundPhase({
  active,
  ...props
}: Omit<ComponentPropsWithRef<'span'>, 'className'> & {
  readonly active: boolean;
}): JSX.Element {
  return (
    <span
      {...props}
      className={`border-b pb-1 text-xs ${active ? 'border-line-primary fg-primary' : 'border-transparent fg-tertiary'}`}
    />
  );
}

export function GalleryHiddenSectionMark(
  props: Omit<ComponentPropsWithRef<'span'>, 'className'>,
): JSX.Element {
  return (
    <span
      {...props}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-warning-subtle fg-warning"
    />
  );
}

export function ActivityGalleryToolbar(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-base p-2 shadow-sm"
    />
  );
}

export function WorktreePriorityPreviewRow(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout="priority-preview"
      state="repo-idle"
      {...props}
    />
  );
}

export function WorktreeLegendSwatch(): JSX.Element {
  return (
    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

export function PanelPreviewLines(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-3" aria-hidden="true">
      <div className="h-2.5 w-3/5 rounded-full bg-subtle" />
      <div className="h-2.5 w-4/5 rounded-full bg-subtle" />
      <div className="h-2.5 w-2/5 rounded-full bg-subtle" />
      <div className="h-2.5 w-3/4 rounded-full bg-subtle" />
    </div>
  );
}
