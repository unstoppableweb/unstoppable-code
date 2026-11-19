// ---------------------------------------------------------------------------
// Entitlements probe.
//
// A minimal, dependency-light read of the connected account's billing
// capabilities via `GET /api/v1/entitlements` (CAN-1037 / T21), without the
// full `loadCanopyCloudAiCredits` balance/landing-URL surface. Kept as a leaf
// module (only the cloud client) to avoid import cycles with `ipc/settings`.
// ---------------------------------------------------------------------------

import {
  can,
  AI_CREDITS_WORK_OWNER_HEADER,
  isModelLibraryAccess,
  type Entitlements,
  type EntitlementSource,
  type BillingPresentation,
  type ModelLibraryAccess,
  type WorkOwner,
} from '@canopy/protocol';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

/**
 * What one entitlements response said about personal model-library access.
 *
 * Three answers that must not be collapsed, because each has a different
 * consequence downstream:
 *
 * - `reported`: the server sent a recognized value. Authoritative.
 * - `not-reported`: a SUCCESSFUL response from a server that predates the
 *   field. Callers fall back to the guest rules that server enforces (guest is
 *   limited to the allowlist, a signed-in account is unlocked).
 * - `invalid`: the field was present but unrecognized. Never guessed at and
 *   never treated as `not-reported`: a newer server may have added a value this
 *   build cannot read, and silently unlocking on it would be a client-side
 *   widening the server did not grant.
 */
export type ModelLibraryAccessRead =
  | { readonly status: 'reported'; readonly access: ModelLibraryAccess }
  | { readonly status: 'not-reported' }
  | { readonly status: 'invalid' };

function readModelLibraryAccess(value: unknown): ModelLibraryAccessRead {
  if (value === undefined) return { status: 'not-reported' };
  return isModelLibraryAccess(value)
    ? { status: 'reported', access: value }
    : { status: 'invalid' };
}

function readWorkModelLibraryAccess(
  value: unknown,
  owner: WorkOwner,
): ModelLibraryAccessRead {
  if (value === undefined) return { status: 'not-reported' };
  if (
    typeof value !== 'object' ||
    value === null ||
    !('owner' in value) ||
    !('access' in value)
  )
    return { status: 'invalid' };
  const reportedOwner = value.owner;
  if (
    typeof reportedOwner !== 'object' ||
    reportedOwner === null ||
    !('kind' in reportedOwner)
  )
    return { status: 'invalid' };
  if (
    reportedOwner.kind !== owner.kind ||
    (owner.kind === 'organization' &&
      (!('organizationId' in reportedOwner) ||
        reportedOwner.organizationId !== owner.organizationId))
  )
    return { status: 'invalid' };
  return readModelLibraryAccess(value.access);
}

/**
 * Projection of the entitlements endpoint: the display fields the sidebar
 * subscription pill needs (plan / trial / manageable org) plus a plain
 * projection of the `data_sync_control` capability, which no longer gates
 * sharing on the desktop. Never throws:
 *
 * - `{ resolved: true, ... }` on a definitive answer (a 404 = unlinked account
 *   resolves to `canDisableSharing: false`, `source: 'none'`, everything null).
 * - `{ resolved: false }` on any transient failure so callers keep
 *   last-known-good rather than flapping.
 */
export type EntitlementsSummaryProbe =
  | {
      resolved: true;
      canDisableSharing: boolean;
      /**
       * Whether the account holds the `remote_control` capability. NOTE: this is
       * NOT a Remote Control availability gate — under billing-off the
       * entitlements mirror never emits `remote_control`, yet Remote Control is
       * still available. This bit is billing-on-only, for
       * completeness/telemetry.
       */
      canRemoteControl: boolean;
      source: EntitlementSource;
      plan: { key: string; displayName: string } | null;
      trial: { active: boolean; endsAt: string } | null;
      billingManageableOrg: { id: string; name: string } | null;
      displayPlan: {
        key: string;
        displayName: string;
        source: EntitlementSource;
      } | null;
      billingPresentation: BillingPresentation | null;
      /** Server-reported free app access; older servers omit the field. */
      freeAccess: boolean;
      /** Personal model-library access; see {@link ModelLibraryAccessRead}. */
      modelLibrary: ModelLibraryAccessRead;
      workModelLibrary?: ModelLibraryAccessRead;
    }
  | { resolved: false };

