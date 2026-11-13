/**
 * Keeps the development core daemon current for dev runs (GA5, CAN-5540).
 * Unpackaged Electron launches `dist/core-daemon/<name>` through the
 * owned-child addon under `.cache/native-owned-child/<platform>-<arch>/`
 * (`electron-daemon-host.ts`); neither exists until something builds it.
 * `build` mode rebuilds whichever one is missing or no longer matches its
 * source record (scripts/lib/core-daemon-sources.mjs) and refuses when a
 * build fails; `check` mode only reports. `watchDevCoreDaemon` reports
 * inputs edited while dev runs. Only macOS, Windows and Linux (CAN-4966) can
 * launch the daemon, so other hosts build nothing.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { daemonName } from '../../packages/protocol/src/brand.ts';
import { loadBrand } from '../brand/load-brand.mjs';
import { daemonBuildIdentity } from './check-migration-role-package.mjs';
import { CODE_GRAPH_RUNTIME_MODULES } from '../../packages/core-platform/src/execution-host/daemon-payload.ts';
import {
  checkSourcesRecord,
  filesUnder,
  recordedInputs,
  writeSourcesRecord,
} from './core-daemon-sources.mjs';

export const SKIP_ENV = 'CANOPY_DEV_SKIP_CORE_DAEMON';
const LAUNCH_HOSTS = new Set(['darwin', 'win32', 'linux']);
const OWNED_CHILD_FILE = 'core-owned-child.node';
const OWNED_CHILD_NATIVE = join(
  'packages',
  'core-platform',
  'native',
  'owned-child',
);
const OWNED_CHILD_SCRIPT = join('scripts', 'build-owned-child.mjs');
const CORE_DAEMON_SCRIPT = join('scripts', 'build-core-daemon.mjs');

function daemonReleaseFlavor(env) {
  return env.CANOPY_RELEASE_FLAVOR ?? 'stable';
}

/** Secure-folder build selection is independent of migration eligibility. */
export function daemonSecureDirectoryDefines({ brand, env = process.env }) {
  return {
    __CANOPY_DAEMON_DATA_DIR_NAMES__: JSON.stringify(
      brand.storage.dataDirNames,
    ),
    __CANOPY_DAEMON_SECURE_DIR_NAMES__: JSON.stringify(
      brand.storage.secureDataDirNames,
    ),
    __CANOPY_DAEMON_RELEASE_FLAVOR__: JSON.stringify(daemonReleaseFlavor(env)),
  };
}

/** What a daemon build is for, beyond its inputs. */
export function coreDaemonFacts({
  identity,
  env = process.env,
  node = process.version,
  platform = process.platform,
  arch = process.arch,
}) {
  return {
    node,
    platform,
    arch,
    identity: { ...identity },
    releaseFlavor: daemonReleaseFlavor(env),
    secureStorageLayout: 'nested-v1',
  };
}

/** The non-bundled inputs a host daemon build stages or reads. */
export function coreDaemonStaticInputs({
  root,
  brandId,
  platform = process.platform,
}) {
  const native = (name) =>
    filesUnder(join(root, 'packages', 'core-platform', 'native', name));
  return [
    join(root, 'brands', brandId, 'brand.json'),
    ...filesUnder(
      join(root, 'packages', 'desktop-shared', 'resources', 'code-graph'),
    ),
    // The packages the build copies or builds from, as it resolves them.
    ...[...CODE_GRAPH_RUNTIME_MODULES, 'node-pty'].map((name) =>
      join(root, 'node_modules', name, 'package.json'),
    ),
    // Windows host builds also stage the W5 worker's owned-child addon.
    ...(platform === 'win32'
      ? [
          ...native('windows-pipe'),
          ...native('windows-process'),
          ...native('owned-child'),
        ]
      : []),
  ];
}

function ownedChildFacts({ platform, arch }) {
  return { node: process.version, platform, arch };
}

function ownedChildInputs(root) {
  return [
    join(root, OWNED_CHILD_SCRIPT),
    ...filesUnder(join(root, OWNED_CHILD_NATIVE)),
  ];
}

/** The unpackaged lookup paths `createElectronDaemonHost` resolves. */
export function devCoreDaemonPaths({ root, brand, platform, arch }) {
  return {
    executable: resolve(
      root,
      'dist',
      'core-daemon',
      `${daemonName(brand)}${platform === 'win32' ? '.exe' : ''}`,
    ),
    ownedChild: resolve(
      root,
      '.cache',
      'native-owned-child',
      `${platform}-${arch}`,
      OWNED_CHILD_FILE,
    ),
  };
}

