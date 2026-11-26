import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import { agentSharePath } from '@canopy/protocol/agents';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type {
  AgentModelDefinition,
  SharedAgentDetail,
  SharedAgentDocument,
} from '@canopy/execution-engine/types/agent-models';
import {
  ShareConflictError,
  deriveExistingShare,
  existingShareLoadFailure,
  shareOwnerFields,
  type CapabilityPackageSharePort,
  type ShareDialogLink,
  type ShareResourceDialogState,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import { useUnifiedTableData } from '@/hooks/useUnifiedTableData';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { deriveShareablePluginsLenient } from '@/lib/agentSharing';
import {
  AGENT_PUBLIC_SHARE_CHANGED_EVENT,
  createShareLinkResolver,
  resolveSharedAgentUrl,
} from '@/lib/share-links';
import {
  missingRemoteShareCanBeRecreated,
  readSharedResourceErrorStatus,
} from '@/lib/sharedResourceErrors';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';

const AGENTS_CRUD_CAPABILITY = 'agents-crud-v1';
const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const agentLinks = createShareLinkResolver(
  agentSharePath,
  resolveSharedAgentUrl,
  'agent',
);

interface ShareAgentModalProps {
  agent: AgentModelDefinition;
  onClose: () => void;
  onOpenAccountSettings: () => void;
  onShared: (detail: SharedAgentDetail) => void;
  /** The public link was removed; the Shared list should drop the row. */
  onPublicLinkRemoved?: () => void;
}

/** Agent-specific payload and package binding around the common share dialog. */
export function ShareAgentModal({
  agent,
  onClose,
  onOpenAccountSettings,
  onShared,
  onPublicLinkRemoved,
}: ShareAgentModalProps): JSX.Element {
  const [remoteDetail, setRemoteDetail] = useState<SharedAgentDetail | null>(
    null,
  );
  const [remoteLoadRevision, setRemoteLoadRevision] = useState(0);
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  const [dialogState, setDialogState] = useState<ShareResourceDialogState>({
    audience: null,
    available: false,
    busy: false,
    status: 'idle',
    copied: false,
  });
  const pendingShared = useRef<SharedAgentDetail | null>(null);
  const { rows, loading: catalogLoading } = useUnifiedTableData({
    includeCollections: false,
    includeMcp: false,
  });
  const shareablePlugins = useMemo(
    () =>
      deriveShareablePluginsLenient(agent.pluginSelections, rows, {
        packageLocalCapabilities: true,
      }),
    [agent.pluginSelections, rows],
  );

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      void remoteLoadRevision;
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      if (!agent.remoteId) return { status: 'ready' } as const;
      try {
        const detail = await window.agents.getShared(agent.remoteId);
        assertCurrent?.();
        setRemoteDetail(detail);
        const refreshedLink = await agentLinks.linkFromDetail(detail);

        assertCurrent?.();

        setRemoteLink(refreshedLink);
        return { status: 'ready' } as const;
      } catch (error: unknown) {
        if (readSharedResourceErrorStatus(error) === 404) {
          return (await missingRemoteShareCanBeRecreated(agent.remoteAccountId))
            ? ({ status: 'ready' } as const)
            : existingShareLoadFailure('agent');
        }
        return existingShareLoadFailure('agent');
      }
    },
    [agent.remoteAccountId, agent.remoteId, remoteLoadRevision],
  );

  useEffect(() => {
    const reload = (): void => {
      setRemoteLoadRevision((revision) => revision + 1);
    };
    window.addEventListener(AGENT_PUBLIC_SHARE_CHANGED_EVENT, reload);
    // Main announces a public link it published or revoked (CAN-6003).
    const unsubscribe = window.agents.onChanged(reload);
    return (): void => {
      window.removeEventListener(AGENT_PUBLIC_SHARE_CHANGED_EVENT, reload);
      unsubscribe();
    };
  }, []);

  const packagePort = useMemo((): CapabilityPackageSharePort | null => {
    if (catalogLoading) return null;
    return {
      analyze: ({ dismissedInvocations }) =>
        window.agents.analyzeCapabilityPackage({
          agentModelId: agent.id,
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
        }),
      cancel: (analysisId) =>
        window.agents.cancelCapabilityPackageAnalysis(analysisId),
    };
  }, [agent.id, catalogLoading]);

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      const document: SharedAgentDocument = {
        version: 1,
        id: agent.id,
        name: agent.name,
        baseModel: agent.baseModel,
        instructions: agent.instructions,
        plugins: shareablePlugins.plugins,
      };
      const selection = input.packageSelection;
      let capabilityPackage: PipelinePackageRef | undefined;
      let committedPackageUploadId: string | undefined;
      if (selection) {
        const committed = unwrapShareOperationResult(
          await window.agents.commitCapabilityPackage({
            analysisId: selection.analysisId,
            selectedOptionalResourceIds: [
              ...selection.selectedOptionalResourceIds,
            ],
          }),
        );
        capabilityPackage = committed.capabilityPackage;
        committedPackageUploadId = committed.committedPackageUploadId;
      }

      const owner = shareOwnerFields(input, remoteDetail);
      const packageFields =
        selection === null
          ? { capabilityPackage: null }
          : {
              ...(capabilityPackage ? { capabilityPackage } : {}),
              ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
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

      input.assertAllowed?.();
      let detail: SharedAgentDetail;
      if (agent.remoteId) {
        try {
          detail = unwrapShareOperationResult(
            await window.agents.updateShared({
              agentId: agent.remoteId,
              agent: document,
              ...((remoteDetail?.contentHash ?? agent.remoteContentHash)
                ? {
                    expectedContentHash:
                      remoteDetail?.contentHash ?? agent.remoteContentHash,
                  }
                : {}),
              ...(revokePublicShare ? { revokePublicShare } : {}),
              ...owner,
              ...packageFields,
            }),
          );
        } catch (error: unknown) {
          const status = readSharedResourceErrorStatus(error);
          if (status === 409) throw new ShareConflictError();
          if (
            status !== 404 ||
            !(await missingRemoteShareCanBeRecreated(agent.remoteAccountId))
          )
            throw error;
          input.assertAllowed?.();
          detail = unwrapShareOperationResult(
            await window.agents.createShared({
              agent: document,
              ...owner,
              ...packageFields,
            }),
          );
        }
      } else {
        detail = unwrapShareOperationResult(
          await window.agents.createShared({
            agent: document,
            ...owner,
            ...packageFields,
          }),
        );
      }

      input.assertAllowed?.();
      let shareUrl: string | undefined;
      let publicLinkFailed = false;
      if (input.scope === 'public') {
        try {
          const publicShare = await window.agents.publishPublicShare(detail.id);
          detail = { ...detail, publicShare };
          const link = await agentLinks.resolveLink({
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
        if (revokePublicShare) {
          detail = { ...detail, publicShare: null };
        }
        if (input.scope === 'team' || input.scope === 'organization') {
          const link = await agentLinks.resolveLink({
            kind: 'scoped',
            id: detail.id,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        }
      }

      input.assertAllowed?.();

      pendingShared.current = detail;
      input.assertAllowed?.();
      setRemoteDetail(detail);
      return {
        ...(shareUrl ? { shareUrl } : {}),
        ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
      };
    },
    [agent, remoteDetail, shareablePlugins.plugins],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const detail = pendingShared.current;
      if (!detail) return { publicLinkFailed: true };
      const publicShare = await window.agents.publishPublicShare(detail.id);
      const next = { ...detail, publicShare };
      assertCurrent?.();
      pendingShared.current = next;
      assertCurrent?.();
      setRemoteDetail(next);
      const link = await agentLinks.resolveLink({
        kind: 'public',
        id: detail.id,
        sharePath: publicShare.sharePath,
      });
      assertCurrent?.();
      setRemoteLink(link);
      return { shareUrl: link.url };
    },
    [],
  );

  const handleCompleted = useCallback((): void => {
    if (!pendingShared.current) return;
    const detail = pendingShared.current;
    onShared(detail);
    pendingShared.current = null;
  }, [onShared]);

  const publicShareState =
    !dialogState.available || !remoteDetail
      ? 'unavailable'
      : !remoteDetail.publicShare
        ? 'unpublished'
        : remoteDetail.publicShare.upToDate
          ? 'published'
          : 'stale';
  useCurrentUiStateReporter('agents.shareModal', {
    open: true,
    localAgentId: agent.id,
    ...(remoteDetail ? { sharedAgentId: remoteDetail.id } : {}),
    state: publicShareState,
    busy: dialogState.busy,
    copied: dialogState.copied,
    ...(remoteDetail ? { canUpdate: remoteDetail.canUpdate } : {}),
  });

  const revokePublicShare = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      await window.agents.revokePublicShare(remoteDetail.id);
      assertCurrent?.();
      setRemoteDetail({ ...remoteDetail, publicShare: null });
      assertCurrent?.();
      window.dispatchEvent(new Event(AGENT_PUBLIC_SHARE_CHANGED_EVENT));
      assertCurrent?.();
      onPublicLinkRemoved?.();
    },
    [onPublicLinkRemoved, remoteDetail],
  );

  const existingShare = remoteDetail
    ? deriveExistingShare({ ...remoteDetail, link: remoteLink })
    : undefined;

  return (
    <DesktopShareResourceDialog
      marketplace={{ kind: 'agent', resourceKey: agent.id }}
      resourceNoun="model preset"
      testIdPrefix="share-agent"
      requiredCapability={AGENTS_CRUD_CAPABILITY}
      scopes={SHARE_SCOPES}
      subtitle={agent.name}
      landing="marketplace"
      shareDisabled={catalogLoading}
      capabilityPackage={{ port: packagePort }}
      preflight={loadExistingShare}
      {...(existingShare ? { existingShare } : {})}
      share={share}
      retryPublicLink={retryPublicLink}
      {...(canManagePublicLink(remoteDetail)
        ? { revokePublicLink: revokePublicShare }
        : {})}
      onClose={onClose}
      onOpenAccountSettings={onOpenAccountSettings}
      onCompleted={handleCompleted}
      onStateChange={setDialogState}
    />
  );
}
