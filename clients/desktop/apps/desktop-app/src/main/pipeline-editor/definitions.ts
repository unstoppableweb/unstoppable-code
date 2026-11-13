import { z } from 'zod/v4';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import {
  askUserQuestionJsonSchema,
  askUserQuestionSchema,
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
