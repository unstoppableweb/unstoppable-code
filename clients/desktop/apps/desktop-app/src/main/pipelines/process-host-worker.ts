import {
  connectExecutionHostChannel,
  type ExecutionHostChannel,
} from '@canopy/desktop-shared/node/execution-host/channel';
import type { SpawnedProcessOutputGate } from '@canopy/execution-engine/node/pipelines/executor/spawned-process';
import { runSpawnedProcessLocally } from '@canopy/execution-engine/node/pipelines/executor/spawned-process';
import { e2eReplayGateFactory } from './e2e-replay-gate';
import type {
  PipelineProcessHostRequest,
  PipelineProcessHostResponse,
} from './process-host-protocol';

const OUTPUT_BATCH_BYTES = 64 * 1024;
const OUTPUT_BATCH_DELAY_MS = 16;

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

interface OutputChunk {
  stream: 'stdout' | 'stderr';
  /**
   * Pending bytes as the appended pieces, joined only when a message is
   * sent. Concatenating on every append copied the whole pending batch each
   * time, so many small appends cost a batch-sized copy apiece.
   */
  parts: Buffer[];
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequest(value: unknown): value is PipelineProcessHostRequest {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'shutdown') return true;
  return typeof value.requestId === 'string';
}

function createOutputBatcher(
  requestId: string,
  post: (response: PipelineProcessHostResponse) => void,
): {
  append(stream: 'stdout' | 'stderr', data: string): void;
  flush(): void;
} {
  const chunks: OutputChunk[] = [];
  let timer: NodeJS.Timeout | undefined;

  const utf8ChunkEnd = (data: Buffer, maxBytes: number): number => {
    let end = Math.min(data.length, maxBytes);
    if (end === data.length) return end;
    while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
    return end;
  };

  const drain = (flushAll: boolean): void => {
    while (chunks.length > 0) {
      const chunk = chunks[0];
      if (!chunk) return;
      const shouldFlush =
        flushAll || chunk.bytes >= OUTPUT_BATCH_BYTES || chunks.length > 1;
      if (!shouldFlush) return;

      const pending =
        chunk.parts.length === 1
          ? (chunk.parts[0] ?? Buffer.alloc(0))
          : Buffer.concat(chunk.parts, chunk.bytes);
      const end = utf8ChunkEnd(pending, OUTPUT_BATCH_BYTES);
      const data = pending.subarray(0, end);
      if (end === pending.length) {
        chunks.shift();
      } else {
        chunk.parts = [pending.subarray(end)];
        chunk.bytes = pending.length - end;
      }
      post({
        type: 'output',
        requestId,
        stream: chunk.stream,
        data: data.toString('utf8'),
      });
    }
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    drain(true);
  };

  return {
    append(stream, data): void {
      const appended = Buffer.from(data, 'utf8');
      const previous = chunks[chunks.length - 1];
      if (previous?.stream === stream) {
        previous.parts.push(appended);
        previous.bytes += appended.length;
      } else {
        chunks.push({ stream, parts: [appended], bytes: appended.length });
      }
      drain(false);
      if (!timer && chunks.length > 0) {
        timer = setTimeout(flush, OUTPUT_BATCH_DELAY_MS);
        timer.unref?.();
      }
    },
    flush,
  };
}

export function startPipelineProcessHost(
  parentPort: ExecutionHostChannel,
  exitProcess: (code: number) => void = (code) => process.exit(code),
  outputGate?: SpawnedProcessOutputGate,
): { shutdown(): Promise<void> } {
  const active = new Map<string, ActiveRun>();
  const pendingProcessCleanups = new Set<Promise<void>>();
  let shuttingDown = false;
  const post = (response: PipelineProcessHostResponse): void => {
    parentPort.postMessage(response);
  };

  const startRun = (
    request: Extract<PipelineProcessHostRequest, { type: 'run' }>,
  ): void => {
    if (shuttingDown || active.has(request.requestId)) {
      post({
        type: 'error',
        requestId: request.requestId,
        message: shuttingDown
          ? 'Pipeline process host is shutting down.'
          : 'Duplicate pipeline process host request.',
      });
      return;
    }

    const controller = new AbortController();
    const output = createOutputBatcher(request.requestId, post);
    const processCleanups = new Set<Promise<void>>();
    const promise = (async (): Promise<void> => {
      try {
        const replayGate = e2eReplayGateFactory();
        const result = await runSpawnedProcessLocally(request.processSpec, {
          ...request.options,
          ...(replayGate ? { createRecordStore: replayGate } : {}),
          signal: controller.signal,
          ...(outputGate ? { outputGate } : {}),
          onProcessCleanup: (cleanup) => {
            const tracked = cleanup.catch(() => undefined);
            pendingProcessCleanups.add(tracked);
            processCleanups.add(tracked);
            void tracked.finally(() => {
              pendingProcessCleanups.delete(tracked);
              processCleanups.delete(tracked);
            });
          },
          onSpawn: (pid) =>
            post({ type: 'started', requestId: request.requestId, pid }),
          onOutput: (stream, data) => output.append(stream, data),
        });
        output.flush();
        post({ type: 'result', requestId: request.requestId, result });
      } catch (error) {
        output.flush();
        post({
          type: 'error',
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        while (processCleanups.size > 0) {
          await Promise.allSettled(Array.from(processCleanups));
        }
        post({ type: 'cleanup-complete', requestId: request.requestId });
        active.delete(request.requestId);
      }
    })();
    active.set(request.requestId, { controller, promise });
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const run of Array.from(active.values())) run.controller.abort();
    await Promise.allSettled(Array.from(active.values(), (run) => run.promise));
    while (pendingProcessCleanups.size > 0) {
      await Promise.allSettled(Array.from(pendingProcessCleanups));
    }
    post({ type: 'shutdown-complete' });
    exitProcess(0);
  };

  parentPort.on('message', (event: unknown): void => {
    const payload = isRecord(event) && 'data' in event ? event.data : event;
    if (!isRequest(payload)) return;
    if (payload.type === 'run') {
      startRun(payload);
    } else if (payload.type === 'cancel') {
      active.get(payload.requestId)?.controller.abort();
    } else {
      void shutdown();
    }
  });
  return { shutdown };
}

const channel = connectExecutionHostChannel();
if (channel) {
  const host = startPipelineProcessHost(
    channel,
    (code) => channel.exit(code),
    channel,
  );
  // A launcher that can no longer be reached cancels the runs, as shutdown does.
  channel.onDisconnect(() => void host.shutdown());
}
