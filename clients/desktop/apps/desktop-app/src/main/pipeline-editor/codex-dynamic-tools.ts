import {
  PIPELINE_EDITOR_TOOL_ENTRIES,
  getCanonicalPipelineEditorToolKey,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type { DynamicToolCallParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type { CanopyInjectedToolContext } from '../canopy-tools/core';
import { defineCodexFunctionToolSpec } from '../codex/dynamic-tool-spec';
import { ASK_USER_QUESTION_DESCRIPTION } from '../canopy-tools/definitions';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
import {
  NAVIGATION_TO_LIST_DESCRIPTION,
  PIPELINE_CREATE_DESCRIPTION,
  PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
  PIPELINE_GET_CURRENT_DESCRIPTION,
  PIPELINE_LIST_DESCRIPTION,
  PIPELINE_OPEN_DESCRIPTION,
  PIPELINE_SAVE_DESCRIPTION,
  PIPELINE_SET_YAML_DESCRIPTION,
  askUserQuestionJsonSchema,
  emptyArgsJsonSchema,
  pipelineGetActionDefinitionJsonSchema,
  pipelineOpenJsonSchema,
  pipelineSetYamlJsonSchema,
} from './definitions';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { PipelineEditorToolRuntime } from './runtime';
import { isPipelineEditorToolAdvertised } from './tool-advertisement';
import { executePipelineEditorTool } from './tool-executor';

const descriptions = {
  ask_user_question: ASK_USER_QUESTION_DESCRIPTION,
  pipeline_list: PIPELINE_LIST_DESCRIPTION,
  pipeline_open: PIPELINE_OPEN_DESCRIPTION,
  pipeline_create: PIPELINE_CREATE_DESCRIPTION,
  pipeline_get_current: PIPELINE_GET_CURRENT_DESCRIPTION,
  pipeline_set_yaml: PIPELINE_SET_YAML_DESCRIPTION,
  pipeline_save: PIPELINE_SAVE_DESCRIPTION,
  pipeline_get_action_definition: PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
  navigation_to_list: NAVIGATION_TO_LIST_DESCRIPTION,
  search_deferred_tools: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  load_deferred_tools: LOAD_DEFERRED_TOOLS_DESCRIPTION,
} as const;

const schemas = {
  ask_user_question: askUserQuestionJsonSchema,
  pipeline_list: emptyArgsJsonSchema,
  pipeline_open: pipelineOpenJsonSchema,
  pipeline_create: emptyArgsJsonSchema,
  pipeline_get_current: emptyArgsJsonSchema,
  pipeline_set_yaml: pipelineSetYamlJsonSchema,
  pipeline_save: emptyArgsJsonSchema,
  pipeline_get_action_definition: pipelineGetActionDefinitionJsonSchema,
  navigation_to_list: emptyArgsJsonSchema,
  search_deferred_tools: searchDeferredToolsJsonSchema,
  load_deferred_tools: loadDeferredToolsJsonSchema,
} as const;

/** Tools that need the editor window are listed only when the session bound them (CAN-5822). */
export function buildPipelineEditorDynamicToolSpecs(options: {
  interfaceTools: readonly InterfaceToolName[];
}): DynamicToolSpec[] {
  return PIPELINE_EDITOR_TOOL_ENTRIES.filter((entry) =>
    isPipelineEditorToolAdvertised(entry.canonicalKey, options.interfaceTools),
  ).map((entry) =>
    defineCodexFunctionToolSpec({
      name: entry.codexToolName,
      description: descriptions[entry.canonicalKey],
      inputSchema: schemas[entry.canonicalKey],
    }),
  );
}

export async function handlePipelineEditorDynamicToolCall(
  params: DynamicToolCallParams,
  runtime: PipelineEditorToolRuntime,
  context?: Pick<CanopyInjectedToolContext, 'signal'>,
): Promise<DynamicToolCallResponse> {
  const canonicalKey = getCanonicalPipelineEditorToolKey(params.tool);
  if (!canonicalKey) {
    return {
      contentItems: [
        {
          type: 'inputText',
          text: `Unsupported Pipeline Editor dynamic tool: ${params.tool}`,
        },
      ],
      success: false,
    };
  }

  const result = await executePipelineEditorTool(
    canonicalKey,
    params.arguments,
    runtime,
    {
      toolUseId: `codex-${params.callId}`,
      ...(context?.signal ? { signal: context.signal } : {}),
    },
  );

  return {
    contentItems: [{ type: 'inputText', text: result.text }],
    success: result.isError !== true,
  };
}
