import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

let canonicalCodexHome: string | null = null;

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return hostOperatingSystem() === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function observeCanonicalCodexHome(reportedCodexHome: string): string {
  const normalized = normalizeExistingPath(reportedCodexHome);
  if (canonicalCodexHome === null) {
    canonicalCodexHome = normalized;
    return normalized;
  }

  if (comparablePath(canonicalCodexHome) !== comparablePath(normalized)) {
    throw new Error(
      `Codex app-server reported a different canonical state directory (expected ${canonicalCodexHome}, received ${normalized})`,
    );
  }
  return canonicalCodexHome;
}

export function getObservedCanonicalCodexHome(): string | null {
  return canonicalCodexHome;
}

export function resetCanonicalCodexHomeForTests(): void {
  canonicalCodexHome = null;
}
