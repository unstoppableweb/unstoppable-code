/**
 * CAN-7030: Git remote URLs leaving this computer for a remote-control
 * controller. Drives the real host session over an encrypted session pair:
 * tunnelled invoke results and pushes from the main window reach the
 * controller with userinfo stripped and local remotes withheld, and a clone
 * job's source as an empty URL. The values the main window holds are never
 * changed. Only the bridge window is a fake that answers each channel.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type { LookupAddress } from 'node:dns';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatSessionCloudExportListResponse,
  ChatSessionImportInspectResponse,
  CloneJobSnapshot,
  GetRemoteUrlResponse,
  WorkspaceReferenceRepoStatus,
  WorkspaceReferenceRepoStatusEvent,
} from '@canopy/desktop-shared/types';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));
import type { HostBridge } from '../host/bridge-window';
import {
  CONTROLLER_REMOTE_URL_PROJECTIONS,
  CONTROLLER_SENT_BACK_URL_CHANNELS,
  controllerCredentialFreeGitUrl,
  controllerCredentialFreeText,
  controllerCredentialFreeUrl,
  controllerCredentialParts,
  projectControllerPush,
  projectControllerResult,
} from '../host/controller-remote-urls';
import {
  installPluginForPrincipal,
  type PluginSourceInstall,
} from '../../plugins/remote-install-source-gate';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';
import { createWorkspace } from '../../lib/workspace-creation';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';

// A controller's plugin install runs the host's source checks, which resolve
// the clone host; every host here is public.
jest.mock('node:dns/promises', () => ({
  lookup: (): Promise<LookupAddress[]> =>
    Promise.resolve([{ address: '140.82.112.3', family: 4 }]),
}));

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};

const TOKEN_URL = 'https://x-access-token:secret@example.invalid/org/repo.git';
const STRIPPED_URL = 'https://example.invalid/org/repo.git';
const SCP_URL = 'deploy@example.invalid:org/scp.git';
const SCP_STRIPPED = 'example.invalid:org/scp.git';
const PLAIN_URL = 'https://example.invalid/org/plain.git';
const LOCAL_PATH = '/Users/someone/origins/private.git';
const FILE_URL = 'file:///Users/someone/origins/private.git';

function referenceStatus(remoteUrl: string): WorkspaceReferenceRepoStatus {
  return {
    referenceRepoPath: '/data/reference',
    healthy: true,
    warnings: [],
    lastCheckedAt: '2026-11-17T00:00:00.000Z',
    remoteUrl,
  };
}

function cloneJob(id: string, remoteUrl: string): CloneJobSnapshot {
  return {
    id,
    repoName: 'repo',
    remoteUrl,
    destinationPath: '/Users/someone/code/repo',
    status: 'running',
    phase: 'counting',
    phasePercent: 40,
    percent: 40,
    processedCount: null,
    totalCount: null,
    received: null,
    throughput: null,
    startedAt: 1_700_000_000_000,
    background: false,
    cancellable: true,
    workspaceId: null,
    workspaceName: null,
    error: null,
  };
}

const exportList: ChatSessionCloudExportListResponse = {
  data: [
    {
      id: 'export-1',
      title: 'Session',
      workspaceName: 'Workspace',
      workspaceType: 'multi-repo',
      repos: [
        { name: 'token', branchName: 'main', remoteUrl: TOKEN_URL },
        { name: 'local', branchName: 'main', remoteUrl: FILE_URL },
        { name: 'none', branchName: 'main' },
      ],
      sizeBytes: 10,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const inspection: ChatSessionImportInspectResponse = {
  exportId: 'export-1',
  manifestSummary: {
    title: 'Session',
    exportedAt: '2026-11-17T00:00:00.000Z',
    workspaceType: 'multi-repo',
    repoCount: 2,
    repos: [
      { name: 'token', remoteUrl: TOKEN_URL },
      { name: 'scp', remoteUrl: SCP_URL },
    ],
  },
  workspaceSummary: {
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    workspaceType: 'multi-repo',
    repoCount: 1,
    repos: [{ name: 'local', remoteUrl: LOCAL_PATH }],
  },
  match: 'superset',
  workspaceTypeCompatible: true,
  missingRepos: [{ name: 'token', remoteUrl: TOKEN_URL }],
  warnings: [],
};

/** What the main window's handlers answer, exactly as main holds them. */
const RESULTS: Readonly<Record<string, unknown>> = {
  [IPC_CHANNELS.repoGetRemoteUrl]: { remoteUrl: TOKEN_URL },
  [IPC_CHANNELS.workspaceReadSettingsData]: {
    referenceRepoStatus: referenceStatus(SCP_URL),
  },
  [IPC_CHANNELS.cloneJobsList]: [
    cloneJob('token', TOKEN_URL),
    cloneJob('local', LOCAL_PATH),
  ],
  [IPC_CHANNELS.chatSessionCloudExportList]: exportList,
  [IPC_CHANNELS.chatSessionImportInspect]: inspection,
};

// CAN-7082: URL fields a controller only reads. No tunnelled channel takes
// them back from a caller, so stripping their credential parts can't
// overwrite a stored value.
const SECRET = 'tok-0123456789';
const CREDENTIAL_GIT_URL = `https://x-access-token:${SECRET}@example.invalid/org/repo.git?private_token=${SECRET}&ref=main#${SECRET}`;
const CREDENTIAL_FREE_GIT_URL = 'https://example.invalid/org/repo.git?ref=main';
const CREDENTIAL_SCP_URL = `${SECRET}@example.invalid:org/repo.git`;
const CREDENTIAL_FREE_SCP_URL = 'example.invalid:org/repo.git';
const CREDENTIAL_PAGE_URL = `https://user:${SECRET}@example.invalid/mcp?api_key=${SECRET}&tab=tools&Token=${SECRET}&key=${SECRET}#access_token=${SECRET}`;
const CREDENTIAL_FREE_PAGE_URL = 'https://example.invalid/mcp?tab=tools';

/** Git remote fields: canopy.json clone URLs and marketplace sources. */
const OUT_ONLY_GIT_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> =
  [
    [
      'manifestUrl',
      [
        'projects:load',
        'projects:save',
        'workspace:add-from-folder',
        'workspace:add-from-remote',
        'workspace:add-repo',
        'workspace:combine-worktree-with-existing-worktree',
        'workspace:combine-worktree-with-workspace',
        'workspace:create',
        'workspace:create-new',
        'workspace:create-temporary-from-repos',
        'workspace:create-temporary-worktree-from-repos',
        'workspace:create-temporary-worktree-from-workspaces',
        'workspace:import-from-repo',
        'workspace:promote-temporary',
        'workspace:read-settings-data',
        'workspace:set-private-memory',
      ],
    ],
    ['url', ['canopy-json:read', 'workspace:init-git']],
    [
      'sourceUrl',
      [
        'app-advisor:settings-view',
        'plugin-catalog:list',
        'plugins:addMarketplace',
        'plugins:load',
        'plugins:loadCacheOnly',
        'plugins:refreshMarketplaces',
        'plugins:removeMarketplace',
        'plugins:updateMarketplace',
      ],
    ],
  ];

/** Other URLs: MCP server URLs, in-app page URLs, the model gateway. */
const OUT_ONLY_URL_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> =
  [
    [
      'url',
      [
        'app-advisor:settings-view',
        'mcp-servers:list-detected',
        'plugin-catalog:list',
        'plugins:addMarketplace',
        'plugins:install-built-in-plugin',
        'plugins:install-plugin',
        'plugins:load',
        'plugins:loadCacheOnly',
        'plugins:prepare-codex-compatibility',
        'plugins:refreshMarketplaces',
        'plugins:removeMarketplace',
        'plugins:set-codex-compat-disabled',
        'plugins:updateMarketplace',
        'app-advisor:get-state',
      ],
    ],
    [
      'displayUrl',
      ['resource-monitor:get-snapshot', 'resource-monitor:snapshot'],
    ],
    ['baseUrl', ['model-registry:get', 'model-registry:updated']],
  ];

