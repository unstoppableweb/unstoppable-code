import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classifyHarnessCompatibility,
  cursorPluginFacetProvider,
  PLUGIN_HARNESSES as OFFERED_PLUGIN_HARNESSES,
  type CompatibilityFacetEvidence,
  type PublisherPluginManifest,
} from '@canopy/plugin-interop';
import { opencodeSupportsCommandHook } from '@canopy/plugin-interop/opencode-support';
import {
  ITEM_HARNESS_INSTALL_REASON_MAX_LENGTH,
  ITEM_HARNESS_INSTALLS_VERSION,
  harnessInstallItemKey,
  isItemInstallHarness,
  itemHarnessInstallPlan,
  parseItemHarnessInstalls,
  type HarnessCompatibility,
  type HarnessCompatibilityHarness,
  type HarnessInstallItemRef,
  type InstallItemForHarnessesRequest,
  type ItemHarnessInstallState,
  type ItemHarnessInstalls,
  type MarketplaceInfo,
  type PluginDetails,
  type PluginInfo,
  type PluginStandInCandidate,
  type RetryItemHarnessInstallRequest,
} from '@canopy/protocol/plugins';
import type { ConfirmedSetUpHarnesses } from '../lib/confirm-set-up-harnesses';
import {
  createHarnessInstallRecordStore,
  type HarnessInstallRecordStore,
  type HarnessInstallStoreDisk,
} from '../lib/harness-install-store';
import { getPluginHarnessInstallsFilePath } from '../lib/paths';

// Experimental Antigravity has no qualified per-harness install record.
const PLUGIN_HARNESSES = OFFERED_PLUGIN_HARNESSES.filter(
  (id): id is HarnessCompatibilityHarness => id !== 'antigravity',
);

// ---------------------------------------------------------------------------
// One Add for every harness, for plugins and skills (CAN-6816, behind the
// `customize-discovery` Labs experiment; the renderer only calls this while
// it is on). The MCP server version (CAN-6815, `../mcp/harness-installs.ts`)
// is the pattern.
//
// Canopy keeps the install it always made: the plugin's Claude and Codex
// installs, or the skill's folder. Every harness session loads plugins and
// skills from that install when it starts, through its own adapter: Claude
// Code takes the plugin folder (and, for a Codex-only plugin one Add
// installed for it, the plugin's skills), Codex takes its native facet or
// the projection of the Claude one, and Cursor, Copilot and OpenCode project
// the facet a Cursor session reads. Canopy writes no harness config file.
//
// Installing for a harness checks the install that harness's session would
// read, exactly as the session reads it, and records whether it loads
// anything and what it leaves out. The record lives in its own file: the
// plugin cache, its ids and its provider installs are never rewritten, and
// older app versions keep using the install as before.
// ---------------------------------------------------------------------------

const HARNESS_LABELS: Record<HarnessCompatibilityHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

/** An installed plugin, as each harness's session finds it on disk. */
export interface StagedPlugin {
  readonly kind: 'plugin';
  /** The Claude facet's installed folder, or `null`. */
  readonly claudePath: string | null;
  /** The native Codex facet's installed folder, or `null`. */
  readonly codexPath: string | null;
  /** The user turned the Claude plugin's Codex compatibility off. */
  readonly codexCompatDisabled: boolean;
  /** The facet a Cursor-family session reads, as the session picks it. */
  readonly cursorProvider: 'claude' | 'codex';
  /** OpenCode runs a Claude plugin's command hooks. */
  readonly opencodeCommandHooks: number;
  readonly compatibility: HarnessCompatibility | undefined;
  /**
   * The hosts of the http MCP servers each installed facet bundles, read
   * from the installed copy (CAN-6818), so a harness that already loads the
   * publisher's server is said to.
   */
  readonly mcpHosts?: Readonly<Record<'claude' | 'codex', readonly string[]>>;
}

/** An installed skill, as each harness's session finds it on disk. */
export interface StagedSkill {
  readonly kind: 'skill';
  /** The skill folder holding `SKILL.md`, or `null`. */
  readonly dir: string | null;
  /** The canonical folder a Cursor-family session copies, or `null`. */
  readonly cursorDir: string | null;
}

