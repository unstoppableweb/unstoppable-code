// ---------------------------------------------------------------------------
// One Add for every harness, for plugins and skills (CAN-6816, behind the
// `customize-discovery` Labs experiment). The MCP server record (CAN-6815,
// `@canopy/protocol/mcp-servers`) is the pattern this follows.
//
// Canopy keeps the install it always made (the plugin's Claude and Codex
// installs, or the skill's folder); every harness session loads plugins and
// skills from it when it starts, through that harness's own adapter. Canopy
// writes no harness config file. The record below sits on top of the install:
// it lists the harnesses one Add installed the item for, what each harness
// left out, and the harnesses that could not take it, with why. It never
// holds a URL, header, token or other secret.
//
// Desktop main keeps these records in their own file and adds them to the
// rows it serves, so the plugin cache, its ids and older app versions' reads
// are never touched.
//
// Pure: no Node, Electron, React or app imports.
// ---------------------------------------------------------------------------

import type {
  HarnessCompatibility,
  HarnessCompatibilityHarness,
  HarnessCompatibilityPart,
  HarnessCompatibilityUnsupportedReason,
} from './harness-compatibility';
import {
  CHATGPT_APP_ONLY,
  parseItemHarnessStandIn,
  type ItemHarnessStandIn,
  type PluginStandInCandidate,
} from './stand-ins';

