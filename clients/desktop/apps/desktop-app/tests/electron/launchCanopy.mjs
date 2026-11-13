import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electronPath from 'electron';
import {
  _electron as electron,
  test as playwrightTest,
} from '@playwright/test';
import { measureE2eHarnessOperation } from '../../../../scripts/lib/e2e-harness-measurement.mjs';
import {
  SUPERVISED_RETAIN_FILE_ENV,
  groupIsRetained,
  killProcessTree,
  listPosixProcesses,
  parsePosixProcessList,
  posixProcessGroupIsOwned,
  processGroupExists,
  readRetainedRoot,
  retainedProcessPids,
  retainedTreeRows,
} from '../performance/process-tree-supervisor.mjs';
import headlessBootstrap from '../performance/browser-profiles-production-headless-bootstrap.cjs';
import { assertProductionHeadlessTerminal } from '../performance/browser-profiles-evidence.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { RENDERER_GONE_MARKER } from './renderer-gone-marker.mjs';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const repoRoot = path.resolve(currentDirPath, '../../../..');
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  // Electron shutdown can overlap briefly with background persistence or git
  // setup. Node retries transient ENOTEMPTY/EBUSY/EPERM failures only when
  // maxRetries is explicitly non-zero.
  maxRetries: 20,
  retryDelay: 100,
};
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
// The Windows launcher closes only after its supervisor finishes bounded
// cleanup (15 s PowerShell enumerations, a 45 s release acknowledgement).
const DEFAULT_WINDOWS_LAUNCHER_CLOSE_TIMEOUT_MS = 60_000;
const SUPERVISED_PID_FILE_TIMEOUT_MS = 5_000;
const CLOSE_TRACE_PATH_ENV = 'CANOPY_E2E_CLOSE_TRACE_PATH';

