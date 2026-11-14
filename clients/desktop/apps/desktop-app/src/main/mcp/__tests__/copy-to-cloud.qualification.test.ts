/**
 * Copying a desktop MCP server to the cloud account (CAN-6176 PR 4a, D15 to
 * D17, D30, D33): `core.integration.mcpAccount.connect` with
 * `fromDeviceServer` sends only the secret slots the person agreed to copy,
 * resolved in main from the server's own store, and only to the origin they
 * were saved for. An OAuth server signs in on the cloud and sends no token;
 * a curated server goes by key. No secret value appears in any result, error
 * or replay record, and the operation needs `core.integration.write`.
 */
import {
  CORE_INTEGRATION_MCP_ACCOUNT_INSTRUCTION_DEFINITIONS,
  McpAccountConnectParamsSchema,
  type McpAccountConnectParams,
} from '@canopy/protocol/canopy-core';
import {
  AccountMcpConnectionError,
  type McpServerData,
  type StartAccountMcpConnectionRequest,
  type StartAccountMcpConnectionResponse,
} from '@canopy/execution-engine/types/mcp-servers';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { connectMcpAccount, type CopyToCloudDeps } from '../copy-to-cloud';
import {
  confirmSecretsLeave,
  type ConfirmSecretsLeaveDeps,
  type SecretsLeaveApproval,
  type SecretsLeaveRequest,
} from '../confirm-secrets-leave';
import { createCoreMcpAccountAdapter } from '../../canopy-runtime/core-mcp-account-adapter';

const HEADER_SECRET = 'header-secret-value-1';
const TOKEN_SECRET = 'bearer-secret-value-2';
const ENV_SECRET = 'env-secret-value-3';

const SERVER = {
  definition: {
    id: 'tracker',
    name: 'Tracker',
    type: 'http',
    url: 'https://mcp.tracker.example/mcp',
    headers: { 'X-Api-Key': HEADER_SECRET },
  },
  configs: [
    {
      id: 'default',
      name: 'Default',
      enabled: true,
      extraArgs: [],
      envVars: { TOKEN: ENV_SECRET },
      extraHeaders: { 'x-api-key': 'config-header-value-4' },
      authToken: TOKEN_SECRET,
    },
  ],
} as unknown as McpServerData;

const CONNECTION = {
  id: 'conn-1',
  serverKey: 'custom:abc',
  configId: 'default',
  displayName: 'Tracker',
  status: 'CONNECTED',
  routeId: 'route-1',
  enabledTools: null,
  kind: 'CUSTOM',
  hasExtraHeaders: true,
} as const;

function harness(
  response: StartAccountMcpConnectionResponse | Error = {
    connection: { ...CONNECTION },
  },
  confirm: (
    request: SecretsLeaveRequest,
  ) => Promise<SecretsLeaveApproval | null> = (request) =>
    Promise.resolve(approving('acct-A', request)),
): CopyToCloudDeps & {
  sent: StartAccountMcpConnectionRequest[];
  asked: SecretsLeaveRequest[];
} {
  const sent: StartAccountMcpConnectionRequest[] = [];
  const asked: SecretsLeaveRequest[] = [];
  return {
    sent,
    asked,
    confirmSecretsLeave: (request) => {
      asked.push(request);
      return confirm(request);
    },
    accountEnabled: () => true,
    curatedServer: (serverKey) => Promise.resolve(CURATED[serverKey] ?? null),
    readServer: (serverId) =>
      Promise.resolve(serverId === 'tracker' ? SERVER : null),
    start: (request) => {
      sent.push(request);
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    },
  };
}

/** Main's curated catalog: one option, none, and several. */
const CURATED: Record<
  string,
  { name: string; url: string; urlOptions: string[]; tokenUrl?: string }
> = {
  oauthy: {
    name: 'Oauthy',
    url: 'https://mcp.oauthy.example/mcp',
    urlOptions: [],
    // Its sign-in lives on another origin.
    tokenUrl: 'https://login.oauthy-auth.example/oauth/token',
  },
  github: {
    name: 'GitHub',
    url: 'https://api.github.example/mcp',
    urlOptions: ['https://eu.github.example/mcp'],
  },
  linear: {
    name: 'Linear',
    url: 'https://mcp.linear.example/mcp',
    urlOptions: [],
  },
  regional: {
    name: 'Regional',
    url: 'https://global.regional.example/mcp',
    urlOptions: [
      'https://eu.regional.example/mcp',
      'https://us.regional.example/mcp',
    ],
  },
};

