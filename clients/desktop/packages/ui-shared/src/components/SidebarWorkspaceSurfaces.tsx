import type { ComponentPropsWithRef, JSX } from 'react';
import { SIDEBAR_STATUS_SURFACE_CLASSNAME } from '../lib/sidebar-status-surface';
import { ListRowFrame } from '../primitives/ListRow';

type DivProps = Omit<ComponentPropsWithRef<'div'>, 'className'>;

export function SidebarWorkspaceHoverPanel({
  preview,
  entering,
  concealed,
  ...props
}: DivProps & {
  readonly preview: boolean;
  readonly entering: boolean;
  readonly concealed: boolean;
}): JSX.Element {
  const position = preview
    ? `app-sidebar-preview-surface sidebar-preview-slide absolute left-0 top-0 shadow-xl ${entering ? 'sidebar-preview-instant' : ''}`
    : 'relative';
  const edge = concealed
    ? 'border-0 pointer-events-none'
    : 'border-y-0 border-l-0 border-r';
  return (
    <div
      {...props}
      className={`app-sidebar-material sidebar-resizable-divider flex h-full flex-col text-s font-normal ${position} ${edge}`}
    />
  );
}

export function SidebarCoworkHeader({
  dragging,
  ...props
}: DivProps & { readonly dragging: boolean }): JSX.Element {
  return (
    <ListRowFrame
      {...props}
      layout="sidebar-workspace"
      state={dragging ? 'sidebar-dragging' : 'sidebar-idle'}
    />
  );
}

export function SidebarWorkspaceFrame({
  spacing,
  code = false,
  highlightPlaying = false,
  ...props
}: DivProps & {
  readonly spacing: 'none' | 'expanded' | 'compact';
  readonly code?: boolean;
  readonly highlightPlaying?: boolean;
}): JSX.Element {
  const separation = spacing === 'expanded' ? 'h-2' : 'h-px';
  return (
    <>
      <div
        {...props}
        className={
          code
            ? `relative rounded-lg ${highlightPlaying ? 'workspace-highlight-pulse' : ''}`
            : 'group/row relative rounded-row transition-colors'
        }
      />
      {spacing !== 'none' && (
        <div aria-hidden className={`shrink-0 ${separation}`} />
      )}
    </>
  );
}

export function SidebarCustomizeDragFrame({
  fixed,
  dragging,
  ...props
}: DivProps & {
  readonly fixed: boolean;
  readonly dragging: boolean;
}): JSX.Element {
  return (
    <div
      {...props}
      className={
        fixed
          ? undefined
          : `focus-ring rounded-row${dragging ? ' relative z-10' : ''}`
      }
    />
  );
}

export function SidebarCustomizeDragRow({
  dragging,
  ...props
}: DivProps & { readonly dragging: boolean }): JSX.Element {
  return (
    <ListRowFrame
      {...props}
      layout="sidebar-customize"
      state={dragging ? 'drag-preview' : 'sidebar-idle'}
    />
  );
}

export function SidebarFooterBannerSurface({
  split = false,
  tall,
  surface,
  ...props
}: DivProps & {
  readonly split?: boolean;
  readonly surface?: 'status' | 'development';
  readonly tall: boolean;
}): JSX.Element {
  const appearance =
    surface === 'development'
      ? 'bg-warning-subtle fg-primary shadow-md'
      : surface === 'status'
        ? SIDEBAR_STATUS_SURFACE_CLASSNAME
        : '';
  // Split rows let the action focus outline extend beyond the container.
  // Only hovering the primary action washes the entire card.
  const interaction = split
    ? surface === 'status'
      ? 'has-[[data-banner-primary]:hover]:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))] has-[[data-banner-primary]:focus-visible]:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]'
      : ''
    : 'overflow-hidden';
  return (
    <div
      {...props}
      className={`${tall ? 'h-8' : 'h-7'} flex w-full items-center gap-1.5 whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-xs font-normal ${interaction} ${appearance}`}
    />
  );
}
