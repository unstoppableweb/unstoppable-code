'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  Button,
  ErrorBanner,
  Heading,
  TextInput,
} from '@canopy/ui-shared/components';
import type { SettingsOperationResult } from '@canopy/protocol/settings';
import { useSettingsClient } from '../host';
import {
  settingsErrorFacts,
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../errors';
import { AI_GATEWAY_ERROR_SCOPE } from './ai-gateway-copy';

type CloudKeyStatus =
  SettingsOperationResult<'organization.settings.ai-gateway.cloud-key.read'>['status'];

// One line per stored state; `stale_url` is a key saved for an older address.
const STATUS_COPY: Record<CloudKeyStatus, string> = {
  none: 'Add your key so cloud chats can use this gateway.',
  saved: 'Cloud chats use your saved key.',
  rejected: "Your gateway didn't accept your saved key. Save a new one.",
  stale_url:
    'The gateway address changed since you saved your key. Save it again.',
};

// An address that isn't public HTTPS fails the server's probe as unreachable.
const SAVE_ERRORS: readonly KnownSettingsError[] = [
  {
    serverCode: 'key_rejected',
    copy: "Couldn't save your key. Your gateway didn't accept it.",
  },
  {
    serverCode: 'gateway_unreachable',
    copy: "Couldn't reach your gateway. Cloud chats need a public HTTPS address.",
  },
  {
    serverCode: 'gateway_off',
    copy: "Couldn't save your key. This AI gateway is turned off.",
  },
  {
    serverCode: 'gateway_changed',
    copy: "Couldn't save your key. The gateway changed while it was being checked. Try again.",
  },
  {
    serverCode: 'key_changed',
    copy: "Couldn't save your key. It was saved or removed somewhere else at the same time. Try again.",
  },
];

/** Codes after which the status on screen may be out of date. */
const REFRESH_CODES: ReadonlySet<string | undefined> = new Set([
  'gateway_changed',
  'key_changed',
]);

/**
 * Whether cloud chats take a key for this organization's gateway, whether or
 * not the gateway is on: the key routes answer 404 while cloud keys are off.
 * `null` until the read answers, or when it fails for another reason.
 */
export function useCloudChatsKeysAvailable(
  organizationId: string,
): boolean | null {
  const client = useSettingsClient();
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client
      .read('organization.settings.ai-gateway.cloud-key.read', {
        organizationId,
      })
      .then(
        () => {
          if (!cancelled) setAvailable(true);
        },
        (err: unknown) => {
          if (!cancelled)
            setAvailable(settingsErrorFacts(err).status === 404 ? false : null);
        },
      );
    return (): void => {
      cancelled = true;
    };
  }, [client, organizationId]);
  return available;
}

/**
 * The member's own key for cloud chats, saved on the server for this
 * organization's gateway (Personal included). Cloud chats can't reach a
 * device's secure storage, so this is separate from any desktop key. The
 * routes answer 404 while cloud keys are off, and the section then renders
 * nothing. It needs only the organization id and a settings host, so it can
 * also mount outside the settings page, such as in a dialog.
 */
export function CloudChatsKeySection({
  organizationId,
  baseUrl,
  revision,
}: {
  readonly organizationId: string;
  /** Re-reads the status when the gateway address changes. */
  readonly baseUrl?: string;
  /** Re-reads the status after a key is saved elsewhere on the page. */
  readonly revision?: number;
}): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const [status, setStatus] = useState<CloudKeyStatus | 'loading' | 'off'>(
    'loading',
  );
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [key, setKey] = useState('');
  const [reads, setReads] = useState(0);
  const busyRef = useRef(false);
  // Bumped by every save or removal, so a read that started earlier can't
  // replace the status the mutation returned.
  const generationRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const generation = generationRef.current;
    const stale = (): boolean =>
      cancelled || generation !== generationRef.current;
    setLoadError(null);
    void client
      .read('organization.settings.ai-gateway.cloud-key.read', {
        organizationId,
      })
      .then(
        (result) => {
          if (stale()) return;
          setStatus(result.status);
        },
        (err: unknown) => {
          if (stale()) return;
          if (settingsErrorFacts(err).status === 404) {
            setStatus('off');
          } else {
            setLoadError(errorCopy.loadFailure(err));
          }
        },
      );
    return (): void => {
      cancelled = true;
    };
  }, [client, errorCopy, organizationId, baseUrl, revision, reads]);

  const run = async (
    action: 'save' | 'remove',
    call: () => Promise<{ status: CloudKeyStatus }>,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    generationRef.current += 1;
    setBusy(action);
    setError(null);
    // The banner shows this action's outcome, not an older failed re-read.
    setLoadError(null);
    try {
      const result = await call();
      setStatus(result.status);
      if (action === 'save') setKey('');
      // Remove goes away with the key; keep keyboard focus on the page.
      else inputRef.current?.focus();
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: `${action} your key`,
          known: SAVE_ERRORS,
        }),
      );
      if (REFRESH_CODES.has(settingsErrorFacts(err).serverCode))
        setReads((count) => count + 1);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const save = (): void => {
    const apiKey = key.trim();
    if (!apiKey) return;
    void run('save', () =>
      client.write('organization.settings.ai-gateway.cloud-key.save', {
        organizationId,
        apiKey,
        ...(baseUrl === undefined ? {} : { expectedBaseUrl: baseUrl }),
      }),
    );
  };

  if (status === 'off') return null;
  if (status === 'loading' && loadError === null) return null;

  return (
    <section className={SETTINGS_CARD_CLASS} data-testid="ai-gateway-cloud-key">
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Cloud chats
        </Heading>
        {/* Your provider bills the model; the cloud machine is still ours. */}
        <p
          className={SETTINGS_CARD_SUBTITLE_CLASS}
          data-testid="ai-gateway-cloud-key-credits"
        >
          Cloud chats on your gateway&apos;s models still use AI Credits for the
          cloud machine they run on.
        </p>
      </div>
      <ErrorBanner
        error={(loadError ?? error)?.copy}
        details={(loadError ?? error)?.details}
        onRetry={
          loadError ? (): void => setReads((count) => count + 1) : undefined
        }
      />
      {status === 'loading' ? null : (
        <div className={SETTINGS_CARD_GROUP_CLASS}>
          <div className={SETTINGS_CARD_ROW_CLASS}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-s font-medium fg-primary">API key</span>
              <p
                role="status"
                className="text-xs text-pretty fg-secondary"
                data-testid="ai-gateway-cloud-key-status"
              >
                {STATUS_COPY[status]}
              </p>
            </div>
            {status === 'none' ? null : (
              <Button
                type="button"
                variant="secondary"
                size="compact"
                disabled={busy !== null}
                data-testid="ai-gateway-cloud-key-remove"
                onClick={() =>
                  void run('remove', () =>
                    client.write(
                      'organization.settings.ai-gateway.cloud-key.remove',
                      { organizationId },
                    ),
                  )
                }
              >
                {busy === 'remove' ? 'Removing…' : 'Remove'}
              </Button>
            )}
          </div>
          <form
            className={SETTINGS_CARD_ROW_CLASS}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="min-w-0 flex-1">
              <TextInput
                ref={inputRef}
                density="settings"
                mono
                type="password"
                aria-label="API key for cloud chats"
                autoComplete="off"
                value={key}
                // Read-only, not disabled: disabling the focused field drops
                // focus to the page when Enter saves.
                readOnly={busy !== null}
                data-testid="ai-gateway-cloud-key-input"
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="compact"
              disabled={busy !== null || !key.trim()}
              data-testid="ai-gateway-cloud-key-save"
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
