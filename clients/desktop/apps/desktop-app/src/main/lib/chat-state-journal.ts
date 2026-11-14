import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import type { ChatJournalRecord } from '@canopy/desktop-shared/types';
import { writeJsonValuesCooperatively } from './cooperative-json';

export interface ChatJournalDiagnostic {
  kind:
    | 'partial_tail'
    | 'malformed_record'
    | 'advisory_threshold_exceeded'
    | 'repaired_snapshot'
    | 'regressed_snapshot'
    | 'unrecoverable_snapshot'
    | 'unrecoverable_journal';
  message: string;
  quarantinePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JOURNAL_SOURCES = new Set([
  'renderer-command',
  'provider',
  'terminal',
  'automation',
  'portal',
  'hook',
  'import',
  'migration',
]);

export function isChatJournalRecord(
  value: unknown,
): value is ChatJournalRecord {
  return (
    isRecord(value) &&
    value.v === 1 &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    typeof value.mutationId === 'string' &&
    value.mutationId.length > 0 &&
    typeof value.occurredAt === 'string' &&
    typeof value.source === 'string' &&
    JOURNAL_SOURCES.has(value.source) &&
    Array.isArray(value.mutations) &&
    value.mutations.length > 0
  );
}

export async function writeSyncedJsonTemp(
  targetPath: string,
  value: unknown,
  options: { shouldAbort?: () => boolean } = {},
): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    await writeJsonValuesCooperatively(tempPath, [value], {
      pretty: true,
      shouldAbort: options.shouldAbort,
    });
    return tempPath;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The shared D1 directory flush, without the chat-storage work counter. */
export async function fsyncDirectory(directoryPath: string): Promise<void> {
  await flushDirectory(directoryPath);
}
