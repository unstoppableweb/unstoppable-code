// ---------------------------------------------------------------------------
// Renderer-side helpers for pipeline model aliases.
//
// Sibling to `pipelinePluginCollections.ts`. Model aliases are named model
// choices that agent steps reference via `with.model: <alias id>`. An alias may
// carry `defaults` (inline model or a local Agent) or omit them (a required
// configuration slot the dispatch/automation setup must fill).
//
// These helpers convert `alias.defaults` into the run-scoped preference shape
// and compute the effective / required display state for a given
// `(alias, storedPref, draftPref)` triple, implementing the overlay rules from
// the "Reset tombstone contract":
//   - a draft inline/Agent override wins,
//   - a draft `{ mode: 'reset' }` marker forces `alias.defaults` (or required
//     when there are none) — NEVER a key deletion,
//   - an absent draft falls back to the stored preference, then to
//     `alias.defaults`, then to required.
// ---------------------------------------------------------------------------

import type {
  PipelineAgentModelAliasPreference,
  PipelineInlineModelAliasPreference,
  PipelineModelAlias,
  PipelineModelAliasDefaults,
  PipelineModelAliasPreference,
} from '@canopy/execution-engine/types/pipeline';

// Re-export the shared locator derivation so alias consumers can import it from
// this module without also reaching into the plugin-collection helper.
export { derivePipelinePreferenceLocator } from './pipelinePluginCollections';

/** A concrete (non-reset) alias preference — the shape actually rendered/run. */
export type ConcreteModelAliasPreference =
  | PipelineInlineModelAliasPreference
  | PipelineAgentModelAliasPreference;

/**
 * Convert an `alias.defaults` object into the run-scoped preference shape.
 * Returns `undefined` when the alias has no defaults (a required slot).
 */
export function aliasDefaultsToPreference(
  defaults: PipelineModelAliasDefaults | undefined,
): ConcreteModelAliasPreference | undefined {
  if (!defaults) return undefined;
  if ('agent_id' in defaults) {
    return { mode: 'agent', agent_id: defaults.agent_id };
  }
  return {
    mode: 'inline',
    base: defaults.base,
    ...(defaults.instructions !== undefined
      ? { instructions: defaults.instructions }
      : {}),
    ...(defaults.plugin_collection_id !== undefined
      ? { plugin_collection_id: defaults.plugin_collection_id }
      : {}),
  };
}

/**
 * Where the effective preference came from:
 *   - `draft`   — an explicit user inline/Agent override for this run,
 *   - `stored`  — a saved per-pipeline preference (no draft override),
 *   - `default` — the pipeline `alias.defaults` (baseline / reset target),
 *   - `none`    — nothing resolved; the alias is required and unconfigured.
 */
export type ModelAliasEffectiveSource = 'draft' | 'stored' | 'default' | 'none';

export interface ModelAliasEffectiveState {
  /** The inline/Agent preference to display and run, or `null` when required. */
  preference: ConcreteModelAliasPreference | null;
  source: ModelAliasEffectiveSource;
  /** No effective value — dispatch/automation setup must configure the alias. */
  required: boolean;
  /**
   * `true` when the effective value comes from a user override (a draft or
   * stored inline/Agent preference) rather than the pipeline default / a
   * reset-to-defaults. Drives the `Customized` badge.
   */
  customized: boolean;
}

function asConcrete(
  pref: PipelineModelAliasPreference | undefined,
): ConcreteModelAliasPreference | null {
  if (!pref) return null;
  if (pref.mode === 'inline' || pref.mode === 'agent') {
    return pref;
  }
  // `reset` markers are handled by the caller, never a concrete value.
  return null;
}

/**
 * Compute the effective / required state for one alias given the stored and
 * draft preferences (see the overlay rules at the top of this file).
 */
export function resolveEffectiveAliasPreference(
  alias: PipelineModelAlias,
  storedPref: PipelineModelAliasPreference | undefined,
  draftPref: PipelineModelAliasPreference | undefined,
): ModelAliasEffectiveState {
  const defaultPref = aliasDefaultsToPreference(alias.defaults) ?? null;

  if (draftPref) {
    if (draftPref.mode === 'reset') {
      // The reset marker forces the pipeline default, overriding any stored
      // preference for this run. No default → the alias falls back to required.
      return defaultPref
        ? {
            preference: defaultPref,
            source: 'default',
            required: false,
            customized: false,
          }
        : {
            preference: null,
            source: 'none',
            required: true,
            customized: false,
          };
    }
    const draftConcrete = asConcrete(draftPref);
    if (draftConcrete) {
      return {
        preference: draftConcrete,
        source: 'draft',
        required: false,
        customized: true,
      };
    }
  }

  const storedConcrete = asConcrete(storedPref);
  if (storedConcrete) {
    return {
      preference: storedConcrete,
      source: 'stored',
      required: false,
      customized: true,
    };
  }

  if (defaultPref) {
    return {
      preference: defaultPref,
      source: 'default',
      required: false,
      customized: false,
    };
  }

  return {
    preference: null,
    source: 'none',
    required: true,
    customized: false,
  };
}

export interface ModelAliasValidationContext {
  /** Plugin-collection ids defined on the pipeline (inline mode reference). */
  pluginCollectionIds: ReadonlySet<string>;
  /** Locally-available Agent ids (`agent_model_*`) for Agent-mode preferences. */
  availableAgentIds: ReadonlySet<string>;
}

/**
 * Validate a resolved effective preference. Returns a human-readable error
 * string when the alias cannot run, or `undefined` when it is valid.
 */
export function validateEffectiveAliasPreference(
  effective: ModelAliasEffectiveState,
  ctx: ModelAliasValidationContext,
): string | undefined {
  const pref = effective.preference;
  if (!pref) {
    return 'Choose a model or Agent for this alias.';
  }
  if (pref.mode === 'inline') {
    if (!pref.base || pref.base.trim() === '') {
      return 'Base model is required.';
    }
    if (
      pref.plugin_collection_id !== undefined &&
      pref.plugin_collection_id !== '' &&
      !ctx.pluginCollectionIds.has(pref.plugin_collection_id)
    ) {
      return 'Choose an existing plugin collection.';
    }
    return undefined;
  }
  // Agent mode.
  if (!pref.agent_id || pref.agent_id.trim() === '') {
    return 'Agent is required.';
  }
  if (!ctx.availableAgentIds.has(pref.agent_id)) {
    return 'Agent is not available locally.';
  }
  return undefined;
}

/**
 * Whether ANY alias on the pipeline is unconfigured or invalid given the draft
 * preferences. Used by the trigger/dispatch modal and automation setup to block
 * Run / Save while a required alias has no valid value.
 */
export function areAliasPreferencesBlocked(
  aliases: PipelineModelAlias[],
  draftPreferences: Record<string, PipelineModelAliasPreference>,
  ctx: ModelAliasValidationContext,
): boolean {
  return aliases.some((alias) => {
    const effective = resolveEffectiveAliasPreference(
      alias,
      undefined,
      draftPreferences[alias.id],
    );
    return validateEffectiveAliasPreference(effective, ctx) !== undefined;
  });
}
