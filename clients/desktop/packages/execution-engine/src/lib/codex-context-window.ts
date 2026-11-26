/**
 * Pure, browser-safe Codex context window resolution shared by desktop main
 * (thread config) and the renderer (settings and the usage popover).
 *
 * Codex accepts `model_context_window` only when a thread starts, resumes or
 * forks, and lowers it to the catalog's `max_context_window` itself. It
 * reports 95% of the window as usable (`effective_context_window_percent`)
 * and auto-compacts at 90% of the window, so the compaction point moves with
 * the setting. Bounds come from the Codex catalog the speed system already
 * reads per route: the native one, and for the account proxy also the
 * proxy's own list, because Codex clamps against the native catalog.
 */
import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
} from '../types/codex-speed-capabilities';
import {
  isCodexSpeedRouteCatalogBacked,
  matchCodexSpeedCatalogModel,
  type CodexSpeedRouteFacts,
} from './codex-speed-availability';
import type { CodexContextWindowSetting } from '@canopy/protocol/agent-model-config';

export type { CodexContextWindowSetting } from '@canopy/protocol/agent-model-config';

/** The smallest custom window Canopy sends. Codex itself sets none. */
export const CODEX_CONTEXT_WINDOW_FLOOR = 128_000;

/**
 * Requests with more input than this are billed at OpenAI's long-context
 * rates (2× input and cached input, 1.5× output).
 * shortcut: one threshold and multiplier for every Codex model, matching the
 * pricing payload today; read its `longContext` rule per model if they vary.
 */
export const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;

/** Codex compacts at this share of the configured window. */
const CODEX_AUTO_COMPACT_PERCENT = 90;
/** Codex's default `effective_context_window_percent`. */
const CODEX_DEFAULT_USABLE_PERCENT = 95;

export function isCodexContextWindowSetting(
  value: unknown,
): value is CodexContextWindowSetting {
  return (
    value === 'model-default' ||
    value === 'standard-pricing' ||
    value === 'maximum' ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= CODEX_CONTEXT_WINDOW_FLOOR)
  );
}

export interface CodexContextWindowBounds {
  /** The window Codex uses when Canopy sends no override. */
  defaultTokens: number;
  /** The largest window Codex accepts for this model on this route. */
  maxTokens: number;
  /** A catalog's fixed compaction limit, which a raised window must match. */
  autoCompactTokenLimit?: number;
  /** The share of the window Codex reports as usable. */
  usablePercent: number;
}

export type CodexContextWindowSupport =
  | { kind: 'adjustable'; bounds: CodexContextWindowBounds }
  | { kind: 'fixed'; bounds: CodexContextWindowBounds }
  | {
      kind: 'unavailable';
      /** `route`: AI Credits, a gateway, Ollama and other non-Codex routes. */
      reason: 'route' | 'catalog' | 'model';
    };

