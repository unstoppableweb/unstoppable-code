// Browser Remote Control over the direct device-relay protocol (CAN-5985),
// end to end: real Chromium pages on the web app's `/chat`, the real web
// server and Postgres, the real relay and the E2E desktop. The page loads the
// production connection owner the way the app does (`new SharedWorker(new
// URL(...))` through the Next bundler; the leader tab's dedicated worker when
// SharedWorker is missing), and every key, handshake and frame uses the
// browser's own WebCrypto, IndexedDB and compression. Test-driven protocol
// clients present browser credentials directly to prove the desktop refuses
// what a browser must not do, and other accounts' devices.
//
// The page never exposes the owner. Its state is read by teeing the tab's
// own MessagePort (an init script wraps the SharedWorker constructor and
// records what the owner posts), the relay's logs show its connections, and
// Chrome DevTools reaches the SharedWorker only to shorten the five-minute
// hidden-tab timer.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { expect, test } from './harness/fixtures.mjs';
import {
  REMOTE_CONTROL_BETTER_AUTH_SECRET,
  REMOTE_CONTROL_WEB_ORIGIN,
  REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK,
} from './harness/config.mjs';
import {
  ensureRemoteControlSchema,
  seededSessionCookie,
} from './harness/remoteControlHarness.mjs';
import { seedRemoteControlWebUser } from './harness/seedWebUser.mjs';
import {
  truncateWebTestState,
  withRemoteControlDbClient,
} from './harness/db.mjs';
import { warmRemoteControlRoutes } from './harness/web-server.mjs';
import {
  buildTrackedPlan,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedStoredPipeline,
  seedTrackedPlans,
} from '../seeders/index.mjs';
import {
  readChatStorageMessages,
  readChatStorageTabs,
} from '../readChatStorage.mjs';
import { startDeviceRelay } from './relay.mjs';
import {
  answerDesktopPairingPrompt,
  directWebServerOptions,
  launchRemoteControlDesktop,
  readRemoteControlState,
} from './directWebHarness.mjs';
import {
  connectTestRelayDevice,
  pairTestBrowserController,
  settle,
} from './hostedController.mjs';

test.describe.configure({ mode: 'serial' });

const PROJECT_NAME = 'TypeScript pnpm Vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
/** The desktop's refusal for a channel outside the controller's profile. */
const HOST_PROFILE_REFUSAL =
  /is not available while controlling another computer/;
/** Low enough that one spare account can fill it with test devices. */
const RELAY_DEVICE_CAP = 8;
const OWNER_SHARED_WORKER = 'canopy-remote-control';
const HIDDEN_DISCONNECT_MS = 5 * 60_000;
const NOTICE = '[data-testid="chat-direct-remote-control-notice"]';
const POLL = { timeout: 30_000, intervals: [250, 500, 1_000] };
/** Seeded on the desktop for the panel rows case. */
const SEEDED_PLAN = { id: 'direct-web-plan', title: 'Direct web seeded plan' };
const SEEDED_PIPELINE = {
  id: 'direct-web-pipeline',
  name: 'Direct web seeded pipeline',
  output: 'DIRECT_PIPELINE_RAN',
};
/** A finished manual hook run in the worktree's hook run ledger. */
const SEEDED_HOOK_RUN = {
  runId: 'direct-web-hook-run',
  triggerName: 'worktree:precommit:failure',
  label: 'Pre-commit Failure',
  output: 'DIRECT_HOOK_RAN',
};

/**
 * Seeds a finished hook run where the desktop's hook run ledger keeps it
 * (`hook-invocations/<runId>/meta.json` and `output.log` under the
 * worktree's data directory). A manual run needs a pull request snapshot,
 * which this harness has none of.
 */
function seedHookRun(userDataDir) {
  const dir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'hook-invocations',
    SEEDED_HOOK_RUN.runId,
  );
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const completedAt = new Date(Date.now() - 58_000).toISOString();
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      runId: SEEDED_HOOK_RUN.runId,
      hook: {
        hookKey: `project:${SEEDED_HOOK_RUN.triggerName}`,
        triggerName: SEEDED_HOOK_RUN.triggerName,
        label: SEEDED_HOOK_RUN.label,
        actions: [
          { type: 'command', command: `echo ${SEEDED_HOOK_RUN.output}` },
        ],
        target: 'project',
      },
      invocation: 'manual',
      status: 'success',
      startedAt,
      updatedAt: completedAt,
      completedAt,
      exitCode: 0,
      timedOut: false,
      durationMs: 2_000,
    }),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'output.log'),
    `${SEEDED_HOOK_RUN.output}\n`,
    'utf8',
  );
}

let relay = null;
let webServer = null;
let browser = null;
let desktop = null;
let userA = null;
let userB = null;
let userC = null;
/** The link-paired browser profile that most cases drive. */
let primary = null;
/** The code-paired browser profile, on its own session, signed out later. */
let secondary = null;
/** The reply in the chat the primary page has open, stored on the desktop. */
let openChatReply = null;
/** The desktop's public key, as a paired controller pins it. */
let hostPublicKey = null;

// ---------------------------------------------------------------------------
// Browser profiles
// ---------------------------------------------------------------------------

/**
 * Records every message the owner posts to this tab's own SharedWorker port,
 * without opening another port: the tab's state as the owner reports it.
 */
function teeOwnerPort(sharedWorkerName) {
  const messages = [];
  Object.defineProperty(window, '__directOwner', {
    value: {
      messages,
      state: () =>
        [...messages].reverse().find((message) => message?.type === 'state')
          ?.state ?? null,
    },
  });
  const Native = window.SharedWorker;
  if (typeof Native !== 'function') return;
  window.SharedWorker = new Proxy(Native, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      if (args[1]?.name === sharedWorkerName) {
        worker.port.addEventListener('message', (event) =>
          messages.push(event.data),
        );
      }
      return worker;
    },
  });
}

/**
 * A fresh browser profile (its own IndexedDB, so its own Remote Control
 * identity) signed in with `cookie`. `leaderTab` removes SharedWorker so the
 * owner runs in the leader tab's dedicated worker.
 */
async function openProfile(cookie, { leaderTab = false } = {}) {
  const context = await browser.newContext({
    baseURL: REMOTE_CONTROL_WEB_ORIGIN,
  });
  if (leaderTab) {
    await context.addInitScript(() => {
      Reflect.deleteProperty(globalThis, 'SharedWorker');
    });
  }
  await context.addInitScript(teeOwnerPort, OWNER_SHARED_WORKER);
  await context.addCookies([cookie]);
  // Portal transport traffic: pairing by code and the per-session routes
  // (state, commands, events, chat history, files). The session status read
  // and the synced desktop inventory read carry no remote work.
  const remoteControlRequests = [];
  context.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/\/portal\/browser\/(sessions\/|connect\b)/.test(pathname))
      remoteControlRequests.push(request.url());
  });
  return {
    context,
    remoteControlRequests,
    page: null,
    deviceId: null,
    async open(route = '/chat') {
      const page = await context.newPage();
      await page.goto(route, { timeout: 300_000 });
      return page;
    },
    close: () => context.close().catch(() => undefined),
  };
}

function ownerState(page) {
  return page.evaluate(() => window.__directOwner?.state() ?? null);
}

