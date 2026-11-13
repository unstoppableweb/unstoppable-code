import type { InstalledStatusFilterValue } from './installed-item-status';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL } from '@canopy/protocol/workspace-templates';
import { WORKFLOW_ITEM_LABEL_PLURAL } from './workflow-labels';

/** The kind a non-`all` Marketplace type tab narrows the browse list to. */
export type MarketplaceKindFilter =
  | 'plugin'
  | 'app'
  | 'skill'
  | 'pipeline'
  | 'automation'
  | 'collection'
  | 'agent'
  | 'blueprint';

/** One Marketplace type tab: every browsable kind, plus the unfiltered view. */
export type MarketplaceTypeTabId =
  | 'all'
  | 'workflow'
  | 'sources'
  | Exclude<MarketplaceKindFilter, 'pipeline' | 'automation'>;
export type MarketplaceCatalogTabId = Exclude<MarketplaceTypeTabId, 'sources'>;

export interface MarketplaceBrowseNavigation {
  readonly tab: MarketplaceTypeTabId;
  readonly query: string;
  readonly category?: string;
  readonly focusSection?: 'installed' | 'shared-by-me';
  readonly installedStatusFilter?: InstalledStatusFilterValue;
  readonly installedExpanded?: boolean;
}

/** Compatibility inputs terminate here; new destinations describe Customize. */
export function marketplaceManagementDestination(
  section: unknown = 'installed',
  statusFilter?: InstalledStatusFilterValue,
): MarketplaceBrowseNavigation {
  const tab: MarketplaceTypeTabId =
    section === 'marketplaces' || section === 'marketplace'
      ? 'sources'
      : section === 'skills'
        ? 'skill'
        : section === 'mcp'
          ? 'app'
          : section === 'collections' || section === 'bundles'
            ? 'collection'
            : 'all';
  return {
    tab,
    query: '',
    ...(tab !== 'sources'
      ? {
          focusSection: 'installed' as const,
          installedExpanded: true,
          ...(statusFilter ? { installedStatusFilter: statusFilter } : {}),
        }
      : {}),
  };
}

/** Which optional kinds a host's Marketplace lists. */
export interface MarketplaceTypeTabOptions {
  /** Shared agents, behind the Agents rollout flag. */
  readonly agents?: boolean;
  /** Shared project templates. */
  readonly projectTemplates?: boolean;
  /** Marketplace-source management, gated by the host capability. */
  readonly sources?: boolean;
}

/**
 * The type tab that lists a catalog entry's kind, or `null` for a kind with
 * no type tab.
 */
export function marketplaceKindFilterForEntryKind(
  kind: UnifiedEntryKind,
): MarketplaceKindFilter | null {
  switch (kind) {
    case 'plugin':
    case 'app':
    case 'skill':
    case 'pipeline':
    case 'automation':
    case 'collection':
    case 'agent':
    case 'blueprint':
      return kind;
    default:
      return null;
  }
}

/**
 * The plural entity-type name a Marketplace breadcrumb shows before an entry's
 * title. Kinds with a type tab reuse that tab's label so the breadcrumb and the
 * list it leads to are named the same.
 */
export function marketplaceEntityTypeLabel(kind: UnifiedEntryKind): string {
  const tab = marketplaceTabForKind(kind);
  return (
    MARKETPLACE_TYPE_TABS.find((candidate) => candidate.id === tab)?.label ??
    kind
  );
}

export interface MarketplaceTypeTab {
  readonly id: MarketplaceTypeTabId;
  readonly label: string;
}

export const MARKETPLACE_TYPE_TABS: readonly MarketplaceTypeTab[] = [
  { id: 'all', label: 'All' },
  { id: 'plugin', label: 'Plugins' },
  { id: 'app', label: 'MCP servers' },
  { id: 'skill', label: 'Skills' },
  { id: 'workflow', label: WORKFLOW_ITEM_LABEL_PLURAL },
  { id: 'collection', label: 'Collections' },
  { id: 'agent', label: 'Agents' },
  { id: 'blueprint', label: WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL },
  { id: 'sources', label: 'Marketplaces' },
];

export function marketplaceTypeTabs(
  options: MarketplaceTypeTabOptions = {},
): readonly MarketplaceTypeTab[] {
  return MARKETPLACE_TYPE_TABS.filter((tab) =>
    tab.id === 'agent'
      ? options.agents === true
      : tab.id === 'blueprint'
        ? options.projectTemplates === true
        : tab.id === 'sources'
          ? options.sources === true
          : true,
  );
}

export function marketplaceTabKinds(
  tab: MarketplaceTypeTabId,
): readonly MarketplaceKindFilter[] {
  if (tab === 'sources') return [];
  if (tab === 'all')
    return [
      'plugin',
      'app',
      'skill',
      'pipeline',
      'automation',
      'collection',
      'agent',
      'blueprint',
    ];
  return tab === 'workflow' ? ['pipeline', 'automation'] : [tab];
}

export function marketplaceTabForKind(
  kind: UnifiedEntryKind,
): MarketplaceTypeTabId | null {
  if (kind === 'pipeline' || kind === 'automation') return 'workflow';
  return MARKETPLACE_TYPE_TABS.find((tab) => tab.id === kind)?.id ?? null;
}

export function marketplaceEntryInTab(
  entry: { readonly kind: UnifiedEntryKind },
  tab: MarketplaceTypeTabId,
): boolean {
  return marketplaceTabKinds(tab).some((kind) => kind === entry.kind);
}

/** Normalize only at persisted/external navigation boundaries. */
export function normalizeMarketplaceNavigation(
  tab: string,
  ownership?: unknown,
): {
  tab: MarketplaceTypeTabId;
  focusSection?: 'installed' | 'shared-by-me';
} {
  const normalized =
    tab === 'pipeline' || tab === 'automation' ? 'workflow' : tab;
  const target =
    MARKETPLACE_TYPE_TABS.find((candidate) => candidate.id === normalized)
      ?.id ?? 'all';
  return {
    tab: target,
    ...(ownership === 'installed' && target !== 'sources'
      ? { focusSection: 'installed' as const }
      : {}),
    ...(ownership === 'shared-by-me' && target === 'workflow'
      ? { focusSection: 'shared-by-me' as const }
      : {}),
  };
}

/** Sources has its own page body and never participates in catalog sections. */
export function isMarketplaceSourcesTab(
  tab: MarketplaceTypeTabId,
): tab is 'sources' {
  return tab === 'sources';
}
