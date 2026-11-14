import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';

/**
 * The hash a worker names a plugin MCP server's declaration by in
 * `owner.mcp.bind` (CAN-6168), and the owner compares with its own read:
 * SHA-256 of the declaration's stable JSON, as lowercase hex.
 */
export function pluginMcpServerContentHash(
  declaration: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(stableStringify(declaration))
    .digest('hex');
}
