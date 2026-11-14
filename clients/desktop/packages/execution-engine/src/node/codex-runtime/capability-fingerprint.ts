import { createHash } from 'node:crypto';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';
import type { DynamicToolSpec } from './generated/v2/DynamicToolSpec';
import type { SelectedCapabilityRoot } from './generated/v2/SelectedCapabilityRoot';
import { dynamicToolSetId } from './dynamic-tool-fingerprint';
import {
  CODEX_MCP_STDIO_LAUNCHER_COMMAND,
  isCodexMcpRouteId,
} from './mcp-stdio-auth';
import { codexStdioMcpCapabilityId } from './mcp-secret-broker';
import { pluginMcpServerContentHash } from '../plugins/plugin-mcp-content-hash';

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

export interface CodexCapabilitySnapshotInputs {
  roots?: readonly SelectedCapabilityRoot[];
  mcpServers?: Record<string, unknown>;
  /** The authority ids the fingerprint names its proxied servers by. */
  mcpAuthorityIds?: readonly string[];
  /**
   * The authority ids a fingerprint v1 named the same servers by, when they
   * differ (an in-process plugin route's key, CAN-6168): only to recognize a
   * session's v1 lease.
   */
  legacyMcpAuthorityIds?: readonly string[];
  dynamicTools?: readonly DynamicToolSpec[];
  toolSchemaProfile?: AiGatewayToolSchemaProfile;
}

/**
 * The host-neutral key the capability snapshot names a plugin HTTP server's
 * route by (fingerprint v2, CAN-6168): its plugin, its name there, its
 * declaration's content hash and whether it requires OAuth. Every host that
 * serves the same declaration computes the same key, whatever its proxy.
 */
export function codexPluginMcpSnapshotKey(source: {
  readonly marketplaceId: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly oauthRequired: boolean;
}): string {
  return `plugin-${createHash('sha256')
    .update(
      JSON.stringify([
        source.marketplaceId,
        source.pluginName,
        source.serverName,
        pluginMcpServerContentHash(source.declaration),
        source.oauthRequired,
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

/** The fingerprint version {@link createCodexCapabilitySnapshotIds} computes. */
export const CODEX_CAPABILITY_FINGERPRINT_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, entry]) => typeof entry === 'string')
    ? Object.fromEntries(entries.map(([key, entry]) => [key, String(entry)]))
    : undefined;
}

/**
 * Fingerprint v2 (CAN-6168): a stdio server is named by its capability id,
 * the digest of what it runs, whether this host reaches it through a stdio
 * broker's launcher (whose command, arguments and route are this host's own)
 * or runs it as written. Every other field stays.
 */
function hostNeutralMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (!isRecord(server) || typeof server.command !== 'string')
        return [name, server];
      const { command, args, cwd, env, ...policy } = server;
      const argv = Array.isArray(args)
        ? args.filter((arg): arg is string => typeof arg === 'string')
        : [];
      const marker = argv.lastIndexOf(CODEX_MCP_STDIO_LAUNCHER_COMMAND);
      const brokered =
        marker >= 0 &&
        /^[a-f0-9]{64}$/.test(argv[marker + 1] ?? '') &&
        isCodexMcpRouteId(argv[marker + 2] ?? '');
      const variables = stringRecord(env);
      const stdio = brokered
        ? (argv[marker + 1] ?? '')
        : codexStdioMcpCapabilityId({
            command: String(command),
            ...(argv.length > 0 && { args: argv }),
            ...(typeof cwd === 'string' && { cwd }),
            ...(variables && { env: variables }),
          });
      return [name, { ...policy, stdio }];
    }),
  );
}

function snapshotId(
  options: CodexCapabilitySnapshotInputs,
  mcpServers: Record<string, unknown>,
  mcpAuthorityIds: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        roots: (options.roots ?? []).map((root) => root.id),
        mcpServers: normalizeCapabilityConfigForFingerprint(
          mcpServers,
          mcpAuthorityIds,
        ),
        mcpAuthorityIds: [...mcpAuthorityIds].sort(),
        dynamicToolSetId: dynamicToolSetId([...(options.dynamicTools ?? [])]),
        toolSchemaProfile: options.toolSchemaProfile ?? 'standard',
      }),
    )
    .digest('hex');
}

/**
 * The capability snapshot's id (fingerprint v2, host-neutral, CAN-6168), and
 * the id fingerprint v1 gave the same capabilities on this host, so a
 * session's v1 lease can be recognized and upgraded. The two are equal for a
 * session with no stdio server and no renamed authority.
 */
export function createCodexCapabilitySnapshotIds(
  options: CodexCapabilitySnapshotInputs,
): { readonly snapshotId: string; readonly legacySnapshotId: string } {
  const servers = options.mcpServers ?? {};
  const authorityIds = options.mcpAuthorityIds ?? [];
  return {
    snapshotId: snapshotId(
      options,
      hostNeutralMcpServers(servers),
      authorityIds,
    ),
    legacySnapshotId: snapshotId(
      options,
      servers,
      options.legacyMcpAuthorityIds ?? authorityIds,
    ),
  };
}

/** The capability snapshot's id: fingerprint v2 (CAN-6168). */
export function createCodexCapabilitySnapshotId(
  options: CodexCapabilitySnapshotInputs,
): string {
  return createCodexCapabilitySnapshotIds(options).snapshotId;
}
