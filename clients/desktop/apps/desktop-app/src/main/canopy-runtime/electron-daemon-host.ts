import { prepareCanopySecureStorage } from '@canopy/desktop-shared/node/build-storage-startup';
import {
  ELECTRON_MIGRATION_ROLE,
  createElectronMigrationLaunch,
} from './migration-channel';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import {
  CanopyClientError,
  type CanopyClient,
  type CanopyClientOptions,
} from '@canopy/core-client';
import {
  connectCanopyClient,
  createCanopyDaemonHostLaunch,
  createDaemonOwnerCredential,
  createRecoverableCanopyStartupClaim,
  type CanopyConnectOptions,
  type CanopyDaemonBeforeSpawn,
} from '@canopy/core-client/node';
import {
  createOwnedChildServices,
  deriveLocalAuthorityIdentity,
  createPlatformEndpointServices,
  hostLocalAuthorityObservation,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
} from '@canopy/core-platform';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import { recoverStaleCanopyDaemonEndpoint } from '@canopy/core-runtime/node';
import { daemonName, type CanopyRuntimeMode } from '@canopy/protocol/brand';
import {
  CanopyRuntimeDescriptorSchema,
  CORE_EXECUTION_STREAMS,
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  WORKER_CODE_GRAPH_STREAM_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_STREAM_DEFINITIONS,
  WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  WORKER_SCRIPT_STREAM_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  getResolvedCanopyDataDir,
  getCanopyRuntimeMode,
} from '@canopy/desktop-shared/canopy-paths';
import {
  getBundledBinDir,
  getEnhancedEnv,
} from '@canopy/desktop-shared/pipelines/config-paths';
import type {
  ElectronDaemonOwnerClient,
  ELECTRON_DAEMON_OWNER_DEFINITIONS,
} from './electron-daemon-owner';

declare const __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__: string | undefined;

export const ELECTRON_DAEMON_DEFINITIONS = {
  queries: {
    ...CORE_TRANSPORT_QUERY_DEFINITIONS,
    // Only the Files reads the opt-in route has a daemon path for (CAN-4305,
    // CAN-5509); its selection set decides which ones leave.
    'worker.filesystem.roots.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.roots.list'],
    'worker.filesystem.directory.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.directory.list'],
    'worker.filesystem.file.read':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.file.read'],
    'worker.filesystem.search':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.search'],
    'worker.filesystem.link.resolve':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.link.resolve'],
    // CAN-5501: typed client only; production selects none and has no Git grant.
    'worker.git.branch.list':
      WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
    // W6g's record port (CAN-5528): served only by a W5 qualification daemon,
    // so production's manifest refuses each call capability_unavailable.
    ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
    // Default eligible local renderer summary reads (CAN-5719).
    'worker.codeGraph.query':
      WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS['worker.codeGraph.query'],
    // Orphaned Claude terminals after a main crash (CAN-5097).
    'worker.terminal.list':
      WORKER_TERMINAL_QUERY_DEFINITIONS['worker.terminal.list'],
    // Eligible local window workflows without model steps (CAN-5086).
    'worker.pipeline.execution.get':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.get'],
  },
  instructions: {
    // CAN-5908: typing only; no production entry route is selected.
    ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    ...CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    // Eligible local window terminals (CAN-5088).
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
    // And its renderer worktree builds (CAN-5089).
    'worker.codeGraph.build':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS['worker.codeGraph.build'],
    // Worktree cleanup ends the worktree's daemon builds (CAN-5089).
    'worker.codeGraph.builds.cancel':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS[
        'worker.codeGraph.builds.cancel'
      ],
    // Eligible local window workflows without model steps (CAN-5086).
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
      ],
    'worker.pipeline.execution.cancel':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.cancel'
      ],
    // The merged generation queue (CAN-5628).
    'worker.codeGraph.buildQueue.update':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS[
        'worker.codeGraph.buildQueue.update'
      ],
    // The merged generation queue (CAN-5628).
    'worker.codeGraph.build.cancel':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS[
        'worker.codeGraph.build.cancel'
      ],
    // Eligible local renderer script runs (CAN-5087).
    'worker.script.execute':
      WORKER_SCRIPT_INSTRUCTION_DEFINITIONS['worker.script.execute'],
    'worker.script.execution.cancel':
      WORKER_SCRIPT_INSTRUCTION_DEFINITIONS['worker.script.execution.cancel'],
  },
  streams: {
    // CAN-5908: typing only; CAN-4730 owns watch route selection.
    'worker.filesystem.watch':
      WORKER_STREAM_DEFINITIONS['worker.filesystem.watch'],
    'core.runtime.events':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.runtime.events'],
    // W5e: served only by a W5 qualification daemon; production's manifest
    // lacks it, so the subscriber never attaches there.
    'core.events.subscribe':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.events.subscribe'],
    ...WORKER_TERMINAL_STREAM_DEFINITIONS,
    ...WORKER_SCRIPT_STREAM_DEFINITIONS,
    // The daemon's execution status for the resource monitor (CAN-5690);
    // a daemon without it refuses the stream and the monitor goes on alone.
    'core.execution.status.events':
      CORE_EXECUTION_STREAMS['core.execution.status.events'],
    // Eligible local window workflows without model steps (CAN-5086).
    'worker.pipeline.execution.events':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.execution.events'],
    // The merged generation queue (CAN-5628).
    'worker.codeGraph.buildQueue.events':
      WORKER_CODE_GRAPH_STREAM_DEFINITIONS[
        'worker.codeGraph.buildQueue.events'
      ],
  },
};
type D = typeof ELECTRON_DAEMON_DEFINITIONS;
export type ElectronDaemonClient = CanopyClient<
  D['queries'],
  D['instructions'],
  D['streams']
