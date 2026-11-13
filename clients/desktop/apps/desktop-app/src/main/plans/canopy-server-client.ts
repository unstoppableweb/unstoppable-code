import { BRAND } from '@canopy/brand/current';
import type {
  SharedPlanCreateRequest,
  SharedPlanDetail,
  SharedPlanUnshareResult,
  SharedPlanUpdateRequest,
} from '@canopy/protocol/plans';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;
const PLANS_CAPABILITY = 'plans-crud-v1';

export async function createSharedPlan(
  request: SharedPlanCreateRequest,
): Promise<SharedPlanDetail> {
  await assertCanopyCloudCapability(PLANS_CAPABILITY);
  return requestCanopyCloudJson<SharedPlanDetail>(`${API_PREFIX}/plans`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// In-flight coalescing for shared-plan GETs, keyed by `remoteId`. Multiple
// tracked-plan tuples across worktrees can point at the same remote plan; on the
// startup sweep (and per SSE signal) they would otherwise each issue an identical
// GET for one resource. Pure in-flight (deleted on settle, no lingering cache) so
// a request only ever joins one that is genuinely happening right now — zero
// staleness, which SSE-signalled refreshes require.
const inFlightGets = new Map<string, Promise<SharedPlanDetail>>();

export async function getSharedPlan(
  remoteId: string,
): Promise<SharedPlanDetail> {
  const existing = inFlightGets.get(remoteId);
  if (existing) {
    return existing;
  }
  const request = (async (): Promise<SharedPlanDetail> => {
    await assertCanopyCloudCapability(PLANS_CAPABILITY);
    return requestCanopyCloudJson<SharedPlanDetail>(
      `${API_PREFIX}/plans/${encodeURIComponent(remoteId)}`,
    );
  })().finally(() => {
    if (inFlightGets.get(remoteId) === request) {
      inFlightGets.delete(remoteId);
    }
  });
  inFlightGets.set(remoteId, request);
  return request;
}

export async function updateSharedPlan(
  remoteId: string,
  request: SharedPlanUpdateRequest,
): Promise<SharedPlanDetail> {
  await assertCanopyCloudCapability(PLANS_CAPABILITY);
  return requestCanopyCloudJson<SharedPlanDetail>(
    `${API_PREFIX}/plans/${encodeURIComponent(remoteId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(request),
    },
  );
}

/**
 * Stop sharing (hard-delete) a shared plan by its `remoteId` (CAN-5904), the
 * web plan's `externalId`, as GET and PUT address it. The web route answers a
 * uniform 404 for a plan that is already gone or not the caller's, which maps
 * to `{ unshared: false }` so the local share still clears. Any other failure
 * (offline, 5xx) is thrown with its message and leaves the share in place.
 */
export async function deleteSharedPlan(
  remoteId: string,
): Promise<SharedPlanUnshareResult> {
  await assertCanopyCloudCapability(PLANS_CAPABILITY);
  try {
    return await requestCanopyCloudJson<SharedPlanUnshareResult>(
      `${API_PREFIX}/plans/${encodeURIComponent(remoteId)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error instanceof CanopyCloudClientError && error.status === 404) {
      return { unshared: false };
    }
    throw error;
  }
}
