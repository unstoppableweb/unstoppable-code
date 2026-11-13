import type { z } from 'zod/v4';
import { executeShowCapabilities } from '../canopy-tools/show-capabilities';
import {
  appAdvisorPipelinesActionCatalog,
  searchAgentActionCatalog,
  installedItemActionCatalog,
  experimentActionCatalog,
  settingsActionCatalog,
  type AgentActionCatalogEntry,
  type AppAdvisorPipelineRunAction,
  type PipelineRunAction,
} from '@canopy/agent-actions';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { startSplitAgentSchema } from '../canopy-tools/definitions';
import {
  chatWatcherSetupSchema,
  containsCanonicalChatWatcher,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  scheduleWakeupSchema,
  watchCommandSchema,
} from '../canopy-tools/local-watcher-definitions';
import type { AppAdvisorToolKey } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { searchAppAdvisorActions } from '@canopy/desktop-shared/lib/app-advisor-actions';
import { transcriptReadActionCatalog } from '@canopy/agent-actions';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolContext,
  type CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import {
  executeLedgerInjectedTool,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import {
  hasInterfaceTool,
  localMainWindowServes,
} from '../agents/interface-tool-binding';
import {
  appAdvisorGetScriptOutputSchema,
  appAdvisorReadPipelineYamlSchema,
  appAdvisorShowFilesSchema,
  appAdvisorGetFileCommentsSchema,
  appAdvisorRespondToFileCommentSchema,
  dispatchActionSchema,
  getCurrentUiStateSchema,
  getPipelineDebugContextSchema,
  searchActionsSchema,
  searchWatchersSchema,
  setupWatchersSchema,
  legacySetupWatcherEntrySchema,
  legacySetupWatchersSchema,
  watchGitHubItemsSchema,
} from './definitions';
import type { AppAdvisorToolRuntime } from './runtime';
import { routeAppAdvisorAction } from './action-router';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import { projectSetupWatchersResultForProvider } from '@canopy/desktop-shared/lib/app-advisor-watchers';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { readWatcherOutputPreview } from './local-watcher-output';

export const APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION =
  'Start an independent Orchestrator chat in this same Work Entry from the current mid-turn context and settings. The source continues running; the child receives followUpInstruction privately and a visible Continue message. This does not create a branch or provide child inspection or automatic result delivery.';

/**
 * The messages of a refused action. A refused union reports the issues of
 * the branch its `type` selected, so a browser rule's message reaches the
 * agent instead of a bare union failure.
 */
function actionIssueMessages(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union') return [issue.message];
    const selected = issue.errors.filter(
      (branch) =>
        !branch.some((inner) => inner.path[inner.path.length - 1] === 'type'),
    );
    return selected.length === 1 && selected[0]
      ? actionIssueMessages(selected[0])
      : [issue.message];
  });
}

function invalidArguments(
  toolName: string,
  details: string[] = [],
): CanopyInjectedToolTextResult {
  return {
    text: [`Invalid arguments for ${toolName}.`, ...details].join('\n'),
    isError: true,
  };
}

function invalidSetupWatchersArguments(): CanopyInjectedToolTextResult {
  return {
    text: [
      'Invalid arguments for SetupWatchers.',
      'Use { "watchers": [{ "trigger": "worktree_chat_completion", "target": { "kind": "worktree_chat", "projectId": "...", "worktreeId": "...", "chatId": "..." } }] } or the equivalent cowork chat (standalone_chat), worktree_chat_scope, cowork project (standalone_chat_project), worktree_pipeline, or worktree_hook target.',
      'Do not pass destinationChatId, targetKind, titles, display metadata, session keys, request ids, or chatId outside target.',
    ].join(' '),
    isError: true,
  };
}

function sharedEngineActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    ...installedItemActionCatalog(),
    ...experimentActionCatalog(),
    ...settingsActionCatalog(),
    ...appAdvisorPipelinesActionCatalog(),
  ];
}

/**
 * App Advisor's `pipeline.run` as the shared action. A run in a task names
 * it with `projectId` and `worktreeId`; main validates the pair and passes it
 * as trusted context, separate from the Advisor chat that starts the run.
 */
