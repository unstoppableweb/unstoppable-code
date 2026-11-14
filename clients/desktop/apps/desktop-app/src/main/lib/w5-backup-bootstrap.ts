import {
  acquireW5RootPresence,
  type W5RootPresence,
} from '@canopy/core-platform/w5-root-presence';
import { createW5BackupBootstrapHost } from '@canopy/core-runtime/node/w5/backup-bootstrap-host-composition';
import { hostW5ConfinementAddon } from '../w5-commit-log/confinement-addon';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  createW5ColdAuthority,
  withW5ColdHost,
  W5ColdAuthorityRefusedError,
} from '@canopy/core-runtime/node/w5/cold-authority';
import {
  acquireW5MaintenanceExclusion,
  type W5MaintenanceExclusion,
} from '@canopy/desktop-shared/node/w5-host-cohort';
import type { CanopyDaemonBeforeSpawn } from '@canopy/core-client/node';
import type { W5BackupContext } from './w5-backup';

export type W5BackupBootstrapProtection = Parameters<
  CanopyDaemonBeforeSpawn['run']
>[1];

// An uncertain worker exit must not let GC release permanent exclusion.
const unconfirmedBootstrapPresence = new Set<W5RootPresence>();
let bootstrapRetired = false;
let bootstrapFlight: Promise<unknown> | undefined;

function requireBootstrapActive(): void {
  if (bootstrapRetired)
    throw new W5ColdAuthorityRefusedError('authority-retired');
  if (unconfirmedBootstrapPresence.size !== 0)
    throw new Error('The W5 bootstrap worker has not exited.');
}

/** One-way fence; a handoff must await the capture's confirmed worker exit. */
export async function retireW5BackupBootstrap(): Promise<void> {
  bootstrapRetired = true;
  await bootstrapFlight;
  if (unconfirmedBootstrapPresence.size !== 0)
    throw new Error('The W5 bootstrap worker has not exited.');
}

/** Startup-claim holder only, before ordinary W5 I/O. Not offline migration. */
export async function withW5BackupBootstrap<T>(
  context: W5BackupContext,
  protectionInput: W5BackupBootstrapProtection,
  run: () => Promise<T>,
): Promise<T> {
  requireBootstrapActive();
  if (bootstrapFlight) throw new Error('The W5 bootstrap is already running.');
  const flight = runW5BackupBootstrap(context, protectionInput, run);
  const settled = flight.finally((): void => {
    if (bootstrapFlight === settled) bootstrapFlight = undefined;
  });
  bootstrapFlight = settled;
  return settled;
}

async function runW5BackupBootstrap<T>(
  context: W5BackupContext,
  protectionInput: W5BackupBootstrapProtection,
  run: () => Promise<T>,
): Promise<T> {
  const { dataRoot, host } = context;
  const protection = {
    assertHeld: protectionInput.assertHeld.bind(protectionInput),
    retainClaim: protectionInput.retainClaim.bind(protectionInput),
  };
  await protection.assertHeld();
  if (host.runningWorkerCount !== 0)
    throw new Error('W5 bootstrap host is already running.');
  const platform = hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
  );
  const runtime = join(dataRoot, 'runtime');
  const rootIdentity = await lstat(dataRoot);
  const runtimeIdentity = await lstat(runtime);
  for (const path of [dataRoot, runtime]) {
    if (
      (await realpath(path)) !== path ||
      (
        await platform.secureFiles.permissions({
          path,
          kind: 'directory',
          mode: 'owner-only',
          action: 'verify',
        })
      ).state !== 'private'
    )
      throw new Error('W5 bootstrap root is not private.');
  }
  const self = await platform.supervision.inspectProcess({ pid: process.pid });
  if (self.state !== 'running')
    throw new Error('W5 bootstrap identity unavailable.');
  // The desktop may already hold shared presence; cold bootstrap must coexist
  // with that host while independently fencing offline maintenance.
  const presence = await acquireW5RootPresence(
    dataRoot,
    'host',
    'backup-bootstrap',
  );
  let exclusion: W5MaintenanceExclusion;
  try {
    exclusion = await acquireW5MaintenanceExclusion({
      dataRoot,
      owner: { pid: process.pid, startIdentity: self.startIdentity },
      inspect: (pid, signal) =>
        platform.supervision.inspectProcess({ pid, signal }),
      secureFiles: platform.secureFiles,
      allowCurrentHost: true,
    });
  } catch (error) {
    presence.close();
    throw error;
  }
  async function stopBootstrap(): Promise<void> {
    let failure: unknown;
    try {
      await host.shutdown();
    } catch (error) {
      failure = error;
    }
    if (host.runningWorkerCount !== 0) {
      unconfirmedBootstrapPresence.add(presence);
      protection.retainClaim();
      throw new Error('The W5 bootstrap worker has not exited.');
    }
    try {
      await exclusion.release();
    } finally {
      presence.close();
    }
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : Object.assign(new Error('W5 bootstrap shutdown failed.'), {
            cause: failure,
          });
  }
  let revoke: (() => void) | undefined;
  try {
    const cold = await createW5ColdAuthority({
      canonicalDataRoot: dataRoot,
      operation: 'backup-bootstrap',
      assertExclusion: async (): Promise<void> => {
        requireBootstrapActive();
        await protection.assertHeld();
        const currentRoot = await lstat(dataRoot);
        const currentRuntime = await lstat(runtime);
        if (
          !currentRoot.isDirectory() ||
          !currentRuntime.isDirectory() ||
          (hostPlatformOperatingSystem() !== 'win32' &&
            (currentRoot.uid !== process.getuid?.() ||
              currentRuntime.uid !== process.getuid?.() ||
              (currentRoot.mode & 0o077) !== 0 ||
              (currentRuntime.mode & 0o077) !== 0)) ||
          (await realpath(runtime)) !== runtime ||
          currentRoot.dev !== rootIdentity.dev ||
          currentRoot.ino !== rootIdentity.ino ||
          currentRuntime.dev !== runtimeIdentity.dev ||
          currentRuntime.ino !== runtimeIdentity.ino ||
          !presence.isHeld() ||
          !(await exclusion.isHeld())
        )
          throw new Error('W5 bootstrap exclusion lost.');
        const endpoints = platform.endpoints;
        const endpoint =
          endpoints.semantics === 'filesystem-socket'
            ? await endpoints.probe(
                endpoints.address({ dataRoot, endpointName: 'core' }),
              )
            : await endpoints.probe(
                endpoints.address({ dataRoot, endpointName: 'core' }),
              );
        if (endpoint.state !== 'absent')
          throw new Error('W5 bootstrap daemon is present.');
        requireBootstrapActive();
      },
    });
    revoke = (): void => cold.revoke();
    return await withW5ColdHost(
      cold.authority,
      dataRoot,
      'backup-bootstrap',
      host,
      async (): Promise<T> => {
        const result = await run();
        requireBootstrapActive();
        return result;
      },
    );
  } finally {
    // The capability retires before exclusion releases; uncertain exit retains both claims.
    revoke?.();
    await stopBootstrap();
  }
}

/** A separate recovery-only host, never the ordinary desktop host. */
export function createW5BackupBootstrapContext(
  dataRoot: string,
): W5BackupContext {
  requireBootstrapActive();
  const host = createW5BackupBootstrapHost({
    dataRoot,
    workerEntry: join(__dirname, 'w5-commit-log-worker.js'),
    confinementAddon: hostW5ConfinementAddon(),
  });
  return { dataRoot, host };
}
