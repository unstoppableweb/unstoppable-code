import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';
import { Surface } from '../primitives/Surface';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

type DiagramChange = 'added' | 'removed' | 'changed';

const CHANGE_EDGE = {
  added: 'border-l-line-positive',
  removed: 'border-l-line-destructive',
  changed: 'border-l-line-attention',
} satisfies Record<DiagramChange, string>;

const FIELD_TONE = {
  added: 'bg-success-subtle',
  removed: 'bg-destructive-subtle line-through decoration-destructive/50',
  changed: 'bg-warning-subtle',
} satisfies Record<DiagramChange, string>;

const SEARCH_RING = {
  active: 'ring-2 ring-line-attention',
  match: 'ring-1 ring-line-attention/60',
} as const;

/** Node chrome shared by plan diagrams. Geometry comes from the layout engine. */
export function DiagramNodeSurface({
  kind = 'detail',
  width,
  height,
  maxHeight,
  change,
  search,
  phase = false,
  children,
}: {
  readonly kind?: 'detail' | 'entity';
  readonly width: number;
  readonly height: number;
  readonly maxHeight?: number;
  readonly change?: DiagramChange;
  readonly search?: keyof typeof SEARCH_RING;
  readonly phase?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex flex-col rounded-md border text-left ${kind === 'entity' ? 'overflow-hidden' : 'h-full w-full justify-center gap-0.5 px-3 py-2'} ${phase ? 'border-line-accent/60 bg-accent/[0.08]' : 'bg-card'} ${change ? `border-l-4 ${CHANGE_EDGE[change]}` : ''} ${search ? SEARCH_RING[search] : ''}`}
      style={{ width, height, maxHeight }}
    >
      {children}
    </div>
  );
}

export function DiagramFieldRow({
  change,
  children,
}: {
  readonly change?: DiagramChange;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex min-h-5 items-center gap-1.5 rounded-sm px-1.5 py-0.5 ${change ? FIELD_TONE[change] : ''}`}
    >
      {children}
    </div>
  );
}

const RUN_EDGE = {
  success: OPERATIONAL_STATUS_COLORS.success.border,
  failed: OPERATIONAL_STATUS_COLORS.failed.border,
  active: OPERATIONAL_STATUS_COLORS.active.border,
  paused: OPERATIONAL_STATUS_COLORS.paused.border,
  neutral: '',
} as const;

export function WorkflowNodeSurface({
  tone,
  selected,
  children,
}: {
  readonly tone: keyof typeof RUN_EDGE;
  readonly selected?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left ${selected ? 'border-line-accent ring-1 ring-line-accent/60' : RUN_EDGE[tone]}`}
    >
      {children}
    </div>
  );
}

export function WorkflowNodeSection({
  kind,
  top,
  bottom,
  rowGap,
  children,
  'data-testid': testId,
}: {
  readonly kind: 'matrix' | 'steps';
  readonly top: number;
  readonly bottom: number;
  readonly rowGap?: number;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col border-t ${kind === 'matrix' ? 'px-3' : 'px-2'}`}
      style={{ paddingTop: top, paddingBottom: bottom, rowGap }}
    >
      {children}
    </div>
  );
}

/** Sortable workflow editor card, with selection independent of drag geometry. */
export function WorkflowEditorJob({
  selected,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly selected: boolean;
}): JSX.Element {
  return (
    <div
      {...props}
      className={`overflow-hidden rounded-lg border transition-[border-color,box-shadow,opacity] ${selected ? 'border-line-accent ring-1 ring-line-accent' : 'hover:border-line-accent/30'}`}
    />
  );
}

export function WorkflowEditorJobHeader(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="flex cursor-pointer items-center gap-2 bg-secondary/50 px-3 py-2"
    />
  );
}

export function WorkflowNavJobRow({
  active,
  matrix,
  children,
}: {
  readonly active: boolean;
  readonly matrix: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Surface
      variant={active ? 'workflow-nav-current' : 'workflow-nav-job'}
      padding={matrix ? 'workflow-nav-leading' : 'none'}
      className="relative w-full"
    >
      {children}
    </Surface>
  );
}

export function FileTreeEditorRow({
  depth,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className' | 'style'> & {
  readonly depth: number;
}): JSX.Element {
  return (
    <div
      {...props}
      className="flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-xs fg-primary"
      style={{ paddingLeft: depth * 16 + 8 }}
    />
  );
}
