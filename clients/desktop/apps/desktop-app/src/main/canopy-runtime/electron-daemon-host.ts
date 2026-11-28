import { prepareCanopySecureStorage } from '@canopy/desktop-shared/node/build-storage-startup';
import { onInternalRootTrusteesAccepted } from '@canopy/core-platform/build-storage-startup';
import {
  ELECTRON_MIGRATION_ROLE,
  createElectronMigrationLaunch,
} from './migration-channel';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { createDaemonStartDiagnostics } from './daemon-start-diagnostics';
import {
  type AcceptedPathRole,
  reportAcceptedForeignTrustees,
} from './accepted-foreign-trustees';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import {
  CanopyClientError,
  type CanopyClient,
  type CanopyClientOptions,
} from '@canopy/core-client';
import {
  canopyEndpointRepairRequiredError,
  canopyLaunchDetails,
  connectCanopyClient,
  type CanopyLaunchDetails,
  createCanopyDaemonHostLaunch,
  createDaemonOwnerCredential,
  createRecoverableCanopyStartupClaim,
  waitForCanopyFileLockRetry,
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
import type { PlatformPermissionResult } from '@canopy/core-runtime';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import {
  CanopyEndpointRepairRequiredError,
  recoverStaleCanopyDaemonEndpoint,
} from '@canopy/core-runtime/node';
import { resolveSecureDataDir } from '@canopy/core-runtime/node/secure-data-dir';
import { daemonName, type CanopyRuntimeMode } from '@canopy/protocol/brand';
import {
  CanopyRuntimeDescriptorSchema,
  CORE_CLIENT_WINDOW_INSTRUCTION_DEFINITIONS,
  CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS,
  CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS,
  CORE_CONFIG_DOCUMENT_INSTRUCTION_DEFINITIONS,
  CORE_CONFIG_DOCUMENT_QUERY_DEFINITIONS,
  CORE_EXECUTION_STREAMS,
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  OPERATION_INSTRUCTION_DEFINITIONS,
  OPERATION_QUERY_DEFINITIONS,
  OPERATION_STREAM_DEFINITIONS,
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
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
  WORKER_SCRIPT_QUERY_DEFINITIONS,
  WORKER_SCRIPT_STREAM_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_RECORD_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_RECORD_LIFECYCLE_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_RECORD_QUERY_DEFINITIONS,
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
import { reportContainedFailure } from '../observability/contained-failure-reporter';
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
    // CAN-5501: typed client; macOS and Linux select it (DAEMON_GIT_PRODUCTION_SELECTION); needs worker.git.read.
    'worker.git.branch.list':
      WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
    // CAN-4729: worktree health on macOS and Linux, codes only.
    'worker.git.worktree.health.get':
      WORKER_QUERY_DEFINITIONS['worker.git.worktree.health.get'],
    // CAN-4729: changed files on macOS and Linux, revision 3 only.
    'worker.git.diff.get': WORKER_QUERY_DEFINITIONS['worker.git.diff.get'],
    // W6g's record port (CAN-5528): served only by a W5 qualification daemon,
    // so production's manifest refuses each call capability_unavailable.
    ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
    // Default eligible local renderer summary reads (CAN-5719).
    'worker.codeGraph.query':
      WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS['worker.codeGraph.query'],
    // Eligible agent status reads and steering language checks (CAN-5093).
    'worker.codeGraph.status.get':
      WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS['worker.codeGraph.status.get'],
    'worker.codeGraph.languages.validate':
      WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS[
        'worker.codeGraph.languages.validate'
      ],
    // Orphaned Claude terminals after a main crash (CAN-5097).
    'worker.terminal.list':
      WORKER_TERMINAL_QUERY_DEFINITIONS['worker.terminal.list'],
    // The worktree terminal record's history (CAN-7051); a daemon without it
    // is not used for records.
    ...WORKER_TERMINAL_RECORD_QUERY_DEFINITIONS,
    // Eligible local window workflows without model steps (CAN-5086).
    'worker.pipeline.execution.get':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.get'],
    // Script run reads: each key's latest run, one run, and an orphaned
    // run's group members for a Force stop's confirmation (CAN-7663).
    'worker.script.execution.get':
      WORKER_SCRIPT_QUERY_DEFINITIONS['worker.script.execution.get'],
    'worker.script.execution.list':
      WORKER_SCRIPT_QUERY_DEFINITIONS['worker.script.execution.list'],
    'worker.script.execution.groupMembers':
      WORKER_SCRIPT_QUERY_DEFINITIONS['worker.script.execution.groupMembers'],
    // CAN-5092 S1a: typing only; production daemons do not serve operation
    // records, so the manifest refuses each call capability_unavailable.
    ...OPERATION_QUERY_DEFINITIONS,
    // CAN-5092 S1b: typing only; production daemons do not serve workflow
    // definitions, so the manifest refuses each call capability_unavailable.
    ...PIPELINE_DEFINITION_QUERY_DEFINITIONS,
    // CAN-6997: typing only until account authority activation is selected;
    // a daemon not holding the account refuses each call.
    ...CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS,
    // CAN-7991: typing only; no daemon serves the preferences document until
    // the CAN-5722 flip, so the manifest refuses each call.
    ...CORE_CONFIG_DOCUMENT_QUERY_DEFINITIONS,
  },
  instructions: {
    // CAN-5908: typing only; no production entry route is selected.
    ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    ...CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
    // CAN-6997: provisioning the daemon's own account from this app's
    // sign-in; typing only until account authority is selected.
    'core.integration.cloudAccount.provision':
      CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS[
        'core.integration.cloudAccount.provision'
      ],
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    // Eligible local window terminals (CAN-5088).
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
    // The worktree terminal record (CAN-7051).
    ...WORKER_TERMINAL_RECORD_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_RECORD_LIFECYCLE_INSTRUCTION_DEFINITIONS,
    // Window tickets and terminal grants for this app's own windows
    // (CAN-8068); a daemon without them keeps every window on main's relay.
    ...CORE_CLIENT_WINDOW_INSTRUCTION_DEFINITIONS,
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
    // A finished run's clear, keyed (CAN-7663).
    'worker.script.execution.clear':
      WORKER_SCRIPT_INSTRUCTION_DEFINITIONS['worker.script.execution.clear'],
    'worker.script.execution.stop':
      WORKER_SCRIPT_INSTRUCTION_DEFINITIONS['worker.script.execution.stop'],
    // CAN-5092 S1a: typing only, as the operation record queries.
    ...OPERATION_INSTRUCTION_DEFINITIONS,
    // CAN-5092 S1b: typing only, as the definition queries. No import: it is
    // not on the interface authority list.
    'core.pipeline.definition.upsert':
      PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS[
        'core.pipeline.definition.upsert'
      ],
    'core.pipeline.definition.delete':
      PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS[
        'core.pipeline.definition.delete'
      ],
    'core.pipeline.definition.duplicate':
      PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS[
        'core.pipeline.definition.duplicate'
      ],
    'core.pipeline.definition.setEnabled':
      PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS[
        'core.pipeline.definition.setEnabled'
      ],
    // CAN-7991: typing only, as the document queries. The owner writes go
    // over the owner connection alone.
    'core.config.document.update':
      CORE_CONFIG_DOCUMENT_INSTRUCTION_DEFINITIONS[
        'core.config.document.update'
      ],
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
    // CAN-5092 S1a: typing only, as the operation record queries.
    ...OPERATION_STREAM_DEFINITIONS,
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
  readonly diagnosticsDirectory?: string;
  /**
   * The flip launch (CAN-5543): every spawn opens the W5 host, after
   * `beforeSpawn` where the platform has a startup claim.
   */
  readonly w5?: { readonly beforeSpawn?: CanopyDaemonBeforeSpawn };
}
const unavailable = (
  message: string,
  details?: Readonly<Record<string, string | number>>,
): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  });

