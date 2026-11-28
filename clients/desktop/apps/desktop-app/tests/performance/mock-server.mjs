import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resetScenarios } from '../electron/seeders/index.mjs';
import { SUPERVISOR_GRACE_MS } from './process-tree-supervisor.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const serverEntry = path.join(
  repoRoot,
  'apps/desktop-app/tests/electron/mock-server/start.mjs',
);
const supervisorEntry = path.join(currentDir, 'process-tree-supervisor.mjs');

// The Playwright suite owns 4011 and tears that server down when its command
// exits. Performance verification runs as a subsequent command, so reusing
// 4011 creates a race where the suite can terminate the server after this
// runner's health check. Keep performance ownership on a separate origin.
export const PERFORMANCE_MOCK_BASE_URL = (
  process.env.CANOPY_PERFORMANCE_MOCK_BASE_URL ?? 'http://127.0.0.1:4012'
).replace(/\/+$/, '');

/**
 * The mock origin the desktops this process launches use: the run's own
 * server once `startPrivateMockServer` is in use, otherwise the shared one.
 */
export function currentMockBaseUrl() {
  return (
    process.env.CANOPY_E2E_MOCK_BASE_URL ?? PERFORMANCE_MOCK_BASE_URL
  ).replace(/\/+$/, '');
}

async function isHealthy(baseUrl = PERFORMANCE_MOCK_BASE_URL, instance) {
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    if (instance === undefined) return true;
    const body = await response.json();
    return body?.instance === instance;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(SUPERVISOR_GRACE_MS + 1_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

export async function resetOwnedMockServer(
  child,
  reset = () => resetScenarios(PERFORMANCE_MOCK_BASE_URL),
) {
  try {
    await reset();
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export async function ensureMockServer() {
  if (await isHealthy()) {
    await resetScenarios(PERFORMANCE_MOCK_BASE_URL);
    return { reused: true, stop: async () => undefined };
  }
  return spawnMockServer(PERFORMANCE_MOCK_BASE_URL, (child) =>
    resetOwnedMockServer(child),
  );
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

/**
 * A mock server only this run uses, on a free port (CAN-8048). The shared
 * performance origin is reset by whichever run starts next, and the suite
 * lease does not serialize runs from different temporary directories, so a
 * run there can lose its scenarios midway. Returns its base URL.
 */
export async function startPrivateMockServer() {
  // The port is free when picked but can be taken before the server binds
  // it; a server that cannot bind exits, so try another.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baseUrl = `http://127.0.0.1:${String(await freePort())}`;
    try {
      const server = await spawnMockServer(baseUrl, async () => undefined, {
        instance: randomUUID(),
      });
      return { ...server, baseUrl };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function spawnMockServer(baseUrl, onHealthy, { instance } = {}) {
  const child = spawn(process.execPath, [supervisorEntry, serverEntry], {
    detached: true,
    cwd: repoRoot,
    env: {
      ...process.env,
      CANOPY_E2E_OWNER_PID: String(process.pid),
      CANOPY_E2E_MOCK_BASE_URL: baseUrl,
      ...(instance === undefined ? {} : { CANOPY_E2E_MOCK_INSTANCE: instance }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-8_000);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Desktop performance mock server exited (${child.exitCode}): ${errorOutput}`,
      );
    }
    if (await isHealthy(baseUrl, instance)) {
      await onHealthy(child);
      return { reused: false, stop: () => stopChild(child) };
    }
    await delay(100);
  }

  await stopChild(child);
  throw new Error(
    `Timed out starting the desktop performance mock server: ${errorOutput}`,
  );
}
