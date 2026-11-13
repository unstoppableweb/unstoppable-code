import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodexSelectedCapabilityRoot } from '@canopy/execution-engine/execution-types';

/**
 * Convert a locally-resolved immutable plugin directory into the app-server's
 * thread-scoped capability-root contract. The id contains no source contents
 * or credentials and is stable for the same normalized local root.
 */
export function createLocalCapabilityRoot(
  rootPath: string,
): CodexSelectedCapabilityRoot {
  const absolutePath = path.resolve(rootPath);
  const id = createHash('sha256')
    .update(`local-capability-root\0${absolutePath}`)
    .digest('hex');
  return {
    id,
    location: {
      type: 'environment',
      environmentId: 'local',
      path: pathToFileURL(absolutePath).href,
    },
  };
}
