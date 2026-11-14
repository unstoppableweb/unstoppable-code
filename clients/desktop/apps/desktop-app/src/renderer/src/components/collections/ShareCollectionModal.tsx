import { type JSX, useCallback, useMemo, useRef, useState } from 'react';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type {
  CollectionConfig,
  SharedCollectionDetail,
} from '@canopy/desktop-shared/types/collections';
import {
  ShareConflictError,
  deriveExistingShare,
  existingShareLoadFailure,
  shareOwnerFields,
  type CapabilityPackageSharePort,
  type ShareResourceOutcome,
  type ShareResourcePreflightResult,
  type ShareDialogLink,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import {
  buildSharedCollectionPayload,
  convertLocalCollectionToEditable,
  type EditableSharedCollection,
} from '@/lib/sharedCollections';
import {
  missingRemoteShareCanBeRecreated,
  readSharedResourceErrorStatus,
} from '@/lib/sharedResourceErrors';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  createShareLinkResolver,
  resolveSharedSkillUrl,
} from '@/lib/share-links';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import { ErrorBanner } from '@canopy/ui-shared/components';

const COLLECTIONS_CRUD_CAPABILITY = 'collections-crud-v1';
const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const collectionLinks = createShareLinkResolver(
  (id) => `/portal/plugins/collections/shared/${encodeURIComponent(id)}`,
  resolveSharedSkillUrl,
  'collection',
);

interface ShareCollectionModalProps {
  collection: CollectionConfig;
  onClose: () => void;
  onOpenAccountSettings: () => void;
  /** A share landed. Sharing always keeps the local collection. */
  onShared: (detail: SharedCollectionDetail) => void;
}

type PreparedPayload = Awaited<ReturnType<typeof buildSharedCollectionPayload>>;

