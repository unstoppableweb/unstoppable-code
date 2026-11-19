import type { BackgroundServiceStatus } from '@canopy/protocol/portal/background-service';

/**
 * Health of this computer's connection to its local background service (the
 * core daemon), owned by Electron main and pushed on
 * `background-service:status-changed` (CAN-5541). The status contract lives
 * in `@canopy/protocol/portal`, which Portal also reads (CAN-7061).
 */
export {
  BACKGROUND_SERVICE_UNREACHABLE_REASONS,
  BackgroundServiceStatusSchema,
  INITIAL_BACKGROUND_SERVICE_STATUS,
  type BackgroundServiceHandoffFailure,
  type BackgroundServiceStatus,
  type BackgroundServiceUnreachableReason,
} from '@canopy/protocol/portal/background-service';

/** Features that read through the background service. Additive. */
export const BACKGROUND_SERVICE_CONSUMERS = [
  'files_reads',
  // The daemon-backed W5 store's record-port lease (CAN-5542).
  'workspace_records',
  // Eligible local window terminals placed in the daemon (CAN-5088).
  'terminals',
  // Eligible local renderer code-graph builds and summary reads (CAN-5719).
  'code_graph',
  // Eligible local renderer script runs placed in the daemon (CAN-5087).
  'scripts',
  // Eligible local window workflows without model steps (CAN-5086).
  'pipelines',
] as const;
export type BackgroundServiceConsumer =
  (typeof BACKGROUND_SERVICE_CONSUMERS)[number];

/** Preload surface: `window.api.backgroundService`. */
export interface BackgroundServiceApi {
  getStatus: () => Promise<BackgroundServiceStatus>;
  /** One bounded attach or start; resolves with the status after it. */
  retry: () => Promise<BackgroundServiceStatus>;
  /** Subscribe to status pushes. Returns an unsubscribe function. */
  onStatusChanged: (
    callback: (status: BackgroundServiceStatus) => void,
  ) => () => void;
}
