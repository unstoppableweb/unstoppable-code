import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import {
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  seedOrgContextScoping,
} from './seeders/seedOrgContextScoping.mjs';

const prefix = 'invite-to-organization';
async function openCreateTeam(page) {
  await page.getByTestId('sidebar-context-row').click();
  await page.getByTestId('account-create-team-row').click();
}

async function withPersonalAccount(run, cloud = {}) {
  const key = `csk_team_creation_${randomUUID()}`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-create-team-'),
  );
  seedOrgContextScoping(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      personalOrganizationUpgrade: true,
      personalOrganizationId: ORG_CONTEXT_A,
      organizations: [],
      teams: [],
      ...cloud,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const page = await electronApp.firstWindow();
    await new CanopyAppDriver(page).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(page, key, {
      expectedAccount: { personalOrganizationId: ORG_CONTEXT_A },
    });
    await run(page, electronApp);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    }
  }
}

async function createTeam(page, name) {
  const dialog = page.getByTestId(`${prefix}-modal`);
  const submit = dialog.getByTestId(`${prefix}-submit`);
  await dialog.getByTestId(`${prefix}-team-name`).fill(name);
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  for (const checkbox of await dialog.getByRole('checkbox').all()) {
    await checkbox.uncheck();
  }
  await submit.click();
  await expect(dialog.getByTestId(`${prefix}-team-created`)).toContainText(
    name,
  );
}

test.describe.configure({ timeout: 60_000 });

for (const policyPending of [false, true]) {
  const title = policyPending
    ? 'a Personal owner can create another team while policy refresh is pending'
    : 'a Personal owner can create a second team from the completed setup';
  test(title, async () => {
    await withPersonalAccount(
      async (page) => {
        await openCreateTeam(page);
        await createTeam(page, 'First team');
        const context = page.getByTestId('sidebar-context-row');
        await expect(context).toContainText('First team');

        await page.getByTestId(`${prefix}-create-another`).click();
        await expect(page.getByTestId(`${prefix}-team-name`)).toHaveValue('');
        await createTeam(page, 'Second team');
        await expect(context).toContainText('Second team');
      },
      { personalUpgradePolicyPending: policyPending },
    );
  });
}

test('a retired team checklist offers only restart and dismissal', async () => {
  await withPersonalAccount(async (page, electronApp) => {
    await openCreateTeam(page);
    await createTeam(page, 'First team');
    const account = await page.evaluate(() =>
      window.api.refreshCanopyCloudEnforcedSettings(),
    );
    expect(account.accountProbeApplied).toBe(true);
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'settings:refresh-canopy-cloud-enforced-settings';
      ipcMain.removeHandler(channel);
      ipcMain.handle(
        channel,
        () =>
          new Promise((resolve) => {
            globalThis.finishTeamRestartRead = resolve;
          }),
      );
    });

    const dialog = page.getByTestId(`${prefix}-modal`);
    const restart = dialog.getByTestId(`${prefix}-create-another`);
    const invite = dialog.getByTestId(`${prefix}-invite-more-email`);
    const manage = dialog.getByTestId(`${prefix}-manage`);
    const done = dialog.getByTestId(`${prefix}-done`);
    const waitForRestartRead = async () => {
      await expect
        .poll(() =>
          electronApp.evaluate(() => typeof globalThis.finishTeamRestartRead),
        )
        .toBe('function');
    };
    await expect(invite).toBeVisible();
    await expect(manage).toBeEnabled();
    await restart.click();
    await waitForRestartRead();
    await expect(invite).toHaveCount(0);
    await expect(manage).toHaveCount(0);
    await expect(done).toBeEnabled();

    await electronApp.evaluate((_electron, account) => {
      const resolve = globalThis.finishTeamRestartRead;
      delete globalThis.finishTeamRestartRead;
      resolve({ ...account, accountProbeApplied: false });
    }, account);
    await expect(restart).toBeEnabled();
    await expect(invite).toHaveCount(0);
    await expect(manage).toHaveCount(0);
    await restart.click();
    await waitForRestartRead();
    await done.click({ timeout: 3_000 });
    await expect(dialog).toBeHidden();
    await electronApp.evaluate(
      (_electron, account) => globalThis.finishTeamRestartRead(account),
      account,
    );
    await expect(page.getByTestId('sidebar-context-row')).toContainText(
      'First team',
    );
    await expect(dialog).toBeHidden();
  });
});

test('canceling a blank second setup retires the completed checklist', async () => {
  await withPersonalAccount(async (page) => {
    await openCreateTeam(page);
    await createTeam(page, 'First team');
    const dialog = page.getByTestId(`${prefix}-modal`);
    const context = page.getByTestId('sidebar-context-row');
    await dialog.getByTestId(`${prefix}-create-another`).click();
    await expect(dialog.getByTestId(`${prefix}-team-name`)).toHaveValue('');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(context).toContainText('First team');

    await context.click();
    await page.getByTestId('sidebar-context-option-personal').click();
    await expect(context).toContainText('Personal');
    await openCreateTeam(page);
    await expect(dialog.getByTestId(`${prefix}-team-name`)).toHaveValue('');
    await expect(dialog.getByTestId(`${prefix}-team-created`)).toHaveCount(0);
  });
});
