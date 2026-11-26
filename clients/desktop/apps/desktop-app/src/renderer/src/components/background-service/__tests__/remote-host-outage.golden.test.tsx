/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient, SessionViewModel } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import type {
  BackgroundServiceStatus,
  W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  publishRecoveryShellSnapshot,
  resetRecoveryShellSnapshotStore,
} from '@/stores/recoveryShellSnapshotStore';
import {
  defaultRemoteControlState,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { HomeSurface } from '@/components/home/HomeSurface';
import { DesktopSharedSidebarHost } from '@/components/sidebar/DesktopSharedSidebarHost';
import { WorkspaceRecoveryNotice } from '../WorkspaceRecoveryNotice';

const HOST_DEVICE_ID = 'host-linux-rimrock';
const ORG_ID = 'org_unstoppable';
const noop = (): void => undefined;

const PRELOAD_BRIDGES = [
  'agents',
  'appErrors',
  'bundles',
  'collections',
  'electron',
  'installedItems',
  'invocableInventory',
  'mcp',
  'mcpServers',
  'pipelines',
  'plugins',
  'skillShareNudge',
  'skillSuggestions',
  'skills',
] as const;

const RECOVERED_PROJECT_ITEM = {
  type: 'single-repo' as const,
  id: 'canopy',
  name: 'canopy',
  repoPath: '/home/host/canopy',
  color: '#3B82F6',
  collapsed: false,
  order: 0,
  worktrees: [],
  owner: {
    type: 'organization' as const,
    organizationId: ORG_ID,
    projectId: 'proj-1',
    instanceId: 'inst-1',
    bindingGeneration: 1,
  },
};

function emptySessionSnapshot(
  overrides: Partial<SessionViewModel> = {},
): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...overrides,
  };
}

interface TransportHarness {
  readonly client: CanopyClient;
  readonly invokeCalls: Array<{
    readonly channel: string;
    readonly args: readonly unknown[];
  }>;
  readonly emitSnapshotStale: () => void;
}

function createDesktopClientOverTransport(
  onSessionSnapshot: (args: {
    readonly noticesOnly?: boolean;
  }) => Promise<SessionViewModel>,
): TransportHarness {
  const invokeCalls: Array<{
    readonly channel: string;
    readonly args: readonly unknown[];
  }> = [];
  const listenersByChannel = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();

  Object.defineProperty(window, 'canopyClientTransport', {
    configurable: true,
    writable: true,
    value: {
      invoke: jest.fn((channel: string, ...args: unknown[]) => {
        invokeCalls.push({ channel, args });
        if (channel === REMOTE_IPC_CHANNELS.desktopSessionSnapshot) {
          return onSessionSnapshot(
            (args[0] as { readonly noticesOnly?: boolean } | undefined) ?? {},
          );
        }
        return Promise.resolve([]);
      }),
      send: jest.fn(),
      on: jest.fn((channel: string, listener: (...args: unknown[]) => void) => {
        let listeners = listenersByChannel.get(channel);
        if (!listeners) {
          listeners = new Set();
          listenersByChannel.set(channel, listeners);
        }
        listeners.add(listener);
        return (): void => {
          listeners?.delete(listener);
        };
      }),
    },
  });

  const client = createDesktopCanopyClient(
    createDesktopCapabilities('darwin', {}, {}),
  );

  return {
    client,
    invokeCalls,
    emitSnapshotStale: () => {
      const listeners = listenersByChannel.get(
        REMOTE_IPC_CHANNELS.desktopSessionSnapshotStale,
      );
      if (!listeners) return;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

function createPendingResult(): unknown {
  const never = (): Promise<never> => new Promise(() => undefined);
  return Object.assign(() => undefined, {
    then: never,
    catch: never,
    finally: never,
  });
}

function createBridgeProxy(overrides: Record<string, unknown> = {}): unknown {
  const wrap = (target: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(target, {
      get(obj, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop in obj) return obj[prop];
        const fn = (): unknown => createPendingResult();
        return wrap(fn as unknown as Record<string, unknown>);
      },
    });
  return wrap(overrides);
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitForRefreshThrottle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320));
  });
  await flushMicrotasks();
}

