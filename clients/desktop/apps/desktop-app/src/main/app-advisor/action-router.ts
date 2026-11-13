import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import { z } from 'zod';
import { scriptPreferencesActionSchema } from '@canopy/agent-actions/families/settings/script-preferences';
import type { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import { executeDesktopAgentActionTool } from '../agent-actions/desktop-surface';
import { dispatchDesktopEditorSetupReview } from '../agent-actions/desktop-editor-setup-port';
import { dispatchDesktopCloudChats } from '../agent-actions/desktop-cloud-chats-port';
import { dispatchDesktopScriptPreferences } from '../agent-actions/desktop-script-preferences-port';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import { getAppAdvisorHomeDir } from '../lib/paths';
import type { BrowserWindow } from 'electron';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  AgentResourceAction,
  AgentResourceActionRuntime,
} from '../canopy-tools/resource-actions';
import { readLocalFileContent } from '../ipc/file-preview';
import { routeRendererToolRequest } from '../ipc/app-advisor';
import { localMainWindowServes } from '../agents/interface-tool-binding';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateAbsolutePath, validateId } from '../lib/validation';
import {
  appAdvisorActionCaller,
  missingAppAdvisorGrants,
} from './action-caller';
import {
  appAdvisorActionSchema,
  type dispatchActionSchema,
} from './definitions';
import { presentAppAdvisorAction } from './presentation-tools';
import type { AppAdvisorToolRuntime } from './runtime';
import {
  appAdvisorPipelineRunDispatch,
  type AppAdvisorToolContext,
} from './tool-executor';

export interface AppAdvisorActionCall {
  /** The provider's tool call id (getDispatchRequestId); undefined when the provider gave none. */
  readonly toolUseId: string | undefined;
  readonly expectedUiRevision?: number;
  readonly context?: AppAdvisorToolContext;
}

/** The model-visible texts this module adds (tests import them). */
export const APP_ADVISOR_ACTION_TEXTS: {
  readonly unknownType: (type: string) => string;
  readonly missingGrant: string;
  readonly conflict: string;
  readonly interrupted: string;
  readonly unrecorded: string;
  readonly coreReachedRenderer: (type: string) => string;
  readonly replayTooLarge: string;
  readonly legacyNeedsWindow: string;
  readonly hostPresentationNeedsWindow: string;
} = Object.freeze({
  unknownType: (type: string): string => `${type} is not available here.`,
  missingGrant: 'App Advisor is not allowed to run this action.',
  conflict:
    'This tool call was already used for a different action. Send the action again as a new tool call.',
  interrupted:
    'This action was interrupted or its result has expired. Check the current state before trying again.',
  unrecorded: 'The action could not be recorded, so it was not run. Try again.',
  coreReachedRenderer: (type: string): string =>
    `${type} did not reach its core executor.`,
  replayTooLarge:
    'This action already ran. Its result was too large to keep for a repeat; check the current state.',
  legacyNeedsWindow: `This action runs in the ${BRAND.displayName} window, which is not open. Open the app and try again.`,
  hostPresentationNeedsWindow: `This action opens part of the ${BRAND.displayName} window, which is not open.`,
});

const REPLAY_TEXT_LIMIT = 65_536;

type RecordedText = { [key: string]: CanopyJsonValue; text: string };

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Every action DispatchAction's schema accepts, shared-engine families included. */
export type AppAdvisorDispatchPayload = z.output<
  typeof dispatchActionSchema
>['action'];

function respond(
  response: AppAdvisorActionResponse,
): CanopyInjectedToolTextResult {
  return { text: jsonText(response), isError: response.ok !== true };
}

