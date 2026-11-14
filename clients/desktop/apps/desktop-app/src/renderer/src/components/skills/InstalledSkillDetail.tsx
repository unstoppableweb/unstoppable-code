import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { SkillUpdateAction } from '@canopy/ui-shared/lib';
import { CustomSkillEditor, SkillDetailModal } from '../pages/SkillsTab';
import { notifySkillsChanged } from '@/lib/skillsChanged';
import { skillDetailEditWithAIState } from '@/lib/editSkillWithAI';
import { ErrorBanner } from '../shared';
import {
  SKILL_UPDATE_REFRESH_FAILED,
  useInstalledSkillActions,
} from './useInstalledSkillActions';
import { useEditSkillWithAI } from './useEditSkillWithAI';
import { useSkillUpdateAppliedRevision } from './skillUpdateStatus';
import { useInstalledShareProvenance } from './useInstalledShareProvenance';

export interface InstalledSkillDetailProps {
  skill: { sourceId: string; name: string; filePath?: string };
  /**
   * The installed record Share, Delete/Remove, and update eligibility is
   * read from, exactly as on the list row. The actions stay hidden until it
   * resolves.
   */
  installedSkill: InstalledSkillInfo | undefined;
  presentation: 'modal' | 'page';
  onClose: () => void;
  /** Where Back goes; also where the page goes once the skill is gone. */
  onNavigateBack?: () => void;
  /** The list's display name for the page header title. */
  displayName?: string;
  /** A rename saved from Edit; the host moves the detail to the new name. */
  onRenamed?: (name: string) => void;
  /**
   * Whether the custom skill's editor is open. Hosts that show the editor's
   * own breadcrumb level control it (CAN-3485); otherwise it is local state.
   */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSharedSkillsChanged?: () => Promise<void>;
  onOpenAccountSettings?: () => void;
  relatedContent?: ReactNode;
}

/**
 * Detail page for a locally installed skill (CAN-3483): the skill content plus
 * its list row's Edit, Share, Delete/Remove, and update (CAN-4264) actions.
 * Updates show the inventory's cached availability and check only on
 * request; an applied update refreshes the inventories and the content.
 *
 * Edit replaces the detail with the custom skill's edit page (CAN-3485): the
 * same page layout, Back/Cancel returning to the detail, and Save returning
 * to the refreshed detail. In the dialog presentation the editor opens as a
 * dialog over the detail instead.
 *
 * "Edit with AI" (CAN-1259) on the detail and its edit page opens a new
 * Cowork chat with the skill selected and an editable prompt. Skills the
 * skill-editing tools cannot change show it unavailable, with the reason.
 */
