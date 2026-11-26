import { createHash } from 'node:crypto';
import {
  subscribe as subscribeChannel,
  unsubscribe as unsubscribeChannel,
} from 'node:diagnostics_channel';
import { getEventListeners } from 'node:events';
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  Server,
  type IncomingHttpHeaders,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createMemoryVaultRepository } from '../../../vault/testing';
import {
  CLOUD_ACCOUNT_VAULT_FAMILY,
  createCloudAccountAuthority,
  createCloudAccountCustody,
  createCloudAccountRefresher,
  probeCloudAccount,
  buildCloudAccountSnapshot,
  readCloudAccountRecord,
  readCloudAccountAccess,
  type CloudAccountAuthority,
} from '../../cloud-account/daemon';
import { AI_CREDITS_PROXY_ERROR_MARKER } from '@canopy/protocol';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  CodexGatewayProxyService,
  LOOPBACK_BROKER_AUTH_TOKEN,
  LOOPBACK_BROKER_SECRET_HEADER,
  createDaemonModelBroker,
  type DaemonModelBroker,
  type DaemonModelRouteBinding,
} from '..';
import type { GatewayDaemonRoutePolicy } from '../gateway-proxy';

async function replaceAccount(
  authority: CloudAccountAuthority,
  next: Record<string, unknown> | null,
): ReturnType<CloudAccountAuthority['provision']> {
  const read = await authority.read();
  const expected =
    read.kind === 'ok' && read.record
      ? createHash('sha256').update(read.record.apiKey).digest('hex')
      : null;
  return authority.provision(next, expected);
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function entry(
  apiKey: string,
  accountId = 'account-1',
): Record<string, unknown> {
  return {
    apiKey,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    account: {
      id: accountId,
      name: 'A',
      email: 'a@example.test',
      role: 'ADMIN',
    },
    organizations: [],
    enforcedSettings: [],
    organizationsVerified: true,
    modelPolicyVerified: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const ORG = '0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

/** An account that belongs to {@link ORG}. */
function memberEntry(apiKey: string): Record<string, unknown> {
  return {
    ...entry(apiKey),
    organizations: [
      {
        id: ORG,
        name: 'Org',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    orgBillingStates: [],
  };
}

let upstream: Server;
let upstreamUrl: string;
let nextStatus = 200;
let nextPolicyCode: string | undefined;
let nextBody: string | undefined;
let accountStatus = 200;
/** Set with a 3xx `nextStatus` to answer a model request with a redirect. */
let nextLocation: string | undefined;
/** Runs before each model response is written, e.g. to change policy mid-retry. */
let beforeRespond: (() => Promise<void>) | undefined;
const seen: Seen[] = [];

beforeAll(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.url === '/redirect-target') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/.well-known/fixture') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ capabilities: [] }));
        return;
      }
      if (request.url === '/account') {
        response.writeHead(accountStatus, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            account: {
              id: 'account-1',
              name: 'A',
              email: 'a@example.test',
              role: 'ADMIN',
            },
            organizations: [],
            enforcedSettings: [],
          }),
        );
        return;
      }
      void (beforeRespond?.() ?? Promise.resolve()).then(() => {
        response.writeHead(nextStatus, {
          'content-type': 'application/json',
          ...(nextLocation === undefined ? {} : { location: nextLocation }),
        });
        response.end(
          nextBody ??
            JSON.stringify({ ok: nextStatus === 200, code: nextPolicyCode }),
        );
      });
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address: string | AddressInfo | null = upstream.address();
  if (address === null || typeof address === 'string')
    throw new Error('No port');
  upstreamUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  nextStatus = 200;
  nextPolicyCode = undefined;
  nextBody = undefined;
  accountStatus = 200;
  nextLocation = undefined;
  beforeRespond = undefined;
});

async function compose(
  initial: Record<string, unknown> = entry('csk-upstream-secret'),
  retry: { retryDelaysMs: number[]; retryBudgetMs: number } = {
    retryDelaysMs: [],
    retryBudgetMs: 1_000,
  },
): Promise<{
  authority: CloudAccountAuthority;
  broker: DaemonModelBroker;
  proxy: CodexGatewayProxyService;
  /** Probes the account endpoint, as the broker does after a 401. */
  refresh: () => Promise<void>;
  setEpoch: (epoch: string) => void;
  setBase: (base: string) => void;
}> {
  const memory = createMemoryVaultRepository();
  const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
  const custody = createCloudAccountCustody({
    repository: () => Promise.resolve(memory.repository),
    writer: () => Promise.resolve(writer),
  });
  await custody.commit({
    expected: null,
    state: 'active',
    credentialGeneration: 1,
    record: readCloudAccountRecord(initial),
  });
  const authority = createCloudAccountAuthority({ custody });
  const proxy = new CodexGatewayProxyService(retry);
  let epoch = 'epoch-1';
  let base = upstreamUrl;
  const refresh = async (): Promise<void> => {
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: buildCloudAccountSnapshot,
      probe: (apiKey, signal) =>
        probeCloudAccount(
          {
            fetch,
            baseUrl: () => base,
            wellKnownPath: '/.well-known/fixture',
            accountPath: '/account',
          },
          apiKey,
          signal,
        ),
    });
    try {
      await refresher.refresh();
    } finally {
      await refresher.dispose();
    }
  };
  const broker = createDaemonModelBroker({
    proxy,
    authority,
    cloudBaseUrl: () => base,
    endpointEpoch: () => epoch,
    refreshAccount: refresh,
  });
  return {
    authority,
    broker,
    proxy,
    refresh,
    setEpoch: (next) => {
      epoch = next;
    },
    setBase: (next) => {
      base = next;
    },
  };
}

function binding(
  overrides: Partial<DaemonModelRouteBinding> = {},
): DaemonModelRouteBinding {
  return {
    executionId: 'exec-1',
    owner: 'personal',
    harness: 'claude',
    governedModelId: 'fixture-model',
    requestModels: { m: 'fixture-model' },
    policyScope: 'union',
    accountId: 'account-1',
    credentialGeneration: 1,
    workOwnerHeader: { 'x-canopy-work-owner': 'personal' },
    ...overrides,
  };
}

/**
 * Wraps the daemon policy of the next broker routes. `hooks` replace single
 * policy members and receive the original member as their last argument.
 */
