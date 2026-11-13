import { BRAND } from '@canopy/brand/current';
import {
  AgentPortError,
  invalidAgentActionArguments,
  isCanonicalChatWatcherTrigger,
  isCanonicalSetupWatcherEntry,
  isLegacyChatWatcherTrigger,
  resolveSetupWatcherTrigger,
  SEARCHABLE_WATCHER_TRIGGERS,
  type AgentActionCall,
  type AgentActionToolResult,
  type AgentActionWatcherPort,
  type AgentArmedChatWatcher,
  type AgentChatWatcherPort,
  type AgentChatWatcherRecord,
  type AgentJson,
  type DeleteWatchersInput,
  type SearchWatchersInput,
  type SetupWatchersInput,
} from '@canopy/agent-actions';
import {
  SUPPORTED_HOOK_TRIGGERS,
  type HookTriggerName,
} from '@canopy/desktop-shared/hooks';
import {
  pageActiveWatchers,
  projectSetupWatchersResultForProvider,
} from '@canopy/desktop-shared/lib/app-advisor-watchers';
import type {
  CanonicalChatWatcherSetupInput,
  CanonicalChatWatcherSetupResult,
  TrustedChatWatcherRecipient,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorWatcherDestination,
  type SearchAppAdvisorWatchersInput,
  type SearchAppAdvisorWatchersResult,
  type SetupAppAdvisorWatchersInput,
  type SetupAppAdvisorWatchersResult,
} from '@canopy/desktop-shared/types';
import type { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { resolveGitHubRepositoryCandidates } from '../lib/github-repository-context';
import type { LocalWatcherTarget } from '@canopy/desktop-shared/types/local-watchers';
import type { WatchGitHubItemsInput } from '@canopy/desktop-shared/types/github-watchers';
import { agentWriteMessageId } from './desktop-write-turns';
import {
  createWatcherThroughCore,
  deleteWatchersThroughCore,
  listWatchersThroughCore,
  setupWatchersJson,
} from '../canopy-tools/watcher-core-client';

type DesktopAgentActionCall = AgentActionCall<CanopyInjectedToolRuntime>;

export function worktreeWatcherDestination(
  runtime: CanopyInjectedToolRuntime,
): AppAdvisorWatcherDestination | null {
  if (!runtime.worktreeWatcherRuntime) {
    return null;
  }
  const {
    projectId,
    worktreeId,
    chatId,
    delegationId,
    delegationDescription,
    delegationDepth,
  } = runtime.worktreeWatcherRuntime;
  return {
    projectId,
    worktreeId,
    chatId,
    ...(delegationId
      ? {
          delegationId,
          ...(delegationDescription ? { delegationDescription } : {}),
          ...(delegationDepth !== undefined ? { delegationDepth } : {}),
        }
      : {}),
  };
}

/**
 * Chat-perspective usage guidance for the triggers whose shared-catalog
 * guidance is written for the App Advisor toolset. Returns `undefined` to
 * keep the shared guidance (github rows).
 */
function chatScopedWatcherGuidance(
  trigger: string,
  coworkScope: boolean,
  delegate: boolean,
): string | undefined {
  if (isCanonicalChatWatcherTrigger(trigger)) {
    const discovery = delegate
      ? 'Use IDs your root supplied; delegates have no list, read, or messaging actions.'
      : 'Use SearchActions → projects/bots list → task list → chat list → SearchWatchers → SetupWatchers to discover target IDs.';
    const policy = trigger.startsWith('bot_')
      ? 'Bot access follows the per-call project setting.'
      : "Project targets must have the same saved owner as this chat's project; delegates use their root project's saved owner.";
    const behavior = trigger.endsWith('_completion')
      ? 'A chat cannot watch itself (a delegate cannot watch its root). Completion requires an active or pending turn; to arm an idle or unknown target, put armForNextCompletion beside target, for example },"armForNextCompletion":true.'
      : 'Watches future first inputs; the destination root chat’s own start is excluded, but sibling starts are eligible. Omit taskId for a project-wide or bot-wide scope.';
    return `${discovery} ${policy} ${behavior} Supply only target IDs, never kind, owner, display, session or destination fields; the host captures the recipient.`;
  }
  switch (trigger) {
    case 'worktree_hook_triggered':
      return `Fires when a supported hook trigger fires automatically in this same worktree, even if the hook is paused or no hook action is configured. Manual hook runs do not fire watchers. Pick target.triggerName from this row's hookTriggers list. For new PR comments use triggerName "pr:update:comments"; for newly submitted PR reviews with inline comments use "pr:reviews:new:has-comments". Use SetupWatchers with {"watchers":[{"trigger":"worktree_hook_triggered","target":{"triggerName":"pr:update:comments"}}]}. ${BRAND.displayName} injects projectId, worktreeId, target.kind, and destination chatId server-side.`;
    case 'worktree_pipeline_completion':
      return `Fires when a pipeline execution in this same ${coworkScope ? 'cowork project' : 'worktree'} pauses or reaches a terminal status. Pause notifications leave the watcher active; matching terminal notifications consume it. Use SetupWatchers with {"watchers":[{"target":{"executionId":"..."}}]} for a non-terminal execution, or omit executionId and optionally set pipelineId/terminalStatuses for future matching runs. ${BRAND.displayName} injects projectId, worktreeId, target.kind, and destination chatId server-side. Use SearchActions plus pipeline.execution_list or pipeline.execution_get to discover execution ids and confirm a specific execution is not already terminal.`;
    case 'worktree_chat_completion':
      return `Fires when the target worktree chat finishes its current turn and returns to idle. Any worktree chat in any project may be targeted. To arm an idle target, supply the full ids and put armForNextCompletion beside target: {"watchers":[{"trigger":"worktree_chat_completion","target":{"projectId":"...","worktreeId":"...","chatId":"..."},"armForNextCompletion":true}]}. This chat cannot watch itself. Omit armForNextCompletion to require a running or pending turn. ${BRAND.displayName} injects target.kind and the destination chat server-side.`;
    case 'standalone_chat_completion':
      return `Fires when the target cowork chat finishes its current turn and returns to idle. Any cowork chat in any project may be targeted. To arm an idle target, supply the full ids and put armForNextCompletion beside target: {"watchers":[{"trigger":"standalone_chat_completion","target":{"projectId":"...","chatId":"..."},"armForNextCompletion":true}]} where projectId is the cowork project id (never the standalone sentinel). This chat cannot watch itself. Omit armForNextCompletion to require a running or pending turn. ${BRAND.displayName} injects target.kind and the destination chat server-side.`;
    case 'worktree_new_chat_started':
      return `Fires once when a user message is sent in a newly created or newly tracked chat in the target worktree, including forked and hook-initiated chats. Any worktree in any project may be targeted: {"watchers":[{"trigger":"worktree_new_chat_started","target":{"projectId":"...","worktreeId":"..."}}]}. ${BRAND.displayName} injects target.kind and the destination chat server-side.`;
    case 'standalone_new_chat_started':
      return `Fires once when a user message is sent in a newly created or newly tracked chat in the target cowork project: {"watchers":[{"trigger":"standalone_new_chat_started","target":{"projectId":"..."}}]} where projectId is the cowork project id (never the standalone sentinel). ${BRAND.displayName} injects target.kind and the destination chat server-side.`;
    case 'automation_run':
      return `Fires once when a run of the target automation reaches its outcome. Failed and skipped runs fire immediately with that status; a successful run fires when its dispatched chat turn ends or its dispatched pipeline reaches a terminal status, and Orchestrator prompt dispatches fire at dispatch. Use SetupWatchers with {"watchers":[{"trigger":"automation_run","target":{"automationId":"..."}}]}. Automations are global to the user; discover ids with the automation.list / automation.get dispatch actions, or arm atomically with the optional watchers array on the automation.create / automation.run_now dispatch actions. The watcher is consumed on fire — re-arm per run for recurring automations. Unknown automation ids are rejected.`;
    default:
      return undefined;
  }
}

/** Target and watcher-entry field lists advertised to chats, keyed by trigger. */
function chatScopedWatcherFields(trigger: string):
  | {
      requiredFields: string[];
      optionalFields: string[];
      optionalEntryFields?: string[];
    }
  | undefined {
  switch (trigger) {
    case 'project_task_chat_completion':
      return {
        requiredFields: ['projectId', 'taskId', 'chatId'],
        optionalFields: [],
        optionalEntryFields: ['armForNextCompletion'],
      };
    case 'project_new_chat_started':
      return { requiredFields: ['projectId'], optionalFields: ['taskId'] };
    case 'bot_task_chat_completion':
      return {
        requiredFields: ['botId', 'taskId', 'chatId'],
        optionalFields: [],
        optionalEntryFields: ['armForNextCompletion'],
      };
    case 'bot_new_chat_started':
      return { requiredFields: ['botId'], optionalFields: ['taskId'] };
    case 'worktree_hook_triggered':
      return {
        requiredFields: ['triggerName'],
        optionalFields: ['hookKey', 'scope', 'repoId'],
      };
    case 'worktree_pipeline_completion':
      return {
        requiredFields: [],
        optionalFields: ['executionId', 'pipelineId', 'terminalStatuses'],
      };
    case 'worktree_chat_completion':
      return {
        requiredFields: ['projectId', 'worktreeId', 'chatId'],
        optionalFields: [],
        optionalEntryFields: ['armForNextCompletion'],
      };
    case 'standalone_chat_completion':
      return {
        requiredFields: ['projectId', 'chatId'],
        optionalFields: [],
        optionalEntryFields: ['armForNextCompletion'],
      };
    case 'worktree_new_chat_started':
      return {
        requiredFields: ['projectId', 'worktreeId'],
        optionalFields: [],
      };
    case 'standalone_new_chat_started':
      return { requiredFields: ['projectId'], optionalFields: [] };
    case 'automation_run':
      return { requiredFields: ['automationId'], optionalFields: [] };
    default:
      return undefined;
  }
}

function scopeWatcherCatalog(
  result: SearchAppAdvisorWatchersResult,
  options: {
    includeHookTrigger: boolean;
    coworkScope: boolean;
    delegate: boolean;
  },
): SearchAppAdvisorWatchersResult {
  return {
    ...result,
    catalog: result.catalog
      .filter(
        (entry) =>
          entry.trigger === 'worktree_pipeline_completion' ||
          isCanonicalChatWatcherTrigger(entry.trigger) ||
          entry.trigger === 'worktree_chat_completion' ||
          entry.trigger === 'standalone_chat_completion' ||
          entry.trigger === 'worktree_new_chat_started' ||
          entry.trigger === 'standalone_new_chat_started' ||
          entry.trigger === 'automation_run' ||
          entry.trigger === 'scheduled_wakeup' ||
          entry.trigger === 'command_watch_resolved' ||
          entry.trigger === 'github_workflow_runs_changed' ||
          entry.trigger === 'github_pull_requests_changed' ||
          (options.includeHookTrigger &&
            entry.trigger === 'worktree_hook_triggered'),
      )
      .map((entry) => {
        const fields = chatScopedWatcherFields(entry.trigger);
        const guidance =
          entry.usageGuidance !== undefined
            ? chatScopedWatcherGuidance(
                entry.trigger,
                options.coworkScope,
                options.delegate,
              )
            : undefined;
        return {
          ...entry,
          ...(fields ?? {}),
          ...(guidance !== undefined ? { usageGuidance: guidance } : {}),
        };
      }),
  };
}

function isBotWatcherTrigger(trigger: string): boolean {
  return (
    trigger === 'bot_task_chat_completion' || trigger === 'bot_new_chat_started'
  );
}

/**
 * Triggers a chat offers: Cowork workspaces have no hooks, and bot watchers
 * follow the calling chat's bot access, read on every call.
 */
function offersWatcherTrigger(
  trigger: string,
  options: { includeHookTrigger: boolean; botsEnabled: boolean },
): boolean {
  return (
    (options.includeHookTrigger || trigger !== 'worktree_hook_triggered') &&
    (options.botsEnabled || !isBotWatcherTrigger(trigger))
  );
}

/** One search per offered trigger, so the limit only ranks offered ones. */
function worktreeWatcherSearchInputs(
  input: SearchAppAdvisorWatchersInput,
  options: { includeHookTrigger: boolean; botsEnabled: boolean },
): SearchAppAdvisorWatchersInput[] {
  const requestedTrigger = input.trigger;
  const triggers = requestedTrigger
    ? [requestedTrigger].filter((trigger) =>
        offersWatcherTrigger(trigger, options),
      )
    : SEARCHABLE_WATCHER_TRIGGERS.filter(
        (trigger) =>
          !isLegacyChatWatcherTrigger(trigger) &&
          offersWatcherTrigger(trigger, options),
      );
  return triggers.map((trigger) => ({
    ...input,
    trigger,
    limit: requestedTrigger ? input.limit : undefined,
  }));
}

function worktreeWatcherCatalogLimit(
  input: SearchAppAdvisorWatchersInput,
): number | undefined {
  if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
    return undefined;
  }
  const floored = Math.floor(input.limit);
  return floored > 0 ? floored : undefined;
}

