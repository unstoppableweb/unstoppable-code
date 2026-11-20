// Golden: the host, not native discovery, decides which repository
// instruction files reach the model: AGENTS.md then GEMINI.md, root only,
// symlinks refused and each file capped at 64 KiB.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  antigravityWorkspaceRootsBlock,
  readAntigravityRepositoryInstructions,
} from '../repository-instructions';

const signal = new AbortController().signal;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'antigravity-instructions-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function root(name: string, files: Record<string, string> = {}): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('Antigravity repository instructions', () => {
  it('delivers AGENTS.md then GEMINI.md from the root only', async () => {
    const dir = root('repo', {
      'AGENTS.md': 'A',
      'GEMINI.md': 'G',
      'sub/AGENTS.md': 'nested-only',
    });
    const { block, notices } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    expect(block).toBe(
      'Repository instructions (AGENTS.md):\nA\n\nRepository instructions (GEMINI.md):\nG',
    );
    expect(block).not.toContain('nested-only');
    expect(notices).toEqual([]);
  });

  it('skips GEMINI.md identical to AGENTS.md', async () => {
    const dir = root('repo', { 'AGENTS.md': 'same', 'GEMINI.md': 'same' });
    const { block } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    expect(block).toBe('Repository instructions (AGENTS.md):\nsame');
    expect(block?.match(/Repository instructions/g)).toHaveLength(1);
  });

  it('returns undefined with no notices when neither file exists', async () => {
    const dir = root('repo');
    await expect(
      readAntigravityRepositoryInstructions([dir], signal),
    ).resolves.toEqual({ block: undefined, notices: [] });
  });

  it('labels additional roots by directory name', async () => {
    const a = root('a');
    const b = root('b', { 'AGENTS.md': 'B' });
    const { block } = await readAntigravityRepositoryInstructions(
      [a, b],
      signal,
    );
    expect(block).toBe('Repository instructions (b/AGENTS.md):\nB');
  });

  it('skips a symlinked instruction file with a notice', async () => {
    const outside = root('outside', { 'secret.md': 'secret' });
    const dir = root('repo');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'AGENTS.md'));
    const { block, notices } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    expect(block).toBeUndefined();
    expect(notices[0]).toMatch(/AGENTS\.md.*symlink/);
  });

  it('skips a symlinked GEMINI.md and still delivers AGENTS.md', async () => {
    const outside = root('outside', { 'secret.md': 'secret' });
    const dir = root('repo', { 'AGENTS.md': 'A' });
    symlinkSync(join(outside, 'secret.md'), join(dir, 'GEMINI.md'));
    const { block, notices } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    expect(block).toBe('Repository instructions (AGENTS.md):\nA');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/GEMINI\.md.*symlink/);
  });

  it('delivers a file of exactly 64 KiB whole', async () => {
    const content = 'x'.repeat(65_536);
    const dir = root('repo', { 'AGENTS.md': content });
    const { block, notices } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    expect(block).toBe(`Repository instructions (AGENTS.md):\n${content}`);
    expect(block).not.toContain('[truncated at 64 KiB]');
    expect(notices).toEqual([]);
  });

  it('truncates at 64 KiB with a visible line', async () => {
    const dir = root('repo', { 'AGENTS.md': 'x'.repeat(70_000) });
    const { block, notices } = await readAntigravityRepositoryInstructions(
      [dir],
      signal,
    );
    const header = 'Repository instructions (AGENTS.md):\n';
    const footer = '\n[truncated at 64 KiB]';
    expect(block?.startsWith(header)).toBe(true);
    expect(block?.endsWith(footer)).toBe(true);
    expect(block?.slice(header.length, -footer.length)).toHaveLength(65_536);
    expect(notices[0]).toContain('64 KiB');
  });

  it('honors an aborted signal', async () => {
    const dir = root('repo', { 'AGENTS.md': 'A' });
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(
      readAntigravityRepositoryInstructions([dir], controller.signal),
    ).rejects.toBe(reason);
  });
});

// The Canopy agent drops Google's default prompt sections, so the model learns
// its workspace paths only from this block.
describe('Antigravity workspace roots block', () => {
  const heading =
    'Workspace roots (absolute paths; stay inside them, and use them for every file path):';

  it('uses the exact heading', () => {
    expect(antigravityWorkspaceRootsBlock(['/w']).split('\n')[0]).toBe(heading);
  });

  it('names one root', () => {
    expect(antigravityWorkspaceRootsBlock(['/work/repo'])).toBe(
      `${heading}\n- /work/repo`,
    );
  });

  it('keeps two roots in the given order', () => {
    expect(antigravityWorkspaceRootsBlock(['/work/b', '/work/a'])).toBe(
      `${heading}\n- /work/b\n- /work/a`,
    );
  });
});
