import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { removeUnstartedWorkEntry } from '../lib/cowork-work-entries';
import { getChatStateService } from '../services/chat-state-service';
import {
  assertCoworkWorkspaceRootPresent,
  CoworkFolderMissingError,
} from '../lib/cowork-folder-guard';
import { randomUUID } from 'node:crypto';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isDeepStrictEqual } from 'node:util';
import {
  parseChatCreationAction,
  type ChatCreationAction,
  type CreatedTaskChatReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import {
  getProviderForChatModel,
  type ChatCommand,
  type ChatCommandEnvelope,
} from '@canopy/desktop-shared/types';
import {
  botIdForProjectId,
  isBotProjectId,
} from '@canopy/protocol/chat-targets';
import {
  AgentChatSendError,
  canonicalSource,
  dispatchAgentChatSend,
  pipelineDiscoveryCaller,
  type AgentChatSendContext,
  type PipelineNativeGrantSeed,
  type PipelineNewChatSeed,
  type TrustedSendCaller,
} from './send-orchestration';
import type { AgentSenderRuntimeSource } from './sender-context';
import { isAutomationRunSource } from './automation-run-source';
import {
  isAgentSenderContextError,
  resolveAgentSenderIdentity,
  revalidatePipelineAgentOrigin,
} from './sender-context';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { requireAuthorizedProject } from '../project-discovery/owner-policy';
import { listDiscoverableTaskIds } from '../project-discovery/chats-list';
import { DiscoveryError } from '../project-discovery/errors';
import { readTaskRuntimeSnapshot } from '../project-discovery/runtime-state';
import {
  requireBotAccess,
  readBotEntries,
} from '../project-discovery/bots/target';
import {
  ensureBotRegistryLoaded,
  requireBotWorkspace,
} from '../project-discovery/bots/registry';
import {
  createWorkEntry,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { ensureCoworkHomeScaffold } from '../lib/chat-project-utils';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { getChatStateCommandPort } from '../ipc/chat-state';
import type { CreationModelSelection } from './creation-model';

async function requireBotWorkspaceForProjectId(
  projectId: string,
): Promise<void> {
  const botId = botIdForProjectId(projectId);
  if (botId) {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(botId);
  }
}

async function requireCreationBotWorkspaces(
  action: ChatCreationAction,
  caller: TrustedSendCaller,
): Promise<void> {
  if (
    action.type === 'bots.create_task' ||
    action.type === 'bots.create_task_chat'
  ) {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(action.botId);
  } else await requireBotWorkspaceForProjectId(action.projectId);

  const sourceProjectId =
    caller.kind === 'pipeline'
      ? caller.source.agentOrigin?.projectId
      : caller.source.projectId;
  if (sourceProjectId) await requireBotWorkspaceForProjectId(sourceProjectId);
}

/**
 * Orchestrator chats keep their own runtime: only these seed settings apply.
 * An automation's own chat (CAN-5380) also keeps the model, provider and
 * plugins its native quick prompt set; no Orchestrator chat takes an
 * interface mode.
 */
function seedAppliesToBotChat(
  seed: PipelineNewChatSeed,
  automationOwnChat: boolean,
): boolean {
  if (seed.interfaceMode !== undefined) return false;
  return (
    automationOwnChat ||
    (seed.model === undefined &&
      seed.providerType === undefined &&
      seed.pluginSelections === undefined)
  );
}

/**
 * Whether a seed's D11 settings are exactly a native grant's (CAN-5479): the
 * approvals, the plugins and, for an Orchestrator chat, the model. Anything
 * else falls back to D11.
 */
function seedIsGranted(
  seed: PipelineNewChatSeed,
  grant: PipelineNativeGrantSeed,
  projectChat: boolean,
): boolean {
  return (
    seed.approvalMode === grant.approvalMode &&
    isDeepStrictEqual(seed.pluginSelections, grant.pluginSelections) &&
    (projectChat || seed.model === grant.model)
  );
}

/** A seed's set fields: one present but undefined neither forces a new chat nor clears a default. */
function definedSeed(
  seed: PipelineNewChatSeed | undefined,
): PipelineNewChatSeed | undefined {
  if (!seed) return undefined;
  const defined: PipelineNewChatSeed = {
    ...(seed.model !== undefined ? { model: seed.model } : {}),
    ...(seed.providerType !== undefined
      ? { providerType: seed.providerType }
      : {}),
    ...(seed.modelConfig !== undefined
      ? { modelConfig: seed.modelConfig }
      : {}),
    ...(seed.planMode !== undefined ? { planMode: seed.planMode } : {}),
    ...(seed.approvalMode !== undefined
      ? { approvalMode: seed.approvalMode }
      : {}),
    ...(seed.pluginSelections !== undefined
      ? { pluginSelections: seed.pluginSelections }
      : {}),
    ...(seed.interfaceMode !== undefined
      ? { interfaceMode: seed.interfaceMode }
      : {}),
  };
  return Object.keys(defined).length > 0 ? defined : undefined;
}

/** Create without navigation; initial input uses the canonical trusted send path. */
export async function dispatchAgentChatCreation(
  action: ChatCreationAction,
  context: AgentChatSendContext,
): Promise<CreatedTaskChatReceipt> {
  try {
    return await create(action, context);
  } catch (error) {
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : error.code === 'unsupported_action'
            ? 'unsupported_action'
            : 'not_found',
        error.code === 'unsupported_action'
          ? error.message
          : 'The target chat is not available.',
      );
    if (error instanceof CoworkFolderMissingError)
      throw new AgentChatSendError(error.code, error.message, error);
    if (error instanceof AgentChatSendError) throw error;
    logMainProcessWarn('[agent-create] Creation failed unexpectedly:', error);
    // Entry, chat and send are separate durable commits. Do not suggest retrying
    // a send whose acknowledgement may have been lost.
    throw new AgentChatSendError(
      'target_not_ready',
      'Creation or initial input could not be confirmed. Discover the task and chat before retrying; do not resend a possibly accepted input.',
    );
  }
}

async function create(
  input: ChatCreationAction,
  context: AgentChatSendContext,
): Promise<CreatedTaskChatReceipt> {
  const parsed = parseChatCreationAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  const action = parsed.action;
  const trusted = context.caller;
  await requireCreationBotWorkspaces(action, trusted);
  // A creation's settings are its seed; a turn override is for existing chats.
  if (context.turnOverride)
    throw new AgentChatSendError(
      'validation_failed',
      'A new chat takes its settings from its seed.',
    );
  let source: AgentSenderRuntimeSource | undefined;
  let caller: ProjectDiscoveryCaller;
  const newChatSeed =
    trusted.kind === 'pipeline' ? definedSeed(context.newChatSeed) : undefined;
  const agentOriginated =
    trusted.kind === 'pipeline' && trusted.source.agentOrigin !== undefined;
  // CAN-4551: a converted automation's send step starts its chat as the
  // automation's own send would, apart from the Agent route (the step
  // resolves its own model).
  const automationRun =
    trusted.kind === 'pipeline' &&
    isAutomationRunSource(trusted.source) &&
    !agentOriginated;
  const projectAction =
    action.type === 'projects.create_task' ||
    action.type === 'projects.create_task_chat';
  // CAN-5479: a converted agent automation's run keeps what its native
  // action set, which its send step verified, while the seed is exactly it.
  const nativeGrant =
    trusted.kind === 'pipeline' &&
    agentOriginated &&
    isAutomationRunSource(trusted.source) &&
    newChatSeed !== undefined &&
    context.nativeGrant !== undefined &&
    seedIsGranted(newChatSeed, context.nativeGrant, projectAction)
      ? context.nativeGrant
      : undefined;
  if (trusted.kind === 'pipeline') {
    caller = pipelineDiscoveryCaller(trusted.source);
  } else {
    source = await canonicalSource(trusted.source);
    if ((trusted.kind === 'app_advisor') !== isBotProjectId(source.projectId))
      throw new AgentChatSendError(
        'validation_failed',
        'The trusted sender runtime is inconsistent.',
      );
    await resolveAgentSenderIdentity(source);
    caller =
      trusted.kind === 'app_advisor'
        ? { kind: 'app_advisor', chatId: source.chatId }
        : { kind: 'project_agent', ...source };
  }
  // D11: before any effect, the run's agent must still be current, keep the
  // run's owner and, for an Orchestrator target, have its access, as a send's.
  if (trusted.kind === 'pipeline' && trusted.source.agentOrigin)
    await revalidatePipelineAgentOrigin(
      trusted.source.agentOrigin,
      trusted.source.owner,
      projectAction
        ? action.projectId
        : requireBotWorkspace(action.botId).projectId,
    );
  const actionModel =
    action.type === 'projects.create_task' ||
    action.type === 'projects.create_task_chat'
      ? action.model
      : undefined;
  const actionHarness =
    action.type === 'projects.create_task' ||
    action.type === 'projects.create_task_chat'
      ? action.executionHarness
      : undefined;
  if (actionModel !== undefined && newChatSeed?.model !== undefined)
    throw new AgentChatSendError(
      'validation_failed',
      'A new chat takes its model from the action or its seed, not both.',
    );
  // The harness is a property of a named model: the project default's
  // harness options are not known until the seed resolves.
  if (actionHarness !== undefined && actionModel === undefined)
    throw new AgentChatSendError(
      'validation_failed',
      'executionHarness needs model: name the model from models.list it applies to.',
    );
  // A seed's model gets the same checks as an explicit one.
  const requestedModel = actionModel ?? newChatSeed?.model;
  // A code task's ID is its new worktree's, known once that is created.
  let taskId =
    'taskId' in action
      ? action.taskId
      : trusted.kind === 'pipeline' && context.plannedTaskId !== undefined
        ? context.plannedTaskId
        : randomUUID();
  if (
    newChatSeed &&
    !projectAction &&
    !seedAppliesToBotChat(
      newChatSeed,
      automationRun || nativeGrant !== undefined,
    )
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'Orchestrator chats accept only thinking effort, fast mode, plan mode and approval mode.',
    );
  // D11 for a new chat: an agent-originated seed may set the model, plan mode
  // and interface, but never plugins, and approvals only within the agent's;
  // a native grant keeps what the automation's native action set (CAN-5479).
  if (
    newChatSeed?.pluginSelections !== undefined &&
    trusted.kind === 'pipeline' &&
    trusted.source.agentOrigin &&
    nativeGrant === undefined
  )
    throw new AgentChatSendError(
      'authorization_conflict',
      'An agent-originated run cannot choose plugins for a new chat.',
    );
  let selection: CreationModelSelection | undefined;
  let projectId: string;
  let codeProject = false;
  let codeTask = false;
  let workspaceKind: 'single-repo' | 'multi-repo' = 'single-repo';
  const createTaskAction =
    action.type === 'projects.create_task' ? action : undefined;
  const projectCreation =
    action.type === 'projects.create_task' ||
    action.type === 'projects.create_task_chat'
      ? action
      : undefined;
  const thinkingLevel = projectCreation?.thinkingLevel;
  // A created task's title names the task; a task chat's names the chat.
  const chatTitle =
    action.type === 'projects.create_task_chat'
      ? action.title?.trim() || undefined
      : undefined;
  if (projectAction) {
    const project = await requireAuthorizedProject(action.projectId, caller);
    codeTask = createTaskAction !== undefined && project.type !== 'cowork';
    // Only a root project agent creates a code task: a pipeline has its own
    // create-worktree step, and App Advisor's legacy standalone-chat creation
    // is Cowork-only.
    if (codeTask && trusted.kind !== 'project_root')
      throw new AgentChatSendError(
        'unsupported_action',
        'Code tasks are created with projects.create_task from a project chat.',
      );
    if (
      createTaskAction &&
      !codeTask &&
      (createTaskAction.branchName ??
        createTaskAction.baseBranch ??
        createTaskAction.baseTaskId) !== undefined
    )
      throw new AgentChatSendError(
        'validation_failed',
        'branchName, baseBranch and baseTaskId apply only to code projects.',
      );
    if (project.config?.type === 'multi-repo') workspaceKind = 'multi-repo';
    if (project.readiness !== 'ready')
      throw new AgentChatSendError(
        'target_not_ready',
        'The project is not ready.',
      );
    projectId = project.projectId;
    codeProject = project.type !== 'cowork';
    const knownTaskId =
      action.type === 'projects.create_task_chat'
        ? action.taskId
        : createTaskAction?.baseTaskId;
    if (
      knownTaskId !== undefined &&
      !(await listDiscoverableTaskIds(projectId, project.type)).includes(
        knownTaskId,
      )
    )
      throw new AgentChatSendError('not_found', 'The task is not available.');
    // Checked against the target before any scaffold, entry, tab or input.
    if (requestedModel !== undefined) {
      const { resolveCreationModelSelection } =
        await import('./creation-model');
      selection = await resolveCreationModelSelection(
        requestedModel,
        { projectId, taskId },
        {
          ...(actionHarness === undefined
            ? {}
            : { executionHarness: actionHarness }),
        },
      );
      // The pin after creation needs a provider for the harness; refuse
      // here, before any scaffold, rather than after the tab exists.
      if (
        selection.executionHarness !== undefined &&
        getProviderForChatModel(selection.model, selection.executionHarness) ===
          undefined
      )
        throw new AgentChatSendError(
          'validation_failed',
          `No provider is available for model "${requestedModel}" on the ${selection.executionHarness} harness.`,
        );
    }
    // Renderer project selection awaits this scaffold through standaloneChat.init.
    // Agent creation bypasses selection, but the first turn needs the same cwd.
    if (project.type === 'cowork') {
      await assertCoworkWorkspaceRootPresent(projectId);
      await ensureCoworkHomeScaffold(projectId);
    }
  } else {
    const bot = requireBotWorkspace(action.botId);
    await requireBotAccess(caller);
    projectId = bot.projectId;
    if (
      action.type === 'bots.create_task_chat' &&
      !(await readBotEntries(bot.botId)).some(
        (entry) => entry.id === action.taskId,
      )
    )
      throw new AgentChatSendError('not_found', 'The task is not available.');
  }

  const taskCreated =
    action.type === 'projects.create_task' ||
    action.type === 'bots.create_task';
  let chatId: string | undefined;
  let replayedTab = false;
  /** The harness the replayed chat already holds, to re-apply a missed pin. */
  let replayedHarness: string | undefined;
  // A host-step replay finds the chat it already created.
  const fixedTabId = context.fixedIds?.tabId;
  if (!taskCreated && fixedTabId) {
    const snapshot = await readTaskRuntimeSnapshot(projectId, taskId);
    const replayed = snapshot.tabsFile.tabs.find(
      (tab) => tab.id === fixedTabId && tab.kind !== 'file',
    );
    if (replayed) {
      // A replay sends only where a fresh choice could: never into an
      // archived or stale chat.
      if (replayed.readOnly || replayed.staleSessionDetected !== undefined)
        throw new AgentChatSendError(
          'target_not_ready',
          'The chat this step created is no longer available.',
        );
      chatId = fixedTabId;
      replayedTab = true;
      replayedHarness = replayed.executionHarness;
    }
  }
  // An explicit model or any seed setting always gets a new chat: an empty
  // tab's stored model is not its effective selection (mode, plugins, an
  // older route base). So does `newChat`, and an automation run's starter
  // replacement: the starter may hold a person's remembered billing choice,
  // which the native send never took.
  const replacesStarter =
    context.reuseStarterChat === true &&
    trusted.kind === 'pipeline' &&
    isAutomationRunSource(trusted.source);
  if (
    !taskCreated &&
    !selection &&
    thinkingLevel === undefined &&
    chatTitle === undefined &&
    !replayedTab &&
    !newChatSeed &&
    context.newChat !== true &&
    !replacesStarter
  ) {
    const { isReusableEmptyChatTab } = await import('../services/chat-service');
    const snapshot = await readTaskRuntimeSnapshot(projectId, taskId);
    chatId = snapshot.tabsFile.tabs.find(
      (tab) =>
        !tab.readOnly &&
        tab.staleSessionDetected === undefined &&
        tab.kind !== 'file' &&
        !(
          source &&
          source.projectId === projectId &&
          source.worktreeId === taskId &&
          source.chatId === tab.id
        ) &&
        isReusableEmptyChatTab(tab),
    )?.id;
  }
  const chatCreated = replayedTab
    ? context.fixedIds?.reusedTab !== true
    : chatId === undefined;
  // CAN-5379: an automation's own worktree may already hold the renderer's
  // blank starter. A seed still needs its own chat, so the starter is replaced
  // in the same commit and the task keeps one chat, as the native send did.
  let starterTabId: string | undefined;
  if (chatCreated && !replayedTab && !taskCreated && replacesStarter) {
    const { isReusableEmptyChatTab } = await import('../services/chat-service');
    const { tabs } = (await readTaskRuntimeSnapshot(projectId, taskId))
      .tabsFile;
    const [only] = tabs;
    if (
      tabs.length === 1 &&
      only.kind !== 'file' &&
      !only.readOnly &&
      only.staleSessionDetected === undefined &&
      isReusableEmptyChatTab(only)
    )
      starterTabId = only.id;
  }
  let allocatedEntry = false;
  let allocatedEntryCreatedAt: string | undefined;
  let ambiguousInput = false;
  // Main-owned chat commands on the task, under the creation's own client
  // identity: the tab creation, a starter replacement and the harness pin.
  const dispatchCreationCommand = (
    commandId: string,
    command: ChatCommand,
  ): ReturnType<typeof dispatchTrustedChatCommand> => {
    const port = getChatStateCommandPort();
    if (!port)
      throw new AgentChatSendError(
        'target_not_ready',
        'Chat command dispatch is unavailable.',
      );
    return dispatchTrustedChatCommand(
      {
        schemaVersion: 1,
        commandId,
        projectId,
        worktreeId: taskId,
        command,
      } satisfies ChatCommandEnvelope,
      {
        ...createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
          principalId: 'local-desktop-user',
          clientInstanceId: 'agent-chat-creation',
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'mcp',
          grants: ['core.chat.write'],
        }),
        executionOptions: { preserveActiveTab: true },
      },
    );
  };
  // A named harness is pinned on an unstarted tab through the same
  // main-owned transition the pickers use, before its first message captures
  // the harness; the create-tab seed cannot carry it.
  const pinHarness = async (
    tabId: string,
    executionHarness: NonNullable<CreationModelSelection['executionHarness']>,
    model: CreationModelSelection['model'],
  ): Promise<void> => {
    const providerType = getProviderForChatModel(model, executionHarness);
    if (providerType === undefined)
      throw new AgentChatSendError(
        'target_not_ready',
        `No provider is available for model "${model}".`,
      );
    const pinned = await dispatchCreationCommand(randomUUID(), {
      type: 'chat.set_model',
      tabId,
      model,
      providerType,
      executionHarness,
    });
    if (pinned.outcome !== 'applied' && pinned.outcome !== 'already_applied')
      throw new AgentChatSendError(
        'target_not_ready',
        pinned.reason ?? 'The target refused the execution harness.',
      );
  };
  try {
    if (chatCreated && !replayedTab) {
      let seed: Omit<
        Extract<ChatCommand, { type: 'chat.create_tab' }>,
        'type' | 'tabId'
      > = {};
      if (projectAction) {
        const seedModel = selection?.model;
        // A named harness seeds the tab with that harness's provider, so the
        // pin after creation keeps the provider and the settings seeded here.
        const seedProvider =
          seedModel !== undefined && selection?.executionHarness !== undefined
            ? getProviderForChatModel(seedModel, selection.executionHarness)
            : undefined;
        const defaults = seedModel
          ? await (
              await import('./creation-model')
            ).resolveCreationModelSeed(
              projectId,
              seedModel,
              selection?.fromDestinationDefault,
              seedProvider,
            )
          : await (
              await import('../remote-control/host/remote-chat-create')
            ).resolveRemoteCreateTabSeed(projectId);
        if ('noDispatchableModel' in defaults)
          throw new AgentChatSendError(
            'target_not_ready',
            'No model is available for a new chat.',
          );
        // The provider follows the resolved model; a seed cannot split them.
        if (
          newChatSeed?.providerType !== undefined &&
          newChatSeed.providerType !== defaults.providerType
        )
          throw new AgentChatSendError(
            'validation_failed',
            'A new chat’s provider must match its model.',
          );
        // The checked selection, not the seed's raw id, is the stored model.
        const { model: _seedModel, ...seedSettings } = newChatSeed ?? {};
        void _seedModel;
        // The remembered interactive billing choice is for a person's new
        // chat; an automation's native send never applied it.
        const {
          aiCreditsRouting: _routing,
          subscriptionBillingOverride: _override,
          ...unbilledDefaults
        } = defaults;
        void _routing;
        void _override;
        seed = {
          ...(automationRun ? unbilledDefaults : defaults),
          ...seedSettings,
          // A partial seed config patches the defaults, as a send's does.
          ...(newChatSeed?.modelConfig
            ? {
                modelConfig: mergeAgentModelConfig(
                  defaults.modelConfig,
                  newChatSeed.modelConfig,
                ),
              }
            : {}),
        };
        if (chatTitle !== undefined) seed = { ...seed, title: chatTitle };
        if (thinkingLevel !== undefined) {
          // Checked against the model the new chat stores, before any write.
          const { assertCreationThinkingLevel } =
            await import('./creation-model');
          await assertCreationThinkingLevel(
            thinkingLevel,
            requestedModel ?? seed.model,
            { projectId, taskId },
          );
          seed = {
            ...seed,
            modelConfig: mergeAgentModelConfig(seed.modelConfig, {
              thinkingLevel,
            }),
          };
        }
        // A code task's worktree must exist before its first message is
        // admitted against the new worktree's root, as chat.create did.
        if (codeTask && createTaskAction) {
          if (action.initialMessage !== undefined)
            await context.startPrecheck?.(projectId);
          // CAN-5830 D9: an agent creates a worktree only while a person can
          // see the calling chat's work, as chat.create's new worktree did.
          const { agentChatInterfacePresent, AGENT_CHAT_INTERFACE_TEXTS } =
            await import('../canopy-tools/agent-chat-interface');
          if (
            !source ||
            !agentChatInterfacePresent({
              projectId: source.projectId,
              worktreeId: source.worktreeId,
              chatId: source.chatId,
              action: {
                type: 'worktree.create',
                workspaceId: projectId,
                select: false,
              },
            })
          )
            throw new AgentChatSendError(
              'target_not_ready',
              AGENT_CHAT_INTERFACE_TEXTS.needsWindow,
            );
          const { createAgentTaskWorktree } =
            await import('./creation-worktree');
          taskId = await createAgentTaskWorktree({
            projectId,
            workspaceKind,
            branchName: createTaskAction.branchName,
            baseBranch: createTaskAction.baseBranch,
            baseTaskId: createTaskAction.baseTaskId,
          });
          // A worktree has no title of its own; the founding chat carries it.
          const title = createTaskAction.title?.trim();
          if (title) seed = { ...seed, title };
        }
        // CAN-5479: a granted approval mode resolves as the native send's
        // did, with no agent admission, which the native send never had.
        const granted =
          nativeGrant?.approvalMode !== undefined
            ? await (
                await import('./turn-override')
              ).resolveAutomationApprovalMode(
                projectId,
                nativeGrant.approvalMode,
              )
            : undefined;
        const started =
          granted === undefined
            ? await context.startAdmission?.(
                { workspaceId: projectId, worktreeId: taskId },
                action.initialMessage !== undefined,
                codeTask,
              )
            : undefined;
        if (granted !== undefined) seed = { ...seed, approvalMode: granted };
        else if (!started && agentOriginated && newChatSeed?.approvalMode)
          throw new AgentChatSendError(
            'authorization_conflict',
            'An agent-originated run cannot choose approvals for a new chat.',
          );
        if (started) {
          // D11: an agent-originated run starts within its agent's approvals.
          if (
            newChatSeed?.approvalMode !== undefined &&
            newChatSeed.approvalMode !== started.approvalMode
          )
            throw new AgentChatSendError(
              'authorization_conflict',
              'An agent-originated run cannot start a chat with other approvals.',
            );
          seed = {
            ...seed,
            approvalMode: started.approvalMode,
            ...(started.selectedRepoId
              ? { selectedRepoId: started.selectedRepoId }
              : {}),
          };
        }
      } else if (newChatSeed) {
        // D11: bot creation has no start admission to take approvals from;
        // a native grant's are the native action's own (CAN-5479).
        if (
          agentOriginated &&
          newChatSeed.approvalMode &&
          nativeGrant === undefined
        )
          throw new AgentChatSendError(
            'authorization_conflict',
            'An agent-originated run cannot choose approvals for a new chat.',
          );
        // A pipeline's own bot settings; never project defaults.
        seed = { ...newChatSeed };
      }
      // Advisor resolves its own defaults at its first send, just like
      // advisor-chat.create_entry. Do not stamp project defaults on bots.
      if (taskCreated && !codeTask) {
        const title = 'title' in action ? action.title?.trim() : undefined;
        const created = await createWorkEntry(projectId, {
          id: taskId,
          createdAt: new Date().toISOString(),
          ...(title ? { title } : {}),
        });
        allocatedEntry = !created.reusedExistingEmpty;
        if (allocatedEntry) allocatedEntryCreatedAt = created.entry.createdAt;
      }
      // A created task's founding tab shares its id; the pipeline host journal relies on this (host-create-entry.ts).
      const tabId =
        taskCreated && !codeTask ? taskId : (fixedTabId ?? randomUUID());
      const createTab = { type: 'chat.create_tab' as const, tabId, ...seed };
      const dispatchCommand = dispatchCreationCommand;
      if (starterTabId !== undefined) {
        // Refused when the starter is no longer blank, and only creates the
        // replacement in place of the task's last tab: either way the chat
        // is then created beside the others.
        const replaced = await dispatchCommand(randomUUID(), {
          type: 'chat.close_tab',
          tabId: starterTabId,
          mode: 'discard_empty',
          replacementTab: createTab,
        });
        if (
          (replaced.outcome === 'applied' ||
            replaced.outcome === 'already_applied') &&
          (await readTaskRuntimeSnapshot(projectId, taskId)).tabsFile.tabs.some(
            (tab) => tab.id === tabId,
          )
        )
          chatId = tabId;
      }
      if (chatId === undefined) {
        const result = await dispatchCommand(
          context.fixedIds?.createTabCommandId ?? randomUUID(),
          createTab,
        );
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied'
        )
          throw new AgentChatSendError(
            result.outcome === 'not_found' ? 'not_found' : 'target_not_ready',
            result.reason ?? 'The target refused chat creation.',
          );
        chatId = result.entityId;
      }
      const snapshot = await readTaskRuntimeSnapshot(projectId, taskId);
      if (
        !chatId ||
        !snapshot.tabsFile.tabs.some(
          (tab) => tab.id === chatId && tab.kind !== 'file',
        )
      )
        throw new AgentChatSendError(
          'target_not_ready',
          'The created chat is not available.',
        );
      if (selection?.executionHarness !== undefined) {
        try {
          await pinHarness(chatId, selection.executionHarness, selection.model);
        } catch (error) {
          // The tab exists but never started: discard it, and the entry this
          // creation allocated, so a retry does not leave a duplicate behind.
          await dispatchCommand(randomUUID(), {
            type: 'chat.close_tab',
            tabId: chatId,
            mode: 'discard_empty',
          }).catch(() => undefined);
          if (allocatedEntryCreatedAt !== undefined)
            await removeUnstartedWorkEntry(
              projectId,
              taskId,
              allocatedEntryCreatedAt,
            ).catch(() => undefined);
          throw error;
        }
      }
    }
    if (!chatId)
      throw new AgentChatSendError(
        'target_not_ready',
        'The created chat is not available.',
      );
    // A replay that was interrupted between creating the tab and pinning it
    // finds the tab on the model's own harness; apply the pin it missed.
    if (
      replayedTab &&
      selection?.executionHarness !== undefined &&
      replayedHarness !== selection.executionHarness
    )
      await pinHarness(chatId, selection.executionHarness, selection.model);
    const address = projectAction
      ? { projectId, taskId, chatId }
      : { botId: action.botId, taskId, chatId };
    await context.onChatResolved?.({ chatId, created: chatCreated });
    // Readback of an explicit selection: the stored model and any Agent.
    const selected = selection ?? {};
    if (action.initialMessage !== undefined) {
      const sendAction = projectAction
        ? {
            type: 'projects.send_message' as const,
            projectId,
            taskId,
            chatId,
            text: action.initialMessage,
            // A pipeline's, or a new worktree's, first message waits for setup.
            ...((trusted.kind === 'pipeline' && codeProject) || codeTask
              ? { queueForSetup: true }
              : {}),
            ...(projectCreation?.watchers
              ? { watchers: projectCreation.watchers }
              : {}),
          }
        : {
            type: 'bots.send_message' as const,
            botId: action.botId,
            taskId,
            chatId,
            text: action.initialMessage,
          };
      // CAN-5479: the granted chat's first message is the native action's
      // prompt, which the native send made without the agent's admission.
      const { admission: _admission, ...unadmitted } = context;
      void _admission;
      try {
        const accepted = await dispatchAgentChatSend(
          sendAction,
          nativeGrant?.approvalMode !== undefined
            ? unadmitted
            : // A worktree in the caller's own project is admitted as a started
              // chat, against the caller's carried root; one elsewhere takes
              // the ordinary send admission, which its start admission matched.
              codeTask && source?.projectId === projectId
              ? { ...context, startedChat: true }
              : context,
        );
        return {
          address,
          taskCreated,
          chatCreated,
          ...selected,
          input: accepted,
        };
      } catch (error) {
        // Typed send refusals precede acceptance. An unconfirmed provider or
        // transport failure may have accepted the input: retain partial state.
        ambiguousInput = !(error instanceof AgentChatSendError);
        throw error;
      }
    }
    return { address, taskCreated, chatCreated, ...selected };
  } catch (error) {
    const missingFolder = readCoworkFolderMissing(error);
    if (missingFolder) {
      try {
        const service = getChatStateService();
        const scope = { projectId, worktreeId: taskId };
        await service.runWithScopeDeletion(scope, async () => {
          if (chatCreated && !replayedTab && chatId)
            await service.rollbackUnstartedCoworkTab(scope, chatId, [], true);
          if (allocatedEntryCreatedAt !== undefined)
            await removeUnstartedWorkEntry(
              projectId,
              taskId,
              allocatedEntryCreatedAt,
            );
        });
      } catch (cleanupError) {
        throw Object.assign(
          new AgentChatSendError(
            'cowork_folder_missing',
            `${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            error instanceof Error ? error : undefined,
          ),
          {
            workspaceId: missingFolder.workspaceId,
            folderName: missingFolder.folderName,
          },
        );
      }
      throw error;
    }
    if (allocatedEntry && !ambiguousInput) {
      // The available removal API only edits the registry, not chat storage.
      // Keep even our empty founding tab: safely removing an entry AND its tab
      // needs an existing conditional deletion boundary, not a hand-rolled one.
      // Unreadable state is never proof that an entry has no chat.
      const empty = await readChatTabsFile(projectId, taskId).then(
        (tabs) => !tabs.tabs.some((tab) => (tab.kind ?? 'chat') === 'chat'),
        () => false,
      );
      if (empty)
        await removeWorkEntryRow(projectId, taskId).catch(() => undefined);
    }
    throw error;
  }
}
