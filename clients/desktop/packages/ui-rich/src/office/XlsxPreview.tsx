'use client';

import {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
import {
  Surface,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  TabBar,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { XlsxSheetModel } from './office-parse';
import {
  officePreviewRenderFailure,
  parseOfficeDocument,
} from './office-parse-client';
import { OfficePreviewBanner } from './OfficePreviewBanner';
import { OfficeDocumentRegion } from './OfficeDocumentSurface';
import { cellKey, columnLabel, coveredCells, spanByAnchor } from './xlsx-grid';

const ROW_HEIGHT_PX = 28;
const OVERSCAN_ROWS = 10;

export interface XlsxPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly createWorker: () => Worker;
  readonly copy?: OfficePreviewCopy;
  /** `error` accompanies a `worker-defect` only, for the host to record. */
  readonly onRenderFailure: (
    failure: OfficePreviewRenderFailure,
    error?: unknown,
  ) => void;
}

type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: ArrayBuffer;
      readonly sheets: readonly XlsxSheetModel[];
    };

export function XlsxPreview({
  bytes,
  fileName,
  createWorker,
  copy = DEFAULT_OFFICE_PREVIEW_COPY,
  onRenderFailure,
}: XlsxPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [activeSheet, setActiveSheet] = useState(0);
  const tabsId = useId();
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const result = await parseOfficeDocument(
          { kind: 'xlsx', bytes },
          { createWorker, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.kind !== 'xlsx') throw new Error('Unexpected parse result.');
        setActiveSheet(0);
        setState({ status: 'ready', bytes, sheets: result.sheets });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (officePreviewRenderFailure(error) === 'worker-defect')
          onRenderFailure('worker-defect', error);
        else onRenderFailure('parse-failed');
      }
    })();
    return (): void => controller.abort();
  }, [bytes, createWorker, onRenderFailure]);

  // Both roots share the block: the workbook reuses the loading root div, and
  // the recorder ignores a block class added to an element it already recorded.
  if (state.status === 'loading' || state.bytes !== bytes) {
    return (
      <div
        className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
        data-testid="xlsx-preview"
      >
        <OfficePreviewBanner text={copy.banner} />
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="xlsx-preview-loading"
        >
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner spacing="section" />
          </DelayedLoadingPlaceholder>
        </div>
      </div>
    );
  }
  const sheet = state.sheets[activeSheet] ?? state.sheets[0];
  return (
    <div
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      data-testid="xlsx-preview"
    >
      <OfficePreviewBanner text={copy.banner} />
      <TabBar
        items={state.sheets.map((entry, index) => ({
          id: String(index),
          label: entry.name,
          dataTestId: 'xlsx-sheet-tab',
          tabId: `${tabsId}-tab-${index}`,
        }))}
        value={String(activeSheet)}
        onChange={(next): void => setActiveSheet(Number(next))}
        label={`Sheets in ${fileName}`}
        density="compact"
        panelId={`${tabsId}-panel`}
        scrollable
      />
      <div
        role="tabpanel"
        data-selectable
        id={`${tabsId}-panel`}
        aria-labelledby={sheet ? `${tabsId}-tab-${activeSheet}` : undefined}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col"
      >
        {sheet && sheet.rows.length > 0 ? (
          <SheetGrid
            key={`${activeSheet}:${sheet.name}`}
            sheet={sheet}
            truncationRecovery={copy.truncationRecovery}
          />
        ) : (
          <p
            className="p-6 text-center text-xs fg-secondary"
            data-testid="xlsx-empty"
          >
            {sheet
              ? `${sheet.name} is empty.`
              : 'This workbook has no sheets to preview.'}
          </p>
        )}
      </div>
    </div>
  );
}

