import {
  PIPELINE_EDITOR_TOOL_ENTRIES,
  type PipelineEditorToolKey,
} from './pipeline-editor-tools';
/**
 * Identity of an MCP tool call as the pinned Cursor CLI reports it over ACP.
 *
 * The CLI titles both the `tool_call` update and the matching
 * `session/request_permission` request as `"<server>: <tool>"` with
 * `kind: "other"`. The `tool_call` update additionally carries a structured
 * `rawInput` of `{ providerIdentifier, toolName, args }`; the permission
 * request omits `rawInput`, so callers correlate it with the earlier update by
 * `toolCallId` and fall back to the title only when no structured input exists.
 *
 * Keep this file dependency-free apart from the injected-tool registry so the
 * main process (approval routing) and the renderer (transcript folding) share
 * one parser.
 */

import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_ENTRIES,
  APP_ADVISOR_TOOL_REGISTRY,
  type AppAdvisorToolKey,
} from './app-advisor-tools';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';

export interface CursorMcpToolCall {
  server: string;
  tool: string;
  args?: unknown;
}

/** Native ACP tool kinds the pinned CLI never uses for MCP calls. */
const NATIVE_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
]);
const MAX_IDENTIFIER_LENGTH = 256;
const TITLE_PATTERN = /^(\S[^:]*?): (\S.*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}

/**
 * Returns the MCP server and tool behind a Cursor ACP tool call, or `null`
 * when the payload describes a native tool (or nothing recognizable).
 * Structured `rawInput` wins; a title that disagrees with valid structured
 * input is rejected rather than trusted.
 */
export function parseCursorMcpToolCall(input: {
  title?: string | null;
  rawInput?: unknown;
  kind?: string | null;
}): CursorMcpToolCall | null {
  if (typeof input.kind === 'string' && NATIVE_TOOL_KINDS.has(input.kind))
    return null;
  const title = typeof input.title === 'string' ? input.title : '';
  const match = TITLE_PATTERN.exec(title);
  const fromTitle =
    match && validIdentifier(match[1]) && validIdentifier(match[2])
      ? { server: match[1], tool: match[2] }
      : null;
  if (isRecord(input.rawInput)) {
    const { providerIdentifier, toolName, args } = input.rawInput;
    if (
      typeof providerIdentifier === 'string' &&
      typeof toolName === 'string' &&
      validIdentifier(providerIdentifier) &&
      validIdentifier(toolName)
    ) {
      if (
        fromTitle &&
        (fromTitle.server !== providerIdentifier || fromTitle.tool !== toolName)
      )
        return null;
      return {
        server: providerIdentifier,
        tool: toolName,
        ...(args !== undefined ? { args } : {}),
      };
    }
  }
  return fromTitle;
}

/**
 * App tools that only read state, ask the user, or present content, so read-only plan mode may
 * still run them. Every other tool on the `cursor-acp` surface changes app
 * state or, for `WatchCommand`, runs a shell command.
 */
const CURSOR_READ_ONLY_APP_TOOL_KEYS: ReadonlySet<CanopyInjectedToolKey> =
  new Set<CanopyInjectedToolKey>([
    'get_script_output',
    'get_git_preferences',
    'search_memory',
    'read_memory',
    'read_pipeline_yaml',
    'show_files',
    'show_capabilities',
    'show_visual',
    'preview_visual',
    'get_file_comments',
    'search_actions',
    'search_watchers',
    'get_github_pull_request_status',
    'ask_user_question',
    'get_code_graph_context',
    'query_code_graph',
    'search_code_graph',
    'explain_code_symbol',
    'get_impact_radius',
    'detect_changed_symbols',
    'compare_change_impact',
    'get_review_context',
  ]);

/** Whether read-only plan mode may run this app tool from a Cursor chat. */
export function isReadOnlyCursorAppTool(key: CanopyInjectedToolKey): boolean {
  return CURSOR_READ_ONLY_APP_TOOL_KEYS.has(key);
}

/** Which of the app's tool sets a Cursor session was created for. */
export type CursorCanopyServerMode =
  | 'default'
  | 'app-advisor'
  | 'pipeline-editor';

