'use client';

import type { JSX, ReactNode } from 'react';
import { EmptyState, TabBar } from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import type { OrganizationTeamPageData } from '@canopy/protocol/settings';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import { SettingsLink, useSettingsRouter } from '../host';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { teamNavItem } from '../navigation/organization-nav-items';
import { TeamPage } from '../organization/team-page';
import { teamPagePropsFromData } from '../organization/team-page-props';

export type MemoryView = 'facts' | 'graph' | 'ops';

const VIEWS: ReadonlyArray<{
  readonly key: MemoryView;
  readonly label: string;
  readonly suffix: string;
}> = [
  { key: 'facts', label: 'Facts', suffix: '' },
  { key: 'graph', label: 'Graph', suffix: '/graph' },
  { key: 'ops', label: 'Operations', suffix: '/ops' },
];

/** The list page of a Memory view. */
export function memoryViewHref(orgId: string, view: MemoryView): string {
  const suffix = VIEWS.find((entry) => entry.key === view)?.suffix ?? '';
  return `/organization/${orgId}/memory${suffix}`;
}

/**
 * Where the empty Facts view sends a viewer to choose who contributes to
 * memory: the organization's Policies settings, for a viewer whose role can
 * edit them on a healthy organization (the gate the Policies subtab uses).
 * `null` when the viewer cannot, or when the host sent no organization data.
 */
export function memoryPoliciesHref(
  orgId: string,
  team: OrganizationTeamPageData | undefined,
): string | null {
  if (team === undefined || team.lapsed !== null) return null;
  if (!canEditOrgEnforcedSettings(team.detail.viewerRole)) return null;
  return `/organization/${orgId}/settings?tab=policies`;
}

/** Organization memory is off for this organization. */
export function MemoryNotEnabledState(): JSX.Element {
  return (
    <EmptyState
      testId="memory-not-enabled"
      title="Memory not enabled"
      subtitle="Organization memory is not enabled for this organization."
    />
  );
}

/** The "← Facts" link a drill-down under the Facts view leads with. */
export function MemoryFactsBackLink({
  orgId,
}: {
  readonly orgId: string;
}): JSX.Element {
  return (
    <SettingsLink
      href={memoryViewHref(orgId, 'facts')}
      data-testid="memory-fact-back"
      className="self-start text-s font-medium fg-secondary transition-colors hover:fg-primary"
    >
      ← Facts
    </SettingsLink>
  );
}

function MemoryViewsNav({
  orgId,
  view,
}: {
  readonly orgId: string;
  readonly view: MemoryView;
}): JSX.Element {
  const router = useSettingsRouter();
  return (
    <TabBar
      items={VIEWS.map((entry) => ({
        id: entry.key,
        label: entry.label,
        dataTestId: `memory-views-tab-${entry.key}`,
      }))}
      value={view}
      onChange={(next): void => router.push(memoryViewHref(orgId, next))}
      label="Memory views"
      scrollable
      dataTestId="memory-views-tabs"
    />
  );
}

export interface OrganizationMemoryLayoutProps {
  readonly orgId: string;
  /**
   * The organization header data. Older servers omit it; the page then keeps
   * the shared column and page header without the organization block.
   */
  readonly team: OrganizationTeamPageData | undefined;
  /** The view the page belongs to; a fact drill-down belongs to Facts. */
  readonly view: MemoryView;
  /** Memory is off for this organization: show that instead of the view. */
  readonly enabled: boolean;
  readonly children?: ReactNode;
}

/**
 * Every Memory page: the organization page shell (switcher, organization
 * block and page header) like the other organization tabs, then the
 * Facts / Graph / Operations views directly under the header and the view's
 * content. Without organization data it renders the same column and header.
 */
export function OrganizationMemoryLayout({
  orgId,
  team,
  view,
  enabled,
  children,
}: OrganizationMemoryLayoutProps): JSX.Element {
  const content = enabled ? (
    <div className="flex flex-col gap-6" data-testid="memory-view">
      <MemoryViewsNav orgId={orgId} view={view} />
      {children}
    </div>
  ) : (
    <MemoryNotEnabledState />
  );

  if (team !== undefined) {
    return (
      <TeamPage
        key={team.detail.id}
        {...teamPagePropsFromData(team)}
        activeTab="memory"
        memoryContent={content}
      />
    );
  }

  const item = teamNavItem('memory');
  return (
    <SettingsPageColumn as="main" width="wide">
      <PageHeader
        inset="none"
        headingLevel="h1"
        reserveActions
        title={item.label}
        description={item.description}
      />
      {content}
    </SettingsPageColumn>
  );
}
