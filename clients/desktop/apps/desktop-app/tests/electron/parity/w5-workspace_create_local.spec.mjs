// W5 behavior baseline (CAN-3697), scenario `workspace_create_local`: pins
// today's desktop create/import behavior and its `workspace_index`,
// `workspace_manifest`, and `worktree_list` effects so the W5 writer transfer
// keeps it green. Titles start `<scenario>/<condition>:`. Hazards these tests
// pin are listed in
// docs/planning/2026-07-31-desktop-core-daemon/artifacts/behavior-baseline-w5.md
//
// Determinism: seeded local repositories and bare remotes, no network, no
// live agents. Races are forced through Git hook gates in the CLI process.

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
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { closeCanopy } from '../launchCanopy.mjs';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  crashKeepingData,
  createW5Teardown,
  git,
  GATE_CLONE,
  gitHooksPathEnv,
  heldGitCommandCount,
  indexPath,
  initBareRemote,
  initRepo,
  invokeExpectingError,
  invokeWithoutAwaiting,
  launchW5App,
  loadProjectIds,
  orphanManifestIds,
  quitGracefullyKeepingData,
  readIndex,
  readIndexEntry,
  readIndexIds,
  readManifest,
  reapCliChildren,
  releaseGitGate,
  runCli,
  writeGatedGitShim,
} from './w5-fixtures.mjs';

let fixtures;
let w5Teardown;
test.beforeEach(() => {
  w5Teardown = createW5Teardown();
  fixtures = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-create-')),
  );
});
test.afterEach(async ({}, testInfo) => {
  try {
    await w5Teardown.end(testInfo.status !== testInfo.expectedStatus);
  } finally {
    reapCliChildren();
    rmSync(fixtures, { recursive: true, force: true });
  }
});

async function openCreateProjectForm(window) {
  await window.getByTestId('sidebar-section-code-toggle').hover();
  await window.getByTestId('sidebar-section-code-add').click();
  await expect(
    window.getByRole('heading', { name: 'Add project' }),
  ).toBeVisible();
  await window.getByRole('button', { name: 'Create new' }).click();
}

/**
 * Workspace creation identities in the app's W5 commit log. The app holds the
 * log exclusively, so read it only while the app is stopped. A creation
 * interrupted by quit stays reserved until relaunch marks it
 * recovery-required (CAN-3813).
 */
function workspaceCreationReservations(userDataDir) {
  const db = new DatabaseSync(
    path.join(userDataDir, 'w5', 'commit-log.sqlite'),
    { readOnly: true },
  );
  try {
    return db
      .prepare('SELECT state, diagnostics_json FROM w5_reservations')
      .all()
      .map((row) => ({
        state: row.state,
        diagnostics: JSON.parse(row.diagnostics_json),
      }))
      .filter((row) => row.diagnostics?.kind === 'local-workspace-create');
  } finally {
    db.close();
  }
}

function manifestRepoWithChild(name) {
  const childRemote = initBareRemote(fixtures, `${name}-child`);
  const repoPath = initRepo(path.join(fixtures, name));
  writeFileSync(
    path.join(repoPath, 'canopy.json'),
    `${JSON.stringify(
      { version: 1, repos: [{ id: 'child', name: 'child', url: childRemote }] },
      null,
      2,
    )}\n`,
  );
  git(repoPath, ['add', 'canopy.json']);
  git(repoPath, ['commit', '-q', '-m', 'manifest']);
  return repoPath;
}

