/**
 * The shared project setup panel on desktop (CAN-6239): its settings table
 * entries, organization.projects.setup and .update, reach
 * core.catalog.projectSetup.get and core.catalog.projectSetup.update on the
 * web core, with the read revision, the project's additions, the defaults it
 * switched off, the dismissed recommendations and the idempotency key passed
 * through unchanged. A web core refusal becomes the settings error the web
 * route answers, so the panel reloads on a stale revision, and a save whose
 * outcome is unknown is uncertain, never replayed. Over the
 * account-organization-settings:read and account-organization-settings:write
 * service, neither entry uses the bridge session, and a confirmed save starts
 * a refresh of that project's shared set on this device without holding up
 * the answer.
 */
import { CanopyClientError } from '@canopy/core-client';
import type {
  CanopyErrorPayload,
  CatalogProjectSetupGetResult,
} from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  createSettingsOrchestratedOperations,
  createSettingsWriteFollowUps,
  type SettingsWriteFollowUpEffects,
} from '../account-organization-settings-orchestration';
import {
  createAccountOrganizationSettingsService,
  type SettingsSessionPort,
} from '../account-organization-settings';
import type {
  OrganizationDefaultsSettingsCalls,
  ProjectSetupSettingsCalls,
} from '../../organization-capabilities/web-core-calls';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '99999999-9999-4999-8999-999999999999';
const SKILL = '22222222-2222-4222-8222-222222222222';
const PLUGIN = '33333333-3333-4333-8333-333333333333';

const UPDATE_INPUT = {
  projectId: PROJECT,
  expectedRevision: 4,
  added: [{ kind: 'skill' as const, id: SKILL }],
  removed: [{ kind: 'plugin' as const, id: PLUGIN }],
  dismissedRecommendations: ['marketplacePlugin:github:acme/plugins:lint'],
  idempotencyKey: 'key-1',
};

function setupResult(revision: number): CatalogProjectSetupGetResult {
  return {
    projectId: PROJECT,
    organizationId: ORG,
    revision,
    organizationDefaultsRevision: 1,
    organizationDefaults: [],
    added: [],
    removed: [],
    dismissedRecommendations: [],
    effective: [],
    canEdit: true,
  };
}

function webCore(overrides: Partial<ProjectSetupSettingsCalls> = {}): {
  fake: ProjectSetupSettingsCalls;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fake: ProjectSetupSettingsCalls = {
    read: (projectId) => {
      calls.push(['core.catalog.projectSetup.get', projectId]);
      return Promise.resolve(setupResult(4));
    },
    update: (input) => {
      calls.push(['core.catalog.projectSetup.update', input]);
      return Promise.resolve(setupResult(input.expectedRevision + 1));
    },
    ...overrides,
  };
  return { fake, calls };
}

const noPromotion = (): Promise<never> =>
  Promise.reject(new Error('not a promotion'));

const noDefaults = (): Promise<OrganizationDefaultsSettingsCalls> =>
  Promise.reject(new Error('not the defaults page'));

function refusal(
  payload: Pick<CanopyErrorPayload, 'kind' | 'code'>,
): CanopyClientError {
  return new CanopyClientError({
    ...payload,
    message: 'refused',
    retry: { kind: 'never' },
  });
}

function effects(
  overrides: Partial<SettingsWriteFollowUpEffects> = {},
): SettingsWriteFollowUpEffects {
  return {
    refresh: () => Promise.resolve(),
    refreshWithRetry: () => Promise.resolve(),
    clearRemovedGatewayKey: () => Promise.resolve(),
    refreshOrganizationCapabilities: () => Promise.resolve(),
    refreshProjectCapabilities: () => Promise.resolve(),
    ...overrides,
  };
}

describe('Project setup settings entries on desktop', () => {
  it('reads and saves through the web core operations', async () => {
    const { fake, calls } = webCore();
    const resolve = createSettingsOrchestratedOperations(
      noPromotion,
      noDefaults,
      () => Promise.resolve(fake),
    );
    await expect(
      resolve('organization.projects.setup', { projectId: PROJECT })?.(),
    ).resolves.toMatchObject({ revision: 4 });
    await expect(
      resolve('organization.projects.setup.update', UPDATE_INPUT)?.(),
    ).resolves.toMatchObject({ revision: 5 });
    expect(calls).toEqual([
      ['core.catalog.projectSetup.get', PROJECT],
      ['core.catalog.projectSetup.update', UPDATE_INPUT],
    ]);
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
      const save = createSettingsOrchestratedOperations(
        noPromotion,
        noDefaults,
        () => Promise.resolve(fake),
      )('organization.projects.setup.update', UPDATE_INPUT);
      const error: unknown = await save?.().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SettingsOperationError);
      if (error instanceof SettingsOperationError)
        expect(error.toPayload()).toEqual(expected);
    },
  );

  it('a confirmed save refreshes the project without waiting for it', async () => {
    const refreshed: string[] = [];
    const followUps = createSettingsWriteFollowUps(
      effects({
        refreshProjectCapabilities: (projectId) => {
          refreshed.push(projectId);
          return new Promise<void>(() => undefined);
        },
      }),
    );
    await followUps(
      'organization.projects.setup.update',
      UPDATE_INPUT,
      'account-1',
    )?.();
    expect(refreshed).toEqual([PROJECT]);
    expect(
      followUps(
        'organization.projects.setup',
        { projectId: PROJECT },
        'account-1',
      ),
    ).toBeNull();
  });

  it('the account-organization-settings:read and account-organization-settings:write service answers them without the bridge session', async () => {
    const executed: string[] = [];
    const refreshed: string[] = [];
    const { fake, calls } = webCore();
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
        noDefaults,
        () => Promise.resolve(fake),
      ),
      resolveWriteFollowUp: createSettingsWriteFollowUps(
        effects({
          refreshProjectCapabilities: (projectId) => {
            refreshed.push(projectId);
            return Promise.resolve();
          },
        }),
      ),
    });
    await expect(
      service.read({
        accountId: 'account-1',
        operation: 'organization.projects.setup',
        input: { projectId: PROJECT },
      }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 4 } });
    await expect(
      service.write({
        accountId: 'account-1',
        operation: 'organization.projects.setup.update',
        input: UPDATE_INPUT,
      }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 5 } });
    expect(calls).toHaveLength(2);
    expect(executed).toEqual([]);
    expect(refreshed).toEqual([PROJECT]);
    service.dispose();
  });
});
