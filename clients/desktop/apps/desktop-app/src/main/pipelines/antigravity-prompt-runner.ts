import { randomUUID } from 'node:crypto';
import { runAntigravityPipelinePrompt } from '@canopy/desktop-shared/node/pipelines/antigravity-prompt-runner';
import { antigravityReadRules } from '@canopy/desktop-shared/node/antigravity/tool-approval';
import type {
  AntigravityPromptRunnerRequest,
  AntigravityPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { createApprovalSession } from '../approvals/approval-service';
import { authorizeAntigravityTool } from '../antigravity/tool-approval';
import { openAntigravityRuntime } from '../antigravity/runtime';
import { isAntigravityConnectionEnabled } from '../antigravity/connection';

export async function runDesktopAntigravityPipelinePrompt(
  request: AntigravityPromptRunnerRequest,
): Promise<AntigravityPromptRunnerResult> {
  const stop = new AbortController();
  const sessionKey = `antigravity-pipeline:${randomUUID()}`;
  const approval = createApprovalSession({
    sessionKey,
    projectId: request.projectId ?? 'pipeline',
    worktreeId: request.executionId,
    chatId: sessionKey,
    provider: 'antigravity',
    workspaceRoot: request.cwd,
    mode: request.permissionPreset === 'dangerous_all' ? 'full-access' : 'ask',
    sessionRules: antigravityReadRules(request.permissionPreset),
    getWindow: () => null,
    trackChatTurn: false,
  });
  const assertEnabled = async (): Promise<void> => {
    stop.signal.throwIfAborted();
    if (!(await isAntigravityConnectionEnabled()))
      throw new Error('Google is disconnected or unavailable.');
  };
  return runAntigravityPipelinePrompt(
    {
      ...request,
      signal: AbortSignal.any([
        request.signal ?? new AbortController().signal,
        stop.signal,
      ]),
    },
    {
      assertEnabled,
      open: (input) =>
        openAntigravityRuntime({
          ...input,
          cwd: request.cwd,
          environment: request.environment,
          owner: { kind: 'pipeline', id: request.executionId },
        }),
      authorize: (permission) =>
        authorizeAntigravityTool(permission, {
          approval,
          cwd: request.cwd,
          planMode: request.permissionPreset === 'plan',
          stopTurn: () => stop.abort(),
        }),
      dispose: () => {
        approval.invalidatePending?.();
        approval.dispose();
      },
    },
  );
}
