// CAN-4175 capture golden: the archived-container retention sweep, pinned on
// unchanged code before it moves into the core lifecycle. Real archive
// manifests in a temporary data directory go through the real sweep; only the
// Ledger journal and the W5 destructive-recovery journal are replaced, so each
// fence can be set per container. It asserts which archives the sweep removes
// and which it keeps: expired ones go, locked ones and ones a fence still
// holds stay, and a staging directory goes only once it is a day old and holds
// nothing that may be the last copy of someone's work.
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedContainerManifestV1 } from '@canopy/desktop-shared/types';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoOperationType,
  ArchiveIoResultMap,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type * as Retention from '../archived-container-retention';
import type * as Paths from '../paths';
import type * as Archives from '../archived-containers';

const mockFenced = new Set<string>();
const mockLedger: {
  intent: 'no_ledger' | 'durable' | 'not_durable';
  purged: string[];
  restored: string[];
} = { intent: 'no_ledger', purged: [], restored: [] };

jest.mock('../w5-destructive-recovery', () => ({
  ...jest.requireActual<object>('../w5-destructive-recovery'),
  hasUnresolvedDestructiveRecovery: (
    _workspaceId: string,
    containerId?: string,
  ): Promise<boolean> =>
    Promise.resolve(containerId !== undefined && mockFenced.has(containerId)),
}));
// The archive I/O utility process runs its engine in this process instead.
jest.mock('../../archive/archive-io-runner', () => ({
  ...jest.requireActual<object>('../../archive/archive-io-runner'),
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      }),
}));
// The chat search index is derived and rebuildable; its worker needs a build.
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: (): object => ({
    worktreeContainerPurged: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../../ledger/lifecycle', () => ({
  ...jest.requireActual<object>('../../ledger/lifecycle'),
  recordLedgerRestoreIntent: (): Promise<string> =>
    Promise.resolve(mockLedger.intent),
  notifyLedgerContainerPurged: (incarnation: unknown): void => {
    mockLedger.purged.push(JSON.stringify(incarnation));
  },
  notifyLedgerContainerRestored: (archived: unknown): void => {
    mockLedger.restored.push(JSON.stringify(archived));
  },
}));

jest.setTimeout(30_000);

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const PROJECT = 'retention-project';

let dataDir: string;
let previousDataDir: string | undefined;

let retention: typeof Retention;
let paths: typeof Paths;
let archives: typeof Archives;

