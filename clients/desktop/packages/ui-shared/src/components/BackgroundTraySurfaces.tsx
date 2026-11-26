import { ListRowFrame } from '../primitives/ListRow';
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';

export function BackgroundTrayGroupLabel({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p
      className="sticky top-0 z-10 flex h-7 items-end bg-depth px-2.75 pb-1 text-s fg-tertiary"
      data-testid="background-tray-group-label"
    >
      {children}
    </p>
  );
}

export function BackgroundTrayKindMark({
  anchored = false,
  ...props
}: Omit<ComponentPropsWithRef<'span'>, 'className'> & {
  readonly anchored?: boolean;
}): JSX.Element {
  return (
    <span
      {...props}
      className={`${anchored ? 'relative ' : ''}inline-flex h-6 shrink-0 items-center gap-0.5 rounded-sm px-1 fg-tertiary`}
    />
  );
}

type TrayRowSurfaceProps = Omit<ComponentPropsWithRef<'li'>, 'className'> & {
  readonly modal: boolean;
  readonly open: boolean;
  readonly actionable: boolean;
};

export function TrayRowSurface({
  modal,
  open,
  actionable,
  ...props
}: TrayRowSurfaceProps): JSX.Element {
  return (
    <ListRowFrame
      as="li"
      layout={modal ? 'tray-modal' : 'tray-drawer'}
      state={
        open ? 'tray-open' : !modal && actionable ? 'sidebar-idle' : 'resting'
      }
      {...props}
    />
  );
}

export function TrayRowHeader({
  modalClosed,
  layout,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly modalClosed: boolean;
  readonly layout: 'modal' | 'legacy' | 'compact';
}): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout={`tray-header-${layout}`}
      state={modalClosed ? 'tray-header-closed' : 'resting'}
      {...props}
    />
  );
}
