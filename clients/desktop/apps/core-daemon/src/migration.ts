import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
  type CanopyRuntimeIdentity,
} from '@canopy/core-runtime';
import {
  serveCanopyControlStream,
  type CanopyControlStreamSession,
  type CanopyObligationRegistry,
} from '@canopy/core-runtime/node';
import {
  createMigrationAdmission,
  createMigrationEvidenceStore,
  createResumableMigrationModule,
  encodeMigrationFrame,
  parseMigrationLauncherFrame,
  migrationOfferFrame,
  migrationResultFrame,
  migrationRefusedFrame,
  MIGRATION_SLOTS_AT_PIN,
  type MigrationAdmissionOptions,
  type MigrationAdmissionPort,
  type MigrationModuleOptions,
  type MigrationWireFrame,
} from '@canopy/core-runtime/node/vault';
import {
  launcherRequirement,
  peerCaptureFor,
  type PeerIdentityServices,
  type LauncherChannel,
} from '@canopy/core-platform';
import {
  migrationFirstFrame,
  type MigrationByteChannel,
} from '@canopy/core-transport/node/migration-channel';
import type { CanopyFramedAuthOptions } from '@canopy/core-transport';
import { CORE_MIGRATION_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';

/** No runtime switch, environment variable or token holder can enable this. */
export const MIGRATION_PRODUCTION_ENABLED = false;

export interface ServeMigrationChannelOptions {
  readonly channel: LauncherChannel;
  readonly peerIdentity: PeerIdentityServices;
  readonly admission: Omit<
    MigrationAdmissionOptions,
    'evidence' | 'onAmbiguity'
  >;
  readonly migration: Omit<MigrationModuleOptions, 'admission' | 'os'>;
  readonly identity: CanopyRuntimeIdentity;
  readonly buildVersion: string;
  readonly auth: CanopyFramedAuthOptions;
  readonly obligations: Pick<CanopyObligationRegistry, 'hold'>;
  /** Explicit isolated qualification composition only; never passed by production startup. */
  readonly qualificationHandoff?: (context: {
    channel: object;
    admission: MigrationAdmissionPort;
  }) => {
    exchange(
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<{ frames: MigrationWireFrame[] }>;
    close(): void;
  };
}

/** Admission precedes D3; the published endpoint never receives this runtime. */
export async function serveMigrationChannel(
  options: ServeMigrationChannelOptions,
): Promise<CanopyControlStreamSession> {
  let release: (() => void) | undefined;
  try {
    release = options.obligations.hold('migration admission');
    return await startMigrationChannel(options);
  } catch (error) {
    options.channel.close();
    throw error;
  } finally {
    release?.();
  }
}

async function startMigrationChannel(
  options: ServeMigrationChannelOptions,
): Promise<CanopyControlStreamSession> {
  const { channel } = options;
  let transport: MigrationByteChannel = channel;
  const evidence = createMigrationEvidenceStore();
  const admission = createMigrationAdmission({
    ...options.admission,
    evidence,
    onAmbiguity: (reason) => sessions.reportAmbiguity(reason),
  });
  const sessions = createResumableMigrationModule({
    ...options.migration,
    admission: admission.port,
    os: options.admission.os,
  });
  let handle: object | undefined;
  let control: CanopyControlStreamSession | undefined;
  let qualified:
    | ReturnType<
        NonNullable<ServeMigrationChannelOptions['qualificationHandoff']>
      >
    | undefined;
  let closed = false;
  const stopped = new AbortController();
  const closeChannel = (): void => {
    if (closed) return;
    closed = true;
    stopped.abort();
    qualified?.close();
    if (handle) {
      sessions.endChannel(handle, 'channel-closed');
      admission.retire(handle);
    }
    sessions.close();
    admission.close();
    transport.close();
  };
  try {
    const expected = options.admission.expected;
    const required = launcherRequirement(
      {
        team: expected.teamId,
        identifier: expected.flavorId,
        buildId: expected.buildId,
      },
      true,
    );
    transport = await migrationFirstFrame(
      channel,
      'daemon',
      () => {
        const capture = options.peerIdentity.captureLauncherEvidence(
          channel,
          required,
        );
        if (!capture.ok) return false;
        handle = evidence.attach(peerCaptureFor(channel));
        return true;
      },
      AbortSignal.timeout(2000),
    );
    if (!handle) throw new Error('Migration evidence unavailable.');
    const channelHandle = handle;
    const admitted = admission.admitMigrationConnection(channelHandle);
    if (!admitted.admitted) throw new Error('Migration admission refused.');
    qualified = options.qualificationHandoff?.({
      channel: channelHandle,
      admission: admission.port,
    });
    let greeted = false;
    let busy = false;
    const exchange = async (
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<{ frames: MigrationWireFrame[] }> => {
      if (closed || busy) throw new Error('Migration session unavailable.');
      busy = true;
      try {
        // A qualified coroutine yields its host action before this single-flight exchange returns.
        if (qualified) return await qualified.exchange(raw, signal);
        const parsed = parseMigrationLauncherFrame(raw);
        if (!parsed.ok) {
          closeChannel();
          throw new Error('Migration frame refused.');
        }
        const frame = parsed.frame;
        if (frame.type === 'hello') {
          if (greeted) {
            closeChannel();
            throw new Error('Migration hello repeated.');
          }
          greeted = true;
          const frames: MigrationWireFrame[] = [
            encodeMigrationFrame({ type: 'welcome' }),
          ];
          for (const slot of MIGRATION_SLOTS_AT_PIN) {
            const issued = await sessions.issue(channelHandle, slot.id);
            if (issued.issued)
              frames.push(
                encodeMigrationFrame(migrationOfferFrame(issued.offer)),
              );
          }
          return { frames };
        }
        if (!greeted) {
          if (frame.type === 'import') frame.value.fill(0);
          closeChannel();
          throw new Error('Migration hello required.');
        }
        const presentation = {
          channel: channelHandle,
          challenge: frame.challenge,
          operation: frame.operation,
          purpose: frame.purpose,
        };
        if (frame.type === 'decline') {
          const result = sessions.decline(
            frame.sessionId,
            presentation,
            frame.reason,
          );
          return {
            frames: result.accepted
              ? []
              : [
                  encodeMigrationFrame(
                    migrationRefusedFrame(frame.sessionId, result.reason),
                  ),
                ],
          };
        }
        const result = sessions.importSlot(
          frame.sessionId,
          presentation,
          frame.value,
        );
        return {
          frames: [
            encodeMigrationFrame(
              result.accepted
                ? migrationResultFrame(frame.sessionId, await result.outcome)
                : migrationRefusedFrame(frame.sessionId, result.reason),
            ),
          ],
        };
      } finally {
        busy = false;
      }
    };
    const runtime = createRuntimeProfileGraph({
      profile: 'core',
      identity: options.identity,
      modules: [
        defineRuntimeModule({
          name: 'core.vaultMigration',
          plane: 'core',
          definitions: {
            queries: {},
            instructions: CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
            streams: {},
          },
          handlers: {
            queries: {},
            instructions: {
              'core.vaultMigration.exchange': ({ frame }, context) =>
                exchange(frame, context.signal),
            },
            streams: {},
          },
        }),
      ],
      principalFor: () => 'migration-launcher',
      phaseDeadlineMs: 5000,
    });
    await runtime.start();
    try {
      control = serveCanopyControlStream({
        stream: {
          signal: stopped.signal,
          read: () => transport.read(stopped.signal),
          write: (bytes) => transport.write(bytes, stopped.signal),
          close: () => {
            closeChannel();
            return Promise.resolve();
          },
        },
        auth: options.auth,
        dispatcher: runtime.dispatcher,
        operations: runtime.operations,
        caller: {
          principalId: admitted.caller.principal,
          clientInstanceId: admitted.caller.channelId,
          authorityId: admitted.caller.admittedHost.authorityId,
          interfaceKind: 'daemon',
          grants: ['core.runtime.read', 'core.vaultMigration.import'],
        },
        obligations: options.obligations,
        buildVersion: options.buildVersion,
        maxActiveRequests: 1,
      });
    } catch (error) {
      closeChannel();
      await runtime.shutdown('migration setup failed');
      throw error;
    }
    const serving = control;
    const done = serving.done.then(async () => {
      closeChannel();
      await runtime.shutdown('migration channel ended');
    });
    void done.catch(() => undefined);
    return {
      done,
      close: async (): Promise<void> => {
        closeChannel();
        await serving.close();
        await done;
      },
    };
  } catch (error) {
    await control?.close();
    closeChannel();
    throw error;
  }
}

export interface DaemonMigrationBuild {
  readonly buildId: string;
  readonly flavor: string;
  readonly launcherIdentifier: string;
  readonly secureMode: string;
}

/** Claims fd 3 before the host can spawn; even a disabled launch closes its end. */
export function prepareDaemonMigration(options: {
  readonly requested: boolean;
  readonly os: 'darwin' | 'win32' | 'linux';
  readonly peerIdentity: PeerIdentityServices;
  readonly build: DaemonMigrationBuild;
}): {
  readonly kind: 'disabled' | 'not_launcher' | 'unavailable';
  readonly reason: string;
} {
  if (!options.requested) return { kind: 'not_launcher', reason: 'no-channel' };
  if (options.os !== 'darwin')
    return { kind: 'unavailable', reason: 'no-launch-primitive' };
  const claimed = options.peerIdentity.claimLauncherChannel();
  if (!claimed.ok) return { kind: 'not_launcher', reason: claimed.reason };
  claimed.channel.close();
  return {
    kind: 'disabled',
    reason:
      options.build.buildId === '' || options.build.flavor === 'development'
        ? 'development-build'
        : 'release-gate-and-v5-ports',
  };
}
