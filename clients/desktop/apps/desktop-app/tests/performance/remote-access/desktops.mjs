/**
 * Shared pieces of the device-to-device Remote Control runs (CAN-7858 and
 * CAN-7876): several E2E desktops on one machine, paired through the preload API, a
 * controller's separate window on a host, terminal work there, the real
 * `apps/device-relay` and a TCP proxy that shapes and breaks the network.
 *
 * Restored from the bench, soak and recovery specs that commit 5c15612d262
 * deleted under the golden-only rule, and their helpers, as harness code
 * that the runner in `run.mjs` drives; nothing here is a test.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { seedDemoWorkspaces } from '../../electron/demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from '../../electron/launchCanopy.mjs';
import { connectMockCloudAccount } from '../../electron/seeders/connectMockCloudAccount.mjs';
import { withBundledBinaryOverridesScrubbed } from '../../electron/seeders/bundledBinaryOverrides.mjs';
import { summarize } from '../statistics.mjs';
import { onCleanup, onCleanupSync } from './cleanup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const SUPERVISOR_ENTRY = path.join(here, '../process-tree-supervisor.mjs');
const RELAY_ENTRY = path.join(here, 'relay-entry.mjs');

// Cloud sign-in needs OS secure storage. Electron cannot detect the Secret
// Service under every Linux desktop, so point it there explicitly; macOS and
// Windows ignore the switch.
const REMOTE_ACCESS_ELECTRON_ARGS =
  process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];

export const DEMO_APPS = {
  'ts-pnpm-vite': 'TypeScript pnpm Vite',
  'ts-bun-api': 'TypeScript Bun API',
};

/** p50, p95 and max rounded to 0.1 ms, as the deleted runs reported them. */
export function latencySummary(values) {
  const summary = summarize(values);
  const round = (value) =>
    Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  return {
    n: summary.count,
    p50: round(summary.p50),
    p95: round(summary.p95),
    max: round(summary.max),
  };
}

function seedDesktopPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
        mcpProxyPort: 20000 + Math.floor(Math.random() * 15000),
      },
    }),
    'utf8',
  );
}

/**
 * The app's own window. A paired controller may connect before it opens, and
 * the hidden bridge window that serves it (a `data:` page) can be the first
 * window of a restarted host.
 */
async function appWindow(electronApp, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = electronApp
      .windows()
      .find((page) => !page.url().startsWith('data:'));
    if (found) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The app window did not open.');
    await electronApp
      .waitForEvent('window', { timeout: Math.min(remaining, 1_000) })
      .catch(() => undefined);
  }
}

/**
 * Launches one desktop with its own data root, optionally seeded with a demo
 * project, signed in to `apiKey`. Pass the `userDataDir` of an earlier
 * desktop to start that computer again (a restart).
 */
