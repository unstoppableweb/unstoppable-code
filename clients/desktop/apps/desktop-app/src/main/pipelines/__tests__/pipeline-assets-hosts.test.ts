import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as FsSync from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PipelineAssetEnvironment } from '@canopy/core-runtime/node/pipeline/store';
import type { PipelinePackageResource } from '@canopy/protocol/pipelines';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getPipelineAssetsDir: (id: string): string =>
    join(mockRoot, 'local', 'pipeline-data', id, 'assets'),
  getPipelineAssetsManifestPath: (id: string): string =>
    join(mockRoot, 'local', 'pipeline-data', id, 'assets.json'),
}));

import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import {
  createPipelineAssetStore,
  type PipelineAssetStore,
} from '@canopy/core-runtime/node/pipeline/store';
import {
  createDaemonPipelineAssetEnvironment,
  DAEMON_PIPELINE_ASSETS_MODULE,
  pipelineAssetsDir,
  pipelineAssetsManifestPath,
} from '@canopy/core-runtime/node/pipeline/store/daemon';
import {
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';
import {
  installPipelineAssets,
  packageCacheBlobReader,
  pipelineAssetEnvironment,
  previewPipelineAssetChanges,
} from '../pipeline-asset-install';

/*
 * CAN-7058 S2b-1: the pipeline asset store's plan, install and preview
 * policy moved to a portable store in core-runtime. Electron main keeps its
 * module, exports and durable writes over it; the daemon gets its own
 * environment over its data root with its own durable install, used only by
 * a trusted composition. These pin that an install leaves the same files on
 * either host, and that the daemon writes them only where both
 * pipeline_definitions and pipeline_data name it.
 */

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');

const script = Buffer.from('#!/bin/sh\necho hello\n');
const notes = Buffer.from('seeded notes\n');
const sha = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

function asset(
  assetId: string,
  installMode: 'seed' | 'replace',
  entries: { path: string; bytes: Buffer; mode: 'read' | 'execute' }[],
): PipelinePackageResource {
  return {
    id: assetId,
    kind: 'file_asset',
    displayName: assetId,
    sourceLabel: 'Package',
    sourceVisibility: 'local',
    invocationKeys: [],
    dependencyResourceIds: [],
    assetId,
    installMode,
    trees: [
      {
        provider: 'codex',
        runtimeKind: 'pipeline_asset',
        rootName: assetId,
        entries: entries.map((entry) => ({
          path: entry.path,
          sha256: sha(entry.bytes),
          size: entry.bytes.length,
          mode: entry.mode,
        })),
      },
    ],
  };
}

const RESOURCES: readonly PipelinePackageResource[] = [
  asset('tools', 'replace', [
    { path: 'bin/run.sh', bytes: script, mode: 'execute' },
  ]),
  asset('docs', 'seed', [{ path: 'notes.md', bytes: notes, mode: 'read' }]),
];

const flippedDefinitions: readonly StorageOwnershipRow[] =
  STORAGE_OWNERSHIP.map(
    (row): StorageOwnershipRow =>
      row.id === 'pipeline_definitions'
        ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
        : row,
  );

/** pipeline_data as it would compile once flipped (it isn't compiled today). */
const pipelineDataRow: StorageOwnershipRow = {
  id: 'pipeline_data',
  transitionOwner: 'daemon',
  currentWriters: [],
  admittedWriters: [DAEMON_PIPELINE_ASSETS_MODULE],
  schemaVersion: 1,
  backupPolicy: 'none',
};

const BOTH: readonly StorageOwnershipRow[] = [
  ...flippedDefinitions,
  pipelineDataRow,
];
const DEFINITIONS_ONLY = flippedDefinitions;
const DATA_ONLY: readonly StorageOwnershipRow[] = [
  ...STORAGE_OWNERSHIP,
  pipelineDataRow,
];

const daemonRoot = (): string => join(mockRoot, 'daemon');
const localData = (): string => join(mockRoot, 'local', 'pipeline-data');
const packagePath = (): string => join(mockRoot, 'package');

function daemonStore(
  ownership: readonly StorageOwnershipRow[],
): PipelineAssetStore {
  return createPipelineAssetStore(
    createDaemonPipelineAssetEnvironment({
      dataRoot: daemonRoot(),
      flushDirectorySync,
      ownership,
    }),
  );
}

function stagePackage(blobs: readonly Buffer[]): void {
  mkdirSync(join(packagePath(), 'blobs'), { recursive: true });
  for (const bytes of blobs)
    writeFileSync(join(packagePath(), 'blobs', sha(bytes)), bytes);
}

/** Every file under a folder, with its bytes and permission bits. */
function tree(root: string): Record<string, { text: string; mode: number }> {
  const files: Record<string, { text: string; mode: number }> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else
        files[name] = {
          text: readFileSync(full, 'utf8'),
          mode: statSync(full).mode & 0o777,
        };
    }
  };
  if (existsSync(root)) walk(root, '');
  return files;
}

