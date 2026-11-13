import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import { SEEDED_CLOUD_CHATS } from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-6333: the seeded cloud task (CAN-6280) on the cowork page, the page
// R2b turns on for every cloud task. The spec opts this build into it, since
// the routing switch is off until then. Opening the task shows the chat
// panel with both of the task's chats, the root chat's transcript and its
// pending question, read through the desktop chat store's web core backend.
// CAN-6334: when that read fails, the page says why and offers Try again.

/** As `CLOUD_CHATS_STANDALONE_PAGE_E2E_KEY` in cloud-chat-routing.ts. */
const COWORK_PAGE_OPT_IN = 'canopy.e2e.cloudChatsUseStandalonePage';

/**
 * Launches the app against the seeded world, opted in to the cowork page,
 * runs `body` with the window and the fake web core, and closes both.
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
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(
      (key) => window.localStorage.setItem(key, '1'),
      COWORK_PAGE_OPT_IN,
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, 'csk_cloud_chats');
    await body(window, cloud);
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

test('a seeded cloud task opens on the cowork page with both of its chats', async () => {
  test.setTimeout(180_000);
  await withSeededCoworkPage(async (window) => {
    await openSeededTask(window);
    await expect(window.getByTestId('cloud-chat-page')).toHaveCount(0);
    await expectBothChats(window);
    await expect(
      window.getByText('What do we still need before the launch?'),
    ).toBeVisible();
    await expect(
      window.getByText('Which room should I book for the demo?'),
    ).toBeVisible();
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
