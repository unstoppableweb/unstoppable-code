import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeAuthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  readChatStorageMessages,
  readChatStorageTabs,
} from './readChatStorage.mjs';
import {
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
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
// Providers and sends use isolated mock scenarios, never live accounts.

test('fresh user reaches the ordinary Home composer after the first-run page', async () => {
  test.setTimeout(60_000);

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  // The examples preview only queues behind a connected tool, so pin GitHub
  // as signed in instead of reading the host's own `gh` login.
  const fixture = seedExternalProjectImportFixture({ userDataDir });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { navigationMode: 'code' } }),
  );
  const mockKey = `can7038_${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, mockKey, {
    authUsage: { scenario: 'authed-low-usage' },
  });
  const env = {
    ...fixture.env,
    GH_EXECUTABLE: writeAuthenticatedGhFixture(userDataDir),
    CANOPY_MOCK_API_KEY: mockKey,
  };
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
    // Accepting the pre-checked defaults saves the choices with the terms:
    // Usage data on, activity sync left off, no onboarding decline.
    const accepted = await window.evaluate(() => window.api.loadPreferences());
    expect(accepted.dataChoicesConfirmedAt).toEqual(expect.any(String));
    expect(accepted.usageData).toMatchObject({
      productAnalytics: true,
      sessionReplay: true,
      errorReports: true,
      activeUseSignal: true,
      featureFlagIdentity: true,
      skillSafetyCheck: true,
    });
    expect(accepted.usageAnalyticsDeclinedAtOnboarding).toBe(false);
    expect(accepted.telemetrySharing).toEqual({
      metadata: 'off',
      plans: 'off',
      summaries: 'off',
      transcripts: 'off',
    });
    await app.waitForShell();
    for (const directory of [fixture.gitApp, fixture.notes]) {
      await expect(
        window.getByTestId(
          `first-run-import-row-${externalProjectCandidateIdFor(directory)}`,
        ),
      ).toBeVisible();
    }
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

    // CAN-7038: Skip finishes only once Personal's Chats exists, so Home can
    // send without a project, and its picker offers a chat without one.
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    expect(
      index.workspaces.some((entry) => entry.id === 'cowork-default'),
    ).toBe(true);
    await window
      .getByTestId('home-composer-editor')
      .locator('visible=true')
      .click();
    await window.keyboard.type('What can you help me with?');
    await expect(
      window.getByTestId('home-send-button').locator('visible=true'),
    ).toBeEnabled();
    await window
      .getByTestId('home-workspace-select')
      .locator('visible=true')
      .click();
    await expect(
      window.getByTestId('home-workspace-option-no-project'),
    ).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Escape');
    const model = window
      .getByTestId('chat-model-picker')
      .locator('visible=true');
    await expect(model).toBeEnabled();
    await model.click();
    await expect(window.getByTestId('chat-model-menu')).toBeVisible();
    await window.keyboard.press('Escape');
    const before = await window.evaluate(() =>
      window.api.workEntries.list({ projectId: 'cowork-default' }),
    );
    const prompt = 'What can you help me with?';
    await window
      .getByTestId('home-composer-editor')
      .locator('visible=true')
      .press('Enter');
    await expect
      .poll(async () => {
        const result = await window.evaluate(() =>
          window.api.workEntries.list({ projectId: 'cowork-default' }),
        );
        return result.entries.filter(
          (entry) =>
            !before.entries.some((existing) => existing.id === entry.id),
        ).length;
      })
      .toBe(1);
    await expect(
      window.getByText(prompt, { exact: true }).locator('visible=true').first(),
    ).toBeVisible();
    await expect(window.getByTestId('worktree-row')).toHaveCount(0);
    await expect(window.getByRole('dialog')).toHaveCount(0);
    const created = await window.evaluate(() =>
      window.api.workEntries.list({ projectId: 'cowork-default' }),
    );
    expect(created.entries).toHaveLength(before.entries.length + 1);
    const entry = created.entries.find(
      (item) => !before.entries.some((prior) => prior.id === item.id),
    );
    expect(entry).toBeDefined();
    const workspaceRoot = path.join(
      userDataDir,
      'workspaces',
      'cowork-default',
    );
    await expect
      .poll(() => {
        const manifest = path.join(
          workspaceRoot,
          'chat-storage-manifests',
          `${entry.id}.json`,
        );
        if (!existsSync(manifest)) return '';
        return readChatStorageTabs(workspaceRoot, entry.id)
          .tabs.map((tab) =>
            JSON.stringify(
              readChatStorageMessages(workspaceRoot, entry.id, tab.id),
            ),
          )
          .join('\n');
      })
      .toContain(prompt);
    expect(readChatStorageTabs(workspaceRoot, entry.id).tabs).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    fixture.cleanup();
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

// The Welcome gate's "What you share" card: Usage data pre-checked, activity
// sync off, both saved with the terms in one Agree & continue.
test('Welcome gate saves the What you share choices with the terms', async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    freshOnboarding: true,
  });
  try {
    const window = await electronApp.firstWindow();
    const gate = window.getByTestId('legal-consent-gate');
    await expect(gate).toBeVisible({ timeout: 30_000 });
    const card = window.getByTestId('legal-consent-data-choices');
    await expect(card).toBeVisible();
    await expect(window.getByTestId('legal-consent-opt-in')).toBeVisible();
    await expect(
      window.getByTestId('legal-consent-group-usage-toggle'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('legal-consent-group-activity-toggle'),
    ).toHaveAttribute('aria-checked', 'false');
    await expect(
      window.getByTestId('legal-consent-activity-features'),
    ).toBeVisible();

    // Customize opens the Settings rows in place, with Skill safety check
    // outside the group and one plain switch per activity type.
    await window.getByTestId('legal-consent-customize').click();
    await expect(card).toHaveAttribute('data-expanded', 'true');
    await expect(
      window.getByTestId('legal-consent-usage-data-row-skillSafetyCheck'),
    ).toBeVisible();
    await expect(
      window.getByTestId('legal-consent-activity-row-transcripts'),
    ).toBeVisible();

    // Decline Usage analytics only: the group reads "Some on".
    await window
      .getByTestId('legal-consent-usage-data-toggle-productAnalytics')
      .click();
    await expect(
      window.getByTestId('legal-consent-group-usage-toggle-mixed'),
    ).toBeVisible();
    // Turn activity sync on for every type.
    await window.getByTestId('legal-consent-group-activity-toggle').click();
    await expect(
      window.getByTestId('legal-consent-group-activity-toggle'),
    ).toHaveAttribute('aria-checked', 'true');

    await window.getByTestId('legal-consent-checkbox').check();
    await window.getByTestId('legal-consent-accept').click();
    await expect(gate).toBeHidden({ timeout: 30_000 });

    const saved = await window.evaluate(() => window.api.loadPreferences());
    expect(saved.legalConsentAcceptedAt).toEqual(expect.any(String));
    expect(saved.dataChoicesConfirmedAt).toBe(saved.legalConsentAcceptedAt);
    expect(saved.usageData).toMatchObject({
      productAnalytics: false,
      errorReports: true,
      skillSafetyCheck: true,
    });
    // Main derives the decline from the consent-accepting commit.
    expect(saved.usageAnalyticsDeclinedAtOnboarding).toBe(true);
    expect(saved.telemetrySharing).toEqual({
      metadata: 'organization',
      plans: 'organization',
      summaries: 'organization',
      transcripts: 'organization',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
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

// Billing setup gate: with no way to pay for a turn (providers signed out,
// zero AI Credits, no gateway), Home shows the billing choices in place of
// its composer; once a source is ready the composer comes back on its own.
test('Home shows the billing setup gate until a billing source is ready', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-billing-gate-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { navigationMode: 'code' } }),
  );
  const authKey = `billing-gate-unauthenticated-${randomUUID()}`;
  const emptyKey = `csk_billing_gate_empty_${randomUUID()}`;
  const fundedKey = `csk_billing_gate_funded_${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, emptyKey, {
    cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, fundedKey, {
    cloud: { aiCreditsBalance: { credits: 1234, eligible: true } },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: authKey,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    }),
  );
  const signIn = async (window, apiKey) => {
    const saved = await window.evaluate(
      async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    expect(saved.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
  };
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await signIn(window, emptyKey);
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible({
      timeout: 15_000,
    });
    const gate = window
      .getByTestId('page-home')
      .getByTestId('billing-setup-gate-home');
    const composer = window
      .getByTestId('home-composer-editor')
      .locator('visible=true');

    // Nothing can pay: the billing choices replace the composer.
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveCount(0);

    // Spendable AI Credits are a ready source: the composer returns.
    await signIn(window, fundedKey);
    await expect(gate).toHaveCount(0, { timeout: 30_000 });
    await expect(composer).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
    await clearScenario(DEFAULT_MOCK_BASE_URL, emptyKey);
    await clearScenario(DEFAULT_MOCK_BASE_URL, fundedKey);
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
