// CAN-4168 golden: the cloud account lifecycle as desktop serves it today,
// captured before core.integration.cloudAccount takes ownership. It drives the
// real Settings IPC handlers, sign-in flows and the encrypted account store on
// the isolated test data root; only IPC registration, the cloud base URL, the
// browser open, enforced-settings application and the replica fences are
// replaced, and HTTP goes to an in-test fake cloud. A change here is a
// behaviour change: re-record deliberately with `pnpm test <this file> -u`
// and review the snapshot diff.
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { safeStorage } from 'electron';
import { dirname, basename } from 'node:path';
import { request as httpRequest } from 'node:http';
import { BRAND } from '@canopy/brand/current';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type * as CloudConfig from '../canopy-cloud/config';
import { getCanopyCloudAccountFilePath } from '../lib/paths';
import {
  clearCanopyCloudAccount,
  invalidateCanopyCloudAccountCache,
  saveCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { resetCanopyCloudSessionCredential } from '../canopy-cloud/session-status';
import { mintGuest } from '../canopy-cloud/guest-auth';

jest.setTimeout(30_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../lib/github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: jest.fn(),
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
const enforcedApplications: unknown[] = [];
jest.mock('../services/org-enforced-settings', () => ({
  applyEnforcedSettings: (state: {
    hasApiKey: boolean;
    enforcedSettings: { organizationId: string }[];
  }): void => {
    enforcedApplications.push({
      hasApiKey: state.hasApiKey,
      organizations: state.enforcedSettings.map(
        (setting) => setting.organizationId,
      ),
    });
  },
}));
jest.mock('../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));
const purgeFences: number[] = [];
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): object => ({
    withReplicaPurgeFence: (
      persist: () => Promise<unknown>,
    ): Promise<unknown> => {
      purgeFences.push(purgeFences.length + 1);
      return persist();
    },
  }),
}));
const accessLossProcessed: unknown[] = [];
jest.mock('../services/organization-access-loss-service', () => ({
  getOrganizationAccessLossService: (): object => ({
    process: (
      records: readonly { organizationId: string }[],
    ): Promise<object> => {
      accessLossProcessed.push(records.map((record) => record.organizationId));
      return Promise.resolve({ outcomes: [], incomplete: false });
    },
    onOwnershipChanged: (): (() => void) => () => undefined,
  }),
}));
const browserOpens: string[] = [];
let onBrowserOpen: ((url: string) => void) | null = null;
jest.mock('../lib/open-external', () => ({
  openExternalGuarded: (url: string): Promise<void> => {
    browserOpens.push(url);
    onBrowserOpen?.(url);
    return Promise.resolve();
  },
}));

const BASE = 'https://cloud.example.test';
const API = `/api/v1/${BRAND.web.apiNamespace}`;
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CAPABILITIES = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
];

interface FakeAccount {
  readonly id: string;
  readonly organizations: readonly string[];
}
const keys = new Map<string, FakeAccount>([
  ['csk_manual_one', { id: 'account-one', organizations: [ORG_A] }],
  ['csk_manual_two', { id: 'account-two', organizations: [ORG_B] }],
  ['csk_oauth_one', { id: 'account-one', organizations: [ORG_A, ORG_B] }],
  ['csk_guest', { id: 'guest-account', organizations: [] }],
]);
const keyLabel = (key: string | undefined): string =>
  key === undefined
    ? 'none'
    : keys.has(key)
      ? `<${key}>`
      : key.length > 0
        ? '<unknown>'
        : 'empty';

