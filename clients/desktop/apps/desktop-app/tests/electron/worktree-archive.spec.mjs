import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, revealRowActions } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

// Boundary: worktree:archive, the current core.worktree.archive compatibility path.
// Golden: archiving a worktree removes it for good. A late chat flush cannot
// recreate its sidecars, a pre-teardown reload cannot resurrect its row, and a
// failed teardown leaves it in place with the removal control usable again.
//
// Seed: a demo workspace with a default `demo-main` worktree. The deletion
// fence tests use an E2E-only cleanup checkpoint to place a real renderer
// flush or reload inside cleanup.

const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';

/**
 * Whether main's desktop session snapshot lists the worktree. The portal
 * overview is built by the same enumerator, so this is what a paired browser
 * would be shown.
 */
async function sessionSnapshotListsWorktree(window, workspaceId, worktreeId) {
  return window.evaluate(
    async ({ workspaceId, worktreeId }) => {
      const snapshot = await window.api.getDesktopSessionSnapshot({});
      return snapshot.worktrees.some(
        (worktree) =>
          worktree.workspaceLocalId === workspaceId &&
          worktree.localId === worktreeId,
      );
    },
    { workspaceId, worktreeId },
  );
}

function persistedWorktreeIds(userDataDir, workspaceId) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
      'utf8',
    ),
  ).worktrees.map((worktree) => worktree.id);
}

