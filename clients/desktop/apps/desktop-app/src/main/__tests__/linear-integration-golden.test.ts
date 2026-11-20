// CAN-4178 golden: the Linear integration as desktop serves it today, captured
// before core.integration takes ownership of it. It drives the real Settings
// and reference-preview IPC handlers, the real core.integration dispatcher and
// desktop host they project since CAN-4178 L3, the Linear API client and the
// encrypted token store on the isolated test data root; only IPC registration
// and the OS cipher are replaced, and HTTP goes to an in-test fake Linear.
// Tokens are fake strings. A change here is a behaviour change: re-record
// deliberately with `pnpm test <this file> -u` and review the snapshot diff.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createCanopyDispatcher,
  CanopyOperationError,
} from '@canopy/core-runtime';
import {
  CORE_INTEGRATION_INSTRUCTIONS,
  CORE_INTEGRATION_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type * as CloudAccountStore from '../lib/canopy-cloud-account-store';
import type { CoreIntegrationDispatcher } from '../canopy-runtime/core-integration-adapter';

// The token handlers write and delete the real secure store: own both data
// roots, so an inherited CANOPY_SECURE_DATA_DIR is never touched.
const STORAGE_ENV = ['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR'] as const;
const inheritedStorageEnv = STORAGE_ENV.map((name) => process.env[name]);
const suiteRoot = mkdtempSync(join(tmpdir(), 'linear-golden-'));
process.env.CANOPY_DATA_DIR = join(suiteRoot, 'data');
process.env.CANOPY_SECURE_DATA_DIR = join(suiteRoot, 'secure');
afterAll(() => {
  STORAGE_ENV.forEach((name, index) => {
    const value = inheritedStorageEnv[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  rmSync(suiteRoot, { recursive: true, force: true });
});

jest.setTimeout(30_000);

// Handlers register through the real registerIpcHandler wrapper, so a
// rejection reaches the caller as production converts it.
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const event = {
  sender: { isDestroyed: (): boolean => false, send: (): void => undefined },
} as unknown as IpcMainInvokeEvent;
jest.mock('../lib/github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: jest.fn(),
}));
// The signed-in account, as the reference-preview scope reads it. A test may
// run work inside the lookup, as a concurrent sign-out would.
let mockAccountId: string | null = null;
let duringAccountLookup: (() => Promise<void>) | null = null;
jest.mock('../lib/canopy-cloud-account-store', () => ({
  ...jest.requireActual<typeof CloudAccountStore>(
    '../lib/canopy-cloud-account-store',
  ),
  loadCanopyCloudAccount: async (): Promise<unknown> => {
    await duringAccountLookup?.();
    return mockAccountId === null ? null : { account: { id: mockAccountId } };
  },
}));

const ALPHA = 'lin_api_fake_alpha';
const REVOKED = 'lin_api_fake_revoked';
const tokenLabel = (token: string | null | undefined): string =>
  token === ALPHA
    ? '<alpha>'
    : token === REVOKED
      ? '<revoked>'
      : token
        ? '<unknown>'
        : 'none';

const ISSUE = {
  id: 'issue-1',
  identifier: 'ABC-1',
  title: 'Login fails on Safari',
  description: 'Steps: open **login**, see [details](https://example.test).',
  url: 'https://linear.app/acme/issue/ABC-1/login-fails',
  priority: 2,
  priorityLabel: 'High',
  branchName: 'abc-1-login-fails',
};
const OTHER = {
  ...ISSUE,
  id: 'issue-2',
  identifier: 'ABC-2',
  title: 'Login copy',
  url: 'https://linear.app/acme/issue/ABC-2/login-copy',
  branchName: 'abc-2-login-copy',
};

let mode: 'ok' | 'ratelimited' | 'offline' = 'ok';
const requests: string[] = [];

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

// The non-null variables each operation's document declares (linear-api.ts).
const REQUIRED_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  searchIssues: ['term'],
  issue_attachments: ['id', 'first'],
  referencePreviewIssue: ['id'],
  referencePreviewTeams: ['first'],
};

function respondAsLinear(init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get('authorization');
  const body: unknown =
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  const query =
    typeof body === 'object' && body !== null && 'query' in body
      ? String(body.query)
      : '';
  const operation = /^query (\w+)/.exec(query)?.[1] ?? 'unknown';
  const variables: unknown =
    typeof body === 'object' && body !== null && 'variables' in body
      ? body.variables
      : null;
  const variable = (name: string): unknown =>
    typeof variables === 'object' && variables !== null && name in variables
      ? Reflect.get(variables, name)
      : undefined;
  const text = (name: string): string | undefined => {
    const value = variable(name);
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined;
  };
  const required = REQUIRED_VARIABLES[operation] ?? [];
  // The lookup key the fixtures answer: the operation's first variable.
  const key = required[0] === undefined ? undefined : text(required[0]);
  requests.push(
    [
      operation,
      tokenLabel(auth),
      ...required.map((name) => `${name}=${text(name) ?? '<missing>'}`),
    ].join(' '),
  );
  const missing = required.find((name) => text(name) === undefined);
  if (missing !== undefined)
    return json(
      {
        errors: [
          {
            message: `Variable "$${missing}" was not provided.`,
            extensions: { type: 'invalid input' },
          },
        ],
      },
      { status: 400 },
    );
  if (mode === 'offline') throw new TypeError('fetch failed');
  if (mode === 'ratelimited')
    return json(
      {
        errors: [
          { message: 'Rate limited', extensions: { code: 'RATELIMITED' } },
        ],
      },
      { status: 429, headers: { 'retry-after': '30' } },
    );
  if (auth !== ALPHA)
    return json(
      {
        errors: [
          {
            message: 'Authentication required',
            extensions: { type: 'authentication error' },
          },
        ],
      },
      { status: 401 },
    );
  switch (operation) {
    case 'viewer':
      return json({ data: { viewer: { name: 'Ada', displayName: 'ada' } } });
    case 'searchIssues':
      // Only the lookups the golden makes find issues.
      return json({
        data: {
          searchIssues: {
            nodes:
              key !== undefined && ['ABC-1', 'login'].includes(key)
                ? [OTHER, ISSUE]
                : [],
          },
        },
      });
    case 'issue_attachments':
      // Only the issue the golden looks up has attachments.
      if (key !== ISSUE.id) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            attachments: {
              nodes: [
                {
                  url: 'https://github.com/acme/app/pull/7',
                  sourceType: 'github',
                  title: 'Fix login',
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      });
    case 'referencePreviewIssue':
      if (key !== ISSUE.identifier) return json({ data: { issue: null } });
      return json({
        data: {
          issue: {
            identifier: ISSUE.identifier,
            title: ISSUE.title,
            description: ISSUE.description,
            url: ISSUE.url,
            updatedAt: '2026-11-01T00:00:00.000Z',
            state: { name: 'In Progress', type: 'started' },
            assignee: { displayName: 'ada', name: 'Ada', avatarUrl: null },
            project: { name: 'Web' },
          },
        },
      });
    case 'referencePreviewTeams':
      return json({
        data: {
          teams: {
            nodes: [{ key: 'abc' }, { key: 'OPS' }, { key: 'bad key' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    default:
      return json({ errors: [{ message: 'Unknown query' }] }, { status: 400 });
  }
}

// A thrown error (offline) rejects, as a failed fetch does.
const fakeLinear = (
  _input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> =>
  new Promise((resolve) => resolve(respondAsLinear(init)));

// A recognisable stand-in for the OS cipher: sealed bytes never carry the
// plaintext, and anything not sealed by it fails to decrypt.
const SEALED = 'sealed:';
const seal = (value: string): Buffer =>
  Buffer.from(`${SEALED}${Buffer.from(value, 'utf8').toString('base64')}`);
function unseal(value: Buffer): string {
  const text = value.toString('utf8');
  if (!text.startsWith(SEALED)) throw new Error('Unable to decrypt');
  return Buffer.from(text.slice(SEALED.length), 'base64').toString('utf8');
}

// Each projection replaces the grants with its own one.
const DESKTOP_IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

// The wrapper's structured rejection, without its per-call id and times.
function rejection(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const parsed: unknown = JSON.parse(message);
  if (typeof parsed !== 'object' || parsed === null || !('appError' in parsed))
    return message;
  // The renderer reads `legacy` when it picks the recovery actions to offer.
  const legacy: unknown = Reflect.get(parsed, 'legacy');
  const appError: unknown = parsed.appError;
  if (typeof appError !== 'object' || appError === null) return message;
  const pick = (name: string): unknown => Reflect.get(appError, name);
  return {
    code: pick('code'),
    copy: pick('copy'),
    detail: pick('detail'),
    kind: pick('kind'),
    legacy,
    recovery: pick('recovery'),
    source: pick('source'),
  };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  try {
    return { resolved: await handler(event, ...args) };
  } catch (error) {
    return { rejected: rejection(error) };
  }
}

// Scopes are digests of the account and token: label them by first sight.
const scopes = new Map<string, string>();
function masked(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry: unknown) => {
      if (key === 'scope' && typeof entry === 'string') {
        if (!scopes.has(entry)) scopes.set(entry, `<scope-${scopes.size + 1}>`);
        return scopes.get(entry);
      }
      if (key === 'fetchedAt' && typeof entry === 'number') return '<time>';
      if (typeof entry === 'string' && (entry === ALPHA || entry === REVOKED))
        return tokenLabel(entry);
      return entry;
    }),
  );
}

const steps: Array<{ step: string; result: unknown; requests: string[] }> = [];
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  requests.length = 0;
  const result = masked(await run());
  steps.push({ step: name, result, requests: [...requests] });
}

const preview = (identifier: string, workspaceSlug?: string): object => ({
  identifier,
  ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
});

let getLinearTokenFilePath: () => string;
let dispatcher: CoreIntegrationDispatcher;

beforeAll(async () => {
  ({ getLinearTokenFilePath } = await import('../lib/paths'));
  expect(getLinearTokenFilePath().startsWith(suiteRoot)).toBe(true);
  jest.spyOn(safeStorage, 'encryptString').mockImplementation(seal);
  jest.spyOn(safeStorage, 'decryptString').mockImplementation(unseal);
  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeLinear);
  jest.spyOn(ipcMain, 'removeHandler').mockImplementation(() => undefined);
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler as Handler);
  });
  const { registerSettingsHandlers } = await import('../ipc/settings');
  const { registerReferencePreviewHandlers } =
    await import('../ipc/reference-previews');
  // The desktop core.integration handlers and host, on a dispatcher that
  // installs only them; imported after the handlers, as main loads them.
  const { createCoreIntegrationAdapter } =
    await import('../canopy-runtime/core-integration-adapter');
  const integration = createCoreIntegrationAdapter();
  dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: CORE_INTEGRATION_QUERIES,
      instructions: CORE_INTEGRATION_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: integration.queries,
      instructions: integration.instructions,
      streams: {},
    },
  });
  const runtime = {
    dispatcher,
    resolveCaller: (): CanopyCallerDescriptor => DESKTOP_IPC_CALLER,
  };
  registerSettingsHandlers(runtime);
  registerReferencePreviewHandlers(runtime);
});

