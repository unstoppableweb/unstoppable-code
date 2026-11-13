import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import type {
  CanopyJsonValue,
  WorkerPipelineHostRequest,
  WorkerPipelineOwnerRequest,
  WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import {
  canopyJsonValueSchemaWithin,
  WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES,
} from '@canopy/protocol/canopy-core';
import { getExecutionHarnessForModel } from '@canopy/execution-engine/model-catalog';
import {
  isModelHarness,
  isModelHarnessSource,
} from '@canopy/execution-engine/model-harnesses';
import { isClaudeModAdmission } from '@canopy/execution-engine/types/claude-mod-admission';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { pipelinePluginSelectionsAddPlugins } from '../executor/step-runner';
import type { DynamicToolCallParams } from '../../codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../../codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '../../codex-runtime/generated/v2/DynamicToolSpec';
import type {
  CodexPipelineEnvironmentProfile,
  CodexPipelineLedgerTools,
  CodexPipelinePromptPorts,
} from '../codex-pipeline-prompt';
import type {
  ExecutionRunPlanPersistence,
  ExecutionRuntime,
  PipelineLedgerAttempt,
  PipelineLedgerPort,
} from '../executor/types';
import {
  PIPELINE_OWNER_DEADLINE_MS,
  type PipelineOwnerClient,
  type PipelineOwnerStep,
} from './owner-client';

/*
 * The pipeline host's model ports (CAN-5095 D1, D10 to D12): each call a
 * model step makes into an owner-held service becomes one owner request to
 * the core that owns the run, which answers with its own functions and the
 * run's own scope. Capabilities return host-locally in the settlement's
 * values and are handed straight to the step.
 */

export interface DaemonPipelineOwnerPorts extends Pick<
  ExecutionRuntime,
  | 'resolveModelHarnessInvocation'
  | 'resolveAiCreditsRouting'
  | 'releaseAiCreditsRouting'
  | 'isModelBlockedByOrgPolicy'
  | 'isOrgModelPolicyActive'
  | 'recordModelPolicyRefusal'
  | 'pipelineLedger'
  | 'resolveClaudeModAdmissionContext'
  | 'resolvePipelineAgentModelAlias'
> {
  /** The Codex runner's ports, apart from the runtime itself. */
  readonly codex: Omit<CodexPipelinePromptPorts, 'runtime'>;
}

const UNANSWERED = 'The app could not answer this workflow step.';
const toolCallJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES,
);

/** A tool call as JSON, or a refusal the policy reports as a failed call. */
function toolCall(call: DynamicToolCallParams): CanopyJsonValue {
  const json = toolCallJson.safeParse(call).data;
  if (json === undefined) throw new Error(UNANSWERED);
  return json;
}
const NEVER = new AbortController().signal;

type Kind = WorkerPipelineOwnerResult['kind'];
type ResultOf<K extends Kind> = Extract<WorkerPipelineOwnerResult, { kind: K }>;

/** The owner value of kind `kind`, or the failure's message as a throw. */
function expectKind<K extends Kind>(
  settlement: PipelineOwnerSettlement,
  kind: K,
): ResultOf<K> {
  const { result } = settlement;
  if (result.status === 'failure') throw new Error(result.message);
  if (result.status !== 'owner' || result.value.kind !== kind)
    throw new Error(UNANSWERED);
  const value: WorkerPipelineOwnerResult = result.value;
  if (!isKind(value, kind)) throw new Error(UNANSWERED);
  return value;
}

function isKind<K extends Kind>(
  value: WorkerPipelineOwnerResult,
  kind: K,
): value is ResultOf<K> {
  return value.kind === kind;
}

