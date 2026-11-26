import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

/**
 * Real HTTP and WebSocket servers in a child Node process, standing in for a
 * developer's dev server: its listeners belong to another process, as a dev
 * server started in a Canopy terminal does, so web preview's listener-owner
 * check sees a process that is not Canopy's.
 *
 * Routes on `port` (127.0.0.1):
 * - `/stream`: a chunked body sent in three parts 300 ms apart.
 * - `/asset`: `ASSET_BYTES` random bytes; `assetSha256` is their digest.
 * - `/five-mib`: the asset's first `FIVE_MIB_BYTES`, just over the 4 MiB
 *   byte budgets the limit tests set.
 * - `/redirect`: 302 to `http://localhost:<port>/next`.
 * - `/next`: a page that sets two cookies.
 * - `/ws`: a WebSocket that echoes every message.
 * `v6Port` serves `v6 only` on `::1` alone, or is null without IPv6
 * loopback.
 */

export const ASSET_BYTES = 20 * 1024 * 1024;
export const FIVE_MIB_BYTES = 5 * 1024 * 1024;
export const STREAM_PARTS = ['part one\n', 'part two\n', 'part three\n'];
export const STREAM_GAP_MS = 300;
export const NEXT_PAGE = 'the next page';
export const NEXT_COOKIES = [
  'session=7f3a9c; Path=/; HttpOnly; SameSite=Lax',
  'theme=dark; Path=/',
];
export const V6_PAGE = 'v6 only';

const ReadySchema = z.object({
  port: z.number().int().positive(),
  v6Port: z.number().int().positive().nullable(),
  assetSha256: z.string(),
  pid: z.number().int().positive(),
});

export type DevServers = z.infer<typeof ReadySchema> & {
  stop(): Promise<void>;
};

const SCRIPT = `
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { WebSocketServer } = require(process.env.WS_MODULE);
const parts = JSON.parse(process.env.STREAM_PARTS);
const cookies = JSON.parse(process.env.NEXT_COOKIES);
const gap = Number(process.env.STREAM_GAP_MS);
const asset = randomBytes(Number(process.env.ASSET_BYTES));
let port = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    parts.forEach((part, index) => setTimeout(() => {
      if (index === parts.length - 1) res.end(part); else res.write(part);
    }, index * gap));
    return;
  }
  if (req.url === '/asset') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(asset.length),
    });
    res.end(asset);
    return;
  }
  if (req.url === '/five-mib') {
    const part = asset.subarray(0, Number(process.env.FIVE_MIB_BYTES));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(part.length),
    });
    res.end(part);
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://localhost:' + port + '/next' });
    res.end();
    return;
  }
  if (req.url === '/next') {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': cookies });
    res.end(process.env.NEXT_PAGE);
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket) => {
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
});
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  const v6 = http.createServer((req, res) => res.end(process.env.V6_PAGE));
  const ready = (v6Port) => process.stdout.write(JSON.stringify({
    port, v6Port, pid: process.pid,
    assetSha256: createHash('sha256').update(asset).digest('hex'),
  }) + '\\n');
  v6.once('error', () => ready(null));
  v6.listen(0, '::1', () => ready(v6.address().port));
});
process.on('disconnect', () => process.exit(0));
`;

/**
 * Starts the servers and waits until they listen. `args` land on the
 * child's command line, as a proxy's config path does on its own.
 */
export async function startDevServers(
  args: readonly string[] = [],
): Promise<DevServers> {
  const child: ChildProcess = spawn(process.execPath, ['-e', SCRIPT, ...args], {
    env: {
      ...process.env,
      WS_MODULE: require.resolve('ws'),
      ASSET_BYTES: String(ASSET_BYTES),
      FIVE_MIB_BYTES: String(FIVE_MIB_BYTES),
      STREAM_PARTS: JSON.stringify(STREAM_PARTS),
      STREAM_GAP_MS: String(STREAM_GAP_MS),
      NEXT_PAGE,
      NEXT_COOKIES: JSON.stringify(NEXT_COOKIES),
      V6_PAGE,
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const stdout = child.stdout;
  if (!stdout) throw new Error('The dev servers have no output.');
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: stdout });
    lines.once('line', (text) => {
      lines.close();
      resolve(text);
    });
    child.once('exit', (code) =>
      reject(new Error(`The dev servers exited (${String(code)}).`)),
    );
  });
  const ready = ReadySchema.parse(JSON.parse(line));
  return {
    ...ready,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
