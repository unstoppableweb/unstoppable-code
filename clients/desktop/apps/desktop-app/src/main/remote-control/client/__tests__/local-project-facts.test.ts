import { repositoryKeyOf } from '@canopy/desktop-shared/lib/project-groups';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  IPC_CHANNELS,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  createLocalProjectFactsReader,
  localProjectFactsHandler,
  type LocalProjectFactsDeps,
} from '../local-project-facts';
import { ownWindowCheck } from '../paired-computer-window-api';

type ConfigDetail = Awaited<ReturnType<LocalProjectFactsDeps['readConfig']>>;

const BINDING = {
  projectId: '5d2f1a3b-8c4e-4f6a-9b7d-1e2c3a4b5c6d',
  ownerType: 'user',
  accountId: 'account-1',
};

function detail(config: Partial<WorkspaceConfigFile>): ConfigDetail {
  return {
    config: { version: 1, type: 'single-repo', repos: [], ...config },
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  } as unknown as ConfigDetail;
}

function setup(
  configs: Record<string, ConfigDetail | Error>,
  remotes: Record<string, string | null | Error>,
): {
  reader: ReturnType<typeof createLocalProjectFactsReader>;
  readRemote: jest.Mock;
  advance: (ms: number) => void;
} {
  let now = 1_000;
  const readRemote = jest.fn((path: string) => {
    const remote = remotes[path];
    if (remote instanceof Error) return Promise.reject(remote);
    return Promise.resolve(remote ?? null);
  });
  const readConfig = jest.fn((id: string) => {
    const config = configs[id];
    if (config === undefined || config instanceof Error)
      return Promise.reject(config ?? new Error('missing'));
    return Promise.resolve(config);
  });
  const reader = createLocalProjectFactsReader({
    readConfig,
    readRemote,
    now: () => now,
  });
  return {
    reader,
    readRemote,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe("this computer's project facts for the main window (CAN-7766)", () => {
  it('sends each repository as a credential-free address that reads back to the same key, with the stored binding', async () => {
    const { reader } = setup(
      {
        shop: detail({
          repoPath: '/repos/shop',
          cloudBinding:
            BINDING as unknown as WorkspaceConfigFile['cloudBinding'],
        }),
        combo: detail({
          type: 'multi-repo',
          sourceRepoPath: '/repos/combo',
          repos: [
            { id: 'a', name: 'a', repoPath: '/repos/combo/a' },
            { id: 'b', name: 'b', repoPath: '/repos/combo/b' },
          ],
        }),
        notes: detail({ type: 'cowork' }),
      },
      {
        '/repos/shop':
          'https://x-access-token:ghs_secret@github.com/Acme/Shop.git',
        // The root folder is not a repository: Git fails, and it is left out.
        '/repos/combo': new Error('not a git repository'),
        '/repos/combo/a': 'git@github.com:acme/a.git',
        '/repos/combo/b': null,
      },
    );
    const facts = await reader.read(['shop', 'combo', 'notes']);

    expect(facts.shop?.cloudBinding).toEqual(BINDING);
    const [shop] = facts.shop?.repositoryRemotes ?? [];
    expect(shop).not.toContain('ghs_secret');
    expect(shop).not.toContain('x-access-token');
    expect(repositoryKeyOf(shop ?? '')).toBe('github.com/acme/shop');
    expect(facts.combo?.repositoryRemotes).toEqual([
      'https://github.com/acme/a.git',
      null,
    ]);
    expect(facts.combo?.cloudBinding).toBeNull();
    expect(facts.notes?.repositoryRemotes).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain('/repos');
  });

  it('reads Git once per repository while the address is fresh, again after, and again after a failed read', async () => {
    const remotes: Record<string, string | null | Error> = {
      '/repos/shop': 'https://github.com/acme/shop',
    };
    const { reader, readRemote, advance } = setup(
      { shop: detail({ repoPath: '/repos/shop' }) },
      remotes,
    );
    await Promise.all([reader.read(['shop']), reader.read(['shop'])]);
    await reader.read(['shop']);
    expect(readRemote).toHaveBeenCalledTimes(1);
    advance(60_001);
    remotes['/repos/shop'] = new Error('spawn failed');
    expect((await reader.read(['shop'])).shop?.repositoryRemotes).toEqual([
      null,
    ]);
    expect(readRemote).toHaveBeenCalledTimes(2);
    remotes['/repos/shop'] = 'https://github.com/acme/shop';
    expect((await reader.read(['shop'])).shop?.repositoryRemotes).toEqual([
      'https://github.com/acme/shop.git',
    ]);
    expect(readRemote).toHaveBeenCalledTimes(3);
  });

  it("answers only this computer's own windows, and only while the one-window switch is on", async () => {
    interface Sender {
      readonly id: number;
      readonly role: 'own' | 'bridge' | 'shows-another' | 'not-app';
      isDestroyed(): boolean;
    }
    const sender = (id: number, role: Sender['role']): Sender => ({
      id,
      role,
      isDestroyed: () => false,
    });
    let switchOn = true;
    const { reader } = setup(
      { shop: detail({ repoPath: '/repos/shop' }) },
      { '/repos/shop': 'https://github.com/acme/shop' },
    );
    const handle = localProjectFactsHandler<Sender>({
      // The check main uses for the paired-computer window API.
      isOwnWindow: ownWindowCheck<Sender>({
        bridgeController: (sender) =>
          sender.role === 'bridge' ? 'Mb8kQz3Vh2xN0pRt5LwY7a' : null,
        showsAnotherComputer: (sender) => sender.role === 'shows-another',
        isAppWindow: (sender) => sender.role !== 'not-app',
      }),
      isOneWindowEnabled: () => switchOn,
      reader,
    });
    expect(Object.keys(await handle(sender(1, 'own'), ['shop']))).toEqual([
      'shop',
    ]);
    // A paired computer acting here through its bridge window.
    await expect(handle(sender(2, 'bridge'), ['shop'])).rejects.toThrow(
      "Only this computer's main window reads these.",
    );
    // A window that shows another computer.
    await expect(handle(sender(3, 'shows-another'), ['shop'])).rejects.toThrow(
      "Only this computer's main window reads these.",
    );
    await expect(handle(sender(4, 'not-app'), ['shop'])).rejects.toThrow();
    // The switch off: even this computer's own window is refused.
    switchOn = false;
    await expect(handle(sender(1, 'own'), ['shop'])).rejects.toThrow(
      "Only this computer's main window reads these.",
    );
  });

  it('is served on a local channel no paired computer reaches through the tunnel', () => {
    expect(IPC_CHANNELS.remoteControlComputerProjectFacts).toBe(
      'remote-control:computer-project-facts',
    );
    expect(IPC_REMOTE_DISPOSITIONS.remoteControlComputerProjectFacts).toBe(
      'local',
    );
  });

  it("leaves out a project it cannot read, and refuses ids that are not this computer's", async () => {
    const { reader } = setup(
      {
        shop: detail({ repoPath: '/repos/shop' }),
        broken: {
          ...detail({}),
          authority: 'unreadable',
        } as unknown as ConfigDetail,
        gone: new Error('ENOENT'),
      },
      { '/repos/shop': null },
    );
    expect(Object.keys(await reader.read(['shop', 'broken', 'gone']))).toEqual([
      'shop',
    ]);
    await expect(reader.read('shop')).rejects.toThrow();
    await expect(
      reader.read(['computer-Mb8kQz3Vh2xN0pRt5LwY7a:shop']),
    ).rejects.toThrow();
    await expect(reader.read(['../escape'])).rejects.toThrow();
    await expect(reader.read(new Array(2001).fill('shop'))).rejects.toThrow();
  });
});
