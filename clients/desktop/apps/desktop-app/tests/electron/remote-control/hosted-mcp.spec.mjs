// Hosted MCP Remote Control over the direct device-relay protocol (CAN-5985),
// end to end: the real web server and Postgres, the real relay, the E2E
// desktop, and an outside agent with a real OAuth grant on
// `/api/v1/mcp/tasks`. Hosted pairing runs through the SSE route and the
// desktop's own approval prompt. Test-driven protocol clients present the
// hosted credentials directly to prove the desktop and relay, not just the
// web server, refuse what agents must not do. The direct Tasks tools run
// against what the desktop holds: seeded plans, a pipeline, a cowork project,
// a secret question and worktree changes, with mock provider turns.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { expect, test } from './harness/fixtures.mjs';
import { REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK } from './harness/config.mjs';
import { ensureRemoteControlSchema } from './harness/remoteControlHarness.mjs';
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
  seedCoworkWorkspace,
  seedStoredPipeline,
  seedTrackedPlans,
  seedWorktreeChat,
} from '../seeders/index.mjs';
import {
  readChatStorageMessages,
  readChatStorageTabs,
} from '../readChatStorage.mjs';
import { startDeviceRelay } from './relay.mjs';
import {
  directWebServerOptions,
  launchRemoteControlDesktop,
  listHostedComputers,
  pairHostedAgents,
  readHostedLeases,
  readHostedLinks,
  readRemoteControlState,
  sameOriginJsonHeaders,
  startHostedPairing,
  waitForRemoteControlState,
} from './directWebHarness.mjs';
import {
  attemptDelegatedHandshake,
  connectTestRelayDevice,
  loadHostedRootIdentity,
  openDelegatedTestSession,
  settle,
} from './hostedController.mjs';
import { connectTasksAgent } from './mcpAgent.mjs';

test.describe.configure({ mode: 'serial' });

const PROJECT_NAME = 'TypeScript pnpm Vite';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SEEDED_CHAT = { id: 'hosted-seed', title: 'Hosted agents seed' };
/** A chat whose agent asked for a credential: only the person may answer. */
const SECRET_CHAT = {
  id: 'hosted-secret',
  title: 'Hosted secret question',
  questionId: 'hosted-secret-question',
  question: 'Paste the deploy token',
};
const COWORK = { id: 'hosted-cowork', name: 'Hosted cowork' };
const PLAN = { id: 'hosted-agents-plan', title: 'Hosted agents plan' };
const PIPELINE = {
  id: 'hosted-agents-pipeline',
  name: 'Hosted agents pipeline',
  output: 'HOSTED_PIPELINE_RAN',
};
/** The desktop's refusal for a channel or argument outside the profile. */
const HOST_PROFILE_REFUSAL =
  /is not available while controlling another computer/;
/** `HOSTED_SECRET_ANSWER_REFUSAL` in hosted-chat-dispatch.ts. */
const SECRET_ANSWER_REFUSAL = "Agents can't answer a secret question.";
/** The brand's injected AskUserQuestion tool for Claude chats. */
const ASK_USER_TOOL = 'mcp__canopy_ui__AskUserQuestion';
/** `task_diff_get`'s patch bound (Portal's `MAX_PATCH_BYTES`). */
const MAX_PATCH_BYTES = 32_768;
const POLL = { timeout: 30_000, intervals: [250, 500, 1_000] };
/** Polls of the agent's tools, within its 60 calls a minute. */
const TOOL_POLL = { timeout: 30_000, intervals: [1_000, 2_000] };
/** The reply to a Work Entry chat's opening message (`startWorkEntryChat`). */
const OPEN_STEPS = { open: [{ text: 'Note opened.', stopReason: 'end_turn' }] };

let relay = null;
let webServer = null;
let browser = null;
let desktop = null;
let userA = null;
let userB = null;
let agentA = null;
let agentB = null;
/** Resolved once pairing succeeds: host code, project and worktree. */
const target = {};

function randomRelayDeviceId() {
  return randomBytes(16).toString('base64url');
}

async function hostedControllers() {
  const state = await readRemoteControlState(desktop.window);
  return state.controllers.filter((controller) => controller.kind === 'hosted');
}

async function hostedRootDeviceId() {
  const [root] = await hostedControllers();
  if (!root) throw new Error('The desktop has no hosted agents pairing.');
  return root.deviceId;
}

/** The paired link: relay device, host code and the desktop's pinned key. */
async function pairedLink(userId) {
  const links = await readHostedLinks(userId);
  return links.find((link) => link.relay_device_id !== null) ?? null;
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

async function openAgent(seeded) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const agent = await connectTasksAgent(page, seeded, { webServer });
  // The suite makes more tool calls than a connection's 60 a minute. A call
  // refused by that limit never ran, so it waits out the window and calls
  // again.
  async function call(name, args) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await agent.call(name, args);
      if (result.structuredContent?.code !== 'rate_limited' || attempt === 5) {
        return result;
      }
      const seconds = result.structuredContent.retryAfterSeconds ?? 1;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    }
  }
  async function ok(name, args) {
    const result = await call(name, args);
    if (result.isError) {
      throw new Error(
        `MCP ${name} returned an error: ${JSON.stringify(result.structuredContent)}`,
      );
    }
    return result.structuredContent;
  }
  return { ...agent, call, ok, close: () => context.close() };
}

function expectToolError(result, code, reason) {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  expect(result.structuredContent.code).toBe(code);
  if (reason !== undefined) {
    expect(result.structuredContent.details?.reason).toBe(reason);
  }
}

function workspaceRoot(workspaceId) {
  return path.join(desktop.userDataDir, 'workspaces', workspaceId);
}

function chatMessages(workspaceId, scopeId, chatId) {
  return readChatStorageMessages(workspaceRoot(workspaceId), scopeId, chatId);
}

function demoWorktreePath() {
  return desktop.demo.workspaces[0].worktreePath;
}

/** Polls `task_chat_get` until `predicate` holds for the chat; returns it. */
async function waitForChat({ taskId, chatId }, predicate, message) {
  let chat = null;
  try {
    await expect
      .poll(async () => {
        chat = (
          await agentA.ok('task_chat_get', {
            host: target.host,
            taskId,
            chatId,
          })
        ).chat;
        return predicate(chat);
      }, TOOL_POLL)
      .toBe(true);
  } catch (error) {
    throw new Error(`${message}; last=${JSON.stringify(chat)}`, {
      cause: error,
    });
  }
  return chat;
}

function chatIdsOf(taskId) {
  return agentA
    .ok('task_get', { host: target.host, taskId })
    .then((read) => read.chats.map((chat) => chat.chatId));
}

/** How long a direct create may stay in progress while its checkout sets up. */
const CREATE_POLL = { timeout: 120_000, intervals: [1_000, 2_000] };

/**
 * Calls `task_create` with one idempotency key until it settles. A direct
 * code task's first chat waits for its checkout: until Git setup finishes the
 * call returns `host_in_progress` naming the task, and calling again with the
 * same key creates the chat and sends the prompt. An answer given before the
 * host reports the task names none. Returns the settled result and the task
 * IDs the in-progress answers named.
 */
async function createTaskSettled(args) {
  const input = { host: target.host, idempotencyKey: randomUUID(), ...args };
  const pendingTaskIds = [];
  let result = null;
  try {
    await expect
      .poll(async () => {
        result = await agentA.call('task_create', input);
        if (result.structuredContent?.code !== 'host_in_progress') return true;
        const pendingTaskId = result.structuredContent.details?.task_id;
        if (pendingTaskId !== undefined) pendingTaskIds.push(pendingTaskId);
        return false;
      }, CREATE_POLL)
      .toBe(true);
  } catch (error) {
    throw new Error(
      `task_create did not settle; last=${JSON.stringify(result?.structuredContent)}`,
      { cause: error },
    );
  }
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
  return { created: result.structuredContent, pendingTaskIds };
}

/**
 * Starts an empty chat on the computer over a raw hosted session with the
 * `chat.create_tab` the hosted profile allows, so the spec knows the desktop
 * tab ID it reads from storage. The agent-facing `task_create` and
 * `task_chat_create` are covered by their own cases. Returns the desktop tab
 * ID and the Tasks chat ID the agent reads it under.
 */
async function startHostedChat({ taskId, projectId, worktreeId }) {
  const before = await chatIdsOf(taskId);
  const tabId = randomUUID();
  const session = await openHostedSession();
  try {
    const created = await settle(
      session.transport.invoke('chat:command', {
        ...chatEnvelope(projectId, worktreeId),
        command: { type: 'chat.create_tab', tabId },
      }),
    );
    expect(created.ok, created.message).toBe(true);
    expect(created.value, JSON.stringify(created.value)).toMatchObject({
      outcome: 'applied',
    });
  } finally {
    session.stop();
  }
  let added = [];
  await expect
    .poll(async () => {
      added = (await chatIdsOf(taskId)).filter((id) => !before.includes(id));
      return added.length;
    }, TOOL_POLL)
    .toBe(1);
  return { tabId, taskId, chatId: added[0] };
}

/**
 * A Work Entry in the cowork project with one chat, made over a raw hosted
 * session so the spec knows the entry ID: an empty entry, its chat, and an
 * opening message (a Work Entry chat is listed once it has one). The desktop
 * reuses an empty entry, so the chat may land in an existing task. Resolves
 * once that opening turn has ended, with it as `opening`. `marker`'s scenario
 * answers the opening message under its `open` request tag
 * ({@link OPEN_STEPS}).
 */
