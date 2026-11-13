import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AutomationAction,
} from '../../types';
import type { AutomationSessionTargetKind } from '../automation-target';
import type { AutomationPipelineResolution } from '@canopy/pipeline-interop/automation-target';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  loadAutomationPipelineDocument,
  loadPipelineDocument,
} from './pipeline-document';
import type { PipelineReadPort } from './port';

const PIPELINE_UNREADABLE = 'The selected workflow could not be read.';

/** Maps a project row's `type` to a session target kind; unknown → undefined. */
export function projectTypeToSessionTargetKind(
  type: unknown,
): AutomationSessionTargetKind | undefined {
  return type === 'cowork' || type === 'single-repo' || type === 'multi-repo'
    ? type
    : undefined;
}

/**
 * Resolve the kind of project a local session prompt is bound to. Missing or
 * unreadable projects return `undefined` so the share builder blocks with
 * `session_target_unresolved` instead of guessing a destination.
 */
export async function resolveSessionTargetKind(
  port: PipelineReadPort,
  action: Extract<AutomationAction, { type: 'worktree_session_prompt' }>,
): Promise<AutomationSessionTargetKind | undefined> {
  if (action.workspaceId === APP_ADVISOR_PROJECT_ID) return 'app_advisor';
  if (action.workspaceId === STANDALONE_CHAT_PROJECT_ID) return 'cowork';
  try {
    const { items } = await port.api.loadProjects();
    return projectTypeToSessionTargetKind(
      items.find((project) => project.id === action.workspaceId)?.type,
    );
  } catch {
    return undefined;
  }
}

function errorResolution(
  error: unknown,
  fallback = PIPELINE_UNREADABLE,
): AutomationPipelineResolution {
  return {
    status: 'error',
    error: error instanceof Error && error.message ? error.message : fallback,
  };
}

/** Parse raw pipeline YAML into a resolution; parse failures are errors. */
export function pipelineResolutionFromRaw(
  rawPipeline: string,
): AutomationPipelineResolution {
  try {
    return { status: 'resolved', scopes: parsePipelineText(rawPipeline).scope };
  } catch (error) {
    return errorResolution(error);
  }
}

/**
 * Read the scopes of the pipeline a local automation runs. Missing or
 * unreadable definitions are errors, never evidence of compatibility.
 */
export async function resolveAutomationPipelineScopes(
  port: PipelineReadPort,
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
): Promise<AutomationPipelineResolution> {
  try {
    if (action.pipelineSource === 'shared') {
      const remoteId = action.sharedPipeline?.remoteId;
      if (!remoteId) return { status: 'error', error: PIPELINE_UNREADABLE };
      const resolved =
        await port.api.automations.resolveSharedPipelineInstallPin({
          remoteId,
        });
      return pipelineResolutionFromRaw(resolved.rawPipeline);
    }
    const result =
      action.pipelineSource === 'user' || action.pipelineSource === 'project'
        ? await loadAutomationPipelineDocument(port, action)
        : await loadPipelineDocument(port, {
            pipelineId: action.pipelineId,
            ...(action.pipelineSource
              ? { pipelineSource: action.pipelineSource }
              : {}),
          });
    return result.data
      ? { status: 'resolved', scopes: result.data.content.scope }
      : { status: 'error', error: result.error ?? PIPELINE_UNREADABLE };
  } catch (error) {
    return errorResolution(error);
  }
}