/**
 * The two MCP server names this app registers for a Cursor chat. The main
 * server carries the worktree tool set by default and the App Advisor tool
 * set in App Advisor sessions; the proxy announces the same names in its
 * `serverInfo`, and Claude configures them identically.
 */
export function cursorCanopyMcpServerNames(
  mode: CursorCanopyServerMode = 'default',
): {
  main: string;
  ui: string;
} {
  return {
    main:
      mode === 'app-advisor'
        ? `${BRAND.tools.namespace}_app_advisor`
        : mode === 'pipeline-editor'
          ? `${BRAND.tools.namespace}_pipeline_editor`
          : BRAND.tools.namespace,
    ui: `${BRAND.tools.namespace}_ui`,
  };
}

/** Which app tool set a Cursor route carries on its main server. */
export type CursorCanopyToolSurface =
  | 'cursor-acp'
  | 'cursor-acp-standalone'
  | 'copilot-sdk'
  | 'opencode-acp'
  | 'opencode-acp-standalone'
  | 'copilot-sdk-standalone';

/**
 * Maps a Cursor MCP call on one of this app's own servers to its canonical
 * injected-tool key. Anything on another server, or a tool the given surface
 * does not advertise, resolves to `null`. The Cowork surface is a strict subset
 * of the worktree one, so callers that only need an identity (transcript
 * display, the turn driver's gate bookkeeping) may keep the default; the
 * approval policy and the proxy pass the route's real surface.
 */
export function resolveCursorCanopyToolKey(
  call: Pick<CursorMcpToolCall, 'server' | 'tool'>,
  // Identity-only callers (the turn driver, the headless policy, transcript
  // display) rely on this default being a superset of every other surface;
  // the strict-subset test in cursor-mcp-tool-call.test.ts guards that.
  surface: CursorCanopyToolSurface = 'cursor-acp',
): CanopyInjectedToolKey | null {
  const names = cursorCanopyMcpServerNames();
  const allowlist =
    call.server === names.main
      ? surface
      : call.server === names.ui
        ? 'native-sdk-ui'
        : null;
  if (!allowlist) return null;
  return (
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[allowlist].find(
      (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].displayName === call.tool,
    ) ?? null
  );
}

/**
 * Maps a Cursor MCP call on the App Advisor servers to its canonical App
 * Advisor tool key. AskUserQuestion lives only on the `_ui` server, every
 * other tool only on the main server; anything else resolves to `null`.
 */
export function resolveCursorAppAdvisorToolKey(
  call: Pick<CursorMcpToolCall, 'server' | 'tool'>,
): AppAdvisorToolKey | null {
  const names = cursorCanopyMcpServerNames('app-advisor');
  if (call.server === names.ui)
    return call.tool === APP_ADVISOR_TOOL_REGISTRY.ask_user_question.displayName
      ? 'ask_user_question'
      : null;
  if (call.server !== names.main) return null;
  const entry = APP_ADVISOR_TOOL_ENTRIES.find(
    (candidate) =>
      candidate.canonicalKey !== 'ask_user_question' &&
      candidate.displayName === call.tool,
  );
  return entry?.canonicalKey ?? null;
}

/** Pipeline Assistant tools are isolated from the worktree and Advisor sets. */
export function resolveCursorPipelineEditorToolKey(
  call: Pick<CursorMcpToolCall, 'server' | 'tool'>,
): PipelineEditorToolKey | null {
  const names = cursorCanopyMcpServerNames('pipeline-editor');
  const entry = PIPELINE_EDITOR_TOOL_ENTRIES.find(
    (candidate) => candidate.displayName === call.tool,
  );
  if (
    !entry ||
    entry.canonicalKey === 'search_deferred_tools' ||
    entry.canonicalKey === 'load_deferred_tools'
  )
    return null;
  return (
    entry.canonicalKey === 'ask_user_question'
      ? call.server === names.ui
      : call.server === names.main
  )
    ? entry.canonicalKey
    : null;
}
