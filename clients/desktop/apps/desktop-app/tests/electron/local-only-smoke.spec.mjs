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
  launchLocalOnlyApp,
  removeTempRoots,
} from './local-only/launcher.mjs';
import { startMockProvider } from './local-only/mock-provider.mjs';

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
