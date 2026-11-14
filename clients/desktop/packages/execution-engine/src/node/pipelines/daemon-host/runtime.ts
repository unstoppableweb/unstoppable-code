import * as os from 'node:os';
import * as path from 'node:path';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import type {
  ExecutionResourceMonitor,
  ExecutionRunPlanPersistence,
  ExecutionRuntime,
  PipelineHostActions,
  PipelineStepNotification,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
} from '../executor/types';
import type { CodexRuntimeService } from '../../codex-runtime';
import { runCodexPipelinePromptWith } from '../codex-pipeline-prompt';
import type { DaemonPipelineOwnerPorts } from './owner-ports';
import { launchPluginCollectionResolver } from './plugin-collections';
import { PIPELINE_HOST_RUN_TEMP_DIR } from './run-temp';
import type { ResolvedPipelinePluginCollectionSnapshot } from '@canopy/execution-engine/types/pipeline';

/** The worktree a launch runs in, as the daemon verified it (CAN-5086 D17). */
export interface DaemonPipelineWorktree {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly path: string;
}

export interface DaemonPipelineRuntimeOptions {
  readonly executionsDir: string;
  readonly bundledActionsDir: string;
  readonly processEnvironment: Readonly<Record<string, string>>;
  readonly nodeProcess?: ExecutionRuntime['nodeProcess'];
  /** The launch's staged tsx CLI (CAN-6316 G1). */
  readonly tsxCli?: string;
  readonly resourceMonitor?: ExecutionResourceMonitor;
  /** The only worktree target this runtime resolves; none for a lookup runtime. */
  readonly worktree?: DaemonPipelineWorktree;
  /** Owner-bound launches only (CAN-5771). */
  readonly pipelineHostActions?: PipelineHostActions;
  /** An owner-bound launch's model ports (CAN-5095): its core answers each call. */
  readonly owner?: DaemonPipelineOwnerPorts;
  /** An owner-bound launch's plan port (CAN-6327): its core keeps the run's plan. */
  readonly plans?: ExecutionRunPlanPersistence;
  /** The host's own Codex runtime, for an owner-bound launch's Codex steps. */
  readonly codexRuntime?: () => CodexRuntimeService;
  /** The run's plugin collection snapshots, resolved by its core at launch (CAN-5832). */
  readonly pluginCollections?: Readonly<
    Record<string, ResolvedPipelinePluginCollectionSnapshot>
  >;
  /** Hands a step's desktop notifications to Electron main (CAN-5868). */
  /**
   * Reports a brokered launch's `git-commit-push` pre-commit failures to its
   * owner after the step settles (CAN-6739).
   */
  readonly reportPrecommitFailures?: NonNullable<
    ExecutionRuntime['onStepPostProcess']
  >;
  readonly onStepNotifications?: (
    stepId: string,
    notifications: readonly PipelineStepNotification[],
  ) => void;
}

function noCodexRuntime(): CodexRuntimeService {
  throw new Error('The background service has no Codex runtime.');
}

function resolveVerifiedWorktree(
  worktree: DaemonPipelineWorktree | undefined,
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  const requested = request.requested;
  if (
    !worktree ||
    requested.scope !== 'worktree' ||
    requested.workspace_id !== worktree.workspaceId ||
    requested.worktree.id !== worktree.worktreeId
  )
    return Promise.reject(
      new Error('The background workflow service runs only its own worktree.'),
    );
  return Promise.resolve({
    cwd: worktree.path,
    scope: 'worktree',
    target: {
      scope: 'worktree',
      workspace_id: worktree.workspaceId,
      worktree_id: worktree.worktreeId,
      path: worktree.path,
      created: false,
    },
    projectId: worktree.workspaceId,
    worktreeId: worktree.worktreeId,
    repoPath: worktree.path,
  });
}

/**
 * The executor runtime a daemon pipeline host runs one launch with (CAN-5086).
 * It has no prompt runner, ledger, lifecycle, host actions or AI-credit
 * route, so a model or host step that slipped past the classifier fails
 * closed; it resolves only the launch's verified worktree. An owner-bound
 * launch's plan writes go to its core (CAN-6327); an unbound launch keeps
 * none.
 * A step's desktop notifications go to Electron main, which shows them
 * (CAN-5868).
 */
export function createDaemonPipelineRuntime(
  options: DaemonPipelineRuntimeOptions,
): ExecutionRuntime {
  return {
    bundledActionsDir: options.bundledActionsDir,
    executionsDir: options.executionsDir,
    tempRootDir: path.join(os.tmpdir(), PIPELINE_HOST_RUN_TEMP_DIR),
    getProjectActionsDir,
    getProjectActionsDirCandidates,
    getProjectPipelinesDir,
    getProjectPipelinesDirCandidates,
    processEnvironment: options.processEnvironment,
    ...(options.nodeProcess && { nodeProcess: options.nodeProcess }),
    ...(options.tsxCli && { tsxCli: options.tsxCli }),
    ...(options.resourceMonitor && {
      resourceMonitor: options.resourceMonitor,
    }),
    ...(options.pipelineHostActions && {
      pipelineHostActions: options.pipelineHostActions,
    }),
    ...(options.plans && { runPlanPersistence: options.plans }),
    ...((options.onStepNotifications || options.reportPrecommitFailures) && {
      onStepPostProcess: stepPostProcess(
        options.onStepNotifications,
        options.reportPrecommitFailures,
      ),
    }),
    resolvePipelineTarget: (request) =>
      resolveVerifiedWorktree(options.worktree, request),
    ...(options.pluginCollections && {
      resolvePipelinePluginCollections: launchPluginCollectionResolver(
        options.pluginCollections,
      ),
    }),
    // Every model is refused unless the launch's core answers for it (D7).
    isModelBlockedByOrgPolicy: () => Promise.resolve(true),
    isOrgModelPolicyActive: () => Promise.resolve(true),
    ...(options.owner && ownerModelPorts(options.owner, options.codexRuntime)),
  };
}

function stepPostProcess(
  forward: DaemonPipelineRuntimeOptions['onStepNotifications'],
  reportPrecommitFailures: DaemonPipelineRuntimeOptions['reportPrecommitFailures'],
): NonNullable<ExecutionRuntime['onStepPostProcess']> {
  return async (ctx) => {
    if (forward && ctx.notifications?.length)
      forward(ctx.step.id, ctx.notifications);
    await reportPrecommitFailures?.(ctx);
  };
}

/**
 * The model ports of an owner-bound launch (CAN-5095 D2): Claude steps run
 * their action subprocess, Codex steps the shared runner on the host's own
 * runtime; Agent model aliases resolve through the owner and plugin
 * collections from the launch (CAN-5832). Terminal workers, Cursor, Copilot
 * and OpenCode stay absent, so such a step fails closed.
 */
function ownerModelPorts(
  owner: DaemonPipelineOwnerPorts,
  codexRuntime: (() => CodexRuntimeService) | undefined,
): Partial<ExecutionRuntime> {
  const { codex, ...ports } = owner;
  return {
    ...ports,
    codexPromptRunner: {
      runCodexPrompt: (request) =>
        runCodexPipelinePromptWith(request, {
          ...codex,
          runtime: codexRuntime ?? noCodexRuntime,
        }),
    },
  };
}