async function startWorkEntryChat(coworkProjectId, marker) {
  const session = await openHostedSession();
  let entryId;
  try {
    const entry = await settle(
      session.transport.invoke('work-entries:create', { projectId: COWORK.id }),
    );
    expect(entry.ok, entry.message).toBe(true);
    entryId = entry.value.entry.id;
    const tabId = randomUUID();
    for (const command of [
      { type: 'chat.create_tab', tabId },
      {
        type: 'chat.send_message',
        chatId: tabId,
        userMessageId: randomUUID(),
        text: `[${marker}] [Canopy-Mock-Request:open] Open a note.`,
      },
    ]) {
      const sent = await settle(
        session.transport.invoke('chat:command', {
          ...chatEnvelope(COWORK.id, entryId),
          command,
        }),
      );
      expect(sent.ok, sent.message).toBe(true);
      expect(sent.value, JSON.stringify(sent.value)).toMatchObject({
        outcome: 'applied',
      });
    }
  } finally {
    session.stop();
  }
  // The entry and its chat are titled by the opening message.
  let taskId = null;
  await expect
    .poll(async () => {
      const listed = await agentA.ok('task_list', {
        host: target.host,
        projectId: coworkProjectId,
        limit: 50,
      });
      taskId =
        listed.items.find(
          (item) => item.kind === 'work_entry' && item.title.includes(marker),
        )?.taskId ?? null;
      return taskId;
    }, TOOL_POLL)
    .not.toBeNull();
  const { chats } = await agentA.ok('task_get', {
    host: target.host,
    taskId,
  });
  const opened = chats.find((item) => item.title.includes(marker));
  expect(opened, JSON.stringify(chats)).toBeTruthy();
  const task = { taskId, chatId: opened.chatId };
  const chat = { entryId, ...task };
  const ended = await waitForChat(
    chat,
    (current) =>
      current.lastTurn !== null &&
      !['queued', 'running'].includes(current.lastTurn.status),
    'the opening turn to end',
  );
  return { ...chat, opening: ended.lastTurn };
}

/** Sends `text` to a chat as the agent, as a plain queued message. */
async function sendToChat(chat, text) {
  const sent = await agentA.ok('task_chat_send', {
    host: target.host,
    taskId: chat.taskId,
    chatId: chat.chatId,
    text,
    idempotencyKey: randomUUID(),
  });
  expect(sent.receipt.operation).toBe('task_chat_send');
  expect(sent.chatId).toBe(chat.chatId);
  return sent;
}

/**
 * The chat read live. A worktree chat's cached read comes from the task
 * listing, which names no turn until it ends; a live read (one of the
 * connection's per-minute live reads) names the running one.
 */
async function readChatLive(chat) {
  return (
    await agentA.ok('task_chat_get', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      noCache: true,
    })
  ).chat;
}

/** A delegated hosted session to the paired desktop, as the pool opens one. */
async function openHostedSession() {
  return openDelegatedTestSession({
    relay,
    userExternalId: await externalIdOf(userA.userId),
    root: await loadHostedRootIdentity(userA.userId),
    host: { deviceId: desktop.deviceId, publicKey: target.hostPublicKey },
    expiresAt: Date.now() + 5 * 60_000,
  });
}

function chatEnvelope(projectId, worktreeId) {
  return { schemaVersion: 1, commandId: randomUUID(), projectId, worktreeId };
}

test.beforeAll(async ({ remoteControlServerManager }) => {
  // A cold Turbopack compile of the web routes and consent page can take
  // minutes; the budget absorbs it here instead of inside a case.
  test.setTimeout(900_000);
  await ensureRemoteControlSchema();
  await truncateWebTestState();
  relay = await startDeviceRelay();
  webServer = await remoteControlServerManager.acquire(
    directWebServerOptions({ relay }),
  );
  await warmRemoteControlRoutes([
    { path: '/api/v1/device-relay/token', method: 'POST' },
    { path: '/api/v1/mcp/remotes/pair', method: 'POST' },
    { path: '/api/v1/external-agents/computers', method: 'GET' },
    {
      path: `/api/v1/external-agents/computers/${randomUUID()}/remove`,
      method: 'POST',
    },
    { path: '/api/v1/mcp/tasks', method: 'POST' },
    { path: '/api/v1/oauth/token', method: 'POST' },
  ]);

  userA = await seedRemoteControlWebUser({ name: 'Hosted agents owner' });
  userB = await seedRemoteControlWebUser({ name: 'Another account' });
  desktop = await launchRemoteControlDesktop({
    relay,
    seeded: userA,
    seedBeforeLaunch: ({ userDataDir }) => {
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        activeTabId: SEEDED_CHAT.id,
        tabs: [
          {
            id: SEEDED_CHAT.id,
            title: SEEDED_CHAT.title,
            approvalMode: 'full-access',
            createdAt: new Date().toISOString(),
            messages: [
              {
                id: `${SEEDED_CHAT.id}-reply`,
                role: 'assistant',
                blocks: [{ type: 'text', text: 'Seeded for hosted agents.' }],
                timestamp: 1000,
              },
            ],
          },
          {
            id: SECRET_CHAT.id,
            title: SECRET_CHAT.title,
            createdAt: new Date().toISOString(),
            messages: [
              {
                id: `${SECRET_CHAT.id}-reply`,
                role: 'assistant',
                blocks: [{ type: 'text', text: 'I need a credential.' }],
                timestamp: 1000,
              },
            ],
          },
        ],
        pendingQuestions: [
          {
            delivery: 'async',
            requestId: SECRET_CHAT.questionId,
            chatId: SECRET_CHAT.id,
            questions: [
              {
                question: SECRET_CHAT.question,
                options: [],
                control: 'text',
                secret: true,
              },
            ],
          },
        ],
      });
      seedTrackedPlans({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        plans: [
          buildTrackedPlan({
            id: PLAN.id,
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            title: PLAN.title,
            content: `# ${PLAN.title}\n\nSeeded for hosted agents.`,
          }),
        ],
      });
      seedStoredPipeline({
        userDataDir,
        id: PIPELINE.id,
        name: PIPELINE.name,
        yaml: [
          `name: ${PIPELINE.name}`,
          'on: dispatch',
          'jobs:',
          '  hello:',
          '    name: Hello',
          '    steps:',
          '      - id: say',
          '        name: Say hello',
          `        run: echo ${PIPELINE.output}`,
          '',
        ].join('\n'),
      });
      seedCoworkWorkspace({
        userDataDir,
        workspaceId: COWORK.id,
        name: COWORK.name,
        providerType: 'claude',
        defaultModel: null,
        seedMessage: false,
        mergeIndex: true,
      });
      // The managed folder a cowork project's chats run in.
      mkdirSync(path.join(userDataDir, 'workspaces', COWORK.id, 'home'), {
        recursive: true,
      });
    },
  });
  browser = await chromium.launch();
  agentA = await openAgent(userA);
  agentB = await openAgent(userB);
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  await agentA?.close().catch(() => undefined);
  await agentB?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await desktop?.teardown();
  await webServer?.stop();
  await relay?.stop();
});

test('cancelling the pairing stream dismisses the desktop prompt and frees the slot', async () => {
  test.setTimeout(120_000);
  const pairing = await startHostedPairing(userA, desktop.deviceId);
  expect(pairing.ok, JSON.stringify(pairing.body)).toBe(true);
  const first = await pairing.next();
  expect(first.event).toBe('code');
  expect(first.data.code).toMatch(/^\d{6}$/);

  // The desktop asks, as an agents request, showing the same code.
  const prompt = desktop.window.getByTestId(
    'remote-access-incoming-pairing-body',
  );
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(
    desktop.window.getByTestId('remote-access-incoming-pairing-code'),
  ).toHaveText(new RegExp(first.data.code.split('').join('\\s*')));
  const pairLeases = await readHostedLeases(userA.userId);
  expect(pairLeases.filter((lease) => lease.purpose === 'pair')).toHaveLength(
    1,
  );
  const rootDeviceId = pairLeases[0].relay_device_id;
  expect(relay.connectedDeviceIds().has(rootDeviceId)).toBe(true);

  pairing.abort();

  await expect(prompt).toBeHidden({ timeout: 30_000 });
  await waitForRemoteControlState(
    desktop.window,
    (state) => state.incomingPairings.length === 0,
    { label: 'the pairing request to end on the desktop' },
  );
  await expect
    .poll(async () => (await readHostedLeases(userA.userId)).length, POLL)
    .toBe(0);
  await relay.waitFor((ids) => !ids.has(rootDeviceId), {
    label: 'the hosted root to leave the relay',
  });
  expect(await hostedControllers()).toHaveLength(0);
});

