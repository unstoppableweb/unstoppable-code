import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import type { AgentActionHostCapabilities } from '../../surface/capabilities';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import { PIPELINE_RUN_MAX_WATCHERS } from './actions';

const PIPELINE_RUN_FIELDS: readonly AgentActionField[] = [
  {
    name: 'pipelineId',
    type: 'string',
    required: true,
    description: 'Pipeline id to run, from pipeline.list.',
  },
  {
    name: 'scope',
    type: "'global'",
    required: false,
    description:
      'Set "global" to run with no project, for a pipeline whose scopes include global. Omit it to run in this chat\'s task or folder.',
  },
  {
    name: 'runOn',
    type: "'local' | 'cloud'",
    required: false,
    description:
      'Set "cloud" to start the run in the cloud, for a shared or curated pipeline. With scope "global" it runs with no project; without it, the cloud runs it in this chat\'s project or task only where it can, and otherwise refuses it with its reason. A cloud run is a dispatch with no plan or task file and no inline watchers; to be told when it pauses or ends, arm a worktree_pipeline_completion watcher with SetupWatchers on the executionId it returns, with target.runOn "cloud". A pipeline whose agent steps need cloud models runs in the cloud only once the person has chosen them in the Run dialog. Omit it to run on this computer.',
  },
  {
    name: 'inputs',
    type: 'Record<string,string>',
    required: false,
    description: 'Pipeline input values.',
  },
  {
    name: 'runMode',
    type: "'dispatch' | 'plan_ready' | 'task_ready'",
    required: false,
    description:
      'Run mode to use. Defaults to dispatch. A global run supports only dispatch.',
  },
  {
    name: 'planPath',
    type: 'string',
    required: false,
    description:
      'Plan file path, required for plan_ready and optional for task_ready. Not for global runs.',
  },
  {
    name: 'taskPath',
    type: 'string',
    required: false,
    description:
      'Task file path, required for task_ready. Not for global runs.',
  },
  {
    name: 'planId',
    type: 'string',
    required: false,
    description: 'Optional tracked plan id. Not for global runs.',
  },
  {
    name: 'repoId',
    type: 'string',
    required: false,
    description:
      'Optional repository of a multi-repository project to run in. Not for global runs.',
  },
  {
    name: 'watchers',
    type: 'InlineWatcherSetup[]',
    required: false,
    description: `Up to ${PIPELINE_RUN_MAX_WATCHERS} completion watchers to arm as soon as the run starts. Do not include destination ids. Not available for global runs.`,
  },
];

const PIPELINE_RUN_KEYWORDS: readonly string[] = [
  'pipeline',
  'run',
  'execute',
  'start',
  'dispatch',
  'global',
  'no project',
  'cloud',
  'run on',
  'plan_ready',
  'task_ready',
];

const PIPELINE_RUN_NOTES: readonly string[] = [
  "A global run belongs to the owner of the chat that started it and appears under No project in that owner's Runs list. The chat that started it can list, read, and control it.",
  'Each new tool call starts a new run; repeating the same tool call returns its recorded result.',
];

/** Where a host that runs both locally and in the cloud follows a cloud run up. */
const CLOUD_RUN_FOLLOW_UP_NOTE =
  'A cloud run belongs to the chat\'s owner and returns location "cloud". Read, cancel and resume it with pipeline.execution_get, pipeline.execution_cancel and pipeline.execution_resume on its executionId; pipeline.execution_list with runOn "cloud" lists the owner\'s cloud runs. A cloud run can\'t be retried yet: start it again with pipeline.run.';

export function pipelinesActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pipeline.run',
      category: 'pipeline',
      summary:
        'Run a pipeline in this chat\'s task or folder, or with scope "global" in a scratch folder with no project.',
      fields: PIPELINE_RUN_FIELDS,
      example: {
        type: 'pipeline.run',
        pipelineId: 'build',
        inputs: { target: 'test' },
        watchers: [
          { target: { terminalStatuses: ['success', 'failure', 'cancelled'] } },
        ],
      },
      additionalExamples: [
        { type: 'pipeline.run', pipelineId: 'weekly-digest', scope: 'global' },
        {
          type: 'pipeline.run',
          pipelineId: 'curated:weekly-digest',
          scope: 'global',
          runOn: 'cloud',
        },
      ],
      keywords: PIPELINE_RUN_KEYWORDS,
      notes: [...PIPELINE_RUN_NOTES, CLOUD_RUN_FOLLOW_UP_NOTE],
    },
  ];
}

const CLOUD_PIPELINE_RUN_FIELDS: readonly AgentActionField[] = [
  {
    name: 'pipelineId',
    type: 'string',
    required: true,
    description:
      'Workflow to run: a shared workflow (shared:…) or a curated one (curated:…).',
  },
  {
    name: 'scope',
    type: "'global'",
    required: true,
    description:
      'Set "global". Workflows started here run in the cloud, with no project.',
  },
  {
    name: 'inputs',
    type: 'Record<string,string>',
    required: false,
    description: 'Workflow input values.',
  },
];

