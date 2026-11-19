import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
  type PlatformServices,
  type PlatformStartupClaim,
} from '@canopy/core-runtime';
import { serveCanopyControlStream } from '@canopy/core-runtime/node';
import {
  runW5Maintenance,
  type W5MaintenanceContext,
} from '@canopy/core-runtime/node/w5/maintenance';
import {
  W5MaintenanceDecisionError,
  W5MaintenanceRefusedError,
} from '@canopy/core-runtime/node/w5/maintenance-types';
import {
  W5BackupRefusedError,
  W5BackupRecoveryError,
} from '@canopy/core-runtime/node/w5/backup';
import { createW5MaintenanceHost } from '@canopy/core-runtime/node/w5/cold-host-composition';
import { acquireW5RootPresence } from '@canopy/core-platform/w5-root-presence';
import { acquireW5MaintenanceExclusion } from '@canopy/core-platform/w5-maintenance-exclusion';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import {
  CORE_W5_RECOVERY_INSTRUCTIONS,
  CoreW5MaintenanceReplySchema,
  type CoreW5MaintenanceReply,
} from '@canopy/protocol/canopy-core';
import { daemonW5WorkerEntry, daemonW5ConfinementAddon } from './w5-host';

export interface DaemonW5RecoveryOptions {
  readonly dataRoot: string;
  readonly nonce: string;
  readonly auth: { readonly secret: string; readonly dataRootHash: string };
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly platformFor: (
    validateStartupClaim: (claim: PlatformStartupClaim) => Promise<boolean>,
  ) => PlatformServices;
  readonly buildVersion: string;
  readonly workerEntry?: string;
}
function reason(error: unknown): string {
  if (
    error instanceof W5MaintenanceRefusedError ||
    error instanceof W5BackupRefusedError
  )
    return error.reason;
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'unexpected';
}
/** One private cold invocation. No ordinary graph, publication, lease or SHARED presence. */
export async function runDaemonW5Recovery(
  options: DaemonW5RecoveryOptions,
): Promise<void> {
  if (options.os === 'win32')
    throw new W5MaintenanceRefusedError('platform-unsupported');
  const { dataRoot, auth } = options;
  const claimPort: { current?: CanopyStartupClaimPort } = {};
  const platform = options.platformFor(
    (claim) => claimPort.current?.verify(claim) ?? Promise.resolve(false),
  );
  if (
    !/^[a-f0-9]{24}$/.test(options.nonce) ||
    auth.dataRootHash !== createHash('sha256').update(dataRoot).digest('hex')
  )
    throw new W5MaintenanceRefusedError('invalid-request');
  for (const path of [dataRoot, join(dataRoot, 'runtime')]) {
    if (
      (await realpath(path)) !== path ||
      !(await lstat(path)).isDirectory() ||
      (
        await platform.secureFiles.permissions({
          path,
          kind: 'directory',
          mode: 'owner-only',
          action: 'verify',
        })
      ).state !== 'private'
    )
      throw new W5MaintenanceRefusedError('runtime-unavailable');
  }
  const endpoints = platform.endpoints;
  if (endpoints.semantics !== 'filesystem-socket')
    throw new W5MaintenanceRefusedError('platform-unsupported');
  const self = await platform.supervision.inspectProcess({ pid: process.pid });
  if (self.state !== 'running')
    throw new W5MaintenanceRefusedError('identity-unprovable');
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspectProcess: async (pid, signal) => {
      const found = await platform.supervision.inspectProcess({ pid, signal });
      return found.state === 'running'
        ? { kind: 'alive', startIdentity: found.startIdentity }
        : { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  claimPort.current = claims;
  const acquired = await claims.tryAcquire(undefined, {
    recoverDeparted: true,
  });
  if (acquired.kind !== 'acquired')
    throw new W5MaintenanceRefusedError(
      acquired.kind === 'held' ? 'claim-held' : 'claim-ambiguous',
    );
  const claimHandle = acquired.handle;
  const inheritedEndpointBind = acquired.recovered?.endpointBound === true;
  let listener: Awaited<ReturnType<typeof endpoints.bind>> | undefined;
  let host: ReturnType<typeof createW5MaintenanceHost> | undefined;
  let used = false;
  let runtime: ReturnType<typeof createRuntimeProfileGraph> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const bound = await endpoints.bind(
      endpoints.address({
        dataRoot,
        endpointName: `w5-recovery-${options.nonce}`,
      }),
    );
    listener = bound;
    if (bound.kind !== 'bound')
      throw new W5MaintenanceRefusedError('endpoint-unavailable');
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      identity: {
        runtimeId: randomUUID(),
        hostId: 'w5-recovery',
        authorityId: `w5-recovery:${auth.dataRootHash}`,
      },
      principalFor: () => 'interface',
      phaseDeadlineMs: 5000,
      modules: [
        defineRuntimeModule({
          name: 'core.workspaceRecovery',
          plane: 'core',
          definitions: {
            queries: {},
            instructions: CORE_W5_RECOVERY_INSTRUCTIONS,
            streams: {},
          },
          handlers: {
            queries: {},
            streams: {},
            instructions: {
              'core.workspaceRecovery.execute': async (request, context) => {
                if (used)
                  throw new W5MaintenanceRefusedError('invalid-request');
                used = true;
                host = createW5MaintenanceHost({
                  dataRoot,
                  workerEntry: options.workerEntry ?? daemonW5WorkerEntry(),
                  confinementAddon: daemonW5ConfinementAddon(),
                });
                const maintenance: W5MaintenanceContext = {
                  dataRoot,
                  host,
                  platform,
                  allowReservationRelease: false,
                };
                let reply: CoreW5MaintenanceReply;
                try {
                  const result = await runW5Maintenance(
                    maintenance,
                    request,
                    {
                      os: options.os,
                      claim: { port: claims, handle: acquired.handle },
                      backup: {
                        syncDirectory: async (path) => {
                          await flushDirectory(path);
                        },
                        admit: async (_targets, run) => run(),
                      },
                      acquirePresence: (root) =>
                        acquireW5RootPresence(root, 'maintenance'),
                      acquireExclusion: acquireW5MaintenanceExclusion,
                    },
                    context.signal,
                  );
                  reply = CoreW5MaintenanceReplySchema.parse({
                    state: 'complete',
                    result,
                  });
                } catch (error) {
                  reply =
                    error instanceof W5BackupRecoveryError
                      ? CoreW5MaintenanceReplySchema.parse({
                          state: 'recovery-required',
                          commitId: error.commitId,
                        })
                      : error instanceof W5MaintenanceDecisionError
                        ? CoreW5MaintenanceReplySchema.parse({
                            state: 'stopped',
                            reason: reason(error.failure),
                            results: error.results,
                            diagnosis: error.diagnosis,
                          })
                        : CoreW5MaintenanceReplySchema.parse({
                            state: 'refused',
                            reason: reason(error),
                            ...(error instanceof W5MaintenanceRefusedError &&
                            error.decision !== undefined
                              ? { decision: error.decision }
                              : {}),
                          });
                }
                if (host.runningWorkerCount !== 0)
                  return {
                    state: 'refused' as const,
                    reason: 'writer-exit-unconfirmed',
                  };
                return reply;
              },
            },
          },
        }),
      ],
    });
    runtime = graph;
    await graph.start();
    const next = bound.listener.connections()[Symbol.asyncIterator]().next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connection;
    try {
      connection = await Promise.race([
        next,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new W5MaintenanceRefusedError('endpoint-unavailable')),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (connection.done)
      throw new W5MaintenanceRefusedError('endpoint-unavailable');
    const session = serveCanopyControlStream({
      stream: connection.value,
      auth,
      dispatcher: graph.dispatcher,
      operations: graph.operations,
      buildVersion: options.buildVersion,
      caller: {
        principalId: 'w5-recovery-launcher',
        clientInstanceId: options.nonce,
        authorityId: `w5-recovery:${auth.dataRootHash}`,
        interfaceKind: 'desktop',
        grants: ['core.runtime.read', 'core.workspaceRecovery.maintain'],
      },
      maxActiveRequests: 1,
      obligations: { hold: (): (() => void) => (): void => {} },
    });
    await session.done;
  } catch (error) {
    failed = true;
    failure = error;
  }
  async function cleanup(): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (listener?.kind === 'bound') await listener.listener.close();
    } catch (error) {
      errors.push(error);
    }
    // Drain/cancel handlers before confirming that their last cold worker exited.
    try {
      if (runtime) {
        const report = await runtime.shutdown('W5 recovery ended');
        if (report.phases.some((phase) => phase.status !== 'completed'))
          errors.push(
            new W5MaintenanceRefusedError('release-uncertain', report),
          );
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await host?.shutdown();
    } catch (error) {
      errors.push(error);
    }
    if (host && host.runningWorkerCount !== 0)
      errors.push(new W5MaintenanceRefusedError('writer-exit-unconfirmed'));
    // Any unconfirmed cleanup keeps admission held; no ordinary serving follows.
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw Object.assign(new Error('Recovery cleanup is uncertain.'), {
        errors,
      });
    // Cold recovery may have removed the inherited socket under exclusion.
    const preserveEndpointBind =
      inheritedEndpointBind &&
      (endpoints.semantics === 'filesystem-socket'
        ? await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          )
        : await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          )
      ).state !== 'absent';
    if (
      (await claims.release(claimHandle, {
        preserveEndpointBind,
      })) !== 'released'
    )
      throw new W5MaintenanceRefusedError('release-uncertain');
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!failed) throw cleanupError;
    throw Object.assign(
      new Error('Recovery failed and cleanup is uncertain.'),
      { cause: failure, cleanupError },
    );
  }
  if (failed) throw failure;
}
