import type { AgentExecutionHarness } from '@canopy/protocol/models';
import type {
  HarnessCompatibilityPart,
  ItemHarnessInstalls,
  ItemHarnessStandIn,
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/protocol/plugins';
import type { PluginHookMember } from './types';
import { opencodeSupportsCommandHook } from './opencode-support';
import {
  cursorPluginFacetSupport,
  type CursorLoadablePluginDetails,
} from './cursor-support';

/**
 * Every harness a plugin page lists, in display order. Each one is listed
 * whether or not you are signed in to it; the row states whether the harness
 * can run the plugin and whether the plugin is installed for it.
 */
export const PLUGIN_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
] as const satisfies readonly AgentExecutionHarness[];

export type PluginHarnessId = (typeof PLUGIN_HARNESSES)[number];

export function isPluginHarnessId(value: unknown): value is PluginHarnessId {
  return PLUGIN_HARNESSES.some((id) => id === value);
}

/**
 * Harnesses every build offers. A host that cannot read the desktop's harness
 * gates (the public catalog page, or a Portal paired with an older desktop)
 * lists only these.
 */
export const ALWAYS_OFFERED_PLUGIN_HARNESSES = [
  'claude',
  'codex',
] as const satisfies readonly PluginHarnessId[];

/** The desktop's harness gates for the harnesses that have one. */
export interface PluginHarnessGates {
  cursor: boolean;
  copilot: boolean;
  opencode: boolean;
  /**
   * Antigravity is a Labs harness: hosts offer it only where this person can
   * run it (its gate is on and Google models were discovered), so the table
   * never advertises it to everyone while it is unqualified.
   */
  antigravity: boolean;
}

/**
 * The harnesses this build offers, in display order: Claude and Codex always,
 * the others when their harness gate is on. A plugin page lists a harness
 * whether or not you are signed in to it, but never one the build hides.
 */
export function offeredPluginHarnesses(
  gates: PluginHarnessGates,
): PluginHarnessId[] {
  return PLUGIN_HARNESSES.filter(
    (id) => id === 'claude' || id === 'codex' || gates[id],
  );
}

/**
 * Display label for a harness row. Matches the model catalog's provider
 * labels except Copilot, which plugin pages name "Copilot" to match the
 * Copilot connection copy. A literal map so this package has no runtime
 * protocol dependency.
 */
export function pluginHarnessLabel(id: PluginHarnessId): string {
  switch (id) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'copilot':
      return 'Copilot';
    case 'opencode':
      return 'OpenCode';
    case 'antigravity':
      return 'Antigravity';
  }
}

/**
 * Why a supported row is not a qualified one. Antigravity runs the projected
 * skills, commands and MCP servers, but stays in Labs and never loads plugin
 * hooks or agents, so the table says so instead of a plain Installed.
 */
export const ANTIGRAVITY_PLUGIN_HARNESS_NOTE = 'Labs: no hooks or agents';

export type PluginHarnessInstallation =
  | 'Installed'
  | 'Not installed'
  | 'Not supported';

export interface PluginHarnessRow {
  id: PluginHarnessId;
  name: string;
  installation: PluginHarnessInstallation;
  /** Experimental qualification or the recorded per-harness install outcome. */
  note?: string;
}

type PluginHarnessFacetProvider = 'claude' | 'codex';

export interface PluginHarnessRowsInput {
  providerSupport: PluginProviderSupport;
  /** The Claude plugin's Codex compatibility setting is off. */
  codexCompatDisabled?: boolean;
  /** Remote hosts must explicitly confirm hook execution; local callers share this runtime. */
  opencodeCommandHooks?: boolean;
  /** Hosts pass facets only for providers they support; the rule does not filter them. */
  facets: {
    claude?: {
      details?:
        | (CursorLoadablePluginDetails & {
            hooks?: readonly PluginHookMember[];
          })
        | null;
    };
    codex?: { details?: CursorLoadablePluginDetails | null };
  };
  /** Per-provider truth, or one flag when the host only has that (web). `false` never claims Installed. */
  installed: boolean | Partial<Record<PluginHarnessFacetProvider, boolean>>;
  /**
   * The harnesses the host offers ({@link offeredPluginHarnesses}). Rows keep
   * {@link PLUGIN_HARNESSES} order. Required so a display caller cannot list
   * a harness the build hides; a caller reading one named harness's support
   * passes {@link PLUGIN_HARNESSES}.
   */
  harnesses: readonly PluginHarnessId[];
  /**
   * One Add for every harness's record (CAN-6816), when there is one. It
   * marks the harnesses it installed for and notes what each left out or
   * why it was skipped; without it the rows are unchanged.
   */
  harnessInstalls?: ItemHarnessInstalls;
}

