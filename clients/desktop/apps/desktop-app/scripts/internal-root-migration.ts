/** Offline operator entry; ordinary startup only prints this command, never runs it. */
import { homedir } from 'node:os';
import {
  repairCompletedInternalRootFileTabs,
  withInternalRootFileTabRepairs,
} from '../src/main/lib/internal-root-file-tabs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostOperatingSystem } from '../../../packages/core-platform/src/host-platform';
import { windowsPrincipalObserver } from '../../../packages/core-platform/src';
import { internalRootFilesystemHost } from '../../../packages/desktop-shared/src/node/internal-root-migration/filesystem-host';
import { readInternalRootAbandonmentPlan } from '../../../packages/desktop-shared/src/node/internal-root-migration/filesystem';
import { repairCompletedInternalRootPipelineRecords } from '../../../packages/desktop-shared/src/node/internal-root-migration/pipeline-records';
import { createFreshInternalRoot } from '../../../packages/desktop-shared/src/node/internal-root-migration/fresh-start';
import { canonicalStoragePath } from '../../../packages/core-platform/src/build-storage-startup';
import {
  parseInternalRootMigrationOptions,
  selectInternalRootArchiveAbandonments,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/operator-options';
import canopy from '../../../brands/canopy/brand.json';
import unstoppableCode from '../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootMigrationWorker,
} from '../../../packages/core-runtime/src/node/internal-root-migration';
import {
  createInternalRootMigrationWorker,
  internalRootIdentity,
} from '../../../packages/desktop-shared/src/node/internal-root-migration';

