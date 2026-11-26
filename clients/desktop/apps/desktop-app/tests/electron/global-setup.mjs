// Every Electron lane needs a launchable daemon for always-on Files reads.
// Install (or verify) it at the product lookup paths and run the packaged
// health/stop smoke once per Playwright invocation. Dry-run mode adds evidence
// collection, not a routing switch (CAN-5561).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';
import { inspectDevCoreDaemon } from '../../../../scripts/lib/dev-core-daemon.mjs';
import {
  E2E_DAEMON_DIRECTORY,
  runCoreDaemonSmoke,
} from '../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import {
  stageIsolatedProductDaemonBridge,
  productDaemonTargets,
} from '../../../../scripts/lib/e2e-daemon-product-bridge.mjs';
import {
  DAEMON_DRY_RUN_DIRECTORY,
  DAEMON_DRY_RUN_ID_ENV,
  DAEMON_LANE_RUNTIME_ROOT_ENV,
} from './launchCanopy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
// `launchCanopy` data roots: mkdtemp(`<tmpdir>/canopy-electron-`), six
// random characters, whose daemon needs `runtime/.000000000000` beside its
// socket (packages/core-platform endpoints).
const LAUNCH_DATA_ROOT = 'canopy-electron-XXXXXX';
const SOCKET_PROBE = path.join('runtime', '.000000000000');
const SOCKET_PATH_LIMIT = { darwin: 103, linux: 107 };

/** Fails before any launch whose daemon could not bind its socket. */
export function preflightLaneSocketRoot({
  platform = process.platform,
  tmpdir = os.tmpdir(),
} = {}) {
  const limit = SOCKET_PATH_LIMIT[platform];
  // Windows daemons listen on named pipes, which have no path limit here.
  if (limit === undefined) return null;
  const root = realpathSync(tmpdir);
  const probe = path.join(root, LAUNCH_DATA_ROOT, SOCKET_PROBE);
  const bytes = Buffer.byteLength(probe);
  if (bytes > limit)
    throw new Error(
      `Files dry run: launch data roots under ${root} need ${bytes}-byte daemon socket paths, over the ${platform} limit of ${limit}. Point TMPDIR at a shorter directory, such as /tmp, as the macOS CI lanes do.`,
    );
  return { probe, bytes, limit };
}