/** Both artifacts' states; reads the checkout, never builds. */
export function inspectDevCoreDaemon({
  root,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
}) {
  const brand = loadBrand(env.CANOPY_BRAND ?? 'canopy');
  const { version } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const identity = daemonBuildIdentity({ brand, version, env });
  const paths = devCoreDaemonPaths({ root, brand, platform, arch });
  return {
    ownedChild: {
      label: 'owned-child addon',
      path: paths.ownedChild,
      ...checkSourcesRecord({
        root,
        artifactPath: paths.ownedChild,
        facts: ownedChildFacts({ platform, arch }),
      }),
    },
    daemon: {
      label: 'core daemon',
      path: paths.executable,
      ...checkSourcesRecord({
        root,
        artifactPath: paths.executable,
        facts: coreDaemonFacts({ identity, env, platform, arch }),
      }),
    },
  };
}

function describe(root, status) {
  const where = relative(root, status.path);
  if (status.state === 'missing')
    return `The ${status.label} is not built at ${where}`;
  if (status.state === 'stale')
    return `The ${status.label} at ${where} ${status.reason}`;
  return `The ${status.label} at ${where} is current`;
}

function runNodeScript({ root, script, env }) {
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function refuseFailedBuild(label, status) {
  return new Error(
    `The ${label} build failed (exit ${status}), so Electron was not started. ` +
      `Fix the build, or set ${SKIP_ENV}=1 to start without a current daemon; ` +
      'Files reads through the daemon then fail or run stale code.',
  );
}

// `ps` reports start times to the second.
const START_TIME_SLACK_MS = 1_000;

/** Running processes on macOS; other hosts report none. */
export function listHostProcesses(platform = process.platform) {
  if (platform !== 'darwin') return [];
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,lstart=,command='], {
    encoding: 'utf8',
    env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').flatMap((line) => {
    // `lstart` is fixed-width C-locale text: "Sun Nov  1 06:40:12 2026".
    const match = line.match(
      /^\s*(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/,
    );
    const startedAtMs = match ? Date.parse(match[2]) : Number.NaN;
    return Number.isFinite(startedAtMs)
      ? [{ pid: Number(match[1]), startedAtMs, command: match[3] }]
      : [];
  });
}

/**
 * Daemons still running from `executable` that started before its current
 * build was written: a launcher attaches to them, so they serve older code
 * until they exit.
 */
export function olderRunningDaemons({ executable, processes }) {
  let builtAtMs;
  try {
    builtAtMs = statSync(executable).mtimeMs;
  } catch {
    return [];
  }
  return processes.filter(
    ({ command, startedAtMs }) =>
      (command === executable || command.startsWith(`${executable} `)) &&
      startedAtMs + START_TIME_SLACK_MS <= builtAtMs,
  );
}

const DATA_ROOT_SWITCH = ' --data-root ';

/** The launch command before the launcher's switches, or `null` for a non-daemon. */
function daemonLaunchPrefix(command, name) {
  const end = command.indexOf(DATA_ROOT_SWITCH);
  if (end < 0) return null;
  const prefix = command.slice(0, end);
  // Launchers pass the executable path, with no extra arguments in dev.
  return basename(prefix) === name ? prefix : null;
}

const fromExecutable = (command, executable) =>
  command === executable || command.startsWith(`${executable} `);

/**
 * The daemon a launcher for `dataRoot` attaches to: the live process its
 * descriptor (`<data root>/runtime/core.json`, read-only) names, launched for
 * that data root. `null` when none is registered or the descriptor is stale.
 */
