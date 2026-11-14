import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useEffect, useState, type JSX } from 'react';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
  normalizeManagedDelegationLifetimeLimit,
  managedDelegationLifetimeLimitChoices,
  MAX_MANAGED_DELEGATION_DEPTH,
  MAX_MANAGED_DELEGATION_CONCURRENCY,
  type ManagedDelegationMode,
} from '@canopy/protocol/delegation/discovery';
import {
  SettingsSelect,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  emitManagedDelegationPreferenceUpdated,
  subscribeManagedDelegationPreferenceUpdated,
} from '@/lib/managedDelegationPreferenceEvents';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = "Couldn't save managed delegation settings.";

const MODE_OPTIONS: readonly SettingsSelectOption<ManagedDelegationMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'explicit-only', label: 'Only when requested' },
  { value: 'proactive', label: 'When useful' },
];

const CONCURRENCY_OPTIONS: readonly SettingsSelectOption[] = Array.from(
  { length: MAX_MANAGED_DELEGATION_CONCURRENCY },
  (_, i) => ({ value: String(i + 1), label: String(i + 1) }),
);

const DEPTH_OPTIONS: readonly SettingsSelectOption[] = Array.from(
  { length: MAX_MANAGED_DELEGATION_DEPTH },
  (_, i) => ({
    value: String(i + 1),
    label: i === 0 ? '1 (no nesting)' : String(i + 1),
  }),
);

interface ManagedDelegationSettingsProps {
  initialMode: ManagedDelegationMode;
  initialRevocationIncomplete?: boolean;
  initialMaxConcurrent?: number;
  initialMaxDepth?: number;
  initialLifetimeLimit?: number;
}

