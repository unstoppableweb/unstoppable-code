import {
  dataDirectoryOverride,
  isDevelopmentOrTestBuild,
} from '@canopy/core-runtime/node/build-identity';
import {
  createLegacyPatGenerationReader,
  createIntegrationCredentialModule,
} from '@canopy/core-runtime/node/vault';
import {
  acquireW5RootPresence,
  type W5RootPresence,
} from '@canopy/core-platform/w5-root-presence';
import {
  createDaemonVault,
  createGitHubCredentialAuthority,
  createGitHubCredentialFenceStore,
  type GitHubCredentialAuthority,
  type GitHubCredentialIdentity,
  createVaultModule,
  type DaemonVault,
} from '@canopy/core-runtime/node/vault';
import type { PlatformSecretProtectionServices } from '@canopy/core-runtime';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createExecutionProcessServices,
  createPlatformEndpointServices,
  deriveLocalAuthorityIdentity,
  type GitReadSelections,
  hostLocalAuthorityObservation,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  LocalAuthorityIdentityError,
  loadWindowsPipeSecurity,
  windowsPrincipalObserver,
  type LocalAuthorityIdentity,
  type NativeSecretProtectionOwner,
} from '@canopy/core-platform';
import {
  createSupervisedLocalWorker,
  type CanopyDispatcher,
  type CanopyRuntime,
  type PlatformOperatingSystem,
  type PlatformServices,
  type RuntimeModule,
  type RuntimeProfileGraph,
  type RuntimeService,
  type ShutdownReport,
  type WorkerBindingDefinitions,
} from '@canopy/core-runtime';
import {
  composeCanopyControlReplyFits,
  createCanopyOwnerProofVerifier,
  createFilesystemScopeResolver,
  prepareCanopyDaemonRuntimeDirectory,
  type CanopyDaemonHeldClaim,
  publishCanopyDaemon,
  readNativeRootIdentity,
  serveCanopyDaemonControlPlane,
  type CanopyControlConnectionIdentity,
  type CanopyControlStreamSession,
  type CanopyObligationRegistry,
  worktreeFenceKey,
} from '@canopy/core-runtime/node';
import {
  createRecordedWorkerGitHosts,
  createGitHubCredentialLeasePort,
  type GitHubCredentialLeasePort,
  type GitRepositoryReader,
} from '@canopy/core-runtime/node/git';
import {
  CORE_OPERATION_CALLER_GRANTS,
  CORE_OPERATION_OPERATIONS,
  createCoreOperationModule,
  createDaemonOperationService,
  isDaemonOperationLedgerOwner,
} from '@canopy/core-runtime/node/operations/daemon';
import {
  CORE_PIPELINE_DEFINITION_CALLER_GRANTS,
  CORE_PIPELINE_DEFINITION_OPERATIONS,
  createCorePipelineDefinitionModule,
  createDaemonPipelineDefinitionHost,
  isDaemonPipelineDefinitionOwner,
  type DaemonPipelineDefinitionHostOptions,
} from '@canopy/core-runtime/node/pipeline/daemon';
import type { StorageOwnershipRow } from '@canopy/core-runtime/storage';
import { isAgentDaemonHostingRequired } from '@canopy/core-runtime/node/agent/hosting';
import {
  createW5RecordPortModule,
  W5_RECORD_PORT_GRANTS,
  W5_RECORD_PORT_OPERATIONS,
} from '@canopy/core-runtime/node/w5/record-port';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { isW5DaemonHostingRequired } from '@canopy/core-runtime/node/w5/storage-binding';
import { W5CommitLogError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import {
  createW5HostedMetadataModule,
  W5_HOSTED_METADATA_OPERATIONS,
} from '@canopy/core-runtime/node/w5/workspace-metadata/module';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_WORKSPACE_METADATA_GRANTS,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyRuntimeDescriptor,
  MUTATION_FENCE_GRANTS,
} from '@canopy/protocol/canopy-core';
import type { CanopyDaemonArguments } from './arguments';
import {
  awaitingOwnerLogLine,
  createMutationFenceGuard,
  createMutationFenceModule,
  createMutationFenceRegistry,
  daemonWorktreeRootLookup,
} from './mutation-fence';
import type { DaemonFilesystemWatchOptions } from './filesystem-watch';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import type { ExecutionHostShellCommand } from '@canopy/core-platform/execution-host';
import {
  createCanopyDaemonGraph,
  createCanopyDaemonSplitGraph,
  DAEMON_WORKER_MODULES,
  type CanopyDaemonGraphOptions,
  DAEMON_OWNER_PRINCIPAL_ID,
  WORKER_CODE_GRAPH_CALLER_GRANTS,
  WORKER_SCRIPT_CALLER_GRANTS,
  WORKER_PIPELINE_CALLER_GRANTS,
  WORKER_PIPELINE_OWNER_GRANTS,
  WORKER_TERMINAL_CALLER_GRANTS,
} from './bundled-graph';
import {
  daemonCodexMcpLauncher,
  createDaemonExecutionHostPort,
  daemonCodeGraphResourcesDir,
} from './execution-hosts';
import { daemonOwnedChildAddon } from './companion-paths';
import { createDaemonScriptProcessServices } from './script-processes';
import { createDaemonScriptModule } from './scripts';
import { createDaemonTerminalModule } from './terminals';
import { createDaemonPipelineModule } from './pipelines';
import {
  codeGraphGenerationReportFit,
  codeGraphReadReportFit,
  createCodeGraphPreferenceSource,
} from '@canopy/core-runtime/node/code-graph';
import { createDaemonCodeGraphModule } from './code-graph';
import {
  createDaemonExecutionAccounting,
  createDaemonExecutionModule,
  DAEMON_EXECUTION_CALLER_GRANTS,
} from './execution';
import { createClosureGate, type ClosureGate } from './closure-gate';
import {
  createDaemonWakeLock,
  createKeepAwakePreferenceSource,
} from './wake-lock';
import { sealClosure } from './seal-closure';
import { createDaemonTrashServices } from './native-trash';
import {
  createDaemonDirectoryInputs,
  type DaemonDirectoryInputs,
  type DaemonDirectoryInputsOptions,
} from './directory-inputs';
import type { CreateDaemonW5Host, DaemonW5Host } from './w5-host';
import {
  createDaemonWorkerSupervisor,
  daemonWorkerCommand,
  type DaemonWorkerCommand,
  type DaemonWorkerRestartPolicy,
  type DaemonWorkerStatus,
} from './worker-supervisor';
import {
  DAEMON_W5_HOST_SERVICE,
  type DaemonW5HostUnavailableReason,
  unavailableDaemonW5HostService,
} from './w5-host-health';
import { unavailableDaemonAgentHostService } from './agent-host-health';
import { createDaemonOperationLedgerFailures } from './operation-ledger-health';
import { createDaemonExecutionSampleFailures } from './execution-health';

