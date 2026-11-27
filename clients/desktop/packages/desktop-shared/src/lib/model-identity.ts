/**
 * Cross-provider model identity: whether a source's own route runs the same
 * model as a chat, when the two spell it differently (`claude-opus-4-7`,
 * `anthropic/claude-opus-4.7`, a dated or `[1m]` variant).
 *
 * Display and selection only. The match picks which of a source's exact
 * route ids to dispatch so the chat stays on its model; it never feeds model
 * policy or guest allowlists, which compare exact ids. A false match is worse
 * than a miss: a wrong "Stays on" silently runs a model the user didn't
 * choose, so every ambiguous case returns no match.
 *
 * Reads module-level catalog state (aliases, gateway and Cursor entries), so
 * React callers re-derive when the model or lane facts version changes.
 */
import { normalizeCursorIdentity } from '../types';
import { normalizeGovernedModelId } from './model-policy';

/** A plausible `-YYYYMMDD` suffix, at the end or before a trailing `[…]`. */
const DATE_SUFFIX = /-20\d{6}(?=(\[[^\]]*\])?$)/;
const VARIANT_SUFFIX = /\[[^\]]*\]$/;

export interface ModelIdentityKeyOptions {
  /** Also drop a trailing `[…]` context-window variant (`[1m]`). */
  readonly stripVariant?: boolean;
}

/**
 * The comparable identity of a model id, or `undefined` when the id has no
 * governed identity (Ollama, an Agent that inherits the default).
 *
 * Aliases resolve before anything is stripped: stripping `opus[1m]` to
 * `opus` first would resolve to a different model.
 */
export function modelIdentityKey(
  id: string,
  options: ModelIdentityKeyOptions = {},
): string | undefined {
  if (id === '') return undefined;
  const governed = normalizeGovernedModelId(id);
  if (governed === undefined || governed === '') return undefined;
  let key = normalizeCursorIdentity(governed).toLowerCase();
  key = key.replace(DATE_SUFFIX, '');
  if (options.stripVariant === true) key = key.replace(VARIANT_SUFFIX, '');
  return key === '' ? undefined : key;
}

/** A source's own route: its exact id, and its gateway id when it has one. */
export interface ModelIdentityCandidate {
  readonly id: string;
  /**
   * Optional: a registry id already reaches its gateway id through
   * `modelIdentityKey`, so hosts may pass the id alone.
   */
  readonly gatewayId?: string;
}

type TierResult<T> =
  | { readonly kind: 'match'; readonly candidate: T }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'none' };

function uniqueMatch<T>(matches: readonly T[]): TierResult<T> {
  const [only] = matches;
  if (only === undefined) return { kind: 'none' };
  return matches.length === 1
    ? { kind: 'match', candidate: only }
    : { kind: 'ambiguous' };
}

function candidateKeys(
  candidate: ModelIdentityCandidate,
  options: ModelIdentityKeyOptions,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of [candidate.id, candidate.gatewayId]) {
    if (id === undefined) continue;
    const key = modelIdentityKey(id, options);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * The one candidate that runs the same model as `targetId`, or `undefined`.
 * Tiers, first result wins; an ambiguous tier stops with no match rather
 * than falling through to a looser one:
 *
 * 1. An exact `id`, then an exact `gatewayId` held by exactly one candidate.
 * 2. One candidate with the target's identity key.
 * 3. One candidate with the target's identity key once `[…]` variants are
 *    dropped, so "Opus 4.7 [1M]" can stay on "Opus 4.7".
 *
 * The returned candidate's own `id` is what a host dispatches.
 */
export function findEquivalentModel<T extends ModelIdentityCandidate>(
  targetId: string,
  candidates: readonly T[],
  options: {
    /**
     * `false` skips tier 3, so a `[1m]` variant never matches its base model.
     * For a swap that persists, where a smaller window would go unnoticed.
     */
    readonly allowVariantFallback?: boolean;
  } = {},
): T | undefined {
  if (targetId === '' || candidates.length === 0) return undefined;

  const exact = candidates.find((candidate) => candidate.id === targetId);
  if (exact !== undefined) return exact;
  const byGatewayId = uniqueMatch(
    candidates.filter((candidate) => candidate.gatewayId === targetId),
  );
  if (byGatewayId.kind === 'match') return byGatewayId.candidate;
  if (byGatewayId.kind === 'ambiguous') return undefined;

  const tiers: ModelIdentityKeyOptions[] =
    options.allowVariantFallback === false
      ? [{}]
      : [{}, { stripVariant: true }];
  for (const keyOptions of tiers) {
    const targetKey = modelIdentityKey(targetId, keyOptions);
    if (targetKey === undefined) return undefined;
    const tier = uniqueMatch(
      candidates.filter((candidate) =>
        candidateKeys(candidate, keyOptions).has(targetKey),
      ),
    );
    if (tier.kind === 'match') return tier.candidate;
    if (tier.kind === 'ambiguous') return undefined;
  }
  return undefined;
}
