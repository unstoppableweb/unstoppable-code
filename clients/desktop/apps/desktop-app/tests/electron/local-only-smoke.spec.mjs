// Local-only build smoke (CAN-7021, docs/local-only-build.md).
//
// Drives a local-only desktop build through the core local flow (a project
// from a folder, a worktree, one chat turn, Settings and the model picker)
// and proves that Electron made no outbound request except two deliberate
// canaries, and that child processes honoring the proxy variables made none.
//
// Build shapes:
// - this repository: an E2E build (`pnpm run build:e2e`, `out-e2e/`, the
//   launcher's default) where CANOPY_E2E_LOCAL_ONLY=1 turns the profile on,
//   and startup background tasks run at once;
// - the public client export: a production `CANOPY_LOCAL_ONLY=true` build in
//   `out/` (smoke:local sets CANOPY_E2E_OUT_DIR=out), which ignores that
//   variable and has no E2E seams. The chat turn
//   therefore reaches the mock the way a user's own provider would:
//   ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in the launch environment.
//
// A second case (CAN-7628) starts from a fresh profile: consent, the
// first-run Claude project import, and a Home send with no Codex executable.
// It needs the E2E build's temp-project import seam, so it skips in the
// production export build.
//
// The launcher and mock helpers live in ./local-only/ and import nothing
// outside apps/desktop-app/tests/electron and node_modules, so the export can
// run this file with playwright.local-smoke.config.mjs.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  NO_PROXY_VALUE,
  startRefusingProxy,
} from './browser-agent-phase0/provider/claude/refusing-proxy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  createTempRoots,
  isProductionLocalOnlyBuild,
  launchLocalOnlyApp,
  removeTempRoots,
} from './local-only/launcher.mjs';
import { startMockProvider } from './local-only/mock-provider.mjs';
import {
  IMPORT_FIXTURE_GIT_PROJECT,
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';

const EGRESS_LOG = 'local-only-egress.jsonl';
const MAIN_CANARY_HOST = 'canary-main.local-only-smoke.invalid';
const RENDERER_CANARY_HOST = 'canary-renderer.local-only-smoke.invalid';
const CONVERSATION_MARKER = 'Canopy-CLOCALONLY';
// No trailing punctuation, so the transcript match is one text node.
const ASSISTANT_REPLY = 'Answered by the loopback mock in a local-only build';
const WORKSPACE_ID = 'local-smoke';
const WORKTREE_BRANCH = 'local-smoke-branch';
// The scheduler in main/startup-background-tasks.ts runs delayed startup
// tasks once 5s have passed (STARTUP_BACKGROUND_TASK_DELAY_MS) and the window
// has had no input for 5s. Under the E2E seam they run at once; a production
// build has no seam, so the spec stays idle past both before quitting.
const STARTUP_TASK_IDLE_MS = 6_500;
const STARTUP_TASK_SETTLE_MS = 2_000;
const FIRST_SEND_MARKER = 'Canopy-C7628FIRSTSEND';
const FIRST_SEND_REPLY = 'Claude first send reached the loopback mock';

test.describe.configure({ retries: 0 });

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function initRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(repoPath, 'README.md'), '# local-only smoke\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  return repoPath;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function indexIds(dataDir) {
  const file = path.join(dataDir, 'workspaces', 'index.json');
  return existsSync(file)
    ? readJson(file).workspaces.map((entry) => entry.id)
    : [];
}

function worktreeRows(dataDir, workspaceId) {
  const file = path.join(dataDir, 'workspaces', workspaceId, 'worktrees.json');
  return existsSync(file) ? readJson(file).worktrees : [];
}

