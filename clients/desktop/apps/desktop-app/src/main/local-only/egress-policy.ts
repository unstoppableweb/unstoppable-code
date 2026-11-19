/**
 * Which hosts a local-only build (docs/local-only-build.md) lets Electron
 * main and its sessions reach. The egress guard asks this module per
 * request; nothing here is snapshotted at install, because providers, MCP
 * servers and the gateway change while the app runs.
 *
 * Allowed:
 * - loopback, always, including before the policy is ready;
 * - every host a registered source reports right now (the configured
 *   gateway, a non-loopback Ollama host, connected MCP servers and their
 *   OAuth issuers, connected provider API hosts and custom base URLs, and
 *   the GitHub hosts while GitHub is connected);
 * - the exact hostnames in `localOnly.allowedHosts`, stored as
 *   `allowedHosts` in `local-only.json` in the app data directory. No UI
 *   writes it.
 *
 * The guard asks synchronously, so `local-only.json` is read off the main
 * thread: `loadEgressPolicySettings()` reads it before the fail-closed window
 * ends, and a check that finds the last read older than two seconds answers
 * from it and starts a background re-read.
 *
 * Rules: fail closed (loopback only) until `markEgressPolicyReady()`; hosts
 * match exactly and case-insensitively, ignoring one trailing dot and the
 * port; there is no suffix or wildcard matching. Non-network schemes are
 * always allowed.
 */
import { readFile, stat } from 'node:fs/promises';
import { getLocalOnlySettingsFilePath } from '../lib/paths';
import { isLoopbackHost, normalizeEgressHost } from './loopback';

/** Returns the hosts a source allows at the moment it is called. */
export type EgressAllowedHostSource = () => Iterable<string>;

/**
 * The GitHub hosts user-started GitHub flows use (REST and GraphQL API,
 * git over HTTPS, release and archive downloads, and the raw file host that
 * skill browsing and installs read). Register them only while
 * GitHub is connected. `avatars.githubusercontent.com` is never allowed:
 * avatars are an automatic call and are off in a local-only build.
 */
export const GITHUB_CONNECTED_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'api.github.com',
  'uploads.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
]);

/**
 * Provider hosts main contacts for a connected provider (keyed like
 * `PortalChatProviderAvailability`), allowed only while it is connected:
 * the Anthropic API for Claude (profile and plan usage), and the OpenAI API
 * and ChatGPT backend for Codex (plan usage).
 */
export const PROVIDER_API_HOSTS = Object.freeze({
  claude: Object.freeze(['api.anthropic.com']),
  codex: Object.freeze(['api.openai.com', 'chatgpt.com']),
});

/**
 * Environment variables naming a provider base URL the user set for this
 * app; their hosts count as user-configured.
 */
const CUSTOM_BASE_URL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;

const NETWORK_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
]);

const sources = new Map<string, EgressAllowedHostSource>();
let ready = false;

/**
 * Registers a named source of allowed hosts and returns its unregister
 * function. A later registration under the same name replaces the earlier
 * one. A source that throws allows nothing.
 */
export function registerEgressAllowedHostSource(
  name: string,
  source: EgressAllowedHostSource,
): () => void {
  sources.set(name, source);
  return () => {
    if (sources.get(name) === source) sources.delete(name);
  };
}

/**
 * Ends the fail-closed startup window. The guard calls it at
 * `app.whenReady()`; host sources answer from their owners' in-memory state
 * from then on.
 */
export function markEgressPolicyReady(): void {
  ready = true;
}

const SETTINGS_RECHECK_MS = 2_000;
let settingsCache:
  | { checkedAt: number; mtimeMs: number; hosts: ReadonlySet<string> }
  | undefined;
let settingsRefresh: Promise<void> | null = null;
const NO_HOSTS: ReadonlySet<string> = new Set();

