import type { EventEmitter } from 'node:events';

/** The Linux daemon may outlive the Electron reader of its captured stderr. */
export function absorbClosedStderr(
  stream: Pick<EventEmitter, 'on'>,
  os: string,
): void {
  if (os !== 'linux') return;

  let closedPipe = false;
  stream.on('error', (error: unknown) => {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'EPIPE') {
      closedPipe = true;
      return;
    }
    if (closedPipe && code === 'ERR_STREAM_DESTROYED') return;
    // Preserve the existing uncaught-exception behavior for unrelated errors.
    process.nextTick(() => {
      throw error;
    });
  });
}
