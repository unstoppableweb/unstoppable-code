'use client';

import { useCallback, useMemo } from 'react';
import {
  PROVIDER_KEY_ERROR_CODES,
  type ProviderKeyProvider,
  type ProviderKeyStatus,
} from '@canopy/protocol/canopy-core';
import {
  providerKeysClientFromSettings,
  type ProviderKeysClient,
} from '@canopy/app-core';
import { useProviderKeys as useProviderKeyState } from '@canopy/app-state/provider-keys';
import { useSettingsClient } from '../host';
import {
  settingsErrorFacts,
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../errors';
import type { ProviderKeyRowOutcome } from '../../providers/ProviderKeyRow';

export const MODEL_PROVIDERS_ERROR_SCOPE = 'settings.model-providers';

const PROVIDER_NAME: Record<ProviderKeyProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

const CHANGED_COPY =
  'This key was saved or removed somewhere else at the same time. Try again.';

function saveErrors(
  provider: ProviderKeyProvider,
): readonly KnownSettingsError[] {
  const name = PROVIDER_NAME[provider];
  return [
    {
      serverCode: PROVIDER_KEY_ERROR_CODES.rejected,
      copy: `${name} didn't accept that key. Check it and try again.`,
    },
    {
      serverCode: PROVIDER_KEY_ERROR_CODES.unreachable,
      copy: `Couldn't reach ${name} to check your key. Try again.`,
    },
    { serverCode: PROVIDER_KEY_ERROR_CODES.changed, copy: CHANGED_COPY },
    {
      serverCode: PROVIDER_KEY_ERROR_CODES.rateLimited,
      copy: 'Too many tries. Wait a while, then try again.',
    },
    { status: 400, copy: 'Enter an API key.' },
  ];
}

const REMOVE_ERRORS: readonly KnownSettingsError[] = [
  { serverCode: PROVIDER_KEY_ERROR_CODES.changed, copy: CHANGED_COPY },
];

export interface ProviderKeys {
  readonly keys: readonly ProviderKeyStatus[];
  /** True once the statuses are known (seeded or read). */
  readonly loaded: boolean;
  readonly statusFor: (provider: ProviderKeyProvider) => ProviderKeyStatus;
  /** Probes and stores a key; resolves our sentence when it can't. */
  readonly save: (
    provider: ProviderKeyProvider,
    apiKey: string,
  ) => Promise<ProviderKeyRowOutcome>;
  readonly remove: (
    provider: ProviderKeyProvider,
  ) => Promise<ProviderKeyRowOutcome>;
  /** The last re-read's failure, for a load banner. */
  readonly loadError: SettingsFailure | null;
  readonly reread: () => void;
}

/**
 * The key client a settings page reaches through its host's settings
 * client, the same operations `CanopyClient.providerKeys` serves.
 */
export function useSettingsProviderKeysClient(): ProviderKeysClient {
  const settings = useSettingsClient();
  return useMemo(() => providerKeysClientFromSettings(settings), [settings]);
}

/**
 * A person's own Claude and ChatGPT keys (`@canopy/app-state/provider-keys`)
 * with our sentences for every failure: their statuses, and Save and Remove
 * with the revision last seen, so a key changed elsewhere is refused instead
 * of overwritten. `client` is `CanopyClient.providerKeys` where the host has
 * one, or the settings page's adapter; absent, nothing is read or written.
 * Settings › Model providers, the web first-visit card and the held send's
 * provider list share it.
 */
export function useProviderKeys(
  client: ProviderKeysClient | undefined,
  initial?: readonly ProviderKeyStatus[],
): ProviderKeys {
  const errorCopy = useSettingsErrorCopy(MODEL_PROVIDERS_ERROR_SCOPE);
  const state = useProviderKeyState(client, initial);
  const { reread } = state;

  const failure = useCallback(
    (
      err: unknown,
      action: string,
      known: readonly KnownSettingsError[],
    ): ProviderKeyRowOutcome => {
      // The status on screen may be out of date; show what is stored now.
      if (
        settingsErrorFacts(err).serverCode === PROVIDER_KEY_ERROR_CODES.changed
      )
        reread();
      return {
        ok: false,
        error: errorCopy.actionFailure(err, { action, known }).copy,
      };
    },
    [errorCopy, reread],
  );

  const stateSave = state.save;
  const save = useCallback(
    async (
      provider: ProviderKeyProvider,
      apiKey: string,
    ): Promise<ProviderKeyRowOutcome> => {
      const result = await stateSave(provider, apiKey);
      return result.ok
        ? { ok: true }
        : failure(result.error, 'save your key', saveErrors(provider));
    },
    [failure, stateSave],
  );

  const stateRemove = state.remove;
  const remove = useCallback(
    async (provider: ProviderKeyProvider): Promise<ProviderKeyRowOutcome> => {
      const result = await stateRemove(provider);
      return result.ok
        ? { ok: true }
        : failure(result.error, 'remove your key', REMOVE_ERRORS);
    },
    [failure, stateRemove],
  );

  const loadError = useMemo(
    () =>
      state.loadError === null ? null : errorCopy.loadFailure(state.loadError),
    [errorCopy, state.loadError],
  );

  return {
    keys: state.keys,
    loaded: state.loaded,
    statusFor: state.statusFor,
    save,
    remove,
    loadError,
    reread,
  };
}
