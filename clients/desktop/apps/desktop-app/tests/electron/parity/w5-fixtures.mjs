// Fixtures for the W5 behavior baseline specs (CAN-3697): seeded Git
// repositories, on-disk readers for the W5 storage ids (`workspace_index`,
// `workspace_manifest`, `worktree_list`, `worktree_checkouts`), and a CLI
// runner that targets the same data root as the running app.
// Record: docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-baseline-w5.md

import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { require as tsRequire } from 'tsx/cjs/api';
import { CanopyAppDriver } from '../canopyApp.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from '../launchCanopy.mjs';
import { writeJson } from '../seeders/fsHelpers.mjs';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

export const DEFAULT_COWORK_WORKSPACE_ID = 'cowork-default';

// Each boot starts at the line logging this marker.
const BOOT_START = /^(?=[^\n]*Main process file logging initialized)/m;

// Existing path-free product warnings and the facts each one carries.
const W5_FAILURE_WARNINGS = [
  [
    'handoff',
    'W5 startup handoff failed; workspace records are read-only',
    [
      'reason',
      'stage',
      'errorKind',
      'refusal',
      'cause',
      'code',
      'errorName',
      'errorCode',
      'errno',
      'nativeStage',
      'exitCode',
      'signal',
      'operation',
      'portKind',
    ],
  ],
  [
    'archive',
    'Worktree archive failed',
    [
      'archive_trigger',
      'phase',
      'code',
      'refusal_reason',
      'refusal_phase',
      'refusal_check',
      'refusal_failure',
      'refusal_cause_code',
      'journal_stopping_phase',
      'journal_stopping_state',
      'journal_step_code',
    ],
  ],
  ['service', 'Background service unavailable', ['reason']],
];

/**
 * Boots in a data root's logs, oldest first. Each W5 test owns its root, so
 * every boot is this test's; rotation moves older lines to main.old.log, and
 * text before the first marker is a boot whose start was rotated away.
 */
