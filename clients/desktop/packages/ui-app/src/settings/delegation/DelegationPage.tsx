'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  accountDelegationSettingsSchema,
  CLOUD_DELEGATION_MAX_CONCURRENT,
  CLOUD_DELEGATION_MAX_DEPTH,
  DEFAULT_CLOUD_DELEGATION_MAX_CONCURRENT,
  DEFAULT_CLOUD_DELEGATION_MAX_DEPTH,
  type AccountDelegationSettings,
} from '@canopy/protocol/settings/account-delegation';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsSelect,
  Skeleton,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import type { SettingsFailure } from '../errors';

const ACCOUNT_DELEGATION_ERROR_SCOPE = 'settings.account.delegation';
const ROW_LABEL_CLASS = 'text-s font-medium fg-primary';
const ROW_DESCRIPTION_CLASS = 'text-s text-pretty fg-secondary';

const DEFAULT_SETTINGS: AccountDelegationSettings = {
  maxDepth: DEFAULT_CLOUD_DELEGATION_MAX_DEPTH,
  maxConcurrent: DEFAULT_CLOUD_DELEGATION_MAX_CONCURRENT,
};

const CONCURRENCY_OPTIONS: readonly SettingsSelectOption[] = Array.from(
  { length: CLOUD_DELEGATION_MAX_CONCURRENT },
  (_, index) => ({ value: String(index + 1), label: String(index + 1) }),
);

const DEPTH_OPTIONS: readonly SettingsSelectOption[] = Array.from(
  { length: CLOUD_DELEGATION_MAX_DEPTH },
  (_, index) => ({
    value: String(index + 1),
    label: index === 0 ? '1 (no nesting)' : String(index + 1),
  }),
);

function parseSettings(value: unknown): AccountDelegationSettings {
  const parsed = accountDelegationSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid delegation settings response');
  return {
    maxDepth: parsed.data.maxDepth,
    maxConcurrent: parsed.data.maxConcurrent,
  };
}

const noop = (): void => undefined;

type DelegationField = 'maxDepth' | 'maxConcurrent';

/** `record` without `field`'s entry. */
function withoutField<T>(
  record: Partial<Record<DelegationField, T>>,
  field: DelegationField,
): Partial<Record<DelegationField, T>> {
  const next: Partial<Record<DelegationField, T>> = {};
  if (field !== 'maxDepth' && record.maxDepth !== undefined)
    next.maxDepth = record.maxDepth;
  if (field !== 'maxConcurrent' && record.maxConcurrent !== undefined)
    next.maxConcurrent = record.maxConcurrent;
  return next;
}

/** The "Cloud chats" card: the two limits and their pickers. */
function CloudChatsCard({
  value,
  onChange,
  error,
  saving,
}: {
  readonly value: AccountDelegationSettings;
  readonly onChange: (field: DelegationField, value: number) => void;
  readonly error: SettingsFailure | null;
  /** The field whose save is running; both pickers wait for it. */
  readonly saving: DelegationField | null;
}): JSX.Element {
  const concurrencyLabelId = useId();
  const depthLabelId = useId();
  return (
    <SettingsCard
      title="Cloud chats"
      subtitle="A change applies to the next delegate a chat starts. Chats on a computer use the delegation settings in the desktop app."
      testId="account-delegation-cloud-chats"
    >
      {error !== null && (
        <ErrorBanner
          errorSource="delegation-card"
          className=""
          error={error.copy}
          details={error.details}
        />
      )}
      <div
        className={SETTINGS_CARD_ROW_CLASS}
        data-testid="settings-delegation-concurrency-row"
      >
        <div className="min-w-0">
          <p id={concurrencyLabelId} className={ROW_LABEL_CLASS}>
            Delegates at once
          </p>
          <p className={ROW_DESCRIPTION_CLASS}>
            The most delegates a chat and its delegates run at the same time.
            Others wait for a free place.
          </p>
        </div>
        <SettingsSelect
          options={CONCURRENCY_OPTIONS}
          value={String(value.maxConcurrent)}
          onValueChange={(next) =>
            onChange('maxConcurrent', Number.parseInt(next, 10))
          }
          aria-labelledby={concurrencyLabelId}
          disabled={saving !== null}
          busy={saving === 'maxConcurrent'}
          data-testid="settings-delegation-concurrency"
        />
      </div>
      <div
        className={SETTINGS_CARD_ROW_CLASS}
        data-testid="settings-delegation-depth-row"
      >
        <div className="min-w-0">
          <p id={depthLabelId} className={ROW_LABEL_CLASS}>
            Delegation levels
          </p>
          <p className={ROW_DESCRIPTION_CLASS}>
            How many levels of delegates can start below a chat. With 1, only
            the chat starts delegates.
          </p>
        </div>
        <SettingsSelect
          options={DEPTH_OPTIONS}
          value={String(value.maxDepth)}
          onValueChange={(next) =>
            onChange('maxDepth', Number.parseInt(next, 10))
          }
          aria-labelledby={depthLabelId}
          disabled={saving !== null}
          busy={saving === 'maxDepth'}
          data-testid="settings-delegation-depth"
        />
      </div>
    </SettingsCard>
  );
}