function traceCloseCanopy(event, detail = {}) {
  const tracePath = process.env[CLOSE_TRACE_PATH_ENV];
  if (!tracePath) return;
  try {
    appendFileSync(
      tracePath,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`,
      'utf8',
    );
  } catch {
    // Diagnostic tracing must never change teardown behavior.
  }
}

function isTransientRemovalError(error) {
  return (
    error &&
    typeof error === 'object' &&
    ['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code)
  );
}

export function makeTestTreeOwnerWritable(dirPath) {
  if (!existsSync(dirPath)) return;
  const stats = lstatSync(dirPath);
  if (stats.isSymbolicLink()) return;
  if (!stats.isDirectory()) {
    chmodSync(dirPath, 0o600);
    return;
  }
  chmodSync(dirPath, 0o700);
  for (const entry of readdirSync(dirPath)) {
    makeTestTreeOwnerWritable(path.join(dirPath, entry));
  }
}

export async function removeTestDataDir(
  dirPath,
  { remove = rmSync, makeWritable = makeTestTreeOwnerWritable } = {},
) {
  try {
    remove(dirPath, REMOVE_OPTIONS);
    return;
  } catch (error) {
    if (!isTransientRemovalError(error)) {
      throw error;
    }
  }

  // Capability roots are deliberately published with read/execute-only
  // directory modes. Restore owner write permission only inside this exact
  // OS-temporary test tree before removing it; never follow links.
  makeWritable(dirPath);
  remove(dirPath, REMOVE_OPTIONS);
}
// E2E builds land in the private `out-e2e/` root (see scripts/build-e2e.mjs)
// so a developer's `npm run dev` watch build rewriting `out/` cannot swap the
// bundle under a running suite.
const supervisorEntryPath = path.join(
  currentDirPath,
  '..',
  'performance',
  process.platform === 'win32'
    ? 'process-tree-supervisor.cmd'
    : 'process-tree-supervisor.mjs',
);
const defaultViewportSize = { width: 1400, height: 900 };

// Suite-wide client feature flag defaults. Because setting
// CANOPY_E2E_CLIENT_FEATURE_FLAGS routes the flag service through the E2E
// override snapshot (seeded from the LaunchDarkly enabled-but-unavailable
// defaults) instead of the not-configured defaults, every flag whose two
// default modes disagree must be pinned here to preserve the pre-override E2E
// baseline. Otherwise specs would silently observe the enabled-unavailable
// value.
//
// - `canopy-cloud-sign-in-required`: the blocking Cloud sign-in gate defaults
//   to open (`false`) in the not-configured mode the E2E build runs in, but the
//   E2E override snapshot is seeded from enabled-unavailable defaults where the
//   gate is enforced. Disable it for the whole suite; the gate spec re-enables
//   it explicitly via `options.env`.
// - `canopy-portal-enabled`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so the Portal
//   sidebar entry stays present by default (matching the pre-override
//   baseline); the portal spec drives it off explicitly.
// - `canopy-desktop-pr-split`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so Split PR entry
//   points stay present by default; specs can drive it off explicitly.
// - `canopy-desktop-claude-tui-workers`: not-configured default is `true` but
//   the enabled-unavailable default is `false`. Pin it `true` so Claude Workers
//   settings/page automation keeps the pre-flag baseline by default.
// - `canopy-desktop-claude-tui-chats`: not-configured default is `true` but
//   the enabled-unavailable default is `false`. Pin it `true` so Claude Code
//   chat mode automation keeps the pre-flag baseline by default.
// - `canopy-shared-custom-agents`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so the Agents page
//   and command-palette entry stay present by default.
// - `canopy-desktop-workspace-code-graph`: not-configured default is `true` but
//   the enabled-unavailable default is `false`. Pin it `true` so code-graph
//   tools remain available to E2E live turns that exercise the default product
//   surface.
// - `canopy-shared-auto-model-routing`: not-configured default is `true` but
//   the enabled-unavailable default is `false`. Pin it `true` so Auto-routing
//   specs exercise the ordinary no-LaunchDarkly desktop baseline.
// - `canopy-desktop-account-proxy`: off in both defaults (launched dark).
//   Pin it `true` so the account proxy specs can reach the Experiments opt-in;
//   the per-user preference still hides every surface until a spec opts in.
// - `canopy-shared-space-notification-settings`: not-configured default is
//   `true` but the enabled-unavailable default is `false`. Pin it `true` so
//   the per-space notification choices appear as they do without
//   LaunchDarkly.
// - `canopy-desktop-chat-visuals`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so live turns offer
//   ShowVisual and PreviewVisual as they do without LaunchDarkly.
// - `canopy-device-remote-control`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so the Remote access
//   picker and settings keep the no-LaunchDarkly baseline by default.
// - `canopy-desktop-skill-suggestions`: not-configured default is `true` but
//   the enabled-unavailable default is `false`. Pin it `true` so the
//   suggestion banner and Settings section keep the no-LaunchDarkly baseline.
// - `canopy-desktop-hosted-settings`: not-configured default is `true` but the
//   enabled-unavailable default is `false`. Pin it `true` so the hosted
//   Account and Organizations settings appear as they do without
//   LaunchDarkly.
// - `canopy-desktop-external-agents-menu`: not-configured default is `true`
//   but the enabled-unavailable default is `false`. Pin it `true` so signed-in
//   account menus show the External agents row as they do without
//   LaunchDarkly; its spec drives it off explicitly.
const DEFAULT_E2E_CLIENT_FEATURE_FLAGS = {
  'canopy-desktop-labs-early-access': 'offered',
  // Terminals stay in the app; terminal acceptance opts in through Labs.
  'canopy-desktop-labs-daemon-terminals': 'offered',
  'canopy-desktop-labs-daemon-code-graph': 'offered',
  'canopy-desktop-labs-orchestrator-page': 'offered',
  // The Labs page experiments are `offered` (off until switched on) in
  // production (CAN-3678). Pin them `on` so specs that drive these pages keep
  // them without per-spec seeding; labs-pages.spec.mjs sets them back to
  // `offered` to cover the production default.
  'canopy-desktop-labs-overview-page': 'on',
  'canopy-desktop-labs-kanban-page': 'on',
  'canopy-desktop-labs-statistics-page': 'on',
  'canopy-desktop-labs-audit-trail-page': 'on',
  // Match the unconfigured defaults; bundled E2E readiness still forces
  // PostHog off unless the hermetic loopback collector is explicitly enabled.
  'canopy-desktop-posthog-capture-enabled': true,
  'canopy-desktop-posthog-session-replay-sample-rate': 100,
  'canopy-desktop-posthog-autocapture-enabled': true,
  'canopy-cloud-sign-in-required': false,
  'canopy-portal-enabled': true,
  'canopy-desktop-pr-split': true,
  'canopy-desktop-cursor-harness': true,
  'canopy-desktop-opencode-harness': true,
  'canopy-desktop-claude-tui-workers': true,
  'canopy-desktop-claude-tui-chats': true,
  'canopy-shared-custom-agents': true,
  'canopy-desktop-workspace-code-graph': true,
  'canopy-shared-auto-model-routing': true,
  'canopy-shared-space-notification-settings': true,
  'canopy-desktop-chat-visuals': true,
  'canopy-desktop-account-proxy': true,
  'canopy-device-remote-control': true,
  'canopy-desktop-skill-suggestions': true,
  'canopy-desktop-hosted-settings': true,
  'canopy-desktop-external-agents-menu': true,
  // MUST stay pinned: this flag's LaunchDarkly-enabled-unavailable default is
  // `false` (deployed environments fail closed until a revision producer
  // exists), and this launcher always seeds from THAT map. Without the pin the
  // shared-container entry points silently vanish from every spec.
  'canopy-desktop-shared-containers': true,
};

export const DAEMON_FILES_DRY_RUN_ENV = 'CANOPY_E2E_DAEMON_FILES_DRY_RUN';

export function isDaemonFilesDryRun(env = process.env) {
  return env[DAEMON_FILES_DRY_RUN_ENV] === '1';
}

/**
 * Suite-wide flag defaults. Dry-run evidence does not change product routing.
 */
export function resolveDefaultE2eClientFeatureFlags() {
  return {
    ...DEFAULT_E2E_CLIENT_FEATURE_FLAGS,
  };
}

const E2E_CLIENT_FEATURE_FLAGS_ENV = 'CANOPY_E2E_CLIENT_FEATURE_FLAGS';
const SUPERVISED_PID_FILE_ENV = 'CANOPY_E2E_SUPERVISED_PID_FILE';
const SUPERVISED_GROUPS_FILE_ENV = 'CANOPY_E2E_SUPERVISED_GROUPS_FILE';
const SUPERVISED_RUN_NONCE_ENV = 'CANOPY_E2E_SUPERVISED_RUN_NONCE';

function currentPlaywrightTestInfo() {
  try {
    return playwrightTest.info();
  } catch {
    return undefined;
  }
}

function launchMeasurementDetails(options) {
  return {
    configuration: {
      buildKind: options.buildKind ?? 'e2e',
      rootPath: options.rootPath,
      viewportSize: options.viewportSize ?? defaultViewportSize,
      reusesUserDataDir: options.userDataDir !== undefined,
      freshOnboarding: options.freshOnboarding === true,
      freshApprovalsUpgradeNotice: options.freshApprovalsUpgradeNotice === true,
      freshOnboardingTips: options.freshOnboardingTips === true,
      preserveProviderState: options.preserveProviderState === true,
      seedDemoWorkspaces: options.seedDemoWorkspaces === true,
      demoWorkspaceSet: options.demoWorkspaceSet,
      demoWorkspaceApps: options.demoWorkspaceApps,
      recordVideo: Boolean(options.recordVideoDir),
      electronArgs: options.electronArgs,
      env: options.env,
    },
    identity: {
      testInfo: options.testInfo ?? currentPlaywrightTestInfo(),
      ...options.measurementIdentity,
    },
  };
}

export function parseSupervisedTreePid(rawPid) {
  const pid = Number(String(rawPid).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('E2E supervisor did not record a valid process-tree PID.');
  }
  return pid;
}

/**
 * Read the supervisor's process-tree PID file. On Windows a missing or still
 * empty file is retried until a short deadline before the original read error
 * is reported; other platforms read once.
 */
export async function readSupervisedTreePid(
  pidFile,
  {
    platform = process.platform,
    readFile = readFileSync,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs = SUPERVISED_PID_FILE_TIMEOUT_MS,
    pollIntervalMs = 50,
  } = {},
) {
  const read = () => parseSupervisedTreePid(readFile(pidFile, 'utf8'));
  if (platform !== 'win32') return read();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const raw = String(readFile(pidFile, 'utf8'));
      if (raw.trim()) return parseSupervisedTreePid(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  return read();
}

export function createAbruptTreeKiller(
  supervisedTreePid,
  killTree = killProcessTree,
) {
  return () => killTree(supervisedTreePid, 'SIGKILL');
}

// Maps each Playwright ElectronApplication back to its supervised process-tree
// identity so closeCanopy can reap stragglers without changing its call
// signature across every spec.
const supervisedProcessTrees = new WeakMap();
const productionSidecars = new WeakMap();
const electronTerminalObservations = new WeakMap();

function boundedTerminalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: message.length <= 512 ? message : `${message.slice(0, 511)}…`,
  };
}

const LAUNCHER_OUTPUT_TAIL_LINES = 30;
const LAUNCHER_OUTPUT_PINNED_LINES = 12;
const LAUNCHER_OUTPUT_LINE_LIMIT = 400;
// Supervisor and watchdog exit reasons, and the main process's fatal errors.
const LAUNCHER_OUTPUT_PINNED_PATTERN =
  /\[e2e-(?:supervisor|watchdog)\]|Fatal uncaught exception|Unhandled rejection|Application shutdown could not/;

function boundedOutputLine(line) {
  return line.length <= LAUNCHER_OUTPUT_LINE_LIMIT
    ? line
    : `${line.slice(0, LAUNCHER_OUTPUT_LINE_LIMIT - 1)}…`;
}

/**
 * Retain a bounded record of the launcher's stdout and stderr: the last lines
 * plus every supervisor or fatal-error line. The listeners only read streams
 * Playwright already consumes.
 */
function collectLauncherOutput(child) {
  const output = { pinned: [], tail: [] };
  const accept = (label, raw) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    const entry = `${label}: ${boundedOutputLine(line)}`;
    output.tail.push(entry);
    if (output.tail.length > LAUNCHER_OUTPUT_TAIL_LINES) output.tail.shift();
    if (
      output.pinned.length < LAUNCHER_OUTPUT_PINNED_LINES &&
      LAUNCHER_OUTPUT_PINNED_PATTERN.test(line)
    )
      output.pinned.push(entry);
  };
  for (const [label, stream] of [
    ['out', child?.stdout],
    ['err', child?.stderr],
  ]) {
    if (!stream || typeof stream.on !== 'function') continue;
    const decoder = new TextDecoder();
    let partial = '';
    stream.on('data', (chunk) => {
      partial +=
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) accept(label, line);
      if (partial.length > LAUNCHER_OUTPUT_LINE_LIMIT) {
        accept(label, partial);
        partial = '';
      }
    });
    stream.on('end', () => {
      partial += decoder.decode();
      if (partial) accept(label, partial);
      partial = '';
    });
  }
  return output;
}

/**
 * Passively retain the terminal events emitted by Playwright's real Electron
 * launch child. This is a per-launch, in-memory observation only: it neither
 * waits for, signals, nor reaps the process. On Windows it also keeps the
 * launcher's bounded output, non-enumerably, so a nonzero result can report
 * why the supervisor or Electron exited. A result that could not listen for
 * `close` is marked `closeUnobservable`, also non-enumerably.
 */
export function observeElectronTerminalResult(
  electronApp,
  { platform = process.platform } = {},
) {
  const result = {
    pid: undefined,
    exit: undefined,
    close: undefined,
    error: undefined,
  };
  let closeObservable = false;
  try {
    const child = electronApp.process();
    result.pid = child?.pid;
    if (!child || typeof child.once !== 'function') {
      result.error = boundedTerminalError(
        new Error(
          'Electron launch did not expose an observable child process.',
        ),
      );
      return result;
    }
    if (platform === 'win32')
      Object.defineProperty(result, 'launcherOutput', {
        value: collectLauncherOutput(child),
      });
    child.once('exit', (code, signal) => {
      result.exit = { code, signal };
    });
    child.once('close', (code, signal) => {
      result.close = { code, signal };
    });
    closeObservable = true;
    child.once('error', (error) => {
      result.error = boundedTerminalError(error);
    });
  } catch (error) {
    result.error = boundedTerminalError(error);
  } finally {
    if (!closeObservable)
      Object.defineProperty(result, 'closeUnobservable', { value: true });
  }
  return result;
}

/**
 * Retain the first passive terminal observation for one launched application.
 * The WeakMap owns it for the application's lifetime so a failed or repeated
 * close cannot fall back to an unobserved terminal result.
 */
export function registerElectronTerminalObservation(electronApp, observation) {
  if (electronTerminalObservations.has(electronApp))
    return electronTerminalObservations.get(electronApp);
  electronTerminalObservations.set(
    electronApp,
    observation ?? observeElectronTerminalResult(electronApp),
  );
  return electronTerminalObservations.get(electronApp);
}

function terminalTupleSnapshot(tuple) {
  if (!tuple || typeof tuple !== 'object') return undefined;
  return {
    code: tuple.code,
    signal: tuple.signal,
  };
}

function terminalObservationSnapshot(observation) {
  return {
    pid: observation?.pid,
    exit: terminalTupleSnapshot(observation?.exit),
    close: terminalTupleSnapshot(observation?.close),
    error: observation?.error
      ? boundedTerminalError(
          observation.error instanceof Error
            ? observation.error
            : new Error(
                String(observation.error?.message ?? observation.error),
              ),
        )
      : undefined,
  };
}

const TERMINAL_REPORT_SUFFIX_LIMIT = 2048;
const TERMINAL_REPORT_TRUNCATION_MARKER = '…[truncated]';

function terminalReportPrimitive(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value);
  return `invalid-${typeof value}`;
}

function terminalReportSuffix(result) {
  const suffix =
    ` [terminal.pid=${terminalReportPrimitive(result.pid)}` +
    ` terminal.exit.code=${terminalReportPrimitive(result.exit?.code)}` +
    ` terminal.exit.signal=${terminalReportPrimitive(result.exit?.signal)}` +
    ` terminal.close.code=${terminalReportPrimitive(result.close?.code)}` +
    ` terminal.close.signal=${terminalReportPrimitive(result.close?.signal)}` +
    ` terminal.child-error.name=${terminalReportPrimitive(result.error?.name)}` +
    ` terminal.child-error.message=${terminalReportPrimitive(result.error?.message)}]`;
  if (suffix.length <= TERMINAL_REPORT_SUFFIX_LIMIT) return suffix;
  return `${suffix.slice(0, TERMINAL_REPORT_SUFFIX_LIMIT - TERMINAL_REPORT_TRUNCATION_MARKER.length)}${TERMINAL_REPORT_TRUNCATION_MARKER}`;
}

const TERMINAL_DIAGNOSTICS_SUFFIX_LIMIT = 6144;

function stringEntries(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string')
    : [];
}

/**
 * Close steps and launcher output for a failed terminal result, or undefined
 * when neither was recorded (every non-Windows close).
 */
function terminalDiagnostics(observation, closeSteps) {
  const output = observation?.launcherOutput;
  const diagnostics = {
    closeSteps: stringEntries(closeSteps),
    launcherOutput: {
      pinned: stringEntries(output?.pinned),
      tail: stringEntries(output?.tail),
    },
  };
  return diagnostics.closeSteps.length > 0 ||
    diagnostics.launcherOutput.pinned.length > 0 ||
    diagnostics.launcherOutput.tail.length > 0
    ? diagnostics
    : undefined;
}

function terminalDiagnosticsSuffix(diagnostics) {
  if (!diagnostics) return '';
  const { closeSteps, launcherOutput } = diagnostics;
  const suffix =
    ` [terminal.close-steps=${closeSteps.join(' > ') || 'missing'}]` +
    ` [terminal.launcher-output.pinned=${launcherOutput.pinned.join(' | ') || 'none'}]` +
    ` [terminal.launcher-output.tail=${launcherOutput.tail.join(' | ') || 'none'}]`;
  if (suffix.length <= TERMINAL_DIAGNOSTICS_SUFFIX_LIMIT) return suffix;
  return `${suffix.slice(0, TERMINAL_DIAGNOSTICS_SUFFIX_LIMIT - TERMINAL_REPORT_TRUNCATION_MARKER.length)}${TERMINAL_REPORT_TRUNCATION_MARKER}`;
}

export class ElectronTerminalResultError extends Error {
  constructor(observation, { closeSteps } = {}) {
    const result = terminalObservationSnapshot(observation);
    const diagnostics = terminalDiagnostics(observation, closeSteps);
    super(
      'Electron launch did not complete with matching exit(0, null) and close(0, null).' +
        terminalReportSuffix(result) +
        terminalDiagnosticsSuffix(diagnostics),
    );
    this.name = 'ElectronTerminalResultError';
    this.result = result;
    if (diagnostics) this.diagnostics = diagnostics;
  }
}

function assertSuccessfulElectronTerminalResult(observation, details) {
  const result = terminalObservationSnapshot(observation);
  const hasZeroExit = result.exit?.code === 0 && result.exit.signal === null;
  const hasZeroClose = result.close?.code === 0 && result.close.signal === null;
  const matchingTuples =
    result.exit?.code === result.close?.code &&
    result.exit?.signal === result.close?.signal;
  if (
    !Number.isInteger(result.pid) ||
    result.pid <= 0 ||
    result.error ||
    !hasZeroExit ||
    !hasZeroClose ||
    !matchingTuples
  )
    throw new ElectronTerminalResultError(observation, details);
}

export function registerSupervisedProcessTree(
  electronApp,
  supervisedTreePid,
  tracking = {},
) {
  supervisedProcessTrees.set(electronApp, {
    pid: supervisedTreePid,
    trackedGroupsFile: tracking.trackedGroupsFile,
    runNonce: tracking.runNonce,
    retainFile: tracking.retainFile,
  });
}

// Daemons specs keep across an app quit (CAN-5862), by root PID and `ps`
// start time. Only killRetainedDaemons and the exit guard below end them: a
// relaunched app's supervisor doesn't track a daemon it didn't start.
const retainedDaemons = new Map();
let retainedDaemonExitGuard = false;

/**
 * Every process group in a retained daemon's tree, including processes it
 * held at retention that have since outlived it.
 */
function retainedDaemonGroups(rows, root, known) {
  return [
    ...new Set(retainedTreeRows(rows, root, known).map((row) => row.pgid)),
  ].filter((pgid) => pgid > 1);
}

function killRetainedDaemonsSync() {
  if (retainedDaemons.size === 0) return;
  let rows;
  try {
    rows = parsePosixProcessList(
      execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
        timeout: 5_000,
      }),
    );
  } catch {
    return;
  }
  for (const [pid, { startTime, known }] of retainedDaemons) {
    for (const pgid of retainedDaemonGroups(rows, { pid, startTime }, known)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  retainedDaemons.clear();
}

/**
 * Kill every daemon a spec kept across an app quit, with its pipeline hosts
 * and steps, and wait (bounded) for their groups to go. Call it in the
 * spec's cleanup; the process-exit guard covers a cleanup that never ran.
 */
export async function killRetainedDaemons({
  listProcesses = listPosixProcesses,
  killTree = killProcessTree,
  treeExists = processGroupExists,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs = 5_000,
} = {}) {
  const signaled = [];
  for (const [pid, { startTime, known }] of retainedDaemons) {
    const rows = await listProcesses();
    for (const pgid of retainedDaemonGroups(rows, { pid, startTime }, known)) {
      await killTree(pgid, 'SIGKILL');
      signaled.push(pgid);
    }
    retainedDaemons.delete(pid);
  }
  const deadline = Date.now() + deadlineMs;
  while (signaled.some((pgid) => treeExists(pgid)) && Date.now() < deadline)
    await delay(50);
}

/** Record the data root's daemon as retained before the app quits. */
async function retainDaemonAcrossClose(userDataDir, supervisedTree) {
  const descriptor = path.join(
    realpathSync(userDataDir),
    'runtime',
    'core.json',
  );
  const pid = existsSync(descriptor)
    ? JSON.parse(readFileSync(descriptor, 'utf8')).pid
    : undefined;
  const rows = await listPosixProcesses();
  const root = Number.isInteger(pid)
    ? rows.find((row) => row.pid === pid)
    : undefined;
  if (!root) throw new Error('retainDaemon: no running daemon to retain');
  // The supervisor's watchdog reaps the daemon once this worker is gone.
  const controller = rows.find((row) => row.pid === process.pid);
  if (!controller)
    throw new Error(
      'retainDaemon: this test worker is not in the process list',
    );
  writeFileSync(
    supervisedTree.retainFile,
    JSON.stringify({
      v: 1,
      nonce: supervisedTree.runNonce,
      pid,
      startTime: root.startTime,
      controller: { pid: process.pid, startTime: controller.startTime },
    }),
  );
  const known = new Map();
  retainedTreeRows(rows, { pid, startTime: root.startTime }, known);
  retainedDaemons.set(pid, { startTime: root.startTime, known });
  if (!retainedDaemonExitGuard) {
    retainedDaemonExitGuard = true;
    process.on('exit', killRetainedDaemonsSync);
  }
}

function readSupervisedPosixGroups(
  supervisedTreePid,
  trackedGroupsFile,
  runNonce,
  readFile,
) {
  if (!trackedGroupsFile || !runNonce) return null;
  try {
    const parseMembers = (value) => {
      if (!Array.isArray(value)) return null;
      const members = new Map();
      for (const member of value) {
        if (
          !Array.isArray(member) ||
          member.length !== 2 ||
          !Number.isInteger(member[0]) ||
          member[0] <= 0 ||
          typeof member[1] !== 'string' ||
          !member[1]
        ) {
          return null;
        }
        members.set(member[0], member[1]);
      }
      return members;
    };
    const lines = String(readFile(trackedGroupsFile, 'utf8')).split(/\r?\n/);
    const header = JSON.parse(lines.shift() ?? '');
    if (
      !header ||
      header.v !== 1 ||
      header.nonce !== runNonce ||
      header.rootPid !== supervisedTreePid ||
      typeof header.rootStart !== 'string' ||
      !header.rootStart
    ) {
      return null;
    }
    const rootMembers =
      header.rootMembers === undefined
        ? new Map([[supervisedTreePid, header.rootStart]])
        : parseMembers(header.rootMembers);
    if (rootMembers?.get(supervisedTreePid) !== header.rootStart) return null;
    const groups = lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const record = JSON.parse(line);
        if (
          !record ||
          !Number.isInteger(record.pgid) ||
          record.pgid <= 1 ||
          record.pgid === supervisedTreePid ||
          typeof record.leaderStart !== 'string' ||
          !record.leaderStart ||
          !Array.isArray(record.members)
        ) {
          return [];
        }
        const members = parseMembers(record.members);
        if (!members) return [];
        return [
          { pgid: record.pgid, leaderStart: record.leaderStart, members },
        ];
      } catch {
        return [];
      }
    });
    return {
      root: {
        pgid: supervisedTreePid,
        leaderStart: header.rootStart,
        members: rootMembers,
      },
      groups,
    };
  } catch {
    return null;
  }
}

/**
 * Hard-kill whatever is left of a supervised Electron process tree and wait
 * (bounded) for the group to actually die. Graceful shutdown has already run
 * by the time this is called, so anything still alive in the tree is a
 * straggler; mirroring claude-process-host's discipline, the whole group gets
 * SIGKILL so no test leaves orphans accumulating process/IPC state on the
 * host. On POSIX, the supervisor periodically persists detached descendant
 * groups with creation identities; this reader accepts only records from the
 * current launch and revalidates each group against a fresh process snapshot
 * before signaling it. The supervisor's own grace-period cleanup remains the
 * async backstop.
 */
export async function reapSupervisedProcessTree(
  supervisedTreePid,
  {
    killTree = killProcessTree,
    treeExists = processGroupExists,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    pollIntervalMs = 50,
    deadlineMs = 2_000,
    trackedGroupsFile,
    runNonce,
    retainFile,
    listProcesses = listPosixProcesses,
    readFile = readFileSync,
  } = {},
) {
  const tracking =
    process.platform === 'win32'
      ? null
      : readSupervisedPosixGroups(
          supervisedTreePid,
          trackedGroupsFile,
          runNonce,
          readFile,
        );
  const trackedGroups = tracking?.groups ?? [];
  if (!treeExists(supervisedTreePid) && trackedGroups.length === 0) return;

  const retainedRoot =
    process.platform === 'win32'
      ? null
      : readRetainedRoot(retainFile, runNonce, readFile);
  const signaledGroups = [];
  for (const group of trackedGroups) {
    try {
      const rows = await listProcesses();
      if (!posixProcessGroupIsOwned(group, rows)) continue;
      if (groupIsRetained(group, rows, retainedProcessPids(rows, retainedRoot)))
        continue;
      await killTree(group.pgid, 'SIGKILL');
      signaledGroups.push(group.pgid);
    } catch {
      // A stale or temporarily unreadable sidecar must not fail a passing test.
    }
  }
  if (treeExists(supervisedTreePid)) {
    let rootIsOwned = !tracking;
    if (tracking) {
      try {
        const rows = await listProcesses();
        rootIsOwned = posixProcessGroupIsOwned(tracking.root, rows);
      } catch {
        rootIsOwned = false;
      }
    }
    if (rootIsOwned) {
      await killTree(supervisedTreePid, 'SIGKILL');
      signaledGroups.push(supervisedTreePid);
    }
  }
  if (signaledGroups.length === 0) return;
  const deadline = now() + deadlineMs;
  while (signaledGroups.some((pgid) => treeExists(pgid)) && now() < deadline) {
    await delay(Math.min(pollIntervalMs, deadline - now()));
  }
}

async function waitForSupervisedProcessExit(
  supervisedTreePid,
  {
    treeExists = processGroupExists,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs,
    pollIntervalMs = 50,
  },
) {
  const deadline = now() + timeoutMs;
  while (treeExists(supervisedTreePid) && now() < deadline) {
    await wait(Math.min(pollIntervalMs, deadline - now()));
  }
  return !treeExists(supervisedTreePid);
}

/**
 * Wait, bounded, for the observed launcher's `close`. On Windows Playwright's
 * launched process is the `cmd.exe` running the supervisor, which closes only
 * after the supervisor's cleanup. Once Electron has exited,
 * `electronApp.close()` resolves on the CDP disconnect without waiting for
 * that launcher. A child `error` does not settle the wait: it can report an
 * undeliverable signal while the launcher keeps running. An observation
 * without a `close` listener returns unsettled at once.
 */
export async function waitForElectronTerminalResult(
  observation,
  {
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs = DEFAULT_WINDOWS_LAUNCHER_CLOSE_TIMEOUT_MS,
    pollIntervalMs = 50,
  } = {},
) {
  const settled = () => Boolean(observation?.close);
  if (observation?.closeUnobservable) return settled();
  const deadline = now() + timeoutMs;
  while (!settled() && now() < deadline) {
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  return settled();
}

async function closeElectronAppWithDeadline(
  electronApp,
  { timeoutMs, scheduleTimeout, cancelTimeout },
) {
  const closePromise = Promise.resolve().then(() => electronApp.close());
  let timeoutHandle;
  const closeOutcome = await Promise.race([
    closePromise.then(
      () => ({ status: 'closed' }),
      (error) => ({ status: 'failed', error }),
    ),
    new Promise((resolve) => {
      timeoutHandle = scheduleTimeout(
        () => resolve({ status: 'timed-out' }),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeoutHandle !== undefined) {
      cancelTimeout(timeoutHandle);
    }
  });
  if (closeOutcome.status === 'failed') {
    throw closeOutcome.error;
  }
  return closeOutcome.status;
}

export function mergeE2eClientFeatureFlags(extraEnv, env = process.env) {
  const defaults = resolveDefaultE2eClientFeatureFlags(env);
  const raw = extraEnv?.[E2E_CLIENT_FEATURE_FLAGS_ENV];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...defaults,
          ...parsed,
        });
      }
    } catch {
      // The caller passed a non-JSON value; leave it untouched so the service's
      // own invalid-JSON warning path is preserved.
      return raw;
    }
  }
  return JSON.stringify(defaults);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function resolveViewportSizeOption(value) {
  if (value === undefined) {
    return defaultViewportSize;
  }
  if (value === null) {
    return null;
  }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isPositiveInteger(value.width) &&
    isPositiveInteger(value.height)
  ) {
    return value;
  }
  throw new Error(
    'launchCanopy viewportSize must be null or an object with positive integer width and height.',
  );
}

const mainWindowSelections = new WeakMap();
const mainWindowRendererUrls = new WeakMap();
const LAUNCH_OBSERVATION_RECORD_LIMIT = 64;
const LAUNCH_OBSERVATION_BYTE_LIMIT = 30_000;

function emitLaunchObservation(observer, stage, details) {
  if (!observer) return;
  try {
    const result = observer(stage, details);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {
    /* Passive observer. */
  }
}

function createLaunchObserver(record) {
  if (typeof record !== 'function') return undefined;
  let records = 0,
    bytes = 0,
    stopped = false;
  const markerReserve = Buffer.byteLength(
    JSON.stringify({
      stage: 'launch-observation-truncated',
      sequence: LAUNCH_OBSERVATION_RECORD_LIMIT,
      records: LAUNCH_OBSERVATION_RECORD_LIMIT - 1,
    }),
  );
  return (stage, details = {}) => {
    if (stopped) return;
    const nextDetails = { ...details, sequence: records + 1 };
    const eventBytes = Buffer.byteLength(
      JSON.stringify({ stage, ...nextDetails }),
    );
    if (
      records >= LAUNCH_OBSERVATION_RECORD_LIMIT - 1 ||
      bytes + eventBytes + markerReserve > LAUNCH_OBSERVATION_BYTE_LIMIT
    ) {
      const markerDetails = { sequence: records + 1, records };
      const markerBytes = Buffer.byteLength(
        JSON.stringify({
          stage: 'launch-observation-truncated',
          ...markerDetails,
        }),
      );
      stopped = true;
      if (
        records < LAUNCH_OBSERVATION_RECORD_LIMIT &&
        bytes + markerBytes <= LAUNCH_OBSERVATION_BYTE_LIMIT
      ) {
        records++;
        bytes += markerBytes;
        emitLaunchObservation(
          record,
          'launch-observation-truncated',
          markerDetails,
        );
      }
      return;
    }
    records++;
    bytes += eventBytes;
    emitLaunchObservation(record, stage, nextDetails);
  };
}

function rendererEntryIdentity(value) {
  // Electron 45 can expose the window before Playwright sees its first
  // commit, so `page.url()` is still empty: not the entry yet, keep waiting.
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

/** Select the native app window at its configured renderer entry, without
 * waiting for DOM readiness or temporary maintenance pages to finish.
 */
export function getMainWindow(
  electronApp,
  {
    timeout = 30_000,
    rendererUrl = mainWindowRendererUrls.get(electronApp),
    launchObserver,
  } = {},
) {
  const cached = mainWindowSelections.get(electronApp);
  if (cached) return cached;
  if (!rendererUrl)
    return Promise.reject(
      new Error('The application renderer entry is not configured.'),
    );
  const expectedUrl = rendererEntryIdentity(rendererUrl);
  // Capture the owning test now; a later failure must not attach to another
  // test. Public array push reports a Buffer body synchronously in Playwright.
  let diagnosticAttachments;
  try {
    diagnosticAttachments = playwrightTest.info().attachments;
  } catch {
    /* Non-Playwright callers have no reporting context. */
  }
  const selection = new Promise((resolve, reject) => {
    let settled = false;
    const observeLaunch = launchObserver
      ? (stage, outcome) => {
          if (!settled)
            emitLaunchObservation(launchObserver, stage, { outcome });
        }
      : undefined;
    observeLaunch?.('main-window-selection', 'entered');
    const observed = new Map();
    // Retain only values obtained by the existing inspection/events. These are
    // historical observations, never a fresh timeout-time liveness claim.
    const evidence = { expectedUrl: undefined, events: [], truncated: false };
    const diagnosticPages = new WeakMap();
    let windowCount = 0,
      eventBytes = 0;
    const safeUrl = (value) => {
      try {
        const url = new URL(value);
        const scheme = url.protocol === 'app-renderer:';
        const local =
          url.protocol === 'file:' ||
          scheme ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        const surface = url.searchParams.get('surface');
        return `${local ? `${url.protocol === 'file:' ? 'file://' : scheme ? `app-renderer://${url.host}` : url.origin}${url.pathname}` : url.protocol === 'about:' ? 'about:blank' : url.origin}${local && surface && /^[a-z-]{1,64}$/.test(surface) ? `?surface=${surface}` : ''}`.slice(
          0,
          512,
        );
      } catch {
        return 'unavailable';
      }
    };
    evidence.expectedUrl = safeUrl(expectedUrl);
    const note = (stage, page, details = {}) => {
      if (settled) return;
      let windowId = page && diagnosticPages.get(page);
      if (page && windowId === undefined) {
        if (windowCount >= 16) {
          evidence.truncated = true;
          return;
        }
        windowId = ++windowCount;
        diagnosticPages.set(page, windowId);
      }
      const event = {
        stage,
        windowId,
        order: evidence.events.length + 1,
        monotonicNs: process.hrtime.bigint().toString(),
        ...details,
      };
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (evidence.events.length >= 64 || eventBytes + bytes > 30000) {
        evidence.truncated = true;
        return;
      }
      eventBytes += bytes;
      evidence.events.push(event);
    };
    const forget = (page) => {
      const listeners = observed.get(page);
      if (!listeners) return;
      page.off('framenavigated', listeners.navigated);
      page.off('load', listeners.loaded);
      page.off('close', listeners.closed);
      observed.delete(page);
    };
    const finish = (error, page) => {
      if (settled) return;
      note(error ? 'selection-rejected' : 'selected', page);
      observeLaunch?.(
        'main-window-selection',
        error ? 'rejected' : 'fulfilled',
      );
      if (error) {
        try {
          Object.defineProperty(error, 'mainWindowSelection', {
            value: evidence,
            enumerable: true,
            configurable: true,
          });
        } catch {
          /* Keep frozen or non-object rejection identity. */
        }
      }
      settled = true;
      clearTimeout(timer);
      electronApp.off('window', observe);
      electronApp.off('close', closed);
      for (const candidate of observed.keys()) forget(candidate);
      if (error) {
        try {
          diagnosticAttachments?.push({
            name: 'main-window-selection.json',
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(evidence)),
          });
        } catch {
          /* Reporting cannot replace the original rejection. */
        }
        reject(error);
      } else resolve(page);
    };
    const closed = () =>
      finish(
        new Error('Electron closed before its application window opened.'),
      );
    const inspect = async (page) => {
      if (settled || page.isClosed()) return;
      try {
        note('inspection-entered', page);
        observeLaunch?.('main-window-native-association', 'entered');
        let handle;
        try {
          handle = await electronApp.browserWindow(page);
          observeLaunch?.('main-window-native-association', 'fulfilled');
        } catch (error) {
          observeLaunch?.('main-window-native-association', 'rejected');
          throw error;
        }
        let nativeUrl, native;
        try {
          observeLaunch?.('main-window-native-evaluate', 'entered');
          try {
            native = await handle.evaluate((window) => {
              if (!window)
                return {
                  nativeOwner: false,
                  destroyed: null,
                  parent: null,
                  url: null,
                };
              if (window.isDestroyed())
                return {
                  nativeOwner: true,
                  destroyed: true,
                  parent: null,
                  url: null,
                };
              if (window.getParentWindow())
                return {
                  nativeOwner: true,
                  destroyed: false,
                  parent: true,
                  url: null,
                };
              return {
                nativeOwner: true,
                destroyed: false,
                parent: false,
                url: window.webContents.getURL(),
              };
            });
            observeLaunch?.('main-window-native-evaluate', 'fulfilled');
          } catch (error) {
            observeLaunch?.('main-window-native-evaluate', 'rejected');
            throw error;
          }
          nativeUrl = native.url;
          let observedPageUrl = 'unavailable';
          try {
            observedPageUrl = safeUrl(page.url());
          } catch {
            /* Cached diagnostic value only. */
          }
          note('inspection', page, {
            nativeOwner: native.nativeOwner,
            destroyed: native.destroyed,
            parent: native.parent,
            nativeUrl: nativeUrl === null ? null : safeUrl(nativeUrl),
            pageUrl: observedPageUrl,
          });
        } finally {
          observeLaunch?.('main-window-native-dispose', 'entered');
          try {
            await handle.dispose();
            observeLaunch?.('main-window-native-dispose', 'fulfilled');
          } catch (error) {
            observeLaunch?.('main-window-native-dispose', 'rejected');
            // Preserve the existing finally precedence: disposal rejection
            // replaces an earlier inspection rejection with the same object.
            // eslint-disable-next-line no-unsafe-finally
            throw error;
          }
        }
        if (
          nativeUrl &&
          rendererEntryIdentity(nativeUrl) === expectedUrl &&
          !page.isClosed() &&
          rendererEntryIdentity(page.url()) === expectedUrl
        )
          finish(undefined, page);
      } catch (error) {
        note('inspection-rejected', page, { pageClosed: page.isClosed() });
        if (!page.isClosed()) finish(error);
      }
    };
    const observe = (page) => {
      if (settled || page.isClosed() || observed.has(page)) return;
      const navigated = (frame) => {
        if (frame === page.mainFrame()) {
          note('main-frame-navigation', page);
          void inspect(page);
        }
      };
      const pageClosed = () => {
        note('window-close', page);
        forget(page);
      };
      // Navigation can be observed before the native owner's URL is ready.
      // A normal load event gives both identities another check, without
      // accepting the page URL alone or polling while the window starts.
      const loaded = () => {
        note('main-frame-load', page);
        void inspect(page);
      };
      note('window-observed', page);
      observed.set(page, { navigated, loaded, closed: pageClosed });
      page.on('framenavigated', navigated);
      page.on('load', loaded);
      page.once('close', pageClosed);
      void inspect(page);
    };
    const timer = setTimeout(
      () => finish(new Error('Timed out identifying the application window.')),
      timeout,
    );
    electronApp.on('window', observe);
    electronApp.once('close', closed);
    for (const page of electronApp.windows()) observe(page);
  });
  mainWindowSelections.set(electronApp, selection);
  void selection.then(
    (page) => {
      const invalidate = () => {
        if (mainWindowSelections.get(electronApp) === selection)
          mainWindowSelections.delete(electronApp);
      };
      if (page.isClosed()) invalidate();
      else page.once('close', invalidate);
    },
    () => {
      if (mainWindowSelections.get(electronApp) === selection)
        mainWindowSelections.delete(electronApp);
    },
  );
  return selection;
}

