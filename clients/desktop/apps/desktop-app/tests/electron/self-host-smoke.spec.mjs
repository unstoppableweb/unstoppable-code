// Self-host build smoke (CAN-7963, "Self-host profile" in
// docs/local-only-build.md).
//
// Runs in this repository only, against the E2E build (`out-e2e/`) with the
// seam CANOPY_E2E_SELF_HOST=1, which turns the self-host profile on: the cloud
// stays on, pointed at CANOPY_E2E_CLOUD_BASE_URL, PostHog, LaunchDarkly and
// update checks are off, and the egress guard is installed with two origin
// allowances, the server and the relay origin the server hands out. It is not
// part of the public export.
//
// No feature flag override is set for sign-in or Remote Control, so the
// flags serve what a self-host build serves without LaunchDarkly.
//
// Probe rule: "allowed" means the request failed for any reason other than
// CANOPY_LOCAL_ONLY_EGRESS_BLOCKED (the probe hosts are reserved `.invalid`
// names, so DNS fails) and the egress log has no line for it. Each probe has a
// short abort timeout, so a resolver that answers unknown names cannot hang
// it. No exact DNS error code is asserted; resolvers differ.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeCanopy,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';

const EGRESS_LOG = 'local-only-egress.jsonl';
const BLOCKED_CODE = 'CANOPY_LOCAL_ONLY_EGRESS_BLOCKED';
const MAIN_CANARY_HOST = 'canary-main.self-host-smoke.invalid';
const RENDERER_CANARY_HOST = 'canary-renderer.self-host-smoke.invalid';
const RELAY_HOST = 'relay.self-host-smoke.invalid';
const RELAY_URL = `wss://${RELAY_HOST}:9443`;
// A distinct host, so an attempted connection to the rejected relay would
// show up in the egress log as a host of its own.
const PLAIN_RELAY_HOST = 'relay-plain.self-host-smoke.invalid';
const PLAIN_RELAY_URL = `ws://${PLAIN_RELAY_HOST}`;
const SERVER_HOST = 'server.self-host-smoke.invalid';
const SERVER_ORIGIN = `https://${SERVER_HOST}:8443`;
const API_KEY = 'csk_self_host_smoke';
const PROBE_TIMEOUT_MS = 5_000;
// Under the seam the deferred startup tasks run at once; give their attempts
// time to land before quitting.
const STARTUP_TASK_SETTLE_MS = 2_000;

test.describe.configure({ retries: 0 });

function selfHostEnv(extra = {}) {
  return { CANOPY_E2E_SELF_HOST: '1', ...extra };
}

