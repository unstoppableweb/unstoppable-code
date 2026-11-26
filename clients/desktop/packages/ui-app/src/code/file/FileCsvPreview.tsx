'use client';

import { CodeBlock } from '@canopy/ui-shared/primitives/CodeBlock';
import { AttachedNotice, CsvPreviewTable } from '@canopy/ui-shared/components';
import { memo, useMemo, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { FileContentScrollBinding } from './FileViewer';

export interface CsvTableModel {
  readonly header: readonly string[] | null;
  readonly rows: readonly (readonly string[])[];
}

export interface FileCsvPreviewProps {
  readonly content: string;
  readonly scrollBinding?: FileContentScrollBinding;
}

const MAX_CSV_TABLE_ROWS = 10_000;
const MAX_CSV_TABLE_CELLS = 100_000;
const CSV_TABLE_LIMIT_ERROR =
  'CSV table limit exceeded (maximum 10,000 rows or 100,000 cells)';

function parseCsvRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellCount = 0;
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let quoteClosed = false;
  let rowHasContent = false;
  function appendField(): void {
    row.push(field);
    if (rowHasContent && cellCount + row.length > MAX_CSV_TABLE_CELLS) {
      throw new Error(CSV_TABLE_LIMIT_ERROR);
    }
    field = '';
    fieldStarted = false;
    quoteClosed = false;
  }
  function appendRow(): void {
    appendField();
    if (rowHasContent) {
      if (rows.length >= MAX_CSV_TABLE_ROWS) {
        throw new Error(CSV_TABLE_LIMIT_ERROR);
      }
      cellCount += row.length;
      rows.push(row);
    }
    row = [];
    rowHasContent = false;
  }
  for (let index = 0; index < content.length; index += 1) {
    const character = content.charAt(index);
    if (inQuotes) {
      if (character === '"') {
        if (content.charAt(index + 1) === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else field += character;
      continue;
    }
    if (quoteClosed) {
      if (character === delimiter) appendField();
      else if (character === '\n') appendRow();
      else if (character === '\r') {
        if (content.charAt(index + 1) === '\n') index += 1;
        appendRow();
      } else if (character !== ' ' && character !== '\t') {
        throw new Error('Invalid closing quote');
      }
      continue;
    }
    if (character === '"') {
      if (fieldStarted || field.length > 0)
        throw new Error('Invalid opening quote');
      inQuotes = true;
      fieldStarted = true;
      rowHasContent = true;
    } else if (character === delimiter) {
      rowHasContent = true;
      appendField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content.charAt(index + 1) === '\n') index += 1;
      appendRow();
    } else {
      field += character;
      fieldStarted = true;
      rowHasContent = true;
    }
  }
  if (inQuotes) throw new Error('Quote not closed');
  if (row.length > 0 || field.length > 0 || fieldStarted || quoteClosed)
    appendRow();
  const expectedLength = rows[0]?.length;
  rows.forEach((item, index) => {
    if (expectedLength !== undefined && item.length !== expectedLength) {
      throw new Error(
        `Invalid Record Length: expect ${expectedLength}, got ${item.length} on line ${index + 1}`,
      );
    }
  });
  return rows;
}

export function parseCsvTableContent(
  content: string,
  delimiter = ',',
): {
  readonly rows: string[][] | null;
  readonly error: string | null;
} {
  try {
    return { rows: parseCsvRows(content, delimiter), error: null };
  } catch (error) {
    return {
      rows: null,
      error: error instanceof Error ? error.message : 'Unknown parse error',
    };
  }
}

function looksLikeDataValue(value: string): boolean {
  const normalized = value.trim();
  return (
    /^-?\d+(\.\d+)?$/.test(normalized) ||
    /^(true|false)$/i.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}(?:[t T].*)?$/.test(normalized) ||
    normalized.length === 0
  );
}

export function buildCsvTableModel(rows: readonly string[][]): CsvTableModel {
  const first = rows[0];
  const hasHeader =
    rows.length >= 2 &&
    first !== undefined &&
    first.some((cell) => /[A-Za-z]/.test(cell)) &&
    rows.slice(1).some((item) => item.some(looksLikeDataValue));
  return hasHeader
    ? { header: first, rows: rows.slice(1) }
    : { header: null, rows };
}

function FileCsvPreviewImpl({
  content,
  scrollBinding,
}: FileCsvPreviewProps): JSX.Element {
  const parsed = useMemo(() => parseCsvTableContent(content), [content]);
  if (parsed.error || !parsed.rows || parsed.rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AttachedNotice variant="csv-fallback">
          {parsed.error
            ? `Could not parse as CSV: ${parsed.error}. Showing raw text.`
            : 'No CSV rows detected. Showing raw text.'}
        </AttachedNotice>
        <CodeBlock
          ref={scrollBinding?.ref}
          onScroll={scrollBinding?.onScroll}
          data-testid="file-viewer-csv-raw-scroll"
          variant="document"
          inset="roomy"
          size="xs"
          wrap="none"
          tone="primary"
          replay="block"
          className="min-h-0 flex-1"
        >
          {content}
        </CodeBlock>
      </div>
    );
  }
  const table = buildCsvTableModel(parsed.rows);
  return (
    <div
      ref={scrollBinding?.ref}
      onScroll={scrollBinding?.onScroll}
      data-testid="file-viewer-csv-table-scroll"
      data-selectable
      className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
    >
      <CsvPreviewTable header={table.header} rows={table.rows} />
    </div>
  );
}

export const FileCsvPreview = memo(FileCsvPreviewImpl);
