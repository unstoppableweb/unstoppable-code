import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { closeCanopy } from '../launchCanopy.mjs';

// Real children wait on filesystem barriers; there are no timing sleeps or
// reruns. The descendant acknowledges readiness over IPC before cancellation.
export const FIXTURE_DIR = '.runner-contract';
export const WORKTREE_ID = 'demo-main';

export function seedRunnerFixture(worktreePath, mode) {
  const dir = path.join(worktreePath, FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'runner.cjs'),
    `
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const mode = ${JSON.stringify(mode)};
const file = (name) => path.join(__dirname, name);
function barrier(name) {
  return new Promise((resolve) => {
    const watcher = fs.watch(__dirname, check);
    function check() {
      if (fs.existsSync(file(name))) { watcher.close(); resolve(); }
    }
    check();
  });
}
if (process.argv[2] === 'descendant') {
  fs.watch(__dirname, () => {});
  process.on('SIGTERM', () => {
    fs.writeFileSync(file('descendant.term'), 'received');
    if (mode === 'cooperative') process.exit(0);
  });
  process.send({ pid: process.pid });
} else if (mode === 'stream') {
  (async () => {
    const partial = barrier('partial.release');
    process.stdout.write('RUNNER_STDOUT_READY\\n');
    process.stderr.write('RUNNER_STDERR_READY\\n');
    await partial;
    const exit = barrier('exit.release');
    process.stdout.write('RUNNER_SPLIT_', () => {
      fs.writeFileSync(file('partial.ready'), 'written');
    });
    await exit;
    process.stdout.write('COMPLETE\\nRUNNER_FINAL_TAIL');
    process.exitCode = 23;
  })().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  const child = fork(__filename, ['descendant'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  fs.watch(__dirname, () => {});
  process.on('SIGTERM', () => {
    fs.writeFileSync(file('parent.term'), 'received');
    if (mode === 'cooperative') {
      if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
      else child.once('exit', () => process.exit(0));
    }
  });
  child.once('message', ({ pid }) => {
    fs.writeFileSync(file('pids.json'), JSON.stringify([process.pid, pid]));
    process.stdout.write('RUNNER_DESCENDANT_READY\\n');
    process.stderr.write('RUNNER_CANCEL_STDERR_READY\\n');
  });
}
`,
    'utf8',
  );
  return dir;
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function readOwnedPids(dir) {
  const file = path.join(dir, 'pids.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export async function expectOwnedProcessesGone(
  dir,
  { expectTerm = true } = {},
) {
  const pids = readOwnedPids(dir);
  expect(pids).toHaveLength(2);
  await expect
    .poll(() => pids.filter(processExists), {
      message: 'cancel must reap the fixture and its owned descendant',
      timeout: 15_000,
    })
    .toEqual([]);
  if (expectTerm) {
    expect(existsSync(path.join(dir, 'parent.term'))).toBe(true);
    expect(existsSync(path.join(dir, 'descendant.term'))).toBe(true);
  }
}

export async function releasePartialAndExit(dir) {
  writeFileSync(path.join(dir, 'partial.release'), 'release');
  await expect
    .poll(() => existsSync(path.join(dir, 'partial.ready')))
    .toBe(true);
  writeFileSync(path.join(dir, 'exit.release'), 'release');
}

export async function expectFinalOutput(output) {
  for (const marker of [
    'RUNNER_STDOUT_READY',
    'RUNNER_STDERR_READY',
    'RUNNER_SPLIT_COMPLETE',
    'RUNNER_FINAL_TAIL',
  ]) {
    await expect(output).toContainText(marker);
    expect((await output.textContent()).split(marker)).toHaveLength(2);
  }
}

export async function cleanupFixture(electronApp, userDataDir, dir) {
  // Release a failed stream assertion before the production harness reaps
  // the supervised tree and its recorded process groups.
  writeFileSync(path.join(dir, 'partial.release'), 'cleanup');
  writeFileSync(path.join(dir, 'exit.release'), 'cleanup');
  await closeCanopy(electronApp, userDataDir);
}
