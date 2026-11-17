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
  seedCoworkWorkspace,
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

  test('New task keeps an unsent draft, and a send a reload cut off before it was dispatched, across a reload (CAN-6798)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-draft-reload-'),
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
      const openHome = async () => {
        await window.getByTestId('sidebar-create-task').click();
        const home = window.getByTestId('page-home');
        await waitForHomeWorkspaceSelection(home);
        return home;
      };
      let home = await openHome();
      const prompt = 'Draft the release notes for the health-check fix.';
      await home.getByTestId('home-composer-editor').fill(prompt);

      // An unsent draft comes back in New task.
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      home = await openHome();
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );

      // A send whose worktree is still being created when the window
      // reloads was never dispatched: it is still a draft, and comes back
      // as one.
      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__homeWorktreeCreate = { called: false };
        ipcMain.removeHandler('worktree:create');
        ipcMain.handle('worktree:create', () => {
          globalThis.__homeWorktreeCreate.called = true;
          return new Promise(() => {});
        });
      });
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeWorktreeCreate.called),
        )
        .toBe(true);
      // Nothing was dispatched, so nothing is in the outbox; the record,
      // under this account's own key, keeps the draft.
      await expect
        .poll(() =>
          window.evaluate(() => {
            const key = Object.keys(window.localStorage).find((each) =>
              each.startsWith('canopy:home-draft:v1:'),
            );
            const record =
              key === undefined
                ? null
                : JSON.parse(window.localStorage.getItem(key) ?? '{}');
            return {
              draft: record?.draft?.text ?? null,
              dispatched: record?.outbox !== undefined,
            };
          }),
        )
        .toEqual({ draft: prompt, dispatched: false });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      home = await openHome();
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );
      await expect(home.locator('[data-testid^="home-outbox-"]')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('worktree-row')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New task brings nothing back after a reload when a Cowork first message was taken before its work entries refreshed (CAN-6798)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-cowork-reload-'),
    );
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'cowork-reload',
      name: 'Reload notes',
      collapsed: false,
      seedMessage: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Once main accepts the first message, hold the work-entry list the
      // Cowork send refreshes after it, so the window reloads mid-send.
      await electronApp.evaluate(({ ipcMain }) => {
        const state = { accepted: false, holding: false };
        globalThis.__homeCoworkSend = state;
        const send = ipcMain._invokeHandlers.get('chat:send-message');
        const list = ipcMain._invokeHandlers.get('work-entries:list');
        if (!send || !list)
          throw new Error('Cowork send handlers are missing.');
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async (...args) => {
          const result = await send(...args);
          state.accepted = true;
          state.holding = true;
          return result;
        });
        ipcMain.removeHandler('work-entries:list');
        ipcMain.handle('work-entries:list', (...args) =>
          state.holding ? new Promise(() => {}) : list(...args),
        );
      });
      let home = await app.openHomeForProject('cowork-reload');
      const prompt = 'Summarise the reload notes for the team.';
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeCoworkSend.accepted),
        )
        .toBe(true);

      // The reloaded window lists its work entries again.
      await electronApp.evaluate(() => {
        globalThis.__homeCoworkSend.holding = false;
      });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      home = window.getByTestId('page-home');
      await expect(home.getByTestId('home-surface')).toBeVisible();
      // It left New task as it was dispatched, and its chat took it: no
      // draft of it was kept, so nothing comes back to be sent twice.
      await expect
        .poll(() =>
          window.evaluate(() => {
            const key = Object.keys(window.localStorage).find((each) =>
              each.startsWith('canopy:home-draft:v1:'),
            );
            const record =
              key === undefined
                ? null
                : JSON.parse(window.localStorage.getItem(key) ?? '{}');
            return {
              draft: record?.draft?.text ?? null,
              outbox: record?.outbox ?? null,
            };
          }),
        )
        .toEqual({ draft: null, outbox: null });
      await expect(home.getByTestId('home-composer-editor')).not.toContainText(
        prompt,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New task never clears a newer draft when an earlier Cowork send finishes, even the same text in another project (CAN-6798)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-newer-draft-'),
    );
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'cowork-first',
      name: 'First notes',
      chatId: 'cowork-first-chat',
      collapsed: false,
      seedMessage: false,
    });
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'cowork-second',
      name: 'Second notes',
      chatId: 'cowork-second-chat',
      collapsed: false,
      seedMessage: false,
      mergeIndex: true,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Hold the first message in main until released, so its send is still
      // under way while the person starts a new draft.
      await electronApp.evaluate(({ ipcMain }) => {
        const state = { called: false, done: false, release: () => {} };
        globalThis.__homeHeldSend = state;
        const send = ipcMain._invokeHandlers.get('chat:send-message');
        if (!send) throw new Error('The send handler is missing.');
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async (...args) => {
          state.called = true;
          await new Promise((resolve) => {
            state.release = resolve;
          });
          const result = await send(...args);
          state.done = true;
          return result;
        });
      });
      const prompt = 'Summarise the notes for the team.';
      let home = await app.openHomeForProject('cowork-first');
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeHeldSend.called),
        )
        .toBe(true);

      // The message left New task as it went: what the person types now,
      // in another project and with the same text, is a new draft.
      home = await app.openHomeForProject('cowork-second');
      await home.getByTestId('home-composer-editor').fill(prompt);
      await electronApp.evaluate(() => {
        globalThis.__homeHeldSend.release();
      });
      await expect
        .poll(() => electronApp.evaluate(() => globalThis.__homeHeldSend.done))
        .toBe(true);

      // The earlier send's end leaves the new draft alone.
      home = await app.openHomeForProject('cowork-second');
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );
      await expect
        .poll(
          () =>
            window.evaluate(() => {
              const key = Object.keys(window.localStorage).find((each) =>
                each.startsWith('canopy:home-draft:v1:'),
              );
              const record =
                key === undefined
                  ? null
                  : JSON.parse(window.localStorage.getItem(key) ?? '{}');
              return {
                draft: record?.draft?.text ?? null,
                outbox: record?.outbox ?? null,
              };
            }),
          { timeout: 5_000 },
        )
        .toEqual({ draft: prompt, outbox: null });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New task brings back a Cowork first message main refused as a draft, into an empty New task or else kept beside a newer one (CAN-6798)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-refused-kept-'),
    );
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'cowork-refused',
      name: 'Refused notes',
      chatId: 'cowork-refused-chat',
      collapsed: false,
      seedMessage: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Main holds each first message until released, then refuses it.
      await electronApp.evaluate(({ ipcMain }) => {
        const state = { calls: 0, release: () => {} };
        globalThis.__homeRefusedSend = state;
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async () => {
          state.calls += 1;
          await new Promise((resolve) => {
            state.release = resolve;
          });
          throw new Error('Main refused this message.');
        });
      });
      const prompt = 'Summarise the refused notes for the team.';
      const newer = 'Pricing notes for later.';
      const record = () =>
        window.evaluate(() => {
          const key = Object.keys(window.localStorage).find((each) =>
            each.startsWith('canopy:home-draft:v1:'),
          );
          const saved =
            key === undefined
              ? null
              : JSON.parse(window.localStorage.getItem(key) ?? '{}');
          return {
            kept: (saved?.kept ?? []).map((each) => each.text),
            outbox: saved?.outbox ?? null,
          };
        });
      let home = await app.openHomeForProject('cowork-refused');
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeRefusedSend.calls),
        )
        .toBe(1);
      // Refused while New task is free: it comes back there, to edit and send.
      await electronApp.evaluate(() => {
        globalThis.__homeRefusedSend.release();
      });
      home = await app.openHomeForProject('cowork-refused');
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
        { timeout: 15_000 },
      );
      await expect.poll(record).toEqual({ kept: [], outbox: null });

      // Sent again, and refused again while New task holds a newer draft.
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeRefusedSend.calls),
        )
        .toBe(2);
      // The message left New task as it went; a newer draft takes its place.
      home = await app.openHomeForProject('cowork-refused');
      await home.getByTestId('home-composer-editor').fill(newer);
      await electronApp.evaluate(() => {
        globalThis.__homeRefusedSend.release();
      });

      // Never lost, never merged: it comes back as its own kept draft.
      await expect(home.getByTestId('home-kept-draft')).toContainText(prompt, {
        timeout: 15_000,
      });
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        newer,
      );
      await expect.poll(record).toEqual({ kept: [prompt], outbox: null });
      // Once New task is free, it moves back.
      await home.getByTestId('home-composer-editor').fill('');
      await home.getByTestId('home-kept-draft-move').click();
      await expect(home.getByTestId('home-composer-editor')).toContainText(
        prompt,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('New task holds a local first message main failed to take exactly once, as develop does, while its chat shows it failed (CAN-6798)', async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-held-by-chat-'),
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
      const openHome = async () => {
        await window.getByTestId('sidebar-create-task').click();
        const page = window.getByTestId('page-home');
        await waitForHomeWorkspaceSelection(page);
        return page;
      };
      // Main holds the first message until released, then fails it.
      await electronApp.evaluate(({ ipcMain }) => {
        const state = { calls: 0, release: () => {} };
        globalThis.__homeHeldByChat = state;
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async () => {
          state.calls += 1;
          await new Promise((resolve) => {
            state.release = resolve;
          });
          throw new Error('Main refused this message.');
        });
      });
      const prompt = 'Draft the release notes for the failed send.';
      const home = await openHome();
      await home.getByTestId('home-composer-editor').fill(prompt);
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(
          () => electronApp.evaluate(() => globalThis.__homeHeldByChat.calls),
          { timeout: 60_000 },
        )
        .toBe(1);
      // New task is untouched when the failure comes.
      await electronApp.evaluate(() => {
        globalThis.__homeHeldByChat.release();
      });

      // Its chat shows it failed, with no way to send it from there...
      await expect(window.getByText('Main refused this message.')).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        window.getByTestId('first-send-failed-notice-retry'),
      ).toHaveCount(0);
      // ...and New task holds it again, once, to edit and send.
      const later = await openHome();
      await expect(later.getByTestId('home-composer-editor')).toContainText(
        prompt,
        { timeout: 15_000 },
      );
      await expect(later.getByTestId('home-kept-draft')).toHaveCount(0);
      await expect
        .poll(() =>
          window.evaluate((text) => {
            const key = Object.keys(window.localStorage).find((each) =>
              each.startsWith('canopy:home-draft:v1:'),
            );
            const saved =
              key === undefined
                ? null
                : JSON.parse(window.localStorage.getItem(key) ?? '{}');
            return {
              draft: saved?.draft?.text ?? null,
              kept: (saved?.kept ?? []).length,
              outbox: saved?.outbox ?? null,
            };
          }, prompt),
        )
        .toEqual({ draft: prompt, kept: 0, outbox: null });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test("New task never writes one account's Cowork first message into another's record when the account changes while its chat is created, and sweeps the first account's record (CAN-6798)", async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-account-switch-'),
    );
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'cowork-account',
      name: 'Account notes',
      chatId: 'cowork-account-chat',
      collapsed: false,
      seedMessage: false,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Main answers the saved-account read as account A, later B, and can
      // hold the Cowork chat's creation.
      await electronApp.evaluate(({ ipcMain }) => {
        const state = {
          who: 'acct-a',
          hold: false,
          held: false,
          created: false,
          release: () => {},
        };
        globalThis.__homeAccountSwitch = state;
        const load = ipcMain._invokeHandlers.get(
          'settings:load-canopy-cloud-account',
        );
        const create = ipcMain._invokeHandlers.get('work-entries:create');
        if (!load || !create)
          throw new Error('The account or create handler is missing.');
        ipcMain.removeHandler('settings:load-canopy-cloud-account');
        ipcMain.handle(
          'settings:load-canopy-cloud-account',
          async (...args) => {
            const real = await load(...args);
            // A whole account record: the window renders it, not just New task.
            return {
              ...(real ?? {}),
              read: 'ok',
              account: {
                name: `Account ${state.who}`,
                email: `${state.who}@example.test`,
                role: 'DEVELOPER',
                ...(real?.account ?? {}),
                id: state.who,
              },
            };
          },
        );
        ipcMain.removeHandler('work-entries:create');
        ipcMain.handle('work-entries:create', async (...args) => {
          if (state.hold) {
            state.held = true;
            await new Promise((resolve) => {
              state.release = resolve;
            });
          }
          const result = await create(...args);
          state.created = true;
          return result;
        });
      });
      const keys = () =>
        window.evaluate(() =>
          Object.keys(window.localStorage).filter((each) =>
            each.startsWith('canopy:home-draft:v1:'),
          ),
        );
      // New task reads account A from the start.
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      const prompt = 'Account A private plan for the launch.';
      let home = await app.openHomeForProject('cowork-account');
      await home.getByTestId('home-composer-editor').fill(prompt);
      await expect.poll(keys).toEqual(['canopy:home-draft:v1:account:acct-a']);

      await electronApp.evaluate(() => {
        globalThis.__homeAccountSwitch.hold = true;
      });
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeAccountSwitch.held),
        )
        .toBe(true);
      // Account B signs in while A's chat is being created.
      const context = await window.evaluate(() =>
        window.api.workspaceContext.get(),
      );
      await electronApp.evaluate(({ BrowserWindow }, state) => {
        globalThis.__homeAccountSwitch.who = 'acct-b';
        for (const each of BrowserWindow.getAllWindows())
          each.webContents.send('workspace-context:changed', {
            ...state,
            reason: 'account-change',
          });
      }, context);
      await electronApp.evaluate(() => {
        globalThis.__homeAccountSwitch.release();
      });
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__homeAccountSwitch.created),
        )
        .toBe(true);

      // Nothing of A's is written under B, and A's record is swept once B
      // is the account signed in.
      await expect
        .poll(
          () =>
            window.evaluate((text) => {
              const found = Object.keys(window.localStorage).filter((each) =>
                each.startsWith('canopy:home-draft:v1:'),
              );
              return {
                accountA: found.includes('canopy:home-draft:v1:account:acct-a'),
                textUnderB: found.some(
                  (each) =>
                    each !== 'canopy:home-draft:v1:account:acct-a' &&
                    (window.localStorage.getItem(each) ?? '').includes(text),
                ),
              };
            }, prompt),
          { timeout: 15_000 },
        )
        .toEqual({ accountA: false, textUnderB: false });
      home = await app.openHomeForProject('cowork-account');
      await expect(home.getByTestId('home-composer-editor')).not.toContainText(
        prompt,
      );
      await expect(
        home.locator('[data-testid^="home-outbox-"]', { hasText: prompt }),
      ).toHaveCount(0);
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

