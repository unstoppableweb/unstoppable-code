import {
  AGENT_MODEL_PREFIX,
  formatAgentRouteModelId,
  isAgentDefaultBaseModel,
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import { STATIC_MODEL_REFERENCE_ALIASES } from './static-model-reference-aliases';

type AgentAliasBaseResult =
  | { ok: true; base?: string }
  | { ok: false; error: string };

function parseAgentAliasBase(base: unknown): AgentAliasBaseResult {
  if (base === undefined) return { ok: true };
  const error = 'Agent model override must be a concrete model id.';
  if (typeof base !== 'string') return { ok: false, error };
  const value = base.trim();
  const resolved = resolveStaticModelReference(value);
  const invalidCharacter = Array.from(resolved).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || /\s|@/.test(character);
  });
  if (
    !resolved ||
    resolved.length > 512 ||
    invalidCharacter ||
    resolved.startsWith(AGENT_MODEL_PREFIX) ||
    resolved.startsWith('$') ||
    isAgentDefaultBaseModel(resolved) ||
    resolved === 'auto'
  ) {
    return { ok: false, error };
  }
  return { ok: true, base: value };
}

function resolveStaticModelReference(value: string): string {
  return Object.prototype.hasOwnProperty.call(
    STATIC_MODEL_REFERENCE_ALIASES,
    value,
  )
    ? STATIC_MODEL_REFERENCE_ALIASES[value]
    : value;
}

/** Invalid explicit overrides throw: dropping them could restore a saved/default model. */
export function normalizeAgentAliasBase(base: unknown): { base?: string } {
  const parsed = parseAgentAliasBase(base);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.base === undefined ? {} : { base: parsed.base };
}

/** Keep invalid saved overrides visible and resettable; route resolution refuses them on use. */
export function normalizeStoredAgentAliasBase(base: unknown): {
  base?: string;
} {
  if (base === undefined) return {};
  // Empty is an invalid explicit choice, never the absent/inherit choice.
  return { base: typeof base === 'string' ? base.trim() : '' };
}

/** Non-throwing validation for editors and automation command boundaries. */
export function parsePipelineAgentAliasRoute(defaults: {
  agent_id: string;
  base?: unknown;
}): { ok: true; route: string } | { ok: false; error: string } {
  // Bare legacy IDs retain their existing admission path when no model is chosen.
  if (defaults.base === undefined && !defaults.agent_id.includes('@')) {
    return { ok: true, route: defaults.agent_id };
  }
  const embedded = parseAgentRouteModelId(defaults.agent_id);
  const agentId = embedded?.agentId ?? defaults.agent_id;
  if (
    !isValidSharedAgentModelId(agentId) ||
    (defaults.agent_id.includes('@') &&
      (!embedded || embedded.baseModel.includes('@')))
  ) {
    return {
      ok: false,
      error: 'Agent model override requires a valid Agent id.',
    };
  }
  const parsed = parseAgentAliasBase(
    defaults.base !== undefined ? defaults.base : embedded?.baseModel,
  );
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    route:
      parsed.base === undefined
        ? defaults.agent_id
        : formatAgentRouteModelId(
            agentId,
            resolveStaticModelReference(parsed.base),
          ),
  };
}

/** Compile structured preferences into the existing owner.model.agentAlias route. */
export function resolvePipelineAgentAliasRoute(defaults: {
  agent_id: string;
  base?: string;
}): string {
  const parsed = parsePipelineAgentAliasRoute(defaults);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.route;
}
