import type {
  SharedArtifactFailure,
  SharedArtifactLoad,
} from '@canopy/app-state/shared-artifacts';
import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import { sharedArtifactSharePath } from '@canopy/protocol/shared-artifacts';
import type { ShareResourceExistingShare } from '../sharing';
import type { SharedArtifactViewer } from './shared-artifacts-host';

/**
 * Pure derivations for the shared artifact viewer (CAN-8017). The server
 * computes `permissions`; nothing here re-derives policy.
 */

export type SharedArtifactViewerState =
  | { readonly status: 'unavailable' }
  | { readonly status: 'unshared' }
  | { readonly status: 'loading' }
  | { readonly status: 'signIn' }
  | { readonly status: 'noAccess' }
  | { readonly status: 'error'; readonly failure: SharedArtifactFailure }
  | { readonly status: 'takenDown'; readonly artifact: SharedArtifact }
  | { readonly status: 'ready'; readonly artifact: SharedArtifact };

/**
 * The viewer state, first match wins: unavailable, unshared, loading, sign
 * in, no access, error, taken down, ready.
 */
export function deriveSharedArtifactViewerState(input: {
  readonly view: boolean;
  readonly hasClient: boolean;
  readonly load: SharedArtifactLoad;
  readonly signedIn: boolean;
}): SharedArtifactViewerState {
  const { load } = input;
  if (!input.view || !input.hasClient || load.status === 'unavailable')
    return { status: 'unavailable' };
  if (
    load.status === 'failed' &&
    load.failure.kind === 'capability_unavailable'
  )
    return { status: 'unavailable' };
  if (load.status === 'unshared') return { status: 'unshared' };
  if (load.status === 'loading') return { status: 'loading' };
  if (load.status === 'failed') {
    if (load.failure.kind === 'not_found')
      return { status: input.signedIn ? 'noAccess' : 'signIn' };
    return { status: 'error', failure: load.failure };
  }
  const { artifact } = load.result;
  if (artifact.takedown !== null) return { status: 'takenDown', artifact };
  return { status: 'ready', artifact };
}

/** Effective public access: the author's choice, the setting, no takedown. */
export function isSharedArtifactEffectivelyPublic(
  artifact: Pick<
    SharedArtifact,
    'public' | 'publicSharingAllowed' | 'takedown'
  >,
): boolean {
  return (
    artifact.public.enabled &&
    artifact.publicSharingAllowed &&
    artifact.takedown === null
  );
}

/** The author turned the link on but the setting pauses it. */
export function isSharedArtifactPublicLinkPaused(
  artifact: Pick<SharedArtifact, 'public' | 'publicSharingAllowed'>,
): boolean {
  return artifact.public.enabled && !artifact.publicSharingAllowed;
}

/** The paused notice shows only to someone who can act on the link. */
export function showsSharedArtifactPausedNotice(
  artifact: Pick<
    SharedArtifact,
    'public' | 'publicSharingAllowed' | 'permissions'
  >,
): boolean {
  return (
    isSharedArtifactPublicLinkPaused(artifact) &&
    artifact.permissions.canSetPublic
  );
}

/**
 * Whether the viewer is outside the owner's audience: signed out, not a
 * member of the owning organization (or the team's organization), or not
 * the owning person. Anything unclassifiable counts as outside, so a gap
 * shows the banner and hides the name. A display rule from explicit account
 * facts, not authorization.
 */
export function isOutsideSharedArtifactAudience(
  owner: SharedArtifact['owner'] | null | undefined,
  viewer: SharedArtifactViewer,
): boolean {
  if (!viewer.signedIn || owner === null || owner === undefined) return true;
  switch (owner.type) {
    case 'user':
      return viewer.userId === undefined || viewer.userId !== owner.userId;
    case 'organization':
      return !viewer.organizationIds.includes(owner.organizationId);
    case 'team':
      return !viewer.organizationIds.includes(owner.organization.id);
    default:
      return true;
  }
}

/** The owner's display name for the owner line, or null to hide it. */
export function sharedArtifactOwnerName(
  artifact: Pick<SharedArtifact, 'owner'>,
  outside: boolean,
): string | null {
  if (outside) return null;
  const name = artifact.owner.name?.trim();
  return name === undefined || name === '' ? null : name;
}

/** The automation label, hidden from outside viewers (it may be internal). */
export function sharedArtifactAutomationLabel(
  artifact: Pick<SharedArtifact, 'latestRevision'>,
  outside: boolean,
): string | null {
  if (outside) return null;
  const label = artifact.latestRevision.republish?.automationLabel.trim();
  return label === undefined || label === '' ? null : label;
}

/** Whether the caller can open the share controls at all. */
export function canManageSharedArtifact(
  artifact: Pick<SharedArtifact, 'permissions'>,
): boolean {
  const { permissions } = artifact;
  return (
    permissions.canChangeAudience ||
    permissions.canSetPublic ||
    permissions.canUnshare
  );
}

/** Report is for callers who don't edit the artifact. */
export function canReportSharedArtifact(
  artifact: Pick<SharedArtifact, 'permissions'>,
): boolean {
  return !artifact.permissions.canEdit;
}

/**
 * `ShareResourceDialog`'s `existingShare` for an artifact: team and
 * organization map to that audience with the owner as target; `private`
 * passes none (its public link is managed in the public link section).
 */
export function sharedArtifactExistingShare(
  artifact: Pick<SharedArtifact, 'id' | 'owner' | 'shareScope'>,
  absoluteUrl: (path: string) => string,
): ShareResourceExistingShare | undefined {
  const link = {
    url: absoluteUrl(sharedArtifactSharePath(artifact.id)),
    kind: 'scoped' as const,
  };
  const { owner } = artifact;
  if (artifact.shareScope === 'team' && owner.type === 'team') {
    return {
      audience: 'team',
      target: {
        id: owner.teamId,
        name: owner.name ?? '',
        organizationId: owner.organization.id,
        ...(owner.organization.name === null
          ? {}
          : { secondaryLabel: owner.organization.name }),
      },
      link,
    };
  }
  if (artifact.shareScope === 'organization' && owner.type === 'organization') {
    return {
      audience: 'organization',
      target: { id: owner.organizationId, name: owner.name ?? '' },
      link,
    };
  }
  return undefined;
}

/** An idempotency key for one committed user action. */
export function newSharedArtifactIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function')
    return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A localized date and time for the "Last updated" line. */
export function formatSharedArtifactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
