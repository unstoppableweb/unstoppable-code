// Phase 8 — pull a panel group out into a standalone OS window (doc 05 §8
// Approach A: an opener-controlled `about:blank` child document rendered via
// createPortal from the main React root).
//
// Flow under test:
//   1. pop out the default terminal group via its overflow menu
//      (`panel-group-menu-group-terminal` -> `panel-group-pop-out-
//      group-terminal`) — main's setWindowOpenHandler
//      narrowly allows the `about:blank` + `canopy-panel-aux:` frame-name
//      open, and Playwright observes the new Electron window;
//   2. the aux window hosts `panel-aux-window-root` with the terminal
//      content frame, the aux-labeled grid, and NO preload surface
//      (`window.api` undefined — the child document runs no app code);
//   3. the aux grid is a full grid: splitting via its own chrome creates a
//      second group INSIDE the aux window;
//   4. merge back via `panel-aux-window-merge-back`: the OS window closes
//      and every aux tab returns to its original group and placement.
//
// Focus caveat (doc 13 §4.1): under the headless E2E build windows are never
// shown/OS-focused (the aux override uses the same `show: !isE2eBuild()`
// posture as the main window), so this spec asserts DOM/layout state, not
// `document.hasFocus()`. Focus behavior needs a HEADED run to observe.
//
// No-remount handoff coverage: panel CONTENT now lives in a stable per-panel
// container (`data-panel-content-host`) owned by PanelContentRoot; grid
// groups ADOPT the container, so pull-out/merge-back re-parent the SAME DOM
// node across OS windows instead of remounting a fresh subtree. Asserted
// three ways: runtime attributes set on the container + the terminal surface
// before the pop-out, a JS expando on the xterm root (an expando cannot
// survive any recreate), and live xterm output that keeps rendering across
// both window hops without a respawn.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  seedPanelWorktree,
  spawnPanelTerminal,
} from './panelHarness.mjs';

/** All panel ids present anywhere in the main worktree layout. */
async function mainLayoutPanelIds(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels.map((panel) => panel.panelId),
  );
}

/** Sentinel echoed into the spawned shell before the pull-out. */
const XTERM_PROBE = 'canopy-noremount-probe';

/**
 * Reads the DOM-identity markers from whichever document `page` addresses.
 * All three values were written pre-pop-out in the MAIN window; finding them
 * intact proves the very same nodes were adopted (attributes travel with the
 * element, and the expando lives on the JS wrapper object itself — a
 * remounted xterm would produce a fresh element without it).
 */
function readIdentityMarkers(page) {
  return page.evaluate(() => {
    const host = document.querySelector(
      '[data-panel-content-host="panel-terminal"]',
    );
    const surface = host?.querySelector(
      '[data-testid="terminal-panel-surface"]',
    );
    // Document-wide on purpose: exactly one xterm DOM root exists for the
    // spawned terminal (terminal-instances caches it). The identity claim is
    // about the xterm DOM itself, not which panel host currently parents it.
    const xterm = document.querySelector('.xterm');
    return {
      containerMarker: host?.getAttribute('data-e2e-identity') ?? null,
      surfaceMarker: surface?.getAttribute('data-e2e-identity') ?? null,
      xtermExpando: xterm?.__canopyIdentityMarker ?? null,
    };
  });
}

const EXPECTED_IDENTITY = {
  containerMarker: 'terminal-container',
  surfaceMarker: 'terminal-panel-surface',
  xtermExpando: 'no-remount',
};

function normalizeTerminalText(text) {
  return text.replace(/\s+/g, '');
}

