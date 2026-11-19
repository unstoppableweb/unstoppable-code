import { randomUUID } from 'node:crypto';
import { allowlistedErrnoOrOther } from '@canopy/core-runtime';
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
import { openAntigravityExtensions } from '../antigravity/extensions';
import { captureAntigravityCapabilitySnapshot } from '../antigravity/capability-snapshot';
import { assertTurnAuthDependencies } from '../lib/auth-preflight';
import { logMainProcessWarn } from '../lib/main-process-logging';

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
      prepareCapabilities: async (input) => {
        const projectId = request.projectId ?? 'pipeline';
        // Auth before inference: a selected dependency already known to be
        // signed out refuses the step before Google is asked anything. The
        // step runs only its own selections, never global defaults.
        // The cached check covers MCP dependencies only, so a step that
        // loads no MCP servers skips it.
        if (request.permissionPreset === 'dangerous_all')
          await assertTurnAuthDependencies({
            target: {
              projectId,
              worktreeId: request.executionId,
              chatId: sessionKey,
            },
            ...(request.pluginSelections
              ? { pluginSelections: request.pluginSelections }
              : {}),
            providerType: 'antigravity',
            applyGlobalPluginDefaults: false,
          });
        input.signal.throwIfAborted();
        const extensions = await openAntigravityExtensions({
          sessionKey,
          options: {
            cwd: request.cwd,
            projectId,
            worktreeId: request.executionId,
            chatId: sessionKey,
            pluginSelections: request.pluginSelections,
            packageOverlay: request.packageOverlay,
            applyGlobalPluginDefaults: false,
          },
          approval,
          signal: input.signal,
          planMode: request.permissionPreset === 'plan',
          stopTurn: input.stopTurn,
          ownsSessionResources: input.ownsResources,
          toolCallAllowed: input.toolCallAllowed,
          // Only a dangerous_all step can call a selected MCP tool; other
          // presets keep their skills and commands and load no servers.
          includeMcp: request.permissionPreset === 'dangerous_all',
          skipUnsupportedMcp: false,
        });
        return {
          servers: extensions.servers,
          instructions: extensions.instructions,
          expandPrompt: (text) => extensions.expandPrompt(text),
          captureSnapshot: (signal) =>
            captureAntigravityCapabilitySnapshot({
              appServers: [],
              extensions: extensions.snapshot,
              grants: {
                toolSurface: 'pipeline',
                appTools: [],
                codeGraph: false,
                feed: false,
                deferredTools: false,
                delegation: false,
                planMode: request.permissionPreset === 'plan',
                approvalMode: request.permissionPreset,
                childInheritance: 'none',
              },
              signal,
              // Slow starts and token refreshes get longer than a chat turn
              // gives evidence; the step's deadline still bounds the wait.
              budgetMs: 30_000,
            }),
          close: () => extensions.close(),
        };
      },
      dispose: () => {
        approval.invalidatePending?.();
        approval.dispose();
      },
      // main.log is bundled into feedback diagnostics unredacted, and the
      // original can hold local paths or record contents, so only the closed
      // code and an allowlisted errno are logged (CAN-7117).
      onLocalDiagnostic: ({ code, cause }) =>
        logMainProcessWarn(
          `[antigravity-pipeline] selected capabilities check failed: ${code} (${allowlistedErrnoOrOther(cause)})`,
        ),
    },
  );
}