async function waitForOwnerState(page, predicate, label) {
  let last = null;
  await expect
    .poll(
      async () => {
        last = await ownerState(page);
        return last !== null && predicate(last);
      },
      {
        ...POLL,
        timeout: 60_000,
        message: () => `${label}; last=${JSON.stringify(last)}`,
      },
    )
    .toBe(true);
  return last;
}

function projectRow(page) {
  return page.getByText(PROJECT_NAME).first();
}

function notice(page, state) {
  return page.locator(`${NOTICE}[data-state="${state}"]`);
}

async function setTabVisible(page, visible) {
  await page.evaluate((nextVisible) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (nextVisible ? 'visible' : 'hidden'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

/** Chrome's target ID for this context's SharedWorker owners. */
async function sharedWorkerTargets(cdp, page) {
  const pageSession = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter(
      (target) =>
        target.type === 'shared_worker' &&
        target.browserContextId === targetInfo.browserContextId,
    );
  } finally {
    await pageSession.detach().catch(() => undefined);
  }
}

/** Evaluates `expression` inside one worker target over the browser session. */
async function evaluateInTarget(cdp, targetId, expression) {
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: false,
  });
  try {
    const reply = new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== 1) return;
        cdp.off('Target.receivedMessageFromTarget', onMessage);
        resolve(message);
      };
      cdp.on('Target.receivedMessageFromTarget', onMessage);
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    });
    const message = await reply;
    if (message.error || message.result?.exceptionDetails) {
      throw new Error(`Worker evaluate failed: ${JSON.stringify(message)}`);
    }
    return message.result.result.value;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Accounts and the desktop
// ---------------------------------------------------------------------------

async function externalIdOf(userId) {
  return withRemoteControlDbClient(async (client) => {
    const result = await client.query(
      'SELECT external_id FROM users WHERE id = $1',
      [userId],
    );
    return result.rows[0].external_id;
  });
}

/** Another signed-in session for the same account (its own cookie). */
async function seedSessionCookie(userId) {
  const token = randomBytes(32).toString('hex');
  await withRemoteControlDbClient((client) =>
    client.query(
      `INSERT INTO "sessions" ("token", "expires_at", "user_id")
       VALUES ($1, $2, $3)`,
      [token, new Date(Date.now() + 24 * 60 * 60 * 1000), userId],
    ),
  );
  const signature = createHmac('sha256', REMOTE_CONTROL_BETTER_AUTH_SECRET)
    .update(token)
    .digest('base64');
  return seededSessionCookie(
    {
      cookie: {
        name: 'better-auth.session_token',
        value: `${token}.${signature}`,
      },
    },
    { webServer },
  );
}

async function browserControllers() {
  const state = await readRemoteControlState(desktop.window);
  return state.controllers.filter(
    (controller) => controller.kind === 'browser',
  );
}

/** Records the desktop's pairing events from here on. */
async function recordDesktopPairingEvents() {
  await desktop.window.evaluate(() => {
    window.__directWebPairingEvents = [];
    window.__directWebStopPairingEvents?.();
    window.__directWebStopPairingEvents =
      window.api.remoteControl.onPairingEvent((event) => {
        window.__directWebPairingEvents.push(event);
      });
  });
}

function desktopPairingEvents() {
  return desktop.window.evaluate(() => window.__directWebPairingEvents ?? []);
}

/**
 * The desktop's pairing link, on the harness web origin. The desktop builds
 * it from its cloud base (the server's loopback address); the seeded browser
 * session lives on `localhost`, the same server.
 */
function webPairingLink(link) {
  expect(
    link.startsWith(
      `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/portal/pair#device=`,
    ),
  ).toBe(true);
  return `${REMOTE_CONTROL_WEB_ORIGIN}${link.slice(REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK.length)}`;
}

async function openDesktopPairingLink() {
  const { link } = await desktop.window.evaluate(() =>
    window.api.remoteControl.openPairingWindow(),
  );
  return link;
}

async function forgetController(deviceId) {
  await desktop.window.evaluate(
    (id) =>
      window.api.remoteControl.forgetDevice({
        deviceId: id,
        role: 'controller',
      }),
    deviceId,
  );
}

function demoWorkspaceRoot() {
  return path.join(desktop.userDataDir, 'workspaces', WORKSPACE_ID);
}

/** Everything stored in the demo worktree's chats on the desktop. */
function worktreeChatText() {
  const root = demoWorkspaceRoot();
  return JSON.stringify(
    readChatStorageTabs(root, WORKTREE_ID).tabs.map(
      (tab) => readChatStorageMessages(root, WORKTREE_ID, tab.id) ?? [],
    ),
  );
}

async function mockBarrierWaiting(key, name) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/barrier?key=${encodeURIComponent(key)}`,
  );
  const body = await response.json();
  return body.barriers.find((barrier) => barrier.name === name)?.waiting ?? 0;
}

async function releaseMockBarrier(key, name) {
  await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });
}

/**
 * The open chat's composer. Each chat tab keeps its own panel mounted, so
 * only the visible composer is the open chat's.
 */
function composer(page) {
  return page
    .locator('[data-testid="remote-control-chat-composer"]:visible')
    .first();
}

/** Opens the desktop's demo worktree from the sidebar, ready to chat. */
async function openWorktree(page) {
  await page
    .locator(`[data-worktree-id="${WORKTREE_ID}"]`)
    .first()
    .click({ timeout: 60_000 });
  await expect(composer(page)).toBeVisible({ timeout: 60_000 });
}

/** A mock provider reply for one prompt carrying a fresh marker. */
async function registerChatReply(label) {
  const marker = `Canopy-CDIRECT${label}${randomBytes(4).toString('hex')}`;
  const reply = `Direct ${label.toLowerCase()} reply ${randomBytes(3).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  return { prompt: `[${marker}] Reply over direct.`, reply };
}

/**
 * Opens a new chat in the open worktree. The worktree opens on the desktop's
 * existing chats, and the mock provider answers the first marker in a chat's
 * history, so each later turn gets its own chat.
 */
async function openNewChat(page) {
  await page.locator('[data-testid^="panel-add-tab-"]').first().click();
  await page.getByRole('menuitem', { name: 'New chat' }).click();
  await expect(
    page.locator(':text("Send a message to start working"):visible').first(),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Sends `text` from the page's composer and waits for the desktop to store
 * the turn's reply and the page to show it.
 */
async function sendChat(page, text, reply) {
  await composer(page).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => worktreeChatText(), POLL).toContain(reply);
}

const SCRIPT_CONTEXT = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

/** The demo worktree's script actions as the desktop itself lists them. */
function desktopScriptActions() {
  return desktop.window.evaluate(
    (request) => window.api.scriptActions.list(request),
    SCRIPT_CONTEXT,
  );
}

async function desktopScriptStatus(name) {
  const snapshot = await desktopScriptActions();
  return snapshot.actions.find((action) => action.name === name)?.status;
}

/**
 * A bare repository whose one commit declares a package.json script, cloned
 * offline through its `file://` URL. Returns that URL.
 */
function seedScriptRepository(root, name) {
  const git = (cwd, args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd,
        encoding: 'utf8',
      },
    );
  const source = path.join(root, `${name}-source`);
  mkdirSync(source, { recursive: true });
  git(source, ['init', '-q', '-b', 'main']);
  writeFileSync(
    path.join(source, 'package.json'),
    `${JSON.stringify({ name, private: true, scripts: { check: 'echo ok' } }, null, 2)}\n`,
  );
  git(source, ['add', 'package.json']);
  git(source, ['commit', '-q', '-m', 'init']);
  const remote = path.join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', source, remote]);
  return `file://${remote}`;
}

