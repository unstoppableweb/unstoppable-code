/**
 * CAN-7082: start page URLs a remote-control controller sends back. Drives
 * the real host session over an encrypted session pair. The controller gets
 * each start page URL without its credential parts; one it sends back
 * exactly as it got it reaches main as the stored value, byte for byte, and
 * any other reaches main as sent, never carrying the old credential. Only the
 * bridge window (main) and the store read are fakes.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
const diagnostics: unknown[] = [];
jest.mock('../../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: (entry: unknown) => void;
  } => ({
    recordAppDiagnostic: (entry: unknown): void => {
      diagnostics.push(entry);
    },
  }),
}));
import type { HostBridge } from '../host/bridge-window';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import {
  CONTROLLER_SENT_BACK_URL_CHANNELS,
  controllerCredentialFreeUrl,
  mergeControllerUrl,
} from '../host/controller-remote-urls';
import {
  ControllerUrlWritebacks,
  CONTROLLER_START_PAGE_UNREADABLE,
  CONTROLLER_URL_WRITEBACK_FIELDS,
  type StoredStartPageFields,
  type StoredStartPages,
} from '../host/controller-url-writebacks';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import { REMOTE_METHODS, REMOTE_PROTOCOL_VERSION } from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';
import { readFileSync } from 'node:fs';

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};

const PROJECT = 'project-a';
const OTHER_PROJECT = 'project-b';

/** A stored start page URL, and the secret part of it a controller never sees. */
const STORED_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['https://user:pa55word@pages.example.invalid/p', 'pa55word'],
  ['https://pages.example.invalid/p?token=t0k3n', 't0k3n'],
  ['https://pages.example.invalid/p?access_token=t0k3n', 't0k3n'],
  ['https://pages.example.invalid/p?token=t%2F0k3n%3D', 't%2F0k3n'],
  ['https://pages.example.invalid/p?ref=main&token=t0k3n#frag', 't0k3n'],
  // A cut-short password with an `@` left after it fails closed to `''`.
  ['https://user:pa/ss@pages.example.invalid/p@q', 'pa/ss'],
];

type Request = (url: string) => unknown[];

/** Each channel a controller writes a start page through, and where main reads it. */
const WRITES: ReadonlyArray<
  readonly [string, Request, (args: readonly unknown[]) => unknown]
> = [
  [
    IPC_CHANNELS.projectsSave,
    (url) => [
      [
        {
          id: PROJECT,
          type: 'single-repo',
          name: 'Project',
          startPage: { kind: 'url', url },
        },
      ],
    ],
    (args) => pick(args, 0, 0, 'startPage', 'url'),
  ],
  [
    IPC_CHANNELS.workspaceSetStartPage,
    (url) => [{ workspaceId: PROJECT, startPage: { kind: 'url', url } }],
    (args) => pick(args, 0, 'startPage', 'url'),
  ],
  [
    IPC_CHANNELS.chatProjectUpdate,
    (url) => [{ projectId: PROJECT, startPage: { kind: 'url', url } }],
    (args) => pick(args, 0, 'startPage', 'url'),
  ],
  [
    IPC_CHANNELS.workspaceApplySourceChanges,
    (url) => [
      {
        workspaceId: PROJECT,
        target: { mode: 'existing', worktreeId: 'worktree-1' },
        startPage: { kind: 'url', url },
      },
    ],
    (args) => pick(args, 0, 'startPage', 'url'),
  ],
  [
    IPC_CHANNELS.projectApplySourceChanges,
    (url) => [
      {
        projectId: PROJECT,
        target: { mode: 'new', existingWorktreeIds: [] },
        startPage: { kind: 'url', url },
      },
    ],
    (args) => pick(args, 0, 'startPage', 'url'),
  ],
];