export function createDaemonPipelineOwnerPorts(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
    readonly codexEnvironment?: CodexPipelineEnvironmentProfile;
    /** Aborts when the run is paused or cancelled: its pending requests are withdrawn. */
    readonly signal?: AbortSignal;
  },
): DaemonPipelineOwnerPorts {
  const step = (
    deadlineMs: number,
    at?: Partial<
      Pick<PipelineOwnerStep, 'jobId' | 'stepId' | 'attempt' | 'iteration'>
    >,
  ): PipelineOwnerStep => ({
    executionId: run.executionId,
    childExecutionId: null,
    jobId: at?.jobId ?? '_run',
    stepId: at?.stepId ?? '_run',
    attempt: at?.attempt ?? 0,
    iteration: at?.iteration ?? 0,
    owner: run.owner,
    deadlineMs,
  });
  const ask = (
    body: WorkerPipelineOwnerRequest,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    at?: Parameters<typeof step>[1],
  ): Promise<PipelineOwnerSettlement> =>
    client.request(
      body,
      step(deadlineMs, at),
      signal && run.signal
        ? AbortSignal.any([signal, run.signal])
        : (signal ?? run.signal ?? NEVER),
    );

  // Cleanup that outlives a cancel or pause of its run, which Electron main
  // also releases at settle (D16), so no step waits for it.
  const release = (routeSessionId: string): Promise<void> => {
    void client
      .request(
        { action: 'owner.model.release', routeSessionId },
        step(PIPELINE_OWNER_DEADLINE_MS.short),
        NEVER,
      )
      .catch(() => undefined);
    return Promise.resolve();
  };

  const resolveAiCreditsRouting: NonNullable<
    ExecutionRuntime['resolveAiCreditsRouting']
  > = async (model, provider, context) => {
    const settlement = await ask(
      {
        action: 'owner.model.routing',
        provider,
        ...(model !== undefined ? { model: model } : {}),
        ...(context?.routeSessionId !== undefined
          ? { routeSessionId: context?.routeSessionId }
          : {}),
        ...(context?.allowNoNativeAuthFallback !== undefined
          ? { allowNoNativeAuthFallback: context?.allowNoNativeAuthFallback }
          : {}),
        ...(context?.checkpointProxyQuota !== undefined
          ? { checkpointProxyQuota: context?.checkpointProxyQuota }
          : {}),
        ...(context?.requiredAccountProxyConnectionId !== undefined
          ? {
              requiredAccountProxyConnectionId:
                context?.requiredAccountProxyConnectionId,
            }
          : {}),
      },
      PIPELINE_OWNER_DEADLINE_MS.long,
      context?.signal,
    );
    const { override } = expectKind(settlement, 'model.routing');
    if (override === null) return null;
    return {
      provider,
      model: override.model,
      env: settlement.values?.env ?? {},
      modelGatewayRouted: override.modelGatewayRouted,
      accountProxyRouted: override.accountProxyRouted,
      ...(override.accountProxyConnectionId !== undefined
        ? { accountProxyConnectionId: override.accountProxyConnectionId }
        : {}),
      ...(settlement.values?.codexConfig
        ? { codexConfig: settlement.values.codexConfig }
        : {}),
    };
  };

  const policy = async (body: WorkerPipelineOwnerRequest): Promise<boolean> =>
    expectKind(
      await ask(body, PIPELINE_OWNER_DEADLINE_MS.short, undefined),
      'model.policy',
    ).answer;

  const pipelineLedger: PipelineLedgerPort = {
    openAttempt: async (request) => {
      const at = {
        jobId: request.physicalJobId,
        stepId: request.stepId,
        attempt: request.attempt,
        iteration: request.iteration,
      };
      const opened = expectKind(
        await ask(
          {
            action: 'owner.ledger.open',
            physicalJobId: request.physicalJobId,
            logicalJobId: request.logicalJobId,
            jobName: request.jobName,
            stepId: request.stepId,
            stepName: request.stepName,
            attempt: request.attempt,
            iteration: request.iteration,
            harness: request.harness,
            permissionPreset: request.permissionPreset,
            ...(request.pipelineId !== undefined
              ? { pipelineId: request.pipelineId }
              : {}),
            ...(request.pipelineName !== undefined
              ? { pipelineName: request.pipelineName }
              : {}),
            ...(request.resumedAgentSessionId !== undefined
              ? { resumedAgentSessionId: request.resumedAgentSessionId }
              : {}),
            ...(request.predecessorAgentSessionId !== undefined
              ? { predecessorAgentSessionId: request.predecessorAgentSessionId }
              : {}),
            ...(request.checkpointId !== undefined
              ? { checkpointId: request.checkpointId }
              : {}),
            ...(request.model !== undefined ? { model: request.model } : {}),
            ...(request.thinkingEffort !== undefined
              ? { thinkingEffort: request.thinkingEffort }
              : {}),
          },
          PIPELINE_OWNER_DEADLINE_MS.short,
          undefined,
          at,
        ),
        'ledger.open',
      ).attempt;
      if (opened === null) return null;
      const attempt: PipelineLedgerAttempt = {
        attemptKey: opened.attemptKey,
        agentSessionId: opened.agentSessionId,
        instructions: opened.instructions,
        openSubprocessTools: async (cwd) => {
          const settlement = await ask(
            {
              action: 'owner.ledger.subprocessTools',
              attemptKey: opened.attemptKey,
              cwd,
            },
            PIPELINE_OWNER_DEADLINE_MS.short,
            undefined,
            at,
          );
          expectKind(settlement, 'ledger.subprocessTools');
          const tools = settlement.values?.ledgerSubprocessTools;
          if (!tools) throw new Error(UNANSWERED);
          return tools;
        },
        close: (outcome) => {
          void ask(
            {
              action: 'owner.ledger.close',
              attemptKey: opened.attemptKey,
              outcome,
            },
            PIPELINE_OWNER_DEADLINE_MS.short,
            undefined,
            at,
          ).catch(() => undefined);
        },
      };
      return attempt;
    },
    // Resume runs in process (CAN-5095 D11).
    noteResuming: () => Promise.resolve(),
  };

  const openLedgerTools: CodexPipelinePromptPorts['openLedgerTools'] = async (
    attemptKey,
    cwd,
  ) => {
    if (attemptKey === undefined) return undefined;
    const { tools } = expectKind(
      await ask(
        { action: 'owner.ledger.codexTools', attemptKey, cwd },
        PIPELINE_OWNER_DEADLINE_MS.short,
        undefined,
      ),
      'ledger.codexTools',
    );
    if (tools === null) return undefined;
    const ledgerTools: CodexPipelineLedgerTools = {
      instructions: tools.instructions,
      specs: tools.specs.flatMap((spec) =>
        isDynamicToolSpec(spec) ? [spec] : [],
      ),
      policy: (threadId) => ({
        allowedTools: tools.allowedTools,
        ...(tools.timeoutMs !== undefined
          ? { timeoutMs: tools.timeoutMs }
          : {}),
        authorize: async (call: DynamicToolCallParams, signal: AbortSignal) =>
          expectKind(
            await ask(
              {
                action: 'owner.ledger.codexToolAuthorize',
                toolsKey: tools.toolsKey,
                threadId,
                call: toolCall(call),
              },
              PIPELINE_OWNER_DEADLINE_MS.long,
              signal,
            ),
            'ledger.codexToolAuthorize',
          ).authorized,
        execute: async (
          call: DynamicToolCallParams,
          signal: AbortSignal,
        ): Promise<DynamicToolCallResponse> => {
          const { response } = expectKind(
            await ask(
              {
                action: 'owner.ledger.codexToolExecute',
                toolsKey: tools.toolsKey,
                threadId,
                call: toolCall(call),
              },
              PIPELINE_OWNER_DEADLINE_MS.long,
              signal,
            ),
            'ledger.codexToolExecute',
          );
          if (!isDynamicToolCallResponse(response)) throw new Error(UNANSWERED);
          return response;
        },
      }),
      dispose: () => {
        void ask(
          {
            action: 'owner.ledger.codexToolsDispose',
            toolsKey: tools.toolsKey,
          },
          PIPELINE_OWNER_DEADLINE_MS.short,
          undefined,
        ).catch(() => undefined);
      },
    };
    return ledgerTools;
  };

  return {
    resolveModelHarnessInvocation: async (model, options) => {
      const harness =
        options?.harness ??
        (model ? getExecutionHarnessForModel(model) : 'claude');
      if (harness !== 'claude' && harness !== 'codex')
        throw new Error('This model does not run in the background service.');
      const settlement = await ask(
        {
          action: 'owner.model.invocation',
          harness,
          ...(model !== undefined ? { model: model } : {}),
          ...(options?.routeSessionId !== undefined
            ? { routeSessionId: options?.routeSessionId }
            : {}),
          ...(options?.allowNoNativeAuthFallback !== undefined
            ? { allowNoNativeAuthFallback: options?.allowNoNativeAuthFallback }
            : {}),
          ...(options?.checkpointProxyQuota !== undefined
            ? { checkpointProxyQuota: options?.checkpointProxyQuota }
            : {}),
          ...(options?.requiredAccountProxyConnectionId !== undefined
            ? {
                requiredAccountProxyConnectionId:
                  options?.requiredAccountProxyConnectionId,
              }
            : {}),
        },
        PIPELINE_OWNER_DEADLINE_MS.long,
        options?.signal,
      );
      const value = expectKind(settlement, 'model.invocation');
      if (!isModelHarnessSource(value.source) || !isModelHarness(value.harness))
        throw new Error(UNANSWERED);
      return {
        source: value.source,
        harness: value.harness,
        runtimeModel: value.runtimeModel,
        aiCreditsRouted: value.aiCreditsRouted,
        modelGatewayRouted: value.modelGatewayRouted,
        ...(value.accountProxyRouted
          ? {
              accountProxyRouted: true,
              accountProxyConnectionId: value.accountProxyConnectionId,
            }
          : {}),
        ...(settlement.values?.env
          ? { envOverride: settlement.values.env }
          : {}),
        ...(settlement.values?.codexConfig
          ? { codexConfig: settlement.values.codexConfig }
          : {}),
      };
    },
    resolveAiCreditsRouting,
    releaseAiCreditsRouting: release,
    isModelBlockedByOrgPolicy: (modelId) =>
      policy({ action: 'owner.model.policy', check: 'blocked', modelId }),
    isOrgModelPolicyActive: () =>
      policy({ action: 'owner.model.policy', check: 'active' }),
    recordModelPolicyRefusal: (context) => {
      void ask(
        { action: 'owner.model.policyRefusal', modelId: context.modelId },
        PIPELINE_OWNER_DEADLINE_MS.short,
        undefined,
        { jobId: context.jobId, stepId: context.stepId },
      ).catch(() => undefined);
    },
    pipelineLedger,
    // Fails closed (CAN-5095): any refusal, absence, deadline or invalid
    // answer fails the step before its CLI starts, never with ambient Mods.
    resolveClaudeModAdmissionContext: async (request) => {
      const { context } = expectKind(
        await ask(
          {
            action: 'owner.claude.modAdmission',
            cwd: request.cwd,
            settingSources: [...request.settingSources],
            ...(request.claudeConfigDir !== undefined && {
              claudeConfigDir: request.claudeConfigDir,
            }),
          },
          PIPELINE_OWNER_DEADLINE_MS.short,
          undefined,
        ),
        'claude.modAdmission',
      );
      if (context === null) return undefined;
      if (!context.admissions.every(isClaudeModAdmission))
        throw new Error(UNANSWERED);
      return {
        enabled: context.enabled,
        ...(context.claudeConfigDir !== undefined && {
          claudeConfigDir: context.claudeConfigDir,
        }),
        authority: context.authority,
        admissions: context.admissions,
        modsDisabled: context.modsDisabled,
        ambientPlugins: context.ambientPlugins.map((plugin) => ({
          pluginId: plugin.pluginId,
          installPath: plugin.installPath,
          ...(plugin.notLoaded && { notLoaded: true as const }),
        })),
        ...(context.sessionModIds !== undefined && {
          sessionModIds: context.sessionModIds,
        }),
      };
    },
    // An Agent model alias (CAN-5832), resolved by the run's core with the
    // run's own scope. An Agent's standalone MCP servers are dropped, as an
    // SDK step drops them in process (CAN-6011, CAN-6277). Codex steps refuse
    // any other plugins in their runner.
    resolvePipelineAgentModelAlias: async (agentId) => {
      const { alias } = expectKind(
        await ask(
          { action: 'owner.model.agentAlias', agentId },
          PIPELINE_OWNER_DEADLINE_MS.short,
          undefined,
        ),
        'model.agentAlias',
      );
      if (alias === null) return null;
      const pluginSelections =
        alias.pluginSelections === undefined
          ? undefined
          : normalizePluginSelections(alias.pluginSelections);
      return {
        agentId: alias.agentId,
        name: alias.name,
        base: alias.base,
        ...(alias.instructions !== undefined && {
          instructions: alias.instructions,
        }),
        // Kept, though empty, so the step records what it does in process.
        ...(pluginSelections && { pluginSelections }),
      };
    },
    codex: {
      // Selections that add nothing (an Agent's empty ones) resolve to no
      // plugins; any other selection or package overlay stays in process.
      resolvePlugins: (request) =>
        request.packageOverlay === undefined &&
        !pipelinePluginSelectionsAddPlugins(request.pluginSelections)
          ? Promise.resolve({
              warnings: [],
              selectedCapabilityRoots: [],
              codexMcpServers: {},
            })
          : Promise.reject(
              new Error('Workflow plugins are not available here.'),
            ),
      mcpCapabilityAuthorityIds: () => [],
      resolveRouting: (model, routeSessionId, request) =>
        resolveAiCreditsRouting(model, 'codex', {
          routeSessionId,
          ...(request.allowNoNativeAuthFallback !== undefined
            ? { allowNoNativeAuthFallback: request.allowNoNativeAuthFallback }
            : {}),
        }),
      environmentProfile: () =>
        run.codexEnvironment
          ? Promise.resolve(run.codexEnvironment)
          : Promise.reject(
              new Error('This workflow run has no Codex environment.'),
            ),
      openLedgerTools,
      releaseSession: release,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDynamicToolSpec(value: unknown): value is DynamicToolSpec {
  return (
    isRecord(value) &&
    (value.type === 'function' || value.type === 'namespace') &&
    typeof value.name === 'string'
  );
}

function isDynamicToolCallResponse(
  value: unknown,
): value is DynamicToolCallResponse {
  return (
    isRecord(value) &&
    typeof value.success === 'boolean' &&
    Array.isArray(value.contentItems)
  );
}

/**
 * The pipeline host's plan port (CAN-6327): each plan write a run makes
 * becomes an `owner.plan.*` request to the core that owns the run, which
 * keeps the plan in its own plans. Raised at the run's start, within the
 * start's bound, and at its end, including after a cancel, so it never takes
 * the run's signal: a missing owner settles it as the owner timers decide.
 */
export function createDaemonPipelinePlanPorts(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
  },
): ExecutionRunPlanPersistence {
  const ask = (
    body: WorkerPipelineOwnerRequest,
    starting: boolean,
  ): Promise<PipelineOwnerSettlement> =>
    client.request(
      body,
      {
        executionId: run.executionId,
        childExecutionId: null,
        jobId: '_run',
        stepId: '_run',
        attempt: 0,
        iteration: 0,
        owner: run.owner,
        deadlineMs: starting
          ? PIPELINE_OWNER_DEADLINE_MS.start
          : PIPELINE_OWNER_DEADLINE_MS.short,
      },
      NEVER,
    );
  return {
    createPlan: async ({ content, starting }) => {
      const { planId } = expectKind(
        await ask(
          {
            action: 'owner.plan.create',
            content,
            ...(starting === true && { initial: true as const }),
          },
          starting === true,
        ),
        'plan.create',
      );
      return planId === null ? null : { id: planId };
    },
    updatePlan: async ({ planId, content, approve, starting }) => {
      expectKind(
        await ask(
          {
            action: 'owner.plan.update',
            planId,
            ...(content !== undefined ? { content } : {}),
            approve,
          },
          starting === true,
        ),
        'plan.update',
      );
    },
  };
}