export type StagedItem = StagedPlugin | StagedSkill;

/** How many members a harness's session loads from one installed folder. */
export type PluginMemberCounter = (
  pluginPath: string,
  provider: 'claude' | 'codex',
  target: 'claude' | 'cursor',
) => number;

/**
 * Checks one harness against the install its session reads. Returns whether
 * the publisher's own version or a converted one loads; throws why nothing
 * loads.
 */
export type ItemHarnessStager = (
  item: StagedItem,
) => 'native' | 'converted' | Promise<'native' | 'converted'>;

function refused(harness: HarnessCompatibilityHarness, reason: string): Error {
  return new Error(reason || `${HARNESS_LABELS[harness]} can't load this.`);
}

const MISSING_FILES = "This plugin's installed files are missing.";

/**
 * The stagers each harness's session matches. `count` reads members the way
 * the session does: the plugin's skills and MCP servers for a Claude session
 * reading a Codex plugin, and the Cursor-family listing for the others.
 */
export function createItemHarnessStagers(
  count: PluginMemberCounter,
): Record<HarnessCompatibilityHarness, ItemHarnessStager> {
  const skill = (
    harness: HarnessCompatibilityHarness,
    item: StagedSkill,
  ): 'native' => {
    const dir =
      harness === 'cursor' || harness === 'copilot' || harness === 'opencode'
        ? item.cursorDir
        : item.dir;
    if (dir === null)
      throw refused(
        harness,
        item.dir === null
          ? "This skill's installed files are missing."
          : `${HARNESS_LABELS[harness]} only loads skills inside the skills folder.`,
      );
    return 'native';
  };
  const cursorFamily =
    (harness: 'cursor' | 'copilot' | 'opencode'): ItemHarnessStager =>
    (item) => {
      if (item.kind === 'skill') return skill(harness, item);
      const folder =
        item.cursorProvider === 'claude' ? item.claudePath : item.codexPath;
      if (folder === null) throw refused(harness, MISSING_FILES);
      const loaded =
        count(folder, item.cursorProvider, 'cursor') +
        (harness === 'opencode' ? item.opencodeCommandHooks : 0);
      if (loaded === 0)
        throw refused(
          harness,
          `Nothing in it runs in ${HARNESS_LABELS[harness]}.`,
        );
      // The session projects the Claude or Codex facet; it never loads a
      // publisher's Cursor or Copilot manifest, so this is always converted.
      return 'converted';
    };
  return {
    claude: (item) => {
      if (item.kind === 'skill') return skill('claude', item);
      if (item.claudePath !== null) return 'native';
      if (item.codexPath === null) throw refused('claude', MISSING_FILES);
      if (count(item.codexPath, 'codex', 'claude') === 0)
        throw refused('claude', 'Nothing in it runs in Claude Code.');
      return 'converted';
    },
    codex: (item) => {
      if (item.kind === 'skill') return skill('codex', item);
      if (item.codexPath !== null) return 'native';
      if (item.claudePath === null) throw refused('codex', MISSING_FILES);
      if (item.codexCompatDisabled)
        throw refused(
          'codex',
          "Codex compatibility is off for this plugin. Turn it on in the plugin's details.",
        );
      return 'converted';
    },
    cursor: cursorFamily('cursor'),
    copilot: cursorFamily('copilot'),
    opencode: cursorFamily('opencode'),
  };
}

// ---------------------------------------------------------------------------
// Compatibility for plugins the catalog has not rated (local marketplaces).
// ---------------------------------------------------------------------------

function detailsEvidence(details: PluginDetails): CompatibilityFacetEvidence {
  return {
    complete: true,
    rootApp: false,
    inventory: {
      skills: details.skills,
      commands: details.commands,
      agents: details.agents,
      apps: details.apps ?? [],
      hooks: details.hooks,
      mods: details.mods ?? [],
      mcpServers: details.mcpServers,
      lspServers: details.lspServers,
    },
    // Every harness's adapter loads a plugin's MCP servers.
    mcpHarnesses: details.mcpServers.map(() => PLUGIN_HARNESSES),
  };
}

