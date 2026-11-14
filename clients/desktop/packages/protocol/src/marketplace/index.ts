import { isUuid } from '../uuid';

/** Public web destinations. Activated by share helpers after route integration. */
export const MARKETPLACE_PUBLIC_PATH = '/portal/plugins/marketplace';

/**
 * The web page for one of the account's MCP servers, where it connects and
 * signs in. Account keys belong to the account panel, never the
 * paired-desktop route.
 */
export function accountMcpSettingsPath(
  serverKey: string,
  configId: string,
): string {
  const params = new URLSearchParams({
    mcpServer: serverKey,
    mcpConfig: configId,
  });
  return `${MARKETPLACE_PUBLIC_PATH}?${params.toString()}`;
}
export const MARKETPLACE_PUBLIC_SHARE_PREFIXES = {
  skill: '/portal/plugins/skills/shared',
  plugin: '/portal/plugins/plugins/shared',
  pipeline: '/portal/plugins/pipelines/shared',
  collection: '/portal/plugins/collections/shared',
  agent: '/portal/plugins/agents',
  automation: '/portal/plugins/automations',
  blueprint: '/portal/plugins/project-templates',
} as const;

/** Stable old paths for redirects and attribution after canonical links switch. */
export const LEGACY_PUBLIC_SKILL_SHARE_PATH_PREFIX = '/share/skills';
export const LEGACY_PUBLIC_PLUGIN_SHARE_PATH_PREFIX = '/share/plugins';
export const LEGACY_PUBLIC_PIPELINE_SHARE_PATH_PREFIX = '/share/pipelines';
export const LEGACY_PUBLIC_COLLECTION_SHARE_PATH_PREFIX = '/share/collections';
export const LEGACY_PUBLIC_AGENT_SHARE_PATH_PREFIX = '/share/agents';
export const LEGACY_PUBLIC_AUTOMATION_SHARE_PATH_PREFIX = '/share/automations';
export const LEGACY_PUBLIC_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX =
  '/share/project-templates';

/** Item links, independent of the stored audience; blueprints retain their own contract. */
export const MARKETPLACE_SHARE_LINK_KINDS = [
  'skill',
  'plugin',
  'pipeline',
  'collection',
  'agent',
  'automation',
] as const;
export type MarketplaceShareLinkKind =
  (typeof MARKETPLACE_SHARE_LINK_KINDS)[number];
export function isMarketplaceShareLinkKind(
  value: unknown,
): value is MarketplaceShareLinkKind {
  return MARKETPLACE_SHARE_LINK_KINDS.some((kind) => kind === value);
}

/** Invalid item identifiers are programmer errors, including in the URL helper. */
export function marketplaceShareLinkPath(
  kind: MarketplaceShareLinkKind,
  itemExternalId: string,
): string {
  if (!isUuid(itemExternalId)) throw new Error('Invalid Marketplace item UUID');
  return `${MARKETPLACE_PUBLIC_SHARE_PREFIXES[kind]}/${itemExternalId.toLowerCase()}`;
}

/** Strict origin contract; do not let URL parsing silently discard paths or credentials. */
export function marketplaceShareOrigin(origin: string): string | null {
  if (!/^https?:\/\/[^/?#@\\\s]+\/*$/.test(origin)) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password) return null;
    const local =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function marketplaceShareLinkUrl(
  origin: string,
  kind: MarketplaceShareLinkKind,
  itemExternalId: string,
): string | null {
  const path = marketplaceShareLinkPath(kind, itemExternalId);
  const normalized = marketplaceShareOrigin(origin);
  return normalized === null ? null : `${normalized}${path}`;
}

/** Validate host-supplied browser links without reconstructing them on another host. */
export function isMarketplaceBrowserLink(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    /[\s\\]/.test(value) ||
    !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      marketplaceShareOrigin(url.origin) !== null
    );
  } catch {
    return false;
  }
}

/** Snapshot update time only; absence or invalid dates do not invent a version. */
export function marketplacePublicLinkPinnedAt(
  value: unknown,
): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
