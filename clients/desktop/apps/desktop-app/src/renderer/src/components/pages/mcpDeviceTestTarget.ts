import { useCallback, useEffect, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  DetectedMcpServerInfo,
  McpHttpAuthHandler,
  McpServerIndexEntry,
  McpServerRef,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import type { McpTestTarget } from '@canopy/ui-app/capability';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import { mcpHasMultipleTargets } from '@canopy/ui-shared/lib/mcp-row-health';

/**
 * Every server row a target can resolve to: each listed row and the device
 * copies under it. The one projection that target resolution, the saved-server
 * revisions and the sign-in selections all walk, so a target that resolves is
 * always one the sign-in read was asked for.
 */
function mcpServerCandidates(
  servers: readonly McpServerIndexEntry[],
): McpServerIndexEntry[] {
  return servers.flatMap((row) => [row, ...(row.deviceCopies ?? [])]);
}

/**
 * The refs the row sign-in read is asked for: every configuration of every
 * candidate row, once each.
 */
export function mcpRowSelectionRefs(
  servers: readonly McpServerIndexEntry[],
): McpServerRef[] {
  const seen = new Set<string>();
  const refs: McpServerRef[] = [];
  for (const server of mcpServerCandidates(servers)) {
    for (const config of server.configs) {
      const key = `${server.id}\u0000${config.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ serverId: server.id, configId: config.id });
    }
  }
  return refs;
}

/** The saved device row whose timestamp identifies one concrete test target. */
function mcpDeviceServerOf(
  servers: readonly McpServerIndexEntry[],
  serverId: string,
  configId: string | undefined,
): McpServerIndexEntry | undefined {
  for (const candidate of mcpServerCandidates(servers)) {
    // Synthesized account rows have no saved-device revision.
    if (candidate.id !== serverId || candidate.updatedAt === '') continue;
    // A binding without a configuration id names the saved server itself:
    // a server with no configurations (develop's row Test ran it) or with
    // exactly one. Several configurations are ambiguous without an id.
    const matchesConfig =
      configId === undefined
        ? candidate.configs.length <= 1
        : candidate.configs.some((config) => config.id === configId);
    if (matchesConfig) return candidate;
  }
  return undefined;
}

/**
 * The route a saved HTTP server's probe takes, as main resolves it
 * (`getMcpHttpAuthDefault`): the server's own handler, else the app-wide
 * default. The index records a server's own handler only when it is Account,
 * so a definition that names Canopy or Provider reads as inheriting here.
 * It feeds the revision key: for an unknown own handler the key also moves
 * with the default, which can clear a kept result whose route did not change.
 * That is harmless. The page reads the default asynchronously and holds it as
 * null until the first read lands; Test waits for it only where this key
 * depends on it (`mcpRowTestEligibility`), so a result is never kept under a
 * default that was not read.
 */
function mcpDeviceHttpHandler(
  server: McpServerIndexEntry,
  defaultHandler: McpHttpAuthHandler,
): McpHttpAuthHandler {
  return (
    server.authHandler ??
    (server.scope === 'account' ? 'account' : defaultHandler)
  );
}

/**
 * A kept result belongs to the saved server and, for HTTP, to the auth route
 * it was probed through: changing the inherited default moves the route
 * without saving the server.
 */
function mcpDeviceRevision(
  server: McpServerIndexEntry,
  defaultHandler: McpHttpAuthHandler,
): string {
  return server.type === 'http'
    ? `${server.updatedAt}|${mcpDeviceHttpHandler(server, defaultHandler)}`
    : server.updatedAt;
}

interface McpDeviceTarget {
  readonly target: McpTestTarget;
  readonly server: McpServerIndexEntry;
}

function mcpDeviceTargetOf(
  entry: UnifiedPluginEntry,
  servers: readonly McpServerIndexEntry[],
  defaultHandler: McpHttpAuthHandler,
): McpDeviceTarget | null {
  if (mcpHasMultipleTargets(entry)) return null;
  const [only, ...others] = entry.integration?.connections ?? [];
  if (only) {
    if (others.length !== 0 || only.binding !== 'device') return null;
    const server = mcpDeviceServerOf(servers, only.serverId, only.configId);
    return server === undefined
      ? null
      : {
          target: {
            serverId: only.serverId,
            configId: only.configId,
            revision: mcpDeviceRevision(server, defaultHandler),
          },
          server,
        };
  }
  if (entry.ref.type !== 'local-mcp' || entry.placement !== 'desktop')
    return null;
  const { serverId } = entry.ref;
  const server = mcpDeviceServerOf(servers, serverId, entry.ref.configId);
  if (server === undefined) return null;
  const [onlyConfig, ...otherConfigs] = server.configs;
  return onlyConfig !== undefined && otherConfigs.length === 0
    ? {
        target: {
          serverId,
          configId: onlyConfig.id,
          revision: mcpDeviceRevision(server, defaultHandler),
        },
        server,
      }
    : null;
}

/**
 * The one saved device binding a row can test without opening its detail.
 * `defaultHandler` is the app-wide HTTP auth default, part of the identity.
 */
export function mcpDeviceTestTarget(
  entry: UnifiedPluginEntry,
  servers: readonly McpServerIndexEntry[],
  defaultHandler: McpHttpAuthHandler,
): McpTestTarget | null {
  const resolved = mcpDeviceTargetOf(entry, servers, defaultHandler);
  return resolved === null ? null : resolved.target;
}

/**
 * What one status read recorded. `scope` is the scope generation it was read
 * under (see `useMcpScopeGeneration`) and `revisions` the saved-server
 * revisions (`mcpServerRevisions`) the server list held when the read
 * started: a status describes a server only as saved at that revision.
 */
export interface McpStatusSnapshot {
  readonly scope: number;
  readonly entries: McpServerStatusEntry[];
  readonly revisions: ReadonlySet<string>;
}

/** One saved server as one revision of it: it moves with every save. */
export function mcpServerRevisionKey(server: McpServerIndexEntry): string {
  return `${server.id}\u0000${server.updatedAt}`;
}

export function mcpServerRevisions(
  servers: readonly McpServerIndexEntry[],
): ReadonlySet<string> {
  return new Set(mcpServerCandidates(servers).map(mcpServerRevisionKey));
}

/**
 * The handler a status read recorded for this saved server, or undefined when
 * the read gives none that can be trusted: no read, a read under another
 * scope generation (an equal default is not enough: A, then B, then A again
 * is a new scope), a read of an older revision of the server, or a list that
 * lacks the server or records no handler for it. Unknown is never a handler.
 */
function mcpMatchedStatusHandler(
  snapshot: McpStatusSnapshot | null,
  scopeGeneration: number,
  server: McpServerIndexEntry,
): McpHttpAuthHandler | undefined {
  if (
    snapshot === null ||
    snapshot.scope !== scopeGeneration ||
    !snapshot.revisions.has(mcpServerRevisionKey(server))
  )
    return undefined;
  // Limitation (CAN-7549): a status row names no source, so when main lists
  // an Account-synthesized status and a device one under the same id, this
  // takes the first HTTP row. Nothing in the DTO tells them apart; main
  // would have to add a discriminator.
  return snapshot.entries.find(
    (status) => status.serverId === server.id && status.transport === 'http',
  )?.handler;
}

/**
 * The handler the index itself records for an HTTP server: its own (the index
 * keeps Account, and may keep another), else Account for an account-scoped
 * server. Undefined means the route is inherited or unrecorded, so only a
 * status can say which one it is.
 */
function mcpRecordedHandler(
  server: McpServerIndexEntry,
): McpHttpAuthHandler | undefined {
  return server.scope === 'account' ? 'account' : server.authHandler;
}

/** The scope-dependent state the Test and Connect decisions read. */
export interface McpRowReadiness {
  readonly servers: readonly McpServerIndexEntry[];
  /** The app-wide HTTP auth default; null until the first read lands. */
  readonly authDefault: McpHttpAuthHandler | null;
  /** Increments whenever the default changes (`useMcpScopeGeneration`). */
  readonly scopeGeneration: number;
  /** Null when no status read has landed: pending, or every read failed. */
  readonly statusSnapshot: McpStatusSnapshot | null;
}

export interface McpRowConnectReadiness extends McpRowReadiness {
  /**
   * The scope generation the latest successful sign-in read applied under
   * (`useDetectedMcpServers`); null while it is pending, or after it failed.
   */
  readonly inventoryAppliedScope: number | null;
  /**
   * The saved-server revisions that read started under
   * (`useDetectedMcpServers`); null with `inventoryAppliedScope`.
   */
  readonly inventoryAppliedRevisions: ReadonlySet<string> | null;
  /** The servers that read returned, current only as the two above say. */
  readonly inventoryServers: readonly DetectedMcpServerInfo[];
  /**
   * True while a sign-in read for this hook has started and not landed
   * (`useDetectedMcpServers` `loading`). The applied values above are the
   * previous read's until it does: they can match the current keys and still
   * be about to be replaced, so they authorize nothing meanwhile.
   */
  readonly inventoryPending: boolean;
}

export type McpRowTestEligibility =
  | {
      readonly available: true;
      /** Undefined opens the detail, where the row's targets are tested. */
      readonly target: McpTestTarget | undefined;
    }
  | { readonly available: false; readonly reason: string };

export type McpRowConnectEligibility =
  /** Null target: no saved device binding, so the page's account or Add path. */
  | { readonly available: true; readonly target: null }
  | {
      readonly available: true;
      readonly target: McpTestTarget;
      /** The sign-in read's entry for this very target: what Connect runs on. */
      readonly detected: DetectedMcpServerInfo;
    }
  | { readonly available: false; readonly reason: string };

export const MCP_ROW_TEST_DISABLED_REASON =
  'Enable this server before testing its connection.';
export const MCP_ROW_CONNECT_NEEDS_CONFIG_REASON =
  'Add a configuration to sign in.';

/**
 * Whether the row's Test is offered, and for which target. A saved HTTP
 * server's route is its recorded handler, else the one the status read
 * resolved for it under the current default; until a status matches this very
 * server (same scope generation, same saved revision) it stays unavailable
 * rather than guessed, because Provider-managed and Account-needs-a-config
 * servers read the same as an inherited Canopy one without it. A missing,
 * failed or stale read is unknown, never "enabled".
 */
export function mcpRowTestEligibility(
  entry: UnifiedPluginEntry,
  readiness: McpRowReadiness,
): McpRowTestEligibility {
  const connection = entry.connection ?? entry.aggregateConnection;
  if (connection?.provider)
    return { available: false, reason: MCP_MANAGEMENT_REASONS.provider };
  if (connection?.disabled)
    return { available: false, reason: MCP_ROW_TEST_DISABLED_REASON };
  if (mcpHasMultipleTargets(entry))
    return { available: true, target: undefined };
  const resolved = mcpDeviceTargetOf(
    entry,
    readiness.servers,
    readiness.authDefault ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
  );
  if (resolved === null)
    return { available: false, reason: MCP_MANAGEMENT_REASONS.cloudTest };
  const { server, target } = resolved;
  if (server.type !== 'http') return { available: true, target };
  const recorded = mcpRecordedHandler(server);
  let handler = recorded;
  if (handler === undefined) {
    handler =
      readiness.authDefault === null
        ? undefined
        : mcpMatchedStatusHandler(
            readiness.statusSnapshot,
            readiness.scopeGeneration,
            server,
          );
    if (handler === undefined)
      return {
        available: false,
        reason: MCP_MANAGEMENT_REASONS.loadingSettings,
      };
  }
  if (handler === 'provider')
    return { available: false, reason: MCP_MANAGEMENT_REASONS.provider };
  // Main refuses this probe: an Account route needs a saved configuration.
  if (handler === 'account' && server.configs.length === 0)
    return { available: false, reason: MCP_MANAGEMENT_REASONS.noConfig };
  return { available: true, target };
}

/**
 * Whether the row's Connect (Connect, Reconnect, Sign in) on a saved device
 * server is offered. Signing in needs a saved configuration, and the run
 * looks its server up in the sign-in read, so that read must have applied
 * (a pending or failed one leaves nothing to sign in to). For an HTTP server
 * whose handler the index does not record, the sign-in state and the status
 * both depend on the current default: wait for a status matching this server
 * and a sign-in read applied under the current scope generation. The read must
 * also have started at this saved revision of the server (a save that keeps
 * every id leaves the selections equal, and an older read would describe the
 * server as it was), and must contain this very target: a read that applied
 * without it (it could not load the definition) leaves nothing to run, and is
 * held like a pending one. A read that has started and not landed holds it
 * too, even when the applied one still matches every key: that read is about
 * to replace it (an auth event or a save may be what started it).
 */
export function mcpRowConnectEligibility(
  entry: UnifiedPluginEntry,
  readiness: McpRowConnectReadiness,
): McpRowConnectEligibility {
  const fallback = readiness.authDefault ?? DEFAULT_MCP_HTTP_AUTH_HANDLER;
  const resolved = mcpDeviceTargetOf(entry, readiness.servers, fallback);
  if (resolved === null) return { available: true, target: null };
  // A saved device server without configurations has a Test target but
  // nothing to sign in to: Add would open the catalog flow for a server the
  // user already saved.
  if (resolved.server.configs.length === 0)
    return {
      available: false,
      reason: MCP_ROW_CONNECT_NEEDS_CONFIG_REASON,
    };
  const loading: McpRowConnectEligibility = {
    available: false,
    reason: MCP_MANAGEMENT_REASONS.loadingSettings,
  };
  if (
    readiness.inventoryPending ||
    readiness.inventoryAppliedScope === null ||
    readiness.inventoryAppliedRevisions === null ||
    !readiness.inventoryAppliedRevisions.has(
      mcpServerRevisionKey(resolved.server),
    )
  )
    return loading;
  if (
    resolved.server.type === 'http' &&
    mcpRecordedHandler(resolved.server) === undefined &&
    (readiness.authDefault === null ||
      readiness.inventoryAppliedScope !== readiness.scopeGeneration ||
      mcpMatchedStatusHandler(
        readiness.statusSnapshot,
        readiness.scopeGeneration,
        resolved.server,
      ) === undefined)
  )
    return loading;
  const { target } = resolved;
  const detected = readiness.inventoryServers.find(
    (candidate) =>
      candidate.serverId === target.serverId &&
      candidate.configId === target.configId,
  );
  if (detected === undefined) return loading;
  return { available: true, target, detected };
}

/**
 * Whether a read that applied still lacks a saved device configuration the
 * rows can target: it returned without it (main may answer with a partial
 * inventory and a warning). Account rows without a saved revision are never
 * targets, so main omitting them is not a lack.
 */
export function mcpInventoryLacksTarget(
  servers: readonly McpServerIndexEntry[],
  inventoryServers: readonly DetectedMcpServerInfo[],
): boolean {
  return mcpServerCandidates(servers).some(
    (candidate) =>
      candidate.updatedAt !== '' &&
      candidate.configs.some(
        (config) =>
          !inventoryServers.some(
            (detected) =>
              detected.serverId === candidate.id &&
              detected.configId === config.id,
          ),
      ),
  );
}

/**
 * Whether a Connect that started from `clicked` still describes the page:
 * the same scope generation, and the same saved revision of the target's
 * server. `latest` reads what the page holds now (it is called after the
 * sign-in resolves, long after the render the click came from).
 */
export function mcpRowConnectIsCurrent(
  clicked: McpRowReadiness,
  latest: () => McpRowReadiness,
  target: McpTestTarget,
): () => boolean {
  const revisionOf = (servers: readonly McpServerIndexEntry[]): string | null =>
    mcpDeviceServerRevision(servers, target.serverId, target.configId);
  const scope = clicked.scopeGeneration;
  const revision = revisionOf(clicked.servers);
  return (): boolean => {
    if (revision === null) return false;
    const now = latest();
    return (
      now.scopeGeneration === scope && revisionOf(now.servers) === revision
    );
  };
}

/** What a row's Connect click runs on, all of it the render's own. */
export interface McpRowConnectRun {
  readonly entry: UnifiedPluginEntry;
  readonly target: McpTestTarget;
  /** The sign-in read's entry for `target`, from the same decision. */
  readonly detected: DetectedMcpServerInfo;
  readonly connect: (
    server: DetectedMcpServerInfo,
    options: { readonly signInRequired: boolean },
  ) => Promise<boolean>;
  /** The probe alone; rejects with the failure to show. */
  readonly runTest: (target: McpTestTarget) => Promise<void>;
  readonly refreshStatuses: () => Promise<void>;
  readonly clearError: () => void;
  readonly onProbeStarted: () => void;
  /**
   * Whether the scope and the target's saved revision are still the ones the
   * click was made under (`mcpRowConnectIsCurrent`). The sign-in can take
   * minutes, and a save in between leaves every id in place.
   */
  readonly isCurrent: () => boolean;
}

/**
 * A row's Connect, Reconnect or Sign in: sign in when the row needs it, then
 * test. Resolves `'cancelled'` when the sign-in did not complete, before any
 * probe started. The sign-in runs on the entry the decision found
 * (`mcpRowConnectEligibility`), never on one looked up again here. When the
 * scope or the server's revision moved while it ran, nothing is probed and no
 * status is refreshed for this click: the new revision's own read takes over,
 * and the row's last result stands. That too resolves `'cancelled'`.
 */
export async function runMcpRowConnect({
  entry,
  target,
  detected,
  connect,
  runTest,
  refreshStatuses,
  clearError,
  onProbeStarted,
  isCurrent,
}: McpRowConnectRun): Promise<'cancelled' | undefined> {
  clearError();
  const connection = entry.connection ?? entry.aggregateConnection;
  const signInRequired =
    connection?.status === 'auth_required' ||
    connection?.signIn === 'connect' ||
    connection?.signIn === 'reconnect';
  if (
    (detected.canConnect || signInRequired) &&
    !(await connect(detected, { signInRequired }))
  )
    return 'cancelled';
  if (!isCurrent()) return 'cancelled';
  onProbeStarted();
  // The status re-read runs after a failed probe too, but its own failure
  // never replaces the probe's: the probe is what the person asked for.
  try {
    await runTest(target);
  } catch (probeError) {
    try {
      await refreshStatuses();
    } catch (refreshError) {
      reportClientAppError(refreshError);
    }
    throw probeError;
  }
  await refreshStatuses();
  return undefined;
}

/**
 * A row Test's probe and its status re-read, paired so the re-read's failure is
 * reported exactly once. The shared row re-reads after the probe whether it
 * failed or not and keeps a failed probe's error over the re-read's, and
 * `@canopy/ui-app` has no reporter. When the probe succeeded, the re-read's
 * rejection reaches the page banner, which records it; when the probe failed,
 * it never does, so it is reported here. Either way the re-read still rejects.
 */
export function mcpRowTestRun(
  runTest: () => Promise<void>,
  refreshStatuses: () => Promise<void>,
): {
  readonly run: () => Promise<void>;
  readonly refresh: () => Promise<void>;
} {
  let probeFailed = false;
  return {
    run: async (): Promise<void> => {
      probeFailed = false;
      try {
        await runTest();
      } catch (error) {
        probeFailed = true;
        throw error;
      }
    },
    refresh: async (): Promise<void> => {
      try {
        await refreshStatuses();
      } catch (error) {
        if (probeFailed) reportClientAppError(error);
        throw error;
      }
    },
  };
}

/**
 * The revision of the saved device server `serverId` and `configId` name, or
 * null when no such server is saved: the same key `mcpRowConnectIsCurrent`
 * compares and `mcpServerRevisions` lists.
 */
export function mcpDeviceServerRevision(
  servers: readonly McpServerIndexEntry[],
  serverId: string | undefined,
  configId: string | undefined,
): string | null {
  if (serverId === undefined) return null;
  const saved = mcpDeviceServerOf(servers, serverId, configId);
  return saved === undefined ? null : mcpServerRevisionKey(saved);
}

/**
 * Whether the revision an earlier attempt ran under is still the page's: a
 * save leaves the ids in place and replaces the revision. Only the attempted
 * server's own revision counts (a save of another server changes none of what
 * the attempt was about); null, a server that was not saved, never stands.
 */
export function mcpRevisionStillSaved(
  attempted: string | null,
  current: ReadonlySet<string>,
): boolean {
  return attempted !== null && current.has(attempted);
}

/**
 * The saved device server a row's Edit opens: the same single device target
 * Test resolves, kept as its own export so Edit does not depend on Test.
 */
export function mcpDeviceEditTarget(
  entry: UnifiedPluginEntry,
  servers: readonly McpServerIndexEntry[],
  defaultHandler: McpHttpAuthHandler,
): McpTestTarget | null {
  const resolved = mcpDeviceTargetOf(entry, servers, defaultHandler);
  return resolved === null ? null : resolved.target;
}

/**
 * The device binding a row's Connect, Reconnect or Sign in runs against.
 * Signing in needs a saved configuration, so a server without one has no
 * target here even though its row can still be tested.
 */
export function mcpDeviceConnectTarget(
  entry: UnifiedPluginEntry,
  servers: readonly McpServerIndexEntry[],
  defaultHandler: McpHttpAuthHandler,
): McpTestTarget | null {
  const resolved = mcpDeviceTargetOf(entry, servers, defaultHandler);
  return resolved === null || resolved.server.configs.length === 0
    ? null
    : resolved.target;
}

/**
 * Reads one snapshot whose reads can overlap. Each read takes the next
 * sequence number and the scope it started under; a successful read applies
 * only if no newer read has applied (so an older response never overwrites a
 * newer one, whichever lands first) and its scope is still the current one
 * (so a read begun under an old scope never lands after the scope moved). A
 * failed read never touches the snapshot and never discards another read: it
 * rejects with its own error. Every read resolves or rejects on its own
 * outcome, whether or not its response was applied.
 */
export function createLatestSnapshotReader<T, S>(
  read: () => Promise<T>,
  apply: (snapshot: T, scope: S) => void,
  currentScope: () => S,
): () => Promise<void> {
  let started = 0;
  let appliedSeq = 0;
  return async (): Promise<void> => {
    started += 1;
    const seq = started;
    const scope = currentScope();
    const snapshot = await read();
    if (seq > appliedSeq && Object.is(scope, currentScope())) {
      appliedSeq = seq;
      apply(snapshot, scope);
    }
  };
}

const NO_STATUSES: McpServerStatusEntry[] = [];

/**
 * A monotonic generation of the scope MCP reads are resolved under: it
 * increments whenever the app-wide HTTP auth default changes, including the
 * first value. A read is current only while its generation equals this one,
 * so the default returning to an earlier value (A, B, A) does not make a read
 * taken under the first A current again. Comparing the default itself would.
 */
export function useMcpScopeGeneration(
  authDefault: McpHttpAuthHandler | null,
): number {
  const [scope, setScope] = useState({ authDefault, generation: 0 });
  if (scope.authDefault === authDefault) return scope.generation;
  const next = { authDefault, generation: scope.generation + 1 };
  // Derived state: React re-renders at once with the stored value.
  setScope(next);
  return next.generation;
}

/**
 * Customize's read-only MCP status snapshot (CAN-7363). Main resolves each
 * status under the app-wide HTTP auth default (an inherited Provider handler
 * reads as provider-managed), so a snapshot is scoped to `scopeGeneration`
 * (`useMcpScopeGeneration`) and to the saved-server revisions the list held
 * when its read started. A generation change, including the first value
 * (a save can land between the page's first read and the first preferences
 * read), re-reads, and statuses read under another generation are never
 * exposed, so a failed re-read cannot leave a stale provider-managed flag in
 * use (`snapshot` is the raw record: a caller matches a server against its
 * generation and revision, and a snapshot that does not match is unknown, not
 * "no status"; a read that keeps failing holds it until one lands). A
 * server-list change re-reads too and keeps the last snapshot until a newer
 * read lands; its entries stay matched only to the revisions they were read
 * at. A failed read never clears or replaces the snapshot: passive reads
 * report the error, `refresh` rejects with it. Reads go through one reader
 * that applies a response only if it is newer than the last applied one and
 * still belongs to the current generation. `listStatus` is read once, at
 * mount. Deliberately does NOT drive the health sweep that
 * `useMcpServerStatuses` performs for the MCP Servers table: probing every
 * configured server on page open would be a new cost on a landing surface.
 */
export function useMcpStatusSnapshot(
  listStatus: () => Promise<McpServerStatusEntry[]>,
  servers: readonly McpServerIndexEntry[],
  scopeGeneration: number,
): {
  /** The statuses read under the current generation; empty until one lands. */
  readonly statuses: McpServerStatusEntry[];
  /** The latest applied read, whichever generation it belongs to. */
  readonly snapshot: McpStatusSnapshot | null;
  /** Re-reads the snapshot; a failed read rejects, unlike the passive ones. */
  readonly refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<McpStatusSnapshot | null>(null);
  const scopeRef = useRef(scopeGeneration);
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const [read] = useState(() =>
    createLatestSnapshotReader(
      async (): Promise<{
        readonly entries: McpServerStatusEntry[];
        readonly revisions: ReadonlySet<string>;
      }> => {
        // Taken before the read starts: it describes the servers as listed now.
        const revisions = mcpServerRevisions(serversRef.current);
        return { entries: await listStatus(), revisions };
      },
      ({ entries, revisions }, scope: number) =>
        setSnapshot({ scope, entries, revisions }),
      () => scopeRef.current,
    ),
  );
  useEffect(() => {
    // Before the read below starts, so it begins under the new generation.
    scopeRef.current = scopeGeneration;
    void (async (): Promise<void> => {
      try {
        await read();
      } catch (error) {
        reportClientAppError(error);
      }
    })();
  }, [scopeGeneration, read, servers]);
  const refresh = useCallback((): Promise<void> => read(), [read]);
  return {
    statuses:
      snapshot !== null && snapshot.scope === scopeGeneration
        ? snapshot.entries
        : NO_STATUSES,
    snapshot,
    refresh,
  };
}