// Follows links as the product's own lookup does. The identity and node-pty
// beside the executable are what the artifact also requires.
function isLaunchableLocalBuild({ executable, ownedChildNativePath }) {
  try {
    if (
      ![
        executable,
        `${executable}.identity.json`,
        path.join(path.dirname(executable), 'node-pty', 'package.json'),
        ownedChildNativePath,
      ].every((file) => statSync(file).isFile())
    )
      return false;
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a launchable local build would not exercise this checkout's code, from
 * the source records `pnpm run dev:core-daemon` writes (CAN-5540).
 */
function staleLocalBuild({
  inspect,
  runtimeRoot,
  env,
  platform,
  arch,
  targets,
}) {
  let statuses;
  try {
    statuses = inspect({ runtimeRoot, env, platform, arch });
  } catch (error) {
    return [
      `could not check the local build: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return [
    [statuses.daemon, targets.executable],
    [statuses.ownedChild, targets.ownedChildNativePath],
  ].flatMap(([status, target]) => {
    if (status.path !== target)
      return [`${status.label} was checked at ${status.path}, not ${target}`];
    if (status.state === 'fresh') return [];
    return [
      `${status.label} at ${status.path} ${status.reason ?? `is ${status.state}`}`,
    ];
  });
}

// Test harness, not an app subprocess: like the other Electron fixtures it
// runs the runner's `git` directly.
const gitHead = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

/**
 * Makes the product lookup paths hold a launchable daemon for every lane: the verified lane artifact when one is unpacked (shards), else a
 * local `pnpm run dev:core-daemon` output that matches its sources. A stale
 * local build is always refused; with neither, CI refuses the lane and a
 * local run only warns.
 *
 * The artifact goes only to an isolated lane root, never the checkout, so a
 * run killed before teardown cannot leave its E2E daemon where ordinary
 * source launches find it. W5 source CLI fixtures receive that layout
 * through host composition.
 */
export function prepareLaneDaemon({
  env = process.env,
  runtimeRoot = repoRoot,
  platform = process.platform,
  arch = process.arch,
  brand,
  tmpdir = os.tmpdir(),
  sourceSha = () => gitHead(runtimeRoot),
  install = stageIsolatedProductDaemonBridge,
  inspectLocalBuild = ({ runtimeRoot: root, ...rest }) =>
    inspectDevCoreDaemon({ root, ...rest }),
  smoke = runCoreDaemonSmoke,
  warn = (message) => console.warn(message),
  now = () => Date.now(),
} = {}) {
  brand ??= loadBrand(env.CANOPY_BRAND ?? 'canopy');
  const socket = preflightLaneSocketRoot({ platform, tmpdir });
  const targets = productDaemonTargets({ runtimeRoot, brand, platform, arch });
  const startedAt = now();
  let source;
  let executable;
  let installation;
  if (existsSync(path.join(runtimeRoot, E2E_DAEMON_DIRECTORY))) {
    source = 'artifact';
    installation = install({
      runtimeRoot,
      sourceSha: sourceSha(),
      platform,
      arch,
      brand,
    });
    ({ executable } = installation);
  } else if (isLaunchableLocalBuild(targets)) {
    const stale = staleLocalBuild({
      inspect: inspectLocalBuild,
      runtimeRoot,
      env,
      platform,
      arch,
      targets,
    });
    // Refused locally too: a stale build is no evidence of this checkout.
    if (stale.length > 0)
      throw new Error(
        `Files dry run: the local build would not run this checkout's code: ${stale.join('; ')}. Run pnpm run dev:core-daemon first.`,
      );
    source = 'local-build';
    ({ executable } = targets);
  } else {
    const message = `Files dry run: lane has no launchable daemon. Neither a verified ${E2E_DAEMON_DIRECTORY} artifact nor a local build at ${targets.executable} (with its identity and node-pty) and ${targets.ownedChildNativePath} exists`;
    if (env.CI) throw new Error(message);
    warn(
      `${message}; Files reads will fall back to the in-process reader. Run pnpm run dev:core-daemon first.`,
    );
    return { state: 'missing', socket };
  }
  const installedAt = now();
  try {
    smoke({ root: runtimeRoot, executable });
  } catch (error) {
    installation?.cleanup?.();
    throw error;
  }
  return {
    state: 'ready',
    source,
    executable,
    socket,
    installMs: installedAt - startedAt,
    smokeMs: now() - installedAt,
    ...(installation?.runtimeRoot && {
      runtimeRoot: installation.runtimeRoot,
      cleanup: () => installation.cleanup(),
    }),
  };
}

function readDryRunLines(directory, prefix, runId) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.ndjson'))
    .flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line, index) => {
          try {
            return JSON.parse(line);
          } catch {
            throw new Error(
              `Files dry run: ${name} line ${index + 1} is not JSON: ${line.slice(0, 200)}`,
            );
          }
        }),
    )
    .filter((record) => record.runId === runId);
}

const nameLaunches = (launches, describe = () => '') => {
  const named = launches.slice(0, 10).map((launch) => {
    const { test } = launch;
    const who = test
      ? `${test.file} > ${test.title} (retry ${test.retry})`
      : 'no test';
    return `${who}${describe(launch)}`;
  });
  return `${named.join('; ')}${launches.length > named.length ? '; ...' : ''}`;
};

const describeSocket = ({ socket }) =>
  ` ${socket.bytes} bytes over ${socket.limit}`;

/**
 * Fails the run when one of its registered launches closed without an
 * evidence line, reached the daemon from a data root too deep for its socket,
 * fell back, or had evidence that was unreadable or not main's snapshot. Many
 * teardown helpers swallow close failures, so the per-close fallback check
 * alone cannot fail the run. Every failing kind is reported, one per line.
 */
