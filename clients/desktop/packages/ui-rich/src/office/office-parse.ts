import mammoth from 'mammoth';
import { read, utils, type CellObject, type Range, type WorkSheet } from 'xlsx';
import { assertOfficeArchive } from './office-archive';
import { assertOfficeArchiveExpansion } from './office-expansion';
import type { PptxParseResult } from './pptx-parse';
import { assertXlsxStructure } from './xlsx-admission';

export const XLSX_PREVIEW_MAX_ROWS = 5_000;
export const XLSX_PREVIEW_MAX_COLS = 200;
export const DOCX_PREVIEW_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const XLSX_PREVIEW_MAX_TOTAL_CELLS = 1_000_000;
export const XLSX_PREVIEW_MAX_MERGES = 1_000;

const encoder = new TextEncoder();
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface DocxParseResult {
  readonly kind: 'docx';
  readonly html: string;
  readonly warnings: readonly string[];
}

export interface XlsxMerge {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface XlsxSheetModel {
  readonly name: string;
  readonly rowCount: number;
  readonly colCount: number;
  readonly rows: readonly (readonly string[])[];
  readonly merges: readonly XlsxMerge[];
  readonly hasFormulas: boolean;
}

export interface XlsxParseResult {
  readonly kind: 'xlsx';
  readonly sheets: readonly XlsxSheetModel[];
}

export interface OfficeParseRequest {
  readonly kind: 'docx' | 'xlsx' | 'pptx';
  readonly bytes: ArrayBuffer;
}

export type OfficeParseResult =
  | DocxParseResult
  | XlsxParseResult
  | PptxParseResult;
/**
 * What a failed parse posts: the thrown value's class and system code, never
 * its message, which can quote document content. Hosts validate both against
 * their allowlists before recording anything.
 */
export interface OfficeParseFailure {
  readonly name?: string;
  readonly code?: string;
}

export type OfficeParseResponse =
  | { readonly ok: true; readonly result: OfficeParseResult }
  | { readonly ok: false; readonly error: OfficeParseFailure };

function boundedResult<T extends DocxParseResult | XlsxParseResult>(
  result: T,
): T {
  if (
    encoder.encode(JSON.stringify(result)).byteLength >
    OFFICE_PREVIEW_MAX_OUTPUT_BYTES
  ) {
    throw new Error('Preview output exceeds its budget.');
  }
  return result;
}

function decodedBase64Length(value: string): number {
  return (
    (value.length / 4) * 3 -
    (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  );
}

export async function parseDocxToHtml(
  bytes: ArrayBuffer,
): Promise<DocxParseResult> {
  assertOfficeArchiveExpansion(assertOfficeArchive(bytes, 'docx'));
  let totalImageBytes = 0;
  const converted = await mammoth.convertToHtml(
    { arrayBuffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        if (!IMAGE_TYPES.has(image.contentType))
          return { src: '', alt: 'Unsupported image omitted' };
        const base64 = await image.readAsBase64String();
        const size = decodedBase64Length(base64);
        if (
          size <= 0 ||
          size > DOCX_PREVIEW_MAX_IMAGE_BYTES ||
          totalImageBytes + size > DOCX_PREVIEW_MAX_IMAGE_BYTES
        ) {
          return { src: '', alt: 'Large image omitted' };
        }
        totalImageBytes += size;
        return { src: `data:${image.contentType};base64,${base64}` };
      }),
    },
  );
  return boundedResult({
    kind: 'docx',
    html: converted.value,
    warnings: converted.messages.map((message) => message.message),
  });
}

function validRange(range: Range): boolean {
  return (
    [range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger) &&
    range.s.r >= 0 &&
    range.s.c >= 0 &&
    range.e.r >= range.s.r &&
    range.e.c >= range.s.c &&
    range.e.r < 1_048_576 &&
    range.e.c < 16_384
  );
}

function intersects(left: Range, right: Range): boolean {
  return (
    left.s.r <= right.e.r &&
    right.s.r <= left.e.r &&
    left.s.c <= right.e.c &&
    right.s.c <= left.e.c
  );
}

interface WorkbookBudget {
  cells: number;
  textBytes: number;
}

