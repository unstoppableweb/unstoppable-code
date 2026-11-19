'use client';

import type { JSX } from 'react';
import type { OrganizationRole } from '@canopy/protocol/settings/organization';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { SettingsLink } from '../host';
import { DigestPreferencesCard } from '../digests/digest-preferences-card';
import { digestPreferencesDescription } from '../digests/digest-format';

interface TeamDigestSettingsSectionProps {
  orgId: string;
  viewerRole: OrganizationRole;
}

/**
 * Organization work-digest cadences, in the General settings subtab.
 *
 * Two independent gates, deliberately: `canEditOrg` here so a MEMBER never sees
 * controls whose every save would 403, and the route's own re-derivation of the
 * role server-side so the client gate is not the security boundary. The digests
 * feature flag is a third gate handled inside the card via the API's 404.
 */
export function TeamDigestSettingsSection({
  orgId,
  viewerRole,
}: TeamDigestSettingsSectionProps): JSX.Element | null {
  if (!canEditOrg(viewerRole)) {
    return null;
  }

  return (
    <DigestPreferencesCard
      owner={{ kind: 'organization', organizationId: orgId }}
      title="Work digests"
      // Role-neutral wording, matching the personal card. An organization
      // digest covers whoever is working in it, not just its engineers.
      description={digestPreferencesDescription({ kind: 'organization' })}
      testIdPrefix="team"
      footer={
        <SettingsLink
          href={`/organization/${orgId}/digests`}
          data-testid="team-view-digests-link"
          className="text-s font-medium fg-accent hover:underline"
        >
          View past digests
        </SettingsLink>
      }
    />
  );
}
