'use client';

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  LocalMemoryNotify,
  LocalMemorySyncClient,
  LocalMemorySyncScopeState,
  LocalMemorySyncSettingsPatch,
  LocalMemorySyncState,
} from '@canopy/app-core/local-memory';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Notice,
  NoticeButton,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsSubRow,
  SettingsRowsValue,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  memorySyncFailureText,
  memorySyncStatusLine,
} from './memory-sync-copy';
import {
  MemorySyncMergeReview,
  useMemorySyncState,
  type MemorySyncReviewUiState,
} from './MemorySyncPanelParts';

export type { MemorySyncReviewUiState };

/**
 * The Sync section as its host's assistant context sees it: the switches,
 * the user scope's state and counts, and the dialog open in it.
 */
export interface MemorySyncSettingsUiState {
  /** Memory sync is offered here, so the section shows. */
  readonly available: boolean;
  readonly signedIn: boolean;
  readonly enabled: boolean;
  readonly userScope: 'sync' | 'device_only' | null;
  readonly cloudConsolidation: 'allowed' | 'disallowed' | null;
  readonly scopeState: LocalMemorySyncScopeState | null;
  /** "This computer's memories aren't synced yet" shows with its review. */
  readonly needsReview: boolean;
  readonly conflicts: number;
  readonly waitingToSend: number;
  readonly keptOnDevice: number;
  readonly restoreBeforeMergeAvailable: boolean;
  readonly saving: boolean;
  /** A control's failure is showing, as a code. */
  readonly failure: string | null;
  readonly review: MemorySyncReviewUiState | null;
  readonly confirming: 'delete' | 'restore' | null;
}

export interface MemorySyncSettingsProps {
  readonly sync: LocalMemorySyncClient;
  readonly notify: LocalMemoryNotify;
  /** What the section shows, for the host's assistant context. */
  readonly onUiStateChange?: (state: MemorySyncSettingsUiState | null) => void;
}

/** Sync is on for the user scope and this computer's memories wait for a review. */
function memorySyncNeedsReview(state: LocalMemorySyncState): boolean {
  const user = state.user;
  return (
    state.settings?.enabled === true &&
    state.settings.userScope === 'sync' &&
    (user?.state === 'needs_first_enable' ||
      user?.state === 'merging' ||
      user?.state === 'deleted_in_cloud')
  );
}

function memorySyncSettingsUiState(
  state: LocalMemorySyncState | null,
  saving: keyof LocalMemorySyncSettingsPatch | null,
  failure: string | null,
  review: MemorySyncReviewUiState | null,
  confirming: 'delete' | 'restore' | null,
): MemorySyncSettingsUiState | null {
  if (state === null) return null;
  const settings = state.settings;
  const user = state.user;
  return {
    available:
      state.availability === 'available' || state.availability === 'signed_out',
    signedIn: state.availability !== 'signed_out',
    enabled: settings?.enabled === true,
    userScope: settings?.userScope ?? null,
    cloudConsolidation:
      settings?.serverConsolidationAvailable === true
        ? settings.serverConsolidation
        : null,
    scopeState: user?.state ?? null,
    needsReview: memorySyncNeedsReview(state),
    conflicts: user?.conflicts.length ?? 0,
    waitingToSend: user?.waitingToSend ?? 0,
    keptOnDevice: user?.keptOnDevice ?? 0,
    restoreBeforeMergeAvailable: user?.preMergeRevision != null,
    saving: saving !== null,
    failure,
    review,
    confirming,
  };
}

/**
 * Settings › Memory's sync section (design §14.4, §17, D11): the account's
 * opt-in, the switch for memories saved for every project, consent for the
 * cloud to consolidate, the first-enable merge, the restore that undoes it,
 * and deleting from the cloud, which is not the same as turning sync off.
 */
