import { session } from 'electron';

/**
 * The in-memory session behind the app's own sign-in pane
 * (`MCP_OAUTH_BROWSER_SCOPE`). It is never persisted and never shared with
 * the person's browser or a workspace browser.
 */
export const MCP_OAUTH_BROWSER_PARTITION = 'mcp-oauth';

/**
 * Forgets every sign-in the pane's session holds, so the next page it opens
 * asks who to sign in as (CAN-6226). Adding another account of a connector
 * would otherwise go straight through as the account the pane last signed in
 * with, and connect the same account twice. Every embedded sign-in shares
 * this session, so the caller holds the pane before its start reaches here:
 * the renderer refuses the start while another sign-in has the pane, and
 * nothing is cleared (CAN-7199).
 */
export async function clearMcpOAuthBrowserSession(): Promise<void> {
  await session.fromPartition(MCP_OAUTH_BROWSER_PARTITION).clearStorageData();
}
