import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CloudAccountEntryJsonSchema,
  cloudAccountEndpointAuthority,
  CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
  CoreCloudAccountProvisionResultSchema,
  CLOUD_ACCOUNT_REFRESH_OUTCOMES,
  CoreCloudAccountRefreshResultSchema,
  resolvePipelineGovernedModelId,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
  type CoreCloudAccountProvisionParams,
  type CoreCloudAccountProvisionResult,
  type WorkerPipelineHostRequest,
  type WorkerPipelineNativeRouteEvidence,
} from '@canopy/protocol/canopy-core';
import {
  createRuntimeProfileGraph,
  type RuntimeModule,
} from '../../../kernel/runtime-profile-graph';
import { CanopyOperationError } from '../../../runtime/errors';
import { createFakeSecretProtection } from '../../../platform/testing/fake-secret-protection';
import type { VaultRepository } from '../../../vault/contracts';
import { createMemoryVaultRepository } from '../../../vault/testing';
import { createDaemonVault, type DaemonVault } from '../../vault/daemon-vault';
import { VAULT_STORE_FILE } from '../../vault/repository/store';
import { recordingSecureFiles } from '../../vault/repository/__tests__/store-fixtures';
import {
  assessManagedPipelineSurvival,
  type ManagedPipelineSurvivalPorts,
} from '../../pipeline/host/managed-survival';
import { prepareManagedPipelineOwnerRun } from '../../pipeline/host/managed-owner';
import {
  CLOUD_ACCOUNT_AUTHORITY_ACTIVATION_SELECTED,
  CLOUD_ACCOUNT_VAULT_FAMILY,
  buildCloudAccountSnapshot,
  createDaemonCloudAccountServices,
  type CloudAccountRefreshResult,
  createCloudAccountAuthority,
  createCloudAccountAuthorizationPort,
  CloudAccountAuthorizationError,
  readCloudAccountAccess,
  createCloudAccountCustody,
  createCloudAccountRefresher,
  createCloudAiCreditsAvailability,
  evaluateCloudModelPolicy,
  probeCloudAccount,
  readCloudAccountRecord,
  type CloudAccountAuthority,
  type CloudAccountCustody,
  type CloudAccountProbe,
  type CloudAccountSnapshotBuilder,
  type CloudJsonRequest,
} from '../daemon';
import { createCloudAccountModule } from '../module';

const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER_ORG = '99999999-2222-4333-8444-555555555555';

type Entry = Record<string, unknown>;
type CloudAccountAuthorityVerify = Parameters<
  CloudAccountAuthority['connectVerified']
>[0]['verify'];

