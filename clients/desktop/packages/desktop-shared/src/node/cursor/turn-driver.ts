import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { McpServer, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { CursorReportedUsage } from '@canopy/agent-transcript/lib/cursor-usage';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type { CanopyInjectedToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  parseCursorMcpToolCall,
  resolveCursorCanopyToolKey,
  type CursorMcpToolCall,
} from '../../lib/cursor-mcp-tool-call';
import {
  CURSOR_THOUGHT_LEVEL_CATEGORY,
  cursorConfigOptionValue,
  cursorConfigOptionValues,
  parseCursorModelVariant,
  planCursorThinking,
  type CursorConfigSet,
} from '@canopy/execution-engine/lib/cursor-thinking';
import { AcpClientError, connectAcp, type AcpClient } from '../acp';
import { isTransientAcpFailure } from './acp-failure';
import {
  CursorEventProjection,
  CursorProjectionLimitError,
  type CursorTerminalAction,
  type CursorToolInvocation,
} from './events';
import { buildCursorHookCommand } from './hook-command';
import {
  createCursorHookTransport,
  CURSOR_HOOK_SCRIPT,
  type CursorHookDecision,
  type CursorHookOutcome,
  type CursorHookTransport,
} from './hook-transport';
import {
  assertCursorHookPathBudget,
  encodeCursorProjectDir,
} from './project-dir';
import { rewriteCursorShellInput } from './rtk-rewrite';
import type { ProviderProcess } from '../provider-process/spawn';
import type { CursorLaunch } from './runtime-launch';
import type { CursorProviderProcess } from './runtime-process';
import { createCursorUsageHook, CURSOR_USAGE_HOOK_SCRIPT } from './usage-hook';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

const CURSOR_HOOK_SPAWN_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENAMETOOLONG',
]);

function hookSpawnFailureMessage(output: unknown): string | undefined {
  if (
    !isRecord(output) ||
    typeof output.error !== 'string' ||
    output.error.length > 16_384
  )
    return undefined;
  // This is diagnostic evidence only, never approval evidence. Keep the
  // provider's paths, command arguments and possible callback secrets out of
  // the message; only a bounded, known OS code reaches the user.
  const error = output.error;
  const spawn = ' execution failed: spawn ';
  for (const line of error.split(/[\r\n]/)) {
    const hook = /\bHook /.exec(line);
    if (!hook) continue;
    const script = line.indexOf(
      'approval-hook.cjs',
      hook.index + hook[0].length,
    );
    if (script < 0) continue;
    const failure = line.indexOf(spawn, script + 'approval-hook.cjs'.length);
    if (failure < 0) continue;
    const detail = line.slice(failure + spawn.length).trimEnd();
    const separator = detail.lastIndexOf(' ');
    if (separator <= 0) continue;
    const code = detail.slice(separator + 1);
    if (CURSOR_HOOK_SPAWN_CODES.has(code)) {
      return `Couldn't start Cursor's approval check (${code}), so the session was stopped. Report this error or choose another model.`;
    }
  }
  return undefined;
}

/**
 * Observed with pinned 2026.09.08-6caf4ff: Grep {} is rejected by argument
 * validation before execution/preToolUse, but ACP calls it "completed".
 * Recognize only that exact rejection after its empty pending announcement.
 * An arbitrary failed call, error string, or started execution is not proof
 * that approval was unnecessary. Expand this only with native runtime evidence.
 */
function isEmptyGrepValidationRejection(update: {
  status?: unknown;
  title?: unknown;
  kind?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: unknown;
}): boolean {
  return (
    update.status === 'completed' &&
    (update.title === undefined || update.title === 'grep') &&
    (update.kind === undefined || update.kind === 'search') &&
    (update.rawInput === undefined || isEmptyRecord(update.rawInput)) &&
    isRecord(update.rawOutput) &&
    Object.keys(update.rawOutput).length === 1 &&
    update.rawOutput.error === 'Invalid arguments:\npattern: Required' &&
    update.content === undefined &&
    update.locations === undefined
  );
}

/**
 * Every actual tool completion needs evidence that an approval gate saw the
 * invocation, including reads, searches and fetches. Only ACP notifications
 * are exempt. This rule is shared by interactive, headless and delegated turns.
 *
 * A native hook observation records that policy saw the call, even if it denied
 * it. This backstop detects missing evidence after completion; it cannot undo
 * an operation or replace a pre-execution gate when the runtime omits one.
 */
const NON_TOOL_NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  'think',
  'switch_mode',
]);

/** Key-order-independent identity of a native tool input for hook correlation. */
function fingerprint(input: unknown): string {
  if (!isRecord(input)) return JSON.stringify(input ?? null);
  return JSON.stringify(
    Object.keys(input)
      .sort()
      .map((key): [string, unknown] => [key, input[key]]),
  );
}

interface ShellHookObservation {
  input: Record<string, unknown>;
  updatedInput?: Record<string, unknown>;
}

/** ACP omits Shell's cwd/timeout. Compare every field it actually reports. */
function matchesShellHookInput(
  input: unknown,
  observed: Record<string, unknown>,
): boolean {
  return (
    isRecord(input) &&
    typeof input.command === 'string' &&
    input.command.trim().length > 0 &&
    Object.entries(input).every(
      ([key, value]) =>
        (key === 'command' || key === 'cwd' || key === 'timeout') &&
        value === observed[key],
    )
  );
}

/**
 * Identity of an app MCP tool call as both the ACP permission request and the
 * HTTP route see it: the canonical tool key plus the raw arguments the CLI
 * forwards unchanged from the model.
 */
function appToolCallIdentity(
  key: CanopyInjectedToolKey,
  args: unknown,
): string {
  return `app\n${key}\n${fingerprint(isRecord(args) ? args : {})}`;
}

/** Identity of a plugin or standalone MCP tool call, as above. */
function pluginCallIdentity(
  server: string,
  tool: string,
  args: unknown,
): string {
  return `plugin\n${server}\n${tool}\n${fingerprint(isRecord(args) ? args : {})}`;
}