test('pairs through the SSE route with desktop approval, retrying a failed link write without duplicates', async () => {
  test.setTimeout(180_000);
  // Fail every in-place attempt to record the link after the desktop
  // approves. A sequence is not transactional, so it counts failed writes.
  await withRemoteControlDbClient(async (client) => {
    await client.query(`
      DROP TRIGGER IF EXISTS e2e_fail_hosted_link ON agent_remote_identities;
      DROP SEQUENCE IF EXISTS e2e_hosted_link_faults;
      CREATE SEQUENCE e2e_hosted_link_faults;
      CREATE OR REPLACE FUNCTION e2e_fail_hosted_link() RETURNS trigger AS $$
      BEGIN
        IF nextval('e2e_hosted_link_faults') <= 3 THEN
          RAISE EXCEPTION 'e2e: hosted link write failed';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER e2e_fail_hosted_link
        BEFORE UPDATE ON agent_remote_identities FOR EACH ROW
        WHEN (NEW.relay_device_id IS NOT NULL
              AND OLD.relay_device_id IS DISTINCT FROM NEW.relay_device_id)
        EXECUTE FUNCTION e2e_fail_hosted_link();
    `);
  });
  let firstRemoteId;
  try {
    const failed = await pairHostedAgents({ seeded: userA, desktop });
    expect(failed.result).toMatchObject({
      event: 'failed',
      data: { type: 'failed', reason: 'link_failed' },
    });
    // The desktop approved and pinned the root; the link was not recorded.
    expect(await hostedControllers()).toHaveLength(1);
    const links = await readHostedLinks(userA.userId);
    expect(links).toHaveLength(1);
    expect(links[0].relay_device_id).toBeNull();
    firstRemoteId = links[0].external_id;
    expect((await readHostedLeases(userA.userId)).length).toBe(0);
  } finally {
    await withRemoteControlDbClient((client) =>
      client.query(`
        DROP TRIGGER IF EXISTS e2e_fail_hosted_link ON agent_remote_identities;
        DROP FUNCTION IF EXISTS e2e_fail_hosted_link();
        DROP SEQUENCE IF EXISTS e2e_hosted_link_faults;
      `),
    );
  }

  // Connect again: the desktop asks again, and the retry links the same
  // identity instead of creating another.
  const paired = await pairHostedAgents({ seeded: userA, desktop });
  expect(paired.result).toMatchObject({
    event: 'paired',
    data: { type: 'paired', remoteId: firstRemoteId },
  });
  const links = await readHostedLinks(userA.userId);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    external_id: firstRemoteId,
    relay_device_id: desktop.deviceId,
  });
  expect(links[0].host_code).toMatch(/^[0-9a-z]{10}$/);
  expect(links[0].hosted_host_public_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await hostedControllers()).toHaveLength(1);

  const computers = await listHostedComputers(userA);
  expect(computers.status).toBe(200);
  expect(computers.body.computers).toEqual([
    expect.objectContaining({
      deviceId: desktop.deviceId,
      remoteId: firstRemoteId,
      online: true,
      agents: 'connected',
    }),
  ]);
  target.host = links[0].host_code;
  target.hostPublicKey = links[0].hosted_host_public_key;
});

test('host_list reports the paired computer online; task_chat_send and task_chat_wait follow a real turn on a default-model chat the desktop attributes to the agent', async () => {
  test.setTimeout(180_000);
  expect(target.host).toBeTruthy();
  await expect
    .poll(async () => {
      const listed = await agentA.ok('host_list', { limit: 50 });
      return listed.hosts.find((host) => host.host === target.host)?.status;
    }, TOOL_POLL)
    .toBe('online');

  const projects = await agentA.ok('project_list', {
    host: target.host,
    limit: 50,
  });
  const project = projects.items.find((item) => item.name === PROJECT_NAME);
  expect(project, JSON.stringify(projects)).toBeTruthy();
  target.projectId = project.projectId;
  // The worktree is one task; its chats, the seeded ones included, are in it.
  const tasks = await agentA.ok('task_list', {
    host: target.host,
    projectId: target.projectId,
    limit: 50,
  });
  const worktreeTask = tasks.items.find(
    (item) => item.kind === 'worktree' && item.branch === WORKTREE_ID,
  );
  expect(worktreeTask, JSON.stringify(tasks)).toBeTruthy();
  target.taskId = worktreeTask.taskId;
  const read = await agentA.ok('task_get', {
    host: target.host,
    taskId: target.taskId,
  });
  expect(read.chats.map((chat) => chat.title)).toEqual(
    expect.arrayContaining([SEEDED_CHAT.title, SECRET_CHAT.title]),
  );

  // The provider reply waits on a barrier, so the turn is still running
  // while task_chat_wait subscribes, and completes only when released.
  const marker = `Canopy-CHOSTEDWAIT${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: 'Hosted agents turn complete.',
          waitFor: 'finish',
          barrierTimeoutMs: 120_000,
        },
      ],
    },
  });
  const chat = await startHostedChat({
    taskId: target.taskId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  try {
    const sent = await sendToChat(chat, `[${marker}] Summarize the README.`);
    expect(sent.host).toBe(target.host);
    expect(sent.taskId).toBe(target.taskId);
    await expect
      .poll(() => mockBarrierWaiting(marker, 'finish'), POLL)
      .toBeGreaterThan(0);
    const running = await readChatLive(chat);
    expect(running.lastTurn, JSON.stringify(running)).toMatchObject({
      status: 'running',
    });

    // A host-wide task_list reads the desktop's chat activity and filters it
    // before paging; host "all" reads every host in one call.
    const working = await agentA.ok('task_list', {
      host: target.host,
      activity: ['active', 'blocked'],
    });
    const workingTask = working.items.find(
      (item) => item.taskId === target.taskId,
    );
    expect(workingTask, JSON.stringify(working)).toBeTruthy();
    expect(['active', 'blocked']).toContain(workingTask.activity.status);
    expect(workingTask.activeChats.map((item) => item.chatId)).toContain(
      chat.chatId,
    );
    const everyHost = await agentA.ok('task_list', {
      host: 'all',
      activity: ['active', 'blocked'],
    });
    expect(everyHost.hosts, JSON.stringify(everyHost)).toContainEqual({
      host: target.host,
      status: 'listed',
    });
    expect(
      everyHost.items.some(
        (item) => item.host === target.host && item.taskId === target.taskId,
      ),
    ).toBe(true);

    // Completion during the subscription: the wait is in flight when the
    // turn ends, and returns that completion rather than timing out.
    const waitStartedAt = Date.now();
    const waiting = agentA.call('task_chat_wait', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      until: 'idle',
      timeoutSeconds: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await releaseMockBarrier(marker, 'finish');
    const completed = await waiting;
    expect(completed.isError, JSON.stringify(completed.structuredContent)).toBe(
      false,
    );
    expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual(3_000);
    expect(completed.structuredContent.timedOut).toBe(false);
    expect(completed.structuredContent.chat.lastTurn).toMatchObject({
      turnId: running.lastTurn.turnId,
      status: 'complete',
    });

    // Already complete: a second wait answers from the current state.
    const again = await agentA.call('task_chat_wait', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      until: 'idle',
      timeoutSeconds: 25,
    });
    expect(again.isError, JSON.stringify(again.structuredContent)).toBe(false);
    expect(again.structuredContent.timedOut).toBe(false);
    expect(again.structuredContent.chat.lastTurn?.status).toBe('complete');
    expect(again.ms).toBeLessThan(10_000);

    // The computer started the new chat on its default model (stamped as the
    // default, and the prompt above ran on it) and stamped who sent the
    // message, derived from the session.
    const tab = readChatStorageTabs(
      workspaceRoot(WORKSPACE_ID),
      WORKTREE_ID,
    ).tabs.find((candidate) => candidate.id === chat.tabId);
    expect(tab?.model, JSON.stringify(tab)).toMatch(/\S/);
    expect(tab.defaultStampModel).toBe(tab.model);
    const [root] = await hostedControllers();
    const userMessage = chatMessages(WORKSPACE_ID, WORKTREE_ID, tab.id).find(
      (message) => message.role === 'user',
    );
    expect(userMessage?.agentSent, JSON.stringify(userMessage)).toMatchObject({
      kind: 'external_agent',
      clientName: root.name,
      verified: false,
    });
    await desktop.app.selectWorktree(WORKTREE_ID);
    await desktop.window.getByTestId(`panel-tab-panel-chat-${tab.id}`).click();
    const sentBy = desktop.window.getByTestId('agent-sent-marker').first();
    await expect(sentBy.getByTestId('agent-sent-marker-name')).toHaveText(
      `Sent by ${root.name}`,
    );
    await expect(sentBy.getByTestId('agent-sent-marker-unverified')).toHaveText(
      'Unverified app',
    );
  } finally {
    await releaseMockBarrier(marker, 'finish');
  }
});

test('task_create makes a code task over the direct host, retrying the same key through checkout setup until its chat runs the prompt; task_chat_create adds a chat to it', async () => {
  test.setTimeout(240_000);
  expect(target.projectId).toBeTruthy();
  // A title is not available over a direct host yet: refused before effects.
  expectToolError(
    await agentA.call('task_create', {
      host: target.host,
      projectId: target.projectId,
      idempotencyKey: randomUUID(),
      title: 'Not available over direct',
      chat: { prompt: 'Summarize the README.' },
    }),
    'capability_missing',
  );
  const marker = `Canopy-CHOSTEDCREATE${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Created task turn complete.', stopReason: 'end_turn' }],
    },
  });
  const { created, pendingTaskIds } = await createTaskSettled({
    projectId: target.projectId,
    chat: { prompt: `[${marker}] Summarize the README.` },
  });
  // A new worktree task, its first chat, and the prompt handed to the turn.
  // While the checkout set up, each in-progress answer named the same task.
  expect(created.host).toBe(target.host);
  expect(created.taskId).not.toBe(target.taskId);
  expect(created.chatId, JSON.stringify(created)).toBeTruthy();
  expect(created.setup).toBe('ready');
  expect(['started', 'queued']).toContain(created.delivery);
  expect(created.receipt).toMatchObject({
    operation: 'task_create',
    taskId: created.taskId,
    chatId: created.chatId,
  });
  expect(
    pendingTaskIds.every((id) => id === created.taskId),
    JSON.stringify(pendingTaskIds),
  ).toBe(true);

  const listed = await agentA.ok('task_list', {
    host: target.host,
    projectId: target.projectId,
    limit: 50,
  });
  expect(
    listed.items.find((item) => item.taskId === created.taskId),
    JSON.stringify(listed),
  ).toMatchObject({ kind: 'worktree' });
  // A queued first message may not have a turn yet, so wait for the turn
  // itself to complete rather than for the chat to be idle.
  await waitForChat(
    created,
    (current) => current.lastTurn?.status === 'complete',
    'the created task turn to complete',
  );

  // task_chat_create adds an empty chat to the created task.
  const added = await agentA.ok('task_chat_create', {
    host: target.host,
    taskId: created.taskId,
    idempotencyKey: randomUUID(),
  });
  expect(added.taskId).toBe(created.taskId);
  expect(added.chatId).not.toBe(created.chatId);
  expect(added.receipt).toMatchObject({
    operation: 'task_chat_create',
    taskId: created.taskId,
    chatId: added.chatId,
  });
  await expect
    .poll(() => chatIdsOf(created.taskId), TOOL_POLL)
    .toEqual(expect.arrayContaining([created.chatId, added.chatId]));
});

