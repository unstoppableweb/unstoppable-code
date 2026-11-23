/**
 * Code a client adapter's refusal carries when the target cannot serve an
 * operation at all, for example an older computer that refuses its channel.
 * `@canopy/ipc-canopy-client`'s `UnsupportedOperationError` uses it.
 */
export const OPERATION_UNSUPPORTED_CODE = 'operation_unsupported';

/**
 * Whether a client rejection says the target does not support the operation,
 * as opposed to a failed attempt (CAN-7439). Matched structurally by code so
 * UI packages need not depend on a client adapter.
 */
export function isUnsupportedOperation(
  error: unknown,
): error is { readonly code: typeof OPERATION_UNSUPPORTED_CODE } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === OPERATION_UNSUPPORTED_CODE
  );
}
