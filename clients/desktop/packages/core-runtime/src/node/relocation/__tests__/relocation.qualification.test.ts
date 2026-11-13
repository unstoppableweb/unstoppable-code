import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import callbackFs, {
  type NoParamCallback,
  type WriteFileOptions,
} from 'node:fs';
import { promisify } from 'node:util';
import {
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  cp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { W5CommitLog } from '../../w5/commit-log/commit-log';
import { projectW5HostPathFingerprint } from '../../w5/host-path-fingerprint';
import {
  createW5KeyedOperationRunner,
  fingerprintW5Parameters,
  type W5ReceiptStore,
} from '../../w5/keyed-operation';
import { recordLocalWorktreeReplica } from '../../w5/worktree-replica-record';
import { createWorkspaceManifestRepository } from '../../w5/workspace-manifest-repository';
import {
  createWorktreeListRepository,
  type W5WorktreeListRow,
  type W5WorktreeListRowProjection,
} from '../../w5/worktree-list-repository';
import { isJsonObject, type W5FileStore } from '../../w5/file-store';
import {
  createRelocatedReceiptStore,
  relocatedRepositoryAddReceipt,
  prepareRelocationGit,
  repairRelocationGit,
  qualifyRelocationGit,
  discardRelocatedRuntime,
  repairRelocatedWorkspace,
  assertRelocationW5Settled,
  movedOwnedPath,
  relocationTransition,
  createRelocationRepairStep,
  assertRelocationOwnedPathsSafe,
  repairRelocationCarriedLinks,
  type RelocationTransition,
} from '..';

const exec = promisify(execFile);
const gitPathSpelling = (path: string): string =>
  process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
async function overwriteExistingFile(
  path: string,
  contents: string,
): Promise<void> {
  // CREATE_ALWAYS refuses Git for Windows' hidden .git files.
  const file = await fs.open(path, 'r+');
  try {
    const bytes = Buffer.from(contents);
    await file.writeFile(bytes);
    await file.truncate(bytes.length);
  } finally {
    await file.close();
  }
}
const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (
    await exec('git', [...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    })
  ).stdout;
let dir: string;
let oldRoot: string;
let newRoot: string;
let workingRoot: string;
let transition: RelocationTransition;
let sourceSnapshot: Record<string, string> | undefined;

async function treeSnapshot(
  root: string,
  includeGit = false,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!includeGit && entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) files[key] = `link:${await readlink(path)}`;
      else if (entry.isDirectory()) {
        files[key] = 'directory';
        await visit(path);
      } else files[key] = (await readFile(path)).toString('hex');
    }
  };
  await visit(root);
  return files;
}

async function copyRoot(): Promise<void> {
  sourceSnapshot = await treeSnapshot(oldRoot);
  await cp(oldRoot, workingRoot, { recursive: true, verbatimSymlinks: true });
}
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'relocation-')));
  sourceSnapshot = undefined;
  oldRoot = join(dir, 'old');
  newRoot = join(dir, 'new');
  workingRoot = join(dir, 'staging');
  await mkdir(oldRoot);
  transition = relocationTransition({
    version: 1,
    brandId: 'canopy',
    installationId: 'installation-1',
    from: { authorityId: 'a'.repeat(64), canonicalDataRoot: oldRoot },
    to: { authorityId: 'b'.repeat(64), canonicalDataRoot: newRoot },
  });
});
afterEach(async () => {
  try {
    if (sourceSnapshot)
      expect(await treeSnapshot(oldRoot)).toEqual(sourceSnapshot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ['init', '-b', 'main']);
  await writeFile(join(path, 'tracked'), 'original\n');
  await git(path, ['add', 'tracked']);
  await git(path, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'initial',
  ]);
}

async function expectNoStagingReferences(root: string): Promise<void> {
  const snapshot = await treeSnapshot(root, true);
  for (const spelling of new Set([workingRoot, gitPathSpelling(workingRoot)]))
    for (const contents of Object.values(snapshot)) {
      expect(contents).not.toContain(spelling);
      expect(contents).not.toContain(Buffer.from(spelling).toString('hex'));
    }
}

(process.platform === 'win32' ? it.skip : it).each([
  'clean',
  'dirty',
  'staged',
  'untracked',
])(
  'preserves %s checkout links and exact Git qualification on retry',
  async (kind) => {
    const common = join(oldRoot, 'repo');
    const checkout = join(oldRoot, 'checkout');
    await repository(common);
    const target = join(oldRoot, 'payload');
    await writeFile(target, 'retained source');
    await symlink(target, join(common, 'pointer'));
    if (kind !== 'untracked') {
      await git(common, ['add', 'pointer']);
      await git(common, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'link fixture',
      ]);
      if (kind !== 'clean') {
        await rm(join(common, 'pointer'));
        await symlink(join(oldRoot, 'missing'), join(common, 'pointer'));
        if (kind === 'staged') await git(common, ['add', 'pointer']);
      }
    }
    await git(common, ['worktree', 'add', '-b', 'linked', checkout]);
    // Non-checkout links still project, including chains through retained checkout links.
    await symlink(join(common, 'pointer'), join(oldRoot, 'alias'));
    await mkdir(join(oldRoot, 'repo-copy'));
    await symlink(target, join(oldRoot, 'repo-copy/pointer'));
    const plan = await prepareRelocationGit(git, [common, checkout]);
    const preserved = plan.checkouts.map((row) =>
      movedOwnedPath(transition, row.path),
    );
    const paths = [oldRoot];
    await copyRoot();
    const warnings = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await createRelocationRepairStep()({
        transition,
        workingRoot,
        gitPlan: plan,
        ownedPaths: paths,
        carryPayloadLinks: true,
        admit: () => Promise.resolve(),
        recordAuthority: () => Promise.resolve(),
        repairMetadata: () => Promise.resolve(),
      });
      expect(
        warnings.mock.calls.some(
          ([line]) =>
            typeof line === 'string' &&
            line.includes('retaining checkout absolute link') &&
            line.includes('repo/pointer'),
        ),
      ).toBe(true);
    } finally {
      warnings.mockRestore();
    }
    await assertRelocationOwnedPathsSafe(
      transition,
      paths,
      workingRoot,
      false,
      {
        preserveSourceTargetsWithin: preserved,
      },
    );
    await rename(workingRoot, newRoot);
    await assertRelocationOwnedPathsSafe(transition, paths, newRoot, true, {
      preserveSourceTargetsWithin: preserved,
    });
    await qualifyRelocationGit(git, transition, plan);
    expect(await readlink(join(newRoot, 'repo/pointer'))).toBe(
      await readlink(join(common, 'pointer')),
    );
    expect(await readlink(join(newRoot, 'alias'))).toBe(
      join(newRoot, 'repo/pointer'),
    );
    expect(await readlink(join(newRoot, 'repo-copy/pointer'))).toBe(
      join(newRoot, 'payload'),
    );
    const published = join(newRoot, 'repo');
    await writeFile(join(published, 'tracked'), 'unexpected change');
    await expect(
      qualifyRelocationGit(git, transition, plan),
    ).rejects.toMatchObject({
      reason: 'published-git-state-changed',
    });
    await writeFile(join(published, 'tracked'), 'original\n');
    await qualifyRelocationGit(git, transition, plan);
    const before = await readlink(join(published, 'pointer'));
    await rm(join(published, 'pointer'));
    await symlink(join(newRoot, 'payload'), join(published, 'pointer'));
    // Porcelain does not fingerprint untracked bytes or already-dirty contents.
    if (kind === 'clean' || kind === 'staged')
      await expect(
        qualifyRelocationGit(git, transition, plan),
      ).rejects.toMatchObject({
        reason: 'published-git-state-changed',
      });
    await rm(join(published, 'pointer'));
    await symlink(before, join(published, 'pointer'));
    await qualifyRelocationGit(git, transition, plan);
  },
);

