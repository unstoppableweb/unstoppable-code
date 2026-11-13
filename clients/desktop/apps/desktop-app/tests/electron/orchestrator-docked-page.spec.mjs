import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/**
 * With the Orchestrator page Labs experiment on, the Orchestrator opens from
 * its sidebar row as a page in the main window, in the normal chat layout:
 * the main window reports its content area over
 * `app-advisor:window-set-dock` (IPC_CHANNELS.appAdvisorWindowSetDock), and
 * the Orchestrator's own page is placed there, docked. Choosing another
 * sidebar destination leaves the page.
 */
test('the Orchestrator opens as a page docked in the main window', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await page.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'orchestrator-page',
        enabled: true,
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.api.experiments.getSnapshot()).experiments.some(
            (entry) => entry.id === 'orchestrator-page' && entry.enabled,
          ),
        ),
      )
      .toBe(true);

    await page.getByTestId('sidebar-nav-app-advisor').click();
    const slot = page.getByTestId('app-advisor-dock-slot');
    await expect(slot).toBeVisible({ timeout: 30_000 });

    let advisor;
    await expect
      .poll(
        async () => {
          advisor = electronApp
            .windows()
            .find((window) => window.url().includes('app-advisor'));
          return advisor
            ? await advisor
                .getByTestId('app-advisor-workspace-surface')
                .getAttribute('data-layout')
                .catch(() => null)
            : null;
        },
        { timeout: 30_000 },
      )
      .toBe('docked');

    // The Orchestrator's page sits over the slot, in the main window.
    const box = await slot.boundingBox();
    await expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow, webContents }) => {
            const contents = webContents
              .getAllWebContents()
              .find((candidate) => candidate.getURL().includes('app-advisor'));
            // The main window: the one whose own page is the app, not the
            // Orchestrator's (blank) shell window.
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().includes('index.html'),
            );
            if (!contents || !main) return null;
            const view = main.contentView.children.find(
              (child) => child.webContents?.id === contents.id,
            );
            if (!view) return null;
            const zoom = main.webContents.getZoomFactor();
            const bounds = view.getBounds();
            return {
              x: Math.round(bounds.x / zoom),
              y: Math.round(bounds.y / zoom),
              width: Math.round(bounds.width / zoom),
              visible: view.getVisible(),
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        visible: true,
      });
    await expect(advisor.getByTestId('app-advisor-nav')).toHaveCount(0);

    // Another destination leaves the page.
    await page
      .getByTestId('app-sidebar')
      .getByRole('button', { name: 'Workflows' })
      .first()
      .click();
    await expect(slot).toHaveCount(0, { timeout: 15_000 });
    expect(
      (await page.evaluate(() => window.api.appAdvisor.getWindowState())).open,
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
