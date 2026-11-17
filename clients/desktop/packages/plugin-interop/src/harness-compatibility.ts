import type {
  HarnessCompatibility,
  HarnessCompatibilityHarness,
  HarnessCompatibilityPart,
  HarnessCompatibilityResult,
  HARNESS_COMPATIBILITY_VERSION,
  HARNESS_COMPATIBILITY_RULES_VERSION,
} from '@canopy/protocol/plugins';
import { cursorLoadsPluginMemberKind } from './cursor-support';
import { PLUGIN_HARNESSES } from './harness-support';
import { opencodeSupportsCommandHook } from './opencode-support';
import type { PluginHookMember } from './types';

// Type-only protocol imports keep this package usable without its runtime.
export const COMPATIBILITY_WIRE_VERSION: typeof HARNESS_COMPATIBILITY_VERSION = 1;
export const COMPATIBILITY_RULES_VERSION: typeof HARNESS_COMPATIBILITY_RULES_VERSION = 1;

// Experimental Antigravity support is not a qualified compatibility target.
const HARNESSES = PLUGIN_HARNESSES.filter(
  (id): id is HarnessCompatibilityHarness => id !== 'antigravity',
);

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

/** Only original, publisher-origin files belong here, never installed/generated trees. */
export interface PublisherPluginManifest {
  /** Canonical POSIX plugin-root-relative path. */
  path: string;
  manifest: unknown;
}

/** Copilot's published plugin convention; OpenCode has no recognized manifest. */
const NATIVE_PATHS: Partial<Record<HarnessCompatibilityHarness, string>> = {
  claude: '.claude-plugin/plugin.json',
  codex: '.codex-plugin/plugin.json',
  cursor: '.cursor-plugin/plugin.json',
  copilot: '.github/plugin/plugin.json',
};

/** Presence alone is insufficient: require a JSON object with a plugin name. */
export function publisherNativeHarnesses(
  manifests: readonly PublisherPluginManifest[],
): HarnessCompatibilityHarness[] {
  return HARNESSES.filter((harness) =>
    manifests.some(
      ({ path, manifest }) =>
        path === NATIVE_PATHS[harness] &&
        typeof manifest === 'object' &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        'name' in manifest &&
        typeof manifest.name === 'string' &&
        manifest.name.trim().length > 0,
    ),
  );
}

/** Structural inventory shared by server ingestion and desktop scan adapters. */
export interface CompatibilityInventory {
  skills: readonly unknown[];
  commands: readonly unknown[];
  agents: readonly unknown[];
  apps?: readonly unknown[];
  hooks: readonly PluginHookMember[];
  mods?: readonly unknown[];
  mcpServers: readonly unknown[];
  lspServers: readonly unknown[];
}

export interface CompatibilityFacetEvidence {
  /** False for missing bytes, failed parsing or an incomplete source listing. */
  complete: boolean;
  inventory: CompatibilityInventory;
  /** Root .app.json is content even though older inventories omit it. */
  rootApp: boolean;
  /** Cursor-family discovery uses children-only roots rather than direct skills. */
  cursorSkillCount?: number;
  /** Extra discovered skills cannot offset an omitted original skill. */
  cursorMissingSkills?: boolean;
  /** Per-member loading restrictions, in inventory order; undefined means unknown. */
  mcpHarnesses?: readonly (
    | readonly HarnessCompatibilityHarness[]
    | undefined
  )[];
  mcpAccountOnly?: readonly boolean[];
}

export type HarnessCompatibilityEvidence =
  | {
      kind: 'plugin';
      publisherManifests: readonly PublisherPluginManifest[];
      /**
       * Recognized native manifest paths the source lists but whose bytes
       * were not read. Native cannot be ruled out, so those harnesses stay
       * unknown instead of falling through to a derived result.
       */
      unreadPublisherManifests?: readonly string[];
      /** Original facets only. Presence controls target-specific source precedence. */
      facets: {
        claude?: CompatibilityFacetEvidence;
        codex?: CompatibilityFacetEvidence;
      };
    }
  | { kind: 'skill'; complete: boolean; hasContent: boolean }
  | {
      kind: 'mcp';
      complete: boolean;
      hasContent: boolean;
      /** Supplied from catalog transport/connector evidence, never current credentials. */
      supportedHarnesses: readonly HarnessCompatibilityHarness[];
      providerAccountOnly: boolean;
    };