function manifest(
  id: string,
  overrides: Partial<ArchivedContainerManifestV1> = {},
): ArchivedContainerManifestV1 {
  return {
    version: 1,
    kind: 'worktree',
    id,
    projectId: PROJECT,
    name: `Archive ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    archivedAt: '2026-10-02T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-11-01T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    ...overrides,
  };
}

const expired = { expiresAt: new Date(NOW - DAY_MS).toISOString() };
const live = { expiresAt: new Date(NOW + DAY_MS).toISOString() };

async function archive(
  id: string,
  overrides: Partial<ArchivedContainerManifestV1> = {},
): Promise<void> {
  await mkdir(paths.getArchivedContainerDir(PROJECT, id), { recursive: true });
  await archives.commitArchivedContainer(manifest(id, overrides));
}

/** A manifest-less staging directory last touched `ageMs` before NOW. */
async function staging(
  id: string,
  ageMs: number,
  contents: 'empty' | 'executions' | 'workspace-root' = 'empty',
): Promise<void> {
  const directory = paths.getArchivedContainerDir(PROJECT, id);
  await mkdir(directory, { recursive: true });
  if (contents === 'executions') {
    const executions = paths.getArchivedContainerExecutionsDir(PROJECT, id);
    await mkdir(executions, { recursive: true });
    await writeFile(join(executions, 'run.json'), '{}');
  }
  if (contents === 'workspace-root') {
    const root = paths.getArchivedContainerWorkspaceRootDir(PROJECT, id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'notes.md'), 'kept');
  }
  const touched = new Date(NOW - ageMs);
  utimesSync(directory, touched, touched);
}

function present(id: string): boolean {
  return existsSync(paths.getArchivedContainerDir(PROJECT, id));
}

async function listed(): Promise<string[]> {
  return (await archives.listArchivedContainerManifests(PROJECT))
    .map((entry) => entry.id)
    .sort();
}

beforeEach(async () => {
  jest.resetModules();
  mockFenced.clear();
  mockLedger.intent = 'no_ledger';
  mockLedger.purged = [];
  mockLedger.restored = [];
  dataDir = mkdtempSync(join(tmpdir(), 'archive-retention-golden-'));
  previousDataDir = process.env['CANOPY_DATA_DIR'];
  process.env['CANOPY_DATA_DIR'] = dataDir;
  paths = await import('../paths');
  archives = await import('../archived-containers');
  retention = await import('../archived-container-retention');
  await mkdir(join(paths.getWorkspacesRootDir(), PROJECT), { recursive: true });
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['CANOPY_DATA_DIR'];
  else process.env['CANOPY_DATA_DIR'] = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('archived-container retention sweep (CAN-4175 capture)', () => {
  it('removes expired archives and keeps unexpired and locked ones', async () => {
    await archive('expired-deleted', expired);
    await archive('unexpired-deleted', live);
    await archive('locked-past-expiry', {
      ...expired,
      lockedAt: '2026-10-03T00:00:00.000Z',
    });

    await retention.applyArchivedContainerRetention(NOW);

    expect(await listed()).toEqual(['locked-past-expiry', 'unexpired-deleted']);
    expect(present('expired-deleted')).toBe(false);
    expect(mockLedger.purged).toEqual([
      expect.stringContaining('"expired-deleted"'),
    ]);
  });

  it('removes an archive exactly when its expiry has passed', async () => {
    await archive('at-expiry', { expiresAt: new Date(NOW).toISOString() });
    await archive('just-before', {
      expiresAt: new Date(NOW + 1).toISOString(),
    });

    await retention.applyArchivedContainerRetention(NOW);

    expect(await listed()).toEqual(['just-before']);
  });

  it('keeps an expired archive while a destructive recovery still holds it', async () => {
    await archive('held', expired);
    await archive('free', expired);
    mockFenced.add('held');

    await retention.applyArchivedContainerRetention(NOW);
    expect(await listed()).toEqual(['held']);

    mockFenced.clear();
    await retention.applyArchivedContainerRetention(NOW);
    expect(await listed()).toEqual([]);
  });

  it('keeps a partly restored archive until its Ledger mapping is durable', async () => {
    const restoredTo = {
      kind: 'worktree' as const,
      id: 'restored-worktree',
      restoredAt: '2026-10-05T00:00:00.000Z',
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    await archive('partly-restored', { ...expired, restoredTo });
    mockLedger.intent = 'not_durable';

    await retention.applyArchivedContainerRetention(NOW);
    expect(await listed()).toEqual(['partly-restored']);
    expect(mockLedger.restored).toEqual([]);

    mockLedger.intent = 'durable';
    await retention.applyArchivedContainerRetention(NOW);
    expect(await listed()).toEqual([]);
    expect(mockLedger.restored).toEqual([
      expect.stringContaining('"partly-restored"'),
    ]);
    // Its scope moved to the restored container, so purging retires nothing.
    expect(mockLedger.purged).toEqual([]);
  });

  it('removes a staging directory only once it is a day old and holds nothing to keep', async () => {
    await staging('stale-empty', DAY_MS + 60_000);
    await staging('fresh-empty', DAY_MS - 60_000);
    await staging('stale-with-executions', DAY_MS + 60_000, 'executions');
    await staging('stale-with-root-files', DAY_MS + 60_000, 'workspace-root');
    await staging('stale-fenced', DAY_MS + 60_000);
    mockFenced.add('stale-fenced');

    await retention.applyArchivedContainerRetention(NOW);

    expect(present('stale-empty')).toBe(false);
    expect(present('fresh-empty')).toBe(true);
    expect(present('stale-with-executions')).toBe(true);
    expect(present('stale-with-root-files')).toBe(true);
    expect(present('stale-fenced')).toBe(true);
  });

  it('sweeps once when it starts, then every 12 hours until stopped', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'Date',
        'nextTick',
        'setImmediate',
        'queueMicrotask',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      await archive('first', {
        expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      });
      const stop = retention.startArchivedContainerRetentionScheduler();
      await waitFor(() => !present('first'));

      await archive('second', {
        expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      });
      jest.advanceTimersByTime(12 * 60 * 60 * 1_000 - 1);
      await settle();
      expect(present('second')).toBe(true);
      jest.advanceTimersByTime(1);
      await waitFor(() => !present('second'));

      stop();
      await archive('third', {
        expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      });
      jest.advanceTimersByTime(24 * 60 * 60 * 1_000);
      await settle();
      expect(present('third')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the sweep');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
