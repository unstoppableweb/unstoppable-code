import { type JSX, useCallback, useMemo, useRef, useState } from 'react';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import {
  skillShareCreateAudience,
  skillShareCreateRefusal,
  skillShareUpdateAudience,
} from './skill-share-audience';
import {
  ShareConflictError,
  deriveExistingShare,
  existingShareLoadFailure,
  resourceContextRefusalMessage,
  shareOwnerFields,
  type CapabilityPackageSharePort,
  type ShareResourceExistingShare,
  type ShareDialogLink,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import { skillSharePath } from '@canopy/protocol/skills';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import {
  createShareLinkResolver,
  resolveSharedSkillUrl,
} from '@/lib/share-links';
import { skillPackageHasContent } from '@/lib/skillPackageContent';
import {
  missingRemoteShareCanBeRecreated,
  readSharedResourceErrorStatus,
} from '@/lib/sharedResourceErrors';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  shareRepairBinding,
  skillShareRepairEligibility,
} from '@/lib/fixShareDependenciesWithAI';

// ---------------------------------------------------------------------------
// Visible copy. Keep resource-specific strings as constants so the test suite
// can reference the same source of truth.
// ---------------------------------------------------------------------------

const SNAPSHOT_NOTE_LABEL =
  'Sharing publishes a copy of this skill under your account.';
const PACKAGE_PREPARE_FAILURE_LABEL =
  'The supporting files could not be prepared for sharing.';
const SKILL_CHANGED_LABEL =
  'This skill changed while the dialog was open. Close and reopen it to recheck what will be shared.';
const SKILL_READ_FAILURE_LABEL = "Couldn't read this skill.";

const SKILLS_CRUD_CAPABILITY = 'skills-crud-v1';

const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const skillLinks = createShareLinkResolver(
  skillSharePath,
  resolveSharedSkillUrl,
  'skill',
);

interface ShareSkillModalProps {
  /**
   * The local skill being shared. Built-in skills are shared as snapshots;
   * plugin-owned and external skills remain excluded from this flow.
   */
  skill: Pick<InstalledSkillInfo, 'sourceId' | 'name' | 'remote'>;
  onClose: () => void;
  onOpenAccountSettings: () => void;
  /**
   * Called when the user dismisses a successful share with the
   * freshly-returned `SharedSkillDetail`. Sharing always keeps the local skill.
   */
  onShared: (detail: SharedSkillDetail) => void;
  /** The public link was removed; the Shared list should drop the row. */
  onPublicLinkRemoved?: () => void;
  /** Document the dialog opens in; a popped-out chat passes its own. */
  ownerDocument?: Document;
}

/**
 * Skill-specific wrapper over the desktop share dialog. The scope selector,
 * pickers, account gating, dependency review and result states are shared;
 * what makes a *skill* share a skill share is the raw-bytes upload and the
 * snapshot note. Sharing never removes the local skill.
 */
