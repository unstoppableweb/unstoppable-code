import type { AccountProxyQuotaWait } from '../../account-proxy/quota-wait';
import { ambientSecretDenyRules } from '../../agent-secrets/ambient-env';
import {
  classifyAgentFailure,
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
} from '@canopy/execution-engine/agent-failures';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import { delegationStopSignal } from './stop-signal';
import type { UUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import {
  createClaudeDelegateTools,
  childDelegationGuidance,
} from './child-tools';
import {
  childLedgerGuidance,
  retainChildLedgerTools,
  type ChildLedgerTools,
} from './ledger-tools';
import {
  delegateAppToolGuidance,
  type DelegateCanopyTools,
} from './canopy-tools';
import {
  DELEGATION_STREAM_PREVIEW_LIMITS,
  DelegationTranscriptRecorder,
} from './transcript-recorder';
import {
  query,
  type Query,
  type SDKUserMessage,
  type SpawnedProcess,
  type PermissionResult,
  type HookJSONOutput,
  type McpServerConfig,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { ClaudeInputDelivery } from '../claude-input-delivery';
import { chatInputRefusal } from '@canopy/protocol/remote-control/shell/input-delivery';
import type { AgentDelegationUsage } from '@canopy/protocol/delegation';
import { buildClaudeThinkingOptions } from '@canopy/desktop-shared/types';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
  type LocalDelegationOutcome,
  DelegationRunnerError,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import type { DelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { getBundledClaudeBinaryPath } from '../../pipelines/config-paths';
import { spawnClaudeCodeProcessOffMain } from '../claude-process-host-runner';
import { recordHostedClaudeProcessDiagnostic } from '../claude-process-diagnostics';
import { ClaudeDelegationUsage } from './claude-usage';
import { ChildAppendQueue } from './child-append-queue';
import { DelegationChildNormalizer } from './child-row-normalizers';
import type { DelegationTranscriptChange } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { delegationBlockId } from '@canopy/agent-transcript';
import {
  getClaudeSessionCostLedger,
  readClaudeMainLoopUsage,
  readClaudeRunningTotals,
} from '../../observability/claude-session-cost-ledger';
import {
  DELEGATION_NATIVE_CLAUDE_TOOLS,
  DELEGATION_NATIVE_PRIVATE_PATTERNS,
  delegatedToolDenialReason,
  type DelegationNativePolicy,
} from './native-policy';
import { claudePermissionModeFor } from '../claude-approval-adapter';
import type {
  DelegationCapabilityReloadController,
  DelegationCapabilityReloadHost,
  PendingDelegationCapabilityReload,
} from './capability-reload';

/** Throws the Allowed models refusal for a later provider turn of a run. */
async function refuseDisallowedContinuation(prepared: {
  readonly admitContinuation?: () => Promise<string | undefined>;
}): Promise<void> {
  const refusal = await prepared.admitContinuation?.();
  if (refusal)
    throw new DelegationRunnerError({
      code: 'policy_blocked',
      message: refusal,
      retryable: false,
    });
}

export interface ClaudeDelegationPreparation {
  readonly waitForQuotaRecovery?: AccountProxyQuotaWait;
  /**
   * Allowed models recheck before a later provider turn of this run (after a
   * quota wait or for an undelivered steer). Returns the refusal, if any.
   */
  readonly admitContinuation?: () => Promise<string | undefined>;
  readonly model: string;
  readonly environment: Record<string, string>;
  readonly tools: DelegationNativePolicy;
  readonly plugins?: readonly {
    type: 'local';
    path: string;
    skipMcpDiscovery?: boolean;
  }[];
  readonly skillNames?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /**
   * Selected MCP servers whose tool calls this runner gates directly, the
   * same way it gates every native tool: the PreToolUse hook and
   * `canUseTool` both call `tools.authorizeMcpToolUse(server, tool, input,
   * toolUseId)`, which shares one decision per tool_use, and honour it.
   * These are provider-handled HTTP
   * servers the host transport does not already gate. A server NOT in this
   * list keeps today's behaviour — the hook/`canUseTool` allow it outright
   * because its HTTP proxy session gate or stdio broker gate is the single
   * gate for that server. Absent or empty means every selected server is
   * transport-gated, unchanged from before this field existed.
   */
  readonly providerGatedMcpServers?: readonly string[];
  /** App-owned tools for this run, served beside the delegation tools. */
  readonly appTools?: DelegateCanopyTools;
  /** Marketplace plugins that user/project/local settings enable. The child
   * receives only its Agent's selected plugins, so these are switched off. */
  readonly ambientPluginIds?: readonly string[];
  /**
   * Enables in-run capability reload (capabilities 03, "Reload semantics").
   * When set, a mid-run Load Deferred Tools call records a pending reload on
   * `controller`; once its tool result reaches the model the runner
   * interrupts the current native turn, asks `host` to commit the grant and
   * re-prepare, and resumes the same native session inside this run
   * generation with a hidden continuation. The broker run never sees an
   * extra result and never consumes a retained generation for this.
   */
  readonly capabilityReload?: {
    readonly controller: DelegationCapabilityReloadController;
    readonly host: DelegationCapabilityReloadHost<ClaudeDelegationPreparation>;
  };
}

/** The same filesystem settings a parent chat loads, including CLAUDE.md. */
export const DELEGATED_CLAUDE_SETTING_SOURCES = [
  'user',
  'project',
  'local',
] as const;

function sdkFailureMessage(
  result: SDKResultMessage,
  assistantError: string | undefined,
  hasPartialText: boolean,
): string {
  const detail =
    result.subtype === 'success'
      ? result.result
      : result.errors.filter((error) => error.trim()).join('; ');
  const reason = detail.trim() || assistantError || result.subtype;
  const safeReason = redactSecrets(reason)
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = hasPartialText ? ' Retained partial output is available.' : '';
  const prefix = 'The delegated SDK turn failed: ';
  return `${prefix}${safeReason.slice(0, 4096 - prefix.length - suffix.length)}${suffix}`;
}

function selectedMcpTool(
  name: string,
  servers: Readonly<Record<string, McpServerConfig>>,
): boolean {
  return Object.keys(servers).some((server) => {
    const prefix = `mcp__${server}__`;
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    return Boolean(tool);
  });
}

/**
 * Server/tool identity for a provider-gated MCP call. Splits the flattened
 * `mcp__<server>__<tool>` name against the *known* gated server names,
 * mirroring `approvalCheckForClaudeTool`'s MCP branch
 * (`agents/claude-approval-adapter.ts`) closely enough to share its
 * approval identity and its fail-closed posture: more than one gated server
 * name explaining the same flattened string, or a second `__` surviving
 * inside the derived tool name (the same "server `a` + tool `b__c` / server
 * `a__b` + tool `c`" collision that adapter documents), is reported as
 * `'ambiguous'` and denied rather than resolved either way. A server NOT in
 * `gatedServers` never reaches this function's ambiguity check — it keeps
 * today's transport-gated allow, unaffected by this field's introduction.
 */
function providerGatedMcpTarget(
  name: string,
  gatedServers: readonly string[],
): { server: string; tool: string } | 'ambiguous' | undefined {
  if (!gatedServers.length || !name.startsWith('mcp__')) return undefined;
  const matches = gatedServers.flatMap((server) => {
    const prefix = `mcp__${server}__`;
    return name.startsWith(prefix)
      ? [{ server, tool: name.slice(prefix.length) }]
      : [];
  });
  if (matches.length > 1) return 'ambiguous';
  const match = matches[0];
  if (match && match.tool.includes('__')) return 'ambiguous';
  return match;
}

const AMBIGUOUS_MCP_REASON =
  'Ambiguous MCP server/tool identity; denied by default.';

function managedMessage(message: string): string {
  // The SDK dispatches a leading /name outside the Skill allowlist.
  return message.trimStart().startsWith('/')
    ? `Managed delegated task:\n${message}`
    : message;
}

function isUUID(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** `tool_use` ids this assistant event opens for a tool `isTarget` accepts. */
function toolUseIdsFor(
  event: unknown,
  isTarget: (name: string) => boolean,
): string[] {
  const content = record(record(event)?.message)?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (
      block?.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      isTarget(block.name)
    )
      ids.push(block.id);
  }
  return ids;
}

/** `tool_use_id`s whose `tool_result` this user event carries. */
function toolResultIdsFor(event: unknown): string[] {
  const content = record(record(event)?.message)?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
      ids.push(block.tool_use_id);
  }
  return ids;
}

/** Sums token usage across turns; cost is tracked separately by session delta. */
function sumDelegationUsage(
  a: AgentDelegationUsage,
  b: AgentDelegationUsage,
): AgentDelegationUsage {
  const sum: {
    -readonly [K in keyof AgentDelegationUsage]?: number;
  } = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
  ] as const)
    if (a[key] !== undefined || b[key] !== undefined)
      sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return sum;
}

