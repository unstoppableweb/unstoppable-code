import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ExecutionSecretSource,
  RedeemedExecutionSecrets,
} from '@canopy/core-runtime/node/execution-secrets';
import {
  PipelineEventJournal,
  pipelineLaunchRefusedError,
  pipelinePortableLaunchRefusedError,
  pipelineStartFailedError,
  type PipelineOwnerChannel,
} from '@canopy/core-runtime/node/pipeline';
import {
  createPipelineHostModule,
  type PipelineHostLaunch,
  type PipelineHostLauncherCommand,
  type PipelineHostMemoryBudget,
  type PipelineHostModule,
  type PipelineHostProcess,
  type PipelineRemoteOwner,
} from '@canopy/core-runtime/node/pipeline/host';
import type {
  WorkerPipelineExecutionStartParams,
  WorkerPipelineHostLaunch,
  WorkerPipelinePortableLaunch,
} from '@canopy/protocol/canopy-core';
import {
  normalizePipelineAssets,
  normalizePipelineLocalState,
} from '@canopy/pipeline-interop/assets';
import {
  PipelineRunnerDataStore,
  type PipelineRunnerDataFolders,
} from './pipeline-data';

/*
 * The cloud runner's composition (CAN-6173, cloud pipelines CP-07, decision
 * P1): the daemon's pipeline host under the same supervisor, owner channel
 * and worker.pipeline handlers, with a launch resolver that maps the
 * portable start (CAN-6161) to the runner's own paths. The runner reads no
 * workspace index: its one checkout is the run's workspace.
 */

/**
 * Where the runner keeps what a portable start leaves out
 * (`WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS`). Every path is the
 * runner's own and absolute; none crosses the relay.
 */
export interface PipelineRunnerLayout {
  /** The runner's data root: the execution store and run state live here. */
  readonly dataRoot: string;
  /** The sandbox checkout: a `worktree` run's workspace, a `directory` run's folder. */
  readonly checkout: string;
  /** The staged builtin actions (`resources/actions`). */
  readonly bundledActionsDir: string;
  /** The staged Node runtime `node` steps and actions run with. */
  readonly nodeRuntime: {
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
  };
  /** The staged tsx CLI `tsx` steps and actions run with (CAN-6316 G1), if staged. */
  readonly tsxCli?: string;
  /** The staged resources a run's plugin steps read (CAN-5832), if staged. */
  readonly bundledResourcesDir?: string;
  /** The staged provider CLIs model steps start (CAN-5095 D21), if staged. */
  readonly providerBinaries?: {
    readonly claude: string;
    readonly codex: string;
  };
  /**
   * The runner's own Codex app-server environment for a run's Codex steps
   * (CAN-5095 D20). A portable start never carries the primary's; without
   * it the host refuses a run with a Codex step.
   */
  readonly codexEnvironment?: WorkerPipelineHostLaunch['codexEnvironment'];
  /** The runner's base environment for each run's steps. */
  readonly processEnvironment: Readonly<Record<string, string>>;
}

async function realOrRefuse(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    throw pipelineLaunchRefusedError();
  }
}

async function directory(value: string): Promise<string> {
  const real = await realOrRefuse(value);
  if (!(await stat(real)).isDirectory()) throw pipelineLaunchRefusedError();
  return real;
}

