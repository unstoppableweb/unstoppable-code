import { openOpenCodeExecutionForWorkerRun } from '../../agent-runs/opencode-worker-runtime';
import type { AiCreditsAttribution } from '../ai-credits-routing';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import { snapshotOpenCodeMcpTools } from '../../opencode/capability-snapshot';
import { openCodeMcpCallMatchesSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';
import { validateOpenCodeMcpSchema } from '../../opencode/schema-validation';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import { expandLeadingCursorCommand } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime';
import { openCodeNativeOperations } from '@canopy/desktop-shared/node/opencode/tool-input';
import { openCodeToolDisplay } from '@canopy/desktop-shared/node/opencode/tool-display';
import type { OpenCodeToolInput } from '@canopy/desktop-shared/node/opencode/runtime';
import { ChildAppendQueue } from './child-append-queue';
import { DelegationChildNormalizer } from './child-row-normalizers';
import { delegationBlockId } from '@canopy/agent-transcript';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { assertOpenCodeConnectionGeneration } from '../../opencode/connection';
import {
  buildOpenCodeMcpServers,
  resolveOpenCodeMcpCall,
} from '../../opencode/mcp-servers';
import { getMcpHttpProxyService } from '../../mcp/http-proxy-service';
import { buildCursorCapabilityProjection } from '../../plugins/plugin-resolver';
import type { DelegationNativePolicy } from './native-policy';
import {
  delegateAppToolGuidance,
  type DelegateCanopyTools,
} from './canopy-tools';
import { childDelegationGuidance } from './child-tools';
import {
  DELEGATION_STREAM_PREVIEW_LIMITS,
  DelegationTranscriptRecorder,
} from './transcript-recorder';
import { openCodeDelegationPolicyIdentity } from './opencode-policy';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface OpenCodeDelegationPreparation {
  readonly model: string;
  readonly attribution?: AiCreditsAttribution;
  readonly profileDir: string;
  readonly tools: DelegationNativePolicy;
  /** Private copies of retained capabilities, whose location changes each run. */
  readonly retainedReadRoots?: readonly string[];
  readonly appTools?: DelegateCanopyTools;
  readonly plugins: readonly { path: string }[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

export async function authorizeDelegatedOpenCodeTool(
  input: OpenCodeToolInput,
  tools: DelegationNativePolicy,
  signal: AbortSignal,
): Promise<{ decision: 'allow' | 'deny' }> {
  if (signal.aborted || input.toolName === 'grep' || input.toolName === 'glob')
    return { decision: 'deny' };
  const operations = openCodeNativeOperations(
    input.toolName,
    input.toolArgs,
    tools.cwd,
  );
  if (!operations?.length) return { decision: 'deny' };
  for (const operation of operations) {
    // The child policy resolves shell paths against its captured workspace.
    // Refuse a different native execution directory before consulting saved approvals.
    if (operation.tool === 'Bash' && operation.input.cwd !== tools.cwd)
      return { decision: 'deny' };
    if (
      signal.aborted ||
      !(await tools.authorize(
        operation.tool,
        operation.input,
        input.toolCallId,
      ))
    )
      return { decision: 'deny' };
    if (operation.tool === 'Read') {
      const file = operation.input.file_path;
      if (
        typeof file !== 'string' ||
        !(await lstat(file).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        return { decision: 'deny' };
    }
  }
  return { decision: signal.aborted ? 'deny' : 'allow' };
}

export function createOpenCodeDelegationRunner(options: {
  available(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability>;
  prepare(
    context: LocalDelegationContext,
  ): Promise<OpenCodeDelegationPreparation>;
  delegation?(context: LocalDelegationContext): DelegationParent | undefined;
  reportError(error: unknown): void;
  transcriptPort?: DelegationTranscriptPort;
}): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'opencode',
    'opencode-acp',
    (route) => options.available(route),
    async (context) => {
      const prepared = await options.prepare(context);
      const { request } = context;
      const delegation = options.delegation?.(context);
      if (delegation)
        context.retain(() => {
          delegation.detach();
          return Promise.resolve();
        });
      const interrupted = new AbortController();
      const runtime = await openOpenCodeExecutionForWorkerRun(
        'opencodeDelegationRunner',
        {
          model: request.route.runtimeModelId,
          expectedInferenceBindingKey: request.route.authAccountKey,
          sessionId: `${request.parent.sessionKey}:delegated:${request.delegationId}`,
          cwd: prepared.tools.cwd,
          attribution: () => Promise.resolve(prepared.attribution ?? {}),
          signal: AbortSignal.any([context.signal, interrupted.signal]),
          workspaceId: request.parent.projectId,
          restrictedEnvironment: true,
        },
      );
      context.retain(() => runtime.close());
      context.setInterrupt(() => {
        interrupted.abort();
        return Promise.resolve();
      });
      const signal = runtime.signal;
      await mkdir(prepared.profileDir, { recursive: true, mode: 0o700 });
      const bindingFile = path.join(prepared.profileDir, 'host-session.json');
      if (request.resumeSessionId) {
        const binding: unknown = JSON.parse(
          await readFile(bindingFile, 'utf8'),
        );
        if (
          !record(binding) ||
          binding.version !== 1 ||
          binding.sessionId !== request.resumeSessionId ||
          binding.cwd !== prepared.tools.cwd
        )
          throw new Error('This OpenCode task belongs to another workspace.');
      }
      const notices: string[] = [],
        warnings: string[] = [];
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
      const capabilityRoot = path.join(
        prepared.profileDir,
        'selected-capabilities',
      );
      const selected = await materializeSelectedCapabilityRoot(
        capabilityRoot,
        projection,
      );
      if (notices.length || warnings.length || selected.warnings.length)
        throw new Error(
          'Retained OpenCode capabilities could not be loaded completely.',
        );
      const commands = projection.commands.filter((command) =>
        selected.commandIds.includes(command.id),
      );
      const skillGuidance = projection.skills
        .filter((skill) => selected.skillIds.includes(skill.id))
        .map(
          (skill) =>
            `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(path.join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
        )
        .join('\n');
      const commandGuidance = commands
        .map(
          (command) =>
            `Selected command /${command.id}: ${command.description}\nRead ${JSON.stringify(path.join(capabilityRoot, 'commands', `${command.id}.md`))} for its instructions.`,
        )
        .join('\n');

      const proxy = getMcpHttpProxyService();
      const key = `${request.parent.sessionKey}:opencode-delegate:${request.delegationId}:${request.runGeneration}`;
      const token = randomBytes(32).toString('base64url');
      const namespace = BRAND.tools.namespace;
      const definitions = [
        ...(delegation?.projection.tools ?? []),
        ...(prepared.appTools?.tools ?? []),
      ].map((tool) => {
        if (!isJsonValue(tool.inputSchema))
          throw new Error('Invalid delegated tool schema.');
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
      });
      const check = (): void => {
        signal.throwIfAborted();
        assertOpenCodeConnectionGeneration(runtime.generation);
      };
      context.retain(() => {
        proxy.unregisterCanopyWorktreeSessionRoute(key);
        return Promise.resolve();
      });
      await proxy.registerCanopyWorktreeSessionRoute({
        sessionKey: key,
        projectId: request.parent.projectId,
        worktreeId: request.parent.worktreeId,
        chatId: request.parent.chatId,
        cwd: prepared.tools.cwd,
        sdkSessionId: key,
        providerType: 'opencode',
        toolSurface: 'cursor-acp',
        authToken: token,
        createdAt: Date.now(),
        hookHandler: () => undefined,
        managedDelegation: {
          exclusive: true,
          tools: definitions,
          invoke: async (name, input, transport) => {
            check();
            if (!transport?.requestId)
              return { text: 'Delegated run is unavailable.', isError: true };
            const callId = transport.requestId;
            const appTool = prepared.appTools?.tools.find(
              (tool) => tool.name === name,
            );
            if (appTool && prepared.appTools)
              return prepared.appTools.execute(appTool, input, {
                callId,
                signal,
              });
            if (
              !delegation?.ownsTool(name) ||
              !(await prepared.tools.authorizeAppTool(
                namespace,
                name,
                [
                  'GetDelegateOutput',
                  'InspectDelegate',
                  'ListDelegates',
                ].includes(name),
                callId,
                signal,
              ))
            )
              return { text: `${name} was denied.`, isError: true };
            check();
            const turnId = delegation.options.currentTurn();
            if (!turnId)
              return { text: 'Delegated owner is unavailable.', isError: true };
            const result = await delegation.invokeCursor(name, input, {
              callId,
              turnId,
            });
            return { text: JSON.stringify(result), isError: !result.ok };
          },
        },
      });
      const servers = buildOpenCodeMcpServers({
        definitions: { ...prepared.mcpServers },
        cwd: prepared.tools.cwd,
      });
      servers.push({
        type: 'http',
        name: namespace,
        url: proxy.getCanopyWorktreeMcpUrl(key),
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      });
      const mcpSnapshot = await snapshotOpenCodeMcpTools(
        servers,
        Object.fromEntries(
          servers.map((server) => [
            server.name,
            server.name === namespace
              ? { app: namespace, surface: 'delegation' }
              : {
                  capabilityOverlay:
                    request.route.capabilityOverlay?.capabilityProjectionHash,
                  agentOverlay:
                    request.route.agentOverlay?.pluginProjectionHash,
                  server: server.name,
                },
          ]),
        ),
        prepared.tools.cwd,
        signal,
        true,
      );
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
      const { runOpenCodeTurn } =
        await import('@canopy/desktop-shared/node/opencode/turn-driver');
      let outcome: Awaited<ReturnType<typeof runOpenCodeTurn>>;
      try {
        outcome = await runOpenCodeTurn(
          {
            ...runtime,
            cwd: prepared.tools.cwd,
            profileDir: prepared.profileDir,
            rawModelId: runtime.rawModelId,
            model: request.route.runtimeModelId,
            thinkingLevel:
              request.route.effectiveThinkingLevel !== undefined &&
              runtime.supportedThinkingLevels.length
                ? clampThinkingLevelToDeclared(
                    request.route.effectiveThinkingLevel,
                    runtime.supportedThinkingLevels,
                  )
                : undefined,
            capabilityRoots: [capabilityRoot],
            mcpSnapshot,
            capabilityContext: {
              capabilityOverlay: request.route.capabilityOverlay,
              agentOverlay: request.route.agentOverlay,
              account: request.route.authAccountKey,
              policy: await openCodeDelegationPolicyIdentity(
                prepared.tools,
                prepared.retainedReadRoots ?? [],
                signal,
              ),
              providerSettingsSources: runtime.inferenceRoute
                ? ['host-inference']
                : ['managed-provider-config', 'native-opencode-auth'],
            },
            sessionId: request.resumeSessionId,
            signal,
            prompt: expandLeadingCursorCommand(request.task.prompt, commands),
            instructions: `${prepared.tools.instructions()}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(prepared.appTools, 'opencode')}\n${commandGuidance}\n${skillGuidance}\nRead only specific granted files. Native directory searches, native subagents, background processes, and unselected skills are unavailable. Shell follows the parent's command approval policy; file-tool grants do not sandbox shell commands.`,
            mcpServers: servers,
          },
          {
            authorize: async (input) => {
              check();
              const call = resolveOpenCodeMcpCall(
                input.toolName,
                servers,
                'default',
                definitions.map((tool) => tool.name),
                mcpSnapshot,
              );
              if (
                call &&
                !(await openCodeMcpCallMatchesSnapshot(
                  mcpSnapshot,
                  call.server,
                  call.tool,
                  input.toolArgs,
                  { validate: validateOpenCodeMcpSchema, signal },
                ))
              )
                return { decision: 'deny' };
              check();
              if (call)
                return {
                  decision:
                    call.server === namespace
                      ? definitions.some((tool) => tool.name === call.tool)
                        ? 'allow'
                        : 'deny'
                      : (await prepared.tools.canUseMcp(
                            call.server,
                            call.tool,
                            signal,
                          ))
                        ? 'allow'
                        : 'deny',
                };
              return authorizeDelegatedOpenCodeTool(
                input,
                prepared.tools,
                signal,
              );
            },
            displayTool: (tool) => {
              const call = resolveOpenCodeMcpCall(
                tool.name,
                servers,
                'default',
                definitions.map((tool) => tool.name),
                mcpSnapshot,
              );
              return call
                ? {
                    name: `mcp__${call.server}__${call.tool}`,
                    input: tool.input,
                  }
                : openCodeToolDisplay(tool, prepared.tools.cwd);
            },
            onSession: async (sessionId, snapshot) => {
              const temporary = `${bindingFile}.${randomUUID()}.tmp`;
              try {
                await writeFile(
                  temporary,
                  JSON.stringify({
                    version: 1,
                    sessionId,
                    capabilityDigest: snapshot.digest,
                    resourceGeneration: snapshot.generation,
                    cwd: prepared.tools.cwd,
                  }),
                  { flag: 'wx', mode: 0o600 },
                );
                check();
                await rename(temporary, bindingFile);
              } finally {
                await rm(temporary, { force: true });
              }
              await context.emit({
                type: 'started',
                nativeSessionId: sessionId,
              });
            },
            emit: async (event) => {
              transcript.cursor(event);
              await queueNormalizedChanges(
                childNormalizer ? await childNormalizer.patch(event) : [],
              );
              if (transcript.limitExceeded && !childNormalizer)
                throw new Error(
                  'Delegated OpenCode transcript exceeds retention limits.',
                );
              if (Date.now() - lastTranscript >= 100) {
                lastTranscript = Date.now();
                await flush();
              }
            },
          },
        ).catch((error: unknown) => {
          throw !context.signal.aborted && runtime.failureError
            ? runtime.failureError(error)
            : error;
        });
      } finally {
        await appendNormalizedChanges(
          childNormalizer ? await childNormalizer.finish() : [],
        );
      }
      await flush();
      const usage = outcome.usage
        ? {
            inputTokens: outcome.usage.input_tokens,
            outputTokens: outcome.usage.output_tokens,
            cachedInputTokens: outcome.usage.cache_read_input_tokens,
            cacheCreationInputTokens: outcome.usage.cache_creation_input_tokens,
          }
        : undefined;
      if (usage) await context.emit({ type: 'usage', usage });
      const failure =
        outcome.isError ||
        (outcome.cancelled &&
          !context.signal.aborted &&
          !interrupted.signal.aborted)
          ? runtime.failureError?.(outcome.message, outcome.requestRejected)
          : undefined;
      if (outcome.cancelled && !failure) return { status: 'cancelled', usage };
      if (outcome.isError || failure)
        return {
          status: 'failed',
          usage,
          error: {
            code: 'runtime_error',
            message: failure?.message ?? outcome.message,
            retryable: false,
          },
        };
      return { status: 'completed', finalText: outcome.responseText, usage };
    },
    (error) => options.reportError(error),
    { transcriptPort: options.transcriptPort },
  );
}
