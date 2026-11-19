import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';

/**
 * Field evidence for the Phase 4 daemon routes (CAN-5093): one
 * `daemon:route_select` event per route decision, carrying only the route
 * family, where the work ran, and a fixed reason code. Never a path, id,
 * name, command or content.
 */

const SELECTION_REASONS = ['platform', 'caller', 'latched'] as const;
const FALLBACK_REASONS = [
  'unreachable',
  'host_unavailable',
  'owner_unavailable',
  'refused',
] as const;

export const DAEMON_ROUTE_REASONS = {
  // Eligible local window branch lists (CAN-4729).
  git_reads: ['served', ...SELECTION_REASONS, ...FALLBACK_REASONS],
  scripts: [
    'served',
    ...SELECTION_REASONS,
    ...FALLBACK_REASONS,
    'run_kind',
    'scope',
    'environment',
    'place',
  ],
  workflows: [
    'served',
    ...SELECTION_REASONS,
    ...FALLBACK_REASONS,
    'environment',
    'host_actions',
    // DaemonPipelineIneligibleReason, which the route passes as typed.
    'initiation',
    'scope',
    'trigger',
    'portal',
    'nested',
    'package',
    'limits',
    'roots',
    'terminal_mode',
    'model_step',
    'host_step',
    'child_pipeline',
    'tsx_runtime',
    'dynamic_action',
    'unresolved_action',
    'too_deep',
    'unknown_runtime',
    'model_provider',
    'model_action',
    'dynamic_model',
    'model_alias',
    'plugin_collections',
    'host_paths',
    'host_inputs',
  ],
  terminals: [
    'served',
    ...SELECTION_REASONS,
    ...FALLBACK_REASONS,
    'shared_container',
    'managed',
    'relative_cwd',
    'capacity',
    'root',
    'cwd',
    'managed_kind',
    'remote_bridge',
    'not_restorable',
  ],
  code_graph: [
    'served',
    ...SELECTION_REASONS,
    ...FALLBACK_REASONS,
    'workspace',
    'unavailable',
    'not_dispatched',
  ],
} as const;

export type DaemonRouteFamily = keyof typeof DAEMON_ROUTE_REASONS;
export type DaemonRouteHost = 'daemon' | 'in_process';
export type DaemonRouteReason<F extends DaemonRouteFamily> =
  (typeof DAEMON_ROUTE_REASONS)[F][number];

const OPERATION = 'canopy.daemon_route';

const REASONS_BY_FAMILY: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(DAEMON_ROUTE_REASONS).map(([family, reasons]) => [
    family,
    new Set<string>(reasons),
  ]),
);

/** The label every value outside the fixed lists becomes. */
export const DAEMON_ROUTE_OTHER = 'other';

/**
 * The labels one decision sends. Each value is one of the fixed codes above,
 * or `other` when the caller passed anything else, so no path, id, name or
 * free text can reach a label. `served` alone means the daemon.
 */
export function daemonRouteLabels(
  family: string,
  reason: string,
): {
  readonly route_family: string;
  readonly route_host: DaemonRouteHost;
  readonly route_reason: string;
} {
  const reasons = REASONS_BY_FAMILY.get(family);
  const known = reasons?.has(reason) === true;
  return {
    route_family: reasons === undefined ? DAEMON_ROUTE_OTHER : family,
    route_host: known && reason === 'served' ? 'daemon' : 'in_process',
    route_reason: known ? reason : DAEMON_ROUTE_OTHER,
  };
}

/**
 * Records where one routed request ran, after the current task so it never
 * delays or changes the route.
 */
export function recordDaemonRoute<F extends DaemonRouteFamily>(
  family: F,
  reason: DaemonRouteReason<F>,
): void {
  setImmediate(() => {
    try {
      const context = daemonRouteLabels(family, reason);
      const operationKey = createDesktopInstrumentationOperationKey(
        `${OPERATION}:${context.route_family}:${context.route_reason}:${Date.now()}`,
      );
      startDesktopOperation(OPERATION, { operationKey, context });
      succeedDesktopOperation(OPERATION, { operationKey, context });
    } catch {
      // Telemetry never affects a route.
    }
  });
}

/** Notes one route decision's reason; only the first note is sent. */
export type DaemonRouteNote<F extends DaemonRouteFamily> = (
  reason: DaemonRouteReason<F>,
) => void;

/**
 * Runs one routed request and records its decision exactly once: the first
 * reason `decide` notes, or `refused` when it settles or throws without one
 * (a reached daemon refused it, or it failed before any outcome). The
 * request's own result or error passes through unchanged.
 */
export async function recordDaemonRouteDecision<F extends DaemonRouteFamily, T>(
  family: F,
  decide: (note: DaemonRouteNote<F>) => Promise<T>,
): Promise<T> {
  let recorded = false;
  const note: DaemonRouteNote<F> = (reason) => {
    if (recorded) return;
    recorded = true;
    recordDaemonRoute(family, reason);
  };
  try {
    return await decide(note);
  } finally {
    if (!recorded) recordDaemonRoute(family, 'refused');
  }
}