export function ShareSkillModal({
  skill,
  onClose,
  onOpenAccountSettings,
  onShared,
  onPublicLinkRemoved,
  ownerDocument,
}: ShareSkillModalProps): JSX.Element {
  useCurrentUiStateReporter('sharing.skillDialog', {
    open: true,
    sourceId: skill.sourceId,
    skillName: skill.name,
  });
  const [remoteDetail, setRemoteDetail] = useState<SharedSkillDetail | null>(
    null,
  );
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  // The SKILL.md bytes the last analysis scanned. The share re-reads and
  // refuses to ship a package reviewed against different bytes.
  const analyzedRawSkill = useRef<string | null>(null);
  const pendingShared = useRef<{ detail: SharedSkillDetail } | null>(null);
  const isCustomSource = skill.sourceId === 'custom:app';
  const skillPath = `${skill.sourceId}/${skill.name}`;

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      if (!skill.remote?.remoteId) return { status: 'ready' } as const;
      try {
        const detail = await window.skills.getShared(skill.remote.remoteId);
        assertCurrent?.();
        setRemoteDetail(detail);
        const refreshedLink = await skillLinks.linkFromDetail(detail);

        assertCurrent?.();

        setRemoteLink(refreshedLink);
        return { status: 'ready' } as const;
      } catch (error: unknown) {
        return readSharedResourceErrorStatus(error) === 404 &&
          (await missingRemoteShareCanBeRecreated(skill.remote?.accountId))
          ? ({ status: 'ready' } as const)
          : existingShareLoadFailure('skill', error);
      }
    },
    [skill.remote?.accountId, skill.remote?.remoteId],
  );

  const existingShare = useMemo(
    (): ShareResourceExistingShare | undefined =>
      remoteDetail
        ? deriveExistingShare({ ...remoteDetail, link: remoteLink })
        : undefined,
    [remoteDetail, remoteLink],
  );

  const revokePublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      await window.skills.revokePublicShare(remoteDetail.id);
      assertCurrent?.();
      setRemoteDetail({ ...remoteDetail, publicShare: null });
      assertCurrent?.();
      onPublicLinkRemoved?.();
    },
    [onPublicLinkRemoved, remoteDetail],
  );

  // What actually travels with this skill: its own folder, anything its
  // instructions invoke, and the MCP/plugin names they reference. The read is
  // part of the analysis so Retry re-runs both.
  const packagePort = useMemo(
    (): CapabilityPackageSharePort => ({
      analyze: async ({
        dismissedInvocations,
      }): Promise<PipelinePackageAnalysisSummary> => {
        let rawSkill: string;
        try {
          rawSkill = await window.skills.readRawSkill(skillPath);
        } catch {
          throw new Error(SKILL_READ_FAILURE_LABEL);
        }
        analyzedRawSkill.current = rawSkill;
        const analysis = await window.skills.analyzeCapabilityPackage({
          sourceId: skill.sourceId,
          skillName: skill.name,
          rawSkill,
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
        });
        // Main binds the subject Skill into every manifest so package commits
        // remain content-addressed. When those bare SKILL.md entries are the
        // whole manifest, they are the definition being shared rather than a
        // dependency. Preserve the analysis identity/hash, but present the
        // common review with the truthful empty dependency set.
        if (!skillPackageHasContent(analysis.manifest) && analysis.manifest) {
          return {
            ...analysis,
            manifest: {
              ...analysis.manifest,
              resources: [],
              bindings: [],
              totalFiles: 0,
              totalBytes: 0,
            },
          };
        }
        return analysis;
      },
      cancel: (analysisId) =>
        window.skills.cancelCapabilityPackageAnalysis(analysisId),
      // The analysis always binds the skill itself, so a manifest holding
      // only its SKILL.md carries nothing the share does not already send.
      hasContent: skillPackageHasContent,
    }),
    [skill.name, skill.sourceId, skillPath],
  );

  // Fix it with AI: custom skills only, since only they are editable here.
  const repair = useMemo(
    () =>
      shareRepairBinding(
        skillShareRepairEligibility({
          sourceId: skill.sourceId,
          name: skill.name,
        }),
        skill.name,
      ),
    [skill.name, skill.sourceId],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      // Build the share payload from the exact SKILL.md bytes: the server
      // hashes the raw bytes and the SHA-256 must round-trip identically.
      const outgoingRawSkill = await window.skills.readRawSkill(skillPath);
      const selection = input.packageSelection ?? null;
      if (selection !== null && outgoingRawSkill !== analyzedRawSkill.current) {
        // The bytes moved under the dialog, so the reviewed analysis no longer
        // describes what is about to be shared.
        throw new Error(SKILL_CHANGED_LABEL);
      }
      let capabilityPackage: PipelinePackageRef | undefined;
      let committedPackageUploadId: string | undefined;
      if (selection !== null) {
        try {
          const committed = unwrapShareOperationResult(
            await window.skills.commitCapabilityPackage({
              analysisId: selection.analysisId,
              selectedOptionalResourceIds: [
                ...selection.selectedOptionalResourceIds,
              ],
            }),
          );
          capabilityPackage = committed.capabilityPackage;
          committedPackageUploadId = committed.committedPackageUploadId;
        } catch (error) {
          // The publisher believes their supporting files travelled, so a
          // failed upload stops the share rather than silently degrading it.
          throw new Error(
            resourceContextRefusalMessage(error) ??
              (error instanceof Error && error.message
                ? `${PACKAGE_PREPARE_FAILURE_LABEL} ${error.message}`
                : PACKAGE_PREPARE_FAILURE_LABEL),
          );
        }
      }
      const ownerFields = shareOwnerFields(input, remoteDetail);
      const packageFields = {
        ...(capabilityPackage ? { capabilityPackage } : {}),
        ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
      };
      // A new share; with "Only me" it may not reuse an identical skill the
      // account already shares more widely (CAN-7037).
      const createShared = async (): Promise<SharedSkillDetail> => {
        try {
          return unwrapShareOperationResult(
            await window.skills.createShared({
              sourceSkillId: skillPath,
              rawSkill: outgoingRawSkill,
              ...ownerFields,
              ...packageFields,
              ...skillShareCreateAudience(input.scope),
            }),
          );
        } catch (error) {
          const refusal = skillShareCreateRefusal(error);
          throw refusal === null ? error : new Error(refusal);
        }
      };
      const revokePublicShare =
        input.scope !== 'public' &&
        !input.preservePublicLink &&
        remoteDetail?.publicShare
          ? {
              externalId: remoteDetail.publicShare.externalId,
              updatedAt: remoteDetail.publicShare.updatedAt,
            }
          : undefined;
      let detail: SharedSkillDetail;
      if (skill.remote) {
        try {
          input.assertAllowed?.();
          detail = unwrapShareOperationResult(
            await window.skills.updateShared({
              sourceSkillId: skillPath,
              skillId: skill.remote.remoteId,
              rawSkill: outgoingRawSkill,
              expectedContentHash:
                remoteDetail?.contentHash ?? skill.remote.contentHash,
              ...(revokePublicShare ? { revokePublicShare } : {}),
              ...ownerFields,
              ...packageFields,
              // "Only me" refuses a link published since the dialog loaded.
              ...skillShareUpdateAudience(input.scope, remoteDetail),
            }),
          );
        } catch (error: unknown) {
          const status = readSharedResourceErrorStatus(error);
          if (status === 409) throw new ShareConflictError();
          if (
            status !== 404 ||
            !(await missingRemoteShareCanBeRecreated(skill.remote.accountId))
          )
            throw error;
          input.assertAllowed?.();
          detail = await createShared();
        }
      } else {
        input.assertAllowed?.();
        detail = await createShared();
      }

      let publicLinkFailed = false;
      input.assertAllowed?.();
      let shareUrl: string | undefined;
      if (input.scope === 'public') {
        input.assertAllowed?.();
        try {
          const publicShare = await window.skills.publishPublicShare(detail.id);
          // Remove public link right on the success notice revokes this share.
          detail = { ...detail, publicShare };
          // Fall back to the server-minted relative path when the cloud base
          // URL is not configured so the link is still visible and copyable.
          const link = await skillLinks.resolveLink({
            kind: 'public',
            id: detail.id,
            sharePath: publicShare.sharePath,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        } catch {
          publicLinkFailed = true;
        }
      } else {
        if (revokePublicShare) detail = { ...detail, publicShare: null };
        if (input.scope === 'team' || input.scope === 'organization') {
          const link = await skillLinks.resolveLink({
            kind: 'scoped',
            id: detail.id,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        }
      }

      input.assertAllowed?.();

      pendingShared.current = { detail };
      input.assertAllowed?.();
      setRemoteDetail(detail);
      return {
        ...(shareUrl !== undefined ? { shareUrl } : {}),
        ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
      };
    },
    [remoteDetail, skill, skillPath],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const pending = pendingShared.current;
      if (!pending) return { publicLinkFailed: true };
      const publicShare = await window.skills.publishPublicShare(
        pending.detail.id,
      );
      const link = await skillLinks.resolveLink({
        kind: 'public',
        id: pending.detail.id,
        sharePath: publicShare.sharePath,
      });
      assertCurrent?.();
      setRemoteLink(link);
      assertCurrent?.();
      pending.detail = { ...pending.detail, publicShare };
      assertCurrent?.();
      setRemoteDetail(pending.detail);
      return { shareUrl: link.url };
    },
    [],
  );

  const handleCompleted = useCallback((): void => {
    const pending = pendingShared.current;
    if (!pending) return;
    onShared(pending.detail);
    pendingShared.current = null;
  }, [onShared]);

  const notes = useMemo(
    (): JSX.Element | null =>
      isCustomSource ? null : (
        <p
          className="text-s fg-secondary"
          data-testid="share-skill-snapshot-note"
        >
          {SNAPSHOT_NOTE_LABEL}
        </p>
      ),
    [isCustomSource],
  );

  return (
    <DesktopShareResourceDialog
      marketplace={{ kind: 'skill', resourceKey: skillPath }}
      resourceNoun="skill"
      testIdPrefix="share-skill"
      requiredCapability={SKILLS_CRUD_CAPABILITY}
      scopes={SHARE_SCOPES}
      subtitle={skill.name}
      landing="marketplace"
      notes={notes}
      capabilityPackage={{
        port: packagePort,
        // A skill has no steps, so a resource has no location to name.
        bindingLabelFor: (): null => null,
        ...(repair ? { repair } : {}),
      }}
      preflight={loadExistingShare}
      {...(existingShare ? { existingShare } : {})}
      keepsOrganizationOwnership
      share={share}
      retryPublicLink={retryPublicLink}
      {...(canManagePublicLink(remoteDetail) ? { revokePublicLink } : {})}
      onClose={onClose}
      onOpenAccountSettings={onOpenAccountSettings}
      onCompleted={handleCompleted}
      {...(ownerDocument ? { ownerDocument } : {})}
    />
  );
}
