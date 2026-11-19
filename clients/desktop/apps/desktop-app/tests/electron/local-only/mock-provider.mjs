// A private copy of the UI-automation mock server for the local-only smoke
// spec. It runs `mock-server/start.mjs` as a child process on a free loopback
// port instead of using the suite's shared server on 4011, so the spec
// behaves the same in this repository and in the public client export, which
// has no Playwright `webServer`.
//
// Imports stay inside apps/desktop-app/tests/electron and node_modules so the
// public export can carry this file (`check:public-export`).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const MOCK_ENTRY = path.resolve(
  import.meta.dirname,
  '..',
  'mock-server',
  'start.mjs',
);
const HEALTH_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A loopback port that was free a moment ago. */
export function pickFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() =>
        port ? resolve(port) : reject(new Error('No free loopback port')),
      );
    });
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startOnPort(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, [MOCK_ENTRY], {
    // start.mjs reads its port from this variable. Nothing else from the
    // runner's environment is needed, so a developer's provider or cloud
    // variables never reach it.
    env: {
      PATH: process.env.PATH ?? '',
      CANOPY_E2E_MOCK_BASE_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (chunk) => {
    output.push(String(chunk));
    if (output.length > 200) output.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      return { ok: false, output: output.join('') };
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return { ok: true, child, baseUrl, output };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  await stopChild(child);
  return {
    ok: false,
    output: `${output.join('')}\nNo /healthz answer within ${HEALTH_TIMEOUT_MS}ms.`,
  };
}

/**
 * Starts the mock server on a free loopback port and waits for `/healthz`.
 * Retries once with a new port, for the case where another process took the
 * port between picking and binding it.
 */
export async function startMockProvider() {
  let lastOutput = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = await startOnPort(await pickFreeLoopbackPort());
    if (started.ok) {
      const { child, baseUrl, output } = started;
      return {
        baseUrl,
        /** Recent mock server output, for a failure message. */
        output: () => output.join(''),
        /**
         * Registers a scenario with the mock's control plane
         * (`mock-server/control-plane.mjs`, `POST /__mock/state`). Live
         * turns select it with a `[<key>]` marker in the user message.
         */
        async registerScenario(key, scenario) {
          const response = await fetch(`${baseUrl}/__mock/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key, scenario }),
          });
          if (!response.ok) {
            throw new Error(
              `Mock scenario registration answered ${response.status}: ${await response.text()}`,
            );
          }
          return response.json();
        },
        stop: () => stopChild(child),
      };
    }
    lastOutput = started.output;
  }
  throw new Error(
    `The mock provider did not start after two attempts:\n${lastOutput}`,
  );
}