export interface CursorTurnGates {
  /** Consume one ACP allowance for this call identity, if any. */
  consumeAllowance(identity: string): boolean;
  /** Record a decision the host's own gate made for a call the CLI never asked about. */
  recordGateDecision(identity: string, decision: 'allow' | 'deny'): void;
  appToolCallIdentity(key: CanopyInjectedToolKey, args: unknown): string;
  pluginCallIdentity(server: string, tool: string, args: unknown): string;
  /** Stop the turn (integrity failure, policy stop). */
  abort(): void;
  /**
   * The turn's own signal: aborted by the caller's signal, by an integrity
   * stop, and by `abort()`. Host-owned gates registered for this turn must
   * read it so a stopped turn cannot authorize another call.
   */
  signal: AbortSignal;
}

export interface CursorTurnMcpSetup {
  servers: McpServer[];
  /** Once-per-session notes about servers that did load. */
  notes: string[];
  /** Once-per-session limits (selections Cursor cannot load). */
  notices: string[];
  /** True when the app's own main MCP server reached the CLI. */
  appToolsAvailable: boolean;
  pluginServerNames: string[];
}

/** RTK rewriting of allowed Shell commands. */
export interface CursorTurnRtk {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
}

export interface CursorTurnHost {
  clientName: string;
  /** Host-only; the driver never branches on it — hosts apply plan mode in authorizeNative/authorizeMcp and beforePrompt. */
  planMode: boolean;
  /** Hook payload policy. The driver records anchors around it. */
  authorizeNative(
    payload: unknown,
    context: { signal: AbortSignal },
  ): Promise<CursorHookOutcome>;
  /** ACP permission for an MCP call on a server this turn handed the CLI. */
  authorizeMcp(
    call: CursorMcpToolCall,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<CursorHookDecision>;
  /** Called after initialize; returns the complete MCP set for session/new|load. */
  prepareMcp(
    capabilities: { http?: boolean; sse?: boolean } | undefined,
    gates: CursorTurnGates,
  ): Promise<CursorTurnMcpSetup>;
  /** Called after the model is selected and before the prompt. */
  beforePrompt(context: {
    sessionId: string;
    contextLost: boolean;
    mcp: CursorTurnMcpSetup;
    announce: (text: string) => void;
  }): Promise<{ instructions: string; inheritedContext?: string }>;
  /** Every projected chat event, including `system`/`init`. */
  emit(event: Record<string, unknown>): void | Promise<void>;
  /** Host-only notification before the corresponding transcript patch is emitted. */
  onToolInvocation?(invocation: CursorToolInvocation): void;
  onUsage?(usage: CursorReportedUsage): void | Promise<void>;
  /**
   * The complete command and skill set the CLI advertises for the session.
   * The pinned CLI sends it right after `session/new`, before the driver has
   * selected the model, so it is delivered from every phase of the turn.
   */
  onAvailableCommands?(names: string[]): void;
  /**
   * Resolved per allowed Shell command rather than once per turn, because the
   * RTK preference can be toggled while a turn is running. Return `undefined`
   * to leave RTK out of this call.
   */
  rtk?(): CursorTurnRtk | undefined;
  /**
   * The native tool callback was revoked (cancellation, a policy stop, or a
   * dead hook connection). Hosts invalidate pending prompt work here.
   */
  onRevoked?(): void;
  /**
   * Called when the driver discards the session id it was given because the
   * saved context could not be loaded, BEFORE a replacement exists.
   *
   * Hosts publish the live session id for mid-turn readers (see
   * `getProviderSessionId` consumers in `ipc/chat.ts` and
   * `lib/worktree-chat-turn.ts`, which feed it back as `sdkSessionId`).
   * Without this, a host kept advertising the ORPHANED id for the two ACP
   * round-trips between the failed load and `beforePrompt`, so a deferred
   * capability load landing in that window could resume against a session
   * that is known to be gone. Clearing at the moment of loss is what develop
   * did before the driver was extracted; this restores it.
   */
  onSessionCleared?(): void;
  onPromptAccepted?(): void;
  /**
   * The failure message when a turn exceeds the projection bound. Defaults to
   * the chat wording; a pipeline step is not a chat.
   */
  projectionLimitMessage?: string;
  /**
   * Configured values to mask in streamed assistant and thought text before
   * it is emitted. A value can span several deltas, and each delta is its own
   * emitted record, so only the projection that owns the block boundaries can
   * mask it. Interactive chat configures none.
   */
  secretValues?: readonly string[];
  /** Runs in `finally`, before the process group is drained. */
  cleanup?(): Promise<void>;
}

export interface CursorTurnRequest {
  cwd: string;
  text: string;
  launch: CursorLaunch;
  /** How this turn starts its CLI child (CAN-4118). Electron main passes the provider process host. */
  providerProcess: CursorProviderProcess;
  env: NodeJS.ProcessEnv;
  /** Verified Node executable used for hook scripts (see `target.hookRuntime`). */
  hookRuntime: string;
  /** CURSOR_DATA_DIR for this conversation; created if missing. */
  profileDir: string;
  rawModelId: string;
  /** Host-facing model identity reported in the `system`/`init` event. */
  model?: string;
  /**
   * Thinking level to run at, resolved against the selected model's
   * `thought_level` options before prompting. Omitted: the variant's own
   * parameters apply, as they always did.
   */
  thinkingLevel?: ThinkingLevel;
  sessionId?: string;
  /**
   * Refuse the turn outright when `sessionId` cannot be loaded, instead of
   * silently starting a fresh conversation in its place.
   *
   * Interactive chat normally uses the fallback: a repo or data-dir change orphans
   * the saved session, and failing every later turn of that chat would be
   * worse than continuing without the old context. A Windows chat requires its
   * saved session for the first load after profile relocation. A pipeline
   * `builtin/agent-resume` step wants the opposite — its prompt is written
   * assuming the prior context exists, so running it against an empty
   * session does real work (with whatever permissions the step declared)
   * before anyone can notice the context is gone. Checking `contextLost`
   * after the turn is too late; the step must fail before it prompts.
   */
  requireExistingSession?: boolean;
  signal: AbortSignal;
  promptTimeoutMs?: number | null;
}

/**
 * A stop the driver discovered itself (CAN-7117): a tool that completed
 * without reaching the approval gate, the projection's output bound, or a
 * failure projecting or delivering an update to the host.
 */
export type CursorTurnFailureKind =
  | 'unapproved_tool'
  | 'output_limit'
  | 'event_delivery';

export interface CursorTurnResult {
  sessionId?: string;
  isError: boolean;
  cancelled: boolean;
  message: string;
  /** Redacted ACP explanation for Copy details, separate from the headline. */
  providerErrorDetails?: string;
  stopReason?: string;
  contextLost: boolean;
  integrityFailure?: string;
  /** Why the driver stopped the turn itself, set with `integrityFailure`. */
  failureKind?: CursorTurnFailureKind;
  /**
   * The error behind an `event_delivery` or `output_limit` stop, for local
   * logs only. Non-enumerable, so neither spreading nor serializing the
   * result carries it (CAN-7117).
   */
  readonly runtimeCause?: unknown;
  /** The account change Cursor asked for when it refused the turn. */
  actionRequired?: CursorTerminalAction;
  /** True when `inheritedContext` was sent and the turn ended normally. */
  inheritedContextDelivered: boolean;
  /** Concatenated assistant response text from the projection. */
  responseText: string;
}

/**
 * One Cursor ACP turn: spawn the pinned runtime, stand up the authenticated
 * hook callbacks, open or resume the CLI conversation, select the model, send
 * the prompt, and drain the process group. Policy, MCP wiring, prompt
 * composition, and event delivery belong to the host; this owns only the
 * lifecycle and the integrity anchor that ties every tool completion back to a
 * gate the host decided.
 */
export async function runCursorTurn(
  request: CursorTurnRequest,
  host: CursorTurnHost,
): Promise<CursorTurnResult> {
  let sessionId = request.sessionId;
  let child: ProviderProcess | undefined;
  let closePromise: Promise<void> | undefined;
  let client: AcpClient | undefined;
  let hook: CursorHookTransport | undefined;
  let usageHook: CursorHookTransport | undefined;
  let hookDir: string | undefined;
  const projection = new CursorEventProjection(host.projectionLimitMessage, {
    secretValues: host.secretValues,
    onToolInvocation: (invocation): void => host.onToolInvocation?.(invocation),
  });
  // Native Read/Write reach policy only through the preToolUse hook, and
  // ACP consent merely advances Shell to that same hook. Remember every
  // tool call the hook observed so a write-capable completion that never
  // reached the hook (a hook-discovery mismatch would execute with no
  // Canopy gate) stops the session instead of passing silently. Read/Write
  // carry the tool id. Shell generates a separate hook id and ACP exposes
  // only its command, so each Shell observation is matched and consumed
  // separately; a repeated id or input must not authorize another call.
  // Consumed, not just remembered: a hook observation authorizes exactly the
  // one invocation it was made for. Keeping it as a set meant a runtime that
  // reuses a tool id got every later, unhooked completion on that id exempted
  // too. Each record carries its id and its input fingerprint, and whichever
  // matcher uses it consumes both, so a stale alias cannot authorize a later
  // call either.
  const nativeHookObservations: { id?: string; inputFingerprint: string }[] =
    [];
  // Completions already accepted by one of the gates, so a duplicate report
  // of the same call does not consume a second observation. Keyed BY TOOL CALL
  // ID, because a new invocation of a reused id has to start with nothing
  // inherited — see the `tool_call` reset in `onUpdate`.
  const settledCompletions = new Map<string, Set<string>>();
  // These are validation failures, never approvals. Keep them separate from
  // settled completions so a later success cannot inherit a rejection.
  const emptyPendingGrepCalls = new Set<string>();
  const shellHookObservations: ShellHookObservation[] = [];
  // MCP tool calls never reach the native hook: their only gate is the
  // ACP permission request. An allowed call is exempt from the hook
  // anchor; a denied call is exempt only when it fails, so a CLI that
  // ignored the denial and completed the call still stops the session.
  const acpDecidedIds = new Map<string, 'allow' | 'deny'>();
  // The ACP permission request is advisory: a CLI may skip it. The proxy
  // therefore re-checks every app tool call (WatchCommand runs a shell
  // command; DispatchAction can run pipelines; SaveMemory and the rest
  // change app state) and every tools/call on the HTTP-proxied plugin and
  // standalone routes at execution time, except a call this turn already
  // allowed over ACP, which passes exactly once per allowance. Stdio
  // servers are launched by Cursor itself, so for them the permission
  // request is the only gate and the integrity anchor the backstop.
  const acpAllowedCalls = new Map<string, number>();
  // Decisions the app's own gates made for calls the CLI never asked
  // about. The pinned CLI has been observed running an MCP tool with no
  // permission request, so the integrity anchor must accept a completion
  // the gate allowed (or denied, when the call then failed) instead of
  // stopping the session for a call this app itself authorized.
  const gateDecidedCalls = new Map<string, ('allow' | 'deny')[]>();
  const recordGateDecision = (
    identity: string,
    decision: 'allow' | 'deny',
  ): void => {
    gateDecidedCalls.set(identity, [
      ...(gateDecidedCalls.get(identity) ?? []),
      decision,
    ]);
  };
  const takeGateDecision = (identity: string): 'allow' | 'deny' | undefined => {
    const decisions = gateDecidedCalls.get(identity);
    const decision = decisions?.shift();
    if (decisions && decisions.length === 0) gateDecidedCalls.delete(identity);
    return decision;
  };
  const allowCall = (identity: string): void => {
    acpAllowedCalls.set(identity, (acpAllowedCalls.get(identity) ?? 0) + 1);
  };
  const consumeAllowance = (identity: string): boolean => {
    const remaining = acpAllowedCalls.get(identity);
    if (!remaining) return false;
    if (remaining === 1) acpAllowedCalls.delete(identity);
    else acpAllowedCalls.set(identity, remaining - 1);
    return true;
  };
  // Only servers this turn actually handed the CLI may ask for permission;
  // a request naming any other server is denied and keeps its anchor.
  const knownMcpServerNames = new Set<string>();
  const integrity: {
    failure?: string;
    kind?: CursorTurnFailureKind;
    cause?: unknown;
  } = {};
  /** Set when the child process itself failed (spawn error), so the catch
   * below can tell a real failure from a cancellation. */
  let childFailure: Error | undefined;
  let contextLost = false;
  let inheritedContextDelivered = false;
  // The caller owns turn cancellation; the driver owns the stops it discovers
  // itself (a policy stop, an integrity failure) and must be able to reach
  // every gate the host registered for this turn.
  const abort = new AbortController();
  const forwardAbort = (): void => abort.abort();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener('abort', forwardAbort, { once: true });
  const gates: CursorTurnGates = {
    consumeAllowance,
    recordGateDecision,
    appToolCallIdentity,
    pluginCallIdentity,
    abort: (): void => abort.abort(),
    signal: abort.signal,
  };
  function closeChild(): Promise<void> {
    closePromise ??= child ? child.stop() : Promise.resolve();
    return closePromise;
  }
  const revoke = (): void => {
    hook?.revoke();
    if (client && sessionId) void client.cancel(sessionId).catch(() => {});
    client?.close();
    void closeChild();
  };
  abort.signal.addEventListener('abort', revoke, { once: true });
  const result = async (
    partial: Omit<CursorTurnResult, 'responseText'>,
  ): Promise<CursorTurnResult> => {
    // Read before awaiting: `partial` was built from `integrity` in this same
    // tick, and a late update must not pair its error with this kind.
    const cause = partial.failureKind ? integrity.cause : undefined;
    // However the turn ended, text the projection is still holding back is
    // the provider's output: release it (masked) rather than drop it.
    for (const event of projection.finish()) await host.emit(event);
    const ended: CursorTurnResult = {
      ...partial,
      responseText: projection.getResponseText(),
    };
    if (cause !== undefined)
      Object.defineProperty(ended, 'runtimeCause', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: cause,
      });
    return ended;
  };
  try {
    assertCursorHookPathBudget(request.profileDir, request.cwd);
    await mkdir(request.profileDir, { recursive: true, mode: 0o700 });
    hookDir = await mkdtemp(join(tmpdir(), 'cursor-chat-hook-'));
    if (host.onUsage) {
      usageHook = await createCursorUsageHook(
        () => (abort.signal.aborted ? undefined : sessionId),
        (usage) => host.onUsage?.(usage),
      ).catch(() => undefined);
    }
    hook = await createCursorHookTransport(
      async (payload) => {
        // Record only native payloads the authorizer inspects: an absent
        // or empty input would otherwise satisfy the fallback for any
        // completion whose input the projection has not seen yet, and an
        // MCP payload (`MCP:<tool>`, hook-only id, tool arguments as the
        // input) never corresponds to a native completion.
        if (
          isRecord(payload) &&
          isRecord(payload.tool_input) &&
          Object.keys(payload.tool_input).length > 0 &&
          payload.tool_name !== 'Shell' &&
          !(
            typeof payload.tool_name === 'string' &&
            payload.tool_name.startsWith('MCP:')
          )
        ) {
          nativeHookObservations.push({
            ...(typeof payload.tool_use_id === 'string' && payload.tool_use_id
              ? { id: payload.tool_use_id }
              : {}),
            inputFingerprint: fingerprint(payload.tool_input),
          });
        }
        const outcome = await host.authorizeNative(payload, {
          signal: abort.signal,
        });
        let shellObservation: ShellHookObservation | undefined;
        if (
          isRecord(payload) &&
          payload.hook_event_name === 'preToolUse' &&
          payload.tool_name === 'Shell' &&
          typeof payload.tool_use_id === 'string' &&
          payload.tool_use_id.length > 0 &&
          isRecord(payload.tool_input) &&
          typeof payload.tool_input.command === 'string' &&
          payload.tool_input.command.trim().length > 0
        ) {
          // The pinned CLI also reports rejected native calls as completed.
          // This records reaching the gate; the hook owns Allow/Deny/Stop.
          shellObservation = { input: payload.tool_input };
          shellHookObservations.push(shellObservation);
        }
        if (outcome.stopTurn) abort.abort();
        if (
          outcome.decision !== 'allow' ||
          outcome.stopTurn ||
          abort.signal.aborted
        )
          return outcome;
        const rtk = host.rtk?.();
        if (!rtk) return outcome;
        // Policy has judged the command Cursor proposed; RTK only swaps in
        // the bundled wrapper for execution, exactly as the Claude hook
        // does. The CLI may report the rewritten input on completion, so
        // anchor that shape too.
        const updatedInput = await rewriteCursorShellInput(payload, {
          rtkBinaryPath: rtk.binaryPath,
          env: rtk.env,
          signal: abort.signal,
        });
        if (!updatedInput) return outcome;
        if (shellObservation) shellObservation.updatedInput = updatedInput;
        return { ...outcome, updatedInput };
      },
      () => host.onRevoked?.(),
    );
    const script = join(hookDir, 'approval-hook.cjs');
    const connection = join(hookDir, 'connection.json');
    const usageScript = join(hookDir, 'usage-hook.cjs');
    const usageConnection = join(hookDir, 'usage-connection.json');
    await Promise.all([
      writeFile(script, CURSOR_HOOK_SCRIPT, { mode: 0o600 }),
      writeFile(
        connection,
        JSON.stringify({ url: hook.url, token: hook.token }),
        { mode: 0o600 },
      ),
    ]);
    if (usageHook) {
      // Telemetry is optional. Wait for both writes before releasing the
      // listener so a failed write cannot race turn-directory cleanup.
      const usageFiles = await Promise.allSettled([
        writeFile(usageScript, CURSOR_USAGE_HOOK_SCRIPT, { mode: 0o600 }),
        writeFile(
          usageConnection,
          JSON.stringify({ url: usageHook.url, token: usageHook.token }),
          { mode: 0o600 },
        ),
      ]);
      if (usageFiles.some((file) => file.status === 'rejected')) {
        await usageHook.close();
        usageHook = undefined;
      }
    }
    const configDir = join(
      request.profileDir,
      'projects',
      encodeCursorProjectDir(request.cwd),
      '.cursor',
    );
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          ...(usageHook
            ? {
                afterAgentResponse: [
                  {
                    command: buildCursorHookCommand([
                      request.hookRuntime,
                      usageScript,
                      usageConnection,
                    ]),
                    timeout: 3,
                    failClosed: false,
                  },
                ],
              }
            : {}),
          preToolUse: [
            {
              command: buildCursorHookCommand([
                request.hookRuntime,
                script,
                connection,
              ]),
              failClosed: true,
              timeout: 75,
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    abort.signal.throwIfAborted();
    child = request.providerProcess.spawner({
      command: request.launch.command,
      args: [
        ...request.launch.prefix,
        '--disable-auto-update',
        '--trust',
        'acp',
      ],
      cwd: request.cwd,
      env: { ...request.env, CURSOR_DATA_DIR: request.profileDir },
      owner: request.providerProcess.owner,
    });
    child.stderr.resume();
    child.once('error', (error: Error) => {
      // Record WHY before aborting. The abort controller below is the
      // driver's own composite, so deriving `cancelled` from it alone
      // turns a runtime failure the driver discovered (a missing or
      // unexecutable binary) into a user cancellation — which is
      // terminal for `max_retries` and produces no failure
      // classification. Only the caller's `request.signal` may cancel.
      childFailure ??= error;
      abort.abort();
    });
    let loading = true;
    let submittingPrompt = false;
    let promptAccepted = false;
    const admitPrompt = (): void => {
      if (!promptAccepted && !abort.signal.aborted) {
        promptAccepted = true;
        host.onPromptAccepted?.();
      }
    };
    const { stdin } = child;
    if (!stdin) throw new Error('The Cursor ACP child has no stdin.');
    client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(stdin),
        close: (): void => {
          hook?.revoke();
          void closeChild();
        },
      },
      clientInfo: { name: host.clientName, version: '1' },
      // The parameterized picker is the only ACP surface that exposes a
      // model's thinking control: the default variants picker advertises one
      // fixed variant per model and rejects every other one.
      clientCapabilityMeta: { parameterizedModelPicker: true },
      resourceGeneration: 1,
      // An approved Write can carry almost 8 MiB. Its completion contains
      // both file snapshots, so allow room for the diff and ACP envelope.
      maxMessageBytes: 32 * 1024 * 1024,
      onUpdate: async (update): Promise<void> => {
        if (update.update.sessionUpdate === 'available_commands_update') {
          if (!abort.signal.aborted)
            host.onAvailableCommands?.(
              update.update.availableCommands.map((command) => command.name),
            );
          return;
        }
        if (!loading && !abort.signal.aborted) {
          const change = update.update;
          if (
            submittingPrompt &&
            update.sessionId === sessionId &&
            [
              'agent_message_chunk',
              'agent_thought_chunk',
              'tool_call',
            ].includes(change.sessionUpdate)
          )
            admitPrompt();
          // A `tool_call` notification announces a NEW invocation, even when
          // the agent reuses an id. Nothing remembered about the previous
          // invocation under that id may carry over: neither that its
          // completion was already settled (or an identical repeat inherits
          // the earlier approval) nor that a permission request for it was
          // decided (or a stale decision authorizes the new call). A repeated
          // TERMINAL notification arrives WITHOUT a new start, so the
          // duplicate-report tolerance below is untouched. Ordering is safe
          // for the ACP map: the pinned CLI sends this notification before the
          // permission request for the same call, so the decision is recorded
          // after this reset, not cleared by it.
          if (change.sessionUpdate === 'tool_call') {
            settledCompletions.delete(change.toolCallId);
            acpDecidedIds.delete(change.toolCallId);
            emptyPendingGrepCalls.delete(change.toolCallId);
            if (
              change.status === 'pending' &&
              change.kind === 'search' &&
              change.title === 'grep' &&
              isEmptyRecord(change.rawInput) &&
              change.rawOutput === undefined &&
              change.content === undefined &&
              change.locations === undefined
            )
              emptyPendingGrepCalls.add(change.toolCallId);
          }
          let validationRejected = false;
          if (
            change.sessionUpdate === 'tool_call_update' &&
            emptyPendingGrepCalls.has(change.toolCallId)
          ) {
            validationRejected = isEmptyGrepValidationRejection(change);
            // Any intervening update (including in_progress or arguments)
            // disqualifies this invocation. Identical rejection repeats are
            // harmless but never consume or create approval evidence.
            if (!validationRejected)
              emptyPendingGrepCalls.delete(change.toolCallId);
          }
          if (
            !validationRejected &&
            (change.sessionUpdate === 'tool_call' ||
              change.sessionUpdate === 'tool_call_update') &&
            (change.status === 'completed' || change.status === 'failed')
          ) {
            // A terminal tool_call is a new invocation with its own payload,
            // not an update to any earlier call that happened to reuse its id.
            const tool =
              change.sessionUpdate === 'tool_call'
                ? undefined
                : projection.getTool(change.toolCallId);
            const kind = change.kind ?? tool?.kind;
            const completionInput = isRecord(change.rawInput)
              ? change.rawInput
              : isRecord(tool?.input)
                ? tool.input
                : undefined;
            // One settled completion can be reported more than once. That
            // repeat describes the SAME gated call, so it is exempt without
            // consuming another observation; a different input on the same id
            // is a different call and is not.
            const completionKey = `${change.status}|${
              completionInput ? fingerprint(completionInput) : ''
            }`;
            const alreadySettled =
              settledCompletions.get(change.toolCallId)?.has(completionKey) ??
              false;
            const decided = acpDecidedIds.get(change.toolCallId);
            const acpExempt =
              decided === 'allow' ||
              (decided === 'deny' && change.status === 'failed');
            // An ACP decision covers its own call, so it is consumed too.
            if (acpExempt && !alreadySettled)
              acpDecidedIds.delete(change.toolCallId);
            // A Shell hook has its own id. Match the exact command against
            // one native invocation, with original/RTK inputs as aliases of
            // that same invocation. Completion may carry a newer input.
            let hookExempt = false;
            if (kind !== 'execute' && !alreadySettled) {
              // The id identifies the invocation even when the completion
              // carries a newer input; the fingerprint covers a hook payload
              // that reported no id.
              let index = nativeHookObservations.findIndex(
                (observed) => observed.id === change.toolCallId,
              );
              if (index < 0 && completionInput) {
                const observedFingerprint = fingerprint(completionInput);
                index = nativeHookObservations.findIndex(
                  (observed) =>
                    observed.inputFingerprint === observedFingerprint,
                );
              }
              if (index >= 0) {
                nativeHookObservations.splice(index, 1);
                hookExempt = true;
              }
            }
            if (kind === 'execute') {
              const input = change.rawInput ?? tool?.input;
              const index = shellHookObservations.findIndex(
                (observed) =>
                  matchesShellHookInput(input, observed.input) ||
                  (observed.updatedInput !== undefined &&
                    matchesShellHookInput(input, observed.updatedInput)),
              );
              if (index >= 0) {
                shellHookObservations.splice(index, 1);
                hookExempt = true;
              }
            }
            // A call the app's own gate decided (because the CLI skipped
            // the permission request) is exempt like an ACP decision: an
            // allowed call passes, a denied one only when it then failed.
            let gateExempt = false;
            if (!acpExempt && !hookExempt) {
              const mcp = parseCursorMcpToolCall({
                title: tool?.name ?? change.title,
                rawInput: completionInput,
                kind,
              });
              if (mcp) {
                const appToolKey = resolveCursorCanopyToolKey(mcp);
                const decision = takeGateDecision(
                  appToolKey
                    ? appToolCallIdentity(appToolKey, mcp.args)
                    : pluginCallIdentity(mcp.server, mcp.tool, mcp.args),
                );
                gateExempt =
                  decision === 'allow' ||
                  (decision === 'deny' && change.status === 'failed');
              }
            }
            // Require approval evidence for all actual tools, including reads
            // and unlabeled kinds. Notifications alone are exempt.
            if (acpExempt || hookExempt || gateExempt || alreadySettled) {
              const settled = settledCompletions.get(change.toolCallId);
              if (settled) settled.add(completionKey);
              else
                settledCompletions.set(
                  change.toolCallId,
                  new Set([completionKey]),
                );
            }
            if (
              !NON_TOOL_NOTIFICATION_KINDS.has(kind ?? '') &&
              !acpExempt &&
              !hookExempt &&
              !gateExempt &&
              !alreadySettled
            ) {
              integrity.failure =
                (change.status === 'failed'
                  ? hookSpawnFailureMessage(change.rawOutput)
                  : undefined) ??
                'Cursor ran a tool without reaching the approval hook, so the session was stopped. Reconnect Cursor before trying again.';
              integrity.kind = 'unapproved_tool';
              integrity.cause = undefined;
              abort.abort();
              return;
            }
          }
          try {
            const event = projection.update(update);
            // A block this update closed releases its held text first.
            for (const flushed of projection.takeFlushed())
              await host.emit(flushed);
            if (event) await host.emit(event);
          } catch (error) {
            // Surface the projection's own message (for example the
            // bounded-output limit) instead of the generic ACP handler error.
            integrity.failure =
              error instanceof Error ? error.message : 'Cursor chat failed.';
            integrity.kind =
              error instanceof CursorProjectionLimitError
                ? 'output_limit'
                : 'event_delivery';
            integrity.cause = error;
            abort.abort();
          }
        }
      },
      // In this pinned CLI, ACP consent advances Shell to native preToolUse;
      // it does not authorize execution. The authenticated hook above routes
      // the actual command/cwd through the host's policy, including Deny
      // and read-only mode, before the CLI can execute it. Keep one policy
      // decision at that boundary (see docs/cursor-chat.md). MCP calls have
      // no native hook, so this request is their policy decision; unknown
      // permission kinds stay denied.
      onPermission: async ({
        request: permission,
        signal,
      }): Promise<'allow' | 'deny'> => {
        if (abort.signal.aborted || signal.aborted) return 'deny';
        const toolCallId = permission.toolCall.toolCallId;
        const tool = projection.getTool(toolCallId);
        if (
          tool?.kind === 'execute' &&
          isRecord(tool.input) &&
          typeof tool.input.command === 'string'
        )
          return 'allow';
        const mcp = parseCursorMcpToolCall({
          title: tool?.name ?? permission.toolCall.title,
          rawInput: tool?.input,
          kind: tool?.kind ?? permission.toolCall.kind,
        });
        if (!mcp || !knownMcpServerNames.has(mcp.server)) return 'deny';
        const outcome = await host.authorizeMcp(mcp, {
          toolCallId,
          signal: AbortSignal.any([abort.signal, signal]),
        });
        acpDecidedIds.set(toolCallId, outcome.decision);
        if (outcome.decision === 'allow') {
          const appToolKey = resolveCursorCanopyToolKey(mcp);
          allowCall(
            appToolKey
              ? appToolCallIdentity(appToolKey, mcp.args)
              : pluginCallIdentity(mcp.server, mcp.tool, mcp.args),
          );
        }
        if (outcome.stopTurn) abort.abort();
        return outcome.decision;
      },
      // No prompt deadline by default: like Claude and Codex chat, an
      // interactive turn runs until Cursor finishes, the user presses Stop,
      // or the process exits. Stop is not deadline-dependent: `revoke`
      // disposes the client and the child's stop() reaps the CLI
      // (SIGTERM, then SIGKILL after 1.5s), so a CLI that ignores
      // session/cancel cannot hold the turn. Pipeline turns pass an explicit
      // `promptTimeoutMs` bounded by `timeout_minutes` instead.
      timeouts: {
        initializeMs: 15_000,
        requestMs: 30_000,
        promptMs:
          request.promptTimeoutMs === undefined
            ? null
            : request.promptTimeoutMs,
        permissionMs: 65_000,
        cancelMs: 1000,
      },
    });
    abort.signal.throwIfAborted();
    if (
      client
        .getInitialization()
        .authMethods?.some((method) => method.id === 'cursor_login')
    )
      await client.authenticate({ methodId: 'cursor_login' }, abort.signal);
    const capabilities =
      client.getInitialization().agentCapabilities?.mcpCapabilities;
    const mcp = await host.prepareMcp(capabilities, gates);
    const mcpServers = mcp.servers;
    for (const server of mcpServers) knownMcpServerNames.add(server.name);
    let configOptions: SessionConfigOption[] = [];
    if (sessionId) {
      try {
        const loaded = await client.loadSession({
          sessionId,
          cwd: request.cwd,
          mcpServers,
        });
        configOptions = loaded.configOptions ?? [];
      } catch (error) {
        // The profile is keyed on the working directory, so a repo or
        // data-dir change orphans the saved session. Start a fresh one
        // rather than failing every later turn of this chat.
        abort.signal.throwIfAborted();
        if (request.requireExistingSession && isTransientAcpFailure(error)) {
          // This catch used to treat EVERY `loadSession` rejection as proof
          // the context was gone, including the ACP client's own fixed-window
          // RPC timeout. A resume-only caller then
          // got "its saved context is no longer available" — a false
          // statement — for what was really a transient blip, and the real
          // cause was replaced by a misdiagnosis. A transport-level fault is
          // now surfaced truthfully and stays an ordinary retryable step
          // failure; an agent-side rejection still means the context is gone.
          // Interactive callers that allow a fresh session retain their
          // documented fallback for every failure kind.
          throw error;
        }
        contextLost = true;
        if (request.requireExistingSession) {
          // A resume-only caller must not have a fresh, write-capable turn
          // run in place of the resume it asked for (see the field's doc
          // comment). Fail here, before `newSession`/`prompt`.
          throw new Error(
            `Cursor session ${sessionId} could not be resumed: its saved context is no longer available.`,
          );
        }
        sessionId = undefined;
        host.onSessionCleared?.();
      }
    }
    if (request.requireExistingSession && !sessionId) {
      // A resume-only caller must never reach `newSession`. The only call site
      // keeps this invariant today (it sets both fields from the same value), so
      // this is defence in depth against a future caller, not a live defect.
      throw new Error(
        'Cursor session could not be resumed: no session id was supplied.',
      );
    }
    if (!sessionId) {
      const created = await client.newSession({
        cwd: request.cwd,
        mcpServers,
      });
      sessionId = created.sessionId;
      configOptions = created.configOptions ?? [];
    }
    abort.signal.throwIfAborted();
    // Loading a saved conversation restores its prior model in this CLI.
    // Apply the exact advertised ACP identity after BOTH new and load, and
    // require an acknowledgement before any prompt can run. The
    // parameterized picker takes the variant's base ID first; selecting it
    // restores whatever parameters the CLI remembers for that model, so every
    // parameter the persisted variant names is re-applied, and the requested
    // thinking level is applied last. Each acknowledgement is checked, and
    // the whole state is re-checked at the end because one option can snap
    // another.
    const variant = parseCursorModelVariant(request.rawModelId);
    const unavailable = (): Error =>
      new Error(
        'This Cursor model is unavailable. Choose another Cursor model and try again.',
      );
    if (
      !cursorConfigOptionValues(configOptions, 'model')?.includes(variant.base)
    )
      throw unavailable();
    // Captured for the closure: both are narrowed here but not inside it.
    const currentSessionId = sessionId;
    const connected = client;
    const apply = async (
      set: CursorConfigSet,
      failure: () => Error,
    ): Promise<void> => {
      const selected = await connected.setSessionConfigOption(
        {
          sessionId: currentSessionId,
          configId: set.configId,
          value: set.value,
        },
        abort.signal,
      );
      configOptions = selected.configOptions;
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value)
        throw failure();
    };
    await apply(
      { configId: 'model', value: variant.base },
      () =>
        new Error(
          'Cursor could not select this model. Choose another Cursor model and try again.',
        ),
    );
    const plan =
      request.thinkingLevel === undefined
        ? undefined
        : planCursorThinking(configOptions, request.thinkingLevel);
    // A requested level owns EVERY thought-level option, including the ones
    // the plan deliberately leaves alone: turning a `thinking` toggle off
    // snaps the graded `effort` in the pinned CLI, so re-applying (or
    // re-checking) the variant's own effort would report a valid Off as an
    // unavailable model.
    const planned = new Set(
      plan
        ? configOptions
            .filter(
              (option) => option.category === CURSOR_THOUGHT_LEVEL_CATEGORY,
            )
            .map((option) => option.id)
        : [],
    );
    const parameterSets: CursorConfigSet[] = [];
    for (const parameter of variant.parameters) {
      // A parameter the picker no longer offers has a single value or is gone.
      const values = cursorConfigOptionValues(configOptions, parameter.id);
      if (values === undefined || planned.has(parameter.id)) continue;
      if (!values.includes(parameter.value)) throw unavailable();
      parameterSets.push({ configId: parameter.id, value: parameter.value });
    }
    const thinkingFailure = (): Error =>
      new Error(
        'Cursor could not apply this thinking level. Choose another level and try again.',
      );
    for (const set of parameterSets)
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value)
        await apply(set, unavailable);
    let planApplied = false;
    for (const set of plan?.sets ?? [])
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value) {
        await apply(set, thinkingFailure);
        planApplied = true;
      }
    // A toggle can change which graded options the picker offers (a
    // remembered `thinking=false` may hide `effort` until it is on), so plan
    // again from the acknowledged options and apply what appeared.
    const finalPlan =
      request.thinkingLevel === undefined
        ? undefined
        : planCursorThinking(configOptions, request.thinkingLevel);
    for (const set of finalPlan?.sets ?? [])
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value) {
        await apply(set, thinkingFailure);
        planApplied = true;
      }
    // A variant parameter that held before the level was applied and no
    // longer does was moved by the level, so the level is what to change.
    for (const set of parameterSets)
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value)
        throw planApplied ? thinkingFailure() : unavailable();
    for (const set of finalPlan?.sets ?? [])
      if (cursorConfigOptionValue(configOptions, set.configId) !== set.value)
        throw thinkingFailure();
    // The host forwards the level its composer shows, clamped to the
    // discovered catalog. If the live options resolve it differently, the
    // runtime would run somewhere the composer never showed: fail instead.
    if (
      request.thinkingLevel !== undefined &&
      (finalPlan === undefined || finalPlan.applied !== request.thinkingLevel)
    )
      throw thinkingFailure();
    abort.signal.throwIfAborted();
    loading = false;
    await host.emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: request.model,
    });
    let noticeTail = Promise.resolve();
    const announce = (text: string): void => {
      const event = projection.notice(text);
      const flushed = projection.takeFlushed();
      noticeTail = noticeTail.then(async () => {
        for (const item of flushed) await host.emit(item);
        await host.emit(event);
      });
    };
    const prepared = await host.beforePrompt({
      sessionId,
      contextLost,
      mcp,
      announce,
    });
    await noticeTail;
    const inheritedContext = prepared.inheritedContext;
    abort.signal.throwIfAborted();
    submittingPrompt = true;
    const response = await client.prompt(
      {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: [prepared.instructions, inheritedContext, request.text]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
      1,
      abort.signal,
    );
    if (response.stopReason === 'end_turn') admitPrompt();
    if (integrity.failure)
      return result({
        sessionId,
        isError: true,
        cancelled: false,
        message: integrity.failure,
        integrityFailure: integrity.failure,
        ...(integrity.kind ? { failureKind: integrity.kind } : {}),
        contextLost,
        inheritedContextDelivered,
      });
    const terminalError =
      response.stopReason === 'end_turn'
        ? projection.getTerminalError()
        : undefined;
    const actionRequired =
      terminalError !== undefined ? projection.getTerminalAction() : undefined;
    const truncated =
      response.stopReason === 'max_tokens' ||
      response.stopReason === 'max_turn_requests';
    inheritedContextDelivered =
      Boolean(inheritedContext) &&
      (response.stopReason === 'end_turn' || truncated) &&
      !terminalError;
    return result({
      sessionId,
      isError:
        response.stopReason === 'refusal' ||
        truncated ||
        terminalError !== undefined,
      // cancelled reflects the CLI's stopReason only; a host-aborted turn is
      // reported through the catch path, preserving the pre-extraction
      // subtype semantics.
      cancelled: response.stopReason === 'cancelled',
      stopReason: response.stopReason,
      message:
        response.stopReason === 'refusal'
          ? 'Cursor declined the request.'
          : response.stopReason === 'cancelled'
            ? 'Turn cancelled'
            : truncated
              ? 'Cursor stopped early after reaching its turn limit. Send a follow-up to continue.'
              : (terminalError ?? ''),
      ...(actionRequired ? { actionRequired } : {}),
      contextLost,
      inheritedContextDelivered,
    });
  } catch (error) {
    if (integrity.failure)
      return result({
        sessionId,
        isError: true,
        cancelled: false,
        message: integrity.failure,
        integrityFailure: integrity.failure,
        ...(integrity.kind ? { failureKind: integrity.kind } : {}),
        contextLost,
        inheritedContextDelivered,
      });
    // A cancellation is only a cancellation when nothing actually broke:
    // `abort` also fires for stops the driver discovers itself, and
    // `childFailure` marks the one that is a genuine infrastructure error
    // rather than a user's stop.
    const cancelled = abort.signal.aborted && childFailure === undefined;
    return result({
      ...(error instanceof AcpClientError &&
      !cancelled &&
      childFailure === undefined &&
      error.providerDetails
        ? { providerErrorDetails: error.providerDetails }
        : {}),
      sessionId,
      isError: !cancelled,
      cancelled,
      message: cancelled
        ? 'Turn cancelled'
        : (childFailure?.message ??
          (error instanceof Error ? error.message : 'Cursor chat failed.')),
      contextLost,
      inheritedContextDelivered,
    });
  } finally {
    hook?.revoke();
    // The host's cleanup is the host's business: a rejection here must not
    // replace this turn's result, nor skip the teardown of everything the
    // DRIVER owns below it — the ACP client, the detached child process
    // group, both listening hook servers, and the temp dir holding the
    // hook's bearer token. Matches the `void ….catch(() => {})` convention
    // already used for the cancel call in `revoke` above.
    //
    // EVERY step is guarded, not just the host hook. This comment used to
    // claim coverage the code did not have:
    // only `host.cleanup` was caught, so a rejection from `closeChild`,
    // either hook server's `close`, or the temp-dir removal would still have
    // replaced the turn's real result and skipped every later step —
    // including the listener removal at the end, which leaks a listener on
    // the caller's long-lived signal. Each is independently owned, so one
    // failing must not stop the others.
    await host.cleanup?.().catch(() => undefined);
    try {
      client?.close();
    } catch {
      // Already closed or never connected.
    }
    await closeChild().catch(() => undefined);
    await hook?.close().catch(() => undefined);
    await usageHook?.close().catch(() => undefined);
    if (hookDir)
      await rm(hookDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    abort.signal.removeEventListener('abort', revoke);
    request.signal.removeEventListener('abort', forwardAbort);
  }
}
