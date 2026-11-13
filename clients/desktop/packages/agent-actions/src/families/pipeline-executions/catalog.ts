import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import type { AgentActionHostCapabilities } from '../../surface/capabilities';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import { pipelineRunsCloudOnly } from '../pipelines/catalog';
import { WORKTREE_LABEL } from '@canopy/protocol/ui-labels';
import type {
  PipelineExecutionAction,
  PipelineExecutionsActionType,
} from './actions';

/**
 * An execution action as a catalog example shows it. Orchestrator names a
 * task with `projectId` and `worktreeId`; chat surfaces hide both.
 */
export type PipelineExecutionCatalogExample =
  | Exclude<
      PipelineExecutionAction,
      {
        type:
          | 'pipeline.execution_list_for_worktree'
          | 'pipeline.execution_list';
      }
    >
  | (Extract<
      PipelineExecutionAction,
      { type: 'pipeline.execution_list_for_worktree' }
    > & { projectId: string; worktreeId: string })
  | (Extract<PipelineExecutionAction, { type: 'pipeline.execution_list' }> & {
      projectId?: string;
      worktreeId?: string;
    });

export type PipelineExecutionCatalogEntry = AgentActionCatalogEntry<
  PipelineExecutionsActionType,
  PipelineExecutionCatalogExample
>;

function field(
  name: string,
  type: string,
  required: boolean,
  description: string,
): AgentActionField {
  return { name, type, required, description };
}

const EXECUTION_FIELD: AgentActionField = {
  name: 'executionId',
  type: 'string',
  required: true,
  description: 'Pipeline execution id.',
};

const PROJECT_FIELD: AgentActionField = {
  name: 'projectId',
  type: 'string',
  required: true,
  description: 'Project/workspace id from current UI state.',
};

const WORKTREE_FIELD: AgentActionField = {
  name: 'worktreeId',
  type: 'string',
  required: true,
  description: 'Worktree id from current UI state.',
};

/**
 * The execution actions' rows before Orchestrator's report and plan actions,
 * in its order, which its search ranking ties depend on. Orchestrator names a
 * task with `projectId` and `worktreeId`; chat surfaces hide both, since the
 * calling chat is the task. Named arrays, so the backend surface census
 * inventories the rows Orchestrator spreads.
 */
