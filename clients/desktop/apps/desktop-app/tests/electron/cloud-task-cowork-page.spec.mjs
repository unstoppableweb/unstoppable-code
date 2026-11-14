import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import {
  agentTaskRow,
  BACKGROUND_AGENT,
  SEEDED_CATALOG,
  SEEDED_CLOUD_CHATS,
} from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { sharedSkillCreates } from './mock-server/routes/cloud.mjs';

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
// CAN-6543: a sleeping sandbox's File explorer says so and lists again once a
// turn wakes it.

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
    await body(window, cloud, handlerErrors, electronApp);
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
    // Core takes a while to start the turn, with none reported meanwhile.
    cloud.world.state.startDelayMs = 3_000;
    await openSeededTask(window);
    await expectBothChats(window);
    await send(window, 'Count to a thousand.');
    const stop = window.getByTestId('chat-stop-generation');
    // Stop can be pressed as soon as the message is sent, and stays while
    // Core starts the turn (CAN-6592).
    await expect(stop).toBeEnabled({ timeout: 2_000 });
    await expect.poll(() => cloud.world.state.sends.length).toBe(1);
    await window.waitForTimeout(1_500);
    expect(cloud.world.state.activeTurns).toEqual({});
    await expect(stop).toBeEnabled({ timeout: 100 });
    await expect
      .poll(() => Object.keys(cloud.world.state.activeTurns).length, {
        timeout: 15_000,
      })
      .toBe(1);

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

