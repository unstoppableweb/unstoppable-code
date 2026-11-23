import type {
  ProviderKeyProvider,
  ProviderKeyStatus,
} from '@canopy/protocol/canopy-core';
import type { AccountOrganizationSettingsClient } from '../settings/settings-client';

/**
 * A person's own Anthropic (Claude) and OpenAI (ChatGPT) API keys for cloud
 * chats: `core.integration.providerKey.{list,set,clear}` (CAN-7502). Present
 * only on hosts that report `capabilities.providerApiKeys`; desktop leaves it
 * absent, which reads as `capability_unavailable`. Keys are write-only: no
 * method returns one, only its status and last four characters.
 *
 * Failures reject with the host's own error, carrying the operation's typed
 * code (rejected, unreachable, changed, rate limited), so callers map them to
 * copy the same way on every host.
 */
export interface ProviderKeysClient {
  /** Every provider's status, one entry each. */
  list(): Promise<readonly ProviderKeyStatus[]>;
  /**
   * Probes and stores a key. `expectedRevision` is the revision last seen,
   * so a key changed elsewhere is refused instead of overwritten.
   */
  set(input: {
    readonly provider: ProviderKeyProvider;
    readonly apiKey: string;
    readonly expectedRevision?: number;
  }): Promise<ProviderKeyStatus>;
  /** Deletes a key; succeeds when none is stored. */
  clear(input: {
    readonly provider: ProviderKeyProvider;
    readonly expectedRevision?: number;
  }): Promise<ProviderKeyStatus>;
}

/**
 * The key operations over a host's settings client
 * (`account.settings.model-providers.*`, the same service as
 * `core.integration.providerKey.*`). Errors keep the settings client's typed
 * failures, so settings error copy reads them.
 */
export function providerKeysClientFromSettings(
  settings: AccountOrganizationSettingsClient,
): ProviderKeysClient {
  return {
    list: async () =>
      (await settings.read('account.settings.model-providers.read', {})).keys,
    set: async (input) =>
      (await settings.write('account.settings.model-providers.save', input))
        .key,
    clear: async (input) =>
      (await settings.write('account.settings.model-providers.remove', input))
        .key,
  };
}
