import {
  ORGANIZATION_SETTINGS_NAV_TABS,
  ORGANIZATION_SETTINGS_SUBTABS,
  settingsBootstrapHasOrganization,
  settingsRouteToPath,
  type OrganizationSettingsNavModel,
  type OrganizationSettingsNavTab,
  type OrganizationSettingsSubtab,
  type SettingsBootstrap,
  type SettingsNavModel,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  selectSettingsNavRow,
  settingsNavModelFromBootstrap,
  type SettingsNavGroup,
} from '@canopy/ui-app/settings/navigation';
import {
  hostedSettingsLocation,
  type HostedSettingsLocation,
} from './hosted-settings-location';

/**
 * The rail before a bootstrap is known (signed out, loading, or a server
 * without hosted settings): the always-available Account pages and the
 * Organizations list, no flag-gated rows and no organization group.
 * Integrations is always listed on desktop: it carries this computer's
 * GitHub sign-in and Linear key whatever the server's Cloud Git gate says.
 */
export const SIGNED_OUT_SETTINGS_NAV_MODEL: SettingsNavModel = {
  account: {
    billingEnabled: false,
    digestsEnabled: false,
    integrationsEnabled: true,
    freeAccess: false,
  },
  adminVisible: false,
  organization: null,
};

/**
 * The desktop rail model. The organization group appears only for the
 * organization the viewer explicitly browses (a pick from the Organizations
 * list or a validated deep link), never from the workspace context or
 * membership order. Integrations is always listed (see
 * {@link SIGNED_OUT_SETTINGS_NAV_MODEL}); its page shows only the device
 * rows when the server reports it disabled.
 *
 * Before the bootstrap is known the rail draws `fallback` (see
 * {@link hostedSettingsNavFallback}). While only the account bootstrap is
 * known, the browsed organization's rows come from the fallback when it has
 * them, so the group does not appear late.
 */
export function hostedSettingsNavModel(
  bootstrap: SettingsBootstrap | null,
  browsedOrganizationId: string | null,
  fallback: SettingsNavModel = SIGNED_OUT_SETTINGS_NAV_MODEL,
): SettingsNavModel {
  if (bootstrap === null) return fallback;
  const model = settingsNavModelFromBootstrap(bootstrap, browsedOrganizationId);
  const organization =
    model.organization === null &&
    browsedOrganizationId !== null &&
    fallback.organization?.id === browsedOrganizationId
      ? fallback.organization
      : model.organization;
  return {
    ...model,
    account: { ...model.account, integrationsEnabled: true },
    organization,
  };
}

/** Renderer `localStorage` key prefix of {@link PersistedSettingsNavModel}. */
export const SETTINGS_NAV_MODEL_STORAGE_PREFIX = 'canopy:settings:nav-model:';

/**
 * Renderer `localStorage` key naming the account whose rail entry was written
 * last, so Settings opened before the account is read draws that entry.
 */
export const SETTINGS_NAV_MODEL_ACCOUNT_STORAGE_KEY =
  'canopy:settings:nav-model-account';

/**
 * What the rail needs from a bootstrap, remembered per account in renderer
 * `localStorage` under `canopy:settings:nav-model:<accountId>`, so a later
 * Settings open (even after a restart) draws the rows the bootstrap will
 * confirm. Booleans and tab ids only: no names or other account data.
 */
export interface PersistedSettingsNavModel {
  /** The account the entry describes; an entry for another is ignored. */
  readonly accountId: string;
  readonly account: {
    readonly billingEnabled: boolean;
    readonly digestsEnabled: boolean;
    readonly freeAccess: boolean;
  };
  /** Keyed by organization id. */
  readonly organizations: Readonly<
    Record<string, PersistedOrganizationSettingsNav>
  >;
}

export interface PersistedOrganizationSettingsNav {
  readonly visibleTabs: readonly OrganizationSettingsNavTab[];
  readonly disabledTabs: readonly OrganizationSettingsNavTab[];
  readonly billingNeedsAttention: boolean;
  /**
   * The Settings pages the viewer got, so the rail draws them as rows before
   * the bootstrap confirms. Absent in entries written before they were rows.
   */
  readonly settingsSubtabs?: readonly OrganizationSettingsSubtab[];
}

