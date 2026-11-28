// ---------------------------------------------------------------------------
// Shared helpers for HTTP MCP auth handler preferences.
//
// This module is consumed by both the renderer (toggle UI) and the main
// process (inventory effective-handler computation, resolver, normalization).
// The functions are intentionally pure so they round-trip across the IPC
// boundary without behavioural drift.
// ---------------------------------------------------------------------------

import type { ChatTabPluginSelections } from '../execution-types';
import type {
  McpHttpAuthHandler,
  McpHttpAuthPreference,
  McpHttpAuthTarget,
  McpServerDefinitionData,
  McpServerIndexEntry,
} from '../types/mcp-servers';
import { mcpHttpAuthTargetKey } from '@canopy/protocol/mcp-servers';

/** Every handler the protocol defines; leaving one out fails to compile. */
const MCP_HTTP_AUTH_HANDLERS: Readonly<Record<McpHttpAuthHandler, true>> = {
  canopy: true,
  provider: true,
  account: true,
};

/** Whether `value` is an HTTP MCP auth handler the protocol defines. */
export function isMcpHttpAuthHandler(
  value: unknown,
): value is McpHttpAuthHandler {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(MCP_HTTP_AUTH_HANDLERS, value)
  );
}

export { mcpHttpAuthTargetKey };

/**
 * Resolve the effective HTTP MCP auth handler for `target`, given the chat's
 * `selections` and the global `defaultHandler` preference.
 *
 * Returns both the resolved handler and a `source` discriminator so callers
 * (UI badges, audit logs) can distinguish defaulted from overridden values.
 *
 * If a matching preference exists but its `handler` field is not a known
 * {@link McpHttpAuthHandler} value (e.g. corrupted persisted state), it is
 * ignored and the default is returned.
 */
export function getMcpHttpAuthHandler(
  selections: ChatTabPluginSelections,
  target: McpHttpAuthTarget,
  defaultHandler: McpHttpAuthHandler,
): { handler: McpHttpAuthHandler; source: 'default' | 'override' } {
  const preferences = selections.mcpHttpAuthPreferences;
  if (!preferences || preferences.length === 0) {
    return { handler: defaultHandler, source: 'default' };
  }

  const key = mcpHttpAuthTargetKey(target);
  for (let index = preferences.length - 1; index >= 0; index -= 1) {
    const preference = preferences[index];
    if (mcpHttpAuthTargetKey(preference.target) !== key) {
      continue;
    }
    if (!isMcpHttpAuthHandler(preference.handler)) {
      continue;
    }
    return { handler: preference.handler, source: 'override' };
  }

  return { handler: defaultHandler, source: 'default' };
}

/**
 * Return a new {@link ChatTabPluginSelections} with the preference for
 * `target` set to `handler`. Any pre-existing preference for the same target
 * key is replaced; all other fields (`collectionIds`, `skillRefs`, `pluginRefs`,
 * `mcpServerRefs`, and unrelated preferences) are preserved exactly.
 *
 * The input `selections` is never mutated.
 */
export function setMcpHttpAuthPreference(
  selections: ChatTabPluginSelections,
  target: McpHttpAuthTarget,
  handler: McpHttpAuthHandler,
): ChatTabPluginSelections {
  const targetKey = mcpHttpAuthTargetKey(target);
  const existing = selections.mcpHttpAuthPreferences ?? [];
  const filtered: McpHttpAuthPreference[] = [];
  for (const preference of existing) {
    if (mcpHttpAuthTargetKey(preference.target) === targetKey) {
      continue;
    }
    filtered.push(preference);
  }
  filtered.push({ target, handler });

  return {
    ...selections,
    mcpHttpAuthPreferences: filtered,
  };
}

/** Definition and chat preferences retain precedence over an index default. */
export function getMcpHttpAuthDefault(
  definition: McpServerDefinitionData,
  entry: Pick<McpServerIndexEntry, 'scope' | 'authHandler'> | undefined,
  globalHandler: McpHttpAuthHandler,
): McpHttpAuthHandler {
  return (
    definition.httpAuthHandler ??
    entry?.authHandler ??
    (entry?.scope === 'account' ? 'account' : globalHandler)
  );
}
