import { AcpClientError } from '../acp/errors';
import type { AcpClient } from '../acp/types';

/** An optional recovery offer, never evidence that retry or replay is safe. */
export class AntigravityResumeFailure extends Error {
  constructor(
    readonly sessionId: string,
    readonly resumeError: AcpClientError,
  ) {
    super(resumeError.message);
    this.name = 'AntigravityResumeFailure';
  }
}

/** Transport and authentication errors must not suggest replacing a session. */
export function antigravityResumeFailure(
  error: unknown,
  sessionId: string,
): AntigravityResumeFailure | undefined {
  return error instanceof AcpClientError &&
    error.code === 'provider' &&
    error.method === 'session/resume' &&
    error.rpcCode === -32603
    ? new AntigravityResumeFailure(sessionId, error)
    : undefined;
}

/** Qualified against 1.5.1; loadSession can accept an ID with no saved history. */
export async function isAntigravitySessionMissing(
  client: AcpClient,
  error: unknown,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (
    !(error instanceof AcpClientError) ||
    error.code !== 'provider' ||
    error.method !== 'session/resume' ||
    error.rpcCode !== -32603 ||
    error.providerDetails !==
      `Failed to read session ${sessionId}; retry, or load it with session/load`
  )
    return false;

  // A read failure alone could be a damaged or temporarily unreadable session.
  // Require a complete listing, without a cwd filter hiding a moved session.
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.listSessions(cursor ? { cursor } : {}, signal);
    signal.throwIfAborted();
    if (result.sessions.some((entry) => entry.sessionId === sessionId))
      return false;
    if (!result.nextCursor) return true;
    if (cursors.has(result.nextCursor)) return false;
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return false;
}