export const PIPELINE_EXECUTION_ACTION_CATALOG: readonly PipelineExecutionCatalogEntry[] =
  [
    {
      type: 'pipeline.execution_list_for_worktree',
      category: 'pipeline',
      summary: `List pipeline executions for a specific ${WORKTREE_LABEL} entry (worktree), with filters for fuzzy name, pipeline id, and status.`,
      fields: [
        PROJECT_FIELD,
        WORKTREE_FIELD,
        field('query', 'string', false, 'Fuzzy pipeline name/id filter.'),
        field('pipelineId', 'string', false, 'Exact pipeline id filter.'),
        field('status', 'ExecutionState.status', false, 'Status filter.'),
        field('limit', 'number', false, 'Maximum rows to return.'),
      ],
      example: {
        type: 'pipeline.execution_list_for_worktree',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        status: 'failure',
      },
      keywords: [
        'pipeline',
        'execution',
        'history',
        'list',
        'worktree',
        'code',
      ],
    },
    {
      type: 'pipeline.execution_list',
      category: 'pipeline',
      summary:
        'List pipeline executions globally, optionally filtered by workspace/worktree, fuzzy name, pipeline id, or status. With runOn "cloud", list cloud runs instead.',
      fields: [
        field('projectId', 'string', false, 'Project/workspace id.'),
        field('worktreeId', 'string', false, 'Worktree id.'),
        field('query', 'string', false, 'Fuzzy pipeline name/id filter.'),
        field('pipelineId', 'string', false, 'Exact pipeline id filter.'),
        field('status', 'ExecutionState.status', false, 'Status filter.'),
        field('limit', 'number', false, 'Maximum rows to return.'),
        field(
          'runOn',
          "'local' | 'cloud'",
          false,
          'Set "cloud" to list the newest cloud runs (at most 100), such as those pipeline.run started with runOn "cloud", without projectId or worktreeId. A chat lists its owner\'s cloud runs. Rows carry location "cloud", and complete is false when more were left unread. Omit it for runs on this computer.',
        ),
      ],
      example: {
        type: 'pipeline.execution_list',
        projectId: 'project-1',
        status: 'running',
      },
      additionalExamples: [
        { type: 'pipeline.execution_list', runOn: 'cloud', status: 'paused' },
      ],
      keywords: ['pipeline', 'execution', 'history', 'list', 'global', 'cloud'],
    },
    {
      type: 'pipeline.execution_get',
      category: 'pipeline',
      summary:
        "Inspect/monitor one pipeline execution with status, timing, job summaries, and optional report/plan content. For a cloud run's id, it answers the cloud run's summary and jobs, with pending pauses and status reasons as JSON text (pendingPausesJson, statusReasonsJson); report and plan content stay in the Runs list.",
      fields: [
        EXECUTION_FIELD,
        field('includeReport', 'boolean', false, 'Include report content.'),
        field('includePlan', 'boolean', false, 'Include plan file content.'),
        field('maxChars', 'number', false, 'Maximum report/plan characters.'),
      ],
      example: {
        type: 'pipeline.execution_get',
        executionId: 'execution-1',
        includeReport: true,
      },
      keywords: ['pipeline', 'execution', 'inspect', 'monitor', 'status'],
    },
    {
      type: 'pipeline.execution_cancel',
      category: 'pipeline',
      summary:
        'Cancel a running or cancellable pipeline execution, on this computer or in the cloud.',
      fields: [EXECUTION_FIELD],
      example: {
        type: 'pipeline.execution_cancel',
        executionId: 'execution-1',
      },
      keywords: ['pipeline', 'execution', 'cancel', 'stop'],
    },
    {
      type: 'pipeline.execution_retry_matrix_job',
      category: 'pipeline',
      summary:
        'Retry all, failed, or selected variants of a terminal matrix job, or retry a failed dynamic expansion.',
      fields: [
        EXECUTION_FIELD,
        field('jobId', 'string', true, 'Logical matrix job id.'),
        field(
          'mode',
          "'all' | 'failed' | 'variants' | 'expansion'",
          true,
          'Which matrix work to retry.',
        ),
        field(
          'variantJobIds',
          'string[]',
          false,
          'Required physical variant ids when mode is variants.',
        ),
      ],
      example: {
        type: 'pipeline.execution_retry_matrix_job',
        executionId: 'execution-1',
        jobId: 'review',
        mode: 'failed',
      },
      keywords: ['pipeline', 'matrix', 'retry', 'failed', 'variant'],
    },
    {
      type: 'pipeline.execution_cancel_matrix_variant',
      category: 'pipeline',
      summary: 'Cancel one queued or running matrix variant.',
      fields: [
        EXECUTION_FIELD,
        field('jobId', 'string', true, 'Logical matrix job id.'),
        field('variantJobId', 'string', true, 'Physical matrix variant id.'),
      ],
      example: {
        type: 'pipeline.execution_cancel_matrix_variant',
        executionId: 'execution-1',
        jobId: 'review',
        variantJobId: '__matrix__review__0',
      },
      keywords: ['pipeline', 'matrix', 'cancel', 'stop', 'variant'],
    },
    {
      type: 'pipeline.execution_resume',
      category: 'pipeline',
      summary:
        'Resume an observed pipeline pause, on this computer or in the cloud, as an automation-initiated action by selecting recovery reasons or answering requested inputs.',
      fields: [
        EXECUTION_FIELD,
        field(
          'statusReasonIds',
          'string[]',
          false,
          'Non-empty unique status-reason ids from pipeline.execution_get or current UI state. Required when pauseResponses is omitted.',
        ),
        field(
          'pauseResponses',
          'Array<{ checkpointId: string; jobId: string; stepId: string; answers?: Record<string, string | number | boolean> }>',
          false,
          'Responses for input requests reported by pipeline.execution_get. Required when statusReasonIds is omitted. Every response requires the exact checkpointId so stale answers cannot target a newer pause. Agent-submitted answers are intentionally recorded as automation-initiated, not as proof of human approval.',
        ),
      ],
      example: {
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      },
      additionalExamples: [
        {
          type: 'pipeline.execution_resume',
          executionId: 'execution-1',
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review',
              stepId: 'approval',
              answers: { reviewer: 'Ada' },
            },
          ],
        },
      ],
      keywords: [
        'pipeline',
        'execution',
        'resume',
        'paused',
        'recover',
        'status reason',
        'input request',
        'pause response',
      ],
    },
    {
      type: 'pipeline.execution_retry',
      category: 'pipeline',
      summary:
        "Retry a failed or cancelled root pipeline execution in place. A cloud run can't be retried yet: start it again with pipeline.run.",
      fields: [EXECUTION_FIELD],
      example: { type: 'pipeline.execution_retry', executionId: 'execution-1' },
      keywords: ['pipeline', 'execution', 'retry'],
    },
  ];

