// Antigravity launch scenario (CAN-6720): the cost of opening the shared
// Antigravity runtime through ACP initialization with Google's signed CLI,
// cold (a new file identity) and warm (its launch-check verdict cached), and
// the launch check on its own. With `--baseline-root`, the baseline and the
// candidate checkouts are sampled in ABBA order with identical host bytes and
// judged with the suite's noise-aware verdicts.
//
// Google's signed CLI is not redistributable, so it is never fetched. Pass a
// copy of the official release with `--executable`. The file is only read and
// cloned: every launch runs a fresh clone, with a temporary home, data
// directory and profile, so no shared installation, profile or credential is
// used. Without a qualifying executable the scenario reports `unavailable`.
import { build } from 'esbuild';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { interleavedSchedule } from './compare.mjs';
import {
  assessHostMeasurement,
  startHostMeasurement,
} from './host-measurement.mjs';
import { roundSummary, summarize } from './statistics.mjs';
import { judgeScenarioMetrics } from './verdicts.mjs';

const SCHEMA = 'canopy.performance.antigravity-launch/v1';
const RUNTIME_MODULE =
  'packages/desktop-shared/src/node/antigravity/runtime.ts';
const INTEGRITY_MODULE =
  'packages/desktop-shared/src/node/antigravity/runtime-integrity.ts';
const SPAWN_MODULE =
  'packages/desktop-shared/src/node/provider-process/spawn.ts';
const COMMAND_TIMEOUT_MS = 120_000;
/** A host gets this long to close its runtime after SIGTERM, then SIGKILL. */
const HOST_STOP_GRACE_MS = 5_000;
const DEFAULTS = Object.freeze({ repeat: 10, warmups: 1, cachedSamples: 50 });
/** Timing metrics a matched comparison judges; both arms report them. */
const COMPARED_METRICS = Object.freeze(['openColdMs', 'openWarmMs']);
/**
 * Only the launch check names Google's signing team. Its absence from a
 * bundle shows that an arm without the check module did not bring it in under
 * another path. The arm with the module is proven by the import graph
 * instead: its runtime must import the check.
 */
const LAUNCH_CHECK_MARKER = 'EQHXZ8M8AV';
/** What a result from this scenario cannot qualify on its own. */
const LIMITS = Object.freeze([
  'Measures the shared runtime open only, not desktop startup or a chat turn.',
  'Not a packaged app: the host is an esbuild bundle of source, not a release-signed, notarized build (CAN-6717).',
  'Uses the direct provider spawner; Electron main launches through the provider process host, which this does not count.',
  'No core daemon is started or attached in either arm.',
  'macOS only; Windows and Linux are refused (CAN-6718).',
  'Clones share the release blocks on APFS, so cold opens may read cached pages.',
  'Every arm runs the CLI with AGY_CLI_DISABLE_AUTO_UPDATE=true, so the comparison isolates the launch check from the update opt-out that the candidate runtime also sets.',
]);

