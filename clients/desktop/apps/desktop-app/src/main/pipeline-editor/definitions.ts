import { z } from 'zod/v4';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { PipelineEditorToolKey } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import {
  validateAutomationActionForWrite,
  validateAutomationCreateRequest,
  validateAutomationTrigger,
} from '@canopy/desktop-shared/lib/automations';
import {
  askUserQuestionJsonSchema,
  askUserQuestionSchema,
  findScopedUiOnlyField,
  scopedDispatchActionSchema,
  type DispatchActionArgs,
} from '../canopy-tools/definitions';

export const PIPELINE_LIST_DESCRIPTION =
  'List the pipelines currently visible in the Pipelines page, including user, bundled, project, and currently loaded shared rows. Use the returned locator fields when opening a row.';

export const PIPELINE_OPEN_DESCRIPTION =
  'Open a pipeline from the visible pipeline list. Pass the source-aware locator returned by ListPipelines.';

export const PIPELINE_CREATE_DESCRIPTION =
  'Create a new draft pipeline in the live editor.';

export const PIPELINE_GET_CURRENT_DESCRIPTION =
  'Read the current live pipeline editor state, including YAML, dirty state, readonly status, and validation issues.';

export const PIPELINE_SET_YAML_DESCRIPTION =
  'Replace the live pipeline editor YAML and auto-save it to disk. Read the current state first, then submit the complete desired YAML.';

export const PIPELINE_SAVE_DESCRIPTION =
  'Save the current live pipeline draft to disk.';

export const NAVIGATION_TO_LIST_DESCRIPTION =
  'Navigate from the pipeline editor back to the pipeline list.';

export const PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION =
  'Return the raw action.yml definition (inputs, outputs, runtime) for a bundled builtin pipeline action used via "use: builtin/<name>". Accepts the name with or without the "builtin/" prefix (e.g. "agent-prompt" or "builtin/agent-prompt").';

const AUTOMATION_SCHEDULE_HELP =
  'schedule is { kind: "cron", expression: "<five cron fields>", timezone: "local" } for recurrence or { kind: "one_time", runAt: "<ISO timestamp>", timezone: "local" } for a single future run.';

const AUTOMATION_ACTION_HELP =
  'To run a workflow, action is { type: "worktree_pipeline", pipelineId, pipelineSource, inputs? }, with pipelineId and its source ("user", "bundled" or "curated") from ListPipelines. A shared workflow cannot be scheduled with this tool; ask the user to schedule it from the Workflows → Library tab. A workflow that declares scope: global uses target: { kind: "global" } and no workspaceId. Otherwise set workspaceId to the project id, which the user or an existing automation from ListAutomations supplies, and optionally target: { kind: "new_worktree" | "project" | "task", taskId }. Chat prompt actions (worktree_prompt, standalone_prompt, app_advisor_prompt) are also accepted. Agents cannot set ifCommand.';

export const AUTOMATION_LIST_DESCRIPTION =
  'List the automations (scheduled and triggered activities) in the selected owner, with their schedules, actions and, unless includeRuns is false, recent runs.';

export const AUTOMATION_GET_DESCRIPTION =
  'Read one automation by id from ListAutomations, including its schedule, action and recent runs.';

export const AUTOMATION_CREATE_DESCRIPTION = `Create an automation that runs on a schedule. Use it when the user asks to schedule a workflow or create an automation; do not write schedule YAML into a pipeline. input needs name, schedule and action; enabled defaults to true. ${AUTOMATION_SCHEDULE_HELP} ${AUTOMATION_ACTION_HELP} The result names the saved automation, which the user can view and edit on the Workflows → Library tab.`;

export const AUTOMATION_UPDATE_DESCRIPTION = `Change an existing automation by id. patch takes any of name, schedule, action and enabled; set enabled to false to pause it. Read it with GetAutomation first. ${AUTOMATION_SCHEDULE_HELP}`;

const openLocatorSchema = z
  .object({
    pipelineId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    pipelineFilePath: z.string().min(1).optional(),
    sharedRemoteId: z.string().min(1).optional(),
  })
  .refine((locator) => Boolean(locator.pipelineId ?? locator.sharedRemoteId), {
    message: 'Provide pipelineId or sharedRemoteId.',
  });

export const pipelineEditorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pipeline.list') }),
  z.object({ type: z.literal('pipeline.open'), locator: openLocatorSchema }),
  z.object({ type: z.literal('pipeline.create') }),
  z.object({ type: z.literal('pipeline.get_current') }),
  z.object({ type: z.literal('pipeline.set_yaml'), yaml: z.string() }),
  z.object({ type: z.literal('pipeline.save') }),
  z.object({ type: z.literal('navigation.to_list') }),
]);

export type PipelineEditorAction = z.infer<typeof pipelineEditorActionSchema>;

export const emptyArgsSchema = z.object({});
export const pipelineOpenSchema = openLocatorSchema;
export const pipelineSetYamlSchema = z.object({ yaml: z.string() });
export const pipelineGetActionDefinitionSchema = z.object({
  name: z.string().min(1),
});

export const automationListSchema = z
  .object({ includeRuns: z.boolean().optional() })
  .strict();
export const automationGetSchema = z.object({ id: z.string().min(1) }).strict();
export const automationCreateSchema = z
  .object({ input: z.record(z.string(), z.unknown()) })
  .strict();
export const automationUpdateSchema = z
  .object({
    id: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  })
  .strict();

/** The automation actions the Pipeline Editor assistant can dispatch. */
export type PipelineEditorAutomationAction = Extract<
  DispatchActionArgs['action'],
  {
    type:
      | 'automation.list'
      | 'automation.get'
      | 'automation.create'
      | 'automation.update'
      | 'automation.disable';
  }
