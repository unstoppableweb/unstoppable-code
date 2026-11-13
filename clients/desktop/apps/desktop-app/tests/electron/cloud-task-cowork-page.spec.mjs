import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import {
  agentTaskRow,
  BACKGROUND_AGENT,
  SEEDED_CLOUD_CHATS,
} from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-6333: the seeded cloud task (CAN-6280) on the cowork page, where
// every cloud task opens since CAN-6175 R2b. Opening the task shows the chat
// panel with both of the task's chats, the root chat's transcript and its
// pending question, read through the desktop chat store's web core backend.
// CAN-6334: when that read fails, the page says why and offers Try again.
// CAN-6363: an idle chat's newest reply is settled, though the web core
// writes no turn timer rows. CAN-6367: a refused answer shows only the
// question card's own error. R2b: a chat's background agents and shells,
// from the web core's agent task rows, in the tray, with the subagent's row
// nested in its card.
// Answering the question from the composer and sending a message then reach
// the web core once each, and the reply comes back as chat events (CAN-6353).

const SENT = 'Book Studio B for Thursday at 3pm.';

/**
 * Launches the app against the seeded world, runs `body` with the window and
 * the fake web core, and closes both.
 */
async function withSeededCoworkPage(body) {
  const cloud = await startCloudChatsWebCore();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cloud-task-cowork-page-'),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cloud-chats': true,
      }),
    },
  });
  // Main's own report of an IPC handler that threw, such as a local read
  // given a cloud id (CAN-6395).
  const handlerErrors = [];
  electronApp.on('console', (message) => {
    const text = message.text();
    if (text.includes('Error occurred in handler for'))
      handlerErrors.push(text);
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, 'csk_cloud_chats');
    await body(window, cloud, handlerErrors);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
}

/** Opens the seeded task, running `beforeOpen` once its row is listed. */
async function openSeededTask(window, beforeOpen = () => {}) {
  const task = window.locator(
    `[data-worktree-id="web-core:${SEEDED_CLOUD_CHATS.taskId}"]`,
  );
  await expect(task.first()).toBeVisible({ timeout: 30_000 });
  beforeOpen();
  await task.first().click();
  await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
    SEEDED_CLOUD_CHATS.workspaceName,
  );
}

/** Sends `text` from the shown chat's composer. */
async function send(window, text) {
  const composer = window
    .getByTestId('chat-panel')
    .first()
    .getByRole('textbox')
    .last();
  await composer.click();
  await composer.fill(text);
  await window.keyboard.press('Enter');
}

async function expectBothChats(window) {
  await expect(window.getByTestId('chat-panel')).toBeVisible();
  for (const chatId of [
    SEEDED_CLOUD_CHATS.rootChatId,
    SEEDED_CLOUD_CHATS.secondChatId,
  ])
    await expect(
      window.getByTestId(`panel-tab-panel-chat-web-core:${chatId}`),
    ).toBeVisible();
}

test('a seeded cloud task on the cowork page shows both chats, answers its question and sends', async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    await openSeededTask(window);
    await expect(window.getByTestId('cloud-chat-page')).toHaveCount(0);
    await expectBothChats(window);
    await expect(
      window.getByText('What do we still need before the launch?'),
    ).toBeVisible();
    await expect(
      window.getByText('Which room should I book for the demo?'),
    ).toBeVisible();

    // The pending question takes the composer's place; a single-choice
    // option answers it.
    await window.getByText('Studio B', { exact: true }).first().click();
    await expect
      .poll(() => cloud.world.state.answers.length, { timeout: 15_000 })
      .toBe(1);
    expect(cloud.world.state.answers[0]).toMatchObject({
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      questionId: SEEDED_CLOUD_CHATS.questionId,
      answers: { room: { selectedOptions: ['Studio B'] } },
    });
    await expect(window.getByTestId('chat-question-option-1')).toHaveCount(0);
    // The answered turn runs on to its reply. Core records no result for the
    // question's call, yet the call shows the question with its answer, not
    // an interruption, and the chat leaves running (CAN-6394).
    await expect(window.getByText('Studio B it is.')).toBeVisible();
    await expect(window.getByText('Answers', { exact: true })).toBeVisible();
    await expect(
      window.getByText('Studio B', { exact: true }).first(),
    ).toBeVisible();
    await expect(window.getByText(/Interrupted/)).toHaveCount(0);
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);

    await send(window, SENT);
    await expect(window.getByText(`Seeded reply: ${SENT}`)).toBeVisible();
    expect(cloud.world.state.sends).toHaveLength(1);
    expect(cloud.world.state.sends[0]).toMatchObject({
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      text: SENT,
    });
    // The batch that commits the reply still reads Core's session as
    // streaming, with no turn: the turn is over (CAN-6396).
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
  });
});

