/**
 * What the composer's Stop says once its stop is sent, on every host that
 * renders `ComposerSendButton`.
 */

/** A stop is sent and the turn hasn't ended yet. */
export const COMPOSER_STOPPING_LABEL = 'Stopping…';

/**
 * A cloud turn's stop is accepted while the turn is still starting: Core
 * ends it only once the project's sandbox wakes (CAN-6721).
 */
export const COMPOSER_STOPPING_WAITING_FOR_WAKE_LABEL =
  'Stopping… waiting for the project to wake';
