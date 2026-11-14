import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import type { McpHostServingCause } from '@canopy/protocol/canopy-core';

/** How long a cause may run in the log and on the MCP server page. */
const CAUSE_LIMIT = 300;

/**
 * Why a desktop MCP server couldn't be reached from a cloud chat, as safe to
 * log and show: the error's message with anything secret-looking redacted.
 */
export function reachBackFailureCause(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const cause = redactSecrets(message.replace(/\s+/g, ' ').trim());
  return cause.length === 0
    ? 'The server could not be reached.'
    : cause.slice(0, CAUSE_LIMIT);
}

/**
 * How long a failed call keeps a server from being offered to cloud chats
 * (CAN-6659). A server they aren't offered gets no calls to succeed with, so
 * the failure lapses and the desktop offers it again.
 */
export const REACH_BACK_RETRY_AFTER_MS = 120_000;

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'string') return code;
  // fetch() fails with a TypeError whose cause holds the socket error.
  return 'cause' in error ? errorCode(error.cause) : null;
};

/**
 * Why a call failed, as the short cause a serving report carries: from the
 * error's code only, never its message, which can hold a URL or a header.
 */
export function reachBackFailureKind(error: unknown): McpHostServingCause {
  const code = errorCode(error);
  if (code === 'ECONNREFUSED') return 'refused';
  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    (error instanceof Error && error.name === 'TimeoutError')
  )
    return 'timed_out';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM')
    return 'start_failed';
  if (
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  )
    return 'upstream_unreachable';
  return 'unknown';
}

/**
 * Whether each allowed server was reachable at its last cloud chat call, per
 * account, in memory: a failed call notes its cause, and the next one that
 * reaches the server clears it.
 */
export interface ReachBackReachability {
  failed(
    accountId: string,
    server: { readonly serverId: string; readonly configId: string },
    cause: string,
    kind?: McpHostServingCause,
  ): void;
  reached(
    accountId: string,
    server: { readonly serverId: string; readonly configId: string },
  ): void;
  /** The cause of the last failed call, or null when it was reached. */
  cause(accountId: string, serverId: string, configId: string): string | null;
  /**
   * The kind of the last failed call while it still holds the server back
   * (`REACH_BACK_RETRY_AFTER_MS`), or null.
   */
  holdingBack(
    accountId: string,
    serverId: string,
    configId: string,
    now: number,
  ): McpHostServingCause | null;
  /** Called after a call fails or reaches a server, or one is forgotten. */
  onChange(listener: () => void): () => void;
  /** Forgets a server turned off, or every server with no arguments. */
  forget(serverId?: string, configId?: string): void;
}

export function createReachBackReachability(
  now: () => number = Date.now,
): ReachBackReachability {
  const causes = new Map<
    string,
    { cause: string; kind: McpHostServingCause; at: number }
  >();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const key = (accountId: string, serverId: string, configId: string): string =>
    JSON.stringify([accountId, serverId, configId]);
  return {
    failed(accountId, server, cause, kind = 'unknown') {
      causes.set(key(accountId, server.serverId, server.configId), {
        cause,
        kind,
        at: now(),
      });
      changed();
    },
    reached(accountId, server) {
      if (causes.delete(key(accountId, server.serverId, server.configId)))
        changed();
    },
    cause(accountId, serverId, configId) {
      return causes.get(key(accountId, serverId, configId))?.cause ?? null;
    },
    holdingBack(accountId, serverId, configId, at) {
      const failure = causes.get(key(accountId, serverId, configId));
      return failure !== undefined &&
        at - failure.at < REACH_BACK_RETRY_AFTER_MS
        ? failure.kind
        : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    forget(serverId, configId) {
      if (serverId === undefined) {
        causes.clear();
        changed();
        return;
      }
      for (const entry of [...causes.keys()]) {
        const parsed: unknown = JSON.parse(entry);
        if (
          Array.isArray(parsed) &&
          parsed[1] === serverId &&
          (configId === undefined || parsed[2] === configId)
        )
          causes.delete(entry);
      }
      changed();
    },
  };
}
