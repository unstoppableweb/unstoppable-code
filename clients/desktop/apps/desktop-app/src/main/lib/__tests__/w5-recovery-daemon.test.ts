import { spawn } from 'node:child_process';
// A real Worker owns the commit log behind the daemon authority and framed port.
// Synthetic ownership rows exercise the pre-cut flow without flipping the repository.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireW5MaintenanceExclusion,
  ensureW5HostMembership,
  registerW5Host,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { internalRootFilesystemHost } from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import type * as Storage from '@canopy/core-runtime/storage';
import * as electron from 'electron';
import * as maintenanceModule from '../w5-maintenance';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { W5CommitLog } from '@canopy/core-runtime/node/w5/commit-log';
import { internalRootIdentity } from '@canopy/desktop-shared/node/internal-root-migration';
import canopy from '../../../../../../brands/canopy/brand.json';
import { settleInternalRootW5 } from '../internal-root-migration-maintenance';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof Storage>(
    '@canopy/core-runtime/storage',
  );
  return {
    ...actual,
    STORAGE_OWNERSHIP: actual.STORAGE_OWNERSHIP.map((row) =>
      ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
        row.id,
      )
        ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
        : row,
    ),
  };
});
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { createDaemonW5Host } from '../../../../../core-daemon/src/w5-host';
import { createW5RecoveryMaintenanceContext } from '../w5-recovery-maintenance';
import { runW5Maintenance } from '../w5-maintenance';
import { recoveryActions, runW5RecoveryLaunch } from '../w5-recovery-launch';
import {
  isW5RecoveryAvailable,
  isW5RecoveryEntryEnabled,
  isW5ReservationReleaseQualified,
} from '../w5-recovery-gates';
import { isW5DaemonFlipCompiled } from '../w5-flip-gate';
import { runDesktopW5RecoveryLaunch } from '../w5-recovery-desktop';
import {
  writeW5RecoveryRequest,
  w5RecoveryRequestPath,
  w5RecoveryResultPath,
} from '../w5-recovery-request';
import { W5_RESOLVABLE_RESERVATION_OPERATIONS } from '../w5-maintenance-decisions';
import type { W5Diagnosis } from '../w5-maintenance-diagnosis';

jest.setTimeout(60_000);
// These cases resolve/diagnose general W5 state or use the POSIX chmod fault.
// Windows supports only transaction-qualified migration reopen, exercised below.
const generalPosixMaintenance = process.platform === 'win32' ? test.skip : test;
const workerEntry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
let root: string;
let data: string;
let temporary: string;
let maintenanceFailures: unknown[];
beforeEach(() => {
  maintenanceFailures = [];
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'rx-')));
  data = temporary;
  if (process.platform === 'win32') {
    data = join(temporary, 'private');
    const native = internalRootFilesystemHost(
      resolve('.cache/native-owned-child/win32-x64/core-owned-child.node'),
    ).windows;
    if (!native) throw new Error('Windows custody helper required');
    native.mkdir(data);
  }
  root = join(data, 'workspaces');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(data, 'runtime'), { mode: 0o700 });
  writeFileSync(join(root, 'index.json'), '{"version":1,"workspaces":[]}');
});
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

async function maintenance(
  request: Parameters<typeof runW5Maintenance>[1],
): ReturnType<typeof runW5Maintenance> {
  try {
    return await runW5Maintenance(
      createW5RecoveryMaintenanceContext(data, { workerEntry }),
      request,
    );
  } catch (error) {
    maintenanceFailures.push(
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            reason: 'reason' in error ? error.reason : undefined,
            stack: error.stack,
          }
        : error,
    );
    throw error;
  }
}
async function expectDaemonWriteResumes(): Promise<void> {
  const daemon = createDaemonW5Host({
    canonicalDataRoot: data,
    workerEntry,
    admission: () => Promise.resolve(),
  });
  const harness = await startW5DaemonRecordHarness({ host: daemon.port });
  try {
    await daemon.open();
    const client = await harness.connect();
    const before = readFileSync(join(root, 'index.json'), 'utf8');
    const next = before.replace(/}$/, ',"recovered":true}');
    await expect(
      client.instruction('core.workspaceRecords.commit', {
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }],
        files: [
          {
            target: { kind: 'index' },
            contents: next,
            previousFingerprint: fingerprintW5File(before),
          },
        ],
        outcome: null,
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(next);
  } finally {
    await harness.close();
    await daemon.stop();
  }
}