function entry(overrides: Entry = {}): Entry {
  return {
    apiKey: 'csk-first',
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: ['account-v1'],
    account: {
      id: 'account-1',
      name: 'A',
      email: 'a@example.test',
      role: 'ADMIN',
    },
    organizations: [
      {
        id: ORG,
        name: 'Org',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    enforcedSettings: [],
    organizationsVerified: true,
    modelPolicyVerified: true,
    orgBillingStates: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const guestEntry = (): Entry =>
  entry({
    apiKey: 'csk-guest',
    authMode: 'guest',
    credentialSource: 'guest',
    account: {
      id: 'guest-1',
      name: 'G',
      email: 'g@guest.test',
      role: 'DEVELOPER',
    },
  });

function custodyFor(): {
  custody: CloudAccountCustody;
  memory: ReturnType<typeof createMemoryVaultRepository>;
} {
  const memory = createMemoryVaultRepository();
  const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
  return {
    memory,
    custody: createCloudAccountCustody({
      repository: () => Promise.resolve(memory.repository),
      writer: () => Promise.resolve(writer),
    }),
  };
}

/** The daemon's durable vault over a fake key slot that survives reopening. */
function durableVault(
  root: string,
  cloudAccountSelected = true,
  slots = createFakeSecretProtection({ backend: 'macos_keychain' }),
): DaemonVault {
  return createDaemonVault({
    secureDataRoot: root,
    platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
    slots: slots.port,
    cloudAccountSelected,
  });
}

function durableCustody(vault: DaemonVault): CloudAccountCustody {
  return createCloudAccountCustody({
    repository: () => vault.repository(),
    writer: () => vault.writer(CLOUD_ACCOUNT_VAULT_FAMILY),
    probeKeyIfDue: () => vault.probeKeyIfDue(),
  });
}

async function activeAuthority(initial: Entry | null = entry()): Promise<{
  authority: CloudAccountAuthority;
  custody: CloudAccountCustody;
  changes: (string | null)[];
  confirmations: number[];
}> {
  const { custody } = custodyFor();
  const record = initial === null ? null : readCloudAccountRecord(initial);
  const created = await custody.commit({
    expected: null,
    state: 'active',
    credentialGeneration: 1,
    record,
  });
  expect(created.kind).toBe('committed');
  const changes: (string | null)[] = [];
  const confirmations: number[] = [];
  const authority = createCloudAccountAuthority({
    custody,
    events: {
      onChange: (next) => changes.push(next?.apiKey ?? null),
      onConfirm: () => confirmations.push(1),
    },
  });
  return { authority, custody, changes, confirmations };
}

async function replaceAccount(
  authority: CloudAccountAuthority,
  next: Entry | null,
): ReturnType<CloudAccountAuthority['provision']> {
  const read = await authority.read();
  const expected =
    read.kind === 'ok' && read.record
      ? createHash('sha256').update(read.record.apiKey).digest('hex')
      : null;
  return authority.provision(next, expected);
}

describe('cloud account authorization port', () => {
  it.each([
    { account: null, serverApiKeyId: undefined, identity: null },
    { account: null, serverApiKeyId: 'server-key-1', identity: 'server-key-1' },
    {
      account: entry().account,
      serverApiKeyId: undefined,
      identity: 'account-1',
    },
  ])(
    'keeps credential-derived route bindings out of public current (%j)',
    async ({ account, serverApiKeyId, identity }) => {
      const { authority } = await activeAuthority(
        entry({ account, serverApiKeyId }),
      );
      const port = createCloudAccountAuthorizationPort(authority);
      try {
        await expect(port.current()).resolves.toMatchObject({
          routeIdentity: identity,
        });
        const internal = await readCloudAccountAccess(authority);
        expect(internal.kind === 'ok' && internal.routeIdentity).toBe(
          identity ?? createHash('sha256').update('csk-first').digest('hex'),
        );
      } finally {
        port.dispose();
      }
    },
  );

  it('binds the lease account id to its issuing snapshot, including no normalized account', async () => {
    const { authority } = await activeAuthority(entry({ account: null }));
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    expect(lease.accountId).toBeNull();
    // Reprovisioning the same credential does not replace daemon-owned policy.
    await expect(replaceAccount(authority, entry())).resolves.toEqual({
      kind: 'unchanged',
      credentialGeneration: 1,
    });
    const current = await authority.read();
    if (current.kind !== 'ok' || !current.record) throw new Error('No account');
    await expect(
      authority.saveIfUnchanged(entry(), current.record, {
        probe: authority.beginProbe(),
      }),
    ).resolves.toMatchObject({ kind: 'saved', changed: true });
    expect(lease.accountId).toBeNull();
    expect(() => lease.apply(new Headers())).toThrow(
      CloudAccountAuthorizationError,
    );
    const replacement = await port.lease(1);
    expect(replacement.accountId).toBe('account-1');
    const headers = new Headers();
    replacement.apply(headers);
    expect(headers.get('authorization')).toBe('Bearer csk-first');
    port.dispose();
  });

  it.each([
    '\rcsk-secret-hidden',
    '\ncsk-secret-hidden',
    'csk-secret\rhidden',
    'csk-secret\nhidden',
    'csk-secret\thidden',
    'csk-secret\u0000hidden',
    'csk-secret\u007f',
    'csk-secreté',
  ])(
    'refuses unsafe header values without exposing them: %j',
    async (apiKey) => {
      const { authority } = await activeAuthority(entry({ apiKey }));
      const port = createCloudAccountAuthorizationPort(authority);
      const lease = await port.lease(1);
      const headers = new Headers({ authorization: 'Bearer previous' });
      try {
        lease.apply(headers);
        throw new Error('Expected refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(CloudAccountAuthorizationError);
        expect(error).toMatchObject({ reason: 'unavailable' });
        expect(String(error)).not.toContain(apiKey);
        const detail =
          error instanceof Error
            ? `${error.message}\n${error.stack}`
            : String(error);
        for (let offset = 0; offset <= apiKey.length - 8; offset += 1)
          expect(detail).not.toContain(apiKey.slice(offset, offset + 8));
      }
      expect(headers.has('authorization')).toBe(false);
      lease.release();
      port.dispose();
    },
  );

  it('preserves visible ASCII keys and ignores trailing whitespace in a lease', async () => {
    const apiKey = 'csk-visible !~ \t\r\n';
    const { authority } = await activeAuthority(entry({ apiKey }));
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers();
    lease.apply(headers);
    expect(headers.get('authorization')).toBe('Bearer csk-visible !~');
    const other = new Headers({ authorization: 'Bearer previous' });
    expect(() => lease.apply(other)).toThrow(CloudAccountAuthorizationError);
    expect(headers.has('authorization')).toBe(false);
    expect(other.has('authorization')).toBe(false);
    port.dispose();
  });

  it('leaves empty credentials signed out', async () => {
    const { authority } = await activeAuthority(entry({ apiKey: ' ' }));
    const port = createCloudAccountAuthorizationPort(authority);
    await expect(port.lease(1)).rejects.toMatchObject({ reason: 'signed-out' });
    port.dispose();
  });

  it('exposes only nonsecret current access and retires subscribers on disposal', async () => {
    const { authority } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const current = await port.current();
    expect(current).toMatchObject({
      kind: 'ok',
      accountId: 'account-1',
      credentialGeneration: 1,
    });
    expect(current).not.toHaveProperty('record');
    expect(JSON.stringify(current)).not.toContain('csk-first');
    const changed = jest.fn();
    const removed = jest.fn();
    port.onAccountChanged((): void => {
      throw new Error('subscriber failed');
    });
    port.onAccountChanged(changed);
    const unsubscribe = port.onAccountChanged(removed);
    unsubscribe();
    await replaceAccount(authority, entry({ apiKey: 'csk-next' }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(await port.current()).toMatchObject({ credentialGeneration: 2 });
    port.dispose();
    await replaceAccount(authority, null);
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(port.current()).rejects.toMatchObject({ reason: 'closed' });
    expect(() => port.onAccountChanged(changed)).toThrow(
      CloudAccountAuthorizationError,
    );
  });

  it('preserves guest account transport and rejects invalid generations', async () => {
    const { authority } = await activeAuthority(guestEntry());
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers();
    lease.apply(headers);
    expect(headers.get('authorization')).toBe('Bearer csk-guest');
    expect(await readCloudAccountAccess(authority)).toMatchObject({
      guest: true,
    });
    await expect(port.lease(Number.NaN)).rejects.toMatchObject({
      reason: 'stale-lease',
    });
    await expect(port.lease(-1)).rejects.toMatchObject({
      reason: 'stale-lease',
    });
    port.dispose();
  });

  it('presents a credential once without returning it and strips headers on release', async () => {
    const { authority } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers({ 'x-request': 'kept' });
    expect(JSON.stringify(lease)).not.toContain('csk-first');
    expect(lease.accountId).toBe('account-1');
    expect(lease.credentialVersion).toBe('1');
    lease.apply(headers);
    expect(headers.get('authorization')).toBe('Bearer csk-first');
    lease.release();
    lease.release();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-request')).toBe('kept');
    expect(() => lease.apply(headers)).toThrow(CloudAccountAuthorizationError);
    port.dispose();
  });

  it('retires issued and applied headers on replacement, including same-account rotation', async () => {
    const { authority } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const applied = await port.lease(1);
    const issued = await port.lease(1);
    const headers = new Headers();
    applied.apply(headers);
    await replaceAccount(authority, entry({ apiKey: 'csk-replacement' }));
    expect(headers.has('authorization')).toBe(false);
    const other = new Headers({ Authorization: 'stale' });
    expect(() => issued.apply(other)).toThrow(CloudAccountAuthorizationError);
    expect(other.has('authorization')).toBe(false);
    await expect(port.lease(1)).rejects.toMatchObject({
      reason: 'stale-lease',
    });
    const replacement = await port.lease(2);
    replacement.apply(headers);
    expect(headers.get('authorization')).toBe('Bearer csk-replacement');
    port.dispose();
    expect(headers.has('authorization')).toBe(false);
    await expect(port.lease(2)).rejects.toMatchObject({ reason: 'closed' });
  });

  it('strips on disconnect and credential rejection without exposing error material', async () => {
    const { authority } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers();
    lease.apply(headers);
    await authority.recordCredentialRejected(1);
    expect(headers.has('authorization')).toBe(false);
    await expect(port.lease(1)).rejects.toMatchObject({
      reason: 'session-expired',
    });
    await replaceAccount(authority, null);
    await expect(port.lease(2)).rejects.toMatchObject({ reason: 'signed-out' });
    port.dispose();
  });

  it('does not strip replacement headers for a stale refusal', async () => {
    const { authority } = await activeAuthority();
    const probe = authority.beginProbe();
    await replaceAccount(authority, entry({ apiKey: 'csk-replacement' }));
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(2);
    const headers = new Headers();
    lease.apply(headers);
    expect(
      await authority.recordCredentialRejected(1, 'rejected', probe),
    ).toEqual({ kind: 'stale' });
    expect(headers.get('authorization')).toBe('Bearer csk-replacement');
    port.dispose();
  });

  it.each(['broker', 'probe'])(
    'retires headers before a %s refusal waits for persistence',
    async (source) => {
      const { custody } = await activeAuthority();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const authority = createCloudAccountAuthority({
        custody: {
          ...custody,
          commit: async (input): ReturnType<typeof custody.commit> => {
            entered.resolve();
            await release.promise;
            return custody.commit(input);
          },
        },
      });
      const port = createCloudAccountAuthorizationPort(authority);
      const applied = await port.lease(1);
      const issued = await port.lease(1);
      const headers = new Headers();
      applied.apply(headers);
      const current = await authority.read();
      if (current.kind !== 'ok' || !current.record)
        throw new Error('No account');
      const probe = authority.beginProbe();
      const saving = authority.saveIfUnchanged(entry(), current.record);
      await entered.promise;
      const refusing =
        source === 'broker'
          ? authority.recordCredentialRejected(1, 'rejected', probe)
          : authority.applyProbeResult(current.record, probe, 'rejected');
      try {
        expect(headers.has('authorization')).toBe(false);
        expect(() => issued.apply(new Headers())).toThrow(
          CloudAccountAuthorizationError,
        );
      } finally {
        release.resolve();
        await saving;
        await refusing;
        port.dispose();
      }
    },
  );

  it('strips headers when a replacement write has an unknown outcome', async () => {
    const { custody } = await activeAuthority();
    const authority = createCloudAccountAuthority({
      custody: {
        ...custody,
        commit: () => Promise.resolve({ kind: 'outcome_unknown' }),
      },
    });
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers();
    lease.apply(headers);
    await expect(
      replaceAccount(authority, entry({ apiKey: 'csk-replacement' })),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'outcome_unknown' });
    expect(headers.has('authorization')).toBe(false);
    port.dispose();
  });

  it('refuses inactive and unreadable custody with typed, redacted errors', async () => {
    const { custody } = custodyFor();
    const authority = createCloudAccountAuthority({ custody });
    const inactive = createCloudAccountAuthorizationPort(authority);
    await expect(inactive.lease(0)).rejects.toBeInstanceOf(
      CloudAccountAuthorizationError,
    );
    await expect(inactive.lease(0)).rejects.toMatchObject({
      reason: 'inactive',
    });
    inactive.dispose();
    const unavailable = createCloudAccountAuthorizationPort({
      ...authority,
      read: () => Promise.resolve({ kind: 'unavailable', reason: 'locked' }),
    });
    await expect(unavailable.lease(0)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    unavailable.dispose();
  });

  it.each(['lease', 'current'] as const)(
    'fences %s across an account change and disposal',
    async (operation) => {
      const { authority } = await activeAuthority();
      const stale = await authority.read();
      let complete: ((read: typeof stale) => void) | undefined;
      const delayed = {
        ...authority,
        read: (): Promise<typeof stale> =>
          new Promise<typeof stale>((resolve) => {
            complete = resolve;
          }),
      };
      const port = createCloudAccountAuthorizationPort(delayed);
      const pending = operation === 'lease' ? port.lease(1) : port.current();
      await replaceAccount(authority, entry({ apiKey: 'csk-next' }));
      complete?.(stale);
      await expect(pending).rejects.toMatchObject({ reason: 'stale-lease' });
      const closing = operation === 'lease' ? port.lease(2) : port.current();
      port.dispose();
      complete?.(await authority.read());
      await expect(closing).rejects.toMatchObject({ reason: 'closed' });
    },
  );

  it('strips after policy refresh and evaluates the lease gate on its own current snapshot', async () => {
    const { authority } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const lease = await port.lease(1);
    const headers = new Headers();
    lease.apply(headers);
    const read = await authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('No account');
    await authority.saveIfUnchanged(
      entry({ modelPolicyVerified: false }),
      read.record,
    );
    expect(headers.has('authorization')).toBe(false);
    await expect(
      port.lease(
        1,
        (current) =>
          current.kind === 'ok' &&
          current.executionUnknownReason(null) === null,
      ),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    // Policy uncertainty must not prevent ordinary account transport/refresh.
    const transport = await port.lease(1);
    transport.release();
    const access = await readCloudAccountAccess(authority);
    expect(JSON.stringify(access)).not.toContain('csk-first');
    expect(access).not.toHaveProperty('record');
    expect(access).not.toHaveProperty('apiKey');
    port.dispose();
  });
});

describe('cloud account record', () => {
  it('keeps every field of the whole entry, including unknown ones', () => {
    const record = readCloudAccountRecord(
      entry({ personalModelGateway: { id: 'g' }, futureField: { a: [1] } }),
    );
    expect(record?.entry.futureField).toEqual({ a: [1] });
    expect(record?.entry.personalModelGateway).toEqual({ id: 'g' });
    expect(record?.accountId).toBe('account-1');
    expect(record?.organizationIds).toEqual([ORG]);
    expect(Object.isFrozen(record?.entry)).toBe(true);
  });

  it('refuses entries without a credential or timestamps', () => {
    expect(
      readCloudAccountRecord({ createdAt: 'x', updatedAt: 'y' }),
    ).toBeNull();
    expect(readCloudAccountRecord(entry({ updatedAt: 3 }))).toBeNull();
    expect(readCloudAccountRecord('csk')).toBeNull();
  });

  it('normalizes OAuth desktop credentials to oauth like the app', () => {
    const record = readCloudAccountRecord(entry({ authMode: 'api_key' }));
    expect(record?.authMode).toBe('oauth');
  });
});

describe('cloud account record parity with the app normalizer', () => {
  it('drops an account the app cannot normalize, so identity uses the credential', () => {
    const record = readCloudAccountRecord(
      entry({
        account: { id: 'account-1', name: 'A', email: 'e', role: 'OWNER' },
      }),
    );
    expect(record?.accountId).toBeNull();
  });

  it('refuses a malformed loss handoff instead of dropping it', () => {
    expect(
      readCloudAccountRecord(
        entry({
          organizationAccessLossState: { accountId: 'account-1', version: 2 },
        }),
      ),
    ).toBeNull();
    // Another account's handoff is dropped, as the app drops it.
    expect(
      readCloudAccountRecord(
        entry({
          organizationAccessLossState: { accountId: 'other', version: 2 },
        }),
      )?.organizationAccessLossState,
    ).toBeNull();
  });
});

describe('cloud account custody', () => {
  it('creates once, then compares and swaps on the vault revision', async () => {
    const { custody } = custodyFor();
    expect((await custody.read()).kind).toBe('absent');
    const first = await custody.commit({
      expected: null,
      state: 'active',
      credentialGeneration: 0,
      record: readCloudAccountRecord(entry()),
    });
    if (first.kind !== 'committed') throw new Error(first.kind);
    expect(
      (
        await custody.commit({
          expected: null,
          state: 'active',
          credentialGeneration: 0,
          record: null,
        })
      ).kind,
    ).toBe('superseded');
    const second = await custody.commit({
      expected: first.pin,
      state: 'active',
      credentialGeneration: 1,
      record: null,
    });
    expect(second.kind).toBe('committed');
    // A stale pin cannot overwrite the newer revision.
    expect(
      (
        await custody.commit({
          expected: first.pin,
          state: 'active',
          credentialGeneration: 2,
          record: readCloudAccountRecord(entry({ apiKey: 'csk-stale' })),
        })
      ).kind,
    ).toBe('superseded');
    const read = await custody.read();
    expect(read.kind === 'ok' && read.document.record).toBeNull();
  });

  it('reports an unreadable store as unavailable, never as signed out', async () => {
    const custody = createCloudAccountCustody({
      repository: () =>
        Promise.resolve({
          list: () =>
            Promise.resolve([
              {
                ref: { vaultId: 'v', entryId: 'e' },
                revision: 1,
                family: CLOUD_ACCOUNT_VAULT_FAMILY,
                label: 'Cloud account',
                expiresAt: null,
                createdAt: '2026-11-01T00:00:00.000Z',
                updatedAt: '2026-11-01T00:00:00.000Z',
                state: 'available',
              },
            ]),
          get: () => Promise.resolve({ kind: 'blocked', reason: 'locked' }),
          admit: () => ({ kind: 'blocked', reason: 'locked' }),
          status: () => ({
            protection: { state: 'unknown', backend: 'test' },
            observedAt: null,
          }),
        }),
      writer: () => Promise.reject(new Error('unused')),
    });
    expect(await custody.read()).toEqual({
      kind: 'unavailable',
      reason: 'locked',
    });
  });

  it('refuses a writer for another family', async () => {
    const memory = createMemoryVaultRepository();
    const custody = createCloudAccountCustody({
      repository: () => Promise.resolve(memory.repository),
      writer: () => Promise.resolve(memory.writer('github-pat')),
    });
    await expect(
      custody.commit({
        expected: null,
        state: 'active',
        credentialGeneration: 0,
        record: null,
      }),
    ).rejects.toThrow('Wrong credential writer.');
  });

  it('answers a throwing vault with typed failures, never an exception', async () => {
    const custody = createCloudAccountCustody({
      repository: () => Promise.reject(new Error('vault disposed')),
      writer: () => Promise.reject(new Error('writer refused')),
    });
    const unavailable = { kind: 'unavailable', reason: 'unavailable' };
    expect(await custody.read()).toEqual(unavailable);
    expect(
      await custody.commit({
        expected: null,
        state: 'active',
        credentialGeneration: 0,
        record: null,
      }),
    ).toEqual(unavailable);
    expect(await custody.resetUnreadable(1)).toEqual(unavailable);
    expect(await createCloudAccountAuthority({ custody }).read()).toEqual(
      unavailable,
    );
  });

  it('mints the family writer only for a daemon vault selected for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cloud-account-reserved-'));
    const vaults = [false, true].map((selected) =>
      durableVault(join(root, String(selected)), selected),
    );
    try {
      await expect(
        vaults[0]?.writer(CLOUD_ACCOUNT_VAULT_FAMILY),
      ).rejects.toMatchObject({
        payload: { code: 'core.vault.entry.writerRefused' },
      });
      await expect(
        vaults[1]?.writer(CLOUD_ACCOUNT_VAULT_FAMILY),
      ).resolves.toMatchObject({ family: CLOUD_ACCOUNT_VAULT_FAMILY });
    } finally {
      await Promise.all(vaults.map((vault) => vault.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out a queued provision without starting a second write', async () => {
    jest.useFakeTimers();
    try {
      const { custody } = custodyFor();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const commit = jest.fn<
        ReturnType<CloudAccountCustody['commit']>,
        Parameters<CloudAccountCustody['commit']>
      >(async (input) => {
        entered.resolve();
        await released.promise;
        return custody.commit(input);
      });
      const authority = createCloudAccountAuthority({
        custody: { ...custody, commit },
        queueTimeoutMs: 1_000,
      });
      const first = authority.provision(entry(), null);
      await entered.promise;
      const queued = authority.provision(entry({ apiKey: 'csk-second' }), null);
      await jest.advanceTimersByTimeAsync(1_001);
      await expect(queued).resolves.toEqual({
        kind: 'unavailable',
        reason: 'busy',
      });
      expect(commit).toHaveBeenCalledTimes(1);
      released.resolve();
      await expect(first).resolves.toMatchObject({ kind: 'provisioned' });
      const read = await authority.read();
      expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('cloud account authority', () => {
  it('advances the credential generation on replacement and sign-out only', async () => {
    const { authority } = await activeAuthority();
    const start = await authority.read();
    if (start.kind !== 'ok') throw new Error(start.kind);
    expect(start.credentialGeneration).toBe(1);
    const saved = await replaceAccount(
      authority,
      entry({ apiKey: 'csk-second' }),
    );
    expect(saved.kind).toBe('provisioned');
    const afterSave = await authority.read();
    expect(afterSave.kind === 'ok' && afterSave.credentialGeneration).toBe(2);
    const expected = afterSave.kind === 'ok' ? afterSave.record : null;
    if (!expected) throw new Error('missing record');
    const refreshed = await authority.saveIfUnchanged(
      { ...expected.entry, updatedAt: '2026-11-02T00:00:00.000Z' },
      expected,
    );
    expect(refreshed).toMatchObject({ kind: 'saved', changed: false });
    const afterRefresh = await authority.read();
    expect(
      afterRefresh.kind === 'ok' && afterRefresh.credentialGeneration,
    ).toBe(2);
    expect((await replaceAccount(authority, null)).kind).toBe('cleared');
    const afterClear = await authority.read();
    expect(afterClear.kind === 'ok' && afterClear.credentialGeneration).toBe(3);
    expect(afterClear.kind === 'ok' && afterClear.record).toBeNull();
    await expect(authority.provision(null, null)).resolves.toEqual({
      kind: 'cleared',
      credentialGeneration: 4,
    });
  });

  it('fences pending verification on repeated clears, then permits a fresh sign-in', async () => {
    const { authority, custody } = await activeAuthority(null);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Entry>();
    const signingIn = authority.connectVerified({
      commandId: createHash('sha256').update('pending-connect').digest('hex'),
      credentialDigest: createHash('sha256').update('csk-first').digest('hex'),
      signal: new AbortController().signal,
      verify: () => {
        entered.resolve();
        return release.promise;
      },
    });
    await entered.promise;
    await expect(authority.provision(null, null)).resolves.toEqual({
      kind: 'cleared',
      credentialGeneration: 2,
    });
    await expect(authority.provision(null, null)).resolves.toEqual({
      kind: 'cleared',
      credentialGeneration: 3,
    });
    expect(await custody.read()).toMatchObject({
      document: { record: null, credentialGeneration: 3 },
    });
    release.resolve(entry());
    await expect(signingIn).resolves.toEqual({ kind: 'superseded' });
    await expect(
      authority.connectVerified({
        commandId: createHash('sha256').update('fresh-connect').digest('hex'),
        credentialDigest: createHash('sha256')
          .update('csk-first')
          .digest('hex'),
        signal: new AbortController().signal,
        verify: () => Promise.resolve(entry()),
      }),
    ).resolves.toEqual({ kind: 'provisioned', credentialGeneration: 4 });
    await expect(replaceAccount(authority, null)).resolves.toEqual({
      kind: 'cleared',
      credentialGeneration: 5,
    });
    await expect(authority.provision(null, null)).resolves.toEqual({
      kind: 'cleared',
      credentialGeneration: 6,
    });
  });

  it('keeps a joined sign-in for the callers still waiting, and resumes it once all left', async () => {
    const { authority } = await activeAuthority(null);
    const commandId = createHash('sha256').update('joined').digest('hex');
    const credentialDigest = createHash('sha256')
      .update('csk-first')
      .digest('hex');
    let probes = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const signIn = (
      signal: AbortSignal,
    ): ReturnType<CloudAccountAuthority['connectVerified']> =>
      authority.connectVerified({
        commandId,
        credentialDigest,
        signal,
        verify: async () => {
          probes += 1;
          entered.resolve();
          await release.promise;
          return entry();
        },
      });
    // One caller leaving fails only its own wait, not the shared probe.
    const first = new AbortController();
    const leaving = signIn(first.signal);
    const staying = signIn(new AbortController().signal);
    await entered.promise;
    first.abort(new Error('first caller left'));
    release.resolve();
    await expect(leaving).rejects.toThrow('first caller left');
    await expect(staying).resolves.toEqual({
      kind: 'provisioned',
      credentialGeneration: 2,
    });
    expect(probes).toBe(1);

    // When every caller leaves, the command stops; a retry resumes it.
    await expect(replaceAccount(authority, null)).resolves.toMatchObject({
      kind: 'cleared',
    });
    const stopped = Promise.withResolvers<void>();
    const only = new AbortController();
    const abandoned = authority.connectVerified({
      commandId: createHash('sha256').update('abandoned').digest('hex'),
      credentialDigest,
      signal: only.signal,
      verify: (_before, _generation, _probe, commandSignal) => {
        probes += 1;
        stopped.resolve();
        return new Promise((_resolve, reject) =>
          commandSignal.addEventListener(
            'abort',
            () =>
              reject(
                commandSignal.reason instanceof Error
                  ? commandSignal.reason
                  : new Error('aborted'),
              ),
            { once: true },
          ),
        );
      },
    });
    await stopped.promise;
    only.abort(new Error('every caller left'));
    await expect(abandoned).rejects.toThrow('every caller left');
    await expect(
      authority.connectVerified({
        commandId: createHash('sha256').update('abandoned').digest('hex'),
        credentialDigest,
        signal: new AbortController().signal,
        verify: () => {
          probes += 1;
          return Promise.resolve(entry());
        },
      }),
    ).resolves.toMatchObject({ kind: 'provisioned' });
    expect(probes).toBe(3);
  });

  it('ranks a sign-in receipt by its completion, not its registration', async () => {
    const { authority } = await activeAuthority(null);
    const command = (name: string): string =>
      createHash('sha256').update(name).digest('hex');
    const credentialDigest = command('csk-first');
    let probes = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const signIn = (): ReturnType<CloudAccountAuthority['connectVerified']> =>
      authority.connectVerified({
        commandId: command('slow'),
        credentialDigest,
        signal: new AbortController().signal,
        verify: async () => {
          probes += 1;
          entered.resolve();
          await release.promise;
          return entry();
        },
      });
    const fail = (index: number): Promise<unknown> =>
      authority
        .connectVerified({
          commandId: command(`failed-${String(index)}`),
          credentialDigest,
          signal: new AbortController().signal,
          verify: () => Promise.reject(new Error('rejected')),
        })
        .catch(() => undefined);
    const slow = signIn();
    await entered.promise;
    // Registered after the slow command, but finished before it.
    for (let index = 0; index < 63; index++) await fail(index);
    release.resolve();
    await expect(slow).resolves.toMatchObject({ kind: 'provisioned' });
    await fail(63);
    await expect(signIn()).resolves.toMatchObject({ kind: 'unchanged' });
    expect(probes).toBe(1);
  });

  it('keeps the newer of two same-key sign-ins that finish in reverse order', async () => {
    const { authority } = await activeAuthority();
    const digest = (value: string): string =>
      createHash('sha256').update(value).digest('hex');
    const signIn = (
      name: string,
      outcome: () => Promise<void>,
    ): {
      readonly probing: Promise<void>;
      readonly result: ReturnType<CloudAccountAuthority['connectVerified']>;
    } => {
      const probing = Promise.withResolvers<void>();
      const result = authority.connectVerified({
        commandId: digest(name),
        credentialDigest: digest('csk-first'),
        signal: new AbortController().signal,
        verify: async () => {
          probing.resolve();
          await outcome();
          return entry({
            account: {
              id: 'account-1',
              name,
              email: 'a@example.test',
              role: 'ADMIN',
            },
          });
        },
      });
      return { probing: probing.promise, result };
    };
    const held = async (): Promise<unknown> => {
      const read = await authority.read();
      return read.kind === 'ok' && read.record?.entry.account;
    };
    const releaseOlder = Promise.withResolvers<void>();
    const older = signIn('Older', () => releaseOlder.promise);
    await older.probing;
    const releaseNewer = Promise.withResolvers<void>();
    const newer = signIn('Newer', () => releaseNewer.promise);
    await newer.probing;
    releaseNewer.resolve();
    await expect(newer.result).resolves.toEqual({
      kind: 'provisioned',
      credentialGeneration: 1,
    });
    releaseOlder.resolve();
    await expect(older.result).resolves.toEqual({ kind: 'superseded' });
    await expect(held()).resolves.toMatchObject({ name: 'Newer' });

    // Only a committed sign-in outranks: a newer one that fails refuses nothing.
    const releaseLater = Promise.withResolvers<void>();
    const later = signIn('Later', () => releaseLater.promise);
    await later.probing;
    const failed = signIn('Failed', () => Promise.reject(new Error('offline')));
    await expect(failed.result).rejects.toThrow('offline');
    releaseLater.resolve();
    await expect(later.result).resolves.toMatchObject({ kind: 'provisioned' });
    await expect(held()).resolves.toMatchObject({ name: 'Later' });
  });

  it('keeps a retried failed sign-in fenced against a later disconnect', async () => {
    const { authority } = await activeAuthority();
    const command = (name: string): string =>
      createHash('sha256').update(name).digest('hex');
    let reachable = false;
    const retried = (): ReturnType<CloudAccountAuthority['connectVerified']> =>
      authority.connectVerified({
        commandId: command('retried'),
        credentialDigest: command('csk-second'),
        signal: new AbortController().signal,
        verify: () =>
          reachable
            ? Promise.resolve(entry({ apiKey: 'csk-second' }))
            : Promise.reject(new Error('offline')),
      });
    const fail = (index: number): Promise<unknown> =>
      authority
        .connectVerified({
          commandId: command(`failed-${String(index)}`),
          credentialDigest: command('csk-revoked'),
          signal: new AbortController().signal,
          verify: () => Promise.reject(new Error('rejected')),
        })
        .catch(() => undefined);
    await expect(retried()).rejects.toThrow('offline');
    for (let index = 0; index < 63; index++) await fail(index);
    // Its retry is its newest attempt: 64 later receipts are needed to drop it.
    await expect(retried()).rejects.toThrow('offline');
    await fail(63);
    await expect(replaceAccount(authority, null)).resolves.toMatchObject({
      kind: 'cleared',
    });
    reachable = true;
    await expect(retried()).resolves.toMatchObject({ kind: 'superseded' });
    expect(await authority.read()).toMatchObject({ record: null });
  });

  it('refuses a refresh after a replacement or a disconnect raced it', async () => {
    const { authority } = await activeAuthority();
    const before = await authority.read();
    if (before.kind !== 'ok' || !before.record) throw new Error('setup');
    const probe = authority.beginProbe();
    // Replacement lands while the probe is in flight.
    await replaceAccount(authority, entry({ apiKey: 'csk-replacement' }));
    const late = await authority.saveIfUnchanged(
      { ...before.record.entry, updatedAt: '2026-11-03T00:00:00.000Z' },
      before.record,
      { probe },
    );
    expect(late.kind).toBe('superseded');
    const read = await authority.read();
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-replacement');

    const current = read.kind === 'ok' ? read.record : null;
    if (!current) throw new Error('setup');
    const second = authority.beginProbe();
    await replaceAccount(authority, null);
    expect(
      (
        await authority.saveIfUnchanged(
          { ...current.entry, updatedAt: '2026-11-04T00:00:00.000Z' },
          current,
          { probe: second },
        )
      ).kind,
    ).toBe('superseded');
    const cleared = await authority.read();
    expect(cleared.kind === 'ok' && cleared.record).toBeNull();
  });

  it('settles an issued provision before a reconciliation read, without blocking policy reads', async () => {
    const { custody } = custodyFor();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const authority = createCloudAccountAuthority({
      custody: {
        ...custody,
        commit: async (input) => {
          entered.resolve();
          await release.promise;
          return custody.commit(input);
        },
      },
    });
    const provisioning = authority.provision(entry(), null);
    await entered.promise;
    const reading = authority.read({ settleMutations: true });
    try {
      await expect(authority.read()).resolves.toMatchObject({
        kind: 'inactive',
      });
    } finally {
      release.resolve();
      await provisioning;
    }
    const read = await reading;
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
  });

  it('refuses a refresh that would carry another credential or identity', async () => {
    const { authority } = await activeAuthority();
    const read = await authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('setup');
    expect(
      (
        await authority.saveIfUnchanged(
          { ...read.record.entry, apiKey: 'csk-x' },
          read.record,
        )
      ).kind,
    ).toBe('invalid');
  });

  it.each([
    { apiKey: 'csk-other' },
    { apiKey: '' },
    {
      account: {
        id: 'another-account',
        name: 'B',
        email: 'b@example.test',
        role: 'ADMIN',
      },
    },
  ])('withdraws verification for an invalid refresh (%j)', async (change) => {
    const { authority, custody } = await activeAuthority();
    const before = await authority.read();
    if (before.kind !== 'ok' || !before.record) throw new Error('setup');
    expect(before.provenance?.credential).toBe('accepted');
    const changed = jest.fn();
    const stop = authority.onAccountChanged(changed);
    try {
      await expect(
        authority.saveIfUnchanged(entry(change), before.record, {
          probe: authority.beginProbe(),
        }),
      ).resolves.toMatchObject({ kind: 'invalid' });
      const after = await authority.read();
      expect(after.kind === 'ok' && after.record?.accountId).toBe('account-1');
      expect(after.kind === 'ok' && after.provenance).toMatchObject({
        credential: 'unknown',
        membership: false,
        policy: false,
      });
      expect(changed).toHaveBeenCalled();
      const restarted = createCloudAccountAuthority({ custody });
      const persisted = await restarted.read();
      expect(persisted.kind === 'ok' && persisted.provenance).toMatchObject({
        credential: 'unknown',
        membership: false,
        policy: false,
      });
      const access = await readCloudAccountAccess(authority);
      if (access.kind !== 'ok') throw new Error('setup');
      expect(
        access.modelPolicy({
          owner: { kind: 'organization', organizationId: ORG },
          scope: 'owner',
          governedModelId: 'claude-sonnet-4-6',
        }).kind,
      ).not.toBe('allowed');
      // A fresh, valid probe can restore this generation's verification.
      await authority.saveIfUnchanged(before.record.entry, before.record, {
        probe: authority.beginProbe(),
      });
      const restored = await authority.read();
      expect(restored.kind === 'ok' && restored.provenance?.credential).toBe(
        'accepted',
      );
    } finally {
      stop();
    }
  });

  it('does not let an older identity mismatch withdraw a newer probe', async () => {
    const { authority } = await activeAuthority();
    const before = await authority.read();
    if (before.kind !== 'ok' || !before.record) throw new Error('setup');
    const stale = authority.beginProbe();
    await authority.saveIfUnchanged(before.record.entry, before.record, {
      probe: authority.beginProbe(),
    });
    await expect(
      authority.saveIfUnchanged(
        entry({
          account: {
            id: 'another-account',
            name: 'B',
            email: 'b@example.test',
            role: 'ADMIN',
          },
        }),
        before.record,
        { probe: stale },
      ),
    ).resolves.toMatchObject({ kind: 'superseded' });
    const after = await authority.read();
    expect(after.kind === 'ok' && after.provenance?.credential).toBe(
      'accepted',
    );
  });

  it('advances daemon membership only from an authoritative refresh', async () => {
    const { authority } = await activeAuthority(
      entry({
        organizations: [
          { id: ORG, name: 'Org' },
          { id: OTHER_ORG, name: 'Other' },
        ],
      }),
    );
    const read = await authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('setup');
    const next = {
      ...read.record.entry,
      organizations: [{ id: ORG, name: 'Org' }],
      updatedAt: '2026-11-05T00:00:00.000Z',
    };
    const notAuthoritative = await authority.saveIfUnchanged(
      next,
      read.record,
      {
        organizationsRefreshed: false,
      },
    );
    if (notAuthoritative.kind !== 'saved')
      throw new Error(notAuthoritative.kind);
    expect(
      Reflect.get(
        Object(notAuthoritative.record.entry.organizationAccessLossState),
        'pending',
      ),
    ).toEqual([]);
    const authoritative = await authority.saveIfUnchanged(
      { ...next, updatedAt: '2026-11-06T00:00:00.000Z' },
      notAuthoritative.record,
      { organizationsRefreshed: true },
    );
    if (authoritative.kind !== 'saved') throw new Error(authoritative.kind);
    // The stored membership snapshot already dropped OTHER_ORG, so the held
    // membership checkpoint decides the last authoritative membership.
    const state: unknown =
      authoritative.record.entry.organizationAccessLossState;
    expect(Reflect.get(Object(state), 'organizationIds')).toEqual([ORG]);
    expect(Reflect.get(Object(state), 'pending')).toEqual([]);
    // A refreshed but unverified list (a missing one normalizes to []) keeps it.
    const unverified = await authority.saveIfUnchanged(
      {
        ...next,
        organizations: [],
        organizationsVerified: false,
        updatedAt: '2026-11-07T00:00:00.000Z',
      },
      authoritative.record,
      { organizationsRefreshed: true },
    );
    if (unverified.kind !== 'saved') throw new Error(unverified.kind);
    expect(unverified.record.entry.organizationAccessLossState).toMatchObject({
      organizationIds: [ORG],
    });
    // A reconnecting client must not restore removed membership or lose the
    // daemon's membership checkpoint, even with the same credential and identity.
    await expect(
      replaceAccount(authority, read.record.entry),
    ).resolves.toMatchObject({ kind: 'unchanged' });
    const reconnected = await authority.read();
    expect(reconnected.kind === 'ok' && reconnected.record?.entry).toEqual(
      unverified.record.entry,
    );
    // A client's key rotation for the same identity carries only its own
    // organization claims: the daemon's checkpoint stays.
    await expect(
      replaceAccount(authority, {
        ...read.record.entry,
        apiKey: 'csk-rotated',
        organizations: [],
        organizationAccessLossState: undefined,
      }),
    ).resolves.toMatchObject({ kind: 'provisioned' });
    const rotated = await authority.read();
    expect(
      rotated.kind === 'ok' &&
        rotated.record?.entry.organizationAccessLossState,
    ).toMatchObject({ organizationIds: [ORG] });
  });

  it('fences broker rejections to the credential generation that was used', async () => {
    const { authority } = await activeAuthority();
    const first = await authority.read();
    if (first.kind !== 'ok') throw new Error('setup');
    await replaceAccount(authority, entry({ apiKey: 'csk-rotated' }));
    // A late 401 for the replaced credential must not expire the new one.
    expect(
      await authority.recordCredentialRejected(first.credentialGeneration),
    ).toEqual({
      kind: 'stale',
    });
    const current = await authority.read();
    expect(current.kind === 'ok' && current.sessionExpired).toBe(false);
    if (current.kind !== 'ok') throw new Error('setup');
    expect(
      await authority.recordCredentialRejected(current.credentialGeneration),
    ).toEqual({ kind: 'recorded' });
    const expired = await authority.read();
    expect(expired.kind === 'ok' && expired.sessionExpired).toBe(true);
    // Explicit replacement clears the expiry: no refresh grant is involved.
    await replaceAccount(authority, entry({ apiKey: 'csk-signed-in-again' }));
    const renewed = await authority.read();
    expect(renewed.kind === 'ok' && renewed.sessionExpired).toBe(false);
  });

  it('notifies changes and confirmations separately', async () => {
    const { authority, changes, confirmations } = await activeAuthority();
    const read = await authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('setup');
    await authority.saveIfUnchanged(
      { ...read.record.entry, updatedAt: '2026-11-07T00:00:00.000Z' },
      read.record,
    );
    expect(confirmations).toHaveLength(1);
    expect(changes).toHaveLength(0);
    await replaceAccount(authority, null);
    expect(changes).toEqual([null]);
  });
});

describe('cloud account authority: unreadable reset', () => {
  it('resets only an unreadable active custody, which stays active', async () => {
    const { custody: held, memory } = custodyFor();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    await held.commit({
      expected: null,
      state: 'active',
      credentialGeneration: 1,
      record: readCloudAccountRecord(entry()),
    });
    const authority = createCloudAccountAuthority({ custody: held });
    expect((await authority.resetUnreadable()).kind).toBe('not-needed');
    const [metadata] = await memory.repository.list();
    if (!metadata) throw new Error('setup');
    await writer.put({
      ref: metadata.ref,
      expectedRevision: metadata.revision,
      label: metadata.label,
      material: new TextEncoder().encode('not json'),
      expiresAt: null,
      idempotencyKey: 'corrupt-it',
    });
    expect((await authority.read()).kind).toBe('unavailable');
    expect(await authority.resetUnreadable()).toEqual({ kind: 'reset' });
    expect(await authority.read()).toMatchObject({ kind: 'ok', record: null });
    const after = await held.read();
    expect(after.kind === 'ok' && after.document.state).toBe('active');
    // A late broker rejection against the unreadable generation is ignored.
    expect(await authority.recordCredentialRejected(1)).toEqual({
      kind: 'stale',
    });
  });

  it('replaces a durable entry that fails its integrity check, keeping the family present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cloud-account-corrupt-'));
    const slots = createFakeSecretProtection({ backend: 'macos_keychain' });
    let vault = durableVault(root, true, slots);
    try {
      const original = createCloudAccountAuthority({
        custody: durableCustody(vault),
      });
      await expect(original.provision(entry(), null)).resolves.toMatchObject({
        kind: 'provisioned',
      });
      const before = await original.read();
      if (before.kind !== 'ok') throw new Error(before.kind);
      await vault.dispose();
      const database = new DatabaseSync(join(root, 'vault', VAULT_STORE_FILE));
      try {
        // Flip the stored authentication tag: the vault now reads it corrupt.
        database
          .prepare(
            'UPDATE vault_entries SET tag = randomblob(length(tag)) WHERE family = ?',
          )
          .run(CLOUD_ACCOUNT_VAULT_FAMILY);
      } finally {
        database.close();
      }
      vault = durableVault(root, true, slots);
      const custody = durableCustody(vault);
      const authority = createCloudAccountAuthority({ custody });
      await expect(authority.read()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      await expect(authority.resetUnreadable()).resolves.toEqual({
        kind: 'reset',
      });
      const [only, ...others] = (
        await (await vault.repository()).list()
      ).filter((metadata) => metadata.family === CLOUD_ACCOUNT_VAULT_FAMILY);
      expect(others).toEqual([]);
      expect(only?.state).toBe('available');
      const after = await authority.read();
      if (after.kind !== 'ok') throw new Error(after.kind);
      expect(after.record).toBeNull();
      expect(after.credentialGeneration).toBeGreaterThan(
        before.credentialGeneration,
      );
      // A late rejection for the corrupt generation cannot touch the new record.
      await expect(
        authority.recordCredentialRejected(before.credentialGeneration),
      ).resolves.toEqual({ kind: 'stale' });
      // Sign-in works again, and the reset survives a restart.
      await expect(
        authority.provision(
          entry({ apiKey: 'csk-after-reset' }),
          null,
          undefined,
          after.credentialGeneration,
        ),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      await vault.dispose();
      vault = durableVault(root, true, slots);
      await expect(
        createCloudAccountAuthority({ custody: durableCustody(vault) }).read(),
      ).resolves.toMatchObject({
        kind: 'ok',
        record: { apiKey: 'csk-after-reset' },
      });
    } finally {
      await vault.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cloud account key probe', () => {
  it.each(['\rcsk-secret-hidden', '\ncsk-secret-hidden', 'csk-secreté'])(
    'keeps a refused header offline without calling the account endpoint (%j)',
    async (apiKey) => {
      // Read each request at fetch time: Headers instances serialize to {}.
      // Request merges input and init headers as fetch does.
      const requests: {
        url: string;
        authorization: string | null;
        headers: [string, string][];
      }[] = [];
      const fetcher: typeof fetch = (input, init) => {
        let request: Request;
        try {
          request = new Request(input, init);
        } catch {
          // fetch would refuse it too; record it so the assertion names it.
          requests.push({
            url: 'unconstructible request',
            authorization: null,
            headers: [],
          });
          return Promise.reject(new TypeError('invalid request'));
        }
        requests.push({
          url: request.url,
          authorization: request.headers.get('authorization'),
          headers: [...request.headers.entries()],
        });
        return Promise.resolve(
          new Response(JSON.stringify({ capabilities: ['account-v1'] }), {
            status: 200,
          }),
        );
      };
      await expect(
        probeCloudAccount(
          {
            fetch: fetcher,
            baseUrl: () => 'https://cloud.example.test',
            wellKnownPath: '/.well-known/canopy',
            accountPath: '/account',
          },
          apiKey,
        ),
      ).resolves.toEqual({ kind: 'offline' });
      expect(requests).toEqual([
        {
          url: 'https://cloud.example.test/.well-known/canopy',
          authorization: null,
          headers: [['accept', 'application/json']],
        },
      ]);
    },
  );

  it('classifies probe responses like the desktop probe', async () => {
    const responses: Record<string, { status: number; body: unknown }> = {
      '/wk': { status: 200, body: { capabilities: ['account-v1'] } },
      '/account': { status: 401, body: { error: 'Invalid API key' } },
    };
    const seen: (string | null)[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push(new Headers(init?.headers).get('authorization'));
      const response = responses[url.pathname];
      return Promise.resolve(
        new Response(JSON.stringify(response?.body ?? null), {
          status: response?.status ?? 500,
        }),
      );
    };
    const options = {
      fetch: fetcher,
      baseUrl: (): string => 'https://cloud.example.test',
      wellKnownPath: '/wk',
      accountPath: '/account',
    };
    expect(await probeCloudAccount(options, 'csk-first')).toEqual({
      kind: 'rejected',
    });
    responses['/account'] = {
      status: 403,
      body: { error: 'User account is not active' },
    };
    expect(await probeCloudAccount(options, 'csk-first')).toEqual({
      kind: 'forbidden',
    });
    responses['/account'] = { status: 503, body: null };
    expect(await probeCloudAccount(options, 'csk-first')).toEqual({
      kind: 'offline',
    });
    responses['/account'] = {
      status: 200,
      body: { capabilities: ['x'], account: { id: 'a' } },
    };
    expect(await probeCloudAccount(options, 'csk-first')).toMatchObject({
      kind: 'authenticated',
      capabilities: ['x'],
    });
    // The well-known request never carries the bearer.
    expect(seen.filter((value, index) => index % 2 === 0)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(
      await probeCloudAccount(
        {
          ...options,
          baseUrl: () => {
            throw new Error('local-only');
          },
        },
        'csk-first',
      ),
    ).toEqual({ kind: 'offline' });
  });

  it.each([401, 403])(
    'classifies account HTTP %s before reading a broken or unending body',
    async (status) => {
      for (const broken of [true, false]) {
        const cancelled = jest.fn();
        const body = new ReadableStream({
          start: (controller): void => {
            if (broken) controller.error(new Error('Body read failed'));
          },
          cancel: (): void => {
            cancelled();
            throw new Error('Body cleanup failed');
          },
        });
        const fetcher: typeof fetch = (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return Promise.resolve(
            url.pathname === '/wk'
              ? new Response('{"capabilities":[]}')
              : new Response(body, { status }),
          );
        };
        await expect(
          probeCloudAccount(
            {
              fetch: fetcher,
              baseUrl: () => 'https://cloud.example.test',
              wellKnownPath: '/wk',
              accountPath: '/account',
            },
            'csk-first',
          ),
        ).resolves.toEqual({ kind: status === 401 ? 'rejected' : 'forbidden' });
        if (!broken) expect(cancelled).toHaveBeenCalled();
      }
    },
  );
});

describe('cloud account refresh in the daemon', () => {
  const builder: CloudAccountSnapshotBuilder = ({
    current,
    capabilities,
    payload,
    updatedAt,
  }) => {
    const organizations: unknown = Reflect.get(
      Object(payload),
      'organizations',
    );
    return {
      entry: {
        ...current.entry,
        capabilities: [...capabilities],
        organizations: Array.isArray(organizations) ? organizations : [],
        enforcedSettings:
          Reflect.get(Object(payload), 'enforcedSettings') ?? [],
        updatedAt,
      },
      organizationsRefreshed: Array.isArray(organizations),
      billingStatesRefreshed: false,
    };
  };

  it('applies an authenticated re-probe and queues a refresh requested mid-probe behind it', async () => {
    const { authority, changes } = await activeAuthority();
    const answers: PromiseWithResolvers<CloudAccountProbe>[] = [];
    let running = 0;
    let overlapped = false;
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: builder,
      probe: async (): Promise<CloudAccountProbe> => {
        running += 1;
        if (running > 1) overlapped = true;
        const answer = Promise.withResolvers<CloudAccountProbe>();
        answers.push(answer);
        try {
          return await answer.promise;
        } finally {
          running -= 1;
        }
      },
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    const authenticated: CloudAccountProbe = {
      kind: 'authenticated',
      capabilities: ['account-v1', 'teams-v1'],
      payload: { organizations: [{ id: OTHER_ORG, name: 'Moved' }] },
    };
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const first = refresher.refresh();
    await settle();
    expect(answers).toHaveLength(1);
    // Requested while the first probe runs: one queued probe serves both.
    const second = refresher.refresh();
    const third = refresher.refresh();
    await settle();
    expect(answers).toHaveLength(1);
    answers[0]?.resolve(authenticated);
    await expect(first).resolves.toMatchObject({ outcome: 'applied' });
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]?.resolve(authenticated);
    await expect(Promise.all([second, third])).resolves.toMatchObject([
      { outcome: 'applied' },
      { outcome: 'applied' },
    ]);
    expect(answers).toHaveLength(2);
    expect(overlapped).toBe(false);
    const read = await authority.read();
    expect(read.kind === 'ok' && read.record?.organizationIds).toEqual([
      OTHER_ORG,
    ]);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("saves a queued refresh's success after the running probe answers 403", async () => {
    const { authority } = await activeAuthority();
    const answers: PromiseWithResolvers<CloudAccountProbe>[] = [];
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: buildCloudAccountSnapshot,
      probe: (): Promise<CloudAccountProbe> => {
        const answer = Promise.withResolvers<CloudAccountProbe>();
        answers.push(answer);
        return answer.promise;
      },
    });
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const first = refresher.refresh();
    await settle();
    const queued = refresher.refresh();
    await settle();
    expect(answers).toHaveLength(1);
    answers[0]?.resolve({ kind: 'forbidden' });
    await expect(first).resolves.toMatchObject({ outcome: 'forbidden' });
    await expect(authority.read()).resolves.toMatchObject({
      provenance: { membership: false, policy: false },
    });
    await settle();
    expect(answers).toHaveLength(2);
    // A 403 orders observations only: the queued probe began after it.
    answers[1]?.resolve({
      kind: 'authenticated',
      capabilities: ['account-v1'],
      payload: {
        account: entry().account,
        organizations: entry().organizations,
        enforcedSettings: [],
      },
    });
    await expect(queued).resolves.toMatchObject({ outcome: 'applied' });
    await expect(authority.read()).resolves.toMatchObject({
      sessionExpired: false,
      provenance: { credential: 'accepted', membership: true, policy: true },
    });
    await refresher.dispose();
  });

  it('keeps the snapshot when offline or forbidden, and expires only on 401', async () => {
    const { authority } = await activeAuthority();
    let next: CloudAccountProbe = { kind: 'offline' };
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: builder,
      probe: () => Promise.resolve(next),
    });
    expect((await refresher.refresh()).outcome).toBe('offline');
    next = { kind: 'forbidden' };
    expect((await refresher.refresh()).outcome).toBe('forbidden');
    let read = await authority.read();
    expect(read.kind === 'ok' && read.sessionExpired).toBe(false);
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
    next = { kind: 'rejected' };
    expect((await refresher.refresh()).outcome).toBe('unauthenticated');
    read = await authority.read();
    expect(read.kind === 'ok' && read.sessionExpired).toBe(true);
    // The credential stays: only explicit sign-in or disconnect replaces it.
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
  });

  // Each sign-in below probes twice: its first answer predates a committed
  // result for the held key, so it re-verifies before installing anything.
  const lateSignIn = (
    authority: CloudAccountAuthority,
    name: string,
    reverify: CloudAccountAuthorityVerify,
  ): {
    readonly probing: Promise<void>;
    readonly release: () => void;
    readonly probes: () => number;
    readonly result: ReturnType<CloudAccountAuthority['connectVerified']>;
  } => {
    const probing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let probes = 0;
    const result = authority.connectVerified({
      commandId: createHash('sha256').update(name).digest('hex'),
      credentialDigest: createHash('sha256').update('csk-first').digest('hex'),
      signal: new AbortController().signal,
      verify: async (...args) => {
        probes += 1;
        if (probes > 1) return reverify(...args);
        probing.resolve();
        await gate.promise;
        // Cloud's answer when this probe ran: the snapshot before the change.
        return entry();
      },
    });
    return {
      probing: probing.promise,
      release: () => gate.resolve(),
      probes: () => probes,
      result,
    };
  };

  it.each(['rejected', 'accepted'] as const)(
    'answers a same-key sign-in from a fresh probe when a 401 is persisted while it probed (%s)',
    async (cloud) => {
      const { authority, custody } = await activeAuthority();
      const refresher = createCloudAccountRefresher({
        authority,
        buildSnapshot: buildCloudAccountSnapshot,
        probe: () => Promise.resolve({ kind: 'rejected' }),
      });
      // The re-verification models the module: a 401 is recorded, then thrown.
      const signIn = lateSignIn(
        authority,
        `sign-in-across-401-${cloud}`,
        async (_previous, generation, probe) => {
          if (cloud === 'accepted') return entry();
          await authority.recordCredentialRejected(
            generation,
            'rejected',
            probe,
          );
          throw new Error('keyRejected');
        },
      );
      await signIn.probing;
      const refused = {
        sessionExpired: true,
        provenance: { membership: false, policy: false },
      };
      // A refresh begun after the sign-in's probe records the 401 durably.
      await expect(refresher.refresh()).resolves.toMatchObject({
        outcome: 'unauthenticated',
      });
      await expect(authority.read()).resolves.toMatchObject(refused);
      signIn.release();
      if (cloud === 'rejected') {
        // The older acceptance never replaces the newer refusal.
        await expect(signIn.result).rejects.toThrow('keyRejected');
        await expect(authority.read()).resolves.toMatchObject(refused);
        await expect(custody.read()).resolves.toMatchObject({
          document: { provenance: { credential: 'rejected' } },
        });
      } else {
        // Cloud accepts the key again: the fresh answer is the newest.
        await expect(signIn.result).resolves.toEqual({
          kind: 'provisioned',
          credentialGeneration: 1,
        });
        await expect(authority.read()).resolves.toMatchObject({
          credentialGeneration: 1,
          sessionExpired: false,
          provenance: {
            credential: 'accepted',
            membership: true,
            policy: true,
          },
        });
      }
      expect(signIn.probes()).toBe(2);
      await refresher.dispose();
    },
  );

  it('keeps a newer refresh that removed a membership over a late same-key sign-in', async () => {
    const { authority } = await activeAuthority();
    const removed = entry({ organizations: [] });
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: builder,
      probe: () =>
        Promise.resolve({
          kind: 'authenticated',
          capabilities: ['account-v1'],
          payload: { organizations: [] },
        }),
    });
    const signIn = lateSignIn(authority, 'late-sign-in-membership', () =>
      Promise.resolve(removed),
    );
    await signIn.probing;
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'applied',
    });
    const organizations = async (): Promise<unknown> => {
      const read = await authority.read();
      return read.kind === 'ok' && read.record?.organizationIds;
    };
    await expect(organizations()).resolves.toEqual([]);
    signIn.release();
    // The stale answer still listed the organization; the fresh one does not.
    await expect(signIn.result).resolves.toEqual({
      kind: 'provisioned',
      credentialGeneration: 1,
    });
    await expect(organizations()).resolves.toEqual([]);
    expect(signIn.probes()).toBe(2);
    await expect(authority.read()).resolves.toMatchObject({
      provenance: { credential: 'accepted', membership: true, policy: true },
    });
    await refresher.dispose();
  });

  it('installs no stale verified policy when a newer 403 lands while a same-key sign-in probes', async () => {
    const { authority, custody } = await activeAuthority();
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: buildCloudAccountSnapshot,
      probe: () => Promise.resolve({ kind: 'forbidden' }),
    });
    const signIn = lateSignIn(
      authority,
      'late-sign-in-forbidden',
      async (_previous, generation, probe) => {
        await authority.recordCredentialRejected(
          generation,
          'forbidden',
          probe,
        );
        throw new Error('keyRejected');
      },
    );
    await signIn.probing;
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'forbidden',
    });
    const withdrawn = {
      sessionExpired: false,
      provenance: { membership: false, policy: false },
    };
    await expect(authority.read()).resolves.toMatchObject(withdrawn);
    signIn.release();
    await expect(signIn.result).rejects.toThrow('keyRejected');
    expect(signIn.probes()).toBe(2);
    await expect(authority.read()).resolves.toMatchObject(withdrawn);
    await expect(custody.read()).resolves.toMatchObject({
      document: { provenance: { credential: 'forbidden' } },
    });
    await refresher.dispose();
  });

  it('notifies authorization subscribers when an unchanged refresh restores policy after a 403', async () => {
    const { authority, changes, confirmations } = await activeAuthority();
    const port = createCloudAccountAuthorizationPort(authority);
    const authenticated: CloudAccountProbe = {
      kind: 'authenticated',
      capabilities: ['account-v1'],
      payload: {
        account: entry().account,
        organizations: entry().organizations,
        enforcedSettings: [],
      },
    };
    let next: CloudAccountProbe = authenticated;
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: buildCloudAccountSnapshot,
      probe: () => Promise.resolve(next),
    });
    // Settle the stored entry on the refresh's own snapshot first.
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'applied',
    });
    const notified = jest.fn();
    port.onAccountChanged(notified);
    next = { kind: 'forbidden' };
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'forbidden',
    });
    expect(notified).toHaveBeenCalled();
    notified.mockClear();
    const changed = changes.length;
    const confirmed = confirmations.length;
    next = authenticated;
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'applied',
    });
    // The entry is unchanged, so only verification recovered.
    expect(changes).toHaveLength(changed);
    expect(confirmations).toHaveLength(confirmed + 1);
    expect(notified).toHaveBeenCalledTimes(1);
    await expect(authority.read()).resolves.toMatchObject({
      provenance: { credential: 'accepted', membership: true, policy: true },
    });
    await refresher.dispose();
    port.dispose();
  });

  it.each([
    {},
    { id: '  ', name: 'A', email: 'a@example.test', role: 'ADMIN' },
    { id: 'account-1', name: 'A', email: 'a@example.test', role: 'OWNER' },
  ])(
    'withdraws verification instead of applying an unidentifiable account (%j)',
    async (account) => {
      const { authority } = await activeAuthority();
      const refresher = createCloudAccountRefresher({
        authority,
        buildSnapshot: buildCloudAccountSnapshot,
        probe: () =>
          Promise.resolve({
            kind: 'authenticated',
            capabilities: ['account-v1'],
            payload: { account, organizations: [], enforcedSettings: [] },
          }),
      });
      await expect(refresher.refresh()).resolves.toMatchObject({
        outcome: 'invalid-snapshot',
      });
      const read = await authority.read();
      expect(read.kind === 'ok' && read.record?.accountId).toBe('account-1');
      expect(read.kind === 'ok' && read.record?.organizationIds).toEqual([ORG]);
      expect(read).toMatchObject({ provenance: { credential: 'unknown' } });
      expect(
        evaluateCloudModelPolicy({
          read,
          owner: { kind: 'personal' },
          scope: 'union',
          governedModelId: 'ok-model',
        }).kind,
      ).toBe('unknown');
    },
  );

  it('takes verification from each refresh response, never from stored flags', async () => {
    const { authority } = await activeAuthority(
      entry({ organizationsVerified: false, modelPolicyVerified: false }),
    );
    let organizations: unknown = entry().organizations;
    let enforcedSettings: unknown = [];
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: buildCloudAccountSnapshot,
      probe: () =>
        Promise.resolve({
          kind: 'authenticated',
          capabilities: ['account-v1'],
          payload: {
            account: entry().account,
            organizations,
            enforcedSettings,
          },
        }),
    });
    const held = async (): Promise<unknown> => {
      const read = await authority.read();
      if (read.kind !== 'ok' || !read.record) throw new Error(read.kind);
      return {
        organizationsVerified: read.record.entry.organizationsVerified,
        modelPolicyVerified: read.record.entry.modelPolicyVerified,
        provenance: read.provenance,
      };
    };
    await expect(refresher.refresh()).resolves.toMatchObject({
      outcome: 'applied',
    });
    await expect(held()).resolves.toMatchObject({
      organizationsVerified: true,
      modelPolicyVerified: true,
      provenance: { credential: 'accepted', membership: true, policy: true },
    });
    // A malformed list or policy this time withdraws what the last one proved.
    organizations = 'not-a-list';
    enforcedSettings = 'not-a-list';
    await refresher.refresh();
    await expect(held()).resolves.toMatchObject({
      organizationsVerified: false,
      modelPolicyVerified: false,
      provenance: { membership: false, policy: false },
    });
  });

  it('aborts and drains an in-flight refresh before disposal, without saving its late response', async () => {
    const { authority, changes } = await activeAuthority();
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const response = Promise.withResolvers<CloudAccountProbe>();
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: builder,
      probe: (_key, signal) => {
        started.resolve(signal);
        return response.promise;
      },
    });
    const refreshing = refresher.refresh();
    const signal = await started.promise;
    let drained = false;
    const disposing = refresher.dispose().then(() => {
      drained = true;
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    response.resolve({
      kind: 'authenticated',
      capabilities: [],
      payload: { organizations: [] },
    });
    await expect(refreshing).resolves.toMatchObject({ outcome: 'unavailable' });
    await disposing;
    expect(changes).toEqual([]);
    expect((await refresher.refresh()).outcome).toBe('unavailable');
    expect((await authority.read()).kind).toBe('ok');
  });

  it('does not refresh a signed-out or inactive account', async () => {
    const { authority } = await activeAuthority(null);
    const refresher = createCloudAccountRefresher({
      authority,
      buildSnapshot: builder,
      probe: () => Promise.reject(new Error('must not probe')),
    });
    expect((await refresher.refresh()).outcome).toBe('no-key');
    const { custody } = custodyFor();
    const inactive = createCloudAccountRefresher({
      authority: createCloudAccountAuthority({ custody }),
      buildSnapshot: builder,
      probe: () => Promise.reject(new Error('must not probe')),
    });
    expect((await inactive.refresh()).outcome).toBe('inactive');
  });

  it('runs periodically without any app connection and stops cleanly', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    try {
      const { authority } = await activeAuthority();
      let calls = 0;
      const refresher = createCloudAccountRefresher({
        authority,
        buildSnapshot: builder,
        probe: () => {
          calls += 1;
          return Promise.resolve({ kind: 'offline' });
        },
      });
      const stop = refresher.start(60_000);
      // One unref'd setInterval per started refresher, at the given period.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(60_000);
      expect(() => refresher.start(10)).toThrow(RangeError);
      await jest.advanceTimersByTimeAsync(180_000);
      stop();
      const seen = calls;
      await jest.advanceTimersByTimeAsync(180_000);
      expect(seen).toBeGreaterThanOrEqual(3);
      expect(calls).toBe(seen);
    } finally {
      setIntervalSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('work-owner policy and AI Credits availability', () => {
  it.each(['balance', 'subscription-batch', 'pool', 'subscription'])(
    'drops a late %s 401 superseded by a successful account refresh',
    async (operation) => {
      const { authority } = await activeAuthority();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{
        status: number;
        body: unknown;
      }>();
      const request: CloudJsonRequest = ({ path }) => {
        const reject =
          operation === 'balance'
            ? path.endsWith('/balance')
            : operation === 'pool'
              ? path.endsWith('/spendable')
              : path.endsWith('/subscription');
        if (reject) {
          started.resolve();
          return pending.promise;
        }
        return Promise.resolve({
          status: 200,
          body: { credits: 5, active: true, hasSpendableHeadroom: true },
        });
      };
      const service = createCloudAiCreditsAvailability({
        authority,
        request,
        organizationNamespace: 'canopy',
      });
      const answer =
        operation === 'subscription'
          ? service.subscription()
          : service.load({ kind: 'organization', organizationId: ORG });
      await started.promise;
      const current = await authority.read();
      if (current.kind !== 'ok' || !current.record)
        throw new Error('No account');
      await expect(
        authority.saveIfUnchanged(current.record.entry, current.record, {
          probe: authority.beginProbe(),
        }),
      ).resolves.toMatchObject({ kind: 'saved' });
      const port = createCloudAccountAuthorizationPort(authority);
      const lease = await port.lease(current.credentialGeneration);
      const headers = new Headers();
      lease.apply(headers);
      try {
        pending.resolve({ status: 401, body: null });
        await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
        await expect(authority.read()).resolves.toMatchObject({
          sessionExpired: false,
          provenance: { credential: 'accepted' },
        });
        expect(headers.get('authorization')).toBe('Bearer csk-first');
      } finally {
        port.dispose();
      }
    },
  );

  const governed = entry({
    enforcedSettings: [
      {
        organizationId: ORG,
        organizationName: 'Org',
        policies: [
          {
            kind: 'model-policy',
            blockedModelIds: ['blocked-model'],
            reviewedModelIds: ['ok-model'],
          },
        ],
      },
    ],
  });

  it('never turns unknown policy into permission', async () => {
    const { custody } = custodyFor();
    const inactive = await createCloudAccountAuthority({ custody }).read();
    expect(
      evaluateCloudModelPolicy({
        read: inactive,
        owner: { kind: 'personal' },
        scope: 'union',
        governedModelId: 'ok-model',
      }),
    ).toEqual({ kind: 'unknown', reason: 'inactive' });
    expect(
      evaluateCloudModelPolicy({
        read: { kind: 'unavailable', reason: 'locked' },
        owner: { kind: 'personal' },
        scope: 'owner',
        governedModelId: 'ok-model',
      }).kind,
    ).toBe('unknown');
  });

  it('never grants policy from a rejected account snapshot', async () => {
    const { authority } = await activeAuthority();
    await authority.recordCredentialRejected(1);
    expect(
      evaluateCloudModelPolicy({
        read: await authority.read(),
        owner: { kind: 'personal' },
        scope: 'union',
        governedModelId: 'claude-sonnet',
      }),
    ).toEqual({ kind: 'unknown', reason: 'session-expired' });
  });

  it('keeps malformed enforcement unknown through tolerant refresh normalization', async () => {
    const { authority, custody } = await activeAuthority();
    const policy = {
      kind: 'model-policy',
      blockedModelIds: [],
      reviewedModelIds: ['ok-model'],
    };
    // Each refresh carries an authoritative organization list, so membership
    // is verified and only the enforcement payload decides the answer.
    const refreshWith = async (
      enforcedSettings: unknown[],
    ): Promise<ReturnType<typeof evaluateCloudModelPolicy>> => {
      const current = await authority.read();
      if (current.kind !== 'ok' || !current.record) throw new Error('account');
      const built = buildCloudAccountSnapshot({
        current: current.record,
        capabilities: [],
        updatedAt: '2026-11-18T00:00:00.000Z',
        payload: {
          account: current.record.entry.account,
          organizations: current.record.entry.organizations,
          enforcedSettings,
        },
      });
      if (!built) throw new Error('snapshot');
      expect(built.organizationsRefreshed).toBe(true);
      await expect(
        authority.saveIfUnchanged(built.entry, current.record, {
          probe: authority.beginProbe(),
          organizationsRefreshed: built.organizationsRefreshed,
        }),
      ).resolves.toMatchObject({ kind: 'saved' });
      // The saved snapshot's own proof: membership holds either way.
      await expect(custody.read()).resolves.toMatchObject({
        document: { provenance: { membership: true } },
      });
      return evaluateCloudModelPolicy({
        read: await authority.read(),
        owner: { kind: 'personal' },
        scope: 'union',
        governedModelId: 'ok-model',
      });
    };
    await expect(
      refreshWith([
        { organizationId: ORG, organizationName: 'Org', policies: [policy] },
      ]),
    ).resolves.toEqual({ kind: 'allowed' });
    // Only the governing organization is missing.
    await expect(
      refreshWith([{ organizationName: 'Org', policies: [policy] }]),
    ).resolves.toEqual({ kind: 'unknown', reason: 'policy-unavailable' });
    await expect(custody.read()).resolves.toMatchObject({
      document: {
        provenance: { policy: false },
        record: { modelPolicyEnforcementUnavailable: true },
      },
    });
  });

  it('withdraws policy after a refresh save that may not have landed, until a verified sign-in commits', async () => {
    const { authority, custody } = await activeAuthority(governed);
    const okModel = async (): Promise<string> =>
      evaluateCloudModelPolicy({
        read: await authority.read(),
        owner: { kind: 'organization', organizationId: ORG },
        scope: 'owner',
        governedModelId: 'ok-model',
      }).kind;
    expect(await okModel()).toBe('allowed');
    const current = await authority.read();
    if (current.kind !== 'ok' || !current.record) throw new Error('account');
    const spy = jest
      .spyOn(custody, 'commit')
      .mockResolvedValueOnce({ kind: 'outcome_unknown' });
    try {
      await expect(
        authority.saveIfUnchanged(current.record.entry, current.record, {
          probe: authority.beginProbe(),
        }),
      ).resolves.toEqual({ kind: 'unavailable', reason: 'outcome_unknown' });
    } finally {
      spy.mockRestore();
    }
    expect(await okModel()).toBe('unknown');
    const digest = (value: string): string =>
      createHash('sha256').update(value).digest('hex');
    await expect(
      authority.connectVerified({
        commandId: digest('after-unknown-refresh'),
        credentialDigest: digest('csk-first'),
        signal: new AbortController().signal,
        verify: () => Promise.resolve(governed),
      }),
    ).resolves.toMatchObject({ kind: 'provisioned' });
    expect(await okModel()).toBe('allowed');
  });

  it('does not turn loss of organization membership into unrestricted native execution', async () => {
    const { authority } = await activeAuthority(entry({ organizations: [] }));
    expect(
      evaluateCloudModelPolicy({
        read: await authority.read(),
        owner: { kind: 'organization', organizationId: ORG },
        scope: 'owner',
        governedModelId: 'ok-model',
      }),
    ).toEqual({ kind: 'unknown', reason: 'owner-unknown' });
  });

  it('does not trust normalized client enforcement carrying a degradation marker', async () => {
    const { authority } = await activeAuthority(
      entry({ enforcedSettings: [], telemetryEnforcementUnavailable: true }),
    );
    expect(
      evaluateCloudModelPolicy({
        read: await authority.read(),
        owner: { kind: 'personal' },
        scope: 'union',
        governedModelId: 'ok-model',
      }),
    ).toEqual({ kind: 'unknown', reason: 'policy-unavailable' });
  });

  it('blocks denied and unreviewed models for the governing organization', async () => {
    const { authority } = await activeAuthority(governed);
    const read = await authority.read();
    const answer = (
      model: string,
      scope: 'owner' | 'union',
      personal = false,
    ): string =>
      evaluateCloudModelPolicy({
        read,
        owner: personal
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId: ORG },
        scope,
        governedModelId: model,
      }).kind;
    expect(answer('ok-model', 'owner')).toBe('allowed');
    expect(answer('blocked-model', 'owner')).toBe('blocked');
    expect(answer('unreviewed-model', 'owner')).toBe('blocked');
    expect(answer('unreviewed-model', 'owner', true)).toBe('allowed');
    // Union scope (owner scoping off) applies every org's policy to personal work.
    expect(answer('unreviewed-model', 'union', true)).toBe('blocked');
  });

  function availabilityWith(
    authority: CloudAccountAuthority,
    responses: Record<string, { status: number; body: unknown }>,
    seen: string[] = [],
  ): ReturnType<typeof createCloudAiCreditsAvailability> {
    // The app reads the personal ledger with its subscription; a fixture
    // models a subscription failure explicitly.
    const answers: Record<string, { status: number; body: unknown }> = {
      subscription: { status: 200, body: { active: true } },
      ...responses,
    };
    const request: CloudJsonRequest = ({ path, apiKey, headers }) => {
      seen.push(`${path} ${apiKey} ${JSON.stringify(headers ?? {})}`);
      const response = answers[path.split('/').slice(-1)[0] ?? ''];
      return response
        ? Promise.resolve(response)
        : Promise.reject(new Error('offline'));
    };
    return createCloudAiCreditsAvailability({
      authority,
      request,
      organizationNamespace: 'canopy',
    });
  }

  it('answers spendable, exhausted and unknown from live reads', async () => {
    const { authority } = await activeAuthority();
    const seen: string[] = [];
    const personal = availabilityWith(
      authority,
      { balance: { status: 200, body: { credits: 5 } } },
      seen,
    );
    expect(await personal.load({ kind: 'personal' })).toMatchObject({
      kind: 'spendable',
      source: 'personal',
      accountId: 'account-1',
    });
    expect(seen[0]).toContain('x-canopy-work-owner');
    const exhausted = availabilityWith(authority, {
      balance: { status: 200, body: { credits: 0 } },
      spendable: { status: 200, body: { hasSpendableHeadroom: false } },
    });
    expect(
      await exhausted.load({ kind: 'organization', organizationId: ORG }),
    ).toEqual({ kind: 'not-spendable', reason: 'exhausted' });
    const offline = availabilityWith(authority, {
      balance: { status: 503, body: null },
    });
    expect(await offline.load({ kind: 'personal' })).toEqual({
      kind: 'unknown',
      reason: 'offline',
    });
    const revoked = availabilityWith(authority, {
      balance: { status: 401, body: null },
    });
    expect(await revoked.load({ kind: 'personal' })).toEqual({
      kind: 'unknown',
      reason: 'rejected',
    });
    // Revocation now persists. The following independent funding scenario
    // starts from a fresh verified account observation, not the refused one.
    const restored = await authority.read();
    if (restored.kind !== 'ok' || !restored.record)
      throw new Error('No account');
    await authority.saveIfUnchanged(entry(), restored.record, {
      probe: authority.beginProbe(),
      organizationsRefreshed: true,
    });
    // As in the app, another organization's work is never asked for a pool,
    // but personal credits can still fund it.
    seen.length = 0;
    expect(
      await personal.load({ kind: 'organization', organizationId: OTHER_ORG }),
    ).toMatchObject({ kind: 'spendable', source: 'personal' });
    expect(seen.some((line) => line.includes('/spendable'))).toBe(false);
    expect(await personal.load(null)).toEqual({
      kind: 'unknown',
      reason: 'owner-unknown',
    });
  });

  it('does not report another organization pool from an older server', async () => {
    const { authority } = await activeAuthority();
    const service = availabilityWith(authority, {
      balance: {
        status: 200,
        body: {
          credits: 0,
          orgPool: { orgId: OTHER_ORG },
          orgFundingAvailable: true,
        },
      },
      spendable: { status: 404, body: null },
    });
    expect(
      await service.load({ kind: 'organization', organizationId: ORG }),
    ).toEqual({ kind: 'not-spendable', reason: 'exhausted' });
  });

  it('takes organization spendability from the spendable endpoint only', async () => {
    const { authority } = await activeAuthority();
    const service = availabilityWith(authority, {
      balance: {
        status: 200,
        body: {
          credits: 0,
          eligible: false,
          orgPool: { orgId: ORG },
          orgFundingAvailable: true,
        },
      },
      spendable: { status: 200, body: { hasSpendableHeadroom: false } },
    });
    expect(
      await service.load({ kind: 'organization', organizationId: ORG }),
    ).toEqual({ kind: 'not-spendable', reason: 'exhausted' });
  });

  it('reads personal credits only with a successful subscription read, as the app does', async () => {
    const { authority } = await activeAuthority();
    const funded = { status: 200, body: { credits: 5 } };
    const failedSubscription = availabilityWith(authority, {
      balance: funded,
      subscription: { status: 503, body: null },
    });
    expect(await failedSubscription.load({ kind: 'personal' })).toEqual({
      kind: 'unknown',
      reason: 'offline',
    });
    const noCloudAccount = availabilityWith(authority, {
      balance: funded,
      subscription: { status: 404, body: null },
    });
    expect(await noCloudAccount.load({ kind: 'personal' })).toEqual({
      kind: 'not-spendable',
      reason: 'no-cloud-account',
    });
    // Established organization coverage still wins over the failed read.
    const pool = availabilityWith(authority, {
      balance: funded,
      subscription: { status: 503, body: null },
      spendable: { status: 200, body: { hasSpendableHeadroom: true } },
    });
    expect(
      await pool.load({ kind: 'organization', organizationId: ORG }),
    ).toMatchObject({ kind: 'spendable', source: 'organization' });
    // An unresolved pool read with no personal coverage stays unknown.
    const poolOffline = availabilityWith(authority, {
      balance: { status: 200, body: { credits: 0 } },
      spendable: { status: 502, body: null },
    });
    expect(
      await poolOffline.load({ kind: 'organization', organizationId: ORG }),
    ).toEqual({ kind: 'unknown', reason: 'offline' });
    // A transport failure (the fixture throws for an unanswered path) fails
    // only its own read: coverage another read established still stands.
    const balanceThrows = availabilityWith(authority, {
      spendable: { status: 200, body: { hasSpendableHeadroom: true } },
    });
    expect(
      await balanceThrows.load({ kind: 'organization', organizationId: ORG }),
    ).toMatchObject({ kind: 'spendable', source: 'organization' });
    const poolThrows = availabilityWith(authority, { balance: funded });
    expect(
      await poolThrows.load({ kind: 'organization', organizationId: ORG }),
    ).toMatchObject({ kind: 'spendable', source: 'personal' });
  });

  it('treats an expired session as unknown, not as spendable', async () => {
    const { authority } = await activeAuthority();
    const read = await authority.read();
    if (read.kind !== 'ok') throw new Error('setup');
    await authority.recordCredentialRejected(read.credentialGeneration);
    const service = availabilityWith(authority, {
      balance: { status: 200, body: { credits: 9 } },
    });
    expect(await service.load({ kind: 'personal' })).toEqual({
      kind: 'unknown',
      reason: 'session-expired',
    });
  });

  it('serves the subscription summary without exposing the response body', async () => {
    const { authority } = await activeAuthority();
    const service = availabilityWith(authority, {
      subscription: {
        status: 200,
        body: {
          active: true,
          plan: 'Pro',
          status: 'active',
          email: 'a@example.test',
        },
      },
    });
    expect(await service.subscription()).toEqual({
      kind: 'ok',
      active: true,
      plan: 'Pro',
      status: 'active',
    });
  });

  it('keeps malformed successful billing bodies unknown, not exhausted', async () => {
    const { authority } = await activeAuthority();
    const organization = { kind: 'organization', organizationId: ORG } as const;
    for (const body of [null, {}, { credits: null }, { credits: 'many' }]) {
      const service = availabilityWith(authority, {
        balance: { status: 200, body },
        spendable: { status: 200, body: { hasSpendableHeadroom: false } },
      });
      expect(await service.load({ kind: 'personal' })).toEqual({
        kind: 'unknown',
        reason: 'offline',
      });
      expect(await service.load(organization)).toEqual({
        kind: 'unknown',
        reason: 'offline',
      });
    }
    for (const body of [null, {}, { hasSpendableHeadroom: 'yes' }]) {
      const service = availabilityWith(authority, {
        balance: { status: 200, body: { credits: 0 } },
        spendable: { status: 200, body },
      });
      expect(await service.load(organization)).toEqual({
        kind: 'unknown',
        reason: 'offline',
      });
    }
    // The owner's own pool decides only with a boolean eligibility.
    const poolWithoutEligibility = availabilityWith(authority, {
      balance: { status: 200, body: { credits: 0, orgPool: { orgId: ORG } } },
      spendable: { status: 404, body: null },
    });
    expect(await poolWithoutEligibility.load(organization)).toEqual({
      kind: 'unknown',
      reason: 'offline',
    });
    // Valid coverage from the other source still stands.
    const pooled = availabilityWith(authority, {
      balance: { status: 200, body: null },
      spendable: { status: 200, body: { hasSpendableHeadroom: true } },
    });
    expect(await pooled.load(organization)).toMatchObject({
      kind: 'spendable',
      source: 'organization',
    });
    const personal = availabilityWith(authority, {
      balance: { status: 200, body: { credits: 5 } },
      spendable: { status: 200, body: null },
    });
    expect(await personal.load(organization)).toMatchObject({
      kind: 'spendable',
      source: 'personal',
    });
  });

  it.each(['subscription', 'load'] as const)(
    'does not attribute a late 404 to a replacement account (%s)',
    async (operation) => {
      const { authority } = await activeAuthority();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{
        status: number;
        body: unknown;
      }>();
      const request: CloudJsonRequest = ({ apiKey }) => {
        if (apiKey === 'csk-second')
          return Promise.resolve({
            status: 200,
            body: { credits: 5, active: true },
          });
        if (apiKey !== 'csk-first')
          return Promise.reject(new Error('Unknown account'));
        started.resolve();
        return pending.promise;
      };
      const service = createCloudAiCreditsAvailability({
        authority,
        request,
        organizationNamespace: 'canopy',
      });
      const ask = (): Promise<{ kind: string }> =>
        operation === 'subscription'
          ? service.subscription()
          : service.load({ kind: 'personal' });
      const answer = ask();
      await started.promise;
      const replacement = entry({
        apiKey: 'csk-second',
        account: {
          id: 'account-2',
          name: 'B',
          email: 'b@example.test',
          role: 'ADMIN',
        },
      });
      await expect(
        replaceAccount(authority, replacement),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      const digest = (value: string): string =>
        createHash('sha256').update(value).digest('hex');
      await expect(
        authority.connectVerified({
          commandId: digest('verify-replacement'),
          credentialDigest: digest('csk-second'),
          signal: new AbortController().signal,
          verify: () => Promise.resolve(replacement),
        }),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      // The verified replacement answers conclusively for itself.
      await expect(ask()).resolves.toMatchObject({
        kind: operation === 'subscription' ? 'ok' : 'spendable',
      });
      pending.resolve({ status: 404, body: null });
      await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
    },
  );

  it.each(['subscription', 'load'] as const)(
    'does not answer no Cloud account with a late 404 after a 401 expires the key (%s)',
    async (operation) => {
      const { authority } = await activeAuthority();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{
        status: number;
        body: unknown;
      }>();
      const service = createCloudAiCreditsAvailability({
        authority,
        request: () => {
          started.resolve();
          return pending.promise;
        },
        organizationNamespace: 'canopy',
      });
      const answer =
        operation === 'subscription'
          ? service.subscription()
          : service.load({ kind: 'personal' });
      await started.promise;
      const read = await authority.read();
      if (read.kind !== 'ok') throw new Error('setup');
      // Another observer's 401 expires the same credential generation.
      await expect(
        authority.recordCredentialRejected(
          read.credentialGeneration,
          'rejected',
          authority.beginProbe(),
        ),
      ).resolves.toEqual({ kind: 'recorded' });
      pending.resolve({ status: 404, body: null });
      await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
    },
  );

  it.each(['subscription', 'load'] as const)(
    'does not answer conclusively after a refusal and same-key sign-in land mid-read (%s)',
    async (operation) => {
      const { authority } = await activeAuthority();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{
        status: number;
        body: unknown;
      }>();
      const service = createCloudAiCreditsAvailability({
        authority,
        request: () => {
          started.resolve();
          return pending.promise;
        },
        organizationNamespace: 'canopy',
      });
      const ask = (): Promise<{ kind: string }> =>
        operation === 'subscription'
          ? service.subscription()
          : service.load({ kind: 'personal' });
      const answer = ask();
      await started.promise;
      const before = await authority.read();
      if (before.kind !== 'ok') throw new Error('setup');
      await expect(
        authority.recordCredentialRejected(
          before.credentialGeneration,
          'rejected',
          authority.beginProbe(),
        ),
      ).resolves.toEqual({ kind: 'recorded' });
      const digest = (value: string): string =>
        createHash('sha256').update(value).digest('hex');
      await expect(
        authority.connectVerified({
          commandId: digest('reauthenticate-mid-read'),
          credentialDigest: digest('csk-first'),
          signal: new AbortController().signal,
          verify: () => Promise.resolve(entry()),
        }),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      // Same key, same durable generation, accepted again: only the session moved.
      await expect(authority.read()).resolves.toMatchObject({
        credentialGeneration: before.credentialGeneration,
        sessionExpired: false,
        provenance: { credential: 'accepted', membership: true, policy: true },
      });
      const conclusive = {
        status: 200,
        body: { credits: 5, active: true },
      };
      pending.resolve(conclusive);
      await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
      // A read begun after the sign-in answers conclusively.
      await expect(ask()).resolves.toMatchObject({
        kind: operation === 'subscription' ? 'ok' : 'spendable',
      });
    },
  );

  it.each(['subscription', 'load'] as const)(
    'does not answer conclusively after a refusal and a re-authenticating refresh land mid-read (%s)',
    async (operation) => {
      const { authority } = await activeAuthority();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{
        status: number;
        body: unknown;
      }>();
      const service = createCloudAiCreditsAvailability({
        authority,
        request: () => {
          started.resolve();
          return pending.promise;
        },
        organizationNamespace: 'canopy',
      });
      const answer =
        operation === 'subscription'
          ? service.subscription()
          : service.load({ kind: 'personal' });
      await started.promise;
      const before = await authority.read();
      if (before.kind !== 'ok') throw new Error('setup');
      await expect(
        authority.recordCredentialRejected(
          before.credentialGeneration,
          'rejected',
          authority.beginProbe(),
        ),
      ).resolves.toEqual({ kind: 'recorded' });
      const refresher = createCloudAccountRefresher({
        authority,
        buildSnapshot: buildCloudAccountSnapshot,
        probe: () =>
          Promise.resolve({
            kind: 'authenticated',
            capabilities: ['account-v1'],
            payload: {
              account: entry().account,
              organizations: entry().organizations,
              enforcedSettings: [],
            },
          }),
      });
      await expect(refresher.refresh()).resolves.toMatchObject({
        outcome: 'applied',
      });
      await expect(authority.read()).resolves.toMatchObject({
        credentialGeneration: before.credentialGeneration,
        sessionExpired: false,
        provenance: { credential: 'accepted', membership: true, policy: true },
      });
      pending.resolve({ status: 200, body: { credits: 5, active: true } });
      await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
      await refresher.dispose();
    },
  );

  it('does not report exhaustion when membership arrives during a billing read', async () => {
    const { authority } = await activeAuthority(entry({ organizations: [] }));
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ status: number; body: unknown }>();
    const paths: string[] = [];
    const request: CloudJsonRequest = ({ path }) => {
      paths.push(path);
      if (path.endsWith('/balance')) {
        started.resolve();
        return pending.promise;
      }
      if (path.endsWith('/spendable'))
        return Promise.resolve({
          status: 200,
          body: { hasSpendableHeadroom: true },
        });
      return Promise.resolve({ status: 200, body: { active: true } });
    };
    const service = createCloudAiCreditsAvailability({
      authority,
      request,
      organizationNamespace: 'canopy',
    });
    const owner = { kind: 'organization', organizationId: ORG } as const;
    const answer = service.load(owner);
    await started.promise;
    const current = await authority.read();
    if (current.kind !== 'ok' || !current.record) throw new Error('setup');
    await expect(
      authority.saveIfUnchanged(entry(), current.record, {
        probe: authority.beginProbe(),
        organizationsRefreshed: true,
      }),
    ).resolves.toMatchObject({ kind: 'saved' });
    pending.resolve({ status: 200, body: { credits: 0 } });
    await expect(answer).resolves.toMatchObject({ kind: 'unknown' });
    expect(paths.some((path) => path.endsWith('/spendable'))).toBe(false);
    // A retry consults the pool the new membership allows.
    await expect(service.load(owner)).resolves.toMatchObject({
      kind: 'spendable',
      source: 'organization',
    });
  });

  it('matches owner policy organizations as availability does', async () => {
    const lettered = 'abcdef01-2222-4333-8444-555555555555';
    const { authority } = await activeAuthority(
      entry({
        organizations: [
          {
            id: lettered,
            name: 'Org',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
        enforcedSettings: [
          {
            organizationId: lettered,
            organizationName: 'Org',
            policies: [
              {
                kind: 'model-policy',
                blockedModelIds: [],
                reviewedModelIds: ['ok-model'],
              },
            ],
          },
        ],
      }),
    );
    const access = await readCloudAccountAccess(authority);
    if (access.kind !== 'ok') throw new Error('setup');
    for (const organizationId of [
      lettered.toUpperCase(),
      ` ${lettered} `,
      ` ${lettered.toUpperCase()}`,
    ]) {
      const owner = { kind: 'organization', organizationId } as const;
      expect(access.modelPolicyActive(owner, 'owner')).toBe(true);
      expect(
        evaluateCloudModelPolicy({
          read: await authority.read(),
          owner,
          scope: 'owner',
          governedModelId: 'unreviewed-model',
        }),
      ).toMatchObject({ kind: 'blocked' });
    }
  });
});

describe('managed survival admission (unselected)', () => {
  const evidence = (
    overrides: Partial<WorkerPipelineNativeRouteEvidence> = {},
  ): WorkerPipelineNativeRouteEvidence => ({
    version: 1,
    identity: {
      executionId: 'exec-1',
      owner: 'personal',
      runScope: 'worktree',
      workspaceId: 'w',
      worktreeId: 't',
    },
    configurationEpoch: 'epoch',
    catalogFingerprint: 'fp',
    expectedAccountIdentity: 'account-1',
    policy: 'account-independent-personal',
    gateway: 'absent',
    accountProxy: 'absent',
    aiCredits: 'required',
    futureSelections: 'closed',
    routes: [
      {
        harness: 'claude',
        selection: 'm',
        requestModel: 'ok-model',
        runtimeModel: 'ok-model',
        source: 'ai-gateway',
        effectiveRoute: 'ai-credits',
        authentication: 'unknown',
      },
    ],
    ...overrides,
  });

  async function ports(balance: {
    status: number;
    body: unknown;
  }): Promise<ManagedPipelineSurvivalPorts> {
    const { authority } = await activeAuthority();
    return {
      authority,
      availability: createCloudAiCreditsAvailability({
        authority,
        request: ({ path }) =>
          Promise.resolve(
            path.endsWith('/subscription')
              ? { status: 200, body: { active: false } }
              : balance,
          ),
        organizationNamespace: 'canopy',
      }),
      brokerReady: (): boolean => true,
      policyScope: 'union',
    };
  }

  it.each([false, true])(
    'requires a fresh daemon probe before admitting client policy (known rejection: %s)',
    async (rejected) => {
      const { custody } = custodyFor();
      let authority = createCloudAccountAuthority({ custody });
      await expect(
        authority.provision(entry(), null, undefined, 0, rejected),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      // Retained client flags cannot grant permission, including after a restart.
      authority = createCloudAccountAuthority({ custody });
      const availability = createCloudAiCreditsAvailability({
        authority,
        organizationNamespace: 'canopy',
        request: () =>
          Promise.resolve({ status: 200, body: { credits: 5, active: true } }),
      });
      const ready: ManagedPipelineSurvivalPorts = {
        authority,
        availability,
        brokerReady: (): boolean => true,
        policyScope: 'union',
      };
      const native = evidence({
        policy: 'required',
        aiCredits: 'absent',
        routes: [
          {
            harness: 'claude',
            selection: 'sonnet',
            requestModel: 'ok-model',
            runtimeModel: 'ok-model',
            source: 'claude-managed',
            effectiveRoute: 'native',
            authentication: 'vendor-profile',
          },
        ],
      });
      const before = await authority.read();
      expect(before).toMatchObject({
        provenance: {
          credential: rejected ? 'rejected' : 'unknown',
          membership: false,
          policy: false,
        },
      });
      expect(
        (await assessManagedPipelineSurvival(native, ready)).kind,
      ).not.toBe('admissible');
      if (before.kind !== 'ok' || !before.record) throw new Error('No account');
      // A probe-less save and client reconciliation cannot manufacture verification.
      await authority.saveIfUnchanged(before.record.entry, before.record);
      await authority.provision(
        entry(),
        createHash('sha256').update('csk-first').digest('hex'),
      );
      expect(
        (await assessManagedPipelineSurvival(native, ready)).kind,
      ).not.toBe('admissible');
      await expect(
        authority.saveIfUnchanged(before.record.entry, before.record, {
          probe: authority.beginProbe(),
        }),
      ).resolves.toMatchObject({ kind: 'saved' });
      expect((await assessManagedPipelineSurvival(native, ready)).kind).toBe(
        'admissible',
      );
    },
  );

  it('admits only a consented, spendable, gateway-free AI Credits run', async () => {
    const ready = await ports({ status: 200, body: { credits: 3 } });
    expect(
      await assessManagedPipelineSurvival(evidence(), ready),
    ).toMatchObject({
      kind: 'admissible',
      credentialFamilies: ['cloud-account'],
    });
  });

  it.each([0, 3])(
    'revalidates membership after billing, preserving a separate personal wallet (%i credits)',
    async (credits) => {
      const { authority } = await activeAuthority();
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const observed =
        Promise.withResolvers<
          Awaited<
            ReturnType<ManagedPipelineSurvivalPorts['availability']['load']>
          >
        >();
      const availability = createCloudAiCreditsAvailability({
        authority,
        organizationNamespace: 'canopy',
        request: async ({ path }) => {
          if (path.endsWith('/subscription'))
            return { status: 200, body: { active: true } };
          if (path.endsWith('/balance'))
            return { status: 200, body: { credits } };
          entered.resolve();
          await released.promise;
          return { status: 200, body: { hasSpendableHeadroom: true } };
        },
      });
      // A refresh that began before billing lands mid-read; a newer probe's
      // result would instead leave the answer unknown (outlived asker).
      const refresh = authority.beginProbe();
      const admission = assessManagedPipelineSurvival(
        evidence({
          identity: {
            ...evidence().identity,
            owner: `org:${ORG}`,
          },
          policy: 'required',
        }),
        {
          authority,
          availability: {
            subscription: (...args) => availability.subscription(...args),
            load: async (owner, signal) => {
              const answer = await availability.load(owner, signal);
              observed.resolve(answer);
              return answer;
            },
          },
          brokerReady: () => true,
          policyScope: 'union',
        },
      );
      await entered.promise;
      try {
        const before = await authority.read();
        if (before.kind !== 'ok' || !before.record)
          throw new Error('No account');
        expect(
          await authority.saveIfUnchanged(
            entry({ organizations: [] }),
            before.record,
            { probe: refresh, organizationsRefreshed: true },
          ),
        ).toMatchObject({ kind: 'saved' });
        const after = await authority.read();
        expect(after.kind === 'ok' && after.credentialGeneration).toBe(
          before.credentialGeneration,
        );
      } finally {
        released.resolve();
      }
      expect(await observed.promise).toMatchObject(
        credits > 0
          ? { kind: 'spendable', source: 'personal' }
          : { kind: 'unknown', reason: 'owner-unknown' },
      );
      const result = await admission;
      if (result.kind !== 'pauses') throw new Error(result.kind);
      expect(result.blockers).toContain('policy');
    },
  );

  it('pauses on exhausted credits, unknown availability or a missing broker', async () => {
    const exhausted = await ports({ status: 200, body: { credits: 0 } });
    expect(await assessManagedPipelineSurvival(evidence(), exhausted)).toEqual({
      kind: 'pauses',
      blockers: ['ai-credits'],
    });
    const offline = await ports({ status: 502, body: null });
    expect(
      (await assessManagedPipelineSurvival(evidence(), offline)).kind,
    ).toBe('pauses');
    const noBroker = {
      ...(await ports({ status: 200, body: { credits: 3 } })),
      brokerReady: (): boolean => false,
    };
    expect(
      (await assessManagedPipelineSurvival(evidence(), noBroker)).kind,
    ).toBe('pauses');
  });

  it('never bypasses a gateway or infers credits consent', async () => {
    const ready = await ports({ status: 200, body: { credits: 3 } });
    expect(
      await assessManagedPipelineSurvival(
        evidence({ gateway: 'required' }),
        ready,
      ),
    ).toEqual({ kind: 'pauses', blockers: ['gateway'] });
    expect(
      await assessManagedPipelineSurvival(
        evidence({ aiCredits: 'unknown' }),
        ready,
      ),
    ).toEqual({ kind: 'pauses', blockers: ['ai-credits'] });
  });

  it('pauses governed native work when policy is unknown or blocks the model', async () => {
    const ready = await ports({ status: 200, body: { credits: 3 } });
    const native = evidence({
      policy: 'required',
      aiCredits: 'absent',
      routes: [
        {
          harness: 'codex',
          selection: 'm',
          requestModel: 'ok-model',
          runtimeModel: 'ok-model',
          source: 'codex-managed',
          effectiveRoute: 'native',
          authentication: 'vendor-profile',
        },
      ],
    });
    // The account has no model policy: governed native work is admissible.
    expect((await assessManagedPipelineSurvival(native, ready)).kind).toBe(
      'admissible',
    );
    const { custody } = custodyFor();
    const inactive = {
      ...ready,
      authority: createCloudAccountAuthority({ custody }),
    };
    expect(await assessManagedPipelineSurvival(native, inactive)).toEqual({
      kind: 'pauses',
      blockers: ['policy'],
    });
    expect(
      await assessManagedPipelineSurvival(
        { ...native, policy: 'unknown' },
        ready,
      ),
    ).toEqual({ kind: 'pauses', blockers: ['policy'] });
  });

  it('uses recorded owner scope and conservatively defaults old evidence to union', async () => {
    const ready = await ports({ status: 200, body: { credits: 3 } });
    const policyRead = await ready.authority.read();
    if (policyRead.kind !== 'ok' || !policyRead.record)
      throw new Error('account');
    await ready.authority.saveIfUnchanged(
      entry({
        enforcedSettings: [
          {
            organizationId: ORG,
            organizationName: 'Org',
            policies: [
              {
                kind: 'model-policy',
                mode: 'allowlist',
                reviewedModelIds: [],
                blockedModelIds: ['ok-model'],
              },
            ],
          },
        ],
      }),
      policyRead.record,
    );
    const native = evidence({
      policy: 'required',
      aiCredits: 'absent',
      routes: [
        {
          harness: 'codex',
          selection: 'm',
          requestModel: 'ok-model',
          runtimeModel: 'ok-model',
          source: 'codex-managed',
          effectiveRoute: 'native',
          authentication: 'vendor-profile',
        },
      ],
    });
    // Personal work ignores organization policies only with a recorded owner scope.
    expect(
      (
        await assessManagedPipelineSurvival(
          { ...native, policyScope: 'owner' },
          ready,
        )
      ).kind,
    ).toBe('admissible');
    expect(await assessManagedPipelineSurvival(native, ready)).toEqual({
      kind: 'pauses',
      blockers: ['policy'],
    });
    expect(
      await assessManagedPipelineSurvival(
        { ...native, policyScope: 'union' },
        ready,
      ),
    ).toEqual({ kind: 'pauses', blockers: ['policy'] });
  });

  it('pauses when the current account makes a gateway mandatory', async () => {
    const gatewayPolicy = (enforced: boolean): Entry =>
      entry({
        enforcedSettings: [
          {
            organizationId: ORG,
            organizationName: 'Org',
            policies: [
              {
                kind: 'model-gateway',
                enforced,
                baseUrl: 'https://gateway.example.test',
                models: [],
              },
            ],
          },
        ],
      });
    const native = evidence({
      identity: { ...evidence().identity, owner: `org:${ORG}` },
      policy: 'required',
      aiCredits: 'absent',
      routes: [
        {
          harness: 'codex',
          selection: 'm',
          requestModel: 'ok-model',
          runtimeModel: 'ok-model',
          source: 'codex-managed',
          effectiveRoute: 'native',
          authentication: 'explicit-environment',
        },
      ],
    });
    const portsFor = async (
      initial: Entry,
    ): Promise<ManagedPipelineSurvivalPorts> => {
      const { authority } = await activeAuthority(initial);
      return {
        authority,
        availability: createCloudAiCreditsAvailability({
          authority,
          request: () => Promise.resolve({ status: 200, body: {} }),
          organizationNamespace: 'canopy',
        }),
        brokerReady: (): boolean => true,
        policyScope: 'owner',
      };
    };
    // Launch evidence said no gateway; a later refresh made one mandatory.
    expect(
      await assessManagedPipelineSurvival(
        native,
        await portsFor(gatewayPolicy(true)),
      ),
    ).toEqual({ kind: 'pauses', blockers: ['gateway'] });
    expect(
      await assessManagedPipelineSurvival(
        native,
        await portsFor(entry({ modelGatewayEnforcementUnavailable: true })),
      ),
    ).toEqual({ kind: 'pauses', blockers: ['gateway'] });
    // An optional gateway is not mandatory; the credential family is the
    // route's own, not a vendor profile.
    expect(
      await assessManagedPipelineSurvival(
        native,
        await portsFor(gatewayPolicy(false)),
      ),
    ).toMatchObject({
      kind: 'admissible',
      credentialFamilies: ['explicit-environment', 'cloud-account'],
    });
  });
});

describe('daemon cloud account composition', () => {
  const endpoint = {
    baseUrl: 'https://cloud.example.test',
    wellKnownNamespace: 'canopy',
    apiNamespace: 'desktop-app',
  };
  const observer: CanopyCallerDescriptor = {
    principalId: 'local-user',
    clientInstanceId: 'observer',
    authorityId: 'authority',
    interfaceKind: 'cli',
    grants: [
      'core.integration.read',
      'core.integration.write',
      CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
    ],
  };

  it.each(['\rcsk-secret-hidden', '\ncsk-secret-hidden', 'csk-secreté'])(
    'keeps refused billing headers inconclusive and off the transport (%j)',
    async (apiKey) => {
      const memory = createMemoryVaultRepository();
      const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
      const fetcher = jest.fn(
        (): Promise<Response> =>
          Promise.reject(
            new Error('Transport must not receive an invalid key'),
          ),
      );
      const services = createDaemonCloudAccountServices({
        cloud: endpoint,
        fetch: fetcher,
        repository: () => Promise.resolve(memory.repository),
        writer: () => Promise.resolve(writer),
      });
      try {
        await services.custody.commit({
          expected: null,
          state: 'active',
          credentialGeneration: 1,
          record: readCloudAccountRecord(entry({ apiKey })),
        });
        await expect(services.availability.subscription()).resolves.toEqual({
          kind: 'unknown',
          reason: 'offline',
        });
        await expect(
          services.availability.load({ kind: 'personal' }),
        ).resolves.toEqual({ kind: 'unknown', reason: 'offline' });
        expect(fetcher).not.toHaveBeenCalled();
        await expect(services.authority.read()).resolves.toMatchObject({
          sessionExpired: false,
        });
      } finally {
        await services.dispose();
      }
    },
  );

  it.each([
    { ...endpoint, baseUrl: 'https://other.example.test' },
    { ...endpoint, baseUrl: `${endpoint.baseUrl}/another-cloud` },
    { ...endpoint, apiNamespace: 'another-api' },
    { ...endpoint, wellKnownNamespace: 'another-brand' },
    null,
  ])(
    'never sends a stored credential to another endpoint authority (%j)',
    async (cloud) => {
      const memory = createMemoryVaultRepository();
      const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
      const requests: string[] = [];
      const compose = (
        target: typeof endpoint | null,
      ): ReturnType<typeof createDaemonCloudAccountServices> =>
        createDaemonCloudAccountServices({
          cloud: target,
          repository: () => Promise.resolve(memory.repository),
          writer: () => Promise.resolve(writer),
          fetch: (url) => {
            requests.push(
              typeof url === 'string'
                ? url
                : url instanceof URL
                  ? url.href
                  : url.url,
            );
            return Promise.resolve(new Response('{}', { status: 503 }));
          },
        });
      const original = compose(endpoint);
      await expect(
        original.authority.provision(entry(), null),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      await original.dispose();
      const restarted = compose({
        ...endpoint,
        baseUrl: `${endpoint.baseUrl}/`,
      });
      await expect(restarted.authority.read()).resolves.toMatchObject({
        kind: 'ok',
        record: { apiKey: 'csk-first' },
      });
      await restarted.dispose();
      const changed = compose(cloud);
      const graph = createRuntimeProfileGraph({
        profile: 'core',
        modules: [changed.module],
        identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
        phaseDeadlineMs: 1000,
        shutdownTimeoutMs: 50,
      });
      try {
        await graph.start();
        await expect(changed.authority.read()).resolves.toEqual({
          kind: 'unavailable',
          reason: 'endpoint_mismatch',
        });
        const unavailableCustody = {
          endpointAuthority: cloud
            ? cloudAccountEndpointAuthority(cloud)
            : null,
          state: 'unavailable',
          credentialGeneration: null,
          credentialDigest: null,
          sessionExpired: false,
          entry: null,
        };
        await expect(
          graph.dispatcher.query(
            'core.integration.cloudAccount.custody.get',
            {},
            { caller: observer },
          ),
        ).resolves.toEqual(unavailableCustody);
        await expect(changed.start()).resolves.toBe(false);
        await expect(changed.refresher.refresh()).resolves.toMatchObject({
          outcome: 'unavailable',
        });
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.refresh',
            {},
            { caller: observer },
          ),
        ).resolves.toEqual({
          outcome: 'unavailable',
          billingStatesRefreshed: false,
          custody: unavailableCustody,
        });
        await expect(changed.availability.subscription()).resolves.toEqual({
          kind: 'unknown',
          reason: 'unavailable',
        });
        await expect(
          changed.availability.load({ kind: 'personal' }),
        ).resolves.toMatchObject({ kind: 'unknown' });
        await expect(
          changed.broker.openAiCreditsRoute({
            executionId: 'run',
            owner: 'personal',
            harness: 'claude',
            governedModelId: 'fixture-model',
            requestModels: { 'fixture-model': 'fixture-model' },
            policyScope: 'union',
            accountId: 'account-1',
            credentialGeneration: 1,
          }),
        ).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
        expect(requests).toEqual([]);
        // Explicit reset discards the wrong-endpoint sign-in, never rebinds its key.
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.resetUnreadable',
            {},
            { caller: observer },
          ),
        ).resolves.toEqual({
          status: 'reset',
          account: { connected: false, kind: 'none' },
        });
        await expect(changed.authority.read()).resolves.toMatchObject({
          kind: 'ok',
          record: null,
        });
        // Reset leaves custody active and signed out.
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.refresh',
            {},
            { caller: observer },
          ),
        ).resolves.toMatchObject({
          outcome: 'no-key',
          custody: { state: 'active', entry: null },
        });
        expect(requests).toEqual([]);
      } finally {
        await graph.shutdown('test');
        await changed.dispose();
      }
    },
  );

  it('does not adopt an old unbound record into a configured Cloud', async () => {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    const legacy = createCloudAccountCustody({
      repository: () => Promise.resolve(memory.repository),
      writer: () => Promise.resolve(writer),
    });
    await legacy.commit({
      expected: null,
      state: 'active',
      credentialGeneration: 1,
      record: readCloudAccountRecord(entry()),
    });
    const configured = createDaemonCloudAccountServices({
      cloud: endpoint,
      repository: () => Promise.resolve(memory.repository),
      writer: () => Promise.resolve(writer),
      fetch: () => {
        throw new Error('An unbound credential must not leave custody.');
      },
    });
    try {
      await expect(configured.start()).resolves.toBe(false);
      await expect(configured.refresher.refresh()).resolves.toMatchObject({
        outcome: 'unavailable',
      });
      await expect(configured.authority.read()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'endpoint_mismatch',
      });
    } finally {
      await configured.dispose();
    }
  });

  function compose(
    options: {
      readonly cloud?: typeof endpoint | null;
      readonly respond?: (url: string) => { status: number; body: unknown };
    } = {},
  ): {
    services: ReturnType<typeof createDaemonCloudAccountServices>;
    requests: string[];
    repositoryReads: () => number;
    results: CloudAccountRefreshResult[];
    nextResult: () => Promise<CloudAccountRefreshResult>;
  } {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    const requests: string[] = [];
    let reads = 0;
    const results: CloudAccountRefreshResult[] = [];
    const waiters: ((result: CloudAccountRefreshResult) => void)[] = [];
    const fetchStub: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push(`${url} ${authorization ?? '-'}`);
      const answer = options.respond?.(url) ?? { status: 503, body: null };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), { status: answer.status }),
      );
    };
    const services = createDaemonCloudAccountServices({
      repository: () => {
        reads += 1;
        return Promise.resolve(memory.repository);
      },
      writer: () => Promise.resolve(writer),
      cloud: options.cloud === undefined ? endpoint : options.cloud,
      fetch: fetchStub,
      refreshIntervalMs: 60_000,
      onRefresh: (result) => {
        results.push(result);
        waiters.shift()?.(result);
      },
    });
    return {
      services,
      requests,
      repositoryReads: () => reads,
      results,
      nextResult: () =>
        new Promise((resolve) => {
          waiters.push(resolve);
        }),
    };
  }

  async function activate(
    services: ReturnType<typeof createDaemonCloudAccountServices>,
    initial: Entry = entry(),
  ): Promise<void> {
    const created = await services.custody.commit({
      expected: null,
      state: 'active',
      credentialGeneration: 1,
      record: readCloudAccountRecord(initial),
    });
    expect(created.kind).toBe('committed');
  }

  it('rejects the held credential when a billing 401 body cannot be read', async () => {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    const services = createDaemonCloudAccountServices({
      repository: () => Promise.resolve(memory.repository),
      writer: () => Promise.resolve(writer),
      cloud: endpoint,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start: (controller): void =>
                controller.error(new Error('Body failed')),
            }),
            { status: 401 },
          ),
        ),
    });
    try {
      await activate(services);
      await expect(services.availability.subscription()).resolves.toMatchObject(
        {
          kind: 'unknown',
          reason: 'rejected',
        },
      );
      const read = await services.authority.read();
      expect(read.kind === 'ok' && read.sessionExpired).toBe(true);
    } finally {
      await services.dispose();
    }
  });

  it('is not selected and stays inert while the app is still the writer', async () => {
    expect(CLOUD_ACCOUNT_AUTHORITY_ACTIVATION_SELECTED).toBe(false);
    const { services, requests, repositoryReads } = compose();
    // Construction alone opens no vault and makes no request.
    expect(repositoryReads()).toBe(0);
    await expect(services.start()).resolves.toBe(false);
    expect(requests).toEqual([]);
    await services.dispose();
  });

  it('makes no request in a build without a Cloud', async () => {
    const { services, requests, repositoryReads } = compose({ cloud: null });
    await activate(services);
    const before = repositoryReads();
    await expect(services.start()).resolves.toBe(false);
    expect(repositoryReads()).toBe(before);
    expect(requests).toEqual([]);
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [services.module],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    await graph.start();
    try {
      const before = await services.custody.read();
      await expect(
        graph.dispatcher
          .instruction(
            'core.integration.cloudAccount.connectWithKey',
            { apiKey: 'csk-manual' },
            { caller: observer, metadata: { idempotencyKey: 'no-cloud' } },
          )
          .catch((error: unknown) =>
            error instanceof CanopyOperationError ? error.payload : error,
          ),
      ).resolves.toMatchObject({
        code: 'core.integration.cloudAccount.providerUnreachable',
        // No retry can reach a Cloud this build does not have.
        retry: { kind: 'never' },
      });
      await expect(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.refresh',
          {},
          { caller: observer },
        ),
      ).resolves.toMatchObject({ outcome: 'offline' });
      expect(requests).toEqual([]);
      // Refused before its receipt.
      await expect(services.custody.read()).resolves.toEqual(before);
      const read = await services.authority.read();
      expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('refreshes active custody with no app connection and records organization loss', async () => {
    const { services, requests, nextResult } = compose({
      respond: (url) =>
        url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: ['account-v1'] } }
          : {
              status: 200,
              body: {
                account: entry().account,
                capabilities: ['account-v1', 'teams-v1'],
                organizations: [],
                orgBillingStates: [],
              },
            },
    });
    await activate(services);
    const result = nextResult();
    await expect(services.start()).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      outcome: 'applied',
      billingStatesRefreshed: true,
    });
    expect(requests).toEqual([
      'https://cloud.example.test/.well-known/canopy -',
      'https://cloud.example.test/api/v1/desktop-app/account Bearer csk-first',
    ]);
    const read = await services.authority.read();
    if (read.kind !== 'ok') throw new Error('read');
    expect(read.credentialGeneration).toBe(1);
    expect(read.record?.organizationIds).toEqual([]);
    expect(read.record?.entry.capabilities).toEqual(['account-v1', 'teams-v1']);
    expect(read.record?.organizationAccessLossState).toMatchObject({
      organizationIds: [],
      pending: [],
    });
    await services.dispose();
  });

  it('persists refreshes that replace advertised fields and keep unknown ones', async () => {
    const lapse = {
      organizationId: ORG,
      organizationName: 'Org',
      teamsEntitled: false,
    };
    const personalModelGatewayConfig = {
      organizationId: ORG,
      enabled: false,
      baseUrl: 'https://personal.example.test',
    };
    const organizationModelGatewayConfigs = [
      {
        organizationId: OTHER_ORG,
        enabled: false,
        configured: true,
        baseUrlFingerprint: 'a'.repeat(64),
      },
    ];
    const moved = {
      id: OTHER_ORG,
      name: 'Moved',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    const replacedFields = {
      personalOrganizationId: ORG,
      personalModelGatewayConfig,
      organizationModelGatewayConfigs,
      memorySearchOrganizationExternalIds: [ORG],
      memorySearchOrganizationExternalId: ORG,
    };
    let accountBody: Record<string, unknown> = {
      account: entry().account,
      capabilities: ['account-v1', 'teams-v1'],
      organizations: [moved],
      teams: [{ id: 'not-a-team' }],
    };
    const { services, nextResult } = compose({
      respond: (url) =>
        url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: ['account-v1'] } }
          : { status: 200, body: accountBody },
    });
    await activate(
      services,
      entry({
        ...replacedFields,
        futureField: { kept: true },
        orgBillingStates: [lapse],
      }),
    );
    // The custody document each refresh saved, read back from the vault.
    const persisted = async (): Promise<{
      readonly entry: Readonly<Record<string, unknown>>;
      readonly membership: boolean | undefined;
    }> => {
      const held = await services.custody.read();
      if (held.kind !== 'ok' || !held.document.record)
        throw new Error(`custody ${held.kind}`);
      return {
        entry: held.document.record.entry,
        membership: held.document.provenance?.membership,
      };
    };
    // Every field the refreshes must drop, keep or clear is held first.
    expect((await persisted()).entry).toMatchObject({
      ...replacedFields,
      futureField: { kept: true },
      orgBillingStates: [lapse],
    });

    // An omitted billing field clears the cached lapse and reports billing
    // absent; advertised fields are replaced, unknown ones kept.
    const refreshedFrom = Date.now();
    const result = nextResult();
    await expect(services.start()).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      outcome: 'applied',
      billingStatesRefreshed: false,
    });
    const refreshedBy = Date.now();
    const replaced = await persisted();
    expect(replaced.membership).toBe(true);
    expect(replaced.entry).toMatchObject({
      apiKey: 'csk-first',
      capabilities: ['account-v1', 'teams-v1'],
      organizations: [moved],
      organizationsVerified: true,
      teams: [],
      futureField: { kept: true },
      orgBillingStates: [],
    });
    for (const field of Object.keys(replacedFields))
      expect(replaced.entry).not.toHaveProperty(field);
    // The refresh stamps its own time; the daemon composition has no clock seam.
    const updatedAt =
      typeof replaced.entry.updatedAt === 'string'
        ? Date.parse(replaced.entry.updatedAt)
        : Number.NaN;
    expect(updatedAt).toBeGreaterThanOrEqual(refreshedFrom);
    expect(updatedAt).toBeLessThanOrEqual(refreshedBy);

    // Saved gateway configs refresh without active routing; organization
    // URLs stay private.
    accountBody = {
      account: entry().account,
      personalOrganizationId: ORG,
      personalModelGatewayConfig,
      organizationModelGatewayConfigs: organizationModelGatewayConfigs.map(
        (config) => ({ ...config, baseUrl: 'https://private.example.test' }),
      ),
      organizations: [moved],
      enforcedSettings: [],
    };
    await expect(services.refresher.refresh()).resolves.toEqual({
      outcome: 'applied',
      billingStatesRefreshed: false,
    });
    const gateway = (await persisted()).entry;
    expect(gateway.personalModelGatewayConfig).toEqual(
      personalModelGatewayConfig,
    );
    expect(gateway.organizationModelGatewayConfigs).toEqual(
      organizationModelGatewayConfigs,
    );
    expect(gateway).not.toHaveProperty('personalModelGateway');

    // A malformed organization list is inconclusive; billing still refreshes.
    accountBody = {
      account: entry().account,
      organizations: [moved, moved],
      orgBillingStates: [],
    };
    await expect(services.refresher.refresh()).resolves.toEqual({
      outcome: 'applied',
      billingStatesRefreshed: true,
    });
    const inconclusive = await persisted();
    expect(inconclusive.membership).toBe(false);
    expect(inconclusive.entry).toMatchObject({ organizationsVerified: false });

    // A response without an account builds nothing: the held account stays.
    accountBody = { organizations: [] };
    await expect(services.refresher.refresh()).resolves.toMatchObject({
      outcome: 'invalid-snapshot',
    });
    await expect(persisted()).resolves.toMatchObject({
      entry: {
        account: inconclusive.entry.account,
        organizations: inconclusive.entry.organizations,
        futureField: { kept: true },
      },
    });
    await services.dispose();
  });

  it('stops brokered routes and credits after a revoked credential is refreshed', async () => {
    const { services, nextResult } = compose({
      respond: (url) =>
        url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: [] } }
          : url.endsWith('/account')
            ? { status: 401, body: { error: 'revoked' } }
            : { status: 200, body: { credits: 5, active: true } },
    });
    await activate(services);
    const result = nextResult();
    await services.start();
    await expect(result).resolves.toMatchObject({
      outcome: 'unauthenticated',
    });
    await expect(
      services.availability.load({ kind: 'personal' }),
    ).resolves.toEqual({ kind: 'unknown', reason: 'session-expired' });
    await expect(
      services.broker.openAiCreditsRoute({
        executionId: 'run-1',
        owner: 'personal',
        harness: 'claude',
        governedModelId: 'fixture-model',
        requestModels: { 'fixture-model': 'fixture-model' },
        policyScope: 'union',
        accountId: 'account-1',
        credentialGeneration: 1,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'session-expired' });
    // The snapshot is kept: revocation is not a sign-out.
    const read = await services.authority.read();
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-first');
    await services.dispose();
  });
});

