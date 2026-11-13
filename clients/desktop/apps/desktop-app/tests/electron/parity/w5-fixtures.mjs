// Fixtures for the W5 behavior baseline specs (CAN-3697): seeded Git
// repositories, on-disk readers for the W5 storage ids (`workspace_index`,
// `workspace_manifest`, `worktree_list`, `worktree_checkouts`), and a CLI
// runner that targets the same data root as the running app.
// Record: docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-baseline-w5.md

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from '../launchCanopy.mjs';
import { writeJson } from '../seeders/fsHelpers.mjs';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

export const DEFAULT_COWORK_WORKSPACE_ID = 'cowork-default';

export function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/** A repository on `main` with one commit. */
export function initRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(repoPath, 'README.md'), '# fixture\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  return realpathSync(repoPath);
}

/** A bare repository usable as an offline clone URL. */
export function initBareRemote(root, name) {
  const source = initRepo(path.join(root, `${name}-source`));
  const remote = path.join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', source, remote]);
  return remote;
}

export function indexPath(userDataDir) {
  return path.join(userDataDir, 'workspaces', 'index.json');
}

export function readIndex(userDataDir) {
  return JSON.parse(readFileSync(indexPath(userDataDir), 'utf8'));
}

export function readIndexIds(userDataDir) {
  return readIndex(userDataDir).workspaces.map((entry) => entry.id);
}

export function readIndexEntry(userDataDir, workspaceId) {
  return readIndex(userDataDir).workspaces.find(
    (entry) => entry.id === workspaceId,
  );
}

function manifestPath(userDataDir, workspaceId) {
  return path.join(userDataDir, 'workspaces', workspaceId, 'workspace.json');
}

export function readManifest(userDataDir, workspaceId) {
  return JSON.parse(
    readFileSync(manifestPath(userDataDir, workspaceId), 'utf8'),
  );
}

export function worktreeListPath(userDataDir, workspaceId) {
  return path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json');
}

export function readWorktreeRows(userDataDir, workspaceId) {
  return JSON.parse(
    readFileSync(worktreeListPath(userDataDir, workspaceId), 'utf8'),
  ).worktrees;
}

export function checkoutPath(userDataDir, workspaceId, worktreeId) {
  return path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktrees',
    worktreeId,
  );
}

/** Workspace directories holding a `workspace.json` that the index omits. */
export function orphanManifestIds(userDataDir) {
  const root = path.join(userDataDir, 'workspaces');
  const indexed = new Set(readIndexIds(userDataDir));
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !indexed.has(entry.name) &&
        existsSync(path.join(root, entry.name, 'workspace.json')),
    )
    .map((entry) => entry.name)
    .sort();
}

export function registeredWorktreePaths(repoPath) {
  const root = realpathSync(repoPath);
  return git(repoPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((worktreePath) => {
      try {
        return realpathSync(worktreePath) !== root;
      } catch {
        return true;
      }
    })
    .map((worktreePath) => {
      try {
        return realpathSync(worktreePath);
      } catch {
        return worktreePath;
      }
    })
    .sort();
}

/** Seeds one single-repo project, publishing a one-entry-per-call index. */
export function seedSingleRepoProject(
  userDataDir,
  { id, name, repoPath, worktrees = [], order = 0 },
) {
  const indexFile = indexPath(userDataDir);
  const existing = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, 'utf8')).workspaces
    : [];
  writeJson(indexFile, {
    version: 1,
    workspaces: [
      ...existing,
      {
        id,
        name,
        type: 'single-repo',
        color: '#7C3AED',
        collapsed: false,
        order,
      },
    ],
  });
  writeJson(manifestPath(userDataDir, id), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
  });
  writeJson(worktreeListPath(userDataDir, id), { version: 1, worktrees });
}

/**
 * Blocks `git worktree add` in `repoPath` inside its post-checkout hook until
 * the test writes `release.<branch>` or `release.all` in `gateDir`.
 */
