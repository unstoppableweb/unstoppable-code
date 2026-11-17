import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_CAPABILITY_BYTES = 100 * 1024 * 1024;

/** Hash the delivered private copies, not source mtimes or selection labels. */
export async function capabilityFiles(
  roots: readonly string[],
  signal: AbortSignal,
  provider: 'Copilot' | 'OpenCode' | 'Antigravity',
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  const walk = async (
    directory: string,
    prefix: string,
    depth = 0,
  ): Promise<void> => {
    if (depth > 64 || ++count > 10_000)
      throw new Error(`${provider} capabilities exceed the file limit.`);
    signal.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name === '.canopy-capabilities.json') continue;
      const file = join(directory, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`${provider} capabilities contain a symbolic link.`);
      if (entry.isDirectory()) {
        await walk(file, name, depth + 1);
        continue;
      }
      if (!entry.isFile() || ++count > 10_000)
        throw new Error(`${provider} capabilities exceed the file limit.`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file, {
        signal,
        highWaterMark: 64 * 1024,
      })) {
        const data: unknown = chunk;
        if (!Buffer.isBuffer(data))
          throw new Error(`${provider} capability file could not be read.`);
        bytes += data.byteLength;
        if (bytes > MAX_CAPABILITY_BYTES)
          throw new Error(`${provider} capabilities exceed the size limit.`);
        hash.update(data);
      }
      files[name] = hash.digest('hex');
    }
  };
  for (const [index, root] of Array.from(roots.entries())) {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`${provider} capability directory is invalid.`);
    await walk(root, String(index));
  }
  return files;
}

/** Normalize only trusted private-copy paths, preserving literal text as separate segments. */
export function capabilityInstructionIdentity(
  text: string,
  roots: readonly string[],
): Array<string | { retainedRoot: number }> {
  if (roots.some((root) => !root))
    throw new Error('Retained capability path is empty.');
  // Preserve the instruction text and its path references as separate segments.
  // A literal placeholder in Agent prose cannot collide with a path reference.
  const references = roots
    .flatMap((root, index) => [
      { path: root, index },
      { path: JSON.stringify(root).slice(1, -1), index },
    ])
    .sort((a, b) => b.path.length - a.path.length);
  const instructions: (string | { retainedRoot: number })[] = [];
  let remaining = text;
  while (remaining) {
    let next: { offset: number; path: string; index: number } | undefined;
    for (const reference of references) {
      const offset = remaining.indexOf(reference.path);
      if (offset >= 0 && (!next || offset < next.offset))
        next = { ...reference, offset };
    }
    if (!next) {
      instructions.push(remaining);
      break;
    }
    instructions.push(remaining.slice(0, next.offset), {
      retainedRoot: next.index,
    });
    remaining = remaining.slice(next.offset + next.path.length);
  }
  return instructions;
}
