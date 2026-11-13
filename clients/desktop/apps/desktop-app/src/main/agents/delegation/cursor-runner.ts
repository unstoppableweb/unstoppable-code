import { buildDelegationCursorEnvironment } from '@canopy/desktop-shared/node/delegation/environment';
import { randomBytes } from 'node:crypto';
import { mkdir, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import type { AgentDelegationUsage } from '@canopy/protocol/delegation';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import {
  LocalDelegationRunner,
  DelegationRunnerError,
  type LocalDelegationContext,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime';
import type { CursorProviderProcess } from '@canopy/desktop-shared/node/cursor/runtime-process';
import type { CursorTurnGates } from '@canopy/desktop-shared/node/cursor/turn-driver';
import {
  readToolPath,
  writeToolInput,
  shellToolCommand,
} from '@canopy/desktop-shared/node/cursor/tool-input';
import { materializeCursorCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { resolveCursorCanopyToolKey } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { getManagedCursorRuntime } from '../../cursor/connection';
import { buildCursorMcpServers } from '../../cursor/mcp-servers';
import { getMcpHttpProxyService } from '../../mcp/http-proxy-service';
import { buildCursorCapabilityProjection } from '../../plugins/plugin-resolver';
import type { DelegationNativePolicy } from './native-policy';
import {
  DELEGATION_STREAM_PREVIEW_LIMITS,
  DelegationTranscriptRecorder,
} from './transcript-recorder';
import { ChildAppendQueue } from './child-append-queue';
import { DelegationChildNormalizer } from './child-row-normalizers';
import { delegationBlockId } from '@canopy/agent-transcript';
import { childDelegationGuidance } from './child-tools';
import {
  delegateAppToolGuidance,
  type DelegateCanopyTools,
} from './canopy-tools';

export interface CursorDelegationPreparation {
  readonly model: string;
  readonly profileDir: string;
  readonly tools: DelegationNativePolicy;
  readonly appTools?: DelegateCanopyTools;
  readonly plugins: readonly { path: string }[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  bindMcpGates(gates: CursorTurnGates): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Native Cursor tools enter the same live file grants and approval policy as other children. */
export async function authorizeDelegatedCursorTool(
  payload: unknown,
  tools: DelegationNativePolicy,
  signal: AbortSignal,
): Promise<{ decision: 'allow' | 'deny' }> {
  if (
    signal.aborted ||
    !record(payload) ||
    payload.hook_event_name !== 'preToolUse' ||
    typeof payload.tool_use_id !== 'string' ||
    !payload.tool_use_id ||
    !record(payload.tool_input)
  )
    return { decision: 'deny' };
  const name = payload.tool_name;
  const input = payload.tool_input;
  // MCP is authorized at its execution transport, where the server is known.
  if (typeof name === 'string' && name.startsWith('MCP:'))
    return { decision: 'allow' };
  // Native traversal can return private descendants even when its root is allowed.
  // Keep it unavailable until execution or results enforce the private-path policy.
  if (
    name === 'Grep' ||
    name === 'Glob' ||
    name === 'List' ||
    name === 'ReadLints'
  )
    return { decision: 'deny' };
  if (name === 'Read' && !readToolPath(input)) return { decision: 'deny' };
  if (name === 'Delete' && !readToolPath(input)) return { decision: 'deny' };
  if (name === 'Write' && !writeToolInput(input)) return { decision: 'deny' };
  if (
    name === 'Shell' &&
    (!shellToolCommand(input) ||
      (input.cwd !== undefined &&
        (typeof input.cwd !== 'string' ||
          path.resolve(tools.cwd, input.cwd) !== tools.cwd)))
  )
    return { decision: 'deny' };
  if (
    name !== 'Read' &&
    name !== 'Write' &&
    name !== 'Shell' &&
    name !== 'Delete'
  )
    return { decision: 'deny' };
  const allowed = await tools.authorize(
    name === 'Shell' ? 'Bash' : name === 'Delete' ? 'Write' : String(name),
    input,
    payload.tool_use_id,
  );
  return { decision: allowed && !signal.aborted ? 'allow' : 'deny' };
}

export function createCursorDelegationRunner(options: {
  available(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability>;
  prepare(
    context: LocalDelegationContext,
  ): Promise<CursorDelegationPreparation>;
  delegation?(context: LocalDelegationContext): DelegationParent | undefined;
  reportError(error: unknown): void;
  transcriptPort?: DelegationTranscriptPort;
}): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'cursor',
    'cursor-acp',
    (route) => options.available(route),
    async (context) => {
      const prepared = await options.prepare(context);
      const delegation = options.delegation?.(context);
      if (delegation)
        context.retain(() => {
          delegation.detach();
          return Promise.resolve();
        });
      const { request } = context;
      const home = path.join(prepared.profileDir, 'home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      const managed = await getManagedCursorRuntime(context.signal, undefined, {
        homeOverlay: home,
      });
      // Defer this local ACP-dependent module until a Cursor child starts so
      // unrelated delegation callers do not eagerly load the ESM-only SDK.
      const { verifyCursorVersion } =
        await import('../../cursor/approval-check');
      const { cursorProcessForWorkerRun } =
        await import('../../agent-runs/cursor-worker-runtime');
      const providerProcess: CursorProviderProcess = cursorProcessForWorkerRun(
        'CursorDelegationRunner.start',
      );
      await verifyCursorVersion(
        providerProcess,
        managed.launch,
        managed.env,
        context.signal,
      );
      const notices: string[] = [];
      const warnings: string[] = [];
      const projection = buildCursorCapabilityProjection(
        [],
        prepared.plugins.map((plugin, index) => ({
          pluginPath: plugin.path,
          pluginName: `selection-${index + 1}`,
          marketplaceId: 'retained',
          category: 'local',
          provider: 'claude',
          mode: 'native',
        })),
        new Set(prepared.plugins.map((plugin) => plugin.path)),
        notices,
        warnings,
      );
      const root = await materializeCursorCapabilityRoot(home, projection);
      if (root.warnings.length || notices.length || warnings.length)
        throw new DelegationRunnerError({
          code: 'capability_unavailable',
          message:
            'Retained Cursor skills or commands could not be loaded completely.',
          retryable: false,
        });
      // File reads of the selected native skill copies remain scoped to this child.

      const proxy = getMcpHttpProxyService();
      const key = `${request.parent.sessionKey}:cursor-delegate:${request.delegationId}:${request.runGeneration}`;
      const namespace = BRAND.tools.namespace;
      const appendChildChanges = context.appendChildChanges;
      const childNormalizer = appendChildChanges
        ? new DelegationChildNormalizer(
            delegationBlockId(
              context.request.delegationId,
              context.request.runGeneration,
            ),
          )
        : undefined;
      const transcript = new DelegationTranscriptRecorder(
        childNormalizer ? DELEGATION_STREAM_PREVIEW_LIMITS : undefined,
      );
      const childAppends = appendChildChanges
        ? new ChildAppendQueue(appendChildChanges, (changes) =>
            childNormalizer?.acknowledge(changes),
          )
        : undefined;
      // Provider events queue their rows and continue; finishing waits until
      // every queued row is durable.
      const queueNormalizedChanges = async (
        changes: readonly DelegationTranscriptChange[],
      ): Promise<void> => childAppends?.enqueue(changes);
      const appendNormalizedChanges = async (
        changes: readonly DelegationTranscriptChange[],
      ): Promise<void> => childAppends?.flush(changes);
      let usage: AgentDelegationUsage | undefined;
      let lastTranscript = 0;
      const flush = async (): Promise<void> => {
        const items = transcript.take();
        if (items?.length)
          await context.emit({
            type: 'transcript',
            items,
            truncated: transcript.truncated,
          });
      };
      const cleanup = (): Promise<void> => {
        proxy.unregisterCanopyWorktreeSessionRoute(key);
        return Promise.resolve();
      };
      context.retain(cleanup);
      // Load the workspace-local ACP transport only for an active Cursor child.
      const { runCursorTurn } =
        await import('@canopy/desktop-shared/node/cursor/turn-driver');
      try {
        const outcome = await runCursorTurn(
          {
            cwd: prepared.tools.cwd,
            text: `Managed delegated task:\n${request.task.prompt}`,
            launch: managed.launch,
            providerProcess,
            env: buildDelegationCursorEnvironment(managed.env),
            hookRuntime: path.join(
              path.dirname(managed.launch.command),
              managed.target.hookRuntime,
            ),
            profileDir: prepared.profileDir,
            rawModelId: prepared.model,
            model: request.route.runtimeModelId,
            thinkingLevel: request.route.effectiveThinkingLevel,
            sessionId: request.resumeSessionId,
            requireExistingSession: Boolean(request.resumeSessionId),
            signal: context.signal,
          },
          {
            clientName: 'canopy-cursor-delegate',
            planMode: false,
            authorizeNative: (payload, native) =>
              authorizeDelegatedCursorTool(
                payload,
                prepared.tools,
                native.signal,
              ),
            authorizeMcp: async (call, native) => {
              if (native.signal.aborted) return { decision: 'deny' };
              if (call.server === namespace) {
                const known =
                  delegation?.ownsTool(call.tool) ||
                  prepared.appTools?.tools.some(
                    (tool) => tool.name === call.tool,
                  );
                // The private HTTP route performs execution-time policy checks.
                return { decision: known ? 'allow' : 'deny' };
              }
              return {
                // Every selected server uses a host-gated transport. ACP only
                // admits it there; approval happens against live policy when
                // the HTTP proxy or stdio broker receives the actual call.
                decision: (await prepared.tools.canUseMcp(
                  call.server,
                  call.tool,
                  native.signal,
                ))
                  ? 'allow'
                  : 'deny',
              };
            },
            prepareMcp: async (capabilities, gates) => {
              prepared.bindMcpGates(gates);
              if (capabilities?.http !== true)
                throw new DelegationRunnerError({
                  code: 'capability_unavailable',
                  message:
                    'Cursor did not provide the HTTP transport required for delegated tools.',
                  retryable: false,
                });
              const token = randomBytes(32).toString('base64url');
              const definitions = [
                ...(delegation?.projection.tools ?? []),
                ...(prepared.appTools?.tools ?? []),
              ].map((tool) => {
                if (!isJsonValue(tool.inputSchema))
                  throw new Error('Invalid delegated tool schema');
                return {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                };
              });
              await proxy.registerCanopyWorktreeSessionRoute({
                sessionKey: key,
                projectId: request.parent.projectId,
                worktreeId: request.parent.worktreeId,
                chatId: request.parent.chatId,
                cwd: prepared.tools.cwd,
                sdkSessionId: key,
                providerType: 'cursor',
                toolSurface: 'cursor-acp',
                authToken: token,
                createdAt: Date.now(),
                hookHandler: () => undefined,
                managedDelegation: {
                  exclusive: true,
                  tools: definitions,
                  invoke: async (name, input, transport) => {
                    if (!transport?.requestId || gates.signal.aborted)
                      return {
                        text: 'Delegated run is unavailable.',
                        isError: true,
                      };
                    const callId = transport.requestId;
                    const call = { server: namespace, tool: name, args: input };
                    const appKey = resolveCursorCanopyToolKey(call);
                    const identity = appKey
                      ? gates.appToolCallIdentity(appKey, input)
                      : gates.pluginCallIdentity(namespace, name, input);
                    // ACP admission is advisory for this private route. Consume
                    // its receipt, then enforce live policy at execution below.
                    gates.consumeAllowance(identity);
                    const appTool = prepared.appTools?.tools.find(
                      (tool) => tool.name === name,
                    );
                    const readOnly = [
                      'GetDelegateOutput',
                      'InspectDelegate',
                      'ListDelegates',
                    ].includes(name);
                    const allowed =
                      appTool && prepared.appTools
                        ? await prepared.appTools.authorize(appTool, {
                            callId,
                            signal: gates.signal,
                          })
                        : delegation?.ownsTool(name) === true &&
                          (await prepared.tools.authorizeAppTool(
                            namespace,
                            name,
                            readOnly,
                            callId,
                            gates.signal,
                          ));
                    gates.recordGateDecision(
                      identity,
                      allowed ? 'allow' : 'deny',
                    );
                    if (!allowed || gates.signal.aborted)
                      return { text: `${name} was denied.`, isError: true };
                    if (appTool && prepared.appTools)
                      return prepared.appTools.run(appTool, input, {
                        callId,
                        signal: gates.signal,
                      });
                    const turnId = delegation?.options.currentTurn();
                    if (!delegation || !turnId)
                      return {
                        text: 'Delegated owner is unavailable.',
                        isError: true,
                      };
                    const result = await delegation.invokeCursor(name, input, {
                      callId,
                      turnId,
                    });
                    return {
                      text: JSON.stringify(result),
                      isError: !result.ok,
                    };
                  },
                },
              });
              const built = await buildCursorMcpServers({
                canopy: null,
                resolvedMcpServers: { ...prepared.mcpServers },
                capabilities,
                resolveExecutable: async (command, cwd) => {
                  const candidates = path.isAbsolute(command)
                    ? [command]
                    : command.includes('/') || command.includes('\\')
                      ? [path.resolve(cwd ?? prepared.tools.cwd, command)]
                      : (managed.env.PATH ?? '')
                          .split(path.delimiter)
                          .filter(Boolean)
                          .map((dir) => path.join(dir, command));
                  for (const candidate of candidates) {
                    try {
                      if ((await stat(candidate)).isFile()) {
                        await access(candidate, constants.X_OK);
                        return candidate;
                      }
                    } catch {
                      /* Try the next captured PATH entry. */
                    }
                  }
                  return null;
                },
              });
              return {
                servers: [
                  {
                    type: 'http',
                    name: namespace,
                    url: proxy.getCanopyWorktreeMcpUrl(key),
                    headers: [
                      { name: 'Authorization', value: `Bearer ${token}` },
                    ],
                  },
                  ...built.servers,
                ],
                notes: built.notes,
                notices: built.warnings,
                appToolsAvailable: true,
                pluginServerNames: built.servers.map((server) => server.name),
              };
            },
            beforePrompt: async ({ sessionId, mcp }) => {
              await context.emit({
                type: 'started',
                nativeSessionId: sessionId,
              });
              return {
                instructions: `${prepared.tools.instructions()}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(prepared.appTools, 'cursor')}\nUse native Read, Write, Delete, and Shell under the supplied grants. Grep, Glob, List, and ReadLints are unavailable because their results could expose private files. Read specific paths directly. Native Cursor subagents and detached background commands are unavailable. Shell follows the parent's command approval policy; file-tool grants do not sandbox shell commands.\n${[...mcp.notes, ...mcp.notices].join('\n')}`,
              };
            },
            emit: async (event) => {
              transcript.cursor(event);
              await queueNormalizedChanges(
                childNormalizer ? await childNormalizer.patch(event) : [],
              );
              if (transcript.limitExceeded && !childNormalizer)
                throw new Error(
                  'Delegated Cursor transcript exceeds retention limits.',
                );
              if (Date.now() - lastTranscript >= 100) {
                lastTranscript = Date.now();
                await flush();
              }
            },
            onUsage: async (reported) => {
              usage = {
                inputTokens: reported.inputTokens,
                outputTokens: reported.outputTokens,
                cachedInputTokens: reported.cacheReadTokens,
                cacheCreationInputTokens: reported.cacheWriteTokens,
              };
              await context.emit({ type: 'usage', usage });
            },
            cleanup,
          },
        );
        await flush();
        if (outcome.cancelled) return { status: 'cancelled', usage };
        if (outcome.isError)
          return {
            status: 'failed',
            usage,
            error: {
              code: 'runtime_error',
              message: outcome.message,
              retryable: false,
            },
          };
        return { status: 'completed', finalText: outcome.responseText, usage };
      } finally {
        await appendNormalizedChanges(
          childNormalizer ? await childNormalizer.finish() : [],
        );
      }
    },
    (error) => options.reportError(error),
    { transcriptPort: options.transcriptPort },
  );
}
