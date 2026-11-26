import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_TOOL_REGISTRY,
  type PipelineEditorToolKey,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolContext,
  type CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import {
  emptyArgsSchema,
  parsePipelineEditorAutomationAction,
  pipelineGetActionDefinitionSchema,
  pipelineOpenSchema,
  pipelineSetYamlSchema,
} from './definitions';
import type { PipelineEditorToolRuntime } from './runtime';

function invalidArguments(toolName: string): CanopyInjectedToolTextResult {
  return {
    text: `Invalid arguments for ${toolName}.`,
    isError: true,
  };
}

/** GetAutomation's newest runs; the rest are counted, keeping the result small. */
const GET_AUTOMATION_RUN_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withRecentRunsOnly(response: AppAdvisorActionResponse): unknown {
  const { result } = response;
  if (!isRecord(result) || !Array.isArray(result.recentRuns)) return response;
  const runs: unknown[] = result.recentRuns;
  if (runs.length <= GET_AUTOMATION_RUN_LIMIT) return response;
  return {
    ...response,
    result: {
      ...result,
      recentRuns: runs.slice(0, GET_AUTOMATION_RUN_LIMIT),
      olderRunsOmitted: runs.length - GET_AUTOMATION_RUN_LIMIT,
    },
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolResultFromRendererResponse(response: {
  ok: boolean;
  error?: string;
}): CanopyInjectedToolTextResult {
  return {
    text: jsonText(response),
    isError: response.ok !== true,
  };
}

export async function executePipelineEditorTool(
  canonicalKey: PipelineEditorToolKey,
  rawArgs: unknown,
  runtime: PipelineEditorToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  if (canonicalKey === 'ask_user_question') {
    return executeCanopyInjectedTool(canonicalKey, rawArgs, runtime, context);
  }

  if (
    canonicalKey === 'search_deferred_tools' ||
    canonicalKey === 'load_deferred_tools'
  ) {
    return executeCanopyInjectedTool(canonicalKey, rawArgs, runtime, context);
  }

  switch (canonicalKey) {
    case 'pipeline_list': {
      const parsed = emptyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('ListPipelines');
      try {
        return { text: jsonText({ pipelines: await runtime.listPipelines() }) };
      } catch (error) {
        return {
          text:
            error instanceof Error
              ? error.message
              : 'Failed to list pipelines.',
          isError: true,
        };
      }
    }
    case 'pipeline_open': {
      const parsed = pipelineOpenSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('OpenPipeline');
      return toolResultFromRendererResponse(
        await runtime.dispatchEditorAction(
          { type: 'pipeline.open', locator: parsed.data },
          context?.toolUseId,
        ),
      );
    }
    case 'pipeline_create': {
      const parsed = emptyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('CreatePipeline');
      return toolResultFromRendererResponse(
        await runtime.dispatchEditorAction(
          { type: 'pipeline.create' },
          context?.toolUseId,
        ),
      );
    }
    case 'pipeline_get_current': {
      const parsed = emptyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('GetCurrentPipeline');
      return toolResultFromRendererResponse(
        await runtime.requestEditorState(context?.toolUseId),
      );
    }
    case 'pipeline_set_yaml': {
      const parsed = pipelineSetYamlSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('SetPipelineYaml');
      return toolResultFromRendererResponse(
        await runtime.dispatchEditorAction(
          { type: 'pipeline.set_yaml', yaml: parsed.data.yaml },
          context?.toolUseId,
        ),
      );
    }
    case 'pipeline_save': {
      const parsed = emptyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('SavePipeline');
      return toolResultFromRendererResponse(
        await runtime.dispatchEditorAction(
          { type: 'pipeline.save' },
          context?.toolUseId,
        ),
      );
    }
    case 'pipeline_get_action_definition': {
      const parsed = pipelineGetActionDefinitionSchema.safeParse(rawArgs);
      if (!parsed.success)
        return invalidArguments('GetBuiltinActionDefinition');
      const result = runtime.getBuiltinActionDefinition(parsed.data.name);
      return { text: jsonText(result), isError: result.found !== true };
    }
    case 'automation_list':
    case 'automation_get':
    case 'automation_create':
    case 'automation_update': {
      const toolName = PIPELINE_EDITOR_TOOL_REGISTRY[canonicalKey].displayName;
      const parsed = parsePipelineEditorAutomationAction(canonicalKey, rawArgs);
      if (!parsed.ok)
        return parsed.problem
          ? {
              text: `Invalid arguments for ${toolName}: ${parsed.problem}`,
              isError: true,
            }
          : invalidArguments(toolName);
      const response = await runtime.dispatchAutomationAction(parsed.action, {
        ...(context?.toolUseId ? { requestId: context.toolUseId } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      return {
        text: jsonText(
          canonicalKey === 'automation_get'
            ? withRecentRunsOnly(response)
            : response,
        ),
        isError: response.ok !== true,
      };
    }
    case 'navigation_to_list': {
      const parsed = emptyArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('NavigateToPipelineList');
      return toolResultFromRendererResponse(
        await runtime.dispatchEditorAction(
          { type: 'navigation.to_list' },
          context?.toolUseId,
        ),
      );
    }
    default: {
      const exhaustive: never = canonicalKey;
      return {
        text: `Unhandled Pipeline Editor tool key: ${String(exhaustive)}.`,
        isError: true,
      };
    }
  }
}
