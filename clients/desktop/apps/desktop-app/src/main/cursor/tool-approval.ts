import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import { PIPELINE_EDITOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { resolve } from 'node:path';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  isLedgerInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  readToolPath,
  shellToolCommand,
  writeToolInput,
  cursorReadToolInput,
  cursorFetchUrl,
  cursorWebSearchQuery,
} from '@canopy/desktop-shared/node/cursor/tool-input';
import {
  cursorCanopyMcpServerNames,
  isReadOnlyCursorAppTool,
  resolveCursorAppAdvisorToolKey,
  resolveCursorPipelineEditorToolKey,
  resolveCursorCanopyToolKey,
  type CursorCanopyServerMode,
  type CursorCanopyToolSurface,
  type CursorMcpToolCall,
} from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import { approvalCheckForClaudeTool } from '../agents/claude-approval-adapter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only inspected native operations enter shared policy. Unknown tools fail closed. */
export async function authorizeCursorTool(
  payload: unknown,
  context: {
    cwd: string;
    approval: ApprovalSessionHandle;
    planMode: boolean;
    signal: AbortSignal;
  },
): Promise<ApprovalOutcome> {
  if (
    context.signal.aborted ||
    !isRecord(payload) ||
    payload.hook_event_name !== 'preToolUse' ||
    !isRecord(payload.tool_input) ||
    typeof payload.tool_use_id !== 'string' ||
    payload.tool_use_id.length > 4096
  )
    return { decision: 'deny' };
  const input = payload.tool_input;
  const tool = payload.tool_name;
  // The pinned CLI runs preToolUse for MCP tools too, as `MCP:<tool>` with
  // only the arguments and a hook-only id: the server is unknown here, and
  // the CLI sends the ACP permission request right after an allow. That
  // request (and the proxy gate) carry MCP policy; a deny here would fail
  // every MCP call as permission denied before either ran.
  if (typeof tool === 'string' && tool.startsWith('MCP:'))
    return { decision: 'allow' };
  let normalized: ReturnType<typeof approvalCheckForClaudeTool>;
  const read = cursorReadToolInput(tool, input);
  if (read) {
    // The shared adapter names the target on the card, like a Claude read.
    normalized = approvalCheckForClaudeTool(
      read.toolName,
      read.input,
      context.cwd,
    );
  } else if (tool === 'Fetch' || tool === 'WebFetch') {
    const url = cursorFetchUrl(input);
    if (url === undefined)
      return {
        decision: 'deny',
        message: 'Fetch requires an HTTP or HTTPS URL.',
      };
    normalized = approvalCheckForClaudeTool('WebFetch', { url }, context.cwd);
  } else if (tool === 'WebSearch') {
    if (cursorWebSearchQuery(input) === undefined)
      return {
        decision: 'deny',
        message: 'WebSearch requires a search query.',
      };
    // Cursor's pinned API has no enforceable domain filter. Use the same
    // broad-grant semantics as Codex: ANY narrower network deny must block
    // this request, even if the model supplies a made-up allowed_domains.
    normalized = {
      check: { kind: 'network', host: '*', isGrant: true },
      details: {
        kind: 'network',
        host: '*',
        reason: 'Cursor web search chooses its own domains.',
      },
      suggestedTarget: { kind: 'network', host: '*' },
    };
  } else if (tool === 'Write' || tool === 'Read' || tool === 'Delete') {
    // Well-formedness comes from the SAME helpers the headless pipeline policy
    // uses (`@canopy/desktop-shared/node/cursor/tool-input`), so a hardening
    // change cannot land in one gate and miss the other. Only the decision
    // below — normalize into the approval engine and prompt — is specific here.
    const filePath = readToolPath(input);
    if (filePath === undefined) return { decision: 'deny' };
    if (
      (tool !== 'Read' && context.planMode) ||
      (tool === 'Write' && !writeToolInput(input))
    )
      return { decision: 'deny' };
    normalized = approvalCheckForClaudeTool(
      tool === 'Delete' ? 'Write' : tool,
      // A Read keeps its raw path so the adapter sees any `..` segment, which
      // `resolve` would collapse before Auto read containment could refuse it.
      { ...input, file_path: tool === 'Read' ? filePath : resolve(filePath) },
      context.cwd,
    );
  } else if (tool === 'Shell') {
    const command = shellToolCommand(input);
    if (context.planMode || command === undefined) return { decision: 'deny' };
    // Preserve the whole command. Never approve only its first executable.
    if (
      input.cwd !== undefined &&
      (typeof input.cwd !== 'string' || input.cwd.includes('\0'))
    )
      return { decision: 'deny' };
    const cwd =
      typeof input.cwd === 'string'
        ? resolve(context.cwd, input.cwd)
        : context.cwd;
    normalized = approvalCheckForClaudeTool('Bash', input, cwd);
    normalized.details = { kind: 'command', command, cwd };
  } else {
    return {
      decision: 'deny',
      message: `Cursor tool ${String(tool)} has an unsupported name or invalid input.`,
    };
  }
  if (normalized.failClosedReason)
    return { decision: 'deny', message: normalized.failClosedReason };
  for (const requirement of [
    normalized,
    ...(normalized.additionalRequirements ?? []),
  ]) {
    if (context.signal.aborted) return { decision: 'deny' };
    const outcome = await context.approval.check(requirement.check, {
      title: `Cursor wants to use ${String(tool)}`,
      details: requirement.details,
      suggestedTarget: requirement.suggestedTarget,
      toolUseId: payload.tool_use_id,
    });
    if (context.signal.aborted) return { decision: 'deny' };
    if (outcome.decision !== 'allow' || outcome.stopTurn) return outcome;
  }
  return { decision: 'allow' };
}