export async function launchDesktop({
  label,
  demoApp = null,
  apiKey,
  seed,
  userDataDir: existingUserDataDir = null,
}) {
  const userDataDir =
    existingUserDataDir ??
    mkdtempSync(path.join(os.tmpdir(), `canopy-remote-${label}-`));
  if (existingUserDataDir === null) {
    // Removed even when seeding or the launch fails; removals run after the
    // apps are closed, or first of all on a signal.
    // launchCanopy keeps secure data in a `-secure` sibling of the root.
    onCleanupSync(() => {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    });
    if (demoApp) seedDemoWorkspaces({ userDataDir, apps: [demoApp] });
    seedDesktopPreferences(userDataDir);
    if (seed) await seed(userDataDir);
  }
  const launched = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      electronArgs: REMOTE_ACCESS_ELECTRON_ARGS,
      ...(process.platform === 'win32'
        ? { env: { CANOPY_E2E_OFFSCREEN_WINDOW: '1' } }
        : {}),
    }),
  );
  // Closed here when the run fails or is interrupted before its own close.
  onCleanup(async () => {
    const child = launched.electronApp.process();
    if (child.exitCode === null && child.signalCode === null) {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
  let window;
  try {
    window = await appWindow(launched.electronApp);
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible({
      timeout: 60_000,
    });
    // A relaunch on the same data keeps its account; saving the key again
    // would race the app's own check of the stored account at startup.
    const stored =
      existingUserDataDir !== null &&
      (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
        ?.hasApiKey === true;
    if (!stored) await connectMockCloudAccount(window, apiKey);
  } catch (error) {
    // The caller never receives this desktop, so close it here; a leaked
    // app would hold the performance host lease after the run fails.
    await closeCanopy(launched.electronApp, userDataDir);
    throw error;
  }
  return {
    label,
    demoApp,
    userDataDir,
    electronApp: launched.electronApp,
    window,
  };
}

export async function remoteState(window, request = {}) {
  return window.evaluate(
    (options) => window.api.remoteControl.getState(options),
    request,
  );
}

/** Turns on incoming control and returns the host's device ID. */
async function allowIncoming(host) {
  const state = await host.window.evaluate(() =>
    window.api.remoteControl.setAllowIncoming(true),
  );
  expect(state.allowIncoming).toBe(true);
  host.deviceId = state.thisDevice.deviceId;
  return host.deviceId;
}

/** Pairs `controller` with `host` through the preload API (host approves). */
export async function pairDevices(controller, host) {
  const hostId = host.deviceId ?? (await allowIncoming(host));
  await expect
    .poll(
      async () =>
        (
          await remoteState(controller.window, { discover: true })
        ).discoverable.map((device) => device.deviceId),
      { timeout: 30_000 },
    )
    .toContain(hostId);
  await controller.window.evaluate(
    (deviceId) => window.api.remoteControl.startPairing(deviceId),
    hostId,
  );
  let pairingId = null;
  await expect
    .poll(
      async () => {
        const state = await remoteState(host.window);
        const controllerId = (await remoteState(controller.window)).thisDevice
          ?.deviceId;
        const pending = state.incomingPairings.find(
          (entry) => entry.deviceId === controllerId,
        );
        pairingId = pending?.pairingId ?? null;
        return pairingId !== null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await host.window.evaluate(
    (id) =>
      window.api.remoteControl.respondToPairing({
        pairingId: id,
        approve: true,
      }),
    pairingId,
  );
  await expect
    .poll(
      async () =>
        (await remoteState(controller.window)).outgoingPairing?.status,
      { timeout: 30_000 },
    )
    .toBe('approved');
  controller.deviceId = (
    await remoteState(controller.window)
  ).thisDevice.deviceId;
  return hostId;
}

/** Opens the window that shows `host` on `controller`; waits for its project. */
export async function openRemoteWindow(controller, host) {
  const startedAt = Date.now();
  // Awaited together, so a failed open or a window that never comes is
  // always handled, whichever settles first.
  const [remoteWindow] = await Promise.all([
    controller.electronApp.waitForEvent('window'),
    controller.window.evaluate(
      (deviceId) => window.api.remoteControl.openMachine(deviceId),
      host.deviceId,
    ),
  ]);
  await remoteWindow.waitForLoadState('domcontentloaded');
  if (host.demoApp) {
    await expect(remoteWindow.getByTestId('app-sidebar')).toContainText(
      DEMO_APPS[host.demoApp],
      { timeout: 60_000 },
    );
  }
  return { window: remoteWindow, openedInMs: Date.now() - startedAt };
}

/**
 * Runs a shell command on the computer a window shows, through that window's
 * terminal API, and resolves with its streamed output once `marker` appears.
 * End commands with `sleep 1` after the marker: the terminal drops output
 * that arrives after the shell exits.
 */
export async function runRemoteTerminal(
  remoteWindow,
  { projectId, worktreeId, command, marker, timeoutMs = 60_000 },
) {
  return remoteWindow.evaluate(
    async ({ projectId, worktreeId, command, marker, timeoutMs }) => {
      const decoder = new TextDecoder();
      // Output is kept per terminal until the spawned terminal's id is
      // known, so another terminal's output can never satisfy the marker.
      const texts = new Map();
      let text = '';
      let terminalId = null;
      let timedOut = false;
      let timer = null;
      let unsubscribe = () => undefined;
      const startedAt = performance.now();
      // One deadline covers the spawn and the wait for the marker.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(`No terminal output for ${marker}: ${text.slice(-400)}`),
          );
        }, timeoutMs);
      });
      let settle = () => undefined;
      const done = new Promise((resolve) => {
        settle = () => {
          if (terminalId === null) return;
          text = texts.get(terminalId) ?? '';
          if (text.includes(marker)) {
            resolve({ text, elapsedMs: performance.now() - startedAt });
          }
        };
        unsubscribe = window.api.terminal.onOutput((event) => {
          if (terminalId !== null && event.terminalId !== terminalId) return;
          texts.set(
            event.terminalId,
            (texts.get(event.terminalId) ?? '') + decoder.decode(event.data),
          );
          settle();
        });
      });
      const spawning = window.api.terminal.spawn({
        projectId,
        worktreeId,
        cols: 120,
        rows: 30,
        initialCommand: command,
      });
      // A terminal that finishes spawning after the deadline is closed.
      spawning.then(
        (spawned) => {
          if (timedOut) {
            window.api.terminal
              .kill({ terminalId: spawned.id })
              .catch(() => undefined);
          }
        },
        () => undefined,
      );
      try {
        const spawned = await Promise.race([spawning, deadline]);
        terminalId = spawned.id;
        settle();
        return await Promise.race([done, deadline]);
      } finally {
        clearTimeout(timer);
        unsubscribe();
        // The marker never came: close the terminal that did spawn, so a
        // retried command does not leave its shell behind.
        if (timedOut && terminalId !== null) {
          window.api.terminal.kill({ terminalId }).catch(() => undefined);
        }
      }
    },
    { projectId, worktreeId, command, marker, timeoutMs },
  );
}