async function file(value: string): Promise<string> {
  const real = await realOrRefuse(value);
  if (!(await stat(real)).isFile()) throw pipelineLaunchRefusedError();
  return real;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The run's data members (CAN-6317): its `canopy.pipeline_data_dir`, its
 * installed asset root and each declared asset's folder in it. A cloud run
 * never reads the declared path, which names a folder on the author's
 * computer: every asset resolves to `assets/<id>` in the pipeline's data.
 * A required asset that is not there fails the start, naming it, as on
 * desktop; an optional one resolves to `''`.
 */
async function pipelineDataMembers(
  snapshot: Readonly<Record<string, unknown>>,
  folders: PipelineRunnerDataFolders,
): Promise<
  Pick<WorkerPipelineHostLaunch, 'pipelineDataDir' | 'assetsDir' | 'assetPaths'>
> {
  let assets: ReturnType<typeof normalizePipelineAssets>;
  try {
    assets = normalizePipelineAssets(snapshot.assets);
  } catch (error) {
    throw pipelineStartFailedError(error);
  }
  const members: Pick<
    WorkerPipelineHostLaunch,
    'pipelineDataDir' | 'assetsDir' | 'assetPaths'
  > = { pipelineDataDir: folders.state, assetsDir: folders.assets };
  if (assets === undefined) return members;
  const assetPaths: Record<string, string> = {};
  for (const asset of assets) {
    const installed = path.join(folders.assets, asset.id);
    if (await isDirectory(installed)) assetPaths[asset.id] = installed;
    else if (asset.required)
      throw pipelineStartFailedError(
        new Error(
          `Pipeline asset "${asset.id}" is missing from this workflow's cloud data.`,
        ),
      );
    else assetPaths[asset.id] = '';
  }
  return { ...members, assetPaths };
}

/**
 * Maps a portable start to a host-local launch on this runner (CP-07's
 * `resolveLaunch`): the pinned snapshot runs in the runner's checkout (a
 * worktree or directory run) or its global workspace (a global run) with
 * its staged actions, Node runtime and provider CLIs, and the redeemed
 * secrets become the launch's `secretEnv`. The run's pipeline data
 * (CAN-6317) comes from `data`: its data folder, its assets and, for a
 * global run, the workspace kept from its last run. A start the runner
 * cannot serve is refused with `worker.pipeline.launchRefused`, as is one
 * whose definition lists `local_state`: those files stay on the computer
 * that owns them (parity R8).
 */
export function createPipelineRunnerLaunchResolver(
  layout: PipelineRunnerLayout,
  data: PipelineRunnerDataStore = new PipelineRunnerDataStore(layout.dataRoot),
): (
  params: WorkerPipelineExecutionStartParams & {
    portableLaunch: WorkerPipelinePortableLaunch;
  },
  secrets: RedeemedExecutionSecrets,
) => Promise<PipelineHostLaunch> {
  return async (params, secrets): Promise<PipelineHostLaunch> => {
    const { portableLaunch: portable, secrets: _bindings, ...rest } = params;
    void _bindings;
    // A pinned package is fetched by digest at bootstrap (CP-11); until a
    // runner can, a run that needs one is refused rather than run without it.
    if (portable.definition.pin.packageDigest !== null)
      throw pipelineLaunchRefusedError();
    // `local_state` never leaves its owner, so a cloud run is refused it.
    let localState: string[] | undefined;
    try {
      localState = normalizePipelineLocalState(
        portable.definition.snapshot.local_state,
      );
    } catch {
      throw pipelineLaunchRefusedError();
    }
    if ((localState?.length ?? 0) > 0) throw pipelineLaunchRefusedError();
    // A worktree run names its workspace and worktree; a directory or
    // global run names neither.
    const worktreeRun = params.runScope === 'worktree';
    if (
      worktreeRun
        ? params.workspaceId === null || params.worktreeId === null
        : params.workspaceId !== null || params.worktreeId !== null
    )
      throw pipelineLaunchRefusedError();
    // A global run has no folder of its own: the executor runs it in its
    // global workspace folder under the data root, as on desktop.
    const checkout =
      params.runScope === 'global' ? null : await directory(layout.checkout);
    const dataRoot = await directory(layout.dataRoot);
    const bundledActionsDir = await directory(layout.bundledActionsDir);
    const nodeCommand = await file(layout.nodeRuntime.command);
    const tsxRuntime =
      layout.tsxCli === undefined ? undefined : await file(layout.tsxCli);
    let providerBinaries: { claude: string; codex: string } | undefined;
    if (layout.providerBinaries) {
      const [claude, codex] = await Promise.all([
        file(layout.providerBinaries.claude),
        file(layout.providerBinaries.codex),
      ]);
      providerBinaries = { claude, codex };
    }
    const bundledResourcesDir =
      layout.bundledResourcesDir === undefined
        ? undefined
        : await directory(layout.bundledResourcesDir);
    const folders = await data.prepare(params.owner, params.pipelineId);
    const dataMembers = await pipelineDataMembers(
      portable.definition.snapshot,
      folders,
    );
    const { definition, delegationLease: _lease, ...members } = portable;
    void _lease;
    const launch: WorkerPipelineHostLaunch = {
      ...members,
      pipeline: definition.snapshot,
      cwd: checkout ?? dataRoot,
      ...(checkout !== null && { repoPath: checkout }),
      ...dataMembers,
      // A global run works in the pipeline's kept workspace, not a new one.
      ...(checkout === null && { globalWorkspaceDir: folders.workspace }),
      bundledActionsDir,
      nodeProcess: {
        command: nodeCommand,
        ...(layout.nodeRuntime.env && { env: { ...layout.nodeRuntime.env } }),
      },
      secretEnv: { ...secrets.env },
      ...(tsxRuntime !== undefined && { tsxRuntime }),
      ...(providerBinaries && { providerBinaries }),
      ...(bundledResourcesDir !== undefined && { bundledResourcesDir }),
      ...(layout.codexEnvironment && {
        codexEnvironment: {
          environment: { ...layout.codexEnvironment.environment },
          logicalWorkspaceEnvironmentId:
            layout.codexEnvironment.logicalWorkspaceEnvironmentId,
        },
      }),
    };
    return {
      params: rest,
      launch,
      processEnvironment: { ...layout.processEnvironment },
    };
  };
}

/**
 * Where a runner bundle stages each member, relative to the bundle root
 * (CP-10): beside the daemon executable `build:core-daemon` builds.
 */
export const PIPELINE_RUNNER_BUNDLE_LAYOUT = Object.freeze({
  /** The execution host entries, with `pipeline-host.js`. */
  hostEntries: 'execution-hosts',
  /** The bundled resources: `builtin:app` skills and pipelines. */
  bundledResources: 'resources',
  /** The builtin actions, with every host-step manifest. */
  bundledActions: path.join('resources', 'actions'),
  /** The Node runtime `node` steps and actions run with. */
  nodeRuntime: path.join('node', 'bin', 'node'),
  /**
   * The tsx CLI `tsx` steps and actions run with on that runtime, staged
   * with its dependencies from the locked install (CAN-6316 G1).
   */
  tsxCli: path.join('tsx', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  /** The provider CLIs model steps start (CAN-5095). */
  claude: path.join('bin', 'claude'),
  codex: path.join('bin', 'codex'),
  /** The GitHub CLI and RTK, for the host and for steps (CAN-6200). */
  gh: path.join('bin', 'gh'),
  rtk: path.join('bin', 'rtk'),
  /** The bundle record: its version, tool versions and every file's digest. */
  record: 'runner-bundle.json',
  /** The runner process entry, which the staged Node runtime runs. */
  runnerEntry: path.join('runner', 'pipeline-runner.js'),
  /** The launcher an image starts under its init process. */
  launcher: 'pipeline-runner',
});

/**
 * What one run's events journal keeps on a runner (CAN-6161), tuned to the
 * five-minute relay outage a run must survive without losing events (CP-11).
 * A run that writes output steadily, a few chunks a second for five minutes,
 * stays inside 8,192 items, four times the journal's default; at the 16 KiB
 * output item limit that is at most 128 MiB for a run that only writes full
 * chunks. A run's journal stays 10 minutes after it pauses or ends, past the
 * outage, so a run that finished meanwhile still replays to its end.
 */
export const PIPELINE_RUNNER_EVENT_JOURNAL = Object.freeze({
  maxEntries: 8_192,
  retainMs: 10 * 60_000,
});

/** The pipeline host's limits: the daemon's (D18). */
export const PIPELINE_RUNNER_HOST_BUDGET = Object.freeze({
  heapMb: 1024,
  rssMb: 2048,
});

/** The runner layout of a staged bundle, its data root and its checkout. */
export function pipelineRunnerLayout(options: {
  readonly bundleRoot: string;
  readonly dataRoot: string;
  readonly checkout: string;
  readonly processEnvironment: Readonly<Record<string, string>>;
  /** Whether the bundle stages the provider CLIs; model steps need them. */
  readonly providerBinaries?: boolean;
}): PipelineRunnerLayout {
  const at = (member: string): string => path.join(options.bundleRoot, member);
  return {
    dataRoot: options.dataRoot,
    checkout: options.checkout,
    bundledActionsDir: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.bundledActions),
    bundledResourcesDir: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.bundledResources),
    nodeRuntime: { command: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.nodeRuntime) },
    tsxCli: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.tsxCli),
    ...(options.providerBinaries && {
      providerBinaries: {
        claude: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.claude),
        codex: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.codex),
      },
    }),
    processEnvironment: { ...options.processEnvironment },
  };
}

