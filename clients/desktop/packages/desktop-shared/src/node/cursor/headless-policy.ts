import type { CursorReportedUsage } from '@canopy/agent-transcript/lib/cursor-usage';
import type { PermissionPreset } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  cursorCanopyMcpServerNames,
  isReadOnlyCursorAppTool,
  resolveCursorCanopyToolKey,
  type CursorMcpToolCall,
} from '../../lib/cursor-mcp-tool-call';
import type { CursorHookDecision } from './hook-transport';
import {
  readToolPath,
  shellToolCommand,
  writeToolInput,
  cursorReadToolInput,
  cursorFetchUrl,
  cursorWebSearchQuery,
} from './tool-input';
import type {
  CursorTurnHost,
  CursorTurnMcpSetup,
  CursorTurnRtk,
} from './turn-driver';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DENY_NONE = 'This step runs with no tools (permission_preset: none).';
const DENY_READ_ONLY =
  'This step is read-only; writes and shell commands are not allowed.';
/** Matches the interactive path's bound in `cursor/tool-approval.ts`. */
const MAX_TOOL_USE_ID_CHARS = 4096;

const DENY_UNKNOWN = 'This Cursor tool is not supported in headless runs.';
const DENY_MCP = 'MCP tools are not available on Cursor steps yet.';
const CURSOR_STEP_LIMIT_MESSAGE =
  'Cursor wrote more than one step can hold (8 MiB or 4,096 blocks in a turn), so the step was stopped.';

/** Pure preset policy for a native preToolUse payload; unknown tools fail closed. */
export function headlessCursorDecision(
  preset: PermissionPreset,
  payload: unknown,
): CursorHookDecision {
  if (
    !isRecord(payload) ||
    payload.hook_event_name !== 'preToolUse' ||
    !isRecord(payload.tool_input) ||
    typeof payload.tool_use_id !== 'string' ||
    // The same bound the interactive path applies (`cursor/tool-approval.ts`):
    // headless has no reason to accept more than interactive does. It bounds
    // what this policy accepts, not the turn's integrity anchor set: the turn
    // driver records a hook's id before it asks this policy.
    payload.tool_use_id.length > MAX_TOOL_USE_ID_CHARS
  )
    return { decision: 'deny', message: DENY_UNKNOWN };
  const tool = payload.tool_name;
  const input = payload.tool_input;
  // Exhaustive on PermissionPreset: a preset added to the union without a
  // case here is a compile error (the `never` assignment below), not a
  // silent fall-through to the Write/Shell "not dangerous_all" branch that
  // would otherwise behave like read_only for an unrecognized preset.
  switch (preset) {
    case 'none':
      return { decision: 'deny', message: DENY_NONE };
    case 'dangerous_all':
    case 'read_only':
    case 'plan':
      break;
    default: {
      const unhandled: never = preset;
      throw new Error(
        `Unhandled Cursor permission preset: ${String(unhandled)}`,
      );
    }
  }
  if (typeof tool === 'string' && tool.startsWith('MCP:'))
    // Headless steps are given no MCP servers (`prepareMcp` below), so an MCP
    // call reaching this hook came from a server the runtime found on its own.
    // The ACP permission request (headlessCursorMcpDecision) cannot be the
    // only gate: the pinned CLI can run an MCP tool without sending one, and
    // the integrity anchor only stops the session AFTER the tool has run.
    // The hook payload names the tool but not its server, so there is nothing
    // here to allow selectively; delivering app MCP to steps must replace this
    // refusal with a check that can identify the server.
    return { decision: 'deny', message: DENY_MCP };
  // Well-formedness is decided by the SAME helpers the interactive policy uses
  // (`node/cursor/tool-input.ts`), so a hardening change cannot land in one
  // gate and miss the other. Only the decision below is policy-specific.
  if (cursorReadToolInput(tool, input)) return { decision: 'allow' };
  if (tool === 'Fetch' || tool === 'WebFetch' || tool === 'WebSearch') {
    const valid =
      tool === 'WebSearch'
        ? cursorWebSearchQuery(input)
        : cursorFetchUrl(input);
    if (valid === undefined) return { decision: 'deny', message: DENY_UNKNOWN };
    return preset === 'dangerous_all' || preset === 'plan'
      ? { decision: 'allow' }
      : {
          decision: 'deny',
          message:
            'The read_only preset permits local file reads and searches, not network tools.',
        };
  }
  if (tool === 'Read') {
    return readToolPath(input) !== undefined
      ? { decision: 'allow' }
      : { decision: 'deny', message: DENY_UNKNOWN };
  }
  if (tool === 'Write' || tool === 'Delete') {
    if (
      (tool === 'Write' ? writeToolInput(input) : readToolPath(input)) ===
      undefined
    )
      return { decision: 'deny', message: DENY_UNKNOWN };
    return preset === 'dangerous_all'
      ? { decision: 'allow' }
      : { decision: 'deny', message: DENY_READ_ONLY };
  }
  if (tool === 'Shell') {
    if (shellToolCommand(input) === undefined)
      return { decision: 'deny', message: DENY_UNKNOWN };
    return preset === 'dangerous_all'
      ? { decision: 'allow' }
      : { decision: 'deny', message: DENY_READ_ONLY };
  }
  return { decision: 'deny', message: DENY_UNKNOWN };
}

