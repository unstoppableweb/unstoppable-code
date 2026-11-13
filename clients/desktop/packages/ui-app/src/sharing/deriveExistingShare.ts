import { marketplacePublicLinkPinnedAt } from '@canopy/protocol/marketplace';
import type { ShareScope } from '@canopy/protocol/sharing';
import type { ShareTarget } from '@canopy/ui-shared/components';
import type { ShareDialogLink } from './ShareDialogFrame';
import type {
  ShareResourceExistingShare,
  ShareResourceShareInput,
} from './ShareResourceDialog';

/**
 * How every share surface reads a resource's current cloud share. Skills,
 * pipelines, automations, agents, collections, plugins and project templates
 * each return a detail with the same three facts (the stored scope, the
 * owner, and an optional public link), so one helper turns them into the
 * dialog's `existingShare`, the owner fields an update sends, and the label a
 * list row shows.
 */

/**
 * A share's owner as the cloud reports it. Structural on purpose: the
 * per-resource detail types disagree on which fields are nullable, and a
 * `ResourceOwner` from `@canopy/protocol/resource-owner` satisfies it as is.
 */
export interface ExistingShareOwner {
  readonly type: 'system' | 'user' | 'team' | 'organization';
  readonly id?: string;
  readonly name?: string | null;
  /** A team's organization. */
  readonly organization?: {
    readonly id: string;
    readonly name?: string | null;
  } | null;
}

/** The facts about a cloud share that decide how it reads. */
export interface ExistingShareFacts {
  /** The stored scope. A public share is stored as `private` plus a link. */
  readonly shareScope?: ShareScope | null;
  readonly owner?: ExistingShareOwner | null;
  /** The public link, when one exists. */
  readonly publicShare?: {
    readonly upToDate?: boolean;
    readonly updatedAt?: string;
  } | null;
  /** The share's current link, shown as Copy link. */
  readonly link?: ShareDialogLink | null;
}

/**
 * Names for an existing share's team or organization the account can't name
 * (deleted, left, or a stale account cache).
 */
export const SHARED_TEAM_FALLBACK_NAME = 'Shared team';
export const SHARED_ORGANIZATION_FALLBACK_NAME = 'Shared organization';
const TEAM_FALLBACK_NAME = SHARED_TEAM_FALLBACK_NAME;
const ORGANIZATION_FALLBACK_NAME = SHARED_ORGANIZATION_FALLBACK_NAME;

function ownerAudience(
  owner: ExistingShareOwner | null | undefined,
): 'team' | 'organization' | null {
  if (!owner || owner.id === undefined) return null;
  return owner.type === 'team' || owner.type === 'organization'
    ? owner.type
    : null;
}

function ownerTarget(
  owner: ExistingShareOwner | null | undefined,
  personalOrganizationId: string | null,
): ShareTarget | undefined {
  const audience = ownerAudience(owner);
  if (audience === null || !owner || owner.id === undefined) return undefined;
  if (audience === 'organization') {
    return {
      id: owner.id,
      name:
        owner.id === personalOrganizationId
          ? 'Personal'
          : (owner.name ?? ORGANIZATION_FALLBACK_NAME),
    };
  }
  const organization = owner.organization;
  return {
    id: owner.id,
    name: owner.name ?? TEAM_FALLBACK_NAME,
    ...(organization
      ? {
          organizationId: organization.id,
          ...(organization.name ? { secondaryLabel: organization.name } : {}),
        }
      : {}),
  };
}

/**
 * The dialog's `existingShare` for a cloud share, or `undefined` when the
 * resource is not shared with anyone (a private copy with no public link), so
 * the dialog opens as a first share.
 *
 * A team or organization share that also has a public link reads as Public,
 * which keeps Remove public link reachable; its team or organization stays
 * the target so the confirm copy and an Update keep the owner.
 */