export function resolveE2eMainEntryPath(
  rootPath = repoRoot,
  pathExists = existsSync,
  outDirName = process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e',
) {
  const mainEntryPath = path.join(rootPath, outDirName, 'main', 'index.js');
  if (!pathExists(mainEntryPath)) {
    throw new Error(
      'Missing the E2E main bundle. Run `npm run build:e2e` before launching Electron tests.',
    );
  }
  return mainEntryPath;
}

export function buildE2eLaunchMarkerEnv(buildKind, showWindow = false) {
  return {
    ...(buildKind === 'production' ? { CANOPY_E2E_ISOLATED_LOGGING: '1' } : {}),
    CANOPY_E2E_SHOW_WINDOW: showWindow ? '1' : '0',
  };
}

export function resolveProductionMainEntryPath(
  rootPath = repoRoot,
  pathExists = existsSync,
) {
  const mainEntryPath = path.join(rootPath, 'out', 'main', 'index.js');
  if (!pathExists(mainEntryPath)) {
    throw new Error(
      'Missing the production main bundle. Run `npm run build` before launching Electron tests.',
    );
  }
  return mainEntryPath;
}

function isolatedProviderStatePaths(userDataDir) {
  return {
    claude: path.join(userDataDir, 'provider-state', 'claude'),
    codex: path.join(userDataDir, 'provider-state', 'codex'),
    // The `.cursor`, `.agents`, and `.grok` roots a Cursor chat inherits
    // skills from; relocated so a suite never reads the developer's own.
    home: path.join(userDataDir, 'provider-state', 'home'),
  };
}

