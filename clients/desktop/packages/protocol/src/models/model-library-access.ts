import type { WorkOwner } from '../llm-gateway/index';
/** Library eligibility only; provider, policy and funding gates still apply. */
export const MODEL_LIBRARY_ACCESS_VALUES = [
  'unlocked',
  'needs_sign_in',
  'needs_sign_in_then_purchase',
  'needs_purchase',
] as const;
export type ModelLibraryAccess = (typeof MODEL_LIBRARY_ACCESS_VALUES)[number];
export function isModelLibraryAccess(
  value: unknown,
): value is ModelLibraryAccess {
  return MODEL_LIBRARY_ACCESS_VALUES.some((access) => access === value);
}
export function decideModelLibraryAccess(input: {
  isGuest: boolean;
  requiresPurchase: boolean;
  hasQualifyingPurchaseOrCoverage: boolean;
}): ModelLibraryAccess {
  if (input.isGuest)
    return input.requiresPurchase
      ? 'needs_sign_in_then_purchase'
      : 'needs_sign_in';
  return !input.requiresPurchase || input.hasQualifyingPurchaseOrCoverage
    ? 'unlocked'
    : 'needs_purchase';
}

/** Compatibility claims are rollout context, never model-access authority. */
export const MODEL_LIBRARY_PROTOCOL_HEADER = 'x-canopy-model-library-protocol';
export const MODEL_LIBRARY_PROTOCOL_VERSION = 1;
export const MODEL_LIBRARY_REMOTE_CONTROL_CAPABILITY = 'model_library_v1';
export function isModelLibraryClientVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value)
  );
}

/** Paired desktop projection. Retained access is display-only. */
export interface ModelLibraryContext {
  readonly accountKey: string;
  readonly owner: WorkOwner;
  readonly access?: ModelLibraryAccess;
  readonly authoritative: boolean;
  readonly requestId: string;
}
export function isModelLibraryContext(
  value: unknown,
): value is ModelLibraryContext {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('accountKey' in value) ||
    !('requestId' in value) ||
    !('owner' in value) ||
    !('authoritative' in value)
  )
    return false;
  const accountKey = value.accountKey;
  const requestId = value.requestId;
  const access = 'access' in value ? value.access : undefined;
  const owner = value.owner;
  if (
    typeof owner !== 'object' ||
    owner === null ||
    Array.isArray(owner) ||
    !('kind' in owner)
  )
    return false;
  const organizationId =
    'organizationId' in owner ? owner.organizationId : undefined;
  return (
    typeof accountKey === 'string' &&
    accountKey.length > 0 &&
    accountKey.length <= 256 &&
    typeof requestId === 'string' &&
    requestId.length > 0 &&
    requestId.length <= 128 &&
    typeof value.authoritative === 'boolean' &&
    (access === undefined || isModelLibraryAccess(access)) &&
    (owner.kind === 'personal' ||
      (owner.kind === 'organization' &&
        typeof organizationId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          organizationId,
        )))
  );
}
