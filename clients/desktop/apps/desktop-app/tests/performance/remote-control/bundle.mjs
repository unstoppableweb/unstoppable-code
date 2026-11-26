/**
 * Bundles the workload's computer worker against one checkout (CAN-7754).
 *
 * The worker's `canopy-transport/<module>` imports resolve to that
 * checkout's desktop transport, and everything they import resolves inside
 * the checkout too, so the same harness code measures a baseline and a
 * candidate. The bundle is built like the app's main bundle for production:
 * Node target, `NODE_ENV=production`, no source maps.
 *
 * When a later change moves a transport module, add its new path in front
 * of the old one: the first path that exists in a checkout wins, so older
 * baselines keep resolving.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

export const TRANSPORT_MODULES = Object.freeze({
  'device-key': [
    'apps/desktop-app/src/main/remote-control/crypto/device-key.ts',
  ],
  'rpc-peer': [
    'apps/desktop-app/src/main/remote-control/transport/rpc-peer.ts',
  ],
  'session-manager': [
    'apps/desktop-app/src/main/remote-control/transport/session-manager.ts',
  ],
  'remote-protocol': [
    'apps/desktop-app/src/main/remote-control/remote-protocol.ts',
  ],
  'relay-client': [
    'apps/desktop-app/src/main/remote-control/transport/relay-client.ts',
  ],
});

export function resolveTransportModule(root, name) {
  const candidates = TRANSPORT_MODULES[name];
  if (!candidates) throw new Error(`Unknown transport module ${name}`);
  for (const candidate of candidates) {
    const resolved = path.join(root, candidate);
    if (existsSync(resolved)) return resolved;
  }
  throw new Error(
    `No transport module ${name} in ${root} (tried ${candidates.join(', ')})`,
  );
}

function transportPlugin(root) {
  return {
    name: 'canopy-transport',
    setup(builder) {
      builder.onResolve({ filter: /^canopy-transport\// }, (args) => ({
        path: resolveTransportModule(
          root,
          args.path.slice('canopy-transport/'.length),
        ),
      }));
    },
  };
}

/** Builds the worker for `root` into a fresh directory; returns its path. */
export async function bundleComputer(root, { outDir } = {}) {
  return bundleTransportEntry(root, path.join(here, 'computer.mjs'), {
    outDir,
    prefix: 'canopy-remote-workload-',
    outName: 'computer.cjs',
  });
}

/**
 * Builds `entry`, whose `canopy-transport/<module>` imports resolve to
 * `root`'s desktop transport, into `outDir` (or a fresh directory under
 * `prefix`); returns the bundle's path. The scripted computers of
 * `--remote-control` (CAN-7852) are built this way too.
 */
export async function bundleTransportEntry(
  root,
  entry,
  { outDir, prefix = 'canopy-remote-transport-', outName = 'entry.cjs' } = {},
) {
  // The transport's own imports (zod, @canopy/protocol) resolve from the
  // checkout, so a fresh worktree must be installed first.
  if (!existsSync(path.join(root, 'node_modules'))) {
    throw new Error(
      `${root} has no node_modules; run \`pnpm install --frozen-lockfile\` there first.`,
    );
  }
  const directory = outDir ?? mkdtempSync(path.join(os.tmpdir(), prefix));
  const outfile = path.join(directory, outName);
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile,
    // The app's main bundle keeps Electron and native modules external; the
    // transport needs neither, so a stray import fails the build here.
    external: ['electron'],
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    minify: false,
    logLevel: 'error',
    plugins: [transportPlugin(root)],
  });
  return outfile;
}
