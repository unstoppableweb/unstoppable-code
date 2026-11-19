// Test-only hosted and browser controllers that speak the real Remote Control
// protocol (`@canopy/remote-session`) to a real desktop through the real
// relay. They let a spec present exactly the credentials the hosted service
// or a browser owner would, and
// then deliberately misuse them (forbidden channels, expired delegations,
// another account's computer) to prove the desktop and relay refuse. Nothing
// here is reachable from production code.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { REMOTE_PROTOCOL_VERSION } from '@canopy/protocol/remote-control';
import {
  createWebSocketRelaySocketFactory,
  generateDeviceIdentity,
  importDeviceIdentityPkcs8,
  pairWithHost,
  RelayClient,
  RemoteControllerConnection,
  RemoteSessionManager,
  signHostedDelegation,
} from '@canopy/remote-session';
import { withPortalDbClient } from './harness/db.mjs';

/** The harness web server's SECRET_ENCRYPTION_KEY_V1 (see web-server.mjs). */
const HARNESS_MASTER_KEY = Buffer.alloc(32, 1);
const AAD_FIELD_SEPARATOR = '\u001f';
const RELAY_READY_TIMEOUT_MS = 15_000;

export const HOSTED_TEST_CONTROLLER = {
  kind: 'hosted',
  version: { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion: 'hosted' },
  minVersion: REMOTE_PROTOCOL_VERSION,
};

/**
 * Opens an envelope sealed by `apps/web/src/lib/crypto/envelope-encryption.ts`
 * with the harness's deterministic test key: salt(16) | nonce(12) | tag(16) |
 * ciphertext, AES-256-GCM under HKDF(master, salt, `${version}<US>${aad}`).
 */