function readEgressLog(dataDir) {
  const file = path.join(dataDir, EGRESS_LOG);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function egressLines(dataDir) {
  return readEgressLog(dataDir)
    .map(({ host, source }) => `${source} ${host}`)
    .sort();
}

/** A main-process fetch: `blocked` when the guard refused the connect. */
function probeMain(electronApp, url) {
  return electronApp.evaluate(
    async (_electron, { target, timeoutMs, blockedCode }) => {
      try {
        await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
        return 'reached';
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const code =
          cause && typeof cause === 'object' && 'code' in cause
            ? String(cause.code)
            : null;
        return code === blockedCode ? 'blocked' : 'not-blocked';
      }
    },
    { target: url, timeoutMs: PROBE_TIMEOUT_MS, blockedCode: BLOCKED_CODE },
  );
}

/** A renderer fetch. The renderer cannot see why it failed; the log can. */
function probeRenderer(window, url) {
  return window.evaluate(
    async ({ target, timeoutMs }) => {
      try {
        await fetch(target, {
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        });
        return 'reached';
      } catch {
        return 'failed';
      }
    },
    { target: url, timeoutMs: PROBE_TIMEOUT_MS },
  );
}

function relayScenario(relayUrl) {
  return {
    cloud: {
      deviceRelay: {
        url: relayUrl,
        secret: 'self-host-smoke-relay-secret-not-a-real-one',
        userId: 'self-host-smoke-user',
      },
    },
  };
}

async function attachEgressLog(testInfo, dataDir) {
  const log = dataDir ? path.join(dataDir, EGRESS_LOG) : null;
  await testInfo.attach(EGRESS_LOG, {
    body:
      log && existsSync(log)
        ? readFileSync(log, 'utf8')
        : '(no egress log was written)\n',
    contentType: 'application/jsonl',
  });
}

test('a self-host build signs in to its server and reaches only the server and the relay it hands out', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'self-host-smoke-'));
  let electronApp;
  try {
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      API_KEY,
      relayScenario(RELAY_URL),
    );
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: selfHostEnv({ CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL }),
    }));
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });

    // 1. The profile, and its run-time exclusivity with local-only.
    expect(
      await window.evaluate(() => ({
        selfHostBuild: window.api.selfHostBuild,
        localOnlyBuild: window.api.localOnlyBuild,
      })),
      'The build under test is not in the self-host profile. Use an E2E build (pnpm run build:e2e); the spec sets CANOPY_E2E_SELF_HOST=1.',
    ).toEqual({ selfHostBuild: true, localOnlyBuild: false });

    // 2. Guard canaries: an empty log also passes when the guard is missing.
    expect(await probeMain(electronApp, `https://${MAIN_CANARY_HOST}/`)).toBe(
      'blocked',
    );
    expect(
      await probeRenderer(window, `https://${RENDERER_CANARY_HOST}/`),
    ).toBe('failed');
    await expect
      .poll(() => egressLines(userDataDir))
      .toEqual(
        expect.arrayContaining([
          `node ${MAIN_CANARY_HOST}`,
          `renderer ${RENDERER_CANARY_HOST}`,
        ]),
      );

    // 4. No PostHog identity reaches the renderer.
    expect(
      await window.evaluate(() =>
        window.api.observability.getPostHogAnonymousId(),
      ),
    ).toBeNull();

    // 5. A manual update check reports the source-build policy, although this
    // E2E build is not a source build: the self-host profile alone does it.
    const updateCheck = await window.evaluate(async () => {
      let rejection = null;
      try {
        await window.api.update.checkForUpdates();
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      const state = await window.api.update.getState();
      return { rejection, message: state.message ?? null };
    });
    expect(
      `${updateCheck.rejection ?? ''} ${updateCheck.message ?? ''}`,
    ).toMatch(/App updates are disabled in source-built/);

    // 6a. Before any token, the relay origin is not allowed.
    expect(await probeMain(electronApp, `https://${RELAY_HOST}:9443/`)).toBe(
      'blocked',
    );

    // 3. Sign-in is offered, and succeeds against the server (the mock). The
    // browser half of sign-in runs in the system browser, outside the guard;
    // the API-key path exercises the same server origin from main.
    await window.getByTestId('sidebar-account-row').click();
    await expect(
      window.getByTestId('sidebar-account-menu-item-sign-in-out'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await connectMockCloudAccount(window, API_KEY);

    // 6b. Remote Control on: the relay client fetches a token naming the
    // relay origin, and from then on that origin is allowed, on its port only.
    await window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(true),
    );
    await expect
      .poll(() => probeMain(electronApp, `https://${RELAY_HOST}:9443/`), {
        timeout: 30_000,
      })
      .toBe('not-blocked');
    expect(await probeMain(electronApp, `https://${RELAY_HOST}:9444/`)).toBe(
      'blocked',
    );

    // 7. A token naming plain ws on a non-loopback host is rejected: the relay
    // client's token_failed branch reports the refusal as its status detail,
    // and the origin from 6b stays allowed (an accepted token would have
    // replaced it).
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      API_KEY,
      relayScenario(PLAIN_RELAY_URL),
    );
    await window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(false),
    );
    await window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(true),
    );
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.remoteControl.getState()))
            .relayDetail,
        { timeout: 30_000 },
      )
      .toMatch(/The server returned a relay address this build can't use/);
    expect(await probeMain(electronApp, `https://${RELAY_HOST}:9443/`)).toBe(
      'not-blocked',
    );

    await window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(false),
    );
    await window.waitForTimeout(STARTUP_TASK_SETTLE_MS);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    // 8. Only the hosts this spec asked for. Nothing tried PostHog,
    // LaunchDarkly, the releases host or the rejected relay.
    expect(
      egressLines(userDataDir),
      'Electron tried to reach a host other than the canaries and the relay probe; see the attached egress log.',
    ).toEqual(
      [
        `node ${MAIN_CANARY_HOST}`,
        `node ${RELAY_HOST}`,
        `renderer ${RENDERER_CANARY_HOST}`,
      ].sort(),
    );
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir, { keepUserData: true }).catch(
        () => undefined,
      );
    }
    await attachEgressLog(testInfo, userDataDir);
    await removeTestDataDir(userDataDir);
  }
});

test('a self-host build allows its non-loopback server origin and nothing else on that host', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'self-host-smoke-origin-'),
  );
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: selfHostEnv({ CANOPY_E2E_CLOUD_BASE_URL: SERVER_ORIGIN }),
    }));
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });
    expect(await window.evaluate(() => window.api.selfHostBuild)).toBe(true);

    // 1. The server origin is allowed from main.
    expect(await probeMain(electronApp, `${SERVER_ORIGIN}/`)).toBe(
      'not-blocked',
    );
    // 3. ...and leaves no log line: a blocked canary written after it shows
    // the log has caught up.
    expect(await probeMain(electronApp, `https://${MAIN_CANARY_HOST}/`)).toBe(
      'blocked',
    );
    await expect
      .poll(() => egressLines(userDataDir))
      .toContain(`node ${MAIN_CANARY_HOST}`);
    expect(egressLines(userDataDir)).not.toContain(`node ${SERVER_HOST}`);

    // 2. The same host on another port, and plain http on the server's port
    // from the renderer, are blocked and logged.
    expect(await probeMain(electronApp, `https://${SERVER_HOST}:8444/`)).toBe(
      'blocked',
    );
    expect(await probeRenderer(window, `http://${SERVER_HOST}:8443/`)).toBe(
      'failed',
    );
    await expect
      .poll(() => egressLines(userDataDir))
      .toEqual(
        [
          `node ${MAIN_CANARY_HOST}`,
          `node ${SERVER_HOST}`,
          `renderer ${SERVER_HOST}`,
        ].sort(),
      );
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir, { keepUserData: true }).catch(
        () => undefined,
      );
    }
    await attachEgressLog(testInfo, userDataDir);
    await removeTestDataDir(userDataDir);
  }
});