const HEALTH = 'core.runtime.health.get';
// Rides out a launcher briefly holding the startup claim (about 1.5 s in all).
const CLOSE_ATTEMPTS = 5;
const CLOSE_BACKOFF_MS = 100;
// Bounds a code-graph worktree's `git-dir` probe.
const GIT_PROBE_TIMEOUT_MS = 30_000;
// Bounds the hosted repository add's `git-dir` probe.
const REPOSITORY_PROBE_TIMEOUT_MS = 30_000;

/**
 * Every authenticated peer proved the owner-only token, so it is the same OS
 * user. Clients get runtime reads, their own lease, filesystem reads and Git
 * reads (`worker.git.read`, CAN-4729: a same-user peer can already run Git as
 * that user); the control plane serves the reads only while the connection
 * holds its lease. No peer gets `worker.git.write`.
 * Where the daemon serves terminals (CAN-5088), they also get
 * `worker.terminal.read` and `.write`, lease-bound the same way: a same-user
 * peer can already start any process as that user. Where it serves the code
 * graph (CAN-5089), they get `worker.codeGraph.read` and `.write` the same
 * way: a same-user peer can already read and write the graph files. With
 * either they also get `core.execution.read` (CAN-5627, CAN-5690): the
 * daemon's process sample, pressure and family counts, which a same-user
 * peer can already read from the process table.
 * Where it serves scripts (CAN-5087), they get `worker.script.execute` and
 * `.read` the same way: a same-user peer can already start any process as
 * that user, with any environment, and read the run logs under the data
 * root. With scripts alone they also get `core.execution.read`.
 * Where it serves workflows (CAN-5086), they get `worker.pipeline.read` and
 * `.write` the same way: a same-user peer can already run any command as
 * that user, and the daemon runs only launches whose paths lie in the
 * worktree and data roots it serves. No peer gets `worker.pipeline.host`
 * here: only `ownerConnectionCaller` does, for the connection that proved
 * the owner secret (CAN-5771).
 * Where compiled ownership makes the daemon the operation ledger's writer
 * (CAN-5092), they get `core.operation.read` and `.cancel` the same way, as
 * every Electron main client holds them: a same-user peer can already read
 * and write the ledger file. A first read is not read-only: it opens the
 * ledger, runs compaction and reconciles interrupted work. `requestedBy`
 * names the principal, so a cancel cannot yet be attributed to one client.
 * No production build composes it.
 * Where the trusted seam makes the daemon the definitions' writer (CAN-5092
 * S1b), they get `core.pipeline.read` and `.write` the same way, as the
 * desktop window and the CLI hold them: a same-user peer can already read
 * and write the definition files. Never `core.pipeline.ownerRead`. No
 * production build composes it.
 */
function connectionCaller(
  { connectionId, lease }: CanopyControlConnectionIdentity,
  authorityId: string,
  /**
   * W5 qualification host only: W6g's record port, W5e's `core.events` and
   * the `core.workspace.*` metadata commands' `core.workspace.write` (W7a-3).
   * Any same-user peer gets them (tracked debt before W15).
   */
  w5Grants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where this daemon serves terminals (CAN-5088). */
  terminalGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where this daemon serves the code graph (CAN-5089). */
  codeGraphGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where this daemon serves scripts (CAN-5087). */
  scriptGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where this daemon serves workflows (CAN-5086). */
  pipelineGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where this daemon accounts terminal or graph hosts (CAN-5627, CAN-5690). */
  executionGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where compiled ownership makes this daemon the operation ledger's writer (CAN-5092). */
  operationGrants: Readonly<CanopyCallerDescriptor['grants']>,
  /** Where the trusted seam makes this daemon the definitions' writer (CAN-5092). */
  definitionGrants: Readonly<CanopyCallerDescriptor['grants']>,
): CanopyCallerDescriptor {
  return {
    principalId: 'local-user',
    clientInstanceId: lease?.clientInstanceId ?? connectionId,
    authorityId,
    // Informational only; an unleased connection has not declared its kind.
    interfaceKind: lease?.interfaceKind ?? 'daemon',
    grants: [
      'core.runtime.read',
      'core.client.manage',
      // D-V6-3: every token holder gets metadata reads, never vault writes.
      'core.vault.read',
      // q-20: every daemon token holder may save integration credentials.
      'core.integration.write',
      'worker.filesystem.read',
      // CAN-4729: Git reads only, lease-bound like the filesystem reads.
      WORKER_GIT_GRANTS.read,
      ...terminalGrants,
      ...codeGraphGrants,
      ...scriptGrants,
      ...pipelineGrants,
      ...executionGrants,
      ...operationGrants,
      ...definitionGrants,
      ...w5Grants,
    ],
  };
}

/**
 * The daemon owner's caller (CAN-5771): only a connection that proved the
 * owner secret its launcher handed this daemon on stdin. It settles host
 * requests and nothing else, so it holds only runtime reads, its own lease
 * and, where the daemon serves workflows, `worker.pipeline.host`.
 */
function ownerConnectionCaller(
  { connectionId, lease }: CanopyControlConnectionIdentity,
  authorityId: string,
  pipelineOwnerGrants: Readonly<CanopyCallerDescriptor['grants']>,
): CanopyCallerDescriptor {
  return {
    principalId: DAEMON_OWNER_PRINCIPAL_ID,
    clientInstanceId: lease?.clientInstanceId ?? connectionId,
    authorityId,
    interfaceKind: 'desktop',
    grants: [
      'core.runtime.read',
      'core.client.manage',
      // CAN-4730 E2-G: only the proven owner publishes its split-lock fences.
      MUTATION_FENCE_GRANTS.publish,
      ...pipelineOwnerGrants,
    ],
  };
}

function w5Grants(
  w5: DaemonW5Host | undefined,
): Readonly<CanopyCallerDescriptor['grants']> {
  if (!w5) return [];
  // W5e: commit events, and so the metadata commands, exist only when the
  // host composes them.
  return w5.events
    ? [
        ...W5_RECORD_PORT_GRANTS,
        'core.events.read',
        CORE_WORKSPACE_METADATA_GRANTS.write,
      ]
    : W5_RECORD_PORT_GRANTS;
}

/**
 * W6g's record port over the W5 host, then the host's own modules. With W5e
 * events, each caller's commits carry its client instance as `publishedBy`,
 * so that client's own subscriber skips them. The authority's other calls go
 * through the plain view, so a replacement worker that any of them starts
 * publishes what it recovered at once; every view keeps the host's queue.
 * The `core.workspace.*` metadata commands (W7a-3, over W5d1's binding) exist
 * only with events (hosting rule (d)): they commit through the plain view,
 * since no process ran post-commit work for them, so every subscriber, the
 * caller's own included, applies them. No repository selection projection is
 * composed, so a repository add is `capability_unavailable` until a selection
 * mint and redeem service exists.
 */
