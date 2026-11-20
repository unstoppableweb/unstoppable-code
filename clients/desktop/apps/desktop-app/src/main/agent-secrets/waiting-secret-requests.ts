/**
 * Secret requests waiting for the person, by chat, and the answers settling
 * now. A chat's Stop cancels the requests that were waiting when it began,
 * through each wait's own abort (PLAN section 12): that closes the wait, so a
 * late answer is refused and stores nothing, and consumes the form.
 * Dismissal through the generic question path stays refused.
 *
 * Kept free of other main-process imports so the Stop sequence can capture
 * the waiting requests synchronously, before it awaits anything.
 */

interface ChatScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

interface WaitingSecretRequest {
  readonly wait: AbortController;
  requestId?: string;
  /** A Stop has captured it: an answer that starts now is refused. */
  stopping: boolean;
  /** Stop came while an answer was settling; cancel if that answer fails. */
  stopRequested: boolean;
}

const waitingRequests = new Map<string, Set<WaitingSecretRequest>>();
/** Request ids a submission is settling now: the first answer wins. */
const settling = new Set<string>();

function chatKey(scope: ChatScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

/**
 * Registers a RequestSecrets call that is about to wait. `identify` records
 * the wait's request id once it exists; `dispose` ends the registration.
 */
export function registerWaitingSecretRequest(
  scope: ChatScope,
  wait: AbortController,
): { identify: (requestId: string) => void; dispose: () => void } {
  const key = chatKey(scope);
  const entry: WaitingSecretRequest = {
    wait,
    stopping: false,
    stopRequested: false,
  };
  const entries = waitingRequests.get(key) ?? new Set<WaitingSecretRequest>();
  entries.add(entry);
  waitingRequests.set(key, entries);
  return {
    identify: (requestId): void => {
      entry.requestId = requestId;
    },
    dispose: (): void => {
      const current = waitingRequests.get(key);
      current?.delete(entry);
      if (current?.size === 0) waitingRequests.delete(key);
    },
  };
}

/**
 * Starts settling an answer: `busy` when one is already settling, `stopping`
 * when a Stop has captured the request (it is about to be cancelled).
 */
export function beginSettlingSecretRequest(
  requestId: string,
): 'started' | 'busy' | 'stopping' {
  if (settling.has(requestId)) return 'busy';
  for (const entries of waitingRequests.values())
    for (const entry of entries)
      if (entry.requestId === requestId && entry.stopping) return 'stopping';
  settling.add(requestId);
  return 'started';
}

/** Ends a settlement; a Stop that waited for it now cancels the request. */
export function endSettlingSecretRequest(requestId: string): void {
  settling.delete(requestId);
  for (const entries of waitingRequests.values())
    for (const entry of entries)
      if (entry.requestId === requestId && entry.stopRequested)
        entry.wait.abort();
}

/**
 * Captures the chat's waiting requests now and returns their cancellation,
 * so a Stop never reaches a request a newer turn opens while it runs. From
 * the capture on, an answer that starts on them is refused. The
 * cancellation returns how many it aborted. An answer already settling goes
 * first, so a value is never stored and exported for a cancelled request;
 * if that answer is refused, the request is cancelled as it ends.
 */
export function captureWaitingSecretRequests(scope: ChatScope): () => number {
  const captured = [...(waitingRequests.get(chatKey(scope)) ?? [])];
  for (const entry of captured) entry.stopping = true;
  return (): number => {
    let cancelled = 0;
    for (const entry of captured) {
      if (entry.wait.signal.aborted) continue;
      if (entry.requestId !== undefined && settling.has(entry.requestId)) {
        entry.stopRequested = true;
        continue;
      }
      entry.wait.abort();
      cancelled += 1;
    }
    return cancelled;
  };
}

/** Cancels every secret request waiting in the chat now; returns how many. */
export function cancelWaitingSecretRequests(scope: ChatScope): number {
  return captureWaitingSecretRequests(scope)();
}
