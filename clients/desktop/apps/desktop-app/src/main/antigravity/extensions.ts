import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@agentclientprotocol/sdk';
import { prepareAntigravityCapabilities } from '@canopy/desktop-shared/node/antigravity/capabilities';
import {
  capabilityFiles,
  capabilityInstructionIdentity,
} from '@canopy/desktop-shared/node/capabilities/file-snapshot';
import {
  effectiveCapabilityDigest,
  effectiveCapabilitySelections,
  type EffectiveCapabilityContent,
  type EffectiveCapabilityOmission,
  type EffectiveCapabilitySelections,
} from '@canopy/desktop-shared/node/capabilities/effective-snapshot';
import { mcpCapabilityIdentityKey } from '@canopy/protocol/canopy-core';
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
import { createMcpToolArgumentClassifier } from '../opencode/schema-validation';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { antigravityProfileDirectory } from './runtime';
import { assertAntigravityHarnessEnabled } from './feature-flag';
import { isAntigravityConnectionEnabled } from './connection';
import {
  AntigravityExternalToolSchemas,
  type AntigravityExternalToolSchema,
} from './external-mcp-schemas';

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

/** One selected MCP server, as the capability snapshot records it. */
export interface AntigravitySelectedMcp {
  name: string;
  transport: 'http' | 'stdio';
  /** Catalog identity keys, or a digest of the non-secret definition. */
  identity: string;
  /**
   * The ACP definition the native runtime received, for tool discovery. For
   * stdio it is always this turn's broker launcher, never the raw command, so
   * discovery runs inside the broker's process-tree ownership.
   */
  server: McpServer;
}

/** The snapshot inputs this resolution owns (CAP-09). */
export interface AntigravityExtensionSnapshot {
  selections: EffectiveCapabilitySelections;
  content: Omit<EffectiveCapabilityContent, 'files'>;
  /**
   * Hashes the delivered private copies. Called by the snapshot capture,
   * beside the native turn, while this resolution still owns the root.
   */
  files(signal: AbortSignal): Promise<Record<string, string>>;
  selectedMcp: AntigravitySelectedMcp[];
  omitted: EffectiveCapabilityOmission[];
}

export interface AntigravityExtensions {
  servers: McpServer[];
  instructions: string;
  fingerprint: string;
  notices: string[];
  snapshot: AntigravityExtensionSnapshot;
  expandPrompt(text: string): string;
  /** Selected external tools as last listed this turn; turn-scoped, not persisted. */
  externalToolSchemas(): AntigravityExternalToolSchema[];
  close(): Promise<void>;
}

/**
 * Recorded on every snapshot. The snapshot covers host-selected capabilities
 * only: the native runtime can still discover repository customizations
 * (skills, hooks, MCP, plugins) outside host selection, which is the open
 * CAP-02 isolation blocker. A reader must never treat this record as a
 * selected-only guarantee.
 */
const UNLOADED_FACETS: readonly EffectiveCapabilityOmission[] = [
  {
    subject: 'native repository discovery',
    reason:
      'Not captured. Antigravity can discover repository customizations outside host selection (CAP-02).',
  },
  {
    subject: 'native built-in tools',
    reason:
      'Not captured. Native tools, including built-in subagents, are not listed here and some run without host approval in runtime 1.5.1.',
  },
  {
    subject: 'plugin hooks',
    reason: 'Antigravity does not load plugin hooks.',
  },
  {
    subject: 'plugin agents',
    reason: 'Antigravity does not load native plugin agents.',
  },
];

function mcpIdentity(
  identities:
    | readonly Parameters<typeof mcpCapabilityIdentityKey>[0][]
    | undefined,
  definition: z.infer<typeof definitionSchema>,
): string {
  if (identities && identities.length > 0)
    return identities.map(mcpCapabilityIdentityKey).sort().join('\n');
  // Never the URL (an ephemeral route) or environment values (credentials).
  return effectiveCapabilityDigest({
    type: definition.type ?? 'stdio',
    command: definition.command,
    args: definition.args,
    cwd: definition.cwd,
    envKeys: Object.keys(definition.env ?? {}).sort(),
  });
}

