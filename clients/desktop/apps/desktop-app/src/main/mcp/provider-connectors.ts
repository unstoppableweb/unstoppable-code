import { listCuratedMcpServers } from './curated-catalog';
import {
  getBundledClaudeBinaryPath,
  getEnhancedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import { normalizeCapabilityName } from '@canopy/desktop-shared/lib/normalize-capability-name';
import type {
  ProviderAlternateRoute,
  ProviderConnectorEntry,
  ProviderConnectorListResult,
} from '@canopy/execution-engine/types/mcp-servers';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runClaudeCliProcessOffMain } from '../agents/claude-process-host-runner';

/**
 * Provider-managed MCP connectors — Google Workspace and friends, authenticated
 * against the *provider's* OAuth client rather than Canopy's.
 *
 * Canopy owns none of this auth. Anthropic hosts the connector, the user links
 * it to their claude.ai account, and Claude Code fetches the list at session
 * start. Canopy's role is to make that discoverable and to explain the cases
 * where the connectors silently will not load.
 *
 * The payoff is that Gmail and Drive need no Canopy-registered OAuth client,
 * which means no Google restricted-scope verification and no annual CASA
 * assessment for those surfaces — that burden stays with the provider.
 */

/** The existing desktop read, also projected by Portal's MCP inventory. */
export async function listAdvertisedProviderConnectors(): Promise<
  ProviderConnectorListResult[]
> {
  // The served catalog is the only source of what is advertised. Claude needs
  // no such filter — its list is already only the account's connectors — but
  // Codex reports a directory of thousands and has to be narrowed.
  const catalog = await listCuratedMcpServers();
  // Reading Claude costs a CLI spawn that health-checks every configured MCP
  // server over the network, and this handler runs on Plugins-page mount and
  // on every window focus. Scoped per provider rather than "does anything
  // advertise a connector": a Codex-only catalog would otherwise still pay
  // the Claude cost for a guaranteed-empty answer.
  const claudeAdvertised = catalog.servers.some((entry) =>
    entry.providerConnector?.providers.includes('claude'),
  );
  // Scoped to Codex: a Claude-only connector has no business being looked up
  // in Codex's directory. The row builder re-filters by the same list, so
  // this is currently only wasted work — but the two filters living in
  // different files is precisely how the last drift bug started.
  const codexAdvertised = catalog.servers
    .filter((entry) => entry.providerConnector?.providers.includes('codex'))
    .map((entry) => ({
      displayName: entry.name,
      ...(entry.providerConnector?.codexConnectorId
        ? { codexConnectorId: entry.providerConnector.codexConnectorId }
        : {}),
    }));
  // Read both providers together: one provider being signed out must not hide
  // the other's connectors.
  return Promise.all([
    claudeAdvertised
      ? listClaudeProviderConnectors()
      : Promise.resolve({ provider: 'claude' as const, connectors: [] }),
    codexAdvertised.length > 0
      ? listCodexProviderConnectors(codexAdvertised)
      : Promise.resolve({ provider: 'codex' as const, connectors: [] }),
  ]);
}

/** Claude Code prefixes every claude.ai account connector with this. */
const CLAUDE_CONNECTOR_PREFIX = 'claude.ai ';

/** `claude mcp list` health-checks every configured server, so allow for it. */
const LIST_TIMEOUT_MS = 60_000;
const LIST_MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Auth sources that take precedence over the claude.ai login.
 *
 * Claude Code disables account connectors entirely when one of these is set —
 * the connector list is fetched with the claude.ai OAuth token, and an API key
 * means there is no such token in play. Worth surfacing, because the failure is
 * otherwise silent: the connectors simply never appear.
 */
const CLAUDE_API_KEY_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

/** `claude mcp list` emits `name: detail - status`, one server per line. */
const LIST_LINE = /^(.+?):\s+(.*?)\s+-\s+(.*)$/;
const CLAUDE_CONNECTORS_DISABLED_WARNING =
  /^[\t ]*(?:(?:warning:|⚠\uFE0F?)[\t ]*)?claude\.ai connectors are disabled\b/im;

function hasClaudeConnectorsDisabledWarning(output: string): boolean {
  return CLAUDE_CONNECTORS_DISABLED_WARNING.test(
    stripVTControlCharacters(output),
  );
}

