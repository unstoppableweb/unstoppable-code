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

      // The Secrets chip lists both by name only; Revoke takes one away.
      const chip = window.getByTestId('chat-secrets-chip');
      await expect(chip).toContainText('2 secrets');
      await chip.click();
      const popover = window.getByTestId('chat-secrets-popover');
      await expect(popover).toContainText('STRIPE_SECRET_KEY');
      await expect(popover).toContainText('SHORT_PIN');
      await expect(popover).not.toContainText(CANARY);
      await popover.getByTestId('chat-secrets-revoke-SHORT_PIN').click();
      await expect(popover).not.toContainText('SHORT_PIN');
      await window.keyboard.press('Escape');
      await expect(chip).toContainText('1 secret');

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

  // Stop cancels a request the form left waiting (PLAN section 12): closing
  // the form keeps the request, but Stop (the composer's Stop button, over
  // chat:cancel) settles it, so nothing stays answerable and a value typed
  // before the Stop is never stored.
  test('Stop cancels a waiting request so no late answer can store a value', async () => {
    test.setTimeout(240_000);
    const marker = 'Canopy-CSECRETSTOP';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-secret-stop-'),
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
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy_ui__RequestSecrets',
                input: {
                  reason: 'Run the checkout integration tests.',
                  secrets: [
                    { name: 'STRIPE_SECRET_KEY', label: 'Stripe secret key' },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: 'unused', stopReason: 'end_turn' },
        ],
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
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${marker}] Run the checkout tests.`);
      await window.getByRole('button', { name: 'Send message' }).click();

      const form = window.getByTestId('chat-secret-request-prompt');
      await expect(form).toBeVisible({ timeout: 90_000 });
      await window
        .getByTestId('chat-secret-request-input-STRIPE_SECRET_KEY')
        .fill(CANARY);
      // Close keeps the request waiting and brings back the composer's Stop.
      await window.getByTestId('chat-secret-request-close').click();
      await expect(form).toBeHidden();
      const pending = window.getByRole('button', { name: /^Question/ });
      await expect(pending).toHaveCount(1);
      await window
        .locator(
          'button[aria-label^="Stop"]:not([aria-label="Stop recording"])',
        )
        .first()
        .click();

      // Nothing is left to answer, so nothing can be stored.
      await expect(pending).toHaveCount(0, { timeout: 30_000 });
      await expect(form).toBeHidden();
      await expect(window.getByTestId('chat-secrets-chip')).toHaveCount(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;
      for (const file of filesUnder(userDataDir)) {
        if (statSync(file).size > 64 * 1024 * 1024) continue;
        const text = readFileSync(file).toString('latin1');
        for (const form of CANARY_FORMS(CANARY))
          expect(text.includes(form), `${form} in ${file}`).toBe(false);
      }
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Full access (U3): the secret reaches the agent's own Bash command
  // directly, revoking it from the Secrets chip takes it away from the next
  // command, and nothing on disk keeps it once revoked.
  test("in Full access a Claude chat's own commands read a provided secret until it is revoked", async () => {
    test.setTimeout(300_000);
    const marker = 'Canopy-CSECRETAMBIENT';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-secret-ambient-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Chat' }],
    });
    // The command's own text never contains what it prints, so an observed
    // `AMBIENT_SET_<length>` can only come from the command's environment.
    const probe =
      'echo "AMBIENT_$( [ -n "$STRIPE_SECRET_KEY" ] && echo SET || echo NONE )_${#STRIPE_SECRET_KEY}"';
    const observers = [
      ...CANARY_FORMS(CANARY).map((text, index) => ({
        key: `canary-long-${index}`,
        text,
      })),
      { key: 'ambient-set', text: `AMBIENT_SET_${CANARY.length}` },
      { key: 'ambient-none', text: 'AMBIENT_NONE_0' },
    ];
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
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
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [{ name: 'Bash', input: { command: probe } }],
            stopReason: 'tool_use',
          },
          { text: 'The key is in my commands', stopReason: 'end_turn' },
          {
            toolCalls: [{ name: 'Bash', input: { command: probe } }],
            stopReason: 'tool_use',
          },
          { text: 'The key is gone', stopReason: 'end_turn' },
        ],
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
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${marker}] Run the checkout tests.`);
      await window.getByRole('button', { name: 'Send message' }).click();

      const form = window.getByTestId('chat-secret-request-prompt');
      await expect(form).toBeVisible({ timeout: 90_000 });
      await expect(form).toContainText('Available to the agent');
      await window
        .getByTestId('chat-secret-request-input-STRIPE_SECRET_KEY')
        .fill(CANARY);
      await window.getByTestId('chat-secret-request-provide').click();
      await expect(
        panel.getByText('The key is in my commands').first(),
      ).toBeVisible({
        timeout: 120_000,
      });

      const chip = window.getByTestId('chat-secrets-chip');
      await expect(chip).toContainText('1 secret');
      await chip.click();
      const popover = window.getByTestId('chat-secrets-popover');
      await expect(popover).toContainText('STRIPE_SECRET_KEY');
      await expect(window.getByTestId('chat-secrets-ambient')).toContainText(
        "also set in the agent's own commands",
      );
      await popover
        .getByTestId('chat-secrets-revoke-STRIPE_SECRET_KEY')
        .click();
      // The open list stays until closed; then the chip goes with the last
      // secret.
      await expect(popover).toContainText('No secrets.');
      await window.keyboard.press('Escape');
      await expect(chip).toBeHidden();

      await composer.click();
      await composer.fill('Check the key again.');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText('The key is gone').first()).toBeVisible({
        timeout: 120_000,
      });

      const activity = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${encodeURIComponent(marker)}`,
      ).then((response) => response.json());
      const counters = activity.activity ?? {};
      expect(counters['llmObserved:ambient-set']).toBeGreaterThan(0);
      expect(counters['llmObserved:ambient-none']).toBeGreaterThan(0);
      // Full access lets the agent print a value it reads; this probe prints
      // only its length, so no form of the canary may reach the provider.
      for (const observer of observers.filter((entry) =>
        entry.key.startsWith('canary-'),
      ))
        expect(counters[`llmObserved:${observer.key}`] ?? 0).toBe(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;
      // Revoked, so no env file kept it; the launch directory went with the
      // session.
      for (const file of filesUnder(userDataDir)) {
        if (statSync(file).size > 64 * 1024 * 1024) continue;
        const text = readFileSync(file).toString('latin1');
        for (const form of CANARY_FORMS(CANARY))
          expect(text.includes(form), `${form} in ${file}`).toBe(false);
      }
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // Codex fixes its commands' environment when its process starts: a secret
  // provided mid-thread offers Restart to apply, which keeps the thread.
  test('a Codex chat in Full access offers Restart to apply for a secret provided mid-thread', async () => {
    test.setTimeout(300_000);
    const marker = 'Canopy-CSECRETRESTART';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-secret-restart-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: 't1',
          title: 'Chat',
          providerType: 'codex',
          model: 'gpt-5.5',
          messages: [],
        },
      ],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'canopy_request_secrets',
                input: {
                  reason: 'Run the checkout integration tests.',
                  secrets: [
                    { name: 'STRIPE_SECRET_KEY', label: 'Stripe secret key' },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          { text: 'Got the key name', stopReason: 'end_turn' },
          { text: 'Running with the new environment', stopReason: 'end_turn' },
        ],
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
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const panel = window.getByTestId('panel-content-chat');
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.fill(`[${marker}] Run the checkout tests.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByTestId('chat-secret-request-prompt'),
      ).toBeVisible({
        timeout: 120_000,
      });
      await window
        .getByTestId('chat-secret-request-input-STRIPE_SECRET_KEY')
        .fill(CANARY);
      await window.getByTestId('chat-secret-request-provide').click();
      await expect(panel.getByText('Got the key name').first()).toBeVisible({
        timeout: 120_000,
      });

      const notice = window.getByTestId('chat-secrets-restart-notice');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText('Restart to apply');
      await expect(window.getByTestId('chat-secrets')).toHaveAttribute(
        'data-ambient',
        'restart',
      );
      await window.getByTestId('chat-secrets-restart-notice-button').click();
      await expect(notice).toBeHidden({ timeout: 30_000 });

      // The next message respawns Codex in the same thread, with the key in
      // its environment.
      await composer.click();
      await composer.fill('Carry on.');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText('Running with the new environment').first(),
      ).toBeVisible({ timeout: 120_000 });
      await expect(panel.getByText('Got the key name').first()).toBeVisible();
      await expect(window.getByTestId('chat-secrets')).toHaveAttribute(
        'data-ambient',
        'live',
      );
      await expect(notice).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RunWithSecrets and WriteSecretsFile (U2b-1, U2b-2). After the person