function wrapDaemonPolicy(
  proxy: CodexGatewayProxyService,
  hooks: {
    readonly preflight?: (
      original: GatewayDaemonRoutePolicy['preflight'],
    ) => Promise<boolean>;
    readonly admitModel?: (
      model: string,
      original: GatewayDaemonRoutePolicy['admitModel'],
    ) => Promise<boolean>;
    readonly prepare?: (
      model: string,
      original: GatewayDaemonRoutePolicy['prepare'],
    ) => ReturnType<GatewayDaemonRoutePolicy['prepare']>;
    readonly settled?: (
      original: GatewayDaemonRoutePolicy['settled'],
    ) => Promise<void>;
    /** Receives the route's upstream withdrawal signal reader. */
    readonly upstreamSignal?: (read: () => AbortSignal) => void;
  },
): void {
  const register = proxy.registerRoute.bind(proxy);
  jest.spyOn(proxy, 'registerRoute').mockImplementation((options) => {
    const daemon = options.daemon;
    if (!daemon) return register(options);
    if (options.upstreamSignal) hooks.upstreamSignal?.(options.upstreamSignal);
    const { preflight, admitModel, prepare, settled } = hooks;
    return register({
      ...options,
      daemon: {
        ...daemon,
        preflight: (): Promise<boolean> =>
          preflight ? preflight(() => daemon.preflight()) : daemon.preflight(),
        admitModel: (model): Promise<boolean> =>
          admitModel
            ? admitModel(model, (next) => daemon.admitModel(next))
            : daemon.admitModel(model),
        prepare: (model): ReturnType<GatewayDaemonRoutePolicy['prepare']> =>
          prepare
            ? prepare(model, (next) => daemon.prepare(next))
            : daemon.prepare(model),
        current: () => daemon.current(),
        settled: (): Promise<void> =>
          settled ? settled(() => daemon.settled()) : daemon.settled(),
        onPolicyRefusal: (code) => daemon.onPolicyRefusal(code),
        onCredentialRejected: (status, version) =>
          daemon.onCredentialRejected(status, version),
      },
    });
  });
}

interface ChildRoute {
  readonly baseUrl: string;
  readonly routeSecret: string;
}