function claudeConnectorsDisabled(): ProviderConnectorListResult {
  return {
    provider: 'claude',
    connectors: [],
    unavailableReason: 'api-key-precedence',
    detail: 'Claude Code turned off claude.ai connectors for this check.',
  };
}

function firstNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read the connector list from the provider's own CLI rather than from
 * Anthropic's `/v1/mcp_servers` endpoint.
 *
 * Going through the CLI means Canopy never reads the provider's credential
 * store and never depends on a private, beta-gated API shape. The cost is a
 * health check per configured server, which is why this is a user-triggered
 * settings action rather than anything on a hot path.
 */
export async function listClaudeProviderConnectors(): Promise<ProviderConnectorListResult> {
  const env = getEnhancedEnv();
  const apiKeyVar = CLAUDE_API_KEY_ENV_VARS.find((name) =>
    firstNonEmpty(env[name]),
  );
  if (apiKeyVar) {
    return {
      provider: 'claude',
      connectors: [],
      unavailableReason: 'api-key-precedence',
      detail: `${apiKeyVar} takes precedence over your claude.ai sign-in, so account connectors are disabled.`,
    };
  }

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await runClaudeCliProcessOffMain({
      command: getBundledClaudeBinaryPath(),
      args: ['mcp', 'list'],
      env,
      timeoutMs: LIST_TIMEOUT_MS,
      maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    }));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'Unknown error';
    if (hasClaudeConnectorsDisabledWarning(detail)) {
      return claudeConnectorsDisabled();
    }
    return {
      provider: 'claude',
      connectors: [],
      unavailableReason: 'cli-failed',
      detail,
    };
  }

  const alternateRoutes = parseClaudeAlternateRoutes(stdout);
  if (
    hasClaudeConnectorsDisabledWarning(stdout) ||
    hasClaudeConnectorsDisabledWarning(stderr)
  ) {
    return { ...claudeConnectorsDisabled(), alternateRoutes };
  }
  return {
    provider: 'claude',
    connectors: parseClaudeConnectorList(stdout),
    alternateRoutes,
  };
}

/**
 * Connected servers that are NOT account connectors.
 *
 * Claude serves some capabilities through plugins rather than account
 * connectors — Slack arrives as `plugin:slack:slack`, not `claude.ai Slack`.
 * Reporting only connectors tells a user whose Slack already works that they
 * need to connect Slack: true about the connector, wrong about whether they
 * have the capability.
 */
export function parseClaudeAlternateRoutes(
  stdout: string,
): ProviderAlternateRoute[] {
  const routes: ProviderAlternateRoute[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith(CLAUDE_CONNECTOR_PREFIX)) continue;
    const match = LIST_LINE.exec(line);
    if (!match) continue;
    const [, name, , status] = match;
    // Only a working server is an alternate route. A failed one is not a
    // reason to stop offering the connector.
    if (!name || !status || !isConnectedStatus(status)) continue;
    routes.push({
      normalizedName: normalizeCapabilityName(name),
      serverName: name,
    });
  }
  return routes;
}

/**
 * Pull the account connectors out of `claude mcp list` output.
 *
 * Locally configured servers and account connectors share one list; only the
 * `claude.ai ` prefix distinguishes them. Anything else in that output is a
 * server the user added themselves, which Canopy already manages elsewhere and
 * must not double-report here.
 */
export function parseClaudeConnectorList(
  stdout: string,
): ProviderConnectorEntry[] {
  const connectors: ProviderConnectorEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(CLAUDE_CONNECTOR_PREFIX)) continue;
    const match = LIST_LINE.exec(line);
    if (!match) continue;
    const [, name, , status] = match;
    if (!name || !status) continue;
    connectors.push({
      name,
      displayName: name.slice(CLAUDE_CONNECTOR_PREFIX.length),
      connected: isConnectedStatus(status),
      status: status.trim(),
    });
  }
  return connectors;
}

/**
 * The CLI marks health with a leading glyph and prose that varies by failure.
 * Treat only an explicit success as connected — an unreachable or
 * needs-authentication connector must not read as ready.
 */
