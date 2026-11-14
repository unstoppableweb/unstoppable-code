import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  ENTRY_ID,
  expandCoworkWorkspace,
  seedDeliveryCoworkWorkspace,
  WORKSPACE_ID,
} from './coworkWorkEntryDoneFixture.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import { SEEDED_CLOUD_CHATS } from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-6175 R14: the cowork page's chrome follows each task's scope in the
// running app. A local cowork task and the seeded cloud task (CAN-6280) open
// side by side in one window: the local task's top bar offers Open in and its
// add menu offers the sections this computer serves; the cloud task's top bar
// has no Open in, since a cloud project has no folder here, and its add menu
// offers the sections the web core feeds, including MCP servers from the
// chat's catalog (CAN-6608). No IPC handler on main is given a cloud id.

/** The activity cards the open add menu offers, by section id. */
async function offeredCards(window) {
  await window.locator('[data-testid^="panel-add-tab-"]').first().click();
  const items = window.locator(
    '[data-testid^="panel-add-menu-item-activity-card-"]',
  );
  await expect(items.first()).toBeVisible();
  const ids = await items.evaluateAll((nodes) =>
    nodes.map((node) =>
      (node.getAttribute('data-testid') ?? '').replace(
        'panel-add-menu-item-activity-card-',
        '',
      ),
    ),
  );
  await window.keyboard.press('Escape');
  return ids;
}

function openIn(window) {
  return window
    .getByTestId('cowork-top-bar')
    .locator('[data-testid^="worktree-open"]');
}

test("the cowork top bar and activity rail follow each task's scope, local and cloud", async () => {
  test.setTimeout(180_000);
  const cloud = await startCloudChatsWebCore();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'cloud-cowork-chrome-'),
  );
  seedDeliveryCoworkWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cloud-chats': true,
      }),
    },
  });
  // Every IPC channel a cloud id reaches, invoked or sent. Only the web core
  // relay may take one; a local handler's refusal of a cloud id need not
  // name it, so the calls themselves are recorded rather than main's error
  // reports (CAN-6395).
  await electronApp.evaluate(
    ({ ipcMain }, ids) => {
      const reached = new Set();
      globalThis.__cloudIdChannels = reached;
      const note = (channel, args) => {
        let text = '';
        try {
          text = JSON.stringify(args) ?? '';
        } catch {
          text = '';
        }
        if (ids.some((id) => text.includes(id))) reached.add(channel);
      };
      const watch =
        (channel, handler) =>
        (event, ...args) => {
          note(channel, args);
          return handler(event, ...args);
        };
      const handlers = ipcMain._invokeHandlers;
      for (const [channel, handler] of handlers)
        handlers.set(channel, watch(channel, handler));
      const handle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = (channel, handler) =>
        handle(channel, watch(channel, handler));
      // A renderer's send reaches its ipcMain.on listeners through emit.
      const emit = ipcMain.emit.bind(ipcMain);
      ipcMain.emit = (channel, event, ...args) => {
        if (typeof channel === 'string') note(channel, args);
        return emit(channel, event, ...args);
      };
      return handlers.size;
    },
    ['web-core:', SEEDED_CLOUD_CHATS.taskId, SEEDED_CLOUD_CHATS.workspaceId],
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, 'csk_cloud_chats');

    // A local cowork task: Open in, and the sections this computer serves.
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 30_000,
    });
    await expect(openIn(window).first()).toBeVisible();
    const local = await offeredCards(window);
    expect(local).toEqual(expect.arrayContaining(['summary', 'notes']));

    // The cloud task in the same window: no Open in. The add menu offers the
    // web core's sections, including MCP servers (CAN-6608).
    const task = window.locator(
      `[data-worktree-id="web-core:${SEEDED_CLOUD_CHATS.taskId}"]`,
    );
    await expect(task.first()).toBeVisible({ timeout: 30_000 });
    await task.first().click();
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      SEEDED_CLOUD_CHATS.workspaceName,
    );
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(openIn(window)).toHaveCount(0);
    const cloudCards = await offeredCards(window);
    expect(cloudCards).toEqual(
      expect.arrayContaining(['todo', 'background-processes', 'mcp-servers']),
    );
    for (const local of [
      'summary',
      'notes',
      'cost',
      'memory',
      'prompts',
      'scripts',
      'hooks',
    ])
      expect(cloudCards).not.toContain(local);

    // Back to the local task: its chrome comes back with it.
    await expandCoworkWorkspace(window, WORKSPACE_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
    await expect(openIn(window).first()).toBeVisible();

    await window.waitForTimeout(1_000);
    const reached = await electronApp.evaluate(() => [
      ...globalThis.__cloudIdChannels,
    ]);
    expect(reached).toContain('canopy-core:relay');
    expect(
      reached.filter((channel) => channel !== 'canopy-core:relay'),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
