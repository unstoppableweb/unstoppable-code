'use client';

import { useMemo, type JSX } from 'react';
import type { SharedArtifactsClient } from '@canopy/app-core';
import { SHARED_ARTIFACT_COPY } from './shared-artifact-copy';
import { SharedArtifactListBody } from './SharedArtifactsList';

/**
 * An organization's public artifacts, read-only, for its Owners and Admins
 * (CAN-8017). Mounted under the "Allow public artifacts" setting once the
 * settings protocol carries it.
 */
export function OrganizationPublicArtifactsList({
  client,
  organizationId,
  onOpen,
}: {
  readonly client: SharedArtifactsClient | null;
  readonly organizationId: string;
  readonly onOpen: (artifactId: string) => void;
}): JSX.Element {
  const query = useMemo(
    () => ({ view: 'organizationPublic' as const, organizationId }),
    [organizationId],
  );
  return (
    <div data-testid="organization-public-artifacts-list">
      <SharedArtifactListBody
        key={organizationId}
        client={client}
        query={query}
        emptyLabel={SHARED_ARTIFACT_COPY.listEmptyOrganizationPublic}
        showOwner
        onOpen={onOpen}
      />
    </div>
  );
}
