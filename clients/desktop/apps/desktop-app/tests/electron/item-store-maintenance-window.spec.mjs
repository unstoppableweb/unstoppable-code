// CAN-4498 (plan §6.2): the item-store maintenance window against the built
// app. A launch under a held window exits 1 with its refusal on stderr before
// touching a store; a window opened while the app runs refuses host-active.
// The helper is the multi-process golden's child fixture.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import electronPath from 'electron';
import {
  buildE2eLaunchMarkerEnv,
  buildElectronEnv,
  closeCanopy,
  launchCanopyApp,
  platformElectronArgs,
  resolveE2eMainEntryPath,
  resolveLaunchRuntimeRoot,
} from './launchCanopy.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = path.join(
  repoRoot,
  'apps/desktop-app/src/main/lib/__tests__/fixtures/item-store-maintenance-child.ts',
);
const HELPER_READY_TIMEOUT_MS = 30_000;
const REFUSED_LAUNCH_TIMEOUT_MS = 30_000;

// Each case starts the tsx helper and an app launch.
test.setTimeout(120_000);
test.skip(
  process.platform === 'win32',
  'win32 refuses platform-unsupported (Windows debt: CAN-4732 / CAN-4929)',
);

let temporary;
let data;
let external;
const children = new Set();

test.beforeEach(() => {
  // Canonical: the window refuses a data root reached through a symlink.
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'canopy-ism-')));
  data = path.join(temporary, 'data');
  external = path.join(temporary, 'cowork-folder');
  mkdirSync(path.join(data, 'runtime'), { recursive: true, mode: 0o700 });
});

test.afterEach(async () => {
  const exits = [...children].map(
    (child) => new Promise((resolve) => child.once('close', resolve)),
  );
  for (const child of children) {
    try {
      // Detached on POSIX: the group also holds anything the app started.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(exits);
  rmSync(temporary, { recursive: true, force: true });
});

function put(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { mode: 0o600 });
}

function seedStores() {
  const local = path.join(data, 'workspaces/local');
  put(
    path.join(data, 'workspaces/index.json'),
    '{"version":1,"workspaces":[]}',
  );
  put(path.join(local, 'notes/note.json'), '{"version":1,"body":"note"}');
  put(path.join(local, 'notes/note.json.damaged-1'), 'damaged');
  put(path.join(local, 'prompts/prompt.json'), '{"version":1}');
  put(path.join(local, 'CLAUDE.md'), '# Local');
  put(path.join(local, 'repo-rules.json'), '{"version":1,"rules":[]}');
  put(path.join(local, 'worktree-data/main/file-annotations.json'), '{}');
  put(
    path.join(data, 'workspaces/cowork/workspace.json'),
    JSON.stringify({ type: 'cowork', externalPath: external }),
  );
  put(path.join(external, 'README.md'), '# Cowork');
  put(path.join(data, 'runtime/w5-recovery-result.json'), '{"version":1}');
}

/** Digests of every store file and the recovery evidence. */
function storeSnapshot() {
  const files = {};
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        files[path.relative(temporary, file)] = createHash('sha256')
          .update(readFileSync(file))
          .digest('hex');
    }
  };
  for (const root of ['workspaces', 'app-workspaces'])
    walk(path.join(data, root));
  walk(external);
  const evidence = path.join(data, 'runtime/w5-recovery-result.json');
  files[path.relative(temporary, evidence)] = readFileSync(evidence, 'utf8');
  return files;
}

/** The startup claim or CAN-3797 record a window failed to withdraw. */
function leftovers() {
  return ['runtime/startup-claim.json', 'runtime/w5-maintenance.json'].filter(
    (file) => existsSync(path.join(data, file)),
  );
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    detached: true,
    ...options,
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => {
    stdout += String(bytes);
  });
  child.stderr.on('data', (bytes) => {
    stderr += String(bytes);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exited, output: () => stdout };
}

/** The helper's JSON lines. */
function lines(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function startWindow(dataRoot, hold) {
  return run(process.execPath, [
    '--import',
    'tsx',
    fixture,
    'window',
    dataRoot,
    'mutating',
    hold ? 'hold' : '',
  ]);
}

test('a launch under a held window exits 1 with its refusal and changes no store byte', async () => {
  seedStores();
  const helper = startWindow(data, true);
  await expect
    .poll(() => lines(helper.output()), { timeout: HELPER_READY_TIMEOUT_MS })
    .toEqual([{ held: true }]);
  const before = storeSnapshot();

  // Spawned directly: Playwright's launch cannot report an exit this early.
  // Same runtime root as launchCanopy (the lane's staged daemon, if any).
  const runtimeRoot = resolveLaunchRuntimeRoot();
  const launch = run(
    electronPath,
    [...platformElectronArgs(data), resolveE2eMainEntryPath(runtimeRoot)],
    {
      cwd: runtimeRoot,
      env: buildElectronEnv(data, buildE2eLaunchMarkerEnv()),
    },
  );
  let timer;
  const refused = await Promise.race([
    launch.exited,
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ timedOut: true }),
        REFUSED_LAUNCH_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(timer);
  expect(refused.timedOut, 'the refused launch must exit on its own').toBe(
    undefined,
  );
  expect(refused.code, refused.stderr).toBe(1);
  expect(refused.stderr).toContain('Data maintenance is running.');
  expect(storeSnapshot()).toEqual(before);

  helper.child.stdin.end();
  const released = await helper.exited;
  expect(released.code).toBe(0);
  expect(lines(released.stdout)).toEqual([{ held: true }, { released: true }]);
  expect(leftovers()).toEqual([]);
  expect(storeSnapshot()).toEqual(before);
});

test("with the app running, the helper's window refuses host-active", async () => {
  const launched = await launchCanopyApp({ userDataDir: data });
  try {
    const helper = await startWindow(data, false).exited;
    expect(helper.code, helper.stderr).toBe(0);
    // The op never ran: it would have reported { held: true } first.
    const [refusal, ...rest] = lines(helper.stdout);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ reason: 'host-active', held: false });
    // Peers come from the host cohort only, never from the app's presence
    // join; a late `lazy-writer` member is labelled `unknown` off darwin.
    expect(refusal.peers).not.toContain('electron');
    // The app keeps running and serving its window.
    expect(await launched.window.evaluate(() => document.readyState)).toBe(
      'complete',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir, {
      keepUserData: true,
    });
  }
});