test.beforeAll(async ({ remoteControlServerManager }) => {
  // A cold Turbopack compile of `/chat`, the pairing page and the owner's
  // worker chunk can take minutes; the budget absorbs it here.
  test.setTimeout(900_000);
  await ensureRemoteControlSchema();
  await truncateWebTestState();
  relay = await startDeviceRelay({ maxDevicesPerAccount: RELAY_DEVICE_CAP });
  webServer = await remoteControlServerManager.acquire(
    directWebServerOptions({ relay }),
  );
  await warmRemoteControlRoutes([
    { path: '/api/v1/device-relay/token', method: 'POST' },
  ]);

  userA = await seedRemoteControlWebUser({ name: 'Direct web owner' });
  userB = await seedRemoteControlWebUser({ name: 'Another account' });
  userC = await seedRemoteControlWebUser({ name: 'Device cap account' });
  desktop = await launchRemoteControlDesktop({
    relay,
    seeded: userA,
    seedBeforeLaunch: ({ userDataDir }) => {
      seedHookRun(userDataDir);
      seedTrackedPlans({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        plans: [
          buildTrackedPlan({
            id: SEEDED_PLAN.id,
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            title: SEEDED_PLAN.title,
            content: `# ${SEEDED_PLAN.title}\n\nSeeded for direct web.`,
          }),
        ],
      });
      seedStoredPipeline({
        userDataDir,
        id: SEEDED_PIPELINE.id,
        name: SEEDED_PIPELINE.name,
        yaml: [
          `name: ${SEEDED_PIPELINE.name}`,
          'on: dispatch',
          'jobs:',
          '  hello:',
          '    name: Hello',
          '    steps:',
          '      - id: say',
          '        name: Say hello',
          `        run: echo ${SEEDED_PIPELINE.output}`,
          '',
        ].join('\n'),
      });
    },
  });
  browser = await chromium.launch();
  primary = await openProfile(seededSessionCookie(userA, { webServer }));
  secondary = await openProfile(await seedSessionCookie(userA.userId));
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  await primary?.close();
  await secondary?.close();
  await browser?.close().catch(() => undefined);
  await desktop?.teardown();
  await webServer?.stop();
  await relay?.stop();
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test('link pairing: the browser opens the desktop pairing link and pairs by proof with no desktop prompt', async () => {
  test.setTimeout(600_000);
  await recordDesktopPairingEvents();
  // The desktop opens its pairing window from the Remote Control dialog;
  // Copy link hands over the QR code's link. The page's clipboard write is
  // captured instead of reaching the machine's shared clipboard.
  await desktop.app.openRemoteControlDialog();
  await expect(
    desktop.window.getByTestId('remote-control-pairing-qr-image'),
  ).toBeVisible({ timeout: 30_000 });
  await desktop.window.evaluate(() => {
    window.__directWebCopied = '';
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        window.__directWebCopied = text;
      },
    });
  });
  await desktop.window.getByTestId('remote-control-copy-link').click();
  let link = '';
  await expect
    .poll(async () => {
      link = await desktop.window.evaluate(() => window.__directWebCopied);
      return link.includes('#device=');
    }, POLL)
    .toBe(true);
  expect(link).toMatch(/#device=[A-Za-z0-9_-]{22}&secret=[A-Za-z0-9_-]{43}$/);
  expect(link).toContain(desktop.deviceId);

  primary.page = await primary.open(webPairingLink(link));
  await expect(
    primary.page.getByTestId('chat-connect-direct-connected'),
  ).toBeVisible({ timeout: 300_000 });
  // The secret left the address bar and history at once.
  expect(primary.page.url()).not.toContain('secret=');

  // Paired as a browser, by the link, without asking anyone on the desktop.
  await expect
    .poll(async () => (await browserControllers()).length, POLL)
    .toBe(1);
  const [controller] = await browserControllers();
  primary.deviceId = controller.deviceId;
  const events = await desktopPairingEvents();
  expect(events.filter((event) => event.type === 'request')).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'paired',
      deviceId: primary.deviceId,
      kind: 'browser',
      method: 'link',
    }),
  );
  expect(
    (await readRemoteControlState(desktop.window)).incomingPairings,
  ).toEqual([]);
  await expect(
    desktop.window.getByTestId('remote-control-paired'),
  ).toBeVisible();
  await desktop.window.getByTestId('remote-control-paired-done').click();

  await primary.page.getByTestId('chat-connect-direct-done').click();
  await expect(projectRow(primary.page)).toBeVisible({ timeout: 60_000 });
  expect(relay.connectedDeviceIds().has(primary.deviceId)).toBe(true);
  const state = await ownerState(primary.page);
  expect(state).toMatchObject({ connection: 'connected', failure: null });
  expect(state.computers).toContainEqual(
    expect.objectContaining({
      deviceId: desktop.deviceId,
      online: true,
      paired: 'paired',
      host: 'supported',
      session: 'open',
    }),
  );
  // Until a computer was selected, `/chat` may check for a Portal session
  // (it keeps one working until the browser pairs directly). From here on
  // this profile is served directly only.
  primary.remoteControlRequests.length = 0;
});

