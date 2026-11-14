import { join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import {
  inertArchiveGroup,
  isAbandonedArchive,
  assertAbandonedArchivesMatch,
  abandonArchiveSuggestion,
} from '@canopy/desktop-shared/node/internal-root-migration/lifecycle-policy';
import { inspectDestructiveJournals } from '@canopy/desktop-shared/node/w5-destructive-journal';
import {
  InternalRootMigrationRefused,
  type InternalRootColdRecovery,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  statIfPresent,
  privateDirectory,
  flush,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  internalRootFilesystemHost,
  createPrivateMigrationDirectory,
  observeMigrationNode,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import { createW5RecoveryMaintenanceContext } from './w5-recovery-maintenance';
import { runW5Maintenance, W5MaintenanceRefusedError } from './w5-maintenance';
import {
  adoptInternalRootW5Metadata,
  isToleratedInternalRootW5Issue,
} from './internal-root-migration-w5-adoption';
import {
  diagnoseW5State,
  type W5Diagnosis,
  type W5FileIssue,
} from './w5-maintenance-diagnosis';
import {
  describeInternalRootCommit,
  internalRootCommitAbandonments,
  retainInternalRootCommits,
} from './internal-root-migration-commits';
import {
  runW5MaintenanceDecisions,
  refuseW5MaintenanceDecisions,
} from './w5-maintenance-decisions';

function warnUnindexedWorkspaceFolders(diagnosis: W5Diagnosis): void {
  for (const issue of diagnosis.files)
    if (issue.artifactKind === 'unindexed-workspace-directory')
      process.stderr.write(
        `Internal-root migration warning: copying unindexed workspace folder ${JSON.stringify(`workspaces/${issue.path}`)} unchanged.\n`,
      );
}

function diagnosticField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const value: unknown = Reflect.get(error, field);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function recoveryDiagnostic(error: unknown): string {
  // Node/Jest errors can cross realms; read validated fields, not instanceof Error.
  const message =
    typeof error === 'string' ? error : diagnosticField(error, 'message');
  const limit = 1024;
  const text = message
    ?.slice(0, limit)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fields: string[] = [];
  for (const key of ['code', 'stage']) {
    const value = diagnosticField(error, key);
    if (value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value))
      fields.push(`${key} ${value}`);
  }
  return `${text || 'Unknown failure'}${message && message.length > limit ? '…' : ''}${fields.length ? ` (${fields.join(', ')})` : ''}`;
}

function boundedDiagnostics(items: readonly string[]): string {
  const limit = 20;
  return (
    items
      .slice(0, limit)
      .map((item) => recoveryDiagnostic(item))
      .join('; ') +
      (items.length > limit ? `; … ${items.length - limit} more` : '') || 'none'
  );
}

function blockingFileIssues(issues: readonly W5FileIssue[]): W5FileIssue[] {
  return issues
    .filter((issue) => !isToleratedInternalRootW5Issue(issue))
    .filter(
      (issue, index, all) =>
        all.findIndex(
          (other) => other.path === issue.path && other.reason === issue.reason,
        ) === index,
    );
}

/**
 * Transaction-qualified pre-Cut-B source recovery (no UI/flip gate or destination startup).
 * Preconditions: migration coordination and targeted cold proof are held by the
 * worker-issued qualification; source is the canonical private original root;
 * workerEntry is dist/core-daemon/w5-commit-log-worker.js built by
 * pnpm run dev:core-daemon, or its matching packaged equivalent.
 * Qualification is rechecked before/after recovery and at W5 worker admission,
 * and revoked before migration coordination releases;
 * W5 retains startup/lifetime/endpoint, cohort and recovery-writer exclusion.
 * Outcomes: settled, or nothing-to-settle for a root with no owned W5 history.
 * Refusals: recovery-required for lost qualification, aliased W5/workspaces,
 * history without a log, aliased/nonregular/foreign/linked log or SQLite sidecars,
 * missing worker, W5 exclusion/recovery failures, remaining
 * commits/reservations, owned-state file issues, unfinished/unreadable lifecycle journals or log issues.
 * unsupported-layout refuses nonprivate source permissions; investigate ownership
 * rather than blindly repairing permissions.
 * Recovery: preserve the ORIGINAL root and journal; use teammate-assisted offline
 * W5 diagnosis there, then retry migration while cold. Never rerun uncertain effects.
 */
export async function settleInternalRootW5(
  source: string,
  workerEntry: string,
  qualification: InternalRootColdRecovery,
  options: {
    readonly abandonArchives?: readonly string[];
    readonly abandonCommits?: readonly number[];
    readonly ownedChildPath?: string;
    readonly windowsProcessPath?: string;
  } = {},
): Promise<'settled' | 'nothing-to-settle'> {
  const abandonArchives = options.abandonArchives ?? [];
  const abandonCommits = [...(options.abandonCommits ?? [])];
  if (abandonCommits.length && hostOperatingSystem() === 'win32')
    throw new InternalRootMigrationRefused(
      'recovery-required',
      '--abandon-commit is supported only on macOS/Linux; Windows offline W5 resolve is not qualified.',
    );
  await qualification.assertHeld();
  assertAbandonedArchivesMatch(
    (await inspectDestructiveJournals(source)).records,
    abandonArchives,
  );
  const windows = hostOperatingSystem() === 'win32';
  if (
    windows &&
    (!qualification.assertCold ||
      !options.windowsProcessPath ||
      !options.ownedChildPath)
  )
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Windows offline migration requires native cold qualification and trusted custody/process helpers.',
    );
  const host = internalRootFilesystemHost(options.ownedChildPath);
  if (
    qualification.identity.source !== source ||
    (await realpath(source)) !== source
  )
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Source is not the qualified canonical original root. Preserve both roots and request offline diagnosis.',
    );
  await privateDirectory(source, host);
  const w5 = join(source, 'w5');
  for (const path of [w5, join(source, 'workspaces')]) {
    const stat = await statIfPresent(path);
    if (stat && (!stat.isDirectory() || (await realpath(path)) !== path))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 state requires offline diagnosis at the original root.',
      );
    if (windows && stat) await privateDirectory(path, host);
  }
  const logPath = join(w5, 'commit-log.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${logPath}${suffix}`;
    const stat = await statIfPresent(path);
    if (
      stat &&
      (!stat.isFile() ||
        stat.nlink !== 1 ||
        (!windows && stat.uid !== process.getuid?.()) ||
        (await realpath(path)) !== path)
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 log/SQLite sidecar. Preserve the original root and obtain offline W5 diagnosis before retrying.',
      );
    if (stat) await observeMigrationNode(path, stat, host);
  }
  if (!(await statIfPresent(logPath))) {
    const diagnosis = await diagnoseW5State(source, 'w5-owned');
    internalRootCommitAbandonments(diagnosis, abandonCommits);
    warnUnindexedWorkspaceFolders(diagnosis);
    const workspaceRootPresent = await statIfPresent(
      join(source, 'workspaces'),
    );
    const journals = await inspectDestructiveJournals(source);
    const unfinished: string[] = [];
    for (const { record } of journals.records) {
      if (
        record.state === 'completed' ||
        isAbandonedArchive(record, abandonArchives)
      )
        continue;
      const group = await inertArchiveGroup(source, record);
      if (!group)
        unfinished.push(
          `${record.operation} workspace=${recoveryDiagnostic(record.workspaceId.slice(0, 160))} worktree=${recoveryDiagnostic((record.worktreeId ?? '(workspace)').slice(0, 160))} state=${record.state}${abandonArchiveSuggestion(record)}`,
        );
      else
        process.stderr.write(
          `Internal-root migration: carrying inert archive ${JSON.stringify({ workspace: record.workspaceId, worktree: record.worktreeId, group, lastDone: record.steps.filter((step) => step.state === 'done').slice(-1)[0]?.phase ?? '(none)' })} unchanged except destination owner projection.\n`,
        );
    }
    // A never-indexed root is valid; absent W5 infrastructure needs no worker.
    const fileIssues = blockingFileIssues([
      ...diagnosis.files,
      ...journals.issues,
    ]).filter(
      (issue) =>
        !(issue.path === 'index.json' && issue.reason === 'missing-file') &&
        !(issue.path === '.' && !workspaceRootPresent),
    );
    if (fileIssues.length || unfinished.length)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        `W5 remains unresolved: file issues ${fileIssues.length} [${boundedDiagnostics(fileIssues.map((issue) => `${issue.reason}: ${issue.path}`))}], lifecycle journals ${unfinished.length} [${boundedDiagnostics(unfinished)}]. Use offline W5 recovery at the ORIGINAL root.`,
      );
    const history = (await statIfPresent(w5))
      ? (await readdir(w5)).filter(
          (name) =>
            name !== 'destructive-lifecycles' &&
            !diagnosis.files.some(
              (issue) =>
                issue.path === `w5/${name}` &&
                issue.artifactKind === 'unrecognized-w5-file',
            ),
        )
      : [];
    if (history.length)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        `W5 history exists without its log [${boundedDiagnostics(history.map((name) => `w5/${name}`))}]. Retain the original root and use W5 offline diagnosis.`,
      );
    await qualification.assertHeld();
    return 'nothing-to-settle'; // No worker or W5 infrastructure for opaque files alone.
  }
  try {
    // Pre-Cut-A roots may contain W5 history but no daemon runtime yet. This is
    // W5 settlement infrastructure, created only under B's cold qualification.
    await qualification.assertHeld();
    const runtime = join(source, 'runtime');
    if (!(await statIfPresent(runtime))) {
      await createPrivateMigrationDirectory(runtime, host);
    }
    await privateDirectory(runtime, host);
    await flush(runtime);
    await flush(source);
    const worker = await statIfPresent(workerEntry);
    if (!worker?.isFile() || (await realpath(workerEntry)) !== workerEntry)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Compiled W5 worker unavailable. Build it with pnpm run dev:core-daemon before retrying at the original root.',
      );
    await qualification.assertHeld();
    const context = createW5RecoveryMaintenanceContext(source, {
      workerEntry,
      admission: qualification.assertHeld,
      windowsProcessPath: options.windowsProcessPath,
      confinementAddon: options.ownedChildPath,
      ...(qualification.assertCold
        ? {
            offlineMigration: async (): Promise<void> => {
              await qualification.assertHeld();
              if (!qualification.assertCold)
                throw new Error('Missing native cold qualification');
              await qualification.assertCold();
            },
          }
        : {}),
    });
    const result = await runW5Maintenance(
      {
        ...context,
        diagnosisScope: 'w5-owned',
        internalRootSettlement: {
          source: qualification.identity.source,
          transactionId: qualification.transactionId,
          assertHeld: qualification.assertHeld,
          abandonCommits,
        },
        adoptInternalRootMetadata: async (
          diagnosis,
          assertHeld,
        ): Promise<void> => {
          await qualification.assertHeld();
          const decisions = internalRootCommitAbandonments(
            diagnosis,
            abandonCommits,
          );
          if (decisions.length) {
            const refusal = refuseW5MaintenanceDecisions(diagnosis, decisions);
            if (refusal)
              throw new Error(
                `W5 commit abandonment refused (${refusal.reason})`,
              );
            await retainInternalRootCommits(
              qualification,
              host,
              abandonCommits,
              assertHeld,
            );
            const { failure } = await runW5MaintenanceDecisions(
              context.host,
              decisions,
              async () => {
                await qualification.assertHeld();
                await assertHeld();
              },
            );
            if (failure) throw failure.error;
            diagnosis = await diagnoseW5State(source, 'w5-owned');
          }
          await adoptInternalRootW5Metadata(
            context.host,
            diagnosis,
            async () => {
              await qualification.assertHeld();
              await assertHeld();
            },
          );
        },
      },
      { source: 'offline_maintenance', mode: 'reopen' },
    );
    if (result.mode !== 'reopen') throw new Error('Unexpected recovery result');
    const diagnosis = result.diagnosis;
    // Opaque artifacts are copied, never adopted as W5-owned state.
    warnUnindexedWorkspaceFolders(diagnosis);
    const journals = await inspectDestructiveJournals(source);
    const unfinished: Array<(typeof journals.records)[number]> = [];
    for (const entry of journals.records) {
      if (
        entry.record.state === 'completed' ||
        isAbandonedArchive(entry.record, abandonArchives)
      )
        continue;
      const group = await inertArchiveGroup(source, entry.record);
      if (!group) unfinished.push(entry);
      else {
        const lastDone =
          entry.record.steps
            .filter((step) => step.state === 'done')
            .slice(-1)[0]?.phase ?? '(none)';
        process.stderr.write(
          `Internal-root migration: carrying inert archive ${JSON.stringify({ workspace: entry.record.workspaceId, worktree: entry.record.worktreeId, group, lastDone })} unchanged except destination owner projection.\n`,
        );
      }
    }
    const fileIssues = blockingFileIssues([
      ...diagnosis.files,
      ...journals.issues,
    ]);
    const field = (value: string): string =>
      `${recoveryDiagnostic(value.slice(0, 160))}${value.length > 160 ? '…' : ''}`;
    if (
      diagnosis.logIssue ||
      diagnosis.commits.length ||
      diagnosis.reservations.length ||
      fileIssues.length ||
      unfinished.length
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        `W5 remains unresolved: commits ${diagnosis.commits.map((row) => describeInternalRootCommit(source, row)).join('; ') || 'none'}, reservations ${diagnosis.reservations.length}, file issues ${fileIssues.length} [${boundedDiagnostics(fileIssues.map((issue) => `${issue.reason}: ${issue.path}`))}], lifecycle journals ${unfinished.length} [${boundedDiagnostics(unfinished.map(({ record }) => `${record.operation} workspace=${field(record.workspaceId)} worktree=${field(record.worktreeId ?? '(workspace)')} state=${record.state}${abandonArchiveSuggestion(record)}`))}], log ${diagnosis.logIssue ?? 'readable'}. Use offline W5 recovery at the ORIGINAL root; never replay uncertain effects.`,
      );
    await qualification.assertHeld();
    return 'settled';
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    // Offline diagnosis needs the actual failure; exclusion still refuses closed.
    const detail =
      error instanceof W5MaintenanceRefusedError
        ? `W5 source maintenance refused (${error.reason})${error.operationError === undefined ? '' : `: ${recoveryDiagnostic(error.operationError)}`}`
        : `W5 source recovery failed or exclusion was unavailable: ${recoveryDiagnostic(error)}`;
    throw Object.assign(
      new InternalRootMigrationRefused(
        'recovery-required',
        `${detail}. Preserve the original root and run W5 offline diagnosis there.`,
      ),
      { cause: error },
    );
  }
}
