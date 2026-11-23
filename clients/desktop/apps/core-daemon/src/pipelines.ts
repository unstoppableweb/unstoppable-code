import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { RuntimeModule } from '@canopy/core-runtime';
import {
  filesystemSnapshotFailure,
  isFilesystemSnapshotUnavailable,
  isUnreadablePathError,
  readFilesystemScope,
  type CanopyObligationRegistry,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import { refusingExecutionSecretSource } from '@canopy/core-runtime/node/execution-secrets';
import { pipelineLaunchRefusedError } from '@canopy/core-runtime/node/pipeline';
import {
  PIPELINE_HOST_DEFINITIONS,
  createPipelineHostModule,
  prepareNativePipelineSurvival,
  type PipelineHostLaunch,
  type PipelineHostModuleOptions,
  type PipelineHostProcess,
  type PipelineRemoteOwner,
} from '@canopy/core-runtime/node/pipeline/host';
import type {
  ExecutionHostBudget,
  OwnedExecutionHostPort,
} from '@canopy/core-platform/execution-host';
import { DAEMON_PIPELINE_HOST_ENTRY } from '@canopy/core-platform/execution-host/daemon-payload';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type {
  CanopyHostExecution,
  CanopyWorkspaceScope,
  WorkerPipelineExecutionStartParams,
  WorkerPipelineHostLaunch,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { PipelineOwnerChannel } from '@canopy/core-runtime/node/pipeline';
import {
  accountExecutionHost,
  type DaemonExecutionAccounting,
} from './execution';

/** The pipeline host's limits (D18). */
export const DAEMON_PIPELINE_HOST_BUDGET: ExecutionHostBudget = {
  heapMb: 1024,
  rssMb: 2048,
};

/** Every `worker.pipeline.*` operation the daemon serves (CAN-5086). */
export const DAEMON_PIPELINE_DEFINITIONS = PIPELINE_HOST_DEFINITIONS;

export interface DaemonPipelineOptions {
  /** Launches budgeted execution hosts: the daemon relaunched in entry mode. */
  readonly hosts: OwnedExecutionHostPort;
  /** Stops what the hosts ran on, after they stopped. */
  readonly shutdown?: () => Promise<void>;
  /** Resolves the selected scope and its trusted owner on every request. */
  readonly resolveScope: FilesystemScopeResolver;
  /** The daemon's canonical data root. */
  readonly dataRoot: string;
  /** The daemon's own command; the pipeline host's Codex MCP launcher (CAN-5095 D18). */
  readonly codexMcpLauncher: {
    readonly command: string;
    readonly args: readonly string[];
  };
  /**
   * The pipeline host holds a `pipeline` lease while it runs (D23); each
   * running execution keeps the computer awake through it (CAN-5872).
   */
  readonly accounting?: DaemonExecutionAccounting;
  /** Bound once the control plane serves; each running execution holds it (D15). */
  readonly obligations: { current?: Pick<CanopyObligationRegistry, 'hold'> };
  /**
   * The owner channel the daemon shares with its definitions (CAN-7522);
   * the pipeline host makes its own without one.
   */
  readonly owner?: PipelineOwnerChannel;
  /** Observes each pipeline host that ended under its executions. */
  readonly onHostLost?: (report: {
    readonly code: number;
    readonly lost: number;
  }) => void;
  /**
   * The owner is remote, such as the web core over the relay: its delegation
   * lease sets the owner timers and an owner-loss pause records `owner_lost`
   * (CAN-6102). The daemon's own composition never sets it.
   */
  readonly remoteOwner?: PipelineRemoteOwner;
}

/** Whether `child` is `parent` or inside it. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** The deepest directory every root lies in. */
function commonAncestor(roots: readonly string[]): string {
  let ancestor = roots[0] ?? path.sep;
  for (const root of roots.slice(1))
    while (!isWithin(ancestor, root)) ancestor = path.dirname(ancestor);
  return ancestor;
}

async function realOrRefuse(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    // A path the system refused to resolve is not a missing one.
    if (isUnreadablePathError(error)) throw error;
    throw pipelineLaunchRefusedError();
  }
}

/**
 * Verifies a start's host-local launch against the roots this daemon serves
 * (D17) and resolves it for the pipeline host.
 */
async function resolveLaunch(
  options: DaemonPipelineOptions,
  params: WorkerPipelineExecutionStartParams,
  execution: CanopyHostExecution & { pipelineLaunch: WorkerPipelineHostLaunch },
): Promise<PipelineHostLaunch> {
  const { workspaceId, worktreeId } = params;
  if (params.runScope !== 'worktree' || !workspaceId || !worktreeId)
    throw pipelineLaunchRefusedError();
  const context = parseWorkspaceContext(params.owner);
  const scope: CanopyWorkspaceScope = {
    workspaceId,
    worktreeId,
    ...(context?.kind === 'organization' && {
      organizationId: context.organizationId,
    }),
  };
  let roots: string[];
  try {
    const catalog = await readFilesystemScope(
      scope,
      await options.resolveScope(scope, 'roots'),
      'roots',
    );
    roots = catalog.roots
      .filter((root) => root.kind !== 'attachments')
      .map((root) => root.absolutePath);
  } catch (error) {
    // A catalog the system refused to read is not a refused launch.
    if (isFilesystemSnapshotUnavailable(error))
      throw filesystemSnapshotFailure(error);
    throw pipelineLaunchRefusedError();
  }
  if (roots.length === 0) throw pipelineLaunchRefusedError();
  const worktree = await realOrRefuse(
    roots.length === 1 ? roots[0] : commonAncestor(roots),
  );
  const dataRoot = await realOrRefuse(options.dataRoot);
  const launch = execution.pipelineLaunch;
  const inWorktree = async (value: string): Promise<string> => {
    const real = await realOrRefuse(value);
    if (!isWithin(worktree, real)) throw pipelineLaunchRefusedError();
    return real;
  };
  const inRoots = async (value: string): Promise<string> => {
    const real = await realOrRefuse(value);
    if (!isWithin(worktree, real) && !isWithin(dataRoot, real))
      throw pipelineLaunchRefusedError();
    return real;
  };
  const optional = async (
    value: string | undefined,
    check: (value: string) => Promise<string>,
  ): Promise<string | undefined> =>
    value === undefined ? undefined : check(value);
  const bundledActionsDir = await realOrRefuse(launch.bundledActionsDir);
  if (!(await stat(bundledActionsDir)).isDirectory())
    throw pipelineLaunchRefusedError();
  let nodeProcess = launch.nodeProcess;
  if (nodeProcess) {
    const command = await realOrRefuse(nodeProcess.command);
    if (!(await stat(command)).isFile()) throw pipelineLaunchRefusedError();
    nodeProcess = { ...nodeProcess, command };
  }
  // The provider CLIs a run's model steps start (CAN-5095 D21), checked as `nodeProcess` is.
  let providerBinaries = launch.providerBinaries;
  if (providerBinaries) {
    const [claude, codex] = await Promise.all(
      [providerBinaries.claude, providerBinaries.codex].map(async (binary) => {
        const real = await realOrRefuse(binary);
        if (!(await stat(real)).isFile()) throw pipelineLaunchRefusedError();
        return real;
      }),
    );
    providerBinaries = { claude, codex };
  }
  // The app's bundled resources a run's plugin steps read (CAN-5832), checked as `bundledActionsDir` is.
  let bundledResourcesDir = launch.bundledResourcesDir;
  if (bundledResourcesDir !== undefined) {
    bundledResourcesDir = await realOrRefuse(bundledResourcesDir);
    if (!(await stat(bundledResourcesDir)).isDirectory())
      throw pipelineLaunchRefusedError();
  }
  const assetPaths: Record<string, string> = {};
  for (const [name, value] of Object.entries(launch.assetPaths ?? {}))
    assetPaths[name] = await inRoots(value);
  const repoPath = await optional(launch.repoPath, inWorktree);
  const pipelineFileDir = await optional(launch.pipelineFileDir, inRoots);
  const pipelineDataDir = await optional(launch.pipelineDataDir, inRoots);
  const assetsDir = await optional(launch.assetsDir, inRoots);
  const executionCheckoutRoot =
    launch.executionCheckoutRoot === null ||
    launch.executionCheckoutRoot === undefined
      ? launch.executionCheckoutRoot
      : await inRoots(launch.executionCheckoutRoot);
  const { secrets: _secrets, ...rest } = params;
  void _secrets;
  return {
    params: rest,
    launch: {
      ...launch,
      cwd: await inWorktree(launch.cwd),
      bundledActionsDir,
      ...(repoPath !== undefined && { repoPath }),
      ...(pipelineFileDir !== undefined && { pipelineFileDir }),
      ...(pipelineDataDir !== undefined && { pipelineDataDir }),
      ...(assetsDir !== undefined && { assetsDir }),
      ...(launch.assetPaths !== undefined && { assetPaths }),
      ...(executionCheckoutRoot !== undefined && { executionCheckoutRoot }),
      ...(nodeProcess && { nodeProcess }),
      ...(providerBinaries && { providerBinaries }),
      ...(bundledResourcesDir !== undefined && { bundledResourcesDir }),
    },
    processEnvironment: execution.childEnvironment,
  };
}

/**
 * `worker.pipeline.execution.*` over a supervised pipeline host (CAN-5086):
 * start, get (with its detail, CAN-6117), list, cancel and events for
 * host-local launches its leased clients send. Recovery controls, the sweep and the checkpoint are not served
 * (D10). Host steps are settled by the daemon's owner over
 * `worker.pipeline.hostRequests` (CAN-5771). Phase 5 checkpoints every running execution, then stops
 * the host; running executions hold the daemon up until then (D15). The
 * composition is the one the cloud runner shares (CAN-6173).
 */
export function createDaemonPipelineModule(
  options: DaemonPipelineOptions,
): RuntimeModule {
  const supervisor: PipelineHostModuleOptions['supervisor'] = {
    launch: (): PipelineHostProcess =>
      accountExecutionHost(
        options.accounting,
        options.hosts.launch({
          entry: DAEMON_PIPELINE_HOST_ENTRY,
          serviceName: 'Pipeline host',
          budget: DAEMON_PIPELINE_HOST_BUDGET,
        }),
        {
          family: 'pipeline',
          label: 'Pipeline host',
          groupId: 'pipelines',
          // Counted as a process: 'pipeline-execution' is a rollup of
          // registered steps, which the daemon does not register.
          kind: 'other',
        },
      ),
    configure: {
      dataRoot: options.dataRoot,
      codexMcpLauncher: options.codexMcpLauncher,
    },
    resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
      resolveLaunch(options, params, execution),
    // Selected in code only for positively closed native launches. All other
    // owner-bound runs retain the existing app_shutdown checkpoint path.
    prepareOwnerRun: (identity, start, signal) =>
      prepareNativePipelineSurvival(
        identity,
        start,
        options.dataRoot,
        signal,
        hostOperatingSystem(),
        (reason): void => {
          start.launch.nativeSetupFailure = reason;
        },
      ).catch(() => {
        start.launch.nativeSetupFailure ??= 'daemon-validation';
        return undefined;
      }),
    holdExecution: (executionId): (() => void) => {
      const releaseHold =
        options.obligations.current?.hold('pipeline execution') ??
        ((): void => undefined);
      // The run keeps the computer awake while keep awake is on, after the
      // app quits too (CAN-5872).
      const releaseAwake =
        options.accounting?.keepAwake('pipeline', executionId) ??
        ((): void => undefined);
      return (): void => {
        releaseAwake();
        releaseHold();
      };
    },
    killProcessGroup: (group): void => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // Already gone, or not ours to signal.
      }
    },
    ...(options.onHostLost && { onHostLost: options.onHostLost }),
    ...(options.remoteOwner && { remoteOwner: options.remoteOwner }),
  };
  return createPipelineHostModule({
    supervisor,
    ...(options.owner && { owner: options.owner }),
    secrets: refusingExecutionSecretSource,
    stopHosts: async (): Promise<void> => {
      await options.hosts.shutdown();
      await options.shutdown?.();
    },
  }).module;
}
