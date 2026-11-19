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
import { prepareOpenCodeCommandHooks } from '@canopy/desktop-shared/node/opencode/command-hooks';
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
import {
  buildOpenCodeMcpServers,
  openOpenCodeMcpRoutes,
} from '../opencode/mcp-servers';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import { validateOpenCodeMcpSchema } from '../opencode/schema-validation';
import {
  openPipelineLedgerOpenCodeTools,
  type PipelineLedgerOpenCodeTools,
} from './pipeline-ledger';

/** Owns the selected capability files and proxy routes for one pipeline step. */
export async function prepareOpenCodePipelineCapabilities(
  request: OpenCodePromptRunnerRequest,
  profile: string,
  signal: AbortSignal,
  currentApproval: () => ApprovalSessionHandle,
  baseEnv: NodeJS.ProcessEnv,
): Promise<OpenCodePipelineCapabilities> {
  signal.throwIfAborted();
  currentApproval();
  const proxy = getMcpHttpProxyService();
  const sessionKey = `opencode-pipeline-capabilities:${request.executionId}:${randomUUID()}`;
  const routeIdentities = new Map<string, string>();
  let disposed = false;
  let mcpRoutes: Awaited<ReturnType<typeof openOpenCodeMcpRoutes>> | undefined;
  let ledger: PipelineLedgerOpenCodeTools | undefined;
  const dispose = async (): Promise<void> => {
    disposed = true;
    signal.removeEventListener('abort', onAbort);
    // Resolution can finish after withdrawal and register another route. Always
    // unregister again when that late result is disposed.
    proxy.unregisterRoutesForSession(sessionKey);
    ledger?.dispose();
    await mcpRoutes?.dispose();
  };
  const onAbort = (): void => {
    void dispose().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
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
        // A workflow prompt has no one to pick an account (CAN-6232).
        accountResolution: 'unattended',
      },
    );
    signal.throwIfAborted();
    currentApproval();
    const projection =
      resolved.cursorCapabilities ?? emptyCursorCapabilityProjection();
    const selectedHooks = await prepareOpenCodeCommandHooks(
      resolved.sdkPlugins.map((plugin) => plugin.path),
      join(profile, 'selected-hook-plugins'),
      signal,
    );
    const capabilityRoot = join(profile, 'selected-capabilities');
    const prepared = await materializeSelectedCapabilityRoot(
      capabilityRoot,
      projection,
    );
    signal.throwIfAborted();
    let mcpServers = buildOpenCodeMcpServers({
      definitions: resolved.mcpServers,
      cwd: request.cwd,
    });
    const serverIdentities: Record<string, unknown> = Object.fromEntries(
      mcpServers.map((server) => [
        server.name,
        {
          binding: resolved.mcpServerBindings[server.name],
          definition:
            ('url' in server ? routeIdentities.get(server.url) : undefined) ??
            openCodeCapabilityDigest(resolved.mcpServers[server.name]),
        },
      ]),
    );
    // The step's Ledger tools ride the app's own server on a per-run route;
    // its identity is the app surface, not a selected capability. A route
    // that cannot open costs the step its Feed tools, never the step.
    let ledgerWarning: string | undefined;
    if (request.ledgerAttemptKey !== undefined) {
      try {
        ledger = await openPipelineLedgerOpenCodeTools(
          request.ledgerAttemptKey,
          request.cwd,
        );
      } catch (error) {
        ledgerWarning = `Feed tools are unavailable for this step: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (signal.aborted || disposed) {
        // Withdrawal during the open: the route registered after `dispose`
        // ran, so it is released here, before the withdrawal is reported.
        ledger?.dispose();
        ledger = undefined;
        signal.throwIfAborted();
        throw new Error('OpenCode pipeline capability session is unavailable.');
      }
      const ledgerName = ledger?.server.name;
      if (ledger && mcpServers.some(({ name }) => name === ledgerName)) {
        // `buildOpenCodeMcpServers` reserves the brand namespace; a selected
        // server that still carries it must not inherit the Ledger branch's
        // gate, so the Ledger route yields.
        ledgerWarning = `Feed tools are unavailable for this step: a selected MCP server is named "${ledgerName}".`;
        ledger.dispose();
        ledger = undefined;
      }
      if (ledger) {
        mcpServers.push({
          type: 'http',
          name: ledger.server.name,
          url: ledger.server.url,
          headers: [
            {
              name: 'Authorization',
              value: `Bearer ${ledger.server.authToken}`,
            },
          ],
        });
        serverIdentities[ledger.server.name] = {
          app: ledger.server.name,
          surface: 'pipeline-ledger',
        };
      }
    }
    const mcpSnapshot = await snapshotOpenCodeMcpTools(
      mcpServers,
      serverIdentities,
      request.cwd,
      signal,
      false,
      baseEnv,
    );
    const ledgerServer = ledger?.server.name;
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
    mcpRoutes = await openOpenCodeMcpRoutes({
      servers: mcpServers,
      baseEnv,
      cwd: request.cwd,
      signal,
      gate: check,
    });
    mcpServers = mcpRoutes.servers;
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
      commandHooks: selectedHooks.hooks,
      hookApproval: {
        check: (check, display) =>
          request.permissionPreset === 'dangerous_all' &&
          !signal.aborted &&
          !disposed
            ? currentApproval().check(check, display)
            : Promise.resolve({ decision: 'deny' }),
      },
      capabilityRoots: [capabilityRoot, ...selectedHooks.capabilityRoots],
      capabilityContext: {
        selections: request.pluginSelections,
        skills: prepared.skillIds,
        commands: prepared.commandIds,
        commandHooks: selectedHooks.hooks,
      },
      mcpServers,
      mcpSnapshot,
      instructions: [
        ...projection.skills
          .filter((skill) => prepared.skillIds.includes(skill.id))
          .map(
            (skill) =>
              `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
          ),
        ...(ledger ? [ledger.instructions] : []),
      ].join('\n\n'),
      ...(ledgerServer === undefined
        ? {}
        : { ledger: { server: ledgerServer } }),
      expandPrompt: (prompt: string): string =>
        expandLeadingCursorCommand(
          prompt,
          projection.commands.filter((command) =>
            prepared.commandIds.includes(command.id),
          ),
        ),
      warnings: [
        ...selectedHooks.warnings,
        ...[
          ...resolved.warnings,
          ...resolved.cursorNotices,
          ...prepared.warnings,
        ].map((warning) => warning.split('Cursor').join('OpenCode')),
        ...(ledgerWarning === undefined ? [] : [ledgerWarning]),
      ],
      authorizeMcpTool: async (input): Promise<ApprovalOutcome> => {
        const identity = resolveOpenCodeMcpSnapshotTool(
          mcpSnapshot,
          input.toolName,
        );
        if (identity && identity.server === ledgerServer) {
          // The Ledger route gates each call with the attempt's approval
          // session when it arrives; here only the snapshot is checked.
          const matches =
            !disposed &&
            !signal.aborted &&
            (await openCodeMcpCallMatchesSnapshot(
              mcpSnapshot,
              identity.server,
              identity.tool.name,
              input.toolArgs,
              { validate: validateOpenCodeMcpSchema, signal },
            ));
          return { decision: matches && !disposed ? 'allow' : 'deny' };
        }
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
    await dispose();
    throw error;
  }
}
