import { createHash } from 'node:crypto';

/**
 * A reporting credential's digest; `null` when none can report (signed out or
 * guest); `undefined` when it is unknown (an unreadable or missing read).
 */
type Identity = string | null | undefined;

const MAX_CHANGES = 64;

/**
 * Main's record of which account held the app when. Every renderer reports
 * through main, including ones that never receive account-change events, so
 * this decides whether an error belongs to the account filing it.
 */
export interface FeedbackErrorAccountFence {
  /**
   * A successful account read. It names the account that has held the app
   * since the last change, so it fills in that span when it is unknown.
   */
  observeRead(apiKey: string | null): void;
  /** An unreadable account read. */
  observeUnreadable(): void;
  /** A change notification. A no-op event (same credential) changes nothing. */
  observe(apiKey: string | null): void;
  /**
   * Drops `error` and `telemetry` unless the error was seen signed out, or by
   * the account `filingApiKey` names, which must still hold the app. An
   * unknown filing account (`undefined`, an unreadable read), an unknown
   * owner at `occurredAt` or an unreadable `occurredAt` drops them too. Never
   * refuses: the rest of the request files as plain feedback.
   */
  admit<T extends { error?: unknown; telemetry?: unknown }>(
    request: T,
    filingApiKey: string | null | undefined,
  ): T;
}

function identityOf(apiKey: string | null): Identity {
  return apiKey === null
    ? null
    : createHash('sha256').update(apiKey).digest('hex');
}

function readOccurredAt(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const occurredAt: unknown = Reflect.get(error, 'occurredAt');
  // The AppError timestamp contract: a non-negative integer of milliseconds.
  return typeof occurredAt === 'number' &&
    Number.isSafeInteger(occurredAt) &&
    occurredAt >= 0
    ? occurredAt
    : undefined;
}

export function createFeedbackErrorAccountFence(
  now: () => number = Date.now,
): FeedbackErrorAccountFence {
  // The account before the first retained change; unknown until a read.
  let initial: Identity;
  let readFailed = false;
  // A read after a failed one may reach storage before a pending change
  // notifies, so it can name the next account; the first change then can't
  // be told from a no-op, and the span before it becomes unknown.
  let initialProvisional = false;
  const changes: { at: number; identity: Identity }[] = [];
  // Owners at or before this time were forgotten with their change.
  let forgottenThrough = Number.NEGATIVE_INFINITY;

  // At an equal millisecond the change may have come after the error, so the
  // earlier account is the one that saw it.
  function identityAt(time = Number.POSITIVE_INFINITY): Identity {
    if (time <= forgottenThrough) return undefined;
    let identity = initial;
    for (const change of changes) {
      if (change.at >= time) break;
      identity = change.identity;
    }
    return identity;
  }

  return {
    observeRead(apiKey): void {
      // Change events carry their account, so only the span before the first
      // retained change can be unknown.
      if (changes.length === 0 && initial === undefined) {
        initial = identityOf(apiKey);
        initialProvisional = readFailed;
      }
    },
    observeUnreadable(): void {
      readFailed = true;
    },
    observe(apiKey): void {
      if (initialProvisional && changes.length === 0) initial = undefined;
      initialProvisional = false;
      const identity = identityOf(apiKey);
      if (identity === identityAt()) return;
      changes.push({ at: now(), identity });
      if (changes.length > MAX_CHANGES) {
        const dropped = changes.shift();
        if (dropped) {
          initial = dropped.identity;
          forgottenThrough = dropped.at;
        }
      }
    },
    admit(request, filingApiKey) {
      if (request.error === undefined) return request;
      const occurredAt = readOccurredAt(request.error);
      const seenBy =
        occurredAt === undefined ? undefined : identityAt(occurredAt);
      const filing =
        filingApiKey === undefined ? undefined : identityOf(filingApiKey);
      // Seen with no reporting account (signed out or guest): signing in to
      // report it stays allowed, as the sign-in prompt asks.
      if (
        filing !== undefined &&
        filing === identityAt() &&
        (seenBy === null || (seenBy !== undefined && seenBy === filing))
      )
        return request;
      const admitted = { ...request };
      delete admitted.error;
      delete admitted.telemetry;
      return admitted;
    },
  };
}
