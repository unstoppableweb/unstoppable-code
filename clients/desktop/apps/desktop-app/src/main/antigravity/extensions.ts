import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@agentclientprotocol/sdk';
import { prepareAntigravityCapabilities } from '@canopy/desktop-shared/node/antigravity/capabilities';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { emptyCursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  getEnhancedEnv,
  getBundledBinaryMember,
  resolveBundledBinary,
} from '@canopy/execution-engine/pipelines/config-paths';
import { hasAnySelections } from '@canopy/desktop-shared/types';
import type { AgentSessionOptions } from '../agents/types';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import type { getCodexRuntimeService } from '../codex/runtime-service';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { antigravityProfileDirectory } from './runtime';
import { assertAntigravityHarnessEnabled } from './feature-flag';
import { isAntigravityConnectionEnabled } from './connection';

const definitionSchema = z.object({
  type: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  enabled: z.boolean().optional(),
  allowedTools: z.unknown().optional(),
  disabledTools: z.unknown().optional(),
  enabled_tools: z.unknown().optional(),
  disabled_tools: z.unknown().optional(),
  default_tools_approval_mode: z.unknown().optional(),
  tools: z.unknown().optional(),
});

export interface AntigravityExtensions {
  servers: McpServer[];
  instructions: string;
  fingerprint: string;
  notices: string[];
  expandPrompt(text: string): string;
  close(): Promise<void>;
}

