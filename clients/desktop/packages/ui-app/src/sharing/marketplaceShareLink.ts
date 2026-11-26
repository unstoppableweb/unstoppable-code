import {
  marketplaceShareLinkUrl,
  type MarketplaceShareLinkKind,
} from '@canopy/protocol/marketplace';
import { isUuid } from '@canopy/protocol/uuid';
import { MODEL_PRESET_LABEL } from '@canopy/ui-shared/lib/model-preset-labels';
import {
  deriveExistingShare,
  type ExistingShareFacts,
} from './deriveExistingShare';
import type { SharedByYouCopyLinkPort } from './sharedByYouScopedLink';

export type SharedLinkKind = MarketplaceShareLinkKind;
export const SHARED_LINK_KIND_LABELS: Readonly<Record<SharedLinkKind, string>> =
  {
    skill: 'skill',
    plugin: 'plugin',
    agent: MODEL_PRESET_LABEL.toLowerCase(),
    collection: 'collection',
    pipeline: 'workflow',
    automation: 'automation',
  };

export function marketplaceShareLink(
  origin: string | null | undefined,
  kind: SharedLinkKind,
  itemId: string | null | undefined,
): string | null {
  return origin && itemId && isUuid(itemId)
    ? marketplaceShareLinkUrl(origin, kind, itemId)
    : null;
}

export interface MarketplaceLinkAccess {
  readonly audience: 'team' | 'organization' | 'public';
  readonly name?: string;
}

/** Readability, independently of management permission. Names come only from matching stored owners. */
export function marketplaceLinkAccess(
  facts: ExistingShareFacts,
  personalOrganizationId: string | null = null,
): MarketplaceLinkAccess | null {
  const share = deriveExistingShare(facts, personalOrganizationId);
  if (!share || share.audience === 'private') return null;
  if (share.audience === 'public') return { audience: 'public' };
  const owner = facts.owner;
  const personal =
    owner?.type === 'organization' &&
    owner.id?.toLowerCase() === personalOrganizationId?.toLowerCase();
  const name =
    owner?.type === share.audience && owner.id?.trim() && !personal
      ? owner.name?.trim()
      : undefined;
  return { audience: share.audience, ...(name ? { name } : {}) };
}

export function marketplaceLinkCopiedNotice(
  access: MarketplaceLinkAccess,
): string {
  if (access.audience === 'public')
    return 'Link copied. Anyone with the link can open it.';
  if (!access.name) return 'Link copied. Existing sharing permissions apply.';
  return access.audience === 'team'
    ? `Link copied. Only members of the ${access.name} team can open it.`
    : `Link copied. Only ${access.name} members can open it.`;
}

export async function copyMarketplaceLink(
  link: string,
  access: MarketplaceLinkAccess,
  port: SharedByYouCopyLinkPort,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  let copied = false;
  try {
    copied = await port.write(link);
  } catch {
    /* Rejected clipboard writes are failures too. */
  }
  if (isCurrent())
    port.notify({
      tone: copied ? 'success' : 'warning',
      message: copied
        ? marketplaceLinkCopiedNotice(access)
        : 'Couldn’t copy the link. Try again.',
      ...(access.name ? { blockMessageFromReplay: true } : {}),
    });
  return copied && isCurrent();
}