describe('credential-only replacement presentation', () => {
  it('withdraws retained policy when a probe-less save changes the replacement snapshot', async () => {
    const { authority } = await activeAuthority();
    await authority.provision(
      entry({ apiKey: 'csk-rotated' }),
      createHash('sha256').update('csk-first').digest('hex'),
    );
    const read = await authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('account');
    await authority.saveIfUnchanged(read.record.entry, read.record);
    const unchanged = await readCloudAccountAccess(authority);
    if (unchanged.kind !== 'ok') throw new Error('account');
    expect(
      unchanged.brokerPresentationUnknownReason({ kind: 'personal' }),
    ).toBeNull();
    await authority.saveIfUnchanged(
      { ...read.record.entry, personalModelGateway: { enforced: false } },
      read.record,
    );
    const changed = await readCloudAccountAccess(authority);
    if (changed.kind !== 'ok') throw new Error('account');
    expect(changed.brokerPresentationUnknownReason({ kind: 'personal' })).toBe(
      'policy-unavailable',
    );
  });

  it.each(['rejected', 'forbidden', 'unknown'] as const)(
    'withdraws retained daemon policy before a %s write completes',
    async (outcome) => {
      const { authority, custody } = await activeAuthority();
      await authority.provision(
        entry({ apiKey: 'csk-rotated' }),
        createHash('sha256').update('csk-first').digest('hex'),
      );
      const access = await readCloudAccountAccess(authority);
      if (access.kind !== 'ok') throw new Error('account');
      expect(
        access.brokerPresentationUnknownReason({ kind: 'personal' }),
      ).toBeNull();
      expect(access.executionUnknownReason({ kind: 'personal' })).toBe(
        'policy-unavailable',
      );
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const commit = custody.commit.bind(custody);
      const spy = jest
        .spyOn(custody, 'commit')
        .mockImplementation(
          async (input): ReturnType<CloudAccountCustody['commit']> => {
            started.resolve();
            await release.promise;
            return commit(input);
          },
        );
      const refused = authority.recordCredentialRejected(2, outcome);
      try {
        await started.promise;
        const pending = await readCloudAccountAccess(authority);
        if (pending.kind !== 'ok') throw new Error('account');
        expect(
          pending.brokerPresentationUnknownReason({ kind: 'personal' }),
        ).not.toBeNull();
      } finally {
        release.resolve();
        await refused;
        spy.mockRestore();
      }
      const rejected = await readCloudAccountAccess(authority);
      if (rejected.kind !== 'ok') throw new Error('account');
      expect(
        rejected.brokerPresentationUnknownReason({ kind: 'personal' }),
      ).not.toBeNull();
    },
  );

  it.each(['rejected', 'forbidden', 'unknown'] as const)(
    'does not retain policy from a %s account on explicit replacement',
    async (outcome) => {
      const { authority } = await activeAuthority();
      await authority.recordCredentialRejected(1, outcome);
      await authority.provision(
        entry({ apiKey: 'csk-rotated' }),
        createHash('sha256').update('csk-first').digest('hex'),
      );
      const access = await readCloudAccountAccess(authority);
      if (access.kind !== 'ok') throw new Error('account');
      expect(access.brokerPresentationUnknownReason({ kind: 'personal' })).toBe(
        'policy-unavailable',
      );
    },
  );
});

