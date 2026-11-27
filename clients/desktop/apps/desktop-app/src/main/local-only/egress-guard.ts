/**
 * The egress guard (docs/local-only-build.md). Installed only in a local-only
 * or self-host build (`isEgressGuardedBuild()`); it blocks and logs every
 * outbound request from Electron main and its sessions to a host
 * `egress-policy.ts` does not allow. In a self-host build the policy also
 * allows the configured server's origin and the relay origin it handed out;
 * the Node layer matches those by host and port (a socket carries no
 * scheme), the Chromium layer by scheme family, host and port.
 *
 * Two layers:
 *
 * - **Node.** `net.Socket.prototype.connect` is the one place every TCP and
 *   TLS client connection in main's JavaScript passes through: `http`,
 *   `https`, `ws`, Node's built-in `fetch` (undici), a bundled undici, and
 *   `tls.connect`. `diagnostics_channel` cannot do this job: subscribers to
 *   `net.client.socket` run before the socket has a destination, destroying
 *   the socket there is undone by the following `connect()`, and
 *   `undici:client:beforeConnect` subscribers cannot cancel. Connections
 *   with a `path` (Unix domain sockets and Windows named pipes, which the
 *   daemon uses) are always allowed. A blocked connection fails before DNS
 *   lookup with the error code `CANOPY_LOCAL_ONLY_EGRESS_BLOCKED`.
 * - **Chromium.** `session.webRequest.onBeforeRequest` on every session,
 *   covering `http(s):` and `ws(s):` from renderers and from Electron's
 *   `net` module. Electron keeps one listener per session, and other main
 *   modules own that listener on some sessions (the visual preview session,
 *   browser profiles), so the guard installs its listener first and turns
 *   the session's `onBeforeRequest` into a composer: a later registration
 *   becomes the delegate the guard calls for requests it allows, and can no
 *   longer replace the guard. In-app browser partitions (browsing is user
 *   driven) and the MCP OAuth partition are exempt by partition.
 *
 * Not covered, listed under "Known limits": utility processes, worker
 * threads and child processes (children get environment opt-outs), UDP
 * (`dgram`) and DNS lookups, native addons that open sockets themselves,
 * and Chromium traffic that never reaches `webRequest`. Windows and Linux
 * spellchecking is disabled here to prevent its automatic CDN dictionary
 * downloads; macOS uses the local system spellchecker.
 */
import net from 'node:net';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { basename } from 'node:path';
import {
  app,
  session,
  type CallbackResponse,
  type OnBeforeRequestListenerDetails,
  type Session,
  type WebRequestFilter,
} from 'electron';
import { recordBlockedEgress } from './egress-log';
import {
  evaluateEgressUrl,
  egressPolicySettingsLoaded,
  isEgressHostAllowed,
  loadEgressPolicySettings,
  markEgressPolicyReady,
} from './egress-policy';
import { isEgressGuardedBuild } from './profile';

export const EGRESS_BLOCKED_ERROR_CODE = 'CANOPY_LOCAL_ONLY_EGRESS_BLOCKED';

/** Partition-name prefixes of the in-app browser's persistent sessions. */
const EXEMPT_PERSISTENT_PARTITION_PREFIXES = ['canopy-browser-'] as const;
/**
 * In-memory partitions exempt from the guard. Each must be created through
 * `session.fromPartition`, which is how the guard learns its name:
 * `browser-service.ts` creates `mcp-oauth` that way. A partition set through
 * `webPreferences.partition` stays unnamed and is guarded.
 */
const EXEMPT_IN_MEMORY_PARTITIONS = ['mcp-oauth'] as const;

// ---------------------------------------------------------------------------
// Node layer
// ---------------------------------------------------------------------------

type ConnectTarget =
  | { readonly kind: 'ipc' }
  | {
      readonly kind: 'tcp';
      readonly host: string;
      /** Null when absent or invalid; a null port matches no origin. */
      readonly port: number | null;
    };

/**
 * A connect port: an integer from 1 to 65535, given as a number or a numeric
 * string (undici passes the URL's port as a string). Anything else is null.
 */