const CHECK_FAILED = 'check failed: ';
/** Windows sharing violations a scanner or writer can hold briefly (CAN-7137). */
const LOCKED_CHECK_REASONS: ReadonlySet<string> = new Set(
  ['EPERM', 'EBUSY', 'EACCES'].map((code) => `${CHECK_FAILED}${code}`),
);

/**
 * The allowlisted errno a `check failed: <ERRNO>` reason names, or else the
 * closed cause; never the reason text, which can name a SID. A failed check
 * keeps its errno only, so its step stays the wrapper's (CAN-7137).
 */
const permissionCheckDetails = (
  result: Extract<PlatformPermissionResult, { readonly reason: string }>,
): CanopyLaunchDetails =>
  result.reason.startsWith(CHECK_FAILED)
    ? canopyLaunchDetails({ errno: result.reason.slice(CHECK_FAILED.length) })
    : result.cause
      ? { privacy: result.cause }
      : {};

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

function e2eCloudAccountEnvironment(
  os: string,
): Readonly<Record<string, string>> {
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const fixture = process.env.CANOPY_E2E_DAEMON_CLOUD_ACCOUNT === '1';
  return {
    ...(fixture ? { CANOPY_E2E_DAEMON_CLOUD_ACCOUNT: '1' } : {}),
    ...(process.env.CANOPY_E2E_CLOUD_BASE_URL
      ? { CANOPY_E2E_CLOUD_BASE_URL: process.env.CANOPY_E2E_CLOUD_BASE_URL }
      : {}),
    ...(fixture &&
    os === 'linux' &&
    bus &&
    bus.length <= 4096 &&
    /^unix:path=\/[a-zA-Z0-9_./%+-]+(?:,guid=[a-fA-F0-9]{32})?$/.test(bus)
      ? { DBUS_SESSION_BUS_ADDRESS: bus }
      : {}),
  };
}

