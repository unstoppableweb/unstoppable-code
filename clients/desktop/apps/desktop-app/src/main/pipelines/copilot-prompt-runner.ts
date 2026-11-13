import { discoverHomeCapabilities } from '../plugins/home-capabilities';
import {
  runCopilotPipelinePrompt,
  type CopilotPipelineCapabilities,
} from '@canopy/desktop-shared/node/pipelines/copilot-prompt-runner';
import type {
  CopilotPromptRunnerRequest,
  CopilotPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { createCopilotCapabilitySnapshot } from '@canopy/copilot-recipient/capability-snapshot';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  emptyCursorCapabilityProjection,
  expandLeadingCursorCommand,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { createApprovalSession } from '../approvals/approval-service';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { buildCopilotMcpServers } from '../copilot/mcp-servers';
import {
  openManagedCopilotRuntime,
  assertCopilotConnectionGeneration,
} from '../copilot/connection';

export async function runDesktopCopilotPipelinePrompt(
  request: CopilotPromptRunnerRequest,
): Promise<CopilotPromptRunnerResult> {
  let generation: number | undefined;
  const authorize = (): void => {
    if (generation === undefined)
      throw new Error('Copilot runtime is unavailable.');
    assertCopilotConnectionGeneration(generation);
  };
  return runCopilotPipelinePrompt(request, {
    open: async (signal) => {
      const runtime = await openManagedCopilotRuntime({
        signal,
        cwd: request.cwd,
        workspaceId: request.projectId,
        executionKind: 'pipeline',
        environment: request.environment,
        owner: { kind: 'pipeline', id: request.executionId },
      });
      generation = runtime.generation;
      return runtime;
    },
    authorize,
    prepareCapabilities: async (profile, signal) => {
      authorize();
      const proxy = getMcpHttpProxyService();
      const sessionKey = `copilot-pipeline:${request.executionId}:${randomUUID()}`;
      const approval = createApprovalSession({
        sessionKey,
        projectId: request.projectId ?? 'pipeline',
        worktreeId: request.executionId,
        chatId: sessionKey,
        provider: 'copilot',
        workspaceRoot: request.cwd,
        // The preset is a ceiling below. Full Access still honors saved denies.
        mode:
          request.permissionPreset === 'dangerous_all' ? 'full-access' : 'ask',
        sessionRules: [],
        getWindow: () => null,
        trackChatTurn: false,
      });
      let disposed = false;
      const withdraw = (): void => {
        approval.invalidatePending?.();
      };
      signal.addEventListener('abort', withdraw, { once: true });
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener('abort', withdraw);
        try {
          approval.dispose();
        } finally {
          proxy.unregisterRoutesForSession(sessionKey);
        }
      };
      try {
        const selections = request.pluginSelections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        };
        const { inherited, inheritedPluginRefs } =
          await discoverHomeCapabilities({
            cwd: request.cwd,
            selections,
            signal,
          });
        const resolved = await resolvePlugins(
          selections,
          request.projectId ?? 'pipeline',
          request.executionId,
          sessionKey,
          {
            purpose: 'copilot-session',
            installExternalPlugins: true,
            enableHttpMcpProxy: true,
            mcpHttpProxyService: proxy,
            sessionId: sessionKey,
            packageOverlay: request.packageOverlay,
            inheritedCursorCapabilities: inherited,
            inheritedPluginRefs,
          },
        );
        signal.throwIfAborted();
        authorize();
        const projection =
          resolved.cursorCapabilities ?? emptyCursorCapabilityProjection();
        const capabilityRoot = join(profile, 'selected-capabilities');
        const prepared = await materializeSelectedCapabilityRoot(
          capabilityRoot,
          projection,
          { verifyContent: true, signal },
        );
        const servers = buildCopilotMcpServers({
          definitions: resolved.mcpServers,
          cwd: request.cwd,
        });
        const authorizeMcpTool: NonNullable<
          CopilotPipelineCapabilities['authorizeMcpTool']
        > = async (call) => {
          authorize();
          const selected = Object.prototype.hasOwnProperty.call(
            servers,
            call.server,
          )
            ? servers[call.server]
            : undefined;
          if (
            disposed ||
            signal.aborted ||
            request.permissionPreset !== 'dangerous_all' ||
            !selected ||
            !(
              (selected.tools ?? []).includes('*') ||
              (selected.tools ?? []).includes(call.tool)
            )
          ) {
            return { decision: 'deny' };
          }
          // Use the trusted structured MCP identity, never a flattened tool name.
          const target = {
            kind: 'mcp',
            server: call.server,
            tool: call.tool,
          } as const;
          const outcome = await approval.check(target, {
            title: `Copilot wants to use ${call.tool}`,
            details: target,
            suggestedTarget: target,
          });
          authorize();
          return disposed || signal.aborted || outcome.stopTurn
            ? { decision: 'deny' }
            : outcome;
        };
        const serverByUrl = new Map(
          Object.entries(servers).flatMap(([name, server]) =>
            'url' in server ? [[server.url, name] as const] : [],
          ),
        );
        proxy.setSessionToolCallGate(sessionKey, async (call) => {
          const server = serverByUrl.get(call.proxyUrl);
          if (!server) return false;
          const outcome = await authorizeMcpTool({
            server,
            tool: call.tool,
            args: call.args,
          });
          return outcome.decision === 'allow';
        });
        signal.throwIfAborted();
        return {
          capabilitySnapshot: createCopilotCapabilitySnapshot({
            materialized: prepared.fingerprint,
            skills: prepared.skillIds,
            commands: projection.commands.filter((command) =>
              prepared.commandIds.includes(command.id),
            ),
            mcp: proxy.getMcpCapabilityDigests(servers),
          }),
          skillDirectories: prepared.skillIds.length
            ? [join(capabilityRoot, 'skills')]
            : [],
          mcpServers: servers,
          authorizeMcpTool,
          expandPrompt: (prompt: string): string =>
            expandLeadingCursorCommand(
              prompt,
              projection.commands.filter((command) =>
                prepared.commandIds.includes(command.id),
              ),
            ),
          warnings: [
            ...inherited.skipped.map(
              (entry) =>
                `Skill or command "${entry.label}" could not be loaded: ${entry.reason}`,
            ),
            ...resolved.warnings,
            ...resolved.cursorNotices,
            ...prepared.warnings,
          ].map((warning) => warning.split('Cursor').join('Copilot')),
          dispose,
        };
      } catch (error) {
        dispose();
        throw error;
      }
    },
  });
}
