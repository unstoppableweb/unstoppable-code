import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type * as SyncFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pipelinePaths from '@canopy/execution-engine/pipelines/config-paths';
import {
  getStoredPipelineText,
  listStoredPipelines,
  saveStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import type { InstallReceipt } from '@canopy/execution-engine/lib/resource-context-policy';
import type { PipelinePackageInstallRecordV1 } from '@canopy/execution-engine/types/pipeline';

let mockRoot = '';
let mockUnstatableDocument = '';
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof SyncFs>('node:fs');
  return {
    ...actual,
    statSync: (
      ...args: Parameters<typeof actual.statSync>
    ): ReturnType<typeof actual.statSync> => {
      if (args[0] === mockUnstatableDocument)
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actual.statSync(...args);
    },
  };
});
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => mockRoot,
  getPipelineInstallIntentsDir: (): string => `${mockRoot}/intents`,
  getPipelinePackageInstallStorePath: (): string => `${mockRoot}/installs.json`,
  getPipelineAssetsDir: (id: string): string =>
    `${mockRoot}/pipeline-data/${id}/assets`,
  getPipelineAssetsManifestPath: (id: string): string =>
    `${mockRoot}/pipeline-data/${id}/assets.json`,
}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemLocalUninstall: jest.fn(),
}));
jest.mock('../pipeline-local-metadata-store', () => ({
  deleteUserPipelineLocalMetadata: jest.fn(),
}));

import { recordSharedItemLocalUninstall } from '../../canopy-cloud/shared-item-subscriptions';
import { createResourceInstallReceiptsStore } from '../../lib/resource-install-receipts';
import { deleteUserPipelineLocalMetadata } from '../pipeline-local-metadata-store';
import * as installStore from '../pipeline-package-install-store';
import {
  listPipelinePackageInstalls,
  upsertPipelinePackageInstall,
} from '../pipeline-package-install-store';
import * as pipelineStore from '@canopy/execution-engine/pipelines/store';
import * as logging from '../../lib/main-process-logging';
import { installPipelineAssets } from '../pipeline-asset-install';
import {
  beginPipelineInstallIntent,
  isPipelineDefinitionClaimed,
  recoverInterruptedPipelineInstalls,
  type PipelineInstallIntent,
} from '../pipeline-install-intents';

const ACCOUNT = 'account-1';
const REMOTE = 'remote-1';
const DIGEST = `pp:v1:${'a'.repeat(43)}`;
const OLD_DIGEST = `pp:v1:${'b'.repeat(43)}`;

function yaml(name: string): string {
  return `name: ${name}\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo ${name}\n`;
}

function save(id: string, text: string, create: boolean): void {
  const saved = saveStoredPipeline(
    {
      id,
      name: 'Installed',
      description: '',
      icon: '',
      content: parsePipelineText(text),
      rawContent: text,
    },
    create ? { id } : undefined,
  );
  if (!saved.success) throw new Error(saved.error);
}

function record(
  id: string,
  text: string,
  digest = DIGEST,
): PipelinePackageInstallRecordV1 {
  return {
    localPipelineId: id,
    originExternalId: REMOTE,
    pipelineContentHash: hashPipelinePackageYaml(text),
    distributionMode: 'package',
    packageDigest: digest,
    installedAt: new Date().toISOString(),
  };
}

function receipt(localIds: string[], text: string): InstallReceipt {
  return {
    family: 'pipelines',
    remoteId: REMOTE,
    localResourceIds: localIds,
    shareScope: 'team',
    ownerContext: {
      kind: 'organization',
      organizationId: '33333333-3333-4333-8333-333333333333',
    },
    hash: hashPipelinePackageYaml(text),
    authorizedAt: new Date().toISOString(),
  };
}

const receipts = (): ReturnType<typeof createResourceInstallReceiptsStore> =>
  createResourceInstallReceiptsStore(ACCOUNT);

async function installRecordFor(
  id: string,
): Promise<PipelinePackageInstallRecordV1 | undefined> {
  return (await listPipelinePackageInstalls(`${mockRoot}/installs.json`)).find(
    (row) => row.localPipelineId === id,
  );
}

async function intentFiles(): Promise<string[]> {
  try {
    return await readdir(`${mockRoot}/intents`);
  } catch {
    return [];
  }
}

/**
 * One install as an ordered list of steps, each note before its write, so a
 * test can stop after any of them as an exit would.
 */
function installSteps(
  intent: PipelineInstallIntent,
  id: string,
  text: string,
  change: 'created' | 'replaced',
): Array<() => Promise<void>> {
  const next = receipt([id], text);
  return [
    () =>
      intent.noteDefinition({
        definitionId: id,
        change,
        contentHash: hashPipelinePackageYaml(text),
      }),
    () => Promise.resolve(save(id, text, change === 'created')),
    async () => {
      await intent.noteReceipt(id, {
        accountId: ACCOUNT,
        receipt: next,
        previous: await receipts().find('pipelines', REMOTE),
      });
    },
    () => receipts().record(next),
    () => intent.noteInstallRecord(id, record(id, text)),
    () =>
      upsertPipelinePackageInstall(
        `${mockRoot}/installs.json`,
        record(id, text),
      ),
  ];
}