const PART_NOUNS: Record<HarnessCompatibilityPart, string> = {
  skills: 'Skills',
  commands: 'Commands',
  agents: 'Agents',
  apps: 'Apps',
  hooks: 'Hooks',
  mods: 'Mods',
  mcpServers: 'MCP servers',
  lspServers: 'Language servers',
};

/**
 * "Hooks don't run in Cursor." for the parts a harness left out. A ChatGPT
 * app it left out reads "ChatGPT app only." (CAN-6818), or, where the
 * plugin's own copy loads the publisher's MCP server, says so.
 */
function leftOutNote(
  id: PluginHarnessId,
  leftOut: readonly HarnessCompatibilityPart[],
  standIn: ItemHarnessStandIn | undefined,
): string | undefined {
  const app = leftOut.includes('apps') ? standInNote(id, standIn) : undefined;
  const rest = partsNote(
    id,
    leftOut.filter((part) => part !== 'apps'),
  );
  const sentences = [app, rest].filter(
    (sentence): sentence is string => sentence !== undefined,
  );
  return sentences.length === 0 ? undefined : sentences.join(' ');
}

// The same sentences as `@canopy/protocol/plugins` (`CHATGPT_APP_ONLY`,
// `standInSentence`); this package takes no runtime protocol dependency, so
// they are spelled here.
const CHATGPT_APP_ONLY = 'ChatGPT app only.';

/** The harness's product name, as the record's sentences name it. */
function harnessProductName(id: PluginHarnessId): string {
  return id === 'claude' ? 'Claude Code' : pluginHarnessLabel(id);
}

function standInSentence(name: string, id: PluginHarnessId): string {
  return `Uses the ${name} MCP server in ${harnessProductName(id)}.`;
}

/** What a harness that can't run a ChatGPT app gets instead (CAN-6818). */
function standInNote(
  id: PluginHarnessId,
  standIn: ItemHarnessStandIn | undefined,
): string {
  return standIn === undefined
    ? CHATGPT_APP_ONLY
    : standInSentence(standIn.name, id);
}

function partsNote(
  id: PluginHarnessId,
  leftOut: readonly HarnessCompatibilityPart[],
): string | undefined {
  if (leftOut.length === 0) return undefined;
  const nouns = leftOut.map((part, index) =>
    index === 0 ? PART_NOUNS[part] : PART_NOUNS[part].toLowerCase(),
  );
  const list =
    nouns.length === 1
      ? nouns[0]
      : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
  return `${list} don't run in ${pluginHarnessLabel(id)}.`;
}

/** Applies one harness's recorded result to its row (CAN-6816). */
function withRecordedInstall(
  row: PluginHarnessRow,
  record: ItemHarnessInstalls | undefined,
): PluginHarnessRow {
  if (row.id === 'antigravity') return row;
  const state = record?.harnesses[row.id];
  if (state === undefined) return row;
  const standIn = record?.standIns?.[row.id];
  switch (state.status) {
    case 'installed': {
      const note = leftOutNote(row.id, state.leftOut ?? [], standIn);
      return {
        ...row,
        installation: 'Installed',
        ...(note !== undefined ? { note } : {}),
      };
    }
    case 'skipped':
      return { ...row, installation: 'Not supported', note: state.reason };
    case 'failed':
      // A copy changed outside the app still loads; one removed outside the
      // app keeps the provider's install state (CAN-6817).
      if (state.outsideChange === 'changed')
        return { ...row, installation: 'Installed', note: state.reason };
      if (state.outsideChange === 'removed')
        return { ...row, note: state.reason };
      return { ...row, note: `Couldn't install: ${state.reason}` };
  }
}

function isInstalledFor(
  installed: PluginHarnessRowsInput['installed'],
  provider: PluginHarnessFacetProvider,
): boolean {
  if (typeof installed === 'boolean') return installed;
  return installed[provider] === true;
}

