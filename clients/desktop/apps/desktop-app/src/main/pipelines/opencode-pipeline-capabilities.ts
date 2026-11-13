import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OpenCodePipelineCapabilities } from '@canopy/desktop-shared/node/pipelines/opencode-prompt-runner';
import type { OpenCodePromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  emptyCursorCapabilityProjection,
  expandLeadingCursorCommand,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { openCodeCapabilityDigest } from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import { openCodeMcpCallMatchesSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';
import { resolveOpenCodeMcpSnapshotTool } from '@canopy/desktop-shared/node/opencode/mcp-tool-identity';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  resolvePlugins,
  type McpHttpProxyServiceForResolver,
} from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { buildOpenCodeMcpServers } from '../opencode/mcp-servers';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import { validateOpenCodeMcpSchema } from '../opencode/schema-validation';

/** Owns the selected capability files and proxy routes for one pipeline step. */
export async function prepareOpenCodePipelineCapabilities(
  request: OpenCodePromptRunnerRequest,
  profile: string,
  signal: AbortSignal,
  currentApproval: () => ApprovalSessionHandle,
): Promise<OpenCodePipelineCapabilities> {
  signal.throwIfAborted();
  currentApproval();
  const proxy = getMcpHttpProxyService();
  const sessionKey = `opencode-pipeline-capabilities:${request.executionId}:${randomUUID()}`;
  const routeIdentities = new Map<string, string>();
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    signal.removeEventListener('abort', dispose);
    // Resolution can finish after withdrawal and register another route. Always
    // unregister again when that late result is disposed.
    proxy.unregisterRoutesForSession(sessionKey);
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    proxy.setSessionToolCallGate(sessionKey, () => Promise.resolve(false));
    const resolverProxy: McpHttpProxyServiceForResolver = {
      ensureStarted: (port) => proxy.ensureStarted(port),
      registerRoute: async (route) => {
        signal.throwIfAborted();
        if (disposed || route.sessionId !== sessionKey)
          throw new Error(
            'OpenCode pipeline capability session is unavailable.',
          );
        const routeId = await proxy.registerRoute({
          ...route,
          requireToolCallGate: true,
        });
        if (disposed || signal.aborted) {
          proxy.unregisterRoute(routeId);
          throw new Error(
            'OpenCode pipeline capability session is unavailable.',
          );
        }
        // Bind strict resumes to the selected upstream declaration, never the
        // random local proxy address or the per-turn session identifier.
        routeIdentities.set(
          proxy.getProxyUrl(routeId),
          openCodeCapabilityDigest({
            serverId: route.serverId,
            configId: route.configId,
            upstreamUrl: route.upstreamUrl,
            headers: route.headers,
            oauthEnabled: route.oauthEnabled,
            oauthRequired: route.oauthRequired,
            authSupplier: route.authSupplier,
          }),
        );
        return routeId;
      },
      unregisterRoute: (routeId) => {
        routeIdentities.delete(proxy.getProxyUrl(routeId));
        proxy.unregisterRoute(routeId);
      },
      getProxyUrl: (routeId) => proxy.getProxyUrl(routeId),
    };
    const resolved = await resolvePlugins(
      request.pluginSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      request.projectId ?? 'pipeline',
      request.executionId,
      sessionKey,
      {
        purpose: 'opencode-session',
        installExternalPlugins: true,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: resolverProxy,
        sessionId: sessionKey,
        packageOverlay: request.packageOverlay,
      },
    );
    signal.throwIfAborted();
    currentApproval();
    const projection =
      resolved.cursorCapabilities ?? emptyCursorCapabilityProjection();
    const capabilityRoot = join(profile, 'selected-capabilities');
    const prepared = await materializeSelectedCapabilityRoot(
      capabilityRoot,
      projection,
    );
    signal.throwIfAborted();
    const mcpServers = buildOpenCodeMcpServers({
      definitions: resolved.mcpServers,
      cwd: request.cwd,
    });
    const mcpSnapshot = await snapshotOpenCodeMcpTools(
      mcpServers,
      Object.fromEntries(
        mcpServers.map((server) => [
          server.name,
          {
            binding: resolved.mcpServerBindings[server.name],
            definition:
              ('url' in server ? routeIdentities.get(server.url) : undefined) ??
              openCodeCapabilityDigest(resolved.mcpServers[server.name]),
          },
        ]),
      ),
      request.cwd,
      signal,
    );
    const check = async (
      server: string,
      tool: string,
      args: unknown,
      callId: string,
    ): Promise<boolean> => {
      if (
        disposed ||
        signal.aborted ||
        request.permissionPreset !== 'dangerous_all'
      )
        return false;
      const approval = currentApproval();
      if (
        !(await openCodeMcpCallMatchesSnapshot(
          mcpSnapshot,
          server,
          tool,
          args,
          {
            validate: validateOpenCodeMcpSchema,
            signal,
          },
        ))
      )
        return false;
      if (disposed || signal.aborted || currentApproval() !== approval)
        return false;
      const target = { kind: 'mcp', server, tool } as const;
      const outcome = await approval.check(target, {
        title: `OpenCode wants to use ${tool}`,
        details: target,
        suggestedTarget: target,
        toolUseId: callId,
      });
      return (
        !disposed &&
        !signal.aborted &&
        currentApproval() === approval &&
        !outcome.stopTurn &&
        outcome.decision === 'allow'
      );
    };
    const serverByUrl = new Map(
      mcpServers.flatMap((server) =>
        'url' in server ? [[server.url, server.name] as const] : [],
      ),
    );
    proxy.setSessionToolCallGate(sessionKey, (call) => {
      const server = serverByUrl.get(call.proxyUrl);
      return server
        ? check(server, call.tool, call.args, call.requestId ?? randomUUID())
        : Promise.resolve(false);
    });
    signal.throwIfAborted();
    currentApproval();
    return {
      capabilityRoots: [capabilityRoot],
      capabilityContext: {
        selections: request.pluginSelections,
        skills: prepared.skillIds,
        commands: prepared.commandIds,
      },
      mcpServers,
      mcpSnapshot,
      instructions: projection.skills
        .filter((skill) => prepared.skillIds.includes(skill.id))
        .map(
          (skill) =>
            `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
        )
        .join('\n\n'),
      expandPrompt: (prompt: string): string =>
        expandLeadingCursorCommand(
          prompt,
          projection.commands.filter((command) =>
            prepared.commandIds.includes(command.id),
          ),
        ),
      warnings: [
        ...resolved.warnings,
        ...resolved.cursorNotices,
        ...prepared.warnings,
      ].map((warning) => warning.split('Cursor').join('OpenCode')),
      authorizeMcpTool: async (input): Promise<ApprovalOutcome> => {
        const identity = resolveOpenCodeMcpSnapshotTool(
          mcpSnapshot,
          input.toolName,
        );
        const allowed =
          identity &&
          (await check(
            identity.server,
            identity.tool.name,
            input.toolArgs,
            input.toolCallId,
          ));
        return { decision: allowed ? 'allow' : 'deny' };
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
