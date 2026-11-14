// Main-owned chat persistence regression (backend plan).
//
// Run after `pnpm run build:e2e`:
//   pnpm exec playwright test chat-main-owned-persistence.spec.mjs --reporter=line
//
// The provider response is delayed by the shared mock server. The spec closes
// the only renderer after the user prompt is accepted, waits for Electron main
// to journal the terminal response, then relaunches with the same userDataDir.
// All fixtures and provider responses are local and deterministic.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  initializeIsolatedCodexState,
  registerScenario,
  seedOrphanedStreamingTurn,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import { SEEDED_CLOUD_CHATS } from './fixtures/cloudChatsWorld.js';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const SECOND_WORKTREE_ID = 'renderer-detached';
const SECOND_CHAT_TITLE = 'Detached renderer sentinel';
const CHAT_ID = 'main-owned-chat';
const CHAT_TITLE = 'Main-owned persistence';
const CASES = [
  {
    provider: 'claude',
    model: 'sonnet',
    marker: 'Canopy-CMAINOWNED-CLAUDE',
    reply: 'Claude durable reply completed with no renderer attached',
    toolOutput: 'No persisted output found for script',
  },
  {
    provider: 'codex',
    model: 'gpt-5.5',
    marker: 'Canopy-CMAINOWNED-CODEX',
    reply: 'Codex durable reply completed with no renderer attached',
  },
];

function seedPreferences(userDataDir, provider) {
  const defaultModel = provider === 'claude' ? 'haiku' : 'gpt-6-sol';
  const mcpProxyPort = 41_000 + (Date.now() % 20_000);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: provider,
          defaultChatProvider: provider,
          defaultChatInterfaceMode: 'canopy',
          defaultStandaloneChatInterfaceMode: 'canopy',
          defaultAppAdvisorInterfaceMode: 'canopy',
          mcpProxyPort,
          defaultWorktreeModelByProvider: {
            [provider]: { model: defaultModel, thinkingLevel: 'high' },
          },
          defaultChatModelByProvider: {
            [provider]: { model: defaultModel, thinkingLevel: 'high' },
          },
          providerModelConfigDefaults: {
            [provider]: { thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    ),
  );
}

function addSecondWorktree(userDataDir, seed) {
  const repoPath = seed.workspaces[0]?.repoPath;
  if (!repoPath) throw new Error('Expected a seeded source repository');
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const worktreePath = path.join(workspaceDir, 'worktrees', SECOND_WORKTREE_ID);
  execFileSync(
    'git',
    ['worktree', 'add', '-b', SECOND_WORKTREE_ID, worktreePath],
    { cwd: repoPath, stdio: 'pipe' },
  );
  const worktreesPath = path.join(workspaceDir, 'worktrees.json');
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  worktrees.worktrees.push({
    id: SECOND_WORKTREE_ID,
    branchName: SECOND_WORKTREE_ID,
    createdAt: '2026-08-07T00:00:00.000Z',
    trackedBaseBranch: 'main',
  });
  writeFileSync(worktreesPath, `${JSON.stringify(worktrees, null, 2)}\n`);
}

function storageDirectory(userDataDir) {
  return path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'chat-storage-v2',
    WORKTREE_ID,
  );
}

function readDurableTurn(userDataDir, testCase, userMessage) {
  try {
    const root = storageDirectory(userDataDir);
    const tabs = JSON.parse(
      readFileSync(path.join(root, 'live-index.json'), 'utf8'),
    );
    const tab = tabs.tabs.find((candidate) => candidate.id === CHAT_ID);
    const runtime = tabs.runtimeByChatId[CHAT_ID];
    const messages = readFileSync(
      path.join(root, 'transcripts', `${CHAT_ID}.jsonl`),
      'utf8',
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const committedUserCount = messages.filter(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message).includes(userMessage),
    ).length;
    const activePath = path.join(root, 'transcripts', `${CHAT_ID}.active.json`);
    if (existsSync(activePath)) {
      const committedIds = new Set(messages.map((message) => message.id));
      messages.push(
        ...JSON.parse(readFileSync(activePath, 'utf8')).messages.filter(
          (message) => !committedIds.has(message.id),
        ),
      );
    }
    const serialized = JSON.stringify(messages);
    const userCount = messages.filter(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message).includes(userMessage),
    ).length;
    return {
      title: tab?.title,
      description: tab?.description,
      model: tab?.model,
      sessionId: tab?.sdkSessionId,
      committedUserCount,
      userCount,
      hasReply: serialized.includes(testCase.reply),
      hasTool:
        !testCase.toolOutput ||
        (serialized.includes('tool_use') &&
          serialized.includes('tool_result') &&
          serialized.includes(testCase.toolOutput)),
      hasCompletedTimer:
        serialized.includes('turn_timer') && serialized.includes('completedAt'),
      runtimeStatus: runtime?.status,
    };
  } catch {
    return null;
  }
}