/**
 * Key-to-paint in a window, measured the way the performance monitor does
 * (`monitor.mjs`): from keydown to the second animation frame after it,
 * which follows the frame that painted the key. Types `count` characters
 * into `textbox`, one every `intervalMs`, then clears it.
 *
 * To show what was busy when a key is slow, it also keeps the window's
 * longest animation frames with their scripts, and pings `electronApp`'s
 * main process (the window's app) every 50 ms while typing.
 */
export async function measureKeyToPaint(
  window,
  textbox,
  electronApp,
  { count = 40, intervalMs = 60 } = {},
) {
  if (process.platform === 'linux' || process.platform === 'win32') {
    const browserWindow = await electronApp.browserWindow(window);
    let surface;
    try {
      surface = await browserWindow.evaluate((win) => ({
        offscreen: win.webContents.isOffscreen(),
        visible: win.isVisible(),
        headed: process.env.CANOPY_E2E_SHOW_WINDOW === '1',
      }));
    } finally {
      await browserWindow.dispose();
    }
    if (!surface.offscreen && !surface.visible) {
      throw new Error(
        'Key-to-paint window is hidden without offscreen rendering; its compositor throttles animation frames to ~1 Hz.',
      );
    }
    if (!surface.offscreen && !surface.headed) {
      throw new Error(
        'Key-to-paint window is not offscreen in a headless run; display occlusion or DPMS can throttle animation frames to ~1 Hz.',
      );
    }
  }
  await textbox.click();
  await window.evaluate(() => {
    const samples = [];
    const frames = [];
    const onKeyDown = (event) => {
      if (event.key.length !== 1) return;
      const keyAt = performance.now();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          samples.push(performance.now() - keyAt);
        });
      });
    };
    document.addEventListener('keydown', onKeyDown, true);
    const observer =
      typeof PerformanceObserver === 'function' &&
      PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              frames.push({
                startMs: entry.startTime,
                durationMs: entry.duration,
                blockingMs: entry.blockingDuration,
                scripts: (entry.scripts ?? [])
                  .toSorted((left, right) => right.duration - left.duration)
                  .slice(0, 3)
                  .map((script) => ({
                    durationMs: script.duration,
                    invoker: script.invoker,
                    source: `${script.sourceURL}:${String(script.sourceCharPosition)}`,
                    sourceFunction: script.sourceFunctionName,
                  })),
              });
            }
          })
        : null;
    observer?.observe({ type: 'long-animation-frame' });
    window.__remoteAccessKeyToPaint = {
      samples,
      frames,
      stop: () => {
        document.removeEventListener('keydown', onKeyDown, true);
        observer?.disconnect();
      },
    };
  });
  const mainPingMs = [];
  let typing = true;
  let pingError = null;
  // The ping's failure is held, not left unhandled, and fails the
  // measurement once typing stops.
  const pinging = (async () => {
    while (typing) {
      const startedAt = performance.now();
      await electronApp.evaluate(() => 0);
      mainPingMs.push(performance.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })().catch((error) => {
    pingError = error;
  });
  try {
    for (let index = 0; index < count; index += 1) {
      await window.keyboard.type(String.fromCharCode(97 + (index % 26)));
      await window.waitForTimeout(intervalMs);
    }
  } finally {
    typing = false;
    await pinging;
  }
  if (pingError) throw pingError;
  // Give slow keys up to 3 s to paint; a key that never paints counts.
  await window
    .waitForFunction(
      (expected) => window.__remoteAccessKeyToPaint.samples.length >= expected,
      count,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  const probe = await window.evaluate(() => {
    const state = window.__remoteAccessKeyToPaint;
    state.stop();
    delete window.__remoteAccessKeyToPaint;
    return { samples: state.samples, frames: state.frames };
  });
  await textbox.fill('');
  return {
    keys: count,
    samples: probe.samples,
    mainPingMs,
    longAnimationFrames: probe.frames
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10),
  };
}

/** The performance suite's key-to-paint freeze ceiling (desktop-app-performance.md). */
export const KEY_TO_PAINT_CEILING = Object.freeze({ p95Ms: 100, maxMs: 250 });

/**
 * The ceiling verdict for one key-to-paint measurement. `overlapped` says
 * whether the typing ran while `load` did; a run where it did not measured
 * the window at rest.
 */
export function keyToPaintVerdict(
  measurement,
  { overlapped = false, load = null } = {},
) {
  const summary = latencySummary(measurement.samples);
  const unpaintedKeys = measurement.keys - measurement.samples.length;
  return {
    ...summary,
    keys: measurement.keys,
    unpaintedKeys,
    overlapped,
    load,
    ceiling: KEY_TO_PAINT_CEILING,
    withinCeiling:
      unpaintedKeys === 0 &&
      summary.p95 <= KEY_TO_PAINT_CEILING.p95Ms &&
      summary.max <= KEY_TO_PAINT_CEILING.maxMs,
    mainPingMs: latencySummary(measurement.mainPingMs),
    longAnimationFrames: measurement.longAnimationFrames,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child, output) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Device relay exited with code ${String(child.exitCode)}:\n${output.join('')}`,
      );
    }
    try {
      const response = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Device relay did not become healthy:\n${output.join('')}`);
}

