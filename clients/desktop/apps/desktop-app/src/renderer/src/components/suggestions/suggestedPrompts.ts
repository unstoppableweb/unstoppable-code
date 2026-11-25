import type { DetectedMcpServerInfo } from '@canopy/execution-engine/types/mcp-servers';
import type { WorkspaceTemplateStarterPrompt } from '@canopy/protocol/workspace-templates';
import {
  GENERIC_FALLBACK_PROMPTS,
  MCP_PROMPT_INDEX,
  synthesizedPromptForServer,
  type GenericPromptSurface,
  type SuggestedPrompt,
} from './mcpPromptIndex';

export const MAX_SUGGESTED_PROMPTS = 3;

/**
 * Auth statuses that make an enabled curated server safe to suggest prompts
 * for. Excludes `not_connected` / `expired` / `error` so users never receive
 * a prompt that depends on an unavailable or unauthorized MCP; includes
 * no-auth HTTP servers (`not_configured`) and command servers
 * (`unsupported`), which work without explicit auth.
 */
const ELIGIBLE_AUTH_STATUSES: ReadonlySet<DetectedMcpServerInfo['authStatus']> =
  new Set<DetectedMcpServerInfo['authStatus']>([
    'connected',
    'not_configured',
    'unsupported',
  ]);

/**
 * One eligible curated server, reduced to the fields prompt picking needs:
 * the catalog key joins the prompt index, and the display name feeds the
 * synthesized fallback prompt when no hand-written entry exists.
 */
export interface EligibleCuratedServer {
  key: string;
  displayName: string;
}

/**
 * Distinct curated servers, in first-seen order per catalog key, for servers
 * that are enabled, usable without further auth, and linked to a curated
 * entry.
 */
export function eligibleCuratedServers(
  servers: readonly DetectedMcpServerInfo[],
): EligibleCuratedServer[] {
  const eligible: EligibleCuratedServer[] = [];
  for (const server of servers) {
    if (
      server.curatedKey !== undefined &&
      server.enabled &&
      ELIGIBLE_AUTH_STATUSES.has(server.authStatus) &&
      !eligible.some((entry) => entry.key === server.curatedKey)
    ) {
      eligible.push({
        key: server.curatedKey,
        displayName: server.displayName,
      });
    }
  }
  return eligible;
}

/**
 * Stable signature of the eligible pool, used to keep a picked set while the
 * pool is unchanged and re-roll only when it genuinely changes.
 */
export function suggestionPoolSignature(
  eligibleKeys: readonly string[],
): string {
  return [...eligibleKeys].sort().join('|');
}

/**
 * Project-owned starter prompts, projected into the shape the picker tops up
 * from. `curatedKey` is null by construction: a project-authored prompt has no
 * curated MCP behind it, which is exactly why the narrow `{ id, text }` form is
 * what travels on the wire (CAN-2964 §8.1).
 */
export function starterPromptsAsSuggestions(
  starterPrompts: readonly WorkspaceTemplateStarterPrompt[],
): SuggestedPrompt[] {
  return starterPrompts.map((prompt) => ({
    id: prompt.id,
    curatedKey: null,
    text: prompt.text,
    userAuthored: true,
  }));
}

/**
 * The prompts {@link pickSuggestedPrompts} tops up from: the project's own
 * starter prompts, else a seeding Blueprint's, else the surface's generic
 * pool. `undefined`/`null` means "never set"; an explicit `[]` is a
 * deliberate "show no starters".
 */
function topUpPool(
  surface: GenericPromptSurface,
  starterPrompts: readonly WorkspaceTemplateStarterPrompt[] | null | undefined,
  seedingBlueprintStarterPrompts:
    | readonly WorkspaceTemplateStarterPrompt[]
    | null
    | undefined,
): readonly SuggestedPrompt[] {
  if (starterPrompts !== undefined && starterPrompts !== null) {
    return starterPromptsAsSuggestions(starterPrompts);
  }
  if (
    seedingBlueprintStarterPrompts !== undefined &&
    seedingBlueprintStarterPrompts !== null
  ) {
    return starterPromptsAsSuggestions(seedingBlueprintStarterPrompts);
  }
  return GENERIC_FALLBACK_PROMPTS[surface];
}

/**
 * How many prompts a pick holds at least, whatever the MCP inventory turns
 * out to be: the top-up pool alone fills this many. Known before the
 * inventory is, so an empty state can keep their room from its first frame.
 */
export function minimumSuggestedPromptCount(
  surface: GenericPromptSurface,
  starterPrompts?: readonly WorkspaceTemplateStarterPrompt[] | null,
  seedingBlueprintStarterPrompts?:
    | readonly WorkspaceTemplateStarterPrompt[]
    | null,
): number {
  return Math.min(
    MAX_SUGGESTED_PROMPTS,
    topUpPool(surface, starterPrompts, seedingBlueprintStarterPrompts).length,
  );
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Picks up to {@link MAX_SUGGESTED_PROMPTS} prompts, deterministic for a given
 * `random`. Interleaves across distinct eligible MCPs first (one prompt per
 * MCP in shuffled order, then a second round, …) so multiple enabled MCPs are
 * all discoverable, then tops up from `starterPrompts` when the project owns a
 * set, otherwise from the surface's generic fallback pool.
 * Eligible servers without a hand-written index entry contribute a single
 * synthesized name-based prompt instead of being dropped, so every curated
 * connector is discoverable. Always returns a full set — with no eligible
 * servers the result is entirely generic fallbacks.
 */
export function pickSuggestedPrompts(
  eligible: readonly EligibleCuratedServer[],
  random: () => number,
  surface: GenericPromptSurface,
  starterPrompts?: readonly WorkspaceTemplateStarterPrompt[] | null,
  seedingBlueprintStarterPrompts?:
    | readonly WorkspaceTemplateStarterPrompt[]
    | null,
): SuggestedPrompt[] {
  // Own-property lookups only: a curated key colliding with an inherited
  // Object.prototype member (e.g. "constructor") must take the synthesized
  // path instead of resolving the inherited function.
  const pools = shuffled(eligible, random).map(({ key, displayName }) =>
    Object.prototype.hasOwnProperty.call(MCP_PROMPT_INDEX, key) &&
    MCP_PROMPT_INDEX[key].length > 0
      ? shuffled(MCP_PROMPT_INDEX[key], random)
      : [synthesizedPromptForServer(key, displayName)],
  );

  const picked: SuggestedPrompt[] = [];
  let round = 0;
  while (picked.length < MAX_SUGGESTED_PROMPTS) {
    let tookAny = false;
    for (const pool of pools) {
      if (picked.length >= MAX_SUGGESTED_PROMPTS) break;
      const prompt = pool[round];
      if (prompt !== undefined) {
        picked.push(prompt);
        tookAny = true;
      }
    }
    if (!tookAny) break;
    round += 1;
  }

  // Resolution order for the top-up pool (CAN-2964 §8.1): the project's own
  // starter prompts, then the surface's generic pool. Seeding copies a
  // Blueprint's prompts into the project setting once, so by the time the
  // picker runs the project setting IS the Blueprint's contribution.
  //
  // `undefined`/`null` (never edited, never seeded) falls back to the generic
  // pool; an explicit `[]` is a deliberate "show no starters" and must NOT
  // collapse into the fallback.
  const topUp = topUpPool(
    surface,
    starterPrompts,
    seedingBlueprintStarterPrompts,
  );
  for (const prompt of shuffled(topUp, random)) {
    if (picked.length >= MAX_SUGGESTED_PROMPTS) break;
    picked.push(prompt);
  }
  return picked;
}