test('Stop ends a running cloud turn, and a turn the web core no longer knows settles quietly (CAN-6393)', async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    const pageErrors = [];
    window.on('pageerror', (error) => pageErrors.push(String(error)));
    cloud.world.state.questions = [];
    cloud.world.state.replyDelayMs = 120_000;
    await openSeededTask(window);
    await expectBothChats(window);
    await send(window, 'Count to a thousand.');
    const stop = window.getByTestId('chat-stop-generation');
    await expect(stop).toBeVisible();

    // As the web core answered Stop before #8885: Core knows no such turn.
    const refused = [];
    cloud.world.state.extraAnswers.set('core.chat.turn.cancel', (params) => {
      refused.push(params);
      return {
        error: {
          kind: 'not_found',
          message:
            'agentic-core request failed with 404: Agent session turn not found',
          retry: { kind: 'never' },
        },
      };
    });
    const readsBefore = cloud.world.state.snapshotReads;
    await stop.click();
    await expect.poll(() => refused.length, { timeout: 15_000 }).toBe(1);
    // The chat is read again: nothing is left unhandled, and cloud chats
    // stay online.
    await expect
      .poll(() => cloud.world.state.snapshotReads, { timeout: 15_000 })
      .toBeGreaterThan(readsBefore);
    await window.waitForTimeout(1_000);
    expect(pageErrors.filter((error) => /turn not found/.test(error))).toEqual(
      [],
    );
    await expect(window.getByText('Cloud chats are offline')).toHaveCount(0);

    // The web core stops the turn by the id the receipt named.
    cloud.world.state.extraAnswers.delete('core.chat.turn.cancel');
    await stop.click();
    await expect(window.getByText('Stopped.')).toBeVisible();
    await expect(stop).toHaveCount(0);
    expect(cloud.world.state.cancels.at(-1)).toMatchObject({
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      turnId: `turn-${cloud.world.state.sends[0].commandId}`,
      reason: 'user',
    });
  });
});

test('a gateway that loses one cloud request leaves cloud chats online (CAN-6394)', async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    cloud.world.state.questions = [];
    await openSeededTask(window);
    await expectBothChats(window);
    // The sidebar's next re-read of the task meets a deploy closing its pod.
    cloud.failWithGateway('core.chat.task.list');
    await send(window, 'Ping.');
    await expect(window.getByText('Seeded reply: Ping.')).toBeVisible();
    await window.waitForTimeout(3_000);
    await expect(window.getByText('Cloud chats are offline')).toHaveCount(0);
    await expect(window.getByTestId('chat-panel')).toBeVisible();
    await send(window, 'Pong.');
    await expect(window.getByText('Seeded reply: Pong.')).toBeVisible();
  });
});

test("a running cloud turn's subagent card nests the subagent's own reply before the turn's reply commits", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    const chatId = SEEDED_CLOUD_CHATS.secondChatId;
    // The spawn call is in the running turn's live reply; the subagent's
    // own row is already in the transcript (55ea4e2123a).
    cloud.world.startBackgroundAgent(chatId, { replyCommitted: false });
    await openSeededTask(window);
    await expectBothChats(window);
    await window.getByTestId(`panel-tab-panel-chat-web-core:${chatId}`).click();
    const card = window.getByText('Explore agent (background)').first();
    await expect(card).toBeVisible();
    await expect(window.getByText('I see three config files.')).toHaveCount(0);
    await card.click();
    await expect(window.getByText('I see three config files.')).toBeVisible();
  });
});