function readManualCancellationRecord(userDataDir) {
  try {
    const recovery = JSON.parse(
      readFileSync(
        path.join(storageDirectory(userDataDir), 'recovery-index.json'),
        'utf8',
      ),
    );
    const mutationId = recovery.mutationIds.find((id) =>
      id.startsWith('manual-cancellation:'),
    );
    return mutationId ? { mutationId } : null;
  } catch {
    return null;
  }
}

async function chatTabIds(window) {
  const ids = await window
    .locator('[data-testid^="panel-tab-panel-chat-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid'))
        .filter((id) => id !== null && !id.includes('panel-tab-close')),
    );
  return ids.map((id) => id.replace('panel-tab-panel-chat-', ''));
}

/** Creates a new chat tab via the chat group's "+" button; returns its id. */
async function createChatTab(window) {
  const before = new Set(await chatTabIds(window));
  await window.getByTestId('panel-add-tab-group-chat').click();
  await window.getByTestId('panel-add-menu-item-new-chat').click();
  let created = null;
  await expect
    .poll(async () => {
      const after = await chatTabIds(window);
      created = after.find((id) => !before.has(id)) ?? null;
      return created;
    })
    .not.toBeNull();
  await expect(
    window.getByTestId(`panel-tab-panel-chat-${created}`),
  ).toHaveAttribute('aria-selected', 'true');
  return created;
}

test('an orphaned timer is settled with canonical runtime after app restart', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-main-owned-orphaned-turn-'),
  );
  seedPreferences(userDataDir, 'codex');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const seeded = seedOrphanedStreamingTurn({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
  });
  const seededChat = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'chats',
        `${WORKTREE_ID}.json`,
      ),
      'utf8',
    ),
  );
  const seededTimer = seededChat.tabs
    .find((tab) => tab.id === CHAT_ID)
    ?.messages.flatMap((message) => message.blocks ?? [])
    .find((block) => block.type === 'turn_timer');
  expect(seededTimer).toEqual({ type: 'turn_timer', completedAt: null });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');

    await expect(panel.getByText(seeded.finalText).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      window.getByRole('button', { name: 'Stop generation' }),
    ).toHaveCount(0);
    await expect(panel.getByText(/Working…/)).toHaveCount(0);
    await expect(
      panel
        .locator('[data-testid="turn-timer"][data-state="completed"]')
        .last(),
    ).toBeVisible();

    const composer = window.getByRole('textbox').first();
    await composer.fill('Follow-up after the interrupted turn');
    await expect(
      window.getByRole('button', { name: 'Send message' }),
    ).toBeEnabled();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('manual cancellation is journaled before the renderer receives it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-main-owned-cancel-'),
  );
  seedPreferences(userDataDir, 'codex');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Main-owned cancellation',
        providerType: 'codex',
        model: 'gpt-5.5',
        messages: [],
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
    ).toBeVisible({ timeout: 30_000 });

    await window.evaluate((request) => window.api.chat.cancel(request), {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
    });

    await expect
      .poll(() => readManualCancellationRecord(userDataDir), {
        timeout: 15_000,
      })
      .toMatchObject({
        mutationId: expect.stringContaining('manual-cancellation:'),
      });
    await expect(composerIdleAction(window)).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