export function prepareIsolatedProviderState(userDataDir) {
  const providerState = isolatedProviderStatePaths(userDataDir);
  mkdirSync(providerState.claude, { recursive: true });
  mkdirSync(providerState.codex, { recursive: true });
  mkdirSync(providerState.home, { recursive: true });
}

function resolveCanonicalDataPath(candidate) {
  const missingSegments = [];
  let existingAncestor = path.resolve(candidate);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = existsSync(existingAncestor)
    ? realpathSync(existingAncestor)
    : existingAncestor;
  return path.resolve(canonicalAncestor, ...missingSegments);
}

/**
 * Refuse to launch the app against a real Canopy data namespace.
 *
 * The app resolves its data root from `CANOPY_DATA_DIR` and writes the whole
 * workspace index from its own in-memory view, so a launch pointed at a live
 * namespace does not merely add test rows — it replaces the developer's
 * workspace list wholesale. That happened: a suite resolving to `~/.canopy`
 * rewrote `workspaces/index.json` down to its own fixtures, and nothing on the
 * machine (no snapshots, no Time Machine) could restore the sidebar order and
 * colours that went with it.
 *
 * The rule is the *shape*, not a brand list, so `.canopy-dev`, `.canopy-rc`,
 * a future brand, and neighbouring tool namespaces like `.claude`/`.codex` are
 * all covered without anyone remembering to extend an allowlist. A deep path
 * inside such a namespace is fine — Canopy keeps its own git worktrees under
 * `~/.canopy/workspaces/...`, so repo-relative directories legitimately live
 * there; only the namespace root is the data root that must stay untouched.
 *
 * `homeDir` is injectable so the unit test never depends on the real home.
 */
export function assertIsolatedCanopyDataDir(
  variableName,
  value,
  homeDir = os.homedir(),
  { allowEmpty = false } = {},
) {
  const reject = (reason) => {
    throw new Error(
      `${variableName} must point at an isolated test directory, but it ${reason}: ${String(value)}\n` +
        'E2E launches build one with ' +
        "mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-')). " +
        "Pointing a launch at a real namespace lets the suite overwrite the developer's live Canopy data.",
    );
  };
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (allowEmpty && typeof value === 'string') return;
    reject(
      'is empty, so the app would fall back to the real brand data directory',
    );
  }
  const raw = value.trim();
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith(`~${path.sep}`)) {
    reject('uses an unexpanded `~`, which Node resolves against the cwd');
  }

  const candidatePaths = new Set([
    path.resolve(raw),
    resolveCanonicalDataPath(raw),
  ]);
  const homePaths = new Set([
    path.resolve(homeDir),
    resolveCanonicalDataPath(homeDir),
  ]);
  const pathsMatch = (left, right) => {
    if (left === right) return true;
    try {
      const leftStats = statSync(left);
      const rightStats = statSync(right);
      return (
        leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino
      );
    } catch {
      return false;
    }
  };
  const containsHome = (candidatePath, homePath) => {
    const relativeHome = path.relative(candidatePath, homePath);
    if (
      relativeHome.length > 0 &&
      !relativeHome.startsWith('..') &&
      !path.isAbsolute(relativeHome)
    ) {
      return true;
    }
    let homeAncestor = path.dirname(homePath);
    while (homeAncestor !== path.dirname(homeAncestor)) {
      if (pathsMatch(candidatePath, homeAncestor)) return true;
      homeAncestor = path.dirname(homeAncestor);
    }
    return pathsMatch(candidatePath, homeAncestor);
  };
  const protectedNamespaceTargets = new Set();
  for (const homePath of homePaths) {
    try {
      for (const entry of readdirSync(homePath, { withFileTypes: true })) {
        if (!entry.name.startsWith('.')) continue;
        const namespacePath = path.join(homePath, entry.name);
        try {
          protectedNamespaceTargets.add(realpathSync(namespacePath));
        } catch {
          // Broken or concurrently removed entries cannot be a writable target.
        }
      }
    } catch {
      // The normal host home is readable. Preserve the path-only checks when
      // an injected home fixture is removed concurrently.
    }
  }
  // Check both lexical and canonical forms. The lexical form catches a live
  // `~/.canopy` namespace that is itself a symlink to an external directory;
  // the canonical form catches an innocent-looking external path that enters
  // a live namespace through a symlinked ancestor.
  for (const candidatePath of candidatePaths) {
    for (const namespaceTarget of protectedNamespaceTargets) {
      if (pathsMatch(candidatePath, namespaceTarget)) {
        reject('is the canonical target of a home dot-namespace');
      }
    }
    for (const homePath of homePaths) {
      if (pathsMatch(candidatePath, homePath)) {
        reject('is the home directory itself');
      }
      // `/`, `/Users`, … — a data root above home is worse than the namespace case.
      if (containsHome(candidatePath, homePath)) {
        reject('contains the home directory');
      }
      if (
        pathsMatch(path.dirname(candidatePath), homePath) &&
        path.basename(candidatePath).startsWith('.')
      ) {
        reject('is a dot-namespace directly under the home directory');
      }
    }
  }
}

function resolveDataDirValidationPolicy(extraEnv, effectiveHome) {
  const hostHome = os.userInfo().homedir;
  const hasExplicitHome = Object.prototype.hasOwnProperty.call(
    extraEnv,
    'HOME',
  );
  let explicitHomeIsIsolated = false;
  if (hasExplicitHome && typeof effectiveHome === 'string') {
    try {
      assertIsolatedCanopyDataDir('HOME', effectiveHome, hostHome);
      explicitHomeIsIsolated = true;
    } catch {
      explicitHomeIsIsolated = false;
    }
  }
  return {
    allowEmpty: explicitHomeIsIsolated,
    primaryHome:
      explicitHomeIsIsolated || typeof effectiveHome !== 'string'
        ? hostHome
        : effectiveHome,
    hostHome,
  };
}

function assertDataRootWithPolicy(variableName, value, policy) {
  assertIsolatedCanopyDataDir(variableName, value, policy.primaryHome, {
    allowEmpty: policy.allowEmpty,
  });
  if (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    path.resolve(policy.primaryHome) !== path.resolve(policy.hostHome)
  ) {
    assertIsolatedCanopyDataDir(variableName, value, policy.hostHome);
  }
}

function assertUsableE2eUserDataFallback(primaryDataDir, fallbackDataDir) {
  if (typeof primaryDataDir === 'string' && primaryDataDir.trim().length > 0) {
    return;
  }
  if (
    typeof fallbackDataDir !== 'string' ||
    fallbackDataDir.trim().length === 0
  ) {
    throw new Error(
      'CANOPY_E2E_USER_DATA_DIR must be a non-empty existing directory when CANOPY_DATA_DIR is blank',
    );
  }
  try {
    if (statSync(path.resolve(fallbackDataDir.trim())).isDirectory()) return;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    'CANOPY_E2E_USER_DATA_DIR must be a non-empty existing directory when CANOPY_DATA_DIR is blank',
  );
}

function normalizedLaunchHome(extraEnv) {
  const candidate = extraEnv.HOME ?? process.env.HOME ?? os.homedir();
  if (
    typeof candidate === 'string' &&
    (candidate.includes('__codex-homes__') ||
      candidate.includes(`${path.sep}codex-home${path.sep}`))
  ) {
    return os.userInfo().homedir;
  }
  return candidate;
}

