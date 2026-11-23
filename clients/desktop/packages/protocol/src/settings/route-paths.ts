import type {
  AccountSettingsRoute,
  OrganizationSettingsPage,
  OrganizationSettingsRoute,
  SettingsRoute,
} from './routes';

/**
 * Web paths for settings routes. Kept free of runtime dependencies (zod and
 * the route schemas live in `routes.ts`), so a root-mounted host can build
 * settings links without adding schemas to every web route's first load.
 */

const segment = encodeURIComponent;

const ORGANIZATION_PAGE_SEGMENTS: Readonly<
  Record<Exclude<OrganizationSettingsPage, 'feed'>, string>
> = {
  statistics: 'statistics',
  digests: 'digests',
  members: 'members',
  groups: 'teams',
  projects: 'projects',
  memory: 'memory',
  settings: 'settings',
};

function accountRoutePath(route: AccountSettingsRoute): string {
  switch (route.page) {
    case 'account':
      return '/account';
    case 'digests':
      return route.digestId === undefined
        ? '/account/digests'
        : `/account/digests/${segment(route.digestId)}`;
    case 'billing':
      return route.invoiceId === undefined
        ? '/account/billing'
        : `/account/billing/invoices/${segment(route.invoiceId)}`;
    case 'profile':
    case 'notifications':
    case 'integrations':
    case 'plugins':
    case 'mcp':
    case 'delegation':
    case 'security':
    case 'model-providers':
    case 'ai-gateway':
    case 'labs':
    case 'appearance':
      return `/account/${route.page}`;
  }
}

function organizationRoutePath(route: OrganizationSettingsRoute): string {
  const base = `/organization/${segment(route.organizationId)}`;
  switch (route.page) {
    case 'feed':
      return route.itemId === undefined
        ? base
        : `${base}/feed/${segment(route.itemId)}`;
    case 'digests':
      return route.digestId === undefined
        ? `${base}/digests`
        : `${base}/digests/${segment(route.digestId)}`;
    case 'members': {
      if (route.userId === undefined) return `${base}/members`;
      const member = `${base}/members/${segment(route.userId)}`;
      return route.digestId === undefined
        ? member
        : `${member}/digests/${segment(route.digestId)}`;
    }
    case 'memory':
      if (route.factId !== undefined)
        return `${base}/memory/fact/${segment(route.factId)}`;
      if (route.memoryView === 'graph' || route.memoryView === 'ops')
        return `${base}/memory/${route.memoryView}`;
      return `${base}/memory`;
    case 'settings':
      if (route.invoiceId !== undefined)
        return `${base}/billing/invoices/${segment(route.invoiceId)}`;
      return route.subtab === undefined
        ? `${base}/settings`
        : `${base}/settings?${new URLSearchParams({ tab: route.subtab }).toString()}`;
    case 'statistics':
    case 'groups':
    case 'projects':
      return `${base}/${ORGANIZATION_PAGE_SEGMENTS[route.page]}`;
  }
}

/**
 * The web path for a validated route. Desktop uses it only to open the
 * equivalent web page; it never fetches it.
 */
export function settingsRouteToPath(route: SettingsRoute): string {
  switch (route.scope) {
    case 'account':
      return accountRoutePath(route);
    case 'organizations':
      return '/organization';
    case 'organization':
      return organizationRoutePath(route);
  }
}