export function deriveExistingShare(
  facts: ExistingShareFacts,
  personalOrganizationId: string | null = null,
): ShareResourceExistingShare | undefined {
  const scope = facts.shareScope ?? 'private';
  const hasPublicLink =
    facts.publicShare !== null && facts.publicShare !== undefined;
  if (scope === 'private' && !hasPublicLink) return undefined;
  const target = ownerTarget(facts.owner, personalOrganizationId);
  const targetAudience = ownerAudience(facts.owner);
  // A host may still hold the public URL after Remove public link cleared its
  // public share; the dialog stays open, so it must not offer the dead link.
  const link =
    facts.link && (facts.link.kind !== 'public' || hasPublicLink)
      ? facts.link
      : undefined;
  return {
    audience: hasPublicLink ? 'public' : scope,
    ...(target && targetAudience ? { target, targetAudience } : {}),
    ...(facts.publicShare?.upToDate === false ? { publicLinkStale: true } : {}),
    ...(marketplacePublicLinkPinnedAt(facts.publicShare?.updatedAt)
      ? {
          publicLinkPinnedAt: marketplacePublicLinkPinnedAt(
            facts.publicShare?.updatedAt,
          ),
        }
      : {}),
    ...(link ? { link } : {}),
  };
}

/** Owner kind from explicit metadata, scoped audience or the established team-parent shape. */
export function existingShareOwnerAudience(
  existing:
    | Pick<ShareResourceExistingShare, 'audience' | 'target' | 'targetAudience'>
    | undefined,
): 'team' | 'organization' | undefined {
  return (
    existing?.targetAudience ??
    (existing?.audience === 'team' || existing?.audience === 'organization'
      ? existing.audience
      : existing?.target?.organizationId !== undefined
        ? 'team'
        : undefined)
  );
}

/**
 * Public requires a personal owner. Only a known Personal organization can
 * exempt a scoped owner, including one with a legacy public link. The caller
 * decides whether this policy applies.
 */
export function publicAudienceLocked(
  existing:
    | Pick<ShareResourceExistingShare, 'audience' | 'target' | 'targetAudience'>
    | undefined,
  personalOrganizationId: string | null,
): boolean {
  const target = existing?.target;
  if (!existing || !target) return false;
  const kind = existingShareOwnerAudience(existing);
  // A target whose kind is unknown can't prove the Personal exception.
  if (kind === undefined) return true;
  // A team id is never an organization id: a team with no known parent stays
  // locked even when its id happens to match.
  const organizationId =
    kind === 'organization' ? target.id : target.organizationId;
  return (
    personalOrganizationId === null ||
    organizationId === undefined ||
    organizationId.toLowerCase() !== personalOrganizationId.toLowerCase()
  );
}

/** The owner fields a share request stores. */
export interface ShareOwnerFields {
  readonly shareScope: ShareScope;
  readonly teamId?: string;
  readonly organizationId?: string;
}

/**
 * The owner a share request sends for the audience the author chose.
 *
 * Public uses a personal (`private`) canonical copy. An explicit Public
 * update normalizes a legacy scoped owner while preserving its public link.
 */
export function shareOwnerFields(
  input: Pick<ShareResourceShareInput, 'scope' | 'teamId' | 'organizationId'>,
  _existing?: Pick<
    ExistingShareFacts,
    'shareScope' | 'owner' | 'publicShare'
  > | null,
): ShareOwnerFields {
  // Keep the legacy argument for existing callers; the chosen audience decides ownership.
  void _existing;
  if (input.scope === 'team') {
    return {
      shareScope: 'team',
      ...(input.teamId ? { teamId: input.teamId } : {}),
    };
  }
  if (input.scope === 'organization') {
    return {
      shareScope: 'organization',
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    };
  }
  return { shareScope: 'private' };
}

/** What a list row's audience label needs: the audience and a team's name. */
export interface ExistingShareAudienceLabel {
  readonly audience: 'team' | 'organization' | 'public';
  readonly teamName?: string;
  readonly personal?: boolean;
}

/**
 * The audience a list row or detail header shows after a shared resource's
 * name (`ShareAudienceLabel` in `@canopy/ui-shared`), or `null` when the
 * resource is not shared.
 */
export function existingShareAudienceLabel(
  facts: ExistingShareFacts,
  personalOrganizationId: string | null = null,
): ExistingShareAudienceLabel | null {
  const existing = deriveExistingShare(facts, personalOrganizationId);
  if (!existing || existing.audience === 'private') return null;
  if (existing.audience !== 'team')
    return {
      audience: existing.audience,
      ...(existing.audience === 'organization' &&
      facts.owner?.type === 'organization' &&
      facts.owner.id === personalOrganizationId
        ? { personal: true }
        : {}),
    };
  const teamName = facts.owner?.name;
  return {
    audience: 'team',
    ...(teamName ? { teamName } : {}),
  };
}
