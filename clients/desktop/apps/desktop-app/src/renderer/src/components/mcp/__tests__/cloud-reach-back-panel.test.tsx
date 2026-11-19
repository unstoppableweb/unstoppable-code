/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import type * as Capability from '@canopy/ui-app/capability';
import { McpRemovalRepair } from '@canopy/ui-app/capability/McpRemovalRepair';
import { McpServerManagementCard } from '@canopy/ui-app/capability/McpServerManagement';
import { MarketplaceDetailPageShell } from '@canopy/ui-app/capability/MarketplaceDetailPageShell';
import {
  CLOUD_REACH_BACK_APPROVAL_PROJECT_ID,
  type ApprovalRequestEvent,
  type CloudReachBackActivityView,
  type CloudReachBackServerView,
} from '@canopy/desktop-shared/types';
import { CloudReachBackApprovalHost } from '../CloudReachBackApprovalHost';
import { CloudReachBackPanel } from '../CloudReachBackPanel';
import { deleteDesktopMcpTarget } from '../mcpManagementOperations';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let signedIn = 'acct-a';

jest.mock('@canopy/app-state/CanopyClientProvider', () => ({
  useCapabilities: (): { cloudReachBack: boolean } => ({
    cloudReachBack: true,
  }),
}));
jest.mock('@/hooks/useCanopyDesktopCloudChatsEnabled', () => ({
  useCanopyDesktopCloudChatsEnabled: (): boolean => true,
}));
jest.mock('@/hooks/useCanopyCloudAccountState', () => ({
  useCanopyCloudAccountState: (): {
    account: { account: { id: string } };
  } => ({ account: { account: { id: signedIn } } }),
}));
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));
jest.mock('@/lib/mcpServerRefs', () => ({ pointRefsAt: jest.fn() }));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: jest.fn() }),
  },
}));
// The section shows what the panel hands it: its saved tools and last calls.
jest.mock('@canopy/ui-app/capability', () => ({
  ...jest.requireActual<typeof Capability>('@canopy/ui-app/capability'),
  CloudReachBackSection: ({
    state,
    calls,
  }: {
    state: { enabledTools: readonly string[] | null } | null;
    calls: readonly { chatTitle: string | null }[];
  }): JSX.Element => (
    <div data-testid="section">
      {JSON.stringify({
        tools: state?.enabledTools ?? null,
        chats: calls.map((call) => call.chatTitle),
      })}
    </div>
  ),
  // The prompt shows which request it asks about.
  ReachBackApprovalDialog: ({
    pending,
  }: {
    pending: { requestId: string };
  }): JSX.Element => <div data-testid="prompt">{pending.requestId}</div>,
}));

interface Pending<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function pending<T>(): Pending<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const server = (tool: string): CloudReachBackServerView => ({
  serverId: 'tracker',
  configId: 'default',
  displayName: 'Tracker',
  enabledTools: [tool],
  allowWithoutAsking: [],
  allowedAt: '2026-11-12T20:00:00.000Z',
  unreachable: null,
});
const call = (title: string): CloudReachBackActivityView => ({
  at: '2026-11-12T20:01:00.000Z',
  chat: { id: `chat-${title}`, title },
  serverId: 'tracker',
  configId: 'default',
  toolName: 'search',
  decision: 'asked_allowed',
  status: 200,
});

let container: HTMLDivElement;
let root: Root;
const lists: Pending<readonly CloudReachBackServerView[]>[] = [];
const activities: Pending<readonly CloudReachBackActivityView[]>[] = [];

