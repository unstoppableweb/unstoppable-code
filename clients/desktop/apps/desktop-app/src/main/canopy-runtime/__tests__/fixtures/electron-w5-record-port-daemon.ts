import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rename } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveLocalAuthorityIdentity } from '@canopy/core-platform';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type { CanopyRuntimeDescriptor } from '@canopy/protocol/canopy-core';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../../../core-daemon/src/daemon';
import { createDaemonW5Host } from '../../../../../../core-daemon/src/w5-host';
import { createW5BoundaryFixture } from '../../../lib/__tests__/fixtures/w5-boundary-fixture';
import { __resetSidebarItemsStateForTests } from '../../../lib/sidebar-items';
import { __setDesktopW5FileStoreForTests } from '../../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../../lib/w5-file-store';
import { disposeElectronDaemonConnections } from '../../electron-daemon-access';
import {
  setDaemonOwnedForTest,
  setTestDaemonHost,
  testDaemonHost,
  type ElectronDaemonHostStandIn,
} from './electron-w5-record-port-mocks';

/*
 * A real daemon serving W6g's record port on a real commit-log worker, for
 * suites that mock their modules with `electron-w5-record-port-mocks`. Import
 * it after those mocks: it loads the modules they replace.
 */

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(
  __dirname,
  '../../../lib/__tests__/fixtures/w5-commit-log-source-worker.ts',
);

let dir: string | undefined;
let dataRoot: string | undefined;
let daemon: RunningCanopyDaemon | undefined;
let originalDataDir: string | undefined;

/**
 * A fresh boundary fixture whose data root is short and owner-only (the
 * daemon's socket lives under it), as `CANOPY_DATA_DIR`, with the W5
 * namespaces daemon-owned.
 */
export async function setUpW5TestDataRoot(options: {
  /** `mkdtemp` prefix; keep it short. */
  readonly prefix: string;
  readonly worktrees: (createdAt: string) => readonly WorktreeData[];
  readonly additionalWorkspaceIds?: readonly string[];
}): Promise<void> {
  ({ dir } = createW5BoundaryFixture(
    options.worktrees,
    options.additionalWorkspaceIds,
  ));
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), options.prefix)));
  await rename(join(dir, 'data'), dataRoot);
  await chmod(dataRoot, 0o700);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  __resetSidebarItemsStateForTests();
  setDaemonOwnedForTest(W5_NAMESPACES);
}

/** Starts the daemon over the data root and publishes its trusted host. */
export async function startW5TestDaemon(options?: {
  readonly w5Host?: boolean;
  readonly onW5Host?: (host: ReturnType<typeof createDaemonW5Host>) => void;
}): Promise<CanopyRuntimeDescriptor> {
  const root = dataRoot;
  if (!root) throw new Error('Set up the W5 test data root first.');
  daemon = await startCanopyDaemon({
    dataRoot: root,
    secureDataRoot: join(root, 'secure'),
    runtimeMode: 'dev',
    buildVersion: 'test',
    brandId: 'canopy',
    coworkManagedDirName: '.canopy',
    environment: {},
    ...((options?.w5Host ?? true) && { w5Host: true }),
    createW5Host: (hostOptions) => {
      const host = createDaemonW5Host({ ...hostOptions, workerEntry: WORKER });
      options?.onW5Host?.(host);
      return host;
    },
  });
  const { descriptor } = daemon;
  const { authorityId } = await deriveLocalAuthorityIdentity({
    brandId: 'canopy',
    dataRoot: root,
  });
  setTestDaemonHost({
    authorityId,
    canonicalDataRoot: root,
    endpoint: {
      kind: 'socket',
      path: descriptor.endpoint.path,
      auth: {
        secret: await readFile(descriptor.tokenRef, 'utf8'),
        dataRootHash: createHash('sha256').update(root).digest('hex'),
      },
    },
    clients: [],
  });
  return descriptor;
}

/** The running daemon's trusted host; throws when none is published. */
export function requireTestDaemonHost(): ElectronDaemonHostStandIn {
  const host = testDaemonHost();
  if (!host) throw new Error('No test daemon.');
  return host;
}

/** Stops the daemon; its host stays published, so main keeps reconnecting. */
export async function stopW5TestDaemon(): Promise<void> {
  await daemon?.stop('test');
  daemon = undefined;
}

/** Ends main's connections and the daemon, and restores the data root. */
export async function tearDownW5TestDaemon(): Promise<void> {
  await disposeElectronDaemonConnections();
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await stopW5TestDaemon();
  setTestDaemonHost(undefined);
  setDaemonOwnedForTest([]);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const path of [dir, dataRoot])
    if (path) rmSync(path, { recursive: true, force: true });
  dir = undefined;
  dataRoot = undefined;
}

export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  rounds = 500,
): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if (await condition()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
