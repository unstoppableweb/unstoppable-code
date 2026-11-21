import type { SharedLinkKind } from '@canopy/ui-app/sharing';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  MarketplaceUnshareError,
  marketplaceUnsharedNotice,
  marketplaceUnshareReasonForStatus,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import { readSharedResourceErrorStatus } from './sharedResourceErrors';
import { postShareToast } from './share-toast';
import {
  SHARED_AGENTS_CHANGED_EVENT,
  SHARED_PLUGINS_CHANGED_EVENT,
} from '@/hooks/useSharedMarketplaceShares';

/**
 * Deletes an account share through the existing preload methods, for the
 * shared Marketplace Unshare (CAN-4263). `shareId` is the account share's
 * own identifier: the summary `id` for skills, collections and agents, and
 * the plugin's `externalId` (the preload request's `remoteId`).
 *
 * Resolves only once main confirmed the delete. The plugin channel answers
 * with an `IPCResult` instead of rejecting, so a resolved failure is turned
 * into a rejection here and never reads as success.
 */
export async function unshareMarketplaceResource(
  kind: SharedLinkKind,
  shareId: string,
): Promise<void> {
  try {
    switch (kind) {
      case 'pipeline': {
        const result = await window.pipelines.deleteShared({
          remoteId: shareId,
        });
        if (!result.success) throw new Error(result.error ?? 'Unshare failed');
        window.dispatchEvent(new Event('canopy:pipeline-public-share-changed'));
        return;
      }
      case 'automation':
        await window.api.automations.deleteShared({ automationId: shareId });
        window.dispatchEvent(
          new Event('canopy:automation-public-share-changed'),
        );
        return;
      case 'skill':
        await window.skills.deleteShared({ skillId: shareId });
        return;
      case 'collection':
        await window.collections.deleteShared({ collectionId: shareId });
        return;
      case 'agent':
        await window.agents.deleteShared({ agentId: shareId });
        return;
      case 'plugin': {
        const result = await window.plugins.deleteShared({
          serverId: CANOPY_CLOUD_SERVER_ID,
          remoteId: shareId,
        });
        if (!result.success) throw new Error(result.error ?? 'Unshare failed');
        return;
      }
    }
  } catch (error: unknown) {
    throw new MarketplaceUnshareError(
      marketplaceUnshareReasonForStatus(readSharedResourceErrorStatus(error)),
      error instanceof Error ? error.message : undefined,
      // Main already recorded an IPC rejection; the dialog must not again.
      {
        alreadyReported:
          toAppError(resolveClientAppError(error))?.recordedBy !== undefined,
      },
    );
  }
}

/** The team or organization a share reaches, for the Unshare confirmation. */
export function unshareOwnerName(owner: {
  type: string;
  name?: string | null;
}): string | null {
  if (owner.type !== 'team' && owner.type !== 'organization') return null;
  return owner.name?.trim() || null;
}

/**
 * What follows a confirmed Unshare, from a detail or a Shared by me row
 * (CAN-4840): the kind's shared list re-reads and a toast confirms it.
 */
export function followMarketplaceUnshare(
  kind: SharedLinkKind,
  name: string,
  refresh: {
    readonly sharedSkills: () => Promise<void>;
    readonly sharedCollections: () => Promise<void>;
  },
): void {
  if (kind === 'skill') void refresh.sharedSkills().catch(() => {});
  if (kind === 'collection') void refresh.sharedCollections().catch(() => {});
  if (kind === 'agent')
    window.dispatchEvent(new Event(SHARED_AGENTS_CHANGED_EVENT));
  if (kind === 'plugin')
    window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
  postShareToast({
    tone: 'success',
    message: marketplaceUnsharedNotice(name),
    blockMessageFromReplay: true,
  });
}
