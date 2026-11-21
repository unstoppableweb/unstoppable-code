import { type JSX, useEffect, useRef, useState } from 'react';
import {
  linkRecordedAppError,
  type SkillUpdateError,
} from '@canopy/ui-shared/lib';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { useShareAccess } from '@/hooks/useShareAccess';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import { SHARE_SKILL_GATE_CONTEXT } from '@/lib/share-gate-context';
import { canShareSkill } from '@/lib/invocableShareTarget';
import { brandText } from '@/lib/brand';
import { DeleteConfirmModal } from '../shared';
import { ShareSkillModal } from './ShareSkillModal';
import {
  beginSkillUpdateCheck,
  recordSkillUpdateApplied,
  recordSkillUpdateCheck,
  beginSkillUpdateApply,
  endSkillUpdateApply,
  useSkillUpdateAvailability,
  useSkillUpdateCheckedAt,
  useSkillUpdatesApplying,
} from './skillUpdateStatus';

interface SkillIdentity {
  sourceId: string;
  name: string;
}

/** Share needs the skill's cloud share to reopen on it instead of a first share. */
type ShareableSkill = SkillIdentity & Pick<InstalledSkillInfo, 'remote'>;

export interface InstalledSkillActionsOptions {
  /** Detail identity; changing it invalidates pending page actions. */
  updateContextKey?: string;
  /**
   * Re-reads the installed inventory after a removal. Awaited before the
   * confirmation closes so the list never shows a row that is already gone.
   */
  onSkillsChanged: () => Promise<void>;
  /** Updates notify all inventories and report refresh failures separately. */
  onUpdateInventoryRefresh?: () => Promise<void>;
  /** The skill no longer exists locally: it was removed. */
  onSkillGone?: (skill: SkillIdentity) => void;
  /** The share dialog completed. */
  onShared?: (detail: SharedSkillDetail) => void;
  onPublicLinkRemoved?: () => void;
  onOpenAccountSettings?: () => void;
  /**
   * The skill was updated and the inventory refresh was attempted; the
   * detail page reloads the skill's content (CAN-4264).
   */
  onSkillUpdated?: (skill: SkillIdentity) => void;
  /** A check for updates finished, including one started elsewhere. */
  onUpdateCheckComplete?: () => void;
}

export type SkillUpdatePending = 'none' | 'checking' | 'applying';

export interface InstalledSkillActions {
  /** The Share dialog is open (reported to App Advisor by the list). */
  shareDialogOpen: boolean;
  canShare: (skill: InstalledSkillInfo) => boolean;
  requestShare: (skill: ShareableSkill) => void;
  canRemove: (skill: InstalledSkillInfo) => boolean;
  /** Opens the Delete (custom) or Remove (installed) confirmation. */
  requestRemove: (skill: InstalledSkillInfo) => void;
  isRemoving: (skill: SkillIdentity) => boolean;
  /** The Skills list's update eligibility: neither built-in nor custom. */
  canUpdate: (skill: InstalledSkillInfo) => boolean;
  /** Known availability, falling back to the inventory's cached flag. */
  updateAvailable: (skill: InstalledSkillInfo) => boolean;
  /** One update operation at a time per hook instance. */
  updatePending: SkillUpdatePending;
  /** An update of `skill` is running, from this view or another. */
  isUpdating: (skill: SkillIdentity) => boolean;
  /** Checks the whole inventory; there is no per-skill check. */
  checkUpdates: () => void;
  applyUpdate: (skill: SkillIdentity) => void;
  /**
   * The update error for `skill`, where a failed check applies to every
   * skill; without `skill`, any update error.
   */
  updateErrorFor: (skill?: SkillIdentity) => string | null;
  /**
   * The same error for the detail page's notice: a failed check, a failed
   * update, or a skill its source no longer has. A failure to reload after
   * a committed update is not one of them; it stays `updateErrorFor`'s.
   */
  updateFailureFor: (skill: SkillIdentity) => SkillUpdateError | undefined;
  /** When a check last completed in this renderer, if ever. */
  updateCheckedAt: number | null;
  clearUpdateError: () => void;
  /** Share gate, share dialog, and removal confirmation; render once. */
  dialogs: JSX.Element;
}

function skillKey(skill: SkillIdentity): string {
  return `${skill.sourceId}/${skill.name}`;
}

const CHECK_FAILED = 'Failed to check for updates.';
// The main process's message when a skill's source no longer lists it
// (`skill-service.ts` `updateSkill`). IPC results carry no error code.
const MISSING_FROM_SOURCE = /no longer found in source/i;
const UPDATE_FAILED = 'Failed to update skill.';
export const SKILL_UPDATE_REFRESH_FAILED =
  'The skill was updated, but the latest version couldn\u2019t be loaded. Reopen the skill to see it.';