function parseAllowedHosts(raw: string): ReadonlySet<string> {
  const parsed: unknown = JSON.parse(raw);
  const hosts = new Set<string>();
  if (typeof parsed !== 'object' || parsed === null) return hosts;
  const list: unknown = Reflect.get(parsed, 'allowedHosts');
  if (!Array.isArray(list)) return hosts;
  for (const entry of list) {
    // Exact hostnames only: wildcards, schemes, paths and ports are ignored.
    if (typeof entry !== 'string' || /[*/:@\s]/.test(entry.trim())) continue;
    const host = normalizeEgressHost(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Reads `local-only.json` and replaces the cache. Never rejects. */
async function refreshConfiguredAllowedHosts(): Promise<void> {
  const checkedAt = Date.now();
  try {
    const path = getLocalOnlySettingsFilePath();
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      settingsCache = { checkedAt, mtimeMs, hosts: NO_HOSTS };
      return;
    }
    if (settingsCache && settingsCache.mtimeMs === mtimeMs) {
      settingsCache = { ...settingsCache, checkedAt };
      return;
    }
    let hosts: ReadonlySet<string> = NO_HOSTS;
    try {
      hosts = parseAllowedHosts(await readFile(path, 'utf8'));
    } catch {
      // An unreadable or malformed file allows nothing extra.
    }
    settingsCache = { checkedAt, mtimeMs, hosts };
  } catch {
    // No settings path yet: allow nothing extra and try again next check.
    settingsCache = { checkedAt, mtimeMs: -1, hosts: NO_HOSTS };
  }
}

/** Starts a read unless one is running, and returns it. Never rejects. */
function refreshSettings(): Promise<void> {
  settingsRefresh ??= refreshConfiguredAllowedHosts().finally(() => {
    settingsRefresh = null;
  });
  return settingsRefresh;
}

/**
 * Reads `localOnly.allowedHosts` once. The guard starts it before ready and
 * calls `markEgressPolicyReady()` only once it has finished, so the first
 * allowed check already sees the file. Never rejects.
 */
export function loadEgressPolicySettings(): Promise<void> {
  return refreshSettings();
}

/** Whether `local-only.json` has been read at least once. */
export function egressPolicySettingsLoaded(): boolean {
  return settingsCache !== undefined;
}

/**
 * `localOnly.allowedHosts` as last read. A read older than two seconds starts
 * a background re-read; this check still answers from the last one.
 */
function readConfiguredAllowedHosts(now = Date.now()): ReadonlySet<string> {
  if (!settingsCache || now - settingsCache.checkedAt >= SETTINGS_RECHECK_MS) {
    void refreshSettings();
  }
  return settingsCache?.hosts ?? NO_HOSTS;
}

function customBaseUrlHosts(): string[] {
  const hosts: string[] = [];
  for (const key of CUSTOM_BASE_URL_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    try {
      hosts.push(new URL(value).hostname);
    } catch {
      // Not a URL; nothing to allow.
    }
  }
  return hosts;
}

function sourceAllows(source: EgressAllowedHostSource, host: string): boolean {
  try {
    for (const candidate of source()) {
      if (normalizeEgressHost(candidate) === host) return true;
    }
  } catch {
    // A failing source allows nothing.
  }
  return false;
}

/** Whether the guard lets a connection to `host` through. */
export function isEgressHostAllowed(rawHost: string): boolean {
  const host = normalizeEgressHost(rawHost);
  if (!host || isLoopbackHost(host)) return true;
  if (!ready) return false;
  if (readConfiguredAllowedHosts().has(host)) return true;
  if (customBaseUrlHosts().some((h) => normalizeEgressHost(h) === host)) {
    return true;
  }
  for (const source of sources.values()) {
    if (sourceAllows(source, host)) return true;
  }
  return false;
}

export type EgressUrlDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly host: string };

/**
 * Decides one URL. Non-network schemes (`file:`, `data:`, `blob:`,
 * `devtools:`, `chrome-extension:`, the app's own protocols) are always
 * allowed; an unparseable URL is allowed only when it is not a network URL.
 */
export function evaluateEgressUrl(value: string): EgressUrlDecision {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return /^(?:https?|wss?):/i.test(value)
      ? { allowed: false, host: '(invalid)' }
      : { allowed: true };
  }
  if (!NETWORK_SCHEMES.has(url.protocol)) return { allowed: true };
  const host = normalizeEgressHost(url.hostname);
  return isEgressHostAllowed(host)
    ? { allowed: true }
    : { allowed: false, host };
}

export function resetEgressPolicyForTests(): void {
  sources.clear();
  ready = false;
  settingsCache = undefined;
  settingsRefresh = null;
}
