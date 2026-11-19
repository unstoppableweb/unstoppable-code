#!/usr/bin/env node

/**
 * Builds the Windows named-pipe security addon
 * (packages/core-platform/native/windows-pipe) with the root node-gyp,
 * against the headers of the Node running this script. Other hosts build
 * nothing: the addon is Windows-only and the daemon loads it only on win32.
 *
 * Usage: node scripts/build-windows-pipe-security.mjs [--out <file>]
 * `--out` copies the built addon there (the daemon build stages it beside
 * the executable as windows-pipe-security.node).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonDirectory = join(
  root,
  'packages',
  'core-platform',
  'native',
  'windows-pipe',
);
export const WINDOWS_PIPE_SECURITY_BUILD_OUTPUT = join(
  addonDirectory,
  'build',
  'Release',
  'windows_pipe_security.node',
);

/**
 * Rebuilds the addon and returns its path, or `null` off Windows.
 * Throws when node-gyp fails or produces no addon.
 */
export function buildWindowsPipeSecurity({ out } = {}) {
  if (process.platform !== 'win32') return null;
  const nodeGyp = createRequire(import.meta.url).resolve(
    'node-gyp/bin/node-gyp.js',
  );
  execFileSync(
    process.execPath,
    [
      nodeGyp,
      'rebuild',
      `--directory=${addonDirectory}`,
      `--target=${process.versions.node}`,
      `--arch=${process.arch}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (!existsSync(WINDOWS_PIPE_SECURITY_BUILD_OUTPUT))
    throw new Error(
      `node-gyp produced no addon at ${WINDOWS_PIPE_SECURITY_BUILD_OUTPUT}`,
    );
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(WINDOWS_PIPE_SECURITY_BUILD_OUTPUT, out);
    return out;
  }
  return WINDOWS_PIPE_SECURITY_BUILD_OUTPUT;
}

function parseOut(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error('--out requires a file path.');
  return resolve(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const out = parseOut(process.argv.slice(2));
    if (process.platform !== 'win32') {
      console.log(
        `Windows pipe security addon is Windows-only; nothing built on ${process.platform}.`,
      );
    } else {
      console.log('Building Windows pipe security addon with node-gyp…');
      const built = buildWindowsPipeSecurity({ out });
      console.log(`Done! Addon: ${built}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