async function kindOf(target: string): Promise<'file' | 'directory' | null> {
  try {
    const stats = await stat(target);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

/**
 * The layout members that are missing or of the wrong kind, so a runner
 * refuses to serve before a start finds one; empty when all are staged.
 */
export async function verifyPipelineRunnerLayout(
  layout: PipelineRunnerLayout,
): Promise<readonly string[]> {
  const expected: [string, string, 'file' | 'directory'][] = [
    ['dataRoot', layout.dataRoot, 'directory'],
    ['checkout', layout.checkout, 'directory'],
    ['bundledActionsDir', layout.bundledActionsDir, 'directory'],
    ['nodeRuntime', layout.nodeRuntime.command, 'file'],
  ];
  if (layout.tsxCli !== undefined)
    expected.push(['tsxCli', layout.tsxCli, 'file']);
  if (layout.bundledResourcesDir !== undefined)
    expected.push([
      'bundledResourcesDir',
      layout.bundledResourcesDir,
      'directory',
    ]);
  if (layout.providerBinaries)
    expected.push(
      ['providerBinaries.claude', layout.providerBinaries.claude, 'file'],
      ['providerBinaries.codex', layout.providerBinaries.codex, 'file'],
    );
  const kinds = await Promise.all(expected.map(([, target]) => kindOf(target)));
  return expected
    .filter(([, , kind], index) => kinds[index] !== kind)
    .map(([member]) => member);
}

/**
 * Refuses to run the runner as PID 1. Its pipeline host and every step run
 * as child processes, and PID 1 must reap orphans and forward signals: start
 * the runner under an init process (`tini`, or `docker run --init`).
 */
export function assertPipelineRunnerNotInit(pid: number = process.pid): void {
  if (pid === 1)
    throw new Error(
      'The pipeline runner must run under an init process such as tini, not as PID 1.',
    );
}

/**
 * Ends a step's process group that outlived its host, as the daemon does:
 * steps run in their own process groups, which stopping a lost host's tree
 * cannot reach.
 */
export function killPipelineStepGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch {
    // Already gone, or not ours to signal.
  }
}

export interface PipelineRunnerOptions {
  readonly layout: PipelineRunnerLayout;
  /** Starts a pipeline host: the runner's staged host entry, under its budget. */
  readonly launchHost: () => PipelineHostProcess;
  /** Stops what the hosts ran on, after the supervisor stopped. */
  readonly stopHosts?: () => Promise<void>;
  /**
   * The owner endpoint: the channel the relay serves the web core's
   * `worker.pipeline.hostRequests` subscription and respond over (CP-11).
   */
  readonly owner?: PipelineOwnerChannel;
  /** Redeems a start's secret bindings at the runner (CAN-5067). */
  readonly secrets: ExecutionSecretSource;
  /** The execution target this runner is, which a list request names. */
  readonly targetId: string;
  /**
   * The remote owner's delegation lease (CAN-6102, CAN-6198): its timers
   * follow its TTL, which the first portable start supplies when this does
   * not, and its epoch fences the host's writes.
   */
  readonly remoteOwner?: PipelineRemoteOwner;
  /** The Codex MCP launcher the host's Codex steps use (CAN-5095 D18). */
  readonly codexMcpLauncher?: PipelineHostLauncherCommand;
  /**
   * The run sandbox's memory (CAN-6325): what the host's steps may take
   * together, from the size the run recorded, and the share kept for chats
   * when the sandbox is a worktree's. Without it steps start without waiting.
   */
  readonly memory?: PipelineHostMemoryBudget;
  /**
   * Ends a step's process group that outlived its host. Default:
   * `killPipelineStepGroup`.
   */
  readonly killProcessGroup?: (processGroupId: number) => void;
  /** Observes each host that ended under its executions. */
  readonly onHostLost?: (report: {
    readonly code: number;
    readonly lost: number;
  }) => void;
}

/**
 * The cloud runner: `worker.pipeline.*` over the daemon's pipeline host, for
 * portable starts only, with its own operations (`runnerHandlers`): one
 * run's graceful checkpoint (CAN-6199), resume and retry for its runs
 * (CAN-6103) and its pipeline data import and export (CAN-6317), bound
 * beside `handlers` under `PIPELINE_RUNNER_DEFINITIONS`. Host-local
 * launches are refused; nothing on a runner stages one. Events streams
 * resume after a cursor from its journal. It refuses to start as PID 1:
 * run it under an init process.
 */
export function createPipelineRunner(
  options: PipelineRunnerOptions,
): PipelineHostModule {
  assertPipelineRunnerNotInit();
  const dataRoot = path.resolve(options.layout.dataRoot);
  const pipelineData = new PipelineRunnerDataStore(dataRoot);
  return createPipelineHostModule({
    supervisor: {
      launch: options.launchHost,
      configure: {
        dataRoot,
        ...(options.codexMcpLauncher && {
          codexMcpLauncher: options.codexMcpLauncher,
        }),
        ...(options.memory && { memory: options.memory }),
      },
      resolveLaunch: (): Promise<PipelineHostLaunch> =>
        Promise.reject(pipelinePortableLaunchRefusedError()),
      resolvePortableLaunch: createPipelineRunnerLaunchResolver(
        options.layout,
        pipelineData,
      ),
      killProcessGroup: options.killProcessGroup ?? killPipelineStepGroup,
      ...(options.onHostLost && { onHostLost: options.onHostLost }),
      ...(options.remoteOwner && { remoteOwner: options.remoteOwner }),
    },
    ...(options.owner && { owner: options.owner }),
    secrets: options.secrets,
    targetId: options.targetId,
    journal: new PipelineEventJournal(PIPELINE_RUNNER_EVENT_JOURNAL),
    ...(options.stopHosts && { stopHosts: options.stopHosts }),
    // Its owner checkpoints one run to roll the sandbox over (CAN-6199),
    // with no other executor its paused runs resume here (CAN-6103, P8), and
    // its owner keeps each pipeline's data between runs (CAN-6317).
    runnerOperations: { pipelineData },
  });
}
