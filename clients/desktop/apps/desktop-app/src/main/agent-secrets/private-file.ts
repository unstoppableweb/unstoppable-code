import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { renameWithRetry } from '../lib/atomic-file';

/**
 * Writes `text` to `target` atomically, readable by its owner only. The
 * temporary file is created empty and made private (0600 on POSIX, an
 * owner-only DACL verified on Windows) before any byte of `text` reaches
 * it; a file that can't be made private is removed and nothing is written.
 * Resolves false when the file couldn't be made private. A `signal` that
 * aborts before the file is installed leaves nothing written and throws its
 * reason.
 */
export async function writePrivateFileAtomically(
  target: string,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temp, 'wx', 0o600);
  let installed = false;
  try {
    const files = hostPlatformServices(
      createPlatformEndpointServices(hostPlatformOperatingSystem()),
    ).secureFiles;
    const permission = await files.permissions({
      path: temp,
      kind: 'file',
      mode: 'owner-only',
      action: 'restrict',
    });
    if (permission.state !== 'private') return false;
    signal?.throwIfAborted();
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    signal?.throwIfAborted();
    // A stop during a retry's backoff installs nothing either.
    await renameWithRetry(temp, target, {
      beforeRetry: () => signal?.throwIfAborted(),
    });
    installed = true;
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!installed) await rm(temp, { force: true }).catch(() => undefined);
  }
}
