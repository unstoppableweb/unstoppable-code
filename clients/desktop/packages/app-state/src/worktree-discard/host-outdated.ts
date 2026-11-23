/**
 * The update message when an older computer refused an archive recovery
 * action, so nothing ran (CAN-7444), or null for any other failure.
 *
 * Only the portable adapter's own mapping is trusted: it marks the error
 * `hostOutdated` (`HostOutdatedError` in `@canopy/ipc-canopy-client`, which
 * this package does not depend on). A bare `remote_channel_unavailable`, such
 * as a dropped link, is not, because the action may have run.
 */
export function worktreeRecoveryHostOutdatedMessage(
  error: unknown,
): string | null {
  if (!(error instanceof Error)) return null;
  if (Reflect.get(error, 'hostOutdated') !== true) return null;
  const message = error.message.trim();
  return message === '' ? null : message;
}
