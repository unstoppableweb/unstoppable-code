import {
  AUTOMATION_TURN_SCHEDULE_ERROR,
  refusesAutomationTurnScheduleMutation,
} from '../automations/schedule-mutation-policy';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
} from '@canopy/agent-actions';
import { APP_ADVISOR_ACTION_CATALOG } from '@canopy/desktop-shared/lib/app-advisor-actions';
import type {
  AppAdvisorJson,
  SetupAppAdvisorWatchersResult,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER,
  DESKTOP_LEGACY_DISPATCH_JSON_SCHEMA,
  findScopedUiOnlyField,
  scopedDispatchActionSchema,
  type DispatchActionArgs,
} from '../canopy-tools/definitions';
import {
  DESKTOP_LEGACY_ACTION_TYPES,
  dispatchWorktreeAction,
  searchWorktreeActions,
} from '../canopy-tools/worktree-actions';
import { worktreeChatCoreWrites } from '../canopy-tools/worktree-chat-core-writes';
import { isRecord } from '../lib/type-guards';
import {
  automationWatcherRefusal,
  worktreeWatcherDestination,
} from './desktop-watcher-port';

type DesktopLegacyAction = DispatchActionArgs['action'];

const DESKTOP_LEGACY_ACTION_TYPE_SET: ReadonlySet<string> = new Set(
  DESKTOP_LEGACY_ACTION_TYPES,
);

async function dispatchDesktopLegacyAction(
  action: DesktopLegacyAction,
  runtime: CanopyInjectedToolRuntime,
  context?: {
    toolUseId?: string;
    signal?: AbortSignal;
    call?: AgentActionCall<CanopyInjectedToolRuntime>;
  },
): Promise<AgentActionDispatchOutput> {
  if (!runtime.worktreeActionRuntime) {
    return {
      text: 'DispatchAction is only available for worktree chats.',
      isError: true,
    };
  }
  // automation.run_now completes the dispatched run before it returns, so its
  // inline watchers must be armed BEFORE the dispatch — arming afterwards
  // would race (and lose against) the run's completion event. Watchers match
  // the automation's next run, not this specific run: a scheduled run
  // completing inside the arm→dispatch window can consume the watcher first
  // (see handleAutomationRunEvent — the subscriber is still woken with that
  // run's outcome and id).
  let preArmedRunNowWatchers: InlineAutomationWatcherSetup | undefined;
  if (action.type === 'automation.run_now' && action.watchers?.length) {
    if (
      await refusesAutomationTurnScheduleMutation(runtime.worktreeActionRuntime)
    )
      return {
        requestId: context?.toolUseId ?? '',
        ok: false,
        error: AUTOMATION_TURN_SCHEDULE_ERROR,
      };
    const hasWatcherDestination = worktreeWatcherDestination(runtime) !== null;
    if (!hasWatcherDestination) {
      // No watcher capability exists on this surface at all, so arming was
      // never possible and blocking the run would make run_now+watchers
      // permanently unusable here. Dispatch and report the limitation,
      // mirroring how automation.create reports setup failures.
      preArmedRunNowWatchers = failedInlineAutomationWatcherSetup(
        'Inline watcher setup is only available for worktree chats.',
      );
    } else {
      preArmedRunNowWatchers = await setupInlineAutomationWatchers(
        action.id,
        action.watchers,
        runtime,
        context,
      );
    }
    if (!preArmedRunNowWatchers.ok && hasWatcherDestination) {
      // Watcher arming and the run must stay atomic: dispatching anyway
      // would run the automation with no watcher armed and strand the
      // subscribing chat — the exact failure mode this trigger exists to
      // eliminate.
      return {
        text: JSON.stringify(
          {
            ok: false,
            error: `Inline watcher setup failed, so the automation was not run: ${preArmedRunNowWatchers.error}`,
            ...(preArmedRunNowWatchers.code
              ? { code: preArmedRunNowWatchers.code }
              : {}),
          },
          null,
          2,
        ),
        isError: true,
      };
    }
  }
  const createWithInlineWatchers =
    action.type === 'automation.create' && action.watchers?.length
      ? action
      : null;
  const requestedCreateEnabled =
    createWithInlineWatchers?.input.enabled !== false;
  const dispatchInput = createWithInlineWatchers
    ? {
        action: {
          type: 'automation.create' as const,
          input: { ...createWithInlineWatchers.input, enabled: false },
        },
      }
    : { action };
  // A Stop's abort signal reaches the action, so a long dispatch can end early.
  const actionRuntime = {
    ...runtime.worktreeActionRuntime,
    coreWrites: worktreeChatCoreWrites({
      chatId: runtime.worktreeActionRuntime.chatId,
      ...(context?.call ? { call: context.call } : {}),
    }),
    ...(context?.signal ? { signal: context.signal } : {}),
  };
  let response = await dispatchWorktreeAction(dispatchInput, actionRuntime);
  if (preArmedRunNowWatchers !== undefined) {
    if (response.ok) {
      response.result = {
        ...(isRecord(response.result) ? response.result : {}),
        inlineWatcherSetup: preArmedRunNowWatchers.json,
      };
    } else {
      // The run never dispatched; remove the pre-armed watchers so they do
      // not linger waiting on a future unrelated run.
      await deleteInlineAutomationWatchers(
        preArmedRunNowWatchers.createdWatcherIds,
        runtime,
      );
    }
  }
  // Keep a newly created automation non-runnable until its inline watcher is
  // durable. Enabling first leaves an immediately-due one-time schedule free
  // to complete before setup can observe its automation id.
  if (response.ok && createWithInlineWatchers) {
    const automationId = readCreatedAutomationId(response.result);
    const watcherSetup = automationId
      ? await setupInlineAutomationWatchers(
          automationId,
          createWithInlineWatchers.watchers ?? [],
          runtime,
          context,
        )
      : failedInlineAutomationWatcherSetup(
          'Automation was created, but its id could not be read for inline watcher setup.',
        );
    if (automationId && watcherSetup.ok && requestedCreateEnabled) {
      const enableResponse = await dispatchWorktreeAction(
        {
          action: {
            type: 'automation.update',
            id: automationId,
            patch: { enabled: true },
          },
        },
        actionRuntime,
      );
      if (enableResponse.ok) {
        response = enableResponse;
      } else {
        return {
          text: JSON.stringify(
            {
              ok: false,
              error:
                enableResponse.error ??
                'Automation watcher was armed, but the automation could not be enabled.',
              result: response.result,
              inlineWatcherSetup: watcherSetup.json,
            },
            null,
            2,
          ),
          isError: true,
        };
      }
    }
    const inlineWatcherSetup: AppAdvisorJson = watcherSetup.json;
    response.result = {
      ...(isRecord(response.result) ? response.result : {}),
      inlineWatcherSetup,
    };
  }
  return response;
}

