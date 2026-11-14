import { AgentModelSelectionError } from '@canopy/execution-engine/lib/agent-model-selection';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { PipelineOwnerSettlement } from '@canopy/core-runtime/node/pipeline';
import {
  WorkerPipelineOwnerResultSchema,
  canopyJsonValueSchemaWithin,
  isWorkerPipelineOwnerAction,
  WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES,
  type CanopyJsonValue,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
  type WorkerPipelineOwnerResult,
  type WorkerPipelineOwnerValues,
} from '@canopy/protocol/canopy-core';
import {
  parsePermissionPreset,
  type PermissionPreset,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  isDynamicToolCallParams,
  type CodexHostToolPolicy,
} from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import {
  pipelineLedgerAttemptOutcome,
  resolvePipelineLedgerTarget,
} from '@canopy/execution-engine/node/pipelines/executor/pipeline-ledger';
import type {
  ExecutionState,
  PipelineLedgerAttempt,
  PipelineLedgerAttemptOutcome,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import { createTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import {
  resolveClaudeModAdmissionContext,
  resolveClaudeModConfigDirectory,
} from '../agents/claude-mod-admission-launch';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getMcpOAuthCredentials } from '../mcp/oauth-credentials';
import {
  resolveEffectivePluginSelectionRefs,
  resolvePluginMcpOAuthRoute,
} from '../plugins/plugin-resolver';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  PipelineOwnerMcpCredentials,
  type PipelineOwnerMcpDeps,
} from './pipeline-owner-mcp';
import { daemonPipelineOwnerGeneration } from './daemon-pipeline-owner';
import {
  createDesktopPipelineLedgerPort,
  openPipelineLedgerCodexTools,
  type PipelineLedgerCodexTools,
} from './pipeline-ledger';
import {
  isDesktopPipelineModelBlocked,
  isDesktopPipelineOrgPolicyActive,
  recordDesktopPipelineModelPolicyRefusal,
  resolveDesktopPipelineAgentModelAlias,
  resolveDesktopPipelineAiCreditsRouting,
  resolveDesktopPipelineHarnessInvocation,
} from './pipeline-model-invocation';

/*
 * Electron main's answers to pipeline owner requests (CAN-5095 D11, D12, D14):
 * a daemon run's model step asks for its route, the organization model policy
 * and its Agent Ledger tools while it runs. Each answer uses the run's own
 * stored scope, never the request's, and the functions in-process runs use.
 * Route URLs and Ledger route tokens return host-locally in the settlement's
 * values; nothing here logs a value.
 */

/** The scope and folder Electron main started a daemon run with (CAN-5095 D14). */
export interface PipelineOwnerRunScope {
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly executionContext?: ExecutionState['execution_context'];
  /** The run's checkout root, or its working directory. */
  readonly folder: string;
  /** The tracked plan the run started from, which its plan writes may revise (CAN-6327). */
  readonly planId?: string;
}

/** A daemon run Electron main admitted and follows (CAN-5095 D14). */
export interface PipelineOwnerRun {
  readonly executionId: string;
  /** The run's own scope, read on every request; never the request's. */
  scope(): PipelineOwnerRunScope;
  /** The run's redeemed secret values, for Ledger masking. Memory only. */
  readonly secretValues: readonly string[];
}

/** Redacted failure for an owner request (no detail, no value). */
export function pipelineOwnerFailure(
  message: string,
): WorkerPipelineHostResult {
  return { status: 'failure', failureReason: null, message, outputs: {} };
}

const NOT_THIS_RUN = 'This app did not start this workflow run.';
const RUN_ENDED = 'This workflow run has ended.';
const UNANSWERED = 'The app could not answer this workflow step.';
const FOREIGN_ROUTE = 'This route session belongs to another workflow run.';
const FOREIGN_PLAN = 'This plan belongs to another workflow run.';

const toolJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES,
);
const toolSpecJson = canopyJsonValueSchemaWithin(65_536);

/** One module-level port, so Codex tool lookups find its attempts. */
const desktopLedgerPort = createDesktopPipelineLedgerPort();

interface OpenAttempt {
  readonly attempt: PipelineLedgerAttempt;
  readonly physicalJobId: string;
  readonly stepId: string;
}

interface OpenCodexTools {
  readonly tools: PipelineLedgerCodexTools;
  readonly policies: Map<string, CodexHostToolPolicy>;
}

function owner(value: WorkerPipelineOwnerResult): WorkerPipelineHostResult {
  return { status: 'owner', value };
}

