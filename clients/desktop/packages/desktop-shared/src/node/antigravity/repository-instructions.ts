import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Read from each root only, in this order; never from subdirectories. */
export const ANTIGRAVITY_INSTRUCTION_FILES = [
  'AGENTS.md',
  'GEMINI.md',
] as const;
export const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;

export interface AntigravityRepositoryInstructions {
  /** The prompt block, or undefined when no root had a readable file. */
  block: string | undefined;
  /** One line per skipped or truncated file, safe to show the user. */
  notices: string[];
}

type InstructionRead =
  | { kind: 'missing' }
  | { kind: 'skipped'; notice: string }
  | { kind: 'read'; content: string; truncated: boolean };

function errorCode(error: unknown): unknown {
  // Not `instanceof Error`: fs errors may come from another realm.
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

async function readInstructionFile(
  path: string,
  label: string,
  signal: AbortSignal,
): Promise<InstructionRead> {
  let size: number;
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      return {
        kind: 'skipped',
        notice: `${label} was skipped because it is a symlink.`,
      };
    if (!stats.isFile())
      return {
        kind: 'skipped',
        notice: `${label} was skipped because it is not a regular file.`,
      };
    size = stats.size;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'skipped', notice: `${label} could not be read.` };
  }
  signal.throwIfAborted();
  const buffer = Buffer.alloc(Math.min(size, MAX_INSTRUCTION_FILE_BYTES));
  let filled = 0;
  try {
    // O_NOFOLLOW where the platform has it: a file swapped for a symlink
    // after the lstat is refused rather than followed.
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      while (filled < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (errorCode(error) === 'ELOOP')
      return {
        kind: 'skipped',
        notice: `${label} was skipped because it is a symlink.`,
      };
    return { kind: 'skipped', notice: `${label} could not be read.` };
  }
  // Streaming decode holds back a multi-byte character cut by the cap.
  const content = new TextDecoder().decode(buffer.subarray(0, filled), {
    stream: true,
  });
  return {
    kind: 'read',
    content,
    truncated: size > MAX_INSTRUCTION_FILE_BYTES,
  };
}

/**
 * Names the session's workspace roots, in the given order, the first being its
 * working directory. The Canopy agent omits Google's default prompt sections,
 * so this block is how the model learns where its files are.
 */
export function antigravityWorkspaceRootsBlock(
  roots: readonly string[],
): string {
  return [
    'Workspace roots (absolute paths; stay inside them, and use them for every file path):',
    ...roots.map((root) => `- ${root}`),
  ].join('\n');
}

/**
 * Reads AGENTS.md then GEMINI.md from each root, the first root being the
 * session's working directory. Symlinks are refused and each file is capped,
 * so nothing outside a root and nothing unbounded reaches the prompt.
 */
export async function readAntigravityRepositoryInstructions(
  roots: readonly string[],
  signal: AbortSignal,
): Promise<AntigravityRepositoryInstructions> {
  const sections: string[] = [];
  const notices: string[] = [];
  for (const [index, root] of roots.entries()) {
    const prefix = index === 0 ? '' : `${basename(root)}/`;
    let agents: string | undefined;
    for (const file of ANTIGRAVITY_INSTRUCTION_FILES) {
      signal.throwIfAborted();
      const label = `${prefix}${file}`;
      const read = await readInstructionFile(join(root, file), label, signal);
      signal.throwIfAborted();
      if (read.kind === 'missing') continue;
      if (read.kind === 'skipped') {
        notices.push(read.notice);
        continue;
      }
      if (file === 'AGENTS.md') agents = read.content;
      else if (read.content === agents) continue;
      if (read.content.trim() === '') continue;
      if (read.truncated) notices.push(`${label} was truncated at 64 KiB.`);
      sections.push(
        `Repository instructions (${label}):\n${read.content}${read.truncated ? '\n[truncated at 64 KiB]' : ''}`,
      );
    }
  }
  return {
    block: sections.length > 0 ? sections.join('\n\n') : undefined,
    notices,
  };
}