function match(
  models: CodexSpeedCatalogModel[],
  route: CodexSpeedRouteFacts,
): CodexSpeedCatalogModel | undefined {
  const candidates = [
    route.runtimeModel,
    ...(route.equivalentModels ?? []),
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  const found = matchCodexSpeedCatalogModel({ models }, candidates);
  return found.kind === 'match' ? found.model : undefined;
}

/** What this chat's model and route allow. */
export function resolveCodexContextWindowSupport(
  catalog: CodexSpeedCatalog | null,
  route: CodexSpeedRouteFacts,
): CodexContextWindowSupport {
  if (!isCodexSpeedRouteCatalogBacked(route)) {
    return { kind: 'unavailable', reason: 'route' };
  }
  if (!catalog || catalog.status !== 'ready') {
    return { kind: 'unavailable', reason: 'catalog' };
  }
  const native = match(catalog.models, route);
  if (!native?.contextWindow) {
    return { kind: 'unavailable', reason: native ? 'catalog' : 'model' };
  }
  let maxTokens = native.maxContextWindow ?? native.contextWindow;
  if (route.routeProfile === 'account-proxy') {
    const proxyCatalog = catalog.routes?.['account-proxy'];
    if (!proxyCatalog || proxyCatalog.status !== 'ready') {
      return { kind: 'unavailable', reason: 'catalog' };
    }
    const proxy = match(proxyCatalog.models, route);
    const proxyMax = proxy?.maxContextWindow ?? proxy?.contextWindow;
    // Codex clamps against the native catalog; the proxy must also serve it.
    maxTokens = proxyMax ? Math.min(maxTokens, proxyMax) : native.contextWindow;
  }
  const bounds: CodexContextWindowBounds = {
    defaultTokens: native.contextWindow,
    maxTokens: Math.max(maxTokens, native.contextWindow),
    usablePercent:
      native.effectiveContextWindowPercent ?? CODEX_DEFAULT_USABLE_PERCENT,
    ...(native.autoCompactTokenLimit
      ? { autoCompactTokenLimit: native.autoCompactTokenLimit }
      : {}),
  };
  return {
    kind: bounds.maxTokens > bounds.defaultTokens ? 'adjustable' : 'fixed',
    bounds,
  };
}

/** The configured window a setting asks for, within the bounds. */
export function resolveCodexContextWindowTokens(
  setting: CodexContextWindowSetting | undefined,
  bounds: CodexContextWindowBounds,
): number {
  const floor = Math.min(CODEX_CONTEXT_WINDOW_FLOOR, bounds.defaultTokens);
  const requested =
    setting === undefined || setting === 'model-default'
      ? bounds.defaultTokens
      : setting === 'standard-pricing'
        ? CODEX_LONG_CONTEXT_THRESHOLD
        : setting === 'maximum'
          ? bounds.maxTokens
          : setting;
  return Math.min(bounds.maxTokens, Math.max(floor, requested));
}

/** Distinct preset windows for a picker, smallest first. */
export function codexContextWindowPresets(
  bounds: CodexContextWindowBounds,
): number[] {
  return [CODEX_LONG_CONTEXT_THRESHOLD, bounds.defaultTokens, bounds.maxTokens]
    .filter(
      (tokens, index, all) =>
        tokens <= bounds.maxTokens && all.indexOf(tokens) === index,
    )
    .sort((left, right) => left - right);
}

/** What Codex reports as the window, for a configured window. */
export function codexUsableContextWindow(
  configuredTokens: number,
  bounds: Pick<CodexContextWindowBounds, 'usablePercent'>,
): number {
  return Math.floor((configuredTokens * bounds.usablePercent) / 100);
}

/** Where Codex compacts for a configured window. */
export function codexAutoCompactTokens(
  configuredTokens: number,
  bounds: Pick<CodexContextWindowBounds, 'autoCompactTokenLimit'>,
): number {
  const limit = Math.floor(
    (configuredTokens * CODEX_AUTO_COMPACT_PERCENT) / 100,
  );
  return bounds.autoCompactTokenLimit
    ? Math.min(bounds.autoCompactTokenLimit, limit)
    : limit;
}

export interface CodexContextWindowThreadConfig {
  model_context_window: number;
  model_auto_compact_token_limit?: number;
}

/**
 * The thread config overrides for a setting, or undefined when Codex's own
 * default applies. A catalog's fixed compaction limit would keep compaction
 * below a raised window, so it is raised with it.
 */
export function codexContextWindowThreadConfig(
  setting: CodexContextWindowSetting | undefined,
  support: CodexContextWindowSupport,
): CodexContextWindowThreadConfig | undefined {
  if (support.kind !== 'adjustable') return undefined;
  const tokens = resolveCodexContextWindowTokens(setting, support.bounds);
  if (tokens === support.bounds.defaultTokens) return undefined;
  return {
    model_context_window: tokens,
    ...(support.bounds.autoCompactTokenLimit
      ? {
          model_auto_compact_token_limit: Math.floor(
            (tokens * CODEX_AUTO_COMPACT_PERCENT) / 100,
          ),
        }
      : {}),
  };
}
