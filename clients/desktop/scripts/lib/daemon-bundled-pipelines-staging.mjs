/**
 * Stages the bundled pipeline definitions beside a standalone daemon
 * (CAN-5092): the brand-rendered `resources/pipelines` tree the desktop ships
 * as an extra resource, copied to `<targetDir>/resources/pipelines`, where
 * the daemon's `daemonBundledPipelinesDir()` resolves it. Refuses a staged
 * tree whose index names a file that is missing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAEMON_BUNDLED_PIPELINES_DIRECTORY } from '../../packages/core-platform/src/execution-host/daemon-payload.ts';

/** Copies `sourceDir` beside the daemon in `targetDir`; returns the copy. */
export function stageDaemonBundledPipelines({ sourceDir, targetDir }) {
  const destination = join(targetDir, ...DAEMON_BUNDLED_PIPELINES_DIRECTORY);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(sourceDir, destination, { recursive: true });
  const indexPath = join(destination, 'index.json');
  if (!existsSync(indexPath))
    throw new Error('The staged bundled pipelines are missing index.json.');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entries = Array.isArray(index?.pipelines) ? index.pipelines : [];
  for (const entry of entries) {
    if (
      typeof entry?.filename !== 'string' ||
      !existsSync(join(destination, entry.filename))
    )
      throw new Error(
        `The staged bundled pipelines are missing ${String(entry?.filename)}.`,
      );
  }
  return destination;
}
