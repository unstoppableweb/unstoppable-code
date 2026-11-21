// Direct (device-relay) Remote Control harness: the web server and seeded
// accounts from `harness/`, plus a real relay, a desktop signed in to the
// relay with its API key, and the hosted pairing and computer routes. Shared
// by the hosted MCP golden and the browser direct-web golden. Test-only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import {
  REMOTE_CONTROL_WEB_ORIGIN,
  REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK,
} from './harness/config.mjs';
import { withRemoteControlDbClient } from './harness/db.mjs';
import { resolveRemoteControlWebBrandId } from './harness/web-server.mjs';

/**
 * Web server options for direct Remote Control: the relay it mints tokens
 * for, and the hosted MCP opt-ins. The device and direct rollout flags need
 * no opt-in: the harness runs without LaunchDarkly, where both default on
 * (`launchDarklyDisabledDefaultValue: true`), and the production-mode stub
 * serves the same disabled defaults.
 */
export function directWebServerOptions({ relay, env = {}, ...options }) {
  return {
    ...options,
    env: {
      DEVICE_RELAY_URL: relay.url,
      DEVICE_RELAY_TOKEN_SECRET: relay.secret,
      CANOPY_PORTAL_E2E_MCP_SERVER: '1',
      CANOPY_PORTAL_E2E_MCP_REMOTE_CONTROL: '1',
      // The OAuth issuer, MCP resources and the hosted routes' exact-origin
      // check all use this origin; without it the default brand falls back
      // to the local development port.
      CANOPY_WEB_MCP_CANONICAL_ORIGINS: `${resolveRemoteControlWebBrandId({ env })}=${REMOTE_CONTROL_WEB_ORIGIN}`,
      ...env,
    },
  };
}

/** The seeded account's browser session, for Node-side route calls. */
export function sessionCookieHeader(seeded) {
  return `${seeded.cookie.name}=${seeded.cookie.value}`;
}

/** Headers a same-origin browser write carries (the routes check all of them). */
export function sameOriginJsonHeaders(seeded) {
  return {
    Cookie: sessionCookieHeader(seeded),
    'Content-Type': 'application/json',
    Origin: REMOTE_CONTROL_WEB_ORIGIN,
    'Sec-Fetch-Site': 'same-origin',
  };
}

export async function readRemoteControlState(window) {
  return window.evaluate(() => window.api.remoteControl.getState());
}