function pick(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function urlPage(url: string): ProjectStartPage {
  return { kind: 'url', url };
}

interface Harness {
  controller: RpcPeer;
  session: RemoteHostSession;
  /** Every call that reached main, in order. */
  received: Array<{ channel: string; args: unknown[] }>;
  /** The start pages each project stores. */
  stored: Map<string, ProjectStartPage[]>;
  /** A project's start pages by field, in place of `stored`'s one for all. */
  fields: Map<string, StoredStartPageFields>;
  /** Projects `projects:load` delivers, by id. */
  items: Map<string, ProjectStartPage | undefined>;
  /** What main's replies held before the controller got them. */
  replies: unknown[];
  reads: Array<[string, string | undefined]>;
  close: () => void;
}

async function harness(
  options: {
    reader?: boolean;
    revoke?: () => Promise<void>;
    answers?: Readonly<Record<string, unknown>>;
    /** Holds main's reply to a call until the promise it returns settles. */
    hold?: (channel: string) => Promise<void> | undefined;
  } = {},
): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const received: Array<{ channel: string; args: unknown[] }> = [];
  const stored = new Map<string, ProjectStartPage[]>();
  const fields = new Map<string, StoredStartPageFields>();
  const items = new Map<string, ProjectStartPage | undefined>();
  const replies: unknown[] = [];
  const reads: Array<[string, string | undefined]> = [];
  const reply = (channel: string): unknown => {
    if (options.answers && channel in options.answers)
      return options.answers[channel];
    if (channel === IPC_CHANNELS.projectsLoad)
      return {
        items: [...items].map(([id, startPage]) => ({
          id,
          type: 'single-repo',
          name: id,
          ...(startPage ? { startPage } : {}),
        })),
      };
    if (channel === IPC_CHANNELS.startPageResolve) {
      const [startPage] = stored.get(PROJECT) ?? [];
      return startPage ? { startPage, source: 'local' } : null;
    }
    return null;
  };
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: async (channel: string, args: unknown[]): Promise<unknown> => {
      received.push({ channel, args });
      const value = reply(channel);
      replies.push(value);
      await options.hold?.(channel);
      return value;
    },
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const storedStartPages: StoredStartPages = (projectId, worktreeId) => {
    reads.push([projectId, worktreeId]);
    const [startPage] = stored.get(projectId) ?? [];
    return Promise.resolve(
      fields.get(projectId) ??
        (startPage
          ? {
              local: startPage,
              cowork: startPage,
              worktreeManifest: startPage,
              sourceManifest: startPage,
            }
          : {}),
    );
  };
  const session = new RemoteHostSession({
    session: responder,
    kind: 'desktop',
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(
      join(tmpdir(), 'controller-writeback-uploads'),
    ),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
    ...(options.revoke ? { revokeOwnPairing: options.revoke } : {}),
    ...(options.reader === false ? {} : { storedStartPages }),
  });
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (): void => undefined,
  });
  await controller.request(REMOTE_METHODS.hello, { version: VERSION });
  await session.start();
  return {
    controller,
    session,
    received,
    stored,
    fields,
    items,
    replies,
    reads,
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

/** Everything a test logged, as text, to check it holds no secret. */
function logged(spies: ReadonlyArray<jest.SpyInstance>): string {
  const calls: unknown[] = spies.map((spy): unknown => spy.mock.calls);
  return JSON.stringify([...calls, diagnostics]);
}

describe('start page URLs a paired controller sends back (CAN-7082)', () => {
  let current: Harness | null = null;
  let spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    diagnostics.length = 0;
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      jest.spyOn(console, name).mockImplementation(() => undefined),
    );
  });
  afterEach(() => {
    current?.close();
    current = null;
    for (const spy of spies) spy.mockRestore();
  });

  const invoke = (channel: string, args: unknown[] = []): Promise<unknown> => {
    if (!current) throw new Error('no harness');
    return current.controller.request(REMOTE_METHODS.invoke, { channel, args });
  };

  /** What main got for the last call on `channel`. */
  const lastReceived = (channel: string): unknown[] => {
    const calls = current?.received.filter((call) => call.channel === channel);
    const last = calls?.[calls.length - 1];
    if (!last) throw new Error(`main never got ${channel}`);
    return last.args;
  };

  it('keeps the stored token byte for byte when a controller sends back the URL it got', async () => {
    for (const [form, secret] of STORED_FORMS)
      for (const [channel, request, sentUrl] of WRITES) {
        current?.close();
        current = await harness();
        current.stored.set(PROJECT, [urlPage(form)]);
        current.items.set(PROJECT, urlPage(form));
        const got =
          channel === IPC_CHANNELS.projectsSave
            ? pick(
                await invoke(IPC_CHANNELS.projectsLoad),
                'items',
                0,
                'startPage',
                'url',
              )
            : pick(
                await invoke(IPC_CHANNELS.startPageResolve),
                'startPage',
                'url',
              );
        expect(got).toBe(controllerCredentialFreeUrl(form));
        expect(got).not.toContain(secret);
        if (typeof got !== 'string') throw new Error('no start page URL');
        await invoke(channel, request(got));
        expect(sentUrl(lastReceived(channel))).toBe(form);
      }
    expect(logged(spies)).not.toMatch(/pa55word|t0k3n|pa\/ss/);
  });

  it('never carries the stored token to a changed host, port, scheme, path or query', async () => {
    const stored =
      'https://u:t0k3n@pages.example.invalid:8443/a?ref=main&token=t0k3n';
    expect(controllerCredentialFreeUrl(stored)).toBe(
      'https://pages.example.invalid:8443/a?ref=main',
    );
    const changed = [
      'https://other.example.invalid:8443/a?ref=main',
      'https://PAGES.example.invalid:8443/a?ref=main',
      'https://pages.example.invalid.:8443/a?ref=main',
      'https://pages.example.invalid/a?ref=main',
      'https://pages.example.invalid:443/a?ref=main',
      'https://pages.example.invalid:8444/a?ref=main',
      'http://pages.example.invalid:8443/a?ref=main',
      'https://pages.example.invalid:8443/a/?ref=main',
      'https://pages.example.invalid:8443/A?ref=main',
      'https://pages.example.invalid:8443/b?ref=main',
      'https://pages.example.invalid:8443/%61?ref=main',
      'https://pages.example.invalid:8443/a?ref=dev',
      'https://pages.example.invalid:8443/a',
    ];
    current = await harness();
    current.stored.set(PROJECT, [urlPage(stored)]);
    current.items.set(PROJECT, urlPage(stored));
    await invoke(IPC_CHANNELS.projectsLoad);
    for (const url of changed)
      for (const [channel, request, sentUrl] of WRITES) {
        await invoke(channel, request(url));
        expect(sentUrl(lastReceived(channel))).toBe(url);
      }
    expect(JSON.stringify(current.received.slice(1))).not.toContain('t0k3n');
    expect(logged(spies)).not.toContain('t0k3n');
  });

  it('stores a credential the controller typed exactly as sent, never mixed with the old one', async () => {
    current = await harness();
    current.stored.set(PROJECT, [
      urlPage('https://old:s3cret@pages.example.invalid/a?token=0ld'),
    ]);
    for (const url of [
      'https://pages.example.invalid/a?token=n3w',
      'https://me:n3w@pages.example.invalid/a',
      'https://other.example.invalid/a?token=n3w',
    ])
      for (const [channel, request, sentUrl] of WRITES) {
        await invoke(channel, request(url));
        expect(sentUrl(lastReceived(channel))).toBe(url);
      }
    expect(JSON.stringify(current.received)).not.toMatch(/s3cret|0ld/);
  });

  it("never carries another project's token, nor reads a record by an id main refuses", async () => {
    current = await harness();
    const other = 'https://pages.example.invalid/b?token=0th3r';
    current.stored.set(OTHER_PROJECT, [urlPage(other)]);
    for (const [channel, request, sentUrl] of WRITES) {
      await invoke(channel, request(controllerCredentialFreeUrl(other)));
      expect(sentUrl(lastReceived(channel))).toBe(
        controllerCredentialFreeUrl(other),
      );
    }
    expect(JSON.stringify(current.received)).not.toContain('0th3r');
    expect(current.reads.every(([projectId]) => projectId === PROJECT)).toBe(
      true,
    );
    expect(current.reads).toContainEqual([PROJECT, 'worktree-1']);
  });

  it("keeps a local edit when a controller saves the sidebar with the start page it didn't touch", async () => {
    current = await harness();
    const delivered = 'https://pages.example.invalid/p?token=d3l1vered';
    current.items.set(PROJECT, urlPage(delivered));
    current.stored.set(PROJECT, [urlPage(delivered)]);
    const got = pick(
      await invoke(IPC_CHANNELS.projectsLoad),
      'items',
      0,
      'startPage',
      'url',
    );
    if (typeof got !== 'string') throw new Error('no start page URL');
    // The person changes the start page on this computer meanwhile.
    current.stored.set(PROJECT, [
      urlPage('https://elsewhere.example.invalid/q?token=l0cal'),
    ]);
    const [, request, sentUrl] = WRITES[0] ?? [];
    if (!request || !sentUrl) throw new Error('no projects:save');
    await invoke(IPC_CHANNELS.projectsSave, request(got));
    // Main gets what it delivered, so its save finds no edit and keeps the
    // newer stored page; the save's items are the next save's baseline.
    expect(sentUrl(lastReceived(IPC_CHANNELS.projectsSave))).toBe(delivered);
    current.stored.set(PROJECT, []);
    await invoke(IPC_CHANNELS.projectsSave, request(got));
    expect(sentUrl(lastReceived(IPC_CHANNELS.projectsSave))).toBe(delivered);
  });

  it('strips a start page URL at any depth of every channel that sends one, and nothing else', async () => {
    const form =
      'https://user:pa55word@pages.example.invalid/p?ref=main&token=t0k3n';
    const reply = {
      startPage: urlPage(form),
      items: [{ cowork: { startPage: urlPage(form) } }],
      file: { startPage: { kind: 'file', path: 'README.md' } },
      link: { url: form },
    };
    const channels = CONTROLLER_SENT_BACK_URL_CHANNELS.filter(
      (channel) => !channel.startsWith('mcp-servers:'),
    );
    expect(channels).toHaveLength(23);
    current = await harness({
      answers: Object.fromEntries(channels.map((channel) => [channel, reply])),
    });
    const stripped = controllerCredentialFreeUrl(form);
    for (const channel of channels)
      expect(await invoke(channel)).toEqual({
        startPage: urlPage(stripped),
        items: [{ cowork: { startPage: urlPage(stripped) } }],
        file: { startPage: { kind: 'file', path: 'README.md' } },
        link: { url: form },
      });
  });

  it('gives the sign-in URL start-account mints only its OAuth request parameters', async () => {
    const minted =
      'https://user:pa55word@auth.example.invalid/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcb&scope=read&state=st4te&code_challenge=ch&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.example.invalid&access_type=offline&prompt=select_account%20consent&code=c0de&client_secret=s3cret&access_token=t0k3n&token=t0k3n&unknown=x&ref=main#frag';
    current = await harness({
      answers: {
        [MCP_SERVER_CHANNELS.START_ACCOUNT]: { authorizationUrl: minted },
      },
    });
    expect(
      await invoke(MCP_SERVER_CHANNELS.START_ACCOUNT, [
        { customUrl: 'https://mcp.example.invalid' },
      ]),
    ).toEqual({
      authorizationUrl:
        'https://auth.example.invalid/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcb&scope=read&state=st4te&code_challenge=ch&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.example.invalid&access_type=offline&prompt=select_account%20consent',
    });
  });

  it("keeps the newest load's start pages when an older load finishes after it", async () => {
    const releases: Array<() => void> = [];
    current = await harness({
      hold: (channel) =>
        channel === IPC_CHANNELS.projectsLoad
          ? new Promise<void>((resolve) => {
              releases.push(resolve);
            })
          : undefined,
    });
    const waitFor = async (count: number): Promise<void> => {
      for (let index = 0; index < 50 && releases.length < count; index += 1)
        await flushRelay();
      expect(releases).toHaveLength(count);
    };
    const old = 'https://pages.example.invalid/p?token=0ldtoken';
    const rotated = 'https://pages.example.invalid/p?token=r0tated';
    current.items.set(PROJECT, urlPage(old));
    current.stored.set(PROJECT, [urlPage(old)]);
    const older = invoke(IPC_CHANNELS.projectsLoad);
    await waitFor(1);
    // The token is rotated on this computer before the newer load runs.
    current.items.set(PROJECT, urlPage(rotated));
    current.stored.set(PROJECT, [urlPage(rotated)]);
    const newer = invoke(IPC_CHANNELS.projectsLoad);
    await waitFor(2);
    releases[1]?.();
    const got = pick(await newer, 'items', 0, 'startPage', 'url');
    releases[0]?.();
    await older;
    if (typeof got !== 'string') throw new Error('no start page URL');
    const [, request, sentUrl] = WRITES[0] ?? [];
    if (!request || !sentUrl) throw new Error('no projects:save');
    await invoke(IPC_CHANNELS.projectsSave, request(got));
    expect(sentUrl(lastReceived(IPC_CHANNELS.projectsSave))).toBe(rotated);
    expect(
      JSON.stringify(lastReceived(IPC_CHANNELS.projectsSave)),
    ).not.toContain('0ldtoken');
  });

  /** The stored field each write channel replaces, as WRITES sends it. */
  const OWN_FIELD: Readonly<Record<string, keyof StoredStartPageFields>> = {
    [IPC_CHANNELS.projectsSave]: 'local',
    [IPC_CHANNELS.workspaceSetStartPage]: 'local',
    [IPC_CHANNELS.chatProjectUpdate]: 'cowork',
    [IPC_CHANNELS.workspaceApplySourceChanges]: 'worktreeManifest',
    [IPC_CHANNELS.projectApplySourceChanges]: 'sourceManifest',
  };
  const ALL_FIELDS: ReadonlyArray<keyof StoredStartPageFields> = [
    'local',
    'cowork',
    'worktreeManifest',
    'sourceManifest',
  ];
  const TOKENED = 'https://pages.example.invalid/p?token=f1eld';
  const PLAIN = controllerCredentialFreeUrl(TOKENED);

  it('restores a start page only from the stored field its write replaces', async () => {
    for (const [channel, request, sentUrl] of WRITES) {
      current?.close();
      current = await harness();
      const own = OWN_FIELD[channel];
      if (own === undefined) throw new Error(`no field for ${channel}`);
      current.fields.set(PROJECT, { [own]: urlPage(TOKENED) });
      await invoke(channel, request(PLAIN));
      expect(sentUrl(lastReceived(channel))).toBe(TOKENED);
    }
  });

  it("never gives a field another field's credential, such as the source canopy.json's", async () => {
    for (const [channel, request, sentUrl] of WRITES) {
      current?.close();
      current = await harness();
      const own = OWN_FIELD[channel];
      const others = Object.fromEntries(
        ALL_FIELDS.filter((field) => field !== own).map((field) => [
          field,
          urlPage(TOKENED),
        ]),
      );
      // A turned-off local setting beside a source canopy.json with a token.
      current.fields.set(
        PROJECT,
        own === 'local' ? { ...others, local: null } : others,
      );
      await invoke(channel, request(PLAIN));
      expect(sentUrl(lastReceived(channel))).toBe(PLAIN);
      expect(JSON.stringify(lastReceived(channel))).not.toContain('f1eld');
    }
  });

  it('stops at a credential-free match instead of falling through to a stored credential', async () => {
    current = await harness();
    current.items.set(PROJECT, urlPage(PLAIN));
    current.fields.set(PROJECT, { local: urlPage(PLAIN) });
    await invoke(IPC_CHANNELS.projectsLoad);
    // A token is added to the setting on this computer after the load.
    current.fields.set(PROJECT, { local: urlPage(TOKENED) });
    const [, request, sentUrl] = WRITES[0] ?? [];
    if (!request || !sentUrl) throw new Error('no projects:save');
    await invoke(IPC_CHANNELS.projectsSave, request(PLAIN));
    // Main gets what it delivered, finds no edit, and keeps the stored token.
    expect(sentUrl(lastReceived(IPC_CHANNELS.projectsSave))).toBe(PLAIN);
    expect(mergeControllerUrl(PLAIN, [PLAIN, TOKENED])).toEqual({
      kind: 'as-sent',
    });
  });

  it("returns main's own values unchanged while the controller gets them stripped", async () => {
    current = await harness();
    const form = 'https://pages.example.invalid/p?token=t0k3n';
    current.items.set(PROJECT, urlPage(form));
    current.stored.set(PROJECT, [urlPage(form)]);
    await invoke(IPC_CHANNELS.projectsLoad);
    await invoke(IPC_CHANNELS.startPageResolve);
    expect(current.replies).toEqual([
      {
        items: [
          {
            id: PROJECT,
            type: 'single-repo',
            name: PROJECT,
            startPage: urlPage(form),
          },
        ],
      },
      { startPage: urlPage(form), source: 'local' },
    ]);
  });

  it('refuses a start page URL it cannot check against the stored one, before main', async () => {
    current = await harness({ reader: false });
    await expect(
      invoke(IPC_CHANNELS.workspaceSetStartPage, [
        {
          workspaceId: PROJECT,
          startPage: urlPage('https://pages.example.invalid/p'),
        },
      ]),
    ).rejects.toThrow(CONTROLLER_START_PAGE_UNREADABLE);
    expect(current.received).toEqual([]);
    // A URL the controller typed a credential into needs no check.
    await invoke(IPC_CHANNELS.workspaceSetStartPage, [
      {
        workspaceId: PROJECT,
        startPage: urlPage('https://pages.example.invalid/p?token=n3w'),
      },
    ]);
    expect(current.received).toHaveLength(1);
  });

  it('drops the delivered start pages when the session ends or its pairing is revoked', async () => {
    const reader: StoredStartPages = () => Promise.resolve({});
    const writebacks = new ControllerUrlWritebacks(reader);
    const delivered = 'https://pages.example.invalid/p?token=d3l1vered';
    const save = [
      [{ id: PROJECT, type: 'single-repo', startPage: urlPage(delivered) }],
    ];
    writebacks.record(
      'main',
      IPC_CHANNELS.projectsLoad,
      [],
      { items: save[0] },
      writebacks.begin('main', IPC_CHANNELS.projectsLoad),
    );
    const sent = [
      [
        {
          id: PROJECT,
          type: 'single-repo',
          startPage: urlPage(controllerCredentialFreeUrl(delivered)),
        },
      ],
    ];
    expect(
      pick(
        await writebacks.merge('main', IPC_CHANNELS.projectsSave, sent),
        0,
        0,
        'startPage',
        'url',
      ),
    ).toBe(delivered);
    writebacks.clear();
    expect(
      pick(
        await writebacks.merge('main', IPC_CHANNELS.projectsSave, sent),
        0,
        0,
        'startPage',
        'url',
      ),
    ).toBe(controllerCredentialFreeUrl(delivered));

    const clear = jest.spyOn(ControllerUrlWritebacks.prototype, 'clear');
    current = await harness();
    current.close();
    current = null;
    await flushRelay();
    expect(clear).toHaveBeenCalledTimes(1);
    current = await harness({ revoke: (): Promise<void> => Promise.resolve() });
    await current.controller.request(REMOTE_METHODS.pairRevoke, {});
    expect(clear).toHaveBeenCalledTimes(2);
    clear.mockRestore();
  });

  it('merges by the rule: exact stripped form carries, anything else never does', () => {
    const stored = 'https://u:p@h.example.invalid/x?token=t';
    expect(mergeControllerUrl('https://h.example.invalid/x', [stored])).toEqual(
      {
        kind: 'carry',
        value: stored,
      },
    );
    expect(mergeControllerUrl('https://h.example.invalid/y', [stored])).toEqual(
      {
        kind: 'changed',
      },
    );
    expect(
      mergeControllerUrl('https://h.example.invalid/y?token=n', [stored]),
    ).toEqual({
      kind: 'as-sent',
    });
    expect(
      mergeControllerUrl('https://h.example.invalid/y', [
        'https://h.example.invalid/x',
      ]),
    ).toEqual({ kind: 'as-sent' });
    expect(mergeControllerUrl('https://h.example.invalid/x', [])).toEqual({
      kind: 'as-sent',
    });
  });

  it('records exactly the merged fields in remote-url-fields.json', () => {
    const recorded: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'remote-url-fields.json'), 'utf8'),
    );
    const written = pick(recorded, 'written');
    const merged: Record<string, string[]> = {};
    if (Array.isArray(written))
      for (const group of written) {
        const field = pick(group, 'field');
        const merge = pick(group, 'merge');
        const channels = pick(group, 'channels');
        if (
          typeof field !== 'string' ||
          merge === 'as-sent' ||
          !Array.isArray(channels)
        )
          continue;
        for (const channel of channels)
          if (typeof channel === 'string')
            merged[channel] = [...(merged[channel] ?? []), field].sort();
      }
    expect(merged).toEqual(
      Object.fromEntries(
        Object.entries(CONTROLLER_URL_WRITEBACK_FIELDS).map(
          ([channel, fields]) => [channel, [...fields].sort()],
        ),
      ),
    );
  });
});
