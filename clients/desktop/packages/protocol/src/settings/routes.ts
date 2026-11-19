import { z } from 'zod';
import {
  ORGANIZATION_SETTINGS_NAV_TABS,
  type OrganizationSettingsNavTab,
} from './navigation';

/**
 * Hosted account and organization settings destinations, shared by the web
 * routes and the desktop Settings overlay. A route names a page and its
 * detail identifiers only; it never carries a URL, so no host can be steered
 * to an arbitrary destination through it.
 */
export const ACCOUNT_SETTINGS_PAGES = [
  'account',
  'profile',
  'digests',
  'notifications',
  'integrations',
  'plugins',
  'mcp',
  'security',
  'ai-gateway',
  'billing',
  'labs',
  'appearance',
] as const;

export type AccountSettingsPage = (typeof ACCOUNT_SETTINGS_PAGES)[number];

export type OrganizationSettingsPage = OrganizationSettingsNavTab;

export const ORGANIZATION_SETTINGS_SUBTABS = [
  'general',
  'policies',
  'project-defaults',
  'integrations',
  'usage',
  'ai-gateway',
  'billing',
] as const;

export type OrganizationSettingsSubtab =
  (typeof ORGANIZATION_SETTINGS_SUBTABS)[number];

export const ORGANIZATION_MEMORY_VIEWS = ['facts', 'graph', 'ops'] as const;

export type OrganizationMemoryView = (typeof ORGANIZATION_MEMORY_VIEWS)[number];

const SETTINGS_ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

/** An identifier that may appear in one settings route path segment. */
export const settingsRouteIdSchema = z
  .string()
  .regex(SETTINGS_ROUTE_ID)
  .refine((value) => !value.includes('..'));

export function isSettingsRouteId(value: unknown): value is string {
  return settingsRouteIdSchema.safeParse(value).success;
}

const accountRouteSchema = z
  .strictObject({
    scope: z.literal('account'),
    page: z.enum(ACCOUNT_SETTINGS_PAGES),
    digestId: settingsRouteIdSchema.optional(),
    invoiceId: settingsRouteIdSchema.optional(),
  })
  .superRefine((route, ctx) => {
    if (route.digestId !== undefined && route.page !== 'digests')
      ctx.addIssue({
        code: 'custom',
        path: ['digestId'],
        message: 'digestId is only valid on Digests',
      });
    if (route.invoiceId !== undefined && route.page !== 'billing')
      ctx.addIssue({
        code: 'custom',
        path: ['invoiceId'],
        message: 'invoiceId is only valid on Billing',
      });
  });

const organizationsRouteSchema = z.strictObject({
  scope: z.literal('organizations'),
});

const organizationRouteSchema = z
  .strictObject({
    scope: z.literal('organization'),
    organizationId: settingsRouteIdSchema,
    page: z.enum(ORGANIZATION_SETTINGS_NAV_TABS),
    subtab: z.enum(ORGANIZATION_SETTINGS_SUBTABS).optional(),
    itemId: settingsRouteIdSchema.optional(),
    userId: settingsRouteIdSchema.optional(),
    digestId: settingsRouteIdSchema.optional(),
    factId: settingsRouteIdSchema.optional(),
    memoryView: z.enum(ORGANIZATION_MEMORY_VIEWS).optional(),
    invoiceId: settingsRouteIdSchema.optional(),
  })
  .superRefine((route, ctx) => {
    const reject = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (route.subtab !== undefined && route.page !== 'settings')
      reject('subtab', 'subtab is only valid on Settings');
    if (route.itemId !== undefined && route.page !== 'feed')
      reject('itemId', 'itemId is only valid on Timeline');
    if (route.userId !== undefined && route.page !== 'members')
      reject('userId', 'userId is only valid on Members');
    if (route.digestId !== undefined) {
      if (route.page === 'members') {
        if (route.userId === undefined)
          reject('digestId', 'member digests need a userId');
      } else if (route.page !== 'digests') {
        reject('digestId', 'digestId is only valid on Digests');
      }
    }
    if (route.factId !== undefined && route.page !== 'memory')
      reject('factId', 'factId is only valid on Memory');
    if (route.memoryView !== undefined && route.page !== 'memory')
      reject('memoryView', 'memoryView is only valid on Memory');
    if (
      route.factId !== undefined &&
      route.memoryView !== undefined &&
      route.memoryView !== 'facts'
    )
      reject('factId', 'fact details belong to the facts view');
    if (route.invoiceId !== undefined) {
      if (route.page !== 'settings')
        reject('invoiceId', 'invoiceId is only valid on Settings');
      else if (route.subtab !== undefined && route.subtab !== 'billing')
        reject('invoiceId', 'invoiceId is only valid on the Billing subtab');
    }
  });

export const settingsRouteSchema = z.union([
  accountRouteSchema,
  organizationsRouteSchema,
  organizationRouteSchema,
]);

export type AccountSettingsRoute = z.infer<typeof accountRouteSchema>;
export type OrganizationsSettingsRoute = z.infer<
  typeof organizationsRouteSchema
>;
export type OrganizationSettingsRoute = z.infer<typeof organizationRouteSchema>;
export type SettingsRoute = z.infer<typeof settingsRouteSchema>;

