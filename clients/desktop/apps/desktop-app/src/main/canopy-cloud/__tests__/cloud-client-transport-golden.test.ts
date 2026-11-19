// CAN-4168 golden: the cloud HTTP client as desktop serves it today, captured
// before its credentials resolve through the core account session. It drives
// the real client and the real encrypted account store on the isolated test
// data root; only the cloud base URL, the replica fences and fetch are
// replaced. Every credential here is a fake.
import { safeStorage } from 'electron';
import { writeFileSync } from 'node:fs';
import { BRAND } from '@canopy/brand/current';
import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import type * as CloudConfig from '../config';
import { getCanopyCloudAccountFilePath } from '../../lib/paths';
import {
  clearCanopyCloudAccount,
  getCanopyCloudCredentials,
  invalidateCanopyCloudAccountCache,
  mergeCanopyCloudAccountCapabilities,
  saveCanopyCloudAccount,
  type CanopyCloudAccountEntry,
} from '../../lib/canopy-cloud-account-store';
import { resetCanopyCloudSessionCredential } from '../session-status';
import { trackCloudWrites } from '../cloud-write-tracking';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  openCanopyCloudStream,
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudMultipartJson,
  requestCanopyCloudNoContent,
  requestCanopyCloudPublicJson,
  resolveCanopyCloudCredentialContext,
  resolveCanopyCloudCredentialContextWithCapability,
} from '../client';

jest.setTimeout(20_000);

const BASE = 'https://cloud.example.test';
let baseUrlConfigured = true;
jest.mock('../config', () => {
  const actual = jest.requireActual<typeof CloudConfig>('../config');
  return {
    ...actual,
    getCanopyCloudBaseUrl: (): string => {
      if (!baseUrlConfigured) {
        throw new actual.CanopyCloudConfigError(
          'base-url-not-configured',
          'Cloud base URL is not configured.',
        );
      }
      return BASE;
    },
  };
});
jest.mock('../../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));
jest.mock('../../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): object => ({
    withReplicaPurgeFence: (
      persist: () => Promise<unknown>,
    ): Promise<unknown> => persist(),
  }),
}));

const CLOUD = `${BRAND.displayName} Cloud`;
const TEST_KEY = 'test-api-key';
const OTHER_KEY = 'test-api-key-other';
const WELL_KNOWN = `/.well-known/${BRAND.web.wellKnownNamespace}`;
const ENTRY: CanopyCloudAccountEntry = {
  apiKey: TEST_KEY,
  authMode: 'api_key',
  credentialSource: 'manual',
  capabilities: ['account-v1'],
  memorySearchOrganizationExternalIds: ['33333333-3333-4333-8333-333333333333'],
  account: {
    id: 'account-test',
    name: 'Test Account',
    email: 'account-test@example.test',
    role: 'DEVELOPER',
  },
  organizations: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Test Org',
      role: 'MEMBER',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: 'none' | 'text' | 'form-data';
  hasSignal: boolean;
}
type Reply = (request: SentRequest, init: RequestInit) => Promise<Response>;

/**
 * Each test gets its own recorder. Requests a test starts are tracked and
 * settled in afterEach, so none can reach the next test's fetch.
 */
interface Recorder {
  readonly sent: SentRequest[];
  readonly replies: Reply[];
  readonly arrivals: { count: number; resolve: () => void }[];
  readonly hanging: (() => void)[];
  readonly pending: Promise<unknown>[];
  fakeTimers: boolean;
  closed: boolean;
}

let recorder: Recorder;
let sent: SentRequest[];
let fetchSpy: jest.SpyInstance;

function record(input: unknown, init: RequestInit = {}): SentRequest {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return {
    url: String(input),
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
    body:
      init.body === undefined || init.body === null
        ? 'none'
        : init.body instanceof FormData
          ? 'form-data'
          : 'text',
    hasSignal: init.signal instanceof AbortSignal,
  };
}

function reply(...next: Reply[]): void {
  recorder.replies.push(...next);
}

/** Tracks a request the test does not await at once, so afterEach can settle it. */
function track<T>(promise: Promise<T>): Promise<T> {
  recorder.pending.push(promise.catch(() => undefined));
  return promise;
}

function useFakeTimers(): void {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  recorder.fakeTimers = true;
}