function settled(
  value: WorkerPipelineOwnerResult,
  values?: WorkerPipelineOwnerValues,
): PipelineOwnerSettlement {
  return values ? { result: owner(value), values } : { result: owner(value) };
}

function failed(message: string): PipelineOwnerSettlement {
  return { result: pipelineOwnerFailure(message) };
}

/** Host-local values with only the members that are present. */
function ownerValues(
  requestId: string,
  env: Record<string, string> | undefined,
  codexConfig: Record<string, unknown> | undefined,
): WorkerPipelineOwnerValues | undefined {
  const config =
    codexConfig === undefined
      ? undefined
      : toolJson.safeParse(codexConfig).data;
  if (env === undefined && config === undefined) return undefined;
  return {
    requestId,
    ...(env !== undefined ? { env } : {}),
    ...(config !== undefined && isJsonRecord(config)
      ? { codexConfig: config }
      : {}),
  };
}

function permissionPresetOf(raw: string): PermissionPreset | undefined {
  try {
    return parsePermissionPreset(raw);
  } catch {
    return undefined;
  }
}

function isJsonRecord(
  value: CanopyJsonValue,
): value is Record<string, CanopyJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `cwd` lies at or under the run's folder, both resolved. A missing
 * path refuses.
 */
async function insideRunFolder(
  cwd: string,
  run: PipelineOwnerRunScope,
): Promise<boolean> {
  try {
    const [folder, root] = await Promise.all([
      realpath(cwd),
      realpath(run.folder),
    ]);
    const relative = path.relative(root, folder);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Whether a step may have its Mods read from `dir`: a folder in the run, or
 * the user's own Claude config folder, which an in-process step reads too.
 */
async function isRunClaudeConfigDir(
  dir: string,
  run: PipelineOwnerRunScope,
): Promise<boolean> {
  // Main's own default, from its own environment and home; never the request's.
  // Without user variables, as a workflow step's child env is built.
  const own = resolveClaudeModConfigDirectory({
    cwd: run.folder,
    environment: false,
  });
  // Canonical, so a folder not created yet still counts as in the run.
  const [requested, root, canonicalOwn] = await Promise.all([
    canonicalPath(dir),
    canonicalPath(run.folder),
    canonicalPath(own),
  ]);
  const relative = path.relative(root, requested);
  return (
    (!relative.startsWith('..') && !path.isAbsolute(relative)) ||
    requested === canonicalOwn
  );
}

/**
 * `target` with every symlink resolved; a missing tail keeps its names under
 * its nearest existing ancestor, so a link or `..` cannot stand in for it.
 */
async function canonicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return (await realpath(absolute)).normalize('NFC');
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute.normalize('NFC');
    return path
      .join(await canonicalPath(parent), path.basename(absolute))
      .normalize('NFC');
  }
}

const DESKTOP_MCP_DEPS: PipelineOwnerMcpDeps = {
  broker: getMcpOAuthCredentials,
  generation: daemonPipelineOwnerGeneration,
  resolve: resolvePluginMcpOAuthRoute,
};

/** One daemon run's owner-held resources: routes, Ledger attempts, Codex tool sessions, MCP credentials. */
export class PipelineOwnerRunContext {
  private readonly routes = new Set<string>();
  private readonly mcp: PipelineOwnerMcpCredentials;
  private readonly attempts = new Map<string, OpenAttempt>();
  private readonly codexTools = new Map<string, OpenCodexTools>();
  /** The tracked plans this run kept (CAN-6327), which its writes may revise. */
  private readonly plans = new Set<string>();
  private readonly inFlight = new Set<Promise<PipelineOwnerSettlement>>();
  private readonly ended = new AbortController();
  private closed = false;

  constructor(
    private readonly run: PipelineOwnerRun,
    mcpDeps: PipelineOwnerMcpDeps = DESKTOP_MCP_DEPS,
  ) {
    this.mcp = new PipelineOwnerMcpCredentials(mcpDeps);
  }