function assertLaunchDataRootsBeforeMutation(userDataDir, extraEnv = {}) {
  const effectiveHome = normalizedLaunchHome(extraEnv);
  const policy = resolveDataDirValidationPolicy(extraEnv, effectiveHome);
  assertDataRootWithPolicy('CANOPY_DATA_DIR', userDataDir, policy);
  assertDataRootWithPolicy(
    'CANOPY_SECURE_DATA_DIR',
    `${userDataDir}-secure`,
    policy,
  );
  if (Object.prototype.hasOwnProperty.call(extraEnv, 'CANOPY_DATA_DIR')) {
    assertDataRootWithPolicy(
      'CANOPY_DATA_DIR',
      extraEnv.CANOPY_DATA_DIR,
      policy,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(extraEnv, 'CANOPY_SECURE_DATA_DIR')
  ) {
    assertDataRootWithPolicy(
      'CANOPY_SECURE_DATA_DIR',
      extraEnv.CANOPY_SECURE_DATA_DIR,
      policy,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(extraEnv, 'CANOPY_E2E_USER_DATA_DIR')
  ) {
    assertDataRootWithPolicy(
      'CANOPY_E2E_USER_DATA_DIR',
      extraEnv.CANOPY_E2E_USER_DATA_DIR,
      policy,
    );
  }
  const primaryDataDir = Object.prototype.hasOwnProperty.call(
    extraEnv,
    'CANOPY_DATA_DIR',
  )
    ? extraEnv.CANOPY_DATA_DIR
    : userDataDir;
  const fallbackDataDir = Object.prototype.hasOwnProperty.call(
    extraEnv,
    'CANOPY_E2E_USER_DATA_DIR',
  )
    ? extraEnv.CANOPY_E2E_USER_DATA_DIR
    : process.env.CANOPY_E2E_USER_DATA_DIR;
  assertUsableE2eUserDataFallback(primaryDataDir, fallbackDataDir);
}

export function buildElectronEnv(
  userDataDir,
  extraEnv = {},
  { preserveProviderState = false } = {},
) {
  const mockBaseUrl = (
    process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'
  ).replace(/\/+$/, '');
  const providerState = isolatedProviderStatePaths(userDataDir);
  // Keep the real login HOME so macOS Electron `safeStorage` can resolve the
  // login Keychain. Some development shells (including selected-capability
  // Codex chats) themselves run under a legacy synthetic Codex home, though.
  // Never propagate that compatibility environment into the app under test:
  // E2E must exercise the same canonical-state boundary as production.
  const env = {
    ...process.env,
    CANOPY_ENV: 'development',
    CANOPY_DATA_DIR: userDataDir,
    CANOPY_SECURE_DATA_DIR: `${userDataDir}-secure`,
    // Deterministic time/locale for date- and locale-formatted UI.
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    SHELL: '/bin/bash',
    // A committed git identity so any in-app commit during setup never fails.
    GIT_AUTHOR_NAME: 'Canopy E2E',
    GIT_AUTHOR_EMAIL: 'e2e@canopy.test',
    GIT_COMMITTER_NAME: 'Canopy E2E',
    GIT_COMMITTER_EMAIL: 'e2e@canopy.test',
    // Point the build-gated provider redirect seams at the shared mock server
    // (started suite-wide by playwright.config.mjs at 127.0.0.1:4011). These are
    // only honored in an E2E build (`if (__CANOPY_E2E__)`), so they're inert in
    // production. The mock returns benign defaults for unregistered keys, so
    // they're safe for every spec; live-turn specs register a scenario + embed a
    // `[Canopy-C<id>]` marker to drive a scripted conversation.
    CANOPY_MOCK_LLM_BASE_URL: mockBaseUrl,
    CANOPY_MOCK_API_KEY: 'mock',
    CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS: '0',
    CANOPY_GITHUB_API_BASE_URL: mockBaseUrl,
    CANOPY_LINEAR_API_BASE_URL: `${mockBaseUrl}/graphql`,
    ...extraEnv,
    // Provider CLIs persist global config, project trust, marketplace clones,
    // and atomic-write staging files outside Electron's userData directory by
    // default. Keep normal E2E launches self-contained so parallel and aborted
    // tests cannot mutate or bloat the developer's real provider state. The
    // manually run real-model benchmark opts out because host auth is its
    // explicit prerequisite.
    ...(preserveProviderState
      ? {}
      : {
          CLAUDE_CONFIG_DIR: providerState.claude,
          CODEX_HOME: providerState.codex,
          CANOPY_CURSOR_USER_HOME: providerState.home,
          // Claude Desktop keeps session records outside CLAUDE_CONFIG_DIR;
          // the bulk project import (CAN-2439) reads them, so isolate that
          // root as well or a developer's real desktop sessions leak into
          // every discovery scan the suite runs. A spec may name its own
          // isolated root instead (CAN-3076 seeds Cowork scratch folders
          // there, which must sit outside the app data dir to be importable).
          CANOPY_CLAUDE_DESKTOP_DATA_DIR:
            extraEnv.CANOPY_CLAUDE_DESKTOP_DATA_DIR ??
            path.join(providerState.claude, 'desktop'),
        }),
  };
  // A headed request must belong to this launch. Never inherit a stale shell
  // setting into ordinary UI automation or performance runs.
  env.CANOPY_E2E_SHOW_WINDOW =
    extraEnv.CANOPY_E2E_SHOW_WINDOW === '1' ? '1' : '0';
  if (extraEnv.CANOPY_E2E_OFFSCREEN_WINDOW !== '1')
    delete env.CANOPY_E2E_OFFSCREEN_WINDOW;
  const inheritedHome = env.HOME;
  if (
    typeof inheritedHome === 'string' &&
    (inheritedHome.includes('__codex-homes__') ||
      inheritedHome.includes(`${path.sep}codex-home${path.sep}`))
  ) {
    env.HOME = os.userInfo().homedir;
  }
  // Always fold in the suite-wide client feature flag defaults (notably the
  // disabled Cloud sign-in gate), merging any caller-provided override on top.
  env[E2E_CLIENT_FEATURE_FLAGS_ENV] = mergeE2eClientFeatureFlags(extraEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  // Agent shells launched by a running desktop inherit its Crashpad pipe.
  // A disposable test renderer must never report into that desktop's database.
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  // Never inherit a live LaunchDarkly client. Startup fixtures may explicitly
  // select a dummy client id only when all LD traffic uses a loopback server.
  delete env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  const fixtureClientId = extraEnv.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID?.trim();
  if (fixtureClientId) {
    const fixtureUrl = new URL(
      extraEnv.CANOPY_E2E_LAUNCHDARKLY_BASE_URL ?? 'http://invalid',
    );
    if (
      fixtureUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
    ) {
      throw new Error(
        'Explicit LaunchDarkly test client ids require an HTTP loopback endpoint',
      );
    }
    env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = fixtureClientId;
  }
  // An API key outranks the claude.ai login, so Claude reports zero account
  // connectors and every connector row renders "unavailable". A developer or
  // runner exporting one would fail provider-connector specs for a reason that
  // says nothing about the code — the same host-dependence that made the MCP
  // settings spec fail whenever the app was running.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Scrub any `CANOPY_<TOOL>_BINARY_PATH` overrides inherited from the developer's
  // login shell (the installed packaged Canopy.app exports these). They would
  // repoint the entire bundled bin dir at the packaged install instead of the
  // dev `.cache/bin`, breaking live SDK turns and bundled `rg`/`gh` resolution.
  for (const key of Object.keys(env)) {
    if (/^CANOPY_[A-Z0-9]+_BINARY_PATH$/.test(key)) {
      delete env[key];
    }
  }
  // Keep GitHub auth tests deterministic and avoid leaking the developer/CI
  // token source into tests that are asserting the no-env-override state.
  // Individual specs can still opt into the env-token path via `options.env`.
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(extraEnv, key)) {
      delete env[key];
    }
  }
  // Last thing before the env is handed to Electron, and deliberately on the
  // FINAL values: `extraEnv` is spread after the defaults above, so a spec can
  // repoint either data root. Checking the resolved values is the only way to
  // catch that as well as a bad `userDataDir`.
  const validationPolicy = resolveDataDirValidationPolicy(extraEnv, env.HOME);
  assertDataRootWithPolicy(
    'CANOPY_DATA_DIR',
    env.CANOPY_DATA_DIR,
    validationPolicy,
  );
  assertDataRootWithPolicy(
    'CANOPY_SECURE_DATA_DIR',
    env.CANOPY_SECURE_DATA_DIR,
    validationPolicy,
  );
  if (Object.prototype.hasOwnProperty.call(env, 'CANOPY_E2E_USER_DATA_DIR')) {
    assertDataRootWithPolicy(
      'CANOPY_E2E_USER_DATA_DIR',
      env.CANOPY_E2E_USER_DATA_DIR,
      validationPolicy,
    );
  }
  assertUsableE2eUserDataFallback(
    env.CANOPY_DATA_DIR,
    env.CANOPY_E2E_USER_DATA_DIR,
  );
  return env;
}

/**
 * A per-launch MCP proxy port in a high range far from the app default
 * (37645) and the shared mock server (4011). The default port collides with
 * any OTHER Canopy instance running on the machine (e.g. the developer's own
 * app) — the proxy's availability probe then fails EVERY interactive chat
 * session with "MCP proxy port … is already in use by another Canopy MCP
 * proxy", breaking all live-turn specs. Randomizing also keeps two
 * concurrently-running E2E apps (--workers=2) from colliding with each other.
 */
function pickEphemeralMcpProxyPort() {
  return 20000 + Math.floor(Math.random() * 15000);
}

function seedOnboardingCompleted(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  if (existsSync(preferencesPath)) {
    let persisted;
    try {
      persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    } catch {
      // Some recovery specs intentionally launch with invalid preferences.
      // Leave those fixtures untouched so the app exercises its recovery path;
      // CanopyAppDriver.waitForShell() handles the post-recovery legal gate.
      return;
    }
    if (!persisted || typeof persisted !== 'object') {
      return;
    }
    const preferences =
      persisted.preferences && typeof persisted.preferences === 'object'
        ? persisted.preferences
        : {};
    writeFileSync(
      preferencesPath,
      JSON.stringify(
        {
          ...persisted,
          version: persisted.version ?? 1,
          preferences: {
            ...preferences,
            onboardingCompleted: preferences.onboardingCompleted ?? ['v1'],
            legalConsentAcceptedAt:
              preferences.legalConsentAcceptedAt ?? '2026-07-06T00:00:00.000Z',
            legalConsentTosVersion:
              preferences.legalConsentTosVersion ?? '2026-07-06',
            mcpProxyPort:
              preferences.mcpProxyPort ?? pickEphemeralMcpProxyPort(),
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    return;
  }
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          initializedCuratedPluginDefaults: [],
          // Seed the blocking first-run legal acceptance so default launches
          // land on the shell. Fresh-onboarding specs (`freshOnboarding: true`)
          // skip this seed and clear the gate via `acceptLegalConsent()`.
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
          legalConsentTosVersion: '2026-07-06',
          mcpProxyPort: pickEphemeralMcpProxyPort(),
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // The default harness launch represents a brand-new user, but it must
  // pre-create preferences to bypass onboarding. Seed the production
  // migration's not-applicable marker at the same time so this test-only file
  // creation does not make a fresh user look like an upgrade.
  const migrationsPath = path.join(userDataDir, 'migrations.json');
  let migrations = {};
  if (existsSync(migrationsPath)) {
    try {
      migrations = JSON.parse(readFileSync(migrationsPath, 'utf8'));
    } catch {
      migrations = {};
    }
  }
  writeFileSync(
    migrationsPath,
    `${JSON.stringify(
      {
        ...migrations,
        version: 1,
        approval_defaults_full_access: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * Seed the one-time "Agents can act without asking" approvals notice as
 * already dismissed. Full Access is the product default (CAN-3055), so a fresh
 * profile shows that notice in every composer's banner stack; left in place it
 * pads the notice column in specs that assert the stack's contents. Only fills
 * a missing field, so a value the app wrote (a dismissal, or the upgrade
 * migration re-arming the notice) survives a relaunch. Specs that assert the
 * notice itself opt out with `freshApprovalsUpgradeNotice: true`. Only patches
 * an existing preferences file, so `freshOnboarding: true` launches (which
 * write none) still show the notice, as a brand-new install would.
 */
function seedDismissedApprovalsUpgradeNotice(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  if (!existsSync(preferencesPath)) return;
  let persisted;
  try {
    persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  } catch {
    // Recovery specs intentionally launch with invalid preferences.
    return;
  }
  if (!persisted || typeof persisted !== 'object') return;
  const preferences =
    persisted.preferences && typeof persisted.preferences === 'object'
      ? persisted.preferences
      : {};
  if (preferences.approvalsUpgradeNoticeDismissed !== undefined) return;
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        ...persisted,
        preferences: { ...preferences, approvalsUpgradeNoticeDismissed: true },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Seed every one-time onboarding tip (CAN-4904) as dismissed. A fresh profile
 * shows one on Workflows and above every worktree chat composer, which would
 * shift the layouts and banner stacks other specs measure. Like the approvals
 * notice above, it only fills a missing field and only patches an existing
 * preferences file. Specs about the tips opt out with
 * `freshOnboardingTips: true`.
 */
function seedDismissedOnboardingTips(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  if (!existsSync(preferencesPath)) return;
  let persisted;
  try {
    persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  } catch {
    // Recovery specs intentionally launch with invalid preferences.
    return;
  }
  if (!persisted || typeof persisted !== 'object') return;
  const preferences =
    persisted.preferences && typeof persisted.preferences === 'object'
      ? persisted.preferences
      : {};
  if (preferences.onboardingTipsDismissed !== undefined) return;
  const at = '2026-01-01T00:00:00.000Z';
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        ...persisted,
        preferences: {
          ...preferences,
          onboardingTipsDismissed: {
            workflows: at,
            'worktree-chat': at,
            'workflows-schedule': at,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Local-only switch for running existing specs with Settings → Experiments →
 * "Open windows faster" on: `CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME=1` seeds
 * `rendererCodeCacheSchemeEnabled: true` before launch, so the app loads both
 * windows from the `app-renderer://bundle/` scheme through the same code path
 * a user's setting takes. CI never sets it; anything but `1` changes nothing.
 */
export const RENDERER_CODE_CACHE_SCHEME_ENV =
  'CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME';

/** The renderer scheme's main window page (`@canopy/desktop-shared/lib/renderer-scheme`). */
const RENDERER_SCHEME_MAIN_PAGE_URL = 'app-renderer://bundle/index.html';

function rendererCodeCacheSchemeRequested(env) {
  return env[RENDERER_CODE_CACHE_SCHEME_ENV] === '1';
}

export function seedRendererCodeCacheScheme(userDataDir, env = process.env) {
  if (!rendererCodeCacheSchemeRequested(env)) return;
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  let persisted = {};
  if (existsSync(preferencesPath)) {
    try {
      persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    } catch {
      return;
    }
  }
  if (!persisted || typeof persisted !== 'object') return;
  const preferences =
    persisted.preferences && typeof persisted.preferences === 'object'
      ? persisted.preferences
      : {};
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        ...persisted,
        version: persisted.version ?? 1,
        preferences: { ...preferences, rendererCodeCacheSchemeEnabled: true },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * With the switch on, Electron gets `--user-data-dir` inside the run's
 * profile. Chromium's origin-keyed storage, its code cache and the renderer
 * origin record live in `sessionData`, which E2E's later `userData` redirect
 * does not move; without this, an on run would migrate a profile that off
 * runs also use. Off, the args are unchanged, and `platformElectronArgs`
 * chooses the profile: the run's directory on macOS and Windows, its
 * `electron-profile` on Linux. A caller's own `--user-data-dir` wins.
 */
function assertLinuxUiIdentity(options) {
  const uid = (options.uid ?? (() => process.getuid?.()))();
  const euid = (options.euid ?? (() => process.geteuid?.()))();
  if (
    !Number.isInteger(uid) ||
    uid <= 0 ||
    !Number.isInteger(euid) ||
    euid <= 0
  )
    throw new Error(
      'Linux UI automation requires a non-root user and effective user.',
    );
}

export function platformElectronArgs(
  userDataDir,
  electronArgs = [],
  options = {},
) {
  if ((options.platform ?? process.platform) !== 'linux') {
    // Electron 45 writes a Session's cookies only inside Chromium's startup
    // profile, and E2E moves `userData` to the run's directory only after
    // ready. Starting Chromium there keeps browser logins across restarts.
    // A caller's own `--user-data-dir` wins.
    const ownProfile = electronArgs.some((arg) =>
      arg.startsWith('--user-data-dir='),
    );
    return [
      '--use-mock-keychain',
      ...(ownProfile ? [] : [`--user-data-dir=${userDataDir}`]),
      ...electronArgs,
    ];
  }
  assertLinuxUiIdentity(options);
  const values = new Map();
  const rest = [];
  for (const arg of electronArgs) {
    const [name, ...parts] = arg.split('=');
    if (
      [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu-sandbox',
        '--disable-seccomp-filter-sandbox',
        '--disable-namespace-sandbox',
        '--no-zygote',
        '--single-process',
        '--use-mock-keychain',
        '--display',
        '--ozone-platform-hint',
      ].includes(name)
    )
      throw new Error(
        `Linux UI automation rejects unsafe sandbox/display argument ${name}.`,
      );
    if (
      !['--user-data-dir', '--ozone-platform', '--password-store'].includes(
        name,
      )
    ) {
      rest.push(arg);
      continue;
    }
    if (values.has(name))
      throw new Error(`Linux UI automation rejects duplicate ${name}.`);
    const value = parts.join('=');
    if (!value) throw new Error(`Linux UI automation requires ${name}=value.`);
    values.set(name, value);
  }
  const profile =
    values.get('--user-data-dir') ?? path.join(userDataDir, 'electron-profile');
  const relativeProfile = path.relative(
    resolveCanonicalDataPath(userDataDir),
    resolveCanonicalDataPath(profile),
  );
  if (
    !path.isAbsolute(profile) ||
    !relativeProfile ||
    relativeProfile === '..' ||
    relativeProfile.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeProfile)
  )
    throw new Error(
      'Linux Chromium profile must be an isolated child of userDataDir.',
    );
  assertIsolatedCanopyDataDir(
    'Linux Chromium profile',
    profile,
    normalizedLaunchHome(options.env ?? {}),
  );
  if (
    values.has('--ozone-platform') &&
    values.get('--ozone-platform') !== 'x11'
  )
    throw new Error('Linux UI automation requires X11.');
  if (
    values.has('--password-store') &&
    values.get('--password-store') !== 'gnome-libsecret'
  )
    throw new Error('Linux UI automation requires gnome-libsecret.');
  return [
    `--user-data-dir=${profile}`,
    '--ozone-platform=x11',
    '--password-store=gnome-libsecret',
    ...rest,
  ];
}

export function rendererCodeCacheSchemeElectronArgs(
  userDataDir,
  electronArgs = [],
  env = process.env,
) {
  if (
    !rendererCodeCacheSchemeRequested(env) ||
    electronArgs.some((arg) => arg.startsWith('--user-data-dir='))
  ) {
    return electronArgs;
  }
  return [
    `--user-data-dir=${path.join(userDataDir, 'electron-profile')}`,
    ...electronArgs,
  ];
}

/**
 * The main window's packaged page: `file://` as today, or the renderer
 * scheme when the launch seeded the experiment. A launch that falls back to
 * `file://` then fails to find its window, which is the point.
 */
export function packagedMainWindowRendererUrl(
  mainEntryPath,
  env = process.env,
) {
  return rendererCodeCacheSchemeRequested(env)
    ? RENDERER_SCHEME_MAIN_PAGE_URL
    : pathToFileURL(
        // Electron resolves the main module's symlinks before computing __dirname.
        path.resolve(
          path.dirname(realpathSync(mainEntryPath)),
          '../renderer/index.html',
        ),
      ).href;
}

export function seedCaptureColorMode(userDataDir, env = process.env) {
  const colorMode = env.CANOPY_E2E_CAPTURE_COLOR_MODE;
  if (colorMode !== 'light' && colorMode !== 'dark') return;
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  let persisted = {};
  if (existsSync(preferencesPath)) {
    try {
      persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    } catch {
      return;
    }
  }
  if (!persisted || typeof persisted !== 'object') return;
  const preferences =
    persisted.preferences && typeof persisted.preferences === 'object'
      ? persisted.preferences
      : {};
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        ...persisted,
        version: persisted.version ?? 1,
        preferences: { ...preferences, colorMode },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Launch the unpackaged Electron app for a spec.
 *
 * `options.rootPath` overrides the repository root used for both the main
 * bundle and the Electron process working directory (defaults to `repoRoot`).
 * A harness running against another checkout can therefore keep entrypoint and
 * process-relative resource resolution isolated to the same root. Production
 * launches resolve that root's existing `out/` bundle.
 * `options.showWindow: true` is reserved for a user-requested headed run;
 * ordinary launches force the BrowserWindow to remain hidden.
 */
export function launchCanopy(options = {}) {
  return measureE2eHarnessOperation(
    'launch-canopy',
    launchMeasurementDetails(options),
    () => launchCanopyUnmeasured(options),
  );
}

export function resolveLaunchRuntimeRoot(rootPath) {
  return path.resolve(rootPath ?? repoRoot);
}

/**
 * Launch Canopy and wait for its first window to reach the interactive shell.
 * Lower-level startup, onboarding, and crash tests should keep using
 * `launchCanopy`; ordinary UI flows can use this helper without duplicating
 * first-window and driver readiness setup.
 *
 * A caller-provided `userDataDir` remains caller-owned if readiness fails.
 * Helper-created data roots are removed by `closeCanopy` after the supervised
 * process tree is reaped.
 */

/**
 * Only main learns why a renderer died. Relay it to the test's stderr so a
 * `page.reload: Page crashed` failure names its cause in the job log.
 */
async function relayRendererCrashes(electronApp) {
  electronApp.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(RENDERER_GONE_MARKER))
      process.stderr.write(`${text}\n`);
  });
  await electronApp.evaluate(({ app }, marker) => {
    app.on('render-process-gone', (_event, contents, details) => {
      console.error(
        `${marker} ${JSON.stringify({ url: contents.getURL(), ...details })}`,
      );
    });
  }, RENDERER_GONE_MARKER);
}

export async function launchCanopyApp(
  options = {},
  {
    launch = launchCanopy,
    AppDriver = CanopyAppDriver,
    close = closeCanopy,
  } = {},
) {
  const { waitForShellOptions, ...launchOptions } = options;
  const launched = await launch(launchOptions);
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new AppDriver(window);
    await app.waitForShell(waitForShellOptions);
    return { ...launched, window, app };
  } catch (error) {
    await close(launched.electronApp, launched.userDataDir, {
      keepUserData: options.userDataDir !== undefined,
    }).catch(() => undefined);
    throw error;
  }
}

async function launchCanopyUnmeasured(options) {
  if ((options.platform ?? process.platform) === 'linux') {
    assertLinuxUiIdentity(options);
    if (options.userDataDir !== undefined)
      platformElectronArgs(
        options.userDataDir,
        options.electronArgs ?? [],
        options,
      );
  }
  // Caller-owned paths must be rejected even when another launch prerequisite
  // (such as a built E2E bundle) is absent. Besides keeping this safety guard
  // independent from local build residue, it guarantees no validation path
  // can inspect or prepare the live namespace first.
  if (options.userDataDir !== undefined) {
    assertLaunchDataRootsBeforeMutation(options.userDataDir, options.env);
  }
  if (
    options.productionWindowMode !== undefined &&
    (options.productionWindowMode !== 'headless' ||
      options.buildKind !== 'production')
  )
    throw new Error('productionWindowMode requires production headless');
  const runtimeRoot = resolveLaunchRuntimeRoot(options.rootPath);
  const mainEntryPath =
    options.buildKind === 'production'
      ? resolveProductionMainEntryPath(runtimeRoot)
      : resolveE2eMainEntryPath(runtimeRoot);

  const viewportSize = resolveViewportSizeOption(options.viewportSize);
  const launchObserver = createLaunchObserver(options.boundaryRecord);
  const showWindow =
    options.showWindow === true ||
    (options.showWindow === undefined &&
      process.env.CANOPY_E2E_RUN_HEADED === '1');
  const reuseDir = options.userDataDir !== undefined;
  const userDataDir =
    options.userDataDir ??
    mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  // Reject unsafe caller-owned and override roots before any onboarding,
  // provider-state, demo-workspace, or ordering seed can touch them.
  if (options.userDataDir === undefined) {
    assertLaunchDataRootsBeforeMutation(userDataDir, options.env);
  }

  let demoSeed = null;
  let electronApp;
  let supervisedTreePid;
  let sidecar;
  const supervisedRunNonce = randomUUID();
  const supervisedPidFile = path.join(
    userDataDir,
    '.e2e-supervised-electron.pid',
  );
  const supervisedGroupsFile = path.join(
    userDataDir,
    '.e2e-supervised-groups.ndjson',
  );
  // The record closeCanopy({ retainDaemon }) writes before it quits the app.
  const supervisedRetainFile =
    options.retainDaemon === true && process.platform !== 'win32'
      ? path.join(userDataDir, '.e2e-supervised-retain.json')
      : undefined;
  try {
    if (supervisedRetainFile) rmSync(supervisedRetainFile, { force: true });
    const electronArgs = platformElectronArgs(
      userDataDir,
      rendererCodeCacheSchemeElectronArgs(
        userDataDir,
        options.electronArgs ?? [],
        { ...process.env, ...options.env },
      ),
      options,
    );
    // By default, suppress the onboarding wizard so existing UI tests don't
    // have to dismiss it. Tests that want to exercise the onboarding flow
    // itself can opt out with `freshOnboarding: true`. When the caller is
    // reusing an existing user data dir (e.g. for a relaunch assertion) we
    // never overwrite their state.
    if (!options.freshOnboarding) {
      seedOnboardingCompleted(userDataDir);
    }
    if (!options.freshApprovalsUpgradeNotice) {
      seedDismissedApprovalsUpgradeNotice(userDataDir);
    }
    if (!options.freshOnboardingTips) {
      seedDismissedOnboardingTips(userDataDir);
    }
    seedCaptureColorMode(userDataDir, { ...process.env, ...options.env });
    seedRendererCodeCacheScheme(userDataDir, {
      ...process.env,
      ...options.env,
    });
    if (!options.preserveProviderState) {
      prepareIsolatedProviderState(userDataDir);
    }

    demoSeed = options.seedDemoWorkspaces
      ? await measureE2eHarnessOperation(
          'seed-demo-workspaces',
          launchMeasurementDetails(options),
          () =>
            seedDemoWorkspaces({
              userDataDir,
              set: options.demoWorkspaceSet,
              apps: options.demoWorkspaceApps,
              checkRuntimes: options.demoWorkspaceCheckRuntimes ?? false,
              createWorktrees: options.demoWorkspaceCreateWorktrees ?? true,
            }),
        )
      : null;

    const electronEnv = buildElectronEnv(
      userDataDir,
      {
        ...options.env,
        ...buildE2eLaunchMarkerEnv(options.buildKind, showWindow),
        CANOPY_E2E_OWNER_PID: String(process.pid),
        CANOPY_E2E_SUPERVISED_EXECUTABLE: electronPath,
        [SUPERVISED_PID_FILE_ENV]: supervisedPidFile,
        [SUPERVISED_GROUPS_FILE_ENV]: supervisedGroupsFile,
        [SUPERVISED_RUN_NONCE_ENV]: supervisedRunNonce,
        ...(supervisedRetainFile && {
          [SUPERVISED_RETAIN_FILE_ENV]: supervisedRetainFile,
        }),
      },
      { preserveProviderState: options.preserveProviderState === true },
    );
    if (options.productionWindowMode === 'headless') {
      const require = createRequire(import.meta.url);
      const packagePath = require.resolve('playwright-core/package.json');
      const launcher = headlessBootstrap.buildExpectedArgv({
        productMainEntryPath: mainEntryPath,
        executablePath: electronPath,
        electronArgs,
        launcherSourcePath: path.join(
          path.dirname(packagePath),
          'lib/coreBundle.js',
        ),
        launcherVersion: JSON.parse(readFileSync(packagePath, 'utf8')).version,
      });
      sidecar = headlessBootstrap.stageBootstrap(mainEntryPath, {
        archivePath: options.productionAdapterArchivePath,
        ...launcher,
      });
    }
    launchObserver?.('electron-launch', { outcome: 'entered' });
    try {
      electronApp = await measureE2eHarnessOperation(
        'electron-process-start',
        launchMeasurementDetails(options),
        () =>
          electron.launch({
            executablePath: supervisorEntryPath,
            cwd: runtimeRoot,
            // Mock the macOS keychain so ad-hoc-signed test builds don't trigger
            // the system "Keychain Not Found" dialog on every launch.
            args: [
              ...electronArgs,
              ...(sidecar?.contractArgs ?? []),
              sidecar?.launchEntryPath ?? mainEntryPath,
              ...(options.applicationArgs ?? []),
            ],
            env: electronEnv,
            // Playwright adds --no-sandbox to Linux Electron launches without this.
            chromiumSandbox: true,
            ...(options.recordVideoDir
              ? { recordVideo: { dir: options.recordVideoDir } }
              : {}),
          }),
      );
      if (process.platform === 'win32' && !sidecar)
        registerElectronTerminalObservation(electronApp);
      launchObserver?.('electron-launch', { outcome: 'fulfilled' });
    } catch (error) {
      launchObserver?.('electron-launch', { outcome: 'rejected' });
      throw error;
    }
    if (sidecar) productionSidecars.set(electronApp, sidecar);
    mainWindowRendererUrls.set(
      electronApp,
      electronEnv.ELECTRON_RENDERER_URL ||
        packagedMainWindowRendererUrl(mainEntryPath, electronEnv),
    );
    supervisedTreePid = await readSupervisedTreePid(supervisedPidFile);
    registerSupervisedProcessTree(electronApp, supervisedTreePid, {
      trackedGroupsFile: supervisedGroupsFile,
      runNonce: supervisedRunNonce,
      retainFile: supervisedRetainFile,
    });
    trackDaemonDryRunLaunch(electronApp, userDataDir, {
      testInfo: options.testInfo ?? currentPlaywrightTestInfo(),
    });
    // Diagnostics only: a failed relay must never fail the launch.
    await relayRendererCrashes(electronApp).catch(() => undefined);
    if (sidecar)
      sidecar.evidence = { ...sidecar.identity, pid: supervisedTreePid };

    if (viewportSize !== null) {
      const mainWindow = await getMainWindow(electronApp, { launchObserver });
      launchObserver?.('viewport-set', { outcome: 'entered' });
      try {
        await mainWindow.setViewportSize(viewportSize);
        launchObserver?.('viewport-set', { outcome: 'fulfilled' });
      } catch (error) {
        launchObserver?.('viewport-set', { outcome: 'rejected' });
        throw error;
      }
      launchObserver?.('resize-dispatch', { outcome: 'entered' });
      try {
        await mainWindow.evaluate(() => {
          window.dispatchEvent(new Event('resize'));
        });
        launchObserver?.('resize-dispatch', { outcome: 'fulfilled' });
      } catch (error) {
        launchObserver?.('resize-dispatch', { outcome: 'rejected' });
        throw error;
      }
    }
  } catch (error) {
    if (sidecar) {
      await closeWithRetainedFailures(
        async () => {
          throw error;
        },
        () =>
          closeWithRetainedFailures(
            async () => {
              if (electronApp) await electronApp.close();
            },
            async () => {
              assert(
                supervisedTreePid !== undefined,
                'Headless launch failed before process identity; owned sidecar retained',
              );
              await reapSupervisedProcessTree(supervisedTreePid);
              assert(
                !processGroupExists(supervisedTreePid),
                'Headless process group remains; owned sidecar retained',
              );
              try {
                await finalizeProductionSidecar(sidecar, supervisedTreePid);
              } finally {
                if (sidecar.archiveCompleted)
                  productionSidecars.delete(electronApp);
              }
              if (!reuseDir) {
                await removeTestDataDir(userDataDir);
                await removeTestDataDir(`${userDataDir}-secure`);
              }
            },
          ),
      );
    }
    await cleanupFailedLaunch(electronApp, userDataDir, error, { reuseDir });
  }

  return {
    electronApp,
    userDataDir,
    demoSeed,
    productMainEntryPath: mainEntryPath,
    launchEntryPath: sidecar?.launchEntryPath ?? mainEntryPath,
    headlessAdapter: sidecar?.evidence,
    supervisedTreePid,
    killAbruptly: endingWithDaemonDryRunEvidence(
      electronApp,
      createAbruptTreeKiller(supervisedTreePid),
    ),
  };
}

/**
 * Close a non-headless launch that failed, remove its data roots, and rethrow.
 * On Windows the roots are removed only after the observed launcher's `close`,
 * as in `closeCanopy`; if it does not close in time they are kept and the
 * failure names them.
 */
export async function cleanupFailedLaunch(
  electronApp,
  userDataDir,
  launchError,
  {
    reuseDir = false,
    removeDataDir = removeTestDataDir,
    platform = process.platform,
    windowsLauncherCloseTimeoutMs = DEFAULT_WINDOWS_LAUNCHER_CLOSE_TIMEOUT_MS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = {},
) {
  const closeStartedAt = now();
  if (electronApp) await electronApp.close().catch(() => undefined);
  if (reuseDir) throw launchError;
  const terminalObservation =
    platform === 'win32' && electronApp
      ? electronTerminalObservations.get(electronApp)
      : undefined;
  if (terminalObservation) {
    const waitStartedAt = now();
    const launcherClosed = await waitForElectronTerminalResult(
      terminalObservation,
      { wait, now, timeoutMs: windowsLauncherCloseTimeoutMs },
    );
    if (!launcherClosed) {
      // Report the result seen at the deadline, even if the launcher closes
      // while the failure is built.
      const observedAtDeadline = {
        ...terminalObservationSnapshot(terminalObservation),
        launcherOutput: terminalObservation.launcherOutput,
      };
      const completedAt = now();
      const sinceClose = completedAt - closeStartedAt;
      const retained = new ElectronTerminalResultError(observedAtDeadline, {
        closeSteps: [
          `launcher-close-wait-complete@${sinceClose}ms(launcherClosed=false,waitedMs=${completedAt - waitStartedAt})`,
          `user-data-retained@${sinceClose}ms(reason=launcher-open,userDataDir=${userDataDir})`,
        ],
      });
      throw new AggregateError(
        [launchError, retained],
        `Electron launch failed and its data roots were kept: ${launchError?.message ?? String(launchError)}; ${retained.message}`,
      );
    }
  }
  await removeDataDir(userDataDir);
  await removeDataDir(`${userDataDir}-secure`);
  throw launchError;
}

async function finalizeProductionSidecar(sidecar, pid) {
  const failures = [];
  sidecar.evidence ??= { ...sidecar.identity, pid };
  try {
    sidecar.evidence.terminalEvidence = headlessBootstrap.readTerminalLifecycle(
      sidecar.identity,
      pid,
    );
    sidecar.evidence.terminalEvidence.processGroupGone = true;
    assertProductionHeadlessTerminal(
      sidecar.evidence.terminalEvidence,
      sidecar.evidence,
    );
  } catch (error) {
    sidecar.evidence.terminalFailure = error.stack ?? String(error);
    failures.push(error);
  }
  try {
    sidecar.cleanup();
    sidecar.archiveCompleted = true;
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Terminal lifecycle and sidecar archive failed: ${failures.map(String).join('; ')}`,
    );
}

/** Preserve both failures for the production adapter's mandatory teardown. */
export async function closeWithRetainedFailures(close, cleanup, validate) {
  const failures = [];
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (validate) {
    try {
      await validate();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Electron close and headless cleanup failed: ${failures.map((error) => error.message ?? String(error)).join('; ')}`,
    );
}

const DAEMON_DRY_RUN_EVIDENCE_TIMEOUT_MS = 2_000;
// GA3's (CAN-5541) in-process answers to daemon-selected reads, wherever they
// land in the snapshot: `daemon.fallback.<reason>`, and `daemon.bypassed` once
// a latched failure skips the daemon, which a connection event can latch
// without any read falling back first.
const DAEMON_FALLBACK_COUNTER =
  /(?:^|\.)daemon\.(?:fallback(?:\.|$)|bypassed$)/;

/**
 * Every nonzero numeric `daemon.fallback.*` or `daemon.bypassed` leaf, keyed
 * by its dotted path.
 */
export function daemonFallbackCounters(snapshot) {
  const found = {};
  const visit = (value, at) => {
    if (typeof value === 'number') {
      if (value !== 0 && DAEMON_FALLBACK_COUNTER.test(at)) found[at] = value;
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        visit(child, at ? `${at}.${key}` : key);
    }
  };
  visit(snapshot, '');
  return found;
}

// packages/core-platform endpoints: the daemon binds beside this probe name.
const DAEMON_SOCKET_LIMIT = { darwin: 103, linux: 107 };

/**
 * The data root's daemon socket probe length against the platform limit. The
 * host binds under the canonical data root, so a resolvable root is resolved.
 */
export function daemonSocketBudget(userDataDir, platform = process.platform) {
  const limit = DAEMON_SOCKET_LIMIT[platform];
  if (typeof userDataDir !== 'string' || limit === undefined) return null;
  let root = userDataDir;
  try {
    root = realpathSync(userDataDir);
  } catch {
    // Already removed or never created: the lexical root is the best estimate.
  }
  const bytes = Buffer.byteLength(path.join(root, 'runtime', '.000000000000'));
  return { bytes, limit, fits: bytes <= limit };
}

const FILES_EVIDENCE_SOURCE = 'desktop-main-files-singleton-v1';
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Why a snapshot is not `snapshotDesktopFilesEvidence`'s, or null. Before the
 * first Files read its route is null and its counters are zeroed, which is
 * valid: a launch need not read Files.
 */
function filesEvidenceContractError(snapshot) {
  const problem = (() => {
    if (!isRecord(snapshot)) return 'no snapshot (missing evidence hook?)';
    if (snapshot.source !== FILES_EVIDENCE_SOURCE)
      return `source ${String(snapshot.source)}`;
    if (!('route' in snapshot)) return 'no route';
    const { route } = snapshot;
    if (route !== null) {
      if (!isRecord(route) || typeof route.enabled !== 'boolean')
        return 'route.enabled is not a boolean';
      if (
        !isRecord(route.cursor) ||
        !Number.isSafeInteger(route.cursor.sequence) ||
        route.cursor.sequence < 0
      )
        return 'route.cursor.sequence is not a count';
    }
    if (!isRecord(snapshot.counters) || !isRecord(snapshot.counters.route))
      return 'counters.route is not an object';
    return null;
  })();
  return (
    problem &&
    `Files evidence snapshot is not ${FILES_EVIDENCE_SOURCE}: ${problem}`
  );
}

/** The dry-run line for one launch, from the Files counters. */
function summarizeDaemonDryRunLaunch({
  snapshot,
  descriptorPresent,
  evidenceError = null,
  evidenceInvalid = false,
}) {
  const routeCounters = snapshot?.counters?.route ?? {};
  const total = (suffix) =>
    Object.entries(routeCounters)
      .filter(([key]) => key.endsWith(suffix))
      .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
  return {
    descriptorPresent,
    evidenceError,
    evidenceInvalid,
    routeEnabled: snapshot?.route?.enabled ?? null,
    // Reads the route sent to the daemon, which need its socket.
    daemonRouted: total('.daemon'),
    daemonServed: total('.daemon.served'),
    direct: total('.direct'),
    daemonFailed: Object.fromEntries(
      Object.entries(routeCounters).filter(
        ([key, value]) => key.includes('.daemon.failed.') && value !== 0,
      ),
    ),
    fallbacks: daemonFallbackCounters(snapshot),
    // Read without a cursor, the route journal lists no entries, only its total.
    routeEventsRecorded: snapshot?.route?.cursor?.sequence ?? 0,
    counters: snapshot?.counters ?? null,
  };
}

export const DAEMON_DRY_RUN_DIRECTORY = path.join(
  repoRoot,
  '.playwright',
  'daemon-dry-run',
);
// Set by the lane's global setup, so its teardown checks only that run's launches.
export const DAEMON_DRY_RUN_ID_ENV = 'CANOPY_E2E_DAEMON_DRY_RUN_ID';

function dryRunTestIdentity(testInfo) {
  return testInfo
    ? {
        file: path.relative(repoRoot, testInfo.file ?? ''),
        title: testInfo.titlePath?.slice(1).join(' > ') ?? testInfo.title,
        project: testInfo.project?.name ?? null,
        retry: testInfo.retry ?? 0,
      }
    : null;
}

// One file per runner process, so parallel workers never interleave lines.
function appendDryRunLine(directory, prefix, record) {
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    path.join(directory, `${prefix}-${process.pid}.ndjson`),
    `${JSON.stringify(record)}\n`,
  );
}

const daemonDryRunLaunches = new WeakMap();
const daemonDryRunEvidence = new WeakMap();

/**
 * Dry run only: registers the launch for the lane teardown's count and makes
 * every close of it, a spec's direct `electronApp.close()` included, record
 * its evidence first.
 */
export function trackDaemonDryRunLaunch(
  electronApp,
  userDataDir,
  {
    directory = DAEMON_DRY_RUN_DIRECTORY,
    env = process.env,
    testInfo = currentPlaywrightTestInfo(),
  } = {},
) {
  if (!isDaemonFilesDryRun(env)) return null;
  const launch = {
    launchId: randomUUID(),
    runId: env[DAEMON_DRY_RUN_ID_ENV] ?? null,
    userDataDir,
    directory,
  };
  appendDryRunLine(directory, 'registered', {
    at: new Date().toISOString(),
    runId: launch.runId,
    launchId: launch.launchId,
    lane: env.CANOPY_UI_TIMINGS_LANE ?? null,
    test: dryRunTestIdentity(testInfo),
  });
  daemonDryRunLaunches.set(electronApp, launch);
  const close = electronApp.close;
  electronApp.close = (...args) =>
    closeWithDaemonDryRunEvidence(electronApp, () =>
      close.apply(electronApp, args),
    );
  return launch;
}

/**
 * Appends one JSON line per launch to the dry-run directory from Electron
 * main's Files evidence and the data root's daemon descriptor, read before
 * close. Unreadable evidence is recorded, never thrown.
 */
async function recordDaemonDryRunLaunch(
  electronApp,
  userDataDir,
  launch,
  {
    directory = launch?.directory ?? DAEMON_DRY_RUN_DIRECTORY,
    timeoutMs = DAEMON_DRY_RUN_EVIDENCE_TIMEOUT_MS,
    env = process.env,
    testInfo = currentPlaywrightTestInfo(),
    platform = process.platform,
  } = {},
) {
  let snapshot = null;
  let evidenceError = null;
  let timer;
  try {
    snapshot = await Promise.race([
      electronApp.evaluate(
        () => globalThis.__CANOPY_FILES_MAIN_EVIDENCE__?.snapshot() ?? null,
      ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Files evidence read timed out')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // Never empty: an empty reason would read as evidence that was read.
    evidenceError =
      String(error?.message ?? error ?? '') || 'Files evidence read failed';
  } finally {
    clearTimeout(timer);
  }
  const contractError =
    evidenceError === null ? filesEvidenceContractError(snapshot) : null;
  const record = {
    at: new Date().toISOString(),
    runId: launch?.runId ?? env[DAEMON_DRY_RUN_ID_ENV] ?? null,
    launchId: launch?.launchId ?? null,
    lane: env.CANOPY_UI_TIMINGS_LANE ?? null,
    test: dryRunTestIdentity(testInfo),
    ...summarizeDaemonDryRunLaunch({
      snapshot,
      descriptorPresent:
        typeof userDataDir === 'string' &&
        existsSync(path.join(userDataDir, 'runtime', 'core.json')),
      evidenceError: evidenceError ?? contractError,
      evidenceInvalid: contractError !== null,
    }),
    // Spec-made data roots can be too deep for the daemon socket, which the
    // lane's preflight of the launcher's own roots cannot see.
    socket: daemonSocketBudget(userDataDir, platform),
  };
  appendDryRunLine(directory, 'launches', record);
  return record;
}

/**
 * Reads a launch's evidence once, however many closes, kills or captures
 * reach it. Only the first close (`reports`) reports its failures, so
 * `closeCanopy` and the wrapped `electronApp.close()` it calls never report
 * them twice, and a kill or capture leaves them to the close that follows.
 */
async function recordDaemonDryRunOnce(
  electronApp,
  userDataDir,
  options,
  { report = true } = {},
) {
  let entry = daemonDryRunEvidence.get(electronApp);
  if (!entry) {
    const launch = daemonDryRunLaunches.get(electronApp);
    entry = {
      reported: false,
      settled: recordDaemonDryRunLaunch(
        electronApp,
        userDataDir ?? launch?.userDataDir,
        launch,
        options,
      ).then(
        (record) => ({ record, error: null }),
        (error) => ({ record: null, error }),
      ),
    };
    // A failed launch can reach closeCanopy without an app to key on.
    if (electronApp && typeof electronApp === 'object')
      daemonDryRunEvidence.set(electronApp, entry);
  }
  const outcome = await entry.settled;
  const reports = report && !entry.reported;
  if (reports) entry.reported = true;
  return { ...outcome, reports };
}

/** The failures a close must report for its evidence: [before, after] close. */
function daemonDryRunFailures(evidence) {
  if (!evidence?.reports) return [[], []];
  const fallbacks = evidence.record?.fallbacks ?? {};
  return [
    evidence.error ? [evidence.error] : [],
    Object.keys(fallbacks).length > 0
      ? [
          new Error(
            `Files dry run: the daemon route fell back ${JSON.stringify(fallbacks)}`,
          ),
        ]
      : [],
  ];
}

function throwCloseFailures(failures) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Electron close and its Files dry run failed: ${failures.map((error) => error?.message ?? String(error)).join('; ')}`,
    );
}

async function closeWithDaemonDryRunEvidence(electronApp, close) {
  const [before, after] = daemonDryRunFailures(
    await recordDaemonDryRunOnce(electronApp, undefined, {}),
  );
  const failures = [...before];
  try {
    await close();
  } catch (error) {
    failures.push(error);
  }
  throwCloseFailures([...failures, ...after]);
}

/**
 * Wraps a way to end a launch other than a close, such as the harness's
 * `killAbruptly`, so a dry-run launch's evidence is read while the app is
 * still alive. It never throws for the dry run: its callers tear down right
 * after it, and that close reports a fallback. Outside the dry run it is
 * `end` unchanged.
 */
export function endingWithDaemonDryRunEvidence(electronApp, end) {
  return (...args) =>
    daemonDryRunLaunches.has(electronApp)
      ? captureDaemonDryRunEvidence(electronApp).then(() => end(...args))
      : end(...args);
}

/**
 * For a spec that ends a launch itself (`process.kill(mainPid, 'SIGKILL')`,
 * `app.quit()`, `app.exit()`): reads its dry-run evidence while the app is
 * alive, since the lane teardown fails a launch whose evidence could only be
 * read after it exited. Call it right before the end: the first read is the
 * launch's only one. Never throws, so it is safe in cleanup paths; the close
 * that follows reports a fallback. Resolves null outside the dry run.
 */
export async function captureDaemonDryRunEvidence(electronApp) {
  if (!daemonDryRunLaunches.has(electronApp)) return null;
  const { record } = await recordDaemonDryRunOnce(
    electronApp,
    undefined,
    {},
    { report: false },
  );
  return record;
}

export async function closeCanopy(electronApp, userDataDir, options = {}) {
  const dryRunOptions = options.daemonDryRun ?? {};
  const evidence =
    daemonDryRunLaunches.has(electronApp) ||
    isDaemonFilesDryRun(dryRunOptions.env ?? process.env)
      ? await recordDaemonDryRunOnce(electronApp, userDataDir, dryRunOptions)
      : null;
  const [before, after] = daemonDryRunFailures(evidence);
  // Teardown runs even when the evidence could not be written.
  const failures = [...before];
  try {
    await closeCanopyUnrecorded(electronApp, userDataDir, options);
  } catch (error) {
    failures.push(error);
  }
  throwCloseFailures([...failures, ...after]);
}

async function closeCanopyUnrecorded(electronApp, userDataDir, options) {
  const {
    retainDaemon = false,
    keepUserData = false,
    reapTree = reapSupervisedProcessTree,
    removeDataDir = removeTestDataDir,
    gracefulCloseTimeoutMs = DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
    windowsLauncherCloseTimeoutMs = DEFAULT_WINDOWS_LAUNCHER_CLOSE_TIMEOUT_MS,
    forcedCloseTimeoutMs = 2_000,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
    platform = process.platform,
    treeExists = processGroupExists,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;
  return measureE2eHarnessOperation(
    'close-canopy',
    {
      configuration: { keepUserData, gracefulCloseTimeoutMs },
      identity: { testInfo: currentPlaywrightTestInfo() },
    },
    async () => {
      const sidecar = productionSidecars.get(electronApp);
      const record = options.boundaryRecord;
      // The selected fixture supplies its observer; the common launch harness
      // stays independent of profile-test helpers and their filesystem imports.
      const observed = (stage, action) =>
        record?.observe ? record.observe(stage, action) : action();
      const supervisedTree = supervisedProcessTrees.get(electronApp);
      const supervisedTreePid = supervisedTree?.pid;
      // CAN-5862: keep the daemon (and its runs) running after the app
      // quits. The app still closes when retention can't be recorded; the
      // failure is reported after it.
      let retainError;
      if (retainDaemon) {
        try {
          if (!keepUserData)
            throw new Error(
              'retainDaemon needs keepUserData: the daemon uses the data root',
            );
          if (!supervisedTree?.retainFile || sidecar)
            throw new Error(
              'retainDaemon needs a POSIX launchCanopy({ retainDaemon: true })',
            );
          await retainDaemonAcrossClose(userDataDir, supervisedTree);
        } catch (error) {
          retainError = error;
        }
      }
      const terminalObservation = electronTerminalObservations.get(electronApp);
      // A Windows terminal failure reports these steps, so the next run shows
      // whether the harness forced Electron or its launcher.
      const closeSteps = [];
      const closeStartedAt = now();
      const trace = (event, detail = {}) => {
        if (platform === 'win32') {
          const fields = Object.entries(detail)
            .filter(([, value]) =>
              ['string', 'number', 'boolean'].includes(typeof value),
            )
            .map(([key, value]) => `${key}=${value}`);
          closeSteps.push(
            `${event}@${now() - closeStartedAt}ms${fields.length > 0 ? `(${fields.join(',')})` : ''}`,
          );
        }
        traceCloseCanopy(event, detail);
      };
      trace('start', {
        platform,
        supervisedTreePid,
        controllerPid: process.pid,
      });
      let playwrightCloseStatus;
      let expiredLauncherObservation;
      const close = async () => {
        if (platform === 'win32' && supervisedTreePid !== undefined) {
          // Playwright closes Electron by calling app.quit() and then waiting
          // for the process it launched. In this harness that process is the
          // Windows supervisor wrapper, so a blocked app quit leaves
          // Playwright waiting on the wrapper indefinitely. Forcing that
          // wrapper with taskkill can deliver a console-control termination to
          // the surrounding Windows test task. Ask the actual Electron process
          // to quit first, then use Electron's direct exit only if shutdown
          // hooks remain blocked. The supervisor observes the target exit and
          // reaps its owned descendants without signaling the test controller.
          await electronApp
            .evaluate(({ app }) => app.quit())
            .catch(() => undefined);
          trace('quit-requested');
          const gracefullyExited = await waitForSupervisedProcessExit(
            supervisedTreePid,
            {
              treeExists,
              wait,
              now,
              timeoutMs: gracefulCloseTimeoutMs,
            },
          );
          trace('quit-wait-complete', { gracefullyExited });
          if (!gracefullyExited) {
            await electronApp
              .evaluate(({ app }) => app.exit(0))
              .catch(() => undefined);
            trace('exit-requested');
            const forciblyExited = await waitForSupervisedProcessExit(
              supervisedTreePid,
              {
                treeExists,
                wait,
                now,
                timeoutMs: forcedCloseTimeoutMs,
              },
            );
            trace('exit-wait-complete', { forciblyExited });
          }
        }
        trace('playwright-close-start');
        playwrightCloseStatus = await observed('electronApp.close', () =>
          closeElectronAppWithDeadline(electronApp, {
            timeoutMs: gracefulCloseTimeoutMs,
            scheduleTimeout,
            cancelTimeout,
          }),
        );
        trace('playwright-close-complete', {
          status: playwrightCloseStatus,
        });
      };
      const cleanup = async () => {
        const shouldReap =
          supervisedTreePid !== undefined &&
          !(platform === 'win32' && playwrightCloseStatus === 'closed');
        if (shouldReap) {
          trace('reap-start');
          await observed('owned-tree-reap', () =>
            reapTree(supervisedTreePid, {
              trackedGroupsFile: supervisedTree.trackedGroupsFile,
              runNonce: supervisedTree.runNonce,
              retainFile: supervisedTree.retainFile,
            }),
          );
          trace('reap-complete');
        } else if (supervisedTreePid !== undefined) {
          // A successful Playwright close means Electron has exited; the
          // supervisor and its watchdog own any remaining descendants. Do not
          // act on the old numeric PID: Windows can immediately reuse it for
          // an unrelated process in this test task.
          trace('reap-skipped-retired-windows-pid');
        }
        if (platform === 'win32' && terminalObservation && !sidecar) {
          // The terminal check below and the data-root removal both need the
          // supervisor to have finished its cleanup.
          const startedAt = now();
          const launcherClosed = await waitForElectronTerminalResult(
            terminalObservation,
            { wait, now, timeoutMs: windowsLauncherCloseTimeoutMs },
          );
          // An open launcher means its supervisor may still be cleaning up
          // and using the data roots. Keep them for diagnosis and fail with
          // the result seen at the deadline, even if the launcher closes
          // before validation.
          if (!launcherClosed) {
            expiredLauncherObservation = {
              ...terminalObservationSnapshot(terminalObservation),
              launcherOutput: terminalObservation.launcherOutput,
            };
          }
          trace('launcher-close-wait-complete', {
            launcherClosed,
            waitedMs: now() - startedAt,
          });
          if (expiredLauncherObservation && !keepUserData)
            trace('user-data-retained', {
              reason: 'launcher-open',
              userDataDir,
            });
        }
        if (sidecar) {
          assert(
            supervisedTreePid !== undefined &&
              !processGroupExists(supervisedTreePid),
            'Headless process cleanup unverified; owned sidecar retained',
          );
          try {
            await finalizeProductionSidecar(sidecar, supervisedTreePid);
          } finally {
            if (sidecar.archiveCompleted)
              productionSidecars.delete(electronApp);
          }
        }
        if (!keepUserData && !expiredLauncherObservation) {
          await observed('user-data-remove', () => removeDataDir(userDataDir));
          await observed('secure-user-data-remove', () =>
            removeDataDir(`${userDataDir}-secure`),
          );
        }
        trace('complete');
      };
      if (sidecar) {
        await closeWithRetainedFailures(close, cleanup);
        if (retainError) throw retainError;
        return;
      }
      if (terminalObservation) {
        await closeWithRetainedFailures(close, cleanup, () => {
          if (expiredLauncherObservation)
            throw new ElectronTerminalResultError(expiredLauncherObservation, {
              closeSteps,
            });
          assertSuccessfulElectronTerminalResult(terminalObservation, {
            closeSteps,
          });
        });
        if (retainError) throw retainError;
        return;
      }
      // Preserve ordinary E2E teardown behavior; the retained-failure branch is
      // specific to the mandatory production sidecar ownership protocol.
      try {
        await close();
      } finally {
        await cleanup();
      }
      if (retainError) throw retainError;
    },
  );
}
