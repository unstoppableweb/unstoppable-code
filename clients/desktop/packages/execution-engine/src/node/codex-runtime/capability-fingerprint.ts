import { createHash } from 'node:crypto';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';
import type { DynamicToolSpec } from './generated/v2/DynamicToolSpec';
import type { SelectedCapabilityRoot } from './generated/v2/SelectedCapabilityRoot';
import { dynamicToolSetId } from './dynamic-tool-fingerprint';
import { isCodexMcpRouteId } from './mcp-stdio-auth';

function normalizeProcessLocalRoute(
  value: string,
  hasParentHttpAuthority: boolean,
): string {
  if (isCodexMcpRouteId(value)) return '<parent-stdio-route>';
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (
      hasParentHttpAuthority &&
      loopback &&
      (url.pathname.includes('/mcp/proxy/') ||
        /^\/mcp\/[^/]+$/.test(url.pathname))
    ) {
      return '<parent-http-route>';
    }
  } catch {
    // Non-URL configuration strings retain their exact value.
  }
  return value;
}

/** Remove process-local broker route ids while preserving their stable digest. */
export function normalizeCapabilityConfigForFingerprint(
  value: unknown,
  mcpAuthorityIds: readonly string[] = [],
): unknown {
  const authorityServerNames = new Set(
    mcpAuthorityIds.map((authorityId) => authorityId.split(':', 1)[0]),
  );
  return normalizeCapabilityValue(value, authorityServerNames);
}

function normalizeCapabilityValue(
  value: unknown,
  authorityServerNames: ReadonlySet<string>,
  currentServerName?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string'
        ? normalizeProcessLocalRoute(
            item,
            currentServerName !== undefined &&
              authorityServerNames.has(currentServerName),
          )
        : normalizeCapabilityValue(
            item,
            authorityServerNames,
            currentServerName,
          ),
    );
  }
  if (typeof value === 'string') {
    return normalizeProcessLocalRoute(
      value,
      currentServerName !== undefined &&
        authorityServerNames.has(currentServerName),
    );
  }
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    const childIsMcpServer =
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      ('url' in child || 'command' in child);
    result[key] = normalizeCapabilityValue(
      child,
      authorityServerNames,
      childIsMcpServer ? key : currentServerName,
    );
  }
  return result;
}

export function createCodexCapabilitySnapshotId(options: {
  roots?: readonly SelectedCapabilityRoot[];
  mcpServers?: Record<string, unknown>;
  mcpAuthorityIds?: readonly string[];
  dynamicTools?: readonly DynamicToolSpec[];
  toolSchemaProfile?: AiGatewayToolSchemaProfile;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        roots: (options.roots ?? []).map((root) => root.id),
        mcpServers: normalizeCapabilityConfigForFingerprint(
          options.mcpServers ?? {},
          options.mcpAuthorityIds,
        ),
        mcpAuthorityIds: [...(options.mcpAuthorityIds ?? [])].sort(),
        dynamicToolSetId: dynamicToolSetId([...(options.dynamicTools ?? [])]),
        toolSchemaProfile: options.toolSchemaProfile ?? 'standard',
      }),
    )
    .digest('hex');
}
