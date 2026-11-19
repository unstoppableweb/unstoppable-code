/**
 * CAN-4730 E2-G: after a daemon restart, Files writes are refused as typed
 * awaitingOwner until the desktop re-publishes its fences, which it does on
 * its own, with no lock activity or user action, within a bounded time.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import type { CanopyClient } from '@canopy/core-client';
import { connectCanopyClient } from '@canopy/core-client/node';
import type * as CoreRuntime from '@canopy/core-runtime';
import type * as CoreRuntimeNode from '@canopy/core-runtime/node';
import { createCanopyOwnerProof } from '@canopy/core-transport';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  MUTATION_FENCE_GRANTS,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  SCOPES,
  seedFilesystemRecords,
  worktreeHome,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../../core-daemon/src/daemon';
import { createElectronDaemonConnectionService } from '../electron-daemon-connection';
import {
  ELECTRON_DAEMON_OWNER_DEFINITIONS,
  type ElectronDaemonOwnerClient,
} from '../electron-daemon-owner';
import {
  createSplitLockFencePublisher,
  ownerFenceSession,
} from '../daemon-split-lock-fences';

// Test-only write grants on both sides. No production principal receives them.
jest.mock('@canopy/core-runtime', () => {
  const actual = jest.requireActual<typeof CoreRuntime>('@canopy/core-runtime');
  return {
    ...actual,
    createRuntimeProfileGraph: (
      options: Parameters<typeof actual.createRuntimeProfileGraph>[0],
    ): ReturnType<typeof actual.createRuntimeProfileGraph> =>
      actual.createRuntimeProfileGraph({
        ...options,
        ...(options.workerCaller && {
          workerCaller: {
            ...options.workerCaller,
            grants: [...options.workerCaller.grants, 'worker.filesystem.write'],
          },
        }),
      }),
  };
});
jest.mock('@canopy/core-runtime/node', () => {
  const actual = jest.requireActual<typeof CoreRuntimeNode>(
    '@canopy/core-runtime/node',
  );
  return {
    ...actual,
    serveCanopyDaemonControlPlane: (
      options: Parameters<typeof actual.serveCanopyDaemonControlPlane>[0],
    ): ReturnType<typeof actual.serveCanopyDaemonControlPlane> =>
      actual.serveCanopyDaemonControlPlane({
        ...options,
        callerFor: (identity): ReturnType<typeof options.callerFor> => {
          const caller = options.callerFor(identity);
          return {
            ...caller,
            grants: [...caller.grants, 'worker.filesystem.write'],
          };
        },
      }),
  };
});

const writerDefinitions = {
  queries: {},
  instructions: {
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  },
  streams: {},
};
type Writer = CanopyClient<
  typeof writerDefinitions.queries,
  typeof writerDefinitions.instructions,
  typeof writerDefinitions.streams
>;

/** How long the desktop may take to re-publish once it can reach the daemon. */
const REPUBLISH_BOUND_MS = 10_000;
const posix = process.platform === 'win32' ? describe.skip : describe;

let dataRoot: string;
let secret: Uint8Array;
let daemon: RunningCanopyDaemon | undefined;
const closers: Array<() => Promise<unknown>> = [];

const dataRootHash = (): string =>
  createHash('sha256').update(dataRoot).digest('hex');

async function start(): Promise<RunningCanopyDaemon> {
  daemon = await startCanopyDaemon({
    dataRoot,
    runtimeMode: 'dev',
    buildVersion: 'test',
    brandId: 'canopy',
    secureDataRoot: paths.join(dataRoot, 'secure'),
    coworkManagedDirName: '.canopy',
    environment: { PATH: process.env.PATH },
    ownerSecret: secret,
  });
  return daemon;
}

async function endpoint(running: RunningCanopyDaemon): Promise<{
  kind: 'socket';
  path: string;
  auth: { secret: string; dataRootHash: string };
}> {
  return {
    kind: 'socket',
    path: running.descriptor.endpoint.path,
    auth: {
      secret: await readFile(running.descriptor.tokenRef, 'utf8'),
      dataRootHash: dataRootHash(),
    },
  };
}

/** Connects as the daemon's owner, as Electron main's owner session does. */
async function connectOwner(
  running: RunningCanopyDaemon,
): Promise<ElectronDaemonOwnerClient> {
  return await connectCanopyClient({
    endpoint: await endpoint(running),
    clientName: 'desktop',
    clientVersion: '0',
    definitions: ELECTRON_DAEMON_OWNER_DEFINITIONS,
    ownerProof: (connectionId: string): string =>
      createCanopyOwnerProof(secret, connectionId, dataRootHash()),
  });
}