function readEgressLog(dataDir) {
  const file = path.join(dataDir, EGRESS_LOG);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('a local-only build reaches no host but loopback through workspace, worktree and chat', async ({}, testInfo) => {
  test.setTimeout(120_000);

  let mock;
  let proxy;
  let roots;
  let app;
  try {
    // 1-2. A private mock provider and the recording proxy.
    mock = await startMockProvider();
    proxy = await startRefusingProxy();
    roots = createTempRoots();

    // 3. Launch headless, isolated, behind the proxy, with the user's own
    // provider path pointed at the mock (no E2E mock redirect is set, so
    // both build shapes take the same path).
    app = await launchLocalOnlyApp({
      roots,
      proxyUrl: proxy.url,
      noProxy: NO_PROXY_VALUE,
      extraEnv: {
        ANTHROPIC_BASE_URL: mock.baseUrl,
        ANTHROPIC_API_KEY: 'local-only-smoke-not-a-real-key',
      },
    });
    const { electronApp, window } = app;
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });

    // 4. The local-only badge first: everything below means nothing in a
    // normal build.
    await driver.openSettings();
    await driver.openSettingsSection('canopy');
    await expect(
      window.getByTestId('settings-local-only-badge'),
      'The build under test is not local-only: Settings has no local-only badge. Build with CANOPY_LOCAL_ONLY=true, or use an E2E build (CANOPY_E2E_LOCAL_ONLY=1 is set by the launcher).',
    ).toBeVisible();
    await expect(window.getByTestId('settings-local-only-build')).toBeVisible();
    expect(await window.evaluate(() => window.api.localOnlyBuild)).toBe(true);
    await driver.closeSettings();
    // No account gate: neither the blocking sign-in gate nor the guest
    // upgrade prompt.
    await expect(window.getByTestId('cloud-sign-in-gate')).toHaveCount(0);
    await expect(window.getByTestId('guest-upgrade-nudge')).toHaveCount(0);

    // 5. Guard canary. An empty log also passes when the guard is missing,
    // so prove it is installed: one request from main's Node fetch and one
    // from the renderer, to two reserved `.invalid` hosts. The main canary
    // fails through the guarded socket connect (its process.nextTick destroy,
    // code CANOPY_LOCAL_ONLY_EGRESS_BLOCKED); neither host is reported by an
    // allowed-host source from registerLocalOnlyEgressHostSources.
    const mainCanary = await electronApp.evaluate(async (_electron, url) => {
      try {
        const response = await fetch(url);
        return { ok: true, status: response.status };
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        return {
          ok: false,
          code:
            cause && typeof cause === 'object' && 'code' in cause
              ? String(cause.code)
              : null,
        };
      }
    }, `https://${MAIN_CANARY_HOST}/`);
    expect(mainCanary).toEqual({
      ok: false,
      code: 'CANOPY_LOCAL_ONLY_EGRESS_BLOCKED',
    });
    const rendererCanary = await window.evaluate(async (url) => {
      try {
        await fetch(url, { cache: 'no-store' });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }, `https://${RENDERER_CANARY_HOST}/`);
    expect(rendererCanary).toEqual({ ok: false });
    await expect
      .poll(() =>
        readEgressLog(roots.data)
          .map(({ host, source }) => `${source} ${host}`)
          .sort(),
      )
      .toEqual(
        expect.arrayContaining([
          `node ${MAIN_CANARY_HOST}`,
          `renderer ${RENDERER_CANARY_HOST}`,
        ]),
      );

    // Channel `observability:get-posthog-anonymous-id`: a local-only build
    // hands the renderer no PostHog identity (behavior inventory declaration
    // 2026-11-16-local-only-build-profile.yaml).
    expect(
      await window.evaluate(() =>
        window.api.observability.getPostHogAnonymousId(),
      ),
    ).toBeNull();

    // 6. The scripted reply, selected by the marker in the user message.
    await mock.registerScenario(CONVERSATION_MARKER, {
      llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
    });

    // 7. A project from a folder, and a worktree on disk.
    const repoPath = initRepo(path.join(roots.fixtures, WORKSPACE_ID));
    const workspace = await window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      { repoPath },
    );
    expect(workspace).toMatchObject({
      id: WORKSPACE_ID,
      type: 'single-repo',
      repoPath,
    });
    // Shell discovery need not provision the default cowork project. Check
    // persistence of the code project this flow actually creates instead.
    await expect
      .poll(() => indexIds(roots.data), { timeout: 30_000 })
      .toContain(WORKSPACE_ID);
    const worktree = await window.evaluate(
      (request) => window.api.createWorktree(request),
      {
        projectId: WORKSPACE_ID,
        repoPath,
        existingWorktreeIds: [],
        branchName: WORKTREE_BRANCH,
      },
    );
    await expect
      .poll(
        () =>
          worktreeRows(roots.data, WORKSPACE_ID).find(
            (row) => row.id === worktree.id,
          )?.setupPhase,
        { timeout: 30_000 },
      )
      .toBe('git-ready');
    const checkout = path.join(
      roots.data,
      'workspaces',
      WORKSPACE_ID,
      'worktrees',
      worktree.id,
    );
    expect(existsSync(path.join(checkout, 'README.md'))).toBe(true);
    expect(git(checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe(
      WORKTREE_BRANCH,
    );

    // 8. One chat turn in the new worktree. The renderer loaded its projects
    // before the API calls above, so reload it to show the new rows.
    await window.reload();
    await driver.waitForShell({ timeout: 30_000 });
    await driver.openMainPage();
    await driver.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    // 9 (model picker). Pick Claude Sonnet, which the API key serves.
    const picker = panel.getByTestId('chat-model-picker');
    await picker.click();
    await selectModelOption(window, 'sonnet');
    const userMessage = `[${CONVERSATION_MARKER}] Say hello.`;
    const composer = panel.getByRole('textbox').first();
    await composer.click();
    await composer.fill(userMessage);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(userMessage).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panel.getByText(ASSISTANT_REPLY).first(),
      `No mock reply. Mock output:\n${mock.output()}`,
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      window.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });

    // 9. Settings and the model picker again, after the turn, so their
    // on-demand paths run with a provider in use and no account connected.
    // The picker starts the hosted model-library:watch subscription and asks
    // for AI credits availability; with the cloud off both answer "off"
    // without a request, so the egress log stays at the two canaries.
    await picker.click();
    await expect(
      window.getByTestId('chat-model-option-sonnet'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.keyboard.press('Escape');
    await driver.openSettings();
    await driver.openSettingsSection('canopy');
    await expect(window.getByTestId('settings-local-only-badge')).toBeVisible();
    await driver.closeSettings();

    // 10. Let delayed startup tasks run: no input for longer than the
    // scheduler's idle window, then time for their attempts to land.
    await window.waitForTimeout(STARTUP_TASK_IDLE_MS + STARTUP_TASK_SETTLE_MS);
    await app.close();

    expect(
      readEgressLog(roots.data)
        .map(({ host, source }) => `${source} ${host}`)
        .sort(),
      'Electron tried to reach a host other than the two canaries; see the attached egress log.',
    ).toEqual([`node ${MAIN_CANARY_HOST}`, `renderer ${RENDERER_CANARY_HOST}`]);
    // Spike 3: with the opt-out environment, child processes that honor the
    // proxy variables (agent CLIs, git, gh) attempt no connection at all.
    expect(
      Object.keys(proxy.summary().byHost).sort(),
      `Child processes tried to reach hosts through the proxy: ${JSON.stringify(proxy.summary())}`,
    ).toEqual([]);
    // The mock's control plane keeps per-scenario observations only, not a
    // log of every route, so the spec cannot prove nothing treated the mock
    // as a hosted service; docs/local-only-build.md records this.
  } finally {
    // 11. Always: the egress log as an attachment and in the output
    // directory (CI uploads it from there), then stop and remove everything.
    try {
      await app?.close();
    } catch {
      // Already closed.
    }
    const log = roots ? path.join(roots.data, EGRESS_LOG) : null;
    if (log && existsSync(log)) {
      const copy = testInfo.outputPath(EGRESS_LOG);
      copyFileSync(log, copy);
      await testInfo.attach(EGRESS_LOG, {
        path: copy,
        contentType: 'application/jsonl',
      });
    } else {
      await testInfo.attach(EGRESS_LOG, {
        body: '(no egress log was written)\n',
        contentType: 'text/plain',
      });
    }
    await mock?.stop();
    await proxy?.close();
    removeTempRoots(roots);
  }
});

// CAN-7628: a fresh local-only profile with a Claude key and no Codex
// executable (the launcher points CODEX_EXECUTABLE at a missing file) accepts
// consent, imports a Claude project, and sends from Home with the default
// model. Before the fix, chat:send-message rejected with a raw
// `spawn …/uninstalled-codex ENOENT` once the plugin catalog held Codex
// facets.
test('a fresh local-only profile without Codex imports a Claude project and completes the first Home send', async ({}, testInfo) => {
  // The first-run import lists only Claude projects outside the OS temp dir
  // in a production build; the E2E build lifts that through
  // CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT, which the production local-only
  // build compiles out. The first case above still runs in both shapes.
  test.skip(
    isProductionLocalOnlyBuild(),
    'Production discovery excludes temp-dir projects and has no E2E import seam.',
  );
  test.setTimeout(120_000);

  let mock;
  let proxy;
  let roots;
  let app;
  const cleanupErrors = [];
  try {
    mock = await startMockProvider();
    proxy = await startRefusingProxy();
    roots = createTempRoots();
    const fixture = seedExternalProjectImportFixture({
      claudeDir: roots.claude,
      fixturesParent: roots.fixtures,
    });
    await mock.registerScenario(FIRST_SEND_MARKER, {
      llm: { steps: [{ text: FIRST_SEND_REPLY, stopReason: 'end_turn' }] },
    });

    app = await launchLocalOnlyApp({
      roots,
      proxyUrl: proxy.url,
      noProxy: NO_PROXY_VALUE,
      freshFirstRun: true,
      extraEnv: {
        ANTHROPIC_BASE_URL: mock.baseUrl,
        ANTHROPIC_API_KEY: 'local-only-smoke-not-a-real-key',
        ...fixture.env,
      },
    });
    const { electronApp, window } = app;

    // Every child process main starts goes through ChildProcess#spawn. Record
    // each attempt to start the configured Codex executable from here on;
    // the import, memory refresh, inventory reads and send all follow.
    // Earlier startup launches and other processes (the core daemon) are not
    // observed here.
    await electronApp.evaluate(() => {
      const { ChildProcess } = process.getBuiltinModule('node:child_process');
      const original = ChildProcess.prototype.spawn;
      const attempts = [];
      globalThis.__localOnlyCodexSpawnAttempts = attempts;
      ChildProcess.prototype.spawn = function spawn(options) {
        if (options?.file === process.env.CODEX_EXECUTABLE) {
          attempts.push(new Error('Codex spawn attempt').stack);
        }
        return original.call(this, options);
      };
    });

    // 1. Consent, then the first-run import page lists the fixture project.
    const driver = new CanopyAppDriver(window);
    // Nothing leaves this build, so the gate shows no "What you share" card.
    await expect(window.getByTestId('legal-consent-gate')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByTestId('legal-consent-data-choices')).toHaveCount(
      0,
    );
    await driver.acceptLegalConsent();
    await driver.waitForShell({ timeout: 30_000 });
    const row = window.getByTestId(
      `first-run-import-row-${externalProjectCandidateIdFor(fixture.gitApp)}`,
    );
    await expect(row.getByRole('checkbox')).toBeVisible({ timeout: 30_000 });
    await row.getByRole('checkbox').check();
    await window.getByTestId('first-run-import-submit').click();

    // 2. Home, with the project actually imported.
    const editor = window
      .getByTestId('home-composer-editor')
      .locator('visible=true');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => indexIds(roots.data), { timeout: 30_000 })
      .toContain(IMPORT_FIXTURE_GIT_PROJECT);

    // 3. The first send, on the default Claude model.
    const prompt = `[${FIRST_SEND_MARKER}] Reply to this request`;
    await editor.fill(prompt);
    await expect(
      window.getByTestId('home-send-button').locator('visible=true'),
    ).toBeEnabled();
    await editor.press('Enter');
    await expect(
      window.getByText(prompt, { exact: true }).locator('visible=true').first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window
        .getByText(FIRST_SEND_REPLY, { exact: true })
        .locator('visible=true')
        .first(),
      `No mock reply. Mock output:\n${mock.output()}`,
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      window.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByText(/ENOENT/)).toHaveCount(0);

    // 4. The Claude reads that used to start Codex answer with Claude content.
    const reads = await window.evaluate(async () => ({
      inventory: await window.invocableInventory.list({
        providerType: 'claude',
      }),
      status: await window.installedItems.listStatus(),
    }));
    expect(reads.inventory.success).toBe(true);
    expect(reads.inventory.data.entries.length).toBeGreaterThan(0);
    expect(
      reads.inventory.data.entries.filter(
        (entry) => entry.provider !== 'claude',
      ),
    ).toEqual([]);
    const claudeSkill = reads.inventory.data.entries.find(
      (entry) => entry.name === 'canopy-config' && entry.kind === 'skill',
    );
    expect(claudeSkill?.enableRef).toEqual({
      kind: 'skill',
      sourceId: 'builtin:app',
      skillName: 'canopy-config',
    });
    expect(reads.status.items).toContainEqual(
      expect.objectContaining({
        target: claudeSkill.enableRef,
        status: 'available',
      }),
    );

    expect(
      await electronApp.evaluate(
        () => globalThis.__localOnlyCodexSpawnAttempts,
      ),
      'Main tried to start the missing Codex executable.',
    ).toEqual([]);

    await app.close();
    expect(
      readEgressLog(roots.data),
      'Electron tried to reach a non-loopback host; see the attached egress log.',
    ).toEqual([]);
    expect(
      Object.keys(proxy.summary().byHost),
      `Child processes tried to reach hosts through the proxy: ${JSON.stringify(proxy.summary())}`,
    ).toEqual([]);
  } finally {
    for (const cleanup of [
      () => app?.close(),
      async () => {
        const log = roots ? path.join(roots.data, EGRESS_LOG) : null;
        if (!log || !existsSync(log)) return;
        const copy = testInfo.outputPath(EGRESS_LOG);
        copyFileSync(log, copy);
        await testInfo.attach(EGRESS_LOG, {
          path: copy,
          contentType: 'application/jsonl',
        });
      },
      () => mock?.stop(),
      () => proxy?.close(),
      () => removeTempRoots(roots),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Local-only smoke cleanup failed');
  }
});

/** Clicks a model row in the open picker, opening "More" groups if needed. */
async function selectModelOption(window, modelId) {
  const menu = window.getByTestId('chat-model-menu');
  await expect(menu).toBeVisible();
  const allTab = menu.getByTestId('chat-model-harness-tab-all');
  if ((await allTab.count()) > 0) await allTab.click();
  const option = window
    .locator(`[data-testid="chat-model-option-${modelId}"]:visible`)
    .first();
  if (!(await option.isVisible().catch(() => false))) {
    const triggers = await menu
      .locator('[data-testid^="chat-model-more-"]:visible')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute('data-testid') ?? '')
          .filter((testId) => !testId.startsWith('chat-model-more-group-')),
      );
    for (const testId of triggers) {
      await menu.locator(`[data-testid="${testId}"]:visible`).first().click();
      if (await option.isVisible().catch(() => false)) break;
    }
  }
  await option.click();
}
