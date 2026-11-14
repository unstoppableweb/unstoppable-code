import type { BrowserWindow } from 'electron';
import {
  requireProviderForModel,
  getExecutionHarnessForModel,
  IPC_CHANNELS,
  normalizeThinkingForProvider,
  resolveKnownModel,
  type AgentProviderType,
  type ChatModel,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from './window-send';
import { dispatchWorktreeChatTurn } from './worktree-chat-turn';
import { runAdmittedDirectDispatch } from '../services/chat-queue-service';
import {
  commitProviderChatEvent,
  completePersistedChatTabTurn,
  emitChatDispatchFailure,
  removePersistedChatTab,
  upsertPersistedChatTab,
} from './chat-tab-dispatch-utils';
import {
  NoDispatchableModelError,
  resolveOptionalLaneAwareDefaultSelection,
} from './default-model-lane-resolver';
import { getChatStateService } from '../services/chat-state-service';
import { resolvePersistedApprovalMode } from './approval-mode-resolution';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';

let generatedIdCounter = 0;

function nextGeneratedId(prefix: string): string {
  generatedIdCounter += 1;
  return `${prefix}-rebase-${Date.now()}-${generatedIdCounter}`;
}

export type RebaseResolutionKind = 'rebase_conflict' | 'stash_pop_conflict';

interface ResolutionContext {
  kind: RebaseResolutionKind;
  repoName: string;
  branchName: string;
  repoPath: string;
  commitMessage?: string;
  errorMessage: string;
}

function buildInitialTitle(context: ResolutionContext): string {
  return context.kind === 'rebase_conflict'
    ? `Resolve rebase conflicts in ${context.repoName}`
    : `Resolve stash-pop conflicts in ${context.repoName}`;
}

function buildPromptText(context: ResolutionContext): string {
  const header =
    context.kind === 'rebase_conflict'
      ? `A \`git pull --rebase --autostash\` on branch \`${context.branchName}\` in repo \`${context.repoName}\` left the working tree mid-rebase with unresolved conflicts.`
      : `A \`git pull --rebase --autostash\` on branch \`${context.branchName}\` in repo \`${context.repoName}\` completed the rebase but the autostash could not be re-applied — the stash entry is retained and the working tree has conflict markers.`;

  const state =
    context.kind === 'rebase_conflict'
      ? [
          'Current state:',
          `- The repo is mid-rebase (\`.git/rebase-merge\` / \`.git/rebase-apply\` is present).`,
          `- Conflicting files are listed as "Unmerged paths" in \`git status\`.`,
          `- No stash apply has happened yet (the autostash is being held until the rebase completes or is aborted).`,
        ].join('\n')
      : [
          'Current state:',
          `- The rebase itself completed successfully.`,
          `- When git popped the autostash back, one or more files conflicted.`,
          `- The autostashed entry is still present in \`git stash list\` as a safety net.`,
          `- Conflicting files are listed as "Unmerged paths" in \`git status\`.`,
        ].join('\n');

  const commitPlan = context.commitMessage
    ? `The original commit message (pre-reviewed by the user) is:\n\n\`\`\`\n${context.commitMessage}\n\`\`\``
    : "No pre-reviewed commit message was provided — generate one that follows this repo's conventions once the conflicts are resolved and you have staged the final tree.";

  const gitError = context.errorMessage.trim()
    ? `The git command failed with:\n\n\`\`\`\n${context.errorMessage.trim()}\n\`\`\``
    : '';

  const steps = [
    `Repo path: \`${context.repoPath}\``,
    '',
    'Your task:',
    context.kind === 'rebase_conflict'
      ? '1. Inspect `git status` and the conflicting files. Resolve each conflict while preserving the intent of both sides (my in-flight work and the incoming remote commits).'
      : '1. Inspect `git status` and the conflicting files. Resolve each conflict while preserving the intent of both sides (my in-flight work from the autostash and the now-rebased local branch).',
    context.kind === 'rebase_conflict'
      ? '2. `git add` the resolved files and run `git rebase --continue` until the rebase completes. If more conflicts appear during continuation, resolve each one the same way.'
      : '2. `git add` the resolved files (this completes the in-progress merge from the stash pop).',
    context.kind === 'rebase_conflict'
      ? '3. After the rebase finishes, confirm that `git status` is clean of unmerged paths. The autostash (if any) will have been popped automatically — if it conflicted, fall back into the stash-pop resolution workflow.'
      : '3. Once there are no unmerged paths, drop the retained autostash entry with `git stash drop stash@{0}` (confirm it is the autostash entry first via `git stash list`).',
    `4. Stage all remaining changes with \`git add -A\`, then create a single commit with \`git commit -m "<message>"\`.`,
    '5. Push the branch with `git push -u origin HEAD`.',
    '6. Summarize what you resolved and report that the commit-and-push completed.',
    '',
    'Do NOT `git rebase --abort` or `git stash drop` without finishing the resolution — the user explicitly asked to complete this flow.',
    'If at any point you cannot proceed safely (e.g., the conflicts require human judgment about intent), stop and describe exactly what you need from the user.',
  ].join('\n');

  const sections = [header, state, commitPlan];
  if (gitError) {
    sections.push(gitError);
  }
  sections.push(steps);
  return sections.join('\n\n');
}

function buildInitialMessages(args: {
  context: ResolutionContext;
  userMessageId: string;
  promptText: string;
}): PersistedChatMessage[] {
  const timestamp = Date.now();
  return [
    {
      id: nextGeneratedId('msg'),
      role: 'system',
      blocks: [
        {
          type: 'rebase_resolution_info',
          kind: args.context.kind,
          repoName: args.context.repoName,
          branchName: args.context.branchName,
          timestamp,
        },
      ],
      timestamp,
    },
    {
      id: args.userMessageId,
      role: 'user',
      blocks: [{ type: 'text', text: args.promptText }],
      timestamp,
    },
  ];
}

async function resolveModelAndThinking(
  prefs: PreferencesData,
  // Parity with the spawn: this launcher dispatches a worktree chat turn for
  // `projectId`, so a Canopy Environments credential assigned to that workspace
  // must be visible to the selection too.
  projectId: string,
): Promise<{
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: 'claude' | 'codex';
  thinkingLevel: ThinkingLevel;
}> {
  const configuredModel = prefs.agentRebaseResolutionModel;
  const explicitModel = configuredModel
    ? resolveKnownModel(configuredModel)
    : undefined;
  // Lane-aware, NOT `resolveOverallDefault`. This launcher passes its model to
  // `dispatchWorktreeChatTurn` EXPLICITLY, and central lane resolution there
  // only runs when `options.model === undefined` — so resolving the raw
  // preference here bypassed CAN-1929 and a credits-only user kept creating
  // rebase-resolution chats on the billing-unaware native default.
  //
  // BRANCH BEFORE THE AWAIT, exactly as `hook-chat.ts` and
  // `automations/service.ts` do. Lane resolution awaits both native auth
  // probes, the AI Credits lookup and policy evaluation; on a cold cache the
  // Claude probe alone can take ~20s and the Codex probe can spin up an
  // app-server process. An explicitly configured `agentRebaseResolutionModel`
  // supersedes the default, so paying that cost — and recording its
  // `lastProjectedDefaultModel` stamp and lane persistence — for an answer this
  // flow then discards would block a conflict chat the user needs NOW behind a
  // question it never asks.
  const laneSelection = explicitModel
    ? undefined
    : (
        await resolveOptionalLaneAwareDefaultSelection(prefs, 'worktree', {
          workspaceId: projectId,
        })
      ).requireModel();
  // Canonicalize the lane answer the same way the explicit branch already
  // does, so the persisted tab cannot hold an alias here while the sibling
  // `builtin-gh-chat.ts` launcher holds the canonical id for the same model.
  const laneModel = laneSelection
    ? (resolveKnownModel(laneSelection.model) ?? laneSelection.model)
    : undefined;
  const model = explicitModel ?? laneModel;
  if (!model) {
    // Unreachable in practice — `requireModel()` above already threw on the
    // lane branch, and `explicitModel` is non-null on the other — but the
    // compiler cannot prove it, so the guard stays.
    //
    // It throws the TYPED error deliberately: `ipc/github.ts` falls back to the
    // manual rebase guidance only for `NoDispatchableModelError`, so a bare
    // `Error` here would escape that fallback and replace the repo/branch/
    // how-to-resolve message with a billing string.
    throw new NoDispatchableModelError('billing-lane');
  }
  const providerType = requireProviderForModel(model);
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for rebase resolution model "${model}".`,
    );
  }
  if (executionHarness === 'antigravity')
    throw new Error(
      'Google subscription models are not available for automatic rebase resolution.',
    );
  if (executionHarness === 'cursor')
    throw new Error('Cursor is not available for automatic rebase resolution.');
  if (executionHarness === 'opencode')
    throw new Error('OpenCode is not available for rebase helpers.');
  if (executionHarness === 'copilot')
    throw new Error(
      'Copilot is not available for automatic rebase resolution.',
    );
  const configuredThinking = prefs.agentRebaseResolutionThinkingLevel;
  const thinkingLevel = normalizeThinkingForProvider(
    // Keyed on the NAMED model's provider, never the surface's preferred one —
    // same rule as `hook-chat.ts`. `laneSelection` is absent only on the
    // explicit-model branch, where the provider's own configured level is the
    // honest fallback; `'medium'` matches `normalizeThinkingForProvider`'s own
    // internal default for an unset level.
    configuredThinking ??
      laneSelection?.thinkingLevel ??
      prefs.defaultWorktreeModelByProvider[providerType]?.thinkingLevel ??
      'medium',
    executionHarness,
  );
  return { model, providerType, executionHarness, thinkingLevel };
}

async function persistTab(args: {
  projectId: string;
  worktreeId: string;
  tab: PersistedChatTab;
}): Promise<void> {
  // The user asked for the pull, so its resolution chat comes forward like
  // any chat they start; only chats nobody asked for stay behind.
  await upsertPersistedChatTab({
    ...args,
    activateTab: true,
  });
}

async function rollbackTab(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await removePersistedChatTab(args);
}

async function markDispatchFailed(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  errorMessage: string;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  await completePersistedChatTabTurn(args);
  await emitChatDispatchFailure(args);
}

export interface LaunchRebaseResolutionChatResult {
  chatId: string;
}

type LaunchRebaseResolutionChatArgs = {
  projectId: string;
  worktreeId: string;
  prefs: PreferencesData;
  context: ResolutionContext;
  getWindow: () => BrowserWindow | null;
};

async function launchRebaseResolutionChatWithScopeLease(
  args: LaunchRebaseResolutionChatArgs,
): Promise<LaunchRebaseResolutionChatResult> {
  const [modelSelection, approvalMode] = await Promise.all([
    resolveModelAndThinking(args.prefs, args.projectId),
    resolvePersistedApprovalMode(args.projectId, args.worktreeId),
  ]);
  const { model, providerType, executionHarness, thinkingLevel } =
    modelSelection;
  const chatId = nextGeneratedId('chat');
  const userMessageId = nextGeneratedId('msg');
  const promptText = buildPromptText(args.context);

  const tab: PersistedChatTab = {
    id: chatId,
    title: buildInitialTitle(args.context),
    messages: buildInitialMessages({
      context: args.context,
      userMessageId,
      promptText,
    }),
    createdAt: new Date().toISOString(),
    thinkingLevel,
    model,
    providerType,
    executionHarness,
    approvalMode,
    ...newChatPluginDefaultsStamp(args.projectId),
  };

  // Ordinary admission precedes the prompt's first effect (contracts §6).
  await runAdmittedDirectDispatch(
    { projectId: args.projectId, worktreeId: args.worktreeId, chatId },
    userMessageId,
    async (authorization): Promise<boolean> => {
      await persistTab({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        tab,
      });

      const delivered = sendToWindow(
        args.getWindow(),
        IPC_CHANNELS.chatHookTabStarted,
        {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId,
          tab,
          activateTab: true,
        },
      );
      if (!delivered) {
        await rollbackTab({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId,
        });
        throw new Error(
          'Rebase resolution chat requires an active renderer window before it can start.',
        );
      }

      try {
        await dispatchWorktreeChatTurn({
          ...(authorization ? { authorization } : {}),
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId,
          userMessageId,
          text: promptText,
          planMode: false,
          thinkingLevel,
          model,
          providerType,
          executionHarness,
          approvalMode,
          getWindow: args.getWindow,
          // Launched synchronously from the user's own Commit/Pull request, so it
          // runs in the context the user is working in (org memory may follow
          // the live sidebar context for a tab with none captured, CAN-3457).
          initiationSource: 'user',
          // Nobody typed this prompt, so analytics count it with automation.
          turnTrigger: 'automation',
          skipBranchNaming: true,
          onBeforeChatEvent: (event) =>
            commitProviderChatEvent({
              projectId: args.projectId,
              worktreeId: args.worktreeId,
              chatId,
              userMessageId,
              providerType,
              event,
            }),
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await markDispatchFailed({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId,
          errorMessage,
          getWindow: args.getWindow,
        });
        throw error;
      }

      return true;
    },
  );

  return { chatId };
}

export async function launchRebaseResolutionChat(
  args: LaunchRebaseResolutionChatArgs,
): Promise<LaunchRebaseResolutionChatResult> {
  return getChatStateService().runWithScopeActivity(
    { projectId: args.projectId, worktreeId: args.worktreeId },
    () => launchRebaseResolutionChatWithScopeLease(args),
  );
}