const copy = (
  secretSlots: string[],
  overrides: Partial<McpAccountConnectParams> = {},
): McpAccountConnectParams =>
  McpAccountConnectParamsSchema.parse({
    customUrl: 'https://mcp.tracker.example/mcp',
    displayName: 'Tracker',
    configId: 'default',
    fromDeviceServer: { serverId: 'tracker', configId: 'default', secretSlots },
    _meta: { idempotencyKey: 'key-1' },
    ...overrides,
  });

const ACCOUNT_A = { id: 'acct-A', label: 'person@example.test' };

/** A yes to `request`, for the account the dialog named. */
const approving = (
  accountId: string,
  request: SecretsLeaveRequest,
): SecretsLeaveApproval => ({
  accountId,
  destinationOrigin: request.destinationOrigin,
  ...(request.tokenEndpointOrigin === undefined
    ? {}
    : { tokenEndpointOrigin: request.tokenEndpointOrigin }),
  secretNames: request.secretNames,
});

const leaks = (value: unknown): boolean =>
  [HEADER_SECRET, TOKEN_SECRET, ENV_SECRET, 'config-header-value-4'].some(
    (secret) => JSON.stringify(value).includes(secret),
  );

describe('copying a desktop MCP server to the cloud account (CAN-6176 D15)', () => {
  it('sends only the slots the person agreed to copy, and none by default', async () => {
    const none = harness();
    await connectMcpAccount(none, copy([]));
    expect(none.sent).toEqual([
      {
        customUrl: 'https://mcp.tracker.example/mcp',
        displayName: 'Tracker',
        configId: 'default',
      },
    ]);

    const tokenOnly = harness();
    await connectMcpAccount(tokenOnly, copy(['config/default/authToken']));
    expect(tokenOnly.sent[0]).toMatchObject({ bearerToken: TOKEN_SECRET });
    expect(tokenOnly.sent[0]).not.toHaveProperty('headers');

    const both = harness();
    const result = await connectMcpAccount(
      both,
      copy(['definition/headers/X-Api-Key', 'config/default/authToken']),
    );
    expect(both.sent[0]).toMatchObject({
      headers: { 'X-Api-Key': HEADER_SECRET },
      bearerToken: TOKEN_SECRET,
    });
    // The result names the connection, never what was sent.
    expect(result).toEqual({
      connection: {
        connectionId: 'conn-1',
        serverKey: 'custom:abc',
        state: 'connected',
        hasStoredHeaders: true,
      },
    });
    expect(leaks(result)).toBe(false);
  });

  it('lets the configuration’s header win over the definition’s, whatever the slot order', async () => {
    const deps = harness();
    await connectMcpAccount(
      deps,
      copy([
        'config/default/extraHeaders/x-api-key',
        'definition/headers/X-Api-Key',
      ]),
    );
    expect(deps.sent[0]?.headers).toEqual({
      'x-api-key': 'config-header-value-4',
    });
  });

  it('refuses a copy whose destination changed, or a slot that changed, before anything is sent', async () => {
    const moved = harness();
    await expect(
      connectMcpAccount(
        moved,
        copy(['config/default/authToken'], {
          customUrl: 'https://elsewhere.example/mcp',
        }),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
    });
    const gone = harness();
    await expect(
      connectMcpAccount(gone, copy(['definition/headers/X-Removed'])),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
    });
    // Another configuration's token is not this copy's slot.
    await expect(
      connectMcpAccount(gone, copy(['config/other/authToken'])),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
    });
    expect([...moved.sent, ...gone.sent]).toEqual([]);
  });

  it('never copies an environment variable or an OAuth client secret, and takes no values with a copy', () => {
    for (const slot of [
      'config/default/envVars/TOKEN',
      'definition/oauth/clientSecret',
    ])
      expect(() => copy([slot])).toThrow();
    expect(() => copy([], { bearerToken: 'typed-by-renderer' })).toThrow();
    expect(() => copy([], { headers: { 'X-Api-Key': 'value' } })).toThrow();
  });

  it('signs an OAuth server in on the cloud, sending no token (D16), and starts a curated one by key (D17)', async () => {
    const oauth = harness({
      authorizationUrl: 'https://cloud.example/oauth/start',
    });
    await expect(connectMcpAccount(oauth, copy([]))).resolves.toEqual({
      authorizationUrl: 'https://cloud.example/oauth/start',
    });
    expect(oauth.sent[0]).not.toHaveProperty('bearerToken');

    const curated = harness();
    await connectMcpAccount(
      curated,
      McpAccountConnectParamsSchema.parse({
        serverKey: 'github',
        configId: 'default',
        _meta: { idempotencyKey: 'key-2' },
      }),
    );
    expect(curated.sent).toEqual([
      { serverKey: 'github', configId: 'default' },
    ]);
  });

  it('copies secrets only to the exact URL they were saved for, and only into their own config', async () => {
    const both = ['definition/headers/X-Api-Key', 'config/default/authToken'];
    for (const overrides of [
      // Same origin, another path on the host.
      { customUrl: 'https://mcp.tracker.example/other' },
      // Another config's connection.
      { configId: 'staging' },
    ]) {
      const deps = harness();
      const refusal: unknown = await connectMcpAccount(
        deps,
        copy(both, overrides),
      ).catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
      });
      expect(deps.asked).toEqual([]);
      expect(deps.sent).toEqual([]);
      expect(leaks(refusal)).toBe(false);
    }
  });

  it('keeps every secret out of errors, and maps the cloud start’s refusals', async () => {
    const raw = harness(new Error(`upstream said ${TOKEN_SECRET}`));
    const error: unknown = await connectMcpAccount(
      raw,
      copy(['config/default/authToken']),
    ).catch((caught: unknown) => caught);
    // The failure stays recorded under its key: trying again is a new request.
    expect(error).toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    expect(leaks(error)).toBe(false);
    expect(leaks((error as { cause?: unknown }).cause ?? null)).toBe(false);

    const limited = harness(
      new AccountMcpConnectionError('connection-limit-reached'),
    );
    await expect(connectMcpAccount(limited, copy([]))).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        code: 'core.integration.mcpAccount.connectionLimitReached',
      },
    });
    const disabled = { ...harness(), accountEnabled: (): boolean => false };
    await expect(connectMcpAccount(disabled, copy([]))).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.accountDisabled' },
    });
    expect(disabled.sent).toEqual([]);
  });

  it('needs core.integration.write, and replays a key without keeping any secret', async () => {
    expect(
      CORE_INTEGRATION_MCP_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.mcpAccount.connect'
      ].requiredGrants,
    ).toEqual(['core.integration.write']);

    const deps = harness();
    const adapter = createCoreMcpAccountAdapter(deps);
    const connect =
      adapter.instructions?.['core.integration.mcpAccount.connect'];
    if (connect === undefined) throw new Error('Not registered.');
    const context = {
      caller: { principalId: 'renderer-1' },
      metadata: { idempotencyKey: 'key-1' },
    } as unknown as CanopyHandlerContext;
    const params = copy(['config/default/authToken']);
    const first = await connect(params, context);
    // The same key and request replays the first outcome; nothing is sent again.
    await expect(connect(params, context)).resolves.toEqual(first);
    expect(deps.sent).toHaveLength(1);
    // Another request under the same key is refused.
    await expect(
      connect(copy(['definition/headers/X-Api-Key']), context),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    expect(deps.sent).toHaveLength(1);
  });
});

