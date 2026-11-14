import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import type {
  CanopyJsonValue,
  LedgerGlobalOwner,
  WorkerPipelineHostRequest,
  WorkerPipelineOwnerRequest,
  WorkerPipelineOwnerResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyJsonValueSchema,
  canopyJsonValueSchemaWithin,
  WORKER_PIPELINE_OWNER_LEDGER_JSON_MAX_BYTES,
  WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX,
  WORKER_PIPELINE_OWNER_PRECOMMIT_REPOS_MAX,
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
import { CodexHttpMcpProxyService } from '../../codex-runtime/http-mcp-proxy';
import {
  resolveCodexPluginMcpServers,
  resolvePlugins,
} from '../../plugins/plugin-resolver';
import {
  DAEMON_CODEX_PLUGINS_UNAVAILABLE,
  daemonCodexMcpAuthorityIds,
  daemonCodexPluginResolution,
} from './codex-plugin-mcp';
import { CodexCapabilityStore } from '../../codex-runtime/capability-store';
import { createOwnerMcpCredentials } from './owner-mcp-credentials';
import type { McpCredentialRef } from '@canopy/core-runtime/node/mcp-auth';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type { DynamicToolCallParams } from '../../codex-runtime/generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from '../../codex-runtime/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from '../../codex-runtime/generated/v2/DynamicToolSpec';
import { ledgerCodexToolPolicy } from '../../ledger-tools/codex';
import { headlessLedgerToolAllowed } from '../../ledger-tools/headless-approval';
import {
  startLedgerToolsMcpRoute,
  type LedgerToolsMcpRoute,
} from '../../ledger-tools/mcp-route';
import {
  openRemoteLedgerTools,
  type RemoteLedgerOperate,
} from '../../ledger-tools/remote-session';
import type { LedgerChatToolsSession } from '../../ledger-tools/runtime';
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
const ledgerOperationJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_LEDGER_JSON_MAX_BYTES,
);

/** A tool call as JSON, or a refusal the policy reports as a failed call. */
function toolCall(call: DynamicToolCallParams): CanopyJsonValue {
  const json = toolCallJson.safeParse(call).data;
  if (json === undefined) throw new Error(UNANSWERED);
  return json;
}
/** A step's plugin selections as JSON for the owner (CAN-6168). */
function selectionsJson(selections: unknown): CanopyJsonValue {
  const json = CanopyJsonValueSchema.safeParse(
    JSON.parse(JSON.stringify(selections)),
  ).data;
  if (json === undefined) throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
  return json;
}
const NEVER = new AbortController().signal;

/** The run owner as a global Ledger's owner, or null for one that can't be parsed. */
function ledgerGlobalOwnerOf(
  owner: WorkerPipelineHostRequest['owner'],
): LedgerGlobalOwner | null {
  if (owner === 'personal') return { kind: 'personal' };
  if (owner?.startsWith('org:') === true)
    return { kind: 'organization', organizationId: owner.slice('org:'.length) };
  return null;
}

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

/**
 * The daemon's one loopback proxy for its Codex steps' plugin HTTP MCP
 * servers (CAN-6168). Each step's routes go when the step releases its
 * route session.
 */
let codexMcpProxy: CodexHttpMcpProxyService | undefined;

/** Where daemon Codex steps build their capability folders, each its own. */
function codexCapabilityRoot(): string {
  return path.join(getCanopyDataDir(), 'pipeline-plugins', 'codex-daemon');
}

/** The content-addressed store every host publishes Codex capability roots to. */
let codexCapabilityStore: CodexCapabilityStore | undefined;
function daemonCodexCapabilityStore(): CodexCapabilityStore {
  codexCapabilityStore ??= new CodexCapabilityStore(getCanopyDataDir());
  return codexCapabilityStore;
}
function daemonCodexMcpProxy(): CodexHttpMcpProxyService {
  codexMcpProxy ??= new CodexHttpMcpProxyService();
  return codexMcpProxy;
}

