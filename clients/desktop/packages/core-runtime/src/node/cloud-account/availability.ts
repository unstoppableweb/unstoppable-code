import {
  AI_CREDITS_WORK_OWNER_HEADER,
  type WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  cloudAccountSnapshotProvenance,
  type CloudAccountAuthority,
  type CloudAccountAuthorityRead,
} from './authority';
import {
  hasCloudAccountCredential,
  isGuestCloudAccount,
  type CloudAccountRecord,
} from './record';
import type { CloudAccountSessionProbe } from './session';

/**
 * Work-owner policy and AI Credits availability from daemon-held account
 * state (CAN-6997), with the same sources as the desktop settings handlers.
 * Every answer is three-valued: `unknown` is never permission, and nothing
 * here selects a paid route. Callers that route still need recorded consent.
 */

export type CloudPolicyUnknownReason =
  | 'inactive'
  | 'unavailable'
  | 'owner-unknown'
  | 'policy-unavailable'
  | 'session-expired';

export type CloudModelPolicyAnswer =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'blocked'; readonly organizationId: string | null }
  | { readonly kind: 'unknown'; readonly reason: CloudPolicyUnknownReason };

/** Shared admission gate for governed native and paid routes; absence is not consent. */
export function cloudAccountExecutionUnknownReason(
  read: CloudAccountAuthorityRead,
  owner: WorkOwner | null,
): CloudPolicyUnknownReason | null {
  return accountPolicyUnknownReason(read, owner, false);
}

/** Existing routes may present a replaced key with unchanged daemon-verified policy. */
export function cloudAccountBrokerPresentationUnknownReason(
  read: CloudAccountAuthorityRead,
  owner: WorkOwner | null,
): CloudPolicyUnknownReason | null {
  return accountPolicyUnknownReason(read, owner, true);
}

function accountPolicyUnknownReason(
  read: CloudAccountAuthorityRead,
  owner: WorkOwner | null,
  allowUnverifiedCredential: boolean,
): CloudPolicyUnknownReason | null {
  if (read.kind === 'inactive') return 'inactive';
  if (read.kind !== 'ok') return 'unavailable';
  if (read.sessionExpired) return 'session-expired';
  const proof =
    read.provenance ??
    (read.record
      ? cloudAccountSnapshotProvenance(read.record, read.credentialGeneration)
      : undefined);
  if (
    !hasCloudAccountCredential(read.record) ||
    !proof ||
    proof.credentialGeneration !== read.credentialGeneration ||
    (proof.credential !== 'accepted' &&
      !(allowUnverifiedCredential && proof.credential === 'unknown')) ||
    !proof.membership ||
    !proof.policy ||
    read.record.modelPolicyEnforcementUnavailable
  )
    return 'policy-unavailable';
  if (
    owner?.kind === 'organization' &&
    !read.record.organizationIds.includes(
      owner.organizationId.trim().toLowerCase(),
    )
  )
    return 'owner-unknown';
  return null;
}

/**
 * Org model policy for one governed model id: an enforcing organization
 * blocks a model it denies or has not reviewed. `scope: 'union'` applies
 * every organization's policy, matching the app while owner-scoped enforcement
 * is off; it is the safe default because it never permits more.
 */