function isConnectedStatus(status: string): boolean {
  // Anchored, because `\bconnected\b` also matches "Not connected" — a status
  // the CLI emits — and reporting that as linked is the one direction this
  // function must never get wrong.
  const trimmed = status.trim();
  return /^[✔✓]/.test(trimmed) || /^connected\b/i.test(trimmed);
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Codex caches the ChatGPT app directory on disk, so its connector state can be
 * read without running the CLI at all.
 *
 * The directory supplies the catalog side only: which apps exist, whether the
 * provider has disabled one, and a per-app `installUrl`, which is a better
 * Connect target than Claude's account-wide page. Linked state comes from the
 * separate tools cache below — see there for why the directory cannot supply
 * it.
 */
const CODEX_APP_DIRECTORY_CACHE = 'cache/codex_app_directory';

/**
 * The cache Codex writes with the tools it actually loaded — the only on-disk
 * evidence of which apps are linked to the account.
 *
 * The app directory looks like the obvious source and is not: its
 * `isAccessible` flag reads false for every entry in a real cache (3,092 of
 * 3,092 on the machine this was diagnosed against), because that file is an
 * anonymous catalog snapshot rather than account state. Keying on it reported
 * every Codex connector as unlinked no matter what the user had connected, and
 * the resulting permanent "Connect with Codex" button was indistinguishable
 * from a stale read.
 *
 * This file is also written far more often — Codex rewrites it whenever it
 * loads tools, so it reflects a link made minutes ago rather than whenever the
 * directory last happened to sync.
 */
const CODEX_APPS_TOOLS_CACHE = 'cache/codex_apps_tools';

/**
 * Ceiling for either Codex cache read; the measured directory is roughly 5 MB.
 *
 * Shared because both files are Codex's, both are parsed on the main thread,
 * and both are read on Plugins-page mount and on window focus.
 */
const CODEX_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface CodexToolEntry {
  connector_id?: unknown;
  connector_name?: unknown;
}

/**
 * Which apps are linked, as a set of both connector ids and connector names.
 *
 * Both are indexed because neither alone is sufficient: the id is the stable
 * join key across a provider-side rename, while a linked app that never
 * appears in the directory can still be recognised by name.
 */
export function parseCodexLinkedApps(parsed: unknown): ReadonlySet<string> {
  const linked = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return linked;
  const raw: unknown = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) return linked;
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const entry: CodexToolEntry = item;
    if (typeof entry.connector_id === 'string' && entry.connector_id) {
      linked.add(entry.connector_id);
    }
    if (typeof entry.connector_name === 'string' && entry.connector_name) {
      linked.add(entry.connector_name);
    }
  }
  return linked;
}

interface CodexDirectoryEntry {
  id?: unknown;
  name?: unknown;
  installUrl?: unknown;
  isAccessible?: unknown;
  isEnabled?: unknown;
}

function codexHome(): string {
  return (
    firstNonEmpty(process.env.CODEX_HOME) ?? path.join(homedir(), '.codex')
  );
}