test('task_chat_cancel stops only the named running turn; an older turn answers turn_not_active', async () => {
  test.setTimeout(120_000);
  const marker = `Canopy-CHOSTEDSTOP${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Unexpected turn.', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        first: [{ text: 'First turn complete.', stopReason: 'end_turn' }],
        second: [
          {
            text: 'Second turn complete.',
            waitFor: 'second',
            barrierTimeoutMs: 120_000,
          },
        ],
      },
    },
  });
  const chat = await startHostedChat({
    taskId: target.taskId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  const session = await openHostedSession();
  try {
    await sendToChat(
      chat,
      `[${marker}] [Canopy-Mock-Request:first] Say hello.`,
    );
    const first = await waitForChat(
      chat,
      (current) => current.lastTurn?.status === 'complete',
      'the first turn to complete',
    );
    const firstTurn = first.lastTurn.turnId;

    await sendToChat(chat, '[Canopy-Mock-Request:second] Keep going.');
    await expect
      .poll(() => mockBarrierWaiting(marker, 'second'), POLL)
      .toBeGreaterThan(0);
    const second = await readChatLive(chat);
    expect(second.lastTurn, JSON.stringify(second)).toMatchObject({
      status: 'running',
    });
    const secondTurn = second.lastTurn.turnId;
    expect(secondTurn).not.toBe(firstTurn);

    // Stopping the finished turn never stops the newer one.
    const stale = await agentA.ok('task_chat_cancel', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      turnId: firstTurn,
      idempotencyKey: randomUUID(),
    });
    expect(stale).toMatchObject({
      outcome: 'turn_not_active',
      stopRequested: false,
    });
    const stillRunning = (
      await agentA.ok('task_chat_get', {
        host: target.host,
        taskId: chat.taskId,
        chatId: chat.chatId,
      })
    ).chat;
    expect(stillRunning.activity.status).toBe('active');
    expect(await mockBarrierWaiting(marker, 'second')).toBeGreaterThan(0);

    // The computer refuses a hosted plain Stop that names no turn.
    const plainStop = await settle(
      session.transport.invoke('chat:cancel', {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: chat.tabId,
      }),
    );
    expect(plainStop.ok).toBe(false);
    expect(plainStop.message).toMatch(HOST_PROFILE_REFUSAL);
    expect(await mockBarrierWaiting(marker, 'second')).toBeGreaterThan(0);

    // Stopping the named running turn stops exactly that turn.
    const stop = await agentA.ok('task_chat_cancel', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      turnId: secondTurn,
      idempotencyKey: randomUUID(),
    });
    expect(stop).toMatchObject({
      outcome: 'stop_requested',
      stopRequested: true,
    });
    const stopped = await agentA.ok('task_chat_wait', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      until: 'idle',
      timeoutSeconds: 25,
    });
    expect(stopped.chat.lastTurn, JSON.stringify(stopped.chat)).toMatchObject({
      turnId: secondTurn,
      status: 'cancelled',
    });
  } finally {
    session.stop();
    await releaseMockBarrier(marker, 'second');
  }
});

test('task_chat_respond answers an ordinary question and the turn continues; secret and approval answers are refused', async () => {
  test.setTimeout(120_000);
  const marker = `Canopy-CHOSTEDASK${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: ASK_USER_TOOL,
              input: {
                questions: [
                  {
                    question: 'Which color should the banner use?',
                    options: ['Red', 'Blue'],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Using the chosen color.', stopReason: 'end_turn' },
      ],
    },
  });
  const chat = await startHostedChat({
    taskId: target.taskId,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
  });
  await sendToChat(chat, `[${marker}] Pick a banner color.`);
  const asking = await waitForChat(
    chat,
    (current) => current.pendingQuestion !== null,
    'the agent to ask its question',
  );
  expect(asking.activity.status).toBe('blocked');
  expect(asking.pendingQuestion).toMatchObject({
    prompt: 'Which color should the banner use?',
    options: [
      { optionIndex: 0, label: 'Red' },
      { optionIndex: 1, label: 'Blue' },
    ],
  });

  const answered = await agentA.ok('task_chat_respond', {
    host: target.host,
    taskId: chat.taskId,
    chatId: chat.chatId,
    questionId: asking.pendingQuestion.questionId,
    idempotencyKey: randomUUID(),
    selectedOptionIndexes: [1],
    freeformText: null,
  });
  expect(answered.receipt).toMatchObject({
    operation: 'task_chat_respond',
    taskId: chat.taskId,
    chatId: chat.chatId,
  });
  expect(answered.receipt.status).not.toBe('failed');
  const done = await agentA.ok('task_chat_wait', {
    host: target.host,
    taskId: chat.taskId,
    chatId: chat.chatId,
    until: 'idle',
    timeoutSeconds: 25,
  });
  expect(done.timedOut).toBe(false);
  expect(done.chat.lastTurn?.status).toBe('complete');
  expect(done.chat.pendingQuestion).toBeNull();
  // The agent received the answer and finished its turn with it.
  const transcript = JSON.stringify(
    chatMessages(WORKSPACE_ID, WORKTREE_ID, chat.tabId),
  );
  expect(transcript).toContain('Blue');
  expect(transcript).toContain('Using the chosen color.');

  // A secret question: the web refuses before anything is sent...
  const chats = (
    await agentA.ok('task_get', { host: target.host, taskId: target.taskId })
  ).chats;
  const secretChat = chats.find((item) => item.title === SECRET_CHAT.title);
  expect(secretChat?.pendingQuestion?.prompt, JSON.stringify(chats)).toBe(
    SECRET_CHAT.question,
  );
  expectToolError(
    await agentA.call('task_chat_respond', {
      host: target.host,
      taskId: target.taskId,
      chatId: secretChat.chatId,
      questionId: secretChat.pendingQuestion.questionId,
      idempotencyKey: randomUUID(),
      selectedOptionIndexes: [],
      freeformText: 'not-a-real-token',
    }),
    'host_unsupported',
  );
  // ...and the computer refuses the same answer, and any approval answer,
  // from a valid hosted session.
  const session = await openHostedSession();
  try {
    const secret = await settle(
      session.transport.invoke('chat:command', {
        ...chatEnvelope(WORKSPACE_ID, WORKTREE_ID),
        command: {
          type: 'chat.answer_question',
          chatId: SECRET_CHAT.id,
          questionId: SECRET_CHAT.questionId,
          answers: [
            {
              question: SECRET_CHAT.question,
              selectedOptions: [],
              freeformText: 'not-a-real-token',
            },
          ],
        },
      }),
    );
    expect(secret.ok, secret.message).toBe(true);
    expect(secret.value).toMatchObject({ outcome: 'rejected' });
    expect(secret.value.reason).toContain(SECRET_ANSWER_REFUSAL);
    const approval = await settle(
      session.transport.invoke('approval:respond', {
        requestId: randomUUID(),
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: SECRET_CHAT.id,
        decision: 'allow',
      }),
    );
    expect(approval.ok).toBe(false);
    expect(approval.message).toMatch(HOST_PROFILE_REFUSAL);
  } finally {
    session.stop();
  }
  const stillPending = (
    await agentA.ok('task_chat_get', {
      host: target.host,
      taskId: target.taskId,
      chatId: secretChat.chatId,
    })
  ).chat;
  expect(stillPending.pendingQuestion?.prompt).toBe(SECRET_CHAT.question);
});