/** A desktop consumer of a daemon stream or lease eviction threw (CAN-7116). */
function reportDaemonListenerError(error: unknown): void {
  reportContainedFailure('core_client.listener', error);
}

let linuxDiagnostics:
  | ReturnType<typeof createDaemonStartDiagnostics>
  | undefined;

/** Trusted main only; also records handoff failures before any spawn. */
export function getLinuxDaemonStartDiagnostics(
  directory?: string,
): ReturnType<typeof createDaemonStartDiagnostics> | undefined {
  if (hostPlatformOperatingSystem() !== 'linux') return undefined;
  if (!linuxDiagnostics) {
    linuxDiagnostics = createDaemonStartDiagnostics({
      directory: directory ?? app.getPath('logs'),
      appVersion: app.getVersion(),
      home: homedir(),
      warn: (facts): void =>
        logMainProcessWarn('Linux background-service start diagnostics', facts),
    });
    // Both before-quit and will-quit are cancellable.
    app.once('quit', disposeLinuxDaemonStartDiagnostics);
  }
  return linuxDiagnostics;
}

export function disposeLinuxDaemonStartDiagnostics(): void {
  linuxDiagnostics?.dispose();
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
  // Import-time startup checks hold their accepted nodes until this sink exists.
  onInternalRootTrusteesAccepted(({ path, role, acceptance }) =>
    reportAcceptedForeignTrustees(path, role, acceptance),
  );
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
  /** The last refusal logged, so each read before a latch adds no line. */
  let loggedRefusal: string | undefined;
  /** CAN-7915: only the data root, `runtime/` and its files admit other accounts. */
  const acceptedPathRole = (
    path: string,
    kind: 'file' | 'directory',
  ): AcceptedPathRole | undefined => {
    if (kind === 'file')
      return dirname(path) === runtimeDirectory ? 'runtime_file' : undefined;
    if (path === dataRoot) return 'data_root';
    return path === runtimeDirectory ? 'runtime' : undefined;
  };
  async function privatePath(
    path: string,
    kind: 'file' | 'directory',
    signal?: AbortSignal,
  ): Promise<void> {
    let details: CanopyLaunchDetails = {};
    const role = acceptedPathRole(path, kind);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await platform.secureFiles.permissions({
        path,
        kind,
        action: kind === 'directory' ? 'restrict' : 'verify',
        mode: 'owner-only',
        foreignTrustees: role ? 'accept' : 'refuse',
      });
      if (result.state === 'private') {
        if (role && result.accepted)
          reportAcceptedForeignTrustees(path, role, result.accepted);
        return;
      }
      if (kind === 'file' && result.reason === 'check failed: ENOENT')
        throw Object.assign(new Error('Core runtime file is absent.'), {
          code: 'ENOENT',
        });
      details = permissionCheckDetails(result);
      // A Windows file lock retries inside the same three attempts, on
      // core-client's shared private-file lock backoff.
      if (
        os === 'win32' &&
        kind === 'file' &&
        LOCKED_CHECK_REASONS.has(result.reason)
      ) {
        if (attempt < 3) await waitForCanopyFileLockRetry(attempt, signal);
        continue;
      }
      if (
        kind !== 'file' ||
        ![
          'path changed while opening',
          'path changed during permission check',
        ].includes(result.reason)
      )
        break;
    }
    // Feedback bundles copy main.log: it gets the path and closed cause, never
    // the reason, which can name a SID (CAN-7917).
    const refusal = `${kind}\0${path}\0${details.privacy ?? ''}`;
    if (refusal !== loggedRefusal) {
      loggedRefusal = refusal;
      logMainProcessWarn('Core runtime permissions are not private', {
        path,
        kind,
        cause: details.privacy ?? 'unknown',
      });
    }
    throw unavailable('Core runtime permissions are not private.', details);
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
    observeSecureStorageTrustees();
    await prepareEndpoint();
    signal.throwIfAborted();
  };
  let secureStorageObserved = false;
  /**
   * Warn-only, once per launch: the daemon's vault checks `secure-storage/`
   * itself and has no local log. Never awaited and never refuses (CAN-7915).
   */
  const observeSecureStorageTrustees = (): void => {
    if (os !== 'win32' || secureStorageObserved) return;
    secureStorageObserved = true;
    const path = resolveSecureDataDir({
      dataRoot,
      environment: process.env,
    }).path;
    void platform.secureFiles
      .permissions({
        path,
        kind: 'directory',
        mode: 'owner-only',
        action: 'verify',
        foreignTrustees: 'accept',
      })
      .then((result) => {
        if (result.state === 'private' && result.accepted)
          reportAcceptedForeignTrustees(
            path,
            'secure_storage',
            result.accepted,
          );
      })
      .catch(() => undefined);
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
  const ownedChildren = createOwnedChildServices({
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
  });
  const diagnostics =
    os === 'linux'
      ? getLinuxDaemonStartDiagnostics(inputs.diagnosticsDirectory)
      : undefined;
  diagnostics?.endpoint({
    endpointSelection:
      address.kind === 'unix-socket' && address.alias ? 'alias' : 'direct',
    socketPathBytes: Buffer.byteLength(address.path),
    bindSiblingBytes: Buffer.byteLength(
      join(dirname(address.path), '.000000000000'),
    ),
  });
  const launch = createCanopyDaemonHostLaunch({
    secureStorageLayout: 'nested-v1',
    ...(migration && { migration }),
    dataRoot,
    runtimeMode,
    executable,
    platform: os,
    supervision: __CANOPY_E2E__
      ? {
          ...platform.supervision,
          // The ordinary child filter deliberately strips product settings.
          // Only this test build may add these non-secret fixture inputs
          // after filtering; neither an upstream key nor the rest of env passes.
          childEnvironment: (request): Readonly<Record<string, string>> => ({
            ...platform.supervision.childEnvironment(request),
            ...e2eCloudAccountEnvironment(os),
          }),
        }
      : platform.supervision,
    ownedChildren: diagnostics
      ? diagnostics.wrap(ownedChildren)
      : ownedChildren,
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
          }).catch((error: unknown): never => {
            // The daemon's own exit-69 refusal, so the notice names the repair
            // command (CAN-7061); other failures stay generic.
            if (error instanceof CanopyEndpointRepairRequiredError)
              throw canopyEndpointRepairRequiredError();
            throw error;
          });
          await protection.assertHeld();
          await beforeSpawn.run(signal, protection);
        },
      },
    }),
    environmentSource: {
      ...getEnhancedEnv({
        includeCanopySecrets: false,
        environment: false,
      }),
    },
    prepareRuntime,
    expectedEndpoint: {
      kind: address.kind === 'unix-socket' ? 'socket' : 'pipe',
      path: address.path,
    },
    verifyPrivateFile: async (path, signal): Promise<void> => {
      signal.throwIfAborted();
      await privatePath(path, 'file', signal);
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
        () =>
          connectCanopyClient({
            onListenerError: reportDaemonListenerError,
            ...options,
            desktopPeerProof: ownerCredential?.peerProof(launch.dataRootHash),
          }),
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
              onListenerError: reportDaemonListenerError,
              ...options,
              ownerProof: (connectionId) =>
                credential.prove(connectionId, launch.dataRootHash),
            }),
        );
      },
    },
  };
}
