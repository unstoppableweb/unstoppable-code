import type { JSX, ReactNode } from 'react';
import { Fact, FactList } from '../primitives/FactList';

/**
 * The label and value columns of a detail page's facts (Website, Marketplace,
 * Status), so every fact lines up however long its label is.
 */
export const DETAIL_FACT_GRID_CLASS =
  'grid min-h-7 grid-cols-[9rem_minmax(0,1fr)] items-center gap-x-4';

/** Lines text up with a fact's value column when it sits under the grid. */
export const DETAIL_FACT_VALUE_OFFSET_CLASS = 'pl-[10rem]';

export function DetailFactList({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <FactList
      labelWidth="9rem"
      size="s"
      rowGap="1"
      rowHeight="control"
      labelTone="secondary"
    >
      {children}
    </FactList>
  );
}

export function DetailFact({
  label,
  children,
  testId,
}: {
  label: string;
  children?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <Fact label={label} fit="inline-spaced" testId={testId}>
      {children}
    </Fact>
  );
}
