import type { ComponentPropsWithoutRef, JSX } from 'react';
import { Dot } from '../primitives/Badge';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

export function TerminalTabsBar(
  props: Omit<ComponentPropsWithoutRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="flex h-10 shrink-0 items-stretch border-b bg-card/40 text-xs"
    />
  );
}

const TERMINAL_TAB_STATE = {
  active: 'border-b-base bg-base fg-primary',
  idle: 'border-transparent bg-muted/25 fg-secondary hover:bg-muted/40 hover:fg-primary',
};

export function TerminalTabFrame({
  active,
  split,
  ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'className'> & {
  readonly active: boolean;
  readonly split?: boolean;
}): JSX.Element {
  const frame = split
    ? 'flex h-9 shrink-0 items-center gap-1 rounded-t-md border px-1'
    : 'group flex h-9 min-w-32 max-w-56 shrink-0 items-center gap-1 rounded-t-md border px-2';
  const tone = split
    ? active
      ? 'border-line-accent/50 border-b-base bg-info/10'
      : 'border-line-accent/25 bg-info/5'
    : TERMINAL_TAB_STATE[active ? 'active' : 'idle'];
  return <div {...props} className={`${frame} ${tone}`} />;
}

export function SplitTerminalTabLabel(
  props: Omit<ComponentPropsWithoutRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="group flex h-7 min-w-24 max-w-40 items-center gap-1 rounded px-1.5 fg-info"
    />
  );
}

export function TerminalSplitPaneTab({
  active,
  ...props
}: Omit<ComponentPropsWithoutRef<'li'>, 'className'> & {
  readonly active: boolean;
}): JSX.Element {
  return (
    <li
      {...props}
      className={`group/pane flex h-8 min-w-24 max-w-44 items-center gap-1 rounded-t border px-2 ${TERMINAL_TAB_STATE[active ? 'active' : 'idle']}`}
    />
  );
}

export function TerminalRunningMark(): JSX.Element {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center"
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full motion-reduce:animate-none ${OPERATIONAL_STATUS_COLORS.active.backgroundPing}`}
      />
      <Dot tone="working" className="relative scale-65" />
    </span>
  );
}
