import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { BrowserProfileService } from '../browser/browser-profile-service';
import * as profileServices from '../browser/browser-profile-service';
import { BrowserService } from '../browser/browser-service';
import { BrowserProfileData } from '../browser/browser-profile-data';
import type * as electron from 'electron';
import type * as nativeMaintenance from '../browser/native-maintenance';
import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';

// Branching evidence only. The separate Electron probe must qualify native lifecycle.
jest.mock('electron', () => ({
  ...jest.requireActual<typeof electron>('electron'),
  session: { fromPartition: jest.fn() },
  webContents: { getAllWebContents: (): never[] => [] },
}));
const mockStopWorkers = jest.fn<Promise<void>, []>();
jest.mock('../browser/native-maintenance', () => ({
  ...jest.requireActual<typeof nativeMaintenance>(
    '../browser/native-maintenance',
  ),
  clearRetiredBrowserSession: jest.fn(),
  BrowserNativeMaintenance: class {
    stopWorkers = mockStopWorkers;
    async release(): Promise<void> {}
    async verifyEmpty(): Promise<void> {}
    inspect(
      origin: string,
      topLevelOrigin: string,
    ): ReturnType<nativeMaintenance.BrowserNativeMaintenance['inspect']> {
      return Promise.resolve({
        origin,
        topLevelOrigin,
        registrableDomain: 'example.invalid',
        localStorageCount: 0,
        databaseCount: 0,
        cacheCount: 0,
        workerCount: 0,
        opfsEntries: 0,
      });
    }
  },
}));
interface NativeFixture {
  storagePath: string;
  webRequest: { onBeforeRequest: jest.Mock };
  setPermissionRequestHandler: jest.Mock;
  setPermissionCheckHandler: jest.Mock;
  cookies?: { get: () => Promise<unknown[]> };
  clearCache?: () => Promise<void>;
  clearData?: (options: unknown) => Promise<void>;
}
const { session } = jest.requireMock<{
  session: { fromPartition: jest.Mock<NativeFixture, [string]> };
}>('electron');
const { clearRetiredBrowserSession } = jest.requireMock<{
  clearRetiredBrowserSession: jest.Mock<Promise<void>, unknown[]>;
}>('../browser/native-maintenance');