/** The rail-relevant feature flags from the renderer's flag snapshot. */
export interface SettingsNavFlagSnapshot {
  readonly billingEnabled: boolean;
  readonly digestsEnabled: boolean;
  readonly freeAccess: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrganizationNavTab(
  value: unknown,
): value is OrganizationSettingsNavTab {
  return ORGANIZATION_SETTINGS_NAV_TABS.some((tab) => tab === value);
}

/** Known tab ids from a persisted list; unknown ids are dropped. */
function parseTabs(value: unknown): OrganizationSettingsNavTab[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isOrganizationNavTab);
}

function isOrganizationSettingsSubtab(
  value: unknown,
): value is OrganizationSettingsSubtab {
  return ORGANIZATION_SETTINGS_SUBTABS.some((subtab) => subtab === value);
}

function parsePersistedOrganization(
  value: unknown,
): PersistedOrganizationSettingsNav | null {
  if (!isRecord(value)) return null;
  const visibleTabs = parseTabs(value.visibleTabs);
  const disabledTabs = parseTabs(value.disabledTabs);
  if (visibleTabs === null || disabledTabs === null) return null;
  const settingsSubtabs = Array.isArray(value.settingsSubtabs)
    ? value.settingsSubtabs.filter(isOrganizationSettingsSubtab)
    : undefined;
  return {
    visibleTabs,
    disabledTabs,
    billingNeedsAttention: value.billingNeedsAttention === true,
    ...(settingsSubtabs === undefined ? {} : { settingsSubtabs }),
  };
}

/**
 * The persisted rail entry for an account, or `null` when it is missing,
 * unparseable, malformed, or written for another account. Unknown tab ids and
 * malformed organizations are dropped.
 */
export function parsePersistedSettingsNavModel(
  raw: string | null,
  accountId: string,
): PersistedSettingsNavModel | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.accountId !== accountId) return null;
  const account = value.account;
  if (
    !isRecord(account) ||
    typeof account.billingEnabled !== 'boolean' ||
    typeof account.digestsEnabled !== 'boolean' ||
    typeof account.freeAccess !== 'boolean'
  )
    return null;
  const organizations: Record<string, PersistedOrganizationSettingsNav> = {};
  if (isRecord(value.organizations)) {
    for (const [id, entry] of Object.entries(value.organizations)) {
      const organization = parsePersistedOrganization(entry);
      if (id !== '' && organization !== null) organizations[id] = organization;
    }
  }
  return {
    accountId,
    account: {
      billingEnabled: account.billingEnabled,
      digestsEnabled: account.digestsEnabled,
      freeAccess: account.freeAccess,
    },
    organizations,
  };
}

/**
 * The persisted entry after a bootstrap arrives: the account flags it
 * reports, the organization it was requested for, and the earlier
 * organizations it still lists (the rest are dropped).
 */
export function persistedSettingsNavModelFrom(
  accountId: string,
  bootstrap: SettingsBootstrap,
  previous: PersistedSettingsNavModel | null,
): PersistedSettingsNavModel {
  const organizations: Record<string, PersistedOrganizationSettingsNav> = {};
  for (const [id, organization] of Object.entries(
    previous?.organizations ?? {},
  )) {
    if (settingsBootstrapHasOrganization(bootstrap, id))
      organizations[id] = organization;
  }
  const requested = bootstrap.organization;
  if (requested !== null)
    organizations[requested.id] = {
      visibleTabs: requested.visibleTabs.filter(isOrganizationNavTab),
      disabledTabs: requested.disabledTabs.filter(isOrganizationNavTab),
      billingNeedsAttention: requested.billingNeedsAttention,
      settingsSubtabs:
        settingsNavModelFromBootstrap(bootstrap, requested.id).organization
          ?.settingsSubtabs ?? [],
    };
  return {
    accountId,
    account: {
      billingEnabled: bootstrap.account.billingEnabled,
      digestsEnabled: bootstrap.account.digestsEnabled,
      freeAccess: bootstrap.account.freeAccess,
    },
    organizations,
  };
}

/**
 * The browsed organization's group label before its bootstrap names it: a
 * non-breaking space keeps the label's line, so the rows under it do not
 * move when the name arrives.
 */
const UNNAMED_ORGANIZATION_LABEL = '\u00a0';

