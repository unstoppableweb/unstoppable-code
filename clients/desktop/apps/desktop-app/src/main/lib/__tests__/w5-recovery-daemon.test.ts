import { createW5RecordAuthority } from '@canopy/core-runtime/node/w5/record-port/authority';
import type {
  CanopyCallerDescriptor,
  CoreWorkspaceRecordsReceipt,
  CoreWorkspaceRecordsReceiptLookup,
} from '@canopy/protocol/canopy-core';
import { W5CommitLog } from '@canopy/core-runtime/node/w5/commit-log';
import { acquireW5RootPresence } from '@canopy/core-platform/w5-root-presence';
import { w5DaemonReceiptCaller } from '@canopy/core-runtime/node/w5/workspace-metadata/receipt-caller';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  connectCanopyClient,
  executeW5Recovery,
  type CanopyOwnedDaemonChildren,
} from '@canopy/core-client/node';
import { failureOutcome } from '../../../../../core-daemon/src/process-control';
import { W5MaintenanceRefusedError } from '@canopy/core-runtime/node/w5/maintenance-types';
import { runDaemonW5Recovery } from '../../../../../core-daemon/src/w5-recovery';
// A real Worker owns the commit log behind the daemon authority and framed port.
// Synthetic ownership rows also exercise legacy and partial-flip refusals.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  leaveW5HostCohortSync,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { internalRootFilesystemHost } from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import type * as Storage from '@canopy/core-runtime/storage';
import * as electron from 'electron';
import * as maintenanceModule from '../w5-maintenance';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import {
  CanopyRuntimeDescriptorSchema,
  CORE_W5_RECOVERY_INSTRUCTIONS,
} from '@canopy/protocol/canopy-core';
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
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import {
  readW5ServiceHistory,
  type W5ServiceHistory,
} from '@canopy/core-runtime/node/w5/service-history';
import { captureW5Backup, requireVerifiedW5Backup } from '../w5-backup';
import {
  createReadOnlyW5BackupContext,
  readOnlyW5BackupPosition,
} from '@canopy/core-runtime/node/w5/readonly-backup-position';
import { createW5RecoveryMaintenanceContext } from '../w5-recovery-maintenance';
import { runW5Maintenance } from '../w5-maintenance';
import {
  recoveryActions,
  runW5RecoveryLaunch,
  w5RecoveryFailureReason,
} from '../w5-recovery-launch';
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
const workerEntry = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts');
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

generalPosixMaintenance.each(['claim-held', 'runtime-unavailable'] as const)(
  'pre-bind %s from the recovery child reaches desktop diagnostics without recovery work',
  async (reason) => {
    const platform = createW5RecoveryMaintenanceContext(data).platform;
    const self = await platform.supervision.inspectProcess({
      pid: process.pid,
    });
    if (self.state !== 'running') throw new Error('Test identity unavailable');
    const claims = createCanopyStartupClaimPort({
      dataRoot: data,
      owner: { pid: process.pid, startIdentity: self.startIdentity },
      inspectProcess: () =>
        Promise.resolve({ kind: 'alive', startIdentity: self.startIdentity }),
    });
    const held =
      reason === 'claim-held' ? await claims.tryAcquire() : undefined;
    if (held && held.kind !== 'acquired')
      throw new Error('Test claim unavailable');
    if (reason === 'runtime-unavailable')
      chmodSync(join(data, 'runtime'), 0o755);
    const runtimeBefore = readdirSync(join(data, 'runtime')).sort();
    const indexBefore = readFileSync(join(root, 'index.json'), 'utf8');
    let exitCode: number | null = null;
    const children: CanopyOwnedDaemonChildren = {
      spawn: (request) => {
        const nonce = request.args.at(-1);
        if (!nonce) throw new Error('Missing recovery nonce');
        const child = spawn(
          process.execPath,
          [
            '--require',
            'tsx/cjs',
            join(__dirname, 'fixtures/w5-recovery-refusal-child.ts'),
            data,
            nonce,
          ],
          { stdio: ['pipe', 'ignore', 'ignore'] },
        );
        const exited = new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => {
            exitCode = code;
            resolve({ code, signal });
          });
        });
        child.stdin.end(request.stdin);
        return Promise.resolve({
          pid: child.pid ?? 0,
          exited,
          commit: () => undefined,
          terminate: async () => {
            if (child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL');
            await exited;
          },
        });
      },
    };
    try {
      const failure = await executeW5Recovery({
        dataRoot: data,
        runtimeMode: 'dev',
        executable: process.execPath,
        environment: {},
        children,
        endpointFor: (name) => join(data, 'runtime', `${name}.sock`),
        request: { source: 'offline_maintenance', mode: 'diagnose' },
      }).catch((error: unknown) => error);
      expect(exitCode).toBe(reason === 'claim-held' ? 84 : 82);
      expect(failure).toMatchObject({
        reason,
        payload: { kind: 'unavailable' },
      });
      expect(w5RecoveryFailureReason(failure)).toBe(reason);
      expect(existsSync(join(data, 'w5'))).toBe(false);
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(indexBefore);
      expect(readdirSync(join(data, 'runtime')).sort()).toEqual(runtimeBefore);
      if (held?.kind === 'acquired') {
        const identity = await claims.identity(held.handle);
        if (!identity) throw new Error('Test claim identity unavailable');
        expect(await claims.verify(identity)).toBe(true);
      }
    } finally {
      if (held?.kind === 'acquired') await claims.release(held.handle);
      chmodSync(join(data, 'runtime'), 0o700);
    }
  },
);

