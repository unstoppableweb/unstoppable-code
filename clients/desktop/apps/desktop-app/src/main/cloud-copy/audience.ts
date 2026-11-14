import type { CloudCopyAudience } from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';

/**
 * Who sees a shared skill copy: its share scope, and for a private one
 * whether a public link reaches it (CAN-6176). Any scope this doesn't know
 * counts as wider than private, so it never reads as private.
 */
export function cloudCopyAudience(copy: {
  readonly shareScope: string;
  readonly public: boolean;
}): CloudCopyAudience {
  if (copy.shareScope === 'private')
    return copy.public ? 'public_link' : 'private';
  if (copy.shareScope === 'team') return 'team';
  return 'organization';
}

/**
 * Who sees a linked skill copy now, from its own record in the cloud: the
 * one source both the consent dialog and the publish read, since the local
 * link file doesn't record a public link or a scope changed on the web.
 * Null when the copy no longer exists for this account.
 */
export async function readLinkedCopyAudience(
  skillId: string,
  context: CanopyCloudCredentialContext,
): Promise<CloudCopyAudience | null> {
  try {
    const detail = await (
      await import('../skills/canopy-server-client')
    ).getSharedSkill(skillId, context);
    return cloudCopyAudience({
      shareScope: detail.shareScope,
      public: detail.publicShare !== null,
    });
  } catch (error) {
    if (error instanceof CanopyCloudClientError && error.status === 404)
      return null;
    throw error;
  }
}
