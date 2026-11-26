import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isErrnoException } from './type-guards';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureUniqueDestination(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let attempt = 1;
  let candidate = join(baseDir, preferredName);
  while (await pathExists(candidate)) {
    attempt += 1;
    candidate = join(baseDir, `${preferredName}-${attempt}`);
  }
  return candidate;
}

/**
 * Creates the first free `<name>`, `<name>-2`, … under `baseDir` with an
 * exclusive mkdir, so concurrent callers never share a directory.
 */
export async function reserveUniqueDestination(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let suffix = 1;
  while (true) {
    const name = suffix === 1 ? preferredName : `${preferredName}-${suffix}`;
    const candidate = join(baseDir, name);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      suffix += 1;
    }
  }
}
