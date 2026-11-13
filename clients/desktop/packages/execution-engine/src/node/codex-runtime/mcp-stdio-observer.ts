import type { Readable } from 'node:stream';
import type { McpAvailabilityObserver } from './mcp-availability-observer';

const MAX_OBSERVED_FRAME_BYTES = 2 * 1024 * 1024;

/** Observe bounded metadata independently of the raw, backpressured transport. */
export function observeMcpStdio(options: {
  input: Readable;
  upstreamOutput: Readable;
  observer: McpAvailabilityObserver;
  signal: AbortSignal;
}): void {
  const { input, upstreamOutput, observer, signal } = options;
  let closed = false;
  let releaseInput = (): void => {};
  let releaseOutput = (): void => {};
  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseInput();
    releaseOutput();
    upstreamOutput.removeListener('end', close);
    upstreamOutput.removeListener('close', close);
    signal.removeEventListener('abort', close);
    observer.close();
  };
  const watch = (
    source: Readable,
    receive: (value: unknown) => void,
  ): (() => void) => {
    let parts: Buffer[] = [];
    let bytes = 0;
    const endFrame = (): void => {
      if (!bytes) return;
      const frame = Buffer.concat(parts, bytes);
      parts = [];
      bytes = 0;
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'));
        receive(value);
      } catch {
        // Incomplete observation cannot establish readiness, but must not affect delivery.
        close();
      }
    };
    const data = (chunk: Buffer): void => {
      let offset = 0;
      while (!closed && offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        if (bytes + end - offset > MAX_OBSERVED_FRAME_BYTES) {
          // Stop attesting readiness, just as the HTTP observer does on overflow.
          // The caller's raw pipes keep forwarding every byte.
          close();
          return;
        }
        parts.push(Buffer.from(chunk.subarray(offset, end)));
        bytes += end - offset;
        offset = end;
        if (newline >= 0) endFrame();
      }
    };
    source.on('data', data);
    source.once('end', endFrame);
    return (): void => {
      source.removeListener('data', data);
      source.removeListener('end', endFrame);
      parts = [];
      bytes = 0;
    };
  };
  if (signal.aborted) return close();
  releaseInput = watch(input, (value) => observer.request(value));
  releaseOutput = watch(upstreamOutput, (value) => observer.response(value));
  upstreamOutput.once('end', close);
  upstreamOutput.once('close', close);
  signal.addEventListener('abort', close, { once: true });
}