const driverPath = fileURLToPath(import.meta.url);
const hostPath = resolve(dirname(driverPath), 'antigravity-launch-host.mjs');
const repoRoot = resolve(dirname(driverPath), '../../../..');

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Bundles the host against `root`'s runtime; the host bytes never change. */
export async function buildHost(root, outfile) {
  const integrity = existsSync(join(root, INTEGRITY_MODULE));
  const packageJson = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  const runtimeModule = [
    `export { openAntigravityRuntime } from './${RUNTIME_MODULE}';`,
    `export { spawnProviderProcessDirect } from './${SPAWN_MODULE}';`,
    integrity
      ? `export { assertAntigravityExecutableUnchanged, verifyAntigravityExecutable } from './${INTEGRITY_MODULE}';`
      : 'export const assertAntigravityExecutableUnchanged = undefined;\nexport const verifyAntigravityExecutable = undefined;',
  ].join('\n');
  const { metafile } = await build({
    entryPoints: [hostPath],
    outfile,
    metafile: true,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    absWorkingDir: root,
    logLevel: 'error',
    // The globals the bundled runtime reads; a checkout that adds one must be
    // given it here, or its bundle fails to build or run.
    define: {
      __CANOPY_CURSOR_CLI__: JSON.stringify(packageJson['cursor-cli']),
      __CANOPY_E2E__: 'false',
      __CANOPY_RELEASE_FLAVOR__: JSON.stringify('stable'),
      __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
      __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: 'false',
    },
    plugins: [
      {
        name: 'antigravity-launch-runtime',
        setup(builder) {
          // The host's placeholder becomes this checkout's runtime.
          builder.onResolve(
            { filter: /^\.\/antigravity-launch-runtime\.mjs$/ },
            (args) =>
              args.importer === hostPath
                ? { path: 'runtime', namespace: 'antigravity-launch' }
                : undefined,
          );
          builder.onLoad(
            { filter: /.*/, namespace: 'antigravity-launch' },
            () => ({ contents: runtimeModule, loader: 'js', resolveDir: root }),
          );
        },
      },
    ],
  });
  const launchCheckInBundle = (await readFile(outfile, 'utf8')).includes(
    LAUNCH_CHECK_MARKER,
  );
  if (launchCheckInBundle !== integrity)
    throw new Error(
      `The ${root} host bundle ${launchCheckInBundle ? 'contains' : 'lacks'} the launch check its checkout ${integrity ? 'has' : 'does not have'}.`,
    );
  const runtimeImportsCheck = Boolean(
    metafile.inputs[RUNTIME_MODULE]?.imports.some(
      (entry) => entry.path === INTEGRITY_MODULE,
    ),
  );
  if (runtimeImportsCheck !== integrity)
    throw new Error(
      `The ${root} runtime ${integrity ? 'does not import the launch check its checkout has' : 'imports a launch check its checkout does not have'}.`,
    );
  return {
    integrity,
    launchCheckInBundle,
    runtimeImportsCheck,
    bundleSha256: await sha256(outfile),
  };
}