export function registeredDaemon({ dataRoot, processes, name }) {
  let canonical;
  let pid;
  try {
    // Launchers serve the native realpath (local-authority.ts), which, unlike
    // the JS one, also restores the on-disk letter case.
    canonical = realpathSync.native(dataRoot);
    ({ pid } = JSON.parse(
      readFileSync(join(canonical, 'runtime', 'core.json'), 'utf8'),
    ));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const switches = `${DATA_ROOT_SWITCH}${canonical} `;
  const daemon = processes.find(
    ({ pid: candidate, command }) =>
      candidate === pid &&
      `${command} `.includes(switches) &&
      daemonLaunchPrefix(command, name) !== null,
  );
  return daemon
    ? {
        ...daemon,
        dataRoot: canonical,
        executable: daemonLaunchPrefix(daemon.command, name),
      }
    : null;
}

const DATA_ROOT_PROBE = `
const [file, mode] = process.argv.slice(1);
import(require('node:url').pathToFileURL(file).href).then((paths) => {
  const resolve =
    paths.getResolvedCanopyDataDir ?? paths.default.getResolvedCanopyDataDir;
  process.stdout.write(JSON.stringify(resolve(mode).path));
});`;

/**
 * The data root dev Electron serves, from canopy-paths' own resolver (its
 * install-data checks decide between candidates), run through tsx.
 */
export function resolveDevDataRoot({ root, env = process.env }) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      DATA_ROOT_PROBE,
      join(root, 'packages', 'execution-engine', 'src', 'canopy-paths.ts'),
      'dev',
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim().split('\n').at(-1) || `exit ${result.status}`,
    );
  const dataRoot = JSON.parse(result.stdout);
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot))
    throw new Error(`unexpected data root ${result.stdout}`);
  return dataRoot;
}

/**
 * The daemon dev attaches to when another executable runs it, as from
 * another worktree or an installed app sharing the data root. Resolves the
 * data root only when such a daemon runs.
 */
export function foreignRegisteredDaemon({
  executable,
  processes,
  resolveDataRoot,
}) {
  const name = basename(executable);
  const foreign = processes.some(
    ({ command }) =>
      daemonLaunchPrefix(command, name) !== null &&
      !fromExecutable(command, executable),
  );
  if (!foreign) return null;
  const daemon = registeredDaemon({
    dataRoot: resolveDataRoot(),
    processes,
    name,
  });
  return daemon && !fromExecutable(daemon.command, executable) ? daemon : null;
}

