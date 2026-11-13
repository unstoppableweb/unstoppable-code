import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import {
  FIXTURE_DIR,
  WORKTREE_ID,
  seedRunnerFixture,
  processExists,
  readOwnedPids,
  expectOwnedProcessesGone,
  releasePartialAndExit,
  expectFinalOutput,
  cleanupFixture,
} from './helpers/runnerContract.mjs';

async function launchFixture(mode) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-script-contract-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspace = seed.workspaces[0];
  const dir = seedRunnerFixture(workspace.worktreePath, mode);
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts = {
    'runner-contract': {
      command: `node ${FIXTURE_DIR}/runner.cjs`,
      interactive: true,
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const entry = window
      .getByTestId('activity-scripts-entry')
      .filter({ hasText: 'Runner Contract' });
    await entry.getByTestId('activity-scripts-run').click();
    await entry.getByRole('button', { name: 'Run', exact: true }).click();
    const output = window.getByTestId('terminal-pane').locator('.xterm-rows');
    await expect(output).toBeVisible();
    await expect(entry).toContainText('Running in terminal');
    return { electronApp, userDataDir, dir, window, workspace, entry, output };
  } catch (error) {
    await cleanupFixture(electronApp, userDataDir, dir);
    throw error;
  }
}

async function persistedRun(window, workspace) {
  return window.evaluate(async (projectId) => {
    const runs = await window.api.loadWorktreeScriptRuns({
      projectId,
      worktreeId: 'demo-main',
    });
    return runs.find((run) => run.script.scriptName === 'runner-contract');
  }, workspace.id);
}

test('streams stdout and stderr before failure and preserves partial lines', async () => {
  const { electronApp, userDataDir, dir, window, workspace, entry, output } =
    await launchFixture('stream');
  try {
    await expect(output).toContainText('RUNNER_STDOUT_READY');
    await expect(output).toContainText('RUNNER_STDERR_READY');
    await expect(entry).toContainText('Running in terminal');
    await expect
      .poll(async () => (await persistedRun(window, workspace))?.status)
      .toBe('running');
    await releasePartialAndExit(dir);
    await expectFinalOutput(output);
    await expect
      .poll(async () => (await persistedRun(window, workspace))?.status)
      .toBe('failed');
    const run = await persistedRun(window, workspace);
    expect(run).toMatchObject({
      status: 'failed',
      exitCode: 23,
      timedOut: false,
    });
    expect(run.completedAt).toBeTruthy();
    await window.getByTestId('activity-scripts-completed-toggle').click();
    await expect(
      window.getByTestId('activity-scripts-completed'),
    ).toContainText('Exit 23');
    expect(run.outputLines.join('\n')).toContain(
      'RUNNER_SPLIT_COMPLETE\nRUNNER_FINAL_TAIL',
    );
  } finally {
    await cleanupFixture(electronApp, userDataDir, dir);
  }
});

for (const mode of ['cooperative', 'ignore-term']) {
  test(`cancels a script and reaps its owned descendant (${mode})`, async () => {
    const { electronApp, userDataDir, dir, window, workspace, entry, output } =
      await launchFixture(mode);
    try {
      await expect(output).toContainText('RUNNER_DESCENDANT_READY');
      expect(readOwnedPids(dir).every(processExists)).toBe(true);
      await entry.getByTestId('activity-scripts-stop').click();
      await expect
        .poll(async () => persistedRun(window, workspace))
        .toMatchObject({
          status: 'cancelled',
          completedAt: expect.any(String),
        });
      const run = await persistedRun(window, workspace);
      expect(run).toMatchObject({ status: 'cancelled', timedOut: false });
      expect(run.completedAt).toBeTruthy();
      await window.getByTestId('activity-scripts-completed-toggle').click();
      await expect(
        window.getByTestId('activity-scripts-completed'),
      ).toContainText('Stopped');
      expect(run.outputLines.join('\n')).toContain('RUNNER_DESCENDANT_READY');
      // Interactive scripts use the terminal engine's immediate forced kill;
      // SIGTERM-to-SIGKILL escalation belongs to the piped runner and pipeline.
      await expectOwnedProcessesGone(dir, { expectTerm: false });
    } finally {
      await cleanupFixture(electronApp, userDataDir, dir);
    }
  });
}
