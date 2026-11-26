/**
 * The controlling computer's window in the Remote Control workload
 * (CAN-7754). It receives every push and invoke result the controller
 * structured-clones to it, the way the remote window's renderer does, and
 * records when each one arrived: a push against the host's send time, a
 * keystroke echo against the controller's write, and a transcript page
 * against the start of its invoke. All three threads share one clock.
 */
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';

const now = () => performance.timeOrigin + performance.now();

let samples = null;

function reset() {
  samples = {
    pushLatencyMs: [],
    echoLatencyMs: [],
    transcriptPageMs: [],
    pushes: 0,
    results: 0,
  };
}
reset();

function sentAt(args) {
  const [first] = args;
  if (!first || typeof first !== 'object') return null;
  if (typeof first.canopyPerfEchoSentAtMs === 'number') {
    return { kind: 'echo', atMs: first.canopyPerfEchoSentAtMs };
  }
  if (typeof first.canopyPerfSentAtMs === 'number') {
    return { kind: 'push', atMs: first.canopyPerfSentAtMs };
  }
  const stamped = first.data?.canopy_perf_sent_at_ms;
  return typeof stamped === 'number' ? { kind: 'push', atMs: stamped } : null;
}

function receive(message) {
  const arrivedAtMs = now();
  if (message.kind === 'result') {
    samples.results += 1;
    samples.transcriptPageMs.push(arrivedAtMs - message.startedAtMs);
    return;
  }
  const stamp = sentAt(message.args);
  if (stamp === null) return;
  // All threads share one clock, so a negative latency is a harness error;
  // throwing fails the sample.
  if (arrivedAtMs < stamp.atMs) {
    throw new Error(`A ${stamp.kind} arrived before its recorded send time.`);
  }
  if (stamp.kind === 'echo') {
    samples.echoLatencyMs.push(arrivedAtMs - stamp.atMs);
  } else {
    samples.pushes += 1;
    samples.pushLatencyMs.push(arrivedAtMs - stamp.atMs);
  }
}

parentPort.on('message', (message) => {
  switch (message.type) {
    case 'attach':
      message.windowPort.on('message', receive);
      parentPort.postMessage({ type: 'attached', id: message.id });
      break;
    case 'measure-start':
      reset();
      parentPort.postMessage({ type: 'measure-started', id: message.id });
      break;
    case 'progress':
      parentPort.postMessage({
        type: 'progress',
        id: message.id,
        pushes: samples.pushes,
        results: samples.results,
        echoes: samples.echoLatencyMs.length,
      });
      break;
    case 'measure-stop':
      parentPort.postMessage({
        type: 'measured',
        id: message.id,
        samples,
      });
      break;
    default:
      parentPort.postMessage({
        type: 'error',
        id: message.id,
        message: `Unknown message ${String(message.type)}`,
      });
  }
});
