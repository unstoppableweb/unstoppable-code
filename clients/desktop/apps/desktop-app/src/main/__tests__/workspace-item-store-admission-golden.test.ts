/**
 * CAN-4735: Electron main's workspace-item store writes pass the storage
 * ownership admission. While a store stays legacy every write goes ahead as
 * before; with the owner set to the daemon (a test-only override of the
 * runtime ownership table) each write is refused with a typed answer before
 * the state file is read for the write, copied or replaced. Reads stay open.
 * - file annotations: every save, append, dismiss and reply runs through the
 *   engine's one read-modify-write, which the desktop host admits. A write
 *   makes its folder chain durable up to the data root before installing,
 *   and a folder flush that fails after the install answers outcome unknown.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as PathsModule from '../lib/paths';

jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  return { ...actual, STORAGE_OWNERSHIP: [...actual.STORAGE_OWNERSHIP] };
});

/** The real file system, recording state reads and folder flushes. */
const mockFs = {
  reads: [] as string[],
  flushed: [] as string[],
  folderOpens: [] as Array<{ folder: string; flags: string }>,
  failFlushOf: undefined as string | undefined,
  /** The host's own platform, before a case forces win32. */
  hostPlatform: process.platform,
};

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> => {
      if (typeof args[0] === 'string') mockFs.reads.push(args[0]);
      return actual.readFile(...args);
    },
    open: async (
      ...args: Parameters<typeof actual.open>
    ): ReturnType<typeof actual.open> => {
      const [folder, flags] = args;
      // A folder flush opens 'r', or 'r+' on Windows; state files open 'wx'.
      if ((flags !== 'r' && flags !== 'r+') || typeof folder !== 'string')
        return actual.open(...args);
      mockFs.folderOpens.push({ folder, flags });
      // Only Windows opens a folder read-write; a forced win32 elsewhere
      // reads it, so the flush still reaches the real folder.
      const handle = await actual.open(
        folder,
        mockFs.hostPlatform === 'win32' ? flags : 'r',
      );
      const sync = handle.sync.bind(handle);
      handle.sync = (): Promise<void> => {
        if (mockFs.failFlushOf === folder) {
          return Promise.reject(
            Object.assign(new Error('EIO: flush failed'), { code: 'EIO' }),
          );
        }
        mockFs.flushed.push(folder);
        return sync();
      };
      return handle;
    },
  };
});

const mockTempDir = mkdtempSync(path.join(tmpdir(), 'item-store-admission-'));

jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getDataDir: (): string => mockTempDir,
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string =>
    path.join(
      mockTempDir,
      'workspaces',
      projectId,
      'worktree-data',
      worktreeId,
      'file-annotations.json',
    ),
}));

jest.mock('../lib/file-browser-roots', () => ({
  getFileBrowserRoots: (): Promise<unknown> =>
    Promise.resolve({
      roots: [
        { repoId: 'root', absolutePath: path.join(mockTempDir, 'checkout') },
      ],
    }),
}));

import {
  StorageOutcomeUnknownError,
  StorageWriteRefusedError,
} from '@canopy/core-runtime/storage';
import { CanopyOperationError } from '@canopy/core-runtime';
import { ANNOTATION_ERROR_CODES } from '@canopy/protocol/canopy-core';
import { getDesktopAnnotationOperations } from '../canopy-runtime/core-annotation-adapter';

/** The typed answer to an installed write whose folder flush failed. */
async function expectOutcomeUnknown(write: Promise<unknown>): Promise<void> {
  const error = await write.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error('Expected a typed annotation error');
  expect(error.payload).toMatchObject({
    code: ANNOTATION_ERROR_CODES.OUTCOME_UNKNOWN,
    details: { reason: 'OUTCOME_UNKNOWN', effects: 'unknown' },
    retry: { kind: 'never' },
  });
  expect(error.runtimeCause).toBeInstanceOf(StorageOutcomeUnknownError);
  expect(error.runtimeCause).toMatchObject({
    stage: 'directory_flush',
    namespaceId: 'file_annotations',
  });
}

type Store = 'file_annotations';

/** The daemon owns `stores`; every other row is as compiled. */
function setDaemonOwned(stores: readonly Store[]): void {
  const compiled = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  ).STORAGE_OWNERSHIP;
  const rows = jest.requireMock<{
    STORAGE_OWNERSHIP: CoreStorage.StorageOwnershipRow[];
  }>('@canopy/core-runtime/storage').STORAGE_OWNERSHIP;
  compiled.forEach((row, index) => {
    rows[index] = stores.some((store) => store === row.id)
      ? { ...row, transitionOwner: 'daemon', currentWriters: ['daemon'] }
      : row;
  });
}

const file = { kind: 'root', rootId: 'root', path: 'src/a.ts' } as const;
const annotation = {
  id: 'note-1',
  repoId: 'root',
  filePath: 'src/a.ts',
  side: 'new',
  lineStart: 1,
  lineEnd: 1,
  kind: 'context',
  title: 'First note',
  body: 'Kept across the flip.',
} as const;

