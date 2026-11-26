// W5 behavior baseline (CAN-3697), scenario `worktree_create_local`: pins
// today's desktop worktree create (row-first `git-pending` reservation, then a
// background checkout) and its `worktree_list` / `worktree_checkouts`
// effects, boot recovery of interrupted creates, and races with the CLI's
// checkout-first writer. Titles start `<scenario>/<condition>:`. Record:
// docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-baseline-w5.md
//
// Determinism: a seeded single-repo project over a local repository, no
// network, no live agents. Interrupted states are seeded exactly as a crash
// leaves them; the CLI race is held open by a Git hook gate (the app runs
// `git worktree add` with hooks disabled, so the gate holds only the CLI).

import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from '../launchCanopy.mjs';
import { writeJson } from '../seeders/fsHelpers.mjs';
import {
  checkoutPath,
  crashKeepingData,
  createW5Teardown,
  GATE_WORKTREE_ADD,
  gateEntries,
  git,
  heldGitCommandCount,
  initBareRemote,
  initRepo,
  installCheckoutGate,
  invokeExpectingError,
  launchW5App,
  quitGracefullyKeepingData,
  readWorktreeRows,
  reapCliChildren,
  registeredWorktreePaths,
  releaseGate,
  releaseGitGate,
  runCli,
  seedSingleRepoProject,
  worktreeListPath,
  writeGatedGitShim,
} from './w5-fixtures.mjs';

const PROJECT_ID = 'alpha';

let fixtures;
let userDataDir;
let repoPath;
let w5Teardown;

test.beforeEach(() => {
  w5Teardown = createW5Teardown();
  fixtures = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-worktree-')),
  );
  userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-worktree-data-')),
  );
  repoPath = initRepo(path.join(fixtures, 'alpha'));
  seedSingleRepoProject(userDataDir, {
    id: PROJECT_ID,
    name: 'Alpha',
    repoPath,
  });
});

test.afterEach(async ({}, testInfo) => {
  try {
    await w5Teardown.end(testInfo.status !== testInfo.expectedStatus);
  } finally {
    reapCliChildren();
    rmSync(fixtures, { recursive: true, force: true });
  }
});

function createWorktree(window, request) {
  return window.evaluate((value) => window.api.createWorktree(value), {
    projectId: PROJECT_ID,
    repoPath,
    existingWorktreeIds: [],
    ...request,
  });
}

function rowSummaries() {
  return readWorktreeRows(userDataDir, PROJECT_ID).map((row) => ({
    id: row.id,
    branchName: row.branchName,
    setupPhase: row.setupPhase,
  }));
}

function checkout(worktreeId) {
  return checkoutPath(userDataDir, PROJECT_ID, worktreeId);
}

async function waitForReadyRows(expectedIds) {
  await expect
    .poll(
      () =>
        rowSummaries()
          .filter((row) => row.setupPhase === 'git-ready')
          .map((row) => row.id)
          .sort(),
      { timeout: 30_000 },
    )
    .toEqual([...expectedIds].sort());
}

/**
 * Boot recovery runs after the first projects load. An interrupted create with
 * an operation identity is never removed or promoted: the next launch keeps
 * its pending row and marks it recovery-required (CAN-3814).
 */
async function waitForRecoveryRequiredRow(response) {
  await expect
    .poll(
      () =>
        readWorktreeRows(userDataDir, PROJECT_ID).map((row) => ({
          id: row.id,
          branchName: row.branchName,
          setupPhase: row.setupPhase,
          state: row.creation?.state,
          phase: row.creation?.phase,
          health: row.healthIssue?.status,
        })),
      { timeout: 30_000 },
    )
    .toEqual([
      {
        id: response.id,
        branchName: 'held',
        setupPhase: 'git-pending',
        state: 'recovery-required',
        phase: 'git-setup',
        health: 'broken',
      },
    ]);
}

