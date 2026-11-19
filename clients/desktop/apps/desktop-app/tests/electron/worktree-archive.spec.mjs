import { seedChatsSectionFixture } from './seeders/seedChatsSectionFixture.mjs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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

test('Finish qualifies historical nonempty metadata after device renumbering', async () => {
  test.setTimeout(240_000);
  let control;
  for (const change of ['exact', 'device', 'inode', 'birthtime']) {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-finish-identity-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const project = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    const config = JSON.parse(
      readFileSync(path.join(project, 'workspace.json'), 'utf8'),
    );
    const { electronApp: initial } = await launchCanopy({ userDataDir });
    try {
      const window = await initial.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      const result = await window.evaluate(
        (request) => window.api.archiveWorktree(request),
        {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_BRANCH,
          repoPath: config.repoPath,
          deleteBranch: false,
          lockAfterArchive: true,
        },
      );
      expect(result.success).toBe(true);
    } finally {
      await closeCanopy(initial, userDataDir, { keepUserData: true });
    }
    const journal = path.join(
      userDataDir,
      'w5/destructive-lifecycles',
      createHash('sha256')
        .update(JSON.stringify([WORKSPACE_ID, WORKTREE_BRANCH]))
        .digest('hex') + '.json',
    );
    const record = JSON.parse(readFileSync(journal, 'utf8'));
    const metadata = path.join(project, 'worktree-data', WORKTREE_BRANCH);
    mkdirSync(metadata, { recursive: true });
    writeFileSync(
      path.join(metadata, 'sentinel'),
      'original metadata awaiting cleanup',
    );
    const mutate = (value) => {
      const fields = value.split(':');
      if (change !== 'exact') {
        const index = change === 'device' ? 0 : change === 'inode' ? 1 : 2;
        fields[index] = String(Number(fields[index]) + 1);
      }
      return fields.join(':');
    };
    const observed = lstatSync(metadata);
    // Negative metadata cases must reach the metadata guard, not fail at the project guard.
    if (change === 'device')
      record.directoryIdentity = mutate(record.directoryIdentity);
    record.ownedPaths = record.ownedPaths.filter(
      (owned) => owned.path !== metadata,
    );
    record.ownedPaths.push({
      path: metadata,
      identity: mutate(
        `${observed.dev}:${observed.ino}:${observed.birthtimeMs}`,
      ),
    });
    record.state = 'recovery-required';
    record.cleanupRequired = true;
    record.steps = record.steps.filter(
      (step) => !step.phase.startsWith('sidecar:'),
    );
    record.steps.push({ phase: 'sidecar:worktree metadata', state: 'pending' });
    writeFileSync(journal, JSON.stringify(record));
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      const list = await window.evaluate(
        (request) => window.api.listWorktreeRecovery(request),
        { workspaceId: WORKSPACE_ID, operationId: record.operationId },
      );
      const entry = list.entries[0];
      expect(entry?.diagnosis).toBeDefined();
      const accepted =
        change === 'exact' ||
        (change === 'device' && process.platform === 'darwin');
      const verdict = {
        verdict: entry.diagnosis.verdict,
        check: entry.diagnosis.check,
        actions: entry.actions,
      };
      if (change === 'exact') control = verdict;
      if (accepted) expect(verdict).toEqual(control);
      else expect(entry.diagnosis.verdict).toBe('refused');
      const result = await window.evaluate(
        (request) => window.api.finishWorktreeRecovery(request),
        {
          workspaceId: WORKSPACE_ID,
          operationId: record.operationId,
          revision: entry.diagnosis.revision,
        },
      );
      expect(result.status).toBe(accepted ? 'finished' : 'refused');
      expect(existsSync(metadata)).toBe(!accepted);
      expect(JSON.parse(readFileSync(journal, 'utf8')).state).toBe(
        accepted ? 'completed' : 'recovery-required',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

for (const action of ['keep', 'discard', 'aside-discard', 'retained-discard']) {
  test(`persisted identity device drift preserves ${action} verdicts and effects`, async () => {
    test.setTimeout(240_000);
    const { seedWorktreeRecoveryFixture } =
      await import('./seeders/worktreeRecoveryFixture.mjs');
    let control;
    const cases = [
      { identityChange: 'exact' },
      { identityChange: 'device' },
      ...['inode', 'birthtime'].map((identityChange) => ({
        identityChange,
        identityScope: action === 'retained-discard' ? 'staged' : 'owned',
      })),
      ...(action === 'keep'
        ? ['project', 'staged'].flatMap((identityScope) =>
            ['inode', 'birthtime'].map((identityChange) => ({
              identityChange,
              identityScope,
            })),
          )
        : []),
      ...(['discard', 'aside-discard'].includes(action)
        ? ['exact', 'device'].map((identityChange) => ({
            identityChange,
            identityScope: 'owned',
            unverifiableCheckout: true,
          }))
        : []),
    ];
    for (const scenario of cases) {
      const { identityChange, unverifiableCheckout = false } = scenario;
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-recorded-identity-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      const fixture = seedWorktreeRecoveryFixture({
        userDataDir,
        ...scenario,
        interruptedDiscard: action === 'aside-discard',
        aside: action === 'aside-discard',
        stagedCapture: action === 'keep',
        retained: action === 'retained-discard',
      });
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        await new CanopyAppDriver(window).waitForShell();
        const accepted =
          identityChange === 'exact' ||
          (identityChange === 'device' &&
            process.platform === 'darwin' &&
            !unverifiableCheckout);
        if (action === 'keep') {
          const list = await window.evaluate(
            (workspaceId) => window.api.listWorktreeRecovery({ workspaceId }),
            WORKSPACE_ID,
          );
          const entry = list.entries.find(
            (item) => item.diagnosis?.operationId === fixture.operationId,
          );
          expect(entry).toBeDefined();
          const verdict = {
            diagnosis: entry.diagnosis.verdict,
            check: entry.diagnosis.check,
            actions: entry.actions,
            checkout: entry.retained.checkout,
          };
          if (identityChange === 'exact') control = verdict;
          // Keep binds project/staged evidence; explicit Discard independently binds the checkout.
          expect(entry.actions.discard.eligible).toBe(
            accepted || ['project', 'staged'].includes(scenario.identityScope),
          );
          if (accepted) {
            expect(verdict).toEqual(control);
            expect(entry.diagnosis.verdict).toBe('keep-worktree');
            const result = await window.evaluate(
              (request) => window.api.resolveWorktreeRecovery(request),
              {
                workspaceId: WORKSPACE_ID,
                operationId: fixture.operationId,
                revision: entry.diagnosis.revision,
                action: 'keep-worktree',
              },
            );
            expect(result.status).toBe('worktree-kept');
            expect(existsSync(fixture.checkout)).toBe(true);
            const hold = JSON.parse(
              readFileSync(
                path.join(
                  userDataDir,
                  'w5/archive-recovery',
                  WORKSPACE_ID,
                  fixture.operationId,
                  'receipt.json',
                ),
                'utf8',
              ),
            );
            expect(hold.stage).toBe('completed');
          } else {
            expect(entry.diagnosis.verdict).toBe('refused');
            const before = readFileSync(fixture.file, 'utf8');
            const result = await window.evaluate(
              (request) => window.api.resolveWorktreeRecovery(request),
              {
                workspaceId: WORKSPACE_ID,
                operationId: fixture.operationId,
                revision: entry.diagnosis.revision,
                action: 'keep-worktree',
              },
            );
            expect(result.status).toBe('refused');
            expect(readFileSync(fixture.file, 'utf8')).toBe(before);
            expect(existsSync(fixture.checkout)).toBe(true);
            expect(JSON.parse(readFileSync(fixture.file, 'utf8')).state).toBe(
              'recovery-required',
            );
          }
        } else {
          const description = await window.evaluate(
            (request) => window.api.describeWorktreeDiscard(request),
            {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_BRANCH,
              retainedArchives: action === 'retained-discard',
            },
          );
          const verdict = {
            status: description.status,
            causes: description.causes,
            kinds: description.targets.map((target) => target.kind),
            preserved: description.preserved,
          };
          if (identityChange === 'exact' && !unverifiableCheckout)
            control = verdict;
          if (accepted) {
            expect(verdict).toEqual(control);
            expect(description.status).toBe('discardable');
            const result = await window.evaluate(
              (request) => window.api.discardWorktree(request),
              {
                projectId: WORKSPACE_ID,
                worktreeId: WORKTREE_BRANCH,
                confirmation: description.confirmation,
                retainedArchives: action === 'retained-discard',
              },
            );
            expect(result.status).toBe('discarded');
            expect(existsSync(fixture.checkout)).toBe(false);
            expect(
              existsSync(
                path.join(
                  path.dirname(fixture.checkout),
                  `.${WORKTREE_BRANCH}.discard-aside-live-checkout`,
                ),
              ),
            ).toBe(false);
            if (action === 'retained-discard')
              expect(existsSync(fixture.container)).toBe(false);
            else
              expect(JSON.parse(readFileSync(fixture.file, 'utf8')).state).toBe(
                'completed',
              );
          } else {
            expect(description.status).toBe('refused');
            const before = readFileSync(fixture.file, 'utf8');
            const result = await window.evaluate(
              (request) => window.api.discardWorktree(request),
              {
                projectId: WORKSPACE_ID,
                worktreeId: WORKTREE_BRANCH,
                confirmation: description.confirmation,
                retainedArchives: action === 'retained-discard',
              },
            );
            expect(result.status).toBe('refused');
            expect(readFileSync(fixture.file, 'utf8')).toBe(before);
            expect(
              existsSync(
                action === 'aside-discard'
                  ? path.join(
                      path.dirname(fixture.checkout),
                      `.${WORKTREE_BRANCH}.discard-aside-live-checkout`,
                    )
                  : fixture.checkout,
              ),
            ).toBe(true);
            if (action === 'retained-discard')
              expect(JSON.parse(readFileSync(fixture.file, 'utf8')).phase).toBe(
                'captured',
              );
            else
              expect(JSON.parse(readFileSync(fixture.file, 'utf8')).state).toBe(
                'recovery-required',
              );
          }
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });
}

test('shared rail stays current during continuous snapshot invalidations', async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-rail-freshness-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    const row = window.locator(
      '[data-testid="worktree-row"][data-branch="demo-main"]',
    );
    await expect(row).toBeVisible();
    const setLabel = (revision) =>
      window.evaluate(
        (label) =>
          window.api.setWorktreeLabel({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
            label,
          }),
        `Snapshot revision ${revision}`,
      );
    await setLabel(0);
    await window.evaluate(() => window.api.invalidateDesktopSessionSnapshot());
    await expect(row).toContainText('Snapshot revision 0');

    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'desktop:session-snapshot';
      // Electron has no public handler getter; retain real captures, delaying only replies.
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing snapshot handler');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        const snapshot = await original(event, ...args);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return snapshot;
      });
      globalThis.__restoreRailFreshness = () => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
      };
    });
    await window.evaluate(() => {
      const state = { stales: 0, errors: [], running: true };
      state.unsubscribe = window.api.onDesktopSessionSnapshotStale(() => {
        state.stales += 1;
      });
      state.timer = setInterval(() => {
        window.api.invalidateDesktopSessionSnapshot().catch((error) => {
          state.errors.push(String(error));
        });
      }, 25);
      window.__railFreshness = state;
    });
    await expect
      .poll(() => window.evaluate(() => window.__railFreshness.stales))
      .toBeGreaterThanOrEqual(2);
    // Recovery also queries this channel on staleness, so total invokes cannot
    // attribute the rail's bounded rate; scratch coverage owns that assertion.
    for (let revision = 1; revision <= 3; revision += 1) {
      const stales = await window.evaluate(() => window.__railFreshness.stales);
      await setLabel(revision);
      await expect(row).toContainText(`Snapshot revision ${revision}`, {
        timeout: 5_000,
      });
      const stream = await window.evaluate(() => ({
        running: window.__railFreshness.running,
        stales: window.__railFreshness.stales,
      }));
      expect(stream.running).toBe(true);
      expect(stream.stales).toBeGreaterThan(stales);
    }

    await setLabel(4);
    await window.evaluate(async () => {
      clearInterval(window.__railFreshness.timer);
      window.__railFreshness.running = false;
      await window.api.invalidateDesktopSessionSnapshot();
    });
    // The final stale signal must still refresh the rail after the stream stops.
    await expect(row).toContainText('Snapshot revision 4', { timeout: 5_000 });
    const errors = await window.evaluate(() => window.__railFreshness.errors);
    expect(errors).toEqual([]);
  } finally {
    try {
      const window = electronApp.windows()[0];
      await window?.evaluate(() => {
        clearInterval(window.__railFreshness?.timer);
        window.__railFreshness?.unsubscribe();
      });
    } finally {
      try {
        await electronApp.evaluate(() => globalThis.__restoreRailFreshness?.());
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  }
});

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

// Exercises the work-entries:delete compatibility boundary through its real
// desktop control, durable archive, and restore flow (not just chat cleanup).
test('work-entries:delete and archived-containers:restore retain the standalone transcript', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-we-'));
  seedChatsSectionFixture(userDataDir, { worktreeCount: 0, chatEntryCount: 1 });
  const projectId = 'cowork-default';
  const entryId = 'entry-chat-001';
  const chatId = 'chat-entry-chat-001';
  const workspaceRoot = path.join(userDataDir, 'workspaces', projectId);
  const entriesFile = path.join(workspaceRoot, 'work-entries.json');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.showSidebar();
    const row = window.getByTestId(`sidebar-work-entry-${entryId}`);
    await expect(row).toBeVisible();
    const openArchive = async () => {
      await row.click({ button: 'right' });
      await window.getByTestId(`sidebar-work-entry-${entryId}-archive`).click();
      const dialog = window.getByTestId(
        `sidebar-work-entry-${entryId}-delete-dialog`,
      );
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const cancelled = await openArchive();
    await cancelled.getByRole('button', { name: /^Cancel/ }).click();
    await expect(cancelled).toHaveCount(0);
    await expect(row).toBeVisible();
    const confirmed = await openArchive();
    await confirmed
      .getByTestId(`sidebar-work-entry-${entryId}-confirm-delete`)
      .click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(() =>
        JSON.parse(readFileSync(entriesFile, 'utf8')).entries.some(
          (entry) => entry.id === entryId,
        ),
      )
      .toBe(false);
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          workspaceRoot,
          'archived-containers',
          entryId,
          'container.json',
        ),
        'utf8',
      ),
    );
    expect(manifest.lockedAt).toBeTruthy();
    expect(manifest.chatCount).toBe(1);
    await window
      .getByTestId(`sidebar-cowork-project-${projectId}-archived-link`)
      .click();
    await window.getByTestId(`archived-overview-open-${entryId}`).click();
    const viewer = window.getByTestId('cowork-archive-overlay');
    await expect(viewer).toBeVisible();
    await viewer.getByTestId('archived-restore').click();
    await expect(viewer).toHaveCount(0);
    const destination = await window.evaluate(
      ({ projectId, chatId }) =>
        window.api.workEntries.resolveChat({ projectId, chatId }),
      { projectId, chatId },
    );
    expect(destination.entryId).toBeTruthy();
    expect(destination.entryId).not.toBe(entryId);
    const transcript = await window.evaluate(
      ({ projectId, worktreeId, chatId }) =>
        window.api.chat.getTranscriptPage({ projectId, worktreeId, chatId }),
      { projectId, worktreeId: destination.entryId, chatId },
    );
    expect(JSON.stringify(transcript.messages)).toContain(
      'Chat topic 1 is ready for review.',
    );
    await expect(
      window.getByTestId(`sidebar-work-entry-${destination.entryId}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-6390 boundaries: work-entry-auto-delete:list replays Auto Delete attention;
// auto-archive:completed must never announce a refusal as successful removal.
// startAutoArchiveScheduler and startWorkEntryAutoDeleteScheduler share that outcome.
test('background removal attention remains reviewable across restart without another popup', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auto-delete-attention-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktrees = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'),
      'utf8',
    ),
  ).worktrees;
  const worktree = worktrees.find((row) => row.id === WORKTREE_BRANCH);
  const id = '00000000-0000-4000-8000-000000006390';
  writeFileSync(
    path.join(userDataDir, 'auto-delete-attention.json'),
    JSON.stringify({
      version: 1,
      incidents: [
        {
          attention: {
            kind: 'worktree',
            id,
            workspaceId: WORKSPACE_ID,
            worktreeId: WORKTREE_BRANCH,
            createdAt: worktree.createdAt,
            worktreeName: WORKTREE_BRANCH,
            reason: {
              code: 'external.worktree_recovery_required',
              intent: 'delete',
              stoppingPoint: { phase: 'teardown-script', state: 'failed' },
            },
          },
          operationIds: [],
        },
      ],
    }),
  );
  for (const restart of [false, true]) {
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const attention = window.getByTestId('auto-delete-attention');
      await expect(attention).toBeVisible();
      const popupAction = window.getByTestId(
        'auto-delete-attention-toast-review',
      );
      if (restart) await expect(popupAction).toHaveCount(0);
      else await expect(popupAction).toBeVisible();
      await attention.getByRole('button').click();
      const recovery = window.getByTestId('worktree-recovery-dialog');
      await expect(recovery).toBeVisible();
      await expect(recovery.getByTestId('worktree-recovery-reason')).toHaveText(
        "The cleanup script didn't finish.",
      );
      await expect(window.getByTestId('toast-stack-host')).not.toContainText(
        'Error invoking remote method',
      );
      expect(
        await sessionSnapshotListsWorktree(
          window,
          WORKSPACE_ID,
          WORKTREE_BRANCH,
        ),
      ).toBe(true);
      const snapshots = await window.evaluate(() =>
        window.api.workEntryAutoDelete.list(),
      );
      expect(
        snapshots.flatMap((row) => row.attention ?? []).map((row) => row.id),
      ).toContain(id);
    } finally {
      await closeCanopy(electronApp, userDataDir, { keepUserData: !restart });
    }
  }
});

// CAN-6389: the real main refusal reaches the shared host only after rollback.
test('a stopped removal opens recovery without finalizing the worktree', async () => {
  const { seedWorktreeRecoveryFixture } =
    await import('./seeders/worktreeRecoveryFixture.mjs');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-recovery-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeRecoveryFixture({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    const row = window
      .locator('[data-testid="worktree-row"][data-worktree-id="demo-main"]')
      .first();
    await expect(row).toBeVisible();
    await (
      await revealRowActions(window, row.getByTestId('worktree-archive-button'))
    ).click();
    const recovery = window.getByTestId('worktree-recovery-dialog');
    await expect(recovery).toBeVisible();
    await expect(recovery).toBeFocused();
    await expect(recovery.getByTestId('worktree-recovery-reason')).toHaveText(
      "Saving Git snapshots didn't finish.",
    );
    await expect(recovery.getByTestId('worktree-recovery-keep')).toHaveCount(0);
    await expect(
      recovery.getByRole('button', { name: 'Keep worktree', exact: true }),
    ).toHaveCount(0);
    const close = recovery.getByRole('button', { name: 'Close', exact: true });
    const lastAction = recovery.locator('[data-dialog-footer] button').last();
    await window.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await window.keyboard.press('Shift+Tab');
    await expect(lastAction).toBeFocused();
    await window.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expect(recovery).not.toContainText('Error invoking remote method');
    await expect(recovery).not.toContainText('Private persisted step detail');
    await expect(row).toBeVisible();
    expect(
      await sessionSnapshotListsWorktree(window, WORKSPACE_ID, WORKTREE_BRANCH),
    ).toBe(true);
    await recovery.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(row).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
