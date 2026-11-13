import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCodexRuntimeService } from '../codex/runtime-service';
import type { CodexRuntimeAdmin } from '@canopy/execution-engine/node/codex-runtime';
import { isPathInside } from '../lib/path-safety';
import { codexMarketplaceRootFromPath } from './codex-marketplace-paths';
import type { MarketplaceAddParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/MarketplaceAddParams';
import type { MarketplaceRemoveParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/MarketplaceRemoveParams';
import type { MarketplaceUpgradeParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/MarketplaceUpgradeParams';
import type { PluginInstallParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginInstallParams';
import type { PluginInstallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginInstallResponse';
import type { PluginInstalledParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginInstalledParams';
import type { PluginListParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginListParams';
import type { PluginListResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginListResponse';
import type { PluginMarketplaceEntry } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginMarketplaceEntry';
import type { PluginReadParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginReadParams';
import type { PluginReadResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginReadResponse';
import type { PluginSource } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginSource';
import type { PluginSummary } from '@canopy/execution-engine/node/codex-runtime/generated/v2/PluginSummary';

export interface CodexMarketplaceOperationResult {
  accepted: boolean;
  marketplaceName?: string;
  installedRoot?: string;
  alreadySatisfied?: boolean;
  error?: string;
  structurallyInvalidAtRevision?: string;
  structuralRevisionFallback?: string;
  structuralFailureRevision?: string;
}

export interface CodexMarketplaceInstallMetadata {
  source: string;
  revision?: string;
}

export interface CodexInstalledPluginLocation {
  pluginName: string;
  marketplaceName: string;
  installRoot: string;
}

export interface ResolveCodexPluginInstallRootsOptions {
  listedMarketplace?: PluginMarketplaceEntry;
  installedRoot?: string;
}

const MARKETPLACE_OPERATION_TIMEOUT_MS = 60_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function withConnection<T>(
  action: (admin: CodexRuntimeAdmin) => Promise<T>,
): Promise<T> {
  return withTimeout(
    action(getCodexRuntimeService().admin()),
    MARKETPLACE_OPERATION_TIMEOUT_MS,
    'Codex marketplace operation',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Codex app-server currently exposes marketplace failures as human-readable
// messages, so these patterns must be checked when the bundled Codex bumps.
function isAlreadyAddedError(message: string): boolean {
  return /already (added|exists|installed|registered)/i.test(message);
}

function normalizeCodexMarketplaceSource(source: string): string {
  const trimmed = source.trim();
  const sshGitHubMatch = trimmed.match(
    /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/i,
  );
  if (sshGitHubMatch) {
    return `github:${sshGitHubMatch[1].replace(/\.git$/i, '').toLowerCase()}`;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    if (url.hostname.toLowerCase() === 'github.com') {
      return `github:${pathname.toLowerCase()}`;
    }
    url.pathname = `/${pathname}`;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return trimmed
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  }
}

export async function readCodexMarketplaceInstallMetadata(
  marketplaceName: string,
): Promise<CodexMarketplaceInstallMetadata | null> {
  const { codexHome } = await getCodexRuntimeService().getCanonicalState();
  const installMetadataPath = path.join(
    codexHome,
    '.tmp',
    'marketplaces',
    marketplaceName,
    '.codex-marketplace-install.json',
  );
  if (!fs.existsSync(installMetadataPath)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(installMetadataPath, 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const source: unknown = Reflect.get(parsed, 'source');
    if (typeof source !== 'string') {
      return null;
    }
    const revision: unknown = Reflect.get(parsed, 'revision');
    return {
      source,
      ...(typeof revision === 'string' ? { revision } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Structural = this marketplace has no Codex facet at this revision, and that
 * will not change until the revision does. Transient failures (network,
 * timeout, app-server unavailable, an incomplete checkout) must never match,
 * because a structural verdict deregisters the marketplace from Codex.
 *
 * `did not report any plugins` covers the case where Codex itself lists the
 * marketplace and reports zero plugins for it - the most clearly permanent
 * shape, and one the PR's stated contract calls structural. It is emitted by
 * `resolveCodexPluginInstallRoots` when `plugins.length === 0`, which means
 * Codex parsed the manifest and found no Codex plugins, not that it failed to
 * read it.
 */
export function isStructuralCodexMarketplaceFailure(
  message: string | undefined,
): boolean {
  return (
    !!message &&
    /((?:did not contain|missing)[^\n]*\.codex-plugin\/plugin\.json|no Codex plugins (?:were )?detected|did not report any plugins)/i.test(
      message,
    )
  );
}

function isSameMarketplaceSource(left: string, right: string): boolean {
  return (
    normalizeCodexMarketplaceSource(left) ===
    normalizeCodexMarketplaceSource(right)
  );
}

function alreadyAddedMarketplaceName(message: string): string | undefined {
  const match = message.match(/marketplace\s+['"]([^'"]+)['"]\s+is already/i);
  return match?.[1];
}

function isNotFoundError(message: string): boolean {
  return /(not found|unknown marketplace|not installed|no marketplace|not configured or installed)/i.test(
    message,
  );
}

export async function addCodexMarketplace(
  source: string,
  options: {
    repairEquivalentSourceConflict?: boolean;
    repairMissingLocalSourceConflict?: (input: {
      marketplaceName: string;
      existingSource: string;
      requestedSource: string;
    }) => boolean;
  } = {
    repairEquivalentSourceConflict: true,
  },
): Promise<CodexMarketplaceOperationResult> {
  try {
    const response = await withConnection((connection) =>
      connection.request('marketplace/add', {
        source,
      } satisfies MarketplaceAddParams),
    );
    return {
      accepted: true,
      marketplaceName: response.marketplaceName,
      installedRoot: response.installedRoot,
      alreadySatisfied: response.alreadyAdded,
    };
  } catch (error) {
    const message = errorMessage(error);
    const alreadySatisfied = isAlreadyAddedError(message);
    const marketplaceName = alreadySatisfied
      ? alreadyAddedMarketplaceName(message)
      : undefined;
    if (alreadySatisfied && marketplaceName) {
      const existingSource = (
        await readCodexMarketplaceInstallMetadata(marketplaceName)
      )?.source;
      const sameSource =
        existingSource && isSameMarketplaceSource(source, existingSource);
      const missingLocalSource =
        !!existingSource &&
        path.isAbsolute(existingSource) &&
        !fs.existsSync(existingSource);
      const canRepairMissingLocalSource =
        missingLocalSource &&
        options.repairMissingLocalSourceConflict?.({
          marketplaceName,
          existingSource,
          requestedSource: source,
        }) === true;
      if (
        (sameSource && options.repairEquivalentSourceConflict !== false) ||
        (!sameSource && canRepairMissingLocalSource)
      ) {
        const removeResult = await removeCodexMarketplace(marketplaceName);
        if (removeResult.accepted) {
          return addCodexMarketplace(source, {
            repairEquivalentSourceConflict: false,
          });
        }
      }
      if (!sameSource || /different source/i.test(message)) {
        return {
          accepted: false,
          marketplaceName,
          error: message,
        };
      }
    }
    return {
      accepted: alreadySatisfied,
      marketplaceName,
      alreadySatisfied: alreadySatisfied ? true : undefined,
      error: message,
    };
  }
}

export async function upgradeCodexMarketplace(
  marketplaceName?: string,
): Promise<CodexMarketplaceOperationResult> {
  try {
    const response = await withConnection((connection) =>
      connection.request('marketplace/upgrade', {
        marketplaceName: marketplaceName ?? null,
      } satisfies MarketplaceUpgradeParams),
    );
    const upgraded = marketplaceName
      ? response.selectedMarketplaces.includes(marketplaceName)
      : response.errors.length === 0;
    const error = response.errors
      .map((entry) => JSON.stringify(entry))
      .join('; ');
    return {
      accepted: upgraded && response.errors.length === 0,
      marketplaceName,
      installedRoot:
        upgraded && (!marketplaceName || response.upgradedRoots.length === 1)
          ? response.upgradedRoots[0]
          : undefined,
      error: error || undefined,
    };
  } catch (error) {
    return { accepted: false, marketplaceName, error: errorMessage(error) };
  }
}

export async function removeCodexMarketplace(
  marketplaceName: string,
): Promise<CodexMarketplaceOperationResult> {
  try {
    const response = await withConnection((connection) =>
      connection.request('marketplace/remove', {
        marketplaceName,
      } satisfies MarketplaceRemoveParams),
    );
    return {
      accepted: true,
      marketplaceName: response.marketplaceName,
      installedRoot: response.installedRoot ?? undefined,
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      accepted: isNotFoundError(message),
      marketplaceName,
      alreadySatisfied: isNotFoundError(message) ? true : undefined,
      error: message,
    };
  }
}

export async function listCodexPlugins(
  cwds?: string[],
): Promise<PluginListResponse> {
  return withConnection((connection) =>
    connection.request('plugin/list', {
      cwds: cwds ?? null,
      // Explicit kinds, never null/omitted: non-explicit kinds add the
      // signed-in remote global catalog, whose unbounded pagination fetch has
      // hung plugin/list indefinitely (Codex 0.144.x — see
      // docs/planning/2026-07-12-codex-app-server-plugin-list-hang/). Canopy
      // marketplaces are local; the locally cached curated marketplace is
      // still included when kinds are explicit.
      marketplaceKinds: ['local'],
    } satisfies PluginListParams),
  );
}

export async function readCodexPlugin(
  params: PluginReadParams,
): Promise<PluginReadResponse> {
  return withConnection((connection) =>
    connection.request('plugin/read', params),
  );
}

export async function installCodexPlugin(
  params: PluginInstallParams,
): Promise<PluginInstallResponse> {
  return withConnection((connection) =>
    connection.request('plugin/install', params),
  );
}

export async function uninstallCodexPlugin(pluginId: string): Promise<void> {
  await withConnection((connection) =>
    connection.request('plugin/uninstall', { pluginId }),
  );
}

function sourceKind(source: PluginSource): PluginSource['type'] {
  return source.type;
}

/**
 * Path of the default `marketplace.json` manifest for a Codex marketplace
 * root. It does not reverse {@link codexMarketplaceRootFromPath}: one checkout
 * can hold other manifests, such as the `api_marketplace.json` Codex lists
 * while signed out.
 *
 * This is how a LOCAL marketplace is addressed to `plugin/install`.
 * `remoteMarketplaceName` is not an alternative spelling of the same thing: it
 * names a marketplace served by the remote plugin catalog, and setting it makes
 * the app-server resolve the plugin against `chatgpt.com/backend-api/ps/plugins`
 * instead of the marketplace on disk — which 404s for anything Canopy manages
 * locally, curated or built-in.
 */
export function codexMarketplaceManifestPath(root: string): string {
  return path.join(root, '.agents', 'plugins', 'marketplace.json');
}

function mergePluginSummaries(input: {
  listedMarketplace?: PluginMarketplaceEntry;
  installedMarketplace?: PluginMarketplaceEntry;
}): PluginSummary[] {
  const byName = new Map<string, PluginSummary>();
  for (const plugin of input.listedMarketplace?.plugins ?? []) {
    byName.set(plugin.name.toLowerCase(), plugin);
  }
  for (const plugin of input.installedMarketplace?.plugins ?? []) {
    byName.set(plugin.name.toLowerCase(), plugin);
  }
  return Array.from(byName.values());
}

function resolveLocalPluginRoot(input: {
  sourcePath: string;
  marketplaceRoot: string | null;
}): string | null {
  if (!input.marketplaceRoot) {
    return null;
  }
  const marketplaceRoot = path.resolve(input.marketplaceRoot);
  const resolved = path.isAbsolute(input.sourcePath)
    ? path.normalize(input.sourcePath)
    : path.resolve(marketplaceRoot, input.sourcePath);
  if (!isPathInside(marketplaceRoot, resolved)) {
    return null;
  }
  return resolved;
}

export async function resolveCodexPluginInstallRoots(
  marketplaceName: string,
  options: ResolveCodexPluginInstallRootsOptions = {},
): Promise<{
  locations: CodexInstalledPluginLocation[];
  unresolved: Array<{
    pluginName: string;
    sourceKind: 'git' | 'remote' | 'local-missing' | 'local-incomplete';
    reason: string;
  }>;
}> {
  const response = await withConnection((connection) =>
    connection.request('plugin/installed', {
      cwds: null,
      installSuggestionPluginNames: null,
    } satisfies PluginInstalledParams),
  );
  const entry = response.marketplaces.find(
    (marketplace) => marketplace.name === marketplaceName,
  );
  if (!entry && !options.listedMarketplace) {
    return {
      locations: [],
      unresolved: [
        {
          pluginName: marketplaceName,
          sourceKind: 'local-missing',
          reason: `Codex marketplace "${marketplaceName}" was not returned by plugin/list or plugin/installed.`,
        },
      ],
    };
  }

  const marketplaceRoot =
    codexMarketplaceRootFromPath(
      entry?.path ?? options.listedMarketplace?.path,
    ) ??
    (options.installedRoot && path.isAbsolute(options.installedRoot)
      ? options.installedRoot
      : null);
  const plugins = mergePluginSummaries({
    listedMarketplace: options.listedMarketplace,
    installedMarketplace: entry,
  });
  const locations: CodexInstalledPluginLocation[] = [];
  const unresolved: Array<{
    pluginName: string;
    sourceKind: 'git' | 'remote' | 'local-missing' | 'local-incomplete';
    reason: string;
  }> = [];

  if (plugins.length === 0) {
    // Symmetric with the per-plugin branch below: a zero-plugin result is only
    // a STABLE structural signal when the marketplace checkout is actually
    // present. Codex also reports zero plugins when the registration exists
    // but its checkout is partial or its manifest unreadable - the
    // mid-`marketplace-upgrade` swap state this sweep cleans up after - and
    // that resolves itself. The revision guard alone is not enough: a checkout
    // that still has `.git` and stale `.codex-marketplace-install.json`
    // resolves a revision and would be deregistered and suppressed until the
    // source revision moved.
    const marketplaceRootPresent =
      !!marketplaceRoot && fs.existsSync(marketplaceRoot);
    unresolved.push(
      marketplaceRootPresent
        ? {
            pluginName: marketplaceName,
            sourceKind: 'local-missing',
            reason: `Codex marketplace "${marketplaceName}" did not report any plugins.`,
          }
        : {
            pluginName: marketplaceName,
            sourceKind: 'local-incomplete',
            reason: `Codex marketplace "${marketplaceName}" has no checkout at ${marketplaceRoot ?? 'an unresolved path'} yet; the marketplace checkout looks incomplete.`,
          },
    );
  }

  for (const plugin of plugins) {
    const kind = sourceKind(plugin.source);
    if (plugin.source.type === 'local') {
      const installRoot = resolveLocalPluginRoot({
        sourcePath: plugin.source.path,
        marketplaceRoot,
      });
      if (!installRoot) {
        unresolved.push({
          pluginName: plugin.name,
          sourceKind: 'local-missing',
          reason: `Local Codex plugin "${plugin.name}" reported path "${plugin.source.path}", but it could not be resolved inside the marketplace root.`,
        });
        continue;
      }
      const manifestPath = path.join(
        installRoot,
        '.codex-plugin',
        'plugin.json',
      );
      if (fs.existsSync(manifestPath)) {
        locations.push({
          pluginName: plugin.name,
          marketplaceName:
            entry?.name ?? options.listedMarketplace?.name ?? marketplaceName,
          installRoot,
        });
      } else if (fs.existsSync(installRoot)) {
        // The checkout is present and simply carries no Codex manifest - a
        // genuine, STABLE structural signal that this plugin is not a Codex
        // plugin. `isStructuralCodexMarketplaceFailure` matches this wording,
        // and a marketplace whose plugins all land here is deregistered from
        // Codex.
        unresolved.push({
          pluginName: plugin.name,
          sourceKind: 'local-missing',
          reason: `Local Codex plugin "${plugin.name}" did not contain .codex-plugin/plugin.json at ${installRoot}.`,
        });
      } else {
        // `resolveLocalPluginRoot` is pure path arithmetic with no existence
        // check, so an install root that does not exist on disk means the
        // checkout itself is incomplete (interrupted clone, a mid-upgrade swap
        // through `marketplace-backup-*`, a sparse/LFS checkout) - NOT that
        // this is a Claude-only plugin. Deliberately worded so it does NOT
        // match `isStructuralCodexMarketplaceFailure`: a transient condition
        // must never deregister a working marketplace, which would then stay
        // suppressed until the source revision moves or the user clicks Retry
        // refresh.
        unresolved.push({
          pluginName: plugin.name,
          // Distinct from 'local-missing' so callers can classify PER ENTRY.
          // The structural regex runs over the JOINED reason string, so one
          // structural entry in a mixed set would otherwise make the whole
          // marketplace structural; this kind is the discriminator that stops
          // a transient entry from being averaged away.
          sourceKind: 'local-incomplete',
          reason: `Local Codex plugin "${plugin.name}" has no checkout at ${installRoot} yet; the marketplace checkout looks incomplete.`,
        });
      }
      continue;
    }

    unresolved.push({
      pluginName: plugin.name,
      sourceKind: plugin.source.type === 'git' ? 'git' : 'remote',
      reason: `Codex plugin "${plugin.name}" uses ${kind} source; the app-server protocol does not expose a materialized install path for this source type yet.`,
    });
  }

  return { locations, unresolved };
}
