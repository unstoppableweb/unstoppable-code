/**
 * One sample of the Remote Control workload (CAN-7754): a fresh process with
 * a host, a controller and the controller's window, each on its own thread,
 * joined by an in-memory relay pair. Runs one unmeasured warm-up pass of the
 * scenario, then the measured pass, and prints the result as one JSON line.
 *
 * The runner starts it under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`)
 * so zlib, V8 and BoringSSL are the ones the app ships; see `workload.mjs`.
 *
 * Usage: sample.mjs <json config>
 *   { computerBundle, scenario, seed, warmupScale, drainTimeoutMs }
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

export const SAMPLE_RESULT_PREFIX = 'REMOTE-CONTROL-SAMPLE ';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A worker with request/reply over its parent port. */
function startWorker(file, workerData) {
  const worker = new Worker(file, { workerData });
  let nextId = 1;
  const waiting = new Map();
  let identity = null;
  let identityResolve;
  const identityReady = new Promise((resolve) => {
    identityResolve = resolve;
  });
  const failure = new Promise((_, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`${file} exited with ${String(code)}`));
    });
  });
  failure.catch(() => undefined);
  // The handshake runs after `attach` replies, so its failure has its own
  // message; the sample fails with that error instead of a timeout.
  const connected = Promise.race([
    new Promise((resolve, reject) => {
      worker.once('connected', resolve);
      worker.once('connect-failed', reject);
    }),
    failure,
  ]);
  connected.catch(() => undefined);
  worker.on('message', (message) => {
    if (message.type === 'identity') {
      identity = message;
      identityResolve(message);
      return;
    }
    if (message.type === 'connected') {
      worker.emit('connected');
      return;
    }
    if (message.type === 'connect-failed') {
      worker.emit('connect-failed', new Error(message.message));
      return;
    }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.type === 'error') pending.reject(new Error(message.message));
    else pending.resolve(message);
  });
  return {
    worker,
    get identity() {
      return identity;
    },
    identityReady,
    connected,
    call(type, body = {}, transferList = []) {
      const id = nextId;
      nextId += 1;
      return Promise.race([
        new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          worker.postMessage({ type, id, ...body }, transferList);
        }),
        failure,
      ]);
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Waits until the window has every push the host sent, or the timeout. */
async function drain(windowWorker, { pushes, results, echoes }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const progress = await windowWorker.call('progress');
    if (
      progress.pushes >= pushes &&
      progress.results >= results &&
      progress.echoes >= echoes
    ) {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function pass(computers, windowWorker, scenario, scale, drainTimeoutMs) {
  const [host, controller] = computers;
  const [hostRan, controllerRan] = await Promise.all([
    host.call('run', { scale }),
    controller.call('run', { scale }),
  ]);
  const { probesSent } = await controller.call('stop-probes');
  // A push the session refused never arrives, so the sample is not valid.
  if (hostRan.rejected > 0) {
    throw new Error(
      `The host's session refused ${String(hostRan.rejected)} of ${String(hostRan.sent + hostRan.rejected)} pushes.`,
    );
  }
  const expectedResults =
    scenario.pages === undefined
      ? 0
      : Math.max(1, Math.round(scenario.pages * scale));
  // A pass that sent nothing measured nothing.
  if (hostRan.sent + expectedResults + probesSent === 0) {
    throw new Error('The pass sent no pushes, pages or probes.');
  }
  const drained = await drain(
    windowWorker,
    { pushes: hostRan.sent, results: expectedResults, echoes: probesSent },
    drainTimeoutMs,
  );
  return {
    drained,
    sent: hostRan.sent,
    probesSent,
    scheduleLagMs: hostRan.scheduleLagMs,
    controllerRan,
  };
}

export async function runSample({
  computerBundle,
  scenario: scenarioName,
  seed,
  warmupScale = 0.2,
  drainTimeoutMs = 60_000,
}) {
  const scenario = Object.hasOwn(SCENARIOS, scenarioName)
    ? SCENARIOS[scenarioName]
    : undefined;
  if (!scenario) throw new Error(`Unknown scenario ${String(scenarioName)}`);
  const host = startWorker(computerBundle, {
    role: 'host',
    scenario: scenarioName,
    seed,
  });
  const controller = startWorker(computerBundle, {
    role: 'controller',
    scenario: scenarioName,
    seed,
  });
  const windowWorker = startWorker(path.join(here, 'window.mjs'), {});
  const workers = [host, controller, windowWorker];
  try {
    await withTimeout(
      Promise.all([host.identityReady, controller.identityReady]),
      30_000,
      'worker identities',
    );
    const relay = new MessageChannel();
    const window = new MessageChannel();
    await windowWorker.call('attach', { windowPort: window.port2 }, [
      window.port2,
    ]);
    await host.call(
      'attach',
      { relayPort: relay.port1, peer: controller.identity },
      [relay.port1],
    );
    await controller.call(
      'attach',
      {
        relayPort: relay.port2,
        windowPort: window.port1,
        peer: host.identity,
      },
      [relay.port2, window.port1],
    );
    await withTimeout(
      Promise.all([host.connected, controller.connected]),
      30_000,
      'session handshake',
    );

    const warmup = await pass(
      [host, controller],
      windowWorker,
      scenario,
      warmupScale,
      drainTimeoutMs,
    );
    if (!warmup.drained) throw new Error('The warm-up pass did not drain.');

    await Promise.all(workers.map((worker) => worker.call('measure-start')));
    const measured = await pass(
      [host, controller],
      windowWorker,
      scenario,
      1,
      drainTimeoutMs,
    );
    const [hostMetrics, controllerMetrics, windowSamples] = await Promise.all(
      workers.map((worker) => worker.call('measure-stop')),
    );
    await Promise.all([host.call('close'), controller.call('close')]);
    return {
      scenario: scenarioName,
      drained: measured.drained,
      pushesSent: measured.sent,
      probesSent: measured.probesSent,
      scheduleLagMs: measured.scheduleLagMs,
      host: hostMetrics.metrics,
      controller: controllerMetrics.metrics,
      window: windowSamples.samples,
    };
  } finally {
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(process.argv[2] ?? '{}');
  runSample(config)
    .then((result) => {
      process.stdout.write(
        `${SAMPLE_RESULT_PREFIX}${JSON.stringify(result)}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