export function parseConnectPort(value: unknown): number | null {
  let port: number;
  if (typeof value === 'number') {
    port = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    port = Number(value.trim());
  } else {
    return null;
  }
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function hostFromOptions(options: object): ConnectTarget {
  const path: unknown = Reflect.get(options, 'path');
  if (typeof path === 'string' && path.length > 0) return { kind: 'ipc' };
  const host: unknown = Reflect.get(options, 'host');
  return {
    kind: 'tcp',
    host: typeof host === 'string' && host.length > 0 ? host : 'localhost',
    port: parseConnectPort(Reflect.get(options, 'port')),
  };
}

/**
 * Reads the destination from `Socket#connect` arguments in each of Node's
 * forms: `(options, cb)`, `(path, cb)`, `(port, host, cb)`, and the
 * internal pre-normalized `([options, cb])` that `net.connect` passes.
 */
export function connectTarget(args: readonly unknown[]): ConnectTarget {
  const first = args[0];
  if (Array.isArray(first)) {
    const normalized: unknown = first[0];
    return typeof normalized === 'object' && normalized !== null
      ? hostFromOptions(normalized)
      : { kind: 'tcp', host: 'localhost', port: null };
  }
  if (typeof first === 'object' && first !== null) {
    return hostFromOptions(first);
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    return { kind: 'ipc' };
  }
  const host = args[1];
  return {
    kind: 'tcp',
    host: typeof host === 'string' && host.length > 0 ? host : 'localhost',
    port: parseConnectPort(first),
  };
}

let nodeGuardInstalled = false;

function installNodeGuard(): void {
  if (nodeGuardInstalled) return;
  nodeGuardInstalled = true;
  const prototype = net.Socket.prototype;
  // Read through the property descriptor so the original method is kept as a
  // value to apply with an explicit receiver, never called unbound.
  const originalConnect: unknown = Object.getOwnPropertyDescriptor(
    prototype,
    'connect',
  )?.value;
  if (typeof originalConnect !== 'function') return;
  // Narrowed once here; a hoisted function declaration does not keep it.
  const connect = originalConnect;
  function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    if (
      target.kind === 'tcp' &&
      !isEgressHostAllowed(target.host, target.port)
    ) {
      recordBlockedEgress(target.host, 'node', () => new Error().stack);
      const error = Object.assign(
        new Error(
          `Outbound connection to ${target.host} blocked by this build's network policy.`,
        ),
        { code: EGRESS_BLOCKED_ERROR_CODE },
      );
      process.nextTick(() => {
        this.destroy(error);
      });
      return this;
    }
    Reflect.apply(connect, this, args);
    return this;
  }
  Object.defineProperty(prototype, 'connect', {
    configurable: true,
    writable: true,
    value: guardedConnect,
  });
}

// ---------------------------------------------------------------------------
// Chromium layer
// ---------------------------------------------------------------------------

type RequestCallback = (response: CallbackResponse) => void;
type RequestListener = (
  details: OnBeforeRequestListenerDetails,
  callback: RequestCallback,
) => void;

interface Delegate {
  readonly listener: RequestListener;
  readonly include: readonly RegExp[] | null;
  readonly exclude: readonly RegExp[];
  readonly types: ReadonlySet<string> | null;
}

/**
 * A delegate's `urls` / `excludeUrls` patterns, as a regex where `*` matches
 * any run of characters. This covers what main registers today (no filter,
 * `<all_urls>`, and the browser service's `file:` pattern); it is not
 * Chromium's full match-pattern
 * grammar (no `*.` host or port rules), so a new filtered registration on a
 * guarded session must keep to that subset.
 */
function matchPattern(pattern: string): RegExp {
  if (pattern === '<all_urls>') return /^/;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function isWebRequestFilter(value: unknown): value is WebRequestFilter {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'urls'))
  );
}

function isRequestListener(value: unknown): value is RequestListener {
  return typeof value === 'function';
}

function delegateFrom(args: readonly unknown[]): Delegate | null {
  const [first, second] = args;
  if (isRequestListener(first)) {
    return { listener: first, include: null, exclude: [], types: null };
  }
  if (isWebRequestFilter(first) && isRequestListener(second)) {
    return {
      listener: second,
      include: first.urls.map(matchPattern),
      exclude: (first.excludeUrls ?? []).map(matchPattern),
      types: first.types ? new Set(first.types) : null,
    };
  }
  return null;
}

function delegateMatches(
  delegate: Delegate,
  details: OnBeforeRequestListenerDetails,
): boolean {
  if (delegate.types && !delegate.types.has(details.resourceType)) return false;
  if (delegate.exclude.some((re) => re.test(details.url))) return false;
  return delegate.include === null
    ? true
    : delegate.include.some((re) => re.test(details.url));
}

const sessionLabels = new WeakMap<Session, string>();
/**
 * Partition names of in-memory sessions, recorded as `session.fromPartition`
 * returns them. An in-memory session has no `storagePath` to name it, and
 * asking `fromPartition` afterwards would create the partition if it did not
 * exist yet.
 */