// provides the canaries, the agent runs a command that echoes them raw and in
// base64, then writes one to a .env file. In Ask mode each use shows the
// secrets approval card first; in Full access there is none. Either way the
// model gets only `[secret:NAME]`, and no form of a canary reaches a provider
// request body or any file the app wrote, except the approved .env file.
// ---------------------------------------------------------------------------

const RUN_COMMAND =
  'printf "%s\\n" "$STRIPE"; printf %s "$STRIPE" | base64; printf "pin:%s\\n" "$PIN"';
const USE_DONE = 'The secrets were used by name';

function requestStep() {
  return {
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
  };
}

function writeStep() {
  return {
    toolCalls: [
      {
        name: 'mcp__canopy__WriteSecretsFile',
        input: {
          path: '.env.local',
          format: 'dotenv',
          entries: { STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY' },
        },
      },
    ],
    stopReason: 'tool_use',
  };
}

function runStep() {
  return {
    toolCalls: [
      {
        name: 'mcp__canopy__RunWithSecrets',
        input: {
          command: RUN_COMMAND,
          env: { STRIPE: 'STRIPE_SECRET_KEY', PIN: 'SHORT_PIN' },
        },
      },
    ],
    stopReason: 'tool_use',
  };
}

async function startSecretChat({ marker, mode, steps, observers }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-secret-use-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: mode,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { requestTextObservers: observers, steps },
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
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const composer = window.getByRole('textbox').first();
  await composer.click();
  await composer.fill(`[${marker}] Run the checkout tests.`);
  await window.getByRole('button', { name: 'Send message' }).click();
  const form = window.getByTestId('chat-secret-request-prompt');
  await expect(form).toBeVisible({ timeout: 90_000 });
  await window
    .getByTestId('chat-secret-request-input-STRIPE_SECRET_KEY')
    .fill(CANARY);
  await window
    .getByTestId('chat-secret-request-input-SHORT_PIN')
    .fill(SHORT_CANARY);
  await window.getByTestId('chat-secret-request-provide').click();
  return { userDataDir, electronApp, window };
}

/** Opens the settled turn's collapsed steps, which hold the tool rows. */
async function expandSteps(panel) {
  // The summary counts RunWithSecrets as a command and WriteSecretsFile as
  // an edit.
  await panel
    .getByRole('button', { name: /ran \d+ commands?/ })
    .first()
    .click();
}

async function mockCounters(marker) {
  const activity = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${encodeURIComponent(marker)}`,
  ).then((response) => response.json());
  return activity.activity ?? {};
}

/**
 * Scans every file the app wrote, the provider's own session history
 * included (the model only ever saw names), except the approved secrets
 * file, which it returns.
 */
function expectNoCanaryOnDisk(userDataDir) {
  const forms = [...CANARY_FORMS(CANARY), ...CANARY_FORMS(SHORT_CANARY)];
  let scanned = 0;
  let secretsFile = null;
  for (const file of filesUnder(userDataDir)) {
    if (path.basename(file) === '.env.local') {
      secretsFile = file;
      continue;
    }
    if (statSync(file).size > 64 * 1024 * 1024) continue;
    const text = readFileSync(file).toString('latin1');
    scanned += 1;
    for (const form of forms)
      expect(text.includes(form), `${form} in ${file}`).toBe(false);
  }
  expect(scanned).toBeGreaterThan(0);
  // The approved file holds the value, owner-only.
  expect(secretsFile).not.toBeNull();
  expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  expect(readFileSync(secretsFile, 'utf8')).toBe(
    `STRIPE_SECRET_KEY='${CANARY}'\n`,
  );
}

test.describe('agent secret use', () => {
  test('Ask mode approves each use, and the command output and file reach the model only as names', async () => {
    test.setTimeout(300_000);
    const marker = 'Canopy-CSECRETUSE-ASK';
    const observers = [
      ...CANARY_FORMS(CANARY).map((text, index) => ({
        key: `canary-long-${index}`,
        text,
      })),
      ...CANARY_FORMS(SHORT_CANARY).map((text, index) => ({
        key: `canary-short-${index}`,
        text,
      })),
      { key: 'run-advertised', scope: 'tools', text: 'RunWithSecrets' },
      // The tool's own name: RequestSecrets' description mentions it.
      {
        key: 'write-advertised',
        scope: 'tools',
        text: 'mcp__canopy__WriteSecretsFile',
      },
      { key: 'run-redacted', text: '[secret:STRIPE_SECRET_KEY]' },
      { key: 'pin-redacted', text: 'pin:[secret:SHORT_PIN]' },
      { key: 'write-result', text: 'gitExcluded' },
    ];
    const { userDataDir, electronApp, window } = await startSecretChat({
      marker,
      mode: 'ask',
      observers,
      steps: [
        requestStep(),
        runStep(),
        writeStep(),
        { text: USE_DONE, stopReason: 'end_turn' },
      ],
    });
    let closed = false;
    try {
      // The command asks first, naming the command or file and the secrets.
      const card = window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({ timeout: 90_000 });
      await expect(card).toContainText('Run a command with secrets?');
      const details = window.getByTestId('tool-approval-secret-use-details');
      await expect(details).toContainText('STRIPE_SECRET_KEY');
      await expect(details).toContainText('SHORT_PIN');
      await expect(card).not.toContainText(CANARY);
      // No rule can remember a use of secrets.
      await expect(
        window.getByRole('button', { name: 'More allow options' }),
      ).toHaveCount(0);
      await window.getByTestId('tool-approval-allow').click();
      // Then the file, naming its path and the secret.
      await expect(card).toContainText('Write a secrets file?', {
        timeout: 90_000,
      });
      await expect(details).toContainText('.env.local');
      await window.getByTestId('tool-approval-allow').click();

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByText(USE_DONE).first()).toBeVisible({
        timeout: 90_000,
      });
      await expandSteps(panel);
      await expect(
        panel.getByTestId('run-with-secrets-status').first(),
      ).toHaveText('exit 0 · 3 values redacted');
      await expect(
        panel.getByTestId('write-secrets-file-row').first(),
      ).toContainText('0600 · git-excluded');
      await expect(panel).not.toContainText(CANARY);
      await expect(panel).not.toContainText(SHORT_CANARY);

      const counters = await mockCounters(marker);
      for (const key of [
        'run-advertised',
        'write-advertised',
        'run-redacted',
        'pin-redacted',
        'write-result',
      ])
        expect(counters[`llmObserved:${key}`] ?? 0).toBeGreaterThan(0);
      for (const observer of observers.filter((entry) =>
        entry.key.startsWith('canary-'),
      ))
        expect(counters[`llmObserved:${observer.key}`] ?? 0).toBe(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;
      expectNoCanaryOnDisk(userDataDir);
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Full access runs the command and writes the file without a card, with nothing exposed', async () => {
    test.setTimeout(300_000);
    const marker = 'Canopy-CSECRETUSE-FULL';
    const observers = [
      { key: 'canary-long-raw', text: CANARY },
      { key: 'run-redacted', text: '[secret:STRIPE_SECRET_KEY]' },
    ];
    const { userDataDir, electronApp, window } = await startSecretChat({
      marker,
      mode: 'full-access',
      observers,
      steps: [
        requestStep(),
        runStep(),
        writeStep(),
        { text: USE_DONE, stopReason: 'end_turn' },
      ],
    });
    let closed = false;
    try {
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel.getByText(USE_DONE).first()).toBeVisible({
        timeout: 120_000,
      });
      await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      await expandSteps(panel);
      await expect(
        panel.getByTestId('run-with-secrets-status').first(),
      ).toHaveText('exit 0 · 3 values redacted');
      await expect(panel).not.toContainText(CANARY);

      const counters = await mockCounters(marker);
      expect(counters['llmObserved:run-redacted'] ?? 0).toBeGreaterThan(0);
      expect(counters['llmObserved:canary-long-raw'] ?? 0).toBe(0);

      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      closed = true;
      expectNoCanaryOnDisk(userDataDir);
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
