import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  BrowserTaskFiles,
  type BrowserTaskFilesDeps,
} from '../browser/files/task-files';
import {
  copyTempName,
  prepareWorkspaceDestination,
} from '../browser/files/workspace-copy';

const scope = { projectId: 'project', worktreeId: 'task' };
const runtime = {
  browserId: 'browser',
  runtimeGeneration: 1,
  taskIncarnationId: 'incarnation',
};
const download = {
  kind: 'download',
  id: 'download',
  browserId: 'browser',
  source: 'user',
  origin: 'https://example.invalid/',
  fileName: 'finished.txt',
  receivedBytes: 4,
  totalBytes: 4,
  status: 'complete',
  startedAt: 1,
};

describe('browser_task_files R8 qualification', () => {
  let root: string;
  let folder: string;
  const stores = new Set<BrowserTaskFiles>();
  function store(extra: Partial<BrowserTaskFilesDeps> = {}): BrowserTaskFiles {
    const files = new BrowserTaskFiles({
      emit: (): void => {},
      taskDir: (): string => root,
      // Skip macOS quarantine, but retain Windows' no-directory-fsync path.
      platform: hostOperatingSystem() === 'win32' ? 'win32' : 'linux',
      ...extra,
    });
    stores.add(files);
    return files;
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'browser-files-r8-'));
    folder = join(root, 'browser-files');
    await fs.mkdir(join(folder, 'downloads'), { recursive: true });
  });
  afterEach(async () => {
    await Promise.all([...stores].map((files) => files.drain()));
    stores.clear();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const catalog = (records: unknown[]): Promise<void> =>
    fs.writeFile(
      join(folder, 'files.json'),
      JSON.stringify({ version: 1, records }),
    );
  function admit(
    files: BrowserTaskFiles,
  ): ReturnType<BrowserTaskFiles['admitDownload']> {
    return files.admitDownload({
      scope,
      runtime,
      downloadId: 'new',
      suggestedName: 'new.txt',
      url: 'https://example.invalid/',
      source: 'user',
      totalBytes: 4,
    });
  }

  test('restart separately recovers download, copy and upload, retaining complete and unrelated payloads', async () => {
    const temp = join(root, copyTempName());
    const uploadId = 'b5b278eb-ecf3-4562-9586-928b47d67408';
    await fs.mkdir(join(folder, 'uploads', uploadId), { recursive: true });
    await Promise.all([
      fs.writeFile(temp, 'partial copy'),
      fs.writeFile(join(folder, 'uploads', uploadId, 'staged'), 'staged'),
      fs.writeFile(join(folder, 'downloads/partial.txt.download'), 'partial'),
      fs.writeFile(join(folder, 'downloads/finished.txt'), 'done'),
      fs.writeFile(join(folder, 'downloads/unrelated.download'), 'user file'),
      fs.writeFile(join(folder, '.files-interrupted.tmp'), 'partial catalog'),
    ]);
    await catalog([
      download,
      { ...download, id: 'partial', fileName: 'partial.txt', status: 'paused' },
      {
        kind: 'copy',
        id: 'copy',
        browserId: 'browser',
        sourceId: 'download',
        source: 'user',
        destinationName: 'copy.txt',
        copiedBytes: 1,
        totalBytes: 4,
        status: 'in_progress',
        startedAt: 2,
        tempPath: temp,
      },
      {
        kind: 'upload',
        id: uploadId,
        browserId: 'browser',
        frameOrigin: 'https://example.invalid',
        topOrigin: 'https://example.invalid',
        files: [
          { name: 'upload.txt', displayPath: 'upload.txt', sizeBytes: 4 },
        ],
        stagedBytes: 1,
        totalBytes: 4,
        status: 'staging',
        startedAt: 3,
      },
    ]);
    const files = store();
    await files.bind(scope);
    expect(files.get(scope, 'download')).toMatchObject({
      kind: 'download',
      status: 'complete',
    });
    expect(files.get(scope, 'partial')).toMatchObject({
      kind: 'download',
      status: 'interrupted',
      canResume: false,
    });
    expect(files.get(scope, 'copy')).toMatchObject({
      kind: 'copy',
      status: 'failed',
      error: { code: 'copy_failed', message: 'The copy was interrupted.' },
    });
    expect(files.get(scope, uploadId)).toMatchObject({
      kind: 'upload',
      status: 'failed',
      error: { code: 'upload_failed' },
    });
    for (const path of [
      temp,
      join(folder, 'uploads', uploadId),
      join(folder, '.files-interrupted.tmp'),
      join(folder, 'downloads/partial.txt.download'),
    ])
      await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await fs.readFile(join(folder, 'downloads/finished.txt'), 'utf8'),
    ).toBe('done');
    expect(
      await fs.readFile(join(folder, 'downloads/unrelated.download'), 'utf8'),
    ).toBe('user file');
    const persisted: unknown = JSON.parse(
      await fs.readFile(join(folder, 'files.json'), 'utf8'),
    );
    if (
      !persisted ||
      typeof persisted !== 'object' ||
      !('records' in persisted)
    )
      throw new Error('Missing catalog records');
    expect(persisted.records).toContainEqual(
      expect.objectContaining({
        kind: 'copy',
        id: 'copy',
        error: { code: 'copy_failed', message: 'The copy was interrupted.' },
      }),
    );
    const reopened = store();
    await reopened.bind(scope);
    // Load normalizes copy error text by code, even though bind persisted it.
    const recovered = files.list(scope, 'browser', { browserId: 'browser' });
    const expected = {
      ...recovered,
      transfers: recovered.transfers.map((record) =>
        record.kind === 'copy' && record.error
          ? {
              ...record,
              error: { ...record.error, message: 'The copy failed.' },
            }
          : record,
      ),
    };
    expect(reopened.list(scope, 'browser', { browserId: 'browser' })).toEqual(
      expected,
    );
  });

  test.each([false, true])(
    'download completion is published only after catalog install; failure=%s',
    async (fail) => {
      await catalog([download]);
      await fs.writeFile(join(folder, 'downloads/finished.txt'), 'done');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const files = store({
        beforeCatalogWrite: async (_scope, snapshot) => {
          if (!/"id":"new"[^}]*"status":"complete"/.test(snapshot)) return;
          entered.resolve();
          await release.promise;
          if (fail) throw new Error('injected catalog install failure');
        },
      });
      await files.bind(scope);
      const admitted = admit(files);
      if (!admitted.ok) throw new Error('Download not admitted');
      await files.drain();
      await fs.writeFile(admitted.stagingPath, 'data');
      const completing = files.completeDownload('new');
      await entered.promise;
      try {
        expect(files.get(scope, 'new')).toMatchObject({
          status: 'in_progress',
        });
        const saved: unknown = JSON.parse(
          await fs.readFile(join(folder, 'files.json'), 'utf8'),
        );
        if (!saved || typeof saved !== 'object' || !('records' in saved))
          throw new Error('Missing catalog records');
        expect(saved.records).toContainEqual(
          expect.objectContaining({ id: 'new', status: 'in_progress' }),
        );
      } finally {
        release.resolve();
        await completing;
      }
      expect(files.get(scope, 'new')).toMatchObject({
        status: fail ? 'failed' : 'complete',
      });
      if (fail)
        await expect(
          fs.stat(join(folder, 'downloads/new.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      else
        expect(
          await fs.readFile(join(folder, 'downloads/new.txt'), 'utf8'),
        ).toBe('data');
      expect(
        await fs.readFile(join(folder, 'downloads/finished.txt'), 'utf8'),
      ).toBe('done');
      const reopened = store();
      await reopened.bind(scope);
      expect(reopened.get(scope, 'new')).toMatchObject({
        status: fail ? 'failed' : 'complete',
      });
    },
  );

  test.each(['copy', 'upload'])(
    'target deletion aborts in-flight %s before removal and fences late admission',
    async (kind) => {
      await catalog([download]);
      await fs.writeFile(join(folder, 'downloads/finished.txt'), 'done');
      await fs.writeFile(join(root, 'source.txt'), 'data');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let gated = false;
      let transferId = '';
      let cancelledWhileFolderExists = false;
      const files = store({
        emit: (event): void => {
          if (
            event.type === 'transfer' &&
            event.transfer.id === transferId &&
            event.transfer.status === 'cancelled'
          )
            cancelledWhileFolderExists = existsSync(folder);
        },
        beforeCatalogWrite: async (_scope, snapshot) => {
          // Upload bytes must exist before deletion, not just its initial record.
          const atBarrier =
            kind === 'upload'
              ? snapshot.includes('"status":"awaiting_approval"')
              : snapshot.includes('"kind":"copy"');
          if (!gated && atBarrier) {
            gated = true;
            entered.resolve();
            await release.promise;
          }
        },
      });
      await files.bind(scope);
      if (kind === 'copy') {
        const prepared = await prepareWorkspaceDestination(root, 'copied.txt');
        if (!prepared.ok) throw new Error('Destination unavailable');
        const started = files.startCopy(scope, {
          browserId: 'browser',
          downloadId: 'download',
          source: 'user',
          destinationName: 'copied.txt',
          destination: prepared.destination,
          overwrite: false,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error('Copy not started');
        transferId = started.transfer.id;
      } else {
        const source = files.downloadUploadSource(scope, 'browser', 'download');
        if (!source.ok) throw new Error('Upload source unavailable');
        const started = files.startUpload(scope, {
          browserId: 'browser',
          sources: [source.source],
          frameOrigin: 'https://example.invalid',
          topOrigin: 'https://example.invalid',
        });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error('Upload not started');
        transferId = started.transfer.id;
      }
      await entered.promise;
      const stagedPath = join(
        folder,
        'uploads',
        transferId,
        '0',
        download.fileName,
      );
      let removing: Promise<void> | undefined;
      try {
        if (kind === 'upload') {
          expect(files.get(scope, transferId)).toMatchObject({
            kind: 'upload',
            status: 'staging',
          });
          expect(await fs.readFile(stagedPath, 'utf8')).toBe('done');
        }
        removing = files.removeTask(scope);
        expect(admit(files)).toEqual({ ok: false, reason: 'fenced' });
        expect((await fs.stat(folder)).isDirectory()).toBe(true);
      } finally {
        release.resolve();
        await removing;
      }
      expect(cancelledWhileFolderExists).toBe(true);
      if (kind === 'upload')
        await expect(fs.stat(stagedPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      await files.bind(scope);
      await files.drain();
      await expect(fs.stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(join(root, 'copied.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await fs.readFile(join(root, 'source.txt'), 'utf8')).toBe('data');
    },
  );

  test('failed publication retains installed catalog and blocks further admission', async () => {
    await catalog([download]);
    const previous = await fs.readFile(join(folder, 'files.json'));
    const files = store({
      beforeCatalogWrite: () => {
        throw new Error('disk unavailable');
      },
    });
    await files.bind(scope);
    expect(await fs.readFile(join(folder, 'files.json'))).toEqual(previous);
    expect(admit(files)).toEqual({ ok: false, reason: 'unavailable' });
  });
});