const inMemoryPartitions = new WeakMap<Session, string>();

function recordInMemoryPartitions(): void {
  const fromPartition = session.fromPartition.bind(session);
  Object.defineProperty(session, 'fromPartition', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof session.fromPartition>): Session => {
      const created = fromPartition(...args);
      if (!created.storagePath) inMemoryPartitions.set(created, args[0]);
      return created;
    },
  });
}

/** `renderer`, `main-net`, or `session:<partition>`. */
function sessionLabel(target: Session): string {
  const cached = sessionLabels.get(target);
  if (cached !== undefined) return cached;
  let label: string;
  if (target === session.defaultSession) {
    label = 'default';
  } else {
    const storagePath = target.storagePath;
    label = storagePath
      ? `session:${basename(storagePath)}`
      : `session:${inMemoryPartitions.get(target) ?? 'in-memory'}`;
  }
  sessionLabels.set(target, label);
  return label;
}

function isExemptSession(label: string): boolean {
  if (!label.startsWith('session:')) return false;
  const partition = label.slice('session:'.length);
  return (
    EXEMPT_PERSISTENT_PARTITION_PREFIXES.some((prefix) =>
      partition.startsWith(prefix),
    ) || EXEMPT_IN_MEMORY_PARTITIONS.some((name) => name === partition)
  );
}

function sourceFor(
  label: string,
  details: OnBeforeRequestListenerDetails,
): string {
  if (label !== 'default') return label;
  return details.webContentsId === undefined ? 'main-net' : 'renderer';
}

const guardedSessions = new WeakSet<Session>();
/** Loopback discard port: a dictionary download pointed here goes nowhere. */
const SPELLCHECK_DICTIONARY_BLACKHOLE_URL = 'http://127.0.0.1:9/';

function guardSession(target: Session): void {
  if (guardedSessions.has(target)) return;
  guardedSessions.add(target);
  // Hunspell downloads bypass webRequest, so the request guard cannot stop
  // them. macOS uses its system dictionaries without a network download.
  // Exempt browser partitions too: the download is automatic, not browsing.
  // The loopback URL catches a download Chromium began before this ran.
  if (hostOperatingSystem() !== 'darwin') {
    target.setSpellCheckerDictionaryDownloadURL(
      SPELLCHECK_DICTIONARY_BLACKHOLE_URL,
    );
    target.spellCheckerEnabled = false;
  }
  const webRequest = target.webRequest;
  const register = webRequest.onBeforeRequest.bind(webRequest);
  let delegate: Delegate | null = null;

  register((details, callback: RequestCallback) => {
    const label = sessionLabel(target);
    if (!isExemptSession(label)) {
      const decision = evaluateEgressUrl(details.url);
      if (!decision.allowed) {
        recordBlockedEgress(decision.host, sourceFor(label, details));
        callback({ cancel: true });
        return;
      }
    }
    if (delegate && delegateMatches(delegate, details)) {
      delegate.listener(details, callback);
      return;
    }
    callback({});
  });

  // Later registrations compose behind the guard instead of replacing it.
  Object.defineProperty(webRequest, 'onBeforeRequest', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]): void => {
      delegate = delegateFrom(args);
    },
  });
}

let installed = false;

/**
 * Installs the guard when the profile is on. Call at the top of main's
 * entry, before any module that can open a connection initializes. The
 * session hook is registered before `ready`; the default session is guarded
 * once the app is ready, which also ends the policy's fail-closed window.
 * `local-only.json` is read as soon as main's entry module has evaluated, so
 * at ready it is normally loaded and the window ends in the same tick as
 * before; only a read still running then holds the window open until it
 * finishes.
 */
export function installLocalOnlyEgressGuard(): void {
  if (installed || !isEgressGuardedBuild()) return;
  installed = true;
  installNodeGuard();
  recordInMemoryPartitions();
  app.on('session-created', (created) => {
    guardSession(created);
  });
  // After main's entry module has evaluated, so the data directory is final.
  const settingsLoaded = new Promise<void>((resolve) => {
    setImmediate(() => {
      void loadEgressPolicySettings().then(resolve);
    });
  });
  void app.whenReady().then((): void => {
    guardSession(session.defaultSession);
    // Synchronously when the read is done, so other `whenReady` work that
    // connects to an allowed host is not refused while a promise settles.
    if (egressPolicySettingsLoaded()) {
      markEgressPolicyReady();
    } else {
      void settingsLoaded.then(markEgressPolicyReady);
    }
  });
}
