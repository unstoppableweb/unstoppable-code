// A real device relay (apps/device-relay) for Remote Control end-to-end
// specs. Test-only: it runs the production relay entry point on an ephemeral
// loopback port with a freshly generated token secret, and reads the relay's
// own structured logs to report which devices are connected.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { repoRoot } from './harness/config.mjs';

const RELAY_ENTRY = path.join(repoRoot, 'apps/device-relay/src/index.ts');
const CAPPED_RELAY_ENTRY = path.join(
  repoRoot,
  'apps/desktop-app/tests/electron/remote-control/relayCappedEntry.mjs',
);
const SUPERVISOR_ENTRY = path.join(
  repoRoot,
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs',
);
const RELAY_START_TIMEOUT_MS = 30_000;
/** Relay tokens live five minutes in production (DEVICE_RELAY_TOKEN_TTL_MS). */
const TOKEN_TTL_MS = 5 * 60_000;

/** A token secret the relay accepts (at least 32 characters). */
export function generateRelayTokenSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Signs relay token claims exactly as `apps/web/src/lib/device-relay/token.ts`
 * does, for test-driven relay clients that act as a device of an account.
 */
export function signRelayToken({
  secret,
  userExternalId,
  deviceId,
  kind,
  ttlMs = TOKEN_TTL_MS,
}) {
  const expiresAt = Date.now() + ttlMs;
  const encodedClaims = Buffer.from(
    JSON.stringify({
      v: 1,
      userId: userExternalId,
      deviceId,
      expiresAt,
      ...(kind === undefined ? {} : { kind }),
    }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(encodedClaims)
    .digest('base64url');
  return {
    token: `${encodedClaims}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function parseLogLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Starts the relay. Returns its `ws://` URL and secret (pass both to the web
 * server through `directWebServerEnv`), live connection bookkeeping from the
 * relay's logs, and `stop()`. `maxDevicesPerAccount` runs the same server
 * with a lower per-account device cap (see relayCappedEntry.mjs).
 */
export async function startDeviceRelay(options = {}) {
  const secret = options.secret ?? generateRelayTokenSecret();
  const capped = options.maxDevicesPerAccount !== undefined;
  const child = spawn(
    process.execPath,
    [
      SUPERVISOR_ENTRY,
      '--import',
      'tsx',
      capped ? CAPPED_RELAY_ENTRY : RELAY_ENTRY,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: '0',
        DEVICE_RELAY_TOKEN_SECRET: secret,
        ...(capped
          ? {
              CANOPY_E2E_RELAY_MAX_DEVICES_PER_ACCOUNT: String(
                options.maxDevicesPerAccount,
              ),
            }
          : {}),
        CANOPY_E2E_OWNER_PID: String(process.pid),
        CANOPY_E2E_SUPERVISED_EXECUTABLE: process.execPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const connected = new Map();
  /** Every relay connection each device opened, including replacements. */
  const connections = new Map();
  /** Connections refused with `too_many_devices`, per device. */
  const overLimit = new Map();
  const logs = [];
  const listeners = new Set();
  let exited = false;
  let buffered = '';
  let resolvePort;
  const portReady = new Promise((resolve) => {
    resolvePort = resolve;
  });

  const handleEntry = (entry) => {
    const { message, deviceId } = entry;
    if (message === 'device relay listening' && Number.isInteger(entry.port)) {
      resolvePort(entry.port);
    } else if (message === 'device relay device connected') {
      connected.set(deviceId, Date.now());
      connections.set(deviceId, (connections.get(deviceId) ?? 0) + 1);
    } else if (message === 'device relay device disconnected') {
      connected.delete(deviceId);
    } else if (
      message === 'device relay refused a device over the account limit'
    ) {
      overLimit.set(deviceId, (overLimit.get(deviceId) ?? 0) + 1);
    }
    for (const listener of listeners) listener(entry);
  };
  const record = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 2_000) logs.shift();
    if (process.env.CANOPY_PORTAL_E2E_VERBOSE) {
      process.stdout.write(`[relay] ${text}`);
    }
  };
  child.stdout.on('data', (chunk) => {
    record(chunk);
    buffered += chunk.toString();
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const entry = parseLogLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (entry) handleEntry(entry);
      newline = buffered.indexOf('\n');
    }
  });
  child.stderr.on('data', record);
  child.on('exit', () => {
    exited = true;
    resolvePort(null);
  });

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), RELAY_START_TIMEOUT_MS),
  );
  const port = await Promise.race([portReady, timeout]);
  if (port === null) {
    child.kill('SIGKILL');
    throw new Error(`The device relay did not start.\n${logs.join('')}`);
  }

  const relay = {
    port,
    url: `ws://127.0.0.1:${String(port)}`,
    secret,
    getLogs: () => logs.join(''),
    /** Relay device IDs connected right now. */
    connectedDeviceIds: () => new Set(connected.keys()),
    connectionCount: () => connected.size,
    /** How many relay connections `deviceId` has opened so far. */
    connectionsOpenedBy: (deviceId) => connections.get(deviceId) ?? 0,
    /** Devices the relay refused over the account's device cap. */
    refusedOverLimit: () => new Set(overLimit.keys()),
    /** Resolves once `predicate(connectedDeviceIds)` holds. */
    async waitFor(
      predicate,
      { timeoutMs = 30_000, label = 'relay state' } = {},
    ) {
      if (predicate(relay.connectedDeviceIds())) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `Timed out waiting for ${label}; connected=${JSON.stringify([...connected.keys()])}`,
            ),
          );
        }, timeoutMs);
        const listener = () => {
          if (!predicate(relay.connectedDeviceIds())) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
    signToken: (claims) => signRelayToken({ secret, ...claims }),
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return relay;
}