/** Owns one turn's selected connections. No upstream endpoint or credential reaches ACP. */
export async function openAntigravityExtensions(input: {
  sessionKey: string;
  options: AgentSessionOptions;
  approval: ApprovalSessionHandle;
  signal: AbortSignal;
  planMode: boolean;
  stopTurn: () => void;
  ownsSessionResources: () => boolean;
}): Promise<AntigravityExtensions> {
  const { options } = input;
  const ownerId = `antigravity-extensions:${randomUUID()}`;
  const capabilityRoot = join(
    antigravityProfileDirectory(),
    'selected-capabilities',
    createHash('sha256').update(input.sessionKey).digest('hex'),
    randomUUID(),
  );
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const proxy = getMcpHttpProxyService();
  let broker: ReturnType<typeof getCodexRuntimeService> | undefined;
  let closed = false;
  const available = (): boolean =>
    !closed && !signal.aborted && input.ownsSessionResources();
  const gate = async (
    server: string,
    tool: string,
    args: unknown,
    callSignal: AbortSignal = signal,
  ): Promise<boolean> => {
    if (!available() || callSignal.aborted) return false;
    assertAntigravityHarnessEnabled();
    if (!(await isAntigravityConnectionEnabled()) || !available()) return false;
    const outcome = await authorizeCursorMcpTool(
      { server, tool, args },
      {
        approval: input.approval,
        cwd: options.cwd,
        toolCallId: randomUUID(),
        planMode: input.planMode,
        providerLabel: 'Antigravity',
        signal: AbortSignal.any([signal, callSignal]),
      },
    );
    if (outcome.stopTurn) input.stopTurn();
    if (
      !available() ||
      callSignal.aborted ||
      outcome.stopTurn ||
      outcome.decision !== 'allow'
    )
      return false;
    assertAntigravityHarnessEnabled();
    return (
      (await isAntigravityConnectionEnabled()) &&
      available() &&
      !callSignal.aborted
    );
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    proxy.unregisterRoutesForSession(ownerId);
    try {
      await broker?.revokeStdioMcpRoutes(ownerId);
    } finally {
      await rm(capabilityRoot, { recursive: true, force: true });
    }
  };
  const registeredUrls = new Set<string>();
  const namesByUrl = new Map<string, string>();
  proxy.setSessionToolCallGate(ownerId, (call) => {
    const name = namesByUrl.get(call.proxyUrl);
    return name ? gate(name, call.tool, call.args) : Promise.resolve(false);
  });
  try {
    signal.throwIfAborted();
    const context = await resolveEffectiveChatPluginContext(
      options.pluginSelections,
      options,
      options.applyGlobalPluginDefaults,
    );
    const resolved =
      hasAnySelections(context.selections) || options.packageOverlay
        ? await resolvePlugins(
            context.selections,
            options.projectId,
            options.worktreeId,
            options.chatId,
            {
              purpose: 'antigravity-session',
              installExternalPlugins: true,
              enableHttpMcpProxy: true,
              sessionId: ownerId,
              preferences: context.preferences,
              packageOverlay: options.packageOverlay,
              mcpHttpProxyService: {
                ensureStarted: (port) => proxy.ensureStarted(port),
                registerRoute: async (route) => {
                  signal.throwIfAborted();
                  const id = await proxy.registerRoute({
                    ...route,
                    sessionId: ownerId,
                    requireToolCallGate: true,
                  });
                  if (!available()) {
                    proxy.unregisterRoute(id);
                    throw new Error(
                      'Antigravity extension selection was cancelled.',
                    );
                  }
                  registeredUrls.add(proxy.getProxyUrl(id));
                  return id;
                },
                unregisterRoute: (id) => proxy.unregisterRoute(id),
                getProxyUrl: (id) => proxy.getProxyUrl(id),
              },
            },
          )
        : undefined;
    signal.throwIfAborted();
    if (!available()) throw new Error('The owning Google turn has ended.');
    const prepared = await prepareAntigravityCapabilities({
      root: capabilityRoot,
      projection:
        resolved?.cursorCapabilities ?? emptyCursorCapabilityProjection(),
      signal,
    });
    const servers: McpServer[] = [];
    const notices = [
      ...(resolved?.warnings ?? []),
      ...(resolved?.cursorNotices ?? []),
      ...prepared.notices,
    ];
    const reserved = new Set(
      Object.values(cursorCanopyMcpServerNames()).concat(
        Object.values(cursorCanopyMcpServerNames('app-advisor')),
        Object.values(cursorCanopyMcpServerNames('pipeline-editor')),
      ),
    );
    for (const [name, raw] of Object.entries(resolved?.mcpServers ?? {})) {
      signal.throwIfAborted();
      const parsed = definitionSchema.safeParse(raw);
      if (
        !parsed.success ||
        reserved.has(name) ||
        !/^[a-zA-Z0-9_-]+$/.test(name)
      )
        throw new Error(
          'Antigravity received an invalid selected MCP definition.',
        );
      const definition = parsed.data;
      if (definition.enabled === false) continue;
      if (
        definition.allowedTools !== undefined ||
        definition.disabledTools !== undefined ||
        definition.enabled_tools !== undefined ||
        definition.disabled_tools !== undefined ||
        definition.default_tools_approval_mode !== undefined ||
        definition.tools !== undefined
      )
        throw new Error(
          `Antigravity cannot apply the selected tool filters for ${name}.`,
        );
      if (definition.type === 'http') {
        // Membership in this resolution's owner-held routes is the trust boundary.
        if (!definition.url || !registeredUrls.has(definition.url))
          throw new Error(
            `MCP server ${name} requires an approval-gated host route.`,
          );
        namesByUrl.set(definition.url, name);
        servers.push({ type: 'http', name, url: definition.url, headers: [] });
      } else if (
        (definition.type === undefined || definition.type === 'stdio') &&
        definition.command
      ) {
        const { getCodexRuntimeService } =
          await import('../codex/runtime-service');
        broker ??= getCodexRuntimeService();
        const bundled = getBundledBinaryMember(definition.command);
        const route = await broker.registerStdioMcpRoute(
          {
            ownerId,
            routeKey: name,
            command: bundled
              ? resolveBundledBinary(bundled).path
              : definition.command,
            args: definition.args ?? [],
            cwd: definition.cwd ?? options.cwd,
            baseEnv: Object.fromEntries(
              Object.entries(
                getEnhancedEnv({
                  environment: false,
                  includeCanopySecrets: false,
                }),
              ).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            ),
            env: definition.env,
          },
          {
            signal,
            toolCallGate: (call) =>
              gate(name, call.toolName, call.arguments, call.signal),
          },
        );
        servers.push({
          name,
          command: route.command,
          args: route.args,
          env: ['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
            name,
            value: tmpdir(),
          })),
        });
      } else
        throw new Error(
          `MCP server ${name} has no supported approval-gated transport.`,
        );
    }
    signal.throwIfAborted();
    return {
      ...prepared,
      servers,
      notices: [
        ...new Set(
          notices.map((notice) => notice.split('Cursor').join('Antigravity')),
        ),
      ],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
