import { execFile } from 'node:child_process';
import { access, readFile, readdir, readlink } from 'node:fs/promises';
import { isIPv4, type Server } from 'node:net';
import { join } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  DEFAULT_MCP_PROXY_PORT,
  DEFAULT_OLLAMA_SERVER_PORT,
} from '@canopy/desktop-shared/types';

/**
 * Canopy's own loopback listeners, and which process holds a loopback port.
 *
 * Two uses: the account proxy trusts a port only once its own child holds
 * it, and Remote Control web preview (CAN-7679) refuses to tunnel a paired
 * computer to any listener a Canopy process holds. The second needs two
 * checks:
 *
 * - A deny registry, kept before a port is bound: main reserves a port as
 *   soon as it picks one, whether it binds it or hands it to a child, and a
 *   listener on port 0 registers once it is listening. The default MCP
 *   proxy and managed Ollama ports are always in it.
 * - An owner lookup from the tools each OS ships, run after a tunnel's dial
 *   connected. Children of Canopy terminals and scripts are other
 *   processes, so a dev server started there is not Canopy's.
 *
 * The owner lookup keeps these invariants:
 *
 * 1. It identifies exactly the socket that accepted this dial: the row
 *    whose local end is the dialed address and port and whose remote end is
 *    the dial's own address and port, in that address family. Never
 *    whoever listens on the port now, except a connection still in a
 *    Linux accept queue, which can only be its queueing listener's.
 * 2. It fails closed. More than one candidate socket, no visible holder, a
 *    failed or timed-out command, an unreadable table or an aborted lookup
 *    are all `unknown`, which callers refuse. Where candidates are held by
 *    several processes, any Canopy one makes it `canopy`. Only a lookup
 *    tool that is absent (ENOENT) makes it `unavailable`, leaving the deny
 *    registry alone. A denial may be reused for the same port for 5 s; an
 *    admission never is.
 * 3. It honours its caller's abort signal at every step, the port and
 *    process sources, the /proc scan and the command it runs. It settles
 *    only once all the work it started has, every source included even
 *    after one fails, and the tunnel dialer holds the open's stream slot
 *    until then.
 * 4. Per OS:
 *    - Linux reads /proc/net/tcp and tcp6, an IPv4 address appearing in
 *      tcp6 as `::ffff:` mapped when a dual-stack listener accepted it, and
 *      matches the row's inode against the descriptors in /proc/<pid>/fd,
 *      Canopy's processes first. A row with inode 0 is queued only when
 *      established; the listener then must share its address (or be the
 *      wildcard) in the same table.
 *    - macOS runs lsof on the dial's own port and matches the exact
 *      `<address>:<port>-><peer>:<peerPort>` name, IPv6 in brackets, in
 *      the established and half-closed states. lsof can't show a queued
 *      connection, so it tries up to four times before answering empty.
 *    - Windows runs netstat -ano and matches the exact local and foreign
 *      endpoints, by the same rules and tries.
 */

// ---------------------------------------------------------------------------
// Deny registry
// ---------------------------------------------------------------------------

const FIXED_CANOPY_PORTS: ReadonlySet<number> = new Set([
  DEFAULT_MCP_PROXY_PORT,
  DEFAULT_OLLAMA_SERVER_PORT,
]);

/** One reservation; a port reserved twice needs two releases. */
type Reservation = symbol;

/** Reservations per port. */
const reservedPorts = new Map<number, Set<Reservation>>();

function release(port: number, reservation: Reservation): void {
  const reservations = reservedPorts.get(port);
  if (!reservations) return;
  reservations.delete(reservation);
  if (reservations.size === 0) reservedPorts.delete(port);
}

/**
 * Marks `port` as Canopy's until the returned release runs. Reserve before
 * binding or before handing the port to a child; release once the listener
 * closed or the child exited. Releasing twice is harmless. A process
 * nothing watches, such as an account proxy an earlier run left, is named
 * by a port source instead (`registerCanopyPorts`), which can confirm it is
 * still that process each time.
 */
