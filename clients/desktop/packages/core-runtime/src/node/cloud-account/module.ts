import { createHash } from 'node:crypto';
import {
  CloudAccountRedactedEntrySchema,
  CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS,
  CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS,
  CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS,
  type CloudAccountCustodyView,
  type CoreCloudAccountProvisionResult,
} from '@canopy/protocol/canopy-core';
import {
  canopyAccountRefreshFields,
  parseCanopyAccountSnapshot,
} from '@canopy/protocol/canopy-server/account-snapshot';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import {
  canopyInvalidArgumentError,
  CanopyOperationError,
} from '../../runtime/errors';
import {
  cloudAccountCredentialDigest,
  type CloudAccountAuthority,
  type CloudAccountAuthorityFailure,
  type CloudAccountAuthorityRead,
} from './authority';
import {
  cloudModelPolicySnapshotUnavailable,
  hasCloudAccountCredential,
  isGuestCloudAccount,
  type CloudAccountRecord,
} from './record';
import { isCloudAccountBearerKey, type CloudAccountProbe } from './probe';
import type { CloudAccountRefresher } from './refresh';

/**
 * `core.integration.cloudAccount.*` over the daemon's own account record
 * (CAN-6997). This is the daemon's login surface, separate from any client's
 * sign-in: a client provisions it from its own sign-in (`provision`), and the
 * published operations sign the daemon in or out directly. None of them
 * writes a client's record, and a client's own sign-in never waits on them.
 * Browser sign-in stays with the client: it needs a browser and a loopback
 * callback, and its result reaches the daemon by provisioning.
 */

/** The capabilities the desktop requires of a manual key (settings.ts). */
export const CLOUD_ACCOUNT_REQUIRED_CAPABILITIES = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
] as const;

export function cloudAccountCustodyView(
  read: CloudAccountAuthorityRead,
  endpointAuthority: string | null = null,
): CloudAccountCustodyView {
  if (read.kind !== 'ok')
    return {
      endpointAuthority,
      state: read.kind === 'inactive' ? 'inactive' : 'unavailable',
      credentialGeneration: null,
      credentialDigest: null,
      sessionExpired: false,
      entry: null,
    };
  const record = read.record;
  const entry: Record<string, unknown> | null = record
    ? { ...record.entry }
    : null;
  if (entry) delete entry.apiKey;
  return {
    endpointAuthority,
    state: 'active',
    credentialGeneration: read.credentialGeneration,
    credentialDigest: hasCloudAccountCredential(record)
      ? cloudAccountCredentialDigest(record.apiKey)
      : null,
    sessionExpired: read.sessionExpired,
    // A record's entry is JSON by construction (`readCloudAccountRecord`).
    entry: entry ? CloudAccountRedactedEntrySchema.parse(entry) : null,
  };
}

/**
 * The custody operations name their failures; the CAN-4168 operations keep
 * their published codes, so their busy and unknown outcomes carry none beyond
 * `storageUnavailable`. `publishedUnfenced` is a published call with no
 * observation fence: replaying it would act on whatever is held by then.
 */
type ErrorCodes =
  | 'custody'
  | 'published'
  | 'publishedKeyed'
  | 'publishedUnfenced';

function inactive(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'core.integration.cloudAccount.custodyInactive',
    message: 'This background service holds no account.',
    retry: { kind: 'never' },
  });
}

function failed(
  failure: Extract<CloudAccountAuthorityFailure, { kind: 'unavailable' }>,
  codes: ErrorCodes,
): CanopyOperationError {
  const custody = codes === 'custody';
  if (failure.reason === 'busy')
    return new CanopyOperationError({
      kind: 'unavailable',
      ...(custody && { code: 'core.integration.cloudAccount.busy' }),
      message: 'Another account change is in progress.',
      retry:
        codes === 'publishedKeyed'
          ? { kind: 'same_idempotency_key', delayMs: 1_000 }
          : codes === 'publishedUnfenced'
            ? { kind: 'never' }
            : { kind: 'same_request', delayMs: 1_000 },
    });
  if (failure.reason === 'outcome_unknown')
    return new CanopyOperationError({
      kind: 'unavailable',
      ...(custody && { code: 'core.integration.cloudAccount.outcomeUnknown' }),
      message:
        'The account change may or may not have been saved; read the account again.',
      retry: { kind: 'never' },
    });
  return new CanopyOperationError({
    kind: 'unavailable',
    code: 'core.integration.cloudAccount.storageUnavailable',
    message: 'The account service could not complete the request.',
    retry:
      codes === 'publishedKeyed' &&
      (failure.reason === 'locked' || failure.reason === 'unavailable')
        ? { kind: 'same_idempotency_key', delayMs: 1_000 }
        : { kind: 'never' },
  });
}