const OUT_ONLY_PUSHES: readonly string[] = [
  'resource-monitor:snapshot',
  'model-registry:updated',
];

/** `channel -> [field, credential URL, credential-free URL]` for its fields. */
function outOnlyFields(): Map<
  string,
  Array<readonly [string, string, string]>
> {
  const byChannel = new Map<string, Array<readonly [string, string, string]>>();
  const add = (
    channel: string,
    entry: readonly [string, string, string],
  ): void => {
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), entry]);
  };
  for (const [field, channels] of OUT_ONLY_GIT_FIELDS)
    for (const channel of channels)
      add(channel, [field, CREDENTIAL_GIT_URL, CREDENTIAL_FREE_GIT_URL]);
  for (const [field, channels] of OUT_ONLY_URL_FIELDS)
    for (const channel of channels)
      add(channel, [field, CREDENTIAL_PAGE_URL, CREDENTIAL_FREE_PAGE_URL]);
  return byChannel;
}

const OUT_ONLY = outOnlyFields();

/**
 * A payload holding each field at the top level and nested in a list, beside
 * a field the projection must leave alone. Real shapes vary by channel; the
 * projection walks the whole value, so the depth doesn't matter.
 */
function outOnlyPayload(
  fields: ReadonlyArray<readonly [string, string, string]>,
  pick: 1 | 2,
): Record<string, unknown> {
  const values = Object.fromEntries(
    fields.map((entry): [string, string] => [entry[0], entry[pick]]),
  );
  return { ...values, note: 'unchanged', entries: [{ ...values, id: 'a' }] };
}

const OUT_ONLY_RESULTS: Readonly<Record<string, unknown>> = {
  ...RESULTS,
  ...Object.fromEntries(
    [...OUT_ONLY].map(([channel, fields]): [string, unknown] => [
      channel,
      outOnlyPayload(fields, 1),
    ]),
  ),
  [IPC_CHANNELS.workspaceReadSettingsData]: {
    referenceRepoStatus: referenceStatus(SCP_URL),
    repos: [{ manifestUrl: CREDENTIAL_SCP_URL }],
  },
  [IPC_CHANNELS.repoGetRemoteUrl]: { remoteUrl: CREDENTIAL_GIT_URL },
};

interface Harness {
  controller: RpcPeer;
  pushes: Array<{ channel: string; args: unknown[] }>;
  mainPush: (channel: string, args: unknown[]) => void;
  close: () => void;
}

/** A bridge channel that answers from what the controller sent. */
type BridgeHandler = (args: readonly unknown[]) => Promise<unknown>;

async function harness(
  results: Readonly<Record<string, unknown>> = RESULTS,
  handlers: Readonly<Record<string, BridgeHandler>> = {},
): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const mainListeners = new Set<(channel: string, args: unknown[]) => void>();
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string, args: unknown[]): Promise<unknown> =>
      handlers[channel]?.(args) ?? Promise.resolve(results[channel] ?? null),
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const session = new RemoteHostSession({
    session: responder,
    kind: 'desktop',
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: {
      subscribe: (listener): (() => void) => {
        mainListeners.add(listener);
        return (): void => {
          mainListeners.delete(listener);
        };
      },
    },
    uploads: new RemoteUploadStore(join(tmpdir(), 'controller-urls-uploads')),
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
  });
  const pushes: Array<{ channel: string; args: unknown[] }> = [];
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (name, payload): void => {
      if (
        name === REMOTE_EVENTS.push &&
        typeof payload === 'object' &&
        payload !== null &&
        'channel' in payload &&
        typeof payload.channel === 'string' &&
        'args' in payload &&
        Array.isArray(payload.args)
      )
        pushes.push({ channel: payload.channel, args: payload.args });
    },
  });
  await controller.request(REMOTE_METHODS.hello, { version: VERSION });
  await session.start();
  return {
    controller,
    pushes,
    mainPush: (channel, args): void => {
      for (const listener of Array.from(mainListeners)) listener(channel, args);
    },
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await flushRelay();
}

describe('remote URLs a paired controller receives (CAN-7030)', () => {
  let current: Harness | null = null;
  afterEach(() => {
    current?.close();
    current = null;
  });

  const invoke = (channel: string): Promise<unknown> => {
    if (!current) throw new Error('no harness');
    return current.controller.request(REMOTE_METHODS.invoke, {
      channel,
      args: [],
    });
  };

  it('strips userinfo from repo:get-remote-url, and withholds a local remote', async () => {
    current = await harness();
    const expected: GetRemoteUrlResponse = { remoteUrl: STRIPPED_URL };
    expect(await invoke(IPC_CHANNELS.repoGetRemoteUrl)).toEqual(expected);
  });

  it("redacts the reference repository's origin in the settings data", async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.workspaceReadSettingsData)).toEqual({
      referenceRepoStatus: referenceStatus(SCP_STRIPPED),
    });
  });

  it('sends a clone job its source as an empty URL', async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.cloneJobsList)).toEqual([
      cloneJob('token', ''),
      cloneJob('local', ''),
    ]);
  });

  it('redacts every repo URL in the session export and import channels', async () => {
    current = await harness();
    expect(await invoke(IPC_CHANNELS.chatSessionCloudExportList)).toEqual({
      ...exportList,
      data: [
        {
          ...exportList.data[0],
          repos: [
            { name: 'token', branchName: 'main', remoteUrl: STRIPPED_URL },
            { name: 'local', branchName: 'main' },
            { name: 'none', branchName: 'main' },
          ],
        },
      ],
    });
    expect(await invoke(IPC_CHANNELS.chatSessionImportInspect)).toEqual({
      ...inspection,
      manifestSummary: {
        ...inspection.manifestSummary,
        repos: [
          { name: 'token', remoteUrl: STRIPPED_URL },
          { name: 'scp', remoteUrl: SCP_STRIPPED },
        ],
      },
      workspaceSummary: {
        ...inspection.workspaceSummary,
        repos: [{ name: 'local' }],
      },
      missingRepos: [{ name: 'token', remoteUrl: STRIPPED_URL }],
    });
  });

  it('redacts pushes and leaves the values the main window holds unchanged', async () => {
    current = await harness();
    const statusEvent: WorkspaceReferenceRepoStatusEvent = {
      workspaceId: 'workspace-1',
      status: referenceStatus(TOKEN_URL),
    };
    const localStatusEvent: WorkspaceReferenceRepoStatusEvent = {
      workspaceId: 'workspace-2',
      status: referenceStatus(LOCAL_PATH),
    };
    const jobs = [cloneJob('plain', PLAIN_URL)];
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      statusEvent,
    ]);
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      localStatusEvent,
    ]);
    current.mainPush(IPC_CHANNELS.cloneJobsChanged, [jobs]);
    await settle();

    const localWithout = Object.fromEntries(
      Object.entries(referenceStatus(LOCAL_PATH)).filter(
        ([key]) => key !== 'remoteUrl',
      ),
    );
    expect(current.pushes).toEqual([
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [{ ...statusEvent, status: referenceStatus(STRIPPED_URL) }],
      },
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [{ ...localStatusEvent, status: localWithout }],
      },
      {
        channel: IPC_CHANNELS.cloneJobsChanged,
        args: [[cloneJob('plain', '')]],
      },
    ]);
    // The main window's own copies are untouched.
    expect(statusEvent.status?.remoteUrl).toBe(TOKEN_URL);
    expect(jobs[0]?.remoteUrl).toBe(PLAIN_URL);
  });

  it("refuses a controller's retry with the empty source before any effect", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'controller-urls-')));
    const destinationDir = join(dir, 'code');
    mkdirSync(destinationDir);
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(dir, 'data');
    const cwdBefore = readdirSync(process.cwd()).sort();
    try {
      // Retry reopens Add project with the job's source, so the controller
      // submits the empty URL it was sent.
      await expect(
        createWorkspace({
          source: 'remote',
          variant: { kind: 'remote-clone', remoteUrl: '', destinationDir },
        }),
      ).rejects.toMatchObject({
        name: 'WorkspaceCreationRefusedError',
        reason: 'invalid-remote',
      });
      // The empty URL is never resolved as a relative path: nothing was
      // cloned into the destination or the working directory, and no
      // workspace was recorded.
      expect(readdirSync(destinationDir)).toEqual([]);
      expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
      expect(existsSync(join(dir, 'data'))).toBe(false);
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every channel this test drives and nothing else', () => {
    expect(Object.keys(CONTROLLER_REMOTE_URL_PROJECTIONS).sort()).toEqual(
      [
        ...new Set([
          ...Object.keys(RESULTS),
          ...OUT_ONLY.keys(),
          // Driven by controller-url-writebacks-golden.test.ts.
          ...CONTROLLER_SENT_BACK_URL_CHANNELS,
          IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
          IPC_CHANNELS.cloneJobsChanged,
        ]),
      ].sort(),
    );
  });

  it('records exactly the projected fields in remote-url-fields.json', () => {
    const recorded: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'remote-url-fields.json'), 'utf8'),
    );
    const projected =
      typeof recorded === 'object' &&
      recorded !== null &&
      'projected' in recorded
        ? recorded.projected
        : undefined;
    expect(projected).toEqual(
      Object.fromEntries(
        Object.entries(CONTROLLER_REMOTE_URL_PROJECTIONS)
          .map(([channel, { fields }]): [string, string[]] => [
            channel,
            [...fields].sort(),
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  });
});