describe('pipeline install crash qualification (CAN-5633)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockUnstatableDocument = '';
    mockRoot = await mkdtemp(join(tmpdir(), 'pipeline-install-intents-'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelinesDir')
      .mockReturnValue(join(mockRoot, 'pipelines'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
      .mockReturnValue(join(mockRoot, 'pipelines', 'index.json'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(mockRoot, { recursive: true, force: true });
  });

  it('refuses snapshot publication for an unreadable indexed alternate document', async () => {
    const id = 'alternate-unreadable';
    save(id, yaml('Stored'), true);
    const dir = pipelinePaths.getUserPipelinesDir();
    const alternate = join(dir, 'alternate.yaml');
    const entry = pipelineStore.getStoredPipelineIndexEntry(id, 'user');
    if (!entry) throw new Error('Missing seeded pipeline');
    await rename(join(dir, `${id}.yaml`), alternate);
    const indexPath = pipelinePaths.getUserPipelineIndexPath();
    await writeFile(
      indexPath,
      JSON.stringify({
        pipelines: [{ ...entry, filename: 'alternate.yaml' }],
      }),
    );
    mockUnstatableDocument = alternate;
    const { readSharedContainerUserPipeline } =
      await import('../../shared-containers/publish/capability-usage');
    await expect(readSharedContainerUserPipeline(id)).rejects.toThrow(
      'The user pipeline index is unreadable',
    );
  });

  it('refuses snapshot publication for an indexed directory target', async () => {
    const id = 'directory-target';
    save(id, yaml('Stored'), true);
    const entry = pipelineStore.getStoredPipelineIndexEntry(id, 'user');
    if (!entry) throw new Error('Missing seeded pipeline');
    const dir = pipelinePaths.getUserPipelinesDir();
    await rm(join(dir, `${id}.yaml`));
    await mkdir(join(dir, 'alternate-directory'));
    await writeFile(
      pipelinePaths.getUserPipelineIndexPath(),
      JSON.stringify({
        pipelines: [{ ...entry, filename: 'alternate-directory' }],
      }),
    );
    const { readSharedContainerUserPipeline } =
      await import('../../shared-containers/publish/capability-usage');
    await expect(readSharedContainerUserPipeline(id)).rejects.toThrow(
      'The user pipeline index is unreadable',
    );
  });

  it('retains an unlisted file and its matching intent while the index is damaged', async () => {
    const id = 'damaged-unlisted';
    const text = '{not yaml';
    const intent = await beginPipelineInstallIntent('shared');
    await intent.noteDefinition({
      definitionId: id,
      change: 'created',
      contentHash: hashPipelinePackageYaml(text),
    });
    const dir = pipelinePaths.getUserPipelinesDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.yaml`);
    await writeFile(file, text);
    await writeFile(pipelinePaths.getUserPipelineIndexPath(), '{broken');
    const remove = jest.spyOn(
      pipelineStore,
      'removeUnlistedStoredPipelineDocument',
    );
    await recoverInterruptedPipelineInstalls();
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(await intentFiles()).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    expect(
      await readFile(pipelinePaths.getUserPipelineIndexPath(), 'utf8'),
    ).toBe('{broken');
  });

  const recoveryChanges: readonly ('created' | 'replaced')[] = [
    'created',
    'replaced',
  ];
  it.each(recoveryChanges)(
    'recovers a %s install through the rebuilt damaged index view',
    async (change) => {
      const id = `damaged-index-${change}`;
      const before = yaml('Before');
      if (change === 'replaced') save(id, before, true);
      const text = yaml('Installed');
      const intent = await beginPipelineInstallIntent('shared');
      for (const step of installSteps(intent, id, text, change)) await step();
      await writeFile(pipelinePaths.getUserPipelineIndexPath(), '{broken');
      await recoverInterruptedPipelineInstalls();
      expect(await intentFiles()).toEqual([]);
      if (change === 'created')
        expect(getStoredPipelineText(id).success).toBe(false);
      else expect(getStoredPipelineText(id).data).toBe(before);
    },
  );

  it.each(['name', 'createdAt', 'updatedAt'])(
    'refuses snapshot publication when indexed metadata lacks %s',
    async (field) => {
      const id = 'malformed-metadata';
      save(id, yaml('Stored'), true);
      const entry = pipelineStore.getStoredPipelineIndexEntry(id, 'user');
      if (!entry) throw new Error('Missing seeded pipeline');
      const malformed: Record<string, unknown> = { ...entry };
      delete malformed[field];
      await writeFile(
        pipelinePaths.getUserPipelineIndexPath(),
        JSON.stringify({ pipelines: [malformed] }),
      );
      const { readSharedContainerUserPipeline } =
        await import('../../shared-containers/publish/capability-usage');
      await expect(readSharedContainerUserPipeline(id)).rejects.toThrow(
        'The user pipeline index is unreadable',
      );
    },
  );

  it.each([{ version: 2, pipelines: null }, { version: 2 }])(
    'refuses snapshot publication for a malformed newer index %j',
    async (index) => {
      const id = 'newer-malformed';
      save(id, yaml('Stored'), true);
      const bytes = JSON.stringify(index);
      await writeFile(pipelinePaths.getUserPipelineIndexPath(), bytes);
      expect(pipelineStore.readStoredPipelineIndexStatus()).toBe('newer');
      const { readSharedContainerUserPipeline } =
        await import('../../shared-containers/publish/capability-usage');
      await expect(readSharedContainerUserPipeline(id)).rejects.toThrow(
        'The user pipeline index is unreadable',
      );
      expect(
        await readFile(pipelinePaths.getUserPipelineIndexPath(), 'utf8'),
      ).toBe(bytes);
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'rolls back a new install that exited after step %i at the next start',
    async (completed) => {
      const id = 'created-1';
      const text = yaml('Created');
      const intent = await beginPipelineInstallIntent('shared');
      for (const step of installSteps(intent, id, text, 'created').slice(
        0,
        completed,
      ))
        await step();

      await recoverInterruptedPipelineInstalls();

      expect(getStoredPipelineText(id).success).toBe(false);
      expect(await installRecordFor(id)).toBeUndefined();
      expect(
        (await receipts().find('pipelines', REMOTE))?.localResourceIds ?? [],
      ).not.toContain(id);
      expect(await intentFiles()).toEqual([]);
      if (completed >= 2) {
        expect(deleteUserPipelineLocalMetadata).toHaveBeenCalledWith(id);
        expect(recordSharedItemLocalUninstall).toHaveBeenCalledWith({
          kind: 'pipeline',
          localId: id,
        });
      }
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'restores a replaced definition, its record and its receipt after an exit at step %i',
    async (completed) => {
      const id = 'replaced-1';
      const before = yaml('Before');
      const after = yaml('After');
      save(id, before, true);
      await upsertPipelinePackageInstall(
        `${mockRoot}/installs.json`,
        record(id, before, OLD_DIGEST),
      );
      await receipts().record(receipt([id], before));
      const intent = await beginPipelineInstallIntent('shared');
      for (const step of installSteps(intent, id, after, 'replaced').slice(
        0,
        completed,
      ))
        await step();

      await recoverInterruptedPipelineInstalls();

      expect(getStoredPipelineText(id).data).toBe(before);
      expect(await installRecordFor(id)).toEqual(
        expect.objectContaining({
          pipelineContentHash: hashPipelinePackageYaml(before),
          packageDigest: OLD_DIGEST,
        }),
      );
      expect(
        (await receipts().find('pipelines', REMOTE))?.localResourceIds,
      ).toEqual([id]);
      expect(deleteUserPipelineLocalMetadata).not.toHaveBeenCalled();
      expect(await intentFiles()).toEqual([]);
    },
  );

  async function seedReplaced(id: string, before: string): Promise<void> {
    save(id, before, true);
    await upsertPipelinePackageInstall(
      `${mockRoot}/installs.json`,
      record(id, before, OLD_DIGEST),
    );
    await receipts().record(receipt([id], before));
  }

  it('restores the receipt of a rolled-back replacement, so the organization content check still knows the restored copy', async () => {
    const id = 'replaced-org';
    const before = yaml('Before');
    await seedReplaced(id, before);
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(intent, id, yaml('After'), 'replaced'))
      await step();

    await intent.rollBack();

    expect(getStoredPipelineText(id).data).toBe(before);
    expect((await receipts().find('pipelines', REMOTE))?.hash).toBe(
      hashPipelinePackageYaml(before),
    );
    // What assertNewPipelineShareContent reads to refuse sharing this
    // organization's workflow into another context (CAN-5678).
    expect(
      await receipts().listOrganizationContentOwners(
        'pipelines',
        hashPipelinePackageYaml(before),
      ),
    ).toEqual(['33333333-3333-4333-8333-333333333333']);
  });

  it('keeps a receipt a later install recorded after the rolled-back replacement', async () => {
    const id = 'replaced-later';
    await seedReplaced(id, yaml('Before'));
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(
      intent,
      id,
      yaml('After'),
      'replaced',
    ).slice(0, 4))
      await step();
    const later = yaml('Later');
    await receipts().record(receipt([id], later));

    await intent.rollBack();

    expect((await receipts().find('pipelines', REMOTE))?.hash).toBe(
      hashPipelinePackageYaml(later),
    );
  });

  it('keeps a definition changed after the install wrote it, with its record and receipt', async () => {
    const id = 'edited-1';
    const text = yaml('Installed');
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(intent, id, text, 'created')) await step();
    save(id, yaml('Edited'), false);

    await recoverInterruptedPipelineInstalls();

    expect(getStoredPipelineText(id).data).toBe(yaml('Edited'));
    expect(await installRecordFor(id)).toBeDefined();
    expect(
      (await receipts().find('pipelines', REMOTE))?.localResourceIds,
    ).toEqual([id]);
    expect(await intentFiles()).toEqual([]);
  });

  it('keeps a definition it cannot read, with its record, receipt and intent', async () => {
    const id = 'unreadable-1';
    const text = yaml('Unreadable');
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(intent, id, text, 'created')) await step();
    jest
      .spyOn(pipelineStore, 'inspectStoredPipelineDocument')
      .mockReturnValue({ kind: 'unreadable', message: 'EACCES' });

    await recoverInterruptedPipelineInstalls();

    jest.mocked(pipelineStore.inspectStoredPipelineDocument).mockRestore();
    expect(getStoredPipelineText(id).data).toBe(text);
    expect(await installRecordFor(id)).toBeDefined();
    expect(
      (await receipts().find('pipelines', REMOTE))?.localResourceIds,
    ).toEqual([id]);
    expect(await intentFiles()).toHaveLength(1);
  });

  it('removes the document of a save an exit interrupted before the store listed it', async () => {
    const id = 'unlisted-1';
    const text = yaml('Unlisted');
    const intent = await beginPipelineInstallIntent('shared');
    await intent.noteDefinition({
      definitionId: id,
      change: 'created',
      contentHash: hashPipelinePackageYaml(text),
    });
    await mkdir(join(mockRoot, 'pipelines'), { recursive: true });
    await writeFile(join(mockRoot, 'pipelines', `${id}.yaml`), text);

    await recoverInterruptedPipelineInstalls();

    expect(await readdir(join(mockRoot, 'pipelines'))).not.toContain(
      `${id}.yaml`,
    );
    expect(await intentFiles()).toEqual([]);
  });

  it('keeps a definition saved while the rollback looks up its record', async () => {
    const id = 'saved-during-1';
    const text = yaml('Installed');
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(intent, id, text, 'created').slice(0, 2))
      await step();
    const lookup = installStore.findCapabilityPackageInstallByOwner;
    jest
      .spyOn(installStore, 'findCapabilityPackageInstallByOwner')
      .mockImplementationOnce(async (...args) => {
        save(id, yaml('Edited meanwhile'), false);
        return lookup(...args);
      });

    await recoverInterruptedPipelineInstalls();

    expect(getStoredPipelineText(id).data).toBe(yaml('Edited meanwhile'));
  });

  it('finishes removing a copy whose document an interrupted rollback already deleted', async () => {
    const id = 'half-deleted-1';
    const text = yaml('Half deleted');
    const intent = await beginPipelineInstallIntent('shared');
    for (const step of installSteps(intent, id, text, 'created').slice(0, 2))
      await step();
    await rm(join(mockRoot, 'pipelines', `${id}.yaml`));

    await recoverInterruptedPipelineInstalls();

    expect(
      (listStoredPipelines().data ?? []).some((entry) => entry.id === id),
    ).toBe(false);
    expect(deleteUserPipelineLocalMetadata).toHaveBeenCalledWith(id);
    expect(await intentFiles()).toEqual([]);
  });

  it.each(['legacy', 'durable'])(
    'removes %s asset temporaries left by an exit before rename',
    async (format) => {
      const id = 'asset-temporary';
      const text = yaml('Existing');
      save(id, text, true);
      const intent = await beginPipelineInstallIntent('automation');
      await intent.noteDefinition({
        definitionId: id,
        change: 'linked',
        contentHash: hashPipelinePackageYaml(text),
      });
      await intent.noteAssetFiles(id, {
        files: [
          { path: 'script/run.sh', sha256: 'a'.repeat(64), executable: true },
        ],
        directories: ['.', 'script'],
        createdDirectories: ['.', 'script'],
        manifest: { version: 1, assets: {} },
        manifestText: '{"version":1,"assets":{}}\n',
        stagingName: `.install-${randomUUID()}`,
      });
      const data = join(mockRoot, 'pipeline-data', id);
      const script = join(data, 'assets', 'script');
      await mkdir(script, { recursive: true });
      const temporary = (name: string): string =>
        format === 'durable'
          ? `.${name}.${process.pid}.${randomUUID()}.tmp`
          : `${name}.${randomUUID()}.tmp`;
      await writeFile(join(script, temporary('run.sh')), 'partial script');
      await writeFile(join(data, temporary('assets.json')), 'partial manifest');

      await recoverInterruptedPipelineInstalls();

      expect(await readdir(data)).toEqual([]);
      expect(getStoredPipelineText(id).data).toBe(text);
      expect(await intentFiles()).toEqual([]);
    },
  );

  const staging = (): string => `.install-${randomUUID()}`;

  /**
   * A linked definition whose install noted `files`, none there before, and
   * `stage`, the staging folder name its install recorded.
   */
  async function noteLinkedInstall(
    id: string,
    files: Array<{ path: string; bytes: string }>,
  ): Promise<{
    text: string;
    data: string;
    intent: PipelineInstallIntent;
    stage: string;
  }> {
    const text = yaml('Existing');
    const stage = staging();
    save(id, text, true);
    const intent = await beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: id,
      change: 'linked',
      contentHash: hashPipelinePackageYaml(text),
    });
    const folders = new Set<string>(['.']);
    for (const file of files) {
      const parts = file.path.split('/').slice(0, -1);
      for (let index = 1; index <= parts.length; index += 1)
        folders.add(parts.slice(0, index).join('/'));
    }
    await intent.noteAssetFiles(id, {
      files: files.map((file) => ({
        path: file.path,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        executable: false,
      })),
      directories: [...folders],
      createdDirectories: [...folders],
      manifest: { version: 1, assets: {} },
      manifestText: '{"version":1,"assets":{}}\n',
      stagingName: stage,
    });
    return { text, data: join(mockRoot, 'pipeline-data', id), intent, stage };
  }

  it('removes the staging folders an exit left before any file moved into place (CAN-7058)', async () => {
    const id = 'staged-before-move';
    const {
      text,
      data,
      stage: name,
    } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
      { path: 'tools/bin/helper.sh', bytes: 'help\n' },
    ]);
    for (const [folder, file] of [
      ['tools', 'run.sh'],
      ['tools/bin', 'helper.sh'],
    ] as const) {
      const stage = join(data, 'assets', folder, name);
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, file), 'staged\n');
    }

    await recoverInterruptedPipelineInstalls();

    expect(await readdir(data)).toEqual([]);
    expect(getStoredPipelineText(id).data).toBe(text);
    expect(await intentFiles()).toEqual([]);
  });

  it('rolls back the files that moved and removes the staging folders of the rest (CAN-7058)', async () => {
    const id = 'staged-mid-move';
    const { data, stage: name } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
      { path: 'docs/notes.md', bytes: 'notes\n' },
    ]);
    // run.sh reached its place; notes.md was still staged at the exit.
    await mkdir(join(data, 'assets', 'tools'), { recursive: true });
    await writeFile(join(data, 'assets', 'tools', 'run.sh'), 'run\n');
    const stage = join(data, 'assets', 'docs', name);
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'notes.md'), 'notes\n');

    await recoverInterruptedPipelineInstalls();

    expect(await readdir(data)).toEqual([]);
    expect(await intentFiles()).toEqual([]);
  });

  it('never recreates a link an older record kept, and rolls back the rest (CAN-7058)', async () => {
    const id = 'old-link-record';
    const outside = join(mockRoot, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'target'), 'outside\n');
    const data = join(mockRoot, 'pipeline-data', id);
    await mkdir(join(data, 'assets', 'tools'), { recursive: true });
    await writeFile(join(data, 'assets', 'tools', 'run.sh'), 'old\n');
    await noteLinkedInstall(id, [{ path: 'tools/run.sh', bytes: 'run\n' }]);
    // Rewrite the record as a pre-CAN-7058 one that kept a link.
    const [name] = (await intentFiles()).filter((entry) =>
      entry.endsWith('.json'),
    );
    if (!name) throw new Error('no install record');
    const file = join(mockRoot, 'intents', name);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      definitions: Array<{
        assetFiles: { files: Array<{ previous: unknown }> };
      }>;
    };
    const first = parsed.definitions[0]?.assetFiles.files[0];
    if (!first) throw new Error('no noted file');
    first.previous = { kind: 'symlink', target: join(outside, 'target') };
    await writeFile(file, JSON.stringify(parsed));
    await writeFile(join(data, 'assets', 'tools', 'run.sh'), 'run\n');
    const warn = jest.spyOn(logging, 'logMainProcessWarn');

    await recoverInterruptedPipelineInstalls();

    const placed = await lstat(join(data, 'assets', 'tools', 'run.sh'));
    expect(placed.isSymbolicLink()).toBe(false);
    expect(
      await readFile(join(data, 'assets', 'tools', 'run.sh'), 'utf8'),
    ).toBe('run\n');
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('outside\n');
    // Handled, not failed: the record completes and claims nothing, so a
    // reinstall of the same workflow can start.
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'link_restore_retired' }),
    );
    expect(await intentFiles()).toEqual([]);
    expect(isPipelineDefinitionClaimed(id)).toBe(false);
    const reinstall = await beginPipelineInstallIntent('automation');
    await reinstall.noteDefinition({
      definitionId: id,
      change: 'linked',
      contentHash: hashPipelinePackageYaml(yaml('Existing')),
    });
    await reinstall.rollBack();
  });

  it('refuses to note a link where an install would write a file (CAN-7058)', async () => {
    const id = 'link-at-destination';
    const text = yaml('Existing');
    save(id, text, true);
    const outside = join(mockRoot, 'outside-file');
    await writeFile(outside, 'outside\n');
    const tools = join(mockRoot, 'pipeline-data', id, 'assets', 'tools');
    await mkdir(tools, { recursive: true });
    await symlink(outside, join(tools, 'run.sh'));
    const intent = await beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: id,
      change: 'linked',
      contentHash: hashPipelinePackageYaml(text),
    });
    await expect(
      intent.noteAssetFiles(id, {
        files: [
          { path: 'tools/run.sh', sha256: 'a'.repeat(64), executable: false },
        ],
        directories: ['.', 'tools'],
        createdDirectories: [],
        manifest: { version: 1, assets: {} },
        manifestText: '{"version":1,"assets":{}}\n',
        stagingName: `.install-${randomUUID()}`,
      }),
    ).rejects.toThrow('is a link, so the update cannot replace it');
    await intent.rollBack();
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it.each([
    ['a staging-shaped link', 'link'],
    ['a staging-shaped name that is not a uuid', 'name'],
    ['a staging folder in a folder the record does not cover', 'elsewhere'],
    ['a staging folder behind a linked folder', 'linked-folder'],
  ])('leaves %s alone during recovery (CAN-7058)', async (_label, kind) => {
    const id = `look-alike-${kind}`;
    const outside = join(mockRoot, 'outside');
    const kept = join(outside, staging());
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, 'keep.txt'), 'keep\n');
    const data = join(mockRoot, 'pipeline-data', id);
    const assets = join(data, 'assets');
    await mkdir(join(assets, 'other'), { recursive: true });
    if (kind === 'linked-folder') {
      await symlink(outside, join(assets, 'tools'), 'dir');
    } else {
      await mkdir(join(assets, 'tools'), { recursive: true });
    }
    const { stage } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    const survivor =
      kind === 'link'
        ? join(assets, 'tools', stage)
        : kind === 'name'
          ? join(assets, 'tools', '.install-not-a-uuid')
          : kind === 'elsewhere'
            ? join(assets, 'other', stage)
            : null;
    if (kind === 'link') await symlink(outside, survivor ?? '', 'dir');
    else if (survivor) await mkdir(survivor);

    await recoverInterruptedPipelineInstalls();

    expect(await readFile(join(kept, 'keep.txt'), 'utf8')).toBe('keep\n');
    if (survivor) {
      const stats = await lstat(survivor);
      expect(stats.isSymbolicLink()).toBe(kind === 'link');
      if (kind !== 'link') expect(stats.isDirectory()).toBe(true);
    }
  });

  it("removes only its own staging folder, never a staging-shaped folder that isn't this install's (CAN-7058)", async () => {
    const id = 'staged-beside-another';
    const { data, stage } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    const tools = join(data, 'assets', 'tools');
    await mkdir(join(tools, stage), { recursive: true });
    await writeFile(join(tools, stage, 'run.sh'), 'staged\n');
    // An earlier install's asset folder may carry a staging-shaped name.
    const earlier = join(tools, staging());
    await mkdir(earlier);
    await writeFile(join(earlier, 'keep.txt'), 'keep\n');

    await recoverInterruptedPipelineInstalls();

    await expect(lstat(join(tools, stage))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(earlier, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await intentFiles()).toEqual([]);
  });

  it("sets aside a record whose staging name isn't an install's (CAN-7058)", async () => {
    const { data } = await noteLinkedInstall('staged-unsafe-name', [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    await mkdir(join(data, 'assets', 'tools', 'keep'), { recursive: true });
    await writeFile(join(data, 'assets', 'tools', 'keep', 'a.txt'), 'keep\n');
    const name = await rewriteRecord((parsed) => {
      const assets = parsed.definitions[0]?.assetFiles;
      if (typeof assets !== 'object' || assets === null)
        throw new Error('no noted files');
      Object.assign(assets, { staging: 'keep' });
    });

    await recoverInterruptedPipelineInstalls();

    expect(
      await readFile(join(data, 'assets', 'tools', 'keep', 'a.txt'), 'utf8'),
    ).toBe('keep\n');
    const left = await intentFiles();
    expect(left).not.toContain(name);
    expect(left.some((entry) => entry.startsWith(`${name}.unreadable-`))).toBe(
      true,
    );
  });

  it('leaves the staging folders of a record that never recorded their name, and rolls back the rest (CAN-7058)', async () => {
    const id = 'staged-unrecorded';
    const { data, stage } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    const tools = join(data, 'assets', 'tools');
    await mkdir(join(tools, stage), { recursive: true });
    await writeFile(join(tools, stage, 'run.sh'), 'staged\n');
    await writeFile(join(tools, 'run.sh'), 'run\n');
    await rewriteRecord((parsed) => {
      const assets = parsed.definitions[0]?.assetFiles;
      if (typeof assets !== 'object' || assets === null)
        throw new Error('no noted files');
      Reflect.deleteProperty(assets, 'staging');
    });

    await recoverInterruptedPipelineInstalls();

    expect(await readFile(join(tools, stage, 'run.sh'), 'utf8')).toBe(
      'staged\n',
    );
    await expect(lstat(join(tools, 'run.sh'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await intentFiles()).toEqual([]);
  });

  /**
   * Every entry under `root`: each file's text and modification time, each
   * folder's modification time, each link's target.
   */
  async function snapshotTree(root: string): Promise<Record<string, string>> {
    const tree: Record<string, string> = {};
    const walk = async (folder: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(folder)).sort()) {
        const full = join(folder, name);
        const key = `${prefix}${name}`;
        const stats = await lstat(full);
        if (stats.isSymbolicLink()) tree[key] = `link:${await readlink(full)}`;
        else if (stats.isDirectory()) {
          tree[key] = `folder@${stats.mtimeMs}`;
          await walk(full, `${key}/`);
        } else
          tree[key] = `file:${await readFile(full, 'utf8')}@${stats.mtimeMs}`;
      }
    };
    await walk(root, '');
    return tree;
  }

  /** Rewrites the one install record on disk, as an older or forged one. */
  async function rewriteRecord(
    edit: (record: { definitions: Array<Record<string, unknown>> }) => void,
  ): Promise<string> {
    const [name] = (await intentFiles()).filter((entry) =>
      entry.endsWith('.json'),
    );
    if (!name) throw new Error('no install record');
    const file = join(mockRoot, 'intents', name);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      definitions: Array<Record<string, unknown>>;
    };
    edit(parsed);
    await writeFile(file, JSON.stringify(parsed));
    return name;
  }

  /**
   * Asserts every asset_path_link refusal logged so far names the definition
   * and no path.
   */
  function expectPathFreeRefusals(
    warn: jest.SpiedFunction<typeof logging.logMainProcessWarn>,
    definitionId: string,
  ): void {
    const refusals = warn.mock.calls
      .map((call): unknown => call[1])
      .filter(
        (details) =>
          typeof details === 'object' &&
          details !== null &&
          'reason' in details &&
          details.reason === 'asset_path_link',
      );
    expect(refusals.length).toBeGreaterThan(0);
    for (const details of refusals)
      expect(details).toEqual({ reason: 'asset_path_link', definitionId });
  }

  it.each([
    ['a file the install created', 'created'],
    ['a file the install replaced', 'replaced'],
    ['a folder the install created', 'folder'],
    ["the pipeline's data folder", 'data'],
  ])(
    'never writes or removes through a link swapped in for %s (CAN-7058)',
    async (_label, kind) => {
      const id = `swapped-${kind}`;
      const data = join(mockRoot, 'pipeline-data', id);
      const outside = join(mockRoot, 'outside');
      await mkdir(outside, { recursive: true });
      if (kind === 'replaced') {
        await mkdir(join(data, 'assets', 'tools'), { recursive: true });
        await writeFile(join(data, 'assets', 'tools', 'run.sh'), 'old\n');
      }
      await noteLinkedInstall(id, [
        {
          path: kind === 'folder' ? 'tools/sub/run.sh' : 'tools/run.sh',
          bytes: 'run\n',
        },
      ]);
      // After the install wrote, a folder on the path became a link to a
      // folder outside that holds what the install would roll back.
      if (kind === 'data') {
        await mkdir(join(outside, 'assets', 'tools'), { recursive: true });
        await writeFile(join(outside, 'assets', 'tools', 'run.sh'), 'run\n');
        await writeFile(
          join(outside, 'assets.json'),
          '{"version":1,"assets":{}}\n',
        );
        await rm(data, { recursive: true, force: true });
        await mkdir(join(mockRoot, 'pipeline-data'), { recursive: true });
        await symlink(outside, data, 'dir');
      } else {
        if (kind === 'folder') await mkdir(join(outside, 'sub'));
        else await writeFile(join(outside, 'run.sh'), 'run\n');
        await rm(join(data, 'assets', 'tools'), {
          recursive: true,
          force: true,
        });
        await mkdir(join(data, 'assets'), { recursive: true });
        await symlink(outside, join(data, 'assets', 'tools'), 'dir');
      }
      const link = kind === 'data' ? data : join(data, 'assets', 'tools');
      const before = await snapshotTree(outside);
      const warn = jest.spyOn(logging, 'logMainProcessWarn');

      await recoverInterruptedPipelineInstalls();

      // The link and everything behind it are left as they were.
      expect(await snapshotTree(outside)).toEqual(before);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(outside);
      expectPathFreeRefusals(warn, id);
      expect(await intentFiles()).toEqual([]);
      expect(isPipelineDefinitionClaimed(id)).toBe(false);

      // Handled never becomes a write path: a reinstall over the same id is
      // refused by the install's own link check.
      const reinstalled = Buffer.from('reinstalled\n');
      const blob = createHash('sha256').update(reinstalled).digest('hex');
      await mkdir(join(mockRoot, 'package', 'blobs'), { recursive: true });
      await writeFile(join(mockRoot, 'package', 'blobs', blob), reinstalled);
      await expect(
        installPipelineAssets({
          localPipelineId: id,
          packagePath: join(mockRoot, 'package'),
          resources: [
            {
              id: 'tools',
              kind: 'file_asset',
              displayName: 'tools',
              sourceLabel: 'Package',
              sourceVisibility: 'local',
              invocationKeys: [],
              dependencyResourceIds: [],
              assetId: 'tools',
              installMode: 'replace',
              trees: [
                {
                  provider: 'codex',
                  runtimeKind: 'pipeline_asset',
                  rootName: 'tools',
                  entries: [
                    {
                      path: 'run.sh',
                      sha256: blob,
                      size: reinstalled.length,
                      mode: 'read',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow('include a link');
      expect(await snapshotTree(outside)).toEqual(before);
    },
  );

  it('never removes the assets of a created workflow through a linked data folder (CAN-7058)', async () => {
    const id = 'created-swapped';
    const intent = await beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: id,
      change: 'created',
      contentHash: hashPipelinePackageYaml(yaml('Installed')),
      assets: true,
    });
    const outside = join(mockRoot, 'outside');
    await mkdir(join(outside, 'assets', 'tools'), { recursive: true });
    await writeFile(join(outside, 'assets', 'tools', 'run.sh'), 'run\n');
    await writeFile(join(outside, 'assets.json'), '{}\n');
    await mkdir(join(mockRoot, 'pipeline-data'), { recursive: true });
    await symlink(outside, join(mockRoot, 'pipeline-data', id), 'dir');
    const before = await snapshotTree(outside);
    const warn = jest.spyOn(logging, 'logMainProcessWarn');

    await recoverInterruptedPipelineInstalls();

    expect(await snapshotTree(outside)).toEqual(before);
    expect(
      (await lstat(join(mockRoot, 'pipeline-data', id))).isSymbolicLink(),
    ).toBe(true);
    expectPathFreeRefusals(warn, id);
    expect(await intentFiles()).toEqual([]);
  });

  it.each([
    ['../victim', 'renamed-up'],
    ['a/../../victim', 'renamed-through'],
  ])(
    'sets aside a record naming the id %j instead of rolling it back (CAN-7058)',
    async (unsafeId, notedId) => {
      const { stage } = await noteLinkedInstall(notedId, [
        { path: 'tools/run.sh', bytes: 'run\n' },
      ]);
      const victim = join(mockRoot, 'victim');
      await mkdir(join(victim, 'assets', 'tools', stage), {
        recursive: true,
      });
      await writeFile(join(victim, 'assets', 'tools', 'run.sh'), 'run\n');
      const name = await rewriteRecord((parsed) => {
        const [first] = parsed.definitions;
        if (!first) throw new Error('no noted definition');
        first.definitionId = unsafeId;
      });
      const before = await snapshotTree(victim);

      await recoverInterruptedPipelineInstalls();

      expect(await snapshotTree(victim)).toEqual(before);
      const left = await intentFiles();
      expect(left).not.toContain(name);
      expect(
        left.some((entry) => entry.startsWith(`${name}.unreadable-`)),
      ).toBe(true);
      expect(isPipelineDefinitionClaimed(unsafeId)).toBe(false);
    },
  );

  it('still rolls back a record whose id has capitals and underscores, as the store allows (CAN-7058)', async () => {
    const id = 'Mixed_Case-1';
    const intent = await beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: id,
      change: 'linked',
      contentHash: hashPipelinePackageYaml(yaml('Existing')),
    });

    await recoverInterruptedPipelineInstalls();

    expect(await intentFiles()).toEqual([]);
    expect(isPipelineDefinitionClaimed(id)).toBe(false);
  });

  it('removes a link inside a staging folder as a link, leaving what it points to (CAN-7058)', async () => {
    const id = 'staged-link';
    const { data, stage: name } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    const outside = join(mockRoot, 'outside');
    await mkdir(join(outside, 'folder'), { recursive: true });
    await writeFile(join(outside, 'file'), 'keep\n');
    await writeFile(join(outside, 'folder', 'inner'), 'keep\n');
    const stage = join(data, 'assets', 'tools', name);
    await mkdir(stage, { recursive: true });
    await symlink(join(outside, 'file'), join(stage, 'run.sh'));
    await symlink(join(outside, 'folder'), join(stage, 'folder'), 'dir');
    const before = await snapshotTree(outside);

    await recoverInterruptedPipelineInstalls();

    expect(await snapshotTree(outside)).toEqual(before);
    expect(await readdir(data)).toEqual([]);
    expect(await intentFiles()).toEqual([]);
  });

  it('logs a staging folder it cannot remove and finishes the rest of the rollback (CAN-7058)', async () => {
    const id = 'staged-stuck';
    const { data, stage } = await noteLinkedInstall(id, [
      { path: 'tools/run.sh', bytes: 'run\n' },
    ]);
    await mkdir(join(data, 'assets', 'tools'), { recursive: true });
    await writeFile(join(data, 'assets', 'tools', 'run.sh'), 'run\n');
    const locked = join(data, 'assets', 'tools', stage, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'run.sh'), 'staged\n');
    await chmod(locked, 0o500);
    const warn = jest.spyOn(logging, 'logMainProcessWarn');
    try {
      await recoverInterruptedPipelineInstalls();
    } finally {
      await chmod(locked, 0o700);
    }

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'staging_cleanup_failed' }),
    );
    await expect(
      lstat(join(data, 'assets', 'tools', 'run.sh')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await intentFiles()).toEqual([]);
    expect(isPipelineDefinitionClaimed(id)).toBe(false);
  });

  it('removes staging folders before the record, so a record an exit leaves is finished by the next start (CAN-7058)', async () => {
    const id = 'staged-then-exit';
    const {
      text,
      data,
      intent,
      stage: name,
    } = await noteLinkedInstall(id, [{ path: 'tools/run.sh', bytes: 'run\n' }]);
    await intent.noteInstallRecord(id, record(id, text));
    const stage = join(data, 'assets', 'tools', name);
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'run.sh'), 'staged\n');
    // The rollback stops after the files and before the record goes, as an
    // exit between the two would.
    jest
      .spyOn(installStore, 'findCapabilityPackageInstallByOwner')
      .mockRejectedValueOnce(new Error('exit'));

    await recoverInterruptedPipelineInstalls();

    expect(await readdir(data)).toEqual([]);
    expect(
      (await intentFiles()).filter((entry) => entry.endsWith('.json')),
    ).toHaveLength(1);
    expect(isPipelineDefinitionClaimed(id)).toBe(true);

    await recoverInterruptedPipelineInstalls();

    expect(await intentFiles()).toEqual([]);
    expect(isPipelineDefinitionClaimed(id)).toBe(false);
  });
});
