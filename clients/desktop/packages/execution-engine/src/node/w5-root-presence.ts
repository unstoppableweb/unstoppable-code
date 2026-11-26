import { resolve, join } from 'node:path';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import { realpath } from 'node:fs/promises';
import {
  acquireW5RootPresence,
  W5RootPresenceBusyError,
  type W5RootPresence,
} from '@canopy/core-platform/w5-root-presence';

import { W5HostCohortRefusedError } from './w5-host-cohort';
import { getBundledBinDir } from '../pipelines/config-paths';

const readOnlyRoots = new Set<string>();
const roots = new Map<string, Promise<W5RootPresence>>();

async function inspectSelf(): Promise<PlatformProcessInspection> {
  const platform = await import('@canopy/core-platform');
  const os = platform.hostPlatformOperatingSystem();
  const host =
    os === 'win32'
      ? {
          windowsProcessPath: join(
            getBundledBinDir(),
            platform.WINDOWS_PROCESS_FILE,
          ),
        }
      : {};
  return platform
    .hostPlatformServices(platform.createPlatformEndpointServices(os), host)
    .supervision.inspectProcess({ pid: process.pid });
}

/** No lazy retry: a CLI that degraded to reads stays read-only for its lifetime. */
export async function restrictW5RootPresenceToReads(
  dataRoot: string,
): Promise<void> {
  readOnlyRoots.add(resolve(dataRoot));
  readOnlyRoots.add(await realpath(dataRoot).catch(() => resolve(dataRoot)));
}

// Joins still resolving their root; each settles once `roots` records it.
const registering = new Set<Promise<unknown>>();

async function registerJoin(
  dataRoot: string,
  kind: string,
): Promise<{
  readonly root: string;
  readonly pending: Promise<W5RootPresence>;
}> {
  const root = await realpath(dataRoot);
  if (readOnlyRoots.has(root))
    throw new W5HostCohortRefusedError('cohort-unavailable');
  let pending = roots.get(root);
  if (!pending) {
    pending = acquireW5RootPresence(root, 'host', kind, inspectSelf);
    roots.set(root, pending);
  }
  return { root, pending };
}

/** Permanent host presence; historical-peer exclusion remains a separate step. */
export async function joinW5RootPresence(
  dataRoot: string,
  kind: string,
): Promise<void> {
  if (readOnlyRoots.has(resolve(dataRoot)))
    throw new W5HostCohortRefusedError('cohort-unavailable');
  const registration = registerJoin(dataRoot, kind);
  registering.add(registration);
  let root: string;
  let pending: Promise<W5RootPresence>;
  try {
    ({ root, pending } = await registration);
  } finally {
    registering.delete(registration);
  }
  let presence: W5RootPresence;
  try {
    presence = await pending;
  } catch (error) {
    if (roots.get(root) === pending) roots.delete(root);
    if (error instanceof W5RootPresenceBusyError)
      throw new W5HostCohortRefusedError('maintenance-held', error);
    throw error;
  }
  // An uncertain acquired hold stays owned until drain; never orphan or reacquire it.
  if (!presence.isHeld()) throw new Error('W5 root presence lost.');
}

async function joinsRegistered(): Promise<void> {
  while (registering.size) await Promise.allSettled([...registering]);
}

/**
 * True while this process holds, or is still joining, host presence for the
 * root. Offline maintenance windows refuse such a caller (CAN-4498).
 */
export async function hasJoinedW5RootPresence(
  dataRoot: string,
): Promise<boolean> {
  await joinsRegistered();
  const root = await realpath(dataRoot).catch(() => resolve(dataRoot));
  // A join may have started while this resolved the root.
  await joinsRegistered();
  const pending = roots.get(root);
  if (!pending) return false;
  try {
    await pending;
    return true;
  } catch {
    return false;
  }
}

/** CLI beforeExit only: no outstanding asynchronous I/O remains. */
export function leaveW5RootPresenceSync(): void {
  const pending = [...roots.values()];
  roots.clear();
  // Settled joins close in this microtask, before another event-loop turn.
  for (const entry of pending)
    void entry.then(
      (presence) => presence.close(),
      () => {},
    );
}

/** Atomic-writer backstop reacquires after each natural CLI drain. */
export async function ensureW5RootPresence(): Promise<void> {
  const { getCanopyDataDir } = await import('../canopy-paths');
  await joinW5RootPresence(getCanopyDataDir(), 'lazy-writer');
}
