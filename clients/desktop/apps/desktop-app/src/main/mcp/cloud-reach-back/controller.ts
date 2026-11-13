import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { ReachBackAllowList, ReachBackServer } from './allow-list';

/**
 * "Allow in cloud chats" and its off switch (CAN-6176 D25, D26), which the
 * opt-in dialog (PR 7c) calls.
 *
 * Allowing records the cloud `DESKTOP` connection first, with this computer's
 * desktop key, then the local allow list entry that serves it. Turning off
 * removes the local entry first, so serving stops at once and fails closed,
 * then the cloud connection; a failed cloud removal leaves a row this
 * computer no longer serves, which the cloud reads as offline.
 */

export interface ReachBackOptIn {
  readonly serverId: string;
  readonly configId: string;
  readonly displayName: string;
  /** The tools cloud chats may use; null allows every listed tool. */
  readonly enabledTools: readonly string[] | null;
  /** Of those, the tools that run without asking on this computer (Q3). */
  readonly allowWithoutAsking: readonly string[];
}

export interface ReachBackControllerDeps {
  readonly allowList: ReachBackAllowList;
  readonly currentAccountId: () => string | null;
  /** `POST /api/v1/mcp-connections/desktop` with the desktop key. */
  readonly recordDesktopConnection: (input: {
    readonly serverId: string;
    readonly configId: string;
    readonly displayName: string;
    readonly enabledTools: string[] | null;
  }) => Promise<{ readonly connectionId: string }>;
  /** Removes the cloud connection (the existing connection delete). */
  readonly removeConnection: (connectionId: string) => Promise<void>;
  /** Drops anything held for a server turned off, such as its route. */
  readonly onServerOff?: (serverId: string, configId: string) => void;
  readonly now?: () => Date;
}

export class ReachBackSignedOutError extends Error {
  constructor() {
    super('Sign in to allow servers in cloud chats.');
    this.name = 'ReachBackSignedOutError';
  }
}

export function createReachBackController(deps: ReachBackControllerDeps): {
  allow(input: ReachBackOptIn): Promise<ReachBackServer>;
  /** True once the cloud connection is gone too. */
  disallow(serverId: string, configId: string): Promise<boolean>;
} {
  const now = deps.now ?? ((): Date => new Date());
  const account = (): string => {
    const accountId = deps.currentAccountId();
    if (accountId === null) throw new ReachBackSignedOutError();
    return accountId;
  };

  return {
    async allow(input) {
      const accountId = account();
      const enabledTools =
        input.enabledTools === null ? null : [...new Set(input.enabledTools)];
      // Only tools cloud chats may use can run without asking.
      const allowWithoutAsking = [...new Set(input.allowWithoutAsking)].filter(
        (tool) => enabledTools === null || enabledTools.includes(tool),
      );
      const { connectionId } = await deps.recordDesktopConnection({
        serverId: input.serverId,
        configId: input.configId,
        displayName: input.displayName,
        enabledTools,
      });
      // Signed out or switched while the cloud call ran: serve nothing.
      if (deps.currentAccountId() !== accountId) {
        await deps.removeConnection(connectionId).catch(() => undefined);
        throw new ReachBackSignedOutError();
      }
      const server: ReachBackServer = {
        serverId: input.serverId,
        configId: input.configId,
        connectionId,
        displayName: input.displayName,
        enabledTools,
        allowWithoutAsking,
        allowedAt: now().toISOString(),
      };
      await deps.allowList.allow(accountId, server);
      return server;
    },
    async disallow(serverId, configId) {
      const accountId = account();
      const server = (await deps.allowList.list(accountId)).find(
        (row) => row.serverId === serverId && row.configId === configId,
      );
      await deps.allowList.disallow(accountId, serverId, configId);
      deps.onServerOff?.(serverId, configId);
      if (server === undefined) return true;
      try {
        await deps.removeConnection(server.connectionId);
        return true;
      } catch (error) {
        logMainProcessWarn(
          '[cloud-reach-back] The cloud connection could not be removed.',
          error,
        );
        return false;
      }
    },
  };
}