it('captures the Linear connection, lookups and sign-out as desktop serves them', async () => {
  const all = async (): Promise<unknown> => ({
    scope: await invoke(IPC_CHANNELS.referencePreviewLinearScope),
    teams: await invoke(IPC_CHANNELS.referencePreviewLinearTeams),
    issue: await invoke(
      IPC_CHANNELS.referencePreviewLinearIssue,
      preview('ABC-1'),
    ),
  });

  // Not connected.
  await step('load token, none stored', () =>
    invoke(IPC_CHANNELS.settingsLoadLinearToken),
  );
  await step('search identifier, not connected', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  await step('search text, not connected', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'login'),
  );
  await step('previews, not connected', all);

  // Validation uses only the candidate it is given.
  await step('validate empty', () =>
    invoke(IPC_CHANNELS.settingsValidateLinearToken, ' '),
  );
  await step('validate good', () =>
    invoke(IPC_CHANNELS.settingsValidateLinearToken, ` ${ALPHA} `),
  );
  await step('validate rejected', () =>
    invoke(IPC_CHANNELS.settingsValidateLinearToken, REVOKED),
  );
  // The candidate is trimmed before any bound, as before.
  const padding = ' '.repeat(20000);
  await expect(
    invoke(
      IPC_CHANNELS.settingsValidateLinearToken,
      `${padding}${ALPHA}${padding}`,
    ),
  ).resolves.toEqual(
    await invoke(IPC_CHANNELS.settingsValidateLinearToken, ALPHA),
  );
  // Past the canonical secret bound, the legacy answer still stands.
  await expect(
    invoke(IPC_CHANNELS.settingsValidateLinearToken, 'x'.repeat(16385)),
  ).resolves.toEqual({
    resolved: {
      authenticated: false,
      displayName: null,
      error: 'Invalid API key or unable to reach Linear.',
    },
  });

  // Connected.
  await step('save token', () =>
    invoke(IPC_CHANNELS.settingsSaveLinearToken, ` ${ALPHA} `),
  );
  await step('load token', () => invoke(IPC_CHANNELS.settingsLoadLinearToken));
  // At rest the token is sealed by the OS cipher, never plaintext.
  const stored = readFileSync(getLinearTokenFilePath());
  expect(stored.includes(ALPHA)).toBe(false);
  expect(unseal(stored)).toBe(ALPHA);
  await step('search identifier', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'abc-1'),
  );
  await step('search text', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'login'),
  );
  await step('search blank', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, '  '),
  );
  await step('previews', all);
  await step('teams again, cached', () =>
    invoke(IPC_CHANNELS.referencePreviewLinearTeams),
  );
  await step('issue from another workspace', () =>
    invoke(IPC_CHANNELS.referencePreviewLinearIssue, preview('ABC-1', 'other')),
  );
  // One machine-wide token: switching the signed-in account keeps it, and only
  // the preview scope (account and token) changes.
  mockAccountId = 'account-one';
  await step('previews, signed in as account one', all);
  mockAccountId = 'account-two';
  await step('previews, signed in as account two', all);
  await step('search identifier, account two', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  mockAccountId = null;
  await step('invalid preview request', () =>
    invoke(IPC_CHANNELS.referencePreviewLinearIssue, { identifier: 7 }),
  );

  // Provider failures.
  mode = 'ratelimited';
  await step('search identifier, rate limited', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  await step('issue, rate limited', () =>
    invoke(IPC_CHANNELS.referencePreviewLinearIssue, preview('ABC-1')),
  );
  mode = 'offline';
  await step('search identifier, offline', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  await step('validate, offline', () =>
    invoke(IPC_CHANNELS.settingsValidateLinearToken, ALPHA),
  );
  mode = 'ok';

  // Revocation: the stored key stops working at Linear.
  await step('save revoked token', () =>
    invoke(IPC_CHANNELS.settingsSaveLinearToken, REVOKED),
  );
  await step('search identifier, revoked', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  await step('search text, revoked', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'login'),
  );
  await step('previews, revoked', all);
  await step('previews again, revoked key held back', all);

  // Sign-out from a working connection, so it alone must stop the requests.
  await step('save token again', () =>
    invoke(IPC_CHANNELS.settingsSaveLinearToken, ALPHA),
  );
  await step('previews, reconnected', all);
  await step('clear token', () =>
    invoke(IPC_CHANNELS.settingsSaveLinearToken, ''),
  );
  await step('load token after clear', () =>
    invoke(IPC_CHANNELS.settingsLoadLinearToken),
  );
  expect(existsSync(getLinearTokenFilePath())).toBe(false);
  await step('search identifier after clear', () =>
    invoke(IPC_CHANNELS.settingsSearchLinearIssues, 'ABC-1'),
  );
  await step('previews after clear', all);

  expect(steps).toMatchSnapshot();
});

it('refuses a team page when the token is cleared during the scope recheck', async () => {
  await invoke(IPC_CHANNELS.settingsSaveLinearToken, ALPHA);
  // The read resolves the scope once, then core rechecks it after the fetch:
  // sign out inside that recheck's account lookup.
  let lookups = 0;
  duringAccountLookup = async (): Promise<void> => {
    lookups += 1;
    if (lookups === 2) await invoke(IPC_CHANNELS.settingsSaveLinearToken, '');
  };
  try {
    const outcome = await dispatcher
      .query(
        'core.integration.resource.list',
        {
          integrationId: 'linear',
          kinds: ['team'],
          query: null,
          cursor: null,
          limit: 200,
        },
        {
          caller: {
            ...DESKTOP_IPC_CALLER,
            grants: ['core.integration.read'],
          },
        },
      )
      .then(
        (page) => ({ page }),
        (error: unknown) => ({
          refused:
            error instanceof CanopyOperationError ? error.payload : error,
        }),
      );
    expect(lookups).toBe(2);
    expect(outcome).toStrictEqual({
      refused: {
        kind: 'unavailable',
        message: 'The Linear credential changed during the read.',
        retry: { kind: 'same_request' },
      },
    });
  } finally {
    duringAccountLookup = null;
    await invoke(IPC_CHANNELS.settingsSaveLinearToken, '');
  }
});
