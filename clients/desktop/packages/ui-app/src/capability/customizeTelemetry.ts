import { useCallback, useEffect, useRef } from 'react';
import {
  pipelineFiltersActive,
  recordedErrorOf,
  type InstalledStatusFilterValue,
  type MarketplaceCatalogTabId,
  type PipelineFilterValues,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  officialMarketplaceProvider,
  sourceLabelProvider,
} from '@canopy/ui-shared/lib/unified-plugin-entry';
import { isAppErrorCode, type AppErrorCode } from '@canopy/protocol/app-errors';
import type { PluginProvider } from '@canopy/protocol/plugins';
import type { CustomizeTabModel } from './customizeSections';

/**
 * Customize discovery analytics (CAN-6806): searches, duplicate integration
 * rows, which copy of a duplicated integration the user picks, and plugin
 * installs. Shared by desktop and the Portal; each host installs its own sink
 * with {@link setCustomizeTelemetrySink} (desktop PostHog operations, web
 * Datadog RUM).
 *
 * Payloads are fixed enums, counts and positions only. Never the query text,
 * item names, publishers, marketplace ids or anything about the person.
 */

export const CUSTOMIZE_SEARCH_EVENT = 'customize:search_submit';
export const CUSTOMIZE_DUPLICATE_RESULTS_EVENT =
  'customize:duplicate_results_view';
export const CUSTOMIZE_INTEGRATION_CLICK_EVENT = 'customize:integration_click';
export const CUSTOMIZE_INSTALL_START_EVENT = 'customize:install_start';
export const CUSTOMIZE_INSTALL_END_EVENT = 'customize:install_end';

/** Where one copy of an integration comes from. */
export type CustomizeCopySource =
  | 'claude_marketplace'
  | 'codex_marketplace'
  | 'other_marketplace'
  | 'canopy_catalog'
  | 'mcp_catalog'
  | 'connector'
  | 'custom'
  | 'shared'
  | 'other';

/** The harnesses one copy runs on. */
export type CustomizeCopyHarness = 'claude' | 'codex' | 'both' | 'none';

export type CustomizeClickAction = 'open' | 'add' | 'connect';

/** Filter names only; values that could carry free text are never sent. */
export type CustomizeFilterName =
  | 'installed_status'
  | 'category'
  | 'pipeline_source'
  | 'pipeline_scope'
  | 'pipeline_trigger';

/** `unknown`: the install succeeded overall but the host reported no result for this harness. */
export type CustomizeHarnessResult =
  | 'installed'
  | 'failed'
  | 'not_targeted'
  | 'unknown';

export type CustomizeInstallKind = 'providers' | 'external';

/**
 * `unknown`: no harness failed, but at least one harness result is unknown
 * (a multi-harness install whose host reports only overall success).
 */
export type CustomizeInstallOutcome =
  | 'success'
  | 'partial'
  | 'failure'
  | 'unknown';

export interface CustomizeSearchProperties {
  readonly customize_tab: MarketplaceCatalogTabId;
  readonly query_length: number;
  readonly result_count: number;
  readonly installed_status_filter: InstalledStatusFilterValue | 'none';
  /** Sorted, comma-joined {@link CustomizeFilterName}s; empty when none. */
  readonly active_filters: string;
  readonly active_filter_count: number;
}

export interface CustomizeDuplicateResultsProperties {
  readonly customize_tab: MarketplaceCatalogTabId;
  readonly is_search_active: boolean;
  /** Distinct rows on screen. */
  readonly result_count: number;
  /** Integrations listed more than once. */
  readonly duplicate_integration_count: number;
  /** Rows belonging to those integrations. */
  readonly duplicate_row_count: number;
  readonly max_copy_count: number;
}

