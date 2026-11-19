import type { RuntimeService } from '@canopy/core-runtime';

/** The W5 host's service, and its health check's name either way. */
export const DAEMON_W5_HOST_SERVICE = 'core.daemon.w5-commit-log';

/**
 * Why a `--w5-host v1` daemon serves without its W5 host (CAN-5529).
 * Additive: later lanes extend it (B7 owns a cohort `maintenance_held`).
 */
export const DAEMON_W5_HOST_UNAVAILABLE_REASONS = [
  /** Another process holds the commit log's writer lock. */
  'writer_unavailable',
] as const;

export type DaemonW5HostUnavailableReason =
  (typeof DAEMON_W5_HOST_UNAVAILABLE_REASONS)[number];

const MESSAGES: Record<DaemonW5HostUnavailableReason, string> = {
  writer_unavailable:
    'Another process holds the W5 commit log, so this daemon serves without it.',
};

/**
 * The degraded daemon's stand-in for the W5 host: optional, so the runtime
 * reports `degraded` with the typed reason instead of refusing startup.
 */
export function unavailableDaemonW5HostService(
  reason: DaemonW5HostUnavailableReason,
): RuntimeService {
  return {
    name: DAEMON_W5_HOST_SERVICE,
    plane: 'core',
    required: false,
    health: () => ({
      name: DAEMON_W5_HOST_SERVICE,
      status: 'warn',
      message: MESSAGES[reason],
      reason,
    }),
  };
}
