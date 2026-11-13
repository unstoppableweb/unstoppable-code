import type { JsonValue } from './generated/serde_json/JsonValue';

/**
 * Repository instruction delivery for chat, delegate and pipeline threads.
 * Codex's 32 KiB default silently truncates larger AGENTS.md chains, and
 * CLAUDE.md-only repositories get no instructions. Thread config is not
 * persisted, so every start, resume and fork request must carry these keys.
 * 128 KiB is the per-chain policy budget.
 */
const PROJECT_DOC_FALLBACK_FILENAMES: string[] = ['CLAUDE.md'];
// Callers spread the constant, so every launch shares this array.
Object.freeze(PROJECT_DOC_FALLBACK_FILENAMES);
export const CODEX_PROJECT_DOC_THREAD_CONFIG = Object.freeze({
  project_doc_max_bytes: 131_072,
  project_doc_fallback_filenames: PROJECT_DOC_FALLBACK_FILENAMES,
});

function isJsonRecord(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the configured MCP servers that Codex will actually initialize.
 * Disabled declarations remain in the thread config so Codex can apply the
 * user's policy, but they must not hold the selected-server readiness gate.
 */
export function enabledCodexMcpServerNames(
  config: { [key: string]: JsonValue | undefined } | null | undefined,
): string[] {
  const enabledByName = new Map<string, boolean>();
  const mcpServers = config?.mcp_servers;
  if (isJsonRecord(mcpServers)) {
    for (const [name, value] of Object.entries(mcpServers)) {
      enabledByName.set(name, !isJsonRecord(value) || value.enabled !== false);
    }
  }

  for (const [key, value] of Object.entries(config ?? {})) {
    const match = /^mcp_servers\.([^.]+)(?:\.(.+))?$/.exec(key);
    const name = match?.[1];
    if (!name) {
      continue;
    }
    const field = match?.[2];
    if (field === 'enabled' && typeof value === 'boolean') {
      enabledByName.set(name, value);
    } else if (!field) {
      enabledByName.set(name, !isJsonRecord(value) || value.enabled !== false);
    } else if (!enabledByName.has(name)) {
      enabledByName.set(name, true);
    }
  }

  return Array.from(enabledByName)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

/**
 * App-server's `ThreadStartParams.config` is a map of Codex override paths,
 * not a serialized config.toml object. Callers use nested objects because that
 * is the natural provider-neutral representation; flatten them at the runtime
 * boundary so tables such as `mcp_servers` and `model_providers` take effect.
 */
export function flattenCodexThreadConfig(
  config: { [key: string]: JsonValue | undefined } | null | undefined,
  options: { resetMcpServers?: boolean } = {},
): { [key: string]: JsonValue } | undefined {
  const flattened: { [key: string]: JsonValue } = {};
  // New threads send a complete MCP table so the request states its
  // selection. Codex merges that table into canonical config, so ambient
  // servers are removed separately by `excludeAmbientCodexMcpServers`.
  // Native fork must not reset this table because the persisted thread
  // already owns the immutable capability snapshot.
  if (options.resetMcpServers) {
    flattened.mcp_servers = {};
  }

  const projectOverride = (path: string, value: JsonValue): void => {
    if (isJsonRecord(value) && Object.keys(value).length > 0) {
      for (const [key, child] of Object.entries(value)) {
        // Each immediate child is one complete TOML table/value override.
        // In particular, Codex expects `mcp_servers.<name>` and
        // `model_providers.<name>` to retain their object values.
        flattened[`${path}.${key}`] = child;
      }
      return;
    }
    flattened[path] = value;
  };

  const dottedMcpNames = new Set<string>();
  const optionalServer = (value: JsonValue): JsonValue =>
    isJsonRecord(value) ? { ...value, required: false } : value;

  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined) {
      if (key === 'mcp_servers') {
        // A root reset plus `mcp_servers.<name>` overrides in the same request
        // causes Codex to discard the named servers. Replace the entire MCP
        // table atomically so canonical globals are excluded and selected
        // servers are retained.
        // Selections describe desired tools, not prerequisites for a turn.
        // Normalize here as well as in the resolver for direct runtime callers
        // and lease-validated configurations created by older app versions.
        flattened.mcp_servers = isJsonRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, server]) => [
                name,
                optionalServer(server),
              ]),
            )
          : value;
      } else if (key.startsWith('mcp_servers.')) {
        const match = /^mcp_servers\.([^.]+)(?:\.(.+))?$/.exec(key);
        const name = match?.[1];
        const field = match?.[2];
        if (name && !field) {
          flattened[key] = optionalServer(value);
        } else {
          flattened[key] = value;
          if (name) dottedMcpNames.add(name);
        }
      } else {
        projectOverride(key, value);
      }
    }
  }
  for (const name of Array.from(dottedMcpNames)) {
    flattened[`mcp_servers.${name}.required`] = false;
  }
  return Object.keys(flattened).length > 0 ? flattened : undefined;
}

