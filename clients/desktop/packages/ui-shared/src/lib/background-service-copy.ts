export interface BackgroundServiceNoticeCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * The copy for the card the host shows while the local background service
 * can't be reached (CAN-5541), by the state of the latest Try again: `failed`
 * once one ended without reaching it. Static copy only: no path, error
 * message or authority id, so replay and autocapture stay safe.
 */
export function backgroundServiceNoticeCopy(
  retry: 'idle' | 'running' | 'failed',
): BackgroundServiceNoticeCopy {
  return retry === 'failed'
    ? {
        title: "Still couldn't reach the background service",
        message: 'Files and folders may not load. Try again in a moment.',
      }
    : {
        title: "Couldn't reach the background service",
        message: 'Files and folders may not load.',
      };
}
