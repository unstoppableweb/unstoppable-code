/**
 * `--remote-control`: run the suite's scenarios with Remote Control
 * connected (CAN-7852). The option names the scenario app's role:
 *
 * - `controller`: the measured app is the computer a person sits at. It is
 *   signed in, paired with `--remote-control-peers` scripted computers and
 *   holds each one through its main window (`window.api.pairedComputers`,
 *   one-window mode), re-reading each computer's session snapshot whenever
 *   that computer says it is stale. Each scripted computer serves a snapshot
 *   of `--remote-control-tasks` tasks and flips one task's status every
 *   `--remote-control-status-interval-ms`.
 * The other direction, where the measured app is the computer being
 * controlled (`host`), is CAN-7910 and is refused here until it lands.
 *
 * The run's `config.remoteControl` exists only when the option is given, so
 * unconnected runs keep their fingerprint. Budgets are the suite's own:
 * nothing here loosens a threshold.
 */

export const REMOTE_CONTROL_ROLES = Object.freeze(['controller']);

export const REMOTE_CONTROL_DEFAULTS = Object.freeze({
  peers: 1,
  tasks: 200,
  statusIntervalMs: 1_000,
});

export const MAX_REMOTE_CONTROL_PEERS = 2;
export const MAX_REMOTE_CONTROL_TASKS = 5_000;
export const MIN_REMOTE_CONTROL_STATUS_INTERVAL_MS = 100;
/** The longest delay a Node timer keeps. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * Scenarios that cannot run connected, with the reason. The connection is
 * set up after the shell is ready and before the measured window opens, so a
 * scenario that captures from DOMContentLoaded would measure the setup, and
 * those scenarios also point the cloud at a dead origin, so the app could
 * not sign in. Scenarios that sign in to their own cloud account would
 * replace the connected account.
 */
export const REMOTE_CONTROL_UNSUPPORTED_SCENARIOS = Object.freeze({
  'startup-settle':
    'it captures from DOMContentLoaded and points the cloud at a dead origin',
  'startup-realistic':
    'it captures from DOMContentLoaded and points the cloud at a dead origin',
  'power-user-idle':
    'it captures from DOMContentLoaded and points the cloud at a dead origin',
  'power-user-active':
    'it captures from DOMContentLoaded and points the cloud at a dead origin',
  'cloud-cowork-first-open': 'it signs in to its own cloud account',
  'attachments-list-scroll': 'it signs in to its own cloud account',
  'w5-store-reload':
    'it reloads the renderer before capture, which drops the connection hooks',
  'w5-store-startup': 'it captures from DOMContentLoaded',
  'home-cowork-legacy': 'it captures from DOMContentLoaded',
});

const OPTION_KEYS = Object.freeze({
  '--remote-control-peers': 'peers',
  '--remote-control-tasks': 'tasks',
  '--remote-control-status-interval-ms': 'statusIntervalMs',
});

/** Whether `option` is one of the value options parsed here. */
export function isRemoteControlOption(option) {
  return option === '--remote-control' || Object.hasOwn(OPTION_KEYS, option);
}

/**
 * Records one parsed option into `raw` (the parser's own accumulator).
 * Throws a usage error for a bad value.
 */
export function recordRemoteControlOption(raw, option, value) {
  if (option === '--remote-control') {
    if (value === 'host')
      throw new Error(
        '--remote-control host (the scenario app as the computer being controlled) is not available yet; see CAN-7910',
      );
    if (!REMOTE_CONTROL_ROLES.includes(value))
      throw new Error(
        `--remote-control expects ${REMOTE_CONTROL_ROLES.join(' or ')}`,
      );
    raw.role = value;
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${option} expects a positive integer`);
  raw[OPTION_KEYS[option]] = parsed;
}

/**
 * The run's `config.remoteControl`, or null when the option was not given.
 * Throws a usage error for a combination that cannot run.
 */
export function remoteControlConfig(raw, { scenarios, releaseLike }) {
  if (raw.role === undefined) {
    const stray = Object.entries(OPTION_KEYS).find(
      ([, key]) => raw[key] !== undefined,
    );
    if (stray) throw new Error(`${stray[0]} requires --remote-control`);
    return null;
  }
  if (releaseLike)
    throw new Error(
      '--remote-control cannot be used with --release-like until a connected production run is verified',
    );
  const unsupported = scenarios.filter((scenario) =>
    Object.hasOwn(REMOTE_CONTROL_UNSUPPORTED_SCENARIOS, scenario),
  );
  if (unsupported.length > 0)
    throw new Error(
      `--remote-control cannot run ${unsupported
        .map(
          (scenario) =>
            `${scenario} (${REMOTE_CONTROL_UNSUPPORTED_SCENARIOS[scenario]})`,
        )
        .join(', ')}`,
    );
  const config = { ...REMOTE_CONTROL_DEFAULTS, ...raw };
  if (config.peers > MAX_REMOTE_CONTROL_PEERS)
    throw new Error(
      `--remote-control-peers expects 1 to ${MAX_REMOTE_CONTROL_PEERS}`,
    );
  if (config.tasks > MAX_REMOTE_CONTROL_TASKS)
    throw new Error(
      `--remote-control-tasks cannot exceed ${MAX_REMOTE_CONTROL_TASKS}`,
    );
  if (config.statusIntervalMs < MIN_REMOTE_CONTROL_STATUS_INTERVAL_MS)
    throw new Error(
      `--remote-control-status-interval-ms must be at least ${MIN_REMOTE_CONTROL_STATUS_INTERVAL_MS}`,
    );
  // Node clamps a longer timer to 1 ms, which would run a different workload.
  if (config.statusIntervalMs > MAX_TIMER_MS)
    throw new Error(
      `--remote-control-status-interval-ms cannot exceed ${MAX_TIMER_MS}`,
    );
  return {
    role: config.role,
    peers: config.peers,
    tasks: config.tasks,
    statusIntervalMs: config.statusIntervalMs,
  };
}

/** The usage lines for these options, in `performanceUsage`'s layout. */
export const REMOTE_CONTROL_USAGE = `  --remote-control controller        Run every scenario with Remote Control connected: the scenario app holds scripted paired computers in one-window mode
  --remote-control-peers <1-${MAX_REMOTE_CONTROL_PEERS}>     Scripted paired computers the scenario app holds (default ${REMOTE_CONTROL_DEFAULTS.peers})
  --remote-control-tasks <n>         Tasks in each paired computer's session snapshot (default ${REMOTE_CONTROL_DEFAULTS.tasks})
  --remote-control-status-interval-ms <ms> How often each paired computer flips a task's status and says its snapshot is stale (default ${REMOTE_CONTROL_DEFAULTS.statusIntervalMs})`;