test('workspace_create_local/normal: workspace:create-new and workspace:create from the Add project dialog index one entry each with its manifest', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    await openCreateProjectForm(window);
    await window.getByLabel('Project name').fill('Single One');
    await window.getByRole('button', { name: 'Create project' }).click();

    await expect
      .poll(() => readIndexIds(userDataDir))
      .toEqual([DEFAULT_COWORK_WORKSPACE_ID, 'single-one']);
    const singleRepoPath = path.join(userDataDir, 'repos', 'single-one');
    // The index can land before the backup and manifest on a loaded machine,
    // so these reads retry rather than assume the files exist.
    await expect(() => {
      // The rolling backup holds the index as it was before this write.
      expect(
        JSON.parse(
          readFileSync(`${indexPath(userDataDir)}.bak`, 'utf8'),
        ).workspaces.map((entry) => entry.id),
      ).toEqual([DEFAULT_COWORK_WORKSPACE_ID]);
      expect(readManifest(userDataDir, 'single-one')).toMatchObject({
        version: 1,
        type: 'single-repo',
        repoPath: singleRepoPath,
      });
    }).toPass();
    expect(readIndexEntry(userDataDir, 'single-one')).toMatchObject({
      name: 'Single One',
      type: 'single-repo',
      order: 1,
    });
    expect(existsSync(path.join(singleRepoPath, 'canopy.json'))).toBe(true);

    await openCreateProjectForm(window);
    await window.getByRole('button', { name: 'Multi-Repo' }).click();
    await window.getByLabel('Project name').fill('Multi One');
    await window.getByRole('button', { name: 'Create project' }).click();

    // workspace:create writes the manifest and a source repo and indexes the
    // project in the same commit (CAN-3806, CAN-3799 D11).
    await expect
      .poll(() => readIndexIds(userDataDir))
      .toEqual([DEFAULT_COWORK_WORKSPACE_ID, 'single-one', 'multi-one']);
    expect(readIndexEntry(userDataDir, 'multi-one')).toMatchObject({
      name: 'Multi One',
      type: 'multi-repo',
    });
    await expect(() =>
      expect(readManifest(userDataDir, 'multi-one')).toMatchObject({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: path.join(userDataDir, 'repos', 'multi-one'),
      }),
    ).toPass();
    expect(
      existsSync(path.join(userDataDir, 'repos', 'multi-one', '.git')),
    ).toBe(true);
    expect(orphanManifestIds(userDataDir)).toEqual([]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

function sourceRepoShape(repoPath) {
  return {
    files: git(repoPath, ['ls-files']).split('\n').sort(),
    commits: git(repoPath, ['log', '--format=%s']),
    gitignore: readFileSync(path.join(repoPath, '.gitignore'), 'utf8'),
    manifest: JSON.parse(
      readFileSync(path.join(repoPath, 'canopy.json'), 'utf8'),
    ),
  };
}

test('workspace_create_local/normal: an empty multi-repo project created by the CLI gets the same source repo as one created in the app (CAN-3799)', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    await openCreateProjectForm(window);
    await window.getByRole('button', { name: 'Multi-Repo' }).click();
    await window.getByLabel('Project name').fill('Multi One');
    await window.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => readIndexIds(userDataDir)).toContain('multi-one');

    const cli = await runCli(userDataDir, [
      'workspace',
      'create',
      'new',
      'multi-repo',
      'Multi Two',
    ]);

    expect(cli.code).toBe(0);
    const appSourceRepo = path.join(userDataDir, 'repos', 'multi-one');
    const cliSourceRepo = path.join(userDataDir, 'repos', 'multi-two');
    expect(JSON.parse(cli.stdout)).toMatchObject({
      id: 'multi-two',
      type: 'multi-repo',
      rootPath: cliSourceRepo,
      sourceRepoPath: cliSourceRepo,
    });
    expect(readManifest(userDataDir, 'multi-two')).toEqual({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: cliSourceRepo,
    });
    expect(sourceRepoShape(cliSourceRepo)).toEqual(
      sourceRepoShape(appSourceRepo),
    );
    expect(sourceRepoShape(cliSourceRepo)).toMatchObject({
      files: ['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'canopy.json'],
      commits: 'Initialize project source repo',
    });
    expect(orphanManifestIds(userDataDir)).toEqual([]);
    expect(await loadProjectIds(window)).toEqual(readIndexIds(userDataDir));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/normal: workspace:add-from-folder indexes a repo or a plain folder and rejects tracked and nested folders; workspace:add-from-remote and workspace:import-from-repo clone from local remotes', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    const repoPath = initRepo(path.join(fixtures, 'alpha'));
    const notes = path.join(fixtures, 'notes');
    mkdirSync(path.join(notes, 'sub'), { recursive: true });
    const remote = initBareRemote(fixtures, 'beta');
    const clones = path.join(fixtures, 'clones');
    const suite = manifestRepoWithChild('suite');

    const alpha = await window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      { repoPath },
    );
    const notesItem = await window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      { repoPath: notes },
    );
    const tracked = await invokeExpectingError(
      window,
      'addWorkspaceFromFolder',
      { repoPath },
    );
    const nested = await invokeExpectingError(
      window,
      'addWorkspaceFromFolder',
      {
        repoPath: path.join(notes, 'sub'),
      },
    );
    const beta = await window.evaluate(
      (request) => window.api.addWorkspaceFromRemote(request),
      { remoteUrl: remote, destinationDir: clones },
    );
    const imported = await window.evaluate(
      (request) => window.api.importWorkspaceFromRepo(request),
      { repoPath: suite },
    );

    expect(alpha).toMatchObject({ id: 'alpha', type: 'single-repo', repoPath });
    // Adding a repository writes the project config file into it.
    expect(
      JSON.parse(readFileSync(path.join(repoPath, 'canopy.json'), 'utf8')),
    ).toEqual({
      version: 1,
    });
    expect(notesItem).toMatchObject({
      id: 'notes',
      type: 'cowork',
      externalPath: notes,
    });
    expect(tracked).toContain(
      'This repository is already tracked as project "alpha"',
    );
    expect(nested).toContain(
      'Cannot add a folder nested inside an existing project',
    );
    expect(beta).toMatchObject({
      id: 'beta',
      type: 'single-repo',
      repoPath: path.join(clones, 'beta'),
    });
    expect(
      git(path.join(clones, 'beta'), ['remote', 'get-url', 'origin']),
    ).toBe(remote);
    // Importing a manifest repo also indexes each cloned repo as its own project.
    expect(imported).toMatchObject({
      workspace: { id: 'suite', type: 'multi-repo', sourceRepoPath: suite },
      clonedRepoIds: ['child'],
    });
    expect(
      readIndex(userDataDir).workspaces.map((entry) => [entry.id, entry.type]),
    ).toEqual([
      [DEFAULT_COWORK_WORKSPACE_ID, 'cowork'],
      ['alpha', 'single-repo'],
      ['notes', 'cowork'],
      ['beta', 'single-repo'],
      ['suite', 'multi-repo'],
      ['child', 'single-repo'],
    ]);
    expect(readManifest(userDataDir, 'suite')).toMatchObject({
      type: 'multi-repo',
      sourceRepoPath: suite,
      repos: [
        expect.objectContaining({
          id: 'child',
          repoPath: path.join(userDataDir, 'repos', 'child'),
          source: 'manifest',
        }),
      ],
    });
    expect(orphanManifestIds(userDataDir)).toEqual([]);
    expect(await loadProjectIds(window)).toEqual(readIndexIds(userDataDir));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/normal: workspace:add-from-folder rejects a folder that does not exist without registering or creating it (CAN-3799)', async () => {
  test.setTimeout(90_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    const missing = path.join(fixtures, 'does-not-exist');
    const indexBefore = readIndexIds(userDataDir);

    const error = await invokeExpectingError(window, 'addWorkspaceFromFolder', {
      repoPath: missing,
    });

    expect(error).toContain(
      `Couldn't add the folder because it doesn't exist: ${missing}. Choose an existing folder.`,
    );
    expect(existsSync(missing)).toBe(false);
    expect(readIndexIds(userDataDir)).toEqual(indexBefore);
    expect(readIndexIds(userDataDir)).not.toContain('does-not-exist');
    expect(
      existsSync(path.join(userDataDir, 'workspaces', 'does-not-exist')),
    ).toBe(false);
    expect(orphanManifestIds(userDataDir)).toEqual([]);
    expect(await loadProjectIds(window)).toEqual(readIndexIds(userDataDir));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/idempotent_retry: repeated creates duplicate (create-new, add-from-remote, create) or reject (add-from-folder, import-from-repo); no create takes a replay key', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    const repoPath = initRepo(path.join(fixtures, 'alpha'));
    const remote = initBareRemote(fixtures, 'beta');
    const clones = path.join(fixtures, 'clones');
    const suite = manifestRepoWithChild('suite');
    const create = (method, request) =>
      window.evaluate(({ method, request }) => window.api[method](request), {
        method,
        request,
      });

    const firstNew = await create('createNewWorkspace', { name: 'Gamma App' });
    const secondNew = await create('createNewWorkspace', { name: 'Gamma App' });
    const firstRemote = await create('addWorkspaceFromRemote', {
      remoteUrl: remote,
      destinationDir: clones,
    });
    const secondRemote = await create('addWorkspaceFromRemote', {
      remoteUrl: remote,
      destinationDir: clones,
    });
    await create('addWorkspaceFromFolder', { repoPath });
    const folderRetry = await invokeExpectingError(
      window,
      'addWorkspaceFromFolder',
      {
        repoPath,
      },
    );
    await create('importWorkspaceFromRepo', { repoPath: suite });
    const importRetry = await invokeExpectingError(
      window,
      'importWorkspaceFromRepo',
      {
        repoPath: suite,
      },
    );
    const firstMulti = await create('createWorkspace', { name: 'Delta Multi' });
    const secondMulti = await create('createWorkspace', {
      name: 'Delta Multi',
    });

    expect(firstNew).toMatchObject({
      id: 'gamma-app',
      repoPath: path.join(userDataDir, 'repos', 'gamma-app'),
    });
    expect(secondNew).toMatchObject({
      id: 'gamma-app-2',
      repoPath: path.join(userDataDir, 'repos', 'gamma-app-2'),
    });
    expect(firstRemote).toMatchObject({
      id: 'beta',
      repoPath: path.join(clones, 'beta'),
    });
    expect(secondRemote).toMatchObject({
      id: 'beta-2',
      repoPath: path.join(clones, 'beta-2'),
    });
    expect(readdirSync(clones).sort()).toEqual(['beta', 'beta-2']);
    expect(folderRetry).toContain(
      'This repository is already tracked as project "alpha"',
    );
    expect(importRetry).toContain(
      'This source repo is already attached to project "suite"',
    );
    expect([firstMulti.id, secondMulti.id]).toEqual([
      'delta-multi',
      'delta-multi-2',
    ]);
    // Each multi-repo create is indexed in its own commit (CAN-3806).
    expect(orphanManifestIds(userDataDir)).toEqual([]);
    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'gamma-app',
      'gamma-app-2',
      'beta',
      'beta-2',
      'alpha',
      'suite',
      'child',
      'delta-multi',
      'delta-multi-2',
    ]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/graceful_shutdown: an acknowledged create survives a graceful quit; a quit while add-from-remote is inside git clone indexes nothing and keeps its checkout and identity for recovery (CAN-3813)', async () => {
  test.skip(
    process.platform === 'win32',
    'The Git gate is a POSIX shell shim.',
  );
  test.setTimeout(150_000);
  const gateDir = path.join(fixtures, 'gate');
  const env = {
    CANOPY_GIT_EXECUTABLE: writeGatedGitShim(gateDir, GATE_CLONE),
  };
  let launched = await launchW5App({ env });
  const { userDataDir } = launched;
  try {
    const acknowledged = initRepo(path.join(fixtures, 'acked'));
    await launched.window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      { repoPath: acknowledged },
    );
    const clones = path.join(fixtures, 'clones');
    const remoteUrl = initBareRemote(fixtures, 'beta');
    await invokeWithoutAwaiting(launched.window, 'addWorkspaceFromRemote', {
      remoteUrl,
      destinationDir: clones,
    });
    await expect
      .poll(() => heldGitCommandCount(gateDir), { timeout: 30_000 })
      .toBe(1);

    await quitGracefullyKeepingData(launched.electronApp, userDataDir);

    // atomic_rename: the prior or the new file, never a partial one.
    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'acked',
    ]);
    // The reserved checkout and its identity outlive the quit; recovery is
    // manual, never automatic deletion or resumption.
    const interrupted = path.join(clones, 'beta');
    expect(existsSync(interrupted)).toBe(true);
    expect(workspaceCreationReservations(userDataDir)).toEqual([
      expect.objectContaining({
        diagnostics: expect.objectContaining({ workspaceId: 'beta' }),
      }),
    ]);

    releaseGitGate(gateDir);
    launched = await launchW5App({ userDataDir });
    expect(await loadProjectIds(launched.window)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'acked',
    ]);
    expect(readManifest(userDataDir, 'acked')).toMatchObject({
      repoPath: acknowledged,
    });
    expect(orphanManifestIds(userDataDir)).toEqual([]);

    // A retry of the same remote and destination never reuses the id or path
    // awaiting recovery, and leaves the retained checkout alone.
    const retried = await launched.window.evaluate(
      (request) => window.api.addWorkspaceFromRemote(request),
      { remoteUrl, destinationDir: clones },
    );
    expect(retried).toMatchObject({
      id: 'beta-2',
      repoPath: path.join(clones, 'beta-2'),
    });
    expect(existsSync(interrupted)).toBe(true);
    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'acked',
      'beta-2',
    ]);

    // Relaunch marked the interrupted identity as awaiting recovery, and the
    // completed retry consumed only its own.
    await quitGracefullyKeepingData(launched.electronApp, userDataDir);
    expect(workspaceCreationReservations(userDataDir)).toEqual([
      {
        state: 'recovery-required',
        diagnostics: expect.objectContaining({
          workspaceId: 'beta',
          phase: 'remote-clone',
          ownedPaths: expect.arrayContaining([interrupted]),
          repositories: [
            expect.objectContaining({
              id: 'source',
              owned: true,
              path: interrupted,
              action: 'clone',
              status: 'started',
            }),
          ],
        }),
      },
    ]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/crash_restart: SIGKILL after an acknowledged create keeps the entry, including a multi-repo workspace:create, which leaves no unindexed manifest (CAN-3806)', async () => {
  test.setTimeout(150_000);
  // Outside `fixtures`, which afterEach removes: a failed test keeps its root.
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-create-data-')),
  );
  let launched = await launchW5App({ userDataDir }, w5Teardown);
  const repoPath = initRepo(path.join(fixtures, 'alpha'));
  await launched.window.evaluate(
    (request) => window.api.addWorkspaceFromFolder(request),
    { repoPath },
  );
  // The Multi-Repo dialog's create, which indexes in the same commit.
  await launched.window.evaluate(
    (request) => window.api.createWorkspace(request),
    { name: 'Delta Multi' },
  );
  await crashKeepingData(launched, w5Teardown);

  launched = await launchW5App({ userDataDir }, w5Teardown);

  expect(await loadProjectIds(launched.window)).toEqual([
    DEFAULT_COWORK_WORKSPACE_ID,
    'alpha',
    'delta-multi',
  ]);
  expect(readManifest(userDataDir, 'alpha')).toMatchObject({ repoPath });
  expect(orphanManifestIds(userDataDir)).toEqual([]);
  expect(
    existsSync(path.join(userDataDir, 'repos', 'delta-multi', '.git')),
  ).toBe(true);
  const retried = await launched.window.evaluate(
    (request) => window.api.createWorkspace(request),
    { name: 'Delta Multi' },
  );
  expect(retried.id).toBe('delta-multi-2');
});