describe('credential parts of URLs a paired controller receives (CAN-7082)', () => {
  let current: Harness | null = null;
  afterEach(() => {
    current?.close();
    current = null;
  });

  const invoke = (channel: string): Promise<unknown> => {
    if (!current) throw new Error('no harness');
    return current.controller.request(REMOTE_METHODS.invoke, {
      channel,
      args: [],
    });
  };

  const invokes = [...OUT_ONLY].filter(
    ([channel]) =>
      !OUT_ONLY_PUSHES.includes(channel) &&
      channel !== IPC_CHANNELS.workspaceReadSettingsData,
  );

  it.each(invokes)(
    '%s reaches the controller without userinfo, fragments or unlisted query values',
    async (channel, fields) => {
      const before = JSON.stringify(OUT_ONLY_RESULTS[channel]);
      current = await harness(OUT_ONLY_RESULTS);
      const received = await invoke(channel);
      expect(received).toEqual(outOnlyPayload(fields, 2));
      expect(JSON.stringify(received)).not.toContain(SECRET);
      // The value main holds is never changed.
      expect(JSON.stringify(OUT_ONLY_RESULTS[channel])).toBe(before);
    },
  );

  it.each(OUT_ONLY_PUSHES)(
    '%s pushes reach the controller credential-free and main keeps its copy',
    async (channel) => {
      const fields = OUT_ONLY.get(channel) ?? [];
      current = await harness(OUT_ONLY_RESULTS);
      const pushed = outOnlyPayload(fields, 1);
      const before = JSON.stringify(pushed);
      current.mainPush(channel, [pushed, 'second']);
      await settle();
      expect(current.pushes.filter((push) => push.channel === channel)).toEqual(
        [{ channel, args: [outOnlyPayload(fields, 2), 'second'] }],
      );
      expect(JSON.stringify(current.pushes)).not.toContain(SECRET);
      expect(JSON.stringify(pushed)).toBe(before);
    },
  );

  // Every caller of the strips gets the safe result. Each entry of the
  // projection table, as host-session applies it to a result or a push,
  // meets these shapes in every field it strips.
  const EXTERNAL_SOURCE_CHANNELS: readonly string[] = [
    'app-advisor:settings-view',
    'plugin-catalog:list',
    'plugins:addMarketplace',
    'plugins:install-built-in-plugin',
    'plugins:install-plugin',
    'plugins:load',
    'plugins:loadCacheOnly',
    'plugins:prepare-codex-compatibility',
    'plugins:refreshMarketplaces',
    'plugins:removeMarketplace',
    'plugins:set-codex-compat-disabled',
    'plugins:updateMarketplace',
  ];
  const CUT_SHORT_SHAPES = [
    'https://user:sekA:123/sekB@sekC?ref=sekD@example.invalid/x',
    'https://sekA:1234/sekB@sekC/x',
    'https://user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
    'https://user:sekA\\sekB@sekC?ref=sekD@example.invalid/x',
    'https://user:sekA?sekB@sekC#sekD@example.invalid/x',
    'ssh://user:sekA/sekB@sekC/sekD@example.invalid/x',
    '//user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
  ];
  /** A sent-back URL's shape on its channel, beside the channel's own fields. */
  function callerPayload(channel: string, url: string): unknown {
    const payload = channelPayload(channel, url);
    if (channel === MCP_SERVER_CHANNELS.START_ACCOUNT)
      return { authorizationUrl: url };
    if (
      channel === MCP_SERVER_CHANNELS.LOAD_SERVER ||
      channel === MCP_SERVER_CHANNELS.SAVE_SERVER
    )
      return {
        server: {
          definition: {
            url,
            oauth: { authorizationUrl: url, tokenUrl: url },
          },
        },
      };
    return CONTROLLER_SENT_BACK_URL_CHANNELS.includes(channel) &&
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload)
      ? { ...payload, startPage: { kind: 'url', url } }
      : payload;
  }

  function channelPayload(channel: string, url: string): unknown {
    const repos = [{ name: 'r', remoteUrl: url }];
    const byChannel: Record<string, unknown> = {
      [IPC_CHANNELS.repoGetRemoteUrl]: { remoteUrl: url },
      [IPC_CHANNELS.workspaceReferenceRepoStatusEvent]: {
        status: { remoteUrl: url },
      },
      [IPC_CHANNELS.workspaceReadSettingsData]: {
        referenceRepoStatus: { remoteUrl: url },
        repos: [{ manifestUrl: url }],
      },
      [IPC_CHANNELS.cloneJobsList]: [{ id: 'j', remoteUrl: url }],
      [IPC_CHANNELS.cloneJobsChanged]: [{ id: 'j', remoteUrl: url }],
      [IPC_CHANNELS.chatSessionCloudExportList]: { data: [{ repos }] },
      [IPC_CHANNELS.chatSessionImportInspect]: {
        manifestSummary: { repos },
        workspaceSummary: { repos },
        missingRepos: repos,
      },
    };
    if (channel in byChannel) return byChannel[channel];
    const values: Record<string, unknown> = Object.fromEntries(
      (OUT_ONLY.get(channel) ?? []).map(([field]): [string, string] => [
        field,
        url,
      ]),
    );
    if (EXTERNAL_SOURCE_CHANNELS.includes(channel)) values.externalSource = url;
    return {
      ...values,
      entries: [
        {
          ...values,
          ...(EXTERNAL_SOURCE_CHANNELS.includes(channel)
            ? { externalSource: { url } }
            : {}),
        },
      ],
    };
  }

  const PUSH_CHANNELS: readonly string[] = [
    IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
    IPC_CHANNELS.cloneJobsChanged,
    ...OUT_ONLY_PUSHES,
  ];
  it.each(Object.keys(CONTROLLER_REMOTE_URL_PROJECTIONS).sort())(
    '%s gives a controller no piece of a cut-short password beside an @',
    (channel) => {
      for (const url of CUT_SHORT_SHAPES) {
        const payload = callerPayload(channel, url);
        expect(JSON.stringify(payload)).toContain('sekC');
        const projected = PUSH_CHANNELS.includes(channel)
          ? projectControllerPush(channel, [payload])
          : projectControllerResult(channel, payload);
        expect(JSON.stringify(projected)).not.toMatch(/sek[A-D]/);
      }
    },
  );

  // The whole-URL pass inserts the controller form as written: a `$&` in it
  // is text, never a pattern that echoes the stored URL back.
  it('replaces a quoted URL with its controller form, whatever `$` it holds', () => {
    const url = 'https://user:pw@example.invalid/a$&b/c.git';
    expect(
      controllerCredentialFreeText(`fatal: unable to access ${url}`, url),
    ).toBe('fatal: unable to access https://example.invalid/a$&b/c.git');
  });

  it('leaves text with no stored URL to replace as it is, still stripping any URL in it', () => {
    expect(controllerCredentialFreeText('fatal: clone failed', '')).toBe(
      'fatal: clone failed',
    );
    expect(
      controllerCredentialFreeText(
        'fatal: unable to access https://user:pw@example.invalid/x',
        '',
      ),
    ).toBe('fatal: unable to access https://example.invalid/x');
  });

  it('gives an error quoting a cut-short shape whole none of its secret pieces', () => {
    for (const url of CUT_SHORT_SHAPES)
      expect(
        controllerCredentialFreeText(`fatal: unable to access '${url}'`, url),
      ).not.toMatch(/sek[A-D]/);
  });

  it('strips an scp-style manifest URL beside the redacted reference repository', async () => {
    current = await harness(OUT_ONLY_RESULTS);
    expect(await invoke(IPC_CHANNELS.workspaceReadSettingsData)).toEqual({
      referenceRepoStatus: referenceStatus(SCP_STRIPPED),
      repos: [{ manifestUrl: CREDENTIAL_FREE_SCP_URL }],
    });
  });

  it('drops a Git remote query token on the CAN-7030 channels', async () => {
    current = await harness(OUT_ONLY_RESULTS);
    const expected: GetRemoteUrlResponse = {
      remoteUrl: CREDENTIAL_FREE_GIT_URL,
    };
    expect(await invoke(IPC_CHANNELS.repoGetRemoteUrl)).toEqual(expected);
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      {
        workspaceId: 'workspace-1',
        status: referenceStatus(CREDENTIAL_GIT_URL),
      },
    ]);
    await settle();
    expect(JSON.stringify(current.pushes)).not.toContain(SECRET);
    expect(current.pushes).toEqual([
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [
          {
            workspaceId: 'workspace-1',
            status: referenceStatus(CREDENTIAL_FREE_GIT_URL),
          },
        ],
      },
    ]);
  });

  // A value that isn't a plain object, such as a class
  // instance, a URL object or a Map, is read as the session wire carries it
  // (JSON), so no credentialed url inside one reaches the controller unwalked.
  it('reads a class instance, a URL object or a Map as the wire carries it', async () => {
    class Holder {
      public readonly url = CREDENTIAL_PAGE_URL;
      public readonly sourceUrl = CREDENTIAL_GIT_URL;
    }
    current = await harness({
      ...OUT_ONLY_RESULTS,
      [PLUGINS_CHANNELS.LOAD]: {
        holder: new Holder(),
        link: { url: new URL(CREDENTIAL_PAGE_URL) },
        map: new Map([['entry', { url: CREDENTIAL_PAGE_URL }]]),
      },
    });
    const received = await invoke(PLUGINS_CHANNELS.LOAD);
    expect(received).toEqual({
      holder: {
        url: CREDENTIAL_FREE_PAGE_URL,
        sourceUrl: CREDENTIAL_FREE_GIT_URL,
      },
      link: { url: CREDENTIAL_FREE_PAGE_URL },
      map: {},
    });
    expect(JSON.stringify(received)).not.toContain(SECRET);
  });

  it('refuses a frame the wire cannot carry instead of passing it unwalked', async () => {
    current = await harness({
      ...OUT_ONLY_RESULTS,
      [PLUGINS_CHANNELS.LOAD]: { url: CREDENTIAL_PAGE_URL, size: BigInt(1) },
    });
    await expect(invoke(PLUGINS_CHANNELS.LOAD)).rejects.toThrow();
  });

  // The URL standard reads a special scheme's authority
  // after any run of `/` or `\`, so these all carry userinfo for `new URL`.
  it.each([
    'https:///user:secret@example.invalid/mcp?api_key=secret',
    'https:////user:secret@example.invalid/mcp',
    'https:\\\\user:secret@example.invalid\\mcp',
    'https:/\\user:secret@example.invalid/mcp',
    'https:user:secret@example.invalid/mcp',
  ])(
    'strips userinfo after extra or missing scheme separators: %s',
    async (url) => {
      expect(new URL(url).password).toBe('secret');
      const local = { url, note: 'unchanged' };
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [MCP_SERVER_CHANNELS.LIST_DETECTED]: local,
      });
      const received = await invoke(MCP_SERVER_CHANNELS.LIST_DETECTED);
      expect(JSON.stringify(received)).not.toContain('secret');
      expect(JSON.stringify(received)).not.toContain('user');
      const projected =
        typeof received === 'object' && received !== null && 'url' in received
          ? String(received.url)
          : '';
      const parsed = new URL(projected);
      expect([parsed.username, parsed.password]).toEqual(['', '']);
      expect(parsed.hostname).toBe('example.invalid');
      expect(local).toEqual({ url, note: 'unchanged' });
    },
  );

  // The URL standard strips C0 controls and spaces at the ends
  // and every tab, LF and CR before parsing, so these all carry a password.
  it.each([
    ' https://user:pw@example.invalid/x',
    '\thttps://user:pw@example.invalid/x',
    'ht\ttps://user:pw@example.invalid/x',
    'https://us\ner:pw@example.invalid/x',
    '\u0000https://user:pw@example.invalid/x',
  ])(
    'strips userinfo the URL standard reads after normalizing %j',
    async (url) => {
      expect(new URL(url).password).toBe('pw');
      const local = { url, note: 'unchanged' };
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [MCP_SERVER_CHANNELS.LIST_DETECTED]: local,
      });
      const received = await invoke(MCP_SERVER_CHANNELS.LIST_DETECTED);
      expect(JSON.stringify(received)).not.toContain('pw');
      expect(JSON.stringify(received)).not.toContain('user');
      expect(local).toEqual({ url, note: 'unchanged' });
    },
  );

  // Only a special scheme ends its authority at a `\`. For
  // any other scheme it is part of the userinfo, as `new URL` reads it.
  it.each([
    'ssh://DOMAIN\\user:pw@example.invalid/repo',
    'git+ssh://DOMAIN\\user:pw@example.invalid/repo',
    'ssh://user:p\\w@example.invalid/repo',
  ])(
    'strips userinfo holding a backslash in a non-special scheme: %s',
    async (url) => {
      expect(new URL(url).password).not.toBe('');
      const local = { url, note: 'unchanged' };
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [MCP_SERVER_CHANNELS.LIST_DETECTED]: local,
      });
      const received = await invoke(MCP_SERVER_CHANNELS.LIST_DETECTED);
      expect(JSON.stringify(received)).not.toContain('pw');
      expect(JSON.stringify(received)).not.toContain('user');
      const projected =
        typeof received === 'object' && received !== null && 'url' in received
          ? String(received.url)
          : '';
      const parsed = new URL(projected);
      expect([parsed.username, parsed.password]).toEqual(['', '']);
      expect(parsed.hostname).toBe('example.invalid');
      expect(local).toEqual({ url, note: 'unchanged' });
    },
  );

  // A scheme-less `//` or `\\` authority carries userinfo
  // once a consumer resolves it against a base.
  it.each(['//user:pw@example.invalid/x', '\\\\user:pw@example.invalid/x'])(
    'strips userinfo from a scheme-less authority: %s',
    async (url) => {
      expect(new URL(url, 'https://base.invalid/').password).toBe('pw');
      const local = { url, note: 'unchanged' };
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [MCP_SERVER_CHANNELS.LIST_DETECTED]: local,
      });
      const received = await invoke(MCP_SERVER_CHANNELS.LIST_DETECTED);
      expect(JSON.stringify(received)).not.toContain('pw');
      expect(JSON.stringify(received)).not.toContain('user');
      const projected =
        typeof received === 'object' && received !== null && 'url' in received
          ? String(received.url)
          : '';
      const parsed = new URL(projected, 'https://base.invalid/');
      expect([parsed.username, parsed.password]).toEqual(['', '']);
      expect(parsed.hostname).toBe('example.invalid');
      expect(local).toEqual({ url, note: 'unchanged' });
    },
  );

  // A plugin's external source reaches the
  // controller redacted, in its object or its string form. The URL the
  // controller sends back to install only picks the host's own record, so the
  // host clones the source it stored and refuses one it has no record of.
  describe('a plugin install from a paired controller', () => {
    const STORED_SOURCE = `https://github.com/acme/plugin.git?token=${SECRET}`;
    const SEEN_SOURCE = 'https://github.com/acme/plugin.git';
    const loaded = (externalSource: unknown): unknown => ({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'acme',
            plugins: [{ name: 'p', marketplaceId: 'acme', externalSource }],
          },
        ],
      },
    });

    /**
     * The host as plugin-handlers wires it, over the record `plugins:load`
     * serves.
     */
    function installHost(stored: string): {
      handlers: Record<string, BridgeHandler>;
      clones: string[];
    } {
      const clones: string[] = [];
      const install: PluginSourceInstall = (_id, _name, sourceUrl) => {
        clones.push(sourceUrl);
        return Promise.resolve({
          success: false,
          error: `fatal: unable to access '${sourceUrl}/': The requested URL returned error: 403`,
        });
      };
      return {
        clones,
        handlers: {
          [PLUGINS_CHANNELS.INSTALL_PLUGIN]: async (args) => {
            const [marketplaceId, pluginName, sourceUrl] = args;
            const result = await installPluginForPrincipal(
              {
                remote: true,
                marketplaceId: String(marketplaceId),
                pluginName: String(pluginName),
                sourceUrl: String(sourceUrl),
              },
              install,
              (id, name) =>
                Promise.resolve(
                  id === 'acme' && name === 'p' ? stored : undefined,
                ),
            );
            return clones.length > 0 && clones.at(-1) === stored
              ? {
                  success: true,
                  data: { name: 'p', externalSource: { url: stored } },
                }
              : result;
          },
        },
      };
    }

    const request = (channel: string, args: unknown[]): Promise<unknown> => {
      if (!current) throw new Error('no harness');
      return current.controller.request(REMOTE_METHODS.invoke, {
        channel,
        args,
      });
    };

    it.each([
      ['object', { url: STORED_SOURCE }, { url: SEEN_SOURCE }],
      ['string', STORED_SOURCE, SEEN_SOURCE],
    ])(
      'loads the %s form redacted, then installs from the stored source',
      async (_form, stored, seen) => {
        const host = installHost(STORED_SOURCE);
        current = await harness(
          {
            ...OUT_ONLY_RESULTS,
            [PLUGINS_CHANNELS.LOAD]: loaded(stored),
          },
          host.handlers,
        );
        const received = await request(PLUGINS_CHANNELS.LOAD, []);
        expect(received).toEqual(loaded(seen));
        const installed = await request(PLUGINS_CHANNELS.INSTALL_PLUGIN, [
          'acme',
          'p',
          SEEN_SOURCE,
        ]);
        expect(host.clones).toEqual([STORED_SOURCE]);
        expect(installed).toEqual({
          success: true,
          data: { name: 'p', externalSource: { url: SEEN_SOURCE } },
        });
        expect(JSON.stringify([received, installed])).not.toContain(SECRET);
      },
    );

    // A browser controller never names a source: it sends '' and the host
    // installs from the one it stored (CAN-7442).
    it('installs from the stored source when the controller sends an empty source', async () => {
      const host = installHost(STORED_SOURCE);
      current = await harness(OUT_ONLY_RESULTS, host.handlers);
      const installed = await request(PLUGINS_CHANNELS.INSTALL_PLUGIN, [
        'acme',
        'p',
        '',
      ]);
      expect(host.clones).toEqual([STORED_SOURCE]);
      expect(installed).toEqual({
        success: true,
        data: { name: 'p', externalSource: { url: SEEN_SOURCE } },
      });
      expect(JSON.stringify(installed)).not.toContain(SECRET);
    });

    it('refuses an empty source for a plugin the host has no source for, and clones nothing', async () => {
      const host = installHost(STORED_SOURCE);
      current = await harness(OUT_ONLY_RESULTS, host.handlers);
      const installed = await request(PLUGINS_CHANNELS.INSTALL_PLUGIN, [
        'acme',
        'unknown',
        '',
      ]);
      expect(host.clones).toEqual([]);
      expect(installed).toMatchObject({ success: false });
    });

    // A plugin's source can be an scp-style Git remote, whose
    // userinfo a URL parser doesn't see.
    it('loads an scp-style source without its userinfo, in every form and facet', async () => {
      const scp = `${SECRET}@git.example.org:org/plugin.git`;
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [PLUGINS_CHANNELS.LOAD]: {
          success: true,
          data: {
            marketplaces: [
              {
                id: 'acme',
                plugins: [
                  { name: 'string', externalSource: scp },
                  { name: 'object', externalSource: { url: scp, sha: 'abc' } },
                  {
                    name: 'facet',
                    facets: { claude: { externalSource: { url: scp } } },
                  },
                ],
              },
            ],
          },
        },
      });
      const received = await request(PLUGINS_CHANNELS.LOAD, []);
      expect(JSON.stringify(received)).not.toContain(SECRET);
      expect(JSON.stringify(received)).toContain('git.example.org');
    });

    it('loads a string-form source with userinfo redacted', async () => {
      current = await harness({
        ...OUT_ONLY_RESULTS,
        [PLUGINS_CHANNELS.LOAD]: loaded(
          `https://user:${SECRET}@github.com/acme/plugin.git`,
        ),
      });
      const received = await request(PLUGINS_CHANNELS.LOAD, []);
      expect(received).toEqual(loaded(SEEN_SOURCE));
    });

    it.each([
      ['another repository', 'https://github.com/acme/other.git'],
      ['a new credential', 'https://github.com/acme/plugin.git?token=new'],
    ])(
      'refuses an install that sends %s, and clones nothing',
      async (_label, sent) => {
        const host = installHost(STORED_SOURCE);
        current = await harness(OUT_ONLY_RESULTS, host.handlers);
        const installed = await request(PLUGINS_CHANNELS.INSTALL_PLUGIN, [
          'acme',
          'p',
          sent,
        ]);
        expect(host.clones).toEqual([]);
        expect(installed).toMatchObject({ success: false });
        expect(JSON.stringify(installed)).not.toContain(SECRET);
      },
    );

    it("keeps the stored credential out of a failed clone's error", async () => {
      const host = installHost(STORED_SOURCE);
      host.handlers[PLUGINS_CHANNELS.INSTALL_PLUGIN] = async (
        args,
      ): Promise<unknown> => {
        const [marketplaceId, pluginName, sourceUrl] = args;
        return installPluginForPrincipal(
          {
            remote: true,
            marketplaceId: String(marketplaceId),
            pluginName: String(pluginName),
            sourceUrl: String(sourceUrl),
          },
          (_id, _name, cloned) =>
            Promise.resolve({
              success: false,
              error: `fatal: unable to access '${cloned}/': The requested URL returned error: 403`,
            }),
          () => Promise.resolve(STORED_SOURCE),
        );
      };
      current = await harness(OUT_ONLY_RESULTS, host.handlers);
      const installed = await request(PLUGINS_CHANNELS.INSTALL_PLUGIN, [
        'acme',
        'p',
        SEEN_SOURCE,
      ]);
      expect(installed).toMatchObject({ success: false });
      expect(JSON.stringify(installed)).not.toContain(SECRET);
    });
  });

  it('strips a backslash-holding ssh userinfo from a Git remote invoke and push', async () => {
    current = await harness({
      ...OUT_ONLY_RESULTS,
      [IPC_CHANNELS.repoGetRemoteUrl]: {
        remoteUrl: 'ssh://DOMAIN\\user:pw@example.invalid/org/repo.git',
      },
    });
    const expected: GetRemoteUrlResponse = {
      remoteUrl: 'ssh://example.invalid/org/repo.git',
    };
    expect(await invoke(IPC_CHANNELS.repoGetRemoteUrl)).toEqual(expected);
    current.mainPush(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, [
      {
        workspaceId: 'workspace-1',
        status: referenceStatus(
          'ssh://DOMAIN\\user:pw@example.invalid/org/repo.git',
        ),
      },
    ]);
    await settle();
    expect(current.pushes).toEqual([
      {
        channel: IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        args: [
          {
            workspaceId: 'workspace-1',
            status: referenceStatus('ssh://example.invalid/org/repo.git'),
          },
        ],
      },
    ]);
  });

  describe('controllerCredentialFreeUrl', () => {
    // The URL standard ends a web URL's
    // host at a `\\`, but curl, and so Git, reads on to the `@`. Userinfo
    // either reading finds is stripped.
    it('strips the userinfo curl reads after a backslash in a web URL', () => {
      const url = 'https://example.invalid\\user:pw@other.invalid/x';
      expect(new URL(url).hostname).toBe('example.invalid');
      expect(controllerCredentialFreeUrl(url)).toBe('https://other.invalid/x');
      for (const value of [
        'https://DOMAIN\\user:pw@example.invalid/repo.git',
        'http://DOMAIN\\user:pa/ss@example.invalid/x',
        'https:DOMAIN\\user:pw@example.invalid/x',
      ]) {
        const out = controllerCredentialFreeUrl(value);
        expect(out).not.toContain('pw');
        expect(out).not.toContain('pa');
        expect(out).not.toContain('user');
      }
      // A web URL with no userinfo for either reading keeps its backslash.
      expect(controllerCredentialFreeUrl('https://example.invalid\\x')).toBe(
        'https://example.invalid\\x',
      );
    });

    it("ends a special scheme's authority at a backslash, and no other scheme's", () => {
      expect(
        controllerCredentialFreeUrl('https://user:pw@example.invalid\\x'),
      ).toBe('https://example.invalid\\x');
      expect(
        controllerCredentialFreeUrl('ssh://DOMAIN\\user:pw@example.invalid/x'),
      ).toBe('ssh://example.invalid/x');
      expect(
        controllerCredentialFreeUrl('ssh://user:pa/s@D\\s@example.invalid/x'),
      ).toBe('ssh://example.invalid/x');
      expect(controllerCredentialFreeUrl('ssh://example.invalid\\x')).toBe(
        'ssh://example.invalid\\x',
      );
      // `new URL` reads this as a path with no userinfo; stripping it anyway
      // errs on the safe side.
      expect(
        controllerCredentialFreeUrl('ssh:\\\\user:pw@example.invalid/x'),
      ).toBe('ssh:\\\\example.invalid/x');
    });

    // A raw '/', '\', '?' or '#' in a password ends the
    // authority early; no part of the userinfo may survive.
    it.each(['/', '\\', '?', '#'])(
      "strips userinfo cut short by a raw '%s', leaving no part of it",
      (separator) => {
        const out = controllerCredentialFreeUrl(
          `https://user:pa${separator}ss@example.invalid/x`,
        );
        expect(out).toBe('https://example.invalid/x');
        expect(out).not.toContain('pa');
        expect(out).not.toContain('ss');
      },
    );

    // An unencoded @ in the username must not hide a
    // password a raw '/' cut short.
    it('names every secret part of a URL, as written and decoded, and no allowlisted value', () => {
      const parts = controllerCredentialParts(
        'https://me:pa%40ss@example.invalid/x?ref=main&token=t%2F1&sig=s2#frag3',
      );
      for (const part of [
        'me',
        'pa%40ss',
        'pa@ss',
        't%2F1',
        't/1',
        's2',
        'frag3',
      ])
        expect(parts).toContain(part);
      expect(parts).not.toContain('main');
      expect(
        controllerCredentialParts('https://DOMAIN\\user:pw@example.invalid/x'),
      ).toEqual(expect.arrayContaining(['DOMAIN\\user', 'pw']));
      expect(controllerCredentialParts('https://example.invalid/x')).toEqual(
        [],
      );
    });

    // Text can quote a part with its percent-encoding in the
    // other hex case, outside any URL.
    it('redacts a secret part quoted outside a URL in either hex case', () => {
      const url =
        'https://me%2Fteam:pa%2Bss%2Fword@example.invalid/x?token=t%3A1';
      const out = controllerCredentialFreeText(
        'login me%2fteam rejected; password pa%2bss%2fword expired; token t%3a1',
        url,
      );
      for (const part of ['me%2fteam', 'pa%2bss%2fword', 't%3a1'])
        expect(out).not.toContain(part);
      expect(out).toContain('rejected');
      expect(
        controllerCredentialFreeText('password pa%2Bss%2Fword', url),
      ).not.toContain('pa%2Bss%2Fword');
    });

    // A reader that form-decodes a query reads '+' as a
    // space, so text can quote 'tok secret' for a stored 'tok+secret'.
    it('redacts the form-decoded form of a secret part quoted outside a URL', () => {
      const url =
        'https://example.invalid/x?ref=main&token=tok+secret&sig=a+b%2Fc#fr+ag';
      const out = controllerCredentialFreeText(
        'remote: token tok secret rejected; tok+secret; signature a b/c; fr ag',
        url,
      );
      for (const part of ['tok secret', 'tok+secret', 'a b/c', 'fr ag'])
        expect(out).not.toContain(part);
      expect(out).toContain('rejected');
    });

    it('strips a cut-short password after a username that holds a raw @', () => {
      const out = controllerCredentialFreeUrl(
        'https://me@corp.com:abc/def@example.invalid/x',
      );
      expect(out).not.toContain('abc');
      expect(out).not.toContain('def');
    });

    it('strips a cut-short password that also held a raw @, in one bounded re-pass', () => {
      expect(
        controllerCredentialFreeUrl('https://user:pa/s@s@example.invalid/x'),
      ).toBe('https://example.invalid/x');
    });

    // Cut-short userinfo that still holds an `@` after the
    // re-pass is redacted whole, never guessed.
    it('redacts a cut-short URL whole when an @ still remains after the re-pass', () => {
      const out = controllerCredentialFreeUrl(
        'https://user:p/a@b/c@example.invalid/x',
      );
      expect(out).toBe('');
      for (const part of ['p/a', 'b/c', 'user'])
        expect(out).not.toContain(part);
    });

    it('redacts a cut-short password followed by an npm-style path whole (the fail-closed trade)', () => {
      expect(
        controllerCredentialFreeUrl(
          'https://user:pa/ss@example.invalid/@scope/pkg',
        ),
      ).toBe('');
    });

    it('keeps an npm-style /@scope/ path, a port and an @ in an allowlisted value', () => {
      for (const value of [
        'https://example.invalid/@scope/pkg',
        'http://[::1]:8080/@scope/pkg',
        'https://example.invalid/p?ref=a@b',
      ])
        expect(controllerCredentialFreeUrl(value)).toBe(value);
    });

    // A password that ends in `]` before a raw `/`, `?` or `#` is
    // not a bracketed IPv6 host. Its credential is found and stripped.
    it.each([
      'https://user:secret]/tail@example.invalid/x',
      'https://user:secret]?tail@example.invalid/x',
      'https://user:secret]#tail@example.invalid/x',
      'ssh://user:secret]/tail@example.invalid/x',
      '//user:secret]/tail@example.invalid/x',
      'https://user:[secret]/tail@example.invalid/x',
    ])('finds and strips the credential of %s', (url) => {
      expect(
        controllerCredentialParts(url).some((part) => part.includes('secret')),
      ).toBe(true);
      for (const strip of [
        controllerCredentialFreeUrl,
        controllerCredentialFreeGitUrl,
      ]) {
        const out = strip(url);
        expect(out).not.toContain('secret');
        expect(out).not.toContain('tail');
      }
    });

    it('keeps a bracketed IPv6 host, with or without a port or zone', () => {
      for (const value of [
        'https://[::1]/x',
        'https://[::1]:8080/x',
        'https://[fe80::1%25eth0]/x',
        'ssh://[2001:db8::7]/org/repo.git',
      ])
        expect(controllerCredentialFreeUrl(value)).toBe(value);
      expect(controllerCredentialFreeUrl('https://user:pw@[::1]:8080/x')).toBe(
        'https://[::1]:8080/x',
      );
    });

    // After a password cut short at any of `/`, `?`,
    // `#` or `\`, an `@` anywhere after the userinfo, in the path, query or
    // fragment, means a reader can end the userinfo there. Fail closed.
    const AFTER_CUT = {
      path: '/sekD@example.invalid/x',
      query: '?ref=sekD@example.invalid/x',
      fragment: '#sekD@example.invalid/x',
    };
    it.each(
      ['/', '?', '#', '\\'].flatMap((cut) =>
        Object.entries(AFTER_CUT).map(
          ([where, tail]): [string, string, string] => [
            cut,
            where,
            `https://user:sekA${cut}sekB@sekC${tail}`,
          ],
        ),
      ),
    )(
      'fails closed on a password cut at %j with an @ in its %s: %s',
      (_cut, _where, url) => {
        expect(controllerCredentialFreeUrl(url)).toBe('');
        expect(controllerCredentialFreeGitUrl(url)).toBe('');
      },
    );

    it.each([
      'https://user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
      'ssh://user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
      '//user:sekA/sekB@sekC?ref=sekD@example.invalid/x',
      'https://user:sekA/sekB@sekC?ref=main#sekD@example.invalid/x',
    ])('fails closed on %s, an @ after a cut-short password', (url) => {
      expect(controllerCredentialFreeUrl(url)).toBe('');
      expect(controllerCredentialFreeGitUrl(url)).toBe('');
      expect(controllerCredentialParts(url)).toContain('sekA/sekB');
    });

    it('fails closed on a cut-short password beside an @ in an allowlisted value (the accepted trade)', () => {
      expect(
        controllerCredentialFreeUrl(
          'https://user:pa/ss@example.invalid/x?ref=a@b',
        ),
      ).toBe('');
    });

    it('keeps an @ in the query of a URL whose userinfo is not cut short', () => {
      expect(
        controllerCredentialFreeUrl(
          'https://user:pw@example.invalid/x?ref=a@b',
        ),
      ).toBe('https://example.invalid/x?ref=a@b');
      expect(
        controllerCredentialFreeUrl('https://example.invalid/x?ref=a@b'),
      ).toBe('https://example.invalid/x?ref=a@b');
      expect(
        controllerCredentialFreeUrl('https://example.invalid/x?ref=main#a@b'),
      ).toBe('https://example.invalid/x?ref=main');
    });

    // A password that ends in `:<digits>` is cut short, not a port: the text
    // before the last `:` must be a plain host for `host:port` to count.
    it.each(
      ['/', '?', '#']
        .map(
          (cut) =>
            `https://user:sekA:123${cut}sekB@example.invalid/org/repo.git`,
        )
        .concat([
          'ssh://user:sekA:123/sekB@example.invalid/org/repo.git',
          '//user:sekA:123/sekB@example.invalid/org/repo.git',
        ]),
    )('finds and strips a password ending in digits: %s', (url) => {
      expect(
        controllerCredentialParts(url).some((part) => part.includes('sekA')),
      ).toBe(true);
      for (const strip of [
        controllerCredentialFreeUrl,
        controllerCredentialFreeGitUrl,
      ])
        expect(strip(url)).not.toMatch(/sek[A-D]|:123/);
      expect(
        controllerCredentialFreeText(`fatal: unable to access '${url}'`, url),
      ).not.toMatch(/sek[A-D]|:123/);
    });

    // `name:1234` before a raw `/`, `?` or `#` reads as a host and port or as
    // an all-digit password cut short. With any `@` after it, fail closed.
    it.each([
      'https://user:1234/sekB@example.invalid/x',
      'https://sekA:1234/sekB@example.invalid/x',
      'https://user:1234?sekB@example.invalid/x',
      'https://user:1234#sekB@example.invalid/x',
      'ssh://user:1234/sekB@example.invalid/x',
      '//user:1234/sekB@example.invalid/x',
      'https://user:pw@sekA:1234/sekB@example.invalid/x',
    ])('fails closed on a name and port with an @ after it: %s', (url) => {
      expect(controllerCredentialFreeUrl(url)).toBe('');
      expect(controllerCredentialFreeGitUrl(url)).toBe('');
      expect(
        controllerCredentialFreeText(`fatal: unable to access '${url}'`, url),
      ).not.toMatch(/sek[A-D]|1234/);
    });

    it('fails closed on an npm-style path on an explicit port (the accepted trade)', () => {
      expect(
        controllerCredentialFreeUrl('https://example.invalid:8443/@scope/pkg'),
      ).toBe('');
    });

    it('keeps a host with a port, and strips the userinfo before one', () => {
      for (const value of [
        'https://example.invalid:8443/x',
        'https://example.invalid:8443/x?ref=main',
        'ssh://git.example.invalid:2222/org/repo.git',
        'https://192.0.2.7:8443/x',
        'https://example.invalid:8443/org/repo.git',
        'https://[::1]:8443/org/repo.git',
        'https://[fe80::1%25eth0]:8443/x',
      ])
        expect(controllerCredentialFreeUrl(value)).toBe(value);
      expect(
        controllerCredentialFreeUrl('https://user:pw@[::1]:8443/org/repo.git'),
      ).toBe('https://[::1]:8443/org/repo.git');
      expect(
        controllerCredentialFreeUrl('https://user:pw@example.invalid:8443/x'),
      ).toBe('https://example.invalid:8443/x');
      expect(
        controllerCredentialFreeGitUrl(
          'https://user:pw@example.invalid:8443/x',
        ),
      ).toBe('https://example.invalid:8443/x');
    });

    it('keeps only the allowlisted query values of a mixed query', () => {
      expect(
        controllerCredentialFreeUrl(
          'https://example.invalid/p?tab=tools&token=a&ref=main&sig=b&page=2',
        ),
      ).toBe('https://example.invalid/p?tab=tools&ref=main&page=2');
    });

    it('strips an unknown query parameter, whatever its name', () => {
      expect(
        controllerCredentialFreeUrl('https://example.invalid/p?harmless=1'),
      ).toBe('https://example.invalid/p');
      expect(
        controllerCredentialFreeUrl(
          'https://example.invalid/p?X-Amz-Signature=a',
        ),
      ).toBe('https://example.invalid/p');
    });

    it('strips userinfo and the fragment, keeping an @ in the path', () => {
      expect(
        controllerCredentialFreeUrl(
          `https://user:${SECRET}@example.invalid/@scope/pkg?ref=v1#${SECRET}`,
        ),
      ).toBe('https://example.invalid/@scope/pkg?ref=v1');
    });

    it('strips userinfo after a leading // or \\\\, cut at /, ? or #', () => {
      expect(controllerCredentialFreeUrl('//user:pw@example.invalid/x')).toBe(
        '//example.invalid/x',
      );
      expect(controllerCredentialFreeUrl('\\\\user:pw@example.invalid/x')).toBe(
        '\\\\example.invalid/x',
      );
      expect(
        controllerCredentialFreeUrl('///user:pw@example.invalid/x?token=a'),
      ).toBe('///example.invalid/x');
    });

    it('keeps a credential-free // authority and any single-slash path', () => {
      for (const value of [
        '//example.invalid/x',
        'a/b',
        '/x',
        '/a@b/c',
        '\\\\server\\share\\dir',
      ])
        expect(controllerCredentialFreeUrl(value)).toBe(value);
    });

    it('returns a credential-free URL and any non-URL string unchanged', () => {
      for (const value of [
        'https://example.invalid/org/repo.git',
        'https://Example.invalid:8443/a%20b?ref=main',
        '/Users/someone/origins/private.git',
        'owner/repo',
        '',
      ])
        expect(controllerCredentialFreeUrl(value)).toBe(value);
    });
  });

  // A property sweep, so the strip can't leak one case at a time. Every
  // scheme, username and password shape below
  // meets four seeded picks of host, path, query, fragment and leading
  // whitespace; the controller form must hold no secret piece, or be ''.
  describe('a seeded sweep of credential shapes', () => {
    const PIECES = ['sekA', 'sekB', 'sekC', 'sekD'];
    const SCHEMES = [
      'https://',
      'http://',
      'wss://',
      'ssh://',
      'git+ssh://',
      '//',
      '\\\\',
      'https:///',
      'https:',
      'https:\\\\',
    ];
    const USERS = ['user', 'me@corp.com', 'DOMAIN\\user', '', 'x-access-token'];
    const PASSWORDS = [
      'sekA',
      'sekA/sekB',
      'sekA\\sekB',
      'sekA?sekB',
      'sekA#sekB',
      'sekA@sekB',
      "sekA'sekB",
      'sekA"sekB',
      'sekA%2FsekB',
      'sekA:sekB',
      'sekA]/sekB',
      'sekA]?sekB',
      'sekA]#sekB',
      '[sekA]/sekB',
      'sekA:123',
      'sekA:123/sekB',
      '1234/sekB',
      '1234?sekB',
      '1234#sekB',
    ];
    const HOSTS = ['example.invalid', 'example.invalid:8443', '[::1]:8080'];
    const PATHS = ['/org/repo.git', '', '/@scope/pkg'];
    const QUERIES = [
      '',
      '?token=sekC',
      '?ref=main&token=sekC',
      "?ref=team's&token=sekC",
      '?ref=a@b&token=sekC',
    ];
    const FRAGMENTS = ['', '#sekD', '#sekD@example.invalid'];
    const PREFIXES = ['', ' ', '\t'];

    /** mulberry32: the same picks on every run. */
    function seeded(seed: number): () => number {
      let state = seed;
      return (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function cases(): string[] {
      const random = seeded(7082);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(random() * list.length)] ?? list[0];
      const urls: string[] = [];
      for (const scheme of SCHEMES)
        for (const user of USERS) {
          for (const password of PASSWORDS)
            for (let round = 0; round < 4; round += 1)
              urls.push(
                `${pick(PREFIXES)}${scheme}${user}:${password}@${pick(HOSTS)}${pick(PATHS)}${pick(QUERIES)}${pick(FRAGMENTS)}`,
              );
        }
      for (const scheme of SCHEMES)
        for (const host of HOSTS)
          urls.push(`${scheme}sekA@${host}/org/repo.git`);
      return urls;
    }

    it.each([
      ['controllerCredentialFreeUrl', controllerCredentialFreeUrl],
      ['controllerCredentialFreeGitUrl', controllerCredentialFreeGitUrl],
    ])('%s leaves no secret piece in any case', (_name, strip) => {
      const leaks = cases().flatMap((url) => {
        const out = strip(url);
        return out !== '' && PIECES.some((piece) => out.includes(piece))
          ? [`${JSON.stringify(url)} -> ${JSON.stringify(out)}`]
          : [];
      });
      expect(leaks.slice(0, 10)).toEqual([]);
    });

    it('covers every scheme, username and password shape', () => {
      expect(cases().length).toBe(3830);
    });

    // The password's tail sits where a host would, with an `@`
    // after it in the path, query or fragment. A `\` cuts only a special
    // scheme's password.
    const CUT_TAILS = [
      'sekC/sekD@example.invalid/x',
      'sekC?ref=sekD@example.invalid/x',
      'sekC#sekD@example.invalid/x',
      'sekC?ref=main#sekD@example.invalid/x',
    ];
    function cutCases(): string[] {
      const urls: string[] = [];
      for (const scheme of SCHEMES)
        for (const user of USERS)
          for (const password of PASSWORDS.filter(
            (shape) =>
              /[/?#]/.test(shape) ||
              (shape.includes('\\') && /^(https?|wss):/.test(scheme)),
          ))
            for (const tail of CUT_TAILS)
              urls.push(`${scheme}${user}:${password}@${tail}`);
      return urls;
    }

    it.each([
      ['controllerCredentialFreeUrl', controllerCredentialFreeUrl],
      ['controllerCredentialFreeGitUrl', controllerCredentialFreeGitUrl],
    ])(
      '%s leaves no secret piece after a cut-short password and an @',
      (_name, strip) => {
        const leaks = cutCases().flatMap((url) => {
          const out = strip(url);
          return out !== '' && PIECES.some((piece) => out.includes(piece))
            ? [`${JSON.stringify(url)} -> ${JSON.stringify(out)}`]
            : [];
        });
        expect(leaks.slice(0, 10)).toEqual([]);
      },
    );

    it('covers every cut-short password shape after every scheme and username', () => {
      expect(cutCases().length).toBe(2320);
    });

    // Every form a reader can quote of each
    // secret part (as written, percent-decoded, form-decoded, each
    // re-encoded, in either hex case), quoted alone outside a URL, is gone
    // from controllerCredentialFreeText.
    const TEXT_PASSWORDS = [
      'sekA',
      'sekA+sekB',
      'sekA%2BsekB',
      'sekA%2fsekB',
      'sekA/sekB',
      "sekA'sekB",
      'sekA@sekB',
    ];
    const TEXT_VALUES = [
      'sekC',
      'sekC+sekC',
      'sekC%2BsekC',
      'sekC%2fsekC',
      'sekC%20sekC',
    ];
    const TEXT_FRAGMENTS = ['sekD', 'sekD+sekD', 'sekD%2fsekD'];

    function quotedForms(part: string): string[] {
      const decode = (text: string): string => {
        try {
          return decodeURIComponent(text);
        } catch {
          return text;
        }
      };
      const lowerHex = (text: string): string =>
        text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
      const percent = decode(part);
      const form = decode(part.replaceAll('+', ' '));
      const forms = [
        part,
        percent,
        form,
        encodeURIComponent(percent),
        encodeURIComponent(form),
      ];
      return [...new Set([...forms, ...forms.map(lowerHex)])];
    }

    function textCases(): Array<{ url: string; parts: string[] }> {
      const random = seeded(7082);
      const pick = <T>(list: readonly T[]): T =>
        list[Math.floor(random() * list.length)] ?? list[0];
      const found: Array<{ url: string; parts: string[] }> = [];
      for (const scheme of SCHEMES)
        for (const user of USERS)
          for (const password of TEXT_PASSWORDS) {
            const value = pick(TEXT_VALUES);
            const fragment = pick(TEXT_FRAGMENTS);
            found.push({
              url: `${scheme}${user}:${password}@${pick(HOSTS)}${pick(PATHS)}?ref=main&token=${value}#${fragment}`,
              parts: [password, value, fragment],
            });
          }
      return found;
    }

    it('controllerCredentialFreeText leaves no secret piece of any quoted form', () => {
      const leaks = textCases().flatMap(({ url, parts }) =>
        parts.flatMap((part) =>
          quotedForms(part).flatMap((form) => {
            const out = controllerCredentialFreeText(
              `remote: ${form} rejected`,
              url,
            );
            return PIECES.some((piece) => out.includes(piece))
              ? [
                  `${JSON.stringify(url)} quoting ${JSON.stringify(form)} -> ${JSON.stringify(out)}`,
                ]
              : [];
          }),
        ),
      );
      expect(leaks.slice(0, 10)).toEqual([]);
    });

    it('quotes every scheme, username and part shape', () => {
      expect(textCases().length).toBe(350);
    });

    it('strips an scp-style Git remote whose userinfo is a token', () => {
      for (const host of ['git.example.org', 'github.com'])
        expect(
          controllerCredentialFreeGitUrl(`sekA@${host}:org/plugin.git`),
        ).not.toContain('sekA');
    });
  });

  // The shared container preview already sanitizes each repository
  // remote at its source; these pin that, with no behaviour change.
  it('the shared container preview strips userinfo and token query values at the source', () => {
    expect(
      sanitizeRemoteUrl(
        `https://x-access-token:${SECRET}@example.invalid/org/repo.git`,
      ),
    ).toBe('https://example.invalid/org/repo.git');
    expect(
      sanitizeRemoteUrl(
        `https://example.invalid/org/repo.git?access_token=${SECRET}`,
      ),
    ).toBe('https://example.invalid/org/repo.git');
    expect(
      sanitizeRemoteUrl(`https://example.invalid/org/repo.git?token=${SECRET}`),
    ).toBe('https://example.invalid/org/repo.git');
  });
});
