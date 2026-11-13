import { openOpenCodeExecutionRuntime } from '../opencode/execution-runtime';
import { resolveRoutingOverrideAttribution } from '../agents/ai-credits-routing';
import { randomUUID } from 'node:crypto';
import type { ApprovalRule } from '@canopy/desktop-shared/types';
import { runOpenCodePipelinePrompt } from '@canopy/desktop-shared/node/pipelines/opencode-prompt-runner';
import type {
  OpenCodePromptRunnerRequest,
  OpenCodePromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { assertOpenCodeConnectionGeneration } from '../opencode/connection';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import { authorizeOpenCodeNativeTool } from '../opencode/tool-approval';

export async function runDesktopOpenCodePipelinePrompt(
  request: OpenCodePromptRunnerRequest,
): Promise<OpenCodePromptRunnerResult> {
  let active:
    | {
        generation: number;
        approval: ApprovalSessionHandle;
        signal: AbortSignal;
      }
    | undefined;
  const attributionOptions = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
    executionContext: request.executionContext,
    environmentRuntime: 'pipeline' as const,
  };
  return runOpenCodePipelinePrompt(request, {
    open: async (signal) => {
      const sessionKey = `opencode-pipeline:${request.executionId}:${randomUUID()}`;
      const runtime = await openOpenCodeExecutionRuntime({
        model: request.model,
        sessionId: sessionKey,
        cwd: request.cwd,
        scopedModelDiscovery: true,
        attribution: () =>
          resolveRoutingOverrideAttribution(attributionOptions),
        signal,
        workspaceId: request.projectId,
        executionKind: 'pipeline',
        environment: request.environment,
      });
      try {
        const runtimeSignal = AbortSignal.any([signal, runtime.signal]);
        runtimeSignal.throwIfAborted();
        assertOpenCodeConnectionGeneration(runtime.generation);
        const approval = createApprovalSession({
          sessionKey,
          projectId: request.projectId ?? 'pipeline',
          worktreeId: request.executionId,
          chatId: sessionKey,
          provider: 'opencode',
          workspaceRoot: request.cwd,
          // The declared preset is a ceiling; Full Access still honors denies.
          mode:
            request.permissionPreset === 'dangerous_all'
              ? 'full-access'
              : 'ask',
          // The selected unattended preset grants local reads. These rules
          // still pass through shared policy, where every saved deny wins.
          sessionRules:
            request.permissionPreset === 'read_only' ||
            request.permissionPreset === 'plan'
              ? ['Read', 'Grep', 'Glob'].map<ApprovalRule>((toolName) => ({
                  id: `opencode-pipeline-read:${toolName}`,
                  behavior: 'allow',
                  target: { kind: 'tool', toolName },
                  origin: 'settings',
                  createdAt: new Date().toISOString(),
                }))
              : [],
          getWindow: () => null,
          trackChatTurn: false,
        });
        const context = {
          generation: runtime.generation,
          approval,
          signal: runtimeSignal,
        };
        active = context;
        const withdraw = (): void => {
          approval.invalidatePending?.();
        };
        runtimeSignal.addEventListener('abort', withdraw, { once: true });
        if (runtimeSignal.aborted) withdraw();
        let closing: Promise<void> | undefined;
        return {
          ...runtime,
          close: (): Promise<void> =>
            (closing ??= (async (): Promise<void> => {
              if (active === context) active = undefined;
              runtimeSignal.removeEventListener('abort', withdraw);
              try {
                approval.dispose();
              } finally {
                await runtime.close();
              }
            })()),
        };
      } catch (error) {
        await runtime.close();
        throw error;
      }
    },
    prepareCapabilities: async (profile, signal) => {
      const context = active;
      if (!context) throw new Error('OpenCode connection changed.');
      const generation = context.generation;
      const capabilitySignal = AbortSignal.any([signal, context.signal]);
      const currentApproval = (): ApprovalSessionHandle => {
        capabilitySignal.throwIfAborted();
        if (!active || active.generation !== generation)
          throw new Error('OpenCode connection changed.');
        active.signal.throwIfAborted();
        assertOpenCodeConnectionGeneration(generation);
        return active.approval;
      };
      currentApproval();
      const { prepareOpenCodePipelineCapabilities } =
        await import('./opencode-pipeline-capabilities');
      return prepareOpenCodePipelineCapabilities(
        request,
        profile,
        capabilitySignal,
        currentApproval,
      );
    },
    authorize: async (input, signal) => {
      const context = active;
      if (!context || signal.aborted || context.signal.aborted)
        return { decision: 'deny' };
      assertOpenCodeConnectionGeneration(context.generation);
      const outcome = await authorizeOpenCodeNativeTool(input, {
        cwd: request.cwd,
        approval: context.approval,
        planMode: request.permissionPreset === 'plan',
        signal: context.signal,
        toolUseId: input.toolCallId,
      });
      if (active !== context || signal.aborted || context.signal.aborted)
        return { decision: 'deny' };
      assertOpenCodeConnectionGeneration(context.generation);
      return outcome;
    },
  });
}