test.each([
  [80, 'platform-unsupported', null],
  [81, 'invalid-request', null],
  [82, 'runtime-unavailable', null],
  [83, 'identity-unprovable', null],
  [84, 'claim-held', null],
  [85, 'claim-ambiguous', null],
  [86, 'endpoint-unavailable', null],
  [87, 'claim-lost', null],
  [88, 'release-uncertain', null],
  [89, 'writer-exit-unconfirmed', null],
  [0, undefined, null],
  [1, undefined, null],
  [64, undefined, null],
  [70, undefined, null],
  [79, undefined, null],
  [90, undefined, null],
  [null, undefined, null],
  [84, undefined, 'SIGTERM'],
  [null, undefined, 'SIGKILL'],
] as const)(
  'recovery startup status %s retains only its reserved reason',
  async (code, reason, signal) => {
    if (reason) {
      expect(failureOutcome(new W5MaintenanceRefusedError(reason))).toEqual({
        code,
        message: 'Daemon failed.',
      });
    }
    const terminate = jest.fn(() => Promise.resolve());
    const failure = await executeW5Recovery({
      dataRoot: data,
      runtimeMode: 'dev',
      executable: process.execPath,
      environment: {},
      children: {
        spawn: () =>
          Promise.resolve({
            pid: process.pid,
            exited: Promise.resolve({ code, signal }),
            commit: () => undefined,
            terminate,
          }),
      },
      endpointFor: () => join(data, 'runtime/never-bound.sock'),
      request: { source: 'offline_maintenance', mode: 'diagnose' },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ payload: { kind: 'unavailable' } });
    if (reason) expect(failure).toMatchObject({ reason });
    else expect(failure).not.toHaveProperty('reason');
    expect(w5RecoveryFailureReason(failure)).toBe(reason ?? 'unexpected');
    expect(terminate).toHaveBeenCalledTimes(1);
  },
);

test('caller cancellation overrides a concurrent recovery startup refusal', async () => {
  const controller = new AbortController();
  const terminate = jest.fn(() => Promise.resolve());
  const failure = await executeW5Recovery({
    dataRoot: data,
    runtimeMode: 'dev',
    executable: process.execPath,
    environment: {},
    children: {
      spawn: () => {
        controller.abort();
        return Promise.resolve({
          pid: process.pid,
          exited: Promise.resolve({ code: 84, signal: null }),
          commit: () => undefined,
          terminate,
        });
      },
    },
    endpointFor: () => join(data, 'runtime/never-bound.sock'),
    request: { source: 'offline_maintenance', mode: 'diagnose' },
    signal: controller.signal,
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ payload: { kind: 'cancelled' } });
  expect(w5RecoveryFailureReason(failure)).toBe('cancelled');
  expect(terminate).toHaveBeenCalledTimes(1);
});

test('unconfirmed recovery-child cleanup overrides a startup refusal', async () => {
  const failure = await executeW5Recovery({
    dataRoot: data,
    runtimeMode: 'dev',
    executable: process.execPath,
    environment: {},
    children: {
      spawn: () =>
        Promise.resolve({
          pid: process.pid,
          exited: Promise.resolve({ code: 84, signal: null }),
          commit: () => undefined,
          terminate: () => Promise.reject(new Error('Test cleanup failure')),
        }),
    },
    endpointFor: () => join(data, 'runtime/never-bound.sock'),
    request: { source: 'offline_maintenance', mode: 'diagnose' },
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    reason: 'writer-exit-unconfirmed',
    cause: { reason: 'claim-held' },
  });
  expect(w5RecoveryFailureReason(failure)).toBe('writer-exit-unconfirmed');
  expect(
    failureOutcome(new W5MaintenanceRefusedError('writer-active')).code,
  ).toBe(1);
});

test('release-skip capture without a log verifies its own backup but cannot waive historical backups', async () => {
  const context = createReadOnlyW5BackupContext(data);
  const backup = await captureW5Backup(context);
  await expect(
    requireVerifiedW5Backup(context, backup, 0),
  ).resolves.toMatchObject({ position: { commitId: 0 } });
  await expect(readOnlyW5BackupPosition(data)).rejects.toThrow(
    'W5 history exists without its log.',
  );
});

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

