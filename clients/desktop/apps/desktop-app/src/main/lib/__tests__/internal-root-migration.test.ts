import * as migrationProgress from '@canopy/desktop-shared/node/internal-root-migration/progress';
import { inertArchiveGroup } from '@canopy/desktop-shared/node/internal-root-migration/lifecycle-policy';
import {
  freezeInternalRootJournals,
  relocateInternalRootJournals,
} from '@canopy/desktop-shared/node/internal-root-migration/lifecycle-journals';
import {
  journalSchema,
  readDestructiveJournal,
  type DestructiveRecoveryRecord,
} from '@canopy/desktop-shared/node/w5-destructive-journal';
import { createFreshInternalRoot } from '@canopy/desktop-shared/node/internal-root-migration/fresh-start';
import {
  parseInternalRootMigrationOptions,
  selectInternalRootArchiveAbandonments,
} from '@canopy/desktop-shared/node/internal-root-migration/operator-options';
import { scanInterruptedWork } from '../interrupted-work-scan-worker';
import { defineComposedMigrationCases } from './fixtures/composed-internal-root-migration';
import {
  chmod,
  cp,
  lstat,
  lutimes,
  link,
  utimes,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as authorityHost from '@canopy/core-platform';
import * as hostPlatform from '@canopy/core-platform/host-platform';
import * as storageObservation from '@canopy/core-platform/storage-path-observation';
import { createServer } from 'node:net';
import {
  listW5HostPeers,
  inspectW5MaintenanceOwner,
} from '@canopy/execution-engine/node/w5-host-cohort';
import {
  encodeMemberRecord,
  encodeMaintenanceRecord,
} from '@canopy/execution-engine/node/w5-host-cohort/records';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { DatabaseSync } from 'node:sqlite';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppableCode from '../../../../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootRepairs,
  type InternalRootMigrationWorker,
  type InternalRootIdentity,
  type InternalRootColdRecovery,
  type InternalRootRepairContext,
} from '@canopy/core-runtime/node/internal-root-migration';
import { validateInternalRootJournal } from '@canopy/core-runtime/node/internal-root-journal';
import {
  createInternalRootMigrationWorker,
  internalRootIdentity,
  readInternalRootJournal,
} from '@canopy/desktop-shared/node/internal-root-migration';
import {
  assertInternalRootColdProcesses,
  assertInternalRootColdOpenFiles,
  assertInternalRootDaemonStopped,
} from '@canopy/desktop-shared/node/internal-root-migration';
import {
  W5CommitLog,
  applyW5Commit,
  type W5CommitRequest,
  fingerprintW5File,
} from '@canopy/core-runtime/node/w5/commit-log';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import {
  internalRootFilesystemHost,
  createPrivateMigrationDirectory,
  migrationNodeIdentity,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import {
  prepareRelocationGit,
  repairRelocationGit,
  relocationTransition,
  gitBacklinkText,
  isWithin,
  assertRelocationOwnedPathsSafe,
} from '@canopy/core-runtime/node/relocation';
import { assertInternalRootNativeDaemonStopped } from '@canopy/desktop-shared/node/internal-root-migration/native-cold';
import {
  createInternalRootRelocationRepairs,
  reportInternalRootCleanup,
} from '@canopy/desktop-shared/node/internal-root-migration/repairs';
import { formatInternalRootCleanupReport } from '@canopy/desktop-shared/node/internal-root-migration/cleanup-candidates';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import { assertHostBuildStorageStartup } from '@canopy/core-platform/build-storage-startup';
import { settleInternalRootW5 } from '../internal-root-migration-maintenance';
import { diagnoseInternalRootW5 } from '../internal-root-migration-inventory';
import {
  adoptInternalRootW5Metadata,
  isToleratedInternalRootW5Issue,
} from '../internal-root-migration-w5-adoption';
import type { W5CommitOutcome } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import type {
  W5CaptureResult,
  W5CaptureRequest,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import type { W5Diagnosis } from '../w5-maintenance-diagnosis';
import { W5MaintenanceRefusedError } from '../w5-maintenance';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import {
  areOwnedPathsUnreplaced,
  assertNoDestructiveRecovery,
  canFinishArchiveCleanup,
  destructiveArchiveOutcomeSchema,
  destructiveStep,
  findCompletedDestructiveArchive,
  hasUnresolvedDestructiveRecovery,
  reportDestructiveRecovery,
  isAdmittedByUserProjectDeletion,
  withDestructiveLifecycle,
} from '../w5-destructive-recovery';
import { archiveWorktree } from '../worktree-archive';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.setTimeout(60_000);
import {
  cloneInternalRoot,
  readInternalRootAbandonmentPlan,
  statIfPresent,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';

// POSIX fixture clone only; Darwin production requires APFS clonefile.
// Windows always uses native construction instead of this seam.
async function portableClone(
  source: string,
  destination: string,
): Promise<void> {
  if (process.platform === 'win32')
    throw new Error('POSIX clone fixture cannot replace Windows construction.');
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: async (path) => !(await lstat(path)).isSocket(),
  });
  async function times(from: string, to: string): Promise<void> {
    const stat = await lstat(from);
    if (stat.isSocket()) return;
    if (stat.isDirectory())
      for (const name of await readdir(from))
        await times(join(from, name), join(to, name));
    // utimes loses precision at bucket edges; preserve the manifest's millisecond.
    const mtime = (Math.floor(stat.mtimeMs) + 0.5) / 1000;
    if (stat.isSymbolicLink()) await lutimes(to, stat.atimeMs / 1000, mtime);
    else await utimes(to, stat.atimeMs / 1000, mtime);
  }
  await times(source, destination);
}

// C's working-root.ts refuses both nested staging and the final destination.
function assertCWorkingRoot(context: InternalRootRepairContext): void {
  expect(context.workingRoot).not.toBe(context.identity.destination);
  expect(dirname(context.workingRoot)).toBe(
    dirname(context.identity.destination),
  );
}

// Cold proof and repair policy are fixtures; Windows custody, construction,
// coordination and publication use the native B2-2 host (no clone substitute).
const windows = process.platform === 'win32';
const fileSymlinkFixture = windows ? test.skip : test;
const unixEndpointFixture = windows ? test.skip : test;
const apfsCloneFixture = windows ? test.skip : test;
const strandedCases = ['P0', 'P1', 'P2', 'v2-tail', 'v3-tail'] as const;
type StrandedCase = (typeof strandedCases)[number];

async function strandedArchiveFixture(
  root: string,
  group: StrandedCase,
  worktreeId = `stranded-${group.toLowerCase()}`,
): Promise<{ path: string; record: DestructiveRecoveryRecord; bytes: string }> {
  const createdAt = '2026-10-30T16:58:14.329Z';
  const workspaceId = 'fixture';
  const record: DestructiveRecoveryRecord = {
    version: 1,
    operationId: '00000000-0000-4000-8000-000000000003',
    operation: 'worktree-archive',
    workspaceId,
    worktreeId,
    createdAt,
    state: 'recovery-required',
    directoryIdentity: null,
    steps: [
      { phase: 'live-state-teardown', state: 'done' },
      {
        phase: 'retained-payload-capture',
        state: group === 'P0' ? 'pending' : 'done',
      },
      ...(group === 'P2'
        ? [
            { phase: 'git-capture', state: 'done' as const },
            { phase: 'provider-capture', state: 'done' as const },
          ]
        : []),
      ...(group.endsWith('tail')
        ? [
            { phase: 'checkout-quarantine', state: 'done' as const },
            { phase: 'retained-manifest-commit', state: 'done' as const },
            { phase: 'compatibility-symlinks', state: 'done' as const },
            { phase: 'canonical-row-removal', state: 'pending' as const },
          ]
        : []),
    ],
    ownedPaths: [
      {
        path: join(root, 'workspaces', workspaceId, 'worktrees', worktreeId),
        identity: null,
      },
    ],
  };
  const staged = join(
    root,
    'workspaces',
    workspaceId,
    'archived-containers',
    worktreeId,
  );
  await mkdir(staged, { recursive: true, mode: 0o700 });
  await writeFile(join(staged, 'partial-payload'), 'preserve staged bytes');
  if (group.endsWith('tail')) {
    const manifest = {
      version: group === 'v2-tail' ? 2 : 3,
      kind: 'worktree',
      id: worktreeId,
      projectId: workspaceId,
      name: worktreeId,
      createdAt,
      archivedAt: createdAt,
      retentionDays: 30,
      expiresAt: '2026-11-29T16:58:14.329Z',
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'multi-repo',
      originalWorktree: {
        id: worktreeId,
        createdAt,
        branchName: 'retained-branch',
      },
      ...(group === 'v2-tail'
        ? {
            restoreScope: 'workspace-root-only',
            gitState: { version: 1, diffFormatVersion: 1, repositories: [] },
            gitChanges: { status: 'unavailable', capturedAt: createdAt },
            pullRequestMetadata: { capturedAt: createdAt, repositories: [] },
          }
        : {
            recovery: {
              kind: 'files-only',
              source: 'partial',
              digest: 'a'.repeat(64),
              payloadId: '00000000-0000-4000-8000-000000000004',
            },
          }),
    };
    await writeFile(join(staged, 'container.json'), JSON.stringify(manifest));
  }
  const journals = join(root, 'w5/destructive-lifecycles');
  await mkdir(journals, { recursive: true, mode: 0o700 });
  const path = join(
    journals,
    `${createHash('sha256')
      .update(JSON.stringify([workspaceId, worktreeId]))
      .digest('hex')}.json`,
  );
  const bytes = JSON.stringify(record);
  await writeFile(path, bytes);
  return { path, record, bytes };
}

describe('cold inert archive classification', () => {
  test.each(strandedCases)(
    'carries %s without changing its source evidence',
    async (group) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'ir-inert-')));
      try {
        const item = await strandedArchiveFixture(root, group);
        if (!item.record.worktreeId)
          throw new Error('Missing stranded worktree identity');
        expect(await inertArchiveGroup(root, item.record)).toBe(
          group.endsWith('tail') ? 'committed-cleanup-tail' : 'pre-quarantine',
        );
        expect(await freezeInternalRootJournals(root)).toHaveLength(1);
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        if (process.platform !== 'win32') {
          const destination = `${root}-copy`;
          const staging = `${root}-staging`;
          const evidence = await freezeInternalRootJournals(root);
          try {
            await cp(root, staging, { recursive: true });
            const transition = relocationTransition({
              version: 1,
              installationId: 'inert-fixture',
              brandId: 'canopy',
              from: { authorityId: 'a'.repeat(64), canonicalDataRoot: root },
              to: {
                authorityId: 'b'.repeat(64),
                canonicalDataRoot: destination,
              },
            });
            await relocateInternalRootJournals(
              transition,
              staging,
              internalRootFilesystemHost(),
              evidence,
            );
            await rename(staging, destination);
            await relocateInternalRootJournals(
              transition,
              destination,
              internalRootFilesystemHost(),
              evidence,
              true,
              true,
            );
            const copied = await readDestructiveJournal(
              join(destination, relative(root, item.path)),
            );
            expect(copied.ownedPaths[0]?.path).toBe(
              join(
                destination,
                'workspaces/fixture/worktrees',
                item.record.worktreeId,
              ),
            );
            expect(copied.steps).toEqual(item.record.steps);
            expect(copied.state).toBe('recovery-required');
            const previous = process.env.CANOPY_DATA_DIR;
            process.env.CANOPY_DATA_DIR = destination;
            const probes = [
              jest.spyOn(fs, 'lstat'),
              jest.spyOn(fs, 'readFile'),
              jest.spyOn(fs, 'readdir'),
              jest.spyOn(fs, 'writeFile'),
              jest.spyOn(fs, 'rm'),
            ];
            try {
              expect(
                await hasUnresolvedDestructiveRecovery(
                  copied.workspaceId,
                  copied.worktreeId,
                ),
              ).toBe(true);
              expect(await reportDestructiveRecovery()).toContainEqual(copied);
              for (const operation of [
                'worktree-archive',
                'worktree-delete',
              ] as const) {
                const effects = jest.fn();
                await expect(
                  withDestructiveLifecycle(
                    {
                      operation,
                      workspaceId: copied.workspaceId,
                      worktreeId: copied.worktreeId,
                      createdAt: copied.createdAt,
                    },
                    effects,
                  ),
                ).rejects.toMatchObject({ reason: 'recovery-required' });
                expect(effects).not.toHaveBeenCalled();
              }
              for (const probe of probes)
                for (const call of probe.mock.calls)
                  if (typeof call[0] === 'string')
                    expect(isWithin(root, call[0])).toBe(false);
            } finally {
              probes.forEach((probe) => probe.mockRestore());
              if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
              else process.env.CANOPY_DATA_DIR = previous;
            }
            expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
          } finally {
            await rm(destination, { recursive: true, force: true });
            await rm(staging, { recursive: true, force: true });
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test.each(['v2-tail', 'v3-tail'] as const)(
    'preserves existing %s cleanup resume using destination paths only',
    async (group) => {
      const temporary = await realpath(
        await mkdtemp(join(tmpdir(), 'ir-inert-resume-')),
      );
      const root = join(temporary, 'source');
      const staging = join(temporary, 'staging');
      const destination = join(temporary, 'destination');
      const host = internalRootFilesystemHost(
        windows
          ? resolve(
              '.cache/native-owned-child',
              `win32-${process.arch}`,
              'core-owned-child.node',
            )
          : undefined,
      );
      const previous = process.env.CANOPY_DATA_DIR;
      try {
        await createPrivateMigrationDirectory(root, host);
        const item = await strandedArchiveFixture(root, group);
        const { record } = item;
        if (!record.worktreeId || !record.createdAt)
          throw new Error('Missing lifecycle identity');
        const metadata = join(
          root,
          'workspaces/fixture/worktree-data',
          record.worktreeId,
        );
        await mkdir(metadata, { recursive: true });
        await writeFile(join(metadata, 'sentinel'), 'source must survive');
        const identityOf = async (path: string): Promise<string> => {
          const stat = await lstat(path);
          return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        };
        record.directoryIdentity = await identityOf(
          join(root, 'workspaces/fixture'),
        );
        record.ownedPaths.push({
          path: metadata,
          identity: await identityOf(metadata),
        });
        for (const phase of [
          'git-worktree-removal',
          'quarantine-directory-removal',
          'pipeline-cleanup',
          'git-capture-completion',
        ])
          record.steps.push({ phase, state: 'done' });
        const sourceBytes = JSON.stringify(record);
        await writeFile(item.path, sourceBytes);
        process.env.CANOPY_DATA_DIR = root;
        expect(await canFinishArchiveCleanup(record, record.createdAt)).toBe(
          true,
        );
        const evidence = await freezeInternalRootJournals(root);
        await createPrivateMigrationDirectory(staging, host);
        await cp(root, staging, { recursive: true });
        const transition = relocationTransition({
          version: 1,
          installationId: 'cleanup-fixture',
          brandId: 'canopy',
          from: { authorityId: 'a'.repeat(64), canonicalDataRoot: root },
          to: { authorityId: 'b'.repeat(64), canonicalDataRoot: destination },
        });
        await relocateInternalRootJournals(transition, staging, host, evidence);
        await rename(staging, destination);
        const copiedPath = join(destination, relative(root, item.path));
        const copied = await readDestructiveJournal(copiedPath);
        process.env.CANOPY_DATA_DIR = destination;
        const projectedMetadata = join(destination, relative(root, metadata));
        const probes = [
          jest.spyOn(fs, 'lstat'),
          jest.spyOn(fs, 'stat'),
          jest.spyOn(fs, 'realpath'),
          jest.spyOn(fs, 'readFile'),
          jest.spyOn(fs, 'readdir'),
          jest.spyOn(fs, 'open'),
          jest.spyOn(fs, 'writeFile'),
          jest.spyOn(fs, 'rename'),
          jest.spyOn(fs, 'rm'),
        ];
        try {
          expect(await canFinishArchiveCleanup(copied, record.createdAt)).toBe(
            true,
          );
          await withDestructiveLifecycle(
            {
              operation: 'worktree-archive',
              workspaceId: record.workspaceId,
              worktreeId: record.worktreeId,
              createdAt: record.createdAt,
              allowMissingRow: true,
              resumeArchiveCleanup: true,
            },
            async () => {
              await destructiveStep('sidecar:worktree metadata', () =>
                rm(projectedMetadata, { recursive: true }),
              );
              await destructiveStep('canonical-row-removal', () =>
                Promise.resolve(),
              );
            },
          );
          expect((await readDestructiveJournal(copiedPath)).state).toBe(
            'completed',
          );
          for (const probe of probes)
            for (const call of probe.mock.calls)
              for (const path of call.slice(0, 2))
                if (typeof path === 'string')
                  expect(isWithin(root, path)).toBe(false);
        } finally {
          probes.forEach((probe) => probe.mockRestore());
        }
        expect(await statIfPresent(projectedMetadata)).toBeNull();
        expect(await readFile(join(metadata, 'sentinel'), 'utf8')).toBe(
          'source must survive',
        );
        expect(await readFile(item.path, 'utf8')).toBe(sourceBytes);
      } finally {
        if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = previous;
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
  test.each(['completed', 'worktree-delete', 'workspace-delete'] as const)(
    'abandonment refuses a name matching only %s history',
    async (kind) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'ir-abandon-refuse-')),
      );
      try {
        const item = await strandedArchiveFixture(root, 'P0', 'crow');
        if (kind === 'completed') item.record.state = 'completed';
        else item.record.operation = kind;
        await writeFile(item.path, JSON.stringify(item.record));
        await expect(
          freezeInternalRootJournals(root, ['fixture/crow']),
        ).rejects.toThrow('does not match an unfinished worktree archive');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test('abandonment does not admit an unnamed blocking archive', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ir-abandon-unnamed-')),
    );
    try {
      const named = await strandedArchiveFixture(root, 'P0', 'crow');
      const unnamed = await strandedArchiveFixture(root, 'P0', 'other');
      for (const item of [named, unnamed]) {
        item.record.state = 'active';
        await writeFile(item.path, JSON.stringify(item.record));
      }
      await expect(
        freezeInternalRootJournals(root, ['fixture/crow']),
      ).rejects.toThrow('Unsettled lifecycle journal evidence');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test.each([
    'active',
    'worktree-delete',
    'workspace-delete',
    'child',
    'checkout-quarantine',
    'git-worktree-removal',
    'teardown-script',
    'missing-createdAt',
    'mismatched-createdAt',
    'corrupt-manifest',
    'unrecognized-manifest',
    'committed-unsafe-tail',
  ])('refuses %s', async (kind) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ir-inert-refuse-')),
    );
    try {
      const committed = [
        'mismatched-createdAt',
        'corrupt-manifest',
        'unrecognized-manifest',
        'committed-unsafe-tail',
      ].includes(kind);
      const item = await strandedArchiveFixture(
        root,
        committed ? 'v3-tail' : 'P0',
      );
      const record = item.record;
      if (!record.worktreeId)
        throw new Error('Missing stranded worktree identity');
      if (kind === 'active') record.state = 'active';
      if (kind === 'worktree-delete' || kind === 'workspace-delete')
        record.operation = kind;
      if (kind === 'child') record.parentOperation = 'workspace-delete';
      if (kind === 'missing-createdAt') delete record.createdAt;
      if (kind === 'mismatched-createdAt')
        record.createdAt = '2026-10-31T16:58:14.329Z';
      if (
        [
          'checkout-quarantine',
          'git-worktree-removal',
          'teardown-script',
          'committed-unsafe-tail',
        ].includes(kind)
      )
        record.steps.push({
          phase:
            kind === 'committed-unsafe-tail' ? 'git-worktree-removal' : kind,
          state: 'pending',
        });
      if (kind === 'corrupt-manifest' || kind === 'unrecognized-manifest')
        await writeFile(
          join(
            root,
            'workspaces/fixture/archived-containers',
            record.worktreeId,
            'container.json',
          ),
          kind === 'corrupt-manifest' ? 'broken' : '{"version":99}',
        );
      await writeFile(item.path, JSON.stringify(record));
      expect(await inertArchiveGroup(root, record)).toBeNull();
      await expect(freezeInternalRootJournals(root)).rejects.toThrow(
        'Unsettled lifecycle journal evidence',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('offline operator option admission', () => {
  test('inventory and resume preserve frozen abandonment with no flags', () => {
    const frozen = ['fixture/crow', 'fixture/gnat-2', 'fixture/crow'];
    expect(selectInternalRootArchiveAbandonments([], frozen)).toEqual([
      'fixture/crow',
      'fixture/gnat-2',
    ]);
    expect(
      selectInternalRootArchiveAbandonments(
        ['fixture/gnat-2', 'fixture/crow'],
        frozen,
      ),
    ).toEqual(['fixture/crow', 'fixture/gnat-2']);
    for (const requested of [['fixture/crow'], ['fixture/sunbird-2']])
      expect(() =>
        selectInternalRootArchiveAbandonments(requested, frozen),
      ).toThrow('all original opt-ins (fixture/crow, fixture/gnat-2)');
    expect(() =>
      selectInternalRootArchiveAbandonments(['fixture/crow'], []),
    ).toThrow('already frozen');
    expect(selectInternalRootArchiveAbandonments(['fixture/crow'])).toEqual([
      'fixture/crow',
    ]);
  });

  test('checkout opt-ins accept both forms and preserve the frozen set', () => {
    const first = join(tmpdir(), 'broken one');
    const second = join(tmpdir(), 'broken-two');
    const paths = [first, second];
    expect(
      parseInternalRootMigrationOptions([
        '--brand=canopy',
        '--apply',
        '--abandon-checkout',
        first,
        `--abandon-checkout=${second}`,
      ]).abandonCheckouts,
    ).toEqual(paths);
    expect(
      selectInternalRootArchiveAbandonments([], paths, 'Checkout'),
    ).toEqual(paths);
    expect(() =>
      selectInternalRootArchiveAbandonments([first], paths, 'Checkout'),
    ).toThrow('Checkout abandonment is already frozen');
  });

  test('accepts explicit restart options separately from completed rebuild', () => {
    expect(
      parseInternalRootMigrationOptions([
        '--brand=canopy',
        '--apply',
        '--restart',
      ]),
    ).toMatchObject({ apply: true, restart: true, rebuild: false });
    for (const args of [
      ['--restart'],
      ['--inventory', '--restart'],
      ['--skip-migration', '--restart'],
      ['--apply', '--restart', '--rebuild'],
    ])
      expect(() =>
        parseInternalRootMigrationOptions(['--brand=canopy', ...args]),
      ).toThrow('Usage:');
  });

  test('restart accepts all opt-ins and retains all recovery flags in usage', () => {
    const checkout = join(tmpdir(), 'broken checkout');
    for (const optIn of [
      ['--abandon-checkout', checkout],
      [`--abandon-checkout=${checkout}`],
    ])
      expect(
        parseInternalRootMigrationOptions([
          '--brand=canopy',
          '--apply',
          '--restart',
          '--abandon-archive=fixture/crow',
          '--abandon-commit',
          '80724',
          '--abandon-commit=80725',
          ...optIn,
        ]),
      ).toMatchObject({
        restart: true,
        abandonArchives: ['fixture/crow'],
        abandonCommits: [80724, 80725],
        abandonCheckouts: [checkout],
      });
    for (const flag of [
      '--restart',
      '--rebuild',
      '--abandon-archive',
      '--abandon-commit',
      '--abandon-checkout',
    ])
      expect(() => parseInternalRootMigrationOptions([])).toThrow(flag);
  });

  test.each(['--inventory', '--apply'])(
    'accepts repeated abandonment for %s',
    (mode) => {
      expect(
        parseInternalRootMigrationOptions([
          '--brand=canopy',
          mode,
          '--abandon-archive',
          'fixture/crow',
          '--abandon-archive=fixture/gnat-2',
        ]).abandonArchives,
      ).toEqual(['fixture/crow', 'fixture/gnat-2']);
    },
  );
  test.each(['--inventory', '--apply'])(
    'accepts repeated commit opt-ins for %s',
    (mode) => {
      expect(
        parseInternalRootMigrationOptions([
          '--brand=canopy',
          mode,
          '--abandon-commit',
          '80724',
          '--abandon-commit=80725',
        ]).abandonCommits,
      ).toEqual([80724, 80725]);
    },
  );
  test.each([
    ['--abandon-commit'],
    ['--abandon-commit='],
    ['--abandon-commit=0'],
    ['--abandon-commit=-1'],
    ['--abandon-commit=1.5'],
    ['--abandon-commit=01'],
    ['--abandon-commit=9007199254740992'],
    ['--abandon-commit=oops'],
    ['--abandon-commit=1', '--abandon-commit', '1'],
    ['--skip-migration', '--abandon-commit=1'],
  ])('refuses invalid commit opt-ins %j', (...args) => {
    expect(() =>
      parseInternalRootMigrationOptions(['--brand=canopy', ...args]),
    ).toThrow('Usage:');
  });
  test.each([
    ['--skip-migration', '--source-dir=/selected'],
    ['--skip-migration', '--apply'],
    ['--skip-migration', '--inventory'],
    ['--skip-migration', '--declare-internal'],
    ['--skip-migration', '--rebuild'],
    ['--source-dir='],
    ['--source-dir=/one', '--source-dir=/two'],
    ['--apply', '--apply'],
    ['--abandon-checkout'],
    ['--abandon-checkout='],
    ['--abandon-checkout=relative/path'],
    ['--abandon-checkout=/one', '--abandon-checkout=/one'],
    ['--skip-migration', '--abandon-checkout=/one'],
    ['--abandon-archive'],
    ['--abandon-archive='],
    ['--abandon-archive', '../crow'],
    ['--abandon-archive', 'fixture/crow', '--abandon-archive=fixture/crow'],
    ['--skip-migration', '--abandon-archive', 'fixture/crow'],
  ])('refuses conflicting or ambiguous options %j', (...args) => {
    expect(() =>
      parseInternalRootMigrationOptions(['--brand=canopy', ...args]),
    ).toThrow('Usage:');
  });
});
describe('cold migration opaque artifact diagnosis', () => {
  test('marks only real unindexed folders and unrecognized W5 regular files as opaque', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ir-opaque-'));
    try {
      for (const name of ['hey', 'old workspace', 'commit-log'])
        await mkdir(join(root, 'workspaces', name, 'chat-storage'), {
          recursive: true,
        });
      await writeFile(
        join(root, 'workspaces/index.json'),
        '{"version":1,"workspaces":[{"id":"indexed","name":"Indexed","color":"blue","type":"multi-repo"}]}',
      );
      await writeFile(join(root, 'workspaces/hey/workspace.json'), 'broken');
      await writeFile(join(root, 'workspaces/unexpected'), 'not a directory');
      await writeFile(join(root, 'workspaces/.DS_Store'), 'Finder metadata');
      await mkdir(join(root, 'w5/destructive-lifecycles'), { recursive: true });
      await mkdir(join(root, 'w5/quarantined-lifecycles'));
      await mkdir(join(root, 'w5/unexpected-directory'));
      await writeFile(
        join(root, 'w5/destructive-lifecycles/unexpected.json'),
        '{}',
      );
      await writeFile(join(root, 'w5/quarantined-lifecycles/old.json'), '{}');
      await writeFile(join(root, 'w5/canopy-restart.log'), 'opaque');
      if (process.platform !== 'win32') {
        await symlink('hey', join(root, 'workspaces/alias'));
        await symlink('canopy-restart.log', join(root, 'w5/alias'));
        await symlink('unexpected-directory', join(root, 'w5/backups'));
      }
      const log = W5CommitLog.open(join(root, 'w5/commit-log.sqlite'));
      try {
        const result = log.commit({
          operation: 'fixture.historical-path',
          advance: [],
          files: [
            {
              path: join(root, 'predecessor/workspaces/index.json'),
              contents: '{}',
              previousFingerprint: null,
            },
          ],
          outcome: {},
        });
        if (result.status !== 'committed')
          throw new Error('Missing historical receipt');
        log.markApplied(result.commitId);
      } finally {
        log.close();
      }
      const diagnosis = await diagnoseW5State(root, 'w5-owned');
      expect(diagnosis.logIssue).toBeNull();
      expect(diagnosis.files.filter(isToleratedInternalRootW5Issue)).toEqual([
        {
          path: '.DS_Store',
          reason: 'unknown-artifact',
          artifactKind: 'unrecognized-workspace-file',
        },
        {
          path: 'commit-log',
          reason: 'unknown-artifact',
          artifactKind: 'unindexed-workspace-directory',
        },
        {
          path: 'hey',
          reason: 'unknown-artifact',
          artifactKind: 'unindexed-workspace-directory',
        },
        { path: 'hey/workspace.json', reason: 'untracked-file' },
        { path: 'index.json', reason: 'untracked-file' },
        {
          path: 'old workspace',
          reason: 'unknown-artifact',
          artifactKind: 'unindexed-workspace-directory',
        },
        {
          path: 'unexpected',
          reason: 'unknown-artifact',
          artifactKind: 'unrecognized-workspace-file',
        },
        {
          path: 'w5/canopy-restart.log',
          reason: 'unknown-artifact',
          artifactKind: 'unrecognized-w5-file',
        },
      ]);
      expect(
        diagnosis.files.filter(
          (issue) => !isToleratedInternalRootW5Issue(issue),
        ),
      ).toEqual(
        expect.arrayContaining([
          { path: 'commit-log', reason: 'unknown-artifact' },
          { path: 'hey/workspace.json', reason: 'corrupt-file' },
          { path: 'indexed/workspace.json', reason: 'missing-file' },
          { path: 'indexed/worktrees.json', reason: 'missing-file' },
          { path: 'w5/unexpected-directory', reason: 'unknown-artifact' },
          {
            path: 'w5/destructive-lifecycles/unexpected.json',
            reason: 'unknown-artifact',
          },
          {
            path: 'w5/quarantined-lifecycles/old.json',
            reason: 'quarantined-journal',
          },
          ...(process.platform === 'win32'
            ? []
            : [
                { path: 'alias', reason: 'unknown-artifact' },
                { path: 'w5/alias', reason: 'unknown-artifact' },
                { path: 'w5/backups', reason: 'unknown-artifact' },
              ]),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cold metadata adoption policy', () => {
  const contents =
    '{"version":1,"worktrees":[{"id":"new","branchName":"new","createdAt":"today"}]}\n';
  function fixture(path = 'fixture/worktrees.json'): {
    diagnosis: W5Diagnosis;
    capture: W5CaptureResult;
    host: {
      root: string;
      capture: jest.Mock<Promise<W5CaptureResult>, [W5CaptureRequest]>;
      commit: jest.Mock<Promise<W5CommitOutcome>, [W5CommitRequest]>;
    };
    held: jest.Mock<Promise<void>, []>;
  } {
    const diagnosis: W5Diagnosis = {
      files: [{ path, reason: 'log-mismatch' }],
      commits: [],
      reservations: [],
      logIssue: null,
      destructiveJournalArtifactCount: 0,
    };
    const capture: W5CaptureResult = {
      files: [
        {
          kind: 'worktrees',
          workspaceId: 'fixture',
          state: 'present',
          base64: Buffer.from(contents).toString('base64'),
        },
      ],
      discovery: 'not-requested',
      log: {
        commitId: 1,
        retainedCommits: 1,
        unresolvedCommits: 0,
        schemaVersion: 8,
        revisions: { 'worktrees:fixture': 2, 'worktree:fixture/removed': 3 },
        files: [],
        chains: [],
        resourceRevisionEligibility: 'unproven',
      },
    };
    const host = {
      root: '/qualified/workspaces',
      capture: jest.fn<Promise<W5CaptureResult>, [W5CaptureRequest]>(() =>
        Promise.resolve(capture),
      ),
      commit: jest.fn<Promise<W5CommitOutcome>, [W5CommitRequest]>(() =>
        Promise.resolve({
          status: 'applied' as const,
          commitId: 2,
          revisions: {},
        }),
      ),
    };
    const held = jest.fn(() => Promise.resolve());
    return { diagnosis, capture, host, held };
  }
  test('records the exact disk image, not the historical image, and invalidates child revisions', async () => {
    const { diagnosis, host, held } = fixture();
    await adoptInternalRootW5Metadata(host, diagnosis, held, () =>
      Promise.resolve(),
    );
    expect(host.commit).toHaveBeenCalledTimes(1);
    const [request] = host.commit.mock.calls[0] ?? [];
    expect(request?.files).toEqual([
      {
        path: '/qualified/workspaces/fixture/worktrees.json',
        contents,
        previousFingerprint: fingerprintW5File(contents),
      },
    ]);
    expect(request?.advance).toEqual(
      expect.arrayContaining([
        { kind: 'worktrees', workspaceId: 'fixture' },
        { kind: 'worktree', workspaceId: 'fixture', worktreeId: 'removed' },
        { kind: 'worktree', workspaceId: 'fixture', worktreeId: 'new' },
      ]),
    );
    expect(held).toHaveBeenCalled();
  });
  test('adopts metadata alongside observed opaque artifacts, not unknown owned state', async () => {
    const { diagnosis, host, held } = fixture();
    await adoptInternalRootW5Metadata(
      host,
      {
        ...diagnosis,
        files: [
          ...diagnosis.files,
          {
            path: '.DS_Store',
            reason: 'unknown-artifact',
            artifactKind: 'unrecognized-workspace-file',
          },
          {
            path: 'hey',
            reason: 'unknown-artifact',
            artifactKind: 'unindexed-workspace-directory',
          },
          {
            path: 'w5/canopy-restart.log',
            reason: 'unknown-artifact',
            artifactKind: 'unrecognized-w5-file',
          },
        ],
      },
      held,
      () => Promise.resolve(),
    );
    expect(host.commit).toHaveBeenCalledTimes(1);
  });
  test.each([
    { path: 'commit-log', reason: 'unknown-artifact' as const },
    { path: 'unexpected', reason: 'unknown-artifact' as const },
    { path: 'w5/destructive-lifecycles', reason: 'unknown-artifact' as const },
    {
      path: 'w5/destructive-lifecycles/unexpected.json',
      reason: 'unknown-artifact' as const,
    },
    { path: 'w5/quarantined-lifecycles', reason: 'unknown-artifact' as const },
    {
      path: 'w5/quarantined-lifecycles/old.json',
      reason: 'quarantined-journal' as const,
    },
    { path: 'fixture/workspace.json', reason: 'corrupt-file' as const },
    { path: 'fixture/workspace.json', reason: 'missing-file' as const },
  ])('does not tolerate owned-state evidence $reason: $path', async (issue) => {
    const { diagnosis, host, held } = fixture();
    expect(isToleratedInternalRootW5Issue(issue)).toBe(false);
    await adoptInternalRootW5Metadata(
      host,
      { ...diagnosis, files: [...diagnosis.files, issue] },
      held,
    );
    expect(host.commit).not.toHaveBeenCalled();
  });
  test.each(['index.json', '../workspace.json', 'fixture/other.json'])(
    'never adopts out-of-scope %s',
    async (path) => {
      const { diagnosis, host, held } = fixture(path);
      await adoptInternalRootW5Metadata(host, diagnosis, held, () =>
        Promise.resolve(),
      );
      expect(host.commit).not.toHaveBeenCalled();
    },
  );
  test.each([
    'reservation',
    'commit',
    'corrupt-file',
    'missing-file',
    'unknown-artifact',
    'log',
  ])('refuses adoption with %s evidence', async (blocker) => {
    const { diagnosis, host, held } = fixture();
    const guarded: W5Diagnosis = {
      ...diagnosis,
      ...(blocker === 'reservation'
        ? {
            reservations: [
              {
                reservationId: 'r',
                operation: 'create',
                state: 'recovery-required',
                diagnostics: '{}',
              },
            ],
          }
        : {}),
      ...(blocker === 'commit'
        ? {
            commits: [
              {
                commitId: 2,
                operation: 'create',
                state: 'recovery-required',
                diagnostics: null,
                receiptOperations: ['create'],
              },
            ],
          }
        : {}),
      ...(blocker === 'log' ? { logIssue: 'unavailable' as const } : {}),
      ...(blocker === 'corrupt-file' ||
      blocker === 'missing-file' ||
      blocker === 'unknown-artifact'
        ? {
            files: [
              ...diagnosis.files,
              { path: 'fixture/worktrees.json', reason: blocker },
            ],
          }
        : {}),
    };
    await adoptInternalRootW5Metadata(host, guarded, held);
    expect(host.commit).not.toHaveBeenCalled();
  });
  test('adopts a manifest without reformatting or restoring its old values', async () => {
    const { diagnosis, capture, host, held } = fixture(
      'fixture/workspace.json',
    );
    const raw = '{ "version": 1, "id": "fixture", "name": "CLI name" }\n';
    host.capture.mockResolvedValue({
      ...capture,
      files: [
        {
          kind: 'manifest',
          workspaceId: 'fixture',
          state: 'present',
          base64: Buffer.from(raw).toString('base64'),
        },
      ],
    });
    await adoptInternalRootW5Metadata(host, diagnosis, held, () =>
      Promise.resolve(),
    );
    expect(host.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        advance: [{ kind: 'workspace', workspaceId: 'fixture' }],
        files: [
          {
            path: '/qualified/workspaces/fixture/workspace.json',
            contents: raw,
            previousFingerprint: fingerprintW5File(raw),
          },
        ],
      }),
    );
  });
  test('adopts multiple metadata mismatches without mixing their images or revisions', async () => {
    const { diagnosis, capture, host, held } = fixture();
    const manifest = '{ "version": 1, "id": "fixture", "name": "CLI name" }\n';
    host.capture.mockResolvedValueOnce(capture).mockResolvedValueOnce({
      ...capture,
      files: [
        {
          kind: 'manifest',
          workspaceId: 'fixture',
          state: 'present',
          base64: Buffer.from(manifest).toString('base64'),
        },
      ],
    });
    await adoptInternalRootW5Metadata(
      host,
      {
        ...diagnosis,
        files: [
          ...diagnosis.files,
          { path: 'fixture/workspace.json', reason: 'log-mismatch' },
        ],
      },
      held,
      () => Promise.resolve(),
    );
    expect(host.capture.mock.calls).toEqual([
      [
        {
          files: [{ kind: 'worktrees', workspaceId: 'fixture' }],
          discoverWorkspaces: false,
        },
      ],
      [
        {
          files: [{ kind: 'manifest', workspaceId: 'fixture' }],
          discoverWorkspaces: false,
        },
      ],
    ]);
    expect(host.commit).toHaveBeenCalledTimes(2);
    const [first] = host.commit.mock.calls[0] ?? [];
    const [second] = host.commit.mock.calls[1] ?? [];
    expect(first?.files[0]?.contents).toBe(contents);
    expect(second?.files).toEqual([
      {
        path: '/qualified/workspaces/fixture/workspace.json',
        contents: manifest,
        previousFingerprint: fingerprintW5File(manifest),
      },
    ]);
    expect(second?.advance).toEqual([
      { kind: 'workspace', workspaceId: 'fixture' },
    ]);
  });
  test.each([
    'absent',
    'unreadable',
    'wrong-file',
    'corrupt',
    'invalid-utf8',
    'pending',
  ])('refuses a changed capture: %s', async (state) => {
    const { diagnosis, capture, host, held } = fixture();
    if (state === 'absent')
      host.capture.mockResolvedValue({
        ...capture,
        files: [{ kind: 'worktrees', workspaceId: 'fixture', state: 'absent' }],
      });
    else if (state === 'unreadable')
      host.capture.mockResolvedValue({
        ...capture,
        files: [
          {
            kind: 'worktrees',
            workspaceId: 'fixture',
            state: 'unreadable',
            reason: 'unsafe-path',
          },
        ],
      });
    else if (state === 'pending')
      host.capture.mockResolvedValue({
        ...capture,
        log: { ...capture.log, unresolvedCommits: 1 },
      });
    else
      host.capture.mockResolvedValue({
        ...capture,
        files: [
          {
            kind: 'worktrees',
            workspaceId: state === 'wrong-file' ? 'other' : 'fixture',
            state: 'present',
            base64: (state === 'invalid-utf8'
              ? Buffer.from([0xff])
              : Buffer.from('not json')
            ).toString('base64'),
          },
        ],
      });
    await expect(
      adoptInternalRootW5Metadata(host, diagnosis, held, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow();
    expect(host.commit).not.toHaveBeenCalled();
  });
  test('flush failure refuses before recording adoption', async () => {
    const { diagnosis, host, held } = fixture();
    await expect(
      adoptInternalRootW5Metadata(host, diagnosis, held, () =>
        Promise.reject(new Error('disk unavailable')),
      ),
    ).rejects.toThrow('disk unavailable');
    expect(host.commit).not.toHaveBeenCalled();
  });
  test('lost exclusion after capture refuses before recording adoption', async () => {
    const { diagnosis, host, held } = fixture();
    held
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('lost during capture'));
    await expect(
      adoptInternalRootW5Metadata(host, diagnosis, held, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('lost during capture');
    expect(host.commit).not.toHaveBeenCalled();
  });
  test.each([
    { files: [] },
    {
      files: [
        { path: 'fixture/worktrees.json', reason: 'untracked-file' as const },
      ],
    },
  ])('does not invent adoptions for %j', async ({ files }) => {
    const { diagnosis, host, held } = fixture();
    await adoptInternalRootW5Metadata(host, { ...diagnosis, files }, held, () =>
      Promise.resolve(),
    );
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.commit).not.toHaveBeenCalled();
  });
  test.each([false, true])(
    'real W5 adoption preserves bytes and receipts across interruption=%s',
    async (interrupt) => {
      const temporary = await mkdtemp(join(tmpdir(), 'ir-adopt-'));
      const dataRoot = join(temporary, 'original');
      const root = join(dataRoot, 'workspaces');
      const path = join(root, 'fixture', 'worktrees.json');
      await mkdir(join(root, 'fixture'), { recursive: true });
      await mkdir(join(dataRoot, 'w5'));
      const initial = '{"version":1,"worktrees":[]}';
      await writeFile(path, initial);
      await writeFile(
        join(root, 'fixture', 'workspace.json'),
        '{"version":1,"id":"fixture"}',
      );
      await writeFile(
        join(root, 'index.json'),
        '{"version":1,"workspaces":[{"id":"fixture","name":"Fixture","type":"multi-repo","color":"blue"}]}',
      );
      const log = W5CommitLog.open(join(dataRoot, 'w5', 'commit-log.sqlite'));
      const receipt = {
        caller: 'fixture',
        operation: 'core.worktree.update',
        idempotencyKey: 'existing',
        fingerprint: 'existing-parameters',
      };
      try {
        const saved = log.commit({
          operation: receipt.operation,
          receipt,
          advance: [{ kind: 'worktrees', workspaceId: 'fixture' }],
          files: [{ path, contents: initial, previousFingerprint: null }],
          outcome: { saved: true },
        });
        if (saved.status !== 'committed')
          throw new Error('Missing seed commit');
        log.markApplied(saved.commitId);
        await writeFile(path, contents);
        const before = await lstat(path);
        const host = {
          root,
          capture: async (): Promise<W5CaptureResult> => ({
            files: [
              {
                kind: 'worktrees',
                workspaceId: 'fixture',
                state: 'present',
                base64: (await readFile(path)).toString('base64'),
              },
            ],
            discovery: 'not-requested',
            log: log.captureEvidence([
              { file: { kind: 'worktrees', workspaceId: 'fixture' }, path },
            ]),
          }),
          commit: async (
            request: W5CommitRequest,
          ): Promise<W5CommitOutcome> => {
            const decision = log.commit(request);
            if (decision.status !== 'committed')
              throw new Error('Unexpected replay');
            if (interrupt)
              throw new Error('interrupted after adoption decision');
            const pending = log.listPendingCommits()[0];
            if (!pending) throw new Error('Missing adoption decision');
            const result = await applyW5Commit(log, pending, {
              root,
              durability: desktopW5Durability,
            });
            if (result.status !== 'applied')
              throw new Error('Adoption did not apply');
            return {
              status: 'applied',
              commitId: decision.commitId,
              revisions: decision.revisions,
            };
          },
        };
        const diagnosis = await diagnoseW5State(dataRoot, 'w5-owned');
        expect(diagnosis.files).toContainEqual({
          path: 'fixture/worktrees.json',
          reason: 'log-mismatch',
        });
        const held = (): Promise<void> => Promise.resolve();
        if (interrupt) {
          await expect(
            adoptInternalRootW5Metadata(host, diagnosis, held),
          ).rejects.toThrow('interrupted after adoption decision');
          const pending = log.listPendingCommits()[0];
          if (!pending) throw new Error('Missing interrupted decision');
          expect(
            await applyW5Commit(log, pending, {
              root,
              durability: desktopW5Durability,
            }),
          ).toEqual({ status: 'applied' });
        } else await adoptInternalRootW5Metadata(host, diagnosis, held);
        const settled = await diagnoseW5State(dataRoot, 'w5-owned');
        expect(settled.commits).toEqual([]);
        expect(
          settled.files.filter((issue) => issue.reason !== 'untracked-file'),
        ).toEqual([]);
        const commitId = log.snapshot().commitId;
        await adoptInternalRootW5Metadata(host, settled, held);
        expect(log.snapshot().commitId).toBe(commitId);
        expect(await readFile(path, 'utf8')).toBe(contents);
        const after = await lstat(path);
        expect({ ino: after.ino, mtime: after.mtimeMs }).toEqual({
          ino: before.ino,
          mtime: before.mtimeMs,
        });
        expect(log.lookupReceipt(receipt, receipt.fingerprint)).toEqual({
          status: 'replay',
          commitId: saved.commitId,
          outcome: { saved: true },
        });
      } finally {
        log.close();
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
  test('lost exclusion refuses before a commit', async () => {
    const { diagnosis, host } = fixture();
    await expect(
      adoptInternalRootW5Metadata(host, diagnosis, () =>
        Promise.reject(new Error('lost qualification')),
      ),
    ).rejects.toThrow('lost qualification');
    expect(host.commit).not.toHaveBeenCalled();
  });
});
describe('offline filesystem transaction (fixture cold proof)', () => {
  let home: string;
  let temporaryHome: string;
  let identity: InternalRootIdentity;
  let worker: InternalRootMigrationWorker;
  let recover: jest.Mock<Promise<void>, [string]>;
  let repairs: InternalRootRepairs;
  const apply = { apply: true, declareInternal: true };
  let filesystemOptions: {
    ownedChildPath?: string;
    cloneTree?: typeof portableClone;
  } = windows
    ? {
        ownedChildPath: resolve(
          '.cache/native-owned-child',
          `win32-${process.arch}`,
          'core-owned-child.node',
        ),
      }
    : { cloneTree: portableClone };
  let host: ReturnType<typeof internalRootFilesystemHost>;
  function nativeRepairOptions(): {
    filesystemHost: ReturnType<typeof internalRootFilesystemHost>;
    windowsPrincipal: (() => Promise<string>) | undefined;
  } {
    return {
      filesystemHost: host,
      windowsPrincipal: windows
        ? authorityHost.windowsPrincipalObserver(
            resolve('.cache/bin/win32-x64/canopy-process-identity.exe'),
          )
        : undefined,
    };
  }
  const readFixtureJournal = (
    selected: InternalRootIdentity,
  ): ReturnType<typeof readInternalRootJournal> =>
    readInternalRootJournal(selected, host);
  // Synthetic cold callback only; custody, process identity and the W5 writer are native.
  async function fixtureW5(
    root: string,
    entry: string,
    qualification: InternalRootColdRecovery,
  ): ReturnType<typeof settleInternalRootW5> {
    return settleInternalRootW5(
      root,
      entry,
      windows
        ? { ...qualification, assertCold: qualification.assertHeld }
        : qualification,
      {
        ownedChildPath: filesystemOptions.ownedChildPath,
        windowsProcessPath: resolve(
          '.cache/bin/win32-x64/canopy-process-identity.exe',
        ),
      },
    );
  }
  async function assertPrivate(
    path: string,
    kind: 'file' | 'directory',
    mode: number,
  ): Promise<void> {
    if (windows) {
      expect(
        (
          await hostPlatformServices(
            createPlatformEndpointServices('win32'),
          ).secureFiles.permissions({
            path,
            kind,
            mode: 'owner-only',
            action: 'verify',
          })
        ).state,
      ).toBe('private');
      expect(host.windows?.inspect(path).security).toBeTruthy();
    } else expect((await lstat(path)).mode & 0o7777).toBe(mode);
  }
  let nativeBuild: string | undefined;
  beforeAll(() => {
    if (process.platform !== 'linux') return;
    nativeBuild = mkdtempSync(join(tmpdir(), 'migration-native-'));
    const ownedChildPath = join(nativeBuild, 'core-owned-child.node');
    execFileSync(
      process.execPath,
      [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
      { stdio: 'pipe' },
    );
    filesystemOptions = { ...filesystemOptions, ownedChildPath };
  }, 60_000);
  afterAll(() => {
    if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
  });
  let environment: {
    HOME: string | undefined;
    USERPROFILE: string | undefined;
  };
  beforeEach(async () => {
    const temporary = await realpath(tmpdir());
    // Include the longest predecessor and the endpoint's temporary bind name.
    const endpoint = join(
      temporary,
      'ir-XXXXXX',
      '.unstoppable-code',
      'runtime',
      '.000000000000',
    );
    const parent =
      windows || Buffer.byteLength(endpoint) <= 103
        ? temporary
        : await realpath('/tmp');
    temporaryHome = await realpath(await mkdtemp(join(parent, 'ir-')));
    host = internalRootFilesystemHost(filesystemOptions.ownedChildPath);
    home = windows ? join(temporaryHome, 'private') : temporaryHome;
    if (windows) await createPrivateMigrationDirectory(home, host);
    environment = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    process.env.HOME = process.env.USERPROFILE = home;
    identity = internalRootIdentity(home, canopy);
    recover = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
    });
    repairs = {
      prepare: (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({ kind: 'ready', externalFiles: [] }),
      repair: (context): ReturnType<InternalRootRepairs['repair']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      },
      verify: (context): ReturnType<InternalRootRepairs['verify']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      },
      qualifyPublished: (
        context,
      ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
        expect(context.workingRoot).toBe(context.identity.destination);
        return Promise.resolve({ kind: 'ok' });
      },
    };
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  });
  async function checkInstalledShape(): Promise<void> {
    // At 262435a30d32, only isRepairPlan differs: its key set is exact.
    const raw = validateInternalRootJournal(
      JSON.parse(
        await readFile(join(identity.coordination, 'journal.json'), 'utf8'),
      ),
      identity,
    );
    if (raw.repairPlan)
      expect(Object.keys(raw.repairPlan).sort()).toEqual([
        'gitPlan',
        'ownedPaths',
        'transition',
        'workspaces',
      ]);
  }

  async function source(): Promise<void> {
    await createPrivateMigrationDirectory(identity.source, host);
    await writeFile(
      join(identity.source, 'preferences.json'),
      '{"theme":"dark"}',
      { mode: 0o600 },
    );
  }
  async function lifecycleFixture(
    state: DestructiveRecoveryRecord['state'],
    operation: DestructiveRecoveryRecord['operation'] = 'worktree-archive',
    cleanupRequired?: boolean,
    present = false,
  ): Promise<{
    path: string;
    record: DestructiveRecoveryRecord;
    bytes: string;
  }> {
    const workspaceId = 'fixture';
    const worktreeId =
      operation === 'workspace-delete'
        ? undefined
        : `history-${cleanupRequired ?? operation}`;
    const directory = join(identity.source, 'workspaces', workspaceId);
    const metadata = join(directory, 'worktree-data', worktreeId ?? 'deleted');
    const statIdentity = async (path: string): Promise<string> => {
      const stat = await lstat(path);
      return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    };
    const token = '00000000-0000-4000-8000-000000000001';
    if (present) {
      await mkdir(metadata, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, '.w5-incarnation'), token);
    }
    const record: DestructiveRecoveryRecord = {
      version: 1,
      operationId: '00000000-0000-4000-8000-000000000002',
      operation,
      workspaceId,
      worktreeId,
      state,
      ...(cleanupRequired === undefined ? {} : { cleanupRequired }),
      createdAt: '2026-11-06T00:00:00.000Z',
      directoryIdentity: present
        ? `${await statIdentity(directory)}:${token}`
        : '1:2:3',
      steps: [
        'git-worktree-removal',
        'quarantine-directory-removal',
        'pipeline-cleanup',
        'retained-manifest-commit',
        'git-capture-completion',
        'sidecar:worktree metadata',
      ].map((phase) => ({ phase, state: 'done' })),
      outcome:
        operation === 'workspace-delete'
          ? { deleted: true }
          : { success: true, warnings: ['Saved archive warning'] },
      ownedPaths: [
        {
          path: metadata,
          identity: present ? await statIdentity(metadata) : '1:2:3',
        },
        {
          path: join(directory, 'worktrees', worktreeId ?? 'deleted'),
          identity: null,
        },
      ],
    };
    const name = createHash('sha256')
      .update(JSON.stringify([workspaceId, worktreeId ?? null]))
      .digest('hex');
    const directoryPath = join(identity.source, 'w5/destructive-lifecycles');
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const path = join(directoryPath, `${name}.json`);
    const bytes = JSON.stringify(record);
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, record, bytes };
  }

  async function assertCompletedHistoryReaders(
    record: DestructiveRecoveryRecord,
    unreplaced = true,
  ): Promise<void> {
    if (!record.worktreeId || !record.createdAt)
      throw new Error('Missing archive incarnation');
    const previousRoot = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = identity.destination;
    const probes = [
      jest.spyOn(fs, 'lstat'),
      jest.spyOn(fs, 'stat'),
      jest.spyOn(fs, 'realpath'),
      jest.spyOn(fs, 'readFile'),
      jest.spyOn(fs, 'readdir'),
      jest.spyOn(fs, 'access'),
      jest.spyOn(fs, 'open'),
      jest.spyOn(fs, 'writeFile'),
      jest.spyOn(fs, 'rm'),
      jest.spyOn(fs, 'rmdir'),
      jest.spyOn(fs, 'rename'),
    ];
    try {
      expect(await areOwnedPathsUnreplaced(record)).toBe(unreplaced);
      // Completed deletions cannot be superseded, even with deferred cleanup.
      expect(
        await isAdmittedByUserProjectDeletion({
          ...record,
          operation: 'workspace-delete',
          worktreeId: undefined,
        }),
      ).toBe(false);
      expect(
        await hasUnresolvedDestructiveRecovery(
          record.workspaceId,
          record.worktreeId,
        ),
      ).toBe(record.cleanupRequired === true);
      const admission = assertNoDestructiveRecovery(
        record.workspaceId,
        record.worktreeId,
        true,
      );
      if (record.cleanupRequired)
        await expect(admission).rejects.toMatchObject({
          reason: 'recovery-required',
        });
      else await expect(admission).resolves.toBeUndefined();
      expect(await canFinishArchiveCleanup(record, record.createdAt)).toBe(
        record.operation === 'worktree-archive' && unreplaced,
      );
      expect(
        await findCompletedDestructiveArchive(
          record.workspaceId,
          record.worktreeId,
          record.createdAt,
        ),
      ).toEqual(record);
      const effects = jest.fn();
      await expect(
        withDestructiveLifecycle(
          {
            operation: 'worktree-archive',
            workspaceId: record.workspaceId,
            worktreeId: record.worktreeId,
            createdAt: record.createdAt,
            replay: (outcome) => outcome,
          },
          effects,
        ),
      ).resolves.toEqual(record.outcome);
      expect(effects).not.toHaveBeenCalled();
      await expect(
        archiveWorktree({
          workspaceId: record.workspaceId,
          worktreeId: record.worktreeId,
          expectedCreatedAt: record.createdAt,
          source: 'multi_repo',
        }),
      ).resolves.toEqual({
        ...destructiveArchiveOutcomeSchema.parse(record.outcome),
        status: 'already-archived',
      });
      for (const probe of probes)
        for (const call of probe.mock.calls)
          for (const path of call.slice(0, 2)) {
            const candidate =
              typeof path === 'string'
                ? path
                : path instanceof URL
                  ? path.pathname
                  : Buffer.isBuffer(path)
                    ? path.toString('utf8')
                    : undefined;
            if (candidate !== undefined)
              expect(isWithin(identity.source, candidate)).toBe(false);
          }
    } finally {
      for (const probe of probes) probe.mockRestore();
      if (previousRoot === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previousRoot;
    }
  }

  test.each(['completed', 'P0', 'active'] as const)(
    'validates no-log lifecycle history by record state: %s',
    async (state) => {
      await source();
      const item =
        state === 'P0'
          ? await strandedArchiveFixture(identity.source, 'P0')
          : await lifecycleFixture(state);
      worker.diagnose = diagnoseInternalRootW5;
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      worker.recoverW5 = async (journal): Promise<void> => {
        await fixtureW5(identity.source, entry, {
          identity,
          transactionId: journal.transactionId,
          assertHeld: () => Promise.resolve(),
        });
      };
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      if (state === 'active')
        await expect(run()).rejects.toThrow('state=active');
      else {
        await expect(run()).resolves.toMatchObject({ kind: 'complete' });
        expect(await diagnoseInternalRootW5(identity.source)).toEqual([]);
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        const copied = await readDestructiveJournal(
          join(identity.destination, relative(identity.source, item.path)),
        );
        expect(copied.state).toBe(item.record.state);
        expect(copied.ownedPaths.map(({ path }) => path)).toEqual(
          item.record.ownedPaths.map(({ path }) =>
            join(identity.destination, relative(identity.source, path)),
          ),
        );
      }
    },
  );

  (windows ? test.skip : test)(
    'Linux apply-peak census refuses inventory and first apply before any journal, including external Git roots',
    async () => {
      await source();
      const externalRoot = '/external/.git';
      const externalFile = `${externalRoot}/worktrees/installed/gitdir`;
      const coldExternalFiles = jest.fn(() => Promise.resolve([externalFile]));
      const save = jest.spyOn(worker, 'saveJournal');
      const build = jest.spyOn(worker, 'build');
      const io: authorityHost.LinuxColdIO = {
        text: (file) => {
          if (file === '/proc/self/mountinfo')
            return Promise.resolve('10 0 8:1 / / rw - ext4 /dev/sda1 rw\n');
          return Promise.reject(new Error(`Unexpected proc read ${file}`));
        },
        entry: (file) =>
          Promise.resolve({
            dev: 2049n,
            ino:
              file === identity.source ? 1n : file === externalRoot ? 2n : 3n,
            mode:
              file === identity.source || file === externalRoot
                ? 0o040700n
                : 0o100600n,
            ctimeNs: 0n,
            mtimeNs: 0n,
          }),
        list: (file) =>
          Promise.resolve(
            file === identity.source ? ['preferences.json'] : ['one', 'two'],
          ),
        pin: () => Promise.reject(new Error('Unexpected pin')),
        identity: () => Promise.reject(new Error('Unexpected identity')),
        link: () => Promise.reject(new Error('Unexpected link')),
      };
      const linuxWorker: InternalRootMigrationWorker = {
        ...worker,
        os: 'linux',
        proveCold: async (_identity, externalFiles) => {
          expect(externalFiles).toEqual([externalFile]);
          try {
            await authorityHost.observeLinuxColdProcesses({
              io,
              uid: 1000,
              roots: [identity.source, externalRoot],
              census: { predictApplyPeak: true, entryCap: 4104 },
            });
          } catch (error) {
            throw new InternalRootMigrationRefused(
              'cold-proof-unavailable',
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      };
      const scopedRepairs = { ...repairs, coldExternalFiles };
      const result = await migrateInternalRoot(
        linuxWorker,
        identity,
        { apply: false, declareInternal: true },
        scopedRepairs,
      );
      const recovery: unknown = expect.stringContaining('cap=4104');
      expect(result).toMatchObject({
        kind: 'inventory',
        journal: null,
        coldProof: {
          kind: 'refused',
          reason: 'cold-proof-unavailable',
          recovery,
        },
      });
      await expect(
        migrateInternalRoot(linuxWorker, identity, apply, scopedRepairs),
      ).rejects.toMatchObject({ reason: 'cold-proof-unavailable' });
      expect(coldExternalFiles).toHaveBeenCalledTimes(2);
      expect(save).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(await worker.readJournal(identity)).toBeNull();
      expect(existsSync(identity.destination)).toBe(false);
    },
  );

  (windows ? test.skip : test).each([
    {
      resume: true,
      discover: true,
      settleSourceFirst: true,
      splitScope: false,
    },
    {
      resume: true,
      discover: false,
      settleSourceFirst: true,
      splitScope: false,
    },
    {
      resume: false,
      discover: false,
      settleSourceFirst: true,
      splitScope: false,
    },
    {
      resume: false,
      discover: false,
      settleSourceFirst: false,
      splitScope: false,
    },
    { resume: true, discover: true, settleSourceFirst: true, splitScope: true },
  ])(
    'Linux renews apply-peak admission before staging when external scope expands (resume=$resume, discover=$discover, settleSourceFirst=$settleSourceFirst, splitScope=$splitScope)',
    async ({ resume, discover, settleSourceFirst, splitScope }) => {
      await source();
      const externalRoot = join(home, 'repository', '.git');
      const externalFile = join(externalRoot, 'gitdir');
      await mkdir(externalRoot, { recursive: true });
      await writeFile(externalFile, 'retained external evidence');
      const priorRoot = join(home, 'prior-repository', '.git');
      const priorFile = join(priorRoot, 'gitdir');
      const priorFiles = splitScope ? [priorFile] : [];
      if (splitScope) {
        await mkdir(priorRoot, { recursive: true });
        await writeFile(priorFile, 'retained journaled evidence');
      }
      const inventory = await worker.inventory(identity);
      if (resume) {
        const release = await worker.coordinate(identity);
        try {
          await worker.saveJournal({
            version: 7,
            transactionId: worker.transactionId(),
            identity,
            internalDeclaration: true,
            phase: 'prepared',
            inventory,
            externalFiles: priorFiles,
            stagingRoot: worker.stagingRoot(identity),
            secureRelocation: 'pending',
          });
        } finally {
          await release();
        }
      }
      const journalPath = join(identity.coordination, 'journal.json');
      const before = resume ? await readFile(journalPath, 'utf8') : null;
      const roots = new Set([
        identity.source,
        identity.destination,
        identity.historicalSecure,
        identity.coordination,
        worker.stagingRoot(identity),
        externalRoot,
        ...(splitScope ? [priorRoot] : []),
      ]);
      const inodes = new Map<string, bigint>();
      const mounts =
        '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n11 10 0:1 / /proc rw - proc proc rw\n';
      const io: authorityHost.LinuxColdIO = {
        text: (file) =>
          Promise.resolve().then(() => {
            if (file.endsWith('/mountinfo')) return mounts;
            if (file === '/proc/sys/kernel/random/boot_id')
              return '01234567-0123-0123-0123-0123456789ab\n';
            if (file.endsWith('/status'))
              return 'Uid:\t1000\t1000\t1000\t1000\n';
            if (file.endsWith('/stat'))
              return `${process.pid} (node) S 1 ${Array(17).fill('0').join(' ')} 42 0\n`;
            throw new Error(`Unexpected proc read ${file}`);
          }),
        entry: (file) =>
          Promise.resolve().then(() => {
            const ino = inodes.get(file) ?? BigInt(inodes.size + 1);
            inodes.set(file, ino);
            return {
              dev: 2049n,
              ino,
              mode: roots.has(file) ? 0o040700n : 0o100600n,
              ctimeNs: 0n,
              mtimeNs: 0n,
            };
          }),
        list: (file) =>
          Promise.resolve().then(() => {
            if (file === '/proc' || file.endsWith('/task'))
              return [String(process.pid)];
            if (file === externalRoot || (splitScope && file === priorRoot))
              return Array.from(
                { length: splitScope ? 600 : 1000 },
                (_, index) => `entry-${index}`,
              );
            return ['entry'];
          }),
        pin: () => Promise.resolve({ dev: 2049n, ino: 999999n, mountId: '10' }),
        identity: () => Promise.resolve({ dev: 2049n, ino: 999999n }),
        link: (file) =>
          Promise.resolve().then(() => {
            const namespace = /\/ns\/(mnt|user|pid)$/.exec(file)?.[1];
            if (namespace) return `${namespace}:[123]`;
            if (file.endsWith('/exe')) return process.execPath;
            if (file.endsWith('/cwd') || file.endsWith('/root')) return '/';
            throw new Error(`Unexpected proc link ${file}`);
          }),
      };
      const observe = authorityHost.observeLinuxColdProcesses;
      const observation = jest
        .spyOn(authorityHost, 'observeLinuxColdProcesses')
        .mockImplementation((options) =>
          observe({
            ...options,
            io,
            uid: 1000,
            census: { ...options?.census, entryCap: 6000 },
          }),
        );
      const platform = jest
        .spyOn(hostPlatform, 'hostOperatingSystem')
        .mockReturnValue('linux');
      try {
        const nativeWorker = createInternalRootMigrationWorker({
          filesystemHost: host,
          ...filesystemOptions,
          recoverW5: recover,
          nativeColdHost: { kind: 'repository', root: home },
          executableBrands: [canopy],
        });
        // Exercise native admission, not the host-dependent Linux copy preflight.
        nativeWorker.inventory = (): ReturnType<
          InternalRootMigrationWorker['inventory']
        > => Promise.resolve(inventory);
        nativeWorker.space = (): ReturnType<
          InternalRootMigrationWorker['space']
        > => Promise.resolve({ requiredBytes: 0, availableBytes: 1 });
        if (splitScope) {
          // Each root fits alone; only the combined scope exceeds admission.
          await expect(
            nativeWorker.proveCold(identity, priorFiles),
          ).resolves.toBeUndefined();
          await expect(
            nativeWorker.proveCold(identity, [externalFile]),
          ).resolves.toBeUndefined();
        }
        const build = jest
          .spyOn(nativeWorker, 'build')
          .mockImplementation(() =>
            Promise.reject(
              new Error('Construction began before peak-capacity refusal'),
            ),
          );
        const expose = jest.spyOn(nativeWorker, 'exposeStaging');
        const save = jest.spyOn(nativeWorker, 'saveJournal');
        const scopedRepairs: InternalRootRepairs = {
          ...repairs,
          settleSourceFirst,
          coldExternalFiles: () =>
            Promise.resolve(discover ? [externalFile] : []),
          prepare: () =>
            Promise.resolve({ kind: 'ready', externalFiles: [externalFile] }),
        };
        const recovery: unknown = expect.stringContaining('cap=6000');
        await expect(
          migrateInternalRoot(nativeWorker, identity, apply, scopedRepairs),
        ).rejects.toMatchObject({
          reason: 'cold-proof-unavailable',
          recovery,
        });
        expect(build).not.toHaveBeenCalled();
        expect(expose).not.toHaveBeenCalled();
        expect(existsSync(nativeWorker.stagingRoot(identity))).toBe(false);
        expect(existsSync(join(identity.coordination, 'staging'))).toBe(false);
        expect(existsSync(identity.destination)).toBe(false);
        const journal = await worker.readJournal(identity);
        if (resume || settleSourceFirst)
          expect(journal?.phase).toBe('prepared');
        else expect(journal).toBeNull();
        if (before !== null)
          expect(await readFile(journalPath, 'utf8')).toBe(before);
        if (discover || !settleSourceFirst) {
          expect(save).not.toHaveBeenCalled();
          expect(recover).not.toHaveBeenCalled();
        } else expect(recover).toHaveBeenCalledTimes(1);
        expect(await readFile(externalFile, 'utf8')).toBe(
          'retained external evidence',
        );
        if (splitScope)
          expect(await readFile(priorFile, 'utf8')).toBe(
            'retained journaled evidence',
          );
        expect(
          await readFile(join(identity.source, 'preferences.json'), 'utf8'),
        ).toBe('{"theme":"dark"}');
      } finally {
        platform.mockRestore();
        observation.mockRestore();
      }
    },
  );

  (windows ? test.skip : test).each([
    { withSibling: false, relativeLinks: false, internalCommon: false },
    { withSibling: true, relativeLinks: false, internalCommon: false },
    { withSibling: true, relativeLinks: true, internalCommon: false },
    { withSibling: true, relativeLinks: true, internalCommon: true },
  ])(
    'Linux pre-journal Git census matches journaled backlink roots ($withSibling sibling, $relativeLinks relative, $internalCommon internal)',
    async ({ withSibling, relativeLinks, internalCommon }) => {
      await source();
      const repository = join(
        internalCommon ? identity.source : home,
        'repository',
      );
      const standalone = join(home, 'standalone');
      const installed = join(identity.source, 'checkout');
      const sibling = join(home, 'sibling');
      const git = async (
        cwd: string,
        args: readonly string[],
      ): Promise<string> =>
        (
          await promisify(execFile)('git', ['--no-optional-locks', ...args], {
            cwd,
          })
        ).stdout;
      for (const root of [repository, standalone]) {
        await mkdir(root);
        await git(root, ['init']);
        await git(root, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ]);
      }
      await git(repository, ['worktree', 'add', '-b', 'installed', installed]);
      if (withSibling)
        await git(repository, ['worktree', 'add', '-b', 'sibling', sibling]);
      const prunable = join(home, 'prunable');
      await git(repository, ['worktree', 'add', '-b', 'prunable', prunable]);
      await rm(prunable, { recursive: true });
      if (relativeLinks)
        for (const checkout of [installed, ...(withSibling ? [sibling] : [])]) {
          const admin = join(
            repository,
            '.git',
            'worktrees',
            basename(checkout),
          );
          const dotGit = join(checkout, '.git');
          await writeFile(dotGit, `gitdir: ${relative(checkout, admin)}\n`);
          await writeFile(
            join(admin, 'gitdir'),
            `${relative(admin, dotGit)}\n`,
          );
        }
      const metadata = join(identity.source, 'workspaces', 'fixture');
      await mkdir(metadata, { recursive: true });
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({ sourceRepoPath: standalone }),
      );
      const plan = await prepareRelocationGit(
        git,
        [repository, standalone, installed, ...(withSibling ? [sibling] : [])],
        { portableFilesystem: true },
      );
      const journaledFiles = plan.backlinks
        .map(({ path }) => path)
        .filter((file) => !isWithin(identity.source, file));
      const live = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      if (!live.coldExternalFiles) throw new Error('Missing cold Git scope');
      const files = await live.coldExternalFiles({
        identity,
        transactionId: 'fixture',
        inventory: await worker.inventory(identity),
        workingRoot: identity.source,
        externalFiles: [],
      });
      expect(new Set(files)).toEqual(new Set(journaledFiles));
      const observed: (readonly string[])[] = [];
      const observation = jest
        .spyOn(authorityHost, 'observeLinuxColdProcesses')
        .mockImplementation((options) => {
          observed.push(options?.roots ?? []);
          return Promise.reject(
            new InternalRootMigrationRefused(
              'cold-proof-unavailable',
              'fixture stopped after census root mapping',
            ),
          );
        });
      const platform = jest
        .spyOn(hostPlatform, 'hostOperatingSystem')
        .mockReturnValue('linux');
      try {
        const nativeWorker = createInternalRootMigrationWorker({
          filesystemHost: host,
          recoverW5: recover,
          nativeColdHost: { kind: 'repository', root: home },
        });
        for (const externalFiles of [files, journaledFiles])
          await expect(
            nativeWorker.proveCold(identity, externalFiles),
          ).rejects.toThrow('fixture stopped after census root mapping');
        const [before, after] = observed;
        expect(new Set(before)).toEqual(new Set(after));
        if (internalCommon)
          expect(before).not.toContain(join(repository, '.git'));
        else expect(before).toContain(join(repository, '.git'));
        expect(before).not.toContain(repository);
        expect(before).not.toContain(standalone);
        expect(before).not.toContain(join(standalone, '.git'));
        expect(before).not.toContain(prunable);
        if (withSibling) expect(before).toContain(sibling);
        else expect(before).not.toContain(sibling);
      } finally {
        platform.mockRestore();
        observation.mockRestore();
      }
    },
  );

  (windows ? test.skip : test).each([
    'unindexed',
    'indexed',
    'unreadable index',
    'pending owner',
    'malformed link',
    'linked admin directory',
    'mismatched backlink',
  ])(
    'Linux Git hint respects canonical workspace membership in peak prediction: %s',
    async (scenario) => {
      await source();
      const checkout = join(home, 'unrelated-checkout');
      const common = join(home, 'repository/.git');
      const admin = join(common, 'worktrees/external');
      await mkdir(checkout);
      await mkdir(admin, { recursive: true });
      if (scenario === 'linked admin directory') {
        await mkdir(join(checkout, '.git'));
        await writeFile(join(checkout, '.git/commondir'), `${common}\n`);
      } else
        await writeFile(
          join(checkout, '.git'),
          scenario === 'malformed link' ? 'opaque\0' : `gitdir: ${admin}\n`,
        );
      await writeFile(join(admin, 'commondir'), '../..\n');
      await writeFile(
        join(admin, 'gitdir'),
        `${join(checkout, scenario === 'mismatched backlink' ? 'other' : '.git')}\n`,
      );
      const metadata = join(identity.source, 'workspaces/fixture');
      await mkdir(metadata, { recursive: true });
      const manifest = JSON.stringify({ version: 1, repoPath: checkout });
      await writeFile(join(metadata, 'workspace.json'), manifest);
      if (scenario === 'unindexed') {
        await mkdir(join(metadata, 'checkout'));
        await writeFile(join(metadata, 'checkout/.git'), `gitdir: ${admin}\n`);
      }
      await writeFile(
        join(identity.source, 'workspaces/index.json'),
        scenario === 'unreadable index'
          ? '{partial W5 image'
          : JSON.stringify({
              version: 1,
              workspaces:
                scenario === 'unindexed'
                  ? []
                  : [
                      {
                        id: 'fixture',
                        name: 'Fixture',
                        type: 'single-repo',
                        color: 'blue',
                      },
                    ],
            }),
      );
      if (scenario === 'pending owner') {
        await mkdir(join(identity.source, 'w5'));
        const log = W5CommitLog.open(
          join(identity.source, 'w5/commit-log.sqlite'),
        );
        try {
          log.commit({
            operation: 'fixture.pending-owner',
            advance: [{ kind: 'workspace', workspaceId: 'fixture' }],
            files: [
              {
                path: join(metadata, 'workspace.json'),
                previousFingerprint: null,
                contents: manifest,
              },
            ],
            outcome: {},
          });
        } finally {
          log.close();
        }
      }
      const live = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const proof = jest.fn((): Promise<void> => Promise.resolve());
      const warning = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const result = await migrateInternalRoot(
          { ...worker, os: 'linux', proveCold: proof },
          identity,
          { apply: false, declareInternal: true },
          {
            ...repairs,
            coldExternalFiles: (context) => {
              if (!live.coldExternalFiles) throw new Error('Missing Git scope');
              return live.coldExternalFiles(context);
            },
          },
        );
        expect(result).toMatchObject({ kind: 'inventory', journal: null });
        expect(proof).toHaveBeenCalledTimes(1);
        if (scenario === 'indexed') {
          expect(proof).toHaveBeenCalledWith(
            identity,
            expect.arrayContaining([
              join(checkout, '.git'),
              join(admin, 'gitdir'),
              join(admin, 'commondir'),
            ]),
          );
        } else {
          expect(proof).toHaveBeenCalledWith(identity, []);
        }
        if (scenario === 'indexed' || scenario === 'unindexed')
          expect(warning).not.toHaveBeenCalled();
        else
          expect(warning.mock.calls.flat().join('')).toContain('lower bound');
        expect(await readFile(join(metadata, 'workspace.json'), 'utf8')).toBe(
          manifest,
        );
        expect(await worker.readJournal(identity)).toBeNull();
        expect(existsSync(worker.stagingRoot(identity))).toBe(false);
        expect(recover).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    },
  );

  (windows ? test.skip : test)(
    'Linux scope skips unsettled current/pending owner hints without freezing owners or writing source evidence',
    async () => {
      await source();
      const physicalRepo = join(home, 'physical');
      const currentRepo = join(home, 'current');
      const pendingRepo = join(home, 'pending');
      const repositories = [physicalRepo, currentRepo, pendingRepo];
      const physical = join(identity.source, 'checkout');
      const expectedFiles: string[] = [];
      for (const repository of repositories) {
        const admin = join(repository, '.git', 'worktrees', 'installed');
        const checkout =
          repository === physicalRepo
            ? physical
            : join(home, `${basename(repository)}-linked`);
        await mkdir(admin, { recursive: true });
        await mkdir(checkout);
        const dotGit = join(checkout, '.git');
        await writeFile(dotGit, `gitdir: ${admin}\n`);
        await writeFile(join(admin, 'gitdir'), `${dotGit}\n`);
        await writeFile(join(admin, 'commondir'), '../..\n');
        if (repository === physicalRepo)
          expectedFiles.push(join(admin, 'gitdir'), join(admin, 'commondir'));
      }
      const metadata = join(identity.source, 'workspaces', 'fixture');
      await mkdir(metadata, { recursive: true });
      await writeFile(
        join(identity.source, 'workspaces', 'index.json'),
        '{partial W5 image',
      );
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({ sourceRepoPath: currentRepo }),
      );
      await mkdir(join(identity.source, 'w5'));
      const log = W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      try {
        log.commit({
          operation: 'fixture.pending-owner',
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: join(metadata, 'workspace.json'),
              previousFingerprint: null,
              contents: JSON.stringify({ repos: [{ repoPath: pendingRepo }] }),
            },
          ],
          outcome: {},
        });
      } finally {
        log.close();
      }
      const live = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const before = await worker.inventory(identity);
      const logBefore = await readFile(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      const prepare = jest.fn(() => {
        expect(recover).toHaveBeenCalledTimes(1);
        return Promise.reject(
          new Error('reached preparation after W5 recovery'),
        );
      });
      const proof = jest.fn(
        (_identity: InternalRootIdentity, files?: readonly string[]) => {
          if (!recover.mock.calls.length)
            expect(new Set(files)).toEqual(new Set(expectedFiles));
          return Promise.resolve();
        },
      );
      const linux = { ...worker, os: 'linux' as const, proveCold: proof };
      const selected = { ...live, prepare };
      const result = await migrateInternalRoot(
        linux,
        identity,
        { apply: false, declareInternal: true },
        selected,
      );
      expect(result).toMatchObject({
        kind: 'inventory',
        journal: null,
        coldProof: { kind: 'ready' },
      });
      expect(await worker.inventory(identity)).toEqual(before);
      expect(
        await readFile(join(identity.source, 'w5', 'commit-log.sqlite')),
      ).toEqual(logBefore);
      expect(recover).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        migrateInternalRoot(linux, identity, apply, selected),
      ).rejects.toThrow('reached preparation after W5 recovery');
      expect(prepare).toHaveBeenCalledTimes(1);
      expect((await worker.readJournal(identity))?.phase).toBe('prepared');
    },
  );

  (windows ? test.skip : test).each([
    'opaque W5',
    'abandoned retained checkout',
    'abandoned quarantine',
    'malformed external link',
  ])(
    'Linux Git scope is a lower-bound hint without excluding census entries: %s',
    async (scenario) => {
      await source();
      const abandoned = scenario.startsWith('abandoned');
      if (abandoned)
        await strandedArchiveFixture(identity.source, 'P0', 'crow');
      const malformed =
        scenario === 'opaque W5'
          ? join(identity.source, 'w5/.git')
          : abandoned
            ? join(
                identity.source,
                'workspaces/fixture/worktrees',
                scenario === 'abandoned quarantine'
                  ? '.crow.archive-quarantine'
                  : 'crow',
                '.git',
              )
            : join(home, 'external/.git');
      await mkdir(dirname(malformed), { recursive: true });
      const bytes = Buffer.from('Opaque history\u0000');
      await writeFile(malformed, bytes);
      if (scenario === 'malformed external link') {
        const metadata = join(identity.source, 'workspaces/fixture');
        await mkdir(metadata, { recursive: true });
        await writeFile(
          join(identity.source, 'workspaces/index.json'),
          JSON.stringify({
            version: 1,
            workspaces: [
              {
                id: 'fixture',
                name: 'Fixture',
                type: 'single-repo',
                color: 'blue',
              },
            ],
          }),
        );
        await writeFile(
          join(metadata, 'workspace.json'),
          JSON.stringify({ version: 1, repoPath: dirname(malformed) }),
        );
      }
      // A broken hint must not discard other discoverable external roots.
      const checkout = join(identity.source, 'valid-checkout');
      const admin = join(home, 'valid/.git/worktrees/installed');
      await mkdir(checkout);
      await mkdir(admin, { recursive: true });
      await writeFile(join(checkout, '.git'), `gitdir: ${admin}\n`);
      await writeFile(join(admin, 'commondir'), '../..\n');
      await writeFile(join(admin, 'gitdir'), `${join(checkout, '.git')}\n`);
      const tree = new Map<string, { ino: bigint; names: string[] | null }>();
      async function snapshot(file: string): Promise<void> {
        const state = await lstat(file);
        const names = state.isDirectory() ? await readdir(file) : null;
        tree.set(file, { ino: BigInt(tree.size + 1), names });
        for (const name of names ?? []) await snapshot(join(file, name));
      }
      await snapshot(identity.source);
      const counted = new Map<string, number>();
      const mounts =
        '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n11 10 0:1 / /proc rw - proc proc rw\n';
      const io: authorityHost.LinuxColdIO = {
        text: (file) => {
          if (file.endsWith('/mountinfo')) return Promise.resolve(mounts);
          if (file === '/proc/sys/kernel/random/boot_id')
            return Promise.resolve('01234567-0123-0123-0123-0123456789ab\n');
          if (file.endsWith('/status'))
            return Promise.resolve('Uid:\t1000\t1000\t1000\t1000\n');
          if (file.endsWith('/stat'))
            return Promise.resolve(
              `${process.pid} (node) S 1 ${Array(17).fill('0').join(' ')} 42 0\n`,
            );
          return Promise.reject(new Error(`Unexpected proc read ${file}`));
        },
        entry: (file) => {
          const entry = tree.get(file);
          if (!entry) return Promise.reject(new Error(`Missing entry ${file}`));
          counted.set(file, (counted.get(file) ?? 0) + 1);
          return Promise.resolve({
            dev: 2049n,
            ino: entry.ino,
            mode: entry.names === null ? 0o100600n : 0o040700n,
            ctimeNs: 0n,
            mtimeNs: 0n,
          });
        },
        list: (file) =>
          Promise.resolve(
            tree.get(file)?.names ??
              (file === '/proc' || file.endsWith('/task')
                ? [String(process.pid)]
                : ['entry']),
          ),
        pin: () => Promise.resolve({ dev: 2049n, ino: 999999n, mountId: '10' }),
        identity: () => Promise.resolve({ dev: 2049n, ino: 999999n }),
        link: (file) => {
          const namespace = /\/ns\/(mnt|user|pid)$/.exec(file)?.[1];
          if (namespace) return Promise.resolve(`${namespace}:[123]`);
          if (file.endsWith('/exe')) return Promise.resolve(process.execPath);
          if (file.endsWith('/cwd') || file.endsWith('/root'))
            return Promise.resolve('/');
          return Promise.reject(new Error(`Unexpected proc link ${file}`));
        },
      };
      const warning = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        for (const selected of abandoned ? [false, true] : [false]) {
          counted.clear();
          const live = createInternalRootRelocationRepairs({
            ...nativeRepairOptions(),
            durability: desktopW5Durability,
            abandonArchives: selected ? ['fixture/crow'] : [],
          });
          const proof = jest.fn(async (): Promise<void> => {
            await authorityHost.observeLinuxColdProcesses({
              io,
              uid: 1000,
              roots: [identity.source],
              census: { predictApplyPeak: true },
            });
          });
          const result = await migrateInternalRoot(
            { ...worker, os: 'linux', proveCold: proof },
            identity,
            { apply: false, declareInternal: true },
            {
              ...repairs,
              coldExternalFiles: (context) => {
                if (!live.coldExternalFiles)
                  throw new Error('Missing Git scope');
                return live.coldExternalFiles(context);
              },
            },
          );
          expect(result).toMatchObject({
            kind: 'inventory',
            journal: null,
            coldProof: { kind: 'ready' },
          });
          expect(proof).toHaveBeenCalledWith(
            identity,
            expect.arrayContaining([
              join(admin, 'gitdir'),
              join(admin, 'commondir'),
            ]),
          );
          for (const file of tree.keys())
            expect(counted.get(file)).toBeGreaterThanOrEqual(2);
        }
        if (scenario === 'malformed external link')
          expect(warning.mock.calls.flat().join('')).toContain('lower bound');
        else expect(warning).not.toHaveBeenCalled();
        expect(await readFile(malformed)).toEqual(bytes);
        expect(await worker.readJournal(identity)).toBeNull();
        expect(existsSync(worker.stagingRoot(identity))).toBe(false);
        if (scenario === 'malformed external link') {
          const externalAdmin = join(
            home,
            'external-admin/.git/worktrees/linked',
          );
          await mkdir(externalAdmin, { recursive: true });
          await writeFile(malformed, `gitdir: ${externalAdmin}\n`);
          await writeFile(join(externalAdmin, 'commondir'), '../..\n');
          await writeFile(join(externalAdmin, 'gitdir'), `${malformed}\n`);
          warning.mockClear();
          const live = createInternalRootRelocationRepairs({
            ...nativeRepairOptions(),
            durability: desktopW5Durability,
          });
          if (!live.coldExternalFiles) throw new Error('Missing Git scope');
          const files = await live.coldExternalFiles({
            identity,
            transactionId: 'fixture',
            inventory: await worker.inventory(identity),
            workingRoot: identity.source,
            externalFiles: [],
          });
          expect(files).toEqual(
            expect.arrayContaining([
              malformed,
              join(externalAdmin, 'gitdir'),
              join(externalAdmin, 'commondir'),
            ]),
          );
          expect(warning).not.toHaveBeenCalled();
        }
      } finally {
        warning.mockRestore();
      }
    },
  );

  test('rollback sidecar without its log refuses inventory and settlement', async () => {
    await source();
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    const sidecar = join(identity.source, 'w5/commit-log.sqlite-journal');
    await writeFile(sidecar, 'rollback evidence');
    expect(
      (await diagnoseInternalRootW5(identity.source)).join('\n'),
    ).toContain('W5 history exists without its log: commit-log.sqlite-journal');
    await expect(
      fixtureW5(identity.source, 'unused-worker', {
        identity,
        transactionId: 'rollback-fixture',
        assertHeld: () => Promise.resolve(),
      }),
    ).rejects.toThrow('W5 history exists without its log');
    expect(await readFile(sidecar, 'utf8')).toBe('rollback evidence');
    expect(
      await statIfPresent(join(identity.source, 'w5/commit-log.sqlite')),
    ).toBeNull();
  });

  test('inventory retains proven Git groups with hardlinked objects, shadows and absent worktree rows', async () => {
    await source();
    const repository = join(identity.source, 'repos/managed');
    const shadow = join(identity.source, 'repo-shadows/key/checkout');
    const absent = join(identity.source, 'worktrees/fixture/gone');
    const metadata = join(identity.source, 'workspaces/fixture');
    await mkdir(repository, { recursive: true });
    await mkdir(metadata, { recursive: true });
    const git = async (...args: string[]): Promise<string> =>
      (
        await promisify(execFile)('git', ['--no-optional-locks', ...args], {
          cwd: repository,
        })
      ).stdout;
    await git('init');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    await git('worktree', 'add', '--detach', shadow);
    await git('worktree', 'add', '-b', 'gone', absent);
    await git('worktree', 'remove', absent);
    const unreferenced = join(identity.source, 'repos/unreferenced');
    await mkdir(unreferenced);
    await promisify(execFile)('git', ['init', unreferenced]);
    const head = (await git('rev-parse', 'HEAD')).trim();
    const object = join(
      repository,
      '.git/objects',
      head.slice(0, 2),
      head.slice(2),
    );
    const externalObject = join(home, 'external-clone-object');
    await link(object, externalObject);
    const bytes = await readFile(object);
    await writeFile(
      join(identity.source, 'workspaces/index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'fixture',
            name: 'Fixture',
            type: 'single-repo',
            color: 'blue',
          },
        ],
      }),
    );
    await writeFile(
      join(metadata, 'workspace.json'),
      JSON.stringify({ version: 1, id: 'fixture', repoPath: repository }),
    );
    const list = JSON.stringify({
      version: 1,
      worktrees: [{ id: 'gone', branchName: 'gone', createdAt: 'today' }],
    });
    await writeFile(join(metadata, 'worktrees.json'), list);
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    worker.diagnose = diagnoseInternalRootW5;
    const before = await worker.inventory(identity);
    const result = await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    if (result.kind !== 'inventory') throw new Error('Expected inventory');
    expect(result.preflight).toEqual({ kind: 'ready', blockers: [] });
    expect(await worker.inventory(identity)).toEqual(before);
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await readFile(
        join(identity.destination, relative(identity.source, object)),
      ),
    ).toEqual(bytes);
    expect(
      (
        await lstat(
          join(identity.destination, relative(identity.source, object)),
        )
      ).nlink,
    ).toBe(1);
    expect((await lstat(object)).nlink).toBe(2);
    expect(await readFile(externalObject)).toEqual(bytes);
    expect(
      await readFile(
        join(identity.source, 'workspaces/fixture/worktrees.json'),
        'utf8',
      ),
    ).toBe(list);
    expect(
      JSON.parse(
        await readFile(
          join(identity.destination, 'workspaces/fixture/worktrees.json'),
          'utf8',
        ),
      ),
    ).toEqual(JSON.parse(list));
  });

  test('unproven repository refusal names workspace, field and relative path', async () => {
    await source();
    const metadata = join(identity.source, 'workspaces/fixture');
    await mkdir(metadata, { recursive: true });
    await writeFile(
      join(identity.source, 'workspaces/index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'fixture',
            name: 'Fixture',
            type: 'single-repo',
            color: 'blue',
          },
        ],
      }),
    );
    await writeFile(
      join(metadata, 'workspace.json'),
      JSON.stringify({
        version: 1,
        id: 'fixture',
        repoPath: join(identity.source, 'repos/missing'),
      }),
    );
    await writeFile(
      join(metadata, 'worktrees.json'),
      '{"version":1,"worktrees":[]}',
    );
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const result = await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    if (result.kind !== 'inventory') throw new Error('Expected inventory');
    expect(result.preflight.blockers).toContain(
      `Installation relocation refused: unproven-repository-path (workspace="fixture" field=repoPath path=${JSON.stringify(join('repos', 'missing'))})`,
    );
    await expect(run()).rejects.toThrow('workspace="fixture" field=repoPath');
  });

  async function schemaFixture(version: number): Promise<string> {
    await source();
    await mkdir(join(identity.source, 'workspaces'), { mode: 0o700 });
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    await writeFile(
      join(identity.source, 'workspaces/index.json'),
      '{"version":1,"workspaces":[]}',
    );
    const path = join(identity.source, 'w5/commit-log.sqlite');
    const log = W5CommitLog.open(path);
    try {
      const decision = log.commit({
        operation: 'fixture.applied-history',
        advance: [],
        files: [
          {
            path: join(identity.source, 'workspaces/index.json'),
            contents: '{"version":1,"workspaces":[]}',
            previousFingerprint: null,
          },
        ],
        outcome: {},
      });
      if (decision.status !== 'committed') throw new Error('Expected commit');
      log.markApplied(decision.commitId);
    } finally {
      log.close();
    }
    const db = new DatabaseSync(path);
    try {
      if (version === 1 || version === 2 || version === 3) {
        db.exec(
          'DROP INDEX w5_workspace_identity; ALTER TABLE w5_reservations DROP COLUMN workspace_identity; DROP TABLE w5_legacy_workspace_claims',
        );
        if (version === 1 || version === 2) {
          for (const trigger of [
            'w5_file_chains_insert',
            'w5_file_chains_delete',
            'w5_file_chains_update',
            'w5_commit_totals_insert',
            'w5_commit_totals_delete',
          ])
            db.exec(`DROP TRIGGER ${trigger}`);
          db.exec('DROP TABLE w5_file_chains; DROP TABLE w5_commit_totals');
        }
      }
      if (version === 1) {
        // v1 retained applied contents; its upgrader derives the fingerprint.
        db.prepare('UPDATE w5_commit_files SET contents = ?').run(
          await readFile(
            join(identity.source, 'workspaces/index.json'),
            'utf8',
          ),
        );
        db.exec(
          'DROP INDEX w5_commits_to_compact; ALTER TABLE w5_commits DROP COLUMN completed_at; ALTER TABLE w5_commits DROP COLUMN outcome_expired; ALTER TABLE w5_commit_files DROP COLUMN new_fingerprint',
        );
      }
      db.prepare(
        "UPDATE w5_meta SET value = ? WHERE key = 'schema_version'",
      ).run(String(version));
    } finally {
      db.close();
    }
    return path;
  }

  test.each([1, 2, 3, 4, 99, 0])(
    'inventory previews schema %s without changing the source',
    async (version) => {
      const path = await schemaFixture(version);
      const before = await readFile(path);
      expect((await diagnoseW5State(identity.source)).logIssue).toBe(
        version === 4 ? null : 'incompatible-schema',
      );
      const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const blockers = await diagnoseInternalRootW5(identity.source);
        expect(blockers).toEqual(
          [1, 2, 3, 4].includes(version) ? [] : ['W5 log: incompatible-schema'],
        );
        if ([1, 2, 3].includes(version))
          expect(
            stderr.mock.calls.some(
              ([line]) =>
                typeof line === 'string' &&
                line.includes(`schema v${version} will be upgraded to v4`),
            ),
          ).toBe(true);
        else expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
      expect(await readFile(path)).toEqual(before);
    },
  );

  test.each([1, 2, 3])(
    'settlement upgrades schema %s before recovery and resumes migration',
    async (version) => {
      await schemaFixture(version);
      await lifecycleFixture('completed');
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      worker.recoverW5 = async (journal): Promise<void> => {
        await fixtureW5(identity.source, entry, {
          identity,
          transactionId: journal.transactionId,
          assertHeld: () => Promise.resolve(),
        });
      };
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect((await diagnoseW5State(identity.source)).logIssue).toBeNull();
      const db = new DatabaseSync(
        join(identity.source, 'w5/commit-log.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              'SELECT operation, state FROM w5_commits WHERE commit_id = 1',
            )
            .get(),
        ).toMatchObject({
          operation: 'fixture.applied-history',
          state: 'applied',
        });
      } finally {
        db.close();
      }
    },
  );

  test.each([0, 99, 'corrupt'])(
    'settlement refuses unsupported or corrupt schema %s before starting a writer',
    async (version) => {
      const path = await schemaFixture(
        typeof version === 'number' ? version : 4,
      );
      if (version === 'corrupt') await writeFile(path, 'not a SQLite database');
      const before = await readFile(path);
      expect(await diagnoseInternalRootW5(identity.source)).toContain(
        `W5 log: ${version === 'corrupt' ? 'unavailable' : 'incompatible-schema'}`,
      );
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      const started = startedWorkers.length;
      await expect(
        fixtureW5(identity.source, entry, {
          identity,
          transactionId: 'unsupported-schema-fixture',
          assertHeld: () => Promise.resolve(),
        }),
      ).rejects.toThrow('log-unavailable');
      expect(startedWorkers).toHaveLength(started);
      expect(await readFile(path)).toEqual(before);
    },
  );

  test('inventory refuses a hot rollback journal without recovering the source', async () => {
    const path = await schemaFixture(2);
    execFileSync(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE');
       db.exec('CREATE TABLE spill(data TEXT); INSERT INTO spill VALUES (hex(zeroblob(1000000)))');
       process.exit(0);`,
      path,
    ]);
    const before = await readFile(path);
    const rollback = await readFile(`${path}-journal`);
    expect(rollback.subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7');
    expect(await diagnoseInternalRootW5(identity.source)).toContain(
      'W5 log: unavailable',
    );
    expect(await readFile(path)).toEqual(before);
    expect(await readFile(`${path}-journal`)).toEqual(rollback);
  });

  test('schema-v2 inventory still names pending commits and reservations', async () => {
    const path = await schemaFixture(2);
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE w5_commits SET state = 'committed' WHERE commit_id = 1",
      ).run();
      db.prepare(
        'INSERT INTO w5_reservations (reservation_id, operation, state, diagnostics_json, reserved_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        'pending-fixture',
        'core.worktree.create',
        'reserved',
        '{}',
        'today',
      );
    } finally {
      db.close();
    }
    const before = await readFile(path);
    expect(await diagnoseInternalRootW5(identity.source)).toEqual([
      'W5 pending commit 1: fixture.applied-history state=committed paths=["workspaces/index.json"] reason="not recorded"',
      'W5 reservation pending-fixture: core.worktree.create state=reserved',
    ]);
    expect(await readFile(path)).toEqual(before);
  });

  test('inventory prints every pending commit even when the summary is bounded', async () => {
    await source();
    await createPrivateMigrationDirectory(join(identity.source, 'w5'), host);
    const log = W5CommitLog.open(join(identity.source, 'w5/commit-log.sqlite'));
    const ids: number[] = [];
    try {
      for (let i = 0; i < 45; i++) {
        const { commitId } = log.commit({
          operation: 'w5.worktree_list.write',
          advance: [],
          files: [],
          outcome: {},
        });
        log.markCommitRecoveryRequired(commitId, { error: 'ENOSPC' });
        ids.push(commitId);
      }
    } finally {
      log.close();
    }
    const output = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await diagnoseInternalRootW5(identity.source);
      const details = output.mock.calls.map(([text]) => String(text)).join('');
      for (const id of ids)
        expect(details).toContain(`--abandon-commit ${id}\n`);
    } finally {
      output.mockRestore();
    }
  });

  test('inventory refuses a schema-v2 log whose upgrade cannot complete', async () => {
    const path = await schemaFixture(2);
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE w5_commit_files');
    } finally {
      db.close();
    }
    const before = await readFile(path);
    expect(await diagnoseInternalRootW5(identity.source)).toContain(
      'W5 log: unavailable',
    );
    expect(await readFile(path)).toEqual(before);
  });

  test('inventory refuses missing unindexed metadata log mismatches', async () => {
    await source();
    await mkdir(join(identity.source, 'workspaces'), { mode: 0o700 });
    await writeFile(
      join(identity.source, 'workspaces/index.json'),
      '{"version":1,"workspaces":[]}',
    );
    const path = join(identity.source, 'workspaces/removed/workspace.json');
    const log = W5CommitLog.open(join(identity.source, 'w5/commit-log.sqlite'));
    try {
      const decision = log.commit({
        operation: 'fixture',
        advance: [],
        files: [{ path, contents: '{"version":1}', previousFingerprint: null }],
        outcome: {},
      });
      if (decision.status !== 'committed') throw new Error('Expected commit');
      log.markApplied(decision.commitId);
    } finally {
      log.close();
    }
    expect(await diagnoseInternalRootW5(identity.source)).toContain(
      'log-mismatch: removed/workspace.json',
    );
  });

  test('inventory aggregates W5, lifecycle, Git and cold blockers without writing any migration state', async () => {
    await source();
    await mkdir(join(identity.source, 'workspaces'), { recursive: true });
    await writeFile(
      join(identity.source, 'workspaces/index.json'),
      '{"version":1,"workspaces":[]}',
    );
    await mkdir(join(identity.source, 'w5'), { recursive: true });
    const log = W5CommitLog.open(join(identity.source, 'w5/commit-log.sqlite'));
    try {
      log.reserve({
        reservationId: 'uncertain-inventory',
        operation: 'core.worktree.create',
        diagnostics: null,
      });
    } finally {
      log.close();
    }
    const history = await lifecycleFixture('active');
    for (const name of ['broken-one', 'broken-two']) {
      const path = join(identity.source, 'repos', name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, '.git'), 'invalid Git metadata');
    }
    const before = await worker.inventory(identity);
    worker.diagnose = diagnoseInternalRootW5;
    worker.proveCold = (): Promise<void> =>
      Promise.reject(
        new InternalRootMigrationRefused(
          'writer-active',
          'fixture live writer',
        ),
      );
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const result = await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    if (result.kind !== 'inventory') throw new Error('Expected inventory');
    expect(result.preflight.kind).toBe('refused');
    expect(result.preflight.blockers.join('\n')).toContain(
      'uncertain-inventory',
    );
    expect(result.preflight.blockers.join('\n')).toContain('state=active');
    expect(result.preflight.blockers.join('\n')).toContain(
      'fixture live writer',
    );
    for (const name of ['broken-one', 'broken-two'])
      expect(result.preflight.blockers.join('\n')).toContain(name);
    expect(await worker.inventory(identity)).toEqual(before);
    expect(await readFile(history.path, 'utf8')).toBe(history.bytes);
    expect(await worker.readJournal(identity)).toBeNull();
    expect(await statIfPresent(identity.coordination)).toBeNull();
    expect(await statIfPresent(identity.destination)).toBeNull();
    worker.proveCold = (): Promise<void> => Promise.resolve();
    worker.recoverW5 = (): Promise<void> =>
      Promise.reject(new Error('prepared inventory fixture'));
    await expect(run()).rejects.toThrow('prepared inventory fixture');
    const saved = await readFile(join(identity.coordination, 'journal.json'));
    const entries = await readdir(identity.coordination);
    const sourceBefore = await worker.inventory(identity);
    await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      saved,
    );
    expect(await readdir(identity.coordination)).toEqual(entries);
    expect(await worker.inventory(identity)).toEqual(sourceBefore);
    expect(await statIfPresent(identity.destination)).toBeNull();
  });

  fileSymlinkFixture(
    'carries relative and external links, projects source absolute links and resumes a building v7 plan with staging',
    async () => {
      await source();
      const repository = join(identity.source, 'repos/canopy');
      const linked = join(identity.source, 'repo-shadows/fixture/checkout');
      const cowork = join(identity.source, 'workspaces/cowork-default/home');
      const advisor = join(identity.source, 'app-workspaces/app-advisor/home');
      for (const path of [repository, cowork, advisor])
        await mkdir(path, { recursive: true });
      const git = async (...args: string[]): Promise<string> =>
        (
          await promisify(execFile)('git', ['--no-optional-locks', ...args], {
            cwd: repository,
          })
        ).stdout;
      await git('init');
      await writeFile(join(repository, 'CLAUDE.md'), 'repository instructions');
      await mkdir(join(repository, 'packages/desktop-shared/src'), {
        recursive: true,
      });
      await mkdir(join(repository, 'apps/fixture-cli'), { recursive: true });
      await symlink('CLAUDE.md', join(repository, 'AGENTS.md'));
      await symlink('src', join(repository, 'packages/desktop-shared/shared'));
      await symlink(
        '../../packages/desktop-shared/src',
        join(repository, 'apps/fixture-cli/shared'),
      );
      await git('add', '.');
      await git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      await git('worktree', 'add', '-b', 'shadow', linked);
      // Empty directories are not tracked by Git.
      await mkdir(join(linked, 'packages/desktop-shared/src'), {
        recursive: true,
      });
      await symlink('CLAUDE.md', join(cowork, 'AGENTS.md'));
      await symlink('CLAUDE.md', join(advisor, 'AGENTS.md'));
      const external = join(home, 'user-codex/memories_1.sqlite-shm');
      await mkdir(dirname(external), { recursive: true });
      await writeFile(external, 'user-owned bytes');
      const legacyExternalTarget = join(home, 'user-skills');
      await symlink(join(home, 'user-managed-skills'), legacyExternalTarget);
      const codexHome = join(
        identity.source,
        'chat-plugins/app-advisor/global/__codex-homes__/fixture',
      );
      const opaque = join(identity.source, 'workspaces/unindexed/home');
      await mkdir(codexHome, { recursive: true });
      await mkdir(opaque, { recursive: true });
      const absoluteLinks = [
        { path: join(codexHome, 'memories_1.sqlite-shm'), target: external },
        {
          path: join(codexHome, 'legacy-skills'),
          target: legacyExternalTarget,
        },
        {
          path: join(codexHome, 'skills'),
          target: join(home, 'absent-user-skills'),
        },
        {
          path: join(codexHome, 'linear'),
          target: join(identity.source, 'plugin-cache/linear/local'),
        },
        ...[cowork, repository, linked, opaque].map((directory) => ({
          path: join(directory, 'absolute-instructions'),
          target: join(
            identity.source,
            'app-workspaces/app-advisor/home/CLAUDE.md',
          ),
        })),
      ];
      for (const image of absoluteLinks)
        await symlink(image.target, image.path);

      await writeFile(
        join(identity.source, 'workspaces/index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: 'cowork-default',
              name: 'Cowork',
              color: 'blue',
              type: 'cowork',
            },
          ],
        }),
      );
      await writeFile(
        join(dirname(cowork), 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'cowork-default',
          folderPath: cowork,
        }),
      );
      const history = await lifecycleFixture(
        'completed',
        'worktree-archive',
        true,
        true,
      );
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const sourceBefore = await worker.inventory(identity);
      worker.diagnose = diagnoseInternalRootW5;
      const inventory = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      expect(inventory).toMatchObject({
        kind: 'inventory',
        preflight: { kind: 'ready', blockers: [] },
      });
      expect(await worker.inventory(identity)).toEqual(sourceBefore);
      expect(await statIfPresent(identity.coordination)).toBeNull();
      const unsafe = join(repository, 'old-root-link');
      await symlink(
        relative(
          join(identity.destination, 'repos/canopy'),
          join(identity.source, 'preferences.json'),
        ),
        unsafe,
      );
      const unsafeInventory = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      if (unsafeInventory.kind !== 'inventory')
        throw new Error('Expected inventory');
      expect(unsafeInventory.preflight.kind).toBe('refused');
      expect(unsafeInventory.preflight.blockers.join('\n')).toContain(
        'repos/canopy/old-root-link',
      );
      await rm(unsafe);
      const repair = repairs.repair.bind(repairs);
      repairs.repair = async (
        context,
      ): ReturnType<InternalRootRepairs['repair']> => {
        if (!context.repairPlan) throw new Error('Missing plan');
        // Reproduce the old runner's exact link proof, not an arbitrary interruption.
        await assertRelocationOwnedPathsSafe(
          context.repairPlan.transition,
          context.repairPlan.ownedPaths,
          context.workingRoot,
        );
        return repair(context);
      };
      await expect(run()).rejects.toThrow('unproven-owned-link-target');
      const prior = await readFixtureJournal(identity);
      expect(prior).toMatchObject({
        version: 7,
        phase: 'building',
        secureRelocation: 'pending',
      });
      if (!prior?.repairPlan) throw new Error('Missing frozen plan');
      expect(await statIfPresent(prior.stagingRoot)).not.toBeNull();
      // The previous runner did not enumerate links inside checkouts, and omitted dangling targets.
      const legacyPlan = {
        ...prior.repairPlan,
        ownedPaths: [
          ...prior.repairPlan.ownedPaths.filter(
            (path) =>
              path === repository ||
              path === linked ||
              (!isWithin(repository, path) && !isWithin(linked, path)),
          ),
          legacyExternalTarget,
        ],
      };
      await worker.saveJournal({ ...prior, repairPlan: legacyPlan });
      repairs.repair = async (
        context,
      ): ReturnType<InternalRootRepairs['repair']> => {
        await symlink(
          relative(
            join(identity.destination, 'repos/canopy'),
            join(identity.source, 'preferences.json'),
          ),
          join(context.workingRoot, 'repos/canopy/unsafe-link'),
        );
        return repair(context);
      };
      // A resumed legacy plan must still check previously uninventoried checkout links.
      await expect(run()).rejects.toThrow('repos/canopy/unsafe-link');
      expect(await statIfPresent(join(repository, 'unsafe-link'))).toBeNull();
      repairs.repair = repair;
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: {
          transactionId: prior.transactionId,
          secureRelocation: 'complete',
        },
      });
      for (const path of [cowork, advisor, repository, linked]) {
        expect(await readlink(join(path, 'AGENTS.md'))).toBe('CLAUDE.md');
        expect(
          await readlink(
            join(
              identity.destination,
              relative(identity.source, path),
              'AGENTS.md',
            ),
          ),
        ).toBe('CLAUDE.md');
      }
      for (const image of absoluteLinks) {
        expect(await readlink(image.path)).toBe(image.target);
        expect(
          await readlink(
            join(identity.destination, relative(identity.source, image.path)),
          ),
        ).toBe(
          isWithin(identity.source, image.target) &&
            ![repository, linked].some((root) => isWithin(root, image.path))
            ? join(
                identity.destination,
                relative(identity.source, image.target),
              )
            : image.target,
        );
      }
      expect(await readFile(external, 'utf8')).toBe('user-owned bytes');
      expect(await readFile(history.path, 'utf8')).toBe(history.bytes);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  fileSymlinkFixture.each(['first-run', 'published-retry'])(
    'migrates tracked source-root absolute links without dirtying managed checkouts: %s',
    async (mode) => {
      await source();
      const repository = join(identity.source, 'repos/managed');
      const linked = join(identity.source, 'repo-shadows/fixture/checkout');
      await mkdir(repository, { recursive: true });
      const git = async (cwd: string, ...args: string[]): Promise<string> =>
        (
          await promisify(execFile)('git', ['--no-optional-locks', ...args], {
            cwd,
          })
        ).stdout;
      await git(repository, 'init', '-b', 'main');
      const target = join(identity.source, 'preferences.json');
      await symlink(target, join(repository, 'pointer'));
      await git(repository, 'add', 'pointer');
      await git(
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Tracked absolute link',
      );
      await git(repository, 'worktree', 'add', '-b', 'linked', linked);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      let transactionId: string | undefined;
      if (mode === 'published-retry') {
        const qualify = repairs.qualifyPublished.bind(repairs);
        repairs.qualifyPublished = async (
          context,
        ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
          await qualify(context);
          throw new Error('interrupted after Git qualification');
        };
        await expect(run()).rejects.toThrow(
          'interrupted after Git qualification',
        );
        const journal = await readFixtureJournal(identity);
        expect(journal?.phase).toBe('publishing');
        transactionId = journal?.transactionId;
        repairs = createInternalRootRelocationRepairs({
          ...nativeRepairOptions(),
          durability: desktopW5Durability,
        });
      }
      const result = await run();
      expect(result.kind).toBe('complete');
      if (transactionId && result.kind === 'complete')
        expect(result.journal.transactionId).toBe(transactionId);
      for (const path of [repository, linked]) {
        expect(await readlink(join(path, 'pointer'))).toBe(target);
        const moved = join(
          identity.destination,
          relative(identity.source, path),
        );
        expect(await readlink(join(moved, 'pointer'))).toBe(target);
        expect(await git(moved, 'status', '--porcelain=v1', '-z')).toBe('');
      }
      expect(await readFile(target, 'utf8')).toBe('{"theme":"dark"}');
    },
  );

  fileSymlinkFixture.each(['relative-source', 'noncanonical-source'])(
    'inventory names the same %s owned-link blocker as apply without writing',
    async (kind) => {
      await source();
      const path = join(identity.source, 'app-workspaces/home/AGENTS.md');
      await mkdir(dirname(path), { recursive: true });
      const target =
        kind === 'relative-source'
          ? relative(
              join(identity.destination, 'app-workspaces/home'),
              join(identity.source, 'preferences.json'),
            )
          : `${identity.source}/app-workspaces/../preferences.json`;
      await symlink(target, path);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const before = await worker.inventory(identity);
      const inventory = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      if (inventory.kind !== 'inventory') throw new Error('Expected inventory');
      expect(inventory.preflight.kind).toBe('refused');
      const detail = `link "app-workspaces/home/AGENTS.md" -> ${JSON.stringify(target)}`;
      expect(inventory.preflight.blockers.join('\n')).toContain(detail);
      expect(await worker.inventory(identity)).toEqual(before);
      expect(await statIfPresent(identity.coordination)).toBeNull();
      expect(await statIfPresent(identity.destination)).toBeNull();
      await expect(run()).rejects.toThrow(detail);
      expect(await readlink(path)).toBe(target);
    },
  );

  test('preparation skips absent prunable Git entries without pruning their source records', async () => {
    await source();
    const repository = join(identity.source, 'repos/managed');
    const absent = join(home, 'missing-linked-checkout');
    await mkdir(repository, { recursive: true });
    const git = async (...args: string[]): Promise<string> =>
      (
        await promisify(execFile)('git', ['--no-optional-locks', ...args], {
          cwd: repository,
        })
      ).stdout;
    await git('init');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    await git('worktree', 'add', '-b', 'prunable-fixture', absent);
    await rm(absent, { recursive: true });
    const before = await git('worktree', 'list', '--porcelain', '-z');
    expect(before).toContain('prunable');
    worker.diagnose = diagnoseInternalRootW5;
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      if (result.kind !== 'inventory') throw new Error('Expected inventory');
      expect(result.preflight).toEqual({ kind: 'ready', blockers: [] });
      expect(
        stderr.mock.calls.filter(
          ([line]) =>
            typeof line === 'string' &&
            line.includes('skipping absent prunable Git worktree') &&
            line.includes('missing-linked-checkout'),
        ),
      ).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
    expect(await git('worktree', 'list', '--porcelain', '-z')).toBe(before);
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(await git('worktree', 'list', '--porcelain', '-z')).toBe(before);
  });

  test.each([
    'external-pruned',
    'fresh',
    'building',
    'removed',
    'publishing-sibling',
    'publishing-destination',
    'complete-pending',
    'restoring-external',
    'rebuilding',
  ] as const)(
    'restarts real Git repairs and retains pruned/removed checkout data (%s)',
    async (phase) => {
      const restart = phase !== 'fresh';
      const pruned = [
        'fresh',
        'building',
        'removed',
        'external-pruned',
      ].includes(phase);
      const externalPruned = phase === 'external-pruned';
      await source();
      const repository = externalPruned
        ? join(identity.source, 'managed-repo')
        : join(home, 'external-repo');
      const metadata = join(identity.source, 'workspaces', 'fixture');
      const checkout = externalPruned
        ? join(home, 'external-checkout')
        : join(metadata, 'worktrees', 'pruned-checkout\u00a0');
      const publishedCheckout = externalPruned
        ? checkout
        : join(identity.destination, relative(identity.source, checkout));
      await mkdir(metadata, { recursive: true, mode: 0o700 });
      await writeFile(
        join(identity.source, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: 'fixture',
              name: 'Fixture',
              type: 'multi-repo',
              color: 'blue',
            },
          ],
        }),
      );
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          repos: [{ id: 'repo', repoPath: repository }],
        }),
      );
      await writeFile(
        join(metadata, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'pruned-checkout',
              branchName: 'pruned-fixture',
              createdAt: '2026-11-10T00:00:00.000Z',
              creation: {
                checkouts: [
                  { repositoryPath: repository, checkoutPath: checkout },
                ],
              },
            },
          ],
        }),
      );
      await mkdir(repository);
      const git = async (...args: string[]): Promise<string> =>
        (
          await promisify(execFile)('git', ['--no-optional-locks', ...args], {
            cwd: repository,
          })
        ).stdout;
      await git('init');
      await git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      await git('worktree', 'add', '-b', 'pruned-fixture', checkout);
      await writeFile(join(checkout, 'uncommitted'), 'preserve this work');
      const admin = (
        await git('-C', checkout, 'rev-parse', '--absolute-git-dir')
      ).replace(/\r?\n$/, '');
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      if (restart) {
        if (pruned) {
          await expect(
            migrateInternalRoot(worker, identity, apply, {
              ...repairs,
              repair: async (context) => {
                await repairs.repair(context);
                throw new Error('unsealed repair stopped');
              },
            }),
          ).rejects.toThrow('unsealed repair stopped');
        } else {
          await expect(
            migrateInternalRoot(
              {
                ...worker,
                relocateSecure: () =>
                  Promise.reject(new Error('secure pending')),
              },
              identity,
              apply,
              repairs,
            ),
          ).rejects.toThrow('secure pending');
          const old = await readFixtureJournal(identity);
          if (!old) throw new Error('missing journal');
          await worker.saveJournal({
            ...old,
            phase: phase.startsWith('publishing-')
              ? 'publishing'
              : phase === 'complete-pending'
                ? 'complete'
                : phase === 'restoring-external'
                  ? 'restoring-external'
                  : 'rebuilding',
          });
          if (phase === 'publishing-sibling')
            await rename(identity.destination, worker.stagingRoot(identity));
        }
        await writeFile(join(identity.source, 'continued-work'), 'keep');
      }
      if (pruned) await rm(admin, { recursive: true });
      if (phase === 'removed') await rm(checkout, { recursive: true });
      const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await expect(
          migrateInternalRoot(worker, identity, { ...apply, restart }, repairs),
        ).resolves.toMatchObject({ kind: 'complete' });
        expect(
          await readFile(
            join(identity.destination, 'workspaces/fixture/worktrees.json'),
            'utf8',
          ),
        ).toContain(publishedCheckout);
        if (phase === 'removed') {
          expect(await statIfPresent(publishedCheckout)).toBeNull();
          expect(await statIfPresent(admin)).toBeNull();
          return;
        }
        expect(
          await readFile(join(publishedCheckout, 'uncommitted'), 'utf8'),
        ).toBe('preserve this work');
        expect(await readFile(join(publishedCheckout, '.git'), 'utf8')).toBe(
          await readFile(join(checkout, '.git'), 'utf8'),
        );
        if (pruned) {
          expect(stderr.mock.calls.flat().join('')).toContain(checkout);
          expect(stderr.mock.calls.flat().join('')).toContain(
            'pruned-git-worktree-records',
          );
        } else {
          expect(
            await git('-C', publishedCheckout, 'status', '--porcelain'),
          ).toContain('uncommitted');
          expect(await readFile(join(admin, 'gitdir'), 'utf8')).toContain(
            identity.destination,
          );
        }
      } finally {
        stderr.mockRestore();
      }
    },
  );

  (windows ? test.skip : test)(
    'nonprivate historical secure root prints an exact quoted remediation without changing permissions',
    async () => {
      await source();
      await mkdir(identity.historicalSecure, { mode: 0o755 });
      await chmod(identity.historicalSecure, 0o755);
      const expected = `chmod 700 '${identity.historicalSecure}'`;
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { apply: false, declareInternal: true },
          repairs,
        ),
      ).rejects.toThrow(expected);
      expect((await lstat(identity.historicalSecure)).mode & 0o777).toBe(0o755);
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(await statIfPresent(identity.coordination)).toBeNull();
    },
  );

  test('migrates hard-linked dependency binaries into independent copies', async () => {
    await source();
    const directory =
      'workspaces/fixture/worktrees/feature/node_modules/@esbuild/darwin-arm64/bin';
    await mkdir(join(identity.source, directory), { recursive: true });
    const original = join(identity.source, directory, 'esbuild');
    const alias = join(identity.source, directory, 'esbuild-alias');
    const bytes = Buffer.from([0, 1, 127, 255]);
    await writeFile(original, bytes, { mode: 0o755 });
    await fs.link(original, alias);
    const before = await lstat(original, { bigint: true });
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: false },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'inventory' });
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    const copies = [original, alias].map((path) =>
      join(identity.destination, relative(identity.source, path)),
    );
    const inodes: bigint[] = [];
    for (const path of copies) {
      expect(await readFile(path)).toEqual(bytes);
      const stat = await lstat(path, { bigint: true });
      expect(stat.nlink).toBe(1n);
      expect(stat.ino).not.toBe(before.ino);
      inodes.push(stat.ino);
    }
    expect(inodes[0]).not.toBe(inodes[1]);
    const [copy, copiedAlias] = copies;
    if (!copy || !copiedAlias) throw new Error('Missing copied binaries');
    await writeFile(copy, 'destination-only change');
    expect(await readFile(copiedAlias)).toEqual(bytes);
    for (const path of [original, alias]) {
      expect(await readFile(path)).toEqual(bytes);
      const stat = await lstat(path, { bigint: true });
      expect(stat.ino).toBe(before.ino);
      expect(stat.nlink).toBe(before.nlink);
      expect(stat.mtimeNs).toBe(before.mtimeNs);
      expect(stat.ctimeNs).toBe(before.ctimeNs);
    }
  });

  test.each([canopy, unstoppableCode])(
    'migrates only the explicitly selected $id source and admits its recorded publication',
    async (brand) => {
      const sourceHome = home;
      home = join(home, 'new-home');
      await createPrivateMigrationDirectory(home, host);
      process.env.HOME = process.env.USERPROFILE = home;
      const ordinary = internalRootIdentity(home, brand);
      await createPrivateMigrationDirectory(ordinary.source, host);
      await writeFile(join(ordinary.source, 'unrelated'), 'leave stable alone');
      const imports = join(sourceHome, 'imports');
      await createPrivateMigrationDirectory(imports, host);
      const selected = join(imports, 'old internal data');
      const options = parseInternalRootMigrationOptions([
        `--brand=${brand.id}`,
        '--apply',
        '--declare-internal',
        `--source-dir=${selected}`,
      ]);
      identity = internalRootIdentity(home, brand, options.sourceDirectory);
      await source();
      const before = await readFile(join(identity.source, 'preferences.json'));
      expect(
        await migrateInternalRoot(
          worker,
          identity,
          { apply: false, declareInternal: true },
          repairs,
        ),
      ).toMatchObject({
        kind: 'inventory',
        identity: { source: selected },
        journal: null,
      });
      expect(await statIfPresent(identity.coordination)).toBeNull();
      expect(await run()).toMatchObject({
        kind: 'complete',
        journal: {
          version: 7,
          identity: { source: selected },
          secureRelocation: 'complete',
        },
      });
      expect(
        await readFile(join(identity.destination, 'preferences.json')),
      ).toEqual(before);
      expect(await readFile(join(identity.source, 'preferences.json'))).toEqual(
        before,
      );
      expect(await readFile(join(ordinary.source, 'unrelated'), 'utf8')).toBe(
        'leave stable alone',
      );
      expect(startup).not.toThrow();
      const journalPath = join(identity.coordination, 'journal.json');
      const completed = await readFile(journalPath, 'utf8');
      const journal: unknown = JSON.parse(completed);
      if (
        typeof journal !== 'object' ||
        journal === null ||
        !('identity' in journal) ||
        typeof journal.identity !== 'object' ||
        journal.identity === null
      )
        throw new Error('Expected a journal with an identity');
      await writeFile(
        journalPath,
        JSON.stringify({
          ...journal,
          identity: { ...journal.identity, source: 'relative-source' },
        }),
      );
      expect(startup).toThrow('unsupported');
      await writeFile(journalPath, completed);
      // Completion binds destination, not a later retained-source observation.
      await rm(selected, { recursive: true });
      await writeFile(selected, 'unrelated replacement');
      expect(startup).not.toThrow();
      await expect(readFixtureJournal(ordinary)).rejects.toMatchObject({
        reason: 'journal-unsupported',
      });
    },
  );

  test('resumes a journal-free v7 repair plan without lifecycle evidence', async () => {
    await source();
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const save = worker.saveJournal.bind(worker);
    worker.saveJournal = async (journal): Promise<void> => {
      if (journal.phase === 'source-settled' && journal.repairPlan) {
        const { lifecycleJournals, ...legacyPlan } = journal.repairPlan;
        expect(lifecycleJournals).toEqual([]);
        await save({ ...journal, repairPlan: legacyPlan });
        throw new Error('old v7 plan saved');
      }
      await save(journal);
    };
    await expect(run()).rejects.toThrow('old v7 plan saved');
    const legacy = await readFixtureJournal(identity);
    expect(legacy).toMatchObject({ version: 7, phase: 'source-settled' });
    expect(legacy?.repairPlan?.lifecycleJournals).toBeUndefined();
    worker.saveJournal = save;
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    await expect(run()).resolves.toMatchObject({
      kind: 'complete',
      journal: { transactionId: legacy?.transactionId },
    });
  });

  test.each(['after-staging', 'after-evidence', 'after-journal'])(
    'restarts with frozen lifecycle evidence after preservation interrupted %s',
    async (cut) => {
      await source();
      await lifecycleFixture('completed', 'worktree-delete');
      const newRepairs = (): InternalRootRepairs =>
        createInternalRootRelocationRepairs({
          ...nativeRepairOptions(),
          durability: desktopW5Durability,
        });
      repairs = newRepairs();
      const expose = worker.exposeStaging.bind(worker);
      worker.exposeStaging = (): Promise<void> =>
        Promise.reject(new Error('before exposure'));
      await expect(run()).rejects.toThrow('before exposure');
      const old = await readFixtureJournal(identity);
      if (!old?.repairPlan?.lifecycleJournals?.length)
        throw new Error('Expected frozen lifecycle evidence');
      const journalPath = join(identity.coordination, 'journal.json');
      const saved = await readFile(journalPath);
      const evidenceNames = (await readdir(identity.coordination)).filter(
        (name) => name.startsWith('lifecycle-journals'),
      );
      const evidence = await Promise.all(
        evidenceNames.map((name) =>
          readFile(join(identity.coordination, name)),
        ),
      );
      const retained = join(
        identity.coordination,
        `restarted-${old.transactionId}`,
      );
      await createPrivateMigrationDirectory(retained, host);
      await rename(
        join(identity.coordination, 'staging'),
        join(retained, 'staging'),
      );
      if (cut !== 'after-staging')
        for (const name of evidenceNames)
          await rename(join(identity.coordination, name), join(retained, name));
      if (cut === 'after-journal')
        await rename(journalPath, join(retained, 'journal.json'));
      await writeFile(join(identity.source, 'new-work'), 'current source');
      worker.exposeStaging = expose;
      repairs = newRepairs();
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, restart: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(await readFile(join(retained, 'journal.json'))).toEqual(saved);
      for (const [index, name] of evidenceNames.entries())
        expect(await readFile(join(retained, name))).toEqual(evidence[index]);
      expect(
        await readFile(join(identity.destination, 'new-work'), 'utf8'),
      ).toBe('current source');
      await checkInstalledShape();
    },
  );

  test.each([
    'valid',
    'corrupt',
    'wrong-transaction',
    'wrong-plan',
    'invalid-record',
    'invalid-abandoned-path',
    'missing',
    'journal-replace-failure',
  ])(
    'keeps persisted plans internal-478-compatible and qualifies separate frozen lifecycle evidence: %s',
    async (fault) => {
      await source();
      const history = [
        await lifecycleFixture('completed', 'worktree-archive', true, true),
        await lifecycleFixture('completed', 'worktree-delete'),
        await strandedArchiveFixture(identity.source, 'P0'),
      ];
      await writeFile(join(identity.source, 'w5/.git'), 'opaque W5 history');
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const save = worker.saveJournal.bind(worker);
      const journalPath = join(identity.coordination, 'journal.json');
      worker.saveJournal = async (journal): Promise<void> => {
        await save(journal);
        await checkInstalledShape();
        if (journal.phase === 'source-settled')
          throw new Error('after frozen evidence');
      };
      await expect(run()).rejects.toThrow('after frozen evidence');
      const frozen = await readFixtureJournal(identity);
      expect(frozen?.repairPlan?.lifecycleJournals).toHaveLength(
        history.length,
      );
      const evidenceName = (await readdir(identity.coordination)).find((name) =>
        /^lifecycle-journals-.*\.json$/.test(name),
      );
      if (!evidenceName) throw new Error('Missing lifecycle sidecar');
      const evidencePath = join(identity.coordination, evidenceName);
      const original = await readFile(evidencePath, 'utf8');
      const evidence: unknown = JSON.parse(original);
      if (typeof evidence !== 'object' || evidence === null)
        throw new Error('Missing frozen evidence');
      if (fault === 'journal-replace-failure') {
        if (!frozen?.repairPlan) throw new Error('Missing frozen plan');
        const checkpoint = await readFile(journalPath);
        // Make only the journal replacement fail, after the new evidence is durable.
        await rm(journalPath);
        await mkdir(journalPath);
        try {
          await expect(
            save({
              ...frozen,
              repairPlan: {
                ...frozen.repairPlan,
                ownedPaths: [
                  ...frozen.repairPlan.ownedPaths,
                  join(identity.source, 'new'),
                ],
              },
            }),
          ).rejects.toThrow();
        } finally {
          await rm(journalPath, { recursive: true });
          await writeFile(journalPath, checkpoint, { mode: 0o600 });
        }
        expect(await readFile(evidencePath, 'utf8')).toBe(original);
        await expect(readFixtureJournal(identity)).resolves.toEqual(frozen);
      } else if (fault === 'missing') await rm(evidencePath);
      else if (fault !== 'valid')
        await writeFile(
          evidencePath,
          fault === 'corrupt'
            ? 'broken'
            : JSON.stringify({
                ...evidence,
                ...(fault === 'wrong-transaction'
                  ? { transactionId: 'other' }
                  : {}),
                ...(fault === 'wrong-plan'
                  ? { planFingerprint: '0'.repeat(64) }
                  : {}),
                ...(fault === 'invalid-record'
                  ? { lifecycleJournals: [{}] }
                  : {}),
                ...(fault === 'invalid-abandoned-path'
                  ? { abandonedPaths: ['../outside'] }
                  : {}),
              }),
        );
      if (!['valid', 'missing', 'journal-replace-failure'].includes(fault)) {
        await expect(readFixtureJournal(identity)).rejects.toMatchObject({
          reason: 'journal-unsupported',
        });
        await writeFile(evidencePath, original);
      }
      worker.saveJournal = save;
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      if (fault === 'missing') {
        await expect(run()).rejects.toThrow(
          'Lifecycle journal membership changed',
        );
        expect(await statIfPresent(identity.destination)).toBeNull();
        return;
      }
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: { transactionId: frozen?.transactionId },
      });
      await checkInstalledShape();
      expect(
        await readFile(join(identity.destination, 'w5/.git'), 'utf8'),
      ).toBe('opaque W5 history');
      for (const item of history) {
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        const copied: unknown = JSON.parse(
          await readFile(
            join(identity.destination, relative(identity.source, item.path)),
            'utf8',
          ),
        );
        // journalSchema is unchanged from internal-478/base, including string identities.
        expect(journalSchema.parse(copied)).toMatchObject({
          state: item.record.state,
          operation: item.record.operation,
        });
      }
    },
  );
  test('the default source never guesses another brand or build', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    for (const name of [
      '.canopy',
      '.canopy-internal',
      '.unstoppable-code-rc',
    ]) {
      await createPrivateMigrationDirectory(join(home, name), host);
      await writeFile(join(home, name, 'keep'), 'not selected');
    }
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(startup).not.toThrow();
    for (const name of ['.canopy', '.canopy-internal', '.unstoppable-code-rc'])
      expect(await readFile(join(home, name, 'keep'), 'utf8')).toBe(
        'not selected',
      );
    expect(await statIfPresent(identity.destination)).toBeNull();
  });
  test('explicit source refuses missing paths and overlapping maintenance trees', async () => {
    const ordinary = identity;
    for (const invalid of [
      '',
      'relative-source',
      home,
      ordinary.destination,
      join(ordinary.destination, 'child'),
      ordinary.coordination,
      ordinary.historicalSecure,
      `${ordinary.destination}.migration-staging`,
      join(home, '.canopy-internal-startup.json'),
    ])
      expect(() => internalRootIdentity(home, canopy, invalid)).toThrow();
    identity = internalRootIdentity(home, canopy, join(home, 'missing-custom'));
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });
  test('explicit source refuses aliases and public roots without repairing them', async () => {
    await source();
    const original = identity.source;
    const alias = join(home, 'custom-alias');
    await symlink(original, alias, windows ? 'junction' : 'dir');
    identity = internalRootIdentity(home, canopy, alias);
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    if (!windows) {
      await chmod(original, 0o755);
      identity = internalRootIdentity(home, canopy, original);
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
      expect((await lstat(original)).mode & 0o777).toBe(0o755);
    }
  });
  test('an interrupted explicit-source transaction cannot resume with another source', async () => {
    const ordinary = identity;
    identity = internalRootIdentity(home, canopy, join(home, 'selected'));
    await source();
    const save = worker.saveJournal.bind(worker);
    worker.saveJournal = async (journal): Promise<void> => {
      await save(journal);
      throw new Error('fixture interruption');
    };
    await expect(run()).rejects.toThrow('fixture interruption');
    const before = await readFile(join(identity.coordination, 'journal.json'));
    expect(startup).toThrow('incomplete');
    expect(startup).toThrow('--source-dir');
    await expect(
      migrateInternalRoot(worker, ordinary, apply, repairs),
    ).rejects.toMatchObject({ reason: 'journal-unsupported' });
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      before,
    );
    worker.saveJournal = save;
    expect(await run()).toMatchObject({ kind: 'complete' });
    expect(startup).not.toThrow();
  });
  test('an explicit source on another volume refuses before W5 or destination creation', async () => {
    identity = internalRootIdentity(home, canopy, join(home, 'selected'));
    await source();
    const original = storageObservation.observeStoragePathSync;
    const observation = jest
      .spyOn(storageObservation, 'observeStoragePathSync')
      .mockImplementation((path) => {
        const observed = original(path);
        if (path === identity.source && observed.stat)
          Object.defineProperty(observed.stat, 'dev', {
            value: observed.stat.dev + 1,
          });
        return observed;
      });
    try {
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
      expect(recover).not.toHaveBeenCalled();
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(await statIfPresent(identity.coordination)).toBeNull();
    } finally {
      observation.mockRestore();
    }
  });
  async function freshStart(): Promise<void> {
    await createFreshInternalRoot({
      identity,
      worker,
      ownedChildPath: filesystemOptions.ownedChildPath,
      windowsPrincipal: windows
        ? authorityHost.windowsPrincipalObserver(
            resolve('.cache/bin/win32-x64/canopy-process-identity.exe'),
          )
        : undefined,
    });
  }
  function startup(): void {
    assertHostBuildStorageStartup({
      home,
      identity: { brandId: identity.brandId, build: 'internal' },
    });
  }
  it.each([canopy, unstoppableCode])(
    '$id explicit empty-internal choice never inventories the unrelated predecessor and admits subsequent writes',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const prior = await lstat(identity.source, { bigint: true });
      const bytes = await readFile(join(identity.source, 'preferences.json'));
      const inventory = jest
        .spyOn(worker, 'inventory')
        .mockRejectedValue(
          new Error('Fresh start must never inventory the predecessor'),
        );
      await freshStart();
      expect(inventory).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(await readdir(identity.destination)).toEqual([]);
      expect(startup).not.toThrow();
      await writeFile(
        join(identity.destination, 'new-payload'),
        'ordinary write',
      );
      expect(startup).not.toThrow();
      expect(await readFile(join(identity.source, 'preferences.json'))).toEqual(
        bytes,
      );
      const after = await lstat(identity.source, { bigint: true });
      expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
        prior.dev,
        prior.ino,
        prior.mtimeNs,
        prior.ctimeNs,
      ]);
      expect(
        await statIfPresent(join(identity.coordination, 'journal.json')),
      ).toBeNull();
      await expect(freshStart()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      inventory.mockRestore();
    },
  );
  it('empty-internal startup choice does not inspect a predecessor that is not even a directory', async () => {
    await writeFile(identity.source, 'unrelated file', { mode: 0o600 });
    await freshStart();
    expect(startup).not.toThrow();
    expect(await readFile(identity.source, 'utf8')).toBe('unrelated file');
  });
  it.each([
    'populated',
    'staging',
    'journal',
    'cold-refusal',
    'cold-under-lock',
  ] as const)(
    'fresh start refuses %s without authorizing startup',
    async (fault) => {
      await source();
      if (fault === 'populated') {
        await createPrivateMigrationDirectory(identity.destination, host);
        await writeFile(join(identity.destination, 'keep'), 'do not replace');
      }
      if (fault === 'staging')
        await createPrivateMigrationDirectory(
          worker.stagingRoot(identity),
          host,
        );
      if (fault === 'journal') {
        const release = await worker.coordinate(identity);
        await release();
        await writeFile(
          join(identity.coordination, 'journal.json'),
          '{"version":999}',
          { mode: 0o600 },
        );
      }
      const cold = jest.spyOn(worker, 'proveCold');
      if (fault === 'cold-refusal')
        cold.mockRejectedValue(new Error('cold refusal'));
      if (fault === 'cold-under-lock')
        cold
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(new Error('cold refusal'));
      await expect(freshStart()).rejects.toThrow();
      expect(
        await statIfPresent(
          join(home, `.${identity.brandId}-internal-startup.json`),
        ),
      ).toBeNull();
      if (fault === 'populated')
        expect(await readFile(join(identity.destination, 'keep'), 'utf8')).toBe(
          'do not replace',
        );
      expect(
        await readFile(join(identity.source, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      cold.mockRestore();
    },
  );
  it('fresh start refuses a nonprivate destination without changing its permissions', async () => {
    await source();
    await createPrivateMigrationDirectory(identity.destination, host);
    if (windows)
      await promisify(execFile)('icacls.exe', [
        identity.destination,
        '/grant',
        '*S-1-1-0:R',
      ]);
    else await chmod(identity.destination, 0o755);
    try {
      await expect(freshStart()).rejects.toThrow();
      expect(
        await statIfPresent(
          join(home, `.${identity.brandId}-internal-startup.json`),
        ),
      ).toBeNull();
      if (!windows)
        expect((await lstat(identity.destination)).mode & 0o777).toBe(0o755);
    } finally {
      if (windows)
        await promisify(execFile)('icacls.exe', [
          identity.destination,
          '/remove:g',
          '*S-1-1-0',
        ]);
    }
  });
  it('fresh-start record publication never replaces a concurrently created choice', async () => {
    await source();
    const path = join(home, `.${identity.brandId}-internal-startup.json`);
    const proof = jest.spyOn(worker, 'proveCold');
    proof.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      await writeFile(path, 'retain this competing choice', { mode: 0o600 });
    });
    await expect(freshStart()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('retain this competing choice');
    expect(await readdir(identity.destination)).toEqual([]);
    expect(startup).toThrow();
    proof.mockRestore();
  });
  it.each(['brandId', 'principal', 'publicationIdentity'] as const)(
    'fresh-start evidence refuses altered %s',
    async (field) => {
      await source();
      await freshStart();
      const path = join(home, `.${identity.brandId}-internal-startup.json`);
      const record: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof record !== 'object' || record === null)
        throw new Error('Expected a fresh-start record');
      await writeFile(path, JSON.stringify({ ...record, [field]: 'foreign' }));
      expect(startup).toThrow();
    },
  );
  it('fresh start refuses a completed migration without superseding its journal', async () => {
    await source();
    const completed = await run();
    expect(completed.kind).toBe('complete');
    const before = await readFile(join(identity.coordination, 'journal.json'));
    await expect(freshStart()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      before,
    );
    expect(startup).not.toThrow();
  });
  it('fresh-start evidence cannot override interrupted migration evidence or a replaced publication', async () => {
    await source();
    await freshStart();
    await rename(identity.destination, `${identity.destination}.retained`);
    await createPrivateMigrationDirectory(identity.destination, host);
    expect(startup).toThrow();
    await rm(identity.destination, { recursive: true });
    await rename(`${identity.destination}.retained`, identity.destination);
    expect(startup).not.toThrow();
    await writeFile(
      join(identity.coordination, 'journal.json'),
      '{"version":999}',
      { mode: 0o600 },
    );
    expect(startup).toThrow();
  });
  async function run(): ReturnType<typeof migrateInternalRoot> {
    return migrateInternalRoot(worker, identity, apply, repairs);
  }

  async function expectPublishedRefusal(): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof InternalRootMigrationRefused)) throw error;
      expect(error.reason).toBe('repair-refused');
      expect(error.recovery).toContain('published but unqualified');
      return;
    }
    throw new Error('Expected published-root qualification to refuse.');
  }

  test.each([canopy, unstoppableCode])(
    'uses the injected Windows principal throughout $id repair admission and publication',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const sid = 'S-1-5-21-1-2-3-1001';
      const principal = jest.fn(() => Promise.resolve(sid));
      const getuid = jest.fn(() => undefined);
      // Exercise SID authority on the native fixture filesystem, not native Windows custody.
      const authorityObservation = jest
        .spyOn(authorityHost, 'hostLocalAuthorityObservation')
        .mockImplementation((windowsPrincipal) => ({
          platform: 'win32',
          getuid,
          windowsPrincipal,
        }));
      try {
        const context: InternalRootRepairContext = {
          identity,
          transactionId: '00000000-0000-0000-0000-000000000000',
          inventory: await worker.inventory(identity),
          workingRoot: `${identity.destination}.migration-staging`,
          externalFiles: [],
        };
        for (const windowsPrincipal of [
          undefined,
          (): Promise<string> => Promise.resolve('not-a-sid'),
          (): Promise<string> =>
            Promise.reject(new Error('TokenUser unavailable')),
        ]) {
          await expect(
            createInternalRootRelocationRepairs({
              filesystemHost: host,
              durability: desktopW5Durability,
              windowsPrincipal,
            }).prepare(context),
          ).rejects.toMatchObject({ code: 'principal_unavailable' });
          await expect(lstat(identity.destination)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        repairs = createInternalRootRelocationRepairs({
          filesystemHost: host,
          durability: desktopW5Durability,
          windowsPrincipal: principal,
        });
        expect(await run()).toMatchObject({ kind: 'complete' });
        expect(principal.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(getuid).not.toHaveBeenCalled();
        const recorded: unknown = JSON.parse(
          await readFile(
            join(identity.destination, 'internal-root-authority.json'),
            'utf8',
          ),
        );
        const journal = await readFixtureJournal(identity);
        if (!journal) throw new Error('Missing completed journal');
        const expected: Record<string, unknown> = {
          version: 1,
          brandId: brand.id,
          installationId: journal.transactionId,
        };
        for (const [key, root] of [
          ['from', identity.source],
          ['to', identity.destination],
        ] as const) {
          const authorityId = createHash('sha256')
            .update(
              JSON.stringify([
                'canopy.local-authority',
                1,
                brand.id,
                root,
                ['windows-sid', sid],
              ]),
            )
            .digest('hex');
          expected[key] = { authorityId, canonicalDataRoot: root };
        }
        expect(recorded).toEqual(expected);
      } finally {
        authorityObservation.mockRestore();
      }
    },
  );

  test.each([canopy, unstoppableCode])(
    'keeps $id secure conflicts pending and resumes accepted v6 pending evidence',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const workspace = join(identity.source, 'workspaces', 'cowork');
      const folder = join(workspace, 'home');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(
        join(identity.source, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            { id: 'cowork', name: 'Cowork', color: 'blue', type: 'cowork' },
          ],
        }),
      );
      await writeFile(
        join(workspace, 'workspace.json'),
        JSON.stringify({ version: 1, id: 'cowork', folderPath: folder }),
      );
      await mkdir(identity.historicalSecure, { mode: 0o700 });
      await writeFile(join(identity.historicalSecure, 'own'), 'opaque-own');
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const save = worker.saveJournal.bind(worker);
      worker.saveJournal = async (journal): Promise<void> => {
        await save(journal);
        if (
          journal.phase === 'complete' &&
          journal.secureRelocation === 'pending'
        ) {
          await mkdir(join(identity.destination, 'secure-storage'), {
            mode: 0o700,
          });
          await writeFile(
            join(identity.destination, 'secure-storage', 'independent'),
            'keep',
          );
        }
      };
      await expect(run()).rejects.toMatchObject({
        reason: 'secure-relocation-conflict',
      });
      expect(
        await readFile(join(identity.historicalSecure, 'own'), 'utf8'),
      ).toBe('opaque-own');
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'independent'),
          'utf8',
        ),
      ).toBe('keep');
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('incomplete');
      worker.saveJournal = save;
      if (brand.id === 'unstoppable-code') {
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { ...apply, declareInternal: false },
            repairs,
          ),
        ).rejects.toMatchObject({ reason: 'ownership-required' });
      }
      await rename(
        join(identity.destination, 'secure-storage'),
        join(home, 'explicitly-preserved-secure-conflict'),
      );
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing pending journal');
      await save({ ...journal, version: 6 });
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: { version: 7, secureRelocation: 'complete' },
      });
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'own'),
          'utf8',
        ),
      ).toBe('opaque-own');
      expect(
        await readFile(
          join(home, 'explicitly-preserved-secure-conflict', 'independent'),
          'utf8',
        ),
      ).toBe('keep');
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'cowork',
              'workspace.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        folderPath: join(identity.destination, 'workspaces', 'cowork', 'home'),
      });
    },
  );

  test('oversized frozen evidence never replaces the last readable journal', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    const path = join(identity.coordination, 'journal.json');
    const before = await readFile(path, 'utf8');
    await expect(
      worker.saveJournal({
        ...journal,
        externalFiles: [`/${'x'.repeat(17 * 1024 * 1024)}`],
      }),
    ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFixtureJournal(identity)).toEqual(journal);
  });

  test.each([canopy, unstoppableCode])(
    'published $id operator inventory writes only its advisory report, resolves HOME and refuses a missing addon without payload or journal writes',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const before = await worker.inventory(identity);
      // The published entry uses the repository addon, not the isolated Linux build above.
      const missingAddon =
        (windows || process.platform === 'linux') &&
        !existsSync(
          resolve(
            '.cache/native-owned-child',
            `${process.platform}-${process.arch}`,
            'core-owned-child.node',
          ),
        );
      for (const linked of [false, true]) {
        const environmentHome = linked ? join(home, 'home-alias') : home;
        if (linked) await symlink(home, environmentHome, 'dir');
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: environmentHome,
          USERPROFILE: environmentHome,
        };
        delete environment.NODE_OPTIONS;
        const execute = promisify(execFile);
        const execution = execute(
          process.execPath,
          [
            '--import',
            'tsx',
            join(__dirname, '../../../../scripts/internal-root-migration.ts'),
            `--brand=${brand.id}`,
            '--inventory',
            ...(brand.id === 'unstoppable-code' ? ['--declare-internal'] : []),
          ],
          { env: environment, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
        );
        if (missingAddon) {
          const error: unknown = await execution.then(
            () => {
              throw new Error(
                'Expected an operator process refusal, but the command succeeded.',
              );
            },
            (error: unknown) => error,
          );
          // Node's process errors can come from outside Jest's Error realm.
          if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            !('stdout' in error) ||
            !('stderr' in error) ||
            typeof error.stderr !== 'string'
          )
            throw new Error(
              'Operator process rejection lacked code, stdout or string stderr.',
              { cause: error },
            );
          expect(error.code).toBe(1);
          expect(error.stdout).toBe('');
          expect(error.stderr).toContain(
            `${JSON.stringify({
              kind: 'refused',
              reason: 'invalid-request-or-runtime',
              recovery: 'Owned child processes are unavailable on this host.',
            })}\n`,
          );
        } else {
          const result = await execution;
          const savedReport: unknown = JSON.parse(
            await readFile(
              join(identity.coordination, 'cleanup-candidates.json'),
              'utf8',
            ),
          );
          const output: unknown = JSON.parse(result.stdout);
          expect(output).toMatchObject({
            kind: 'inventory',
            identity,
            journal: null,
            space: {
              requiredBytes:
                process.platform === 'darwin' ? 64 * 1024 * 1024 : before.bytes,
            },
            cleanupCandidates: savedReport,
          });
          expect(output).toHaveProperty(
            'space.availableBytes',
            expect.any(Number),
          );
          expect(
            result.stderr
              .split('\n')
              .filter((line) => line.startsWith('Migration: ')),
          ).toEqual([
            'Migration: Walking source',
            'Migration: Cold proof',
            'Migration: W5 diagnosis',
            'Migration: Git checks',
            'Migration: Cleanup report',
          ]);
          expect(result.stderr).toContain('Cleanup candidates\n');
          expect(result.stderr).toContain('Removal is your choice.');
          expect(result.stderr).toContain(
            'Totals by category (listed copies only):',
          );
          expect(result.stderr).toContain('Overall potentially reclaimable:');
          expect(result.stderr).toContain('None identified.');
          expect(await readdir(identity.coordination)).toEqual([
            'cleanup-candidates.json',
            'coordination.sqlite',
          ]);
          await assertPrivate(
            join(identity.coordination, 'cleanup-candidates.json'),
            'file',
            0o600,
          );
          expect(await worker.readJournal(identity)).toBeNull();
          const applyError: unknown = await execute(
            process.execPath,
            [
              '--import',
              'tsx',
              join(__dirname, '../../../../scripts/internal-root-migration.ts'),
              `--brand=${brand.id}`,
              `--source-dir=${join(home, 'missing-source')}`,
              '--apply',
              '--declare-internal',
            ],
            { env: environment, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
          ).then(
            () => {
              throw new Error('Expected missing-source refusal');
            },
            (error: unknown) => error,
          );
          expect(applyError).toMatchObject({ code: 1, stdout: '' });
          if (
            typeof applyError !== 'object' ||
            applyError === null ||
            !('stderr' in applyError) ||
            typeof applyError.stderr !== 'string'
          )
            throw new Error('Operator refusal lacked string stderr.');
          expect(applyError.stderr).toMatch(
            /^Migration: Walking source\n.*"reason":"source-missing"/ms,
          );
          expect(await worker.readJournal(identity)).toBeNull();
        }
        expect(await worker.inventory(identity)).toEqual(before);
        if (linked) await rm(environmentHome);
      }
      expect((await readdir(home)).sort()).toEqual(
        (missingAddon
          ? [`.${brand.id}`]
          : [`.${brand.id}`, `.${brand.id}-internal-migration`]
        ).sort(),
      );
    },
  );

  test.each([canopy, unstoppableCode])(
    'composes real C repairs and pre-Cut-B recovery for $id across durable staging, publication and secure interruption windows',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const execute = promisify(execFile);
      const git = async (cwd: string, ...args: string[]): Promise<string> =>
        (
          await execute(
            'git',
            [
              '--no-optional-locks',
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'commit.gpgsign=false',
              ...args,
            ],
            {
              cwd,
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
              },
            },
          )
        ).stdout;
      const repository = async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await git(path, 'init', '-b', 'main');
        await writeFile(join(path, 'tracked'), 'committed\n');
        await git(path, 'add', 'tracked');
        await git(
          path,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Fixture',
        );
      };
      const managed = join(identity.source, 'repos', 'managed');
      const linked = join(
        identity.source,
        'workspaces',
        'fixture',
        'worktrees',
        'managed',
      );
      const external = join(home, 'external');
      const outside = join(home, 'outside-linked');
      const externalLinked = join(
        identity.source,
        'workspaces',
        'fixture',
        'worktrees',
        'external',
      );
      await repository(managed);
      if (!windows) {
        await symlink(
          join(identity.source, 'preferences.json'),
          join(managed, 'absolute-preferences'),
        );
        await git(managed, 'add', 'absolute-preferences');
        await git(
          managed,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Tracked absolute link',
        );
      }
      await repository(external);
      await git(managed, 'worktree', 'add', '-b', 'feature', linked);
      await git(managed, 'worktree', 'add', '-b', 'outside', outside);
      await git(external, 'worktree', 'add', '-b', 'inside', externalLinked);
      for (const path of [managed, linked, outside, external, externalLinked]) {
        await writeFile(join(path, 'tracked'), 'dirty\n');
        await writeFile(join(path, 'untracked'), 'untracked\n');
      }
      const metadata = join(identity.source, 'workspaces', 'fixture');
      await mkdir(metadata, { recursive: true, mode: 0o700 });
      const nonW5 = new Map<string, Buffer>();
      for (const directory of [
        'archived-containers',
        'attachments',
        'chat-archives',
        'chat-journals',
        'chat-storage-manifests',
        'chat-storage-v2',
        'chats',
        'cost',
        'detected-plans',
        'lane-recovery',
        'memory',
        'notes',
        'perf-baselines',
        'script-runs',
        'summaries',
        'worktree-data',
      ]) {
        await mkdir(join(metadata, directory), { mode: 0o700 });
        nonW5.set(
          join(directory, 'opaque'),
          Buffer.from(`${directory}\0retained\n`),
        );
      }
      nonW5.set('script-actions.json', Buffer.from('{"scripts":[]}'));
      nonW5.set('sidebar-item-groups.json', Buffer.from('{"groups":[]}'));
      for (const [path, bytes] of nonW5)
        await writeFile(join(metadata, path), bytes, { mode: 0o600 });
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('--apply');
      const index = join(identity.source, 'workspaces', 'index.json');
      const before = JSON.stringify({
        version: 1,
        workspaces: [
          { id: 'fixture', name: 'Fixture', type: 'multi-repo', color: 'blue' },
        ],
      });
      const after = before.replace('"Fixture"', '"Settled source"');
      await writeFile(index, before);
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          repos: [
            { id: 'managed', repoPath: managed },
            { id: 'external', repoPath: external },
          ],
          extension: { untouched: identity.source },
        }),
      );
      await writeFile(
        join(metadata, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'feature',
              branchName: 'feature',
              createdAt: '2026-11-06T00:00:00.000Z',
              creation: {
                checkouts: [{ repositoryPath: managed, checkoutPath: linked }],
              },
            },
          ],
        }),
      );
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const log = W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      const completedHistory = await lifecycleFixture(
        'completed',
        'worktree-archive',
        true,
        true,
      );
      const conservativeHistory = await lifecycleFixture(
        'completed',
        'worktree-delete',
      );
      const preserved = new Map<string, string | null>();
      for (const kind of [
        'replaced',
        'unverifiable',
        'null',
        'file',
        'external',
      ]) {
        const path =
          kind === 'external'
            ? join(home, 'external-lifecycle-owner')
            : join(identity.source, 'lifecycle-owners', kind);
        await mkdir(dirname(path), { recursive: true });
        if (kind === 'file') await writeFile(path, 'Keep the replacement file');
        else {
          await mkdir(path);
          await writeFile(
            join(path, 'sentinel'),
            'Keep the replacement directory',
          );
        }
        const stat = await lstat(path);
        const actual = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const recorded =
          kind === 'unverifiable'
            ? `unverifiable:${actual}`
            : kind === 'null'
              ? null
              : kind === 'external'
                ? actual
                : '1:2:3';
        conservativeHistory.record.ownedPaths.push({
          path,
          identity: recorded,
        });
        preserved.set(
          path,
          kind === 'file' || kind === 'replaced'
            ? `unverifiable:${recorded}`
            : recorded,
        );
      }
      conservativeHistory.bytes = JSON.stringify(conservativeHistory.record);
      await writeFile(conservativeHistory.path, conservativeHistory.bytes);
      const inertLive = await strandedArchiveFixture(
        identity.source,
        'P0',
        'feature',
      );
      inertLive.record.createdAt = '2026-11-06T00:00:00.000Z';
      inertLive.record.ownedPaths = [{ path: linked, identity: null }];
      inertLive.bytes = JSON.stringify(inertLive.record);
      await writeFile(inertLive.path, inertLive.bytes);
      const sourceBacklink = await readFile(join(linked, '.git'), 'utf8');
      const inertCaptured = await strandedArchiveFixture(identity.source, 'P2');
      const snapshotRef =
        'refs/app/archived-containers/fixture/stranded-p2/__workspace_root__';
      await git(managed, 'update-ref', snapshotRef, 'HEAD');
      const snapshotCommit = await git(managed, 'rev-parse', snapshotRef);
      const receipt = {
        caller: 'fixture',
        operation: 'core.workspace.update',
        idempotencyKey: 'release-skip',
        fingerprint: 'frozen-source-request',
      };
      try {
        log.commit({
          operation: 'core.workspace.update',
          receipt,
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      } finally {
        log.close();
      }
      await mkdir(join(identity.source, 'account-proxy-local', 'auths'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(identity.source, 'account-proxy-local', 'auths', 'opaque'),
        'account-bytes',
      );
      await writeFile(
        join(identity.source, 'account-proxy-local', 'config.yaml'),
        'stale',
      );
      await mkdir(join(identity.historicalSecure, 'vault'), {
        recursive: true,
        mode: 0o700,
      });
      const opaque = Buffer.from([0, 255, 2, 42]);
      await writeFile(
        join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        opaque,
        { mode: 0o600 },
      );
      const secureInode = (
        await lstat(join(identity.historicalSecure, 'vault', 'vault.sqlite'))
      ).ino;
      // Ordinary diagnosis retains its full artifact census; only internal-root
      // settlement scopes admission to W5's documents and log/journal evidence.
      const diagnosis = await diagnoseW5State(identity.source);
      expect(diagnosis.files).toEqual(
        expect.arrayContaining(
          [
            'archived-containers',
            'attachments',
            'chat-archives',
            'chat-journals',
            'chat-storage-manifests',
            'chat-storage-v2',
            'chats',
            'cost',
            'detected-plans',
            'lane-recovery',
            'memory',
            'notes',
            'perf-baselines',
            'script-runs',
            'summaries',
            'worktree-data',
            'worktrees',
            'script-actions.json',
            'sidebar-item-groups.json',
          ].map((name) => ({
            path: `fixture/${name}`,
            reason: 'unknown-artifact',
          })),
        ),
      );
      let settlements = 0;
      const newWorker = (): InternalRootMigrationWorker =>
        createInternalRootMigrationWorker({
          filesystemHost: host,
          ...filesystemOptions,
          proveCold: () => Promise.resolve(),
          recoverW5: async (root, qualification) => {
            settlements++;
            await fixtureW5(
              root,
              join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
              qualification,
            );
          },
        });
      worker = newWorker();
      let durabilityWrites = 0;
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: {
          ...desktopW5Durability,
          writeFileDurably: async (path, contents): Promise<void> => {
            durabilityWrites++;
            await desktopW5Durability.writeFileDurably(path, contents);
            throw new Error('interrupted after durable owner image');
          },
        },
      });
      const sourceOwner = await readFile(
        join(metadata, 'workspace.json'),
        'utf8',
      );
      await expect(run()).rejects.toThrow(
        'Relocation W5 decision requires recovery',
      );
      expect(durabilityWrites).toBeGreaterThan(0);
      expect(await readFixtureJournal(identity)).toMatchObject({
        phase: 'building',
        secureRelocation: 'pending',
        repairPlan: { transition: { brandId: brand.id } },
      });
      await expect(lstat(identity.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(metadata, 'workspace.json'), 'utf8')).toBe(
        sourceOwner,
      );
      expect(
        await readFile(
          join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        ),
      ).toEqual(opaque);
      // Restart discards partial staging and reapplies frozen C evidence, without
      // capturing changed Git backlinks or repeating source W5 settlement.
      worker = newWorker();
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const publish = worker.publish.bind(worker);
      worker.publish = async (journal): Promise<void> => {
        await publish(journal);
        await git(
          external,
          'symbolic-ref',
          'HEAD',
          'refs/heads/qualification-drift',
        );
      };
      await expect(run()).rejects.toThrow('published-git-state-changed');
      expect(await readFixtureJournal(identity)).toMatchObject({
        phase: 'publishing',
        secureRelocation: 'pending',
      });
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('incomplete');
      expect(
        await readFile(
          join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        ),
      ).toEqual(opaque);
      await git(external, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      if (!windows)
        for (const path of [managed, linked]) {
          expect(await readlink(join(path, 'absolute-preferences'))).toBe(
            join(identity.source, 'preferences.json'),
          );
          expect(
            await readlink(
              join(
                identity.destination,
                relative(identity.source, path),
                'absolute-preferences',
              ),
            ),
          ).toBe(join(identity.source, 'preferences.json'));
        }
      worker = newWorker();
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const save = worker.saveJournal.bind(worker);
      worker.saveJournal = async (journal): Promise<void> => {
        await save(journal);
        if (
          journal.phase === 'complete' &&
          journal.secureRelocation === 'pending'
        )
          throw new Error('root complete interruption');
      };
      await expect(run()).rejects.toThrow('root complete interruption');
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      for (const build of ['internal', 'stable'] as const)
        expect(() =>
          assertHostBuildStorageStartup({
            home,
            identity: { brandId: brand.id, build },
          }),
        ).toThrow('--apply');
      // The retained source is no longer authoritative, even before secure resume.
      await writeFile(
        join(identity.source, 'preferences.json'),
        'recreated old installation',
      );
      worker = newWorker();
      const move = worker.relocateSecure.bind(worker);
      worker.relocateSecure = async (journal): Promise<void> => {
        await move(journal);
        throw new Error('secure rename interruption');
      };
      await expect(run()).rejects.toThrow('secure rename interruption');
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      await expect(lstat(identity.historicalSecure)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      worker = newWorker();
      // A new adapter instance must reopen the plan from B's journal, not memory.
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      expect(await run()).toMatchObject({
        kind: 'complete',
        journal: { version: 7, secureRelocation: 'complete' },
      });
      expect(settlements).toBe(1);
      for (const item of [inertLive, inertCaptured]) {
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        const copied = await readDestructiveJournal(
          join(identity.destination, relative(identity.source, item.path)),
        );
        expect(copied.state).toBe('recovery-required');
        expect(copied.steps).toEqual(item.record.steps);
      }
      expect(await readFile(join(linked, '.git'), 'utf8')).toBe(sourceBacklink);
      expect(await git(managed, 'rev-parse', snapshotRef)).toBe(snapshotCommit);
      expect(
        await git(
          join(identity.destination, 'repos/managed'),
          'rev-parse',
          snapshotRef,
        ),
      ).toBe(snapshotCommit);
      expect(
        await git(
          join(identity.destination, 'workspaces/fixture/worktrees/managed'),
          'symbolic-ref',
          '--short',
          'HEAD',
        ),
      ).toBe('feature\n');

      expect(await readFile(completedHistory.path, 'utf8')).toBe(
        completedHistory.bytes,
      );
      const relocatedHistory = await readDestructiveJournal(
        join(
          identity.destination,
          relative(identity.source, completedHistory.path),
        ),
      );
      const copiedWorkspaceStat = await lstat(
        join(identity.destination, 'workspaces/fixture'),
      );
      expect(relocatedHistory.directoryIdentity).toBe(
        `${copiedWorkspaceStat.dev}:${copiedWorkspaceStat.ino}:${copiedWorkspaceStat.birthtimeMs}:00000000-0000-4000-8000-000000000001`,
      );
      for (const owned of relocatedHistory.ownedPaths) {
        expect(isWithin(identity.destination, owned.path)).toBe(true);
        if (owned.identity !== null) {
          const stat = await lstat(owned.path);
          expect(owned.identity).toBe(
            `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
          );
        }
      }
      await assertCompletedHistoryReaders(relocatedHistory);
      expect(await readFile(conservativeHistory.path, 'utf8')).toBe(
        conservativeHistory.bytes,
      );
      const relocatedConservative = await readDestructiveJournal(
        join(
          identity.destination,
          relative(identity.source, conservativeHistory.path),
        ),
      );
      for (const [path, expectedIdentity] of preserved) {
        const destination = isWithin(identity.source, path)
          ? join(identity.destination, relative(identity.source, path))
          : path;
        expect(
          relocatedConservative.ownedPaths.find(
            (owned) => owned.path === destination,
          )?.identity,
        ).toBe(expectedIdentity);
        if (path === join(identity.source, 'lifecycle-owners', 'file'))
          expect(await readFile(destination, 'utf8')).toBe(
            'Keep the replacement file',
          );
        else
          expect(await readFile(join(destination, 'sentinel'), 'utf8')).toBe(
            'Keep the replacement directory',
          );
      }
      await assertCompletedHistoryReaders(relocatedConservative, false);

      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).not.toThrow();
      for (const [path, bytes] of nonW5) {
        expect(
          await readFile(
            join(identity.destination, 'workspaces', 'fixture', path),
          ),
        ).toEqual(bytes);
        expect(await readFile(join(metadata, path))).toEqual(bytes);
        await assertPrivate(
          join(identity.destination, 'workspaces', 'fixture', path),
          'file',
          0o600,
        );
      }
      const nested = join(
        identity.destination,
        'secure-storage',
        'vault',
        'vault.sqlite',
      );
      expect(await readFile(nested)).toEqual(opaque);
      expect((await lstat(nested)).ino).toBe(secureInode);
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(after);
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'fixture',
              'workspace.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        repos: [
          { repoPath: join(identity.destination, 'repos', 'managed') },
          { repoPath: external },
        ],
        extension: { untouched: identity.source },
      });
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'fixture',
              'worktrees.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        worktrees: [
          {
            creation: {
              checkouts: [
                {
                  repositoryPath: join(
                    identity.destination,
                    'repos',
                    'managed',
                  ),
                  checkoutPath: join(
                    identity.destination,
                    'workspaces',
                    'fixture',
                    'worktrees',
                    'managed',
                  ),
                },
              ],
            },
          },
        ],
      });
      for (const path of [
        join(identity.destination, 'repos', 'managed'),
        join(
          identity.destination,
          'workspaces',
          'fixture',
          'worktrees',
          'managed',
        ),
        external,
        outside,
        join(
          identity.destination,
          'workspaces',
          'fixture',
          'worktrees',
          'external',
        ),
      ]) {
        expect(
          await git(
            path,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ),
        ).toBe(' M tracked\0?? untracked\0');
      }
      expect(
        await readFile(
          join(identity.destination, 'account-proxy-local', 'auths', 'opaque'),
          'utf8',
        ),
      ).toBe('account-bytes');
      expect(
        await statIfPresent(
          join(identity.destination, 'account-proxy-local', 'config.yaml'),
        ),
      ).toBeNull();
      const movedLog = W5CommitLog.open(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
      );
      try {
        expect(
          movedLog.lookupReceipt(receipt, receipt.fingerprint),
        ).toMatchObject({ status: 'replay', outcome: { saved: true } });
        expect(movedLog.listPendingCommits()).toEqual([]);
      } finally {
        movedLog.close();
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'source-changed' });
      // Completion stays authoritative if the predecessor is deleted/recreated.
      await rm(identity.source, { recursive: true });
      await mkdir(identity.source, { mode: 0o700 });
      await writeFile(join(identity.source, 'foreign'), 'new installation');
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).not.toThrow();
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
    },
  );

  test.each([canopy, unstoppableCode])(
    'clones only the $id internal predecessor, preserving the source and requiring explicit rebuild',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      await createPrivateMigrationDirectory(identity.historicalSecure, host);
      const opaque = Buffer.from([0, 255, 42, 22]);
      const readonly = join(identity.source, 'readonly-opaque');
      await writeFile(readonly, opaque);
      await chmod(readonly, 0o400);
      const readonlyBefore = await lstat(readonly);
      const nativeReadonly = host.windows?.inspect(readonly);
      await writeFile(join(identity.historicalSecure, 'opaque'), opaque);
      const before = await worker.inventory(identity);
      expect(
        await migrateInternalRoot(
          worker,
          identity,
          { ...apply, apply: false },
          repairs,
        ),
      ).toMatchObject({
        kind: 'inventory',
        internalDeclaration: true,
        inventory: { files: 2 },
        coldProof: { kind: 'ready' },
      });
      expect(await readdir(home)).toHaveLength(2); // Inventory creates neither lock nor journal.
      const result = await run();
      expect(result.kind).toBe('complete');
      expect(await readFile(readonly)).toEqual(opaque);
      expect(
        await readFile(join(identity.destination, 'readonly-opaque')),
      ).toEqual(opaque);
      if (nativeReadonly) {
        const native = host.windows;
        if (!native) throw new Error('Missing Windows filesystem');
        expect(nativeReadonly.attributes & 1).toBe(1);
        expect(native.inspect(readonly)).toEqual(nativeReadonly);
        expect(
          native.inspect(join(identity.destination, 'readonly-opaque'))
            .attributes,
        ).toBe(nativeReadonly.attributes);
      } else {
        expect((await lstat(readonly)).mode & 0o777).toBe(0o400);
        expect(
          (await lstat(join(identity.destination, 'readonly-opaque'))).mode &
            0o777,
        ).toBe(0o400);
      }
      expect((await lstat(readonly)).mtimeMs).toBe(readonlyBefore.mtimeMs);
      if (result.kind !== 'complete') throw new Error('Expected completion');
      const stableWarning = `Do not start ${brand.displayName} stable until you have checked the new installation and deleted ${identity.source}, because stable uses that folder.`;
      if (brand.id === 'unstoppable-code')
        expect(result.recovery).toContain(stableWarning);
      else
        expect(result.recovery).not.toContain(
          'because stable uses that folder',
        );
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        before.sourceIdentity,
      );
      expect((await worker.inventory(identity)).fingerprint).toBe(
        before.fingerprint,
      );
      expect(
        (await worker.inventory(identity, true)).destinationIdentity,
      ).not.toBe(before.sourceIdentity);
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      expect(
        await readFile(join(identity.destination, 'secure-storage', 'opaque')),
      ).toEqual(opaque);
      const journal = await readFixtureJournal(identity);
      expect(journal).toMatchObject({
        phase: 'complete',
        internalDeclaration: true,
        secureRelocation: 'complete',
      });
      if (!journal) throw new Error('Missing journal');
      expect(await readdir(identity.coordination)).not.toContain(
        'recovery-tree',
      );
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      // Explicit operator recovery removes secure state from the rebuild candidate.
      await rename(
        join(identity.destination, 'secure-storage'),
        identity.historicalSecure,
      );
      await writeFile(
        join(identity.destination, 'preferences.json'),
        'new-build-change',
      );
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([canopy, unstoppableCode])(
    'qualifies published $id Git state, resumes refusal and rebuilds against the modeled C contract',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const execute = promisify(execFile);
      async function git(cwd: string, ...args: string[]): Promise<string> {
        const result = await execute(
          'git',
          [
            '--no-optional-locks',
            '-C',
            cwd,
            '-c',
            `core.hooksPath=${windows ? 'NUL' : '/dev/null'}`,
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Migration fixture',
            '-c',
            'user.email=fixture@example.invalid',
            ...args,
          ],
          {
            cwd,
            env: {
              ...process.env,
              HOME: home,
              GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
            },
          },
        );
        return result.stdout;
      }
      async function seedRepo(path: string): Promise<void> {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await git(path, 'init', '-b', 'main');
        await writeFile(join(path, 'tracked.txt'), 'committed fixture\n');
        await git(path, 'add', 'tracked.txt');
        await git(path, 'commit', '-m', 'Fixture initial state');
      }
      const managed = join(identity.source, 'repos', 'managed');
      const linked = join(identity.source, 'worktrees', 'managed');
      const external = join(home, 'external');
      const externalLinked = join(identity.source, 'worktrees', 'external');
      await seedRepo(managed);
      await seedRepo(external);
      await git(managed, 'worktree', 'add', '-b', 'development', linked);
      await git(
        external,
        'worktree',
        'add',
        '-b',
        'external-development',
        externalLinked,
      );
      for (const path of [managed, linked, externalLinked]) {
        await writeFile(join(path, 'tracked.txt'), 'dirty fixture\n');
        await writeFile(join(path, 'untracked.txt'), 'untracked fixture\n');
      }
      async function observeGit(path: string): Promise<{
        path: string;
        commonDirectory: string;
        head: string;
        branch: string;
        status: string;
      }> {
        return {
          path,
          commonDirectory: resolve(
            (
              await git(
                path,
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              )
            ).trimEnd(),
          ),
          head: (await git(path, 'rev-parse', 'HEAD')).trimEnd(),
          branch: (
            await git(path, 'rev-parse', '--symbolic-full-name', 'HEAD')
          ).trimEnd(),
          status: await git(
            path,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ),
        };
      }
      async function indexEvidence(paths: readonly string[]): Promise<unknown> {
        return Promise.all(
          paths.map(async (checkout) => {
            const path = (
              await git(
                checkout,
                'rev-parse',
                '--path-format=absolute',
                '--git-path',
                'index',
              )
            ).trimEnd();
            const stat = await lstat(path);
            return {
              path,
              contents: await readFile(path),
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              siblings: await readdir(dirname(path)),
            };
          }),
        );
      }
      const readonlyGitObjects: {
        path: string;
        bytes: Buffer;
        attributes: number;
      }[] = [];
      if (host.windows) {
        const objects = join(managed, '.git', 'objects');
        for (const fanout of await readdir(objects)) {
          if (!/^[a-f0-9]{2}$/.test(fanout)) continue;
          for (const name of await readdir(join(objects, fanout))) {
            const path = join(objects, fanout, name);
            const { attributes } = host.windows.inspect(path);
            expect(attributes & 1).toBe(1);
            readonlyGitObjects.push({
              path,
              bytes: await readFile(path),
              attributes,
            });
          }
        }
        expect(readonlyGitObjects.length).toBeGreaterThan(0);
      }
      const frozenGitPlans = new Map<
        string,
        readonly Awaited<ReturnType<typeof observeGit>>[]
      >();
      const repairGitPlans = new Map<
        string,
        Awaited<ReturnType<typeof prepareRelocationGit>>
      >();
      const transition = relocationTransition({
        version: 1,
        installationId: 'fixture',
        brandId: identity.brandId,
        from: {
          authorityId: 'a'.repeat(64),
          canonicalDataRoot: identity.source,
        },
        to: {
          authorityId: 'b'.repeat(64),
          canonicalDataRoot: identity.destination,
        },
      });
      const externalBacklink = join(
        external,
        '.git',
        'worktrees',
        'external',
        'gitdir',
      );
      const externalPreimage = await readFile(externalBacklink);
      await mkdir(join(identity.source, 'ledger'), { mode: 0o700 });
      const ledger = LedgerRepository.open({
        databasePath: join(identity.source, 'ledger', 'ledger.sqlite'),
      });
      const authorityId = ledger.authorityId;
      const binding = {
        authorityId,
        container: {
          kind: 'code_worktree',
          workspaceId: 'fixture',
          worktreeId: 'managed',
        },
        containerCreatedAt: '2026-11-05T00:00:00.000Z',
        accountId: null,
      } satisfies Parameters<typeof ledger.bindScope>[0];
      try {
        ledger.bindScope(binding);
      } finally {
        ledger.close();
      }
      const ledgerPreimage = await readFile(
        join(identity.source, 'ledger', 'ledger.sqlite'),
      );
      const runtime = join(identity.source, 'runtime');
      const metadata = join(identity.source, 'workspaces', 'fixture');
      const proxy = join(identity.source, 'account-proxy-local');
      for (const path of [
        runtime,
        metadata,
        join(identity.source, 'w5'),
        join(proxy, 'auths'),
        identity.historicalSecure,
      ])
        await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(
        join(identity.source, 'build-storage-owner.json'),
        JSON.stringify({ version: 1, brandId: brand.id, build: 'internal' }),
      );
      const index = join(identity.source, 'workspaces', 'index.json');
      const before = JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'fixture',
            name: 'Migration fixture',
            color: 'blue',
            type: 'multi-repo',
          },
        ],
      });
      const after = before.replace(/}$/, ',"settled":true}');
      await writeFile(index, before);
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          name: 'Migration fixture',
          type: 'multi-repo',
          repositories: [
            { id: 'managed', path: managed },
            { id: 'external', path: external },
          ],
        }),
      );
      await writeFile(
        join(metadata, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'managed',
              branchName: 'development',
              createdAt: binding.containerCreatedAt,
              path: linked,
            },
          ],
        }),
      );
      const opaque = Buffer.from([0, 255, 11, 88, 0, 42]);
      await writeFile(join(identity.historicalSecure, 'opaque-vault'), opaque, {
        mode: 0o600,
      });
      await writeFile(join(proxy, 'auths', 'opaque-account'), opaque, {
        mode: 0o600,
      });
      await writeFile(
        join(proxy, 'config.yaml'),
        `auth-dir: ${proxy}/auths\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(proxy, 'process.json'),
        '{"pid":2147483647,"state":"stopped"}',
      );
      await writeFile(
        join(runtime, 'managed-child.json'),
        '{"pid":2147483647,"state":"stopped"}',
      );
      const receipt = {
        caller: authorityId,
        operation: 'core.workspace.update',
        idempotencyKey: 'pending-source-change',
        fingerprint: 'qualified-source-parameters',
      };
      const log = W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      try {
        log.commit({
          operation: 'core.workspace.update',
          receipt,
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      } finally {
        log.close();
      }
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: async (root, qualification): Promise<void> => {
          expect(root).toBe(identity.source);
          expect(await statIfPresent(identity.destination)).toBeNull();
          await fixtureW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            qualification,
          );
          expect(await readFile(index, 'utf8')).toBe(after);
        },
        proveCold: () => Promise.resolve(),
      });
      const original = await worker.inventory(identity);
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, apply: false },
          repairs,
        ),
      ).resolves.toMatchObject({
        kind: 'inventory',
        inventory: {
          historicalSecure: true,
          sourceIdentity: original.sourceIdentity,
        },
      });
      expect(await statIfPresent(identity.coordination)).toBeNull();
      expect(await readFile(index, 'utf8')).toBe(before);
      // Test-only qualified paths, NOT the general CAN-5785 repair implementation.
      repairs = {
        prepare: async (
          context,
        ): ReturnType<InternalRootRepairs['prepare']> => {
          // C observes an absent destination and inventories Git from the old root.
          if (await statIfPresent(identity.destination))
            return { kind: 'refused', recovery: 'existing destination' };
          const paths = [managed, linked, external, externalLinked];
          for (const checkout of paths) {
            const records = (
              await git(checkout, 'worktree', 'list', '--porcelain', '-z')
            ).split('\0\0');
            // C git.ts observe() requires this exact checkout before its
            // complete-common-repository membership check can run.
            const entry = records
              .map((record) => record.split('\0'))
              .find((fields) =>
                fields.some(
                  (field) =>
                    field.startsWith('worktree ') &&
                    resolve(field.slice(9)) === checkout,
                ),
              );
            const head = entry
              ?.find((field) => field.startsWith('HEAD '))
              ?.slice(5);
            const branch = entry?.includes('detached')
              ? 'HEAD'
              : entry?.find((field) => field.startsWith('branch '))?.slice(7);
            if (
              !head ||
              !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
              !branch
            )
              return { kind: 'refused', recovery: 'unreadable-git-checkout' };
            for (const record of records) {
              if (record.split('\0').includes('bare')) continue;
              for (const field of record.split('\0'))
                if (
                  field.startsWith('worktree ') &&
                  !paths.includes(resolve(field.slice(9)))
                )
                  return {
                    kind: 'refused',
                    recovery: 'uninventoried-git-checkout',
                  };
            }
          }
          if (!(await readFile(externalBacklink)).equals(externalPreimage))
            return { kind: 'refused', recovery: 'changed backlink' };
          frozenGitPlans.set(
            context.transactionId,
            await Promise.all(paths.map(observeGit)),
          );
          repairGitPlans.set(
            context.transactionId,
            await prepareRelocationGit(
              (cwd, args) => git(cwd, ...args),
              paths,
              { portableFilesystem: process.platform !== 'darwin' },
            ),
          );
          return { kind: 'ready', externalFiles: [externalBacklink] };
        },
        repair: async (context): ReturnType<InternalRootRepairs['repair']> => {
          assertCWorkingRoot(context);
          const plan = repairGitPlans.get(context.transactionId);
          if (!plan)
            return {
              kind: 'refused',
              recovery: 'Missing frozen Git repair plan.',
            };
          if (host.windows) {
            for (const source of [linked, externalLinked]) {
              const sourceAttributes = host.windows.inspect(
                join(source, '.git'),
              ).attributes;
              const copiedAttributes = host.windows.inspect(
                join(
                  context.workingRoot,
                  relative(identity.source, source),
                  '.git',
                ),
              ).attributes;
              expect(sourceAttributes & 1).toBe(0);
              expect(sourceAttributes & 2).toBe(2);
              expect(copiedAttributes).toBe(sourceAttributes);
            }
          }
          // Git's hidden .git cannot be opened with CREATE_ALWAYS on Windows.
          // Exercise the real attribute-preserving repair, not a writeFile model.
          await repairRelocationGit(transition, plan, context.workingRoot);
          await writeFile(
            join(context.workingRoot, 'account-proxy-local', 'config.yaml'),
            `auth-dir: ${identity.destination}/account-proxy-local/auths\n`,
            { mode: 0o600 },
          );
          await rm(
            join(context.workingRoot, 'account-proxy-local', 'process.json'),
          );
          await rm(join(context.workingRoot, 'runtime', 'managed-child.json'));
          return { kind: 'ok' };
        },
        verify: async (context): ReturnType<InternalRootRepairs['verify']> => {
          assertCWorkingRoot(context);
          expect(await statIfPresent(identity.destination)).toBeNull();
          expect(
            await readFile(
              join(context.workingRoot, 'worktrees', 'managed', '.git'),
              'utf8',
            ),
          ).toBe(
            `gitdir: ${gitBacklinkText(identity.destination, join(identity.destination, 'repos/managed/.git/worktrees/managed'), true)}\n`,
          );
          expect(await readFile(externalBacklink, 'utf8')).toBe(
            `${gitBacklinkText(identity.destination, join(identity.destination, 'worktrees/external/.git'), true)}\n`,
          );
          return { kind: 'ok' };
        },
        qualifyPublished: async (
          context,
        ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
          expect(context.workingRoot).toBe(identity.destination);
          expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
          expect((await readFixtureJournal(identity))?.phase).toBe(
            'publishing',
          );
          const plan = frozenGitPlans.get(context.transactionId);
          if (!plan)
            return { kind: 'refused', recovery: 'Missing frozen Git plan.' };
          const project = (path: string): string =>
            path.replace(identity.source, identity.destination);
          const expected = plan.map((checkout) => ({
            ...checkout,
            path: project(checkout.path),
            commonDirectory: project(checkout.commonDirectory),
          }));
          const paths = expected.map((checkout) => checkout.path);
          const indexes = await indexEvidence(paths);
          const before = await worker.inventory(identity, true);
          const actual = await Promise.all(
            expected.map((checkout) => observeGit(checkout.path)),
          );
          expect((await worker.inventory(identity, true)).fingerprint).toBe(
            before.fingerprint,
          );
          expect(await indexEvidence(paths)).toEqual(indexes);
          return JSON.stringify(actual) === JSON.stringify(expected)
            ? { kind: 'ok' }
            : {
                kind: 'refused',
                recovery: 'Published Git state differs from the frozen plan.',
              };
        },
      };
      const verifyPublished = async (): Promise<void> => {
        const movedPaths = [managed, linked, externalLinked].map((path) =>
          path.replace(identity.source, identity.destination),
        );
        expect(
          await git(external, 'worktree', 'list', '--porcelain'),
        ).toContain(
          join(identity.destination, 'worktrees/external').replaceAll(
            '\\',
            '/',
          ),
        );
        expect(
          await git(movedPaths[0] ?? '', 'worktree', 'list', '--porcelain'),
        ).not.toContain(identity.source.replaceAll('\\', '/') + '/');
      };
      const prepare = jest.spyOn(repairs, 'prepare');
      const repair = jest.spyOn(repairs, 'repair');
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      const publish = worker.publish.bind(worker);
      const externalHeadPath = join(external, '.git', 'HEAD');
      const externalHead = await readFile(externalHeadPath);
      worker.publish = async (journal): Promise<void> => {
        await publish(journal);
        // An external checkout can drift without changing B's root/backlink seal.
        await writeFile(
          externalHeadPath,
          'ref: refs/heads/external-development\n',
        );
      };
      await expectPublishedRefusal();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(await statIfPresent(identity.destination)).not.toBeNull();
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      worker.publish = publish;
      await expectPublishedRefusal();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(qualify).toHaveBeenCalledTimes(2);
      await writeFile(externalHeadPath, externalHead);
      const result = await run();
      expect(qualify).toHaveBeenCalledTimes(3);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe('complete');
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        original.sourceIdentity,
      );
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing qualification journal');
      expect(journal).toMatchObject({
        phase: 'complete',
        secureRelocation: 'complete',
      });
      expect((await worker.inventory(identity)).fingerprint).toBe(
        journal.settledFingerprint,
      );
      expect(journal.externalFiles).toEqual([externalBacklink]);
      const preimageNames = (await readdir(identity.coordination)).filter(
        (name) => name.endsWith('.preimage'),
      );
      expect(preimageNames).toHaveLength(1);
      for (const name of preimageNames) {
        const path = join(identity.coordination, name);
        await assertPrivate(path, 'file', 0o600);
        expect(await readFile(path)).toEqual(externalPreimage);
      }
      expect(await readFile(externalBacklink)).not.toEqual(externalPreimage);
      await verifyPublished();
      for (const object of readonlyGitObjects) {
        expect(await readFile(object.path)).toEqual(object.bytes);
        expect(host.windows?.inspect(object.path).attributes).toBe(
          object.attributes,
        );
        const copied = object.path.replace(
          identity.source,
          identity.destination,
        );
        expect(await readFile(copied)).toEqual(object.bytes);
        expect(host.windows?.inspect(copied).attributes).toBe(
          object.attributes,
        );
      }
      const preparationContext = {
        identity,
        transactionId: journal.transactionId,
        inventory: journal.inventory,
        workingRoot: worker.stagingRoot(identity),
        externalFiles: journal.externalFiles,
      };
      await expect(repairs.prepare(preparationContext)).resolves.toMatchObject({
        kind: 'refused',
        recovery: 'existing destination',
      });
      const temporarilyHidden = `${identity.destination}.fixture-probe`;
      await rename(identity.destination, temporarilyHidden);
      try {
        // Removing only the destination does not repair old-root Git inventory.
        await expect(
          repairs.prepare(preparationContext),
        ).resolves.toMatchObject({
          kind: 'refused',
        });
      } finally {
        await rename(temporarilyHidden, identity.destination);
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      await rename(
        join(identity.destination, 'secure-storage'),
        identity.historicalSecure,
      );
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(4);
      await verifyPublished();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        journal.settledFingerprint,
      );
      expect(await readFile(externalBacklink, 'utf8')).toBe(
        `${gitBacklinkText(identity.destination, join(identity.destination, 'worktrees/external/.git'), true)}\n`,
      );
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(after);
      expect(
        await readFile(join(identity.destination, 'ledger', 'ledger.sqlite')),
      ).toEqual(ledgerPreimage);
      const movedLedger = LedgerRepository.open({
        databasePath: join(identity.destination, 'ledger', 'ledger.sqlite'),
      });
      try {
        expect(movedLedger.authorityId).toBe(authorityId);
        expect(movedLedger.findScope(binding)?.scope.authorityId).toBe(
          authorityId,
        );
      } finally {
        movedLedger.close();
      }
      const settled = W5CommitLog.open(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
      );
      try {
        expect(settled.listPendingCommits()).toEqual([]);
        expect(
          settled.lookupReceipt(receipt, receipt.fingerprint),
        ).toMatchObject({ status: 'replay', outcome: { saved: true } });
      } finally {
        settled.close();
      }
      const historical = new DatabaseSync(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          historical
            .prepare(
              'SELECT path, previous_fingerprint, new_fingerprint FROM w5_commit_files',
            )
            .all(),
        ).toEqual([
          {
            path: index,
            previous_fingerprint: fingerprintW5File(before),
            new_fingerprint: fingerprintW5File(after),
          },
        ]);
      } finally {
        historical.close();
      }
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'opaque-vault'),
        ),
      ).toEqual(opaque);
      expect(
        await statIfPresent(join(identity.destination, 'secure-storage')),
      ).not.toBeNull();
      expect(
        await readFile(
          join(
            identity.destination,
            'account-proxy-local',
            'auths',
            'opaque-account',
          ),
        ),
      ).toEqual(opaque);
      expect(
        await readFile(
          join(identity.destination, 'account-proxy-local', 'config.yaml'),
          'utf8',
        ),
      ).toContain(identity.destination);
      expect(
        await statIfPresent(
          join(identity.destination, 'account-proxy-local', 'process.json'),
        ),
      ).toBeNull();
      expect(
        await statIfPresent(
          join(identity.destination, 'runtime', 'managed-child.json'),
        ),
      ).toBeNull();
    },
  );

  test('an existing empty predecessor clones without inventing W5 state', async () => {
    await createPrivateMigrationDirectory(identity.source, host);
    const original = await worker.inventory(identity);
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(await readdir(identity.source)).toEqual([]);
    expect(await readdir(identity.destination)).toEqual([]);
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
  });

  test.each(['dangling gitdir', 'empty .git directory'])(
    'apply names a dangling or empty .git checkout under the source root without changing it (%s)',
    async (layout) => {
      await source();
      const checkout = join(identity.source, 'repos', 'broken checkout');
      await mkdir(checkout, { recursive: true });
      const dotGit = join(checkout, '.git');
      const contents = `gitdir: ${join(home, 'missing-repository', '.git', 'worktrees', 'broken')}\n`;
      if (layout === 'dangling gitdir') await writeFile(dotGit, contents);
      else await mkdir(dotGit);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const before = await worker.inventory(identity);
      const error: unknown = await run().catch((error: unknown) => error);
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(JSON.stringify(checkout)),
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('--abandon-checkout'),
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(
          'git --no-optional-locks worktree list --porcelain -z',
        ),
      );
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining('fatal:'),
      );
      if (layout === 'dangling gitdir')
        expect(await readFile(dotGit, 'utf8')).toBe(contents);
      else expect(await readdir(dotGit)).toEqual([]);
      expect(await worker.inventory(identity)).toEqual(before);
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(
        await statIfPresent(`${identity.destination}.migration-staging`),
      ).toBeNull();

      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        abandonCheckouts: [checkout],
      });
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      const after = await worker.inventory(identity);
      expect(after.sourceIdentity).toBe(before.sourceIdentity);
      expect(after.fingerprint).toBe(before.fingerprint);
      if (layout === 'dangling gitdir')
        expect(await readFile(dotGit, 'utf8')).toBe(contents);
      else expect(await readdir(dotGit)).toEqual([]);
      expect(
        await statIfPresent(
          join(identity.destination, 'repos', 'broken checkout'),
        ),
      ).toBeNull();
      expect(
        (await worker.readJournal(identity))?.repairPlan?.abandonedCheckouts,
      ).toEqual([checkout]);
      await checkInstalledShape();
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
      const report = await reportInternalRootCleanup(
        identity,
        true,
        host,
        before.bytes,
        [],
        [checkout],
      );
      expect(report.entries).toContainEqual({
        path: checkout,
        bytes: layout === 'dangling gitdir' ? Buffer.byteLength(contents) : 0,
        category: 'abandoned-archive',
        disposition: 'review before deleting',
        reason: `Broken checkout ${JSON.stringify(checkout)}: explicitly omitted from migration; retained in the old root.`,
        copy: 'old-root',
        restoreSource: identity.source,
      });
      expect(report.warnings).toEqual([]);
    },
  );

  test.each([
    'healthy',
    'outside',
    'missing',
    'no .git',
    'source root',
    'symlink',
    'Git runtime failure',
  ])('checkout abandonment refuses %s without source changes', async (kind) => {
    await source();
    const checkout =
      kind === 'outside'
        ? join(home, 'outside')
        : join(identity.source, 'repos', 'candidate');
    await mkdir(checkout, { recursive: true });
    if (kind === 'healthy' || kind === 'Git runtime failure')
      await promisify(execFile)('git', ['init', checkout]);
    else if (kind !== 'no .git')
      await writeFile(join(checkout, '.git'), 'gitdir: /missing/repository\n');
    if (kind === 'Git runtime failure')
      await writeFile(join(checkout, '.git', 'config'), '[invalid config\n');
    let requested = checkout;
    if (kind === 'missing') requested = join(identity.source, 'missing');
    if (kind === 'source root') requested = identity.source;
    if (kind === 'symlink') {
      requested = join(identity.source, 'alias');
      await symlink(checkout, requested, 'dir');
    }
    const before = await worker.inventory(identity);
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
      abandonCheckouts: [requested],
    });
    const result = run();
    await expect(result).rejects.toThrow(
      kind === 'Git runtime failure'
        ? `Git command failed at ${JSON.stringify(requested)}: git --no-optional-locks rev-parse --absolute-git-dir`
        : `--abandon-checkout ${JSON.stringify(requested)} must name a broken checkout directory under ${JSON.stringify(identity.source)}; preserve the folder.`,
    );
    if (kind === 'Git runtime failure')
      await expect(result).rejects.toThrow('fatal: bad config line');
    expect(await worker.inventory(identity)).toEqual(before);
    expect(await statIfPresent(identity.destination)).toBeNull();
  });

  test.each(['moved', 'repaired', 'aliased parent'])(
    'inventory refreshes cleanup after a frozen abandoned checkout is %s',
    async (action) => {
      await source();
      const execute = promisify(execFile);
      const repository = join(home, 'repository');
      const displaced = join(home, 'displaced-repository');
      const checkout = join(identity.source, 'repos', 'abandoned');
      await execute('git', ['init', repository]);
      await execute('git', [
        '-C',
        repository,
        '-c',
        'user.name=Migration fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Fixture',
      ]);
      await execute('git', [
        '-C',
        repository,
        'worktree',
        'add',
        '--detach',
        checkout,
      ]);
      await writeFile(join(checkout, 'keep.txt'), 'unique work');
      await rename(repository, displaced);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        abandonCheckouts: [checkout],
      });
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      if (action === 'moved') {
        await rename(checkout, join(home, 'kept-aside'));
      } else if (action === 'aliased parent') {
        const parent = join(identity.source, 'repos');
        const retained = join(home, 'kept-repos');
        await rename(parent, retained);
        await symlink(retained, parent, 'dir');
      } else {
        await rename(displaced, repository);
        await execute('git', [
          '-C',
          repository,
          'worktree',
          'repair',
          checkout,
        ]);
        await execute('git', [
          '-C',
          checkout,
          'rev-parse',
          '--absolute-git-dir',
        ]);
      }
      const frozen = (await worker.readJournal(identity))?.repairPlan;
      const selected = selectInternalRootArchiveAbandonments(
        [],
        frozen?.abandonedCheckouts,
        'Checkout',
      );
      expect(selected).toEqual([checkout]);
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { apply: false, declareInternal: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'inventory' });
      const report = await reportInternalRootCleanup(
        identity,
        true,
        host,
        undefined,
        [],
        selected,
      );
      expect(report.entries.filter((entry) => entry.path === checkout)).toEqual(
        action === 'repaired'
          ? [
              expect.objectContaining({
                path: checkout,
                disposition: 'review before deleting',
                copy: 'old-root',
              }),
            ]
          : [],
      );
      if (action === 'aliased parent')
        expect(report.warnings).toContain(
          `Could not fully inspect ${JSON.stringify(checkout)}; do not infer that unlisted data is disposable.`,
        );
      else expect(report.warnings).toEqual([]);
      expect(await readFile(report.reportPath, 'utf8')).toBe(
        `${JSON.stringify(report)}\n`,
      );
      const retained = action === 'moved' ? join(home, 'kept-aside') : checkout;
      expect(await readFile(join(retained, 'keep.txt'), 'utf8')).toBe(
        'unique work',
      );
      expect(
        await statIfPresent(join(identity.destination, 'repos', 'abandoned')),
      ).toBeNull();
    },
  );

  test.each(
    [
      'GIT_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ].flatMap((key) => ['healthy', 'broken'].map((kind) => ({ key, kind }))),
  )(
    'checkout abandonment probes the actual $kind checkout despite inherited $key',
    async ({ key, kind }) => {
      await source();
      const checkout = join(identity.source, 'repos', 'candidate');
      const otherRepository = join(home, 'other-repository');
      const execute = promisify(execFile);
      await execute('git', ['init', otherRepository]);
      await mkdir(checkout, { recursive: true });
      if (kind === 'healthy') await execute('git', ['init', checkout]);
      else
        await writeFile(
          join(checkout, '.git'),
          'gitdir: /missing/repository\n',
        );
      const before = await worker.inventory(identity);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        abandonCheckouts: [checkout],
      });
      const previous = process.env[key];
      try {
        process.env[key] =
          key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS'
            ? 'invalid'
            : kind === 'healthy'
              ? join(home, 'missing-repository')
              : join(otherRepository, '.git');
        if (kind === 'healthy')
          await expect(run()).rejects.toThrow('--abandon-checkout');
        else await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      const after = await worker.inventory(identity);
      expect(after.sourceIdentity).toBe(before.sourceIdentity);
      expect(after.fingerprint).toBe(before.fingerprint);
      expect(
        await statIfPresent(join(identity.destination, 'repos', 'candidate')),
      ).toBeNull();
      if (kind === 'healthy')
        expect(await statIfPresent(identity.destination)).toBeNull();
    },
  );

  test('fresh start refuses retained migration evidence after interrupted restart', async () => {
    await source();
    worker.build = (): ReturnType<InternalRootMigrationWorker['build']> =>
      Promise.reject(new Error('before copy'));
    await expect(run()).rejects.toThrow('before copy');
    const old = await worker.readJournal(identity);
    if (!old) throw new Error('Missing stopped transaction');
    const preserve = worker.preserveUnpublished.bind(worker);
    worker.preserveUnpublished = async (journal, checkOnly): Promise<void> => {
      await preserve(journal, checkOnly);
      if (!checkOnly) throw new Error('after preservation');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, restart: true },
        repairs,
      ),
    ).rejects.toThrow('after preservation');
    expect(await worker.readJournal(identity)).toBeNull();
    expect(startup).toThrow();
    await expect(freshStart()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect(
      await statIfPresent(join(home, '.canopy-internal-startup.json')),
    ).toBeNull();
    expect(
      await statIfPresent(
        join(
          identity.coordination,
          `restarted-${old.transactionId}`,
          'journal.json',
        ),
      ),
    ).not.toBeNull();
  });

  test.each([
    'after-preservation',
    'after-prepared',
    'after-second-preservation',
  ])(
    'restart retains combined abandonment selections when interrupted %s',
    async (cut) => {
      await source();
      const archive = await strandedArchiveFixture(
        identity.source,
        'P0',
        'crow',
      );
      const checkout = join(identity.source, 'repos', 'broken checkout');
      await mkdir(checkout, { recursive: true });
      await writeFile(join(checkout, '.git'), 'gitdir: /missing/repository\n');
      await writeFile(join(checkout, 'keep.txt'), 'unique work');
      const selected = {
        abandonArchives: ['fixture/crow'],
        abandonCheckouts: [checkout],
      };
      const newRepairs = (choices = selected): InternalRootRepairs =>
        createInternalRootRelocationRepairs({
          ...nativeRepairOptions(),
          durability: desktopW5Durability,
          ...choices,
        });
      repairs = newRepairs();
      const build = worker.build.bind(worker);
      worker.build = (): ReturnType<InternalRootMigrationWorker['build']> =>
        Promise.reject(new Error('before copy'));
      await expect(run()).rejects.toThrow('before copy');
      worker.build = build;
      const old = await worker.readJournal(identity);
      if (!old) throw new Error('Missing frozen transaction');
      const saved = await readFile(join(identity.coordination, 'journal.json'));
      const preserve = worker.preserveUnpublished.bind(worker);
      if (cut === 'after-preservation')
        worker.preserveUnpublished = async (
          journal,
          checkOnly,
        ): Promise<void> => {
          await preserve(journal, checkOnly);
          if (!checkOnly) throw new Error('interrupted restart');
        };
      else
        worker.recoverW5 = (): Promise<void> =>
          Promise.reject(new Error('interrupted restart'));
      await writeFile(join(identity.source, 'new-work'), 'current source');
      if (!windows && cut === 'after-preservation') {
        const move = fs.rename;
        const interrupted = jest
          .spyOn(fs, 'rename')
          .mockImplementation(async (from, to) => {
            if (to === join(identity.coordination, 'restart.json'))
              throw new Error('pointer replacement interrupted');
            await move(from, to);
          });
        try {
          await expect(
            migrateInternalRoot(
              worker,
              identity,
              { ...apply, restart: true },
              repairs,
            ),
          ).rejects.toThrow('pointer replacement interrupted');
        } finally {
          interrupted.mockRestore();
        }
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, restart: true },
          repairs,
        ),
      ).rejects.toThrow('interrupted restart');
      worker.preserveUnpublished = preserve;
      worker.recoverW5 = (): Promise<void> => Promise.resolve();
      if (cut === 'after-second-preservation') {
        worker.preserveUnpublished = async (
          journal,
          checkOnly,
        ): Promise<void> => {
          await preserve(journal, checkOnly);
          if (!checkOnly) throw new Error('interrupted restart');
        };
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { ...apply, restart: true },
            repairs,
          ),
        ).rejects.toThrow('interrupted restart');
        worker.preserveUnpublished = preserve;
      }
      // Match CLI selection after a fresh invocation with neither abandonment flag.
      const plan = await readInternalRootAbandonmentPlan(
        identity,
        await worker.readJournal(identity),
        host,
      );
      const frozenArchives = plan?.lifecycleJournals?.flatMap((entry) =>
        entry.abandoned
          ? [`${entry.abandoned.workspaceId}/${entry.abandoned.worktreeId}`]
          : [],
      );
      const choices = {
        abandonArchives: [
          ...selectInternalRootArchiveAbandonments(
            [],
            plan ? (frozenArchives ?? []) : undefined,
          ),
        ],
        abandonCheckouts: [
          ...selectInternalRootArchiveAbandonments(
            [],
            plan ? (plan.abandonedCheckouts ?? []) : undefined,
            'Checkout',
          ),
        ],
      };
      expect(choices).toEqual(selected);
      const marker = join(identity.coordination, 'restart.json');
      const markerBytes = await readFile(marker);
      const restartMarker: unknown = JSON.parse(markerBytes.toString('utf8'));
      if (
        typeof restartMarker !== 'object' ||
        restartMarker === null ||
        !('transactionId' in restartMarker)
      )
        throw new Error('Missing restart transaction');
      expect(restartMarker.transactionId).toBe(old.transactionId);
      const current = await worker.readJournal(identity);
      await writeFile(
        marker,
        JSON.stringify({ version: 1, transactionId: '../outside' }),
      );
      await expect(
        readInternalRootAbandonmentPlan(identity, current, host),
      ).rejects.toThrow(JSON.stringify(marker));
      await writeFile(marker, markerBytes);
      expect(() =>
        selectInternalRootArchiveAbandonments(
          ['fixture/other'],
          choices.abandonArchives,
        ),
      ).toThrow('already frozen');
      expect(() =>
        selectInternalRootArchiveAbandonments(
          [join(identity.source, 'repos/other')],
          choices.abandonCheckouts,
          'Checkout',
        ),
      ).toThrow('already frozen');
      await rename(join(checkout, '.git'), join(home, 'broken-git'));
      execFileSync('git', ['init', '-q', checkout]);
      // Report refresh is advisory; new construction must still reject a healed checkout.
      const cleanupEntries: unknown = expect.arrayContaining([
        expect.objectContaining({ path: checkout, copy: 'old-root' }),
      ]);
      await expect(
        reportInternalRootCleanup(
          identity,
          false,
          host,
          undefined,
          choices.abandonArchives,
          choices.abandonCheckouts,
        ),
      ).resolves.toMatchObject({
        entries: cleanupEntries,
      });
      repairs = newRepairs(choices);
      await expect(run()).rejects.toThrow('must name a broken checkout');
      await rm(join(checkout, '.git'), { recursive: true });
      await rename(join(home, 'broken-git'), join(checkout, '.git'));
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(
        await readFile(
          join(
            identity.coordination,
            `restarted-${old.transactionId}`,
            'journal.json',
          ),
        ),
      ).toEqual(saved);
      expect(await readFile(archive.path, 'utf8')).toBe(archive.bytes);
      expect(await readFile(join(checkout, 'keep.txt'), 'utf8')).toBe(
        'unique work',
      );
      expect(
        await statIfPresent(
          join(identity.destination, relative(identity.source, checkout)),
        ),
      ).toBeNull();
      expect(
        await statIfPresent(
          join(identity.destination, relative(identity.source, archive.path)),
        ),
      ).toBeNull();
      const report = await reportInternalRootCleanup(
        identity,
        true,
        host,
        undefined,
        choices.abandonArchives,
        choices.abandonCheckouts,
      );
      expect(report.entries).toContainEqual(
        expect.objectContaining({
          path: checkout,
          copy: 'old-root',
          disposition: 'review before deleting',
        }),
      );
      expect(
        await readFile(join(identity.destination, 'new-work'), 'utf8'),
      ).toBe('current source');
    },
  );

  test.each(['resume', 'restart'])(
    'checkout abandonment preserves multiple frozen omissions on %s after interruption',
    async (mode) => {
      await source();
      const checkouts = ['first broken', 'second broken'].map((name) =>
        join(identity.source, 'repos', name),
      );
      const contents = 'gitdir: /missing/repository\n';
      for (const checkout of checkouts) {
        await mkdir(checkout, { recursive: true });
        await writeFile(join(checkout, '.git'), contents);
        await writeFile(join(checkout, 'keep.txt'), 'unique work');
      }
      const before = await worker.inventory(identity);
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        abandonCheckouts: checkouts,
      });
      const build = worker.build.bind(worker);
      worker.build = (): ReturnType<InternalRootMigrationWorker['build']> =>
        Promise.reject(new Error('interrupted before copy'));
      await expect(run()).rejects.toThrow('interrupted before copy');
      worker.build = build;
      await checkInstalledShape();
      const old = await worker.readJournal(identity);
      const oldJournalContents = await readFile(
        join(identity.coordination, 'journal.json'),
        'utf8',
      );
      const frozen = old?.repairPlan;
      expect(frozen?.abandonedCheckouts).toEqual(checkouts);
      expect(() =>
        selectInternalRootArchiveAbandonments(
          checkouts.slice(0, 1),
          frozen?.abandonedCheckouts,
          'Checkout',
        ),
      ).toThrow('Checkout abandonment is already frozen');
      let expected = before;
      if (mode === 'restart') {
        await writeFile(
          join(identity.source, 'continued-work'),
          'keep new work',
        );
        await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
        expected = await worker.inventory(identity);
      }
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        ...(mode === 'restart'
          ? {
              abandonCheckouts: selectInternalRootArchiveAbandonments(
                [],
                frozen?.abandonedCheckouts,
                'Checkout',
              ),
            }
          : {}),
      });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          {
            ...apply,
            restart: mode === 'restart',
          },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      if (mode === 'restart') {
        if (!old) throw new Error('Missing stopped transaction');
        const retained = join(
          identity.coordination,
          `restarted-${old.transactionId}`,
        );
        expect(await readFile(join(retained, 'journal.json'), 'utf8')).toBe(
          oldJournalContents,
        );
        expect((await worker.readJournal(identity))?.transactionId).not.toBe(
          old.transactionId,
        );
        expect(
          await readFile(join(identity.destination, 'continued-work'), 'utf8'),
        ).toBe('keep new work');
      }
      expect(
        (await worker.readJournal(identity))?.repairPlan?.abandonedCheckouts,
      ).toEqual(checkouts);
      const after = await worker.inventory(identity);
      expect(after.sourceIdentity).toBe(before.sourceIdentity);
      expect(after.fingerprint).toBe(expected.fingerprint);
      const report = await reportInternalRootCleanup(
        identity,
        true,
        host,
        expected.bytes,
        [],
        selectInternalRootArchiveAbandonments(
          [],
          frozen?.abandonedCheckouts,
          'Checkout',
        ),
      );
      for (const checkout of checkouts) {
        expect(await readFile(join(checkout, '.git'), 'utf8')).toBe(contents);
        expect(await readFile(join(checkout, 'keep.txt'), 'utf8')).toBe(
          'unique work',
        );
        expect(
          await statIfPresent(
            join(identity.destination, relative(identity.source, checkout)),
          ),
        ).toBeNull();
        expect(report.entries.find((entry) => entry.path === checkout)).toEqual(
          {
            path: checkout,
            bytes:
              Buffer.byteLength(contents) + Buffer.byteLength('unique work'),
            category: 'abandoned-archive',
            disposition: 'review before deleting',
            reason: `Broken checkout ${JSON.stringify(checkout)}: explicitly omitted from migration; retained in the old root.`,
            copy: 'old-root',
            restoreSource: identity.source,
          },
        );
      }
    },
  );

  test('the repository script cannot mutate before CAN-5785 is installed', async () => {
    await source();
    await expect(
      migrateInternalRoot(worker, identity, apply),
    ).rejects.toMatchObject({ reason: 'repair-unavailable' });
    expect(await readdir(home)).toEqual(['.canopy']);
  });

  test('inventory reports live writers and apply refuses them before the unavailable repair port without creating coordination', async () => {
    await source();
    const proveCold = jest.fn<Promise<void>, []>(() =>
      Promise.reject(
        new InternalRootMigrationRefused(
          'writer-active',
          'A managed child remains active.',
        ),
      ),
    );
    worker = { ...worker, proveCold };
    await expect(
      migrateInternalRoot(worker, identity, {
        apply: false,
        declareInternal: false,
      }),
    ).resolves.toMatchObject({
      kind: 'inventory',
      inventory: { files: 1 },
      coldProof: {
        kind: 'refused',
        reason: 'writer-active',
        recovery: 'A managed child remains active.',
      },
    });
    await expect(
      migrateInternalRoot(worker, identity, apply),
    ).rejects.toMatchObject({ reason: 'writer-active' });
    expect(proveCold).toHaveBeenCalledTimes(2);
    expect(await readdir(home)).toEqual(['.canopy']);
    expect(recover).not.toHaveBeenCalled();
  });

  test('requires the explicit UC declaration and rejects contradictory stable or nested secure ownership', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    await source();
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: false },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'inventory', internalDeclaration: false });
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: true, declareInternal: false },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'ownership-required' });
    await mkdir(join(identity.source, 'secure-storage'), { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    await rm(join(identity.source, 'secure-storage'), { recursive: true });
    await writeFile(
      join(identity.source, 'build-storage-owner.json'),
      JSON.stringify({
        version: 1,
        brandId: 'unstoppable-code',
        build: 'stable',
      }),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });

  test('a resumed UC transaction still refuses newly discovered nested secure ownership', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    await source();
    recover.mockRejectedValueOnce(new Error('interrupted source recovery'));
    await expect(run()).rejects.toThrow('interrupted source recovery');
    await mkdir(join(identity.source, 'secure-storage'), { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await statIfPresent(identity.destination)).toBeNull();
  });

  test('empty and secure-only sources never create a synthetic predecessor', async () => {
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    await createPrivateMigrationDirectory(identity.historicalSecure, host);
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });

  test('does not overwrite an independent destination or follow an alias', async () => {
    await source();
    await createPrivateMigrationDirectory(identity.destination, host);
    const destinationData = join(identity.destination, 'created-after-478');
    await writeFile(destinationData, 'keep my data');
    await expect(run()).rejects.toMatchObject({
      reason: 'destination-exists',
    });
    await expect(run()).rejects.toThrow(JSON.stringify(identity.destination));
    await expect(run()).rejects.toThrow('never delete it');
    const inventory = await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    if (inventory.kind !== 'inventory') throw new Error('Expected inventory');
    expect(inventory.preflight.blockers.join('\n')).toContain(
      'data created after an internal-478 launch',
    );
    expect(await readFile(destinationData, 'utf8')).toBe('keep my data');
    await rm(identity.destination, { recursive: true });
    await symlink(
      identity.source,
      identity.destination,
      windows ? 'junction' : 'dir',
    );
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
  });

  test.each([
    {},
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 8 },
    { version: 1, phase: 'invented' },
  ])('refuses unknown journals without altering either tree', async (raw) => {
    await source();
    await createPrivateMigrationDirectory(identity.coordination, host);
    const path = join(identity.coordination, 'journal.json');
    await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
    const before = await readdir(identity.coordination);
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, apply: false },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'journal-unsupported' });
    expect(await readdir(identity.coordination)).toEqual(before);
  });

  test('refuses an otherwise valid completed v5 journal for inventory, apply and rebuild', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing completed journal');
    const path = join(identity.coordination, 'journal.json');
    const legacy = JSON.stringify({ ...journal, version: 5 });
    await writeFile(path, legacy, { mode: 0o600 });
    const original = await worker.inventory(identity);
    const destination = await worker.inventory(identity, true);
    const prepare = jest.spyOn(repairs, 'prepare');
    const qualify = jest.spyOn(repairs, 'qualifyPublished');
    for (const options of [
      { ...apply, apply: false },
      apply,
      { ...apply, rebuild: true },
    ]) {
      await expect(
        migrateInternalRoot(worker, identity, options, repairs),
      ).rejects.toMatchObject({ reason: 'journal-unsupported' });
      expect(await readFile(path, 'utf8')).toBe(legacy);
      expect(await worker.inventory(identity)).toEqual(original);
      expect(await worker.inventory(identity, true)).toEqual(destination);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(qualify).not.toHaveBeenCalled();
  });

  test('concurrent invocations cannot share the non-moving SQLite exclusion', async () => {
    await source();
    const release = await worker.coordinate(identity);
    try {
      await expect(worker.coordinate(identity)).rejects.toMatchObject({
        reason: 'coordination-held',
      });
    } finally {
      await release();
    }
    const again = await worker.coordinate(identity);
    await again();
  });

  test('preparation cannot reuse a journal changed within the same transaction while acquiring coordination', async () => {
    await source();
    await run();
    const coordinate = worker.coordinate.bind(worker);
    const save = worker.saveJournal.bind(worker);
    worker = {
      ...worker,
      coordinate: async (
        selected,
      ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
        const release = await coordinate(selected);
        try {
          const journal = await readFixtureJournal(selected);
          if (!journal) throw new Error('Missing journal');
          await save({
            ...journal,
            internalDeclaration: !journal.internalDeclaration,
          });
          return release;
        } catch (error) {
          await release();
          throw error;
        }
      },
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
  });

  test.each([false, true])(
    'cold recovery qualification is revoked on callback exit (failure=%s), with no preferences-only worker',
    async (fail) => {
      await source();
      const qualifications: InternalRootColdRecovery[] = [];
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          qualifications.push(qualification);
          await expect(qualification.assertHeld()).resolves.toBeUndefined();
          await expect(
            fixtureW5(root, 'no-worker-needed', qualification),
          ).resolves.toBe('nothing-to-settle');
          if (fail) throw new Error('recovery interrupted');
        },
      });
      const recover = worker.recoverW5.bind(worker);
      worker.recoverW5 = async (journal): Promise<void> => {
        try {
          await recover(journal);
        } finally {
          // Still prepared and coordinated: only the recovery callback has ended.
          expect((await worker.readJournal(identity))?.phase).toBe('prepared');
          const qualification = qualifications[0];
          expect(qualification).toBeDefined();
          await expect(qualification?.assertHeld()).rejects.toMatchObject({
            reason: 'recovery-required',
          });
        }
      };
      if (fail) await expect(run()).rejects.toThrow('recovery interrupted');
      else await run();
      const qualification = qualifications[0];
      if (!qualification) throw new Error('No qualification');
      await expect(qualification.assertHeld()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        fixtureW5(identity.source, 'must-not-start', qualification),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await statIfPresent(join(identity.source, 'runtime'))).toBeNull();
    },
  );

  test.each(['cold-refusal', 'cold-exception', 'journal', 'recovery'])(
    'coordination closes after a held-transaction %s failure',
    async (failure) => {
      await source();
      const original = await worker.inventory(identity);
      const interrupted = new Error(`interrupted ${failure}`);
      let held = false;
      const coordinate = worker.coordinate.bind(worker);
      const saveJournal = worker.saveJournal.bind(worker);
      worker = {
        ...worker,
        coordinate: async (
          selected,
        ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
          const release = await coordinate(selected);
          held = true;
          return async (): Promise<void> => {
            await release();
            held = false;
          };
        },
        proveCold: (): Promise<void> => {
          if (!held) return Promise.resolve();
          if (failure === 'cold-refusal')
            return Promise.reject(
              new InternalRootMigrationRefused(
                'cold-proof-unavailable',
                'incomplete fixture inspection',
              ),
            );
          if (failure === 'cold-exception') return Promise.reject(interrupted);
          return Promise.resolve();
        },
        saveJournal: async (journal): Promise<void> => {
          if (failure === 'journal') throw interrupted;
          await saveJournal(journal);
        },
        recoverW5: (): Promise<void> => Promise.reject(interrupted),
      };
      await expect(run()).rejects.toThrow(
        failure === 'cold-refusal'
          ? 'incomplete fixture inspection'
          : interrupted.message,
      );
      expect(held).toBe(false);
      const release = await coordinate(identity);
      await release();
      expect(
        await statIfPresent(
          join(identity.coordination, 'coordination.sqlite-journal'),
        ),
      ).toBeNull();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        original.fingerprint,
      );
      expect(await statIfPresent(identity.destination)).toBeNull();
    },
  );

  test('repair verification refusal never publishes the staged destination', async () => {
    await source();
    const original = await worker.inventory(identity);
    repairs.verify = (): ReturnType<InternalRootRepairs['verify']> =>
      Promise.resolve({
        kind: 'refused',
        recovery: 'Verify projection before publication.',
      });
    await expect(run()).rejects.toMatchObject({ reason: 'repair-refused' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
  });

  test('explicit rebuild resumes a crash after discarding the recorded destination', async () => {
    await source();
    await run();
    const discard = worker.discardDestination.bind(worker);
    let interrupted = false;
    worker.discardDestination = async (journal): Promise<void> => {
      await discard(journal);
      if (!interrupted) {
        interrupted = true;
        throw new Error('rebuild interrupted');
      }
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('rebuild interrupted');
    expect((await readFixtureJournal(identity))?.phase).toBe('rebuilding');
    expect(await statIfPresent(identity.destination)).toBeNull();
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test('rebuild never discards secure storage delivered by a later phase', async () => {
    await source();
    await run();
    const secure = join(identity.destination, 'secure-storage');
    await mkdir(secure, { mode: 0o700 });
    const opaque = Buffer.from([0, 255, 19]);
    await writeFile(join(secure, 'opaque'), opaque);
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await readFile(join(secure, 'opaque'))).toEqual(opaque);
  });

  test('rebuild refuses to discard a substituted destination', async () => {
    await source();
    await run();
    // Keep the old inode alive to avoid filesystem inode reuse in this test.
    await rename(identity.destination, join(home, 'quarantined'));
    await createPrivateMigrationDirectory(identity.destination, host);
    await writeFile(join(identity.destination, 'independent'), 'keep');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(
      await readFile(join(identity.destination, 'independent'), 'utf8'),
    ).toBe('keep');
  });

  test('cold proof refuses before journal publication', async () => {
    await source();
    worker = {
      ...worker,
      proveCold: (): Promise<void> => Promise.reject(new Error('live child')),
    };
    await expect(run()).rejects.toThrow('live child');
    expect(
      await statIfPresent(join(identity.coordination, 'journal.json')),
    ).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  test('recovers committed images at the original root before creating destination staging', async () => {
    await source();
    recover.mockImplementation(async (root) => {
      expect(root).toBe(identity.source);
      expect(await statIfPresent(identity.destination)).toBeNull();
      const journal = await readFixtureJournal(identity);
      expect(journal?.phase).toBe('prepared');
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      await writeFile(join(root, 'preferences.json'), '{"recovered":true}');
    });
    await run();
    expect(
      await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
    ).toBe('{"recovered":true}');
  });

  function countWalks(): {
    inventory: jest.SpyInstance<
      ReturnType<InternalRootMigrationWorker['inventory']>,
      Parameters<InternalRootMigrationWorker['inventory']>
    >;
    publication: jest.SpyInstance<
      ReturnType<InternalRootMigrationWorker['publicationRoot']>,
      Parameters<InternalRootMigrationWorker['publicationRoot']>
    >;
    inspections: jest.SpyInstance<
      ReturnType<typeof migrationProgress.internalRootMigrationProgress>,
      Parameters<typeof migrationProgress.internalRootMigrationProgress>
    >;
    walks: () => number;
    restore: () => void;
  } {
    const inventory = jest.spyOn(worker, 'inventory');
    const publication = jest.spyOn(worker, 'publicationRoot');
    const inspections = jest.spyOn(
      migrationProgress,
      'internalRootMigrationProgress',
    );
    return {
      inventory,
      publication,
      inspections,
      // This fixture has only its root and preferences.json in each tree.
      walks: () =>
        inspections.mock.calls.filter(
          ([detail]) => detail === 'inspected manifest entry',
        ).length / 2,
      restore: () => {
        inventory.mockRestore();
        publication.mockRestore();
        inspections.mockRestore();
      },
    };
  }

  test('fresh apply uses nine tree walks instead of sixteen', async () => {
    await source();
    const counts = countWalks();
    try {
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(counts.inventory).toHaveBeenCalledTimes(5);
      expect(counts.publication).toHaveBeenCalledTimes(2);
      expect(
        counts.publication.mock.calls.every(
          ([, fingerprint]) => typeof fingerprint === 'string',
        ),
      ).toBe(true);
      expect(counts.walks()).toBe(9);
    } finally {
      counts.restore();
    }
  });

  test.each([
    { phase: 'prepared', inventories: 5, publications: 2, walks: 9 },
    { phase: 'source-settled', inventories: 4, publications: 2, walks: 8 },
    { phase: 'building', inventories: 4, publications: 2, walks: 8 },
    { phase: 'publishing', inventories: 3, publications: 2, walks: 5 },
    { phase: 'published', inventories: 2, publications: 2, walks: 3 },
    { phase: 'complete', inventories: 0, publications: 0, walks: 0 },
    { phase: 'complete-rebuild', inventories: 6, publications: 2, walks: 10 },
    { phase: 'restoring-external', inventories: 6, publications: 2, walks: 10 },
    { phase: 'rebuilding', inventories: 5, publications: 2, walks: 9 },
  ])(
    're-walks in a new invocation resuming $phase',
    async ({ phase, inventories, publications, walks }) => {
      await source();
      const rebuilding = [
        'complete-rebuild',
        'restoring-external',
        'rebuilding',
      ].includes(phase);
      if (rebuilding) await run();
      const save = worker.saveJournal.bind(worker);
      const publish = worker.publish.bind(worker);
      const resumeOptions = { ...apply, rebuild: rebuilding };
      if (phase !== 'complete-rebuild') {
        worker.saveJournal = async (value): Promise<void> => {
          await save(value);
          if (value.phase === phase) throw new Error('walk-count interruption');
        };
        if (phase === 'published') {
          worker.publish = async (...args): Promise<void> => {
            await publish(...args);
            throw new Error('walk-count interruption');
          };
        }
        await expect(
          migrateInternalRoot(worker, identity, resumeOptions, repairs),
        ).rejects.toThrow('walk-count interruption');
        worker.saveJournal = save;
        worker.publish = publish;
      }
      const counts = countWalks();
      const coordinate = jest.spyOn(worker, 'coordinate');
      const secure = jest.spyOn(worker, 'validateSecureResume');
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      const relocate = jest.spyOn(worker, 'relocateSecure');
      const build = jest.spyOn(worker, 'build');
      const publishResume = jest.spyOn(worker, 'publish');
      const restore = jest.spyOn(worker, 'restoreExternal');
      const discard = jest.spyOn(worker, 'discardDestination');
      const recoverResume = jest.spyOn(worker, 'recoverW5');
      try {
        await expect(
          migrateInternalRoot(worker, identity, resumeOptions, repairs),
        ).resolves.toMatchObject({ kind: 'complete' });
        expect(counts.inventory).toHaveBeenCalledTimes(inventories);
        expect(counts.publication).toHaveBeenCalledTimes(publications);
        const discardScan = rebuilding && process.platform !== 'darwin' ? 1 : 0;
        expect(counts.walks()).toBe(walks + discardScan);
        if (inventories) {
          const postLock = counts.inventory.mock.invocationCallOrder[1];
          expect(postLock).toBeGreaterThan(
            coordinate.mock.invocationCallOrder[0],
          );
          for (const step of [
            build,
            publishResume,
            restore,
            discard,
            recoverResume,
          ])
            for (const call of step.mock.invocationCallOrder)
              expect(call).toBeGreaterThan(postLock);
        } else {
          expect(secure).toHaveBeenCalledTimes(1);
          expect(qualify).toHaveBeenCalledTimes(1);
          expect(secure.mock.invocationCallOrder[0]).toBeLessThan(
            qualify.mock.invocationCallOrder[0],
          );
          expect(qualify.mock.invocationCallOrder[0]).toBeLessThan(
            relocate.mock.invocationCallOrder[0],
          );
        }
        if (phase === 'publishing' || phase === 'published')
          expect(counts.publication.mock.calls[0][1]).toBeUndefined();
        expect(
          await readFile(join(identity.source, 'preferences.json'), 'utf8'),
        ).toBe('{"theme":"dark"}');
      } finally {
        for (const spy of [
          coordinate,
          secure,
          qualify,
          relocate,
          build,
          publishResume,
          restore,
          discard,
          recoverResume,
        ])
          spy.mockRestore();
        counts.restore();
      }
    },
  );

  test.each(['repair', 'verify-before-seal', 'verify-before-publish'])(
    'source changes during retained %s window are refused',
    async (window) => {
      await source();
      let verifications = 0;
      const changeSource = async (): Promise<void> => {
        await writeFile(
          join(identity.source, 'preferences.json'),
          '{"changed":true,"retain":true}',
        );
      };
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        if (window === 'repair') await changeSource();
        return { kind: 'ok' };
      };
      repairs.verify = async (): ReturnType<InternalRootRepairs['verify']> => {
        verifications += 1;
        if (
          window ===
          (verifications === 1 ? 'verify-before-seal' : 'verify-before-publish')
        )
          await changeSource();
        return { kind: 'ok' };
      };
      const publish = jest.spyOn(worker, 'publish');
      try {
        await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
        expect(publish).not.toHaveBeenCalled();
        expect(
          await readFile(join(identity.source, 'preferences.json'), 'utf8'),
        ).toBe('{"changed":true,"retain":true}');
        expect(await statIfPresent(identity.destination)).toBeNull();
      } finally {
        publish.mockRestore();
      }
    },
  );

  test('a cached post-lock inventory still refuses stable ownership', async () => {
    await source();
    const inventory = worker.inventory.bind(worker);
    let calls = 0;
    worker.inventory = async (
      ...args
    ): ReturnType<InternalRootMigrationWorker['inventory']> => {
      const current = await inventory(...args);
      calls += 1;
      return { ...current, stableOwned: calls === 2 };
    };
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    expect(recover).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });

  test.each(['identity', 'stable-owner', 'fingerprint'])(
    'reused build inventory still compares %s',
    async (field) => {
      await source();
      const build = worker.build.bind(worker);
      worker.build = async (
        value,
      ): ReturnType<InternalRootMigrationWorker['build']> => {
        const result = await build(value);
        return {
          ...result,
          sourceInventory: {
            ...result.sourceInventory,
            ...(field === 'identity' ? { sourceIdentity: '1:999999' } : {}),
            ...(field === 'stable-owner' ? { stableOwned: true } : {}),
            ...(field === 'fingerprint' ? { fingerprint: 'changed' } : {}),
          },
        };
      };
      const repair = jest.spyOn(repairs, 'repair');
      try {
        await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
        expect(repair).not.toHaveBeenCalled();
        expect(await statIfPresent(identity.source)).not.toBeNull();
      } finally {
        repair.mockRestore();
      }
    },
  );

  test.each(['restoreExternal', 'discardDestination'] as const)(
    'invalidates source inventory after %s during rebuild',
    async (step) => {
      await source();
      await run();
      const original = worker[step].bind(worker);
      worker[step] = async (value): Promise<void> => {
        await original(value);
        await writeFile(
          join(identity.source, 'preferences.json'),
          'source changed during rebuild',
        );
      };
      const build = jest.spyOn(worker, 'build');
      try {
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { ...apply, rebuild: true },
            repairs,
          ),
        ).rejects.toMatchObject({ reason: 'source-changed' });
        expect(build).not.toHaveBeenCalled();
        expect(
          await readFile(join(identity.source, 'preferences.json'), 'utf8'),
        ).toBe('source changed during rebuild');
      } finally {
        build.mockRestore();
      }
    },
  );

  test('repairs.verify invalidates the sealed staging walk before publish', async () => {
    await source();
    let verifications = 0;
    repairs.verify = async (
      context,
    ): ReturnType<InternalRootRepairs['verify']> => {
      verifications += 1;
      if (verifications === 2)
        await writeFile(
          join(context.workingRoot, 'preferences.json'),
          'staging changed after seal',
        );
      return { kind: 'ok' };
    };
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    expect(verifications).toBe(2);
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect(await statIfPresent(identity.source)).not.toBeNull();
  });

  test.each(['before-rename', 'after-rename'])(
    'cached publication fingerprint still checks inode %s',
    async (window) => {
      await source();
      const publish = worker.publish.bind(worker);
      worker.publish = async (...args): Promise<void> => {
        const path =
          window === 'before-rename'
            ? worker.stagingRoot(identity)
            : identity.destination;
        if (window === 'after-rename') await publish(...args);
        await rename(path, join(home, 'retained-publication'));
        await createPrivateMigrationDirectory(path, host);
        await writeFile(join(path, 'independent'), 'never adopt');
        if (window === 'before-rename') await publish(...args);
      };
      await expect(run()).rejects.toMatchObject({
        reason: 'destination-exists',
      });
      const path =
        window === 'before-rename'
          ? worker.stagingRoot(identity)
          : identity.destination;
      expect(await readFile(join(path, 'independent'), 'utf8')).toBe(
        'never adopt',
      );
      expect(
        await statIfPresent(join(home, 'retained-publication')),
      ).not.toBeNull();
      expect(await statIfPresent(identity.source)).not.toBeNull();
    },
  );

  test('unresolved W5 state leaves the source intact without creating a destination', async () => {
    await source();
    recover.mockRejectedValue(new Error('unresolved reservation'));
    await expect(run()).rejects.toThrow('unresolved reservation');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
    expect(
      await statIfPresent(join(identity.coordination, 'recovery-tree')),
    ).toBeNull();
  });

  test.each(['before-rename', 'after-rename', 'repair', 'publication'])(
    'resumes %s interruption by rebuilding staging or recognizing publication, never repeating settled W5',
    async (point) => {
      await source();
      const publish = worker.publish.bind(worker);
      const save = worker.saveJournal.bind(worker);
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      let failed = false;
      worker = {
        ...worker,
        publish: async (journal): Promise<void> => {
          if (point === 'before-rename' && !failed) {
            failed = true;
            throw new Error('power loss');
          }
          await publish(journal);
          if (point === 'after-rename' && !failed) {
            failed = true;
            throw new Error('power loss');
          }
        },
        saveJournal: async (journal): Promise<void> => {
          if (
            point === 'publication' &&
            journal.phase === 'complete' &&
            !failed
          ) {
            failed = true;
            throw new Error('power loss');
          }
          await save(journal);
        },
      };
      repairs.repair = (): ReturnType<InternalRootRepairs['repair']> => {
        if (point === 'repair' && !failed) {
          failed = true;
          return Promise.reject(new Error('power loss'));
        }
        return Promise.resolve({ kind: 'ok' });
      };
      await expect(run()).rejects.toThrow('power loss');
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(point === 'publication' ? 2 : 1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(await statIfPresent(identity.source)).not.toBeNull();
    },
  );

  test.each([false, true])(
    'completion-save interruption preserves the durable outcome (saved=%s)',
    async (saved) => {
      await source();
      const save = worker.saveJournal.bind(worker);
      const prepare = jest.spyOn(repairs, 'prepare');
      const repair = jest.spyOn(repairs, 'repair');
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      worker.saveJournal = async (journal): Promise<void> => {
        if (journal.phase === 'complete') {
          if (saved) await save(journal);
          throw new Error('completion-save power loss');
        }
        await save(journal);
      };
      await expect(run()).rejects.toThrow('completion-save power loss');
      expect((await readFixtureJournal(identity))?.phase).toBe(
        saved ? 'complete' : 'publishing',
      );
      expect(qualify).toHaveBeenCalledTimes(1);
      worker.saveJournal = save;
      // A durable root completion still has pending secure work; resume it.
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: { secureRelocation: 'complete' },
      });
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
      expect(qualify).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect((await readFixtureJournal(identity))?.phase).toBe('complete');
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('publication resume preserves a newly populated independent destination', async () => {
    await source();
    const publish = worker.publish.bind(worker);
    worker.publish = (): Promise<void> =>
      Promise.reject(new Error('interrupted before rename'));
    await expect(run()).rejects.toThrow('interrupted before rename');
    worker.publish = publish;
    await createPrivateMigrationDirectory(identity.destination, host);
    await writeFile(join(identity.destination, 'independent'), 'preserve');
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(
      await readFile(join(identity.destination, 'independent'), 'utf8'),
    ).toBe('preserve');
    expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
  });

  test.each(['before-rename', 'after-rename'])(
    'publication resume refuses changed sealed data (Windows readonly bit before rename) %s',
    async (point) => {
      await source();
      const publish = worker.publish.bind(worker);
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      worker.publish = async (journal): Promise<void> => {
        if (point === 'after-rename') await publish(journal);
        throw new Error('publication interrupted');
      };
      await expect(run()).rejects.toThrow('publication interrupted');
      worker.publish = publish;
      const root =
        point === 'after-rename'
          ? identity.destination
          : worker.stagingRoot(identity);
      if (windows && point === 'before-rename')
        await chmod(join(root, 'preferences.json'), 0o400);
      else await writeFile(join(root, 'preferences.json'), 'unverified change');
      await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
      expect(qualify).not.toHaveBeenCalled();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(
        await readFile(join(identity.source, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
    },
  );

  test.each(['refused', 'thrown'])(
    'published qualification %s failure remains recoverable and never completes',
    async (failure) => {
      await source();
      const attempts = jest.fn(repairs.qualifyPublished.bind(repairs));
      repairs.qualifyPublished = async (
        context,
      ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
        await attempts(context);
        if (failure === 'thrown')
          throw new Error('Git qualification unavailable');
        return { kind: 'refused', recovery: 'Git qualification unavailable' };
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expectPublishedRefusal();
        expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
        expect(await statIfPresent(identity.destination)).not.toBeNull();
      }
      expect(attempts).toHaveBeenCalledTimes(2);
      repairs.qualifyPublished = attempts;
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(attempts).toHaveBeenCalledTimes(3);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['before-rename', 'after-rename'])(
    'publication resume rechecks external projections and physical root %s',
    async (point) => {
      await source();
      const external = join(home, 'gitdir');
      await writeFile(external, 'original backlink');
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({ kind: 'ready', externalFiles: [external] });
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        await writeFile(external, identity.destination);
        return { kind: 'ok' };
      };
      repairs.verify = async (
        context,
      ): ReturnType<InternalRootRepairs['verify']> => {
        if ((await readFile(external, 'utf8')) !== identity.destination)
          return {
            kind: 'refused',
            recovery: 'External backlink changed; retain evidence.',
          };
        expect(
          await readFile(join(context.workingRoot, 'preferences.json'), 'utf8'),
        ).toBe('{"theme":"dark"}');
        return { kind: 'ok' };
      };
      const publish = worker.publish.bind(worker);
      worker.publish = async (journal): Promise<void> => {
        if (point === 'after-rename') await publish(journal);
        throw new Error('publication interrupted');
      };
      await expect(run()).rejects.toThrow('publication interrupted');
      worker.publish = publish;
      await writeFile(external, 'independent backlink');
      await expect(run()).rejects.toMatchObject({
        reason:
          point === 'after-rename' ? 'recovery-required' : 'repair-refused',
      });
      expect(await readFile(external, 'utf8')).toBe('independent backlink');
      await writeFile(external, identity.destination);
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('rebuild resumes deletion privately without exposing a half-deleted destination', async () => {
    await source();
    await run();
    const discard = worker.discardDestination.bind(worker);
    worker.discardDestination = async (): Promise<void> => {
      const discarded = join(identity.coordination, 'discarding');
      await rename(identity.destination, discarded);
      await rm(join(discarded, 'preferences.json'));
      throw new Error('interrupted deletion');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('interrupted deletion');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await readFixtureJournal(identity))?.phase).toBe('rebuilding');
    worker.discardDestination = discard;
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await statIfPresent(join(identity.coordination, 'discarding')),
    ).toBeNull();
    expect(
      await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
    ).toBe('{"theme":"dark"}');
  });

  // Windows file symlinks require developer mode/SeCreateSymbolicLinkPrivilege;
  // directory reparse refusal executes below using an unprivileged junction.
  fileSymlinkFixture.each(['', '-wal', '-shm', '-journal'])(
    'POSIX file-symlink W5 sidecar %s refuses before worker admission (Windows needs symlink privilege)',
    async (suffix) => {
      await source();
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const outside = join(home, 'outside.sqlite');
      await writeFile(outside, 'external log must not be opened');
      await symlink(
        outside,
        join(identity.source, 'w5', `commit-log.sqlite${suffix}`),
      );
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(root, 'missing-worker', qualification);
        },
      });
      await expect(run()).rejects.toThrow(
        'Aliased or unsupported W5 log/SQLite sidecar',
      );
      expect(await readFile(outside, 'utf8')).toBe(
        'external log must not be opened',
      );
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
    },
  );

  test('rebuild never adopts a recreated predecessor', async () => {
    await source();
    await run();
    await rm(identity.source, { recursive: true });
    await source();
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
    expect(
      await readFile(join(identity.source, 'preferences.json'), 'utf8'),
    ).toBe('{"theme":"dark"}');
  });

  test('rebuild refuses a changed source and preserves the completed destination', async () => {
    await source();
    await run();
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await writeFile(
      join(identity.source, 'preferences.json'),
      'changed source',
    );
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
  });

  test('insecure or aliased roots require manual qualification', async () => {
    await source();
    if (windows) {
      await promisify(execFile)('icacls.exe', [
        identity.source,
        '/grant',
        '*S-1-1-0:R',
      ]);
      try {
        await expect(run()).rejects.toThrow('private-dacl');
      } finally {
        await promisify(execFile)('icacls.exe', [
          identity.source,
          '/remove:g',
          '*S-1-1-0',
        ]);
      }
    } else {
      await chmod(identity.source, 0o755);
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
    }
  });

  const coldFailure = new Error('Native proof-start budget exhausted: fixture');
  const directoryFailure = {
    message: 'Directory flush failed: denied\n\u001b[31m',
    code: 'EACCES',
    stage: 'flush',
  };
  const typedFailure = new InternalRootMigrationRefused(
    'writer-active',
    'Fixture writer remains; stop it before recovery.',
  );
  test.each([
    {
      timing: 'before-claim',
      failure: coldFailure,
      detail: coldFailure.message,
    },
    {
      timing: 'published-record',
      failure: coldFailure,
      detail: coldFailure.message,
    },
    {
      timing: 'before-claim',
      failure: directoryFailure,
      detail: 'Directory flush failed: denied [31m (code EACCES, stage flush)',
    },
    {
      timing: 'before-claim',
      failure: new W5MaintenanceRefusedError(
        'release-uncertain',
        directoryFailure,
      ),
      detail:
        'W5 source maintenance refused (release-uncertain): Directory flush failed: denied [31m (code EACCES, stage flush)',
    },
    {
      timing: 'before-claim',
      failure: typedFailure,
      detail: typedFailure.recovery,
    },
    {
      timing: 'before-claim',
      failure: { message: 'Foreign realm failure', code: 5, stage: {} },
      detail: 'Foreign realm failure',
    },
    {
      timing: 'before-claim',
      failure: {
        message: 'Bad tokens',
        code: 'EIO\nspoof',
        stage: 'a'.repeat(65),
      },
      detail: 'Bad tokens',
    },
    {
      timing: 'before-claim',
      failure: new Error(
        `Queue deadline\r\n\u0000\u0085\u202e${'x'.repeat(2000)}`,
      ),
      detail: 'Queue deadline',
    },
    { timing: 'before-claim', failure: null, detail: 'Unknown failure' },
    { timing: 'before-claim', failure: '', detail: 'Unknown failure' },
    {
      timing: 'before-claim',
      failure: 'Worker deadline expired',
      detail: 'Worker deadline expired',
    },
    {
      timing: 'before-claim',
      failure: Object.defineProperty({}, 'message', {
        get() {
          throw new Error('Diagnostic getter failed');
        },
      }),
      detail: 'Unknown failure',
    },
  ])(
    'retains W5 refusal evidence at $timing: $detail',
    async ({ timing, failure, detail }) => {
      await source();
      for (const name of ['runtime', 'workspaces', 'w5'])
        await createPrivateMigrationDirectory(
          join(identity.source, name),
          host,
        );
      const logPath = join(identity.source, 'w5/commit-log.sqlite');
      const log = W5CommitLog.open(logPath);
      try {
        log.reserve({
          reservationId: 'uncertain',
          operation: 'core.worktree.create',
          diagnostics: { note: 'Never replay this reservation' },
        });
      } finally {
        log.close();
      }
      const recordPath = join(identity.source, 'runtime/w5-maintenance.json');
      const claimPath = join(identity.source, 'runtime/startup-claim.json');
      let observed: { record: boolean; claim: boolean } | undefined;
      const rejectCold = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(failure);
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await settleInternalRootW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            {
              ...qualification,
              assertCold: async (): Promise<void> => {
                await qualification.assertHeld();
                const record = (await statIfPresent(recordPath)) !== null;
                const claim = (await statIfPresent(claimPath)) !== null;
                if (timing === 'before-claim' || record) {
                  observed = { record, claim };
                  return rejectCold();
                }
              },
            },
            {
              ownedChildPath: filesystemOptions.ownedChildPath,
              windowsProcessPath: resolve(
                '.cache/bin/win32-x64/canopy-process-identity.exe',
              ),
            },
          );
        },
      });
      let refusal: unknown;
      try {
        await run();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(InternalRootMigrationRefused);
      if (!(refusal instanceof InternalRootMigrationRefused))
        throw new Error('Expected migration refusal');
      expect(refusal.recovery).toContain(detail);
      if (failure === typedFailure) {
        expect(refusal).toBe(typedFailure);
      } else {
        expect(refusal.reason).toBe('recovery-required');
        expect('cause' in refusal && refusal.cause).toBe(failure);
        expect(refusal.recovery).toContain(
          'Preserve the original root and run W5 offline diagnosis there.',
        );
        expect(refusal.recovery.length).toBeLessThan(1400);
        expect(refusal.recovery).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }
      if (detail === 'Bad tokens') {
        expect(refusal.recovery).not.toContain('code ');
        expect(refusal.recovery).not.toContain('stage ');
      }
      expect(observed).toEqual({
        record: timing === 'published-record',
        claim: timing === 'published-record',
      });
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
      expect(await statIfPresent(recordPath)).toBeNull();
      expect(await statIfPresent(claimPath)).toBeNull();
      const retained = W5CommitLog.open(logPath);
      try {
        expect(
          retained.listReservations().map((row) => row.reservationId),
        ).toEqual(['uncertain']);
      } finally {
        retained.close();
      }
    },
  );

  test.each(['.DS_Store', 'unexpected'])(
    'no-log source carries workspace-root regular file %s',
    async (name) => {
      await source();
      await mkdir(join(identity.source, 'workspaces'));
      await writeFile(join(identity.source, 'workspaces', name), 'preserve');
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(root, entry, qualification);
        },
      });
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(
        await readFile(join(identity.destination, 'workspaces', name), 'utf8'),
      ).toBe('preserve');
      expect(
        await readFile(join(identity.source, 'workspaces', name), 'utf8'),
      ).toBe('preserve');
    },
  );

  test('cleanup report inventories every carried category and preserves all payloads and Git records before and after apply', async () => {
    await source();
    const put = async (path: string, contents: string): Promise<void> => {
      await mkdir(dirname(join(identity.source, path)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(identity.source, path), contents, { mode: 0o600 });
    };
    await put(
      'workspaces/index.json',
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'fixture',
            name: 'Fixture',
            type: 'multi-repo',
            color: 'blue',
          },
          { id: 'cowork', name: 'Cowork', type: 'cowork', color: 'blue' },
        ],
      }),
    );
    await put('workspaces/fixture/workspace.json', '{"version":1}');
    await put('workspaces/cowork/workspace.json', '{"version":1}');
    await put(
      'workspaces/fixture/worktrees.json',
      JSON.stringify({
        version: 1,
        worktrees: [
          { id: 'live', branchName: 'live', createdAt: 'today' },
          { id: 'missing-row', branchName: 'missing-row', createdAt: 'today' },
          {
            id: 'modern-gone',
            branchName: 'modern-gone',
            createdAt: 'today',
            creation: {
              operationId: 'fixture',
              state: 'complete',
              phase: 'git-ready',
              checkouts: [],
            },
          },
          {
            id: 'external-row',
            branchName: 'external-row',
            createdAt: 'today',
            path: home,
          },
        ],
      }),
    );
    await mkdir(join(identity.source, 'workspaces/fixture/worktrees/live'), {
      recursive: true,
      mode: 0o700,
    });
    const payloads = new Map([
      [
        'workspaces/old workspace/chat-storage/chat.json',
        'unique conversation',
      ],
      ['workspaces/old workspace/.DS_Store', 'nested metadata'],
      ['w5/abandon-23758.log', 'diagnostics'],
      ['w5/commit-log.sqlite.bak-before-abandon', 'historical backup'],
      ['.DS_Store', 'Finder metadata'],
      ['workspaces/.DS_Store', 'workspace metadata'],
      [
        'workspaces/cowork/worktree-data/live-entry/chat.json',
        'live Cowork history',
      ],
      [
        'app-workspaces/app-advisor/worktree-data/live-chat/chat.json',
        'live app-managed history',
      ],
      [
        'workspaces/fixture/worktree-data/modern-gone/chat.json',
        'missing modern checkout history',
      ],
      ['workspaces/default/chats/one.json', 'default history'],
      ['workspaces/proj-1/chats/one.json', 'project history'],
      ['workspaces/workspace-1/chats/one.json', 'workspace history'],
      [
        'workspaces/fixture/worktree-data/missing-row/chat.json',
        'stranded tracked chat',
      ],
      [
        'workspaces/fixture/worktree-data/external-row/chat.json',
        'external tracked chat',
      ],
      ['workspaces/notes.txt', 'operator notes'],
      ['workspaces/fixture/worktree-data/gone/chat.json', 'orphan chat'],
      ['chat-plugins/fixture/gone/chat/plugin.json', 'plugin sidecar'],
      ['workspaces/fixture/attachments/gone/file', 'orphan attachment'],
      ['workspaces/fixture/script-runs/gone/log', 'orphan script log'],
      ['workspaces/fixture/cost/gone/entry.json', 'orphan cost'],
      ['chat-plugins/default/gone/chat/plugin.json', 'unindexed plugin'],
      ['chat-plugins/removed/gone/chat/plugin.json', 'removed plugin'],
      ['chat-plugins/cowork/live-entry/chat/plugin.json', 'Cowork plugin'],
      ['chat-plugins/app-advisor/live-chat/chat/plugin.json', 'app plugin'],
      ['workspaces/fixture/worktree-data/live/chat.json', 'live chat'],
      ...['attachments', 'script-runs', 'cost'].flatMap((folder) => [
        [`workspaces/fixture/${folder}/live/payload`, 'live data'] as const,
        [
          `workspaces/fixture/${folder}/external-row/payload`,
          'external data',
        ] as const,
        [
          `workspaces/fixture/${folder}/stranded-v3-tail/payload`,
          'archive data',
        ] as const,
      ]),
      ['chat-plugins/fixture/live/chat/plugin.json', 'live plugin'],
      ['chat-plugins/fixture/external-row/chat/plugin.json', 'external plugin'],
      [
        'chat-plugins/fixture/stranded-v3-tail/chat/plugin.json',
        'archive plugin',
      ],
    ]);
    for (const [path, contents] of payloads) await put(path, contents);
    const stranded = await strandedArchiveFixture(identity.source, 'P0');
    payloads.set(
      'workspaces/fixture/archived-containers/stranded-p0/partial-payload',
      'preserve staged bytes',
    );
    const committed = await strandedArchiveFixture(identity.source, 'v3-tail');
    const repository = join(identity.source, 'repos/managed');
    await mkdir(repository, { recursive: true, mode: 0o700 });
    const git = async (...args: string[]): Promise<string> =>
      (
        await promisify(execFile)('git', ['--no-optional-locks', ...args], {
          cwd: repository,
        })
      ).stdout;
    await git('init');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const missing = join(home, 'absent-cleanup-worktree');
    await git('worktree', 'add', '-b', 'cleanup-fixture', missing);
    const absoluteAdmin = resolve(
      (await git('-C', missing, 'rev-parse', '--absolute-git-dir')).trimEnd(),
    );
    await rm(missing, { recursive: true });
    const relativeMissing = join(home, 'absent relative cleanup worktree');
    await git(
      'worktree',
      'add',
      '-b',
      'relative-cleanup-fixture',
      relativeMissing,
    );
    const relativeAdmin = resolve(
      (
        await git('-C', relativeMissing, 'rev-parse', '--absolute-git-dir')
      ).trimEnd(),
    );
    await writeFile(join(relativeMissing, 'staged.txt'), 'unique staged data');
    await git('-C', relativeMissing, 'add', 'staged.txt');
    const retainedIndex = await readFile(join(relativeAdmin, 'index'));
    await writeFile(
      join(relativeAdmin, 'gitdir'),
      `${relative(relativeAdmin, join(relativeMissing, '.git')).split(sep).join('/')}\r\n`,
    );
    await rm(relativeMissing, { recursive: true });
    const gitBefore = await git('worktree', 'list', '--porcelain', '-z');
    expect(
      gitBefore
        .split('\0')
        .filter((field) => field.startsWith('worktree '))
        .map((field) => resolve(field.slice('worktree '.length))),
    ).toContain(relativeMissing);
    const snapshot = async (root: string): Promise<unknown[]> => {
      const records: unknown[] = [];
      const visit = async (path: string): Promise<void> => {
        const stat = await lstat(path);
        records.push({
          path: relative(root, path),
          mode: stat.mode,
          ino: stat.ino,
          mtime: stat.mtimeMs,
          bytes: stat.isFile()
            ? (await readFile(path)).toString('base64')
            : null,
        });
        if (stat.isDirectory())
          for (const name of (await readdir(path)).sort())
            await visit(join(path, name));
      };
      await visit(root);
      return records;
    };
    const before = await snapshot(identity.source);
    const fileBytes = async (path: string): Promise<number> => {
      const stat = await lstat(path);
      if (!stat.isDirectory()) return stat.size;
      const children = await readdir(path);
      const bytes = await Promise.all(
        children.map((name) => fileBytes(join(path, name))),
      );
      return bytes.reduce((sum, value) => sum + value, 0);
    };
    const prunableBytes =
      (await fileBytes(absoluteAdmin)) + (await fileBytes(relativeAdmin));
    expect(prunableBytes).toBeGreaterThan(retainedIndex.byteLength);
    const inventory = await migrateInternalRoot(
      worker,
      identity,
      { apply: false, declareInternal: true },
      repairs,
    );
    expect(inventory.kind).toBe('inventory');
    if (inventory.kind !== 'inventory') throw new Error('Expected inventory');
    const report = await reportInternalRootCleanup(
      identity,
      false,
      host,
      inventory.inventory.bytes,
    );
    const prunablePaths = report.entries
      .filter((entry) => entry.category === 'prunable-git-worktree')
      .map((entry) => entry.path);
    for (const expected of [absoluteAdmin, relativeAdmin])
      if (!prunablePaths.includes(expected))
        throw new Error(
          `Missing prunable Git worktree ${JSON.stringify(expected)}; cleanup report: ${JSON.stringify({ prunablePaths, warnings: report.warnings })}`,
        );
    expect(report.restoreSource.bytes).toBe(inventory.inventory.bytes);
    for (const path of [
      join(identity.source, 'workspaces', 'fixture', 'attachments', 'gone'),
      join(identity.source, 'workspaces', 'fixture', 'script-runs', 'gone'),
      join(identity.source, 'workspaces', 'fixture', 'cost', 'gone'),
      join(identity.source, 'chat-plugins', 'default', 'gone'),
      join(identity.source, 'chat-plugins', 'removed', 'gone'),
    ])
      expect(report.entries).toContainEqual(
        expect.objectContaining({
          path,
          category: 'orphaned-worktree-data',
          disposition: 'review before deleting',
        }),
      );
    for (const id of ['cowork', 'app-advisor'])
      expect(
        report.entries.some((entry) =>
          isWithin(join(identity.source, 'chat-plugins', id), entry.path),
        ),
      ).toBe(false);
    const printed = formatInternalRootCleanupReport(report);
    expect(printed).toContain('Cleanup candidates\n');
    expect(printed).toContain('Removal is your choice.');
    expect(printed).toContain(
      `Overall potentially reclaimable: ${report.reclaimableBytes} bytes`,
    );
    for (const entry of report.entries) {
      expect(printed).toContain(`Path: ${JSON.stringify(entry.path)}`);
      expect(printed).toContain(
        `Restore source: ${JSON.stringify(entry.restoreSource)}`,
      );
      expect(printed).toContain(`${entry.disposition} | ${entry.bytes} bytes`);
    }
    expect(await snapshot(identity.source)).toEqual(before);
    expect(await readFile(report.reportPath, 'utf8').then(JSON.parse)).toEqual(
      report,
    );
    expect(report.warnings).toEqual([]);
    expect(new Set(report.entries.map((entry) => entry.category))).toEqual(
      new Set([
        'unindexed-workspace',
        'unrecognized-w5-file',
        'os-metadata',
        'prunable-git-worktree',
        'inert-archive-staging',
        'orphaned-worktree-data',
        'unrecognized-workspace-file',
      ]),
    );
    expect(
      report.entries.filter(
        (entry) => entry.category === 'prunable-git-worktree',
      ),
    ).toHaveLength(2);
    expect(
      report.totals.find((total) => total.category === 'prunable-git-worktree'),
    ).toEqual({
      category: 'prunable-git-worktree',
      entries: 2,
      bytes: prunableBytes,
    });
    expect(
      report.entries.find(
        (entry) =>
          entry.category === 'prunable-git-worktree' &&
          entry.worktreePath === missing,
      ),
    ).toMatchObject({ worktreePath: missing });
    expect(
      report.entries.find((entry) => entry.path === relativeAdmin),
    ).toMatchObject({
      category: 'prunable-git-worktree',
      worktreePath: relativeMissing,
      disposition: 'review before deleting',
    });
    expect(
      report.entries.find(
        (entry) =>
          entry.path === join(identity.source, 'workspaces', 'old workspace'),
      ),
    ).toMatchObject({
      disposition: 'review before deleting',
      bytes: Buffer.byteLength('unique conversationnested metadata'),
    });
    expect(
      report.entries.some(
        (entry) =>
          entry.path ===
          join(identity.source, 'workspaces', 'old workspace', '.DS_Store'),
      ),
    ).toBe(false);
    expect(
      report.entries.find((entry) => entry.category === 'os-metadata'),
    ).toMatchObject({
      disposition: 'safe to drop',
      bytes: Buffer.byteLength('Finder metadata'),
    });
    expect(
      report.entries.some(
        (entry) =>
          entry.path ===
          join(
            identity.source,
            'workspaces',
            'fixture',
            'worktree-data',
            'live',
          ),
      ),
    ).toBe(false);
    expect(
      report.entries.some(
        (entry) =>
          entry.path ===
          join(
            identity.source,
            'workspaces',
            'fixture',
            'worktree-data',
            'external-row',
          ),
      ),
    ).toBe(false);
    expect(
      report.entries.find(
        (entry) =>
          entry.path ===
          join(
            identity.source,
            'workspaces',
            'fixture',
            'worktree-data',
            'missing-row',
          ),
      ),
    ).toMatchObject({
      category: 'orphaned-worktree-data',
      disposition: 'review before deleting',
    });
    expect(
      report.entries.find(
        (entry) =>
          entry.path ===
          join(
            identity.source,
            'workspaces',
            'fixture',
            'worktree-data',
            'modern-gone',
          ),
      ),
    ).toMatchObject({ category: 'orphaned-worktree-data' });
    expect(
      report.entries.some((entry) =>
        isWithin(
          join(identity.source, 'workspaces', 'cowork', 'worktree-data'),
          entry.path,
        ),
      ),
    ).toBe(false);
    expect(
      report.entries.some((entry) =>
        isWithin(join(identity.source, 'app-workspaces'), entry.path),
      ),
    ).toBe(false);
    for (const id of ['default', 'proj-1', 'workspace-1'])
      expect(
        report.entries.find(
          (entry) => entry.path === join(identity.source, 'workspaces', id),
        ),
      ).toMatchObject({
        category: 'unindexed-workspace',
        disposition: 'review before deleting',
      });
    expect(
      report.entries.filter(
        (entry) =>
          entry.path === join(identity.source, 'workspaces', '.DS_Store'),
      ),
    ).toHaveLength(1);
    expect(
      report.entries.some(
        (entry) =>
          entry.path === join(identity.source, 'workspaces', 'fixture'),
      ),
    ).toBe(false);
    for (const folder of ['archived-containers', 'worktree-data'])
      expect(
        report.entries.some((entry) =>
          isWithin(
            join(
              identity.source,
              'workspaces',
              'fixture',
              folder,
              'stranded-v3-tail',
            ),
            entry.path,
          ),
        ),
      ).toBe(false);
    for (const folder of ['attachments', 'script-runs', 'cost'])
      for (const id of ['live', 'external-row', 'stranded-v3-tail'])
        expect(
          report.entries.some((entry) =>
            isWithin(
              join(identity.source, 'workspaces', 'fixture', folder, id),
              entry.path,
            ),
          ),
        ).toBe(false);
    for (const id of ['live', 'external-row', 'stranded-v3-tail'])
      expect(
        report.entries.some((entry) =>
          isWithin(
            join(identity.source, 'chat-plugins', 'fixture', id),
            entry.path,
          ),
        ),
      ).toBe(false);

    expect(
      report.entries.every((entry) => entry.restoreSource === identity.source),
    ).toBe(true);
    expect(report.reclaimableBytes).toBe(
      report.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );
    for (const total of report.totals) {
      const matching = report.entries.filter(
        (entry) => entry.category === total.category,
      );
      expect(total).toEqual({
        category: total.category,
        entries: matching.length,
        bytes: matching.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    }
    const result = await migrateInternalRoot(
      worker,
      identity,
      { apply: true, declareInternal: true },
      repairs,
    );
    expect(result.kind).toBe('complete');
    const sourceBeforeReport = await snapshot(identity.source);
    const destinationBeforeReport = await snapshot(identity.destination);
    const journalBefore = await readFile(
      join(identity.coordination, 'journal.json'),
    );
    const applied = await reportInternalRootCleanup(identity, true, host);
    expect(applied.warnings).toEqual([]);
    expect(await snapshot(identity.source)).toEqual(sourceBeforeReport);
    expect(await snapshot(identity.destination)).toEqual(
      destinationBeforeReport,
    );
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      journalBefore,
    );
    expect(await readFile(applied.reportPath, 'utf8').then(JSON.parse)).toEqual(
      applied,
    );
    for (const entry of report.entries) {
      expect(applied.entries).toContainEqual(entry);
      expect(applied.entries).toContainEqual({
        ...entry,
        path: join(identity.destination, relative(identity.source, entry.path)),
        copy: 'new-root',
      });
    }
    expect(applied.reclaimableBytes).toBe(report.reclaimableBytes * 2);
    expect(
      applied.totals.find(
        (total) => total.category === 'prunable-git-worktree',
      ),
    ).toEqual({
      category: 'prunable-git-worktree',
      entries: 4,
      bytes: prunableBytes * 2,
    });
    for (const root of [identity.source, identity.destination])
      expect(
        await readFile(
          join(root, relative(identity.source, relativeAdmin), 'index'),
        ),
      ).toEqual(retainedIndex);
    expect(await git('worktree', 'list', '--porcelain', '-z')).toBe(gitBefore);
    for (const [path, contents] of payloads)
      for (const root of [identity.source, identity.destination])
        expect(await readFile(join(root, path), 'utf8')).toBe(contents);
    for (const item of [stranded, committed])
      for (const root of [identity.source, identity.destination])
        expect(
          await readFile(
            join(root, relative(identity.source, item.path)),
            'utf8',
          ),
        ).toBe(item.bytes);
  });

  test.each([
    'indexed-missing',
    'unindexed-missing',
    'unindexed-present',
    'no-workspaces-root',
  ])('cleanup report finds detached plugin sidecars: %s', async (shape) => {
    await source();
    const put = async (path: string, contents: string): Promise<void> => {
      const target = join(identity.source, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: 0o600 });
    };
    const id = 'removed';
    if (shape !== 'no-workspaces-root')
      await put(
        'workspaces/index.json',
        JSON.stringify({
          version: 1,
          workspaces:
            shape === 'indexed-missing'
              ? [{ id, name: id, type: 'multi-repo', color: 'blue' }]
              : [],
        }),
      );
    const payloads = new Map([
      [`chat-plugins/${id}/gone/chat/plugin.json`, 'unique plugin data'],
    ]);
    if (shape === 'unindexed-present') {
      payloads.set(`workspaces/${id}/workspace.json`, '{"version":1}');
      for (const folder of [
        'worktree-data',
        'attachments',
        'script-runs',
        'cost',
      ])
        payloads.set(`workspaces/${id}/${folder}/gone/payload`, folder);
    }
    for (const [path, contents] of payloads) await put(path, contents);
    const before = await Promise.all(
      [...payloads.keys()].map(async (path) => ({
        path,
        stat: await lstat(join(identity.source, path)),
        bytes: await readFile(join(identity.source, path)),
      })),
    );
    const report = await reportInternalRootCleanup(identity, false, host);
    expect(report.warnings).toEqual([]);
    expect(report.entries).toContainEqual({
      path: join(identity.source, 'chat-plugins', id, 'gone'),
      bytes: Buffer.byteLength('unique plugin data'),
      category: 'orphaned-worktree-data',
      disposition: 'review before deleting',
      reason:
        'No checkout or archive remains at the known worktree paths; sidecar data may still contain unique chats or execution history.',
      copy: 'old-root',
      restoreSource: identity.source,
    });
    const expectedBytes = [...payloads.values()].reduce(
      (sum, contents) => sum + Buffer.byteLength(contents),
      0,
    );
    expect(report.reclaimableBytes).toBe(expectedBytes);
    if (shape === 'unindexed-present') {
      expect(report.entries).toHaveLength(2);
      expect(report.entries).toContainEqual(
        expect.objectContaining({
          path: join(identity.source, 'workspaces', id),
          category: 'unindexed-workspace',
          disposition: 'review before deleting',
        }),
      );
    }
    for (const item of before) {
      const path = join(identity.source, item.path);
      expect(await lstat(path)).toMatchObject({
        ino: item.stat.ino,
        mode: item.stat.mode,
        mtimeMs: item.stat.mtimeMs,
        size: item.stat.size,
      });
      expect(await readFile(path)).toEqual(item.bytes);
    }
  });

  test.each([
    'live-row',
    'live-checkout',
    'retained-archive',
    'cowork-manifest',
    'cowork-entries',
    'corrupt-manifest',
    'corrupt-worktrees',
    'partial-worktrees',
    'duplicate-worktree-rows',
    'corrupt-index',
    'partial-index',
    'aliased-owner',
    'aliased-plugin-owner',
    'unfinished-row',
    'archive-recovery',
    'app-advisor',
    'plan-explore-chat',
    'code-review-chat',
    'pipeline-editor',
    'shared-container-viewer',
  ])(
    'cleanup report preserves detached plugin ownership evidence: %s',
    async (evidence) => {
      await source();
      const appScope = [
        'app-advisor',
        'plan-explore-chat',
        'code-review-chat',
        'pipeline-editor',
        'shared-container-viewer',
      ].includes(evidence);
      const id = appScope ? evidence : 'unindexed';
      const put = async (path: string, contents: string): Promise<void> => {
        const target = join(identity.source, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, contents, { mode: 0o600 });
      };
      const pluginPath = `chat-plugins/${id}/entry/chat/plugin.json`;
      await put(pluginPath, 'retain plugin data');
      if (!appScope) {
        await put(
          'workspaces/index.json',
          evidence === 'corrupt-index'
            ? 'corrupt'
            : '{"version":1,"workspaces":[]}',
        );
        await put(
          `workspaces/${id}/workspace.json`,
          evidence === 'corrupt-manifest'
            ? 'corrupt'
            : JSON.stringify({
                version: 1,
                type: evidence === 'cowork-manifest' ? 'cowork' : 'multi-repo',
              }),
        );
        if (evidence === 'cowork-entries')
          await put(
            `workspaces/${id}/work-entries.json`,
            '{"version":1,"entries":[]}',
          );
        if (evidence === 'live-checkout')
          await put(
            `workspaces/${id}/worktrees/entry/payload`,
            'live checkout',
          );
        if (evidence === 'retained-archive')
          await put(
            `workspaces/${id}/archived-containers/entry/container.json`,
            'retain even unreadable archive',
          );
        if (evidence === 'archive-recovery')
          await put(
            `workspaces/${id}/worktree-data/entry/archive-recovery-evidence/archive/payload`,
            'restore evidence',
          );
        if (evidence === 'corrupt-worktrees')
          await put(`workspaces/${id}/worktrees.json`, 'corrupt');
        if (evidence === 'partial-index')
          await put(
            'workspaces/index.json',
            JSON.stringify({ version: 1, workspaces: [{ id }] }),
          );
        if (
          evidence === 'partial-worktrees' ||
          evidence === 'duplicate-worktree-rows'
        )
          await put(
            `workspaces/${id}/worktrees.json`,
            JSON.stringify({
              version: 1,
              worktrees: [
                { id: 'entry', branchName: 'entry', createdAt: 'today' },
                evidence === 'partial-worktrees'
                  ? { id: 'other' }
                  : {
                      id: 'entry',
                      branchName: 'live-duplicate',
                      createdAt: 'today',
                      path: home,
                    },
              ],
            }),
          );
        if (evidence === 'aliased-owner') {
          await rename(
            join(identity.source, 'workspaces', id),
            join(identity.source, 'retained-workspace'),
          );
          await symlink(
            '../retained-workspace',
            join(identity.source, 'workspaces', id),
            'dir',
          );
        }
        if (evidence === 'aliased-plugin-owner') {
          await rename(
            join(identity.source, 'chat-plugins', id),
            join(identity.source, 'retained-plugins'),
          );
          await symlink(
            '../retained-plugins',
            join(identity.source, 'chat-plugins', id),
            'dir',
          );
        }
        if (evidence === 'live-row' || evidence === 'unfinished-row')
          await put(
            `workspaces/${id}/worktrees.json`,
            JSON.stringify({
              version: 1,
              worktrees: [
                {
                  id: 'entry',
                  branchName: 'entry',
                  createdAt: 'today',
                  ...(evidence === 'live-row'
                    ? { path: home }
                    : { setupPhase: 'git-pending' }),
                },
              ],
            }),
          );
      }
      const before = await lstat(join(identity.source, pluginPath));
      const report = await reportInternalRootCleanup(identity, false, host);
      expect(
        report.entries.some((entry) =>
          isWithin(join(identity.source, 'chat-plugins'), entry.path),
        ),
      ).toBe(false);
      expect(await readFile(join(identity.source, pluginPath), 'utf8')).toBe(
        'retain plugin data',
      );
      expect(await lstat(join(identity.source, pluginPath))).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        mtimeMs: before.mtimeMs,
      });
      if (
        evidence.startsWith('corrupt-') ||
        evidence.startsWith('partial-') ||
        evidence === 'duplicate-worktree-rows' ||
        evidence === 'aliased-owner' ||
        evidence === 'unfinished-row' ||
        evidence === 'archive-recovery'
      )
        expect(report.warnings.length).toBeGreaterThan(0);
      else expect(report.warnings).toEqual([]);
    },
  );

  test('cleanup report preserves removed workspace plugins with lifecycle recovery evidence', async () => {
    await source();
    const lifecycle = await lifecycleFixture('recovery-required');
    const plugin = join(
      identity.source,
      'chat-plugins',
      lifecycle.record.workspaceId,
      lifecycle.record.worktreeId ?? 'entry',
      'chat',
      'plugin.json',
    );
    await mkdir(dirname(plugin), { recursive: true, mode: 0o700 });
    await writeFile(plugin, 'recovery plugin', { mode: 0o600 });
    const report = await reportInternalRootCleanup(identity, false, host);
    expect(report.entries).toEqual([]);
    expect(report.warnings.join('\n')).toContain('chat-plugins');
    expect(await readFile(plugin, 'utf8')).toBe('recovery plugin');
    expect(await readFile(lifecycle.path, 'utf8')).toBe(lifecycle.bytes);
  });

  test.each(['metadata', 'lifecycle'])(
    'cleanup report applies mixed %s recovery evidence across every sidecar root',
    async (evidence) => {
      await source();
      const put = async (path: string, contents: string): Promise<void> => {
        const target = join(identity.source, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, contents, { mode: 0o600 });
      };
      const lifecycle =
        evidence === 'lifecycle'
          ? await lifecycleFixture('recovery-required')
          : undefined;
      const retainedId = lifecycle?.record.worktreeId ?? 'recovering';
      await put(
        'workspaces/index.json',
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: 'fixture',
              name: 'Fixture',
              type: 'multi-repo',
              color: 'blue',
            },
          ],
        }),
      );
      await put(
        'workspaces/fixture/worktrees.json',
        JSON.stringify({
          version: 1,
          worktrees: [
            { id: 'ambiguous', branchName: 'gone', createdAt: 'today' },
            {
              id: 'ambiguous',
              branchName: 'live',
              createdAt: 'today',
              path: home,
            },
          ],
        }),
      );
      const sidecars = [
        'workspaces/fixture/worktree-data',
        'workspaces/fixture/attachments',
        'workspaces/fixture/script-runs',
        'workspaces/fixture/cost',
        'chat-plugins/fixture',
      ];
      const payloads = new Map<string, string>();
      for (const folder of sidecars)
        for (const id of ['gone', 'ambiguous', retainedId])
          payloads.set(`${folder}/${id}/payload`, `${folder}/${id}`);
      if (evidence === 'metadata')
        payloads.set(
          `workspaces/fixture/worktree-data/${retainedId}/archive-recovery-evidence/archive/payload`,
          'retain restored archive',
        );
      for (const [path, contents] of payloads) await put(path, contents);
      const before = await Promise.all(
        [...payloads.keys()].map(async (path) => ({
          path,
          stat: await lstat(join(identity.source, path)),
        })),
      );
      const report = await reportInternalRootCleanup(identity, false, host);
      expect(report.entries.map((entry) => entry.path).sort()).toEqual(
        sidecars.map((folder) => join(identity.source, folder, 'gone')).sort(),
      );
      expect(
        report.entries.every(
          (entry) =>
            entry.category === 'orphaned-worktree-data' &&
            entry.disposition === 'review before deleting',
        ),
      ).toBe(true);
      expect(report.reclaimableBytes).toBe(
        sidecars.reduce(
          (sum, folder) => sum + Buffer.byteLength(`${folder}/gone`),
          0,
        ),
      );
      expect(report.warnings.join('\n')).toContain('worktrees.json');
      for (const folder of sidecars)
        expect(report.warnings.join('\n')).toContain(
          JSON.stringify(join(identity.source, folder, retainedId)),
        );
      for (const item of before) {
        const path = join(identity.source, item.path);
        expect(await readFile(path, 'utf8')).toBe(payloads.get(item.path));
        expect(await lstat(path)).toMatchObject({
          ino: item.stat.ino,
          mode: item.stat.mode,
          mtimeMs: item.stat.mtimeMs,
        });
      }
      if (lifecycle)
        expect(await readFile(lifecycle.path, 'utf8')).toBe(lifecycle.bytes);
    },
  );

  test('refreshes a pre-abandonment version-1 cleanup report through inventory and apply', async () => {
    await source();
    worker.diagnose = diagnoseInternalRootW5;
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const report = await reportInternalRootCleanup(identity, false, host);
    const legacy = {
      ...report,
      totals: report.totals.filter(
        (total) => total.category !== 'abandoned-archive',
      ),
    };
    expect(legacy.totals).toHaveLength(7);
    const saveLegacy = (): Promise<void> =>
      writeFile(report.reportPath, JSON.stringify(legacy), { mode: 0o600 });
    await saveLegacy();
    await expect(worker.readJournal(identity)).resolves.toBeNull();
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      ),
    ).resolves.toMatchObject({
      kind: 'inventory',
      preflight: { kind: 'ready' },
    });
    const refreshed = await reportInternalRootCleanup(identity, false, host);
    expect(refreshed.totals).toContainEqual({
      category: 'abandoned-archive',
      entries: 0,
      bytes: 0,
    });
    await saveLegacy();
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    const applied = await reportInternalRootCleanup(identity, true, host);
    expect(applied.totals).toContainEqual({
      category: 'abandoned-archive',
      entries: 0,
      bytes: 0,
    });
    expect(startup).not.toThrow();
  });

  test('cleanup report handles empty roots and refuses to infer absence from corrupt membership', async () => {
    await source();
    const empty = await reportInternalRootCleanup(identity, false, host);
    expect(await worker.readJournal(identity)).toBeNull();
    expect(startup).toThrow('required');
    expect(empty.entries).toEqual([]);
    expect(empty.reclaimableBytes).toBe(0);
    expect(
      empty.totals.every((total) => total.bytes === 0 && total.entries === 0),
    ).toBe(true);
    await assertPrivate(empty.reportPath, 'file', 0o600);
    const unexpected = join(identity.coordination, 'unexpected-evidence');
    await writeFile(unexpected, 'preserve unknown evidence', { mode: 0o600 });
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    expect(startup).toThrow('unsupported');
    expect(await readFile(unexpected, 'utf8')).toBe(
      'preserve unknown evidence',
    );
    await rm(unexpected);
    expect(await worker.readJournal(identity)).toBeNull();
    await mkdir(join(identity.source, 'workspaces/maybe-live'), {
      recursive: true,
    });
    await writeFile(join(identity.source, 'workspaces/index.json'), 'corrupt');
    const corrupt = await reportInternalRootCleanup(identity, false, host);
    expect(corrupt.entries).toEqual([]);
    expect(corrupt.warnings.join('\n')).toContain('index.json');
    await writeFile(empty.reportPath, '{"version":99}', { mode: 0o600 });
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    expect(startup).toThrow('unsupported');
  });

  test.each([
    { failurePoint: 'write', previousReport: false },
    { failurePoint: 'partial-write', previousReport: false },
    { failurePoint: 'sync', previousReport: false },
    { failurePoint: 'close', previousReport: false },
    { failurePoint: 'write', previousReport: true },
    { failurePoint: 'partial-write', previousReport: true },
    { failurePoint: 'sync', previousReport: true },
    { failurePoint: 'close', previousReport: true },
  ])(
    'cleanup report $failurePoint failure preserves retry and startup admission (previous report: $previousReport)',
    async ({ failurePoint, previousReport }) => {
      await source();
      const before = await worker.inventory(identity);
      const reportPath = join(identity.coordination, 'cleanup-candidates.json');
      if (previousReport)
        await reportInternalRootCleanup(identity, false, host);
      const previousBytes = previousReport ? await readFile(reportPath) : null;
      const failure = Object.assign(
        new Error(`Injected report ${failurePoint} failure`),
        {
          code: failurePoint === 'close' ? 'EIO' : 'ENOSPC',
        },
      );
      const open = fs.open;
      let injected = false;
      const opening = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            typeof args[0] === 'string' &&
            args[0].startsWith(`${reportPath}.`) &&
            args[1] === 'wx'
          ) {
            injected = true;
            if (failurePoint === 'write')
              jest.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
            else if (failurePoint === 'partial-write') {
              const write = handle.writeFile.bind(handle);
              jest
                .spyOn(handle, 'writeFile')
                .mockImplementationOnce(async () => {
                  await write('{"version":');
                  throw failure;
                });
            } else if (failurePoint === 'sync')
              jest.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
            else {
              const close = handle.close.bind(handle);
              jest.spyOn(handle, 'close').mockImplementationOnce(async () => {
                await close();
                throw failure;
              });
            }
          }
          return handle;
        });
      try {
        await expect(
          reportInternalRootCleanup(identity, false, host),
        ).rejects.toBe(failure);
      } finally {
        opening.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await readdir(identity.coordination)).toEqual(
        previousReport
          ? ['cleanup-candidates.json', 'coordination.sqlite']
          : ['coordination.sqlite'],
      );
      if (previousBytes)
        expect(await readFile(reportPath)).toEqual(previousBytes);
      expect(await worker.readJournal(identity)).toBeNull();
      // The migration is still required, but its coordination directory is valid.
      expect(startup).toThrow('required');
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { apply: false, declareInternal: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'inventory' });
      await expect(
        reportInternalRootCleanup(identity, false, host),
      ).resolves.toMatchObject({ reportPath });
      expect(await worker.readJournal(identity)).toBeNull();
      expect(startup).toThrow('required');
      expect(await worker.inventory(identity)).toEqual(before);
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(startup).not.toThrow();
      expect(await worker.inventory(identity)).toEqual({
        ...before,
        destinationIdentity: (await worker.readJournal(identity))
          ?.publicationIdentity,
      });
    },
  );

  test('cleanup report staging sweep never removes an active report writer', async () => {
    await source();
    const before = await worker.inventory(identity);
    const reportPath = join(identity.coordination, 'cleanup-candidates.json');
    await reportInternalRootCleanup(identity, false, host);
    let resume = (): void => {};
    let entered = (): void => {};
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const open = fs.open;
    let staged: string | undefined;
    const opening = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (
          !staged &&
          typeof args[0] === 'string' &&
          args[0].startsWith(`${reportPath}.`) &&
          args[1] === 'wx'
        ) {
          staged = args[0];
          const write = handle.writeFile.bind(handle);
          jest
            .spyOn(handle, 'writeFile')
            .mockImplementationOnce(async (...writeArgs) => {
              entered();
              await release;
              return write(...writeArgs);
            });
        }
        return handle;
      });
    const writing = reportInternalRootCleanup(identity, false, host);
    try {
      await paused;
      await expect(
        reportInternalRootCleanup(identity, false, host),
      ).rejects.toMatchObject({ reason: 'coordination-held' });
      await expect(worker.coordinate(identity)).rejects.toMatchObject({
        reason: 'coordination-held',
      });
      if (!staged) throw new Error('Report did not open its staging file');
      expect(await statIfPresent(staged)).not.toBeNull();
    } finally {
      resume();
      try {
        await writing;
      } finally {
        opening.mockRestore();
      }
    }
    expect(await worker.readJournal(identity)).toBeNull();
    expect(startup).toThrow('required');
    await expect(
      reportInternalRootCleanup(identity, false, host),
    ).resolves.toMatchObject({ reportPath });
    expect(await worker.inventory(identity)).toEqual(before);
  });

  test.each([
    'replacement',
    'modified',
    ...(windows ? [] : ['initially-unsafe']),
  ])(
    'cleanup report staging sweep preserves a %s node during publication',
    async (shape) => {
      await source();
      const reportPath = join(identity.coordination, 'cleanup-candidates.json');
      await reportInternalRootCleanup(identity, false, host);
      const staged = join(
        identity.coordination,
        'cleanup-candidates.json.12345678-1234-4234-8234-123456789abc.tmp',
      );
      await writeFile(staged, '{"version":', { mode: 0o600 });
      if (shape === 'initially-unsafe') await chmod(staged, 0o644);
      const retained = join(home, 'retained-staging');
      const open = fs.open;
      let injected = false;
      const opening = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            !injected &&
            typeof args[0] === 'string' &&
            args[0].startsWith(`${reportPath}.`) &&
            args[1] === 'wx'
          ) {
            injected = true;
            if (shape === 'replacement') await rename(staged, retained);
            await writeFile(staged, 'changed node must survive', {
              mode: 0o600,
            });
            if (shape === 'initially-unsafe') await chmod(staged, 0o600);
          }
          return handle;
        });
      try {
        await reportInternalRootCleanup(identity, false, host);
      } finally {
        opening.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await readFile(staged, 'utf8')).toBe('changed node must survive');
      if (shape === 'replacement')
        expect(await readFile(retained, 'utf8')).toBe('{"version":');
      expect(await worker.readJournal(identity)).toBeNull();
      expect(startup).toThrow('required');
    },
  );

  test.each(
    ['inventory', 'apply', 'rebuild', 'fresh-start'].flatMap((choice) =>
      [false, true].map((previousReport) => ({ choice, previousReport })),
    ),
  )(
    'cleanup report interrupted staging preserves $choice admission (previous report: $previousReport)',
    async ({ choice, previousReport }) => {
      await source();
      const before = await worker.inventory(identity);
      if (previousReport)
        await reportInternalRootCleanup(identity, false, host);
      else await createPrivateMigrationDirectory(identity.coordination, host);
      const staged = [
        'cleanup-candidates.json.12345678-1234-4234-8234-123456789abc.tmp',
        'cleanup-candidates.json.abcdefab-abcd-4abc-babc-abcdefabcdef.tmp',
      ].map((name) => join(identity.coordination, name));
      await writeFile(staged[0], '', { mode: 0o600 });
      await writeFile(staged[1], '{"version":', { mode: 0o600 });
      expect(await worker.readJournal(identity)).toBeNull();
      expect(startup).toThrow('required');
      if (choice === 'fresh-start') {
        await freshStart();
        expect(await worker.readJournal(identity)).toBeNull();
        expect(await readdir(identity.destination)).toEqual([]);
        expect(startup).not.toThrow();
      } else {
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            {
              apply: choice !== 'inventory',
              declareInternal: true,
              rebuild: choice === 'rebuild',
            },
            repairs,
          ),
        ).resolves.toMatchObject({
          kind: choice === 'inventory' ? 'inventory' : 'complete',
        });
        if (choice === 'inventory') expect(startup).toThrow('required');
        else expect(startup).not.toThrow();
      }
      // Readers never remove advisory staging or mistake it for completion.
      expect(await readFile(staged[0], 'utf8')).toBe('');
      expect(await readFile(staged[1], 'utf8')).toBe('{"version":');
      await reportInternalRootCleanup(
        identity,
        choice === 'apply' || choice === 'rebuild',
        host,
      );
      for (const path of staged) expect(await statIfPresent(path)).toBeNull();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        before.fingerprint,
      );
      if (choice === 'inventory') expect(startup).toThrow('required');
      else expect(startup).not.toThrow();
    },
  );

  test.each([
    'name',
    'uuid-version',
    'suffix',
    'directory',
    'hardlink',
    'oversized',
    ...(windows ? [] : ['permissions']),
  ])('cleanup report interrupted staging refuses unsafe %s', async (shape) => {
    await source();
    await createPrivateMigrationDirectory(identity.coordination, host);
    const name =
      'cleanup-candidates.json.12345678-1234-4234-8234-123456789abc.tmp';
    const path = join(
      identity.coordination,
      shape === 'name'
        ? 'cleanup-candidates.json.not-a-uuid.tmp'
        : shape === 'uuid-version'
          ? name.replace('-4234-', '-1234-')
          : shape === 'suffix'
            ? `${name}.other`
            : name,
    );
    if (shape === 'directory') await mkdir(path, { mode: 0o700 });
    else {
      await writeFile(path, 'preserve evidence', { mode: 0o600 });
      if (shape === 'hardlink') await link(path, join(home, 'linked-evidence'));
      if (shape === 'oversized') await fs.truncate(path, 16 * 1024 * 1024 + 1);
      if (shape === 'permissions') await chmod(path, 0o644);
    }
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    expect(startup).toThrow('unsupported');
    await reportInternalRootCleanup(identity, false, host);
    expect(await statIfPresent(path)).not.toBeNull();
    expect(startup).toThrow('unsupported');
  });

  fileSymlinkFixture(
    'cleanup report interrupted staging refuses symlinks',
    async () => {
      await source();
      await createPrivateMigrationDirectory(identity.coordination, host);
      const target = join(home, 'staging-target');
      await writeFile(target, 'user data', { mode: 0o600 });
      const path = join(
        identity.coordination,
        'cleanup-candidates.json.12345678-1234-4234-8234-123456789abc.tmp',
      );
      await symlink(target, path);
      await expect(worker.readJournal(identity)).rejects.toMatchObject({
        reason: 'journal-unsupported',
      });
      expect(startup).toThrow('unsupported');
      await reportInternalRootCleanup(identity, false, host);
      expect(await readlink(path)).toBe(target);
      expect(await readFile(target, 'utf8')).toBe('user data');
    },
  );

  test.each(['rebuild', 'fresh-start', 'destination-exists'])(
    'report-only coordination preserves %s admission',
    async (choice) => {
      await source();
      const before = (await worker.inventory(identity)).fingerprint;
      const report = await reportInternalRootCleanup(identity, false, host);
      if (choice === 'fresh-start') {
        await freshStart();
        expect(startup).not.toThrow();
        expect(await worker.readJournal(identity)).toBeNull();
        expect(await readdir(identity.destination)).toEqual([]);
        await expect(freshStart()).rejects.toMatchObject({
          reason: 'recovery-required',
        });
      } else if (choice === 'destination-exists') {
        await createPrivateMigrationDirectory(identity.destination, host);
        await writeFile(
          join(identity.destination, 'keep'),
          'independent user data',
        );
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true },
            repairs,
          ),
        ).rejects.toMatchObject({ reason: 'destination-exists' });
        expect(await readFile(join(identity.destination, 'keep'), 'utf8')).toBe(
          'independent user data',
        );
        expect(await worker.readJournal(identity)).toBeNull();
      } else {
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true, rebuild: true },
            repairs,
          ),
        ).resolves.toMatchObject({ kind: 'complete' });
        await reportInternalRootCleanup(identity, true, host);
        expect((await worker.readJournal(identity))?.phase).toBe('complete');
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { apply: true, declareInternal: true, rebuild: true },
            repairs,
          ),
        ).resolves.toMatchObject({ kind: 'complete' });
      }
      expect((await worker.inventory(identity)).fingerprint).toBe(before);
      expect(await statIfPresent(report.reportPath)).not.toBeNull();
    },
  );

  fileSymlinkFixture(
    'cleanup reporting never follows payload links or replaces an aliased report',
    async () => {
      await source();
      const external = join(home, 'external-cleanup-evidence');
      await mkdir(external, { mode: 0o700 });
      const sentinel = join(external, '.DS_Store');
      await writeFile(sentinel, 'external user data');
      await symlink(external, join(identity.source, 'linked-payload'));
      const report = await reportInternalRootCleanup(identity, false, host);
      expect(report.entries).toEqual([]);
      await rm(report.reportPath);
      await symlink(sentinel, report.reportPath);
      await expect(
        reportInternalRootCleanup(identity, false, host),
      ).rejects.toThrow('Unsafe cleanup report path');
      expect(await readlink(report.reportPath)).toBe(sentinel);
      expect(await readFile(sentinel, 'utf8')).toBe('external user data');
      expect(await readlink(join(identity.source, 'linked-payload'))).toBe(
        external,
      );
    },
  );

  test('copies unindexed sidecars without Git/owner interpretation, even without a W5 log', async () => {
    await source();
    const folder = windows ? 'old workspace' : 'old\nworkspace';
    await mkdir(join(identity.source, 'workspaces', folder, 'chat-storage'), {
      recursive: true,
      mode: 0o700,
    });
    const files = new Map([
      ['workspaces/index.json', '{"version":1,"workspaces":[]}'],
      ['w5/canopy-restart.log', 'opaque log without W5 history'],
      [
        `workspaces/${folder}/workspace.json`,
        `{"version":1,"id":"orphan","repoPath":${JSON.stringify(join(identity.source, 'missing-repository'))}}`,
      ],
      [`workspaces/${folder}/.git`, 'opaque, not Git metadata'],
      [
        `workspaces/${folder}/chat-storage/opaque`,
        `retained path ${identity.source}`,
      ],
    ]);
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    for (const [path, bytes] of files)
      await writeFile(join(identity.source, path), bytes);
    const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      proveCold: () => Promise.resolve(),
      recoverW5: async (root, qualification): Promise<void> => {
        await fixtureW5(root, entry, qualification);
      },
    });
    repairs = createInternalRootRelocationRepairs({
      ...nativeRepairOptions(),
      durability: desktopW5Durability,
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(
        `Internal-root migration warning: copying unindexed workspace folder ${JSON.stringify(`workspaces/${folder}`)} unchanged.\n`,
      );
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
    for (const [path, bytes] of files)
      for (const root of [identity.source, identity.destination])
        expect(await readFile(join(root, path), 'utf8')).toBe(bytes);
    const plan = (await readFixtureJournal(identity))?.repairPlan;
    expect(plan?.workspaces).toEqual([]);
    expect(plan?.gitPlan.checkouts).toEqual([]);
    expect(
      plan?.ownedPaths.some((path) =>
        isWithin(join(identity.source, 'workspaces', folder), path),
      ),
    ).toBe(false);
    expect(
      await statIfPresent(join(identity.source, 'w5/commit-log.sqlite')),
    ).toBeNull();
  });

  test.each(['workspace.json', 'worktrees.json'])(
    'cold migration adopts legacy %s bytes and resumes its prepared transaction',
    async (filename) => {
      await source();
      await mkdir(join(identity.source, 'workspaces', 'fixture'), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const root = join(identity.source, 'workspaces');
      const manifest = '{"version":1,"id":"fixture","name":"old"}';
      const list = '{"version":1,"worktrees":[]}';
      await writeFile(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: 'fixture',
              name: 'Fixture',
              type: 'multi-repo',
              color: 'blue',
            },
          ],
        }),
      );
      await writeFile(join(root, 'fixture', 'workspace.json'), manifest);
      await writeFile(join(root, 'fixture', 'worktrees.json'), list);
      const path = join(root, 'fixture', filename);
      const before = filename === 'workspace.json' ? manifest : list;
      const current =
        filename === 'workspace.json'
          ? '{ "version": 1, "id": "fixture", "name": "CLI change" }\n'
          : '{ "version": 1, "worktrees": [{"id":"cli-added","branchName":"cli-added","createdAt":"today"}] }\n';
      const logPath = join(identity.source, 'w5', 'commit-log.sqlite');
      const log = W5CommitLog.open(logPath);
      try {
        const result = log.commit({
          operation: 'fixture.initial',
          advance: [],
          files: [{ path, contents: before, previousFingerprint: null }],
          outcome: {},
        });
        if (result.status !== 'committed')
          throw new Error('Fixture commit was not recorded');
        log.markApplied(result.commitId);
      } finally {
        log.close();
      }
      await writeFile(path, current);
      const opaquePaths: string[] = [];
      const unindexed = [
        'alpha-project-2',
        'app-advisor',
        'hey',
        'project-1',
        'standalone-chat',
        'workspace-1',
        'old workspace',
      ];
      for (const name of unindexed) {
        const sidecar = join('workspaces', name, 'chat-storage', 'opaque.bin');
        await mkdir(join(identity.source, dirname(sidecar)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          join(identity.source, sidecar),
          Buffer.from([0, 255, 1, 128]),
        );
        opaquePaths.push(sidecar);
      }
      // Daniil's unindexed "hey" also has a valid, untracked manifest.
      const heyManifest = 'workspaces/hey/workspace.json';
      await writeFile(
        join(identity.source, heyManifest),
        '{"version":1,"id":"hey","name":"Retained"}',
      );
      opaquePaths.push(heyManifest);
      for (const name of [
        'abandon-23758.log',
        'canopy-restart.log',
        'commit-log.sqlite.bak-before-abandon-23758',
        '.git',
      ]) {
        const path = join('w5', name);
        await writeFile(
          join(identity.source, path),
          `Opaque history at ${identity.source}\u0000`,
        );
        opaquePaths.push(path);
      }
      const osMetadata = 'workspaces/.DS_Store';
      await writeFile(
        join(identity.source, osMetadata),
        Buffer.from([0, 255, 1, 128]),
      );
      opaquePaths.push(osMetadata);
      const opaque = await Promise.all(
        opaquePaths.map(async (path) => ({
          path,
          bytes: await readFile(join(identity.source, path)),
          stat: await lstat(join(identity.source, path)),
        })),
      );
      const history = [
        await lifecycleFixture('completed', 'worktree-archive', true),
        await lifecycleFixture('completed', 'worktree-delete'),
        await strandedArchiveFixture(identity.source, 'P0'),
      ];
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      worker.recoverW5 = (): Promise<void> =>
        Promise.reject(new Error('earlier prepared attempt'));
      await expect(run()).rejects.toThrow('earlier prepared attempt');
      const prepared = await readFixtureJournal(identity);
      expect(prepared?.phase).toBe('prepared');
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification) => {
          await fixtureW5(root, entry, qualification);
        },
      });
      const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      let warnings: unknown[];
      try {
        await expect(run()).resolves.toMatchObject({
          kind: 'complete',
          journal: { transactionId: prepared?.transactionId },
        });
        warnings = stderr.mock.calls
          .map(([message]) => message)
          .filter(
            (message) =>
              typeof message === 'string' &&
              message.startsWith('Internal-root migration warning:'),
          );
      } finally {
        stderr.mockRestore();
      }
      expect(warnings).toHaveLength(unindexed.length);
      for (const name of unindexed)
        expect(warnings).toContain(
          `Internal-root migration warning: copying unindexed workspace folder ${JSON.stringify(`workspaces/${name}`)} unchanged.\n`,
        );
      for (const { path, bytes, stat } of opaque) {
        expect(await readFile(join(identity.destination, path))).toEqual(bytes);
        expect(await readFile(join(identity.source, path))).toEqual(bytes);
        const retained = await lstat(join(identity.source, path));
        expect([retained.ino, retained.size, retained.mtimeMs]).toEqual([
          stat.ino,
          stat.size,
          stat.mtimeMs,
        ]);
      }
      for (const item of history) {
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        expect(
          await readDestructiveJournal(
            join(identity.destination, relative(identity.source, item.path)),
          ),
        ).toMatchObject({
          state: item.record.state,
          operation: item.record.operation,
        });
      }
      for (const dataRoot of [identity.source, identity.destination]) {
        expect(
          await readFile(
            join(dataRoot, 'workspaces', 'fixture', filename),
            'utf8',
          ),
        ).toBe(current);
      }
      expect(
        (await diagnoseW5State(identity.source, 'w5-owned')).files.filter(
          (issue) => !isToleratedInternalRootW5Issue(issue),
        ),
      ).toEqual([]);
      for (const dataRoot of [identity.source, identity.destination]) {
        const db = new DatabaseSync(join(dataRoot, 'w5', 'commit-log.sqlite'), {
          readOnly: true,
        });
        try {
          expect(
            db
              .prepare(
                'SELECT new_fingerprint FROM w5_commit_files ORDER BY commit_id DESC LIMIT 1',
              )
              .get(),
          ).toMatchObject({
            new_fingerprint: fingerprintW5File(current),
          });
          expect(
            db
              .prepare(
                'SELECT state, operation FROM w5_commits ORDER BY commit_id DESC LIMIT 1',
              )
              .get(),
          ).toMatchObject({
            state: 'applied',
            operation: 'internal-root-migration.adopt-legacy-metadata',
          });
        } finally {
          db.close();
        }
      }
    },
  );

  test.each(['active', 'mid-quarantine', 'post-Git-removal'])(
    'explicitly abandons %s without replay or payload deletion',
    async (shape) => {
      await source();
      const item = await strandedArchiveFixture(identity.source, 'P0', 'crow');
      if (shape === 'active') item.record.state = 'active';
      else
        item.record.steps = [
          { phase: 'live-state-teardown', state: 'done' },
          { phase: 'retained-payload-capture', state: 'done' },
          { phase: 'git-capture', state: 'done' },
          { phase: 'provider-capture', state: 'done' },
          { phase: 'checkout-quarantine', state: 'done' },
          {
            phase: 'git-worktree-removal',
            state: shape === 'mid-quarantine' ? 'pending' : 'done',
          },
        ];
      await writeFile(item.path, JSON.stringify(item.record));
      const originalJournal = await readFile(item.path, 'utf8');
      const workspace = join(identity.source, 'workspaces/fixture');
      const checkout = join(workspace, 'worktrees/crow');
      const repository = join(home, 'shared-repository');
      await mkdir(repository, { recursive: true });
      const git = async (...args: string[]): Promise<string> =>
        (
          await promisify(execFile)('git', args, { cwd: repository })
        ).stdout.trim();
      await git('init');
      await git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      await mkdir(dirname(checkout), { recursive: true });
      await git('worktree', 'add', '-b', 'crow', checkout);
      const snapshotRef = 'refs/app/archived-containers/fixture/crow/repo';
      await git('update-ref', snapshotRef, 'HEAD');
      const snapshotOid = await git('rev-parse', snapshotRef);
      const protectedRef = `refs/canopy-migration-abandoned/archived-containers/fixture/crow/repo/${snapshotOid}`;
      const quarantine = join(workspace, 'worktrees/.crow.archive-quarantine');
      if (shape === 'mid-quarantine') {
        await git(
          'worktree',
          'lock',
          '--reason',
          'canopy: removing stale registration',
          checkout,
        );
        await rename(checkout, quarantine);
        await writeFile(
          join(quarantine, '.git'),
          'gitdir: /missing/stale-record\n',
        );
      } else if (shape === 'post-Git-removal') {
        await git('worktree', 'remove', '--force', checkout);
        await mkdir(checkout);
        await writeFile(
          join(checkout, '.git'),
          'gitdir: /missing/stale-record\n',
        );
      } else {
        await mkdir(quarantine);
        await writeFile(join(quarantine, 'sentinel'), 'quarantine payload');
      }
      await writeFile(
        join(shape === 'mid-quarantine' ? quarantine : checkout, 'sentinel'),
        'checkout payload',
      );
      const registration = join(repository, '.git/worktrees/crow');
      const registrationBefore =
        shape === 'post-Git-removal'
          ? null
          : await readFile(join(registration, 'gitdir'), 'utf8');
      if (shape === 'active') {
        const nested = join(quarantine, 'repos/secondary');
        await git('worktree', 'add', '-b', 'secondary', nested);
        await git(
          'worktree',
          'lock',
          '--reason',
          'canopy: removing stale registration',
          nested,
        );
        await rm(nested, { recursive: true });
      }
      await mkdir(join(workspace, 'worktree-data/crow'), { recursive: true });
      await writeFile(
        join(workspace, 'worktree-data/crow/chat'),
        'chat payload',
      );
      for (const folder of [
        'chats',
        'chat-storage-manifests',
        'chat-storage-v2/crow',
      ])
        await mkdir(join(workspace, folder), { recursive: true });
      await writeFile(
        join(workspace, 'chats/crow.json'),
        'legacy chat payload',
      );
      await writeFile(
        join(workspace, 'chat-storage-v2/crow/transcript'),
        'canonical transcript',
      );
      await writeFile(
        join(workspace, 'chat-storage-v2/crow/live-index.json'),
        JSON.stringify({
          version: 2,
          tabs: [],
          runtimeByChatId: { chat: { status: 'streaming' } },
        }),
      );
      const keepChat = JSON.stringify({
        tabs: [{ id: 'keep-chat', claudeTerminal: { turnState: 'running' } }],
      });
      await writeFile(join(workspace, 'chats/keep.json'), keepChat);
      const chatManifest = JSON.stringify({ version: 2, scopeId: 'crow' });
      await writeFile(
        join(workspace, 'chat-storage-manifests/crow.json'),
        chatManifest,
      );
      await writeFile(
        join(workspace, 'chat-storage-manifests/crow.json.last-good'),
        chatManifest,
      );
      await mkdir(join(workspace, 'chat-journals'), { recursive: true });
      const chatJournal =
        JSON.stringify({
          mutations: [
            {
              type: 'runtime.patched',
              chatId: 'chat',
              runtime: { status: 'streaming' },
            },
          ],
        }) + '\n';
      await writeFile(join(workspace, 'chat-journals/crow.jsonl'), chatJournal);
      const compatibilityLink = '../archived-containers/crow/partial-payload';
      if (!windows && shape === 'post-Git-removal') {
        await mkdir(join(workspace, 'chat-archives'), { recursive: true });
        await symlink(
          compatibilityLink,
          join(workspace, 'chat-archives/crow.json'),
        );
      }
      await writeFile(
        join(workspace, 'archived-containers/crow/git-state.staged.json'),
        '{"unfinished":true}',
      );
      for (const folder of ['attachments', 'script-runs', 'cost']) {
        await mkdir(join(workspace, folder, 'crow'), { recursive: true });
        await writeFile(join(workspace, folder, 'crow/sentinel'), folder);
      }
      for (const folder of [
        'summaries',
        'plans',
        'detected-plans',
        'split-maps',
      ]) {
        await mkdir(join(workspace, folder), { recursive: true });
        await writeFile(join(workspace, folder, 'crow.json.bak'), folder);
      }
      const beforeScan = await scanInterruptedWork(
        [join(identity.source, 'workspaces')],
        join(identity.source, 'pipeline-executions'),
      );
      expect(beforeScan.chatScopes).toContainEqual({
        projectId: 'fixture',
        worktreeId: 'crow',
      });
      await writeFile(
        join(identity.source, 'workspaces/index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            {
              id: 'fixture',
              name: 'Fixture',
              type: 'multi-repo',
              color: 'blue',
            },
          ],
        }),
      );
      await writeFile(
        join(workspace, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          type: 'multi-repo',
          repos: [{ id: 'repo', name: 'Repo', repoPath: repository }],
        }),
      );
      const list = JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'crow',
            branchName: 'crow',
            createdAt: item.record.createdAt,
            path: checkout,
            creation: {
              checkouts: [
                { repositoryPath: repository, checkoutPath: checkout },
              ],
            },
          },
          { id: 'keep', branchName: 'keep', createdAt: item.record.createdAt },
        ],
      });
      await writeFile(join(workspace, 'worktrees.json'), list);
      const workspaceImage = async (): Promise<unknown[]> => {
        const image: unknown[] = [];
        const visit = async (path: string): Promise<void> => {
          const stat = await lstat(path);
          if (stat.isDirectory())
            for (const name of (await readdir(path)).sort())
              await visit(join(path, name));
          else
            image.push([
              relative(workspace, path),
              stat.isSymbolicLink()
                ? await readlink(path)
                : await readFile(path),
            ]);
        };
        await visit(workspace);
        return image;
      };
      const sourceBefore = await workspaceImage();
      const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
      let names: readonly string[] = [];
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        ...(process.platform === 'darwin' && shape === 'post-Git-removal'
          ? { cloneTree: undefined }
          : {}),
        proveCold: () => Promise.resolve(),
        diagnose: (root) => diagnoseInternalRootW5(root, names),
        recoverW5: async (root, qualification) => {
          await settleInternalRootW5(
            root,
            entry,
            windows
              ? { ...qualification, assertCold: qualification.assertHeld }
              : qualification,
            {
              ownedChildPath: filesystemOptions.ownedChildPath,
              windowsProcessPath: resolve(
                '.cache/bin/win32-x64/canopy-process-identity.exe',
              ),
              abandonArchives: names,
            },
          );
        },
      });
      const inventory = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      expect(inventory).toMatchObject({
        kind: 'inventory',
        preflight: { kind: 'refused' },
      });
      expect(await diagnoseInternalRootW5(identity.source)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('--abandon-archive fixture/crow'),
        ]),
      );
      await expect(run()).rejects.toThrow('--abandon-archive fixture/crow');
      await expect(
        diagnoseInternalRootW5(identity.source, ['fixture/typo']),
      ).rejects.toThrow('does not match');
      names = ['fixture/crow'];
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
        abandonArchives: names,
      });
      const ready = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      expect(ready).toMatchObject({
        kind: 'inventory',
        preflight: { kind: 'ready' },
      });
      const persist = worker.saveJournal.bind(worker);
      worker.saveJournal = async (journal): Promise<void> => {
        await persist(journal);
        await checkInstalledShape();
        expect((await readFixtureJournal(identity))?.repairPlan).toEqual(
          journal.repairPlan,
        );
      };
      if (shape === 'active') {
        const save = worker.saveJournal.bind(worker);
        worker.saveJournal = async (journal): Promise<void> => {
          await save(journal);
          if (journal.phase === 'source-settled')
            throw new Error('after frozen abandonment');
        };
        await expect(run()).rejects.toThrow('after frozen abandonment');
        const evidenceName = (await readdir(identity.coordination)).find(
          (name) => /^lifecycle-journals-.*\.json$/.test(name),
        );
        if (!evidenceName) throw new Error('Missing abandonment sidecar');
        const evidencePath = join(identity.coordination, evidenceName);
        const original = await readFile(evidencePath, 'utf8');
        const evidence: unknown = JSON.parse(original);
        if (!evidence || typeof evidence !== 'object')
          throw new Error('Missing abandonment evidence');
        for (const abandonedPaths of [undefined, []]) {
          await writeFile(
            evidencePath,
            JSON.stringify({ ...evidence, abandonedPaths }),
          );
          await expect(readFixtureJournal(identity)).rejects.toMatchObject({
            reason: 'journal-unsupported',
          });
        }
        await writeFile(evidencePath, original);
        worker.saveJournal = save;
        names = [];
        repairs = createInternalRootRelocationRepairs({
          ...nativeRepairOptions(),
          durability: desktopW5Durability,
        });
      }
      const completed = await run();
      expect(completed).toMatchObject({ kind: 'complete' });
      expect(await workspaceImage()).toEqual(sourceBefore);
      expect(await readFile(item.path, 'utf8')).toBe(originalJournal);
      expect(await readFile(join(workspace, 'worktrees.json'), 'utf8')).toBe(
        list,
      );
      const destinationWorkspace = join(
        identity.destination,
        'workspaces/fixture',
      );
      const copiedList: unknown = JSON.parse(
        await readFile(join(destinationWorkspace, 'worktrees.json'), 'utf8'),
      );
      expect(copiedList).toEqual({
        version: 1,
        worktrees: [
          { id: 'keep', branchName: 'keep', createdAt: item.record.createdAt },
        ],
      });
      expect(
        await statIfPresent(
          join(identity.destination, relative(identity.source, item.path)),
        ),
      ).toBeNull();
      const retainedFiles = [
        ...(shape === 'mid-quarantine'
          ? [
              [
                'worktrees/.crow.archive-quarantine/sentinel',
                'checkout payload',
              ],
            ]
          : []),
        [
          'archived-containers/crow/git-state.staged.json',
          '{"unfinished":true}',
        ],
        ...(shape === 'mid-quarantine'
          ? []
          : [['worktrees/crow/sentinel', 'checkout payload']]),
        ...(shape === 'active'
          ? [
              [
                'worktrees/.crow.archive-quarantine/sentinel',
                'quarantine payload',
              ],
            ]
          : []),
        ['worktree-data/crow/chat', 'chat payload'],
        ['chats/keep.json', keepChat],
        ['chat-storage-v2/crow/transcript', 'canonical transcript'],
        ['archived-containers/crow/partial-payload', 'preserve staged bytes'],
      ];
      for (const [path, contents] of retainedFiles) {
        if (!path) throw new Error('Missing fixture path');
        expect(await readFile(join(workspace, path), 'utf8')).toBe(contents);
        if (path === 'chats/keep.json')
          expect(await readFile(join(destinationWorkspace, path), 'utf8')).toBe(
            contents,
          );
        else
          expect(
            await statIfPresent(join(destinationWorkspace, path)),
          ).toBeNull();
      }
      for (const [path, contents] of [
        ['chats/crow.json', 'legacy chat payload'],
        ['chat-storage-manifests/crow.json', chatManifest],
        ['chat-storage-manifests/crow.json.last-good', chatManifest],
        ['chat-journals/crow.jsonl', chatJournal],
      ]) {
        if (!path) throw new Error('Missing fixture path');
        expect(await readFile(join(workspace, path), 'utf8')).toBe(contents);
        expect(
          await statIfPresent(join(destinationWorkspace, path)),
        ).toBeNull();
      }
      const afterScan = await scanInterruptedWork(
        [join(identity.destination, 'workspaces')],
        join(identity.destination, 'pipeline-executions'),
      );
      expect(afterScan.chatScopes).not.toContainEqual({
        projectId: 'fixture',
        worktreeId: 'crow',
      });
      expect(afterScan.chatScopes).toContainEqual({
        projectId: 'fixture',
        worktreeId: 'keep',
      });
      expect(afterScan.errors).toEqual([]);
      if (!windows && shape === 'post-Git-removal') {
        expect(await readlink(join(workspace, 'chat-archives/crow.json'))).toBe(
          compatibilityLink,
        );
        expect(
          await statIfPresent(
            join(destinationWorkspace, 'chat-archives/crow.json'),
          ),
        ).toBeNull();
      }
      const report = await reportInternalRootCleanup(
        identity,
        true,
        host,
        undefined,
        ['fixture/crow'],
      );
      expect(
        report.entries.filter(
          (row) =>
            row.copy === 'new-root' && row.category === 'abandoned-archive',
        ),
      ).toEqual([]);
      for (const copy of ['old-root']) {
        const entries = report.entries.filter(
          (row) => row.copy === copy && row.category === 'abandoned-archive',
        );
        expect(entries.length).toBeGreaterThanOrEqual(
          shape === 'active' ? 7 : 5,
        );
        expect(
          entries.some((row) =>
            row.path.endsWith(join('chat-storage-v2', 'crow')),
          ),
        ).toBe(true);
        expect(
          entries.some((row) =>
            row.path.endsWith(join('chat-storage-manifests', 'crow.json')),
          ),
        ).toBe(true);

        expect(
          entries.every(
            (row) =>
              row.disposition === 'review before deleting' &&
              row.reason.includes('fixture/crow'),
          ),
        ).toBe(true);
      }
      if (registrationBefore !== null)
        expect(report.entries).toContainEqual(
          expect.objectContaining({
            path: registration,
            category: 'abandoned-archive',
          }),
        );
      expect(await git('rev-parse', snapshotRef)).toBe(snapshotOid);
      expect(await git('rev-parse', protectedRef)).toBe(snapshotOid);
      if (registrationBefore !== null)
        expect(await readFile(join(registration, 'gitdir'), 'utf8')).toBe(
          registrationBefore,
        );
      if (shape === 'mid-quarantine')
        expect(await readFile(join(registration, 'locked'), 'utf8')).toContain(
          'canopy: removing stale registration',
        );
      const refCandidate = report.entries.find(
        (row) => row.path === `${join(repository, '.git')}#${protectedRef}`,
      );
      expect(refCandidate).toMatchObject({
        category: 'abandoned-archive',
        disposition: 'review before deleting',
      });
      expect(refCandidate?.reason).toContain('fixture/crow');
      for (const path of [
        'worktrees/crow',
        'worktrees/.crow.archive-quarantine',
        'archived-containers/crow',
        'worktree-data/crow',
        'chat-storage-v2/crow',
        'attachments/crow',
        'script-runs/crow',
        'cost/crow',
        'summaries/crow.json.bak',
        'plans/crow.json.bak',
        'detected-plans/crow.json.bak',
        'split-maps/crow.json.bak',
      ])
        expect(
          await statIfPresent(join(destinationWorkspace, path)),
        ).toBeNull();
      const previousRoot = process.env.CANOPY_DATA_DIR;
      process.env.CANOPY_DATA_DIR = identity.destination;
      try {
        expect(await hasUnresolvedDestructiveRecovery('fixture', 'crow')).toBe(
          false,
        );
        const {
          reconcileArchivedGitRefsForWorkspace,
          recoverArchivedGitTeardownsForWorkspace,
        } = await import('../archived-container-git');
        await recoverArchivedGitTeardownsForWorkspace('fixture');
        await reconcileArchivedGitRefsForWorkspace('fixture');
        expect(await git('rev-parse', protectedRef)).toBe(snapshotOid);
        await expect(
          git('show-ref', '--verify', snapshotRef),
        ).rejects.toThrow();
      } finally {
        if (previousRoot === undefined) delete process.env.CANOPY_DATA_DIR;
        else process.env.CANOPY_DATA_DIR = previousRoot;
      }
      expect(startup).not.toThrow();
    },
  );

  test.each([false, true])(
    'commit abandonment preview matches real W5 deletion across selected files (unrelated mismatch=%s)',
    async (unrelatedMismatch) => {
      await source();
      await mkdir(join(identity.source, 'workspaces'), { mode: 0o700 });
      await mkdir(join(identity.source, 'workspaces/fixture'), { mode: 0o700 });
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const path = join(identity.source, 'workspaces/index.json');
      const backup = `${path}.bak`;
      const worktrees = join(
        identity.source,
        'workspaces/fixture/worktrees.json',
      );
      const old = '{"version":1,"workspaces":[]}';
      const current = '{"version":1,"workspaces":[],"retained":true}';
      const pending = '{"version":1,"workspaces":[],"pending":true}';
      const oldWorktrees = '{"version":1,"worktrees":[]}';
      await writeFile(path, current);
      await writeFile(backup, old);
      await writeFile(worktrees, oldWorktrees);
      const logPath = join(identity.source, 'w5/commit-log.sqlite');
      const log = W5CommitLog.open(logPath);
      const ids: number[] = [];
      try {
        const initial = log.commit({
          operation: 'fixture.initial',
          advance: [],
          files: [
            { path, contents: old, previousFingerprint: null },
            {
              path: worktrees,
              contents: oldWorktrees,
              previousFingerprint: null,
            },
            {
              path: backup,
              contents: unrelatedMismatch ? pending : old,
              previousFingerprint: null,
            },
          ],
          outcome: {},
        });
        log.markApplied(initial.commitId);
        const failedWorktrees = log.commit({
          operation: 'w5.worktree_list.write',
          advance: [],
          files: [
            {
              path: worktrees,
              contents: '{"version":1,"worktrees":[],"pending":true}',
              previousFingerprint: fingerprintW5File(oldWorktrees),
            },
          ],
          outcome: {},
        });
        log.markCommitRecoveryRequired(failedWorktrees.commitId, {
          error: 'ENOSPC',
        });
        ids.push(failedWorktrees.commitId);
        for (const state of ['applied', 'recovery-required']) {
          const result = log.commit({
            operation: 'w5.workspace_index.write',
            advance: [],
            files: [
              {
                path,
                contents: state === 'applied' ? current : pending,
                previousFingerprint: fingerprintW5File(
                  state === 'applied' ? old : current,
                ),
              },
            ],
            outcome: {},
          });
          if (state === 'applied') log.markApplied(result.commitId);
          else {
            log.markCommitRecoveryRequired(result.commitId, {
              error: 'ENOSPC',
            });
            ids.unshift(result.commitId);
          }
        }
      } finally {
        log.close();
      }
      const before = await readFile(logPath);
      const preview = await diagnoseW5State(
        identity.source,
        'w5-owned',
        true,
        ids,
      );
      expect(preview.logIssue).toBeNull();
      expect(preview.commits.map(({ commitId }) => commitId)).toEqual(
        [...ids].reverse(),
      );
      const blockers = unrelatedMismatch
        ? ['log-mismatch: index.json.bak']
        : [];
      if (!windows)
        expect(await diagnoseInternalRootW5(identity.source, [], ids)).toEqual(
          blockers,
        );
      expect(await readFile(logPath)).toEqual(before);
      const writer = W5CommitLog.open(logPath);
      try {
        for (const id of ids) writer.abandonRecoveryRequiredCommit(id);
      } finally {
        writer.close();
      }
      const actual = await diagnoseW5State(identity.source, 'w5-owned');
      expect(actual.logIssue).toBeNull();
      expect(actual.commits).toEqual([]);
      expect(preview.files).toEqual(actual.files);
      expect(await diagnoseInternalRootW5(identity.source)).toEqual(blockers);
      expect(await readFile(path, 'utf8')).toBe(current);
      expect(await readFile(backup, 'utf8')).toBe(old);
      expect(await readFile(worktrees, 'utf8')).toBe(oldWorktrees);
    },
  );

  test.each([
    { target: 'worktree', history: 'matching' },
    { target: 'index', history: 'matching' },
    { target: 'index', history: 'mismatched' },
    { target: 'index', history: 'untracked' },
  ])(
    'ENOSPC pending $target save with $history history requires a named opt-in, retains evidence and keeps files',
    async ({ target, history }) => {
      await source();
      for (const name of ['runtime', 'workspaces', 'w5', 'workspaces/fixture'])
        await createPrivateMigrationDirectory(
          join(identity.source, name),
          host,
        );
      await writeFile(
        join(identity.source, 'workspaces/index.json'),
        '{"version":1,"workspaces":[]}',
        { mode: 0o600 },
      );
      const relativePath =
        target === 'worktree' ? 'fixture/worktrees.json' : 'index.json';
      const path = join(identity.source, 'workspaces', relativePath);
      const operation =
        target === 'worktree'
          ? 'w5.worktree_list.write'
          : 'w5.workspace_index.write';
      const before =
        target === 'worktree'
          ? '{"version":1,"worktrees":[]}'
          : '{"version":1,"workspaces":[]}';
      const after =
        target === 'worktree'
          ? '{"version":1,"worktrees":[],"pending":true}'
          : '{"version":1,"workspaces":[],"pending":true}';
      await writeFile(path, before, { mode: 0o600 });
      const original = await lstat(path);
      const log = W5CommitLog.open(
        join(identity.source, 'w5/commit-log.sqlite'),
      );
      let commitId: number;
      let appliedId: number;
      let keyedId: number;
      const receipt = {
        caller: 'fixture',
        operation: 'core.worktree.update',
        idempotencyKey: 'pending-one-decision',
        fingerprint: 'fixture-parameters',
      };
      const enospc: unknown = expect.stringContaining('ENOSPC');
      try {
        const applied = log.commit({
          operation: 'fixture.applied',
          advance: [],
          files:
            history === 'untracked'
              ? []
              : [
                  {
                    path,
                    contents: history === 'matching' ? before : after,
                    previousFingerprint: null,
                  },
                ],
          outcome: {},
        });
        appliedId = applied.commitId;
        log.markApplied(appliedId);
        const result = log.commit({
          operation,
          advance:
            target === 'worktree'
              ? [{ kind: 'worktrees', workspaceId: 'fixture' }]
              : [{ kind: 'workspaces' }],
          files: [
            {
              path,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
        commitId = result.commitId;
        const pending = log
          .listPendingCommits()
          .find((row) => row.commitId === commitId);
        if (!pending) throw new Error('Missing pending save');
        expect(
          await applyW5Commit(log, pending, {
            root: join(identity.source, 'workspaces'),
            durability: {
              ...desktopW5Durability,
              writeFileDurably: () =>
                Promise.reject(
                  new Error('ENOSPC: no space left on device, write'),
                ),
            },
          }),
        ).toMatchObject({ status: 'recovery-required', error: enospc });
        const keyed = log.commit({
          operation: receipt.operation,
          receipt,
          advance: [],
          files: [],
          outcome: { saved: true },
        });
        keyedId = keyed.commitId;
        log.markCommitRecoveryRequired(keyedId, { error: 'ENOSPC' });
      } finally {
        log.close();
      }
      let ids: readonly number[] = [];
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        diagnose: (root) => diagnoseInternalRootW5(root, [], ids),
        recoverW5: (root, qualification) =>
          settleInternalRootW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            windows
              ? { ...qualification, assertCold: qualification.assertHeld }
              : qualification,
            {
              ownedChildPath: filesystemOptions.ownedChildPath,
              windowsProcessPath: resolve(
                '.cache/bin/win32-x64/canopy-process-identity.exe',
              ),
              abandonCommits: ids,
            },
          ).then(() => undefined),
      });
      const blockers = (await diagnoseInternalRootW5(identity.source)).join(
        '\n',
      );
      for (const text of [
        operation,
        `paths=["workspaces/${relativePath}"]`,
        'reason="ENOSPC: no space left on device, write"',
        `--abandon-commit ${commitId}`,
      ])
        expect(blockers).toContain(text);
      await expect(run()).rejects.toThrow('ENOSPC');
      expect(await readFile(path, 'utf8')).toBe(before);
      for (const unknown of [commitId + 100, appliedId]) {
        await expect(
          diagnoseInternalRootW5(identity.source, [], [unknown]),
        ).rejects.toThrow('does not match');
        ids = [unknown];
        await expect(run()).rejects.toThrow(
          windows ? 'macOS/Linux' : 'does not match',
        );
      }
      ids = [commitId];
      if (windows) {
        expect(
          (await diagnoseInternalRootW5(identity.source, [], ids)).join(' '),
        ).toContain('macOS/Linux');
        await expect(run()).rejects.toThrow('macOS/Linux');
        return;
      }
      expect(
        (await diagnoseInternalRootW5(identity.source, [], ids)).join(' '),
      ).toContain(`--abandon-commit ${keyedId}`);
      ids = [commitId, keyedId];
      const logPath = join(identity.source, 'w5/commit-log.sqlite');
      const logBeforePreview = await readFile(logPath);
      const preview = await migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: true },
        repairs,
      );
      expect(await readFile(logPath)).toEqual(logBeforePreview);
      expect(await readFile(path, 'utf8')).toBe(before);
      if (history === 'mismatched') {
        expect(preview).toMatchObject({
          kind: 'inventory',
          preflight: { blockers: ['log-mismatch: index.json'] },
        });
        await expect(run()).rejects.toThrow('log-mismatch');
        return;
      }
      expect(preview).toMatchObject({
        kind: 'inventory',
        preflight: { blockers: [] },
      });
      expect((await diagnoseW5State(identity.source)).commits).toHaveLength(2);
      const actualOpen = fs.open;
      const failEvidence = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          if (String(args[0]).includes('abandoned-w5-commits-'))
            throw new Error('ENOSPC: cannot retain evidence');
          return actualOpen(...args);
        });
      try {
        await expect(run()).rejects.toThrow('cannot retain evidence');
      } finally {
        failEvidence.mockRestore();
      }
      expect((await diagnoseW5State(identity.source)).commits).toHaveLength(2);
      const syncFailures: jest.SpyInstance[] = [];
      const failEvidenceSync = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args) => {
          const file = await actualOpen(...args);
          if (String(args[0]).includes('abandoned-w5-commits-'))
            syncFailures.push(
              jest
                .spyOn(file, 'sync')
                .mockRejectedValueOnce(
                  new Error('ENOSPC: cannot sync evidence'),
                ),
            );
          return file;
        });
      try {
        await expect(run()).rejects.toThrow('cannot sync evidence');
      } finally {
        failEvidenceSync.mockRestore();
        for (const failure of syncFailures) failure.mockRestore();
      }
      expect((await diagnoseW5State(identity.source)).commits).toHaveLength(2);
      const previousEvidence = new Set(await readdir(identity.coordination));
      const interruptBatch = jest.spyOn(
        W5CommitLogHost.prototype,
        'abandonRecoveryRequiredCommit',
      );
      const abandon = interruptBatch.getMockImplementation();
      if (!abandon) throw new Error('Missing original abandon implementation');
      interruptBatch.mockImplementation(async function (
        this: W5CommitLogHost,
        id,
      ) {
        if (id === keyedId)
          throw new Error('fixture interrupted second abandon');
        await abandon.call(this, id);
      });
      try {
        await expect(run()).rejects.toThrow('interrupted second abandon');
      } finally {
        interruptBatch.mockRestore();
      }
      expect(
        (await diagnoseW5State(identity.source)).commits.map(
          ({ commitId }) => commitId,
        ),
      ).toEqual([keyedId]);
      expect(await readFile(path, 'utf8')).toBe(before);
      const evidenceName = (await readdir(identity.coordination)).find(
        (name) =>
          name.startsWith('abandoned-w5-commits-') &&
          !previousEvidence.has(name),
      );
      if (!evidenceName) throw new Error('Missing commit evidence');
      await expect(
        diagnoseInternalRootW5(identity.source, [], ids),
      ).rejects.toThrow('does not match');
      ids = [keyedId];
      const build = worker.build.bind(worker);
      worker.build = (): ReturnType<InternalRootMigrationWorker['build']> =>
        Promise.reject(new Error('after W5 abandonment'));
      await expect(run()).rejects.toThrow('after W5 abandonment');
      worker.build = build;
      const stopped = await worker.readJournal(identity);
      if (!stopped) throw new Error('Missing stopped migration');
      ids = [];
      await writeFile(join(identity.source, 'new-work'), 'current source');
      await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
      const preserve = worker.preserveUnpublished.bind(worker);
      worker.preserveUnpublished = async (
        journal,
        checkOnly,
      ): Promise<void> => {
        await preserve(journal, checkOnly);
        if (!checkOnly)
          throw new Error('interrupted restart after W5 abandonment');
      };
      const restart = (): ReturnType<typeof migrateInternalRoot> =>
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, restart: true },
          repairs,
        );
      await expect(restart()).rejects.toThrow(
        'interrupted restart after W5 abandonment',
      );
      worker.preserveUnpublished = preserve;
      expect(await worker.readJournal(identity)).toBeNull();
      await expect(
        createFreshInternalRoot({ identity, worker, ...filesystemOptions }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(
        await statIfPresent(
          join(
            identity.coordination,
            `restarted-${stopped.transactionId}`,
            'journal.json',
          ),
        ),
      ).not.toBeNull();
      const retainedEvidence = await readFile(
        join(identity.coordination, evidenceName),
      );
      await expect(restart()).resolves.toMatchObject({ kind: 'complete' });
      expect(await readFile(join(identity.coordination, evidenceName))).toEqual(
        retainedEvidence,
      );
      expect(
        await readFile(join(identity.destination, 'new-work'), 'utf8'),
      ).toBe('current source');
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(
        await readFile(
          join(identity.destination, 'workspaces', relativePath),
          'utf8',
        ),
      ).toBe(before);
      const unchanged = await lstat(path);
      expect({ ino: unchanged.ino, mtime: unchanged.mtimeMs }).toEqual({
        ino: original.ino,
        mtime: original.mtimeMs,
      });
      expect((await diagnoseW5State(identity.source)).commits).toEqual([]);
      const evidence: unknown = JSON.parse(
        await readFile(join(identity.coordination, evidenceName), 'utf8'),
      );
      expect(evidence).toMatchObject({
        source: identity.source,
        commits: [
          {
            commit: {
              commit_id: commitId,
              operation,
              diagnostics_json: enospc,
            },
            files: [
              {
                path,
                contents: after,
                previous_fingerprint: fingerprintW5File(before),
              },
            ],
          },
          {
            commit: { commit_id: keyedId, operation: receipt.operation },
            receipts: [
              {
                operation: receipt.operation,
                idempotency_key: receipt.idempotencyKey,
              },
            ],
          },
        ],
      });
      await assertPrivate(
        join(identity.coordination, evidenceName),
        'file',
        0o600,
      );
      await checkInstalledShape();
      ids = [commitId, keyedId];
      await expect(
        diagnoseInternalRootW5(identity.source, [], ids),
      ).rejects.toThrow('does not match');
    },
  );

  test('commit opt-ins refuse unsafe receipt release without dropping any selected record', async () => {
    await source();
    await createPrivateMigrationDirectory(join(identity.source, 'w5'), host);
    const path = join(identity.source, 'w5/commit-log.sqlite');
    const log = W5CommitLog.open(path);
    const ids: number[] = [];
    try {
      for (const operation of [
        'core.worktree.update',
        'core.worktree.create',
      ]) {
        const { commitId } = log.commit({
          operation,
          advance: [],
          files: [],
          outcome: {},
          receipt: {
            caller: 'fixture',
            operation,
            idempotencyKey: operation,
            fingerprint: operation,
          },
        });
        log.markCommitRecoveryRequired(commitId, { error: 'ENOSPC' });
        ids.push(commitId);
      }
    } finally {
      log.close();
    }
    const before = await readFile(path);
    await expect(
      diagnoseInternalRootW5(identity.source, [], ids),
    ).rejects.toThrow('operation-excluded');
    expect(await readFile(path)).toEqual(before);
    expect(
      (await diagnoseW5State(identity.source)).commits.map(
        ({ commitId }) => commitId,
      ),
    ).toEqual(ids);
  });
  test.each([
    'settled',
    'reservation',
    'legacy-untracked',
    'active-lifecycle',
    'recovery-required-lifecycle',
    ...strandedCases,
    'prepared-inert',
    'completed-lifecycles',
    'prepared-completed-lifecycles',
    'unreadable-lifecycle',
    'unrecognized-lifecycle',
    'quarantined-lifecycle',
    'invalid-lifecycle-state',
    'many-blockers',
    'corrupt-record',
    'commit-conflict',
    'workspace-root-artifact',
    'w5-artifact',
    'w5-artifact-directory',
    'historical-log-path',
  ])('uses actual W5 recovery at source for %s state', async (state) => {
    await source();
    await mkdir(join(identity.source, 'runtime'), { mode: 0o700 });
    await mkdir(join(identity.source, 'workspaces'), { mode: 0o700 });
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    const index = join(identity.source, 'workspaces', 'index.json');
    const before = '{"version":1,"workspaces":[]}';
    const after = '{"version":1,"workspaces":[],"settled":true}';
    await writeFile(index, before, { mode: 0o600 });
    const log = W5CommitLog.open(
      join(identity.source, 'w5', 'commit-log.sqlite'),
    );
    try {
      if (state !== 'legacy-untracked')
        log.commit({
          operation: 'core.workspace.update',
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      if (state === 'reservation')
        log.reserve({
          reservationId: 'uncertain',
          operation: 'core.worktree.create',
          diagnostics: { note: 'Never repeat an uncertain effect' },
        });
    } finally {
      log.close();
    }
    const history: Awaited<ReturnType<typeof lifecycleFixture>>[] = [];
    if (
      strandedCases.some((group) => group === state) ||
      state === 'prepared-inert'
    ) {
      const group = strandedCases.find((group) => group === state) ?? 'P0';
      history.push(await strandedArchiveFixture(identity.source, group));
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
    }
    if (state === 'active-lifecycle') await lifecycleFixture('active');
    if (state === 'recovery-required-lifecycle')
      await lifecycleFixture('recovery-required');
    if (
      state === 'completed-lifecycles' ||
      state === 'prepared-completed-lifecycles'
    ) {
      for (const cleanup of [undefined, false, true])
        history.push(
          await lifecycleFixture('completed', 'worktree-archive', cleanup),
        );
      history.push(await lifecycleFixture('completed', 'worktree-delete'));
      history.push(await lifecycleFixture('completed', 'workspace-delete'));
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
    }
    if (state === 'unreadable-lifecycle') {
      const { path } = await lifecycleFixture('completed');
      await writeFile(path, 'invalid JSON');
    }
    if (state === 'unrecognized-lifecycle') {
      const { path } = await lifecycleFixture('completed');
      await rename(path, join(dirname(path), 'unexpected.json'));
    }
    if (state === 'quarantined-lifecycle') {
      const { path } = await lifecycleFixture('completed');
      const quarantined = join(identity.source, 'w5/quarantined-lifecycles');
      await mkdir(quarantined);
      await rename(path, join(quarantined, 'unreadable.json'));
    }
    if (state === 'invalid-lifecycle-state') {
      const { path, record } = await lifecycleFixture('completed');
      await writeFile(path, JSON.stringify({ ...record, state: 'unknown' }));
    }
    if (state === 'many-blockers') {
      const { path, record } = await lifecycleFixture('active');
      for (let index = 0; index < 25; index++) {
        const name = createHash('sha256').update(String(index)).digest('hex');
        await writeFile(
          join(dirname(path), `${name}.json`),
          JSON.stringify({
            ...record,
            workspaceId: `workspace-${index}`,
            worktreeId: 'long\n' + 'x'.repeat(1500),
          }),
        );
        const broken = join(identity.source, 'workspaces', `unknown-${index}`);
        await mkdir(broken);
        await writeFile(join(broken, 'workspace.json'), 'corrupt');
      }
    }
    if (state === 'corrupt-record') {
      const workspace = join(identity.source, 'workspaces', 'broken');
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(join(workspace, 'workspace.json'), 'not-json', {
        mode: 0o600,
      });
    }
    if (state === 'workspace-root-artifact')
      await writeFile(
        join(identity.source, 'workspaces', 'unexpected'),
        'keep',
      );
    if (state === 'w5-artifact')
      await writeFile(join(identity.source, 'w5', 'unexpected'), 'keep');
    if (state === 'w5-artifact-directory')
      await mkdir(join(identity.source, 'w5', 'unexpected'));
    if (state === 'historical-log-path') {
      await mkdir(join(identity.source, 'workspaces', 'commit-log'));
      const log = W5CommitLog.open(
        join(identity.source, 'w5/commit-log.sqlite'),
      );
      try {
        const result = log.commit({
          operation: 'fixture.historical-path',
          advance: [],
          files: [
            {
              path: join(home, 'predecessor/workspaces/index.json'),
              contents: '{}',
              previousFingerprint: null,
            },
          ],
          outcome: {},
        });
        if (result.status !== 'committed')
          throw new Error('Missing historical receipt');
        log.markApplied(result.commitId);
      } finally {
        log.close();
      }
    }
    const conflict = '{"version":1,"workspaces":[],"manual-change":true}';
    if (state === 'commit-conflict') await writeFile(index, conflict);
    const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: async (root, qualification): Promise<void> => {
        await fixtureW5(root, entry, qualification);
      },
      proveCold: () => Promise.resolve(),
    });
    let preparedTransaction: string | undefined;
    if (
      state === 'prepared-completed-lifecycles' ||
      state === 'prepared-inert'
    ) {
      const recover = worker.recoverW5.bind(worker);
      // Model the old script's post-recovery filename-count refusal.
      worker.recoverW5 = async (journal): Promise<void> => {
        await recover(journal);
        throw new InternalRootMigrationRefused(
          'recovery-required',
          'W5 remains unresolved: lifecycle artifacts 5',
        );
      };
      await expect(run()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      const prepared = await readFixtureJournal(identity);
      expect(prepared).toMatchObject({ version: 7, phase: 'prepared' });
      expect(prepared?.repairPlan).toBeUndefined();
      preparedTransaction = prepared?.transactionId;
      worker.recoverW5 = recover;
    }
    if (
      state === 'reservation' ||
      state === 'active-lifecycle' ||
      state === 'recovery-required-lifecycle' ||
      state === 'unreadable-lifecycle' ||
      state === 'unrecognized-lifecycle' ||
      state === 'quarantined-lifecycle' ||
      state === 'invalid-lifecycle-state' ||
      state === 'many-blockers' ||
      state === 'corrupt-record' ||
      state === 'commit-conflict' ||
      state === 'w5-artifact-directory' ||
      state === 'historical-log-path'
    ) {
      const migration = run();
      await expect(migration).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(migration).rejects.toThrow('W5 remains unresolved:');
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(await readFile(index, 'utf8')).toBe(
        state === 'commit-conflict' ? conflict : after,
      );
      const prepared = await readFixtureJournal(identity);
      expect(prepared?.phase).toBe('prepared');
      if (
        state === 'active-lifecycle' ||
        state === 'recovery-required-lifecycle'
      ) {
        await expect(migration).rejects.toThrow(
          `worktree-archive workspace=fixture worktree=history-worktree-archive state=${state === 'active-lifecycle' ? 'active' : 'recovery-required'}`,
        );
        // A previously prepared invocation resumes its transaction after offline repair.
        await lifecycleFixture('completed');
        repairs = createInternalRootRelocationRepairs({
          ...nativeRepairOptions(),
          durability: desktopW5Durability,
        });
        await expect(run()).resolves.toMatchObject({
          kind: 'complete',
          journal: { transactionId: prepared?.transactionId },
        });
      }
      if (state === 'many-blockers') {
        let failure: unknown;
        try {
          await migration;
        } catch (error) {
          failure = error;
        }
        if (!(failure instanceof InternalRootMigrationRefused))
          throw new Error('Missing bounded refusal');
        expect(failure.recovery).toContain('… 5 more');
        expect(failure.recovery).toContain('… 6 more');
        expect(failure.recovery).toContain('state=active');
        expect(failure.recovery.length).toBeLessThan(30000);
        expect(failure.recovery).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }
      if (state === 'corrupt-record')
        await expect(migration).rejects.toThrow(
          'corrupt-file: broken/workspace.json',
        );
      if (state === 'historical-log-path')
        await expect(migration).rejects.toThrow('unknown-artifact: commit-log');
      if (state === 'unreadable-lifecycle')
        await expect(migration).rejects.toThrow(
          'corrupt-file: w5/destructive-lifecycles/',
        );
      if (state === 'unrecognized-lifecycle')
        await expect(migration).rejects.toThrow(
          'unknown-artifact: w5/destructive-lifecycles/unexpected.json',
        );
      if (state === 'quarantined-lifecycle')
        await expect(migration).rejects.toThrow(
          'quarantined-journal: w5/quarantined-lifecycles/unreadable.json',
        );
    } else {
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      if (state === 'workspace-root-artifact')
        for (const root of [identity.source, identity.destination])
          expect(
            await readFile(join(root, 'workspaces/unexpected'), 'utf8'),
          ).toBe('keep');
      if (state === 'w5-artifact')
        for (const root of [identity.source, identity.destination])
          expect(await readFile(join(root, 'w5/unexpected'), 'utf8')).toBe(
            'keep',
          );
      if (preparedTransaction)
        expect((await readFixtureJournal(identity))?.transactionId).toBe(
          preparedTransaction,
        );
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(state === 'legacy-untracked' ? before : after);
      for (const item of history) {
        expect(await readFile(item.path, 'utf8')).toBe(item.bytes);
        const copied = await readDestructiveJournal(
          join(identity.destination, relative(identity.source, item.path)),
        );
        expect(copied).toMatchObject({
          state: item.record.state,
          operation: item.record.operation,
        });
        expect(copied.cleanupRequired).toBe(item.record.cleanupRequired);
        if (copied.state === 'recovery-required') {
          if (!copied.worktreeId)
            throw new Error('Missing stranded worktree identity');
          const previous = process.env.CANOPY_DATA_DIR;
          process.env.CANOPY_DATA_DIR = identity.destination;
          try {
            expect(
              await hasUnresolvedDestructiveRecovery(
                copied.workspaceId,
                copied.worktreeId,
              ),
            ).toBe(true);
            expect(await reportDestructiveRecovery()).toContainEqual(copied);
            for (const operation of [
              'worktree-archive',
              'worktree-delete',
            ] as const) {
              const effects = jest.fn();
              await expect(
                withDestructiveLifecycle(
                  {
                    operation,
                    workspaceId: copied.workspaceId,
                    worktreeId: copied.worktreeId,
                    createdAt: copied.createdAt,
                  },
                  effects,
                ),
              ).rejects.toMatchObject({ reason: 'recovery-required' });
              expect(effects).not.toHaveBeenCalled();
            }
          } finally {
            if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
            else process.env.CANOPY_DATA_DIR = previous;
          }
          for (const root of [identity.source, identity.destination])
            expect(
              await readFile(
                join(
                  root,
                  'workspaces',
                  copied.workspaceId,
                  'archived-containers',
                  copied.worktreeId,
                  'partial-payload',
                ),
                'utf8',
              ),
            ).toBe('preserve staged bytes');
        }

        expect(copied.ownedPaths.map(({ path }) => path)).toEqual(
          item.record.ownedPaths.map(({ path }) =>
            join(identity.destination, relative(identity.source, path)),
          ),
        );
        expect(
          copied.ownedPaths.every(
            ({ path }) => !isWithin(identity.source, path),
          ),
        ).toBe(true);
      }
    }
  });

  unixEndpointFixture(
    'POSIX overlong root reaches its W5 endpoint through the private socket alias (CAN-5694)',
    async () => {
      const longHome = join(home, 'x'.repeat(110));
      await mkdir(longHome, { mode: 0o700 });
      identity = internalRootIdentity(longHome, canopy);
      await source();
      for (const name of ['runtime', 'workspaces', 'w5'])
        await mkdir(join(identity.source, name), { mode: 0o700 });
      const index = join(identity.source, 'workspaces', 'index.json');
      await writeFile(index, '{"version":1,"workspaces":[]}');
      W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      ).close();
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            qualification,
          );
        },
      });
      // Too long for `runtime/core.sock`: an alias under the user's temporary root.
      const endpoints = createPlatformEndpointServices(
        process.platform === 'darwin' ? 'darwin' : 'linux',
      );
      if (endpoints.semantics !== 'filesystem-socket')
        throw new Error('Wrong family');
      const { alias } = endpoints.address({
        dataRoot: identity.source,
        endpointName: 'core',
      });
      expect(alias).toBeDefined();
      try {
        await expect(run()).resolves.toMatchObject({ kind: 'complete' });
        expect(await statIfPresent(identity.destination)).not.toBeNull();
      } finally {
        if (alias) await rm(alias.link, { force: true });
      }
    },
  );

  test.each([0, 1024 * 1024, 1024 * 1024 + 1])(
    'qualifies external preimage byte boundary %i',
    async (size) => {
      await source();
      const external = join(home, 'gitdir');
      const preimage = Buffer.alloc(size, '.');
      await writeFile(external, preimage, { mode: 0o600 });
      repairs.prepare = async (): ReturnType<
        InternalRootRepairs['prepare']
      > => {
        expect(await readFile(external)).toEqual(preimage);
        return { kind: 'ready', externalFiles: [external] };
      };
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        await writeFile(external, identity.destination);
        return { kind: 'ok' };
      };
      if (size > 1024 * 1024) {
        await expect(run()).rejects.toMatchObject({
          reason: 'unsupported-layout',
        });
        expect(await statIfPresent(identity.coordination)).toBeNull();
        expect(recover).not.toHaveBeenCalled();
        return;
      }
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(await readFile(external, 'utf8')).toBe(identity.destination);
    },
  );

  test.each(['first-preimage', 'all-preimages', 'postimages'])(
    'resumes interruption after %s without losing the original external bytes',
    async (point) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files) await writeFile(file, identity.source);
      repairs.prepare = async (): ReturnType<
        InternalRootRepairs['prepare']
      > => {
        if (await statIfPresent(identity.destination))
          return { kind: 'refused', recovery: 'existing destination' };
        for (const file of files)
          if ((await readFile(file, 'utf8')) !== identity.source)
            return { kind: 'refused', recovery: 'changed backlink' };
        return { kind: 'ready', externalFiles: files };
      };
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        for (const file of files) await writeFile(file, identity.destination);
        return { kind: 'ok' };
      };
      const capture = worker.captureExternal.bind(worker);
      const seal = worker.sealExternal.bind(worker);
      let failed = false;
      worker = {
        ...worker,
        captureExternal: async (
          journal,
        ): ReturnType<InternalRootMigrationWorker['captureExternal']> => {
          const entries = await capture(
            point === 'first-preimage' && !failed
              ? { ...journal, externalFiles: files.slice(0, 1) }
              : journal,
          );
          if (point !== 'postimages' && !failed) {
            failed = true;
            throw new Error('external evidence power loss');
          }
          return entries;
        },
        sealExternal: async (
          journal,
        ): ReturnType<InternalRootMigrationWorker['sealExternal']> => {
          const entries = await seal(journal);
          if (point === 'postimages' && !failed) {
            failed = true;
            throw new Error('external evidence power loss');
          }
          return entries;
        },
      };
      await expect(run()).rejects.toThrow('external evidence power loss');
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      const backups = (await readdir(identity.coordination)).filter((name) =>
        name.endsWith('.preimage'),
      );
      expect(backups).toHaveLength(2);
      await assertPrivate(identity.coordination, 'directory', 0o700);
      for (const backup of backups) {
        await assertPrivate(join(identity.coordination, backup), 'file', 0o600);
        expect(
          await readFile(join(identity.coordination, backup), 'utf8'),
        ).toBe(identity.source);
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      for (const file of files)
        expect(await readFile(file, 'utf8')).toBe(identity.destination);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    'before-intent',
    'restore-intent',
    'first-backlink',
    'all-backlinks',
    'discard-intent',
    'discard-renamed',
    'discarded',
    'source-settled',
    'prepare',
    'repaired',
    'sealed',
    'published',
  ])(
    'completed rebuild resumes interruption at %s without recapturing repaired backlinks',
    async (point) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files)
        await writeFile(file, identity.source, { mode: 0o644 });
      const native = host.windows;
      const metadata = native
        ? files.map((file) => {
            const { attributes, security } = native.inspect(file);
            return { attributes, security };
          })
        : [];
      let prepareCalls = 0;
      let rebuilding = false;
      let failed = false;
      const interrupt = (): never => {
        failed = true;
        throw new Error('rebuild power loss');
      };
      const qualifyPublished = repairs.qualifyPublished.bind(repairs);
      repairs = {
        qualifyPublished,
        prepare: async (): ReturnType<InternalRootRepairs['prepare']> => {
          // Models C's authority observer and old-root Git backlink inventory.
          if (await statIfPresent(identity.destination))
            return { kind: 'refused', recovery: 'existing destination' };
          for (const file of files)
            if ((await readFile(file, 'utf8')) !== identity.source)
              return { kind: 'refused', recovery: 'changed backlink' };
          if (rebuilding && point === 'prepare' && !failed) interrupt();
          prepareCalls++;
          return { kind: 'ready', externalFiles: files };
        },
        repair: async (context): ReturnType<InternalRootRepairs['repair']> => {
          assertCWorkingRoot(context);
          for (const file of files) await writeFile(file, identity.destination);
          if (rebuilding && point === 'repaired' && !failed) interrupt();
          return { kind: 'ok' };
        },
        verify: async (context): ReturnType<InternalRootRepairs['verify']> => {
          assertCWorkingRoot(context);
          for (const file of files)
            expect(await readFile(file, 'utf8')).toBe(identity.destination);
          return { kind: 'ok' };
        },
      };
      await run();
      const settled = await worker.inventory(identity);
      const save = worker.saveJournal.bind(worker);
      const restore = worker.restoreExternal.bind(worker);
      const discard = worker.discardDestination.bind(worker);
      const publish = worker.publish.bind(worker);
      rebuilding = true;
      worker = {
        ...worker,
        saveJournal: async (journal): Promise<void> => {
          if (
            !failed &&
            point === 'before-intent' &&
            journal.phase === 'restoring-external'
          )
            interrupt();
          if (
            !failed &&
            point === 'all-backlinks' &&
            journal.phase === 'rebuilding'
          )
            interrupt();
          await save(journal);
          if (
            !failed &&
            ((point === 'restore-intent' &&
              journal.phase === 'restoring-external') ||
              (point === 'discard-intent' && journal.phase === 'rebuilding') ||
              (point === 'source-settled' &&
                journal.phase === 'source-settled') ||
              (point === 'sealed' && journal.phase === 'publishing'))
          )
            interrupt();
        },
        publish: async (journal): Promise<void> => {
          await publish(journal);
          if (point === 'published' && !failed) interrupt();
        },
        restoreExternal: async (journal): Promise<void> => {
          if (point === 'first-backlink' && !failed) {
            await restore({
              ...journal,
              externalFiles: files.slice(0, 1),
              externalSnapshots: journal.externalSnapshots?.slice(0, 1),
            });
            interrupt();
          }
          await restore(journal);
        },
        discardDestination: async (journal): Promise<void> => {
          if (point === 'discard-renamed' && !failed) {
            await rename(
              identity.destination,
              join(identity.coordination, 'discarding'),
            );
            interrupt();
          }
          await discard(journal);
          if (point === 'discarded' && !failed) interrupt();
        },
      };
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toThrow('rebuild power loss');
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(prepareCalls).toBe(2);
      for (const file of files) {
        expect(await readFile(file, 'utf8')).toBe(identity.destination);
        if (host.windows) {
          const { attributes, security } = host.windows.inspect(file);
          expect({ attributes, security }).toEqual(
            metadata[files.indexOf(file)],
          );
        } else expect((await lstat(file)).mode & 0o777).toBe(0o644);
      }
      expect((await worker.inventory(identity)).fingerprint).toBe(
        settled.fingerprint,
      );
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        settled.sourceIdentity,
      );
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    'edited-backlink',
    windows ? 'changed-readonly-attribute' : 'changed-mode',
    'missing-preimage',
    'corrupt-preimage',
  ])(
    'completed rebuild refuses %s without changing either backlink or discarding the destination',
    async (change) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files)
        await writeFile(file, identity.source, { mode: 0o600 });
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({
          kind: 'ready',
          externalFiles: files,
        });
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        for (const file of files) await writeFile(file, identity.destination);
        return { kind: 'ok' };
      };
      await run();
      const destination = await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      );
      const second = files[1];
      if (!second) throw new Error('Missing fixture backlink');
      if (change === 'edited-backlink')
        await writeFile(second, 'operator edit');
      if (change === 'changed-mode') await chmod(second, 0o644);
      if (change === 'changed-readonly-attribute') await chmod(second, 0o400);
      if (change === 'missing-preimage' || change === 'corrupt-preimage') {
        const backup = (await readdir(identity.coordination)).find((name) =>
          name.endsWith('.preimage'),
        );
        if (!backup) throw new Error('Missing preimage fixture');
        if (change === 'missing-preimage')
          await rm(join(identity.coordination, backup));
        else await writeFile(join(identity.coordination, backup), 'corrupt');
      }
      const before = await Promise.all(files.map((file) => readFile(file)));
      const rebuild = migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      );
      // Readonly is admitted for observation, not authorization to rewrite an
      // external postimage whose recorded mode no longer matches.
      await expect(rebuild).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
        before,
      );
      expect(
        await migrationNodeIdentity(
          identity.destination,
          await lstat(identity.destination),
        ),
      ).toBe(destination);
      expect((await readFixtureJournal(identity))?.phase).toBe('complete');
      if (change === 'changed-readonly-attribute') await chmod(second, 0o600);
    },
  );

  test('restore resume refuses a backlink edited after another file was restored', async () => {
    await source();
    const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
    for (const file of files) await writeFile(file, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: files,
      });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      for (const file of files) await writeFile(file, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const restore = worker.restoreExternal.bind(worker);
    worker.restoreExternal = async (journal): Promise<void> => {
      await restore({
        ...journal,
        externalFiles: files.slice(0, 1),
        externalSnapshots: journal.externalSnapshots?.slice(0, 1),
      });
      throw new Error('partial restore');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('partial restore');
    worker.restoreExternal = restore;
    const second = files[1];
    if (!second) throw new Error('Missing fixture backlink');
    await writeFile(second, 'operator edit after interruption');
    const before = await Promise.all(files.map((file) => readFile(file)));
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
      before,
    );
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
    expect((await readFixtureJournal(identity))?.phase).toBe(
      'restoring-external',
    );
  });

  test.each([4, 5, 8])(
    'v%i completion is refused rather than adopting old or unknown qualification evidence',
    async (version) => {
      await source();
      await run();
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing journal');
      await writeFile(
        join(identity.coordination, 'journal.json'),
        JSON.stringify({ ...journal, version }),
      );
      const recovery: unknown = expect.stringContaining('including v4');
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'journal-unsupported', recovery });
      expect(await statIfPresent(identity.destination)).not.toBeNull();
    },
  );

  test('rebuild resume refuses a user edit after restore intent completed, before destination discard', async () => {
    await source();
    const external = join(home, 'gitdir');
    await writeFile(external, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({ kind: 'ready', externalFiles: [external] });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      await writeFile(external, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const save = worker.saveJournal.bind(worker);
    worker.saveJournal = async (journal): Promise<void> => {
      await save(journal);
      if (journal.phase === 'rebuilding') throw new Error('restore finished');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('restore finished');
    worker.saveJournal = save;
    await writeFile(external, 'operator edit after restore');
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
    expect(await readFile(external, 'utf8')).toBe(
      'operator edit after restore',
    );
  });

  test('v6 journals refuse a changed sibling staging path', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    await writeFile(
      join(identity.coordination, 'journal.json'),
      JSON.stringify({
        ...journal,
        stagingRoot: join(identity.coordination, 'staging'),
      }),
    );
    await expect(run()).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    expect(await statIfPresent(identity.destination)).not.toBeNull();
  });

  test('the default port refuses a completed rebuild before restoring external files', async () => {
    await source();
    const external = join(home, 'gitdir');
    await writeFile(external, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: [external],
      });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      await writeFile(external, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const before = await readFixtureJournal(identity);
    await expect(
      migrateInternalRoot(worker, identity, { ...apply, rebuild: true }),
    ).rejects.toMatchObject({ reason: 'repair-unavailable' });
    expect(await readFixtureJournal(identity)).toEqual(before);
    expect(await readFile(external, 'utf8')).toBe(identity.destination);
    expect(await statIfPresent(identity.destination)).not.toBeNull();
  });

  test('external repair membership is journaled before effects and partial repair can be retried', async () => {
    await source();
    const git = join(home, 'external', '.git', 'worktrees', 'managed');
    await mkdir(git, { recursive: true, mode: 0o700 });
    const metadata = join(git, 'gitdir');
    await writeFile(metadata, `${identity.source}/managed/.git`, {
      mode: 0o644,
    });
    const original = await worker.inventory(identity);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({ kind: 'ready', externalFiles: [metadata] });
    repairs.repair = async (
      context,
    ): ReturnType<InternalRootRepairs['repair']> => {
      expect(context.externalFiles).toEqual([metadata]);
      expect((await readFixtureJournal(identity))?.externalFiles).toEqual([
        metadata,
      ]);
      expect(await statIfPresent(identity.destination)).toBeNull();
      await writeFile(join(context.workingRoot, 'partial'), 'discard on retry');
      await writeFile(metadata, `${identity.destination}/managed/.git`);
      return {
        kind: 'refused',
        recovery: 'Simulated partial repair; retry migration.',
      };
    };
    await expect(run()).rejects.toMatchObject({ reason: 'repair-refused' });
    expect((await readFixtureJournal(identity))?.phase).toBe('building');
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
    repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
      Promise.resolve({ kind: 'ok' });
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await statIfPresent(join(identity.destination, 'partial')),
    ).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test('unsupported external paths refuse before source recovery', async () => {
    await source();
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: [join(identity.source, 'preferences.json')],
      });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(recover).not.toHaveBeenCalled();
  });

  test('duplicate external membership cannot be resumed', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    await worker.saveJournal({
      ...journal,
      externalFiles: ['/external/.git/gitdir', '/external/.git/gitdir'],
    });
    await expect(run()).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
  });

  test('metadata inventory scales with sparse bytes and catches same-size edits by mtime', async () => {
    await source();
    const file = join(identity.source, 'preferences.json');
    const before = await worker.inventory(identity);
    const stat = await lstat(file);
    await utimes(file, stat.atime, new Date(stat.mtimeMs + 10_000));
    expect((await worker.inventory(identity)).fingerprint).not.toBe(
      before.fingerprint,
    );
    expect(before).toMatchObject({ files: 1, bytes: 16 });
  });

  test('small critical W5 records retain byte verification even with preserved metadata', async () => {
    await source();
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    const file = join(identity.source, 'w5', 'receipt.json');
    await writeFile(file, 'before');
    const original = await lstat(file);
    const before = await worker.inventory(identity);
    await writeFile(file, 'after!');
    await utimes(file, original.atimeMs / 1000, original.mtimeMs / 1000);
    expect((await worker.inventory(identity)).fingerprint).not.toBe(
      before.fingerprint,
    );
  });

  test('a source change (Windows readonly attribute) before staging exposure refuses before publication', async () => {
    await source();
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      ...(windows
        ? {}
        : {
            cloneTree: async (from, to): Promise<void> => {
              await portableClone(from, to);
              await writeFile(join(from, 'new-file'), 'change');
            },
          }),
    });
    if (windows) {
      const build = worker.build.bind(worker);
      worker.build = async (
        journal,
      ): ReturnType<InternalRootMigrationWorker['build']> => {
        const inode = await build(journal);
        await chmod(join(identity.source, 'preferences.json'), 0o400);
        return inode;
      };
    }
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await statIfPresent(identity.source)).not.toBeNull();
  });

  test('an interrupted staging clone is discarded and rebuilt from the intact source', async () => {
    await source();
    let attempts = 0;
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      ...(windows
        ? {}
        : {
            cloneTree: async (from, to): Promise<void> => {
              await portableClone(from, to);
              attempts++;
              if (attempts === 1) {
                await writeFile(join(to, 'partial'), 'incomplete');
                throw new Error('interrupted clone');
              }
            },
          }),
    });
    if (windows) {
      const build = worker.build.bind(worker);
      worker.build = async (
        journal,
      ): ReturnType<InternalRootMigrationWorker['build']> => {
        const inode = await build(journal);
        attempts++;
        if (attempts === 1) {
          await writeFile(
            join(identity.coordination, 'staging', 'partial'),
            'incomplete',
          );
          throw new Error('interrupted clone');
        }
        return inode;
      };
    }
    await expect(run()).rejects.toThrow('interrupted clone');
    expect((await readFixtureJournal(identity))?.phase).toBe('building');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await run()).kind).toBe('complete');
    expect(
      await statIfPresent(join(identity.destination, 'partial')),
    ).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  test.each(['unknown', 'substituted'])(
    'refuses %s sibling staging without adopting or deleting it',
    async (kind) => {
      await source();
      const staging = worker.stagingRoot(identity);
      if (kind === 'substituted') {
        repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
          Promise.reject(new Error('repair interruption'));
        await expect(run()).rejects.toThrow('repair interruption');
        await rename(staging, join(home, 'preserved-staging'));
      }
      await mkdir(staging, { mode: 0o700 });
      await writeFile(join(staging, 'independent'), 'keep');
      await expect(run()).rejects.toMatchObject({
        reason: 'destination-exists',
      });
      expect(await readFile(join(staging, 'independent'), 'utf8')).toBe('keep');
      if (kind === 'unknown') {
        expect(recover).not.toHaveBeenCalled();
        expect(await statIfPresent(identity.coordination)).toBeNull();
      }
    },
  );

  test.each(['cloned', 'journaled', 'exposed', 'returned-to-private'])(
    'resumes sibling staging interruption at %s from a fresh worker',
    async (point) => {
      await source();
      const build = worker.build.bind(worker);
      const expose = worker.exposeStaging.bind(worker);
      const save = worker.saveJournal.bind(worker);
      let failed = false;
      worker = {
        ...worker,
        build: async (
          journal,
        ): ReturnType<InternalRootMigrationWorker['build']> => {
          if (
            point === 'returned-to-private' &&
            !failed &&
            (await statIfPresent(worker.stagingRoot(identity)))
          ) {
            await rename(
              worker.stagingRoot(identity),
              join(identity.coordination, 'staging'),
            );
            failed = true;
            throw new Error('staging power loss');
          }
          const inode = await build(journal);
          if (point === 'cloned' && !failed) {
            failed = true;
            throw new Error('staging power loss');
          }
          return inode;
        },
        saveJournal: async (journal): Promise<void> => {
          await save(journal);
          if (
            point === 'journaled' &&
            !failed &&
            journal.phase === 'building' &&
            journal.stagingIdentity
          ) {
            failed = true;
            throw new Error('staging power loss');
          }
        },
        exposeStaging: async (journal): Promise<void> => {
          await expose(journal);
          if (point === 'exposed' && !failed) {
            failed = true;
            throw new Error('staging power loss');
          }
        },
      };
      if (point === 'returned-to-private') {
        repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
          Promise.reject(new Error('repair interruption'));
        await expect(run()).rejects.toThrow('repair interruption');
      }
      await expect(run()).rejects.toThrow('staging power loss');
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: recover,
        proveCold: () => Promise.resolve(),
      });
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.reject(
          new Error('Fresh prepare on partial staging is forbidden'),
        );
      repairs.repair = (context): ReturnType<InternalRootRepairs['repair']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      };
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('publication after rename completes from B seals without calling C on the destination', async () => {
    await source();
    const publish = worker.publish.bind(worker);
    worker.publish = async (journal): Promise<void> => {
      await publish(journal);
      throw new Error('completion interrupted');
    };
    await expect(run()).rejects.toThrow('completion interrupted');
    worker.publish = publish;
    repairs.verify = (): ReturnType<InternalRootRepairs['verify']> =>
      Promise.reject(new Error('C must not verify the final destination'));
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  });

  apfsCloneFixture(
    'POSIX clone failure is actionable (Windows uses native construction, never APFS clone)',
    async () => {
      await source();
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: recover,
        proveCold: () => Promise.resolve(),
        cloneTree: (): Promise<void> =>
          Promise.reject(
            new InternalRootMigrationRefused(
              'clone-unavailable',
              'APFS required',
            ),
          ),
      });
      await expect(run()).rejects.toMatchObject({
        reason: 'clone-unavailable',
      });
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect(recover).toHaveBeenCalledTimes(1);
      if (process.platform !== 'darwin')
        await expect(
          cloneInternalRoot(identity.source, join(home, 'clone')),
        ).rejects.toMatchObject({ reason: 'clone-unavailable' });
    },
  );

  test('read-only cohort and maintenance preflight reject live owners but admit departed records', async () => {
    await source();
    const runtime = join(identity.source, 'runtime');
    await mkdir(join(runtime, 'hosts'), { recursive: true, mode: 0o700 });
    const now = Math.floor(Date.now() / 1000);
    const inspect = jest.fn(() =>
      Promise.resolve({
        state: 'running' as const,
        pid: 200,
        startIdentity: `darwin:v1:200:${now}`,
      }),
    );
    const secureFiles = windows
      ? hostPlatformServices(createPlatformEndpointServices('win32'))
          .secureFiles
      : {
          permissions: jest.fn(() =>
            Promise.resolve({ state: 'private' as const }),
          ),
        };
    const options = { dataRoot: identity.source, inspect, secureFiles };
    await writeFile(
      join(runtime, 'hosts', '12345678-1234-4234-8234-123456789abc.json'),
      encodeMemberRecord({
        pid: 200,
        startEstimateMs: now * 1000,
        hostKind: 'cli',
      }),
    );
    expect(await listW5HostPeers(options)).toEqual(['cli']);
    await writeFile(
      join(runtime, 'w5-maintenance.json'),
      encodeMaintenanceRecord({
        pid: 200,
        startIdentity: `darwin:v1:200:${now}`,
        token: '12345678-1234-4234-8234-123456789abc',
      }),
    );
    expect(await inspectW5MaintenanceOwner(options)).toBe(true);
    const departed = {
      ...options,
      inspect: (): Promise<{ state: 'absent' }> =>
        Promise.resolve({ state: 'absent' }),
    };
    expect(await inspectW5MaintenanceOwner(departed)).toBe(false);
    expect(await listW5HostPeers(departed)).toEqual([]);
  });

  test('a reachable daemon socket refuses without changing the tree', async () => {
    await source();
    await mkdir(join(identity.source, 'runtime'), { mode: 0o700 });
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      const endpoint = windows
        ? createPlatformEndpointServices('win32').address({
            dataRoot: identity.source,
            endpointName: 'core',
          })
        : undefined;
      server.listen(
        endpoint?.kind === 'named-pipe'
          ? endpoint.path
          : join(identity.source, 'runtime', 'core.sock'),
        resolve,
      );
    });
    const assertStopped = windows
      ? (root: string): Promise<void> =>
          assertInternalRootNativeDaemonStopped(root, 'win32')
      : assertInternalRootDaemonStopped;
    try {
      await expect(assertStopped(identity.source)).rejects.toThrow(
        'writer-active',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await expect(assertStopped(identity.source)).resolves.toBeUndefined();
  });

  test('an aliased W5 directory never reaches the recovery writer', async () => {
    await source();
    const outside = join(home, 'outside-w5');
    await mkdir(outside, { mode: 0o700 });
    await symlink(
      outside,
      join(identity.source, 'w5'),
      windows ? 'junction' : 'dir',
    );
    const migration = migrateInternalRoot(
      createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(root, 'unused-worker', qualification);
        },
      }),
      identity,
      apply,
      repairs,
    );
    if (windows) await expect(migration).rejects.toThrow('attributes-or-case');
    else
      await expect(migration).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    expect(await readdir(outside)).toEqual([]);
  });
});

test('targeted process proof admits unrelated jobs but refuses both brands and helpers even in ancestry', () => {
  const brands = [canopy, unstoppableCode];
  const session = '100 90 /path/to/node\n90 1 /bin/zsh\n';
  for (const executable of [
    '/usr/bin/python3',
    '/usr/libexec/git-core/git',
    '/usr/sbin/periodic',
    '/bin/ps',
  ])
    expect(() =>
      assertInternalRootColdProcesses(
        `${session}50 1 ${executable}`,
        100,
        90,
        brands,
      ),
    ).not.toThrow();
  for (const brand of brands) {
    for (const executable of [
      brand.cliName,
      `${brand.cliName}d`,
      brand.displayName,
      `${brand.displayName} (Internal)`,
      `${brand.displayName} Helper (Renderer)`,
      `/Applications/${brand.displayName} (Internal).app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`,
    ])
      expect(() =>
        assertInternalRootColdProcesses(
          `100 90 /path/to/node\n90 1 ${executable}`,
          100,
          90,
          brands,
        ),
      ).toThrow('writer-active');
  }
  expect(() =>
    assertInternalRootColdProcesses('unreadable', 100, 90, brands),
  ).toThrow();
  expect(() =>
    assertInternalRootColdProcesses('90 1 /bin/zsh', 100, 90, brands),
  ).toThrow('Incomplete');
});

// lsof is Darwin-only; native Windows handles are qualified by the composed matrix.
const lsofParserFixture = windows ? test.skip : test;
lsofParserFixture(
  'POSIX lsof parser fixture: single-pass open-file proof covers cwd, files, coordination and external Git without prefix collisions',
  () => {
    const roots = [
      '/example/source',
      '/example/destination',
      '/example/secure',
      '/example/coordination',
      '/example/repo/.git',
    ];
    const self = 'p100\0fcwd\0n/elsewhere\0\n';
    for (const root of roots)
      for (const fd of ['cwd', '3'])
        expect(() =>
          assertInternalRootColdOpenFiles(
            `${self}p200\0ccloudflared\0f${fd}\0n${root}/entry\0`,
            '',
            roots,
            new Set([100]),
          ),
        ).toThrow(
          `Internal root migration refused (writer-active): Process 200 (cloudflared) has an open file or working directory under an affected tree: ${JSON.stringify(`${root}/entry`)}.`,
        );
    const blockers =
      'p200\0ccloudflared\0fcwd\0n/example/source/entry\0f3\0n/example/source/other\0' +
      'p300\0cnode\0f3\0n/example/destination/file\0';
    const refusal =
      'Process 200 (cloudflared) has an open file or working directory under an affected tree: "/example/source/entry". ' +
      'Process 300 (node) has an open file or working directory under an affected tree: "/example/destination/file".';
    for (const output of [
      `${self}${blockers}`,
      blockers,
      `${self}${blockers}pbad\0`,
      `${self}${blockers}zunknown\0`,
    ])
      expect(() =>
        assertInternalRootColdOpenFiles(output, '', roots, new Set([100])),
      ).toThrow(`Internal root migration refused (writer-active): ${refusal}`);
    expect(() =>
      assertInternalRootColdOpenFiles(
        `${self}pbad\0${blockers}`,
        '',
        roots,
        new Set([100]),
      ),
    ).toThrow('Invalid lsof PID');
    expect(
      assertInternalRootColdOpenFiles(
        `${self}p200\0fcwd\0n/example/source-other\0`,
        '',
        roots,
        new Set([100]),
      ),
    ).toBeUndefined();
    expect(
      assertInternalRootColdOpenFiles(
        `${self}p101\0f3\0n/example/source/file\0`,
        '',
        roots,
        new Set([100, 101]),
      ),
    ).toBeUndefined();
    expect(
      assertInternalRootColdOpenFiles(
        self,
        "lsof: WARNING: can't stat() apfs file system /unrelated-volume\n      Output information may be incomplete.\n",
        roots,
        new Set([100]),
      ),
    ).toBeUndefined();
    for (const warning of [
      'permission denied',
      "lsof: WARNING: can't stat() apfs file system /example/source\n      Output information may be incomplete.\n",
    ])
      expect(() =>
        assertInternalRootColdOpenFiles(self, warning, roots, new Set([100])),
      ).toThrow();
    expect(() =>
      assertInternalRootColdOpenFiles('', '', roots, new Set([100])),
    ).toThrow('Incomplete');
  },
);

// Protected or deleted macOS mappings retain their accessible ancestor aliases.
lsofParserFixture.each(['EACCES', 'EPERM', 'ENOENT'])(
  'POSIX lsof cold proof projects %s paths through the deepest accessible ancestor',
  async (code) => {
    const home = await mkdtemp(join(tmpdir(), 'cold-open-files-'));
    const root = join(home, 'affected');
    const outside = join(home, 'outside');
    const alias = join(home, 'alias');
    const self = 'p100\0fcwd\0n/elsewhere\0\n';
    const observe = storageObservation.observeStoragePathSync;
    try {
      await mkdir(root);
      await mkdir(outside);
      await symlink(root, alias);
      const roots = [observe(root).canonicalPath];
      for (const ancestor of [outside, alias]) {
        const denied = join(ancestor, 'protected');
        const path = join(denied, 'nested', 'events.allowlist');
        const observation = jest
          .spyOn(storageObservation, 'observeStoragePathSync')
          .mockImplementation((candidate) => {
            if (candidate === denied || candidate.startsWith(`${denied}/`))
              throw Object.assign(new Error('Injected permission denial'), {
                code,
              });
            return observe(candidate);
          });
        try {
          for (const kind of ['open-file', 'skipped-mount']) {
            const check = (): void =>
              assertInternalRootColdOpenFiles(
                kind === 'open-file'
                  ? `${self}p200\0f3\0n${path} (deleted)\0`
                  : self,
                kind === 'skipped-mount'
                  ? `lsof: WARNING: can't stat() apfs file system ${path}\n      Output information may be incomplete.\n`
                  : '',
                roots,
                new Set([100]),
              );
            if (ancestor === alias) expect(check).toThrow('writer-active');
            else expect(check).not.toThrow();
            expect(observation).toHaveBeenCalledWith(ancestor);
          }
        } finally {
          observation.mockRestore();
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

lsofParserFixture.each(['EIO', 'ENOENT', 'ELOOP'])(
  'POSIX lsof cold proof retains observation failure %s without a resolvable ancestor',
  (code) => {
    const failure = Object.assign(new Error('Injected observation failure'), {
      code,
    });
    const observe = storageObservation.observeStoragePathSync;
    const observation = jest
      .spyOn(storageObservation, 'observeStoragePathSync')
      .mockImplementation(() => {
        throw failure;
      });
    try {
      for (const kind of ['open-file', 'skipped-mount']) {
        observation.mockClear();
        expect(() =>
          assertInternalRootColdOpenFiles(
            kind === 'open-file'
              ? 'p100\0n/elsewhere\0p200\0f3\0n/unrelated/file\0'
              : 'p100\0n/elsewhere\0',
            kind === 'skipped-mount'
              ? "lsof: WARNING: can't stat() apfs file system /unrelated/file\n"
              : '',
            ['/example/source'],
            new Set([100]),
          ),
        ).toThrow(failure);
        expect(observation).toHaveBeenCalledTimes(code === 'ENOENT' ? 3 : 1);
      }
      observation.mockImplementation((path) => {
        if (path === '/unrelated/file') throw failure;
        return observe(path);
      });
      expect(() =>
        assertInternalRootColdOpenFiles(
          'p100\0n/elsewhere\0p200\0ccloudflared\0fcwd\0n/example/source/first\0' +
            'p250\0cnode\0f3\0n/unrelated/file\0' +
            'p300\0cnode\0f3\0n/example/source/second\0',
          '',
          ['/example/source'],
          new Set([100]),
        ),
      ).toThrow(
        'Internal root migration refused (writer-active): Process 200 (cloudflared) has an open file or working directory under an affected tree: "/example/source/first". ' +
          'Process 300 (node) has an open file or working directory under an affected tree: "/example/source/second".',
      );
    } finally {
      observation.mockRestore();
    }
  },
);

test.each([
  canopy,
  unstoppableCode,
  { displayName: "Brand's [test]+", cliName: 'test-brand' },
])(
  'crash reporter stop pattern is shell-safe and scoped to the $displayName bundle',
  (brand) => {
    for (const channel of ['', ' (Internal)', ' (RC)']) {
      const executable = `/Applications/Owner's apps/${brand.displayName}${channel}.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`;
      const secondExecutable = `/Volumes/Second copy/${brand.displayName}${channel}.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`;
      try {
        assertInternalRootColdProcesses(
          `100 90 /path/to/node\n90 1 /bin/zsh\n55 1 ${executable}\n56 1 ${secondExecutable}`,
          100,
          90,
          [brand],
        );
        throw new Error('Expected crash reporter refusal');
      } catch (error) {
        if (!(error instanceof InternalRootMigrationRefused)) throw error;
        expect(error.reason).toBe('writer-active');
        const command = error.recovery.split('run: ')[1];
        expect(command).toMatch(/^pkill -f '/);
        if (!command) throw new Error('Missing crash reporter stop command');
        const quoted = command.slice('pkill -f '.length);
        expect(quoted).toContain("'\\''");
        const pattern = quoted.slice(1, -1).replaceAll("'\\''", "'");
        const regex = new RegExp(pattern);
        expect(regex.test(`${executable} --database=/tmp/crashes`)).toBe(true);
        expect(regex.test(secondExecutable)).toBe(true);
        expect(
          regex.test(
            '/Applications/Other.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
          ),
        ).toBe(false);
        expect(regex.test(command)).toBe(false);
        if (!windows) {
          const shellPattern = execFileSync(
            '/bin/sh',
            ['-c', `printf '%s' ${quoted}`],
            { encoding: 'utf8' },
          );
          expect(shellPattern).toBe(pattern);
          expect(
            execFileSync('grep', ['-E', '--', shellPattern], {
              encoding: 'utf8',
              input: `${executable}\n${secondExecutable}\n/Applications/Other.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler\n${command}\n`,
            }),
          ).toBe(`${executable}\n${secondExecutable}\n`);
        }
      }
    }
  },
);

// Native filesystem/W5/Git outcomes in CI; whole-host admission is manual evidence.
defineComposedMigrationCases({ wholeHost: false });

test('orphaned crash reporter refusal names the reporter and exact manual stop command', () => {
  expect(() =>
    assertInternalRootColdProcesses(
      '100 90 /path/to/node\n90 1 /bin/zsh\n55 1 /Applications/Canopy (Internal).app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
      100,
      90,
      [canopy],
    ),
  ).toThrow(
    String.raw`Crash reporter remains (PIDs 55). After quitting the app, run: pkill -f '/Applications/Canopy \(Internal\)\.app/Contents/Frameworks/Electron Framework\.framework/Helpers/[c]hrome_crashpad_handler'`,
  );
});
