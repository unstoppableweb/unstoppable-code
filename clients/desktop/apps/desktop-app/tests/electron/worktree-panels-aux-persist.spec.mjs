// Phase 9 — popped-out panel window persistence across app relaunches.
//
// The per-worktree `panel-layout.json` gains a `poppedOut` section: one entry
// per open auxiliary window carrying its serialized grid (leaves = tab
// metadata), live OS bounds, and merge-back source group. On relaunch the
// persistence bridge restores the main grid first and then re-creates each
// popped-out window, parent-orchestrated from the main renderer (doc 05
// §7.5 / doc 10 D4).
//
// Three flows under test (each is a two-launch keepUserData round-trip, the
// worktree-panels-persist.spec pattern):
//   1. pop out the terminal group, split INSIDE the aux window, relaunch —
//      the aux OS window re-opens with its split layout, and the main grid
//      still excludes the popped-out group;
//   2. pop out, then close the aux OS window (merge-back), relaunch — no aux
//      window re-opens and the merged tabs live in the main grid;
//   3. pop out, then ONLY resize/move the aux OS window (no layout mutation),
//      relaunch — the bounds watch scheduled a save, so the window re-opens
//      at the resized bounds (Linux saves native bounds, without CSD shadows).
//
// Windows exist headlessly (the aux override uses the same
// `show: !isE2eBuild()` posture as the main window; app-advisor multi-window
// precedent), so the relaunched aux window is directly observable.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

/** All panel ids present anywhere in the main worktree layout. */
async function mainLayoutPanelIds(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels.map((panel) => panel.panelId),
  );
}

/**
 * Polls for the auxiliary `about:blank` window. On relaunch the window opens
 * while the harness is still driving worktree selection, so waitForEvent can
 * miss it; polling `electronApp.windows()` covers both orders.
 */