function mergeWorktreeWatcherSearchResults(
  input: SearchAppAdvisorWatchersInput,
  results: SearchAppAdvisorWatchersResult[],
): SearchAppAdvisorWatchersResult {
  const catalog = results
    .flatMap((result) => result.catalog)
    .sort((left, right) => right.score - left.score)
    .slice(0, worktreeWatcherCatalogLimit(input));

  return {
    catalog,
    activeWatchers: results[0]?.activeWatchers ?? [],
  };
}

/** The calling chat, or its delegate, as the chat watcher recipient. */
function trustedChatWatcherRecipient(
  destination: AppAdvisorWatcherDestination,
): TrustedChatWatcherRecipient {
  return {
    destination,
    recipient: destination.delegationId
      ? { kind: 'delegate', delegationId: destination.delegationId }
      : { kind: 'root' },
  };
}

function isChatWatcherTrigger(trigger: string): boolean {
  return (
    isCanonicalChatWatcherTrigger(trigger) ||
    isLegacyChatWatcherTrigger(trigger)
  );
}

/** Whether the calling chat's project may reach bots, read on every call. */
async function botAccessAllowed(
  destination: AppAdvisorWatcherDestination,
): Promise<boolean> {
  // Deferred: the bot service imports the watcher and sidebar modules.
  const { isBotAccessAllowed } = await import('../project-discovery/bots');
  return isBotAccessAllowed({
    kind: 'project_agent',
    projectId: destination.projectId,
    worktreeId: destination.worktreeId,
    chatId: destination.chatId,
  });
}

