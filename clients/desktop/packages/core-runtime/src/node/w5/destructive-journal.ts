import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN,
  journalSchema,
  type DestructiveRecoveryRecord,
} from '@canopy/protocol/portal/lifecycle-journal';

/** The validated reader shared by live recovery and cold root relocation. */
export async function readDestructiveJournal(
  path: string,
): Promise<DestructiveRecoveryRecord> {
  return journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export interface DestructiveJournalInspection {
  readonly records: readonly {
    readonly name: string;
    readonly record: DestructiveRecoveryRecord;
  }[];
  readonly issues: readonly {
    readonly path: string;
    readonly reason: 'corrupt-file' | 'unknown-artifact';
  }[];
}

/** Cold inspection only: never follows aliased journal entries or changes evidence. */
export async function inspectDestructiveJournals(
  dataRoot: string,
): Promise<DestructiveJournalInspection> {
  const path = 'w5/destructive-lifecycles';
  const directory = join(dataRoot, path);
  const records: Array<DestructiveJournalInspection['records'][number]> = [];
  const issues: Array<DestructiveJournalInspection['issues'][number]> = [];
  try {
    const stat = await lstat(directory).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    });
    if (!stat) return { records, issues };
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { records, issues: [{ path, reason: 'unknown-artifact' }] };
    }
    for (const name of (await readdir(directory)).sort()) {
      const entryPath = `${path}/${name}`;
      try {
        const entry = await lstat(join(directory, name));
        if (
          !LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name) ||
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          entry.nlink !== 1
        ) {
          issues.push({ path: entryPath, reason: 'unknown-artifact' });
          continue;
        }
        records.push({
          name,
          record: await readDestructiveJournal(join(directory, name)),
        });
      } catch {
        issues.push({ path: entryPath, reason: 'corrupt-file' });
      }
    }
  } catch {
    issues.push({ path, reason: 'corrupt-file' });
  }
  return { records, issues };
}

/** The hashed slot a project (no worktree) or worktree journal uses. */
export function lifecycleJournalSlotName(
  workspaceId: string,
  worktreeId?: string,
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([workspaceId, worktreeId ?? null]))
    .digest('hex');
  return `${key}.json`;
}

/** Counts files needing attention, not operations; null means the directory is unreadable. */
export function countDestructiveJournalsNeedingAttention(
  evidence: DestructiveJournalInspection,
): number | null {
  if (
    evidence.issues.some((issue) => issue.path === 'w5/destructive-lifecycles')
  )
    return null;
  const operations = new Map<
    string,
    Array<DestructiveJournalInspection['records'][number]>
  >();
  for (const entry of evidence.records) {
    const copies = operations.get(entry.record.operationId) ?? [];
    copies.push(entry);
    operations.set(entry.record.operationId, copies);
  }
  let count = evidence.issues.length;
  for (const copies of operations.values()) {
    const inconsistent = copies.some(
      ({ record }) => !isDeepStrictEqual(copies[0]?.record, record),
    );
    for (const { name, record } of copies)
      if (
        inconsistent ||
        record.state !== 'completed' ||
        record.cleanupRequired === true ||
        (name !== `${record.operationId}.json` &&
          name !==
            lifecycleJournalSlotName(record.workspaceId, record.worktreeId))
      )
        count += 1;
  }
  return count;
}
