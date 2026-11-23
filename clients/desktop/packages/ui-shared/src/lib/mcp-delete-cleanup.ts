'use client';

import { useSyncExternalStore } from 'react';

/**
 * A device MCP server deleted with cleanup left incomplete (CAN-7362). The
 * confirmation that deleted it closes at once, often with its detail page,
 * so the notice that names the server and offers Repair outlives the page.
 */
export interface McpDeleteCleanupIncomplete {
  readonly serverId: string;
  readonly serverName: string;
}

/**
 * Accepted reports, one per server and oldest first, kept for this window
 * rather than in the page that took them, so leaving and reopening Customize
 * keeps the only way back to each deleted server's cleanup. Each clears when
 * dismissed or when that server's cleanup finishes; the others stay.
 */
let pendingCleanups: readonly McpDeleteCleanupIncomplete[] = [];
const pendingListeners = new Set<() => void>();
const repairSurfaces = new Set<symbol>();

function setPendingCleanups(next: readonly McpDeleteCleanupIncomplete[]): void {
  pendingCleanups = next;
  for (const listener of pendingListeners) listener();
}

function addPendingCleanup(detail: McpDeleteCleanupIncomplete): void {
  setPendingCleanups([
    ...pendingCleanups.filter((entry) => entry.serverId !== detail.serverId),
    detail,
  ]);
}

function clearPendingCleanup(serverId: string): void {
  if (pendingCleanups.some((entry) => entry.serverId === serverId))
    setPendingCleanups(
      pendingCleanups.filter((entry) => entry.serverId !== serverId),
    );
}

function subscribePendingCleanup(listener: () => void): () => void {
  pendingListeners.add(listener);
  return (): void => {
    pendingListeners.delete(listener);
  };
}

const readPendingCleanups = (): readonly McpDeleteCleanupIncomplete[] =>
  pendingCleanups;
const noPendingCleanups: readonly McpDeleteCleanupIncomplete[] = [];
const readNoPendingCleanups = (): readonly McpDeleteCleanupIncomplete[] =>
  noPendingCleanups;

/** Every accepted, undismissed report, oldest first. */
export function usePendingMcpDeleteCleanups(): readonly McpDeleteCleanupIncomplete[] {
  return useSyncExternalStore(
    subscribePendingCleanup,
    readPendingCleanups,
    readNoPendingCleanups,
  );
}

/** The user dismissed this server's notice. */
export function dismissMcpDeleteCleanup(serverId: string): void {
  clearPendingCleanup(serverId);
}

/**
 * Capture the route to Repair before starting Delete. If Customize unmounts
 * while Delete runs, the report still reaches the notice on return. When no
 * Repair surface was available at the start, the caller owns the failure.
 */
export function captureMcpDeleteCleanupReporter():
  | ((detail: McpDeleteCleanupIncomplete) => void)
  | undefined {
  return repairSurfaces.size > 0 ? addPendingCleanup : undefined;
}

/**
 * Registers a mounted surface that can offer Repair. Returns cleanup.
 */
export function registerMcpDeleteCleanupSurface(): () => void {
  const surface = Symbol();
  repairSurfaces.add(surface);
  return (): void => {
    repairSurfaces.delete(surface);
  };
}

/** Repair finished the saved uninstall of this device server. */
export function reportMcpDeleteCleanupComplete(serverId: string): void {
  clearPendingCleanup(serverId);
}