>;

export type PipelineEditorAutomationToolKey = Extract<
  PipelineEditorToolKey,
  `automation_${string}`
>;

function automationRequestProblem(
  candidate: Record<string, unknown>,
): string | null {
  const uiOnlyField = findScopedUiOnlyField(candidate);
  if (uiOnlyField) return `${uiOnlyField} cannot be set by an agent.`;
  if (candidate.type === 'automation.create')
    return validateAutomationCreateRequest(candidate.input);
  const patch = candidate.patch;
  if (typeof patch !== 'object' || patch === null) return null;
  if ('schedule' in patch) {
    const scheduleError = validateAutomationTrigger(patch.schedule);
    if (scheduleError) return scheduleError;
  }
  return 'action' in patch
    ? validateAutomationActionForWrite(patch.action)
    : null;
}

/**
 * Build the shared `automation.*` action a Pipeline Editor tool stands for,
 * validated by the same schema `DispatchAction` uses, so this surface can
 * never send an automation the other agent surfaces would refuse.
 */
export function parsePipelineEditorAutomationAction(
  key: PipelineEditorAutomationToolKey,
  rawArgs: unknown,
):
  | { ok: true; action: PipelineEditorAutomationAction }
  | { ok: false; problem?: string } {
  let candidate: Record<string, unknown>;
  switch (key) {
    case 'automation_list': {
      const parsed = automationListSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false };
      candidate = { type: 'automation.list', ...parsed.data };
      break;
    }
    case 'automation_get': {
      const parsed = automationGetSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false };
      candidate = { type: 'automation.get', ...parsed.data };
      break;
    }
    case 'automation_create': {
      const parsed = automationCreateSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false };
      candidate = { type: 'automation.create', ...parsed.data };
      break;
    }
    case 'automation_update': {
      const parsed = automationUpdateSchema.safeParse(rawArgs);
      if (!parsed.success) return { ok: false };
      const { id, patch } = parsed.data;
      // A pause alone is the disable action, as the Automations page's toggle
      // is: it keeps the schedule's author and run policy, so it also pauses
      // a schedule an agent's update can't target.
      candidate =
        Object.keys(patch).length === 1 && patch.enabled === false
          ? { type: 'automation.disable', id }
          : { type: 'automation.update', id, patch };
      break;
    }
  }
  const parsed = scopedDispatchActionSchema.safeParse(candidate);
  if (parsed.success) {
    const action = parsed.data;
    if (
      action.type === 'automation.list' ||
      action.type === 'automation.get' ||
      action.type === 'automation.create' ||
      action.type === 'automation.update' ||
      action.type === 'automation.disable'
    )
      return { ok: true, action };
  }
  const problem = automationRequestProblem(candidate);
  return problem ? { ok: false, problem } : { ok: false };
}

export const emptyArgsJsonSchema: JsonValue = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export const pipelineOpenJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    pipelineId: {
      type: 'string',
      description:
        'Pipeline id from ListPipelines for user, bundled, or project rows.',
    },
    cwd: {
      type: 'string',
      description: 'Project cwd for project-sourced rows, when provided.',
    },
    pipelineFilePath: {
      type: 'string',
      description: 'On-disk pipeline file path for user/bundled/project rows.',
    },
    sharedRemoteId: {
      type: 'string',
      description:
        'Remote id for shared pipeline rows. Shared rows can be opened with this field alone.',
    },
  },
  additionalProperties: false,
};

export const pipelineSetYamlJsonSchema: JsonValue = {
  type: 'object',
  required: ['yaml'],
  properties: {
    yaml: {
      type: 'string',
      description:
        'Complete replacement pipeline YAML to put in the live editor and auto-save.',
    },
  },
  additionalProperties: false,
};

export const pipelineGetActionDefinitionJsonSchema: JsonValue = {
  type: 'object',
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      description:
        'Builtin action name, with or without the "builtin/" prefix (e.g. "agent-prompt" or "builtin/agent-prompt").',
    },
  },
  additionalProperties: false,
};

export { askUserQuestionJsonSchema, askUserQuestionSchema };

const automationScheduleJsonSchema: JsonValue = {
  type: 'object',
  description:
    '{ kind: "cron", expression, timezone: "local" } or { kind: "one_time", runAt, timezone: "local" }.',
};

const automationActionJsonSchema: JsonValue = {
  type: 'object',
  description:
    'What the automation runs, with a type such as "worktree_pipeline" to run a workflow.',
};

export const automationListJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    includeRuns: {
      type: 'boolean',
      description: 'Include recent runs. Defaults to true.',
    },
  },
  additionalProperties: false,
};

export const automationGetJsonSchema: JsonValue = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'Automation id from ListAutomations.' },
  },
  additionalProperties: false,
};

export const automationCreateJsonSchema: JsonValue = {
  type: 'object',
  required: ['input'],
  properties: {
    input: {
      type: 'object',
      required: ['name', 'schedule', 'action'],
      properties: {
        name: { type: 'string', description: 'Automation name.' },
        schedule: automationScheduleJsonSchema,
        action: automationActionJsonSchema,
        enabled: {
          type: 'boolean',
          description: 'Whether it runs on its schedule. Defaults to true.',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const automationUpdateJsonSchema: JsonValue = {
  type: 'object',
  required: ['id', 'patch'],
  properties: {
    id: { type: 'string', description: 'Automation id from ListAutomations.' },
    patch: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        schedule: automationScheduleJsonSchema,
        action: automationActionJsonSchema,
        enabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
