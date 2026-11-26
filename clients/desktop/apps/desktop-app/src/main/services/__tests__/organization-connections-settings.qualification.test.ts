/**
 * The organization Settings Connectors page on desktop (CAN-6245): its
 * settings table entries reach core.integration.sharedConnection.list,
 * .connect, .reconnect, .disconnect and .remove on the web core, with the
 * idempotency key passed as the instruction's key, never in its params. A web
 * core refusal becomes the settings error the web route answers, and a write
 * whose outcome is unknown is uncertain, never replayed. Other entries keep
 * their own path.
 */
import { CanopyClientError } from '@canopy/core-client';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { createSettingsOrchestratedOperations } from '../account-organization-settings-orchestration';
import {
  createAccountOrganizationSettingsService,
  type SettingsSessionPort,
} from '../account-organization-settings';
import type { OrganizationConnectionsCalls } from '../../shared-connections/organization-connections-calls';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const unused = (): Promise<never> => Promise.reject(new Error('not used'));

function webCore(overrides: Partial<OrganizationConnectionsCalls> = {}): {
  fake: OrganizationConnectionsCalls;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fake: OrganizationConnectionsCalls = {
    list: (organizationId) => {
      calls.push(['core.integration.sharedConnection.list', organizationId]);
      return Promise.resolve({
        organizationId,
        connections: [],
        catalog: [],
      });
    },
    usage: (params) => {
      calls.push(['core.integration.sharedConnection.usage.list', params]);
      return Promise.resolve({
        uses: [],
        nextCursor: null,
        filters: { connections: [], projects: [], people: [] },
      });
    },
    tools: (organizationId, connectionId) => {
      calls.push([
        'core.integration.sharedConnection.tools',
        organizationId,
        connectionId,
      ]);
      return Promise.resolve({
        tools: [{ name: 'list_issues', readOnly: true }],
      });
    },
    instruction: (name, params) => {
      calls.push([name, params]);
      return Promise.resolve({ ok: true });
    },
    ...overrides,
  };
  return { fake, calls };
}

function resolverFor(
  fake: OrganizationConnectionsCalls,
): ReturnType<typeof createSettingsOrchestratedOperations> {
  return createSettingsOrchestratedOperations(unused, unused, unused, () =>
    Promise.resolve(fake),
  );
}

function refusal(
  payload: Pick<CanopyErrorPayload, 'kind' | 'code'>,
): CanopyClientError {
  return new CanopyClientError({
    ...payload,
    message: 'refused',
    retry: { kind: 'never' },
  });
}

async function failureOf(
  run: (() => Promise<unknown>) | null | undefined,
): Promise<unknown> {
  const error: unknown = await run?.().then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(SettingsOperationError);
  return error instanceof SettingsOperationError ? error.toPayload() : null;
}