async function openWriter(running: RunningCanopyDaemon): Promise<Writer> {
  const writer: Writer = await connectCanopyClient({
    endpoint: await endpoint(running),
    clientName: 'fence-writer',
    clientVersion: '0',
    definitions: writerDefinitions,
  });
  closers.push(() => writer.close());
  await writer.instruction('core.client.lease.acquire', {
    clientInstanceId: `cli:${randomUUID()}`,
    interfaceKind: 'cli',
    label: 'cli',
    interactive: false,
    foreground: false,
    renewalIntervalMs: 15000,
    _meta: { idempotencyKey: randomUUID() },
  });
  return writer;
}

/** A Files write: deletes a file this creates in the worktree. */
async function write(writer: Writer): Promise<unknown> {
  const name = `${randomUUID()}.txt`;
  await writeFile(paths.join(worktreeHome(dataRoot, 'single'), name), 'x');
  return await writer.instruction('worker.filesystem.entry.delete', {
    scope: SCOPES.single,
    fileRootId: 'single',
    relativePath: name,
    expectedVersion: null,
    recursive: false,
    disposition: 'permanent',
    _meta: { idempotencyKey: randomUUID() },
  });
}

/** Resolves once `writer`'s writes are accepted, failing past `boundMs`. */
async function acceptedWithin(writer: Writer, boundMs: number): Promise<void> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    try {
      expect(await write(writer)).toMatchObject({ deleted: true });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const awaitingOwner = {
  payload: {
    kind: 'failed_precondition',
    // What a CLI, MCP or Remote Control caller shows: what to do, not a crash.
    message:
      "Couldn't change these files because the desktop app hasn't reported which worktrees are locked. Open the desktop app, then try again.",
    details: { fence: 'awaitingOwner' },
    retry: { kind: 'never' },
  },
};

posix('split-lock fences across a daemon restart (CAN-4730 E2-G)', () => {
  beforeEach(async () => {
    dataRoot = await realpath(await mkdtemp(paths.join(tmpdir(), 'fence-')));
    await seedFilesystemRecords(dataRoot);
    secret = randomBytes(32);
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse())
      await close().catch(() => undefined);
    await daemon?.stop('test');
    daemon = undefined;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('refuses writes as awaitingOwner after a restart until the desktop re-publishes on its own, then accepts them within the bound', async () => {
    let running = await start();
    const first = await openWriter(running);
    // The local authority is the same across restarts of one data root.
    const authorityId = first.identity.authorityId;
    if (authorityId === null) throw new Error('The daemon named no authority.');
    // The owner's reconnects wait here while the test holds them.
    let reconnects: Promise<void> = Promise.resolve();
    const service =
      createElectronDaemonConnectionService<ElectronDaemonOwnerClient>({
        enabled: true,
        authorityId,
        lease: {
          label: 'Workflow host steps',
          interactive: false,
          foreground: false,
        },
        attach: async () => {
          await reconnects;
          if (!daemon) throw new Error('The daemon is restarting.');
          return await connectOwner(daemon);
        },
      });
    const owner = new AbortController();
    closers.push(async () => {
      owner.abort();
      await service.dispose();
    });
    const publisher = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: async () =>
        ownerFenceSession(
          await service.get(
            {
              principalId: 'electron-main',
              clientInstanceId: 'electron-main:pipeline-owner',
              authorityId,
              interfaceKind: 'desktop',
              grants: [MUTATION_FENCE_GRANTS.publish],
            },
            owner.signal,
          ),
        ),
      isOwnerUnavailable: () => false,
      locks: () => [],
      retryInitialMs: 25,
      retryMaxMs: 250,
      recheckMs: 100,
    });
    const stop = new AbortController();
    const observing = publisher.keepObserved(stop.signal);
    closers.push(async () => {
      stop.abort();
      await observing;
    });

    // Startup: no split lock is taken or released, yet the desktop
    // publishes its snapshot and writes are accepted.
    await acceptedWithin(first, REPUBLISH_BOUND_MS);

    // The daemon restarts. The owner's reconnect is held so a write can
    // reach the new daemon before the desktop does.
    let reconnect: () => void = () => undefined;
    reconnects = new Promise((resolve) => {
      reconnect = resolve;
    });
    await running.stop('restart');
    daemon = undefined;
    running = await start();
    const writer = await openWriter(running);
    const home = worktreeHome(dataRoot, 'single');
    const before = (await readdir(home)).sort();
    await expect(write(writer)).rejects.toMatchObject(awaitingOwner);
    // The refused delete changed nothing: its file is still there.
    expect((await readdir(home)).length).toBe(before.length + 1);

    // The desktop reaches the restarted daemon and re-publishes on its own.
    reconnect();
    await acceptedWithin(writer, REPUBLISH_BOUND_MS);
  }, 60_000);
});
