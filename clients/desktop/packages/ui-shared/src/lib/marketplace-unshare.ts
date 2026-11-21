import type { MarketplaceShareLinkKind } from '@canopy/protocol/marketplace';
/**
 * Copy and failure classification for Unsharing an account share from its
 * Marketplace detail (CAN-4263). Both hosts render the same confirmation, so
 * the wording lives here once; each host maps its transport's refusal onto a
 * `MarketplaceUnshareError` reason.
 */

/** The share kinds an owner can Unshare from Marketplace. */
export type MarketplaceUnshareKind =
  | 'skill'
  | 'collection'
  | 'plugin'
  | 'agent';

/** Explicit singular labels; display labels are not mechanically singularized. */
export const MARKETPLACE_UNSHARE_KIND_LABELS: Readonly<
  Record<MarketplaceUnshareKind, string>
> = {
  skill: 'skill',
  collection: 'collection',
  plugin: 'plugin',
  agent: 'agent',
};

/** Whether a share kind is one an owner can Unshare from Marketplace. */
export function isMarketplaceUnshareKind(
  kind: string,
): kind is MarketplaceUnshareKind {
  return Object.hasOwn(MARKETPLACE_UNSHARE_KIND_LABELS, kind);
}

export const MARKETPLACE_UNSHARE_LABEL = 'Unshare';
export const MARKETPLACE_UNSHARE_BUSY_LABEL = 'Unsharing…';

/** ⋯ menu label when the item is shared with more than one audience. */
export const MARKETPLACE_UNSHARE_ALL_LABEL = 'Unshare all';

/**
 * The ⋯ Unshare item removes every audience at once, so it reads "Unshare
 * all" when the Shared by you section lists two audience rows.
 */
export function marketplaceUnshareMenuLabel(audienceCount: number): string {
  void audienceCount;
  return MARKETPLACE_UNSHARE_LABEL;
}

/**
 * Why a delete was refused. `forbidden` and `not-found` mean the page is out
 * of date, `in-use` is a skill that shared collections still reference.
 */
export type MarketplaceUnshareFailureReason =
  | 'forbidden'
  | 'not-found'
  | 'in-use'
  | 'unknown';

export class MarketplaceUnshareError extends Error {
  readonly reason: MarketplaceUnshareFailureReason;
  /**
   * The thrower already recorded the underlying failure, so the confirmation
   * shows its message without recording the same attempt again.
   */
  readonly alreadyReported: boolean;

  constructor(
    reason: MarketplaceUnshareFailureReason,
    message?: string,
    options?: { readonly alreadyReported?: boolean },
  ) {
    super(message ?? `Unshare failed: ${reason}`);
    this.name = 'MarketplaceUnshareError';
    this.reason = reason;
    this.alreadyReported = options?.alreadyReported ?? false;
  }
}

/** Maps an HTTP-style refusal status onto a failure reason. */
export function marketplaceUnshareReasonForStatus(
  status: number | undefined,
): MarketplaceUnshareFailureReason {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'in-use';
  return 'unknown';
}

/**
 * What Unshare does, as the confirmation states it. Deleting the account
 * share also revokes its public link (the link cascades with the share); a
 * collection's skills are separate shares and stay as they are. Nothing is
 * promised about copies already installed.
 */
export function marketplaceUnshareMessage(
  kind: MarketplaceShareLinkKind,
  ownerName?: string | null,
): string {
  const label =
    kind === 'pipeline'
      ? 'workflow'
      : kind === 'automation'
        ? 'automation'
        : MARKETPLACE_UNSHARE_KIND_LABELS[kind];
  const audience = ownerName?.trim()
    ? `People in ${ownerName.trim()}`
    : 'People it was shared with';
  const sentences = [
    `${audience} will no longer find this ${label} in Marketplace.`,
    'If it has a public link, that link stops working too.',
  ];
  if (kind === 'collection') {
    sentences.push('The skills in it are not unshared.');
  }
  return sentences.join(' ');
}

/** Inline error for a refused Unshare; the dialog stays open to retry. */
export function marketplaceUnshareErrorMessage(
  kind: MarketplaceShareLinkKind,
  reason: MarketplaceUnshareFailureReason,
): string {
  const label =
    kind === 'pipeline'
      ? 'workflow'
      : kind === 'automation'
        ? 'automation'
        : MARKETPLACE_UNSHARE_KIND_LABELS[kind];
  switch (reason) {
    case 'forbidden':
      return `You no longer have permission to unshare this ${label}. Refresh the page to see its current status.`;
    case 'not-found':
      return `This ${label} is no longer shared, or was already unshared. Refresh the page to see the current list.`;
    case 'in-use':
      return 'Couldn’t unshare this skill because shared collections include it. Remove it from those collections, then try again.';
    case 'unknown':
      return `Couldn’t unshare this ${label}. Try again.`;
  }
}

/** Success notice a host shows after navigating away. */
export function marketplaceUnsharedNotice(name: string): string {
  return `Unshared “${name}”`;
}