// SheetJS mixes bang-prefixed metadata and address-keyed cells in an untyped
// index signature. This type-only view describes the keys used below without
// changing the vendor output or the parser's admission and budget checks.
type PreviewWorksheet = Pick<WorkSheet, '!ref' | '!merges'> & {
  readonly '!fullref'?: string;
} & Readonly<Record<string, CellObject | undefined>>;

function sheetModel(
  name: string,
  sheet: PreviewWorksheet | undefined,
  budget: WorkbookBudget,
): XlsxSheetModel {
  const reference = sheet?.['!fullref'] ?? sheet?.['!ref'];
  if (!sheet || !reference) {
    return {
      name,
      rowCount: 0,
      colCount: 0,
      rows: [],
      merges: [],
      hasFormulas: false,
    };
  }
  let range: Range;
  try {
    range = utils.decode_range(reference);
  } catch {
    throw new Error('Invalid worksheet range.');
  }
  if (!validRange(range)) throw new Error('Invalid worksheet range.');
  const mergeRanges = sheet['!merges'] ?? [];
  if (mergeRanges.length > XLSX_PREVIEW_MAX_MERGES)
    throw new Error('Too many merged ranges.');
  let rowCount = range.e.r + 1;
  let colCount = range.e.c + 1;
  for (let index = 0; index < mergeRanges.length; index += 1) {
    const merge = mergeRanges[index];
    if (!validRange(merge)) throw new Error('Invalid merged range.');
    for (let prior = 0; prior < index; prior += 1) {
      if (intersects(merge, mergeRanges[prior]))
        throw new Error('Overlapping merged ranges.');
    }
    rowCount = Math.max(rowCount, merge.e.r + 1);
    colCount = Math.max(colCount, merge.e.c + 1);
  }
  const visibleRows = Math.min(rowCount, XLSX_PREVIEW_MAX_ROWS);
  const visibleCols = Math.min(colCount, XLSX_PREVIEW_MAX_COLS);
  budget.cells += visibleRows * visibleCols;
  if (budget.cells > XLSX_PREVIEW_MAX_TOTAL_CELLS)
    throw new Error('Workbook exceeds the preview cell budget.');
  let hasFormulas = false;
  const rows: string[][] = [];
  for (let rowIndex = 0; rowIndex < visibleRows; rowIndex += 1) {
    const row: string[] = [];
    for (let colIndex = 0; colIndex < visibleCols; colIndex += 1) {
      const cell = sheet[utils.encode_cell({ r: rowIndex, c: colIndex })];
      if (cell?.f !== undefined) hasFormulas = true;
      const value = cell?.v === undefined ? '' : utils.format_cell(cell);
      budget.textBytes += encoder.encode(value).byteLength;
      if (budget.textBytes > OFFICE_PREVIEW_MAX_OUTPUT_BYTES)
        throw new Error('Workbook preview text exceeds its budget.');
      row.push(value);
    }
    rows.push(row);
  }
  const merges = mergeRanges
    .filter((merge) => merge.s.r < visibleRows && merge.s.c < visibleCols)
    .map(
      (merge): XlsxMerge => ({
        startRow: merge.s.r,
        startCol: merge.s.c,
        endRow: Math.min(merge.e.r, visibleRows - 1),
        endCol: Math.min(merge.e.c, visibleCols - 1),
      }),
    );
  return { name, rowCount, colCount, rows, merges, hasFormulas };
}

export function parseXlsxWorkbook(bytes: ArrayBuffer): XlsxParseResult {
  assertXlsxStructure(assertOfficeArchive(bytes, 'xlsx'));
  const data = new Uint8Array(bytes);
  const { SheetNames } = read(data, { type: 'array', bookSheets: true });
  const budget: WorkbookBudget = { cells: 0, textBytes: 0 };
  return boundedResult({
    kind: 'xlsx',
    sheets: SheetNames.map((name, index) => {
      // Multiple sheet names may reference the same XML part. Keep only one
      // vendor worksheet alive so aliases cannot multiply source allocations.
      const workbook = read(data, {
        type: 'array',
        sheets: index,
        dense: false,
        sheetRows: XLSX_PREVIEW_MAX_ROWS,
        cellFormula: true,
        cellNF: false,
        sheetStubs: true,
      });
      return sheetModel(name, workbook.Sheets[name], budget);
    }),
  });
}
