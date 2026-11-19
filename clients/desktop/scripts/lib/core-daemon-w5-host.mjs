import { build } from 'esbuild';
import { join } from 'node:path';

/**
 * Bundles the daemon's W5 commit log worker entry as its own CJS file and
 * returns the esbuild result, whose metafile lists its inputs. Every core
 * daemon build stages it beside the executable (CAN-5529); the daemon starts
 * it only for `--w5-host v1`, which no launcher passes.
 */
export async function bundleDaemonW5Worker({ root, outfile }) {
  return await build({
    entryPoints: [
      join(root, 'apps', 'core-daemon', 'src', 'w5-commit-log-worker.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    outfile,
    external: ['node:*'],
    metafile: true,
    logLevel: 'warning',
  });
}