async function searchWatchers(
  input: SearchWatchersInput,
  call: DesktopAgentActionCall,
): Promise<AgentActionToolResult> {
  const destination = worktreeWatcherDestination(call.host);
  if (!destination) {
    return {
      text: 'SearchWatchers is only available for worktree chats.',
      isError: true,
    };
  }
  return listWatchersThroughCore(destination, input, call.signal);
}

/** SearchWatchers for one recipient, behind `core.initiatedWork.watcher.list` (CAN-5994). */
export async function searchWatchersFor(
  input: SearchWatchersInput,
  destination: AppAdvisorWatcherDestination,
): Promise<AgentActionToolResult> {
  // Defer the scheduler-backed service until watcher discovery is requested.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  const service = getAppAdvisorWatcherService();
  // Cowork workspaces have no hooks; every other watcher trigger is offered.
  const coworkScope = isCoworkWorkspace(destination.projectId);
  const offered = {
    includeHookTrigger: !coworkScope,
    botsEnabled: await botAccessAllowed(destination),
  };
  // An exact trigger the call does not offer lists no catalog rows, but the
  // active watchers are still read once.
  const searchInputs = worktreeWatcherSearchInputs(input, offered);
  if (searchInputs.length === 0)
    searchInputs.push({ ...input, trigger: undefined });
  const scopedResults = await Promise.all(
    searchInputs.map((searchInput, index) =>
      service.search(
        {
          ...searchInput,
          includeActive: index === 0 ? searchInput.includeActive : false,
        },
        destination,
        // A legacy chat trigger is listed only when it is asked for exactly.
        {
          includeLegacyChatTriggers:
            searchInput.trigger !== undefined &&
            isLegacyChatWatcherTrigger(searchInput.trigger),
        },
      ),
    ),
  );
  // Filter before ranking and the limit, including for an exact trigger.
  const result = mergeWorktreeWatcherSearchResults(
    input,
    scopedResults.map((scoped) => ({
      ...scoped,
      catalog: scoped.catalog.filter(
        (row) =>
          offersWatcherTrigger(row.trigger, offered) &&
          (input.trigger === undefined || row.trigger === input.trigger),
      ),
    })),
  );
  const includeActive = input.includeActive !== false;
  // Chat watchers come only from the redacted canonical projection.
  const chatWatchers = includeActive
    ? await service
        .projectCanonicalChatWatchers(trustedChatWatcherRecipient(destination))
        .catch(() =>
          result.activeWatchers
            .filter((watcher) => isChatWatcherTrigger(watcher.trigger))
            .map(({ id, trigger }) => ({
              id,
              trigger,
              availability: 'runtime_unavailable' as const,
            })),
        )
    : [];
  const instances = includeActive
    ? [
        ...result.activeWatchers.filter(
          (watcher) => !isChatWatcherTrigger(watcher.trigger),
        ),
        ...chatWatchers,
      ]
    : [];
  const page = pageActiveWatchers(instances, input);
  if (!page.ok) return { text: page.error, isError: true };
  const scoped = scopeWatcherCatalog(result, {
    ...offered,
    coworkScope,
    delegate: !!destination.delegationId,
  });
  return {
    text: JSON.stringify(
      {
        ...scoped,
        activeWatchers: page.activeWatchers.map((watcher) => ({
          ...watcher,
          watcherId: watcher.id,
        })),
        activeReturned: page.activeReturned,
        activeTotalMatches: page.activeTotalMatches,
        ...(page.activeNextCursor
          ? { activeNextCursor: page.activeNextCursor }
          : {}),
      },
      null,
      2,
    ),
  };
}