/** Collection payload/package binding around the common share dialog. */
export function ShareCollectionModal({
  collection,
  onClose,
  onOpenAccountSettings,
  onShared,
}: ShareCollectionModalProps): JSX.Element {
  useCurrentUiStateReporter('sharing.collectionDialog', {
    open: true,
    collectionId: collection.id,
  });
  const [remoteDetail, setRemoteDetail] =
    useState<SharedCollectionDetail | null>(null);
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  const [reconciliationRevision, setReconciliationRevision] = useState(0);
  const preparedPayload = useRef<PreparedPayload | null>(null);
  const pendingShared = useRef<{ detail: SharedCollectionDetail } | null>(null);

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      void reconciliationRevision;
      if (collection.mcpServers.length > 0) {
        return {
          status: 'blocked',
          body: (
            <ErrorBanner
              errorSource="share-collection-modal"
              className=""
              error="Collections containing MCP servers cannot be shared."
            />
          ),
        } satisfies ShareResourcePreflightResult;
      }
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      if (!collection.remote?.remoteId) return { status: 'ready' } as const;
      try {
        const detail = await window.collections.getShared(
          collection.remote.remoteId,
        );
        assertCurrent?.();
        setRemoteDetail(detail);
        const refreshedLink = await collectionLinks.linkFromDetail(detail);

        assertCurrent?.();

        setRemoteLink(refreshedLink);
        return { status: 'ready' } as const;
      } catch (error: unknown) {
        if (
          readSharedResourceErrorStatus(error) === 404 &&
          (await missingRemoteShareCanBeRecreated(collection.remote.accountId))
        ) {
          return { status: 'ready' } as const;
        }
        return existingShareLoadFailure('collection', error);
      }
    },
    [
      reconciliationRevision,
      collection.mcpServers.length,
      collection.remote?.accountId,
      collection.remote?.remoteId,
    ],
  );

  const packagePort = useMemo(
    (): CapabilityPackageSharePort => ({
      analyze: async ({
        dismissedInvocations,
      }): Promise<PipelinePackageAnalysisSummary> => {
        const [skillsResult, marketplacesResult] = await Promise.all([
          window.skills.loadSkills(),
          window.plugins.loadMarketplaces(),
        ]);
        const installedSkills =
          skillsResult.success && skillsResult.data ? skillsResult.data : [];
        const marketplaces =
          marketplacesResult.success && marketplacesResult.data
            ? marketplacesResult.data.marketplaces.map((marketplace) => ({
                id: marketplace.id,
                sourceUrl: marketplace.sourceUrl,
              }))
            : [];
        const { editable }: { editable: EditableSharedCollection } =
          convertLocalCollectionToEditable({
            config: collection,
            installedSkills,
            marketplaces,
          });
        const payload = await buildSharedCollectionPayload({
          name: editable.name,
          description: editable.description,
          items: editable.items,
          customSkillReader: (localSkillId) =>
            window.skills.readRawSkill(localSkillId),
        });
        preparedPayload.current = payload;
        return window.collections.analyzeCapabilityPackage({
          collectionId: collection.id,
          rawCollection: payload.rawCollection,
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
        });
      },
      cancel: (analysisId) =>
        window.collections.cancelCapabilityPackageAnalysis(analysisId),
    }),
    [collection],
  );

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      let revocationStarted = false;
      try {
        if (collection.mcpServers.length > 0)
          throw new Error(
            'Collections containing MCP servers cannot be shared.',
          );
        const payload = preparedPayload.current;
        if (!payload) {
          throw new Error('The collection is still being prepared. Try again.');
        }
        const selection = input.packageSelection;
        let capabilityPackage: PipelinePackageRef | undefined;
        let committedPackageUploadId: string | undefined;
        if (selection) {
          const committed = unwrapShareOperationResult(
            await window.collections.commitCapabilityPackage({
              analysisId: selection.analysisId,
              selectedOptionalResourceIds: [
                ...selection.selectedOptionalResourceIds,
              ],
            }),
          );
          capabilityPackage = committed.capabilityPackage;
          committedPackageUploadId = committed.committedPackageUploadId;
        }
        const ownerFields = shareOwnerFields(input, remoteDetail);
        const request = {
          sourceCollectionId: collection.id,
          rawCollection: payload.rawCollection,
          ...(payload.customSkills.length > 0
            ? { customSkills: payload.customSkills }
            : {}),
          ...ownerFields,
          ...(selection === null
            ? { capabilityPackage: null }
            : capabilityPackage
              ? { capabilityPackage }
              : {}),
          ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
        };

        if (
          input.scope !== 'public' &&
          !input.preservePublicLink &&
          remoteDetail?.publicShare
        ) {
          input.assertAllowed?.();
          revocationStarted = true;
          await window.collections.revokePublicShare(remoteDetail.id);
          const remaining = { ...remoteDetail, publicShare: null };
          input.assertAllowed?.();
          setRemoteDetail(remaining);
          const refreshedLink = await collectionLinks.linkFromDetail(remaining);

          input.assertAllowed?.();

          setRemoteLink(refreshedLink);
        }
        let detail: SharedCollectionDetail;
        if (collection.remote) {
          try {
            input.assertAllowed?.();
            detail = unwrapShareOperationResult(
              await window.collections.updateShared({
                collectionId: collection.remote.remoteId,
                expectedContentHash:
                  remoteDetail?.contentHash ?? collection.remote.contentHash,
                ...request,
              }),
            );
          } catch (error: unknown) {
            const status = readSharedResourceErrorStatus(error);
            if (status === 409) throw new ShareConflictError();
            if (
              status !== 404 ||
              !(await missingRemoteShareCanBeRecreated(
                collection.remote.accountId,
              ))
            )
              throw error;
            input.assertAllowed?.();
            detail = unwrapShareOperationResult(
              await window.collections.createShared(request),
            );
          }
        } else {
          input.assertAllowed?.();
          detail = unwrapShareOperationResult(
            await window.collections.createShared(request),
          );
        }

        input.assertAllowed?.();
        let shareUrl: string | undefined;
        let publicLinkFailed = false;
        if (input.scope === 'public') {
          input.assertAllowed?.();
          try {
            const publicShare = await window.collections.publishPublicShare(
              detail.id,
            );
            detail = { ...detail, publicShare };
            const link = await collectionLinks.resolveLink({
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
          if (!input.preservePublicLink && remoteDetail?.publicShare) {
            detail = { ...detail, publicShare: null };
          }
          const link = await collectionLinks.resolveLink({
            kind: 'scoped',
            id: detail.id,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        }

        input.assertAllowed?.();

        pendingShared.current = { detail };
        input.assertAllowed?.();
        setRemoteDetail(detail);
        return {
          ...(shareUrl ? { shareUrl } : {}),
          ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
        };
      } catch (error: unknown) {
        input.assertAllowed?.();
        if (revocationStarted)
          setReconciliationRevision((revision) => revision + 1);
        throw error;
      }
    },
    [collection, remoteDetail],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const pending = pendingShared.current;
      if (!pending) return { publicLinkFailed: true };
      const publicShare = await window.collections.publishPublicShare(
        pending.detail.id,
      );
      const link = await collectionLinks.resolveLink({
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

  const revokePublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      try {
        await window.collections.revokePublicShare(remoteDetail.id);
        const remaining = { ...remoteDetail, publicShare: null };
        assertCurrent?.();
        setRemoteDetail(remaining);
        const refreshedLink = await collectionLinks.linkFromDetail(remaining);

        assertCurrent?.();

        setRemoteLink(refreshedLink);
      } catch (error: unknown) {
        assertCurrent?.();
        setReconciliationRevision((revision) => revision + 1);
        throw error;
      }
    },
    [remoteDetail],
  );

  const handleCompleted = useCallback((): void => {
    const pending = pendingShared.current;
    if (!pending) return;
    onShared(pending.detail);
    pendingShared.current = null;
  }, [onShared]);

  const existingShare = remoteDetail
    ? deriveExistingShare({
        ...remoteDetail,
        link: remoteLink,
      })
    : undefined;

  return (
    <DesktopShareResourceDialog
      marketplace={{ kind: 'collection', resourceKey: collection.id }}
      resourceNoun="collection"
      testIdPrefix="share-collection"
      requiredCapability={COLLECTIONS_CRUD_CAPABILITY}
      scopes={SHARE_SCOPES}
      subtitle={collection.name}
      landing="marketplace"
      capabilityPackage={{ port: packagePort }}
      {...(existingShare ? { existingShare } : {})}
      keepsOrganizationOwnership
      preflight={loadExistingShare}
      share={share}
      retryPublicLink={retryPublicLink}
      {...(canManagePublicLink(remoteDetail) ? { revokePublicLink } : {})}
      onClose={onClose}
      onOpenAccountSettings={onOpenAccountSettings}
      onCompleted={handleCompleted}
    />
  );
}