beforeEach(() => {
  signedIn = 'acct-a';
  lists.length = 0;
  activities.length = 0;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cloudReachBack: {
        list: (): Promise<readonly CloudReachBackServerView[]> => {
          const next = pending<readonly CloudReachBackServerView[]>();
          lists.push(next);
          return next.promise;
        },
        activity: (): Promise<readonly CloudReachBackActivityView[]> => {
          const next = pending<readonly CloudReachBackActivityView[]>();
          activities.push(next);
          return next.promise;
        },
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => {
    root.render(
      <CloudReachBackPanel
        serverId="tracker"
        serverName="Tracker"
        configs={[{ id: 'default', name: 'Default' }]}
        busy={false}
      />,
    );
  });
}

const shown = (): unknown =>
  JSON.parse(
    container.querySelector('[data-testid="section"]')?.textContent ?? 'null',
  );

it('opens device repair prefilled after a refused detail delete without deleting the cloud connection', async () => {
  const refusal = new Error('Unsafe MCP removal refused');
  const deleteServer = jest.fn().mockRejectedValue(refusal);
  const removeAccountConnection = jest.fn();
  const originalServers = Object.getOwnPropertyDescriptor(window, 'mcpServers');
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { deleteServer, removeAccountConnection },
  });
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error('Unexpected repair mutation'));
  const force = jest.fn(unexpected);
  const onDeleted = jest.fn();
  const client: CanopyClient = {
    capabilities: {
      mcpRemoval: true,
      mcpRemovalForce: true,
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'none',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'read-only',
      routing: 'in-memory',
      overviewNotifications: false,
    },
    query: unexpected,
    command: unexpected,
    subscribe: () => () => undefined,
    mcpRemoval: {
      candidates: () => Promise.resolve({ candidates: [], incomplete: true }),
      inspect: unexpected,
      force,
    },
  };
  const click = async (id: string): Promise<void> => {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-testid="${id}"]`,
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
  };
  try {
    act(() =>
      root.render(
        <>
          <MarketplaceDetailPageShell title="Device server">
            <McpServerManagementCard
              health={{ targetKey: 'a1', configs: [] }}
              management={{
                targetKey: 'a1',
                serverName: 'Device server',
                placement: 'cloud',
                deleteScope: 'device-and-cloud',
                deleteServer: {
                  available: true,
                  run: () =>
                    deleteDesktopMcpTarget({
                      serverId: 'a1',
                      connection: {
                        id: 'cloud-connection',
                        serverKey: 'custom',
                        configId: 'default',
                        displayName: 'Device server',
                        status: 'CONNECTED',
                        kind: 'CUSTOM',
                      },
                    }),
                },
                onDeleted,
              }}
            />
          </MarketplaceDetailPageShell>
          <McpRemovalRepair client={client} />
        </>,
      ),
    );
    expect(
      container.querySelector('[data-testid="mcp-removal-server-id"]'),
    ).toBeNull();
    await click('plugins-entry-detail-more');
    await click('mcp-management-delete');
    await click('mcp-management-delete-confirm');
    expect(deleteServer).toHaveBeenCalledTimes(1);
    expect(deleteServer).toHaveBeenCalledWith('a1');
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="mcp-removal-server-id"]',
      )?.value,
    ).toBe('a1');
    expect(document.body.textContent).toContain(refusal.message);
    expect(removeAccountConnection).not.toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  } finally {
    if (originalServers)
      Object.defineProperty(window, 'mcpServers', originalServers);
    else Reflect.deleteProperty(window, 'mcpServers');
  }
});

describe('the reach-back panel after an account switch (CAN-6176)', () => {
  it('never shows or seeds the previous account’s servers and calls from a late answer', async () => {
    render();
    expect(lists).toHaveLength(1);
    // The person switches accounts while the first account's read is out.
    signedIn = 'acct-b';
    render();
    expect(lists).toHaveLength(2);
    await act(async () => {
      lists[1]?.resolve([server('create_issue')]);
      activities[1]?.resolve([call('Account B chat')]);
      await Promise.resolve();
    });
    expect(shown()).toEqual({
      tools: ['create_issue'],
      chats: ['Account B chat'],
    });
    // The first account's answer arrives late.
    await act(async () => {
      lists[0]?.resolve([server('delete_everything')]);
      activities[0]?.resolve([call('Account A private chat')]);
      await Promise.resolve();
    });
    expect(shown()).toEqual({
      tools: ['create_issue'],
      chats: ['Account B chat'],
    });
  });
});

describe('the reach-back prompt queue (CAN-6176)', () => {
  const prompt = (requestId: string): ApprovalRequestEvent => ({
    surface: 'non-chat',
    requestId,
    projectId: CLOUD_REACH_BACK_APPROVAL_PROJECT_ID,
    worktreeId: 'cloud-reach-back',
    chatId: 'cloud-reach-back',
    provider: 'claude',
    title: 'Plan the launch wants to use search',
    details: { kind: 'tool', toolName: 'search' },
    policyRevision: 1,
  });

  it('never brings back a prompt withdrawn before the first snapshot arrives', async () => {
    let request: (event: ApprovalRequestEvent) => void = () => undefined;
    let cancel: (event: { requestId: string }) => void = () => undefined;
    const snapshot = pending<ApprovalRequestEvent[]>();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        approvals: {
          onRequest: (listener: typeof request): (() => void) => {
            request = listener;
            return () => undefined;
          },
          onCancelled: (listener: typeof cancel): (() => void) => {
            cancel = listener;
            return () => undefined;
          },
          pendingRequests: (): Promise<ApprovalRequestEvent[]> =>
            snapshot.promise,
          respond: (): Promise<boolean> => Promise.resolve(true),
        },
      },
    });
    act(() => {
      root.render(<CloudReachBackApprovalHost />);
    });
    act(() => {
      request(prompt('req-a'));
    });
    expect(container.querySelector('[data-testid="prompt"]')?.textContent).toBe(
      'req-a',
    );
    // Main withdraws it, then the snapshot taken before that arrives.
    act(() => {
      cancel({ requestId: 'req-a' });
    });
    await act(async () => {
      snapshot.resolve([prompt('req-a'), prompt('req-b')]);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="prompt"]')?.textContent).toBe(
      'req-b',
    );
  });
});