/**
 * `/account/delegation`: the owner's limits for delegates in their cloud
 * chats (CAN-7571), saved on the account for every workspace they own and
 * sent to Core with each new delegate. A pick shows while its save runs and
 * goes back if the save fails; the pickers wait while a save runs.
 */
// `account.delegation` page data is empty, so the page takes no props (it
// still satisfies the registry's `SettingsPageProps` component type).
export function DelegationPage(): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ACCOUNT_DELEGATION_ERROR_SCOPE);
  const [saved, setSaved] = useState<AccountDelegationSettings | null>(null);
  // The pick whose save is running, shown until it settles. One save runs
  // at a time and the pickers wait for it, so no pick is ever queued: each
  // goes out at once under the session it was made in.
  const [saving, setSaving] = useState<{
    readonly field: DelegationField;
    readonly value: number;
  } | null>(null);
  // Each field's last failed save; a failure reverts only its own field.
  const [failures, setFailures] = useState<
    Partial<Record<DelegationField, SettingsFailure>>
  >({});
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry so the load effect runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);
  // Set at once on a pick, so a second pick in the same frame is ignored.
  const saveRunning = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const next = parseSettings(
          await client.read('account.settings.delegation.read', {}),
        );
        if (!active) return;
        setSaved(next);
        setLoadError(null);
      } catch (caught: unknown) {
        if (active) setLoadError(errorCopy.loadFailure(caught));
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setLoadError(null);
    setSaved(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const onChange = useCallback(
    (field: DelegationField, value: number): void => {
      if (saveRunning.current) return;
      saveRunning.current = true;
      setSaving({ field, value });
      setFailures((current) => withoutField(current, field));
      const save = async (): Promise<void> => {
        try {
          const next = parseSettings(
            await client.write('account.settings.delegation.update', {
              [field]: value,
            }),
          );
          if (mounted.current) setSaved(next);
        } catch (caught: unknown) {
          if (mounted.current)
            setFailures((current) => ({
              ...current,
              [field]: errorCopy.actionFailure(caught, {
                action: 'save your choice',
              }),
            }));
          // A save whose answer was lost may still have landed: show what
          // the account holds now, not the value from before the pick.
          try {
            const held = parseSettings(
              await client.read('account.settings.delegation.read', {}),
            );
            if (mounted.current) setSaved(held);
          } catch {
            // Unread, the page keeps the last saved values beside the error.
          }
        } finally {
          saveRunning.current = false;
          if (mounted.current) setSaving(null);
        }
      };
      void save();
    },
    [client, errorCopy],
  );

  const shown =
    saved === null
      ? null
      : saving === null
        ? saved
        : { ...saved, [saving.field]: saving.value };
  const failure = failures.maxConcurrent ?? failures.maxDepth ?? null;
  return (
    <div className="flex flex-col gap-6" data-testid="account-delegation-page">
      {loadError !== null ? (
        <ErrorBanner
          errorSource="delegation-page-load"
          error={loadError.copy}
          details={loadError.details}
          onRetry={retryLoad}
        />
      ) : shown === null ? (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading delegation settings"
            testId="settings-skeleton-form"
          >
            <CloudChatsCard
              value={DEFAULT_SETTINGS}
              onChange={noop}
              error={null}
              saving={null}
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : (
        <CloudChatsCard
          value={shown}
          onChange={onChange}
          error={failure}
          saving={saving?.field ?? null}
        />
      )}
    </div>
  );
}