test("a cloud task never hands its ids to this computer's worktree or file tree IPC (CAN-6395)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, _cloud, handlerErrors) => {
    await openSeededTask(window);
    await expectBothChats(window);
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`,
      )
      .click();
    // A File explorer tab watches nothing on this computer.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(window.getByText('README.md').first()).toBeVisible({
      timeout: 15_000,
    });
    await window.waitForTimeout(1_000);
    expect(
      handlerErrors.filter((error) =>
        /worktree:get-path|file-tree:watch/.test(error),
      ),
    ).toEqual([]);
  });
});

test("a cloud task whose chats don't load says why, and Try again loads them", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    // Refused once the sidebar has listed the task, so only the page's read
    // of the task fails, not the connection.
    const refusal = 'The chat list could not be read.';
    await openSeededTask(window, () =>
      cloud.world.state.extraAnswers.set('core.chat.list', () => ({
        error: {
          kind: 'internal',
          message: refusal,
          retry: { kind: 'never' },
        },
      })),
    );

    const notice = window.getByTestId('standalone-chat-load-error');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText('Couldn’t load this task’s chats');
    await expect(notice).toContainText(refusal);
    await expect(window.getByTestId('chat-panel')).toHaveCount(0);

    cloud.world.state.extraAnswers.delete('core.chat.list');
    await window.getByTestId('standalone-chat-load-retry').click();
    await expect(notice).toHaveCount(0);
    await expectBothChats(window);
  });
});

test("an idle cloud chat's newest reply is settled, with no question left preparing or Stop", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    // The question was answered elsewhere: the reply that asked it is idle.
    cloud.world.state.questions = [];
    // Just after a turn ends, the snapshot still reads Core's session as
    // streaming, with no turn (staging, 11 Nov 2026): nothing runs (CAN-6396).
    cloud.world.state.runtime[SEEDED_CLOUD_CHATS.rootChatId] = 'streaming';
    await openSeededTask(window);
    await expectBothChats(window);
    await expect(
      window.getByText('Before I book it, which room should I use?'),
    ).toBeVisible();
    // Both of the root chat's turns are settled and offer Copy.
    await expect(window.getByTestId('turn-copy-message')).toHaveCount(2);
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
    await expect(window.getByTestId('ask-user-question-preparing')).toHaveCount(
      0,
    );
  });
});

test("a refused cloud question answer shows only the card's own error", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    cloud.world.state.extraAnswers.set('core.chat.question.respond', () => ({
      error: {
        kind: 'failed_precondition',
        message: 'The question is no longer open.',
        retry: { kind: 'never' },
      },
    }));
    await openSeededTask(window);
    await expectBothChats(window);
    await window.getByText('Studio B', { exact: true }).click();
    await expect(window.getByText("Couldn't send your answer")).toBeVisible();
    await expect(
      window.getByTestId('chat-state-command-failed-notice'),
    ).toHaveCount(0);
  });
});

test("a cloud chat's background work shows in the tray and follows the web core's task rows", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    const chatId = SEEDED_CLOUD_CHATS.secondChatId;
    cloud.world.startBackgroundAgent(chatId);
    await openSeededTask(window);
    await expectBothChats(window);
    await window.getByTestId(`panel-tab-panel-chat-web-core:${chatId}`).click();
    // The subagent's own row nests in its spawn call's card.
    await expect(
      window.getByText(BACKGROUND_AGENT.description).first(),
    ).toBeVisible();
    await expect(window.getByText('I see three config files.')).toHaveCount(0);
    const pill = window.getByTestId('composer-work-pill');
    await expect(pill).toHaveText(/Running\s*2/);
    await pill.click();
    // A running row also draws its label in two aria-hidden shimmer copies.
    await expect(
      window
        .getByTestId('composer-work-drawer-list')
        .getByText(BACKGROUND_AGENT.shellDescription)
        .first(),
    ).toBeVisible();

    // Core reports the subagent done: only the shell still runs.
    cloud.world.replaceAgentTasks(chatId, [
      agentTaskRow({
        taskId: 'e2e-task-survey',
        stateVersion: '2',
        spawnToolCallId: BACKGROUND_AGENT.spawnToolCallId,
        description: BACKGROUND_AGENT.description,
        background: true,
        status: 'completed',
        summary: 'Found three config files.',
        completedAtMs: Date.now(),
      }),
      agentTaskRow({
        taskId: 'e2e-task-shell',
        kind: 'background_shell',
        description: BACKGROUND_AGENT.shellDescription,
        native: { toolName: 'Bash' },
        background: true,
      }),
    ]);
    await expect(pill).toHaveText(/Running\s*1/);
    // The subagent's card, opened, shows how its task ended.
    await window.getByText('Explore agent (background)').first().click();
    await expect(window.getByText('I see three config files.')).toBeVisible();
    await window.getByText('Show result').first().click();
    await expect(
      window.getByText('Found three config files.').first(),
    ).toBeVisible();

    // A failed subagent shows its error on its card.
    cloud.world.replaceAgentTasks(chatId, [
      agentTaskRow({
        taskId: 'e2e-task-survey',
        stateVersion: '3',
        spawnToolCallId: BACKGROUND_AGENT.spawnToolCallId,
        description: BACKGROUND_AGENT.description,
        background: true,
        status: 'failed',
        error: { code: 'crashed', message: 'Subagent crashed' },
        completedAtMs: Date.now(),
      }),
      agentTaskRow({
        taskId: 'e2e-task-shell',
        kind: 'background_shell',
        description: BACKGROUND_AGENT.shellDescription,
        native: { toolName: 'Bash' },
        background: true,
      }),
    ]);
    await expect(window.getByText('Subagent crashed').first()).toBeVisible();
    await expect(pill).toHaveText(/Running\s*1/);

    // The task's Activity offers the background work it has data for, and
    // nothing that reads this computer (CAN-6430, CAN-6431).
    await window.locator('[data-testid^="panel-add-tab-"]').first().click();
    await expect(
      window.getByTestId(
        'panel-add-menu-item-activity-card-background-processes',
      ),
    ).toBeVisible();
    await expect(
      window.getByTestId('panel-add-menu-item-activity-card-cost'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('panel-add-menu-item-activity-card-summary'),
    ).toHaveCount(0);
    await window
      .getByTestId('panel-add-menu-item-activity-card-background-processes')
      .click();
    await expect(
      window
        .getByTestId('activity-card-section-background-processes')
        .getByText(BACKGROUND_AGENT.shellDescription)
        .first(),
    ).toBeVisible();

    // Core reports no background work, the shell included: the tray empties.
    cloud.world.replaceAgentTasks(chatId, []);
    await expect(pill).toHaveCount(0);
  });
});