async function child(
  route: string | ChildRoute,
  path = '/v1/messages',
  headers: Record<string, string> = {},
  model = 'm',
): Promise<number> {
  const baseUrl = typeof route === 'string' ? route : route.baseUrl;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LOOPBACK_BROKER_AUTH_TOKEN}`,
      ...(typeof route !== 'string' && {
        [LOOPBACK_BROKER_SECRET_HEADER]: route.routeSecret,
      }),
      ...headers,
    },
    body: JSON.stringify({ model, messages: [] }),
  });
  await response.text();
  return response.status;
}

describe('daemon-hosted model broker', () => {
  it('retires a custody lease prepared before release without contacting upstream', async () => {
    const { broker, proxy } = await compose();
    const prepared = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let released = 0;
    wrapDaemonPolicy(proxy, {
      prepare: async (model, original) => {
        const lease = await original(model);
        if (lease === null || lease === 'model-refused') return lease;
        prepared.resolve();
        await resume.promise;
        return {
          credentialVersion: lease.credentialVersion,
          apply: (headers: Headers): void => lease.apply(headers),
          release: (): void => {
            released += 1;
            lease.release();
          },
        };
      },
    });
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const requesting = child(opened.child);
      await prepared.promise;
      expect(broker.releaseExecution('exec-1')).toBe(1);
      resume.resolve();
      expect(await requesting).toBe(404);
      expect(seen).toHaveLength(0);
      expect(released).toBe(1);
    } finally {
      resume.resolve();
      await broker.shutdown();
    }
  });

  it('preserves legacy token lookup timing across retries', async () => {
    let key = 'csk-legacy-first';
    let lookups = 0;
    const proxy = new CodexGatewayProxyService({ retryDelaysMs: [0] });
    try {
      const route = await proxy.registerRoute({
        sessionId: 'legacy',
        upstreamUrl,
        allowedPaths: ['/v1/messages'],
        resolveToken: (): Promise<string> => {
          lookups++;
          return Promise.resolve(key);
        },
        onUpstreamResponse: () => {
          nextStatus = 200;
          key = 'csk-legacy-second';
        },
      });
      nextStatus = 503;
      expect(await child(route.baseUrl)).toBe(200);
      expect(lookups).toBe(1);
      expect(seen.map(({ headers }) => headers.authorization)).toEqual([
        'Bearer csk-legacy-first',
        'Bearer csk-legacy-first',
      ]);
    } finally {
      await proxy.shutdown();
    }
  });

  it('preserves versioned legacy credentials and their refusal callback', async () => {
    const rejected = jest.fn();
    const proxy = new CodexGatewayProxyService();
    try {
      const route = await proxy.registerRoute({
        sessionId: 'legacy-versioned',
        upstreamUrl,
        allowedPaths: ['/v1/messages'],
        resolveToken: () =>
          Promise.resolve({
            token: 'csk-versioned',
            credentialVersion: 'saved-version',
          }),
        onCredentialRejected: rejected,
      });
      nextStatus = 401;
      expect(await child(route.baseUrl)).toBe(401);
      expect(seen[0]?.headers.authorization).toBe('Bearer csk-versioned');
      expect(rejected).toHaveBeenCalledWith(401, 'saved-version');
    } finally {
      await proxy.shutdown();
    }
  });

  it('gives the child a loopback route and swaps in the upstream key per request', async () => {
    const { broker } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      expect(opened.child.authToken).toBe(LOOPBACK_BROKER_AUTH_TOKEN);
      expect(opened.child.baseUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/codex-gateway\/[a-f0-9]{48}$/,
      );
      expect(JSON.stringify(opened)).not.toContain('csk-upstream-secret');
      expect(await child(opened.child.baseUrl)).toBe(401);
      expect(
        await child(opened.child.baseUrl, '/v1/messages', {
          [LOOPBACK_BROKER_SECRET_HEADER]: 'wrong-secret',
        }),
      ).toBe(401);
      expect(seen).toHaveLength(0);
      expect(
        await child(opened.child, '/v1/messages', {
          'x-canopy-work-owner': `org:${ORG}`,
        }),
      ).toBe(200);
      expect(seen[0]?.path).toBe('/api/v1/llm-proxy/anthropic/v1/messages');
      expect(seen[0]?.headers.authorization).toBe('Bearer csk-upstream-secret');
      const headers = seen[0]?.headers;
      expect(headers).not.toHaveProperty(LOOPBACK_BROKER_SECRET_HEADER);
      // The daemon's admitted funding owner wins over a child-supplied one.
      expect(seen[0]?.headers['x-canopy-work-owner']).toBe('personal');
    } finally {
      await broker.shutdown();
    }
  });

  it('bills the owner that passed admission, in the hosted header format', async () => {
    const { broker } = await compose(memberEntry('csk-upstream-secret'));
    try {
      const opened = await broker.openAiCreditsRoute(
        binding({
          owner: `org:${ORG.toUpperCase()}`,
          // A binding's own owner entry, in any spelling, never reaches billing.
          workOwnerHeader: {
            'X-Canopy-Work-Owner': 'personal',
            'x-canopy-workspace': 'daemon-workspace',
          },
        }),
      );
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      expect(
        await child(opened.child, '/v1/messages', {
          'x-canopy-work-owner': 'personal',
        }),
      ).toBe(200);
      const forwarded = seen[0]?.headers['x-canopy-work-owner'];
      expect(forwarded).toBe(
        serializeWorkspaceContext({
          kind: 'organization',
          organizationId: ORG,
        }),
      );
      expect(
        typeof forwarded === 'string' ? parseWorkspaceContext(forwarded) : null,
      ).toEqual({ kind: 'organization', organizationId: ORG });
      expect(seen[0]?.headers['x-canopy-workspace']).toBe('daemon-workspace');
      // Release matches the owner as admitted, whatever its spelling, and
      // only that owner.
      for (const owner of [
        'org:1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
        'personal',
      ])
        expect(
          broker.release({
            executionId: 'exec-1',
            owner,
            routeId: opened.routeId,
          }),
        ).toBe(false);
      expect(
        broker.release({
          executionId: 'exec-1',
          owner: `org:${ORG}`,
          routeId: opened.routeId,
        }),
      ).toBe(true);
    } finally {
      await broker.shutdown();
    }
  });

  it.each(['{"kind":"personal"}', 'org:not-a-uuid', 'Personal', ''])(
    'opens no route for the malformed owner %j',
    async (owner) => {
      const { broker } = await compose();
      try {
        expect(await broker.openAiCreditsRoute(binding({ owner }))).toEqual({
          kind: 'refused',
          reason: 'unavailable',
        });
        expect(broker.routeCount()).toBe(0);
        expect(seen).toHaveLength(0);
      } finally {
        await broker.shutdown();
      }
    },
  );

  it('opens no route for a well-formed organization the account is not in', async () => {
    const { broker } = await compose();
    try {
      expect(
        await broker.openAiCreditsRoute(binding({ owner: `org:${ORG}` })),
      ).toEqual({ kind: 'refused', reason: 'unavailable' });
      expect(broker.routeCount()).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      await broker.shutdown();
    }
  });

  it("sends only the daemon's attribution headers, never a child's", async () => {
    const { broker } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      expect(
        await child(opened.child, '/v1/messages', {
          'x-canopy-workspace': 'child-workspace',
          'x-canopy-worktree': 'child-worktree',
          'x-canopy-org-project': 'child-project',
        }),
      ).toBe(200);
      const forwarded = Object.keys(seen[0]?.headers ?? {}).filter((name) =>
        name.startsWith('x-canopy-'),
      );
      expect(forwarded).toEqual(['x-canopy-work-owner']);
    } finally {
      await broker.shutdown();
    }
  });

  it('starts no upstream attempt once revocation begins, even after a lease', async () => {
    const { broker, proxy } = await compose();
    const leased = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const decided = Promise.withResolvers<'fenced' | 'sent'>();
    // Pause the other model's request between its lease and its send.
    wrapDaemonPolicy(proxy, {
      prepare: async (model, original) => {
        const lease = await original(model);
        if (model === 'other-admitted' && lease !== null) {
          leased.resolve();
          await resume.promise;
        }
        return lease;
      },
      settled: (original) => {
        decided.resolve('fenced');
        return original();
      },
    });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const checkpoint = jest.fn((): Promise<void> => {
      started.resolve();
      return held.promise;
    });
    try {
      const opened = await broker.openAiCreditsRoute(
        binding({
          requestModels: { m: 'fixture-model', 'other-admitted': 'other' },
          checkpointBeforeRevoke: checkpoint,
        }),
      );
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const pending = child(opened.child, '/v1/messages', {}, 'other-admitted');
      await leased.promise;
      // A hosted policy refusal on the admitted model begins revocation.
      nextStatus = 403;
      nextBody = JSON.stringify({ error: 'x', code: 'model_policy_blocked' });
      const refused = child(opened.child);
      await started.promise;
      expect(seen).toHaveLength(1);
      beforeRespond = (): Promise<void> => {
        decided.resolve('sent');
        return Promise.resolve();
      };
      resume.resolve();
      expect(await decided.promise).toBe('fenced');
      held.resolve();
      expect(await refused).toBe(403);
      expect(await pending).toBe(404);
      expect(seen).toHaveLength(1);
      expect(broker.routeCount()).toBe(0);
    } finally {
      resume.resolve();
      held.resolve();
      await broker.shutdown();
    }
  });

  /** Holds the daemon's model admission until `admit` resolves. */
  function slowAdmission(proxy: CodexGatewayProxyService): {
    readonly admitting: Promise<void>;
    readonly admit: () => void;
    readonly prepared: () => number;
  } {
    const admitting = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let prepares = 0;
    wrapDaemonPolicy(proxy, {
      admitModel: async (model, original) => {
        admitting.resolve();
        await gate.promise;
        return original(model);
      },
      prepare: (model, original) => {
        prepares += 1;
        return original(model);
      },
    });
    return {
      admitting: admitting.promise,
      admit: () => gate.resolve(),
      prepared: () => prepares,
    };
  }

  it('sends nothing for a child that disconnects during model admission', async () => {
    const { broker, proxy } = await compose();
    const admission = slowAdmission(proxy);
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const target = new URL(`${opened.child.baseUrl}/v1/messages`);
      const upload = httpRequest(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
        },
      });
      const closed = new Promise<void>((resolve) =>
        upload.once('close', () => resolve()),
      );
      upload.on('error', () => undefined);
      upload.end(JSON.stringify({ model: 'm', messages: [] }));
      await admission.admitting;
      upload.destroy();
      await closed;
      // Let the proxy observe the closed socket before admission returns.
      await new Promise((resolve) => setTimeout(resolve, 50));
      admission.admit();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(seen).toHaveLength(0);
      expect(admission.prepared()).toBe(0);
      expect(broker.routeCount()).toBe(1);
    } finally {
      admission.admit();
      await broker.shutdown();
    }
  });

  it('serves a connected child after a slow model admission', async () => {
    const { broker, proxy } = await compose();
    const admission = slowAdmission(proxy);
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const requesting = child(opened.child);
      await admission.admitting;
      await new Promise((resolve) => setTimeout(resolve, 100));
      admission.admit();
      expect(await requesting).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.headers.authorization).toBe('Bearer csk-upstream-secret');
    } finally {
      admission.admit();
      await broker.shutdown();
    }
  });

  it.each([
    ['retries with the fresh lease', [0], 200],
    ['answers 502 once retries are spent', [], 502],
  ] as const)(
    'never sends an unauthorized request when the account changes between lease and send: %s',
    async (_case, retryDelaysMs, status) => {
      const { authority, broker, proxy } = await compose(undefined, {
        retryDelaysMs: [...retryDelaysMs],
        retryBudgetMs: 5_000,
      });
      let rotated = false;
      wrapDaemonPolicy(proxy, {
        prepare: async (model, original) => {
          const lease = await original(model);
          if (!rotated) {
            rotated = true;
            // Same-account rotation retires the unapplied lease.
            await replaceAccount(authority, entry('csk-rotated'));
          }
          return lease;
        },
      });
      try {
        const opened = await broker.openAiCreditsRoute(binding());
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        expect(await child(opened.child)).toBe(status);
        expect(seen.map(({ headers }) => headers.authorization)).toEqual(
          status === 200 ? ['Bearer csk-rotated'] : [],
        );
        // A stale lease is local: the route stays for the next request.
        expect(broker.routeCount()).toBe(1);
      } finally {
        await broker.shutdown();
      }
    },
  );

  it('closes a listener whose bind settles after shutdown', async () => {
    const proxy = new CodexGatewayProxyService();
    // The proxy's listener is private: observe it through its listen call.
    const listen = jest.spyOn(Server.prototype, 'listen');
    const listeners = (): Server[] =>
      listen.mock.contexts.filter(
        (context): context is Server => context instanceof Server,
      );
    try {
      const registering = proxy.registerRoute({
        sessionId: 'late-bind',
        upstreamUrl,
        resolveToken: () => Promise.resolve(null),
      });
      await proxy.shutdown();
      const late = await registering.then(
        (lease) => lease.baseUrl,
        () => null,
      );
      expect(late).toBeNull();
      // The rejected bind must not leave its listener holding a port.
      const [original] = listeners();
      expect(listeners()).toHaveLength(1);
      expect(original?.listening).toBe(false);
      // The proxy can still start again afterwards.
      const lease = await proxy.registerRoute({
        sessionId: 'after-shutdown',
        upstreamUrl,
        resolveToken: () => Promise.resolve(null),
      });
      expect(lease.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      const opened = listeners();
      listen.mockRestore();
      await proxy.shutdown();
      // An orphan from a regression would otherwise keep Jest open.
      for (const server of opened) if (server.listening) server.close();
    }
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses a %i upstream redirect without re-sending the bearer or body',
    async (status) => {
      // Retries enabled: a refused redirect must not be retried either.
      const { broker } = await compose(undefined, {
        retryDelaysMs: [0, 0],
        retryBudgetMs: 1_000,
      });
      try {
        const opened = await broker.openAiCreditsRoute(binding());
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        nextStatus = status;
        nextLocation = '/redirect-target';
        expect(await child(opened.child)).toBe(502);
        expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
          'POST /api/v1/llm-proxy/anthropic/v1/messages',
        ]);
        expect(seen[0]?.headers.authorization).toBe(
          'Bearer csk-upstream-secret',
        );
        expect(seen[0]?.body).toContain('"model":"m"');
        expect(broker.routeCount()).toBe(1);
      } finally {
        await broker.shutdown();
      }
    },
  );

  it('keeps following redirects on routes the daemon does not own', async () => {
    const proxy = new CodexGatewayProxyService();
    try {
      const route = await proxy.registerRoute({
        sessionId: 'legacy-redirect',
        upstreamUrl,
        allowedPaths: ['/v1/messages'],
        resolveToken: () => Promise.resolve('csk-legacy'),
      });
      nextStatus = 307;
      nextLocation = '/redirect-target';
      expect(await child(route.baseUrl)).toBe(200);
      expect(seen.map(({ path }) => path)).toEqual([
        '/v1/messages',
        '/redirect-target',
      ]);
    } finally {
      await proxy.shutdown();
    }
  });

  /**
   * Opens a route and starts an upload that sends headers and part of its
   * body, then stalls. Resolves once the proxy is collecting that body.
   */
  async function stalledUpload(
    broker: DaemonModelBroker,
    proxy: CodexGatewayProxyService,
  ): Promise<{
    readonly answered: Promise<number | 'closed'>;
    readonly abandon: () => void;
  }> {
    const collecting = Promise.withResolvers<void>();
    wrapDaemonPolicy(proxy, {
      // The preflight precedes body collection.
      preflight: async (original) => {
        const allowed = await original();
        setImmediate(collecting.resolve);
        return allowed;
      },
    });
    const opened = await broker.openAiCreditsRoute(binding());
    if (opened.kind !== 'opened') throw new Error(opened.reason);
    const target = new URL(`${opened.child.baseUrl}/v1/messages`);
    const upload = httpRequest(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1000',
        [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
      },
    });
    const answered = new Promise<number | 'closed'>((resolve) => {
      upload.once('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      upload.once('error', () => resolve('closed'));
      upload.once('close', () => resolve('closed'));
    });
    upload.write('{"model":"m","messages":[');
    await collecting.promise;
    return { answered, abandon: () => upload.destroy() };
  }

  function within<T>(
    work: Promise<T>,
    milliseconds: number,
  ): Promise<T | 'timed-out'> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      work,
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), milliseconds);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  it('finishes shutdown while a child upload is stalled mid-body', async () => {
    const { broker, proxy } = await compose();
    const upload = await stalledUpload(broker, proxy);
    try {
      expect(await within(broker.shutdown(), 2_000)).toBeUndefined();
      expect(await within(upload.answered, 2_000)).not.toBe('timed-out');
      expect(seen).toHaveLength(0);
    } finally {
      upload.abandon();
      await broker.shutdown();
    }
  });

  it('finishes shutdown while a child is stalled mid-headers', async () => {
    const { broker } = await compose();
    const opened = await broker.openAiCreditsRoute(binding());
    if (opened.kind !== 'opened') throw new Error(opened.reason);
    const target = new URL(opened.child.baseUrl);
    const socket = connect(Number(target.port), target.hostname);
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.on('error', () => undefined);
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `POST ${target.pathname}/v1/messages HTTP/1.1\r\nhost: ${target.host}\r\n`,
      );
      // Let the proxy's parser take the partial request.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await within(broker.shutdown(), 2_000)).toBeUndefined();
      expect(await within(closed, 2_000)).toBeUndefined();
      expect(seen).toHaveLength(0);
    } finally {
      socket.destroy();
      await broker.shutdown();
    }
  });

  it('answers a stalled upload as soon as its route is released', async () => {
    const { broker, proxy } = await compose();
    const upload = await stalledUpload(broker, proxy);
    try {
      expect(broker.releaseExecution('exec-1')).toBe(1);
      expect(await within(upload.answered, 2_000)).toBe(404);
      expect(seen).toHaveLength(0);
    } finally {
      upload.abandon();
      await broker.shutdown();
    }
  });

  it('drops a child that disconnects during preflight without reading its body', async () => {
    const { broker, proxy } = await compose();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const preflighted = Promise.withResolvers<void>();
    const admitted: string[] = [];
    const captured: { withdrawal?: () => AbortSignal } = {};
    wrapDaemonPolicy(proxy, {
      preflight: async (original) => {
        entered.resolve();
        await resume.promise;
        const allowed = await original();
        setImmediate(preflighted.resolve);
        return allowed;
      },
      admitModel: (model, original) => {
        admitted.push(model);
        return original(model);
      },
      upstreamSignal: (read) => {
        captured.withdrawal = read;
      },
    });
    const opened = await broker.openAiCreditsRoute(binding());
    const withdrawal = captured.withdrawal;
    if (opened.kind !== 'opened' || !withdrawal) throw new Error('route');
    const listening = (): number =>
      getEventListeners(withdrawal(), 'abort').length;
    const before = listening();
    const target = new URL(`${opened.child.baseUrl}/v1/messages`);
    // The proxy's own request object, so the test waits on its close.
    const arrived = Promise.withResolvers<IncomingMessage>();
    const onRequestStart = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'request' in message &&
        message.request instanceof IncomingMessage &&
        message.request.url === target.pathname
      )
        arrived.resolve(message.request);
    };
    subscribeChannel('http.server.request.start', onRequestStart);
    const upload = httpRequest(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
      },
    });
    upload.on('error', () => undefined);
    try {
      upload.end(JSON.stringify({ model: 'm', messages: [] }));
      const received = await arrived.promise;
      await entered.promise;
      const closed = new Promise<void>((resolve) =>
        received.once('close', () => resolve()),
      );
      upload.destroy();
      await closed;
      resume.resolve();
      await preflighted.promise;
      // A read started now would wait until the route is withdrawn.
      expect(listening()).toBe(before);
      expect(received.listenerCount('data')).toBe(0);
      expect(admitted).toHaveLength(0);
      expect(seen).toHaveLength(0);
      expect(broker.routeCount('exec-1')).toBe(1);
      // The route still serves a connected child.
      expect(await child(opened.child)).toBe(200);
      expect(seen).toHaveLength(1);
      expect(listening()).toBe(before);
    } finally {
      unsubscribeChannel('http.server.request.start', onRequestStart);
      upload.destroy();
      await broker.shutdown();
    }
  });

  it('refuses a route whose bind was pending when the broker shut down', async () => {
    const { broker, proxy } = await compose();
    const register = proxy.registerRoute.bind(proxy);
    const registering = Promise.withResolvers<void>();
    jest.spyOn(proxy, 'registerRoute').mockImplementation((options) => {
      const lease = register(options);
      registering.resolve();
      return lease;
    });
    const opening = broker.openAiCreditsRoute(binding());
    await registering.promise;
    await broker.shutdown();
    await expect(opening).resolves.toEqual({
      kind: 'refused',
      reason: 'closed',
    });
    await expect(broker.openAiCreditsRoute(binding())).resolves.toEqual({
      kind: 'refused',
      reason: 'closed',
    });
  });

  it('keeps request restrictions: only allowed paths reach the upstream', async () => {
    const { broker } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const status = await child(opened.child, '/v1/files');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(seen).toHaveLength(0);
    } finally {
      await broker.shutdown();
    }
  });

  it.each(['denied', 'unreviewed'])(
    'checkpoints verified %s policy before any upstream credential presentation',
    async (decision) => {
      const { authority, broker } = await compose();
      const started = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const checkpoint = jest.fn((): Promise<void> => {
        started.resolve();
        return held.promise;
      });
      try {
        const opened = await broker.openAiCreditsRoute(
          binding({ checkpointBeforeRevoke: checkpoint }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        const current = await authority.read();
        if (current.kind !== 'ok' || !current.record)
          throw new Error('account');
        await authority.saveIfUnchanged(
          {
            ...current.record.entry,
            enforcedSettings: [
              {
                organizationId: '11111111-2222-4333-8444-555555555555',
                organizationName: 'Org',
                policies: [
                  {
                    kind: 'model-policy',
                    blockedModelIds:
                      decision === 'denied' ? ['fixture-model'] : [],
                    reviewedModelIds: [],
                  },
                ],
              },
            ],
          },
          current.record,
          { probe: authority.beginProbe() },
        );
        expect(await authority.read()).toMatchObject({
          provenance: { policy: true },
        });
        const requesting = child(opened.child);
        await started.promise;
        // The route outlives the checkpoint, so its stream can record a pause.
        expect(checkpoint).toHaveBeenCalledWith('policy');
        expect(broker.routeCount()).toBe(1);
        held.resolve();
        expect(await requesting).toBe(401);
        expect(seen).toHaveLength(0);
        expect(broker.routeCount()).toBe(0);
      } finally {
        held.resolve();
        await broker.shutdown();
      }
    },
  );

  const membershipRefusal = JSON.stringify({
    error: {
      canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER,
      code: 'work_owner_not_member',
      correlation_id: 'hosted-1',
      message: 'Not a member.',
    },
  });

  it.each([
    [
      'model policy',
      JSON.stringify({ error: 'x', code: 'model_policy_blocked' }),
    ],
    ['nested work-owner membership', membershipRefusal],
  ])(
    'checkpoints a hosted %s refusal without expiring custody or unrelated routes',
    async (_case, body) => {
      const { authority, broker } = await compose();
      const started = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const checkpoint = jest.fn((): Promise<void> => {
        started.resolve();
        return held.promise;
      });
      try {
        const opened = await broker.openAiCreditsRoute(
          binding({ checkpointBeforeRevoke: checkpoint }),
        );
        const other = await broker.openAiCreditsRoute(
          binding({ executionId: 'other' }),
        );
        if (opened.kind !== 'opened' || other.kind !== 'opened')
          throw new Error('route');
        nextStatus = 403;
        nextBody = body;
        const response = fetch(`${opened.child.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${LOOPBACK_BROKER_AUTH_TOKEN}`,
            [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
          },
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
        await started.promise;
        expect(checkpoint).toHaveBeenCalledWith('policy');
        expect(broker.routeCount()).toBe(2);
        // The child sees the refusal only once the pause is recorded.
        expect(await within(response, 100)).toBe('timed-out');
        expect(seen).toHaveLength(1);
        held.resolve();
        const relayed = await response;
        expect(relayed.status).toBe(403);
        // The hosted body reaches the child intact for its own rendering.
        expect(await relayed.text()).toBe(body);
        expect(broker.routeCount()).toBe(1);
        expect(broker.routeCount('exec-1')).toBe(0);
        const read = await authority.read();
        expect(read).toMatchObject({ sessionExpired: false });
        expect(read.kind === 'ok' && read.provenance?.credential).toBe(
          'accepted',
        );
        nextStatus = 200;
        nextBody = undefined;
        expect(await child(other.child)).toBe(200);
      } finally {
        held.resolve();
        await broker.shutdown();
      }
    },
  );

  it('relays an unmarked membership-shaped 403 without revoking the route', async () => {
    const { broker } = await compose();
    const checkpoint = jest.fn(() => Promise.resolve());
    try {
      const opened = await broker.openAiCreditsRoute(
        binding({ checkpointBeforeRevoke: checkpoint }),
      );
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      nextStatus = 403;
      nextBody = JSON.stringify({ error: { code: 'work_owner_not_member' } });
      expect(await child(opened.child)).toBe(403);
      expect(checkpoint).not.toHaveBeenCalled();
      expect(broker.routeCount()).toBe(1);
    } finally {
      await broker.shutdown();
    }
  });

  describe('request model authorization', () => {
    const governed = {
      m: 'fixture-model',
      'other-admitted': 'other-governed',
    };
    const reviewing = async (
      authority: CloudAccountAuthority,
      reviewedModelIds: string[],
    ): Promise<void> => {
      const current = await authority.read();
      if (current.kind !== 'ok' || !current.record) throw new Error('account');
      await authority.saveIfUnchanged(
        {
          ...current.record.entry,
          enforcedSettings: [
            {
              organizationId: '11111111-2222-4333-8444-555555555555',
              organizationName: 'Org',
              policies: [
                {
                  kind: 'model-policy',
                  blockedModelIds: [],
                  reviewedModelIds,
                },
              ],
            },
          ],
        },
        current.record,
        { probe: authority.beginProbe() },
      );
    };

    it("forwards the admitted model and the run's other admitted models", async () => {
      const { broker } = await compose();
      try {
        const opened = await broker.openAiCreditsRoute(
          binding({ requestModels: governed }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        expect(await child(opened.child)).toBe(200);
        expect(
          await child(opened.child, '/v1/messages', {}, 'other-admitted'),
        ).toBe(200);
        expect(seen).toHaveLength(2);
      } finally {
        await broker.shutdown();
      }
    });

    it('forwards a built-in Claude side model the policy allows', async () => {
      const { authority, broker } = await compose();
      try {
        await reviewing(authority, [
          'fixture-model',
          'anthropic/claude-haiku-4.5',
        ]);
        const opened = await broker.openAiCreditsRoute(binding());
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        expect(
          await child(
            opened.child,
            '/v1/messages',
            {},
            'claude-haiku-4-5-20251001',
          ),
        ).toBe(200);
        expect(seen).toHaveLength(1);
      } finally {
        await broker.shutdown();
      }
    });

    it('refuses a policy-blocked side model locally and keeps the route', async () => {
      const { authority, broker } = await compose();
      const checkpoint = jest.fn(() => Promise.resolve());
      try {
        await reviewing(authority, ['fixture-model']);
        const opened = await broker.openAiCreditsRoute(
          binding({ checkpointBeforeRevoke: checkpoint }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        expect(
          await child(
            opened.child,
            '/v1/messages',
            {},
            'claude-haiku-4-5-20251001',
          ),
        ).toBe(403);
        expect(seen).toHaveLength(0);
        expect(checkpoint).not.toHaveBeenCalled();
        expect(broker.routeCount()).toBe(1);
        // The admitted model still runs on the same route.
        expect(await child(opened.child)).toBe(200);
        expect(seen).toHaveLength(1);
      } finally {
        await broker.shutdown();
      }
    });

    it.each([
      [
        'an unadmitted Claude model',
        'claude',
        '/v1/messages',
        'claude-opus-4-8',
      ],
      [
        'a Claude side model on a Codex route',
        'codex',
        '/responses',
        'claude-haiku-4-5-20251001',
      ],
    ] as const)(
      'refuses %s before presenting the credential',
      async (_case, harness, path, model) => {
        const { broker } = await compose();
        const checkpoint = jest.fn(() => Promise.resolve());
        try {
          const opened = await broker.openAiCreditsRoute(
            binding({ harness, checkpointBeforeRevoke: checkpoint }),
          );
          if (opened.kind !== 'opened') throw new Error(opened.reason);
          const response = await fetch(`${opened.child.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${LOOPBACK_BROKER_AUTH_TOKEN}`,
              [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
            },
            body: JSON.stringify({ model, input: [] }),
          });
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            error: 'This model is not admitted for this workflow step.',
            code: 'model_policy_blocked',
          });
          expect(seen).toHaveLength(0);
          expect(checkpoint).not.toHaveBeenCalled();
          expect(broker.routeCount()).toBe(1);
        } finally {
          await broker.shutdown();
        }
      },
    );

    it("rechecks the request's own model before each retry's credential lease", async () => {
      const { authority, broker } = await compose(
        entry('csk-upstream-secret'),
        { retryDelaysMs: [0], retryBudgetMs: 5_000 },
      );
      const checkpoint = jest.fn(() => Promise.resolve());
      try {
        await reviewing(authority, ['fixture-model', 'other-governed']);
        const opened = await broker.openAiCreditsRoute(
          binding({
            requestModels: governed,
            checkpointBeforeRevoke: checkpoint,
          }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        // The first attempt fails retryably; policy then withdraws only the
        // request's own model during the backoff.
        nextStatus = 503;
        beforeRespond = async (): Promise<void> => {
          beforeRespond = undefined;
          await reviewing(authority, ['fixture-model']);
          await Promise.resolve();
        };
        const response = await fetch(`${opened.child.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${LOOPBACK_BROKER_AUTH_TOKEN}`,
            [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
          },
          body: JSON.stringify({ model: 'other-admitted', messages: [] }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'This model is not admitted for this workflow step.',
          code: 'model_policy_blocked',
        });
        expect(seen).toHaveLength(1);
        expect(checkpoint).not.toHaveBeenCalled();
        expect(broker.routeCount()).toBe(1);
        nextStatus = 200;
        expect(await child(opened.child)).toBe(200);
        expect(seen).toHaveLength(2);
      } finally {
        await broker.shutdown();
      }
    });

    it("rechecks the request's model against the snapshot the credential is leased from", async () => {
      const { authority, broker } = await compose(
        entry('csk-upstream-secret'),
        { retryDelaysMs: [0], retryBudgetMs: 5_000 },
      );
      const checkpoint = jest.fn(() => Promise.resolve());
      const read = authority.read.bind(authority);
      let armed = false;
      // The route's read sees the old policy; the lease's read sees the new.
      jest.spyOn(authority, 'read').mockImplementation(async () => {
        if (!armed) return read();
        armed = false;
        const snapshot = await read();
        await reviewing(authority, ['fixture-model']);
        return snapshot;
      });
      try {
        await reviewing(authority, ['fixture-model', 'other-governed']);
        const opened = await broker.openAiCreditsRoute(
          binding({
            requestModels: governed,
            checkpointBeforeRevoke: checkpoint,
          }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        nextStatus = 503;
        beforeRespond = (): Promise<void> => {
          beforeRespond = undefined;
          armed = true;
          return Promise.resolve();
        };
        const response = await fetch(`${opened.child.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${LOOPBACK_BROKER_AUTH_TOKEN}`,
            [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
          },
          body: JSON.stringify({ model: 'other-admitted', messages: [] }),
        });
        expect(response.status).toBe(403);
        expect(armed).toBe(false);
        expect(seen).toHaveLength(1);
        expect(checkpoint).not.toHaveBeenCalled();
        expect(broker.routeCount()).toBe(1);
      } finally {
        await broker.shutdown();
      }
    });

    it('refuses built-in side models for a guest, whose side models are pinned', async () => {
      const { broker } = await compose({
        ...entry('csk-guest'),
        authMode: 'guest',
        credentialSource: 'guest',
      });
      try {
        const opened = await broker.openAiCreditsRoute(binding());
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        expect(
          await child(
            opened.child,
            '/v1/messages',
            {},
            'claude-haiku-4-5-20251001',
          ),
        ).toBe(403);
        expect(await child(opened.child)).toBe(200);
        expect(seen).toHaveLength(1);
      } finally {
        await broker.shutdown();
      }
    });

    it.each([
      ['refuses', 'guest', true, 403],
      ['forwards', 'non-guest', false, 200],
    ] as const)(
      '%s a built-in alias of the admitted model on a %s route',
      async (_verb, _account, guest, aliasStatus) => {
        const { broker } = await compose({
          ...entry('csk-account'),
          ...(guest ? { authMode: 'guest', credentialSource: 'guest' } : {}),
        });
        const checkpoint = jest.fn(() => Promise.resolve());
        try {
          const opened = await broker.openAiCreditsRoute(
            binding({
              governedModelId: 'anthropic/claude-haiku-5.5',
              requestModels: {
                'claude-haiku-5.5': 'anthropic/claude-haiku-5.5',
              },
              checkpointBeforeRevoke: checkpoint,
            }),
          );
          if (opened.kind !== 'opened') throw new Error(opened.reason);
          // `claude-haiku-5-5` is a built-in side spelling, not admitted.
          expect(
            await child(opened.child, '/v1/messages', {}, 'claude-haiku-5-5'),
          ).toBe(aliasStatus);
          expect(
            await child(opened.child, '/v1/messages', {}, 'claude-haiku-5.5'),
          ).toBe(200);
          expect(
            seen.map(({ body }) => /"model":"([^"]+)"/.exec(body)?.[1]),
          ).toEqual(
            guest
              ? ['claude-haiku-5.5']
              : ['claude-haiku-5-5', 'claude-haiku-5.5'],
          );
          expect(checkpoint).not.toHaveBeenCalled();
          expect(broker.routeCount()).toBe(1);
        } finally {
          await broker.shutdown();
        }
      },
    );

    it('refuses a body without a model', async () => {
      const { broker } = await compose();
      try {
        const opened = await broker.openAiCreditsRoute(binding());
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        const response = await fetch(`${opened.child.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [LOOPBACK_BROKER_SECRET_HEADER]: opened.child.routeSecret,
          },
          body: JSON.stringify({ messages: [] }),
        });
        expect(response.status).toBe(403);
        await response.text();
        expect(seen).toHaveLength(0);
      } finally {
        await broker.shutdown();
      }
    });
  });

  it('uses a rotated key for the same account on the next request', async () => {
    const { broker, authority } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      await replaceAccount(authority, entry('csk-rotated'));
      expect(await child(opened.child)).toBe(200);
      expect(seen[0]?.headers.authorization).toBe('Bearer csk-rotated');
      const rotated = await readCloudAccountAccess(authority);
      if (rotated.kind !== 'ok') throw new Error('account');
      expect(rotated.executionUnknownReason({ kind: 'personal' })).toBe(
        'policy-unavailable',
      );
      expect(
        await broker.openAiCreditsRoute(binding({ credentialGeneration: 2 })),
      ).toEqual({ kind: 'refused', reason: 'unavailable' });
      // Repeated explicit rotations retain policy, never credential acceptance.
      await replaceAccount(authority, entry('csk-rotated-again'));
      expect(await child(opened.child)).toBe(200);
      expect(seen[1]?.headers.authorization).toBe('Bearer csk-rotated-again');
    } finally {
      await broker.shutdown();
    }
  });

  it.each(['same-account', 'identity', 'endpoint', 'policy', 'twice'] as const)(
    'rechecks a rotation between account and lease reads: %s',
    async (race) => {
      const { broker, authority, setEpoch } = await compose();
      const checkpoint = jest.fn(() => Promise.resolve());
      try {
        const opened = await broker.openAiCreditsRoute(
          binding({ checkpointBeforeRevoke: checkpoint }),
        );
        if (opened.kind !== 'opened') throw new Error(opened.reason);
        const original = authority.read.bind(authority);
        let reads = 0;
        const intercept = async (): ReturnType<
          CloudAccountAuthority['read']
        > => {
          const snapshot = await original();
          reads++;
          // Read 1 is the pre-body preflight; 2 and 4 are attempt account
          // reads, each followed by its lease read.
          if (reads === 2 || (race === 'twice' && reads === 4)) {
            // Provision reads through the authority too; do not count that read.
            spy.mockImplementation(original);
            await replaceAccount(authority, {
              ...entry(
                `csk-rotated-${reads}`,
                race === 'identity' ? 'account-2' : 'account-1',
              ),
              ...(race === 'policy' ? { modelPolicyVerified: false } : {}),
            });
            if (race === 'endpoint') setEpoch('changed');
            spy.mockImplementation(intercept);
          }
          return snapshot;
        };
        const spy = jest.spyOn(authority, 'read').mockImplementation(intercept);
        const status = await child(opened.child);
        spy.mockRestore();
        if (race === 'same-account') {
          expect(status).toBe(200);
          expect(seen[0]?.headers.authorization).toBe('Bearer csk-rotated-2');
          expect(checkpoint).not.toHaveBeenCalled();
          expect(broker.routeCount()).toBe(1);
        } else {
          expect(status).toBeGreaterThanOrEqual(400);
          expect(seen).toHaveLength(0);
          expect(checkpoint).toHaveBeenCalledTimes(1);
          expect(broker.routeCount()).toBe(0);
        }
      } finally {
        jest.restoreAllMocks();
        await broker.shutdown();
      }
    },
  );

  it('refuses requests after the account identity changes or signs out', async () => {
    const { broker, authority } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      await replaceAccount(authority, entry('csk-other-account', 'account-2'));
      expect(await child(opened.child)).toBe(401);
      expect(seen).toHaveLength(0);
      await replaceAccount(authority, null);
      expect(
        await broker.openAiCreditsRoute(binding({ credentialGeneration: 3 })),
      ).toEqual({ kind: 'refused', reason: 'signed-out' });
    } finally {
      await broker.shutdown();
    }
  });

  it('opens no route for a legacy entry without an account id', async () => {
    // Custody it cannot identify has no verified provenance (CAN-7700).
    const { broker } = await compose({
      ...entry('csk-legacy'),
      account: undefined,
    });
    try {
      expect(
        await broker.openAiCreditsRoute(binding({ accountId: null })),
      ).toEqual({ kind: 'refused', reason: 'unavailable' });
      expect(broker.routeCount()).toBe(0);
      expect(seen).toHaveLength(0);
    } finally {
      await broker.shutdown();
    }
  });

  it('does not bypass a newly mandatory gateway on an existing route', async () => {
    const { broker, authority } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      const read = await authority.read();
      if (read.kind !== 'ok' || !read.record) throw new Error('account');
      await authority.saveIfUnchanged(
        {
          ...entry('csk-upstream-secret'),
          personalModelGateway: { enforced: true },
        },
        read.record,
      );
      expect(await child(opened.child)).toBe(401);
      expect(seen).toHaveLength(0);
      expect(await broker.openAiCreditsRoute(binding())).toEqual({
        kind: 'refused',
        reason: 'mandatory-gateway',
      });
    } finally {
      await broker.shutdown();
    }
  });

  it('fences endpoint and endpoint-epoch changes', async () => {
    const { broker, setEpoch, setBase } = await compose();
    try {
      const first = await broker.openAiCreditsRoute(binding());
      if (first.kind !== 'opened') throw new Error(first.reason);
      setEpoch('epoch-2');
      expect(await child(first.child)).toBe(401);
      setEpoch('epoch-1');
      const second = await broker.openAiCreditsRoute(binding());
      if (second.kind !== 'opened') throw new Error(second.reason);
      setBase('http://127.0.0.1:9');
      expect(await child(second.child)).toBe(401);
      expect(seen).toHaveLength(0);
    } finally {
      await broker.shutdown();
    }
  });

  it('re-probes inference 401 and expires only an account-rejected generation, never on 403', async () => {
    const { broker, authority } = await compose();
    try {
      const opened = await broker.openAiCreditsRoute(binding());
      if (opened.kind !== 'opened') throw new Error(opened.reason);
      nextStatus = 403;
      expect(await child(opened.child)).toBe(403);
      let read = await authority.read();
      expect(read.kind === 'ok' && read.sessionExpired).toBe(false);
      expect(read.kind === 'ok' && read.provenance?.credential).toBe(
        'accepted',
      );
      nextStatus = 401;
      expect(await child(opened.child)).toBe(401);
      read = await authority.read();
      expect(read.kind === 'ok' && read.sessionExpired).toBe(false);
      expect(read.kind === 'ok' && read.provenance?.credential).toBe(
        'accepted',
      );
      // Only the account endpoint confirms that the user's key was revoked.
      accountStatus = 401;
      expect(await child(opened.child)).toBe(401);
      read = await authority.read();
      expect(read.kind === 'ok' && read.sessionExpired).toBe(true);
      // An expired session refuses new routes rather than paying silently.
      expect(await broker.openAiCreditsRoute(binding())).toEqual({
        kind: 'refused',
        reason: 'session-expired',
      });
    } finally {
      await broker.shutdown();
    }
  });

  it('refuses a route whose credential rotated while it was registering', async () => {
    const { authority, broker, proxy, refresh } = await compose();
    const register = proxy.registerRoute.bind(proxy);
    // Same account, new key, then a probe that re-verifies its policy.
    const spy = jest
      .spyOn(proxy, 'registerRoute')
      .mockImplementation(async (options) => {
        await replaceAccount(authority, entry('csk-rotated'));
        await refresh();
        return register(options);
      });
    try {
      expect(await broker.openAiCreditsRoute(binding())).toEqual({
        kind: 'refused',
        reason: 'unavailable',
      });
      expect(broker.routeCount()).toBe(0);
      spy.mockRestore();
      // The rotated generation is admissible: only the stale one was refused.
      const current = await broker.openAiCreditsRoute(
        binding({ credentialGeneration: 2 }),
      );
      if (current.kind !== 'opened') throw new Error(current.reason);
      expect(await child(current.child)).toBe(200);
      expect(seen.at(-1)?.headers.authorization).toBe('Bearer csk-rotated');
    } finally {
      await broker.shutdown();
    }
  });

  it('refuses a stale admission and an inactive custody', async () => {
    const { broker } = await compose();
    try {
      expect(
        await broker.openAiCreditsRoute(binding({ credentialGeneration: 7 })),
      ).toEqual({ kind: 'refused', reason: 'identity-changed' });
    } finally {
      await broker.shutdown();
    }
    const memory = createMemoryVaultRepository();
    const inactive = createDaemonModelBroker({
      proxy: new CodexGatewayProxyService(),
      authority: createCloudAccountAuthority({
        custody: createCloudAccountCustody({
          repository: () => Promise.resolve(memory.repository),
          writer: () =>
            Promise.resolve(memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY)),
        }),
      }),
      cloudBaseUrl: () => upstreamUrl,
      endpointEpoch: () => 'e',
    });
    expect(await inactive.openAiCreditsRoute(binding())).toEqual({
      kind: 'refused',
      reason: 'inactive',
    });
    await inactive.shutdown();
  });

  it('releases routes on settlement only, scoped to the execution and owner', async () => {
    const { broker } = await compose();
    try {
      const a = await broker.openAiCreditsRoute(binding());
      const b = await broker.openAiCreditsRoute(binding({ harness: 'codex' }));
      const other = await broker.openAiCreditsRoute(
        binding({ executionId: 'exec-2' }),
      );
      if (a.kind !== 'opened' || b.kind !== 'opened' || other.kind !== 'opened')
        throw new Error('setup');
      // A different well-formed owner, a malformed one, or the right owner on
      // another execution cannot release another run's route.
      for (const [executionId, owner] of [
        ['exec-1', `org:${ORG}`],
        ['exec-1', 'org:x'],
        ['exec-2', 'personal'],
      ])
        expect(broker.release({ executionId, owner, routeId: a.routeId })).toBe(
          false,
        );
      expect(broker.routeCount('exec-1')).toBe(2);
      // A Codex route allows only /responses; any other path 404s while open.
      expect(await child(b.child, '/responses')).toBe(200);
      // The run's own owner and execution do release it.
      expect(
        broker.release({
          executionId: 'exec-1',
          owner: 'personal',
          routeId: b.routeId,
        }),
      ).toBe(true);
      expect(await child(b.child, '/responses')).toBe(404);
      expect(await child(a.child)).toBe(200);
      expect(broker.releaseExecution('exec-1')).toBe(1);
      expect(await child(a.child)).toBe(404);
      expect(broker.routeCount('exec-2')).toBe(1);
      expect(await child(other.child)).toBe(200);
      expect(seen[0]?.headers.authorization).toBe('Bearer csk-upstream-secret');
    } finally {
      await broker.shutdown();
    }
  });
});