function organization(id: string): Record<string, unknown> {
  return {
    id,
    name: `Org ${id.slice(0, 4)}`,
    role: 'MEMBER',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}
function accountBody(account: FakeAccount): Record<string, unknown> {
  return {
    account: {
      id: account.id,
      name: `Name ${account.id}`,
      email: `${account.id}@example.test`,
      role: 'DEVELOPER',
    },
    capabilities: CAPABILITIES,
    organizations: account.organizations.map(organization),
    teams: [],
    enforcedSettings: account.organizations.map((organizationId) => ({
      organizationId,
      organizationName: `Org ${organizationId.slice(0, 4)}`,
      policies: [],
    })),
  };
}

const accountOverrides = new Map<string, FakeAccount>();
const requests: string[] = [];
let tokenResponse: (() => Response) | null = null;
function bearer(init: RequestInit | undefined): string | undefined {
  const headers = new Headers(init?.headers);
  const value = headers.get('authorization');
  return value?.replace(/^Bearer\s+/i, '');
}
function fakeCloud(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const method = (init?.method ?? 'GET').toUpperCase();
  const key = bearer(init);
  requests.push(`${method} ${url.pathname} auth=${keyLabel(key)}`);
  if (url.origin !== BASE) {
    return Promise.reject(new TypeError('Unexpected origin'));
  }
  if (url.pathname.startsWith('/.well-known/')) {
    return Promise.resolve(Response.json({ capabilities: CAPABILITIES }));
  }
  if (url.pathname === `${API}/account`) {
    const account =
      key === undefined
        ? undefined
        : (accountOverrides.get(key) ?? keys.get(key));
    return Promise.resolve(
      account
        ? Response.json(accountBody(account))
        : new Response(JSON.stringify({ error: 'Invalid API key' }), {
            status: 401,
          }),
    );
  }
  if (url.pathname === `${API}/desktop-auth/token` && method === 'POST') {
    return Promise.resolve(
      tokenResponse
        ? tokenResponse()
        : Response.json({
            token: 'csk_oauth_one',
            userApiKey: { id: 'server-key-oauth' },
            ...accountBody({
              id: 'account-one',
              organizations: [ORG_A, ORG_B],
            }),
          }),
    );
  }
  if (url.pathname === `${API}/desktop-auth/guest` && method === 'POST') {
    return Promise.resolve(
      Response.json({
        token: 'csk_guest',
        userApiKey: { id: 'server-key-guest' },
        ...accountBody({ id: 'guest-account', organizations: [] }),
      }),
    );
  }
  if (url.pathname === `${API}/desktop-auth/guest-link-ticket`) {
    return Promise.resolve(Response.json({ ticket: 'glt_ticket' }));
  }
  if (url.pathname === `${API}/desktop-auth/current-key`) {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (url.pathname === `${API}/auth-link` && method === 'POST') {
    return Promise.resolve(
      key !== undefined && keys.has(key)
        ? Response.json({ url: `${BASE}/auth/consume?code=one-time` })
        : new Response(JSON.stringify({ error: 'Invalid API key' }), {
            status: 401,
          }),
    );
  }
  return Promise.resolve(new Response('Not found', { status: 404 }));
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
// Snapshots hold for every brand pack: brand names and namespaces are tokens.
function unbrand(text: string): string {
  return text
    .split(`/api/v1/${BRAND.web.apiNamespace}/`)
    .join('/api/v1/<brand-api>/')
    .split(`/.well-known/${BRAND.web.wellKnownNamespace}`)
    .join('/.well-known/<brand>')
    .split(BRAND.displayName)
    .join('<Brand>');
}
function normalize(value: unknown): unknown {
  return JSON.parse(
    unbrand(JSON.stringify(value ?? null))
      .replace(ISO, '<time>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/"backend":(?:null|"[^"]*")/g, '"backend":"<host-backend>"')
      .replace(/\.bak-[0-9A-Za-z-]+/g, '.bak-<stamp>'),
  );
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

const changes: (string | null)[] = [];
let fetchSpy: jest.SpyInstance;

// A recognisable stand-in for the OS cipher: sealed bytes never carry the
// plaintext, and anything not sealed by it fails to decrypt.
const SEALED = 'sealed:';
function seal(value: string): Buffer {
  return Buffer.from(
    `${SEALED}${Buffer.from(value, 'utf8').toString('base64')}`,
  );
}
function unseal(value: Buffer): string {
  const text = value.toString('utf8');
  if (!text.startsWith(SEALED)) throw new Error('Unable to decrypt');
  return Buffer.from(text.slice(SEALED.length), 'base64').toString('utf8');
}

const settingsRuntime = {
  dispatcher: {
    query: (): Promise<never> =>
      Promise.reject(new Error('Unexpected dispatch')),
    instruction: (): Promise<never> =>
      Promise.reject(new Error('Unexpected dispatch')),
  },
  resolveCaller: (): never => {
    throw new Error('Unexpected caller');
  },
};

beforeAll(async () => {
  jest.spyOn(safeStorage, 'encryptString').mockImplementation(seal);
  jest.spyOn(safeStorage, 'decryptString').mockImplementation(unseal);
  const { registerSettingsHandlers } = await import('../ipc/settings');
  registerSettingsHandlers(settingsRuntime);
  subscribeCanopyCloudAccountChanges((account) => {
    changes.push(account?.account?.id ?? (account ? '<no-id>' : null));
  });
});

beforeEach(async () => {
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  await clearCanopyCloudAccount();
  resetCanopyCloudSessionCredential();
  const dir = dirname(getCanopyCloudAccountFilePath());
  for (const name of safeReaddir(dir)) {
    if (name.startsWith(basename(getCanopyCloudAccountFilePath()))) {
      rmSync(`${dir}/${name}`, { force: true });
    }
  }
  invalidateCanopyCloudAccountCache();
  resetTrace();
  browserOpens.length = 0;
  onBrowserOpen = null;
  tokenResponse = null;
  accountOverrides.clear();
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function backups(): string[] {
  const name = basename(getCanopyCloudAccountFilePath());
  return safeReaddir(dirname(getCanopyCloudAccountFilePath()))
    .filter((entry) => entry.startsWith(`${name}.bak-`))
    .map((entry) => entry.replace(/\.bak-.*$/, '.bak-<stamp>'));
}

function trace(): unknown {
  return normalize({
    requests: [...requests],
    changes: [...changes],
    enforcedApplications: [...enforcedApplications],
    replicaPurgeFences: purgeFences.length,
    accessLossProcessed: [...accessLossProcessed],
  });
}

function resetTrace(): void {
  requests.length = 0;
  changes.length = 0;
  enforcedApplications.length = 0;
  purgeFences.length = 0;
  accessLossProcessed.length = 0;
}

async function publicState(): Promise<unknown> {
  return invoke(IPC_CHANNELS.settingsLoadCanopyCloudAccount);
}

describe('API key lifecycle', () => {
  it('reports a signed-out account with no key', async () => {
    expect(normalize(await publicState())).toMatchSnapshot();
    expect(await invoke(IPC_CHANNELS.settingsLoadCanopyCloudApiKey)).toBe('');
  });

  it('refuses an empty key and a rejected key without writing', async () => {
    const empty = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: '   ',
    });
    const rejected = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_rejected',
    });
    expect(normalize({ empty, rejected, trace: trace() })).toMatchSnapshot();
    expect(normalize(await publicState())).toMatchObject({ hasApiKey: false });
  });

  it('validates a candidate and the stored key without saving', async () => {
    const candidate = await invoke(
      IPC_CHANNELS.settingsValidateCanopyCloudApiKey,
      { apiKey: 'csk_manual_one' },
    );
    const storedWhenSignedOut = await invoke(
      IPC_CHANNELS.settingsValidateCanopyCloudApiKey,
      {},
    );
    expect(
      normalize({ candidate, storedWhenSignedOut, trace: trace() }),
    ).toMatchSnapshot();
    expect(normalize(await publicState())).toMatchObject({ hasApiKey: false });
  });

  it('saves a manual key, projects it without the secret and returns it to the renderer', async () => {
    const saved = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    const state = await publicState();
    expect(JSON.stringify(state)).not.toContain('csk_manual_one');
    expect(
      normalize({
        saved,
        state,
        rendererKey: await invoke(IPC_CHANNELS.settingsLoadCanopyCloudApiKey),
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });

  it('replaces a manual key with another account as an identity change', async () => {
    await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    resetTrace();
    const replaced = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_two',
    });
    expect(normalize({ replaced, trace: trace() })).toMatchSnapshot();
  });

  it('clears and disconnects a manual key', async () => {
    await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    resetTrace();
    const cleared = await invoke(IPC_CHANNELS.settingsClearCanopyCloudApiKey);
    const disconnectedAgain = await invoke(
      IPC_CHANNELS.settingsDisconnectCanopyCloudAccount,
    );
    expect(
      normalize({ cleared, disconnectedAgain, trace: trace() }),
    ).toMatchSnapshot();
  });
});

describe('guest accounts', () => {
  it('mints a guest and protects it from disconnect and manual replacement', async () => {
    const minted = await mintGuest();
    const disconnect = await invoke(
      IPC_CHANNELS.settingsDisconnectCanopyCloudAccount,
    );
    const manual = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    expect(
      normalize({
        minted,
        disconnect,
        manual,
        rendererKey: await invoke(IPC_CHANNELS.settingsLoadCanopyCloudApiKey),
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });
});

describe('unreadable credential recovery', () => {
  it.each([
    [
      'bytes the OS cipher cannot decrypt',
      (): Buffer => Buffer.from('not an account'),
    ],
    [
      'a decryptable file that is not an account',
      (): Buffer => seal('not an account'),
    ],
  ])(
    'reports %s as unreadable and resets it to a backup once',
    async (_label, bytes) => {
      const path = getCanopyCloudAccountFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes());
      invalidateCanopyCloudAccountCache();
      const unreadable = await publicState();
      const reset = await invoke(
        IPC_CHANNELS.settingsResetUnreadableCanopyCloudAccount,
      );
      const again = await invoke(
        IPC_CHANNELS.settingsResetUnreadableCanopyCloudAccount,
      );
      expect(
        normalize({
          unreadable,
          reset,
          again,
          backups: backups(),
          trace: trace(),
        }),
      ).toMatchSnapshot();
    },
  );
});

function callback(url: string, query: Record<string, string>): Promise<number> {
  const authorize = new URL(url);
  const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  for (const [name, value] of Object.entries(query)) {
    redirect.searchParams.set(name, value);
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      redirect,
      { method: 'GET', headers: { host: redirect.host } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function authorizeShape(url: string): unknown {
  const authorize = new URL(url);
  return {
    origin: authorize.origin,
    pathname: authorize.pathname,
    params: [...authorize.searchParams.keys()].sort(),
    challengeMethod: authorize.searchParams.get('code_challenge_method'),
    redirect: authorize.searchParams.get('redirect_uri'),
    guestLinkTicket: authorize.searchParams.get('guest_link_ticket'),
  };
}

describe('browser sign-in', () => {
  it('completes the loopback exchange and stores the account', async () => {
    const callbacks: Promise<number>[] = [];
    onBrowserOpen = (url): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callbacks.push(callback(url, { code: 'auth-code', state }));
    };
    const result = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    );
    const callbackStatus = await Promise.all(callbacks);
    const state = await publicState();
    expect(JSON.stringify([result, state])).not.toContain('csk_oauth_one');
    expect(
      normalize({
        result,
        callbackStatus,
        authorize: browserOpens.map(authorizeShape),
        rendererKey: await invoke(IPC_CHANNELS.settingsLoadCanopyCloudApiKey),
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });

  it('carries a guest link ticket when signing in from a guest', async () => {
    await mintGuest();
    resetTrace();
    const callbacks: Promise<number>[] = [];
    onBrowserOpen = (url): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callbacks.push(callback(url, { code: 'auth-code', state }));
    };
    const result = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    );
    await Promise.all(callbacks);
    expect(
      normalize({
        result,
        authorize: browserOpens.map(authorizeShape),
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });

  it('rejects a callback whose state does not match', async () => {
    const callbacks: Promise<number>[] = [];
    onBrowserOpen = (url): void => {
      callbacks.push(callback(url, { code: 'auth-code', state: 'forged' }));
    };
    const outcome = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    ).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({
        rejected: error instanceof Error ? error.message : String(error),
      }),
    );
    const callbackStatus = await Promise.all(callbacks);
    expect(
      normalize({ outcome, callbackStatus, trace: trace() }),
    ).toMatchSnapshot();
    expect(normalize(await publicState())).toMatchObject({ hasApiKey: false });
  });

  it('reports a provider error and a failed exchange', async () => {
    onBrowserOpen = (url): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      void callback(url, { error: 'access_denied', state });
    };
    const denied = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    ).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({
        rejected: error instanceof Error ? error.message : String(error),
      }),
    );
    tokenResponse = (): Response =>
      new Response(JSON.stringify({ error: 'Code expired' }), { status: 400 });
    onBrowserOpen = (url): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      void callback(url, { code: 'auth-code', state });
    };
    const exchangeFailed = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    ).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({
        rejected: error instanceof Error ? error.message : String(error),
      }),
    );
    expect(
      normalize({ denied, exchangeFailed, trace: trace() }),
    ).toMatchSnapshot();
  });

  it('cancels a pending sign-in and replaces it with a new one', async () => {
    const opened: string[] = [];
    let release: () => void = () => undefined;
    const browserOpened = new Promise<void>((resolve) => {
      release = resolve;
    });
    onBrowserOpen = (url): void => {
      opened.push(url);
      release();
    };
    const cancelled = invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    ).then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    await browserOpened;
    await invoke(IPC_CHANNELS.settingsCancelCanopyCloudOAuthLogin);
    const cancelledOutcome = await cancelled;

    let releaseSecond: () => void = () => undefined;
    const secondOpened = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    onBrowserOpen = (): void => releaseSecond();
    const replaced = invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    ).then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    await secondOpened;
    const callbacks: Promise<number>[] = [];
    onBrowserOpen = (url): void => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callbacks.push(callback(url, { code: 'auth-code', state }));
    };
    const winner = await invoke(
      IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
    );
    await Promise.all(callbacks);
    expect(
      normalize({
        cancelledOutcome,
        replacedOutcome: await replaced,
        winner,
        browserOpens: browserOpens.length,
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });
});

describe('enforced settings', () => {
  it('re-probes the stored account and applies each organization once', async () => {
    const entry: CanopyCloudAccountEntry = {
      apiKey: 'csk_oauth_one',
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: CAPABILITIES,
      account: {
        id: 'account-one',
        name: 'Name account-one',
        email: 'account-one@example.test',
        role: 'DEVELOPER',
      },
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    };
    await saveCanopyCloudAccount(entry);
    resetTrace();
    const refreshed = await invoke(
      IPC_CHANNELS.settingsRefreshCanopyCloudEnforcedSettings,
    );
    expect(normalize({ refreshed, trace: trace() })).toMatchSnapshot();
  });
});

const OAUTH_ENTRY: CanopyCloudAccountEntry = {
  apiKey: 'csk_oauth_one',
  authMode: 'oauth',
  credentialSource: 'oauth_desktop',
  serverApiKeyId: 'server-key-oauth',
  capabilities: CAPABILITIES,
  account: {
    id: 'account-one',
    name: 'Name account-one',
    email: 'account-one@example.test',
    role: 'DEVELOPER',
  },
  organizations: [ORG_A, ORG_B].map((id) => ({
    id,
    name: `Org ${id.slice(0, 4)}`,
    role: 'MEMBER',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  })),
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
};

// The renderer hands the authenticated cloud page channel only a same-origin
// path; main mints the one-time link with the stored key, which never leaves
// main, and opens the page signed out when there is no account.
describe('authenticated cloud page', () => {
  it('opens a page signed in with a minted link, signed out without an account, and refuses an off-origin destination', async () => {
    const signedOut = await invoke(
      IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
      '/settings/billing',
    );
    const opensSignedOut = [...browserOpens];
    await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    browserOpens.length = 0;
    resetTrace();
    const signedIn = await invoke(
      IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
      '/settings/billing',
    );
    expect({
      signedOut,
      opensSignedOut,
      signedIn,
      opensSignedIn: [...browserOpens],
      requests: [...requests].map(unbrand),
    }).toEqual({
      signedOut: true,
      opensSignedOut: [`${BASE}/settings/billing`],
      signedIn: true,
      opensSignedIn: [`${BASE}/auth/consume?code=one-time`],
      requests: ['POST /api/v1/<brand-api>/auth-link auth=<csk_manual_one>'],
    });
    browserOpens.length = 0;
    await expect(
      invoke(
        IPC_CHANNELS.settingsOpenAuthenticatedCloudPage,
        '//evil.example.test/settings',
      ),
    ).rejects.toThrow('same-origin path');
    expect(browserOpens).toEqual([]);
  });
});

describe('browser key revocation', () => {
  it('revokes the replaced browser key on a manual save, and the browser key on disconnect', async () => {
    await saveCanopyCloudAccount(OAUTH_ENTRY);
    resetTrace();
    const manual = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_two',
    });
    const afterManual = trace();
    await saveCanopyCloudAccount(OAUTH_ENTRY);
    resetTrace();
    const disconnected = await invoke(
      IPC_CHANNELS.settingsDisconnectCanopyCloudAccount,
    );
    expect(
      normalize({
        manualAccount: (manual as { account: unknown }).account,
        afterManual,
        disconnected,
        afterDisconnect: trace(),
      }),
    ).toMatchSnapshot();
  });
});

describe('organization access loss', () => {
  it('commits a lost organization with the refreshed snapshot and hands it off without projecting it', async () => {
    await saveCanopyCloudAccount(OAUTH_ENTRY);
    accountOverrides.set('csk_oauth_one', {
      id: 'account-one',
      organizations: [ORG_A],
    });
    resetTrace();
    const refreshed = await invoke(
      IPC_CHANNELS.settingsRefreshCanopyCloudEnforcedSettings,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const state = await publicState();
    expect(JSON.stringify(state)).not.toContain('organizationAccessLoss');
    expect(
      normalize({
        refreshed,
        organizations: (
          state as { organizations: { id: string }[] }
        ).organizations.map((organization) => organization.id),
        trace: trace(),
      }),
    ).toMatchSnapshot();
  });
});

describe('secure storage', () => {
  it('writes the account through the OS cipher, never in the clear', async () => {
    await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
      apiKey: 'csk_manual_one',
    });
    const raw = readFileSync(getCanopyCloudAccountFilePath());
    const text = raw.toString('utf8');
    expect(text.startsWith(SEALED)).toBe(true);
    expect(text).not.toContain('csk_manual_one');
    expect(text).not.toContain('account-one');
    const stored: unknown = JSON.parse(unseal(raw));
    expect(stored).toMatchObject({
      apiKey: 'csk_manual_one',
      account: { id: 'account-one' },
    });
    expect(
      typeof stored === 'object' && stored !== null
        ? Object.keys(stored).sort()
        : stored,
    ).toMatchSnapshot();
  });

  it('refuses to save, read or reset while the OS cipher is unavailable', async () => {
    await saveCanopyCloudAccount({
      apiKey: 'csk_manual_one',
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: CAPABILITIES,
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    });
    resetTrace();
    await jest.isolateModulesAsync(async () => {
      const electron = await import('electron');
      jest
        .spyOn(electron.safeStorage, 'encryptString')
        .mockImplementation(seal);
      jest
        .spyOn(electron.safeStorage, 'decryptString')
        .mockImplementation(unseal);
      jest
        .spyOn(electron.safeStorage, 'isEncryptionAvailable')
        .mockReturnValue(false);
      const settings = await import('../ipc/settings');
      settings.registerSettingsHandlers(settingsRuntime);
      const state = await publicState();
      const save = await invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, {
        apiKey: 'csk_manual_two',
      });
      const reset = await invoke(
        IPC_CHANNELS.settingsResetUnreadableCanopyCloudAccount,
      ).then(
        (value) => ({ resolved: value }),
        (error: unknown) => ({
          rejected: error instanceof Error ? error.message : String(error),
        }),
      );
      expect(JSON.stringify([state, save, reset])).not.toContain('csk_');
      expect(
        normalize({ state, save, reset, backups: backups(), trace: trace() }),
      ).toMatchSnapshot();
    });
  });
});