const ADVISOR_ACCESS_OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so Orchestrator watcher access is denied for safety.';
const AUTOMATION_WATCHER_OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so automation watcher access is denied for safety.';

function automationWatcherNotFoundMessage(automationId: string): string {
  return `Watcher target automation "${automationId}" was not found. Discover automation ids with the automation.list or automation.get actions.`;
}

/**
 * Why the calling chat may not watch this automation, if it may not: an App
 * Advisor prompt follows the project's App Advisor access, and any other
 * automation must target a project with the caller's saved owner. A hidden
 * automation reads as not found. Delegates carry their root caller.
 */
export async function automationWatcherRefusal(
  rawAutomationId: string,
  destination: AppAdvisorWatcherDestination,
): Promise<{ code?: string; message: string } | undefined> {
  if (destination.projectId === APP_ADVISOR_PROJECT_ID) return undefined;
  // Check the same trimmed id the watcher service resolves.
  const automationId = rawAutomationId.trim();
  // Deferred: the automation and owner services load on first use.
  const [{ getAutomationsService }, access, owners] = await Promise.all([
    import('../automations/service'),
    import('../lib/app-advisor-project-agent-access'),
    import('../lib/project-owner'),
  ]);
  const activity =
    await getAutomationsService().findActivityForBackgroundAuthorization(
      automationId,
    );
  if (!activity) return undefined;
  if (activity.action.type === 'app_advisor_prompt') {
    const decision = await access.decideAppAdvisorAccessForCaller({
      projectId: destination.projectId,
      worktreeId: destination.worktreeId,
    });
    if (decision.allowed) return undefined;
    return {
      code: access.ADVISOR_ACCESS_DISABLED,
      message:
        decision.reason === 'owner_unknown'
          ? ADVISOR_ACCESS_OWNER_UNKNOWN_MESSAGE
          : access.ADVISOR_ACCESS_DISABLED_MESSAGE,
    };
  }
  const target = owners.resolveAutomationTargetProject(activity.action);
  if (target.kind !== 'project')
    return { message: automationWatcherNotFoundMessage(automationId) };
  const callerOwner = await owners.resolveProjectSavedOwner({
    projectId: destination.projectId,
    worktreeId: destination.worktreeId,
  });
  const decision = await owners.decideSameOwnerAccess(callerOwner, target);
  if (decision.kind === 'allowed') return undefined;
  if (decision.kind === 'hidden')
    return { message: automationWatcherNotFoundMessage(automationId) };
  return {
    code: 'owner_context_unavailable',
    message: AUTOMATION_WATCHER_OWNER_UNKNOWN_MESSAGE,
  };
}

