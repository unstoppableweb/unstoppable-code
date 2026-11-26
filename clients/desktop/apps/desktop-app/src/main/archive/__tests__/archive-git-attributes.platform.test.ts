// CAN-6776: test:platform-services runs this on Linux, macOS and Windows. A
// checkout whose attributes transform bytes archives through the real capture
// and restores byte for byte, without running a filter; snapshot refusals keep
// their typed code across the archive I/O worker transport.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  lstatSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as ArchiveIoWorker from '../archive-io-worker';
import type { ArchiveGitCaptureRepositoryInput } from '../archive-io-protocol';

class FakeParentPort extends EventEmitter {
  public constructor(private readonly deliver: (message: unknown) => void) {
    super();
  }
  public postMessage(message: unknown): void {
    this.deliver(message);
  }
}

/** The archive worker in this process, behind a structured-clone boundary. */
function mockForkArchiveWorker(): EventEmitter {
  const { startArchiveIoWorker } = jest.requireActual<typeof ArchiveIoWorker>(
    '../archive-io-worker',
  );
  const child = new EventEmitter();
  const port = new FakeParentPort((message) => {
    const copy = structuredClone(message);
    setImmediate(() => child.emit('message', copy));
  });
  Object.assign(child, {
    pid: process.pid,
    postMessage: (message: unknown): void => {
      const copy = structuredClone(message);
      setImmediate(() => port.emit('message', { data: copy }));
    },
    kill: (): boolean => {
      setImmediate(() => child.emit('exit', 0));
      return true;
    },
  });
  startArchiveIoWorker(port, () => {
    setImmediate(() => child.emit('exit', 0));
  });
  return child;
}

jest.mock('electron', () => ({
  ...jest.requireActual<Record<string, unknown>>('electron'),
  utilityProcess: { fork: (): EventEmitter => mockForkArchiveWorker() },
}));

import { captureArchiveGit } from '../archive-git-operations';
import {
  runArchiveIoRequest,
  shutdownArchiveIoRunner,
} from '../archive-io-runner';
import {
  assertWorktreeSnapshotSupported,
  gitVersionSupportsAttributeSource,
  parseGitVersionNumbers,
  resolveRestoreAttributeSource,
  restoreIndexAndWorkingTreeSnapshot,
} from '../../lib/git-tree-snapshot';
import {
  assertScopedStartPointAttributes,
  runWithGitAttributeSources,
} from '../../lib/git-attribute-source-scope';
import { createWorktreeFromStartPoint } from '../../lib/git';
import {
  isWorktreeSnapshotRefusalError,
  redactWorktreeSnapshotRefusalMessage,
  worktreeSnapshotRefusalDiagnostic,
} from '../../lib/worktree-snapshot-refusal';

jest.setTimeout(60_000);

let root: string;
let reference: string;
let checkout: string;

function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', stdio: 'pipe', env },
  ).trim();
}

/**
 * Fixture setup Git, without the host's global and system configuration: an
 * installed Git LFS sets `filter.lfs.process`, which Git prefers over the
 * fixture's `filter.lfs.clean` and `filter.lfs.smudge`.
 */