export function reserveLoopbackPort(port: number): () => void {
  const reservation: Reservation = Symbol('reservation');
  const reservations = reservedPorts.get(port) ?? new Set<Reservation>();
  reservations.add(reservation);
  reservedPorts.set(port, reservations);
  return () => release(port, reservation);
}

/**
 * Reserves `server`'s port from the moment it listens until it closes, for
 * listeners bound to port 0 that learn their port only then. Call before
 * `listen`.
 */
export function reserveServerPort(server: Server): void {
  server.once('listening', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') return;
    server.once('close', reserveLoopbackPort(address.port));
  });
}

/**
 * Lists ports that are Canopy's own; asked after every dial connects. It
 * may stop early once `signal` aborts, as the answer is no longer wanted.
 */
export type CanopyPortSource = (
  signal?: AbortSignal,
) => readonly number[] | Promise<readonly number[]>;

const portSources = new Set<CanopyPortSource>();

/**
 * Adds a source of Canopy's ports that can only be read asynchronously,
 * such as those a process record names. It applies on every platform, with
 * or without an owner lookup. Returns its removal.
 */
export function registerCanopyPorts(source: CanopyPortSource): () => void {
  portSources.add(source);
  return () => portSources.delete(source);
}

/**
 * Every source's list, once all of them have settled, so nothing a source
 * started outlives the lookup that asked; any failure then throws.
 */
async function settledLists(
  sources: ReadonlySet<CanopyPortSource | CanopyProcessSource>,
  signal: AbortSignal | undefined,
): Promise<Array<readonly number[]>> {
  const results = await Promise.allSettled(
    Array.from(sources, (source) =>
      Promise.resolve().then(() => source(signal)),
    ),
  );
  const lists: Array<readonly number[]> = [];
  for (const result of results) {
    if (result.status === 'rejected')
      throw new Error('A source of Canopy ports or processes failed.');
    lists.push(result.value);
  }
  return lists;
}

/** Whether a registered source names `port`; a failing source throws. */
async function sourcedPort(
  port: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const lists = await settledLists(portSources, signal);
  return lists.some((list) => list.includes(port));
}

/** Whether `port` is one of Canopy's own listeners by the deny registry. */
export function isReservedLoopbackPort(port: number): boolean {
  return FIXED_CANOPY_PORTS.has(port) || reservedPorts.has(port);
}

// ---------------------------------------------------------------------------
// Canopy's processes
// ---------------------------------------------------------------------------

/**
 * Lists process ids that are Canopy's own; called on every lookup. It may
 * stop early once `signal` aborts.
 */
export type CanopyProcessSource = (
  signal?: AbortSignal,
) => readonly number[] | Promise<readonly number[]>;

const processSources = new Set<CanopyProcessSource>();

/**
 * Adds a source of Canopy's own processes, such as Electron's utility
 * processes or the core daemon. Returns its removal.
 */
export function registerCanopyProcesses(
  source: CanopyProcessSource,
): () => void {
  processSources.add(source);
  return () => processSources.delete(source);
}

/** Registers one child process, such as the account proxy, until it exits. */
export function registerCanopyProcess(pid: number): () => void {
  return registerCanopyProcesses(() => [pid]);
}

/** This process and every registered one; a failing source throws. */
async function canopyProcessIds(signal?: AbortSignal): Promise<Set<number>> {
  const pids = new Set<number>([process.pid]);
  const lists = await settledLists(processSources, signal);
  for (const list of lists) for (const pid of list) pids.add(pid);
  return pids;
}

// ---------------------------------------------------------------------------
// Which process holds a listener
// ---------------------------------------------------------------------------