/** Validate an untrusted value as a {@link SettingsRoute}. */
export function parseSettingsRoute(value: unknown): SettingsRoute | null {
  const parsed = settingsRouteSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export { settingsRouteToPath } from './route-paths';

function decodeSegments(pathname: string): string[] | null {
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

function parseAccountSegments(rest: string[]): SettingsRoute | null {
  const [section, detail, id, ...extra] = rest;
  if (extra.length > 0) return null;
  if (section === undefined) return { scope: 'account', page: 'account' };
  switch (section) {
    case 'profile':
    case 'notifications':
    case 'integrations':
    case 'plugins':
    case 'mcp':
    case 'security':
    case 'ai-gateway':
    case 'labs':
    case 'appearance':
      return detail === undefined ? { scope: 'account', page: section } : null;
    case 'digests':
      if (id !== undefined) return null;
      return parseSettingsRoute(
        detail === undefined
          ? { scope: 'account', page: 'digests' }
          : { scope: 'account', page: 'digests', digestId: detail },
      );
    case 'billing':
      if (detail === undefined)
        return id === undefined ? { scope: 'account', page: 'billing' } : null;
      if (detail !== 'invoices' || id === undefined) return null;
      return parseSettingsRoute({
        scope: 'account',
        page: 'billing',
        invoiceId: id,
      });
    default:
      return null;
  }
}

function isOrganizationSubtab(
  value: string | null,
): value is OrganizationSettingsSubtab {
  return ORGANIZATION_SETTINGS_SUBTABS.some((subtab) => subtab === value);
}

function parseOrganizationSegments(
  organizationId: string,
  rest: string[],
  search: URLSearchParams,
): SettingsRoute | null {
  const base = { scope: 'organization', organizationId } as const;
  const [section, first, second, third, ...extra] = rest;
  if (extra.length > 0) return null;
  const noDetail = first === undefined;
  switch (section) {
    case undefined:
      return parseSettingsRoute({ ...base, page: 'feed' });
    case 'feed':
      if (second !== undefined) return null;
      return parseSettingsRoute(
        noDetail
          ? { ...base, page: 'feed' }
          : { ...base, page: 'feed', itemId: first },
      );
    case 'statistics':
    case 'projects':
      return noDetail ? parseSettingsRoute({ ...base, page: section }) : null;
    case 'teams':
      return noDetail ? parseSettingsRoute({ ...base, page: 'groups' }) : null;
    case 'digests':
      if (second !== undefined) return null;
      return parseSettingsRoute(
        noDetail
          ? { ...base, page: 'digests' }
          : { ...base, page: 'digests', digestId: first },
      );
    case 'members':
      if (noDetail) return parseSettingsRoute({ ...base, page: 'members' });
      if (second === undefined)
        return parseSettingsRoute({ ...base, page: 'members', userId: first });
      if (second !== 'digests' || third === undefined) return null;
      return parseSettingsRoute({
        ...base,
        page: 'members',
        userId: first,
        digestId: third,
      });
    case 'memory':
      if (noDetail) return parseSettingsRoute({ ...base, page: 'memory' });
      if (first === 'graph' || first === 'ops')
        return second === undefined
          ? parseSettingsRoute({ ...base, page: 'memory', memoryView: first })
          : null;
      if (first !== 'fact' || second === undefined || third !== undefined)
        return null;
      return parseSettingsRoute({ ...base, page: 'memory', factId: second });
    case 'settings': {
      if (!noDetail) return null;
      const tab = search.get('tab');
      return parseSettingsRoute(
        isOrganizationSubtab(tab)
          ? { ...base, page: 'settings', subtab: tab }
          : { ...base, page: 'settings' },
      );
    }
    case 'billing':
      if (first !== 'invoices' || second === undefined || third !== undefined)
        return null;
      return parseSettingsRoute({
        ...base,
        page: 'settings',
        subtab: 'billing',
        invoiceId: second,
      });
    default:
      return null;
  }
}

/**
 * Parse an existing web settings URL into a route. Returns `null` for paths
 * outside account and organization settings and for unknown sub-routes, so a
 * caller never marks an unrelated destination current. Only the Settings
 * `tab` query parameter is part of a route; an unknown `tab` falls back to the
 * default subtab exactly as the web page does. Other query parameters are
 * validated by the page that owns them.
 */
export function parseSettingsRoutePath(
  pathname: string,
  search: string | URLSearchParams = '',
): SettingsRoute | null {
  const segments = decodeSegments(pathname);
  if (segments === null) return null;
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  const [root, ...rest] = segments;
  if (root === 'account') return parseAccountSegments(rest);
  if (root !== 'organization') return null;
  const [organizationId, ...organizationRest] = rest;
  if (organizationId === undefined) return { scope: 'organizations' };
  if (!isSettingsRouteId(organizationId)) return null;
  return parseOrganizationSegments(organizationId, organizationRest, params);
}

/** The account rail key a route lights, or `null` outside account scope. */
export function accountSettingsNavKeyForRoute(
  route: SettingsRoute | null,
): AccountSettingsPage | null {
  return route?.scope === 'account' ? route.page : null;
}

/**
 * The organization rail tab a route lights within ONE organization, or `null`
 * for any other organization or scope. Invoice details light Settings.
 */
export function organizationSettingsNavTabForRoute(
  route: SettingsRoute | null,
  organizationId: string,
): OrganizationSettingsNavTab | null {
  return route?.scope === 'organization' &&
    route.organizationId === organizationId
    ? route.page
    : null;
}
