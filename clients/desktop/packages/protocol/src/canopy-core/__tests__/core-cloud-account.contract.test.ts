import { z } from 'zod';
import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CLOUD_ACCOUNT_INTEGRATION_ID,
  CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS,
  CloudAccountStatusSchema,
  CoreIntegrationSchema,
} from '../core';

const NAMES = [
  'core.integration.cloudAccount.signIn.start',
  'core.integration.cloudAccount.signIn.cancel',
  'core.integration.cloudAccount.connectWithKey',
  'core.integration.cloudAccount.disconnect',
  'core.integration.cloudAccount.resetUnreadable',
] as const;
const KEYED = new Set<string>([
  'core.integration.cloudAccount.signIn.start',
  'core.integration.cloudAccount.connectWithKey',
]);

const status = {
  kind: 'oauth',
  read: 'ok',
  storage: { state: 'secure', writeAvailable: true },
  sessionExpired: false,
  accountId: 'account-one',
  personalOrganizationId: 'org-personal',
  organizations: [
    { organizationId: 'org-personal', name: 'Personal', role: 'OWNER' },
  ],
  capabilities: ['account-v1'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const refusal = (code: string, retry: string): unknown => ({
  kind: 'unavailable',
  code,
  message: 'refused',
  retry: { kind: retry },
});

describe('core.integration.cloudAccount contract (CAN-4168)', () => {
  it('writes with core.integration.write, keyed for sign-in and key connect only', () => {
    expect(Object.keys(CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS)).toEqual(
      NAMES,
    );
    for (const name of NAMES) {
      const definition = CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[name];
      expect(definition.requiredGrants).toEqual(['core.integration.write']);
      expect(definition.placement).toBe('core-only');
      expect(definition.idempotency).toBe(
        KEYED.has(name) ? 'keyed' : 'inherent',
      );
      const retry = KEYED.has(name) ? 'same_idempotency_key' : 'same_request';
      expect(
        definition.error.safeParse(
          refusal('core.integration.cloudAccount.storageUnavailable', retry),
        ).success,
      ).toBe(name !== 'core.integration.cloudAccount.signIn.cancel');
      expect(
        definition.error.safeParse(
          refusal('core.integration.cloudAccount.localOnly', retry),
        ).success,
      ).toBe(true);
    }
  });

  it('is spec-first: no composed registry serves it yet', () => {
    for (const name of NAMES) {
      expect(Object.hasOwn(CANOPY_INSTRUCTION_DEFINITIONS, name)).toBe(false);
    }
  });

  it('takes the API key write-only and never returns a credential', () => {
    const connect =
      CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.connectWithKey'
      ];
    expect(connect.params.safeParse({ apiKey: 'csk_key' }).success).toBe(true);
    expect(connect.params.safeParse({ apiKey: '' }).success).toBe(false);
    expect(
      connect.result.safeParse({
        account: { connected: true, kind: 'apiKey' },
        apiKey: 'csk_key',
      }).success,
    ).toBe(false);
    for (const name of NAMES) {
      expect(
        CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[name].params.safeParse({
          accountId: 'account-one',
        }).success,
      ).toBe(false);
    }
    expect(
      CloudAccountStatusSchema.safeParse({ ...status, apiKey: 'csk_key' })
        .success,
    ).toBe(false);
    expect(
      CloudAccountStatusSchema.safeParse({
        ...status,
        storage: { ...status.storage, backend: 'gnome_libsecret' },
      }).success,
    ).toBe(false);
  });

  it('admits the API key only as write-only input, in no result or error schema', () => {
    const credentialFields =
      /^(apiKey|token|secret|credential|password|codeVerifier)$/i;
    const found: string[] = [];
    function scan(schema: unknown, where: string): void {
      if (Array.isArray(schema)) {
        schema.forEach((entry, index) =>
          scan(entry, `${where}[${String(index)}]`),
        );
        return;
      }
      if (!isRecord(schema)) return;
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'properties' && isRecord(value)) {
          for (const [name, property] of Object.entries(value)) {
            if (credentialFields.test(name)) {
              const writeOnly =
                typeof property === 'object' &&
                property !== null &&
                'writeOnly' in property &&
                property.writeOnly === true;
              found.push(`${where}.${name}${writeOnly ? ' (writeOnly)' : ''}`);
            }
          }
        }
        scan(value, where);
      }
    }
    const json = (schema: z.ZodType, io: 'input' | 'output'): unknown =>
      z.toJSONSchema(schema, { io, unrepresentable: 'any', cycles: 'ref' });
    for (const name of NAMES) {
      const definition = CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[name];
      scan(json(definition.params, 'input'), `${name}.params`);
      scan(json(definition.result, 'output'), `${name}.result`);
      scan(json(definition.error, 'output'), `${name}.error`);
    }
    scan(json(CloudAccountStatusSchema, 'output'), 'cloudAccount');
    expect(found).toEqual([
      'core.integration.cloudAccount.connectWithKey.params.apiKey (writeOnly)',
    ]);
  });

  it('keeps each operation to its own codes', () => {
    const disconnect =
      CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.disconnect'
      ];
    expect(
      disconnect.error.safeParse(
        refusal('core.integration.cloudAccount.keyRejected', 'same_request'),
      ).success,
    ).toBe(false);
    const start =
      CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.signIn.start'
      ];
    expect(
      start.error.safeParse(
        refusal(
          'core.integration.cloudAccount.callbackRejected',
          'same_idempotency_key',
        ),
      ).success,
    ).toBe(true);
    expect(
      start.error.safeParse(
        refusal(
          'core.integration.cloudAccount.keyRejected',
          'same_idempotency_key',
        ),
      ).success,
    ).toBe(false);
    const connect =
      CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.connectWithKey'
      ];
    expect(
      connect.error.safeParse(
        refusal(
          'core.integration.cloudAccount.callbackRejected',
          'same_idempotency_key',
        ),
      ).success,
    ).toBe(false);
  });

  it('carries a backup file name, never a path', () => {
    const reset =
      CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.resetUnreadable'
      ];
    const account = { connected: false, kind: 'none' };
    expect(
      reset.result.safeParse({
        status: 'reset',
        account,
        backupFileName: 'canopy-cloud-account.enc.bak-1',
      }).success,
    ).toBe(true);
    expect(
      reset.result.safeParse({
        status: 'reset',
        account,
        backupFileName: '/Users/someone/secure/account.enc.bak',
      }).success,
    ).toBe(false);
  });

  it('projects the account as the cloud-account member of core.integration.get', () => {
    expect(CLOUD_ACCOUNT_INTEGRATION_ID).toBe('cloud-account');
    expect(
      Object.hasOwn(CANOPY_QUERY_DEFINITIONS, 'core.integration.get'),
    ).toBe(true);
    const integration = {
      integrationId: CLOUD_ACCOUNT_INTEGRATION_ID,
      kind: 'cloud-account',
      accountLabel: '',
      state: 'connected',
      capabilities: [],
      revision: 1,
    };
    expect(
      CoreIntegrationSchema.safeParse({ ...integration, cloudAccount: status })
        .success,
    ).toBe(true);
    expect(
      CoreIntegrationSchema.safeParse({
        ...integration,
        cloudAccount: { ...status, organizations: [{ id: 'org' }] },
      }).success,
    ).toBe(false);
  });
});
