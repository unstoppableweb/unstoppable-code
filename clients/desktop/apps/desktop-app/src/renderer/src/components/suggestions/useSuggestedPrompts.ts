import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { WorkspaceTemplateStarterPrompt } from '@canopy/protocol/workspace-templates';
import { useDetectedMcpServers } from '../../hooks/useDetectedMcpServers';
import type { SuggestedPrompt } from './mcpPromptIndex';
import {
  eligibleCuratedServers,
  pickSuggestedPrompts,
  suggestionPoolSignature,
} from './suggestedPrompts';
import {
  trackSuggestedPromptImpression,
  type SuggestedPromptSurface,
} from './suggestedPromptTelemetry';

export interface UseSuggestedPromptsOptions {
  surface: SuggestedPromptSurface;
  /**
   * Stable identity of the empty state the suggestions belong to (chat id for
   * chat surfaces, `'home'` for the Home surface). A new seed key re-rolls
   * the picked set; the same seed key keeps it stable.
   */
  seedKey: string;
  /**
   * Hold the picked set across concurrent mounts of the same hold key: the
   * always-mounted MainPage keeps an embedded HomeSurface alive under the
   * standalone Home page, so a per-instance pick would visibly re-roll during
   * Code <-> New Task navigation. Held picks are dropped once no instance
   * remains mounted.
   */
  holdAcrossMounts?: boolean;
  /**
   * Whether prompts may come from this computer's MCP servers. A cloud chat
   * runs elsewhere, so it takes the surface's pool without reading them
   * (CAN-6175). Defaults to true.
   */
  localInventory?: boolean;
  /**
   * The project's own starter prompts (CAN-2964 §8.1). `undefined`/`null`
   * means "never set" and falls back to the surface's generic pool; an
   * explicit `[]` deliberately shows no generic starters. Editing the set
   * re-rolls the pick, because `starterPromptsKey` joins the pick identity.
   */
  starterPrompts?: readonly WorkspaceTemplateStarterPrompt[] | null;
  /** Blueprint defaults used only while the project setting is absent. */
  seedingBlueprintStarterPrompts?:
    | readonly WorkspaceTemplateStarterPrompt[]
    | null;
}

export interface UseSuggestedPromptsResult {
  prompts: readonly SuggestedPrompt[];
  loading: boolean;
}

interface PickedSet {
  surface: SuggestedPromptSurface;
  seedKey: string;
  /**
   * Structural snapshot of the latest selections whose inventory confirmed
   * this pick's pool. Not part of the pick's identity: a selections change
   * that leaves the eligible pool unchanged keeps the same prompts.
   */
  selectionsKey: string;
  /** Structural snapshot of the project starter prompts behind this pick. */
  starterPromptsKey: string;
  signature: string;
  prompts: SuggestedPrompt[];
}

/**
 * Whether `pick` is the set to show for this pool. Selections are left out
 * on purpose: startup rebases the Home draft's selections several times
 * (projects loading, the Cowork seed, then the MRU project) and re-rolling
 * on each one flickered the visible suggestions (the pool rarely changes).
 */
function pickMatchesPool(
  pick: PickedSet,
  surface: SuggestedPromptSurface,
  seedKey: string,
  starterPromptsKey: string,
  signature: string,
): boolean {
  return (
    pick.surface === surface &&
    pick.seedKey === seedKey &&
    pick.starterPromptsKey === starterPromptsKey &&
    pick.signature === signature
  );
}

/**
 * A pick without curated MCP prompts is valid under any selections. This
 * relies on `curatedKey` being non-null exactly for prompts tied to an MCP:
 * indexed and synthesized server prompts always carry their server key, while
 * generic fallbacks and project starter prompts are null by construction (see
 * `@canopy/ui-shared/lib/mcp-prompt-index` and `starterPromptsAsSuggestions`).
 */
function pickIsMcpIndependent(pick: PickedSet): boolean {
  return pick.prompts.every((prompt) => prompt.curatedKey === null);
}