describe('main confirms natively before any secret leaves (CAN-6176, Nick 11 Nov)', () => {
  const both = ['definition/headers/X-Api-Key', 'config/default/authToken'];

  it('sends nothing when the person says no, closes the dialog, or it fails', async () => {
    for (const answer of [
      (): Promise<SecretsLeaveApproval | null> => Promise.resolve(null),
      (): Promise<SecretsLeaveApproval | null> =>
        Promise.reject(new Error('dialog failed')),
    ]) {
      const deps = harness(undefined, answer);
      const refusal: unknown = await connectMcpAccount(deps, copy(both)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(deps.sent).toEqual([]);
      expect(refusal).toMatchObject({
        payload: {
          kind: 'cancelled',
          code: 'core.integration.mcpAccount.consentDeclined',
        },
      });
      expect(leaks(refusal)).toBe(false);
    }
  });

  it('asks once, after the renderer’s choice, naming each secret, the origin and never a value', async () => {
    const deps = harness();
    await connectMcpAccount(deps, copy(both));
    expect(deps.asked).toEqual([
      {
        serverName: 'Tracker',
        secretNames: ['X-Api-Key header', 'bearer token'],
        destinationOrigin: 'https://mcp.tracker.example',
      },
    ]);
    expect(leaks(deps.asked)).toBe(false);
    expect(deps.sent).toHaveLength(1);
    // A copy with no secret sends none and asks nothing.
    const plain = harness();
    await connectMcpAccount(plain, copy([]));
    expect(plain.asked).toEqual([]);
  });

  it('asks for secrets a caller passes in too, so no request skips it', async () => {
    const deps = harness(undefined, () => Promise.resolve(null));
    const direct = McpAccountConnectParamsSchema.parse({
      customUrl: 'https://mcp.tracker.example/mcp',
      configId: 'default',
      headers: { 'X-Api-Key': HEADER_SECRET },
      bearerToken: TOKEN_SECRET,
      _meta: { idempotencyKey: 'key-2' },
    });
    await expect(connectMcpAccount(deps, direct)).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.consentDeclined' },
    });
    expect(deps.asked[0]?.secretNames).toEqual([
      'X-Api-Key header',
      'bearer token',
    ]);
    expect(deps.sent).toEqual([]);
  });

  it('names and pins the token endpoint an OAuth client secret goes to, and refuses a server that pins none', async () => {
    const withSecret = (serverKey: string): McpAccountConnectParams =>
      McpAccountConnectParamsSchema.parse({
        serverKey,
        configId: 'default',
        oauthClient: { clientId: 'client-1', clientSecret: TOKEN_SECRET },
        _meta: { idempotencyKey: `key-oauth-${serverKey}` },
      });
    const pinned = harness();
    await connectMcpAccount(pinned, withSecret('oauthy'));
    expect(pinned.asked).toEqual([
      expect.objectContaining({
        destinationOrigin: 'https://mcp.oauthy.example',
        tokenEndpointOrigin: 'https://login.oauthy-auth.example',
        secretNames: ['OAuth client secret'],
      }),
    ]);
    expect(pinned.sent[0]?.oauthClient).toEqual({
      clientId: 'client-1',
      clientSecret: TOKEN_SECRET,
      tokenEndpoint: 'https://login.oauthy-auth.example/oauth/token',
    });

    // No pinned token endpoint: the cloud would refuse the secret anyway, and
    // main can't say where it goes, so nothing is asked or sent.
    const unpinned = harness();
    const refusal: unknown = await connectMcpAccount(
      unpinned,
      withSecret('linear'),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      payload: { code: 'core.integration.mcpAccount.invalidUrl' },
    });
    expect(unpinned.asked).toEqual([]);
    expect(unpinned.sent).toEqual([]);
  });

  it('tells the person a curated server’s endpoints changed when the cloud refuses the pinned URL as the start adapter reports it', async () => {
    // The start adapter answers the cloud's invalid_url as a refused connect.
    const lagging = harness(
      new AccountMcpConnectionError('connect-refused', undefined, {
        serverCode: 'invalid_url',
      }),
    );
    const refusal: unknown = await connectMcpAccount(
      lagging,
      McpAccountConnectParamsSchema.parse({
        serverKey: 'linear',
        configId: 'default',
        bearerToken: TOKEN_SECRET,
        _meta: { idempotencyKey: 'key-lag-adapter' },
      }),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      payload: {
        kind: 'conflict',
        message: 'This server’s endpoints changed. Try again.',
      },
    });
  });

  it('refuses a curated copy when main’s catalog lags the cloud’s, sending no secret', async () => {
    // Main's catalog lists no options, so the dialog shows the base URL and
    // the start pins it. The cloud's catalog has since gained options and
    // refuses that URL before storing anything.
    const lagging = harness(new AccountMcpConnectionError('invalid-url'));
    const refusal: unknown = await connectMcpAccount(
      lagging,
      McpAccountConnectParamsSchema.parse({
        serverKey: 'linear',
        configId: 'default',
        bearerToken: TOKEN_SECRET,
        _meta: { idempotencyKey: 'key-lag' },
      }),
    ).catch((error: unknown) => error);
    expect(lagging.asked[0]?.destinationOrigin).toBe(
      'https://mcp.linear.example',
    );
    // What was offered is only the pinned URL the person saw.
    expect(lagging.sent).toEqual([
      expect.objectContaining({
        serverKey: 'linear',
        endpointUrl: 'https://mcp.linear.example/mcp',
      }),
    ]);
    expect(refusal).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.integration.mcpAccount.invalidUrl',
        message: 'This server’s endpoints changed. Try again.',
      },
    });
    expect(JSON.stringify(refusal)).not.toContain(TOKEN_SECRET);
  });

  it('names a curated server’s destination from main’s own catalog, and refuses one it can’t name', async () => {
    const curated = (
      serverKey: string,
      endpointUrl?: string,
    ): McpAccountConnectParams =>
      McpAccountConnectParamsSchema.parse({
        serverKey,
        ...(endpointUrl === undefined ? {} : { endpointUrl }),
        configId: 'default',
        bearerToken: TOKEN_SECRET,
        _meta: { idempotencyKey: 'key-3' },
      });

    // A fixed-endpoint curated server, with no options: its catalog name
    // and URL, which the start pins.
    const fixed = harness();
    await connectMcpAccount(fixed, curated('linear'));
    expect(fixed.asked).toEqual([
      {
        serverName: 'Linear',
        secretNames: ['bearer token'],
        destinationOrigin: 'https://mcp.linear.example',
      },
    ]);
    expect(fixed.sent).toHaveLength(1);
    expect(fixed.sent[0]).toMatchObject({
      serverKey: 'linear',
      endpointUrl: 'https://mcp.linear.example/mcp',
    });

    // The same server with its fixed URL pinned explicitly, as the cloud
    // accepts it; any other URL is refused before asking.
    const pinnedFixed = harness();
    await connectMcpAccount(
      pinnedFixed,
      curated('linear', 'https://mcp.linear.example/mcp'),
    );
    expect(pinnedFixed.asked[0]?.destinationOrigin).toBe(
      'https://mcp.linear.example',
    );
    expect(pinnedFixed.sent[0]).toMatchObject({
      serverKey: 'linear',
      endpointUrl: 'https://mcp.linear.example/mcp',
    });
    const elsewhere = harness();
    await expect(
      connectMcpAccount(
        elsewhere,
        curated('linear', 'https://mcp.elsewhere.example/mcp'),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.invalidUrl' },
    });
    expect(elsewhere.asked).toEqual([]);
    expect(elsewhere.sent).toEqual([]);

    // One option, none chosen: the cloud uses that option, never the
    // catalog's base URL on another origin. The dialog names the option, and
    // it's sent, so the cloud can't pick another.
    const sole = harness();
    await connectMcpAccount(sole, curated('github'));
    expect(sole.asked[0]?.destinationOrigin).toBe('https://eu.github.example');
    expect(sole.sent[0]).toMatchObject({
      serverKey: 'github',
      endpointUrl: 'https://eu.github.example/mcp',
    });

    // A chosen endpoint the catalog offers.
    const chosen = harness();
    await connectMcpAccount(
      chosen,
      curated('github', 'https://eu.github.example/mcp'),
    );
    expect(chosen.asked[0]?.destinationOrigin).toBe(
      'https://eu.github.example',
    );
    expect(chosen.sent[0]).toMatchObject({
      endpointUrl: 'https://eu.github.example/mcp',
    });

    // An endpoint the catalog doesn't offer, a server it doesn't list, or
    // several options and none chosen: the cloud could keep whichever an
    // earlier connection used, so main can't say where the secret goes.
    for (const params of [
      curated('github', 'https://elsewhere.example/mcp'),
      curated('unknown'),
      curated('regional'),
    ]) {
      const refusedDeps = harness();
      const refusal: unknown = await connectMcpAccount(
        refusedDeps,
        params,
      ).catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'core.integration.mcpAccount.invalidUrl',
        },
      });
      expect(refusedDeps.asked).toEqual([]);
      expect(refusedDeps.sent).toEqual([]);
      expect(leaks(refusal)).toBe(false);
    }
  });

  it('sends the secrets only under the cloud account the dialog named', async () => {
    const deps = harness();
    await connectMcpAccount(deps, copy(both));
    expect(deps.sent[0]?.expectedAccountId).toBe('acct-A');

    // A caller's own expected account must be that same account.
    const other = harness();
    await expect(
      connectMcpAccount(other, copy(both, { expectedAccountId: 'acct-B' })),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.integration.mcpAccount.accountChanged',
      },
    });
    expect(other.sent).toEqual([]);
  });

  it('sends nothing when the server’s URL or secrets change while the dialog is open', async () => {
    const edits: ((server: McpServerData) => McpServerData)[] = [
      // Pointed somewhere else.
      (server) => ({
        ...server,
        definition: {
          ...server.definition,
          url: 'https://mcp.elsewhere.example/mcp',
        },
      }),
      // Its saved header removed, so the agreed slot set no longer holds.
      (server) => ({
        ...server,
        definition: { ...server.definition, headers: {} },
      }),
    ];
    for (const edit of edits) {
      let stored = SERVER;
      const base = harness();
      const deps: CopyToCloudDeps & { sent: unknown[] } = {
        ...base,
        readServer: (serverId) =>
          Promise.resolve(serverId === 'tracker' ? stored : null),
        confirmSecretsLeave: (request) => {
          stored = edit(stored);
          return Promise.resolve(approving('acct-A', request));
        },
      };
      const refusal: unknown = await connectMcpAccount(deps, copy(both)).catch(
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({
        payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
      });
      expect(deps.sent).toEqual([]);
      expect(leaks(refusal)).toBe(false);
    }
  });

  it('sends nothing when the answer is not for what is about to leave', async () => {
    for (const answer of [
      (request: SecretsLeaveRequest): SecretsLeaveApproval => ({
        ...approving('acct-A', request),
        destinationOrigin: 'https://mcp.elsewhere.example',
      }),
      (request: SecretsLeaveRequest): SecretsLeaveApproval => ({
        ...approving('acct-A', request),
        secretNames: ['bearer token'],
      }),
    ]) {
      const deps = harness(undefined, (request) =>
        Promise.resolve(answer(request)),
      );
      await expect(connectMcpAccount(deps, copy(both))).rejects.toMatchObject({
        payload: { code: 'core.integration.mcpAccount.secretSlotRefused' },
      });
      expect(deps.sent).toEqual([]);
    }
  });

  it('sends nothing when the account changes while the dialog is open', async () => {
    // The start resolves the credentials once and refuses another account
    // before any request leaves, as startAccountMcpConnection does.
    let signedIn = 'acct-A';
    const sentUnder: string[] = [];
    const deps: CopyToCloudDeps = {
      ...harness(),
      confirmSecretsLeave: (request) => {
        const named = signedIn;
        signedIn = 'acct-B';
        return Promise.resolve(approving(named, request));
      },
      start: (request) => {
        if (request.expectedAccountId !== signedIn)
          return Promise.reject(
            new AccountMcpConnectionError('account-changed'),
          );
        sentUnder.push(signedIn);
        return Promise.resolve({ connection: { ...CONNECTION } });
      },
    };
    const refusal: unknown = await connectMcpAccount(deps, copy(both)).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      payload: { code: 'core.integration.mcpAccount.accountChanged' },
    });
    expect(sentUnder).toEqual([]);
    expect(leaks(refusal)).toBe(false);
  });

  it('gives the renderer no way to answer for the person', async () => {
    // The params are strict: no confirmation or skip flag can be sent.
    for (const flag of ['confirmed', 'skipConfirmation', 'consented'])
      expect(
        McpAccountConnectParamsSchema.safeParse({
          ...copy(both),
          [flag]: true,
        }).success,
      ).toBe(false);
    // Through the dispatcher's adapter, a no still sends nothing.
    const deps = harness(undefined, () => Promise.resolve(null));
    const adapter = createCoreMcpAccountAdapter(deps);
    const connect = adapter.instructions?.[
      'core.integration.mcpAccount.connect'
    ] as (params: unknown, context: CanopyHandlerContext) => Promise<unknown>;
    await expect(
      connect(copy(both), {
        caller: { principalId: 'renderer-1' },
        metadata: { idempotencyKey: 'key-3' },
      } as unknown as CanopyHandlerContext),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.consentDeclined' },
    });
    expect(deps.sent).toEqual([]);
  });

  it('uses the native dialog by default, and sends nothing with no main window', async () => {
    const deps = harness();
    const adapter = createCoreMcpAccountAdapter({
      accountEnabled: deps.accountEnabled,
      readServer: deps.readServer,
      start: deps.start,
    });
    const connect = adapter.instructions?.[
      'core.integration.mcpAccount.connect'
    ] as (params: unknown, context: CanopyHandlerContext) => Promise<unknown>;
    await expect(
      connect(copy(both), {
        caller: { principalId: 'renderer-1' },
        metadata: { idempotencyKey: 'key-4' },
      } as unknown as CanopyHandlerContext),
    ).rejects.toMatchObject({
      payload: { code: 'core.integration.mcpAccount.consentDeclined' },
    });
    expect(deps.sent).toEqual([]);
  });

  describe('the native dialog', () => {
    const window = { isDestroyed: () => false } as unknown as BrowserWindow;
    const request: SecretsLeaveRequest = {
      serverName: 'Tracker',
      secretNames: ['X-Api-Key header', 'bearer token'],
      destinationOrigin: 'https://mcp.tracker.example',
    };
    const shown: MessageBoxOptions[] = [];
    const answering =
      (response: number | Error): ConfirmSecretsLeaveDeps['showMessageBox'] =>
      (_window, options) => {
        shown.push(options);
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve({ response });
      };

    it('says yes only when the person picks Send to cloud', async () => {
      const deps = (response: number | Error): ConfirmSecretsLeaveDeps => ({
        mainWindow: () => window,
        account: () => Promise.resolve(ACCOUNT_A),
        showMessageBox: answering(response),
      });
      // A yes answers with exactly what the dialog showed.
      await expect(confirmSecretsLeave(request, deps(1))).resolves.toEqual({
        accountId: 'acct-A',
        destinationOrigin: request.destinationOrigin,
        secretNames: request.secretNames,
      });
      await expect(confirmSecretsLeave(request, deps(0))).resolves.toBeNull();
      await expect(
        confirmSecretsLeave(request, deps(new Error('closed'))),
      ).resolves.toBeNull();
      const options = shown[0];
      expect(options?.buttons).toEqual(['Cancel', 'Send to cloud']);
      expect([options?.defaultId, options?.cancelId]).toEqual([0, 0]);
      expect(options?.detail).toContain('X-Api-Key header');
      expect(options?.detail).toContain('bearer token');
      expect(options?.detail).toContain('person@example.test');
      expect(options?.detail).toContain('https://mcp.tracker.example');
    });

    it('fails closed with no main window or no signed-in account, showing nothing', async () => {
      shown.length = 0;
      const refusing: ConfirmSecretsLeaveDeps[] = [
        {
          mainWindow: () => null,
          account: () => Promise.resolve(ACCOUNT_A),
          showMessageBox: answering(1),
        },
        {
          mainWindow: () =>
            ({ isDestroyed: () => true }) as unknown as BrowserWindow,
          account: () => Promise.resolve(ACCOUNT_A),
          showMessageBox: answering(1),
        },
        {
          mainWindow: () => window,
          account: () => Promise.resolve(null),
          showMessageBox: answering(1),
        },
      ];
      for (const deps of refusing)
        await expect(confirmSecretsLeave(request, deps)).resolves.toBeNull();
      expect(shown).toEqual([]);
    });
  });
});