export function evaluateCloudModelPolicy(input: {
  readonly read: CloudAccountAuthorityRead;
  readonly owner: WorkOwner | null;
  readonly scope: 'owner' | 'union';
  /** The exact policy identity recorded at launch, not a display selection. */
  readonly governedModelId: string;
  readonly mode?: 'admission' | 'presentation';
}): CloudModelPolicyAnswer {
  const { read } = input;
  const unknown =
    input.mode === 'presentation'
      ? cloudAccountBrokerPresentationUnknownReason(read, input.owner)
      : cloudAccountExecutionUnknownReason(read, input.owner);
  if (unknown) return { kind: 'unknown', reason: unknown };
  if (read.kind === 'inactive') return { kind: 'unknown', reason: 'inactive' };
  if (read.kind !== 'ok') return { kind: 'unknown', reason: 'unavailable' };
  if (read.sessionExpired)
    return { kind: 'unknown', reason: 'session-expired' };
  // Signed out holds no organization policy, as in the app.
  const record = read.record;
  if (!record) return { kind: 'unknown', reason: 'policy-unavailable' };
  if (
    input.owner?.kind === 'organization' &&
    !record.organizationIds.includes(
      input.owner.organizationId.trim().toLowerCase(),
    )
  )
    return { kind: 'unknown', reason: 'owner-unknown' };
  if (input.scope === 'owner' && !input.owner)
    return { kind: 'unknown', reason: 'owner-unknown' };
  if (input.scope === 'owner' && input.owner?.kind === 'personal')
    return { kind: 'allowed' };
  if (record.modelPolicyEnforcementUnavailable)
    return { kind: 'unknown', reason: 'policy-unavailable' };
  const ownerOrganization =
    input.scope === 'owner' && input.owner?.kind === 'organization'
      ? input.owner.organizationId.trim().toLowerCase()
      : null;
  for (const setting of record.enforcedSettings) {
    const organizationId = setting.organizationId.trim().toLowerCase();
    if (ownerOrganization !== null && organizationId !== ownerOrganization)
      continue;
    for (const policy of setting.policies) {
      if (policy.kind !== 'model-policy') continue;
      if (
        policy.blockedModelIds.includes(input.governedModelId) ||
        !policy.reviewedModelIds.includes(input.governedModelId)
      )
        return { kind: 'blocked', organizationId: organizationId || null };
    }
  }
  return { kind: 'allowed' };
}

/**
 * Whether the held account could make a gateway mandatory for this owner,
 * from the same account fields as the app's `gatewayRequirementForOwner`.
 * Deliberately broader than that function: an unavailable enforcement read, an
 * enforcing organization or an enforced Personal gateway each count, and a
 * null owner considers every organization. A device gateway is not visible
 * here; launch evidence carries it.
 */
export function cloudAccountMayRequireGateway(
  record: CloudAccountRecord,
  owner: WorkOwner | null,
): boolean {
  const personalOrganization = record.personalOrganizationId?.toLowerCase();
  const governs = (organizationId: string | null | undefined): boolean =>
    record.enforcedSettings.some(
      (setting) =>
        (organizationId === null ||
          setting.organizationId.trim().toLowerCase() === organizationId) &&
        (setting.modelGatewayEnforcementUnavailable === true ||
          setting.policies.some(
            (policy) => policy.kind === 'model-gateway' && policy.enforced,
          )),
    );
  const personalGateway: unknown = record.entry.personalModelGateway;
  const personal =
    record.entry.personalModelGatewayEnforcementUnavailable === true ||
    (typeof personalGateway === 'object' &&
      personalGateway !== null &&
      Reflect.get(personalGateway, 'enforced') === true) ||
    (personalOrganization !== undefined && governs(personalOrganization));
  if (owner?.kind === 'personal') return personal;
  if (record.modelGatewayEnforcementUnavailable) return true;
  if (owner?.kind === 'organization')
    return governs(owner.organizationId.trim().toLowerCase());
  return personal || governs(null);
}

export type CloudAiCreditsUnknownReason =
  | 'inactive'
  | 'unavailable'
  | 'offline'
  | 'rejected'
  | 'forbidden'
  | 'session-expired'
  | 'owner-unknown'
  | 'policy-unavailable';

export type CloudAiCreditsAvailability =
  | {
      readonly kind: 'spendable';
      readonly source: 'personal' | 'organization';
      readonly accountId: string | null;
      readonly credentialGeneration: number;
    }
  | {
      readonly kind: 'not-spendable';
      readonly reason:
        | 'signed-out'
        | 'guest'
        | 'no-cloud-account'
        | 'exhausted';
    }
  | { readonly kind: 'unknown'; readonly reason: CloudAiCreditsUnknownReason };