/**
 * The `pipeline.run` row of a host that starts every run in the cloud: a
 * global dispatch, with no task fields, run location or inline watchers.
 */
function cloudPipelinesActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pipeline.run',
      category: 'pipeline',
      summary:
        'Run a workflow in the cloud with scope "global", with no project.',
      fields: CLOUD_PIPELINE_RUN_FIELDS,
      example: {
        type: 'pipeline.run',
        pipelineId: 'curated:weekly-digest',
        scope: 'global',
      },
      additionalExamples: [
        {
          type: 'pipeline.run',
          pipelineId: 'curated:weekly-digest',
          scope: 'global',
          inputs: { topic: 'releases' },
        },
      ],
      keywords: ['pipeline', 'workflow', 'run', 'execute', 'start', 'cloud'],
      notes: [
        "A run belongs to the owner of this chat's project, never one the payload names.",
        'A workflow whose agent steps need cloud models runs only once the person has chosen those models in the Run dialog.',
        'To be told when it ends, arm a worktree_pipeline_completion watcher with SetupWatchers on the executionId it returns.',
        PIPELINE_RUN_NOTES[1],
      ],
    },
  ];
}

/** Whether a host starts every run in the cloud. */
export function pipelineRunsCloudOnly(
  capabilities: Pick<AgentActionHostCapabilities, 'pipelineRunLocations'>,
): boolean {
  const locations = capabilities.pipelineRunLocations;
  return locations !== undefined && !locations.includes('local');
}

/** The `pipeline.run` row for where a host starts runs. */
export function pipelinesActionCatalogFor(
  capabilities: Pick<AgentActionHostCapabilities, 'pipelineRunLocations'>,
): readonly AgentActionCatalogEntry[] {
  return pipelineRunsCloudOnly(capabilities)
    ? cloudPipelinesActionCatalog()
    : pipelinesActionCatalog();
}

/**
 * App Advisor's `pipeline.run` row: it has no task of its own, so a run in a
 * task names it with `projectId` and `worktreeId`.
 */
export function appAdvisorPipelinesActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pipeline.run',
      category: 'pipeline',
      summary:
        'Run a pipeline in a task (worktree), or with scope "global" in a scratch folder with no project.',
      fields: [
        PIPELINE_RUN_FIELDS[0],
        {
          name: 'projectId',
          type: 'string',
          required: false,
          description:
            'Project of the task to run in. Required unless scope is "global"; omit it for a global run.',
        },
        {
          name: 'worktreeId',
          type: 'string',
          required: false,
          description:
            'Task (worktree) to run in. Required unless scope is "global"; omit it for a global run.',
        },
        ...PIPELINE_RUN_FIELDS.slice(1),
      ],
      example: {
        type: 'pipeline.run',
        pipelineId: 'build',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        inputs: { target: 'test' },
        watchers: [{ terminalStatuses: ['success', 'failure', 'cancelled'] }],
      },
      additionalExamples: [
        { type: 'pipeline.run', pipelineId: 'weekly-digest', scope: 'global' },
        {
          type: 'pipeline.run',
          pipelineId: 'curated:weekly-digest',
          scope: 'global',
          runOn: 'cloud',
        },
      ],
      keywords: PIPELINE_RUN_KEYWORDS,
      notes: [
        "A global run from Orchestrator belongs to the selected owner and appears under No project in that owner's Runs list.",
        PIPELINE_RUN_NOTES[1],
        'A cloud run returns location "cloud". Read, cancel and resume it with pipeline.execution_get, pipeline.execution_cancel and pipeline.execution_resume on its executionId; pipeline.execution_list with runOn "cloud" lists cloud runs. A cloud run can\'t be retried yet: start it again with pipeline.run.',
      ],
    },
  ];
}

/**
 * Only `scope` is advertised; the other pipeline.run fields come from
 * SearchActions, as the desktop's legacy pipeline actions always have.
 */
export const pipelinesDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    scope: {
      type: 'string',
      enum: ['global'],
      description:
        'For pipeline.run, "global" runs with no project. Omit it to run in this chat\'s task or folder.',
    },
  },
  allOf: [
    {
      if: {
        properties: { type: { const: 'pipeline.run' } },
        required: ['type'],
      },
      then: { required: ['pipelineId'] },
    },
  ],
};

/** The advertised `scope` of a host that starts every run in the cloud. */
export const cloudPipelinesDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    scope: {
      type: 'string',
      enum: ['global'],
      description:
        'For pipeline.run, "global": workflows started here run in the cloud, with no project.',
    },
  },
  allOf: [
    {
      if: {
        properties: { type: { const: 'pipeline.run' } },
        required: ['type'],
      },
      then: { required: ['pipelineId', 'scope'] },
    },
  ],
};
