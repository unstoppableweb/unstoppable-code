// Form + display helpers for the `worktree_session_prompt` automation action.
// Form-authored activities carry optional explicit settings and logical references.
// Chat-authored scheduled messages retain their existing attachment payloads.

import type {
  AgentModelConfig,
  ApprovalMode,
  ChatModel,
  ChatTabPluginSelections,
  ConfiguredPromptReference,
  AutomationAction,
  ChatAttachmentPromptContext,
  FileReference,
  UsageLimitResumeInterruption,
} from '@canopy/desktop-shared/types';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { validateConfiguredPromptReferences } from '@canopy/protocol/configured-prompt-references';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';

export interface WorktreeSessionTarget {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  workspaceName?: string;
  worktreeName?: string;
  chatTitle?: string;
}

type WorktreeSessionPromptAction = Extract<
  AutomationAction,
  { type: 'worktree_session_prompt' }
>;

/** Extract the readonly target identity (+ display names) from an action. */
export function worktreeSessionTargetFromAction(
  action: WorktreeSessionPromptAction,
): WorktreeSessionTarget {
  return {
    workspaceId: action.workspaceId,
    worktreeId: action.worktreeId,
    chatId: action.chatId,
    ...(action.workspaceName ? { workspaceName: action.workspaceName } : {}),
    ...(action.worktreeName ? { worktreeName: action.worktreeName } : {}),
    ...(action.chatTitle ? { chatTitle: action.chatTitle } : {}),
  };
}

/**
 * Rebuild a session action with explicit settings for form-authored prompts.
 * Chat-authored callers retain their reference and attachment metadata while
 * the form permits choosing a new destination.
 */
export function buildWorktreeSessionPromptAction(args: {
  target: WorktreeSessionTarget;
  prompt: string;
  promptReferences?: ConfiguredPromptReference[];
  model?: ChatModel;
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  pluginSelections?: ChatTabPluginSelections;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  inputMode?: 'typed' | 'voice';
  purpose?: 'usage_limit_resume' | 'scheduled_send';
  /** A usage-limit watcher's guard (CAN-7483); kept through every edit. */
  resumeWhen?: 'provider_usage_clear';
  usageResumeInterruption?: UsageLimitResumeInterruption;
}): { action?: AutomationAction; error?: string } {
  const prompt = args.prompt.trim();
  const error = validateConfiguredPromptReferences(
    args.prompt,
    args.promptReferences,
  );
  if (error) return { error };
  const leadingWhitespace = args.prompt.length - args.prompt.trimStart().length;
  if (
    !args.target.workspaceId ||
    !args.target.worktreeId ||
    !args.target.chatId
  ) {
    return {
      error: `${WORKTREE_UNIT_LABEL} Session prompt is missing its target chat.`,
    };
  }
  if (!prompt) {
    return { error: 'Enter a prompt for the scheduled message.' };
  }
  const fileReferences = (args.fileReferences ?? [])
    .map((ref) => ({
      displayPath: ref.displayPath.trim(),
      absolutePath: ref.absolutePath.trim(),
      ...(ref.kind ? { kind: ref.kind } : {}),
      ...(ref.textStart !== undefined
        ? { textStart: ref.textStart - leadingWhitespace }
        : {}),
      ...(ref.repoName?.trim() ? { repoName: ref.repoName.trim() } : {}),
    }))
    .filter((ref) => ref.displayPath.length > 0 && ref.absolutePath.length > 0);
  const attachmentPaths = (args.attachmentPaths ?? [])
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  const attachmentPathSet = new Set(attachmentPaths);
  const attachmentPromptContexts = (args.attachmentPromptContexts ?? []).filter(
    (context) => attachmentPathSet.has(context.attachmentPath),
  );
  const action: WorktreeSessionPromptAction = {
    type: 'worktree_session_prompt',
    workspaceId: args.target.workspaceId,
    worktreeId: args.target.worktreeId,
    chatId: args.target.chatId,
    prompt,
    ...(args.promptReferences?.length
      ? {
          promptReferences: args.promptReferences.map((ref) => ({
            ...ref,
            textStart: ref.textStart - leadingWhitespace,
          })),
        }
      : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.modelConfig !== undefined
      ? { modelConfig: args.modelConfig }
      : {}),
    ...(args.planMode !== undefined ? { planMode: args.planMode } : {}),
    ...(args.approvalMode !== undefined
      ? { approvalMode: args.approvalMode }
      : {}),
    ...(args.plugins?.length ? { plugins: args.plugins } : {}),
    ...(args.pluginSelections !== undefined
      ? { pluginSelections: args.pluginSelections }
      : {}),
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    ...(attachmentPromptContexts.length > 0
      ? { attachmentPromptContexts }
      : {}),
    ...(args.inputMode ? { inputMode: args.inputMode } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.resumeWhen ? { resumeWhen: args.resumeWhen } : {}),
    ...(args.usageResumeInterruption
      ? { usageResumeInterruption: args.usageResumeInterruption }
      : {}),
    ...(args.target.workspaceName
      ? { workspaceName: args.target.workspaceName }
      : {}),
    ...(args.target.worktreeName
      ? { worktreeName: args.target.worktreeName }
      : {}),
    ...(args.target.chatTitle ? { chatTitle: args.target.chatTitle } : {}),
  };
  return { action };
}