test('Stop pressed while a cloud send is still in flight cancels its turn once, by the receipt (CAN-6592)', async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    cloud.world.state.questions = [];
    cloud.world.state.replyDelayMs = 120_000;
    // The web core answers the send late: its turn has no id to stop by yet.
    cloud.world.state.sendDelayMs = 3_000;
    await openSeededTask(window);
    await expectBothChats(window);
    await send(window, 'Count to a million.');
    const stop = window.getByTestId('chat-stop-generation');
    await expect(stop).toBeEnabled({ timeout: 2_000 });
    await expect.poll(() => cloud.world.state.sends.length).toBe(1);
    await stop.click();
    // Nothing names the turn until the send answers.
    expect(cloud.world.state.cancels).toEqual([]);
    await expect
      .poll(() => cloud.world.state.cancels.length, { timeout: 15_000 })
      .toBe(1);
    expect(cloud.world.state.cancels[0]).toMatchObject({
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      turnId: `turn-${cloud.world.state.sends[0].commandId}`,
      reason: 'user',
    });
    await expect(window.getByText('Stopped.')).toBeVisible({ timeout: 15_000 });
    await expect(stop).toHaveCount(0);
    // One press, one cancel, and the turn never ran its reply.
    expect(cloud.world.state.cancels).toHaveLength(1);
    await expect(
      window.getByText('Seeded reply: Count to a million.'),
    ).toHaveCount(0);
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

test("a sleeping cloud sandbox's File explorer says so, lists once a turn wakes it, and drops a deleted row (CAN-6543)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    cloud.world.state.questions = [];
    cloud.world.state.sandboxAsleep = true;
    await openSeededTask(window);
    await expectBothChats(window);
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    // The web core's reason crosses main's relay and the preload.
    await expect(window.getByTestId('files-tree-sandbox-sleeping')).toHaveText(
      'Project is sleeping. Send a message to wake it.',
      { timeout: 15_000 },
    );
    await expect(window.getByTestId('files-tree-folder-error')).toHaveCount(0);
    await expect(window.getByTestId('files-tree-sandbox-wake')).toHaveCount(0);

    // A sent turn wakes the sandbox; the explorer lists it with no refresh.
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.rootChatId}`,
      )
      .click();
    await send(window, 'Wake up.');
    await expect(window.getByText('Seeded reply: Wake up.')).toBeVisible();
    await window
      .locator('[role="tab"][data-panel-kind="file-explorer"]')
      .first()
      .click();
    const notes = window.locator('[data-file-tree-id$=":notes"]:visible');
    await expect(notes.first()).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId('files-tree-sandbox-sleeping')).toHaveCount(
      0,
    );

    // A deleted folder's row leaves as the delete lands.
    await notes.first().click({ button: 'right' });
    await window.getByTestId('files-tree-action-delete').click();
    await window.getByTestId('files-tree-delete-confirm-button').click();
    await expect
      .poll(() => cloud.world.state.deletes.length, { timeout: 15_000 })
      .toBe(1);
    await expect(notes).toHaveCount(0);
    await expect(window.getByText('README.md').first()).toBeVisible();
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

test("a cloud task archives from its own tab's menu or its sidebar row, and a refusal stays in the dialog (CAN-6511)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud, handlerErrors) => {
    await openSeededTask(window);
    await expectBothChats(window);
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="web-core:${SEEDED_CLOUD_CHATS.taskId}"]`,
    );

    // The task's own chat tab can't close; its menu archives the task.
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.rootChatId}`,
      )
      .click({ button: 'right' });
    await window.getByTestId('panel-tab-context-archive').click();
    const confirm = window.getByTestId('cloud-task-archive-confirm');
    await expect(confirm).toBeVisible();

    // A refusal keeps the dialog open and says so; the task stays.
    cloud.world.state.extraAnswers.set('core.chat.archive', () => ({
      error: {
        kind: 'unavailable',
        message: 'The web core is restarting.',
        retry: { kind: 'never' },
      },
    }));
    await window.getByTestId('cloud-task-archive-confirm-button').click();
    await expect(
      confirm.getByText("Couldn't archive the task. Try again."),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row.first()).toBeVisible();

    // The sidebar row's Archive asks first, then archives once it's served.
    cloud.world.state.extraAnswers.delete('core.chat.archive');
    await row.first().click({ button: 'right' });
    await window.getByTestId('worktree-actions-menu-archive').first().click();
    const rowConfirm = window.getByTestId('portal-delete-worktree-confirm');
    await expect(rowConfirm).toBeVisible();
    await rowConfirm.getByRole('button', { name: /^Archive/ }).click();
    await expect(rowConfirm).toHaveCount(0);
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(cloud.world.state.archived.has(SEEDED_CLOUD_CHATS.taskId)).toBe(
      true,
    );
    // The open task is left for home, and nothing local is asked about it.
    await expect(
      window.getByTestId('page-home').getByTestId('home-surface'),
    ).toBeVisible();
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveCount(
      0,
    );
    expect(
      handlerErrors.filter((error) =>
        error.includes(SEEDED_CLOUD_CHATS.taskId),
      ),
    ).toEqual([]);
  });
});

test("a cloud task's Activity lists its project's workspace files, and no Summary (CAN-6568)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    cloud.world.addWorkspaceFile({ name: 'ericeira_weather_next_5_days.csv' });
    await openSeededTask(window);
    await expectBothChats(window);

    // A task with files but no todos or background work shows the files in
    // its Activity, never "No activity yet".
    await expandDefaultActivityRail(window);
    const activity = window.getByTestId('panel-group-group-activity');
    await expect(
      activity.getByText('ericeira_weather_next_5_days.csv'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(activity.getByTestId('activity-list-empty')).toHaveCount(0);
    await window.locator('[data-testid^="panel-add-tab-"]').first().click();
    await expect(
      window.getByTestId('panel-add-menu-item-activity-card-summary'),
    ).toHaveCount(0);
    await window
      .getByTestId('panel-add-menu-item-activity-card-workspace-files')
      .click();
    const files = window.getByTestId('portal-workspace-files').first();
    await expect(
      files
        .getByTestId('workspace-file-row')
        .getByText('ericeira_weather_next_5_days.csv'),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test("a cloud chat's Plugins picker names each source and lists a curated skill once (CAN-6397)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window) => {
    await openSeededTask(window);
    await expectBothChats(window);
    // The second chat has no pending question, so its composer shows.
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`,
      )
      .click();
    await window.getByTestId('chat-input-plus-button').last().click();
    await window.getByTestId('chat-plugins-button').click();
    const table = window.getByTestId('unified-table');
    await expect(
      table.getByText(SEEDED_CATALOG.marketplacePluginName, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    // Source reads the web core's label, never a raw marketplace or
    // curated id.
    await expect(
      table.getByText(SEEDED_CATALOG.marketplaceLabel, { exact: true }),
    ).toBeVisible();
    await expect(
      table.locator('td', { hasText: /marketplace:|cloud-curated/ }),
    ).toHaveCount(0);
    // The curated skill is listed once, as its curated plugin.
    await expect(
      table.getByText(SEEDED_CATALOG.curatedName, { exact: true }),
    ).toHaveCount(1);
    // No row carries a date, so there is no column of dashes.
    await expect(
      table.getByRole('columnheader', { name: 'Last updated' }),
    ).toHaveCount(0);
  });
});