export function createDaemonPipelineOwnerPorts(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
    readonly codexEnvironment?: CodexPipelineEnvironmentProfile;
    /** Aborts when the run is paused or cancelled: its pending requests are withdrawn. */
    readonly signal?: AbortSignal;
    /**
     * The owner is remote (a cloud run's web core, CAN-6422): the Feed tools
     * run here, over `owner.ledger.operation`, instead of in the owner.
     */
    readonly remoteLedgerTools?: boolean;
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

  // A plugin MCP server's OAuth credential stays with Electron main (CAN-6168,
  // X1 (a)): the daemon binds a route by the declaration's hash and asks for
  // one authorization per upstream request.
  // The owner's bindings last for the run (part 2), so the same declaration
  // binds once per run, however many steps reach it. A route the owner calls
  // stale (bound under an earlier owner subscription) binds once more, and
  // every step that found that same route stale shares the replacement.
  const mcpBinds = new Map<string, Promise<string | null>>();
  const mcpBind = async (
    source: {
      readonly marketplaceId: string;
      readonly pluginName: string;
      readonly serverName: string;
      readonly contentHash: string;
    },
    options?: { readonly staleRef?: string },
  ): Promise<string | null> => {
    const key = JSON.stringify([
      source.marketplaceId,
      source.pluginName,
      source.serverName,
      source.contentHash,
    ]);
    const known = mcpBinds.get(key);
    if (known && options?.staleRef === undefined) return known;
    if (known && options?.staleRef !== undefined) {
      const current = await known.catch(() => null);
      // Another step already replaced the stale route, or is replacing it.
      const latest = mcpBinds.get(key);
      if (latest !== known && latest !== undefined) return latest;
      if (current !== null && current !== options.staleRef) return current;
    }
    const bound = ask(
      { action: 'owner.mcp.bind', ...source },
      PIPELINE_OWNER_DEADLINE_MS.short,
      undefined,
    ).then((settlement) => expectKind(settlement, 'mcp.bind').routeRef);
    mcpBinds.set(key, bound);
    // A failed bind is asked again by the next step.
    bound.catch(() => {
      if (mcpBinds.get(key) === bound) mcpBinds.delete(key);
    });
    return bound;
  };
  const sessionCredentials = new Map<string, McpCredentialRef[]>();
  const mcpCredentials = createOwnerMcpCredentials({
    authorize: async (routeRef, signal) => {
      const settlement = await ask(
        { action: 'owner.mcp.authorize', routeRef },
        PIPELINE_OWNER_DEADLINE_MS.short,
        signal,
      );
      const { grantId, refused } = expectKind(settlement, 'mcp.authorize');
      const authorization = settlement.values?.mcpAuthorization?.authorization;
      return {
        grantId,
        ...(authorization !== undefined && { authorization }),
        ...(refused !== undefined && { refused }),
      };
    },
    rejected: (grantId) =>
      ask(
        { action: 'owner.mcp.rejected', grantId },
        PIPELINE_OWNER_DEADLINE_MS.short,
        undefined,
      )
        .then(() => undefined)
        .catch(() => undefined),
  });

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

  /** The Feed tools of this run's open attempts, when they run here. */
  const hostedAttempts = new Map<
    string,
    {
      readonly session: LedgerChatToolsSession;
      readonly permissionPreset: string;
    }
  >();
  const hostedOwner = ledgerGlobalOwnerOf(run.owner);

  /** One Ledger operation as the attempt the remote owner opened. */
  const operate =
    (
      attemptKey: string,
      at: Partial<
        Pick<PipelineOwnerStep, 'jobId' | 'stepId' | 'attempt' | 'iteration'>
      >,
    ): RemoteLedgerOperate =>
    async (operation, params, signal) => {
      const json = ledgerOperationJson.safeParse(params).data;
      // Params no request can carry are the agent's to fix.
      if (json === undefined)
        return { kind: 'refused', error: { reason: 'INVALID_INPUT' } };
      return expectKind(
        await ask(
          {
            action: 'owner.ledger.operation',
            attemptKey,
            operation,
            params: json,
          },
          PIPELINE_OWNER_DEADLINE_MS.long,
          signal,
          at,
        ),
        'ledger.operation',
      ).outcome;
    };

  const pipelineLedger: PipelineLedgerPort = {
    openAttempt: async (request) => {
      // The background service hosts no OpenCode step (daemon eligibility
      // keeps them in the app), and the owner request names only the
      // harnesses it hosts; an OpenCode attempt here opens nothing.
      if (request.harness === 'opencode') return null;
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
      if (run.remoteLedgerTools === true)
        return hostedAttempt(request, opened, at);
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

  /**
   * An attempt whose Feed tools run here (CAN-6422): the shared tools runtime,
   * dispatching through `owner.ledger.operation`, served to a Claude
   * subprocess on a loopback MCP route and to Codex as dynamic tools.
   */
  function hostedAttempt(
    request: Parameters<PipelineLedgerPort['openAttempt']>[0],
    opened: { readonly attemptKey: string; readonly agentSessionId: string },
    at: Partial<
      Pick<PipelineOwnerStep, 'jobId' | 'stepId' | 'attempt' | 'iteration'>
    >,
  ): PipelineLedgerAttempt | null {
    if (hostedOwner === null) return null;
    let live = true;
    const name = request.pipelineName?.trim()
      ? `${request.stepName} · ${request.pipelineName.trim()}`
      : request.stepName;
    const session = openRemoteLedgerTools({
      executionId: run.executionId,
      harness: request.harness,
      owner: hostedOwner,
      pipelineAgent: {
        physicalJobId: request.physicalJobId,
        logicalJobId: request.logicalJobId,
        stepId: request.stepId,
        attempt: Math.max(1, request.attempt),
        iteration: request.iteration,
        agentSessionId: opened.agentSessionId,
        ...(request.predecessorAgentSessionId === undefined
          ? {}
          : { predecessorAgentSessionId: request.predecessorAgentSessionId }),
        ...(request.checkpointId === undefined
          ? {}
          : { checkpointId: request.checkpointId }),
        displayName:
          request.attempt > 1
            ? `${name} (attempt ${String(request.attempt)})`
            : name,
        isLive: () => live,
      },
      settings: {
        model: request.model ?? null,
        thinkingEffort: request.thinkingEffort ?? null,
        mode: request.permissionPreset,
      },
      operate: operate(opened.attemptKey, at),
    });
    hostedAttempts.set(opened.attemptKey, {
      session,
      permissionPreset: request.permissionPreset,
    });
    let route: Promise<LedgerToolsMcpRoute> | undefined;
    return {
      attemptKey: opened.attemptKey,
      agentSessionId: opened.agentSessionId,
      instructions: session.systemPrompt(),
      openSubprocessTools: async () => {
        if (!live) throw new Error('The pipeline agent attempt has ended.');
        route ??= startLedgerToolsMcpRoute(session, (tool) =>
          headlessLedgerToolAllowed(request.permissionPreset, tool),
        );
        const open = await route;
        return {
          mcpServers: open.mcpServers,
          allowedTools: [...open.allowedTools],
          secretValues: [open.token],
        };
      },
      close: (outcome) => {
        if (!live) return;
        live = false;
        hostedAttempts.delete(opened.attemptKey);
        session.dispose();
        void route?.then((open) => open.close()).catch(() => undefined);
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
  }

  const openLedgerTools: CodexPipelinePromptPorts['openLedgerTools'] = async (
    attemptKey,
    cwd,
  ) => {
    if (attemptKey === undefined) return undefined;
    const hosted = hostedAttempts.get(attemptKey);
    if (hosted !== undefined) {
      // A remote owner's attempt: the tools run here, and an unattended step
      // may call exactly the three Feed tools.
      const { specs, policy } = ledgerCodexToolPolicy(
        hosted.session,
        (_call, tool) =>
          Promise.resolve(
            headlessLedgerToolAllowed(hosted.permissionPreset, tool),
          ),
      );
      return {
        instructions: hosted.session.systemPrompt(),
        specs,
        policy,
        dispose: () => undefined,
      };
    }
    if (run.remoteLedgerTools === true) return undefined;
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
      // plugins. Plugins resolve here with the shared resolver; their MCP
      // servers are served only as daemonCodexPluginResolution allows
      // (CAN-6168). A package overlay or a standalone MCP server stays in
      // process.
      resolvePlugins: async (request, routeSessionId) => {
        if (
          request.packageOverlay === undefined &&
          !pipelinePluginSelectionsAddPlugins(request.pluginSelections)
        )
          return {
            warnings: [],
            selectedCapabilityRoots: [],
            codexMcpServers: {},
          };
        if (
          request.packageOverlay !== undefined ||
          request.pluginSelections === undefined
        )
          throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
        // The owner's own policy decides what the step may load, as in
        // process: collections expanded, disabled items out, skill
        // contexts checked (CAN-6168).
        const effective = expectKind(
          await ask(
            {
              action: 'owner.codex.pluginRefs',
              selections: selectionsJson(request.pluginSelections),
            },
            PIPELINE_OWNER_DEADLINE_MS.short,
            undefined,
          ),
          'codex.pluginRefs',
        );
        // Null: no policy answered (a remote owner), so nothing loads.
        if (!isRecord(effective.selections))
          throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
        const selections = normalizePluginSelections(effective.selections);
        // In process installs a missing plugin and builds a compatibility
        // one; here either would leave the step without it.
        const plugins = resolveCodexPluginMcpServers(selections);
        if (
          selections.collectionIds.length > 0 ||
          // Built differently in process, so their root ids would differ.
          selections.skillRefs.length > 0 ||
          (selections.mcpServerRefs?.length ?? 0) > 0 ||
          plugins.compatibilityPlugins ||
          plugins.unresolvedPlugins
        )
          throw new Error(DAEMON_CODEX_PLUGINS_UNAVAILABLE);
        // Each step builds in its own folder; the finished build is
        // published by its contents, so the same capabilities keep the same
        // root ids across steps and a resumed session.
        const rootDir = path.join(
          codexCapabilityRoot(),
          'builds',
          randomUUID(),
        );
        const resolved = resolvePlugins(
          selections,
          request.projectId ?? 'pipeline',
          request.worktreeId ?? request.executionId,
          routeSessionId,
          {
            purpose: 'codex-session',
            runtimeDirs: {
              rootDir,
              claudePluginDir: path.join(rootDir, 'claude-sdk-plugin'),
            },
          },
        );
        resolved.warnings.unshift(...effective.warnings);
        try {
          // Published by content, as Electron main and the CLI publish
          // theirs: the same capabilities get the same root ids on every
          // host, step and resumed session.
          resolved.selectedCapabilityRoots = (
            await daemonCodexCapabilityStore().publishSelectedRoots(
              resolved.selectedCapabilityRoots,
            )
          ).roots;
        } finally {
          await rm(rootDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
        const registered: McpCredentialRef[] = [];
        sessionCredentials.set(routeSessionId, registered);
        return daemonCodexPluginResolution(resolved, routeSessionId, {
          bind: mcpBind,
          proxy: daemonCodexMcpProxy(),
          credentials: {
            ...mcpCredentials,
            register: (routeRef, rebind) => {
              const ref = mcpCredentials.register(routeRef, rebind);
              registered.push(ref);
              return ref;
            },
          },
        });
      },
      mcpCapabilityAuthorityIds: daemonCodexMcpAuthorityIds,
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
      releaseSession: (routeSessionId) => {
        codexMcpProxy?.revokeOwner(routeSessionId);
        for (const credential of sessionCredentials.get(routeSessionId) ?? [])
          mcpCredentials.release(credential);
        sessionCredentials.delete(routeSessionId);
        return release(routeSessionId);
      },
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

const GIT_COMMIT_PUSH = 'builtin/git-commit-push';

/** One failed repository of a `git-commit-push` step, as its outputs report it. */
type PrecommitRepository = Extract<
  WorkerPipelineOwnerRequest,
  { action: 'owner.precommit.failure' }
>['repositories'][number];

function isOutputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * The repositories a `git-commit-push` step's `results_json` says a
 * pre-commit hook refused (`failurePhase: 'commit'`), bounded to what the
 * owner request carries. The action already redacted every field; the
 * absolute `repoPath` is left out. Empty when none, or when the output is
 * not the action's.
 */
export function precommitFailedRepositories(
  outputs: Readonly<Record<string, string>>,
): PrecommitRepository[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputs.results_json ?? '');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const failed: PrecommitRepository[] = [];
  for (const result of parsed) {
    if (!isOutputRecord(result)) continue;
    if (result.status !== 'failed' || result.failurePhase !== 'commit')
      continue;
    const text = (
      key: 'repoId' | 'repoName' | 'relativePath' | 'branchName',
      max: number,
    ): Partial<PrecommitRepository> => {
      const value = boundedText(result[key], max);
      return value === undefined ? {} : { [key]: value };
    };
    failed.push({
      ...text('repoId', 512),
      ...text('repoName', 512),
      ...text('relativePath', 4096),
      ...text('branchName', 512),
      error:
        boundedText(result.error, WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX) ??
        '',
      precommitFailureError:
        boundedText(
          result.precommitFailureError,
          WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX,
        ) ?? '',
    });
    if (failed.length === WORKER_PIPELINE_OWNER_PRECOMMIT_REPOS_MAX) break;
  }
  return failed;
}

/**
 * CAN-6739: a brokered host's `git-commit-push` pre-commit failures, raised
 * to the run's owner as `owner.precommit.failure` after the step settles, as
 * desktop's Electron main fires its hook from the stored outputs (CAN-6012
 * D3). Only the run's own top-level steps report: the classifier refuses the
 * action inside a composite. Best effort: a report the owner doesn't settle
 * never changes the step.
 */
export function createDaemonPrecommitReporter(
  client: PipelineOwnerClient,
  run: {
    readonly executionId: string;
    readonly owner: WorkerPipelineHostRequest['owner'];
    /** The run's own: a cancelled or checkpointed run withdraws its report. */
    readonly signal?: AbortSignal;
  },
): NonNullable<ExecutionRuntime['onStepPostProcess']> {
  return async (ctx) => {
    if (
      ctx.step.uses !== GIT_COMMIT_PUSH ||
      (ctx.depth ?? 0) !== 0 ||
      ctx.jobId === undefined ||
      (ctx.executionId !== undefined && ctx.executionId !== run.executionId)
    )
      return;
    const repositories = precommitFailedRepositories(ctx.outputs);
    if (repositories.length === 0) return;
    await client
      .request(
        { action: 'owner.precommit.failure', repositories },
        {
          executionId: run.executionId,
          childExecutionId: null,
          jobId: ctx.jobId,
          stepId: ctx.step.id,
          attempt: ctx.attempt ?? 0,
          iteration: ctx.iteration ?? 0,
          owner: run.owner,
          deadlineMs: PIPELINE_OWNER_DEADLINE_MS.short,
        },
        run.signal ?? NEVER,
      )
      .catch(() => undefined);
  };
}