/** Inodes of the sockets listening on `port`, from a /proc/net/tcp table. */
export function listeningInodes(table: string, port: number): Set<string> {
  const inodes = new Set<string>();
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1]?.split(':');
    // State 0A is LISTEN.
    if (
      fields[3] === '0A' &&
      local &&
      Number.parseInt(local[1] ?? '', 16) === port
    ) {
      if (fields[9]) inodes.add(fields[9]);
    }
  }
  return inodes;
}

/**
 * A tunnel dial's connection as its own socket sees it: `address:port` is
 * the listener it reached, `peerAddress:peerPort` the dial's own end.
 */
export interface DialedConnection {
  address: string;
  port: number;
  peerAddress: string;
  peerPort: number;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) text = `${text.slice(0, v4.index)}0:0`;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : [];
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (v4) {
    const bytes = v4.slice(1).map(Number);
    groups[6] = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    groups[7] = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  }
  return groups.length === 8 &&
    groups.every(
      (group) => Number.isInteger(group) && group >= 0 && group <= 0xffff,
    )
    ? groups
    : null;
}

/** Bytes as /proc/net/tcp writes an address: each 32-bit word reversed. */
function procWords(bytes: readonly number[]): string {
  let text = '';
  for (let word = 0; word < bytes.length; word += 4)
    for (let index = 3; index >= 0; index -= 1)
      text += (bytes[word + index] ?? 0).toString(16).padStart(2, '0');
  return text.toUpperCase();
}

/**
 * The ways /proc/net/tcp or tcp6 can write `address`: an IPv4 address in
 * tcp, or mapped into tcp6 when a dual-stack listener accepted it.
 */
export function procAddresses(address: string): Set<string> {
  const found = new Set<string>();
  if (isIPv4(address)) {
    const bytes = address.split('.').map(Number);
    found.add(procWords(bytes));
    found.add(
      procWords([...new Array<number>(10).fill(0), 0xff, 0xff, ...bytes]),
    );
    return found;
  }
  const groups = ipv6Groups(address);
  if (groups === null) return found;
  found.add(procWords(groups.flatMap((group) => [group >> 8, group & 0xff])));
  return found;
}

/** One /proc/net/tcp row's fields, or null for a header or a blank line. */
function procRow(line: string): {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  inode: string;
} | null {
  const fields = line.trim().split(/\s+/);
  const local = fields[1]?.split(':');
  const remote = fields[2]?.split(':');
  const state = fields[3];
  const inode = fields[9];
  if (!local?.[0] || !remote?.[0] || !state || !inode) return null;
  return {
    localAddress: local[0].toUpperCase(),
    localPort: Number.parseInt(local[1] ?? '', 16),
    remoteAddress: remote[0].toUpperCase(),
    remotePort: Number.parseInt(remote[1] ?? '', 16),
    state,
    inode,
  };
}

/** Whether a row is the accepting side of `connection`, by its full tuple. */
function isAcceptingRow(
  row: NonNullable<ReturnType<typeof procRow>>,
  connection: DialedConnection,
): boolean {
  return (
    row.localPort === connection.port &&
    row.remotePort === connection.peerPort &&
    procAddresses(connection.address).has(row.localAddress) &&
    procAddresses(connection.peerAddress).has(row.remoteAddress)
  );
}

/**
 * Inodes of the socket on the accepting side of `connection`, matched by
 * its full tuple in a /proc/net/tcp table. An inode of 0 is a socket no
 * process holds: one still in the accept queue, or one closing.
 */
export function acceptedInodes(
  table: string,
  connection: DialedConnection,
): Set<string> {
  const inodes = new Set<string>();
  for (const line of table.split('\n').slice(1)) {
    const row = procRow(line);
    if (row && isAcceptingRow(row, connection)) inodes.add(row.inode);
  }
  return inodes;
}

/**
 * Inodes of the listeners that could hold `connection` in their accept
 * queue, from the same /proc/net/tcp table: on its port, bound to its
 * address or to the wildcard. Empty unless the connection is queued, an
 * established row no process holds yet; a closing one is not.
 */
