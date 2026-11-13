import { z } from 'zod';
import {
  PipelineDefinitionGetResultSchema,
  PipelineDefinitionListResultSchema,
  type PipelineDefinition,
  type PipelineDefinitionListResult,
  type PipelineDefinitionSummary,
} from '@canopy/protocol/canopy-core';
import type { PortalPipelineInputDefinition } from '@canopy/protocol/portal';
import type { CoreCoworkInvoker } from '../core-cowork/invoker';
import { requestCloud } from './request';

/**
 * The workflows a cloud run can use (CAN-6341, plan CP-39), read from the
 * web core's `core.pipeline.definition.list` and `.get`: curated ones and
 * the shared ones the account may read. A workflow on a desktop or in a
 * checkout isn't among them until the cloud runner carries it (CP-29).
 */

/** The sources a cloud run can start from. */
export const CLOUD_RUN_DEFINITION_SOURCES = ['curated', 'shared'] as const;

/** Reads one page of the workflows a cloud run can use. */
export function listCloudRunDefinitions(
  invoker: CoreCoworkInvoker,
  { cursor, query }: { readonly cursor?: string; readonly query?: string } = {},
): Promise<PipelineDefinitionListResult> {
  return requestCloud(
    invoker,
    'core.pipeline.definition.list',
    {
      sources: [...CLOUD_RUN_DEFINITION_SOURCES],
      ...(cursor === undefined ? {} : { cursor }),
      ...(query === undefined || query === '' ? {} : { query }),
    },
    PipelineDefinitionListResultSchema,
  );
}

/** Reads one workflow with its document and normalized form. */
export async function readCloudRunDefinition(
  invoker: CoreCoworkInvoker,
  definitionId: string,
): Promise<PipelineDefinition> {
  const result = await requestCloud(
    invoker,
    'core.pipeline.definition.get',
    { definitionId },
    PipelineDefinitionGetResultSchema,
  );
  return result.definition;
}

/**
 * The trigger a manual cloud run of this workflow starts from: `dispatch`,
 * else `workflow` for one only another workflow calls; null for one that
 * needs a plan or a task, which the Run dialog doesn't take.
 */
export function cloudRunEventName(
  definition: Pick<PipelineDefinitionSummary, 'triggerTypes'>,
): 'dispatch' | 'workflow' | null {
  if (definition.triggerTypes.includes('dispatch')) return 'dispatch';
  if (definition.triggerTypes.includes('workflow')) return 'workflow';
  return null;
}

const InputDefinitionSchema = z.looseObject({
  description: z.string().optional(),
  required: z.boolean().optional(),
  // A `json` input may default to an array, an object or null.
  default: z.unknown().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  'hint-hide-ui-option': z.boolean().optional(),
});

const TriggerInputsSchema = z.looseObject({
  trigger_inputs: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
});

type FieldType = NonNullable<PortalPipelineInputDefinition['type']>;
const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'boolean',
  'number',
  'choice',
];

function fieldType(type: string | undefined): FieldType {
  return FIELD_TYPES.find((known) => known === type) ?? 'string';
}

/**
 * A default as its field shows it. A `json` input's is its JSON text, as
 * desktop's Run dialog starts it (a string default quoted), so the value it
 * sends parses back to the declared default; any other structured one is
 * JSON too.
 */
function fieldDefault(
  type: string | undefined,
  value: unknown,
): PortalPipelineInputDefinition['default'] {
  if (value === undefined) return undefined;
  if (type === 'json') return JSON.stringify(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  return JSON.stringify(value);
}

/**
 * The inputs a cloud run of this workflow takes, as the shared input fields
 * render them. A type the fields don't know, such as `json`, is typed as
 * text; the web core checks the value when the run starts.
 */
export function cloudRunInputDefinitions(
  definition: Pick<PipelineDefinition, 'normalized' | 'triggerTypes'>,
): Record<string, PortalPipelineInputDefinition> {
  const eventName = cloudRunEventName(definition);
  const parsed = TriggerInputsSchema.safeParse(definition.normalized);
  if (eventName === null || !parsed.success) return {};
  const inputs = parsed.data.trigger_inputs?.[eventName] ?? {};
  // One input at a time, so one the fields can't read never hides the rest.
  return Object.fromEntries(
    Object.entries(inputs).flatMap(([name, raw]) => {
      const read = InputDefinitionSchema.safeParse(raw);
      if (!read.success) return [];
      const input = read.data;
      const fallback = fieldDefault(input.type, input.default);
      const field: PortalPipelineInputDefinition = {
        type: fieldType(input.type),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.min === undefined ? {} : { min: input.min }),
        ...(input.max === undefined ? {} : { max: input.max }),
        ...(input['hint-hide-ui-option'] === undefined
          ? {}
          : { 'hint-hide-ui-option': input['hint-hide-ui-option'] }),
      };
      return [[name, field]];
    }),
  );
}
