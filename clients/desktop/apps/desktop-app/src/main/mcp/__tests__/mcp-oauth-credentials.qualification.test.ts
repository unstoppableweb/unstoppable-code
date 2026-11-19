import { z } from 'zod';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  McpCredentialBroker,
  type McpCredentialOwner,
} from '@canopy/core-runtime/node/mcp-auth';
import { CANOPY_MCP_PROXY_PATH } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import type * as CanopyCloudClientModule from '../../canopy-cloud/client';
import type * as PathsModule from '../../lib/paths';
import type { SecretStoragePolicy } from '../../lib/secure-storage-policy';

let dataDir = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'secure', 'mcp-oauth-tokens.json'),
  getLegacyMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'legacy-mcp-oauth-tokens.json'),
  getInternalLegacySharedMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'shared-mcp-oauth-tokens.json'),
  getMcpServerFilePath: (serverId: string): string =>
    join(dataDir, 'mcp-servers', `server-${serverId}.json`),
}));
jest.mock('../../lib/secure-storage-policy', () => ({
  getSecureStorageFailure: (): null => null,
  getSecretStoragePolicy: (): Omit<SecretStoragePolicy, 'getStatus'> => ({
    isWriteAvailable: (): boolean => true,
    nativeEncryptionAvailable: (): boolean => true,
    assertCanRead: (): void => undefined,
    assertCanWrite: (): void => undefined,
    encrypt: (text: string): Buffer =>
      Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decrypt: (ciphertext: Buffer): string =>
      Buffer.from(
        ciphertext.toString().replace(/^enc:/, ''),
        'base64',
      ).toString(),
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../../canopy-cloud/client', () => ({
  CanopyCloudClientError: jest.requireActual<typeof CanopyCloudClientModule>(
    '../../canopy-cloud/client',
  ).CanopyCloudClientError,
  resolveCanopyCloudCredentialContext: jest.fn(),
}));

import { resolveCanopyCloudCredentialContext } from '../../canopy-cloud/client';
import { desktopExecutionSecretReader } from '../../execution-secrets/reader';
import { logMainProcessError } from '../../lib/main-process-logging';
import { storedSecretRef } from '../../lib/stored-secrets';
import {
  AgentMcpConnections,
  type AgentMcpRouteRegistration,
} from '../agent-mcp-connections';
import {
  connectMcpOAuthRevocations,
  createMcpOAuthCredentialOwner,
  type McpOAuthSubject,
} from '../oauth-credentials';
import {
  clearMcpOAuthToken,
  clearMcpOAuthTokensForServer,
  getMcpOAuthToken,
  onMcpOAuthCredentialRevoked,
  setMcpOAuthTokensChangedListener,
  saveMcpOAuthToken,
} from '../oauth-token-store';
import { claimPendingAuthFailures } from '../pending-auth-failures';

const CANARIES = [
  'secret-canary-access-1',
  'secret-canary-refresh-2',
  'secret-canary-client-3',
  'secret-canary-access-4',
];
const ACCESS = 'secret-canary-access-1';
const REFRESH = 'secret-canary-refresh-2';
const CLIENT_SECRET = 'secret-canary-client-3';
const CONFIG_ID = 'cfg';
const NOW = '2026-11-05T00:00:00.000Z';
const proxyPrefix = `${CANOPY_MCP_PROXY_PATH}/`;

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ClientResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (req: RecordedRequest, res: ServerResponse) => void;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function send(url: string, body: string): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'search', arguments: { q: 'x' } },
});

