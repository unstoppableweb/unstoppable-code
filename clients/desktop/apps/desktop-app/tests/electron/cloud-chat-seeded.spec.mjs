import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import { SEEDED_CLOUD_CHATS } from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-6280: a seeded cloud chat, against the built app and a fake web core
// over the real POST + SSE binding. With cloud chats on and the mock account
// signed in, the sidebar lists the seeded cloud project and task; opening
// the task shows it on the cowork page (CAN-6175 R2b) with its transcript
// and its pending question, and once the question is answered a sent
// message reaches the web core and comes back, with its reply, as chat
// events.

const SENT = 'Book Studio B for Thursday at 3pm.';

test('a seeded cloud chat opens, shows its question and sends a message', async () => {
  test.setTimeout(180_000);
  const cloud = await startCloudChatsWebCore();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cloud-chat-seeded-'));
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
    await connectMockCloudAccount(window, 'csk_cloud_chats');

    const task = window.locator(
      `[data-worktree-id="web-core:${SEEDED_CLOUD_CHATS.taskId}"]`,
    );
    await expect(task.first()).toBeVisible({ timeout: 30_000 });
    await expect(task.first()).toContainText(SEEDED_CLOUD_CHATS.taskTitle);
    await task.first().click();

    const page = window.getByTestId('chat-panel');
    await expect(page).toBeVisible();
    await expect(
      page.getByText('What do we still need before the launch?'),
    ).toBeVisible();
    await expect(
      page.getByText('Which room should I book for the demo?'),
    ).toBeVisible();

    // The pending question holds the composer until it is answered.
    await window.getByText('Studio B', { exact: true }).click();
    await expect.poll(() => cloud.world.state.answers.length).toBe(1);
    const composer = page.getByRole('textbox').first();
    await composer.click();
    await composer.fill(SENT);
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page.getByText(`Seeded reply: ${SENT}`)).toBeVisible();
    expect(cloud.world.state.sends).toHaveLength(1);
    expect(cloud.world.state.sends[0]).toMatchObject({
      chatId: SEEDED_CLOUD_CHATS.rootChatId,
      text: SENT,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
