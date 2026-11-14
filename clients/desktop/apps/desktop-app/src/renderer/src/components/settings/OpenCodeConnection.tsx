import { AuthLoginModal } from './AuthLoginModal';
import { Fragment, useEffect, useRef, useState, type JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { ModelProviderIcon } from '@canopy/ui-shared';
import type { OpenCodeConnectionStatus } from '@canopy/desktop-shared/types/opencode-connection';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureWithMainSentence,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

interface OpenCodeConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Labs.
   */
  readonly placement?: 'row' | 'section';
}

export function OpenCodeConnection({
  placement = 'section',
}: OpenCodeConnectionProps = {}): JSX.Element | null {
  const [status, setStatus] = useState<OpenCodeConnectionStatus>();
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InlineFailure | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const api = window.api.opencodeConnection;
    if (!api) return;
    const off = api.onProgress((value) => {
      if (mounted.current) setStatus(value);
    });
    void api
      .status()
      .then((value) => {
        if (mounted.current && !operation.current) setStatus(value);
      })
      .catch((reason: unknown) => {
        const appError = toAppError(resolveClientAppError(reason));
        if (appError && mounted.current)
          setError(
            inlineFailure(
              appError,
              "Couldn't check OpenCode setup. Reopen this page to check again.",
            ),
          );
      });
    return (): void => {
      mounted.current = false;
      off();
      if (operation.current)
        void api.cancel().catch((reason: unknown) => {
          reportClientAppError(reason);
        });
    };
  }, []);
  const act = async (kind: 'connect' | 'disconnect'): Promise<void> => {
    const api = window.api.opencodeConnection;
    if (!api || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      await api[kind]();
      const next = await api.status();
      emitPreferencesUpdated(await window.api.loadPreferences());
      if (mounted.current) setStatus(next);
    } catch (reason) {
      const appError = toAppError(resolveClientAppError(reason));
      if (appError && mounted.current)
        setError(
          inlineFailureWithMainSentence(
            appError,
            kind === 'connect'
              ? "Couldn't connect OpenCode."
              : "Couldn't disconnect OpenCode.",
          ),
        );
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (status && !status.supported) return null;
  const connected = status?.enabled && status.installed;
  const label = !status
    ? 'Checking setup…'
    : !busy
      ? connected
        ? 'OpenCode connected'
        : 'Ready to connect'
      : status.phase === 'downloading'
        ? `Downloading OpenCode${status.percent === undefined ? '…' : `… ${status.percent}%`}`
        : status.phase === 'discovering'
          ? 'Loading your OpenCode models…'
          : status.phase === 'verifying'
            ? 'Verifying download…'
            : 'Preparing OpenCode…';
  // As a row, the caller's provider group supplies the section and box.
  const Section = placement === 'row' ? Fragment : SettingsSection;
  const Group = placement === 'row' ? Fragment : SettingsGroup;
  return (
    // Untitled: the row itself names OpenCode, so a heading would repeat it.
    <Section>
      <Group>
        <SettingsRow
          dataTestId="opencode-connection"
          label={
            <span className="inline-flex items-center gap-2">
              <ModelProviderIcon
                provider="opencode"
                size={16}
                className="shrink-0 fg-primary"
                aria-hidden
              />
              OpenCode
            </span>
          }
          description="Connect your configured OpenCode providers. Their billing and usage limits apply."
          control={
            <>
              <Button
                size="compact"
                variant={connected ? 'secondary' : 'primary'}
                disabled={busy || !status}
                data-testid="opencode-connect"
                onClick={() => {
                  void act(connected ? 'disconnect' : 'connect');
                }}
              >
                {connected ? 'Disconnect' : 'Connect OpenCode'}
              </Button>
              {status?.installed && (
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={busy}
                  data-testid="opencode-provider-login"
                  onClick={() => setLogin(true)}
                >
                  {connected ? 'Manage providers' : 'Sign in to a provider'}
                </Button>
              )}
              {busy && (
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="opencode-cancel"
                  onClick={() => {
                    void window.api.opencodeConnection
                      ?.cancel()
                      .catch((reason: unknown) => {
                        const appError = toAppError(
                          resolveClientAppError(reason),
                        );
                        if (appError && mounted.current)
                          setError(
                            inlineFailure(
                              appError,
                              "Couldn't cancel OpenCode setup.",
                            ),
                          );
                      });
                  }}
                >
                  Cancel
                </Button>
              )}
            </>
          }
        >
          <p
            role="status"
            className="text-xs fg-secondary"
            data-testid="opencode-connection-status"
          >
            {label}
          </p>
          {!connected && (
            <p className="text-xs fg-secondary">
              Connect to download OpenCode, then sign in to a provider. Existing
              OpenCode accounts and provider settings are reused. Download size
              {status?.archiveBytes
                ? ` (${Math.round(status.archiveBytes / 1_000_000)} MB)`
                : ''}
              .
            </p>
          )}
          <DesktopErrorBanner
            errorSource="opencode-connection-error"
            className=""
            error={error?.error}
            {...(error?.details === undefined
              ? {}
              : { details: error.details })}
            onDismiss={(): void => setError(null)}
            testId="opencode-connection-error"
          />
        </SettingsRow>
      </Group>
      {login && (
        <AuthLoginModal
          provider="opencode"
          onClose={() => {
            setLogin(false);
            void window.api.opencodeConnection
              ?.listModels()
              .catch((reason: unknown) => {
                reportClientAppError(reason);
              });
          }}
        />
      )}
    </Section>
  );
}