function classifyFacet(
  target: HarnessCompatibilityHarness,
  provider: 'claude' | 'codex',
  evidence: CompatibilityFacetEvidence,
): HarnessCompatibilityResult | undefined {
  if (!evidence.complete) return undefined;
  const inventory = evidence.inventory;
  const counts: Record<HarnessCompatibilityPart, number> = {
    skills: inventory.skills.length,
    commands: inventory.commands.length,
    agents: inventory.agents.length,
    apps: (inventory.apps?.length ?? 0) + Number(evidence.rootApp),
    hooks: inventory.hooks.length,
    mods: inventory.mods?.length ?? 0,
    mcpServers: inventory.mcpServers.length,
    lspServers: inventory.lspServers.length,
  };
  const total = PARTS.reduce((sum, part) => sum + counts[part], 0);
  if (total === 0) return { level: 'unsupported', reason: 'no_content' };

  const loaded: Record<HarnessCompatibilityPart, number> = {
    skills: 0,
    commands: 0,
    agents: 0,
    apps: 0,
    hooks: 0,
    mods: 0,
    mcpServers: 0,
    lspServers: 0,
  };
  if (target === 'claude' && provider === 'codex') {
    // A Claude session converts a Codex plugin's skills and MCP servers
    // (CAN-6816); Codex apps and hooks do not run there. Generated web trees
    // are deliberately not evidence of this desktop capability.
    loaded.skills = counts.skills;
    loaded.mcpServers = counts.mcpServers;
  } else if (target === 'claude') {
    for (const part of PARTS) if (part !== 'apps') loaded[part] = counts[part];
  } else if (target === 'codex') {
    loaded.skills = counts.skills;
    loaded.mcpServers = counts.mcpServers;
    if (provider === 'claude') {
      loaded.commands = counts.commands;
      loaded.agents = counts.agents;
      // Only the root app configuration is emitted by the implemented projection.
      loaded.apps = Number(evidence.rootApp);
    } else {
      loaded.apps = counts.apps;
    }
  } else {
    for (const part of ['skills', 'commands', 'mcpServers'] as const) {
      if (cursorLoadsPluginMemberKind(provider, part))
        loaded[part] = counts[part];
    }
    // Children-only discovery decides what a Cursor-family session finds.
    // Extra nested skills never offset an omitted source skill.
    loaded.skills = Math.min(
      counts.skills,
      evidence.cursorSkillCount ?? counts.skills,
    );
    if (target === 'opencode' && provider === 'claude') {
      loaded.hooks = inventory.hooks.filter(opencodeSupportsCommandHook).length;
    }
  }
  if (counts.mcpServers > 0) {
    const restrictions = evidence.mcpHarnesses;
    if (
      restrictions === undefined ||
      restrictions.length !== counts.mcpServers ||
      restrictions.some((harnesses) => harnesses === undefined)
    )
      return undefined;
    loaded.mcpServers = restrictions.filter((harnesses) =>
      harnesses?.includes(target),
    ).length;
  }
  const missing = PARTS.filter(
    (part) =>
      loaded[part] < counts[part] ||
      (part === 'skills' &&
        target !== 'claude' &&
        target !== 'codex' &&
        evidence.cursorMissingSkills === true),
  );
  const surviving = PARTS.reduce((sum, part) => sum + loaded[part], 0);
  if (surviving === 0) {
    return {
      level: 'unsupported',
      reason:
        counts.apps === total
          ? 'app_only'
          : counts.mcpServers === total &&
              evidence.mcpAccountOnly?.length === counts.mcpServers &&
              evidence.mcpAccountOnly.every(Boolean)
            ? 'provider_account_only'
            : 'nothing_loadable',
    };
  }
  return missing.length === 0
    ? { level: 'full' }
    : { level: 'partial', missing };
}

/** Pure derivation. Call only at ingestion/refresh, never while projecting UI rows. */
export function classifyHarnessCompatibility(
  evidence: HarnessCompatibilityEvidence,
): HarnessCompatibility | undefined {
  const harnesses: HarnessCompatibility['harnesses'] = {};
  const native =
    evidence.kind === 'plugin'
      ? publisherNativeHarnesses(evidence.publisherManifests)
      : [];
  for (const target of HARNESSES) {
    if (native.includes(target)) {
      harnesses[target] = { level: 'native' };
    } else if (
      evidence.kind === 'plugin' &&
      NATIVE_PATHS[target] !== undefined &&
      evidence.unreadPublisherManifests?.includes(NATIVE_PATHS[target])
    ) {
      continue;
    } else if (evidence.kind === 'skill' || evidence.kind === 'mcp') {
      if (!evidence.complete) continue;
      harnesses[target] = !evidence.hasContent
        ? { level: 'unsupported', reason: 'no_content' }
        : evidence.kind === 'skill' ||
            evidence.supportedHarnesses.includes(target)
          ? { level: 'full' }
          : {
              level: 'unsupported',
              reason: evidence.providerAccountOnly
                ? 'provider_account_only'
                : 'nothing_loadable',
            };
    } else {
      const provider =
        target === 'codex' && evidence.facets.codex
          ? 'codex'
          : evidence.facets.claude
            ? 'claude'
            : 'codex';
      const facet = evidence.facets[provider];
      if (facet === undefined) continue;
      const result = classifyFacet(target, provider, facet);
      if (result !== undefined) harnesses[target] = result;
    }
  }
  return Object.keys(harnesses).length === 0
    ? undefined
    : {
        version: COMPATIBILITY_WIRE_VERSION,
        rulesVersion: COMPATIBILITY_RULES_VERSION,
        harnesses,
      };
}