export function appAdvisorPipelineRunDispatch(
  action: AppAdvisorPipelineRunAction,
  runtime: AppAdvisorToolRuntime,
):
  | { action: PipelineRunAction; runtime: AppAdvisorToolRuntime }
  | { error: string } {
  const { projectId, worktreeId, ...shared } = action;
  if (projectId === undefined || worktreeId === undefined)
    return { action: shared, runtime };
  try {
    validateId(projectId, 'projectId');
    validateId(worktreeId, 'worktreeId');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (projectId === APP_ADVISOR_PROJECT_ID)
    return {
      error: 'App Advisor ids do not identify a task. Pass a real task.',
    };
  return {
    action: shared,
    runtime: {
      ...runtime,
      appAdvisorPipelineTarget: { projectId, worktreeId },
    },
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    return undefined;
  }
}

function recordFromValue(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : undefined;
}

function arrayFromValue(value: unknown): unknown[] | undefined {
  if (isUnknownArray(value)) return value;
  const parsed = parseJsonValue(value);
  return isUnknownArray(parsed) ? parsed : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

const TARGET_KIND_BY_TRIGGER = {
  worktree_chat_completion: 'worktree_chat',
  standalone_chat_completion: 'standalone_chat',
  worktree_new_chat_started: 'worktree_chat_scope',
  standalone_new_chat_started: 'standalone_chat_project',
  worktree_pipeline_completion: 'worktree_pipeline',
  worktree_hook_triggered: 'worktree_hook',
} as const;

function watcherTargetKind(value: unknown): string | undefined {
  if (
    value === 'worktree_chat' ||
    value === 'standalone_chat' ||
    value === 'worktree_chat_scope' ||
    value === 'standalone_chat_project' ||
    value === 'worktree_pipeline' ||
    value === 'worktree_hook'
  ) {
    return value;
  }
  return undefined;
}

function triggerTargetKind(value: unknown): string | undefined {
  return typeof value === 'string' && value in TARGET_KIND_BY_TRIGGER
    ? TARGET_KIND_BY_TRIGGER[value as keyof typeof TARGET_KIND_BY_TRIGGER]
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = nonBlankString(value);
    if (text) return text;
  }
  return undefined;
}

function normalizeSetupWatcherEntry(value: unknown): unknown {
  const entry = recordFromValue(value);
  if (!entry) return value;

  const parsedTarget = recordFromValue(entry.target);
  const sourceTarget = parsedTarget ?? {};
  const kind =
    watcherTargetKind(sourceTarget.kind) ??
    watcherTargetKind(entry.targetKind) ??
    triggerTargetKind(entry.trigger);
  const target: Record<string, unknown> = {};
  if (kind) target.kind = kind;

  if (kind === 'worktree_chat') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.workspaceId,
      entry.projectId,
      entry.workspaceId,
    );
    target.worktreeId = firstString(sourceTarget.worktreeId, entry.worktreeId);
    target.chatId = firstString(
      sourceTarget.chatId,
      sourceTarget.tabId,
      sourceTarget.id,
      entry.chatId,
      entry.tabId,
    );
  } else if (kind === 'standalone_chat') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.standaloneProjectId,
      entry.projectId,
      entry.standaloneProjectId,
    );
    target.chatId = firstString(
      sourceTarget.chatId,
      sourceTarget.id,
      entry.chatId,
    );
  } else if (kind === 'worktree_chat_scope') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.workspaceId,
      entry.projectId,
      entry.workspaceId,
    );
    target.worktreeId = firstString(sourceTarget.worktreeId, entry.worktreeId);
  } else if (kind === 'standalone_chat_project') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.standaloneProjectId,
      entry.projectId,
      entry.standaloneProjectId,
    );
  } else if (kind === 'worktree_pipeline') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.workspaceId,
      entry.projectId,
      entry.workspaceId,
    );
    target.worktreeId = firstString(sourceTarget.worktreeId, entry.worktreeId);
    const executionId = firstString(
      sourceTarget.executionId,
      sourceTarget.id,
      entry.executionId,
    );
    if (executionId) target.executionId = executionId;
    const pipelineId = firstString(sourceTarget.pipelineId, entry.pipelineId);
    if (pipelineId) target.pipelineId = pipelineId;
    if (Array.isArray(sourceTarget.terminalStatuses)) {
      target.terminalStatuses = sourceTarget.terminalStatuses;
    } else if (Array.isArray(entry.terminalStatuses)) {
      target.terminalStatuses = entry.terminalStatuses;
    } else {
      const status = firstString(sourceTarget.status, entry.status);
      if (
        status === 'success' ||
        status === 'failure' ||
        status === 'cancelled'
      ) {
        target.terminalStatuses = [status];
      }
    }
  } else if (kind === 'worktree_hook') {
    target.projectId = firstString(
      sourceTarget.projectId,
      sourceTarget.workspaceId,
      entry.projectId,
      entry.workspaceId,
    );
    target.worktreeId = firstString(sourceTarget.worktreeId, entry.worktreeId);
    target.triggerName = firstString(
      sourceTarget.triggerName,
      sourceTarget.hookTrigger,
      entry.triggerName,
      entry.hookTrigger,
    );
    const hookKey = firstString(sourceTarget.hookKey, entry.hookKey);
    if (hookKey) target.hookKey = hookKey;
    const scope = firstString(sourceTarget.scope, entry.scope);
    if (scope) target.scope = scope;
    const repoId = firstString(sourceTarget.repoId, entry.repoId);
    if (repoId) target.repoId = repoId;
  } else if (parsedTarget) {
    return entry;
  }

  const normalized: Record<string, unknown> = {
    trigger: entry.trigger,
    target,
  };
  for (const field of [
    'label',
    'followUpInstruction',
    'allowDuplicate',
    'armForNextCompletion',
  ] as const) {
    if (entry[field] !== undefined) {
      normalized[field] = entry[field];
    }
  }
  return normalized;
}