/** When the inventory says the install last changed, if it says. */
function changedAt(skill: InstalledSkillInfo): number | undefined {
  const times = [skill.installedAt, skill.updatedAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  return times.length > 0 ? Math.max(...times) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface UpdateError {
  /** The skill key an update failed for; `null` for a failed check. */
  key: string | null;
  message: string;
  /** Main already recorded the failure, so its notice records nothing. */
  recorded?: true;
}

/**
 * Share, Delete/Remove, and updates (CAN-4264) for locally installed skills
 * (CAN-3482). One implementation backs both the Installed Skills list rows
 * and the installed skill detail page, so their eligibility, confirmation,
 * and update flows cannot drift. Instances share implementation, not
 * pending state; known update availability is shared through
 * `skillUpdateStatus`.
 */
export function useInstalledSkillActions({
  onSkillsChanged,
  onUpdateInventoryRefresh,
  updateContextKey,
  onSkillGone,
  onShared,
  onPublicLinkRemoved,
  onOpenAccountSettings,
  onSkillUpdated,
  onUpdateCheckComplete,
}: InstalledSkillActionsOptions): InstalledSkillActions {
  const { requestShare, shareGateModal } = useShareAccess();
  const refreshUpdates = onUpdateInventoryRefresh ?? onSkillsChanged;
  const [sharingSkill, setSharingSkill] = useState<ShareableSkill | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    sourceId: string;
    name: string;
    custom: boolean;
  } | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  // Electron main already recorded the failure: show it, never record it a
  // second time from the dialog.
  const [removalErrorRecorded, setRemovalErrorRecorded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [backgroundChecking, setBackgroundChecking] = useState(false);
  const backgroundChecks = useRef(0);
  // Context switches abandon the UI operation, not its uncorrelated progress.
  const abandonedChecks = useRef(0);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<UpdateError | null>(null);
  const availability = useSkillUpdateAvailability();
  const updateCheckedAt = useSkillUpdateCheckedAt();
  const applyingElsewhere = useSkillUpdatesApplying();
  // Synchronous guard: a second click lands before React re-renders.
  const updateBusy = useRef(false);
  // Bumped on a context switch and on unmount; an operation that started
  // under an earlier value leaves this instance's state alone.
  const updateScope = useRef(0);
  const seenUpdateContext = useRef(updateContextKey);
  // The sequence of the check whose `running` progress this instance saw.
  const progressCheck = useRef(0);
  const progressContextValid = useRef(true);
  const latestOptions = useRef({ onSkillUpdated, onUpdateCheckComplete });
  latestOptions.current = { onSkillUpdated, onUpdateCheckComplete };

  // A skill from the previous Personal/organization context must not stay
  // open in a share or removal dialog after the switch.
  useWorkspaceContextReset((): void => {
    setSharingSkill(null);
    setPendingRemoval(null);
    setRemovalError(null);
    setRemovalErrorRecorded(false);
    updateScope.current += 1;
    updateBusy.current = false;
    setChecking(false);
    setBackgroundChecking(false);
    abandonedChecks.current += backgroundChecks.current;
    backgroundChecks.current = 0;
    progressCheck.current = 0;
    progressContextValid.current = false;
    setUpdatingKey(null);
    setUpdateError(null);
  });

  useEffect((): (() => void) => {
    return (): void => {
      updateScope.current += 1;
    };
  }, []);

  useEffect(() => {
    if (seenUpdateContext.current === updateContextKey) return;
    seenUpdateContext.current = updateContextKey;
    updateScope.current += 1;
    updateBusy.current = false;
    abandonedChecks.current += backgroundChecks.current;
    backgroundChecks.current = 0;
    progressCheck.current = 0;
    progressContextValid.current = false;
    setBackgroundChecking(false);
    setChecking(false);
    setUpdatingKey(null);
    setUpdateError(null);
  }, [updateContextKey]);

  // Checks run for the whole inventory, including background checks, and
  // report progress to every window. Each mounted list or detail follows
  // them, as the Skills list always has.
  useEffect((): (() => void) | undefined => {
    if (typeof window.skills.onUpdateProgress !== 'function') {
      return undefined;
    }
    return window.skills.onUpdateProgress((progress) => {
      if (progress.operation !== 'check-updates') return;
      if (progress.status === 'running') {
        progressContextValid.current = true;
        backgroundChecks.current += 1;
        // Progress has no operation ID. Once starts overlap, none of their
        // completions can safely be attributed to the newest start.
        progressCheck.current =
          backgroundChecks.current === 1 && abandonedChecks.current === 0
            ? beginSkillUpdateCheck()
            : 0;
        setBackgroundChecking(true);
        if (!updateBusy.current) setUpdateError(null);
      } else if (
        progress.status === 'complete' ||
        progress.status === 'error'
      ) {
        const observed = backgroundChecks.current > 0;
        if (abandonedChecks.current > 0) abandonedChecks.current -= 1;
        else
          backgroundChecks.current = Math.max(0, backgroundChecks.current - 1);
        setBackgroundChecking(backgroundChecks.current > 0);
        if (progress.status === 'complete') {
          if (progressContextValid.current && progress.updateMap) {
            recordSkillUpdateCheck(
              progress.updateMap,
              observed ? progressCheck.current : 0,
            );
          }
          if (progressContextValid.current)
            latestOptions.current.onUpdateCheckComplete?.();
        } else if (progressContextValid.current && !updateBusy.current) {
          setUpdateError({
            key: null,
            message: progress.message || CHECK_FAILED,
          });
        }
        if (backgroundChecks.current === 0) progressCheck.current = 0;
      }
    });
  }, []);

  const checkUpdates = async (): Promise<void> => {
    if (updateBusy.current || backgroundChecks.current > 0) return;
    updateBusy.current = true;
    const scope = updateScope.current;
    const sequence = beginSkillUpdateCheck();
    setChecking(true);
    setUpdateError(null);
    let failure: string | null = null;
    try {
      const result = await window.skills.checkUpdates();
      if (scope !== updateScope.current) return;
      if (result.success && result.data) {
        recordSkillUpdateCheck(result.data, sequence);
        if (scope === updateScope.current) await refreshUpdates();
      } else {
        failure = result.error || CHECK_FAILED;
      }
    } catch (err) {
      failure = errorMessage(err);
    }
    if (scope !== updateScope.current) return;
    updateBusy.current = false;
    setChecking(false);
    if (failure !== null) setUpdateError({ key: null, message: failure });
  };

  const applyUpdate = async (skill: SkillIdentity): Promise<void> => {
    if (updateBusy.current || backgroundChecks.current > 0) return;
    const key = skillKey(skill);
    // Another view may already be updating this skill.
    if (!beginSkillUpdateApply(key)) return;
    updateBusy.current = true;
    const scope = updateScope.current;
    const { sourceId, name } = skill;
    setUpdatingKey(key);
    setUpdateError(null);
    let failure: string | null = null;
    let recorded = false;
    try {
      const result = await window.skills.updateSkill(sourceId, name);
      if (result.success) {
        // Recorded even if this surface is gone: the skill was updated.
        recordSkillUpdateApplied(key);
        try {
          // The mutation committed even if its page is gone. Both hosts use
          // the global notification path, refreshing the currently mounted
          // inventories; only the page's content callback is scoped below.
          await refreshUpdates();
        } catch {
          failure = SKILL_UPDATE_REFRESH_FAILED;
        }
        if (scope === updateScope.current) {
          latestOptions.current.onSkillUpdated?.({ sourceId, name });
        }
      } else {
        failure = result.error || UPDATE_FAILED;
        // Main recorded it; the notice records nothing but links it to this session.
        linkRecordedAppError(result.appError, 'skill-update-notice');
        recorded = result.appError?.recordedBy !== undefined;
      }
    } catch (err) {
      failure = errorMessage(err);
    }
    // Released after the refresh, even if this view moved on.
    endSkillUpdateApply(key);
    if (scope !== updateScope.current) return;
    updateBusy.current = false;
    setUpdatingKey(null);
    if (failure !== null)
      setUpdateError({
        key,
        message: failure,
        ...(recorded ? { recorded: true as const } : {}),
      });
  };

  // Built-in skills are shared as snapshot copies under the sharer's
  // account; `canShareSkill` is the one rule the chat-side Share entry
  // points and the Marketplace share resolver reuse. Sign-in is gated by
  // `requestShare` at click time.
  const canShare = (skill: InstalledSkillInfo): boolean => canShareSkill(skill);

  const canRemove = (skill: InstalledSkillInfo): boolean => !skill.builtIn;

  const confirmRemoval = async (): Promise<void> => {
    if (!pendingRemoval) return;
    const key = skillKey(pendingRemoval);
    if (removingKey === key) return;
    setRemovingKey(key);
    setRemovalError(null);
    setRemovalErrorRecorded(false);
    try {
      const result = await window.skills.removeSkill(
        pendingRemoval.sourceId,
        pendingRemoval.name,
      );
      if (result.success) {
        await onSkillsChanged();
        setPendingRemoval(null);
        onSkillGone?.({
          sourceId: pendingRemoval.sourceId,
          name: pendingRemoval.name,
        });
      } else {
        setRemovalError(result.error || 'Failed to remove skill.');
      }
    } catch (err) {
      setRemovalError(err instanceof Error ? err.message : String(err));
      setRemovalErrorRecorded(
        toAppError(resolveClientAppError(err))?.recordedBy !== undefined,
      );
    } finally {
      setRemovingKey(null);
    }
  };

  const pendingRemovalBusy =
    pendingRemoval !== null && removingKey === skillKey(pendingRemoval);

  const dialogs = (
    <>
      {shareGateModal}
      {sharingSkill && (
        <ShareSkillModal
          skill={sharingSkill}
          onClose={() => setSharingSkill(null)}
          onOpenAccountSettings={onOpenAccountSettings ?? ((): void => {})}
          onPublicLinkRemoved={onPublicLinkRemoved}
          onShared={(detail) => {
            // Sharing keeps the local skill; the list keeps showing it. The
            // dialog stays open on its success notice until Done.
            onShared?.(detail);
          }}
        />
      )}
      {pendingRemoval && (
        <DeleteConfirmModal
          title={
            pendingRemoval.custom
              ? `Delete skill "${pendingRemoval.name}"?`
              : `Remove skill "${pendingRemoval.name}"?`
          }
          message={
            pendingRemoval.custom
              ? `This skill will be permanently deleted from your local ${brandText.appName} data.`
              : 'This skill will be removed from your installed skills. You can reinstall it later.'
          }
          confirmLabel={pendingRemoval.custom ? 'Delete' : 'Remove'}
          pendingLabel={pendingRemoval.custom ? 'Deleting…' : 'Removing…'}
          pending={pendingRemovalBusy}
          {...(removalErrorRecorded
            ? {
                errorMessage: removalError,
                errorRecordingDisabled: true as const,
              }
            : {
                errorMessage: removalError,
                errorSource: 'installed-skill-remove',
              })}
          dataTestId="skill-delete-confirm-modal"
          confirmTestId="skill-delete-confirm"
          onCancel={() => {
            if (pendingRemovalBusy) return;
            setPendingRemoval(null);
            setRemovalError(null);
            setRemovalErrorRecorded(false);
          }}
          onConfirm={() => void confirmRemoval()}
        />
      )}
    </>
  );

  return {
    shareDialogOpen: sharingSkill !== null,
    canShare,
    requestShare: (skill): void => {
      const { sourceId, name, remote } = skill;
      requestShare(SHARE_SKILL_GATE_CONTEXT, () =>
        setSharingSkill({ sourceId, name, ...(remote ? { remote } : {}) }),
      );
    },
    canRemove,
    requestRemove: (skill): void => {
      setRemovalError(null);
      setRemovalErrorRecorded(false);
      setPendingRemoval({
        sourceId: skill.sourceId,
        name: skill.name,
        custom: skill.custom === true,
      });
    },
    isRemoving: (skill): boolean => removingKey === skillKey(skill),
    canUpdate: (skill): boolean => !skill.builtIn && !skill.custom,
    updateAvailable: (skill): boolean =>
      availability(skillKey(skill), skill.updateAvailable, changedAt(skill)),
    updatePending: updatingKey
      ? 'applying'
      : checking || backgroundChecking
        ? 'checking'
        : 'none',
    isUpdating: (skill): boolean =>
      updatingKey === skillKey(skill) || applyingElsewhere.has(skillKey(skill)),
    checkUpdates: (): void => void checkUpdates(),
    applyUpdate: (skill): void => void applyUpdate(skill),
    updateErrorFor: (skill): string | null => {
      if (!updateError) return null;
      if (!skill || updateError.key === null) return updateError.message;
      return updateError.key === skillKey(skill) ? updateError.message : null;
    },
    updateFailureFor: (skill): SkillUpdateError | undefined => {
      if (!updateError) return undefined;
      const { key, message } = updateError;
      if (key === null) {
        return {
          kind: 'check-failed',
          ...(message !== CHECK_FAILED ? { detail: message } : {}),
        };
      }
      if (key !== skillKey(skill) || message === SKILL_UPDATE_REFRESH_FAILED) {
        return undefined;
      }
      if (MISSING_FROM_SOURCE.test(message)) return { kind: 'missing-source' };
      return {
        kind: 'update-failed',
        ...(message !== UPDATE_FAILED ? { detail: message } : {}),
        ...(updateError.recorded ? { recorded: true as const } : {}),
      };
    },
    updateCheckedAt,
    clearUpdateError: (): void => setUpdateError(null),
    dialogs,
  };
}