test('worktree_create_local/normal: worktree:create commits a git-pending row first, then checks out the base branch and promotes the row', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const response = await createWorktree(launched.window, {
      baseBranch: 'main',
    });

    expect(response).toMatchObject({
      trackedBaseBranch: 'main',
      setupPhase: 'git-pending',
    });
    // Default branch: `<worktree id>-<epoch ms>`.
    expect(response.branchName).toMatch(new RegExp(`^${response.id}-\\d+$`));
    // The row is durable before the response; the checkout may still be running.
    expect(rowSummaries()).toEqual([
      expect.objectContaining({
        id: response.id,
        branchName: response.branchName,
      }),
    ]);

    await waitForReadyRows([response.id]);
    expect(readWorktreeRows(userDataDir, PROJECT_ID)[0]).toMatchObject({
      id: response.id,
      createdAt: response.createdAt,
      trackedBaseBranch: 'main',
    });
    expect(registeredWorktreePaths(repoPath)).toEqual([checkout(response.id)]);
    expect(git(checkout(response.id), ['rev-parse', 'HEAD'])).toBe(
      git(repoPath, ['rev-parse', 'main']),
    );
    expect(
      git(checkout(response.id), ['symbolic-ref', '--short', 'HEAD']),
    ).toBe(response.branchName);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

/** Imports a source repo whose manifest lists one child repo. */
async function importMultiRepoProject(window, { gitignoreRepos }) {
  const childRemote = initBareRemote(fixtures, 'child');
  const sourceRepo = initRepo(path.join(fixtures, 'suite'));
  writeFileSync(
    path.join(sourceRepo, 'canopy.json'),
    `${JSON.stringify(
      { version: 1, repos: [{ id: 'child', name: 'child', url: childRemote }] },
      null,
      2,
    )}\n`,
  );
  const files = ['canopy.json'];
  if (gitignoreRepos) {
    writeFileSync(path.join(sourceRepo, '.gitignore'), 'repos/\n');
    files.push('.gitignore');
  }
  git(sourceRepo, ['add', ...files]);
  git(sourceRepo, ['commit', '-q', '-m', 'manifest']);
  const imported = await window.evaluate(
    (request) => window.api.importWorkspaceFromRepo(request),
    { repoPath: sourceRepo },
  );
  return imported.workspace.id;
}

test('worktree_create_local/normal: workspace:create-worktree checks out the source repo and each project repo, then promotes the row', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const workspaceId = await importMultiRepoProject(launched.window, {
      gitignoreRepos: true,
    });

    const response = await launched.window.evaluate(
      (request) => window.api.createWorkspaceWorktree(request),
      { workspaceId, existingWorktreeIds: [], baseBranch: 'main' },
    );

    expect(response).toMatchObject({ setupPhase: 'git-pending' });
    await expect
      .poll(
        () =>
          readWorktreeRows(userDataDir, workspaceId).map((row) => [
            row.id,
            row.setupPhase,
          ]),
        { timeout: 30_000 },
      )
      .toEqual([[response.id, 'git-ready']]);
    const root = checkoutPath(userDataDir, workspaceId, response.id);
    expect(existsSync(path.join(root, 'canopy.json'))).toBe(true);
    expect(existsSync(path.join(root, 'repos', 'child', '.git'))).toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/normal: workspace:create-worktree on a source repo that needs repair keeps the acknowledged row pending for recovery and keeps the root checkout', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const workspaceId = await importMultiRepoProject(launched.window, {
      gitignoreRepos: false,
    });

    const response = await launched.window.evaluate(
      (request) => window.api.createWorkspaceWorktree(request),
      { workspaceId, existingWorktreeIds: [], baseBranch: 'main' },
    );

    expect(response).toMatchObject({ setupPhase: 'git-pending' });
    // The root checkout may exist, so the row is never rolled back or marked
    // ready: it waits, pending, for an explicit repair (CAN-3814).
    await expect
      .poll(
        () =>
          readWorktreeRows(userDataDir, workspaceId).map((row) => ({
            id: row.id,
            setupPhase: row.setupPhase,
            state: row.creation?.state,
            phase: row.creation?.phase,
          })),
        { timeout: 30_000 },
      )
      .toEqual([
        {
          id: response.id,
          setupPhase: 'git-pending',
          state: 'recovery-required',
          phase: 'source-root-repair',
        },
      ]);
    const root = checkoutPath(userDataDir, workspaceId, response.id);
    expect(existsSync(path.join(root, 'canopy.json'))).toBe(true);
    expect(existsSync(path.join(root, 'repos'))).toBe(false);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/idempotent_retry: replaying a request creates a second worktree, and replaying a used branch name is rejected', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  const { window } = launched;
  try {
    const first = await createWorktree(window, {});
    const second = await createWorktree(window, {});
    const named = await createWorktree(window, { branchName: 'feature-x' });
    await waitForReadyRows([first.id, second.id, named.id]);

    const retry = await invokeExpectingError(window, 'createWorktree', {
      projectId: PROJECT_ID,
      repoPath,
      existingWorktreeIds: [],
      branchName: 'feature-x',
    });

    expect(new Set([first.id, second.id, named.id]).size).toBe(3);
    expect(first.branchName).not.toBe(second.branchName);
    expect(retry).toContain('Branch name "feature-x" is already in use');
    expect(registeredWorktreePaths(repoPath)).toEqual(
      [checkout(first.id), checkout(second.id), checkout(named.id)].sort(),
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/concurrent_client: two parallel app creates serialize into rows with distinct ids, branches, and checkouts', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const [left, right] = await Promise.all([
      createWorktree(launched.window, { branchName: 'left' }),
      createWorktree(launched.window, { branchName: 'right' }),
    ]);
    await waitForReadyRows([left.id, right.id]);

    expect(left.id).not.toBe(right.id);
    expect(registeredWorktreePaths(repoPath)).toEqual(
      [checkout(left.id), checkout(right.id)].sort(),
    );
    expect(git(checkout(left.id), ['symbolic-ref', '--short', 'HEAD'])).toBe(
      'left',
    );
    expect(git(checkout(right.id), ['symbolic-ref', '--short', 'HEAD'])).toBe(
      'right',
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/concurrent_client: of two parallel app creates of one branch name, one is acknowledged and checked out and the other is refused before its row or checkout', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const settled = await Promise.allSettled([
      createWorktree(launched.window, { branchName: 'race' }),
      createWorktree(launched.window, { branchName: 'race' }),
    ]);
    const acknowledged = settled.filter(
      (result) => result.status === 'fulfilled',
    );
    const refused = settled.filter((result) => result.status === 'rejected');
    expect(acknowledged).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The pending-row decision reserves the branch, so the loser never
    // reaches Git (CAN-3814).
    expect(String(refused[0].reason)).toContain(
      'Branch name "race" is already in use',
    );
    const winner = acknowledged[0].value;
    await waitForReadyRows([winner.id]);

    expect(rowSummaries()).toEqual([
      { id: winner.id, branchName: 'race', setupPhase: 'git-ready' },
    ]);
    expect(registeredWorktreePaths(repoPath)).toEqual([checkout(winner.id)]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/concurrent_client: a CLI create that read the list before an app create preserves the app row and checkout', async () => {
  test.skip(
    process.platform === 'win32',
    'The race gate is a POSIX shell hook.',
  );
  test.setTimeout(120_000);
  const launched = await launchW5App({ userDataDir });
  try {
    const gateDir = path.join(fixtures, 'gate');
    installCheckoutGate(repoPath, gateDir);
    const cli = runCli(userDataDir, [
      'workspace',
      'worktrees',
      PROJECT_ID,
      'create',
      '--branch',
      'from-cli',
    ]);
    // The CLI has read the empty list and is inside `git worktree add`.
    await expect
      .poll(() => gateEntries(gateDir), { timeout: 30_000 })
      .toContain('from-cli');

    const appCreated = await createWorktree(launched.window, {
      branchName: 'from-app',
    });
    await waitForReadyRows([appCreated.id]);
    releaseGate(gateDir, 'from-cli');
    const result = await cli;

    expect(result.code).toBe(0);
    expect(rowSummaries().map((row) => row.id)).toEqual([
      'from-cli',
      appCreated.id,
    ]);
    // Publication rereads after Git; both acknowledged checkouts stay tracked.
    expect(registeredWorktreePaths(repoPath)).toEqual(
      [checkout(appCreated.id), checkout('from-cli')].sort(),
    );
    const listed = await runCli(userDataDir, [
      'workspace',
      'worktrees',
      PROJECT_ID,
      'list',
    ]);
    expect(listed.code).toBe(0);
    expect(
      listed.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((row) => row.split('\t')[0]),
    ).toEqual(['from-cli', appCreated.id]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

/**
 * Starts a create whose background `git worktree add` is held by the Git
 * shim, then applies `interrupt` while the row is committed `git-pending`.
 */
async function interruptHeldCreate(interrupt) {
  const gateDir = path.join(fixtures, 'gate');
  const launched = await launchW5App({
    userDataDir,
    env: {
      CANOPY_GIT_EXECUTABLE: writeGatedGitShim(gateDir, GATE_WORKTREE_ADD),
    },
  });
  let response;
  try {
    response = await createWorktree(launched.window, { branchName: 'held' });
    await expect
      .poll(() => heldGitCommandCount(gateDir), { timeout: 30_000 })
      .toBe(1);
    expect(rowSummaries()).toEqual([
      { id: response.id, branchName: 'held', setupPhase: 'git-pending' },
    ]);
  } catch (error) {
    // The interrupt never ran, so this helper still owns the app. The close
    // does not confirm a stop either, so the gate stays closed.
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    }).catch(() => undefined);
    throw error;
  }

  // A rejected interrupt has not confirmed the runtime stopped, so the gate
  // stays closed; the held command exits with the process that ran it.
  await interrupt(launched);
  try {
    // Row-first: the reservation is durable, the checkout never started.
    expect(rowSummaries()).toEqual([
      { id: response.id, branchName: 'held', setupPhase: 'git-pending' },
    ]);
    expect(existsSync(checkout(response.id))).toBe(false);
  } finally {
    releaseGitGate(gateDir);
  }
  return response;
}

test('worktree_create_local/graceful_shutdown: a quit while git worktree add is held leaves the git-pending row, which the next launch keeps for recovery', async () => {
  test.skip(
    process.platform === 'win32',
    'The Git gate is a POSIX shell shim.',
  );
  test.setTimeout(150_000);
  let launched;
  try {
    const response = await interruptHeldCreate((app) =>
      quitGracefullyKeepingData(app.electronApp, userDataDir),
    );

    launched = await launchW5App({ userDataDir });
    await waitForRecoveryRequiredRow(response);

    expect(existsSync(checkout(response.id))).toBe(false);
    expect(registeredWorktreePaths(repoPath)).toEqual([]);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/crash_restart: SIGKILL while git worktree add is held leaves the git-pending row, which the next launch keeps for recovery', async () => {
  test.skip(
    process.platform === 'win32',
    'The Git gate is a POSIX shell shim.',
  );
  test.setTimeout(150_000);
  let launched;
  try {
    const response = await interruptHeldCreate((app) => crashKeepingData(app));

    launched = await launchW5App({ userDataDir });
    await waitForRecoveryRequiredRow(response);

    expect(existsSync(checkout(response.id))).toBe(false);
    expect(registeredWorktreePaths(repoPath)).toEqual([]);
  } finally {
    if (launched) await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('worktree_create_local/crash_restart: next launch promotes a git-pending row with a checkout, drops one without, archives a ready row whose checkout is gone, and never lists an unrecorded checkout', async () => {
  test.setTimeout(120_000);
  const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  // State a crash leaves at each point of today's row-first create.
  git(repoPath, [
    'worktree',
    'add',
    '-q',
    '-b',
    'pending-with-checkout',
    checkout('pending-with-checkout'),
  ]);
  git(repoPath, ['worktree', 'add', '-q', '-b', 'orphan', checkout('orphan')]);
  writeJson(worktreeListPath(userDataDir, PROJECT_ID), {
    version: 1,
    worktrees: [
      {
        id: 'pending-with-checkout',
        branchName: 'pending-with-checkout',
        createdAt,
        setupPhase: 'git-pending',
      },
      {
        id: 'pending-without-checkout',
        branchName: 'pending-without-checkout',
        createdAt,
        setupPhase: 'git-pending',
      },
      {
        id: 'ready-without-checkout',
        branchName: 'ready-without-checkout',
        createdAt,
      },
    ],
  });

  const launched = await launchW5App({ userDataDir }, w5Teardown);
  await expect
    .poll(() => rowSummaries(), { timeout: 30_000 })
    .toEqual([
      {
        id: 'pending-with-checkout',
        branchName: 'pending-with-checkout',
        setupPhase: 'git-ready',
      },
    ]);
  const listed = await launched.window.evaluate(async (projectId) => {
    const { items } = await window.api.loadProjects();
    return items
      .find((item) => item.id === projectId)
      ?.worktrees.map((row) => row.id);
  }, PROJECT_ID);
  expect(listed).toEqual(['pending-with-checkout']);
  // The checkout with no row stays on disk and registered, reported nowhere.
  expect(existsSync(checkout('orphan'))).toBe(true);
  expect(registeredWorktreePaths(repoPath)).toContain(checkout('orphan'));
});

test('worktree_create_local/client_disconnect: a renderer reload while git worktree add is held still completes the checkout and promotes the row', async () => {
  test.skip(
    process.platform === 'win32',
    'The Git gate is a POSIX shell shim.',
  );
  test.setTimeout(90_000);
  const gateDir = path.join(fixtures, 'gate');
  const launched = await launchW5App({
    userDataDir,
    env: {
      CANOPY_GIT_EXECUTABLE: writeGatedGitShim(gateDir, GATE_WORKTREE_ADD),
    },
  });
  try {
    const response = await createWorktree(launched.window, {
      branchName: 'after-reload',
    });
    await expect
      .poll(() => heldGitCommandCount(gateDir), { timeout: 30_000 })
      .toBe(1);

    await launched.window.reload();
    releaseGitGate(gateDir);

    await waitForReadyRows([response.id]);
    expect(registeredWorktreePaths(repoPath)).toEqual([checkout(response.id)]);
    expect(
      git(checkout(response.id), ['symbolic-ref', '--short', 'HEAD']),
    ).toBe('after-reload');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
