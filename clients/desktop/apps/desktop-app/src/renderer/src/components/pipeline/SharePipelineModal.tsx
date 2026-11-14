import { Stack } from '@canopy/ui-shared/components';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Notice } from '@canopy/ui-shared';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { pipelineSharePath } from '@canopy/protocol/pipelines';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type {
  Pipeline,
  PipelineInfo,
  PipelineShareSource,
  IPCResult,
  SharedPipelineDetail,
  SharedPipelineWriteRequest,
} from '@canopy/execution-engine/types/pipeline';
import {
  CapabilityPackageAnalysisError,
  ShareConflictError,
  ShareFailureError,
  classifyShareFailure,
  deriveExistingShare,
  existingShareLoadFailure,
  shareOwnerFields,
  type CapabilityPackageSharePort,
  type ShareDialogLink,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  projectPipelineRelativePath,
  serializePipelineDocument,
} from '@/lib/pipelineDocument';
import {
  createShareLinkResolver,
  resolveSharedPipelineUrl,
} from '@/lib/share-links';
import {
  missingRemoteShareCanBeRecreated,
  readSharedResourceErrorStatus,
} from '@/lib/sharedResourceErrors';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  pipelineShareRepairEligibility,
  shareRepairBinding,
} from '@/lib/fixShareDependenciesWithAI';

const PIPELINES_CRUD_CAPABILITY = 'pipelines-crud-v1';
const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const SNAPSHOT_NOTE_LABEL =
  'Sharing publishes a copy of this workflow under your account.';
const pipelineLinks = createShareLinkResolver(
  pipelineSharePath,
  resolveSharedPipelineUrl,
  'pipeline',
);

interface SharePipelineModalProps {
  pipeline: Pipeline;
  localPipelineInfo: PipelineInfo;
  onClose: () => void;
  onOpenAccountSettings: () => void;
  /** A share landed. Sharing always keeps the local pipeline. */
  onShared: (detail: SharedPipelineDetail) => void;
  /** The public link was removed; the Shared list should drop the row. */
  onPublicLinkRemoved?: () => void;
  worktree?: { projectId: string; worktreeId: string; repoId?: string };
}