function readCreatedAutomationId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const activity = result.activity;
  if (
    isRecord(activity) &&
    typeof activity.id === 'string' &&
    activity.id.length > 0
  ) {
    return activity.id;
  }
  return null;
}

/**
 * Typed inline-watcher setup outcome. `json` is a hand-built JSON projection
 * of the setup result (no type assertions) suitable for embedding in the
 * dispatch response; `createdWatcherIds` backs run_now's failure cleanup.
 */
interface InlineAutomationWatcherSetup {
  ok: boolean;
  error: string;
  /** A typed refusal code, such as the App Advisor access code. */
  code?: string;
  json: AppAdvisorJson;
  createdWatcherIds: string[];
}

/** The JSON an action response embeds for the inline watchers it armed. */
export function inlineWatcherSetupJson(
  result: SetupAppAdvisorWatchersResult,
): AppAdvisorJson {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      ...(result.rejectedIndex !== undefined
        ? { rejectedIndex: result.rejectedIndex }
        : {}),
    };
  }
  return {
    ok: true,
    results: result.results.map((entry) => ({
      status: entry.status,
      watcher: {
        id: entry.watcher.id,
        trigger: entry.watcher.trigger,
        status: entry.watcher.status,
        label: entry.watcher.label,
        targetKind: entry.watcher.target.kind,
      },
    })),
  };
}

function failedInlineAutomationWatcherSetup(
  error: string,
  code?: string,
): InlineAutomationWatcherSetup {
  return {
    ok: false,
    error,
    ...(code ? { code } : {}),
    json: { ok: false, error, ...(code ? { code } : {}) },
    createdWatcherIds: [],
  };
}