const CURSOR_FAMILY: readonly HarnessCompatibilityHarness[] = [
  'cursor',
  'copilot',
  'opencode',
];

/**
 * The plugin's rating as this app's sessions load it: the catalog's, with
 * two corrections from the same rules over the scanned Claude and native
 * Codex facets, or those rules alone when the catalog has no rating.
 *
 * - A rating made before Claude Code converted Codex plugins (CAN-6816) still
 *   says `no_conversion`; the local rule replaces it.
 * - A Cursor-family session projects the Claude or Codex facet and never
 *   loads a publisher's Cursor or Copilot manifest, so a `native` rating
 *   there is replaced by what the facet rule says that session loads.
 */
export function pluginHarnessCompatibility(
  plugin: PluginInfo,
): HarnessCompatibility | undefined {
  const local = localPluginHarnessCompatibility(plugin);
  const catalog = plugin.harnessCompatibility;
  if (catalog === undefined) return local;
  const harnesses: HarnessCompatibility['harnesses'] = {
    ...catalog.harnesses,
  };
  for (const harness of PLUGIN_HARNESSES) {
    const rated = harnesses[harness];
    const stale =
      (rated?.level === 'unsupported' && rated.reason === 'no_conversion') ||
      (rated?.level === 'native' && CURSOR_FAMILY.includes(harness));
    if (!stale) continue;
    const derived = local?.harnesses[harness];
    if (derived === undefined) delete harnesses[harness];
    else harnesses[harness] = derived;
  }
  return { ...catalog, harnesses };
}

