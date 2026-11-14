import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CORE_W5_RECOVERY_INSTRUCTIONS,
  type CoreW5MaintenanceRequest,
  type CoreW5MaintenanceReply,
} from '@canopy/protocol/canopy-core';
import { w5RecoveryRefusalFromExitCode } from '@canopy/core-transport';
import { CanopyClientError } from '../errors';
import { connectCanopyClient } from './connect';
import { Deadline, fixed } from './launch-deadline';
import { canopyConnectError } from './endpoint';
import type { CanopyOwnedDaemonChildren } from './daemon-host';

export interface W5RecoveryLaunchOptions {
  readonly dataRoot: string;
  readonly runtimeMode: 'prod' | 'rc' | 'dev';
  readonly executable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly children: CanopyOwnedDaemonChildren;
  readonly endpointFor: (name: string) => string;
  readonly request: CoreW5MaintenanceRequest;
  readonly signal?: AbortSignal;
}
const definitions = {
  queries: {},
  instructions: CORE_W5_RECOVERY_INSTRUCTIONS,
  streams: {},
};
/** Owns the cold child until its observed exit; it never creates an ordinary lease. */
export async function executeW5Recovery(
  options: W5RecoveryLaunchOptions,
): Promise<CoreW5MaintenanceReply> {
  options.signal?.throwIfAborted();
  const nonce = randomBytes(12).toString('hex');
  const auth = {
    secret: randomBytes(32).toString('hex'),
    dataRootHash: createHash('sha256').update(options.dataRoot).digest('hex'),
  };
  const child = await options.children.spawn({
    executable: options.executable,
    args: [
      '--data-root',
      options.dataRoot,
      '--runtime-mode',
      options.runtimeMode,
      '--w5-recovery',
      nonce,
    ],
    environment: {
      ...options.environment,
      CANOPY_DAEMON_CLAIM_HANDOFF: 'stdin-recovery-v1',
    },
    stdin: JSON.stringify({ auth }),
  });
  const deadline = new Deadline(10000, options.signal);
  let client:
    | Awaited<
        ReturnType<
          typeof connectCanopyClient<
            typeof definitions.queries,
            typeof definitions.instructions,
            typeof definitions.streams
          >
        >
      >
    | undefined;
  try {
    const endpoint = {
      kind: 'socket' as const,
      path: options.endpointFor(`w5-recovery-${nonce}`),
      auth,
    };
    while (!client) {
      try {
        client = await connectCanopyClient({
          endpoint,
          definitions,
          clientName: 'w5-recovery-launcher',
          clientVersion: '1',
          timeoutMs: deadline.remainingMs(),
          signal: deadline.signal,
        });
      } catch (error) {
        if (
          !(error instanceof CanopyClientError) ||
          error.payload.kind !== 'unavailable' ||
          !deadline.isBeforeExpiration()
        )
          throw error;
        const exit = await deadline.run(
          (signal) =>
            Promise.race([delay(25, undefined, { signal }), child.exited]),
          fixed('Recovery service did not start.'),
        );
        if (exit) {
          const failure = canopyConnectError(
            'unavailable',
            'Recovery service did not start.',
          );
          const reason = exit.signal
            ? undefined
            : w5RecoveryRefusalFromExitCode(exit.code);
          // Decode after deadline redaction; only our fixed status codes carry reasons.
          throw reason ? Object.assign(failure, { reason }) : failure;
        }
      }
    }
    // Startup is bounded separately; maintenance retains the worker's own bounds.
    deadline.dispose();
    const reply = await client.instruction(
      'core.workspaceRecovery.execute',
      options.request,
      { signal: options.signal },
    );
    await client.close();
    client = undefined;
    const stopping = new Deadline(10000, options.signal);
    try {
      const exit = await stopping.run(
        () => child.exited,
        fixed('Recovery service did not stop.'),
      );
      if (exit.code !== 0)
        throw Object.assign(new Error('Recovery release is uncertain.'), {
          reason: 'release-uncertain',
        });
    } finally {
      stopping.dispose();
    }
    return reply;
  } catch (error) {
    await client?.close().catch(() => undefined);
    try {
      await child.terminate(AbortSignal.timeout(5000));
    } catch (cleanupError) {
      throw Object.assign(new Error('Recovery service exit is unconfirmed.'), {
        reason: 'writer-exit-unconfirmed',
        cause: error,
        cleanupError,
      });
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