test('history recovery exposes saved sessions without reloading or reopening closed tabs', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Keep the real IPC client, observer, terminal store and panel host. Only
    // the history transport is controlled, including historical byte replay.
    await electronApp.evaluate(({ ipcMain }) => {
      const loadChannel = 'terminal:load-worktree-state';
      const attachChannel = 'terminal:attach';
      const load = ipcMain._invokeHandlers.get(loadChannel);
      const attach = ipcMain._invokeHandlers.get(attachChannel);
      if (typeof load !== 'function' || typeof attach !== 'function')
        throw new Error('Expected the terminal history handlers');
      const fixture = {
        available: false,
        ids: ['recovered-first', 'recovered-second'],
        unavailableLoads: 0,
        recoveredLoads: 0,
      };
      globalThis.__terminalHistoryRecovery = fixture;
      const session = (id) => ({
        id,
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/',
        createdAt: 1,
        title: id,
      });
      ipcMain.removeHandler(loadChannel);
      ipcMain.handle(loadChannel, async (event, request) => {
        const original = await load(event, request);
        if (
          request.projectId !== 'demo-ts-pnpm-vite' ||
          request.worktreeId !== 'demo-main'
        )
          return original;
        const history = fixture.available
          ? { status: 'available' }
          : { status: 'unavailable', reason: 'background_service' };
        if (request.historyStatusOnly)
          return { ...original, history, historyRefreshSupported: true };
        if (!fixture.available) {
          fixture.unavailableLoads += 1;
          return { ...original, history };
        }
        fixture.recoveredLoads += 1;
        return {
          ...original,
          history,
          groups: fixture.ids.map((id) => ({
            id: `legacy-${id}`,
            terminalIds: [id],
            focusedTerminalId: id,
            splitSizes: [1],
          })),
          terminals: fixture.ids.map((id) => ({
            session: session(id),
            scrollbackLines: [`saved-${id}`],
            exitCode: 0,
            signal: null,
          })),
          liveTerminalIds: [],
        };
      });
      ipcMain.removeHandler(attachChannel);
      ipcMain.handle(attachChannel, (event, request) => {
        if (!fixture.ids.includes(request.terminalId))
          return attach(event, request);
        const replay = new TextEncoder().encode(
          `saved-${request.terminalId}\r\n`,
        );
        return {
          session: session(request.terminalId),
          replay,
          seq: replay.length,
        };
      });
    });
    // Passive expansion must leave the empty placeholder empty, not spawn.
    await window.evaluate(() => {
      window.__canopyPanelTestApi.collapseGroup('group-terminal', false);
      document
        .querySelector('[data-panel-content-host="panel-terminal"]')
        ?.setAttribute('data-recovery-host', 'same-host');
    });
    await expect(
      window.getByRole('button', { name: 'Start terminal', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__terminalHistoryRecovery.unavailableLoads,
        ),
      )
      .toBeGreaterThan(0);
    const before = await getLayout(window);
    expect(
      collectLeaves(before.root)
        .flatMap((leaf) => leaf.panels)
        .filter((panel) => panel.kind === 'terminal')
        .map((panel) => panel.instance?.terminalId),
    ).toEqual([undefined]);

    await electronApp.evaluate(() => {
      globalThis.__terminalHistoryRecovery.available = true;
    });
    const first = window.locator('[data-panel-content-host="panel-terminal"]');
    await expect(first.getByTestId('terminal-pane')).toBeVisible({
      timeout: 20_000,
    });
    await expect(first).toHaveAttribute('data-recovery-host', 'same-host');
    await expect
      .poll(() => first.innerText().then(normalizeTerminalText))
      .toContain('saved-recovered-first');
    await expect(
      window.getByTestId('panel-tab-panel-terminal-recovered-second'),
    ).toBeVisible();
    const recovered = await getLayout(window);
    const recoveredTabs = collectLeaves(recovered.root)
      .flatMap((leaf) => leaf.panels)
      .filter((panel) => panel.kind === 'terminal');
    expect(recoveredTabs.map((panel) => panel.instance?.terminalId)).toEqual([
      'recovered-first',
      'recovered-second',
    ]);
    expect(recoveredTabs[0].panelId).toBe(DEFAULT_PANEL_IDS.terminal);
    await first.locator('.xterm').evaluate((node) => {
      node.__recoveryIdentity = 'same-xterm';
    });
    await first.getByTestId('terminal-panel-surface').evaluate((node) => {
      node.__recoveryIdentity = 'same-surface';
    });

    await window
      .getByTestId('panel-tab-panel-terminal-recovered-second')
      .hover();
    await window
      .getByTestId('panel-tab-close-panel-terminal-recovered-second')
      .click();
    await expect(
      window.getByTestId('panel-tab-panel-terminal-recovered-second'),
    ).toHaveCount(0);
    await electronApp.evaluate(() => {
      globalThis.__terminalHistoryRecovery.available = false;
    });
    await expect(
      first.getByTestId('terminal-history-unavailable-notice'),
    ).toBeVisible({ timeout: 20_000 });
    await electronApp.evaluate(() => {
      globalThis.__terminalHistoryRecovery.ids.push('recovered-third');
      globalThis.__terminalHistoryRecovery.available = true;
    });
    await expect(
      window.getByTestId('panel-tab-panel-terminal-recovered-third'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      first.getByTestId('terminal-history-unavailable-notice'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('panel-tab-panel-terminal-recovered-second'),
    ).toHaveCount(0);
    expect(
      await first.locator('.xterm').evaluate((node) => node.__recoveryIdentity),
    ).toBe('same-xterm');
    expect(
      await first
        .getByTestId('terminal-panel-surface')
        .evaluate((node) => node.__recoveryIdentity),
    ).toBe('same-surface');
    await expect
      .poll(() => first.innerText().then(normalizeTerminalText))
      .toContain('saved-recovered-first');
    // The newly discovered tab is reachable, not merely present in a store.
    await window
      .getByTestId('panel-tab-panel-terminal-recovered-third')
      .click();
    await expect
      .poll(() =>
        window
          .locator('[data-panel-content-host="panel-terminal-recovered-third"]')
          .innerText()
          .then(normalizeTerminalText),
      )
      .toContain('saved-recovered-third');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Real spawn, renderer and panel host. The first in-scope spawn after this
 * call flips history to available, so the next history refresh lists the new
 * shell, and main holds that spawn's reply until the test releases it: the
 * overlap a slow daemon spawn reply allows.
 */
async function installSpawnRecoveryRace(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const loadChannel = 'terminal:load-worktree-state';
    const spawnChannel = 'terminal:spawn';
    const killChannel = 'terminal:kill';
    const load = ipcMain._invokeHandlers.get(loadChannel);
    const spawn = ipcMain._invokeHandlers.get(spawnChannel);
    const kill = ipcMain._invokeHandlers.get(killChannel);
    if (
      typeof load !== 'function' ||
      typeof spawn !== 'function' ||
      typeof kill !== 'function'
    )
      throw new Error('Expected the terminal spawn and history handlers');
    const fixture = {
      available: false,
      spawned: null,
      unavailableLoads: 0,
      releaseSpawn: false,
      releasedByTest: false,
      killed: [],
    };
    globalThis.__terminalAddRecoveryRace = fixture;
    const inScope = (request) =>
      request.projectId === 'demo-ts-pnpm-vite' &&
      request.worktreeId === 'demo-main';
    ipcMain.removeHandler(loadChannel);
    ipcMain.handle(loadChannel, async (event, request) => {
      const original = await load(event, request);
      if (!inScope(request)) return original;
      const history = fixture.available
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'background_service' };
      if (request.historyStatusOnly)
        return { ...original, history, historyRefreshSupported: true };
      if (!fixture.available) {
        fixture.unavailableLoads += 1;
        return { ...original, history };
      }
      const shell = fixture.spawned;
      if (shell === null) return { ...original, history };
      const listed = original.terminals.some(
        (terminal) => terminal.session.id === shell.id,
      );
      const grouped = original.groups.some((group) =>
        group.terminalIds.includes(shell.id),
      );
      return {
        ...original,
        history,
        groups: grouped
          ? original.groups
          : [
              ...original.groups,
              {
                id: 'recovery-race-group',
                terminalIds: [shell.id],
                focusedTerminalId: shell.id,
                splitSizes: [1],
              },
            ],
        terminals: listed
          ? original.terminals
          : [
              ...original.terminals,
              {
                session: shell,
                scrollbackLines: [],
                exitCode: null,
                signal: null,
              },
            ],
        liveTerminalIds: [
          ...original.liveTerminalIds.filter((id) => id !== shell.id),
          shell.id,
        ],
      };
    });
    ipcMain.removeHandler(spawnChannel);
    ipcMain.handle(spawnChannel, async (event, request) => {
      const session = await spawn(event, request);
      if (!inScope(request) || fixture.spawned !== null) return session;
      fixture.spawned = session;
      fixture.available = true;
      const deadline = Date.now() + 30_000;
      while (!fixture.releaseSpawn && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      fixture.releasedByTest = fixture.releaseSpawn;
      return session;
    });
    ipcMain.removeHandler(killChannel);
    ipcMain.handle(killChannel, (event, request) => {
      fixture.killed.push(request.terminalId);
      return kill(event, request);
    });
  });
}

/**
 * Waits, with the spawn reply still held, until the recovered load has put
 * the new shell in the renderer's terminal store (nothing else can before the
 * reply), checks the passive pass left it unbound, then releases the reply.
 */
async function releaseSpawnAfterRendererRecovery(electronApp, window) {
  const spawnedId = () =>
    electronApp.evaluate(
      () => globalThis.__terminalAddRecoveryRace.spawned?.id ?? null,
    );
  await expect.poll(spawnedId, { timeout: 20_000 }).not.toBeNull();
  const shellId = await spawnedId();
  await expect
    .poll(
      () =>
        window.evaluate(
          () =>
            window.__canopyPanelTestApi.getTerminalPlacementState().sessionIds,
        ),
      { timeout: 20_000 },
    )
    .toContain(shellId);
  // That store update scheduled the passive reconcile as a zero-delay timer.
  const held = await window.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return window.__canopyPanelTestApi.getTerminalPlacementState();
  });
  expect(held.bindings.map((binding) => binding.terminalId)).not.toContain(
    shellId,
  );
  await electronApp.evaluate(() => {
    globalThis.__terminalAddRecoveryRace.releaseSpawn = true;
  });
  return shellId;
}