describe("the daemon's own account record, provisioned by clients", () => {
  const endpoint = {
    baseUrl: 'https://cloud.example.test',
    wellKnownNamespace: 'canopy',
    apiNamespace: 'desktop-app',
  };
  const client: CanopyCallerDescriptor = {
    principalId: 'local-user',
    clientInstanceId: 'desktop',
    authorityId: 'authority',
    interfaceKind: 'desktop',
    grants: [
      'core.integration.read',
      'core.integration.write',
      CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
    ],
  };
  const digest = (apiKey: string): string =>
    createHash('sha256').update(apiKey).digest('hex');
  const accountBody = {
    account: entry().account,
    capabilities: [
      'account-v1',
      'organizations-v1',
      'teams-v1',
      'pipelines-crud-v1',
    ],
    organizations: [{ id: ORG, name: 'Org' }],
  };

  type CloudAnswer = { status: number; body: unknown };

  function serve(
    respond: (
      url: string,
      authorization: string | null,
    ) => CloudAnswer | Promise<CloudAnswer> = () => ({
      status: 503,
      body: null,
    }),
    /** While true, the store lists the entry but cannot read it (locked). */
    locked: () => boolean = () => false,
    /** Runs when the graph's phase-7 vault close begins. */
    onVaultClose: () => void = () => undefined,
  ): {
    services: ReturnType<typeof createDaemonCloudAccountServices>;
    graph: ReturnType<typeof createRuntimeProfileGraph>;
    requests: string[];
    results: CloudAccountRefreshResult[];
    /** Account vault calls after the graph's phase-7 vault close. */
    lateVaultCalls: string[];
    /** Refresh results reported when the vault closed; null while open. */
    resultsAtVaultClose: () => number | null;
  } {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    const requests: string[] = [];
    const results: CloudAccountRefreshResult[] = [];
    const lateVaultCalls: string[] = [];
    let closedWith: number | null = null;
    const touch = (call: string): void => {
      if (closedWith !== null) lateVaultCalls.push(call);
    };
    // Mirrors the daemon vault: closes in shutdown phase 7.
    const vaultModule: RuntimeModule = {
      name: 'test.vault',
      plane: 'core',
      services: [
        {
          name: 'daemon.vault',
          plane: 'core',
          stop: {
            7: (): void => {
              closedWith = results.length;
              onVaultClose();
            },
          },
        },
      ],
      definitions: { queries: {}, instructions: {}, streams: {} },
      handlers: { queries: {}, instructions: {}, streams: {} },
    };
    const services = createDaemonCloudAccountServices({
      repository: () => {
        touch('repository');
        const repository = memory.repository;
        return Promise.resolve(
          locked() ? lockedRepository(repository) : repository,
        );
      },
      writer: () =>
        Promise.resolve({
          family: writer.family,
          put: (request) => {
            touch('put');
            return writer.put(request);
          },
          delete: (request) => {
            touch('delete');
            return writer.delete(request);
          },
        }),
      cloud: endpoint,
      refreshIntervalMs: 60_000,
      onRefresh: (result) => results.push(result),
      fetch: (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const authorization = new Headers(init?.headers).get('authorization');
        requests.push(`${url} ${authorization ?? '-'}`);
        const answer = respond(url, authorization);
        const toResponse = ({ status, body }: CloudAnswer): Response =>
          new Response(JSON.stringify(body), { status });
        if (!(answer instanceof Promise))
          return Promise.resolve(toResponse(answer));
        // A held answer ends early, as fetch does, when its request aborts.
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          const abort = (): void =>
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('Aborted'),
            );
          if (signal?.aborted) return abort();
          signal?.addEventListener('abort', abort, { once: true });
          answer.then((value) => resolve(toResponse(value)), reject);
        });
      },
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [services.module, vaultModule],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    return {
      services,
      graph,
      requests,
      results,
      lateVaultCalls,
      resultsAtVaultClose: () => closedWith,
    };
  }

  /** Lists the entry but cannot read it, like a locked store. */
  const lockedRepository = (repository: VaultRepository): VaultRepository => ({
    list: () => repository.list(),
    get: () => Promise.resolve({ kind: 'blocked', reason: 'locked' }),
    admit: () => ({ kind: 'blocked', reason: 'locked' }),
    status: () => repository.status(),
  });

  const kindOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof CanopyOperationError
          ? { kind: error.payload.kind, code: error.payload.code ?? null }
          : 'thrown',
    );

  const provision = (
    graph: ReturnType<typeof createRuntimeProfileGraph>,
    params: CoreCloudAccountProvisionParams,
    caller = client,
  ): Promise<CoreCloudAccountProvisionResult> =>
    graph.dispatcher
      .instruction('core.integration.cloudAccount.provision', params, {
        caller,
      })
      .then((result) => CoreCloudAccountProvisionResultSchema.parse(result));
  /** A fixture entry as the wire carries it. */
  const json = (value: Entry): Record<string, CanopyJsonValue> => {
    const parsed = CloudAccountEntryJsonSchema.parse(
      JSON.parse(JSON.stringify(value)),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected an account fixture object.');
    return parsed;
  };

  it('retains a client 401 through provisioning and reconciliation until its own probe succeeds', async () => {
    let online = false;
    const { graph, services, requests } = serve((url) =>
      !online
        ? { status: 503, body: null }
        : url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: accountBody.capabilities } }
          : {
              status: 200,
              body: {
                ...accountBody,
                organizations: entry().organizations,
                enforcedSettings: [],
              },
            },
    );
    try {
      await graph.start();
      const params: CoreCloudAccountProvisionParams = {
        entry: json(entry()),
        expectedCredentialDigest: null,
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialGeneration: 0,
        credentialRejected: true,
      };
      const first = await provision(graph, params);
      expect(first).toMatchObject({
        status: 'provisioned',
        custody: { sessionExpired: true },
      });
      expect(requests.length).toBeGreaterThan(0);
      await expect(
        provision(graph, {
          ...params,
          expectedCredentialDigest: digest('csk-first'),
          expectedCredentialGeneration: 1,
          credentialRejected: false,
        }),
      ).resolves.toMatchObject({
        status: 'unchanged',
        custody: { sessionExpired: true },
      });
      expect(
        evaluateCloudModelPolicy({
          read: await services.authority.read(),
          owner: { kind: 'personal' },
          scope: 'union',
          governedModelId: 'ok-model',
        }),
      ).toEqual({ kind: 'unknown', reason: 'session-expired' });
      online = true;
      await expect(services.refresher.refresh()).resolves.toMatchObject({
        outcome: 'applied',
      });
      expect(
        evaluateCloudModelPolicy({
          read: await services.authority.read(),
          owner: { kind: 'personal' },
          scope: 'union',
          governedModelId: 'ok-model',
        }),
      ).toEqual({ kind: 'allowed' });
      // A newly reported client 401 also withdraws a previously accepted daemon generation.
      online = false;
      await expect(
        provision(graph, {
          ...params,
          expectedCredentialDigest: digest('csk-first'),
          expectedCredentialGeneration: 1,
        }),
      ).resolves.toMatchObject({
        status: 'unchanged',
        custody: { sessionExpired: true },
      });
      expect(await services.authority.read()).toMatchObject({
        provenance: { credential: 'rejected' },
      });
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('requires connection trust for provisioning, clear and digest-bearing results', async () => {
    const { graph, services } = serve();
    await graph.start();
    const untrusted: CanopyCallerDescriptor = {
      ...client,
      grants: ['core.integration.read', 'core.integration.write'],
    };
    try {
      for (const entry of [json({ apiKey: 'csk-untrusted' }), null]) {
        await expect(
          kindOf(
            provision(
              graph,
              {
                entry,
                endpointAuthority: cloudAccountEndpointAuthority(endpoint),
                expectedCredentialDigest: null,
              },
              untrusted,
            ),
          ),
        ).resolves.toMatchObject({ kind: 'permission_denied' });
      }
      await expect(
        kindOf(
          graph.dispatcher.query(
            'core.integration.cloudAccount.custody.get',
            {},
            {
              caller: untrusted,
            },
          ),
        ),
      ).resolves.toMatchObject({ kind: 'permission_denied' });
      await expect(
        kindOf(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.refresh',
            {},
            {
              caller: untrusted,
            },
          ),
        ),
      ).resolves.toMatchObject({ kind: 'permission_denied' });
      expect((await services.authority.read()).kind).toBe('inactive');
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('holds no account until a client provisions one', async () => {
    const { graph, services, requests } = serve();
    await graph.start();
    await expect(services.start()).resolves.toBe(false);
    await expect(
      graph.dispatcher.query(
        'core.integration.cloudAccount.custody.get',
        {},
        { caller: client },
      ),
    ).resolves.toEqual({
      state: 'inactive',
      endpointAuthority:
        '["https://cloud.example.test","canopy","desktop-app"]',
      credentialGeneration: null,
      credentialDigest: null,
      sessionExpired: false,
      entry: null,
    });
    await expect(
      kindOf(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.refresh',
          {},
          { caller: client },
        ),
      ),
    ).resolves.toEqual({
      kind: 'failed_precondition',
      code: 'core.integration.cloudAccount.custodyInactive',
    });
    // Disconnect and reset of nothing answer signed out, as the app does.
    await expect(
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client },
      ),
    ).resolves.toEqual({ account: { connected: false, kind: 'none' } });
    // Browser sign-in stays with the client.
    await expect(
      kindOf(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.signIn.start',
          {},
          { caller: client, metadata: { idempotencyKey: 'sign-in-1' } },
        ),
      ),
    ).resolves.toMatchObject({ kind: 'capability_unavailable' });
    expect(requests).toEqual([]);
    await graph.shutdown('test');
    await services.dispose();
  });

  it('answers a refresh in every custody state as its contract says', async () => {
    let online = false;
    let locked = false;
    const { graph, services, requests } = serve(
      (url) =>
        !online
          ? { status: 503, body: null }
          : url.endsWith('/.well-known/canopy')
            ? { status: 200, body: { capabilities: accountBody.capabilities } }
            : {
                status: 200,
                body: {
                  ...accountBody,
                  organizations: entry().organizations,
                  enforcedSettings: [],
                },
              },
      () => locked,
    );
    const refresh = (): Promise<unknown> =>
      graph.dispatcher
        .instruction(
          'core.integration.cloudAccount.refresh',
          {},
          {
            caller: client,
          },
        )
        .then((result) => CoreCloudAccountRefreshResultSchema.parse(result));
    // The wire never carries `inactive`: inactive custody is an error.
    expect(CLOUD_ACCOUNT_REFRESH_OUTCOMES).not.toContain('inactive');
    await graph.start();
    try {
      // Inactive: never provisioned on this daemon.
      await expect(kindOf(refresh())).resolves.toEqual({
        kind: 'failed_precondition',
        code: 'core.integration.cloudAccount.custodyInactive',
      });
      expect(requests).toEqual([]);
      // A clear of never-provisioned custody activates it signed out.
      const neverProvisioned = await provision(graph, {
        entry: null,
        expectedCredentialDigest: null,
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialGeneration: 0,
      });
      expect(neverProvisioned).toMatchObject({
        status: 'cleared',
        custody: { state: 'active', entry: null },
      });
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'no-key',
        custody: { state: 'active', entry: null },
      });
      expect(requests).toEqual([]);
      // Active with a refused generation: offline keeps the refusal.
      const params: CoreCloudAccountProvisionParams = {
        entry: json(entry()),
        expectedCredentialDigest: null,
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialGeneration:
          neverProvisioned.custody.credentialGeneration ?? -1,
        credentialRejected: true,
      };
      await expect(provision(graph, params)).resolves.toMatchObject({
        status: 'provisioned',
      });
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'offline',
        custody: { state: 'active', sessionExpired: true },
      });
      // Active with a record: an authenticated probe applies and verifies.
      online = true;
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'applied',
        custody: { state: 'active', sessionExpired: false },
      });
      expect(await services.authority.read()).toMatchObject({
        provenance: { credential: 'accepted' },
      });
      // Unreadable: a typed storage error, never signed out, and no request.
      locked = true;
      const before = requests.length;
      await expect(kindOf(refresh())).resolves.toEqual({
        kind: 'unavailable',
        code: 'core.integration.cloudAccount.storageUnavailable',
      });
      expect(requests).toHaveLength(before);
      locked = false;
      // Active and signed out by a generation-qualified clear: no-key, no request.
      const read = await services.authority.read();
      if (read.kind !== 'ok') throw new Error('Expected readable custody.');
      await expect(
        provision(graph, {
          ...params,
          entry: null,
          expectedCredentialDigest: digest('csk-first'),
          expectedCredentialGeneration: read.credentialGeneration,
        }),
      ).resolves.toMatchObject({ status: 'cleared' });
      const cleared = requests.length;
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'no-key',
        billingStatesRefreshed: false,
        custody: { state: 'active', entry: null },
      });
      expect(requests).toHaveLength(cleared);
      // Signed out by disconnect: the same.
      const signedOut = await services.authority.read();
      if (signedOut.kind !== 'ok')
        throw new Error('Expected readable custody.');
      await expect(
        provision(graph, {
          ...params,
          credentialRejected: false,
          expectedCredentialGeneration: signedOut.credentialGeneration,
        }),
      ).resolves.toMatchObject({ status: 'provisioned' });
      await expect(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.disconnect',
          {},
          { caller: client },
        ),
      ).resolves.toEqual({ account: { connected: false, kind: 'none' } });
      const disconnected = requests.length;
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'no-key',
        custody: { state: 'active', entry: null },
      });
      expect(requests).toHaveLength(disconnected);
      // Shutdown ends refresh with `unavailable` and leaves custody unchanged.
      await services.dispose();
      await expect(refresh()).resolves.toMatchObject({
        outcome: 'unavailable',
        custody: { state: 'active', entry: null },
      });
      expect(requests).toHaveLength(disconnected);
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('answers a custody read that waits out the account queue as retryable busy', async () => {
    const { custody } = custodyFor();
    const gates: PromiseWithResolvers<void>[] = [];
    const entered = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const authority = createCloudAccountAuthority({
      custody: {
        ...custody,
        commit: async (input) => {
          const gate = Promise.withResolvers<void>();
          entered[gates.length]?.resolve();
          gates.push(gate);
          await gate.promise;
          return custody.commit(input);
        },
      },
      // Long enough that the queued write below never times out under load.
      queueTimeoutMs: 250,
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [
        createCloudAccountModule({
          endpointAuthority: null,
          authority,
          // Provision's admission refresh stays offline, so it writes nothing.
          refresher: createCloudAccountRefresher({
            authority,
            buildSnapshot: () => null,
            probe: (): Promise<CloudAccountProbe> =>
              Promise.resolve({ kind: 'offline' }),
          }),
          probe: () => Promise.reject(new Error('No probe expected.')),
        }),
      ],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    await graph.start();
    try {
      const held = authority.provision(entry(), null);
      await entered[0]?.promise;
      await expect(
        graph.dispatcher.query(
          'core.integration.cloudAccount.custody.get',
          {},
          { caller: client },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.integration.cloudAccount.busy',
          retry: { kind: 'same_request' },
        },
      });
      gates[0]?.resolve();
      await expect(held).resolves.toMatchObject({ kind: 'provisioned' });

      // A provision reports its own committed write, not busy or unavailable,
      // while a later write holds the queue.
      const provisioning = provision(graph, {
        entry: json(entry({ apiKey: 'csk-second' })),
        endpointAuthority: null,
        expectedCredentialDigest: digest('csk-first'),
        expectedCredentialGeneration: 1,
      });
      await entered[1]?.promise;
      const queued = authority.provision(
        entry({ apiKey: 'csk-third' }),
        digest('csk-second'),
      );
      gates[1]?.resolve();
      await expect(provisioning).resolves.toMatchObject({
        status: 'provisioned',
        custody: {
          state: 'active',
          credentialGeneration: 2,
          credentialDigest: digest('csk-second'),
        },
      });
      await entered[2]?.promise;
      gates[2]?.resolve();
      await expect(queued).resolves.toMatchObject({ kind: 'provisioned' });
      await expect(
        graph.dispatcher.query(
          'core.integration.cloudAccount.custody.get',
          {},
          { caller: client },
        ),
      ).resolves.toMatchObject({ state: 'active', credentialGeneration: 3 });
    } finally {
      for (const gate of gates) gate.resolve();
      await graph.shutdown('test');
    }
  });

  /**
   * The module over an authority whose next commit after `hold()` waits until
   * `release()`, keeping the account queue: a write queued behind it times
   * out as `busy`, and one that skipped the queue would commit.
   */
  function heldQueue(
    probe: () => Promise<CloudAccountProbe>,
    onResult?: (result: CloudAccountRefreshResult) => void,
  ): {
    authority: CloudAccountAuthority;
    graph: ReturnType<typeof createRuntimeProfileGraph>;
    hold: () => void;
    /** Settles once the held write reaches its commit. */
    entered: Promise<void>;
    release: () => void;
  } {
    const { custody } = custodyFor();
    let holding = false;
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const authority = createCloudAccountAuthority({
      custody: {
        ...custody,
        commit: async (input) => {
          if (holding) {
            holding = false;
            entered.resolve();
            await gate.promise;
          }
          return custody.commit(input);
        },
      },
      // Only writes queued behind a held one wait this long, so load can't
      // time out the others.
      queueTimeoutMs: 100,
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [
        createCloudAccountModule({
          endpointAuthority: null,
          authority,
          refresher: createCloudAccountRefresher({
            authority,
            buildSnapshot: buildCloudAccountSnapshot,
            probe,
            ...(onResult ? { onResult } : {}),
          }),
          probe: () => Promise.reject(new Error('No probe expected.')),
        }),
      ],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    return {
      authority,
      graph,
      hold: (): void => {
        holding = true;
      },
      entered: entered.promise,
      release: (): void => {
        holding = false;
        gate.resolve();
      },
    };
  }

  const authenticated: CloudAccountProbe = {
    kind: 'authenticated',
    capabilities: accountBody.capabilities,
    payload: {
      ...accountBody,
      organizations: entry().organizations,
      enforcedSettings: [],
    },
  };

  const refreshThrough = (
    graph: ReturnType<typeof createRuntimeProfileGraph>,
  ): Promise<unknown> =>
    graph.dispatcher
      .instruction(
        'core.integration.cloudAccount.refresh',
        {},
        { caller: client },
      )
      .then((result) => CoreCloudAccountRefreshResultSchema.parse(result));

  it('answers an applied refresh as applied while a later write holds the queue', async () => {
    let afterApplied: (() => void) | undefined;
    const queue = heldQueue(
      () => Promise.resolve(authenticated),
      (result) => {
        if (result.outcome !== 'applied') return;
        afterApplied?.();
        afterApplied = undefined;
      },
    );
    let later: ReturnType<CloudAccountAuthority['provision']> | undefined;
    // Runs once the refresh's own save has left the queue, before its
    // operation reads the result.
    afterApplied = (): void => {
      queue.hold();
      later = queue.authority.provision(
        entry({ apiKey: 'csk-second' }),
        digest('csk-first'),
      );
    };
    await queue.graph.start();
    try {
      await expect(
        queue.authority.provision(entry(), null),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      await expect(refreshThrough(queue.graph)).resolves.toMatchObject({
        outcome: 'applied',
        custody: {
          state: 'active',
          credentialGeneration: 1,
          credentialDigest: digest('csk-first'),
        },
      });
      expect(later).toBeDefined();
      await queue.entered;
      queue.release();
      await expect(later).resolves.toMatchObject({ kind: 'provisioned' });
    } finally {
      queue.release();
      await queue.graph.shutdown('test');
    }
  });

  it("fails a refresh whose own save can't take the queue as retryable busy, writing nothing", async () => {
    const answer = Promise.withResolvers<CloudAccountProbe>();
    const probed = Promise.withResolvers<void>();
    let probes = 0;
    const queue = heldQueue(() => {
      probes += 1;
      if (probes === 1) return Promise.resolve(authenticated);
      probed.resolve();
      return answer.promise;
    });
    await queue.graph.start();
    try {
      await expect(
        queue.authority.provision(entry(), null),
      ).resolves.toMatchObject({ kind: 'provisioned' });
      // Verified first, so a busy refresh has trust it could wrongly drop.
      await expect(refreshThrough(queue.graph)).resolves.toMatchObject({
        outcome: 'applied',
      });
      const before = await queue.authority.read();
      expect(before).toMatchObject({
        kind: 'ok',
        record: { apiKey: 'csk-first' },
        provenance: { credential: 'accepted', membership: true, policy: true },
      });
      const refreshing = refreshThrough(queue.graph);
      await probed.promise;
      queue.hold();
      const held = queue.authority.provision(
        entry({ apiKey: 'csk-second' }),
        digest('csk-first'),
      );
      await queue.entered;
      // A changed account, so a save that slipped past the queue would show.
      answer.resolve({
        ...authenticated,
        payload: {
          ...accountBody,
          account: {
            id: 'account-1',
            name: 'B',
            email: 'a@example.test',
            role: 'ADMIN',
          },
          organizations: entry().organizations,
          enforcedSettings: [],
        },
      });
      await expect(refreshing).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.integration.cloudAccount.busy',
          retry: { kind: 'same_request' },
        },
      });
      // Record and provenance, as stored before the refresh.
      await expect(queue.authority.read()).resolves.toEqual(before);
      queue.release();
      await expect(held).resolves.toMatchObject({ kind: 'provisioned' });
    } finally {
      queue.release();
      await queue.graph.shutdown('test');
    }
  });

  it("provisions when its admission refresh's save times out on the queue, leaving the key unverified", async () => {
    const answer = Promise.withResolvers<CloudAccountProbe>();
    const probed = Promise.withResolvers<void>();
    const results: CloudAccountRefreshResult[] = [];
    const queue = heldQueue(
      () => {
        probed.resolve();
        return answer.promise;
      },
      (result) => results.push(result),
    );
    await queue.graph.start();
    try {
      const provisioning = provision(queue.graph, {
        entry: json(entry()),
        endpointAuthority: null,
        expectedCredentialDigest: null,
      });
      await probed.promise;
      queue.hold();
      const held = queue.authority.provision(
        entry({ apiKey: 'csk-second' }),
        digest('csk-first'),
      );
      await queue.entered;
      answer.resolve(authenticated);
      await expect(provisioning).resolves.toMatchObject({
        status: 'provisioned',
        custody: {
          state: 'active',
          credentialGeneration: 1,
          credentialDigest: digest('csk-first'),
        },
      });
      expect(results).toEqual([
        {
          outcome: 'unavailable',
          billingStatesRefreshed: false,
          failure: { kind: 'unavailable', reason: 'busy' },
        },
      ]);
      // Only this daemon's own applied probe verifies the key.
      await expect(queue.authority.read()).resolves.toMatchObject({
        kind: 'ok',
        record: { apiKey: 'csk-first' },
        provenance: { credential: 'unknown' },
      });
      queue.release();
      await expect(held).resolves.toMatchObject({ kind: 'provisioned' });
    } finally {
      queue.release();
      await queue.graph.shutdown('test');
    }
  });

  it.each([
    { signedOut: false, qualified: false },
    { signedOut: false, qualified: true },
    { signedOut: true, qualified: false },
    { signedOut: true, qualified: true },
  ])(
    'fences late desktop provisioning with an empty clear (%j)',
    async ({ signedOut, qualified }) => {
      const { graph, services } = serve();
      await graph.start();
      try {
        const params = {
          entry: json(entry()),
          endpointAuthority: cloudAccountEndpointAuthority(endpoint),
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        };
        let generation = 0;
        if (signedOut) {
          const connected = await provision(graph, params);
          const cleared = await provision(graph, {
            ...params,
            entry: null,
            expectedCredentialDigest: digest('csk-first'),
            expectedCredentialGeneration:
              connected.custody.credentialGeneration ?? 0,
          });
          if (cleared.custody.credentialGeneration === null)
            throw new Error('Missing clear generation');
          generation = cleared.custody.credentialGeneration;
        }
        // This intent was captured before disconnect but has not reached the
        // daemon, so no connect receipt can tell the clear about it.
        const delayed = { ...params, expectedCredentialGeneration: generation };
        const clear = {
          endpointAuthority: params.endpointAuthority,
          entry: null,
          expectedCredentialDigest: null,
          ...(qualified ? { expectedCredentialGeneration: generation } : {}),
        };
        await expect(provision(graph, clear)).resolves.toMatchObject({
          status: 'cleared',
          custody: { entry: null, credentialGeneration: generation + 1 },
        });
        await expect(provision(graph, delayed)).resolves.toMatchObject({
          status: 'superseded',
          custody: { entry: null, credentialGeneration: generation + 1 },
        });
        // A qualified replay is stale and writes nothing. A digest-only clear
        // is indistinguishable from another disconnect and advances the fence.
        const latest = generation + (qualified ? 1 : 2);
        await expect(provision(graph, clear)).resolves.toMatchObject({
          status: qualified ? 'superseded' : 'cleared',
          custody: { entry: null, credentialGeneration: latest },
        });
        await expect(
          provision(graph, {
            ...delayed,
            expectedCredentialGeneration: latest,
          }),
        ).resolves.toMatchObject({ status: 'provisioned' });
      } finally {
        await graph.shutdown('test');
        await services.dispose();
      }
    },
  );

  it('fences provision and disconnect across signed-out and same-key ABA', async () => {
    const { graph, services } = serve();
    await graph.start();
    try {
      const params = {
        entry: json(entry()),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: null,
        expectedCredentialGeneration: 0,
      };
      const connected = await provision(graph, params);
      const firstGeneration = connected.custody.credentialGeneration;
      if (firstGeneration === null)
        throw new Error('Missing custody generation');
      await graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        { expectedCredentialGeneration: firstGeneration },
        { caller: client },
      );
      const stale = await provision(graph, params);
      expect(stale.status).toBe('superseded');
      expect(stale.custody.entry).toBeNull();
      const clearedGeneration = stale.custody.credentialGeneration;
      if (clearedGeneration === null)
        throw new Error('Missing clear generation');
      expect(clearedGeneration).toBeGreaterThan(firstGeneration);
      await provision(graph, {
        ...params,
        expectedCredentialGeneration: clearedGeneration,
      });
      await expect(
        kindOf(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.disconnect',
            { expectedCredentialGeneration: firstGeneration },
            { caller: client },
          ),
        ),
      ).resolves.toMatchObject({ kind: 'conflict' });
      const current = await services.authority.read();
      expect(current.kind === 'ok' && current.record?.apiKey).toBe(
        entry().apiKey,
      );
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('reports a stale disconnect fence against an absent, signed-out or guest account', async () => {
    const { graph, services } = serve();
    await graph.start();
    try {
      const endpointAuthority = cloudAccountEndpointAuthority(endpoint);
      const disconnect = (params: {
        expectedCredentialGeneration?: number;
      }): Promise<unknown> =>
        graph.dispatcher
          .instruction('core.integration.cloudAccount.disconnect', params, {
            caller: client,
          })
          .catch((error: unknown) =>
            error instanceof CanopyOperationError ? error.payload : error,
          );
      const stale = {
        kind: 'conflict',
        retry: {
          kind: 'after_refresh',
          resource: 'core.integration.cloudAccount.custody.get',
        },
      };

      // Never provisioned: a stale fence writes nothing.
      await expect(
        disconnect({ expectedCredentialGeneration: 1 }),
      ).resolves.toMatchObject(stale);
      await expect(services.custody.read()).resolves.toMatchObject({
        kind: 'absent',
      });
      // Signed out: the current fence clears again, a stale one conflicts.
      await expect(
        disconnect({ expectedCredentialGeneration: 0 }),
      ).resolves.toEqual({ account: { connected: false, kind: 'none' } });
      const signedOut = await services.custody.read();
      await expect(
        disconnect({ expectedCredentialGeneration: 0 }),
      ).resolves.toMatchObject(stale);
      await expect(services.custody.read()).resolves.toEqual(signedOut);

      const regular = await provision(graph, {
        entry: json(entry()),
        endpointAuthority,
        expectedCredentialDigest: null,
        expectedCredentialGeneration: 1,
      });
      expect(regular.status).toBe('provisioned');
      const regularGeneration = regular.custody.credentialGeneration;
      if (regularGeneration === null)
        throw new Error('Missing custody generation');
      const guest = await provision(graph, {
        entry: json(guestEntry()),
        endpointAuthority,
        expectedCredentialDigest: digest('csk-first'),
        expectedCredentialGeneration: regularGeneration,
      });
      expect(guest.status).toBe('provisioned');
      expect(guest.custody.credentialGeneration).toBe(regularGeneration + 1);
      const guestHeld = await services.custody.read();
      await expect(
        disconnect({ expectedCredentialGeneration: regularGeneration }),
      ).resolves.toMatchObject(stale);
      await expect(services.custody.read()).resolves.toEqual(guestHeld);
      // The current fence and the legacy unfenced form keep the guest, as before.
      for (const params of [
        { expectedCredentialGeneration: regularGeneration + 1 },
        {},
      ])
        await expect(disconnect(params)).resolves.toEqual({
          account: { connected: true, kind: 'guest' },
        });
      await expect(services.custody.read()).resolves.toEqual(guestHeld);
    } finally {
      await graph.shutdown('test');
    }
  });

  /** A module over custody whose commits can be held, before or after they land. */
  function heldCommits(queueTimeoutMs = 250): {
    graph: ReturnType<typeof createRuntimeProfileGraph>;
    authority: CloudAccountAuthority;
    hold: (when: 'before' | 'after') => {
      readonly reached: Promise<void>;
      readonly release: () => void;
    };
  } {
    const { custody } = custodyFor();
    let held:
      | {
          readonly when: 'before' | 'after';
          readonly reached: PromiseWithResolvers<void>;
          readonly gate: PromiseWithResolvers<void>;
        }
      | undefined;
    const authority = createCloudAccountAuthority({
      custody: {
        ...custody,
        commit: async (input) => {
          const current = held;
          held = undefined;
          if (current?.when === 'before') {
            current.reached.resolve();
            await current.gate.promise;
          }
          const result = await custody.commit(input);
          if (current?.when === 'after') {
            current.reached.resolve();
            await current.gate.promise;
          }
          return result;
        },
      },
      queueTimeoutMs,
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [
        createCloudAccountModule({
          endpointAuthority: null,
          authority,
          // Provision's admission refresh stays offline, so it writes nothing.
          refresher: createCloudAccountRefresher({
            authority,
            buildSnapshot: () => null,
            probe: (): Promise<CloudAccountProbe> =>
              Promise.resolve({ kind: 'offline' }),
          }),
          probe: () => Promise.reject(new Error('No probe expected.')),
        }),
      ],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    return {
      graph,
      authority,
      hold: (when) => {
        const next = {
          when,
          reached: Promise.withResolvers<void>(),
          gate: Promise.withResolvers<void>(),
        };
        held = next;
        return {
          reached: next.reached.promise,
          release: () => next.gate.resolve(),
        };
      },
    };
  }

  it('never advises replaying a disconnect or provision that may have committed', async () => {
    const { graph, authority, hold } = heldCommits();
    await graph.start();
    const soon = (): { deadlineAt: string } => ({
      // Long enough under host load for the held write to land first.
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    });
    try {
      await expect(authority.provision(entry(), null)).resolves.toMatchObject({
        kind: 'provisioned',
        credentialGeneration: 1,
      });
      // The legacy unfenced clear lands, but its caller only sees the deadline.
      const landed = hold('after');
      const disconnect = graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client, metadata: soon() },
      );
      await expect(disconnect).rejects.toMatchObject({
        payload: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
      });
      await landed.reached;
      landed.release();
      await expect(
        authority.read({ settleMutations: true }),
      ).resolves.toMatchObject({ record: null, credentialGeneration: 2 });

      // A replacement provisioned meanwhile is not cleared by a fenced replay.
      await expect(
        authority.provision(
          entry({ apiKey: 'csk-second' }),
          null,
          undefined,
          2,
        ),
      ).resolves.toMatchObject({
        kind: 'provisioned',
        credentialGeneration: 3,
      });
      await expect(
        kindOf(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.disconnect',
            { expectedCredentialGeneration: 1 },
            { caller: client },
          ),
        ),
      ).resolves.toEqual({ kind: 'conflict', code: null });
      await expect(authority.read()).resolves.toMatchObject({
        record: { apiKey: 'csk-second' },
      });

      // A provision is not ABA-proof without its generation, so neither is it
      // replayed once it may have landed.
      const provisioned = hold('after');
      await expect(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.provision',
          {
            entry: json(entry({ apiKey: 'csk-third' })),
            endpointAuthority: null,
            expectedCredentialDigest: digest('csk-second'),
          },
          { caller: client, metadata: soon() },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
      });
      await provisioned.reached;
      provisioned.release();
      await expect(
        authority.read({ settleMutations: true }),
      ).resolves.toMatchObject({ record: { apiKey: 'csk-third' } });
    } finally {
      await graph.shutdown('test');
    }
  });

  it('retries a busy disconnect only when its generation fences it', async () => {
    const { graph, authority, hold } = heldCommits(50);
    await graph.start();
    try {
      await authority.provision(entry(), null);
      const queue = hold('before');
      const holding = authority.provision(null, digest('csk-first'));
      await queue.reached;
      const busy = (params: {
        expectedCredentialGeneration?: number;
      }): Promise<unknown> =>
        graph.dispatcher
          .instruction('core.integration.cloudAccount.disconnect', params, {
            caller: client,
          })
          .then(
            () => null,
            (error: unknown) =>
              error instanceof CanopyOperationError ? error.payload : error,
          );
      const [unfenced, fenced] = await Promise.all([
        busy({}),
        busy({ expectedCredentialGeneration: 1 }),
      ]);
      expect(unfenced).toMatchObject({
        kind: 'unavailable',
        retry: { kind: 'never' },
      });
      expect(fenced).toMatchObject({
        kind: 'unavailable',
        retry: { kind: 'same_request' },
      });
      queue.release();
      await expect(holding).resolves.toMatchObject({ kind: 'cleared' });
    } finally {
      await graph.shutdown('test');
    }
  });

  it('keeps a guest that lands while a fenced disconnect waits', async () => {
    const { graph, authority, hold } = heldCommits();
    await graph.start();
    try {
      await authority.provision(entry(), null);
      const queue = hold('before');
      const replacing = authority.provision(
        guestEntry(),
        digest('csk-first'),
        undefined,
        1,
      );
      await queue.reached;
      // Queues behind the guest's write, so it observes the guest.
      const disconnect = kindOf(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.disconnect',
          { expectedCredentialGeneration: 1 },
          { caller: client },
        ),
      );
      // The memory vault settles in microtasks: disconnect is queued by now.
      await new Promise((resolve) => setImmediate(resolve));
      queue.release();
      await expect(replacing).resolves.toMatchObject({
        kind: 'provisioned',
        credentialGeneration: 2,
      });
      await expect(disconnect).resolves.toEqual({
        kind: 'conflict',
        code: null,
      });
      await expect(
        authority.read({ settleMutations: true }),
      ).resolves.toMatchObject({
        record: { apiKey: 'csk-guest' },
        credentialGeneration: 2,
      });
    } finally {
      await graph.shutdown('test');
    }
  });

  it.each([{}, { expectedCredentialGeneration: 1 }])(
    'completes a disconnect whose first read overlaps a custody write (%j)',
    async (params) => {
      const { custody, memory } = custodyFor();
      const authority = createCloudAccountAuthority({
        custody,
        queueTimeoutMs: 1_000,
      });
      const graph = createRuntimeProfileGraph({
        profile: 'core',
        modules: [
          createCloudAccountModule({
            endpointAuthority: null,
            authority,
            // Disconnect refreshes nothing; an offline refresh would write nothing.
            refresher: createCloudAccountRefresher({
              authority,
              buildSnapshot: () => null,
              probe: (): Promise<CloudAccountProbe> =>
                Promise.resolve({ kind: 'offline' }),
            }),
            probe: () => Promise.reject(new Error('No probe expected.')),
          }),
        ],
        identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
        phaseDeadlineMs: 1000,
        shutdownTimeoutMs: 50,
      });
      await graph.start();
      let held: ReturnType<typeof memory.holdNextCommit> | undefined;
      try {
        await expect(authority.provision(entry(), null)).resolves.toMatchObject(
          { kind: 'provisioned', credentialGeneration: 1 },
        );
        // Unreleased, so the next write waits at the vault. An imported client
        // 401 writes without advancing the generation the fence names.
        held = memory.holdNextCommit();
        const rejecting = authority.provision(
          entry(),
          digest('csk-first'),
          undefined,
          1,
          true,
        );
        // The memory vault settles in microtasks: the write is mid-commit.
        await new Promise((resolve) => setImmediate(resolve));
        await expect(authority.read()).resolves.toMatchObject({
          kind: 'unavailable',
        });
        const disconnect = graph.dispatcher
          .instruction('core.integration.cloudAccount.disconnect', params, {
            caller: client,
          })
          .catch((error: unknown) =>
            error instanceof CanopyOperationError ? error.payload : error,
          );
        await new Promise((resolve) => setImmediate(resolve));
        held.release({ kind: 'committed' });
        await expect(rejecting).resolves.toMatchObject({
          kind: 'unchanged',
          credentialGeneration: 1,
        });
        await expect(disconnect).resolves.toEqual({
          account: { connected: false, kind: 'none' },
        });
        await expect(
          authority.read({ settleMutations: true }),
        ).resolves.toMatchObject({ record: null, credentialGeneration: 2 });
      } finally {
        held?.release({ kind: 'committed' });
        await graph.shutdown('test');
      }
    },
  );

  it.each(['   ', '\u201ccsk-quoted\u201d', 'csk-nb\u00a0sp', 'csk-in\tner'])(
    'refuses a key no request can carry before writing anything (%j)',
    async (apiKey) => {
      const { graph, services, requests } = serve();
      await graph.start();
      const connect = (): Promise<unknown> =>
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.connectWithKey',
          { apiKey },
          { caller: client, metadata: { idempotencyKey: 'malformed' } },
        );
      const refused = {
        payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
      };
      try {
        await expect(connect()).rejects.toMatchObject(refused);
        // An inactive daemon stays without a record.
        await expect(services.custody.read()).resolves.toEqual({
          kind: 'absent',
        });
        expect(requests).toEqual([]);
        await provision(graph, {
          entry: json(entry()),
          endpointAuthority: cloudAccountEndpointAuthority(endpoint),
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        });
        // Provision's own admission refresh (CAN-7700) may probe; the refused
        // connect below must add nothing to it.
        const admitted = [...requests];
        const before = await services.custody.read();
        await expect(connect()).rejects.toMatchObject(refused);
        // No connect receipt, no probe.
        await expect(services.custody.read()).resolves.toEqual(before);
        expect(requests).toEqual(admitted);
      } finally {
        await graph.shutdown('test');
      }
    },
  );

  it('takes a client sign-in as its own record and never returns the key', async () => {
    const { graph, services } = serve();
    await graph.start();
    await expect(
      provision(graph, {
        entry: json(entry()),
        expectedCredentialDigest: null,
        endpointAuthority: cloudAccountEndpointAuthority({
          ...endpoint,
          apiNamespace: 'other',
        }),
      }),
    ).resolves.toMatchObject({
      status: 'invalid',
      custody: { state: 'inactive' },
    });
    expect(await services.authority.read()).toEqual({ kind: 'inactive' });
    const first = await provision(graph, {
      entry: json(entry()),
      endpointAuthority: cloudAccountEndpointAuthority(endpoint),
      expectedCredentialDigest: null,
    });
    expect(first).toMatchObject({
      status: 'provisioned',
      custody: {
        state: 'active',
        credentialGeneration: 1,
        credentialDigest: digest('csk-first'),
      },
    });
    expect(JSON.stringify(first)).not.toContain('csk-first');
    expect(first.custody.endpointAuthority).toBe(
      cloudAccountEndpointAuthority(endpoint),
    );
    // Reconnection cannot replace the daemon-owned policy snapshot.
    await expect(
      provision(graph, {
        entry: json(entry()),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-first'),
      }),
    ).resolves.toMatchObject({ status: 'unchanged' });
    await expect(
      provision(graph, {
        entry: json(entry({ updatedAt: '2026-11-02T00:00:00.000Z' })),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-first'),
      }),
    ).resolves.toMatchObject({
      status: 'unchanged',
      custody: { credentialGeneration: 1 },
    });
    // The client's loss handoff stays the client's.
    const read = await services.authority.read();
    expect(read.kind === 'ok' && read.record?.organizationAccessLossState).toBe(
      null,
    );
    // Replacement advances the generation; a stale provision is superseded.
    await expect(
      provision(graph, {
        entry: json(entry({ apiKey: 'csk-second' })),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-first'),
      }),
    ).resolves.toMatchObject({
      status: 'provisioned',
      custody: {
        credentialGeneration: 2,
        credentialDigest: digest('csk-second'),
      },
    });
    await expect(
      provision(graph, {
        entry: json(entry({ apiKey: 'csk-third' })),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-first'),
      }),
    ).resolves.toMatchObject({
      status: 'superseded',
      custody: { credentialDigest: digest('csk-second') },
    });
    // Sign-out clears the daemon's record too; an entry without a key is refused.
    await expect(
      provision(graph, {
        entry: null,
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-second'),
      }),
    ).resolves.toMatchObject({
      status: 'cleared',
      custody: { state: 'active', credentialDigest: null, entry: null },
    });
    await expect(
      kindOf(
        provision(graph, {
          entry: json(entry({ apiKey: '' })),
          endpointAuthority: cloudAccountEndpointAuthority(endpoint),
          expectedCredentialDigest: null,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_argument' });
    await graph.shutdown('test');
    await services.dispose();
  });

  it('provisions and reads a whole account larger than error-detail limits', async () => {
    const { graph, services } = serve();
    await graph.start();
    try {
      const large = entry({
        teams: Array.from({ length: 1_100 }, (_, index) => ({
          id: `team-${index}`,
        })),
        futurePolicy: 'x'.repeat(40_000),
      });
      const result = await provision(graph, {
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: null,
        entry: json(large),
      });
      expect(result.status).toBe('provisioned');
      expect(result.custody.entry?.teams).toEqual(large.teams);
      expect(result.custody.entry?.futurePolicy).toEqual(large.futurePolicy);
      expect(result.custody.entry).not.toHaveProperty('apiKey');
      await expect(
        graph.dispatcher.query(
          'core.integration.cloudAccount.custody.get',
          {},
          { caller: client },
        ),
      ).resolves.toEqual(result.custody);
      await expect(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.refresh',
          {},
          { caller: client },
        ),
      ).resolves.toMatchObject({ outcome: 'offline', custody: result.custody });
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('refreshes the provisioned record on timer ticks with no client connected and stops at shutdown', async () => {
    // Only the clock is faked: promise and stream plumbing stay real.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
    // Spied after faking so each spy wraps the fake clock.
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    let refreshTimer: unknown;
    let clearedBeforeVaultClose: boolean | undefined;
    const { graph, services, requests, results } = serve(
      (url, authorization) =>
        url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: accountBody.capabilities } }
          : authorization === 'Bearer csk-revoked'
            ? { status: 401, body: { error: 'revoked' } }
            : { status: 200, body: accountBody },
      undefined,
      () => {
        clearedBeforeVaultClose = clearIntervalSpy.mock.calls.some(
          ([handle]) => handle === refreshTimer,
        );
      },
    );
    const accountProbes = (): number =>
      requests.filter(
        (request) =>
          request ===
          'https://cloud.example.test/api/v1/desktop-app/account Bearer csk-first',
      ).length;
    // Settles in-flight refreshes without reaching the 60 s interval.
    const settle = async (): Promise<void> => {
      for (let step = 0; step < 20; step += 1)
        await jest.advanceTimersByTimeAsync(10);
    };
    let shutDown = false;
    try {
      await graph.start();
      await provision(graph, {
        entry: json(entry()),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: null,
      });
      await settle();
      expect(results[0]).toEqual({
        outcome: 'applied',
        billingStatesRefreshed: false,
      });
      expect(requests).toContain(
        'https://cloud.example.test/api/v1/desktop-app/account Bearer csk-first',
      );
      // Provisioning armed the daemon's own timer: each interval probes again
      // and persists its answer, with no client asking.
      const armed = setIntervalSpy.mock.calls.flatMap(
        ([, delay], index): unknown[] =>
          delay === 60_000 ? [setIntervalSpy.mock.results[index]?.value] : [],
      );
      expect(armed).toHaveLength(1);
      refreshTimer = armed[0];
      expect(refreshTimer).toBeDefined();
      for (let tick = 0; tick < 2; tick += 1) {
        const probes = accountProbes();
        const reported = results.length;
        await jest.advanceTimersByTimeAsync(60_000);
        await settle();
        expect(accountProbes()).toBe(probes + 1);
        expect(results.slice(reported)).toEqual([
          { outcome: 'applied', billingStatesRefreshed: false },
        ]);
      }
      // A revoked replacement expires the daemon session; it is not a sign-out.
      await provision(graph, {
        entry: json(entry({ apiKey: 'csk-revoked' })),
        endpointAuthority: cloudAccountEndpointAuthority(endpoint),
        expectedCredentialDigest: digest('csk-first'),
      });
      await expect(
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.refresh',
          {},
          { caller: client },
        ),
      ).resolves.toMatchObject({
        outcome: 'unauthenticated',
        custody: {
          sessionExpired: true,
          credentialDigest: digest('csk-revoked'),
        },
      });
      // Runtime shutdown alone disarms the timer, before vault teardown.
      expect(clearIntervalSpy).not.toHaveBeenCalledWith(refreshTimer);
      const shutdown = graph.shutdown('test');
      await settle();
      await shutdown;
      shutDown = true;
      expect(clearedBeforeVaultClose).toBe(true);
      const sent = requests.length;
      await jest.advanceTimersByTimeAsync(180_000);
      expect(requests).toHaveLength(sent);
    } finally {
      try {
        if (!shutDown) await graph.shutdown('test');
      } finally {
        await services.dispose();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
        jest.useRealTimers();
      }
    }
  });

  it.each(['a client refresh instruction', 'the periodic refresh'] as const)(
    'drains %s in flight at shutdown before the vault closes',
    async (trigger) => {
      let holding = false;
      let markHeld = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const answer = { status: 200, body: accountBody };
      const { graph, services, results, lateVaultCalls, resultsAtVaultClose } =
        serve((url) => {
          if (url.endsWith('/.well-known/canopy'))
            return {
              status: 200,
              body: { capabilities: accountBody.capabilities },
            };
          if (!holding) return answer;
          markHeld();
          // A slow Cloud answers only after the vault would have closed.
          return released.then(() => answer);
        });
      try {
        await graph.start();
        await provision(graph, {
          entry: json(entry()),
          endpointAuthority: cloudAccountEndpointAuthority(endpoint),
          expectedCredentialDigest: null,
        });
        await services.start();
        await services.refresher.refresh();
        holding = true;
        const caller =
          trigger === 'a client refresh instruction'
            ? kindOf(
                graph.dispatcher.instruction(
                  'core.integration.cloudAccount.refresh',
                  {},
                  { caller: client },
                ),
              )
            : undefined;
        // Arming a timer starts its first periodic refresh at once.
        const disarm =
          trigger === 'the periodic refresh'
            ? services.refresher.start(60_000)
            : undefined;
        await held;
        const reported = results.length;
        await graph.shutdown('test');
        disarm?.();
        // The held refresh settled, unapplied, before the vault closed.
        expect(resultsAtVaultClose()).toBe(reported + 1);
        expect(results.slice(reported)).toEqual([
          { outcome: 'unavailable', billingStatesRefreshed: false },
        ]);
        await caller;
        release();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(lateVaultCalls).toEqual([]);
        expect(results).toHaveLength(reported + 1);
      } finally {
        release();
        await services.dispose();
      }
    },
  );

  it('replays committed sign-in commands without undoing a later replacement or disconnect', async () => {
    const { graph, services, requests } = serve((url) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : { status: 200, body: accountBody },
    );
    await graph.start();
    // This flow qualifies explicit account commands, not periodic refresh.
    await services.refresher.dispose();
    const connect = (
      apiKey: string,
      idempotencyKey: string,
    ): Promise<unknown> =>
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.connectWithKey',
        { apiKey },
        {
          caller: client,
          metadata: { idempotencyKey },
        },
      );
    try {
      const original = await connect('csk-a', 'request-a');
      const first = await services.authority.read();
      if (first.kind !== 'ok') throw new Error('Expected signed-in custody');
      await services.authority.recordCredentialRejected(
        first.credentialGeneration,
      );
      expect(await services.authority.read()).toMatchObject({
        sessionExpired: true,
      });
      await connect('csk-a', 'fresh-probe-a');
      expect(await services.authority.read()).toMatchObject({
        sessionExpired: false,
      });
      await connect('csk-b', 'request-b');
      const count = requests.length;
      await expect(connect('csk-a', 'request-a')).resolves.toEqual(original);
      expect(requests).toHaveLength(count);
      expect(await services.authority.read()).toMatchObject({
        record: { apiKey: 'csk-b' },
      });
      await graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client },
      );
      await expect(connect('csk-a', 'request-a')).resolves.toEqual(original);
      expect(await services.authority.read()).toMatchObject({ record: null });
      for (let index = 0; index < 70; index++)
        await connect('csk-later', `later-${String(index)}`);
      const custody = await services.custody.read();
      if (custody.kind !== 'ok') throw new Error('Expected readable custody');
      expect(Object.keys(custody.document.connectReceipts ?? {})).toHaveLength(
        64,
      );
      const beforeReplay = requests.length;
      await connect('csk-later', 'later-69');
      expect(requests).toHaveLength(beforeReplay);
      // Evicted intent is a fresh explicit sign-in and must probe Cloud again.
      await connect('csk-a', 'request-a');
      expect(requests.length).toBeGreaterThan(beforeReplay);
      expect(await services.authority.read()).toMatchObject({
        record: { apiKey: 'csk-a' },
      });
    } finally {
      await graph.shutdown('test');
      await services.dispose();
    }
  });

  it('keeps a newer completed sign-in receipt when later failed attempts fill the cap', async () => {
    const { graph, services, requests } = serve((url, authorization) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : authorization === 'Bearer csk-revoked'
          ? { status: 401, body: { error: 'revoked' } }
          : { status: 200, body: accountBody },
    );
    await graph.start();
    const connect = (
      apiKey: string,
      idempotencyKey: string,
    ): Promise<unknown> =>
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.connectWithKey',
        { apiKey },
        { caller: client, metadata: { idempotencyKey } },
      );
    const fail = async (index: number): Promise<void> => {
      await expect(
        kindOf(connect('csk-revoked', `failed-${String(index)}`)),
      ).resolves.toMatchObject({ kind: 'permission_denied' });
    };
    try {
      await connect('csk-a', 'initial');
      for (let index = 0; index < 63; index++) await fail(index);
      // Same key and identity: the generation stays, so the failures above
      // remain current incomplete attempts.
      const original = await connect('csk-a', 'request-a');
      await fail(63);
      await graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client },
      );
      const beforeReplay = requests.length;
      await expect(connect('csk-a', 'request-a')).resolves.toEqual(original);
      expect(requests).toHaveLength(beforeReplay);
      expect(await services.authority.read()).toMatchObject({ record: null });
    } finally {
      await graph.shutdown('test');
    }
  });

  it('keeps the membership checkpoint through a same-key sign-in without an organization list', async () => {
    const organization = (id: string): Entry => ({
      id,
      name: id,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    let organizations: unknown = [organization(ORG), organization(OTHER_ORG)];
    const { graph, services } = serve((url) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : {
            status: 200,
            body:
              organizations === undefined
                ? { ...accountBody, organizations: undefined }
                : { ...accountBody, organizations },
          },
    );
    await graph.start();
    try {
      const signIn = async (attempt: string): Promise<unknown> => {
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.connectWithKey',
            { apiKey: 'csk-manual' },
            { caller: client, metadata: { idempotencyKey: attempt } },
          ),
        ).resolves.toEqual({ account: { connected: true, kind: 'apiKey' } });
        const read = await services.authority.read();
        if (read.kind !== 'ok' || !read.record) throw new Error(read.kind);
        return read.record.entry;
      };
      await expect(signIn('first')).resolves.toMatchObject({
        organizationsVerified: true,
      });
      organizations = undefined;
      const partial = await signIn('no-organizations');
      expect(partial).toMatchObject({
        organizationsVerified: false,
        organizationAccessLossState: { organizationIds: [ORG, OTHER_ORG] },
      });
      // A verified organization list still advances it.
      organizations = [organization(ORG)];
      await expect(signIn('verified')).resolves.toMatchObject({
        organizationsVerified: true,
        organizationAccessLossState: { organizationIds: [ORG] },
      });
    } finally {
      await graph.shutdown('test');
    }
  });

  it('stores a key whose account custody cannot identify with provenance that grants nothing', async () => {
    let account: unknown = accountBody.account;
    const { graph, services } = serve((url) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : {
            status: 200,
            body: {
              ...accountBody,
              account,
              organizations: entry().organizations,
              enforcedSettings: [],
            },
          },
    );
    await graph.start();
    try {
      const signIn = async (
        attempt: string,
      ): Promise<{ held: unknown; stored: unknown }> => {
        // Parity with the app: the key still connects.
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.connectWithKey',
            { apiKey: 'csk-manual' },
            { caller: client, metadata: { idempotencyKey: attempt } },
          ),
        ).resolves.toEqual({ account: { connected: true, kind: 'apiKey' } });
        const read = await services.authority.read();
        const stored = await services.custody.read();
        if (read.kind !== 'ok' || stored.kind !== 'ok')
          throw new Error('Expected custody');
        expect(read.record?.apiKey).toBe('csk-manual');
        return { held: read.provenance, stored: stored.document.provenance };
      };
      const granted = {
        credential: 'accepted',
        membership: true,
        policy: true,
      };
      await expect(signIn('identified')).resolves.toMatchObject({
        held: granted,
        stored: granted,
      });
      // An empty account, and one the app cannot normalize, identify nobody.
      const withdrawn = {
        credential: 'unknown',
        membership: false,
        policy: false,
      };
      for (const [attempt, unidentified] of [
        ['empty', {}],
        [
          'unnormalized',
          {
            id: 'account-1',
            name: 'A',
            email: 'a@example.test',
            role: 'OWNER',
          },
        ],
      ] as const) {
        account = unidentified;
        await expect(signIn(attempt)).resolves.toMatchObject({
          held: withdrawn,
          stored: withdrawn,
        });
      }
    } finally {
      await graph.shutdown('test');
    }
  });

  it.each([
    { outcome: 'applied', answer: { status: 200 } },
    { outcome: 'unauthenticated', answer: { status: 401 } },
    { outcome: 'forbidden', answer: { status: 403 } },
    { outcome: 'invalid-snapshot', answer: { status: 200, account: {} } },
  ])(
    'never fails a sign-in with a refresh that lands first ($outcome)',
    async ({ outcome, answer }) => {
      const held: ((answer: CloudAnswer) => void)[] = [];
      let holding = false;
      const accountAnswer = (
        status: number,
        account: unknown = accountBody.account,
      ): CloudAnswer => ({
        status,
        body:
          status === 200
            ? {
                ...accountBody,
                account,
                organizations: entry().organizations,
                enforcedSettings: [],
              }
            : null,
      });
      const { graph, services, results } = serve((url) =>
        url.endsWith('/.well-known/canopy')
          ? { status: 200, body: { capabilities: accountBody.capabilities } }
          : holding
            ? new Promise<CloudAnswer>((resolve) => held.push(resolve))
            : accountAnswer(200),
      );
      const turns = async (until: () => boolean): Promise<void> => {
        for (let turn = 0; !until() && turn < 200; turn += 1)
          await new Promise((resolve) => setImmediate(resolve));
      };
      const signIn = (apiKey: string, attempt: string): Promise<unknown> =>
        graph.dispatcher.instruction(
          'core.integration.cloudAccount.connectWithKey',
          { apiKey },
          { caller: client, metadata: { idempotencyKey: attempt } },
        );
      await graph.start();
      try {
        await expect(signIn('csk-first', 'first')).resolves.toEqual({
          account: { connected: true, kind: 'apiKey' },
        });
        // The first sign-in arms periodic refresh; let its first probe finish.
        await turns(() => results.length === 1);
        holding = true;
        // The sign-in probes first; a refresh of the held key probes after it
        // and answers first.
        const second = signIn('csk-second', 'second');
        await turns(() => held.length === 1);
        let refreshSettled = false;
        const refreshed = services.refresher.refresh().finally(() => {
          refreshSettled = true;
        });
        await turns(() => held.length === 2);
        const [releaseSignIn, releaseRefresh] = held;
        if (!releaseSignIn || !releaseRefresh)
          throw new Error('Expected both probes held');
        releaseRefresh(accountAnswer(answer.status, answer.account));
        await turns(() => refreshSettled);
        expect(refreshSettled).toBe(true);
        releaseSignIn(accountAnswer(200));
        await expect(second).resolves.toEqual({
          account: { connected: true, kind: 'apiKey' },
        });
        // The refresh lands on the held key before the sign-in replaces it;
        // its result orders observations only and never refuses the sign-in.
        await expect(refreshed.then((result) => result.outcome)).resolves.toBe(
          outcome,
        );
        const read = await services.authority.read();
        if (read.kind !== 'ok') throw new Error('Expected custody');
        expect(read.record?.apiKey).toBe('csk-second');
        expect(read).toMatchObject({
          sessionExpired: false,
          provenance: {
            credential: 'accepted',
            membership: true,
            policy: true,
          },
        });
      } finally {
        await graph.shutdown('test');
        await services.dispose();
      }
    },
  );

  it('never grants policy for a key whose model policy is missing or malformed', async () => {
    let enforcedSettings: unknown = [];
    const { graph, services } = serve((url) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : {
            status: 200,
            body: {
              ...accountBody,
              organizations: entry().organizations,
              ...(enforcedSettings === undefined ? {} : { enforcedSettings }),
            },
          },
    );
    await graph.start();
    try {
      const signIn = async (attempt: string): Promise<unknown> => {
        await expect(
          graph.dispatcher.instruction(
            'core.integration.cloudAccount.connectWithKey',
            { apiKey: 'csk-manual' },
            { caller: client, metadata: { idempotencyKey: attempt } },
          ),
        ).resolves.toEqual({ account: { connected: true, kind: 'apiKey' } });
        const read = await services.authority.read();
        if (read.kind !== 'ok') throw new Error(read.kind);
        return read.provenance;
      };
      await expect(signIn('verified')).resolves.toMatchObject({
        credential: 'accepted',
        policy: true,
      });
      for (const [attempt, unverified] of [
        ['missing', undefined],
        ['not-a-list', {}],
        [
          'malformed-model-policy',
          [
            {
              organizationId: ORG,
              organizationName: 'Org',
              policies: [
                {
                  kind: 'model-policy',
                  reviewedModelIds: 'all',
                  blockedModelIds: [],
                },
              ],
            },
          ],
        ],
      ] as const) {
        enforcedSettings = unverified;
        await expect(signIn(attempt)).resolves.toMatchObject({
          credential: 'unknown',
          policy: false,
        });
      }
    } finally {
      await graph.shutdown('test');
    }
  });

  it('signs the daemon in with a key and keeps a guest from replacement', async () => {
    const { graph, services } = serve((url, authorization) =>
      url.endsWith('/.well-known/canopy')
        ? { status: 200, body: { capabilities: accountBody.capabilities } }
        : authorization === 'Bearer csk-revoked'
          ? { status: 401, body: { error: 'revoked' } }
          : { status: 200, body: accountBody },
    );
    await graph.start();
    const connect = (apiKey: string): Promise<unknown> =>
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.connectWithKey',
        { apiKey },
        { caller: client, metadata: { idempotencyKey: `connect-${apiKey}` } },
      );
    await expect(kindOf(connect('csk-revoked'))).resolves.toEqual({
      kind: 'permission_denied',
      code: 'core.integration.cloudAccount.keyRejected',
    });
    // No record yet: the key creates it.
    await expect(connect(' csk-manual ')).resolves.toEqual({
      account: { connected: true, kind: 'apiKey' },
    });
    const read = await services.authority.read();
    expect(read.kind === 'ok' && read.record?.apiKey).toBe('csk-manual');
    await expect(
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client },
      ),
    ).resolves.toEqual({ account: { connected: false, kind: 'none' } });
    await provision(graph, {
      entry: json(guestEntry()),
      endpointAuthority: cloudAccountEndpointAuthority(endpoint),
      expectedCredentialDigest: null,
    });
    const guestHeld = await services.custody.read();
    await expect(kindOf(connect('csk-manual'))).resolves.toEqual({
      kind: 'failed_precondition',
      code: 'core.integration.cloudAccount.guestProtected',
    });
    // Refused before its receipt: a guest-protected sign-in writes nothing.
    await expect(services.custody.read()).resolves.toEqual(guestHeld);
    await expect(
      graph.dispatcher.instruction(
        'core.integration.cloudAccount.disconnect',
        {},
        { caller: client },
      ),
    ).resolves.toEqual({ account: { connected: true, kind: 'guest' } });
    await graph.shutdown('test');
    await services.dispose();
  });
});

