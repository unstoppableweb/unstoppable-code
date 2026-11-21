import { randomUUID } from 'node:crypto';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type ClaudeForkToolResult,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { drainCurrentSessionEvents } from '../agents/session-event-router';
import { resolvePersistedChatExecutionHarness } from '@canopy/desktop-shared/types';
import {
  sanitizeSystemInstructionText,
  withWorktreeRelocationInstruction,
} from '@canopy/desktop-shared/lib/pending-system-instructions';
import { withChatAddressChangedInstruction } from '@canopy/desktop-shared/lib/chat-address-prompt';
import { agentChatAddress } from '../lib/agent-chat-address';
import { getChatStateService } from '../services/chat-state-service';
import {
  buildExistingTabDispatchOptions,
  sendWorktreeChatMessage,
} from '../services/chat-service';
import { clonePersistedWorktreeTab } from '../lib/worktree-open-tabs-fork';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { getCurrentBranch } from '../lib/git';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  createSingleRepoWorktree,
  createMultiRepoWorktree,
  type CreateWorktreeServiceOptions,
} from '../lib/worktree-service';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import {
  forkOpenCodeSessionByIdViaOneShot,
  discardUnpublishedOpenCodeFork,
} from '../opencode/fork-session';
import {
  getSessionInterfaceToolRegistry,
  interfaceToolAudience,
} from '../agents/interface-tool-binding';
import { presentAppAdvisorAction } from '../app-advisor/presentation-tools';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { activeAgentCoreOperations } from './active-agent-core-operations';
import {
  AGENT_CHAT_INTERFACE_TEXTS,
  agentChatInterfacePresent,
} from './agent-chat-interface';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import type { WorktreeActionRuntime } from './worktree-actions';
import { isClaudeChainUuid } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { closeRejectedSplitAgentStartup } from '../services/split-agent-startup';

/** What the source's split tool call returns to the forked chat itself. */
const FORK_TOOL_RESULT =
  'This is the independent forked chat. The source chat continues separately.';
const FORK_SIBLING_TOOL_RESULT =
  'Not run in this fork; the call belongs to the source chat.';

/**
 * Where a Claude fork of a chat taken inside its own split tool call resumes.
 * The snapshot ends on the assistant entry that made the call, which the fork
 * resumes at (the SDK anchors only on assistant entries) while answering every
 * call still open there. Returns `undefined` when the snapshot has no open
 * call, so the normal transcript-derived anchor applies.
 */
function claudeSplitForkAnchor(
  messages: readonly PersistedChatMessage[],
): { resumeAt: string; toolResults: ClaudeForkToolResult[] } | undefined {
  const open: string[] = [];
  let anchor: PersistedChatMessage | undefined;
  for (const message of messages) {
    if (message.parentToolUseId) continue;
    if (isClaudeChainUuid(message.claudeUuid)) anchor = message;
    for (const block of message.blocks) {
      if (block.type === 'tool_use') open.push(block.toolUseId);
      else if (block.type === 'tool_result') {
        const index = open.indexOf(block.toolUseId);
        if (index >= 0) open.splice(index, 1);
      }
    }
  }
  const splitToolUseId = open[open.length - 1];
  if (
    !splitToolUseId ||
    anchor?.role !== 'assistant' ||
    !isClaudeChainUuid(anchor.claudeUuid) ||
    !anchor.blocks.some(
      (block) =>
        block.type === 'tool_use' && block.toolUseId === splitToolUseId,
    )
  ) {
    return undefined;
  }
  return {
    resumeAt: anchor.claudeUuid,
    toolResults: open.map((toolUseId) => ({
      toolUseId,
      content:
        toolUseId === splitToolUseId
          ? FORK_TOOL_RESULT
          : FORK_SIBLING_TOOL_RESULT,
    })),
  };
}

/**
 * CAN-5830: a branched agent's prompt counts as queued only when the core
 * send applied it; a refused send fails the start, so its cleanup runs.
 */
export function assertBranchedPromptQueued(receipt: {
  outcome: string;
  reason?: string;
}): void {
  if (receipt.outcome === 'applied' || receipt.outcome === 'already_applied')
    return;
  throw new Error(
    receipt.reason ?? 'Could not queue the branched agent prompt.',
  );
}

