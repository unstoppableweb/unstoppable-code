'use client';

import type { JSX } from 'react';
import { PROVIDER_KEY_PROVIDERS } from '@canopy/protocol/canopy-core';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  ErrorBanner,
  Heading,
  SettingsRowsGroup,
} from '@canopy/ui-shared/components';
import type { SettingsPageProps } from '../pages/page-props';
import { ProviderKeyRow } from '../../providers/ProviderKeyRow';
import {
  useProviderKeys,
  useSettingsProviderKeysClient,
} from './use-provider-keys';

/**
 * `/account/model-providers`: the person's own Anthropic and OpenAI API keys
 * for cloud chats. Each key is write-only; the page shows only its state and
 * last four characters. Saves send the revision the page last saw, so a key
 * changed in another tab is refused instead of overwritten.
 */
export function AccountModelProvidersPage({
  page,
}: SettingsPageProps<'account.model-providers'>): JSX.Element {
  const client = useSettingsProviderKeysClient();
  const { statusFor, save, remove, loadError, reread } = useProviderKeys(
    client,
    page.data.keys,
  );

  return (
    <section className={SETTINGS_CARD_CLASS} data-testid="model-providers">
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          API keys
        </Heading>
        {/* Says who bills the model; compute funding is flag-dependent, so
            this sentence makes no claim about AI Credits. */}
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          Cloud chats can run on your own Claude or ChatGPT API key. Your
          provider bills you for those models.
        </p>
      </div>
      <ErrorBanner
        errorSource="model-providers-page"
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={loadError ? reread : undefined}
      />
      <SettingsRowsGroup ariaLabel="API keys">
        {PROVIDER_KEY_PROVIDERS.map((provider) => (
          <ProviderKeyRow
            key={provider}
            provider={provider}
            status={statusFor(provider)}
            onSave={(apiKey) => save(provider, apiKey)}
            onRemove={() => remove(provider)}
          />
        ))}
      </SettingsRowsGroup>
    </section>
  );
}
