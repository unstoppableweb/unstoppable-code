import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeAuthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { externalProjectCandidateIdFor } from './seeders/seedExternalProjectImportFixture.mjs';
import {
  OPENCODE_FIXTURE_PROJECT,
  seedOpenCodeImportFixture,
} from './seeders/seedOpenCodeImportFixture.mjs';
import {
  seedT3CodeImportFixture,
  T3_FIXTURE_CODEX_TITLE,
  T3_FIXTURE_HISTORY_TITLE,
  T3_FIXTURE_PROJECT,
} from './seeders/seedT3CodeImportFixture.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';

// First run lands on the ordinary Home composer without the retired checklist.
// Provider steps use the harness auth fixtures; no live agent sends are needed.

test('fresh user reaches the ordinary Home composer after the first-run page', async () => {
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  // The examples preview only queues behind a connected tool, so pin GitHub
  // as signed in instead of reading the host's own `gh` login.
  const env = { GH_EXECUTABLE: writeAuthenticatedGhFixture(userDataDir) };
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboarding: true,
    env,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    // Fresh launch shows the blocking first-run legal gate before the shell.
    await app.acceptLegalConsent();
    await app.waitForShell();
    await app.skipFirstRunImport();

    await expect(
      window.getByTestId('home-onboarding-subscription-prompt'),
    ).toBeHidden();
    await expect(
      window.getByTestId('home-onboarding-credits-remaining'),
    ).toBeHidden();
    // After the first-run page, the surface is the Home composer.
    await expect(window.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
    await expect(window.getByTestId('home-onboarding-suggestions')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // Relaunch preserves individual dismissals and keeps the next suggestion visible.
  const second = await launchCanopy({ userDataDir, env });
  try {
    const window2 = await second.electronApp.firstWindow();
    const app2 = new CanopyAppDriver(window2);
    await app2.waitForShell();
    await expect(window2.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window2.getByTestId('home-onboarding-suggestions'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(second.electronApp, second.userDataDir);
  }
});

test('Home does not advertise plugin recommendations absent from the bundled catalog', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntries: [
        'plugin:universal:google',
        'plugin:universal:slack',
        'plugin:universal:notion',
        'plugin:universal:datadog',
      ],
      enabledPlugins: ['gmail'],
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    for (const name of ['google', 'slack', 'notion', 'datadog'])
      await expect(
        window.getByTestId(
          `home-onboarding-suggestion-plugin:universal:${name}`,
        ),
      ).toHaveCount(0);
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

function importedChats(userDataDir, workspaceName) {
  const index = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
  const workspace = index.workspaces.find(
    (entry) => entry.name === workspaceName,
  );
  if (!workspace) return [];
  const root = path.join(userDataDir, 'workspaces', workspace.id);
  const manifests = path.join(root, 'chat-storage-manifests');
  if (!existsSync(manifests)) return [];
  return readdirSync(manifests)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readChatStorageTabs(root, name.slice(0, -5)).tabs);
}

// T3 Code and OpenCode stores are real SQLite files under the isolated
// provider state; one T3 thread is backed by a Codex rollout, the rest import
// from the tools' own text copies as read-only history.
test('first run names T3 Code and OpenCode, and their chats import as history', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const t3 = seedT3CodeImportFixture({ userDataDir });
  const oc = seedOpenCodeImportFixture({ userDataDir });
  const t3Id = externalProjectCandidateIdFor(t3.projectDir);
  const ocId = externalProjectCandidateIdFor(oc.projectDir);
  const launch = await launchCanopy({
    userDataDir,
    freshOnboarding: true,
    env: { ...t3.env, ...oc.env },
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.acceptLegalConsent();
    await app.waitForShell();

    // The first-run page names the tool each project was used with.
    const firstRun = window.getByTestId('first-run-import-page');
    const rowTools = (id) =>
      firstRun
        .getByTestId(`first-run-import-row-${id}`)
        .getByTestId('first-run-import-row-tools');
    await expect(rowTools(t3Id)).toHaveAttribute('aria-label', /T3 Code/, {
      timeout: 60_000,
    });
    await expect(rowTools(ocId)).toHaveAttribute(
      'aria-label',
      'Used with OpenCode',
    );
    await app.skipFirstRunImport();

    await app.openSettings();
    await app.openSettingsSection('canopy');
    await window.getByTestId('settings-canopy-import-projects-open').click();
    const modal = window.getByTestId('import-projects-modal');
    const list = modal.getByTestId('import-projects-list');
    await expect(list).toBeVisible({ timeout: 60_000 });
    // The meta line carries the total; the note splits it by how each chat
    // imports, and the chats checkbox starts on for both rows.
    await expect(
      list.getByTestId(`import-projects-row-meta-${t3Id}`),
    ).toHaveText(/^Cowork project · 3 chats(?: · .+)?$/);
    await expect(
      list.getByTestId(`import-projects-row-chat-tiers-${t3Id}`),
    ).toHaveText(
      '1 continues in place · 2 import as history only · 1 archived',
    );
    await expect(
      list.getByTestId(`import-projects-row-chat-tiers-${ocId}`),
    ).toHaveText('All chats import as history only');
    for (const id of [t3Id, ocId]) {
      const chats = list.getByTestId(`import-projects-row-chats-${id}`);
      await expect(chats).toBeChecked();
      await expect(chats).toHaveAccessibleName('Import chats');
    }
    // Show chats lists the T3 titles, tagging only the history-only ones.
    await list
      .getByTestId(`import-projects-row-chat-list-${t3Id}-toggle`)
      .click();
    const t3Chats = list
      .getByTestId(`import-projects-row-chat-list-${t3Id}-body`)
      .locator('li[data-history-only]');
    await expect(t3Chats).toHaveCount(3);
    await expect(t3Chats.filter({ hasText: 'History only' })).toHaveCount(2);
    await expect(
      list
        .getByTestId(`import-projects-row-chat-list-${t3Id}-body`)
        .locator('li[data-history-only="true"]'),
    ).toHaveCount(2);
    await expect(
      list.getByTestId(`import-projects-row-chat-list-${t3Id}-body`),
    ).not.toContainText('(history only)');
    for (const box of await list
      .locator('[data-testid^="import-projects-row-checkbox-"]')
      .all()) {
      const id = (await box.getAttribute('data-testid'))?.slice(
        'import-projects-row-checkbox-'.length,
      );
      await box.setChecked(id === t3Id || id === ocId);
    }
    await modal.getByTestId('import-projects-submit').click();
    const results = modal.getByTestId('import-projects-results');
    await expect(results).toBeVisible({ timeout: 120_000 });
    await expect(
      results.getByTestId(`import-projects-result-${t3Id}`),
    ).toContainText('3 chats imported, 2 history only');
    await expect(
      results.getByTestId(`import-projects-result-${ocId}`),
    ).toContainText('2 chats imported, 2 history only');
    await modal.getByTestId('import-projects-done').click();
    await expect(modal).toHaveCount(0);

    // Importing persisted each project with its chats: the Codex-backed T3
    // thread continues, the rest are read-only history from their tool.
    const t3Tabs = importedChats(userDataDir, T3_FIXTURE_PROJECT);
    expect(t3Tabs).toHaveLength(3);
    expect(
      t3Tabs.every(
        (tab) => (tab.importedFrom === 't3code') === (tab.readOnly === true),
      ),
    ).toBe(true);
    const codexTab = t3Tabs.find((tab) => tab.title === T3_FIXTURE_CODEX_TITLE);
    expect(codexTab?.providerType).toBe('codex');
    expect(codexTab?.readOnly).toBeUndefined();
    expect(codexTab?.importedFrom).toBeUndefined();
    const grokTab = t3Tabs.find(
      (tab) => tab.title === T3_FIXTURE_HISTORY_TITLE,
    );
    expect(grokTab?.readOnly).toBe(true);
    expect(grokTab?.importedFrom).toBe('t3code');
    expect(grokTab?.providerType).toBeUndefined();
    const ocTabs = importedChats(userDataDir, OPENCODE_FIXTURE_PROJECT);
    expect(ocTabs).toHaveLength(2);
    expect(
      ocTabs.every((tab) => tab.importedFrom === 'opencode' && tab.readOnly),
    ).toBe(true);

    // An imported history chat says where it came from.
    if (await window.getByTestId('settings-overlay').isVisible())
      await app.closeSettings();
    await app.openChatPage();
    await window
      .locator(`text="${T3_FIXTURE_HISTORY_TITLE}"`)
      .locator('visible=true')
      .first()
      .click({ timeout: 30_000 });
    await expect(
      window
        .getByTestId('read-only-imported-notice')
        .locator('visible=true')
        .first(),
    ).toContainText('Imported from T3 Code', { timeout: 30_000 });
  } finally {
    try {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    } finally {
      t3.cleanup();
      oc.cleanup();
    }
  }
});