export function queuedListenerInodes(
  table: string,
  connection: DialedConnection,
): Set<string> {
  const rows = table
    .split('\n')
    .slice(1)
    .map(procRow)
    .filter((row) => row !== null);
  const addresses = new Set<string>();
  for (const row of rows) {
    // State 01 is ESTABLISHED.
    if (
      row.inode === '0' &&
      row.state === '01' &&
      isAcceptingRow(row, connection)
    )
      addresses.add(row.localAddress);
  }
  const inodes = new Set<string>();
  if (addresses.size === 0) return inodes;
  for (const row of rows) {
    // State 0A is LISTEN.
    if (
      row.state === '0A' &&
      row.localPort === connection.port &&
      (addresses.has(row.localAddress) || /^0+$/.test(row.localAddress))
    )
      inodes.add(row.inode);
  }
  return inodes;
}

/**
 * The process ids `netstat -ano` shows listening on TCP `port`, IPv4 and
 * IPv6. Windows translates the state column, so a listener is told apart by
 * its unset foreign address instead of the word LISTENING.
 */
export function netstatListenerPids(output: string, port: number): Set<number> {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (
      fields[0] === 'TCP' &&
      fields[1]?.endsWith(`:${String(port)}`) === true &&
      (fields[2] === '0.0.0.0:0' || fields[2] === '[::]:0')
    ) {
      const pid = Number.parseInt(fields[fields.length - 1] ?? '', 10);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return pids;
}

/**
 * How lsof and netstat write the endpoint `address:port`: IPv6 in
 * brackets, and an IPv4 address also as mapped into IPv6, as a dual-stack
 * listener's socket shows it.
 */
function endpointTexts(address: string, port: number): Set<string> {
  const suffix = `:${String(port)}`;
  return isIPv4(address)
    ? new Set([`${address}${suffix}`, `[::ffff:${address}]${suffix}`])
    : new Set([`[${address}]${suffix}`]);
}

/**
 * The process ids `netstat -ano` shows holding the accepting side of
 * `connection`, by its full tuple.
 */
export function netstatConnectionPids(
  output: string,
  connection: DialedConnection,
): Set<number> {
  const local = endpointTexts(connection.address, connection.port);
  const remote = endpointTexts(connection.peerAddress, connection.peerPort);
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (
      fields[0] === 'TCP' &&
      local.has(fields[1] ?? '') &&
      remote.has(fields[2] ?? '')
    ) {
      const pid = Number.parseInt(fields[fields.length - 1] ?? '', 10);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return pids;
}

/**
 * The process ids in `lsof -F pn` output holding the accepting side of
 * `connection`, whose name reads `<address>:<port>-><peer>:<peerPort>`.
 */
export function lsofConnectionPids(
  output: string,
  connection: DialedConnection,
): Set<number> {
  const local = endpointTexts(connection.address, connection.port);
  const remote = endpointTexts(connection.peerAddress, connection.peerPort);
  const pids = new Set<number>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (!line.startsWith('n')) continue;
    const [localText, remoteText] = line.slice(1).split('->');
    if (
      local.has(localText ?? '') &&
      remote.has(remoteText ?? '') &&
      Number.isSafeInteger(pid) &&
      pid > 0
    )
      pids.add(pid);
  }
  return pids;
}

/** The process ids in `lsof -F p` output. */
export function lsofPids(output: string): Set<number> {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('p')) continue;
    const pid = Number.parseInt(line.slice(1), 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

export type CommandResult =
  | { ok: true; stdout: string }
  /**
   * It ran and exited with this code, such as lsof's 1 for no match or
   * for a file it could not read, with what it printed before that.
   */
  | { ok: false; exitCode: number | null; stdout: string };

/**
 * Runs one of the OS's own tools, named by absolute path, never looked up
 * on PATH. Like the process supervision probes in core-platform, it gets a
 * fixed minimal environment rather than the user's (`getEnhancedEnv`, for
 * user-installed tools), so no loader or locale setting reaches it and its
 * output parses the same everywhere. It settles only once the process has
 * closed, also when `signal` stopped it: Node reports an abort as soon as
 * it signals the process, which may take a while to exit.
 */
function run(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  if (process.env.SystemRoot !== undefined)
    env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve) => {
    let result: CommandResult | null = null;
    let closed = false;
    const settle = (): void => {
      if (result !== null && closed) resolve(result);
    };
    execFile(
      file,
      args,
      {
        env,
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        result = error
          ? {
              ok: false,
              exitCode: typeof error.code === 'number' ? error.code : null,
              stdout,
            }
          : { ok: true, stdout };
        settle();
      },
      // Emitted after the process exited, or after it failed to start.
    ).once('close', () => {
      closed = true;
      settle();
    });
  });
}