/** The follow-up chain row, after Orchestrator's report and plan actions. */
export const PIPELINE_EXECUTION_CHAIN_ACTION_CATALOG: readonly PipelineExecutionCatalogEntry[] =
  [
    {
      type: 'pipeline.execution_chain',
      category: 'pipeline',
      summary:
        'Run a plan_ready follow-up pipeline using the plan produced by another execution.',
      fields: [
        EXECUTION_FIELD,
        field('pipelineId', 'string', true, 'Follow-up pipeline id to run.'),
        field(
          'inputs',
          'Record<string,string>',
          false,
          'Follow-up pipeline input values.',
        ),
        field(
          'repoId',
          'string',
          false,
          'Optional repo id for source-backed project execution cwd.',
        ),
      ],
      example: {
        type: 'pipeline.execution_chain',
        executionId: 'execution-1',
        pipelineId: 'implement-plan',
      },
      keywords: ['pipeline', 'execution', 'chain', 'follow up', 'plan_ready'],
    },
  ];

/** Every execution row, as chat surfaces list them. */
export function pipelineExecutionsActionCatalog(): readonly PipelineExecutionCatalogEntry[] {
  return [
    ...PIPELINE_EXECUTION_ACTION_CATALOG,
    ...PIPELINE_EXECUTION_CHAIN_ACTION_CATALOG,
  ];
}

/**
 * The execution actions as a cloud chat dispatches them: on the cloud runs
 * the calling chat started, which run with no project.
 */
function cloudPipelineExecutionsActionCatalog(): readonly PipelineExecutionCatalogEntry[] {
  const listFields = [
    field('query', 'string', false, 'Fuzzy workflow name or id filter.'),
    field('pipelineId', 'string', false, 'Exact workflow id filter.'),
    field(
      'status',
      "'pending' | 'running' | 'paused' | 'success' | 'failure' | 'cancelled'",
      false,
      'Status filter.',
    ),
    field('limit', 'number', false, 'Maximum rows to return (at most 100).'),
  ];
  const keywords = ['pipeline', 'workflow', 'execution', 'run', 'cloud'];
  return [
    {
      type: 'pipeline.execution_list',
      category: 'pipeline',
      summary:
        'List the workflow runs this chat started in the cloud, newest first, optionally filtered by fuzzy name, workflow id, or status.',
      fields: listFields,
      example: { type: 'pipeline.execution_list', status: 'running' },
      keywords: [...keywords, 'list', 'history'],
    },
    {
      type: 'pipeline.execution_get',
      category: 'pipeline',
      summary:
        'Read one workflow run this chat started: its status, timing, jobs and matrix variants, error, and any pause waiting for an answer. Pending pauses and status reasons come as JSON text (pendingPausesJson, statusReasonsJson), with the ids pipeline.execution_resume takes.',
      fields: [EXECUTION_FIELD],
      example: { type: 'pipeline.execution_get', executionId: 'execution-1' },
      keywords: [...keywords, 'inspect', 'status', 'monitor'],
    },
    {
      type: 'pipeline.execution_cancel',
      category: 'pipeline',
      summary: 'Cancel a workflow run this chat started.',
      fields: [EXECUTION_FIELD],
      example: {
        type: 'pipeline.execution_cancel',
        executionId: 'execution-1',
      },
      keywords: [...keywords, 'cancel', 'stop'],
    },
    {
      type: 'pipeline.execution_resume',
      category: 'pipeline',
      summary:
        'Resume a paused workflow run this chat started, by selecting recovery reasons or answering its input requests. The resume is recorded as automation-initiated.',
      fields: [
        EXECUTION_FIELD,
        field(
          'statusReasonIds',
          'string[]',
          false,
          'Status-reason ids from pipeline.execution_get. Required when pauseResponses is omitted.',
        ),
        field(
          'pauseResponses',
          'Array<{ checkpointId: string; jobId: string; stepId: string; answers?: Record<string, string | number | boolean> }>',
          false,
          'Answers to the input requests pipeline.execution_get reports, each with its exact checkpointId. Required when statusReasonIds is omitted. Agent answers are recorded as automation-initiated, not as proof of human approval.',
        ),
      ],
      example: {
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      },
      keywords: [...keywords, 'resume', 'paused', 'recover', 'input request'],
    },
  ];
}

/** The execution rows for where a host's runs go. */
export function pipelineExecutionsActionCatalogFor(
  capabilities: Pick<AgentActionHostCapabilities, 'pipelineRunLocations'>,
): readonly PipelineExecutionCatalogEntry[] {
  return pipelineRunsCloudOnly(capabilities)
    ? cloudPipelineExecutionsActionCatalog()
    : pipelineExecutionsActionCatalog();
}

/**
 * The execution actions' fields come from SearchActions, as desktop's
 * legacy actions' always have; nothing more is advertised.
 */
export const pipelineExecutionsDispatchJsonSchema: AgentActionFamilyJsonSchema =
  { properties: {} };