async function crashReservedDaemon(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      join(__dirname, 'fixtures/w5-recovery-daemon-child.ts'),
      data,
      workerEntry,
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let stdout = '';
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Daemon reservation did not become durable: ${stderr}`),
          ),
        30_000,
      );
      const done = (error?: Error): void => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', (error) => done(error));
      child.once('exit', (code, signal) =>
        done(
          new Error(
            `Daemon fixture exited before crash: ${code ?? signal}; ${stderr}`,
          ),
        ),
      );
      child.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString();
        if (stdout.includes('"reserved":"crashed"')) done();
      });
    });
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  }
}

generalPosixMaintenance(
  'crash reservation → exclusive reopen → resolve → the daemon accepts a write (POSIX general maintenance; disabled on Windows)',
  async () => {
    await crashReservedDaemon();
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: () =>
        Promise.resolve([
          { kind: 'resolve-reservation', reservationId: 'crashed' },
        ]),
      record: () => Promise.resolve(),
      allowReservationRelease: true,
    });
    expect({ outcome, maintenanceFailures }).toMatchObject({
      outcome: { state: 'complete' },
      maintenanceFailures: [],
    });
    await expectDaemonWriteResumes();
  },
);

generalPosixMaintenance(
  'the production history gate withholds every reservation class and rejects a forged release (POSIX general maintenance; disabled on Windows)',
  async () => {
    expect(isW5ReservationReleaseQualified()).toBe(false);
    await crashReservedDaemon();
    const calls: string[] = [];
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance: (request) => {
        calls.push(request.mode);
        return maintenance(request);
      },
      choose: (diagnosis) => {
        expect(diagnosis.reservations).toEqual([
          expect.objectContaining({
            reservationId: 'crashed',
            state: 'recovery-required',
          }),
        ]);
        // A name cannot prove whether a reservation predates registration/#5615.
        const allClasses: W5Diagnosis = {
          ...diagnosis,
          reservations: [
            ...W5_RESOLVABLE_RESERVATION_OPERATIONS,
            'core.workspace.create',
            'unknown.operation',
          ].map((operation, index) => ({
            reservationId: String(index),
            operation,
            state: 'recovery-required',
            diagnostics: '{}',
          })),
        };
        expect(
          recoveryActions(allClasses, isW5ReservationReleaseQualified()),
        ).toEqual([]);
        expect(
          recoveryActions(diagnosis, isW5ReservationReleaseQualified()),
        ).toEqual([]);
        return Promise.resolve([
          { kind: 'resolve-reservation', reservationId: 'crashed' },
        ]);
      },
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect(outcome).toMatchObject({
      state: 'refused',
      reason: 'operation-excluded',
    });
    expect(calls).toEqual(['reopen']);
    const retained = await maintenance({
      source: 'offline_maintenance',
      mode: 'diagnose',
    });
    if (retained.mode !== 'diagnose') throw new Error('Expected diagnosis');
    expect(retained.diagnosis.reservations).toEqual([
      expect.objectContaining({
        reservationId: 'crashed',
        state: 'recovery-required',
      }),
    ]);
  },
);

generalPosixMaintenance.each([
  { keyed: false, decision: 'retry-commit' as const },
  { keyed: true, decision: 'retry-commit' as const },
  { keyed: false, decision: 'abandon-commit' as const },
])(
  'saved commit $decision (keyed=$keyed), with the real history gate (POSIX general maintenance; disabled on Windows)',
  async ({ keyed, decision }) => {
    const workspaceId = 'retry-target';
    const directory = join(root, workspaceId);
    const path = join(directory, 'workspace.json');
    const before = '{"version":1,"name":"Before"}';
    const after = '{"version":1,"name":"After"}';
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path, before);
    const receipt = {
      caller: 'can-5760',
      operation: 'core.workspace.update',
      idempotencyKey: 'saved',
      fingerprint: 'saved-parameters',
    };
    const daemon = createDaemonW5Host({
      canonicalDataRoot: data,
      workerEntry,
      admission: () => Promise.resolve(),
    });
    const harness = await startW5DaemonRecordHarness({ host: daemon.port });
    let commitId: number;
    try {
      await daemon.open();
      const client = await harness.connect();
      chmodSync(directory, 0o500);
      const committed = await client.instruction(
        'core.workspaceRecords.commit',
        {
          operation: 'core.workspace.update',
          ...(keyed ? { receipt } : {}),
          advance: [{ kind: 'workspace', workspaceId }],
          files: [
            {
              target: { kind: 'manifest', workspaceId },
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        },
      );
      expect(committed.status).toBe('recovery-required');
      commitId = committed.commitId;
    } finally {
      chmodSync(directory, 0o700);
      await harness.close();
      await daemon.stop();
    }
    // Independent terminal evidence must survive an otherwise successful decision.
    const journals = join(data, 'w5/destructive-lifecycles');
    mkdirSync(journals, { recursive: true });
    writeFileSync(join(journals, `${'a'.repeat(64)}.json`), '{}');
    const recorded = jest.fn(() => Promise.resolve());
    if (keyed) {
      const forbidden = await runW5RecoveryLaunch({
        waitForRelease: () => Promise.resolve(),
        maintenance,
        choose: () => Promise.resolve([{ kind: 'abandon-commit', commitId }]),
        record: () => Promise.resolve(),
        allowReservationRelease: isW5ReservationReleaseQualified(),
      });
      expect(forbidden).toMatchObject({
        state: 'refused',
        reason: 'operation-excluded',
      });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: (diagnosis) => {
        const actions = recoveryActions(
          diagnosis,
          isW5ReservationReleaseQualified(),
        );
        expect(actions).toEqual(
          keyed
            ? [{ kind: 'retry-commit', commitId }]
            : [
                { kind: 'retry-commit', commitId },
                { kind: 'abandon-commit', commitId },
              ],
        );
        return Promise.resolve([{ kind: decision, commitId }]);
      },
      record: recorded,
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect(recorded).toHaveBeenCalledWith(
      outcome,
      expect.objectContaining({
        commits: [],
        destructiveJournalArtifactCount: 1,
      }),
      expect.any(Array),
    );
    expect(outcome.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'journals' })]),
    );
    expect(readFileSync(path, 'utf8')).toBe(
      decision === 'retry-commit' ? after : before,
    );
    expect(readFileSync(join(journals, `${'a'.repeat(64)}.json`), 'utf8')).toBe(
      '{}',
    );
    await expectDaemonWriteResumes();
    {
      const resumed = createDaemonW5Host({
        canonicalDataRoot: data,
        workerEntry,
        admission: () => Promise.resolve(),
      });
      const resumedHarness = await startW5DaemonRecordHarness({
        host: resumed.port,
      });
      try {
        await resumed.open();
        const client = await resumedHarness.connect();
        // An index write alone does not qualify the manifest that was repaired.
        const current = decision === 'retry-commit' ? after : before;
        const next = current.replace(/}$/, ',"subsequent":true}');
        await expect(
          client.instruction('core.workspaceRecords.commit', {
            operation: 'core.workspace.update',
            advance: [{ kind: 'workspace', workspaceId }],
            files: [
              {
                target: { kind: 'manifest', workspaceId },
                contents: next,
                previousFingerprint: fingerprintW5File(current),
              },
            ],
            outcome: null,
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect(readFileSync(path, 'utf8')).toBe(next);
        if (keyed) {
          await expect(
            client.query('core.workspaceRecords.receipt.lookup', { receipt }),
          ).resolves.toMatchObject({
            status: 'replay',
            commitId,
            outcome: { saved: true },
          });
          // Replay the instruction, not just its lookup, after a newer write.
          await expect(
            client.instruction('core.workspaceRecords.commit', {
              operation: 'core.workspace.update',
              receipt,
              advance: [{ kind: 'workspace', workspaceId }],
              files: [
                {
                  target: { kind: 'manifest', workspaceId },
                  contents: after,
                  previousFingerprint: fingerprintW5File(before),
                },
              ],
              outcome: { saved: true },
            }),
          ).resolves.toMatchObject({
            status: 'replayed',
            commitId,
            outcome: { saved: true },
          });
          expect(readFileSync(path, 'utf8')).toBe(next);
        }
      } finally {
        await resumedHarness.close();
        await resumed.stop();
      }
    }
  },
);

test.each(['legacy', 'workspace_index', 'workspace_manifest', 'worktree_list'])(
  'exposure-on with %s ownership gates retained intent without maintenance or a window',
  async (legacyNamespace) => {
    const compiled = jest.requireActual<typeof Storage>(
      '@canopy/core-runtime/storage',
    );
    const exposed = jest.requireMock<{
      STORAGE_OWNERSHIP: readonly Storage.StorageOwnershipRow[];
    }>('@canopy/core-runtime/storage');
    const ownership = jest.replaceProperty(
      exposed,
      'STORAGE_OWNERSHIP',
      legacyNamespace === 'legacy'
        ? compiled.STORAGE_OWNERSHIP
        : exposed.STORAGE_OWNERSHIP.map((row) =>
            row.id === legacyNamespace
              ? (compiled.STORAGE_OWNERSHIP.find(
                  (actual) => actual.id === row.id,
                ) ?? row)
              : row,
          ),
    );
    const window = jest.spyOn(electron, 'BrowserWindow');
    const writer = jest.spyOn(maintenanceModule, 'runW5Maintenance');
    const shown = jest.spyOn(electron.dialog, 'showMessageBox');
    try {
      expect(isW5RecoveryEntryEnabled()).toBe(true);
      expect(isW5DaemonFlipCompiled()).toBe(false);
      expect(isW5RecoveryAvailable()).toBe(false);
      if (process.platform === 'win32') {
        // Retained-intent UI admission is deliberately unavailable on Windows;
        // migration-only reopen must not enable ordinary recovery or its writer.
        await expect(writeW5RecoveryRequest(data)).rejects.toMatchObject({
          reason: 'platform-unsupported',
        });
        expect(existsSync(w5RecoveryRequestPath(data))).toBe(false);
        const retained = JSON.stringify({ version: 1, createdAt: Date.now() });
        writeFileSync(w5RecoveryRequestPath(data), retained, { mode: 0o600 });
        expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
        expect(window).not.toHaveBeenCalled();
        expect(writer).not.toHaveBeenCalled();
        expect(shown).toHaveBeenCalledTimes(1);
        expect(readFileSync(w5RecoveryRequestPath(data), 'utf8')).toBe(
          retained,
        );
        expect(existsSync(w5RecoveryResultPath(data))).toBe(false);
        return;
      }
      // No-request startup remains a no-op even before ownership is handed over.
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(shown).not.toHaveBeenCalled();
      await writeW5RecoveryRequest(data);
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(existsSync(w5RecoveryRequestPath(data))).toBe(false);
      expect(
        JSON.parse(readFileSync(w5RecoveryResultPath(data), 'utf8')),
      ).toMatchObject({
        status: {
          state: 'refused',
          canRecover: false,
          reason: 'exposure-gated',
          entries: [],
        },
      });
      expect(window).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(shown).toHaveBeenCalledTimes(1);
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(shown).toHaveBeenCalledTimes(1);
      const now = Date.now();
      for (const bytes of [
        '',
        '{',
        JSON.stringify({ version: 2, createdAt: now }),
        JSON.stringify({ version: 1, createdAt: 0 }),
        JSON.stringify({ version: 1, createdAt: now, unexpected: true }),
        JSON.stringify({
          version: 1,
          createdAt: now - 24 * 60 * 60 * 1000 - 1000,
        }),
        JSON.stringify({ version: 1, createdAt: now + 60_000 }),
      ]) {
        writeFileSync(w5RecoveryRequestPath(data), bytes, { mode: 0o600 });
        expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
        expect(existsSync(w5RecoveryRequestPath(data))).toBe(false);
        expect(
          JSON.parse(readFileSync(w5RecoveryResultPath(data), 'utf8')),
        ).toMatchObject({
          status: { state: 'refused', reason: 'invalid-request' },
        });
      }
      expect(window).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      ownership.restore();
    }
  },
);

generalPosixMaintenance(
  'a stuck unkeyed index commit can be abandoned without overwriting foreign bytes, then daemon writes resume (POSIX general maintenance; disabled on Windows)',
  async () => {
    const daemon = createDaemonW5Host({
      canonicalDataRoot: data,
      workerEntry,
      admission: () => Promise.resolve(),
    });
    const workspaceId = 'partial-apply';
    const directory = join(root, workspaceId);
    const manifestPath = join(directory, 'workspace.json');
    const manifest = '{"version":1,"name":"Before"}';
    const before = JSON.stringify({
      version: 1,
      workspaces: [
        { id: workspaceId, name: 'Before', color: 'blue', type: 'cowork' },
      ],
    });
    const pending = before.replace(/}$/, ',"pending":true}');
    const foreign = before.replace(/}$/, ',"foreign":true}');
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(manifestPath, manifest);
    writeFileSync(join(root, 'index.json'), before);
    const harness = await startW5DaemonRecordHarness({ host: daemon.port });
    let commitId: number;
    try {
      await daemon.open();
      const client = await harness.connect();
      // Reads pass, but atomic replacement cannot create a manifest temp file.
      // The real worker applies the index first (path order), then records EACCES.
      chmodSync(directory, 0o500);
      const commit = await client.instruction('core.workspaceRecords.commit', {
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }, { kind: 'workspace', workspaceId }],
        files: [
          {
            target: { kind: 'index' },
            contents: pending,
            previousFingerprint: fingerprintW5File(before),
          },
          {
            target: { kind: 'manifest', workspaceId },
            contents: '{"version":1,"name":"After"}',
            previousFingerprint: fingerprintW5File(manifest),
          },
        ],
        outcome: null,
      });
      expect(commit.status).toBe('recovery-required');
      commitId = commit.commitId;
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(pending);
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
      await expect(
        client.instruction('core.workspaceRecords.commit', {
          operation: 'core.workspace.update',
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              target: { kind: 'index' },
              contents: before,
              previousFingerprint: fingerprintW5File(pending),
            },
          ],
          outcome: null,
        }),
      ).rejects.toMatchObject({
        payload: { code: 'core.workspaceRecords.unappliedChange' },
      });
    } finally {
      chmodSync(directory, 0o700);
      try {
        await harness.close();
      } finally {
        await daemon.stop();
      }
    }
    // A retained raw writer can change the applied index while the daemon is down.
    writeFileSync(join(root, 'index.json'), foreign);
    const retried = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: (diagnosis) => {
        expect(diagnosis.commits).toEqual([
          expect.objectContaining({ commitId, state: 'recovery-required' }),
        ]);
        const evidence: unknown = JSON.parse(
          diagnosis.commits[0]?.diagnostics ?? 'null',
        );
        expect(evidence).toMatchObject({
          written: [join(root, 'index.json')],
        });
        if (
          typeof evidence !== 'object' ||
          evidence === null ||
          !('error' in evidence) ||
          typeof evidence.error !== 'string'
        ) {
          throw new Error('Expected recovery diagnostics with a string error');
        }
        expect(evidence.error).toContain('EACCES');
        return Promise.resolve([{ kind: 'retry-commit', commitId }]);
      },
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect({ retried, maintenanceFailures }).toMatchObject({
      retried: { state: 'blocked', reason: 'recovery-required' },
      maintenanceFailures: [],
    });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(foreign);
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: () => Promise.resolve([{ kind: 'abandon-commit', commitId }]),
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect({ outcome, maintenanceFailures }).toMatchObject({
      outcome: { state: 'complete' },
      maintenanceFailures: [],
    });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(foreign);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
    await expectDaemonWriteResumes();
  },
);

// Ordinary Windows diagnose/resolve/restore remains unavailable. Only the
// transaction-qualified reopen path is exercised by CAN-5942's migration golden.
(process.platform === 'win32' ? test : test.skip).each([
  { source: 'offline_maintenance', mode: 'diagnose' },
  { source: 'offline_maintenance', mode: 'reopen' },
  { source: 'offline_maintenance', mode: 'restore', backupPath: 'not-used' },
  {
    source: 'offline_maintenance',
    mode: 'resolve',
    decisions: [{ kind: 'retry-commit', commitId: 1 }],
  },
] as const)(
  'Windows ordinary $mode maintenance still refuses before worker admission',
  async (request) => {
    const context = createW5RecoveryMaintenanceContext(data, { workerEntry });
    await expect(runW5Maintenance(context, request)).rejects.toMatchObject({
      reason: 'platform-unsupported',
    });
    expect(context.host.workersStarted).toBe(0);
  },
);

(process.platform === 'win32' ? test : test.skip)(
  'offline qualification cannot enable Windows resolve or a writer without the native observer',
  async () => {
    const admission = jest.fn(() => Promise.resolve());
    const context = createW5RecoveryMaintenanceContext(data, {
      workerEntry,
      offlineMigration: admission,
    });
    await expect(
      runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'resolve',
        decisions: [{ kind: 'retry-commit', commitId: 1 }],
      }),
    ).rejects.toMatchObject({ reason: 'platform-unsupported' });
    expect(admission).not.toHaveBeenCalled();
    await expect(
      runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'reopen',
      }),
    ).rejects.toMatchObject({ reason: 'identity-unprovable' });
    expect(context.host.workersStarted).toBe(0);
  },
);

// Contract-level exclusion with a synthetic qualification, not a native cold
// success receipt. The migration golden alone composes whole-user observation.
test('offline exclusion blocks same-process W5 registration and releases its record', async () => {
  const context = createW5RecoveryMaintenanceContext(data, {
    windowsProcessPath: resolve(
      '.cache/bin/win32-x64/canopy-process-identity.exe',
    ),
  });
  const self = await context.platform.supervision.inspectProcess({
    pid: process.pid,
  });
  if (self.state !== 'running')
    throw new Error('Native self identity required');
  const qualification = jest.fn(() => Promise.resolve());
  const exclusion = await acquireW5MaintenanceExclusion({
    dataRoot: data,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspect: (pid, signal) =>
      context.platform.supervision.inspectProcess({ pid, signal }),
    secureFiles: context.platform.secureFiles,
    offlineMigration: qualification,
  });
  try {
    expect(await exclusion.isHeld()).toBe(true);
    expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(true);
    await expect(
      registerW5Host({ dataRoot: data, hostKind: 'cli' }),
    ).rejects.toMatchObject({ reason: 'maintenance-process' });
    if (process.platform === 'win32')
      await expect(ensureW5HostMembership()).rejects.toMatchObject({
        reason: 'maintenance-process',
      });
    expect(qualification).toHaveBeenCalledTimes(2);
  } finally {
    await exclusion.release();
  }
  expect(await exclusion.isHeld()).toBe(false);
  expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
  await exclusion.release();
});

test('lost offline qualification releases the startup claim before worker admission', async () => {
  const qualification = jest
    .fn(() => Promise.resolve())
    .mockImplementationOnce(() => Promise.resolve())
    .mockImplementation(() =>
      Promise.reject(new Error('qualification revoked')),
    );
  const context = createW5RecoveryMaintenanceContext(data, {
    workerEntry,
    windowsProcessPath: resolve(
      '.cache/bin/win32-x64/canopy-process-identity.exe',
    ),
    offlineMigration: qualification,
  });
  await expect(
    runW5Maintenance(context, {
      source: 'offline_maintenance',
      mode: 'reopen',
    }),
  ).rejects.toThrow('qualification revoked');
  expect(qualification).toHaveBeenCalledTimes(2);
  expect(context.host.workersStarted).toBe(0);
  expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(false);
  expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
});

// Qualifies native W5 custody/recovery/release even when ambient cold inspection
// refuses. Only the cold callback is synthetic; this is not composed evidence.
test.each(['settled', 'commit', 'reservation'] as const)(
  'offline migration W5 %s runs the writer and releases both records',
  async (state) => {
    mkdirSync(join(data, 'w5'), { mode: 0o700 });
    const path = join(root, 'index.json');
    const before = readFileSync(path, 'utf8');
    const after = '{"version":1,"workspaces":[],"saved":true}';
    const conflict = '{"version":1,"workspaces":[],"operatorEdit":true}';
    const log = W5CommitLog.open(join(data, 'w5/commit-log.sqlite'));
    try {
      log.commit({
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }],
        files: [
          {
            path,
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
          diagnostics: {},
        });
    } finally {
      log.close();
    }
    if (state === 'commit') writeFileSync(path, conflict);
    const firstWorker = startedWorkers.length;
    const qualification = {
      identity: { ...internalRootIdentity(temporary, canopy), source: data },
      transactionId: 'synthetic-w5-contract',
      assertHeld: (): Promise<void> => Promise.resolve(),
      assertCold: (): Promise<void> => Promise.resolve(),
    };
    const recovery = settleInternalRootW5(data, workerEntry, qualification, {
      windowsProcessPath: resolve(
        '.cache/bin/win32-x64/canopy-process-identity.exe',
      ),
      ...(process.platform === 'win32'
        ? {
            ownedChildPath: resolve(
              `.cache/native-owned-child/win32-${process.arch}/core-owned-child.node`,
            ),
          }
        : {}),
    });
    if (state === 'settled') await expect(recovery).resolves.toBe('settled');
    else
      await expect(recovery).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    const workers = startedWorkers.slice(firstWorker);
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((worker) => worker.exitCode !== undefined)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      state === 'commit' ? conflict : after,
    );
    expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(false);
    expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
  },
);
