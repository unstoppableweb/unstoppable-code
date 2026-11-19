/**
 * The managed Antigravity CLI installs, verifies and reports its status
 * through one owner (antigravity-runtime:status, :install, :cancel and the
 * :progress event), and install stays local-only under remote control. The
 * download is the real installer against a fake GitHub release: a tiny tgz
 * whose sha256 and sha512 this test computes and pins into the artifact.
 */
import type * as ConfigPaths from '@canopy/execution-engine/pipelines/config-paths';
import type * as RuntimeArtifacts from '@canopy/desktop-shared/node/antigravity/runtime-artifacts';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { AntigravityRuntimeStatus } from '@canopy/desktop-shared/types/antigravity-runtime';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { verifyManagedExecutable } from '@canopy/desktop-shared/node/managed-runtime/verification';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const mockWindows = new Set<unknown>();
jest.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: unknown): object | null =>
      mockWindows.has(contents) ? {} : null,
  },
}));

const mockSent: Array<[string, AntigravityRuntimeStatus]> = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    _contents: unknown,
    channel: string,
    data: AntigravityRuntimeStatus,
  ): void => {
    mockSent.push([channel, data]);
  },
}));
jest.mock('../../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: (): boolean => true,
  assertAntigravityHarnessEnabled: (): void => undefined,
}));

let mockRoot = '';
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  ...jest.requireActual<typeof ConfigPaths>(
    '@canopy/execution-engine/pipelines/config-paths',
  ),
  getAntigravityRuntimeRootDir: (): string => mockRoot,
}));

// The real manifest entry for the platform, with the hashes of this test's
// archive. win32 goes through the real platform gate and gets none.
let mockPlatform = 'darwin';
let mockPins = { integrity: '', archiveBytes: 0, executableSha256: '' };
jest.mock('@canopy/desktop-shared/node/antigravity/runtime-artifacts', () => {
  const actual = jest.requireActual<typeof RuntimeArtifacts>(
    '@canopy/desktop-shared/node/antigravity/runtime-artifacts',
  );
  return {
    ...actual,
    getAntigravityRuntimeArtifact: ():
      | RuntimeArtifacts.AntigravityRuntimeArtifact
      | undefined => {
      const real = actual.getAntigravityRuntimeArtifact(mockPlatform, 'arm64');
      return real && { ...real, ...mockPins };
    },
  };
});

// The post-install refresh must not be served from the 15-second
// availability cache.
const mockMarkCatalogStale = jest.fn();
jest.mock('../../antigravity/models', () => ({
  markAntigravityCatalogStale: (): void => {
    mockMarkCatalogStale();
  },
}));

// No user copy on PATH: status depends only on the managed copy.
jest.mock('@canopy/desktop-shared/node/antigravity/runtime-resolution', () => ({
  resolveAntigravityExecutable: (): Promise<string> =>
    Promise.reject(
      new Error('Install Antigravity CLI 1.5.1, then refresh Google models.'),
    ),
}));

import { registerAntigravityRuntimeHandlers } from '../antigravity-runtime';

class FakeContents extends EventEmitter {
  public readonly mainFrame = {};
  public constructor(public readonly id: number) {
    super();
  }
  public isDestroyed(): boolean {
    return false;
  }
}

const RELEASE_STORAGE = 'https://release-assets.githubusercontent.com/agy';

interface Archive {
  bytes: Uint8Array<ArrayBuffer>;
  integrity: string;
  executableSha256: string;
}

async function archive(contents: string): Promise<Archive> {
  const source = mkdtempSync(join(tmpdir(), 'agy-src-'));
  const out = mkdtempSync(join(tmpdir(), 'agy-tgz-'));
  try {
    writeFileSync(join(source, 'antigravity'), contents, { mode: 0o755 });
    const file = join(out, 'runtime.tgz');
    await createTar({ gzip: true, cwd: source, file, portable: true }, [
      'antigravity',
    ]);
    const bytes = new Uint8Array(readFileSync(file));
    return {
      bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      executableSha256: createHash('sha256').update(contents).digest('hex'),
    };
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

function pin(served: Archive): void {
  mockPins = {
    integrity: served.integrity,
    archiveBytes: served.bytes.length,
    executableSha256: served.executableSha256,
  };
}

let body: () => BodyInit = () => Buffer.alloc(0);
let downloads = 0;
const realFetch = globalThis.fetch;

function fakeRelease(url: string | URL | Request): Promise<Response> {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.hostname === 'github.com') {
    downloads++;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: RELEASE_STORAGE },
      }),
    );
  }
  if (target.href === RELEASE_STORAGE)
    return Promise.resolve(new Response(body(), { status: 200 }));
  return Promise.reject(new Error(`unexpected fetch ${target.href}`));
}

