import { AsyncLocalStorage } from 'node:async_hooks';
import { type BigIntStats, constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  observePluginCopyReferences,
  pluginCopyPathIdentity,
} from '@canopy/execution-engine/node/plugins/plugin-copy-references';
import {
  CodexNotInstalledError,
  probeCodexExecutableInstalled,
} from '../codex/codex-executable-availability';
import { installPathOf } from './claude-enabled-plugins';
import { getPluginCacheDir } from '../lib/paths';
import { safeReadJsonAsync } from '../lib/fs-utils';

/**
 * The closed evidence set one refresh judges before its sweep may reclaim.
 * Each source is judged where it is read. Codex starts unread, so a refresh
 * that never judged a listing cannot admit; any other unknown taints it.
 */
export interface PluginCopySweepEvidence {
  codex: 'unread' | 'complete' | 'absent' | 'unknown';
  tainted: boolean;
  closed: boolean;
  readonly curatedCodex: {
    readonly marketplaceName: string;
    readonly manifestPath: string;
  };
}

export const pluginCopyProviderEvidence =
  new AsyncLocalStorage<PluginCopySweepEvidence>();

export function openPluginCopySweepEvidence(
  curatedCodex: PluginCopySweepEvidence['curatedCodex'],
): PluginCopySweepEvidence {
  return { codex: 'unread', tainted: false, closed: false, curatedCodex };
}

function openEvidence(): PluginCopySweepEvidence | undefined {
  const evidence = pluginCopyProviderEvidence.getStore();
  return evidence && !evidence.closed ? evidence : undefined;
}

export type PluginCopyEvidence<T> =
  | { state: 'present'; value: T }
  | { state: 'absent' }
  | { state: 'unknown' };

export function taintPluginCopyEvidence(): void {
  const evidence = pluginCopyProviderEvidence.getStore();
  if (evidence) evidence.tainted = true;
}

/** The single admission check for every sweep entry point. */
export function admitsPluginCopySweep(): boolean {
  const evidence = openEvidence();
  return (
    evidence !== undefined &&
    !evidence.tainted &&
    (evidence.codex === 'complete' || evidence.codex === 'absent')
  );
}

export function isPluginCopyEvidenceRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PLUGIN_COPY_EVIDENCE_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** Evidence file path to the stamp it was read with: identity, size and times, or absent. */
export type PluginCopyEvidenceStamps = Map<string, string>;

const ABSENT_STAMP = 'absent';
// Never produced by a stat, so a file read twice differently or unreadably never matches.
const UNMATCHABLE_STAMP = 'unmatchable';

function isMissingEvidence(error: unknown): boolean {
  return isPluginCopyEvidenceRecord(error) && error.code === 'ENOENT';
}

function evidenceStamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function recordEvidenceStamp(
  stamps: PluginCopyEvidenceStamps | undefined,
  file: string,
  stamp: string,
): void {
  if (!stamps) return;
  const previous = stamps.get(file);
  stamps.set(
    file,
    previous === undefined || previous === stamp ? stamp : UNMATCHABLE_STAMP,
  );
}

async function currentEvidenceStamp(file: string): Promise<string> {
  try {
    return evidenceStamp(await stat(file, { bigint: true }));
  } catch (error) {
    if (isMissingEvidence(error)) return ABSENT_STAMP;
    throw error;
  }
}

/** Stamp before reading, so a change during or after the read never matches. */
export async function stampPluginCopyEvidencePath(
  file: string,
  stamps: PluginCopyEvidenceStamps,
): Promise<void> {
  recordEvidenceStamp(
    stamps,
    file,
    await currentEvidenceStamp(file).catch(() => UNMATCHABLE_STAMP),
  );
}

/**
 * Evidence reads run inside the plugin mutation queue, on paths registries and
 * listings name: open without blocking and read only a bounded regular file,
 * so a FIFO or device is unknown evidence instead of a stalled queue.
 */
