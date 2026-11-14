import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN } from '@canopy/protocol/portal/lifecycle-journal';
import { z } from 'zod';

export const archiveTriggerSchema = z.enum([
  'manual',
  'auto-delete',
  'agent',
  'project-deletion',
  'restore',
  'split',
  'import',
  'internal-rollback',
]);
export type ArchiveTrigger = z.infer<typeof archiveTriggerSchema>;
const operationSchema = z.enum([
  'workspace-delete',
  'worktree-archive',
  'worktree-delete',
]);
export const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  operation: operationSchema,
  trigger: archiveTriggerSchema.optional(),
  /** Set on a child of {@link runStepFreeChildLifecycles}, which may resume it. */
  parentOperation: operationSchema.optional(),
  /** A resumed pre-capture archive's successor retains this binding after replacing its slot. */
  supersedesArchives: z.array(z.string().uuid()).optional(),
  workspaceId: z.string(),
  worktreeId: z.string().optional(),
  createdAt: z.string().optional(),
  directoryIdentity: z.string().nullable(),
  state: z.enum(['active', 'recovery-required', 'completed']),
  steps: z.array(
    z.object({
      phase: z.string(),
      state: z.enum(['pending', 'done', 'failed']),
      /** Privacy-safe failure classification; raw step errors stay local. */
      code: z.string().optional(),
      error: z.string().optional(),
      /** Taken by {@link resumableDestructiveStep} while it was step-free. */
      resumable: z.literal(true).optional(),
    }),
  ),
  outcome: z.unknown().optional(),
  cleanupRequired: z.boolean().optional(),
  archiveRecoveryCleanup: z
    .array(
      z.object({
        operationId: z.string().uuid(),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        done: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Retains bounded-repair scope across a caught failure; never generic archive replay. */
  cleanupRepair: z.object({ kind: z.literal('completed-cleanup') }).optional(),
  ownedPaths: z
    .array(z.object({ path: z.string(), identity: z.string().nullable() }))
    .default([]),
});
export type DestructiveRecoveryRecord = z.infer<typeof journalSchema>;

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

export function isArchiveCleanupPhase(phase: string): boolean {
  return (
    phase.startsWith('sidecar:') ||
    [
      'live-state-teardown',
      'turn-diff-cleanup',
      'browser-retirement',
      'sidecar-cleanup',
      'compatibility-symlinks',
      'canonical-row-removal',
      'deferred-browser-retirement',
      'watcher-commit',
      'temporary-workspace-cleanup',
    ].includes(phase)
  );
}
