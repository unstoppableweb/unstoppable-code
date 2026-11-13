import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
import {
  beginPipelineInstallIntent,
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
});
