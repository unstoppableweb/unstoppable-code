/**
 * Scheduled runs act as a named account (CAN-6233). A run nobody watches
 * never picks between a person's accounts, never falls back to another
 * account when the one it names is gone, and stops before sending anything,
 * with a named reason and a notice to its owner.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountMcpConnection } from '@canopy/protocol/mcp-servers';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins';
import {
  automationAccountProblems,
  type AutomationAccountCheckInput,
} from '@canopy/desktop-shared/lib/automation-accounts';
import {
  effectiveChatPluginSelections,
  withoutAccountsPickedOver,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';

let mockDataDir = '';
let mockConnections: AccountMcpConnection[] | null = [];
let mockPluginKeys: string[] = [];
// The sign-in each plugin server uses, as the inventory reports it.
let mockPluginHandler: {
  authHandler: string;
  httpAuthHandlerSource: 'default' | 'server' | 'override';
} = { authHandler: 'account', httpAuthHandlerSource: 'default' };
let mockCollectionRefs: { serverId: string; configId: string }[] = [];
let mockDisabledCollections = new Set<string>();
// What the chat's session layers add (the person's global defaults).
let mockGlobalPlugins: ChatTabPluginSelections['pluginRefs'] = [];
const mockNotify = jest.fn<void, [{ title: string; body: string }]>();

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getDataDir: (): string => mockDataDir,
}));
jest.mock('../../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => true,
  loadAccountMcpRefConnections: (): Promise<AccountMcpConnection[] | null> =>
    Promise.resolve(mockConnections),
}));
jest.mock('../../mcp/curated-catalog', () => ({
  readCachedCuratedMcpDesktopOnlyKeys: (): Promise<ReadonlySet<string>> =>
    Promise.resolve(new Set<string>()),
  readCachedCuratedMcpServers: (): Promise<{
    servers: { key: string; name: string }[];
  }> => Promise.resolve({ servers: [{ key: 'slack', name: 'Slack' }] }),
}));
// The session's selection filter: collections expand into their refs, and a
// turned-off collection contributes nothing.
jest.mock('../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: (
    selections: ChatTabPluginSelections,
  ): Promise<{
    pluginRefs: ChatTabPluginSelections['pluginRefs'];
    mcpServerRefs: { serverId: string; configId: string }[];
  }> =>
    Promise.resolve({
      pluginRefs: selections.pluginRefs,
      mcpServerRefs: [
        ...(selections.mcpServerRefs ?? []),
        ...selections.collectionIds.flatMap((id) =>
          mockDisabledCollections.has(id) ? [] : mockCollectionRefs,
        ),
      ],
    }),
}));
jest.mock('../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: (
    local: ChatTabPluginSelections,
  ): Promise<{ selections: ChatTabPluginSelections }> =>
    Promise.resolve({
      selections: {
        ...local,
        pluginRefs: [...local.pluginRefs, ...mockGlobalPlugins],
      },
    }),
}));
jest.mock('../../plugins/mcp-inventory', () => ({
  listDetectedMcpServersForSelections: (): Promise<{
    servers: {
      source: 'plugin';
      curatedKey: string;
      authHandler: string;
      httpAuthHandlerSource: 'default' | 'server' | 'override';
    }[];
    warnings: string[];
  }> =>
    Promise.resolve({
      servers: mockPluginKeys.map((curatedKey) => ({
        source: 'plugin' as const,
        curatedKey,
        ...mockPluginHandler,
      })),
      warnings: [],
    }),
}));
jest.mock('../../ipc/os-notifications', () => ({
  showOsNotification: (request: {
    title: string;
    body: string;
  }): {
    shown: boolean;
  } => {
    mockNotify(request);
    return { shown: true };
  },
}));
jest.mock('../../lib/space-notification-gate', () => ({
  isSpaceNotificationDeliverable: (): boolean => true,
}));

import {
  AutomationAccountUnavailableError,
  assertAutomationAccountsReady,
} from '../automation-account-preflight';
import { withAutomationSendAs } from '@canopy/ui-app/capability/accountMcpRows';
import { resolveAutomationPromptPlugins } from '../../agent-messaging/turn-override';

function slack(
  configId: string,
  label: string,
  overrides: Partial<AccountMcpConnection> = {},
): AccountMcpConnection {
  return {
    id: `conn-${configId}`,
    kind: 'CURATED',
    serverKey: 'slack',
    configId,
    displayName: 'Slack',
    label,
    isDefault: configId === 'default',
    routeId: `route-${configId}`,
    status: 'CONNECTED',
    enabledTools: null,
    enabled: true,
    ...overrides,
  };
}

const acme = slack('default', 'acme');
const globex = slack('acct-globex', 'globex');
const ref = (configId: string): { serverId: string; configId: string } => ({
  serverId: 'slack',
  configId,
});

function check(
  input: Partial<AutomationAccountCheckInput>,
): ReturnType<typeof automationAccountProblems> {
  return automationAccountProblems({
    connections: [acme, globex],
    directRefs: [],
    pluginCuratedKeys: [],
    isDeviceServer: () => false,
    curatedConnectors: new Map([['slack', 'Slack']]),
    ...input,
  });
}

describe('the accounts a scheduled run acts as (CAN-6233)', () => {
  it('runs as the account it names, or the only account', () => {
    expect(check({ directRefs: [ref('acct-globex')] })).toEqual([]);
    // A locally generated config still reaches the person's only account.
    expect(
      check({ connections: [globex], directRefs: [ref('cfg-local')] }),
    ).toEqual([]);
    expect(
      check({ connections: [globex], pluginCuratedKeys: ['slack'] }),
    ).toEqual([]);
  });

  it('never picks between accounts, nor falls back to the default', () => {
    expect(check({ directRefs: [ref('cfg-local')] })).toEqual([
      { reason: 'choose', serverKey: 'slack', connector: 'Slack' },
    ]);
    expect(check({ pluginCuratedKeys: ['slack'] })).toEqual([
      { reason: 'choose', serverKey: 'slack', connector: 'Slack' },
    ]);
    // "Send as" names an account: a plugin's server acts as it.
    expect(
      check({ directRefs: [ref('acct-globex')], pluginCuratedKeys: ['slack'] }),
    ).toEqual([]);
  });

  it('names an account that is gone or not connected', () => {
    // Removed: the automation's account no longer exists, even with another.
    expect(
      check({ connections: [acme], directRefs: [ref('acct-globex')] }),
    ).toEqual([{ reason: 'gone', serverKey: 'slack', connector: 'Slack' }]);
    expect(check({ connections: [], directRefs: [ref('default')] })).toEqual([
      { reason: 'gone', serverKey: 'slack', connector: 'Slack' },
    ]);
    expect(
      check({
        connections: [
          acme,
          slack('acct-globex', 'globex', { status: 'REAUTH_REQUIRED' }),
        ],
        directRefs: [ref('acct-globex')],
      }),
    ).toEqual([
      {
        reason: 'disconnected',
        serverKey: 'slack',
        connector: 'Slack',
        account: 'globex',
      },
    ]);
    expect(
      check({
        connections: [slack('default', 'acme', { enabled: false })],
        pluginCuratedKeys: ['slack'],
      }),
    ).toEqual([
      {
        reason: 'disconnected',
        serverKey: 'slack',
        connector: 'Slack',
        account: 'acme',
      },
    ]);
  });

  it('leaves device servers alone', () => {
    expect(
      check({
        directRefs: [{ serverId: 'local-files', configId: 'default' }],
        isDeviceServer: (id) => id === 'local-files',
      }),
    ).toEqual([]);
    // A device server that was removed is not an account.
    expect(
      check({ directRefs: [{ serverId: 'gone-device', configId: 'default' }] }),
    ).toEqual([]);
  });
});

describe('a run that cannot act as its account stops (CAN-6233)', () => {
  const run = { automationName: 'Daily digest' };
  const selections = (
    mcpServerRefs: { serverId: string; configId: string }[],
    pluginRefs: { marketplaceId: string; pluginName: string }[] = [],
  ): ChatTabPluginSelections => ({
    collectionIds: [],
    skillRefs: [],
    pluginRefs,
    mcpServerRefs,
  });

  beforeEach(() => {
    mockDataDir = mkdtempSync(join(tmpdir(), 'automation-accounts-'));
    mockConnections = [acme, globex];
    mockPluginKeys = [];
    mockCollectionRefs = [];
    mockDisabledCollections = new Set();
    mockPluginHandler = {
      authHandler: 'account',
      httpAuthHandlerSource: 'default',
    };
    mockGlobalPlugins = [];
    mockNotify.mockClear();
  });
  afterEach(() => {
    rmSync(mockDataDir, { recursive: true, force: true });
  });

  it('lets a run whose account is ready through, with no notice', async () => {
    await expect(
      assertAutomationAccountsReady(selections([ref('acct-globex')]), run),
    ).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('stops before sending, names the reason and tells the owner', async () => {
    const stopped = assertAutomationAccountsReady(
      selections([ref('cfg-local')]),
      run,
    );
    await expect(stopped).rejects.toBeInstanceOf(
      AutomationAccountUnavailableError,
    );
    await expect(stopped).rejects.toThrow(
      'This run stopped before sending anything. You have several Slack accounts. Choose which one this automation sends as.',
    );
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]?.[0]).toMatchObject({
      title: "Daily digest didn't run",
    });
  });

  it("stops a plugin's connector with several accounts and no choice", async () => {
    mockPluginKeys = ['slack'];
    await expect(
      assertAutomationAccountsReady(
        selections(
          [],
          [
            {
              marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
              pluginName: 'slack-tools',
            },
          ],
        ),
        run,
      ),
    ).rejects.toThrow('Choose which one this automation sends as.');
  });

  it('stops when the accounts cannot be read, and only then', async () => {
    mockConnections = null;
    await expect(
      assertAutomationAccountsReady(selections([ref('acct-globex')]), run),
    ).rejects.toThrow("the accounts it sends as couldn't be checked");
    // Nothing names an account: a device-only run is not held up.
    await expect(
      assertAutomationAccountsReady(selections([]), run),
    ).resolves.toBeUndefined();
  });

  it("ignores a plugin's server set to its provider's sign-in", async () => {
    mockPluginKeys = ['slack'];
    mockPluginHandler = {
      authHandler: 'provider',
      httpAuthHandlerSource: 'override',
    };
    await expect(
      assertAutomationAccountsReady(
        selections(
          [],
          [
            {
              marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
              pluginName: 'slack-tools',
            },
          ],
        ),
        run,
      ),
    ).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('still asks for an unbound plugin server that keeps the default sign-in', async () => {
    // Several accounts and no default (an older cloud): the inventory leaves
    // the row unbound with the global default handler.
    mockConnections = [
      slack('acct-acme', 'acme', { isDefault: false }),
      slack('acct-globex', 'globex', { isDefault: false }),
    ];
    mockPluginKeys = ['slack'];
    mockPluginHandler = {
      authHandler: 'canopy',
      httpAuthHandlerSource: 'default',
    };
    await expect(
      assertAutomationAccountsReady(
        selections(
          [],
          [
            {
              marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
              pluginName: 'slack-tools',
            },
          ],
        ),
        run,
      ),
    ).rejects.toThrow('Choose which one this automation sends as.');
  });

  it('checks the global defaults the chat inherits', async () => {
    mockGlobalPlugins = [
      {
        marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
        pluginName: 'slack-tools',
      },
    ];
    mockPluginKeys = ['slack'];
    // Without the chat it runs in, the automation's own selections hold
    // nothing to check.
    await expect(
      assertAutomationAccountsReady(selections([]), run),
    ).resolves.toBeUndefined();
    await expect(
      assertAutomationAccountsReady(undefined, {
        ...run,
        target: { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
      }),
    ).rejects.toThrow('Choose which one this automation sends as.');
  });

  it('ignores a turned-off collection, which the run never loads', async () => {
    mockCollectionRefs = [ref('acct-removed')];
    mockDisabledCollections = new Set(['team-tools']);
    await expect(
      assertAutomationAccountsReady(
        { ...selections([]), collectionIds: ['team-tools'] },
        run,
      ),
    ).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('stops a connector a collection brings whose account is gone', async () => {
    mockCollectionRefs = [ref('acct-removed')];
    await expect(
      assertAutomationAccountsReady(
        { ...selections([]), collectionIds: ['team-tools'] },
        run,
      ),
    ).rejects.toThrow(
      'The Slack account this automation sends as is gone. Choose another account.',
    );
  });
});

describe('choosing Send as clears the stop (CAN-6233)', () => {
  it('replaces a ref that named no account, so the run can act as the choice', () => {
    const before = { mcpServerRefs: [ref('cfg-local')] };
    expect(check({ directRefs: before.mcpServerRefs })).toEqual([
      { reason: 'choose', serverKey: 'slack', connector: 'Slack' },
    ]);
    const after = withAutomationSendAs(before, 'slack', 'acct-globex', [
      'default',
      'acct-globex',
    ]);
    expect(after.mcpServerRefs).toEqual([ref('acct-globex')]);
    expect(check({ directRefs: after.mcpServerRefs })).toEqual([]);
  });

  it("settles a collection's connector, which the form can't edit", () => {
    const collectionRefs = [ref('cfg-team')];
    expect(check({ directRefs: collectionRefs })).toEqual([
      { reason: 'choose', serverKey: 'slack', connector: 'Slack' },
    ]);
    // Send as adds the choice beside the collection's ref, which then loads
    // nothing: the run acts as the chosen account.
    const own = withAutomationSendAs(
      { mcpServerRefs: [] },
      'slack',
      'acct-globex',
      ['default', 'acct-globex'],
    );
    expect(
      check({ directRefs: [...(own.mcpServerRefs ?? []), ...collectionRefs] }),
    ).toEqual([]);
  });

  it("sends a plugin's server as the choice beside a ref naming no account", () => {
    expect(
      check({
        directRefs: [ref('acct-globex'), ref('cfg-team')],
        pluginCuratedKeys: ['slack'],
      }),
    ).toEqual([]);
  });
});

describe('a deleted legacy account stops the run (CAN-6233)', () => {
  beforeEach(() => {
    mockDataDir = mkdtempSync(join(tmpdir(), 'automation-accounts-'));
    mockConnections = [acme, globex];
    mockNotify.mockClear();
  });
  afterEach(() => {
    rmSync(mockDataDir, { recursive: true, force: true });
  });

  it('names it rather than dropping it', async () => {
    await expect(
      assertAutomationAccountsReady(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'account:conn-deleted', configId: 'default' },
          ],
        },
        { automationName: 'Daily digest' },
      ),
    ).rejects.toThrow(
      'This run stopped before sending anything. An account this automation sends as is gone. Choose another account.',
    );
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("acts as the automation's pick over the project's other account", () => {
    const own = { mcpServerRefs: [ref('default')] };
    const project: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [ref('acct-globex')],
    };
    // Merged as the session layers them, the project's other account drops.
    const inherited = withoutAccountsPickedOver(project, own);
    expect(inherited?.mcpServerRefs).toEqual([]);
    expect(
      effectiveChatPluginSelections({
        local: { ...project, mcpServerRefs: own.mcpServerRefs },
        projectDefaults: project,
      }).mcpServerRefs,
    ).toEqual([ref('default')]);
    expect(
      check({
        directRefs: [...(inherited?.mcpServerRefs ?? []), ...own.mcpServerRefs],
        pluginCuratedKeys: ['slack'],
      }),
    ).toEqual([]);
  });

  it("replaces the chat's other account in an existing chat", async () => {
    const tab: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [ref('default')],
    };
    const merged = await resolveAutomationPromptPlugins(tab, undefined, {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [ref('acct-globex')],
    });
    expect(merged?.mcpServerRefs).toEqual([ref('acct-globex')]);
    expect(
      check({
        directRefs: merged?.mcpServerRefs ?? [],
        pluginCuratedKeys: ['slack'],
      }),
    ).toEqual([]);
  });
});
