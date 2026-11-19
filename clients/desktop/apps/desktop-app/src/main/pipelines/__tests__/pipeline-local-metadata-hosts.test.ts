import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getPipelineLocalMetadataFilePath: (): string =>
    join(mockRoot, 'local', 'pipeline-local-metadata.json'),
}));

import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import { createDaemonDefinitionSidecarWriter } from '@canopy/core-runtime/node/pipeline/daemon';
import type { PipelineDefinitionWritePort } from '@canopy/core-runtime/node/pipeline';
import {
  createPipelineLocalMetadataStore,
  type PipelineLocalMetadataStore,
} from '@canopy/core-runtime/node/pipeline/store';
import {
  createDaemonPipelineLocalMetadataEnvironment,
  DAEMON_PIPELINE_LOCAL_METADATA_MODULE,
  pipelineLocalMetadataPath,
} from '@canopy/core-runtime/node/pipeline/store/daemon';
import {
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';
import {
  deleteUserPipelineLocalMetadata,
  isPipelineLocalMetadataReadable,
  pipelineLocalMetadataCodec,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from '../pipeline-local-metadata-store';

/*
 * CAN-7057: the pipeline local metadata file's read, write and recovery
 * policy moved to a portable store in core-runtime. Electron main keeps its
 * module and exports over it; the daemon gets its own environment over its
 * data root with its own durable install, used only by a trusted
 * composition. These pin that a definition delete leaves the same file on
 * either host, and that the daemon writes it only where both rows name it.
 */

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');

const flipped = (...ids: readonly string[]): readonly StorageOwnershipRow[] =>
  STORAGE_OWNERSHIP.map(
    (row): StorageOwnershipRow =>
      ids.includes(row.id)
        ? {
            ...row,
            transitionOwner: 'daemon',
            currentWriters: [],
            admittedWriters: [
              row.id === 'pipeline_local_metadata'
                ? DAEMON_PIPELINE_LOCAL_METADATA_MODULE
                : 'packages/core-runtime/src/node/pipeline/store/definitions-store.ts',
            ],
          }
        : row,
  );

const BOTH = flipped('pipeline_definitions', 'pipeline_local_metadata');
const DEFINITIONS_ONLY = flipped('pipeline_definitions');

/** A file with a field the hosts don't keep, so both must normalize it. */
const SEEDED = `${JSON.stringify(
  {
    version: 1,
    entries: {
      'stored:user:first': { owner: 'personal', ignored: 'dropped' },
      'stored:user:second': {
        owner: 'personal',
        ownerAutomationId: 'automation-1',
        agentHidden: true,
      },
      'stored:user:empty': { owner: 'not a context' },
    },
  },
  null,
  2,
)}\n`;

const localFile = (): string =>
  join(mockRoot, 'local', 'pipeline-local-metadata.json');
const daemonRoot = (): string => join(mockRoot, 'daemon');

function seed(text: string): void {
  for (const file of [localFile(), pipelineLocalMetadataPath(daemonRoot())]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
}

function daemonStore(
  ownership: readonly StorageOwnershipRow[],
): PipelineLocalMetadataStore<object> {
  return createPipelineLocalMetadataStore(
    createDaemonPipelineLocalMetadataEnvironment({
      dataRoot: daemonRoot(),
      flushDirectorySync,
      ownership,
    }),
    pipelineLocalMetadataCodec,
  );
}

/** A definitions writer that records its deletes and writes nothing. */
function recordingWriter(): PipelineDefinitionWritePort & {
  readonly deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    upsert: () => Promise.reject(new Error('unused')),
    copy: () => Promise.reject(new Error('unused')),
    revision: () => Promise.resolve(1),
    delete: (definitionId) => {
      deleted.push(definitionId);
      return Promise.resolve(1);
    },
  };
}

const context = {
  scope: {},
  signal: new AbortController().signal,
};

let stderr: jest.SpyInstance;

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'pipeline-local-metadata-hosts-'));
  stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('pipeline local metadata on every host (CAN-7057)', () => {
  it('leaves the same file after a definition delete on either host', async () => {
    seed(SEEDED);
    const writer = recordingWriter();
    const daemon = createDaemonDefinitionSidecarWriter(writer, {
      localMetadata: daemonStore(BOTH),
      ownership: BOTH,
    });

    deleteUserPipelineLocalMetadata('first');
    await expect(daemon.delete('first', null, context)).resolves.toBe(1);

    const daemonFile = pipelineLocalMetadataPath(daemonRoot());
    expect(writer.deleted).toEqual(['first']);
    expect(readFileSync(daemonFile, 'utf8')).toBe(
      readFileSync(localFile(), 'utf8'),
    );
    expect(statSync(daemonFile).mode & 0o777).toBe(0o600);
    expect(statSync(localFile()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(daemonFile, 'utf8'))).toEqual({
      version: 1,
      entries: {
        'stored:user:second': {
          owner: 'personal',
          ownerAutomationId: 'automation-1',
          agentHidden: true,
        },
      },
    });
    expect(readdirSync(join(daemonFile, '..'))).toEqual([
      'pipeline-local-metadata.json',
    ]);
  });

  it('keeps an entry recorded after the delete readable on Electron main', () => {
    seed(SEEDED);
    deleteUserPipelineLocalMetadata('second');
    recordUserPipelineOwner('third', 'personal');
    expect(
      readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: 'third',
      }),
    ).toEqual({ owner: 'personal' });
    expect(
      readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: 'second',
      }),
    ).toEqual({});
  });

  it.each([
    ['the compiled rows', STORAGE_OWNERSHIP],
    ['only pipeline_definitions flipped', DEFINITIONS_ONLY],
  ])(
    'refuses a daemon delete under %s before anything is written',
    async (_label, ownership) => {
      seed(SEEDED);
      const writer = recordingWriter();
      const daemon = createDaemonDefinitionSidecarWriter(writer, {
        localMetadata: daemonStore(ownership),
        ownership,
      });

      await expect(daemon.delete('first', null, context)).rejects.toMatchObject(
        { payload: { code: 'core.pipeline.sourceUnavailable' } },
      );
      expect(writer.deleted).toEqual([]);
      expect(
        readFileSync(pipelineLocalMetadataPath(daemonRoot()), 'utf8'),
      ).toBe(SEEDED);
    },
  );

  it('never overwrites an unreadable file on either host', async () => {
    seed('{ not json');
    const daemonMetadata = daemonStore(BOTH);
    const daemon = createDaemonDefinitionSidecarWriter(recordingWriter(), {
      localMetadata: daemonMetadata,
      ownership: BOTH,
    });

    expect(isPipelineLocalMetadataReadable()).toBe(false);
    expect(daemonMetadata.isReadable()).toBe(false);
    recordUserPipelineOwner('first', 'personal');
    daemonMetadata.updateUserPipeline('first', () => ({ owner: 'personal' }));
    await daemon.delete('first', null, context);

    expect(readFileSync(localFile(), 'utf8')).toBe('{ not json');
    expect(readFileSync(pipelineLocalMetadataPath(daemonRoot()), 'utf8')).toBe(
      '{ not json',
    );
  });

  it("refuses the daemon's install under rows that don't admit it, writing nothing", () => {
    const metadata = daemonStore(STORAGE_OWNERSHIP);
    metadata.updateUserPipeline('first', () => ({ owner: 'personal' }));
    expect(existsSync(pipelineLocalMetadataPath(daemonRoot()))).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write metadata file'),
    );
  });

  it('is composed by no production daemon or Electron module', () => {
    const sources = [
      'apps/core-daemon/src/daemon.ts',
      'apps/core-daemon/src/main.ts',
      'apps/core-daemon/src/execution-hosts.ts',
    ].map((file) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
    for (const source of sources) {
      expect(source).not.toContain(
        'createDaemonPipelineLocalMetadataEnvironment',
      );
      expect(source).not.toContain('createDaemonDefinitionSidecarWriter');
      expect(source).not.toContain('localMetadata');
    }
  });
});