export interface HostedSettingsNavFallbackSource {
  /** The account's persisted entry, when one was read. */
  readonly persisted: PersistedSettingsNavModel | null;
  /** Used for the account flags when nothing is persisted. */
  readonly flags: SettingsNavFlagSnapshot;
  readonly browsedOrganizationId: string | null;
  /** The browsed organization's name when a known bootstrap lists it. */
  readonly organizationName: string | null;
}

/**
 * The rail before a bootstrap is known, for a signed-in account: the
 * persisted entry when there is one, otherwise the flag snapshot; and the
 * browsed organization's group when the entry has its tabs.
 */
export function hostedSettingsNavFallback({
  persisted,
  flags,
  browsedOrganizationId,
  organizationName,
}: HostedSettingsNavFallbackSource): SettingsNavModel {
  const account = persisted?.account ?? flags;
  const remembered =
    browsedOrganizationId === null
      ? undefined
      : persisted?.organizations[browsedOrganizationId];
  const organization: OrganizationSettingsNavModel | null =
    browsedOrganizationId === null || remembered === undefined
      ? null
      : {
          id: browsedOrganizationId,
          name: organizationName ?? UNNAMED_ORGANIZATION_LABEL,
          visibleTabs: [...remembered.visibleTabs],
          disabledTabs: [...remembered.disabledTabs],
          billingNeedsAttention: remembered.billingNeedsAttention,
          ...(remembered.settingsSubtabs === undefined
            ? {}
            : { settingsSubtabs: [...remembered.settingsSubtabs] }),
        };
  return {
    account: {
      billingEnabled: account.billingEnabled,
      digestsEnabled: account.digestsEnabled,
      integrationsEnabled: true,
      freeAccess: account.freeAccess,
    },
    adminVisible: false,
    organization,
  };
}

/** The organization a route browses, or `null` outside organization scope. */
export function hostedSettingsOrganizationId(
  route: SettingsRoute,
): string | null {
  return route.scope === 'organization' ? route.organizationId : null;
}

/**
 * The one hosted rail row current for a route, or `null`. An organization
 * route selects a row only in the group of the organization it names.
 */
export function selectHostedSettingsRow(
  groups: readonly SettingsNavGroup<string>[],
  route: SettingsRoute | null,
  browsedOrganizationId: string | null,
): string | null {
  if (route === null) return null;
  if (
    route.scope === 'organization' &&
    route.organizationId !== browsedOrganizationId
  )
    return null;
  return selectSettingsNavRow(
    groups,
    settingsRouteToPath(route),
    hostedSettingsOrganizationId(route),
  );
}

/**
 * Where a hosted destination must go instead, once its organization's
 * bootstrap is known, or `null` when it can render:
 *
 * - an organization absent from the viewer's membership opens the
 *   Organizations list with the access-lost notice, except the viewer's
 *   Personal organization, whose bootstrap the server returns only to them;
 * - a tab the destination's nav model hides (role, flag, Personal) opens the
 *   organization's Feed (or its first visible tab), so switching
 *   organizations keeps the current tab only where the destination offers it.
 *
 * Disabled (lapsed) tabs stay: their pages render the lapsed state.
 */
export function hostedSettingsRedirect(
  location: HostedSettingsLocation,
  bootstrap: SettingsBootstrap,
): HostedSettingsLocation | null {
  const route = location.route;
  if (route.scope !== 'organization') return null;
  const organization = bootstrap.organization;
  if (
    organization === null ||
    organization.id !== route.organizationId ||
    // The server leaves the Personal organization out of the membership list
    // but returns its bootstrap only to its owner, so that bootstrap is the
    // membership check for it.
    (!organization.isPersonal &&
      !settingsBootstrapHasOrganization(bootstrap, route.organizationId))
  )
    return hostedSettingsLocation(
      { scope: 'organizations' },
      { notice: 'access-lost' },
    );
  if (organization.visibleTabs.includes(route.page)) return null;
  const fallback = organization.visibleTabs.includes('feed')
    ? 'feed'
    : organization.visibleTabs[0];
  if (fallback === undefined) return null;
  return hostedSettingsLocation({
    scope: 'organization',
    organizationId: route.organizationId,
    page: fallback,
  });
}
