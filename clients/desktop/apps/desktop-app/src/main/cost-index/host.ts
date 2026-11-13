import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import {
  APP_ADVISOR_PROJECT_ID,
  type PersistedChatTab,
  type ChatRuntimeState,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type {
  CostScopeRef,
  CostPipelineRunStatus,
} from '@canopy/protocol/cost-view';
import {
  getAgentObservabilityAuditDir,
  getArchivedContainerCostDir,
  getCostIndexCheckpointPath,
  getDataDir,
  getEntryCostDir,
  getWorkspacesRootDir,
} from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import type {
  CostChatIdentity,
  CostIndexHost,
  CostScopeLocation,
} from './types';

async function resolveScope(
  scope: CostScopeRef,
): Promise<CostScopeLocation | null> {
  validateId(scope.projectId, 'projectId');
  if (scope.kind === 'retained') {
    const { readArchivedContainerManifest } =
      await import('../lib/archived-containers');
    try {
      const manifest = await readArchivedContainerManifest(
        scope.projectId,
        scope.containerId,
      );
      return {
        scope,
        directory: getArchivedContainerCostDir(
          scope.projectId,
          scope.containerId,
        ),
        incarnation: manifest.createdAt,
        createdAt: manifest.createdAt,
      };
    } catch (error) {
      if (isErrnoException(error) && error.code !== 'ENOENT') throw error;
      return null;
    }
  }
  validateId(scope.worktreeId, 'worktreeId');
  const { getWorkspaceWorktreeCreatedAt } =
    await import('../lib/workspace-persistence');
  const { readWorkEntriesFile } =
    await import('../lib/cowork-work-entries-file');
  const createdAt =
    scope.projectId === APP_ADVISOR_PROJECT_ID
      ? (await readWorkEntriesFile(scope.projectId)).entries.find(
          (entry) => entry.id === scope.worktreeId,
        )?.createdAt
      : ((await getWorkspaceWorktreeCreatedAt(
          scope.projectId,
          scope.worktreeId,
        )) ??
        (await readWorkEntriesFile(scope.projectId)).entries.find(
          (entry) => entry.id === scope.worktreeId,
        )?.createdAt);
  if (createdAt === undefined || createdAt === null) return null;
  return {
    scope,
    directory: getEntryCostDir(scope.projectId, scope.worktreeId),
    incarnation: createdAt,
    createdAt,
  };
}

async function listRetainedScopes(): Promise<readonly CostScopeLocation[]> {
  const projectIds = [APP_ADVISOR_PROJECT_ID];
  try {
    const entries = await readdir(getWorkspacesRootDir(), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
        projectIds.push(entry.name);
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const { listArchivedContainerManifests } =
    await import('../lib/archived-containers');
  const scopes: CostScopeLocation[] = [];
  for (const projectId of projectIds) {
    for (const manifest of await listArchivedContainerManifests(projectId)) {
      const scope: CostScopeRef = {
        kind: 'retained',
        projectId,
        containerId: manifest.id,
      };
      scopes.push({
        scope,
        directory: getArchivedContainerCostDir(projectId, manifest.id),
        incarnation: manifest.createdAt,
        createdAt: manifest.createdAt,
      });
    }
  }
  return scopes;
}

function identity(
  tab: PersistedChatTab,
  state: CostChatIdentity['state'],
  runtime?: ChatRuntimeState,
): CostChatIdentity {
  return {
    chatId: tab.id,
    label: chatDisplayLabel({
      title: tab.title,
      description: tab.description,
      fallback: tab.id,
    }),
    state,
    running:
      state === 'open' &&
      (['starting', 'streaming', 'awaiting_input', 'completing'].includes(
        runtime?.status ?? 'idle',
      ) ||
        ['running', 'starting'].includes(
          tab.claudeTerminal?.turnState ?? 'idle',
        )),
    ...(tab.createdAt === undefined ? {} : { createdAt: tab.createdAt }),
  };
}

async function readChats(
  scope: CostScopeRef,
): Promise<readonly CostChatIdentity[]> {
  if (scope.kind === 'retained') {
    const { readArchivedContainerChats, readArchivedContainerChatArchives } =
      await import('../lib/archived-containers');
    const [tabs, archives] = await Promise.all([
      readArchivedContainerChats(scope.projectId, scope.containerId),
      readArchivedContainerChatArchives(scope.projectId, scope.containerId),
    ]);
    return [
      ...tabs.tabs.map((tab) => identity(tab, 'open')),
      ...archives.archived.map((entry) => identity(entry.tab, 'archived')),
    ];
  }
  const { readChatTabsFile } = await import('../lib/chat-tabs-reader');
  const { readChatArchivesFile } = await import('../lib/chat-archives');
  const { getChatStateService } =
    await import('../services/chat-state-service');
  const [tabs, archives, snapshot] = await Promise.all([
    readChatTabsFile(scope.projectId, scope.worktreeId),
    readChatArchivesFile(scope.projectId, scope.worktreeId),
    getChatStateService().getState({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    }),
  ]);
  return [
    ...tabs.tabs.map((tab) =>
      identity(tab, 'open', snapshot.runtimeByChatId[tab.id]),
    ),
    ...archives.archived.map((entry) => identity(entry.tab, 'archived')),
  ];
}

function runStatus(status: ExecutionState['status']): CostPipelineRunStatus {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'failure':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

const AGENT_ACTIONS = new Set([
  'builtin/agent-loop',
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/coder',
  'builtin/complexity-assessor',
  'builtin/context-discovery',
  'builtin/discovery',
  'builtin/greenfield-detection',
  'builtin/historical-context',
  'builtin/parallel-agents',
  'builtin/plan-validation',
  'builtin/plan-with-review',
  'builtin/planner',
  'builtin/qa-fixer',
  'builtin/qa-reviewer',
  'builtin/quality-gate',
  'builtin/requirements-from-task',
  'builtin/requirements-interactive',
  'builtin/router',
  'builtin/spec-critic',
  'builtin/spec-gatherer',
  'builtin/spec-quick',
  'builtin/spec-researcher',
  'builtin/spec-validation',
  'builtin/spec-writer',
]);

async function readPipelineRun(
  scope: CostScopeRef,
  executionId: string,
): Promise<Awaited<ReturnType<CostIndexHost['readPipelineRun']>>> {
  const { loadExecutionState } =
    await import('@canopy/execution-engine/node/pipelines/executor');
  const { getArchivedContainerExecutionsDir } = await import('../lib/paths');
  const directory =
    scope.kind === 'retained'
      ? getArchivedContainerExecutionsDir(scope.projectId, scope.containerId)
      : join(getDataDir(), 'pipeline-executions');
  const root = await loadExecutionState(executionId, directory);
  if (root === null) return null;
  const scopeId = scope.kind === 'entry' ? scope.worktreeId : scope.containerId;
  if (root.project_id !== scope.projectId || root.worktree_id !== scopeId)
    return null;
  const visited = new Set<string>();
  const stepNames: Record<string, string> = {};
  let count = 0;
  let complete = true;
  const visit = async (state: ExecutionState): Promise<void> => {
    if (visited.has(state.id)) return;
    visited.add(state.id);
    for (const [jobId, job] of Object.entries(state.jobs)) {
      const definition = state.job_definitions[jobId];
      for (const [stepId, step] of Object.entries(job.steps)) {
        const stepDefinition = definition?.steps.find(
          (item) => item.id === stepId,
        );
        const stepName = stepDefinition?.name?.trim();
        if (stepName) {
          stepNames[`${state.id}/${jobId}/${stepId}`] = stepName.slice(0, 160);
        }
        if (stepDefinition === undefined && step.agent_provider === undefined)
          complete = false;
        if (
          step.agent_provider === undefined &&
          stepDefinition !== undefined &&
          stepDefinition.log_format_hint !== 'agent' &&
          !AGENT_ACTIONS.has(stepDefinition.uses ?? '')
        )
          count += 1;
        if (step.child_execution_id !== undefined) {
          const child = await loadExecutionState(
            step.child_execution_id,
            directory,
          );
          if (child === null) complete = false;
          else await visit(child);
        }
      }
    }
  };
  await visit(root);
  return {
    ...(complete ? { nonAgentStepCount: count } : {}),
    ...(Object.keys(stepNames).length > 0 ? { stepNames } : {}),
    status: runStatus(root.status),
    pipelineName: root.pipeline_snapshot.name,
  };
}

/**
 * Root status and name of an entry's runs, from the cached execution
 * summaries the Activity pipeline list also reads. A retained scope's runs are
 * sealed with their final status, so it has nothing to add.
 */
async function readPipelineRunStates(
  scope: CostScopeRef,
): Promise<
  Awaited<ReturnType<NonNullable<CostIndexHost['readPipelineRunStates']>>>
> {
  const states = new Map<
    string,
    { status: CostPipelineRunStatus; pipelineName?: string }
  >();
  if (scope.kind !== 'entry') return states;
  const { listExecutionSummaries } =
    await import('@canopy/execution-engine/node/pipelines/executor');
  const summaries = await listExecutionSummaries(
    join(getDataDir(), 'pipeline-executions'),
  );
  for (const summary of summaries) {
    if (
      summary.project_id !== scope.projectId ||
      summary.worktree_id !== scope.worktreeId
    )
      continue;
    const pipelineName = summary.pipeline_name.trim();
    states.set(summary.id, {
      status: runStatus(summary.status),
      ...(pipelineName ? { pipelineName } : {}),
    });
  }
  return states;
}

export function getDesktopCostIndexHost(): CostIndexHost {
  return {
    auditDirectory: getAgentObservabilityAuditDir,
    checkpointPath: getCostIndexCheckpointPath,
    resolveScope,
    listRetainedScopes,
    withRetainedLock: async <T>(
      scope: CostScopeRef,
      action: () => Promise<T>,
    ): Promise<T> => {
      if (scope.kind !== 'retained') return action();
      const { withArchivedContainerOperationLock } =
        await import('../lib/archived-containers');
      return withArchivedContainerOperationLock(
        scope.projectId,
        scope.containerId,
        action,
      );
    },
    readChats,
    readPipelineRun,
    readPipelineRunStates,
    readProxyAccountLabels: async (): Promise<ReadonlyMap<string, string>> => {
      const { getAccountProxyAccountLabels } =
        await import('../account-proxy/service');
      return getAccountProxyAccountLabels();
    },
    retentionDays: async (): Promise<number> => {
      const { readPreferencesFile } = await import('../lib/preferences-store');
      return (await readPreferencesFile()).auditRetentionDays;
    },
    flush: async (): Promise<void> => {
      const { getObservabilityService } = await import('../observability');
      await getObservabilityService().flush();
    },
  };
}