export function InstalledSkillDetail({
  skill,
  installedSkill,
  presentation,
  onClose,
  onNavigateBack,
  displayName,
  onRenamed,
  editing: controlledEditing,
  onEditingChange,
  onSharedSkillsChanged,
  onOpenAccountSettings,
  relatedContent,
}: InstalledSkillDetailProps): JSX.Element {
  const [localEditing, setLocalEditing] = useState(false);
  const editing =
    skill.sourceId === 'custom:app' && (controlledEditing ?? localEditing);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const setEditing = (next: boolean): void => {
    setLocalEditing(next);
    onEditingChange?.(next);
  };
  // Bumped after an in-place save so the viewer re-reads the edited content.
  const [contentVersion, setContentVersion] = useState(0);
  const [updatedSkillKey, setUpdatedSkillKey] = useState<string | null>(null);
  // A save can finish after the user has left this skill (Back, breadcrumb,
  // or Escape stay available while it runs); it must not navigate then.
  const mountedRef = useRef(true);
  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const leave = onNavigateBack ?? onClose;
  const displayedKey = `${skill.sourceId}/${skill.name}`;
  const actions = useInstalledSkillActions({
    updateContextKey: displayedKey,
    // Discovery and the Installed Skills list kept mounted behind this page
    // each refresh their own inventory; wait for both before leaving.
    onSkillsChanged: notifySkillsChanged,
    onUpdateInventoryRefresh: () =>
      notifySkillsChanged({ rejectOnFailure: true }),
    onSkillGone: leave,
    onShared: () => {
      // The local record gains its share link even when it is kept.
      void notifySkillsChanged();
      void onSharedSkillsChanged?.();
    },
    onPublicLinkRemoved: () => void onSharedSkillsChanged?.(),
    onOpenAccountSettings,
  });

  // Reload the shown skill after any successful update of it: one started
  // here, from the list behind this page, or before leaving and reopening
  // it. A reviewed replacement of a shared copy (CAN-5306) shows as its
  // receipt's hash advancing. Switching skills, a first receipt, or a
  // removed one is not an update, and signals landing together reload once.
  const appliedRevision = useSkillUpdateAppliedRevision(displayedKey);
  const receiptHash =
    installedSkill?.installedFromShare?.contentHash?.toLowerCase();
  const seenRevision = useRef({
    key: displayedKey,
    revision: appliedRevision,
    receiptHash,
  });
  useEffect(() => {
    const seen = seenRevision.current;
    const sameSkill = seen.key === displayedKey;
    seenRevision.current = {
      key: displayedKey,
      revision: appliedRevision,
      // A record briefly missing during an inventory refresh keeps the last
      // known receipt, so its return is compared with what was shown.
      receiptHash: receiptHash ?? (sameSkill ? seen.receiptHash : undefined),
    };
    if (!sameSkill) return;
    const revisionAdvanced = appliedRevision > seen.revision;
    const replaced =
      seen.receiptHash !== undefined &&
      receiptHash !== undefined &&
      receiptHash !== seen.receiptHash;
    if (!revisionAdvanced && !replaced) return;
    setUpdatedSkillKey(displayedKey);
    setContentVersion((version) => version + 1);
  }, [appliedRevision, displayedKey, receiptHash]);

  // An update error belongs to the skill it was raised on.
  const { clearUpdateError } = actions;
  useEffect(() => {
    clearUpdateError();
    // Only a change of skill clears it; the callback is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedKey]);

  // Update failures show in the update notice; a committed update whose
  // content could not be reloaded is the page's own failure.
  const updateFailure = actions.updateFailureFor(skill);
  const refreshError =
    actions.updateErrorFor(skill) === SKILL_UPDATE_REFRESH_FAILED
      ? SKILL_UPDATE_REFRESH_FAILED
      : null;
  const updateAction: SkillUpdateAction | undefined =
    installedSkill && actions.canUpdate(installedSkill)
      ? {
          status: 'ready',
          updateAvailable: actions.updateAvailable(installedSkill),
          // An update started from the list behind this page shows here too.
          pending: actions.isUpdating(installedSkill)
            ? 'applying'
            : actions.updatePending,
          ...(actions.updateCheckedAt !== null
            ? { checkedAt: actions.updateCheckedAt }
            : {}),
          ...(updateFailure ? { error: updateFailure } : {}),
          onCheck: actions.checkUpdates,
          onApply: (): void => actions.applyUpdate(installedSkill),
        }
      : undefined;

  const shareProvenance = useInstalledShareProvenance(
    editing ? undefined : installedSkill,
  );

  const editWithAI = useEditSkillWithAI();
  const startEditWithAI = (): void =>
    editWithAI.start({ sourceId: skill.sourceId, name: skill.name });
  const detailEditWithAI = skillDetailEditWithAIState(skill, installedSkill, {
    onSelect: startEditWithAI,
    pending: editWithAI.pending,
  });

  const editor = editing ? (
    <CustomSkillEditor
      editingName={skill.name}
      presentation={presentation}
      onClose={() => setEditing(false)}
      onCancel={() => setEditing(false)}
      editWithAI={{
        onSelect: startEditWithAI,
        pending: editWithAI.pending,
        error: editWithAI.error,
      }}
      onSaved={async (savedName, isEditorOpen) => {
        await notifySkillsChanged();
        if (!mountedRef.current) return;
        const renamed = savedName !== skill.name;
        // The user left this editor mid-save and has opened a newer one. A
        // late in-place save leaves that session alone; a rename still moves
        // to the renamed skill, since the newer editor targets a name that no
        // longer exists.
        if (!renamed && !isEditorOpen() && editingRef.current) return;
        setEditing(false);
        if (renamed && onRenamed) {
          // The host moves the detail to the renamed skill.
          onRenamed(savedName);
          return;
        }
        setContentVersion((version) => version + 1);
      }}
    />
  ) : null;

  if (editor && presentation === 'page') {
    return (
      <>
        {editor}
        {actions.dialogs}
      </>
    );
  }

  return (
    <>
      <SkillDetailModal
        {...(displayName ? { displayName } : {})}
        contentRevision={contentVersion}
        skill={skill}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        onEdit={
          skill.sourceId === 'custom:app'
            ? (): void => setEditing(true)
            : undefined
        }
        editWithAI={detailEditWithAI}
        notice={
          // Each failure keeps its own banner, so one cannot mask another;
          // either takes the place of the update notice.
          refreshError || editWithAI.error ? (
            <div className="flex flex-col gap-2">
              {refreshError && (
                <ErrorBanner
                  errorSource="installed-skill-detail-refresh"
                  error={refreshError}
                />
              )}
              {editWithAI.error && (
                <ErrorBanner
                  errorSource="installed-skill-detail-edit-with-ai"
                  error={editWithAI.error}
                />
              )}
            </div>
          ) : undefined
        }
        shareAction={
          installedSkill && actions.canShare(installedSkill)
            ? {
                status: 'shareable',
                onShare: (): void => actions.requestShare(installedSkill),
              }
            : undefined
        }
        onRemove={
          installedSkill && actions.canRemove(installedSkill)
            ? (): void => actions.requestRemove(installedSkill)
            : undefined
        }
        removeKind={installedSkill?.custom ? 'delete' : 'remove'}
        removePending={actions.isRemoving(skill)}
        updateAction={updateAction}
        installedSkill={installedSkill}
        shareProvenance={shareProvenance}
        loadErrorPrefix={
          updatedSkillKey === displayedKey
            ? SKILL_UPDATE_REFRESH_FAILED
            : undefined
        }
        relatedContent={relatedContent}
      />
      {editor}
      {actions.dialogs}
    </>
  );
}
