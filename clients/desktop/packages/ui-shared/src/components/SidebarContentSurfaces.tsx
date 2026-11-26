import type { ComponentPropsWithRef, JSX } from 'react';
import { ListRowFrame } from '../primitives/ListRow';

export function SidebarAccountRowSurface({
  tall,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly tall: boolean;
}): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout="sidebar-account"
      state={tall ? 'account-tall' : 'account-default'}
      {...props}
    />
  );
}

export function SidebarModeToggleFrame({
  active,
  className,
  ...props
}: ComponentPropsWithRef<'span'> & { readonly active: boolean }): JSX.Element {
  return (
    <span
      {...props}
      className={`inline-flex rounded-md ${active ? 'bg-subtle' : ''} ${className ?? ''}`}
    />
  );
}

export function SidebarActivityRowSurface(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return <div {...props} className="focus-ring rounded-row outline-none" />;
}

export function SidebarArchivedRow(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout="sidebar-archive"
      state="sidebar-idle"
      {...props}
    />
  );
}

export function SidebarGroupStrip({
  color,
  preview = false,
}: {
  readonly color: string;
  readonly preview?: boolean;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={
        preview
          ? 'absolute left-1 inset-y-2 w-0.5 rounded-full'
          : 'absolute -left-1.5 inset-y-0 w-0.5 rounded-full'
      }
      style={{ backgroundColor: color }}
    />
  );
}

export function SidebarGroupDropSurface(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return <div {...props} className="relative rounded-md" />;
}

export function SidebarScrollThumb({
  interactive,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly interactive: boolean;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`absolute top-0 touch-none rounded-full bg-fg-quaternary/50 ${interactive ? 'pointer-events-auto' : 'pointer-events-none'}`}
    />
  );
}

export function ChangedFileRowSurface({
  selectable,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly selectable: boolean;
}): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout="changed-file"
      state={selectable ? 'file-selectable' : 'resting'}
      {...props}
    />
  );
}

const SIDEBAR_CHROME_WIDTH = {
  compact: 'w-56',
  default: 'w-64',
  wide: 'w-72',
  full: 'w-full',
} as const;

const SIDEBAR_CHROME_SCROLL = {
  frame: 'overflow-auto',
  host: 'overflow-hidden',
  none: '',
} as const;

export function SidebarChromeFrame({
  painted,
  split,
  compact,
  fullHeight,
  scroll,
  width,
  className,
  ...props
}: ComponentPropsWithRef<'div'> & {
  readonly painted: boolean;
  readonly split: boolean;
  readonly compact: boolean;
  readonly fullHeight: boolean;
  readonly scroll: keyof typeof SIDEBAR_CHROME_SCROLL;
  readonly width: keyof typeof SIDEBAR_CHROME_WIDTH;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`flex min-h-0 flex-col ${fullHeight ? ' h-full' : ''} ${SIDEBAR_CHROME_SCROLL[scroll]} ${SIDEBAR_CHROME_WIDTH[width]}${compact ? ' text-xs' : ''}${className ? ` ${className}` : ''}${split ? ' h-[42vh] min-h-75 shrink-0 border-b lg:h-full lg:border-b-0 lg:border-r' : ''}${painted ? ' bg-sidebar' : ''}`}
    />
  );
}

export function SidebarPageNavFrame({
  material,
  className,
  ...props
}: ComponentPropsWithRef<'aside'> & {
  readonly material: boolean;
}): JSX.Element {
  const presentation = material
    ? 'app-sidebar-material sidebar-resizable-surface sidebar-instant-interactions'
    : 'bg-sidebar';
  return (
    <aside
      {...props}
      className={`${presentation} relative h-full shrink-0 select-none font-normal ${className ?? ''}`}
    />
  );
}

export function SidebarRowBox({
  chrome,
  selected,
  interactive,
  density,
  ...props
}: ComponentPropsWithRef<'div'> & {
  readonly chrome: boolean;
  readonly selected: boolean;
  readonly interactive: boolean;
  readonly density: 'default' | 'compact' | 'touch';
}): JSX.Element {
  const state = !chrome
    ? 'resting'
    : selected
      ? interactive
        ? 'sidebar-selected-interactive'
        : 'sidebar-selected'
      : interactive
        ? 'sidebar-interactive'
        : 'sidebar-idle';
  return (
    <ListRowFrame
      as="div"
      layout={chrome ? `sidebar-${density}` : 'sidebar-bare'}
      state={state}
      {...props}
    />
  );
}

const SIDEBAR_SECTION_HEADER = {
  default: '',
  'shared-containers': 'group group/shared-containers',
  'sticky-workspace': 'sidebar-workspace-sticky-header z-30',
  'hidden-workspaces': 'group group/hidden-workspaces',
} as const;

export function SidebarSectionHeaderFrame({
  painted,
  inset,
  variant = 'default',
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly painted: boolean;
  readonly inset: boolean;
  readonly variant?: keyof typeof SIDEBAR_SECTION_HEADER;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`flex min-w-0 items-center gap-1${inset ? ' px-1' : ''}${painted ? ' bg-sidebar' : ''} ${SIDEBAR_SECTION_HEADER[variant]}`}
    />
  );
}