generalPosixMaintenance.each([
  'desktop-host:new_single_repo',
  'desktop-host:worktree-selection',
  'daemon:local-user:desktop_canopy_client',
])(
  'persisted receipt %s survives the in-process → daemon host change',
  async (caller) => {
    const receipt = {
      caller,
      operation: 'core.workspace.update',
      idempotencyKey: 'before-host-change',
      fingerprint: 'original-parameters',
    };
    const before = readFileSync(join(root, 'index.json'), 'utf8');
    const after = '{"version":1,"workspaces":[],"saved":true}';
    const legacy = new W5CommitLogHost({
      dataRoot: data,
      root,
      dbPath: join(data, 'w5/commit-log.sqlite'),
      workerEntry,
    });
    let commitId: number;
    try {
      const committed = await legacy.commit({
        operation: receipt.operation,
        receipt,
        advance: [{ kind: 'workspaces' }],
        files: [
          {
            path: join(root, 'index.json'),
            contents: after,
            previousFingerprint: fingerprintW5File(before),
          },
        ],
        outcome: { saved: true, originalPath: root },
      });
      commitId = committed.commitId;
    } finally {
      await legacy.shutdown();
    }
    let history: W5ServiceHistory | undefined;
    for (const instance of ['first-daemon', 'restarted-daemon']) {
      const daemon = createDaemonW5Host({
        canonicalDataRoot: data,
        workerEntry,
        admission: async () => {},
      });
      const harness = await startW5DaemonRecordHarness({ host: daemon.port });
      try {
        await daemon.open();
        const currentHistory = await readW5ServiceHistory(data);
        expect(currentHistory).toMatchObject({
          version: 1,
          priorHistory: 'unknown',
        });
        if (history) expect(currentHistory).toEqual(history);
        history = currentHistory;
        const client = await harness.connect(instance);
        await expect(
          client.query('core.workspaceRecords.receipt.lookup', { receipt }),
        ).resolves.toMatchObject({
          status: 'replay',
          commitId,
          outcome: { saved: true, originalPath: root },
        });
        await expect(
          client.instruction('core.workspaceRecords.commit', {
            operation: receipt.operation,
            receipt,
            advance: [{ kind: 'workspaces' }],
            files: [
              {
                target: { kind: 'index' },
                contents: before,
                previousFingerprint: fingerprintW5File(before),
              },
            ],
            outcome: { saved: false },
          }),
        ).resolves.toMatchObject({
          status: 'replayed',
          commitId,
          outcome: { saved: true, originalPath: root },
        });
        await expect(
          client.query('core.workspaceRecords.receipt.lookup', {
            receipt: { ...receipt, fingerprint: 'changed-non-path-parameter' },
          }),
        ).resolves.toMatchObject({ status: 'key-reused' });
        expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(after);
      } finally {
        await harness.close();
        await daemon.stop();
      }
    }
  },
);

