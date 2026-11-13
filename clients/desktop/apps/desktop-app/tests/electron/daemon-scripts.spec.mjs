// CAN-5087 — scripts Electron acceptance for the daemon script route, which
// is on by default with no Labs switch (CAN-5960).
//
// SCOPE. A non-interactive project script the main window runs executes in
// the core daemon: its shell's parent is the daemon, its run log names the
// daemon as writer, and its output reaches the renderer. A stop cancels it.
// An interactive script, which the route excludes in code, runs in the app
// after a daemon run, and nothing in the run logs is repaired or set aside.
//
// PLATFORM. macOS only: it needs the verified daemon artifact the launcher
// starts and the owned-child host. Linux and Windows skip.
//
// FLOW. Seed a demo workspace and add `daemon-echo` and `daemon-sleep` to the
// worktree's canopy.json, launch the app, and run the scripts through the
// preload calls the Scripts panel makes. The daemon's PID comes from
// `<dataRoot>/runtime/core.json`.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopyApp } from './launchCanopy.mjs';

test.skip(
  process.platform !== 'darwin',
  'The packaged daemon artifact and owned-child host are macOS only.',
);

const SCRIPTS = {
  'daemon-echo': "printf 'one\\ntwo\\n'",
  'daemon-sleep': 'sleep 60',
  // Interactive runs use a terminal, which the daemon route never takes.
  'daemon-ask': { command: "printf 'asked\\n'", interactive: true },
};

function daemonPid(userDataDir) {
  const descriptor = JSON.parse(
    readFileSync(path.join(userDataDir, 'runtime', 'core.json'), 'utf8'),
  );
  return Number(descriptor.pid);
}

function processTable() {
  // A busy host's full process table can pass execFileSync's 1 MiB default.
  return execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      args,
    }));
}

function scriptRunDir(userDataDir, workspaceId, worktreeId) {
  return path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'script-runs',
    worktreeId,
  );
}

// Project scripts are keyed `project:<name>` (createScriptKey).
function runLogMeta(userDataDir, workspaceId, worktreeId, scriptName) {
  const dir = scriptRunDir(userDataDir, workspaceId, worktreeId);
  const stem = createHash('sha256')
    .update(`project:${scriptName}`)
    .digest('hex')
    .slice(0, 12);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // No run has written a log in this worktree yet.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const name = entries.find((entry) => entry.endsWith(`__${stem}.json`));
  return name ? JSON.parse(readFileSync(path.join(dir, name), 'utf8')) : null;
}

// Whether a process running `args` descends from `ancestor`.
function runsUnder(args, ancestor) {
  const rows = processTable();
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  return rows.some((row) => {
    if (row.args !== args) return false;
    for (let pid = row.ppid; pid > 1; pid = parents.get(pid) ?? 0)
      if (pid === ancestor) return true;
    return false;
  });
}

// The seed summary carries the worktree's path but not its id; the id is the
// worktrees.json entry the seeder created at that path.
function seededWorktreeId(userDataDir, workspace) {
  const { worktrees } = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspace.id, 'worktrees.json'),
      'utf8',
    ),
  );
  const id = worktrees.find(
    (entry) => entry.id === path.basename(workspace.worktreePath),
  )?.id;
  if (!id) throw new Error(`No seeded worktree for ${workspace.id}.`);
  return id;
}