test.describe('worktree archive', () => {
  test('G5: archiving fences a late chat flush from recreating sidecars', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-archive-chat-fence-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const { filePath: chatTabsPath } = seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_BRANCH,
      providerType: 'claude',
      tabs: [
        {
          id: 'chat-before-archive',
          title: 'Chat before archive',
          messages: [
            {
              id: 'message-before-archive',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Persisted before archive' }],
              timestamp: Date.parse('2026-09-01T12:00:00.000Z'),
            },
          ],
        },
      ],
    });
    const chatArchivesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-archives',
      `${WORKTREE_BRANCH}.json`,
    );
    const chatJournalPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-journals',
      `${WORKTREE_BRANCH}.jsonl`,
    );

    const nativeScopePath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-v2',
      WORKTREE_BRANCH,
    );
    const nativeManifestPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-storage-manifests',
      `${WORKTREE_BRANCH}.json`,
    );

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORKTREE_CLEANUP_FENCE_DELAY_MS: '2000' },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByText('Persisted before archive')).toBeVisible({
        timeout: 30_000,
      });
      expect(existsSync(nativeScopePath)).toBe(true);
      expect(existsSync(nativeManifestPath)).toBe(true);

      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      const archiveButton = await revealRowActions(
        window,
        row.getByTestId('worktree-archive-button'),
      );
      await archiveButton.click();

      // Cleanup has removed the live sidecar but is paused before metadata
      // teardown, so this renderer request is guaranteed to arrive while the
      // scope-deletion fence is held. Before the fence fix, it recreated the
      // just-deleted chat files.
      await expect
        .poll(() => existsSync(nativeScopePath), { timeout: 30_000 })
        .toBe(false);
      await expect(
        window.evaluate(
          async ({ projectId, worktreeId }) => {
            await window.api.chat.flushScope({ projectId, worktreeId });
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_BRANCH },
        ),
      ).rejects.toThrow('Chat state repository is draining');

      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          () =>
            [
              chatTabsPath,
              chatArchivesPath,
              chatJournalPath,
              nativeScopePath,
              nativeManifestPath,
            ].every((filePath) => !existsSync(filePath)),
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('archive stays removed when a pre-teardown reload finishes during cleanup', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-archive-reload-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seeded.workspaces[0];
    const configPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts.teardown =
      'node -e "setTimeout(() => process.exit(0), 1500)"';
    writeFileSync(configPath, JSON.stringify(config));
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORKTREE_CLEANUP_FENCE_DELAY_MS: '10000' },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.locator(
        '[data-testid="worktree-row"][data-branch="demo-main"]',
      );
      await expect(row).toBeVisible();
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(true);
      await window.evaluate(() => {
        window.__canopyProjectsTestApi.holdNextLoadAfterRead();
        window.__canopyProjectsTestApi.loadProjects();
      });
      await window.evaluate(() =>
        window.__canopyProjectsTestApi.waitForHeldLoad(),
      );
      const archiveButton = await revealRowActions(
        window,
        row.getByTestId('worktree-archive-button'),
      );
      await archiveButton.click();
      await expect(row).toContainText(/teardown/i);
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      // The sidebar hid the row optimistically; main must agree for as long as
      // the removal runs, or a paired browser keeps a row the desktop dropped.
      // The cleanup fence keeps the row persisted, so this reads the
      // removal-pending mark and not the finished archive.
      await expect
        .poll(
          () => sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
          { timeout: 5_000 },
        )
        .toBe(false);
      expect(persistedWorktreeIds(userDataDir, workspace.id)).toContain(
        'demo-main',
      );
      await window.evaluate(() =>
        window.__canopyProjectsTestApi.releaseHeldLoad(),
      );
      // The response was read while the worktree existed. It must not resurrect
      // the row during the real backend's deliberately held cleanup phase.
      expect(await row.count()).toBe(0);
      await expect
        .poll(
          () =>
            persistedWorktreeIds(userDataDir, workspace.id).includes(
              'demo-main',
            ),
          { timeout: 30_000 },
        )
        .toBe(false);
      await expect(row).toHaveCount(0);
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('G5: removal control disables during teardown and re-enables after failure', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-electron-archive-gating-'),
    );
    const demoSeed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-npm-next'],
    });
    const workspace = demoSeed.workspaces[0];
    const teardownCommand = 'node -e "setTimeout(() => process.exit(1), 3000)"';
    const workspaceConfigPath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'workspace.json',
    );
    const workspaceConfig = JSON.parse(
      readFileSync(workspaceConfigPath, 'utf8'),
    );
    workspaceConfig.scripts.teardown = teardownCommand;
    writeFileSync(
      workspaceConfigPath,
      `${JSON.stringify(workspaceConfig, null, 2)}\n`,
    );

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const row = window.locator(
        '[data-testid="worktree-row"][data-branch="demo-main"]',
      );
      await expect(row).toBeVisible();
      const archiveButton = await revealRowActions(
        window,
        row.getByTestId('worktree-archive-button'),
      );
      await expect(archiveButton).toBeVisible();
      // While removal cannot run (teardown in flight), the button is REMOVED
      // from the hover rail rather than rendered greyed out. Observe the DOM
      // before triggering the async action so the short-lived removal window
      // cannot be missed by Playwright's next poll.
      const transition = await archiveButton.evaluate(
        (button) =>
          new Promise((resolve, reject) => {
            let sawRemoved = false;
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(new Error('Archive button did not hide and reappear'));
            }, 15_000);
            const observer = new MutationObserver(() => {
              const currentButton = document.querySelector(
                '[data-testid="worktree-row"][data-branch="demo-main"] [data-testid="worktree-archive-button"]',
              );
              if (!currentButton) {
                sawRemoved = true;
                return;
              }
              if (sawRemoved) {
                clearTimeout(timeout);
                observer.disconnect();
                resolve({ sawRemoved });
              }
            });
            observer.observe(document.body, {
              attributes: true,
              childList: true,
              subtree: true,
              attributeFilter: ['aria-label', 'disabled'],
            });
            button.click();
          }),
      );
      expect(transition).toEqual({ sawRemoved: true });
      await expect(
        window.getByRole('dialog', { name: 'Teardown failed' }),
      ).toBeVisible({ timeout: 15_000 });
      // After the failure the action renders again (the failure dialog is
      // still up, so assert DOM presence rather than hover-revealed
      // visibility — hover would be intercepted by the dialog).
      await expect(archiveButton).toHaveCount(1, { timeout: 15_000 });
      await expect(archiveButton).toBeEnabled();
      await expect(row).toBeVisible();
      // The teardown script runs in the renderer before the archive request,
      // so a failed teardown never starts a removal in main: the snapshot
      // keeps the row the sidebar is still showing.
      expect(
        await sessionSnapshotListsWorktree(window, workspace.id, 'demo-main'),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