describe('browser_native_partitions R8 adapter qualification', () => {
  let root: string;
  let service: BrowserProfileService;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'browser-native-r8-'));
    service = new BrowserProfileService(root, join(root, 'session-data'));
    session.fromPartition.mockReset().mockImplementation((partition) => ({
      storagePath: nativePath(partition),
      webRequest: { onBeforeRequest: jest.fn() },
      setPermissionRequestHandler: jest.fn(),
      setPermissionCheckHandler: jest.fn(),
    }));
    clearRetiredBrowserSession.mockReset().mockResolvedValue(undefined);
    mockStopWorkers.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const nativePath = (partition: string): string =>
    join(
      root,
      'session-data',
      'Partitions',
      partition.slice('persist:'.length).toLowerCase(),
    );
  const named = (): Promise<BrowserProfileRecord> =>
    service.repository.createNamed('create', { displayName: 'R8' });
  const retire = (
    profile: BrowserProfileRecord,
  ): ReturnType<typeof service.repository.resetProfile> =>
    service.repository.resetProfile('reset', profile);

  test('inspection of an unused profile never allocates a Session', async () => {
    const profile = await named();
    expect(await service.existingSession(profile.profileId, 1)).toBeUndefined();
    expect(session.fromPartition).not.toHaveBeenCalled();
    await expect(
      fs.stat(await service.storageDirectory(profile.profileId, 1)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('task acquisition shares initialization and refuses a stale generation before native allocation', async () => {
    await fs.mkdir(join(root, 'workspaces/project'), { recursive: true });
    await fs.writeFile(
      join(root, 'workspaces/index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'project', type: 'single-repo' }],
      }),
    );
    await fs.writeFile(
      join(root, 'workspaces/project/worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'task', createdAt: '2026-11-16' }],
      }),
    );
    const resolution = await service.resolve('project', 'task');
    const [first, second] = await Promise.all([
      service.acquireSession(resolution),
      service.acquireSession(resolution),
    ]);
    expect(first).toBe(second);
    expect(session.fromPartition).toHaveBeenCalledTimes(1);
    await retire(resolution.profile);
    await expect(service.acquireSession(resolution)).rejects.toMatchObject({
      code: 'profile_unavailable',
    });
    expect(session.fromPartition).toHaveBeenCalledTimes(1);
  });

  test('unexpected native storage path refuses and stays loaded for safe cleanup', async () => {
    const profile = await named();
    const path = await service.storageDirectory(profile.profileId, 1);
    await fs.mkdir(path, { recursive: true });
    session.fromPartition.mockImplementationOnce(() => ({
      storagePath: join(root, 'unexpected'),
      webRequest: { onBeforeRequest: jest.fn() },
      setPermissionRequestHandler: jest.fn(),
      setPermissionCheckHandler: jest.fn(),
    }));
    await expect(
      service.existingSession(profile.profileId, 1),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(
      service.existingSession(profile.profileId, 1),
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(session.fromPartition).toHaveBeenCalledTimes(1);
    const partition = await service.repository.getNativePartition(
      profile.profileId,
      1,
    );
    expect(service.isCleanupLoaded(partition)).toBe(true);
    await retire(profile);
    await service.purgeRetired();
    expect(clearRetiredBrowserSession).not.toHaveBeenCalled();
    expect(await service.repository.getCleanupJobs()).toHaveLength(1);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  test('loaded retirement retries failed clear, retains job/directory, and only a fresh adapter removes them', async () => {
    const profile = await named();
    const path = await service.storageDirectory(profile.profileId, 1);
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, 'synthetic'), 'native bytes');
    await service.existingSession(profile.profileId, 1);
    await retire(profile);
    clearRetiredBrowserSession.mockRejectedValueOnce(new Error('native busy'));
    await service.purgeRetired();
    expect(service.cleanupErrors.size).toBe(1);
    await service.purgeRetired();
    expect(service.cleanupErrors.size).toBe(0);
    expect(clearRetiredBrowserSession).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(join(path, 'synthetic'), 'utf8')).toBe(
      'native bytes',
    );
    expect(await service.repository.getCleanupJobs()).toHaveLength(1);
    await service.purgeRetired();
    expect(clearRetiredBrowserSession).toHaveBeenCalledTimes(2);
    await new BrowserProfileService(
      root,
      join(root, 'session-data'),
    ).purgeRetired();
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.repository.getCleanupJobs()).toHaveLength(0);
  });

  test.each(['symlink', 'mismatch', 'replacement-directory'])(
    'unloaded purge contract: %s',
    async (kind) => {
      const profile = await named();
      const path = await service.storageDirectory(profile.profileId, 1);
      const outside = join(root, 'replacement');
      await fs.mkdir(outside);
      await fs.writeFile(join(outside, 'retain'), 'outside');
      if (kind === 'mismatch')
        await service.repository.recordNativePath(
          profile.profileId,
          1,
          outside,
        );
      await retire(profile);
      await fs.mkdir(join(root, 'session-data/Partitions'), {
        recursive: true,
      });
      // Junctions exercise link refusal without Windows symlink privileges.
      if (kind === 'symlink')
        await fs.symlink(
          outside,
          path,
          hostOperatingSystem() === 'win32' ? 'junction' : 'dir',
        );
      else {
        await fs.mkdir(path);
        await fs.writeFile(join(path, 'replacement'), 'not identity fenced');
      }
      await service.purgeRetired();
      expect(await fs.readFile(join(outside, 'retain'), 'utf8')).toBe(
        'outside',
      );
      if (kind === 'replacement-directory') {
        // q-9 accepts path-based removal, not a remembered dev/inode identity.
        await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await service.repository.getCleanupJobs()).toHaveLength(0);
      } else {
        expect(await service.repository.getCleanupJobs()).toHaveLength(1);
        expect(service.cleanupErrors.size).toBe(1);
        expect(await fs.lstat(path)).toBeDefined();
        if (kind === 'symlink') {
          await fs.unlink(path);
          await fs.mkdir(path);
          await service.purgeRetired();
          expect(await service.repository.getCleanupJobs()).toEqual([]);
          expect(service.cleanupErrors.size).toBe(0);
        }
      }
    },
  );

  test('cleanup of an old generation leaves the active generation untouched', async () => {
    const profile = await named();
    const oldPath = await service.storageDirectory(profile.profileId, 1);
    await fs.mkdir(oldPath, { recursive: true });
    const next = await retire(profile);
    const activePath = await service.storageDirectory(
      profile.profileId,
      next.profile.storageGeneration,
    );
    await fs.mkdir(activePath, { recursive: true });
    await fs.writeFile(join(activePath, 'active'), 'retain');
    await service.purgeRetired();
    await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(activePath, 'active'), 'utf8')).toBe(
      'retain',
    );
    expect(await service.repository.getCleanupJobs()).toEqual([]);
  });

  test.each(['cache', 'site'] as const)(
    'maintenance %s fences and drains producers before journaled native invocation',
    async (kind) => {
      const profile = await named();
      const path = await service.storageDirectory(profile.profileId, 1);
      await fs.mkdir(path, { recursive: true });
      jest
        .spyOn(profileServices, 'getBrowserProfileService')
        .mockReturnValue(service);
      const browser = new BrowserService({
        getWindow: (): null => null,
        profileAuthority: service,
      });
      const data = new BrowserProfileData(browser);
      const order: string[] = [];
      let jobId = '';
      const clear = jest.fn(async (): Promise<void> => {
        expect(order).toEqual([
          'creations',
          'views',
          'downloads',
          'scratch',
          'workers',
        ]);
        expect((await data.jobs.getForExecution(jobId))?.irreversible).toBe(
          true,
        );
      });
      session.fromPartition.mockImplementationOnce((partition) => ({
        storagePath: nativePath(partition),
        webRequest: { onBeforeRequest: jest.fn() },
        setPermissionRequestHandler: jest.fn(),
        setPermissionCheckHandler: jest.fn(),
        cookies: { get: (): Promise<unknown[]> => Promise.resolve([]) },
        clearCache: clear,
        clearData: clear,
      }));
      jest
        .spyOn(browser, 'drainProfileCreations')
        .mockImplementation((): Promise<void> => {
          order.push('creations');
          return Promise.resolve();
        });
      jest
        .spyOn(browser, 'disposeProfileViews')
        .mockImplementation((): Promise<void> => {
          order.push('views');
          return Promise.resolve();
        });
      jest
        .spyOn(browser.downloads, 'drain')
        .mockImplementation((): Promise<void> => {
          order.push('downloads');
          return Promise.resolve();
        });
      jest
        .spyOn(data.scratch, 'drain')
        .mockImplementation((): Promise<void> => {
          order.push('scratch');
          return Promise.resolve();
        });
      mockStopWorkers.mockImplementation((): Promise<void> => {
        expect(() =>
          browser.assertProfileAvailable(profile.profileId),
        ).toThrow();
        order.push('workers');
        return Promise.resolve();
      });
      try {
        await data.ensureReady();
        order.length = 0;
        data.observations.record(
          profile.profileId,
          1,
          'https://example.invalid',
          'https://example.invalid',
          'example.invalid',
        );
        await data.observations.flush();
        const commands = data.userCommands();
        const preview = await commands.previewClear({
          profileId: profile.profileId,
          storageGeneration: 1,
          metadataRevision: profile.metadataRevision,
          operation:
            kind === 'cache'
              ? { kind }
              : { kind, origin: 'https://example.invalid' },
        });
        const job = await commands.clear({
          operationId: 'clear',
          token: preview.token,
        });
        jobId = job.jobId;
        await data.maintenance.settled();
        expect(clear).toHaveBeenCalledTimes(1);
        if (kind === 'site')
          expect(clear).toHaveBeenCalledWith(
            expect.objectContaining({
              origins: ['https://example.invalid'],
              originMatchingMode: 'origin-in-all-contexts',
            }),
          );
        expect(await commands.jobGet({ jobId })).toMatchObject({
          status: 'complete',
        });
        expect(() =>
          browser.assertProfileAvailable(profile.profileId),
        ).not.toThrow();
      } finally {
        await data.shutdown();
        await browser.shutdown();
      }
    },
  );
});