function daemonW5Modules(
  w5: DaemonW5Host,
  git: GitRepositoryReader,
  os: PlatformOperatingSystem,
): RuntimeModule[] {
  const { events } = w5;
  return [
    createW5RecordPortModule(
      events
        ? {
            host: events.port(),
            portFor: (caller): W5CommitLogHostPort =>
              events.port({ publishedBy: caller.clientInstanceId }),
          }
        : { host: w5.port },
    ),
    ...(events
      ? [
          createW5HostedMetadataModule({
            host: events.port(),
            getReceiptStore: w5.getReceiptStore,
            pathFlavor: os === 'win32' ? 'win32' : 'posix',
            // The worker plane's probe, as Electron's `rev-parse --git-dir`.
            isRepository: (repoPath) =>
              git
                .read({ kind: 'git-dir' }, repoPath, {
                  signal: AbortSignal.timeout(REPOSITORY_PROBE_TIMEOUT_MS),
                  environment: undefined,
                })
                .then(
                  () => true,
                  () => false,
                ),
          }),
        ]
      : []),
    ...(w5.modules ?? []),
  ];
}

export interface StartCanopyDaemonOptions extends CanopyDaemonArguments {
  readonly buildVersion: string;
  /** Trusted qualification composition only; production main never supplies V5 ports. */
  readonly migration?: (
    obligations: CanopyObligationRegistry,
  ) => Promise<CanopyControlStreamSession>;
  /** Trusted build brand, supplied by packaged composition, never a peer. */
  readonly brandId: string;
  /** Resolved by daemon main from its compiled brand and build, never a peer. */
  readonly secureDataRoot: string;
  /** The build brand's managed Cowork folder name; an invalid one refuses startup. */
  readonly coworkManagedDirName: string;
  /**
   * The daemon's own environment, snapshot after the claim marker is consumed.
   * Only the Git read host uses it; a peer never changes it. A peer's
   * per-request `_execution` environment replaces it for that request's
   * `worker.git.*` repository reads only, and is never kept (CAN-5496).
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Extra core services; tests use one to drive health-change events. */
  readonly services?: readonly RuntimeService[];
  /** Test seam for the worker's native watch and attachment lifecycle. */
  readonly filesystemWatch?: DaemonFilesystemWatchOptions;
  /** Test seam for observing the bundled worker binding. */
  readonly createWorkerPair?: CanopyDaemonGraphOptions['createWorkerPair'];
  /** Test seam: decorates the host platform before the closure gate holds it. */
  readonly platformFor?: (platform: PlatformServices) => PlatformServices;
  /** Trusted compatibility seam for injected protection services. */
  readonly secretProtectionFor?: (
    platform: PlatformServices,
    identity: LocalAuthorityIdentity & {
      readonly windowsPrincipalSid?: string;
    },
  ) =>
    | PlatformSecretProtectionServices
    | null
    | Promise<PlatformSecretProtectionServices | null>;
  /** Owns preparation, adapters and submitted native work for this invocation. */
  readonly nativeProtectionFor?: (
    platform: PlatformServices,
    identity: LocalAuthorityIdentity & {
      readonly windowsPrincipalSid?: string;
    },
  ) => NativeSecretProtectionOwner;
  readonly startupSignal?: AbortSignal;
  readonly recordStartupSeal?: (sealed: boolean) => void;
  /** Trusted composition only; CAN-5783 supplies the compiled identity later. */
  readonly githubCredentialIdentity?: GitHubCredentialIdentity;
  readonly legacyPatPaths?: readonly string[];
  /** A1 test seam; A2 supplies the real generation reader, never a peer. */
  readonly githubCredentials?: {
    readonly legacyGeneration?: (
      source: GitHubCredentialIdentity,
    ) => Promise<string | null>;
    readonly seed?: (
      authority: GitHubCredentialAuthority,
      leases: GitHubCredentialLeasePort,
    ) => Promise<void>;
  };
  /** Test seam for the Git read host factory. */
  readonly createGitHost?: DaemonDirectoryInputsOptions['createGitHost'];
  /** Lease-free time before an idle stop; the control plane defaults to 30 s. */
  readonly idleGraceMs?: number;
  /** Windows only: the staged pipe-security addon. Absent or unloadable fails closed. */
  readonly pipeSecurityModule?: string;
  readonly windowsProcessPath?: string;
  /**
   * Windows only: the owned-child addon every execution process tree starts
   * suspended inside a job object with (CAN-5140); defaults to the one staged
   * beside the daemon. Without it Windows execution refuses to start.
   */
  readonly ownedChildAddon?: string;
  /** A trusted launcher's startup claim to adopt; absent means a standalone start. */
  readonly claimHandle?: object;
  /** The owner secret from the launcher's stdin handoff (CAN-5771); copied into the verifier only. */
  readonly ownerSecret?: Uint8Array;
  /** Test seam for the W5 host factory, honored for qualification or activated ownership. */
  readonly createW5Host?: CreateDaemonW5Host;
  /**
   * Trusted test composition only: ownership rows that replace the compiled
   * ones for the operation ledger's gate and its open (CAN-5092). Main never
   * supplies them, so production keeps the compiled rows, which leave the
   * ledger with Electron main, and the default retry window.
   */
  readonly operationLedger?: {
    readonly ownership: readonly StorageOwnershipRow[];
    readonly retryAfterMs?: number;
  };
  /**
   * Trusted test composition only (CAN-5092 S1b): ownership rows that replace
   * the compiled ones for the definitions' gate, and the store's sources,
   * which the daemon does not carry. Main never supplies them, so production
   * keeps the compiled rows, which leave the definitions with Electron main
   * and the CLI, and composes nothing.
   */
  readonly pipelineDefinitions?: {
    readonly ownership: readonly StorageOwnershipRow[];
    readonly sources: DaemonPipelineDefinitionHostOptions['sources'];
    readonly writeReplays?: DaemonPipelineDefinitionHostOptions['writeReplays'];
  };
  /**
   * Trusted test composition only (CAN-6995): ownership rows that replace the
   * compiled ones for the agent host's gate. Main never supplies them, so
   * production keeps the compiled rows, which leave every chat with Electron
   * main.
   */
  readonly agentHost?: {
    readonly ownership: readonly StorageOwnershipRow[];
  };
  /**
   * Serve `worker.terminal.*` from a supervised terminal host (CAN-5088; on
   * Windows CAN-5091), in the bundled composition. `shell` replaces this
   * executable's entry mode, for a source run.
   */
  readonly terminals?: { readonly shell?: ExecutionHostShellCommand };
  /**
   * Serve `worker.codeGraph.*` from budgeted graph hosts (CAN-5089; on Windows
   * CAN-5091), in the bundled composition. `shell` replaces this
   * executable's entry mode and `resourcesDir` its staged graph runtime, for
   * a source run.
   */
  readonly codeGraph?: {
    readonly shell?: ExecutionHostShellCommand;
    readonly resourcesDir?: string;
  };
  /** Serve worker.script.* in this process (CAN-5087; on Windows CAN-5091), in the bundled composition. */
  readonly scripts?: boolean;
  /** Serve worker.pipeline.* from a supervised pipeline host (CAN-5086; on Windows CAN-5091). */
  readonly pipelines?: {
    readonly shell?: ExecutionHostShellCommand;
    /** Test seam for automatic launcher-root propagation without an explicit override. */
    readonly dataDirectoryOverrides?: boolean;
  };
  /** Split only: how to relaunch this daemon as its worker; defaults to itself. */
  readonly workerCommand?: DaemonWorkerCommand;
  /** Split only: test seam for the worker restart budget. */
  readonly workerRestart?: DaemonWorkerRestartPolicy;
}

