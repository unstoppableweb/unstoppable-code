import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { isIpcCancellation } from '@/lib/errors';

/** What a sign-in surface shows for a failed sign-in (CAN-6895). */
export type SignInFailure =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly message: string };

/**
 * The one rule every sign-in surface uses for a failed sign-in. A cancellation,
 * including a sign-in replaced from another surface, shows nothing. An
 * external failure (a timeout, no browser, the service down) shows its catalog
 * copy. Anything else shows the surface's own `fallback`.
 */
export function describeSignInFailure(
  error: unknown,
  fallback: string,
): SignInFailure {
  if (isIpcCancellation(error)) return { cancelled: true };
  const appError = toAppError(resolveClientAppError(error));
  if (appError?.kind !== 'external')
    return { cancelled: false, message: fallback };
  const { title, description } = appError.copy;
  return {
    cancelled: false,
    message: description ? `${title} ${description}` : title,
  };
}