export interface CustomizeIntegrationClickProperties {
  readonly customize_tab: MarketplaceCatalogTabId;
  readonly click_action: CustomizeClickAction;
  readonly is_search_active: boolean;
  readonly copy_source: CustomizeCopySource;
  readonly copy_harness: CustomizeCopyHarness;
  /** Rows of this integration on screen; 1 when it is not duplicated. */
  readonly copy_count: number;
  readonly has_copies: boolean;
  /** Zero-based position of the picked row among the rows on screen. */
  readonly result_position: number;
  /** Zero-based position of the picked row among its integration's rows. */
  readonly copy_position: number;
  readonly result_count: number;
}

export interface CustomizeInstallStartProperties {
  readonly install_kind: CustomizeInstallKind;
  readonly plugin_source: CustomizeCopySource;
  /** `claude`, `codex`, `claude,codex`, or `external`. */
  readonly target_harnesses: string;
  readonly target_harness_count: number;
}

/**
 * Why an install failed: the catalog code of the error main recorded for it,
 * or `unknown` when none was (a refusal before the install ran, or a failure
 * main did not record). Never the message.
 */
export type CustomizeInstallFailureCode = AppErrorCode | 'unknown';

export interface CustomizeInstallEndProperties extends CustomizeInstallStartProperties {
  readonly install_outcome: CustomizeInstallOutcome;
  readonly claude_result: CustomizeHarnessResult;
  readonly codex_result: CustomizeHarnessResult;
  readonly duration_ms: number;
  /** Set only on an install that threw. */
  readonly failure_code?: CustomizeInstallFailureCode;
}

export type CustomizeTelemetryEvent =
  | {
      readonly name: typeof CUSTOMIZE_SEARCH_EVENT;
      readonly properties: CustomizeSearchProperties;
    }
  | {
      readonly name: typeof CUSTOMIZE_DUPLICATE_RESULTS_EVENT;
      readonly properties: CustomizeDuplicateResultsProperties;
    }
  | {
      readonly name: typeof CUSTOMIZE_INTEGRATION_CLICK_EVENT;
      readonly properties: CustomizeIntegrationClickProperties;
    }
  | {
      readonly name: typeof CUSTOMIZE_INSTALL_START_EVENT;
      readonly properties: CustomizeInstallStartProperties;
    }
  | {
      readonly name: typeof CUSTOMIZE_INSTALL_END_EVENT;
      readonly properties: CustomizeInstallEndProperties;
    };

export type CustomizeTelemetrySink = (event: CustomizeTelemetryEvent) => void;

let sink: CustomizeTelemetrySink | null = null;

/** Installs the host transport; `null` uninstalls it. */
export function setCustomizeTelemetrySink(
  next: CustomizeTelemetrySink | null,
): void {
  sink = next;
}

/** Never throws: telemetry must not break the interaction it observes. */
export function reportCustomizeTelemetry(event: CustomizeTelemetryEvent): void {
  const current = sink;
  if (current === null) return;
  try {
    current(event);
  } catch {
    // Observation only.
  }
}

// ---------------------------------------------------------------------------
// Integration identity
// ---------------------------------------------------------------------------

/**
 * The one place that decides whether two rows are the same integration: the
 * projection's `integrationKey` (CAN-6808), grouped by publisher brand and
 * MCP host. A row without one is its own integration. Only plugin and MCP
 * rows (servers, connectors) are integrations.
 */
export function customizeIntegrationKey(
  entry: UnifiedPluginEntry,
): string | undefined {
  if (entry.kind !== 'plugin' && entry.kind !== 'app') return undefined;
  return entry.integrationKey;
}

function entryMarketplaceProvider(
  entry: UnifiedPluginEntry,
): 'Claude' | 'Codex' | 'both' | undefined {
  const providers = entry.marketplaceProviders;
  if (providers && providers.includes('Claude') && providers.includes('Codex'))
    return 'both';
  if (entry.marketplaceProvider) return entry.marketplaceProvider;
  if (entry.ref.type === 'marketplace-plugin') {
    const official = officialMarketplaceProvider(entry.ref.marketplaceId);
    if (official) return official;
  }
  return sourceLabelProvider(entry.sourceLabel);
}

