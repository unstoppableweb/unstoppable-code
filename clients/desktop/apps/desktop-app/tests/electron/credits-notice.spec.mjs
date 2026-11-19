import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The shared AI Credits notice (`CreditsNotice`, Card A) in the desktop
// composer offers provider choice (CAN-6860): one Choose provider button
// that opens the provider list, where each provider connects from its row,
// credits are one row and the only place a purchase is offered.
//
//   1. A buyer buys from the credits row: the browser hand-off opens once,
//      the dialog closes, the notice waits on it with two buttons (Choose
//      provider and Check again) while the credits row offers Reopen
//      billing, and Check again finds the credits, which the composer
//      confirms.
//   2. A guest's credits row signs in first; nothing opens billing.
//   3. A member of an organization whose pool needs its admin gets the admin
//      line on the credits row and no purchase action.
//   4. On a usage limit, an AI gateway with a key is a provider row like the
//      others: Continue continues the chat on the gateway's model, and the
//      next turn reaches the gateway under that model's gateway id.
//   5. When the gateway offers the chat's own model under another id, its
//      row stays on that model and holds the only primary button, and
//      Continue sends the gateway's own route id.
//   6. A confirmed sign-out with spendable credits, routing mode `off` and no
//      explicit credits choice is not consent (CAN-7062): the composer shows
//      the signed-out No billing source notice and no "Using AI Credits"
//      card, a send is refused before any provider or gateway request, and
//      Continue with credits shows the card and the next turn bills credits.
//
// Deviation from the plan: it named the mock `usage-limit-reached` scenario
// and `seedUsageLimitedChats.mjs`, but those model a Claude/Codex provider
// quota and the resume modal, not AI Credits. AI Credits state comes from the
// cloud mock instead: `cloud.aiCreditsBalance` per key, the contact-admin key
// with its organization's spendable probe, and a per-device guest token.
// Providers are signed out through a per-test `authUsage` scenario, so the
// composer's No billing source notice is the one under test.
//
// Run:
//   pnpm run test:electron apps/desktop-app/tests/electron/credits-notice.spec.mjs

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// The mock's member account whose organization pool needs its admin.
const CONTACT_ADMIN_KEY = 'csk_model_recovery_contact_admin_e2e';
const CONTACT_ADMIN_ORG_ID = '77777777-7777-4777-8777-777777777777';

/** Local receiver standing in for the host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Malformed payloads leave a gap the assertions report.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Make the seeded workspace owned by an organization (CAN-3463). */
function markWorkspaceOrganizationOwned(userDataDir, organizationId) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  writeFileSync(
    filePath,
    JSON.stringify({
      ...config,
      owner: {
        type: 'organization',
        organizationId,
        projectId: '99999999-9999-4999-8999-999999999991',
        instanceId: '99999999-9999-4999-8999-999999999992',
        bindingGeneration: 0,
      },
    }),
  );
}

/**
 * Seed one chat, launch with signed-out providers and billing opening in the
 * (captured) browser, and open the chat's worktree.
 */