export async function waitForRemoteControlState(
  window,
  predicate,
  { timeoutMs = 30_000, label = 'Remote Control state' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readRemoteControlState(window);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${label} not reached within ${String(timeoutMs)}ms; last=${JSON.stringify(last)}`,
  );
}

/**
 * Launches the E2E desktop pointed at the harness web server, signs it in
 * with the seeded account's API key and turns Remote Control on, so it joins
 * the relay as a controllable computer. Resolves once the relay reports it.
 *
 * `quit()` closes the app and keeps its data (its relay identity and
 * pairings), so the computer goes offline; `relaunch()` starts it again on
 * the same data and waits for it to rejoin the relay. Both update the
 * returned handle's `electronApp`, `window` and `app` in place.
 */
export async function launchRemoteControlDesktop({
  relay,
  seeded,
  env = {},
  desktopPreferences = {},
  seedBeforeLaunch,
}) {
  let userDataDir = null;
  let running = null;
  let closed = false;
  const removeData = () => {
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  };
  try {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-rc-e2e-'));
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          // The bundled agent SDK's MCP proxy otherwise binds a fixed port
          // another local app may hold.
          mcpProxyPort: 41000 + (Date.now() % 20000),
          ...desktopPreferences,
        },
      }),
      'utf8',
    );
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    await seedBeforeLaunch?.({ userDataDir, demo });

    running = await startSignedInDesktop({ relay, seeded, env, userDataDir });
    const handle = {
      ...running,
      userDataDir,
      demo,
      /** Quits the app, keeping its data; the computer goes offline. */
      async quit() {
        if (!running) return;
        const stopping = running;
        running = null;
        await closeCanopy(stopping.electronApp, userDataDir, {
          keepUserData: true,
        });
      },
      /**
       * Starts the app again on the same data and waits for the relay.
       * `env` overrides the launch environment for this start only.
       */
      async relaunch({ env: relaunchEnv = {} } = {}) {
        if (running) await handle.quit();
        running = await startSignedInDesktop({
          relay,
          seeded,
          env: { ...env, ...relaunchEnv },
          userDataDir,
        });
        if (running.deviceId !== handle.deviceId) {
          throw new Error(
            `The relaunched desktop joined as ${running.deviceId}, not ${handle.deviceId}.`,
          );
        }
        Object.assign(handle, running);
        return handle;
      },
      async teardown() {
        if (closed) return;
        closed = true;
        const stopping = running;
        running = null;
        if (stopping) {
          await closeCanopy(stopping.electronApp, userDataDir).catch(
            () => undefined,
          );
        }
        removeData();
      },
    };
    return handle;
  } catch (error) {
    if (running) {
      await closeCanopy(running.electronApp, userDataDir).catch(
        () => undefined,
      );
    }
    removeData();
    throw error;
  }
}

async function startSignedInDesktop({ relay, seeded, env, userDataDir }) {
  const launch = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK,
      ...env,
    },
  });
  const { electronApp } = launch;
  try {
    if (process.env.CANOPY_PORTAL_E2E_DEBUG_STDIO === '1') {
      electronApp.process().stdout?.on('data', (chunk) => {
        process.stdout.write(`[desktop-stdout] ${chunk}`);
      });
      electronApp.process().stderr?.on('data', (chunk) => {
        process.stdout.write(`[desktop-stderr] ${chunk}`);
      });
    }
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window
      .getByTestId('worktree-row')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });

    // Relaunch keeps this user-data directory. The app's startup account
    // refresh writes the stored account while this save validates the seeded
    // key, so saveManualCanopyCloudAccount returns superseded ("changed while
    // the API key was being validated"). That is the product's own try-again
    // outcome; retry only that error.
    const supersededApiKeySave =
      /changed while the API key was being validated/;
    let saved = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      saved = await window.evaluate(
        (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        seeded.apiKey,
      );
      if (saved?.status?.authenticated) break;
      const error = saved?.status?.error;
      if (
        attempt === 3 ||
        typeof error !== 'string' ||
        !supersededApiKeySave.test(error)
      ) {
        break;
      }
      await delay(attempt * 250);
    }
    if (!saved?.status?.authenticated) {
      throw new Error(`saveCanopyCloudApiKey failed: ${JSON.stringify(saved)}`);
    }
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(true),
    );
    const state = await waitForRemoteControlState(
      window,
      (current) =>
        current.relayStatus === 'connected' && current.thisDevice !== null,
      { timeoutMs: 45_000, label: 'desktop relay connection' },
    );
    const deviceId = state.thisDevice.deviceId;
    await relay.waitFor((ids) => ids.has(deviceId), {
      label: 'the desktop on the relay',
    });
    return { electronApp, window, app, deviceId };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

/** Parses one `text/event-stream` body into `{ event, data }` records. */
async function* readServerSentEvents(body) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let boundary = buffered.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf('\n\n');
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}

/**
 * Starts hosted pairing (`POST /api/v1/mcp/remotes/pair`) for one of the
 * account's computers. A refusal resolves `{ ok: false, status, body }`; an
 * admitted pairing resolves `{ ok: true, next(), abort() }`, where `next()`
 * yields the stream's events in order (`code`, then `paired` or `failed`).
 */
export async function startHostedPairing(seeded, deviceId) {
  const abort = new AbortController();
  const response = await fetch(
    `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/api/v1/mcp/remotes/pair`,
    {
      method: 'POST',
      headers: sameOriginJsonHeaders(seeded),
      body: JSON.stringify({ deviceId }),
      signal: abort.signal,
    },
  );
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('text/event-stream')) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: false, status: response.status, body };
  }
  const events = readServerSentEvents(response.body);
  return {
    ok: true,
    status: response.status,
    async next(timeoutMs = 60_000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for a pairing event.')),
          timeoutMs,
        );
      });
      try {
        const result = await Promise.race([events.next(), timeout]);
        return result.done ? null : result.value;
      } finally {
        clearTimeout(timer);
      }
    },
    abort: () => abort.abort(),
  };
}

/**
 * Waits for the desktop's pairing request prompt, checks it shows `code`
 * for an agents (hosted) request, and answers it with the real buttons.
 */
export async function answerDesktopPairingPrompt(window, { code, approve }) {
  const prompt = window.getByTestId('remote-access-incoming-pairing-body');
  await prompt.waitFor({ state: 'visible', timeout: 30_000 });
  const shownCode = (
    await window.getByTestId('remote-access-incoming-pairing-code').innerText()
  ).replace(/\D/g, '');
  if (shownCode !== code.replace(/\D/g, '')) {
    throw new Error(
      `Desktop shows pairing code ${shownCode}, the web shows ${code}.`,
    );
  }
  await window
    .getByTestId(
      approve
        ? 'remote-access-incoming-pairing-allow'
        : 'remote-access-incoming-pairing-decline',
    )
    .click();
}

/**
 * Pairs the account's hosted agents root with the desktop: starts the SSE
 * pairing, approves the matching code on the desktop and returns the final
 * event (`paired` with `remoteId`, or `failed` with `reason`).
 */
export async function pairHostedAgents({ seeded, desktop, approve = true }) {
  const pairing = await startHostedPairing(seeded, desktop.deviceId);
  if (!pairing.ok) {
    throw new Error(
      `Hosted pairing refused: ${String(pairing.status)} ${JSON.stringify(pairing.body)}`,
    );
  }
  const first = await pairing.next();
  if (first?.event !== 'code') {
    throw new Error(`Expected a pairing code, got ${JSON.stringify(first)}`);
  }
  await answerDesktopPairingPrompt(desktop.window, {
    code: first.data.code,
    approve,
  });
  const result = await pairing.next();
  return { code: first.data.code, result };
}

/** `GET /api/v1/external-agents/computers` as the signed-in account. */
export async function listHostedComputers(seeded) {
  const response = await fetch(
    `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/api/v1/external-agents/computers`,
    { headers: { Cookie: sessionCookieHeader(seeded) } },
  );
  return { status: response.status, body: await response.json() };
}

/** Hosted session/device slot leases held for an account, live or not. */
export async function readHostedLeases(userId) {
  return withRemoteControlDbClient(async (client) => {
    const result = await client.query(
      `SELECT slot, purpose, relay_device_id, expires_at,
              expires_at > clock_timestamp() AS live
         FROM hosted_remote_session_leases WHERE user_id = $1 ORDER BY slot`,
      [userId],
    );
    return result.rows;
  });
}

/** The account's hosted pairing links (`agent_remote_identities`). */
export async function readHostedLinks(userId) {
  return withRemoteControlDbClient(async (client) => {
    const result = await client.query(
      `SELECT external_id, stable_device_identity, relay_device_id,
              hosted_paired_at, hosted_removal_requested_at, host_code,
              hosted_host_public_key
         FROM agent_remote_identities WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return result.rows;
  });
}