describe('Connectors settings entries on desktop', () => {
  it('lists and manages connections through the web core operations', async () => {
    const { fake, calls } = webCore();
    const resolve = resolverFor(fake);
    await expect(
      resolve('organization.settings.connections', { organizationId: ORG })?.(),
    ).resolves.toEqual({ organizationId: ORG, connections: [], catalog: [] });
    await expect(
      resolve('organization.settings.connections.tools', {
        organizationId: ORG,
        connectionId: CONNECTION,
      })?.(),
    ).resolves.toEqual({ tools: [{ name: 'list_issues', readOnly: true }] });
    await resolve('organization.settings.connectionUsage', {
      organizationId: ORG,
      connectionId: CONNECTION,
      cursor: '42',
    })?.();
    await resolve('organization.settings.connections.connect', {
      organizationId: ORG,
      serverKey: 'linear',
      label: 'Acme Linear',
      idempotencyKey: 'key-1',
    })?.();
    await resolve('organization.settings.connections.reconnect', {
      organizationId: ORG,
      connectionId: CONNECTION,
      idempotencyKey: 'key-2',
    })?.();
    await resolve('organization.settings.connections.disconnect', {
      organizationId: ORG,
      connectionId: CONNECTION,
      idempotencyKey: 'key-3',
    })?.();
    await resolve('organization.settings.connections.remove', {
      organizationId: ORG,
      connectionId: CONNECTION,
      idempotencyKey: 'key-4',
    })?.();
    expect(calls).toEqual([
      ['core.integration.sharedConnection.list', ORG],
      ['core.integration.sharedConnection.tools', ORG, CONNECTION],
      [
        'core.integration.sharedConnection.usage.list',
        { organizationId: ORG, connectionId: CONNECTION, cursor: '42' },
      ],
      [
        'core.integration.sharedConnection.connect',
        {
          organizationId: ORG,
          serverKey: 'linear',
          label: 'Acme Linear',
          _meta: { idempotencyKey: 'key-1' },
        },
      ],
      [
        'core.integration.sharedConnection.reconnect',
        {
          organizationId: ORG,
          connectionId: CONNECTION,
          _meta: { idempotencyKey: 'key-2' },
        },
      ],
      [
        'core.integration.sharedConnection.disconnect',
        {
          organizationId: ORG,
          connectionId: CONNECTION,
          _meta: { idempotencyKey: 'key-3' },
        },
      ],
      [
        'core.integration.sharedConnection.remove',
        {
          organizationId: ORG,
          connectionId: CONNECTION,
          _meta: { idempotencyKey: 'key-4' },
        },
      ],
    ]);
  });

  it.each([
    [
      {
        kind: 'failed_precondition',
        code: 'core.integration.sharedConnection.botUnavailable',
      },
      {
        code: 'failed',
        status: 409,
        serverCode: 'core.integration.sharedConnection.botUnavailable',
      },
    ],
    [{ kind: 'invalid_argument' }, { code: 'failed', status: 400 }],
    [{ kind: 'permission_denied' }, { code: 'forbidden', status: 403 }],
    [{ kind: 'not_found' }, { code: 'not_found', status: 404 }],
    [{ kind: 'capability_unavailable' }, { code: 'unsupported_server' }],
    [{ kind: 'unavailable' }, { code: 'uncertain' }],
  ] as const)(
    'a refused write (%j) is the settings error %j',
    async (payload, expected) => {
      const { fake } = webCore({
        instruction: () => Promise.reject(refusal(payload)),
      });
      expect(
        await failureOf(
          resolverFor(fake)('organization.settings.connections.remove', {
            organizationId: ORG,
            connectionId: CONNECTION,
            idempotencyKey: 'key-1',
          }),
        ),
      ).toEqual(expected);
    },
  );

  it('a read that fails without a typed refusal is failed, not uncertain', async () => {
    const { fake } = webCore({
      list: () => Promise.reject(new Error('connection reset')),
    });
    expect(
      await failureOf(
        resolverFor(fake)('organization.settings.connections', {
          organizationId: ORG,
        }),
      ),
    ).toEqual({ code: 'failed' });
  });

  it('leaves other entries and malformed input to their own path', () => {
    const resolve = resolverFor(webCore().fake);
    expect(
      resolve('organization.settings.config', { organizationId: ORG }),
    ).toBeNull();
    expect(
      resolve('organization.settings.connections.remove', {
        organizationId: ORG,
      }),
    ).toBeNull();
  });
  it('the account-organization-settings:read and account-organization-settings:write service answers them without the bridge session', async () => {
    const executed: string[] = [];
    const { fake, calls } = webCore({
      instruction: (name, params) => {
        calls.push([name, params]);
        return Promise.reject(refusal({ kind: 'permission_denied' }));
      },
    });
    const session: SettingsSessionPort = {
      accountId: 'account-1',
      generation: 1,
      state: 'ready',
      ensureReady: () => Promise.resolve(),
      onStateChange: () => (): void => undefined,
    };
    const service = createAccountOrganizationSettingsService({
      acquireSession: () => Promise.resolve(session),
      execute: (_session, name) => {
        executed.push(name);
        return Promise.resolve(null);
      },
      openFeedStream: () => ({ close: (): void => undefined }),
      credentials: () => Promise.reject(new Error('not used')),
      currentAccountId: () => Promise.resolve('account-1'),
      currentSession: () => session,
      signedInAccountId: () => 'account-1',
      subscribeAccountChanges: () => (): void => undefined,
      openStrictCloudPage: () => Promise.reject(new Error('not used')),
      paymentHandoffAvailable: () => Promise.resolve(false),
      resolveOrchestrated: resolverFor(fake),
    });
    await expect(
      service.read({
        accountId: 'account-1',
        operation: 'organization.settings.connections',
        input: { organizationId: ORG },
      }),
    ).resolves.toEqual({
      ok: true,
      result: { organizationId: ORG, connections: [], catalog: [] },
    });
    await expect(
      service.write({
        accountId: 'account-1',
        operation: 'organization.settings.connections.disconnect',
        input: {
          organizationId: ORG,
          connectionId: CONNECTION,
          idempotencyKey: 'key-1',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
    expect(calls.map((call) => (call as unknown[])[0])).toEqual([
      'core.integration.sharedConnection.list',
      'core.integration.sharedConnection.disconnect',
    ]);
    expect(executed).toEqual([]);
    service.dispose();
  });
});