/**
 * Runs the production relay server through `relay-entry.mjs` (bundled once),
 * listening on loopback only, on a fixed port so `restart()` brings it back
 * where the desktops reconnect. Pair it with the mock server's `cloud.deviceRelay` scenario so
 * desktops get tokens it accepts.
 */
export async function startDeviceRelay() {
  const bundleDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-relay-'));
  // Removed even when the build or the spawn fails.
  onCleanupSync(() => rmSync(bundleDir, { recursive: true, force: true }));
  const entry = path.join(bundleDir, 'relay.cjs');
  await build({
    absWorkingDir: path.join(repoRoot, 'apps/device-relay'),
    entryPoints: [RELAY_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: entry,
    logLevel: 'error',
  });
  const port = await freePort();
  const secret = randomBytes(32).toString('hex');
  const output = [];
  const httpUrl = `http://127.0.0.1:${String(port)}`;
  let child = null;

  const spawnRelay = async () => {
    const next = spawn(process.execPath, [SUPERVISOR_ENTRY, entry], {
      env: {
        ...process.env,
        PORT: String(port),
        DEVICE_RELAY_TOKEN_SECRET: secret,
        NODE_ENV: 'production',
        CANOPY_E2E_OWNER_PID: String(process.pid),
        CANOPY_E2E_SUPERVISED_EXECUTABLE: process.execPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const record = (chunk) => {
      output.push(String(chunk));
      if (output.length > 4_000) output.shift();
    };
    next.stdout.on('data', record);
    next.stderr.on('data', record);
    child = next;
    await waitForHealth(httpUrl, next, output);
  };

  const stopRelay = async () => {
    const current = child;
    if (!current || current.exitCode !== null) return;
    current.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        current.kill('SIGKILL');
        resolve();
      }, 5_000);
      current.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const stop = async () => {
    await stopRelay();
    rmSync(bundleDir, { recursive: true, force: true });
  };
  onCleanup(stop);
  try {
    await spawnRelay();
  } catch (error) {
    // A relay that never became healthy is stopped here: the caller gets
    // no handle to stop it with.
    await stop();
    throw error;
  }
  return {
    port,
    url: `ws://127.0.0.1:${String(port)}`,
    secret,
    output: () => output.join(''),
    /** Kills the relay and starts it again on the same port and secret. */
    async restart(downtimeMs = 0) {
      await stopRelay();
      if (downtimeMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, downtimeMs));
      }
      await spawnRelay();
    },
    stop,
  };
}

/**
 * Counts the outer WebSocket frames in one direction of a proxied
 * connection. Relay payloads are end-to-end encrypted, so frame and byte
 * counts are all the proxy can see. It parses frames only after a WebSocket
 * upgrade, and skips payload bytes as they pass instead of buffering them.
 */
function webSocketFrameCounter(counts) {
  const MAX_HANDSHAKE_BYTES = 16 * 1024;
  let handshake = Buffer.alloc(0);
  let state = 'handshake';
  let header = [];
  let skip = 0;
  const parse = (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (skip > 0) {
        const step = Math.min(skip, chunk.length - offset);
        skip -= step;
        offset += step;
        continue;
      }
      // A frame header is 2 to 14 bytes; take them one at a time.
      header.push(chunk[offset]);
      offset += 1;
      if (header.length < 2) continue;
      const lengthCode = header[1] & 0x7f;
      const extended = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
      const masked = (header[1] & 0x80) !== 0 ? 4 : 0;
      if (header.length < 2 + extended + masked) continue;
      const bytes = Buffer.from(header);
      skip =
        lengthCode === 126
          ? bytes.readUInt16BE(2)
          : lengthCode === 127
            ? Number(bytes.readBigUInt64BE(2))
            : lengthCode;
      header = [];
      counts.webSocketFrames += 1;
    }
  };
  return (chunk) => {
    counts.bytes += chunk.length;
    counts.tcpChunks += 1;
    if (state === 'frames') {
      parse(chunk);
      return;
    }
    if (state !== 'handshake') return;
    handshake = Buffer.concat([handshake, chunk]);
    const separator = handshake.indexOf('\r\n\r\n');
    if (separator === -1) {
      if (handshake.length > MAX_HANDSHAKE_BYTES) state = 'opaque';
      return;
    }
    const head = handshake.subarray(0, separator).toString('latin1');
    const upgrade =
      /^HTTP\/1\.1 101/.test(head) || /\r\nupgrade:\s*websocket/i.test(head);
    const rest = handshake.subarray(separator + 4);
    handshake = Buffer.alloc(0);
    state = upgrade ? 'frames' : 'opaque';
    if (upgrade) parse(rest);
  };
}