/** Host-neutral policy choices; model/runtime discovery belongs to the parent tool. */
export function ManagedDelegationSettings({
  initialMode,
  initialMaxConcurrent,
  initialMaxDepth,
  initialLifetimeLimit,
  initialRevocationIncomplete = false,
}: ManagedDelegationSettingsProps): JSX.Element {
  const [mode, setMode] = useState(initialMode);
  const [maxConcurrent, setMaxConcurrent] = useState(
    normalizeManagedDelegationMaxConcurrent(initialMaxConcurrent),
  );
  const [saving, setSaving] = useState(false);
  const [maxDepth, setMaxDepth] = useState(
    normalizeManagedDelegationMaxDepth(initialMaxDepth),
  );
  const [error, setError] = useState<InlineFailure | null>(null);
  const [lifetimeLimit, setLifetimeLimit] = useState(
    normalizeManagedDelegationLifetimeLimit(initialLifetimeLimit),
  );
  const lifetimeLimitChoices = managedDelegationLifetimeLimitChoices();
  const [revocationIncomplete, setRevocationIncomplete] = useState(
    initialRevocationIncomplete,
  );
  const windows = window.platform === 'win32';
  const supported =
    window.platform === 'darwin' || window.platform === 'linux' || windows;

  useEffect(() => {
    const unsubscribePreferenceUpdate =
      subscribeManagedDelegationPreferenceUpdated((update) => {
        setMode(update.mode);
        if (update.maxDepth !== undefined) setMaxDepth(update.maxDepth);
        if (update.maxConcurrent !== undefined)
          setMaxConcurrent(update.maxConcurrent);
        if (update.lifetimeLimit !== undefined)
          setLifetimeLimit(update.lifetimeLimit);
        setRevocationIncomplete(update.revocationIncomplete);
      });
    const unsubscribePreferencesSync =
      typeof window.api.onPreferencesSynced === 'function'
        ? window.api.onPreferencesSynced((preferences) => {
            if (preferences.managedDelegationLifetimeLimit !== undefined)
              setLifetimeLimit(
                normalizeManagedDelegationLifetimeLimit(
                  preferences.managedDelegationLifetimeLimit,
                ),
              );
            if (preferences.managedDelegationMaxDepth !== undefined)
              setMaxDepth(
                normalizeManagedDelegationMaxDepth(
                  preferences.managedDelegationMaxDepth,
                ),
              );
            if (preferences.managedDelegationMaxConcurrent !== undefined)
              setMaxConcurrent(
                normalizeManagedDelegationMaxConcurrent(
                  preferences.managedDelegationMaxConcurrent,
                ),
              );
            if (preferences.managedDelegationMode !== undefined) {
              setMode(preferences.managedDelegationMode);
            }
            if (
              preferences.__managedDelegationRevocationIncomplete !== undefined
            ) {
              setRevocationIncomplete(
                preferences.__managedDelegationRevocationIncomplete,
              );
            }
          })
        : undefined;
    return (): void => {
      unsubscribePreferenceUpdate();
      unsubscribePreferencesSync?.();
    };
  }, []);

  useCurrentUiStateReporter('settings.managedDelegation', {
    loaded: true,
    mode,
    maxDepth,
    lifetimeLimit,
    revocationIncomplete,
  });

  async function save(
    patch: Partial<
      Pick<
        PreferencesData,
        | 'managedDelegationMode'
        | 'managedDelegationMaxConcurrent'
        | 'managedDelegationMaxDepth'
        | 'managedDelegationLifetimeLimit'
      >
    >,
  ): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const saved = await window.api.savePreferences(patch);
      const nextLifetimeLimit = normalizeManagedDelegationLifetimeLimit(
        saved.managedDelegationLifetimeLimit,
      );
      setLifetimeLimit(nextLifetimeLimit);
      const nextMaxDepth = normalizeManagedDelegationMaxDepth(
        saved.managedDelegationMaxDepth,
      );
      setMaxDepth(nextMaxDepth);
      const nextMaxConcurrent = normalizeManagedDelegationMaxConcurrent(
        saved.managedDelegationMaxConcurrent,
      );
      setMaxConcurrent(nextMaxConcurrent);
      setMode(saved.managedDelegationMode ?? 'off');
      setRevocationIncomplete(
        saved.__managedDelegationRevocationIncomplete === true,
      );
      emitManagedDelegationPreferenceUpdated({
        mode: saved.managedDelegationMode ?? 'off',
        maxConcurrent: nextMaxConcurrent,
        maxDepth: nextMaxDepth,
        lifetimeLimit: nextLifetimeLimit,
        revocationIncomplete:
          saved.__managedDelegationRevocationIncomplete === true,
      });
    } catch (caught) {
      const appError = toAppError(resolveClientAppError(caught));
      if (appError) setError(inlineFailure(appError, SAVE_ERROR_MESSAGE));
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection
      title="Managed delegation"
      description={
        <>
          Let Code worktree chats delegate tasks to another model. Tasks may use
          additional tokens. Children can read and search, and edit with
          explicit file permissions from the parent. Your approval settings
          still apply. Tasks share the current worktree unless isolation is
          requested.
          {windows && (
            <>
              {' '}
              <span data-testid="settings-managed-delegation-windows-codex">
                On Windows, Codex tasks run without the Codex sandbox and follow
                this chat&apos;s approval settings.
              </span>
            </>
          )}
        </>
      }
      dataTestId="managed-delegation-settings"
    >
      <DesktopErrorBanner
        errorSource="settings-managed-delegation-save-error"
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        onDismiss={(): void => setError(null)}
        testId="settings-managed-delegation-save-error"
      />
      <DesktopErrorBanner
        errorSource="settings-managed-delegation-revocation-incomplete"
        className=""
        error={
          error === null && revocationIncomplete
            ? "Managed delegation is off, but some child sessions couldn't be stopped."
            : null
        }
        onRetry={(): void => {
          void save({ managedDelegationMode: 'off' });
        }}
        retrying={saving}
        testId="settings-managed-delegation-revocation-incomplete"
      />
      <SettingsGroup>
        <SettingsRow
          label="Delegate tasks"
          htmlFor="managed-delegation-mode"
          description={
            supported
              ? 'Applies to new turns in Code worktree chats. Enabling replaces native subagent tools. Turning off cancels managed children; the parent chat continues.'
              : 'Managed delegation is currently available on macOS, Windows, and Linux.'
          }
          control={
            <SettingsSelect
              id="managed-delegation-mode"
              data-testid="settings-managed-delegation-mode"
              options={MODE_OPTIONS}
              value={mode}
              disabled={!supported || saving}
              onValueChange={(next) => {
                void save({
                  managedDelegationMode: normalizeManagedDelegationMode(next),
                });
              }}
            />
          }
        />
        <SettingsRow
          label="Maximum concurrent subagents"
          htmlFor="managed-delegation-concurrency"
          description={
            <span data-testid="settings-managed-delegation-concurrency-help">
              {`Active managed subagents across the whole chat, including nested agents. Defaults to 5. Tasks over the limit wait their turn and start automatically. Changes apply to new tasks; running tasks continue. The application-wide limit is ${MAX_MANAGED_DELEGATION_CONCURRENCY}.`}
            </span>
          }
          control={
            <SettingsSelect
              id="managed-delegation-concurrency"
              data-testid="settings-managed-delegation-concurrency"
              options={CONCURRENCY_OPTIONS}
              value={String(maxConcurrent)}
              disabled={!supported || saving}
              onValueChange={(next) => {
                void save({
                  managedDelegationMaxConcurrent: Number(next),
                });
              }}
            />
          }
        />
        <SettingsRow
          label="Maximum delegation depth"
          htmlFor="managed-delegation-depth"
          description="Direct children are depth 1. Each delegation must explicitly allow its child to delegate further. Changes limit new tasks; running tasks continue."
          control={
            <SettingsSelect
              id="managed-delegation-depth"
              data-testid="settings-managed-delegation-depth"
              options={DEPTH_OPTIONS}
              value={String(maxDepth)}
              disabled={!supported || saving}
              onValueChange={(next) => {
                void save({
                  managedDelegationMaxDepth: Number(next),
                });
              }}
            />
          }
        />
        <SettingsRow
          label="Lifetime limit"
          htmlFor="managed-delegation-lifetime-limit"
          description={
            <span data-testid="settings-managed-delegation-lifetime-limit-help">
              Managed delegates a worktree can start over its lifetime, separate
              from how many run at once.
              {lifetimeLimitChoices.length === 1 &&
                ` This build allows only ${lifetimeLimitChoices[0]}.`}
            </span>
          }
          control={
            <SettingsSelect
              id="managed-delegation-lifetime-limit"
              data-testid="settings-managed-delegation-lifetime-limit"
              options={lifetimeLimitChoices.map((choice) => ({
                value: String(choice),
                label: String(choice),
              }))}
              value={String(lifetimeLimit)}
              disabled={
                !supported || saving || lifetimeLimitChoices.length === 1
              }
              onValueChange={(next) => {
                void save({
                  managedDelegationLifetimeLimit:
                    normalizeManagedDelegationLifetimeLimit(Number(next)),
                });
              }}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
