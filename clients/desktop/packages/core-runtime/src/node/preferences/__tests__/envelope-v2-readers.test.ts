import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PREFERENCES_ENVELOPE_WRITE_VERSION } from '@canopy/protocol/preferences';
import { createPreferencesRepository, type PreferencesCodec } from '..';
import {
  createDirectoryReadPreferenceSource,
  readDesktopPreferencesRecord,
} from '../../filesystem/directory-read-preferences';
import { createCodeGraphPreferenceSource } from '../../code-graph/preferences';
import { readPipelineSetupFactVersion } from '../../pipeline/host';
import { MemoryPreferencesDocument } from './fixtures/memory-document';

// CAN-7925 (CAN-5722 slice C): the owner flip moves preferences.json to
// envelope version 2 with version 1's shape. Every reader must get the same
// values from either version, and this build still writes version 1.

const PREFERENCES = {
  count: 7,
  tags: ['a', 'b'],
  keepSystemAwakeWhileAgentsActive: false,
  fileIndexing: { excludePatterns: ['dist'] },
  gitExecutablePath: '/opt/git/bin/git',
  codeGraph: {
    mode: 'selected-workspaces',
    selectedWorkspaceIds: ['ws-1'],
    generationTimeoutMinutes: 45,
  },
  aiCreditsRoutingMode: 'on',
  defaultChatProvider: 'codex',
};

const envelope = (version: number, generation = 4): string =>
  JSON.stringify({ version, generation, preferences: PREFERENCES });
const record = (generation: number): string =>
  JSON.stringify({ version: 1, generation });

interface Value {
  count: number;
  tags: string[];
}

const codec: PreferencesCodec<Value> = {
  defaults: { count: 0, tags: [] },
  normalize: (payload) => ({
    count: Number(payload.count ?? 0),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
  }),
  project: (value) => value,
  inspect: () => null,
  merge: (existing, patch) => ({ ...existing, ...patch }),
};

const repository = (
  document: MemoryPreferencesDocument,
): ReturnType<typeof createPreferencesRepository<Value>> =>
  createPreferencesRepository({
    document: () => document,
    codec,
    log: { error: jest.fn() },
  });

async function repositoryReads(primary: string): Promise<unknown> {
  const document = new MemoryPreferencesDocument();
  document.slots.set('primary', primary);
  document.slots.set('generation', record(4));
  const store = repository(document);
  const reads = {
    persisted: await store.read('persisted'),
    runtime: await store.read('runtime'),
    authority: await store.readAuthority({ includeServed: true }),
    payload: await store.readStoredPayload(),
    loadError: store.peekLoadError(),
    latched: store.isRecoveryLatched(),
  };
  // A read never repairs or rewrites a readable file.
  expect(document.installs).toEqual([]);
  return reads;
}

async function recoveredFromLastGood(lastGood: string): Promise<unknown> {
  const document = new MemoryPreferencesDocument();
  document.slots.set('primary', '{');
  document.slots.set('lastGood', lastGood);
  document.slots.set('generation', record(4));
  const store = repository(document);
  const value = await store.read('persisted');
  return {
    value,
    latched: store.isRecoveryLatched(),
    restored: ((): unknown =>
      JSON.parse(document.slots.get('primary') ?? 'null'))(),
  };
}

function fileReader(files: Map<string, string>) {
  return (absolutePath: string): Promise<string> => {
    const text = files.get(absolutePath);
    return text === undefined
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : Promise.resolve(text);
  };
}

const paths = { join, isAbsolute };