function recorded(result: CanopyInjectedToolTextResult): RecordedText {
  return {
    text: result.text,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

function decodeTextResult(outcome: unknown): RecordedText | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const keys = Object.keys(outcome);
  if (keys.some((key) => key !== 'text' && key !== 'isError')) return null;
  if (!('text' in outcome) || typeof outcome.text !== 'string') return null;
  if ('isError' in outcome) {
    if (typeof outcome.isError !== 'boolean') return null;
    return { text: outcome.text, isError: outcome.isError };
  }
  return { text: outcome.text };
}

function toolResult(result: RecordedText): CanopyInjectedToolTextResult {
  return {
    text: result.text,
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
  };
}

/** The renderer read a workflow file from any absolute path, with these limits. */
async function readPipelineYamlFile(yamlFilePath: string): Promise<string> {
  validateAbsolutePath(yamlFilePath, 'yamlFilePath');
  const file = await readLocalFileContent(yamlFilePath);
  if (file.truncated)
    throw new Error(
      `Pipeline YAML file ${yamlFilePath} exceeds the readable file size limit.`,
    );
  if (file.kind !== 'text' && file.kind !== 'markdown')
    throw new Error(
      `Pipeline YAML file ${yamlFilePath} is not a supported text file.`,
    );
  return file.content;
}

/**
 * The resource executor's action and scope. Workflow files and an explicit
 * task are resolved here as the renderer resolved them, so the executor sees
 * inline YAML and the target worktree; the advisor stays the author.
 */
async function resourceDispatch(
  action: AgentResourceAction,
  target: { projectId?: string; worktreeId?: string },
  runtime: AppAdvisorToolRuntime,
): Promise<{
  action: AgentResourceAction;
  runtime: AgentResourceActionRuntime;
}> {
  const destination = runtime.watcherDestination;
  const getWindow = (): BrowserWindow | null =>
    runtime.appAdvisorPipelineWindow?.() ?? null;
  let resourceAction = action;
  if (action.type === 'pipeline.create' || action.type === 'pipeline.update')
    resourceAction =
      action.rawYaml !== undefined
        ? { ...action, yamlFilePath: undefined }
        : action.yamlFilePath !== undefined
          ? {
              ...action,
              yamlFilePath: undefined,
              rawYaml: await readPipelineYamlFile(action.yamlFilePath),
            }
          : action;
  if (
    target.projectId &&
    target.worktreeId &&
    target.projectId !== APP_ADVISOR_PROJECT_ID
  ) {
    validateId(target.projectId, 'projectId');
    validateId(target.worktreeId, 'worktreeId');
    return {
      action: resourceAction,
      runtime: {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: destination.chatId,
        cwd: resolveWorktreeCwd(target.projectId, target.worktreeId),
        executionScope: 'worktree',
        getWindow,
        authorChat: {
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          chatId: destination.chatId,
        },
      },
    };
  }
  return {
    action: resourceAction,
    runtime: {
      projectId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
      cwd: getAppAdvisorHomeDir(),
      executionScope: 'directory',
      definitionScope: {},
      getWindow,
    },
  };
}

/** Whether this chat is driven from another computer, whose window serves it (D15). */
function remoteRouted(
  action: AppAdvisorDispatchPayload,
  requestId: string,
  runtime: AppAdvisorToolRuntime,
): boolean {
  const parsed = appAdvisorActionSchema.safeParse(action);
  if (!parsed.success) return false;
  const destination = runtime.watcherDestination;
  return (
    routeRendererToolRequest({
      kind: 'dispatch_action',
      requestId,
      action: parsed.data,
      originWorktreeId: destination.worktreeId,
      originProjectId: destination.projectId,
      originChatTabId: destination.chatId,
    }) !== null
  );
}

function defaultRuns(): AdvisorActionRuns | null {
  return getActiveDesktopRuntimeIfAccepting()?.appAdvisorActions ?? null;
}

/** D3: the one entry for DispatchAction after its schema parse. Never throws for a refused action. */
export async function routeAppAdvisorAction(
  action: AppAdvisorDispatchPayload,
  runtime: AppAdvisorToolRuntime,
  call: AppAdvisorActionCall,
  deps?: { runs?: () => AdvisorActionRuns | null },
): Promise<CanopyInjectedToolTextResult> {
  const requestId = call.toolUseId ?? randomUUID();
  const signal = call.context?.signal;
  const disposition = appAdvisorActionDisposition(action.type);
  if (!disposition)
    return respond({
      requestId,
      ok: false,
      error: {
        code: 'unsupported_action',
        message: APP_ADVISOR_ACTION_TEXTS.unknownType(action.type),
      },
    });

  // D12: worktree-chat.open_tab with a chatId is pure presentation.
  const presentation =
    disposition.kind === 'presentation' ||
    (disposition.kind === 'core' &&
      disposition.access === 'write' &&
      disposition.presentationWhenChatId === true &&
      action.type === 'worktree-chat.open_tab' &&
      Boolean(action.chatId));

  // D11: renderer-only and window-opening actions need the main window's
  // lease (or a remote route); without one they answer before any receipt.
  if (
    !presentation &&
    (disposition.kind === 'legacy' || disposition.kind === 'host_presentation')
  ) {
    const bound = (
      call.context?.interfaceTools ?? (await runtime.boundInterfaceTools())
    ).includes('ui.app_advisor.present');
    if (!bound && !remoteRouted(action, requestId, runtime))
      return respond({
        requestId,
        ok: false,
        error: {
          code: 'surface_unavailable',
          message:
            disposition.kind === 'legacy'
              ? APP_ADVISOR_ACTION_TEXTS.legacyNeedsWindow
              : APP_ADVISOR_ACTION_TEXTS.hostPresentationNeedsWindow,
          retryable: true,
        },
      });
  }

  // CAN-6008 (CAN-4133 N2): credential and remote-access actions run in main
  // only while this session binds the presentation tool and this computer's
  // own main window serves it. A headless turn, a chat a connected computer
  // drives, or that computer's window lease (CAN-5823) never satisfies it.
  if (disposition.kind === 'core' && disposition.requiresInterface === true) {
    const bound = (
      call.context?.interfaceTools ?? (await runtime.boundInterfaceTools())
    ).includes('ui.app_advisor.present');
    if (!bound || !localMainWindowServes(runtime.watcherDestination.chatId))
      return respond({
        requestId,
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: APP_ADVISOR_ACTION_TEXTS.legacyNeedsWindow,
          retryable: true,
        },
      });
  }

  const execute = async (): Promise<CanopyInjectedToolTextResult> => {
    if (
      action.type === 'cloud_chats.list' ||
      action.type === 'cloud_chats.open'
    ) {
      const response = await dispatchDesktopCloudChats(action, runtime, {
        requestId,
        ...(call.expectedUiRevision !== undefined
          ? { expectedUiRevision: call.expectedUiRevision }
          : {}),
        ...(call.context?.interfaceTools
          ? { boundTools: call.context.interfaceTools }
          : {}),
        ...(signal ? { signal } : {}),
      });
      return { text: jsonText(response), isError: response.ok !== true };
    }
    if (presentation) {
      const presented = appAdvisorActionSchema.safeParse(action);
      if (!presented.success)
        return respond({
          requestId,
          ok: false,
          error: {
            code: 'unsupported_action',
            message: APP_ADVISOR_ACTION_TEXTS.unknownType(action.type),
          },
        });
      return respond(
        await presentAppAdvisorAction({
          action: presented.data,
          requestId,
          ...(call.expectedUiRevision !== undefined
            ? { expectedUiRevision: call.expectedUiRevision }
            : {}),
          destination: runtime.watcherDestination,
          boundTools:
            call.context?.interfaceTools ??
            (await runtime.boundInterfaceTools()),
          ...(signal ? { signal } : {}),
        }),
      );
    }
    // Shared-family actions run through the shared engine in main, without
    // a renderer round trip.
    if (
      action.type === 'installed_items.list_status' ||
      action.type === 'installed_items.set_status' ||
      action.type === 'installed_items.uninstall' ||
      action.type === 'experiments.set_enabled' ||
      action.type === 'settings.open' ||
      action.type === 'settings.ai_gateway.get' ||
      action.type === 'settings.ai_gateway.connect' ||
      action.type === 'settings.ai_gateway.update'
    )
      return executeDesktopAgentActionTool(
        'dispatch_action',
        { action },
        runtime,
        call.context,
      );
    if (action.type === 'pipeline.run') {
      const dispatch = appAdvisorPipelineRunDispatch(action, runtime);
      if ('error' in dispatch) {
        return {
          text: jsonText({
            requestId: call.toolUseId,
            ok: false,
            error: { code: 'invalid_target', message: dispatch.error },
          }),
          isError: true,
        };
      }
      return executeDesktopAgentActionTool(
        'dispatch_action',
        { action: dispatch.action },
        dispatch.runtime,
        call.context,
      );
    }
    if (
      !presentation &&
      (disposition.kind === 'core' || disposition.kind === 'host_presentation')
    ) {
      switch (disposition.executor) {
        case 'script-preferences': {
          const scriptPreference =
            scriptPreferencesActionSchema.safeParse(action);
          if (!scriptPreference.success) break;
          const response = await dispatchDesktopScriptPreferences(
            scriptPreference.data,
            runtime,
            call.toolUseId,
            call.expectedUiRevision,
            signal,
          );
          return { text: jsonText(response), isError: response.ok !== true };
        }
        case 'editor-setup': {
          if (action.type !== 'navigation.open_editor_setup') break;
          const response = await dispatchDesktopEditorSetupReview(
            action,
            runtime,
            call.toolUseId,
            call.expectedUiRevision,
            signal,
          );
          return { text: jsonText(response), isError: response.ok !== true };
        }
        case 'resource': {
          const {
            agentResourceActionFailure,
            dispatchAgentResourceAction,
            isAgentResourceAction,
          } = await import('../canopy-tools/resource-actions');
          const target =
            action.type === 'pipeline.duplicate' ||
            action.type === 'pipeline.share'
              ? { projectId: action.projectId, worktreeId: action.worktreeId }
              : {};
          if (!isAgentResourceAction(action)) break;
          let resolved: Awaited<ReturnType<typeof resourceDispatch>>;
          try {
            resolved = await resourceDispatch(action, target, runtime);
          } catch (cause) {
            return respond({ ...agentResourceActionFailure(cause), requestId });
          }
          const response = await dispatchAgentResourceAction(
            resolved.action,
            resolved.runtime,
          );
          return respond({ ...response, requestId });
        }
        case 'settings-surface': {
          // CAN-6008 B1: the mounted Settings surface takes the operation
          // through the main window's lease, as the window's own event did.
          const surfaceAction = appAdvisorActionSchema.safeParse(action);
          if (!surfaceAction.success) break;
          return respond(
            await presentAppAdvisorAction({
              action: surfaceAction.data,
              requestId,
              ...(call.expectedUiRevision !== undefined
                ? { expectedUiRevision: call.expectedUiRevision }
                : {}),
              destination: runtime.watcherDestination,
              boundTools:
                call.context?.interfaceTools ??
                (await runtime.boundInterfaceTools()),
              surfaceRequest: true,
              ...(signal ? { signal } : {}),
            }),
          );
        }
        case 'shared-engine':
          break;
        default:
          return respond(
            await runtime.dispatchRendererAction(
              action,
              undefined,
              requestId,
              signal,
            ),
          );
      }
      return respond({
        requestId,
        ok: false,
        error: {
          code: 'unsupported_action',
          message: APP_ADVISOR_ACTION_TEXTS.unknownType(action.type),
        },
      });
    }
    return respond(
      await runtime.dispatchRendererAction(
        action,
        call.expectedUiRevision,
        requestId,
        signal,
      ),
    );
  };

  if (
    presentation ||
    (disposition.kind !== 'core' && disposition.kind !== 'legacy') ||
    disposition.access === 'read'
  )
    return execute();

  const destination = runtime.watcherDestination;
  const caller = appAdvisorActionCaller(destination.chatId);
  if (missingAppAdvisorGrants(caller, disposition.grants).length > 0)
    return respond({
      requestId,
      ok: false,
      error: {
        code: 'missing_capability',
        message: APP_ADVISOR_ACTION_TEXTS.missingGrant,
      },
    });
  const unrecordedResponse = respond({
    requestId,
    ok: false,
    error: {
      code: 'execution_failed',
      message: APP_ADVISOR_ACTION_TEXTS.unrecorded,
      retryable: true,
    },
  });
  const runs = (deps?.runs ?? defaultRuns)();
  if (!runs) return unrecordedResponse;
  const outcome = await runs.run<RecordedText>({
    caller,
    idempotencyKey: call.toolUseId
      ? `app-advisor-action:${destination.chatId}:${call.toolUseId}`
      : `app-advisor-action:${destination.chatId}:untracked:${randomUUID()}`,
    fingerprintInput: {
      type: action.type,
      action: z.json().parse(JSON.parse(JSON.stringify(action))),
      expectedUiRevision: call.expectedUiRevision ?? null,
    },
    scope: {
      workspaceId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
    },
    actionType: action.type,
    decode: decodeTextResult,
    effect: async () => recorded(await execute()),
    storeAs: (result) =>
      result.text.length <= REPLAY_TEXT_LIMIT
        ? result
        : {
            text: APP_ADVISOR_ACTION_TEXTS.replayTooLarge,
            ...(result.isError === true ? { isError: true } : {}),
          },
  });
  switch (outcome.status) {
    case 'ran':
    case 'replayed':
      return toolResult(outcome.result);
    case 'conflict':
      return respond({
        requestId,
        ok: false,
        error: {
          code: 'idempotency_conflict',
          message: APP_ADVISOR_ACTION_TEXTS.conflict,
          retryable: false,
        },
      });
    case 'interrupted':
    case 'expired':
      return respond({
        requestId,
        ok: false,
        error: {
          code: 'execution_failed',
          message: APP_ADVISOR_ACTION_TEXTS.interrupted,
          retryable: false,
        },
      });
    case 'unavailable':
      return unrecordedResponse;
  }
}
