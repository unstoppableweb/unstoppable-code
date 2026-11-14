'use client';

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import { GitHubIcon, Globe, Mail } from '@canopy/ui-shared/icons/AppIcons';
import {
  GoogleIcon,
  SingleSignOnIcon,
  UnstoppableDomainsIcon,
} from '@canopy/ui-shared/icons';
import {
  Button,
  FormField,
  TextInput,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  CREDENTIAL_PROVIDER_ID,
  LAST_AUTH_SOURCE_ERROR,
  PASSWORD_COMPROMISED_CODE,
  PASSWORD_COMPROMISED_ERROR,
  PASSWORD_MIN_LENGTH,
  SOCIAL_PROVIDER_IDS,
  SSO_SERVER_PROVIDER_ID,
  UD_PROVIDER_ID,
  authSourceLabel,
  isAuthSourcesResponse,
  type AuthSource,
  type AuthSourcesResponse,
  type SocialProviderId,
} from '@canopy/protocol/settings/account';
import { useSettingsClient, useSettingsNavigation } from '../host';
import { TwoFactorSetupPanel } from './two-factor-setup-panel';
import { ApiKeysManager } from './api-keys-panel';
import {
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../errors';

const SECURITY_ERROR_SCOPE = 'settings.account.security';
const PASSWORD_SAVED = 'Password saved.';
/** Password failures with their own copy on both set and change. */
const PASSWORD_KNOWN_ERRORS = [
  { serverCode: PASSWORD_COMPROMISED_CODE, copy: PASSWORD_COMPROMISED_ERROR },
  {
    serverCode: 'PASSWORD_TOO_SHORT',
    copy: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  },
  {
    serverCode: 'INVALID_PASSWORD',
    copy: "That current password isn't right.",
  },
] as const;

/** Failures of removing a sign-in method that have their own copy. */
const REMOVE_AUTH_SOURCE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The route refuses to remove the account's last sign-in method.
    status: 400,
    copy: LAST_AUTH_SOURCE_ERROR,
  },
];

type Status = 'loading' | 'ready' | 'error';

const noop = (): void => undefined;

/**
 * Sample sign-in methods for the loading state. They never show: `Skeleton`
 * measures the real rows rendered with them into bars.
 */
const SAMPLE_AUTH_SOURCES: readonly AuthSource[] = [
  {
    providerId: 'google',
    accountId: 'sample-google',
    label: 'Google',
    linkedAt: '2026-01-01T00:00:00.000Z',
    canUnlink: true,
  },
  {
    providerId: CREDENTIAL_PROVIDER_ID,
    accountId: 'sample-credential',
    label: 'Email and password',
    linkedAt: '2026-01-01T00:00:00.000Z',
    canUnlink: true,
  },
];

export interface SecurityPanelProps {
  brandDisplayName: string;
  emailPasswordAuthEnabled: boolean;
}

/** Human-friendly linked-on date; falls back to the raw value when unparseable. */
export function formatLinkedDate(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleDateString();
}

/**
 * "Security" tab content: sign-in methods (with set/change password), two-factor
 * setup, and API keys. Owns the auth-sources fetch that drives the sign-in-method
 * list and the credential/2FA state.
 */