function localPluginHarnessCompatibility(
  plugin: PluginInfo,
): HarnessCompatibility | undefined {
  const claude = plugin.facets.claude?.details;
  const codex = plugin.facets.codex?.details;
  const manifests: PublisherPluginManifest[] = [];
  if (plugin.facets.claude)
    manifests.push({
      path: '.claude-plugin/plugin.json',
      manifest: { name: plugin.facets.claude.name },
    });
  if (plugin.facets.codex)
    manifests.push({
      path: '.codex-plugin/plugin.json',
      manifest: { name: plugin.facets.codex.name },
    });
  if (!claude && !codex) return undefined;
  return classifyHarnessCompatibility({
    kind: 'plugin',
    publisherManifests: manifests,
    facets: {
      ...(claude ? { claude: detailsEvidence(claude) } : {}),
      ...(codex ? { codex: detailsEvidence(codex) } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Record store: `plugin-harness-installs.json`.
// ---------------------------------------------------------------------------

/** A newer app wrote the record file; this one only reads around it. */
export class ItemHarnessInstallsNewerError extends Error {
  constructor() {
    super('A newer version of the app saved these install records.');
    this.name = 'ItemHarnessInstallsNewerError';
  }
}

export type ItemHarnessInstallStore =
  HarnessInstallRecordStore<ItemHarnessInstalls>;

export function createItemHarnessInstallStore(
  filePath: () => string = getPluginHarnessInstallsFilePath,
  disk?: HarnessInstallStoreDisk,
): ItemHarnessInstallStore {
  return createHarnessInstallRecordStore({
    path: filePath,
    collection: 'items',
    parse: parseItemHarnessInstalls,
    newerError: () => new ItemHarnessInstallsNewerError(),
    ...(disk !== undefined ? { disk } : {}),
  });
}

// ---------------------------------------------------------------------------
// Install, retry, forget, serve.
// ---------------------------------------------------------------------------

export interface ItemHarnessInstallDeps {
  readonly store: ItemHarnessInstallStore;
  readonly loadItem: (
    item: HarnessInstallItemRef,
  ) => Promise<StagedItem | undefined>;
  readonly stagers: Record<HarnessCompatibilityHarness, ItemHarnessStager>;
  readonly now: () => string;
  /** Harnesses this process checks on its own (see the MCP version). */
  readonly confirmedSetUpHarnesses?: () => Promise<ConfirmedSetUpHarnesses>;
  /**
   * The version and digest of the copy a harness's session reads (CAN-6817),
   * kept with its installed state so a later change outside the app shows.
   * `undefined` when the copy cannot be read; nothing is flagged then.
   */
  readonly describeCopy?: (copy: HarnessCopy) => HarnessCopyFacts | undefined;
  /**
   * Puts back a plugin copy removed outside the app, the way a session
   * restores it, for Try again (CAN-6817). Restores what it can and never
   * throws for what it cannot; the check after it records the result.
   */
  readonly restoreItem?: (item: HarnessInstallItemRef) => Promise<void>;
  /** The publisher's MCP server for a ChatGPT app (CAN-6818). */
  readonly standIns?: ItemStandInHooks;
}

/**
 * Where one Add and Try again hand a plugin to its ChatGPT app's stand-in
 * (CAN-6818, `./stand-ins.ts`). Neither throws: the plugin's own record is
 * already written, and a stand-in that fails shows on the row.
 */
export interface ItemStandInHooks {
  /**
   * Taken before an install or Try again's first step and handed back to
   * the calls below, so an uninstall at any point after it cancels the
   * stand-in work.
   */
  readonly begin: (key: string) => number;
  /**
   * After a plugin's record is written. `candidate` is the one the request
   * carried; without one, the plugin's earlier stand-in is used.
   */
  readonly afterInstall: (
    key: string,
    record: ItemHarnessInstalls,
    staged: StagedPlugin,
    candidate: PluginStandInCandidate | undefined,
    mode: 'add' | 'catch-up',
    token: number,
  ) => Promise<void>;
  /**
   * After Try again checked one harness of a plugin again: its stand-in,
   * worked out from that fresh result, when it has one.
   */
  readonly retry: (
    key: string,
    harness: HarnessCompatibilityHarness,
    record: ItemHarnessInstalls,
    staged: StagedPlugin,
    token: number,
  ) => Promise<void>;
}

/** The folder one harness's session reads an item from (CAN-6817). */
export interface HarnessCopy {
  readonly folder: string;
  /** The facet a plugin folder is read as; `skill` for a skill folder. */
  readonly provider: 'claude' | 'codex' | 'skill';
}

/** What {@link ItemHarnessInstallDeps.describeCopy} reads from a copy. */
export interface HarnessCopyFacts {
  readonly version?: string;
  readonly fingerprint: string;
}

/**
 * The copy one harness's session reads, as the stagers pick it: a skill's
 * folder (the canonical one for the Cursor family), a plugin's native facet
 * first, otherwise the facet it converts, and for the Cursor family the facet
 * its session projects. `null` when that copy is not on disk.
 */
export function harnessCopy(
  item: StagedItem,
  harness: HarnessCompatibilityHarness,
  /**
   * The copy a recorded state read: Claude Code and Codex read their own
   * facet when `native` and the other one when `converted`, with no
   * fallback, so a removed copy reads as removed.
   */
  via?: 'native' | 'converted',
): HarnessCopy | null {
  const cursorFamily = CURSOR_FAMILY.includes(harness);
  if (item.kind === 'skill') {
    const folder = cursorFamily ? item.cursorDir : item.dir;
    return folder === null ? null : { folder, provider: 'skill' };
  }
  const facet = (provider: 'claude' | 'codex'): HarnessCopy | null => {
    const folder = provider === 'claude' ? item.claudePath : item.codexPath;
    return folder === null ? null : { folder, provider };
  };
  if (cursorFamily) return facet(item.cursorProvider);
  const own = harness === 'claude' ? 'claude' : 'codex';
  const other = own === 'claude' ? 'codex' : 'claude';
  if (via === 'native') return facet(own);
  if (via === 'converted') return facet(other);
  return facet(own) ?? facet(other);
}

function failureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return (message || 'This harness did not accept it.').slice(
    0,
    ITEM_HARNESS_INSTALL_REASON_MAX_LENGTH,
  );
}

function compatibilityOf(item: StagedItem): HarnessCompatibility | undefined {
  return item.kind === 'plugin' ? item.compatibility : undefined;
}

async function stage(
  deps: ItemHarnessInstallDeps,
  harness: HarnessCompatibilityHarness,
  item: StagedItem,
): Promise<ItemHarnessInstallState> {
  const plan = itemHarnessInstallPlan(compatibilityOf(item), harness);
  if (plan?.action === 'skip')
    return { status: 'skipped', reason: plan.reason, updatedAt: deps.now() };
  try {
    const via = await deps.stagers[harness](item);
    const leftOut = plan?.leftOut ?? [];
    const copy = harnessCopy(item, harness, via);
    const facts = copy === null ? undefined : deps.describeCopy?.(copy);
    return {
      status: 'installed',
      // The stager knows which install the session reads.
      via,
      ...(leftOut.length > 0 ? { leftOut } : {}),
      ...(facts?.version !== undefined ? { version: facts.version } : {}),
      ...(facts !== undefined ? { fingerprint: facts.fingerprint } : {}),
      updatedAt: deps.now(),
    };
  } catch (cause) {
    return {
      status: 'failed',
      reason: failureReason(cause),
      updatedAt: deps.now(),
    };
  }
}

async function requireItem(
  deps: ItemHarnessInstallDeps,
  item: HarnessInstallItemRef,
): Promise<StagedItem> {
  const staged = await deps.loadItem(item);
  if (staged === undefined)
    throw new Error(
      item.kind === 'plugin'
        ? 'This plugin is not installed.'
        : 'This skill is not installed.',
    );
  return staged;
}

/**
 * Checks an installed plugin or skill against each set-up harness, one at a
 * time, then commits the record: installed (native or converted, with what
 * is left out), skipped with why when nothing useful loads, or failed with
 * why. No harness to record writes nothing.
 */
export async function installItemForHarnesses(
  deps: ItemHarnessInstallDeps,
  request: InstallItemForHarnessesRequest,
): Promise<ItemHarnessInstalls | null> {
  const key = harnessInstallItemKey(request.item);
  // Checked again when the record is written: an uninstall while the
  // harnesses are checked discards this Add rather than recreating it.
  const generation = uninstallGeneration(key);
  const standInToken = deps.standIns?.begin(key) ?? 0;
  const startedAt = deps.now();
  const staged = await requireItem(deps, request.item);
  const checked: ConfirmedSetUpHarnesses =
    (await deps.confirmedSetUpHarnesses?.()) ?? { confirmed: [], pending: [] };
  const setUp = new Set(
    [...request.harnesses, ...checked.confirmed].filter(isItemInstallHarness),
  );
  // Catching up checks only harnesses the record has no state for: a
  // recorded one (for example a copy flagged as changed outside the app)
  // is neither checked again nor rewritten (CAN-6817).
  const recorded =
    request.mode === 'catch-up' ? (await deps.store.read())[key] : undefined;
  const absent = (harness: HarnessCompatibilityHarness): boolean =>
    recorded?.harnesses[harness] === undefined;
  const targets = PLUGIN_HARNESSES.filter(
    (harness) => setUp.has(harness) && absent(harness),
  );
  // A harness whose setup check never answered is recorded as failed, not
  // dropped, so its row offers Try again once it is ready. One that cannot
  // load the item is skipped either way.
  const pending = PLUGIN_HARNESSES.filter(
    (harness) =>
      !setUp.has(harness) &&
      absent(harness) &&
      [...(request.pendingHarnesses ?? []), ...checked.pending].includes(
        harness,
      ),
  );
  if (targets.length === 0 && pending.length === 0) return recorded ?? null;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessInstallState>
  > = {};
  for (const harness of targets)
    harnesses[harness] = await stage(deps, harness, staged);
  for (const harness of pending) {
    const plan = itemHarnessInstallPlan(compatibilityOf(staged), harness);
    harnesses[harness] =
      plan?.action === 'skip'
        ? { status: 'skipped', reason: plan.reason, updatedAt: deps.now() }
        : {
            status: 'failed',
            reason: "Its setup check didn't finish in time.",
            updatedAt: deps.now(),
          };
  }
  const now = deps.now();
  // Merged into the latest record in one store step, so a concurrent Add or
  // Try again for the same item keeps its own harnesses.
  let uninstalled = false;
  const record = await deps.store.update(key, (existing) => {
    if (uninstallGeneration(key) !== generation) {
      uninstalled = true;
      return existing;
    }
    // A new Add keeps only what changed after it started (a concurrent Add
    // or Try again); anything older, such as a record a failed uninstall
    // left behind, is replaced. Catching up a newly set-up harness only adds
    // harnesses the latest record has no state for: a recorded state, such
    // as one whose copy was removed outside the app, is never rewritten.
    const catchUp = request.mode === 'catch-up';
    const kept = catchUp ? existing : keepChangedSince(existing, startedAt);
    const added = catchUp
      ? onlyAbsent(harnesses, existing?.harnesses)
      : harnesses;
    return {
      version: ITEM_HARNESS_INSTALLS_VERSION,
      harnesses: { ...kept?.harnesses, ...added },
      createdAt: kept?.createdAt ?? now,
      updatedAt: now,
    };
  });
  if (uninstalled || record === undefined) return null;
  if (staged.kind === 'plugin')
    await deps.standIns?.afterInstall(
      key,
      record,
      staged,
      request.standIn,
      request.mode ?? 'add',
      standInToken,
    );
  return record;
}

/** The states in `fresh` for harnesses `recorded` has no state for. */
function onlyAbsent<S>(
  fresh: Readonly<Partial<Record<HarnessCompatibilityHarness, S>>>,
  recorded:
    | Readonly<Partial<Record<HarnessCompatibilityHarness, unknown>>>
    | undefined,
): Partial<Record<HarnessCompatibilityHarness, S>> {
  const absent: Partial<Record<HarnessCompatibilityHarness, S>> = {};
  for (const harness of PLUGIN_HARNESSES) {
    const state = fresh[harness];
    if (state !== undefined && recorded?.[harness] === undefined)
      absent[harness] = state;
  }
  return absent;
}

/** A record's harness states written at or after `since`, or `undefined`. */
function keepChangedSince(
  record: ItemHarnessInstalls | undefined,
  since: string,
): ItemHarnessInstalls | undefined {
  if (record === undefined) return undefined;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessInstallState>
  > = {};
  for (const harness of PLUGIN_HARNESSES) {
    const state = record.harnesses[harness];
    if (state !== undefined && state.updatedAt >= since)
      harnesses[harness] = state;
  }
  return Object.keys(harnesses).length === 0
    ? undefined
    : { ...record, harnesses };
}

/** What a sync after an update did for one item (CAN-6817). */
export type ItemHarnessResyncOutcome =
  | { readonly kind: 'synced'; readonly record: ItemHarnessInstalls }
  /** No record: the item was never installed for every harness. */
  | { readonly kind: 'no-record' }
  /** The item is not on disk; its record is left as it is. */
  | { readonly kind: 'not-installed' }
  /** It was uninstalled while the harnesses were checked. */
  | { readonly kind: 'uninstalled' };

/**
 * After an item updates (CAN-6817): checks every harness its record lists
 * against the new version, the way one Add did, and records each result,
 * with the version and digest of the copy each one reads, so every harness
 * ends on the version now installed. Harnesses the record does not list are
 * left out; a harness changed by an Add or Try again while this ran keeps
 * that newer state. One record write at the end: quitting midway leaves the
 * old record, and the row then shows the change with Try again.
 */
export async function resyncItemHarnessInstalls(
  deps: ItemHarnessInstallDeps,
  item: HarnessInstallItemRef,
): Promise<ItemHarnessResyncOutcome> {
  const key = harnessInstallItemKey(item);
  const generation = uninstallGeneration(key);
  const standInToken = deps.standIns?.begin(key) ?? 0;
  const startedAt = deps.now();
  const existing = (await deps.store.read())[key];
  if (existing === undefined) return { kind: 'no-record' };
  // Not on disk right now (mid-update, or removed): unknown, not uninstalled,
  // so the record stays as it is.
  const staged = await deps.loadItem(item);
  if (staged === undefined) return { kind: 'not-installed' };
  const fresh: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessInstallState>
  > = {};
  for (const harness of PLUGIN_HARNESSES) {
    const state = existing.harnesses[harness];
    if (state === undefined) continue;
    // A recorded copy removed outside the app keeps its state, so the row
    // keeps offering its repair instead of the other copy taking its place.
    if (
      state.status === 'installed' &&
      harnessCopy(staged, harness, state.via) === null
    )
      continue;
    fresh[harness] = await stage(deps, harness, staged);
  }
  const now = deps.now();
  let gone = false;
  const record = await deps.store.update(key, (latest) => {
    if (latest === undefined || uninstallGeneration(key) !== generation) {
      gone = true;
      return latest;
    }
    const harnesses = { ...latest.harnesses };
    for (const harness of PLUGIN_HARNESSES) {
      const state = fresh[harness];
      const current = latest.harnesses[harness];
      if (state === undefined) continue;
      // Changed while this ran: the newer state wins.
      if (current !== undefined && current.updatedAt > startedAt) continue;
      harnesses[harness] = state;
    }
    return { ...latest, harnesses, updatedAt: now };
  });
  if (gone || record === undefined) return { kind: 'uninstalled' };
  // The new version may no longer bundle the publisher's server (or may
  // start to): each harness's stand-in route is worked out again from the
  // synced record, with the plugin's stored candidate (CAN-6818).
  if (staged.kind === 'plugin')
    await deps.standIns?.afterInstall(
      key,
      record,
      staged,
      undefined,
      'add',
      standInToken,
    );
  return { kind: 'synced', record };
}

/** Why a harness's copy shows as changed outside the app. */
const OUTSIDE_CHANGE_REASONS: Record<'changed' | 'removed', string> = {
  changed: 'Its files changed outside the app.',
  removed: 'Its files were removed outside the app.',
};

/**
 * The record a row is served (CAN-6817): each installed harness whose copy
 * was removed, or whose digest no longer matches the one recorded, is served
 * as failed with `outsideChange`, so the row warns and its Try again
 * repairs it. Never saved. A state without a digest (an older app's) and a
 * copy that cannot be read are served as recorded: unknown is not changed.
 * `staged` `undefined` means the item could not be read; nothing is flagged.
 */
export function servedItemHarnessInstalls(
  record: ItemHarnessInstalls,
  staged: StagedItem | undefined,
  describeCopy: (copy: HarnessCopy) => HarnessCopyFacts | undefined,
): ItemHarnessInstalls {
  if (staged === undefined) return record;
  let changed = false;
  const harnesses = { ...record.harnesses };
  for (const harness of PLUGIN_HARNESSES) {
    const state = record.harnesses[harness];
    if (state?.status !== 'installed' || state.fingerprint === undefined)
      continue;
    const copy = harnessCopy(staged, harness, state.via);
    let outsideChange: 'changed' | 'removed' | undefined;
    if (copy === null) outsideChange = 'removed';
    else {
      const facts = describeCopy(copy);
      if (facts !== undefined && facts.fingerprint !== state.fingerprint)
        outsideChange = 'changed';
    }
    if (outsideChange === undefined) continue;
    changed = true;
    harnesses[harness] = {
      status: 'failed',
      reason: OUTSIDE_CHANGE_REASONS[outsideChange],
      outsideChange,
      updatedAt: state.updatedAt,
    };
  }
  return changed ? { ...record, harnesses } : record;
}

// Uninstalls this process has seen, per record key. An Add or Try again
// that started before one never writes its record after it.
const uninstallGenerations = new Map<string, number>();

function uninstallGeneration(key: string): number {
  return uninstallGenerations.get(key) ?? 0;
}

/** Marks an item uninstalled, so checks already running discard results. */
export function noteItemUninstalled(key: string): void {
  uninstallGenerations.set(key, uninstallGeneration(key) + 1);
}

/** Checks one harness of an earlier install again and records the result. */
export async function retryItemHarnessInstall(
  deps: ItemHarnessInstallDeps,
  request: RetryItemHarnessInstallRequest,
  /**
   * `restore: false` for a remote caller: putting back a removed copy can
   * fetch the plugin's source, which only the person at this desktop starts.
   */
  options: { readonly restore?: boolean } = {},
): Promise<ItemHarnessInstalls> {
  if (!isItemInstallHarness(request.harness))
    throw new Error('Unknown harness.');
  const key = harnessInstallItemKey(request.item);
  const generation = uninstallGeneration(key);
  const standInToken = deps.standIns?.begin(key) ?? 0;
  const existing = (await deps.store.read())[key];
  if (existing?.harnesses[request.harness] === undefined)
    throw new Error(
      `This was not installed for ${HARNESS_LABELS[request.harness]}.`,
    );
  // Try again is also the repair for a copy removed outside the app
  // (CAN-6817): the copy the recorded state read (native or converted, no
  // fallback) is restored the way a session would before checking again.
  const recorded = existing.harnesses[request.harness];
  const recordedVia =
    recorded?.status === 'installed' ? recorded.via : undefined;
  const missing = (item: StagedItem | undefined): boolean =>
    item === undefined ||
    harnessCopy(item, request.harness, recordedVia) === null;
  let staged = await deps.loadItem(request.item);
  if (
    deps.restoreItem !== undefined &&
    options.restore !== false &&
    missing(staged)
  ) {
    await deps.restoreItem(request.item);
    staged = await deps.loadItem(request.item);
  }
  if (staged === undefined) staged = await requireItem(deps, request.item);
  // Still missing: the recorded state stays as it is (the row keeps showing
  // the removed copy, and the next Try again restores the same copy) rather
  // than recording the other copy in its place, which would quietly trade
  // the publisher's own version for a converted one.
  if (recordedVia !== undefined && missing(staged))
    throw new Error('Its files are still missing. Remove it and add it again.');
  const state = await stage(deps, request.harness, staged);
  const now = deps.now();
  // Only the retried harness changes, merged into the latest record, so a
  // concurrent retry of another harness is never undone.
  let removed = false;
  const record = await deps.store.update(key, (latest) => {
    if (latest === undefined || uninstallGeneration(key) !== generation) {
      removed = true;
      return latest;
    }
    return {
      ...latest,
      harnesses: { ...latest.harnesses, [request.harness]: state },
      updatedAt: now,
    };
  });
  if (removed || record === undefined)
    throw new Error('This plugin or skill was uninstalled.');
  // The publisher's MCP server standing in for its ChatGPT app is checked
  // again with it (CAN-6818).
  if (staged.kind === 'plugin' && state.status !== 'failed')
    await deps.standIns?.retry(
      key,
      request.harness,
      record,
      staged,
      standInToken,
    );
  return record;
}

/** Whether a record lists this harness as installed. */
export function itemInstalledFor(
  record: ItemHarnessInstalls | undefined,
  harness: HarnessCompatibilityHarness,
): boolean {
  return record?.harnesses[harness]?.status === 'installed';
}

/**
 * Adds each plugin's record to the rows served to a window. Never written
 * into the plugin cache: the result is a fresh copy.
 */
export function withPluginHarnessInstalls<
  T extends { marketplaces: MarketplaceInfo[] },
>(cache: T, records: Readonly<Record<string, ItemHarnessInstalls>>): T {
  if (Object.keys(records).length === 0) return cache;
  return {
    ...cache,
    marketplaces: cache.marketplaces.map((marketplace) => ({
      ...marketplace,
      plugins: marketplace.plugins.map((plugin) => {
        const key = harnessInstallItemKey({
          kind: 'plugin',
          marketplaceId: marketplace.id,
          pluginName: plugin.name,
        });
        const record = Object.prototype.hasOwnProperty.call(records, key)
          ? records[key]
          : undefined;
        return record === undefined
          ? plugin
          : { ...plugin, harnessInstalls: record };
      }),
    })),
  };
}

/** A skill folder's `SKILL.md`, when there is one. */
export function skillFolderOrNull(dir: string): string | null {
  return fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : null;
}

/** The Cursor-family facet and OpenCode command hooks of a plugin row. */
export function pluginSessionFacts(
  plugin: PluginInfo,
): Pick<StagedPlugin, 'cursorProvider' | 'opencodeCommandHooks'> {
  return {
    cursorProvider: cursorPluginFacetProvider(plugin.facets),
    opencodeCommandHooks:
      plugin.facets.claude?.details?.hooks.filter(opencodeSupportsCommandHook)
        .length ?? 0,
  };
}
