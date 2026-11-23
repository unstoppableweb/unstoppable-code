const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const MAX_ENTRIES = 2_000;
const MAX_ENTRY_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_EXPANDED_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * A fatal UTF-8 decode failure is a damaged entry name (a damaged file), not a
 * parser defect: rethrow it as the plain `Error` the other archive checks use.
 */
function decodeEntryName(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error('Malformed Office ZIP entry name.');
  }
}

function requireRange(length: number, offset: number, size: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > length - size
  ) {
    throw new Error('Malformed Office ZIP bounds.');
  }
}

function findEnd(bytes: Uint8Array, view: DataView): number {
  const first = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  let found: number | undefined;
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) {
        if (found !== undefined)
          throw new Error('Ambiguous Office ZIP end record.');
        found = offset;
      }
    }
  }
  if (found !== undefined) {
    for (let offset = found + 4; offset <= bytes.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
        throw new Error(
          'Office ZIP comments may not contain end-record signatures.',
        );
      }
    }
    return found;
  }
  throw new Error('Office file is not a supported ZIP archive.');
}

function rejectZip64Extra(
  data: Uint8Array,
  view: DataView,
  offset: number,
  length: number,
): void {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    requireRange(data.length, cursor, 4);
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    requireRange(end, cursor + 4, size);
    if (id === 0x0001)
      throw new Error('ZIP64 Office archives are unsupported.');
    cursor += 4 + size;
  }
  if (cursor !== end) throw new Error('Malformed Office ZIP extra fields.');
}

export type OfficeArchiveKind = 'docx' | 'xlsx' | 'pptx';

const PACKAGE_ROOTS: Readonly<Record<OfficeArchiveKind, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

/** Compressed bytes of one admitted entry, as consumed by expansion checks. */
export interface OfficeArchiveData {
  readonly data: Uint8Array;
  readonly method: number;
  readonly expandedSize: number;
}

export interface OfficeArchiveEntry extends OfficeArchiveData {
  readonly name: string;
}

export function assertOfficeArchive(
  bytes: ArrayBuffer,
  kind: OfficeArchiveKind,
): readonly OfficeArchiveEntry[] {
  const data = new Uint8Array(bytes);
  if (data.length < 22)
    throw new Error('Office file is not a supported ZIP archive.');
  const view = new DataView(bytes);
  const end = findEnd(data, view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries)
    throw new Error('Multi-disk ZIP archives are unsupported.');
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    throw new Error('ZIP64 Office archives are unsupported.');
  if (totalEntries > MAX_ENTRIES)
    throw new Error('Office archive has too many entries.');
  requireRange(data.length, centralOffset, centralSize);
  if (centralOffset + centralSize > end)
    throw new Error('Malformed Office ZIP directory.');

  const names = new Set<string>();
  const entries: OfficeArchiveEntry[] = [];
  let expandedTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(data.length, cursor, 46);
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE)
      throw new Error('Malformed Office ZIP directory entry.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const expandedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entryDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if ((flags & 1) !== 0)
      throw new Error('Encrypted Office archives are unsupported.');
    if (method !== 0 && method !== 8)
      throw new Error('Unsupported Office ZIP compression method.');
    if (entryDisk !== 0)
      throw new Error('Multi-disk ZIP archives are unsupported.');
    if ([compressedSize, expandedSize, localOffset].includes(0xffffffff))
      throw new Error('ZIP64 Office archives are unsupported.');
    requireRange(
      data.length,
      cursor + 46,
      nameLength + extraLength + commentLength,
    );
    rejectZip64Extra(data, view, cursor + 46 + nameLength, extraLength);
    requireRange(data.length, localOffset, 30);
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE)
      throw new Error('Malformed Office ZIP local entry.');
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localChecksum = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localExpandedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength
    ) {
      throw new Error(
        'Office ZIP directory metadata does not match its local entry.',
      );
    }
    if ([localCompressedSize, localExpandedSize].includes(0xffffffff))
      throw new Error('ZIP64 Office archives are unsupported.');
    if (localExpandedSize > MAX_ENTRY_EXPANDED_BYTES)
      throw new Error(
        'Office archive local entry exceeds its expanded-size budget.',
      );
    if (
      (flags & 8) === 0 &&
      (localChecksum !== checksum ||
        localCompressedSize !== compressedSize ||
        localExpandedSize !== expandedSize)
    ) {
      throw new Error(
        'Office ZIP local sizes do not match the central directory.',
      );
    }
    if (
      (flags & 8) !== 0 &&
      ((localChecksum !== 0 && localChecksum !== checksum) ||
        (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
        (localExpandedSize !== 0 && localExpandedSize !== expandedSize))
    ) {
      throw new Error('Office ZIP data-descriptor sizes are inconsistent.');
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(data.length, dataOffset, localCompressedSize);
    requireRange(data.length, dataOffset, compressedSize);
    rejectZip64Extra(
      data,
      view,
      localOffset + 30 + localNameLength,
      localExtraLength,
    );
    const name = decodeEntryName(
      data.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const localName = decodeEntryName(
      data.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localName !== name)
      throw new Error('Office ZIP entry names do not match.');
    if (names.has(name))
      throw new Error('Office archive contains duplicate entries.');
    names.add(name);
    if (expandedSize > MAX_ENTRY_EXPANDED_BYTES)
      throw new Error('Office archive entry exceeds its expanded-size budget.');
    expandedTotal += expandedSize;
    if (expandedTotal > MAX_TOTAL_EXPANDED_BYTES)
      throw new Error('Office archive exceeds its expanded-size budget.');
    entries.push({
      name,
      data: data.subarray(dataOffset, dataOffset + compressedSize),
      method,
      expandedSize,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize)
    throw new Error('Malformed Office ZIP directory size.');
  const otherRootPresent = Object.entries(PACKAGE_ROOTS).some(
    ([otherKind, root]) => otherKind !== kind && names.has(root),
  );
  if (
    !names.has('[Content_Types].xml') ||
    !names.has('_rels/.rels') ||
    !names.has(PACKAGE_ROOTS[kind]) ||
    otherRootPresent
  ) {
    throw new Error(`Archive is not a ${kind.toUpperCase()} package.`);
  }
  for (const name of names) {
    if (name.toLowerCase().endsWith('/vbaproject.bin'))
      throw new Error('Macro-enabled Office files are unsupported.');
    // SheetJS dispatches .bin parts to XLSB parsers, bypassing XML budgets.
    if (kind === 'xlsx' && name.toLowerCase().endsWith('.bin'))
      throw new Error('Binary workbook parts are unsupported for preview.');
  }
  return entries;
}