export { run as runSystemTool };

const LSOF = '/usr/sbin/lsof';

function netstatPath(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'netstat.exe',
  );
}

/** The socket inodes `pid` holds; null when its descriptors can't be read. */
async function socketInodesOf(pid: number): Promise<Set<string> | null> {
  const fdDir = `/proc/${String(pid)}/fd`;
  let fds: string[];
  try {
    fds = await readdir(fdDir);
  } catch {
    return null;
  }
  const links = await Promise.all(
    fds.map((fd) => readlink(join(fdDir, fd)).catch(() => '')),
  );
  const inodes = new Set<string>();
  for (const link of links) {
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode !== undefined) inodes.add(inode);
  }
  return inodes;
}

/** Processes whose descriptors one step of the /proc scan reads at once. */
const PROC_SCAN_BATCH = 32;

/**
 * Linux: holders of the listener on `port`, looking at `preferred` first.
 * Stops at the first preferred holder, or else at the first other one; an
 * empty set means no readable process holds it (another user's, or a
 * process that does not let its descriptors be read).
 */
async function linuxHolders(
  port: number,
  preferred: ReadonlySet<number>,
  connection?: DialedConnection,
  signal?: AbortSignal,
): Promise<Set<number> | null> {
  // A table that isn't there (tcp6 without IPv6) is skipped; one that
  // can't be read fails the lookup.
  const read = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) =>
      readFile(file, 'utf8').then(
        (table): string | null => table,
        (error: unknown): string | null | undefined =>
          isMissingFileError(error) ? null : undefined,
      ),
    ),
  );
  if (read.some((table) => table === undefined)) return null;
  const tables = read.filter((table) => typeof table === 'string');
  if (tables.length === 0) return null;
  const collect = (select: (table: string) => Set<string>): Set<string> => {
    const found = new Set<string>();
    for (const table of tables) select(table).forEach((i) => found.add(i));
    return found;
  };
  let inodes: Set<string>;
  if (connection === undefined) {
    inodes = collect((table) => listeningInodes(table, port));
  } else {
    const accepted = collect((table) => acceptedInodes(table, connection));
    accepted.delete('0');
    // One tuple names one socket; more is a table that can't be trusted.
    if (accepted.size > 1) return new Set();
    // Not accepted yet, the connection waits in the queue of the listener
    // that took it, the one on its address and family; closing that
    // listener resets it.
    inodes =
      accepted.size > 0
        ? accepted
        : collect((table) => queuedListenerInodes(table, connection));
  }
  if (inodes.size === 0) return new Set();
  const holds = async (pid: number): Promise<boolean> => {
    const held = await socketInodesOf(pid);
    return held !== null && Array.from(inodes).some((inode) => held.has(inode));
  };
  const found = new Set<number>();
  for (const pid of preferred) {
    if (signal?.aborted === true) return null;
    if (await holds(pid)) found.add(pid);
  }
  if (found.size > 0) return found;
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return null;
  }
  const others = entries
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => !preferred.has(pid));
  for (let start = 0; start < others.length; start += PROC_SCAN_BATCH) {
    if (signal?.aborted === true) return null;
    const batch = others.slice(start, start + PROC_SCAN_BATCH);
    const held = await Promise.all(batch.map(holds));
    const holder = batch.find((_, index) => held[index]);
    if (holder !== undefined) return new Set([holder]);
  }
  return signal?.aborted === true ? null : found;
}