/** A persistent SDK query with native tools governed by the parent approval session. */
export function createClaudeDelegationRunner(options: {
  available: (route: ResolvedAgentRouteSnapshot) => Promise<RunnerAvailability>;
  prepare: (
    context: LocalDelegationContext,
  ) => Promise<ClaudeDelegationPreparation>;
  reportError: (error: unknown) => void;
  delegation?: (
    context: LocalDelegationContext,
  ) => DelegationParent | undefined;
  /**
   * The Agent Ledger tools for this run, when the Ledger is exposed to it.
   * They ride on the child's host-owned server beside its delegation tools.
   */
  ledger?: (
    context: LocalDelegationContext,
  ) => Promise<ChildLedgerTools | undefined>;
  transcriptPort?: DelegationTranscriptPort;
}): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'claude',
    'claude-sdk',
    options.available,
    async (context): Promise<LocalDelegationOutcome> => {
      let prepared = await options.prepare(context);
      const delegation = options.delegation?.(context);
      if (delegation)
        context.retain(
          () => {
            delegation.detach();
            return Promise.resolve();
          },
          { label: 'delegation-detach', phase: 'parent' },
        );
      const ledger = await retainChildLedgerTools(
        context,
        delegation,
        options.ledger,
      );
      if (context.signal.aborted)
        throw new Error('Delegation cancelled before SDK launch');
      const sessionCostLedger = getClaudeSessionCostLedger();
      await sessionCostLedger.load();
      const controller = new AbortController();
      let stream: Query | undefined = undefined;
      const processes: { process: SpawnedProcess; exited: Promise<void> }[] =
        [];
      const cancel = (): void => {
        controller.abort();
        stream?.close();
        prepared.capabilityReload?.controller.cancel();
        for (const child of processes)
          if (child.process.exitCode === null)
            child.process.kill(delegationStopSignal());
      };
      const cancelAndAwait = async (): Promise<void> => {
        cancel();
        await Promise.all(processes.map((child) => child.exited));
      };
      context.setInterrupt(cancelAndAwait);
      context.retain(cancelAndAwait, {
        label: 'native-process',
        phase: 'native',
      });
      const namespace = delegation?.options.namespace ?? BRAND.tools.namespace;
      const effort = context.request.route.effectiveThinkingLevel;
      if (effort === 'ultra')
        throw new DelegationRunnerError({
          code: 'capability_unavailable',
          message:
            'Ultra orchestration is unavailable in a managed delegated runner.',
          retryable: false,
        });

      const appendChildChanges = context.appendChildChanges;
      const childNormalizer = appendChildChanges
        ? new DelegationChildNormalizer(
            delegationBlockId(
              context.request.delegationId,
              context.request.runGeneration,
            ),
          )
        : undefined;
      // Shared across every provider-turn segment inside this run generation.
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
      let costUsd = 0;
      let hasRecordedCost = false;
      let segmentIndex = 0;
      const withRunCost = (
        tokenUsage: AgentDelegationUsage,
      ): AgentDelegationUsage =>
        hasRecordedCost ? { ...tokenUsage, costUsd } : tokenUsage;
      let lastTranscript = 0;
      const flushTranscript = async (): Promise<void> => {
        const items = transcript.take();
        if (items?.length)
          await context.emit({
            type: 'transcript',
            items,
            truncated: transcript.truncated,
          });
      };
      let priorSegmentsUsage: AgentDelegationUsage = {};
      let usage: AgentDelegationUsage | undefined;
      let nativeSessionId = context.request.resumeSessionId;
      let startedEmitted = false;
      let inputDelivery = new ClaudeInputDelivery(
        `${context.request.delegationId}:${context.request.runGeneration}`,
        () => undefined,
        () => false,
      );
      let outcome: LocalDelegationOutcome | undefined;
      let streamFailure: Error | undefined;
      let nextPrompt = managedMessage(context.request.task.prompt);
      let text = '';

      // SDK compatibility note (capability reload, in-run resume): `prompt`
      // below is always a plain string, never the async-iterable "streaming
      // input" the SDK's own `Query` doc reserves control requests for. Two
      // findings from `@anthropic-ai/claude-agent-sdk`'s `sdk.mjs` make
      // `interrupt()` safe here anyway. First, a string `prompt` only sets
      // the query's internal `isSingleUserTurn` flag, which closes stdin
      // (`transport.endInput()`) when the FIRST `result`-shaped message is
      // read — not before — so stdin is still open when this loop calls
      // `interrupt()` mid-turn, before that turn's own `result` exists.
      // Second, the CLI subprocess is always launched with `--input-format
      // stream-json` regardless of how the JS wrapper represents `prompt`,
      // and `Query.interrupt()`'s own implementation only writes a
      // `control_request` frame to that already-open transport — it has no
      // additional guard tied to how the prompt was supplied. Once the
      // interrupted turn's own result (if any) is read, `isSingleUserTurn`
      // closes stdin and the CLI exits, same as an ordinary completed
      // single-prompt turn ("In single-prompt (non-streaming-input) mode the
      // process exits after the turn" — `SDKResultMessage` doc), which is
      // exactly the shutdown this loop waits for before starting the next
      // segment with `resume`. This was verified by reading the SDK's
      // bundled source; it has not been verified against a live bundled CLI
      // process, so treat it as the documented, not yet field-verified,
      // basis for this design.
      // Keep the provider loop and its post-loop handling inside the row-finalization boundary.
      // prettier-ignore
      try { for (;;) {
        if (context.signal.aborted) break;
        const queryId = `${context.request.delegationId}:${context.request.runGeneration}:${segmentIndex}`;
        segmentIndex += 1;
        const nested = createClaudeDelegateTools({
          namespace,
          ...(delegation ? { delegation } : {}),
          ...(prepared.appTools ? { appTools: prepared.appTools } : {}),
          ...(ledger
            ? {
                ledger,
                // Ledger calls pass the parent's policy, as app tools do.
                authorizeLedger: (
                  tool,
                  readOnly,
                  callId,
                  signal,
                ): Promise<boolean> =>
                  prepared.tools.authorizeAppTool(
                    BRAND.tools.namespace,
                    tool,
                    readOnly,
                    callId,
                    signal,
                  ),
              }
            : {}),
        });
        const selectedMcpServers = prepared.mcpServers ?? {};
        if (
          nested &&
          Object.prototype.hasOwnProperty.call(selectedMcpServers, namespace)
        )
          throw new DelegationRunnerError({
            code: 'capability_unavailable',
            message:
              'A selected Agent MCP server conflicts with managed delegation tools.',
            retryable: false,
          });
        const gatedServers = prepared.providerGatedMcpServers ?? [];
        const privateReads = [
          ...DELEGATION_NATIVE_PRIVATE_PATTERNS.map(
            (pattern) => `Read(${pattern})`,
          ),
          // Every chat's Full-access agent secrets (ambient-env.ts).
          ...ambientSecretDenyRules(),
        ];
        const allowed = prepared.skillNames?.length
          ? [...DELEGATION_NATIVE_CLAUDE_TOOLS, 'Skill']
          : DELEGATION_NATIVE_CLAUDE_TOOLS;

        const queryOptions: Parameters<typeof query>[0] = {
          prompt: nextPrompt,
          options: {
            // The policy's canonical directory: Windows keeps the spelling a
            // process starts with, so an 8.3 short cwd would make Claude's
            // absolute tool paths miss the realpath-based file grants.
            cwd: prepared.tools.cwd,
            model: prepared.model,
            pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
            abortController: controller,
            persistSession: true,
            ...(nativeSessionId ? { resume: nativeSessionId } : {}),
            includePartialMessages: true,
            systemPrompt: {
              type: 'custom',
              prompt: `${prepared.tools.instructions()}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(prepared.appTools, 'claude')}\nFor native file tools, the task path grants above apply. Bash uses the parent's command access and approval policy instead; do not assume it is confined by file-tool grants.${childLedgerGuidance(ledger)}`,
              // A retained follow-up receives fresh staged capability paths.
              // Claude must render this system context again on resume.
              snapshot: false,
            },
            // Project instructions and settings load like a parent chat. MCP
            // stays host-selected: strict config ignores settings-file servers.
            settingSources: [...DELEGATED_CLAUDE_SETTING_SOURCES],
            strictMcpConfig: true,
            skills: [...(prepared.skillNames ?? [])],
            ...(prepared.plugins?.length
              ? {
                  plugins: prepared.plugins.map((plugin) => ({
                    ...plugin,
                    skipMcpDiscovery: true,
                  })),
                }
              : {}),
            tools: allowed,
            allowedTools: [],
            mcpServers: nested
              ? { ...selectedMcpServers, [namespace]: nested.server }
              : selectedMcpServers,
            // Always invoke host hooks for native file checks and parent Bash approvals.
            permissionMode: claudePermissionModeFor('auto', false),
            // Policy-tier `ask` outranks repository allowlists, so a settings
            // file cannot bypass the host permission callback even when it
            // disables hooks. An administrator's managed settings drop this
            // parent tier by default, so the flag tier repeats the same rules.
            managedSettings: {
              permissions: { ask: ['*'], deny: privateReads },
            },
            settings: {
              permissions: { ask: ['*'], deny: privateReads },
              // As Mod admission does: flag-tier env outranks settings-file
              // env, so a plugin folder named there stays off.
              env: { CLAUDE_CODE_PLUGIN_DIRS: '' },
              ...(prepared.ambientPluginIds?.length
                ? {
                    enabledPlugins: Object.fromEntries(
                      prepared.ambientPluginIds.map((id) => [id, false]),
                    ),
                  }
                : {}),
            },
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    async (input, toolUseId): Promise<HookJSONOutput> => {
                      if (input.hook_event_name !== 'PreToolUse')
                        return { continue: true };
                      if (nested?.owns(input.tool_name)) {
                        const bound = nested.bind(
                          input.tool_name,
                          input.tool_input,
                          toolUseId ?? 'native',
                        );
                        return {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: bound.ok ? 'allow' : 'deny',
                            ...(bound.ok
                              ? { updatedInput: bound.value }
                              : {
                                  permissionDecisionReason:
                                    bound.error.message,
                                }),
                          },
                        };
                      }
                      const gatedMcp = providerGatedMcpTarget(
                        input.tool_name,
                        gatedServers,
                      );
                      if (gatedMcp) {
                        // Without a tool_use id to pair with canUseTool, the
                        // hook's check stands alone.
                        const approvedMcp =
                          gatedMcp === 'ambiguous'
                            ? false
                            : toolUseId
                              ? await prepared.tools.authorizeMcpToolUse(
                                  gatedMcp.server,
                                  gatedMcp.tool,
                                  input.tool_input,
                                  toolUseId,
                                )
                              : await prepared.tools.authorizeMcp(
                                  gatedMcp.server,
                                  gatedMcp.tool,
                                  input.tool_input,
                                  'native',
                                );
                        return {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: approvedMcp
                              ? 'allow'
                              : 'deny',
                            ...(approvedMcp
                              ? {}
                              : {
                                  permissionDecisionReason:
                                    gatedMcp === 'ambiguous'
                                      ? AMBIGUOUS_MCP_REASON
                                      : 'Delegated task permissions and parent approval policy',
                                }),
                          },
                        };
                      }
                      // Transport-gated MCP tools are approved by the host
                      // route gate; app-owned tools are approved when they run.
                      if (
                        selectedMcpTool(
                          input.tool_name,
                          selectedMcpServers,
                        ) ||
                        nested?.ownsAppTool(input.tool_name)
                      )
                        return {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'allow',
                          },
                        };
                      const approved = await prepared.tools.authorize(
                        input.tool_name,
                        input.tool_input,
                        toolUseId ?? 'native',
                      );
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: approved ? 'allow' : 'deny',
                          permissionDecisionReason:
                            (!approved &&
                              delegatedToolDenialReason(
                                input.tool_name,
                                input.tool_input,
                              )) ||
                            'Delegated task permissions and parent approval policy',
                        },
                      };
                    },
                  ],
                },
              ],
            },
            ...(effort ? buildClaudeThinkingOptions(effort) : {}),
            env: prepared.environment,
            spawnClaudeCodeProcess: (spawnOptions) => {
              // The SDK normally merges ambient process state. Replace it at the
              // final native boundary with the captured delegation environment.
              const processOwner = {
                sessionKey: context.request.parent.sessionKey,
                delegationId: context.request.delegationId,
              };
              const child = spawnClaudeCodeProcessOffMain(
                {
                  ...spawnOptions,
                  env: { ...prepared.environment },
                },
                {
                  ...processOwner,
                  recordDiagnostic: (diagnostic) =>
                    recordHostedClaudeProcessDiagnostic(
                      { ...processOwner, providerType: 'claude' },
                      diagnostic,
                    ),
                },
              );
              const exited = new Promise<void>((resolve) => {
                child.once('exit', () => resolve());
                child.on('error', options.reportError);
              });
              void exited.catch(options.reportError);
              processes.push({ process: child, exited });
              return child;
            },
            canUseTool: async (
              name,
              input,
              permission,
            ): Promise<PermissionResult> => {
              if (nested?.owns(name) || nested?.ownsAppTool(name))
                return { behavior: 'allow', updatedInput: input };
              // Provider-gated servers are a subset of `selectedMcpServers`,
              // so this check must run before the transport-gated fallback
              // below — otherwise a gated server's own membership in
              // `selectedMcpServers` would let it slip through ungated.
              const gatedMcp = providerGatedMcpTarget(name, gatedServers);
              if (gatedMcp) {
                const approvedMcp =
                  gatedMcp === 'ambiguous'
                    ? false
                    : await prepared.tools.authorizeMcpToolUse(
                        gatedMcp.server,
                        gatedMcp.tool,
                        input,
                        permission.toolUseID,
                      );
                return approvedMcp
                  ? { behavior: 'allow', updatedInput: input }
                  : {
                      behavior: 'deny',
                      message:
                        gatedMcp === 'ambiguous'
                          ? AMBIGUOUS_MCP_REASON
                          : 'This tool is unavailable under the delegated task permissions.',
                    };
              }
              if (selectedMcpTool(name, selectedMcpServers))
                return { behavior: 'allow', updatedInput: input };
              return (await prepared.tools.authorize(
                name,
                input,
                permission.toolUseID,
              ))
                ? { behavior: 'allow', updatedInput: input }
                : {
                    behavior: 'deny',
                    message:
                      delegatedToolDenialReason(name, input) ??
                      'This tool is unavailable under the delegated task permissions.',
                  };
            },
          },
        };
        sessionCostLedger.beginQuery(
          queryId,
          nativeSessionId
            ? { sessionId: nativeSessionId, fork: false }
            : undefined,
        );
        try {
          stream = query(queryOptions);
        } catch (error) {
          sessionCostLedger.endQuery(queryId);
          throw error;
        }
        const activeQuery = stream;

        inputDelivery = new ClaudeInputDelivery(
          `${context.request.delegationId}:${context.request.runGeneration}`,
          () => undefined,
          () => false,
        );
        inputDelivery.setQuery(activeQuery);
        let liveSteering = true;
        const steerMessages = new Map<string, string>();
        context.setInterrupt(cancelAndAwait);
        context.setSteer((request) => {
          const uuid = request.attemptId;
          const sessionId = nativeSessionId;
          if (!liveSteering)
            return Promise.resolve({
              kind: 'rejected' as const,
              attemptId: uuid,
              reason: 'The delegated SDK turn has ended',
              fallback: 'ordinary' as const,
              refusal: chatInputRefusal('turn-ended'),
            });
          if (!isUUID(uuid))
            return Promise.resolve({
              kind: 'rejected' as const,
              attemptId: uuid,
              reason: 'The delegated session cannot correlate this message',
              refusal: chatInputRefusal('not-correlated'),
            });
          // Still starting: nothing is sent, so the run's end can take it.
          if (!sessionId)
            return Promise.resolve({
              kind: 'rejected' as const,
              attemptId: uuid,
              reason: 'The delegated session cannot correlate this message',
              fallback: 'ordinary' as const,
              refusal: chatInputRefusal('not-correlated'),
            });
          // Allowed models: a live steer can start another provider turn on
          // this route, so it is admitted under the policy now.
          const admitted = prepared.admitContinuation
            ? prepared.admitContinuation()
            : Promise.resolve(undefined);
          return admitted.then((policyRefusal) => {
            if (policyRefusal)
              return {
                kind: 'rejected' as const,
                attemptId: uuid,
                reason: policyRefusal,
                refusal: chatInputRefusal('session-not-steerable'),
              };
            if (!liveSteering)
              return {
                kind: 'rejected' as const,
                attemptId: uuid,
                reason: 'The delegated SDK turn has ended',
                fallback: 'ordinary' as const,
                refusal: chatInputRefusal('turn-ended'),
              };
            steerMessages.set(uuid, request.message);
          return inputDelivery.submit(
            request.message,
            request.attemptId,
            request.attemptId,
            () => {
              const input =
                (async function* (): AsyncGenerator<SDKUserMessage> {
                  await Promise.resolve();
                  const steeringMessage: SDKUserMessage = {
                    type: 'user',
                    message: {
                      role: 'user',
                      content: managedMessage(request.message),
                    },
                    parent_tool_use_id: null,
                    uuid,
                    session_id: sessionId,
                  };
                  if (!inputDelivery.claimYield(uuid)) return;
                  yield steeringMessage;
                })();
              void activeQuery.streamInput(input).catch(() => {
                inputDelivery.rejectUnaccepted(
                  uuid,
                  'The delegated SDK could not accept steering input',
                );
              });
            },
          ).then((admission) =>
            // Refused before the SDK reported its steering support, so
            // nothing was enqueued and the run's end can take the message.
            admission.kind === 'rejected' &&
            admission.fallback === undefined &&
            admission.refusal?.code === 'steering-unavailable'
              ? { ...admission, fallback: 'ordinary' as const }
              : admission,
          );
          });
        });

        let lastProgress = 0;
        let assistantError: string | undefined;
        let quotaEvents: unknown[] = [];
        text = '';
        let segmentUsage = new ClaudeDelegationUsage();
        let undeliveredSteers: string[] = [];
        // The result a queued steer continued past, and how many steers had
        // started by then. It stands only if no further turn started.
        let continuedFrom:
          | { outcome: LocalDelegationOutcome; startedSteers: number }
          | undefined;
        const pendingLoadToolUseIds = new Set<string>();
        let deliveredReload: PendingDelegationCapabilityReload | undefined;
        const isLoadDeferredToolsCall = (name: string): boolean =>
          prepared.appTools?.toolForClaudeName(name)?.key ===
          'load_deferred_tools';

        try {
          for await (const event of activeQuery) {
            inputDelivery.observe(event);
            if (context.signal.aborted) break;
            transcript.claude(event);
            await queueNormalizedChanges(
              childNormalizer ? await childNormalizer.claude(event) : [],
            );
            if (transcript.limitExceeded && !childNormalizer) {
              cancel();
              throw new DelegationRunnerError({
                code: 'runtime_error',
                message:
                  'Delegated transcript exceeded the safe retention budget. The native turn was stopped.',
                retryable: false,
              });
            }
            if (
              Date.now() - lastTranscript >= 200 ||
              event.type === 'assistant' ||
              event.type === 'user'
            ) {
              await flushTranscript();
              lastTranscript = Date.now();
            }
            const capturedUsage = segmentUsage.receive(event);
            if (capturedUsage) {
              usage = withRunCost(
                sumDelegationUsage(priorSegmentsUsage, capturedUsage),
              );
              await context.emit({ type: 'usage', usage });
            }
            if (
              event.type === 'result' ||
              (event.type === 'assistant' && event.error)
            )
              quotaEvents = [...quotaEvents, event].slice(-4);
            if (event.type === 'system' && event.subtype === 'init') {
              nativeSessionId = event.session_id;
              if (!startedEmitted) {
                startedEmitted = true;
                await context.emit({
                  type: 'started',
                  nativeSessionId: event.session_id,
                });
              }
            }
            if (
              event.type === 'stream_event' &&
              event.event.type === 'content_block_delta' &&
              event.event.delta.type === 'text_delta'
            ) {
              text = text + event.event.delta.text;
              if (Date.now() - lastProgress >= 200) {
                await context.emit({ type: 'progress', text });
                lastProgress = Date.now();
              }
            }
            if (event.type === 'assistant' && prepared.capabilityReload)
              for (const id of toolUseIdsFor(event, isLoadDeferredToolsCall))
                pendingLoadToolUseIds.add(id);
            if (event.type === 'assistant' && event.error) {
              const detail = event.message.content
                .flatMap((block) =>
                  block.type === 'text' ? [block.text] : [],
                )
                .join(' ');
              assistantError = `${event.error}${detail ? `: ${detail}` : ''}`;
            }
            if (
              event.type === 'user' &&
              prepared.capabilityReload &&
              pendingLoadToolUseIds.size
            ) {
              let loadResultDelivered = false;
              for (const id of toolResultIdsFor(event))
                if (pendingLoadToolUseIds.delete(id))
                  loadResultDelivered = true;
              // The in-process tool handler records the reload under its own
              // call id and never sees the provider's tool_use id, so match
              // by tool instead: once every Load call of this turn has its
              // result, the one pending reload (a second Load in the same
              // turn is refused) has reached the model.
              const reload =
                loadResultDelivered && pendingLoadToolUseIds.size === 0
                  ? prepared.capabilityReload.controller.markDelivered()
                  : undefined;
              if (reload) {
                deliveredReload = reload;
                // Stop this native turn without ending the broker run. See
                // the SDK compatibility note above this loop for why
                // `interrupt()` is safe here even though this segment's
                // `prompt` is a plain string.
                if (typeof activeQuery.interrupt === 'function') {
                  try {
                    await activeQuery.interrupt();
                  } catch (error) {
                    options.reportError(error);
                  }
                } else {
                  activeQuery.close();
                }
              }
            }
            if (event.type === 'result') {
              liveSteering = false;
              const resultRecord = record(event);
              const resultSessionId = resultRecord?.session_id;
              const runningTotals = resultRecord
                ? readClaudeRunningTotals(resultRecord)
                : undefined;
              if (
                resultRecord &&
                typeof resultSessionId === 'string' &&
                resultSessionId.length > 0 &&
                runningTotals
              ) {
                const resultCostUsd = sessionCostLedger.recordResult(queryId, {
                  sessionId: resultSessionId,
                  totals: runningTotals,
                  mainLoopUsage: readClaudeMainLoopUsage(resultRecord),
                  mainModel: prepared.model,
                }).costUsd;
                costUsd = Number((costUsd + resultCostUsd).toFixed(12));
                hasRecordedCost = true;
              }
              const resultUsage: AgentDelegationUsage = {
                inputTokens: event.usage.input_tokens,
                outputTokens: event.usage.output_tokens,
                cachedInputTokens:
                  event.usage.cache_read_input_tokens ?? undefined,
                cacheCreationInputTokens:
                  event.usage.cache_creation_input_tokens ?? undefined,
              };
              usage = withRunCost(
                sumDelegationUsage(priorSegmentsUsage, resultUsage),
              );
              if (text) await context.emit({ type: 'progress', text });
              if (!deliveredReload) {
                outcome =
                  event.subtype === 'success' && !event.is_error
                    ? { status: 'completed', finalText: event.result, usage }
                    : {
                        status: 'failed',
                        usage,
                        error: {
                          code: 'runtime_error',
                          message: sdkFailureMessage(
                            event,
                            assistantError,
                            Boolean(text),
                          ),
                          retryable: false,
                        },
                      };
                // A steer the SDK queued before this result runs as the next
                // turn of the same stream. Keep reading until that turn has
                // its own result instead of stopping the process under it.
                if (inputDelivery.hasPending()) {
                  priorSegmentsUsage = usage;
                  segmentUsage = new ClaudeDelegationUsage();
                  text = '';
                  continuedFrom = {
                    outcome,
                    startedSteers: inputDelivery.startedCount(),
                  };
                  outcome = undefined;
                  liveSteering = true;
                  continue;
                }
                inputDelivery.endTurn();
                break;
              }
              // Interrupted specifically for a capability reload: this
              // result belongs to the stopped turn, not the run. Keep
              // draining without setting `outcome`, so the framework never
              // sees this as the run's one terminal event.
            }
          }
        } catch (error) {
          streamFailure =
            error instanceof Error
              ? error
              : new Error('Delegated SDK stream failed');
        } finally {
          liveSteering = false;
          undeliveredSteers = inputDelivery
            .admittedUnstarted()
            .flatMap((id) => steerMessages.get(id) ?? []);
          inputDelivery.endTurn();
          sessionCostLedger.endQuery(queryId);
        }
        // A steered turn that started but never returned its result ended
        // early, so the result before it no longer stands for the run.
        if (
          !outcome &&
          continuedFrom &&
          inputDelivery.startedCount() === continuedFrom.startedSteers
        )
          outcome = continuedFrom.outcome;
        priorSegmentsUsage = usage ?? priorSegmentsUsage;
        if (text) {
          await context.emit({ type: 'progress', text });
          text = '';
        }
        await flushTranscript();
        if (
          outcome?.status === 'completed' &&
          undeliveredSteers.length &&
          !streamFailure &&
          !context.signal.aborted &&
          nativeSessionId
        ) {
          // The stream ended with an accepted steer that no turn started.
          // Resume the session with it rather than dropping it.
          await refuseDisallowedContinuation(prepared);
          nextPrompt = managedMessage(undeliveredSteers.join('\n\n'));
          outcome = undefined;
          continue;
        }
        if (
          prepared.waitForQuotaRecovery &&
          nativeSessionId &&
          !context.signal.aborted &&
          (streamFailure || outcome?.status === 'failed')
        ) {
          const failure = classifyAgentFailure({
            provider: 'claude',
            accountScope: 'native',
            events: quotaEvents,
            error:
              streamFailure ??
              (outcome?.status === 'failed' ? outcome.error : undefined),
          });
          if (failure?.kind === 'provider_usage_limit') {
            await prepared.waitForQuotaRecovery(failure, context.signal);
            await refuseDisallowedContinuation(prepared);
            outcome = undefined;
            streamFailure = undefined;
            nextPrompt = managedMessage(
              [
                AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
                ...undeliveredSteers,
              ].join('\n\n'),
            );
            continue;
          }
        }
        if (streamFailure || outcome || context.signal.aborted) break;
        if (!deliveredReload) {
          // The turn ended (or the stream closed) without ever seeing a
          // pending reload's tool result delivered. Drop any reload the
          // controller still holds — its Load result never reached the
          // model — and fall through to this run's ordinary "ended before
          // completion" handling below.
          prepared.capabilityReload?.controller.discardUndelivered();
          break;
        }
        // Outside the reload's try, so the refusal keeps its own error code.
        try {
          await refuseDisallowedContinuation(prepared);
        } catch (refused) {
          prepared.capabilityReload?.controller.discardUndelivered();
          throw refused;
        }
        try {
          const capabilityReload = prepared.capabilityReload;
          // `deliveredReload` above is only ever set inside a branch guarded
          // by `prepared.capabilityReload`, and `prepared` has not been
          // reassigned since — this can only fail if that invariant breaks.
          if (!capabilityReload)
            throw new Error(
              'Delegated capability reload host is unavailable',
            );
          const result = await capabilityReload.controller.perform(
            capabilityReload.host,
            context.signal,
          );
          prepared = result.prepared;
          nextPrompt = result.continuation;
        } catch (error) {
          // A cancellation and a failed `restore` both surface here. Local
          // runner overrides the outcome status to cancelled when the abort
          // already happened, so this failure needs no special casing.
          streamFailure =
            error instanceof Error
              ? error
              : new Error('Delegated capability reload failed');
          break;
        }
      }
        prepared.capabilityReload?.controller.discardUndelivered();
        if (streamFailure) throw streamFailure;
        return (
          outcome ?? {
            status: context.signal.aborted ? 'cancelled' : 'failed',
            usage,
            error: {
              code: 'runtime_error',
              message: 'The delegated SDK stream ended before completion.',
              retryable: false,
            },
          }
        );
      } finally {
        if (childNormalizer)
          await appendNormalizedChanges(await childNormalizer.finish());
      }
    },
    options.reportError,
    { transcriptPort: options.transcriptPort },
  );
}