function normalizeSetupWatchersArgs(rawArgs: unknown): unknown {
  const args = recordFromValue(rawArgs) ?? rawArgs;
  const watcherArray = arrayFromValue(args);
  if (watcherArray) {
    return { watchers: watcherArray.map(normalizeSetupWatcherEntry) };
  }
  if (!isRecord(args)) return rawArgs;
  const watchers = arrayFromValue(args.watchers);
  if (watchers) {
    return {
      ...args,
      watchers: watchers.map(normalizeSetupWatcherEntry),
    };
  }
  if (
    args.trigger !== undefined ||
    args.target !== undefined ||
    args.targetKind !== undefined
  ) {
    return { watchers: [normalizeSetupWatcherEntry(args)] };
  }
  return args;
}

/** One App Advisor tool call's provider invocation and session tools. */
export interface AppAdvisorToolContext extends CanopyInjectedToolContext {
  /**
   * The calling session's Ledger tools, present only when its Ledger exposure
   * gate passed when it started. They are bound to the Work Entry the session
   * started in, never the entry selected later. Without them a Ledger call
   * answers that this chat has no Ledger.
   */
  ledgerRuntime?: LedgerToolsRuntime;
  /** Interface tools the calling session or route bound when it was created (CAN-4131). */
  interfaceTools?: readonly InterfaceToolName[];
}

export function getDispatchRequestId(
  context: { toolUseId?: string } | undefined,
): string | undefined {
  if (context?.toolUseId) {
    return context.toolUseId;
  }

  // Older App Advisor tool schemas exposed requestId to the model. The model
  // must not control renderer dispatch idempotency because repeated user
  // requests with a reused id would return cached responses instead of acting.
  // Keep accepting the field for compatibility, but only Canopy/provider-owned
  // ids may flow into the renderer cache.
  return undefined;
}