/**
 * Policy decision for an MCP tool call Cursor asks permission for over ACP.
 * The app's own servers are checked exactly as Claude checks its Canopy MCP
 * tools: the call is mapped through the tool's Claude MCP name, so
 * `WatchCommand` becomes a command check (safety-deny list included) and every
 * other tool the `<namespace>` / `<namespace>_ui` MCP check, sharing rules and
 * prompts with Claude. A tool the surface does not advertise is denied. Every
 * other server goes through the shared MCP approval check for its own name,
 * exactly like a Claude `mcp__<server>__<tool>` call.
 *
 * In App Advisor mode the main server carries the App Advisor tool set: each
 * call is checked as its `mcp__<namespace>_app_advisor__<Name>` Claude name so
 * remembered rules and prompts are shared with Claude App Advisor, and
 * `WatchCommand` is allowed here because the App Advisor runtime performs that
 * command approval itself against the selected worktree (the Claude hook and
 * Codex handler take the same shortcut).
 */
export async function authorizeCursorMcpTool(
  call: Pick<CursorMcpToolCall, 'server' | 'tool' | 'args'>,
  context: {
    approval: ApprovalSessionHandle;
    toolCallId: string;
    cwd: string;
    /** Read-only plan mode: only app tools that read state may run. */
    planMode?: boolean;
    /** Which app tool set this session carries. */
    mode?: CursorCanopyServerMode;
    providerLabel?: 'Cursor' | 'Copilot' | 'OpenCode' | 'Antigravity';
    /**
     * Which app tool set the default-mode main server advertises. Cowork
     * routes carry `cursor-acp-standalone`; a tool outside it is denied here
     * so the user is never prompted for a call the proxy would refuse.
     */
    toolSurface?: CursorCanopyToolSurface;
    /** Host-advertised managed tools for this exact worktree turn. */
    managedToolNames?: readonly string[];
    signal: AbortSignal;
  },
): Promise<ApprovalOutcome> {
  if (context.signal.aborted) return { decision: 'deny' };
  const mode = context.mode ?? 'default';
  const providerLabel = context.providerLabel ?? 'Cursor';
  const names = cursorCanopyMcpServerNames(mode);
  if (
    mode === 'default' &&
    call.server === names.main &&
    isWatchDelegatesCompatibilityName(call.tool, 'cursor')
  )
    return { decision: 'allow' };
  const args = isRecord(call.args) ? call.args : {};
  let requirements: ReturnType<typeof approvalCheckForClaudeTool>[];
  if (
    mode === 'default' &&
    call.server === names.main &&
    context.managedToolNames?.includes(call.tool)
  ) {
    const readOnly = [
      'GetDelegateOutput',
      'InspectDelegate',
      'ListDelegates',
    ].includes(call.tool);
    if (context.planMode && !readOnly) return { decision: 'deny' };
    const normalized = approvalCheckForClaudeTool(
      `mcp__${names.main}__${call.tool}`,
      args,
      context.cwd,
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    requirements = [normalized, ...(normalized.additionalRequirements ?? [])];
  } else if (
    mode === 'app-advisor' &&
    (call.server === names.main || call.server === names.ui)
  ) {
    const key = resolveCursorAppAdvisorToolKey(call);
    if (!key)
      return {
        decision: 'deny',
        message: `This tool is not available to ${providerLabel} chats.`,
      };
    if (key === 'watch_command') return { decision: 'allow' };
    // AskUserQuestion travels on the shared `_ui` server, which is the name
    // Claude's App Advisor session checks it under too.
    const normalized = approvalCheckForClaudeTool(
      key === 'ask_user_question'
        ? CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.claudeToolName
        : APP_ADVISOR_TOOL_REGISTRY[key].claudeToolName,
      args,
      context.cwd,
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    requirements = [normalized, ...(normalized.additionalRequirements ?? [])];
  } else if (
    mode === 'pipeline-editor' &&
    (call.server === names.main || call.server === names.ui)
  ) {
    const key = resolveCursorPipelineEditorToolKey(call);
    if (!key) return { decision: 'deny' };
    if (
      context.planMode &&
      ![
        'ask_user_question',
        'pipeline_list',
        'pipeline_get_current',
        'pipeline_get_action_definition',
      ].includes(key)
    )
      return { decision: 'deny' };
    const normalized = approvalCheckForClaudeTool(
      PIPELINE_EDITOR_TOOL_REGISTRY[key].claudeToolName,
      args,
      context.cwd,
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    requirements = [normalized, ...(normalized.additionalRequirements ?? [])];
  } else if (call.server === names.main || call.server === names.ui) {
    const key = resolveCursorCanopyToolKey(
      call,
      context.toolSurface ?? 'cursor-acp',
    );
    if (!key)
      return {
        decision: 'deny',
        message: `This tool is not available to ${providerLabel} chats.`,
      };
    // The native hook denies Write and Shell in plan mode. An app tool that
    // changes app state, or runs a shell command (WatchCommand), gets the same
    // answer before a remembered rule or Full Access could allow it silently.
    // The Ledger tools are the explicit bookkeeping exception, as in Claude
    // and Codex plan mode: they grant no edits or commands, so they follow
    // the ordinary policy below.
    if (
      context.planMode === true &&
      !isReadOnlyCursorAppTool(key) &&
      !isLedgerInjectedToolKey(key)
    )
      return {
        decision: 'deny',
        message: `Read-only plan mode: ${call.tool} is not available.`,
      };
    // A watcher probe without a command has nothing the command policy could
    // inspect; fail closed rather than fall back to a generic tool prompt.
    if (key === 'watch_command' && typeof args.command !== 'string')
      return { decision: 'deny', message: 'WatchCommand needs a command.' };
    const normalized = approvalCheckForClaudeTool(
      CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
      args,
      context.cwd,
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    requirements = [normalized, ...(normalized.additionalRequirements ?? [])];
  } else {
    // Plugin metadata does not establish that a tool is read-only. Deny
    // before generic policy, including Full Access or remembered allows.
    if (context.planMode === true)
      return {
        decision: 'deny',
        message: `Read-only plan mode: ${call.tool} is not available.`,
      };
    const target = {
      kind: 'mcp',
      server: call.server,
      tool: call.tool,
    } as const;
    requirements = [
      { check: target, details: target, suggestedTarget: target },
    ];
  }
  for (const requirement of requirements) {
    if (context.signal.aborted) return { decision: 'deny' };
    // Match Claude's card: a watcher probe says how often it may run.
    const description =
      requirement.check.kind === 'command' &&
      typeof args.maxAttempts === 'number' &&
      typeof args.intervalSeconds === 'number'
        ? `Repeated command in \`${context.cwd}\`: up to ${String(args.maxAttempts)} ${args.maxAttempts === 1 ? 'attempt' : 'attempts'}, ${String(args.intervalSeconds)} seconds between attempts, 60-second timeout each.`
        : undefined;
    const outcome = await context.approval.check(requirement.check, {
      title: `${providerLabel} wants to use ${call.tool}`,
      ...(description ? { description } : {}),
      details: requirement.details,
      suggestedTarget: requirement.suggestedTarget,
      toolUseId: context.toolCallId,
    });
    if (context.signal.aborted) return { decision: 'deny' };
    if (outcome.decision !== 'allow' || outcome.stopTurn) return outcome;
  }
  return { decision: 'allow' };
}