// Regression: a freshly created, unused draft tab must be committed to
// main-owned canonical state immediately. Pre-fix the draft existed only in
// the renderer, so returning to it dispatched an activation main rejected
// with not_found — showing "This chat changed elsewhere. Your view has been
// refreshed." and erasing the draft — and a relaunch lost the empty tab.
test('an unused draft tab survives tab switching and app relaunch', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-main-owned-draft-'),
  );
  seedPreferences(userDataDir, 'claude');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: CHAT_TITLE,
        providerType: 'claude',
        model: 'sonnet',
        messages: [],
      },
    ],
  });

  const first = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  let firstClosed = false;
  let draftId = null;
  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
    ).toBeVisible({ timeout: 30_000 });

    draftId = await createChatTab(window);

    // Click into the seeded tab, then return to the unused draft. Every tab
    // keeps its own content element mounted, so scope by data-panel-id.
    const chatContentFor = (id) =>
      window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${id}"]`,
      );
    const draftText =
      'Unsent human draft survives canonical tab activation and navigation.';
    await chatContentFor(draftId)
      .getByRole('textbox')
      .first()
      .pressSequentially(draftText);
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
    await expect(chatContentFor(CHAT_ID)).toBeVisible();
    await window.getByTestId(`panel-tab-panel-chat-${draftId}`).click();
    await expect(chatContentFor(draftId)).toBeVisible();
    await expect(
      chatContentFor(draftId).getByRole('textbox').first(),
    ).toContainText(draftText);

    // The draft must not be refreshed away as a conflict.
    await expect(window.getByTestId('chat-state-conflict-notice')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${draftId}`),
    ).toBeVisible();

    // The empty draft must reach the v2 metadata index before shutdown.
    const tabsPath = path.join(
      storageDirectory(userDataDir),
      'live-index.json',
    );
    await expect
      .poll(
        () => {
          try {
            const persisted = JSON.parse(readFileSync(tabsPath, 'utf8'));
            return persisted.tabs.map((tab) => tab.id);
          } catch {
            return [];
          }
        },
        { timeout: 20_000 },
      )
      .toContain(draftId);

    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    firstClosed = true;

    // The empty draft is durable main-owned state and survives a relaunch.
    const second = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const relaunchedWindow = await second.electronApp.firstWindow();
      const relaunchedApp = new CanopyAppDriver(relaunchedWindow);
      await relaunchedApp.waitForShell({ timeout: 30_000 });
      await relaunchedApp.openMainPage();
      await relaunchedApp.selectWorktree(WORKTREE_BRANCH);
      await expect(
        relaunchedWindow.getByTestId(`panel-tab-panel-chat-${draftId}`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        relaunchedWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`),
      ).toBeVisible();
    } finally {
      await closeCanopy(second.electronApp, userDataDir);
    }
  } finally {
    if (!firstClosed) await closeCanopy(first.electronApp, userDataDir);
  }
});

