import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockRoot = '';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', on: jest.fn() },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: jest.fn() },
}));

jest.mock('../native-crash-policy', () => ({
  nativeCrashAnnotation: {
    suspendForOptOut: jest.fn(),
    resumeAfterOptIn: jest.fn(),
  },
}));

jest.mock('../paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../paths'),
  getPreferencesFilePath: (): string => `${mockRoot}/preferences.json`,
}));

import {
  CONFIG_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { StorageRowOwnerError } from '@canopy/core-runtime/node/pipeline/store';
import { createCoreOperationAdapter } from '../../canopy-runtime/core-operation-adapter';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { protectedApprovalFileWritePaths } from '../../approvals/approval-rule-sources';
import type * as PathsModule from '../paths';
import { createPreferencesGenerationPath } from '../preferences-file-paths';
import {
  flushPreferencesWrites,
  readPreferencesFile,
  stampPreferencesGeneration,
  startPreferencesGenerationStamp,
  updatePreferencesFile,
} from '../preferences-store';

/*
 * CAN-7916 (the first slice of CAN-5722): Electron main writes the preferences
 * row (the preferences file, its last-good, generation and backup copies, and
 * the usage-data denial journal) only while the row's owner record names the
 * app, or while there is no record. A record naming the daemon, or one that
 * can't be read, refuses every write before a byte of the row changes,
 * including a core.config.update and the background generation stamp, which
 * answers `refused` and stops instead of retrying. An agent can't write the
 * owner records without approval, so it can't block saves that way.
 */

function ownerRecordPath(): string {
  return join(mockRoot, 'storage-records', 'preferences', 'owner-flip.json');
}

function record(toOwner: 'daemon' | 'legacy'): void {
  mkdirSync(join(ownerRecordPath(), '..'), { recursive: true });
  writeFileSync(
    ownerRecordPath(),
    JSON.stringify({
      namespaceId: 'preferences',
      fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
      toOwner,
      workPackage: 'W6',
      backupRecord: `storage-records/preferences/namespace-backup.json#sha256:${'a'.repeat(64)}`,
      flippedAt: '2026-11-25T10:00:00.000Z',
    }),
  );
}

/** The row's files in the data root, by name and digest. */
function preferencesRow(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(mockRoot)) {
    if (!name.startsWith('preferences.')) continue;
    files[name] = createHash('sha256')
      .update(readFileSync(join(mockRoot, name)))
      .digest('hex');
  }
  return files;
}

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'agent-action:advisor-chat',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants,
});

const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'preferences-owner-record-'));
  process.env.CANOPY_DATA_DIR = mockRoot;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('older app writes refused once another owner keeps the preferences (CAN-7916)', () => {
  it('saves as before with no record, refuses every write while the record names the daemon or can’t be read, and saves again once it names the app', async () => {
    await updatePreferencesFile(() => ({ fileAutoSave: true }));
    await flushPreferencesWrites();
    expect(existsSync(join(mockRoot, 'preferences.json'))).toBe(true);

    record('daemon');
    const before = preferencesRow();
    await expect(
      updatePreferencesFile(() => ({ fileAutoSave: false })),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
    // A revocation writes its journal ahead of the save; that is refused too.
    await expect(
      updatePreferencesFile((latest) => ({
        usageData: { ...latest.usageData, productAnalytics: false },
      })),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
    await flushPreferencesWrites();
    expect(preferencesRow()).toEqual(before);

    writeFileSync(ownerRecordPath(), '{ not json');
    await expect(
      updatePreferencesFile(() => ({ fileAutoSave: false })),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
    await flushPreferencesWrites();
    expect(preferencesRow()).toEqual(before);

    record('legacy');
    await updatePreferencesFile(() => ({ fileAutoSave: false }));
    await flushPreferencesWrites();
    expect((await readPreferencesFile()).fileAutoSave).toBe(false);
  });

  it('refuses a core.config.update of the preferences the same way', async () => {
    await updatePreferencesFile(() => ({ fileAutoSave: true }));
    await flushPreferencesWrites();
    const runtime = createDesktopRuntime({
      operationAdapter: createCoreOperationAdapter({
        ledgerPath: () => join(mockRoot, 'ledger.sqlite'),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      const { revision } = await runtime.query(
        'core.config.get',
        { namespace: 'agent' },
        { caller: caller([CONFIG_GRANTS.read]) },
      );
      record('daemon');
      const before = preferencesRow();
      const meta = { idempotencyKey: 'owner-record-1' };
      const refusal = await runtime
        .instruction(
          'core.config.update',
          {
            namespace: 'agent',
            expectedRevision: revision,
            patch: { claudeMaxTurns: 25 },
            _meta: meta,
          },
          { caller: caller([CONFIG_GRANTS.write]), metadata: meta },
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal).toMatchObject({
        payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
      });
      expect(refusal instanceof Error ? refusal.message : '').toContain(
        'Nothing was saved.',
      );
      await flushPreferencesWrites();
      expect(preferencesRow()).toEqual(before);
    } finally {
      await runtime.shutdown();
    }
  });

  it('answers refused from the generation stamp of a row another owner keeps, and stops instead of retrying', async () => {
    await updatePreferencesFile(() => ({ fileAutoSave: true }));
    await flushPreferencesWrites();
    // A profile saved before generations were recorded.
    rmSync(
      createPreferencesGenerationPath(join(mockRoot, 'preferences.json')),
      { force: true },
    );
    record('daemon');
    const before = preferencesRow();

    await expect(stampPreferencesGeneration()).resolves.toBe('refused');
    const warn = jest.spyOn(console, 'warn').mockReturnValue(undefined);
    let attempts = 0;
    try {
      await expect(
        startPreferencesGenerationStamp(() => {
          attempts += 1;
          return Promise.resolve(attempts === 1);
        }),
      ).resolves.toBe('refused');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Another owner keeps the preferences'),
      );
    } finally {
      warn.mockRestore();
    }
    expect(attempts).toBe(1);
    await flushPreferencesWrites();
    expect(preferencesRow()).toEqual(before);
  });

  it('lists the row’s owner records among the files an agent may not write without approval', async () => {
    const paths = await protectedApprovalFileWritePaths(
      'workspace-1',
      mockRoot,
    );
    expect(paths).toContain(
      join(realpathSync(mockRoot), 'storage-records', 'preferences', '*'),
    );
  });
});