function connectError(
  code:
    | 'keyRejected'
    | 'missingCapabilities'
    | 'providerUnreachable'
    | 'guestProtected'
    | 'superseded',
  retryable = code === 'providerUnreachable',
): CanopyOperationError {
  const kinds = {
    keyRejected: 'permission_denied',
    missingCapabilities: 'failed_precondition',
    providerUnreachable: 'unavailable',
    guestProtected: 'failed_precondition',
    superseded: 'conflict',
  } as const;
  return new CanopyOperationError({
    kind: kinds[code],
    code: `core.integration.cloudAccount.${code}`,
    message:
      code === 'guestProtected'
        ? 'A manual API key cannot replace a guest session.'
        : 'The key was not connected.',
    retry: retryable
      ? { kind: 'same_idempotency_key', delayMs: 1_000 }
      : { kind: 'never' },
  });
}

function summary(record: CloudAccountRecord | null): {
  connected: boolean;
  kind: 'guest' | 'apiKey' | 'oauth' | 'none';
} {
  if (!hasCloudAccountCredential(record))
    return { connected: false, kind: 'none' };
  return {
    connected: true,
    kind: isGuestCloudAccount(record)
      ? 'guest'
      : record.authMode === 'oauth'
        ? 'oauth'
        : 'apiKey',
  };
}

/** The manual-key entry the app's Settings save builds from its probe. */
export function buildManualCloudAccountEntry(input: {
  readonly apiKey: string;
  readonly probe: Extract<CloudAccountProbe, { kind: 'authenticated' }>;
  readonly previous: CloudAccountRecord | null;
  readonly now: string;
}):
  | { readonly kind: 'entry'; readonly entry: Record<string, unknown> }
  | { readonly kind: 'missingCapabilities' }
  | { readonly kind: 'invalid' } {
  const { payload } = input.probe;
  const account: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'account')
      : undefined;
  if (typeof account !== 'object' || account === null)
    return { kind: 'invalid' };
  const snapshot = parseCanopyAccountSnapshot(
    payload,
    input.probe.capabilities,
  );
  if (
    CLOUD_ACCOUNT_REQUIRED_CAPABILITIES.some(
      (capability) => !snapshot.capabilities.includes(capability),
    )
  )
    return { kind: 'missingCapabilities' };
  // Read from the raw payload: the tolerant normalizer drops malformed rows.
  const modelPolicyEnforcementUnavailable = cloudModelPolicySnapshotUnavailable(
    Reflect.get(Object(payload), 'enforcedSettings'),
  );
  return {
    kind: 'entry',
    entry: {
      apiKey: input.apiKey,
      authMode: 'api_key',
      credentialSource: 'manual',
      ...canopyAccountRefreshFields(snapshot),
      organizationsVerified: snapshot.organizationsRefreshed,
      modelPolicyVerified: !modelPolicyEnforcementUnavailable,
      modelPolicyEnforcementUnavailable,
      account,
      createdAt: input.previous?.createdAt ?? input.now,
      updatedAt: input.now,
    },
  };
}

export interface CloudAccountModuleOptions {
  readonly endpointAuthority: string | null;
  readonly authority: CloudAccountAuthority;
  readonly refresher: CloudAccountRefresher;
  /** Probes a key the caller supplies (`connectWithKey`). */
  readonly probe: (
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<CloudAccountProbe>;
  /** After the record is created, replaced or cleared: arms refresh. */
  readonly onProvisioned?: () => void;
  readonly now?: () => Date;
}

const CLOUD_ACCOUNT_SERVED_INSTRUCTIONS = {
  ...CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS,
  'core.integration.cloudAccount.connectWithKey':
    CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
      'core.integration.cloudAccount.connectWithKey'
    ],
  'core.integration.cloudAccount.disconnect':
    CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
      'core.integration.cloudAccount.disconnect'
    ],
  'core.integration.cloudAccount.resetUnreadable':
    CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS[
      'core.integration.cloudAccount.resetUnreadable'
    ],
};

