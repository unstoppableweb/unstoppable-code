import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  createCoreDictationHandlers,
  type CoreDictationHandlers,
  type SpeechModelManifestEntry,
} from '@canopy/core-runtime/dictation';
import {
  DICTATION_INSTRUCTION_DEFINITIONS,
  DICTATION_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type DictationModelStatus,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();

jest.mock('electron', () => ({ app: { isPackaged: false } }));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ voiceDictationEnabled: boolean }> =>
    Promise.resolve({ voiceDictationEnabled: true }),
}));

import {
  createSpeechModelActions,
  registerSpeechModelHandlers,
} from '../../ipc/voice-speech-model';
import {
  createDesktopDictationHost,
  VERIFIED_MARKER,
} from '../speech-model-host';

/*
 * The Linux speech model store (CAN-7231): core.dictation.model.status.get,
 * core.dictation.model.install, core.dictation.model.install.cancel and
 * core.dictation.model.remove on a real dispatcher, over the real desktop store, downloading from a local HTTP
 * server through the Dictation settings' IPC channels. A file that fails its
 * sha256 never reaches the installed directory, an interrupted download
 * resumes with a range request, and an older model goes only after its
 * replacement verified.
 */

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1)
    out[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  return out;
}

const sha256 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** A model with three small files served from `/<version>/<file>`. */
function model(version: string): {
  entry: SpeechModelManifestEntry;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>([
    [`m/${version}/encoder.ort`, bytes(`enc-${version}`, 200_000)],
    [`m/${version}/decoder_kv.ort`, bytes(`dec-${version}`, 300_000)],
    [`m/${version}/tokenizer.bin`, bytes(`tok-${version}`, 5_000)],
  ]);
  const list = [...files].map(([path, data]) => ({
    path,
    sizeBytes: data.length,
    sha256: sha256(data),
  }));
  return {
    files,
    entry: {
      id: `test-model-${version}`,
      displayName: 'English (test)',
      architecture: 'small-streaming',
      language: 'en',
      license: 'MIT',
      sizeBytes: list.reduce((total, file) => total + file.sizeBytes, 0),
      files: list,
    },
  };
}

interface Served {
  server: Server;
  baseUrl: string;
  files: Map<string, Buffer>;
  /** Range headers received, by path. */
  ranges: string[];
  /** Every path requested, in order. */
  requests: string[];
  /**
   * Paths whose next response is cut off after this many bytes, once the
   * client has saved them to the `saved` file.
   */
  cutOnce: Map<string, { bytes: number; saved: string }>;
  /** Paths whose next response sends this many bytes, then stalls open. */
  stallOnce: Map<string, number>;
  /** Paths served with these bytes instead of the real ones. */
  corrupt: Map<string, Buffer>;
}

async function serve(): Promise<Served> {
  const state: Omit<Served, 'server' | 'baseUrl'> = {
    files: new Map(),
    ranges: [],
    requests: [],
    cutOnce: new Map(),
    stallOnce: new Map(),
    corrupt: new Map(),
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').slice(1));
    state.requests.push(path);
    const data = state.corrupt.get(path) ?? state.files.get(path);
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    const range = request.headers.range;
    let start = 0;
    if (range) {
      state.ranges.push(`${path} ${range}`);
      start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
      response.writeHead(206, {
        'content-length': data.length - start,
        'content-range': `bytes ${start}-${data.length - 1}/${data.length}`,
      });
    } else {
      response.writeHead(200, { 'content-length': data.length });
    }
    const stall = state.stallOnce.get(path);
    if (stall !== undefined) {
      state.stallOnce.delete(path);
      response.write(data.subarray(start, start + stall));
      return;
    }
    const cut = state.cutOnce.get(path);
    if (cut !== undefined) {
      state.cutOnce.delete(path);
      response.write(data.subarray(start, start + cut.bytes));
      // Cut only after the client saved what it was sent. A connection lost
      // while the bytes still sit unread in the client's response stream
      // saves nothing, and the retry then rightly starts over with no range.
      const cutWhenSaved = (): void => {
        const socket = response.socket;
        if (!socket || socket.destroyed) return;
        const saved = existsSync(cut.saved) ? statSync(cut.saved).size : 0;
        if (saved >= cut.bytes) socket.destroy();
        else setTimeout(cutWhenSaved, 5);
      };
      cutWhenSaved();
      return;
    }
    response.end(data.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, ...state };
}

let root: string;
let served: Served;

beforeEach(async () => {
  mockHandlers.clear();
  root = mkdtempSync(join(tmpdir(), 'speech-model-'));
  served = await serve();
});

afterEach(async () => {
  served.server.closeAllConnections();
  await new Promise<void>((resolve) => served.server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function compose(
  entry: SpeechModelManifestEntry,
  baseUrl: string | null = served.baseUrl,
): {
  handlers: CoreDictationHandlers;
  dispatcher: CanopyDispatcher<
    typeof DICTATION_QUERY_DEFINITIONS,
    typeof DICTATION_INSTRUCTION_DEFINITIONS,
    Record<never, never>
  >;
} {
  const host = createDesktopDictationHost({
    supported: true,
    modelsDir: join(root, 'models'),
    baseUrl,
    fetch: (url, init) => fetch(url, init),
  });
  const handlers = createCoreDictationHandlers(host, { model: entry });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: DICTATION_QUERY_DEFINITIONS,
      instructions: DICTATION_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: handlers.queries,
      instructions: handlers.instructions,
      streams: {},
    },
  });
  registerSpeechModelHandlers(dispatcher, () => caller);
  return { handlers, dispatcher };
}

function ipc(channel: string): Promise<DictationModelStatus> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}) as Promise<DictationModelStatus>;
}