/** Starts a separate user-visible chat; never waits for its agent turn. */
export async function startSplitAgent(
  kind: 'start_forked_agent' | 'start_branched_agent',
  input: { followUpInstruction: string },
  runtime: WorktreeActionRuntime & {
    appAdvisorSurfaces?: AppAdvisorToolRuntimeSurfaces;
  },
): Promise<{
  ok: true;
  chatId: string;
  worktreeId: string;
  delivery: 'submitted';
  independent: true;
  contextTransfer?: 'transcript';
}> {
  const {
    projectId,
    worktreeId: sourceWorktreeId,
    chatId: sourceChatId,
  } = runtime;
  runtime.signal?.throwIfAborted();
  if (
    kind === 'start_branched_agent' &&
    runtime.executionScope === 'directory'
  ) {
    throw new Error('Starting a branched agent requires a worktree chat.');
  }
  if (kind === 'start_branched_agent' && isBotProjectId(projectId)) {
    throw new Error('Starting a branched agent requires a Code worktree chat.');
  }
  if (
    // Default Bot only: this compatibility restriction is for the legacy global slot.
    projectId === APP_ADVISOR_PROJECT_ID &&
    sourceWorktreeId === APP_ADVISOR_WORKTREE_ID
  ) {
    throw new Error(
      'The legacy Orchestrator global slot cannot start a forked agent; select a Work Entry chat.',
    );
  }
  if (isBotProjectId(projectId) && !runtime.appAdvisorSurfaces) {
    throw new Error(
      'Starting an Orchestrator fork requires Orchestrator surfaces.',
    );
  }
  const sourceTarget = resolveWorktreeTargetIds(projectId, sourceWorktreeId);
  if (!sourceTarget) {
    throw new Error(
      'Starting forked or branched agents requires a worktree chat.',
    );
  }
  const config =
    kind === 'start_branched_agent'
      ? await readWorkspaceConfig(sourceTarget.projectId)
      : undefined;
  if (kind === 'start_branched_agent' && config?.type === 'cowork') {
    throw new Error('Starting a branched agent requires a worktree chat.');
  }
  // CAN-5830 D9: a branched agent starts only while a person can see it,
  // before anything is created.
  if (
    kind === 'start_branched_agent' &&
    !agentChatInterfacePresent({
      projectId,
      worktreeId: sourceWorktreeId,
      chatId: sourceChatId,
      action: {
        type: 'worktree-chat.send_message',
        projectId,
        worktreeId: sourceWorktreeId,
        chatId: sourceChatId,
        text: 'Continue',
      },
    })
  )
    throw new Error(AGENT_CHAT_INTERFACE_TEXTS.needsWindow);
  await drainCurrentSessionEvents({
    projectId,
    worktreeId: sourceWorktreeId,
    chatId: sourceChatId,
  });
  const state = getChatStateService();
  const tabs = await state.getCompatibilityTabs(
    {
      projectId,
      worktreeId: sourceWorktreeId,
    },
    { chatIds: [sourceChatId] },
  );
  const source = tabs.tabs.find((tab) => tab.id === sourceChatId);
  runtime.signal?.throwIfAborted();
  if (
    !source ||
    source.kind === 'file' ||
    source.readOnly ||
    !source.messages.length
  ) {
    throw new Error(
      'The source must be an existing editable chat with conversation history.',
    );
  }
  // Copy before any asynchronous work. Streaming events continue to mutate only
  // the source; lifecycle markers in the copy are settled by the normal fork helper.
  const sourceRoot = resolveWorktreeCwd(
    projectId,
    sourceWorktreeId,
    source.selectedRepoId,
  );
  const chatId = `chat-${randomUUID()}`;
  const cloned = clonePersistedWorktreeTab(
    source,
    {
      projectId,
      sourceWorktreeId,
      destinationWorktreeId: sourceWorktreeId,
    },
    sourceRoot,
    sourceRoot,
    chatId,
    new Date().toISOString(),
  );
  if (!cloned) throw new Error('The source chat cannot be forked.');
  // Metadata crosses the split boundary here; canonical persistence below
  // streams the complete source transcript and its artifact closure.
  cloned.messages = [];
  // These tools create native chats even when invoked from a managed terminal.
  // A copied terminal interface must not wait for a user to mount a terminal.
  cloned.interfaceMode = 'canopy';
  const harness = resolvePersistedChatExecutionHarness(source);
  const isOpenCode =
    harness === 'opencode' || source.providerType === 'opencode';
  if (isOpenCode && !source.sdkSessionId)
    throw new Error(
      'OpenCode needs a saved native session before it can start an independent fork.',
    );
  const transcriptFork =
    harness === 'cursor' || source.providerType === 'cursor';
  if (transcriptFork) {
    // Retries need a provider-owned stable receipt before startup can open.
    throw new Error(
      kind === 'start_branched_agent'
        ? 'Branched agents are not available for Cursor chats.'
        : 'Forked agents are not available for Cursor chats.',
    );
  }
  let unpublishedOpenCodeFork:
    | Parameters<typeof discardUnpublishedOpenCodeFork>[0]
    | undefined;
  let canonicalPublicationStarted = false;
  const forkProviderContext = async (
    destinationProjectId: string,
    destinationWorktreeId: string,
    destinationRoot: string,
  ): Promise<void> => {
    if (isOpenCode && source.sdkSessionId) {
      const forked = await forkOpenCodeSessionByIdViaOneShot({
        model: source.model,
        cwd: destinationRoot,
        projectId: destinationProjectId,
        worktreeId: destinationWorktreeId,
        chatId,
        sourceProjectId: projectId,
        sourceWorktreeId,
        sourceChatId,
        sourceCwd: sourceRoot,
        sourceSessionId: source.sdkSessionId,
        signal: runtime.signal,
      });
      cloned.sdkSessionId = forked.sessionId;
      if (forked.executionContext !== undefined)
        cloned.executionContext = forked.executionContext;
      if (cloned.forkedFrom) delete cloned.forkedFrom.modelContext;
      unpublishedOpenCodeFork = {
        projectId: destinationProjectId,
        worktreeId: destinationWorktreeId,
        chatId,
        cwd: destinationRoot,
        sessionId: cloned.sdkSessionId,
      };
      runtime.signal?.throwIfAborted();
      return;
    }
    if (harness !== 'codex' || !source.sdkSessionId) return;
    cloned.sdkSessionId = await forkCodexThreadByIdViaOneShot({
      cwd: destinationRoot,
      projectId: destinationProjectId,
      worktreeId: destinationWorktreeId,
      chatId,
      sourceThreadId: source.sdkSessionId,
      sourceProjectId: projectId,
      sourceWorktreeId,
      sourceChatId,
      pluginSelections: source.pluginSelections,
      modelConfig: source.modelConfig,
    });
  };
  try {
    runtime.signal?.throwIfAborted();
    if (kind === 'start_forked_agent') {
      // Fork while the source context is current, before worktree setup. Failing
      // here must not acknowledge a context-preserving start that never happened.
      await forkProviderContext(projectId, sourceWorktreeId, sourceRoot);
    }
    runtime.signal?.throwIfAborted();
    let destinationProjectId = projectId;
    let worktreeId = sourceWorktreeId;
    const handoff = ['You are now running as an independent forked chat.'];
    if (kind === 'start_branched_agent') {
      destinationProjectId = sourceTarget.projectId;
      const sourceBranch =
        config?.type === 'single-repo' || source.selectedRepoId
          ? await getCurrentBranch(sourceRoot)
          : undefined;
      let completeBranchedProviderFork = (): void => {};
      let branchedProviderForkCompleted = false;
      let branchedProviderForkError: Error | undefined;
      const branchedProviderFork =
        (harness === 'codex' || isOpenCode) && source.sdkSessionId
          ? new Promise<void>((resolve) => {
              completeBranchedProviderFork = resolve;
            })
          : undefined;
      const options: CreateWorktreeServiceOptions = {
        workspaceId: sourceTarget.projectId,
        baseWorktreeId: sourceTarget.worktreeId,
        deferGitSetup: true,
        startPostCreateSetup: true,
        startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
        startWorkspacePostCreateSetup: startWorkspaceWorktreePostCreateSetup,
        getWindow: runtime.getWindow,
        beforeGitReady: async (event): Promise<void> => {
          if (!branchedProviderFork) return;
          try {
            await forkProviderContext(
              destinationProjectId,
              event.worktreeId,
              resolveWorktreeCwd(
                destinationProjectId,
                event.worktreeId,
                source.selectedRepoId,
              ),
            );
            branchedProviderForkCompleted = true;
          } catch (error) {
            const normalizedError =
              error instanceof Error ? error : new Error(String(error));
            branchedProviderForkError = normalizedError;
            throw normalizedError;
          }
        },
        onGitSetupSettled: (event): void => {
          if (!branchedProviderFork) return;
          if (event.outcome !== 'ready' || !branchedProviderForkCompleted) {
            branchedProviderForkError ??= new Error(
              `Worktree setup ended before the ${isOpenCode ? 'OpenCode' : 'Codex'} context could be forked.`,
            );
          }
          completeBranchedProviderFork();
        },
        onGitReady: (event) =>
          runtime.interfacePort.publishWorktreeGitReady(event),
        onGitFailed: (event) => {
          if (branchedProviderFork) {
            branchedProviderForkError ??= new Error(event.error);
          }
          runtime.interfacePort.publishWorktreeGitFailed(event);
        },
        onNeedsRepair: (event) => {
          if (branchedProviderFork) {
            branchedProviderForkError ??= new Error(
              'The new worktree requires repair before starting a branched agent.',
            );
            // A repair detour keeps the setup pending, so no settlement
            // ends this wait.
            completeBranchedProviderFork();
          }
          runtime.interfacePort.publishWorktreeNeedsRepair(event);
        },
      };
      const created =
        config?.type === 'single-repo'
          ? await createSingleRepoWorktree(options)
          : await createMultiRepoWorktree(options);
      if ('needsRepair' in created && created.needsRepair) {
        throw new Error(
          'The new worktree requires repair before starting a branched agent.',
        );
      }
      worktreeId = created.id;
      await branchedProviderFork;
      if (branchedProviderForkError !== undefined) {
        throw branchedProviderForkError;
      }
      const destinationRoot = resolveWorktreeCwd(
        destinationProjectId,
        worktreeId,
        source.selectedRepoId,
      );
      cloned.pendingSystemInstructions = withWorktreeRelocationInstruction(
        cloned.pendingSystemInstructions,
        sourceRoot,
        destinationRoot,
        { sourceBranch },
      );
      runtime.interfacePort.publishWorkspaceWorktrees(
        destinationProjectId,
        await readWorkspaceWorktrees(destinationProjectId),
      );
    } else {
      const label = source.description?.trim() || source.title.trim() || 'Chat';
      cloned.title = label.startsWith('Fork: ') ? label : `Fork: ${label}`;
      delete cloned.description;
    }
    // Keep the visible prompt short. The ordinary one-shot instruction path
    // supplies the handoff to either provider and consumes it on accepted send.
    cloned.pendingSystemInstructions = [
      ...(cloned.pendingSystemInstructions ?? []).filter(
        (instruction) => instruction.id !== 'independent-agent-start',
      ),
      {
        id: 'independent-agent-start',
        text: sanitizeSystemInstructionText(
          [
            ...handoff,
            'Follow-up instruction from the originating tool call:',
            input.followUpInstruction,
          ].join('\n'),
        ),
      },
    ];
    cloned.pendingSystemInstructions = withChatAddressChangedInstruction(
      cloned.pendingSystemInstructions,
      agentChatAddress(destinationProjectId, worktreeId, cloned.id),
      agentChatAddress(projectId, sourceWorktreeId, sourceChatId),
    );
    // A Claude fork is taken inside the source's own split call; see
    // `claudeSplitForkAnchor`. Branches keep the transcript-derived anchor.
    const splitAnchor =
      kind === 'start_forked_agent' &&
      harness === 'claude' &&
      source.sdkSessionId
        ? claudeSplitForkAnchor(source.messages)
        : undefined;
    const sourceScope = { projectId, worktreeId: sourceWorktreeId };
    const destinationScope = { projectId: destinationProjectId, worktreeId };
    const atMessageId = cloned.forkedFrom?.atMessageId;
    let turnAccepted = false;
    runtime.signal?.throwIfAborted();
    canonicalPublicationStarted = true;
    // From this point a failed write may still have published the new tab.
    // Roll back only this unique destination, through the canonical owner.
    try {
      runtime.signal?.throwIfAborted();
      if (kind === 'start_branched_agent') {
        await state.copyStorageChats(
          sourceScope,
          destinationScope,
          {
            version: 1,
            tabs: [cloned],
            activeTabId: chatId,
          },
          { version: 1, archived: [] },
          { [chatId]: sourceChatId },
          undefined,
          atMessageId ? { [chatId]: atMessageId } : undefined,
        );
      } else {
        const persisted = await state.command({
          schemaVersion: 1,
          commandId: randomUUID(),
          projectId,
          worktreeId: sourceWorktreeId,
          command: {
            type: 'chat.fork_tab',
            sourceTabId: sourceChatId,
            targetTabId: chatId,
            // The private native transfer above already supplied the context.
            ...(isOpenCode ? { cloneMode: 'continuation' as const } : {}),
            ...(atMessageId ? { atMessageId } : {}),
            destinationTab: cloned,
          },
        });
        if (persisted.outcome !== 'applied') {
          throw new Error(
            persisted.reason ?? 'The source chat cannot be forked canonically.',
          );
        }
        // Canonical fork construction clears independently forked session IDs until
        // the native context transfer settles. This path already awaited that fork,
        // so publish the resulting independent thread before dispatch.
        if ((harness === 'codex' || isOpenCode) && cloned.sdkSessionId) {
          await state.updateCompatibilityTab(
            destinationScope,
            chatId,
            (tab) => ({ ...tab, sdkSessionId: cloned.sdkSessionId }),
            undefined,
            { metadataOnly: true },
          );
        }
        // Canonical fork construction cannot anchor a Claude fork on the open
        // split call and marks it fresh; the first send below resumes at that
        // call instead, so restore the carried session and its fork marker. A
        // CLI refusal still re-marks the fork fresh on its init event.
        if (splitAnchor && source.sdkSessionId) {
          const sourceSessionId = source.sdkSessionId;
          await state.updateCompatibilityTab(
            destinationScope,
            chatId,
            (tab) => {
              const forkedFrom = tab.forkedFrom
                ? { ...tab.forkedFrom, resumePointRequired: true }
                : undefined;
              if (forkedFrom) delete forkedFrom.modelContext;
              return {
                ...tab,
                sdkSessionId: sourceSessionId,
                claudeForkSessionOnNextSend: true,
                ...(forkedFrom ? { forkedFrom } : {}),
              };
            },
            undefined,
            { metadataOnly: true },
          );
        }
      }
      runtime.signal?.throwIfAborted();
      if (kind === 'start_branched_agent') {
        // Main's chat send holds the prompt while the new worktree's Git
        // setup runs (CAN-5830); the reveal is a best-effort presentation.
        const commandId = `agent-branched-send:${chatId}`;
        const receipt = await activeAgentCoreOperations(
          'chatActions',
        ).instruction(
          'core.chat.message.send',
          {
            scope: { workspaceId: destinationProjectId, worktreeId },
            commandId,
            chatId,
            messageId: randomUUID(),
            text: 'Continue',
            _meta: { idempotencyKey: commandId },
          },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: `agent-action:${sourceChatId}`,
              authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
              interfaceKind: 'mcp',
              grants: ['core.chat.write'],
            },
            metadata: { idempotencyKey: commandId },
          },
        );
        assertBranchedPromptQueued(receipt);
        await presentAppAdvisorAction({
          action: {
            type: 'worktree-chat.open_tab',
            projectId: destinationProjectId,
            worktreeId,
            chatId,
          },
          destination: {
            projectId: projectId,
            worktreeId: sourceWorktreeId,
            chatId: sourceChatId,
          },
          boundTools:
            getSessionInterfaceToolRegistry()?.availableFor(
              interfaceToolAudience(sourceChatId),
            ) ?? [],
        }).catch(() => undefined);
      } else {
        const dispatch = await buildExistingTabDispatchOptions(
          destinationProjectId,
          worktreeId,
          chatId,
        );
        // The transcript-derived anchor refuses the open split call and would
        // start the fork fresh; resume at the call and answer it instead.
        runtime.signal?.throwIfAborted();
        await sendWorktreeChatMessage(
          {
            ...dispatch,
            ...(splitAnchor && source.sdkSessionId
              ? {
                  sdkSessionId: source.sdkSessionId,
                  claudeForkSession: true,
                  claudeForkResumeAt: splitAnchor.resumeAt,
                  claudeForkToolResults: splitAnchor.toolResults,
                  claudeForkStartsFresh: undefined,
                }
              : {}),
            projectId: destinationProjectId,
            worktreeId,
            chatId,
            text: 'Continue',
          },
          {
            getWindow: runtime.getWindow,
            admissionSignal: runtime.signal,
            onTurnAccepted: () => {
              turnAccepted = true;
            },
            ...(runtime.appAdvisorSurfaces
              ? { appAdvisorSurfaces: runtime.appAdvisorSurfaces }
              : {}),
          },
        );
      }
      return {
        ok: true,
        chatId,
        worktreeId,
        delivery: 'submitted',
        independent: true,
        ...(transcriptFork ? { contextTransfer: 'transcript' as const } : {}),
      };
    } catch (error) {
      if (turnAccepted) throw error;
      return closeRejectedSplitAgentStartup(
        { ...destinationScope, chatId },
        error,
        state,
      );
    }
  } catch (error) {
    if (!canonicalPublicationStarted && unpublishedOpenCodeFork) {
      await discardUnpublishedOpenCodeFork(unpublishedOpenCodeFork);
    }
    throw error;
  }
}