export function createCloudAccountModule(
  options: CloudAccountModuleOptions,
): RuntimeModule {
  const { authority } = options;
  const now = options.now ?? ((): Date => new Date());
  const custodyGet = async (): Promise<CloudAccountCustodyView> => {
    const read = await authority.read({ settleMutations: true });
    // Queue contention is retryable, not unreadable custody.
    if (read.kind === 'unavailable' && read.reason === 'busy')
      throw failed(read, 'custody');
    return cloudAccountCustodyView(read, options.endpointAuthority);
  };
  // Provision's own write has settled, so its result reads without queueing:
  // a later queued write can neither make it busy nor report it unavailable.
  const provisionedView = async (): Promise<CloudAccountCustodyView> =>
    cloudAccountCustodyView(await authority.read(), options.endpointAuthority);

  const digestOf = (record: CloudAccountRecord | null): string | null =>
    hasCloudAccountCredential(record)
      ? cloudAccountCredentialDigest(record.apiKey)
      : null;

  function provisioned(
    outcome: Awaited<ReturnType<CloudAccountAuthority['provision']>>,
    codes: ErrorCodes,
  ): CoreCloudAccountProvisionResult['status'] {
    if (outcome.kind === 'unavailable') throw failed(outcome, codes);
    if (outcome.kind === 'inactive') throw inactive();
    if (
      outcome.kind === 'provisioned' ||
      outcome.kind === 'cleared' ||
      outcome.kind === 'unchanged'
    )
      try {
        options.onProvisioned?.();
      } catch {
        // Arming refresh never changes the provisioning outcome.
      }
    return outcome.kind;
  }

  return defineRuntimeModule({
    name: 'core.integration.cloudAccount',
    plane: 'core',
    services: [],
    definitions: {
      queries: CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS,
      instructions: CLOUD_ACCOUNT_SERVED_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: {
        'core.integration.cloudAccount.custody.get': custodyGet,
      },
      streams: {},
      instructions: {
        'core.integration.cloudAccount.provision': async (
          {
            entry,
            expectedCredentialDigest,
            expectedCredentialGeneration,
            credentialRejected,
            endpointAuthority,
          },
          { signal },
        ) => {
          const status = provisioned(
            endpointAuthority === options.endpointAuthority
              ? await authority.provision(
                  entry,
                  expectedCredentialDigest,
                  signal,
                  expectedCredentialGeneration,
                  credentialRejected,
                )
              : { kind: 'invalid' },
            'custody',
          );
          if (status === 'provisioned' || status === 'unchanged') {
            const current = await authority.read();
            if (
              current.kind === 'ok' &&
              current.record &&
              current.provenance?.credential !== 'accepted'
            ) {
              // Only this daemon's own probe qualifies managed admission.
              // A failed probe does not undo the already-committed custody.
              await options.refresher.refresh(signal);
            }
          }
          return { status, custody: await provisionedView() };
        },
        'core.integration.cloudAccount.refresh': async (_, { signal }) => {
          const refreshed = await options.refresher.refresh(signal);
          const { outcome } = refreshed;
          if (outcome === 'inactive') throw inactive();
          // A different Cloud binding makes refresh unavailable, not storage
          // broken; custody retains the original account without probing it.
          if (
            refreshed.failure &&
            refreshed.failure.reason !== 'endpoint_mismatch'
          )
            throw failed(refreshed.failure, 'custody');
          return {
            outcome,
            billingStatesRefreshed: refreshed.billingStatesRefreshed,
            // Refresh's own writes have settled too: busy here would hide an
            // applied result behind "no write attempted".
            custody: await provisionedView(),
          };
        },
        'core.integration.cloudAccount.connectWithKey': async (
          { apiKey },
          context,
        ) => {
          const key = apiKey.trim();
          // Refused before any receipt and never retried: no request could
          // carry this key, or this build has no Cloud to verify it.
          if (!isCloudAccountBearerKey(key))
            throw canopyInvalidArgumentError('The key is not a valid API key.');
          if (options.endpointAuthority === null)
            throw connectError('providerUnreachable', false);
          const outcome = await authority.connectVerified({
            commandId: createHash('sha256')
              .update(
                JSON.stringify([
                  context.caller.authorityId,
                  context.caller.principalId,
                  'core.integration.cloudAccount.connectWithKey',
                  context.metadata.idempotencyKey,
                ]),
              )
              .digest('hex'),
            credentialDigest: cloudAccountCredentialDigest(key),
            signal: context.signal,
            // Joined callers share this probe, so it runs on the command's
            // lifetime, not on this caller's request.
            verify: async (before, generation, sessionProbe, commandSignal) => {
              const refuseHeld = async (
                outcome: 'rejected' | 'forbidden' | 'unknown',
              ): Promise<void> => {
                if (before?.apiKey !== key) return;
                const recorded = await authority.recordCredentialRejected(
                  generation,
                  outcome,
                  sessionProbe,
                );
                if (recorded.kind === 'unavailable')
                  throw failed(recorded, 'publishedKeyed');
              };
              const probe = await options.probe(key, commandSignal);
              commandSignal.throwIfAborted();
              if (probe.kind === 'rejected' || probe.kind === 'forbidden') {
                await refuseHeld(probe.kind);
                throw connectError('keyRejected');
              }
              if (probe.kind === 'offline')
                throw connectError('providerUnreachable');
              const built = buildManualCloudAccountEntry({
                apiKey: key,
                probe,
                previous: before,
                now: now().toISOString(),
              });
              if (built.kind === 'missingCapabilities')
                throw connectError('missingCapabilities');
              if (built.kind === 'invalid') {
                await refuseHeld('unknown');
                throw connectError('keyRejected');
              }
              return built.entry;
            },
          });
          if (outcome.kind === 'guest-protected')
            throw connectError('guestProtected');
          if (outcome.kind === 'superseded') throw connectError('superseded');
          if (
            outcome.kind === 'invalid' ||
            outcome.kind === 'credential-rejected'
          )
            throw connectError('keyRejected');
          if (outcome.kind !== 'unchanged')
            provisioned(outcome, 'publishedKeyed');
          // The command's original result, not a later replacement/disconnect.
          return { account: { connected: true, kind: 'apiKey' as const } };
        },
        'core.integration.cloudAccount.disconnect': async (
          { expectedCredentialGeneration },
          { signal },
        ) => {
          const codes =
            expectedCredentialGeneration === undefined
              ? 'publishedUnfenced'
              : 'published';
          const superseded = (): CanopyOperationError =>
            new CanopyOperationError({
              kind: 'conflict',
              message: 'The account changed before disconnect completed.',
              retry: {
                kind: 'after_refresh',
                resource: 'core.integration.cloudAccount.custody.get',
              },
            });
          // Queued: an in-flight write is waited for, not reported unavailable.
          const observed = await authority.read({ settleMutations: true });
          if (observed.kind === 'unavailable') throw failed(observed, codes);
          const before = observed.kind === 'ok' ? observed.record : null;
          // A guest stays, as in the app; signed out answers signed out. A
          // stale fence still reports the replacement it missed.
          if (observed.kind === 'ok' && before && isGuestCloudAccount(before)) {
            if (
              expectedCredentialGeneration !== undefined &&
              expectedCredentialGeneration !== observed.credentialGeneration
            )
              throw superseded();
            return { account: summary(before) };
          }
          const outcome = await authority.provision(
            null,
            digestOf(before),
            signal,
            expectedCredentialGeneration ??
              (observed.kind === 'ok' ? observed.credentialGeneration : 0),
          );
          if (outcome.kind === 'superseded') throw superseded();
          provisioned(outcome, codes);
          return { account: summary(null) };
        },
        'core.integration.cloudAccount.resetUnreadable': async (
          _,
          { signal },
        ): Promise<{
          readonly status: 'reset' | 'notNeeded';
          readonly account: ReturnType<typeof summary>;
        }> => {
          const reset = await authority.resetUnreadable(signal);
          if (reset.kind === 'reset')
            return { status: 'reset', account: summary(null) };
          if (reset.kind === 'not-needed')
            return { status: 'notNeeded', account: summary(reset.record) };
          if (reset.kind === 'inactive')
            return { status: 'notNeeded', account: summary(null) };
          throw failed(reset, 'published');
        },
      },
    },
  });
}
