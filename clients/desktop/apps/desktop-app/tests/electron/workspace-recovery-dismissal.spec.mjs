import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function installBlockedRecoveryFixture(electronApp, recoverable = false) {
  // Stand in for a blocked daemon at the IPC seam; exercise the real host,
  // preload, polling and shared notice without changing recovery records.
  await electronApp.evaluate(({ ipcMain }, recoverable) => {
    const state = {
      status: {
        state: 'blocked',
        canRecover: recoverable,
        entries: recoverable
          ? [
              {
                id: 'commit:1',
                operation: 'Commit 1',
                detail: 'Operation details are available after restart.',
              },
            ]
          : [
              {
                id: 'reservation:held-create',
                operation: 'core.worktree.create',
                detail:
                  '{"operation":"core.worktree.create","errorName":"Error"}',
              },
            ],
      },
      prepares: 0,
      restarts: 0,
    };
    globalThis.workspaceRecoveryFixture = state;
    globalThis.workspaceRecoveryStatusReads = 0;
    for (const channel of [
      'w5-recovery:status',
      'w5-recovery:prepare',
      'app-window:restart',
    ])
      ipcMain.removeHandler(channel);
    ipcMain.handle('w5-recovery:status', () => {
      globalThis.workspaceRecoveryStatusReads += 1;
      return state.status;
    });
    ipcMain.handle('w5-recovery:prepare', () => {
      state.prepares += 1;
      state.status = {
        ...state.status,
        state: 'restart-required',
        canRecover: false,
      };
      return state.status;
    });
    ipcMain.handle('app-window:restart', () => {
      state.restarts += 1;
      return true;
    });
  }, recoverable);
}

test('dismissed workspace recovery returns for new entries and relaunch without changing recovery', async () => {
  const { electronApp: initialApp, userDataDir } = await launchCanopy();
  let electronApp = initialApp;
  try {
    let window = await electronApp.firstWindow();
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
    await installBlockedRecoveryFixture(electronApp);
    const readFixture = () =>
      electronApp.evaluate(() => globalThis.workspaceRecoveryFixture);
    const initial = await readFixture();
    await window.reload();
    let notice = window.getByTestId('w5-recovery-notice');
    await expect(notice).toBeVisible();
    await expect(notice.locator('li')).toHaveCount(1);
    // A failed create reservation is diagnostic only, not a cold-recovery target.
    await expect(notice.getByTestId('w5-recovery-start')).toHaveCount(0);
    await notice
      .getByRole('button', {
        name: 'Dismiss workspace recovery notice',
        exact: true,
      })
      .click();
    await expect(notice).toHaveCount(0);
    expect(await readFixture()).toEqual(initial);

    await electronApp.evaluate(() => {
      // The live controller grants recovery for a recoverable commit, never
      // for the lone core.worktree.create reservation above.
      globalThis.workspaceRecoveryFixture.status.entries.push({
        id: 'commit:1',
        operation: 'Commit 1',
        detail: 'Operation details are available after restart.',
      });
      globalThis.workspaceRecoveryFixture.status.canRecover = true;
    });
    // The running host's ordinary status refresh discovers the new entry.
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator('li')).toHaveCount(2);
    await expect(notice.getByTestId('w5-recovery-start')).toBeVisible();
    const withNewEntry = await readFixture();
    await notice
      .getByRole('button', {
        name: 'Dismiss workspace recovery notice',
        exact: true,
      })
      .click();
    await expect(notice).toHaveCount(0);
    expect(await readFixture()).toEqual(withNewEntry);

    // q-30: acknowledging both records also hides the remaining commit alone.
    const readsBeforeRemoval = await electronApp.evaluate(() => {
      globalThis.workspaceRecoveryFixture.status.entries.shift();
      return globalThis.workspaceRecoveryStatusReads;
    });
    // Observe two ordinary polls so this cannot pass before the removal is read.
    await expect
      .poll(
        () =>
          electronApp.evaluate(() => globalThis.workspaceRecoveryStatusReads),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(readsBeforeRemoval + 1);
    await expect(notice).toHaveCount(0);
    const recoverable = await readFixture();
    expect(recoverable).toEqual({
      ...withNewEntry,
      status: {
        ...withNewEntry.status,
        entries: [withNewEntry.status.entries[1]],
      },
    });

    // A renderer reload restores the same recovery action without preparing it.
    await window.reload();
    await expect(notice.getByTestId('w5-recovery-start')).toBeVisible();
    expect(await readFixture()).toEqual(recoverable);
    await notice
      .getByRole('button', {
        name: 'Dismiss workspace recovery notice',
        exact: true,
      })
      .click();
    await expect(notice).toHaveCount(0);

    // Dismissal lasts only in renderer memory. Relaunch with the same profile
    // and unchanged blocked IDs to recover the Restart for recovery action.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    await expect(window.getByTestId('app-sidebar')).toBeVisible();
    await installBlockedRecoveryFixture(electronApp, true);
    await window.reload();
    notice = window.getByTestId('w5-recovery-notice');
    await expect(notice).toBeVisible();
    await expect(notice.locator('li')).toHaveCount(1);
    expect(await readFixture()).toEqual(recoverable);
    await notice.getByTestId('w5-recovery-start').click();
    await expect.poll(async () => (await readFixture()).restarts).toBe(1);
    expect((await readFixture()).prepares).toBe(1);
    expect((await readFixture()).status.entries).toHaveLength(1);
    await expect(notice).toContainText('Workspace recovery needs a restart');
    await expect(notice.getByTestId('w5-recovery-start')).toHaveCount(0);
    await notice
      .getByRole('button', {
        name: 'Dismiss workspace recovery notice',
        exact: true,
      })
      .click();
    await expect(notice).toHaveCount(0);
    expect((await readFixture()).prepares).toBe(1);
    expect((await readFixture()).status.state).toBe('restart-required');
    expect((await readFixture()).status.entries).toEqual(
      recoverable.status.entries,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
