import { randomUUID } from 'node:crypto';
import {
  canopyJsonValueSchemaWithin,
  INTERFACE_TOOL_INPUT_MAX_BYTES,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_SURFACE_REQUEST_ACTION_TYPES,
  appAdvisorActionDisposition,
} from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorRendererToolRequest,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import {
  getSessionInterfaceToolRegistry,
  interfaceToolAudience,
  interfaceToolAudienceOf,
} from '../agents/interface-tool-binding';
import { noteAgentRequestedEditorSave } from '../pipelines/agent-editor-save';
import {
  interfaceToolOutcomeToRendererResponse,
  setLatestAppAdvisorUiState,
  surfaceUnavailableResponse,
} from '../ipc/app-advisor';

const PRESENTATION_ONLY_MESSAGE =
  'Only navigation, panel and window actions run through this tool.';

const actionInputSchema = canopyJsonValueSchemaWithin(
  INTERFACE_TOOL_INPUT_MAX_BYTES,
);

/** The interface tools the live session of this App Advisor chat was created with. */
export async function boundAppAdvisorInterfaceTools(
  destination: AppAdvisorWatcherDestination,
): Promise<readonly InterfaceToolName[]> {
  const { getActiveSessionCapabilityProfile } =
    await import('../agents/session-manager');
  return (
    getActiveSessionCapabilityProfile(
      destination.projectId,
      destination.worktreeId,
      destination.chatId,
    )?.interfaceTools ?? []
  );
}

function isPresentation(action: AppAdvisorAction, guarded: boolean): boolean {
  if (action.type === 'worktree-chat.open_tab') return Boolean(action.chatId);
  const disposition = appAdvisorActionDisposition(action.type);
  if (disposition?.kind === 'presentation') return true;
  return (
    guarded &&
    disposition?.kind === 'core' &&
    disposition.access === 'write' &&
    disposition.presentationWhenGuarded === true
  );
}

/**
 * CAN-4133 D8: one presentation action, served by the main window's lease.
 * A chat driven from another computer is served by that computer's window
 * lease (CAN-5823). Unbound or without a registry: today's
 * surface_unavailable response, no delivery.
 */
export async function presentAppAdvisorAction(input: {
  action: AppAdvisorAction;
  requestId?: string;
  expectedUiRevision?: number;
  destination: AppAdvisorWatcherDestination;
  /** The calling session's or route's bound interface tools; looked up from SDK sessions when absent. */
  boundTools?: readonly InterfaceToolName[];
  /** A core write whose guard failed (CAN-5999 D3), applied in the window instead. */
  guarded?: true;
  /**
   * A CAN-6008 surface request: a core write the main window hands to its
   * mounted Settings surface. Only the local lease serves it, never a route.
   */
  surfaceRequest?: true;
  signal?: AbortSignal;
}): Promise<AppAdvisorActionResponse> {
  const { action, destination, expectedUiRevision, signal } = input;
  const requestId = input.requestId ?? randomUUID();
  const surfaceRequest =
    input.surfaceRequest === true &&
    APP_ADVISOR_SURFACE_REQUEST_ACTION_TYPES.has(action.type);
  if (!surfaceRequest && !isPresentation(action, input.guarded === true))
    return {
      requestId,
      ok: false,
      error: { code: 'unsupported_action', message: PRESENTATION_ONLY_MESSAGE },
    };
  const request: AppAdvisorRendererToolRequest = {
    kind: 'dispatch_action',
    requestId,
    action,
    originWorktreeId: destination.worktreeId,
    originProjectId: destination.projectId,
    originChatTabId: destination.chatId,
    ...(expectedUiRevision !== undefined ? { expectedUiRevision } : {}),
  };
  // CAN-6008: a surface request is served only by this computer's main
  // window, never by a window lease of a computer driving this chat.
  if (surfaceRequest && interfaceToolAudience(destination.chatId) !== undefined)
    return { ...surfaceUnavailableResponse(request), requestId };
  const registry = getSessionInterfaceToolRegistry();
  const bound = (
    input.boundTools ?? (await boundAppAdvisorInterfaceTools(destination))
  ).includes('ui.app_advisor.present');
  if (!registry || !bound)
    return { ...surfaceUnavailableResponse(request), requestId };
  const serialized: unknown = JSON.parse(JSON.stringify(action));
  const actionInput = actionInputSchema.safeParse(serialized);
  if (!actionInput.success)
    return {
      requestId,
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'The action is too large to send to the window.',
      },
    };
  const audience = interfaceToolAudienceOf(destination.chatId);
  // CAN-7228: the editor save this presses is the agent's, not the person's.
  if (action.type === 'pipeline.save') noteAgentRequestedEditorSave();
  const outcome = await registry.invoke({
    toolName: 'ui.app_advisor.present',
    input: {
      action: actionInput.data,
      originWorktreeId: destination.worktreeId,
      originProjectId: destination.projectId,
      originChatTabId: destination.chatId,
      ...(expectedUiRevision !== undefined ? { expectedUiRevision } : {}),
    },
    scope: {
      workspaceId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
    },
    ...audience,
    ...(signal ? { signal } : {}),
  });
  const response = interfaceToolOutcomeToRendererResponse(outcome, request);
  // A controlling computer's window describes that window, not this
  // computer's screen, so its state never becomes this computer's.
  if (response.ok && response.uiState && audience.audience === undefined)
    setLatestAppAdvisorUiState(response.uiState);
  return { ...response, requestId };
}
