import type { CodexPipelinePromptPorts } from '@canopy/execution-engine/node/pipelines/codex-pipeline-prompt';
import { resolveAiCreditsRoutingOverride } from '../agents/ai-credits-routing';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { openPipelineLedgerCodexTools } from './pipeline-ledger';

/** Electron main's Codex workflow ports: exactly the calls the runner made before (CAN-5095). */
export const desktopCodexPipelinePromptPorts: CodexPipelinePromptPorts = {
  runtime: () => getCodexRuntimeService(),
  resolvePlugins: (request, routeSessionId, runtime) =>
    resolvePlugins(
      request.pluginSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      request.projectId ?? 'pipeline',
      request.worktreeId ?? request.executionId,
      routeSessionId,
      {
        purpose: 'codex-session',
        installExternalPlugins: true,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: getMcpHttpProxyService(),
        mcpStdioBroker: runtime,
        sessionId: routeSessionId,
        packageOverlay: request.packageOverlay,
      },
    ),
  mcpCapabilityAuthorityIds: (servers) =>
    getMcpHttpProxyService().getCodexCapabilityAuthorityIds(servers),
  legacyMcpCapabilityAuthorityIds: (servers) =>
    getMcpHttpProxyService().getLegacyCodexCapabilityAuthorityIds(servers),
  resolveRouting: (model, routeSessionId, request) =>
    resolveAiCreditsRoutingOverride(model, 'codex', undefined, routeSessionId, {
      environmentRuntime: 'pipeline',
      ...(request.projectId ? { workspaceId: request.projectId } : {}),
      ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
      ...(request.allowNoNativeAuthFallback !== undefined
        ? {
            allowNoNativeAuthFallback: request.allowNoNativeAuthFallback,
          }
        : {}),
      ...(request.executionContext !== undefined
        ? { executionContext: request.executionContext }
        : {}),
    }),
  environmentProfile: (request) =>
    Promise.resolve(
      resolveCodexRuntimeEnvironmentProfile({
        runtime: 'pipeline',
        ...(request.projectId ? { workspaceId: request.projectId } : {}),
      }),
    ),
  openLedgerTools: (attemptKey, cwd) =>
    Promise.resolve(openPipelineLedgerCodexTools(attemptKey, cwd)),
  releaseSession: (routeSessionId) => {
    getMcpHttpProxyService().unregisterRoutesForSession(routeSessionId);
    getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    return Promise.resolve();
  },
};
