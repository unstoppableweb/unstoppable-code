import { join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  inertArchiveGroup,
  isAbandonedArchive,
  assertAbandonedArchivesMatch,
  abandonArchiveSuggestion,
} from '@canopy/desktop-shared/node/internal-root-migration/lifecycle-policy';
import { inspectDestructiveJournals } from '@canopy/desktop-shared/node/w5-destructive-journal';
import { statIfPresent } from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { isToleratedInternalRootW5Issue } from './internal-root-migration-w5-adoption';
import { diagnoseW5State } from './w5-maintenance-diagnosis';
import {
  describeInternalRootCommit,
  internalRootCommitAbandonments,
} from './internal-root-migration-commits';

/** Inventory only: SQLite diagnosis uses a disposable copy, never the live writer. */
export async function diagnoseInternalRootW5(
  source: string,
  abandonArchives: readonly string[] = [],
  abandonCommits: readonly number[] = [],
): Promise<readonly string[]> {
  const diagnosis = await diagnoseW5State(
    source,
    'w5-owned',
    true,
    abandonCommits,
  );
  internalRootCommitAbandonments(diagnosis, abandonCommits);
  const blockers: string[] = [];
  if (abandonCommits.length && hostOperatingSystem() === 'win32')
    blockers.push(
      '--abandon-commit is supported only on macOS/Linux; Windows offline W5 resolve is not qualified.',
    );
  if (diagnosis.schemaUpgrade && !diagnosis.logIssue)
    process.stderr.write(
      `Internal-root migration inventory: W5 log schema v${diagnosis.schemaUpgrade.from} will be upgraded to v${diagnosis.schemaUpgrade.to} during settlement.\n`,
    );
  const hasLog = await statIfPresent(join(source, 'w5/commit-log.sqlite'));
  if (hasLog && diagnosis.logIssue)
    blockers.push(`W5 log: ${diagnosis.logIssue}`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `w5/commit-log.sqlite${suffix}`;
    const stat = await statIfPresent(join(source, path));
    if (
      stat &&
      (!stat.isFile() ||
        stat.nlink !== 1 ||
        (await realpath(join(source, path))) !== join(source, path))
    )
      blockers.push(`Unsafe W5 log/sidecar: ${path}`);
  }
  for (const row of diagnosis.commits)
    if (!abandonCommits.includes(row.commitId)) {
      const detail = `W5 pending ${describeInternalRootCommit(source, row)}`;
      // The core inventory summary is bounded; retain every opt-in hint in stderr.
      process.stderr.write(`Internal-root migration inventory: ${detail}\n`);
      blockers.push(detail);
    }
  for (const row of diagnosis.reservations)
    blockers.push(
      `W5 reservation ${row.reservationId}: ${row.operation} state=${row.state}`,
    );
  for (const issue of diagnosis.files) {
    if (isToleratedInternalRootW5Issue(issue)) continue;
    if (
      !hasLog &&
      ((issue.path === 'index.json' && issue.reason === 'missing-file') ||
        (issue.path === '.' &&
          !(await statIfPresent(join(source, 'workspaces')))))
    )
      continue;
    // Eligible disk images are adopted only by --apply, under cold exclusion.
    if (
      issue.reason === 'log-mismatch' &&
      /^[A-Za-z0-9_-]+\/(workspace|worktrees)\.json$/.test(issue.path) &&
      (await statIfPresent(join(source, 'workspaces', issue.path)))?.isFile()
    )
      continue;
    blockers.push(`${issue.reason}: ${issue.path}`);
  }
  if (!hasLog && (await statIfPresent(join(source, 'w5')))) {
    const history = (await readdir(join(source, 'w5'))).filter(
      (name) =>
        name !== 'destructive-lifecycles' &&
        !diagnosis.files.some(
          (issue) =>
            issue.path === `w5/${name}` &&
            issue.artifactKind === 'unrecognized-w5-file',
        ),
    );
    if (history.length)
      blockers.push(`W5 history exists without its log: ${history.join(', ')}`);
  }
  const journals = await inspectDestructiveJournals(source);
  assertAbandonedArchivesMatch(journals.records, abandonArchives);
  for (const issue of journals.issues)
    blockers.push(`${issue.reason}: ${issue.path}`);
  for (const { record } of journals.records) {
    if (
      record.state === 'completed' ||
      isAbandonedArchive(record, abandonArchives)
    )
      continue;
    const group = await inertArchiveGroup(source, record);
    if (group) {
      process.stderr.write(
        `Internal-root migration inventory: carrying inert archive ${JSON.stringify({ workspace: record.workspaceId, worktree: record.worktreeId, group, lastDone: record.steps.filter((step) => step.state === 'done').slice(-1)[0]?.phase ?? '(none)' })}.\n`,
      );
    } else
      blockers.push(
        `${record.operation} workspace=${record.workspaceId} worktree=${record.worktreeId ?? '(workspace)'} state=${record.state}${abandonArchiveSuggestion(record)}`,
      );
  }
  return blockers
    .slice(0, 40)
    .map((value) =>
      value.startsWith('W5 pending commit ') ? value : value.slice(0, 1000),
    )
    .concat(
      blockers.length > 40
        ? [`… ${blockers.length - 40} more W5 blockers`]
        : [],
    );
}
