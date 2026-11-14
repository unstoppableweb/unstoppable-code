import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export const MINIDUMP_READ_BUDGET_BYTES = 16 * 1024;

export type MinidumpExecutableResult =
  | { readonly status: 'ok'; readonly executablePath: string }
  | { readonly status: 'unreadable' };

interface ReadBudget {
  bytesRead: number;
}

interface ModuleListStream {
  readonly dataSize: number;
  readonly rva: number;
}

const MINIDUMP_SIGNATURE = 0x504d444d;
const MINIDUMP_VERSION = 0xa793;
const MINIDUMP_HEADER_SIZE = 32;
const MINIDUMP_TIMESTAMP_OFFSET = 20;
const MINIDUMP_DIRECTORY_SIZE = 12;
const MINIDUMP_MODULE_LIST_STREAM = 4;
const MINIDUMP_MODULE_SIZE = 108;
const MINIDUMP_MODULE_NAME_RVA_OFFSET = 20;
const MAX_STREAM_COUNT = 256;
const MAX_MODULE_NAME_BYTES = 2048;

// The 32-byte header and 12-byte directories follow Microsoft's minidump API:
// https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_module
// MINIDUMP_MODULE is 108 bytes: a base u64, four u32s, 52-byte file info,
// two descriptors and two u64s; ModuleNameRva is at byte 20.
// Breakpad uses module 0 as the main module and caps names at 1024 UTF-16 units:
// https://raw.githubusercontent.com/google/breakpad/main/src/processor/minidump.cc

type ReadMinidumpBytes = (
  offset: number,
  length: number,
) => Promise<Buffer | null>;

export async function readMinidumpExecutablePath(
  filePath: string,
): Promise<MinidumpExecutableResult> {
  const executablePath = await withMinidump(
    filePath,
    async (streamDirectory, readBytes, inRange) => {
      let moduleListStream: ModuleListStream | undefined;
      for (
        let index = 0;
        index < streamDirectory.length / MINIDUMP_DIRECTORY_SIZE;
        index += 1
      ) {
        const entryOffset = index * MINIDUMP_DIRECTORY_SIZE;
        const streamType = streamDirectory.readUInt32LE(entryOffset);
        if (streamType !== MINIDUMP_MODULE_LIST_STREAM) {
          continue;
        }
        if (moduleListStream !== undefined) {
          return undefined;
        }
        moduleListStream = {
          dataSize: streamDirectory.readUInt32LE(entryOffset + 4),
          rva: streamDirectory.readUInt32LE(entryOffset + 8),
        };
      }

      if (
        moduleListStream === undefined ||
        moduleListStream.dataSize < 4 ||
        !inRange(moduleListStream.rva, moduleListStream.dataSize)
      ) {
        return undefined;
      }

      const moduleCountBytes = await readBytes(moduleListStream.rva, 4);
      if (moduleCountBytes === null) {
        return undefined;
      }
      const moduleCount = moduleCountBytes.readUInt32LE(0);
      const moduleListBytes = 4 + moduleCount * MINIDUMP_MODULE_SIZE;
      if (moduleCount < 1 || moduleListBytes > moduleListStream.dataSize) {
        return undefined;
      }

      const firstModule = await readBytes(
        moduleListStream.rva + 4,
        MINIDUMP_MODULE_NAME_RVA_OFFSET + 4,
      );
      if (firstModule === null) {
        return undefined;
      }
      const nameRva = firstModule.readUInt32LE(MINIDUMP_MODULE_NAME_RVA_OFFSET);
      const nameLengthBytes = await readBytes(nameRva, 4);
      if (nameLengthBytes === null) {
        return undefined;
      }
      const nameLength = nameLengthBytes.readUInt32LE(0);
      if (
        nameLength < 2 ||
        nameLength > MAX_MODULE_NAME_BYTES ||
        nameLength % 2 !== 0
      ) {
        return undefined;
      }

      const nameBytes = await readBytes(nameRva + 4, nameLength);
      if (nameBytes === null) {
        return undefined;
      }
      const executablePath = decodeStrictUtf16Le(nameBytes);
      if (executablePath === undefined) {
        return undefined;
      }

      return executablePath;
    },
  ).catch(() => undefined);
  return executablePath === undefined
    ? { status: 'unreadable' }
    : { status: 'ok', executablePath };
}