/**
 * The processes holding the listener on loopback `port`, or null when the
 * lookup failed. If any `preferred` process holds it the result names it;
 * otherwise it names at least one other holder when one is visible.
 */
export async function listenerHolders(
  port: number,
  preferred: ReadonlySet<number> = new Set(),
): Promise<Set<number> | null> {
  const os = hostPlatformOperatingSystem();
  if (os === 'linux') return linuxHolders(port, preferred);
  if (os === 'darwin') {
    const result = await run(LSOF, [
      '-nP',
      `-iTCP:${String(port)}`,
      '-sTCP:LISTEN',
      '-Fp',
    ]);
    if (result.ok) return lsofPids(result.stdout);
    // lsof exits 1, printing nothing, when no process it can see matches.
    return result.exitCode === 1 ? new Set() : null;
  }
  if (os === 'win32') {
    const result = await run(netstatPath(), ['-ano']);
    return result.ok ? netstatListenerPids(result.stdout, port) : null;
  }
  return null;
}

/**
 * Tries of a connection lookup that finds no holder, as a server that has
 * not accepted the connection yet has none. Each lsof or netstat run takes
 * tens of milliseconds or more, which spaces the tries without a timer.
 */
const CONNECTION_LOOKUP_TRIES = 4;

/**
 * The processes holding the accepting side of `connection`, a tunnel
 * dial's, or null when the lookup failed or `signal` aborted it. The
 * connection is told by its own socket, matched by its full tuple, so a
 * listener that closed and another process that took its port can't be
 * confused. On Linux one still in the accept queue, which no process holds
 * yet, is the queueing listener's. lsof and netstat can't show which
 * listener queued a connection, so there the lookup tries again a few
 * times and an empty result, refused by callers, means no holder appeared.
 */
export async function connectionHolders(
  connection: DialedConnection,
  preferred: ReadonlySet<number> = new Set(),
  signal?: AbortSignal,
): Promise<Set<number> | null> {
  const os = hostPlatformOperatingSystem();
  if (os === 'linux')
    return linuxHolders(connection.port, preferred, connection, signal);
  const once = async (): Promise<Set<number> | null> => {
    if (os === 'darwin') {
      const result = await run(
        LSOF,
        [
          '-nP',
          `-iTCP:${String(connection.peerPort)}`,
          // The accepting side, including a server that half-closed at once.
          '-sTCP:ESTABLISHED,FIN_WAIT_1,FIN_WAIT_2,CLOSE_WAIT',
          '-Fpn',
        ],
        signal,
      );
      // lsof exits 1 when nothing matched, and also after a file it could
      // not read; a match it printed is still that socket's.
      if (result.ok || result.exitCode === 1)
        return lsofConnectionPids(result.stdout, connection);
      return null;
    }
    if (os === 'win32') {
      const result = await run(netstatPath(), ['-ano'], signal);
      return result.ok
        ? netstatConnectionPids(result.stdout, connection)
        : null;
    }
    return null;
  };
  for (let tries = 0; tries < CONNECTION_LOOKUP_TRIES; tries += 1) {
    const holders = await once();
    if (signal?.aborted === true) return null;
    if (holders === null || holders.size > 0) return holders;
  }
  return new Set();
}

/** Whether `pid` holds the listening socket on loopback `port`. */
export async function pidOwnsLoopbackListener(
  pid: number,
  port: number,
): Promise<boolean> {
  return (await listenerHolders(port, new Set([pid])))?.has(pid) ?? false;
}