function git(cwd: string, ...args: string[]): string {
  return runGit(cwd, args, {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
}

/** Makes any LFS filter Git runs in `reference` fail its command. */
function failLfsFilters(): void {
  git(reference, 'config', 'filter.lfs.required', 'true');
  // Repository config outranks an installed Git LFS's process driver.
  git(reference, 'config', 'filter.lfs.process', 'false');
  git(reference, 'config', 'filter.lfs.clean', 'false');
  git(reference, 'config', 'filter.lfs.smudge', 'false');
}

/** Commits the removal of the fixture's in-tree attributes. */
function dropInTreeAttributes(): void {
  git(checkout, 'rm', '-q', '.gitattributes');
  git(checkout, 'commit', '-q', '-m', 'no attributes');
}

/** Whether `ref` resolves in the reference repository. */
function hasRef(ref: string): boolean {
  try {
    git(reference, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

function gitEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

/** Every file below `path` with its bytes, skipping Git metadata. */
function files(path: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const full = join(dir, name);
      const rel = `${prefix}${name}`;
      if (lstatSync(full).isDirectory()) walk(full, `${rel}/`);
      else entries[rel] = readFileSync(full).toString('base64');
    }
  };
  walk(path, '');
  return entries;
}

/** A snapshot blob's exact bytes, base64-encoded. */
function snapshotBlob(commit: string, path: string): string {
  return execFileSync(
    'git',
    ['-C', reference, 'cat-file', 'blob', `${commit}:${path}`],
    { stdio: 'pipe' },
  ).toString('base64');
}

function captureInput(
  repoId: string,
  worktreeRepoPath: string,
): ArchiveGitCaptureRepositoryInput {
  return {
    repoId,
    repoName: repoId,
    relativePath: '.',
    referenceRepoPath: reference,
    worktreeRepoPath,
    snapshotRef: `refs/app/archived-containers/platform/test/${repoId}`,
  };
}

function capture(
  repositories: ArchiveGitCaptureRepositoryInput[],
  inherited: Record<string, string> = {},
): ReturnType<typeof captureArchiveGit> {
  return captureArchiveGit({
    git: { executable: 'git', env: { ...gitEnvironment(), ...inherited } },
    stagedDescriptorPath: join(root, `descriptor-${String(Date.now())}.json`),
    repositories,
    signal: new AbortController().signal,
    child: { started: () => undefined, exited: () => undefined },
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'archive-attributes-')));
  reference = join(root, 'reference');
  checkout = join(root, 'checkout');
  writeFileSync(join(root, 'empty.gitconfig'), '');
  mkdirSync(reference);
  git(reference, 'init', '-q', '-b', 'main');
  // Git for Windows defaults core.autocrlf on; the fixture fixes its own.
  git(reference, 'config', 'core.autocrlf', 'false');
  writeFileSync(
    join(reference, '.gitattributes'),
    '* text=auto eol=lf\n*.bin filter=lfs diff=lfs merge=lfs -text\n',
  );
  writeFileSync(join(reference, 'crlf.txt'), 'one\r\ntwo\r\n');
  writeFileSync(join(reference, 'asset.bin'), 'payload-1');
  git(reference, '-c', 'filter.lfs.clean=cat', 'add', '-A');
  git(reference, '-c', 'filter.lfs.clean=cat', 'commit', '-q', '-m', 'base');
  git(
    reference,
    '-c',
    'filter.lfs.smudge=cat',
    'worktree',
    'add',
    '-q',
    '-b',
    'feature',
    checkout,
    'main',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeAll(() => {
  // Windows: name the PATH Git for `git.ts`, so the restore's destination
  // checkout skips desktop Git discovery and its saved preference.
  if (process.platform !== 'win32') return;
  const [found] = execFileSync('where', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  if (found) process.env.CANOPY_GIT_EXECUTABLE = found;
});

afterAll(async () => {
  await shutdownArchiveIoRunner();
});

it.each(['false', 'true'])(
  'round-trips transforming attributes byte for byte without running a filter (core.autocrlf=%s)',
  async (autocrlf) => {
    const banner = git(reference, '--version');
    // Windows CI evidence: which Git ran, and that it took the lossless branch.
    process.stdout.write(
      `CAN-6776 archive attribute round trip with ${banner}\n`,
    );
    expect(parseGitVersionNumbers(banner)).not.toBeNull();
    expect(gitVersionSupportsAttributeSource(banner)).toBe(true);

    // A stat-clean CRLF file whose index blob is the normalized LF form.
    writeFileSync(join(checkout, 'crlf.txt'), 'one\r\ntwo\r\n');
    git(checkout, '-c', 'filter.lfs.clean=cat', 'add', 'crlf.txt');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(checkout, 'crlf.txt'), past, past);
    git(checkout, '-c', 'filter.lfs.clean=cat', 'update-index', '--refresh');
    expect(git(checkout, 'diff-files', '--name-only')).toBe('');
    // Independent staged and unstaged changes, a same-sized LFS edit and
    // untracked CRLF bytes.
    writeFileSync(join(checkout, 'staged.txt'), 'staged\r\n');
    git(checkout, '-c', 'filter.lfs.clean=cat', 'add', 'staged.txt');
    writeFileSync(join(checkout, 'staged.txt'), 'staged edit\r\n');
    writeFileSync(join(checkout, 'asset.bin'), 'payload-2');
    writeFileSync(join(checkout, 'notes.txt'), 'notes\r\n');
    // Any filter Git runs from here on fails the command.
    failLfsFilters();
    // Git for Windows installs with core.autocrlf=true; the archive and the
    // destination checkout must not convert bytes under it either.
    git(reference, 'config', 'core.autocrlf', autocrlf);
    const before = files(checkout);
    const index = git(checkout, 'ls-files', '-s');

    // A desktop launched with GIT_ATTR_SOURCE set inherits it; one naming the
    // empty tree would hide the in-tree attributes from capture.
    const emptyTree = execFileSync(
      'git',
      ['-C', reference, 'hash-object', '-t', 'tree', '--stdin'],
      { encoding: 'utf8', input: '' },
    ).trim();
    const { repositories } = await capture([captureInput('repo', checkout)], {
      GIT_ATTR_SOURCE: emptyTree,
    });
    const [repository] = repositories;
    if (!repository) throw new Error('Missing captured repository');
    expect(repository.attributePolicy).toBe('ignore-in-tree-attributes');
    expect(
      execFileSync(
        'git',
        [
          '-C',
          reference,
          'cat-file',
          'blob',
          `${repository.worktreeSnapshotCommit}:crlf.txt`,
        ],
        { stdio: 'pipe' },
      ).toString('base64'),
    ).toBe(Buffer.from('one\r\ntwo\r\n').toString('base64'));

    // The sentinel is live under the host's own Git configuration: a checkout
    // that reads in-tree attributes runs the failing filter, and succeeds
    // once the LFS driver is switched off. A process driver that exits
    // before its handshake can surface as a hung-up remote end instead.
    const unscopedCheckout =
      (name: string, config: string[] = []) =>
      (): string =>
        runGit(reference, [
          ...config,
          'worktree',
          'add',
          '-q',
          '--detach',
          join(root, name),
          repository.headCommit,
        ]);
    expect(unscopedCheckout('unscoped')).toThrow(
      /smudge filter lfs failed|the remote end hung up unexpectedly/,
    );
    expect(
      unscopedCheckout('unscoped-control', [
        '-c',
        'filter.lfs.required=false',
        '-c',
        'filter.lfs.process=',
        '-c',
        'filter.lfs.smudge=',
      ]),
    ).not.toThrow();

    // Restore as an archive restore does: preflight, then create the
    // destination and replay the snapshots under the same attribute source.
    // The desktop's inherited source names a tree that sends every path
    // through the failing filter, so restore succeeds only if it ignores it.
    const filterEverything = execFileSync(
      'git',
      ['-C', reference, 'hash-object', '-w', '--stdin'],
      { encoding: 'utf8', input: '* filter=lfs\n' },
    ).trim();
    const hostAttributeSource = process.env.GIT_ATTR_SOURCE;
    process.env.GIT_ATTR_SOURCE = execFileSync(
      'git',
      ['-C', reference, 'mktree'],
      {
        encoding: 'utf8',
        input: `100644 blob ${filterEverything}\t.gitattributes\n`,
      },
    ).trim();
    const destination = join(root, 'restored');
    try {
      const attributeSource = await resolveRestoreAttributeSource(
        reference,
        repository,
      );
      await runWithGitAttributeSources(
        new Map([[reference, attributeSource]]),
        () =>
          createWorktreeFromStartPoint(
            reference,
            destination,
            'restored',
            repository.headCommit,
          ),
      );
      await restoreIndexAndWorkingTreeSnapshot({
        repoPath: destination,
        headCommit: repository.headCommit,
        indexSnapshotCommit: repository.indexSnapshotCommit,
        worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
        attributes: { attributeSource },
      });
    } finally {
      if (hostAttributeSource === undefined) delete process.env.GIT_ATTR_SOURCE;
      else process.env.GIT_ATTR_SOURCE = hostAttributeSource;
    }
    expect(files(destination)).toEqual(before);
    expect(git(destination, 'ls-files', '-s')).toBe(index);
  },
);

it.each(['unset', 'unspecified'])(
  'archives byte for byte a checkout whose filter selects a configured driver named %s',
  async (driver) => {
    // `check-attr` prints `filter: <driver>` here exactly as for `-filter`.
    writeFileSync(join(checkout, '.gitattributes'), `* filter=${driver}\n`);
    git(checkout, 'add', '.gitattributes');
    git(checkout, 'commit', '-q', '-m', driver);
    // The driver discards every byte it cleans.
    git(reference, 'config', `filter.${driver}.clean`, 'cat >/dev/null');
    writeFileSync(join(checkout, 'crlf.txt'), 'edited\r\n');
    const before = files(checkout);

    const { repositories } = await capture([captureInput('repo', checkout)]);
    const [repository] = repositories;
    if (!repository) throw new Error('Missing captured repository');
    expect(repository.attributePolicy).toBe('ignore-in-tree-attributes');
    expect(snapshotBlob(repository.worktreeSnapshotCommit, 'crlf.txt')).toBe(
      Buffer.from('edited\r\n').toString('base64'),
    );
    expect(files(checkout)).toEqual(before);

    const attributeSource = await resolveRestoreAttributeSource(
      reference,
      repository,
    );
    const destination = join(root, 'restored');
    await runWithGitAttributeSources(
      new Map([[reference, attributeSource]]),
      () =>
        createWorktreeFromStartPoint(
          reference,
          destination,
          'restored',
          repository.headCommit,
        ),
    );
    await restoreIndexAndWorkingTreeSnapshot({
      repoPath: destination,
      headCommit: repository.headCommit,
      indexSnapshotCommit: repository.indexSnapshotCommit,
      worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      attributes: { attributeSource },
    });
    expect(files(destination)).toEqual(before);
  },
);

it('archives byte for byte when an inherited GIT_CONFIG hides a configured driver named unset', async () => {
  writeFileSync(join(checkout, '.gitattributes'), '* filter=unset\n');
  git(checkout, 'add', '.gitattributes');
  git(checkout, 'commit', '-q', '-m', 'unset');
  git(reference, 'config', 'filter.unset.clean', 'cat >/dev/null');
  writeFileSync(join(checkout, 'crlf.txt'), 'edited\r\n');
  const before = files(checkout);

  // Only `git config` reads GIT_CONFIG; every other capture command still
  // runs the repository's driver.
  const { repositories } = await capture([captureInput('repo', checkout)], {
    GIT_CONFIG: join(root, 'empty.gitconfig'),
  });
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  expect(repository.attributePolicy).toBe('ignore-in-tree-attributes');
  expect(snapshotBlob(repository.worktreeSnapshotCommit, 'crlf.txt')).toBe(
    Buffer.from('edited\r\n').toString('base64'),
  );
  expect(files(checkout)).toEqual(before);
});

it('archives a checkout whose only filter attribute is unset without an attribute policy', async () => {
  writeFileSync(join(checkout, '.gitattributes'), '* -filter\n');
  git(checkout, 'add', '.gitattributes');
  git(checkout, 'commit', '-q', '-m', 'no filter');
  writeFileSync(join(checkout, 'crlf.txt'), 'edited\r\n');

  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  expect(repository.attributePolicy).toBeUndefined();
  expect(snapshotBlob(repository.worktreeSnapshotCommit, 'crlf.txt')).toBe(
    Buffer.from('edited\r\n').toString('base64'),
  );
});

it('refuses a restore when a transforming attribute now applies from outside the tree', async () => {
  writeFileSync(join(checkout, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(join(reference, '.git', 'info', 'attributes'), '* eol=crlf\n');
  await expect(
    resolveRestoreAttributeSource(reference, repository),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
});

it('checks out the restore destination without its configuration-only filter, then refuses the replay', async () => {
  writeFileSync(join(checkout, 'lf.txt'), 'one\ntwo\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  // Applies on the restored branch only, so the reference repository's
  // preflight and the destination's start-point check both pass. Any smudge
  // leaves the sentinel.
  const forwardSlashes = (path: string): string => path.replace(/\\/g, '/');
  const sentinel = join(root, 'smudged');
  writeFileSync(join(root, 'restored.attributes'), '* filter=mark\n');
  writeFileSync(
    join(root, 'restored.gitconfig'),
    `[core]\n\tattributesFile = ${forwardSlashes(join(root, 'restored.attributes'))}\n`,
  );
  git(
    reference,
    'config',
    'includeIf.onbranch:restored.path',
    forwardSlashes(join(root, 'restored.gitconfig')),
  );
  git(reference, 'config', 'filter.mark.required', 'true');
  git(
    reference,
    'config',
    'filter.mark.smudge',
    `touch '${forwardSlashes(sentinel)}' && cat`,
  );
  git(reference, 'config', 'filter.mark.clean', 'cat');
  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await runWithGitAttributeSources(
    new Map([[reference, attributeSource]]),
    () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
  );
  expect(existsSync(sentinel)).toBe(false);
  // Live on the restored branch: a plain checkout there runs the smudge.
  rmSync(join(destination, 'crlf.txt'));
  git(destination, 'checkout', '--', 'crlf.txt');
  expect(existsSync(sentinel)).toBe(true);
  rmSync(sentinel);
  await expect(
    restoreIndexAndWorkingTreeSnapshot({
      repoPath: destination,
      headCommit: repository.headCommit,
      indexSnapshotCommit: repository.indexSnapshotCommit,
      worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      attributes: { attributeSource },
    }),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
  expect(existsSync(sentinel)).toBe(false);
});

it('checks out the restore destination without a branch-only driver named unset, then refuses the replay', async () => {
  writeFileSync(join(checkout, 'lf.txt'), 'one\ntwo\n');
  // `* -filter` and `* filter=unset` print alike; with no driver configured
  // this archives.
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(join(reference, '.git', 'info', 'attributes'), '* -filter\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  const attributeSourceBefore = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  // The scope's own `required=false` override configures no driver.
  await expect(
    runWithGitAttributeSources(
      new Map([[reference, attributeSourceBefore]]),
      () => assertScopedStartPointAttributes(reference, repository.headCommit),
    ),
  ).resolves.toBe(repository.headCommit);
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    '* filter=unset\n',
  );
  const forwardSlashes = (path: string): string => path.replace(/\\/g, '/');
  const sentinel = join(root, 'smudged');
  // Required: an emptied command alone would fail the checkout.
  writeFileSync(
    join(root, 'restored.gitconfig'),
    `[filter "unset"]\n\tsmudge = touch '${forwardSlashes(sentinel)}' && cat\n\trequired = true\n`,
  );
  git(
    reference,
    'config',
    'includeIf.onbranch:restored.path',
    forwardSlashes(join(root, 'restored.gitconfig')),
  );
  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await runWithGitAttributeSources(
    new Map([[reference, attributeSource]]),
    () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
  );
  expect(existsSync(sentinel)).toBe(false);
  await expect(
    restoreIndexAndWorkingTreeSnapshot({
      repoPath: destination,
      headCommit: repository.headCommit,
      indexSnapshotCommit: repository.indexSnapshotCommit,
      worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      attributes: { attributeSource },
    }),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
  expect(existsSync(sentinel)).toBe(false);
});

it('refuses to restore onto a branch that has advanced past the archived commit, without running a filter', async () => {
  // Archived: an untracked CRLF file under an in-tree filter that is required.
  writeFileSync(
    join(checkout, '.gitattributes'),
    `${readFileSync(join(checkout, '.gitattributes'), 'utf8')}*.txt filter=mark\n`,
  );
  git(checkout, 'add', '.gitattributes');
  git(checkout, 'commit', '-q', '-m', 'mark');
  writeFileSync(join(checkout, 'new.txt'), 'new\r\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await runWithGitAttributeSources(
    new Map([[reference, attributeSource]]),
    () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
  );
  // The branch moves on between the restore's branch check and its replay.
  writeFileSync(join(destination, 'later.md'), 'later\n');
  git(destination, 'add', 'later.md');
  git(destination, 'commit', '-q', '-m', 'later');
  const advancedHead = git(destination, 'rev-parse', 'HEAD');
  const forwardSlashes = (path: string): string => path.replace(/\\/g, '/');
  const sentinel = join(root, 'smudged');
  git(reference, 'config', 'filter.mark.required', 'true');
  git(
    reference,
    'config',
    'filter.mark.smudge',
    `touch '${forwardSlashes(sentinel)}' && cat`,
  );
  git(reference, 'config', 'filter.mark.clean', 'cat');
  const before = files(destination);

  // A cherry-pick here would read the in-tree attributes the policy ignores.
  await expect(
    restoreIndexAndWorkingTreeSnapshot({
      repoPath: destination,
      headCommit: repository.headCommit,
      indexSnapshotCommit: repository.indexSnapshotCommit,
      worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      preserveDescendantHead: true,
      attributes: { attributeSource },
    }),
  ).rejects.toMatchObject({ code: 'GIT_CAPTURE_TRANSFORMING_ATTRIBUTE' });
  expect(existsSync(sentinel)).toBe(false);
  expect(files(destination)).toEqual(before);
  expect(git(destination, 'rev-parse', 'HEAD')).toBe(advancedHead);
});

it('refuses a capture when an external attribute applies to a path staged for deletion', async () => {
  // Restore writes the path from the archived HEAD and would refuse it.
  git(checkout, 'rm', '-q', 'crlf.txt');
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    'crlf.txt eol=crlf\n',
  );
  await expect(capture([captureInput('repo', checkout)])).rejects.toMatchObject(
    { code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE' },
  );
});

it('refuses a restore when an external required filter now applies to a path deleted before archiving', async () => {
  // Restore writes the deleted path from the archived HEAD, then removes it.
  rmSync(join(checkout, 'crlf.txt'));
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  expect(() =>
    git(
      reference,
      'cat-file',
      '-e',
      `${repository.worktreeSnapshotCommit}:crlf.txt`,
    ),
  ).toThrow();
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    'crlf.txt filter=lfs\n',
  );
  failLfsFilters();
  await expect(
    resolveRestoreAttributeSource(reference, repository),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
});

it('refuses, before creating it, a restore destination whose start point an external filter would transform', async () => {
  writeFileSync(join(checkout, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  // The base the destination starts from gained a path no snapshot has.
  git(reference, 'checkout', '-q', '-b', 'base', 'main');
  writeFileSync(join(reference, 'later.dat'), 'later');
  git(reference, 'add', 'later.dat');
  git(reference, 'commit', '-q', '-m', 'later');
  git(reference, 'checkout', '-q', 'main');
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    'later.dat filter=lfs\n',
  );
  failLfsFilters();

  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await expect(
    runWithGitAttributeSources(new Map([[reference, attributeSource]]), () =>
      createWorktreeFromStartPoint(reference, destination, 'restored', 'base'),
    ),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
  expect(existsSync(destination)).toBe(false);
  expect(() =>
    git(reference, 'rev-parse', '--verify', 'refs/heads/restored'),
  ).toThrow();
});

/** Makes `reference` run a required `mark` filter that leaves `sentinel`. */
function markFilter(sentinel: string): void {
  git(reference, 'config', 'filter.mark.required', 'true');
  git(
    reference,
    'config',
    'filter.mark.smudge',
    `touch '${sentinel.replace(/\\/g, '/')}' && cat`,
  );
  git(reference, 'config', 'filter.mark.clean', 'cat');
}

it('checks out the restore destination from the commit its start-point check read, not a replacement', async () => {
  writeFileSync(join(checkout, 'lf.txt'), 'one\ntwo\n');
  const before = files(checkout);
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  // A replacement for the archived HEAD adds a path only an external filter
  // matches.
  const sentinel = join(root, 'smudged');
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    'replaced.dat filter=mark\n',
  );
  markFilter(sentinel);
  const blob = execFileSync(
    'git',
    ['-C', reference, 'hash-object', '-w', '--stdin'],
    { input: 'replaced\n', encoding: 'utf8' },
  ).trim();
  const tree = execFileSync('git', ['-C', reference, 'mktree'], {
    input: `${git(reference, 'ls-tree', repository.headCommit)}\n100644 blob ${blob}\treplaced.dat\n`,
    encoding: 'utf8',
  }).trim();
  git(
    reference,
    'replace',
    repository.headCommit,
    git(reference, 'commit-tree', tree, '-m', 'replacement'),
  );
  expect(
    git(reference, 'ls-tree', '--name-only', repository.headCommit),
  ).toContain('replaced.dat');

  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await runWithGitAttributeSources(
    new Map([[reference, attributeSource]]),
    () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
  );
  expect(existsSync(sentinel)).toBe(false);
  await restoreIndexAndWorkingTreeSnapshot({
    repoPath: destination,
    headCommit: repository.headCommit,
    indexSnapshotCommit: repository.indexSnapshotCommit,
    worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
    attributes: { attributeSource },
  });
  expect(files(destination)).toEqual(before);
  expect(existsSync(sentinel)).toBe(false);
});

it('refuses, before creating it, a restore destination whose filter only a user attributes macro cancels', async () => {
  writeFileSync(join(checkout, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  // The user attributes file defines the macro that cancels the filter; the
  // destination's checkout ignores that file.
  const sentinel = join(root, 'smudged');
  writeFileSync(join(root, 'macro.attributes'), '[attr]nofilter -filter\n');
  git(
    reference,
    'config',
    'core.attributesFile',
    join(root, 'macro.attributes').replace(/\\/g, '/'),
  );
  mkdirSync(join(reference, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(reference, '.git', 'info', 'attributes'),
    'crlf.txt filter=mark nofilter\n',
  );
  markFilter(sentinel);
  expect(git(reference, 'check-attr', 'filter', 'crlf.txt')).toBe(
    'crlf.txt: filter: unset',
  );

  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await expect(
    runWithGitAttributeSources(new Map([[reference, attributeSource]]), () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
    ),
  ).rejects.toMatchObject({
    code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
  });
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(sentinel)).toBe(false);
});

it('keeps a raw failure in one repository ahead of a refusal in another, and rolls both back', async () => {
  writeFileSync(join(checkout, 'later.txt'), 'later\n');
  git(checkout, 'add', '-N', 'later.txt');
  const clean = join(root, 'clean');
  git(reference, 'worktree', 'add', '-q', '-b', 'clean', clean, 'main');
  const unregistered = join(root, 'unregistered');
  mkdirSync(unregistered);

  const refused = capture([
    captureInput('clean', clean),
    captureInput('refused', checkout),
  ]);
  await expect(refused).rejects.toMatchObject({
    code: 'GIT_CAPTURE_INTENT_TO_ADD',
  });
  // The clean repository's pinned snapshot was released again.
  expect(() =>
    git(
      reference,
      'rev-parse',
      '--verify',
      'refs/app/archived-containers/platform/test/clean',
    ),
  ).toThrow();

  // Two refusals fill both capture slots, so one is recorded before the raw
  // failure starts: first-error-wins would surface a refusal.
  const alsoRefused = join(root, 'also-refused');
  git(reference, 'worktree', 'add', '-q', '-b', 'also', alsoRefused, 'main');
  writeFileSync(join(alsoRefused, 'later.txt'), 'later\n');
  git(alsoRefused, 'add', '-N', 'later.txt');
  const mixed = capture([
    captureInput('a-refused', checkout),
    captureInput('b-refused', alsoRefused),
    captureInput('c-raw', unregistered),
  ]);
  await expect(mixed).rejects.toThrow('no unique Git registration');
  await mixed.catch((error: unknown) => {
    expect(isWorktreeSnapshotRefusalError(error)).toBe(false);
  });
});

it.each([
  [
    'an external transforming attribute',
    'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
    (): void => {
      writeFileSync(join(checkout, 'private-name.txt'), 'external\r\n');
      mkdirSync(join(reference, '.git', 'info'), { recursive: true });
      writeFileSync(join(reference, '.git', 'info', 'attributes'), '* text\n');
    },
  ],
  [
    'an external filter driver named unset',
    'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
    (): void => {
      writeFileSync(join(checkout, 'private-name.txt'), 'external\n');
      git(reference, 'config', 'filter.unset.clean', 'cat >/dev/null');
      mkdirSync(join(reference, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(reference, '.git', 'info', 'attributes'),
        '* filter=unset\n',
      );
    },
  ],
  [
    'a same-sized edit under an external filter whose required clean fails',
    'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
    (): void => {
      dropInTreeAttributes();
      writeFileSync(join(checkout, 'private-name.bin'), 'size-1');
      git(checkout, 'add', 'private-name.bin');
      git(checkout, 'commit', '-q', '-m', 'blob');
      writeFileSync(join(checkout, 'private-name.bin'), 'size-2');
      mkdirSync(join(reference, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(reference, '.git', 'info', 'attributes'),
        '*.bin filter=lfs\n',
      );
      failLfsFilters();
    },
  ],
  [
    'intent-to-add',
    'GIT_CAPTURE_INTENT_TO_ADD',
    (): void => {
      writeFileSync(join(checkout, 'private-name.txt'), 'later\n');
      git(checkout, 'add', '-N', 'private-name.txt');
    },
  ],
  [
    'an untracked nested repository',
    'GIT_CAPTURE_NESTED_REPOSITORY',
    (): void => {
      mkdirSync(join(checkout, 'private-name'));
      git(join(checkout, 'private-name'), 'init', '-q');
    },
  ],
])(
  'keeps the refusal code for %s across the archive worker transport',
  async (_name, code, arrange) => {
    arrange();
    const failure = await runArchiveIoRequest({
      version: 1,
      type: 'capture-git',
      requestId: `request-${code}`,
      operationId: `archive:platform:${code}:capture-git`,
      projectId: 'platform',
      containerId: 'test',
      expectedCreatedAt: new Date(0).toISOString(),
      input: {
        git: { executable: 'git', env: gitEnvironment() },
        stagedDescriptorPath: join(root, 'descriptor.json'),
        repositories: [captureInput('repo', checkout)],
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code });
    expect(isWorktreeSnapshotRefusalError(failure)).toBe(true);
    const diagnostic = worktreeSnapshotRefusalDiagnostic(failure);
    expect(diagnostic?.code).toBe(code);
    expect(diagnostic?.message).not.toContain('private-name');
    expect(diagnostic?.message).not.toContain(root);
  },
);

it('keeps a failed rollback fatal when the capture failure was a refusal', async () => {
  writeFileSync(join(checkout, 'later.txt'), 'later\n');
  git(checkout, 'add', '-N', 'later.txt');
  const clean = join(root, 'clean');
  git(reference, 'worktree', 'add', '-q', '-b', 'clean', clean, 'main');
  // Git now refuses to delete any archive snapshot ref, so the clean
  // repository's pinned snapshot cannot be rolled back.
  const hooks = join(reference, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, 'reference-transaction'),
    [
      '#!/bin/sh',
      'test "$1" = prepared || exit 0',
      'while read -r old new ref; do',
      '  case "$new" in *[!0]*) continue ;; esac',
      '  case "$ref" in refs/app/*) exit 1 ;; esac',
      'done',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const failure = await capture([
    captureInput('clean', clean),
    captureInput('refused', checkout),
  ]).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(isWorktreeSnapshotRefusalError(failure)).toBe(false);
  expect(worktreeSnapshotRefusalDiagnostic(failure)).toBeUndefined();
  expect(hasRef('refs/app/archived-containers/platform/test/clean')).toBe(true);
});

it.each([
  [
    'Cannot archive an untracked nested Git repository: private-name/a b/',
    'Cannot archive an untracked nested Git repository: <path>',
  ],
  [
    'Cannot archive a worktree with a transforming Git attribute "text": C:\\private-name\\crlf.txt',
    'Cannot archive a worktree with a transforming Git attribute "text": <path>',
  ],
  [
    'Cannot restore a worktree with a transforming Git attribute "text": private-name/crlf.txt',
    'Cannot restore a worktree with a transforming Git attribute "text": <path>',
  ],
  [
    'Cannot archive files marked intent-to-add. Stage or unstage them first.',
    'Cannot archive files marked intent-to-add. Stage or unstage them first.',
  ],
  ['Git failed in /Users/private-name/repo.', 'Git failed in <path>'],
  ["Git failed in '~/private-name/repo'.", "Git failed in '<path>'."],
  [
    'Git failed in C:\\Users\\private-name\\repo and D:/private-name/repo',
    'Git failed in <path> and <path>',
  ],
  ['Git failed in \\\\server\\private-name\\repo', 'Git failed in <path>'],
])('redacts paths from %j', (message, redacted) => {
  expect(redactWorktreeSnapshotRefusalMessage(message)).toBe(redacted);
});

it('restores an index whose next status still shows a clean-filtered edit', async () => {
  // The working bytes equal the staged blob, but the checkout's own clean
  // filter turns them into other content: Git reports an unstaged edit.
  git(reference, 'config', 'filter.rot13.clean', 'tr A-Za-z N-ZA-Mn-za-m');
  git(reference, 'config', 'filter.rot13.smudge', 'tr A-Za-z N-ZA-Mn-za-m');
  writeFileSync(
    join(checkout, '.gitattributes'),
    `${readFileSync(join(checkout, '.gitattributes'), 'utf8')}secret.rot filter=rot13\n`,
  );
  writeFileSync(join(checkout, 'secret.rot'), 'hello\n');
  git(checkout, 'add', '.gitattributes', 'secret.rot');
  git(checkout, 'commit', '-q', '-m', 'rot13');
  writeFileSync(join(checkout, 'secret.rot'), 'uryyb\n');
  const edited = /^1 \.M N\.\.\. .* secret\.rot$/;
  expect(git(checkout, 'status', '--porcelain=v2')).toMatch(edited);

  const { repositories } = await capture([captureInput('repo', checkout)]);
  const [repository] = repositories;
  if (!repository) throw new Error('Missing captured repository');
  expect(repository.attributePolicy).toBe('ignore-in-tree-attributes');
  // Capture under the attribute source sees no edit.
  expect(repository.worktreeSnapshotCommit).toBe(repository.headCommit);

  const attributeSource = await resolveRestoreAttributeSource(
    reference,
    repository,
  );
  const destination = join(root, 'restored');
  await runWithGitAttributeSources(
    new Map([[reference, attributeSource]]),
    () =>
      createWorktreeFromStartPoint(
        reference,
        destination,
        'restored',
        repository.headCommit,
      ),
  );
  await restoreIndexAndWorkingTreeSnapshot({
    repoPath: destination,
    headCommit: repository.headCommit,
    indexSnapshotCommit: repository.indexSnapshotCommit,
    worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
    attributes: { attributeSource },
  });
  expect(readFileSync(join(destination, 'secret.rot'), 'utf8')).toBe('uryyb\n');
  // Racy entries are always rehashed; an index newer than every file is
  // trusted on its stat data alone.
  const indexPath = resolve(
    destination,
    git(destination, 'rev-parse', '--git-path', 'index'),
  );
  const later = new Date(Date.now() + 2_000);
  utimesSync(indexPath, later, later);
  expect(git(destination, 'status', '--porcelain=v2')).toMatch(edited);
});

it.each([
  ['sub', 'sub'],
  ['parent/sub', 'parent'],
])(
  'refuses a submodule at %s reached through a link, without running Git in its target',
  async (submodulePath, linkedPath) => {
    const forwardSlashes = (path: string): string => path.replace(/\\/g, '/');
    const fsmonitorRan = join(root, 'fsmonitor-ran');
    const fsmonitor = `touch '${forwardSlashes(fsmonitorRan)}'; false`;
    const origin = join(root, 'sub-origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'tracked.txt'), 'sub\n');
    git(origin, 'add', 'tracked.txt');
    git(origin, 'commit', '-q', '-m', 'sub');
    git(
      checkout,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      origin,
      submodulePath,
    );
    git(checkout, 'commit', '-q', '-m', 'submodule');
    // The submodule's own config cannot run a command during the check.
    git(join(checkout, submodulePath), 'config', 'core.fsmonitor', fsmonitor);
    await expect(
      assertWorktreeSnapshotSupported(checkout, 'negotiate'),
    ).resolves.toMatchObject({ attributePolicy: 'ignore-in-tree-attributes' });
    expect(existsSync(fsmonitorRan)).toBe(false);

    // A repository elsewhere takes the submodule's place through a link (a
    // junction on Windows, which needs no symlink privilege).
    const elsewhere = join(root, 'elsewhere');
    const target = join(elsewhere, submodulePath.slice(linkedPath.length));
    mkdirSync(target, { recursive: true });
    git(target, 'init', '-q', '-b', 'main');
    git(target, 'config', 'core.fsmonitor', fsmonitor);
    rmSync(join(checkout, linkedPath), { recursive: true, force: true });
    symlinkSync(elsewhere, join(checkout, linkedPath), 'junction');
    await expect(
      assertWorktreeSnapshotSupported(checkout, 'negotiate'),
    ).rejects.toMatchObject({ code: 'GIT_CAPTURE_DIRTY_SUBMODULE' });
    expect(existsSync(fsmonitorRan)).toBe(false);
  },
);

// Only Linux filesystems take a name that is not UTF-8.
const linuxTest = process.platform === 'linux' ? it : it.skip;
linuxTest.each([true, false])(
  'refuses a dirty submodule whose path is not UTF-8 across the archive worker transport (in-tree attributes: %s)',
  async (inTreeAttributes) => {
    if (!inTreeAttributes) {
      git(checkout, 'rm', '-q', '.gitattributes');
      git(checkout, 'commit', '-q', '-m', 'no attributes');
    }
    const submodule = join(checkout, 'sub');
    mkdirSync(submodule);
    git(submodule, 'init', '-q', '-b', 'main');
    writeFileSync(join(submodule, 'tracked.txt'), 'sub\n');
    git(submodule, 'add', 'tracked.txt');
    git(submodule, 'commit', '-q', '-m', 'sub');
    const commit = git(submodule, 'rev-parse', 'HEAD');
    writeFileSync(join(submodule, 'tracked.txt'), 'edited\n');
    const rawName = Buffer.from([0x73, 0xff]);
    renameSync(
      submodule,
      Buffer.concat([Buffer.from(`${checkout}/`), rawName]),
    );
    execFileSync(
      'git',
      ['-C', checkout, 'update-index', '--add', '-z', '--index-info'],
      {
        input: Buffer.concat([
          Buffer.from(`160000 ${commit}\t`),
          rawName,
          Buffer.from([0]),
        ]),
      },
    );

    const failure = await runArchiveIoRequest({
      version: 1,
      type: 'capture-git',
      requestId: `request-raw-submodule-${String(inTreeAttributes)}`,
      operationId: `archive:platform:raw-submodule:${String(inTreeAttributes)}:capture-git`,
      projectId: 'platform',
      containerId: 'test',
      expectedCreatedAt: new Date(0).toISOString(),
      input: {
        git: { executable: 'git', env: gitEnvironment() },
        stagedDescriptorPath: join(root, 'descriptor.json'),
        repositories: [captureInput('repo', checkout)],
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'GIT_CAPTURE_DIRTY_SUBMODULE' });
    expect(isWorktreeSnapshotRefusalError(failure)).toBe(true);
  },
);

linuxTest(
  'looks up nested repositories by the bytes of a path that is not UTF-8',
  async () => {
    const rawName = Buffer.from([0x64, 0xff]);
    const rawDirectory = Buffer.concat([Buffer.from(`${checkout}/`), rawName]);
    const moveGitDirectoryIn = (): void => {
      const scratch = join(root, 'nested-scratch');
      mkdirSync(scratch);
      git(scratch, 'init', '-q');
      renameSync(
        join(scratch, '.git'),
        Buffer.concat([rawDirectory, Buffer.from('/.git')]),
      );
      rmSync(scratch, { recursive: true });
    };
    mkdirSync(rawDirectory);
    writeFileSync(Buffer.concat([rawDirectory, Buffer.from('/f.txt')]), 'f\n');

    // An untracked nested repository.
    moveGitDirectoryIn();
    await expect(
      assertWorktreeSnapshotSupported(checkout, 'negotiate'),
    ).rejects.toMatchObject({ code: 'GIT_CAPTURE_NESTED_REPOSITORY' });

    // A tracked directory archives as it did before, until a repository
    // takes it over.
    rmSync(Buffer.concat([rawDirectory, Buffer.from('/.git')]), {
      recursive: true,
    });
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'raw directory');
    await expect(
      assertWorktreeSnapshotSupported(checkout, 'negotiate'),
    ).resolves.toMatchObject({ attributePolicy: 'ignore-in-tree-attributes' });
    moveGitDirectoryIn();
    await expect(
      assertWorktreeSnapshotSupported(checkout, 'negotiate'),
    ).rejects.toMatchObject({ code: 'GIT_CAPTURE_NESTED_REPOSITORY' });
  },
);
