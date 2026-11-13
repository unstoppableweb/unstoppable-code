import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';

export const PEER_SECRET = 'socket-peer-secret';
export const PEER_AUTH = { secret: PEER_SECRET, dataRootHash: 'a'.repeat(64) };
/** Set on both ends; fits the shared suite's 6 MiB stream frames. */
export const PEER_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Bounded, so a missed settle fails an assertion instead of the Jest timeout. */
export async function within<T>(promise: Promise<T>): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, 2_000, 'timeout');
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** `auth` runs the server handshake; `silent` never writes; `drop` hangs up. */
export type PeerScript = 'auth' | 'silent' | 'drop';
export interface SocketPeer {
  readonly kind: 'socket' | 'pipe';
  readonly path: string;
  /** Raw sockets accepted so far, open or closed. */
  readonly accepted: readonly Socket[];
  /** The next server connection to finish its handshake. */
  next(): Promise<CanopyFramedConnection>;
  /** Waits for every accepted socket to close; bounded by the test timeout. */
  allClosed(): Promise<boolean>;
  close(): Promise<void>;
}

/** A scripted core on a short Unix socket path, or a named pipe on Windows. */
export async function listenSocketPeer(
  script: PeerScript = 'auth',
): Promise<SocketPeer> {
  const kind = process.platform === 'win32' ? 'pipe' : 'socket';
  // macOS caps socket paths near 104 bytes; the default tmpdir can exceed it.
  const dir = kind === 'socket' ? mkdtempSync('/tmp/ccn-') : undefined;
  const path = dir ? join(dir, 's') : `\\\\.\\pipe\\ccn-${randomUUID()}`;
  const accepted: Socket[] = [];
  const ready: Promise<CanopyFramedConnection>[] = [];
  const awaitingClose = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.on('error', () => {});
    if (script === 'drop') socket.destroy();
    // Drain writes so a silent peer can observe EOF without replying.
    if (script === 'silent') socket.resume();
    if (script !== 'auth') return;
    const connection = createCanopyFramedConnection(socket, {
      role: 'server',
      auth: PEER_AUTH,
      maxFrameBytes: PEER_MAX_FRAME_BYTES,
    });
    connection.catch(() => {});
    ready.push(connection);
  });
  server.listen(path);
  await once(server, 'listening');
  const closed = (socket: Socket): Promise<unknown> =>
    socket.closed ? Promise.resolve() : once(socket, 'close');
  return {
    kind,
    path,
    accepted,
    async next(): Promise<CanopyFramedConnection> {
      for (let i = 0; i < 400 && !ready.length; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const connection = ready.shift();
      if (!connection) throw new Error('No connection was accepted.');
      return connection;
    },
    async allClosed(): Promise<boolean> {
      await Promise.all(
        accepted.map((socket) => {
          awaitingClose.add(socket);
          return closed(socket).finally(() => awaitingClose.delete(socket));
        }),
      );
      return true;
    },
    async close(): Promise<void> {
      // After a Jest timeout, report the sockets allClosed() was waiting for.
      const leaked = [...awaitingClose]
        .filter((socket) => !socket.closed)
        .map((socket) => ({
          destroyed: socket.destroyed,
          readableEnded: socket.readableEnded,
          writableEnded: socket.writableEnded,
          bytesRead: socket.bytesRead,
          bytesWritten: socket.bytesWritten,
        }));
      accepted.forEach((socket) => socket.destroy());
      server.close();
      await Promise.all([once(server, 'close'), ...accepted.map(closed)]);
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (leaked.length > 0) {
        throw new Error(
          `Socket peer teardown while allClosed() was still waiting: ${JSON.stringify(leaked)}`,
        );
      }
    },
  };
}
