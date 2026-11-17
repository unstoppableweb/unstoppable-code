import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startCloudChatsWebCore } from './fixtures/cloudChatsWebCore.mjs';
import { SEEDED_CLOUD_CHATS } from './fixtures/cloudChatsWorld.js';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// ---------------------------------------------------------------------------
// Agent secret requests in a cloud chat, with the desktop as the cloud
// client (agent-secret-requests U5): a seeded cloud task whose agent waits
// on RequestSecrets, served by the fake web core over the real POST + SSE
// binding. The composer shows the shared secret form with the cloud footer;
// a refused value (a JSON-RPC refusal with its kind's code) asks for the
// values again; the person provides two canary values (one of 5
// characters), which go only in core.chat.secretRequest.submit with a fresh
// submission id, never in another web core request nor anywhere in the app
// data directory. While the flag is on, the window's web core requests
// announce secret_requests, so a send lets Agentic Core offer the tools.
// ---------------------------------------------------------------------------

const CANARY = `canary-${process.pid}-a41c9e-cloud-value`;
const SHORT_CANARY = 'cn7q2';
const CANARY_FORMS = (value) => [
  value,
  Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'),
  Buffer.from(value).toString('hex'),
  encodeURIComponent(value),
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SENT = 'Deploy it now.';

function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* filesUnder(full);
    else if (entry.isFile()) yield full;
  }
}

test('a cloud chat asks for secrets on desktop and no value leaves the submit', async () => {
  test.setTimeout(180_000);
  const cloud = await startCloudChatsWebCore();
  cloud.world.askForSecrets([
    { name: 'DEPLOY_TOKEN', label: 'Deploy token' },
    { name: 'SHORT_PIN', label: 'PIN' },
  ]);
  cloud.world.state.refuseNextSecretSubmit = true;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-secret-requests-cloud-'),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cloud-chats': true,
        'canopy-shared-agent-secret-requests': true,
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
    await task.first().click();

    const form = window.getByTestId('chat-secret-request-prompt');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form).toContainText('Deploy the demo to staging.');
    await expect(window.getByTestId('chat-secret-request-footer')).toHaveText(
      "Sent to this chat's cloud workspace and stored encrypted.",
    );

    const fill = async () => {
      await window
        .getByTestId('chat-secret-request-input-DEPLOY_TOKEN')
        .fill(CANARY);
      await window
        .getByTestId('chat-secret-request-input-SHORT_PIN')
        .fill(SHORT_CANARY);
      await window.getByTestId('chat-secret-request-provide').click();
    };

    // Refused once (invalid_argument, -32602): the values are cleared and
    // asked for again, with the refused field named.
    await fill();
    await expect(
      window.getByTestId('chat-secret-request-notice'),
    ).toContainText('DEPLOY_TOKEN is too long.');
    await expect(
      window.getByTestId('chat-secret-request-input-DEPLOY_TOKEN'),
    ).toHaveValue('');
    await fill();
    await expect(form).toBeHidden({ timeout: 30_000 });

    const submits = cloud.world.state.secretSubmits;
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({
      action: 'provide',
      interactionId: SEEDED_CLOUD_CHATS.questionId,
      values: { DEPLOY_TOKEN: CANARY, SHORT_PIN: SHORT_CANARY },
    });
    expect(submits[0].submissionId).toMatch(UUID);
    expect(cloud.world.state.answers).toEqual([]);

    // A send from the window announces that it can answer secret requests.
    const composer = window
      .getByTestId('chat-panel')
      .getByRole('textbox')
      .first();
    await composer.click();
    await composer.fill(SENT);
    await window
      .getByTestId('chat-panel')
      .getByRole('button', { name: 'Send message' })
      .click();
    await expect.poll(() => cloud.world.state.sends.length).toBe(1);
    const send = cloud.calls.find(
      (call) => call.method === 'core.chat.message.send',
    );
    expect(send?.capabilities).toBe('secret_requests');

    // No form of a value in any request but the submit that carried it.
    const forms = [...CANARY_FORMS(CANARY), ...CANARY_FORMS(SHORT_CANARY)];
    const submitCalls = cloud.calls.filter(
      (call) => call.method === 'core.chat.secretRequest.submit',
    );
    expect(submitCalls).toHaveLength(2);
    for (const call of cloud.calls) {
      if (call.method === 'core.chat.secretRequest.submit') continue;
      for (const form of forms) expect(call.body ?? '').not.toContain(form);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    await cloud.close();
  }
  try {
    // Nor anywhere the app kept on disk: logs, journals, transcripts, caches.
    const forms = [...CANARY_FORMS(CANARY), ...CANARY_FORMS(SHORT_CANARY)];
    for (const file of filesUnder(userDataDir)) {
      const content = readFileSync(file).toString('latin1');
      for (const form of forms)
        expect(content.includes(form), `${file} holds a value`).toBe(false);
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