function SheetGrid({
  sheet,
  truncationRecovery,
}: {
  readonly sheet: XlsxSheetModel;
  readonly truncationRecovery: string;
}): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const visibleCols = sheet.rows.reduce(
    (largest, row) => Math.max(largest, row.length),
    0,
  );
  const rowsTruncated = sheet.rowCount > sheet.rows.length;
  const colsTruncated = sheet.colCount > visibleCols;
  const spans = useMemo(() => spanByAnchor(sheet.merges), [sheet.merges]);
  // TanStack Virtual owns mutable measurement state by design.
  const virtualizer = useVirtualizer({
    count: sheet.rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      for (const merge of sheet.merges) {
        if (
          merge.endRow >= range.startIndex &&
          merge.startRow <= range.endIndex
        )
          indexes.push(merge.startRow);
      }
      return [...new Set(indexes)].sort((left, right) => left - right);
    },
  });
  const items = virtualizer.getVirtualItems();
  const covered = coveredCells(
    sheet.merges,
    new Set(items.map((item) => item.index)),
  );
  const gridTemplateColumns = `48px repeat(${visibleCols}, 140px)`;
  return (
    <>
      {(rowsTruncated || colsTruncated) && (
        <Surface variant="section" boundary="bottom" className="shrink-0">
          <div
            role="status"
            className="shrink-0 px-3 py-1.5 text-xs fg-secondary"
            data-testid="xlsx-truncation-banner"
          >
            Showing the first {sheet.rows.length.toLocaleString('en-US')} of{' '}
            {sheet.rowCount.toLocaleString('en-US')} rows
            {colsTruncated
              ? ` and ${visibleCols} of ${sheet.colCount} columns`
              : ''}
            . {truncationRecovery}
          </div>
        </Surface>
      )}
      {(sheet.hasFormulas || rowsTruncated || colsTruncated) && (
        <Surface variant="section" boundary="bottom" className="shrink-0">
          <div
            className="shrink-0 px-3 py-1.5 text-xs fg-secondary"
            data-testid="xlsx-formula-note"
          >
            Cells show the values saved in the file; formulas are not
            recalculated.
          </div>
        </Surface>
      )}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        data-testid="xlsx-grid"
        data-row-count={sheet.rows.length}
      >
        <div
          role="table"
          aria-label={sheet.name}
          aria-rowcount={sheet.rows.length + 1}
          aria-colcount={visibleCols + 1}
          className="text-xs"
          style={{ width: 48 + visibleCols * 140 }}
        >
          {/*
           * The frozen edge. Both this header row and the row-number gutter
           * below are `position: sticky`, so they have to be OPAQUE or the
           * rows travelling underneath read straight through the column
           * letters and the row numbers. `bg-secondary` also fills the gutter
           * corner, so the header and the gutter read as one edge rather than
           * a filled strip with a hole at its origin.
           */}
          <OfficeDocumentRegion
            role="row"
            aria-rowindex={1}
            kind="frozen-edge"
            className="sticky top-0 z-10 grid"
            style={{ gridTemplateColumns, height: ROW_HEIGHT_PX }}
          >
            <div role="columnheader" aria-label="Row number" />
            {Array.from({ length: visibleCols }, (_, col) => (
              <OfficeDocumentRegion
                key={col}
                role="columnheader"
                aria-colindex={col + 2}
                kind="document-edge"
                className="px-2 font-medium fg-secondary"
              >
                {columnLabel(col)}
              </OfficeDocumentRegion>
            ))}
          </OfficeDocumentRegion>
          <div
            role="rowgroup"
            className="relative"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                data-index={item.index}
                className="absolute left-0 grid"
                style={{
                  top: item.start,
                  height: ROW_HEIGHT_PX,
                  gridTemplateColumns,
                }}
              >
                {/*
                 * `z-2`, not the header row's `z-10` and not `z-index: auto`.
                 * Painting order decides what a sticky gutter covers: the
                 * cells are positioned siblings LATER in tree order, so at
                 * `auto` they paint over the gutter and its fill buys
                 * nothing, and a merged cell explicitly takes `1`. Above
                 * both, below the header row, so the top-left corner stays
                 * the header's.
                 */}
                <OfficeDocumentRegion
                  role="rowheader"
                  aria-colindex={1}
                  kind="frozen-cell"
                  className="sticky left-0 z-2 col-start-1 px-2 text-right fg-secondary"
                >
                  {item.index + 1}
                </OfficeDocumentRegion>
                {Array.from({ length: visibleCols }, (_, col) => {
                  const key = cellKey(item.index, col);
                  if (covered.has(key)) return null;
                  const span = spans.get(key);
                  const value = sheet.rows[item.index]?.[col] ?? '';
                  return (
                    <OfficeDocumentRegion
                      key={col}
                      role="cell"
                      aria-colindex={col + 2}
                      aria-rowspan={span?.rowSpan}
                      aria-colspan={span?.colSpan}
                      data-testid="xlsx-cell"
                      data-cell={`${columnLabel(col)}${item.index + 1}`}
                      title={value}
                      kind="document-edge"
                      className="relative box-border min-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-2"
                      style={{
                        gridColumn: `${col + 2} / span ${span?.colSpan ?? 1}`,
                        height: (span?.rowSpan ?? 1) * ROW_HEIGHT_PX,
                        zIndex: span ? 1 : undefined,
                      }}
                    >
                      {value}
                    </OfficeDocumentRegion>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
