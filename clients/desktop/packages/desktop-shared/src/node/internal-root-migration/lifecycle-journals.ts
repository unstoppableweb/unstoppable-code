import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertRelocationOwnedPathsSafe,
  isWithin,
  movedOwnedPath,
  type RelocationTransition,
} from '@canopy/core-runtime/node/relocation';
import type { InternalRootLifecycleJournalEvidence } from '@canopy/core-runtime/node/internal-root-repairs';
import { LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN } from '@canopy/protocol/portal/lifecycle-journal';
import {
  journalSchema,
  inspectDestructiveJournals,
  type DestructiveRecoveryRecord,
} from '../w5-destructive-journal';
import {
  inertArchiveGroup,
  isInertArchiveCandidate,
  isAbandonedArchive,
  assertAbandonedArchivesMatch,
} from './lifecycle-policy';
import { durableJson, statIfPresent } from './filesystem';
import { internalRootMigrationProgress } from './progress';
import type { InternalRootFilesystemHost } from './filesystem-host';

async function carriedJournals(
  source: string,
  abandonArchives: readonly string[] = [],
): ReturnType<typeof inspectDestructiveJournals> {
  const inspection = await inspectDestructiveJournals(source);
  assertAbandonedArchivesMatch(inspection.records, abandonArchives);
  if (
    inspection.issues.length ||
    (
      await Promise.all(
        inspection.records.map(
          async ({ record }) =>
            record.state === 'completed' ||
            isAbandonedArchive(record, abandonArchives) ||
            (await inertArchiveGroup(source, record)) !== null,
        ),
      )
    ).some((accepted) => !accepted)
  )
    throw new Error('Unsettled lifecycle journal evidence');
  return inspection;
}

function workspacePath(
  source: string,
  record: DestructiveRecoveryRecord,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(record.workspaceId))
    throw new Error('Noncanonical lifecycle workspace identity');
  return join(source, 'workspaces', record.workspaceId);
}

function evidenceRecord(
  evidence: InternalRootLifecycleJournalEvidence,
): DestructiveRecoveryRecord {
  const record = journalSchema.parse(JSON.parse(evidence.raw));
  if (
    !LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(evidence.name) ||
    (evidence.abandoned
      ? !isAbandonedArchive(record, [
          `${evidence.abandoned.workspaceId}/${evidence.abandoned.worktreeId}`,
        ])
      : record.state !== 'completed' && !isInertArchiveCandidate(record)) ||
    record.ownedPaths.length !== evidence.ownedIdentities.length
  )
    throw new Error('Invalid frozen lifecycle evidence');
  return record;
}

/** Exact journal owner fields join CAN-5785's existing path safety qualification. */
export function internalRootJournalOwnedPaths(
  source: string,
  evidence: readonly InternalRootLifecycleJournalEvidence[],
): readonly string[] {
  return evidence
    .filter((entry) => !entry.abandoned)
    .flatMap((entry) => {
      const record = evidenceRecord(entry);
      return [
        workspacePath(source, record),
        ...record.ownedPaths.map(({ path }) => path),
      ];
    });
}

export async function freezeInternalRootJournals(
  source: string,
  abandonArchives: readonly string[] = [],
): Promise<readonly InternalRootLifecycleJournalEvidence[]> {
  const { records } = await carriedJournals(source, abandonArchives);
  return Promise.all(
    records.map(async ({ name, record }) => {
      const directory = workspacePath(source, record);
      const stat = await directoryStatIdentity(directory);
      const marker =
        stat === null
          ? null
          : await readFile(join(directory, '.w5-incarnation'), 'utf8').catch(
              () => null,
            );
      return {
        name,
        ...(isAbandonedArchive(record, abandonArchives) && record.worktreeId
          ? {
              abandoned: {
                workspaceId: record.workspaceId,
                worktreeId: record.worktreeId,
              },
            }
          : {}),
        raw: JSON.stringify(record),
        workspaceIdentity:
          stat === null ? null : `${stat}${marker ? `:${marker}` : ''}`,
        ownedIdentities: await Promise.all(
          record.ownedPaths.map(({ path }) => directoryStatIdentity(path)),
        ),
      };
    }),
  );
}