>;
type ConnectOptions = CanopyConnectOptions &
  Omit<
    CanopyClientOptions<D['queries'], D['instructions'], D['streams']>,
    'connection'
  >;
type O = typeof ELECTRON_DAEMON_OWNER_DEFINITIONS;
/** The owner session's connect options; the proof comes from this launch's credential. */
export type OwnerConnectOptions = CanopyConnectOptions &
  Omit<
    CanopyClientOptions<O['queries'], O['instructions'], O['streams']>,
    'connection' | 'ownerProof'
  >;
export interface ElectronDaemonHostInputs {
  /** Trusted main composition only; no renderer fields. */
  readonly dataRoot?: string;
  readonly runtimeMode?: CanopyRuntimeMode;
  readonly executable?: string;
  readonly ownedChildNativePath?: string;
  readonly windowsProcessPath?: string;
  /**
   * The flip launch (CAN-5543): every spawn opens the W5 host, after
   * `beforeSpawn` where the platform has a startup claim.
   */
  readonly w5?: { readonly beforeSpawn?: CanopyDaemonBeforeSpawn };
}
const unavailable = (message: string): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
  });

/** Fixed install or build location only; empty when neither is defined. */
export function selectWindowsProcessPath(
  inputs: ElectronDaemonHostInputs,
): string {
  if (inputs.windowsProcessPath !== undefined) return inputs.windowsProcessPath;
  if (app.isPackaged)
    return join(process.resourcesPath, 'bin', WINDOWS_PROCESS_FILE);
  return typeof __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__ === 'string'
    ? __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__
    : '';
}