let stderr: jest.SpyInstance;

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'pipeline-assets-hosts-'));
  stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('pipeline assets on every host (CAN-7058)', () => {
  it('leaves the same files, modes and manifest after an install on either host', async () => {
    stagePackage([script, notes]);
    const local = await installPipelineAssets({
      localPipelineId: 'workflow',
      packagePath: packagePath(),
      resources: RESOURCES,
    });
    const daemon = await daemonStore(BOTH).install({
      localPipelineId: 'workflow',
      readBlob: packageCacheBlobReader(packagePath()),
      resources: RESOURCES,
    });

    expect(daemon).toEqual(local);
    const localTree = tree(join(localData(), 'workflow'));
    expect(tree(join(daemonRoot(), 'pipeline-data', 'workflow'))).toEqual(
      localTree,
    );
    expect(Object.keys(localTree).sort()).toEqual([
      'assets.json',
      'assets/docs/notes.md',
      'assets/tools/bin/run.sh',
    ]);
    if (process.platform !== 'win32')
      expect(localTree['assets/tools/bin/run.sh']?.mode).toBe(0o755);
  });

  it('previews the same changes on either host', async () => {
    stagePackage([script, notes]);
    for (const root of [
      join(localData(), 'workflow', 'assets', 'docs'),
      join(pipelineAssetsDir(daemonRoot(), 'workflow'), 'docs'),
    ]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'notes.md'), 'edited here\n');
    }
    const local = await previewPipelineAssetChanges({
      localPipelineId: 'workflow',
      resources: RESOURCES,
    });
    expect(
      await daemonStore(BOTH).preview({
        localPipelineId: 'workflow',
        resources: RESOURCES,
      }),
    ).toEqual(local);
    expect(local).toEqual([
      expect.objectContaining({ assetId: 'tools', added: ['bin/run.sh'] }),
      expect.objectContaining({ assetId: 'docs', kept: ['notes.md'] }),
    ]);
  });

  it('refuses an install over a newer manifest on either host, writing nothing', async () => {
    stagePackage([script, notes]);
    const newer = '{"version":2,"assets":{},"future":true}\n';
    const manifests = [
      join(localData(), 'workflow', 'assets.json'),
      pipelineAssetsManifestPath(daemonRoot(), 'workflow'),
    ];
    for (const file of manifests) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, newer);
    }
    const message =
      'The supporting files of this workflow were saved by a newer version of the app. Update the app and try again.';
    const beforeWrite = jest.fn(() => Promise.resolve());
    await expect(
      installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: packagePath(),
        resources: RESOURCES,
        beforeWrite,
      }),
    ).rejects.toThrow(message);
    await expect(
      daemonStore(BOTH).install({
        localPipelineId: 'workflow',
        readBlob: packageCacheBlobReader(packagePath()),
        resources: RESOURCES,
        beforeWrite,
      }),
    ).rejects.toThrow(message);
    expect(beforeWrite).not.toHaveBeenCalled();
    for (const file of manifests)
      expect(readFileSync(file, 'utf8')).toBe(newer);
    expect(existsSync(join(localData(), 'workflow', 'assets'))).toBe(false);
    expect(existsSync(pipelineAssetsDir(daemonRoot(), 'workflow'))).toBe(false);
  });

  it('writes no file or manifest when a cached file fails verification, on either host', async () => {
    stagePackage([script, notes]);
    writeFileSync(join(packagePath(), 'blobs', sha(script)), 'tampered\n');
    const message =
      'The cached package file tools/bin/run.sh failed verification. Install the automation again.';
    await expect(
      installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: packagePath(),
        resources: RESOURCES,
      }),
    ).rejects.toThrow(message);
    await expect(
      daemonStore(BOTH).install({
        localPipelineId: 'workflow',
        readBlob: packageCacheBlobReader(packagePath()),
        resources: RESOURCES,
      }),
    ).rejects.toThrow(message);
    expect(tree(join(localData(), 'workflow'))).toEqual({});
    expect(tree(join(daemonRoot(), 'pipeline-data', 'workflow'))).toEqual({});
  });

  it('writes nothing when a later cached file fails verification, on either host', async () => {
    stagePackage([script, notes]);
    writeFileSync(join(packagePath(), 'blobs', sha(notes)), 'tampered\n');
    const message =
      'The cached package file docs/notes.md failed verification. Install the automation again.';
    const beforeWrite = jest.fn(() => Promise.resolve());
    await expect(
      installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: packagePath(),
        resources: RESOURCES,
        beforeWrite,
      }),
    ).rejects.toThrow(message);
    await expect(
      daemonStore(BOTH).install({
        localPipelineId: 'workflow',
        readBlob: packageCacheBlobReader(packagePath()),
        resources: RESOURCES,
        beforeWrite,
      }),
    ).rejects.toThrow(message);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(existsSync(join(localData(), 'workflow'))).toBe(false);
    expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
  });

  it.each([
    ['a parent segment', '../escape.sh'],
    ['a nested parent segment', 'bin/../../escape.sh'],
    ['an absolute path', '/escape.sh'],
    ['a drive path', 'C:/escape.sh'],
    ['a backslash', 'bin\\..\\..\\escape.sh'],
    ['a NUL byte', 'bin/run\0.sh'],
    ['an alternate data stream colon', 'bin/run.sh:hidden'],
    ['a reserved device name', 'bin/CON'],
    ['a reserved device name with an extension', 'bin/lpt1.sh'],
    ['a reserved device folder', 'aux/run.sh'],
    ['a trailing dot', 'bin/run.sh.'],
    ['a trailing space', 'bin/run.sh '],
  ])(
    'refuses an asset file name with %s on either host, writing nothing',
    async (_label, unsafePath) => {
      stagePackage([script]);
      const resources = [
        asset('tools', 'replace', [
          { path: unsafePath, bytes: script, mode: 'execute' },
        ]),
      ];
      const beforeWrite = jest.fn(() => Promise.resolve());
      const message = 'The automation package has an unsafe file path';
      await expect(
        installPipelineAssets({
          localPipelineId: 'workflow',
          packagePath: packagePath(),
          resources,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      await expect(
        daemonStore(BOTH).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(existsSync(join(localData(), 'workflow'))).toBe(false);
      expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
      expect(readdirSync(mockRoot).sort()).toEqual(['package']);
    },
  );

  const linkCases: [string, string, 'dir' | 'file'][] = [
    ["the pipeline's data folder", '', 'dir'],
    ['the asset dir', 'assets', 'dir'],
    ["an asset's folder", 'assets/tools', 'dir'],
    ['a nested folder', 'assets/tools/bin', 'dir'],
    ['the file itself', 'assets/tools/bin/run.sh', 'file'],
  ];
  (process.platform === 'win32' ? it.skip : it).each(linkCases)(
    'refuses an install that would write through a link at %s, on either host',
    async (_label, linkAt, kind) => {
      stagePackage([script, notes]);
      const hosts = [
        { name: 'local', root: join(localData(), 'workflow') },
        {
          name: 'daemon',
          root: join(daemonRoot(), 'pipeline-data', 'workflow'),
        },
      ];
      for (const host of hosts) {
        const outside = join(mockRoot, 'outside', host.name);
        mkdirSync(outside, { recursive: true });
        const link = linkAt ? join(host.root, linkAt) : host.root;
        mkdirSync(join(link, '..'), { recursive: true });
        if (kind === 'file') {
          writeFileSync(join(outside, 'target'), 'outside\n');
          symlinkSync(join(outside, 'target'), link);
        } else {
          symlinkSync(outside, link, 'dir');
        }
      }
      const beforeWrite = jest.fn(() => Promise.resolve());
      const message =
        "This workflow's supporting files include a link, so they can't be updated safely.";
      await expect(
        installPipelineAssets({
          localPipelineId: 'workflow',
          packagePath: packagePath(),
          resources: RESOURCES,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      await expect(
        daemonStore(BOTH).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources: RESOURCES,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      expect(beforeWrite).not.toHaveBeenCalled();
      for (const host of hosts) {
        const outside = join(mockRoot, 'outside', host.name);
        expect(readdirSync(outside)).toEqual(kind === 'file' ? ['target'] : []);
        if (kind === 'file')
          expect(readFileSync(join(outside, 'target'), 'utf8')).toBe(
            'outside\n',
          );
      }
    },
  );

  it.each([
    ['case', 'bin/Run.sh', 'bin/run.sh'],
    ['Unicode normalization', 'caf\u00e9.md', 'cafe\u0301.md'],
    ['a file and a folder', 'bin', 'bin/run.sh'],
    ['the case of their folders', 'Bin/run.sh', 'bin/notes.md'],
    [
      'the Unicode normalization of their folders',
      'caf\u00e9/run.sh',
      'cafe\u0301/notes.md',
    ],
  ])(
    'refuses two package files whose names collide by %s, on either host, writing nothing',
    async (_label, first, second) => {
      stagePackage([script, notes]);
      const resources = [
        asset('tools', 'replace', [
          { path: first, bytes: script, mode: 'execute' },
          { path: second, bytes: notes, mode: 'read' },
        ]),
      ];
      const beforeWrite = jest.fn(() => Promise.resolve());
      const message = 'The automation package has';
      await expect(
        installPipelineAssets({
          localPipelineId: 'workflow',
          packagePath: packagePath(),
          resources,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      await expect(
        daemonStore(BOTH).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources,
          beforeWrite,
        }),
      ).rejects.toThrow(message);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(existsSync(join(localData(), 'workflow'))).toBe(false);
      expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
    },
  );

  const raceCases: [string, string, 'dir' | 'file'][] = [
    ['the asset dir', 'assets', 'dir'],
    ["an asset's folder", 'assets/tools', 'dir'],
    ['a nested folder', 'assets/tools/bin', 'dir'],
    ['the file itself', 'assets/tools/bin/run.sh', 'file'],
  ];
  (process.platform === 'win32' ? it.skip : it).each(raceCases)(
    'refuses a link planted at %s after verification, on either host, writing nothing through it',
    async (_label, linkAt, kind) => {
      stagePackage([script, notes]);
      const hosts = [
        { name: 'local', root: join(localData(), 'workflow') },
        {
          name: 'daemon',
          root: join(daemonRoot(), 'pipeline-data', 'workflow'),
        },
      ];
      const plant =
        (host: { name: string; root: string }) => (): Promise<void> => {
          const outside = join(mockRoot, 'outside', host.name);
          mkdirSync(outside, { recursive: true });
          const link = join(host.root, linkAt);
          mkdirSync(join(link, '..'), { recursive: true });
          if (kind === 'file') {
            writeFileSync(join(outside, 'target'), 'outside\n');
            symlinkSync(join(outside, 'target'), link);
          } else {
            symlinkSync(outside, link, 'dir');
          }
          return Promise.resolve();
        };
      const [local, daemon] = hosts;
      if (!local || !daemon) throw new Error('two hosts');
      const message =
        "This workflow's supporting files include a link, so they can't be updated safely.";
      await expect(
        installPipelineAssets({
          localPipelineId: 'workflow',
          packagePath: packagePath(),
          resources: RESOURCES,
          beforeWrite: plant(local),
        }),
      ).rejects.toThrow(message);
      await expect(
        daemonStore(BOTH).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources: RESOURCES,
          beforeWrite: plant(daemon),
        }),
      ).rejects.toThrow(message);
      for (const host of hosts) {
        const outside = join(mockRoot, 'outside', host.name);
        expect(readdirSync(outside)).toEqual(kind === 'file' ? ['target'] : []);
        if (kind === 'file')
          expect(readFileSync(join(outside, 'target'), 'utf8')).toBe(
            'outside\n',
          );
        expect(existsSync(join(host.root, 'assets.json'))).toBe(false);
        const assetsDir = join(host.root, 'assets');
        if (linkAt !== 'assets' && existsSync(assetsDir))
          expect(
            readdirSync(assetsDir).filter((name) =>
              name.startsWith('.install-'),
            ),
          ).toEqual([]);
      }
    },
  );

  (process.platform === 'win32' ? it.skip : it).each([
    ['the asset dir', 'assets'],
    ["an existing asset's folder", 'assets/tools'],
  ])(
    'writes nothing through %s when it is swapped for a link just before the files move, on either host',
    async (_label, swapped) => {
      stagePackage([script]);
      const resources = [
        asset('tools', 'replace', [
          { path: 'run.sh', bytes: script, mode: 'execute' },
        ]),
      ];
      const swapBeforeMove = (
        environment: PipelineAssetEnvironment,
        root: string,
        outside: string,
      ): PipelineAssetEnvironment => {
        let swappedOnce = false;
        return {
          ...environment,
          moveAssetFile: (id, from, to) => {
            if (!swappedOnce) {
              swappedOnce = true;
              const target = join(root, swapped);
              mkdirSync(outside, { recursive: true });
              renameSync(target, `${target}-moved`);
              symlinkSync(outside, target, 'dir');
            }
            return environment.moveAssetFile(id, from, to);
          },
        };
      };
      const hosts = [
        {
          name: 'local',
          root: join(localData(), 'workflow'),
          environment: pipelineAssetEnvironment,
          readBlob: packageCacheBlobReader(packagePath()),
        },
        {
          name: 'daemon',
          root: join(daemonRoot(), 'pipeline-data', 'workflow'),
          environment: createDaemonPipelineAssetEnvironment({
            dataRoot: daemonRoot(),
            flushDirectorySync,
            ownership: BOTH,
          }),
          readBlob: packageCacheBlobReader(packagePath()),
        },
      ];
      for (const host of hosts) {
        const outside = join(mockRoot, 'outside', host.name);
        // A first install leaves the asset's folder in place.
        await createPipelineAssetStore(host.environment).install({
          localPipelineId: 'workflow',
          readBlob: host.readBlob,
          resources,
        });
        await expect(
          createPipelineAssetStore(
            swapBeforeMove(host.environment, host.root, outside),
          ).install({
            localPipelineId: 'workflow',
            readBlob: host.readBlob,
            resources,
          }),
        ).rejects.toThrow();
        expect(readdirSync(outside)).toEqual([]);
      }
    },
  );

  it('retries a final move that hits a transient sharing violation, on either host', async () => {
    stagePackage([script]);
    const resources = [
      asset('tools', 'replace', [
        { path: 'run.sh', bytes: script, mode: 'execute' },
      ]),
    ];
    const busy = (): Error =>
      Object.assign(new Error('EBUSY: resource busy or locked'), {
        code: 'EBUSY',
      });
    const isFinalMove = (source: unknown, target: unknown): boolean =>
      String(source).includes('.install-') &&
      String(target).endsWith(join('tools', 'run.sh'));
    const fsPromises =
      jest.requireActual<typeof FsPromises>('node:fs/promises');
    const fsSync = jest.requireActual<typeof FsSync>('node:fs');
    const realRename = fsPromises.rename;
    const realRenameSync = fsSync.renameSync;
    let asyncFailures = 0;
    let syncFailures = 0;
    const asyncSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation((source, target) => {
        if (isFinalMove(source, target) && asyncFailures === 0) {
          asyncFailures += 1;
          return Promise.reject(busy());
        }
        return realRename(source, target);
      });
    const syncSpy = jest
      .spyOn(fsSync, 'renameSync')
      .mockImplementation((source, target) => {
        if (isFinalMove(source, target) && syncFailures === 0) {
          syncFailures += 1;
          throw busy();
        }
        realRenameSync(source, target);
      });
    try {
      await installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: packagePath(),
        resources,
      });
      await daemonStore(BOTH).install({
        localPipelineId: 'workflow',
        readBlob: packageCacheBlobReader(packagePath()),
        resources,
      });
    } finally {
      asyncSpy.mockRestore();
      syncSpy.mockRestore();
    }
    expect([asyncFailures, syncFailures]).toEqual([1, 1]);
    for (const root of [
      join(localData(), 'workflow'),
      join(daemonRoot(), 'pipeline-data', 'workflow'),
    ])
      expect(Object.keys(tree(root)).sort()).toEqual([
        'assets.json',
        'assets/tools/run.sh',
      ]);
  });

  it('refuses a file whose recorded hash is not a sha256, without reading it, on either host', async () => {
    stagePackage([script]);
    const resources = [
      {
        ...asset('tools', 'replace', [
          { path: 'run.sh', bytes: script, mode: 'execute' },
        ]),
        trees: [
          {
            provider: 'codex' as const,
            runtimeKind: 'pipeline_asset' as const,
            rootName: 'tools',
            entries: [
              {
                path: 'run.sh',
                sha256: `../blobs/${sha(script)}`,
                size: script.length,
                mode: 'execute' as const,
              },
            ],
          },
        ],
      },
    ];
    const message =
      'The cached package file tools/run.sh failed verification. Install the automation again.';
    await expect(
      installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: packagePath(),
        resources,
      }),
    ).rejects.toThrow(message);
    const readBlob = jest.fn(packageCacheBlobReader(packagePath()));
    await expect(
      daemonStore(BOTH).install({
        localPipelineId: 'workflow',
        readBlob,
        resources,
      }),
    ).rejects.toThrow(message);
    expect(readBlob).not.toHaveBeenCalled();
    expect(existsSync(join(localData(), 'workflow'))).toBe(false);
    expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
  });

  it.each([
    ['a parent segment', '../tools'],
    ['a path separator', 'tools/bin'],
  ])(
    'refuses an asset id with %s on either host, writing nothing',
    async (_label, unsafeId) => {
      stagePackage([script]);
      const resources = [
        asset(unsafeId, 'replace', [
          { path: 'run.sh', bytes: script, mode: 'execute' },
        ]),
      ];
      const message = 'The automation package has an invalid file resource.';
      await expect(
        installPipelineAssets({
          localPipelineId: 'workflow',
          packagePath: packagePath(),
          resources,
        }),
      ).rejects.toThrow(message);
      await expect(
        daemonStore(BOTH).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources,
        }),
      ).rejects.toThrow(message);
      expect(existsSync(join(localData(), 'workflow'))).toBe(false);
      expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
      expect(readdirSync(mockRoot).sort()).toEqual(['package']);
    },
  );

  it.each([
    ['the compiled rows', STORAGE_OWNERSHIP],
    ['only pipeline_definitions flipped', DEFINITIONS_ONLY],
    ['only pipeline_data flipped', DATA_ONLY],
  ])(
    "refuses the daemon's install under %s before anything is written",
    async (_label, ownership) => {
      stagePackage([script, notes]);
      const beforeWrite = jest.fn(() => Promise.resolve());
      await expect(
        daemonStore(ownership).install({
          localPipelineId: 'workflow',
          readBlob: packageCacheBlobReader(packagePath()),
          resources: RESOURCES,
          beforeWrite,
        }),
      ).rejects.toMatchObject({ name: 'StorageWriteRefusedError' });
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
    },
  );

  it('refuses a pipeline id that is not a valid id on the daemon, as Electron main does', async () => {
    await expect(
      daemonStore(BOTH).install({
        localPipelineId: '../escape',
        readBlob: packageCacheBlobReader(packagePath()),
        resources: RESOURCES,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(mockRoot, 'escape'))).toBe(false);
    expect(existsSync(join(daemonRoot(), 'pipeline-data'))).toBe(false);
  });

  it('is composed by no production daemon module', () => {
    const sources = [
      'apps/core-daemon/src/daemon.ts',
      'apps/core-daemon/src/main.ts',
      'apps/core-daemon/src/execution-hosts.ts',
      'apps/core-daemon/src/pipelines.ts',
    ].map((file) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
    for (const source of sources)
      expect(source).not.toContain('createDaemonPipelineAssetEnvironment');
  });
});
