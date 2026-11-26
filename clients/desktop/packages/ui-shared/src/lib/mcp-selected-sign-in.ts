import type { McpCardAuthStatus } from './mcp-card-display';

export function mcpServerNameList(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(' and ')
    : names.length === 3
      ? `${names[0]}, ${names[1]}, and ${names[2]}`
      : `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

export function mcpSignInSummary(names: readonly string[]): string {
  return `Sign in to use ${mcpServerNameList(names)}`;
}

export interface SelectedMcpSignInStatus {
  readonly displayName: string;
  readonly authStatus: McpCardAuthStatus;
  readonly authStatusLabel: string;
  readonly canRefresh?: boolean;
  readonly connectActionLabel?: string;
  readonly source?: string;
}

/**
 * The row already shows the service name, so the status names only the state.
 * Operational errors and explicit no-auth/provider labels keep their own
 * vocabulary.
 */
export function mcpSignInStatusLabel(server: SelectedMcpSignInStatus): string {
  // A shared connection is signed in by a project admin, not the person, so
  // its label names the connection's state rather than asking for a sign-in.
  if (server.source === 'shared') return server.authStatusLabel;
  if (server.connectActionLabel !== undefined) return server.authStatusLabel;
  if (server.authStatus === 'connected') return 'Connected';
  if (server.authStatus === 'not_connected') return 'Sign-in needed';
  if (server.authStatus === 'expired' && !server.canRefresh)
    return 'Sign-in expired';
  return server.authStatusLabel;
}
