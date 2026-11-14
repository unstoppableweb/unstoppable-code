'use client';

import { Stack } from '@canopy/ui-shared/components/Stack';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  FormField,
  Skeleton,
  TextInput,
  EmptyStateRow,
  Heading,
} from '@canopy/ui-shared/components';
import { Copy, Plus, Trash2 } from '@canopy/ui-shared/icons/AppIcons';
import { formatDateTime } from '@canopy/ui-shared/lib';
import type {
  UserApiKeyListItem,
  UserApiKeySource,
} from '@canopy/protocol/settings/account';
import {
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import { withPrivacyClass } from './privacy-class';
import { useSettingsErrorCopy } from '../errors';
import { SETTINGS_CARD_ROW_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import type { SettingsFailure } from '../errors';
import { Divider, Surface } from '@canopy/ui-shared/components';

const API_KEYS_ERROR_SCOPE = 'api-keys-panel';

/**
 * Human-facing label for each key provenance value the list shows:
 *
 * - `MANUAL`: created by a user through the API-keys UI.
 * - `OAUTH_DESKTOP`: minted by the desktop OAuth-style sign-in flow.
 *
 * Raw tokens and SHA-256 hashes are NEVER part of a list row — only the
 * metadata needed to render rows, surface provenance, and identify keys for
 * deletion. A created key's `token` is the only raw `csk_…` value ever sent
 * to the client; the panel keeps it strictly in component state and clears
 * it on `Done` / unmount. It is never written to localStorage /
 * sessionStorage / IndexedDB.
 */
const SOURCE_LABELS: Partial<Record<UserApiKeySource, string>> = {
  MANUAL: 'Manual',
  OAUTH_DESKTOP: 'Desktop OAuth',
};

type PanelStatus = 'loading' | 'ready' | 'error';

const noop = (): void => undefined;

/**
 * Sample keys for the loading state. They never show: `Skeleton` measures the
 * real rows rendered with them into bars.
 */
const SAMPLE_API_KEYS: readonly UserApiKeyListItem[] = [
  {
    id: 'sample-key-1',
    name: 'Build server',
    source: 'MANUAL',
    createdIp: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
  },
  {
    id: 'sample-key-2',
    name: 'Desktop',
    source: 'OAUTH_DESKTOP',
    createdIp: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
  },
];

interface ApiKeysManagerProps {
  brandDisplayName: string;
  /** Render the "API keys" heading. Off when a modal already supplies a title. */
  showHeading?: boolean;
}

interface ApiKeysPanelProps {
  brandDisplayName: string;
}

/**
 * Build the per-key metadata line:
 * `Created {createdAt} · {sourceLabel} · IP {createdIpOrUnknown} · {lastUsedText}`
 *
 * - `createdIpOrUnknown` is the raw IP string or `Unknown` when absent.
 * - `lastUsedText` is `Last used {lastUsedAt}` or `Never used`.
 */
export function formatApiKeyMetadata(key: UserApiKeyListItem): string {
  const sourceLabel = SOURCE_LABELS[key.source] ?? key.source;
  const createdIpOrUnknown =
    key.createdIp && key.createdIp.trim().length > 0
      ? key.createdIp
      : 'Unknown';
  const lastUsedText = key.lastUsedAt
    ? `Last used ${formatDateTime(key.lastUsedAt)}`
    : 'Never used';
  return `Created ${formatDateTime(key.createdAt)} · ${sourceLabel} · IP ${createdIpOrUnknown} · ${lastUsedText}`;
}

/**
 * Section-chrome wrapper around {@link ApiKeysManager}. Retained for callers
 * that want the standalone card; the dashboard no longer renders it (API keys
 * now live as a panel on the account details page), but it stays exported for
 * tests and any future standalone placement.
 */
export function ApiKeysPanel({
  brandDisplayName,
}: ApiKeysPanelProps): JSX.Element {
  return (
    <Surface as="section" variant="raised">
      <div className="p-8">
        <ApiKeysManager brandDisplayName={brandDisplayName} />
      </div>
    </Surface>
  );
}

/**
 * API key list/create/revoke management content, without outer card chrome so
 * it can render inside the dashboard section or the account details page panel.
 */
export function ApiKeysManager({
  brandDisplayName,
  showHeading = true,
}: ApiKeysManagerProps): JSX.Element {
  const client = useSettingsClient();
  const host = useSettingsHost();
  const logger = useMemo(() => host.logger(API_KEYS_ERROR_SCOPE), [host]);
  const errorCopy = useSettingsErrorCopy(API_KEYS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [keys, setKeys] = useState<UserApiKeyListItem[]>([]);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createdToken, setCreatedToken] = useState<{
    token: string;
    userApiKey: UserApiKeyListItem;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);

  const clearCopiedTimeout = useCallback((): void => {
    if (copiedTimeoutRef.current) {
      window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus('loading');
      setLoadError(null);
      setError(null);
      const data = await client.read('account.apiKeys.list', {});
      setKeys(Array.isArray(data) ? data : []);
      setStatus('ready');
    } catch (err: unknown) {
      setStatus('error');
      setLoadError(errorCopy.loadFailure(err));
    }
  }, [client, errorCopy]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, 0);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [refresh]);

  useEffect(() => {
    return clearCopiedTimeout;
  }, [clearCopiedTimeout]);

  const handleStartCreate = (): void => {
    setCreating(true);
    setNewName('');
    setError(null);
  };

  const handleCancelCreate = (): void => {
    setCreating(false);
    setNewName('');
  };

  const handleSubmitCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      setSubmitting(true);
      setError(null);
      const data = await client.write('account.apiKeys.create', { name });
      setCreatedToken({ token: data.token, userApiKey: data.userApiKey });
      setKeys((prev) => [data.userApiKey, ...prev]);
      setCreating(false);
      setNewName('');
    } catch (err: unknown) {
      setError(errorCopy.actionFailure(err, { action: 'create the API key' }));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      clearCopiedTimeout();
      setCopied(true);
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimeoutRef.current = null;
      }, 1500);
    } catch (err: unknown) {
      logger.error('Failed to copy token to clipboard', { error: err });
    }
  };

  const handleDoneToken = (): void => {
    clearCopiedTimeout();
    setCreatedToken(null);
    setCopied(false);
  };

  const handleRequestDelete = (id: string): void => {
    setPendingDeleteId(id);
  };

  const handleCancelDelete = (): void => {
    setPendingDeleteId(null);
  };

  const handleConfirmDelete = async (id: string): Promise<void> => {
    try {
      setDeletingId(id);
      setError(null);
      await client.write('account.apiKeys.revoke', { apiKeyId: id });
      setKeys((prev) => prev.filter((k) => k.id !== id));
      setPendingDeleteId(null);
    } catch (err: unknown) {
      setError(errorCopy.actionFailure(err, { action: 'revoke the API key' }));
    } finally {
      setDeletingId(null);
    }
  };

  // Every part of the manager is a row of the section's grouped box, so the
  // box hands its vertical inset to the rows: the explanation with its Create
  // action, the create form, and one row per key.
  return (
    <div>
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className="min-w-0">
          {showHeading && (
            <Heading level={2} variant="page">
              API keys
            </Heading>
          )}
          <p className="max-w-xl text-xs text-pretty fg-secondary">
            Create manual API keys for {brandDisplayName} clients and review
            keys created by desktop OAuth sign-in. Newly created manual keys are
            shown once and stored only as a secure hash.
          </p>
        </div>
        {!creating && !createdToken && (
          <Button size="compact" onClick={handleStartCreate}>
            <Plus size={14} aria-hidden="true" />
            Create manual API key
          </Button>
        )}
      </div>

      <ErrorBanner
        errorSource="api-keys-manager-load"
        className="mb-3"
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={() => void refresh()}
      />
      <ErrorBanner
        errorSource="api-keys-manager"
        className="mb-3"
        error={error?.copy}
        details={error?.details}
      />

      {createdToken && (
        <Surface
          gap="item"
          variant="group"
          size="small"
          padding="default"
          className="mb-3"
          aria-live="polite"
        >
          <Stack gap="tight">
            <p className="text-s font-medium fg-primary">
              Copy this API key now. It will not be shown again.
            </p>
            <p className="text-xs fg-secondary">
              Name: {createdToken.userApiKey.name}
            </p>
          </Stack>
          <div className="flex items-center gap-2">
            <Surface
              variant="card"
              size="small"
              className="flex-1 overflow-hidden"
            >
              <code
                className={withPrivacyClass(
                  'block overflow-x-auto px-3 py-2 font-mono text-xs fg-primary',
                  blockClassName,
                )}
              >
                {createdToken.token}
              </code>
            </Surface>
            <Button size="compact" onClick={() => void handleCopy()}>
              <Copy size={14} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="compact" onClick={handleDoneToken}>
              Done
            </Button>
          </div>
        </Surface>
      )}

      {creating && (
        <form
          onSubmit={(event) => void handleSubmitCreate(event)}
          className={`${SETTINGS_CARD_ROW_CLASS} flex-col items-stretch gap-3`}
        >
          <FormField label="Name">
            {(control) => (
              <TextInput
                {...control}
                density="settings"
                type="text"
                autoFocus
                required
                maxLength={256}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="compact"
              disabled={submitting || !newName.trim()}
            >
              {submitting ? 'Creating…' : 'Create manual API key'}
            </Button>
            <Button size="compact" onClick={handleCancelCreate}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {status === 'loading' && (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading API keys"
            testId="settings-skeleton-list"
          >
            <div>
              <Divider />
              <ul className="flex flex-col">
                {SAMPLE_API_KEYS.map((key) => (
                  <ApiKeyRow
                    key={key.id}
                    apiKey={key}
                    pendingDelete={false}
                    deleting={false}
                    onRequestDelete={noop}
                    onConfirmDelete={noop}
                    onCancelDelete={noop}
                  />
                ))}
              </ul>
            </div>
          </Skeleton>
        </DelayedLoadingPlaceholder>
      )}
      {status === 'ready' && keys.length === 0 && !creating && (
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <EmptyStateRow title="No API keys yet." />
        </div>
      )}
      {status === 'ready' && keys.length > 0 && (
        <div>
          <Divider />
          <ul className="flex flex-col">
            {keys.map((key) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                pendingDelete={pendingDeleteId === key.id}
                deleting={deletingId === key.id}
                onRequestDelete={handleRequestDelete}
                onConfirmDelete={(id) => void handleConfirmDelete(id)}
                onCancelDelete={handleCancelDelete}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface ApiKeyRowProps {
  apiKey: UserApiKeyListItem;
  pendingDelete: boolean;
  deleting: boolean;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}

/**
 * Presentational row for a single API key. Renders the key name, the
 * provenance/IP/last-used metadata line, and the delete affordance. Kept as a
 * standalone export so it can be unit-tested without driving the list-loading
 * fetch in {@link ApiKeysPanel}.
 */
export function ApiKeyRow({
  apiKey,
  pendingDelete,
  deleting,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: ApiKeyRowProps): JSX.Element {
  return (
    // The key's facts wrap under its name; its actions keep the row's
    // trailing edge, like every settings row.
    <li className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-s font-medium fg-primary">{apiKey.name}</p>
        <p className="text-xs fg-secondary">{formatApiKeyMetadata(apiKey)}</p>
      </div>
      {pendingDelete ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="compact"
            variant="destructive"
            onClick={() => onConfirmDelete(apiKey.id)}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Confirm'}
          </Button>
          <Button size="compact" onClick={onCancelDelete} disabled={deleting}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="compact"
          className="shrink-0"
          onClick={() => onRequestDelete(apiKey.id)}
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete
        </Button>
      )}
    </li>
  );
}