async function withMinidump<T>(
  filePath: string,
  read: (
    directory: Buffer,
    readBytes: ReadMinidumpBytes,
    inRange: (offset: number, length: number) => boolean,
    timestampSeconds: number,
  ) => Promise<T | undefined>,
): Promise<T | undefined> {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === 'number') {
    flags |= fsConstants.O_NOFOLLOW;
  }
  // POSIX only: a FIFO would otherwise block the open before fstat rejects it.
  if (typeof fsConstants.O_NONBLOCK === 'number') {
    flags |= fsConstants.O_NONBLOCK;
  }

  const handle = await fsPromises.open(filePath, flags);
  try {
    const fileStats = await handle.stat();
    if (
      !fileStats.isFile() ||
      !Number.isSafeInteger(fileStats.size) ||
      fileStats.size < 0
    ) {
      return undefined;
    }

    const fileSize = fileStats.size;
    const budget: ReadBudget = { bytesRead: 0 };
    const header = await readExact(
      handle,
      fileSize,
      0,
      MINIDUMP_HEADER_SIZE,
      budget,
    );
    if (
      header === null ||
      header.readUInt32LE(0) !== MINIDUMP_SIGNATURE ||
      (header.readUInt32LE(4) & 0xffff) !== MINIDUMP_VERSION
    ) {
      return undefined;
    }

    const streamCount = header.readUInt32LE(8);
    if (streamCount < 1 || streamCount > MAX_STREAM_COUNT) {
      return undefined;
    }

    const streamDirectoryRva = header.readUInt32LE(12);
    const streamDirectorySize = streamCount * MINIDUMP_DIRECTORY_SIZE;
    if (!isRangeWithinFile(streamDirectoryRva, streamDirectorySize, fileSize)) {
      return undefined;
    }

    const streamDirectory = await readExact(
      handle,
      fileSize,
      streamDirectoryRva,
      streamDirectorySize,
      budget,
    );
    if (streamDirectory === null) {
      return undefined;
    }

    return await read(
      streamDirectory,
      (offset, length) => readExact(handle, fileSize, offset, length, budget),
      (offset, length) => isRangeWithinFile(offset, length, fileSize),
      header.readUInt32LE(MINIDUMP_TIMESTAMP_OFFSET),
    );
  } finally {
    // Closing is best effort and must not change the reader's result.
    await handle.close().catch(() => undefined);
  }
}

export const MAIN_CRASH_ELIGIBLE_ANNOTATION = 'canopy_main_crash_eligible';

const CRASHPAD_INFO_STREAM = 0x43500001;

// Crashpad's version-1 stream contains a process dictionary and a list of
// module annotation descriptors. Electron stores main-only extra parameters
// as typed crash keys, which Crashpad serializes as module annotation objects.
export async function readMainCrash(
  filePath: string,
): Promise<{ version: string; timestamp?: Date } | undefined> {
  return withMinidump(filePath, async (directory, read, _inRange, seconds) => {
    const timestamp = seconds > 0 ? new Date(seconds * 1000) : undefined;
    const stream = findCrashpadStream(directory);
    if (!stream || stream.dataSize < 52) return undefined;
    const info = await read(stream.rva, 52);
    if (!info || info.readUInt32LE(0) < 1) return undefined;
    const processMarker = await readCrashEligibilityAnnotation(info, 36, read);
    if (processMarker) return { version: processMarker, timestamp };

    const modules = await readCrashpadList(info, 44, 12, read);
    if (!modules) return undefined;
    for (let offset = 0; offset < modules.length; offset += 12) {
      const size = modules.readUInt32LE(offset + 4);
      if (size < 28) continue;
      const moduleInfo = await read(modules.readUInt32LE(offset + 8), 28);
      if (!moduleInfo || moduleInfo.readUInt32LE(0) < 1) continue;
      const marker = await readCrashEligibilityAnnotation(
        moduleInfo,
        20,
        read,
        true,
      );
      if (marker) return { version: marker, timestamp };
    }
    return undefined;
  });
}