/** Newest cache file wins; Codex keys them by a hash that changes per account. */
async function newestCacheFile(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    try {
      const info = await stat(file);
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs: info.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return newest?.file;
}

/**
 * @param advertised Display names the served catalog advertises as connectors.
 *   The directory holds thousands of apps, so something has to narrow it — and
 *   that something must be the served catalog, not a list compiled in here. A
 *   second, hand-kept copy drifted once already: a connector was advertised and
 *   not copied into this module, so Codex reported nothing for it, the row
 *   carried no install URL, and Connect fell through to the wrong provider.
 */
/** One advertised connector, as the served catalog describes it. */
export interface AdvertisedConnector {
  displayName: string;
  /**
   * Exact directory id, when the catalog pins one.
   *
   * Preferred over the display name because the directory holds thousands of
   * apps and names collide; the name is also the provider's to change, while
   * the id is stable. Optional, so an entry that does not pin one still
   * matches by name.
   */
  codexConnectorId?: string;
}

export async function listCodexProviderConnectors(
  advertised: readonly AdvertisedConnector[],
): Promise<ProviderConnectorListResult> {
  const file = await newestCacheFile(
    path.join(codexHome(), CODEX_APP_DIRECTORY_CACHE),
  );
  if (!file) {
    return {
      provider: 'codex',
      connectors: [],
      unavailableReason: 'no-directory-cache',
      detail:
        'Codex has not cached its app directory yet. Start a Codex chat once, then refresh.',
    };
  }
  let parsed: unknown;
  try {
    const info = await stat(file);
    // Bounded like the Claude path's output cap. This file is Codex's, not
    // Canopy's, and it is read and parsed on the main thread — the measured
    // 3,092-entry directory is ~5 MB, so the ceiling is generous while still
    // refusing to block the event loop on something pathological.
    if (info.size > CODEX_CACHE_MAX_BYTES) {
      return {
        provider: 'codex',
        connectors: [],
        unavailableReason: 'no-directory-cache',
        detail: `Codex's app directory cache is larger than ${String(
          Math.round(CODEX_CACHE_MAX_BYTES / 1_000_000),
        )} MB, so it was not read.`,
      };
    }
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error: unknown) {
    return {
      provider: 'codex',
      connectors: [],
      unavailableReason: 'no-directory-cache',
      detail: error instanceof Error ? error.message : 'Unreadable cache',
    };
  }
  // Linked state is a separate read, and its absence is not fatal: the catalog
  // is still worth showing with everything reported unlinked.
  const toolsFile = await newestCacheFile(
    path.join(codexHome(), CODEX_APPS_TOOLS_CACHE),
  );
  let linked: ReadonlySet<string> = new Set();
  let linkedAt: string | undefined;
  if (toolsFile) {
    try {
      const info = await stat(toolsFile);
      // Capped like the directory read. This is the file Codex rewrites most
      // often, and it is parsed on the main thread.
      if (info.size > CODEX_CACHE_MAX_BYTES) {
        throw new Error('tools cache too large');
      }
      linkedAt = info.mtime.toISOString();
      linked = parseCodexLinkedApps(
        JSON.parse(await readFile(toolsFile, 'utf8')),
      );
    } catch {
      // Nothing linked — and crucially no timestamp. `linkedAt` is assigned
      // before the parse, so leaving it set would date a state that was never
      // read: the UI would show "Status may be out of date" from seconds ago
      // while reporting nothing linked, which reads as a confident negative
      // derived from a failed read.
      linkedAt = undefined;
      linked = new Set();
    }
  }

  return {
    provider: 'codex',
    connectors: parseCodexDirectory(parsed, linked, advertised),
    // Qualifies a not-linked answer, and dates it by the file the answer
    // actually came from — the tools cache, rewritten whenever Codex loads
    // tools. Deliberately not falling back to the directory's mtime: the
    // directory says nothing about what is linked, so dating a negative by it
    // would overstate the staleness of a fresh answer and understate a
    // genuinely old one. When the tools cache could not be read there is no
    // basis for any staleness claim, so none is made.
    ...(linkedAt ? { snapshotAt: linkedAt } : {}),
  };
}

/**
 * Pull the surfaced connectors out of Codex's cached app directory, taking
 * linked state from `linked` rather than from the directory itself.
 */
export function parseCodexDirectory(
  parsed: unknown,
  linked: ReadonlySet<string>,
  advertised: readonly AdvertisedConnector[],
): ProviderConnectorEntry[] {
  const pinnedIds = new Map(
    advertised.flatMap((row) =>
      row.codexConnectorId ? [[row.codexConnectorId, row] as const] : [],
    ),
  );
  const byName = new Map(
    advertised
      .filter((row) => !row.codexConnectorId)
      .map((row) => [row.displayName, row] as const),
  );
  if (typeof parsed !== 'object' || parsed === null) return [];
  const raw: unknown = (parsed as { connectors?: unknown }).connectors;
  if (!Array.isArray(raw)) return [];
  const connectors: ProviderConnectorEntry[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const entry: CodexDirectoryEntry = item;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    // An id pin wins over the name, which is the whole reason the field
    // exists: the directory holds thousands of apps and display names both
    // collide and belong to the provider to change.
    const match =
      (id ? pinnedIds.get(id) : undefined) ??
      (name ? byName.get(name) : undefined);
    if (!match || !name) continue;
    // `isEnabled` is the provider's own kill switch for the app; a disabled one
    // cannot be linked, so offering Connect for it would dead-end the user.
    if (entry.isEnabled === false) continue;
    const connected = (id ? linked.has(id) : false) || linked.has(name);
    connectors.push({
      name,
      // The catalog's name, not the directory's. Everything downstream joins
      // on what the catalog calls this connector, so an id-pinned entry whose
      // provider-side name differs — the exact case the pin exists for — would
      // otherwise never match its own row: no install URL, permanently "not
      // linked", and Connect falling through to the generic directory page.
      displayName: match.displayName,
      connected,
      status: connected ? 'Connected' : 'Not linked',
      ...(typeof entry.installUrl === 'string'
        ? { installUrl: entry.installUrl }
        : {}),
    });
  }
  return connectors;
}