/** Delayed bytes a proxy direction holds before it stops reading its source. */
const PROXY_DELAY_BUFFER_BYTES = 4 * 1024 * 1024;

export async function startProxy({ targetPort, oneWayDelayMs = 0 }) {
  const sockets = new Set();
  const traffic = {
    toRelay: { bytes: 0, tcpChunks: 0, webSocketFrames: 0 },
    toDesktop: { bytes: 0, tcpChunks: 0, webSocketFrames: 0 },
  };
  const corruptions = { toRelay: 0, toDesktop: 0 };
  // While stalled, no direction forwards anything: the sockets stay open but
  // carry nothing, as on a link that has gone silent.
  let stalled = false;
  const flows = new Set();
  let corrupted = 0;
  const corruptionTimes = [];
  const maybeCorrupt = (direction, chunk) => {
    if (corruptions[direction] === 0 || chunk.length < 512) return chunk;
    corruptions[direction] -= 1;
    corrupted += 1;
    corruptionTimes.push(Date.now());
    const copy = Buffer.from(chunk);
    const index = Math.floor(copy.length / 2);
    copy[index] ^= 0xff;
    return copy;
  };
  const server = createServer((client) => {
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    // Like the relay and the desktop client, never hold small frames back
    // (Nagle plus delayed ACKs would add ~40 ms that real paths do not have).
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const forget = (socket) => () => sockets.delete(socket);
    client.on('close', forget(client));
    upstream.on('close', forget(upstream));
    const pipeDelayed = (from, to, direction) => {
      // Frames are counted on the bytes that arrived, before any corruption.
      const count = webSocketFrameCounter(traffic[direction]);
      // Backpressure passes through, as on a real link: while the delayed
      // bytes or the destination's buffer are full, stop reading the source.
      let delayedBytes = 0;
      let waitingForDrain = false;
      const updateFlow = () => {
        if (
          stalled ||
          waitingForDrain ||
          delayedBytes > PROXY_DELAY_BUFFER_BYTES
        ) {
          from.pause();
        } else {
          from.resume();
        }
      };
      const write = (chunk) => {
        if (to.destroyed) return;
        if (!to.write(chunk) && !waitingForDrain) {
          waitingForDrain = true;
          to.once('drain', () => {
            waitingForDrain = false;
            updateFlow();
          });
        }
      };
      from.on('data', (received) => {
        count(received);
        const chunk = maybeCorrupt(direction, received);
        if (oneWayDelayMs === 0) {
          write(chunk);
          updateFlow();
          return;
        }
        delayedBytes += chunk.length;
        updateFlow();
        setTimeout(() => {
          delayedBytes -= chunk.length;
          write(chunk);
          updateFlow();
        }, oneWayDelayMs);
      });
      flows.add(updateFlow);
      // A connection made during a stall is held like the others.
      updateFlow();
      from.on('close', () => {
        flows.delete(updateFlow);
        setTimeout(() => to.destroy(), oneWayDelayMs);
      });
      from.on('error', () => to.destroy());
    };
    pipeDelayed(client, upstream, 'toRelay');
    pipeDelayed(upstream, client, 'toDesktop');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  onCleanup(stop);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `ws://127.0.0.1:${String(port)}`,
    trafficSnapshot() {
      return {
        toRelay: { ...traffic.toRelay },
        toDesktop: { ...traffic.toDesktop },
      };
    },
    dropConnections() {
      for (const socket of sockets) socket.resetAndDestroy();
      sockets.clear();
    },
    /**
     * Stops forwarding in both directions for `ms` without closing anything;
     * resolves with the time forwarding resumed (epoch milliseconds).
     */
    async stall(ms) {
      stalled = true;
      for (const flow of flows) flow();
      await new Promise((resolve) => setTimeout(resolve, ms));
      stalled = false;
      for (const flow of flows) flow();
      return Date.now();
    },
    corruptNext(direction) {
      corruptions[direction] += 1;
    },
    /** Chunks corrupted so far. */
    corrupted: () => corrupted,
    /** When each corruption happened (epoch milliseconds). */
    corruptionTimes: () => [...corruptionTimes],
    stop,
  };
}

export function trafficDelta(before, after) {
  return Object.fromEntries(
    Object.entries(after).map(([direction, counts]) => [
      direction,
      {
        bytes: counts.bytes - before[direction].bytes,
        tcpChunks: counts.tcpChunks - before[direction].tcpChunks,
        webSocketFrames:
          counts.webSocketFrames - before[direction].webSocketFrames,
      },
    ]),
  );
}