test('code pairing: the browser and the desktop show the same code and Allow on the desktop pairs it', async () => {
  test.setTimeout(240_000);
  await recordDesktopPairingEvents();
  secondary.page = await secondary.open('/chat?pair=1');
  await secondary.page
    .getByTestId(`chat-connect-direct-connect-${desktop.deviceId}`)
    .click({ timeout: 120_000 });
  const webCode = secondary.page.getByTestId('chat-connect-direct-code');
  await expect(webCode).toHaveText(/\d/, { timeout: 60_000 });
  const code = (await webCode.innerText()).replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);
  // Throws unless the desktop's prompt shows the same six digits.
  await answerDesktopPairingPrompt(desktop.window, { code, approve: true });

  await expect(
    secondary.page.getByTestId('chat-connect-direct-connected'),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await browserControllers()).length, POLL)
    .toBe(2);
  const added = (await browserControllers()).find(
    (controller) => controller.deviceId !== primary.deviceId,
  );
  secondary.deviceId = added.deviceId;
  const events = await desktopPairingEvents();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'request',
      pairing: expect.objectContaining({ kind: 'browser', code }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'paired',
      deviceId: secondary.deviceId,
      kind: 'browser',
      method: 'code',
    }),
  );
  await secondary.page.getByTestId('chat-connect-direct-done').click();
  await expect(projectRow(secondary.page)).toBeVisible({ timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// Chat over direct
// ---------------------------------------------------------------------------

test('chat: a message sent from /chat runs on the desktop and its reply streams back over direct', async () => {
  test.setTimeout(240_000);
  const marker = `Canopy-CDIRECTWEB${randomBytes(4).toString('hex')}`;
  const reply = `Direct reply ${randomBytes(3).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: reply, waitFor: 'reply', barrierTimeoutMs: 120_000 }],
    },
  });
  const page = primary.page;
  await openWorktree(page);
  const prompt = `[${marker}] Say hello over direct.`;
  await composer(page).click();
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');

  // The desktop runs the turn: the provider request is waiting on the
  // barrier, and the page already shows the prompt but no reply.
  await expect
    .poll(() => mockBarrierWaiting(marker, 'reply'), POLL)
    .toBeGreaterThan(0);
  await expect(page.getByText(prompt).first()).toBeVisible();
  await expect(page.getByText(reply)).toHaveCount(0);

  // Released, the reply reaches the open page as pushed chat events.
  await releaseMockBarrier(marker, 'reply');
  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => worktreeChatText(), POLL).toContain(reply);
  expect(worktreeChatText()).toContain(prompt);
  expect(primary.remoteControlRequests).toEqual([]);
  openChatReply = reply;
});

/** The open composer's text, without the editor's placeholder. */
function composerText(page) {
  return composer(page).evaluate((element) => {
    const copy = element.cloneNode(true);
    for (const node of copy.querySelectorAll('[data-slate-placeholder]'))
      node.remove();
    return (copy.textContent ?? '').replace(/\uFEFF/g, '').trim();
  });
}

/** Closes the open menu and deletes the `typed` text from the composer. */
async function clearComposer(page, typed) {
  await page.keyboard.press('Escape');
  for (let index = 0; index < typed.length; index += 1)
    await page.keyboard.press('Backspace');
  await expect.poll(() => composerText(page), POLL).toBe('');
}

test('composer menus: the open chat’s / and @ menus and its Plugins picker are served by the computer over direct', async () => {
  test.setTimeout(240_000);
  const page = primary.page;
  await expect(composer(page)).toBeVisible();
  expect(await composerText(page)).toBe('');

  // `/` lists the chat's inventory from the computer (CAN-7217).
  await composer(page).click();
  await page.keyboard.type('/');
  await expect(
    page
      .locator('[data-testid^="remote-control-chat-capability-"]:visible')
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await clearComposer(page, '/');

  // `@` searches the demo worktree's files on the computer.
  await page.keyboard.type('@status');
  await expect(
    page
      .locator('[data-testid="remote-control-chat-file-result"]:visible')
      .filter({ hasText: 'status.ts' })
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await clearComposer(page, '@status');

  // The Plugins picker reads the computer's catalog, which always lists the
  // app's built-in skills.
  await page
    .locator('[data-testid="remote-control-chat-plus-button"]:visible')
    .first()
    .click();
  await page.getByTestId('remote-control-chat-plus-plugins').click();
  const picker = page.getByTestId('remote-control-plugins-modal');
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(picker.getByText(/pipeline[- ]writing/i).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(picker.getByText(/^No plugins are available/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  expect(await composerText(page)).toBe('');
  expect(primary.remoteControlRequests).toEqual([]);
});

test('existing desktop chats: a chat started on the desktop lists in its worktree with its transcript over direct', async () => {
  test.setTimeout(240_000);
  const seeded = await registerChatReply('SEEDED');
  // The chat is created and run on the desktop itself, as its own composer
  // would; the browser has never seen it.
  const chatId = await desktop.window.evaluate(
    async ({ projectId, worktreeId }) => {
      const tabId = crypto.randomUUID();
      const created = await window.api.chat.command({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        projectId,
        worktreeId,
        command: { type: 'chat.create_tab', tabId },
      });
      return created.entityId ?? tabId;
    },
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  await desktop.window.evaluate(
    (request) => window.api.chat.sendMessage(request),
    {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      userMessageId: randomBytes(8).toString('hex'),
      text: seeded.prompt,
    },
  );
  await expect.poll(() => worktreeChatText(), POLL).toContain(seeded.reply);

  // A fresh load lists the desktop's chat in its worktree, and opening it
  // reads its transcript from the computer.
  const page = primary.page;
  await page.reload();
  await expect(projectRow(page)).toBeVisible({ timeout: 60_000 });
  await openWorktree(page);
  // The worktree's chat tabs sit in the panel strip, one per chat panel.
  const tab = page.getByTestId(`panel-tab-panel-chat-${chatId}`);
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await tab.click();
  await expect(page.getByText(seeded.reply).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(seeded.prompt).first()).toBeVisible();
  expect(primary.remoteControlRequests).toEqual([]);
  openChatReply = seeded.reply;
});

test('offline and reconnect: a quit desktop shows D1 with no stale rows, and the page resynchronizes when it returns', async () => {
  test.setTimeout(300_000);
  const page = primary.page;
  const quitPid = desktop.electronApp.process().pid;
  await desktop.quit();
  await relay.waitFor((ids) => !ids.has(desktop.deviceId), {
    label: 'the desktop to leave the relay',
  });
  const offline = notice(page, 'offline');
  await expect(offline).toBeVisible({ timeout: 60_000 });
  await expect(offline).toContainText('is offline');
  // The computer keeps its name; none of its rows stay on screen as live.
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
  await expect(page.getByText(openChatReply)).toHaveCount(0);
  const offlineState = await ownerState(page);
  expect(offlineState.connection).toBe('connected');
  expect(offlineState.computers).toContainEqual(
    expect.objectContaining({
      deviceId: desktop.deviceId,
      online: false,
      paired: 'paired',
    }),
  );

  await desktop.relaunch();
  // A new app process on the same data rejoined as the same computer.
  expect(desktop.electronApp.process().pid).not.toBe(quitPid);
  await expect(offline).toHaveCount(0, { timeout: 120_000 });
  await expect(projectRow(page)).toBeVisible({ timeout: 120_000 });
  // The open chat's transcript is read from the computer again.
  await expect(page.getByText(openChatReply).first()).toBeVisible({
    timeout: 60_000,
  });
  await waitForOwnerState(
    page,
    (state) =>
      state.computers.some(
        (computer) =>
          computer.deviceId === desktop.deviceId && computer.session === 'open',
      ),
    'the session to reopen',
  );
});

test('panels: a pipeline run, a tracked plan and a hook run the desktop finished list in their panels over direct', async () => {
  test.setTimeout(240_000);
  // A pipeline run the desktop finished, as its Dispatch modal starts one.
  const started = await desktop.window.evaluate(
    async ({ id, projectId, worktreeId }) => {
      const loaded = await window.pipelines.get(id);
      if (!loaded.success || !loaded.data) throw new Error(loaded.error);
      const cwd = await window.api.getWorktreePath({ projectId, worktreeId });
      return window.pipelines.execute(loaded.data.content, {
        cwd,
        pipelineId: id,
        projectId,
        worktreeId,
        scope: 'worktree',
        target: {
          scope: 'worktree',
          workspace_id: projectId,
          worktree_id: worktreeId,
          path: cwd,
          created: false,
        },
        eventName: 'dispatch',
      });
    },
    {
      id: SEEDED_PIPELINE.id,
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
    },
  );
  expect(started?.success, JSON.stringify(started)).toBe(true);
  const page = primary.page;
  primary.remoteControlRequests.length = 0;
  await page.reload();
  await expect(projectRow(page)).toBeVisible({ timeout: 60_000 });
  await openWorktree(page);
  const panel = page.locator('[data-testid="activity-panel"]:visible').first();
  // The seeded plan, the finished pipeline run and the finished hook run,
  // read from the computer as Portal's worktree snapshot carries them.
  await expect(panel.getByText(SEEDED_PLAN.title).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByText(SEEDED_PIPELINE.name).first()).toBeVisible({
    timeout: 60_000,
  });
  const completedHooks = panel.getByTestId('activity-hooks-completed-toggle');
  await expect(completedHooks).toBeVisible({ timeout: 60_000 });
  await completedHooks.click();
  await expect(panel.getByTestId('activity-hooks-completed')).toContainText(
    SEEDED_HOOK_RUN.label,
  );
  await expect(panel.getByTestId('activity-hooks-completed')).toContainText(
    'Success',
  );
  expect(primary.remoteControlRequests).toEqual([]);
});

// ---------------------------------------------------------------------------
// Host authorization for browser controllers
// ---------------------------------------------------------------------------

test('the desktop refuses a paired browser session’s forbidden invokes and never forwards forbidden pushes', async () => {
  test.setTimeout(180_000);
  const link = await openDesktopPairingLink();
  const secret = /&secret=([A-Za-z0-9_-]{43})$/.exec(link)[1];
  const controller = await pairTestBrowserController({
    relay,
    userExternalId: await externalIdOf(userA.userId),
    hostDeviceId: desktop.deviceId,
    proofSecret: new Uint8Array(Buffer.from(secret, 'base64url')),
  });
  let mainWindowClosed = false;
  try {
    const paired = (await browserControllers()).find(
      (entry) => entry.deviceId === controller.device.identity.deviceId,
    );
    expect(paired?.kind).toBe('browser');
    hostPublicKey = controller.pairing.hostPublicKey;
    const session = await controller.openSession();
    const transport = session.transport;
    const received = { stale: 0, preferences: 0, terminal: 0, found: 0 };
    transport.on('desktop:session-snapshot-stale', () => {
      received.stale += 1;
    });
    transport.on('preferences:synced', () => {
      received.preferences += 1;
    });
    transport.on('terminal:output', () => {
      received.terminal += 1;
    });
    // A post-add scan notice the desktop pushes to its own windows (CAN-6038):
    // web notices poll the receipt, so the browser never gets the push.
    transport.on('script-actions:found', () => {
      received.found += 1;
    });

    const snapshot = await settle(transport.invoke('desktop:session-snapshot'));
    expect(snapshot.ok, snapshot.message).toBe(true);

    // Script review is in the browser list (CAN-6038); terminals stay out.
    const scripts = await settle(
      transport.invoke('script-actions:list', SCRIPT_CONTEXT),
    );
    expect(scripts.ok, scripts.message).toBe(true);

    // Outside BROWSER_CONTROLLER_CHANNELS: terminals, chat interest
    // subscriptions and preferences reads.
    for (const [channel, args] of [
      ['terminal:spawn', [{ id: 'direct-web-forbidden', cwd: '/' }]],
      [
        'chat:set-interest',
        [{ projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID }],
      ],
      ['preferences:load', []],
    ]) {
      const refused = await settle(transport.invoke(channel, ...args));
      expect(refused.ok, channel).toBe(false);
      expect(refused.message, channel).toMatch(HOST_PROFILE_REFUSAL);
    }

    // A preferences save pushes `preferences:synced` (a tunneled push a
    // desktop controller receives) to the desktop's main window. This
    // session never gets it, while an allowed push sent after it arrives.
    await desktop.window.evaluate(() => {
      window.__directWebPreferencePushes = 0;
      window.api.onPreferencesSynced(() => {
        window.__directWebPreferencePushes += 1;
      });
    });
    await desktop.window.evaluate(async () => {
      // Two values, so at least one save is a change.
      await window.api.savePreferences({ chatDetail: 'compact' });
      await window.api.savePreferences({ chatDetail: 'detailed' });
    });
    await expect
      .poll(
        () => desktop.window.evaluate(() => window.__directWebPreferencePushes),
        POLL,
      )
      .toBeGreaterThan(0);
    // A desktop clone pushes `script-actions:found` to the desktop's
    // windows once its scan completes; this session never gets it.
    const foundRoot = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-direct-web-found-'),
    );
    try {
      const foundUrl = seedScriptRepository(foundRoot, 'direct-web-found');
      await desktop.window.evaluate(async (remoteUrl) => {
        window.__directWebFoundPushes = 0;
        window.api.scriptActions.onFound(() => {
          window.__directWebFoundPushes += 1;
        });
        const destinationDir = await window.api.getDefaultCloneDirectory();
        await window.api.addWorkspaceFromRemote({ remoteUrl, destinationDir });
      }, foundUrl);
      await expect
        .poll(
          () => desktop.window.evaluate(() => window.__directWebFoundPushes),
          POLL,
        )
        .toBeGreaterThan(0);
    } finally {
      rmSync(foundRoot, { recursive: true, force: true });
    }
    const invalidate = await settle(
      transport.invoke('desktop:session-snapshot-invalidate'),
    );
    expect(invalidate.ok, invalidate.message).toBe(true);
    await expect.poll(() => received.stale, POLL).toBeGreaterThan(0);
    expect(received.preferences).toBe(0);
    expect(received.terminal).toBe(0);
    expect(received.found).toBe(0);

    // Refusals leave the session usable.
    const after = await settle(transport.invoke('desktop:session-snapshot'));
    expect(after.ok, after.message).toBe(true);

    // macOS keeps the host alive without a local window. The browser must
    // still receive allowed pushes, not just successful invoke replies.
    if (process.platform === 'darwin') {
      const main = await desktop.electronApp.browserWindow(desktop.window);
      const mainId = await main.evaluate((window) => window.id);
      const closed = desktop.window.waitForEvent('close');
      await main.evaluate((window) => window.close());
      await closed;
      mainWindowClosed = true;
      // Playwright's page close can precede Electron's window destruction.
      await expect
        .poll(
          () =>
            desktop.electronApp.evaluate(
              ({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null,
              mainId,
            ),
          POLL,
        )
        .toBe(true);
      for (const noticesOnly of [false, true]) {
        const read = await settle(
          transport.invoke('desktop:session-snapshot', { noticesOnly }),
        );
        expect(read.ok, read.message).toBe(true);
      }
      const before = received.stale;
      const invalidated = await settle(
        transport.invoke('desktop:session-snapshot-invalidate'),
      );
      expect(invalidated.ok, invalidated.message).toBe(true);
      await expect.poll(() => received.stale, POLL).toBeGreaterThan(before);
      const refreshed = await settle(
        transport.invoke('desktop:session-snapshot', { noticesOnly: false }),
      );
      expect(refreshed.ok, refreshed.message).toBe(true);
      expect(received.preferences).toBe(0);
      expect(received.terminal).toBe(0);
      expect(received.found).toBe(0);
    }
  } finally {
    controller.stop();
    if (mainWindowClosed) await desktop.relaunch();
    await forgetController(controller.device.identity.deviceId);
  }
});

// ---------------------------------------------------------------------------
// Connection owner lifecycle (production worker loading, browser crypto)
// ---------------------------------------------------------------------------

test('owner: two tabs of one profile share one SharedWorker owner and one relay connection', async () => {
  test.setTimeout(180_000);
  const cdp = await browser.newBrowserCDPSession();
  try {
    const opened = relay.connectionsOpenedBy(primary.deviceId);
    const second = await primary.open('/chat');
    try {
      await expect(projectRow(second)).toBeVisible({ timeout: 60_000 });
      await waitForOwnerState(
        second,
        (state) => state.connection === 'connected',
        'the second tab to share the connection',
      );
      expect(await sharedWorkerTargets(cdp, second)).toHaveLength(1);
      expect(relay.connectionsOpenedBy(primary.deviceId)).toBe(opened);
      await expect(projectRow(primary.page)).toBeVisible();
    } finally {
      await second.close();
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
});

test('owner: with no visible tab the connection suspends after the hidden timeout and resumes with fresh auth', async () => {
  test.setTimeout(180_000);
  const cdp = await browser.newBrowserCDPSession();
  const second = await primary.open('/chat');
  try {
    await expect(projectRow(second)).toBeVisible({ timeout: 60_000 });
    const [owner] = await sharedWorkerTargets(cdp, primary.page);
    // Only the five-minute hidden-tab timer is shortened, inside the
    // production worker; everything else runs unchanged.
    await evaluateInTarget(
      cdp,
      owner.targetId,
      `(() => {
        const native = globalThis.setTimeout;
        globalThis.setTimeout = function (callback, ms, ...rest) {
          return native.call(this, callback, ms === ${HIDDEN_DISCONNECT_MS} ? 2000 : ms, ...rest);
        };
        return true;
      })()`,
    );
    const opened = relay.connectionsOpenedBy(primary.deviceId);
    await setTabVisible(primary.page, false);
    await setTabVisible(second, false);
    await relay.waitFor((ids) => !ids.has(primary.deviceId), {
      label: 'the hidden profile to leave the relay',
    });
    await waitForOwnerState(
      primary.page,
      (state) => state.connection === 'suspended',
      'the owner to suspend',
    );

    await setTabVisible(primary.page, true);
    await relay.waitFor((ids) => ids.has(primary.deviceId), {
      label: 'the profile to rejoin the relay',
    });
    expect(relay.connectionsOpenedBy(primary.deviceId)).toBeGreaterThan(opened);
    await waitForOwnerState(
      primary.page,
      (state) =>
        state.connection === 'connected' &&
        state.computers.some(
          (computer) =>
            computer.deviceId === desktop.deviceId &&
            computer.session === 'open',
        ),
      'the owner to resume and reopen the session',
    );
    await expect(projectRow(primary.page)).toBeVisible({ timeout: 60_000 });
  } finally {
    await second.close();
    await cdp.detach().catch(() => undefined);
  }
});

test('owner: without SharedWorker the leader tab owns the connection and another tab takes over when it closes', async () => {
  test.setTimeout(300_000);
  const profile = await openProfile(await seedSessionCookie(userA.userId), {
    leaderTab: true,
  });
  let deviceId = null;
  try {
    const leader = await profile.open(
      webPairingLink(await openDesktopPairingLink()),
    );
    await expect(
      leader.getByTestId('chat-connect-direct-connected'),
    ).toBeVisible({
      timeout: 120_000,
    });
    await leader.getByTestId('chat-connect-direct-done').click();
    await expect(projectRow(leader)).toBeVisible({ timeout: 60_000 });
    const known = new Set([primary.deviceId, secondary.deviceId]);
    deviceId = (await browserControllers()).find(
      (controller) => !known.has(controller.deviceId),
    )?.deviceId;
    expect(deviceId).toBeTruthy();
    expect(leader.workers()).toHaveLength(1);

    const follower = await profile.open('/chat');
    await expect(projectRow(follower)).toBeVisible({ timeout: 60_000 });
    expect(follower.workers()).toHaveLength(0);
    const opened = relay.connectionsOpenedBy(deviceId);

    await leader.close();
    await expect.poll(() => follower.workers().length, POLL).toBe(1);
    await relay.waitFor(() => relay.connectionsOpenedBy(deviceId) > opened, {
      label: 'the new leader to connect',
    });
    await expect(projectRow(follower)).toBeVisible({ timeout: 60_000 });
    // The new leader carries a whole chat turn.
    const turn = await registerChatReply('LEADER');
    await openWorktree(follower);
    await openNewChat(follower);
    await sendChat(follower, turn.prompt, turn.reply);
  } finally {
    await profile.close();
    if (deviceId) await forgetController(deviceId);
  }
});

test('owner: a key store that cannot be opened fails as identity_unavailable without joining the relay', async () => {
  test.setTimeout(180_000);
  const profile = await openProfile(await seedSessionCookie(userA.userId));
  try {
    const page = await profile.context.newPage();
    await page.goto('/robots.txt');
    // The account key store, already at a newer schema: opening it fails,
    // while the support probes (their own databases) still pass.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('canopy-remote-control', 99);
          request.onsuccess = () => {
            request.result.close();
            resolve(undefined);
          };
          request.onerror = () => reject(request.error);
        }),
    );
    const before = relay.connectedDeviceIds();
    await page.goto('/chat', { timeout: 300_000 });
    const state = await waitForOwnerState(
      page,
      (current) => current.connection === 'failed',
      'the owner to fail',
    );
    expect(state).toMatchObject({
      failure: 'identity_unavailable',
      computers: [],
    });
    await expect(notice(page, 'failure')).toBeVisible({ timeout: 30_000 });
    expect(
      [...relay.connectedDeviceIds()].filter((id) => !before.has(id)),
    ).toEqual([]);
  } finally {
    await profile.close();
  }
});

test('owner: the relay’s device cap refuses another browser as too_many_devices', async () => {
  test.setTimeout(180_000);
  const externalId = await externalIdOf(userC.userId);
  const { generateDeviceIdentity } = await import('@canopy/remote-session');
  const devices = [];
  const profile = await openProfile(seededSessionCookie(userC, { webServer }));
  try {
    for (let index = 0; index < RELAY_DEVICE_CAP; index += 1) {
      devices.push(
        await connectTestRelayDevice({
          relay,
          userExternalId: externalId,
          identity: await generateDeviceIdentity(),
          kind: 'browser',
          name: `Cap filler ${String(index + 1)}`,
        }),
      );
    }
    const page = await profile.open('/chat');
    const state = await waitForOwnerState(
      page,
      (current) => current.failure === 'too_many_devices',
      'the owner to report the device cap',
    );
    expect(state.computers).toEqual([]);
    const fillers = new Set(devices.map((device) => device.identity.deviceId));
    expect([...relay.refusedOverLimit()].some((id) => !fillers.has(id))).toBe(
      true,
    );
    await expect(notice(page, 'too-many-devices')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    for (const device of devices) device.stop();
    await profile.close();
  }
});

// ---------------------------------------------------------------------------
// Synced desktop inventory and the Marketplace
// ---------------------------------------------------------------------------

test('inventory: the synced desktop inventory and the Marketplace serve over direct', async () => {
  // CAN-7262 added one more Allow incoming off/on cycle (a relay leave and
  // rejoin) to prove the unpause report clears the paused flag.
  test.setTimeout(720_000);
  const profile = await openProfile(await seedSessionCookie(userA.userId));
  try {
    const page = await profile.open('/account/plugins');

    // The account read serves the documents the desktop pushed, including the
    // installed-item snapshot (CAN-6037).
    const readInventory = () =>
      page.evaluate(async () => {
        const response = await fetch('/api/account/desktop-inventory');
        return { status: response.status, body: await response.json() };
      });
    await expect
      .poll(
        async () => {
          const { status, body } = await readInventory();
          return status === 200 &&
            body.device !== null &&
            body.documents.some(
              (document) => document.kind === 'installed_items',
            )
            ? 'synced'
            : status;
        },
        { timeout: 120_000 },
      )
      .toBe('synced');
    const inventory = (await readInventory()).body;
    const installedItems = inventory.documents.find(
      (document) => document.kind === 'installed_items',
    );
    expect(Array.isArray(installedItems.payload.items)).toBe(true);
    for (const item of installedItems.payload.items) {
      expect(typeof item.target.kind).toBe('string');
      expect(typeof item.removable).toBe('boolean');
      expect(Array.isArray(item.notices)).toBe(true);
    }

    // The Marketplace lists answer, and the desktop's manifest read is
    // admitted.
    const catalogStatuses = await page.evaluate(async () =>
      Promise.all(
        [
          '/api/account/pipeline-catalog/pipelines?limit=25',
          '/api/account/automation-catalog/automations?limit=25',
        ].map(async (path) => (await fetch(path)).status),
      ),
    );
    expect(catalogStatuses).toEqual([200, 200]);
    const manifest = await fetch(
      `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/api/v1/desktop-app/desktop-inventory/documents?clientDeviceId=${encodeURIComponent(inventory.device.clientDeviceId)}`,
      { headers: { Authorization: `Bearer ${userA.apiKey}` } },
    );
    expect(manifest.status).toBe(200);

    // Settings → Plugins counts the synced snapshot instead of asking to
    // connect the desktop, and says when it was synced (CAN-6037).
    await page.goto('/account/plugins');
    const activeItems = page.getByTestId('settings-plugins-active');
    await expect(
      activeItems.getByTestId('active-items-summary-counts'),
    ).toHaveText(/(?:are|is) active\.$|^Nothing is active yet\.$/, {
      timeout: 60_000,
    });
    await expect(
      activeItems.getByTestId('active-items-summary-synced-at'),
    ).toHaveText(/^Updated (?:just now|\d+[smhd] ago)$/);

    // The desktop's inventory sync gate opens on direct Remote Control
    // (CAN-6037), so a relaunch re-sends the installed-item snapshot.
    const syncedBefore = installedItems.syncedAt;
    await desktop.relaunch();
    await expect
      .poll(
        async () => {
          const { body } = await readInventory();
          const document = body.documents?.find(
            (candidate) => candidate.kind === 'installed_items',
          );
          return document !== undefined && document.syncedAt > syncedBefore;
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    // Opting out (CAN-5986). The documents DELETE needs an account and
    // touches only that account's rows for the device: another account's
    // delete of this device removes nothing.
    const documentsUrl = `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/api/v1/desktop-app/desktop-inventory/documents?clientDeviceId=${encodeURIComponent(inventory.device.clientDeviceId)}`;
    const ownDocumentCount = async () => {
      const response = await fetch(documentsUrl, {
        headers: { Authorization: `Bearer ${userA.apiKey}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()).documents.length;
    };
    expect((await fetch(documentsUrl, { method: 'DELETE' })).status).toBe(401);
    const otherAccountDelete = await fetch(documentsUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userB.apiKey}` },
    });
    expect(otherAccountDelete.status).toBe(200);
    expect(await otherAccountDelete.json()).toEqual({ deleted: 0 });
    expect(await ownDocumentCount()).toBeGreaterThan(0);

    // Allow incoming off pauses uploads but never the opt-out. With no
    // computers to control, the desktop also leaves the relay.
    const allowOff = await desktop.window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(false),
    );
    expect(allowOff.allowIncoming).toBe(false);
    await relay.waitFor((ids) => !ids.has(desktop.deviceId), {
      label: 'the desktop to leave the relay',
    });

    // With the switch on and Allow incoming off, the desktop reports its
    // uploads paused, and the account read says so (CAN-7262).
    const readUploadsPaused = async () =>
      (await readInventory()).body.device?.uploadsPaused;
    await expect
      .poll(async () => (await readUploadsPaused())?.reason, {
        ...POLL,
        timeout: 60_000,
      })
      .toBe('allow_incoming_off');
    const pausedSince = (await readUploadsPaused())?.since;
    expect(typeof pausedSince).toBe('string');
    expect(new Date(pausedSince).toISOString()).toBe(pausedSince);

    // Turning this computer's sync switch off deletes its documents on the
    // web, and the settings row returns to idle once the delete lands.
    const optedOut = await desktop.window.evaluate(() =>
      window.api.remoteControl.setInventorySyncEnabled(false),
    );
    expect(optedOut.inventorySyncEnabled).toBe(false);
    await expect.poll(ownDocumentCount, { ...POLL, timeout: 90_000 }).toBe(0);
    await expect
      .poll(
        async () =>
          (await readRemoteControlState(desktop.window)).inventoryDeleteStatus,
        { ...POLL, timeout: 60_000 },
      )
      .toBe('idle');
    expect(await readInventory()).toEqual({
      status: 200,
      body: { device: null, documents: [] },
    });

    // Turning it back on uploads nothing while Allow incoming is off (past
    // the push debounce), and the lists upload again once it is on.
    await desktop.window.evaluate(() =>
      window.api.remoteControl.setInventorySyncEnabled(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(await ownDocumentCount()).toBe(0);
    await desktop.window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(true),
    );
    await relay.waitFor((ids) => ids.has(desktop.deviceId), {
      label: 'the desktop to rejoin the relay',
    });
    await expect
      .poll(
        async () =>
          (await readInventory()).body.documents?.some(
            (candidate) => candidate.kind === 'installed_items',
          ) ?? false,
        { timeout: 120_000 },
      )
      .toBe(true);
    expect(await ownDocumentCount()).toBeGreaterThan(0);
    // The opt-out removed the device's status row with its documents.
    await expect
      .poll(readUploadsPaused, { ...POLL, timeout: 60_000 })
      .toBeUndefined();

    // One more cycle with the documents in place: Allow incoming off pauses,
    // and turning it back on reports the unpause, which alone clears the
    // flag when nothing changed (no document PUT is sent).
    await desktop.window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(false),
    );
    await expect
      .poll(async () => (await readUploadsPaused())?.reason, {
        ...POLL,
        timeout: 60_000,
      })
      .toBe('allow_incoming_off');
    await desktop.window.evaluate(() =>
      window.api.remoteControl.setAllowIncoming(true),
    );
    await relay.waitFor((ids) => ids.has(desktop.deviceId), {
      label: 'the desktop to rejoin the relay after the pause',
    });
    await expect
      .poll(readUploadsPaused, { ...POLL, timeout: 60_000 })
      .toBeUndefined();
    // The paired browser the later cases drive reconnects on its own.
    if (primary?.page) {
      await waitForOwnerState(
        primary.page,
        (state) =>
          state.computers.some(
            (computer) =>
              computer.deviceId === desktop.deviceId &&
              computer.session === 'open',
          ),
        'the paired browser to reconnect',
      );
    }
  } finally {
    await profile.close();
  }
});

test('script review: a direct browser reviews detected scripts, and the desktop sees the decision', async () => {
  test.setTimeout(300_000);
  const page = primary.page;
  const packagePath = path.join(
    desktop.demo.workspaces[0].worktreePath,
    'package.json',
  );
  const originalPackage = readFileSync(packagePath, 'utf8');
  const repositoryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-direct-web-scripts-'),
  );
  const fromBrowser = `direct-web-browser-${randomBytes(3).toString('hex')}`;
  const fromDesktop = `direct-web-desktop-${randomBytes(3).toString('hex')}`;
  try {
    // Two detected scripts: one approved from the browser, one from the
    // desktop.
    const manifest = JSON.parse(originalPackage);
    writeFileSync(
      packagePath,
      `${JSON.stringify(
        {
          ...manifest,
          scripts: {
            ...manifest.scripts,
            [fromBrowser]: 'echo browser',
            [fromDesktop]: 'echo desktop',
          },
        },
        null,
        2,
      )}\n`,
    );
    await desktop.window.evaluate(
      (request) => window.api.scriptActions.rescan(request),
      SCRIPT_CONTEXT,
    );
    await expect
      .poll(
        async () => [
          await desktopScriptStatus(fromBrowser),
          await desktopScriptStatus(fromDesktop),
        ],
        POLL,
      )
      .toEqual(['pending', 'pending']);

    // The worktree panel's Detected scripts opens the shared review over
    // direct, and an approval there lands on the desktop.
    primary.remoteControlRequests.length = 0;
    await page.reload();
    await expect(projectRow(page)).toBeVisible({ timeout: 60_000 });
    await openWorktree(page);
    await page
      .locator('[data-testid="script-actions-review-entry-open"]:visible')
      .first()
      .click({ timeout: 60_000 });
    const review = page.getByTestId('script-actions-review');
    await expect(review).toBeVisible({ timeout: 30_000 });
    await review
      .locator(
        `[data-testid="script-actions-pending-row"][data-script-name="${fromBrowser}"] [data-testid="script-actions-row-select"]`,
      )
      .click();
    await review.getByTestId('script-actions-approve').click();
    await expect
      .poll(() => desktopScriptStatus(fromBrowser), POLL)
      .toBe('approved');
    const approvedRow = (name) =>
      review.locator(
        `[data-testid="script-actions-approved-row"][data-script-name="${name}"]`,
      );
    await expect(approvedRow(fromBrowser)).toBeVisible();

    // A desktop approval reaches the open review without a reload: the
    // `script-actions:changed` push refreshes the snapshot.
    await desktop.window.evaluate(
      async ({ request, name }) => {
        const snapshot = await window.api.scriptActions.list(request);
        const action = snapshot.actions.find((entry) => entry.name === name);
        await window.api.scriptActions.review({
          ...request,
          entries: [{ id: action.id, revision: action.revision }],
          decision: 'approve',
        });
      },
      { request: SCRIPT_CONTEXT, name: fromDesktop },
    );
    await expect(approvedRow(fromDesktop)).toBeVisible({ timeout: 30_000 });
    expect(primary.remoteControlRequests).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();

    // A clone from the browser polls its scan receipt and offers Review.
    const remoteUrl = seedScriptRepository(repositoryRoot, 'direct-web-notice');
    await page.getByTestId('remote-control-workspaces-header').hover();
    await page.getByTestId('remote-control-add-workspace').click();
    const dialog = page.getByTestId('chat-add-workspace-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('chat-add-workspace-destination-device').click();
    await dialog.getByTestId('chat-add-workspace-value').fill(remoteUrl);
    await dialog.getByTestId('chat-add-workspace-submit').click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });
    const notice = page
      .getByTestId('toast-stack-card')
      .filter({ hasText: /Found .+ in direct-web-notice to review/ });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice.getByTestId('toast-action')).toHaveText('Review');
    expect(primary.remoteControlRequests).toEqual([]);
  } finally {
    writeFileSync(packagePath, originalPackage, 'utf8');
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sign-out, other accounts, revocation
// ---------------------------------------------------------------------------

test('signing out detaches the owner: the profile leaves the relay and the page keeps no remote state', async () => {
  test.setTimeout(180_000);
  const page = secondary.page;
  await expect(projectRow(page)).toBeVisible({ timeout: 60_000 });
  expect(relay.connectedDeviceIds().has(secondary.deviceId)).toBe(true);
  await page.getByTestId('sidebar-account-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  // Either landing ends the session on the page: a slow server lands on the
  // unconfirmed one, which finishes the sign-out (CAN-6370).
  await page.waitForURL(/\/login\?signedOut=(?:1|unconfirmed)$/, {
    timeout: 60_000,
  });
  await relay.waitFor((ids) => !ids.has(secondary.deviceId), {
    label: 'the signed-out profile to leave the relay',
  });
  await page.goto('/chat');
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
  expect(relay.connectedDeviceIds().has(secondary.deviceId)).toBe(false);
});

test('another account’s browser cannot see or reach this computer', async () => {
  test.setTimeout(180_000);
  const other = await openProfile(seededSessionCookie(userB, { webServer }));
  try {
    const page = await other.open('/chat?pair=1');
    const state = await waitForOwnerState(
      page,
      (current) => current.connection === 'connected',
      'the other account to connect',
    );
    expect(state.computers).toEqual([]);
    await expect(page.getByTestId('chat-connect-device-dialog')).toBeVisible();
    await expect(
      page.getByTestId(`chat-connect-direct-computer-${desktop.deviceId}`),
    ).toHaveCount(0);

    // A browser device of that account, even holding this computer's key,
    // never sees it on the relay and cannot open a session to it.
    const { generateDeviceIdentity } = await import('@canopy/remote-session');
    const probe = await connectTestRelayDevice({
      relay,
      userExternalId: await externalIdOf(userB.userId),
      identity: await generateDeviceIdentity(),
      kind: 'browser',
    });
    try {
      expect(
        probe.client.peers.some((peer) => peer.deviceId === desktop.deviceId),
      ).toBe(false);
      expect(hostPublicKey).toBeTruthy();
      const reach = await settle(
        probe.sessions.connect({
          peerDeviceId: desktop.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: hostPublicKey,
          delegation: null,
        }),
      );
      expect(reach.ok).toBe(false);
    } finally {
      probe.stop();
    }
  } finally {
    await other.close();
  }
});

test('removing the browser in desktop Settings ends its control: the page asks to pair again', async () => {
  test.setTimeout(180_000);
  const page = primary.page;
  await expect(projectRow(page)).toBeVisible({ timeout: 60_000 });
  await desktop.app.openSettings();
  await desktop.window.getByTestId('settings-nav-remote-access').click();
  const row = desktop.window.getByTestId(
    `settings-remote-access-controller-${primary.deviceId}`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('Browser');
  await desktop.window
    .getByTestId(`settings-remote-access-controller-remove-${primary.deviceId}`)
    .click();
  await desktop.window
    .getByTestId('settings-remote-access-remove-confirm')
    .click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  expect(
    (await browserControllers()).some(
      (controller) => controller.deviceId === primary.deviceId,
    ),
  ).toBe(false);

  await expect(notice(page, 'pair-again')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
  await waitForOwnerState(
    page,
    (state) =>
      state.computers.some(
        (computer) =>
          computer.deviceId === desktop.deviceId &&
          computer.paired === 'unpaired',
      ),
    'the owner to drop the pairing',
  );
  // A fresh load stays unpaired: the desktop refuses the old key.
  await page.reload();
  await expect(notice(page, 'pair-again')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
});
