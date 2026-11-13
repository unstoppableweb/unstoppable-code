import type { W5DurabilityPort } from '@canopy/core-runtime/node/w5/commit-log';
import {
  syncDirectory,
  writeFileAtomically,
} from '@canopy/execution-engine/node/lib/atomic-file';

/**
 * The desktop's W5 durability: atomic-file's temp file, fsync,
 * rename-with-retry and folder sync (skipped on Windows), without storage
 * admission, which callers apply before they commit.
 */
export const desktopW5Durability: W5DurabilityPort = {
  syncDirectory,
  writeFileDurably: (path: string, contents: string): Promise<void> =>
    writeFileAtomically(path, contents, { encoding: 'utf8', durable: true }),
};