async function setupWatchers(
  input: SetupWatchersInput<HookTriggerName>,
  call: DesktopAgentActionCall,
): Promise<AgentActionToolResult> {
  const destination = worktreeWatcherDestination(call.host);
  if (!destination) {
    return {
      text: 'SetupWatchers is only available for worktree chats.',
      isError: true,
    };
  }
  return createWatcherThroughCore(
    destination,
    { kind: 'setup', input: setupWatchersJson(input) },
    { toolUseId: call.toolUseId, signal: call.signal },
  );
}

/** SetupWatchers for one recipient, behind `core.initiatedWork.watcher.create` (CAN-5994). */
export async function setupWatchersFor(
  input: SetupWatchersInput<HookTriggerName>,
  destination: AppAdvisorWatcherDestination,
  call: { toolUseId?: string; signal?: AbortSignal },
): Promise<AgentActionToolResult> {
  const watchers: CanonicalChatWatcherSetupInput['watchers'] = [];
  for (const [watcherIndex, watcher] of Array.from(input.watchers.entries())) {
    if (isCanonicalSetupWatcherEntry(watcher)) {
      // Canonical entries pass through; the service resolves and authorizes.
      watchers.push(watcher);
      continue;
    }
    const target = watcher.target;
    const trigger = resolveSetupWatcherTrigger(watcher);
    const base = {
      trigger,
      ...(watcher.label ? { label: watcher.label } : {}),
      ...(watcher.followUpInstruction
        ? { followUpInstruction: watcher.followUpInstruction }
        : {}),
      ...(watcher.allowDuplicate !== undefined
        ? { allowDuplicate: watcher.allowDuplicate }
        : {}),
      ...(watcher.armForNextCompletion !== undefined
        ? { armForNextCompletion: watcher.armForNextCompletion }
        : {}),
    };
    if (trigger === 'worktree_hook_triggered') {
      if (isCoworkWorkspace(destination.projectId)) {
        return {
          text: 'Hook watchers require a git worktree and are not available in this project folder. Only pipeline watchers are supported here.',
          isError: true,
        };
      }
      if (!('triggerName' in target) || !target.triggerName) {
        return invalidAgentActionArguments('SetupWatchers');
      }
      watchers.push({
        ...base,
        target: {
          kind: 'worktree_hook',
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          triggerName: target.triggerName,
          ...('hookKey' in target && target.hookKey
            ? { hookKey: target.hookKey }
            : {}),
          ...('scope' in target && target.scope ? { scope: target.scope } : {}),
          ...('repoId' in target && target.repoId
            ? { repoId: target.repoId }
            : {}),
        },
      });
      continue;
    }
    if (trigger === 'automation_run') {
      // Check and arm the same trimmed id the watcher service resolves.
      const automationId =
        'automationId' in target ? target.automationId.trim() : '';
      if (!automationId) {
        return invalidAgentActionArguments('SetupWatchers', [
          'automation_run watchers require target.automationId.',
        ]);
      }
      const refusal = await automationWatcherRefusal(automationId, destination);
      // A hidden automation reads exactly like a setup that found none.
      if (refusal)
        return setupResultText(
          {
            ok: false,
            error: refusal.message,
            ...(refusal.code ? { code: refusal.code } : {}),
            rejectedIndex: watcherIndex,
          },
          input.watchers.length,
        );
      watchers.push({
        ...base,
        target: { kind: 'automation', automationId },
      });
      continue;
    }
    if (
      trigger === 'worktree_chat_completion' ||
      trigger === 'standalone_chat_completion' ||
      trigger === 'worktree_new_chat_started' ||
      trigger === 'standalone_new_chat_started'
    ) {
      if (!('projectId' in target) || !target.projectId) {
        return invalidAgentActionArguments('SetupWatchers', [
          `${trigger} watchers require target.projectId (plus the other ids the trigger needs).`,
        ]);
      }
      const worktreeId =
        'worktreeId' in target && target.worktreeId
          ? target.worktreeId
          : undefined;
      const chatId =
        'chatId' in target && target.chatId ? target.chatId : undefined;
      if (trigger === 'worktree_chat_completion') {
        if (!worktreeId || !chatId) {
          return invalidAgentActionArguments('SetupWatchers', [
            'worktree_chat_completion watchers require target.projectId, target.worktreeId, and target.chatId.',
          ]);
        }
        watchers.push({
          ...base,
          target: {
            kind: 'worktree_chat',
            projectId: target.projectId,
            worktreeId,
            chatId,
          },
        });
        continue;
      }
      if (trigger === 'standalone_chat_completion') {
        if (!chatId) {
          return invalidAgentActionArguments('SetupWatchers', [
            'standalone_chat_completion watchers require target.projectId (the cowork project id) and target.chatId.',
          ]);
        }
        watchers.push({
          ...base,
          target: {
            kind: 'standalone_chat',
            projectId: target.projectId,
            chatId,
          },
        });
        continue;
      }
      if (trigger === 'worktree_new_chat_started') {
        if (!worktreeId) {
          return invalidAgentActionArguments('SetupWatchers', [
            'worktree_new_chat_started watchers require target.projectId and target.worktreeId.',
          ]);
        }
        watchers.push({
          ...base,
          target: {
            kind: 'worktree_chat_scope',
            projectId: target.projectId,
            worktreeId,
          },
        });
        continue;
      }
      watchers.push({
        ...base,
        target: {
          kind: 'standalone_chat_project',
          projectId: target.projectId,
        },
      });
      continue;
    }
    // worktree_pipeline_completion: the target must be pipeline-shaped — a
    // chat/hook/automation-shaped target defaulting here would silently
    // become an unfiltered whole-worktree pipeline watcher.
    if ('triggerName' in target || 'automationId' in target) {
      return invalidAgentActionArguments('SetupWatchers');
    }
    if ('projectId' in target) {
      return invalidAgentActionArguments('SetupWatchers', [
        'Chat targets require an explicit chat trigger (worktree_chat_completion, standalone_chat_completion, worktree_new_chat_started, or standalone_new_chat_started).',
      ]);
    }
    watchers.push({
      ...base,
      target: {
        kind: 'worktree_pipeline',
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        ...('executionId' in target && target.executionId
          ? { executionId: target.executionId }
          : {}),
        ...('pipelineId' in target && target.pipelineId
          ? { pipelineId: target.pipelineId }
          : {}),
        ...('terminalStatuses' in target && target.terminalStatuses
          ? { terminalStatuses: target.terminalStatuses }
          : {}),
      },
    });
  }
  // Defer the scheduler-backed service until watcher registration is requested.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  const service = getAppAdvisorWatcherService();
  const result:
    | SetupAppAdvisorWatchersResult
    | CanonicalChatWatcherSetupResult = input.watchers.some(
    isCanonicalSetupWatcherEntry,
  )
    ? await service.setupCanonicalChatWatchers({
        ...trustedChatWatcherRecipient(destination),
        watchers,
        ...(call.toolUseId ? { createdByToolUseId: call.toolUseId } : {}),
      })
    : await service.setup(
        { watchers: watchers.filter(isTargetWatcher) },
        destination,
        {
          toolUseId: call.toolUseId,
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
  return setupResultText(result, watchers.length);
}

/** A setup result as the tool returns it, with its per-entry results. */
function setupResultText(
  result: SetupAppAdvisorWatchersResult | CanonicalChatWatcherSetupResult,
  count: number,
): AgentActionToolResult {
  const projected = projectSetupWatchersResultForProvider(result);
  return {
    text: JSON.stringify(
      typeof projected === 'object' && projected !== null
        ? { ...projected, watchers: perEntrySetupResults(result, count) }
        : projected,
      null,
      2,
    ),
    isError: result.ok !== true,
  };
}

function isTargetWatcher(
  watcher: CanonicalChatWatcherSetupInput['watchers'][number],
): watcher is SetupAppAdvisorWatchersInput['watchers'][number] {
  return 'kind' in watcher.target;
}

/**
 * The shared per-entry watcher results beside the service result: the service
 * creates all watchers of a call or none, so a rejection marks its entry
 * `invalid_target` and every other entry as not created.
 */
function perEntrySetupResults(
  result: SetupAppAdvisorWatchersResult | CanonicalChatWatcherSetupResult,
  count: number,
): AgentJson[] {
  if (result.ok) {
    return result.results.map(
      (entry): AgentJson => ({
        ok: true,
        result: { watcherId: entry.watcher.id, status: entry.status },
      }),
    );
  }
  const rejectedIndex =
    'rejectedIndex' in result ? result.rejectedIndex : undefined;
  return Array.from({ length: count }, (_, index): AgentJson => {
    if (rejectedIndex === undefined || rejectedIndex === index) {
      return {
        ok: false,
        error: {
          code:
            rejectedIndex === undefined ? 'execution_failed' : 'invalid_target',
          message: result.error,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Not created because another watcher in this call failed.',
      },
    };
  });
}

async function deleteWatchers(
  input: DeleteWatchersInput,
  call: DesktopAgentActionCall,
): Promise<AgentActionToolResult> {
  const destination = worktreeWatcherDestination(call.host);
  if (!destination) {
    return {
      text: 'DeleteWatchers is only available for worktree chats.',
      isError: true,
    };
  }
  return deleteWatchersThroughCore(destination, input.watcherIds, {
    signal: call.signal,
  });
}

/** DeleteWatchers for one recipient, behind `core.initiatedWork.watcher.delete` (CAN-5994). */
export async function deleteWatchersFor(
  input: DeleteWatchersInput,
  destination: AppAdvisorWatcherDestination,
): Promise<AgentActionToolResult> {
  // Keep the main-only watcher service lazy so unrelated injected tools do not
  // initialize observer state; the static path remains packageable by Electron.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  const result = await getAppAdvisorWatcherService().deleteAgentWatchers(
    input,
    destination,
  );
  return { text: JSON.stringify(result) };
}

/** Watcher tools over the main-process watcher service. */
export const desktopWatcherPort: AgentActionWatcherPort<
  CanopyInjectedToolRuntime,
  HookTriggerName
> = {
  hookTriggerNames: SUPPORTED_HOOK_TRIGGERS,
  search: searchWatchers,
  setup: setupWatchers,
  delete: deleteWatchers,
};

async function watcherService(): Promise<
  ReturnType<typeof getAppAdvisorWatcherService>
> {
  // Defer the scheduler-backed service until a watcher is requested.
  const watchers = await import('../app-advisor/watchers');
  return watchers.getAppAdvisorWatcherService();
}

function requireDestination(
  call: DesktopAgentActionCall,
): AppAdvisorWatcherDestination {
  const destination = worktreeWatcherDestination(call.host);
  if (!destination) {
    throw new AgentPortError(
      'surface_unavailable',
      'Watchers are only available for worktree and Cowork chats.',
    );
  }
  return destination;
}

/**
 * Chat-completion watchers the environment actions arm inline. A Cowork
 * target is a Cowork chat; any other target is a worktree chat.
 */
export const desktopChatWatcherPort: AgentChatWatcherPort<CanopyInjectedToolRuntime> =
  {
    armChatCompletion: async (input, call): Promise<AgentArmedChatWatcher> => {
      const destination = requireDestination(call);
      const service = await watcherService();
      const { target, forWrite } = input;
      const turnUserMessageId = forWrite
        ? agentWriteMessageId(forWrite.idempotencyKey)
        : null;
      // A watcher bound to a write whose turn already finished fires for that
      // turn now instead of waiting for a later one.
      const resolveBound = async (
        armed: AgentArmedChatWatcher,
      ): Promise<AgentArmedChatWatcher> => {
        if (forWrite) {
          await service.fireIfTurnSettled(
            armed.watcherId,
            destination,
            turnUserMessageId,
          );
        }
        return armed;
      };
      // A retried write reuses the watcher its key armed, also after it fired.
      const armed = await service.findWatcherCreatedBy(
        input.idempotencyKey,
        destination,
      );
      if (armed) return resolveBound({ watcherId: armed.id, created: true });
      const cowork = isCoworkWorkspace(target.workspaceId);
      const turn = turnUserMessageId ? { turnUserMessageId } : {};
      const result = await service.setup(
        {
          watchers: [
            {
              ...(cowork
                ? {
                    trigger: 'standalone_chat_completion',
                    target: {
                      kind: 'standalone_chat',
                      projectId: target.workspaceId,
                      chatId: target.chatId,
                      ...turn,
                    },
                  }
                : {
                    trigger: 'worktree_chat_completion',
                    target: {
                      kind: 'worktree_chat',
                      projectId: target.workspaceId,
                      worktreeId: target.worktreeId,
                      chatId: target.chatId,
                      ...turn,
                    },
                  }),
              ...(input.label ? { label: input.label } : {}),
              ...(input.followUpInstruction
                ? { followUpInstruction: input.followUpInstruction }
                : {}),
              armForNextCompletion: forWrite
                ? true
                : input.armForNextCompletion,
              ...(input.allowDuplicate === true
                ? { allowDuplicate: true }
                : {}),
            },
          ],
        },
        destination,
        { toolUseId: input.idempotencyKey },
      );
      if (!result.ok) throw new AgentPortError('invalid_target', result.error);
      const created = result.results[0];
      if (!created) {
        throw new AgentPortError('execution_failed', 'No watcher was created.');
      }
      return resolveBound({
        watcherId: created.watcher.id,
        created: created.status === 'created',
      });
    },
    list: async (call): Promise<readonly AgentChatWatcherRecord[]> => {
      const destination = requireDestination(call);
      const active = await (await watcherService()).list(destination);
      return active.flatMap((watcher): AgentChatWatcherRecord[] => {
        const target = watcher.target;
        if (
          target.kind === 'worktree_chat' &&
          (watcher.status === 'active' || watcher.status === 'firing')
        ) {
          return [
            {
              watcherId: watcher.id,
              trigger: 'worktree_chat_completion',
              target: {
                workspaceId: target.projectId,
                worktreeId: target.worktreeId,
                chatId: target.chatId,
              },
              label: watcher.label ?? null,
            },
          ];
        }
        return [];
      });
    },
    delete: async (watcherIds, call) => {
      const destination = requireDestination(call);
      const result = await (
        await watcherService()
      ).deleteAgentWatchers({ watcherIds: [...watcherIds] }, destination);
      return result.results;
    },
  };

/** WatchCommand and ScheduleWakeup for one recipient, behind `core.initiatedWork.watcher.create` (CAN-5994). */
export async function createLocalWatcherFor(
  target: LocalWatcherTarget,
  destination: AppAdvisorWatcherDestination,
  call: {
    toolUseId: string;
    followUpInstruction?: string;
    signal?: AbortSignal;
  },
): Promise<AgentActionToolResult> {
  try {
    // Defer the scheduler-backed service because most injected tool calls do
    // not need its persistence and process-lifecycle initialization graph.
    const service = await watcherService();
    const watcher = call.signal
      ? await service.createLocalWatcher(
          target,
          destination,
          call.toolUseId,
          call.followUpInstruction,
          undefined,
          { signal: call.signal },
        )
      : await service.createLocalWatcher(
          target,
          destination,
          call.toolUseId,
          call.followUpInstruction,
        );
    return {
      text: JSON.stringify({
        ok: true,
        watcher,
        note: destination.delegationId
          ? 'Watcher registered. End this run when ready; the notification resumes this delegated task.'
          : 'Watcher registered. End this turn when ready; notification resumes this same chat.',
      }),
    };
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

/** WatchGitHubItems for one recipient, behind `core.initiatedWork.watcher.create` (CAN-5994). */
export async function watchGitHubItemsFor(
  input: WatchGitHubItemsInput,
  destination: AppAdvisorWatcherDestination,
  call: { toolUseId?: string; signal?: AbortSignal; repositoryCwd?: string },
): Promise<
  AgentActionToolResult & { failure?: { code: string; message: string } }
> {
  const repositoryCandidates = await resolveGitHubRepositoryCandidates({
    projectId: destination.projectId,
    worktreeId: destination.worktreeId,
    ...(call.repositoryCwd ? { cwd: call.repositoryCwd } : {}),
  });
  const result = await (
    await watcherService()
  ).watchGitHubItems(input, destination, {
    toolUseId: call.toolUseId,
    ...(call.signal ? { signal: call.signal } : {}),
    repositoryCandidates,
  });
  return {
    text: JSON.stringify(result),
    isError: result.ok !== true,
    ...(result.ok !== true
      ? { failure: { code: result.code, message: result.message } }
      : {}),
  };
}
