import type * as TsxWorkerThreads from '../../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { getDataDir, getWorkspacesRootDir } from '../../paths';
import { __setDesktopW5FileStoreForTests } from '../../w5-commit-log-file-store';
import { nodeW5FileStore } from '../../w5-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../../w5-daemon-record-store';
import { shutdownW5BoundaryHost } from './w5-boundary-host';

/** Real authority and framed record port; no Electron canonical-write exception. */
export async function installRoutedW5GoldenStore(
  options: {
    wrapTransport?: (transport: W5RecordPortTransport) => W5RecordPortTransport;
  } = {},
): Promise<() => Promise<void>> {
  await mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(getDataDir());
  const root = join(dataRoot, 'workspaces');
  await mkdir(root, { recursive: true });
  const dbPath = join(dataRoot, 'w5', 'commit-log.sqlite');
  const repositoryRoot = resolve(__dirname, '../../../../../../..');
  // Match the native CI addon override and build-owned-child.mjs default output.
  const confinementAddon =
    process.platform === 'win32'
      ? resolve(
          repositoryRoot,
          process.env.CANOPY_OWNED_CHILD_ADDON ||
            `.cache/native-owned-child/win32-${process.arch}/core-owned-child.node`,
        )
      : undefined;
  const host = new W5CommitLogHost({
    dbPath,
    root,
    dataRoot,
    workerEntry: join(__dirname, 'w5-commit-log-source-worker.ts'),
    confinementAddon,
  });
  const harness = await startW5DaemonRecordHarness({ host });
  let restore = (): void => undefined;
  try {
    const transport = w5RecordPortTransport(await harness.connect());
    restore = installW5DaemonRecordStoreForTests(
      createW5DaemonRecordStore({
        // The interface projects its selected path; the authority anchors realpath.
        root: getWorkspacesRootDir(),
        transport: options.wrapTransport?.(transport) ?? transport,
      }),
    );
  } catch (error) {
    await harness.close();
    await shutdownW5BoundaryHost(host, dbPath);
    throw error;
  }
  return async (): Promise<void> => {
    await settleDetachedWork();
    restore();
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    try {
      await harness.close();
    } finally {
      await shutdownW5BoundaryHost(host, dbPath);
    }
  };
}