generalPosixMaintenance(
  'core.workspaceRecovery.execute cold restore uses core authority under daemon ownership and refuses an older backup after new writes',
  async () => {
    const host = new W5CommitLogHost({
      dataRoot: data,
      root,
      dbPath: join(data, 'w5/commit-log.sqlite'),
      workerEntry,
    });
    let backupPath: string;
    try {
      backupPath = await captureW5Backup({ host, dataRoot: data });
    } finally {
      await host.shutdown();
    }
    const restored = await maintenance({
      source: 'offline_maintenance',
      mode: 'restore',
      backupPath,
    });
    expect(restored).toMatchObject({
      mode: 'restore',
    });
    expect(restored).toHaveProperty('commitId', expect.any(Number));
    await expectDaemonWriteResumes();
    await expect(
      maintenance({
        source: 'offline_maintenance',
        mode: 'restore',
        backupPath,
      }),
    ).rejects.toMatchObject({ reason: 'newer-writes' });
  },
);

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
    const legacyRows = compiled.STORAGE_OWNERSHIP.map((row) =>
      ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
        row.id,
      )
        ? { ...row, transitionOwner: 'legacy' as const }
        : row,
    );
    const ownership = jest.replaceProperty(
      exposed,
      'STORAGE_OWNERSHIP',
      legacyNamespace === 'legacy'
        ? legacyRows
        : exposed.STORAGE_OWNERSHIP.map((row) =>
            row.id === legacyNamespace
              ? (legacyRows.find((actual) => actual.id === row.id) ?? row)
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
test.each([
  'settled',
  'commit',
  'reservation',
  ...(process.platform === 'win32' ? [] : ['orphan']),
])(
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
    const descriptor = state === 'orphan' ? await orphanEndpoint() : undefined;
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
    if (state === 'settled' || state === 'orphan')
      await expect(recovery).resolves.toBe('settled');
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
    if (descriptor) {
      expect(existsSync(join(data, 'runtime/core.sock'))).toBe(false);
      expect(readFileSync(join(data, 'runtime/core.json'))).toEqual(descriptor);
    }
    expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(false);
    expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
  },
);

// Core host-transfer flow: retained outcomes and uncertain reservations never become new work.
const families = [
  'desktop-host:worktree-selection',
  'desktop-host:pipeline-host',
  'desktop-host:new_single_repo',
  w5DaemonReceiptCaller('local-user', 'worktree-create'),
  w5DaemonReceiptCaller('cli-user', 'worktree-create'),
  w5DaemonReceiptCaller('cli-user', 'workspace-create'),
  w5DaemonReceiptCaller('cli-user', 'workspace-import'),
];
generalPosixMaintenance.each(families)(
  'same-root %s preserves pending, expired, recovery and reservation results across hosts',
  async (caller) => {
    let now = Date.now() - 100_000;
    mkdirSync(join(data, 'w5'), { recursive: true, mode: 0o700 });
    const db = W5CommitLog.open(join(data, 'w5/commit-log.sqlite'), {
      clock: () => now,
      retryWindowMs: 10,
    });
    const receipt = (id: string): CoreWorkspaceRecordsReceipt => ({
      caller,
      operation: 'core.worktree.create',
      idempotencyKey: id,
      fingerprint: 'parameters',
    });
    const expired = db.commit({
      operation: 'test.expired',
      receipt: receipt('expired'),
      advance: [],
      files: [],
      outcome: { old: true },
    });
    if (expired.status !== 'committed') throw new Error('not committed');
    db.markApplied(expired.commitId);
    now += 100;
    db.compact();
    const path = join(data, 'workspaces/index.json');
    writeFileSync(path, 'before');
    db.commit({
      operation: 'test.pending',
      receipt: receipt('pending'),
      advance: [],
      files: [
        {
          path,
          contents: 'after',
          previousFingerprint: fingerprintW5File('before'),
        },
      ],
      outcome: { pending: true },
    });
    const stuck = db.commit({
      operation: 'test.stuck',
      receipt: receipt('stuck'),
      advance: [],
      files: [],
      outcome: { saved: false },
    });
    if (stuck.status !== 'committed') throw new Error('not committed');
    db.markCommitRecoveryRequired(stuck.commitId, { reason: 'uncertain' });
    db.reserve({
      reservationId: 'reservation',
      diagnostics: null,
      operation: 'core.worktree.create',
      receipt: receipt('reservation'),
    });
    expect(
      db.lookupReceipt(receipt('reservation'), 'parameters'),
    ).toMatchObject({ status: 'in-progress' });
    db.close();
    for (const instance of [1, 2]) {
      const daemon = createDaemonW5Host({
        canonicalDataRoot: data,
        workerEntry,
        admission: async () => {},
      });
      try {
        await daemon.open();
        const authority = createW5RecordAuthority({ host: daemon.port });
        const cliPrefix = 'daemon:cli-user:';
        const cli = caller.startsWith(cliPrefix);
        const peer: CanopyCallerDescriptor = {
          principalId: cli ? 'cli-user' : 'local-user',
          clientInstanceId: `host-${instance}`,
          authorityId: 'local',
          interfaceKind: cli ? 'cli' : 'desktop',
          grants: [],
        };
        // CLI sends its source; Electron sends the original trusted caller.
        const lookup = (
          id: string,
        ): Promise<CoreWorkspaceRecordsReceiptLookup> =>
          authority.lookupReceipt(
            {
              ...receipt(id),
              caller: cli ? caller.slice(cliPrefix.length) : caller,
            },
            peer,
          );
        await expect(lookup('expired')).resolves.toMatchObject({
          status: 'replay-expired',
        });
        await expect(lookup('pending')).resolves.toMatchObject({
          status: 'replay',
          outcome: { pending: true },
        });
        await expect(lookup('stuck')).resolves.toMatchObject({
          status: 'commit-recovery-required',
        });
        await expect(lookup('reservation')).resolves.toMatchObject({
          status: 'recovery-required',
          reservationId: 'reservation',
        });
        await expect(
          daemon.port.lookupReceipt(receipt('expired')),
        ).resolves.toMatchObject({ status: 'replay-expired' });
        await expect(
          daemon.port.lookupReceipt(receipt('pending')),
        ).resolves.toMatchObject({
          status: 'replay',
          outcome: { pending: true },
        });
        await expect(
          daemon.port.lookupReceipt(receipt('stuck')),
        ).resolves.toMatchObject({ status: 'commit-recovery-required' });
        await expect(
          daemon.port.lookupReceipt(receipt('reservation')),
        ).resolves.toMatchObject({
          status: 'recovery-required',
          reservationId: 'reservation',
        });
        await expect(
          daemon.port.lookupReceipt({
            ...receipt('pending'),
            fingerprint: 'changed',
          }),
        ).resolves.toMatchObject({ status: 'key-reused' });
        await expect(
          daemon.port.lookupReceipt({
            ...receipt('missing'),
            caller: caller + '-other',
          }),
        ).resolves.toMatchObject({ status: 'none' });
      } finally {
        await daemon.stop();
      }
    }
  },
);

async function endpointOwner(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(process.argv[1], () => process.stdout.write('ready'));`,
      join(data, 'runtime/core.sock'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('Socket owner exited before binding')),
      );
      child.stdout?.once('data', () => resolve());
    });
    return child;
  } catch (error) {
    await killEndpointOwner(child);
    throw error;
  }
}
async function killEndpointOwner(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGKILL');
  await exited;
}
async function publishEndpointOwner(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (!child.pid) throw new Error('Missing owner PID');
  const context = createW5RecoveryMaintenanceContext(data);
  const owner = await context.platform.supervision.inspectProcess({
    pid: child.pid,
  });
  if (owner.state !== 'running')
    throw new Error('Native owner identity required');
  const socket = lstatSync(join(data, 'runtime/core.sock'), { bigint: true });
  writeFileSync(
    join(data, 'runtime/core.json'),
    JSON.stringify({
      version: 1,
      pid: child.pid,
      startIdentity: owner.startIdentity,
      endpoint: { kind: 'socket', path: join(data, 'runtime/core.sock') },
      socketIdentity: { device: String(socket.dev), inode: String(socket.ino) },
      tokenRef: join(data, 'runtime/core-test.token'),
      protocolRange: { min: 1, max: 1 },
      buildVersion: 'test',
    }),
    { mode: 0o600 },
  );
}
async function retainEndpointBind(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (!child.pid) throw new Error('Missing owner PID');
  const { supervision } = createW5RecoveryMaintenanceContext(data).platform;
  const owner = await supervision.inspectProcess({ pid: child.pid });
  if (owner.state !== 'running')
    throw new Error('Native owner identity required');
  const departed = createCanopyStartupClaimPort({
    dataRoot: data,
    owner: { pid: child.pid, startIdentity: owner.startIdentity },
    inspectProcess: async (pid, signal) => {
      const found = await supervision.inspectProcess({ pid, signal });
      return found.state === 'running'
        ? { kind: 'alive', startIdentity: found.startIdentity }
        : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  const acquired = await departed.tryAcquire();
  if (acquired.kind !== 'acquired') throw new Error('Claim required');
  expect(await departed.markEndpointBind(acquired.handle)).toBe(true);
}
async function orphanEndpoint(retainBind = false): Promise<Buffer> {
  const child = await endpointOwner();
  try {
    await publishEndpointOwner(child);
    if (retainBind) await retainEndpointBind(child);
    return readFileSync(join(data, 'runtime/core.json'));
  } finally {
    await killEndpointOwner(child);
  }
}
function initializeW5Log(): void {
  mkdirSync(join(data, 'w5'), { mode: 0o700 });
  W5CommitLog.open(join(data, 'w5/commit-log.sqlite')).close();
}

async function coreMaintenance(
  context: Parameters<typeof runW5Maintenance>[0],
  request: Parameters<typeof runW5Maintenance>[1],
  signal?: AbortSignal,
): ReturnType<typeof runW5Maintenance> {
  const { runW5Maintenance: runCoreMaintenance } =
    await import('@canopy/core-runtime/node/w5/maintenance');
  const { flushDirectory } =
    await import('@canopy/core-platform/directory-flush');
  const { acquireW5MaintenanceExclusion: acquireExclusion } =
    await import('@canopy/core-platform/w5-maintenance-exclusion');
  const self = await context.platform.supervision.inspectProcess({
    pid: process.pid,
  });
  if (self.state !== 'running') throw new Error('Native identity required');
  const claims = createCanopyStartupClaimPort({
    dataRoot: data,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspectProcess: async (pid, inspectionSignal) => {
      const found = await context.platform.supervision.inspectProcess({
        pid,
        signal: inspectionSignal,
      });
      return found.state === 'running'
        ? { kind: 'alive', startIdentity: found.startIdentity }
        : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  const acquired = await claims.tryAcquire(undefined, {
    recoverDeparted: true,
  });
  if (acquired.kind !== 'acquired') throw new Error('Claim required');
  const { handle, recovered } = acquired;
  async function releaseClaim(operationError?: unknown): Promise<void> {
    const endpoints = context.platform.endpoints;
    const preserveEndpointBind =
      recovered?.endpointBound === true &&
      endpoints.semantics === 'filesystem-socket' &&
      (
        await endpoints.probe(
          endpoints.address({ dataRoot: data, endpointName: 'core' }),
        )
      ).state !== 'absent';
    if ((await claims.release(handle, { preserveEndpointBind })) !== 'released')
      throw new W5MaintenanceRefusedError('release-uncertain', operationError);
  }
  let result: Awaited<ReturnType<typeof runCoreMaintenance>>;
  try {
    result = await runCoreMaintenance(
      context,
      request,
      {
        os:
          process.platform === 'win32'
            ? 'win32'
            : process.platform === 'darwin'
              ? 'darwin'
              : 'linux',
        claim: { port: claims, handle },
        backup: {
          syncDirectory: async (path): Promise<void> => {
            await flushDirectory(path);
          },
          admit: (_targets, run) => run(),
        },
        acquirePresence: (dataRoot) =>
          acquireW5RootPresence(dataRoot, 'maintenance'),
        acquireExclusion,
      },
      signal,
    );
  } catch (error) {
    await releaseClaim(error);
    throw error;
  }
  await releaseClaim();
  return result;
}

generalPosixMaintenance.each(['diagnose', 'reopen'] as const)(
  'an unpublished inherited bind marker is retained by %s until the socket is unlinked',
  async (mode) => {
    const child = await endpointOwner();
    try {
      const context = createW5RecoveryMaintenanceContext(data, { workerEntry });
      await retainEndpointBind(child);
      await killEndpointOwner(child);
      initializeW5Log();
      const result = runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode,
      });
      if (mode === 'diagnose') {
        await expect(result).rejects.toMatchObject({
          reason: 'release-uncertain',
        });
        expect(
          JSON.parse(
            readFileSync(join(data, 'runtime/startup-claim.json'), 'utf8'),
          ),
        ).toMatchObject({ endpointBound: true, owner: { pid: process.pid } });
        expect(context.host.workersStarted).toBe(0);
      } else {
        await expect(result).resolves.toMatchObject({ mode });
        expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(
          false,
        );
        await expectDaemonWriteResumes();
      }
      expect(existsSync(join(data, 'runtime/core.sock'))).toBe(
        mode === 'diagnose',
      );
      expect(existsSync(join(data, 'runtime/core.json'))).toBe(false);
      expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
    } finally {
      await killEndpointOwner(child);
    }
  },
);

generalPosixMaintenance(
  'core recovery with no published endpoint still reopens',
  async () => {
    initializeW5Log();
    await expect(
      coreMaintenance(
        createW5RecoveryMaintenanceContext(data, { workerEntry }),
        {
          source: 'offline_maintenance',
          mode: 'reopen',
        },
      ),
    ).resolves.toMatchObject({ mode: 'reopen' });
    expect(existsSync(join(data, 'runtime/core.sock'))).toBe(false);
    expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(false);
    await expectDaemonWriteResumes();
  },
);

generalPosixMaintenance.each([
  'diagnose',
  'reopen',
  'claim-lost-at-unlink',
] as const)(
  'daemon recovery %s retains bind evidence until core endpoint absence',
  async (scenario) => {
    const mode = scenario === 'claim-lost-at-unlink' ? 'reopen' : scenario;
    const descriptor = await orphanEndpoint(true);
    initializeW5Log();
    const { endpoints } = createW5RecoveryMaintenanceContext(data).platform;
    const os = hostPlatformOperatingSystem();
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('POSIX required');
    const nonce = 'b'.repeat(24);
    const address = endpoints.address({
      dataRoot: data,
      endpointName: `w5-recovery-${nonce}`,
    });
    let notifyReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    let closeRecovery: (() => Promise<void>) | undefined;
    const auth = {
      secret: 'a'.repeat(64),
      dataRootHash: createHash('sha256').update(data).digest('hex'),
    };
    const recovery = runDaemonW5Recovery({
      dataRoot: data,
      nonce,
      auth,
      os,
      platformFor: (validateStartupClaim) => {
        const recoveryEndpoints = createPlatformEndpointServices(os, {
          validateStartupClaim,
        });
        if (recoveryEndpoints.semantics !== 'filesystem-socket')
          throw new Error('POSIX required');
        return hostPlatformServices({
          ...recoveryEndpoints,
          unlinkStale: async (request) => {
            if (scenario === 'claim-lost-at-unlink')
              unlinkSync(join(data, 'runtime/startup-claim.json'));
            return recoveryEndpoints.unlinkStale(request);
          },
          bind: async (
            target: Parameters<typeof endpoints.bind>[0],
          ): ReturnType<typeof endpoints.bind> => {
            const bound = await recoveryEndpoints.bind(target);
            if (bound.kind === 'bound' && target.path === address.path) {
              closeRecovery = (): Promise<void> => bound.listener.close();
              notifyReady?.();
            }
            return bound;
          },
        });
      },
      buildVersion: 'test',
      workerEntry,
    });
    // Observe cleanup rejection before awaiting the authenticated operation.
    const settled = recovery.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        ready,
        settled.then(({ error }) => {
          throw error instanceof Error
            ? error
            : new Error(
                error == null
                  ? 'Recovery ended before binding'
                  : typeof error === 'string'
                    ? error
                    : (JSON.stringify(error) ?? 'Recovery failed'),
              );
        }),
      ]);
      const client = await connectCanopyClient({
        endpoint: { kind: 'socket', path: address.path, auth },
        definitions: {
          queries: {},
          instructions: CORE_W5_RECOVERY_INSTRUCTIONS,
          streams: {},
        },
        clientName: 'w5-recovery-launcher',
        clientVersion: '1',
        timeoutMs: 5000,
      });
      try {
        await expect(
          client.instruction('core.workspaceRecovery.execute', {
            source: 'offline_maintenance',
            mode,
          }),
        ).resolves.toMatchObject(
          scenario === 'claim-lost-at-unlink'
            ? { state: 'refused', reason: 'endpoint-unavailable' }
            : { state: 'complete', result: { mode } },
        );
      } finally {
        await client.close();
      }
      const outcome = await settled;
      if (scenario !== 'reopen')
        expect(outcome.error).toMatchObject({ reason: 'release-uncertain' });
      else expect(outcome.error).toBeUndefined();
      expect(existsSync(join(data, 'runtime/core.sock'))).toBe(
        scenario !== 'reopen',
      );
      expect(readFileSync(join(data, 'runtime/core.json'))).toEqual(descriptor);
      expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(
        scenario === 'diagnose',
      );
      expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(false);
      if (scenario !== 'reopen') return;
      const platform = hostPlatformServices(endpoints);
      const self = await platform.supervision.inspectProcess({
        pid: process.pid,
      });
      if (self.state !== 'running') throw new Error('Native identity required');
      const claims = createCanopyStartupClaimPort({
        dataRoot: data,
        owner: { pid: process.pid, startIdentity: self.startIdentity },
        inspectProcess: async (pid, signal) => {
          const found = await platform.supervision.inspectProcess({
            pid,
            signal,
          });
          return found.state === 'running'
            ? { kind: 'alive', startIdentity: found.startIdentity }
            : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
        },
      });
      const next = await claims.tryAcquire();
      expect(next.kind).toBe('acquired');
      if (next.kind !== 'acquired')
        throw new Error('Next startup claim required');
      expect(await claims.release(next.handle)).toBe('released');
      await expectDaemonWriteResumes();
    } finally {
      await closeRecovery?.();
      await settled;
    }
  },
);

describe.each(['offline', 'core'] as const)(
  '%s recovery endpoint admission',
  (host) => {
    const runEndpointMaintenance =
      host === 'core' ? coreMaintenance : runW5Maintenance;
    generalPosixMaintenance.each(['diagnose', 'reopen'] as const)(
      'a killed daemon endpoint permits %s; only a mutating run unlinks the socket',
      async (mode) => {
        const descriptor = await orphanEndpoint();
        if (mode === 'reopen') initializeW5Log();
        await expect(
          runEndpointMaintenance(
            createW5RecoveryMaintenanceContext(data, { workerEntry }),
            { source: 'offline_maintenance', mode },
          ),
        ).resolves.toMatchObject({ mode });
        expect(existsSync(join(data, 'runtime/core.sock'))).toBe(
          mode === 'diagnose',
        );
        expect(readFileSync(join(data, 'runtime/core.json'))).toEqual(
          descriptor,
        );
        expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(
          false,
        );
        expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(
          false,
        );
        if (mode === 'reopen') await expectDaemonWriteResumes();
      },
    );

    generalPosixMaintenance.each([
      'listener',
      'ambiguous',
      'refused-live-owner',
      'unverifiable',
      'foreign-endpoint',
      'foreign-inode',
      'foreign-device',
      'missing',
      'malformed',
    ])('%s cannot authorize offline socket cleanup', async (scenario) => {
      const child = await endpointOwner();
      try {
        await publishEndpointOwner(child);
        if (scenario !== 'listener' && scenario !== 'refused-live-owner')
          await killEndpointOwner(child);
        const context = createW5RecoveryMaintenanceContext(data, {
          workerEntry,
        });
        const endpoints = context.platform.endpoints;
        if (endpoints.semantics !== 'filesystem-socket')
          throw new Error('POSIX required');
        const socket = lstatSync(join(data, 'runtime/core.sock'), {
          bigint: true,
        });
        const descriptorPath = join(data, 'runtime/core.json');
        if (scenario === 'missing') unlinkSync(descriptorPath);
        else if (scenario === 'malformed') writeFileSync(descriptorPath, '{');
        else if (scenario.startsWith('foreign-')) {
          const descriptor = CanopyRuntimeDescriptorSchema.parse(
            JSON.parse(readFileSync(descriptorPath, 'utf8')),
          );
          if (scenario === 'foreign-endpoint')
            descriptor.endpoint.path += '.foreign';
          else {
            if (!descriptor.socketIdentity)
              throw new Error('Socket identity required');
            if (scenario === 'foreign-device')
              descriptor.socketIdentity.device = String(socket.dev + 1n);
            else descriptor.socketIdentity.inode = String(socket.ino + 1n);
          }
          writeFileSync(descriptorPath, JSON.stringify(descriptor));
        }
        const unlink = jest.fn(
          (request: Parameters<typeof endpoints.unlinkStale>[0]) =>
            endpoints.unlinkStale(request),
        );
        const probe: typeof endpoints.probe =
          scenario === 'ambiguous'
            ? () => Promise.resolve({ state: 'ambiguous', reason: 'test' })
            : scenario === 'refused-live-owner'
              ? () =>
                  Promise.resolve({
                    state: 'refused',
                    identity: { device: socket.dev, inode: socket.ino },
                  })
              : (address) => endpoints.probe(address);
        await expect(
          runEndpointMaintenance(
            {
              ...context,
              platform: {
                ...context.platform,
                supervision: {
                  ...context.platform.supervision,
                  inspectProcess: (request) =>
                    scenario === 'unverifiable' && request.pid === child.pid
                      ? Promise.resolve({
                          state: 'unverifiable',
                          reason: 'test',
                        })
                      : context.platform.supervision.inspectProcess(request),
                },
                endpoints: { ...endpoints, unlinkStale: unlink, probe },
              },
            },
            { source: 'offline_maintenance', mode: 'reopen' },
          ),
        ).rejects.toMatchObject({ reason: 'endpoint-unavailable' });
        expect(unlink).not.toHaveBeenCalled();
        expect(
          lstatSync(join(data, 'runtime/core.sock'), { bigint: true }).ino,
        ).toBe(socket.ino);
        expect(context.host.workersStarted).toBe(0);
      } finally {
        await killEndpointOwner(child);
      }
    });

    generalPosixMaintenance.each([
      'host-active',
      'presence-active',
      'replaced-at-probe',
      'descriptor-replaced-at-probe',
      'owner-live-under-exclusion',
      'owner-unverifiable-under-exclusion',
      'inherited-descriptor-replaced-at-probe',
      'replaced-at-unlink',
      'claim-lost-at-unlink',
    ])('%s refuses before removing any foreign endpoint', async (scenario) => {
      const descriptorBytes = await orphanEndpoint(
        scenario === 'inherited-descriptor-replaced-at-probe',
      );
      const publishedOwner = CanopyRuntimeDescriptorSchema.parse(
        JSON.parse(descriptorBytes.toString('utf8')),
      );
      const context = createW5RecoveryMaintenanceContext(data, { workerEntry });
      const endpoints = context.platform.endpoints;
      if (endpoints.semantics !== 'filesystem-socket')
        throw new Error('POSIX required');
      const registration =
        scenario === 'host-active'
          ? await registerW5Host({ dataRoot: data, hostKind: 'cli' })
          : undefined;
      const presence =
        scenario === 'presence-active'
          ? await acquireW5RootPresence(data, 'host')
          : undefined;
      let probes = 0;
      const replace = (): void => {
        unlinkSync(join(data, 'runtime/core.sock'));
        writeFileSync(join(data, 'runtime/core.sock'), 'replacement');
      };
      const unlink = jest.fn(
        async (request: Parameters<typeof endpoints.unlinkStale>[0]) => {
          expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(
            true,
          );
          if (scenario === 'replaced-at-unlink') replace();
          if (scenario === 'claim-lost-at-unlink')
            unlinkSync(join(data, 'runtime/startup-claim.json'));
          return endpoints.unlinkStale(request);
        },
      );
      const probe: typeof endpoints.probe = async (address) => {
        if (++probes === 2) {
          if (scenario === 'replaced-at-probe') replace();
          if (
            scenario === 'descriptor-replaced-at-probe' ||
            scenario === 'inherited-descriptor-replaced-at-probe'
          ) {
            const path = join(data, 'runtime/core.json');
            const descriptor = CanopyRuntimeDescriptorSchema.parse(
              JSON.parse(readFileSync(path, 'utf8')),
            );
            descriptor.endpoint.path += '.foreign';
            writeFileSync(path, JSON.stringify(descriptor));
          }
        }
        return endpoints.probe(address);
      };
      try {
        const result = runEndpointMaintenance(
          {
            ...context,
            platform: {
              ...context.platform,
              supervision: {
                ...context.platform.supervision,
                inspectProcess: (request) => {
                  if (request.pid === publishedOwner.pid && probes >= 2) {
                    if (scenario === 'owner-live-under-exclusion')
                      return Promise.resolve({
                        state: 'running',
                        startIdentity: publishedOwner.startIdentity,
                      });
                    if (scenario === 'owner-unverifiable-under-exclusion')
                      return Promise.resolve({
                        state: 'unverifiable',
                        reason: 'test',
                      });
                  }
                  return context.platform.supervision.inspectProcess(request);
                },
              },
              endpoints: { ...endpoints, probe, unlinkStale: unlink },
            },
          },
          { source: 'offline_maintenance', mode: 'reopen' },
        );
        if (scenario === 'host-active' || scenario === 'presence-active')
          await expect(result).rejects.toHaveProperty(
            'reason',
            expect.stringMatching(/host-active|cohort-ambiguous/),
          );
        else
          await expect(result).rejects.toMatchObject({
            reason:
              scenario === 'claim-lost-at-unlink' ||
              scenario === 'inherited-descriptor-replaced-at-probe'
                ? 'release-uncertain'
                : 'endpoint-unavailable',
            ...((scenario === 'claim-lost-at-unlink' ||
              scenario === 'inherited-descriptor-replaced-at-probe') && {
              operationError: { reason: 'endpoint-unavailable' },
            }),
          });
        if (
          scenario !== 'replaced-at-unlink' &&
          scenario !== 'claim-lost-at-unlink'
        )
          expect(unlink).not.toHaveBeenCalled();
        if (
          scenario === 'replaced-at-probe' ||
          scenario === 'replaced-at-unlink'
        )
          expect(readFileSync(join(data, 'runtime/core.sock'), 'utf8')).toBe(
            'replacement',
          );
        else
          expect(lstatSync(join(data, 'runtime/core.sock')).isSocket()).toBe(
            true,
          );
        expect(context.host.workersStarted).toBe(0);
      } finally {
        presence?.close();
        if (registration) leaveW5HostCohortSync();
      }
    });

    generalPosixMaintenance.each(['before-exclusion', 'under-exclusion'])(
      'stale-owner inspection cancellation %s preserves its reason without writes',
      async (phase) => {
        const descriptorBytes = await orphanEndpoint();
        const descriptor = CanopyRuntimeDescriptorSchema.parse(
          JSON.parse(descriptorBytes.toString('utf8')),
        );
        const context = createW5RecoveryMaintenanceContext(data, {
          workerEntry,
        });
        const endpoints = context.platform.endpoints;
        if (endpoints.semantics !== 'filesystem-socket')
          throw new Error('POSIX required');
        const unlink = jest.fn(
          (request: Parameters<typeof endpoints.unlinkStale>[0]) =>
            endpoints.unlinkStale(request),
        );
        const controller = new AbortController();
        const cancellation = new Error('maintenance cancelled');
        await expect(
          runEndpointMaintenance(
            {
              ...context,
              platform: {
                ...context.platform,
                supervision: {
                  ...context.platform.supervision,
                  inspectProcess: (request) => {
                    if (
                      request.pid === descriptor.pid &&
                      (phase === 'before-exclusion' ||
                        existsSync(join(data, 'runtime/w5-maintenance.json')))
                    ) {
                      controller.abort(cancellation);
                      return Promise.reject(cancellation);
                    }
                    return context.platform.supervision.inspectProcess(request);
                  },
                },
                endpoints: { ...endpoints, unlinkStale: unlink },
              },
            },
            { source: 'offline_maintenance', mode: 'reopen' },
            controller.signal,
          ),
        ).rejects.toBe(cancellation);
        expect(unlink).not.toHaveBeenCalled();
        expect(lstatSync(join(data, 'runtime/core.sock')).isSocket()).toBe(
          true,
        );
        expect(readFileSync(join(data, 'runtime/core.json'))).toEqual(
          descriptorBytes,
        );
        expect(context.host.workersStarted).toBe(0);
        expect(existsSync(join(data, 'runtime/startup-claim.json'))).toBe(
          false,
        );
        expect(existsSync(join(data, 'runtime/w5-maintenance.json'))).toBe(
          false,
        );
      },
    );
  },
);
