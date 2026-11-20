import type {
  UnifiedEntryConnectionStatus,
  UnifiedEntryPlacement,
  UnifiedPluginEntry,
} from './unified-plugin-entry';

/** Several configurations also require target selection on one server. */
export function mcpHasMultipleTargets(entry: UnifiedPluginEntry): boolean {
  return (
    Math.max(
      entry.mcpTargetCount ?? 0,
      entry.integration?.connections.length ?? 0,
    ) > 1
  );
}

/**
 * Whether a server on this device stands behind the row: a device connection
 * on an integration card, or a standalone server outside the account. An
 * account-only row has connections to remove, never a server to delete.
 */
export function mcpRowHasDeviceServer(entry: UnifiedPluginEntry): boolean {
  const connections = entry.integration?.connections;
  if (connections !== undefined)
    return connections.some((connection) => connection.binding === 'device');
  return entry.placement !== 'account';
}

/** The one action a Customize MCP row offers inline. */
export type McpRowInlineAction = 'test' | 'connect' | 'reconnect';

export interface McpRowHealthModel {
  readonly text: string;
  readonly tone: 'positive' | 'attention' | 'destructive' | 'neutral';
  /** A valid check time, never later than now. */
  readonly checkedAt?: string;
  readonly action: McpRowInlineAction | null;
}

/** A timestamp fit to show: valid, and clamped so it never reads as future. */
function displayableCheckTime(
  value: string | undefined,
  now: number,
): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return time > now ? new Date(now).toISOString() : value;
}

/**
 * What a Customize MCP row says and offers. Sign-in wording follows the auth
 * state, never the health alone, so a first Connect is not called a reconnect.
 */
export function mcpRowHealthModel(
  connection: UnifiedEntryConnectionStatus,
  options: {
    readonly disabled?: boolean;
    readonly canTest?: boolean;
    readonly now?: number;
  } = {},
): McpRowHealthModel {
  const checkedAt = displayableCheckTime(
    connection.lastCheckedAt,
    options.now ?? Date.now(),
  );
  const withTime = checkedAt === undefined ? {} : { checkedAt };
  if (options.disabled === true || connection.disabled === true)
    return {
      text: 'Not checked while disabled',
      tone: 'neutral',
      action: null,
    };
  if (connection.signIn === 'reconnect')
    return {
      text: 'Needs reconnecting',
      tone: 'attention',
      action: 'reconnect',
      ...withTime,
    };
  if (connection.signIn === 'connect' || connection.status === 'auth_required')
    return {
      text: 'Sign-in needed',
      tone: 'attention',
      action: 'connect',
      ...withTime,
    };
  switch (connection.status) {
    case 'connected':
      return {
        text: 'Connected',
        tone: 'positive',
        ...withTime,
        action: 'test',
      };
    case 'unreachable':
      return {
        text: "Couldn't connect",
        tone: 'destructive',
        ...withTime,
        action: 'test',
      };
    case 'unknown':
      return {
        text: 'Not checked yet',
        tone: 'neutral',
        ...withTime,
        action:
          connection.requirementUnknown === true
            ? 'connect'
            : options.canTest === false
              ? null
              : 'test',
      };
  }
}

const SEVERITY: Readonly<
  Record<UnifiedEntryConnectionStatus['status'], number>
> = { unreachable: 3, auth_required: 2, unknown: 1, connected: 0 };

/**
 * One health for a card's several connections: the worst of those turned on,
 * so a disabled binding never hides another's failure. It shows a check time
 * only when every included binding has a valid one, and then the oldest.
 */
export function mcpAggregateConnection(
  bindings: readonly {
    readonly enabled: boolean;
    readonly connection: UnifiedEntryConnectionStatus;
  }[],
): UnifiedEntryConnectionStatus | undefined {
  const [first] = bindings;
  if (first === undefined) return undefined;
  const included = bindings
    .filter((binding) => binding.enabled)
    .map((binding) => binding.connection);
  if (included.length === 0)
    return { status: first.connection.status, disabled: true };
  const worst = included.reduce((current, candidate) =>
    SEVERITY[candidate.status] > SEVERITY[current.status] ? candidate : current,
  );
  const times = included.map((connection) =>
    connection.lastCheckedAt === undefined
      ? NaN
      : Date.parse(connection.lastCheckedAt),
  );
  const worstBindings = included.filter(
    (item) => item.status === worst.status && worst.status !== 'unreachable',
  );
  const signIn = worstBindings.some((item) => item.signIn === 'reconnect')
    ? 'reconnect'
    : worstBindings.some((item) => item.signIn === 'connect')
      ? 'connect'
      : undefined;
  return {
    status: worst.status,
    ...(worst.provider === true ? { provider: true } : {}),
    ...(signIn !== undefined ? { signIn } : {}),
    ...(included.some(
      (item) =>
        item.status === worst.status && item.requirementUnknown === true,
    )
      ? { requirementUnknown: true }
      : {}),
    ...(times.every(Number.isFinite)
      ? { lastCheckedAt: new Date(Math.min(...times)).toISOString() }
      : {}),
  };
}

export function mcpPlacementLabel(placement: UnifiedEntryPlacement): string {
  switch (placement) {
    case 'account':
      return 'Cloud account';
    case 'desktop':
      return 'This device';
    case 'both':
      return 'Cloud account · This device';
  }
}