async function readBoundedEvidenceFile(
  file: string,
  stamps: PluginCopyEvidenceStamps | undefined,
): Promise<Buffer> {
  // The recheck's own path stat, not this handle's: Windows can serve the two
  // through different file-information calls.
  if (stamps) await stampPluginCopyEvidencePath(file, stamps);
  // eslint-disable-next-line admitted-writers/no-unadmitted-write -- opens provider evidence O_RDONLY to read it, never a plugin_cache payload; remove when namespace matching ignores read-only opens.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PLUGIN_COPY_EVIDENCE_FILE_MAX_BYTES)
      throw new Error(`Skipped a non-regular or oversized file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Unknown suppresses maintenance only; business readers keep their existing recovery. */
export function readPluginCopyJson<T>(
  file: string,
  accepts: (value: unknown) => value is T,
  stamps?: PluginCopyEvidenceStamps,
): Promise<PluginCopyEvidence<T>>;
export function readPluginCopyJson(
  file: string,
  accepts?: (value: unknown) => boolean,
  stamps?: PluginCopyEvidenceStamps,
): Promise<PluginCopyEvidence<unknown>>;
export async function readPluginCopyJson(
  file: string,
  accepts: (value: unknown) => boolean = isPluginCopyEvidenceRecord,
  stamps?: PluginCopyEvidenceStamps,
): Promise<PluginCopyEvidence<unknown>> {
  try {
    const bytes = await readBoundedEvidenceFile(file, stamps);
    let text: string;
    try {
      // Keep BOMs for JSON.parse, matching legacy fs UTF-8 reads.
      text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      taintPluginCopyEvidence();
      text = bytes.toString('utf-8');
    }
    const value: unknown = JSON.parse(text);
    observePluginCopyReferences(value, getPluginCacheDir());
    if (accepts(value)) return { state: 'present', value };
  } catch (error) {
    if (isMissingEvidence(error)) {
      recordEvidenceStamp(stamps, file, ABSENT_STAMP);
      return { state: 'absent' };
    }
    recordEvidenceStamp(stamps, file, UNMATCHABLE_STAMP);
  }
  taintPluginCopyEvidence();
  return { state: 'unknown' };
}

/** Evidence shape checks must not discard values legacy readers tolerated. */
export async function readPluginCopyJsonWithRecovery<T>(
  file: string,
  accepts: (value: unknown) => value is T,
): Promise<T | null> {
  const evidence = await readPluginCopyJson(file, accepts);
  if (evidence.state === 'present') return evidence.value;
  return evidence.state === 'unknown' ? safeReadJsonAsync<T>(file) : null;
}

/** A file a registry names must exist: its absence is a disagreement, not an empty inventory. */
export async function readRegistryNamedJsonWithRecovery<T>(
  file: string,
  accepts: (value: unknown) => value is T,
): Promise<T | null> {
  const evidence = await readPluginCopyJson(file, accepts);
  if (evidence.state === 'present') return evidence.value;
  if (evidence.state === 'absent') {
    taintPluginCopyEvidence();
    return null;
  }
  return safeReadJsonAsync<T>(file);
}

export function isPluginCopyManifest(
  value: unknown,
): value is Record<string, unknown> & { plugins: unknown[] } {
  return isPluginCopyEvidenceRecord(value) && Array.isArray(value.plugins);
}

export function isPluginCopyInstallMetadata(value: unknown): boolean {
  return isPluginCopyEvidenceRecord(value) && typeof value.source === 'string';
}

/** A row whose copy cannot be located protects nothing, so it cannot prove absence.
 * Windows drive-relative paths count as absolute but name no copy the sweep can place. */
function isLocatablePath(value: unknown): boolean {
  return (
    typeof value === 'string' && pluginCopyPathIdentity(value) !== undefined
  );
}

export function readPluginCopyProviderFile(
  file: string,
  stamps?: PluginCopyEvidenceStamps,
): Promise<PluginCopyEvidence<unknown>> {
  return readPluginCopyJson(
    file,
    (value) =>
      isPluginCopyEvidenceRecord(value) &&
      (basename(file) === 'installed_plugins.json'
        ? isPluginCopyEvidenceRecord(value.plugins) &&
          // Singleton records match claude-enabled-plugins' readers.
          Object.values(value.plugins).every((rows) =>
            (Array.isArray(rows) ? rows : [rows]).every(
              (row) =>
                isPluginCopyEvidenceRecord(row) &&
                isLocatablePath(installPathOf(row)),
            ),
          )
        : Object.values(value).every(
            (entry) =>
              isPluginCopyEvidenceRecord(entry) &&
              isPluginCopyEvidenceRecord(entry.source) &&
              isLocatablePath(entry.installLocation),
          )),
    stamps,
  );
}

/**
 * Claude's marketplace registry and every manifest it names, as the identity
 * reader locates them. Refresh enrols them before discovery and the sweep
 * rereads them, stamped, so a registration added in between is judged too.
 * Present holds the registry and each manifest; a named manifest that is not
 * present is unknown.
 */
export async function readClaudeMarketplaceRegistryEvidence(
  file: string,
  stamps?: PluginCopyEvidenceStamps,
): Promise<PluginCopyEvidence<unknown[]>> {
  const registry = await readPluginCopyProviderFile(file, stamps);
  if (registry.state === 'absent') return registry;
  if (
    registry.state === 'unknown' ||
    !isPluginCopyEvidenceRecord(registry.value)
  ) {
    taintPluginCopyEvidence();
    return { state: 'unknown' };
  }
  const manifests = await Promise.all(
    Object.values(registry.value).map(
      (entry): Promise<PluginCopyEvidence<unknown>> =>
        isPluginCopyEvidenceRecord(entry) &&
        typeof entry.installLocation === 'string'
          ? readPluginCopyJson(
              join(entry.installLocation, '.claude-plugin', 'marketplace.json'),
              isPluginCopyManifest,
              stamps,
            )
          : Promise.resolve({ state: 'unknown' }),
    ),
  );
  const documents: unknown[] = [registry.value];
  for (const manifest of manifests) {
    if (manifest.state !== 'present') {
      taintPluginCopyEvidence();
      return { state: 'unknown' };
    }
    documents.push(manifest.value);
  }
  return { state: 'present', value: documents };
}

interface ProviderListing {
  marketplaces: Array<{
    name: string;
    path: string | null;
    plugins: Array<{ name: string }>;
  }>;
}

function isProviderEnvelope(value: unknown): value is ProviderListing {
  return (
    isPluginCopyEvidenceRecord(value) &&
    Array.isArray(value.marketplaceLoadErrors) &&
    value.marketplaceLoadErrors.length === 0 &&
    Array.isArray(value.marketplaces) &&
    value.marketplaces.every(
      (entry: unknown) =>
        isPluginCopyEvidenceRecord(entry) &&
        typeof entry.name === 'string' &&
        (entry.path === null || isLocatablePath(entry.path)) &&
        Array.isArray(entry.plugins) &&
        entry.plugins.every(
          (plugin: unknown) =>
            isPluginCopyEvidenceRecord(plugin) &&
            typeof plugin.name === 'string' &&
            isProviderSource(plugin.source),
        ),
    )
  );
}

function isProviderSource(value: unknown): boolean {
  if (!isPluginCopyEvidenceRecord(value)) return false;
  switch (value.type) {
    case 'local':
      return isLocatablePath(value.path);
    case 'git':
      return typeof value.url === 'string';
    case 'npm':
      return typeof value.package === 'string';
    case 'remote':
      return true;
    default:
      return false;
  }
}

function isEmptyManifest(value: unknown): boolean {
  return isPluginCopyManifest(value) && value.plugins.length === 0;
}

/**
 * Codex reports a missing or unreadable manifest as an empty marketplace, so
 * an empty listing counts only when the manifest it names is empty too. A
 * listed curated marketplace must list every plugin its manifest names.
 * `plugin/installed` names installed plugins only: it is checked for shape.
 */
async function judgesCodexListingComplete(
  response: unknown,
  request: 'plugin/list' | 'plugin/installed',
  curatedCodex: PluginCopySweepEvidence['curatedCodex'],
): Promise<boolean> {
  if (!isProviderEnvelope(response)) return false;
  if (request === 'plugin/installed') return true;
  for (const marketplace of response.marketplaces) {
    if (marketplace.plugins.length > 0) continue;
    // An empty remote-only marketplace has no manifest to confirm it.
    if (marketplace.path === null) return false;
    const manifest = await readPluginCopyJson(
      marketplace.path,
      isEmptyManifest,
    );
    if (manifest.state !== 'present') return false;
  }
  const curated = response.marketplaces.find(
    (marketplace) => marketplace.name === curatedCodex.marketplaceName,
  );
  if (!curated) return true;
  const manifest = await readPluginCopyJson(
    curatedCodex.manifestPath,
    isPluginCopyManifest,
  );
  if (manifest.state !== 'present') return false;
  const listed = new Set(
    curated.plugins.map((plugin) => plugin.name.toLowerCase()),
  );
  return manifest.value.plugins.every(
    (entry) =>
      !isPluginCopyEvidenceRecord(entry) ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      listed.has(entry.name.toLowerCase()),
  );
}

/** A failed probe cannot confirm absence. */
async function isCodexExecutableFreshlyAbsent(): Promise<boolean> {
  return !(await probeCodexExecutableInstalled().catch(() => true));
}

/**
 * Absence is judged again before deleting: a Codex CLI restored since its
 * listing failed may hold registrations no listing reported.
 */
export async function reconfirmsPluginCopyProviderAbsence(): Promise<boolean> {
  const evidence = openEvidence();
  if (evidence?.codex !== 'absent') return true;
  if (await isCodexExecutableFreshlyAbsent()) return true;
  evidence.codex = 'unknown';
  return false;
}

/**
 * The admission recheck before each deletion: every stamped evidence file is
 * unchanged, `unchanged` holds, and an absent Codex is still absent. A failure
 * taints the refresh, so later candidates are refused without further I/O.
 */
export async function reconfirmsPluginCopyEvidence(
  stamps: ReadonlyMap<string, string>,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  if (!admitsPluginCopySweep()) return false;
  const checks = [
    ...Array.from(
      stamps,
      async ([file, stamp]) => (await currentEvidenceStamp(file)) === stamp,
    ),
    unchanged(),
    reconfirmsPluginCopyProviderAbsence(),
  ].map((check) => check.catch(() => false));
  if ((await Promise.all(checks)).every(Boolean)) return true;
  taintPluginCopyEvidence();
  return false;
}

/** Observe bounded responses before DTO reduction; failure only suppresses maintenance.
 * A missing Codex CLI is absent evidence: it runs no copy, and unknown would never reclaim.
 * The executable check caches a miss, so absence needs a fresh probe. */
export async function readPluginCopyProviderEvidence<
  T extends { marketplaceLoadErrors: readonly unknown[] },
>(
  request: 'plugin/list' | 'plugin/installed',
  read: () => Promise<T>,
): Promise<T> {
  const evidence = openEvidence();
  let response: T;
  try {
    response = await read();
  } catch (error) {
    if (evidence && error instanceof CodexNotInstalledError) {
      if (!(await isCodexExecutableFreshlyAbsent())) evidence.codex = 'unknown';
      else if (evidence.codex === 'unread') evidence.codex = 'absent';
    } else if (evidence) evidence.codex = 'unknown';
    throw error;
  }
  observePluginCopyReferences(response, getPluginCacheDir());
  // Unknown is sticky: later responses cannot restore it, so skip their reads.
  if (evidence && evidence.codex !== 'unknown') {
    if (
      !(await judgesCodexListingComplete(
        response,
        request,
        evidence.curatedCodex,
      ))
    )
      evidence.codex = 'unknown';
    else if (
      request === 'plugin/list' &&
      (evidence.codex === 'unread' || evidence.codex === 'absent')
    )
      evidence.codex = 'complete';
  }
  return response;
}