test('a Work Entry chat in a cowork project runs the turn an agent sends and reads it as a work_entry task', async () => {
  test.setTimeout(240_000);
  const projects = await agentA.ok('project_list', {
    host: target.host,
    limit: 50,
  });
  const cowork = projects.items.find((item) => item.name === COWORK.name);
  expect(cowork, JSON.stringify(projects)).toBeTruthy();
  // A direct no-repository create makes a Work Entry, its chat, and sends
  // the prompt. A Work Entry has no checkout, so its setup is null.
  const createMarker = `Canopy-CHOSTEDENTRY${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, createMarker, {
    llm: {
      steps: [{ text: 'Created entry turn complete.', stopReason: 'end_turn' }],
    },
  });
  const { created } = await createTaskSettled({
    projectId: cowork.projectId,
    chat: { prompt: `[${createMarker}] Draft a note.` },
  });
  expect(created.chatId, JSON.stringify(created)).toBeTruthy();
  expect(created.setup).toBeNull();
  expect(['started', 'queued']).toContain(created.delivery);
  expect(created.receipt).toMatchObject({
    operation: 'task_create',
    taskId: created.taskId,
    chatId: created.chatId,
  });
  await waitForChat(
    created,
    (current) => current.lastTurn?.status === 'complete',
    'the created Work Entry turn to complete',
  );
  const coworkTasks = await agentA.ok('task_list', {
    host: target.host,
    projectId: cowork.projectId,
    limit: 50,
  });
  expect(
    coworkTasks.items.find((item) => item.taskId === created.taskId),
    JSON.stringify(coworkTasks),
  ).toMatchObject({ kind: 'work_entry' });

  const marker = `Canopy-CHOSTEDSOLO${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Unexpected turn.', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        ...OPEN_STEPS,
        solo: [
          {
            text: 'No-repository turn complete.',
            waitFor: 'solo',
            barrierTimeoutMs: 60_000,
          },
        ],
      },
    },
  });
  const chat = await startWorkEntryChat(cowork.projectId, marker);
  let turnId;
  try {
    await sendToChat(
      chat,
      `[${marker}] [Canopy-Mock-Request:solo] Draft a note.`,
    );
    // The prompt runs on the computer: the provider call is held open.
    await expect
      .poll(() => mockBarrierWaiting(marker, 'solo'), POLL)
      .toBeGreaterThan(0);
    const running = await waitForChat(
      chat,
      (current) => current.lastTurn?.status === 'running',
      'the no-repository turn to run',
    );
    turnId = running.lastTurn.turnId;
  } finally {
    await releaseMockBarrier(marker, 'solo');
  }
  const done = await agentA.ok('task_chat_wait', {
    host: target.host,
    taskId: chat.taskId,
    chatId: chat.chatId,
    until: 'idle',
    timeoutSeconds: 25,
  });
  expect(done.timedOut).toBe(false);
  expect(done.chat.activity.status).toBe('idle');
  expect(done.chat.lastTurn).toMatchObject({ turnId, status: 'complete' });

  // The chat ran in the Work Entry the hosted session added.
  const entries = (
    await desktop.window.evaluate(
      (projectId) => window.api.workEntries.list({ projectId }),
      COWORK.id,
    )
  ).entries;
  const used = entries.find((entry) => entry.id === chat.entryId);
  expect(used?.lastMessageAt, JSON.stringify(entries)).toBeTruthy();
  const transcripts = readChatStorageTabs(
    workspaceRoot(COWORK.id),
    chat.entryId,
  ).tabs.map((tab) =>
    JSON.stringify(chatMessages(COWORK.id, chat.entryId, tab.id) ?? []),
  );
  const transcript = transcripts.find((text) => text.includes(marker));
  expect(transcript, JSON.stringify(transcripts)).toBeTruthy();
  expect(transcript).toContain('No-repository turn complete.');
});

/** Points the computer's Claude executable at `missing`; returns a restore. */
async function overrideClaudeExecutable(missing) {
  const saved = await desktop.electronApp.evaluate((_electron, override) => {
    const names = [
      'CANOPY_CLAUDE_BINARY_PATH',
      'UNSTOPPABLE_CODE_CLAUDE_BINARY_PATH',
      'CLAUDE_CODE_EXECUTABLE',
    ];
    const previous = names.map((name) => [name, process.env[name] ?? null]);
    for (const name of names) process.env[name] = override;
    return previous;
  }, missing);
  return () =>
    desktop.electronApp.evaluate((_electron, previous) => {
      for (const [name, value] of previous) {
        if (value === null) delete process.env[name];
        else process.env[name] = value;
      }
    }, saved);
}

