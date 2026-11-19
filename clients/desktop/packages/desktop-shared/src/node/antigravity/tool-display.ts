function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Antigravity's path aliases, in the order the native tools prefer them. */
const PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath'] as const;

function nativePath(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const path = input[key];
    if (typeof path === 'string' && path.length > 0) return path;
  }
  return undefined;
}

/** Maps an advertised MCP route name back to the server's original name. */
export interface AntigravityToolRoutes {
  canonicalNameFor(
    server: string,
    tool: string,
  ): { server: string; tool: string } | undefined;
}

type NativeTool = 'Read' | 'Write' | 'Bash';

/** The renderer names for Antigravity's native tools, keyed by ACP kind. */
const NATIVE_BY_KIND: ReadonlyMap<string, NativeTool> = new Map([
  ['read', 'Read'],
  ['edit', 'Write'],
  ['execute', 'Bash'],
]);

/** Pre-1.5.1 exact titles, kept as a fallback for the same shapes. */
const NATIVE_BY_TITLE: ReadonlyMap<string, NativeTool> = new Map([
  ['read_file', 'Read'],
  ['write_file', 'Write'],
  ['run_command', 'Bash'],
]);

function nativeDisplay(
  native: NativeTool,
  input: Record<string, unknown>,
): { name: string; input: unknown } | undefined {
  if (native === 'Bash')
    return typeof input.CommandLine === 'string'
      ? { name: 'Bash', input: { command: input.CommandLine } }
      : undefined;
  const path = nativePath(input);
  if (path === undefined) return undefined;
  if (native === 'Read') return { name: 'Read', input: { file_path: path } };
  return {
    name: 'Write',
    input: {
      file_path: path,
      ...(typeof input.Content === 'string' ? { content: input.Content } : {}),
    },
  };
}

/**
 * Display-only translation of Antigravity 1.5.1's native tools and routed MCP
 * tools into the names the chat renderer already knows, for
 * `CursorEventProjection`'s `toolDisplay` option.
 *
 * Antigravity 1.5.1 titles native calls for people ("File README.md"), so a
 * native tool is recognized by its ACP `kind` and input keys: `read` with a
 * path key is Read, `edit` with a path key (and `Content` when present) is
 * Write, `execute` with `CommandLine` is Bash. The exact titles `read_file`,
 * `write_file` and `run_command` map to the same shapes as a fallback. A kind
 * or title whose expected input key is missing stays raw. Titles of the form
 * `mcp_<server>_<tool>` are routed MCP calls and never match by kind.
 *
 * `routes` maps an advertised route name back to the server's original name;
 * anything it does not know, a title that does not parse, or one more than one
 * route resolves is returned unchanged.
 */
export function antigravityToolDisplay(
  tool: { name: string; input: unknown; kind?: string },
  routes: AntigravityToolRoutes,
): { name: string; input: unknown } {
  const { name, input, kind } = tool;
  if (isRecord(input) && !name.startsWith('mcp_')) {
    const byKind = kind === undefined ? undefined : NATIVE_BY_KIND.get(kind);
    const byTitle = NATIVE_BY_TITLE.get(name);
    const display =
      (byKind && nativeDisplay(byKind, input)) ??
      (byTitle && nativeDisplay(byTitle, input));
    if (display) return display;
  }
  // The native gate names MCP tools mcp_<server>_<tool>. Server and tool
  // names may both contain `_`, so every split is checked against the routes;
  // when more than one resolves (`gh` and `gh_enterprise` for
  // mcp_gh_enterprise_list) the title is ambiguous and stays raw.
  if (name.startsWith('mcp_')) {
    const qualified = name.slice('mcp_'.length);
    let match: { server: string; tool: string } | undefined;
    let matches = 0;
    for (
      let split = qualified.indexOf('_');
      split > 0;
      split = qualified.indexOf('_', split + 1)
    ) {
      const toolName = qualified.slice(split + 1);
      if (!toolName) break;
      const canonical = routes.canonicalNameFor(
        qualified.slice(0, split),
        toolName,
      );
      if (canonical) {
        match = canonical;
        matches += 1;
      }
    }
    if (match && matches === 1)
      return { name: `mcp__${match.server}__${match.tool}`, input };
  }
  return { name, input };
}