export function SecurityPanel({
  brandDisplayName,
  emailPasswordAuthEnabled,
}: SecurityPanelProps): JSX.Element {
  const client = useSettingsClient();
  const navigation = useSettingsNavigation();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<AuthSourcesResponse | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const body: unknown = await client.read(
        'account.security.authSources',
        {},
      );
      if (!isAuthSourcesResponse(body)) {
        throw new Error('Invalid auth sources response');
      }
      setData(body);
      setStatus('ready');
    } catch (err: unknown) {
      setStatus('error');
      setError(errorCopy.loadFailure(err));
    }
  }, [client, errorCopy]);

  const retry = (): void => {
    // Back to the loading placeholder while the read runs again.
    setStatus('loading');
    setError(null);
    void refresh();
  };

  useEffect(() => {
    // Defer the initial load out of the synchronous effect body so the fetch's
    // setState does not trigger a cascading render (mirrors ApiKeysPanel).
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh]);

  const sources = (data?.sources ?? []).filter(
    (source) =>
      emailPasswordAuthEnabled || source.providerId !== CREDENTIAL_PROVIDER_ID,
  );
  const hasCredential = sources.some(
    (s) => s.providerId === CREDENTIAL_PROVIDER_ID,
  );
  const linkedProviders = new Set(sources.map((s) => s.providerId));

  const handleLink = (provider: SocialProviderId): void => {
    // The host owns the provider round trip. On web the OAuth callback
    // returns to `/account`; the unchanged session token + valid completion
    // cookie let the protected gate pass without re-prompting.
    navigation.openOAuth(provider);
  };

  return (
    <section className="flex flex-col gap-6">
      {status === 'loading' && (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading sign-in methods"
            testId="settings-skeleton-form"
          >
            <SettingsCard title="Sign-in methods">
              <ul className="flex flex-col">
                {SAMPLE_AUTH_SOURCES.map((source) => (
                  <AuthSourceRow
                    key={source.accountId}
                    source={source}
                    onRemoved={noop}
                  />
                ))}
              </ul>
            </SettingsCard>
          </Skeleton>
        </DelayedLoadingPlaceholder>
      )}

      <ErrorBanner
        errorSource="security-panel"
        className=""
        error={status === 'error' ? error?.copy : null}
        details={error?.details}
        onRetry={retry}
      />

      {status === 'ready' && data && (
        <>
          <SettingsCard title="Sign-in methods">
            <ul className="flex flex-col">
              {sources.map((source) => (
                <AuthSourceRow
                  key={source.accountId}
                  source={source}
                  onRemoved={() => void refresh()}
                />
              ))}
              {sources.length === 0 && (
                <li
                  className={`${SETTINGS_CARD_ROW_CLASS} text-s fg-secondary`}
                >
                  No sign-in methods found.
                </li>
              )}
            </ul>

            {SOCIAL_PROVIDER_IDS.some(
              (provider) => !linkedProviders.has(provider),
            ) ? (
              <div className={SETTINGS_CARD_ROW_CLASS}>
                <div className="min-w-0">
                  <div className="text-s font-medium fg-primary">
                    Add a sign-in method
                  </div>
                  <p className="text-xs text-pretty fg-secondary">
                    Sign in with another account you already use.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {SOCIAL_PROVIDER_IDS.map((provider) =>
                    linkedProviders.has(provider) ? null : (
                      <Button
                        key={provider}
                        size="compact"
                        variant="secondary"
                        onClick={() => handleLink(provider)}
                      >
                        Link {authSourceLabel(provider)}
                      </Button>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            {emailPasswordAuthEnabled && (
              <PasswordSection
                hasCredential={hasCredential}
                onChanged={() => void refresh()}
              />
            )}
          </SettingsCard>

          <TwoFactorSetupPanel
            twoFactorEnabled={data.user.twoFactorEnabled}
            hasCredential={hasCredential}
            brandDisplayName={brandDisplayName}
            onChanged={() => void refresh()}
          />
        </>
      )}

      {/* Rendered outside the auth-sources `status` conditional so API keys
          always show and manage their own fetch — an auth-sources load
          failure must not hide this panel. */}
      <SettingsCard title="API keys" testId="account-api-keys-section">
        <ApiKeysManager
          brandDisplayName={brandDisplayName}
          showHeading={false}
        />
      </SettingsCard>
    </section>
  );
}

/**
 * Provider glyph for a login-method row. Social providers render their real
 * brand logos (shared with the login page), Canopy SSO renders the neutral
 * key mark, and email/password plus unrecognized providers fall back to neutral
 * UI Kit marks. A `Map`, so a provider id such as `constructor` finds no
 * inherited `Object.prototype` member and takes the fallback.
 */
const AUTH_SOURCE_GLYPHS: ReadonlyMap<string, JSX.Element> = new Map([
  ['google', <GoogleIcon size={16} />],
  ['github', <GitHubIcon size="md" />],
  [UD_PROVIDER_ID, <UnstoppableDomainsIcon size={16} />],
  // Explicit entry, not the `Globe` fallback: without it an SSO row renders
  // the fallback globe and every test still passes.
  [SSO_SERVER_PROVIDER_ID, <SingleSignOnIcon size={16} />],
  [
    CREDENTIAL_PROVIDER_ID,
    <Mail
      size="sm"
      className="fg-secondary"
      aria-hidden="true"
      data-testid="auth-source-mail-icon"
    />,
  ],
]);

const FALLBACK_AUTH_SOURCE_GLYPH = (
  <Globe size="sm" className="fg-secondary" aria-hidden="true" />
);

interface AuthSourceRowProps {
  source: AuthSource;
  onRemoved: () => void;
}

/** A single linked sign-in method with its remove affordance / confirmation. */
export function AuthSourceRow({
  source,
  onRemoved,
}: AuthSourceRowProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const handleRemove = async (): Promise<void> => {
    setRemoving(true);
    setError(null);
    try {
      await client.write('account.security.unlinkAuthSource', {
        providerId: source.providerId,
        accountId: source.accountId,
      });
    } catch (err: unknown) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'remove this sign-in method',
          known: REMOVE_AUTH_SOURCE_KNOWN_ERRORS,
        }),
      );
      setRemoving(false);
      return;
    }
    onRemoved();
  };

  return (
    <li className={`${SETTINGS_CARD_ROW_CLASS} flex-wrap`}>
      <div className="flex items-center gap-3">
        {AUTH_SOURCE_GLYPHS.get(source.providerId) ??
          FALLBACK_AUTH_SOURCE_GLYPH}
        <div className="min-w-0 flex flex-col gap-1">
          <div>
            <p className="text-s font-medium fg-primary">{source.label}</p>

            <p className="text-xs fg-secondary">
              Linked {formatLinkedDate(source.linkedAt)}
            </p>
          </div>

          {error && (
            <div>
              <ErrorBanner
                errorSource="auth-source-row"
                className=""
                error={error.copy}
              />
            </div>
          )}
        </div>
      </div>

      {!source.canUnlink ? (
        <span className="text-xs fg-secondary">
          Add another method before removing
        </span>
      ) : confirming ? (
        <div className="flex flex-col items-end gap-1">
          <span className="text-xs fg-primary">
            Remove this sign-in method?
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="compact"
              variant="destructive"
              onClick={() => void handleRemove()}
              disabled={removing}
            >
              {removing ? 'Removing…' : 'Remove'}
            </Button>
            <Button
              size="compact"
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={removing}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="compact"
          variant="secondary"
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

interface PasswordSectionProps {
  hasCredential: boolean;
  onChanged: () => void;
}

/**
 * Set-password (OAuth-only users) or change-password (credential users) form.
 *
 * `setPassword` is server-only, so the set flow goes through Canopy's
 * `/api/account/password` route (`account.security.setPassword`); the change
 * flow is Better Auth's `changePassword` (`account.security.changePassword`).
 */
export function PasswordSection({
  hasCredential,
  onChanged,
}: PasswordSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(SECURITY_ERROR_SCOPE);
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [saved, setSaved] = useState(false);

  const close = (): void => {
    setOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      if (hasCredential) {
        await client.write('account.security.changePassword', {
          currentPassword,
          newPassword,
        });
      } else {
        await client.write('account.security.setPassword', { newPassword });
      }
      setSaved(true);
      close();
      onChanged();
    } catch (err: unknown) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'save the password',
          known: PASSWORD_KNOWN_ERRORS,
        }),
      );
      setSubmitting(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className="min-w-0">
          <div className="text-s font-medium fg-primary">Password</div>
          <p className="text-xs text-pretty fg-secondary" role="status">
            {saved
              ? PASSWORD_SAVED
              : hasCredential
                ? 'Sign in with your email and a password.'
                : 'Not set'}
          </p>
        </div>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => {
            setOpen(true);
            setSaved(false);
          }}
        >
          {hasCredential ? 'Change password' : 'Set password'}
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className={`${SETTINGS_CARD_ROW_CLASS} flex-col items-stretch gap-3`}
    >
      {hasCredential && (
        <FormField label="Current password">
          {(control) => (
            <TextInput
              {...control}
              density="settings"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
            />
          )}
        </FormField>
      )}
      <FormField label="New password">
        {(control) => (
          <TextInput
            {...control}
            density="settings"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
          />
        )}
      </FormField>

      <ErrorBanner
        errorSource="password-section"
        className=""
        error={error?.copy}
        details={error?.details}
      />

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="compact"
          variant="secondary"
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Save password'}
        </Button>
        <Button
          size="compact"
          variant="secondary"
          onClick={close}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
