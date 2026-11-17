// Forked host for `antigravity-launch-run.mjs`, bundled at run time against one
// checkout. `./antigravity-launch-runtime.mjs` is replaced with that checkout's
// Antigravity runtime, so the same host bytes measure the baseline and the
// candidate. One process measures one sample, so every first launch starts
// with an empty verdict cache. Commands arrive over IPC.
import {
  assertAntigravityExecutableUnchanged,
  openAntigravityRuntime,
  spawnProviderProcessDirect,
  verifyAntigravityExecutable,
} from './antigravity-launch-runtime.mjs';

const owner = { kind: 'discovery', id: 'antigravity-launch-perf' };

/**
 * Aborted when the driver stops this host: an open in progress stops its CLI,
 * and an open runtime is closed, so no CLI outlives its sample.
 */
const stopping = new AbortController();
/** Each open runtime with its one close, shared by the sample and SIGTERM. */
const openRuntimes = new Map();
const opening = new Set();
/** Inside the driver's 5 s before it kills this host. */
const STOP_WAIT_MS = 4_000;

function closeOnce(runtime) {
  let closing = openRuntimes.get(runtime);
  if (!closing) {
    closing = runtime.close();
    openRuntimes.set(runtime, closing);
  }
  return closing;
}

process.once('SIGTERM', () => {
  stopping.abort();
  const timer = setTimeout(() => process.exit(0), STOP_WAIT_MS);
  // An open in progress settles once its abort has stopped its CLI. A
  // runtime it returned is registered before it settles, so the second
  // sweep closes it too. Ends within the wait either way.
  void Promise.allSettled([...opening])
    .then(() =>
      Promise.allSettled(
        [...openRuntimes.keys()].map((runtime) => closeOnce(runtime)),
      ),
    )
    .finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
});

/** Tracks an open and registers its runtime before the open settles. */
function track(promise) {
  const registered = promise.then((runtime) => {
    if (!openRuntimes.has(runtime)) openRuntimes.set(runtime, undefined);
    return runtime;
  });
  opening.add(registered);
  void registered
    .catch(() => undefined)
    .finally(() => opening.delete(registered));
  return registered;
}

async function timed(work) {
  const started = performance.now();
  const value = await work();
  return { ms: performance.now() - started, value };
}

/** Opens the runtime through ACP initialization, as every surface does. */
async function openAndClose({ executable, cwd, profile }) {
  // Once the driver stops this host, no new CLI starts.
  stopping.signal.throwIfAborted();
  process.env.ANTIGRAVITY_EXECUTABLE = executable;
  const opened = await timed(() =>
    track(
      openAntigravityRuntime({
        cwd,
        profile,
        spawnProcess: spawnProviderProcessDirect,
        assertEnabled: () => undefined,
        signal: stopping.signal,
        owner,
        onUpdate: () => undefined,
      }),
    ),
  );
  let version = null;
  let closed;
  try {
    version =
      opened.value.client.getInitialization().agentInfo?.version ?? null;
  } finally {
    try {
      closed = await timed(() => closeOnce(opened.value));
    } finally {
      openRuntimes.delete(opened.value);
    }
  }
  return { openMs: opened.ms, closeMs: closed.ms, version };
}

const commands = {
  /** Refuses an executable that this checkout's launch check would refuse. */
  async qualify({ executable }) {
    await verifyAntigravityExecutable(executable);
    return true;
  },
  /**
   * `launch` and `probe` are distinct APFS clones of the same release, so each
   * is a new file identity to this process. `launch` is opened twice: cold,
   * then with its verdict cached. `probe` isolates the launch check itself.
   */
  async sample({ launch, probe, cwd, profile, cachedSamples }) {
    const cold = await openAndClose({ executable: launch, cwd, profile });
    const warm = await openAndClose({ executable: launch, cwd, profile });
    const result = {
      openColdMs: cold.openMs,
      openWarmMs: warm.openMs,
      closeMs: cold.closeMs,
      versions: [cold.version, warm.version],
    };
    if (typeof verifyAntigravityExecutable !== 'function') return result;
    const first = await timed(() => verifyAntigravityExecutable(probe));
    const cached = [];
    const unchanged = [];
    for (let index = 0; index < cachedSamples; index += 1) {
      cached.push((await timed(() => verifyAntigravityExecutable(probe))).ms);
      unchanged.push(
        (await timed(() => assertAntigravityExecutableUnchanged(first.value)))
          .ms,
      );
    }
    return {
      ...result,
      verifyColdMs: first.ms,
      verifyCachedMs: cached,
      unchangedCheckMs: unchanged,
    };
  },
};

process.on('message', async ({ id, command, args }) => {
  try {
    process.send({ id, value: await commands[command](args) });
  } catch (error) {
    process.send({ id, error: String(error?.stack ?? error) });
  }
});