describe('preferences envelope v2 readers (CAN-7925)', () => {
  it('the preference repository behind preferences:load reads a version 2 file as it reads version 1, without writing', async () => {
    const v1 = await repositoryReads(envelope(1));
    expect(v1).toMatchObject({
      persisted: { count: 7, tags: ['a', 'b'] },
      authority: { authority: 'ok' },
      payload: { kind: 'read', source: 'primary', payload: PREFERENCES },
      loadError: null,
      latched: false,
    });
    await expect(repositoryReads(envelope(2))).resolves.toEqual(v1);
  });

  it('the preference repository restores a version 2 last-good as it restores version 1', async () => {
    const v1 = await recoveredFromLastGood(envelope(1));
    expect(v1).toMatchObject({
      value: { count: 7, tags: ['a', 'b'] },
      latched: false,
    });
    const v2 = await recoveredFromLastGood(envelope(2));
    expect(v2).toMatchObject({
      value: { count: 7, tags: ['a', 'b'] },
      latched: false,
    });
    // Recovery rewrites the primary in the version this build writes.
    expect(v2).toMatchObject({
      restored: { version: PREFERENCES_ENVELOPE_WRITE_VERSION },
    });
  });

  it('a save over a version 2 file keeps its values and writes version 1', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('primary', envelope(2));
    document.slots.set('generation', record(4));
    const store = repository(document);
    await store.update((latest) => ({ count: latest.count + 1 }));
    await store.flush();
    expect(PREFERENCES_ENVELOPE_WRITE_VERSION).toBe(1);
    expect(JSON.parse(document.slots.get('primary') ?? '')).toEqual({
      version: 1,
      generation: 5,
      preferences: { count: 8, tags: ['a', 'b'] },
    });
    expect(JSON.parse(document.slots.get('lastGood') ?? '')).toMatchObject({
      version: 1,
    });
  });

  it('an unknown version is still refused and never written over', async () => {
    const document = new MemoryPreferencesDocument();
    const primary = envelope(3);
    document.slots.set('primary', primary);
    const store = repository(document);
    await expect(store.read('persisted')).resolves.toEqual(codec.defaults);
    expect(store.peekLoadError()).toMatchObject({
      reason: 'version',
      actualVersion: 3,
    });
    await expect(store.readAuthority()).resolves.toMatchObject({
      authority: 'unreadable',
    });
    await expect(store.update(() => ({ count: 1 }))).rejects.toMatchObject({
      code: 'PREFERENCES_RECOVERY_REQUIRED',
    });
    expect(document.slots.get('primary')).toBe(primary);
    expect(readDesktopPreferencesRecord(primary)).toBeNull();
  });

  it('the daemon envelope reader (wake lock, code graph) reads version 2 as version 1', () => {
    expect(readDesktopPreferencesRecord(envelope(1))).toEqual(PREFERENCES);
    expect(readDesktopPreferencesRecord(envelope(2))).toEqual(
      readDesktopPreferencesRecord(envelope(1)),
    );
  });

  it.each([
    ['primary', 'preferences.json'],
    ['last-good', 'preferences.last-good.json'],
  ])(
    'the daemon directory source and the code-graph source gating worker.codeGraph.build read a version 2 %s file as version 1',
    async (_source, name) => {
      const read = async (version: number): Promise<unknown> => {
        const files = new Map([[join('/data', name), envelope(version)]]);
        const options = {
          canonicalDataRoot: '/data',
          paths,
          readFile: fileReader(files),
        };
        const signal = new AbortController().signal;
        return {
          directory:
            await createDirectoryReadPreferenceSource(options).read(signal),
          codeGraph:
            await createCodeGraphPreferenceSource(options).read(signal),
        };
      };
      const v1 = await read(1);
      expect(v1).toMatchObject({
        directory: { preferences: { gitExecutablePath: '/opt/git/bin/git' } },
        codeGraph: {
          mode: 'selected-workspaces',
          selectedWorkspaceIds: ['ws-1'],
          generationTimeoutMinutes: 45,
        },
      });
      expect(v1).not.toMatchObject({ directory: { source: 'defaults' } });
      await expect(read(2)).resolves.toEqual(v1);
    },
  );

  it('the pipeline setup facts worker.pipeline.execution.start admits digest a version 2 preferences file as version 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preferences-envelope-v2-'));
    const fact = {
      root: 'data',
      relativePath: 'preferences.json',
      projection: 'preferences',
    } as const;
    // The observed, frozen-consent and consent-admitted digests.
    const digests = async (
      version: number,
    ): Promise<(string | undefined)[]> => {
      await writeFile(join(root, 'preferences.json'), envelope(version));
      const observed = await readPipelineSetupFactVersion(root, fact, 'darwin');
      return [
        observed,
        await readPipelineSetupFactVersion(root, fact, 'darwin', {
          frozenAiCreditsConsent: true,
        }),
        await readPipelineSetupFactVersion(root, fact, 'darwin', {
          frozenAiCreditsConsent: true,
          requireAiCreditsConsent: true,
          ...(observed !== undefined && {
            expectedPreferencesVersion: observed,
          }),
        }),
      ];
    };
    try {
      const v1 = await digests(1);
      expect(v1).toHaveLength(3);
      for (const digest of v1) expect(digest).toMatch(/^[0-9a-f]{64}$/);
      await expect(digests(2)).resolves.toEqual(v1);
      await expect(digests(3)).resolves.toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