export interface RunningCanopyDaemon {
  readonly descriptor: CanopyRuntimeDescriptor;
  readonly runtime: CanopyRuntime<CanopyDispatcher>;
  /**
   * Resolves with the reason when the control plane asks for a stop: `idle`
   * once the idle grace elapses, `accept loop failed` once no new client can
   * connect (CAN-7116).
   */
  readonly idle: Promise<string>;
  /**
   * Kernel phases 1–7, then endpoint close and descriptor removal. Concurrent
   * calls share one attempt; after a rejection a later call retries.
   */
  stop(reason: string): Promise<ShutdownReport>;
  /**
   * Ends every creation-capable owner: stops the Git read host unless phase 5
   * did, then refuses identity and permission helpers. Idempotent, bounded,
   * and never rejects; `false` means closure is unconfirmed.
   */
  seal(): Promise<boolean>;
  /** The Gits the daemon ran `check-ignore` with, for the Git receipt. */
  gitSelections(): GitReadSelections;
  /** Split only: the supervised worker's state; absent when bundled. */
  readonly worker?: () => DaemonWorkerStatus;
}

/** Every operation the split core routes to its worker, as the worker declares them. */
function daemonWorkerDefinitions(): WorkerBindingDefinitions {
  const definitions: WorkerBindingDefinitions = {
    queries: {},
    instructions: {},
    streams: {},
  };
  for (const module of DAEMON_WORKER_MODULES) {
    Object.assign(definitions.queries, module.definitions.queries);
    Object.assign(definitions.instructions, module.definitions.instructions);
    Object.assign(definitions.streams, module.definitions.streams);
  }
  return definitions;
}

const uncertainRootPresence = new Set<W5RootPresence>();

const NO_GIT_SELECTIONS: GitReadSelections = Object.freeze({
  selections: Object.freeze([]),
  overflow: false,
});

/**
 * Activated ownership hosts W5 except in manual split-worker qualification.
 * The flag retains the legacy qualification composition until activation.
 */
async function selectW5Host(
  options: StartCanopyDaemonOptions,
): Promise<CreateDaemonW5Host | undefined> {
  if (options.splitWorker) return undefined;
  if (options.w5Host !== true && !isW5DaemonHostingRequired()) return undefined;
  if (options.createW5Host) return options.createW5Host;
  const { createDaemonW5Host } = await import('./w5-host');
  return createDaemonW5Host;
}

/**
 * The ownership rows that let this daemon serve `core.operation.*`, or
 * undefined: compiled ownership, never a runtime opt-in, as for W5. The
 * compiled rows keep `operation_ledger` legacy, so production composes
 * nothing and never touches the ledger path. Split mode serves none.
 */