/** Uses the H1 shared launch policy and the staged opaque native ownership adapter. */
export async function createElectronDaemonHost(
  inputs: ElectronDaemonHostInputs = {},
): Promise<{
  authorityId: string;
  /** The realpath of the data root the daemon serves; revisions hash it. */
  canonicalDataRoot: string;
  launch: ReturnType<typeof createCanopyDaemonHostLaunch>;
  connect: (options: ConnectOptions) => Promise<ElectronDaemonClient>;
  /** CAN-5771: the daemon owner credential and its checks. Trusted main only. */
  owner: {
    /** Whether the published daemon is the one this launch spawned last. */
    isSpawnedDaemon(signal: AbortSignal): Promise<boolean>;
    /** Whether this launch has spawned a daemon at all. */
    hasSpawned(): boolean;
    /** `connect` with `ownerProof` over this launch's credential. */
    connect(options: OwnerConnectOptions): Promise<ElectronDaemonOwnerClient>;
  };
}> {
  const os = hostPlatformOperatingSystem();
  // One selection serves both process inspection and the authority principal.
  const windowsProcessPath =
    os === 'win32' ? selectWindowsProcessPath(inputs) : undefined;
  const platform = hostPlatformServices(createPlatformEndpointServices(os), {
    ...(windowsProcessPath !== undefined && { windowsProcessPath }),
  });
  const runtimeMode =
    inputs.runtimeMode ?? (app.isPackaged ? getCanopyRuntimeMode() : 'dev');
  const requestedRoot = resolve(
    inputs.dataRoot ?? getResolvedCanopyDataDir(runtimeMode).path,
  );
  if (inputs.dataRoot === undefined) await prepareCanopySecureStorage();
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const { authorityId, canonicalDataRoot: dataRoot } =
    await deriveLocalAuthorityIdentity(
      { brandId: BRAND.id, dataRoot: requestedRoot },
      hostLocalAuthorityObservation(
        windowsProcessPath
          ? windowsPrincipalObserver(windowsProcessPath)
          : undefined,
      ),
    );
  const runtimeDirectory = platform.paths.runtimeDirectory({ dataRoot });
  const name = `${daemonName(BRAND)}${os === 'win32' ? '.exe' : ''}`;
  const executable =
    inputs.executable ??
    (app.isPackaged
      ? join(getBundledBinDir(), name)
      : resolve('dist/core-daemon', name));
  async function privatePath(
    path: string,
    kind: 'file' | 'directory',
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await platform.secureFiles.permissions({
        path,
        kind,
        action: kind === 'directory' ? 'restrict' : 'verify',
        mode: 'owner-only',
      });
      if (result.state === 'private') return;
      if (kind === 'file' && result.reason === 'check failed: ENOENT')
        throw Object.assign(new Error('Core runtime file is absent.'), {
          code: 'ENOENT',
        });
      if (
        kind !== 'file' ||
        ![
          'path changed while opening',
          'path changed during permission check',
        ].includes(result.reason)
      )
        break;
    }
    throw unavailable('Core runtime permissions are not private.');
  }
  const prepareRuntime = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    if ((await realpath(dataRoot)) !== dataRoot)
      throw unavailable('Core data root is not canonical.');
    await privatePath(dataRoot, 'directory');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    if ((await realpath(runtimeDirectory)) !== runtimeDirectory)
      throw unavailable('Core runtime directory is not canonical.');
    await privatePath(runtimeDirectory, 'directory');
    await prepareEndpoint();
    signal.throwIfAborted();
  };
  /** A long data root's socket alias, checked before every connect (CAN-5694). */
  const prepareEndpoint = async (): Promise<void> => {
    if (platform.endpoints.semantics !== 'filesystem-socket') return;
    const endpoints = platform.endpoints;
    await endpoints
      .prepare(endpoints.address({ dataRoot, endpointName: 'core' }))
      .catch(() => {
        throw unavailable('Core endpoint alias is not private.');
      });
  };
  let claims: Promise<CanopyStartupClaimPort> | undefined;
  const claimPort = (): Promise<CanopyStartupClaimPort> => {
    claims ??= (async (): Promise<CanopyStartupClaimPort> => {
      const self = await platform.supervision.inspectProcess({
        pid: process.pid,
      });
      if (self.state !== 'running')
        throw unavailable('Core launcher process identity is unverifiable.');
      return createCanopyStartupClaimPort({
        dataRoot,
        owner: { pid: process.pid, startIdentity: self.startIdentity },
        inspectProcess: async (pid, signal) => {
          const state = await platform.supervision.inspectProcess({
            pid,
            signal,
          });
          return state.state === 'running'
            ? { kind: 'alive', startIdentity: state.startIdentity }
            : { kind: state.state === 'absent' ? 'dead' : 'unknown' };
        },
      });
    })();
    void claims.catch(() => {
      claims = undefined;
    });
    return claims;
  };
  const address = platform.endpoints.address({
    dataRoot,
    endpointName: 'core',
  });
  // CAN-5771 D19: every macOS and Linux spawn gets a fresh owner secret;
  // Windows spawns keep today's handoff.
  const ownerCredential =
    os !== 'win32' ? createDaemonOwnerCredential() : undefined;
  const migration = createElectronMigrationLaunch({
    enabled: ELECTRON_MIGRATION_ROLE.enabled,
  });
  const beforeSpawn = inputs.w5?.beforeSpawn;
  const launch = createCanopyDaemonHostLaunch({
    secureStorageLayout: 'nested-v1',
    ...(migration && { migration }),
    dataRoot,
    runtimeMode,
    executable,
    platform: os,
    supervision: platform.supervision,
    ownedChildren: createOwnedChildServices({
      os,
      nativePath:
        inputs.ownedChildNativePath ??
        (app.isPackaged
          ? join(process.resourcesPath, 'cli/core-owned-child.node')
          : resolve(
              '.cache/native-owned-child',
              `${os}-${process.arch}`,
              'core-owned-child.node',
            )),
    }),
    ...(inputs.w5 && { w5Host: true }),
    ...(beforeSpawn && {
      beforeSpawn: {
        timeoutMs: beforeSpawn.timeoutMs,
        run: async (signal, protection): Promise<void> => {
          await protection.assertHeld();
          const claims = await claimPort();
          await recoverStaleCanopyDaemonEndpoint({
            dataRoot,
            claims,
            claimHandle: protection.claimHandle,
            recoveredEndpointBind: protection.recoveredEndpointBind,
            signal,
            platform: {
              ...platform,
              endpoints: createPlatformEndpointServices(os, {
                validateStartupClaim: async (claim): Promise<boolean> => {
                  signal.throwIfAborted();
                  const held = await claims.verify(claim);
                  signal.throwIfAborted();
                  return held;
                },
              }),
            },
          });
          await protection.assertHeld();
          await beforeSpawn.run(signal, protection);
        },
      },
    }),
    environmentSource: getEnhancedEnv({
      includeCanopySecrets: false,
      environment: false,
    }),
    prepareRuntime,
    expectedEndpoint: {
      kind: address.kind === 'unix-socket' ? 'socket' : 'pipe',
      path: address.path,
    },
    verifyPrivateFile: async (path, signal): Promise<void> => {
      signal.throwIfAborted();
      await privatePath(path, 'file');
      signal.throwIfAborted();
    },
    ...(os !== 'win32' && {
      claim: createRecoverableCanopyStartupClaim(claimPort),
    }),
    ...(ownerCredential && { ownerCredential }),
  });
  /** Verifies the runtime around one connection; closes it when the second check fails. */
  async function verifiedConnect<
    C extends { readonly signal: AbortSignal; close(): Promise<void> },
  >(signal: AbortSignal, open: () => Promise<C>): Promise<C> {
    await launch.verifyRuntime(signal);
    const client = await open();
    try {
      await launch.verifyRuntime(signal);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  return {
    authorityId,
    canonicalDataRoot: dataRoot,
    launch,
    connect(options): Promise<ElectronDaemonClient> {
      return verifiedConnect(
        options.signal ?? new AbortController().signal,
        () => connectCanopyClient(options),
      );
    },
    owner: {
      async isSpawnedDaemon(signal): Promise<boolean> {
        const spawned = ownerCredential?.spawnedPid() ?? null;
        if (spawned === null) return false;
        const parsed = CanopyRuntimeDescriptorSchema.safeParse(
          await launch.ports.descriptor.read(signal),
        );
        if (!parsed.success || parsed.data.pid !== spawned) return false;
        const observed = await platform.supervision.inspectProcess({
          pid: spawned,
          signal,
        });
        return (
          observed.state === 'running' &&
          observed.startIdentity === parsed.data.startIdentity
        );
      },
      hasSpawned(): boolean {
        return (ownerCredential?.spawnedPid() ?? null) !== null;
      },
      connect(options): Promise<ElectronDaemonOwnerClient> {
        const credential = ownerCredential;
        if (!credential)
          return Promise.reject(
            unavailable("This app is not the background service's owner."),
          );
        return verifiedConnect(
          options.signal ?? new AbortController().signal,
          () =>
            connectCanopyClient({
              ...options,
              ownerProof: (connectionId) =>
                credential.prove(connectionId, launch.dataRootHash),
            }),
        );
      },
    },
  };
}