export function customizeCopySource(
  entry: UnifiedPluginEntry,
): CustomizeCopySource {
  if (entry.custom === true || entry.origin === 'custom') return 'custom';
  switch (entry.ref.type) {
    case 'marketplace-plugin': {
      const provider = entryMarketplaceProvider(entry);
      if (provider === 'Claude') return 'claude_marketplace';
      if (provider === 'Codex') return 'codex_marketplace';
      return 'other_marketplace';
    }
    case 'curated-plugin':
      return 'canopy_catalog';
    case 'curated-mcp':
    case 'local-mcp':
    case 'mcp-server':
      return 'mcp_catalog';
    case 'provider-connector':
      return 'connector';
    case 'public-share':
    case 'shared-plugin':
    case 'shared-skill':
    case 'shared-agent':
    case 'shared-collection':
    case 'shared-blueprint':
    case 'shared-automation':
      return 'shared';
    default:
      return 'other';
  }
}

export function customizeCopyHarness(
  entry: UnifiedPluginEntry,
): CustomizeCopyHarness {
  const provider = entryMarketplaceProvider(entry);
  if (provider === 'both') return 'both';
  if (provider === 'Claude') return 'claude';
  if (provider === 'Codex') return 'codex';
  const { claude, codex } = entry.providerSupport;
  if (claude && codex) return 'both';
  if (claude) return 'claude';
  if (codex) return 'codex';
  return 'none';
}

// ---------------------------------------------------------------------------
// Shown rows and duplicate counts
// ---------------------------------------------------------------------------

/**
 * Rows the tab draws, in display order, each entry once. Installed and
 * browse-group previews count only the rows they show.
 */
export function customizeShownRows(
  model: Pick<CustomizeTabModel, 'sections'>,
  options: { readonly browseGroupsCollapse: boolean },
): UnifiedPluginEntry[] {
  const seen = new Set<string>();
  const rows: UnifiedPluginEntry[] = [];
  const add = (entries: readonly UnifiedPluginEntry[]): void => {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      rows.push(entry);
    }
  };
  for (const section of model.sections) {
    if (section.groups) {
      for (const group of section.groups) {
        add(
          options.browseGroupsCollapse && group.previewLimit !== undefined
            ? group.entries.slice(0, group.previewLimit)
            : group.entries,
        );
      }
      continue;
    }
    add(
      section.previewLimit !== undefined
        ? section.entries.slice(0, section.previewLimit)
        : section.entries,
    );
  }
  return rows;
}

export interface CustomizeDuplicateSummary {
  /** Integration key to the ids of its rows, in display order. */
  readonly copiesByKey: ReadonlyMap<string, readonly string[]>;
  readonly duplicateIntegrationCount: number;
  readonly duplicateRowCount: number;
  readonly maxCopyCount: number;
}