test('a failed no-repository turn reads as failed in task_chat_get and task_chat_wait, and a running one reads the same in both', async () => {
  test.setTimeout(180_000);
  const projects = await agentA.ok('project_list', {
    host: target.host,
    limit: 50,
  });
  const cowork = projects.items.find((item) => item.name === COWORK.name);
  expect(cowork, JSON.stringify(projects)).toBeTruthy();
  // The provider holds the request open, then refuses it, so the turn runs
  // while it is read and then ends failed on the computer.
  const marker = `Canopy-CHOSTEDFAIL${randomBytes(4).toString('hex')}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Unexpected turn.', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        ...OPEN_STEPS,
        fail: [
          {
            waitFor: 'fail',
            barrierTimeoutMs: 60_000,
            error: { kind: 'status', status: 400 },
          },
        ],
      },
    },
  });
  const chat = await startWorkEntryChat(cowork.projectId, marker);
  let turnId;
  try {
    await sendToChat(
      chat,
      `[${marker}] [Canopy-Mock-Request:fail] Draft a note that fails.`,
    );
    await expect
      .poll(() => mockBarrierWaiting(marker, 'fail'), POLL)
      .toBeGreaterThan(0);
    const running = await waitForChat(
      chat,
      (current) => current.lastTurn?.status === 'running',
      'the no-repository turn to run',
    );
    turnId = running.lastTurn.turnId;
    // A wait that times out on the running turn sees the turn task_chat_get
    // sees.
    const waiting = await agentA.ok('task_chat_wait', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
      until: 'idle',
      timeoutSeconds: 1,
    });
    expect(waiting.timedOut).toBe(true);
    expect(waiting.chat.lastTurn, JSON.stringify(waiting.chat)).toMatchObject({
      turnId,
      status: 'running',
      startedAt: running.lastTurn.startedAt,
    });
  } finally {
    await releaseMockBarrier(marker, 'fail');
  }

  const done = await agentA.ok('task_chat_wait', {
    host: target.host,
    taskId: chat.taskId,
    chatId: chat.chatId,
    until: 'idle',
    timeoutSeconds: 25,
  });
  expect(done.timedOut).toBe(false);
  expect(done.chat.lastTurn, JSON.stringify(done.chat)).toMatchObject({
    turnId,
    status: 'failed',
    outcome: 'failed',
    startedAt: expect.any(String),
    endedAt: expect.any(String),
  });
  const read = (
    await agentA.ok('task_chat_get', {
      host: target.host,
      taskId: chat.taskId,
      chatId: chat.chatId,
    })
  ).chat;
  expect(read.lastTurn, JSON.stringify(read)).toMatchObject({
    turnId,
    status: 'failed',
    outcome: 'failed',
    startedAt: done.chat.lastTurn.startedAt,
    endedAt: done.chat.lastTurn.endedAt,
  });
  // task_get's cheaper listing may leave the turn out, never reads it complete.
  const listed = (
    await agentA.ok('task_get', { host: target.host, taskId: chat.taskId })
  ).chats.find((item) => item.chatId === chat.chatId);
  expect(listed?.lastTurn?.status ?? null, JSON.stringify(listed)).not.toBe(
    'complete',
  );

  // The provider cannot start at all ("spawn ... ENOENT"): the chat's first
  // turn fails with no live session left on the computer, and still never
  // reads as complete.
  const unstartedMarker = `Canopy-CHOSTEDNOEXE${randomBytes(4).toString('hex')}`;
  const restore = await overrideClaudeExecutable(
    path.join(desktop.userDataDir, 'missing-provider', 'claude'),
  );
  let unstarted;
  try {
    unstarted = await startWorkEntryChat(cowork.projectId, unstartedMarker);
  } finally {
    await restore();
  }
  expect(unstarted.opening, JSON.stringify(unstarted.opening)).toMatchObject({
    status: 'failed',
    outcome: 'failed',
  });
  const failed = await agentA.ok('task_chat_wait', {
    host: target.host,
    taskId: unstarted.taskId,
    chatId: unstarted.chatId,
    until: 'idle',
    timeoutSeconds: 25,
  });
  expect(failed.timedOut).toBe(false);
  expect(failed.chat.lastTurn, JSON.stringify(failed.chat)).toMatchObject({
    turnId: unstarted.opening.turnId,
    status: 'failed',
    outcome: 'failed',
  });
  const unstartedRead = (
    await agentA.ok('task_chat_get', {
      host: target.host,
      taskId: unstarted.taskId,
      chatId: unstarted.chatId,
    })
  ).chat;
  expect(unstartedRead.lastTurn, JSON.stringify(unstartedRead)).toMatchObject({
    turnId: unstarted.opening.turnId,
    status: 'failed',
    outcome: 'failed',
  });
});

test('plan_list returns the tracked plan seeded on the desktop', async () => {
  test.setTimeout(60_000);
  const plans = await agentA.ok('plan_list', {
    host: target.host,
    taskId: target.taskId,
    limit: 50,
  });
  expect(plans.host).toBe(target.host);
  expect(plans.items).toEqual([
    expect.objectContaining({
      host: target.host,
      projectId: target.projectId,
      worktreeId: target.taskId,
      title: PLAN.title,
      status: 'pending',
    }),
  ]);
  expect(plans.nextCursor).toBeNull();
});

test('pipeline_list and pipeline_run_get return a seeded pipeline and the run it finished on the desktop', async () => {
  test.setTimeout(120_000);
  const listed = await agentA.ok('pipeline_list', {
    host: target.host,
    taskId: target.taskId,
    limit: 100,
  });
  const before = listed.items.find((item) => item.name === PIPELINE.name);
  expect(before, JSON.stringify(listed)).toMatchObject({
    host: target.host,
    projectId: target.projectId,
    worktreeId: target.taskId,
    triggerTypes: ['dispatch'],
    latestRun: null,
  });

  // Run it on the desktop, as the Dispatch modal does, and read it once it
  // has finished (no live output stream is involved).
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
    { id: PIPELINE.id, projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  expect(started?.success, JSON.stringify(started)).toBe(true);

  let latestRun = null;
  await expect
    .poll(async () => {
      const page = await agentA.ok('pipeline_list', {
        host: target.host,
        taskId: target.taskId,
        limit: 100,
      });
      latestRun =
        page.items.find((item) => item.name === PIPELINE.name)?.latestRun ??
        null;
      return Boolean(latestRun?.finishedAt);
    }, TOOL_POLL)
    .toBe(true);
  expect(latestRun).toMatchObject({ host: target.host, status: 'success' });

  const read = await agentA.ok('pipeline_run_get', {
    host: target.host,
    runId: latestRun.runId,
  });
  expect(read.run).toMatchObject({
    host: target.host,
    runId: latestRun.runId,
    pipelineId: before.pipelineId,
    projectId: target.projectId,
    worktreeId: target.taskId,
    pipelineName: PIPELINE.name,
    status: 'success',
  });
  expect(read.run.finishedAt).toBe(latestRun.finishedAt);
  expect(read.run.outputTail, JSON.stringify(read.run)).toContain(
    PIPELINE.output,
  );
  expectToolError(
    await agentA.call('pipeline_run_get', {
      host: target.host,
      runId: randomUUID(),
    }),
    'not_found',
  );
});

test('task_diff_get returns the combined worktree diff and cuts the patch at its bound', async () => {
  test.setTimeout(60_000);
  const worktreePath = demoWorktreePath();
  const dir = path.join(worktreePath, 'hosted-diff');
  const line = (index) =>
    `${String(index).padStart(4, '0')} ${'hosted diff fixture '.repeat(4)}`;
  const lines = (count) =>
    `${Array.from({ length: count }, (_, index) => line(index)).join('\n')}\n`;
  mkdirSync(dir, { recursive: true });
  // a.txt and c.txt are small; b.txt alone is larger than the patch bound.
  writeFileSync(path.join(dir, 'a.txt'), lines(3));
  writeFileSync(path.join(dir, 'b.txt'), lines(500));
  writeFileSync(path.join(dir, 'c.txt'), lines(3));
  try {
    const diff = await agentA.ok('task_diff_get', {
      host: target.host,
      taskId: target.taskId,
    });
    expect(diff).toMatchObject({
      host: target.host,
      projectId: target.projectId,
      worktreeId: target.taskId,
      diffSource: 'combined',
      filesTruncated: false,
      patchTruncated: true,
    });
    const paths = diff.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'hosted-diff/a.txt',
        'hosted-diff/b.txt',
        'hosted-diff/c.txt',
      ]),
    );
    expect(
      diff.files.find((file) => file.path === 'hosted-diff/b.txt'),
    ).toMatchObject({ insertions: 500, deletions: 0 });
    // Patches are read in roster order until the bound: a whole, b cut, and
    // c never read.
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(
      MAX_PATCH_BYTES,
    );
    expect(diff.patch).toContain('+++ b/hosted-diff/a.txt');
    expect(diff.patch).toContain(`+${line(2)}`);
    expect(diff.patch).toContain('+++ b/hosted-diff/b.txt');
    expect(diff.patch).not.toContain(`+${line(499)}`);
    expect(diff.patch).not.toContain('hosted-diff/c.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task_pull_request_get answers no pull request for a worktree without a GitHub remote', async () => {
  test.setTimeout(60_000);
  // No remote at all, so nothing can reach GitHub.
  expect(
    execFileSync('git', ['remote'], {
      cwd: demoWorktreePath(),
      encoding: 'utf8',
    }).trim(),
  ).toBe('');
  const read = await agentA.ok('task_pull_request_get', {
    host: target.host,
    taskId: target.taskId,
  });
  expect(read).toMatchObject({
    host: target.host,
    projectId: target.projectId,
    worktreeId: target.taskId,
    pullRequest: null,
    source: 'live',
  });
});

test('the desktop refuses forbidden effects from a valid delegated hosted session', async () => {
  test.setTimeout(120_000);
  const root = await loadHostedRootIdentity(userA.userId);
  const session = await openDelegatedTestSession({
    relay,
    userExternalId: await externalIdOf(userA.userId),
    root,
    host: { deviceId: desktop.deviceId, publicKey: target.hostPublicKey },
    expiresAt: Date.now() + 5 * 60_000,
  });
  const tabsBefore = readChatStorageTabs(
    path.join(desktop.userDataDir, 'workspaces', WORKSPACE_ID),
    WORKTREE_ID,
  )
    .tabs.map((tab) => tab.id)
    .sort();
  expect(tabsBefore).toContain(SEEDED_CHAT.id);
  try {
    // The session is authorized: an allowlisted read works.
    const snapshot = await settle(
      session.transport.invoke('desktop:session-snapshot'),
    );
    expect(snapshot.ok, snapshot.message).toBe(true);

    const terminal = await settle(
      session.transport.invoke('terminal:spawn', {
        id: 'hosted-forbidden',
        cwd: '/',
      }),
    );
    expect(terminal.ok).toBe(false);
    expect(terminal.message).toMatch(HOST_PROFILE_REFUSAL);

    const envelope = {
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
    };
    const archive = await settle(
      session.transport.invoke('chat:command', {
        ...envelope,
        command: { type: 'chat.archive_tab', tabId: SEEDED_CHAT.id },
      }),
    );
    expect(archive.ok).toBe(false);
    expect(archive.message).toMatch(HOST_PROFILE_REFUSAL);
    const fullAccess = await settle(
      session.transport.invoke('chat:command', {
        ...envelope,
        command: {
          type: 'chat.create_tab',
          tabId: randomUUID(),
          approvalMode: 'full-access',
        },
      }),
    );
    expect(fullAccess.ok).toBe(false);
    expect(fullAccess.message).toMatch(HOST_PROFILE_REFUSAL);

    // Refusals leave the seeded chat untouched and the session usable.
    const after = await settle(
      session.transport.invoke('desktop:session-snapshot'),
    );
    expect(after.ok, after.message).toBe(true);
    const tabs = readChatStorageTabs(
      path.join(desktop.userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
    ).tabs;
    expect(tabs.map((tab) => tab.id).sort()).toEqual(tabsBefore);
    expect(
      tabs.find((tab) => tab.id === SEEDED_CHAT.id)?.archivedAt ?? null,
    ).toBeNull();
  } finally {
    session.stop();
  }
});

test('a Slack session reaches the Orchestrator only behind its gate, in one Slack conversations tab per thread and sender that closes after each turn (CAN-7604)', async () => {
  test.setTimeout(240_000);
  const root = await loadHostedRootIdentity(userA.userId);
  const open = (firstPartyClient) =>
    openDelegatedTestSession({
      relay,
      userExternalId: externalId,
      root,
      host: { deviceId: desktop.deviceId, publicKey: target.hostPublicKey },
      expiresAt: Date.now() + 5 * 60_000,
      ...(firstPartyClient ? { firstPartyClient } : {}),
    });
  const externalId = await externalIdOf(userA.userId);
  const slack = await open('slack');
  const agents = await open();
  // The caller's tab ID is per Slack thread and per sender.
  const slackThread = `slack-thread-${randomBytes(6).toString('hex')}`;
  const thread = `${slackThread}-sender-a`;
  const otherSender = `${slackThread}-sender-b`;
  const send = (session, userMessageId, text, chatId = thread) =>
    settle(
      session.transport.invoke('chat:command', {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: 'app-advisor',
        worktreeId: 'slack-conversations',
        command: {
          type: 'chat.send_message',
          chatId,
          userMessageId,
          text,
        },
      }),
    );
  const status = async (userMessageId, chatId = thread) => {
    const read = await settle(
      slack.transport.invoke('app-advisor:slack-turn-status', {
        chatId,
        userMessageId,
      }),
    );
    expect(read.ok, read.message).toBe(true);
    return read.value;
  };
  const slackEntries = async () =>
    (
      await desktop.window.evaluate(() =>
        window.api.workEntries.list({ projectId: 'app-advisor' }),
      )
    ).entries.filter((entry) => entry.title === 'Slack conversations');
  try {
    // Off by default: refused, and nothing is created.
    const off = await send(slack, 'slack-message-0', 'Are you there?');
    expect(off.ok, off.message).toBe(true);
    expect(off.value).toMatchObject({ outcome: 'rejected' });
    expect(await slackEntries()).toEqual([]);

    // The Orchestrator's own model here differs from the worktree default.
    await desktop.window.evaluate(() =>
      window.api.savePreferences({
        slackOrchestratorRequestsEnabled: true,
        appAdvisorModel: 'sonnet',
      }),
    );
    // An agents session never reaches the Orchestrator, gate or not.
    const fromAgents = await send(agents, 'slack-message-0', 'Are you there?');
    expect(fromAgents.ok).toBe(false);
    expect(fromAgents.message).toMatch(HOST_PROFILE_REFUSAL);

    const first = `Canopy-CSLACK${randomBytes(4).toString('hex')}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, first, {
      llm: {
        steps: [
          { text: 'Three pull requests merged.', stopReason: 'end_turn' },
        ],
      },
    });
    const sent = await send(
      slack,
      'slack-message-1',
      `[${first}] What changed today?`,
    );
    expect(sent.ok, sent.message).toBe(true);
    expect(sent.value).toMatchObject({ outcome: 'applied', entityId: thread });
    const entryId = sent.value.worktreeId;
    expect(entryId).toMatch(/\S/);
    // The turn completes and its tab closes on its own.
    await expect
      .poll(() => status('slack-message-1'), { ...POLL, timeout: 90_000 })
      .toEqual({ state: 'completed', worktreeId: entryId, closed: true });

    // The Slack sender, verified, on the Orchestrator's own model.
    const page = await settle(
      slack.transport.invoke('chat:get-transcript-page', {
        projectId: 'app-advisor',
        worktreeId: entryId,
        chatId: thread,
      }),
    );
    expect(page.ok, page.message).toBe(true);
    const prompt = page.value.messages.find((m) => m.id === 'slack-message-1');
    expect(prompt?.agentSent, JSON.stringify(prompt)).toMatchObject({
      kind: 'external_agent',
      clientName: 'Slack',
      verified: true,
    });
    expect(JSON.stringify(page.value.messages)).toContain(
      'Three pull requests merged.',
    );

    // A resend after the tab closed starts nothing and reopens nothing.
    const resent = await send(
      slack,
      'slack-message-1',
      `[${first}] What changed today?`,
    );
    expect(resent.value).toMatchObject({
      outcome: 'already_applied',
      worktreeId: entryId,
    });
    expect(await status('slack-message-1')).toMatchObject({ closed: true });

    // The thread's next message reopens the same tab in the same entry.
    const second = `Canopy-CSLACK${randomBytes(4).toString('hex')}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, second, {
      llm: {
        steps: [{ text: 'Nothing else changed.', stopReason: 'end_turn' }],
      },
    });
    const next = await send(
      slack,
      'slack-message-2',
      `[${second}] Anything else?`,
    );
    expect(next.value).toMatchObject({
      outcome: 'applied',
      worktreeId: entryId,
    });
    await expect
      .poll(() => status('slack-message-2'), { ...POLL, timeout: 90_000 })
      .toEqual({ state: 'completed', worktreeId: entryId, closed: true });

    // Another person asking in the same Slack thread gets their own tab.
    const third = `Canopy-CSLACK${randomBytes(4).toString('hex')}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, third, {
      llm: {
        steps: [{ text: 'Your build is green.', stopReason: 'end_turn' }],
      },
    });
    const fromOther = await send(
      slack,
      'slack-message-3',
      `[${third}] Is my build green?`,
      otherSender,
    );
    expect(fromOther.value).toMatchObject({
      outcome: 'applied',
      entityId: otherSender,
      worktreeId: entryId,
    });
    await expect
      .poll(() => status('slack-message-3', otherSender), {
        ...POLL,
        timeout: 90_000,
      })
      .toEqual({ state: 'completed', worktreeId: entryId, closed: true });

    expect((await slackEntries()).map((entry) => entry.id)).toEqual([entryId]);
    const state = await desktop.window.evaluate(
      (worktreeId) =>
        window.api.chat.getState({ projectId: 'app-advisor', worktreeId }),
      entryId,
    );
    // One tab for each person's thread, open or closed. Any other tab is the
    // empty one the Orchestrator window opens on an entry with none open.
    const tabs = [
      ...state.tabsFile.tabs,
      ...state.archives.map((archive) => ({
        id: archive.chatId,
        turnCount: archive.turnCount,
      })),
    ];
    expect(tabs.filter((tab) => tab.id === thread)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.id === otherSender)).toHaveLength(1);
    // The thread ran on the Orchestrator's own model, not the worktree one.
    expect(
      state.archives.find((archive) => archive.chatId === thread)?.model,
    ).toBe('sonnet');
    for (const tab of tabs.filter(
      (candidate) => candidate.id !== thread && candidate.id !== otherSender,
    )) {
      expect(
        tab.messages?.length ?? tab.transcript?.messageCount ?? tab.turnCount,
        JSON.stringify(tab),
      ).toBe(0);
    }

    // Deleted by the person: the next Slack message makes a new entry under
    // a new ID, never reusing the deleted one's.
    await desktop.window.evaluate(
      (entryId) =>
        window.api.workEntries.delete({ projectId: 'app-advisor', entryId }),
      entryId,
    );
    await expect.poll(async () => (await slackEntries()).length, POLL).toBe(0);
    const fourth = `Canopy-CSLACK${randomBytes(4).toString('hex')}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, fourth, {
      llm: { steps: [{ text: 'Back again.', stopReason: 'end_turn' }] },
    });
    const recreated = await send(
      slack,
      'slack-message-4',
      `[${fourth}] Still there?`,
    );
    expect(recreated.value).toMatchObject({ outcome: 'applied' });
    const newEntryId = recreated.value.worktreeId;
    expect(newEntryId).not.toBe(entryId);
    expect((await slackEntries()).map((entry) => entry.id)).toEqual([
      newEntryId,
    ]);
    await expect
      .poll(() => status('slack-message-4'), { ...POLL, timeout: 90_000 })
      .toEqual({ state: 'completed', worktreeId: newEntryId, closed: true });

    // A Slack session reads no other entry, and no ordinary project.
    const elsewhere = await settle(
      slack.transport.invoke('desktop:session-snapshot'),
    );
    expect(elsewhere.ok).toBe(false);
  } finally {
    await desktop.window.evaluate(() =>
      window.api.savePreferences({
        slackOrchestratorRequestsEnabled: false,
        appAdvisorModel: 'gpt-6.2-sol',
      }),
    );
    slack.stop();
    agents.stop();
  }
});

async function externalIdOf(userId) {
  return withRemoteControlDbClient(async (client) => {
    const result = await client.query(
      'SELECT external_id FROM users WHERE id = $1',
      [userId],
    );
    return result.rows[0].external_id;
  });
}

test('the desktop refuses expired, overlong and unpinned delegations and ends a session at expiry', async () => {
  test.setTimeout(120_000);
  const root = await loadHostedRootIdentity(userA.userId);
  const userExternalId = await externalIdOf(userA.userId);
  const host = { deviceId: desktop.deviceId, publicKey: target.hostPublicKey };

  const valid = await attemptDelegatedHandshake({
    relay,
    userExternalId,
    root,
    host,
    expiresAt: Date.now() + 60_000,
  });
  expect(valid.ok, valid.message).toBe(true);
  const expired = await attemptDelegatedHandshake({
    relay,
    userExternalId,
    root,
    host,
    expiresAt: Date.now() - 1_000,
  });
  expect(expired.ok).toBe(false);
  const overlong = await attemptDelegatedHandshake({
    relay,
    userExternalId,
    root,
    host,
    expiresAt: Date.now() + 11 * 60_000,
  });
  expect(overlong.ok).toBe(false);
  const { generateDeviceIdentity } = await import('@canopy/remote-session');
  const unpinned = await attemptDelegatedHandshake({
    relay,
    userExternalId,
    root: await generateDeviceIdentity(),
    host,
    expiresAt: Date.now() + 60_000,
  });
  expect(unpinned.ok).toBe(false);

  // A short delegation: usable until it lapses, then the desktop ends it.
  const expiresAt = Date.now() + 5_000;
  const session = await openDelegatedTestSession({
    relay,
    userExternalId,
    root,
    host,
    expiresAt,
  });
  try {
    const before = await settle(
      session.transport.invoke('desktop:session-snapshot'),
    );
    expect(before.ok, before.message).toBe(true);
    await waitForRemoteControlState(
      desktop.window,
      (state) =>
        state.controllers.some((controller) =>
          controller.hostedSessions.some(
            (child) => child.deviceId === session.deviceId,
          ),
        ),
      { label: 'the delegated session on the desktop' },
    );
    const endedAt = await Promise.race([
      session.ended,
      new Promise((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    expect(endedAt, 'the desktop ends the session at expiry').not.toBeNull();
    expect(endedAt).toBeGreaterThanOrEqual(expiresAt - 1_000);
    const afterExpiry = await settle(
      session.transport.invoke('desktop:session-snapshot'),
    );
    expect(afterExpiry.ok).toBe(false);
    await waitForRemoteControlState(
      desktop.window,
      (state) =>
        state.controllers.every((controller) =>
          controller.hostedSessions.every(
            (child) => child.deviceId !== session.deviceId,
          ),
        ),
      { label: 'the expired session to leave the desktop' },
    );
  } finally {
    session.stop();
  }
});

test('an expired trial refuses neither the next call on a pooled session nor a pairing, and the pool is reused', async () => {
  test.setTimeout(120_000);
  const read = () =>
    agentA.call('project_list', { host: target.host, limit: 50 });
  expect((await read()).isError).toBe(false);
  const [pooled] = (await readHostedLeases(userA.userId)).filter(
    (lease) => lease.live,
  );
  expect(pooled?.purpose).toBe('control');
  expect(relay.connectedDeviceIds().has(pooled.relay_device_id)).toBe(true);

  // Remote control no longer depends on subscription state, so a trial that
  // ended in tier mode refuses nothing.
  await withRemoteControlDbClient((client) =>
    client.query(
      `UPDATE users SET trial_ends_at = clock_timestamp() - interval '1 day' WHERE id = $1`,
      [userA.userId],
    ),
  );
  try {
    expect((await read()).isError).toBe(false);
    const pairing = await startHostedPairing(userA, desktop.deviceId);
    expect(pairing.ok, JSON.stringify(pairing.body)).toBe(true);
    const first = await pairing.next();
    expect(first.event).toBe('code');
    pairing.abort();
    await waitForRemoteControlState(
      desktop.window,
      (state) => state.incomingPairings.length === 0,
      { label: 'the pairing request to end on the desktop' },
    );
    await expect
      .poll(
        async () =>
          (await readHostedLeases(userA.userId)).filter(
            (lease) => lease.purpose === 'pair',
          ).length,
        POLL,
      )
      .toBe(0);
    expect(relay.connectedDeviceIds().has(pooled.relay_device_id)).toBe(true);
  } finally {
    await withRemoteControlDbClient((client) =>
      client.query('UPDATE users SET trial_ends_at = NULL WHERE id = $1', [
        userA.userId,
      ]),
    );
  }
  expect((await read()).isError).toBe(false);
  const leases = (await readHostedLeases(userA.userId)).filter(
    (lease) => lease.live,
  );
  expect(leases.map((lease) => lease.relay_device_id)).toEqual([
    pooled.relay_device_id,
  ]);
});

test('global slots: pooled calls share one slot, a fifth admission is refused, and a crashed holder frees its slot', async () => {
  test.setTimeout(180_000);
  const read = () =>
    agentA.call('project_list', { host: target.host, limit: 50 });
  expect((await read()).isError).toBe(false);
  const ours = (await readHostedLeases(userA.userId)).filter((l) => l.live);
  expect(ours).toHaveLength(1);
  const foreign = [];
  const holdSlot = async (slot, expiresIn) => {
    const relayDeviceId = randomRelayDeviceId();
    await withRemoteControlDbClient((client) =>
      client.query(
        `INSERT INTO hosted_remote_session_leases
           (external_id, user_id, slot, purpose, relay_device_id, expires_at)
         VALUES (gen_random_uuid(), $1, $2, 'control', $3,
                 clock_timestamp() + ($4 || ' milliseconds')::interval)`,
        [userA.userId, slot, relayDeviceId, String(expiresIn)],
      ),
    );
    foreign.push(relayDeviceId);
    return relayDeviceId;
  };
  try {
    // Other pods hold the three free slots.
    const freeSlots = [0, 1, 2, 3].filter((slot) => slot !== ours[0].slot);
    for (const slot of freeSlots) await holdSlot(slot, 10 * 60_000);

    // Five concurrent admissions: four tool calls share this pod's pooled
    // session; the pairing needs a fifth slot and is refused, typed.
    const [pairing, ...calls] = await Promise.all([
      startHostedPairing(userA, desktop.deviceId),
      read(),
      read(),
      read(),
      read(),
    ]);
    for (const call of calls) expect(call.isError).toBe(false);
    expect(pairing).toMatchObject({
      ok: false,
      status: 429,
      body: { error: 'hosted_capacity' },
    });
    expect(
      (await readHostedLeases(userA.userId)).filter((l) => l.live),
    ).toHaveLength(4);

    // Disconnect agents on the desktop: the pooled session ends and its
    // slot is released.
    const rootDeviceId = await hostedRootDeviceId();
    await desktop.window.evaluate(
      (deviceId) => window.api.remoteControl.disconnectController(deviceId),
      rootDeviceId,
    );
    await expect
      .poll(
        async () =>
          (await readHostedLeases(userA.userId)).some(
            (lease) => lease.relay_device_id === ours[0].relay_device_id,
          ),
        POLL,
      )
      .toBe(false);

    // Every slot held by live pods: a new session is refused with the typed
    // capacity error after the bounded queue wait.
    const fourth = await holdSlot(ours[0].slot, 10 * 60_000);
    const refused = await read();
    expectToolError(refused, 'resource_exhausted', 'hosted_capacity');
    expect(refused.structuredContent.retryAfterSeconds).toBe(15);

    // That holder crashes: its renewal stops, the lease lapses, and the
    // next admission reclaims the slot without anyone releasing it.
    await withRemoteControlDbClient((client) =>
      client.query(
        `UPDATE hosted_remote_session_leases
            SET expires_at = clock_timestamp() + interval '3 seconds'
          WHERE user_id = $1 AND relay_device_id = $2`,
        [userA.userId, fourth],
      ),
    );
    const reclaimed = await read();
    expect(reclaimed.isError, JSON.stringify(reclaimed.structuredContent)).toBe(
      false,
    );
    const leases = await readHostedLeases(userA.userId);
    expect(leases.some((lease) => lease.relay_device_id === fourth)).toBe(
      false,
    );
    expect(leases.filter((lease) => lease.live)).toHaveLength(4);
  } finally {
    await withRemoteControlDbClient((client) =>
      client.query(
        `DELETE FROM hosted_remote_session_leases
          WHERE user_id = $1 AND relay_device_id = ANY($2::text[])`,
        [userA.userId, foreign],
      ),
    );
  }
});

test('another account cannot see, pair with, reach or remove this computer', async () => {
  test.setTimeout(180_000);
  const listedA = await agentA.ok('host_list', { limit: 50 });
  expect(listedA.hosts.map((host) => host.host)).toContain(target.host);
  const listedB = await agentB.ok('host_list', { limit: 50 });
  expect(listedB.hosts.map((host) => host.host)).not.toContain(target.host);
  expectToolError(
    await agentB.call('project_list', { host: target.host, limit: 50 }),
    'not_found',
  );

  const computersB = await listHostedComputers(userB);
  expect(computersB.status).toBe(200);
  expect(computersB.body.computers).toEqual([]);

  // B's root reaches only B's relay namespace: the computer is not there.
  const pairing = await startHostedPairing(userB, desktop.deviceId);
  expect(pairing.ok, JSON.stringify(pairing.body)).toBe(true);
  expect(await pairing.next()).toMatchObject({
    event: 'failed',
    data: { reason: 'offline' },
  });
  expect(await readHostedLinks(userB.userId)).toHaveLength(0);
  expect(
    (await readRemoteControlState(desktop.window)).incomingPairings,
  ).toHaveLength(0);

  const remove = await fetch(
    `${REMOTE_CONTROL_WEB_ORIGIN_LOOPBACK}/api/v1/external-agents/computers/${(await pairedLink(userA.userId)).external_id}/remove`,
    { method: 'POST', headers: sameOriginJsonHeaders(userB), body: '{}' },
  );
  expect(remove.status).toBe(404);
  expect((await pairedLink(userA.userId))?.relay_device_id).toBe(
    desktop.deviceId,
  );

  // A device of B on the relay never sees A's computer and cannot open a
  // session to it, even with A's pinned host key.
  const { generateDeviceIdentity } = await import('@canopy/remote-session');
  const probe = await connectTestRelayDevice({
    relay,
    userExternalId: await externalIdOf(userB.userId),
    identity: await generateDeviceIdentity(),
  });
  try {
    expect(
      probe.client.peers.some((peer) => peer.deviceId === desktop.deviceId),
    ).toBe(false);
    const reach = await settle(
      probe.sessions.connect({
        peerDeviceId: desktop.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: target.hostPublicKey,
        delegation: null,
      }),
    );
    expect(reach.ok).toBe(false);
  } finally {
    probe.stop();
  }
});

test('removing the agents pairing on the desktop closes the pooled session and refuses the next call', async () => {
  test.setTimeout(120_000);
  const read = () =>
    agentA.call('project_list', { host: target.host, limit: 50 });
  expect((await read()).isError).toBe(false);
  const [pooled] = (await readHostedLeases(userA.userId)).filter((l) => l.live);
  expect(relay.connectedDeviceIds().has(pooled.relay_device_id)).toBe(true);

  const rootDeviceId = await hostedRootDeviceId();
  await desktop.window.evaluate(
    (deviceId) =>
      window.api.remoteControl.forgetDevice({ deviceId, role: 'controller' }),
    rootDeviceId,
  );
  expect(await hostedControllers()).toHaveLength(0);
  await relay.waitFor((ids) => !ids.has(pooled.relay_device_id), {
    label: 'the pooled session to close',
  });
  await expect
    .poll(async () => (await readHostedLeases(userA.userId)).length, POLL)
    .toBe(0);

  // The link still exists, but the desktop no longer trusts the root.
  expectToolError(await read(), 'host_unreachable');
  expect(
    (await readHostedLeases(userA.userId)).filter((l) => l.live),
  ).toHaveLength(0);
  const refused = await attemptDelegatedHandshake({
    relay,
    userExternalId: await externalIdOf(userA.userId),
    root: await loadHostedRootIdentity(userA.userId),
    host: { deviceId: desktop.deviceId, publicKey: target.hostPublicKey },
    expiresAt: Date.now() + 60_000,
  });
  expect(refused.ok).toBe(false);
});