test('workspace_create_local/client_disconnect: a renderer reload while add-from-remote is inside git clone does not stop the main-process write', async () => {
  test.skip(
    process.platform === 'win32',
    'The Git gate is a POSIX shell shim.',
  );
  test.setTimeout(120_000);
  const gateDir = path.join(fixtures, 'gate');
  const launched = await launchW5App({
    env: { CANOPY_GIT_EXECUTABLE: writeGatedGitShim(gateDir, GATE_CLONE) },
  });
  const { window, userDataDir } = launched;
  try {
    await invokeWithoutAwaiting(window, 'addWorkspaceFromRemote', {
      remoteUrl: initBareRemote(fixtures, 'beta'),
      destinationDir: path.join(fixtures, 'clones'),
    });
    await expect
      .poll(() => heldGitCommandCount(gateDir), { timeout: 30_000 })
      .toBe(1);
    expect(readIndexIds(userDataDir)).not.toContain('beta');

    await window.reload();
    releaseGitGate(gateDir);

    await expect
      .poll(() => readIndexIds(userDataDir), { timeout: 30_000 })
      .toContain('beta');
    await expect.poll(() => loadProjectIds(window)).toContain('beta');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/concurrent_client: a CLI create while the app runs is indexed beside the app entries and survives a stale app save', async () => {
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    const alpha = initRepo(path.join(fixtures, 'alpha'));
    await window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      {
        repoPath: alpha,
      },
    );
    const staleItems = await window.evaluate(
      async () => (await window.api.loadProjects()).items,
    );

    const cli = await runCli(userDataDir, [
      'workspace',
      'create',
      'import',
      initRepo(path.join(fixtures, 'from-cli')),
    ]);
    expect(cli.code).toBe(0);
    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'alpha',
      'from-cli',
    ]);

    // projects:save keeps index entries its snapshot does not mention.
    await window.evaluate(
      (items) => window.api.saveProjects(items),
      staleItems,
    );
    await window.evaluate(
      (request) => window.api.addWorkspaceFromFolder(request),
      {
        repoPath: initRepo(path.join(fixtures, 'after')),
      },
    );

    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'alpha',
      'from-cli',
      'after',
    ]);
    expect(await loadProjectIds(window)).toEqual(readIndexIds(userDataDir));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('workspace_create_local/concurrent_client: a CLI create that reserved its id first keeps it, and the app takes the next id (CAN-6790)', async () => {
  test.skip(
    process.platform === 'win32',
    'The race gate is a POSIX shell hook.',
  );
  test.setTimeout(120_000);
  const launched = await launchW5App();
  const { window, userDataDir } = launched;
  try {
    // Hold the CLI inside the initial commit of its new repo: it has already
    // reserved the id `my-app` in the shared W5 log (CAN-5761) and created
    // <data>/repos/my-app.
    const gateDir = path.join(fixtures, 'gate');
    mkdirSync(path.join(gateDir, 'hooks'), { recursive: true });
    writeFileSync(
      path.join(gateDir, 'hooks', 'pre-commit'),
      `#!/bin/sh\ntouch "${gateDir}/entered"\nwhile [ ! -f "${gateDir}/release" ]; do sleep 0.05; done\n`,
      { mode: 0o755 },
    );
    const cli = runCli(
      userDataDir,
      ['workspace', 'create', 'new', 'single-repo', 'My App'],
      gitHooksPathEnv(gateDir),
    );
    await expect
      .poll(() => existsSync(path.join(gateDir, 'entered')), {
        timeout: 30_000,
      })
      .toBe(true);

    const appItem = await window.evaluate(
      (request) => window.api.createNewWorkspace(request),
      { name: 'My App' },
    );
    writeFileSync(path.join(gateDir, 'release'), '');
    const result = await cli;

    // The app skips the id the CLI reserved, so neither create loses its
    // project or leaves a repo behind.
    expect(appItem).toMatchObject({
      id: 'my-app-2',
      repoPath: path.join(userDataDir, 'repos', 'my-app-2'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'my-app',
      type: 'single-repo',
    });
    expect(
      git(path.join(userDataDir, 'repos', 'my-app'), ['log', '--format=%s']),
    ).toMatch(/^Initialize .+ workspace$/);
    expect(readIndexIds(userDataDir)).toEqual([
      DEFAULT_COWORK_WORKSPACE_ID,
      'my-app-2',
      'my-app',
    ]);
    expect(orphanManifestIds(userDataDir)).toEqual([]);
    await expect
      .poll(() => loadProjectIds(window))
      .toEqual(readIndexIds(userDataDir));
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