export function startHost(bundle, env) {
  const child = fork(bundle, [], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
  // An IPC failure surfaces through the request it affects, never as an
  // unhandled event.
  child.on('error', () => undefined);
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  let next = 0;
  const request = (command, args = {}) =>
    new Promise((settle, reject) => {
      if (gone() || !child.connected) {
        reject(new Error(`host is gone before ${command}: ${stderr}`));
        return;
      }
      const id = (next += 1);
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) reject(error);
        else settle(value);
      };
      const onMessage = (message) =>
        message.id === id &&
        finish(message.error ? new Error(message.error) : null, message.value);
      const onExit = (code) =>
        finish(new Error(`host exited ${code}: ${stderr}`));
      const timer = setTimeout(
        () => finish(new Error(`host ${command} timed out`)),
        COMMAND_TIMEOUT_MS,
      );
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send({ id, command, args }, (error) => {
        if (error) finish(error);
      });
    });
  /**
   * SIGTERM lets the host close its open runtime, which stops the CLI's
   * group; a host still running after the grace is killed.
   */
  const stop = async () => {
    if (gone()) return;
    const exited = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    let timer;
    const late = await Promise.race([
      exited.then(() => false),
      new Promise((done) => {
        timer = setTimeout(() => done(true), HOST_STOP_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (late) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  return { request, stop };
}

/** How each sample's copies of the CLI are made; recorded in the result. */
const CLONE_METHOD = 'clonefile(2)';

/**
 * Calls clonefile(2) itself, which clones or fails (for example across
 * volumes) and never falls back to a copy, as Node's COPYFILE_FICLONE and
 * `cp -c` do. A success is therefore a verified clone: a new file identity
 * that shares the release's blocks.
 */
const CLONEFILE = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.clonefile(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0) != 0:
    sys.exit(os.strerror(ctypes.get_errno()))
`;

async function cloneExecutable(source, target) {
  await mkdir(dirname(target), { recursive: true });
  const cloned = spawnSync(
    '/usr/bin/python3',
    ['-I', '-c', CLONEFILE, source, target],
    { encoding: 'utf8', env: {} },
  );
  if (cloned.status !== 0)
    throw new Error(
      `Could not clone ${source}: ${cloned.stderr?.trim() || cloned.error?.message || `exit ${cloned.status}`}`,
    );
  await chmod(target, 0o755);
  return target;
}

/**
 * Private directories for one host process; nothing shared is reachable.
 * Their preparation, clones included, is timed before the host starts, so
 * it is outside every measured open.
 */
async function sampleSandbox(executable) {
  const started = performance.now();
  const root = await realpath(
    await mkdtemp(join(os.tmpdir(), 'agy-launch-perf-')),
  );
  try {
    const paths = {
      root,
      launch: await cloneExecutable(executable, join(root, 'launch', 'agy')),
      probe: await cloneExecutable(executable, join(root, 'probe', 'agy')),
      cwd: join(root, 'workspace'),
      profile: join(root, 'profile'),
      home: join(root, 'home'),
      data: join(root, 'data'),
    };
    await Promise.all(
      [paths.cwd, paths.home, paths.data].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    return { ...paths, prepareMs: performance.now() - started };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The same for every arm and sample, apart from the sample's own private
 * directories. The update opt-out is set here because the candidate runtime
 * sets it and the baseline does not; the CLI inherits it in both.
 */
function hostEnvironment(paths) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    TMPDIR: `${paths.root}/`,
    CANOPY_DATA_DIR: paths.data,
    NODE_ENV: 'production',
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}

/** The file system of the volume holding `path`, from the mount table. */
function volumeOf(path) {
  // `df` resolves firmlinks to the volume that really holds the path.
  const df = spawnSync('/bin/df', ['-P', path], { encoding: 'utf8', env: {} });
  const row = df.stdout?.trim().split('\n')[1]?.split(/\s+/);
  if (df.status !== 0 || !row || row.length < 6) return null;
  const device = row[0];
  const mountPoint = row.slice(5).join(' ');
  const mounts = spawnSync('/sbin/mount', [], { encoding: 'utf8', env: {} });
  for (const line of mounts.stdout?.split('\n') ?? []) {
    const match = /^(\S+) on (.+) \(([^,)]+)/.exec(line);
    if (match && match[1] === device && match[2] === mountPoint)
      return { device, mountPoint, type: match[3] };
  }
  return { device, mountPoint, type: null };
}

/** The recorded environment, with each sample's private paths named. */
const RECORDED_ENVIRONMENT = Object.freeze(
  hostEnvironment({
    root: '<sample>',
    home: '<sample>/home',
    data: '<sample>/data',
  }),
);

async function withHost(arm, executable, work) {
  const paths = await sampleSandbox(executable);
  const host = startHost(arm.bundle, hostEnvironment(paths));
  try {
    return await work(host, paths);
  } finally {
    await host.stop();
    await rm(paths.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function runSample(arm, executable, cachedSamples) {
  return withHost(arm, executable, async (host, paths) => ({
    prepareMs: paths.prepareMs,
    ...(await host.request('sample', {
      launch: paths.launch,
      probe: paths.probe,
      cwd: paths.cwd,
      profile: paths.profile,
      cachedSamples,
    })),
  }));
}

/** The names of the file's extended attributes, or null when unreadable. */
function extendedAttributes(file) {
  const read = spawnSync('/usr/bin/xattr', [file], {
    encoding: 'utf8',
    env: {},
  });
  if (read.status !== 0) return null;
  return read.stdout.split('\n').filter(Boolean).sort();
}

/** The code signature `codesign` reports, or why it reports none. */
function signatureIdentity(file) {
  const read = spawnSync('/usr/bin/codesign', ['-dvv', file], {
    encoding: 'utf8',
    env: {},
  });
  const lines = `${read.stdout}${read.stderr}`.split('\n');
  const field = (name) =>
    lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ??
    null;
  if (read.status !== 0)
    return { signed: false, detail: lines.find(Boolean) ?? null };
  return {
    signed: true,
    identifier: field('Identifier'),
    teamIdentifier: field('TeamIdentifier'),
    authorities: lines
      .filter((line) => line.startsWith('Authority='))
      .map((line) => line.slice('Authority='.length)),
    timestamp: field('Timestamp'),
    codeDirectory: field('CodeDirectory v'),
  };
}

/**
 * Records the executable's identity and qualifies it with a checkout's own
 * launch check. `reason` explains why it cannot be measured, or is null.
 */
async function qualifyExecutable(executable, arms) {
  if (process.platform !== 'darwin')
    return {
      reason: 'Antigravity launches are supported only on macOS.',
      identity: null,
    };
  if (!executable)
    return {
      reason: 'Pass a copy of the official Antigravity CLI with --executable.',
      identity: null,
    };
  const info = await stat(executable).catch(() => null);
  if (!info?.isFile())
    return { reason: `${executable} is not a file.`, identity: null };
  const checker = arms.find((arm) => arm.integrity);
  const identity = {
    sha256: await sha256(executable),
    bytes: info.size,
    signature: signatureIdentity(executable),
    // A quarantined download keeps its attributes in every clone, and
    // Gatekeeper may then assess each clone at its first run.
    extendedAttributes: extendedAttributes(executable),
    qualified: false,
    qualifiedBy: checker?.side ?? null,
    version: null,
  };
  if (!checker)
    return {
      reason:
        'Neither checkout has the Antigravity launch check to qualify the executable.',
      identity,
    };
  try {
    await withHost(checker, executable, (host, paths) =>
      host.request('qualify', { executable: paths.probe }),
    );
  } catch (error) {
    return {
      reason: `The executable did not pass the launch check, or its host failed: ${String(error?.message ?? error).split('\n')[0]}`,
      identity,
    };
  }
  identity.qualified = true;
  return { reason: null, identity };
}

/**
 * Load admission decides first: a contended host cannot support a verdict.
 * Neither can an arm whose source is dirty or unknown, since its commit
 * would not name what was measured.
 */
export function concludeLaunchRun(hostLoad, comparison, arms = {}) {
  if (hostLoad?.status !== 'valid')
    return {
      status: 'inconclusive',
      reasons: hostLoad?.reasons ?? ['Host load was not measured.'],
    };
  const unclean = Object.entries(arms)
    .filter(
      ([, arm]) =>
        arm.commit === null ||
        arm.dirty !== false ||
        (arm.dirtyAfter !== undefined && arm.dirtyAfter !== false) ||
        (arm.commitAfter !== undefined && arm.commitAfter !== arm.commit),
    )
    .map(([side]) => `The ${side} checkout is dirty or not a known commit.`);
  if (unclean.length > 0) return { status: 'inconclusive', reasons: unclean };
  return { status: comparison?.verdict ?? 'single-arm', reasons: [] };
}

function armMetadata(arm) {
  const status = git(arm.root, ['status', '--porcelain']);
  return {
    root: arm.root,
    commit: git(arm.root, ['rev-parse', 'HEAD']),
    // Unknown when git cannot read the tree; never assumed clean.
    dirty: status === null ? null : status.length > 0,
    integrity: arm.integrity,
    launchCheckInBundle: arm.launchCheckInBundle,
    runtimeImportsCheck: arm.runtimeImportsCheck,
    hostBundleSha256: arm.bundleSha256,
  };
}

function summarizeArm(samples) {
  const pick = (key) => samples.map((sample) => sample[key]);
  const flat = (key) => samples.flatMap((sample) => sample[key] ?? []);
  const summaries = {
    openColdMs: summarize(pick('openColdMs')),
    openWarmMs: summarize(pick('openWarmMs')),
    closeMs: summarize(pick('closeMs')),
    // Outside every open: the sandbox and its clones, before the host.
    prepareMs: summarize(pick('prepareMs')),
  };
  if (samples.some((sample) => sample.verifyColdMs !== undefined)) {
    summaries.verifyColdMs = summarize(pick('verifyColdMs'));
    summaries.verifyCachedMs = summarize(flat('verifyCachedMs'));
    summaries.unchangedCheckMs = summarize(flat('unchangedCheckMs'));
  }
  return Object.fromEntries(
    Object.entries(summaries).map(([key, value]) => [key, roundSummary(value)]),
  );
}

async function runAntigravityLaunch({
  executable,
  baselineRoot,
  candidateRoot = repoRoot,
  repeat = DEFAULTS.repeat,
  warmups = DEFAULTS.warmups,
  cachedSamples = DEFAULTS.cachedSamples,
  output,
}) {
  const work = await realpath(
    await mkdtemp(join(os.tmpdir(), 'agy-launch-hosts-')),
  );
  const sides = baselineRoot ? ['baseline', 'candidate'] : ['candidate'];
  const roots = { baseline: baselineRoot, candidate: candidateRoot };
  const result = {
    schema: SCHEMA,
    status: 'unavailable',
    reason: null,
    createdAt: new Date().toISOString(),
    plan: { repeat, warmups, cachedSamples, order: 'abba', sides },
    limits: LIMITS,
    environment: RECORDED_ENVIRONMENT,
    cloneMethod: CLONE_METHOD,
    driver: {
      path: relative(repoRoot, driverPath),
      sha256: await sha256(driverPath),
    },
    hostSource: {
      path: relative(repoRoot, hostPath),
      sha256: await sha256(hostPath),
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      node: process.version,
      volume: null,
    },
    executable: null,
    arms: {},
    samples: [],
    summaries: {},
    comparison: null,
    hostLoad: null,
    conclusion: null,
  };
  const arms = {};
  try {
    if (
      executable &&
      !(await stat(resolve(executable)).catch(() => null))?.isFile()
    ) {
      result.reason = `${resolve(executable)} is not a file.`;
      return await finish(result, output);
    }
    if (executable && process.platform === 'darwin') {
      const temporary = volumeOf(work);
      const source = volumeOf(resolve(executable));
      result.host.volume = temporary;
      if (
        temporary?.type !== 'apfs' ||
        !source ||
        source.device !== temporary.device
      ) {
        result.reason = `The executable and the temporary directory must be on the same APFS volume, so each sample can clone the CLI (temporary: ${temporary?.mountPoint ?? 'unknown'}, ${temporary?.type ?? 'unknown type'}; executable: ${source?.mountPoint ?? 'unknown'}).`;
        return await finish(result, output);
      }
    }
    if (executable && process.platform === 'darwin') {
      // One clone before anything else uses it, so a missing python3 or a
      // volume that cannot clone is reported as itself.
      const probe = join(work, 'clone-preflight', 'agy');
      try {
        await cloneExecutable(resolve(executable), probe);
      } catch (error) {
        result.reason = `Each sample clones the CLI with clonefile(2) through /usr/bin/python3, which failed: ${String(error?.message ?? error).split('\n')[0]}`;
        return await finish(result, output);
      } finally {
        await rm(dirname(probe), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    if (
      baselineRoot &&
      (await realpath(resolve(baselineRoot)).catch(() =>
        resolve(baselineRoot),
      )) ===
        (await realpath(resolve(candidateRoot)).catch(() =>
          resolve(candidateRoot),
        ))
    ) {
      result.reason =
        'The baseline and the candidate are the same checkout. Pass an unchanged checkout as --baseline-root.';
      return await finish(result, output);
    }
    try {
      for (const side of sides) {
        const root = resolve(roots[side]);
        const bundle = join(work, `${side}.cjs`);
        arms[side] = {
          side,
          root,
          bundle,
          ...(await buildHost(root, bundle)),
        };
        result.arms[side] = armMetadata(arms[side]);
      }
    } catch (error) {
      // A checkout that does not build, or whose bundle disagrees with it
      // about the launch check, is an error, not a refusal.
      result.status = 'failed';
      result.reason = `A host could not be built: ${String(error?.message ?? error).split('\n')[0]}`;
      return await finish(result, output);
    }
    // This scenario measures the launch check, so the candidate must carry
    // it; a baseline may have it or not, and the arms record which.
    if (!arms.candidate.integrity) {
      result.reason =
        'The candidate checkout lacks the Antigravity launch check this scenario measures.';
      return await finish(result, output);
    }
    const absolute = executable ? resolve(executable) : null;
    const qualification = await qualifyExecutable(
      absolute,
      Object.values(arms),
    );
    result.reason = qualification.reason;
    result.executable = qualification.identity;
    if (result.reason) return await finish(result, output);

    try {
      for (let warmup = 0; warmup < warmups; warmup += 1)
        for (const side of sides)
          await runSample(arms[side], absolute, cachedSamples);

      // Admission covers the recorded schedule only, not builds, warmups or
      // qualification.
      const measurement = startHostMeasurement();
      const schedule = baselineRoot
        ? interleavedSchedule(repeat)
        : Array.from({ length: repeat }, (_, sample) => ({
            sample,
            sides: ['candidate'],
          }));
      try {
        for (const { sample, sides: order } of schedule)
          for (const side of order)
            result.samples.push({
              side,
              sample,
              ...(await runSample(arms[side], absolute, cachedSamples)),
            });
      } finally {
        result.hostLoad = assessHostMeasurement(measurement.stop());
      }
      const versions = new Set(
        result.samples.flatMap((sample) => sample.versions ?? [null]),
      );
      const [version] = versions;
      if (versions.size !== 1 || typeof version !== 'string')
        throw new Error(
          `Samples reported missing or different runtime versions: ${[...versions].join(', ')}.`,
        );
      result.executable.version = version;
      // A tree that changed while it was measured does not name what ran.
      for (const side of sides) {
        const after = armMetadata(arms[side]);
        result.arms[side].dirtyAfter = after.dirty;
        result.arms[side].commitAfter = after.commit;
      }
    } catch (error) {
      // The samples taken and the host load so far are kept with the reason.
      result.status = 'failed';
      result.reason = String(error?.message ?? error).split('\n')[0];
      return await finish(result, output);
    }
    result.status = 'measured';
    for (const side of sides)
      result.summaries[side] = summarizeArm(
        result.samples.filter((sample) => sample.side === side),
      );
    if (baselineRoot) {
      const values = (side, key) =>
        result.samples
          .filter((sample) => sample.side === side)
          .map((sample) => sample[key]);
      result.comparison = judgeScenarioMetrics(
        COMPARED_METRICS.map((key) => ({
          key,
          unit: 'ms',
          direction: 'lower',
          baseline: values('baseline', key),
          candidate: values('candidate', key),
        })),
      );
    }
    result.conclusion = concludeLaunchRun(
      result.hostLoad,
      result.comparison,
      result.arms,
    );
    return await finish(result, output);
  } catch (error) {
    // Anything not refused or failed above still leaves a result.
    result.status = 'failed';
    result.reason = String(error?.message ?? error).split('\n')[0];
    return await finish(result, output);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function finish(result, output) {
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

function count(value, fallback, minimum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`Invalid count ${value}; expected an integer ≥ ${minimum}`);
  return parsed;
}

const USAGE = `Usage: pnpm run perf:desktop:antigravity-launch --executable <official CLI copy> [options]
  --baseline-root <path>   Unchanged checkout to compare against (ABBA interleaved)
  --candidate-root <path>  Checkout under test (default: this checkout)
  --repeat <n>             Samples per side (default ${DEFAULTS.repeat})
  --warmups <n>            Unrecorded samples per side first (default ${DEFAULTS.warmups})
  --cached-samples <n>     Cached launch-check reads per sample (default ${DEFAULTS.cachedSamples})
  --output <path>          Result JSON (default .performance/desktop/antigravity-launch-<time>.json)`;

if (process.argv[1] === driverPath) {
  const { values } = parseArgs({
    options: {
      executable: { type: 'string' },
      'baseline-root': { type: 'string' },
      'candidate-root': { type: 'string' },
      repeat: { type: 'string' },
      warmups: { type: 'string' },
      'cached-samples': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = resolve(
      values.output ??
        join(repoRoot, `.performance/desktop/antigravity-launch-${stamp}.json`),
    );
    const result = await runAntigravityLaunch({
      executable: values.executable,
      baselineRoot: values['baseline-root'],
      candidateRoot: values['candidate-root'],
      repeat: count(values.repeat, DEFAULTS.repeat, 1),
      warmups: count(values.warmups, DEFAULTS.warmups, 0),
      cachedSamples: count(values['cached-samples'], DEFAULTS.cachedSamples, 1),
      output,
    });
    console.log(
      JSON.stringify(
        {
          output,
          status: result.status,
          reason: result.reason,
          summaries: result.summaries,
          verdict: result.comparison?.verdict ?? null,
          hostLoad: result.hostLoad,
          conclusion: result.conclusion,
        },
        null,
        2,
      ),
    );
    // A failed run is an error; an unavailable one is a refusal with a
    // reason, and a measured one exits 0 whatever its conclusion.
    if (result.status === 'failed') process.exitCode = 1;
  }
}
