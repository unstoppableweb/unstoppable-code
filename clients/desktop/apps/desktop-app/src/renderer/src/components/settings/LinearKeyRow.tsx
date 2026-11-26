import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import { unknownSecureStorageFailure } from '@/lib/secureStorageNotice';
import {
  Button,
  Notice,
  ProviderStatusDot,
  StatusLabel,
  TextLink,
} from '@canopy/ui-shared/components';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  useLinearStatus,
  invalidateLinearStatusCache,
} from '@/hooks/useLinearStatus';
import { notifyLinearConnectionChanged } from '@/lib/integrationConnectionEvents';
import {
  EyeIcon,
  EyeOffIcon,
  LinearIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { SettingsRow, SettingsTextField } from './SettingsLayout';

const TOKEN_SAVE_DEBOUNCE_MS = 600;

// Shared by every Linear key row: a remounted row's Linear read and saves wait
// behind the unmount flush of the row it replaced, so that write cannot land
// after a newer edit or leave a stale key on screen.
let linearTokenWriteQueue: Promise<void> = Promise.resolve();

/**
 * The Linear API key row: the saved key, its validation status, and the
 * secure-storage notices. Returns a bare `SettingsRow`, so the caller places
 * it in a group (the legacy Accounts tab) or a card (hosted Integrations).
 */
export function LinearKeyRow(): JSX.Element {
  const [linearValue, setLinearValue] = useState('');
  const [debouncedLinearValue, setDebouncedLinearValue] = useState('');
  const [linearLoaded, setLinearLoaded] = useState(false);
  const [linearVisible, setLinearVisible] = useState(false);
  const [linearStorageFailure, setLinearStorageFailure] =
    useState<SecureStorageFailure | null>(null);
  const [linearError, setLinearError] = useState<string | null>(null);
  const [linearSaving, setLinearSaving] = useState(false);
  const linearReadFailedRef = useRef(false);
  const linearSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestLinearRef = useRef(linearValue);
  const linearEditRevisionRef = useRef(0);
  const linearReadRequestRef = useRef(0);
  const linearSaveRequestRef = useRef(0);

  const linearStatus = useLinearStatus(debouncedLinearValue);
  const linearInputId = useId();
  const linearValidating =
    !linearError &&
    (linearSaving ||
      (linearLoaded && !!debouncedLinearValue && linearStatus === null));

  const loadLinearCredential = useCallback(async (): Promise<void> => {
    const editRevision = linearEditRevisionRef.current;
    const request = ++linearReadRequestRef.current;
    try {
      const token = await linearTokenWriteQueue.then(() =>
        window.api.loadLinearToken(),
      );
      if (
        request !== linearReadRequestRef.current ||
        editRevision !== linearEditRevisionRef.current
      )
        return;
      if (typeof token !== 'string') {
        linearReadFailedRef.current = true;
        setLinearStorageFailure(
          token.secureStorageFailure ?? unknownSecureStorageFailure('read'),
        );
        setLinearError(token.error);
        return;
      }
      const recoveredFailedRead = linearReadFailedRef.current;
      linearReadFailedRef.current = false;
      setLinearStorageFailure(null);
      setLinearError(null);
      setLinearValue(token);
      setDebouncedLinearValue(token);
      if (recoveredFailedRead) notifyLinearConnectionChanged();
    } catch {
      if (
        request !== linearReadRequestRef.current ||
        editRevision !== linearEditRevisionRef.current
      )
        return;
      setLinearStorageFailure(unknownSecureStorageFailure('read'));
      setLinearError('Couldn’t read your saved Linear key. Try again.');
      linearReadFailedRef.current = true;
    } finally {
      setLinearLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadLinearCredential();
  }, [loadLinearCredential]);

  const commitLinearCredential = useCallback(
    async (token: string): Promise<void> => {
      const editRevision = linearEditRevisionRef.current;
      const request = ++linearSaveRequestRef.current;
      const isCurrent = (): boolean =>
        request === linearSaveRequestRef.current &&
        editRevision === linearEditRevisionRef.current &&
        latestLinearRef.current === token;
      setLinearSaving(true);
      linearReadFailedRef.current = false;
      try {
        const save = linearTokenWriteQueue.then(() =>
          window.api.saveLinearToken(token),
        );
        linearTokenWriteQueue = save.then(
          () => undefined,
          () => undefined,
        );
        const result = await save;
        if (result.success) notifyLinearConnectionChanged();
        if (!isCurrent()) return;
        if (!result.success) {
          setLinearStorageFailure(
            result.secureStorageFailure ?? unknownSecureStorageFailure('write'),
          );
          setLinearError(result.error);
          return;
        }
        setLinearStorageFailure(null);
        setLinearError(null);
        setDebouncedLinearValue(token);
      } catch {
        if (isCurrent()) {
          setLinearStorageFailure(unknownSecureStorageFailure('write'));
          setLinearError('Couldn’t save your Linear key. Try again.');
        }
      } finally {
        if (isCurrent()) setLinearSaving(false);
      }
    },
    [],
  );

  const scheduleLinearSave = useCallback(
    (token: string): void => {
      if (linearSaveTimer.current) clearTimeout(linearSaveTimer.current);
      linearSaveTimer.current = setTimeout(() => {
        linearSaveTimer.current = null;
        void commitLinearCredential(token);
      }, TOKEN_SAVE_DEBOUNCE_MS);
    },
    [commitLinearCredential],
  );

  useEffect(() => {
    latestLinearRef.current = linearValue;
  }, [linearValue]);

  useEffect(() => {
    return (): void => {
      if (linearSaveTimer.current) {
        clearTimeout(linearSaveTimer.current);
        linearSaveTimer.current = null;
        const token = latestLinearRef.current;
        const queued = linearTokenWriteQueue.then(async () => {
          const result = await window.api.saveLinearToken(token);
          if (result.success) notifyLinearConnectionChanged();
        });
        linearTokenWriteQueue = queued.catch(() => undefined);
      }
    };
  }, []);

  function handleLinearChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const next = e.target.value;
    linearEditRevisionRef.current += 1;
    linearReadFailedRef.current = false;
    latestLinearRef.current = next;
    setLinearValue(next);
    setDebouncedLinearValue('');
    setLinearSaving(true);
    invalidateLinearStatusCache();
    scheduleLinearSave(next);
  }

  // One status line for the Linear row, like the provider rows beside it:
  // the signed-in account, the key's error, or where to get a key.
  let linearHint: ReactNode;
  if (linearError) {
    linearHint = 'Your key is not available.';
  } else if (linearValidating) {
    linearHint = 'Validating API key…';
  } else if (linearStatus?.authenticated) {
    // Session replay blocks the account name, not the copy around it.
    linearHint = linearStatus.displayName ? (
      <>
        Signed in as{' '}
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
          {linearStatus.displayName}
        </span>
      </>
    ) : (
      'API key is valid.'
    );
  } else {
    linearHint = (
      <>
        {linearStatus ? (
          <StatusLabel>{linearStatus.error || 'Invalid API key.'}</StatusLabel>
        ) : (
          'Optional.'
        )}{' '}
        Create a personal API key in{' '}
        <TextLink
          href="https://linear.app/settings/account/security/api-keys"
          size="xs"
          target="_blank"
          rel="noopener noreferrer"
        >
          Linear API settings
        </TextLink>
        .
      </>
    );
  }

  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          <LinearIcon size="md" className="shrink-0 fg-primary" aria-hidden />
          Linear
          {!linearError && linearStatus && (
            <ProviderStatusDot
              tone={linearStatus.authenticated ? 'connected' : 'failed'}
            />
          )}
        </span>
      }
      description={linearHint}
      control={
        <>
          <SettingsTextField
            id={linearInputId}
            width="md"
            aria-label="Linear API key"
            type={linearVisible ? 'text' : 'password'}
            value={linearValue}
            onChange={handleLinearChange}
            disabled={!linearLoaded}
            placeholder="lin_api_xxxxxxxxxxxxxxxxxxxx"
            data-testid="settings-linear-token-input"
          />
          <Button
            size="compact"
            variant="ghost"
            iconOnly
            aria-label={linearVisible ? 'Hide token' : 'Show token'}
            onClick={() => setLinearVisible((prev) => !prev)}
          >
            {linearVisible ? (
              <EyeOffIcon size="sm" aria-hidden />
            ) : (
              <EyeIcon size="sm" aria-hidden />
            )}
          </Button>
        </>
      }
    >
      <SecureStorageNotice
        failure={linearStorageFailure}
        retrying={linearSaving}
        onRetry={(): void => {
          if (linearReadFailedRef.current) void loadLinearCredential();
          else void commitLinearCredential(latestLinearRef.current);
        }}
      />
      {linearError && !linearStorageFailure && (
        <Notice intent="attention">{linearError}</Notice>
      )}
    </SettingsRow>
  );
}
