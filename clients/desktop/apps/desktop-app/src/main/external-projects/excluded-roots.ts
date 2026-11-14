import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getBrandOwnedDataDirRoots,
  getCanopySecureDataDir,
} from '@canopy/execution-engine/canopy-paths';
import { getDataDir } from '../lib/paths';

/**
 * The directories whose contents are never a person's own projects: Canopy's
 * data roots and the OS temp roots. One definition serves the discovery scan
 * and the presence probe, so the invite never fires for evidence a scan would
 * then drop.
 */

export async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/**
 * Temporary directories never hold real projects, only tool and test
 * scratch. The UI-automation harness keeps every fixture under the OS temp
 * dir, so the E2E build alone may lift that rule through an explicit env
 * opt-in; production builds erase the branch at compile time.
 */
function temporaryRootsExcluded(): boolean {
  if (
    __CANOPY_E2E__ &&
    process.env.CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT === '1'
  ) {
    return false;
  }
  return true;
}

export async function collectExcludedRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const candidates = [
    getDataDir(),
    getCanopySecureDataDir(),
    ...getBrandOwnedDataDirRoots(),
  ];
  if (temporaryRootsExcluded()) {
    candidates.push(tmpdir(), '/tmp', '/private/tmp', '/private/var/folders');
  }
  for (const candidate of candidates) {
    roots.add(await safeRealpath(candidate));
    // Provider stores record paths as the app passed them, which may be the
    // unresolved spelling; the Claude adapter's slug rule needs both.
    roots.add(path.resolve(candidate));
  }
  return Array.from(roots);
}