/** Pipeline payload/package binding around the common share dialog. */
export function SharePipelineModal({
  pipeline,
  localPipelineInfo,
  onClose,
  onOpenAccountSettings,
  onShared,
  onPublicLinkRemoved,
  worktree: worktreeProp,
}: SharePipelineModalProps): JSX.Element {
  useCurrentUiStateReporter('sharing.pipelineDialog', {
    open: true,
    pipelineId: localPipelineInfo.id,
  });
  const [remoteDetail, setRemoteDetail] = useState<SharedPipelineDetail | null>(
    null,
  );
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  const pendingShared = useRef<{ detail: SharedPipelineDetail } | null>(null);
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const rawPipeline = useMemo(
    () => serializePipelineDocument(pipeline),
    [pipeline],
  );
  const worktree = useMemo(
    () =>
      worktreeProp
        ? {
            projectId: worktreeProp.projectId,
            worktreeId: worktreeProp.worktreeId,
            ...(worktreeProp.repoId ? { repoId: worktreeProp.repoId } : {}),
          }
        : undefined,
    [worktreeProp],
  );
  const sourcePipeline = useMemo<PipelineShareSource | undefined>(() => {
    if (!contextEnabled) return undefined;
    if (localPipelineInfo.source === 'project') {
      if (!worktree || !localPipelineInfo.filePath) return undefined;
      return {
        kind: 'project',
        ...worktree,
        pipelineFilePath: localPipelineInfo.filePath,
      };
    }
    return {
      kind: 'stored',
      id: localPipelineInfo.id,
      source:
        localPipelineInfo.source === 'bundled' ||
        localPipelineInfo.source === 'curated'
          ? localPipelineInfo.source
          : 'user',
    };
  }, [
    contextEnabled,
    localPipelineInfo.filePath,
    localPipelineInfo.id,
    localPipelineInfo.source,
    worktree,
  ]);
  const projectSourceUnavailable =
    contextEnabled && localPipelineInfo.source === 'project' && !sourcePipeline;

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      if (!localPipelineInfo.remote?.remoteId) {
        return { status: 'ready' } as const;
      }
      try {
        const result = await window.pipelines.getShared({
          remoteId: localPipelineInfo.remote.remoteId,
        });
        if (result.success && result.data) {
          assertCurrent?.();
          setRemoteDetail(result.data);
          const refreshedLink = await pipelineLinks.linkFromDetail(result.data);

          assertCurrent?.();

          setRemoteLink(refreshedLink);
          return { status: 'ready' } as const;
        }
        return readSharedResourceErrorStatus(result.error) === 404 &&
          (await missingRemoteShareCanBeRecreated(
            localPipelineInfo.remote.accountId,
          ))
          ? ({ status: 'ready' } as const)
          : existingShareLoadFailure('workflow', result.error);
      } catch (error: unknown) {
        return existingShareLoadFailure('workflow', error);
      }
    },
    [localPipelineInfo.remote?.accountId, localPipelineInfo.remote?.remoteId],
  );

  const packagePort = useMemo(
    (): CapabilityPackageSharePort => ({
      analyze: async ({
        dismissedInvocations,
        dismissedReferences,
      }): Promise<PipelinePackageAnalysisSummary> => {
        const result = await window.pipelines.analyzePackage({
          rawPipeline,
          pipelineId: localPipelineInfo.id,
          ...(sourcePipeline ? { sourcePipeline } : {}),
          ...(worktree ? { worktree } : {}),
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
          ...(dismissedReferences !== undefined
            ? { dismissedReferences: [...dismissedReferences] }
            : {}),
        });
        if (!result.success || !result.data) {
          // Main's reason is the only diagnostic the author sees; without it
          // the dialog shows just its generic failure.
          throw result.error
            ? new CapabilityPackageAnalysisError(result.error)
            : new Error('Could not analyze dependencies.');
        }
        return result.data;
      },
      // Even a pipeline without dependencies uses the packaged share path.
      hasContent: () => true,
      cancel: async (analysisId): Promise<void> => {
        await window.pipelines.cancelPackageAnalysis({ analysisId });
      },
    }),
    [localPipelineInfo.id, rawPipeline, sourcePipeline, worktree],
  );

  // Fix it with AI. A project pipeline needs its checkout-relative path, which
  // only the worktree's own root can give; until it resolves (or when it
  // cannot), the button stays hidden rather than guessing a location.
  const projectFilePath =
    localPipelineInfo.source === 'project'
      ? localPipelineInfo.filePath
      : undefined;
  const [projectRelativePath, setProjectRelativePath] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setProjectRelativePath(null);
    if (!worktree || !projectFilePath) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        window.api.getWorktreePath({
          projectId: worktree.projectId,
          worktreeId: worktree.worktreeId,
          ...(worktree.repoId ? { repoId: worktree.repoId } : {}),
        }),
      )
      .then(
        (cwd) => {
          if (cancelled || !cwd) return;
          setProjectRelativePath(
            projectPipelineRelativePath(cwd, projectFilePath),
          );
        },
        () => {},
      );
    return (): void => {
      cancelled = true;
    };
  }, [projectFilePath, worktree]);
  const repair = useMemo(
    () =>
      shareRepairBinding(
        pipelineShareRepairEligibility(
          localPipelineInfo,
          worktree
            ? { ...worktree, relativePath: projectRelativePath }
            : undefined,
        ),
        localPipelineInfo.name,
      ),
    [localPipelineInfo, projectRelativePath, worktree],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      if (projectSourceUnavailable) {
        throw new Error(
          'Reopen this workflow from its project to share it. Its worktree or file location is unavailable.',
        );
      }
      const selection = input.packageSelection;
      if (!selection)
        throw new Error('Analyze dependencies before sharing this workflow.');
      const revokePublicShare =
        input.scope !== 'public' &&
        !input.preservePublicLink &&
        remoteDetail?.publicShare
          ? {
              externalId: remoteDetail.publicShare.externalId,
              updatedAt: remoteDetail.publicShare.updatedAt,
            }
          : undefined;
      const request: SharedPipelineWriteRequest = {
        ...(localPipelineInfo.source === 'user'
          ? { sourcePipelineId: localPipelineInfo.id }
          : {}),
        ...(sourcePipeline ? { sourcePipeline } : {}),
        rawPipeline,
        ...shareOwnerFields(input, remoteDetail),
      };

      const runWrite = async (
        update: boolean,
      ): Promise<IPCResult<SharedPipelineDetail>> => {
        input.assertAllowed?.();
        return window.pipelines.createSharedPackaged({
          ...request,
          distributionMode: 'package',
          analysisId: selection.analysisId,
          selectedOptionalResourceIds: [
            ...selection.selectedOptionalResourceIds,
          ],
          ...(update && localPipelineInfo.remote
            ? {
                remoteId: localPipelineInfo.remote.remoteId,
                expectedContentHash:
                  remoteDetail?.contentHash ??
                  localPipelineInfo.remote.contentHash,
                ...(revokePublicShare ? { revokePublicShare } : {}),
              }
            : {}),
        });
      };

      let result: IPCResult<SharedPipelineDetail>;
      result = await runWrite(localPipelineInfo.remote !== undefined);
      if (!result.success && localPipelineInfo.remote) {
        const status =
          result.failure?.httpStatus ??
          readSharedResourceErrorStatus(result.error);
        if (status === 409) throw new ShareConflictError();
        if (
          status === 404 &&
          (await missingRemoteShareCanBeRecreated(
            localPipelineInfo.remote.accountId,
          ))
        )
          result = await runWrite(false);
      }
      if (!result.success || !result.data) {
        // Keep the structured cause so the dialog explains it and offers
        // the right recovery; older handlers send only the string.
        const failure = classifyShareFailure(result);
        if (failure) throw new ShareFailureError(failure);
        throw new Error(result.error ?? 'The workflow could not be shared.');
      }

      let detail = result.data;
      input.assertAllowed?.();
      let shareUrl: string | undefined;
      let publicLinkFailed = false;
      if (input.scope === 'public') {
        input.assertAllowed?.();
        const published = await window.pipelines.publishPublicShare(
          result.data.id,
        );
        if (published.success && published.data) {
          // Remove public link right on the success notice revokes this share.
          detail = { ...detail, publicShare: published.data };
          const link = await pipelineLinks.resolveLink({
            kind: 'public',
            id: result.data.id,
            sharePath: published.data.sharePath,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        } else {
          publicLinkFailed = true;
        }
      } else {
        if (input.scope === 'team' || input.scope === 'organization') {
          const link = await pipelineLinks.resolveLink({
            kind: 'scoped',
            id: result.data.id,
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
        ...(shareUrl ? { shareUrl } : {}),
        ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
      };
    },
    [
      localPipelineInfo,
      projectSourceUnavailable,
      rawPipeline,
      remoteDetail,
      sourcePipeline,
    ],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const pending = pendingShared.current;
      if (!pending) return { publicLinkFailed: true };
      const published = await window.pipelines.publishPublicShare(
        pending.detail.id,
      );
      if (!published.success || !published.data) {
        return { publicLinkFailed: true };
      }
      const link = await pipelineLinks.resolveLink({
        kind: 'public',
        id: pending.detail.id,
        sharePath: published.data.sharePath,
      });
      assertCurrent?.();
      setRemoteLink(link);
      assertCurrent?.();
      pending.detail = { ...pending.detail, publicShare: published.data };
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
      localPipelineInfo.source === 'user' ? null : (
        <Stack gap="item">
          <p
            className="text-s fg-secondary"
            data-testid="share-pipeline-snapshot-note"
          >
            {SNAPSHOT_NOTE_LABEL}
          </p>
          {projectSourceUnavailable && (
            <Notice
              errorSource="workflow-share-missing-location"
              displayErrorCode="external.state_changed"
              intent="destructive"
            >
              Reopen this workflow from its project to share it. Its worktree or
              file location is unavailable.
            </Notice>
          )}
        </Stack>
      ),
    [localPipelineInfo.source, projectSourceUnavailable],
  );

  const existingShare = remoteDetail
    ? deriveExistingShare({ ...remoteDetail, link: remoteLink })
    : localPipelineInfo.remote &&
        localPipelineInfo.remote.shareScope !== 'private'
      ? { audience: localPipelineInfo.remote.shareScope }
      : undefined;

  const revokePublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      const result = await window.pipelines.revokePublicShare(remoteDetail.id);
      if (!result.success) {
        throw new Error(result.error ?? 'Could not remove the public link.');
      }
      assertCurrent?.();
      setRemoteDetail({ ...remoteDetail, publicShare: null });
      assertCurrent?.();
      onPublicLinkRemoved?.();
    },
    [onPublicLinkRemoved, remoteDetail],
  );

  return (
    <DesktopShareResourceDialog
      marketplace={{
        kind: 'pipeline',
        resourceKey: JSON.stringify([
          localPipelineInfo.id,
          localPipelineInfo.filePath,
        ]),
      }}
      resourceNoun="workflow"
      testIdPrefix="share-pipeline"
      requiredCapability={PIPELINES_CRUD_CAPABILITY}
      scopes={SHARE_SCOPES}
      subtitle={localPipelineInfo.name}
      landing="marketplace"
      notes={notes}
      shareDisabled={projectSourceUnavailable}
      capabilityPackage={{
        port: packagePort,
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
    />
  );
}
