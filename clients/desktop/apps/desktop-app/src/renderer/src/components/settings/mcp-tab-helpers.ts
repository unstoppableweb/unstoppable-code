import type { McpProxyState } from '@canopy/execution-engine/types/mcp-servers';
import { brandText } from '@/lib/brand';
import type { InlineFailure } from '@/lib/inline-app-error';

export const MCP_PORT_VALIDATION_ERROR = 'Enter a port from 1 to 65535.';
export const MCP_SAVE_ERROR_FALLBACK = 'Could not save MCP proxy settings.';
export const MCP_PROXY_ERROR_COPY = "The MCP proxy couldn't start.";

/**
 * The proxy error banner. A failed apply keeps its own error and details.
 * A proxy that couldn't start shows main's reason as the banner's text: it
 * is written for people (the port and what to do), and a release build
 * never shows a banner's raw details.
 */
export function mcpProxyErrorBanner(
  applyError: InlineFailure | null,
  proxyState: McpProxyState | null,
): { error: InlineFailure['error'] | null; details?: string } {
  if (applyError !== null)
    return {
      error: applyError.error,
      ...(applyError.details === undefined
        ? {}
        : { details: applyError.details }),
    };
  if (proxyState?.status !== 'error') return { error: null };
  const reason = proxyState.error?.trim();
  return { error: reason ? reason : MCP_PROXY_ERROR_COPY };
}
export const MCP_SAVED_TEXT = 'MCP proxy settings saved.';

export const MCP_HTTP_AUTH_HEADING = 'HTTP MCP server auth';
/** The HTTP auth helper naming the activity card by its displayed title. */
export function mcpHttpAuthHelper(mcpSectionTitle: string): string {
  return `Server toggles in the ${mcpSectionTitle} activity card can override this for a chat.`;
}

export const MCP_HTTP_AUTH_HELPER = mcpHttpAuthHelper('MCP servers');

/**
 * Brand-aware labels and descriptions are lazy getters so renderer copy
 * follows the active brand without re-importing the module. Tests that read
 * these read the resolved string at access time.
 */
export const MCP_HTTP_AUTH_CANOPY_LABEL = `${brandText.appName} proxy`;
export const MCP_HTTP_AUTH_PROVIDER_LABEL = 'Agent provider';
export const MCP_HTTP_AUTH_CANOPY_DESCRIPTION = `${brandText.appName} handles OAuth through its local 127.0.0.1 proxy, stores tokens in secure local storage, and shares the same connection across Claude and Codex.`;
export const MCP_HTTP_AUTH_PROVIDER_DESCRIPTION =
  'Claude and Codex handle MCP auth directly. You may need to authenticate with Claude and Codex separately for the same server.';

/**
 * Parses a port string, returning the integer when it represents a valid
 * port (1..65535) or `null` when the input is malformed or out of range.
 * Exported so tests can verify the validator without rendering the tab.
 */
export function parseMcpProxyPort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1 || parsed > 65535) return null;
  return parsed;
}