/** Every harness one Add can install for, in the Works with filter's order. */
export const ITEM_INSTALL_HARNESSES: readonly HarnessCompatibilityHarness[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

/** Wire version of {@link ItemHarnessInstalls}. */
export const ITEM_HARNESS_INSTALLS_VERSION = 1;

/** Longest reason a record keeps; longer ones are cut. */
export const ITEM_HARNESS_INSTALL_REASON_MAX_LENGTH = 300;

/** Parts a harness can leave out, in display order. */
const PARTS: readonly HarnessCompatibilityPart[] = [
  'skills',
  'commands',
  'agents',
  'apps',
  'hooks',
  'mods',
  'mcpServers',
  'lspServers',
];

/** What happened when one Add installed an item for one harness. */
export type ItemHarnessInstallState =
  | {
      readonly status: 'installed';
      /** The publisher's own version for this harness, or a converted one. */
      readonly via: 'native' | 'converted';
      /** Parts this harness does not load; absent when it loads everything. */
      readonly leftOut?: readonly HarnessCompatibilityPart[];
      /**
       * The version of the copy this harness's session reads, from its
       * manifest, when it names one (CAN-6817). Absent on records older apps
       * wrote.
       */
      readonly version?: string;
      /**
       * A short digest of the copy this harness's session reads, taken when
       * it was installed, updated or repaired (CAN-6817). A copy whose digest
       * no longer matches was changed outside the app. Absent on records
       * older apps wrote, which are never flagged.
       */
      readonly fingerprint?: string;
      readonly updatedAt: string;
    }
  | {
      /** Nothing useful loads in this harness; never retried. */
      readonly status: 'skipped';
      readonly reason: string;
      readonly updatedAt: string;
    }
  | {
      readonly status: 'failed';
      /** Why, in words the row can show. Never a secret. */
      readonly reason: string;
      /**
       * Served only, never saved (CAN-6817): the copy this harness reads was
       * changed or removed outside the app since it was installed. Try again
       * repairs it.
       */
      readonly outsideChange?: ItemHarnessOutsideChange;
      readonly updatedAt: string;
    };

/** How a harness's copy changed outside the app (CAN-6817). */
export type ItemHarnessOutsideChange = 'changed' | 'removed';

/** The install record one Add writes for one plugin or skill. */
export interface ItemHarnessInstalls {
  readonly version: number;
  readonly harnesses: Readonly<
    Partial<Record<HarnessCompatibilityHarness, ItemHarnessInstallState>>
  >;
  /**
   * Served only, never saved (CAN-6818): the harnesses where the plugin's
   * own copy loads the publisher's MCP server in place of its ChatGPT app.
   */
  readonly standIns?: Readonly<
    Partial<Record<HarnessCompatibilityHarness, ItemHarnessStandIn>>
  >;
  /**
   * Other copies of the same integration one Add installed for harnesses
   * this item can't serve, natively there (Sergii's QA: Slack's Claude
   * plugin beside its Codex one). They go when this item is uninstalled.
   */
  readonly companions?: readonly ItemHarnessCompanion[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A native copy one Add installed for some harnesses (see `companions`). */
export interface ItemHarnessCompanion {
  readonly item: {
    readonly kind: 'plugin';
    readonly marketplaceId: string;
    readonly pluginName: string;
  };
  readonly harnesses: readonly HarnessCompatibilityHarness[];
}

/** At most this many companions ride on one install. */
export const ITEM_HARNESS_COMPANIONS_MAX = 4;

/** Reads a companion list at a trust boundary; bad entries are dropped. */
export function parseItemHarnessCompanions(
  value: unknown,
): ItemHarnessCompanion[] {
  if (!Array.isArray(value)) return [];
  const companions: ItemHarnessCompanion[] = [];
  for (const candidate of value.slice(0, ITEM_HARNESS_COMPANIONS_MAX)) {
    if (!isRecord(candidate) || !isRecord(candidate.item)) continue;
    const item = parseHarnessInstallItemRef(candidate.item);
    if (item === undefined || item.kind !== 'plugin') continue;
    const listed: unknown = candidate.harnesses;
    const harnesses = Array.isArray(listed)
      ? ITEM_INSTALL_HARNESSES.filter((harness) => listed.includes(harness))
      : [];
    if (harnesses.length === 0) continue;
    companions.push({ item, harnesses });
  }
  return companions;
}

/** The item one Add installed, as the record store keys it. */
export type HarnessInstallItemRef =
  | {
      readonly kind: 'plugin';
      readonly marketplaceId: string;
      readonly pluginName: string;
    }
  | {
      readonly kind: 'skill';
      readonly sourceId: string;
      readonly skillName: string;
    };

/** Installs a plugin or skill for these harnesses (CAN-6816). */
export interface InstallItemForHarnessesRequest {
  readonly item: HarnessInstallItemRef;
  /** The harnesses the user has set up; main keeps those that load the item. */
  readonly harnesses: readonly HarnessCompatibilityHarness[];
  /**
   * Harnesses whose setup check had not answered when Add gave up waiting.
   * Main records each one it cannot confirm as failed, so its row offers
   * Try again instead of leaving it out.
   */
  readonly pendingHarnesses?: readonly HarnessCompatibilityHarness[];
  /**
   * `add` (the default) is a new Add: harness states recorded before it
   * started, such as a record a failed uninstall left behind, are replaced.
   * `catch-up` adds harnesses set up since (CAN-6817) and keeps every state
   * already recorded.
   */
  readonly mode?: HarnessInstallMode;
  /**
   * The publisher's MCP server that stands in where the plugin's ChatGPT app
   * doesn't run (CAN-6818): the integration's preferred endpoint, as the
   * catalog grouping picked it. Absent: nothing stands in.
   */
  readonly standIn?: PluginStandInCandidate;
  /**
   * Native copies of the same integration to install for harnesses this
   * item can't serve (see `ItemHarnessInstalls.companions`).
   */
  readonly companions?: readonly ItemHarnessCompanion[];
}

/** Whether an install request is a new Add or adds newly set-up harnesses. */
export type HarnessInstallMode = 'add' | 'catch-up';

/** Retries one harness of an earlier install (CAN-6816). */
export interface RetryItemHarnessInstallRequest {
  readonly item: HarnessInstallItemRef;
  readonly harness: HarnessCompatibilityHarness;
}

export function isItemInstallHarness(
  value: unknown,
): value is HarnessCompatibilityHarness {
  return ITEM_INSTALL_HARNESSES.some((harness) => harness === value);
}

/**
 * The record store's key for an item. Lower-case plugin names, as the plugin
 * cache matches them, so a differently cased Add reuses one record.
 */
export function harnessInstallItemKey(item: HarnessInstallItemRef): string {
  return item.kind === 'plugin'
    ? `plugin:${item.marketplaceId}/${item.pluginName.toLowerCase()}`
    : `skill:${item.sourceId}/${item.skillName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reads an item reference at a trust boundary. */
export function parseHarnessInstallItemRef(
  value: unknown,
): HarnessInstallItemRef | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'plugin' &&
    nonEmpty(value.marketplaceId) &&
    nonEmpty(value.pluginName)
  )
    return {
      kind: 'plugin',
      marketplaceId: value.marketplaceId,
      pluginName: value.pluginName,
    };
  if (
    value.kind === 'skill' &&
    nonEmpty(value.sourceId) &&
    nonEmpty(value.skillName)
  )
    return {
      kind: 'skill',
      sourceId: value.sourceId,
      skillName: value.skillName,
    };
  return undefined;
}

function harnessLabel(harness: HarnessCompatibilityHarness): string {
  switch (harness) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'copilot':
      return 'Copilot';
    case 'opencode':
      return 'OpenCode';
  }
}

/** Why a harness was skipped, from its compatibility reason. */
export function harnessSkipSentence(
  harness: HarnessCompatibilityHarness,
  reason: HarnessCompatibilityUnsupportedReason,
): string {
  const name = harnessLabel(harness);
  switch (reason) {
    case 'no_content':
      return 'This item has nothing to load.';
    // A plugin's apps are ChatGPT apps (CAN-6818).
    case 'app_only':
      return CHATGPT_APP_ONLY;
    case 'provider_account_only':
      return `It only works through a provider account, which ${name} can't use.`;
    case 'no_conversion':
      return `${name} can't load this item's format.`;
    case 'nothing_loadable':
      return `Nothing in it runs in ${name}.`;
  }
}

/**
 * What one Add does for one harness, from the item's compatibility rating:
 * install it (natively, or converted, with what is left out), or skip it with
 * the reason. Without a rating every harness gets a try; whether the harness
 * then loads anything is checked when the item is installed.
 */
export type ItemHarnessInstallPlan =
  | {
      readonly action: 'install';
      readonly via: 'native' | 'converted';
      readonly leftOut: readonly HarnessCompatibilityPart[];
    }
  | { readonly action: 'skip'; readonly reason: string };

export function itemHarnessInstallPlan(
  compatibility: HarnessCompatibility | undefined,
  harness: HarnessCompatibilityHarness,
): ItemHarnessInstallPlan | undefined {
  const result = compatibility?.harnesses[harness];
  if (result === undefined) return undefined;
  switch (result.level) {
    case 'native':
      return { action: 'install', via: 'native', leftOut: [] };
    case 'full':
      return { action: 'install', via: 'converted', leftOut: [] };
    case 'partial':
      return {
        action: 'install',
        via: 'converted',
        leftOut: PARTS.filter((part) => result.missing.includes(part)),
      };
    case 'unsupported':
      return {
        action: 'skip',
        reason: harnessSkipSentence(harness, result.reason),
      };
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function reasonOf(value: unknown): string | undefined {
  return nonEmpty(value)
    ? value.slice(0, ITEM_HARNESS_INSTALL_REASON_MAX_LENGTH)
    : undefined;
}

function parseState(value: unknown): ItemHarnessInstallState | undefined {
  if (!isRecord(value) || !isTimestamp(value.updatedAt)) return undefined;
  const updatedAt = value.updatedAt;
  if (value.status === 'installed') {
    if (value.via !== 'native' && value.via !== 'converted') return undefined;
    const leftOutValue = value.leftOut;
    const leftOut = Array.isArray(leftOutValue)
      ? PARTS.filter((part) => leftOutValue.includes(part))
      : [];
    const version = shortText(value.version);
    const fingerprint = shortText(value.fingerprint);
    return {
      status: 'installed',
      via: value.via,
      ...(leftOut.length > 0 ? { leftOut } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      updatedAt,
    };
  }
  const reason = reasonOf(value.reason);
  if (reason === undefined) return undefined;
  if (value.status === 'skipped')
    return { status: 'skipped', reason, updatedAt };
  if (value.status === 'failed') {
    const outsideChange =
      value.outsideChange === 'changed' || value.outsideChange === 'removed'
        ? value.outsideChange
        : undefined;
    return {
      status: 'failed',
      reason,
      ...(outsideChange !== undefined ? { outsideChange } : {}),
      updatedAt,
    };
  }
  return undefined;
}

/** Longest version or digest a record keeps. */
const SHORT_TEXT_MAX_LENGTH = 64;

function shortText(value: unknown): string | undefined {
  return nonEmpty(value) && value.length <= SHORT_TEXT_MAX_LENGTH
    ? value
    : undefined;
}

/**
 * Reads a record at a trust boundary. Unknown versions are absent, an unknown
 * harness or a bad state is dropped without poisoning its siblings, and the
 * result is a sanitized copy.
 */
export function parseItemHarnessInstalls(
  value: unknown,
): ItemHarnessInstalls | undefined {
  if (
    !isRecord(value) ||
    value.version !== ITEM_HARNESS_INSTALLS_VERSION ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(value.harnesses)
  )
    return undefined;
  const harnesses: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessInstallState>
  > = {};
  for (const harness of ITEM_INSTALL_HARNESSES) {
    const state = parseState(value.harnesses[harness]);
    if (state !== undefined) harnesses[harness] = state;
  }
  const standIns: Partial<
    Record<HarnessCompatibilityHarness, ItemHarnessStandIn>
  > = {};
  const servedStandIns = isRecord(value.standIns) ? value.standIns : {};
  for (const harness of ITEM_INSTALL_HARNESSES) {
    const standIn = parseItemHarnessStandIn(servedStandIns[harness]);
    if (standIn !== undefined) standIns[harness] = standIn;
  }
  const companions = parseItemHarnessCompanions(value.companions);
  return {
    version: ITEM_HARNESS_INSTALLS_VERSION,
    harnesses,
    ...(Object.keys(standIns).length > 0 ? { standIns } : {}),
    ...(companions.length > 0 ? { companions } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** The harnesses a record lists as installed, in order. */
export function itemInstalledHarnesses(
  record: ItemHarnessInstalls | undefined,
): HarnessCompatibilityHarness[] {
  return ITEM_INSTALL_HARNESSES.filter(
    (harness) => record?.harnesses[harness]?.status === 'installed',
  );
}

/** One harness that refused an item, with why. */
export interface ItemHarnessInstallNote {
  readonly harness: HarnessCompatibilityHarness;
  readonly reason: string;
  /** The copy was changed or removed outside the app (CAN-6817). */
  readonly outsideChange?: ItemHarnessOutsideChange;
}

/** The harnesses a record lists as failed, with why, in order. */
export function itemFailedHarnessInstalls(
  record: ItemHarnessInstalls | undefined,
): ItemHarnessInstallNote[] {
  return ITEM_INSTALL_HARNESSES.flatMap((harness) => {
    const state = record?.harnesses[harness];
    return state?.status === 'failed'
      ? [
          {
            harness,
            reason: state.reason,
            ...(state.outsideChange !== undefined
              ? { outsideChange: state.outsideChange }
              : {}),
          },
        ]
      : [];
  });
}