export function summarizeCustomizeDuplicates(
  rows: readonly UnifiedPluginEntry[],
): CustomizeDuplicateSummary {
  const copiesByKey = new Map<string, string[]>();
  for (const entry of rows) {
    const key = customizeIntegrationKey(entry);
    if (key === undefined) continue;
    const ids = copiesByKey.get(key);
    if (ids) ids.push(entry.id);
    else copiesByKey.set(key, [entry.id]);
  }
  let duplicateIntegrationCount = 0;
  let duplicateRowCount = 0;
  let maxCopyCount = 0;
  for (const ids of copiesByKey.values()) {
    if (ids.length < 2) continue;
    duplicateIntegrationCount += 1;
    duplicateRowCount += ids.length;
    maxCopyCount = Math.max(maxCopyCount, ids.length);
  }
  return {
    copiesByKey,
    duplicateIntegrationCount,
    duplicateRowCount,
    maxCopyCount,
  };
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

export interface CustomizeFilterState {
  readonly installedStatusFilter?: InstalledStatusFilterValue;
  readonly pipelineCategory?: string | null;
  readonly pipelineFilters?: PipelineFilterValues;
}

function activeFilterNames(
  filters: CustomizeFilterState,
): CustomizeFilterName[] {
  const names: CustomizeFilterName[] = [];
  if (filters.pipelineCategory?.trim()) names.push('category');
  if (filters.installedStatusFilter !== undefined)
    names.push('installed_status');
  const pipeline = filters.pipelineFilters;
  if (pipeline && pipelineFiltersActive(pipeline)) {
    if (pipeline.scope !== 'all') names.push('pipeline_scope');
    if (pipeline.source !== 'all') names.push('pipeline_source');
    if (pipeline.trigger !== 'all') names.push('pipeline_trigger');
  }
  return names.sort();
}

/** A stable in-memory key for one filter state; never sent. */
export function customizeFilterStateKey(filters: CustomizeFilterState): string {
  return JSON.stringify([
    filters.installedStatusFilter ?? null,
    filters.pipelineCategory?.trim().toLowerCase() ?? null,
    filters.pipelineFilters ?? null,
  ]);
}

export function buildCustomizeSearchEvent(input: {
  readonly tab: MarketplaceCatalogTabId;
  readonly query: string;
  readonly resultCount: number;
  readonly filters: CustomizeFilterState;
}): CustomizeTelemetryEvent {
  const names = activeFilterNames(input.filters);
  return {
    name: CUSTOMIZE_SEARCH_EVENT,
    properties: {
      customize_tab: input.tab,
      query_length: input.query.trim().length,
      result_count: input.resultCount,
      installed_status_filter: input.filters.installedStatusFilter ?? 'none',
      active_filters: names.join(','),
      active_filter_count: names.length,
    },
  };
}

export function buildCustomizeDuplicateResultsEvent(input: {
  readonly tab: MarketplaceCatalogTabId;
  readonly searchActive: boolean;
  readonly rows: readonly UnifiedPluginEntry[];
}): CustomizeTelemetryEvent | undefined {
  const summary = summarizeCustomizeDuplicates(input.rows);
  if (summary.duplicateIntegrationCount === 0) return undefined;
  return {
    name: CUSTOMIZE_DUPLICATE_RESULTS_EVENT,
    properties: {
      customize_tab: input.tab,
      is_search_active: input.searchActive,
      result_count: input.rows.length,
      duplicate_integration_count: summary.duplicateIntegrationCount,
      duplicate_row_count: summary.duplicateRowCount,
      max_copy_count: summary.maxCopyCount,
    },
  };
}

/**
 * One event per integration pick, duplicated or not, so the duplicate-click
 * rate has its denominator. `undefined` for non-integrations and rows that
 * are not on screen.
 */
export function buildCustomizeIntegrationClickEvent(input: {
  readonly tab: MarketplaceCatalogTabId;
  readonly searchActive: boolean;
  readonly rows: readonly UnifiedPluginEntry[];
  readonly entry: UnifiedPluginEntry;
  readonly action: CustomizeClickAction;
}): CustomizeTelemetryEvent | undefined {
  const key = customizeIntegrationKey(input.entry);
  if (key === undefined) return undefined;
  const position = input.rows.findIndex((row) => row.id === input.entry.id);
  if (position < 0) return undefined;
  const copies = summarizeCustomizeDuplicates(input.rows).copiesByKey.get(
    key,
  ) ?? [input.entry.id];
  return {
    name: CUSTOMIZE_INTEGRATION_CLICK_EVENT,
    properties: {
      customize_tab: input.tab,
      click_action: input.action,
      is_search_active: input.searchActive,
      copy_source: customizeCopySource(input.entry),
      copy_harness: customizeCopyHarness(input.entry),
      copy_count: copies.length,
      has_copies: copies.length > 1,
      result_position: position,
      copy_position: Math.max(0, copies.indexOf(input.entry.id)),
      result_count: input.rows.length,
    },
  };
}

/** The plugin facts install events read; no name or marketplace id is sent. */
export interface CustomizeInstallPlugin {
  readonly marketplaceId: string;
  readonly builtIn?: boolean;
  readonly curated?: boolean;
}

function installPluginSource(
  plugin: CustomizeInstallPlugin,
): CustomizeCopySource {
  if (plugin.curated === true) return 'canopy_catalog';
  const provider = officialMarketplaceProvider(plugin.marketplaceId);
  if (provider === 'Claude') return 'claude_marketplace';
  if (provider === 'Codex') return 'codex_marketplace';
  return 'other_marketplace';
}

export type CustomizeInstallRequest =
  | { readonly kind: 'external' }
  | {
      readonly kind: 'providers';
      readonly providers: readonly PluginProvider[];
    };

export function buildCustomizeInstallStartEvent(
  plugin: CustomizeInstallPlugin,
  request: CustomizeInstallRequest,
): CustomizeTelemetryEvent {
  return {
    name: CUSTOMIZE_INSTALL_START_EVENT,
    properties: installStartProperties(plugin, request),
  };
}

function installStartProperties(
  plugin: CustomizeInstallPlugin,
  request: CustomizeInstallRequest,
): CustomizeInstallStartProperties {
  const targets =
    request.kind === 'external'
      ? ['external']
      : [...new Set(request.providers)].sort();
  return {
    install_kind: request.kind,
    plugin_source: installPluginSource(plugin),
    target_harnesses: targets.join(','),
    target_harness_count: request.kind === 'external' ? 0 : targets.length,
  };
}

/**
 * `outcomes` holds the per-harness results the host reported. A thrown or
 * rejected install passes `failed: true`: every targeted harness failed.
 * Without a harness's outcome, a successful single-harness install implies it
 * installed; with several targets it is `unknown`, never assumed installed.
 */
export function buildCustomizeInstallEndEvent(input: {
  readonly plugin: CustomizeInstallPlugin;
  readonly request: CustomizeInstallRequest;
  readonly outcomes?: Partial<
    Record<PluginProvider, { readonly installed: boolean }>
  >;
  readonly failed?: boolean;
  readonly failureCode?: CustomizeInstallFailureCode;
  readonly durationMs: number;
}): CustomizeTelemetryEvent {
  const targeted = (provider: PluginProvider): boolean =>
    input.request.kind === 'providers' &&
    input.request.providers.includes(provider);
  const targetCount =
    input.request.kind === 'providers'
      ? new Set(input.request.providers).size
      : 0;
  const result = (provider: PluginProvider): CustomizeHarnessResult => {
    if (!targeted(provider)) return 'not_targeted';
    if (input.failed === true) return 'failed';
    const outcome = input.outcomes?.[provider];
    if (outcome) return outcome.installed ? 'installed' : 'failed';
    return targetCount === 1 ? 'installed' : 'unknown';
  };
  const claude = result('claude');
  const codex = result('codex');
  const results = [claude, codex].filter((value) => value !== 'not_targeted');
  const failures = results.filter((value) => value === 'failed').length;
  const outcome: CustomizeInstallOutcome =
    input.failed === true || (results.length > 0 && failures === results.length)
      ? 'failure'
      : failures > 0
        ? 'partial'
        : results.includes('unknown')
          ? 'unknown'
          : 'success';
  return {
    name: CUSTOMIZE_INSTALL_END_EVENT,
    properties: {
      ...installStartProperties(input.plugin, input.request),
      install_outcome: outcome,
      claude_result: claude,
      codex_result: codex,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      ...(input.failureCode === undefined
        ? {}
        : { failure_code: input.failureCode }),
    },
  };
}

function installFailureCode(error: unknown): CustomizeInstallFailureCode {
  const code = recordedErrorOf(error)?.code;
  return code !== undefined && isAppErrorCode(code) ? code : 'unknown';
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** How long results must hold still before a search counts as run. */
export const CUSTOMIZE_RESULTS_SETTLE_MS = 1000;
const MAX_REPORTED_STATES = 200;

export interface CustomizeResultsTelemetryInput {
  readonly tab: MarketplaceCatalogTabId;
  readonly query: string;
  readonly filters: CustomizeFilterState;
  readonly model: Pick<CustomizeTabModel, 'sections' | 'resultCount'>;
  readonly loading: boolean;
  readonly browseGroupsCollapse: boolean;
}

export interface CustomizeResultsTelemetry {
  /** Wraps a row handler so a pick reports which copy was chosen. */
  readonly trackPick: (
    entry: UnifiedPluginEntry,
    action: CustomizeClickAction,
  ) => void;
}

/**
 * Reports a search once its results settle, and a duplicate-results view once
 * per tab/query/filter state per mount. Picks read the rows on screen now.
 */
export function useCustomizeResultsTelemetry(
  input: CustomizeResultsTelemetryInput,
): CustomizeResultsTelemetry {
  const latest = useRef(input);
  latest.current = input;
  const reported = useRef(new Set<string>());
  const query = input.query.trim();
  const stateKey = JSON.stringify([
    input.tab,
    query,
    customizeFilterStateKey(input.filters),
  ]);

  useEffect(() => {
    if (input.loading) return undefined;
    const timer = setTimeout(() => {
      const current = latest.current;
      const currentQuery = current.query.trim();
      const searchActive = currentQuery !== '';
      const seen = reported.current;
      if (seen.size > MAX_REPORTED_STATES) seen.clear();
      if (searchActive && !seen.has(`search|${stateKey}`)) {
        seen.add(`search|${stateKey}`);
        reportCustomizeTelemetry(
          buildCustomizeSearchEvent({
            tab: current.tab,
            query: currentQuery,
            resultCount: current.model.resultCount,
            filters: current.filters,
          }),
        );
      }
      if (!seen.has(`duplicates|${stateKey}`)) {
        const event = buildCustomizeDuplicateResultsEvent({
          tab: current.tab,
          searchActive,
          rows: customizeShownRows(current.model, {
            browseGroupsCollapse: current.browseGroupsCollapse,
          }),
        });
        if (event) {
          seen.add(`duplicates|${stateKey}`);
          reportCustomizeTelemetry(event);
        }
      }
    }, CUSTOMIZE_RESULTS_SETTLE_MS);
    return (): void => clearTimeout(timer);
  }, [stateKey, input.loading, input.model]);

  const trackPick = useCallback(
    (entry: UnifiedPluginEntry, action: CustomizeClickAction): void => {
      try {
        const current = latest.current;
        const event = buildCustomizeIntegrationClickEvent({
          tab: current.tab,
          searchActive: current.query.trim() !== '',
          rows: customizeShownRows(current.model, {
            browseGroupsCollapse: current.browseGroupsCollapse,
          }),
          entry,
          action,
        });
        if (event) reportCustomizeTelemetry(event);
      } catch {
        // Observation only.
      }
    },
    [],
  );
  return { trackPick };
}

/**
 * Wraps a host install so it reports start and end. The wrapped call's
 * result and errors pass through unchanged.
 */
export async function trackCustomizeInstall<T>(
  plugin: CustomizeInstallPlugin,
  request: CustomizeInstallRequest,
  run: () => Promise<T>,
  outcomesOf: (
    result: T,
  ) =>
    | Partial<Record<PluginProvider, { readonly installed: boolean }>>
    | undefined,
): Promise<T> {
  const startedAt = Date.now();
  reportCustomizeTelemetry(buildCustomizeInstallStartEvent(plugin, request));
  try {
    const result = await run();
    let outcomes: ReturnType<typeof outcomesOf>;
    try {
      outcomes = outcomesOf(result);
    } catch {
      outcomes = undefined;
    }
    reportCustomizeTelemetry(
      buildCustomizeInstallEndEvent({
        plugin,
        request,
        outcomes,
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
  } catch (error) {
    reportCustomizeTelemetry(
      buildCustomizeInstallEndEvent({
        plugin,
        request,
        failed: true,
        failureCode: installFailureCode(error),
        durationMs: Date.now() - startedAt,
      }),
    );
    throw error;
  }
}
