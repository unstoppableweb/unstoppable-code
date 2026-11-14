import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The key one archive request is tracked under. Archive removes the whole
 * Work Entry, so its sibling chat rows share the key; a chat without a
 * projected Work Entry falls back to its own identity.
 */
export function standaloneChatArchiveKey(chat: {
  readonly localId: string;
  readonly projectLocalId: string;
  readonly workEntryId?: string;
}): string {
  return chat.workEntryId
    ? `${chat.projectLocalId}\u0000entry\u0000${chat.workEntryId}`
    : `${chat.projectLocalId}\u0000chat\u0000${chat.localId}`;
}

export interface StandaloneChatArchiveController<TChat> {
  /** Failure stays in the shared sidebar surface until the next attempt. */
  readonly error: string | null;
  /** Whether an archive for this key has not settled yet. */
  readonly isPending: (key: string) => boolean;
  /** Runs the host's archive once per key until it settles. */
  readonly archive: (key: string, chat: TChat) => void;
}

/**
 * One archive invocation shared by flat and Work Entry rows (CAN-5461).
 *
 * The guard is synchronous, so a second pointer, menu or keyboard activation
 * before React re-renders cannot issue another request. The pending state
 * clears on every settlement, including a synchronous throw; the shared section
 * reports the failure, and the row stays available to retry.
 */
export function useStandaloneChatArchive<TChat>(
  onArchive: ((chat: TChat) => void | Promise<void>) | undefined,
): StandaloneChatArchiveController<TChat> {
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const [pending, setPending] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const publish = useCallback((): void => {
    if (mounted.current) setPending(new Set(inFlight.current));
  }, []);
  const archive = useCallback(
    (key: string, chat: TChat): void => {
      if (onArchive === undefined || inFlight.current.has(key)) return;
      setError(null);
      inFlight.current.add(key);
      publish();
      const settle = (): void => {
        inFlight.current.delete(key);
        publish();
      };
      const fail = (error: unknown): void => {
        if (mounted.current)
          setError(
            error instanceof Error && error.message
              ? error.message
              : "Couldn't archive the chat. Try again.",
          );
        settle();
      };
      let result: void | Promise<void>;
      try {
        result = onArchive(chat);
      } catch (error) {
        fail(error);
        return;
      }
      void Promise.resolve(result).then(settle, fail);
    },
    [onArchive, publish],
  );
  const isPending = useCallback(
    (key: string): boolean => pending.has(key),
    [pending],
  );
  return { isPending, archive, error };
}