function readW5Boots(userDataDir) {
  const text = ['main.old.log', 'main.log']
    .map((name) => path.join(userDataDir, 'logs', name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const boots = text.split(BOOT_START);
  const cropped = BOOT_START.test(boots[0] ?? '') ? undefined : boots.shift();
  return { cropped: cropped?.trim() ? cropped : undefined, boots };
}

function reportW5WarningFacts(boot, label) {
  for (const [kind, marker, fields] of W5_FAILURE_WARNINGS) {
    for (
      let start = boot.indexOf(marker);
      start >= 0;
      start = boot.indexOf(marker, start + marker.length)
    ) {
      // A record runs until the next timestamped line.
      const warning = boot.slice(start, start + 4096).split('\n[')[0];
      const facts = Object.fromEntries(
        fields.flatMap((field) => {
          // util.inspect keys are unquoted, so a key inside a JSON string
          // value (`journal_steps`) never matches.
          const value = warning.match(
            new RegExp(`(?:^|[{,])\\s*${field}\\s*:\\s*["']?([\\w.:-]+)`, 'm'),
          )?.[1];
          return value ? [[field, value]] : [];
        }),
      );
      console.warn(
        `[w5-failure] ${kind}`,
        JSON.stringify({ boot: label, ...facts }),
      );
    }
  }
}

/** CI uploads screenshots only: keep path/value-free failure facts in its log. */
function reportW5FailureFacts(userDataDir) {
  const { cropped, boots } = readW5Boots(userDataDir);
  console.warn(
    '[w5-failure] boots',
    JSON.stringify({ logged: boots.length, cropped: cropped !== undefined }),
  );
  if (cropped !== undefined) reportW5WarningFacts(cropped, 'cropped');
  boots.forEach((boot, index) =>
    reportW5WarningFacts(boot, `${index + 1}/${boots.length}`),
  );
  const directory = path.join(userDataDir, 'w5', 'destructive-lifecycles');
  if (!existsSync(directory)) return;
  let contract;
  try {
    // tsx, on failure only: a Playwright-transformed import of this graph breaks
    // discovery of any spec that also imports a core-platform .ts.
    contract = tsRequire(
      '../../../src/main/lib/__tests__/fixtures/w5-journal-schema.ts',
      import.meta.url,
    );
  } catch (error) {
    warnW5Failure('could not load the recovery journal contract', error);
    return;
  }
  const {
    journalSchema,
    LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN,
    sanitizedDestructiveCode,
    sanitizedDestructivePhase,
  } = contract;
  for (const file of readdirSync(directory).filter((name) =>
    LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name),
  )) {
    let journal;
    try {
      const journalPath = path.join(directory, file);
      if (!lstatSync(journalPath).isFile())
        throw new Error('Recovery journal is not a regular file');
      journal = journalSchema.parse(
        JSON.parse(readFileSync(journalPath, 'utf8')),
      );
    } catch {
      console.warn('[w5-failure] unreadable recovery journal');
      continue;
    }
    console.warn(
      '[w5-failure] recovery',
      JSON.stringify({
        // Schema enums; phases and codes use the production log sanitizers.
        operation: journal.operation,
        state: journal.state,
        steps: journal.steps.map((step) => ({
          phase: sanitizedDestructivePhase(step.phase),
          state: step.state,
          code:
            step.code === undefined
              ? undefined
              : sanitizedDestructiveCode(step.code),
        })),
      }),
    );
  }
}

const terminalTupleFacts = (tuple) => ({
  code: Number.isInteger(tuple?.code) ? tuple.code : undefined,
  signal:
    typeof tuple?.signal === 'string' && /^SIG[A-Z0-9]+$/.test(tuple.signal)
      ? tuple.signal
      : undefined,
});

/**
 * Warns with allowlisted facts only: raw error text can carry launcher output
 * and absolute paths into CI logs.
 */
function warnW5Failure(message, error) {
  const name = typeof error?.name === 'string' ? error.name : undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const result = error?.result;
  console.warn(
    `[w5-failure] ${message}`,
    JSON.stringify({
      name: name !== undefined && /^\w+$/.test(name) ? name : undefined,
      code:
        code !== undefined && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined,
      exit: result === undefined ? undefined : terminalTupleFacts(result.exit),
      close:
        result === undefined ? undefined : terminalTupleFacts(result.close),
    }),
  );
}

/** Run after the app stops (main.log's async sink drains); never copy tokens. */
function captureW5FailureDiagnostics(userDataDir) {
  try {
    reportW5FailureFacts(userDataDir);
  } catch {
    console.warn('[w5-failure] could not summarize failure facts');
  }
  try {
    for (const [relative, outputName] of [
      ['logs', 'w5-failure-logs'],
      ['w5/destructive-lifecycles', 'w5-recovery-journals'],
    ]) {
      const source = path.join(userDataDir, relative);
      if (!existsSync(source)) continue;
      cpSync(source, test.info().outputPath(outputName), {
        recursive: true,
        filter: (source) => {
          const entry = lstatSync(source);
          return entry.isDirectory() || entry.isFile();
        },
      });
    }
  } catch (error) {
    warnW5Failure('could not keep failure diagnostics', error);
  }
}

/** Teardown after a failure only warns, so it never replaces that failure. */
async function closeW5AppQuietly(electronApp, userDataDir, options) {
  try {
    await closeCanopy(electronApp, userDataDir, options);
  } catch (error) {
    warnW5Failure('teardown failed', error);
  }
}

// Inside the W5 specs' test timeouts. Windows closeCanopy awaits app.quit()
// in the main process with no deadline of its own. A close that is slow but
// not hung is cut only in its launcher wait, after Electron has exited.
const W5_FAILURE_CLOSE_DEADLINE_MS = 30_000;

/**
 * Waits for `work` until the failure deadline, then continues without it; the
 * abandoned work keeps running in the background.
 */
async function untilW5FailureDeadline(work, description) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), W5_FAILURE_CLOSE_DEADLINE_MS);
  });
  try {
    if (await Promise.race([work.then(() => false), expired]))
      console.warn(
        `[w5-failure] ${description} still running after ${W5_FAILURE_CLOSE_DEADLINE_MS} ms; continuing without it`,
      );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A failed test's close, keeping the data root, that stops waiting at the
 * deadline so the evidence is still captured. An abandoned close never
 * removes a root.
 */
function closeW5AppBeforeCapture(electronApp, userDataDir) {
  return untilW5FailureDeadline(
    closeW5AppQuietly(electronApp, userDataDir, { keepUserData: true }),
    'teardown',
  );
}

/**
 * The single owner of a W5 test's data root and its open app, which
 * `launchW5App` and `crashKeepingData` keep current. Call `end` first in the
 * spec's `afterEach`: Playwright 1.64 gives after-hooks a fresh slot of the
 * test timeout, so the close and capture still run after the body times out,
 * and before the spec removes fixtures the app may still use. The body is
 * then abandoned, not stopped: `end` refuses its later launches and crashes,
 * and waits (bounded) for the ones in flight so their app is closed before
 * the capture. After a failure the close is bounded and keeps the root, which
 * is captured once: the root, not the app handle, holds every boot's evidence.
 *
 * Every owner launch passes the test's caller-made root, registered before
 * the launch starts: the launcher keeps a caller root on a rejected launch,
 * so a launch that fails or never returns is still captured. A launch still
 * booting at capture yields a partial main.log.
 */
export function createW5Teardown() {
  let userDataDir;
  let electronApp;
  let ended = false;
  // Set once `end` has chosen the app it closes; a later launch closes itself.
  let closing = false;
  const inFlight = [];
  const start = (operation) => {
    if (ended) throw new Error('W5 test already ended');
    const running = operation();
    inFlight.push(running.catch(() => undefined));
    return running;
  };
  return {
    launch(options, launchApp) {
      if (options.userDataDir === undefined)
        throw new Error('A W5 owner launch needs a caller-made data root');
      if (userDataDir !== undefined && userDataDir !== options.userDataDir)
        throw new Error('A W5 owner keeps one data root per test');
      return start(async () => {
        userDataDir = options.userDataDir;
        const launched = await launchApp(options);
        if (closing) {
          await closeW5AppBeforeCapture(launched.electronApp, userDataDir);
          throw new Error('W5 launch returned after its test ended');
        }
        electronApp = launched.electronApp;
        return launched;
      });
    },
    /** The owner keeps `app` unless `stopApp` resolves. */
    stop(app, stopApp) {
      return start(async () => {
        await stopApp();
        if (electronApp === app) electronApp = undefined;
      });
    },
    async end(failed) {
      ended = true;
      if (!failed) {
        await Promise.all(inFlight);
        closing = true;
        if (electronApp !== undefined)
          await closeCanopy(electronApp, userDataDir);
        return;
      }
      await untilW5FailureDeadline(
        Promise.all(inFlight),
        'launch or crash from the test body',
      );
      closing = true;
      if (electronApp !== undefined)
        await closeW5AppBeforeCapture(electronApp, userDataDir);
      if (userDataDir !== undefined) captureW5FailureDiagnostics(userDataDir);
      // Leak, never block: a resolved close does not prove the runtime
      // stopped, so the data and -secure roots stay; they are temp dirs.
    },
  };
}

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
      ['apps/desktop-app/tests/electron/parity/w5-cli-entry.mjs', ...args],
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
 * project into the index, so later index reads see a settled baseline. With
 * `teardown` (`createW5Teardown`), `options.userDataDir` is required; the
 * launch is started through it and is its app as soon as it returns.
 */
export async function launchW5App(options = {}, teardown = undefined) {
  const launched = await (teardown === undefined
    ? launchCanopy(options)
    : teardown.launch(options, launchCanopy));
  try {
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
  } catch (error) {
    // An adopted launch is closed and captured by its test's teardown.
    // Otherwise kept even when fresh: a resolved close does not prove the
    // runtime stopped.
    if (teardown === undefined)
      await closeW5AppBeforeCapture(launched.electronApp, launched.userDataDir);
    throw error;
  }
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
  if (outcome !== 'exited') keepQuitLogs(userDataDir);
  expect(outcome, 'graceful quit must finish without a forced kill').toBe(
    'exited',
  );
}

/**
 * Copies a timed-out quit's logs into the test's output, which CI uploads on
 * failure: main.log's `[shutdown]` lines time each runtime cleanup stage
 * (CAN-6456). Logs only, never sockets or tokens, and a failed copy never
 * hides the quit failure itself.
 */
function keepQuitLogs(userDataDir) {
  const logs = path.join(userDataDir, 'logs');
  if (!existsSync(logs)) return;
  try {
    cpSync(logs, test.info().outputPath('graceful-quit-logs'), {
      recursive: true,
      filter: (source) => {
        const entry = lstatSync(source);
        return entry.isDirectory() || entry.isFile();
      },
    });
  } catch (error) {
    warnW5Failure('could not keep the quit logs', error);
  }
}

/**
 * Abruptly stops the frozen W5 runtime tree (`crashW5SupervisedRuntime`)
 * without invoking daemon.stop(). A rejection means the stop is unconfirmed,
 * so a caller holding a Git gate keeps it closed.
 */
export async function crashKeepingData(launched, teardown = undefined) {
  const closeCrashed = () =>
    closeCanopy(launched.electronApp, launched.userDataDir, {
      keepUserData: true,
    });
  if (teardown !== undefined) {
    // A refused crash or a failed close leaves the app to `teardown`.
    await teardown.stop(launched.electronApp, async () => {
      await launched.crashW5Runtime();
      await closeCrashed();
    });
    return;
  }
  try {
    await launched.crashW5Runtime();
  } catch (error) {
    // Unbounded: reap the original launch before the caller fails.
    await closeW5AppQuietly(launched.electronApp, launched.userDataDir, {
      keepUserData: true,
    });
    throw error;
  }
  await closeCrashed();
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
