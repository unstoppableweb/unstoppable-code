'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  ProviderKeyProvider,
  ProviderKeyStatus,
} from '@canopy/protocol/canopy-core';
import { Button, FieldError, TextInput } from '@canopy/ui-shared/components';
import { ConfirmDialog } from '@canopy/ui-shared/components/ConfirmDialog';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ProviderSourceRow } from './ProviderSourceRow';

/** What a save or removal returned: done, or our sentence for why not. */
export type ProviderKeyRowOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface ProviderKeyRowProps {
  readonly provider: ProviderKeyProvider;
  /** The key's stored state, or `null` while it is being read. */
  readonly status: ProviderKeyStatus | null;
  /**
   * Saves the trimmed key. The host probes and stores it; the row clears its
   * input once this resolves `ok`, and keeps it with the error otherwise.
   */
  readonly onSave: (apiKey: string) => Promise<ProviderKeyRowOutcome>;
  readonly onRemove: () => Promise<ProviderKeyRowOutcome>;
  /** Under the row's lines, such as a host note. */
  readonly children?: ReactNode;
}

const PROVIDER_ROW: Record<
  ProviderKeyProvider,
  { readonly name: string; readonly icon: ReactNode }
> = {
  anthropic: {
    name: 'Claude API key',
    icon: <ClaudeLogo className="size-4" aria-hidden />,
  },
  openai: {
    name: 'ChatGPT API key',
    icon: <CodexLogo className="size-4" aria-hidden />,
  },
};

/**
 * The row's name, such as "Claude API key": named by the product people
 * know (Claude, ChatGPT), not the company that issues the key.
 */
export function providerKeyRowName(provider: ProviderKeyProvider): string {
  return PROVIDER_ROW[provider].name;
}

function modelCountLine(count: number): string {
  return count === 1
    ? '1 model is ready in your chats.'
    : `${count} models are ready in your chats.`;
}

function savedDescription(status: ProviderKeyStatus): string {
  const connected =
    status.keyHint === null
      ? 'Connected'
      : `Connected · ends in ${status.keyHint}`;
  // A key whose models weren't listed still works; it just has no count.
  return status.modelsListed
    ? `${connected}. ${modelCountLine(status.modelCount)}`
    : `${connected}.`;
}

function description(status: ProviderKeyStatus | null): string {
  if (status === null) return 'Checking…';
  switch (status.status) {
    case 'none':
      return 'Use your own key for cloud chats.';
    case 'saved':
      return savedDescription(status);
    case 'rejected':
      return 'Key rejected. Save it again.';
  }
}

function statusTone(
  status: ProviderKeyStatus | null,
): 'connected' | 'failed' | 'pending' | 'signed-out' {
  if (status === null) return 'pending';
  switch (status.status) {
    case 'saved':
      return 'connected';
    case 'rejected':
      return 'failed';
    case 'none':
      return 'signed-out';
  }
}

/**
 * One provider's own API key as a provider row: its status, then a masked
 * editor while a key is being entered. The typed key lives only in this
 * row's state until Save resolves, and is cleared on success, Cancel and
 * unmount; it never enters shared state. Settings › Model providers mounts
 * it today; the first-visit chooser can render it in its list.
 */
export function ProviderKeyRow({
  provider,
  status,
  onSave,
  onRemove,
  children,
}: ProviderKeyRowProps): JSX.Element {
  const row = PROVIDER_ROW[provider];
  const testId = `provider-key-row-${provider}`;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const busyRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const run = async (
    action: 'save' | 'remove',
    call: () => Promise<ProviderKeyRowOutcome>,
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(action);
    setError(null);
    try {
      const outcome = await call();
      if (!mountedRef.current) return outcome.ok;
      if (outcome.ok) {
        setKey('');
        setEditing(false);
      } else {
        setError(outcome.error);
      }
      return outcome.ok;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };

  const save = (): void => {
    const apiKey = key.trim();
    if (!apiKey) return;
    void run('save', () => onSave(apiKey));
  };

  const cancel = (): void => {
    setKey('');
    setError(null);
    setEditing(false);
  };

  const stored = status !== null && status.status !== 'none';
  const control = editing ? undefined : status === null ? undefined : (
    <div className="flex items-center gap-2">
      {stored && (
        <Button
          type="button"
          variant="ghost"
          size="compact"
          disabled={busy !== null}
          data-testid={`${testId}-remove`}
          onClick={() => {
            setError(null);
            setRemoveOpen(true);
          }}
        >
          Remove
        </Button>
      )}
      <Button
        type="button"
        variant="secondary"
        size="compact"
        ref={editButtonRef}
        disabled={busy !== null}
        data-testid={`${testId}-edit`}
        onClick={() => setEditing(true)}
      >
        {stored ? 'Change' : 'Connect'}
      </Button>
    </div>
  );

  return (
    <>
      <ProviderSourceRow
        icon={row.icon}
        name={row.name}
        status={statusTone(status)}
        statusTestId={`${testId}-status`}
        description={<span role="status">{description(status)}</span>}
        {...(error !== null && !editing && !removeOpen
          ? { error, errorTestId: `${testId}-error` }
          : {})}
        control={control}
        dataTestId={testId}
      >
        {editing && (
          <form
            // Never recorded by session replay, input value included.
            className={`${REPLAY_BLOCK_CLASS} flex w-full flex-col gap-2`}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <TextInput
              ref={inputRef}
              density="settings"
              mono
              type="password"
              aria-label={row.name}
              autoComplete="off"
              spellCheck={false}
              value={key}
              // Read-only, not disabled: disabling the focused field drops
              // focus to the page when Enter saves.
              readOnly={busy !== null}
              {...(error !== null
                ? { 'aria-invalid': true, 'aria-describedby': errorId }
                : {})}
              data-testid={`${testId}-input`}
              onChange={(event) => setKey(event.target.value)}
            />
            {error !== null && (
              <FieldError id={errorId} announce data-testid={`${testId}-error`}>
                {error}
              </FieldError>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="compact"
                disabled={busy !== null}
                data-testid={`${testId}-cancel`}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="compact"
                disabled={busy !== null || !key.trim()}
                data-testid={`${testId}-save`}
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        )}
        {children}
      </ProviderSourceRow>
      {removeOpen ? (
        <ConfirmDialog
          destructive
          title={`Remove your ${row.name}?`}
          message="It's deleted. Chats on its models stop working until you save a key again."
          confirmLabel={`Remove ${row.name}`}
          busyLabel="Removing…"
          busy={busy === 'remove'}
          dataTestId={`${testId}-remove-confirm`}
          errorMessage={error}
          errorSource="provider-key-remove"
          restoreFocusRef={editButtonRef}
          onCancel={() => {
            // A failed removal's error belongs to the dialog, not the row.
            setError(null);
            setRemoveOpen(false);
          }}
          onConfirm={() =>
            // On success the row drops back to Connect; on failure the dialog
            // stays open with the reason.
            void run('remove', onRemove).then((removed) => {
              if (removed && mountedRef.current) setRemoveOpen(false);
            })
          }
        />
      ) : null}
    </>
  );
}
