import { AgentModelSelectionError } from '@canopy/execution-engine/lib/agent-model-selection';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import {
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  type ChatModel,
  type ModelHarnessInvocation,
} from '@canopy/desktop-shared/types';
import type {
  ModelHarnessInvocationOptions,
  PipelineAgentModelAliasResolution,
  PipelineAiCreditsRoutingContext,
  PipelineAiCreditsRoutingOverride,
  PipelineModelPolicyScope,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import { resolveAiCreditsRoutingOverride } from '../agents/ai-credits-routing';
import { resolveBackgroundWorkOwner } from '../agents/work-owner';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../lib/model-policy-state';
import { getObservabilityService } from '../observability';
import { resolveCodexCompatibleOllamaInvocation } from '../ollama/codex-compatible';

/** The pipeline model invocation both compositions use (CAN-5095 D23). */
export async function resolveDesktopPipelineHarnessInvocation(
  model: ChatModel | undefined,
  options?: ModelHarnessInvocationOptions,
): Promise<ModelHarnessInvocation> {
  const source = model ? getModelSource(model) : 'claude-managed';
  const harness =
    options?.harness ?? (model ? getExecutionHarnessForModel(model) : 'claude');
  if (source === 'antigravity-managed' || harness === 'antigravity') {
    return {
      source: 'antigravity-managed',
      harness: 'antigravity',
      runtimeModel: model ?? '',
      aiCreditsRouted: false,
    };
  }
  if (source === 'copilot-managed' || harness === 'copilot') {
    return {
      source: 'copilot-managed',
      harness: 'copilot',
      runtimeModel: model ?? '',
      aiCreditsRouted: false,
    };
  }
  if (source === 'opencode-managed' || harness === 'opencode') {
    return {
      source: 'opencode-managed',
      harness: 'opencode',
      runtimeModel: model ?? '',
      aiCreditsRouted: false,
    };
  }
  if (source === 'cursor-managed' || harness === 'cursor') {
    return {
      source: 'cursor-managed',
      harness: 'cursor',
      runtimeModel: model ?? '',
      aiCreditsRouted: false,
    };
  }
  if (!source || !harness) {
    throw new Error(`Unknown model "${model ?? ''}"`);
  }
  const { getClaudeWorkerRuntime } =
    await import('../agent-runs/claude-worker-runtime');
  const { envOverride: mockEnv } =
    await getClaudeWorkerRuntime().prepareInvocation({
      providerType: 'claude',
      model,
      reason: 'pipeline',
    });
  if (harness === 'claude' && mockEnv) {
    return {
      source,
      harness,
      runtimeModel: model ?? '',
      aiCreditsRouted: false,
      envOverride: mockEnv,
    };
  }
  if (model && source === 'ollama') {
    if (harness === 'codex') {
      return resolveCodexCompatibleOllamaInvocation(model, {
        ensureRunningReason: 'pipeline',
        assertInstalled: true,
      });
    }
    const invocation = await getClaudeWorkerRuntime().prepareInvocation({
      providerType: 'ollama',
      model,
      reason: 'pipeline',
    });
    return {
      source: 'ollama',
      harness,
      runtimeModel: invocation.sdkModel ?? model,
      aiCreditsRouted: false,
      ...(invocation.envOverride
        ? { envOverride: invocation.envOverride }
        : {}),
    };
  }
  const routed =
    model && (harness === 'claude' || harness === 'codex')
      ? await resolveAiCreditsRoutingOverride(
          model,
          harness,
          undefined,
          options?.routeSessionId,
          {
            environmentRuntime: 'pipeline',
            signal: options?.signal,
            checkpointProxyQuota: options?.checkpointProxyQuota,
            requiredAccountProxyConnectionId:
              options?.requiredAccountProxyConnectionId,
            ...(options?.workspaceId !== undefined
              ? { workspaceId: options.workspaceId }
              : {}),
            ...(options?.worktreeId !== undefined
              ? { worktreeId: options.worktreeId }
              : {}),
            ...(options?.allowNoNativeAuthFallback !== undefined
              ? {
                  allowNoNativeAuthFallback: options.allowNoNativeAuthFallback,
                }
              : {}),
            ...(options?.executionContext !== undefined
              ? { executionContext: options.executionContext }
              : {}),
          },
        )
      : null;
  return {
    source,
    harness,
    runtimeModel: routed?.model ?? model ?? '',
    aiCreditsRouted: routed !== null && !routed.accountProxyRouted,
    modelGatewayRouted: routed?.modelGatewayRouted === true,
    ...(routed?.accountProxyRouted
      ? {
          accountProxyRouted: true,
          accountProxyConnectionId: routed.accountProxyConnectionId,
        }
      : {}),
    ...(routed?.env ? { envOverride: routed.env } : {}),
    ...(routed?.codexConfig ? { codexConfig: routed.codexConfig } : {}),
  };
}

/** AI Credits, gateway and account-proxy routing for a direct-Claude action or Codex step. */
export function resolveDesktopPipelineAiCreditsRouting(
  model: string | undefined,
  provider: 'claude' | 'codex',
  context?: PipelineAiCreditsRoutingContext,
): Promise<PipelineAiCreditsRoutingOverride | null> {
  // The step supplies both halves of its own routing context (ECW-9091
  // review round 7):
  // - `workspaceId` + `environmentRuntime: 'pipeline'` so the
  //   user-supplied-credential guard resolves the SAME environment the step
  //   spawns with (`resolvePipelineRuntimeEnv(state.project_id)`). A
  //   workspace assignment replaces the global one, so the runtime slot
  //   alone is not enough.
  // - `allowNoNativeAuthFallback` false for automation/hook triggers, so a
  //   pipeline running with no user present cannot silently spend credits.
  return resolveAiCreditsRoutingOverride(
    model,
    provider,
    undefined,
    context?.routeSessionId,
    {
      environmentRuntime: 'pipeline',
      signal: context?.signal,
      checkpointProxyQuota: context?.checkpointProxyQuota,
      requiredAccountProxyConnectionId:
        context?.requiredAccountProxyConnectionId,
      ...(context?.workspaceId !== undefined
        ? { workspaceId: context.workspaceId }
        : {}),
      ...(context?.worktreeId !== undefined
        ? { worktreeId: context.worktreeId }
        : {}),
      ...(context?.allowNoNativeAuthFallback !== undefined
        ? { allowNoNativeAuthFallback: context.allowNoNativeAuthFallback }
        : {}),
      ...(context?.executionContext !== undefined
        ? { executionContext: context.executionContext }
        : {}),
    },
  );
}

/** A workflow model alias's Agent, for both compositions (CAN-5832). */
export async function resolveDesktopPipelineAgentModelAlias(
  agentId: string,
  scope?: PipelineModelPolicyScope,
): Promise<PipelineAgentModelAliasResolution | null> {
  const resolved = await resolveAgentModelRuntime({
    model: agentId,
    projectId: scope?.projectId,
    inheritDefaultFrom: { projectId: scope?.projectId },
  }).catch((error: unknown) => {
    if (
      error instanceof AgentModelSelectionError &&
      error.code === 'agent_unavailable'
    ) {
      return null;
    }
    throw error;
  });
  if (!resolved) return null;
  const agent = resolved.agent;
  if (!agent) return null;
  if (
    scope &&
    (await isDesktopPipelineModelBlocked(resolved.runtimeModel, scope))
  ) {
    throw new AgentModelSelectionError(
      'policy_blocked',
      `Model "${resolved.runtimeModel}" is blocked by your organization policy. Choose another model.`,
    );
  }
  let pluginSelections = agent.pluginSelections;
  if (parseAgentRouteModelId(agentId)) {
    const { resolveEffectivePluginSelectionRefs } =
      await import('../plugins/plugin-resolver');
    const refs = await resolveEffectivePluginSelectionRefs(
      pluginSelections,
      [],
      scope?.projectId,
    );
    if (refs.warnings.length)
      throw new AgentModelSelectionError(
        'plugins_incompatible',
        'Some Agent resources could not be checked. Choose another model or edit the Agent.',
      );
    pluginSelections = {
      collectionIds: [],
      skillRefs: refs.skillRefs,
      pluginRefs: refs.pluginRefs,
      mcpServerRefs: refs.mcpServerRefs,
      ...(pluginSelections?.mcpHttpAuthPreferences !== undefined
        ? { mcpHttpAuthPreferences: pluginSelections.mcpHttpAuthPreferences }
        : {}),
    };
  }
  return {
    agentId: agent.id,
    name: agent.name,
    base: resolved.runtimeModel,
    instructions: agent.instructions,
    pluginSelections,
  };
}

export async function isDesktopPipelineModelBlocked(
  modelId: string,
  scope: PipelineModelPolicyScope,
): Promise<boolean> {
  const owner = await resolveBackgroundWorkOwner(
    {
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
    },
    scope.executionContext,
  );
  return isModelBlockedByStoredPolicy(modelId, owner);
}

export async function isDesktopPipelineOrgPolicyActive(
  scope: PipelineModelPolicyScope,
): Promise<boolean> {
  const owner = await resolveBackgroundWorkOwner(
    {
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
    },
    scope.executionContext,
  );
  return isOrgModelPolicyActiveForStoredAccount(owner);
}

export function recordDesktopPipelineModelPolicyRefusal(context: {
  executionId: string;
  jobId: string;
  stepId: string;
  projectId?: string;
  worktreeId?: string;
  modelId: string;
}): void {
  const projectId = context.projectId ?? 'pipeline';
  const worktreeId = context.worktreeId ?? context.executionId;
  getObservabilityService().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'model_policy_refused',
    sessionKey: `pipeline:${context.executionId}:${context.jobId}:${context.stepId}`,
    projectId,
    worktreeId,
    chatId: `pipeline:${context.executionId}`,
    providerType: getProviderForModel(context.modelId) ?? 'unknown',
    model: context.modelId,
  });
}