import {
  createInternalRootRelocationRepairs,
  reportInternalRootCleanup,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/repairs';
import {
  formatInternalRootCleanupReport,
  type InternalRootCleanupReport,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/cleanup-candidates';
import { assertAbandonedArchivesMatch } from '../../../packages/desktop-shared/src/node/internal-root-migration/lifecycle-policy';
import { inspectDestructiveJournals } from '../../../packages/desktop-shared/src/node/w5-destructive-journal';
import { desktopW5Durability } from '../../../packages/desktop-shared/src/node/w5-commit-log/durability';
import {
  monitorInternalRootMigrationWorker,
  runInternalRootMigrationPhase,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/progress';

import {
  copyCompletedInternalRootClaudeTranscripts,
  type ClaudeTranscriptCopyReport,
} from './internal-root-claude-transcripts';

async function copyClaudeTranscripts(
  worker: InternalRootMigrationWorker,
  identity: InternalRootIdentity,
  configDirs: readonly string[],
): Promise<{
  claudeTranscripts: ClaudeTranscriptCopyReport | null;
  claudeTranscriptCopyError?: string;
}> {
  try {
    const claudeTranscripts = await runInternalRootMigrationPhase(
      'Copying Claude transcripts',
      () =>
        copyCompletedInternalRootClaudeTranscripts(
          worker,
          identity,
          configDirs,
        ),
    );
    process.stderr.write(
      `Claude transcripts: ${claudeTranscripts.copied} copied, ${claudeTranscripts.skippedExisting} existing, ${claudeTranscripts.skippedMissingDestination} missing destination, ${claudeTranscripts.errors.length} errors.\n`,
    );
    if (claudeTranscripts.errors.length) process.exitCode = 1;
    return { claudeTranscripts };
  } catch (error) {
    const claudeTranscriptCopyError = `Migration remains complete; Claude transcript copying failed: ${error instanceof Error ? error.message : 'Unknown copy failure'}. Retain both roots and rerun --copy-claude-transcripts after resolving the error.`;
    process.stderr.write(`${claudeTranscriptCopyError}\n`);
    process.exitCode = 1;
    return { claudeTranscripts: null, claudeTranscriptCopyError };
  }
}

function phase<Args extends unknown[], Result>(
  name: string,
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args: Args): Promise<Result> =>
    runInternalRootMigrationPhase(name, () => operation(...args));
}

async function main(): Promise<void> {
  const options = parseInternalRootMigrationOptions(process.argv.slice(2));
  let abandonArchives = options.abandonArchives;
  const brand = options.brandId === 'canopy' ? canopy : unstoppableCode;
  // Only explicit source selection; ordinary startup never guesses a predecessor.
  const identity = internalRootIdentity(
    canonicalStoragePath(homedir()),
    brand,
    options.sourceDirectory,
  );
  const os = hostOperatingSystem();
  const ownedChildPath =
    os === 'win32' || os === 'linux'
      ? resolve(
          '.cache/native-owned-child',
          `${os}-${process.arch}`,
          'core-owned-child.node',
        )
      : undefined;
  const windowsProcessPath = resolve(
    '.cache/bin/win32-x64/canopy-process-identity.exe',
  );
  const windowsPrincipal =
    os === 'win32' ? windowsPrincipalObserver(windowsProcessPath) : undefined;
  const filesystemHost = internalRootFilesystemHost(ownedChildPath);
  const baseWorker = createInternalRootMigrationWorker({
    filesystemHost,
    ownedChildPath,
    ...(os === 'win32' || os === 'linux'
      ? {
          nativeColdHost: { kind: 'repository', root: resolve('.') } as const,
        }
      : {}),
    executableBrands: [canopy, unstoppableCode],
    diagnose: async (source): Promise<readonly string[]> => {
      const { diagnoseInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-inventory');
      return diagnoseInternalRootW5(
        source,
        abandonArchives,
        options.abandonCommits,
      );
    },
    recoverW5: async (source, qualification): Promise<void> => {
      const { settleInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-maintenance');
      await settleInternalRootW5(
        source,
        resolve('dist/core-daemon/w5-commit-log-worker.js'),
        qualification,
        {
          ownedChildPath,
          windowsProcessPath,
          abandonArchives,
          abandonCommits: options.abandonCommits,
        },
      );
    },
  });
  if (options.repairPipelineRecords) {
    const result = await runInternalRootMigrationPhase(
      'Repairing pipeline execution records',
      () =>
        repairCompletedInternalRootPipelineRecords({
          identity,
          worker: baseWorker,
          host: filesystemHost,
        }),
    );
    process.stdout.write(
      `${JSON.stringify({ kind: 'pipeline-records-repaired', ...result })}\n`,
    );
    return;
  }
  if (options.skipMigration) {
    await createFreshInternalRoot({
      identity,
      worker: baseWorker,
      ownedChildPath,
      windowsPrincipal,
    });
    process.stdout.write(
      `${JSON.stringify({ kind: 'fresh-internal', destination: identity.destination })}\n`,
    );
    return;
  }
  const worker = monitorInternalRootMigrationWorker(baseWorker);
  if (options.repairFileTabs) {
    const result = await runInternalRootMigrationPhase(
      'Repairing file-tab paths',
      () =>
        repairCompletedInternalRootFileTabs({
          identity,
          worker,
          host: filesystemHost,
        }),
    );
    process.stdout.write(
      `${JSON.stringify({ kind: 'file-tabs-repaired', ...result })}\n`,
    );
    return;
  }
  const disposition = join(
    identity.destination,
    '..',
    `.${identity.brandId}-internal-startup.json`,
  );
  try {
    await runInternalRootMigrationPhase(
      'Checking startup choice',
      () => lstat(disposition),
      { announce: false },
    );
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'An explicit fresh-start choice exists. Retain it and the internal folder; do not migrate over this installation.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const prior = await worker.readJournal(identity);
  if (options.copyClaudeTranscripts) {
    if (prior?.phase !== 'complete')
      throw new Error(
        'Transcript recovery requires a completed migration journal for this brand and source. Retain both roots.',
      );
    const transcriptResult = await copyClaudeTranscripts(
      worker,
      identity,
      options.claudeConfigDirs,
    );
    process.stdout.write(
      `${JSON.stringify({ kind: 'complete', journal: prior, ...transcriptResult }, null, 2)}\n`,
    );
    return;
  }

  const abandonmentPlan = await readInternalRootAbandonmentPlan(
    identity,
    prior,
    filesystemHost,
  );
  const frozenAbandonments = [
    ...new Set(
      abandonmentPlan?.lifecycleJournals?.flatMap((entry) =>
        entry.abandoned
          ? [`${entry.abandoned.workspaceId}/${entry.abandoned.worktreeId}`]
          : [],
      ) ?? [],
    ),
  ];
  abandonArchives = selectInternalRootArchiveAbandonments(
    options.abandonArchives,
    abandonmentPlan ? frozenAbandonments : undefined,
  );
  if (options.abandonArchives.length)
    assertAbandonedArchivesMatch(
      (
        await runInternalRootMigrationPhase(
          'Checking archive selections',
          () => inspectDestructiveJournals(identity.source),
          { announce: false },
        )
      ).records,
      options.abandonArchives,
    );
  // Commit opt-ins consume pending rows before construction; never freeze/replay them.
  if (options.abandonCommits.length) {
    const { diagnoseW5State } =
      await import('../src/main/lib/w5-maintenance-diagnosis');
    const { internalRootCommitAbandonments } =
      await import('../src/main/lib/internal-root-migration-commits');
    internalRootCommitAbandonments(
      await diagnoseW5State(identity.source, 'w5-owned', true),
      options.abandonCommits,
    );
  }
  const abandonCheckouts = selectInternalRootArchiveAbandonments(
    options.abandonCheckouts,
    abandonmentPlan ? (abandonmentPlan.abandonedCheckouts ?? []) : undefined,
    'Checkout',
  );
  const repairs = withInternalRootFileTabRepairs(
    createInternalRootRelocationRepairs({
      abandonCheckouts,
      abandonArchives,
      durability: desktopW5Durability,
      windowsPrincipal,
      ownedChildPath,
      filesystemHost,
    }),
    filesystemHost,
  );
  const result = await migrateInternalRoot(
    worker,
    identity,
    {
      apply: options.apply,
      declareInternal: options.declareInternal,
      rebuild: options.rebuild,
      restart: options.restart,
    },
    {
      ...repairs,
      prepare: phase('Git checks', repairs.prepare),
      repair: phase('Repairing destination', repairs.repair),
      verify: phase('Verifying destination', repairs.verify),
      qualifyPublished: phase(
        'publishing: Git qualification',
        repairs.qualifyPublished,
      ),
      ...(repairs.inspect
        ? { inspect: phase('Git checks', repairs.inspect) }
        : {}),
    },
  );
  const transcriptResult =
    options.apply && result.kind === 'complete'
      ? await copyClaudeTranscripts(worker, identity, options.claudeConfigDirs)
      : {};
  let cleanupCandidates: InternalRootCleanupReport | null = null;
  let cleanupReportError: string | undefined;
  try {
    cleanupCandidates = await runInternalRootMigrationPhase(
      'Cleanup report',
      () =>
        reportInternalRootCleanup(
          identity,
          result.kind === 'complete' || result.journal?.phase === 'complete',
          filesystemHost,
          result.kind === 'inventory'
            ? result.inventory.bytes
            : result.journal.inventory.bytes,
          abandonArchives,
          abandonCheckouts,
        ),
    );
    process.stderr.write(formatInternalRootCleanupReport(cleanupCandidates));
  } catch (error: unknown) {
    // Reporting failure cannot turn a durably completed migration into a refusal.
    cleanupReportError = `Migration returned ${result.kind}, but cleanup reporting failed: ${error instanceof Error ? error.message : 'Unknown report failure'}. Retain both roots and the journal; reporting did not roll back migration. Resolve the report issue and run --inventory, not --rebuild, to refresh the report. Removal is your choice; no cleanup candidates were changed.`;
    process.stderr.write(`Cleanup candidates\n${cleanupReportError}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({ ...result, ...transcriptResult, cleanupCandidates, ...(cleanupReportError ? { cleanupReportError } : {}) }, null, 2)}\n`,
  );
}

void main().catch((error: unknown): void => {
  const result =
    error instanceof InternalRootMigrationRefused
      ? { kind: 'refused', reason: error.reason, recovery: error.recovery }
      : {
          kind: 'refused',
          reason: 'invalid-request-or-runtime',
          recovery:
            error instanceof Error
              ? error.message
              : 'Unknown failure; retain both roots and the journal.',
        };
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
});
