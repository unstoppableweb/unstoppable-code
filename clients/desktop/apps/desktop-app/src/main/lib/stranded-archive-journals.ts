import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN } from '@canopy/protocol/portal/lifecycle-journal';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import {
  inspectDestructiveJournals,
  journalSchema,
  type DestructiveRecoveryRecord,
} from '@canopy/desktop-shared/node/w5-destructive-journal';
import {
  lifecycleJournalSlotName,
  withSharedLifecycleJournalAccess,
} from './w5-destructive-recovery';
import { getW5DestructiveLifecycleDir } from './paths';

export interface ArchiveJournalOperation {
  record: DestructiveRecoveryRecord;
  names: readonly string[];
  /** All validated copies: relevance must not depend on the representative. */
  records: readonly DestructiveRecoveryRecord[];
  consistent: boolean;
  /** Opaque review binding, not a filesystem target or execution permission. */
  revision: string;
  copies: number;
  sources: { name: string; contents: string; digest: string }[];
  slot: 'same-operation' | 'other-operation' | 'absent';
}

/** Raw persisted evidence. Never use the launch report, which projects active as stranded. */
export function readArchiveJournalOperations(workspaceId: string): Promise<{
  operations: ArchiveJournalOperation[];
  readable: boolean;
  directoryUnreadable: boolean;
}> {
  return withSharedLifecycleJournalAccess(async () => {
    try {
      const inspection = await inspectDestructiveJournals(getCanopyDataDir());
      const directoryUnreadable = inspection.issues.some(
        (issue) => issue.path === 'w5/destructive-lifecycles',
      );
      // Match live recovery/quarantine: atomic-write siblings are not journal entries.
      if (
        directoryUnreadable ||
        inspection.issues.some((issue) =>
          LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(basename(issue.path)),
        )
      )
        return { operations: [], readable: false, directoryUnreadable };
      const groups = new Map<string, (typeof inspection.records)[number][]>();
      for (const entry of inspection.records) {
        const group = groups.get(entry.record.operationId) ?? [];
        group.push(entry);
        groups.set(entry.record.operationId, group);
      }
      const operations: ArchiveJournalOperation[] = [];
      for (const group of groups.values()) {
        const first = group.find(
          (entry) => entry.record.workspaceId === workspaceId,
        );
        if (!first) continue;
        const record = first.record;
        const slotName = lifecycleJournalSlotName(
          workspaceId,
          record.worktreeId,
        );
        const slot = inspection.records.find(
          (entry) => entry.name === slotName,
        );
        const hash = createHash('sha256');
        const sources: ArchiveJournalOperation['sources'] = [];
        let consistent = true;
        let firstValue: unknown;
        for (const [index, entry] of group.entries()) {
          const contents = await readFile(
            join(getW5DestructiveLifecycleDir(), entry.name),
            'utf8',
          );
          sources.push({
            name: entry.name,
            contents,
            digest: createHash('sha256').update(contents).digest('hex'),
          });
          const value: unknown = JSON.parse(contents);
          if (!isDeepStrictEqual(journalSchema.parse(value), entry.record))
            consistent = false;
          if (index === 0) firstValue = value;
          else if (!isDeepStrictEqual(firstValue, value)) consistent = false;
          // A copy may occupy only its own hashed slot or its own UUID history file.
          if (
            entry.name !== slotName &&
            entry.name !== `${record.operationId}.json`
          )
            consistent = false;
          if (!isDeepStrictEqual(entry.record, record)) consistent = false;
          hash.update(entry.name).update('\0').update(contents).update('\0');
        }
        operations.push({
          record,
          names: group.map((entry) => entry.name),
          records: group.map((entry) => entry.record),
          consistent,
          revision: hash.digest('hex'),
          copies: group.length,
          sources,
          slot: !slot
            ? 'absent'
            : slot.record.operationId === record.operationId
              ? 'same-operation'
              : 'other-operation',
        });
      }
      return { operations, readable: true, directoryUnreadable: false };
    } catch {
      // Atomic replacement/removal can race the second read, even under shared access.
      const inspection = await inspectDestructiveJournals(
        getCanopyDataDir(),
      ).catch(() => undefined);
      return {
        operations: [],
        readable: false,
        directoryUnreadable:
          inspection?.issues.some(
            (issue) => issue.path === 'w5/destructive-lifecycles',
          ) ?? false,
      };
    }
  });
}
