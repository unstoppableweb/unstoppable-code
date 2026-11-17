import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedWorktreeBrowserStateFile } from '@canopy/execution-engine/types/browser';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type * as archived from '../lib/archived-containers';
import * as paths from '../lib/paths';
import {
  captureWorktreeBrowserStateRollback,
  loadAndMigrateWorktreeBrowserState,
  loadWorktreeBrowserState,
  loadWorktreeBrowserStateAsync,
  saveWorktreeBrowserState,
} from '../browser/browser-persistence';
import { BrowserService } from '../browser/browser-service';
import { withWorkspaceTargetArchiveDrain } from '../lib/workspace-target-exclusion';

// Real archive lock and writers; workspace policy and native UI are not qualified here.
jest.mock('../lib/archived-containers', () => ({
  withArchivedWorkspaceOperationLock: jest.requireActual<typeof archived>(
    '../lib/archived-containers',
  ).withArchivedWorkspaceOperationLock,
}));
jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTargetWithoutOperationLock: (): Promise<void> =>
    Promise.resolve(),
}));

const scope = {
  projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
  worktreeId: 'r8-state',
};
function state(id?: string): PersistedWorktreeBrowserStateFile {
  return {
    version: 2,
    browserOrder: id ? [id] : [],
    activeBrowserId: id ?? null,
    browsers: id
      ? [
          {
            ...scope,
            id,
            createdAt: 1,
            updatedAt: 2,
            url: 'https://example.invalid/',
            title: id,
            status: 'ready',
            canGoBack: false,
            canGoForward: false,
            loading: false,
            themeMode: 'light',
            pickMode: false,
            recording: false,
          },
        ]
      : [],
  };
}

