import type { ComponentPropsWithoutRef, JSX } from 'react';

type SidebarDragPreviewProps = ComponentPropsWithoutRef<'div'> & {
  variant?: 'row' | 'workspace' | 'group';
};

/** The copy of a sidebar row or group carried outside the scrolling rail. */
export function SidebarDragPreview({
  variant = 'row',
  className,
  ...props
}: SidebarDragPreviewProps): JSX.Element {
  const surface =
    variant === 'group' ? 'rounded-md bg-secondary' : 'rounded-row bg-popover';
  const layout =
    variant === 'workspace' ? 'flex h-8 w-full touch-none select-none' : '';
  return (
    <div
      {...props}
      className={`pointer-events-none cursor-default ${surface} shadow-lg ${layout} ${className ?? ''}`}
    />
  );
}

type SidebarDropLineProps = ComponentPropsWithoutRef<'span'> & {
  position: 'before' | 'after';
  variant: 'worktree' | 'workspace' | 'group';
};

const DROP_LINE_GEOMETRY = {
  worktree: 'pointer-events-none inset-x-1.5 z-10',
  workspace: 'pointer-events-none inset-x-1.5 z-20',
  group: 'inset-x-1',
} as const;

/** Marks the exact insertion edge of a pending sidebar reorder. */
export function SidebarDropLine({
  position,
  variant,
  ...props
}: SidebarDropLineProps): JSX.Element {
  const edge =
    variant === 'group'
      ? position === 'before'
        ? 'top-0'
        : 'bottom-0'
      : position === 'before'
        ? '-top-px'
        : '-bottom-px';
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`absolute h-0.5 rounded-full bg-accent ${DROP_LINE_GEOMETRY[variant]} ${edge}`}
    />
  );
}

type SidebarNestingRailProps = Omit<
  ComponentPropsWithoutRef<'span'>,
  'children'
> & {
  first: boolean;
  last: boolean;
  bridgeGap?: boolean;
  rounded?: boolean;
};

/** Joins adjacent nested sidebar rows while insetting the ends of the rail. */
export function SidebarNestingRail({
  first,
  last,
  bridgeGap = false,
  rounded = true,
  ...props
}: SidebarNestingRailProps): JSX.Element {
  const top = first ? 'top-1.5' : bridgeGap ? '-top-px' : 'top-0';
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`pointer-events-none absolute left-8 w-px bg-line-base/80 ${rounded ? 'rounded-full' : ''} ${top} ${last ? 'bottom-1.5' : 'bottom-0'}`}
    />
  );
}
