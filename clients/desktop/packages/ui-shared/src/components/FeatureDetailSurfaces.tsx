import { Badge } from '../primitives/Badge';
import { ListRowFrame } from '../primitives/ListRow';
import { NOTICE_TRAY_SURFACE_CLASS } from '../primitives/Notice';
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';

export function UnresolvedCollectionMember(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return <div {...props} className="bg-secondary/20 px-3 py-2" />;
}

export function ProviderRecheckRow({
  standalone,
  children,
}: {
  readonly standalone: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={standalone ? 'pt-4' : undefined}>
      <div
        className={`flex items-center justify-end gap-3${standalone ? ' border-t pt-3' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

export function LedgerActivityPrompt({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex justify-center bg-base pb-2">
      {children}
    </div>
  );
}

export function ContinueInterruptedSessionRow(
  props: Omit<ComponentPropsWithRef<'li'>, 'className'>,
): JSX.Element {
  return (
    <li {...props} className="group relative flex items-center rounded-full" />
  );
}

export function LinkedMemoryRow(
  props: Omit<ComponentPropsWithRef<'li'>, 'className'>,
): JSX.Element {
  return (
    <ListRowFrame
      as="li"
      layout="linked-memory"
      state="sidebar-idle"
      {...props}
    />
  );
}

export function ProjectCatalogHeader({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="sticky top-0 z-10 -mx-5 -mt-3 flex flex-col gap-2 bg-card px-5 pt-3 pb-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-linear-to-b after:from-card after:to-transparent">
      {children}
    </div>
  );
}

export function ProjectCatalogRow({
  columns,
  activatable,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly columns: boolean;
  readonly activatable: boolean;
}): JSX.Element {
  return (
    <ListRowFrame
      as="div"
      layout={columns ? 'project-columns' : 'project-inline'}
      state={activatable ? 'project-activatable' : 'resting'}
      {...props}
    />
  );
}

export function PipelineDetailTag({
  kind,
  children,
}: {
  readonly kind: 'trigger' | 'scope';
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Badge tone={kind === 'trigger' ? 'info' : 'neutral'}>{children}</Badge>
  );
}

export function PipelineDetailJobHeader({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 bg-secondary/50 px-3 py-2">
      {children}
    </div>
  );
}

export function PackageProblemTray(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className={`overflow-hidden rounded-xl ${NOTICE_TRAY_SURFACE_CLASS}`}
    />
  );
}

export function PackageProblemItems({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ul className="divide-y divide-line-base border-t border-line-base">
      {children}
    </ul>
  );
}

export function PackageProblemSection({
  small = false,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly small?: boolean;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`border-t border-line-base py-2 pl-9 pr-3${small ? ' text-xs' : ''}`}
    />
  );
}