describe('governed-native and AI Credits model answers (unselected)', () => {
  const identity = {
    executionId: 'exec-1',
    owner: 'personal',
    runScope: 'worktree',
    workspaceId: 'w',
    worktreeId: 't',
  } as const;
  const creditsRoute = {
    harness: 'claude',
    selection: 'sonnet',
    requestModel: 'claude-sonnet',
    runtimeModel: 'anthropic/claude-sonnet',
    source: 'ai-gateway',
    effectiveRoute: 'ai-credits',
    authentication: 'vendor-profile',
  } as const;
  const evidence = (
    overrides: Partial<WorkerPipelineNativeRouteEvidence> = {},
  ): WorkerPipelineNativeRouteEvidence => ({
    version: 1,
    identity,
    configurationEpoch: 'epoch',
    catalogFingerprint: 'fp',
    expectedAccountIdentity: 'account-1',
    policy: 'account-independent-personal',
    gateway: 'absent',
    accountProxy: 'absent',
    aiCredits: 'required',
    futureSelections: 'closed',
    routes: [creditsRoute],
    ...overrides,
  });
  const request = (
    action: WorkerPipelineHostRequest['request'],
    owner: WorkerPipelineHostRequest['owner'] = 'personal',
  ): WorkerPipelineHostRequest => ({
    requestId: 'request-1',
    executionId: 'exec-1',
    jobId: 'job',
    stepId: 'step',
    childExecutionId: null,
    attempt: 1,
    iteration: 1,
    owner,
    deadlineAt: '2026-11-18T10:00:00.000Z',
    request: action,
  });

  async function managed(initial: Entry = entry()): Promise<{
    services: ReturnType<typeof createDaemonCloudAccountServices>;
    credentialGeneration: number;
    /** Holds every later custody read until the returned release runs. */
    holdCustodyReads: () => () => void;
    upstream: string[];
    credits: { value: number };
  }> {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    let gate: Promise<void> | undefined;
    const upstream: string[] = [];
    const credits = { value: 5 };
    const services = createDaemonCloudAccountServices({
      repository: async () => {
        await gate;
        return memory.repository;
      },
      writer: () => Promise.resolve(writer),
      cloud: {
        baseUrl: 'https://cloud.example.test',
        wellKnownNamespace: 'canopy',
        apiNamespace: 'desktop-app',
      },
      fetch: (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        upstream.push(
          `${url} ${new Headers(init?.headers).get('authorization') ?? '-'}`,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({ credits: credits.value, active: true }),
            {
              status: 200,
            },
          ),
        );
      },
    });
    await expect(
      services.authority.provision(initial, null),
    ).resolves.toMatchObject({ kind: 'provisioned' });
    const read = await services.authority.read();
    if (read.kind !== 'ok' || !read.record) throw new Error('No account');
    await expect(
      services.authority.saveIfUnchanged(initial, read.record, {
        probe: services.authority.beginProbe(),
      }),
    ).resolves.toMatchObject({ kind: 'saved' });
    const verified = await services.authority.read();
    if (verified.kind !== 'ok') throw new Error('No account');
    return {
      services,
      credentialGeneration: verified.credentialGeneration,
      holdCustodyReads: () => {
        const held = Promise.withResolvers<void>();
        gate = held.promise;
        return held.resolve;
      },
      upstream,
      credits,
    };
  }

  const ports = (
    services: ReturnType<typeof createDaemonCloudAccountServices>,
  ): Parameters<typeof prepareManagedPipelineOwnerRun>[2] => ({
    authority: services.authority,
    availability: services.availability,
    broker: services.broker,
    brokerReady: (): boolean => true,
    policyScope: 'union',
  });
  const unchangedSettings = {
    isConfigurationCurrent: (): boolean => true,
    isAiCreditsConsentCurrent: (): Promise<boolean> => Promise.resolve(true),
  };

  it('opens a daemon broker route from the first invocation and gives the child no key', async () => {
    const { services } = await managed();
    const prepared = await prepareManagedPipelineOwnerRun(
      identity,
      evidence(),
      ports(services),
      unchangedSettings,
    );
    if (prepared.kind !== 'managed-model-answers')
      throw new Error(JSON.stringify(prepared.decision));
    const invocation = request({
      action: 'owner.model.invocation',
      harness: 'claude',
      model: 'claude-sonnet',
      routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
    });
    // Answered while the app is still connected, so the route outlives it.
    expect(prepared.authority.answersFirst(invocation)).toBe(true);
    const answered = await prepared.authority.answer(
      invocation,
      new AbortController().signal,
    );
    expect(answered?.result).toEqual({
      status: 'owner',
      value: {
        kind: 'model.invocation',
        source: 'ai-gateway',
        harness: 'claude',
        runtimeModel: 'anthropic/claude-sonnet',
        aiCreditsRouted: true,
        modelGatewayRouted: false,
        accountProxyRouted: false,
      },
    });
    const env = answered?.values?.env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('canopy-loopback-broker');
    expect(JSON.stringify(answered)).not.toContain('csk-first');
    expect(services.broker.routeCount('exec-1')).toBe(1);
    // Even an unrecorded selection must revoke survival before app fallback.
    expect(
      prepared.authority.answersFirst(
        request({ action: 'owner.model.invocation', harness: 'codex' }),
      ),
    ).toBe(true);
    await expect(
      prepared.authority.answer(
        request({
          action: 'owner.model.release',
          routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ result: { value: { kind: 'model.release' } } });
    expect(services.broker.routeCount('exec-1')).toBe(0);
    await prepared.authority.answer(invocation, new AbortController().signal);
    prepared.authority.retire?.();
    expect(services.broker.routeCount('exec-1')).toBe(1);
    await expect(
      prepared.authority.answer(invocation, new AbortController().signal),
    ).resolves.toBeUndefined();
    await prepared.authority.answer(
      request({
        action: 'owner.model.release',
        routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
      }),
      new AbortController().signal,
    );
    expect(services.broker.routeCount('exec-1')).toBe(0);
    // Settlement or cancellation releases this run's routes.
    prepared.authority.dispose();
    expect(services.broker.routeCount('exec-1')).toBe(0);
    await services.dispose();
  });

  it('keeps broker routes while phase 5 stops pipeline hosts and releases them before the vault closes', async () => {
    const { services } = await managed();
    const prepared = await prepareManagedPipelineOwnerRun(
      identity,
      evidence(),
      ports(services),
      unchangedSettings,
    );
    if (prepared.kind !== 'managed-model-answers')
      throw new Error(JSON.stringify(prepared.decision));
    const routesAt: Partial<Record<5 | 7, number>> = {};
    const record = (phase: 5 | 7) => (): void => {
      routesAt[phase] = services.broker.routeCount('exec-1');
    };
    // Mirrors the pipeline hosts (phase 5) and the daemon vault (phase 7).
    const neighbours: RuntimeModule = {
      name: 'test.neighbours',
      plane: 'core',
      services: [
        {
          name: 'test.neighbours',
          plane: 'core',
          stop: { 5: record(5), 7: record(7) },
        },
      ],
      definitions: { queries: {}, instructions: {}, streams: {} },
      handlers: { queries: {}, instructions: {}, streams: {} },
    };
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [services.module, neighbours],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    try {
      await graph.start();
      await prepared.authority.answer(
        request({
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'claude-sonnet',
          routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
        }),
        new AbortController().signal,
      );
      expect(services.broker.routeCount('exec-1')).toBe(1);
      await graph.shutdown('test');
      expect(routesAt).toEqual({ 5: 1, 7: 0 });
      await expect(
        services.broker.openAiCreditsRoute({
          executionId: 'exec-1',
          owner: 'personal',
          harness: 'claude',
          governedModelId: 'claude-sonnet',
          requestModels: {},
          policyScope: 'union',
          accountId: null,
          credentialGeneration: 0,
        }),
      ).resolves.toEqual({ kind: 'refused', reason: 'closed' });
    } finally {
      prepared.authority.dispose();
      await services.dispose();
    }
  });

  it('releases broker routes in phase 6 while a held custody read stalls the refresh drain', async () => {
    const { services, credentialGeneration, holdCustodyReads } =
      await managed();
    let routesAtVaultClose: number | undefined;
    // Mirrors the daemon vault: closes in shutdown phase 7.
    const vaultModule: RuntimeModule = {
      name: 'test.vault',
      plane: 'core',
      services: [
        {
          name: 'test.vault',
          plane: 'core',
          stop: {
            7: (): void => {
              routesAtVaultClose = services.broker.routeCount();
            },
          },
        },
      ],
      definitions: { queries: {}, instructions: {}, streams: {} },
      handlers: { queries: {}, instructions: {}, streams: {} },
    };
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [services.module, vaultModule],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    let releaseRead = (): void => undefined;
    let starting: Promise<boolean> | undefined;
    try {
      await graph.start();
      await expect(
        services.broker.openAiCreditsRoute({
          executionId: 'exec-1',
          owner: 'personal',
          harness: 'claude',
          governedModelId: 'claude-sonnet',
          requestModels: { 'claude-sonnet': 'anthropic/claude-sonnet' },
          policyScope: 'union',
          accountId: 'account-1',
          credentialGeneration,
        }),
      ).resolves.toMatchObject({ kind: 'opened' });
      releaseRead = holdCustodyReads();
      // The refresh drain waits for this start's held custody read.
      starting = services.start();
      const report = await graph.shutdown('test');
      const status = (id: number): string | undefined =>
        report.phases.find((phase) => phase.id === id)?.status;
      expect(status(4)).toBe('timed_out');
      expect(status(6)).toBe('completed');
      expect(routesAtVaultClose).toBe(0);
      // The seal path's disposal still waits for the drain.
      let disposed = false;
      const disposal = services.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);
      releaseRead();
      await disposal;
      await expect(starting).resolves.toBe(false);
    } finally {
      releaseRead();
      await starting;
      await services.dispose();
    }
  });

  it('refuses admission when the evidence names another run identity', async () => {
    const { services } = await managed();
    for (const other of [
      { ...identity, owner: 'org:11111111-2222-4333-8444-555555555555' },
      { ...identity, executionId: 'exec-2' },
      { ...identity, worktreeId: 'other-worktree' },
      { ...identity, workspaceId: 'other-workspace' },
      { ...identity, runScope: 'directory' as const },
    ]) {
      // Personal evidence must never admit a run recorded under another scope.
      await expect(
        prepareManagedPipelineOwnerRun(
          other,
          evidence(),
          ports(services),
          unchangedSettings,
        ),
      ).resolves.toEqual({
        kind: 'app-dependent',
        decision: { kind: 'pauses', blockers: ['unknown'] },
      });
    }
    expect(services.broker.routeCount()).toBe(0);
    await services.dispose();
  });

  it('stops opening routes after the account is replaced by another identity', async () => {
    const { services } = await managed();
    const prepared = await prepareManagedPipelineOwnerRun(
      identity,
      evidence(),
      ports(services),
      unchangedSettings,
    );
    if (prepared.kind !== 'managed-model-answers') throw new Error('admitted');
    await services.authority.provision(
      entry({
        apiKey: 'csk-other',
        account: {
          id: 'account-2',
          name: 'B',
          email: 'b@x.test',
          role: 'ADMIN',
        },
      }),
      createHash('sha256').update('csk-first').digest('hex'),
    );
    await expect(
      prepared.authority.answer(
        request({
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'claude-sonnet',
          routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
        }),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(services.broker.routeCount()).toBe(0);
    await services.dispose();
  });

  it('does not create a later model route after the credits are exhausted', async () => {
    const { services, credits } = await managed();
    const prepared = await prepareManagedPipelineOwnerRun(
      identity,
      evidence(),
      ports(services),
      unchangedSettings,
    );
    if (prepared.kind !== 'managed-model-answers') throw new Error('admission');
    credits.value = 0;
    await expect(
      prepared.authority.answer(
        request({
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'claude-sonnet',
          routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
        }),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(services.broker.routeCount()).toBe(0);
    prepared.authority.dispose();
    await services.dispose();
  });

  it.each(['turned off', 'unreadable'] as const)(
    'declines another AI Credits route once consent is %s, for the app to route or the run to checkpoint, and keeps open routes (CAN-7730)',
    async (consent) => {
      const { services } = await managed();
      let consented = true;
      const prepared = await prepareManagedPipelineOwnerRun(
        identity,
        evidence(),
        ports(services),
        {
          isConfigurationCurrent: () => true,
          isAiCreditsConsentCurrent: () =>
            consented || consent === 'turned off'
              ? Promise.resolve(consented)
              : Promise.reject(new Error('preferences unreadable')),
        },
      );
      if (prepared.kind !== 'managed-model-answers')
        throw new Error('admission');
      const checkpoints: unknown[] = [];
      prepared.authority.bindCheckpoint?.((blocker) => {
        checkpoints.push(blocker);
        return Promise.resolve();
      });
      const invocation = (index: number): WorkerPipelineHostRequest =>
        request({
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'claude-sonnet',
          routeSessionId: `pipeline:exec-1:job:step:1:1:${index}`,
        });
      await expect(
        prepared.authority.answer(invocation(0), new AbortController().signal),
      ).resolves.toMatchObject({
        result: { value: { aiCreditsRouted: true } },
      });
      consented = false;
      // A decline, never delivered: a connected app routes the step under
      // its own setting, as without the daemon; once the app has gone, the
      // supervisor checkpoints the run for AI Credits (pipeline-host-owner).
      for (const index of [1, 2])
        await expect(
          prepared.authority.answer(
            invocation(index),
            new AbortController().signal,
          ),
        ).resolves.toEqual({
          result: {
            status: 'failure',
            failureReason: null,
            message:
              'AI Credits are off, or could not be confirmed, for this workflow.',
            outputs: {},
          },
          checkpoint: 'ai-credits',
        });
      // The authority itself never pauses the run.
      expect(checkpoints).toEqual([]);
      // The step already routed keeps its route until it releases it.
      expect(services.broker.routeCount('exec-1')).toBe(1);
      await prepared.authority.answer(
        request({
          action: 'owner.model.release',
          routeSessionId: 'pipeline:exec-1:job:step:1:1:0',
        }),
        new AbortController().signal,
      );
      expect(services.broker.routeCount('exec-1')).toBe(0);
      prepared.authority.dispose();
      await services.dispose();
    },
  );

  it.each(['disconnect', 'revoke', 'identity', 'gateway', 'policy'] as const)(
    'does not execute a later governed step after %s',
    async (change) => {
      const { services } = await managed();
      const governed = evidence({
        policy: 'required',
        aiCredits: 'absent',
        routes: [
          {
            ...creditsRoute,
            runtimeModel: 'claude-sonnet',
            source: 'claude-managed',
            effectiveRoute: 'native',
          },
        ],
      });
      const prepared = await prepareManagedPipelineOwnerRun(
        identity,
        governed,
        ports(services),
        unchangedSettings,
      );
      if (prepared.kind !== 'managed-model-answers')
        throw new Error('admission');
      const read = await services.authority.read();
      if (read.kind !== 'ok') throw new Error('account');
      if (change === 'revoke')
        await services.authority.recordCredentialRejected(
          read.credentialGeneration,
        );
      else if (change === 'disconnect' || change === 'identity')
        await services.authority.provision(
          change === 'disconnect'
            ? null
            : entry({
                account: {
                  id: 'other',
                  name: 'B',
                  email: 'b@x.test',
                  role: 'ADMIN',
                },
              }),
          createHash('sha256').update('csk-first').digest('hex'),
        );
      else {
        if (!read.record) throw new Error('account');
        const refreshed = entry(
          change === 'gateway'
            ? { personalModelGateway: { enforced: true } }
            : {
                enforcedSettings: [
                  {
                    organizationId: ORG,
                    organizationName: 'Org',
                    policies: [
                      {
                        kind: 'model-policy',
                        mode: 'allowlist',
                        blockedModelIds: ['claude-sonnet'],
                        reviewedModelIds: [],
                      },
                    ],
                  },
                ],
              },
        );
        await services.authority.saveIfUnchanged(refreshed, read.record);
      }
      await expect(
        prepared.authority.answer(
          request({
            action: 'owner.model.invocation',
            harness: 'claude',
            model: 'claude-sonnet',
          }),
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
      prepared.authority.dispose();
      await services.dispose();
    },
  );

  it.each([true, false])(
    'withdraws native permission after a failed policy save (probe: %s)',
    async (withProbe) => {
      const { custody } = await activeAuthority();
      let fail = true;
      const authority = createCloudAccountAuthority({
        custody: {
          ...custody,
          commit: (input) =>
            fail
              ? Promise.resolve({ kind: 'unavailable', reason: 'locked' })
              : custody.commit(input),
        },
      });
      const { services } = await managed();
      const port = createCloudAccountAuthorizationPort(authority);
      try {
        const governed = evidence({
          policy: 'required',
          aiCredits: 'absent',
          routes: [
            {
              ...creditsRoute,
              runtimeModel: 'claude-sonnet',
              source: 'claude-managed',
              effectiveRoute: 'native',
            },
          ],
        });
        const prepared = await prepareManagedPipelineOwnerRun(
          identity,
          governed,
          { ...ports(services), authority },
          unchangedSettings,
        );
        if (prepared.kind !== 'managed-model-answers')
          throw new Error('Not admitted');
        const step = request({
          action: 'owner.model.invocation',
          harness: 'claude',
          model: 'claude-sonnet',
        });
        await expect(
          prepared.authority.answer(step, new AbortController().signal),
        ).resolves.toMatchObject({
          result: { value: { aiCreditsRouted: false } },
        });
        const current = await authority.read();
        if (current.kind !== 'ok' || !current.record)
          throw new Error('No account');
        const headers = new Headers();
        (await port.lease(current.credentialGeneration)).apply(headers);
        const olderProbe = authority.beginProbe();
        const refreshed = entry({
          enforcedSettings: [
            {
              organizationId: ORG,
              organizationName: 'Org',
              policies: [
                {
                  kind: 'model-policy',
                  mode: 'allowlist',
                  reviewedModelIds: [],
                  blockedModelIds: [],
                },
              ],
            },
          ],
        });
        await expect(
          authority.saveIfUnchanged(
            refreshed,
            current.record,
            withProbe ? { probe: authority.beginProbe() } : {},
          ),
        ).resolves.toEqual({ kind: 'unavailable', reason: 'locked' });
        expect(headers.has('authorization')).toBe(false);
        const access = await port.current();
        expect(
          access.kind === 'ok' &&
            access.modelPolicyActive({ kind: 'personal' }, 'union'),
        ).toBeNull();
        expect(
          evaluateCloudModelPolicy({
            read: await authority.read(),
            owner: { kind: 'personal' },
            scope: 'union',
            governedModelId: 'claude-sonnet',
          }),
        ).toEqual({ kind: 'unknown', reason: 'policy-unavailable' });
        await expect(
          prepared.authority.answer(step, new AbortController().signal),
        ).resolves.toBeUndefined();
        fail = false;
        // An older allowed observation must not overwrite a newer failed denial.
        await expect(
          authority.saveIfUnchanged(current.record.entry, current.record, {
            probe: olderProbe,
          }),
        ).resolves.toMatchObject({ kind: 'superseded' });
        expect(
          evaluateCloudModelPolicy({
            read: await authority.read(),
            owner: { kind: 'personal' },
            scope: 'union',
            governedModelId: 'claude-sonnet',
          }),
        ).toEqual({ kind: 'unknown', reason: 'policy-unavailable' });
        await expect(
          prepared.authority.answer(step, new AbortController().signal),
        ).resolves.toBeUndefined();
        await expect(
          authority.saveIfUnchanged(current.record.entry, current.record, {
            probe: authority.beginProbe(),
          }),
        ).resolves.toMatchObject({ kind: 'saved' });
        expect(
          evaluateCloudModelPolicy({
            read: await authority.read(),
            owner: { kind: 'personal' },
            scope: 'union',
            governedModelId: 'claude-sonnet',
          }),
        ).toEqual({ kind: 'allowed' });
      } finally {
        port.dispose();
        await services.dispose();
      }
    },
  );

  it('keeps exhausted credits out of native routing and re-checks policy before every step', async () => {
    const org = `org:${ORG}`;
    const { services, credits } = await managed(
      entry({
        enforcedSettings: [
          {
            organizationId: ORG,
            organizationName: 'Org',
            policies: [
              {
                kind: 'model-policy',
                mode: 'allowlist',
                blockedModelIds: [],
                reviewedModelIds: ['anthropic/claude-sonnet-5.5'],
              },
            ],
          },
        ],
      }),
    );
    const governed = evidence({
      identity: { ...identity, owner: org },
      policy: 'required',
      aiCredits: 'absent',
      routes: [
        {
          ...creditsRoute,
          requestModel: 'sonnet',
          runtimeModel: 'sonnet',
          source: 'claude-managed',
          effectiveRoute: 'native',
        },
      ],
    });
    const prepared = await prepareManagedPipelineOwnerRun(
      { ...identity, owner: org },
      governed,
      {
        ...ports(services),
        governedModelId: (model) =>
          resolvePipelineGovernedModelId(model, {
            MODEL_CATALOG: JSON.stringify({
              version: 1,
              claudeModels: ['sonnet'],
              codexModels: ['gpt-6-sol'],
              modelAliases: {},
              gatewayRoutes: [
                { modelId: 'sonnet', gatewayId: 'anthropic/claude-sonnet-5.5' },
              ],
            }),
          }),
      },
      unchangedSettings,
    );
    if (prepared.kind !== 'managed-model-answers')
      throw new Error(JSON.stringify(prepared.decision));
    const step = request(
      {
        action: 'owner.model.invocation',
        harness: 'claude',
        model: 'sonnet',
      },
      org,
    );
    expect(prepared.authority.answersFirst(step)).toBe(false);
    await expect(
      prepared.authority.answer(step, new AbortController().signal),
    ).resolves.toMatchObject({
      result: { value: { kind: 'model.invocation', aiCreditsRouted: false } },
    });
    credits.value = 0;
    await expect(
      prepared.authority.answer(step, new AbortController().signal),
    ).resolves.toMatchObject({
      result: { value: { kind: 'model.invocation', aiCreditsRouted: false } },
    });
    expect(services.broker.routeCount()).toBe(0);
    await expect(
      prepared.authority.answer(
        request(
          { action: 'owner.model.policy', check: 'blocked', modelId: 'sonnet' },
          org,
        ),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      result: { value: { kind: 'model.policy', answer: false } },
    });
    // The organization stops reviewing the model: the next step is not run.
    const policyRead = await services.authority.read();
    if (policyRead.kind !== 'ok' || !policyRead.record)
      throw new Error('account');
    await services.authority.saveIfUnchanged(
      entry({
        enforcedSettings: [
          {
            organizationId: ORG,
            organizationName: 'Org',
            policies: [
              {
                kind: 'model-policy',
                mode: 'allowlist',
                blockedModelIds: [],
                reviewedModelIds: [],
              },
            ],
          },
        ],
      }),
      policyRead.record,
    );
    // Re-observing the old client snapshot cannot restore the old allowlist.
    await services.authority.provision(
      policyRead.record.entry,
      createHash('sha256').update('csk-first').digest('hex'),
    );
    await expect(
      prepared.authority.answer(
        request(
          {
            action: 'owner.model.policy',
            check: 'blocked',
            modelId: 'sonnet',
          },
          org,
        ),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      checkpoint: 'policy',
      result: { value: { kind: 'model.policy', answer: true } },
    });
    await expect(
      prepared.authority.answer(step, new AbortController().signal),
    ).resolves.toBeUndefined();
    await services.dispose();
  });
});