const installed = (entry: SpeechModelManifestEntry): string =>
  join(root, 'models', entry.id);

describe('the Linux speech model through core.dictation', () => {
  it('downloads, verifies and installs the model with a marker, then removes it', async () => {
    const { entry, files } = model('v1');
    files.forEach((data, path) => served.files.set(path, data));
    const { handlers, dispatcher } = compose(entry);

    const before = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(before).toMatchObject({
      state: 'notInstalled',
      model: { id: entry.id, sizeBytes: entry.sizeBytes },
      sourceConfigured: true,
    });

    const started = await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    expect(['downloading', 'verifying', 'installed']).toContain(started.state);
    await handlers.idle();

    const after = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(after.state).toBe('installed');
    for (const [path, data] of files) {
      const name = path.split('/').pop() ?? '';
      expect(readFileSync(join(installed(entry), name))).toEqual(data);
    }
    const marker: unknown = JSON.parse(
      readFileSync(join(installed(entry), VERIFIED_MARKER), 'utf8'),
    );
    expect(marker).toMatchObject({ id: entry.id, files: entry.files });
    expect(existsSync(join(root, 'models', '.staging', entry.id))).toBe(false);

    // A status read trusts the marker: it never downloads or re-hashes.
    const requests = served.ranges.length;
    expect((await ipc(IPC_CHANNELS.voiceSpeechModelInstall)).state).toBe(
      'installed',
    );
    expect(served.ranges.length).toBe(requests);

    const removed = await ipc(IPC_CHANNELS.voiceSpeechModelRemove);
    expect(removed.state).toBe('notInstalled');
    expect(existsSync(installed(entry))).toBe(false);
    await dispatcher.shutdown();
  });

  it('never installs a file that fails its sha256, and installs once it matches', async () => {
    const { entry, files } = model('v1');
    files.forEach((data, path) => served.files.set(path, data));
    const bad = entry.files[1]?.path ?? '';
    served.corrupt.set(bad, bytes('tampered', files.get(bad)?.length ?? 0));
    const { handlers, dispatcher } = compose(entry);

    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await handlers.idle();
    const failed = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(failed).toMatchObject({
      state: 'failed',
      failure: { code: 'checksum' },
    });
    expect(existsSync(installed(entry))).toBe(false);

    served.corrupt.clear();
    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await handlers.idle();
    expect((await ipc(IPC_CHANNELS.voiceSpeechModelStatus)).state).toBe(
      'installed',
    );
    await dispatcher.shutdown();
  });

  it('resumes an interrupted download with a range request', async () => {
    const { entry, files } = model('v1');
    files.forEach((data, path) => served.files.set(path, data));
    const big = entry.files[1]?.path ?? '';
    const partial = join(
      root,
      'models',
      '.staging',
      entry.id,
      'decoder_kv.ort.partial',
    );
    served.cutOnce.set(big, { bytes: 120_000, saved: partial });
    const { handlers, dispatcher } = compose(entry);

    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await handlers.idle();
    const interrupted = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(interrupted).toMatchObject({
      state: 'failed',
      failure: { code: 'network' },
      // The partial it keeps to resume is removable from Settings.
      extraFilesStored: true,
    });
    expect(existsSync(installed(entry))).toBe(false);
    expect(statSync(partial).size).toBe(120_000);

    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await handlers.idle();
    expect((await ipc(IPC_CHANNELS.voiceSpeechModelStatus)).state).toBe(
      'installed',
    );
    expect(served.ranges).toEqual([`${big} bytes=120000-`]);
    await dispatcher.shutdown();
  });

  it('replaces an older model at launch, removing it only after the new one verified', async () => {
    const old = model('v1');
    const next = model('v2');
    old.files.forEach((data, path) => served.files.set(path, data));
    next.files.forEach((data, path) => served.files.set(path, data));

    // Launch with nothing installed: first use waits for someone to ask.
    const first = compose(old.entry);
    const launch = createSpeechModelActions(first.dispatcher, caller);
    expect((await launch.install('launch')).state).toBe('notInstalled');
    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await first.handlers.idle();
    await first.dispatcher.shutdown();
    expect(existsSync(installed(old.entry))).toBe(true);

    // The next version's manifest names a new model; the new model fails
    // first, and the old one stays.
    const bad = next.entry.files[0]?.path ?? '';
    served.corrupt.set(
      bad,
      bytes('tampered', next.files.get(bad)?.length ?? 0),
    );
    const second = compose(next.entry);
    const upgrade = createSpeechModelActions(second.dispatcher, caller);
    await upgrade.install('launch');
    await second.handlers.idle();
    expect((await upgrade.status()).state).toBe('failed');
    expect(existsSync(installed(old.entry))).toBe(true);

    served.corrupt.clear();
    await upgrade.install('launch');
    await second.handlers.idle();
    expect((await upgrade.status()).state).toBe('installed');
    expect(existsSync(installed(next.entry))).toBe(true);
    expect(existsSync(installed(old.entry))).toBe(false);
    await second.dispatcher.shutdown();
  });

  it('reports a build with no download location instead of downloading', async () => {
    const { entry } = model('v1');
    const { dispatcher } = compose(entry, null);
    const status = await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    expect(status).toMatchObject({
      state: 'failed',
      sourceConfigured: false,
      failure: { code: 'sourceUnavailable' },
    });
    expect(served.ranges).toEqual([]);
    await dispatcher.shutdown();
  });

  it('cancels a download keeping its partial files and the older model, then resumes it', async () => {
    const old = model('v1');
    const next = model('v2');
    old.files.forEach((data, path) => served.files.set(path, data));
    next.files.forEach((data, path) => served.files.set(path, data));
    const first = compose(old.entry);
    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await first.handlers.idle();
    await first.dispatcher.shutdown();

    const big = next.entry.files[1]?.path ?? '';
    served.stallOnce.set(big, 100_000);
    const second = compose(next.entry);
    const before = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(before).toMatchObject({
      state: 'notInstalled',
      extraFilesStored: true,
    });
    // Two installs at once (the launch check and a click) start one download.
    const [a, b] = await Promise.all([
      ipc(IPC_CHANNELS.voiceSpeechModelInstall),
      ipc(IPC_CHANNELS.voiceSpeechModelInstall),
    ]);
    expect([a.state, b.state]).toEqual(['downloading', 'downloading']);
    // Cancel only once bytes are saved: an empty partial has nothing to
    // resume, and the retry rightly starts over with no range.
    const partial = join(
      root,
      'models',
      '.staging',
      next.entry.id,
      'decoder_kv.ort.partial',
    );
    while (!existsSync(partial) || statSync(partial).size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await ipc(IPC_CHANNELS.voiceSpeechModelCancel);
    expect(cancelled).toMatchObject({ state: 'notInstalled', failure: null });
    expect(served.requests.filter((path) => path === big)).toHaveLength(1);
    // The older model and the partial download both stay.
    expect(existsSync(installed(old.entry))).toBe(true);
    expect(
      existsSync(
        join(
          root,
          'models',
          '.staging',
          next.entry.id,
          'decoder_kv.ort.partial',
        ),
      ),
    ).toBe(true);

    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    await second.handlers.idle();
    const after = await ipc(IPC_CHANNELS.voiceSpeechModelStatus);
    expect(after).toMatchObject({
      state: 'installed',
      extraFilesStored: false,
    });
    expect(
      served.ranges.some((range) => range.startsWith(`${big} bytes=`)),
    ).toBe(true);
    expect(existsSync(installed(old.entry))).toBe(false);
    await second.dispatcher.shutdown();
  });

  it('does not start a launch download for a leftover partial of another model', async () => {
    const old = model('v1');
    const next = model('v2');
    old.files.forEach((data, path) => served.files.set(path, data));
    old.files.forEach((_data, path) => served.stallOnce.set(path, 1_000));
    const first = compose(old.entry);
    await ipc(IPC_CHANNELS.voiceSpeechModelInstall);
    while (!existsSync(join(root, 'models', '.staging', old.entry.id))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await ipc(IPC_CHANNELS.voiceSpeechModelCancel);
    await first.dispatcher.shutdown();

    const second = compose(next.entry);
    const launch = createSpeechModelActions(second.dispatcher, caller);
    const status = await launch.install('launch');
    expect(status).toMatchObject({
      state: 'notInstalled',
      extraFilesStored: true,
    });
    await second.dispatcher.shutdown();
  });

  it('refuses a paired computer', async () => {
    const { entry, files } = model('v1');
    files.forEach((data, path) => served.files.set(path, data));
    const { dispatcher } = compose(entry);
    const remote = createSpeechModelActions(dispatcher, {
      ...caller,
      principalId: 'remote-device:abc',
    });
    await expect(remote.install('user')).rejects.toThrow(
      'Only someone at this computer can change its speech model.',
    );
    expect(existsSync(installed(entry))).toBe(false);
    await dispatcher.shutdown();
  });
});