function normalizeBillingPresentation(
  value: unknown,
): BillingPresentation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const plan = candidate.plan as Record<string, unknown> | undefined;
  const owner = candidate.owner as Record<string, unknown> | undefined;
  const lifecycle = candidate.lifecycle;
  const action = candidate.action;
  const trialEndsAt = candidate.trialEndsAt;
  if (
    !plan ||
    typeof plan.key !== 'string' ||
    plan.key.length === 0 ||
    typeof plan.displayName !== 'string' ||
    plan.displayName.length === 0 ||
    !owner ||
    (lifecycle !== 'trial' && lifecycle !== 'paid') ||
    (trialEndsAt !== null && typeof trialEndsAt !== 'string')
  ) {
    return null;
  }
  if (owner.type === 'user') {
    if (action !== 'subscribe' && action !== 'manage') return null;
  } else if (owner.type === 'organization') {
    if (
      typeof owner.id !== 'string' ||
      owner.id.length === 0 ||
      typeof owner.name !== 'string' ||
      owner.name.length === 0 ||
      (action !== 'subscribe' && action !== 'manage' && action !== 'view')
    ) {
      return null;
    }
  } else {
    return null;
  }
  return value as BillingPresentation;
}

/**
 * Probe the entitlements endpoint for both the `data_sync_control` capability
 * and the subscription display projection (plan / trial / manageable org).
 * Never throws.
 */
export async function probeEntitlementsSummary(
  owner?: WorkOwner,
): Promise<EntitlementsSummaryProbe> {
  try {
    const entitlements = owner
      ? await requestCanopyCloudJson<Entitlements>('/api/v1/entitlements', {
          headers: {
            [AI_CREDITS_WORK_OWNER_HEADER]:
              owner.kind === 'personal'
                ? 'personal'
                : `org:${owner.organizationId}`,
          },
        })
      : await requestCanopyCloudJson<Entitlements>('/api/v1/entitlements');
    return {
      resolved: true,
      canDisableSharing: can(entitlements, 'data_sync_control'),
      canRemoteControl: can(entitlements, 'remote_control'),
      source: entitlements.source,
      plan: entitlements.plan,
      trial: entitlements.trial,
      // Backward compat: older servers omit these append-only fields.
      billingManageableOrg: entitlements.billingManageableOrg ?? null,
      displayPlan: entitlements.displayPlan ?? null,
      billingPresentation: normalizeBillingPresentation(
        entitlements.billingPresentation,
      ),
      freeAccess: entitlements.freeAccess === true,
      // Read through `Reflect.get` so the runtime value is judged as `unknown`.
      // The declared type promises a valid union member, which is exactly the
      // claim an untrusted response body has not earned yet.
      modelLibrary: readModelLibraryAccess(
        Reflect.get(entitlements, 'modelLibrary'),
      ),
      ...(owner
        ? {
            workModelLibrary: readWorkModelLibraryAccess(
              Reflect.get(entitlements, 'workModelLibrary'),
              owner,
            ),
          }
        : {}),
    };
  } catch (error) {
    // A 404 means no linked UD account, i.e. definitively cannot disable sharing.
    if (error instanceof CanopyCloudClientError && error.status === 404) {
      return {
        resolved: true,
        canDisableSharing: false,
        canRemoteControl: false,
        source: 'none',
        plan: null,
        trial: null,
        billingManageableOrg: null,
        displayPlan: null,
        billingPresentation: null,
        freeAccess: false,
        // No linked account means no server opinion, not an invalid one.
        modelLibrary: { status: 'not-reported' },
      };
    }
    return { resolved: false };
  }
}
