import type { ComponentPropsWithRef, JSX } from 'react';
import { ListRowFrame } from '../primitives/ListRow';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { INLINE_TOKEN_CHIP_CLASS } from '../primitives/InlineMention';

type DiffTone = 'add' | 'del' | 'context';
const DIFF_FILL: Record<DiffTone, string> = {
  add: 'bg-success-subtle',
  del: 'bg-destructive-subtle',
  context: '',
};
const DIFF_GUTTER_INK: Record<DiffTone, string> = {
  add: 'fg-success',
  del: 'fg-destructive',
  context: 'fg-tertiary',
};

export function DiffPatchRow({
  tone,
  ...props
}: Omit<ComponentPropsWithRef<'tr'>, 'className'> & {
  readonly tone: DiffTone;
}): JSX.Element {
  return <tr {...props} className={DIFF_FILL[tone]} />;
}

type DiffCellProps = Omit<ComponentPropsWithRef<'td'>, 'className'>;

export function DiffHunkCell(props: DiffCellProps): JSX.Element {
  return <td {...props} className="bg-fg-primary/[0.04] px-3 fg-secondary" />;
}

export function DiffFileHeaderCell(props: DiffCellProps): JSX.Element {
  return (
    <td
      {...props}
      className="sticky top-0 border-y bg-base px-3 py-1 fg-primary"
    />
  );
}

export function DiffSplitFillerCell({
  side,
  gutter,
  ...props
}: DiffCellProps & {
  readonly side: 'old' | 'new';
  readonly gutter?: boolean;
}): JSX.Element {
  return (
    <td
      {...props}
      className={`bg-fg-primary/[0.03] ${gutter ? (side === 'new' ? 'border-l' : '') : 'w-1/2'}`}
    />
  );
}

export function DiffSplitLineNumberCell({
  side,
  tone,
  ...props
}: DiffCellProps & {
  readonly side: 'old' | 'new';
  readonly tone: DiffTone;
}): JSX.Element {
  return (
    <td
      {...props}
      className={`select-none whitespace-nowrap px-2 text-right align-top tabular-nums ${DIFF_FILL[tone]} ${DIFF_GUTTER_INK[tone]} ${side === 'new' ? 'border-l' : ''}`}
    />
  );
}

export function DiffSplitCodeCell({
  tone,
  ...props
}: DiffCellProps & {
  readonly tone: DiffTone;
}): JSX.Element {
  return (
    <td
      {...props}
      className={`w-1/2 whitespace-pre pr-4 align-top fg-primary ${DIFF_FILL[tone]}`}
    />
  );
}

export function FileOverlapChoiceSurface({
  disabled,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly disabled: boolean;
}): JSX.Element {
  return (
    <ListRowFrame
      {...props}
      layout="file-overlap"
      state={disabled ? 'disabled' : 'pressable'}
    />
  );
}

export function FileOverlapChangeMark(
  props: Omit<ComponentPropsWithRef<'mark'>, 'className'>,
): JSX.Element {
  return <mark {...props} className="rounded-sm bg-accent-subtle fg-primary" />;
}

export function FileLineRangeHighlight(
  props: Omit<ComponentPropsWithRef<'span'>, 'className'>,
): JSX.Element {
  return (
    <span
      {...props}
      className="-mx-4 block border-l-2 border-line-accent bg-accent-subtle pl-3.5 pr-4"
    />
  );
}

export function FileHtmlPreviewFrame(
  props: Omit<ComponentPropsWithRef<'iframe'>, 'className'>,
): JSX.Element {
  return (
    <iframe
      {...props}
      className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 border-0 bg-white`}
    />
  );
}

export function FileReferenceChip({
  selected,
  ...props
}: Omit<ComponentPropsWithRef<'span'>, 'className'> & {
  readonly selected: boolean;
}): JSX.Element {
  return (
    <span
      {...props}
      className={`${INLINE_TOKEN_CHIP_CLASS}${selected ? ' ring-[length:var(--border-hairline)] ring-line-accent' : ''}`}
    />
  );
}
