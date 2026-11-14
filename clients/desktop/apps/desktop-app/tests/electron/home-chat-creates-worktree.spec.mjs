import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

// Golden: a Chat-mode send from the standalone Home page creates a worktree,
// navigates to Code, and the message reaches the transcript.

const DEMO_APP_ID = 'ts-pnpm-vite';

async function waitForHomeWorkspaceSelection(homePage) {
  await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
    'data-workspace-selected',
    'true',
  );
}

test.describe('Home chat send', () => {
  test('workspace startup admits Home only after the local boot barrier settles, including reloads', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-startup-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Exercise the real completed handler before holding the local admission
      // reply for a reload; no canonical store or writer is replaced.
      await window.evaluate(() => window.api.waitForWorkspaceStartup());
      await electronApp.evaluate(({ ipcMain }) => {
        const ready = new Promise((resolve) => {
          globalThis.__releaseHomeStartup = resolve;
        });
        ipcMain.removeHandler('app:workspace-startup-wait');
        ipcMain.handle('app:workspace-startup-wait', () => ready);
      });
      await window.reload();
      const loading = window.getByTestId('workspace-startup-loading');
      await expect(loading).toBeVisible();
      await expect(window.getByTestId('sidebar-create-task')).toHaveCount(0);
      await expect(window.getByTestId('home-composer-editor')).toHaveCount(0);
      await window.reload();
      await expect(loading).toBeVisible();
      await expect(
        loading.getByText('Still loading workspaces…', { exact: true }).last(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('sidebar-create-task')).toHaveCount(0);
      await electronApp.evaluate(() => {
        globalThis.__releaseHomeStartup();
        delete globalThis.__releaseHomeStartup;
      });
      await app.waitForShell({ timeout: 30_000 });
      await expect(loading).toHaveCount(0);
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      await waitForHomeWorkspaceSelection(home);
      await expect(home.getByTestId('home-composer-editor')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an unborn source preserves the draft before any worktree or chat and recovers after a first commit', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-unborn-'),
    );
    const summary = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    const repoPath = summary.workspaces[0].repoPath;
    const git = (args) =>
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    // Keep staged files but remove the first commit, like a fresh git init.
    git(['update-ref', '-d', 'HEAD']);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await waitForHomeWorkspaceSelection(home);
      const picker = home.getByTestId('home-branch-picker-button');
      await expect(picker).toHaveAttribute('data-source-no-commits', 'true');
      const prompt = 'Investigate the failing health-check endpoint.';
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await window.keyboard.press('Enter');
      await expect(home.getByTestId('home-composer-error')).toContainText(
        'has no commits yet. Create a first commit on this branch, then send again.',
      );
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
      const projects = await window.evaluate(() => window.api.loadProjects());
      expect(
        projects.items.find((item) => item.id === `demo-${DEMO_APP_ID}`)
          ?.worktrees,
      ).toEqual([]);

      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '--no-verify',
        '-m',
        'First commit',
      ]);
      // Returning from an external editor refreshes the warning and clears
      // only this preflight error, without consuming the preserved draft.
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(picker).not.toHaveAttribute(
        'data-source-no-commits',
        'true',
      );
      await expect(home.getByTestId('home-composer-error')).toHaveCount(0);
      await home.getByTestId('home-send-button').click();
      await expect(home).toHaveCount(0);
      await expect(window.getByTestId('worktree-row')).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(
        window.getByTestId('panel-content-chat').getByText(prompt).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.getByTestId('worktree-error-notice')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Chat mode send creates a worktree, navigates to Code, and the message reaches the transcript', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-surface-send-'),
    );
    // No pre-existing worktree so the post-send worktree-row count
    // unambiguously proves the Home send created one.
    const summary = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    execFileSync(
      'git',
      ['update-ref', 'refs/remotes/origin/feature-x', 'HEAD'],
      { cwd: summary.workspaces[0].repoPath, stdio: 'pipe' },
    );

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Fail the first catalogue read at the real IPC boundary. Retry uses
      // the original handler, including its real Git reads.
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'home:list-branch-targets';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Home catalogue handler is missing.');
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          throw new Error('Fixture: the first branch list failed.');
        });
      });
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await waitForHomeWorkspaceSelection(homePage);

      const picker = homePage.getByTestId('home-base-branch-picker-button');
      const search = window.getByRole('combobox', { name: 'Search branches' });
      const branch = window.getByRole('option').filter({
        has: window.getByText('origin/feature-x', { exact: true }),
      });
      await picker.press('Enter');
      await expect(
        window.getByTestId('home-base-branch-picker-branches-error'),
      ).toBeVisible();
      await window
        .getByTestId('home-base-branch-picker-branches-retry')
        .click();
      await expect(branch).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();
      await search.fill('feature');
      await expect(branch).toBeVisible();
      await search.fill('origin/fe');
      await expect(branch).toBeVisible();
      await window.keyboard.press('Tab');
      await expect(
        window.getByTestId('home-base-branch-picker-tab-branches'),
      ).toBeFocused();
      await window.keyboard.press('Tab');
      await expect(search).toBeHidden();
      // Tab dismisses the picker. The trigger keeps its own collapsed state
      // when a non-interactive tooltip wraps it (#8911).
      await expect(picker).toHaveAttribute('aria-expanded', 'false');
      await expect(picker).toBeFocused();
      await window.keyboard.press('Enter');
      await search.fill('origin/feature-x');
      await expect(branch).toBeVisible();
      await search.press('Enter');
      await expect(picker).toHaveAccessibleName(/origin\/feature-x/);

      const git = (args) =>
        execFileSync('git', args, {
          cwd: summary.workspaces[0].repoPath,
          stdio: 'pipe',
        });
      git(['update-ref', 'refs/heads/origin/feature-x', 'HEAD']);
      git(['update-ref', '-d', 'refs/remotes/origin/feature-x']);
      await picker.press('Enter');
      await expect(picker).toHaveAccessibleName(/origin\/feature-x.*missing/);
      await window.keyboard.press('Escape');
      // The confirmed absence belongs to the saved selection, including
      // while reopening or after a failed refresh. It still blocks sending.
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'home:list-branch-targets';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Home catalogue handler is missing.');
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          throw new Error('Fixture: refresh after confirmed absence failed.');
        });
      });
      await picker.press('Enter');
      await expect(picker).toHaveAccessibleName(/origin\/feature-x.*missing/);
      await expect(
        window.getByTestId('home-base-branch-picker-branches-error'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await homePage
        .getByTestId('home-composer-editor')
        .fill('Keep the exact missing base.');
      await homePage.getByTestId('home-send-button').click();
      await expect(homePage.getByTestId('home-composer-error')).toBeVisible();
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
      await expect(picker).toHaveAccessibleName(/origin\/feature-x.*missing/);
      git(['update-ref', 'refs/remotes/origin/feature-x', 'HEAD']);
      await picker.press('Enter');
      await window
        .getByTestId('home-base-branch-picker-branches-retry')
        .click();
      await expect(picker).not.toHaveAccessibleName(/missing/);
      await window.keyboard.press('Escape');

      // Keep the approval lookup in flight long enough for a premature Code
      // navigation to become a user-visible empty frame. The fixed flow keeps
      // Home mounted until the starter tab has consumed this result.
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('approval:resolved-default');
        ipcMain.handle('approval:resolved-default', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return 'ask';
        });
      });

      const taskText = 'Investigate the failing health-check endpoint.';
      await window.evaluate(() => {
        window.__homeSendNoChatSeen = false;
        window.__homeSendTransitionChecked = false;
        let transitionCheckScheduled = false;
        let homeWasMounted = Boolean(
          document.querySelector('[data-testid="page-home"]'),
        );
        new MutationObserver(() => {
          const homeIsMounted = Boolean(
            document.querySelector('[data-testid="page-home"]'),
          );
          if (homeWasMounted && !homeIsMounted && !transitionCheckScheduled) {
            transitionCheckScheduled = true;
            setTimeout(() => {
              const chatPanelIsMounted = document.querySelector(
                '[data-testid="panel-content-chat"]',
              );
              if (!chatPanelIsMounted) window.__homeSendNoChatSeen = true;
              window.__homeSendTransitionChecked = true;
            }, 100);
          }
          homeWasMounted = homeIsMounted;
        }).observe(document.body, { childList: true, subtree: true });
      });
      await homePage.getByTestId('home-composer-editor').click();
      await homePage.getByTestId('home-composer-editor').fill(taskText);
      await homePage.getByTestId('home-send-button').click();

      // Task I1: `dispatchHomeSend`'s new-worktree route does ONE transition —
      // the (now reservation-only, sub-second) create resolves, the created
      // worktree is selected, then it navigates to Code. The Home page unmounts.
      await expect(homePage).toHaveCount(0);

      // The first (and only) new Code-page surface is the real chat panel —
      // there is no special pending page anymore. It is NEVER the embedded
      // no-selection HomeSurface (the "looks broken" regression of earlier
      // rounds).
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('home-surface')).toHaveCount(0);
      await window.waitForFunction(
        () => window.__homeSendTransitionChecked === true,
      );
      expect(await window.evaluate(() => window.__homeSendNoChatSeen)).toBe(
        false,
      );

      const rows = window.getByTestId('worktree-row');
      await expect(rows).toHaveCount(1, { timeout: 60_000 });

      // The user's message shows in the transcript (as a queued bubble while
      // git-pending, or processed once ready).
      await expect(panel.getByText(taskText).first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Branch info shows the checked-out branch after verification fails', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-branch-info-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const row = window.locator(
        '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
      );
      await row.click();
      await row.click({ button: 'right' });
      await window.getByTestId('worktree-actions-menu-info').click();
      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      await dialog
        .getByRole('button', { name: 'Switch branch', exact: true })
        .click();
      await dialog.getByText('New branch…', { exact: true }).click();

      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'worktree:create-branch';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Branch create handler missing');
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, request) => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          const result = await original(event, request);
          if (!result.success) throw new Error('Fixture checkout failed');
          return {
            success: false,
            branchName: result.branchName,
            failureMessage:
              'Could not verify checkout after Git switched branches.',
          };
        });
      });
      await dialog
        .getByRole('textbox', { name: 'Branch name' })
        .fill('after-checkout');
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(
        dialog.getByText(
          'Could not verify checkout after Git switched branches.',
        ),
      ).toBeVisible();
      await expect(row).toHaveAttribute('data-branch', 'after-checkout');
      await expect(
        dialog.getByRole('textbox', { name: 'Branch name' }),
      ).toHaveCount(0);
      await expect(dialog.locator('[aria-current="true"]')).toHaveText(
        /after-checkout/,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Branch info consumes the create draft after a hook advances the new branch', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-hook-checkout-'),
    );
    const {
      workspaces: [workspace],
    } = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
    });
    const git = (args) =>
      execFileSync('git', args, {
        cwd: workspace.worktreePath,
        encoding: 'utf8',
      }).trim();
    git(['branch', 'hook-base']);
    const baseTip = git(['rev-parse', 'refs/heads/hook-base']);
    const hooks = path.join(userDataDir, 'checkout-hooks');
    mkdirSync(hooks);
    writeFileSync(
      path.join(hooks, 'post-checkout'),
      [
        '#!/bin/sh',
        'test "$(git symbolic-ref -q HEAD)" = refs/heads/hook-checkout || exit 0',
        'git -c user.name=Fixture -c user.email=fixture@example.com commit --allow-empty --no-verify -qm "Advance after checkout"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    git(['config', 'core.hooksPath', hooks]);

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const row = window.locator(
        '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
      );
      await row.click();
      await row.click({ button: 'right' });
      await window.getByTestId('worktree-actions-menu-info').click();
      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      const switchBranch = dialog.getByRole('button', {
        name: 'Switch branch',
        exact: true,
      });
      await switchBranch.click();
      const newBranch = dialog.getByText('New branch…', { exact: true });
      await newBranch.click();
      const draft = dialog.getByRole('textbox', { name: 'Branch name' });
      const create = dialog.getByRole('button', {
        name: 'Create',
        exact: true,
      });
      await draft.fill('hook-checkout');
      await dialog
        .getByRole('textbox', { name: 'From base branch' })
        .fill('hook-base');
      await window
        .getByRole('listbox', { name: 'Base branches' })
        .getByText('hook-base', { exact: true })
        .click();
      await create.click();

      await expect(row).toHaveAttribute('data-branch', 'hook-checkout');
      expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/hook-checkout');
      await expect.poll(() => git(['rev-parse', 'HEAD'])).not.toBe(baseTip);
      expect(git(['rev-parse', 'HEAD^'])).toBe(baseTip);
      await expect(draft).toHaveCount(0);
      await expect(newBranch).toHaveCount(0);
      await switchBranch.click();
      await expect(dialog.locator('[aria-current="true"]')).toHaveText(
        /hook-checkout/,
      );
      await newBranch.click();
      await expect(draft).toHaveValue('');
      await expect(create).toBeDisabled();
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
          .split('\n')
          .filter((ref) => ref.startsWith('refs/heads/hook-checkout')),
      ).toEqual(['refs/heads/hook-checkout']);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Branch info saves the base and recovers an existing checkout after a refresh failure', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-branch-refresh-retry-'),
    );
    const {
      workspaces: [workspace],
    } = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
    });
    const git = (args) =>
      execFileSync('git', args, {
        cwd: workspace.worktreePath,
        encoding: 'utf8',
      }).trim();
    git(['branch', 'retry-base']);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const row = window.locator(
        '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
      );
      await row.click();
      await row.click({ button: 'right' });
      await window.getByTestId('worktree-actions-menu-info').click();
      const dialog = window.getByRole('dialog', { name: 'Branch info' });
      await dialog
        .getByRole('button', { name: 'Switch branch', exact: true })
        .click();
      await dialog.getByText('New branch…', { exact: true }).click();

      await electronApp.evaluate(({ ipcMain }) => {
        const create = 'worktree:create-branch';
        const list = 'worktree:list-branches';
        const originalCreate = ipcMain._invokeHandlers.get(create);
        const originalList = ipcMain._invokeHandlers.get(list);
        if (!originalCreate || !originalList)
          throw new Error('Branch fixture handlers missing');
        ipcMain.removeHandler(create);
        ipcMain.handle(create, async (event, request) => {
          ipcMain.removeHandler(create);
          ipcMain.handle(create, originalCreate);
          const result = await originalCreate(event, request);
          if (!result.success) throw new Error('Fixture checkout failed');
          ipcMain.removeHandler(list);
          ipcMain.handle(list, () => {
            ipcMain.removeHandler(list);
            ipcMain.handle(list, originalList);
            throw new Error('Branch list unavailable after create');
          });
          return result;
        });
      });
      await dialog
        .getByRole('textbox', { name: 'Branch name' })
        .fill('retry-checkout');
      await dialog
        .getByRole('textbox', { name: 'From base branch' })
        .fill('retry-base');
      await window
        .getByRole('listbox', { name: 'Base branches' })
        .getByText('retry-base', { exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      const retry = dialog.getByRole('button', {
        name: 'Try again',
        exact: true,
      });
      await expect(retry).toBeVisible();
      const savedBase = () =>
        window.evaluate(async (projectId) => {
          const { items } = await window.api.loadProjects();
          return items
            .find((item) => item.id === projectId)
            ?.worktrees?.find((worktree) => worktree.id === 'demo-main')
            ?.trackedBaseBranch;
        }, `demo-${DEMO_APP_ID}`);
      expect(await savedBase()).toBe('retry-base');

      await retry.click();
      await expect(dialog.locator('[aria-current="true"]')).toHaveText(
        /retry-checkout/,
      );
      await expect(
        dialog.getByRole('button', { name: 'Create', exact: true }),
      ).toHaveCount(0);
      expect(await savedBase()).toBe('retry-base');
      expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/retry-checkout');
      expect(
        git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
          .split('\n')
          .filter((ref) => ref.startsWith('refs/heads/retry-checkout')),
      ).toEqual(['refs/heads/retry-checkout']);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // CAN-6444: a user whose only working route is their own AI gateway (Claude
  // and Codex signed out, no AI Credits) lands on Home defaulted to a model
  // they saved there, never a built-in model they can't bill, and the first
  // send runs on that gateway with their key.
  test('a gateway-only account defaults Home to its own gateway model and sends through it', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-gateway-only-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    // A per-test key keeps the signed-out scenario away from parallel tests.
    const mockKey = `csk_home_gateway_${randomUUID()}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, mockKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    // Signed out of the cloud: AI Credits are unavailable.
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: mockKey,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-ai-gateway-settings-enabled': true,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      // Save an OpenRouter gateway on this device through the real preload:
      // a preset-suggested model first, then one the user chose themselves.
      const gatewayModel = (id, gatewayId, label) => ({
        id,
        gatewayId,
        label,
        harness: 'claude',
        contextWindow: 200_000,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      });
      const saved = await window.evaluate(
        async (models) => {
          const { organizationId } = await window.api.localModelGateway.read();
          const update = await window.api.localModelGateway.update({
            expectedOrganizationId: organizationId,
            expectedRevision: 'absent',
            baseUrl: 'https://openrouter.ai/api',
            enabled: true,
            models,
          });
          const connect = await window.api.localModelGateway.connect({
            expectedOrganizationId: organizationId,
            baseUrl: 'https://openrouter.ai/api',
            apiKey: 'sk-or-e2e-home-gateway',
          });
          return { update, connect };
        },
        [
          gatewayModel(
            'gateway-sonnet-5-5',
            'anthropic/claude-sonnet-5.5',
            'Gateway Sonnet 5.5',
          ),
          gatewayModel(
            'gateway-qwen3-5-coder',
            'qwen/qwen3.5-coder-480b',
            'Qwen3.5 Coder 480B',
          ),
        ],
      );
      expect(saved.update.ok).toBe(true);
      expect(saved.connect.value?.status).toBe('connected');

      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await waitForHomeWorkspaceSelection(homePage);
      // The model the user chose themselves, not the preset suggestion and
      // not a built-in Claude model.
      await expect(homePage.getByTestId('chat-model-picker')).toContainText(
        'Qwen3.5 Coder 480B',
        { timeout: 30_000 },
      );

      const marker = `Canopy-Chome-gateway-${randomUUID()}`;
      const reply = 'Fixed the missing element panic.';
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });
      const taskText = `Fix the missing element panic. [${marker}]`;
      await homePage.getByTestId('home-composer-editor').fill(taskText);
      await homePage.getByTestId('home-send-button').click();
      await expect(homePage).toHaveCount(0);
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      // The turn reached the gateway under the model's gateway id.
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity[
              'llmModel:qwen/qwen3.5-coder-480b'
            ] ?? 0,
          { timeout: 60_000 },
        )
        .toBeGreaterThan(0);
      await expect(panel.getByText(reply).first()).toBeVisible({
        timeout: 30_000,
      });
      // Its own gateway key pays, so the composer reports no billing dead end.
      await expect(window.getByText('Not connected to Claude')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// The worktree menu drives workspace:combine-worktree-with-existing-worktree.
// Golden: composition must preserve the user's saved chat across a restart.
test('combining repository worktrees opens a temporary destination and preserves its chat after restart', async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-composition-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID, 'go-cli'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${DEMO_APP_ID}`,
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'saved-source-chat',
        title: 'Saved source chat',
        blocks: [
          { type: 'text', text: 'Saved transcript survives composition.' },
        ],
      },
    ],
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const source = window.locator(
      `[data-testid="worktree-row"][data-project-id="demo-${DEMO_APP_ID}"][data-worktree-id="demo-main"]`,
    );
    await source.click();
    await source.click({ button: 'right' });
    await window.getByTestId('worktree-actions-menu-add-repo').click();
    const dialog = window.getByTestId('add-repo-to-worktree-modal');
    await dialog
      .getByTestId('add-repo-to-worktree-modal-pill-existing')
      .click();
    await dialog
      .getByTestId('existing-worktree-picker-option-demo-go-cli-demo-main')
      .click();
    await dialog.getByTestId('add-repo-to-worktree-modal-submit').click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    const destination = await window.evaluate(async () =>
      (await window.api.loadProjects()).items.find(
        (item) => item.type === 'multi-repo' && item.temporary,
      ),
    );
    expect(destination).toBeDefined();
    const destinationSelector = `[data-testid="worktree-row"][data-project-id="${destination.id}"]`;
    await expect(
      window.locator(`[data-sidebar-selected-item] ${destinationSelector}`),
    ).toBeVisible();
    await expect(
      window
        .getByText('Saved transcript survives composition.', { exact: true })
        .first(),
    ).toBeVisible();
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.locator(destinationSelector).click();
    await expect(
      window
        .getByText('Saved transcript survives composition.', { exact: true })
        .first(),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