let lookupAvailability: Promise<boolean> | null = null;

function isMissingFileError(error: unknown): boolean {
  // Read structurally: Node's own errors may come from another realm.
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/**
 * Whether this platform can look up a listener's process at all: /proc on
 * Linux, lsof on macOS, netstat on Windows. Checked once.
 */
export function loopbackOwnerLookupAvailable(): Promise<boolean> {
  lookupAvailability ??= (async (): Promise<boolean> => {
    const os = hostPlatformOperatingSystem();
    const probe =
      os === 'linux'
        ? '/proc/net/tcp'
        : os === 'darwin'
          ? LSOF
          : os === 'win32'
            ? netstatPath()
            : null;
    if (probe === null) return false;
    // Only a tool that isn't there makes the lookup unavailable. Any other
    // error, such as one denying access, leaves it available, so each
    // lookup runs, fails and is refused.
    return access(probe).then(
      () => true,
      (error: unknown) => !isMissingFileError(error),
    );
  })();
  return lookupAvailability;
}

/**
 * Who holds a loopback listener a tunnel just connected to:
 *
 * - `canopy`: Canopy main, one of its registered processes, or a port in
 *   the deny registry.
 * - `other`: a process that is not Canopy's, such as a dev server started
 *   in a Canopy terminal.
 * - `unknown`: the lookup failed, timed out or saw no holder. Callers
 *   refuse it: an owner that can't be determined is a denial.
 * - `unavailable`: this platform has no lookup at all; only the deny
 *   registry applies.
 */
export type LoopbackListenerOwner =
  | 'canopy'
  | 'other'
  | 'unknown'
  | 'unavailable';

/** Ports recently found to be Canopy's; only denials are cached. */
const canopyOwnedUntil = new Map<number, number>();
const DENIAL_CACHE_MS = 5_000;

async function lookUpOwner(
  connection: DialedConnection,
  signal: AbortSignal | undefined,
): Promise<LoopbackListenerOwner> {
  const { port } = connection;
  // A caller that gave up gets `unknown` at the next step, unasked.
  const abandoned = (): boolean => signal?.aborted === true;
  try {
    if (await sourcedPort(port, signal)) return 'canopy';
  } catch {
    return 'unknown';
  }
  if (abandoned()) return 'unknown';
  if (!(await loopbackOwnerLookupAvailable())) return 'unavailable';
  let canopy: Set<number>;
  try {
    canopy = await canopyProcessIds(signal);
  } catch {
    return 'unknown';
  }
  if (abandoned()) return 'unknown';
  const holders = await connectionHolders(connection, canopy, signal).catch(
    () => null,
  );
  if (holders === null || holders.size === 0) return 'unknown';
  for (const pid of holders) if (canopy.has(pid)) return 'canopy';
  return 'other';
}

/**
 * Classifies the process holding the accepting side of `connection`, a
 * tunnel dial that just connected; see {@link LoopbackListenerOwner} and
 * the invariants above. `signal` stops the lookup's work, including the
 * tools it runs, and answers `unknown`.
 */
export async function loopbackListenerOwner(
  connection: DialedConnection,
  signal?: AbortSignal,
): Promise<LoopbackListenerOwner> {
  const { port } = connection;
  if (isReservedLoopbackPort(port)) return 'canopy';
  const cachedUntil = canopyOwnedUntil.get(port);
  if (cachedUntil !== undefined) {
    if (cachedUntil > Date.now()) return 'canopy';
    canopyOwnedUntil.delete(port);
  }
  const owner = await lookUpOwner(connection, signal);
  if (owner === 'canopy')
    canopyOwnedUntil.set(port, Date.now() + DENIAL_CACHE_MS);
  return owner;
}

/** Forgets cached denials, so one test's closed listener can't refuse the next's. */
export function resetLoopbackListenerOwnersForTests(): void {
  canopyOwnedUntil.clear();
}
