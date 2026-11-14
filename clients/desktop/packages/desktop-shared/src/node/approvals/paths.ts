import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * The canonical path `inputPath` names, resolved against `basePath` and
 * through the deepest existing ancestor. Undefined when an ancestor cannot
 * be read or a dangling symlink sits on the way, which a write could follow
 * out of the canonical boundary.
 */
export async function resolveExistingAncestorPath(
  inputPath: string,
  basePath: string,
): Promise<string | undefined> {
  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(basePath, inputPath);
  const missingSegments: string[] = [];
  let cursor = absolutePath;
  for (;;) {
    try {
      const existingPath = await realpath(cursor);
      return resolve(existingPath, ...missingSegments);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return undefined;
      }
      try {
        await lstat(cursor);
        return undefined;
      } catch (lstatError) {
        const lstatCode = errorCode(lstatError);
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          return undefined;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        return undefined;
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function toggleFirstAlphabeticCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/);
  if (index === -1) {
    return undefined;
  }
  const char = value[index];
  const toggled =
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`;
}

/**
 * Whether paths under a canonical root compare case-insensitively: always on
 * Windows, never on Linux, and on macOS as the volume holding the root
 * answers a probe with one letter's case toggled.
 */
export async function isPathCaseInsensitiveAt(
  canonicalRoot: string | undefined,
): Promise<boolean> {
  const platform = hostOperatingSystem();
  if (platform === 'win32') {
    return true;
  }
  if (platform !== 'darwin' || !canonicalRoot) {
    return false;
  }
  let cursor = canonicalRoot;
  while (true) {
    const parent = dirname(cursor);
    const name = basename(cursor);
    const probeName = toggleFirstAlphabeticCase(name);
    if (probeName && probeName !== name) {
      const resolvedProbe = await realpath(join(parent, probeName)).catch(
        () => undefined,
      );
      if (resolvedProbe !== undefined) {
        return resolvedProbe === cursor;
      }
    }
    if (parent === cursor) {
      return false;
    }
    cursor = parent;
  }
}
