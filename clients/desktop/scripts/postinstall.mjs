#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { clearDemoGitIdentity } from './lib/clear-demo-git-identity.mjs';

function shouldSkipElectronRebuild() {
  return (
    process.env.CANOPY_SKIP_ELECTRON_REBUILD === 'true' ||
    process.env.CANOPY_SKIP_BINARY_STAGING_POSTINSTALL === 'true'
  );
}

function runElectronRebuild() {
  const result = spawnSync(
    process.execPath,
    [
      './node_modules/@electron/rebuild/lib/cli.js',
      '--only',
      'node-pty',
      '--force',
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `electron-rebuild failed for node-pty (exit ${result.status ?? 'unknown'})`,
    );
  }
}

if (clearDemoGitIdentity()) {
  process.stdout.write(
    "Removed the demo apps' git identity from this checkout's local config; commits use your own identity again.\n",
  );
}

if (shouldSkipElectronRebuild()) {
  process.stdout.write(
    'Skipping Electron rebuild for node-pty due to postinstall skip environment.\n',
  );
} else {
  runElectronRebuild();
  process.stdout.write(
    'Rebuilt native node-pty for Electron; skipping electron-builder install-app-deps because builtin SQLite uses node:sqlite.\n',
  );
}