export interface CloudJsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One bearer request to the Cloud; throws only for a failed transport. */
export type CloudJsonRequest = (input: {
  readonly path: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}) => Promise<CloudJsonResponse>;

function subscriptionDecoded(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof Reflect.get(body, 'active') === 'boolean'
  );
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null
    ? Reflect.get(body, name)
    : undefined;
}

/** A failed read other than "no Cloud account" (404). */
function unknownReason(status: number): CloudAiCreditsUnknownReason {
  if (status === 401) return 'rejected';
  if (status === 403) return 'forbidden';
  return 'offline';
}

function classifyFailure(
  status: number,
): CloudAiCreditsUnknownReason | 'no-cloud-account' {
  if (status === 401) return 'rejected';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'no-cloud-account';
  return 'offline';
}

export type CloudAiCreditsSubscriptionAnswer =
  | {
      readonly kind: 'ok';
      readonly active: boolean;
      readonly plan: string | null;
      readonly status: string | null;
    }
  | {
      readonly kind: 'none';
      readonly reason: 'signed-out' | 'no-cloud-account';
    }
  | { readonly kind: 'unknown'; readonly reason: CloudAiCreditsUnknownReason };

export interface CloudAiCreditsAvailabilityService {
  /** Display-only subscription summary; never consulted for routing. */
  subscription(signal?: AbortSignal): Promise<CloudAiCreditsSubscriptionAnswer>;
  /** Live answer for one work owner; never cached across credential changes. */
  load(
    owner: WorkOwner | null,
    signal?: AbortSignal,
  ): Promise<CloudAiCreditsAvailability>;
}

