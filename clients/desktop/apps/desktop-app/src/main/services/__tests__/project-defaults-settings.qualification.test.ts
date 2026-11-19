/**
 * The organization Settings Project defaults page on desktop (CAN-6237): its
 * settings table entries, organization.settings.projectDefaults and .update,
 * reach core.catalog.organizationDefaults.get and
 * core.catalog.organizationDefaults.update on the web core, with the read
 * revision, the whole list and the idempotency key passed through. A web
 * core refusal becomes the settings error the web route answers, so the
 * shared page reloads on a stale revision or an item the organization no
 * longer shares, and a save whose outcome is unknown is uncertain, never
 * replayed. A confirmed save starts a refresh of that organization's shared
 * items on this device without holding up the answer.
 */
import { CanopyClientError } from '@canopy/core-client';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  createSettingsOrchestratedOperations,
  createSettingsWriteFollowUps,
} from '../account-organization-settings-orchestration';
import {
  createAccountOrganizationSettingsService,
  type SettingsSessionPort,
} from '../account-organization-settings';
import type { OrganizationDefaultsSettingsCalls } from '../../organization-capabilities/web-core-calls';

const ORG = '11111111-1111-4111-8111-111111111111';
const SKILL = '22222222-2222-4222-8222-222222222222';

const UPDATE_INPUT = {
  organizationId: ORG,
  expectedRevision: 2,
  items: [{ kind: 'skill' as const, id: SKILL }],
  idempotencyKey: 'key-1',
};

function webCore(overrides: Partial<OrganizationDefaultsSettingsCalls> = {}): {
  fake: OrganizationDefaultsSettingsCalls;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fake: OrganizationDefaultsSettingsCalls = {
    read: (organizationId) => {
      calls.push(['core.catalog.organizationDefaults.get', organizationId]);
      return Promise.resolve({
        organizationId,
        revision: 2,
        items: [],
        candidates: [],
        canEdit: true,
      });
    },
    update: (input) => {
      calls.push(['core.catalog.organizationDefaults.update', input]);
      return Promise.resolve({
        organizationId: input.organizationId,
        revision: input.expectedRevision + 1,
        items: [],
      });
    },
    ...overrides,
  };
  return { fake, calls };
}

const noPromotion = (): Promise<never> =>
  Promise.reject(new Error('not a promotion'));

function refusal(
  payload: Pick<CanopyErrorPayload, 'kind' | 'code'>,
): CanopyClientError {
  return new CanopyClientError({
    ...payload,
    message: 'refused',
    retry: { kind: 'never' },
  });
}