function findCrashpadStream(directory: Buffer): ModuleListStream | undefined {
  for (
    let offset = 0;
    offset < directory.length;
    offset += MINIDUMP_DIRECTORY_SIZE
  ) {
    if (directory.readUInt32LE(offset) === CRASHPAD_INFO_STREAM) {
      return {
        dataSize: directory.readUInt32LE(offset + 4),
        rva: directory.readUInt32LE(offset + 8),
      };
    }
  }
  return undefined;
}

async function readCrashpadList(
  info: Buffer,
  descriptor: number,
  entrySize: number,
  read: ReadMinidumpBytes,
): Promise<Buffer | null> {
  const size = info.readUInt32LE(descriptor);
  const rva = info.readUInt32LE(descriptor + 4);
  if (size < 4 || size > 4 + 256 * entrySize || rva === 0) return null;
  const list = await read(rva, size);
  if (!list || list.readUInt32LE(0) * entrySize !== size - 4) return null;
  return list.subarray(4);
}

async function readCrashEligibilityAnnotation(
  info: Buffer,
  descriptor: number,
  read: ReadMinidumpBytes,
  typed = false,
): Promise<string | undefined> {
  const entrySize = typed ? 12 : 8;
  const entries = await readCrashpadList(info, descriptor, entrySize, read);
  if (!entries) return undefined;
  for (let offset = 0; offset < entries.length; offset += entrySize) {
    // Crashpad Annotation::Type::kString.
    if (typed && entries.readUInt16LE(offset + 4) !== 1) continue;
    const key = await readCrashpadString(
      entries.readUInt32LE(offset),
      MAIN_CRASH_ELIGIBLE_ANNOTATION.length,
      read,
    );
    if (key !== MAIN_CRASH_ELIGIBLE_ANNOTATION) continue;
    const valueRva = entries.readUInt32LE(offset + (typed ? 8 : 4));
    const value = await readCrashpadString(valueRva, 128, read);
    return value && /^[0-9][a-zA-Z0-9._+-]*$/.test(value) ? value : undefined;
  }
  return undefined;
}

async function readCrashpadString(
  rva: number,
  maxLength: number,
  read: ReadMinidumpBytes,
): Promise<string | undefined> {
  if (rva === 0) return undefined;
  const prefix = await read(rva, 4);
  const length = prefix?.readUInt32LE(0) ?? 0;
  if (length === 0 || length > maxLength) return undefined;
  return (await read(rva + 4, length))?.toString('utf8');
}

async function readExact(
  handle: FileHandle,
  fileSize: number,
  offset: number,
  length: number,
  budget: ReadBudget,
): Promise<Buffer | null> {
  if (!isRangeWithinFile(offset, length, fileSize)) {
    return null;
  }

  const buffer = Buffer.alloc(length);
  let totalBytesRead = 0;
  while (totalBytesRead < length) {
    const remainingBudget = MINIDUMP_READ_BUDGET_BYTES - budget.bytesRead;
    if (remainingBudget <= 0) {
      return null;
    }
    const requestedBytes = Math.min(length - totalBytesRead, remainingBudget);
    const result = await handle.read(
      buffer,
      totalBytesRead,
      requestedBytes,
      offset + totalBytesRead,
    );
    const bytesRead = result.bytesRead;
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
      return null;
    }
    budget.bytesRead += bytesRead;
    if (bytesRead === 0) {
      throw new Error('Minidump changed during the read');
    }
    if (
      bytesRead > requestedBytes ||
      budget.bytesRead > MINIDUMP_READ_BUDGET_BYTES
    ) {
      return null;
    }
    totalBytesRead += bytesRead;
  }
  return buffer;
}

function isRangeWithinFile(
  offset: number,
  length: number,
  fileSize: number,
): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    Number.isSafeInteger(fileSize) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= fileSize
  );
}

function decodeStrictUtf16Le(buffer: Buffer): string | undefined {
  let decoded = '';
  for (let offset = 0; offset < buffer.length; offset += 2) {
    const codeUnit = buffer.readUInt16LE(offset);
    if (codeUnit === 0) {
      return undefined;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextOffset = offset + 2;
      if (nextOffset >= buffer.length) {
        return undefined;
      }
      const nextCodeUnit = buffer.readUInt16LE(nextOffset);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return undefined;
      }
      decoded += String.fromCharCode(codeUnit, nextCodeUnit);
      offset = nextOffset;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    decoded += String.fromCharCode(codeUnit);
  }
  return decoded;
}
