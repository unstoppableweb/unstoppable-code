import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => `${mockRoot}/electron`,
  getPipelineInstallIntentsDir: (): string =>
    `${mockRoot}/electron/pipeline-install-intents`,
  getPipelinePackageInstallStorePath: (): string =>
    `${mockRoot}/electron/installs.json`,
  getPipelineAssetsDir: (id: string): string =>
    `${mockRoot}/electron/pipeline-data/${id}/assets`,
  getPipelineAssetsManifestPath: (id: string): string =>
    `${mockRoot}/electron/pipeline-data/${id}/assets.json`,
}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemLocalUninstall: jest.fn(),
}));
jest.mock('../pipeline-local-metadata-store', () => ({
  deleteUserPipelineLocalMetadata: jest.fn(),
}));

import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import {
  ensurePrivateLockDirectorySync,
  withOwnerLockFileSync,
} from '@canopy/core-platform/owner-lock-file';
import {
  createPipelineDefinitionStore,
  createPipelineInstallJournal,
  PipelineInstallJournalLeftForHostError,
  type PipelineDefinitionStore,
  type PipelineInstallJournal,
  type PipelineInstallJournalEnvironment,
  type PipelineInstallJournalRecord,
} from '@canopy/core-runtime/node/pipeline/store';
import {
  createDaemonPipelineDefinitionStoreEnvironment,
  createDaemonPipelineInstallJournalEnvironment,
  DAEMON_PIPELINE_ASSETS_MODULE,
  DAEMON_PIPELINE_DEFINITION_STORE_MODULE,
  DaemonInstallJournalWriteRefusedError,
} from '@canopy/core-runtime/node/pipeline/store/daemon';
import {
  STORAGE_OWNERSHIP,
  StorageWriteRefusedError,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';
import * as pipelinePaths from '@canopy/execution-engine/pipelines/config-paths';
import {
  getStoredPipeline,
  saveStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  isInstallReceipt,
  type InstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';
import type {
  CapabilityPackageInstallRecordV1,
  PipelinePackageInstallRecordV1,
} from '@canopy/execution-engine/types/pipeline';
import { StorageRowOwnerError } from '@canopy/core-runtime/node/pipeline/store';
import * as logging from '../../lib/main-process-logging';
import { pipelineInstallJournalEnvironment } from '../pipeline-install-intents';

/*
 * CAN-7058: the pipeline install journal runs over a host environment.
 * Electron main's environment is unchanged; the daemon's is dormant and used
 * only by a trusted composition. These pin that the same record recovers the
 * same way on both hosts, that the daemon leaves a record it cannot fully
 * undo for Electron main, that it writes nothing unless all three of its
 * stores name it, and that every daemon write stays inside its own store
 * folder, through real folders, without naming a path.
 */

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');

const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const OLD_SCRIPT = Buffer.from('#!/bin/sh\necho old\n');
const NEW_SCRIPT = Buffer.from('#!/bin/sh\necho new\n');
const NOTES = Buffer.from('notes the install added\n');
const OLD_MANIFEST = '{"version":1,"files":{"bin/run.sh":"old"}}\n';
const NEW_MANIFEST =
  '{"version":1,"files":{"bin/run.sh":"new","docs/notes.md":"new"}}\n';

function yaml(name: string): string {
  return `name: ${name}\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo ${name}\n`;
}

const definitionsRow = (row: StorageOwnershipRow): StorageOwnershipRow => ({
  ...row,
  transitionOwner: 'daemon',
  currentWriters: [],
  admittedWriters: [DAEMON_PIPELINE_DEFINITION_STORE_MODULE],
});

/** A daemon-owned row for a store that isn't compiled today. */
const daemonRow = (
  id: 'pipeline_data' | 'pipeline_install_intents',
  admittedWriters: readonly string[] = [DAEMON_PIPELINE_ASSETS_MODULE],
): StorageOwnershipRow => ({
  id,
  transitionOwner: 'daemon',
  currentWriters: [],
  admittedWriters: [...admittedWriters],
  schemaVersion: 1,
  backupPolicy: 'none',
});

type JournalStore =
  | 'pipeline_definitions'
  | 'pipeline_data'
  | 'pipeline_install_intents';

/** The compiled rows with the named stores flipped to the daemon. */
function rowsNaming(
  stores: readonly JournalStore[],
  admitted: Partial<Record<JournalStore, readonly string[]>> = {},
): readonly StorageOwnershipRow[] {
  const rows = STORAGE_OWNERSHIP.map((row) =>
    row.id === 'pipeline_definitions' && stores.includes('pipeline_definitions')
      ? definitionsRow(row)
      : row,
  );
  return [
    ...rows,
    ...(stores.includes('pipeline_data')
      ? [daemonRow('pipeline_data', admitted.pipeline_data)]
      : []),
    ...(stores.includes('pipeline_install_intents')
      ? [
          daemonRow(
            'pipeline_install_intents',
            admitted.pipeline_install_intents,
          ),
        ]
      : []),
  ];
}

const ALL_THREE: readonly JournalStore[] = [
  'pipeline_definitions',
  'pipeline_data',
  'pipeline_install_intents',
];

const electronRoot = (): string => join(mockRoot, 'electron');
const daemonRoot = (): string => join(mockRoot, 'daemon');
const outside = (): string => join(mockRoot, 'outside');

const daemonWarnings: { message: string; context: unknown }[] = [];

function daemonDefinitionStore(
  ownership: readonly StorageOwnershipRow[],
): PipelineDefinitionStore {
  mkdirSync(join(mockRoot, 'bundled'), { recursive: true });
  const store = createPipelineDefinitionStore(
    createDaemonPipelineDefinitionStoreEnvironment({
      dataRoot: daemonRoot(),
      bundledPipelinesDir: join(mockRoot, 'bundled'),
      lock: { ensurePrivateLockDirectorySync, withOwnerLockFileSync },
      flushDirectorySync,
    }),
  );
  const asDaemon = <T>(run: () => T): T =>
    store.withStoredPipelineWriter({ writer: 'daemon', ownership }, run);
  return {
    ...store,
    removeUnlistedStoredPipelineDocument: (id, expectedSha256) =>
      asDaemon(() =>
        store.removeUnlistedStoredPipelineDocument(id, expectedSha256),
      ),
    removeStoredPipeline: (id, options) =>
      asDaemon(() => store.removeStoredPipeline(id, options)),
    writeStoredPipeline: (input, options) =>
      asDaemon(() => store.writeStoredPipeline(input, options)),
  };
}

function daemonEnvironment(
  ownership: readonly StorageOwnershipRow[],
  flush: (directory: string) => void = flushDirectorySync,
): PipelineInstallJournalEnvironment<
  InstallReceipt,
  PipelineInstallJournalRecord
> {
  const store = daemonDefinitionStore(ownership);
  return createDaemonPipelineInstallJournalEnvironment<InstallReceipt>({
    dataRoot: daemonRoot(),
    flushDirectorySync: flush,
    ownership,
    definitions: store,
    pipelineService: {
      getPipeline: (id) => store.getStoredPipeline(id),
      getPipelineText: (id) => store.getStoredPipelineText(id),
    },
    deleteUserPipelineLocalMetadata: jest.fn(),
    isInstallReceipt: (value): value is InstallReceipt =>
      isInstallReceipt(value),
    warn: (message, context) => {
      daemonWarnings.push({ message, context });
    },
  });
}

function daemonJournal(
  ownership: readonly StorageOwnershipRow[] = rowsNaming(ALL_THREE),
): PipelineInstallJournal<InstallReceipt, PipelineInstallJournalRecord> {
  return createPipelineInstallJournal<
    InstallReceipt,
    PipelineInstallJournalRecord,
    PipelineInstallJournalRecord
  >(daemonEnvironment(ownership));
}

function electronJournal(): PipelineInstallJournal<
  InstallReceipt,
  PipelinePackageInstallRecordV1
> {
  return createPipelineInstallJournal<
    InstallReceipt,
    CapabilityPackageInstallRecordV1,
    PipelinePackageInstallRecordV1
  >(pipelineInstallJournalEnvironment);
}

/** Saves a definition on Electron main and copies the store to the daemon. */
function seedDefinition(id: string, text: string): void {
  const saved = saveStoredPipeline(
    {
      id,
      name: 'Installed',
      description: '',
      icon: '',
      content: parsePipelineText(text),
      rawContent: text,
    },
    { id },
  );
  if (!saved.success) throw new Error(saved.error);
}

function copyDefinitionsToDaemon(): void {
  cpSync(join(electronRoot(), 'pipelines'), join(daemonRoot(), 'pipelines'), {
    recursive: true,
  });
}

type FailurePoint = 'noted' | 'staged' | 'moved';

/** A pipeline's supporting files as an install left them at `point`. */
function writeAssets(root: string, id: string, point: FailurePoint): void {
  const assets = join(root, 'pipeline-data', id, 'assets');
  mkdirSync(join(assets, 'bin'), { recursive: true });
  const script = point === 'moved' ? NEW_SCRIPT : OLD_SCRIPT;
  writeFileSync(join(assets, 'bin', 'run.sh'), script);
  chmodSync(join(assets, 'bin', 'run.sh'), 0o755);
  writeFileSync(
    join(root, 'pipeline-data', id, 'assets.json'),
    point === 'moved' ? NEW_MANIFEST : OLD_MANIFEST,
  );
  if (point === 'moved') {
    mkdirSync(join(assets, 'docs'));
    writeFileSync(join(assets, 'docs', 'notes.md'), NOTES);
  }
}

interface RecordShape {
  readonly intentId: string;
  readonly staging: string;
  readonly definition: Record<string, unknown>;
}

/** An install record changing `id`'s supporting files, plus its kept copy. */
function assetRecord(
  id: string,
  change: 'linked' | 'replaced' | 'created',
  contentHash: string,
  extra: Record<string, unknown> = {},
): RecordShape {
  const staging = `.install-${randomUUID()}`;
  return {
    intentId: randomUUID(),
    staging,
    definition: {
      definitionId: id,
      change,
      contentHash,
      ...(change === 'created'
        ? {}
        : {
            assetFiles: {
              files: [
                {
                  path: 'bin/run.sh',
                  next: sha(NEW_SCRIPT),
                  previous: {
                    kind: 'file',
                    sha256: sha(OLD_SCRIPT),
                    mode: 0o755,
                  },
                },
                { path: 'docs/notes.md', next: sha(NOTES), previous: null },
              ],
              createdDirectories: ['docs'],
              manifest: { previous: OLD_MANIFEST, next: sha(NEW_MANIFEST) },
              staging,
            },
          }),
      ...extra,
    },
  };
}

function writeRecord(root: string, record: RecordShape): void {
  const intents = join(root, 'pipeline-install-intents');
  mkdirSync(join(intents, record.intentId), { recursive: true });
  writeFileSync(join(intents, record.intentId, sha(OLD_SCRIPT)), OLD_SCRIPT);
  writeFileSync(
    join(intents, `${record.intentId}.json`),
    `${JSON.stringify(
      {
        version: 2,
        id: record.intentId,
        source: 'automation',
        startedAt: new Date().toISOString(),
        definitions: [record.definition],
      },
      null,
      2,
    )}\n`,
  );
}

function writeStaging(root: string, id: string, staging: string): void {
  const folder = join(root, 'pipeline-data', id, 'assets', 'bin', staging);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'run.sh'), NEW_SCRIPT);
}

