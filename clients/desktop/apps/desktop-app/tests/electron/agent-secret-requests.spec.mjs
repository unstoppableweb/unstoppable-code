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
// Agent secret requests (RequestSecrets) end to end: the bundled Claude SDK
// calls RequestSecrets against the mock LLM, the person answers the composer
// form with canary values (one of 5 characters), and the turn finishes.
//
// Values must reach only the chat's secret store. The spec proves that no
// form of a canary (raw, base64, hex) appears in any provider request body
// (the mock's request text observers), nor anywhere in the app data
// directory once the app has closed: the canonical transcript, output
// artifacts, observability sidecars, pending-question records and logs. The
// store's own file holds only safe storage ciphertext, or does not exist
// when secure storage is unavailable.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const MARKER = 'Canopy-CSECRETREQ';
const FOLLOW_UP = 'Both secrets are available by name now';
const CANARY = `canary-${process.pid}-7f3e1b29-long-value`;
const SHORT_CANARY = 'cnr5x';
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

test.describe('agent secret requests', () => {
  test('a person provides secrets to a live Claude turn without any value reaching the model, the transcript or disk', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-secret-requests-'),
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
        key: `canary-long-${index}`,
        text,
      })),
      ...CANARY_FORMS(SHORT_CANARY).map((text, index) => ({
        key: `canary-short-${index}`,
        text,
      })),
      // Positive controls: the tool is advertised, and its names-only result
      // reaches the model.
      { key: 'tool-advertised', scope: 'tools', text: 'RequestSecrets' },
      { key: 'result-provided', text: 'STRIPE_SECRET_KEY' },
      { key: 'result-usage', text: 'Values are hidden from you' },
    ];
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        requestTextObservers: observers,
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy_ui__RequestSecrets',
                input: {
                  reason: 'Run the checkout integration tests.',
                  secrets: [
                    { name: 'STRIPE_SECRET_KEY', label: 'Stripe secret key' },
                    { name: 'SHORT_PIN', label: 'PIN' },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: FOLLOW_UP, stopReason: 'end_turn' },
        ],
      },
    });

    // E2E builds seed the LaunchDarkly-unavailable defaults, where the flag
    // is off; opt in as a configured flag would.
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
      await composer.fill(`[${MARKER}] Run the checkout tests.`);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The form replaces the composer while the agent waits.
      const form = window.getByTestId('chat-secret-request-prompt');
      await expect(form).toBeVisible({ timeout: 90_000 });
      await expect(form).toContainText('Claude needs 2 secrets');
      await expect(form).toContainText('Run the checkout integration tests.');
      const longField = window.getByTestId(
        'chat-secret-request-input-STRIPE_SECRET_KEY',
      );
      await expect(longField).toHaveAttribute('type', 'password');
      await longField.fill(CANARY);
      await window
        .getByTestId('chat-secret-request-input-SHORT_PIN')
        .fill(SHORT_CANARY);
      await expect(form).toContainText('Short values may not be redacted');
      await window.getByTestId('chat-secret-request-provide').click();

      // The turn resumes with names only, and the row says what happened.
      await expect(panel.getByText(FOLLOW_UP).first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(form).toBeHidden();
      await expect(
        panel.getByTestId('request-secrets-status').first(),
      ).toHaveText('Provided 2 of 2');
      await expect(panel).not.toContainText(CANARY);
      await expect(panel).not.toContainText(SHORT_CANARY);

      const activity = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${encodeURIComponent(MARKER)}`,
      ).then((response) => response.json());
      const counters = activity.activity ?? {};
      expect(counters['llmObserved:tool-advertised']).toBeGreaterThan(0);
      expect(counters['llmObserved:result-provided']).toBeGreaterThan(0);
      expect(counters['llmObserved:result-usage']).toBeGreaterThan(0);
      for (const observer of observers.filter((entry) =>
        entry.key.startsWith('canary-'),
      ))
        expect(counters[`llmObserved:${observer.key}`] ?? 0).toBe(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;

      // Every file the app wrote: transcripts, artifacts, sidecars, pending
      // records, the store and logs.
      const forms = [...CANARY_FORMS(CANARY), ...CANARY_FORMS(SHORT_CANARY)];
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
