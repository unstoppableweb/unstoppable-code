'use client';

import type { JSX, ReactNode } from 'react';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';

/**
 * The Organizations list's page header. Kept apart from
 * `OrganizationListPage` so the route's loading frame can draw the same
 * header without loading the page chunk. The actions slot is reserved, so
 * the header keeps its height before "New organization" appears.
 */
export function OrganizationListHeader({
  actions,
}: {
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <PageHeader
      inset="none"
      reserveActions
      title="Organizations"
      description="Open an organization, answer an invitation, or start a new one."
      actions={actions}
    />
  );
}
