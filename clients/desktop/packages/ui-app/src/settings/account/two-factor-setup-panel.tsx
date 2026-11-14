'use client';

import { useState, type FormEvent, type JSX } from 'react';
import { toDataURL } from 'qrcode';
import {
  Button,
  Disclosure,
  ErrorBanner,
  FormField,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { isOkResponse } from '@canopy/protocol/settings/account';
import { SettingsImage, useSettingsClient, useSettingsPrivacy } from '../host';
import { withPrivacyClass } from './privacy-class';
import { Surface } from '@canopy/ui-shared/components';

const INVALID_CODE_ERROR = 'Invalid verification code.';
const ENABLE_FAILED_ERROR = 'Unable to enable two-factor authentication.';
const DISABLE_FAILED_ERROR = 'Unable to disable two-factor authentication.';
const REGENERATE_FAILED_ERROR = 'Unable to regenerate backup codes.';
const COPY_FAILED_ERROR = 'Unable to copy backup codes.';

/** A step of the flow: a full-width row under the status row that starts it. */
const STEP_ROW_CLASS = `${SETTINGS_CARD_ROW_CLASS} flex-col items-stretch gap-3`;

/**
 * One of the discrete steps the panel can be in. The `view` is local UI state,
 * deliberately independent of the server's `twoFactorEnabled` flag: even though
 * Better Auth provisions the TOTP secret when `enable` resolves, the panel keeps
 * the user in the `verify` step until a code is confirmed through the custom
 * session route — only then is the account treated as enabled (and the
 * completion cookie set).
 */
type View =
  | 'idle'
  | 'enablePassword'
  | 'verify'
  | 'backupCodes'
  | 'disableConfirm'
  | 'regeneratePassword';

interface TwoFactorSetupPanelProps {
  /** Server-reported 2FA state (from `GET /api/account/auth-sources`). */
  twoFactorEnabled: boolean;
  /** Whether the user has an email/password (`credential`) account. */
  hasCredential: boolean;
  /** Brand name used as the authenticator `issuer`. */
  brandDisplayName: string;
  /** Re-fetch account state after a successful enable/disable. */
  onChanged: () => void;
}

export function TwoFactorSetupPanel({
  twoFactorEnabled,
  hasCredential,
  brandDisplayName,
  onChanged,
}: TwoFactorSetupPanelProps): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const [view, setView] = useState<View>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // Backup codes live ONLY in component state and are cleared on `Done`. They
  // are never written to localStorage / sessionStorage / IndexedDB or logged.
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [backupCodesCopied, setBackupCodesCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetTransient = (): void => {
    setPassword('');
    setCode('');
    setError(null);
  };

  const returnToIdle = (): void => {
    setView('idle');
    setTotpUri(null);
    setQrDataUrl(null);
    setBackupCodes(null);
    setBackupCodesCopied(false);
    resetTransient();
  };

  /** Provision the TOTP secret, then render the QR once `enable` resolves. */
  const runEnable = async (withPassword: string | undefined): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const { totpURI, backupCodes: codes } = await client.write(
        'account.security.twoFactor.enable',
        withPassword
          ? { password: withPassword, issuer: brandDisplayName }
          : { issuer: brandDisplayName },
      );
      // Only now — after the server created the encrypted TOTP material — do we
      // build and show the QR (Phase F "Cannot ship if").
      const dataUrl = await toDataURL(totpURI);
      setTotpUri(totpURI);
      setQrDataUrl(dataUrl);
      setBackupCodes(codes);
      setBackupCodesCopied(false);
      setCode('');
      setPassword('');
      setView('verify');
    } catch {
      setError(ENABLE_FAILED_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnableClick = (): void => {
    resetTransient();
    if (hasCredential) {
      setView('enablePassword');
      return;
    }
    void runEnable(undefined);
  };

  const handleEnablePasswordSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (submitting) return;
    void runEnable(password);
  };

  /**
   * Verify the first TOTP code through the custom session route (NOT a bare
   * `verifyTotp`) so the rotated session cookie propagates and the
   * `canopy.two_factor_verified` completion cookie is set — leaving the user in
   * a 2FA-complete state instead of being bounced to `/two-factor`.
   */
  const handleVerifySubmit = async (
    e: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // The entry trims the code and sends `purpose: 'setup'`.
      const data: unknown = await client.write(
        'account.security.twoFactor.verify',
        { code },
      );
      if (!isOkResponse(data)) {
        setError(INVALID_CODE_ERROR);
        setSubmitting(false);
        return;
      }
      // 2FA is now active; refresh server-driven state and show backup codes.
      onChanged();
      setTotpUri(null);
      setQrDataUrl(null);
      setCode('');
      setView('backupCodes');
    } catch {
      setError(INVALID_CODE_ERROR);
      setSubmitting(false);
    } finally {
      setSubmitting(false);
    }
  };

  const runDisable = async (
    withPassword: string | undefined,
  ): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      await client.write(
        'account.security.twoFactor.disable',
        withPassword ? { password: withPassword } : {},
      );
      // Clear the local completion cookie so the next protected navigation does
      // not assume a 2FA-complete session (Transport B2).
      await client
        .write('account.security.twoFactor.clearSession', {})
        .catch(() => null);
      onChanged();
      returnToIdle();
    } catch {
      setError(DISABLE_FAILED_ERROR);
      setSubmitting(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisableConfirm = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (submitting) return;
    void runDisable(hasCredential ? password : undefined);
  };

  const runRegenerate = async (
    withPassword: string | undefined,
  ): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await client.write(
        'account.security.twoFactor.backupCodes',
        withPassword ? { password: withPassword } : {},
      );
      setBackupCodes(result.backupCodes);
      setBackupCodesCopied(false);
      setPassword('');
      setView('backupCodes');
    } catch {
      setError(REGENERATE_FAILED_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegenerateClick = (): void => {
    resetTransient();
    if (hasCredential) {
      setView('regeneratePassword');
      return;
    }
    void runRegenerate(undefined);
  };

  const handleRegeneratePasswordSubmit = (
    e: FormEvent<HTMLFormElement>,
  ): void => {
    e.preventDefault();
    if (submitting) return;
    void runRegenerate(password);
  };

  const handleCopyBackupCodes = async (): Promise<void> => {
    if (!backupCodes) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setBackupCodesCopied(true);
    } catch {
      setBackupCodesCopied(false);
      setError(COPY_FAILED_ERROR);
    }
  };

  // `h3` → `h2` (via `SettingsCard`) is correct now: this is a first-level
  // sibling of the Sign-in methods and API keys cards, not a subsection. The
  // inner subheadings moved `h4` → `h3` to match, so the panel does not skip a
  // level (axe `heading-order`). The status row carries the idle actions; each
  // step of a flow is a full-width row under it.
  return (
    <SettingsCard title="Two-factor authentication">
      <>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0">
            <div className="text-s font-medium fg-primary">
              Authenticator app
            </div>
            <p className="text-xs text-pretty fg-secondary">
              {twoFactorEnabled
                ? 'Two-factor authentication is enabled for this account.'
                : 'Add an authenticator app to require a code when signing in.'}
            </p>
          </div>
          {view === 'idle' &&
            (twoFactorEnabled ? (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Button
                  size="compact"
                  onClick={() => {
                    resetTransient();
                    setView('disableConfirm');
                  }}
                >
                  Disable 2FA
                </Button>
                <Button size="compact" onClick={handleRegenerateClick}>
                  Regenerate backup codes
                </Button>
              </div>
            ) : (
              <Button
                size="compact"
                onClick={handleEnableClick}
                disabled={submitting}
              >
                {submitting ? 'Enabling…' : 'Enable 2FA'}
              </Button>
            ))}
        </div>

        {view === 'enablePassword' && (
          <form
            onSubmit={handleEnablePasswordSubmit}
            className={STEP_ROW_CLASS}
          >
            <FormField label="Password">
              {(control) => (
                <TextInput
                  {...control}
                  density="settings"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              )}
            </FormField>
            <div className="flex items-center gap-2">
              <Button type="submit" size="compact" disabled={submitting}>
                {submitting ? 'Enabling…' : 'Enable 2FA'}
              </Button>
              <Button
                size="compact"
                onClick={returnToIdle}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {view === 'verify' && qrDataUrl && (
          <div
            className={`${SETTINGS_CARD_ROW_CLASS} flex-col items-stretch gap-4`}
          >
            {/* The QR and its setup key encode the TOTP secret: the whole
                block is hidden from session replay. */}
            <div
              className={withPrivacyClass(
                'flex flex-col gap-2',
                blockClassName,
              )}
              data-testid="two-factor-qr-block"
            >
              <Heading level={3} variant="title">
                Scan this QR code
              </Heading>
              <SettingsImage
                src={qrDataUrl}
                alt="Two-factor authentication QR code"
                width={176}
                height={176}
                unoptimized
                className="rounded-md border bg-white p-2"
              />
              {totpUri && (
                <Disclosure label="Setup key" dataTestId="two-factor-setup-key">
                  <Surface
                    variant="group"
                    size="small"
                    className="overflow-hidden"
                  >
                    <code
                      className={withPrivacyClass(
                        'block overflow-x-auto px-3 py-2 font-mono text-xs fg-primary',
                        blockClassName,
                      )}
                    >
                      {totpUri}
                    </code>
                  </Surface>
                </Disclosure>
              )}
            </div>
            <form
              onSubmit={(e) => void handleVerifySubmit(e)}
              className="flex flex-col gap-3"
            >
              <FormField label="Authentication code">
                {(control) => (
                  <TextInput
                    {...control}
                    density="settings"
                    mono
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={submitting}
                  />
                )}
              </FormField>
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="compact"
                  disabled={submitting || code.trim().length === 0}
                >
                  {submitting ? 'Verifying…' : 'Verify and finish'}
                </Button>
                <Button
                  size="compact"
                  onClick={returnToIdle}
                  disabled={submitting}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}

        {view === 'backupCodes' && backupCodes && (
          <div className={STEP_ROW_CLASS}>
            <Heading level={3} variant="title">
              Save your backup codes
            </Heading>
            <p className="text-s fg-secondary">
              These codes are shown once. Store them somewhere safe.
            </p>
            <Surface variant="group" size="small" padding="compact">
              <ul
                className={withPrivacyClass(
                  'grid grid-cols-2 gap-2',
                  blockClassName,
                )}
              >
                {backupCodes.map((backupCode) => (
                  <li key={backupCode} className="font-mono text-s fg-primary">
                    {backupCode}
                  </li>
                ))}
              </ul>
            </Surface>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="compact"
                onClick={() => void handleCopyBackupCodes()}
              >
                {backupCodesCopied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="compact" onClick={returnToIdle}>
                Done
              </Button>
            </div>
          </div>
        )}

        {view === 'disableConfirm' && (
          <form onSubmit={handleDisableConfirm} className={STEP_ROW_CLASS}>
            <p className="text-s fg-primary">
              Disable two-factor authentication?
            </p>
            {hasCredential && (
              <FormField label="Password">
                {(control) => (
                  <TextInput
                    {...control}
                    density="settings"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={submitting}
                  />
                )}
              </FormField>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="compact"
                variant="destructive"
                disabled={submitting}
              >
                {submitting ? 'Disabling…' : 'Disable 2FA'}
              </Button>
              <Button
                size="compact"
                onClick={returnToIdle}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {view === 'regeneratePassword' && (
          <form
            onSubmit={handleRegeneratePasswordSubmit}
            className={STEP_ROW_CLASS}
          >
            <FormField label="Password">
              {(control) => (
                <TextInput
                  {...control}
                  density="settings"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              )}
            </FormField>
            <div className="flex items-center gap-2">
              <Button type="submit" size="compact" disabled={submitting}>
                {submitting ? 'Generating…' : 'Regenerate backup codes'}
              </Button>
              <Button
                size="compact"
                onClick={returnToIdle}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        <ErrorBanner
          errorSource="two-factor-setup-panel"
          className="mb-3"
          error={error}
        />
      </>
    </SettingsCard>
  );
}
