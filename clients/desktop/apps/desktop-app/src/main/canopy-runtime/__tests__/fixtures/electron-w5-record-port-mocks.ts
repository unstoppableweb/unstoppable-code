import type * as CoreClientNode from '@canopy/core-client/node';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as ElectronDaemonHost from '../../electron-daemon-host';

/*
 * Module mock factories for suites that lease the W5 record port through
 * main's real daemon connection service to a test daemon. Only type imports
 * at the top: a factory loads this module while another module is loading.
 * Use each one from a hoisted mock, for example:
 *
 *   jest.mock('../electron-daemon-host', () =>
 *     jest
 *       .requireActual<typeof W5RecordPortMocks>('./fixtures/electron-w5-record-port-mocks')
 *       .createElectronDaemonHostMock(),
 *   );
 *
 * `jest.requireActual` and a plain import share one instance, so the state
 * below is what both the mocks and the suite see.
 */

/** The trusted host main's access module resolves, over the test daemon. */
export interface ElectronDaemonHostStandIn {
  readonly authorityId: string;
  readonly canonicalDataRoot: string;
  readonly endpoint: CoreClientNode.CanopyConnectOptions['endpoint'];
  /** Every connection main attached, oldest first. */
  readonly clients: { close(): Promise<void>; signal: AbortSignal }[];
}

let testHost: ElectronDaemonHostStandIn | undefined;

/** The test daemon's host; none rejects host setup and every attach. */
export function testDaemonHost(): ElectronDaemonHostStandIn | undefined {
  return testHost;
}

export function setTestDaemonHost(
  host: ElectronDaemonHostStandIn | undefined,
): void {
  testHost = host;
}

let ownershipRows: CoreStorage.StorageOwnershipRow[] | undefined;

/** `@canopy/core-runtime/storage` whose ownership rows the suite can flip. */
export function createStorageMock(): object {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  // Same array every checked writer reads, the daemon authority's included.
  ownershipRows = [...actual.STORAGE_OWNERSHIP];
  return { ...actual, STORAGE_OWNERSHIP: ownershipRows };
}

/** Makes `namespaceIds` daemon-owned with no other writer; `[]` restores. */
export function setDaemonOwnedForTest(namespaceIds: readonly string[]): void {
  const rows = ownershipRows;
  if (!rows) throw new Error('The storage mock is not installed.');
  const { STORAGE_OWNERSHIP } = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  STORAGE_OWNERSHIP.forEach((row, index) => {
    rows[index] = namespaceIds.includes(row.id)
      ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
      : row;
  });
}

/** `../electron-daemon-host` whose trusted host is {@link testDaemonHost}. */
export function createElectronDaemonHostMock(): object {
  const actual = jest.requireActual<typeof ElectronDaemonHost>(
    '../../electron-daemon-host',
  );
  const node = jest.requireActual<typeof CoreClientNode>(
    '@canopy/core-client/node',
  );
  // Only the fields main's access module reads.
  const createElectronDaemonHost = (): Promise<object> => {
    const host = testHost;
    if (!host) return Promise.reject(new Error('No test daemon.'));
    return Promise.resolve({
      authorityId: host.authorityId,
      canonicalDataRoot: host.canonicalDataRoot,
      launch: {},
      connect: async (
        options: Parameters<typeof node.connectCanopyClient>[0],
      ): Promise<unknown> => {
        const client = await node.connectCanopyClient(options);
        host.clients.push(client);
        return client;
      },
    });
  };
  return { ...actual, createElectronDaemonHost };
}

/** `@canopy/core-client/node` whose launcher only attaches: no daemon starts. */
export function createCoreClientNodeMock(): object {
  const actual = jest.requireActual<typeof CoreClientNode>(
    '@canopy/core-client/node',
  );
  return {
    ...actual,
    attachOrStartCanopyDaemon: async <T>(
      options: CoreClientNode.CanopyDaemonLaunchOptions<T>,
    ): Promise<{ value: T }> => {
      const host = testHost;
      if (!host) throw new Error('No test daemon.');
      return {
        value: await options.attach(host.endpoint, {
          timeoutMs: 5_000,
          signal: options.signal ?? new AbortController().signal,
        }),
      };
    },
  };
}

export function createElectronMock(): object {
  return { app: { getVersion: () => '0.0.0', isPackaged: false } };
}

export function createObservabilityMock(): object {
  return {
    getObservabilityService: jest.fn(() => ({
      purgeWorktreeData: jest.fn(() => Promise.resolve()),
      recordAppDiagnostic: jest.fn(),
      recordUsageMetricEvent: jest.fn(),
    })),
  };
}

/** What main's handlers would refresh: each targeted list, and `broad`. */
export const refreshedRegistries: string[] = [];

/** Main's commit event handlers, recording into {@link refreshedRegistries}. */
export function createCommitEventHandlersMock(): object {
  return {
    createDesktopWorkspaceCommitEventHandlers: (): object => ({
      scheduleDesktopStructureChanged: (): void => undefined,
      refreshWorkspaceRegistries: (): Promise<void> => {
        refreshedRegistries.push('broad');
        return Promise.resolve();
      },
      reconcileManifestPluginDefaults: (): Promise<void> => Promise.resolve(),
      listWorkspaceIds: (): string[] => [],
      readWorktreeList: (workspaceId: string): Promise<object> => {
        refreshedRegistries.push(workspaceId);
        return Promise.resolve({ authority: 'ok', worktrees: [] });
      },
      publishWorktreeListWrite: (): void => undefined,
      publishWorktreeMembershipChange: (): void => undefined,
    }),
  };
}