function warnRunningDaemons({
  root,
  executable,
  env,
  listProcesses,
  resolveDataRoot,
  platform,
  warn,
}) {
  const processes = listProcesses(platform);
  const advice =
    'Clients attach to it until it exits, about 30 seconds after its last client disconnects; quit the app or CLI using it, or stop it.';
  for (const { pid, command } of olderRunningDaemons({
    executable,
    processes,
  })) {
    const dataRoot = command.match(/--data-root (\S+)/)?.[1];
    warn(
      `Warning: core daemon ${pid}${dataRoot ? ` (data root ${dataRoot})` : ''} started before ${relative(root, executable)} was last built and still runs the older build. ${advice}`,
    );
  }
  // Launchers attach to a live compatible daemon without comparing executables.
  let foreign;
  try {
    foreign = foreignRegisteredDaemon({
      executable,
      processes,
      resolveDataRoot: () => resolveDataRoot({ root, env }),
    });
  } catch (error) {
    warn(
      `Warning: could not resolve the dev data root, so a core daemon from another checkout that dev may attach to goes unreported: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (foreign)
    warn(
      `Warning: core daemon ${foreign.pid}, registered for this dev run's data root ${foreign.dataRoot}, runs ${foreign.executable}, not ${relative(root, executable)}. ` +
        `This run is served by that build, not this checkout's. ${advice}`,
    );
}

/**
 * `build` mode brings both artifacts up to date before Electron starts and
 * throws when a build fails; `check` mode only reports. Both say why any
 * artifact is not current.
 */
export function ensureDevCoreDaemon({
  root,
  mode = 'build',
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
  run = runNodeScript,
  listProcesses = listHostProcesses,
  resolveDataRoot = resolveDevDataRoot,
}) {
  if (!LAUNCH_HOSTS.has(platform)) {
    log(
      `Core daemon: not built on ${platform}, where the desktop host cannot launch it yet.`,
    );
    return { built: [] };
  }
  const inspect = () => inspectDevCoreDaemon({ root, env, platform, arch });
  const initial = inspect();
  const reportOlderDaemons = () =>
    warnRunningDaemons({
      root,
      executable: initial.daemon.path,
      env,
      listProcesses,
      resolveDataRoot,
      platform,
      warn,
    });
  const pending = [initial.ownedChild, initial.daemon].filter(
    (status) => status.state !== 'fresh',
  );
  if (pending.length === 0) {
    log(
      `The core daemon at ${relative(root, initial.daemon.path)} and its owned-child addon match their sources.`,
    );
    reportOlderDaemons();
    return { built: [] };
  }
  if (mode === 'check' || env[SKIP_ENV] === '1') {
    const why =
      mode === 'check'
        ? 'Run `pnpm run dev:core-daemon` first.'
        : `${SKIP_ENV}=1, so dev does not build it.`;
    for (const status of pending)
      warn(
        `Warning: ${describe(root, status)}. ${status.state === 'missing' ? 'This run cannot launch the core daemon, so Files reads through it fail.' : 'A daemon launched in this run serves that older build.'} ${why}`,
      );
    reportOlderDaemons();
    return { built: [] };
  }
  const built = [];
  for (const status of pending) {
    log(`${describe(root, status)}; building it…`);
    const startedAtMs = Date.now();
    const isDaemon = status === initial.daemon;
    const exit = run({
      root,
      env,
      script: isDaemon ? CORE_DAEMON_SCRIPT : OWNED_CHILD_SCRIPT,
    });
    if (exit !== 0) throw refuseFailedBuild(status.label, exit);
    // A missing artifact is refused below, after every build.
    if (!isDaemon && existsSync(status.path)) {
      const record = writeSourcesRecord({
        root,
        artifactPath: status.path,
        facts: ownedChildFacts({ platform, arch }),
        inputs: ownedChildInputs(root),
        startedAtMs,
      });
      if (!record.written)
        warn(
          `Warning: ${record.changed} changed during the owned-child addon build; the next dev run rebuilds it.`,
        );
    }
    built.push(status.label);
  }
  const final = inspect();
  for (const status of [final.ownedChild, final.daemon]) {
    if (status.state === 'missing')
      throw new Error(
        `${describe(root, status)} after a successful build, so Electron was not started.`,
      );
    if (status.state === 'stale')
      warn(
        `Warning: ${describe(root, status)} after its build; the next dev run rebuilds it.`,
      );
  }
  reportOlderDaemons();
  return { built };
}

// Coalesces an editor's save burst into one check.
const WATCH_DELAY_MS = 300;

/**
 * Watches the directories of both artifacts' recorded inputs while dev runs.
 * The running daemon keeps its build, and Electron restarts reattach to it,
 * so each new reason an artifact is stale is reported once, and again only
 * after the artifact matches its sources and goes stale once more. Returns a handle whose `close` stops it.
 */
export function watchDevCoreDaemon({
  root,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
  listProcesses = listHostProcesses,
  resolveDataRoot = resolveDevDataRoot,
  watch: watchDirectory = watch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!LAUNCH_HOSTS.has(platform)) return { close() {} };
  const inspect = () => {
    const { ownedChild, daemon } = inspectDevCoreDaemon({
      root,
      env,
      platform,
      arch,
    });
    return [ownedChild, daemon];
  };
  const initial = inspect();
  // Reasons already reported per artifact, startup's included, until it
  // matches its sources again.
  const reported = new Map(
    initial
      .filter((status) => status.state !== 'fresh')
      .map((status) => [status.label, new Set([describe(root, status)])]),
  );
  const check = () => {
    let statuses;
    try {
      statuses = inspect();
    } catch (error) {
      warn(
        `Warning: could not check the core daemon: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const status of statuses) {
      const description = describe(root, status);
      if (status.state === 'fresh') {
        if (!reported.delete(status.label)) continue;
        log(`The ${status.label} matches its sources again.`);
        if (status.label === 'core daemon')
          warnRunningDaemons({
            root,
            executable: status.path,
            env,
            listProcesses,
            resolveDataRoot,
            platform,
            warn,
          });
      } else if (!reported.get(status.label)?.has(description)) {
        reported.set(
          status.label,
          (reported.get(status.label) ?? new Set()).add(description),
        );
        warn(
          `Warning: ${description} while dev runs. The running daemon keeps serving its older build, and Electron restarts reattach to it; restart \`pnpm run dev\` to rebuild it.`,
        );
      }
    }
  };
  let timer = null;
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      check();
    }, WATCH_DELAY_MS);
  };
  const directories = new Set(
    initial.flatMap((status) =>
      recordedInputs({ root, artifactPath: status.path }).map((path) =>
        dirname(path),
      ),
    ),
  );
  const watchers = [];
  for (const directory of directories) {
    try {
      const watcher = watchDirectory(
        directory,
        { persistent: false },
        schedule,
      );
      // A removed directory ends its watcher; the importing file still changes.
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // A directory gone since the build changes a recorded file elsewhere.
    }
  }
  return {
    close() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}