async function waitForCoalescedProjectsReload(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 460));
  });
  await flushMicrotasks();
}

describe('Remote desktop window host daemon outage (CAN-7946)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let loadProjectsSpy: jest.Mock;
  let ensureOrgDefaultCoworkWorkspaceSpy: jest.Mock;
  let backgroundServiceGetStatusSpy: jest.Mock;
  let w5RecoveryGetStatusSpy: jest.Mock;
  let worktreesFileChangedListeners: Set<() => void>;
  let unsubscribeProjectLifecycle: (() => void) | null = null;
  const previousApi = window.api;
  const previousTransport = (window as unknown as Record<string, unknown>)
    .canopyClientTransport;
  const previousBridges = new Map<string, unknown>();
  const consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    resetRecoveryShellSnapshotStore();
    useSidebarItemGroupsStore.setState({
      byScope: {},
      orderByScope: {},
      errors: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    loadProjectsSpy = jest.fn(() =>
      Promise.resolve({
        version: 1,
        items: [],
        stale: true,
      }),
    );
    ensureOrgDefaultCoworkWorkspaceSpy = jest.fn(() =>
      Promise.resolve(undefined),
    );
    worktreesFileChangedListeners = new Set();
    backgroundServiceGetStatusSpy = jest.fn(() =>
      Promise.resolve({
        state: 'ok',
        retry: 'idle',
        sequence: 0,
      }),
    );
    w5RecoveryGetStatusSpy = jest.fn(() =>
      Promise.resolve({
        state: 'hidden',
        canRecover: false,
        entries: [],
      }),
    );

    const win = window as unknown as Record<string, unknown>;
    previousBridges.clear();
    for (const bridge of PRELOAD_BRIDGES) {
      previousBridges.set(bridge, win[bridge]);
      Object.defineProperty(window, bridge, {
        configurable: true,
        writable: true,
        value: createBridgeProxy(),
      });
    }

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: createBridgeProxy({
        platform: 'darwin',
        loadProjects: loadProjectsSpy,
        loadPreferences: jest.fn(() =>
          Promise.resolve({
            version: 1,
            preferences: {},
          }),
        ),
        listChatProjects: jest.fn(() => Promise.resolve([])),
        loadAllStandaloneChats: jest.fn(() => Promise.resolve([])),
        listModelCatalog: jest.fn(() =>
          Promise.resolve({
            models: [],
            defaultModel: null,
          }),
        ),
        loadAvailableProviders: jest.fn(() => Promise.resolve([])),
        loadCanopyCloudAccount: jest.fn(() =>
          Promise.resolve({
            hasApiKey: false,
            credentialSource: null,
          }),
        ),
        loadCanopyCloudEntitlements: jest.fn(() => Promise.resolve({})),
        chatProject: {
          revealFolderLocation: jest.fn(() => Promise.resolve(undefined)),
          ensureOrgDefaultCoworkWorkspace: ensureOrgDefaultCoworkWorkspaceSpy,
        },
        onWorktreeGitReady: jest.fn(() => noop),
        onWorktreeGitFailed: jest.fn(() => noop),
        onWorktreeNeedsRepair: jest.fn(() => noop),
        onWorktreeBranchChanged: jest.fn(() => noop),
        onWorkspaceWorktreesUpdated: jest.fn(() => noop),
        onWorktreesFileChanged: jest.fn((listener: () => void) => {
          worktreesFileChangedListeners.add(listener);
          return (): void => {
            worktreesFileChangedListeners.delete(listener);
          };
        }),
        onWorkspaceSplitTemporaryComplete: jest.fn(() => noop),
        sidebarItemGroups: {
          list: jest.fn(() => Promise.resolve([])),
          onChanged: jest.fn(() => noop),
        },
        workEntryAutoDelete: {
          list: jest.fn(() => Promise.resolve({ attention: [] })),
          onChanged: jest.fn(() => noop),
        },
        workspaceContext: {
          get: jest.fn(() =>
            Promise.resolve({
              context: { kind: 'organization', organizationId: ORG_ID },
              organizations: [{ id: ORG_ID, name: 'Unstoppable.ai' }],
              revision: 1,
            }),
          ),
          onChanged: jest.fn(() => noop),
        },
        orgProjects: {
          list: jest.fn(() =>
            Promise.resolve({
              organizationId: ORG_ID,
              projects: [],
              status: 'ready',
            }),
          ),
          onChanged: jest.fn(() => noop),
          onOwnershipChanged: jest.fn(() => noop),
        },
        remoteControl: {
          getContext: jest.fn(() => ({
            mode: 'remote',
            deviceId: HOST_DEVICE_ID,
            name: 'rimrock-linux-desktop',
            platform: 'linux',
          })),
          getState: jest.fn(() => Promise.resolve(defaultRemoteControlState())),
          onStateChanged: jest.fn(() => noop),
        },
        backgroundService: {
          getStatus: backgroundServiceGetStatusSpy,
          retry: jest.fn(() =>
            Promise.resolve({
              state: 'ok',
              retry: 'idle',
              sequence: 0,
            }),
          ),
          onStatusChanged: jest.fn(() => noop),
        },
        w5Recovery: {
          getStatus: w5RecoveryGetStatusSpy,
          prepare: jest.fn(() =>
            Promise.resolve({
              state: 'hidden',
              canRecover: false,
              entries: [],
            }),
          ),
        },
        restartApp: jest.fn(() => Promise.resolve(false)),
      }),
    });

    useRemoteControlStore.setState({
      hydrated: true,
      context: {
        mode: 'remote',
        deviceId: HOST_DEVICE_ID,
        name: 'rimrock-linux-desktop',
        platform: 'linux',
      },
      state: {
        ...defaultRemoteControlState(),
        available: true,
        signedIn: true,
      },
    });
    useFeatureFlagsStore.setState((state) => ({
      ...state,
      snapshot: {
        ...state.snapshot,
        values: {
          ...state.snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    }));
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG_ID },
        organizations: [
          {
            id: ORG_ID,
            name: 'Unstoppable.ai',
            role: 'MEMBER',
          },
        ],
        revision: 1,
      },
    });
    useProjectsStore.setState({
      projects: [],
      isLoading: false,
      hasHydratedProjects: true,
      projectInventoryStatus: 'ready',
      failedWorkspaceIds: new Set(),
      projectLoadWarnings: [],
    });
    useStandaloneChatStore.setState({
      scopedWorkspaceId: null,
    });
    useHomeComposerStore.setState({
      workspaceId: null,
    });
    useNavigationStore.setState({
      activePage: 'home',
    });
    unsubscribeProjectLifecycle = useProjectsStore
      .getState()
      .subscribeToWorktreeGitLifecycleEvents();
  });

  afterEach(() => {
    unsubscribeProjectLifecycle?.();
    unsubscribeProjectLifecycle = null;
    act(() => {
      root.unmount();
    });
    container.remove();
    resetRecoveryShellSnapshotStore();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: previousApi,
    });
    Object.defineProperty(window, 'canopyClientTransport', {
      configurable: true,
      writable: true,
      value: previousTransport,
    });
    for (const [bridge, previous] of previousBridges) {
      Object.defineProperty(window, bridge, {
        configurable: true,
        writable: true,
        value: previous,
      });
    }
    previousBridges.clear();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it('falls back to noticesOnly over desktop:session-snapshot, renders read-only outage notices, and recovers automatically when the host signals snapshot-stale', async () => {
    const outageStatus: BackgroundServiceStatus = {
      state: 'unavailable',
      reason: 'reconnect_failed',
      retry: 'idle',
      sequence: 2,
    };
    let hostDown = true;

    loadProjectsSpy.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        items: hostDown ? [] : [RECOVERED_PROJECT_ITEM],
        stale: hostDown,
      }),
    );

    const harness = createDesktopClientOverTransport(({ noticesOnly }) => {
      if (noticesOnly === true) {
        return Promise.resolve(
          emptySessionSnapshot({
            backgroundService: hostDown ? outageStatus : undefined,
            w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
          }),
        );
      }
      if (hostDown) {
        return Promise.reject(
          new Error(
            "RpcRemoteError: W5AuthorityUnreachableError: Couldn't save this change because the background service isn't running.",
          ),
        );
      }
      return Promise.resolve(
        emptySessionSnapshot({
          workspaces: [
            {
              localId: 'canopy',
              name: 'canopy',
              type: 'single-repo',
              order: 0,
              owner: {
                type: 'organization',
                organizationId: ORG_ID,
                projectId: 'proj-1',
              },
            },
          ],
          w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
        }),
      );
    });

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
          <HomeSurface variant="page" />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    // 1. Real desktop client fell back to noticesOnly on the wire channel
    //    without touching blocked local background-service/w5-recovery IPCs.
    expect(
      harness.invokeCalls.some(
        (call) =>
          call.channel === REMOTE_IPC_CHANNELS.desktopSessionSnapshot &&
          (call.args[0] as { readonly noticesOnly?: boolean } | undefined)
            ?.noticesOnly !== true,
      ),
    ).toBe(true);
    expect(harness.invokeCalls).toContainEqual({
      channel: REMOTE_IPC_CHANNELS.desktopSessionSnapshot,
      args: [{ noticesOnly: true }],
    });
    expect(backgroundServiceGetStatusSpy).not.toHaveBeenCalled();
    expect(w5RecoveryGetStatusSpy).not.toHaveBeenCalled();

    // 2. WorkspaceRecoveryNotice renders the host's outage notice read-only:
    //    Copy diagnostics only, no local Try again or Restart app buttons.
    const bgNotice = container.querySelector(
      '[data-testid="background-service-notice"]',
    );
    expect(bgNotice).not.toBeNull();
    expect(bgNotice?.textContent).toContain(
      "Couldn't reach the background service",
    );
    expect(bgNotice?.textContent).toContain('paired computer');
    expect(
      container.querySelector(
        '[data-testid="background-service-notice-copy-diagnostics"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="background-service-notice-retry"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="background-service-notice-restart"]',
      ),
    ).toBeNull();

    // 3. Sidebar shows the outage notice instead of spinning on loading placeholders.
    const sidebarNotice = container.querySelector(
      '[data-testid="sidebar-remote-host-unavailable"]',
    );
    expect(sidebarNotice).not.toBeNull();
    expect(sidebarNotice?.textContent).toContain(
      "Couldn't reach the background service",
    );
    expect(
      container.querySelector('[data-testid="delayed-loading-placeholder"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-section-code-loading"]'),
    ).toBeNull();

    // 4. Home composer explains why it can't prepare the chat without waiting 10s.
    const homeNotice = container.querySelector(
      '[data-testid="home-default-chats-unavailable"]',
    );
    expect(homeNotice).not.toBeNull();
    expect(homeNotice?.textContent).toContain('Couldn’t prepare this chat');
    expect(homeNotice?.textContent).toContain(
      "Couldn't reach the background service",
    );
    expect(homeNotice?.textContent).toContain('paired computer');
    expect(homeNotice?.textContent).toContain('Your draft is kept.');

    // 5. Automatic snapshot-driven recovery: once the host recovers and pushes
    //    both desktop:session-snapshot-stale and worktrees:file-changed
    //    (without clicking any retry button), notices clear, the recovered
    //    project renders in the sidebar, projects reload once (coalesced),
    //    and Home clears its unavailability notice.
    hostDown = false;
    loadProjectsSpy.mockClear();
    await waitForRefreshThrottle();
    act(() => {
      harness.emitSnapshotStale();
      for (const listener of Array.from(worktreesFileChangedListeners)) {
        listener();
      }
    });
    await waitForCoalescedProjectsReload();

    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-remote-host-unavailable"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="home-default-chats-unavailable"]'),
    ).toBeNull();
    expect(container.textContent).toContain('canopy');
    expect(loadProjectsSpy).toHaveBeenCalledTimes(1);
    expect(
      useProjectsStore.getState().projects.map((project) => project.id),
    ).toContain('canopy');
  });

  it('delegates Home Try again to the shared sidebar refresh without issuing a duplicate project load', async () => {
    const outageStatus: BackgroundServiceStatus = {
      state: 'unavailable',
      reason: 'reconnect_failed',
      retry: 'idle',
      sequence: 2,
    };
    let hostDown = true;

    loadProjectsSpy.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        items: hostDown ? [] : [RECOVERED_PROJECT_ITEM],
        stale: hostDown,
      }),
    );

    const harness = createDesktopClientOverTransport(({ noticesOnly }) => {
      if (noticesOnly === true) {
        return Promise.resolve(
          emptySessionSnapshot({
            backgroundService: hostDown ? outageStatus : undefined,
            w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
          }),
        );
      }
      if (hostDown) {
        return Promise.reject(new Error('W5AuthorityUnreachableError'));
      }
      return Promise.resolve(
        emptySessionSnapshot({
          workspaces: [
            {
              localId: 'canopy',
              name: 'canopy',
              type: 'single-repo',
              order: 0,
              owner: {
                type: 'organization',
                organizationId: ORG_ID,
                projectId: 'proj-1',
              },
            },
          ],
          w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
        }),
      );
    });

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
          <HomeSurface variant="page" />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    hostDown = false;
    loadProjectsSpy.mockClear();
    const homeRetry = container.querySelector<HTMLButtonElement>(
      '[data-testid="home-default-chats-retry"]',
    );
    expect(homeRetry).not.toBeNull();
    await waitForRefreshThrottle();
    act(() => {
      homeRetry?.click();
    });
    await waitForCoalescedProjectsReload();

    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).toBeNull();
    expect(ensureOrgDefaultCoworkWorkspaceSpy).not.toHaveBeenCalled();
    expect(loadProjectsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not treat a healthy host W5 recovery advisory as an outage on Home or reload projects on every refresh', async () => {
    const blockedRecovery: W5RecoveryStatus = {
      state: 'blocked',
      canRecover: true,
      entries: [
        {
          id: 'entry-1',
          operation: 'workspace.save',
          detail: 'blocked on host',
        },
      ],
    };
    const harness = createDesktopClientOverTransport(() =>
      Promise.resolve(
        emptySessionSnapshot({
          w5Recovery: blockedRecovery,
        }),
      ),
    );

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
          <HomeSurface variant="page" />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    expect(
      container.querySelector('[data-testid="w5-recovery-notice"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="home-default-chats-unavailable"]'),
    ).toBeNull();

    await waitForCoalescedProjectsReload();
    loadProjectsSpy.mockClear();
    act(() => {
      harness.emitSnapshotStale();
    });
    await waitForCoalescedProjectsReload();
    expect(loadProjectsSpy).not.toHaveBeenCalled();
  });

  it('renders read-only w5Recovery, startup-backup, and replay-masked repair-command notices and clears stale notices with custom onSnapshot', async () => {
    const repairOutage: BackgroundServiceStatus = {
      state: 'unavailable',
      reason: 'endpoint_repair_required',
      retry: 'idle',
      sequence: 2,
    };
    let mode: 'repair' | 'backup-warning' = 'repair';
    const customOnSnapshot = jest.fn();

    const harness = createDesktopClientOverTransport(({ noticesOnly }) => {
      if (mode === 'repair') {
        if (noticesOnly === true) {
          return Promise.resolve(
            emptySessionSnapshot({
              backgroundService: repairOutage,
              w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
            }),
          );
        }
        return Promise.reject(new Error('W5AuthorityUnreachableError'));
      }
      return Promise.resolve(
        emptySessionSnapshot({
          backgroundService: {
            state: 'ok',
            retry: 'idle',
            sequence: 3,
            backupWarning: 'source-unreadable',
          },
          w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
        }),
      );
    });

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={customOnSnapshot}
          />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    const bgNotice = container.querySelector(
      '[data-testid="background-service-notice"]',
    );
    expect(bgNotice).not.toBeNull();
    expect(bgNotice?.querySelector(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    expect(
      container
        .querySelector(
          '[data-testid="background-service-notice-copy-diagnostics"]',
        )
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();

    const sidebarNotice = container.querySelector(
      '[data-testid="sidebar-remote-host-unavailable"]',
    );
    expect(sidebarNotice).not.toBeNull();
    expect(
      sidebarNotice?.querySelector(`.${REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();

    mode = 'backup-warning';
    await waitForRefreshThrottle();
    act(() => {
      harness.emitSnapshotStale();
    });
    await flushMicrotasks();

    expect(customOnSnapshot).toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="startup-backup-notice"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="startup-backup-notice-copy-diagnostics"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-remote-host-unavailable"]',
      ),
    ).toBeNull();
  });

  it('skips a duplicate recovery reload when worktrees:file-changed already reloaded projects more than 400 ms before the recovery snapshot', async () => {
    const outageStatus: BackgroundServiceStatus = {
      state: 'unavailable',
      reason: 'reconnect_failed',
      retry: 'idle',
      sequence: 2,
    };
    let hostDown = true;

    loadProjectsSpy.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        items: hostDown ? [] : [RECOVERED_PROJECT_ITEM],
        stale: hostDown ? true : undefined,
      }),
    );

    const harness = createDesktopClientOverTransport(({ noticesOnly }) => {
      if (noticesOnly === true) {
        return Promise.resolve(
          emptySessionSnapshot({
            backgroundService: hostDown ? outageStatus : undefined,
            w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
          }),
        );
      }
      if (hostDown) {
        return Promise.reject(new Error('W5AuthorityUnreachableError'));
      }
      return Promise.resolve(
        emptySessionSnapshot({
          workspaces: [
            {
              localId: 'canopy',
              name: 'canopy',
              type: 'single-repo',
              order: 0,
              owner: {
                type: 'organization',
                organizationId: ORG_ID,
                projectId: 'proj-1',
              },
            },
          ],
          w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
        }),
      );
    });

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
          <HomeSurface variant="page" />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).not.toBeNull();

    // Host recovers and worktrees:file-changed fires and completes its 400 ms
    // debounced reload BEFORE the delayed session.snapshot recovery lands.
    hostDown = false;
    loadProjectsSpy.mockClear();
    act(() => {
      for (const listener of Array.from(worktreesFileChangedListeners)) {
        listener();
      }
    });
    await waitForCoalescedProjectsReload();
    expect(loadProjectsSpy).toHaveBeenCalledTimes(1);

    // Delayed snapshot-stale arrives more than 400 ms after worktrees:file-changed.
    act(() => {
      harness.emitSnapshotStale();
    });
    await waitForCoalescedProjectsReload();

    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).toBeNull();
    expect(container.textContent).toContain('canopy');
    expect(loadProjectsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let recovery overwrite and drop a pending worktrees:file-changed reload when an in-flight load finishes authoritatively', async () => {
    const outageStatus: BackgroundServiceStatus = {
      state: 'unavailable',
      reason: 'reconnect_failed',
      retry: 'idle',
      sequence: 2,
    };
    const updatedProjectItem = {
      ...RECOVERED_PROJECT_ITEM,
      id: 'canopy-worktree-update',
      name: 'canopy-worktree-update',
      order: 1,
    };
    let hostDown = true;

    const harness = createDesktopClientOverTransport(({ noticesOnly }) => {
      if (noticesOnly === true) {
        return Promise.resolve(
          emptySessionSnapshot({
            backgroundService: hostDown ? outageStatus : undefined,
            w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
          }),
        );
      }
      if (hostDown) {
        return Promise.reject(new Error('W5AuthorityUnreachableError'));
      }
      return Promise.resolve(
        emptySessionSnapshot({
          workspaces: [
            {
              localId: 'canopy',
              name: 'canopy',
              type: 'single-repo',
              order: 0,
              owner: {
                type: 'organization',
                organizationId: ORG_ID,
                projectId: 'proj-1',
              },
            },
          ],
          w5Recovery: { state: 'hidden', canRecover: false, entries: [] },
        }),
      );
    });

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <WorkspaceRecoveryNotice />
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
          <HomeSurface variant="page" />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    expect(
      container.querySelector('[data-testid="background-service-notice"]'),
    ).not.toBeNull();

    await waitForRefreshThrottle();

    hostDown = false;
    let resolveInFlightLoad: ((value: unknown) => void) | null = null;
    const inFlightLoad = new Promise((resolve) => {
      resolveInFlightLoad = resolve;
    });
    loadProjectsSpy.mockClear();
    loadProjectsSpy
      .mockImplementationOnce(() => inFlightLoad)
      .mockImplementationOnce(() =>
        Promise.resolve({
          version: 1,
          items: [RECOVERED_PROJECT_ITEM, updatedProjectItem],
        }),
      );

    // 1. An inventory load is already in flight.
    act(() => {
      void useProjectsStore.getState().loadProjects({ silent: true });
    });
    expect(loadProjectsSpy).toHaveBeenCalledTimes(1);

    // 2. worktrees:file-changed schedules a debounced reload while load #1 is pending.
    act(() => {
      for (const listener of Array.from(worktreesFileChangedListeners)) {
        listener();
      }
    });

    // 3. Recovery snapshot lands and calls requestRemoteRecoveryProjectsReload.
    act(() => {
      harness.emitSnapshotStale();
    });
    await flushMicrotasks();

    // 4. The in-flight load finishes authoritatively, advancing the load epoch.
    act(() => {
      resolveInFlightLoad?.({
        version: 1,
        items: [RECOVERED_PROJECT_ITEM],
      });
    });
    await flushMicrotasks();

    // 5. After the debounce window, the worktrees:file-changed reload must still run.
    await waitForCoalescedProjectsReload();

    expect(loadProjectsSpy).toHaveBeenCalledTimes(2);
    expect(
      useProjectsStore.getState().projects.map((project) => project.id),
    ).toContain('canopy-worktree-update');
  });

  it('does not query noticesOnly in local desktop mode when session.snapshot fails', async () => {
    useRemoteControlStore.setState({
      hydrated: true,
      context: { mode: 'local' },
      state: defaultRemoteControlState(),
    });
    const harness = createDesktopClientOverTransport(() =>
      Promise.reject(new Error('W5AuthorityUnreachableError')),
    );

    act(() => {
      root.render(
        <CanopyClientProvider client={harness.client}>
          <DesktopSharedSidebarHost
            client={harness.client}
            onSnapshot={publishRecoveryShellSnapshot}
          />
        </CanopyClientProvider>,
      );
    });
    await flushMicrotasks();

    expect(
      harness.invokeCalls.some(
        (call) =>
          call.channel === REMOTE_IPC_CHANNELS.desktopSessionSnapshot &&
          (call.args[0] as { readonly noticesOnly?: boolean } | undefined)
            ?.noticesOnly !== true,
      ),
    ).toBe(true);
    expect(harness.invokeCalls).not.toContainEqual({
      channel: REMOTE_IPC_CHANNELS.desktopSessionSnapshot,
      args: [{ noticesOnly: true }],
    });
    expect(
      container.querySelector(
        '[data-testid="sidebar-remote-host-unavailable"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="delayed-loading-placeholder"]'),
    ).not.toBeNull();
  });
});
