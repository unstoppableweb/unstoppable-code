import {
  acquireW5RootPresence,
  type W5RootPresence,
} from '@canopy/core-platform/w5-root-presence';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  PlatformServices,
  PlatformUnixSocketAddress,
  PlatformEndpointPathIdentity,
  DaemonStartupClaimPort,
} from '@canopy/core-runtime';
import { assertCanopyDaemonEndpointStale } from '@canopy/core-runtime/node';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  createW5ColdAuthority,
  requireW5ColdAuthority,
  withW5ColdRestoreStorage,
  withW5ColdHost,
  W5ColdAuthorityRefusedError,
  type W5ColdAuthority,
  type W5ColdOperation,
  type W5InternalRootSettlement,
} from '@canopy/core-runtime/node/w5/cold-authority';
import { withStorageAdmission } from './w5-storage';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import {
  acquireW5MaintenanceExclusion,
  W5HostCohortRefusedError,
  type W5MaintenanceExclusion,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { CanopyRuntimeDescriptorSchema } from '@canopy/protocol/canopy-core';
import {
  restoreW5Backup,
  type W5BackupContext,
  type W5ExclusiveMaintenance,
} from './w5-backup';
import { isErrnoException } from './type-guards';
import {
  readW5MaintenanceDecisions,
  refuseW5MaintenanceDecisions,
  runW5MaintenanceDecisions,
} from './w5-maintenance-decisions';
import type { W5Diagnosis, W5DiagnosisScope } from './w5-maintenance-diagnosis';

export type {
  W5MaintenanceDecision,
  W5MaintenanceDecisionResult,
} from './w5-maintenance-decisions';

import {
  W5MaintenanceRefusedError,
  W5MaintenanceDecisionError,
  type W5MaintenanceRefusal,
  type W5MaintenanceRequest,
  type W5MaintenanceResult,
} from '@canopy/core-runtime/node/w5/maintenance-types';
export {
  W5MaintenanceRefusedError,
  W5MaintenanceDecisionError,
  type W5MaintenanceRefusal,
  type W5MaintenanceRequest,
  type W5MaintenanceResult,
} from '@canopy/core-runtime/node/w5/maintenance-types';

/** Trusted cold maintenance composition only; never the admitted app host. */
export interface W5MaintenanceContext extends W5BackupContext {
  /** Trusted migration qualification, not available to ordinary recovery launches. */
  readonly offlineMigration?: () => Promise<void>;
  /** Internal-root settlement checks W5 ownership, not unrelated app payloads. */
  readonly diagnosisScope?: W5DiagnosisScope;
  readonly internalRootSettlement?: W5InternalRootSettlement;
  /** Trusted internal-root composition; runs before writer shutdown under exclusion. */
  readonly adoptInternalRootMetadata?: (
    diagnosis: W5Diagnosis,
    assertHeld: () => Promise<void>,
  ) => Promise<void>;
  readonly platform: Pick<
    PlatformServices,
    'supervision' | 'secureFiles' | 'endpoints'
  >;
}
interface HeldMaintenance {
  readonly dataRoot: string;
  readonly claims: DaemonStartupClaimPort;
  readonly handle: object;
  readonly verifyRuntime: () => Promise<void>;
  readonly exclusion: W5MaintenanceExclusion;
  readonly presence: W5RootPresence;
  cold?: {
    readonly authority: W5ColdAuthority;
    readonly operation: W5ColdOperation;
    revoke(): void;
  };
}
const held = new WeakMap<W5ExclusiveMaintenance, HeldMaintenance>();
const heldHosts = new WeakMap<
  W5MaintenanceContext['host'],
  W5ExclusiveMaintenance
>();
// Revocation must not let GC release root exclusion while a worker may write.
const unconfirmedWorkerPresence = new Set<W5RootPresence>();

/** Cold-host admission, revoked before the exclusion or startup claim releases. */
export async function isW5MaintenanceHostHeld(
  host: W5MaintenanceContext['host'],
  dataRoot: string,
): Promise<boolean> {
  const exclusive = heldHosts.get(host);
  const state = exclusive && held.get(exclusive);
  if (!state?.cold || state.cold.operation === 'diagnose') return false;
  try {
    await requireW5ColdAuthority(
      state.cold.authority,
      dataRoot,
      state.cold.operation,
    );
    return true;
  } catch {
    return false;
  }
}

/** Only a held restore composition may use core's cold writer admission. */
export async function withW5MaintenanceRestoreStorage<T>(
  exclusive: W5ExclusiveMaintenance,
  dataRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  const state = held.get(exclusive);
  if (!state?.cold) throw new W5MaintenanceRefusedError('claim-lost');
  return withW5ColdRestoreStorage(
    state.cold.authority,
    dataRoot,
    withStorageAdmission,
    run,
  );
}

/** Validation only: callers cannot mint or retain admission after completion. */
export async function isW5MaintenanceHeld(
  exclusive: W5ExclusiveMaintenance,
  dataRoot: string,
): Promise<boolean> {
  const state = held.get(exclusive);
  if (!state || state.dataRoot !== resolve(dataRoot)) return false;
  try {
    await state.verifyRuntime();
    const identity = await state.claims.identity(state.handle);
    return (
      held.get(exclusive) === state &&
      identity?.dataRoot === state.dataRoot &&
      (await state.exclusion.isHeld()) &&
      state.presence.isHeld()
    );
  } catch {
    return false;
  }
}

function refuse(reason: W5MaintenanceRefusal, decision?: number): never {
  throw new W5MaintenanceRefusedError(reason, undefined, decision);
}

/**
 * CAN-3797. Order: startup claim, endpoint and descriptor checks, then the
 * host cohort (Electron main, the CLI and create-worktree children). Refuses,
 * never waits, while holding anything. The process hosting this must never
 * register as a host itself.
 * Runtime must already exist and be private. Only a proven-stale socket may be
 * unlinked, after host exclusion; diagnose never unlinks it.
 * Resolve (RX2) checks every decision against the diagnosis before its cold
 * writer starts.
 */
export async function runW5Maintenance(
  contextInput: W5MaintenanceContext,
  requestInput: W5MaintenanceRequest,
  signal?: AbortSignal,
): Promise<W5MaintenanceResult> {
  const settlement = contextInput.internalRootSettlement;
  const context: W5MaintenanceContext = {
    dataRoot: contextInput.dataRoot,
    host: contextInput.host,
    platform: contextInput.platform,
    offlineMigration: contextInput.offlineMigration,
    diagnosisScope: contextInput.diagnosisScope,
    adoptInternalRootMetadata: contextInput.adoptInternalRootMetadata,
    internalRootSettlement: settlement && {
      source: settlement.source,
      transactionId: settlement.transactionId,
      assertHeld: settlement.assertHeld,
      abandonCommits: [...settlement.abandonCommits],
    },
  };
  const request = { ...requestInput };
  if (
    request.source !== 'offline_maintenance' ||
    (request.mode !== 'diagnose' &&
      request.mode !== 'reopen' &&
      request.mode !== 'restore' &&
      request.mode !== 'resolve')
  )
    refuse('invalid-request');
  const decisions =
    request.mode === 'resolve'
      ? readW5MaintenanceDecisions(request.decisions)
      : null;
  if (request.mode === 'resolve' && !decisions) refuse('invalid-request');
  // Windows has no general host registration. The offline migration window
  // requires native cold proof plus CAN-5786's startup guard, never resolve.
  if (
    hostOperatingSystem() === 'win32' &&
    (!context.offlineMigration || request.mode !== 'reopen')
  )
    refuse('platform-unsupported');
  await context.offlineMigration?.();
  signal?.throwIfAborted();
  if (context.host.workersStarted !== 0) refuse('writer-active');
  const { dataRoot, platform } = context;
  const runtime = join(dataRoot, 'runtime');
  async function privateDirectory(path: string): Promise<void> {
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
      refuse('runtime-unavailable');
    const permission = await platform.secureFiles.permissions({
      path,
      kind: 'directory',
      mode: 'owner-only',
      action: 'verify',
    });
    if (permission.state !== 'private') refuse('runtime-unavailable');
  }
  let runtimeIdentity;
  try {
    if (resolve(dataRoot) !== dataRoot) refuse('runtime-unavailable');
    await privateDirectory(dataRoot);
    await privateDirectory(runtime);
    runtimeIdentity =
      hostOperatingSystem() === 'win32'
        ? await lstat(runtime, { bigint: true })
        : await lstat(runtime);
  } catch {
    refuse('runtime-unavailable');
  }
  const { dev, ino } = runtimeIdentity;
  async function verifyRuntime(): Promise<void> {
    await context.offlineMigration?.();
    await privateDirectory(runtime);
    const current =
      hostOperatingSystem() === 'win32'
        ? await lstat(runtime, { bigint: true })
        : await lstat(runtime);
    if (current.dev !== dev || current.ino !== ino)
      refuse('runtime-unavailable');
  }
  const self = await platform.supervision.inspectProcess({
    pid: process.pid,
    signal,
  });
  if (self.state !== 'running') refuse('identity-unprovable');
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspectProcess: async (pid, inspectionSignal) => {
      const found = await platform.supervision.inspectProcess({
        pid,
        signal: inspectionSignal,
      });
      if (found.state === 'running')
        return { kind: 'alive', startIdentity: found.startIdentity };
      return { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  // Structural compatibility with the same Phase 1 runtime contract.
  const claimPort: DaemonStartupClaimPort = claims;
  const acquisition = await claimPort.tryAcquire(signal, {
    recoverDeparted: true,
  });
  if (acquisition.kind !== 'acquired')
    refuse(acquisition.kind === 'held' ? 'claim-held' : 'claim-ambiguous');
  const { handle } = acquisition;
  const recoveredEndpointBind = acquisition.recovered?.endpointBound === true;
  // Until an absent endpoint is proven, keep any inherited bind evidence.
  let preserveEndpointBind = recoveredEndpointBind;
  let operationError: unknown;
  const exclusive: W5ExclusiveMaintenance = Object.freeze({
    kind: 'w5-exclusive-maintenance',
  });
  let exclusion: W5MaintenanceExclusion | undefined;
  let presence: W5RootPresence | undefined;
  // The cohort record goes first; hosts never touch the claim.
  async function releaseExclusion(): Promise<void> {
    try {
      await exclusion?.release();
    } catch {
      throw new W5MaintenanceRefusedError('release-uncertain', operationError);
    }
  }
  async function releaseClaim(): Promise<void> {
    const result = await claims.release(handle, { preserveEndpointBind });
    // Diagnose retains inherited bind markers, so their release stays uncertain.
    if (result !== 'released')
      throw new W5MaintenanceRefusedError('release-uncertain', operationError);
  }
  // Set once an unconfirmed exit has been reported, so it is reported once.
  let writerExitUnconfirmed = false;
  async function stopWriter(): Promise<void> {
    if (context.host.workersStarted === 0) return;
    await context.host.shutdown();
    // Shutdown waits a bounded time for workers to exit. A worker still
    // alive could keep writing, so the claim must stay held.
    if (context.host.runningWorkerCount > 0) {
      writerExitUnconfirmed = true;
      throw new W5MaintenanceRefusedError(
        'writer-exit-unconfirmed',
        operationError,
      );
    }
  }
  async function finishMaintenance(): Promise<void> {
    held.get(exclusive)?.cold?.revoke();
    heldHosts.delete(context.host);
    held.delete(exclusive);
    // Preserve departed bind evidence when a refused/uncertain endpoint remains.
    try {
      if (!writerExitUnconfirmed) await stopWriter();
    } catch (error) {
      if (operationError !== undefined) {
        operationError = Object.assign(
          new Error('W5 maintenance and writer shutdown failed.'),
          { errors: [operationError, error] },
        );
        throw operationError;
      }
      operationError = error;
      throw error;
    } finally {
      // An unconfirmed worker exit keeps the record and the claim; departed-
      // owner recovery frees both once this process has exited.
      if (context.host.runningWorkerCount === 0) {
        await releaseExclusion();
        presence?.close();
        await releaseClaim();
      } else if (presence) unconfirmedWorkerPresence.add(presence);
    }
  }
  try {
    signal?.throwIfAborted();
    await verifyRuntime();
    // A published daemon no longer holds the startup claim. Probe its lifetime
    // lock even when discovery is missing.
    const endpoints = platform.endpoints;
    const address = ((): ReturnType<typeof endpoints.address> => {
      try {
        return endpoints.address({ dataRoot, endpointName: 'core' });
      } catch {
        return refuse('runtime-unavailable');
      }
    })();
    const probe =
      endpoints.semantics === 'filesystem-socket'
        ? await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          )
        : await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          );
    async function requireStaleSocket(
      socketAddress: PlatformUnixSocketAddress,
      identity: PlatformEndpointPathIdentity,
    ): Promise<void> {
      try {
        // CAN-5957's device-remap rule belongs in this shared daemon decision.
        await assertCanopyDaemonEndpointStale({
          descriptorPath: join(runtime, 'core.json'),
          address: socketAddress,
          identity,
          supervision: platform.supervision,
          recoveredEndpointBind,
          signal,
        });
      } catch {
        signal?.throwIfAborted();
        refuse('endpoint-unavailable');
      }
    }
    if (
      probe.state !== 'absent' &&
      !(probe.state === 'refused' && address.kind === 'unix-socket')
    )
      refuse('endpoint-unavailable');
    if (probe.state === 'absent') preserveEndpointBind = false;
    async function readDescriptor(): Promise<Buffer | undefined> {
      let descriptorBytes: Buffer | undefined;
      const descriptorPath = join(runtime, 'core.json');
      try {
        const stat = await lstat(descriptorPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
          refuse('endpoint-unavailable');
        const permissions = await platform.secureFiles.permissions({
          path: descriptorPath,
          kind: 'file',
          mode: 'owner-only',
          action: 'verify',
        });
        if (permissions.state !== 'private') refuse('endpoint-unavailable');
        descriptorBytes = await readFile(descriptorPath);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      }
      return descriptorBytes;
    }
    async function verifyDescriptor(
      descriptorBytes: Buffer | undefined,
    ): Promise<void> {
      if (descriptorBytes) {
        let raw: unknown;
        try {
          raw = JSON.parse(descriptorBytes.toString('utf8'));
        } catch {
          refuse('endpoint-unavailable');
        }
        const descriptor = CanopyRuntimeDescriptorSchema.safeParse(raw);
        if (
          !descriptor.success ||
          descriptor.data.endpoint.path !== address.path ||
          descriptor.data.endpoint.kind !==
            (address.kind === 'unix-socket' ? 'socket' : 'pipe')
        )
          refuse('endpoint-unavailable');
        const owner = await platform.supervision.inspectProcess({
          pid: descriptor.data.pid,
          signal,
        });
        if (
          owner.state === 'unverifiable' ||
          (owner.state === 'running' &&
            owner.startIdentity === descriptor.data.startIdentity)
        )
          refuse('identity-unprovable');
      }
    }
    const descriptorBytes = await readDescriptor();
    if (probe.state === 'refused' && address.kind === 'unix-socket')
      await requireStaleSocket(address, probe.identity);
    await verifyDescriptor(descriptorBytes);
    try {
      presence = await acquireW5RootPresence(dataRoot, 'maintenance');
    } catch (error) {
      throw new W5MaintenanceRefusedError('host-active', error);
    }
    // TRANSITIONAL cohort step: remove when the W5 rows move to `daemon`.
    try {
      exclusion = await acquireW5MaintenanceExclusion({
        dataRoot,
        owner: { pid: process.pid, startIdentity: self.startIdentity },
        inspect: async (pid, inspectionSignal) =>
          platform.supervision.inspectProcess({
            pid,
            signal: inspectionSignal,
          }),
        secureFiles: platform.secureFiles,
        offlineMigration: context.offlineMigration,
        signal,
      });
    } catch (error) {
      if (!(error instanceof W5HostCohortRefusedError)) throw error;
      refuse(
        error.reason === 'host-active'
          ? 'host-active'
          : error.reason === 'platform-unsupported'
            ? 'platform-unsupported'
            : 'cohort-ambiguous',
      );
    }
    held.set(exclusive, {
      dataRoot,
      claims: claimPort,
      handle,
      verifyRuntime,
      exclusion,
      presence,
    });
    heldHosts.set(context.host, exclusive);
    if (!(await isW5MaintenanceHeld(exclusive, dataRoot))) refuse('claim-lost');
    if (
      probe.state === 'refused' &&
      endpoints.semantics === 'filesystem-socket'
    ) {
      const socketAddress = endpoints.address({
        dataRoot,
        endpointName: 'core',
      });
      const fresh = await endpoints.probe(socketAddress);
      if (
        fresh.state !== 'refused' ||
        fresh.identity.device !== probe.identity.device ||
        fresh.identity.inode !== probe.identity.inode
      )
        refuse('endpoint-unavailable');
      const freshDescriptor = await readDescriptor();
      await requireStaleSocket(socketAddress, fresh.identity);
      // Inherited bind lineage does not waive W5's descriptor admission checks.
      await verifyDescriptor(freshDescriptor);
      signal?.throwIfAborted();
      if (!(await isW5MaintenanceHeld(exclusive, dataRoot)))
        refuse('claim-lost');
      if (request.mode !== 'diagnose') {
        const claim = await claims.identity(handle);
        if (!claim || !(await exclusion.isHeld())) refuse('claim-lost');
        if (
          (await endpoints.unlinkStale({
            address: socketAddress,
            expected: fresh.identity,
            claim,
          })) === 'changed'
        )
          refuse('endpoint-unavailable');
        preserveEndpointBind = false;
      }
    }
    const state = held.get(exclusive);
    if (!state) refuse('claim-lost');
    const cold = await createW5ColdAuthority({
      canonicalDataRoot: dataRoot,
      operation: request.mode,
      assertExclusion: async () => {
        signal?.throwIfAborted();
        if (!(await isW5MaintenanceHeld(exclusive, dataRoot)))
          refuse('claim-lost');
      },
    });
    state.cold = { ...cold, operation: request.mode };
    return await withW5ColdHost(
      cold.authority,
      dataRoot,
      request.mode,
      context.host,
      async (): Promise<W5MaintenanceResult> => {
        // Local import keeps SQLite and offline scans off the desktop startup graph.
        const { diagnoseW5State } = await import('./w5-maintenance-diagnosis');
        const diagnosis = await diagnoseW5State(
          dataRoot,
          context.diagnosisScope,
          // Internal-root settlement proves upgrades before opening the writer.
          request.mode === 'reopen' &&
            context.adoptInternalRootMetadata !== undefined,
        );
        signal?.throwIfAborted();
        if (!(await isW5MaintenanceHeld(exclusive, dataRoot)))
          refuse('claim-lost');
        if (request.mode === 'diagnose') return { mode: 'diagnose', diagnosis };
        if (request.mode === 'reopen') {
          if (diagnosis.logIssue) refuse('log-unavailable');
          await context.host.recoveryReport();
          if (context.adoptInternalRootMetadata) {
            const requireHeld = async (): Promise<void> => {
              signal?.throwIfAborted();
              if (!(await isW5MaintenanceHostHeld(context.host, dataRoot)))
                refuse('claim-lost');
            };
            await requireHeld();
            const recovered = await diagnoseW5State(
              dataRoot,
              context.diagnosisScope,
            );
            await requireHeld();
            await context.adoptInternalRootMetadata(recovered, requireHeld);
            await requireHeld();
          }
          await stopWriter();
          if (!(await isW5MaintenanceHeld(exclusive, dataRoot)))
            refuse('claim-lost');
          const after = await diagnoseW5State(dataRoot, context.diagnosisScope);
          if (!(await isW5MaintenanceHeld(exclusive, dataRoot)))
            refuse('claim-lost');
          return { mode: 'reopen', diagnosis: after };
        }
        if (request.mode === 'resolve') {
          if (!decisions) refuse('invalid-request');
          const refusal = refuseW5MaintenanceDecisions(diagnosis, decisions);
          if (refusal) refuse(refusal.reason, refusal.decision);
          const requireHeld = async (): Promise<void> => {
            signal?.throwIfAborted();
            if (!(await isW5MaintenanceHostHeld(context.host, dataRoot)))
              refuse('claim-lost');
          };
          const { results, failure } = await runW5MaintenanceDecisions(
            context.host,
            decisions,
            requireHeld,
          );
          const diagnoseAfter = async (): Promise<W5Diagnosis> => {
            await requireHeld();
            const after = await diagnoseW5State(
              dataRoot,
              context.diagnosisScope,
            );
            await requireHeld();
            return after;
          };
          if (!failure) {
            try {
              await stopWriter();
              return {
                mode: 'resolve',
                results,
                diagnosis: await diagnoseAfter(),
              };
            } catch (error) {
              throw new W5MaintenanceDecisionError(results, error);
            }
          }
          try {
            await stopWriter();
          } catch (error) {
            throw new W5MaintenanceDecisionError(
              results,
              Object.assign(
                new Error('W5 maintenance resolve and writer shutdown failed.'),
                { errors: [failure.error, error] },
              ),
            );
          }
          // The stopped decision's outcome may be unknown, so diagnose again
          // unless aborted; only an unconfirmed writer exit must be reported.
          const after = signal?.aborted
            ? undefined
            : await diagnoseAfter().catch(() => undefined);
          throw new W5MaintenanceDecisionError(results, failure.error, after);
        }
        // Do not start a recovery-capable writer with unresolved decisions/effects.
        if (
          diagnosis.logIssue ||
          diagnosis.commits.length ||
          diagnosis.reservations.length
        )
          refuse('recovery-required');
        const commitId = await restoreW5Backup(context, {
          source: request.source,
          backupPath: request.backupPath,
          exclusive,
          unreadableOverride: request.unreadableOverride,
        });
        return { mode: 'restore', commitId };
      },
      context.internalRootSettlement,
    );
  } catch (error) {
    operationError = error;
    if (error instanceof W5ColdAuthorityRefusedError) {
      if (signal?.aborted && error.underlying === signal.reason)
        operationError = signal.reason;
      else if (error.underlying instanceof W5MaintenanceRefusedError)
        operationError = error.underlying;
      else
        operationError = new W5MaintenanceRefusedError(
          error.reason === 'ownership-inconsistent'
            ? 'invalid-state'
            : 'claim-lost',
          error,
        );
    }
    throw operationError;
  } finally {
    await finishMaintenance();
  }
}