const MCP_OVERRIDE_KEY = /^mcp_servers\.([^.]+)(?:\.(.+))?$/;

/** Enabled MCP servers in a `config/read` response's effective config. */
export function ambientCodexMcpServerNames(
  configReadResponse: unknown,
): string[] {
  const response = isUnknownRecord(configReadResponse)
    ? configReadResponse
    : undefined;
  const config = isUnknownRecord(response?.config)
    ? response.config
    : undefined;
  const servers = isUnknownRecord(config?.mcp_servers)
    ? config.mcp_servers
    : undefined;
  return Object.entries(servers ?? {})
    .filter(
      ([, server]) => !isUnknownRecord(server) || server.enabled !== false,
    )
    .map(([name]) => name);
}

/**
 * Codex merges a thread's `mcp_servers` override into canonical config, so
 * neither an empty table nor a table of selected servers removes servers the
 * user configured globally or in a project layer; only `enabled = false`
 * does. Disable every ambient server the request does not name.
 */
export function excludeAmbientCodexMcpServers(
  config: { [key: string]: JsonValue } | undefined,
  ambientServerNames: readonly string[],
): { [key: string]: JsonValue } | undefined {
  const named = new Set<string>();
  const root = config?.mcp_servers;
  if (isJsonRecord(root)) {
    for (const name of Object.keys(root)) named.add(name);
  }
  for (const key of Object.keys(config ?? {})) {
    const name = MCP_OVERRIDE_KEY.exec(key)?.[1];
    if (name) named.add(name);
  }
  const excluded = ambientServerNames.filter((name) => !named.has(name));
  if (excluded.length === 0) return config;

  if (!isJsonRecord(root)) {
    const next: { [key: string]: JsonValue } = { ...(config ?? {}) };
    for (const name of excluded) next[`mcp_servers.${name}.enabled`] = false;
    return next;
  }

  // Codex drops dotted `mcp_servers.*` keys sent beside a root table, so fold
  // them into the single table that carries the disables.
  const table: { [key: string]: JsonValue } = { ...root };
  const next: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const match = MCP_OVERRIDE_KEY.exec(key);
    const name = match?.[1];
    if (!name) {
      next[key] = value;
      continue;
    }
    const field = match?.[2];
    table[name] = field
      ? withNestedValue(table[name], field.split('.'), value)
      : isJsonRecord(value) && isJsonRecord(table[name])
        ? { ...table[name], ...value }
        : value;
  }
  for (const name of excluded) table[name] = { enabled: false };
  next.mcp_servers = table;
  return next;
}

function withNestedValue(
  target: JsonValue | undefined,
  path: readonly string[],
  value: JsonValue,
): JsonValue {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const record: { [key: string]: JsonValue } = isJsonRecord(target)
    ? { ...target }
    : {};
  record[head] = withNestedValue(record[head], rest, value);
  return record;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove MCP configuration only for operations that must inherit the owning
 * thread's already-loaded runtime unchanged, such as a native fork. A resume
 * in a fresh app-server must reapply the lease-validated MCP table because
 * Codex rollouts do not persist thread-scoped config overrides.
 */
export function omitCodexMcpServersFromThreadConfig(
  config: { [key: string]: JsonValue | undefined } | null | undefined,
): { [key: string]: JsonValue | undefined } | undefined {
  if (!config) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== 'mcp_servers' && !key.startsWith('mcp_servers.'),
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
