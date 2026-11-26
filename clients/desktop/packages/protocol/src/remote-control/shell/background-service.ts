import { z } from 'zod';
import type { W5RecoveryStatus } from './w5-recovery';

/**
 * Health of a computer's connection to its local background service (the
 * core daemon), owned by Electron main (CAN-5541). Codes only: no message,
 * path or authority id ever crosses to a renderer or to Portal.
 */

/** Why the background service can't be reached. Additive. */
export const BACKGROUND_SERVICE_UNREACHABLE_REASONS = [
  'start_failed',
  // Only a typed offline-repair refusal, from the owned daemon or main's
  // pre-spawn endpoint check; never inferred from stderr.
  'endpoint_repair_required',
  'connect_timeout',
  'host_unavailable',
  'connection_lost',
  'reconnect_failed',
  // Another account can reach the data folder or a runtime file in it, so
  // no daemon starts until its access is removed (CAN-7917).
  'data_folder_shared',
] as const;
export type BackgroundServiceUnreachableReason =
  (typeof BACKGROUND_SERVICE_UNREACHABLE_REASONS)[number];

/**
 * Why the W5 startup handoff settled degraded (CAN-7061): its typed failure
 * code, never its free-text detail. Additive, like the handoff's own codes.
 */
export const BACKGROUND_SERVICE_HANDOFF_FAILURES = [
  'writer_held',
  'peer_held',
  'version_skew',
  'exited_before_ready',
  'endpoint_repair_required',
  'daemon_unavailable',
  'backup_refused',
  'host_admission_failed',
  'in_process_host_running',
  // The handoff's daemon failed because the data folder is shared (CAN-7917).
  'data_folder_shared',
] as const;
export type BackgroundServiceHandoffFailure =
  (typeof BACKGROUND_SERVICE_HANDOFF_FAILURES)[number];

/** Startup capture refusals; never host, root-change, claim or peer failures. */
export const BACKGROUND_SERVICE_BACKUP_WARNINGS = [
  'source-unreadable',
  'missing-source',
  'schema-downgrade',
  'incomplete-backup',
  'corrupt-backup',
] as const;
export type BackgroundServiceBackupWarning =
  (typeof BACKGROUND_SERVICE_BACKUP_WARNINGS)[number];

const BACKGROUND_SERVICE_STATUS_SHAPE = {
  /**
   * `unavailable`: a start, attach or reconnect failed; shown.
   * `reconnecting`: a live connection dropped and the daemon is restarting;
   * hidden until that restart fails (CAN-5541).
   */
  state: z.enum(['ok', 'reconnecting', 'unavailable']),
  /** Present only while `state` is `unavailable`. */
  reason: z.enum(BACKGROUND_SERVICE_UNREACHABLE_REASONS).optional(),
  /** The latest Try again: `failed` until the service is reached again. */
  retry: z.enum(['idle', 'running', 'failed']),
  /** A degraded startup handoff cannot be retried until the next launch. */
  recovery: z.literal('restart_app').optional(),
  /** With `recovery`: the degraded handoff's failure code, for diagnostics. */
  handoff: z.enum(BACKGROUND_SERVICE_HANDOFF_FAILURES).optional(),
  /** Advisory only: does not change reachability, authority or save admission. */
  backupWarning: z.enum(BACKGROUND_SERVICE_BACKUP_WARNINGS).optional(),
  /** Increases with every change; a lower one is stale. */
  sequence: z.number().int().nonnegative(),
};

/** The preload contract between this computer's main and renderer. */
export const BackgroundServiceStatusSchema = z.strictObject(
  BACKGROUND_SERVICE_STATUS_SHAPE,
);
export type BackgroundServiceStatus = z.infer<
  typeof BackgroundServiceStatusSchema
>;

/**
 * Portal's reader: a newer computer may add fields, which are dropped, while
 * a malformed known field still drops the whole status. Reason, handoff and
 * backup warning codes are additive: an unknown string drops only its field.
 * An outage keeps its generic copy; an unknown advisory is not shown.
 */
const RemoteBackgroundServiceStatusSchema = z.object({
  ...BACKGROUND_SERVICE_STATUS_SHAPE,
  reason: z.string().optional(),
  handoff: z.string().optional(),
  backupWarning: z.string().optional(),
});
const UnreachableReasonSchema = BACKGROUND_SERVICE_STATUS_SHAPE.reason;
const HandoffFailureSchema = BACKGROUND_SERVICE_STATUS_SHAPE.handoff;
const BackupWarningSchema = BACKGROUND_SERVICE_STATUS_SHAPE.backupWarning;

export const INITIAL_BACKGROUND_SERVICE_STATUS: BackgroundServiceStatus =
  Object.freeze({ state: 'ok', retry: 'idle', sequence: 0 });

/**
 * Portal's copy of the paired computer's service notice (CAN-7061, CAN-7848):
 * a shown failure, or any status carrying the startup backup advisory, travels;
 * anything else is absent, so the notice clears. A `reconnecting` status with
 * the advisory travels so the notice stays mounted, and a dismissed advisory
 * stays dismissed, across a daemon restart, as on the computer itself.
 */
export function projectRemoteBackgroundService(
  status: BackgroundServiceStatus,
): BackgroundServiceStatus | undefined {
  return status.state === 'unavailable' || status.backupWarning !== undefined
    ? status
    : undefined;
}

/**
 * Whether a computer's notices say why its rows are missing (CAN-7061): an
 * outage, or blocked changes. A `hidden` W5 recovery is its resting state,
 * which every overview carries. The startup backup advisory says the service
 * is reachable, so it never explains an empty computer.
 */
export function remoteNoticeExplainsMissingRows(notices: {
  readonly w5Recovery?: W5RecoveryStatus;
  readonly backgroundService?: BackgroundServiceStatus;
}): boolean {
  return (
    notices.backgroundService?.state === 'unavailable' ||
    (notices.w5Recovery !== undefined && notices.w5Recovery.state !== 'hidden')
  );
}

/** Reads a Portal payload's field; an unknown or malformed value shows nothing. */
export function readRemoteBackgroundService(
  value: unknown,
): BackgroundServiceStatus | undefined {
  const parsed = RemoteBackgroundServiceStatusSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { reason, handoff, backupWarning, ...status } = parsed.data;
  const knownReason = UnreachableReasonSchema.safeParse(reason);
  const knownHandoff = HandoffFailureSchema.safeParse(handoff);
  const knownBackupWarning = BackupWarningSchema.safeParse(backupWarning);
  return projectRemoteBackgroundService({
    ...status,
    ...(knownReason.success &&
      knownReason.data !== undefined && { reason: knownReason.data }),
    ...(knownHandoff.success &&
      knownHandoff.data !== undefined && { handoff: knownHandoff.data }),
    ...(knownBackupWarning.success &&
      knownBackupWarning.data !== undefined && {
        backupWarning: knownBackupWarning.data,
      }),
  });
}