function event(contents: FakeContents): object {
  return { sender: contents, senderFrame: contents.mainFrame };
}

function handler(channel: string): Handler {
  const found = handlers.get(channel);
  if (!found) throw new Error(`no handler for ${channel}`);
  return found;
}

async function invoke<T>(
  channel: string,
  contents: FakeContents,
  ...args: unknown[]
): Promise<T> {
  return (await handler(channel)(event(contents), ...args)) as T;
}

function phases(): string[] {
  const seen: string[] = [];
  for (const [channel, status] of mockSent) {
    expect(channel).toBe(IPC_CHANNELS.antigravityRuntimeProgress);
    if (seen.at(-1) !== status.phase) seen.push(status.phase);
  }
  return seen;
}

let main: FakeContents;
let nextWindow = 1;

beforeAll(() => {
  registerAntigravityRuntimeHandlers();
  globalThis.fetch = jest.fn(fakeRelease) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'agy-runtime-'));
  mockPlatform = 'darwin';
  mockSent.length = 0;
  mockMarkCatalogStale.mockClear();
  downloads = 0;
  main = new FakeContents(nextWindow++);
  mockWindows.add(main);
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('Antigravity managed runtime owner', () => {
  it('installs the managed runtime and reports installed managed', async () => {
    const served = await archive('#!/bin/sh\necho agy 1.5.1\n');
    pin(served);
    body = (): BodyInit => served.bytes;

    const before = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeStatus,
      main,
    );
    expect(before).toMatchObject({
      supported: true,
      installed: false,
      managed: false,
      version: '1.5.1',
      phase: 'idle',
    });

    const status = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-1',
    );
    expect(status).toMatchObject({
      supported: true,
      installed: true,
      managed: true,
      version: '1.5.1',
      phase: 'installed',
    });
    expect(status.executable?.endsWith('/1.5.1/antigravity')).toBe(true);
    expect(phases()).toEqual(['downloading', 'verifying', 'installed']);
    expect(downloads).toBe(1);

    await expect(
      invoke(IPC_CHANNELS.antigravityRuntimeStatus, main),
    ).resolves.toEqual(status);
  });

  it('keeps the previous install when a download is truncated', async () => {
    const first = await archive('#!/bin/sh\necho first\n');
    pin(first);
    body = (): BodyInit => first.bytes;
    const installed = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-1',
    );
    expect(installed.phase).toBe('installed');
    const executable = installed.executable ?? '';

    // A new pinned binary forces a download; the release stops mid-way.
    const second = await archive('#!/bin/sh\necho second build\n');
    pin(second);
    body = (): BodyInit => second.bytes.subarray(0, second.bytes.length - 10);
    const failed = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-2',
    );
    expect(failed).toMatchObject({ installed: false, phase: 'failed' });
    expect(failed.error).toBeTruthy();
    expect(downloads).toBe(2);

    // No half-installed version directory or staging left behind, and the
    // first copy is untouched.
    expect(readdirSync(mockRoot)).toEqual(['1.5.1']);
    await expect(
      verifyManagedExecutable(
        executable,
        first.executableSha256,
        AbortSignal.timeout(10_000),
        'Antigravity',
      ),
    ).resolves.toBeUndefined();
  });

  it('a second install while one is running joins it', async () => {
    const served = await archive('#!/bin/sh\necho joined\n');
    pin(served);
    body = (): BodyInit => served.bytes;
    const other = new FakeContents(nextWindow++);
    mockWindows.add(other);

    const [a, b] = await Promise.all([
      invoke<AntigravityRuntimeStatus>(
        IPC_CHANNELS.antigravityRuntimeInstall,
        main,
        'op-a',
      ),
      invoke<AntigravityRuntimeStatus>(
        IPC_CHANNELS.antigravityRuntimeInstall,
        other,
        'op-b',
      ),
    ]);
    expect(downloads).toBe(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      installed: true,
      managed: true,
      phase: 'installed',
    });
  });

  it('cancel stops a running install and leaves nothing installed', async () => {
    const served = await archive('#!/bin/sh\necho cancelled\n');
    pin(served);
    // A release that sends a few bytes and then stalls until cancelled.
    body = (): BodyInit =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(served.bytes.subarray(0, 8));
        },
      });
    const running = invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-c',
    );
    for (let tick = 0; tick < 50 && mockSent.length === 0; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(phases()[0]).toBe('downloading');

    await invoke(IPC_CHANNELS.antigravityRuntimeCancel, main, 'op-c');
    await expect(running).resolves.toMatchObject({
      installed: false,
      phase: 'idle',
    });
    expect(readdirSync(mockRoot)).toEqual([]);

    // The card can install again afterwards.
    body = (): BodyInit => served.bytes;
    await expect(
      invoke(IPC_CHANNELS.antigravityRuntimeInstall, main, 'op-d'),
    ).resolves.toMatchObject({ installed: true, phase: 'installed' });
  });

  it('a joining window closing does not cancel the install', async () => {
    const served = await archive('#!/bin/sh\necho shared\n');
    pin(served);
    // The release sends a few bytes, then waits until the test lets it finish.
    let finish: () => void = () => undefined;
    body = (): BodyInit =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(served.bytes.subarray(0, 8));
          finish = (): void => {
            controller.enqueue(served.bytes.subarray(8));
            controller.close();
          };
        },
      });
    const joiner = new FakeContents(nextWindow++);
    mockWindows.add(joiner);
    const started = invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-origin',
    );
    for (let tick = 0; tick < 50 && mockSent.length === 0; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const joined = invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      joiner,
      'op-joiner',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    joiner.emit('destroyed');
    await new Promise((resolve) => setTimeout(resolve, 5));
    finish();

    await expect(started).resolves.toMatchObject({
      installed: true,
      managed: true,
      phase: 'installed',
    });
    await expect(joined).resolves.toMatchObject({ phase: 'installed' });
    expect(downloads).toBe(1);
  });

  it('reports a failed verification as not installed with a reason', async () => {
    const served = await archive('#!/bin/sh\necho genuine\n');
    pin(served);
    body = (): BodyInit => served.bytes;
    const installed = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-1',
    );
    writeFileSync(
      installed.executable ?? '',
      '#!/bin/sh\necho tampered binary\n',
    );

    const status = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeStatus,
      main,
    );
    expect(status).toMatchObject({
      supported: true,
      installed: false,
      managed: false,
      phase: 'failed',
    });
    expect(status.executable).toBeUndefined();
    expect(status.error).toMatch(/sha256/);
  });

  it('marks the Antigravity catalog stale after a managed install', async () => {
    const served = await archive('#!/bin/sh\necho fresh models\n');
    pin(served);
    body = (): BodyInit => served.bytes.subarray(0, served.bytes.length - 10);
    await expect(
      invoke(IPC_CHANNELS.antigravityRuntimeInstall, main, 'op-fail'),
    ).resolves.toMatchObject({ phase: 'failed' });
    expect(mockMarkCatalogStale).not.toHaveBeenCalled();

    body = (): BodyInit => served.bytes;
    await expect(
      invoke(IPC_CHANNELS.antigravityRuntimeInstall, main, 'op-ok'),
    ).resolves.toMatchObject({ phase: 'installed', managed: true });
    expect(mockMarkCatalogStale).toHaveBeenCalledTimes(1);
  });

  it('install is refused on win32', async () => {
    mockPlatform = 'win32';
    await expect(
      invoke(IPC_CHANNELS.antigravityRuntimeStatus, main),
    ).resolves.toMatchObject({ supported: false, installed: false });
    const refused = await invoke<AntigravityRuntimeStatus>(
      IPC_CHANNELS.antigravityRuntimeInstall,
      main,
      'op-1',
    );
    expect(refused).toMatchObject({
      supported: false,
      installed: false,
      phase: 'failed',
    });
    expect(downloads).toBe(0);
    expect(readdirSync(mockRoot)).toEqual([]);
  });

  it('remote disposition for install and cancel is local', () => {
    expect(IPC_REMOTE_DISPOSITIONS.antigravityRuntimeInstall).toBe('local');
    expect(IPC_REMOTE_DISPOSITIONS.antigravityRuntimeCancel).toBe('local');
    expect(IPC_REMOTE_DISPOSITIONS.antigravityRuntimeProgress).toBe('local');
    expect(IPC_REMOTE_DISPOSITIONS.antigravityRuntimeStatus).toBe('tunnel');
  });
});
