import { useCallback, useEffect, useMemo, useRef } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { DetectedMcpServerInfo } from '@canopy/execution-engine/types/mcp-servers';
import type {
  McpHttpAuthHandler,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import { useDetectedMcpServers } from '../../hooks/useDetectedMcpServers';
import type { UseDetectedMcpServersResult } from '../../hooks/useDetectedMcpServers';
import {
  mcpInventoryLacksTarget,
  mcpDeviceServerRevision,
  mcpRevisionStillSaved,
  mcpRowSelectionRefs,
  mcpServerRevisions,
  useMcpScopeGeneration,
  useMcpStatusSnapshot,
  type McpRowConnectReadiness,
  type McpRowReadiness,
} from './mcpDeviceTestTarget';

export interface UseMcpRowReadinessOptions {
  readonly servers: readonly McpServerIndexEntry[];
  /** The app-wide HTTP auth default; null until the first read lands. */
  readonly authDefault: McpHttpAuthHandler | null;
  readonly listStatus: () => Promise<McpServerStatusEntry[]>;
  /**
   * The page's error banner. A sign-in attempt that failed puts its message
   * there, where it stays until the page clears it, like any other action's.
   */
  readonly setBannerError: (message: string) => void;
}

export interface McpRowReadinessState {
  /** The statuses read under the current scope generation. */
  readonly statuses: McpServerStatusEntry[];
  /** Re-reads the statuses; a failed read rejects. */
  readonly refreshStatuses: () => Promise<void>;
  /** The row sign-in inventory, with Connect, cancel and its read state. */
  readonly rowMcp: UseDetectedMcpServersResult;
  readonly readiness: McpRowReadiness;
  readonly connectReadiness: McpRowConnectReadiness;
  /**
   * The message of the sign-in read that failed, kept until a read applies.
   * It is the read's own entry, shown beside the banner (never copied into
   * it), so only that read's recovery removes it, whatever other sources put
   * in the banner meanwhile, and whatever their text.
   */
  readonly readError: string | null;
  /** The readiness the page holds now, for a click that outlives its render. */
  readonly latestReadiness: () => McpRowReadiness;
}

/**
 * Everything the Customize MCP rows' Test and Connect decisions read, in one
 * place so the page and its golden run the same wiring (CAN-7363): the scope
 * generation, the status snapshot, and the sign-in inventory over the same
 * saved-server projection. Each of them re-reads when the scope moves or a
 * saved server's revision does (a save that keeps every id changes neither
 * the selections nor the default), and never otherwise: no timer, no probe.
 * An auth event re-reads both, as a browser sign-in settles with no other
 * signal. The window regaining focus (which also reloads the saved-server
 * index) re-reads the sign-in inventory once more when it applied without a
 * saved configuration the rows can target, and not otherwise.
 */
export function useMcpRowReadiness({
  servers,
  authDefault,
  listStatus,
  setBannerError,
}: UseMcpRowReadinessOptions): McpRowReadinessState {
  // Resolved under the default, so they re-read when it changes.
  const scopeGeneration = useMcpScopeGeneration(authDefault);
  const {
    statuses,
    snapshot: statusSnapshot,
    refresh: refreshStatuses,
  } = useMcpStatusSnapshot(listStatus, servers, scopeGeneration);
  useEffect(
    () =>
      window.mcpServers?.onAuthChanged?.(() => {
        void (async (): Promise<void> => {
          try {
            await refreshStatuses();
          } catch (error) {
            // A passive read: a failure keeps the last snapshot.
            reportClientAppError(error);
          }
        })();
      }),
    [refreshStatuses],
  );
  const selections = useMemo(
    () => ({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: mcpRowSelectionRefs(servers),
    }),
    [servers],
  );
  const revisions = useMemo(() => mcpServerRevisions(servers), [servers]);
  // A sign-in is about one server: its failure stands while that server is
  // saved as it was, whatever else is saved meanwhile.
  const attemptRevisionOf = useCallback(
    (server: DetectedMcpServerInfo): string | null =>
      mcpDeviceServerRevision(servers, server.serverId, server.configId),
    [servers],
  );
  const rowMcp = useDetectedMcpServers(selections, {
    ownerKey: 'customize-mcp-rows',
    cancelOnDispose: true,
    scope: scopeGeneration,
    revisions,
    revisionOf: attemptRevisionOf,
  });
  // Its sign-in state is resolved under the default as well, and decides
  // whether a row's Connect signs in before it tests. The hook keeps only the
  // latest read and publishes the scope and revisions each applied read ran
  // under, so Connect waits for one that follows the current ones. The first
  // value re-reads too, as the status snapshot does.
  const refreshRowMcp = rowMcp.refresh;
  useEffect(() => {
    if (authDefault === null) return;
    // The hook reports a failed read as its error and an empty list.
    void refreshRowMcp();
  }, [authDefault, refreshRowMcp]);
  // A failed sign-in (or a vanished server) is the page's to clear, like a
  // probe's. The hook keeps it apart from its read state, so a read that fails
  // or recovers meanwhile neither hides nor erases it, and each failure is
  // forwarded once: the page clearing the banner is not undone when the
  // inventory is read again. One of a configuration since replaced (another
  // default, or a save of its server) is dropped, never forwarded or kept:
  // the new configuration's own read says what is true now. A failed read is
  // not copied: `readError` carries it.
  const { signInFailure, loading, appliedScope, servers: inventory } = rowMcp;
  const forwardedFailure = useRef(0);
  useEffect(() => {
    if (!signInFailure || signInFailure.seq === forwardedFailure.current)
      return;
    forwardedFailure.current = signInFailure.seq;
    if (
      signInFailure.scope === scopeGeneration &&
      mcpRevisionStillSaved(signInFailure.revision, revisions)
    )
      setBannerError(signInFailure.message);
  }, [signInFailure, scopeGeneration, revisions, setBannerError]);
  // The window regaining focus: the one trigger that retries a read that
  // applied without a target a row needs. No timer, no repeat.
  const focusRetry = useRef({ servers, inventory, loading, appliedScope });
  focusRetry.current = { servers, inventory, loading, appliedScope };
  useEffect(() => {
    const onFocus = (): void => {
      const latest = focusRetry.current;
      if (
        latest.loading ||
        latest.appliedScope === null ||
        !mcpInventoryLacksTarget(latest.servers, latest.inventory)
      )
        return;
      void refreshRowMcp();
    };
    window.addEventListener('focus', onFocus);
    return (): void => window.removeEventListener('focus', onFocus);
  }, [refreshRowMcp]);
  const readiness = useMemo(
    (): McpRowReadiness => ({
      servers,
      authDefault,
      scopeGeneration,
      statusSnapshot,
    }),
    [servers, authDefault, scopeGeneration, statusSnapshot],
  );
  const connectReadiness = useMemo(
    (): McpRowConnectReadiness => ({
      ...readiness,
      inventoryAppliedScope: rowMcp.appliedScope,
      inventoryAppliedRevisions: rowMcp.appliedRevisions,
      inventoryServers: rowMcp.servers,
      inventoryPending: rowMcp.loading,
    }),
    [
      readiness,
      rowMcp.appliedScope,
      rowMcp.appliedRevisions,
      rowMcp.servers,
      rowMcp.loading,
    ],
  );
  const latestReadiness = useRef(readiness);
  latestReadiness.current = readiness;
  const readLatestReadiness = useCallback(
    (): McpRowReadiness => latestReadiness.current,
    [],
  );
  return {
    statuses,
    refreshStatuses,
    rowMcp,
    readiness,
    connectReadiness,
    readError: rowMcp.inventoryError,
    latestReadiness: readLatestReadiness,
  };
}