describe('Project defaults settings entries on desktop', () => {
  it('reads and saves through the web core operations', async () => {
    const { fake, calls } = webCore();
    const resolve = createSettingsOrchestratedOperations(noPromotion, () =>
      Promise.resolve(fake),
    );
    const read = resolve('organization.settings.projectDefaults', {
      organizationId: ORG,
    });
    await expect(read?.()).resolves.toMatchObject({ revision: 2 });
    const save = resolve(
      'organization.settings.projectDefaults.update',
      UPDATE_INPUT,
    );
    await expect(save?.()).resolves.toMatchObject({ revision: 3 });
    expect(calls).toEqual([
      ['core.catalog.organizationDefaults.get', ORG],
      ['core.catalog.organizationDefaults.update', UPDATE_INPUT],
    ]);
    // Other entries keep the bridge session.
    expect(
      resolve('organization.settings.config', { organizationId: ORG }),
    ).toBeNull();
  });

  it.each([
    [
      {
        kind: 'conflict',
        code: 'core.catalog.capabilitySetup.revisionConflict',
      },
      { code: 'failed', status: 409, serverCode: 'revision_conflict' },
    ],
    [
      {
        kind: 'invalid_argument',
        code: 'core.catalog.capabilitySetup.invalidItem',
      },
      { code: 'failed', status: 400, serverCode: 'invalid_item' },
    ],
    [{ kind: 'permission_denied' }, { code: 'forbidden', status: 403 }],
    [{ kind: 'not_found' }, { code: 'not_found', status: 404 }],
    [{ kind: 'capability_unavailable' }, { code: 'unsupported_server' }],
    [{ kind: 'unavailable' }, { code: 'uncertain' }],
  ] as const)(
    'a refused save (%j) is the settings error %j',
    async (payload, expected) => {
      const { fake } = webCore({
        update: () => Promise.reject(refusal(payload)),
      });
      const save = createSettingsOrchestratedOperations(noPromotion, () =>
        Promise.resolve(fake),
      )('organization.settings.projectDefaults.update', UPDATE_INPUT);
      const error: unknown = await save?.().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SettingsOperationError);
      if (error instanceof SettingsOperationError)
        expect(error.toPayload()).toEqual(expected);
    },
  );

  it('a read that fails without a typed refusal is failed, not uncertain', async () => {
    const { fake } = webCore({
      read: () => Promise.reject(new Error('connection reset')),
    });
    const read = createSettingsOrchestratedOperations(noPromotion, () =>
      Promise.resolve(fake),
    )('organization.settings.projectDefaults', { organizationId: ORG });
    const error: unknown = await read?.().then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SettingsOperationError);
    if (error instanceof SettingsOperationError)
      expect(error.code).toBe('failed');
  });

  it('a confirmed save refreshes the organization without waiting for it', async () => {
    const refreshed: string[] = [];
    let finish: () => void = () => undefined;
    const followUps = createSettingsWriteFollowUps({
      refresh: () => Promise.resolve(),
      refreshWithRetry: () => Promise.resolve(),
      clearRemovedGatewayKey: () => Promise.resolve(),
      refreshProjectCapabilities: () => Promise.resolve(),
      refreshOrganizationCapabilities: (organizationId) => {
        refreshed.push(organizationId);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const followUp = followUps(
      'organization.settings.projectDefaults.update',
      UPDATE_INPUT,
      'account-1',
    );
    await followUp?.();
    expect(refreshed).toEqual([ORG]);
    finish();
    expect(
      followUps(
        'organization.settings.projectDefaults',
        { organizationId: ORG },
        'account-1',
      ),
    ).toBeNull();
  });

  it('the account-organization-settings:read and account-organization-settings:write service answers them without the bridge session', async () => {
    const executed: string[] = [];
    const refreshed: string[] = [];
    const { fake, calls } = webCore({
      update: () =>
        Promise.reject(
          refusal({
            kind: 'conflict',
            code: 'core.catalog.capabilitySetup.revisionConflict',
          }),
        ),
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
      openStrictPortalPage: () => Promise.reject(new Error('not used')),
      paymentHandoffAvailable: () => Promise.resolve(false),
      resolveOrchestrated: createSettingsOrchestratedOperations(
        noPromotion,
        () => Promise.resolve(fake),
      ),
      resolveWriteFollowUp: createSettingsWriteFollowUps({
        refresh: () => Promise.resolve(),
        refreshWithRetry: () => Promise.resolve(),
        clearRemovedGatewayKey: () => Promise.resolve(),
        refreshProjectCapabilities: () => Promise.resolve(),
        refreshOrganizationCapabilities: (organizationId) => {
          refreshed.push(organizationId);
          return Promise.resolve();
        },
      }),
    });
    await expect(
      service.read({
        accountId: 'account-1',
        operation: 'organization.settings.projectDefaults',
        input: { organizationId: ORG },
      }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 2 } });
    await expect(
      service.write({
        accountId: 'account-1',
        operation: 'organization.settings.projectDefaults.update',
        input: UPDATE_INPUT,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'failed', status: 409, serverCode: 'revision_conflict' },
    });
    expect(calls).toEqual([['core.catalog.organizationDefaults.get', ORG]]);
    expect(executed).toEqual([]);
    // A refused save is not confirmed, so nothing is refreshed.
    expect(refreshed).toEqual([]);
    service.dispose();
  });
});
