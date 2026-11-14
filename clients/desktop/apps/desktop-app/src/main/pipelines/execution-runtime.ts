import {
  authorizeProjectPipelineRequest,
  readStoredPipelineContext,
} from './pipeline-install-context';
import {
  validateDependencyGraph,
  type ResourceContextInput,
} from '@canopy/execution-engine/lib/resource-context-policy';
import { getStoredPipelinePathWithSource } from '@canopy/execution-engine/pipelines/store';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
} from './canopy-server-client';
import {
  assertPipelineContext,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import { parseSharedPipelineLocalId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getDataDir } from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import {
  getBundledActionsDir,
  getBundledPipelinesDir,
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
} from './config-paths';
import type {
  AgentPromptWorkerResult,
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
  ExecutionRuntime,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
  SpawnedProcessResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  createDesktopLifecycleHooks,
  createDesktopStepPostProcess,
} from './execution-runtime-hooks';
import { createTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import { resolvePipelinePluginCollections } from './plugin-collection-resolver';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import { getClaudeWorkerSessionService } from '../integration/claude-worker-session-service';
import { resolveClaudeModAdmissionContext } from '../agents/claude-mod-admission-launch';
import { getWorktreeCliRecord } from '../lib/worktree-service';
import { classifyAgentFailure } from '@canopy/execution-engine/agent-failures';
import { transcriptHasAgentActivity } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { runPipelineProcessInExecutionHost } from './process-host-runner';
import {
  createDesktopPipelineLedgerPort,
  getPipelineLedgerAttemptTools,
} from './pipeline-ledger';
import { createDesktopPipelineHostActions } from './host-actions';
import {
  createWorkerPipelineHostActions,
  registerDesktopPipelineHostActions,
} from './pipeline-host-requests';
import {
  isDesktopPipelineModelBlocked,
  isDesktopPipelineOrgPolicyActive,
  recordDesktopPipelineModelPolicyRefusal,
  resolveDesktopPipelineAgentModelAlias,
  resolveDesktopPipelineAiCreditsRouting,
  resolveDesktopPipelineHarnessInvocation,
} from './pipeline-model-invocation';
import {
  PIPELINE_AGENT_SESSION_START_TIMEOUT_MS,
  runCodexPipelinePromptWith,
} from '@canopy/execution-engine/node/pipelines/codex-pipeline-prompt';
import { desktopCodexPipelinePromptPorts } from './codex-pipeline-prompt-ports';

function parseTranscriptEvents(jsonl: string): unknown[] {
  return jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line);
        return [event];
      } catch {
        return [];
      }
    });
}
import {
  assertPipelineHostTargetOwner,
  createDesktopPipelineOwnershipPort,
} from './pipeline-owner-policy';