test("a cloud chat's tool approval shows in its composer, and Allow answers the web core (CAN-6515)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    await openSeededTask(window);
    await expectBothChats(window);
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`,
      )
      .click();
    // Let the chat's approval stream open before Core asks.
    await window.waitForTimeout(1_000);
    cloud.world.raiseApproval(SEEDED_CLOUD_CHATS.secondChatId, {
      toolName: 'Bash',
      toolCallId: 'toolu_e2e_ls',
      command: 'ls -la notes',
    });
    const card = window.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('ls -la notes')).toBeVisible();
    // Cloud chats keep no approval rules: Allow once and Deny only.
    await expect(
      card.getByRole('button', { name: 'More allow options' }),
    ).toHaveCount(0);
    await window.getByTestId('tool-approval-allow').click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    expect(cloud.world.state.approvalAnswers).toEqual([
      expect.objectContaining({ decision: 'allow', stopTurn: false }),
    ]);
  });
});

test("a cloud chat's file link opens in the viewer, one outside the task folder is refused, and its Files panel renames and reopens a file (CAN-6587)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud) => {
    await openSeededTask(window);
    await expectBothChats(window);
    // The first chat waits on a question; the second takes a message.
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`,
      )
      .click();
    await send(
      window,
      'See [the checklist](/vercel/sandbox/workspace/notes/checklist.md) and [the hosts file](/etc/hosts).',
    );
    const link = (name) =>
      window
        .getByTestId('chat-local-file-link')
        .filter({ hasText: name })
        .last();
    await expect(link('the checklist')).toBeVisible({ timeout: 15_000 });

    // A link into the task folder opens the file in the viewer, read over the
    // web core; one outside it is refused and opens nothing.
    await link('the checklist').click();
    await expect(
      window.getByText('Write the announcement').first(),
    ).toBeVisible({ timeout: 15_000 });
    await link('the hosts file').click();
    await expect(
      window.getByText("This file isn't in the task's folder").first(),
    ).toBeVisible();

    // The Files panel browses the task folder, renames a file there, and
    // opens it under its new name.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    const readme = window.getByText('README.md', { exact: true }).first();
    await expect(readme).toBeVisible({ timeout: 15_000 });
    await readme.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    const editor = window.getByTestId('files-tree-inline-editor');
    await editor.fill('LAUNCH.md');
    await editor.press('Enter');
    const renamed = window.getByText('LAUNCH.md', { exact: true }).first();
    await expect(renamed).toBeVisible({ timeout: 15_000 });
    expect(Object.keys(cloud.world.state.files)).toContain('LAUNCH.md');
    await renamed.click();
    await expect(
      window.getByText('Ship the cloud chats beta on Friday.').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test("a cloud chat's deliverable saves through main's save dialog, and opens from its saved copy while the sandbox sleeps (CAN-6587)", async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window, cloud, _errors, electronApp) => {
    const chatId = SEEDED_CLOUD_CHATS.secondChatId;
    const deliverableId = cloud.world.addDeliverable(chatId, {
      session: 'session-1',
      name: 'weather.csv',
      content: 'day,swell\nMonday,surfable\n',
    });
    await openSeededTask(window);
    await expectBothChats(window);
    await window.getByTestId(`panel-tab-panel-chat-web-core:${chatId}`).click();
    await send(
      window,
      'Saved [the forecast](/vercel/sandbox/workspace/deliverables/session-1/weather.csv).',
    );
    const link = window
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'the forecast' })
      .last();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(window.getByText(/surfable/).first()).toBeVisible({
      timeout: 15_000,
    });

    // Download asks main for a path; the renderer never names one, and main
    // writes there what it read over its own web core connection.
    const saveDir = mkdtempSync(path.join(os.tmpdir(), 'cloud-download-'));
    const chosen = path.join(saveDir, 'forecast.csv');
    await electronApp.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog;
      dialog.showSaveDialog = async (...args) => {
        dialog.showSaveDialog = original;
        const options = args.length > 1 ? args[1] : args[0];
        globalThis.__can6587SuggestedPath = options?.defaultPath;
        return { canceled: false, filePath };
      };
    }, chosen);
    await window.getByTestId('file-viewer-cloud-download').first().click();
    await expect
      .poll(() => (existsSync(chosen) ? readFileSync(chosen, 'utf8') : null), {
        timeout: 15_000,
      })
      .toBe('day,swell\nMonday,surfable\n');
    expect(
      path.basename(
        await electronApp.evaluate(() => globalThis.__can6587SuggestedPath),
      ),
    ).toBe('weather.csv');
    expect(cloud.world.state.artifactReads).toContainEqual(
      expect.objectContaining({
        artifactId: `deliverable:${deliverableId}`,
        scope: { chatId },
      }),
    );
    rmSync(saveDir, { recursive: true, force: true });

    // Asleep, the sandbox serves no file, but a link to a deliverable the
    // viewer never opened reads its saved copy.
    const tidesId = cloud.world.addDeliverable(chatId, {
      session: 'session-1',
      name: 'tides.csv',
      content: 'time,tide\n06:00,flooding\n',
    });
    await window.getByTestId(`panel-tab-panel-chat-web-core:${chatId}`).click();
    await send(
      window,
      'And [the tides](/vercel/sandbox/workspace/deliverables/session-1/tides.csv).',
    );
    const tides = window
      .getByTestId('chat-local-file-link')
      .filter({ hasText: 'the tides' })
      .last();
    await expect(tides).toBeVisible({ timeout: 15_000 });
    cloud.world.state.sandboxAsleep = true;
    await tides.click();
    await expect(window.getByText(/flooding/).first()).toBeVisible({
      timeout: 15_000,
    });
    expect(cloud.world.state.artifactReads).toContainEqual(
      expect.objectContaining({
        artifactId: `deliverable:${tidesId}`,
        scope: { chatId },
      }),
    );
  });
});