async function setupInlineAutomationWatchers(
  automationId: string,
  watchers: Array<{
    label?: string;
    followUpInstruction?: string;
    allowDuplicate?: boolean;
  }>,
  runtime: CanopyInjectedToolRuntime,
  context?: { toolUseId?: string; signal?: AbortSignal },
): Promise<InlineAutomationWatcherSetup> {
  const destination = worktreeWatcherDestination(runtime);
  if (!destination) {
    return failedInlineAutomationWatcherSetup(
      'Inline watcher setup is only available for worktree chats.',
    );
  }
  try {
    const refusal = await automationWatcherRefusal(automationId, destination);
    if (refusal)
      return failedInlineAutomationWatcherSetup(refusal.message, refusal.code);
    // Keep the main-only watcher service lazy so unrelated injected tools do
    // not initialize observer state; the static path remains packageable by
    // Electron.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    const result = await getAppAdvisorWatcherService().setup(
      {
        watchers: watchers.map((watcher) => ({
          trigger: 'automation_run',
          ...(watcher.label ? { label: watcher.label } : {}),
          target: { kind: 'automation', automationId },
          ...(watcher.followUpInstruction
            ? { followUpInstruction: watcher.followUpInstruction }
            : {}),
          ...(watcher.allowDuplicate !== undefined
            ? { allowDuplicate: watcher.allowDuplicate }
            : {}),
        })),
      },
      destination,
      {
        toolUseId: context?.toolUseId,
        ...(context?.signal ? { signal: context.signal } : {}),
      },
    );
    if (!result.ok) {
      return failedInlineAutomationWatcherSetup(result.error);
    }
    return {
      ok: true,
      error: '',
      json: inlineWatcherSetupJson(result),
      createdWatcherIds: result.results.flatMap((entry) =>
        entry.status === 'created' ? [entry.watcher.id] : [],
      ),
    };
  } catch (error) {
    return failedInlineAutomationWatcherSetup(
      error instanceof Error
        ? error.message
        : 'Inline automation watcher setup failed.',
    );
  }
}

/** Best-effort removal of inline watchers whose run_now dispatch failed. */
async function deleteInlineAutomationWatchers(
  watcherIds: string[],
  runtime: CanopyInjectedToolRuntime,
): Promise<void> {
  const destination = worktreeWatcherDestination(runtime);
  if (!destination || watcherIds.length === 0) {
    return;
  }
  try {
    // Keep the main-only watcher service lazy so unrelated injected tools do
    // not initialize observer state; the static path remains packageable by
    // Electron.
    // Defer the scheduler-backed service because most injected tool calls do
    // not need its persistence and process-lifecycle initialization graph.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().deleteAgentWatchers(
      { watcherIds },
      destination,
    );
  } catch {
    // Best-effort cleanup: a lingering automation watcher is inert until the
    // automation actually runs, and the user can delete it from the UI.
  }
}

/**
 * The frozen chat-surface actions, plugged into the shared engine: their
 * schema, catalog search, and dispatch, including the inline watchers that
 * automation.create and automation.run_now arm.
 */
export const desktopLegacyActionFamily: AgentActionFamily<CanopyInjectedToolRuntime> =
  defineAgentActionFamily<CanopyInjectedToolRuntime, DesktopLegacyAction>({
    id: 'desktop-legacy',
    types: DESKTOP_LEGACY_ACTION_TYPES,
    catalog: () =>
      APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
        DESKTOP_LEGACY_ACTION_TYPE_SET.has(entry.type),
      ),
    supportedTypes: () => DESKTOP_LEGACY_ACTION_TYPES,
    actionSchema: scopedDispatchActionSchema,
    findUiOnlyField: findScopedUiOnlyField,
    // Per-surface catalog: directory-scoped runtimes (Cowork) never see
    // worktree-only actions (tracked-plan/hook), and a restricted runtime
    // sees only its allowed action types.
    search: (input, call) => {
      const executionScope =
        call.host.worktreeActionRuntime?.executionScope ?? 'worktree';
      const allowedActionTypes =
        call.host.worktreeActionRuntime?.allowedActionTypes;
      return searchWorktreeActions(input, {
        executionScope,
        ...(allowedActionTypes ? { allowedActionTypes } : {}),
      });
    },
    hiddenFields: ['projectId', 'worktreeId'],
    jsonEnumOrder: DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER,
    dispatchJsonSchema: DESKTOP_LEGACY_DISPATCH_JSON_SCHEMA,
    dispatch: (action, call) =>
      dispatchDesktopLegacyAction(action, call.host, {
        toolUseId: call.toolUseId,
        ...(call.signal ? { signal: call.signal } : {}),
        call,
      }),
  });