const heldPicks = new Map<string, PickedSet>();
const heldInstanceCounts = new Map<string, number>();
/**
 * Last impression id-join per `${surface}:${seedKey}`, so a held double-mount
 * (or an unchanged-set re-render) records a single impression per distinct
 * displayed set.
 */
const lastImpressions = new Map<string, string>();

/**
 * Resolves the MCP-aware suggested prompts for one empty-state surface
 * (CAN-1809): detects the MCPs enabled for `selections`, filters to eligible
 * curated servers, and picks a stable rotating subset (generic fallbacks when
 * none are eligible). Passing `null` selections keeps the hook fully inert
 * (no fetch, no prompts, no telemetry) — callers pass `null` for excluded or
 * hidden surfaces. Fires one impression telemetry event per distinct
 * displayed set.
 *
 * A pick is keyed to its eligible pool, not to the selections snapshot: a
 * selections change whose inventory yields the same pool keeps the same
 * prompts, so startup selection churn neither flashes nor re-rolls. A pick
 * holding curated MCP prompts is still suppressed after a selections change
 * until the replacement inventory confirms its pool, so users can never
 * click a prompt for an MCP the new selections do not include; a pick of
 * generic or starter prompts stays visible throughout.
 */
export function useSuggestedPrompts(
  selections: ChatTabPluginSelections | null,
  options: UseSuggestedPromptsOptions,
): UseSuggestedPromptsResult {
  const {
    surface,
    seedKey,
    holdAcrossMounts,
    starterPrompts,
    seedingBlueprintStarterPrompts,
    localInventory = true,
  } = options;
  const { servers, loading } = useDetectedMcpServers(
    localInventory ? selections : null,
  );

  const selectionsKey = useMemo(
    () => (selections === null ? null : JSON.stringify(selections)),
    [selections],
  );
  // `null` and `undefined` are the same "never set" answer here, but an
  // explicit `[]` must key differently from both so a project that opted out
  // of starters does not adopt a held pick built from the generic pool.
  const starterPromptsKey = useMemo(
    () =>
      JSON.stringify({
        project:
          starterPrompts === undefined || starterPrompts === null
            ? null
            : starterPrompts,
        blueprint:
          seedingBlueprintStarterPrompts === undefined ||
          seedingBlueprintStarterPrompts === null
            ? null
            : seedingBlueprintStarterPrompts,
      }),
    [seedingBlueprintStarterPrompts, starterPrompts],
  );

  // Inventory readiness is tracked per selections snapshot: a completed
  // fetch (loading true -> false while this key was current) marks that
  // key's inventory trustworthy. Going inert (null selections) or switching
  // keys re-arms the guard, so a re-enable or selection change always waits
  // for its own fetch instead of picking from a stale/empty server list.
  const [fetchedForKey, setFetchedForKey] = useState<string | null>(null);
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (selectionsKey === null) {
      wasLoadingRef.current = false;
      setFetchedForKey(null);
      return;
    }
    if (loading) {
      wasLoadingRef.current = true;
      return;
    }
    if (wasLoadingRef.current) {
      wasLoadingRef.current = false;
      setFetchedForKey(selectionsKey);
    }
  }, [loading, selectionsKey]);
  const inventoryReady =
    selectionsKey !== null &&
    (!localInventory || fetchedForKey === selectionsKey);

  const eligible = useMemo(() => eligibleCuratedServers(servers), [servers]);
  // Keys only: display names feed synthesized prompt text but a cosmetic
  // rename must not re-roll an otherwise unchanged pool.
  const signature = suggestionPoolSignature(eligible.map((s) => s.key));
  const holdKey = holdAcrossMounts === true ? `${surface}:${seedKey}` : null;

  const [pick, setPick] = useState<PickedSet | null>(() =>
    holdKey !== null ? (heldPicks.get(holdKey) ?? null) : null,
  );
  const pickRef = useRef<PickedSet | null>(pick);
  pickRef.current = pick;

  useEffect(() => {
    if (selectionsKey === null || !inventoryReady) return;
    // The confirmed inventory yields the same pool: keep the prompts and
    // only record which selections confirmed them.
    const confirm = (kept: PickedSet): void => {
      const confirmed =
        kept.selectionsKey === selectionsKey
          ? kept
          : { ...kept, selectionsKey };
      if (confirmed !== pick) setPick(confirmed);
      if (holdKey !== null) heldPicks.set(holdKey, confirmed);
    };
    if (
      pick !== null &&
      pickMatchesPool(pick, surface, seedKey, starterPromptsKey, signature)
    ) {
      if (pick.selectionsKey !== selectionsKey) confirm(pick);
      return;
    }
    // Adopt a concurrent sibling's held pick before rolling a fresh one, so
    // simultaneously mounting instances converge on one set.
    if (holdKey !== null) {
      const held = heldPicks.get(holdKey);
      if (
        held !== undefined &&
        pickMatchesPool(held, surface, seedKey, starterPromptsKey, signature)
      ) {
        confirm(held);
        return;
      }
    }
    const next: PickedSet = {
      surface,
      seedKey,
      selectionsKey,
      starterPromptsKey,
      signature,
      prompts: pickSuggestedPrompts(
        eligible,
        Math.random,
        surface,
        starterPrompts,
        seedingBlueprintStarterPrompts,
      ),
    };
    setPick(next);
    if (holdKey !== null) {
      heldPicks.set(holdKey, next);
    }
    // `starterPrompts` itself is intentionally NOT a dependency: callers pass a
    // fresh array identity on every render, and `starterPromptsKey` is its
    // structural stand-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectionsKey,
    inventoryReady,
    pick,
    seedKey,
    signature,
    starterPromptsKey,
    eligible,
    holdKey,
    surface,
  ]);

  // Ref-counted hold lifecycle (mirrors useHomeHeading): drop the held set
  // only once every concurrent instance for this hold key has unmounted.
  useEffect(() => {
    if (holdKey === null) return;
    heldInstanceCounts.set(holdKey, (heldInstanceCounts.get(holdKey) ?? 0) + 1);
    // Re-assert in case a sibling instance's unmount cleanup dropped the held
    // pick between this instance's render and this effect committing.
    const current = pickRef.current;
    if (current !== null) {
      heldPicks.set(holdKey, current);
    }
    return (): void => {
      const next = (heldInstanceCounts.get(holdKey) ?? 1) - 1;
      if (next <= 0) {
        heldInstanceCounts.delete(holdKey);
        heldPicks.delete(holdKey);
        lastImpressions.delete(holdKey);
      } else {
        heldInstanceCounts.set(holdKey, next);
      }
    };
  }, [holdKey]);

  // A pick is only active for its surface, seed key and starter prompts. One
  // with curated MCP prompts also needs its selections confirmed, so it is
  // suppressed the moment selections change; generic prompts stay put.
  const activePick =
    selectionsKey !== null &&
    pick !== null &&
    pick.surface === surface &&
    pick.seedKey === seedKey &&
    pick.starterPromptsKey === starterPromptsKey &&
    (pick.selectionsKey === selectionsKey || pickIsMcpIndependent(pick))
      ? pick
      : null;

  useEffect(() => {
    if (activePick === null || activePick.prompts.length === 0) return;
    const impressionKey = `${surface}:${seedKey}`;
    const idJoin = activePick.prompts.map((prompt) => prompt.id).join(',');
    if (lastImpressions.get(impressionKey) === idJoin) return;
    lastImpressions.set(impressionKey, idJoin);
    trackSuggestedPromptImpression(surface, activePick.prompts);
  }, [activePick, surface, seedKey]);

  return {
    prompts: activePick?.prompts ?? [],
    loading: selectionsKey !== null && activePick === null,
  };
}