test.describe('Sidebar worktree create', () => {
  test('the sidebar + shows the created worktree at once, under one id, and opens it (CAN-6957)', async () => {
    test.setTimeout(90_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-sidebar-create-'),
    );
    // No pre-existing worktree, so every row the project shows is this create.
    const summary = seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      createWorktrees: false,
    });
    const workspace = summary.workspaces[0];

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Hold main's create at its real IPC boundary, so "at once" means
      // before the host has answered, not merely fast.
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'worktree:create';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Worktree create handler is missing.');
        let release;
        globalThis.__can6957ReleaseCreate = new Promise((resolve) => {
          release = resolve;
        });
        globalThis.__can6957Release = () => release();
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          await globalThis.__can6957ReleaseCreate;
          return original(...args);
        });
      });

      // Every worktree id this project's rows show from the click on.
      await window.evaluate((projectId) => {
        const seen = new Set();
        const record = () => {
          for (const row of document.querySelectorAll(
            `[data-testid="worktree-row"][data-project-id="${projectId}"]`,
          )) {
            seen.add(row.getAttribute('data-worktree-id'));
          }
        };
        new MutationObserver(record).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-worktree-id'],
        });
        globalThis.__can6957SeenRowIds = seen;
      }, workspace.id);

      const header = window
        .locator(
          `[data-sidebar-workspace-id="${workspace.id}"] [data-testid^="sidebar-project-header-"]`,
        )
        .first();
      // The + is revealed on hover; this is setup by stable identity, not a
      // hover assertion, so dispatch to the resolved button directly.
      const add = header.getByLabel(/^Create worktree for /);
      await expect(add).toBeEnabled();
      await add.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error('Expected the create button element');
        }
        element.click();
      });

      // While main still holds the create, the project already shows the
      // new worktree's row.
      const rows = window.locator(
        `[data-testid="worktree-row"][data-project-id="${workspace.id}"]`,
      );
      await expect(rows).toHaveCount(1);
      const shownId = await rows.first().getAttribute('data-worktree-id');
      expect(shownId).toBeTruthy();

      await electronApp.evaluate(() => globalThis.__can6957Release());

      // The row it showed is the worktree main created, now open.
      const createdRow = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${shownId}"]`,
      );
      await expect(
        window.locator('[data-sidebar-selected-item]').filter({
          has: createdRow,
        }),
      ).toHaveCount(1, { timeout: 30_000 });
      await expect(window.getByTestId('worktree-part')).toBeVisible();
      await expect
        .poll(() =>
          execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: workspace.repoPath,
            encoding: 'utf8',
          })
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => path.basename(line.slice('worktree '.length))),
        )
        .toContain(shownId);
      // No other id ever stood in for it.
      expect(
        await window.evaluate(() => [...globalThis.__can6957SeenRowIds]),
      ).toEqual([shownId]);
      await expect(rows).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
