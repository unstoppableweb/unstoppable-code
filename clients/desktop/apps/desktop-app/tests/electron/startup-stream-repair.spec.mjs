import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PROJECT = 'demo-ts-pnpm-vite';
const WORKTREE = 'demo-main';
const CHAT_ID = 'startup-repair-unopened-chat';
const REPAIR_COMPLETION_LINE = '[startup-stream-repair] E2E completion';

function prepareStartupRepairFixture(userDataDir) {
  const specPath = path.join(userDataDir, 'startup-stream-repair-fixture.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      version: 1,
      projectId: PROJECT,
      worktreeId: WORKTREE,
      chatId: CHAT_ID,
      scenario: 'startup-repair',
    }),
  );
  return {
    specPath,
    extraEnv: {
      CANOPY_E2E_CHAT_FORMAT4: '1',
      CANOPY_E2E_STARTUP_STREAM_REPAIR: '0',
      CANOPY_E2E_SEED_STREAM_FIXTURE: specPath,
    },
  };
}

async function startupRepairSnapshot(electronApp) {
  return electronApp.evaluate(async () => {
    const query = globalThis.__CANOPY_E2E_STARTUP_STREAM_REPAIR_QUERY__;
    if (!query) throw new Error('Startup repair fixture query is not ready');
    return query();
  });
}

function hasRepairCompletionLine(userDataDir) {
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  if (!existsSync(logPath)) return false;
  return readFileSync(logPath, 'utf8').includes(REPAIR_COMPLETION_LINE);
}

test('startup stream repair settles a never-opened stream card after restart', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-stream-repair-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const fixture = prepareStartupRepairFixture(userDataDir);
  let electronApp;

  try {
    electronApp = (await launchCanopy({ userDataDir, env: fixture.extraEnv }))
      .electronApp;
    await electronApp.firstWindow();
    await expect
      .poll(() => startupRepairSnapshot(electronApp), { timeout: 30_000 })
      .toMatchObject({
        runGeneration: 3,
        descriptor: {
          status: 'open',
          committedRowCount: 1,
          cardStatus: 'pending',
        },
        card: { status: 'pending', runGeneration: 3 },
        childRows: [
          {
            id: 'startup-repair-row',
            itemRevision: 0,
            final: true,
          },
        ],
      });
    const before = await startupRepairSnapshot(electronApp);

    // The target worktree/chat is never navigated to before or after restart.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = (
      await launchCanopy({
        userDataDir,
        env: {
          ...fixture.extraEnv,
          CANOPY_E2E_STARTUP_STREAM_REPAIR: '1',
        },
      })
    ).electronApp;
    const window = await electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });

    await expect
      .poll(() => hasRepairCompletionLine(userDataDir), { timeout: 60_000 })
      .toBe(true);

    // Read durable card/stream state from the main fixture hook before opening
    // a chat or creating a scope actor. The content-free log line is only the
    // job-completion signal; assertions below read the canonical store.
    const after = await startupRepairSnapshot(electronApp);
    expect(after).toMatchObject({
      runGeneration: 3,
      descriptor: {
        status: 'settled',
        committedRowCount: 1,
      },
      childRows: before.childRows,
    });
    expect(['completed', 'interrupted']).toContain(after.descriptor.cardStatus);
    expect(after.card).toMatchObject({ runGeneration: 3 });
    expect(['pending', after.descriptor.cardStatus]).toContain(
      after.card.status,
    );

    await expect(window.getByTestId('panel-content-chat')).toHaveCount(0);
    const targetSessions = await window.evaluate(
      async ({ projectId, worktreeId, chatId }) => {
        const active = await window.api.chat.activeSessions({
          projectId,
          worktreeId,
        });
        return (active.sessions ?? []).filter(
          (session) => session.chatId === chatId,
        );
      },
      { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT_ID },
    );
    expect(targetSessions).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