/** Resolves once the test's fetch has received `count` requests. */
function sentCount(count: number): Promise<void> {
  const current = recorder;
  if (current.sent.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    current.arrivals.push({ count, resolve });
  });
}

function json(status: number, body: unknown, headers = {}): Reply {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
}

function text(status: number, body: string | null, headers = {}): Reply {
  return () => Promise.resolve(new Response(body, { status, headers }));
}

function fail(error: Error): Reply {
  return () => Promise.reject(error);
}

function abortError(): Error {
  const aborted = new Error('The operation was aborted.');
  aborted.name = 'AbortError';
  return aborted;
}

function hang(): Reply {
  return (_request, init) =>
    new Promise((_resolve, reject) => {
      if (recorder.closed) {
        reject(abortError());
        return;
      }
      recorder.hanging.push(() => reject(abortError()));
      init.signal?.addEventListener('abort', () => reject(abortError()));
    });
}

function seal(value: string): Buffer {
  return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`);
}
function unseal(value: Buffer): string {
  const sealed = value.toString('utf8');
  if (!sealed.startsWith('sealed:')) throw new Error('Unable to decrypt');
  return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString();
}

/**
 * The stored account once every capability merge already queued on the
 * account save lock has run: an empty merge queues behind them and changes
 * nothing.
 */
function afterQueuedMerges(): Promise<CanopyCloudAccountEntry | null> {
  return mergeCanopyCloudAccountCapabilities([], TEST_KEY);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  void track(promise);
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

function clientError(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(CanopyCloudClientError);
  const failure = error as CanopyCloudClientError;
  return {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    serverCode: failure.serverCode,
    serverScope: failure.serverScope,
    isValidatedServerError: failure.isValidatedServerError,
    retryAfterMs: failure.retryAfterMs,
    retryableNetworkFailure: failure.retryableNetworkFailure,
    requestId: failure.requestId,
    serverReason: failure.serverReason,
    failedRead: failure.failedRead,
  };
}

beforeAll(() => {
  jest.spyOn(safeStorage, 'encryptString').mockImplementation(seal);
  jest.spyOn(safeStorage, 'decryptString').mockImplementation(unseal);
});

beforeEach(async () => {
  baseUrlConfigured = true;
  const current: Recorder = {
    sent: [],
    replies: [],
    arrivals: [],
    hanging: [],
    pending: [],
    fakeTimers: false,
    closed: false,
  };
  recorder = current;
  sent = current.sent;
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => {
      const request = record(input, init);
      current.sent.push(request);
      for (const arrival of current.arrivals.filter(
        (waiting) => current.sent.length >= waiting.count,
      ))
        arrival.resolve();
      const next = current.replies.shift();
      if (!next) {
        return Promise.reject(new Error(`Unexpected request ${request.url}`));
      }
      return next(request, init ?? {});
    });
  await clearCanopyCloudAccount();
  resetCanopyCloudSessionCredential();
  invalidateCanopyCloudAccountCache();
  await saveCanopyCloudAccount(ENTRY);
});

afterEach(async () => {
  recorder.closed = true;
  recorder.hanging.forEach((abort) => abort());
  if (recorder.fakeTimers) await jest.runAllTimersAsync();
  await Promise.all(recorder.pending);
  jest.useRealTimers();
  fetchSpy.mockRestore();
});

describe('credentials', () => {
  it('signs implicit requests with the stored key and the protocol headers', async () => {
    reply(json(200, { ok: true }), json(200, { ok: true }));
    await expect(requestCanopyCloudJson('/api/v1/read')).resolves.toEqual({
      ok: true,
    });
    await requestCanopyCloudJson('/api/v1/write', {
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
      headers: { 'X-Caller': 'kept' },
    });
    expect(sent).toEqual([
      {
        url: `${BASE}/api/v1/read`,
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${TEST_KEY}`,
          [MODEL_LIBRARY_PROTOCOL_HEADER.toLowerCase()]: String(
            MODEL_LIBRARY_PROTOCOL_VERSION,
          ),
        },
        body: 'none',
        hasSignal: true,
      },
      {
        url: `${BASE}/api/v1/write`,
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${TEST_KEY}`,
          'content-type': 'application/json',
          'x-caller': 'kept',
          [MODEL_LIBRARY_PROTOCOL_HEADER.toLowerCase()]: String(
            MODEL_LIBRARY_PROTOCOL_VERSION,
          ),
        },
        body: 'text',
        hasSignal: true,
      },
    ]);
  });

  it('uses an explicit credential context without reading the store', async () => {
    await clearCanopyCloudAccount();
    reply(json(200, { ok: true }));
    await requestCanopyCloudJson('/api/v1/read', {
      credentialContext: {
        baseUrl: 'https://other.example.test',
        apiKey: OTHER_KEY,
      },
    });
    expect(
      sent.map((request) => [request.url, request.headers.authorization]),
    ).toEqual([
      ['https://other.example.test/api/v1/read', `Bearer ${OTHER_KEY}`],
    ]);
  });

  it('reads the stored account as fresh copies', async () => {
    const first = await getCanopyCloudCredentials();
    expect(first).toEqual({
      baseUrl: BASE,
      apiKey: TEST_KEY,
      capabilities: ['account-v1'],
      memorySearchOrganizationExternalIds: [
        '33333333-3333-4333-8333-333333333333',
      ],
      account: ENTRY.account,
      organizations: ENTRY.organizations,
      teams: [],
    });
    first.capabilities.push('mutated');
    first.organizations?.splice(0);
    const context = await resolveCanopyCloudCredentialContext();
    expect(context).toEqual(await getCanopyCloudCredentials());
    expect(context.capabilities).toEqual(['account-v1']);
    expect(context.account).toEqual(ENTRY.account);
  });

  it('maps a missing account or base URL to the client error codes', async () => {
    await clearCanopyCloudAccount();
    expect(
      clientError(await caught(requestCanopyCloudJson('/x'))),
    ).toMatchObject({
      code: 'missing-api-key',
      message: `${CLOUD} API key is required.`,
    });
    expect(
      clientError(await caught(resolveCanopyCloudCredentialContext())),
    ).toMatchObject({ code: 'missing-api-key' });
    await saveCanopyCloudAccount(ENTRY);
    baseUrlConfigured = false;
    expect(
      clientError(await caught(requestCanopyCloudJson('/x'))),
    ).toMatchObject({
      code: 'cloud-not-configured',
      message: 'Cloud base URL is not configured.',
    });
    expect(sent).toEqual([]);
  });

  it('treats an unreadable account as missing, unless the caller keeps read errors', async () => {
    writeFileSync(getCanopyCloudAccountFilePath(), 'not sealed');
    invalidateCanopyCloudAccountCache();
    expect(
      clientError(await caught(requestCanopyCloudJson('/x'))),
    ).toMatchObject({
      code: 'missing-api-key',
    });
    const kept = await caught(
      resolveCanopyCloudCredentialContextWithCapability('account-v1'),
    );
    expect(kept).not.toBeInstanceOf(CanopyCloudClientError);
    expect(sent).toEqual([]);
  });
});

describe('capabilities', () => {
  it('trusts a stored capability without a request', async () => {
    await assertCanopyCloudCapability('account-v1');
    expect(sent).toEqual([]);
  });

  it('discovers a live capability and merges it into the stored account', async () => {
    reply(
      json(200, { capabilities: ['account-v1', 'collections-crud-v1', 7] }),
    );
    await assertCanopyCloudCapability('collections-crud-v1');
    expect(
      sent.map((request) => [request.url, request.headers.authorization]),
    ).toEqual([[`${BASE}${WELL_KNOWN}`, `Bearer ${TEST_KEY}`]]);
    expect((await afterQueuedMerges())?.capabilities).toEqual([
      'account-v1',
      'collections-crud-v1',
    ]);
  });

  it('does not merge capabilities discovered with an explicit context', async () => {
    reply(json(200, { capabilities: ['collections-crud-v1'] }));
    await assertCanopyCloudCapability('collections-crud-v1', {
      baseUrl: BASE,
      apiKey: TEST_KEY,
    });
    expect((await afterQueuedMerges())?.capabilities).toEqual(['account-v1']);
  });

  it('refuses a capability the cloud does not list', async () => {
    reply(json(200, { capabilities: ['account-v1'] }));
    expect(
      clientError(await caught(assertCanopyCloudCapability('missing-v1'))),
    ).toMatchObject({
      code: 'unsupported-capability',
      message: `${CLOUD} does not support missing-v1.`,
    });
  });

  it('resolves a context with a capability from one account read', async () => {
    reply(json(200, { capabilities: ['account-v1', 'teams-v1'] }));
    const context =
      await resolveCanopyCloudCredentialContextWithCapability('teams-v1');
    expect(context.apiKey).toBe(TEST_KEY);
    expect(sent).toHaveLength(1);
  });
});

describe('errors', () => {
  it('keeps the server envelope, Retry-After and request id', async () => {
    reply(
      json(
        401,
        {
          error: 'Key revoked.',
          code: 'key_revoked',
          scope: 'account',
          reason: 'revoked',
        },
        { 'retry-after': '3', 'x-request-id': 'req-123' },
      ),
    );
    expect(
      clientError(
        await caught(
          requestCanopyCloudJson('/x', { method: 'POST', body: '{}' }),
        ),
      ),
    ).toEqual({
      code: 'http-error',
      message: 'HTTP 401: Key revoked.',
      status: 401,
      serverCode: 'key_revoked',
      serverScope: 'account',
      isValidatedServerError: true,
      retryAfterMs: 3000,
      retryableNetworkFailure: false,
      requestId: 'req-123',
      serverReason: 'revoked',
      failedRead: false,
    });
  });

  it('reads nested codes, plain text bodies and invalid JSON', async () => {
    reply(
      json(409, { error: { code: 'conflict', message: 'Already exists.' } }),
      text(500, 'upstream exploded'),
      text(200, 'not json', { 'content-type': 'application/json' }),
    );
    const write = { method: 'POST', body: '{}' };
    expect(
      clientError(await caught(requestCanopyCloudJson('/a', write))),
    ).toMatchObject({
      message: 'HTTP 409: Already exists.',
      serverCode: 'conflict',
      isValidatedServerError: true,
    });
    expect(
      clientError(await caught(requestCanopyCloudJson('/b', write))),
    ).toMatchObject({
      message: 'HTTP 500: upstream exploded',
      isValidatedServerError: false,
    });
    expect(
      clientError(await caught(requestCanopyCloudJson('/c', write))),
    ).toMatchObject({
      code: 'invalid-response',
      message: `HTTP 200: ${CLOUD} returned invalid JSON.`,
    });
  });
});

describe('retries and timeouts', () => {
  it('retries an idempotent read at 400 ms and 1,500 ms, then fails the read', async () => {
    useFakeTimers();
    reply(text(503, 'busy'), text(503, 'busy'), text(503, 'busy'));
    const result = caught(track(requestCanopyCloudJson('/x')));
    await sentCount(1);
    await jest.advanceTimersByTimeAsync(399);
    expect(sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1_499);
    expect(sent).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(clientError(await result)).toMatchObject({
      status: 503,
      failedRead: true,
    });
    expect(sent).toHaveLength(3);
  });

  it('honours Retry-After up to 5 s and recovers', async () => {
    useFakeTimers();
    reply(text(502, 'busy', { 'retry-after': '60' }), json(200, { ok: true }));
    const result = track(requestCanopyCloudJson('/x'));
    await sentCount(1);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('retries a read after a network failure, never a write or a 404', async () => {
    useFakeTimers();
    reply(fail(new TypeError('fetch failed')), json(200, { ok: true }));
    const read = track(requestCanopyCloudJson('/x'));
    await sentCount(1);
    await jest.advanceTimersByTimeAsync(400);
    await expect(read).resolves.toEqual({ ok: true });

    reply(text(503, 'busy'), text(404, 'missing'));
    expect(
      clientError(
        await caught(
          requestCanopyCloudJson('/w', { method: 'POST', body: '{}' }),
        ),
      ),
    ).toMatchObject({ status: 503, failedRead: false });
    expect(
      clientError(await caught(requestCanopyCloudJson('/y'))),
    ).toMatchObject({
      status: 404,
      failedRead: true,
    });
    expect(sent).toHaveLength(4);
  });

  it('stops a read waiting to retry when the caller aborts', async () => {
    useFakeTimers();
    const controller = new AbortController();
    reply(text(503, 'busy'));
    const result = caught(
      requestCanopyCloudJson('/x', { signal: controller.signal }),
    );
    await sentCount(1);
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(clientError(await result)).toMatchObject({
      code: 'network-error',
      message: `${CLOUD} request cancelled.`,
      failedRead: true,
    });
    expect(sent).toHaveLength(1);
  });

  it('times a request out after 15 s, or the caller’s timeout', async () => {
    useFakeTimers();
    reply(hang(), hang());
    const write = caught(
      requestCanopyCloudJson('/w', { method: 'POST', body: '{}' }),
    );
    await sentCount(1);
    await jest.advanceTimersByTimeAsync(14_999);
    expect(sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(clientError(await write)).toMatchObject({
      code: 'network-error',
      message: `${CLOUD} request timed out.`,
      retryableNetworkFailure: true,
      failedRead: false,
    });
    const short = caught(
      requestCanopyCloudJson('/w', {
        method: 'POST',
        body: '{}',
        timeoutMs: 50,
      }),
    );
    await sentCount(2);
    await jest.advanceTimersByTimeAsync(49);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(clientError(await short)).toMatchObject({
      message: `${CLOUD} request timed out.`,
    });
  });
});

describe('request shapes', () => {
  it('sends If-None-Match and answers a 304 as not modified', async () => {
    reply(text(304, null), json(200, { items: [] }, { etag: '"v2"' }));
    await expect(
      requestCanopyCloudJsonConditional('/c', { etag: '"v1"' }),
    ).resolves.toEqual({ status: 'not-modified' });
    await expect(
      requestCanopyCloudJsonConditional('/c', { etag: null }),
    ).resolves.toEqual({ status: 'fresh', body: { items: [] }, etag: '"v2"' });
    expect(sent.map((request) => request.headers['if-none-match'])).toEqual([
      '"v1"',
      undefined,
    ]);
    expect(
      sent.every((r) => r.headers.authorization === `Bearer ${TEST_KEY}`),
    ).toBe(true);
  });

  it('posts multipart, binary, no-content and public requests', async () => {
    reply(
      json(200, { id: 'upload' }),
      text(200, 'gzip-bytes'),
      text(204, null),
      json(200, { plans: [] }),
    );
    const formData = new FormData();
    formData.append('file', 'content');
    await expect(
      requestCanopyCloudMultipartJson('/upload', { formData }),
    ).resolves.toEqual({ id: 'upload' });
    await expect(requestCanopyCloudBinary('/blob')).resolves.toEqual(
      Buffer.from('gzip-bytes'),
    );
    await expect(
      requestCanopyCloudNoContent('/share', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
    await expect(requestCanopyCloudPublicJson('/pricing')).resolves.toEqual({
      plans: [],
    });
    expect(
      sent.map((request) => ({
        method: request.method,
        accept: request.headers.accept,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: request.body,
      })),
    ).toEqual([
      {
        method: 'POST',
        accept: 'application/json',
        authorization: `Bearer ${TEST_KEY}`,
        contentType: undefined,
        body: 'form-data',
      },
      {
        method: 'GET',
        accept: 'application/gzip',
        authorization: `Bearer ${TEST_KEY}`,
        contentType: undefined,
        body: 'none',
      },
      {
        method: 'DELETE',
        accept: 'application/json',
        authorization: `Bearer ${TEST_KEY}`,
        contentType: undefined,
        body: 'none',
      },
      {
        method: 'GET',
        accept: 'application/json',
        authorization: undefined,
        contentType: undefined,
        body: 'none',
      },
    ]);
  });

  it('opens a stream with the caller’s signal and no client timeout', async () => {
    useFakeTimers();
    const controller = new AbortController();
    let streamSignal: AbortSignal | null | undefined;
    reply((_request, init) => {
      streamSignal = init.signal;
      return Promise.resolve(new Response('data: 1\n\n', { status: 200 }));
    });
    const response = await openCanopyCloudStream('/events', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(streamSignal).toBe(controller.signal);
    expect(jest.getTimerCount()).toBe(0);
    expect(sent[0]?.headers).toEqual({
      accept: 'text/event-stream',
      authorization: `Bearer ${TEST_KEY}`,
    });
  });

  it('marks a write as sent once it is attempted, never a read', async () => {
    reply(json(200, {}), fail(new TypeError('fetch failed')));
    const read = trackCloudWrites(() => requestCanopyCloudJson('/r'));
    await read.result;
    expect(read.writeSent()).toBe(false);
    const write = trackCloudWrites(() =>
      requestCanopyCloudJson('/w', { method: 'POST', body: '{}' }),
    );
    expect(clientError(await caught(write.result))).toMatchObject({
      code: 'network-error',
      message: 'fetch failed',
    });
    expect(write.writeSent()).toBe(true);
  });
});