export async function executeAppAdvisorTool(
  canonicalKey: AppAdvisorToolKey,
  rawArgs: unknown,
  runtime: AppAdvisorToolRuntime,
  context?: AppAdvisorToolContext,
): Promise<CanopyInjectedToolTextResult> {
  if (context?.interfaceTools)
    runtime.rememberInterfaceTools(context.interfaceTools);
  if (canonicalKey === 'start_forked_agent') {
    if (runtime.deferredToolsRuntime?.providerType === 'cursor') {
      return {
        text: 'Cursor Orchestrator chats cannot fork provider context.',
        isError: true,
      };
    }
    const parsed = startSplitAgentSchema.safeParse(rawArgs);
    if (!parsed.success) return invalidArguments('StartForkedAgent');
    if (!runtime.startForkedAgent) {
      return {
        text: 'Orchestrator fork runtime is unavailable.',
        isError: true,
      };
    }
    try {
      context?.signal?.throwIfAborted();
      return {
        text: jsonText(
          await runtime.startForkedAgent(
            parsed.data.followUpInstruction,
            context?.signal,
          ),
        ),
      };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
  if (
    canonicalKey === 'ask_user_question' ||
    canonicalKey === 'set_auto_archive' ||
    canonicalKey === 'set_work_entry_auto_delete'
  ) {
    return executeCanopyInjectedTool(canonicalKey, rawArgs, runtime, context);
  }

  if (
    canonicalKey === 'search_deferred_tools' ||
    canonicalKey === 'load_deferred_tools' ||
    canonicalKey === 'get_github_pull_request_status'
  ) {
    return executeCanopyInjectedTool(canonicalKey, rawArgs, runtime, context);
  }

  if (canonicalKey === 'get_script_output') {
    const parsed = appAdvisorGetScriptOutputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return invalidArguments('GetScriptOutput');
    }
    if (parsed.data.scriptId.startsWith('watcher:')) {
      return {
        text: await readWatcherOutputPreview(
          runtime.watcherDestination,
          parsed.data.scriptId,
          parsed.data.maxLines ?? 200,
        ),
      };
    }
    const snapshot = await runtime.loadScriptOutput({
      scriptId: parsed.data.scriptId,
      repo: parsed.data.repo,
      maxLines: parsed.data.maxLines ?? 200,
      projectId: parsed.data.projectId,
      worktreeId: parsed.data.worktreeId,
    });
    if (!snapshot.found || snapshot.error) {
      return {
        text:
          snapshot.error ??
          `No persisted output found for script "${parsed.data.scriptId}".`,
        isError: true,
      };
    }
    const header = `[${snapshot.label ?? snapshot.scriptKey ?? 'Script Output'} - ${snapshot.humanStatus ?? 'unknown'}]`;
    return {
      text: [
        header,
        `Script ID: ${snapshot.scriptKey ?? parsed.data.scriptId}`,
        `Invocation: ${snapshot.invocation ?? 'unknown'}`,
        '---',
        snapshot.lines.length > 0
          ? snapshot.lines.join('\n')
          : 'No output available yet.',
      ].join('\n'),
    };
  }

  if (canonicalKey === 'read_pipeline_yaml') {
    const parsed = appAdvisorReadPipelineYamlSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return invalidArguments('ReadPipelineYaml');
    }
    const result = await runtime.loadPipelineYaml(parsed.data);
    return {
      text: result.text ?? result.error ?? 'Failed to read pipeline YAML.',
      isError: result.ok !== true,
    };
  }

  if (canonicalKey === 'show_capabilities')
    return executeShowCapabilities(rawArgs);

  if (canonicalKey === 'show_files') {
    const parsed = appAdvisorShowFilesSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return invalidArguments('ShowFiles');
    }
    try {
      const result = await runtime.showFiles(
        parsed.data.files,
        parsed.data.workspace,
      );
      return {
        text: jsonText(result),
        isError: result.opened === 0 && result.presentation !== 'deferred',
      };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : 'Failed to show files.',
        isError: true,
      };
    }
  }

  if (canonicalKey === 'get_file_comments') {
    const parsed = appAdvisorGetFileCommentsSchema.safeParse(rawArgs);
    if (!parsed.success) return invalidArguments('GetFileComments');
    const result = await runtime.getScopedFileComments(parsed.data);
    return {
      text: result.ok
        ? result.text
        : `Failed to read file comments: ${result.error ?? 'unknown error'}`,
      isError: !result.ok,
    };
  }

  if (canonicalKey === 'respond_to_file_comment') {
    const parsed = appAdvisorRespondToFileCommentSchema.safeParse(rawArgs);
    if (!parsed.success) return invalidArguments('RespondToFileComment');
    const result = await runtime.respondToScopedFileComment({
      threadId: parsed.data.threadId,
      body: parsed.data.body,
      resolve: parsed.data.resolve ?? false,
      ...(parsed.data.workspace ? { workspace: parsed.data.workspace } : {}),
    });
    const threadKind =
      result.store === 'plan' ? 'plan comment thread' : 'file thread';
    return {
      text: result.ok
        ? `Reply posted to ${threadKind} ${parsed.data.threadId}${result.resolved ? ' and the thread was resolved' : ''}.`
        : `Reply failed: ${result.error ?? 'unknown error'}`,
      isError: !result.ok,
    };
  }

  switch (canonicalKey) {
    case 'get_current_ui_state': {
      const parsed = getCurrentUiStateSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return invalidArguments('GetCurrentUiState');
      }
      const state = await runtime.requestUiStateForTool({
        bound: hasInterfaceTool(
          context?.interfaceTools,
          'ui.get_current_ui_state',
        ),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      return { text: jsonText(state) };
    }
    case 'search_actions': {
      const parsed = searchActionsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return invalidArguments('SearchActions');
      }
      // A disconnected renderer must not suppress unrelated catalog results or
      // let stale main-process flag data imply page availability.
      const state = await runtime
        .requestUiStateForTool({
          bound: hasInterfaceTool(
            context?.interfaceTools,
            'ui.get_current_ui_state',
          ),
          ...(context?.signal ? { signal: context.signal } : {}),
        })
        .catch(() => undefined);
      const featureFlags = {
        ...getFeatureFlagService().getSnapshot().values,
        ...(state?.snapshot.canopyPortal
          ? {
              [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]:
                state?.snapshot.canopyPortal.featureEnabled,
            }
          : {}),
      };
      // D10: without the main window's lease, list only actions that work
      // without a window; search wide first so filtering cannot starve a page.
      // CAN-6008: credential and remote-access actions only for this
      // computer's own main window.
      const localWindow = localMainWindowServes(
        runtime.watcherDestination.chatId,
      );
      const windowBound = (
        context?.interfaceTools ?? (await runtime.boundInterfaceTools())
      ).includes('ui.app_advisor.present');
      const searchInput = { ...parsed.data, limit: 50 };
      const sharedActions = searchAgentActionCatalog(
        sharedEngineActionCatalog(),
        searchInput,
      );
      const existing = searchAppAdvisorActions(
        {
          ...searchInput,
          availablePages: state?.snapshot.availablePages,
          // Action availability accepts boolean gates, not numeric rollout values.
          featureFlags: Object.fromEntries(
            Object.entries(featureFlags).map(([key, value]) => [
              key,
              value === true,
            ]),
          ),
        },
        transcriptReadActionCatalog(),
      );
      const actions = [...sharedActions.actions, ...existing.actions]
        .filter((action) => {
          const disposition = appAdvisorActionDisposition(action.type);
          if (disposition?.kind === 'core' && disposition.requiresInterface)
            return windowBound && localWindow;
          if (windowBound) return true;
          if (disposition?.kind === 'core') return true;
          return (
            disposition?.kind !== 'presentation' &&
            disposition?.kind !== 'host_presentation' &&
            disposition?.kind !== 'legacy'
          );
        })
        .slice(0, parsed.data.limit ?? 12);
      return {
        text: jsonText({
          ...existing,
          actions,
          returned: actions.length,
          totalMatches: existing.totalMatches + sharedActions.totalMatches,
          categories: Array.from(
            new Set([...existing.categories, ...sharedActions.categories]),
          ),
        }),
      };
    }
    case 'dispatch_action': {
      const parsed = dispatchActionSchema.safeParse(rawArgs);
      if (!parsed.success) {
        // The schema's messages say which rule failed, as the injected
        // DispatchAction tool reports them.
        return invalidArguments(
          'DispatchAction',
          actionIssueMessages(parsed.error.issues).map(
            (message) => `- ${message}`,
          ),
        );
      }
      return routeAppAdvisorAction(parsed.data.action, runtime, {
        toolUseId: getDispatchRequestId(context),
        ...(parsed.data.expectedUiRevision !== undefined
          ? { expectedUiRevision: parsed.data.expectedUiRevision }
          : {}),
        ...(context ? { context } : {}),
      });
    }
    case 'get_pipeline_debug_context': {
      const parsed = getPipelineDebugContextSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return invalidArguments('GetPipelineDebugContext');
      }
      try {
        const contextResult = await runtime.getPipelineDebugContext(
          parsed.data.executionId,
        );
        return { text: jsonText(contextResult) };
      } catch (error) {
        return {
          text:
            error instanceof Error
              ? error.message
              : 'Failed to load pipeline debug context.',
          isError: true,
        };
      }
    }
    case 'search_watchers': {
      const parsed = searchWatchersSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return invalidArguments('SearchWatchers');
      }
      const result = await runtime.searchWatchers(parsed.data);
      if ('ok' in result && !result.ok) {
        return invalidArguments('SearchWatchers', [result.error]);
      }
      return { text: jsonText(result) };
    }
    case 'setup_watchers': {
      // Never run the permissive alias normalizer over canonical raw objects.
      const canonicalBatch = containsCanonicalChatWatcher(rawArgs);
      const parsed = (
        canonicalBatch
          ? chatWatcherSetupSchema(
              legacySetupWatcherEntrySchema,
              normalizeSetupWatcherEntry,
            )
          : setupWatchersSchema
      ).safeParse(
        canonicalBatch ? rawArgs : normalizeSetupWatchersArgs(rawArgs),
      );
      if (!parsed.success) {
        return invalidSetupWatchersArguments();
      }
      if (canonicalBatch) {
        if (!runtime.setupCanonicalChatWatchers) {
          return {
            text: jsonText({
              ok: false,
              code: 'runtime_unavailable',
              error: 'Canonical chat watcher runtime is unavailable.',
            }),
            isError: true,
          };
        }
        // Keep the validated order and canonical objects; only the legacy
        // entries were normalized. C validates and applies this batch once.
        const response = await runtime.setupCanonicalChatWatchers(parsed.data, {
          toolUseId: context?.toolUseId,
        });
        return {
          text: jsonText(projectSetupWatchersResultForProvider(response)),
          isError: response.ok !== true,
        };
      }
      const legacy = legacySetupWatchersSchema.safeParse(parsed.data);
      if (!legacy.success) return invalidSetupWatchersArguments();
      const response = await runtime.setupWatchers(legacy.data, {
        toolUseId: context?.toolUseId,
      });
      return {
        text: jsonText(projectSetupWatchersResultForProvider(response)),
        isError: response.ok !== true,
      };
    }
    case 'watch_github_items': {
      const parsed = watchGitHubItemsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return invalidArguments('WatchGitHubItems', [
          ...parsed.error.issues.slice(0, 3).map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
            return `- ${path}: ${issue.message}`;
          }),
          '- For every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}.',
        ]);
      }
      const response = await runtime.watchGitHubItems(parsed.data, {
        toolUseId: context?.toolUseId,
      });
      return {
        text: JSON.stringify(response),
        isError: response.ok !== true,
      };
    }
    case 'schedule_wakeup': {
      const parsed = scheduleWakeupSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('ScheduleWakeup');
      if (!runtime.scheduleWakeup)
        return { text: 'Scheduled wakeup is unavailable.', isError: true };
      return {
        text: JSON.stringify({
          ok: true,
          watcher: await runtime.scheduleWakeup(parsed.data, context),
        }),
      };
    }
    case 'watch_command': {
      const parsed = watchCommandSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArguments('WatchCommand');
      if (!runtime.watchCommand)
        return { text: 'Command watcher is unavailable.', isError: true };
      return {
        text: JSON.stringify({
          ok: true,
          watcher: await runtime.watchCommand(parsed.data, context),
        }),
      };
    }
    case 'add_ledger_entry':
    case 'search_ledger_entries':
    case 'update_ledger_entry':
      // The session's own Ledger tools, never one resolved from the UI
      // selection; without them the call answers no_ledger_scope.
      return executeLedgerInjectedTool(
        canonicalKey,
        rawArgs,
        context?.ledgerRuntime,
        {
          ...(context?.invocationId !== undefined
            ? { invocationId: context.invocationId }
            : {}),
          ...(context?.signal ? { signal: context.signal } : {}),
        },
      );
    default: {
      const exhaustive: never = canonicalKey;
      return {
        text: `Unhandled App Advisor tool key: ${String(exhaustive)}.`,
        isError: true,
      };
    }
  }
}
