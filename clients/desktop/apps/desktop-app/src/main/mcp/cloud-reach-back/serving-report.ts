import type {
  McpHostServingCause,
  McpHostServingServer,
} from '@canopy/protocol/canopy-core';
import type { ReachBackServer } from './allow-list';
import type { ReachBackReachability } from './reachability';

/**
 * What a serving report says about each cause (CAN-6659): fixed text, never
 * the error itself, so no URL, header or environment value leaves this
 * computer. The log and the server's own page keep the redacted detail.
 */
const SAFE_MESSAGES: Readonly<Record<McpHostServingCause, string>> = {
  start_failed: "The server didn't start on this desktop.",
  proxy_unavailable: "This desktop's MCP proxy isn't running.",
  upstream_unreachable: "This desktop couldn't reach the server.",
  timed_out: "The server didn't answer in time.",
  refused: 'The server refused the connection.',
  unknown: "This desktop couldn't use the server.",
};

/**
 * Whether this desktop can serve each allowed server now: unreachable while
 * its settings can't start it, or while a recent call failed (until the
 * retry window lapses); otherwise ready.
 */
export async function servingReport(
  accountId: string,
  servers: readonly ReachBackServer[],
  deps: {
    readonly reachability: ReachBackReachability;
    /** Why the server's settings can't serve it now, or null. */
    readonly unusable: (
      server: ReachBackServer,
    ) => Promise<McpHostServingCause | null>;
    readonly now: () => number;
  },
): Promise<McpHostServingServer[]> {
  const at = deps.now();
  return Promise.all(
    servers.map(async (server): Promise<McpHostServingServer> => {
      const cause =
        (await deps.unusable(server)) ??
        deps.reachability.holdingBack(
          accountId,
          server.serverId,
          server.configId,
          at,
        );
      return cause === null
        ? {
            serverId: server.serverId,
            configId: server.configId,
            state: 'ready',
          }
        : {
            serverId: server.serverId,
            configId: server.configId,
            state: 'unreachable',
            cause,
            message: SAFE_MESSAGES[cause],
          };
    }),
  );
}