/**
 * ACP permission policy for MCP calls: only the app's own servers, read-only
 * below dangerous_all. Staged ahead of the slice that delivers the app MCP
 * server to headless Cursor steps: `prepareMcp` below currently always
 * returns `servers: []`, and `headlessCursorDecision` refuses every `MCP:`
 * call at the preToolUse hook, so this function only ever sees calls that
 * have already been refused there. It stays in place, already exercised by
 * policy tests. Activating the "App MCP tools" preset column documented in
 * docs/cursor-chat.md takes two steps, not one: wiring the real server list
 * into `prepareMcp`, and replacing the hook refusal with a check that can
 * tell the app's servers from ones the runtime loaded itself.
 */
export function headlessCursorMcpDecision(
  preset: PermissionPreset,
  call: Pick<CursorMcpToolCall, 'server' | 'tool' | 'args'>,
): CursorHookDecision {
  if (preset === 'none') return { decision: 'deny', message: DENY_NONE };
  const names = cursorCanopyMcpServerNames();
  if (call.server !== names.main && call.server !== names.ui)
    return {
      decision: 'deny',
      message: 'Plugin MCP servers are not available on Cursor steps yet.',
    };
  const key = resolveCursorCanopyToolKey(call);
  if (!key)
    return {
      decision: 'deny',
      message: 'This tool is not available to Cursor steps.',
    };
  if (preset === 'dangerous_all' || isReadOnlyCursorAppTool(key))
    return { decision: 'allow' };
  return {
    decision: 'deny',
    message: `${call.tool} changes state and this step is read-only.`,
  };
}

export const CURSOR_PLAN_MODE_STEERING =
  'Read-only plan mode: do not edit files or execute shell commands. When you have a plan, write the complete plan inside <proposed_plan>...</proposed_plan> tags as the final part of your response.';

/**
 * Re-exported, NOT reimplemented.
 *
 * This module had its own copy that was case-SENSITIVE and took the LAST
 * `<proposed_plan>` block, while the established helper every other provider
 * uses (`codex-plan-mode.ts`, on the base, four call sites across Claude and
 * Codex) is case-INSENSITIVE and takes the FIRST. The same agent text therefore
 * produced a different `proposed_plan_file` on a Cursor step than on a Codex or
 * Claude one — and a `plan_ready` run consumes that file durably.
 *
 * The outlier is this one: it had a single caller and arrived with this change,
 * so it converges onto the established contract rather than the other way
 * round. Changing the established semantics would alter Codex and Claude
 * behaviour this work has no mandate to touch.
 */
export { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';

const NO_TOOLS_STEERING =
  'This run has no tools available. Answer from the prompt alone.';
const READ_ONLY_STEERING =
  'This run supports native Read, Grep, Glob, List, and ReadLints. Writes, deletes, shell commands, and network tools are denied. Do not work around a denied operation.';
const PLAN_STEERING =
  'This run supports native Read, Grep, Glob, List, ReadLints, Fetch, WebFetch, and WebSearch. Writes, deletes, and shell commands are denied. Do not work around a denied operation.';
const FULL_STEERING =
  'This run supports native Read, Grep, Glob, List, ReadLints, Write, Delete, Shell, Fetch, WebFetch, and WebSearch. Do not work around a denied operation.';

export function createHeadlessCursorHost(options: {
  preset: PermissionPreset;
  instructions: string;
  clientName: string;
  emit: (event: Record<string, unknown>) => void;
  onUsage?: (usage: CursorReportedUsage) => void;
  rtk?: { binaryPath: string; env: NodeJS.ProcessEnv };
  pluginWarning?: string;
  /** The step's configured values, masked in streamed text across deltas. */
  secretValues?: readonly string[];
}): CursorTurnHost {
  const { preset } = options;
  const toolSteering =
    preset === 'none'
      ? NO_TOOLS_STEERING
      : preset === 'dangerous_all'
        ? FULL_STEERING
        : preset === 'plan'
          ? PLAN_STEERING
          : READ_ONLY_STEERING;
  const emptyMcp: CursorTurnMcpSetup = {
    servers: [],
    notes: [],
    notices: options.pluginWarning ? [options.pluginWarning] : [],
    appToolsAvailable: false,
    pluginServerNames: [],
  };
  return {
    clientName: options.clientName,
    planMode: preset === 'plan',
    projectionLimitMessage: CURSOR_STEP_LIMIT_MESSAGE,
    secretValues: options.secretValues,
    authorizeNative: (payload) =>
      Promise.resolve(headlessCursorDecision(preset, payload)),
    authorizeMcp: (call) =>
      Promise.resolve(headlessCursorMcpDecision(preset, call)),
    prepareMcp: () => Promise.resolve(emptyMcp),
    beforePrompt: ({
      mcp,
      contextLost,
      announce,
    }): Promise<{ instructions: string; inheritedContext?: string }> => {
      for (const notice of mcp.notices) announce(`${notice}\n\n`);
      if (contextLost)
        // The turn driver could not `loadSession` the id it was given and
        // started a fresh one instead. A `builtin/agent-resume` step turns
        // this into a hard failure (cursor-prompt-runner.ts checks
        // `outcome.contextLost` once the turn resolves); this notice makes
        // that failure legible in the transcript rather than a bare error.
        announce(
          'This step could not restore its saved Cursor conversation; a new session was started.\n\n',
        );
      const instructions = [
        preset === 'plan' ? CURSOR_PLAN_MODE_STEERING : undefined,
        toolSteering,
        options.instructions,
      ]
        .filter(Boolean)
        .join('\n\n');
      return Promise.resolve({ instructions });
    },
    emit: options.emit,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    ...(options.rtk
      ? { rtk: (): CursorTurnRtk | undefined => options.rtk }
      : {}),
  };
}