async function directoryStatIdentity(path: string): Promise<string | null> {
  const stat = await statIfPresent(path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('Aliased lifecycle owner directory');
  if (!stat.isDirectory()) return null;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

async function projectJournal(
  transition: RelocationTransition,
  workingRoot: string,
  evidence: InternalRootLifecycleJournalEvidence,
): Promise<DestructiveRecoveryRecord> {
  const record = evidenceRecord(evidence);
  const source = transition.from.canonicalDataRoot;
  const physical = (path: string): string =>
    isWithin(transition.to.canonicalDataRoot, path)
      ? join(workingRoot, relative(transition.to.canonicalDataRoot, path))
      : path;
  const projectIdentity = async (
    path: string,
    identity: string | null,
    actual: string | null,
  ): Promise<string | null> => {
    const moved = movedOwnedPath(transition, path);
    if (moved === path || identity === null) return identity;
    // A replaced/absent/unverifiable identity must never acquire new deletion rights.
    if (actual !== identity)
      return identity.startsWith('unverifiable:')
        ? identity
        : `unverifiable:${identity}`;
    const copied = await directoryStatIdentity(physical(moved));
    if (!copied) throw new Error('Missing copied lifecycle owner directory');
    return copied;
  };
  const directory = workspacePath(source, record);
  let directoryIdentity = record.directoryIdentity;
  if (directoryIdentity !== null) {
    const parts = directoryIdentity.split(':');
    const statIdentity = parts.slice(0, 3).join(':');
    const marker = parts.slice(3).join(':');
    const actual = evidence.workspaceIdentity;
    const matches = marker
      ? actual === directoryIdentity
      : actual?.split(':').slice(0, 3).join(':') === statIdentity;
    if (matches) {
      const copied = await directoryStatIdentity(
        physical(movedOwnedPath(transition, directory)),
      );
      if (!copied) throw new Error('Missing copied lifecycle workspace');
      if (
        marker &&
        (await readFile(
          join(
            physical(movedOwnedPath(transition, directory)),
            '.w5-incarnation',
          ),
          'utf8',
        )) !== marker
      )
        throw new Error('Changed copied lifecycle incarnation');
      directoryIdentity = `${copied}${marker ? `:${marker}` : ''}`;
    } else directoryIdentity = `unverifiable:${directoryIdentity}`;
  }
  return {
    ...record,
    directoryIdentity,
    ownedPaths: await Promise.all(
      record.ownedPaths.map(async (owned, index) => ({
        path: movedOwnedPath(transition, owned.path),
        identity: await projectIdentity(
          owned.path,
          owned.identity,
          evidence.ownedIdentities[index] ?? null,
        ),
      })),
    ),
  };
}

/** Writes only copied journals; the settled source remains the immutable restore image. */
export async function relocateInternalRootJournals(
  transition: RelocationTransition,
  workingRoot: string,
  host: InternalRootFilesystemHost,
  evidence: readonly InternalRootLifecycleJournalEvidence[],
  verify = false,
  published = false,
): Promise<void> {
  const source = transition.from.canonicalDataRoot;
  if (workingRoot === source)
    throw new Error('Cannot repair source lifecycle journals');
  const original = evidence;
  const copied = await inspectDestructiveJournals(workingRoot);
  if (copied.issues.length)
    throw new Error('Unreadable copied lifecycle journals');
  if (
    !isDeepStrictEqual(
      original.filter((entry) => !entry.abandoned).map(({ name }) => name),
      copied.records.map(({ name }) => name),
    )
  )
    throw new Error('Lifecycle journal membership changed');
  await assertRelocationOwnedPathsSafe(
    transition,
    internalRootJournalOwnedPaths(source, evidence),
    workingRoot,
    published,
    undefined,
    internalRootMigrationProgress,
  );
  for (const entry of original) {
    const { name } = entry;
    const record = evidenceRecord(entry);
    if (entry.abandoned) continue;
    const projected = await projectJournal(transition, workingRoot, entry);
    const current = copied.records.find((entry) => entry.name === name)?.record;
    if (verify) {
      if (!isDeepStrictEqual(current, projected))
        throw new Error('Lifecycle journal projection differs');
    } else {
      if (!isDeepStrictEqual(current, record))
        throw new Error('Lifecycle journal differs from source evidence');
      await durableJson(
        join(workingRoot, 'w5/destructive-lifecycles', name),
        projected,
        host,
      );
    }
  }
}