describe('MCP OAuth credentials (CAN-4126)', () => {
  let provider: Server;
  let base: string;
  let upstreamRequests: RecordedRequest[];
  let tokenRequests: RecordedRequest[];
  let upstreamHandler: Handler;
  let tokenHandler: Handler;
  let front: Server;
  let frontBase: string;
  let broker: McpCredentialBroker<McpOAuthSubject>;
  let disconnectRevocations: () => void;
  let connections: AgentMcpConnections;
  const resolveCalls: McpOAuthSubject[] = [];
  const caughtErrors: unknown[] = [];
  const consoleArgs: unknown[] = [];
  const consoleSpies: jest.SpyInstance[] = [];
  let caseNumber = 0;

  const proxyUrl = (routeId: string): string =>
    `${frontBase}${proxyPrefix}${encodeURIComponent(routeId)}`;

  const definitionFor = (serverId: string): McpServerDefinitionData => ({
    id: serverId,
    name: 'Server',
    description: '',
    type: 'http',
    url: `${base}/mcp`,
    oauth: {
      clientId: 'client-1',
      clientSecret: CLIENT_SECRET,
      tokenUrl: `${base}/token`,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const config: McpServerConfigData = {
    id: CONFIG_ID,
    name: 'Default',
    description: '',
    enabled: true,
    envVars: {},
    extraArgs: [],
    extraHeaders: {},
    createdAt: NOW,
    updatedAt: NOW,
  };

  /** A device server with a seeded token record; each case uses its own server id. */
  const seedServer = async (
    options: { expired?: boolean } = {},
  ): Promise<string> => {
    caseNumber += 1;
    const serverId = `srv-${String(caseNumber)}`;
    const definition = definitionFor(serverId);
    const file: McpServerFile = {
      version: 1,
      server: { definition, configs: [config] },
    };
    mkdirSync(join(dataDir, 'mcp-servers'), { recursive: true });
    writeFileSync(
      join(dataDir, 'mcp-servers', `server-${serverId}.json`),
      JSON.stringify(file),
    );
    const upstream = new URL(definition.url ?? '');
    upstream.hash = '';
    await saveMcpOAuthToken({
      serverId,
      configId: CONFIG_ID,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      upstreamUrl: upstream.toString(),
      clientId: 'client-1',
      tokenUrl: `${base}/token`,
      tokenType: 'Bearer',
      expiresAt: new Date(
        Date.now() + (options.expired ? -60_000 : 3_600_000),
      ).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return serverId;
  };

  const route = (
    overrides: Partial<AgentMcpRouteRegistration> = {},
  ): AgentMcpRouteRegistration => ({
    sessionId: null,
    serverId: 'srv',
    configId: CONFIG_ID,
    displayName: 'Server',
    upstreamUrl: `${base}/mcp`,
    headers: {},
    oauthEnabled: false,
    ...overrides,
  });

  const deviceRoute = (
    serverId: string,
    overrides: Partial<AgentMcpRouteRegistration> = {},
  ): AgentMcpRouteRegistration =>
    route({
      serverId,
      oauthEnabled: true,
      credential: broker.bind({
        kind: 'device',
        serverId,
        configId: CONFIG_ID,
      }),
      ...overrides,
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'can-4126-oauth-'));
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      consoleSpies.push(
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleArgs.push(args);
        }),
      );
    provider = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        if (recorded.path === '/token') {
          tokenRequests.push(recorded);
          tokenHandler(recorded, res);
        } else {
          upstreamRequests.push(recorded);
          upstreamHandler(recorded, res);
        }
      });
    });
    base = `http://127.0.0.1:${String(await listen(provider))}`;
  });

  afterAll(async () => {
    await close(provider);
    for (const spy of consoleSpies) spy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    upstreamRequests = [];
    tokenRequests = [];
    upstreamHandler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    tokenHandler = (_req, res): void => {
      res.writeHead(500);
      res.end();
    };
    const owner = createMcpOAuthCredentialOwner();
    const countingOwner: McpCredentialOwner<McpOAuthSubject> = {
      scopeOf: (subject) => owner.scopeOf(subject),
      resolve: (subject, signal) => {
        resolveCalls.push(subject);
        return owner.resolve(subject, signal);
      },
      invalidate: (subject, token, upstreamUrl) =>
        owner.invalidate(subject, token, upstreamUrl),
    };
    broker = new McpCredentialBroker({ owner: countingOwner });
    disconnectRevocations = connectMcpOAuthRevocations(broker);
    connections = new AgentMcpConnections({
      proxyUrl,
      listening: (): boolean => true,
      credentials: broker,
    });
    front = createServer((req, res) => {
      const id = decodeURIComponent(
        new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '',
      );
      connections.serve(req, res, id).catch((error: unknown) => {
        caughtErrors.push(error);
      });
    });
    frontBase = `http://127.0.0.1:${String(await listen(front))}`;
  });

  afterEach(async () => {
    connections.clear();
    disconnectRevocations();
    broker.close();
    await close(front);
  });

  it('agent connections forward OAuth routes through opaque credentials only', async () => {
    const serverId = await seedServer();
    const registration = deviceRoute(serverId);
    const id = await connections.register(registration);

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.headers.authorization).toBe(`Bearer ${ACCESS}`);
    for (const text of [
      inspect(connections, { depth: 10, showHidden: true }),
      JSON.stringify(registration),
    ])
      for (const canary of CANARIES) expect(text).not.toContain(canary);
  });

  it('sign-out between authorization and forwarding never forwards the old token', async () => {
    const serverId = await seedServer();
    const id = await connections.register(
      deviceRoute(serverId, { sessionId: 's', requireToolCallGate: true }),
    );
    connections.setSessionToolCallGate('s', async () => {
      await clearMcpOAuthToken(serverId, CONFIG_ID);
      return true;
    });

    const response = await send(proxyUrl(id), TOOL_CALL);

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: -32001, message: 'MCP server authorization required' },
    });
    expect(upstreamRequests).toHaveLength(0);
  });

  it('a rejected token is invalidated before the 401 is relayed', async () => {
    const serverId = await seedServer();
    upstreamHandler = (_req, res): void => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    };
    const id = await connections.register(
      deviceRoute(serverId, { sessionId: 's3' }),
    );

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(401);
    expect((await getMcpOAuthToken(serverId, CONFIG_ID))?.expiresAt).toBe(
      new Date(0).toISOString(),
    );
    const claimed = claimPendingAuthFailures('s3');
    expect(claimed).toHaveLength(1);
    expect(JSON.stringify(claimed)).toContain(serverId);
    expect(JSON.stringify(claimed)).toContain(CONFIG_ID);
  });

  it('an expired token refreshes in the owner and the handle carries the refreshed token', async () => {
    const serverId = await seedServer({ expired: true });
    tokenHandler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'secret-canary-access-4',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    };
    const id = await connections.register(deviceRoute(serverId));

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(200);
    expect(tokenRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.headers.authorization).toBe(
      'Bearer secret-canary-access-4',
    );
    expect((await getMcpOAuthToken(serverId, CONFIG_ID))?.accessToken).toBe(
      'secret-canary-access-4',
    );
  });

  it('a temporary refresh failure answers 503 with retry-after 30 and records nothing', async () => {
    const serverId = await seedServer({ expired: true });
    const id = await connections.register(deviceRoute(serverId));

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('30');
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: -32002,
        message:
          'MCP authorization is temporarily unavailable. Try again shortly.',
      },
    });
    expect(upstreamRequests).toHaveLength(0);
    expect(
      (await getMcpOAuthToken(serverId, CONFIG_ID))?.lastError,
    ).toBeUndefined();
  });

  it('a terminal refresh rejection records lastError and answers 401', async () => {
    const serverId = await seedServer({ expired: true });
    tokenHandler = (_req, res): void => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_grant"}');
    };
    const id = await connections.register(deviceRoute(serverId));

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: -32001 },
    });
    expect(upstreamRequests).toHaveLength(0);
    expect(
      (await getMcpOAuthToken(serverId, CONFIG_ID))?.lastError,
    ).toBeTruthy();
  });

  it('disconnecting a session releases its credentials', async () => {
    const serverId = await seedServer();
    const prior = broker.size;
    const first = deviceRoute(serverId, { sessionId: 's1' });
    const second = deviceRoute(serverId, { sessionId: 's1' });
    await connections.register(first);
    await connections.register(second);
    expect(broker.size).toBe(prior + 2);

    connections.disconnectSession('s1');

    expect(broker.size).toBe(prior);
    for (const registration of [first, second]) {
      const { credential } = registration;
      if (!credential) throw new Error('expected a credential');
      await expect(
        broker.authorize({
          credential,
          purpose: 'mcp.upstream.forward',
          upstreamUrl: `${base}/mcp`,
        }),
      ).resolves.toEqual({ status: 'none' });
    }
  });

  it('an account route still sends the account key and never asks the OAuth owner', async () => {
    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      apiKey: 'acct-key',
      baseUrl: base,
    });
    resolveCalls.length = 0;
    const id = await connections.register(
      route({
        upstreamUrl: `${base}/api/v1/mcp-proxy/r1`,
        authSupplier: 'canopy-cloud',
      }),
    );

    const response = await send(proxyUrl(id), '{}');

    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.headers.authorization).toBe('Bearer acct-key');
    expect(resolveCalls).toHaveLength(0);
  });

  it('the execution secret reader never yields an OAuth client secret', async () => {
    const serverId = await seedServer();
    await expect(
      desktopExecutionSecretReader.read(
        [
          {
            name: 'CANOPY_MCP_SECRET_0',
            source: {
              kind: 'stored-secret',
              family: 'mcp.server',
              record: serverId,
              ref: storedSecretRef(
                'mcp.server',
                serverId,
                'definition/oauth/clientSecret',
              ),
            },
          },
        ],
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ status: 'missing' }]);
  });

  it('no token or client secret reaches logs or errors', () => {
    const logged = [
      ...jest.mocked(logMainProcessError).mock.calls,
      ...consoleArgs,
      ...caughtErrors,
    ].map((entry) => inspect(entry, { depth: 10 }));
    for (const text of logged)
      for (const canary of CANARIES) expect(text).not.toContain(canary);
  });

  it('device repair clears exact server records through the owner queue and revokes every configuration', async () => {
    const save = (serverId: string, configId: string): Promise<void> =>
      saveMcpOAuthToken({
        serverId,
        configId,
        accessToken: ACCESS,
        tokenType: 'Bearer',
        updatedAt: NOW,
      });
    await Promise.all([save('a1', 'c1'), save('a1', 'c2'), save('a10', 'c1')]);
    const events: Array<{
      serverId: string;
      configId: string;
      reason: string;
    }> = [];
    const unsubscribe = onMcpOAuthCredentialRevoked((event) =>
      events.push(event),
    );
    try {
      expect(await clearMcpOAuthTokensForServer('a1')).toEqual({ cleared: 2 });
      expect(events).toEqual([
        { serverId: 'a1', configId: 'c1', reason: 'cleared' },
        { serverId: 'a1', configId: 'c2', reason: 'cleared' },
      ]);
      expect(await getMcpOAuthToken('a1', 'c1')).toBeNull();
      expect(await getMcpOAuthToken('a10', 'c1')).not.toBeNull();
      expect(await clearMcpOAuthTokensForServer('a1')).toEqual({ cleared: 0 });
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('repair refuses inconsistent key/record identity before changing any token or notifying revocation', async () => {
    await saveMcpOAuthToken({
      serverId: 'a1',
      configId: 'c1',
      accessToken: ACCESS,
      tokenType: 'Bearer',
      updatedAt: NOW,
    });
    const path = join(dataDir, 'secure', 'mcp-oauth-tokens.json');
    const before = readFileSync(path, 'utf8');
    const file = z
      .object({
        records: z.record(
          z.string(),
          z.object({ serverId: z.string() }).passthrough(),
        ),
      })
      .passthrough()
      .parse(JSON.parse(before));
    file.records['a1:c1'].serverId = 'a10';
    const damaged = JSON.stringify(file);
    writeFileSync(path, damaged);
    const revoked = jest.fn();
    const unsubscribe = onMcpOAuthCredentialRevoked(revoked);
    try {
      await expect(clearMcpOAuthTokensForServer('a1')).rejects.toThrow(
        'Invalid MCP OAuth token identity',
      );
      expect(readFileSync(path, 'utf8')).toBe(damaged);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      writeFileSync(path, before);
      unsubscribe();
    }
    // A refused cleanup must not poison the owner's mutation queue.
    expect(await clearMcpOAuthTokensForServer('a1')).toEqual({ cleared: 1 });
  });

  it('an unusable current token store is not treated as empty by device repair', async () => {
    const path = join(dataDir, 'secure', 'mcp-oauth-tokens.json');
    const before = readFileSync(path, 'utf8');
    const damaged = '{"records":"secret-canary-access-1"';
    writeFileSync(path, damaged);
    try {
      await expect(clearMcpOAuthTokensForServer('a1')).rejects.toThrow(
        'Invalid MCP OAuth token store',
      );
      expect(readFileSync(path, 'utf8')).toBe(damaged);
      await expect(clearMcpOAuthTokensForServer('account:a1')).rejects.toThrow(
        'Invalid device MCP server id.',
      );
    } finally {
      writeFileSync(path, before);
    }
  });

  it('revokes removed credentials even if the post-commit inventory refresh throws', async () => {
    await saveMcpOAuthToken({
      serverId: 'a1',
      configId: 'c1',
      accessToken: ACCESS,
      tokenType: 'Bearer',
      updatedAt: NOW,
    });
    const revoked = jest.fn();
    const unsubscribe = onMcpOAuthCredentialRevoked(revoked);
    setMcpOAuthTokensChangedListener(() => {
      throw new Error('refresh failed');
    });
    try {
      await expect(clearMcpOAuthTokensForServer('a1')).rejects.toThrow(
        'refresh failed',
      );
      expect(revoked).toHaveBeenCalledWith({
        serverId: 'a1',
        configId: 'c1',
        reason: 'cleared',
      });
      expect(await getMcpOAuthToken('a1', 'c1')).toBeNull();
    } finally {
      setMcpOAuthTokensChangedListener(null);
      unsubscribe();
    }
  });
});