/** Every entry under a folder: file bytes and mode, links and folders. */
function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = join(folder, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) entries[name] = 'link';
      else if (entry.isDirectory()) {
        entries[name] = 'folder';
        walk(full, name);
      } else
        entries[name] =
          `${sha(readFileSync(full))}:${(statSync(full).mode & 0o777).toString(8)}`;
    }
  };
  if (existsSync(root)) walk(root, '');
  return entries;
}

/** A folder's entries with every modification time, to show nothing changed. */
function stamps(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    entries[prefix || '.'] = String(lstatSync(folder).mtimeMs);
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else
        entries[name] =
          `${sha(readFileSync(full))}:${String(lstatSync(full).mtimeMs)}`;
    }
  };
  walk(root, '');
  return entries;
}

/** What a host's recovery leaves: supporting files, records, the document. */
function hostState(root: string, id: string): Record<string, unknown> {
  const document = join(root, 'pipelines', `${id}.yaml`);
  return {
    data: tree(join(root, 'pipeline-data')),
    intents: tree(join(root, 'pipeline-install-intents')),
    document: existsSync(document) ? readFileSync(document, 'utf8') : null,
  };
}

/**
 * A refusal, whose message names no root or record path; the daemon's own
 * path refusals name no path at all.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(pathFree(error.message)).toBe(true);
    if (error instanceof DaemonInstallJournalWriteRefusedError)
      expect(error.message).not.toMatch(/[\\/]/);
    return error;
  }
  throw new Error('expected a refusal');
}

/** True when a log entry, errors included, names no root or record path. */
const pathFree = (value: unknown): boolean => {
  const text =
    JSON.stringify(value, (_key, field: unknown) =>
      field instanceof Error
        ? { name: field.name, message: field.message }
        : field,
    ) ?? '';
  return ![
    mockRoot,
    realpathSync(mockRoot),
    'pipeline-data/',
    'pipeline-install-intents/',
  ].some((fragment) => text.includes(fragment));
};

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'pipeline-install-journal-hosts-'));
  for (const folder of [electronRoot(), daemonRoot(), outside()])
    mkdirSync(folder, { recursive: true });
  jest
    .spyOn(pipelinePaths, 'getUserPipelinesDir')
    .mockReturnValue(join(electronRoot(), 'pipelines'));
  jest
    .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
    .mockReturnValue(join(electronRoot(), 'pipelines', 'index.json'));
  jest.spyOn(logging, 'logMainProcessWarn').mockImplementation(() => {
    // Electron main's warnings are not under test here.
  });
  daemonWarnings.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('pipeline install journal on every host (CAN-7058)', () => {
  it.each<FailurePoint>(['noted', 'staged', 'moved'])(
    'recovers the same linked record the same way on both hosts (%s)',
    async (point) => {
      const id = 'linked-files';
      seedDefinition(id, yaml('Linked'));
      copyDefinitionsToDaemon();
      const record = assetRecord(id, 'linked', sha(yaml('Linked')));
      for (const root of [electronRoot(), daemonRoot()]) {
        writeAssets(root, id, point);
        writeRecord(root, record);
        if (point === 'staged') writeStaging(root, id, record.staging);
      }
      await electronJournal().recoverInterruptedPipelineInstalls();
      await daemonJournal().recoverInterruptedPipelineInstalls();
      const electron = hostState(electronRoot(), id);
      expect(hostState(daemonRoot(), id)).toEqual(electron);
      // Both are back to what the pipeline held before the install.
      const before = join(mockRoot, 'before');
      writeAssets(before, id, 'noted');
      expect(electron.data).toEqual(tree(join(before, 'pipeline-data')));
      expect(electron.intents).toEqual({});
    },
  );

  it.each<FailurePoint>(['noted', 'moved'])(
    'puts back a replaced document and its files the same way on both hosts (%s)',
    async (point) => {
      const id = 'replaced-files';
      const previous = yaml('Before');
      const next = yaml('After');
      // After the save, the install's own document is the stored one.
      seedDefinition(id, point === 'moved' ? next : previous);
      copyDefinitionsToDaemon();
      const record = assetRecord(id, 'replaced', sha(next), {
        previous: {
          text: previous,
          name: 'Installed',
          description: '',
          icon: '',
        },
      });
      for (const root of [electronRoot(), daemonRoot()]) {
        writeAssets(root, id, point);
        writeRecord(root, record);
      }
      await electronJournal().recoverInterruptedPipelineInstalls();
      await daemonJournal().recoverInterruptedPipelineInstalls();
      const electron = hostState(electronRoot(), id);
      expect(hostState(daemonRoot(), id)).toEqual(electron);
      expect(electron.document).toBe(previous);
      expect(electron.intents).toEqual({});
    },
  );

  it('replays a committed marker clear without rolling back the definition', async () => {
    const id = 'committed-marker';
    const previous = yaml('Before');
    const next = yaml('After');
    seedDefinition(id, previous);
    const clearMarker = jest.fn().mockImplementationOnce(() => {
      throw new Error('interrupted before marker cleanup');
    });
    const environment = {
      ...pipelineInstallJournalEnvironment,
      clearInstalledPipelineMarker: clearMarker,
    };
    const installer = createPipelineInstallJournal(environment);
    const intent = await installer.beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: id,
      change: 'replaced',
      contentHash: sha(next),
    });
    const saved = saveStoredPipeline({
      id,
      name: 'Installed',
      description: '',
      icon: '',
      content: parsePipelineText(next),
      rawContent: next,
    });
    if (!saved.success || !saved.data) throw new Error(saved.error);
    const { revision } = saved.data;
    const marker = { definitionId: id, revision };
    await expect(intent.finish([marker])).rejects.toMatchObject({
      name: 'PipelineInstallCleanupPendingError',
    });
    expect(clearMarker).toHaveBeenCalledWith(marker);
    expect(installer.isPipelineDefinitionClaimed(id)).toBe(true);

    cpSync(electronRoot(), daemonRoot(), { recursive: true });
    const before = stamps(daemonRoot());
    const daemon = daemonJournal();
    await daemon.recoverInterruptedPipelineInstalls();
    expect(stamps(daemonRoot())).toEqual(before);
    expect(daemon.isPipelineDefinitionClaimed(id)).toBe(true);

    await createPipelineInstallJournal(
      environment,
    ).recoverInterruptedPipelineInstalls();
    expect(clearMarker.mock.calls).toEqual([[marker], [marker]]);
    expect(hostState(electronRoot(), id).document).toBe(next);
    expect(tree(join(electronRoot(), 'pipeline-install-intents'))).toEqual({});
    expect(getStoredPipeline(id).data?.info.revision).toBe(revision);
  });

  it('sets an unreadable record aside the same way on both hosts', async () => {
    const intentId = randomUUID();
    for (const root of [electronRoot(), daemonRoot()]) {
      const intents = join(root, 'pipeline-install-intents');
      mkdirSync(join(intents, intentId), { recursive: true });
      writeFileSync(join(intents, intentId, 'kept'), 'kept');
      writeFileSync(join(intents, `${intentId}.json`), '{not json');
    }
    await electronJournal().recoverInterruptedPipelineInstalls();
    await daemonJournal().recoverInterruptedPipelineInstalls();
    const names = (root: string): string[] =>
      readdirSync(join(root, 'pipeline-install-intents'))
        .map((name) => name.replace(/\.unreadable-\d+$/, '.unreadable'))
        .sort();
    expect(names(daemonRoot())).toEqual(names(electronRoot()));
    expect(names(daemonRoot())).toEqual([
      `${intentId}.json.unreadable`,
      `${intentId}.unreadable`,
    ]);
  });

  it.each([
    [
      'install_receipts',
      (id: string): RecordShape =>
        assetRecord(id, 'linked', sha(yaml('Shared')), {
          receipt: {
            accountId: 'account-1',
            receipt: {
              family: 'pipelines',
              remoteId: 'remote-1',
              localResourceIds: [id],
              shareScope: 'team',
              ownerContext: {
                kind: 'organization',
                organizationId: '33333333-3333-4333-8333-333333333333',
              },
              hash: sha(yaml('Shared')),
              authorizedAt: new Date().toISOString(),
            },
            previous: null,
          },
        }),
    ],
    [
      'install_records',
      (id: string): RecordShape =>
        assetRecord(id, 'linked', sha(yaml('Shared')), {
          installRecord: { previous: null, next: null },
        }),
    ],
    [
      'shared_item_ledger',
      (id: string): RecordShape =>
        assetRecord(id, 'created', sha(yaml('Shared'))),
    ],
  ] as const)(
    'leaves a record needing %s whole on the daemon, for Electron main to recover',
    async (port, build) => {
      const id = 'needs-host';
      seedDefinition(id, yaml('Shared'));
      copyDefinitionsToDaemon();
      const record = build(id);
      writeAssets(daemonRoot(), id, 'moved');
      writeRecord(daemonRoot(), record);
      const before = stamps(daemonRoot());
      const daemon = daemonJournal();
      await daemon.recoverInterruptedPipelineInstalls();
      // Nothing of it was undone, rewritten or removed, and it stays claimed.
      expect(stamps(daemonRoot())).toEqual(before);
      expect(daemon.isPipelineDefinitionClaimed(id)).toBe(true);
      const left = daemonWarnings.filter((entry) =>
        entry.message.includes('for a host that can undo it'),
      );
      expect(left).toEqual([
        {
          message:
            '[pipeline-install] Left an install record for a host that can undo it',
          context: {
            reason: 'needs_host_port',
            port,
            intentId: record.intentId,
          },
        },
      ]);
      for (const entry of daemonWarnings) expect(pathFree(entry)).toBe(true);
      // Electron main, given the same data root, recovers it.
      rmSync(electronRoot(), { recursive: true, force: true });
      cpSync(daemonRoot(), electronRoot(), { recursive: true });
      await electronJournal().recoverInterruptedPipelineInstalls();
      expect(tree(join(electronRoot(), 'pipeline-install-intents'))).toEqual(
        {},
      );
    },
  );

  it('refuses to note a receipt or an install record on the daemon before writing', async () => {
    const daemon = daemonJournal();
    const intent = await daemon.beginPipelineInstallIntent('shared');
    await expect(
      refusalOf(() => intent.noteInstallRecord('needs-host', null)),
    ).resolves.toBeInstanceOf(PipelineInstallJournalLeftForHostError);
    await expect(
      refusalOf(() =>
        intent.noteReceipt('needs-host', {
          accountId: 'account-1',
          receipt: {
            family: 'pipelines',
            remoteId: 'remote-1',
            shareScope: 'team',
            ownerContext: {
              kind: 'organization',
              organizationId: '33333333-3333-4333-8333-333333333333',
            },
            hash: sha('x'),
            authorizedAt: new Date().toISOString(),
          },
          previous: undefined,
        }),
      ),
    ).resolves.toBeInstanceOf(PipelineInstallJournalLeftForHostError);
    expect(existsSync(join(daemonRoot(), 'pipeline-install-intents'))).toBe(
      false,
    );
  });

  const PARTIAL: readonly (readonly JournalStore[])[] = [
    [],
    ['pipeline_definitions'],
    ['pipeline_data'],
    ['pipeline_install_intents'],
    ['pipeline_definitions', 'pipeline_data'],
    ['pipeline_definitions', 'pipeline_install_intents'],
    ['pipeline_data', 'pipeline_install_intents'],
  ];

  it.each(PARTIAL.map((stores) => [stores.join('+') || 'none', stores]))(
    'writes nothing on the daemon unless all three stores name it (%s)',
    async (_label, stores) => {
      const id = 'gated';
      seedDefinition(id, yaml('Gated'));
      copyDefinitionsToDaemon();
      writeAssets(daemonRoot(), id, 'moved');
      writeRecord(daemonRoot(), assetRecord(id, 'linked', sha(yaml('Gated'))));
      const before = stamps(daemonRoot());
      const environment = daemonEnvironment(rowsNaming(stores));
      let writes = 0;
      const counted = <A extends unknown[], R>(
        port: (...args: A) => R,
      ): ((...args: A) => R) => {
        return (...args) => {
          writes += 1;
          return port(...args);
        };
      };
      const journal = createPipelineInstallJournal<
        InstallReceipt,
        PipelineInstallJournalRecord,
        PipelineInstallJournalRecord
      >({
        ...environment,
        createDirectoryDurably: counted(environment.createDirectoryDurably),
        syncDirectory: counted(environment.syncDirectory),
        writeFileAtomically: counted(environment.writeFileAtomically),
        writeStoreFileDurably: counted(environment.writeStoreFileDurably),
        removePath: counted(environment.removePath),
        removeEmptyFolder: counted(environment.removeEmptyFolder),
        renamePath: counted(environment.renamePath),
        makeFolder: counted(environment.makeFolder),
        pruneDamagedCopies: counted(environment.pruneDamagedCopies),
      });
      await expect(
        refusalOf(() => journal.recoverInterruptedPipelineInstalls()),
      ).resolves.toBeInstanceOf(StorageWriteRefusedError);
      await expect(
        refusalOf(() => journal.beginPipelineInstallIntent('automation')),
      ).resolves.toBeInstanceOf(StorageWriteRefusedError);
      expect(writes).toBe(0);
      expect(stamps(daemonRoot())).toEqual(before);
    },
  );

  it('admits every daemon write: a store whose row lacks the daemon module is not written', async () => {
    const intentsRefused = daemonJournal(
      rowsNaming(ALL_THREE, { pipeline_install_intents: ['someone-else'] }),
    );
    const intent =
      await intentsRefused.beginPipelineInstallIntent('automation');
    await expect(
      refusalOf(() =>
        intent.noteDefinition({
          definitionId: 'admitted',
          change: 'linked',
          contentHash: sha('x'),
        }),
      ),
    ).resolves.toBeInstanceOf(StorageWriteRefusedError);
    expect(existsSync(join(daemonRoot(), 'pipeline-install-intents'))).toBe(
      false,
    );

    const id = 'admitted-data';
    seedDefinition(id, yaml('Admitted'));
    copyDefinitionsToDaemon();
    writeAssets(daemonRoot(), id, 'moved');
    writeRecord(daemonRoot(), assetRecord(id, 'linked', sha(yaml('Admitted'))));
    const data = stamps(join(daemonRoot(), 'pipeline-data'));
    await daemonJournal(
      rowsNaming(ALL_THREE, { pipeline_data: ['someone-else'] }),
    ).recoverInterruptedPipelineInstalls();
    expect(stamps(join(daemonRoot(), 'pipeline-data'))).toEqual(data);
    expect(
      readdirSync(join(daemonRoot(), 'pipeline-install-intents')).some((name) =>
        name.endsWith('.json'),
      ),
    ).toBe(true);
  });

  describe('daemon writes stay inside their store folder', () => {
    const environment = (): PipelineInstallJournalEnvironment<
      InstallReceipt,
      PipelineInstallJournalRecord
    > => daemonEnvironment(rowsNaming(ALL_THREE));
    const data = (...parts: string[]): string =>
      join(daemonRoot(), 'pipeline-data', ...parts);
    const intents = (...parts: string[]): string =>
      join(daemonRoot(), 'pipeline-install-intents', ...parts);

    beforeEach(() => {
      mkdirSync(data('one', 'assets', 'bin'), { recursive: true });
      writeFileSync(data('one', 'assets', 'bin', 'run.sh'), OLD_SCRIPT);
      mkdirSync(intents('kept'), { recursive: true });
      writeFileSync(intents('record.json'), '{}');
      writeFileSync(join(outside(), 'secret.txt'), 'outside');
    });

    const reasonOf = async (
      run: () => Promise<unknown>,
    ): Promise<string | undefined> => {
      const error = await refusalOf(run);
      return error instanceof DaemonInstallJournalWriteRefusedError
        ? error.reason
        : undefined;
    };

    it('refuses a look-alike sibling of a store folder', async () => {
      for (const sibling of [
        'pipeline-data-evil',
        'pipeline-install-intents-evil',
      ]) {
        mkdirSync(join(daemonRoot(), sibling), { recursive: true });
        writeFileSync(join(daemonRoot(), sibling, 'file'), 'sibling');
        await expect(
          reasonOf(() =>
            environment().removePath(join(daemonRoot(), sibling, 'file')),
          ),
        ).resolves.toBe('outside_root');
        await expect(
          reasonOf(() =>
            environment().writeFileAtomically(
              join(daemonRoot(), sibling, 'new'),
              'x',
              { durable: true },
            ),
          ),
        ).resolves.toBe('outside_root');
        expect(readFileSync(join(daemonRoot(), sibling, 'file'), 'utf8')).toBe(
          'sibling',
        );
        expect(existsSync(join(daemonRoot(), sibling, 'new'))).toBe(false);
      }
    });

    it("refuses a '..' segment, and a path outside the data root", async () => {
      await expect(
        reasonOf(() =>
          environment().removePath(
            `${data('one', 'assets')}/../../../pipeline-install-intents/record.json`,
          ),
        ),
      ).resolves.toBe('dotdot_segment');
      await expect(
        reasonOf(() => environment().removePath(join(outside(), 'secret.txt'))),
      ).resolves.toBe('outside_root');
      await expect(
        reasonOf(() =>
          environment().removePath('pipeline-data/one/assets/bin/run.sh'),
        ),
      ).resolves.toBe('outside_root');
      expect(readFileSync(intents('record.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(outside(), 'secret.txt'), 'utf8')).toBe(
        'outside',
      );
    });

    it('never removes or renames a whole store folder', async () => {
      for (const root of [data(), intents()]) {
        await expect(
          reasonOf(() =>
            environment().removePath(root, { recursive: true, force: true }),
          ),
        ).resolves.toBe('root_target');
        await expect(
          reasonOf(() => environment().removeEmptyFolder(root)),
        ).resolves.toBe('root_target');
        await expect(
          reasonOf(() => environment().renamePath(root, join(root, 'moved'))),
        ).resolves.toBe('root_target');
        await expect(
          reasonOf(() =>
            environment().renamePath(join(root, 'anything'), root),
          ),
        ).resolves.toBe('root_target');
      }
      expect(existsSync(data('one', 'assets', 'bin', 'run.sh'))).toBe(true);
      expect(existsSync(intents('record.json'))).toBe(true);
    });

    it('keeps a rename inside one store folder', async () => {
      await expect(
        reasonOf(() =>
          environment().renamePath(intents('record.json'), data('record.json')),
        ),
      ).resolves.toBe('cross_root_rename');
      await expect(
        reasonOf(() =>
          environment().renamePath(
            data('one', 'assets', 'bin', 'run.sh'),
            intents('run.sh'),
          ),
        ),
      ).resolves.toBe('cross_root_rename');
      await expect(
        reasonOf(() =>
          environment().renamePath(
            intents('record.json'),
            join(outside(), 'record.json'),
          ),
        ),
      ).resolves.toBe('outside_root');
      expect(existsSync(intents('record.json'))).toBe(true);
      expect(existsSync(data('one', 'assets', 'bin', 'run.sh'))).toBe(true);
      expect(existsSync(join(outside(), 'record.json'))).toBe(false);
    });

    it.each([
      ['the pipeline folder', ['one']],
      ['the asset folder', ['one', 'assets']],
      ['a nested folder', ['one', 'assets', 'bin']],
    ])(
      'never removes or renames through a link at %s',
      async (_label, linked) => {
        const target = join(outside(), 'linked');
        mkdirSync(join(target, 'bin'), { recursive: true });
        writeFileSync(join(target, 'run.sh'), 'outside');
        writeFileSync(join(target, 'bin', 'run.sh'), 'outside');
        writeFileSync(join(target, 'assets'), 'outside');
        const linkPath = data(...linked);
        rmSync(linkPath, { recursive: true, force: true });
        symlinkSync(target, linkPath);
        const before = stamps(outside());
        const victim = data('one', 'assets', 'bin', 'run.sh');
        await expect(
          reasonOf(() => environment().removePath(victim, { force: true })),
        ).resolves.toBe('link_on_path');
        await expect(
          reasonOf(() =>
            environment().renamePath(victim, data('one', 'assets', 'moved')),
          ),
        ).resolves.toBe('link_on_path');
        await expect(
          reasonOf(() =>
            environment().writeFileAtomically(victim, 'install', {
              durable: true,
            }),
          ),
        ).resolves.toBe('link_on_path');
        expect(stamps(outside())).toEqual(before);
      },
    );

    it('never writes through the records folder when it is a link', async () => {
      const target = join(outside(), 'records');
      mkdirSync(target);
      writeFileSync(join(target, 'record.json'), 'outside');
      rmSync(intents(), { recursive: true, force: true });
      symlinkSync(target, intents());
      const before = stamps(outside());
      await expect(
        reasonOf(() => environment().removePath(intents('record.json'))),
      ).resolves.toBe('link_on_path');
      await expect(
        reasonOf(() =>
          environment().makeFolder(intents('kept'), {
            recursive: true,
            mode: 0o700,
          }),
        ),
      ).resolves.toBe('link_on_path');
      await expect(
        reasonOf(() =>
          environment().createDirectoryDurably(intents(), {
            dataRoot: daemonRoot(),
          }),
        ),
      ).resolves.toBe('link_on_path');
      expect(stamps(outside())).toEqual(before);
    });

    it('never creates a folder through a link inside the records folder', async () => {
      const target = join(outside(), 'linked-records');
      mkdirSync(target);
      symlinkSync(target, intents('link'));
      const before = stamps(outside());
      await expect(
        reasonOf(() =>
          environment().createDirectoryDurably(intents('link', 'child'), {
            dataRoot: daemonRoot(),
          }),
        ),
      ).resolves.toBe('link_on_path');
      expect(existsSync(join(target, 'child'))).toBe(false);
      // Nor through a link deeper down, below a real folder.
      mkdirSync(intents('real'));
      symlinkSync(target, intents('real', 'link'));
      await expect(
        reasonOf(() =>
          environment().createDirectoryDurably(
            intents('real', 'link', 'a', 'b'),
            { dataRoot: daemonRoot() },
          ),
        ),
      ).resolves.toBe('link_on_path');
      expect(existsSync(join(target, 'a'))).toBe(false);
      expect(stamps(outside())).toEqual(before);
    });

    it('removes or renames a link inside the store as a link, leaving what it points to', async () => {
      const target = join(outside(), 'pointed');
      mkdirSync(target);
      writeFileSync(join(target, 'kept.txt'), 'outside');
      const before = stamps(outside());
      symlinkSync(target, data('one', 'assets', 'link'));
      await environment().renamePath(
        data('one', 'assets', 'link'),
        data('one', 'assets', 'renamed'),
      );
      expect(lstatSync(data('one', 'assets', 'renamed')).isSymbolicLink()).toBe(
        true,
      );
      await environment().removePath(data('one', 'assets', 'renamed'), {
        recursive: true,
        force: true,
      });
      expect(existsSync(data('one', 'assets', 'renamed'))).toBe(false);
      expect(stamps(outside())).toEqual(before);
      // Nor does a rename land inside a link that points outside.
      symlinkSync(target, data('one', 'assets', 'into'));
      await expect(
        reasonOf(() =>
          environment().renamePath(
            data('one', 'assets', 'bin', 'run.sh'),
            data('one', 'assets', 'into', 'run.sh'),
          ),
        ),
      ).resolves.toBe('link_on_path');
      expect(stamps(outside())).toEqual(before);
    });

    it('refuses an unsafe pipeline id without naming it', async () => {
      await expect(
        reasonOf(() =>
          Promise.resolve().then(() =>
            environment().getPipelineAssetsDir('../one'),
          ),
        ),
      ).resolves.toBe('unsafe_id');
    });
  });

  it('counts a record installed when only its folder flush fails, so a rollback still clears it', async () => {
    const records = join(daemonRoot(), 'pipeline-install-intents');
    let failNextRecordFlush = true;
    const flush = (directory: string): void => {
      if (
        failNextRecordFlush &&
        directory === records &&
        readdirSync(records).some((name) => name.endsWith('.json'))
      ) {
        failNextRecordFlush = false;
        throw new Error('flush failed');
      }
      flushDirectorySync(directory);
    };
    const journal = createPipelineInstallJournal<
      InstallReceipt,
      PipelineInstallJournalRecord,
      PipelineInstallJournalRecord
    >(daemonEnvironment(rowsNaming(ALL_THREE), flush));
    const intent = await journal.beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: 'flushed',
      change: 'linked',
      contentHash: sha('x'),
    });
    expect(failNextRecordFlush).toBe(false);
    expect(journal.isPipelineDefinitionClaimed('flushed')).toBe(true);
    expect(
      readdirSync(records).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
    await intent.rollBack();
    expect(
      readdirSync(records).filter((name) => name.endsWith('.json')),
    ).toEqual([]);
    expect(journal.isPipelineDefinitionClaimed('flushed')).toBe(false);
    expect(daemonWarnings.map((entry) => entry.message)).toContain(
      '[storage] Store file installed, but its folder flush failed',
    );
    for (const entry of daemonWarnings) expect(pathFree(entry)).toBe(true);
  });

  it('recovers at the next start a record whose only failure was its folder flush', async () => {
    const records = join(daemonRoot(), 'pipeline-install-intents');
    let failNextRecordFlush = true;
    const flush = (directory: string): void => {
      if (
        failNextRecordFlush &&
        directory === records &&
        readdirSync(records).some((name) => name.endsWith('.json'))
      ) {
        failNextRecordFlush = false;
        throw new Error('flush failed');
      }
      flushDirectorySync(directory);
    };
    const first = createPipelineInstallJournal<
      InstallReceipt,
      PipelineInstallJournalRecord,
      PipelineInstallJournalRecord
    >(daemonEnvironment(rowsNaming(ALL_THREE), flush));
    const intent = await first.beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: 'flushed-then-exited',
      change: 'linked',
      contentHash: sha('x'),
    });
    expect(first.isPipelineDefinitionClaimed('flushed-then-exited')).toBe(true);
    // The process exits here; the next start recovers the record.
    await daemonJournal().recoverInterruptedPipelineInstalls();
    expect(
      readdirSync(records).filter((name) => name.endsWith('.json')),
    ).toEqual([]);
  });

  it('logs no path when the daemon refuses during a rollback', async () => {
    const id = 'linked-out';
    seedDefinition(id, yaml('Linked'));
    copyDefinitionsToDaemon();
    writeAssets(daemonRoot(), id, 'moved');
    const record = assetRecord(id, 'linked', sha(yaml('Linked')));
    writeRecord(daemonRoot(), record);
    writeStaging(daemonRoot(), id, record.staging);
    const target = join(outside(), 'assets');
    cpSync(join(daemonRoot(), 'pipeline-data', id, 'assets'), target, {
      recursive: true,
    });
    rmSync(join(daemonRoot(), 'pipeline-data', id, 'assets'), {
      recursive: true,
      force: true,
    });
    symlinkSync(target, join(daemonRoot(), 'pipeline-data', id, 'assets'));
    const before = stamps(outside());
    await daemonJournal().recoverInterruptedPipelineInstalls();
    expect(stamps(outside())).toEqual(before);
    expect(daemonWarnings.length).toBeGreaterThan(0);
    for (const entry of daemonWarnings) expect(pathFree(entry)).toBe(true);
  });

  it('is composed by no production module', () => {
    const sources = [
      'apps/core-daemon/src/daemon.ts',
      'apps/core-daemon/src/main.ts',
      'apps/core-daemon/src/execution-hosts.ts',
      'apps/core-daemon/src/pipelines.ts',
      'apps/desktop-app/src/main/pipelines/pipeline-install-intents.ts',
    ].map((file) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
    for (const source of sources)
      expect(source).not.toContain(
        'createDaemonPipelineInstallJournalEnvironment',
      );
  });

  it("refuses an install on each host when the intents row is recorded as the other one's (CAN-7690)", async () => {
    const record = (folder: string, toOwner: 'daemon' | 'legacy'): void => {
      const path = join(
        folder,
        'storage-records',
        'pipeline_install_intents',
        'owner-flip.json',
      );
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          namespaceId: 'pipeline_install_intents',
          fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
          toOwner,
          workPackage: 'W6',
          backupRecord: `storage-records/pipeline_install_intents/namespace-backup.json#sha256:${'a'.repeat(64)}`,
          flippedAt: '2026-11-24T10:00:00.000Z',
        }),
      );
    };
    record(electronRoot(), 'daemon');
    await expect(
      refusalOf(() => electronJournal().beginPipelineInstallIntent('shared')),
    ).resolves.toBeInstanceOf(StorageRowOwnerError);
    expect(existsSync(join(electronRoot(), 'pipeline-install-intents'))).toBe(
      false,
    );
    record(daemonRoot(), 'legacy');
    await expect(
      refusalOf(() => daemonJournal().beginPipelineInstallIntent('shared')),
    ).resolves.toMatchObject({ owner: 'legacy' });
    expect(existsSync(join(daemonRoot(), 'pipeline-install-intents'))).toBe(
      false,
    );
    record(daemonRoot(), 'daemon');
    await expect(
      daemonJournal().beginPipelineInstallIntent('shared'),
    ).resolves.toBeDefined();
  });

  it("refuses snapshots, the finish and a rollback once the intents row is recorded as the other host's, changing no byte (CAN-7690)", async () => {
    const owned = join(daemonRoot(), 'pipeline-data', 'owned', 'assets');
    mkdirSync(join(owned, 'tools'), { recursive: true });
    writeFileSync(join(owned, 'tools', 'run.sh'), 'echo before\n');
    const journal = daemonJournal();
    const finishing = await journal.beginPipelineInstallIntent('automation');
    await finishing.noteDefinition({
      definitionId: 'owned',
      change: 'linked',
      contentHash: sha('owned'),
    });
    const rolling = await journal.beginPipelineInstallIntent('automation');
    await rolling.noteDefinition({
      definitionId: 'other',
      change: 'linked',
      contentHash: sha('other'),
    });
    const path = join(
      daemonRoot(),
      'storage-records',
      'pipeline_install_intents',
      'owner-flip.json',
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        namespaceId: 'pipeline_install_intents',
        fromOwner: 'daemon',
        toOwner: 'legacy',
        workPackage: 'W6',
        backupRecord: `storage-records/pipeline_install_intents/namespace-backup.json#sha256:${'a'.repeat(64)}`,
        flippedAt: '2026-11-24T10:00:00.000Z',
      }),
    );
    const before = tree(daemonRoot());
    await expect(
      refusalOf(() =>
        finishing.noteAssetFiles('owned', {
          files: [
            { path: 'tools/run.sh', sha256: sha('next'), executable: false },
          ],
          directories: ['.', 'tools'],
          createdDirectories: [],
          manifest: { version: 1, assets: {} },
          manifestText: '{"version":1,"assets":{}}\n',
          stagingName: `.install-${randomUUID()}`,
        }),
      ),
    ).resolves.toBeInstanceOf(StorageRowOwnerError);
    await expect(refusalOf(() => finishing.finish())).resolves.toMatchObject({
      owner: 'legacy',
    });
    await expect(refusalOf(() => rolling.rollBack())).resolves.toMatchObject({
      owner: 'legacy',
    });
    expect(tree(daemonRoot())).toEqual(before);
    // Both intents stay for the owning host's recovery, still claimed.
    expect(journal.isPipelineDefinitionClaimed('owned')).toBe(true);
    expect(journal.isPipelineDefinitionClaimed('other')).toBe(true);
  });

  it('keeps an interrupted install fenced when the next start may not write the intents, writing nothing (CAN-7690)', async () => {
    const first = daemonJournal();
    const intent = await first.beginPipelineInstallIntent('automation');
    await intent.noteDefinition({
      definitionId: 'half-installed',
      change: 'linked',
      contentHash: sha('half'),
    });
    // The process exits here, its intent still on disk.
    const records = join(daemonRoot(), 'pipeline-install-intents');
    const intents = (): string[] =>
      readdirSync(records).filter((name) => name.endsWith('.json'));
    expect(intents()).toHaveLength(1);
    const path = join(
      daemonRoot(),
      'storage-records',
      'pipeline_install_intents',
      'owner-flip.json',
    );
    const record = (toOwner: 'daemon' | 'legacy'): void => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          namespaceId: 'pipeline_install_intents',
          fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
          toOwner,
          workPackage: 'W6',
          backupRecord: `storage-records/pipeline_install_intents/namespace-backup.json#sha256:${'a'.repeat(64)}`,
          flippedAt: '2026-11-24T10:00:00.000Z',
        }),
      );
    };
    record('legacy');
    const before = tree(daemonRoot());
    const refused = daemonJournal();
    await expect(
      refused.pipelineDefinitionRecoveryRefusal('half-installed'),
    ).resolves.toMatchObject({ errorCode: 'pipeline_definition_unconfirmed' });
    await expect(
      refusalOf(() => refused.recoverInterruptedPipelineInstalls()),
    ).resolves.toBeInstanceOf(StorageRowOwnerError);
    expect(tree(daemonRoot())).toEqual(before);
    record('daemon');
    const owner = daemonJournal();
    await owner.recoverInterruptedPipelineInstalls();
    expect(intents()).toEqual([]);
    // Its owner rolls it back as before: the link it added is undone.
    await expect(
      owner.pipelineDefinitionRecoveryRefusal('half-installed'),
    ).resolves.toMatchObject({ errorCode: 'pipeline_definition_removed' });
  });
});
