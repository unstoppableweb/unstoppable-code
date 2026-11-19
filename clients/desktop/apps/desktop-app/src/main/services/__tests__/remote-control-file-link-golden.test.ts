/**
 * CAN-5038 golden: `resolveRemoteControlFileLink` (transcript link resolution) on
 * real temporary filesystems. Captured on the resolver in `files-service.ts`
 * before it called the `worker.filesystem.link.resolve` engine. A link
 * resolves only to one existing regular file in exactly one root; anything
 * else, including a file that overlapping roots both contain, answers `null`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

jest.mock('electron', () => ({
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  readRemoteControlFilePreview,
  resolveRemoteControlFileLink,
} from '../files-service';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const posix = process.platform === 'win32' ? describe.skip : describe;

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'] = 'git-repo',
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind,
    gitAware: rootKind === 'git-repo',
    excludedDescendantRoots: [],
  };
}

function setRoots(roots: FileBrowserRoot[]): void {
  mockedGetFileBrowserRoots.mockResolvedValue({
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  });
}

function resolveLink(
  href: string,
): ReturnType<typeof resolveRemoteControlFileLink> {
  return resolveRemoteControlFileLink({
    projectId: 'project-1',
    worktreeId: 'wt-1',
    href,
  });
}

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'portal-file-link-golden-'));
  tempRoot = await realpath(tempRoot);
  mockedGetFileBrowserRoots.mockReset();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

it('opens the intended file from a transcript resolution through the Portal read', async () => {
  const repo = join(tempRoot, 'repo');
  await put(join(repo, 'foo', 'bar.ts'), 'directory-path contents');
  if (sep !== '\\') {
    await put(join(repo, 'foo\\bar.ts'), 'literal-backslash contents');
  }
  setRoots([root('repo', repo)]);

  // Preserve the completion's exact identity across the JSON transport.
  const resolution = await resolveLink('foo%5Cbar.ts');
  expect(resolution).toEqual({
    fileRootLocalId: 'repo',
    relativePath: sep === '\\' ? 'foo/bar.ts' : 'foo\\bar.ts',
  });
  if (!resolution) throw new Error('Transcript fixture did not resolve.');
  const transported: unknown = JSON.parse(JSON.stringify(resolution));
  if (
    typeof transported !== 'object' ||
    transported === null ||
    !('fileRootLocalId' in transported) ||
    typeof transported.fileRootLocalId !== 'string' ||
    !('relativePath' in transported) ||
    typeof transported.relativePath !== 'string'
  ) {
    throw new Error('Transcript completion did not survive JSON transport.');
  }
  const readRequest = {
    projectId: 'project-1',
    worktreeId: 'wt-1',
    fileRootLocalId: transported.fileRootLocalId,
    relativePath: transported.relativePath,
  };
  await expect(
    readRemoteControlFilePreview(readRequest),
  ).resolves.toMatchObject({
    path: resolution.relativePath,
    content:
      sep === '\\' ? 'directory-path contents' : 'literal-backslash contents',
  });
  for (const relativePath of ['../foo/bar.ts', '..\\foo\\bar.ts']) {
    await expect(
      readRemoteControlFilePreview({
        ...readRequest,
        relativePath,
      }),
    ).rejects.toThrow('Path cannot traverse outside the worktree.');
  }
});

posix('single-repository worktree', () => {
  let repo = '';
  let attachments = '';
  let outside = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    attachments = join(tempRoot, 'attachments');
    outside = join(tempRoot, 'outside');
    await put(join(repo, 'src', 'only.ts'));
    await put(join(repo, 'src', 'space file.ts'));
    await put(join(repo, 'shared.md'));
    await put(join(repo, '.git', 'config'));
    await put(join(attachments, 'shared.md'));
    await put(join(attachments, 'image.png'));
    await put(join(outside, 'secret.ts'));
    setRoots([
      root('repo', repo),
      root('attachments', attachments, 'attachments'),
    ]);
  });

  it.each([
    'src/only.ts',
    './src/only.ts',
    'src/only.ts#L12',
    './src/only.ts?raw=1',
    '  src/only.ts  ',
    'src\\only.ts',
    'src//only.ts',
  ])('resolves the relative link %j uniquely', async (href) => {
    await expect(resolveLink(href)).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: 'src/only.ts',
    });
  });

  it('percent-decodes relative links', async () => {
    await expect(resolveLink('src/space%20file.ts')).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: 'src/space file.ts',
    });
    await expect(resolveLink('src/%E0%A4%A.ts')).resolves.toBeNull();

    // Raw separators retain transcript syntax; encoded backslashes name
    // literal POSIX characters even when the directory spelling also exists.
    await put(join(repo, 'src\\only.ts'), 'literal');
    await put(join(repo, 'src', 'literal\\name.ts'), 'nested literal');
    await put(join(repo, 'src', 'literal', 'name.ts'), 'directory decoy');
    for (const [href, relativePath] of [
      ['src\\only.ts', 'src/only.ts'],
      ['src%5Conly.ts', 'src\\only.ts'],
      ['src\\literal%5Cname.ts', 'src/literal\\name.ts'],
      [join(repo, 'src\\only.ts'), 'src\\only.ts'],
      [pathToFileURL(join(repo, 'src\\only.ts')).href, 'src\\only.ts'],
    ]) {
      await expect(resolveLink(href)).resolves.toEqual({
        fileRootLocalId: 'repo',
        relativePath,
      });
    }
  });

  it('resolves absolute paths and local file URLs inside one root', async () => {
    const only = join(repo, 'src', 'only.ts');
    const expected = { fileRootLocalId: 'repo', relativePath: 'src/only.ts' };
    for (const href of [
      only,
      `${only}#L2`,
      `${only}?raw=1`,
      pathToFileURL(only).href,
      `${pathToFileURL(only).href}#L2`,
      `file://localhost${only}`,
      `FILE://${only}`,
    ])
      await expect(resolveLink(href)).resolves.toEqual(expected);
    await expect(
      resolveLink(pathToFileURL(join(repo, 'src', 'space file.ts')).href),
    ).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: 'src/space file.ts',
    });
    await expect(resolveLink(join(attachments, 'image.png'))).resolves.toEqual({
      fileRootLocalId: 'attachments',
      relativePath: 'image.png',
    });
  });

  it.each([
    ['an empty link', ''],
    ['a blank link', '   '],
    ['an ambiguous relative file', 'shared.md'],
    ['a missing file', 'src/missing.ts'],
    ['a directory', 'src'],
    ['the root itself', '.'],
    ['parent traversal', '../outside/secret.ts'],
    ['inner traversal', 'src/../src/only.ts'],
    ['a remote URL', 'https://example.com/src/only.ts'],
    ['a mailto link', 'mailto:someone@example.com'],
    ['a UNC path', '//server/share/only.ts'],
    ['a backslash UNC path', '\\\\server\\share\\only.ts'],
    ['a drive-letter path', 'C:\\repo\\src\\only.ts'],
    ['a control character', 'src/only.ts\n'.replace('\n', '\u0001')],
    ['a NUL byte', 'src/only.ts%00'],
  ])('leaves %s unresolved', async (_label, href) => {
    await expect(resolveLink(href)).resolves.toBeNull();
  });

  it('leaves links longer than 4096 characters unresolved', async () => {
    await expect(resolveLink(`./${'a/'.repeat(2047)}x`)).resolves.toBeNull();
  });

  it('leaves remote-host file URLs and the root directory unresolved', async () => {
    await expect(
      resolveLink(`file://other-host${join(repo, 'src', 'only.ts')}`),
    ).resolves.toBeNull();
    await expect(resolveLink(repo)).resolves.toBeNull();
    await expect(resolveLink(pathToFileURL(repo).href)).resolves.toBeNull();
  });

  it('leaves absolute paths and file URLs outside every root unresolved', async () => {
    const secret = join(outside, 'secret.ts');
    await expect(resolveLink(secret)).resolves.toBeNull();
    await expect(resolveLink(pathToFileURL(secret).href)).resolves.toBeNull();
  });

  it('does not refuse .git paths', async () => {
    await expect(resolveLink('.git/config')).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: '.git/config',
    });
  });

  it('answers the real path inside one root and refuses symlink escapes', async () => {
    await symlink(join(repo, 'src', 'only.ts'), join(repo, 'alias.ts'));
    await expect(resolveLink('alias.ts')).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: 'src/only.ts',
    });
    await symlink(join(outside, 'secret.ts'), join(repo, 'escape.ts'));
    await expect(resolveLink('escape.ts')).resolves.toBeNull();
    await expect(resolveLink(join(repo, 'escape.ts'))).resolves.toBeNull();
    await symlink(outside, join(repo, 'escape-dir'));
    await expect(resolveLink('escape-dir/secret.ts')).resolves.toBeNull();
  });

  it('requires a relative link to stay in the root it was joined to', async () => {
    await symlink(join(attachments, 'image.png'), join(repo, 'to-image.png'));
    // Relative: joined to each root, contained by that root only.
    await expect(resolveLink('to-image.png')).resolves.toBeNull();
    // Absolute: matched against every root by its resolved path.
    await expect(resolveLink(join(repo, 'to-image.png'))).resolves.toEqual({
      fileRootLocalId: 'attachments',
      relativePath: 'image.png',
    });
  });

  it('leaves a target that is not a regular file unresolved', async () => {
    execFileSync('mkfifo', [join(repo, 'src', 'pipe')]);
    await expect(resolveLink('src/pipe')).resolves.toBeNull();
  });

  it('skips a root that does not exist', async () => {
    setRoots([
      root('missing', join(tempRoot, 'missing-root')),
      root('repo', repo),
    ]);
    await expect(resolveLink('src/only.ts')).resolves.toEqual({
      fileRootLocalId: 'repo',
      relativePath: 'src/only.ts',
    });
  });
});

posix('a root advertised through a symlink', () => {
  let real = '';
  let link = '';

  beforeEach(async () => {
    real = join(tempRoot, 'real-repo');
    link = join(tempRoot, 'linked-repo');
    await put(join(real, 'src', 'only.ts'));
    await symlink(real, link);
    setRoots([root('repo', link)]);
  });

  it('resolves relative, linked and real spellings to one identity', async () => {
    const expected = { fileRootLocalId: 'repo', relativePath: 'src/only.ts' };
    await expect(resolveLink('src/only.ts')).resolves.toEqual(expected);
    await expect(resolveLink(join(link, 'src', 'only.ts'))).resolves.toEqual(
      expected,
    );
    await expect(resolveLink(join(real, 'src', 'only.ts'))).resolves.toEqual(
      expected,
    );
  });
});

posix('multi-repository worktree with overlapping roots', () => {
  let home = '';
  let api = '';

  beforeEach(async () => {
    home = join(tempRoot, 'home');
    api = join(home, 'repos', 'api');
    await put(join(home, 'NOTES.md'));
    await put(join(api, 'docs', 'routes.md'));
    await put(join(api, 'NOTES.md'));
    setRoots([
      root('__workspace_root__', home, 'workspace-root'),
      root('api', api),
    ]);
  });

  it('resolves a relative link that exists under one root only', async () => {
    await expect(resolveLink('docs/routes.md')).resolves.toEqual({
      fileRootLocalId: 'api',
      relativePath: 'docs/routes.md',
    });
    await expect(resolveLink('repos/api/docs/routes.md')).resolves.toEqual({
      fileRootLocalId: '__workspace_root__',
      relativePath: 'repos/api/docs/routes.md',
    });
  });

  it('leaves a file that two roots contain unresolved', async () => {
    await expect(resolveLink('NOTES.md')).resolves.toBeNull();
    await expect(
      resolveLink(join(api, 'docs', 'routes.md')),
    ).resolves.toBeNull();
    await expect(
      resolveLink(pathToFileURL(join(api, 'docs', 'routes.md')).href),
    ).resolves.toBeNull();
    await expect(resolveLink(join(home, 'NOTES.md'))).resolves.toEqual({
      fileRootLocalId: '__workspace_root__',
      relativePath: 'NOTES.md',
    });
  });
});