async function waitForAuxPage(electronApp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const aux = electronApp
      .windows()
      .find((page) => page.url() === 'about:blank');
    if (aux) {
      return aux;
    }
    if (Date.now() > deadline) {
      throw new Error('auxiliary panel window did not open');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function hasAuxPage(electronApp) {
  return electronApp.windows().some((page) => page.url() === 'about:blank');
}

test('a popped-out window (with an inner split) is re-created on relaunch', async () => {
  test.setTimeout(240_000);

  // ---- Launch 1: pop out the terminal group and split inside the window. --
  const first = await seedPanelWorktree();
  const { userDataDir } = first;

  try {
    const auxWindowPromise = first.electronApp.waitForEvent('window');
    await first.window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect.poll(() => countLeaves(first.window)).toBe(2);

    // Split inside the aux window so the persisted aux grid is non-trivial.
    // Split lives in the overflow ("…") menu; open it first.
    await aux
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await aux
      .getByTestId(`panel-group-split-${DEFAULT_GROUP_IDS.terminal}-right`)
      .click();
    await expect(
      aux.locator('[data-testid^="panel-group-title-"]'),
    ).toHaveCount(2);

    // Renderer save debounce is 500ms; give it margin (persist-spec pattern).
    await first.window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2: the aux window must be re-created from `poppedOut`. ------
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });

  try {
    const aux = await waitForAuxPage(second.electronApp);

    const auxRoot = aux.getByTestId('panel-aux-window-root');
    await expect(auxRoot).toBeVisible();
    await expect(auxRoot).toHaveAttribute(
      'data-source-group-id',
      DEFAULT_GROUP_IDS.terminal,
    );
    // Chrome follows the local OS even when a window controls another host.
    const nativeFrame = process.platform === 'linux';
    const header = aux.getByTestId('panel-aux-window-top-bar');
    await expect(header).toHaveCSS(
      '-webkit-app-region',
      nativeFrame ? 'no-drag' : 'drag',
    );
    if (nativeFrame) await expect(header).toHaveCSS('padding-left', '8px');
    await expect(aux.getByTestId('panel-aux-window-source')).toBeVisible();
    await expect(aux.getByTestId('panel-aux-window-merge-back')).toBeVisible();

    // The inner split survived the relaunch: two groups — the terminal
    // singleton plus the empty split group (splits no longer clone).
    await expect(
      aux.locator('[data-testid^="panel-group-title-"]'),
    ).toHaveCount(2);
    await expect(aux.getByTestId('panel-content-terminal')).toHaveCount(1);

    // The main grid still excludes the popped-out group.
    await expect.poll(() => countLeaves(second.window)).toBe(2);
    const mainLayout = await getLayout(second.window);
    expect(collectLeaves(mainLayout.root).map((leaf) => leaf.groupId)).toEqual([
      DEFAULT_GROUP_IDS.chat,
      DEFAULT_GROUP_IDS.activity,
    ]);
    expect(await mainLayoutPanelIds(second.window)).not.toContain(
      DEFAULT_PANEL_IDS.terminal,
    );

    // Merging back after a restore works exactly like a live pop-out.
    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!String(error).includes('has been closed')) {
          throw error;
        }
      });
    await expect.poll(() => aux.isClosed()).toBe(true);
    await expect
      .poll(() => mainLayoutPanelIds(second.window))
      .toContain(DEFAULT_PANEL_IDS.terminal);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('bounds-only main and aux window resizes persist without any layout mutation', async () => {
  test.setTimeout(240_000);

  // Well inside any display so main's visible-display clamp
  // (hardenPanelAuxWindow) does not move the restored window.
  const RESIZED_BOUNDS = { x: 60, y: 60, width: 700, height: 500 };
  let MAIN_SIZE;
  // Keep the existing cross-platform placement/main-window tolerance. Linux
  // aux persistence must additionally round-trip the exact native size.
  const TOLERANCE_PX = 40;

  // ---- Launch 1: pop out, let the pop-out save land, then ONLY resize. ----
  // Neither launch may pin the harness's default viewport while this flow
  // measures native main-window resize persistence.
  const first = await seedPanelWorktree({ viewportSize: null });
  const { userDataDir } = first;
  let nativeAuxBounds;
  const layoutPath = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
    'panel-layout.json',
  );
  const savedAuxBounds = () =>
    JSON.parse(readFileSync(layoutPath, 'utf8')).poppedOut?.[0]?.bounds;

  try {
    const auxWindowPromise = first.electronApp.waitForEvent('window');
    await first.window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect.poll(() => countLeaves(first.window)).toBe(2);
    // Let the pop-out's own save (with the ORIGINAL bounds) land first, so
    // the relaunch genuinely proves the bounds-only change scheduled a save.
    await first.window.waitForTimeout(1500);

    // Resize/move the aux OS window. Crucially, commit NO layout mutation
    // afterwards — persistence must come from the bounds watch alone.
    await first.electronApp.evaluate(({ BrowserWindow }, bounds) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL() === 'about:blank') {
          win.setBounds(bounds);
        }
      }
    }, RESIZED_BOUNDS);
    const mainWindow = await first.electronApp.browserWindow(first.window);
    const mainWorkArea = await first.electronApp.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    );
    // Fit the size and the 60px origin inset inside the display. In
    // particular, macOS CI has a 1024x680 work area: a fixed 1100x720
    // fixture would be clamped on relaunch instead of round-tripping.
    MAIN_SIZE = await mainWindow.evaluate((win, workArea) => {
      const [minWidth, minHeight] = win.getMinimumSize();
      return {
        width: Math.max(minWidth, Math.min(1100, workArea.width - 60)),
        height: Math.max(minHeight, Math.min(720, workArea.height - 60)),
      };
    }, mainWorkArea);
    // Hidden native windows can start at (0, 0), above the macOS work area.
    // Give the size-persistence check a valid origin; the non-Linux
    // offscreen fallback is deliberately unchanged by this fix.
    await mainWindow.evaluate(
      (win, { size, workArea }) =>
        win.setBounds({ x: workArea.x + 60, y: workArea.y + 60, ...size }),
      { size: MAIN_SIZE, workArea: mainWorkArea },
    );
    await expect
      .poll(() =>
        mainWindow.evaluate((win) => {
          const { width, height } = win.getNormalBounds();
          return { width, height };
        }),
      )
      .toEqual(MAIN_SIZE);
    // Bounds-watch poll tick (500ms) + save debounce (500ms), with margin.
    await first.window.waitForTimeout(2500);
    const auxWindow = await first.electronApp.browserWindow(aux);
    nativeAuxBounds = await auxWindow.evaluate((win) => win.getNormalBounds());
    if (process.platform === 'linux') {
      // Compare the file on disk before quit, not the renderer's outerWidth /
      // outerHeight (GNOME CSD shadows can inflate both by 44px).
      // The panel-layout:save boundary must write the native dimensions that
      // window.open will consume on restore.
      await expect.poll(savedAuxBounds).toEqual(nativeAuxBounds);
    }
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2: the aux window re-opens at the resized bounds. -----------
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    // Do not let the harness replace the persisted main-window size.
    viewportSize: null,
  });

  try {
    const aux = await waitForAuxPage(second.electronApp);
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();

    const bounds = await second.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === 'about:blank',
      );
      return win ? win.getNormalBounds() : null;
    });
    expect(bounds).not.toBeNull();
    if (process.platform === 'linux') {
      expect(bounds.width).toBe(nativeAuxBounds.width);
      expect(bounds.height).toBe(nativeAuxBounds.height);
      // Hydration saves must not re-inflate the restored window either.
      await second.window.waitForTimeout(1500);
      await expect.poll(savedAuxBounds).toEqual(bounds);
    }
    // Wayland owns placement and may report (0, 0) for every window.
    // Size restoration is required on Linux; absolute placement is not.
    if (process.platform !== 'linux') {
      expect(Math.abs(bounds.x - RESIZED_BOUNDS.x)).toBeLessThanOrEqual(
        TOLERANCE_PX,
      );
      expect(Math.abs(bounds.y - RESIZED_BOUNDS.y)).toBeLessThanOrEqual(
        TOLERANCE_PX,
      );
    }
    expect(Math.abs(bounds.width - RESIZED_BOUNDS.width)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );
    expect(Math.abs(bounds.height - RESIZED_BOUNDS.height)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );

    const mainWindow = await second.electronApp.browserWindow(second.window);
    const mainBounds = await mainWindow.evaluate((win) =>
      win.getNormalBounds(),
    );
    expect(Math.abs(mainBounds.width - MAIN_SIZE.width)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );
    expect(Math.abs(mainBounds.height - MAIN_SIZE.height)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('closing the popped-out window persists the merge-back: no aux window on relaunch', async () => {
  test.setTimeout(240_000);

  // ---- Launch 1: pop out, then close the aux OS window (merge-back). ------
  const first = await seedPanelWorktree();
  const { userDataDir } = first;

  try {
    const auxWindowPromise = first.electronApp.waitForEvent('window');
    await first.window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect.poll(() => countLeaves(first.window)).toBe(2);
    // Let the popped-out save land first, so the relaunch genuinely proves
    // the LATER merge-back save overwrote it.
    await first.window.waitForTimeout(1500);

    // OS-close the aux window: close detection runs merge-back semantics.
    await first.electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL() === 'about:blank') {
          win.close();
        }
      }
    });
    await expect.poll(() => aux.isClosed()).toBe(true);
    await expect
      .poll(() => mainLayoutPanelIds(first.window), { timeout: 10_000 })
      .toContain(DEFAULT_PANEL_IDS.terminal);

    await first.window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // ---- Launch 2: no aux window; the merged tabs live in the main grid. ----
  const second = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
  });

  try {
    // The merged-back terminal tab restores its original group and placement.
    await expect
      .poll(() => mainLayoutPanelIds(second.window))
      .toContain(DEFAULT_PANEL_IDS.terminal);
    await expect.poll(() => countLeaves(second.window)).toBe(3);
    const mainLayout = await getLayout(second.window);
    expect(collectLeaves(mainLayout.root).map((leaf) => leaf.groupId)).toEqual([
      DEFAULT_GROUP_IDS.chat,
      DEFAULT_GROUP_IDS.terminal,
      DEFAULT_GROUP_IDS.activity,
    ]);
    // The terminal content is mounted in the re-created singleton group.
    await expect(
      second.window.getByTestId('panel-content-terminal'),
    ).toBeVisible();

    // And no auxiliary window was re-created (settle briefly first).
    await second.window.waitForTimeout(2000);
    expect(hasAuxPage(second.electronApp)).toBe(false);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});