it.each(['absolute', 'relative'])(
  'publishes repaired staging with final-only %s Git paths, owner records and runtime state',
  async (backlinkKind) => {
    const common = join(oldRoot, 'repo');
    const checkout = join(oldRoot, 'checkout');
    const external = join(dir, 'external');
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await git(common, ['worktree', 'add', '-b', 'external', external]);
    const gitDir = (
      await git(checkout, ['rev-parse', '--absolute-git-dir'])
    ).trim();
    if (backlinkKind === 'absolute')
      await writeFile(join(gitDir, 'commondir'), `${join(common, '.git')}\n`);
    else
      await overwriteExistingFile(
        join(checkout, '.git'),
        `gitdir: ${relative(checkout, gitDir)}\n`,
      );
    for (const path of [common, checkout, external]) {
      await writeFile(join(path, 'tracked'), 'dirty content\n');
      await writeFile(join(path, 'untracked'), 'untracked\0bytes');
    }
    const plan = await prepareRelocationGit(git, [common, checkout, external]);
    const fixture = metadataFixture({
      creation: {
        checkouts: [{ repositoryPath: common, checkoutPath: checkout }],
      },
    });
    fixture.evidence.repositoryPaths = [common, checkout];
    await writeFile(
      join(oldRoot, 'manifest.json'),
      fixture.evidence.manifestRaw,
    );
    await writeFile(join(oldRoot, 'worktrees.json'), fixture.evidence.listRaw);
    await mkdir(join(oldRoot, 'runtime'));
    await writeFile(
      join(oldRoot, 'runtime', 'core.json'),
      'stale process descriptor',
    );
    await mkdir(join(oldRoot, 'account-proxy-local', 'auths'), {
      recursive: true,
    });
    await writeFile(
      join(oldRoot, 'account-proxy-local', 'auths', 'account.fixture'),
      'preserve account',
    );
    await writeFile(
      join(oldRoot, 'account-proxy-local', 'config.yaml'),
      'stale config',
    );
    await copyRoot();
    const retained = await treeSnapshot(oldRoot, true);
    const store: W5FileStore = {
      read: async (path) => ({
        state: 'present',
        raw: await readFile(path, 'utf8'),
      }),
      replace: (path, contents) => writeFile(path, contents),
      remove: (path) => rm(path),
    };
    const manifest = createWorkspaceManifestRepository({
      store,
      filePath: () => join(workingRoot, 'manifest.json'),
      storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
      knownFields: new Set(),
      knownRepoFields: new Set(),
    });
    const list = createWorktreeListRepository({
      store,
      filePath: () => join(workingRoot, 'worktrees.json'),
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(),
      readRow: (row) => row,
    });
    await createRelocationRepairStep()({
      transition,
      workingRoot,
      gitPlan: plan,
      ownedPaths: [],
      admit: () => Promise.resolve(),
      recordAuthority: (mapping) =>
        writeFile(join(workingRoot, 'authority.json'), JSON.stringify(mapping)),
      repairMetadata: () =>
        repairRelocatedWorkspace(transition, fixture.evidence, manifest, list),
    });
    await expect(lstat(newRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const stagingBacklink = await readFile(
      join(workingRoot, 'checkout', '.git'),
      'utf8',
    );
    expect(stagingBacklink).not.toContain(workingRoot);
    expect(stagingBacklink).not.toContain(gitPathSpelling(workingRoot));
    expect(await readFile(join(external, '.git'), 'utf8')).toContain(
      gitPathSpelling(newRoot),
    );
    await expect(
      readFile(join(workingRoot, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(workingRoot, 'account-proxy-local', 'config.yaml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(workingRoot, newRoot);
    const published = await prepareRelocationGit(git, [
      join(newRoot, 'repo'),
      join(newRoot, 'checkout'),
      external,
    ]);
    expect(published.checkouts).toEqual(
      plan.checkouts.map((row) => ({
        ...row,
        path: movedOwnedPath(transition, row.path),
        commonDirectory: movedOwnedPath(transition, row.commonDirectory),
      })),
    );
    for (const row of published.checkouts) {
      expect(await readFile(join(row.path, 'tracked'), 'utf8')).toBe(
        'dirty content\n',
      );
      expect(await readFile(join(row.path, 'untracked'), 'utf8')).toBe(
        'untracked\0bytes',
      );
    }
    expect(
      JSON.parse(await readFile(join(newRoot, 'authority.json'), 'utf8')),
    ).toEqual(transition);
    expect(
      JSON.parse(await readFile(join(newRoot, 'manifest.json'), 'utf8')),
    ).toMatchObject({ authorityId: transition.to.authorityId });
    expect(
      JSON.parse(await readFile(join(newRoot, 'worktrees.json'), 'utf8')),
    ).toMatchObject({
      worktrees: [
        {
          id: 'combined',
          creation: {
            checkouts: [
              {
                repositoryPath: join(newRoot, 'repo'),
                checkoutPath: join(newRoot, 'checkout'),
              },
            ],
          },
        },
      ],
    });
    expect(
      await readFile(
        join(newRoot, 'account-proxy-local', 'auths', 'account.fixture'),
        'utf8',
      ),
    ).toBe('preserve account');
    await expectNoStagingReferences(newRoot);
    expect(await readFile(join(external, '.git'), 'utf8')).not.toContain(
      workingRoot,
    );
    expect(await treeSnapshot(oldRoot, true)).toEqual(retained);
  },
);

it.each([
  'source',
  'source-child',
  'final',
  'final-child',
  'nonsibling',
  'relative',
  'alias',
])('refuses an invalid %s working root before repair effects', async (kind) => {
  await copyRoot();
  const invalid =
    kind === 'source'
      ? oldRoot
      : kind === 'source-child'
        ? join(oldRoot, 'private')
        : kind === 'final'
          ? newRoot
          : kind === 'final-child'
            ? join(newRoot, 'private')
            : kind === 'nonsibling'
              ? join(dir, 'other', 'private')
              : kind === 'relative'
                ? 'private'
                : `${workingRoot}/../staging`;
  const effect = jest.fn(() => Promise.resolve());
  await expect(
    createRelocationRepairStep()({
      transition,
      workingRoot: invalid,
      gitPlan: { checkouts: [], backlinks: [] },
      ownedPaths: [],
      admit: () => Promise.resolve(),
      recordAuthority: effect,
      repairMetadata: effect,
    }),
  ).rejects.toMatchObject({ reason: 'invalid-working-root' });
  expect(effect).not.toHaveBeenCalled();
});

it.each(['both', 'checkout-only', 'common-only'])(
  'repairs %s without changing branches or dirty/untracked bytes',
  async (movement) => {
    const common = join(
      movement === 'checkout-only' ? dir : oldRoot,
      'repository',
    );
    const checkout = join(
      movement === 'common-only' ? dir : oldRoot,
      'checkout',
    );
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await writeFile(join(checkout, 'tracked'), 'dirty\n');
    await writeFile(join(checkout, 'untracked'), 'keep\0bytes');
    await writeFile(join(common, 'untracked-main'), 'also keep');
    const commonBytes = await treeSnapshot(common);
    const checkoutBytes = await treeSnapshot(checkout);
    const plan = await prepareRelocationGit(git, [common, checkout]);
    expect(plan.backlinks).toHaveLength(3);
    expect(plan.backlinks.map((row) => row.path)).toContain(
      join(checkout, '.git'),
    );
    await copyRoot();
    const retainedBytes = await treeSnapshot(oldRoot, true);
    await repairRelocationGit(transition, plan, workingRoot);
    expect(await treeSnapshot(oldRoot, true)).toEqual(retainedBytes);
    await repairRelocationGit(transition, plan, workingRoot);
    expect(await treeSnapshot(oldRoot, true)).toEqual(retainedBytes);
    await rename(workingRoot, newRoot);
    const current = movedOwnedPath(transition, checkout);
    expect(await treeSnapshot(current)).toEqual(checkoutBytes);
    expect(await treeSnapshot(movedOwnedPath(transition, common))).toEqual(
      commonBytes,
    );
    expect(await readFile(join(current, 'tracked'), 'utf8')).toBe('dirty\n');
    expect(await readFile(join(current, 'untracked'), 'utf8')).toBe(
      'keep\0bytes',
    );
    expect(await git(current, ['branch', '--show-current'])).toBe('feature\n');
    const published = await prepareRelocationGit(
      git,
      plan.checkouts.map((row) => movedOwnedPath(transition, row.path)),
    );
    expect(published.checkouts).toEqual(
      plan.checkouts.map((row) => ({
        ...row,
        path: movedOwnedPath(transition, row.path),
        commonDirectory: movedOwnedPath(transition, row.commonDirectory),
      })),
    );
    await expectNoStagingReferences(newRoot);
    expect(await readFile(join(current, '.git'), 'utf8')).not.toContain(
      workingRoot,
    );
    expect(
      await readFile(
        join(movedOwnedPath(transition, common), 'untracked-main'),
        'utf8',
      ),
    ).toBe('also keep');
  },
);

it('relocates managed checkouts of an external bare repository, changing only their backlinks', async () => {
  const seed = join(dir, 'seed');
  const common = join(dir, 'external bare');
  const first = join(oldRoot, 'first checkout');
  const second = join(oldRoot, 'second');
  const external = join(dir, 'external checkout');
  await repository(seed);
  await git(dir, ['clone', '--bare', seed, common]);
  const linkedCheckouts: readonly [string, string][] = [
    ['first', first],
    ['second', second],
    ['external', external],
  ];
  for (const [branch, path] of linkedCheckouts) {
    await git(common, ['worktree', 'add', '-b', branch, path]);
    await writeFile(join(path, 'tracked'), `dirty ${branch}\n`);
    await writeFile(join(path, 'untracked'), `keep ${branch}\0bytes`);
  }
  for (const omitted of [first, second, external]) {
    await expect(
      prepareRelocationGit(
        git,
        [first, second, external].filter((path) => path !== omitted),
      ),
    ).rejects.toMatchObject({ reason: 'uninventoried-git-checkout' });
  }
  const plan = await prepareRelocationGit(git, [first, second, external]);
  expect(plan.checkouts.map((row) => row.commonDirectory)).toEqual([
    common,
    common,
    common,
  ]);
  const expectedBare = await treeSnapshot(common, true);
  for (const path of [first, second]) {
    const gitDir = (
      await git(path, ['rev-parse', '--absolute-git-dir'])
    ).trim();
    expectedBare[relative(common, join(gitDir, 'gitdir'))] = Buffer.from(
      `${gitPathSpelling(movedOwnedPath(transition, join(path, '.git')))}\n`,
    ).toString('hex');
  }
  const externalBytes = await treeSnapshot(external, true);
  const firstBytes = await treeSnapshot(first);
  const secondBytes = await treeSnapshot(second);
  await copyRoot();
  const retained = await treeSnapshot(oldRoot, true);
  await repairRelocationGit(transition, plan, workingRoot);
  await repairRelocationGit(transition, plan, workingRoot);
  expect(await treeSnapshot(oldRoot, true)).toEqual(retained);
  expect(await treeSnapshot(common, true)).toEqual(expectedBare);
  expect(await treeSnapshot(external, true)).toEqual(externalBytes);
  await rename(workingRoot, newRoot);
  const published = await prepareRelocationGit(
    git,
    plan.checkouts.map((row) => movedOwnedPath(transition, row.path)),
  );
  expect(published.checkouts).toEqual(
    plan.checkouts.map((row) => ({
      ...row,
      path: movedOwnedPath(transition, row.path),
    })),
  );
  expect(await treeSnapshot(movedOwnedPath(transition, first))).toEqual(
    firstBytes,
  );
  expect(await treeSnapshot(movedOwnedPath(transition, second))).toEqual(
    secondBytes,
  );
  expect(await treeSnapshot(common, true)).toEqual(expectedBare);
  expect(await treeSnapshot(external, true)).toEqual(externalBytes);
  await expectNoStagingReferences(newRoot);
});

it('preserves detached worktrees and an unborn managed main branch', async () => {
  const common = join(oldRoot, 'repository');
  const checkout = join(oldRoot, 'detached');
  const empty = join(oldRoot, 'empty');
  await repository(common);
  await git(common, ['worktree', 'add', '--detach', checkout]);
  await mkdir(empty);
  await git(empty, ['init', '-b', 'initial']);
  await writeFile(join(empty, 'untracked'), 'keep unborn bytes');
  const plan = await prepareRelocationGit(git, [common, checkout, empty]);
  expect(plan.checkouts.find((row) => row.path === checkout)?.branch).toBe(
    'HEAD',
  );
  expect(plan.checkouts.find((row) => row.path === empty)?.branch).toBe(
    'refs/heads/initial',
  );
  await copyRoot();
  await repairRelocationGit(transition, plan, workingRoot);
  await rename(workingRoot, newRoot);
  expect(
    await git(join(newRoot, 'detached'), ['branch', '--show-current']),
  ).toBe('');
  expect(await git(join(newRoot, 'empty'), ['symbolic-ref', 'HEAD'])).toBe(
    'refs/heads/initial\n',
  );
  expect(await readFile(join(newRoot, 'empty', 'untracked'), 'utf8')).toBe(
    'keep unborn bytes',
  );
});

it('refuses an omitted external checkout, and exposes recovery preimages before external repair failure', async () => {
  const common = join(oldRoot, 'repository');
  const checkout = join(dir, 'external');
  await repository(common);
  await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
  await expect(prepareRelocationGit(git, [common])).rejects.toMatchObject({
    reason: 'uninventoried-git-checkout',
  });
  const plan = await prepareRelocationGit(git, [common, checkout]);
  const original = await readFile(join(checkout, '.git'), 'utf8');
  await copyRoot();
  await expect(
    createRelocationRepairStep()({
      transition,
      workingRoot,
      gitPlan: plan,
      ownedPaths: [],
      admit: () => Promise.resolve(),
      recordAuthority: () => Promise.resolve(),
      repairMetadata: () =>
        Promise.reject(new Error('external repair failed after effect')),
    }),
  ).rejects.toThrow('external repair failed');
  await repairRelocationGit(transition, plan, workingRoot);
  expect(await readFile(join(checkout, '.git'), 'utf8')).toContain(
    gitPathSpelling(newRoot),
  );
  // B may restore an individual external preimage before resuming the frozen plan.
  await overwriteExistingFile(join(checkout, '.git'), original);
  expect(await readFile(join(checkout, '.git'), 'utf8')).toBe(original);
  expect(await git(checkout, ['branch', '--show-current'])).toBe('feature\n');
  await repairRelocationGit(transition, plan, workingRoot);
  expect(await readFile(join(checkout, '.git'), 'utf8')).toContain(
    gitPathSpelling(newRoot),
  );
  await rename(workingRoot, newRoot);
  expect(await git(checkout, ['branch', '--show-current'])).toBe('feature\n');
});

const windowsGitSpelling = process.platform === 'win32' ? it : it.skip;
windowsGitSpelling.each([
  'missing prunable',
  'present prunable',
  'missing locked',
])(
  'handles a %s worktree during Windows Git preparation without changing source records',
  async (kind) => {
    const common = join(oldRoot, 'repository');
    const checkout = join(oldRoot, 'linked');
    const stale = join(oldRoot, 'stale');
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await git(common, ['worktree', 'add', '-b', 'stale', stale]);
    if (kind === 'missing locked')
      await git(common, ['worktree', 'lock', stale]);
    if (kind === 'present prunable') await rm(join(stale, '.git'));
    else await rm(stale, { recursive: true });
    const before = await git(common, ['worktree', 'list', '--porcelain', '-z']);
    expect(before).toContain(
      kind === 'missing locked' ? '\0locked\0' : '\0prunable ',
    );
    const retained = await treeSnapshot(oldRoot, true);
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const preparation = prepareRelocationGit(git, [common, checkout], {
        reportedMissingPrunable: new Set(),
      });
      if (kind === 'missing prunable') {
        const plan = await preparation;
        expect(plan.checkouts.map((row) => row.path)).toEqual([
          common,
          checkout,
        ]);
        expect(plan.backlinks.some((row) => row.path.startsWith(stale))).toBe(
          false,
        );
        expect(
          stderr.mock.calls.filter(
            ([line]) =>
              typeof line === 'string' &&
              line.includes('skipping absent prunable Git worktree'),
          ),
        ).toHaveLength(1);
      } else {
        await expect(preparation).rejects.toMatchObject({
          reason:
            kind === 'missing locked'
              ? 'symlink-checkout'
              : 'uninventoried-git-checkout',
        });
      }
    } finally {
      stderr.mockRestore();
    }
    expect(await git(common, ['worktree', 'list', '--porcelain', '-z'])).toBe(
      before,
    );
    expect(await treeSnapshot(oldRoot, true)).toEqual(retained);
  },
);

windowsGitSpelling(
  'canonicalizes Windows Git separators and drive case without duplicating inventoried checkouts',
  async () => {
    const common = join(oldRoot, 'repository');
    const checkout = join(oldRoot, 'linked');
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    const expected = await prepareRelocationGit(git, [common, checkout]);
    const alternate = (path: string): string =>
      gitPathSpelling(path).replace(/^[A-Za-z]:/, (drive) =>
        drive === drive.toUpperCase()
          ? drive.toLowerCase()
          : drive.toUpperCase(),
      );
    const differentlySpelledGit = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await git(cwd, args);
      if (
        args.includes('--git-common-dir') ||
        args.includes('--absolute-git-dir')
      )
        return alternate(result);
      if (args[0] === 'worktree')
        return result.replace(
          /worktree ([^\0]+)/g,
          (_, path: string) => `worktree ${alternate(path)}`,
        );
      return result;
    };
    expect(
      await prepareRelocationGit(differentlySpelledGit, [
        alternate(common),
        common,
        alternate(checkout),
      ]),
    ).toEqual(expected);
  },
);

it.each(['checkout', 'checkout ancestor', 'common directory'])(
  'refuses a real directory symlink or Windows junction at the %s',
  async (location) => {
    const common = join(oldRoot, 'repository');
    await repository(common);
    const link = join(dir, 'alias');
    const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
    if (location === 'common directory') {
      const metadata = join(dir, 'git-metadata');
      await rename(join(common, '.git'), metadata);
      await symlink(metadata, join(common, '.git'), linkKind);
      const probe = jest.fn(git);
      const preparation = prepareRelocationGit(probe, [common]);
      await expect(preparation).rejects.toMatchObject({
        reason: 'symlink-git-directory',
      });
      expect(probe).not.toHaveBeenCalled();
    } else {
      await symlink(location === 'checkout' ? common : oldRoot, link, linkKind);
      await expect(
        prepareRelocationGit(git, [
          location === 'checkout' ? link : join(link, 'repository'),
        ]),
      ).rejects.toMatchObject({ reason: 'symlink-checkout' });
    }
  },
);

(process.platform === 'win32' ? it.skip : it)(
  'preserves backlink permissions under a restrictive umask',
  async () => {
    const common = join(oldRoot, 'repository');
    const checkout = join(dir, 'external');
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await fs.chmod(join(checkout, '.git'), 0o664);
    const plan = await prepareRelocationGit(git, [common, checkout]);
    await copyRoot();
    const previous = process.umask(0o022);
    try {
      await repairRelocationGit(transition, plan, workingRoot);
    } finally {
      process.umask(previous);
    }
    expect((await lstat(join(checkout, '.git'))).mode & 0o777).toBe(0o664);
    expect(await readFile(join(checkout, '.git'), 'utf8')).toContain(
      gitPathSpelling(newRoot),
    );
  },
);

it.each(['write', 'publish'])(
  'resumes mixed backlink images after an interrupted %s without truncation or repeated writes',
  async (failure) => {
    const common = join(oldRoot, 'repository');
    const checkout = join(dir, 'external');
    const managed = join(oldRoot, 'managed');
    await repository(common);
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await git(common, ['worktree', 'add', '-b', 'managed', managed]);
    await writeFile(join(checkout, 'tracked'), 'dirty bytes');
    await writeFile(join(managed, 'tracked'), 'managed dirty bytes');
    await writeFile(join(managed, 'untracked'), 'managed untracked bytes');
    await writeFile(join(checkout, 'untracked'), 'keep bytes');
    const plan = await prepareRelocationGit(git, [common, checkout, managed]);
    await copyRoot();
    const retained = await treeSnapshot(oldRoot, true);
    const write = fs.writeFile;
    const writeFd = callbackFs.writeFile;
    const publish = fs.rename;
    let count = 0;
    if (failure === 'write' && process.platform !== 'win32')
      jest
        .spyOn(callbackFs, 'writeFile')
        .mockImplementation(
          (
            path,
            contents,
            options: WriteFileOptions | NoParamCallback,
            callback?: NoParamCallback,
          ) => {
            const done = typeof options === 'function' ? options : callback;
            if (!done) throw new Error('Missing write callback');
            const settings = typeof options === 'function' ? {} : options;
            if (++count === 2)
              writeFd(path, 'torn backlink', settings, (error) =>
                done(error ?? new Error('interrupted backlink write')),
              );
            else writeFd(path, contents, settings, done);
          },
        );
    else if (failure === 'write')
      jest
        .spyOn(fs, 'writeFile')
        .mockImplementation(async (path, contents, options) => {
          if (++count === 2) {
            await write(path, 'torn backlink', options);
            throw new Error('interrupted backlink write');
          }
          await write(path, contents, options);
        });
    else
      jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (++count === 2) throw new Error('interrupted backlink publish');
        await publish(from, to);
      });
    try {
      await expect(
        repairRelocationGit(transition, plan, workingRoot),
      ).rejects.toThrow('interrupted backlink');
    } finally {
      jest.restoreAllMocks();
    }
    expect(count).toBe(2);
    // The first effect landed; the second still has its exact frozen preimage.
    expect(await readFile(join(checkout, '.git'), 'utf8')).toContain(
      gitPathSpelling(newRoot),
    );
    for (const image of plan.backlinks) {
      const final = movedOwnedPath(transition, image.path);
      const actual =
        final === image.path
          ? final
          : join(workingRoot, relative(newRoot, final));
      const current = await readFile(actual, 'utf8');
      expect([
        image.contents,
        image.contents.replaceAll(
          gitPathSpelling(oldRoot),
          gitPathSpelling(newRoot),
        ),
      ]).toContain(current);
    }
    for (const root of [workingRoot, checkout])
      expect(
        Object.keys(await treeSnapshot(root, true)).some((path) =>
          path.includes('.relocation-'),
        ),
      ).toBe(false);
    await repairRelocationGit(transition, plan, workingRoot);
    const repeated = jest.spyOn(fs, 'writeFile');
    const repeatedPublish = jest.spyOn(fs, 'rename');
    try {
      await repairRelocationGit(transition, plan, workingRoot);
      expect(repeated).not.toHaveBeenCalled();
      expect(repeatedPublish).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
    await rename(workingRoot, newRoot);
    expect(await git(checkout, ['branch', '--show-current'])).toBe('feature\n');
    expect(await git(checkout, ['status', '--porcelain'])).toContain('tracked');
    expect(await readFile(join(checkout, 'untracked'), 'utf8')).toBe(
      'keep bytes',
    );
    expect(
      (
        await prepareRelocationGit(git, [
          join(newRoot, 'repository'),
          checkout,
          join(newRoot, 'managed'),
        ])
      ).checkouts,
    ).toEqual(
      plan.checkouts.map((row) => ({
        ...row,
        path: movedOwnedPath(transition, row.path),
        commonDirectory: movedOwnedPath(transition, row.commonDirectory),
      })),
    );
    expect(await readFile(join(newRoot, 'managed', 'untracked'), 'utf8')).toBe(
      'managed untracked bytes',
    );
    expect(await treeSnapshot(oldRoot, true)).toEqual(retained);
    await expectNoStagingReferences(newRoot);
  },
);

it('refuses a symlinked sibling staging root before repair effects', async () => {
  await copyRoot();
  const alias = join(dir, 'staging-alias');
  await symlink(
    workingRoot,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const effect = jest.fn(() => Promise.resolve());
  await expect(
    createRelocationRepairStep()({
      transition,
      workingRoot: alias,
      gitPlan: { checkouts: [], backlinks: [] },
      ownedPaths: [],
      admit: () => Promise.resolve(),
      recordAuthority: effect,
      repairMetadata: effect,
    }),
  ).rejects.toMatchObject({ reason: 'noncanonical-destination' });
  expect(effect).not.toHaveBeenCalled();
});

it('rejects an identity transition and leaves unrelated path prefixes alone', () => {
  expect(() =>
    relocationTransition({ ...transition, to: transition.from }),
  ).toThrow('invalid-transition');
  expect(movedOwnedPath(transition, join(dir, 'old-unrelated', 'repo'))).toBe(
    join(dir, 'old-unrelated', 'repo'),
  );
});

function receiptStore(log: W5CommitLog): W5ReceiptStore {
  return {
    lookupReceipt: (receipt) =>
      Promise.resolve(log.lookupReceipt(receipt, receipt.fingerprint)),
    reserve: (input) =>
      Promise.resolve(
        log.reserve({ ...input, diagnostics: input.diagnostics ?? {} }),
      ),
    releaseReservation: (id) => Promise.resolve(log.releaseReservation(id)),
    markReservationRecoveryRequired: (id, diagnostics) =>
      Promise.resolve(log.markReservationRecoveryRequired(id, diagnostics)),
  };
}

it.each([
  'legacy-path',
  process.platform === 'win32' ? 'win32' : 'posix',
] as const)(
  'preserves W5 receipt evidence and completed effects for %s identities',
  async (flavor) => {
    const key = {
      caller: 'caller',
      operation: 'core.workspace.repository.add',
      idempotencyKey: 'key',
    };
    const request = {
      workspaceId: 'workspace',
      source: 'workspace_settings',
      repository: {
        id: 'repo',
        name: 'Repository',
        repoPath: join(oldRoot, 'repo'),
      },
    } as const;
    const projection = relocatedRepositoryAddReceipt(
      transition,
      'repo-1',
      key,
      request,
      flavor,
    );
    let now = 0;
    const log = W5CommitLog.open(join(dir, 'log.sqlite'), {
      clock: () => now,
      retryWindowMs: 10,
    });
    try {
      const result = log.commit({
        operation: key.operation,
        receipt: { ...key, fingerprint: projection.originalFingerprint },
        files: [],
        advance: [],
        outcome: { repoPath: request.repository.repoPath, id: 'repo' },
      });
      if (result.status !== 'committed') throw new Error('new commit required');
      log.markApplied(result.commitId);
      const store = createRelocatedReceiptStore(
        receiptStore(log),
        transition,
        [projection],
        (pair) => pair.objectId === 'repo-1',
      );
      const exact = await store.lookupReceipt({
        ...key,
        fingerprint: projection.originalFingerprint,
      });
      expect(
        await store.lookupReceipt({
          ...key,
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toEqual(exact);
      expect(exact).toMatchObject({
        status: 'replay',
        outcome: { repoPath: request.repository.repoPath },
      });
      expect(
        await store.lookupReceipt({ ...key, fingerprint: 'f'.repeat(64) }),
      ).toEqual({ status: 'key-reused' });
      expect(
        await store.lookupReceipt({
          ...key,
          idempotencyKey: 'different',
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toEqual({ status: 'none' });
      const runner = createW5KeyedOperationRunner({
        getReceiptStore: () => store,
      });
      const work = jest.fn(() => Promise.resolve('repeated effect'));
      const retry = (path: string): Promise<unknown> =>
        runner(
          {
            ...key,
            parameters: {
              ...request,
              repository: {
                ...request.repository,
                repoPath:
                  flavor === 'legacy-path'
                    ? path
                    : projectW5HostPathFingerprint(path, flavor),
              },
            },
            isPreEffectRefusal: () => false,
          },
          (outcome) => outcome,
          work,
        );
      for (const path of [projection.originalPath, projection.relocatedPath])
        await expect(retry(path)).resolves.toEqual({
          repoPath: request.repository.repoPath,
          id: 'repo',
        });
      expect(work).not.toHaveBeenCalled();
      expect(log.lookupReceipt(key, projection.originalFingerprint)).toEqual(
        exact,
      );
      now = 11;
      log.compact();
      expect(
        await store.lookupReceipt({
          ...key,
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toMatchObject({ status: 'replay-expired' });
      for (const path of [projection.originalPath, projection.relocatedPath])
        await expect(retry(path)).rejects.toMatchObject({
          reason: 'outcome-expired',
          details: { commitId: result.commitId },
        });
      expect(work).not.toHaveBeenCalled();
    } finally {
      log.close();
    }
  },
);

it.each(['original', 'relocated'] as const)(
  'keeps %s reservations and committed/recovery outcomes through the keyed runner',
  async (reservationPath) => {
    const key = {
      caller: 'caller',
      operation: 'core.workspace.repository.add',
      idempotencyKey: 'key',
    };
    const request = {
      workspaceId: 'workspace',
      source: 'workspace_settings',
      repository: { repoPath: join(oldRoot, 'repo') },
    } as const;
    const projection = relocatedRepositoryAddReceipt(
      transition,
      'repo-1',
      key,
      request,
      'legacy-path',
    );
    const log = W5CommitLog.open(join(dir, 'log.sqlite'));
    try {
      const store = createRelocatedReceiptStore(
        receiptStore(log),
        transition,
        [projection],
        () => true,
      );
      const runner = createW5KeyedOperationRunner({
        getReceiptStore: () => store,
      });
      const work = jest.fn(() => Promise.resolve('repeated effect'));
      const retry = (repoPath: string): Promise<unknown> =>
        runner(
          {
            ...key,
            parameters: { ...request, repository: { repoPath } },
            isPreEffectRefusal: () => false,
          },
          (outcome) => outcome,
          work,
        );
      const fingerprint =
        reservationPath === 'original'
          ? projection.originalFingerprint
          : projection.relocatedFingerprint;
      log.reserve({
        operation: key.operation,
        reservationId: 'reservation',
        receipt: { ...key, fingerprint },
        diagnostics: {},
      });
      expect(() => assertRelocationW5Settled(log)).toThrow(
        'w5-recovery-required',
      );
      expect(
        await store.lookupReceipt({
          ...key,
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toMatchObject({ status: 'in-progress' });
      await expect(retry(projection.relocatedPath)).rejects.toMatchObject({
        reason: 'in-progress',
        details: { reservationId: 'reservation' },
      });
      await expect(retry(projection.originalPath)).rejects.toMatchObject({
        reason: reservationPath === 'original' ? 'in-progress' : 'key-reused',
      });
      log.markInterruptedReservations();
      expect(
        await store.lookupReceipt({
          ...key,
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toMatchObject({ status: 'recovery-required' });
      await expect(retry(projection.relocatedPath)).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { reservationId: 'reservation' },
      });
      expect(log.lookupReceipt(key, fingerprint)).toMatchObject({
        status: 'recovery-required',
        reservationId: 'reservation',
      });
      expect(work).not.toHaveBeenCalled();
      log.resolveRecovery('reservation');
      await expect(retry(projection.relocatedPath)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(log.lookupReceipt(key, fingerprint)).toEqual({ status: 'none' });
      expect(work).not.toHaveBeenCalled();
      const decision = log.commit({
        operation: key.operation,
        receipt: { ...key, fingerprint: projection.originalFingerprint },
        files: [],
        advance: [],
        outcome: 'original',
      });
      if (decision.status !== 'committed')
        throw new Error('new commit required');
      expect(() => assertRelocationW5Settled(log)).toThrow(
        'w5-recovery-required',
      );
      for (const path of [projection.originalPath, projection.relocatedPath])
        await expect(retry(path)).resolves.toBe('original');
      expect(work).not.toHaveBeenCalled();
      log.markCommitRecoveryRequired(decision.commitId, {
        reason: 'preserved',
      });
      expect(
        await store.lookupReceipt({
          ...key,
          fingerprint: projection.relocatedFingerprint,
        }),
      ).toMatchObject({ status: 'commit-recovery-required' });
      for (const path of [projection.originalPath, projection.relocatedPath])
        await expect(retry(path)).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { commitId: decision.commitId },
        });
      expect(
        log.lookupReceipt(key, projection.originalFingerprint),
      ).toMatchObject({
        status: 'commit-recovery-required',
        commitId: decision.commitId,
        diagnostics: { reason: 'preserved' },
      });
      expect(work).not.toHaveBeenCalled();
      expect(() =>
        createRelocatedReceiptStore(
          receiptStore(log),
          transition,
          [projection],
          () => false,
        ),
      ).toThrow('unproven-receipt-projection');
    } finally {
      log.close();
    }
  },
);

it('invalidates only destination runtime artifacts; preserves source, proxy accounts and Ledger bytes', async () => {
  const runtime = join(oldRoot, 'runtime');
  await mkdir(join(runtime, 'hosts'), { recursive: true });
  await mkdir(join(runtime, 'locks'));
  const evidence = [
    'w5-maintenance.json',
    'hosts/cohort.json',
    'locks/guard.sqlite',
    'recovery.json',
  ];
  for (const name of evidence)
    await writeFile(join(runtime, name), `evidence:${name}`);
  const artifacts = [
    'core.sock',
    'core.json',
    'core-00000000-0000-4000-8000-000000000000.token',
  ];
  for (const name of artifacts)
    await writeFile(join(runtime, name), 'stale transport state');
  const proxy = join(oldRoot, 'account-proxy-local');
  await mkdir(join(proxy, 'auths'), { recursive: true });
  await writeFile(join(proxy, 'auths', 'account.fixture'), 'preserve account');
  for (const name of [
    'process.json',
    'key.json',
    'config.yaml',
    'config-old-epoch.yaml',
  ])
    await writeFile(join(proxy, name), 'stale');
  const ledger = join(oldRoot, 'ledger.sqlite');
  await writeFile(ledger, 'logical authority UUID remains byte-identical');
  await copyRoot();
  await discardRelocatedRuntime(transition, workingRoot);
  for (const path of [
    ...artifacts.map((name) => `runtime/${name}`),
    'account-proxy-local/process.json',
    'account-proxy-local/key.json',
    'account-proxy-local/config.yaml',
    'account-proxy-local/config-old-epoch.yaml',
  ])
    await expect(readFile(join(workingRoot, path))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  for (const name of evidence)
    expect(await readFile(join(workingRoot, 'runtime', name), 'utf8')).toBe(
      `evidence:${name}`,
    );
  expect(
    await readFile(
      join(workingRoot, 'account-proxy-local', 'auths', 'account.fixture'),
      'utf8',
    ),
  ).toBe('preserve account');
  expect(await readFile(join(workingRoot, 'ledger.sqlite'), 'utf8')).toBe(
    'logical authority UUID remains byte-identical',
  );
  await discardRelocatedRuntime(transition, workingRoot);
});

it('calls cold admission and durable mapping before effects, and stops after any refusal', async () => {
  await copyRoot();
  const calls: string[] = [];
  await createRelocationRepairStep()({
    transition,
    workingRoot,
    gitPlan: { checkouts: [], backlinks: [] },
    ownedPaths: [],
    admit: () => {
      calls.push('admit');
      return Promise.resolve();
    },
    recordAuthority: (mapping) => {
      expect(mapping).toEqual(transition);
      calls.push('record');
      return Promise.resolve();
    },
    repairMetadata: () => {
      calls.push('metadata');
      return Promise.resolve();
    },
  });
  expect(calls).toEqual(['admit', 'record', 'metadata']);
  const recordAuthority = jest.fn();
  await expect(
    createRelocationRepairStep()({
      transition,
      workingRoot,
      gitPlan: { checkouts: [], backlinks: [] },
      ownedPaths: [],
      admit: () => Promise.reject(new Error('not stopped')),
      recordAuthority,
      repairMetadata: jest.fn(),
    }),
  ).rejects.toThrow('not stopped');
  expect(recordAuthority).not.toHaveBeenCalled();
});

it.each([false, true])(
  'uses W5 owners for manifests and replicas, preserving foreign state (foreign=%s)',
  async (foreign) => {
    const files = new Map<string, string>();
    const store: W5FileStore = {
      read: (path) => {
        const raw = files.get(path);
        return Promise.resolve(
          raw === undefined ? { state: 'absent' } : { state: 'present', raw },
        );
      },
      replace: (path, contents) => {
        files.set(path, contents);
        return Promise.resolve();
      },
      remove: (path) => {
        files.delete(path);
        return Promise.resolve();
      },
    };
    const path = join(oldRoot, 'repo');
    const authorityId = foreign ? 'f'.repeat(64) : transition.from.authorityId;
    const replica = recordLocalWorktreeReplica(
      'workspace',
      { id: 'worktree', branchName: 'feature' },
      { authorityId, targetId: 'local', repoIds: ['repo'] },
    );
    const document = {
      version: 1,
      workspaceId: 'workspace',
      authorityId: transition.from.authorityId,
      targetId: 'local',
      repos: [
        { id: 'repo', name: 'Repo', repoPath: path },
        { id: 'external', repoPath: join(dir, 'external') },
      ],
      extension: { authorityId: transition.from.authorityId, path },
    };
    const manifestRaw = JSON.stringify(document);
    const listRaw = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'worktree',
          branchName: 'feature',
          createdAt: '2026-11-05',
          replica,
        },
      ],
    });
    files.set('manifest', manifestRaw);
    files.set('list', listRaw);
    const manifest = createWorkspaceManifestRepository({
      store,
      filePath: () => 'manifest',
      storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
      knownFields: new Set(),
      knownRepoFields: new Set(),
    });
    const list = createWorktreeListRepository({
      store,
      filePath: () => 'list',
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(),
      readRow: (row) => row,
    });
    const evidence = {
      workspaceId: 'workspace',
      targetId: 'local',
      manifestRaw,
      listRaw,
      repositoryPaths: [path],
    };
    await repairRelocatedWorkspace(transition, evidence, manifest, list);
    const current = await manifest.read('workspace');
    const rows = await list.read('workspace');
    expect(current).toMatchObject({
      authority: 'ok',
      document: {
        ...document,
        authorityId: transition.to.authorityId,
        repos: [
          { id: 'repo', repoPath: join(newRoot, 'repo') },
          { id: 'external', repoPath: join(dir, 'external') },
        ],
        extension: document.extension,
      },
    });
    expect(rows).toMatchObject({
      authority: 'ok',
      worktrees: [
        {
          id: 'worktree',
          branchName: 'feature',
          replica: {
            state: 'recorded',
            repositories: [
              {
                authorityId: foreign ? authorityId : transition.to.authorityId,
                targetId: {
                  primaryAuthorityId: foreign
                    ? authorityId
                    : transition.to.authorityId,
                },
              },
              {
                authorityId: foreign ? authorityId : transition.to.authorityId,
              },
            ],
          },
        },
      ],
    });
    if (
      rows.authority === 'ok' &&
      replica.state === 'recorded' &&
      rows.worktrees[0]?.replica?.state === 'recorded'
    ) {
      expect(
        rows.worktrees[0].replica.repositories.map((entry) => entry.replicaId),
      ).toEqual(replica.repositories.map((entry) => entry.replicaId));
    } else throw new Error('replicas must remain recorded');
    const after = files.get('manifest');
    await expect(
      repairRelocatedWorkspace(transition, evidence, manifest, list),
    ).rejects.toMatchObject({ reason: 'metadata-evidence-mismatch' });
    expect(files.get('manifest')).toBe(after);
    files.set(
      'manifest',
      JSON.stringify({ ...document, authorityId: 'e'.repeat(64) }),
    );
    const foreignManifest = files.get('manifest');
    if (!foreignManifest) throw new Error('fixture manifest required');
    await expect(
      repairRelocatedWorkspace(
        transition,
        { ...evidence, manifestRaw: foreignManifest },
        manifest,
        list,
      ),
    ).rejects.toThrow();
  },
);

it.each(['original', 'unrelated'] as const)(
  'refuses missing relocated evidence while admitting a new %s path request',
  async (newPath) => {
    const key = {
      caller: 'caller',
      operation: 'core.workspace.repository.add',
      idempotencyKey: 'key',
    };
    const request = {
      workspaceId: 'workspace',
      source: 'workspace_settings',
      repository: { repoPath: join(oldRoot, 'repo') },
    } as const;
    const projection = relocatedRepositoryAddReceipt(
      transition,
      'repo',
      key,
      request,
      'legacy-path',
    );
    const log = W5CommitLog.open(join(dir, 'log.sqlite'));
    try {
      const store = createRelocatedReceiptStore(
        receiptStore(log),
        transition,
        [projection],
        () => true,
      );
      const parameters = {
        ...request,
        repository: { repoPath: projection.relocatedPath },
      };
      expect(log.lookupReceipt(key, projection.relocatedFingerprint)).toEqual({
        status: 'none',
      });
      const runner = createW5KeyedOperationRunner({
        getReceiptStore: () => store,
      });
      const work = jest.fn(() => Promise.resolve('repeated effect'));
      const admit = jest.fn(() => Promise.resolve());
      await Promise.all(
        [0, 1].map(() =>
          expect(
            runner(
              { ...key, parameters, admit, isPreEffectRefusal: () => false },
              (outcome) => outcome,
              work,
            ),
          ).rejects.toMatchObject({
            name: 'W5CommitRefusedError',
            reason: 'recovery-required',
            details: {},
          }),
        ),
      );
      expect(admit).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
      expect(log.lookupReceipt(key, projection.originalFingerprint)).toEqual({
        status: 'none',
      });

      // The projection authorizes one key and fingerprint, not a global path alias.
      const unrelated = [
        { ...key, idempotencyKey: 'new-key', parameters },
        {
          ...key,
          parameters: {
            ...request,
            repository: {
              repoPath:
                newPath === 'original'
                  ? projection.originalPath
                  : join(dir, 'unrelated'),
            },
          },
        },
      ];
      for (const input of unrelated) {
        const newWork = jest.fn(() => Promise.resolve('new effect'));
        await expect(
          runner(
            { ...input, isPreEffectRefusal: () => false },
            (outcome) => outcome,
            newWork,
          ),
        ).resolves.toBe('new effect');
        expect(newWork).toHaveBeenCalledTimes(1);
      }
      expect(() =>
        relocatedRepositoryAddReceipt(
          transition,
          'external',
          key,
          {
            workspaceId: 'workspace',
            source: 'workspace_settings',
            repository: { repoPath: join(dir, 'external') },
          },
          'legacy-path',
        ),
      ).toThrow('not-a-moved-object');
      expect(fingerprintW5Parameters({ a: 1, b: 2 })).toBe(
        fingerprintW5Parameters({ b: 2, a: 1 }),
      );
    } finally {
      log.close();
    }
  },
);

it('leaves unrelated external repositories untouched', async () => {
  const external = join(dir, 'external');
  await repository(external);
  const plan = await prepareRelocationGit(git, [external]);
  await copyRoot();
  const before = await treeSnapshot(external, true);
  await repairRelocationGit(transition, plan, workingRoot);
  expect(await treeSnapshot(external, true)).toEqual(before);
});

function metadataFixture(
  fields: Record<string, unknown>,
  projection: boolean | W5WorktreeListRowProjection<W5WorktreeListRow> = false,
): {
  files: Map<string, string>;
  manifest: ReturnType<typeof createWorkspaceManifestRepository>;
  list: ReturnType<typeof createWorktreeListRepository>;
  evidence: {
    workspaceId: string;
    targetId: string;
    manifestRaw: string;
    listRaw: string;
    repositoryPaths: string[];
    ownedPaths: string[];
  };
} {
  const manifestRaw = JSON.stringify({
    version: 1,
    authorityId: transition.from.authorityId,
  });
  const listRaw = JSON.stringify({
    version: 1,
    worktrees: [
      { id: 'combined', branchName: 'feature', createdAt: 'now', ...fields },
    ],
  });
  const files = new Map([
    ['manifest', manifestRaw],
    ['list', listRaw],
  ]);
  const store: W5FileStore = {
    read: (path) => {
      const raw = files.get(path);
      return Promise.resolve(
        raw === undefined ? { state: 'absent' } : { state: 'present', raw },
      );
    },
    replace: (path, contents) => {
      files.set(path, contents);
      return Promise.resolve();
    },
    remove: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
  return {
    files,
    manifest: createWorkspaceManifestRepository({
      store,
      filePath: () => 'manifest',
      storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
      knownFields: new Set(),
      knownRepoFields: new Set(),
    }),
    list: createWorktreeListRepository({
      store,
      filePath: () => 'list',
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(),
      readRow: (row) =>
        typeof projection === 'function'
          ? projection(row)
          : projection
            ? {
                id: row.id,
                branchName: row.branchName,
                createdAt: row.createdAt,
                replica: row.replica,
              }
            : row,
    }),
    evidence: {
      workspaceId: 'workspace',
      targetId: 'local',
      manifestRaw,
      listRaw,
      repositoryPaths: [],
      ownedPaths: [],
    },
  };
}

function combinedPathFields(
  root: string,
  external: string,
): Record<string, unknown> {
  const repositoryPath = join(root, 'repo');
  const checkoutPath = join(root, 'combined', 'repo');
  const linkPath = join(root, 'consumed');
  const rootPath = join(root, 'combined');
  const deletion = {
    referenceRepoPath: repositoryPath,
    repositoryIdentity: join(repositoryPath, '.git'),
    branchName: 'archived',
    expectedTip: 'a'.repeat(40),
    extension: { path: join(oldRoot, 'opaque') },
  };
  const mappings = [
    {
      repoPath: repositoryPath,
      oldWorktreePath: linkPath,
      newWorktreePath: checkoutPath,
      destinationRepoId: 'repo',
      repoName: 'Repo',
    },
    {
      repoPath: external,
      newWorktreePath: external,
      destinationRepoId: 'external',
      repoName: 'External',
    },
  ];
  const links = [
    {
      path: linkPath,
      targetPath: external,
      reason: 'adhoc-multi-repo-transition',
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'consumed',
      createdAt: 'now',
    },
    {
      path: join(root, 'consumed-repo'),
      targetPath: checkoutPath,
      reason: 'adhoc-multi-repo-transition',
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'consumed-repo',
      repoId: 'repo',
      createdAt: 'now',
    },
  ];
  const rewrites = [
    { fromRoot: linkPath, toRoot: rootPath },
    { fromRoot: external, toRoot: external },
  ];
  return {
    creation: {
      operationId: 'create',
      state: 'complete',
      phase: 'git-ready',
      checkouts: [
        { repositoryPath, checkoutPath },
        { repositoryPath: external, checkoutPath: external },
      ],
    },
    pendingArchiveBranchDeletion: deletion,
    pendingArchiveBranchDeletions: [
      { ...deletion, repoId: 'repo' },
      {
        ...deletion,
        repoId: 'external',
        referenceRepoPath: external,
        repositoryIdentity: join(external, '.git'),
      },
    ],
    healthIssue: {
      status: 'broken',
      code: 'git-error',
      message: 'Keep diagnostic text',
      checkedAt: 'now',
      worktreePath: rootPath,
      repoIssues: [
        {
          repoId: 'repo',
          repoName: 'Repo',
          repoPath: checkoutPath,
          code: 'git-error',
          message: 'Keep diagnostic text',
        },
        { repoId: 'external', repoPath: external },
      ],
    },
    compatibilitySymlinks: links,
    adhocTransitionSource: {
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'consumed',
      sourceRepoIds: ['repo'],
      repoMappings: mappings,
      filePathRewrites: rewrites,
      selectedRepoIdRewrites: { original: 'repo' },
      createdAt: 'now',
      joinedWorktreeMigration: {
        workspaceId: 'joined',
        worktreeId: 'joined',
        repoMappings: mappings,
        filePathRewrites: rewrites,
        compatibilitySymlinks: links,
      },
    },
    extension: {
      path: join(oldRoot, 'opaque'),
      targetPath: join(oldRoot, 'opaque'),
      authorityId: transition.from.authorityId,
    },
  };
}

it.each([false, true])(
  'relocates every persisted worktree path without changing IDs or opaque fields (narrow projection=%s)',
  async (narrow) => {
    const external = join(dir, 'external');
    await mkdir(external);
    const common = join(oldRoot, 'repo');
    const checkout = join(oldRoot, 'combined', 'repo');
    const link = join(oldRoot, 'consumed');
    await repository(common);
    await mkdir(join(oldRoot, 'combined'));
    await git(common, ['worktree', 'add', '-b', 'feature', checkout]);
    await writeFile(join(checkout, 'untracked'), 'retained bytes');
    await symlink(
      process.platform === 'win32'
        ? external
        : relative(dirname(link), external),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const plan = await prepareRelocationGit(git, [common, checkout]);
    const fixture = metadataFixture(
      combinedPathFields(oldRoot, external),
      narrow,
    );
    fixture.evidence.repositoryPaths = plan.checkouts.map((row) => row.path);
    fixture.evidence.ownedPaths = [
      link,
      join(oldRoot, 'consumed-repo'),
      join(oldRoot, 'combined'),
      ...plan.checkouts.map((row) => row.commonDirectory),
    ];
    await copyRoot();
    await repairRelocationGit(transition, plan, workingRoot);
    await rename(workingRoot, newRoot);
    await repairRelocatedWorkspace(
      transition,
      fixture.evidence,
      fixture.manifest,
      fixture.list,
    );
    const stored: unknown = JSON.parse(fixture.files.get('list') ?? 'null');
    expect(stored).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'combined',
          branchName: 'feature',
          createdAt: 'now',
          ...combinedPathFields(newRoot, external),
        },
      ],
    });
    expect(
      await readFile(join(newRoot, 'combined', 'repo', 'untracked'), 'utf8'),
    ).toBe('retained bytes');
    expect(
      await git(join(newRoot, 'combined', 'repo'), [
        'branch',
        '--show-current',
      ]),
    ).toBe('feature\n');

    // The cleanup consumer's lstat/readlink guard must find the moved link and its expected target.
    const read = await fixture.list.read('workspace');
    if (read.authority !== 'ok')
      throw new Error('readable relocated list required');
    const row = read.worktrees[0];
    if (!isJsonObject(row) || !Array.isArray(row.compatibilitySymlinks)) {
      // A narrow host projection does not expose links; persisted bytes above are still qualified.
      if (narrow) return;
      throw new Error('compatibility links required');
    }
    const movedLink: unknown = row.compatibilitySymlinks[0];
    if (
      !isJsonObject(movedLink) ||
      typeof movedLink.path !== 'string' ||
      typeof movedLink.targetPath !== 'string'
    )
      throw new Error('readable compatibility link required');
    expect((await lstat(movedLink.path)).isSymbolicLink()).toBe(true);
    expect(
      resolve(dirname(movedLink.path), await readlink(movedLink.path)),
    ).toBe(resolve(movedLink.targetPath));
    await rm(movedLink.path, { force: true });
    await expect(lstat(join(newRoot, 'consumed'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await lstat(external)).isDirectory()).toBe(true);
  },
);

const externalMetadataPath = resolve('/external');
const worktreePathCases: readonly [
  string,
  (path: unknown) => Record<string, unknown>,
][] = [
  [
    'creation.repositoryPath',
    (path) => ({
      creation: {
        checkouts: [
          { repositoryPath: path, checkoutPath: externalMetadataPath },
        ],
      },
    }),
  ],
  [
    'creation.checkoutPath',
    (path) => ({
      creation: {
        checkouts: [
          { repositoryPath: externalMetadataPath, checkoutPath: path },
        ],
      },
    }),
  ],
  [
    'pendingArchiveBranchDeletion.referenceRepoPath',
    (path) => ({
      pendingArchiveBranchDeletion: {
        referenceRepoPath: path,
        repositoryIdentity: externalMetadataPath,
      },
    }),
  ],
  [
    'pendingArchiveBranchDeletion.repositoryIdentity',
    (path) => ({
      pendingArchiveBranchDeletion: {
        referenceRepoPath: externalMetadataPath,
        repositoryIdentity: path,
      },
    }),
  ],
  [
    'pendingArchiveBranchDeletions.referenceRepoPath',
    (path) => ({
      pendingArchiveBranchDeletions: [
        { referenceRepoPath: path, repositoryIdentity: externalMetadataPath },
      ],
    }),
  ],
  [
    'pendingArchiveBranchDeletions.repositoryIdentity',
    (path) => ({
      pendingArchiveBranchDeletions: [
        { referenceRepoPath: externalMetadataPath, repositoryIdentity: path },
      ],
    }),
  ],
  [
    'healthIssue.worktreePath',
    (path) => ({ healthIssue: { worktreePath: path } }),
  ],
  [
    'healthIssue.repoIssues.repoPath',
    (path) => ({
      healthIssue: {
        worktreePath: externalMetadataPath,
        repoIssues: [{ repoPath: path }],
      },
    }),
  ],
  [
    'compatibilitySymlinks.path',
    (path) => ({
      compatibilitySymlinks: [{ path, targetPath: externalMetadataPath }],
    }),
  ],
  [
    'compatibilitySymlinks.targetPath',
    (path) => ({
      compatibilitySymlinks: [{ path: externalMetadataPath, targetPath: path }],
    }),
  ],
  [
    'adhocTransitionSource.repoMappings.repoPath',
    (path) => ({
      adhocTransitionSource: {
        repoMappings: [
          { repoPath: path, newWorktreePath: externalMetadataPath },
        ],
      },
    }),
  ],
  [
    'adhocTransitionSource.repoMappings.oldWorktreePath',
    (path) => ({
      adhocTransitionSource: {
        repoMappings: [
          {
            repoPath: externalMetadataPath,
            oldWorktreePath: path,
            newWorktreePath: externalMetadataPath,
          },
        ],
      },
    }),
  ],
  [
    'adhocTransitionSource.repoMappings.newWorktreePath',
    (path) => ({
      adhocTransitionSource: {
        repoMappings: [
          { repoPath: externalMetadataPath, newWorktreePath: path },
        ],
      },
    }),
  ],
  [
    'adhocTransitionSource.filePathRewrites.fromRoot',
    (path) => ({
      adhocTransitionSource: {
        filePathRewrites: [{ fromRoot: path, toRoot: externalMetadataPath }],
      },
    }),
  ],
  [
    'adhocTransitionSource.filePathRewrites.toRoot',
    (path) => ({
      adhocTransitionSource: {
        filePathRewrites: [{ fromRoot: externalMetadataPath, toRoot: path }],
      },
    }),
  ],
];
const joinedPathCases: readonly [
  string,
  (path: unknown) => Record<string, unknown>,
][] = worktreePathCases
  .filter(
    ([name]) =>
      name.startsWith('adhocTransitionSource.') ||
      name.startsWith('compatibilitySymlinks.'),
  )
  .map(([name, build]) => [
    `joinedWorktreeMigration.${name}`,
    (path: unknown): Record<string, unknown> => {
      const fields = build(path);
      return {
        adhocTransitionSource: {
          joinedWorktreeMigration: fields.adhocTransitionSource ?? fields,
        },
      };
    },
  ]);

it.each([...worktreePathCases, ...joinedPathCases])(
  'refuses unproven, invalid and noncanonical %s before staging either owner',
  async (_name, build) => {
    for (const invalid of [
      join(oldRoot, 'unproven'),
      join(dir, 'old-unrelated'),
      'relative/path',
      `${oldRoot}/repo/../unproven`,
      null,
      42,
    ]) {
      const fixture = metadataFixture(build(invalid));
      // Neither a proven parent nor an unrelated root grants descendant paths.
      fixture.evidence.ownedPaths = [oldRoot, join(dir, 'old-unrelated')];
      if (invalid === join(dir, 'old-unrelated')) {
        await repairRelocatedWorkspace(
          transition,
          fixture.evidence,
          fixture.manifest,
          fixture.list,
        );
        expect(JSON.parse(fixture.files.get('list') ?? 'null')).toMatchObject({
          worktrees: [build(invalid)],
        });
        continue;
      }
      await expect(
        repairRelocatedWorkspace(
          transition,
          fixture.evidence,
          fixture.manifest,
          fixture.list,
        ),
      ).rejects.toMatchObject({ name: 'RelocationRefusedError' });
      expect(fixture.files.get('manifest')).toBe(fixture.evidence.manifestRaw);
      expect(fixture.files.get('list')).toBe(fixture.evidence.listRaw);
    }
  },
);

it.each([
  { compatibilitySymlinks: [] },
  { creation: { checkouts: [] } },
  { pendingArchiveBranchDeletions: [] },
  { healthIssue: { worktreePath: externalMetadataPath, repoIssues: [] } },
  {
    adhocTransitionSource: {
      repoMappings: [],
      filePathRewrites: [],
      joinedWorktreeMigration: {
        repoMappings: [],
        filePathRewrites: [],
        compatibilitySymlinks: [],
      },
    },
  },
])('preserves empty path collections: %j', async (fields) => {
  const fixture = metadataFixture(fields);
  await repairRelocatedWorkspace(
    transition,
    fixture.evidence,
    fixture.manifest,
    fixture.list,
  );
  expect(JSON.parse(fixture.files.get('list') ?? 'null')).toEqual({
    version: 1,
    worktrees: [
      { id: 'combined', branchName: 'feature', createdAt: 'now', ...fields },
    ],
  });
});

it.each([
  { compatibilitySymlinks: {} },
  { compatibilitySymlinks: [null] },
  { creation: null },
  { creation: { checkouts: {} } },
  { pendingArchiveBranchDeletion: [] },
  { pendingArchiveBranchDeletions: {} },
  { healthIssue: null },
  { healthIssue: { worktreePath: externalMetadataPath, repoIssues: {} } },
  { adhocTransitionSource: [] },
  { adhocTransitionSource: { repoMappings: {} } },
  { adhocTransitionSource: { filePathRewrites: [null] } },
  {
    adhocTransitionSource: {
      joinedWorktreeMigration: { compatibilitySymlinks: {} },
    },
  },
])('refuses malformed path collections before staging: %j', async (fields) => {
  const fixture = metadataFixture(fields);
  await expect(
    repairRelocatedWorkspace(
      transition,
      fixture.evidence,
      fixture.manifest,
      fixture.list,
    ),
  ).rejects.toMatchObject({ name: 'RelocationRefusedError' });
  expect(fixture.files.get('manifest')).toBe(fixture.evidence.manifestRaw);
  expect(fixture.files.get('list')).toBe(fixture.evidence.listRaw);
});

it.each(['local', 'foreign', 'unreadable'] as const)(
  'uses raw %s replica evidence even when the host hides it',
  async (kind) => {
    const authorityId =
      kind === 'foreign' ? 'f'.repeat(64) : transition.from.authorityId;
    const recorded = recordLocalWorktreeReplica(
      'workspace',
      { id: 'combined', branchName: 'feature' },
      { authorityId, targetId: 'local', repoIds: [] },
    );
    if (recorded.state !== 'recorded')
      throw new Error('recorded fixture replica required');
    const replica =
      kind === 'unreadable'
        ? { state: 'recorded', repositories: [] }
        : recorded;
    const fixture = metadataFixture(
      { replica, extension: { path: join(oldRoot, 'opaque') } },
      ({ id, branchName, createdAt }) => ({
        id,
        branchName,
        createdAt,
        hostOnly: 'runtime projection',
      }),
    );
    const repair = repairRelocatedWorkspace(
      transition,
      fixture.evidence,
      fixture.manifest,
      fixture.list,
    );
    if (kind === 'unreadable') {
      await expect(repair).rejects.toMatchObject({
        reason: 'unreadable-replica',
      });
      expect(fixture.files.get('manifest')).toBe(fixture.evidence.manifestRaw);
      expect(fixture.files.get('list')).toBe(fixture.evidence.listRaw);
      return;
    }
    await repair;
    const read = await fixture.list.read('workspace');
    if (read.authority !== 'ok')
      throw new Error('readable owner document required');
    expect(read.document).toEqual({
      version: 1,
      worktrees: [
        {
          id: 'combined',
          branchName: 'feature',
          createdAt: 'now',
          extension: { path: join(oldRoot, 'opaque') },
          replica:
            kind === 'foreign'
              ? replica
              : {
                  ...recorded,
                  repositories: recorded.repositories.map((entry) => ({
                    ...entry,
                    authorityId: transition.to.authorityId,
                    targetId: {
                      ...entry.targetId,
                      primaryAuthorityId: transition.to.authorityId,
                    },
                  })),
                },
        },
      ],
    });
  },
);

it('preserves persisted replica authority against a synthetic host replica', async () => {
  const replica = recordLocalWorktreeReplica(
    'workspace',
    { id: 'combined', branchName: 'feature' },
    { authorityId: 'f'.repeat(64), targetId: 'local', repoIds: [] },
  );
  const fixture = metadataFixture({ replica }, (row) => ({
    ...row,
    replica: { state: 'never-recorded' },
  }));
  await repairRelocatedWorkspace(
    transition,
    fixture.evidence,
    fixture.manifest,
    fixture.list,
  );
  expect(JSON.parse(fixture.files.get('list') ?? 'null')).toEqual(
    JSON.parse(fixture.evidence.listRaw),
  );
});

it.each([
  'moved',
  'external',
  'empty',
  'unproven',
  'malformed',
  'relative',
  'non-string',
] as const)(
  'projects only qualified manifest path identity keys (%s)',
  async (kind) => {
    const fixture = metadataFixture({});
    const path =
      kind === 'external' ? join(dir, 'external') : join(oldRoot, 'repo');
    const keys =
      kind === 'empty'
        ? []
        : kind === 'malformed'
          ? {}
          : [
              kind === 'unproven'
                ? `path:${join(path, 'descendant')}`
                : kind === 'relative'
                  ? 'path:relative'
                  : kind === 'non-string'
                    ? null
                    : `path:${path}`,
              'remote:github.com/team/repo',
              `opaque:${join(oldRoot, 'extension')}`,
            ];
    const manifestRaw = JSON.stringify({
      version: 1,
      authorityId: transition.from.authorityId,
      temporaryRepoIdentityKeys: keys,
      extension: { path },
    });
    fixture.files.set('manifest', manifestRaw);
    fixture.evidence.manifestRaw = manifestRaw;
    fixture.evidence.repositoryPaths = [path];
    fixture.evidence.ownedPaths = [join(path, 'descendant')];
    const repair = repairRelocatedWorkspace(
      transition,
      fixture.evidence,
      fixture.manifest,
      fixture.list,
    );
    if (['unproven', 'malformed', 'relative', 'non-string'].includes(kind)) {
      await expect(repair).rejects.toMatchObject({
        name: 'RelocationRefusedError',
      });
      expect(fixture.files.get('manifest')).toBe(manifestRaw);
      expect(fixture.files.get('list')).toBe(fixture.evidence.listRaw);
      return;
    }
    await repair;
    expect(JSON.parse(fixture.files.get('manifest') ?? 'null')).toEqual({
      version: 1,
      authorityId: transition.to.authorityId,
      temporaryRepoIdentityKeys:
        kind === 'empty'
          ? []
          : [
              `path:${kind === 'moved' ? join(newRoot, 'repo') : path}`,
              'remote:github.com/team/repo',
              `opaque:${join(oldRoot, 'extension')}`,
            ],
      extension: { path },
    });
  },
);

it.each(['absolute', 'relative', 'ancestor'])(
  'refuses a retained-source %s owned link before any repair effect',
  async (kind) => {
    const checkout = join(oldRoot, 'checkout');
    const link = join(oldRoot, 'compatibility');
    await mkdir(checkout);
    await writeFile(join(checkout, 'dirty'), 'retained source bytes');
    await symlink(
      kind === 'relative'
        ? relative(dirname(join(workingRoot, 'compatibility')), checkout)
        : checkout,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyRoot();
    const recordAuthority = jest.fn(() => Promise.resolve());
    const repairMetadata = jest.fn(() => Promise.resolve());
    const execution = jest.fn(git);
    const runtime = join(workingRoot, 'runtime');
    await mkdir(runtime);
    await writeFile(join(runtime, 'core.json'), 'not yet invalidated');
    await expect(
      createRelocationRepairStep()({
        transition,
        workingRoot,
        gitPlan: { checkouts: [], backlinks: [] },
        ownedPaths: [
          kind === 'ancestor' ? join(link, 'dirty') : link,
          checkout,
        ],
        admit: () => Promise.resolve(),
        recordAuthority,
        repairMetadata,
      }),
    ).rejects.toMatchObject({ reason: 'stale-owned-link' });
    expect(recordAuthority).not.toHaveBeenCalled();
    expect(repairMetadata).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    expect(await readlink(join(workingRoot, 'compatibility'))).toBe(
      await readlink(link),
    );
    expect(await readFile(join(runtime, 'core.json'), 'utf8')).toBe(
      'not yet invalidated',
    );
  },
);

it('accepts moved relative links, unchanged external targets, absent and empty owned paths without following links', async () => {
  const checkout = join(oldRoot, 'checkout');
  const link = join(oldRoot, 'compatibility');
  const external = join(dir, 'external');
  await mkdir(checkout);
  await mkdir(external);
  await writeFile(join(external, 'bytes'), 'unchanged external bytes');
  await symlink('checkout', link, 'dir');
  await symlink(external, join(oldRoot, 'external-link'), 'dir');
  await copyRoot();
  const paths = [
    checkout,
    link,
    join(oldRoot, 'external-link'),
    join(oldRoot, 'absent'),
    external,
  ];
  await expect(
    assertRelocationOwnedPathsSafe(transition, paths, workingRoot),
  ).resolves.toBeUndefined();
  await expect(
    assertRelocationOwnedPathsSafe(transition, [], workingRoot),
  ).resolves.toBeUndefined();
  expect(await realpath(join(workingRoot, 'compatibility'))).toBe(
    join(workingRoot, 'checkout'),
  );
  expect(await readFile(join(external, 'bytes'), 'utf8')).toBe(
    'unchanged external bytes',
  );
  await expect(
    assertRelocationOwnedPathsSafe(transition, [link], workingRoot),
  ).rejects.toMatchObject({ reason: 'unproven-owned-link-target' });
  await expect(
    assertRelocationOwnedPathsSafe(
      transition,
      [join(link, 'child'), checkout],
      workingRoot,
    ),
  ).rejects.toMatchObject({ reason: 'symlink-owned-parent' });
  await expect(
    assertRelocationOwnedPathsSafe(
      transition,
      [`${oldRoot}/checkout/../other`],
      workingRoot,
    ),
  ).rejects.toMatchObject({ reason: 'noncanonical-owned-path' });
});

it.each([
  'source-root',
  'external-chain',
  'external-parent',
  'unlisted-external',
  'destination-chain',
  'cycle',
])('refuses %s owned-link indirection before effects', async (kind) => {
  const external = join(dir, 'external');
  const link = join(oldRoot, 'compatibility');
  const internal = join(oldRoot, 'indirection');
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
  if (kind === 'unlisted-external') await mkdir(external);
  else if (kind !== 'cycle') await symlink(oldRoot, external, directoryLink);
  let target = external;
  if (kind === 'source-root') target = oldRoot;
  if (kind === 'external-parent') target = join(external, 'child');
  if (kind === 'destination-chain') {
    await symlink(external, internal, directoryLink);
    target =
      process.platform === 'win32'
        ? join(newRoot, 'indirection')
        : 'indirection';
  }
  if (kind === 'cycle')
    target =
      process.platform === 'win32'
        ? join(newRoot, 'compatibility')
        : 'compatibility';
  await symlink(target, link, directoryLink);
  await copyRoot();
  const recordAuthority = jest.fn(() => Promise.resolve());
  const repairMetadata = jest.fn(() => Promise.resolve());
  const execution = jest.fn(git);
  const runtime = join(workingRoot, 'runtime');
  await mkdir(runtime);
  await writeFile(join(runtime, 'core.json'), 'not yet invalidated');
  const reason =
    kind === 'unlisted-external'
      ? 'unproven-owned-link-target'
      : kind === 'cycle'
        ? 'cyclic-owned-link'
        : kind === 'external-parent'
          ? 'symlink-owned-parent'
          : 'stale-owned-link';
  await expect(
    createRelocationRepairStep()({
      transition,
      workingRoot,
      gitPlan: { checkouts: [], backlinks: [] },
      ownedPaths: [
        link,
        internal,
        ...(kind === 'unlisted-external'
          ? []
          : [external, ...(kind === 'external-parent' ? [target] : [])]),
      ],
      admit: () => Promise.resolve(),
      recordAuthority,
      repairMetadata,
    }),
  ).rejects.toMatchObject({ reason });
  expect(recordAuthority).not.toHaveBeenCalled();
  expect(repairMetadata).not.toHaveBeenCalled();
  expect(execution).not.toHaveBeenCalled();
  expect(await readFile(join(runtime, 'core.json'), 'utf8')).toBe(
    'not yet invalidated',
  );
});

it('accepts fully inventoried relative and external link chains without changing either tree', async () => {
  const external = join(dir, 'external');
  const externalLink = join(dir, 'external-link');
  const internal = join(oldRoot, 'internal');
  const link = join(oldRoot, 'compatibility');
  const parentLink = join(oldRoot, 'nested', 'compatibility');
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(external);
  await mkdir(dirname(parentLink));
  await writeFile(join(external, 'bytes'), 'unchanged external bytes');
  await symlink(external, externalLink, directoryLink);
  await symlink(externalLink, internal, directoryLink);
  await symlink(
    process.platform === 'win32' ? join(newRoot, 'internal') : './internal',
    link,
    directoryLink,
  );
  await symlink(
    process.platform === 'win32' ? join(newRoot, 'internal') : '../internal',
    parentLink,
    directoryLink,
  );
  await copyRoot();
  const destination = await treeSnapshot(workingRoot, true);
  const outside = await treeSnapshot(external, true);
  await expect(
    assertRelocationOwnedPathsSafe(
      transition,
      [link, internal, externalLink, external, parentLink],
      workingRoot,
    ),
  ).resolves.toBeUndefined();
  expect(await treeSnapshot(workingRoot, true)).toEqual(destination);
  expect(await treeSnapshot(external, true)).toEqual(outside);
  expect(await readlink(externalLink)).toBe(external);
});

(process.platform === 'win32' ? it.skip : it)(
  'checks target components before parent traversal, not only their lexical projection',
  async () => {
    const checkout = join(oldRoot, 'checkout');
    const lexicalCheckout = join(oldRoot, 'old', 'checkout');
    const external = join(dir, 'external');
    const pivot = join(oldRoot, 'pivot');
    const link = join(oldRoot, 'compatibility');
    const ordinary = join(oldRoot, 'ordinary');
    const safeLink = join(oldRoot, 'safe-compatibility');
    await mkdir(checkout, { recursive: true });
    await mkdir(lexicalCheckout, { recursive: true });
    await mkdir(external);
    await mkdir(ordinary);
    await writeFile(join(checkout, 'dirty'), 'unchanged source bytes');
    await symlink(external, pivot, 'dir');
    await symlink('pivot/../old/checkout', link, 'dir');
    await symlink('ordinary/../checkout', safeLink, 'dir');
    await copyRoot();
    expect(await realpath(join(workingRoot, 'compatibility'))).toBe(checkout);
    const recordAuthority = jest.fn(() => Promise.resolve());
    const repairMetadata = jest.fn(() => Promise.resolve());
    const execution = jest.fn(git);
    await expect(
      createRelocationRepairStep()({
        transition,
        workingRoot,
        gitPlan: { checkouts: [], backlinks: [] },
        ownedPaths: [link, pivot, external, checkout, lexicalCheckout],
        admit: () => Promise.resolve(),
        recordAuthority,
        repairMetadata,
      }),
    ).rejects.toMatchObject({ reason: 'symlink-owned-parent' });
    expect(recordAuthority).not.toHaveBeenCalled();
    expect(repairMetadata).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    await expect(
      assertRelocationOwnedPathsSafe(
        transition,
        [safeLink, ordinary, checkout],
        workingRoot,
      ),
    ).resolves.toBeUndefined();
    expect(await realpath(join(workingRoot, 'safe-compatibility'))).toBe(
      join(workingRoot, 'checkout'),
    );
  },
);

(process.platform === 'win32' ? it.skip : it).each([
  'dangling',
  'directory-chain',
  'cycle',
  'absolute-destination',
  'source-escape',
  'indirect-source',
  'ordinary-parent',
  'external',
  'proven-external',
  'parent-traversal',
])(
  'whole-root copies check %s payload links identically before and after copying',
  async (kind) => {
    const home = join(oldRoot, 'cowork/home');
    await mkdir(home, { recursive: true });
    const link = join(home, 'AGENTS.md');
    let target = 'CLAUDE.md';
    if (kind === 'directory-chain' || kind === 'cycle') {
      await mkdir(join(home, '.agents/skills'), { recursive: true });
      await mkdir(join(home, '.claude'));
      await symlink('../.agents/skills', join(home, '.claude/skills'));
      if (kind === 'cycle')
        await symlink(
          '../../.claude/skills/example',
          join(home, '.agents/skills/example'),
        );
      else await writeFile(join(home, '.agents/skills/example'), 'carried');
      target = '.claude/skills/example';
    }
    if (kind === 'absolute-destination')
      target = join(newRoot, 'cowork/home/CLAUDE.md');
    if (kind === 'source-escape')
      target = relative(
        join(newRoot, 'cowork/home'),
        join(oldRoot, 'preferences.json'),
      );
    if (kind === 'indirect-source') {
      await symlink(oldRoot, join(home, 'pivot'));
      target = 'pivot/../CLAUDE.md';
    }
    if (kind === 'ordinary-parent') {
      await mkdir(join(home, 'ordinary'));
      target = 'ordinary/../CLAUDE.md';
    }
    if (kind === 'external') target = join(dir, 'unproven');
    if (kind === 'proven-external') {
      target = join(dir, 'external-file');
      await writeFile(target, 'external bytes');
    }
    if (kind === 'parent-traversal') {
      await symlink('..', join(home, 'pivot'));
      target = 'pivot/../../old/preferences.json';
    }
    await symlink(target, link);
    const paths = [link, ...(kind === 'proven-external' ? [target] : [])];
    await copyRoot();
    const checkRoot = async (
      root: string,
      source = false,
      published = false,
    ): Promise<void> => {
      const check = assertRelocationOwnedPathsSafe(
        transition,
        paths,
        root,
        published,
        { source },
      );
      if (
        ['source-escape', 'indirect-source', 'parent-traversal'].includes(kind)
      ) {
        const reason =
          kind === 'parent-traversal' || (kind === 'indirect-source' && source)
            ? 'symlink-owned-parent'
            : 'stale-owned-link';
        await expect(check).rejects.toMatchObject({ reason });
        await expect(check).rejects.toThrow(
          `link "cowork/home/AGENTS.md" -> ${JSON.stringify(target)}`,
        );
      } else await expect(check).resolves.toBeUndefined();
    };
    await checkRoot(oldRoot, true);
    await checkRoot(workingRoot);
    await rename(workingRoot, newRoot);
    await checkRoot(newRoot, false, true);
    expect(await readlink(join(newRoot, 'cowork/home/AGENTS.md'))).toBe(target);
  },
);

(process.platform === 'win32' ? it.skip : it).each([
  'external',
  'dangling-external',
  'source',
  'source-cycle',
  'source-indirection',
  'noncanonical-source',
  'owner-parent',
])(
  'whole-root absolute %s links are carried or projected only in staging',
  async (kind) => {
    const home = join(oldRoot, 'chat-plugins/provider-home');
    await mkdir(home, { recursive: true });
    const link = join(home, 'pointer');
    const targetFile = join(oldRoot, 'plugin-cache/linear/local');
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, 'plugin bytes');
    let target = targetFile;
    if (kind === 'external' || kind === 'dangling-external') {
      target = join(dir, 'user-home/skills');
      if (kind === 'external') {
        await mkdir(dirname(target), { recursive: true });
        await symlink(join(dir, 'absent-user-owned-folder'), target);
      }
    }
    if (kind === 'source-cycle') target = link;
    if (kind === 'source-indirection') {
      await symlink(join(oldRoot, 'plugin-cache'), join(home, 'directory'));
      target = join(home, 'directory/linear/local');
    }
    if (kind === 'noncanonical-source')
      target = `${oldRoot}/plugin-cache/../preferences.json`;
    if (kind === 'owner-parent') {
      await mkdir(join(oldRoot, 'owned-directory'));
      await writeFile(join(oldRoot, 'owned-directory/record'), 'owned');
      target = join(oldRoot, 'owned-directory');
    }
    await symlink(target, link);
    const paths = kind === 'owner-parent' ? [join(link, 'record')] : [link];
    const check = assertRelocationOwnedPathsSafe(
      transition,
      paths,
      oldRoot,
      false,
      { source: true },
    );
    if (['noncanonical-source', 'owner-parent'].includes(kind)) {
      await expect(check).rejects.toThrow(
        `link "chat-plugins/provider-home/pointer" -> ${JSON.stringify(target)}`,
      );
      await copyRoot();
      await expect(
        repairRelocationCarriedLinks(transition, paths, workingRoot),
      ).rejects.toThrow('Installation relocation refused');
      expect(await readlink(join(workingRoot, relative(oldRoot, link)))).toBe(
        target,
      );
      return;
    }
    await expect(check).resolves.toBeUndefined();
    await copyRoot();
    await repairRelocationCarriedLinks(transition, paths, workingRoot);
    await assertRelocationOwnedPathsSafe(
      transition,
      paths,
      workingRoot,
      false,
      {},
    );
    // Repeating the repair after an interruption must not project the new root again.
    await repairRelocationCarriedLinks(transition, paths, workingRoot);
    await rename(workingRoot, newRoot);
    await assertRelocationOwnedPathsSafe(transition, paths, newRoot, true, {});
    expect(await readlink(join(newRoot, relative(oldRoot, link)))).toBe(
      kind === 'external' || kind === 'dangling-external'
        ? target
        : join(newRoot, relative(oldRoot, target)),
    );
    expect(await readlink(link)).toBe(target);
    expect(await readFile(targetFile, 'utf8')).toBe('plugin bytes');
  },
);