describe('browser_state R8 qualification', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'browser-state-r8-'));
    file = join(root, 'browser-state.json');
    jest.spyOn(paths, 'getWorktreeBrowserStateFilePath').mockReturnValue(file);
    jest.spyOn(paths, 'getWorktreeDataDir').mockReturnValue(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const load = (): ReturnType<typeof loadWorktreeBrowserState> =>
    loadWorktreeBrowserState(scope.projectId, scope.worktreeId);
  const save = (value = state()): Promise<void> =>
    saveWorktreeBrowserState({ ...scope, state: value });

  test('missing is distinct from non-absence read failure in both readers', async () => {
    expect(load()).toEqual({ status: 'missing', state: null });
    expect(
      await loadWorktreeBrowserStateAsync(scope.projectId, scope.worktreeId),
    ).toEqual(load());
    await fs.mkdir(file);
    expect(load()).toMatchObject({ status: 'fallback' });
    expect(
      await loadWorktreeBrowserStateAsync(scope.projectId, scope.worktreeId),
    ).toMatchObject({ status: 'fallback' });
    expect((await fs.stat(file)).isDirectory()).toBe(true);
  });

  test.each([
    '',
    '{broken',
    '{"version":0}',
    '{"version":999}',
    '{"version":2,"browsers":[]}',
  ])('BrowserService latch preserves rejected bytes: %s', async (bytes) => {
    await fs.writeFile(file, bytes);
    const service = new BrowserService({ getWindow: (): null => null });
    try {
      await service.saveWorktreeState({ ...scope, state: state('ignored') });
      expect(await fs.readFile(file, 'utf8')).toBe(bytes);
      // The low-level writer validates the proposed image, not the old file.
      await save(state('explicit-low-level'));
      expect(load()).toMatchObject({
        status: 'loaded',
        state: state('explicit-low-level'),
      });
    } finally {
      await service.shutdown();
    }
  });

  test('legacy normalization preserves one exclusive migration copy, including on repeated migration', async () => {
    const legacy = JSON.stringify({
      version: 1,
      browsers: state('old').browsers,
      groups: [
        {
          id: 'group',
          browserIds: ['missing', 'old', 'old'],
          focusedBrowserId: 'old',
        },
      ],
      activeGroupId: 'group',
    });
    await fs.writeFile(file, legacy);
    expect(
      await loadAndMigrateWorktreeBrowserState(
        scope.projectId,
        scope.worktreeId,
      ),
    ).toMatchObject({ status: 'loaded', state: state('old') });
    expect(await fs.readFile(`${file}.v1.backup`, 'utf8')).toBe(legacy);
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, browsers: [], groups: [] }),
    );
    await loadAndMigrateWorktreeBrowserState(scope.projectId, scope.worktreeId);
    expect(await fs.readFile(`${file}.v1.backup`, 'utf8')).toBe(legacy);
    expect(load()).toMatchObject({ status: 'loaded', state: state() });
  });

  test('migration-copy failure and failed atomic install retain the prior image', async () => {
    const legacy = '{"version":1,"browsers":[],"groups":[]}';
    await fs.writeFile(file, legacy);
    jest.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('copy denied'));
    await expect(
      loadAndMigrateWorktreeBrowserState(scope.projectId, scope.worktreeId),
    ).rejects.toThrow('copy denied');
    expect(await fs.readFile(file, 'utf8')).toBe(legacy);
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('install denied'));
    await expect(save()).rejects.toThrow('install denied');
    expect(await fs.readFile(file, 'utf8')).toBe(legacy);
    expect(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('migration is not ordered by ordinary-save admission', async () => {
    await fs.writeFile(file, '{"version":1,"browsers":[],"groups":[]}');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const copy = fs.copyFile;
    jest.spyOn(fs, 'copyFile').mockImplementationOnce(async (...args) => {
      await copy(...args);
      entered.resolve();
      await release.promise;
    });
    const migrating = loadAndMigrateWorktreeBrowserState(
      scope.projectId,
      scope.worktreeId,
    );
    await entered.promise;
    try {
      await save(state('new-save'));
      expect(load()).toMatchObject({ state: state('new-save') });
    } finally {
      release.resolve();
      await migrating;
    }
    // A stale migration can replace a later save: no store-wide queue is claimed.
    expect(load()).toMatchObject({ state: state() });
  });

  test('projection rollback can replace a later service save; queued cancellation cannot publish', async () => {
    await save(state('preimage'));
    const rollback = await captureWorktreeBrowserStateRollback(
      scope.projectId,
      scope.worktreeId,
    );
    const service = new BrowserService({ getWindow: (): null => null });
    try {
      await service.saveWorktreeState({ ...scope, state: state('service') });
      await rollback();
      expect(load()).toMatchObject({ state: state('preimage') });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const saving = saveWorktreeBrowserState(
        { ...scope, state: state('holder') },
        async (write) => {
          entered.resolve();
          await release.promise;
          await write();
        },
      );
      await entered.promise;
      const controller = new AbortController();
      const cancelled = saveWorktreeBrowserState(
        { ...scope, state: state('cancelled') },
        undefined,
        controller.signal,
      );
      const rejection = expect(cancelled).rejects.toThrow();
      controller.abort();
      try {
        await rejection;
      } finally {
        release.resolve();
        await saving;
      }
      expect(load()).toMatchObject({ state: state('holder') });
    } finally {
      await service.shutdown();
    }
  });

  test('archive drain waits for an installed save and refuses the queued service save before cleanup', async () => {
    const service = new BrowserService({ getWindow: (): null => null });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rename = fs.rename;
    jest.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await rename(...args);
    });
    const saving = service.saveWorktreeState({ ...scope, state: state() });
    await entered.promise;
    const queued = service.saveWorktreeState({
      ...scope,
      state: state('late'),
    });
    const refused = expect(queued).rejects.toThrow();
    const removing = withWorkspaceTargetArchiveDrain(
      scope.projectId,
      scope.worktreeId,
      async () => {
        await service.destroyWorktree(scope.projectId, scope.worktreeId, {
          deletingTarget: true,
        });
        await fs.rm(file, { force: true });
      },
    );
    try {
      release.resolve();
      await Promise.all([saving, refused, removing]);
      expect(load()).toEqual({ status: 'missing', state: null });
      expect(await fs.readdir(root)).not.toContain('browser-state.json');
    } finally {
      release.resolve();
      await service.shutdown();
    }
  });
});
