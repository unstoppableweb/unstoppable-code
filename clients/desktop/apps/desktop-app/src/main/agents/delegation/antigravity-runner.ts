import { randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { BRAND } from '@canopy/brand/current';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import { antigravityModelsFromConfig } from '@canopy/execution-engine/lib/antigravity-models';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { isJsonValue } from '@canopy/execution-engine/node/codex-runtime';
import { delegationBlockId } from '@canopy/agent-transcript';
import type { AcpPermissionRequest } from '@canopy/desktop-shared/node/acp';
import { AcpClientError } from '@canopy/desktop-shared/node/acp/errors';
import { antigravityNativeOperation } from '@canopy/desktop-shared/node/antigravity/tool-approval';
import {
  isAntigravityWorkspaceConfigurationError,
  writesAntigravityExecutableConfiguration,
} from '@canopy/desktop-shared/node/antigravity/workspace-configuration';
import { antigravityTokenUsage } from '@canopy/desktop-shared/node/antigravity/usage';
import { ANTIGRAVITY_RUNTIME_VERSION } from '@canopy/desktop-shared/node/antigravity/runtime-metadata';
import { CursorEventProjection } from '@canopy/desktop-shared/node/cursor/events';
import { expandLeadingCursorCommand } from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import {
  DelegationRunnerError,
  LocalDelegationRunner,
  type LocalDelegationContext,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import type { MaterializedCapabilityOverlay } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { DelegationCapabilitySource } from '@canopy/protocol/delegation';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type {
  AntigravityRuntime,
  openAntigravityRuntime,
} from '../../antigravity/runtime';
import { isAntigravityConnectionEnabled } from '../../antigravity/connection';
import {
  getAntigravityConnectionGeneration,
  onAntigravityDisconnect,
} from '../../antigravity/connection-generation';
import {
  ANTIGRAVITY_DELEGATE_MODEL_REQUIRED,
  antigravityDelegateRawModel,
} from '../../antigravity/delegation-admission';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { getMcpHttpProxyService } from '../../mcp/http-proxy-service';
import { buildCursorCapabilityProjection } from '../../plugins/plugin-resolver';
import type { DelegationNativePolicy } from './native-policy';
import {
  delegateAppToolGuidance,
  type DelegateCanopyTools,
} from './canopy-tools';
import { CHILD_LEDGER_TOOLS, childDelegationGuidance } from './child-tools';
import {
  childLedgerGuidance,
  retainChildLedgerTools,
  type ChildLedgerTools,
} from './ledger-tools';
import { ChildAppendQueue } from './child-append-queue';
import { DelegationChildNormalizer } from './child-row-normalizers';
import {
  DELEGATION_STREAM_PREVIEW_LIMITS,
  DelegationTranscriptRecorder,
} from './transcript-recorder';

/**
 * Canopy-delivered capabilities: explicit spawn or Agent selections only.
 * This does not bound what the native runtime discovers in the working
 * directory (CAP-02); admission stays refused until that is enforced.
 */
export interface AntigravityDelegationPreparation {
  readonly profileDir: string;
  readonly tools: DelegationNativePolicy;
  readonly appTools?: DelegateCanopyTools;
  readonly plugins: readonly { path: string }[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

/** Host seams. Production uses the Antigravity runtime and connection consent. */
export interface AntigravityDelegationHost {
  openRuntime(
    input: Parameters<typeof openAntigravityRuntime>[0],
  ): Promise<AntigravityRuntime>;
  connectionEnabled(): Promise<boolean>;
  connectionGeneration(): number;
  /** Notifies each Google disconnect with its new connection generation. */
  onDisconnect(listener: (generation: number) => void): () => void;
}

const productionHost: AntigravityDelegationHost = {
  // Loaded on first launch: the ACP SDK stays out of delegation startup.
  openRuntime: async (input) =>
    (await import('../../antigravity/runtime')).openAntigravityRuntime(input),
  connectionEnabled: () => isAntigravityConnectionEnabled(),
  connectionGeneration: () => getAntigravityConnectionGeneration(),
  onDisconnect: (listener) => onAntigravityDisconnect(listener),
};

export const ANTIGRAVITY_DELEGATE_MCP_UNAVAILABLE =
  'Selected MCP servers are not available for Antigravity delegates yet. Remove them or choose another model.';

export const ANTIGRAVITY_DELEGATE_INHERITED_UNAVAILABLE =
  "Antigravity delegates can't receive capabilities inherited from their parent yet. Choose another model, or start it from a chat without selected capabilities.";

export const ANTIGRAVITY_DELEGATE_HOOKS_UNAVAILABLE =
  'Plugin hooks are not available for Antigravity delegates. Remove the plugin or choose another model.';

/**
 * Canopy delivers an Antigravity child only the capabilities named by its
 * spawn request or its Agent. Inherited, home-captured or mid-run loaded
 * content, hooks and MCP selections refuse before any provider launch,
 * because no complete, qualified snapshot of them exists for this runtime.
 * Native workspace discovery is outside this check (CAP-02).
 */
export function antigravityChildCapabilityRefusal(
  overlay: MaterializedCapabilityOverlay | undefined,
): string | undefined {
  if (!overlay) return undefined;
  const explicit = (source: DelegationCapabilitySource): boolean =>
    source === 'explicit' || source === 'agent';
  if (
    (overlay.homeEntries?.length ?? 0) > 0 ||
    !Object.values(overlay.provenance.roots).every(explicit) ||
    !overlay.provenance.mcpSelections.every(explicit) ||
    !overlay.items.every((item) => explicit(item.source))
  )
    return ANTIGRAVITY_DELEGATE_INHERITED_UNAVAILABLE;
  if (overlay.capabilities.mcpSelections.length > 0)
    return ANTIGRAVITY_DELEGATE_MCP_UNAVAILABLE;
  if (overlay.capabilities.hookDeclarations.length > 0)
    return ANTIGRAVITY_DELEGATE_HOOKS_UNAVAILABLE;
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(message: string): DelegationRunnerError {
  return new DelegationRunnerError({
    code: 'capability_unavailable',
    message,
    retryable: false,
  });
}

/**
 * Native Antigravity tools reach a child only through the shared child
 * policy: exact file reads, file writes within the child's grants, and shell
 * commands in the child's working directory under the parent's command
 * policy. Directory listings, searches, native subagents, browser and every
 * unmapped native tool stay denied.
 */
export async function authorizeDelegatedAntigravityTool(
  request: AcpPermissionRequest,
  tools: DelegationNativePolicy,
  signal: AbortSignal,
): Promise<'allow' | 'deny'> {
  if (signal.aborted || request.signal.aborted) return 'deny';
  const operation = antigravityNativeOperation(request);
  if (!operation) return 'deny';
  // Hooks, MCP and agent configuration written into a discovery folder would
  // run without a host approval: refuse before the shared policy, with no
  // prompt, as the root path does (CAN-6713).
  if (await writesAntigravityExecutableConfiguration(operation, tools.cwd))
    return 'deny';
  const callId = request.request.toolCall.toolCallId;
  const requestSignal = AbortSignal.any([signal, request.signal]);
  if (operation.tool === 'Bash') {
    const cwd = operation.input.cwd;
    // The child policy resolves commands against its captured workspace.
    if (
      cwd !== undefined &&
      (typeof cwd !== 'string' || path.resolve(tools.cwd, cwd) !== tools.cwd)
    )
      return 'deny';
    const allowed = await tools.authorize(
      'Bash',
      { command: operation.input.command },
      callId,
      false,
      requestSignal,
    );
    return allowed && !requestSignal.aborted ? 'allow' : 'deny';
  }
  const allowed = await tools.authorize(
    operation.tool,
    operation.input,
    callId,
    false,
    requestSignal,
  );
  if (!allowed || requestSignal.aborted) return 'deny';
  if (operation.tool === 'Read') {
    const file = operation.input.file_path;
    if (
      typeof file !== 'string' ||
      !(await lstat(path.resolve(tools.cwd, file)).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      return 'deny';
  }
  return requestSignal.aborted ? 'deny' : 'allow';
}

export const ANTIGRAVITY_DELEGATE_NATIVE_SUBAGENT =
  "Antigravity started a native subagent, which delegates can't use. The task was stopped.";

/**
 * Native tools that Antigravity 1.5.1 runs without an ACP permission request,
 * so the host can't refuse them. A child that reports one is stopped after the
 * fact by closing its native runtime. Native work in other process groups can
 * outlive that (CAN-6726). The notification can follow native execution, so
 * this is cleanup, not authorization. None of
 * the child's managed delegation, app or Ledger tools uses these names, and
 * selected MCP servers are refused for children.
 */
const NATIVE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'define_subagent',
  'invoke_subagent',
  'manage_subagents',
  'send_message',
]);

export function isAntigravityNativeSubagentCall(update: unknown): boolean {
  if (!record(update)) return false;
  const inner = record(update.update) ? update.update : update;
  // The tool-call name only, as antigravityNativeOperation reads it: titles
  // and tool inputs are free-form and would stop ordinary calls.
  return (
    (inner.sessionUpdate === 'tool_call' ||
      inner.sessionUpdate === 'tool_call_update') &&
    typeof inner.name === 'string' &&
    NATIVE_SUBAGENT_TOOLS.has(inner.name)
  );
}

interface AntigravityChildBinding {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  readonly runtimeVersion: string;
  readonly model: string;
}

async function readBinding(
  file: string,
): Promise<AntigravityChildBinding | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (
    !record(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.cwd !== 'string' ||
    typeof parsed.runtimeVersion !== 'string' ||
    typeof parsed.model !== 'string'
  )
    return undefined;
  return {
    version: 1,
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    runtimeVersion: parsed.runtimeVersion,
    model: parsed.model,
  };
}

async function writeBinding(
  file: string,
  binding: AntigravityChildBinding,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(binding), {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createAntigravityDelegationRunner(options: {
  available(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability>;
  prepare(
    context: LocalDelegationContext,
  ): Promise<AntigravityDelegationPreparation>;
  delegation?(context: LocalDelegationContext): DelegationParent | undefined;
  ledger?: (
    context: LocalDelegationContext,
  ) => Promise<ChildLedgerTools | undefined>;
  reportError(error: unknown): void;
  transcriptPort?: DelegationTranscriptPort;
  host?: AntigravityDelegationHost;
}): LocalDelegationRunner {
  const host = options.host ?? productionHost;
  // A reporter failure never replaces a run's outcome; it leaves a trace.
  const report = (error: unknown): void => {
    try {
      options.reportError(error);
    } catch (reportFailure) {
      logMainProcessWarn(
        '[antigravity-runner] Error reporting failed',
        reportFailure,
      );
    }
  };
  return new LocalDelegationRunner(
    'antigravity',
    'antigravity-acp',
    (route) => options.available(route),
    async (context) => {
      const { request } = context;
      const generation = host.connectionGeneration();
      const connected = async (): Promise<boolean> =>
        host.connectionGeneration() === generation &&
        (await host.connectionEnabled()) &&
        host.connectionGeneration() === generation;
      const interrupted = new AbortController();
      const signal = AbortSignal.any([context.signal, interrupted.signal]);
      context.setInterrupt(() => {
        interrupted.abort();
        return Promise.resolve();
      });
      const disconnected = (): DelegationRunnerError =>
        new DelegationRunnerError({
          code: 'auth_required',
          message: 'Google was disconnected while this delegate ran.',
          retryable: false,
        });
      // Set once the run must fail: a disconnect, a native subagent stop or a
      // transcript failure. Always one Error instance, so identity holds.
      let updateFailure: Error | undefined;
      // Consent that can't be read is treated as withdrawn, with its own
      // message, since Google may still be connected.
      const unconfirmed = (started: boolean): DelegationRunnerError =>
        new DelegationRunnerError({
          code: 'auth_required',
          message: started
            ? "Google's connection couldn't be confirmed, so this delegate was stopped."
            : "Google's connection couldn't be confirmed, so this delegate didn't start.",
          retryable: false,
        });
      // Records the first failure and stops the native turn; returns the
      // recorded one, so a later failure never replaces it.
      const fail = (error: Error): Error => {
        if (updateFailure === undefined) {
          updateFailure = error;
          interrupted.abort();
        }
        return updateFailure;
      };
      // Stops only runs admitted under an earlier connection, synchronously,
      // so a reconnect and a new spawn are never affected.
      const unsubscribe = host.onDisconnect((retired) => {
        if (
          retired <= generation ||
          updateFailure !== undefined ||
          signal.aborted
        )
          return;
        fail(disconnected());
      });
      context.retain(() => {
        unsubscribe();
        return Promise.resolve();
      });
      // A recorded failure explains any abort it caused, wherever the run is.
      const recorded = (): Error | undefined => updateFailure;
      // The cancellations a recorded failure causes are not separate faults.
      // Transcript storage failures the shared runner reports itself once the
      // run ends, so the run never reports them again.
      const transcriptFailures = new WeakSet<object>();
      const isTranscriptFailure = (error: unknown): boolean =>
        typeof error === 'object' &&
        error !== null &&
        transcriptFailures.has(error);
      // Errors behind a recorded failure that aren't reported separately. The
      // error that ends the run is still reported once by the shared runner,
      // whatever its type, including an expected refusal.
      const isCancellation = (error: unknown): boolean =>
        error === updateFailure ||
        isTranscriptFailure(error) ||
        // Behind a recorded failure, an expected refusal (the launch
        // preflight, MCP or a model the runtime can't use, a mismatched
        // binding) isn't a separate fault; runtime and auth runner errors
        // still are.
        (error instanceof DelegationRunnerError &&
          error.detail.code === 'capability_unavailable') ||
        (signal.aborted && error === signal.reason) ||
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof AcpClientError &&
          (error.code === 'cancelled' || error.code === 'closed'));
      // An error captured while the run was live, before any failure was
      // recorded, can't be a cancellation that failure caused; it is reported
      // whatever its type.
      let liveError: { readonly error: unknown } | undefined;
      try {
        // A consent read that rejects is reported and refuses the launch.
        const admitted = await connected().catch((error: unknown) => {
          report(error);
          throw unconfirmed(false);
        });
        if (!admitted)
          throw new DelegationRunnerError({
            code: 'auth_required',
            message: 'Connect Google in Settings to run this delegate.',
            retryable: false,
          });
        const prepared = await options.prepare(context);
        // External MCP stays unavailable until its schemas are validated and
        // approved by the canonical host path for this native runtime.
        if (Object.keys(prepared.mcpServers).length > 0)
          throw unavailable(ANTIGRAVITY_DELEGATE_MCP_UNAVAILABLE);
        const model = antigravityDelegateRawModel(request.route.runtimeModelId);
        if (!model) throw unavailable(ANTIGRAVITY_DELEGATE_MODEL_REQUIRED);
        const delegation = options.delegation?.(context);
        if (delegation)
          context.retain(() => {
            delegation.detach();
            return Promise.resolve();
          });
        const ledger = await retainChildLedgerTools(
          context,
          delegation,
          options.ledger,
        );
        // A consent read that rejects fails closed: the first one on a live
        // run is reported and recorded, which stops the turn. Once any
        // failure is recorded, or the run is being stopped, it adds nothing.
        const consent = (): Promise<'confirmed' | 'withdrawn' | 'unreadable'> =>
          connected().then(
            (ok) => (ok ? 'confirmed' : 'withdrawn'),
            (error: unknown) => {
              if (updateFailure === undefined && !signal.aborted) {
                report(error);
                fail(unconfirmed(true));
              }
              return 'unreadable';
            },
          );
        const consented = async (): Promise<boolean> =>
          (await consent()) === 'confirmed';
        const check = async (): Promise<void> => {
          const before = recorded();
          if (before) throw before;
          signal.throwIfAborted();
          // A failed check stops the turn, as a disconnect notice does, even
          // when consent can't be confirmed without a notice. Recording it
          // also keeps a trailing notice from adding a second auth failure.
          if (!(await consented())) {
            // A recorded failure explains the check; a stop by the parent
            // stays a cancellation.
            const failure = recorded();
            if (failure) throw failure;
            signal.throwIfAborted();
            throw fail(disconnected());
          }
          const after = recorded();
          if (after) throw after;
          signal.throwIfAborted();
        };

        await mkdir(prepared.profileDir, { recursive: true, mode: 0o700 });
        const bindingFile = path.join(prepared.profileDir, 'host-session.json');
        const cwd = prepared.tools.cwd;
        if (request.resumeSessionId) {
          const binding = await readBinding(bindingFile);
          if (
            !binding ||
            binding.sessionId !== request.resumeSessionId ||
            binding.cwd !== cwd ||
            binding.runtimeVersion !== ANTIGRAVITY_RUNTIME_VERSION ||
            binding.model !== model
          )
            throw unavailable(
              "This Antigravity delegate can't be resumed in this workspace.",
            );
        }

        // Explicit selections are copied into a private root and described by
        // instruction. Unsupported plugin facets refuse instead of being dropped.
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
          throw unavailable(
            'The selected capabilities could not be prepared completely for this Antigravity delegate.',
          );
        const commands = projection.commands.filter((command) =>
          selected.commandIds.includes(command.id),
        );
        const selectedGuidance = [
          ...commands.map(
            (command) =>
              `Selected command /${command.id}: ${command.description}\nRead ${JSON.stringify(path.join(capabilityRoot, 'commands', `${command.id}.md`))} for its instructions.`,
          ),
          ...projection.skills
            .filter((skill) => selected.skillIds.includes(skill.id))
            .map(
              (skill) =>
                `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(path.join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
            ),
        ].join('\n');

        const proxy = getMcpHttpProxyService();
        const key = `${request.parent.sessionKey}:antigravity-delegate:${request.delegationId}:${request.runGeneration}`;
        const token = randomBytes(32).toString('base64url');
        const namespace = BRAND.tools.namespace;
        const ledgerDefinitions =
          ledger === undefined
            ? []
            : CHILD_LEDGER_TOOLS.map((definition) => ({
                name: CANOPY_INJECTED_TOOL_REGISTRY[definition.key].displayName,
                description: definition.description,
                inputSchema: definition.inputSchema,
                key: definition.key,
                readOnly: definition.readOnly,
              }));
        const definitions = [
          ...(delegation?.projection.tools ?? []),
          ...(prepared.appTools?.tools ?? []),
          ...ledgerDefinitions,
        ].map((tool) => {
          if (!isJsonValue(tool.inputSchema))
            throw new Error('Invalid delegated tool schema.');
          // A managed tool sharing a native subagent tool name would be stopped
          // as a native subagent.
          if (NATIVE_SUBAGENT_TOOLS.has(tool.name))
            throw new Error(
              'A delegated tool name collides with a native tool.',
            );
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          };
        });
        const servers: McpServer[] = [];
        if (definitions.length > 0) {
          context.retain(() => {
            proxy.unregisterCanopyWorktreeSessionRoute(key);
            return Promise.resolve();
          });
          // Antigravity 1.5.1 does not ask ACP permission for MCP calls. Every
          // managed call is authorized here, at its host execution.
          await proxy.registerCanopyWorktreeSessionRoute({
            sessionKey: key,
            projectId: request.parent.projectId,
            worktreeId: request.parent.worktreeId,
            chatId: request.parent.chatId,
            cwd,
            sdkSessionId: key,
            providerType: 'antigravity',
            toolSurface: 'antigravity-acp',
            authToken: token,
            createdAt: Date.now(),
            turnSignal: signal,
            hookHandler: () => undefined,
            managedDelegation: {
              exclusive: true,
              tools: definitions,
              invoke: async (name, input, transport) => {
                await check();
                if (!transport?.requestId)
                  return {
                    text: 'Delegated run is unavailable.',
                    isError: true,
                  };
                const callId = transport.requestId;
                const ledgerTool = ledgerDefinitions.find(
                  (tool) => tool.name === name,
                );
                if (ledgerTool && ledger) {
                  if (
                    !(await prepared.tools.authorizeAppTool(
                      namespace,
                      name,
                      ledgerTool.readOnly,
                      callId,
                      signal,
                    ))
                  )
                    return {
                      text: `${name} was denied by the delegated task's approval policy.`,
                      isError: true,
                    };
                  await check();
                  const result = await ledger.execute(ledgerTool.key, input, {
                    invocationId: `${key}:${callId}`,
                    signal,
                  });
                  return {
                    text: result.text,
                    isError: result.isError === true,
                  };
                }
                const appTool = prepared.appTools?.tools.find(
                  (tool) => tool.name === name,
                );
                if (appTool && prepared.appTools) {
                  if (
                    !(await prepared.appTools.authorize(appTool, {
                      callId,
                      signal,
                    }))
                  )
                    return { text: `${name} was denied.`, isError: true };
                  await check();
                  return prepared.appTools.run(appTool, input, {
                    callId,
                    signal,
                  });
                }
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
                await check();
                const turnId = delegation.options.currentTurn();
                if (!turnId)
                  return {
                    text: 'Delegated owner is unavailable.',
                    isError: true,
                  };
                const result = await delegation.invokeCursor(name, input, {
                  callId,
                  turnId,
                });
                return { text: JSON.stringify(result), isError: !result.ok };
              },
            },
          });
          servers.push({
            type: 'http',
            name: namespace,
            url: proxy.getCanopyWorktreeMcpUrl(key),
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
          });
        }

        const sharedAppend = context.appendChildChanges;
        const appendChildChanges = sharedAppend
          ? async (
              changes: readonly DelegationTranscriptChange[],
            ): Promise<void> => {
              try {
                await sharedAppend(changes);
              } catch (error) {
                // Only storage failures become the shared runner's transcript
                // error; a failed receipt emit is still reported here. This
                // relies on transcript sinks never rejecting with a
                // DelegationRunnerError, which none does today.
                if (error instanceof DelegationRunnerError)
                  transcriptFailures.add(error);
                throw error;
              }
            }
          : undefined;
        const childNormalizer = appendChildChanges
          ? new DelegationChildNormalizer(
              delegationBlockId(request.delegationId, request.runGeneration),
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
        const queueChanges = async (
          changes: readonly DelegationTranscriptChange[],
        ): Promise<void> => childAppends?.enqueue(changes);
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
        const eventProjection = new CursorEventProjection(
          'Antigravity delegate output exceeded the local limit.',
          { recognizeCursorErrors: false },
        );
        // Provider updates are serialized so rows and previews keep their order.
        let updates: Promise<void> = Promise.resolve();
        const observe = async (
          event: Record<string, unknown>,
        ): Promise<void> => {
          transcript.cursor(event);
          await queueChanges(
            childNormalizer ? await childNormalizer.patch(event) : [],
          );
          if (transcript.limitExceeded && !childNormalizer)
            throw new Error(
              "This Antigravity delegate's transcript exceeds retention limits.",
            );
          if (Date.now() - lastTranscript >= 100) {
            lastTranscript = Date.now();
            await flush();
          }
        };
        // Set only when the shared policy denied a native tool.
        let denied = false;
        // Set when the approval service failed while the run was still live.
        let approvalFailed = false;
        const routedMcpServerNames = servers.map((server) => server.name);
        let runtime: AntigravityRuntime;
        try {
          runtime = await host.openRuntime({
            cwd,
            profile: path.join(prepared.profileDir, 'native'),
            // The gate and session receive the same host-registered servers.
            // Selected external MCP servers are refused above.
            mcpServerNames: routedMcpServerNames,
            signal,
            owner: {
              kind: 'subagent',
              id: `${request.delegationId}:${request.runGeneration}`.slice(
                0,
                200,
              ),
            },
            onUpdate: (update) => {
              if (signal.aborted || updateFailure !== undefined) return;
              if (isAntigravityNativeSubagentCall(update)) {
                fail(unavailable(ANTIGRAVITY_DELEGATE_NATIVE_SUBAGENT));
                return;
              }
              updates = updates.then(async () => {
                if (signal.aborted || updateFailure !== undefined) return;
                try {
                  const event = eventProjection.update(update);
                  for (const flushed of eventProjection.takeFlushed())
                    await observe(flushed);
                  if (event) await observe(event);
                } catch (error) {
                  fail(
                    error instanceof Error
                      ? error
                      : new Error(
                          "Antigravity delegate output couldn't be processed.",
                        ),
                  );
                }
              });
            },
            onPermission: async (permission) => {
              try {
                await check();
                const decision = await authorizeDelegatedAntigravityTool(
                  permission,
                  prepared.tools,
                  signal,
                );
                await check();
                if (decision === 'deny') denied = true;
                return decision;
              } catch (error) {
                // The tool is denied either way. A failed connection or ownership check
                // is explained by the recorded failure or the final check, so only a
                // failure on a live run is an approval-service fault. It is reported
                // unless consent was withdrawn; a consent read that then fails stops
                // the run separately, so it doesn't hide the approval fault. Only a
                // connected run gives it its own message, not the policy-denial one.
                if (!signal.aborted && updateFailure === undefined) {
                  const state = await consent();
                  if (state !== 'withdrawn') report(error);
                  if (state === 'confirmed') approvalFailed = true;
                }
                return 'deny';
              }
            },
          });
        } catch (error) {
          // The launch preflight refuses repository hooks, MCP and agent
          // configuration before any native process starts; tell the parent
          // why. Only its message is forwarded, never the filesystem error.
          if (isAntigravityWorkspaceConfigurationError(error))
            throw unavailable(error.message);
          throw error;
        }
        context.retain(() => runtime.close());
        const client = runtime.client;
        if (
          client.getInitialization().agentCapabilities?.mcpCapabilities
            ?.http !== true &&
          servers.length > 0
        )
          throw unavailable(
            'This Antigravity runtime does not support delegated tools.',
          );
        const instructions = `${prepared.tools.instructions()}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(prepared.appTools, 'antigravity')}\n${selectedGuidance}\nRead only specific granted files. Native directory listings and searches, native subagents, browser tools, workspace-discovered skills and unselected capabilities are unavailable. Shell follows the parent's command approval policy; file-tool grants do not sandbox shell commands.${childLedgerGuidance(ledger)}`;
        const params = {
          cwd,
          mcpServers: servers,
          _meta: { antigravity: { systemPrompt: { append: instructions } } },
        };
        // Keep ACP loading lazy, and refuse any routing drift before either
        // session operation can deliver the servers to the native runtime.
        const { assertAntigravityMcpServersRouted } =
          await import('@canopy/desktop-shared/node/antigravity/runtime');
        await check();
        assertAntigravityMcpServersRouted(
          params.mcpServers,
          routedMcpServerNames,
        );
        const native = request.resumeSessionId
          ? await client.resumeSession({
              ...params,
              sessionId: request.resumeSessionId,
            })
          : await client.newSession(params);
        const sessionId =
          'sessionId' in native && typeof native.sessionId === 'string'
            ? native.sessionId
            : request.resumeSessionId;
        if (
          !sessionId ||
          (request.resumeSessionId && sessionId !== request.resumeSessionId)
        )
          throw unavailable(
            "Antigravity didn't resume this delegate's session.",
          );
        const entry = antigravityModelsFromConfig(native.configOptions).find(
          (candidate) => candidate.rawModelId === model,
        );
        if (!entry)
          throw unavailable(
            'The selected Google model is unavailable on this account.',
          );
        await client.setSessionConfigOption(
          { sessionId, configId: 'model', value: model },
          signal,
        );
        const thinking = request.route.effectiveThinkingLevel;
        if (thinking && entry.supportedThinkingLevels.length > 0)
          await client.setSessionConfigOption(
            {
              sessionId,
              configId: 'thought_level',
              value: clampThinkingLevelToDeclared(
                thinking,
                entry.supportedThinkingLevels,
              ),
            },
            signal,
          );
        await client.setSessionConfigOption(
          { sessionId, configId: 'mode', value: 'default' },
          signal,
        );
        await check();
        await writeBinding(bindingFile, {
          version: 1,
          sessionId,
          cwd,
          runtimeVersion: ANTIGRAVITY_RUNTIME_VERSION,
          model,
        });
        await context.emit({ type: 'started', nativeSessionId: sessionId });
        let stopReason = 'cancelled';
        let nativeUsage: ReturnType<typeof antigravityTokenUsage> = undefined;
        let primary: { error: unknown } | undefined;
        try {
          await check();
          const result = await client.prompt(
            {
              sessionId,
              prompt: [
                {
                  type: 'text',
                  text: expandLeadingCursorCommand(
                    request.task.prompt,
                    commands,
                  ),
                },
              ],
            },
            // Resource generation of this run's MCP servers; it never changes.
            1,
            signal,
          );
          stopReason = result.stopReason;
          nativeUsage = antigravityTokenUsage(result.usage);
        } catch (error) {
          if (updateFailure === undefined && !signal.aborted) {
            primary = { error };
            liveError = { error };
          } else if (!isCancellation(error)) report(error);
        }
        // Drain recorded output. A cleanup failure never replaces the error that
        // ended the run; it is reported instead.
        try {
          await updates;
          for (const event of eventProjection.finish()) await observe(event);
          await childAppends?.flush(
            childNormalizer ? await childNormalizer.finish() : [],
          );
          await flush();
        } catch (cleanupError) {
          if (primary === undefined && updateFailure === undefined) {
            primary = { error: cleanupError };
            // The error still ends the run as its primary error, but only a run
            // that was still live captures it as a live error to report.
            if (!signal.aborted) liveError = { error: cleanupError };
          } else if (!isCancellation(cleanupError)) report(cleanupError);
        }
        if (primary !== undefined) throw primary.error;
        const drained = recorded();
        if (drained) throw drained;
        const usage = nativeUsage
          ? {
              inputTokens: nativeUsage.input_tokens,
              outputTokens: nativeUsage.output_tokens,
              cachedInputTokens: nativeUsage.cache_read_input_tokens,
              cacheCreationInputTokens: nativeUsage.cache_creation_input_tokens,
            }
          : undefined;
        if (usage) await context.emit({ type: 'usage', usage });
        const late = recorded();
        if (late) throw late;
        if (stopReason === 'cancelled' || signal.aborted)
          return { status: 'cancelled', usage };
        const text = eventProjection.getResponseText();
        if (stopReason !== 'end_turn')
          return {
            status: 'failed',
            usage,
            error: {
              code: 'runtime_error',
              message:
                stopReason === 'refusal'
                  ? 'Google declined this delegated task.'
                  : `Google ended the delegated task with ${stopReason}.`,
              retryable: false,
            },
          };
        // With partial text the run completes; a denied or failed tool only turns
        // an empty answer into a failure.
        if (!text.trim() && approvalFailed)
          return {
            status: 'failed',
            usage,
            error: {
              code: 'runtime_error',
              message:
                "Google couldn't complete this task because the approval check for a requested tool failed.",
              retryable: false,
            },
          };
        if (!text.trim() && denied)
          return {
            status: 'failed',
            usage,
            error: {
              code: 'runtime_error',
              message:
                "Google couldn't complete this task because a requested tool was denied by the approval policy.",
              retryable: false,
            },
          };
        // Output produced after consent was withdrawn is not a success.
        await check();
        return { status: 'completed', finalText: text, usage };
      } catch (error) {
        const failure = recorded();
        if (failure === undefined) throw error;
        // The recorded failure explains the run. An error captured while the
        // run was live, or any other error that isn't a cancellation the
        // failure caused, is reported rather than dropped. A transcript
        // storage failure is left to the shared runner, which reports it.
        if (
          ((liveError !== undefined && error === liveError.error) ||
            !isCancellation(error)) &&
          !isTranscriptFailure(error)
        )
          report(error);
        throw failure;
      }
    },
    report,
    { transcriptPort: options.transcriptPort },
  );
}