async function deliveredFiles(
  root: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  try {
    return await capabilityFiles([root], signal, 'Antigravity');
  } catch (error) {
    signal.throwIfAborted();
    // No selection materializes no private root.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return {};
    throw error;
  }
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
  /**
   * A ceiling read on every selected tool call, before and after approval.
   * False denies the call before any remembered rule or Full Access applies.
   */
  toolCallAllowed?: () => boolean;
  /**
   * Workflow steps whose preset can never call a selected MCP tool do not load
   * the servers: nothing is handed to the native runtime, no stdio worker
   * starts and nothing is listed. Defaults to loading them, as chats do.
   */
  includeMcp?: boolean;
  /**
   * Whether a selected server Antigravity cannot load (SSE-only) is skipped
   * with a notice, as chats do, or fails the open. An unattended step must not
   * run without a server it selected.
   */
  skipUnsupportedMcp?: boolean;
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
  const permitted = (): boolean => input.toolCallAllowed?.() !== false;
  const schemas = new AntigravityExternalToolSchemas(
    createMcpToolArgumentClassifier(),
  );
  const gate = async (
    server: string,
    tool: string,
    args: unknown,
    callSignal: AbortSignal = signal,
  ): Promise<boolean | { refusal: string }> => {
    if (!available() || callSignal.aborted || !permitted()) return false;
    const callAbort =
      callSignal === signal ? signal : AbortSignal.any([signal, callSignal]);
    assertAntigravityHarnessEnabled();
    if (!(await isAntigravityConnectionEnabled()) || !available()) return false;
    // The runtime may have received a projected schema; the upstream one decides.
    const checked = await schemas.check(server, tool, args, callAbort);
    if (!checked.ok) return { refusal: checked.refusal };
    if (!available() || callSignal.aborted) return false;
    const outcome = await authorizeCursorMcpTool(
      { server, tool, args },
      {
        approval: input.approval,
        cwd: options.cwd,
        toolCallId: randomUUID(),
        planMode: input.planMode,
        providerLabel: 'Antigravity',
        signal: callAbort,
      },
    );
    if (outcome.stopTurn) input.stopTurn();
    if (
      !available() ||
      callSignal.aborted ||
      outcome.stopTurn ||
      outcome.decision !== 'allow' ||
      !permitted()
    )
      return false;
    // A list refreshed during approval: check again under the current schema.
    const decided = await schemas.confirm(checked.entry, args, callAbort);
    if (!decided.ok) return { refusal: decided.refusal };
    assertAntigravityHarnessEnabled();
    if (
      !(await isAntigravityConnectionEnabled()) ||
      !available() ||
      !permitted() ||
      callSignal.aborted
    )
      return false;
    return schemas.isCurrent(decided.entry)
      ? true
      : { refusal: 'The tool list changed while the call was approved.' };
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
  proxy.setSessionToolListTransform(ownerId, ({ proxyUrl, ...page }) => {
    const name = namesByUrl.get(proxyUrl);
    if (!name || !available())
      throw new Error('The selected MCP route is unavailable.');
    return schemas.advertise(name, page);
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
              // A step that cannot call MCP resolves none: no MCP probe, route
              // or warning, so its MCP evidence is the same on every run.
              skipMcpServers: input.includeMcp === false,
              sessionId: ownerId,
              preferences: context.preferences,
              packageOverlay: options.packageOverlay,
              ...(options.accountResolution
                ? { accountResolution: options.accountResolution }
                : {}),
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
    const selectedMcp: AntigravitySelectedMcp[] = [];
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
    const selectedServers =
      input.includeMcp === false ? {} : (resolved?.mcpServers ?? {});
    if (input.includeMcp === false)
      notices.push(
        'This step does not load MCP servers because it cannot call them.',
      );
    for (const [name, raw] of Object.entries(selectedServers)) {
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
      // Defensive: the resolver already drops turned-off servers.
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
        const server: McpServer = {
          type: 'http',
          name,
          url: definition.url,
          headers: [],
        };
        servers.push(server);
        selectedMcp.push({
          name,
          transport: 'http',
          identity: mcpIdentity(
            resolved?.mcpCapabilityIdentities?.[name],
            definition,
          ),
          server,
        });
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
            toolListTransform: (page) => {
              if (!available())
                throw new Error('The selected MCP route is unavailable.');
              return schemas.advertise(name, page);
            },
          },
        );
        const server: McpServer = {
          name,
          command: route.command,
          args: route.args,
          env: ['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
            name,
            value: tmpdir(),
          })),
        };
        servers.push(server);
        selectedMcp.push({
          name,
          transport: 'stdio',
          identity: mcpIdentity(
            resolved?.mcpCapabilityIdentities?.[name],
            definition,
          ),
          server,
        });
      } else if (
        definition.type === 'sse' &&
        input.skipUnsupportedMcp !== false
      ) {
        // A deferred Load can select a plugin whose server is SSE-only; the
        // turn continues without it rather than failing every later turn.
        notices.push(
          `MCP server ${name} was skipped because Antigravity does not support SSE servers.`,
        );
      } else if (definition.type === 'sse')
        throw new Error(
          `MCP server ${name} uses SSE, which Google workflow steps cannot load. Remove it from the step.`,
        );
      else
        throw new Error(
          `MCP server ${name} has no supported approval-gated transport.`,
        );
    }
    signal.throwIfAborted();
    const finalNotices = [
      ...new Set(
        notices.map((notice) => notice.split('Cursor').join('Antigravity')),
      ),
    ];
    return {
      ...prepared,
      servers,
      externalToolSchemas: () => schemas.entries(),
      notices: finalNotices,
      snapshot: {
        selections: effectiveCapabilitySelections({
          chat: options.pluginSelections,
          effective: context.selections,
          optedOut: context.chatTombstones,
          packageOverlay: options.packageOverlay,
        }),
        content: {
          skills: prepared.skillIds,
          commands: prepared.commandIds,
          // The private root is new each turn; identical content must keep
          // one digest, so the root is normalized out of the instructions.
          fingerprint: effectiveCapabilityDigest({
            instructions: capabilityInstructionIdentity(prepared.instructions, [
              capabilityRoot,
            ]),
            skills: prepared.skillIds,
            commands: prepared.commandIds,
          }),
        },
        files: (fileSignal) =>
          deliveredFiles(capabilityRoot, AbortSignal.any([signal, fileSignal])),
        selectedMcp,
        omitted: [
          ...UNLOADED_FACETS,
          // The private root is new each turn; a notice that names it must
          // not change the digest, so the root is normalized out here too.
          ...finalNotices.map((reason) => ({
            subject: 'selection',
            reason: reason
              .split(capabilityRoot)
              .join('<selected capabilities>'),
          })),
        ],
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
