import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  RecommendedPluginItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import {
  recommendationIsOpen,
  recommendationSetupRef,
} from '@canopy/ui-app/capability/project-setup/project-setup-model';

// ---------------------------------------------------------------------------
// A repository's plugin recommendations in an organization project
// (CAN-6241, spec FR-4.2). The answer is the project's, not each person's:
// only someone who may administer the project (the setup's `canEdit`) is
// asked, once per project, and adds a recommendation for everyone or
// dismisses it in the project's shared setup. Members are not asked. A
// Personal project keeps the per-person prompt.
// ---------------------------------------------------------------------------

/** What the prompt offers in one project. */
export type RecommendationAudience =
  /** A Personal project: the per-person prompt, as before. */
  | { readonly kind: 'personal' }
  /** An organization project: only its administrators, these items. */
  | {
      readonly kind: 'organization';
      readonly setupProjectId: string;
      readonly items: RecommendedPluginItem[];
    };

/**
 * The recommendations an organization project's administrator still has to
 * decide on: neither added to the project nor dismissed. Empty for anyone
 * who can't change the project's setup, and when the setup can't be read
 * (signed out, offline, an older server), so a member is never asked and an
 * administrator is asked only about what the setup really leaves open.
 */
export async function organizationRecommendations(
  client: AccountOrganizationSettingsClient | null,
  owner: WorkspaceOwnerBinding,
  items: readonly RecommendedPluginItem[],
): Promise<RecommendedPluginItem[]> {
  if (client === null || items.length === 0) return [];
  // Unread, nobody is asked; the next inspection asks again.
  const setup = await client
    .read('organization.projects.setup', { projectId: owner.projectId })
    .then(
      (read) => read,
      (): null => null,
    );
  if (setup === null || !setup.canEdit) return [];
  return items.filter((item) => {
    const ref = recommendationSetupRef(item.ref);
    return ref !== null && recommendationIsOpen(setup, ref);
  });
}

/** Who a project's recommendations go to. */
export async function recommendationAudience(
  client: AccountOrganizationSettingsClient | null,
  owner: WorkspaceOwnerBinding | undefined,
  items: readonly RecommendedPluginItem[],
): Promise<RecommendationAudience> {
  if (owner?.type !== 'organization') return { kind: 'personal' };
  return {
    kind: 'organization',
    setupProjectId: owner.projectId,
    items: await organizationRecommendations(client, owner, items),
  };
}
