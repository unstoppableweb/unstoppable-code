'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import {
  selectSettingsBootstrap,
  useOptionalSettingsStore,
} from '@canopy/app-state/settings';
import {
  organizationPageDataKindForRoute,
  type OrganizationDetail,
  type OrganizationRole,
  type OrganizationSettingsRoute,
  type SettingsOrganizationMembership,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import { OrganizationInviteButton } from '../../sharing/OrganizationInviteButton';
import { SettingsPageColumn } from '../layout/SettingsPageColumn';
import { SettingsPageNotice } from '../layout/settings-page-notice';
import { settingsPageSkeleton } from '../pages/loading-skeletons';
import {
  organizationSettingsSubtabItem,
  resolveOrganizationSettingsSubtab,
  teamNavItem,
  type OrganizationSettingsSubtabItem,
  type TeamNavItem,
  type TeamTab,
} from '../navigation/organization-nav-items';
import { organizationSettingsSubtabsFromBootstrap } from '../navigation/settings-nav-bootstrap';
import { Heading } from '@canopy/ui-shared/components';

/**
 * What an organization tab draws above its page header. The settings rail's
 * scope picker names the organization, so only the Personal organization
 * draws a header of its own. `TeamPage` renders it live;
 * {@link OrganizationSettingsPlaceholder} renders the same markup read-only
 * while a tab loads, so nothing moves when the page replaces it.
 */

/** What the header shows for an organization, from the best source known. */
export interface OrganizationHeaderModel {
  readonly id: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly viewerRole: OrganizationRole;
  readonly isPersonal: boolean;
}

/**
 * What is known about an organization: from its detail when known (a tab
 * loaded it, or a change updated it), otherwise from the bootstrap
 * membership, otherwise `null`.
 */
export function organizationHeaderModel(
  organizationId: string,
  detail: OrganizationDetail | null,
  memberships: readonly SettingsOrganizationMembership[],
): OrganizationHeaderModel | null {
  if (detail !== null && detail.id === organizationId)
    return {
      id: detail.id,
      name: detail.name,
      logoUrl: detail.logoUrl,
      viewerRole: detail.viewerRole,
      isPersonal: detail.isPersonal === true,
    };
  const membership = memberships.find(
    (candidate) => candidate.id === organizationId,
  );
  if (membership === undefined) return null;
  return {
    id: membership.id,
    name: membership.name,
    logoUrl: membership.logoUrl ?? null,
    viewerRole: membership.role,
    isPersonal: membership.isPersonal,
  };
}

/**
 * The organization tab a route draws under the organization header, or
 * `null` for routes without it: account pages, the Organizations list, and
 * drill-downs with their own back-link header (a member's profile or digest,
 * a digest, an invoice).
 */
export function organizationTabForRoute(route: SettingsRoute): TeamTab | null {
  if (route.scope !== 'organization') return null;
  switch (route.page) {
    case 'members':
      return route.userId === undefined ? 'members' : null;
    case 'digests':
      return route.digestId === undefined ? 'digests' : null;
    case 'settings':
      return route.invoiceId === undefined ? 'settings' : null;
    case 'transcripts':
      // A session has its own breadcrumb header.
      return route.sessionId === undefined ? 'transcripts' : null;
    case 'feed':
    case 'statistics':
    case 'groups':
    case 'projects':
    case 'memory':
      return route.page;
  }
}

/**
 * Timeline, Statistics, Memory and Transcripts hold feeds, charts, a graph
 * and wide tables, so they keep the wide column; every other organization
 * page is a settings page in the shared 640px column.
 */
export function organizationTabColumnWidth(tab: TeamTab): 'settings' | 'wide' {
  return tab === 'feed' ||
    tab === 'statistics' ||
    tab === 'memory' ||
    tab === 'transcripts'
    ? 'wide'
    : 'settings';
}

const NO_MEMBERSHIPS: readonly SettingsOrganizationMembership[] = [];

function useOrganizationMemberships(
  organizationId: string,
): readonly SettingsOrganizationMembership[] {
  const own = useOptionalSettingsStore(
    (state) => selectSettingsBootstrap(state, organizationId).data,
  );
  const account = useOptionalSettingsStore(
    (state) => selectSettingsBootstrap(state, null).data,
  );
  return (own ?? account)?.organizations ?? NO_MEMBERSHIPS;
}

/**
 * The header model from the settings store's caches: the last detail any tab
 * loaded, else the bootstrap membership. Without a store (web), `null`.
 */
export function useOrganizationHeaderModel(
  organizationId: string,
): OrganizationHeaderModel | null {
  const detail = useOptionalSettingsStore(
    (state) => state.organizationDetails[organizationId],
  );
  const memberships = useOrganizationMemberships(organizationId);
  return useMemo(
    () => organizationHeaderModel(organizationId, detail ?? null, memberships),
    [organizationId, detail, memberships],
  );
}

/**
 * Header for the viewer's personal organization. It names the space rather than
 * an organization, so there is no logo, role, rename, or member count.
 */
export function PersonalOverviewHeader({
  onInvite,
}: {
  readonly onInvite: () => void;
}): JSX.Element {
  return (
    <header data-testid="team-personal-header">
      <Heading level={1} variant="page" truncate>
        Personal
      </Heading>
      <p className="pt-1.5 text-s fg-secondary">
        Your activity and usage across your personal work.
      </p>
      <div className="pt-3">
        <OrganizationInviteButton
          testId="team-personal-invite"
          onClick={onInvite}
        />
      </div>
    </header>
  );
}

/**
 * The read-only header a loading tab draws: the Personal header for the
 * Personal organization (inert), nothing for any other organization.
 */
function OrganizationHeaderPreview({
  organizationId,
}: {
  readonly organizationId: string;
}): JSX.Element | null {
  const model = useOrganizationHeaderModel(organizationId);
  return model?.isPersonal === true ? (
    <PersonalOverviewHeader onInvite={noop} />
  ) : null;
}

const noop = (): void => undefined;

/**
 * The page a placeholder names, as the loaded page will: a bare or hidden
 * `?tab=` opens the viewer's first Settings page. Without the organization's bootstrap
 * yet, the route's own page.
 */
function usePlaceholderPageItem(
  route: OrganizationSettingsRoute,
  tab: TeamTab,
): TeamNavItem | OrganizationSettingsSubtabItem {
  const bootstrap = useOptionalSettingsStore(
    (state) => selectSettingsBootstrap(state, route.organizationId).data,
  );
  if (route.page !== 'settings') return teamNavItem(tab);
  const organization =
    bootstrap?.organization?.id === route.organizationId
      ? bootstrap.organization
      : null;
  if (organization === null)
    return organizationSettingsSubtabItem(route.subtab ?? 'general');
  const subtab =
    resolveOrganizationSettingsSubtab(
      route.subtab ?? null,
      organizationSettingsSubtabsFromBootstrap(organization),
    ) ??
    route.subtab ??
    'general';
  return organizationSettingsSubtabItem(subtab);
}

export interface OrganizationSettingsPlaceholderProps {
  readonly route: OrganizationSettingsRoute;
  /**
   * The body under the page header: an error state, or by default the tab's
   * loading skeleton, shown once loading takes noticeably long.
   */
  readonly body?: ReactNode;
  /** Delay before the default skeleton shows; `0` shows it at once. */
  readonly skeletonDelayMs?: number;
}

/**
 * An organization tab that is not ready yet: the organization header and the
 * tab's page header exactly where the loaded page draws them, with only the
 * body standing in. The header is inert, so nothing in it acts on a page that
 * has not loaded.
 */
export function OrganizationSettingsPlaceholder({
  route,
  body,
  skeletonDelayMs,
}: OrganizationSettingsPlaceholderProps): JSX.Element {
  const tab = organizationTabForRoute(route) ?? route.page;
  const item = usePlaceholderPageItem(route, tab);
  const personal =
    useOrganizationHeaderModel(route.organizationId)?.isPersonal === true;
  return (
    // `contents` keeps the column a direct child of the host's frame.
    <div className="contents" data-testid="organization-settings-loading">
      <SettingsPageColumn
        className="relative"
        width={organizationTabColumnWidth(tab)}
      >
        <div className="contents" inert>
          <OrganizationHeaderPreview organizationId={route.organizationId} />
        </div>
        <PageHeader
          inset="none"
          headingLevel={personal ? 'h2' : 'h1'}
          reserveActions
          title={item.label}
          description={item.description}
        />
        <SettingsPageNotice />
        {body ??
          settingsPageSkeleton(
            organizationPageDataKindForRoute(route),
            undefined,
            skeletonDelayMs,
          )}
      </SettingsPageColumn>
    </div>
  );
}