export function installCheckoutGate(repoPath, gateDir) {
  const hooksDir = path.join(gateDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    path.join(hooksDir, 'post-checkout'),
    [
      '#!/bin/sh',
      'branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo none)',
      `touch "${gateDir}/entered.$branch"`,
      `while [ ! -f "${gateDir}/release.$branch" ] && [ ! -f "${gateDir}/release.all" ]; do sleep 0.05; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  git(repoPath, ['config', 'core.hooksPath', hooksDir]);
}

/** Git config applying `gateDir/hooks` to every repository a CLI touches. */
export function gitHooksPathEnv(gateDir) {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(gateDir, 'hooks'),
  };
}

export function gateEntries(gateDir) {
  return readdirSync(gateDir)
    .filter((name) => name.startsWith('entered.'))
    .map((name) => name.slice('entered.'.length))
    .sort();
}

export function releaseGate(gateDir, branch = 'all') {
  writeFileSync(path.join(gateDir, `release.${branch}`), '');
}

// CLI children still running when a test ends; a failed test may leave one
// held inside a gate hook that would otherwise wait forever.
const runningCliChildren = new Set();

/** Runs the desktop CLI against the app's data root, as a second client. */
export function runCli(userDataDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      path.join(
        repoRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
      ),
      ['apps/desktop-cli/src/index.ts', ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FORCE_COLOR: undefined,
          NO_COLOR: '1',
          CANOPY_DATA_DIR: userDataDir,
          CANOPY_SECURE_DATA_DIR: `${userDataDir}-secure`,
          ...extraEnv,
        },
        // Own process group, so cleanup also kills its git and hook children.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    runningCliChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      runningCliChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Kills every CLI child (and its process group) a test left running. */
export function reapCliChildren() {
  for (const child of runningCliChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already exited between the check and the signal.
    }
  }
  runningCliChildren.clear();
}

/** Main-process view of the projects, as the renderer loads it. */
export async function loadProjectIds(window) {
  return window.evaluate(async () =>
    (await window.api.loadProjects()).items.map((item) => item.id),
  );
}

/**
 * Launches the app and waits until startup has provisioned the default Chats
 * project into the index, so later index reads see a settled baseline.
 */
export async function launchW5App(options = {}) {
  const launched = await launchCanopy(options);
  const window = await launched.electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await expect
    .poll(() =>
      existsSync(indexPath(launched.userDataDir))
        ? readIndexIds(launched.userDataDir)
        : [],
    )
    .toContain(DEFAULT_COWORK_WORKSPACE_ID);
  return { ...launched, window };
}

/**
 * Asks the app to quit and requires it to exit on its own within the
 * deadline; only then reaps the tree, keeping the data root for a relaunch.
 * `closeCanopy` alone would fall back to SIGKILL after a timed-out close.
 */
export async function quitGracefullyKeepingData(
  electronApp,
  userDataDir,
  timeoutMs = 20_000,
) {
  await captureDaemonDryRunEvidence(electronApp);
  const exited = new Promise((resolve) => {
    electronApp.once('close', () => resolve('exited'));
  });
  // close() quits the app, then detaches Playwright's Node inspector. A quit
  // sent through evaluate() leaves it attached, and Electron then waits at exit
  // for that debugger to disconnect. close() never forces a kill.
  void electronApp.close().catch(() => undefined);
  let deadline;
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => {
      deadline = setTimeout(() => resolve('timed-out'), timeoutMs);
    }),
  ]);
  clearTimeout(deadline);
  await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  expect(outcome, 'graceful quit must finish without a forced kill').toBe(
    'exited',
  );
}

/** SIGKILLs the app's process tree, then reaps it, keeping its data root. */
export async function crashKeepingData(launched) {
  await launched.killAbruptly();
  await closeCanopy(launched.electronApp, launched.userDataDir, {
    keepUserData: true,
  });
}

/** Invokes a preload method from the renderer and returns its rejection text. */
export async function invokeExpectingError(window, method, request) {
  return window.evaluate(
    async ({ method, request }) => {
      try {
        await window.api[method](request);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { method, request },
  );
}

/** Calls a preload method without awaiting it, as a disconnecting client would. */
export async function invokeWithoutAwaiting(window, method, request) {
  await window.evaluate(
    ({ method, request }) => {
      void window.api[method](request).catch(() => undefined);
    },
    { method, request },
  );
}

/**
 * A `CANOPY_GIT_EXECUTABLE` shim that holds matching Git commands until the
 * test writes `release` in `gateDir`. The app runs Git with hooks disabled,
 * so this is the seam that pauses its own `git clone` or `git worktree add`.
 * Each held invocation records `entered.<pid>`. A held command exits once the
 * process that ran it is gone: an orphan would keep the quit app's crashpad
 * handler, and so its stderr, open until the harness happened to reap it.
 */
export function writeGatedGitShim(gateDir, casePattern) {
  mkdirSync(gateDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  const shimPath = path.join(gateDir, 'gated-git.sh');
  writeFileSync(
    shimPath,
    [
      '#!/bin/sh',
      'case " $* " in',
      `  ${casePattern})`,
      `    touch "${gateDir}/entered.$$"`,
      `    while [ ! -f "${gateDir}/release" ]; do`,
      '      kill -0 "$PPID" 2>/dev/null || exit 1',
      '      sleep 0.05',
      '    done',
      '    ;;',
      'esac',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return shimPath;
}

export const GATE_WORKTREE_ADD = '*" worktree add "*';
export const GATE_CLONE = '*" clone "*';

export function heldGitCommandCount(gateDir) {
  return readdirSync(gateDir).filter((name) => name.startsWith('entered.'))
    .length;
}

export function releaseGitGate(gateDir) {
  writeFileSync(path.join(gateDir, 'release'), '');
}
