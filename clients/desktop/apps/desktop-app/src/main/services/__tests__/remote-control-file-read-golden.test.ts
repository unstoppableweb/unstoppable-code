/**
 * CAN-4099 golden: `readRemoteControlFilePreview` on real temporary filesystems.
 * The Portal read stays a direct, recorded path in CAN-4099; this pins the
 * behavior a later move onto `worker.filesystem.file.read` must keep (or
 * name as a difference): the 256 KiB byte cut, its UTF-8 decoding, the
 * `version` token and single-root containment.
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

jest.mock('electron', () => ({
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import { readRemoteControlFilePreview } from '../files-service';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const PREVIEW_BYTES = 256 * 1024;

function root(repoId: string, absolutePath: string): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
}

let tempRoot = '';
let repo = '';
let other = '';

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'portal-file-read-golden-'));
  repo = join(tempRoot, 'repo');
  other = join(tempRoot, 'other');
  await mkdir(repo, { recursive: true });
  await mkdir(other, { recursive: true });
  const roots = [root('repo', repo), root('other', other)];
  mockedGetFileBrowserRoots.mockResolvedValue({
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function read(
  relativePath: string,
): ReturnType<typeof readRemoteControlFilePreview> {
  return readRemoteControlFilePreview({
    projectId: 'project-1',
    worktreeId: 'wt-1',
    fileRootLocalId: 'repo',
    relativePath,
  });
}

it('reads text with the size:round(mtimeMs) version token', async () => {
  const file = join(repo, 'src', 'main.ts');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(file, 'main();\n');
  const stats = await stat(file);
  await expect(read('src/main.ts')).resolves.toEqual({
    workspaceLocalId: 'project-1',
    worktreeLocalId: 'wt-1',
    fileRootLocalId: 'repo',
    path: 'src/main.ts',
    content: 'main();\n',
    language: 'ts',
    size: 8,
    version: `8:${Math.round(stats.mtimeMs)}`,
    truncated: false,
    modifiedAt: stats.mtime.toISOString(),
  });
});

it('cuts at 256 KiB of bytes and decodes a split character as U+FFFD', async () => {
  // 'é' is two bytes; the cut falls inside the last one.
  const body = Buffer.concat([
    Buffer.alloc(PREVIEW_BYTES - 1, 'a'),
    Buffer.from('é tail', 'utf8'),
  ]);
  await writeFile(join(repo, 'long.txt'), body);
  const result = await read('long.txt');
  expect(result.truncated).toBe(true);
  expect(result.size).toBe(body.length);
  expect(result.content).toHaveLength(PREVIEW_BYTES);
  expect(result.content.endsWith('a�')).toBe(true);
});

it('refuses a symlink into another root of the same worktree', async () => {
  await writeFile(join(other, 'shared.txt'), 'shared');
  await symlink(join(other, 'shared.txt'), join(repo, 'shared-link.txt'));
  await expect(read('shared-link.txt')).rejects.toThrow(
    'File is outside the selected worktree root.',
  );
});

it('refuses a NUL-bearing file as binary', async () => {
  await writeFile(join(repo, 'data.txt'), Buffer.from([0x41, 0x00]));
  await expect(read('data.txt')).rejects.toThrow(
    'Binary files cannot be read.',
  );
});

it('reads a file inside .git', async () => {
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await expect(read('.git/HEAD')).resolves.toMatchObject({
    content: 'ref: refs/heads/main\n',
  });
});