/**
 * One row per offered harness ({@link PluginHarnessRowsInput.harnesses}), read from the plugin's
 * provider support and facets so the harness table and Try it state the same
 * support (CAP-01 in the harness checklist).
 *
 * - Claude runs a plugin with a Claude facet; Codex runs a native or
 *   compatibility facet unless the Claude plugin's Codex compatibility is off.
 * - Cursor, Copilot, OpenCode and Antigravity sessions read the facet a
 *   Cursor session reads (`cursorPluginFacetSupport`; the desktop resolver
 *   runs the same projection for the others), so they are supported when
 *   that facet carries something they load, and installed when the plugin is
 *   installed for that facet's provider. A supported Antigravity row carries
 *   {@link ANTIGRAVITY_PLUGIN_HARNESS_NOTE}: supported, but unqualified.
 * - `codexCompatDisabled` changes only the Codex row. It does not strip the
 *   Codex facet: compatibility is a Claude-plugin setting, so a Codex-only
 *   plugin never carries it.
 */
export function pluginHarnessRows(
  input: PluginHarnessRowsInput,
): PluginHarnessRow[] {
  const { providerSupport, codexCompatDisabled, facets, installed, harnesses } =
    input;
  const facetSupport = cursorPluginFacetSupport(facets);
  const row = (
    id: PluginHarnessId,
    supported: boolean,
    provider: PluginHarnessFacetProvider,
  ): PluginHarnessRow => ({
    id,
    name: pluginHarnessLabel(id),
    installation: !supported
      ? 'Not supported'
      : isInstalledFor(installed, provider)
        ? 'Installed'
        : 'Not installed',
  });
  return PLUGIN_HARNESSES.filter((id) => harnesses.includes(id)).map((id) =>
    // The current Codex compatibility setting outranks an older record:
    // with it off, Codex sessions refuse the plugin whatever was recorded.
    id === 'codex' && codexCompatDisabled
      ? baseRow(id)
      : withRecordedInstall(baseRow(id), input.harnessInstalls),
  );
  function baseRow(id: PluginHarnessId): PluginHarnessRow {
    switch (id) {
      case 'claude':
        return row(id, providerSupport.claude !== 'none', 'claude');
      case 'codex':
        return row(
          id,
          providerSupport.codex !== 'none' && !codexCompatDisabled,
          'codex',
        );
      case 'cursor':
      case 'copilot':
        return row(id, facetSupport.supported, facetSupport.provider);
      case 'antigravity': {
        const projected = row(
          id,
          facetSupport.supported,
          facetSupport.provider,
        );
        return projected.installation === 'Not supported'
          ? projected
          : { ...projected, note: ANTIGRAVITY_PLUGIN_HARNESS_NOTE };
      }
      case 'opencode':
        return row(
          id,
          facetSupport.supported ||
            (input.opencodeCommandHooks !== false &&
              (facets.claude?.details?.hooks?.some(
                opencodeSupportsCommandHook,
              ) ??
                false)),
          facetSupport.provider,
        );
    }
  }
}

/**
 * A desktop catalog plugin's harness rows, read the way the desktop plugin
 * page reads them. New Customize's tiles and Works with tables, on desktop
 * and Portal, all start from these rows, so a tile's chips and its page's
 * table can't disagree.
 */
export function pluginInfoHarnessRows(
  plugin: Pick<
    PluginInfo,
    | 'providerSupport'
    | 'codexCompatDisabled'
    | 'facets'
    | 'globalInstallStatus'
    | 'harnessInstalls'
  >,
  harnesses: readonly PluginHarnessId[],
  showHarnessInstalls: boolean,
  /**
   * Whether the plugin counts as installed when no provider status says so.
   * A catalog listing not fetched yet passes false; the plugin page, which
   * opens installed plugins, keeps the default.
   */
  installedWhenUnknown = true,
): PluginHarnessRow[] {
  return pluginHarnessRows({
    harnesses,
    // One Add for every harness (CAN-6816): New Customize only.
    ...(showHarnessInstalls && plugin.harnessInstalls
      ? { harnessInstalls: plugin.harnessInstalls }
      : {}),
    providerSupport: plugin.providerSupport,
    codexCompatDisabled: plugin.codexCompatDisabled,
    facets: plugin.facets,
    installed: plugin.globalInstallStatus
      ? {
          claude: plugin.globalInstallStatus.claude?.installed ?? false,
          codex: plugin.globalInstallStatus.codex?.installed ?? false,
        }
      : installedWhenUnknown,
  });
}