function openHarnessEnvelope(envelope, keyVersion, aad) {
  const bytes = Buffer.from(envelope, 'base64');
  const salt = bytes.subarray(0, 16);
  const nonce = bytes.subarray(16, 28);
  const tag = bytes.subarray(28, 44);
  const ciphertext = bytes.subarray(44);
  const dataKey = Buffer.from(
    hkdfSync(
      'sha256',
      HARNESS_MASTER_KEY,
      salt,
      Buffer.from(`${keyVersion}${AAD_FIELD_SEPARATOR}${aad}`, 'utf8'),
      32,
    ),
  );
  const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The account's hosted root identity, unsealed from the test database the way
 * the hosted service does it. Null until the account has created one.
 */
export async function loadHostedRootIdentity(userId) {
  const row = await withPortalDbClient(async (client) => {
    const result = await client.query(
      `SELECT device_id, sealed_private_key, key_version
         FROM hosted_remote_controller_devices WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  });
  if (!row) return null;
  const aad = ['relay-hosted-device-key', userId, row.device_id].join(
    AAD_FIELD_SEPARATOR,
  );
  const pkcs8 = Buffer.from(
    openHarnessEnvelope(row.sealed_private_key, row.key_version, aad),
    'base64',
  );
  const identity = await importDeviceIdentityPkcs8(new Uint8Array(pkcs8));
  if (identity.deviceId !== row.device_id) {
    throw new Error('The unsealed hosted root does not match its device ID.');
  }
  return identity;
}

/**
 * Connects one identity to the relay as a device of `userExternalId`, with a
 * token the spec signs itself. Resolves once the relay says `ready`.
 */
export async function connectTestRelayDevice({
  relay,
  userExternalId,
  identity,
  kind = 'hosted',
  name = 'Hosted test controller',
}) {
  let settle = null;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  const client = new RelayClient({
    kind,
    mintToken: async () => {
      const minted = relay.signToken({
        userExternalId,
        deviceId: identity.deviceId,
        kind,
      });
      return { ...minted, relayUrl: relay.url };
    },
    deviceInfo: () => ({
      deviceId: identity.deviceId,
      name,
      platform: 'linux',
      appVersion: 'hosted',
      publicKey: identity.publicKey,
      acceptsRemoteControl: false,
    }),
    createSocket: createWebSocketRelaySocketFactory(WebSocket),
    onStatusChange: (status) => {
      if (['connected', 'unsupported', 'failed'].includes(status)) {
        settle?.(status);
      }
    },
  });
  const sessions = new RemoteSessionManager({
    transport: client,
    identity: () => identity,
  });
  const stop = () => {
    sessions.dispose();
    client.stop();
  };
  client.start();
  const outcome = await Promise.race([
    settled,
    new Promise((resolve) =>
      setTimeout(() => resolve('timeout'), RELAY_READY_TIMEOUT_MS),
    ),
  ]);
  if (outcome !== 'connected') {
    stop();
    throw new Error(`Test relay device did not connect: ${outcome}`);
  }
  return { client, sessions, identity, stop };
}

/**
 * Opens a delegated hosted session to `host` exactly as the hosted service
 * does (fresh ephemeral identity, root-signed hello1 delegation), except that
 * the spec chooses `expiresAt`. Resolves with the connection, or rejects with
 * the handshake refusal.
 */
export async function openDelegatedTestSession({
  relay,
  userExternalId,
  root,
  host,
  expiresAt,
}) {
  const identity = await generateDeviceIdentity();
  const device = await connectTestRelayDevice({
    relay,
    userExternalId,
    identity,
  });
  const delegation = await signHostedDelegation(
    root,
    identity.publicKey,
    expiresAt,
  );
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const connection = new RemoteControllerConnection({
    sessions: device.sessions,
    host,
    controller: HOSTED_TEST_CONTROLLER,
    delegation,
    autoReconnect: false,
    onSessionEnded: () => resolveEnded(Date.now()),
  });
  const stop = () => {
    connection.close();
    device.stop();
  };
  try {
    await connection.connect();
  } catch (error) {
    stop();
    throw error;
  }
  return {
    deviceId: identity.deviceId,
    connection,
    transport: connection.transport,
    ended,
    stop,
  };
}

/**
 * One raw delegated `control` handshake, without the controller's own expiry
 * check, so the desktop alone decides whether `delegation` is acceptable.
 * Resolves `{ ok: true }` when the desktop accepted (the session is closed
 * again at once) or `{ ok: false, message }` with its refusal.
 */
export async function attemptDelegatedHandshake({
  relay,
  userExternalId,
  root,
  host,
  expiresAt,
}) {
  const identity = await generateDeviceIdentity();
  const device = await connectTestRelayDevice({
    relay,
    userExternalId,
    identity,
  });
  try {
    const delegation = await signHostedDelegation(
      root,
      identity.publicKey,
      expiresAt,
    );
    const outcome = await settle(
      device.sessions.connect({
        peerDeviceId: host.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: host.publicKey,
        delegation,
      }),
    );
    if (outcome.ok) outcome.value.close('closed');
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  } finally {
    device.stop();
  }
}

export const BROWSER_TEST_CONTROLLER = {
  kind: 'browser',
  version: { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion: 'web' },
  minVersion: REMOTE_PROTOCOL_VERSION,
};

/**
 * A test-driven browser-kind controller: a fresh identity on the relay as a
 * `browser` device of `userExternalId`, paired with `hostDeviceId` by the
 * desktop's pairing link (`proofSecret`, the link's 32 decoded bytes), the
 * way the web owner pairs. Resolves `{ device, pairing, openSession(), stop() }`;
 * `openSession()` opens a control session held to the browser profile.
 */
export async function pairTestBrowserController({
  relay,
  userExternalId,
  hostDeviceId,
  proofSecret,
  name = 'Browser test controller',
}) {
  const identity = await generateDeviceIdentity();
  const device = await connectTestRelayDevice({
    relay,
    userExternalId,
    identity,
    kind: 'browser',
    name,
  });
  const connections = [];
  try {
    const pairing = await pairWithHost({
      sessions: device.sessions,
      hostDeviceId,
      controller: BROWSER_TEST_CONTROLLER,
      request: { name, platform: 'linux' },
      proofSecret,
      timeoutMs: 60_000,
    });
    if (!pairing.approved) throw new Error('The desktop refused the link.');
    return {
      device,
      pairing,
      async openSession() {
        const connection = new RemoteControllerConnection({
          sessions: device.sessions,
          host: { deviceId: hostDeviceId, publicKey: pairing.hostPublicKey },
          controller: BROWSER_TEST_CONTROLLER,
          autoReconnect: false,
        });
        connections.push(connection);
        await connection.connect();
        return connection;
      },
      stop() {
        for (const connection of connections) connection.close();
        device.stop();
      },
    };
  } catch (error) {
    device.stop();
    throw error;
  }
}

/** Settles `promise` into `{ ok, value | error }` so refusals can be asserted. */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return {
      ok: false,
      error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