test("a desktop skill shows in a cloud chat's Plugins picker and reaches the cloud account only once Add is pressed (CAN-6176)", async () => {
  test.setTimeout(240_000);
  sharedSkillCreates.length = 0;
  await withSeededCoworkPage(async (window) => {
    // A custom skill on this computer, made as the Skills page makes one.
    const saved = await window.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.catalog.skill.custom.save',
        params: {
          name: 'release-notes',
          originalName: null,
          description: 'Writes the release notes.',
          body: '# Release notes\n\nList what changed since the last tag.\n',
          extraMetadata: null,
          preservedMetadata: null,
          files: null,
          _meta: { idempotencyKey: crypto.randomUUID() },
        },
      }),
    );
    expect(saved.ok).toBe(true);

    await openSeededTask(window);
    await expectBothChats(window);
    await window
      .getByTestId(
        `panel-tab-panel-chat-web-core:${SEEDED_CLOUD_CHATS.secondChatId}`,
      )
      .click();
    const openPicker = async () => {
      await window.getByTestId('chat-input-plus-button').last().click();
      await window.getByTestId('chat-plugins-button').click();
    };
    await openPicker();
    const item = window
      .getByTestId('portal-plugins-local-item')
      .filter({ hasText: 'release-notes' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toContainText('Add to cloud');

    // Add opens the consent, which lists what goes; Cancel sends nothing.
    await item.getByTestId('portal-plugins-local-add').click();
    const consent = window.getByTestId('cloud-copy-consent');
    await expect(consent).toBeVisible({ timeout: 15_000 });
    await expect(consent.getByTestId('cloud-copy-consent-sent')).toContainText(
      'SKILL.md',
      { timeout: 15_000 },
    );
    await consent.getByRole('button', { name: 'Cancel' }).click();
    await expect(consent).toHaveCount(0);
    expect(sharedSkillCreates).toHaveLength(0);

    // Add again, then Add in the consent: the skill goes once, privately.
    await item.getByTestId('portal-plugins-local-add').click();
    await expect(consent).toBeVisible({ timeout: 15_000 });
    const add = consent.getByTestId('cloud-copy-consent-add');
    await expect(add).toBeEnabled({ timeout: 15_000 });
    await add.click();
    await expect.poll(() => sharedSkillCreates.length).toBe(1);
    expect(sharedSkillCreates[0]).toMatchObject({ shareScope: 'private' });
    expect(sharedSkillCreates[0].rawSkill).toContain('release-notes');
    await expect(consent).toHaveCount(0, { timeout: 15_000 });
    // Nothing more goes after the dialog closes.
    await window.waitForTimeout(1_000);
    expect(sharedSkillCreates).toHaveLength(1);
  });
});