export function createCloudAiCreditsAvailability(options: {
  readonly authority: CloudAccountAuthority;
  readonly request: CloudJsonRequest;
  /** `/api/v1/{namespace}`: the organization billing namespace. */
  readonly organizationNamespace: string;
}): CloudAiCreditsAvailabilityService {
  // Status 0 (offline) for a failed transport: each read fails on its own, so
  // coverage another read established still stands, as in the app.
  const settled: CloudJsonRequest = (input) =>
    options.request(input).catch(() => ({ status: 0, body: null }));

  // A billing answer is evidence only for the session that asked: a same-key
  // sign-in keeps the durable generation, and a refusal can be re-authenticated
  // before the answer lands. A newer probe result, even an accepted one, also
  // leaves it unknown; revisit if that overlap makes routine answers unknown.
  function outlivedAsker(
    probe: CloudAccountSessionProbe,
    askedGeneration: number,
    latest: CloudAccountAuthorityRead,
  ): boolean {
    return (
      latest.kind !== 'ok' ||
      latest.credentialGeneration !== askedGeneration ||
      options.authority.isProbeSuperseded(probe)
    );
  }

  async function balance(
    apiKey: string,
    owner: WorkOwner,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'ok';
        readonly eligible: boolean;
        readonly personalEligible: boolean;
      }
    | { readonly kind: 'failed'; readonly status: number }
  > {
    const response = await settled({
      path: '/api/v1/ai-credits/balance',
      apiKey,
      headers: {
        [AI_CREDITS_WORK_OWNER_HEADER]: serializeWorkspaceContext(owner),
      },
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status > 299)
      return { kind: 'failed', status: response.status };
    // The app's `scopeAiCreditsBalanceToWorkOwner`: the server's `eligible`
    // stands only for the owner's own pool; otherwise eligibility is the
    // personal balance. `orgFundingAvailable` never grants: the spendable
    // endpoint is the organization's routing authority.
    // A 2xx decides only with the fields the hosted contract requires;
    // otherwise it is a failed read (status 0), never a zero balance.
    const credits = field(response.body, 'credits');
    if (typeof credits !== 'number' || !Number.isFinite(credits))
      return { kind: 'failed', status: 0 };
    const poolForOwner =
      owner.kind === 'organization' &&
      field(field(response.body, 'orgPool'), 'orgId') === owner.organizationId;
    const eligible = field(response.body, 'eligible');
    if (poolForOwner && typeof eligible !== 'boolean')
      return { kind: 'failed', status: 0 };
    const personalEligible = credits > 0;
    return {
      kind: 'ok',
      eligible: poolForOwner ? eligible === true : personalEligible,
      personalEligible,
    };
  }

  async function organization(
    apiKey: string,
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'ok'; readonly spendable: boolean }
    | { readonly kind: 'failed'; readonly status: number }
  > {
    const response = await settled({
      path: `/api/v1/${options.organizationNamespace}/organizations/${encodeURIComponent(organizationId)}/billing/credits/spendable`,
      apiKey,
      ...(signal ? { signal } : {}),
    });
    // A 404 is an answer: native billing is off or the caller is not a member.
    if (response.status === 404) return { kind: 'ok', spendable: false };
    if (response.status < 200 || response.status > 299)
      return { kind: 'failed', status: response.status };
    const headroom = field(response.body, 'hasSpendableHeadroom');
    return typeof headroom === 'boolean'
      ? { kind: 'ok', spendable: headroom }
      : { kind: 'failed', status: 0 };
  }

  async function subscription(
    signal?: AbortSignal,
  ): Promise<CloudAiCreditsSubscriptionAnswer> {
    const probe = options.authority.beginProbe();
    const read = await options.authority.read();
    if (read.kind === 'inactive')
      return { kind: 'unknown', reason: 'inactive' };
    if (read.kind !== 'ok') return { kind: 'unknown', reason: 'unavailable' };
    if (!hasCloudAccountCredential(read.record))
      return { kind: 'none', reason: 'signed-out' };
    if (read.sessionExpired)
      return { kind: 'unknown', reason: 'session-expired' };
    try {
      const response = await options.request({
        path: '/api/v1/ai-credits/subscription',
        apiKey: read.record.apiKey,
        ...(signal ? { signal } : {}),
      });
      const failed = response.status < 200 || response.status > 299;
      if (response.status === 401)
        await options.authority.recordCredentialRejected(
          read.credentialGeneration,
          'rejected',
          probe,
        );
      const reason = failed ? classifyFailure(response.status) : null;
      if (reason !== null && reason !== 'no-cloud-account')
        return { kind: 'unknown', reason };
      // A 404 or 2xx answers only for the session that asked, still
      // current, unexpired and verified.
      const latest = await options.authority.read();
      if (
        outlivedAsker(probe, read.credentialGeneration, latest) ||
        cloudAccountExecutionUnknownReason(latest, null)
      )
        return { kind: 'unknown', reason: 'unavailable' };
      if (reason === 'no-cloud-account') return { kind: 'none', reason };
      if (!subscriptionDecoded(response.body))
        return { kind: 'unknown', reason: 'offline' };
      const plan = field(response.body, 'plan');
      const status = field(response.body, 'status');
      return {
        kind: 'ok',
        active: field(response.body, 'active') === true,
        plan: typeof plan === 'string' ? plan : null,
        status: typeof status === 'string' ? status : null,
      };
    } catch {
      return { kind: 'unknown', reason: 'offline' };
    }
  }

  return {
    subscription,
    load: async (owner, signal): Promise<CloudAiCreditsAvailability> => {
      const probe = options.authority.beginProbe();
      const read = await options.authority.read();
      if (read.kind === 'inactive')
        return { kind: 'unknown', reason: 'inactive' };
      if (read.kind !== 'ok') return { kind: 'unknown', reason: 'unavailable' };
      const record = read.record;
      if (!hasCloudAccountCredential(record))
        return { kind: 'not-spendable', reason: 'signed-out' };
      if (read.sessionExpired)
        return { kind: 'unknown', reason: 'session-expired' };
      if (!owner) return { kind: 'unknown', reason: 'owner-unknown' };
      const unknown = cloudAccountExecutionUnknownReason(read, null);
      if (unknown) return { kind: 'unknown', reason: unknown };
      const spendable = {
        accountId: record.accountId,
        credentialGeneration: read.credentialGeneration,
      };
      // Only a verified member may consult an organization's pool.
      const member =
        owner.kind === 'organization' &&
        record.organizationIds.includes(
          owner.organizationId.trim().toLowerCase(),
        );
      try {
        const [personal, subscriptionRead, pool] = await Promise.all([
          balance(record.apiKey, owner, signal),
          // The app reads the personal ledger only with its subscription
          // (`loadCanopyCloudAiCredits`): a failed subscription read leaves the
          // balance unknown, and a 404 from either means no Cloud account.
          settled({
            path: '/api/v1/ai-credits/subscription',
            apiKey: record.apiKey,
            ...(signal ? { signal } : {}),
          }),
          member && owner.kind === 'organization'
            ? organization(record.apiKey, owner.organizationId, signal)
            : Promise.resolve(null),
        ]);
        // Billing 403 leaves only this answer unknown; only 401 invalidates the key.
        const statuses = [
          personal.kind === 'failed' ? personal.status : 200,
          subscriptionRead.status,
          pool?.kind === 'failed' ? pool.status : 200,
        ];
        const refusal = statuses.includes(401)
          ? 401
          : statuses.includes(403)
            ? 403
            : null;
        if (refusal !== null) {
          if (refusal === 401)
            await options.authority.recordCredentialRejected(
              read.credentialGeneration,
              'rejected',
              probe,
            );
          return { kind: 'unknown', reason: unknownReason(refusal) };
        }
        // All live billing facts are single-use evidence for this generation.
        // Never reuse a cached grant after replacement, refusal or restart.
        const latest = await options.authority.read();
        const unknown = cloudAccountExecutionUnknownReason(latest, null);
        if (unknown) return { kind: 'unknown', reason: unknown };
        if (outlivedAsker(probe, read.credentialGeneration, latest))
          return { kind: 'unknown', reason: 'unavailable' };
        const ownerUnknown = cloudAccountExecutionUnknownReason(latest, owner);
        const subscriptionFailed =
          subscriptionRead.status < 200 || subscriptionRead.status > 299
            ? subscriptionRead.status
            : !subscriptionDecoded(subscriptionRead.body)
              ? 0
              : null;
        const personalFailed =
          personal.kind === 'failed' ? personal.status : subscriptionFailed;
        const noCloudAccount =
          (personal.kind === 'failed' && personal.status === 404) ||
          subscriptionFailed === 404;
        // Established coverage wins over an unrelated failed read, as in the
        // app; otherwise any failure leaves the answer unknown, never "no".
        if (!ownerUnknown && pool?.kind === 'ok' && pool.spendable)
          return { kind: 'spendable', source: 'organization', ...spendable };
        if (
          personalFailed === null &&
          personal.kind === 'ok' &&
          // Membership loss invalidates pool-backed eligibility, not the
          // separate personal wallet. Managed admission still checks policy.
          (ownerUnknown ? personal.personalEligible : personal.eligible)
        )
          return { kind: 'spendable', source: 'personal', ...spendable };
        if (ownerUnknown) return { kind: 'unknown', reason: ownerUnknown };
        // Membership gained during the reads: the pool was never asked.
        if (owner.kind === 'organization' && pool === null)
          return { kind: 'unknown', reason: 'unavailable' };
        if (personalFailed !== null && !noCloudAccount)
          return { kind: 'unknown', reason: unknownReason(personalFailed) };
        if (pool?.kind === 'failed')
          return { kind: 'unknown', reason: unknownReason(pool.status) };
        if (noCloudAccount)
          return isGuestCloudAccount(record)
            ? { kind: 'not-spendable', reason: 'guest' }
            : { kind: 'not-spendable', reason: 'no-cloud-account' };
        return { kind: 'not-spendable', reason: 'exhausted' };
      } catch {
        return { kind: 'unknown', reason: 'offline' };
      }
    },
  };
}