/** One binding across the main and auxiliary layouts, and it is in main. */
async function expectBoundOnceInMainLayout(window, shellId) {
  const { bindings } = await window.evaluate(() =>
    window.__canopyPanelTestApi.getTerminalPlacementState(),
  );
  expect(
    bindings
      .filter((binding) => binding.terminalId === shellId)
      .map((binding) => binding.layoutKey),
  ).toEqual(['demo-ts-pnpm-vite/demo-main']);
}

async function waitForHistoryOutage(electronApp) {
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          () => globalThis.__terminalAddRecoveryRace.unavailableLoads,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
}

async function expectSpawnSurvived(electronApp, shellId) {
  const race = await electronApp.evaluate(
    () => globalThis.__terminalAddRecoveryRace,
  );
  expect(race.releasedByTest).toBe(true);
  expect(race.killed).not.toContain(shellId);
}

test('Add Terminal keeps its shell when history recovery publishes it first', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await installSpawnRecoveryRace(electronApp);
    await window.evaluate(() => {
      window.__canopyPanelTestApi.collapseGroup('group-terminal', false);
    });
    await expect(
      window.getByRole('button', { name: 'Start terminal', exact: true }),
    ).toBeVisible();
    await waitForHistoryOutage(electronApp);

    await window
      .getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await window.getByTestId('panel-add-menu-terminal-submenu').click();
    await window.getByTestId('panel-add-menu-item-terminal').click();

    const shellId = await releaseSpawnAfterRendererRecovery(
      electronApp,
      window,
    );
    const tab = window.getByTestId(`panel-tab-panel-terminal-${shellId}`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await expectSpawnSurvived(electronApp, shellId);
    await expect(window.getByText('Unable to open Terminal')).toHaveCount(0);
    // Bound exactly once, in the requested group, and the shell is live.
    const layout = await getLayout(window);
    const bindings = collectLeaves(layout.root).flatMap((leaf) =>
      leaf.panels
        .filter((panel) => panel.instance?.terminalId === shellId)
        .map(() => leaf.groupId),
    );
    expect(bindings).toEqual([DEFAULT_GROUP_IDS.terminal]);
    await expectBoundOnceInMainLayout(window, shellId);
    await tab.click();
    const pane = window.locator(
      `[data-panel-content-host="panel-terminal-${shellId}"] [data-testid="terminal-pane"]`,
    );
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.click();
    // Joined only by the shell, so PTY input echo cannot satisfy the check.
    await window.keyboard.type(
      "printf '%s%s\\n' 'canopy-add-' 'terminal-survived'\n",
    );
    await expect
      .poll(() => pane.innerText().then(normalizeTerminalText), {
        timeout: 20_000,
      })
      .toContain('canopy-add-terminal-survived');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('composer command stays in the source layout when history recovery publishes its shell first', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // With the only terminal group popped out, a passive placement would put
    // the composer's shell in the auxiliary window.
    await spawnPanelTerminal(window);
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('terminal-pane')).toHaveCount(1);
    await expect(window.getByTestId('terminal-pane')).toHaveCount(0);

    await installSpawnRecoveryRace(electronApp);
    await waitForHistoryOutage(electronApp);

    const chatPanel = window.locator(
      '[data-testid="panel-content-chat"]:visible',
    );
    await chatPanel
      .locator('[data-chat-textarea][contenteditable="true"]')
      .fill("!printf '%s%s\\n' 'canopy-composer-' 'recovery-race'");
    await chatPanel
      .getByRole('button', { name: 'Run terminal command', exact: true })
      .click();

    const shellId = await releaseSpawnAfterRendererRecovery(
      electronApp,
      window,
    );
    const mainTerminal = window.locator(
      `[data-panel-content-host="panel-terminal-${shellId}"] [data-testid="terminal-pane"]`,
    );
    await expect(mainTerminal).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => mainTerminal.innerText().then(normalizeTerminalText), {
        timeout: 20_000,
      })
      .toContain('canopy-composer-recovery-race');
    await expect(aux.getByTestId('terminal-pane')).toHaveCount(1);
    await expectSpawnSurvived(electronApp, shellId);
    await expectBoundOnceInMainLayout(window, shellId);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('terminal command stays in the source layout when another terminal is popped out', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await spawnPanelTerminal(window);
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('terminal-pane')).toBeVisible();
    await expect(window.getByTestId('terminal-pane')).toHaveCount(0);

    const chatPanel = window.locator(
      '[data-testid="panel-content-chat"]:visible',
    );
    const composer = chatPanel.locator(
      '[data-chat-textarea][contenteditable="true"]',
    );
    await composer.fill('!echo canopy-main-terminal-command');
    await chatPanel
      .getByRole('button', { name: 'Run terminal command', exact: true })
      .click();

    const mainTerminal = window.getByTestId('terminal-pane');
    await expect(mainTerminal).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => mainTerminal.innerText().then(normalizeTerminalText), {
        timeout: 20_000,
      })
      .toContain('canopy-main-terminal-command');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('new terminal from an aux window stays in that window when main also has one', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await spawnPanelTerminal(window);
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('terminal-pane')).toHaveCount(1);

    const chatPanel = window.locator(
      '[data-testid="panel-content-chat"]:visible',
    );
    await chatPanel
      .locator('[data-chat-textarea][contenteditable="true"]')
      .fill('!echo canopy-main-terminal-ready');
    await chatPanel
      .getByRole('button', { name: 'Run terminal command', exact: true })
      .click();
    await expect(window.getByTestId('terminal-pane')).toBeVisible({
      timeout: 20_000,
    });

    // Ctrl+T in the terminal body belongs to the shell on Linux/Windows.
    // Focus its tab chrome to request a new terminal in the owning group.
    await aux.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.terminal}`).focus();
    await aux.keyboard.press(
      process.platform === 'darwin' ? 'Meta+t' : 'Control+t',
    );

    await expect(aux.getByTestId('terminal-pane')).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(window.getByTestId('terminal-pane')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rapid new-terminal shortcuts are serialized without dropping a request', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const firstPane = await spawnPanelTerminal(window);
    await firstPane.click();

    await window.evaluate((isMac) => {
      const shortcut = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 't',
            code: 'KeyT',
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
          }),
        );
      shortcut();
      shortcut();
    }, process.platform === 'darwin');

    await expect(window.getByTestId('terminal-pane')).toHaveCount(3, {
      timeout: 20_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pull out the terminal group, split inside the aux window, merge back', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    expect(await countLeaves(window)).toBe(3);

    // ---- 0. Spawn a live terminal and mark the content DOM. ---------------
    // A real shell + echoed sentinel makes the no-remount contract
    // observable end-to-end: the xterm buffer only survives the window hops
    // if the exact same xterm DOM/instance is re-parented (no respawn).
    const pane = await spawnPanelTerminal(window);
    await pane.click();
    // Wait for the shell prompt before typing — keystrokes sent while the
    // shell is still initializing can be dropped by the fresh PTY.
    await expect
      .poll(() => pane.innerText(), { timeout: 20_000 })
      .toMatch(/[$%>#]/);
    await window.keyboard.type(`echo ${XTERM_PROBE}`, { delay: 25 });
    await expect
      .poll(() => pane.innerText().then(normalizeTerminalText), {
        timeout: 10_000,
      })
      .toContain(`echo${XTERM_PROBE}`);
    await window.keyboard.press('Enter');
    await expect
      .poll(() => pane.innerText().then(normalizeTerminalText), {
        timeout: 20_000,
      })
      .toContain(XTERM_PROBE);

    await window.evaluate(() => {
      const host = document.querySelector(
        '[data-panel-content-host="panel-terminal"]',
      );
      if (!host) {
        throw new Error('terminal content container not found');
      }
      const surface = host.querySelector(
        '[data-testid="terminal-panel-surface"]',
      );
      const xterm = host.querySelector('.xterm');
      if (!surface || !xterm) {
        throw new Error('terminal surface / xterm root not found');
      }
      host.setAttribute('data-e2e-identity', 'terminal-container');
      surface.setAttribute('data-e2e-identity', 'terminal-panel-surface');
      xterm.__canopyIdentityMarker = 'no-remount';
    });

    // ---- 1. Pop out via the overflow ("…") menu. -------------------------
    const auxWindowPromise = electronApp.waitForEvent('window');
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await window
      .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    const aux = await auxWindowPromise;

    // ---- 2. Aux window contents. ------------------------------------------
    const auxRoot = aux.getByTestId('panel-aux-window-root');
    await expect(auxRoot).toBeVisible();
    await expect(auxRoot).toHaveAttribute(
      'data-source-group-id',
      DEFAULT_GROUP_IDS.terminal,
    );
    await expect(aux.getByTestId('panel-grid-root')).toHaveAttribute(
      'data-window',
      'aux',
    );
    await expect(aux.getByTestId('panel-content-terminal')).toBeVisible();

    // Explicit native-scrollbar activity is document-scoped. The pulled-out
    // panel is rendered into the auxiliary document, so scrolling its real
    // xterm viewport must reveal that viewport there rather than relying on
    // listeners installed in the opener document.
    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'scroll';
    });
    await expect
      .poll(() =>
        aux.evaluate(
          () => document.documentElement.dataset.scrollbarBehavior ?? null,
        ),
      )
      .toBe('scroll');
    const auxNativeScroller = aux.locator('.xterm-viewport').first();
    await expect(auxNativeScroller).toBeVisible();
    await auxNativeScroller.evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(auxNativeScroller).toHaveAttribute(
      'data-native-scrollbar-scrolling',
      'true',
    );

    // The child document runs NO app code of its own: no preload bridge and
    // an opener-injected `script-src 'none'` CSP.
    expect(await aux.evaluate(() => typeof window.api)).toBe('undefined');
    expect(
      await aux.evaluate(
        () =>
          document.querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.content ?? null,
      ),
    ).toBe("script-src 'none'");

    // Focus sequencing (Phase 9, doc 12 §2): DOM focus moved into the aux
    // window — the active group's roving tab, falling back to the merge-back
    // button. DOM focus (activeElement) is observable headlessly even though
    // OS window focus is not.
    await expect
      .poll(() =>
        aux.evaluate(() => {
          const el = document.activeElement;
          if (!el) {
            return null;
          }
          return el.getAttribute('role') === 'tab'
            ? 'tab'
            : (el.getAttribute('data-testid') ?? el.tagName.toLowerCase());
        }),
      )
      .toMatch(/^(tab|panel-aux-window-merge-back)$/);

    // The main layout lost the terminal group (2 leaves, no group-terminal).
    await expect.poll(() => countLeaves(window)).toBe(2);
    const mainLayout = await getLayout(window);
    expect(collectLeaves(mainLayout.root).map((leaf) => leaf.groupId)).toEqual([
      DEFAULT_GROUP_IDS.chat,
      DEFAULT_GROUP_IDS.activity,
    ]);

    // ---- 2b. No-remount proof in the AUX window. ---------------------------
    // The SAME content container / terminal surface / xterm root DOM nodes
    // were adopted into the child document: every pre-pop-out marker —
    // including the JS expando, which no recreate can reproduce — is intact.
    await expect
      .poll(() => readIdentityMarkers(aux))
      .toEqual(EXPECTED_IDENTITY);
    // And the container node is GONE from the main document (moved, not
    // copied).
    expect(
      await window.evaluate(
        () =>
          document.querySelector(
            '[data-panel-content-host="panel-terminal"]',
          ) !== null,
      ),
    ).toBe(false);
    // The live xterm buffer kept rendering across the hop — no respawn: the
    // sentinel is still on screen and exactly one terminal pane exists.
    await expect(aux.getByTestId('terminal-pane')).toHaveCount(1);
    await expect
      .poll(() =>
        aux
          .getByTestId('terminal-pane')
          .innerText()
          .then(normalizeTerminalText),
      )
      .toContain(XTERM_PROBE);

    // ---- 3. Split INSIDE the aux window via its own overflow menu. ---------
    await aux
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await aux
      .getByTestId(`panel-group-split-${DEFAULT_GROUP_IDS.terminal}-right`)
      .click();
    await expect(
      aux.locator('[data-testid^="panel-group-title-"]'),
    ).toHaveCount(2);

    // ---- 4. Merge back. -----------------------------------------------------
    // The click handler closes the aux window as part of merge-back, so
    // Playwright's click action can lose its target mid-action; that
    // specific rejection IS the expected outcome (the close is asserted
    // right below).
    await aux
      .getByTestId('panel-aux-window-merge-back')
      .click()
      .catch((error) => {
        if (!String(error).includes('has been closed')) {
          throw error;
        }
      });
    await expect.poll(() => aux.isClosed()).toBe(true);

    // The terminal tab returns to its original group and placement, restoring
    // the main grid to 3 leaves. (The aux split created an EMPTY group — no
    // clone — so exactly one terminal tab makes the round trip home.)
    await expect
      .poll(() => mainLayoutPanelIds(window))
      .toContain(DEFAULT_PANEL_IDS.terminal);
    expect(await countLeaves(window)).toBe(3);
    const layoutAfter = await getLayout(window);
    expect(collectLeaves(layoutAfter.root).map((leaf) => leaf.groupId)).toEqual(
      [
        DEFAULT_GROUP_IDS.chat,
        DEFAULT_GROUP_IDS.terminal,
        DEFAULT_GROUP_IDS.activity,
      ],
    );
    const terminalTabs = collectLeaves(layoutAfter.root)
      .flatMap((leaf) => leaf.panels)
      .filter((panel) => panel.kind === 'terminal');
    expect(terminalTabs).toHaveLength(1);
    // The merged-back terminal content renders again in the MAIN window.
    await expect(window.getByTestId('panel-content-terminal')).toHaveCount(1);

    // ---- 4b. No-remount proof back in the MAIN window. --------------------
    // The same DOM nodes made the round trip home: container + surface
    // attributes and the xterm expando all survived pull-out AND merge-back.
    await expect
      .poll(() => readIdentityMarkers(window))
      .toEqual(EXPECTED_IDENTITY);
    // The original shell is still alive and rendering its buffer — exactly
    // one xterm DOM root exists (no duplicate/recreated instance) and the
    // sentinel echoed BEFORE the pull-out is still rendered, with no respawn.
    await expect(window.locator('.xterm')).toHaveCount(1);
    await expect
      .poll(() =>
        window.locator('.xterm').innerText().then(normalizeTerminalText),
      )
      .toContain(XTERM_PROBE);

    // Focus returned to the restored group in the main window (its roving tab;
    // deferred one macrotask after adoption).
    await expect
      .poll(() =>
        window.evaluate(() => {
          const el = document.activeElement;
          return el && el.closest('[data-testid^="panel-group-"]')
            ? (el.getAttribute('role') ?? el.tagName.toLowerCase())
            : null;
        }),
      )
      .toBe('tab');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pop-out is rejected for a group containing a window-bound browser tab', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Add a browser tab (window-bound native content) to the activity group
    // through the graduated tab-strip Add menu.
    await window
      .getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(window.getByTestId('panel-add-menu')).toBeVisible();
    await window.getByTestId('panel-add-menu-item-browser').click();
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        const activityLeaf = collectLeaves(layout.root).find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
        );
        return activityLeaf?.panels.map((panel) => panel.kind) ?? [];
      })
      .toContain('browser');
    const layout = await getLayout(window);
    const activityLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
    );
    expect(activityLeaf.panels.map((panel) => panel.kind)).toContain('browser');

    // The pop-out item is not offered in the browser group's overflow menu…
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.activity}`)
      .click();
    await expect(
      window.getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.activity}`),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    // …while poppable groups still offer it.
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.terminal}`)
      .click();
    await expect(
      window.getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.terminal}`),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    // The test-API path rejects too, with no new window and no layout change.
    const windowsBefore = electronApp.windows().length;
    const rejection = await window.evaluate(async (groupId) => {
      try {
        await window.__canopyPanelTestApi.popOutPanel(groupId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, DEFAULT_GROUP_IDS.activity);
    expect(rejection).toContain('rejected');
    expect(electronApp.windows().length).toBe(windowsBefore);
    expect(await countLeaves(window)).toBe(3);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing the aux OS window directly merges the tabs back', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Pop out via the test API (same store path as the chrome button).
    const auxWindowPromise = electronApp.waitForEvent('window');
    const auxWindowId = await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      DEFAULT_GROUP_IDS.terminal,
    );
    expect(auxWindowId).toBeTruthy();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect.poll(() => countLeaves(window)).toBe(2);

    // Close the OS window directly from the main process (the equivalent of
    // the user hitting the window's close button, NOT the merge-back
    // affordance): the renderer's pagehide/close-poll detection must run
    // merge-back semantics for the orphaned tabs.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL() === 'about:blank') {
          win.close();
        }
      }
    });
    await expect.poll(() => aux.isClosed()).toBe(true);

    await expect
      .poll(() => mainLayoutPanelIds(window), { timeout: 10_000 })
      .toContain(DEFAULT_PANEL_IDS.terminal);
    await expect(window.getByTestId('panel-content-terminal')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