async function openChat({
  prefix,
  providerType,
  model,
  flags,
  prepare,
  blocks,
}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `canopy-${prefix}-`));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType,
    tabs: [
      {
        id: `${prefix}-chat`,
        title: 'Credits notice',
        model,
        ...(blocks ? { blocks } : {}),
      },
    ],
  });
  prepare?.(userDataDir);
  const authKey = `${prefix}-unauthenticated-${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const externalOpen = await startExternalOpenCapture();
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: authKey,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
        // Billing opens in the browser: in Settings the hand-off would end.
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-hosted-settings': false,
          ...flags,
        }),
      },
    }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  const close = async () => {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
    await externalOpen.close();
  };
  return { window, app, externalOpen, close };
}

/** Sign in with a cloud key and announce it, as the account flow does. */
async function signIn(window, apiKey) {
  const saved = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(saved.status.authenticated).toBe(true);
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
}

async function showWorktree(window, app) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Seed one chat on `model` that hit Claude's usage limit, launch signed out
 * of the cloud, save this device's gateway with a key that offers only
 * Gateway Sonnet 5.5, and open the chat's worktree.
 */
async function openGatewayChat({ prefix, model }) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `canopy-${prefix}-`));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: `${prefix}-chat`,
        title: 'Credits notice',
        model,
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: "You've hit your usage limit.",
          detectedAt: Date.now() - 60_000,
          dismissKey: `${prefix}-${randomUUID()}`,
          resetsAt: Date.now() + 2 * 60 * 60 * 1000,
        },
      },
    ],
  });
  const authKey = `csk_${prefix.replaceAll('-', '_')}_${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'authed-low-usage' },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: authKey,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-ai-gateway-settings-enabled': true,
          'canopy-desktop-hosted-settings': false,
        }),
      },
    }),
  );
  const close = async () => {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
  };
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Signed out of the cloud, the gateway is this device's: save one with
    // a key through the real preload, as its setup dialog does.
    const saved = await window.evaluate(async () => {
      const { organizationId } = await window.api.localModelGateway.read();
      const update = await window.api.localModelGateway.update({
        expectedOrganizationId: organizationId,
        expectedRevision: 'absent',
        baseUrl: 'https://openrouter.ai/api',
        enabled: true,
        models: [
          {
            id: 'gateway-sonnet-5-5',
            gatewayId: 'anthropic/claude-sonnet-5.5',
            label: 'Gateway Sonnet 5.5',
            harness: 'claude',
            contextWindow: 200_000,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
      });
      const connect = await window.api.localModelGateway.connect({
        expectedOrganizationId: organizationId,
        baseUrl: 'https://openrouter.ai/api',
        apiKey: 'sk-or-e2e-credits-notice',
      });
      return { update, connect };
    });
    expect(saved.update.ok).toBe(true);
    expect(saved.connect.value?.status).toBe('connected');
    const panel = await showWorktree(window, app);
    return { window, panel, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Count a marker's provider and gateway requests (`llmModel:` / `llmProxy:`). */
async function llmActivity(marker, prefix) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker);
  return Object.entries(activity ?? {})
    .filter(([key]) => key.startsWith(prefix))
    .reduce((sum, [, count]) => sum + count, 0);
}

/** Send one turn and expect it to reach the gateway under `gatewayId`. */
async function expectTurnOnGateway({ window, panel, gatewayId, reply }) {
  const marker = `Canopy-Ccredits-gateway-${randomUUID()}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const composer = panel.getByRole('textbox').first();
  await composer.click();
  await composer.fill(`[${marker}] Keep going.`);
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect
    .poll(
      async () =>
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity[
          `llmModel:${gatewayId}`
        ] ?? 0,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await expect(panel.getByText(reply).first()).toBeVisible({
    timeout: 30_000,
  });
  await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
}

test.describe('Credits notice', () => {
  test('a buyer buys, waits on the hand-off, checks again and sees the credits arrive', async () => {
    test.setTimeout(180_000);
    const cloudKey = `csk_credits_notice_buyer_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    });
    const fixture = await openChat({
      prefix: 'credits-notice-buyer',
      providerType: 'claude',
      model: 'opus[1m]',
    });
    try {
      const { window, app, externalOpen } = fixture;
      await signIn(window, cloudKey);
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      const choose = notice.getByTestId(
        'chat-input-no-billing-source-provider-choice',
      );
      const dialog = window.getByTestId('switch-provider-dialog');
      const buy = dialog.getByTestId('provider-choice-action-credits');
      const checkAgain = notice.getByTestId(
        'chat-input-no-billing-source-get-credits-check-again',
      );
      const reopen = notice.getByTestId(
        'chat-input-no-billing-source-reopen-billing',
      );
      const connect = notice.getByTestId(
        'chat-input-no-billing-source-sign-in',
      );

      // Nothing can pay: the attention notice offers provider choice and
      // sells nothing itself.
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toHaveAttribute('data-notice-intent', 'attention');
      // Nothing bills this chat, so there is nothing to switch from: one
      // Choose provider button, and connecting lives in the list's rows.
      await expect(choose).toHaveText('Choose provider');
      await expect(connect).toHaveCount(0);
      await expect(notice.getByRole('button')).toHaveCount(1);
      await expect(notice).not.toContainText('Buy credits');
      await expect(notice).not.toContainText('Finish checkout in your browser');

      // The provider list's credits row is the purchase.
      await choose.click();
      await expect(dialog).toBeVisible();
      await expect(buy).toHaveText('Buy credits');
      await expect(buy).toBeEnabled({ timeout: 15_000 });
      await expect(
        dialog.getByTestId('provider-choice-row-claude-badge'),
      ).toHaveCount(0);
      // Nothing is ready now, so no button is primary and the list stays
      // neutral.
      await expect(dialog.locator('[data-recommended="true"]')).toHaveCount(0);
      // The credits row runs the chat's model once credits are added (a
      // switch would have no Buy here: a worktree Claude chat is never
      // offered the default credits model).
      await expect(
        dialog.getByTestId('provider-choice-detail-credits'),
      ).toHaveText(/^Stays on \S.* after you add credits$/);

      // Buy hands off to the browser once, the dialog closes, and the notice
      // waits on it.
      await buy.click();
      await expect.poll(() => externalOpen.opened.length).toBe(1);
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      await expect(notice).toContainText('Finish checkout in your browser', {
        timeout: 15_000,
      });
      await expect(notice).toHaveAttribute('data-notice-intent', 'neutral');
      await expect(checkAgain).toBeVisible();
      await expect(
        notice.locator('[data-notice-actions="below"]'),
      ).toBeVisible();
      // Two buttons mid-checkout: Choose provider and Check again. Reopen
      // billing moves to the list's credits row.
      await expect(notice.getByRole('button')).toHaveCount(2);
      await expect(reopen).toHaveCount(0);
      await choose.click();
      await expect(dialog).toBeVisible();
      await expect(buy).toHaveText('Reopen billing');
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // The credits land; Check again finds them.
      await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
        cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
      });
      await checkAgain.click();

      // Arrived: the composer confirms the credits this chat now uses, and the
      // attention notice is gone.
      const card = panel.getByTestId('chat-input-ai-credits-active');
      await expect(
        card.getByTestId('chat-input-ai-credits-arrival'),
      ).toHaveText('16 AI Credits added.', { timeout: 15_000 });
      await expect(notice).toHaveCount(0);
      expect(externalOpen.opened.length).toBe(1);
    } finally {
      await fixture.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey);
    }
  });

  test('a guest signs in before buying, and nothing opens billing', async () => {
    test.setTimeout(150_000);
    // This guest's own token, so no shared guest scenario changes.
    const deviceId = randomUUID();
    const guestToken = `csk_credits_notice_guest_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, `guest-device:${deviceId}`, {
      guestToken,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, guestToken, {
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    });
    const fixture = await openChat({
      prefix: 'credits-notice-guest',
      providerType: 'claude',
      model: 'opus[1m]',
      flags: { 'canopy-guest-mode-enabled': true },
      prepare: (userDataDir) => {
        writeFileSync(
          path.join(userDataDir, 'portal-state.json'),
          JSON.stringify({ version: 1, clientDeviceId: deviceId }),
        );
      },
    });
    try {
      const { window, app, externalOpen } = fixture;
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
              ?.credentialSource,
          { timeout: 30_000 },
        )
        .toBe('guest');
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await notice
        .getByTestId('chat-input-no-billing-source-provider-choice')
        .click();
      const buy = window
        .getByTestId('switch-provider-dialog')
        .getByTestId('provider-choice-action-credits');
      await expect(buy).toBeEnabled({ timeout: 15_000 });
      // A guest's purchase action names the sign-in, never the bare purchase.
      await expect(buy).toHaveText('Sign in to buy credits');

      // The guest's purchase action is the sign-in: it opens the account
      // sign-in, never a billing page.
      await buy.click();
      await expect(window.getByTestId('cloud-sync-modal')).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        notice.getByTestId(
          'chat-input-no-billing-source-get-credits-check-again',
        ),
      ).toHaveCount(0);
      expect(externalOpen.opened).toEqual([]);
    } finally {
      await fixture.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, guestToken);
      await clearScenario(DEFAULT_MOCK_BASE_URL, `guest-device:${deviceId}`);
    }
  });

  test("an organization member who can't fund the pool gets no purchase action", async () => {
    test.setTimeout(150_000);
    const fixture = await openChat({
      prefix: 'credits-notice-org-member',
      providerType: 'claude',
      model: 'opus[1m]',
      prepare: (userDataDir) =>
        markWorkspaceOrganizationOwned(userDataDir, CONTACT_ADMIN_ORG_ID),
    });
    try {
      const { window, app, externalOpen } = fixture;
      await signIn(window, CONTACT_ADMIN_KEY);
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).not.toContainText('Buy credits');
      await notice
        .getByTestId('chat-input-no-billing-source-provider-choice')
        .click();
      const dialog = window.getByTestId('switch-provider-dialog');
      // The admin line moved to the credits row, which offers no purchase.
      await expect(
        dialog.getByTestId('provider-choice-detail-credits'),
      ).toHaveText('Contact your org admin to increase your spend quota.', {
        timeout: 15_000,
      });
      await expect(
        dialog.getByTestId('provider-choice-action-credits'),
      ).toHaveCount(0);
      await expect(dialog).not.toContainText('Buy credits');
      expect(externalOpen.opened).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
  test('an AI gateway with a key is a Continue row that continues the chat on its model', async () => {
    test.setTimeout(180_000);
    const fixture = await openGatewayChat({
      prefix: 'credits-notice-gateway',
      model: 'opus[1m]',
    });
    try {
      const { window, panel } = fixture;
      const notice = panel.getByTestId('chat-input-usage-limit-banner');
      const choose = notice.getByTestId(
        'chat-input-usage-limit-provider-choice',
      );
      // Codex and the gateway are both usable now, so the notice opens the
      // list rather than naming one.
      await expect(choose).toHaveText('Switch provider', { timeout: 30_000 });
      await choose.click();
      const dialog = window.getByTestId('switch-provider-dialog');
      const use = dialog.getByTestId('provider-choice-action-gateway');
      await expect(use).toHaveText('Continue', { timeout: 15_000 });
      // The chat is on Opus and the gateway offers only Sonnet, so there is
      // no equivalent route: the row switches model.
      await expect(
        dialog.getByTestId('provider-choice-detail-gateway'),
      ).toHaveText('Switches to Gateway Sonnet 5.5');
      // Rows group by what they can do: the gateway is ready now, and
      // credits, which need buying, are not.
      const ready = dialog.getByTestId('provider-choice-group-ready');
      await expect(
        ready.getByTestId('provider-choice-row-gateway'),
      ).toBeVisible();
      await expect(
        ready.getByTestId('provider-choice-row-credits'),
      ).toHaveCount(0);
      // One primary button: Codex's, since both ready rows switch model and
      // the tie-break order puts Codex first.
      const recommended = dialog.locator('[data-recommended="true"]');
      await expect(recommended).toHaveCount(1);
      await expect(recommended).toHaveAttribute(
        'data-testid',
        'provider-choice-action-codex',
      );

      await use.click();
      await expect(dialog).toHaveCount(0);
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        'Gateway Sonnet 5.5',
        { timeout: 30_000 },
      );
      // The gateway pays: the turn reached it under the model's gateway id.
      await expectTurnOnGateway({
        window,
        panel,
        gatewayId: 'anthropic/claude-sonnet-5.5',
        reply: 'Continued on the gateway.',
      });
    } finally {
      await fixture.close();
    }
  });

  test("a gateway route for the chat's own model stays on it and holds the only primary", async () => {
    test.setTimeout(180_000);
    // Claude's Sonnet runs on the gateway as `anthropic/claude-sonnet-5.5`,
    // which the gateway lists under its own id `gateway-sonnet-5-5`.
    const fixture = await openGatewayChat({
      prefix: 'credits-notice-gateway-same-model',
      model: 'sonnet',
    });
    try {
      const { window, panel } = fixture;
      const notice = panel.getByTestId('chat-input-usage-limit-banner');
      await notice
        .getByTestId('chat-input-usage-limit-provider-choice')
        .click({ timeout: 30_000 });
      const dialog = window.getByTestId('switch-provider-dialog');
      const use = dialog.getByTestId('provider-choice-action-gateway');
      await expect(use).toHaveText('Continue', { timeout: 15_000 });
      // The row keeps the chat's label even though this route's context
      // window (200K) is smaller than native Sonnet's. A same-model route
      // reads as "Stays on", with no context-window copy (CAN-6965).
      await expect(
        dialog.getByTestId('provider-choice-detail-gateway'),
      ).toHaveText('Stays on Sonnet 5.5');
      // A row that keeps the chat's model beats ones that switch it, so the
      // gateway, not Codex, holds the only primary button.
      const recommended = dialog.locator('[data-recommended="true"]');
      await expect(recommended).toHaveCount(1);
      await expect(recommended).toHaveAttribute(
        'data-testid',
        'provider-choice-action-gateway',
      );

      await use.click();
      await expect(dialog).toHaveCount(0);
      // Continue sent the gateway's own route id, not the chat's `sonnet`.
      await expect(panel.getByTestId('chat-model-picker')).toContainText(
        'Gateway Sonnet 5.5',
        { timeout: 30_000 },
      );
      await expectTurnOnGateway({
        window,
        panel,
        gatewayId: 'anthropic/claude-sonnet-5.5',
        reply: 'Stayed on Sonnet through the gateway.',
      });
    } finally {
      await fixture.close();
    }
  });

  test('a signed-out chat with credits nobody chose shows No billing source and refuses the send', async () => {
    test.setTimeout(180_000);
    const cloudKey = `csk_credits_notice_signed_out_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
      cloud: { aiCreditsBalance: { credits: 1234, eligible: true } },
    });
    const fixture = await openChat({
      prefix: 'credits-notice-signed-out',
      providerType: 'claude',
      model: 'opus[1m]',
      // A used chat, so it is never re-stamped as an empty default tab.
      blocks: [{ type: 'text', text: 'Earlier reply on the subscription.' }],
    });
    const refusedMarker = `Canopy-Ccredits-signed-out-${randomUUID()}`;
    const creditsMarker = `Canopy-Ccredits-signed-out-ok-${randomUUID()}`;
    const reply = 'Running on AI Credits now.';
    try {
      const { window, app } = fixture;
      // `off` is the default; set it so a fixture default change cannot make
      // this pass for the wrong reason. The sign-in below refreshes the
      // composer's cached read.
      await window.evaluate(async () =>
        window.api.savePreferences({ aiCreditsRoutingMode: 'off' }),
      );
      await signIn(window, cloudKey);
      const panel = await showWorktree(window, app);
      const notice = panel.getByTestId('chat-input-no-billing-source-banner');
      const card = panel.getByTestId('chat-input-ai-credits-active');

      // Before send: the signed-out notice, and no card claiming credits.
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText('Signed out of Claude');
      await expect(card).toHaveCount(0);

      // The send is refused before any provider or gateway request, and the
      // prompt comes back to the composer.
      await registerScenario(DEFAULT_MOCK_BASE_URL, refusedMarker, {
        llm: { steps: [{ text: 'Should never run.', stopReason: 'end_turn' }] },
      });
      const composer = panel.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${refusedMarker}] Keep going.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText("You're signed out of Claude.").first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(composer).toContainText(refusedMarker, {
        timeout: 15_000,
      });
      expect(await llmActivity(refusedMarker, 'llmModel:')).toBe(0);
      expect(await llmActivity(refusedMarker, 'llmProxy:')).toBe(0);
      await expect(card).toHaveCount(0);
      await expect(notice).toBeVisible();

      // Credits are the one ready source: Continue with credits is the
      // user's choice, and the card replaces the notice.
      const choose = notice.getByTestId(
        'chat-input-no-billing-source-provider-choice',
      );
      await choose.click();
      const continueWithCredits = window.getByTestId(
        'chat-input-no-billing-source-provider-choice-continue',
      );
      await expect(continueWithCredits).toHaveText('Continue with credits');
      await continueWithCredits.click();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(notice).toHaveCount(0);

      // The next turn bills AI Credits through the gateway.
      await registerScenario(DEFAULT_MOCK_BASE_URL, creditsMarker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });
      await composer.click();
      await composer.fill(`[${creditsMarker}] Keep going.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(() => llmActivity(creditsMarker, 'llmProxy:'), {
          timeout: 60_000,
        })
        .toBeGreaterThan(0);
      await expect(panel.getByText(reply).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await fixture.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, refusedMarker);
      await clearScenario(DEFAULT_MOCK_BASE_URL, creditsMarker);
    }
  });
});