export function createElectronExecutionRuntime(
  getWindow?: () => BrowserWindow | null,
): ExecutionRuntime {
  const desktopHost = createDesktopPipelineHostActions({
    assertTargetOwner: assertPipelineHostTargetOwner,
    ...(getWindow ? { getWindow } : {}),
  });
  const runtime: ExecutionRuntime = {
    resolvePipelineContextResource: async (parent, executionContext) => {
      if (!pipelineResourceContextEnabled()) return undefined;
      if (!parent.pipelineId)
        throw new Error('Workflow unavailable (unknown-provenance)');
      const parentShared = parseSharedPipelineLocalId(parent.pipelineId);
      let resource: ResourceContextInput['resource'];
      if (parentShared) {
        resource = {
          owner: (
            await (executionContext !== undefined
              ? getSharedPipelineForExecutionContext(parentShared.remoteId)
              : getSharedPipeline(parentShared.remoteId))
          ).owner,
        };
      } else if (
        parent.pipelineFileDir &&
        isPathInside(getBundledPipelinesDir(), parent.pipelineFileDir)
      ) {
        resource = { owner: { type: 'system' } };
      } else if (
        parent.pipelineId.startsWith('project--') ||
        (parent.pipelineFileDir &&
          !getStoredPipelinePathWithSource(parent.pipelineId).success)
      ) {
        if (!parent.cwd || !parent.pipelineFileDir)
          throw new Error('Workflow unavailable (unknown-provenance)');
        const { owner, projectId } = await authorizeProjectPipelineRequest({
          id: parent.pipelineId,
          cwd: parent.pipelineSource?.cwd ?? parent.cwd,
          filePath:
            parent.pipelineSource?.filePath ??
            path.join(
              parent.pipelineFileDir,
              path.basename(parent.pipelineId.replace(/^project--/, '')),
            ),
        });
        if (!parent.pipelineSource && projectId !== parent.projectId)
          throw new Error('Workflow unavailable (context-mismatch)');
        resource = { owner };
      } else {
        resource = await readStoredPipelineContext(
          parent.pipelineId,
          executionContext,
        );
        const stored = getStoredPipelinePathWithSource(parent.pipelineId);
        if (
          !resource.provenance &&
          stored.success &&
          stored.data?.source === 'bundled'
        )
          resource = { owner: { type: 'system' } };
      }
      await assertPipelineContext(resource, parent.projectId, executionContext);
      return resource;
    },
    resolvePipelineResource: async (
      reference,
      parent,
      file,
      target,
      executionContext,
    ) => {
      if (!pipelineResourceContextEnabled()) return undefined;
      if (target) {
        if (!parent)
          throw new Error('Workflow unavailable (unknown-provenance)');
        if (
          target.target.scope === 'directory' &&
          !target.projectId &&
          typeof classifyResourceOwner(effectivePipelineOwner(parent), {
            strict: true,
          }) === 'object'
        )
          throw new Error('Workflow unavailable (unsupported-target)');
        await assertPipelineContext(parent, target.projectId, executionContext);
      }
      if (file) {
        // Bundled presets resolved by relative file name are system-owned and
        // live outside every project root, so they never go through the
        // project resolver.
        const owner: ResourceContextInput['resource']['owner'] = isPathInside(
          getBundledPipelinesDir(),
          file.filePath,
        )
          ? { type: 'system' }
          : (await authorizeProjectPipelineRequest({ id: reference, ...file }))
              .owner;
        if (!parent)
          throw new Error('Workflow unavailable (unknown-provenance)');
        if (target)
          await assertPipelineContext(
            { owner },
            target.projectId,
            executionContext,
          );
        await assertPipelineContext(parent, undefined, executionContext);
        const decision = validateDependencyGraph(
          effectivePipelineOwner(parent),
          [{ owner: effectivePipelineOwner({ owner }), available: true }],
        );
        if (!decision.allow)
          throw new Error(`Workflow unavailable (${decision.reason})`);
        return undefined;
      }
      const shared = parseSharedPipelineLocalId(reference);
      if (!shared && !getStoredPipelinePathWithSource(reference).success)
        return undefined;
      const detail = shared
        ? await (executionContext !== undefined
            ? getSharedPipelineForExecutionContext(shared.remoteId)
            : getSharedPipeline(shared.remoteId))
        : undefined;
      let child: ResourceContextInput['resource'] = detail
        ? { owner: detail.owner }
        : await readStoredPipelineContext(reference, executionContext);
      if (!shared && !child.provenance) {
        const stored = getStoredPipelinePathWithSource(reference);
        if (stored.success && stored.data?.source === 'bundled')
          child = { owner: { type: 'system' } };
      }
      await assertPipelineContext(child, target?.projectId, executionContext);
      if (!parent) throw new Error('Workflow unavailable (unknown-provenance)');
      await assertPipelineContext(parent, undefined, executionContext);
      const decision = validateDependencyGraph(effectivePipelineOwner(parent), [
        { owner: effectivePipelineOwner(child), available: true },
      ]);
      if (!decision.allow)
        throw new Error(`Workflow unavailable (${decision.reason})`);
      if (detail) {
        return {
          pipeline: parsePipelineText(detail.rawPipeline),
          pipelineId: reference,
        };
      }
      return undefined;
    },
    executionsDir: path.join(getDataDir(), 'pipeline-executions'),
    tempRootDir: path.join(os.tmpdir(), 'canopy-exec'),
    bundledActionsDir: getBundledActionsDir(),
    getProjectActionsDir,
    getProjectActionsDirCandidates,
    getProjectPipelinesDir,
    getProjectPipelinesDirCandidates,
    lifecycle: createDesktopLifecycleHooks(),
    onStepPostProcess: createDesktopStepPostProcess(getWindow),
    planPersistence: {
      createTrackedPlan,
      updateTrackedPlan,
    },
    resolvePipelinePluginCollections,
    resolveClaudeModAdmissionContext: (request) =>
      resolveClaudeModAdmissionContext(request),
    resolveClaudeCompatibleInvocation,
    resolveModelHarnessInvocation: resolveDesktopPipelineHarnessInvocation,
    resolveAiCreditsRouting: resolveDesktopPipelineAiCreditsRouting,
    releaseAiCreditsRouting: (routeSessionId) => {
      getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    },
    resolvePipelineAgentModelAlias: resolveDesktopPipelineAgentModelAlias,
    isModelBlockedByOrgPolicy: isDesktopPipelineModelBlocked,
    isOrgModelPolicyActive: isDesktopPipelineOrgPolicyActive,
    recordModelPolicyRefusal: recordDesktopPipelineModelPolicyRefusal,
    resolvePipelineTarget: resolveDesktopPipelineTarget,
    pipelineLedger: createDesktopPipelineLedgerPort(),
    // Host steps reach core as worker-to-core requests.
    pipelineHostActions: createWorkerPipelineHostActions(desktopHost),
    pipelineOwnership: createDesktopPipelineOwnershipPort(),
    codexPromptRunner: {
      runCodexPrompt: (request) =>
        runCodexPipelinePromptWith(request, desktopCodexPipelinePromptPorts),
    },
    copilotPromptRunner: {
      async runCopilotPrompt(request) {
        return (
          await import('./copilot-prompt-runner')
        ).runDesktopCopilotPipelinePrompt(request);
      },
    },
    antigravityPromptRunner: {
      async runAntigravityPrompt(request) {
        return (
          await import('./antigravity-prompt-runner')
        ).runDesktopAntigravityPipelinePrompt(request);
      },
    },
    opencodePromptRunner: {
      async runOpenCodePrompt(request) {
        return (
          await import('./opencode-prompt-runner')
        ).runDesktopOpenCodePipelinePrompt(request);
      },
    },
    cursorPromptRunner: {
      async runCursorPrompt(
        request: CursorPromptRunnerRequest,
      ): Promise<CursorPromptRunnerResult> {
        // Dynamic import (local module): './cursor-prompt-runner'
        // transitively reaches the ESM-only '@agentclientprotocol/sdk' via
        // node/cursor/turn-driver -> node/acp/client. execution-runtime.ts
        // is statically imported by ipc/archived-containers.ts,
        // ipc/usage-limited-chats.ts, and pipelines/pipeline-handlers.ts, all
        // reachable at Electron main startup, so a static import here would
        // put that ESM chain on the static require graph the
        // bytecode-compiled main build resolves at load. The dynamic edge
        // keeps it off that graph and defers EVALUATION until a Cursor step
        // actually runs, mirroring agents/session-manager.ts's dynamic load
        // of the Cursor provider. It does not keep the bytes out of the
        // emitted chunk: the main build sets `inlineDynamicImports: true`
        // (electron.vite.config.ts) for the executor's circular import, so
        // Rollup inlines this module — deferred evaluation, not code
        // splitting, is the guarantee here.
        const { runCursorPipelinePrompt } =
          await import('./cursor-prompt-runner');
        return runCursorPipelinePrompt(request);
      },
    },
    agentPromptWorker: {
      async runAgentPrompt(request): Promise<AgentPromptWorkerResult> {
        const workerService = getClaudeWorkerSessionService();
        const abortSignal = request.signal;
        let workerId: string | undefined;
        const cancelWorker = (): void => {
          if (workerId) {
            void workerService.cancel(workerId);
          }
        };
        const captureWorkerId = (id: string): void => {
          workerId = id;
          if (abortSignal?.aborted) {
            queueMicrotask(cancelWorker);
          }
        };
        abortSignal?.addEventListener('abort', cancelWorker, { once: true });

        let result;
        try {
          result = await workerService.runWorker({
            kind: 'pipeline_agent_prompt',
            label: request.stepLabel,
            cwd: request.cwd,
            systemPrompt: request.systemPrompt ?? '',
            prompt: request.prompt,
            schema: request.schema,
            resumeSessionId: request.resumeSessionId,
            model: request.model,
            thinkingLevel: request.thinkingLevel,
            permission: request.permission,
            approvalMode: request.approvalMode,
            settingSources: request.settingSources,
            maxTurns: request.maxTurns,
            mcpServers: request.mcpServers,
            claudeEnvOverride: request.claudeEnvOverride,
            // A pipeline agent's Ledger tools; helper workers never get any.
            ledgerTools: getPipelineLedgerAttemptTools(
              request.ledgerAttemptKey,
            ),
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            pipelineExecutionId: request.executionId,
            stepId: request.stepId,
            linkTarget: request.linkTarget,
            startupTimeoutMs: PIPELINE_AGENT_SESSION_START_TIMEOUT_MS,
            onCreated: captureWorkerId,
            onStarted: (id) => {
              captureWorkerId(id);
              void request.onWorkerStarted?.(id);
            },
            onQueued: (id) => {
              captureWorkerId(id);
              void request.onWorkerQueued?.(id);
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            status: 'failure',
            transcript: '',
            projectedMessages: [],
            failure: {
              version: 1,
              provider: 'claude',
              agent_harness: 'claude',
              had_agent_activity: false,
              classification:
                classifyAgentFailure({
                  provider: 'claude',
                  model: request.model,
                  accountScope: 'native',
                  error,
                }) ?? undefined,
              message,
            },
          };
        } finally {
          abortSignal?.removeEventListener('abort', cancelWorker);
          if (request.aiCreditsRouteSessionId) {
            getCodexGatewayProxyService().unregisterRoutesForSession(
              request.aiCreditsRouteSessionId,
            );
          }
        }
        if (result.status !== 'success') {
          const message =
            result.error ??
            `Claude worker failed with status: ${result.status}`;
          const hadAgentActivity = transcriptHasAgentActivity(
            result.transcript,
          );
          return {
            status: result.status === 'cancelled' ? 'cancelled' : 'failure',
            workerId: result.workerId,
            transcript: result.transcriptJsonl,
            projectedMessages: result.transcript,
            failure: {
              version: 1,
              provider: 'claude',
              agent_harness: 'claude',
              session_id: result.sessionId,
              had_agent_activity: hadAgentActivity,
              classification:
                classifyAgentFailure({
                  provider: 'claude',
                  model: request.model,
                  accountScope: 'native',
                  events: parseTranscriptEvents(result.transcriptJsonl),
                  error: new Error(message),
                }) ?? undefined,
              message,
            },
          };
        }
        return {
          status: 'success',
          workerId: result.workerId,
          sessionId: result.sessionId,
          rawText: result.finalText,
          structured:
            request.schema !== undefined
              ? (result.result ?? undefined)
              : undefined,
          transcript: result.transcriptJsonl,
          proposedPlan: result.proposedPlan,
          projectedMessages: result.transcript,
        };
      },
    },
  };
  runtime.spawnedProcessRunner = (
    processSpec,
    options,
  ): Promise<SpawnedProcessResult> =>
    runPipelineProcessInExecutionHost(
      processSpec,
      options,
      runtime.resourceMonitor,
    );
  // A daemon run's host steps are applied with its start's desktop host (CAN-5771).
  registerDesktopPipelineHostActions(runtime, desktopHost);
  return runtime;
}

function effectivePipelineOwner(
  resource: ResourceContextInput['resource'],
): unknown {
  // Receipts preserve organization origin even if the current owner is portable.
  return resource.provenance?.ownerContext.kind === 'organization' &&
    typeof classifyResourceOwner(resource.owner, { strict: true }) !== 'object'
    ? {
        type: 'organization',
        id: resource.provenance.ownerContext.organizationId,
        name: null,
      }
    : resource.owner;
}

async function resolveDesktopPipelineTarget(
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  if (request.requested.scope !== 'worktree') {
    throw new Error(
      `Desktop runtime can only resolve worktree targets, received "${request.requested.scope}"`,
    );
  }

  const target = request.requested;
  const workspaceId = target.workspace_id;
  const worktreeId = target.worktree.id;
  const record = await getWorktreeCliRecord(workspaceId, worktreeId);
  return {
    cwd: record.path,
    scope: 'worktree',
    target: {
      scope: 'worktree',
      workspace_id: workspaceId,
      worktree_id: record.id,
      path: record.path,
      created: false,
    },
    projectId: workspaceId,
    worktreeId: record.id,
    repoPath: record.path,
  };
}