export function verifyDaemonDryRunLaunches({
  runId,
  directory = DAEMON_DRY_RUN_DIRECTORY,
}) {
  const registered = readDryRunLines(directory, 'registered', runId);
  const evidence = new Map(
    readDryRunLines(directory, 'launches', runId).map((line) => [
      line.launchId,
      line,
    ]),
  );
  const failures = [];
  const check = (failing, what, describe, advice = '') => {
    if (failing.length > 0)
      failures.push(
        `Files dry run: ${failing.length} of ${registered.length} launches ${what}: ${nameLaunches(failing, describe)}${advice}`,
      );
  };
  check(
    registered.filter(({ launchId }) => !evidence.has(launchId)),
    'have no evidence line',
  );
  // Named by the launch's test, which a close in a hook may not know.
  const recorded = registered
    .filter(({ launchId }) => evidence.has(launchId))
    .map((launch) => ({ ...evidence.get(launch.launchId), test: launch.test }));
  // The likely cause of the failures below for that launch, so named first.
  // A spec's own mkdtemp prefix adds to TMPDIR; the lane preflight checked
  // only the launcher's.
  check(
    recorded.filter(
      ({ socket, daemonRouted }) => socket?.fits === false && daemonRouted > 0,
    ),
    'used the daemon from a data root too deep for its socket',
    describeSocket,
    ". Give the spec's data root a shorter mkdtemp prefix, or run under a shorter TMPDIR such as /tmp.",
  );
  check(
    recorded.filter(({ fallbacks }) => Object.keys(fallbacks ?? {}).length > 0),
    'fell back',
    ({ fallbacks }) => ` ${JSON.stringify(fallbacks)}`,
  );
  const describeError = ({ evidenceError }) => ` ${evidenceError}`;
  // No evidence hook, or a snapshot shape this check cannot read: nothing
  // proved the launch's route or fallbacks.
  check(
    recorded.filter(({ evidenceInvalid }) => evidenceInvalid === true),
    'have invalid evidence',
    describeError,
  );
  // Typically read after a SIGKILL or quit the harness never saw, so nothing
  // checked that launch's fallbacks.
  check(
    recorded.filter(
      ({ evidenceError, evidenceInvalid }) =>
        evidenceError != null && evidenceInvalid !== true,
    ),
    'have unreadable evidence',
    describeError,
    '. A spec that ends the app itself must await captureDaemonDryRunEvidence(electronApp) first.',
  );
  if (failures.length > 0) throw new Error(failures.join('\n'));
  return { launches: registered.length, recorded: recorded.length };
}

export default function globalSetup() {
  const result = prepareLaneDaemon();
  if (result.state === 'inert') return undefined;
  // Give the lane a clean product lookup tree, not permission to overwrite a
  // local production daemon with its deliberately different E2E composition.
  if (result.runtimeRoot)
    process.env[DAEMON_LANE_RUNTIME_ROOT_ENV] = result.runtimeRoot;
  else delete process.env[DAEMON_LANE_RUNTIME_ROOT_ENV];
  // Workers inherit it; it keeps earlier runs' files out of this run's check.
  const runId = randomUUID();
  process.env[DAEMON_DRY_RUN_ID_ENV] = runId;
  console.log(`Files dry run lane daemon: ${JSON.stringify(result)}`);
  try {
    // Beside the per-launch evidence, for the per-lane time delta.
    mkdirSync(DAEMON_DRY_RUN_DIRECTORY, { recursive: true });
    writeFileSync(
      path.join(DAEMON_DRY_RUN_DIRECTORY, `global-setup-${process.pid}.json`),
      `${JSON.stringify({
        at: new Date().toISOString(),
        runId,
        lane: process.env.CANOPY_UI_TIMINGS_LANE ?? null,
        ...result,
      })}\n`,
    );
  } catch (error) {
    // Playwright runs no teardown for a setup that throws.
    result.cleanup?.();
    delete process.env[DAEMON_LANE_RUNTIME_ROOT_ENV];
    throw error;
  }
  // Playwright runs a returned function as the global teardown.
  return () => {
    try {
      const summary = verifyDaemonDryRunLaunches({ runId });
      console.log(`Files dry run launches: ${JSON.stringify(summary)}`);
    } finally {
      result.cleanup?.();
      delete process.env[DAEMON_LANE_RUNTIME_ROOT_ENV];
    }
  };
}
