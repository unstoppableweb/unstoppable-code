import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProviderKeyProvider,
  ProviderKeyStatus,
} from '@canopy/protocol/canopy-core';
import type { ProviderKeysClient } from '@canopy/app-core';

/** What a save or removal did: done, or the host's error to describe. */
export type ProviderKeyWriteResult =
  | { readonly ok: true; readonly key: ProviderKeyStatus }
  | { readonly ok: false; readonly error: unknown };

export interface ProviderKeysState {
  /** Every provider's last-known status; empty until the first read. */
  readonly keys: readonly ProviderKeyStatus[];
  /** True once a read (or the host's initial statuses) has answered. */
  readonly loaded: boolean;
  readonly statusFor: (provider: ProviderKeyProvider) => ProviderKeyStatus;
  readonly save: (
    provider: ProviderKeyProvider,
    apiKey: string,
  ) => Promise<ProviderKeyWriteResult>;
  readonly remove: (
    provider: ProviderKeyProvider,
  ) => Promise<ProviderKeyWriteResult>;
  /** Reads the statuses again; the failure, if any, is in `loadError`. */
  readonly reread: () => void;
  readonly loadError: unknown;
}

/** A provider with no stored key. */
export function emptyProviderKeyStatus(
  provider: ProviderKeyProvider,
): ProviderKeyStatus {
  return {
    provider,
    status: 'none',
    keyHint: null,
    modelCount: 0,
    modelsListed: false,
    savedAt: null,
    revision: 0,
  };
}

export function providerKeyStatusOf(
  keys: readonly ProviderKeyStatus[],
  provider: ProviderKeyProvider,
): ProviderKeyStatus {
  return (
    keys.find((key) => key.provider === provider) ??
    emptyProviderKeyStatus(provider)
  );
}

/**
 * A person's own provider keys through `CanopyClient.providerKeys`
 * (CAN-7502): their statuses, and Save and Remove with the revision last
 * seen, so a key changed elsewhere is refused instead of overwritten. With
 * no client (the `providerApiKeys` capability unset) it makes no call and
 * every write fails. `initial` seeds the statuses a host already read
 * (a settings page's data); without it, the statuses are read once on mount.
 */
export function useProviderKeys(
  client: ProviderKeysClient | undefined,
  initial?: readonly ProviderKeyStatus[],
): ProviderKeysState {
  const [keys, setKeys] = useState<readonly ProviderKeyStatus[]>(initial ?? []);
  const [loaded, setLoaded] = useState(initial !== undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const keysRef = useRef(keys);
  useEffect(() => {
    keysRef.current = keys;
  });

  // Only the latest read applies: an earlier one (a previous client's, say)
  // that answers later is dropped.
  const readSeqRef = useRef(0);
  const apply = useCallback((next: ProviderKeyStatus): void => {
    setKeys((current) => [
      ...current.filter((key) => key.provider !== next.provider),
      next,
    ]);
  }, []);

  const reread = useCallback((): void => {
    if (client === undefined) return;
    readSeqRef.current += 1;
    const seq = readSeqRef.current;
    setLoadError(null);
    void client.list().then(
      (result) => {
        if (seq !== readSeqRef.current) return;
        // A save or removal that answered first is newer: keep the higher
        // revision for each provider.
        setKeys((current) =>
          result.map((read) => {
            const written = current.find(
              (key) => key.provider === read.provider,
            );
            return written !== undefined && written.revision > read.revision
              ? written
              : read;
          }),
        );
        setLoaded(true);
      },
      (error: unknown) => {
        if (seq === readSeqRef.current) setLoadError(error);
      },
    );
  }, [client]);

  const readOnMount = initial === undefined;
  useEffect(() => {
    if (readOnMount) reread();
  }, [readOnMount, reread]);

  const save = useCallback(
    async (
      provider: ProviderKeyProvider,
      apiKey: string,
    ): Promise<ProviderKeyWriteResult> => {
      if (client === undefined)
        return { ok: false, error: new Error('capability_unavailable') };
      try {
        const key = await client.set({
          provider,
          apiKey,
          expectedRevision: providerKeyStatusOf(keysRef.current, provider)
            .revision,
        });
        apply(key);
        return { ok: true, key };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [apply, client],
  );

  const remove = useCallback(
    async (provider: ProviderKeyProvider): Promise<ProviderKeyWriteResult> => {
      if (client === undefined)
        return { ok: false, error: new Error('capability_unavailable') };
      try {
        const key = await client.clear({
          provider,
          expectedRevision: providerKeyStatusOf(keysRef.current, provider)
            .revision,
        });
        apply(key);
        return { ok: true, key };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [apply, client],
  );

  const statusFor = useCallback(
    (provider: ProviderKeyProvider): ProviderKeyStatus =>
      providerKeyStatusOf(keys, provider),
    [keys],
  );

  return { keys, loaded, statusFor, save, remove, reread, loadError };
}