for (const testCase of CASES) {
  test(`a ${testCase.provider} turn completes durably after its renderer is destroyed`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-chat-main-owned-${testCase.provider}-`),
    );
    seedPreferences(userDataDir, testCase.provider);
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    addSecondWorktree(userDataDir, seed);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: SECOND_WORKTREE_ID,
      providerType: testCase.provider,
      tabs: [
        {
          id: 'secondary-chat',
          title: SECOND_CHAT_TITLE,
          providerType: testCase.provider,
          model: testCase.model,
          messages: [],
        },
      ],
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: testCase.provider,
      tabs: [
        {
          id: CHAT_ID,
          title: CHAT_TITLE,
          providerType: testCase.provider,
          model: testCase.model,
          messages: [],
        },
      ],
    });
    const steps = testCase.toolOutput
      ? [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__GetScriptOutput',
                input: { scriptId: 'launch' },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            thinking: 'The renderer is absent, but main still owns this turn.',
            text: testCase.reply,
            stopReason: 'end_turn',
            streamMs: 30_000,
          },
        ]
      : [
          {
            thinking: 'The renderer is absent, but main still owns this turn.',
            text: testCase.reply,
            stopReason: 'end_turn',
            streamMs: 30_000,
          },
        ];
    await registerScenario(DEFAULT_MOCK_BASE_URL, testCase.marker, {
      llm: { steps },
    });

    if (testCase.provider === 'codex') {
      initializeIsolatedCodexState(userDataDir);
    }
    const first = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    let firstClosed = false;
    try {
      const window = await first.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      const userMessage = `[${testCase.marker}] Finish after this window closes.`;
      const composer = window.getByRole('textbox').first();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });

      // The optimistic renderer row can appear before the IPC handler has
      // finished creating the provider session. Wait for main's canonical
      // state to prove that the turn is genuinely live, then destroy the
      // renderer while the delayed assistant response is still outstanding.
      // V2 may keep the active turn in its sidecar until it settles, so this
      // pre-close checkpoint deliberately uses the main-owned API rather than
      // requiring an intermediate committed JSONL snapshot on disk.
      await expect
        .poll(
          () =>
            window.evaluate(
              async ({ projectId, worktreeId, chatId, prompt, reply }) => {
                const state = await window.api.chat.getState({
                  projectId,
                  worktreeId,
                });
                const tab = state.tabsFile.tabs.find(
                  (candidate) => candidate.id === chatId,
                );
                const serialized = JSON.stringify(tab?.messages ?? []);
                return {
                  userCount: (tab?.messages ?? []).filter(
                    (message) =>
                      message.role === 'user' &&
                      JSON.stringify(message).includes(prompt),
                  ).length,
                  hasReply: serialized.includes(reply),
                  runtimeStatus: state.runtimeByChatId[chatId]?.status,
                };
              },
              {
                projectId: WORKSPACE_ID,
                worktreeId: WORKTREE_ID,
                chatId: CHAT_ID,
                prompt: userMessage,
                reply: testCase.reply,
              },
            ),
          { timeout: 60_000, intervals: [100, 250, 500] },
        )
        .toMatchObject({
          userCount: 1,
          hasReply: false,
          runtimeStatus: 'streaming',
        });

      await app.selectWorktree(SECOND_WORKTREE_ID);
      await expect(window.getByTestId('panel-content-chat')).toHaveAttribute(
        'data-panel-id',
        'panel-chat-secondary-chat',
      );
      await expect(panel.getByText(userMessage)).toHaveCount(0);

      // Closing the only BrowserWindow destroys the renderer while leaving the
      // macOS Electron main process alive. The delayed provider response must
      // therefore complete without any renderer-owned store or subscription.
      await window.close();
      await expect
        .poll(() => readDurableTurn(userDataDir, testCase, userMessage), {
          timeout: 60_000,
          intervals: [100, 250, 500],
        })
        .toEqual({
          // A seeded meaningful creation title is a saved name, so the chat
          // is never eligible for a generated initial title (CAN-3652).
          title: CHAT_TITLE,
          description: undefined,
          model: testCase.model,
          sessionId: expect.any(String),
          committedUserCount: 1,
          userCount: 1,
          hasReply: true,
          hasTool: true,
          hasCompletedTimer: true,
          runtimeStatus: 'completed',
        });

      await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
      firstClosed = true;

      const second = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      );
      try {
        const relaunchedWindow = await second.electronApp.firstWindow();
        const relaunchedApp = new CanopyAppDriver(relaunchedWindow);
        await relaunchedApp.waitForShell({ timeout: 30_000 });
        await relaunchedApp.openMainPage();
        await relaunchedApp.selectWorktree(WORKTREE_BRANCH);
        const relaunchedPanel =
          relaunchedWindow.getByTestId('panel-content-chat');
        await expect(
          relaunchedPanel.getByText(userMessage).first(),
        ).toHaveCount(1);
        await expect(
          relaunchedPanel.getByText(testCase.reply).first(),
        ).toBeVisible();
        await expect(relaunchedPanel).toHaveAttribute(
          'data-panel-id',
          `panel-chat-${CHAT_ID}`,
        );
        const relaunchedTab = relaunchedWindow.getByTestId(
          `panel-tab-panel-chat-${CHAT_ID}`,
        );
        await expect(relaunchedTab).toContainText(CHAT_TITLE);
        await expect(relaunchedTab).not.toContainText('Mock topic summary');
        await expect(
          relaunchedWindow.getByRole('button', { name: 'Stop generation' }),
        ).toHaveCount(0);
      } finally {
        await closeCanopy(second.electronApp, userDataDir);
      }
    } finally {
      if (!firstClosed) await closeCanopy(first.electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, testCase.marker).catch(
        () => undefined,
      );
    }
  });
}

// CAN-5624: an unsent composer draft is kept per chat across a relaunch.
const DRAFT_OTHER_WORKSPACE_ID = 'demo-ts-npm-next';
const DRAFT_OTHER_CHAT_ID = 'scroll-restore-other-worktree';
const DRAFT_FIRST_CHAT_ID = 'scroll-restore-first';
const DRAFT_SECOND_CHAT_ID = 'scroll-restore-second';
const DRAFT_SECOND_CHAT_TITLE = 'First visit background chat';

function buildLongTranscript(turnCount = 48) {
  const messages = [];
  const startedAt = Date.parse('2026-04-10T12:00:00.000Z');
  for (let index = 0; index < turnCount; index += 1) {
    const turnStartedAt = startedAt + index * 60_000;
    messages.push(
      {
        id: `scroll-user-${index + 1}`,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `First chat transcript request ${index + 1}`,
          },
        ],
        timestamp: turnStartedAt,
      },
      {
        id: `scroll-assistant-${index + 1}`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text:
              index === 0
                ? 'Unique offscreen transcript marker'
                : `First seeded transcript line ${index + 1}`,
          },
        ],
        timestamp: turnStartedAt + 1_000,
      },
      {
        id: `scroll-timer-${index + 1}`,
        role: 'system',
        blocks: [
          {
            type: 'turn_timer',
            startedAt: turnStartedAt,
            completedAt: turnStartedAt + 2_000,
          },
        ],
        timestamp: turnStartedAt + 2_000,
      },
    );
  }
  return messages;
}

function distanceFromBottom(scroller) {
  return scroller.evaluate(
    (element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

/** Two demo workspaces: a shown chat and a long background chat, and one more. */
function seedBackgroundDraftChats(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-npm-next'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: DRAFT_FIRST_CHAT_ID,
    tabs: [
      {
        id: DRAFT_FIRST_CHAT_ID,
        title: 'First visit shown chat',
        blocks: [{ type: 'text', text: 'Shown chat transcript' }],
      },
      {
        id: DRAFT_SECOND_CHAT_ID,
        title: DRAFT_SECOND_CHAT_TITLE,
        messages: buildLongTranscript(48),
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: DRAFT_OTHER_WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: DRAFT_OTHER_CHAT_ID,
    tabs: [
      {
        id: DRAFT_OTHER_CHAT_ID,
        title: 'Other worktree chat',
        blocks: [{ type: 'text', text: 'Other worktree transcript' }],
      },
    ],
  });
}

function worktreeRowOf(window, workspaceId) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

function shownComposerOf(window) {
  return window
    .locator('[data-testid="panel-content-chat"]:visible')
    .first()
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
}

/** Opens the first workspace's background chat and leaves `draft` in it. */
async function typeBackgroundDraft(window, draft) {
  await worktreeRowOf(window, WORKSPACE_ID).click();
  await window
    .getByTestId(`panel-tab-panel-chat-${DRAFT_SECOND_CHAT_ID}`)
    .click();
  await shownComposerOf(window).fill(draft);
  await expect(shownComposerOf(window)).toHaveText(draft);
}

test('a background chat first shown after a worktree switch keeps its draft and opens at its latest message', async () => {
  // Hidden chats may mount only once their tab is first shown. The first
  // visit after a relaunch and a worktree switch must look exactly as when
  // every hidden chat mounted with its worktree.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-first-visit-'),
  );
  const draft = 'Background chat draft survives its first visit';
  seedBackgroundDraftChats(userDataDir);

  // First launch: leave a draft in the background chat, then make the other
  // chat the shown one so the next launch starts with the draft chat hidden.
  const { electronApp: firstApp } = await launchCanopy({ userDataDir });
  try {
    const window = await firstApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await typeBackgroundDraft(window, draft);
    await window
      .getByTestId(`panel-tab-panel-chat-${DRAFT_FIRST_CHAT_ID}`)
      .click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${DRAFT_FIRST_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
  } finally {
    await closeCanopy(firstApp, userDataDir, { keepUserData: true });
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await worktreeRowOf(window, WORKSPACE_ID).click();
    await expect(
      window.getByText('Shown chat transcript', { exact: true }),
    ).toBeVisible();
    await worktreeRowOf(window, DRAFT_OTHER_WORKSPACE_ID).click();
    await expect(
      window.getByText('Other worktree transcript', { exact: true }),
    ).toBeVisible();
    await worktreeRowOf(window, WORKSPACE_ID).click();

    // The background chat's first showing in this launch.
    const tab = window.getByTestId(
      `panel-tab-panel-chat-${DRAFT_SECOND_CHAT_ID}`,
    );
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(shownComposerOf(window)).toHaveText(draft);
    const scroller = window.locator(
      '[data-testid="chat-message-list-scroll"]:visible',
    );
    await expect
      .poll(() => distanceFromBottom(scroller), { timeout: 10_000 })
      .toBeLessThanOrEqual(1);
    expect(
      await scroller.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(320);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a draft left by switching worktrees comes back when the palette opens its chat after a relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-palette-draft-'),
  );
  const draft =
    'Go with full jitter and cap the delay at 30s. Also add a test that';
  seedBackgroundDraftChats(userDataDir);

  // First launch: type, then leave through the worktree list without
  // switching tabs.
  const { electronApp: firstApp } = await launchCanopy({ userDataDir });
  try {
    const window = await firstApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await typeBackgroundDraft(window, draft);
    await worktreeRowOf(window, DRAFT_OTHER_WORKSPACE_ID).click();
    await expect(
      window.getByText('Other worktree transcript', { exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(firstApp, userDataDir, { keepUserData: true });
  }

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await window.keyboard.press(
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+K`,
    );
    await expect(window.getByTestId('command-palette-input')).toBeVisible();
    const recentChat = window
      .getByTestId('command-palette')
      .getByRole('group', { name: 'Recent' })
      .getByRole('option', { name: new RegExp(DRAFT_SECOND_CHAT_TITLE) });
    await recentChat.hover();
    await expect(recentChat).toHaveAttribute('data-active', 'true');
    await window.keyboard.press('Enter');
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${DRAFT_SECOND_CHAT_ID}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(shownComposerOf(window)).toHaveText(draft);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a cloud chat draft typed just before quitting comes back after a relaunch', async () => {
  const cloud = await startCloudChatsWebCore();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cloud-chat-draft-'),
  );
  const draft = 'Cloud chat draft typed right before quitting';
  const env = {
    CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-desktop-cloud-chats': true,
    }),
  };
  const chatTabId = `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`;
  const openSecondChat = async (window) => {
    await connectMockCloudAccount(window, 'csk_cloud_chats');
    const task = window.locator(
      `[data-worktree-id="web-core:${SEEDED_CLOUD_CHATS.taskId}"]`,
    );
    await expect(task.first()).toBeVisible({ timeout: 30_000 });
    await task.first().click();
    await window.getByTestId(chatTabId).click();
    await expect(window.getByTestId(chatTabId)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    return window.getByTestId('chat-panel').first().getByRole('textbox').last();
  };
  try {
    const { electronApp: firstApp } = await launchCanopy({ userDataDir, env });
    try {
      const window = await firstApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const composer = await openSecondChat(window);
      await composer.click();
      await composer.pressSequentially(draft);
      await expect(composer).toHaveText(draft);
    } finally {
      await closeCanopy(firstApp, userDataDir, { keepUserData: true });
    }

    const { electronApp } = await launchCanopy({ userDataDir, env });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const composer = await openSecondChat(window);
      await expect(composer).toHaveText(draft);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await cloud.close();
  }
});