function selectOperationLedger(options: StartCanopyDaemonOptions):
  | {
      readonly ownership?: readonly StorageOwnershipRow[];
      readonly retryAfterMs?: number;
    }
  | undefined {
  if (options.splitWorker) return undefined;
  const ownership = options.operationLedger?.ownership;
  if (!isDaemonOperationLedgerOwner(ownership)) return undefined;
  const retryAfterMs = options.operationLedger?.retryAfterMs;
  return {
    ...(ownership && { ownership }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

/**
 * What lets this daemon serve `core.pipeline.definition.*`, or undefined:
 * compiled ownership, never a runtime opt-in, and sources only a trusted
 * composition supplies. The compiled rows keep pipeline_definitions legacy,
 * so production composes nothing and never touches the store or its replay
 * receipts. Split mode serves none.
 */
function selectPipelineDefinitions(
  options: StartCanopyDaemonOptions,
): StartCanopyDaemonOptions['pipelineDefinitions'] {
  if (options.splitWorker) return undefined;
  const seam = options.pipelineDefinitions;
  if (!seam || !isDaemonPipelineDefinitionOwner(seam.ownership))
    return undefined;
  return seam;
}

/**
 * Whether the ownership rows hand this daemon the agent host: compiled
 * ownership, never a runtime opt-in, as for W5. The compiled rows keep every
 * agent namespace with Electron main, so production selects nothing. Split
 * mode hosts none.
 */
function selectAgentHost(options: StartCanopyDaemonOptions): boolean {
  if (options.splitWorker) return false;
  return isAgentDaemonHostingRequired(options.agentHost?.ownership);
}

/**
 * The eager open, under the startup claim and before the graph. Only a log
 * another process holds (`WRITER_UNAVAILABLE`, such as an older desktop's
 * in-process host or a backup) degrades the daemon, once that host's worker
 * has exited; every other open failure refuses startup, fail-closed. A
 * maintenance-held root never gets here: maintenance holds the startup claim
 * for its whole run, so the claim refuses first, with or without the flag.
 * A maintenance record without the claim is the host cohort's (CAN-3795 B7).
 */
async function openW5Host(
  w5: DaemonW5Host,
): Promise<DaemonW5HostUnavailableReason | undefined> {
  try {
    await w5.open();
    return undefined;
  } catch (error) {
    if (
      error instanceof W5CommitLogError &&
      error.code === 'WRITER_UNAVAILABLE' &&
      (await w5Exited(w5))
    )
      return 'writer_unavailable';
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        `Service ${DAEMON_W5_HOST_SERVICE} failed to start: ${message}`,
      ),
      { cause: error },
    );
  }
}

/** Disposes the core-owned vault before sealing the platform closure gate. */
export function sealDaemonClosure(
  gate: ClosureGate,
  directory: DaemonDirectoryInputs | undefined,
  w5?: DaemonW5Host,
  vault?: DaemonVault,
  native?: NativeSecretProtectionOwner,
): Promise<boolean> {
  native?.closeAdmission();
  return sealClosure(gate, directory, w5, async (signal) => {
    const disposal = vault?.dispose();
    const drained = native?.drain(signal) ?? Promise.resolve(true);
    const [, confirmed] = await Promise.all([disposal, drained]);
    return confirmed;
  });
}

/** Stops the W5 host, if any; whether no W5 worker can still hold the log. */
async function w5Exited(w5: DaemonW5Host | undefined): Promise<boolean> {
  if (!w5) return true;
  return (await w5.stop().catch(() => 'unconfirmed')) === 'stopped';
}

/** Composes the host platform, startup claim, bundled graph, and publication. */
export async function startCanopyDaemon(
  options: StartCanopyDaemonOptions,
): Promise<RunningCanopyDaemon> {
  const signal = options.startupSignal;
  let cancel = (): Promise<boolean> => Promise.resolve(false);
  let rejectStop: (error: Error) => void = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const onAbort = (): void => {
    void cancel().then((sealed) => {
      options.recordStartupSeal?.(sealed);
      rejectStop(new Error('Daemon startup stopped.'));
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const starting = startOwnedDaemon(options, (cleanup) => {
    cancel = cleanup;
  });
  if (signal?.aborted) onAbort();
  try {
    return await Promise.race([starting, stopped]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function startOwnedDaemon(
  options: StartCanopyDaemonOptions,
  ownCancellation: (cleanup: () => Promise<boolean>) => void,
): Promise<RunningCanopyDaemon> {
  let startupComplete = false;
  let publicationAdmitted = false;
  let startupExpired = false;
  const publicationLifetime = new AbortController();
  const checkStartup = (): void => {
    if ((!startupComplete && !publicationAdmitted) || startupExpired)
      options.startupSignal?.throwIfAborted();
  };
  checkStartup();
  // First: a W5 host that fails to load starts no helper and writes nothing.
  const createW5Host = await selectW5Host(options);
  checkStartup();
  // The endpoint family verifies claims the port below issues.
  const claimPort: { current?: CanopyStartupClaimPort } = {};
  const os = hostPlatformOperatingSystem();
  // Windows execution trees start suspended inside their job object, and the
  // wake lock sets the thread execution state, through this addon (CAN-5140,
  // CAN-5091).
  const nativePath =
    os === 'win32'
      ? (options.ownedChildAddon ?? daemonOwnedChildAddon(os))
      : undefined;
  // Windows split mode is out of CAN-5091; the parser already refuses W5 with it.
  if (options.splitWorker && (os === 'win32' || createW5Host))
    throw new Error('Split worker unavailable.');
  const decorate =
    options.platformFor ?? ((raw: PlatformServices): PlatformServices => raw);
  const gate = createClosureGate(
    decorate(
      hostPlatformServices(
        createPlatformEndpointServices(os, {
          validateStartupClaim: (claim) =>
            claimPort.current?.verify(claim) ?? Promise.resolve(false),
          // Loaded before anything else so a missing resource fails closed early.
          ...(os === 'win32' && {
            namedPipeSecurity: loadWindowsPipeSecurity(
              options.pipeSecurityModule ?? '',
            ),
          }),
        }),
        {
          windowsProcessPath: options.windowsProcessPath,
          ...(nativePath !== undefined && { ownedChildPath: nativePath }),
          trash: createDaemonTrashServices(os),
        },
      ),
    ),
    // The same selected helper as process inspection; absent refuses authority.
    os === 'win32' && options.windowsProcessPath
      ? {
          windowsPrincipal: windowsPrincipalObserver(
            options.windowsProcessPath,
          ),
        }
      : {},
  );
  const { platform } = gate;
  // Before any helper or undo step, and before a W5 start adopts the claim to
  // publish under as held, which publication accepts on a pipe.
  if (
    options.claimHandle !== undefined &&
    platform.endpoints.semantics === 'first-instance-pipe'
  )
    throw new Error('Windows launcher claim unsupported.');
  let vault: DaemonVault | undefined;
  let native: NativeSecretProtectionOwner | undefined;
  let directory: DaemonDirectoryInputs | undefined;
  let w5: DaemonW5Host | undefined;
  let rootPresence: W5RootPresence | undefined;
  let w5Unavailable: DaemonW5HostUnavailableReason | undefined;
  // W5e: the runtime and the W5 commit journal issue cursors in one epoch.
  let daemonEpoch: string | undefined;
  // Q8(a): the startup claim a W5 start holds from before the W5 host exists
  // until publication succeeds, or until a failed start's W5 worker exits.
  let held: CanopyDaemonHeldClaim | undefined;
  // Publication releases the held claim only once the endpoint is bound; the
  // endpoint then protects the root until the daemon withdraws it.
  const endpoint = { withdrawn: false };
  let sealing: Promise<boolean> | undefined;
  let startupFailed = false;
  let cancellingStartup = false;
  let stopAfterStartup: (() => Promise<ShutdownReport>) | undefined;
  let startupQuiet = (): void => undefined;
  const quiet = new Promise<void>((resolve) => {
    startupQuiet = resolve;
  });
  const undo: (() => Promise<unknown>)[] = [];
  let startupRollback: Promise<void> | undefined;
  const rollbackStartup = (): Promise<void> =>
    (startupRollback ??= (async (): Promise<void> => {
      for (const step of undo)
        await Promise.resolve()
          .then(step)
          .catch(() => undefined);
      if (held && !held.released && (await w5Exited(w5))) {
        await claimPort.current?.release(held.current).catch(() => undefined);
        held.released = true;
      }
    })());
  const seal = (): Promise<boolean> => {
    native?.closeAdmission();
    // Abort opening synchronously; disposal keeps submitted initialization alive.
    void vault?.dispose();
    return (sealing ??= sealClosure(gate, directory, w5, async (signal) => {
      signal.addEventListener('abort', () => publicationLifetime.abort(), {
        once: true,
      });
      const drained = native?.drain(signal) ?? Promise.resolve(true);
      await quiet;
      if (startupFailed) await rollbackStartup();
      else if (cancellingStartup) await stopAfterStartup?.();
      native?.closeAdmission();
      const disposal = vault?.dispose();
      const [, confirmed] = await Promise.all([disposal, drained]);
      return confirmed;
    }).then((confirmed) => {
      if (!confirmed) {
        startupExpired = true;
        publicationLifetime.abort();
      }
      return confirmed;
    }));
  };
  ownCancellation(() => {
    cancellingStartup = true;
    endpoint.withdrawn = true;
    return seal();
  });

  try {
    // On Windows the gated principal is the first helper the daemon starts.
    let principal: Promise<string> | undefined;
    const observePrincipal = gate.windowsPrincipal;
    const windowsPrincipal =
      observePrincipal &&
      ((): Promise<string> => (principal ??= observePrincipal()));
    const { authorityId, canonicalDataRoot } =
      await deriveLocalAuthorityIdentity(
        { brandId: options.brandId, dataRoot: options.dataRoot },
        hostLocalAuthorityObservation(windowsPrincipal),
      );
    checkStartup();
    if (canonicalDataRoot !== options.dataRoot)
      throw new LocalAuthorityIdentityError('invalid_root');
    checkStartup();
    const resolveScope = await createFilesystemScopeResolver({
      canonicalDataRoot,
      authorityId,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      coworkManagedDirName: options.coworkManagedDirName,
      paths: { join, resolve, isAbsolute, sep, basename },
      rootIdentity: readNativeRootIdentity,
    });
    // CAN-4730 E2-G: one fence key per worktree, checked on the core before
    // any write reaches a bundled or split worker.
    const lookupWorktreeRoot = daemonWorktreeRootLookup(resolveScope);
    const mutationFence = createMutationFenceRegistry(
      (target) =>
        worktreeFenceKey(
          target.workspaceId,
          target.worktreeId,
          lookupWorktreeRoot,
        ),
      {
        // No native UI in the daemon: a lost owner shows in the log.
        onAwaitingOwnerOverdue: (waitedMs) =>
          process.stderr.write(awaitingOwnerLogLine('overdue', waitedMs)),
        onAwaitingOwnerRecovered: (waitedMs) =>
          process.stderr.write(awaitingOwnerLogLine('recovered', waitedMs)),
      },
    );
    const mutationFenceGuard = createMutationFenceGuard({
      registry: mutationFence,
      lookupWorktreeRoot,
    });
    const mutationFenceModule = createMutationFenceModule(mutationFence);
    checkStartup();
    await prepareCanopyDaemonRuntimeDirectory(canonicalDataRoot, platform);
    checkStartup();
    rootPresence = await acquireW5RootPresence(
      canonicalDataRoot,
      'host',
      'daemon',
      () => platform.supervision.inspectProcess({ pid: process.pid }),
    );
    checkStartup();
    const identityContext = {
      authorityId,
      canonicalDataRoot,
      ...(windowsPrincipal && {
        windowsPrincipalSid: await windowsPrincipal(),
      }),
    };
    checkStartup();
    native = options.nativeProtectionFor?.(platform, identityContext);
    const slots = native
      ? await native.services
      : ((await options.secretProtectionFor?.(platform, identityContext)) ??
        null);
    const loadFailure = native ? await native.failure : null;
    checkStartup();
    vault = createDaemonVault({
      secureDataRoot: options.secureDataRoot,
      platform,
      slots,
      loadFailure,
    });
    const ownedVault = vault;
    const credentialIdentity = options.githubCredentialIdentity ?? {
      brandId: options.brandId,
      build: '',
    };
    const legacyGeneration =
      options.githubCredentials?.legacyGeneration ??
      createLegacyPatGenerationReader({
        identity: credentialIdentity,
        paths: options.legacyPatPaths ?? [],
      });
    const githubCredentials = createGitHubCredentialAuthority({
      identity: credentialIdentity,
      repository: () => ownedVault.repository(),
      probeKeyIfDue: () => ownedVault.probeKeyIfDue(),
      writer: () => ownedVault.writer('github-pat'),
      fences: createGitHubCredentialFenceStore({
        secureDataRoot: options.secureDataRoot,
        secureFiles: platform.secureFiles,
      }),
      legacyGeneration,
    });
    const githubLeases = createGitHubCredentialLeasePort({
      source: githubCredentials,
      signal: ownedVault.signal,
    });
    await options.githubCredentials?.seed?.(githubCredentials, githubLeases);
    checkStartup();
    const vaultModule = createVaultModule(vault);
    const credentialsModule = createIntegrationCredentialModule({
      authority: githubCredentials,
      identity: credentialIdentity,
      legacyGeneration,
    });
    const hostCaller: CanopyCallerDescriptor = {
      principalId: 'core',
      clientInstanceId: 'daemon-host',
      authorityId,
      interfaceKind: 'daemon',
      grants: ['core.runtime.read'],
    };
    const self = await platform.supervision.inspectProcess({
      pid: process.pid,
    });
    checkStartup();
    if (self.state !== 'running')
      throw new Error('Daemon process identity is unverifiable.');
    const { startIdentity } = self;
    const claims = createCanopyStartupClaimPort({
      dataRoot: options.dataRoot,
      owner: { pid: process.pid, startIdentity },
      inspectProcess: async (pid, signal) => {
        const found = await platform.supervision.inspectProcess({
          pid,
          signal,
        });
        if (found.state === 'running')
          return { kind: 'alive', startIdentity: found.startIdentity };
        return { kind: found.state === 'absent' ? 'dead' : 'unknown' };
      },
    });
    claimPort.current = claims;

    // Q8(a): a W5 writer exists only under the startup claim, acquired or
    // adopted here, before the graph, and handed to publication as held.
    if (createW5Host) {
      checkStartup();
      await prepareCanopyDaemonRuntimeDirectory(canonicalDataRoot, platform);
      checkStartup();
      const startup = options.claimHandle
        ? await claims.adopt(options.claimHandle)
        : await claims.tryAcquire(undefined, {
            recoverDeparted:
              platform.endpoints.semantics === 'filesystem-socket',
          });
      if (startup.kind !== 'acquired')
        throw new Error('Startup claim unavailable.');
      const claim: CanopyDaemonHeldClaim = {
        current: startup.handle,
        released: false,
        ...(startup.recovered && { recovered: startup.recovered }),
      };
      held = claim;
      checkStartup();
      daemonEpoch = `runtime:${randomUUID()}`;
      const endpointProtects = (): boolean =>
        claim.released && !endpoint.withdrawn;
      checkStartup();
      w5 = createW5Host({
        canonicalDataRoot,
        os: platform.os,
        daemonEpoch,
        // Every worker start, including a relaunch, needs live protection.
        // Rechecked after the claim check: publication may release it then.
        admission: async () => {
          checkStartup();
          if (endpointProtects()) return;
          const claimHeld =
            !claim.released && (await claims.identity(claim.current));
          checkStartup();
          if (claimHeld || endpointProtects()) return;
          throw new Error('W5 host protection lapsed.');
        },
      });
      w5Unavailable = await openW5Host(w5);
      // Degraded: no W5 host, so no record port, events or their grants.
      if (w5Unavailable) w5 = undefined;
    }

    checkStartup();
    let runtime: RuntimeProfileGraph;
    let worker: (() => DaemonWorkerStatus) | undefined;
    // CAN-5088: the bundled composition's terminals; split serves none yet.
    let terminals: ReturnType<typeof createDaemonTerminalModule> | undefined;
    // CAN-5089: the bundled composition's code graph; split serves none yet.
    let codeGraph: RuntimeModule | undefined;
    // CAN-5087: the bundled composition's scripts; split serves none yet.
    let scripts: RuntimeModule | undefined;
    // CAN-5086: the bundled composition's workflows; split serves none yet.
    let pipelines: RuntimeModule | undefined;
    const pipelineObligations: {
      current?: Pick<CanopyObligationRegistry, 'hold'>;
    } = {};
    let execution: RuntimeModule | undefined;
    // CAN-5092: only where compiled ownership makes the daemon its writer.
    let operations: RuntimeModule | undefined;
    // CAN-5092 S1b: only where the trusted seam makes the daemon the writer.
    let pipelineDefinitions: RuntimeModule | undefined;
    const identity = { runtimeId: randomUUID(), hostId: 'local', authorityId };
    const services = [
      ...(options.services ?? []),
      ...(w5Unavailable ? [unavailableDaemonW5HostService(w5Unavailable)] : []),
      // CAN-6995: no build composes the agent host yet, so a selection is degraded.
      ...(selectAgentHost(options)
        ? [unavailableDaemonAgentHostService('not_composed')]
        : []),
    ];
    if (options.splitWorker) {
      // The worker binds its private endpoint here, beside the daemon's own.
      checkStartup();
      await prepareCanopyDaemonRuntimeDirectory(canonicalDataRoot, platform);
      checkStartup();
      const definitions = daemonWorkerDefinitions();
      const route = createSupervisedLocalWorker({ definitions });
      const supervisor = createDaemonWorkerSupervisor({
        services: createExecutionProcessServices({ os }),
        command: options.workerCommand ?? daemonWorkerCommand(),
        dataRoot: canonicalDataRoot,
        runtimeMode: options.runtimeMode,
        authorityId,
        coworkManagedDirName: options.coworkManagedDirName,
        environment: options.environment,
        endpoints: platform.endpoints,
        worker: route,
        definitions,
        ...(options.workerRestart && { restart: options.workerRestart }),
      });
      worker = (): DaemonWorkerStatus => supervisor.status();
      runtime = createCanopyDaemonSplitGraph({
        identity,
        worker: route,
        vault: vaultModule,
        credentials: credentialsModule,
        mutationFence: mutationFenceModule,
        instructionGuard: mutationFenceGuard,
        services: [...services, supervisor.service],
      });
    } else {
      const inputs = createDaemonDirectoryInputs({
        os,
        githubLeases,
        canonicalDataRoot,
        environment: options.environment,
        ...(options.createGitHost && { createGitHost: options.createGitHost }),
      });
      directory = inputs;
      // Terminal, graph and pipeline hosts and script processes hold
      // execution leases (CAN-5627, CAN-5690, CAN-5087, CAN-5086), which
      // clients read through `core.execution.status.*`.
      // Running workflows keep the computer awake while the desktop's
      // keep-awake preference is on (CAN-5872).
      const wakeLock = options.pipelines
        ? createDaemonWakeLock({
            os,
            power: platform.power,
            preference: createKeepAwakePreferenceSource({ canonicalDataRoot }),
          })
        : undefined;
      const executionServices = (): ReturnType<
        typeof createExecutionProcessServices
      > =>
        createExecutionProcessServices({
          os,
          ...(nativePath !== undefined && { nativePath }),
        });
      const sampleFailures = createDaemonExecutionSampleFailures();
      const accounting =
        options.terminals ||
        options.codeGraph ||
        options.scripts ||
        options.pipelines
          ? createDaemonExecutionAccounting({
              supervision: platform.supervision,
              ...(wakeLock && { wakeLock }),
              onSampleFailure: sampleFailures.record,
            })
          : undefined;
      if (accounting)
        execution = createDaemonExecutionModule(accounting, {
          ...(wakeLock && { wakeLock }),
          health: sampleFailures.health,
        });
      if (options.terminals) {
        const processes = executionServices();
        terminals = createDaemonTerminalModule({
          accounting,
          hosts: createDaemonExecutionHostPort({
            services: processes,
            cwd: canonicalDataRoot,
            environment: () => options.environment,
            ...(options.terminals.shell && { shell: options.terminals.shell }),
          }),
          shutdown: () => processes.shutdown(),
          resolveScope,
        });
      }
      if (options.codeGraph) {
        const processes = executionServices();
        codeGraph = await createDaemonCodeGraphModule({
          accounting,
          hosts: createDaemonExecutionHostPort({
            services: processes,
            cwd: canonicalDataRoot,
            environment: () => options.environment,
            ...(options.codeGraph.shell && { shell: options.codeGraph.shell }),
          }),
          shutdown: () => processes.shutdown(),
          resolveScope,
          dataRoot: canonicalDataRoot,
          resourcesDir:
            options.codeGraph.resourcesDir ?? daemonCodeGraphResourcesDir(),
          gitExecutable: (signal) => inputs.selectGitExecutable(signal),
          isGitRepo: async (directory) => {
            try {
              await inputs.git.read({ kind: 'git-dir' }, directory, {
                signal: AbortSignal.timeout(GIT_PROBE_TIMEOUT_MS),
                environment: undefined,
              });
              return true;
            } catch {
              return false;
            }
          },
          canonicalRepoRoot: async (configured, signal) => {
            try {
              const commonDir = (
                await inputs.git.read({ kind: 'common-dir' }, configured, {
                  signal,
                  environment: undefined,
                })
              ).trim();
              if (commonDir === '') return configured;
              const resolved = isAbsolute(commonDir)
                ? commonDir
                : join(configured, commonDir);
              return dirname(
                resolved.replace(/[/\\]worktrees[/\\][^/\\]+$/, ''),
              );
            } catch {
              return configured;
            }
          },
          preferences: createCodeGraphPreferenceSource({
            canonicalDataRoot,
            paths: { join, isAbsolute },
          }),
        });
      }
      checkStartup();
      const operationLedger = selectOperationLedger(options);
      if (operationLedger) {
        const failures = createDaemonOperationLedgerFailures();
        operations = createCoreOperationModule(
          createDaemonOperationService({
            dataRoot: canonicalDataRoot,
            ...operationLedger,
            onError: failures.record,
          }),
          { health: failures.health },
        );
      }
      const definitions = selectPipelineDefinitions(options);
      if (definitions)
        pipelineDefinitions = createCorePipelineDefinitionModule(
          createDaemonPipelineDefinitionHost({
            dataRoot: canonicalDataRoot,
            authorityId,
            flushDirectory: (folder) => flushDirectory(folder, { os }),
            ...definitions,
          }),
        );
      if (options.scripts)
        scripts = createDaemonScriptModule({
          os,
          authorityId,
          canonicalDataRoot,
          environment: options.environment,
          resolveScope,
          processes: createDaemonScriptProcessServices(os, nativePath),
          supervision: platform.supervision,
          accounting,
        });
      if (options.pipelines) {
        const processes = executionServices();
        pipelines = createDaemonPipelineModule({
          accounting,
          hosts: createDaemonExecutionHostPort({
            services: processes,
            cwd: canonicalDataRoot,
            // Explicit overrides follow the launcher's canonical root in every
            // build. Without one, release hosts retain their default routing.
            environment: () => {
              const automaticRootPropagation =
                options.pipelines?.dataDirectoryOverrides ??
                isDevelopmentOrTestBuild();
              const explicitDataRoot = dataDirectoryOverride(
                options.environment,
                'CANOPY_DATA_DIR',
              );
              return {
                ...options.environment,
                ...((automaticRootPropagation || explicitDataRoot) && {
                  CANOPY_DATA_DIR: canonicalDataRoot,
                }),
              };
            },
            ...(options.pipelines.shell && { shell: options.pipelines.shell }),
          }),
          shutdown: () => processes.shutdown(),
          resolveScope,
          dataRoot: canonicalDataRoot,
          codexMcpLauncher: daemonCodexMcpLauncher(options.pipelines.shell),
          obligations: pipelineObligations,
        });
      }
      runtime = await createCanopyDaemonGraph({
        identity,
        vault: vaultModule,
        credentials: credentialsModule,
        mutationFence: mutationFenceModule,
        instructionGuard: mutationFenceGuard,
        filesystem: {
          os,
          ...(platform.trash && { trash: platform.trash }),
          resolveScope,
          directoryInputs: inputs.directoryInputs,
          watch: options.filesystemWatch,
          services: inputs.services,
        },
        git: createRecordedWorkerGitHosts({
          dataRoot: canonicalDataRoot,
          authorityId,
          recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
          os,
          arch: process.arch,
          git: inputs.git,
          writes: inputs.writes,
        }),
        services,
        ...(w5 && {
          w5: {
            services: [w5.service],
            modules: daemonW5Modules(w5, inputs.git, os),
          },
          daemonEpoch,
        }),
        ...(options.createWorkerPair && {
          createWorkerPair: options.createWorkerPair,
        }),
        ...(terminals && { terminals }),
        ...(codeGraph && { codeGraph }),
        ...(scripts && { scripts }),
        ...(pipelines && { pipelines }),
        ...(execution && { execution }),
        ...(operations && { operations }),
        ...(pipelineDefinitions && { pipelineDefinitions }),
      });
    }
    undo.push(() => runtime.shutdown('startup failed'));
    checkStartup();
    await runtime.start(options.startupSignal);
    checkStartup();
    const health = CORE_TRANSPORT_QUERY_DEFINITIONS[HEALTH].result.parse(
      await runtime.dispatcher.query(HEALTH, {}, { caller: hostCaller }),
    );
    const versions = health.runtime.protocolVersions;
    checkStartup();
    const publication = await publishCanopyDaemon({
      signal: options.startupSignal,
      admitPublication: () => {
        checkStartup();
        publicationAdmitted = true;
        return publicationLifetime.signal;
      },
      dataRoot: options.dataRoot,
      runtimeMode: options.runtimeMode,
      platform,
      claims,
      ...(held
        ? { heldClaim: held }
        : options.claimHandle && { claimHandle: options.claimHandle }),
      pid: process.pid,
      startIdentity,
      buildVersion: options.buildVersion,
      protocolRange: { min: Math.min(...versions), max: Math.max(...versions) },
    });

    // publication.close() needs the startup claim and stays retryable when it is held.
    const closePublication = async (): Promise<void> => {
      endpoint.withdrawn = true;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await publication.close();
          return;
        } catch (error) {
          if (attempt === CLOSE_ATTEMPTS) throw error;
          await delay(CLOSE_BACKOFF_MS * attempt);
        }
      }
    };
    // The endpoint keeps protecting the root while a W5 worker may run.
    undo.push(async () => {
      if (!(await w5Exited(w5))) return;
      await closePublication();
    });
    checkStartup();
    let requestStop: (reason: string) => void = () => undefined;
    const idle = new Promise<string>((resolve) => {
      requestStop = resolve;
    });
    const ownerProof = options.ownerSecret
      ? createCanopyOwnerProofVerifier({
          secret: options.ownerSecret,
          dataRootHash: publication.auth.dataRootHash,
        })
      : undefined;
    undo.push(() => Promise.resolve(ownerProof?.dispose()));
    const controlPlane = serveCanopyDaemonControlPlane({
      binding: publication,
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
      callerFor: (identity) =>
        identity.owner
          ? ownerConnectionCaller(
              identity,
              authorityId,
              pipelines ? WORKER_PIPELINE_OWNER_GRANTS : [],
            )
          : connectionCaller(
              identity,
              authorityId,
              w5Grants(w5),
              terminals ? WORKER_TERMINAL_CALLER_GRANTS : [],
              codeGraph ? WORKER_CODE_GRAPH_CALLER_GRANTS : [],
              scripts ? WORKER_SCRIPT_CALLER_GRANTS : [],
              pipelines ? WORKER_PIPELINE_CALLER_GRANTS : [],
              execution ? DAEMON_EXECUTION_CALLER_GRANTS : [],
              operations ? CORE_OPERATION_CALLER_GRANTS : [],
              pipelineDefinitions ? CORE_PIPELINE_DEFINITION_CALLER_GRANTS : [],
            ),
      ...(ownerProof && { ownerProof }),
      // Generation and read reports reach only clients that decode them
      // (CAN-5627, CAN-5691).
      fitReply: composeCanopyControlReplyFits(
        codeGraphGenerationReportFit,
        codeGraphReadReportFit,
      ),
      // The bundled worker sees one fixed trusted caller, so the interface
      // lease is enforced here, at the outer boundary, for every worker read.
      // The W5 record port (W6g), the metadata commands and, where served,
      // the operation records and the workflow definitions (CAN-5092) are
      // bound to a lease too.
      leaseBoundOperations: runtime.operations
        .filter(
          ({ plane, name }) =>
            plane === 'worker' ||
            W5_RECORD_PORT_OPERATIONS.includes(name) ||
            W5_HOSTED_METADATA_OPERATIONS.includes(name) ||
            CORE_OPERATION_OPERATIONS.includes(name) ||
            // CAN-4730 E2-G: each fence set belongs to its publishing lease.
            Object.prototype.hasOwnProperty.call(
              CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
              name,
            ) ||
            CORE_PIPELINE_DEFINITION_OPERATIONS.includes(name),
        )
        .map(({ name }) => name),
      // W5 receipts name the principal (DM-5 #4). Entry outcome replay still
      // needs CAN-4733 before E2; q-22(d) requires the same-key directive now.
      sameKeyFencedOperations: runtime.operations
        .filter(
          ({ name }) =>
            W5_HOSTED_METADATA_OPERATIONS.includes(name) ||
            Object.prototype.hasOwnProperty.call(
              WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
              name,
            ),
        )
        .map(({ name }) => name),
      buildVersion: options.buildVersion,
      idleGrace: { graceMs: options.idleGraceMs },
      onIdle: () => requestStop('idle'),
      onAcceptFailed: () => requestStop('accept loop failed'),
    });
    pipelineObligations.current = controlPlane.obligations;
    let migration: CanopyControlStreamSession | undefined;
    undo.push(() => controlPlane.close());
    // An ended owner lease keeps its fences until a live owner publishes;
    // only the lease that published a set ends it.
    const offFenceOwners = controlPlane.leases.onEnd((lease) =>
      mutationFence.ownerLeaseEnded(lease.leaseId),
    );
    undo.push(() => Promise.resolve(offFenceOwners()));
    if (options.migration) {
      migration = await options.migration(controlPlane.obligations);
      undo.push(() => migration?.close() ?? Promise.resolve());
    }
    let stopping: Promise<ShutdownReport> | undefined;
    const stop = async (reason: string): Promise<ShutdownReport> => {
      native?.closeAdmission();
      await migration?.close();
      const report = await runtime.shutdown(reason);
      await controlPlane.close();
      // Phase 7 stopped W5; until its worker exits the endpoint stays.
      if (!(await w5Exited(w5)))
        throw new Error('The W5 commit log worker has not exited.');
      await closePublication();
      rootPresence?.close();
      return report;
    };
    const running: RunningCanopyDaemon = {
      descriptor: publication.descriptor,
      runtime,
      idle,
      stop: (reason) =>
        (stopping ??= stop(reason).catch((error: unknown) => {
          stopping = undefined;
          throw error;
        })),
      seal,
      gitSelections: () => directory?.gitSelections() ?? NO_GIT_SELECTIONS,
      ...(worker && { worker }),
    };
    stopAfterStartup = (): Promise<ShutdownReport> =>
      running.stop('startup stop after publication admission');
    checkStartup();
    startupComplete = true;
    startupQuiet();
    return running;
  } catch (error) {
    endpoint.withdrawn = true;
    startupFailed = true;
    startupQuiet();
    const confirmed = await seal();
    // The outer stop race is bounded; its late continuation still owns undo.
    if (options.startupSignal?.aborted) await rollbackStartup();
    options.recordStartupSeal?.(confirmed);
    if (confirmed || !w5) rootPresence?.close();
    else if (rootPresence) uncertainRootPresence.add(rootPresence);
    throw error;
  }
}
