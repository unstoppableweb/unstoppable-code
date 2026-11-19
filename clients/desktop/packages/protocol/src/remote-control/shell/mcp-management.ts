import type {
  McpHttpAuthHandler,
  McpServerAuthStatus,
  McpServerConnectionStatus,
} from '../../mcp-servers';

/** Deliberately excludes service errors, credentials and configuration contents. */
export interface RemoteControlMcpServerStatus {
  connectionStatus: McpServerConnectionStatus;
  reachability: 'reachable' | 'unreachable' | 'unknown';
  handler?: McpHttpAuthHandler;
  configs: Array<{
    configId: string;
    authStatus: McpServerAuthStatus;
    expiresAt?: string;
    canRefresh?: boolean;
  }>;
  lastCheckedAt?: string;
}

export interface RemoteControlMcpTestConnectionResult {
  serverId: string;
  configId: string;
  success: boolean;
  message: string;
  error?: string;
  endpointReachable?: boolean;
  tools?: string[];
  responseTime?: number;
}

export interface RemoteControlMcpDeleteServerResult {
  deleted: true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/** Runtime allowlist: never spread service objects, including nested configs. */
export function projectRemoteControlMcpStatus(
  value: unknown,
): RemoteControlMcpServerStatus | undefined {
  if (!record(value)) return undefined;
  const connectionStatus = value.connectionStatus;
  const reachability = value.reachability;
  const handler = value.handler;
  const configs: RemoteControlMcpServerStatus['configs'] = [];
  if (Array.isArray(value.configs)) {
    for (const config of value.configs) {
      if (!record(config) || typeof config.configId !== 'string') continue;
      const authStatus = config.authStatus;
      if (
        authStatus !== 'unsupported' &&
        authStatus !== 'not_configured' &&
        authStatus !== 'not_connected' &&
        authStatus !== 'connected' &&
        authStatus !== 'expired' &&
        authStatus !== 'error'
      )
        continue;
      const expiresAt = timestamp(config.expiresAt);
      configs.push({
        configId: config.configId,
        authStatus,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(typeof config.canRefresh === 'boolean'
          ? { canRefresh: config.canRefresh }
          : {}),
      });
    }
  }
  const lastCheckedAt = timestamp(value.lastCheckedAt);
  return {
    connectionStatus:
      connectionStatus === 'connected' ||
      connectionStatus === 'auth_required' ||
      connectionStatus === 'unreachable'
        ? connectionStatus
        : 'unknown',
    reachability:
      reachability === 'reachable' || reachability === 'unreachable'
        ? reachability
        : 'unknown',
    ...(handler === 'canopy' || handler === 'account' || handler === 'provider'
      ? { handler }
      : {}),
    configs,
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
  };
}

/** Strict portable result guard for version-skewed peers. */
export function isRemoteControlMcpTestConnectionResult(
  value: unknown,
): value is RemoteControlMcpTestConnectionResult {
  return (
    record(value) &&
    typeof value.serverId === 'string' &&
    typeof value.configId === 'string' &&
    typeof value.success === 'boolean' &&
    typeof value.message === 'string' &&
    value.message.length <= 512 &&
    (value.error === undefined ||
      (typeof value.error === 'string' && value.error.length <= 512)) &&
    (value.endpointReachable === undefined ||
      typeof value.endpointReachable === 'boolean') &&
    (value.responseTime === undefined ||
      (typeof value.responseTime === 'number' &&
        Number.isFinite(value.responseTime) &&
        value.responseTime >= 0)) &&
    (value.tools === undefined ||
      (Array.isArray(value.tools) &&
        value.tools.length <= 1000 &&
        value.tools.every(
          (tool: unknown) =>
            typeof tool === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(tool),
        )))
  );
}