test.describe('daemon scripts (CAN-5087)', () => {
  let launched;
  let seeded;
  let workspace;
  let worktreeId;
  let owner;

  test.beforeEach(async () => {
    // A short root: the daemon refuses a macOS socket path over 103 bytes,
    // and a test output path can pass that.
    owner = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cds-')));
    const userDataDir = path.join(owner, 'data');
    seeded = seedDemoWorkspaces({ userDataDir });
    workspace = seeded.workspaces.find(
      (entry) => entry.type === 'single-repo' && entry.worktreePath,
    );
    if (!workspace) throw new Error('No single-repo demo workspace.');
    worktreeId = seededWorktreeId(userDataDir, workspace);
    const manifestPath = path.join(workspace.worktreePath, 'canopy.json');
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))
      : {};
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { ...manifest, scripts: { ...manifest.scripts, ...SCRIPTS } },
        null,
        2,
      ),
    );
    launched = await launchCanopyApp({ userDataDir });
  });

  test.afterEach(async () => {
    if (launched)
      await closeCanopy(launched.electronApp, launched.userDataDir).catch(
        () => undefined,
      );
    cleanupDemoWorkspaces(seeded);
    if (owner) rmSync(owner, { recursive: true, force: true });
  });

  function request(scriptName) {
    return {
      target: 'project',
      projectId: workspace.id,
      worktreeId,
      scriptName,
    };
  }

  test('runs a project script in the daemon with live output', async () => {
    const { window, userDataDir } = launched;
    const outputs = window.evaluate(
      () =>
        new Promise((resolve) => {
          const lines = [];
          const stop = window.api.onScriptOutput((event) => {
            lines.push(...(event.lines ?? []));
            if (lines.includes('two')) {
              stop();
              resolve(lines);
            }
          });
        }),
    );
    const response = await window.evaluate(
      (body) => window.api.runScript(body),
      request('daemon-echo'),
    );
    expect(response.success).toBe(true);
    expect(await outputs).toEqual(expect.arrayContaining(['one', 'two']));
    const meta = runLogMeta(
      userDataDir,
      workspace.id,
      worktreeId,
      'daemon-echo',
    );
    expect(meta?.writer?.pid).toBe(daemonPid(userDataDir));
    expect(meta?.status).toBe('success');
  });

  test('stops a daemon script', async () => {
    const { window, userDataDir } = launched;
    const running = window.evaluate(
      (body) => window.api.runScript(body),
      request('daemon-sleep'),
    );
    // The first routed run starts the daemon, so its descriptor comes later.
    await expect
      .poll(() => existsSync(path.join(userDataDir, 'runtime', 'core.json')))
      .toBe(true);
    const daemon = daemonPid(userDataDir);
    // Wait for this script's own run log and process: another daemon child
    // can start before either exists (CAN-6043).
    await expect
      .poll(
        () =>
          runLogMeta(userDataDir, workspace.id, worktreeId, 'daemon-sleep')
            ?.status,
      )
      .toBe('running');
    await expect.poll(() => runsUnder('sleep 60', daemon)).toBe(true);
    const meta = runLogMeta(
      userDataDir,
      workspace.id,
      worktreeId,
      'daemon-sleep',
    );
    expect(meta?.script?.scriptKey).toBe('project:daemon-sleep');
    expect(meta?.writer?.pid).toBe(daemon);
    await window.evaluate((body) => window.api.stopScript(body), {
      projectId: workspace.id,
      worktreeId,
      scriptKey: meta.script.scriptKey,
    });
    expect((await running).success).toBe(false);
    await expect
      .poll(() => processTable().some((row) => row.args === 'sleep 60'))
      .toBe(false);
  });

  test('runs an interactive script in the app after a daemon run, with nothing repaired', async () => {
    const { window, userDataDir } = launched;
    expect(
      (
        await window.evaluate(
          (body) => window.api.runScript(body),
          request('daemon-echo'),
        )
      ).success,
    ).toBe(true);
    const daemon = daemonPid(userDataDir);
    expect(
      runLogMeta(userDataDir, workspace.id, worktreeId, 'daemon-echo')?.writer
        ?.pid,
    ).toBe(daemon);
    expect(
      (
        await window.evaluate(
          (body) => window.api.runScript(body),
          request('daemon-ask'),
        )
      ).success,
    ).toBe(true);
    const meta = runLogMeta(
      userDataDir,
      workspace.id,
      worktreeId,
      'daemon-ask',
    );
    expect(meta?.status).toBe('success');
    expect(meta?.writer?.pid).not.toBe(daemon);
    expect(
      readdirSync(scriptRunDir(userDataDir, workspace.id, worktreeId)).some(
        (name) => name.includes('.unreadable-'),
      ),
    ).toBe(false);
  });
});
