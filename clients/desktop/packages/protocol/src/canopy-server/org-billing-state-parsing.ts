// ---------------------------------------------------------------------------
// Tolerant per-org billing state parsing (CAN-2311).
//
// Single source of truth for turning untrusted JSON (an OAuth token response, a
// guest mint, a decrypted account file, or a refreshed account payload) into the
// structured `CanopyOrgBillingState[]` wire shape. The key is optional on the
// wire — a server that predates it omits it entirely — so parsing is tolerant
// rather than strict: a non-array, a malformed entry, or an unparseable field
// drops to "nothing known about this org" instead of throwing, which keeps a
// single bad field from failing an otherwise-valid login or account read.
//
// Direction of the failure mode matters here. Every gate built on this treats
// "no billing state for org X" as NOT lapsed, so a parse failure degrades to
// today's ungated behavior rather than locking a paying org out of its own data.
// The server-side guard is the authoritative half; this is the local half that
// explains the block instead of surfacing an unattributed 403.
//
// No I/O and no Electron, so it is shared by the daemon's key sign-in and
// every desktop parse site
// (`oauth-login`, `guest-auth`, `canopy-cloud-account-store`, `ipc/settings`)
// and passes `pnpm run check:electron-boundary`.
// ---------------------------------------------------------------------------

import type { CanopyOrgBillingState } from './index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a single per-org billing state. Returns `null` for non-records,
 * entries missing the org id/name, and entries whose `teamsEntitled` is not a
 * literal boolean, so callers can filter them out.
 *
 * `teamsEntitled` must be a real `boolean`. It is deliberately NOT coerced with
 * `=== true`: that would turn an absent, `null`, or otherwise malformed field
 * into `false`, and because `isOrgTeamsLapsed` reads a present entry as
 * authoritative (`!entry.teamsEntitled`), a partial payload would become an
 * explicit lapse and locally lock a PAYING org out of telemetry, memory,
 * sharing, and org credit routing. That inverts this module's stated contract
 * (see the header): unknown state must degrade to "nothing known", which is
 * fail-open, not to "not entitled". Dropping the entry is what produces that.
 *
 * Only a well-formed, literal `false` gates an organization.
 */
export function normalizeOrgBillingState(
  value: unknown,
): CanopyOrgBillingState | null {
  if (
    !isRecord(value) ||
    typeof value.organizationId !== 'string' ||
    typeof value.organizationName !== 'string' ||
    typeof value.teamsEntitled !== 'boolean'
  ) {
    return null;
  }
  const trialEndedAt =
    typeof value.trialEndedAt === 'string' && value.trialEndedAt.trim().length
      ? value.trialEndedAt.trim()
      : undefined;
  return {
    organizationId: value.organizationId,
    organizationName: value.organizationName,
    teamsEntitled: value.teamsEntitled,
    ...(trialEndedAt ? { trialEndedAt } : {}),
  };
}

/**
 * Normalize a full `orgBillingStates` array. Non-arrays and malformed entries
 * are dropped, so the result is always a well-formed (possibly empty) list.
 */
export function normalizeOrgBillingStates(
  value: unknown,
): CanopyOrgBillingState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: CanopyOrgBillingState[] = [];
  for (const entry of value) {
    const normalized = normalizeOrgBillingState(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Deep-copy a billing-state list for the account store's clone paths, so a
 * cached entry can never be mutated through a handed-out reference.
 */
export function cloneOrgBillingStates(
  value: CanopyOrgBillingState[] | undefined,
): CanopyOrgBillingState[] {
  return (value ?? []).map((entry) => ({ ...entry }));
}

/**
 * Whether org `organizationId` has LOST the `teams` capability.
 *
 * Fail-open by construction: an org with no entry (older server, parse failure,
 * or an account snapshot written before this key existed) is NOT lapsed. Only an
 * explicit `teamsEntitled: false` gates anything, and only for that one org —
 * this is the chokepoint that keeps every caller per-org instead of a global
 * kill switch.
 */
export function isOrgTeamsLapsed(
  states: readonly CanopyOrgBillingState[] | undefined,
  organizationId: string,
): boolean {
  const entry = (states ?? []).find(
    (state) => state.organizationId === organizationId,
  );
  return entry ? !entry.teamsEntitled : false;
}

/**
 * Names of the lapsed orgs among `organizationIds`, in the order given, for
 * copy that has to say WHICH org is blocked. Deduplicated, and empty when
 * nothing is lapsed.
 */
export function lapsedOrgNames(
  states: readonly CanopyOrgBillingState[] | undefined,
  organizationIds: readonly string[],
): string[] {
  const names: string[] = [];
  for (const organizationId of organizationIds) {
    const entry = (states ?? []).find(
      (state) => state.organizationId === organizationId,
    );
    if (
      entry &&
      !entry.teamsEntitled &&
      !names.includes(entry.organizationName)
    ) {
      names.push(entry.organizationName);
    }
  }
  return names;
}