  /** Settle one owner request for this run. Never throws: failures settle redacted. */
  async apply(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineOwnerSettlement> {
    if (
      request.executionId !== this.run.executionId ||
      !isWorkerPipelineOwnerAction(request.request.action)
    )
      return failed(NOT_THIS_RUN);
    if (this.closed) return failed(RUN_ENDED);
    // close() waits for this request, so whatever it creates is released.
    const settling = this.settle(
      request,
      AbortSignal.any([signal, this.ended.signal]),
    );
    this.inFlight.add(settling);
    try {
      const settlement = await settling;
      return this.closed ? failed(RUN_ENDED) : settlement;
    } catch (error) {
      if (this.closed) return failed(RUN_ENDED);
      if (error instanceof AgentModelSelectionError)
        return failed(error.message);
      logMainProcessWarn('Pipeline owner request failed', {
        action: request.request.action,
        executionId: request.executionId,
      });
      return failed(UNANSWERED);
    } finally {
      this.inFlight.delete(settling);
    }
  }

  /**
   * The route session a request routes under, recorded before routing
   * creates it so close() releases it: the step's own, or one this run
   * mints when the step names none. A session of another run is refused:
   * releasing it would end that run's routes.
   */
  private ownRoute(routeSessionId: string | undefined): string | undefined {
    const prefix = `pipeline:${this.run.executionId}:`;
    const session = routeSessionId ?? `${prefix}owner:${randomUUID()}`;
    if (!session.startsWith(prefix)) return undefined;
    this.routes.add(session);
    return session;
  }

  private async settle(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineOwnerSettlement> {
    const state = this.run.scope();
    const { projectId, worktreeId, executionContext } = state;
    const scope = {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(worktreeId !== undefined ? { worktreeId } : {}),
      ...(executionContext !== undefined ? { executionContext } : {}),
    };
    const routingScope = {
      ...(projectId !== undefined ? { workspaceId: projectId } : {}),
      ...(worktreeId !== undefined ? { worktreeId } : {}),
      ...(executionContext !== undefined ? { executionContext } : {}),
      signal,
    };
    const action = request.request;
    switch (action.action) {
      case 'owner.model.invocation': {
        const routeSessionId = this.ownRoute(action.routeSessionId);
        if (routeSessionId === undefined) return failed(FOREIGN_ROUTE);
        const invocation = await resolveDesktopPipelineHarnessInvocation(
          action.model,
          {
            harness: action.harness,
            routeSessionId,
            ...(action.checkpointProxyQuota !== undefined
              ? { checkpointProxyQuota: action.checkpointProxyQuota }
              : {}),
            ...(action.requiredAccountProxyConnectionId !== undefined
              ? {
                  requiredAccountProxyConnectionId:
                    action.requiredAccountProxyConnectionId,
                }
              : {}),
            ...(action.allowNoNativeAuthFallback !== undefined
              ? { allowNoNativeAuthFallback: action.allowNoNativeAuthFallback }
              : {}),
            ...routingScope,
          },
        );
        // Ollama answers with its local server's route (CAN-5831).
        if (invocation.harness !== 'claude' && invocation.harness !== 'codex')
          return failed('This model does not run in the background service.');
        return settled(
          {
            kind: 'model.invocation',
            source: invocation.source,
            harness: invocation.harness,
            runtimeModel: invocation.runtimeModel,
            aiCreditsRouted: invocation.aiCreditsRouted,
            modelGatewayRouted: invocation.modelGatewayRouted === true,
            accountProxyRouted: invocation.accountProxyRouted === true,
            ...(invocation.accountProxyConnectionId !== undefined
              ? {
                  accountProxyConnectionId: invocation.accountProxyConnectionId,
                }
              : {}),
          },
          ownerValues(
            request.requestId,
            invocation.envOverride,
            invocation.codexConfig,
          ),
        );
      }
      case 'owner.model.routing': {
        const routeSessionId = this.ownRoute(action.routeSessionId);
        if (routeSessionId === undefined) return failed(FOREIGN_ROUTE);
        const override = await resolveDesktopPipelineAiCreditsRouting(
          action.model,
          action.provider,
          {
            routeSessionId,
            ...(action.checkpointProxyQuota !== undefined
              ? { checkpointProxyQuota: action.checkpointProxyQuota }
              : {}),
            ...(action.requiredAccountProxyConnectionId !== undefined
              ? {
                  requiredAccountProxyConnectionId:
                    action.requiredAccountProxyConnectionId,
                }
              : {}),
            ...(action.allowNoNativeAuthFallback !== undefined
              ? { allowNoNativeAuthFallback: action.allowNoNativeAuthFallback }
              : {}),
            ...routingScope,
          },
        );
        if (override === null)
          return settled({ kind: 'model.routing', override: null });
        return settled(
          {
            kind: 'model.routing',
            override: {
              provider: action.provider,
              model: override.model,
              modelGatewayRouted: override.modelGatewayRouted === true,
              accountProxyRouted: override.accountProxyRouted === true,
              ...(override.accountProxyConnectionId !== undefined
                ? {
                    accountProxyConnectionId: override.accountProxyConnectionId,
                  }
                : {}),
            },
          },
          ownerValues(request.requestId, override.env, override.codexConfig),
        );
      }
      case 'owner.model.release': {
        // A peer cannot release a route this run did not issue.
        if (this.routes.delete(action.routeSessionId))
          getCodexGatewayProxyService().unregisterRoutesForSession(
            action.routeSessionId,
          );
        return settled({ kind: 'model.release' });
      }
      case 'owner.model.policy': {
        try {
          const answer =
            action.check === 'blocked' && action.modelId !== undefined
              ? await isDesktopPipelineModelBlocked(action.modelId, scope)
              : await isDesktopPipelineOrgPolicyActive(scope);
          return settled({ kind: 'model.policy', answer });
        } catch {
          return failed(
            'The app could not check the organization model policy.',
          );
        }
      }
      case 'owner.model.policyRefusal': {
        recordDesktopPipelineModelPolicyRefusal({
          executionId: this.run.executionId,
          jobId: request.jobId,
          stepId: request.stepId,
          ...(projectId !== undefined ? { projectId } : {}),
          ...(worktreeId !== undefined ? { worktreeId } : {}),
          modelId: action.modelId,
        });
        return settled({ kind: 'model.policyRefusal' });
      }
      case 'owner.ledger.open': {
        const target = resolvePipelineLedgerTarget({
          projectId,
          worktreeId,
          executionContext,
        });
        if (target === undefined)
          return settled({ kind: 'ledger.open', attempt: null });
        const permissionPreset = permissionPresetOf(action.permissionPreset);
        if (permissionPreset === undefined)
          return failed("This step's permission preset is not valid.");
        const attempt = await desktopLedgerPort.openAttempt({
          executionId: this.run.executionId,
          ...(action.pipelineId !== undefined
            ? { pipelineId: action.pipelineId }
            : {}),
          ...(action.pipelineName !== undefined
            ? { pipelineName: action.pipelineName }
            : {}),
          target,
          ...(projectId !== undefined ? { projectId } : {}),
          ...(worktreeId !== undefined ? { worktreeId } : {}),
          physicalJobId: action.physicalJobId,
          logicalJobId: action.logicalJobId,
          jobName: action.jobName,
          stepId: action.stepId,
          stepName: action.stepName,
          attempt: action.attempt,
          iteration: action.iteration,
          ...(action.resumedAgentSessionId !== undefined
            ? { resumedAgentSessionId: action.resumedAgentSessionId }
            : {}),
          ...(action.predecessorAgentSessionId !== undefined
            ? { predecessorAgentSessionId: action.predecessorAgentSessionId }
            : {}),
          ...(action.checkpointId !== undefined
            ? { checkpointId: action.checkpointId }
            : {}),
          harness: action.harness,
          ...(action.model !== undefined ? { model: action.model } : {}),
          ...(action.thinkingEffort !== undefined
            ? { thinkingEffort: action.thinkingEffort }
            : {}),
          permissionPreset,
          secretValues: this.run.secretValues,
        });
        if (attempt === null)
          return settled({ kind: 'ledger.open', attempt: null });
        this.attempts.set(attempt.attemptKey, {
          attempt,
          physicalJobId: action.physicalJobId,
          stepId: action.stepId,
        });
        return settled({
          kind: 'ledger.open',
          attempt: {
            attemptKey: attempt.attemptKey,
            agentSessionId: attempt.agentSessionId,
            instructions: attempt.instructions,
          },
        });
      }
      case 'owner.ledger.subprocessTools': {
        const open = this.attempts.get(action.attemptKey);
        if (open === undefined)
          return failed('This Ledger attempt is not open.');
        // The app is a local owner: its host always sends the step's folder.
        if (
          action.cwd === undefined ||
          !(await insideRunFolder(action.cwd, state))
        )
          return failed('This step folder is outside the workflow run.');
        const tools = await open.attempt.openSubprocessTools(action.cwd);
        const mcpServers = toolJson.safeParse(tools.mcpServers).data;
        if (mcpServers === undefined || !isJsonRecord(mcpServers))
          return failed(UNANSWERED);
        return settled(
          { kind: 'ledger.subprocessTools' },
          {
            requestId: request.requestId,
            ledgerSubprocessTools: {
              mcpServers,
              allowedTools: [...tools.allowedTools],
              secretValues: [...tools.secretValues],
            },
          },
        );
      }
      case 'owner.ledger.close': {
        const open = this.attempts.get(action.attemptKey);
        if (open !== undefined) {
          this.attempts.delete(action.attemptKey);
          open.attempt.close(action.outcome);
        }
        return settled({ kind: 'ledger.close' });
      }
      case 'owner.ledger.codexTools': {
        if (!this.attempts.has(action.attemptKey))
          return failed('This Ledger attempt is not open.');
        if (
          action.cwd === undefined ||
          !(await insideRunFolder(action.cwd, state))
        )
          return failed('This step folder is outside the workflow run.');
        const tools = openPipelineLedgerCodexTools(
          action.attemptKey,
          action.cwd,
        );
        if (tools === undefined)
          return settled({ kind: 'ledger.codexTools', tools: null });
        const specs: CanopyJsonValue[] = [];
        for (const spec of tools.specs) {
          const json = toolSpecJson.safeParse(spec).data;
          if (json === undefined) {
            tools.dispose();
            return failed(UNANSWERED);
          }
          specs.push(json);
        }
        const toolsKey = randomUUID();
        this.codexTools.set(toolsKey, { tools, policies: new Map() });
        return settled({
          kind: 'ledger.codexTools',
          tools: {
            toolsKey,
            instructions: tools.instructions,
            specs,
            allowedTools: tools.specs.map(({ name }) => ({
              namespace: null,
              tool: name,
            })),
          },
        });
      }
      case 'owner.ledger.codexToolAuthorize': {
        const policy = this.codexPolicy(action.toolsKey, action.threadId);
        if (policy === undefined || !isDynamicToolCallParams(action.call))
          return settled({
            kind: 'ledger.codexToolAuthorize',
            authorized: false,
          });
        const authorized = await policy.authorize(action.call, signal);
        return settled({ kind: 'ledger.codexToolAuthorize', authorized });
      }
      case 'owner.ledger.codexToolExecute': {
        const refused = settled({
          kind: 'ledger.codexToolExecute',
          response: { success: false, contentItems: [] },
        });
        const policy = this.codexPolicy(action.toolsKey, action.threadId);
        if (policy === undefined || !isDynamicToolCallParams(action.call))
          return refused;
        const response = toolJson.safeParse(
          await policy.execute(action.call, signal),
        ).data;
        if (response === undefined) return failed(UNANSWERED);
        return settled({ kind: 'ledger.codexToolExecute', response });
      }
      case 'owner.ledger.codexToolsDispose': {
        const open = this.codexTools.get(action.toolsKey);
        if (open !== undefined) {
          this.codexTools.delete(action.toolsKey);
          open.tools.dispose();
        }
        return settled({ kind: 'ledger.codexToolsDispose' });
      }
      case 'owner.claude.modAdmission': {
        // The run's own folder bounds what is read, as for Ledger requests.
        if (
          !(await insideRunFolder(action.cwd, state)) ||
          (action.claudeConfigDir !== undefined &&
            !(await isRunClaudeConfigDir(action.claudeConfigDir, state)))
        )
          return failed('This step folder is outside the workflow run.');
        const context = await resolveClaudeModAdmissionContext({
          cwd: action.cwd,
          settingSources: action.settingSources,
          ...(action.claudeConfigDir !== undefined && {
            claudeConfigDir: action.claudeConfigDir,
          }),
        });
        const answer = WorkerPipelineOwnerResultSchema.safeParse(
          JSON.parse(
            JSON.stringify({
              kind: 'claude.modAdmission',
              context: context ?? null,
            }),
          ),
        );
        return answer.success ? settled(answer.data) : failed(UNANSWERED);
      }
      case 'owner.model.agentAlias': {
        // The run's own workspace decides an inheriting Agent's base (CAN-5832).
        const resolution = await resolveDesktopPipelineAgentModelAlias(
          action.agentId,
          scope,
        );
        const answer = WorkerPipelineOwnerResultSchema.safeParse(
          JSON.parse(
            JSON.stringify({ kind: 'model.agentAlias', alias: resolution }),
          ),
        );
        return answer.success ? settled(answer.data) : failed(UNANSWERED);
      }
      case 'owner.plan.create': {
        // A run outside a worktree keeps no tracked plan, as in process.
        if (projectId === undefined || worktreeId === undefined)
          return settled({ kind: 'plan.create', planId: null });
        // A start-time create that lands after the run's end kept its plan.
        const kept = this.plans.values().next();
        if (action.initial === true && !kept.done)
          return settled({ kind: 'plan.create', planId: kept.value });
        const plan = await createTrackedPlan({
          projectId,
          worktreeId,
          source: 'pipeline',
          content: action.content,
          reviewStatus: 'approved',
          linkedExecutionId: this.run.executionId,
        });
        this.plans.add(plan.id);
        return settled({ kind: 'plan.create', planId: plan.id });
      }
      case 'owner.plan.update': {
        if (
          projectId === undefined ||
          worktreeId === undefined ||
          (action.planId !== state.planId && !this.plans.has(action.planId))
        )
          return failed(FOREIGN_PLAN);
        // As the in-process upsert writes it: a link while the run runs, an
        // approval with any changed content once it ends.
        await updateTrackedPlan({
          projectId,
          worktreeId,
          planId: action.planId,
          linkedExecutionId: this.run.executionId,
          ...(action.content !== undefined && { content: action.content }),
          ...(action.approve && {
            source: 'pipeline',
            reviewStatus: 'approved',
            approvedAt: new Date().toISOString(),
            dismissedAt: null,
          }),
        });
        return settled({ kind: 'plan.update' });
      }
      case 'owner.mcp.bind': {
        const routeRef = await this.mcp.bind({
          marketplaceId: action.marketplaceId,
          pluginName: action.pluginName,
          serverName: action.serverName,
          contentHash: action.contentHash,
        });
        return settled({ kind: 'mcp.bind', routeRef });
      }
      case 'owner.mcp.authorize': {
        const granted = await this.mcp.authorize(action.routeRef, signal);
        if ('refused' in granted)
          return settled({
            kind: 'mcp.authorize',
            grantId: null,
            refused: granted.refused,
          });
        return settled(
          { kind: 'mcp.authorize', grantId: granted.grantId },
          {
            requestId: request.requestId,
            mcpAuthorization: { authorization: granted.authorization },
          },
        );
      }
      case 'owner.mcp.rejected': {
        await this.mcp.rejected(action.grantId);
        return settled({ kind: 'mcp.rejected' });
      }
      case 'owner.codex.pluginRefs': {
        // A daemon Codex step loads only what this app's own policy lets it,
        // as Electron main's resolver applies it in process (CAN-6168): a
        // skill whose context check fails fails the step here too.
        const selections = normalizePluginSelections(action.selections);
        const warnings: string[] = [];
        const refs = await resolveEffectivePluginSelectionRefs(
          selections,
          warnings,
          projectId,
        );
        const answer = WorkerPipelineOwnerResultSchema.safeParse(
          JSON.parse(
            JSON.stringify({
              kind: 'codex.pluginRefs',
              selections: {
                collectionIds: [],
                skillRefs: refs.skillRefs,
                pluginRefs: refs.pluginRefs,
                mcpServerRefs: refs.mcpServerRefs,
              },
              warnings: refs.warnings,
            }),
          ),
        );
        return answer.success ? settled(answer.data) : failed(UNANSWERED);
      }
      default:
        return failed(NOT_THIS_RUN);
    }
  }

  private codexPolicy(
    toolsKey: string,
    threadId: string,
  ): CodexHostToolPolicy | undefined {
    const open = this.codexTools.get(toolsKey);
    if (open === undefined) return undefined;
    const kept = open.policies.get(threadId);
    if (kept !== undefined) return kept;
    const policy = open.tools.policy(threadId);
    open.policies.set(threadId, policy);
    return policy;
  }

  /**
   * Release every route the run's steps still hold, close its open Ledger
   * attempts (`paused` with the state's checkpoint when the run is paused,
   * else `settled`) and dispose its Codex tool sessions. Idempotent; later
   * requests settle `This workflow run has ended.`.
   */
  async close(finalState: ExecutionState | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ended.abort();
    await Promise.allSettled([...this.inFlight]);
    this.mcp.close();
    for (const routeSessionId of this.routes)
      getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    this.routes.clear();
    for (const open of this.codexTools.values()) open.tools.dispose();
    this.codexTools.clear();
    for (const open of this.attempts.values())
      open.attempt.close(attemptOutcome(open, finalState));
    this.attempts.clear();
  }
}

function attemptOutcome(
  open: OpenAttempt,
  finalState: ExecutionState | null,
): PipelineLedgerAttemptOutcome {
  if (finalState?.status !== 'paused') return { kind: 'settled' };
  return pipelineLedgerAttemptOutcome(
    finalState.jobs[open.physicalJobId]?.steps[open.stepId],
  );
}