export function MemorySyncSettings({
  sync,
  notify,
  onUiStateChange,
}: MemorySyncSettingsProps): JSX.Element | null {
  const state = useMemorySyncState(sync);
  const [saving, setSaving] = useState<
    keyof LocalMemorySyncSettingsPatch | null
  >(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<MemorySyncReviewUiState | null>(null);
  const [confirming, setConfirming] = useState<'delete' | 'restore' | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // A control's answer shows at once; the next broadcast replaces it.
  const [override, setOverride] = useState<LocalMemorySyncState | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [state]);
  const current = override ?? state;
  const error = failure === null ? null : memorySyncFailureText(failure);
  const closeReview = useCallback((): void => {
    setReviewing(false);
    setReview(null);
  }, []);
  const uiState = useMemo(
    () =>
      memorySyncSettingsUiState(current, saving, failure, review, confirming),
    [current, saving, failure, review, confirming],
  );
  useEffect(() => {
    onUiStateChange?.(uiState);
  }, [uiState, onUiStateChange]);
  useEffect(
    () => (): void => {
      onUiStateChange?.(null);
    },
    [onUiStateChange],
  );
  if (current === null) return null;
  if (current.availability === 'not_offered') return null;

  const signedOut = current.availability === 'signed_out';
  const settings = current.settings;
  const enabled = settings?.enabled === true;
  const user = current.user;
  const status = memorySyncStatusLine(current);

  const change = async (
    key: keyof LocalMemorySyncSettingsPatch,
    patch: LocalMemorySyncSettingsPatch,
  ): Promise<void> => {
    setSaving(key);
    setFailure(null);
    try {
      const result = await sync.updateSettings(patch);
      setOverride(result.state);
      if (!result.ok) setFailure(result.code);
    } catch {
      setFailure('offline');
    } finally {
      setSaving(null);
    }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setConfirmError(null);
    try {
      const result =
        confirming === 'delete'
          ? await sync.deleteFromCloud()
          : user?.preMergeRevision != null
            ? await sync.restore(user.preMergeRevision)
            : null;
      if (result === null) return;
      setOverride(result.state);
      if (!result.ok) {
        setConfirmError(memorySyncFailureText(result.code));
        return;
      }
      notify({
        message:
          confirming === 'delete'
            ? 'Memories deleted from the cloud. Sync is off.'
            : 'Restored your memories from before the merge.',
      });
      setConfirming(null);
    } catch {
      setConfirmError(memorySyncFailureText('offline'));
    } finally {
      setBusy(false);
    }
  };

  const needsMerge = memorySyncNeedsReview(current);

  return (
    <SettingsRowsSection
      title="Sync"
      description="Keep the same memories on every computer you sign in to. Your memories stay on this computer too."
      dataTestId="memory-sync-settings"
    >
      {needsMerge && (
        <Notice
          intent="attention"
          title="This computer's memories aren't synced yet"
          shape="settings"
          role="none"
          actions={
            <NoticeButton
              variant="primary"
              onClick={() => setReviewing(true)}
              data-testid="memory-sync-review-merge"
            >
              Review merge
            </NoticeButton>
          }
          data-testid="memory-sync-merge-notice"
        >
          See how they merge with your other computers' memories before anything
          is sent.
        </Notice>
      )}
      <SettingsRowsGroup>
        <SettingsRowsRow
          label="Sync across computers"
          htmlFor="memory-sync-enabled"
          description={
            signedOut
              ? 'Sign in to sync your memories across your computers.'
              : 'Turning sync off keeps your memories in the cloud and on each computer.'
          }
          control={
            signedOut ? undefined : (
              <ToggleSwitch
                id="memory-sync-enabled"
                label="Sync across computers"
                checked={enabled}
                busy={saving === 'enabled'}
                disabled={settings === null || saving !== null}
                onChange={(next) => void change('enabled', { enabled: next })}
                dataTestId="memory-sync-enabled-toggle"
              />
            )
          }
        >
          {enabled && settings !== null && (
            <>
              <SettingsRowsSubRow
                label="Memories for every project"
                htmlFor="memory-sync-user-scope"
                description="Project memories stay on each computer."
                control={
                  <ToggleSwitch
                    id="memory-sync-user-scope"
                    label="Memories for every project"
                    checked={settings.userScope === 'sync'}
                    busy={saving === 'userScope'}
                    disabled={saving !== null}
                    onChange={(next) =>
                      void change('userScope', {
                        userScope: next ? 'sync' : 'device_only',
                      })
                    }
                    dataTestId="memory-sync-user-toggle"
                  />
                }
              />
              {settings.serverConsolidationAvailable && (
                <SettingsRowsSubRow
                  label="Consolidate in the cloud"
                  htmlFor="memory-sync-cloud-consolidation"
                  description="When none of your computers is on, the cloud consolidates new memories for you."
                  control={
                    <ToggleSwitch
                      id="memory-sync-cloud-consolidation"
                      label="Consolidate in the cloud"
                      checked={settings.serverConsolidation === 'allowed'}
                      busy={saving === 'serverConsolidation'}
                      disabled={saving !== null}
                      onChange={(next) =>
                        void change('serverConsolidation', {
                          serverConsolidation: next ? 'allowed' : 'disallowed',
                        })
                      }
                      dataTestId="memory-sync-cloud-consolidation-toggle"
                    />
                  }
                />
              )}
            </>
          )}
        </SettingsRowsRow>
        {enabled && status !== null && !needsMerge && (
          <SettingsRowsRow
            label="Status"
            fact
            control={
              <SettingsRowsValue dataTestId="memory-sync-settings-status">
                {status.text}
                {current.deviceLabel !== null && (
                  <>
                    {' · '}
                    <span className={REPLAY_MASK_CLASS}>
                      {current.deviceLabel}
                    </span>
                  </>
                )}
              </SettingsRowsValue>
            }
          />
        )}
        {user?.preMergeRevision != null && (
          <SettingsRowsRow
            label="Before the merge"
            description="Bring back your memories as they were before this computer's were merged in."
            control={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  setConfirmError(null);
                  setConfirming('restore');
                }}
                data-testid="memory-sync-restore-premerge"
              >
                Restore…
              </Button>
            }
          />
        )}
        {!signedOut && settings !== null && (
          <SettingsRowsRow
            label="Delete from the cloud"
            description="Removes your memories from the cloud for every computer and turns sync off. Each computer keeps its own copy."
            control={
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={() => {
                  setConfirmError(null);
                  setConfirming('delete');
                }}
                data-testid="memory-sync-delete-cloud"
              >
                Delete…
              </Button>
            }
          />
        )}
      </SettingsRowsGroup>
      {error !== null && <ErrorBanner error={error} />}
      {reviewing && (
        <MemorySyncMergeReview
          sync={sync}
          notify={notify}
          onClose={closeReview}
          onStateChange={setReview}
        />
      )}
      {confirming !== null && (
        <ConfirmDialog
          title={
            confirming === 'delete'
              ? 'Delete your memories from the cloud?'
              : 'Restore memories from before the merge?'
          }
          message={
            confirming === 'delete'
              ? 'Your memories and their history are removed from the cloud for every computer, and sync turns off. Each computer keeps its own copy.'
              : 'Your memories go back to how they were before this computer joined, on every computer. The merged version stays in history.'
          }
          confirmLabel={
            confirming === 'delete'
              ? 'Delete from the cloud'
              : 'Restore memories'
          }
          busyLabel={confirming === 'delete' ? 'Deleting…' : 'Restoring…'}
          busy={busy}
          destructive={confirming === 'delete'}
          errorMessage={confirmError}
          onConfirm={() => void confirm()}
          onCancel={() => setConfirming(null)}
          dataTestId="memory-sync-confirm-dialog"
          confirmTestId="memory-sync-confirm"
        />
      )}
    </SettingsRowsSection>
  );
}