function scopeFor(worktreeId: string): {
  projectId: string;
  worktreeId: string;
} {
  return { projectId: `project-${worktreeId}`, worktreeId };
}

function statePathOf(scope: { projectId: string; worktreeId: string }): string {
  return path.join(
    mockTempDir,
    'workspaces',
    scope.projectId,
    'worktree-data',
    scope.worktreeId,
    'file-annotations.json',
  );
}

/** A fresh state file holding `annotation`, written by the legacy writer. */
async function seed(worktreeId: string): Promise<{
  scope: { projectId: string; worktreeId: string };
  statePath: string;
}> {
  const scope = scopeFor(worktreeId);
  const statePath = statePathOf(scope);
  rmSync(statePath, { force: true });
  await getDesktopAnnotationOperations().appendAnnotations({
    scope,
    file,
    annotations: [annotation],
    commentThreads: [],
  });
  return { scope, statePath };
}

afterEach(() => {
  setDaemonOwned([]);
  mockFs.failFlushOf = undefined;
});
afterAll(() => rmSync(mockTempDir, { recursive: true, force: true }));

describe('file annotation writes (file_annotations)', () => {
  it('writes while the store is legacy', async () => {
    const { statePath } = await seed('legacy');
    expect(readFileSync(statePath, 'utf8')).toContain('First note');
  });

  it('refuses every write once the daemon owns the store, without reading or changing the file', async () => {
    const { scope, statePath } = await seed('refused');
    const operations = getDesktopAnnotationOperations();
    const before = readFileSync(statePath, 'utf8');
    setDaemonOwned(['file_annotations']);
    mockFs.reads.length = 0;

    const writes = [
      operations.appendAnnotations({
        scope,
        file,
        annotations: [{ ...annotation, id: 'note-2' }],
        commentThreads: [],
      }),
      operations.saveDocument({
        scope,
        document: { file, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      }),
      operations.dismissAnnotation({ scope, file, annotationId: 'note-1' }),
    ];
    for (const write of writes) {
      await expect(write).rejects.toBeInstanceOf(StorageWriteRefusedError);
      await expect(write).rejects.toMatchObject({
        namespaceId: 'file_annotations',
        writer: 'electron_main',
        reason: 'daemon_owned',
      });
    }
    expect(mockFs.reads.filter((read) => read === statePath)).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('still reads once the daemon owns the store', async () => {
    const { scope } = await seed('read');
    setDaemonOwned(['file_annotations']);
    const { document } = await getDesktopAnnotationOperations().getDocument({
      scope,
      file,
    });
    expect(document.annotations.map((entry) => entry.id)).toEqual(['note-1']);
  });
});

describe('file annotation durability (file_annotations)', () => {
  it('flushes every new folder up to the data root on the first write', async () => {
    const scope = scopeFor('first-write');
    const leaf = path.dirname(statePathOf(scope));
    mockFs.flushed.length = 0;
    await getDesktopAnnotationOperations().appendAnnotations({
      scope,
      file,
      annotations: [annotation],
      commentThreads: [],
    });
    const project = path.join(mockTempDir, 'workspaces', scope.projectId);
    expect(mockFs.flushed).toEqual(
      expect.arrayContaining([
        path.join(mockTempDir, 'workspaces'),
        project,
        path.join(project, 'worktree-data'),
        leaf,
      ]),
    );
  });

  it('answers outcome unknown when the folder flush after the install fails', async () => {
    const { scope, statePath } = await seed('flush-fails');
    mockFs.failFlushOf = path.dirname(statePath);
    const write = getDesktopAnnotationOperations().appendAnnotations({
      scope,
      file,
      annotations: [{ ...annotation, id: 'note-2', title: 'Installed note' }],
      commentThreads: [],
    });
    await expectOutcomeUnknown(write);
    expect(readFileSync(statePath, 'utf8')).toContain('Installed note');
  });

  it('flushes on Windows through a read-write handle, and a failed flush there answers outcome unknown', async () => {
    const { scope, statePath } = await seed('windows');
    const folder = path.dirname(statePath);
    const operations = getDesktopAnnotationOperations();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      mockFs.folderOpens.length = 0;
      await operations.appendAnnotations({
        scope,
        file,
        annotations: [{ ...annotation, id: 'note-2' }],
        commentThreads: [],
      });
      expect(mockFs.folderOpens).toContainEqual({ folder, flags: 'r+' });

      mockFs.failFlushOf = folder;
      const write = operations.appendAnnotations({
        scope,
        file,
        annotations: [{ ...annotation, id: 'note-3', title: 'Windows note' }],
        commentThreads: [],
      });
      await expectOutcomeUnknown(write);
      expect(readFileSync(statePath, 'utf8')).toContain('Windows note');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
