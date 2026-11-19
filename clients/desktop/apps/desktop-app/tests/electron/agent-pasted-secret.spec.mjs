import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// The composer paste guard (agent secret requests U6b), end to end against
// the bundled Claude SDK and the mock LLM. A Stripe-shaped canary pasted into
// a local chat's composer is held out of the editor and its draft; "Send as
// secret" keeps it as a chat secret and leaves `[secret:STRIPE_SECRET_KEY]`
// in the message. No form of the canary may reach a provider request body,
// the transcript, a draft or any file the app wrote.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const MARKER = 'Canopy-CPASTEDSECRET';
const DONE = 'The key is available by name';
const CANARY = `sk_live_canary${process.pid}Hq8RkLmZx2TfV`;
const CANARY_FORMS = (value) => [
  value,
  Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'),
  Buffer.from(value).toString('hex'),
  encodeURIComponent(value),
];

function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* filesUnder(full);
    else if (entry.isFile()) yield full;
  }
}

/** Pastes `text` into the composer as a clipboard paste would. */
async function paste(composer, text) {
  await composer.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

test.describe('composer paste guard', () => {
  test('a pasted secret sent as a secret reaches the model and disk only as its name', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-pasted-secret-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'ask',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });
    const observers = [
      ...CANARY_FORMS(CANARY).map((text, index) => ({
        key: `canary-${index}`,
        text,
      })),
      // Positive control: the message names the pasted secret.
      { key: 'pasted-mention', text: '[secret:STRIPE_SECRET_KEY]' },
    ];
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        requestTextObservers: observers,
        steps: [{ text: DONE, stopReason: 'end_turn' }],
      },
    });
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-shared-agent-secret-requests': true,
          }),
        },
      }),
    );
    let closed = false;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.pressSequentially(`[${MARKER}] Use this key: `);
      await paste(composer, CANARY);

      const notice = window.getByTestId('chat-pasted-secret-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        'This looks like a secret. If you send it as a message, the agent and its provider will see it.',
      );
      await expect(notice).not.toContainText(CANARY);
      await expect(composer).not.toContainText(CANARY);
      await window.getByTestId('chat-pasted-secret-send-as-secret').click();
      await window
        .getByTestId('chat-pasted-secret-name')
        .fill('STRIPE_SECRET_KEY');
      await window.getByTestId('chat-pasted-secret-save').click();
      await expect(notice).toBeHidden();
      await expect(composer).toContainText('[secret:STRIPE_SECRET_KEY]');
      await expect(composer).not.toContainText(CANARY);
      await expect(window.getByTestId('chat-secrets-chip')).toContainText(
        '1 secret',
      );
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(DONE).first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(panel).not.toContainText(CANARY);

      const activity = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${encodeURIComponent(MARKER)}`,
      ).then((response) => response.json());
      const counters = activity.activity ?? {};
      expect(counters['llmObserved:pasted-mention'] ?? 0).toBeGreaterThan(0);
      for (const observer of observers.filter((entry) =>
        entry.key.startsWith('canary-'),
      ))
        expect(counters[`llmObserved:${observer.key}`] ?? 0).toBe(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;
      const forms = CANARY_FORMS(CANARY);
      let scanned = 0;
      for (const file of filesUnder(userDataDir)) {
        if (statSync(file).size > 64 * 1024 * 1024) continue;
        const text = readFileSync(file).toString('latin1');
        scanned += 1;
        for (const form of forms)
          expect(text.includes(form), `${form} in ${file}`).toBe(false);
      }
      expect(scanned).toBeGreaterThan(0);
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
