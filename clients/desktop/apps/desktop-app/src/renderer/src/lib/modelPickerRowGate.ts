import { isNativeOpenCodeSelection } from '@canopy/desktop-shared/lib/chat-model-selection';
import type {
  AgentProviderType,
  ChatModel,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
  isOrgGatewayRoute,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  DEFAULT_OLLAMA_HARNESS,
  getExecutionHarnessForModel,
  hasGatewayModelRoutes,
  isAgentModel,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import { isModelBlocked } from '@canopy/desktop-shared/lib/model-policy';
import {
  isGuestAllowedModelId,
  type ModelLibraryAccess,
} from '@canopy/protocol/models';
import {
  describeLockedProviderReason,
  isContinuableHarnessPair,
} from '@/lib/chatProviderLock';
import { connectProviderLabel } from '@canopy/ui-shared';
import { brandText } from '@/lib/brand';
import { getProviderLabel } from '@/lib/providerLabels';
import type { BillingFramework } from '@/lib/chatBillingFramework';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import { resolveModelLibraryLock } from '@/lib/modelLibraryAccess';

/**
 * CAN-2349 — the single decision for what a model-picker row does.
 *
 * Every gate the picker used to evaluate inline (org policy, stale Agents, the
 * provider lock, gateway-only credits, native auth, AI-Credits routability) is
 * resolved here, once, in one ordered chain. Two things depend on that:
 *
 *  1. **Hiding** (case E) and the group-header drop need the gate BEFORE the
 *     rows render, and evaluating it twice — once to filter, once to render —
 *     is how the two quietly drift apart.
 *  2. **The matrix is unit-testable without React.** Modeled on the existing
 *     pure resolver `lib/chatBillingFramework.ts`.
 *
 * The rule the whole ticket rests on: a `recoverable` row is visually and
 * behaviorally INDISTINGUISHABLE from an available one. No dim, no lock icon,
 * no `aria-disabled`, no pre-emptive tooltip, no `sr-only` reason. The modal
 * does the explaining, and only for the user who actually wanted that model.
 */

/**
 * What a row belonging to a different execution harness than `lockedProvider`
 * does.
 *
 * - `'disabled'` (default): the row is greyed out and explains itself through
 *   the standard unavailable-reason tooltip. Every non-chat call site keeps
 *   this behavior at zero diff.
 * - `'continue'`: harness-mismatched Claude/Codex rows render as ordinary
 *   selectable models and call `onModelChange` like any other row. The consumer
 *   already knows `lockedProvider`, so it recognizes the cross-harness pick and
 *   owns the confirm-and-continue flow. Rows that can never be continued
 *   (Ollama in either direction) become case H instead.
 */
export type LockedProviderBehavior = 'disabled' | 'continue';

/** How a recoverable row gets un-gated. Drives which modal branch opens. */
export type ModelRecovery =
  /**
   * Case A — no native provider login AND not credits-eligible. `'claude' |
   * 'codex'` at the type level so Ollama (never gated on auth) cannot reach
   * this branch and offer a nonsensical "sign in to Ollama".
   */
  | {
      readonly kind: 'needs-billing-source';
      readonly provider: 'claude' | 'codex';
    }
  /** Case B — gateway-only model with no credits. Can never bill to a subscription. */
  | { readonly kind: 'needs-credits' }
  /**
   * CAN-3026 — a GUEST picked a model Canopy would pay for that is not on the
   * guest allowlist. An account is required, not a balance.
   *
   * Deliberately distinct from `needs-credits`: a guest may already be FUNDED,
   * so this modal must not lead with a purchase for something money cannot
   * buy. A guest or free user with no balance who picks an allowlisted
   * Canopy-paid model lands on `needs-credits`, whose modal offers
   * "Buy AI Credits" (CAN-4766: never free daily credits).
   *
   * `access` says which remedy the row's lock hint names (CAN-4028): sign-in
   * alone, or sign-in followed by a purchase. Absent means sign-in alone, so
   * a recovery built without it keeps the original behavior.
   */
  | {
      readonly kind: 'needs-account';
      readonly access?: 'needs_sign_in' | 'needs_sign_in_then_purchase';
    }
  /**
   * CAN-4028 — a SIGNED-IN account that has not made a card purchase picked a
   * model Canopy would pay for that is not on the allowlist. A purchase is the
   * missing thing, and specifically a purchase: leftover free credits are
   * spendable and still do not unlock the library, so this must never resolve
   * through the `needs-credits` coverage path, which treats any spendable
   * balance as the problem solved.
   */
  | { readonly kind: 'needs-purchase' }
  /** Case H — cross-harness pair that can never be continued (Ollama). */
  | {
      readonly kind: 'needs-new-chat';
      readonly lockedProvider: AgentProviderType;
      /** Effective execution harness, including the legacy Ollama repair. */
      readonly lockedHarness?: ModelHarness;
    };

/** Why a row is hard-disabled. Purely diagnostic; the copy lives in `reason`. */
export type ModelRowHardDisabledCause =
  | 'org-policy'
  | 'org-gateway'
  | 'stale-agent'
  | 'locked-provider'
  | 'no-credits'
  | 'no-billing-source';

export type ModelRowGate =
  | { readonly kind: 'available' }
  | { readonly kind: 'recoverable'; readonly recovery: ModelRecovery }
  | {
      readonly kind: 'hidden';
      readonly cause: 'not-billable-to-credits' | 'org-gateway-only';
    }
  | {
      readonly kind: 'hard-disabled';
      readonly cause: ModelRowHardDisabledCause;
      /**
       * The whole explanation, shown in the hover tooltip AND the
       * click-to-reveal (§6). Always present, so `ModelOption` needs no
       * per-case branch that could drift.
       */
      readonly reason: string;
    };

/** A gate that actually renders. Type-level narrowing, not an `as` cast. */
export type VisibleModelRowGate = Exclude<ModelRowGate, { kind: 'hidden' }>;

export interface ModelRowGateInput {
  readonly selectedHarness?: ModelHarness;
  readonly model: ChatModel;
  /** Row provider. For an Agent row this is its BASE model's provider. */
  readonly provider: AgentProviderType;
  readonly currentModel: ChatModel | undefined;
  /**
   * LOAD-BEARING. A gate may only resolve to `recoverable` when the caller
   * passes `providerAvailability` — i.e. it is a chat composer, not one of the
   * five config surfaces (`AgentModelModal`, `ModelAliasesEditor`,
   * `PipelineModelAliasEditor`, `HookActionEditor`, `AutomationsPage`).
   *
   * Those surfaces write a CONFIG VALUE (a pipeline alias, a hook action), not
   * a chat turn, so a purchase modal that then auto-commits a pipeline alias
   * would be wrong. With this false the resolver returns exactly what today's
   * code produces: zero diff at those five sites.
   */
  readonly gatingEnabled: boolean;
  /** Undefined = back-compat "everything is available" (the five config sites). */
  readonly availability: ProviderModelAvailability | undefined;
  readonly billingValue: BillingFramework | undefined;
  /** This particular entry explicitly selects hosted credits billing. */
  readonly requireCredits?: boolean;
  readonly lockedProvider: AgentProviderType | undefined;
  readonly lockedProviderBehavior: LockedProviderBehavior;
  readonly lockedProviderReason: string | undefined;
  /**
   * The chat's CAPTURED execution harness, when it has one.
   *
   * Authoritative over `lockedProvider` for deciding whether a row belongs to
   * this chat's harness: registry membership no longer implies the harness a
   * model actually runs on (a gateway model listed under Claude can be assigned
   * to the Codex harness). `lockedProvider` stays the fallback for chats with no
   * captured harness, and still drives the continue affordance. Recovery copy
   * names the effective harness when it is known.
   */
  readonly lockedHarness: ModelHarness | undefined;
  readonly executionHarnessExplicitlyChosen?: boolean;
  /** True when the consumer passed `onStartNewChat`, enabling case H. */
  readonly canStartNewChat: boolean;
  readonly modelPolicy: ReadonlySet<string>;
  /** Agent rows only: the Agent's base model is missing or unavailable. */
  readonly staleAgent: boolean;
  /**
   * True when the active owner's organization makes its gateway the only
   * route. Other organizations' gateway rows never reach the gate: the catalog
   * store hides them for the active owner.
   */
  readonly modelGatewayEnforced?: boolean;
  /**
   * Display name of the organization that owns the active work, used to name
   * it in policy and gateway reasons. Absent for Personal work and an unknown
   * owner, where the copy stays generic.
   */
  readonly organizationName?: string;
  /**
   * CAN-3026 — the saved Canopy Cloud credential is a guest.
   *
   * OPTIONAL, and absent means "not a guest": every existing caller keeps its
   * behavior at zero diff, and the five config surfaces never pass it. Only
   * `ModelPicker` reads it (from `useIsGuestCredential`), because guest-ness is
   * a session fact none of its eight call sites knows better than the store.
   */
  readonly isGuest?: boolean;
  /**
   * CAN-4028 — model-library access for the OWNER of this work.
   *
   * OPTIONAL, and absent means UNKNOWN, which renders no purchase lock: every
   * existing caller keeps its behavior, and a guest is still held to the
   * allowlist by {@link isGuest} alone. Callers must pass the owner's access,
   * not the person's — for organization-owned work the desktop has no such
   * read yet, so `ModelPicker` passes nothing there and the server enforces.
   */
  readonly libraryAccess?: ModelLibraryAccess;
}

/**
 * Reason copy for a row disabled purely by the provider lock.
 *
 * `lockedProviderReason` describes a chat that *could* be continued but is
 * blocked right now (streaming, queued turns, a pending plan approval), so the
 * consumer computes it for the one continuable target provider. It must not
 * leak onto a row that can never be continued at all: an Ollama row saying
 * "stop the current turn, then switch" promises a switch that will never
 * become available. Those rows always get the generic locked copy.
 */
function resolveLockedRowReason(
  lockedProvider: AgentProviderType,
  rowProvider: AgentProviderType,
  lockedProviderReason: string | undefined,
): string {
  return lockedProviderReason !== undefined &&
    isContinuableHarnessPair(lockedProvider, rowProvider)
    ? lockedProviderReason
    : describeLockedProviderReason(lockedProvider, rowProvider);
}

/**
 * CAN-3026 — may a guest run this picker selection where Canopy pays?
 *
 * The one place the shared `isGuestAllowedModelId` contract is fed a picker
 * model id, so the desktop and the server always judge the SAME spelling.
 *
 * An Agent overlay (`agent_model_*`) is unwrapped to its BASE model first, the
 * same way `resolveGatewayModelEntry` unwraps it before checking routability.
 * An Agent never reaches a provider — every caller resolves it to `baseModel` —
 * so the LLM proxy judges the base model's gateway id. Testing the raw overlay
 * id would refuse, on the client, a selection the server accepts, and no
 * sign-in could clear it. A stale Agent resolves to `undefined` and stays
 * refused, which is fail-closed.
 *
 * BOTH spellings are tested, and that is what makes the "same spelling" claim
 * structural rather than incidental (CAN-3026 review round 2). What the proxy
 * actually receives is the RESOLVED GATEWAY ID — every credit-routed call site
 * sends `entry.gatewayId` (`agents/ai-credits-routing.ts`, `claude-session.ts`,
 * `codex-session.ts`) — while this function is handed the picker's row id.
 * Those coincide only because the seeded catalog spells both allowlisted models
 * canonically. A registry ALIAS row, or a catalog re-spell, would silently
 * separate them.
 *
 * The check is an OR, so it can only ever ADMIT more, never refuse more. That
 * direction is the safe one and is the same reasoning as the overlay unwrap
 * above: the server remains authoritative and re-judges the gateway id itself,
 * whereas a client that wrongly refuses produces a dead end no sign-in clears.
 */
export function isGuestAllowedSelection(model: ChatModel | undefined): boolean {
  if (model === undefined) return false;
  const baseModel = isAgentModel(model) ? resolveRuntimeModel(model) : model;
  if (isGuestAllowedModelId(baseModel)) return true;
  return isGuestAllowedModelId(resolveGatewayModelEntry(baseModel)?.gatewayId);
}

/**
 * Resolve one row's gate.
 *
 * Ordering is the spec. Three choices in it are deliberate and load-bearing:
 *
 *  - **`currentModel` short-circuits the hide.** `resolveChatBillingFramework`
 *    already locks the toggle OFF for a non-routable selection, so a hidden
 *    current model should be unreachable — but without the guard one bad state
 *    makes the checked row vanish and the picker shows no selection at all.
 *  - **Locked outranks availability.** A cross-harness row for a user with no
 *    billing source is both H and A; H wins, because the row is unusable in
 *    *this* chat at any price. `NoBillingSourceBanner` explains the billing
 *    dead end once they are in the new chat.
 *  - **`loading` stays optimistic**, exactly as before. A row that is available
 *    only because a probe is in flight must never become `recoverable` — that
 *    is the trap that would auto-commit a model the user merely clicked.
 */
export function resolveModelRowGate(input: ModelRowGateInput): ModelRowGate {
  const {
    model,
    provider,
    currentModel,
    gatingEnabled,
    availability,
    billingValue,
    requireCredits,
    lockedProvider,
    lockedProviderBehavior,
    lockedProviderReason,
    lockedHarness,
    executionHarnessExplicitlyChosen,
    canStartNewChat,
    modelPolicy,
    staleAgent,
    modelGatewayEnforced,
    organizationName,
    isGuest,
    libraryAccess,
  } = input;
  const organizationGatewayRoute = isOrgGatewayRoute(model);

  /**
   * CAN-3026 — would this pick put a guest on a model CANOPY pays for that the
   * guest allowlist does not admit?
   *
   * Scoped to AI-Credits-routed selections only, applied at the two predicates
   * that already express "Canopy is paying": case B's `isGatewayOnlyModel` and
   * case A's `creditRouted`. A guest running their OWN Claude/Codex
   * subscription or local Ollama costs Canopy nothing, and `gpt-6-luna` is a
   * NATIVE Codex model — forcing it on a Claude-native guest would push them
   * OFF a free subscription ONTO the hosted gateway, raising cost for exactly
   * the users this gate targets.
   *
   * `model !== currentModel` for the same reason as cases E and 1b: a chat
   * already stamped on a model must keep rendering its own selection. The
   * server decides whether that turn actually runs.
   *
   * `gatingEnabled` keeps the five config surfaces at zero diff — they write a
   * config value, not a chat turn.
   *
   * Note `CREDITS_LANE_DEFAULT_CANDIDATES` is untouched: `deepseek-v4-pro`
   * remains the desktop AI-Credits lane default and is ON the allowlist, so a
   * guest who never opens the picker — or opens it and keeps the default —
   * never sees this prompt at all.
   *
   * Agent-overlay unwrapping lives in `isGuestAllowedSelection` above, shared
   * with the billing-framework toggle so both judge the same spelling.
   *
   * CAN-4028 widens WHO this applies to without changing where it applies. The
   * same allowlist now also holds a signed-in account that has not purchased,
   * and the two predicates below are still the only places it is consulted, so
   * a model the user runs on their own provider subscription or locally is
   * never library-locked for anyone. `resolveModelLibraryLock` keeps a guest
   * locked whatever `libraryAccess` says, which is the funded-guest rule.
   */
  const libraryLock = resolveModelLibraryLock(isGuest === true, libraryAccess);
  const libraryRecovery: ModelRecovery | undefined =
    libraryLock !== undefined &&
    gatingEnabled &&
    (model !== currentModel || requireCredits === true) &&
    !isGuestAllowedSelection(model)
      ? libraryLock === 'needs_purchase'
        ? { kind: 'needs-purchase' }
        : { kind: 'needs-account', access: libraryLock }
      : undefined;

  // 1. Org model policy. Normally these rows are already gone —
  // `modelCatalogStore` filters the registry — so this is the backstop for a
  // row surfaced from anywhere else. Ollama is never blocked (`isModelBlocked`
  // carves it out), so local models stay selectable for an enforcing org.
  if (isModelBlocked(model, modelPolicy)) {
    return {
      kind: 'hard-disabled',
      cause: 'org-policy',
      reason: organizationName
        ? `Blocked by ${organizationName}’s model policy.`
        : 'Blocked by your organization’s model policy.',
    };
  }

  // 1b. The org made its gateway the only route.
  //
  // HIDDEN rather than dimmed, for case E's reason (below): a row that can
  // never become selectable while enforcement stands is noise, and there were
  // enough of them to bury the handful the org actually permits underneath a
  // full-height wall of dead rows.
  //
  // Unlike case E and unlike org model policy, LOCAL models are hidden too:
  // when an admin turns on "Make this the only route", the org's gateway is
  // the ONLY route, local models included.
  //
  // The chat's own model is the exception, exactly as in case E: a chat stamped
  // before enforcement landed still has to render its selection, so it stays
  // visible and carries the explanation.
  if (modelGatewayEnforced === true && !organizationGatewayRoute) {
    // Hiding requires KNOWING the row is not an org route, and that answer
    // comes from the gateway route table. Cold, every model looks non-org,
    // including the org's own — which empties the picker down to the current
    // model. Case E guards its hide the same way. Degrade to the visible,
    // self-explaining row rather than to an empty list.
    return model === currentModel || !hasGatewayModelRoutes()
      ? {
          kind: 'hard-disabled',
          cause: 'org-gateway',
          reason: organizationName
            ? `${organizationName} requires its configured AI gateway.`
            : 'Your organization requires its configured AI gateway.',
        }
      : { kind: 'hidden', cause: 'org-gateway-only' };
  }

  // 2. Stale Agents are never selectable, and never recoverable: an Agent whose
  // base model left the registry is a broken definition, not an account state.
  // (`getAgentModelAvailability` returns only `'not_found'` /
  // `'base_model_unavailable'` — it never reflects auth or credits. An Agent's
  // auth/credits gate is just case A on its base provider, resolved below.)
  if (staleAgent) {
    return {
      kind: 'hard-disabled',
      cause: 'stale-agent',
      reason: 'This agent’s base model is unavailable.',
    };
  }

  // 3. Case E — under AI Credits, a model the gateway cannot route can never be
  // billed, so it is HIDDEN rather than dimmed. Dimming a row the user cannot
  // act on in any way is pure noise; the count note under the toggle says how
  // many went away and the toggle itself brings them back.
  // FAILS OPEN on an empty registry, for the same reason `ModelRecoveryModal`
  // does: the gateway registry starts empty and is filled from the
  // model-configuration broadcast, so during that window every model reads as
  // non-routable and this would hide the ENTIRE list. Unreachable today only
  // because `resolveChatBillingFramework` cannot resolve to `'ai-credits'`
  // while the registry is empty — an invariant enforced in a different file,
  // which is exactly the kind of cross-file coupling that regresses silently.
  // Ollama is carved out for the same reason case A carves it out below and
  // `resolveChatBillingFramework` states outright ("Ollama is local/free and
  // never carries a billing concept"): routability is not a question a local
  // model can fail. Hiding it here also named a remedy the user may not have —
  // with credits but no native login the framework returns `toggleDisabled`,
  // so "turn AI Credits off to see them" pointed at a control they cannot
  // operate while their local models silently left the picker.
  const notBillableToCredits =
    billingValue === 'ai-credits' &&
    provider !== 'ollama' &&
    // Cursor uses its own account regardless of the shared billing toggle.
    provider !== 'cursor' &&
    provider !== 'copilot' &&
    provider !== 'opencode' &&
    hasGatewayModelRoutes() &&
    !isGatewayRoutableModel(model);
  if (notBillableToCredits && model !== currentModel) {
    return { kind: 'hidden', cause: 'not-billable-to-credits' };
  }

  // 4. Harness lock. Mismatch is decided by the chat's CAPTURED harness when it
  // has one — registry membership no longer implies the harness a model runs on
  // — and falls back to the provider comparison for chats without one. Bind the
  // locked subject itself rather than a boolean plus a repeat of the
  // `!== undefined` half, which read as a second real condition when it was only
  // there to re-narrow the type.
  const rowHarness: ModelHarness =
    input.selectedHarness ??
    (model === currentModel && executionHarnessExplicitlyChosen === true
      ? lockedHarness
      : undefined) ??
    getExecutionHarnessForModel(model) ??
    (provider === 'ollama'
      ? DEFAULT_OLLAMA_HARNESS
      : provider === 'codex'
        ? 'codex'
        : 'claude');
  // Repair ONE specific bad inference, and nothing else.
  //
  // A chat persisted before `executionHarness` existed resolves its harness
  // through `inferLegacyExecutionHarness`, which reports 'claude' for an Ollama
  // model — but legacy Ollama chats ran on DEFAULT_OLLAMA_HARNESS ('codex').
  // Explicit per-chat choices must retain their captured harness. That single
  // wrong inferred value broke the lock in both directions: the
  // chat's own Ollama rows read as a mismatch against THEMSELVES, so case H
  // offered a new chat to reach the model already selected, while Claude rows
  // read as a match and were not gated at all.
  //
  // Deliberately narrow. `lockedProvider === 'ollama'` alone would be wrong
  // twice: with no captured harness it would synthesize one and flip the whole
  // comparison onto the harness branch, silently unlocking every Codex row in
  // an Ollama-locked chat; and with a correctly captured 'codex' it would
  // change behavior for MODERN Ollama chats, which legitimately run on the
  // Codex harness and may switch to a Codex model in place. Both are
  // load-bearing — the first is caught by "keeps Ollama rows locked under
  // 'continue' in both directions", the second by "falls back to
  // provider-derived harnesses when the snapshot is empty".
  //
  // Repaired here rather than in `inferLegacyExecutionHarness` because
  // `getLockedHarness` also feeds message-time harness capture in
  // `messaging.ts`; changing the shared inference would repin live chats.
  const effectiveLockedHarness: ModelHarness | undefined =
    lockedProvider === 'ollama' &&
    lockedHarness === 'claude' &&
    executionHarnessExplicitlyChosen !== true
      ? DEFAULT_OLLAMA_HARNESS
      : lockedHarness;
  const harnessMismatch =
    effectiveLockedHarness !== undefined
      ? effectiveLockedHarness !== rowHarness
      : lockedProvider !== undefined && lockedProvider !== provider;
  // `ModelHarness` is a subset of `AgentProviderType`, so the captured harness
  // can name the lock in copy and in the case-H recovery when a chat reports a
  // harness but no provider.
  const lockedOtherProvider: AgentProviderType | undefined = harnessMismatch
    ? (lockedProvider ?? lockedHarness)
    : undefined;
  if (
    (effectiveLockedHarness === 'opencode' || lockedProvider === 'opencode') &&
    rowHarness === 'opencode' &&
    isNativeOpenCodeSelection(currentModel) !== isNativeOpenCodeSelection(model)
  ) {
    return {
      kind: 'hard-disabled',
      cause: 'locked-provider',
      reason: 'Start a new chat to change the OpenCode billing selection.',
    };
  }
  if (
    lockedOtherProvider !== undefined &&
    ((rowHarness === 'opencode' && !isNativeOpenCodeSelection(model)) ||
      (lockedOtherProvider === 'opencode' &&
        !isNativeOpenCodeSelection(currentModel)))
  ) {
    return {
      kind: 'hard-disabled',
      cause: 'locked-provider',
      reason: 'Start a new chat to change its execution harness.',
    };
  }
  if (lockedOtherProvider !== undefined) {
    // Continuation stays a PROVIDER question: only Claude<->Codex chats carry
    // over. Fall back to the captured harness when the provider half is
    // unknown — `getLockedHarness` always resolves for a started chat but
    // `getLockedProvider` returns undefined for a tab with content and no
    // `providerType`/`model`, and in that window a genuinely continuable row
    // was being offered as "start a new chat" purely because the pair could not
    // be named. `ModelHarness` is a subset of `AgentProviderType`, so the
    // captured harness answers the same question.
    const continuablePair = isContinuableHarnessPair(
      lockedOtherProvider,
      provider,
    );
    const continuable =
      lockedProviderBehavior === 'continue' && continuablePair;
    if (!continuable) {
      // Case H — the pair can NEVER be continued (Ollama in either direction),
      // so there is no transient state to wait out. The only way to this model
      // is a fresh chat, and that is an offer, not a refusal.
      if (!continuablePair && canStartNewChat && gatingEnabled) {
        return {
          kind: 'recoverable',
          recovery: {
            kind: 'needs-new-chat',
            lockedProvider: lockedOtherProvider,
            ...(effectiveLockedHarness
              ? { lockedHarness: effectiveLockedHarness }
              : {}),
          },
        };
      }
      // Case J (and every non-continuable row without the new-chat affordance):
      // hard-disabled, with copy that names what clears it.
      return {
        kind: 'hard-disabled',
        cause: 'locked-provider',
        reason: resolveLockedRowReason(
          lockedOtherProvider,
          provider,
          lockedProviderReason,
        ),
      };
    }
  }

  // No availability info => back-compat: treat the row as available.
  const nativeAuth = availability ? availability.nativeAuth : true;
  const loading = availability ? availability.loading : false;
  const creditsEligible = availability ? availability.creditsEligible : false;
  const isOllama = provider === 'ollama';

  // AI gateway traffic is billed under the organization's own
  // provider contract. Hosted AI Credits and native-login availability do not
  // gate it; credential readiness is surfaced by the dedicated setup banner.
  if (organizationGatewayRoute) {
    return { kind: 'available' };
  }

  // 5. Case B — gateway-only models (e.g. DeepSeek V4 Pro) can never be billed
  // via a native provider login, so they ignore `nativeAuth` and the
  // subscription/credits toggle entirely: usable only with AI Credits, and only
  // when the model is gateway-routable. Optimistic while the probe is loading.
  if (isGatewayOnlyModel(model) || requireCredits) {
    // CAN-3026 — checked BEFORE `gatewayLoading`/`creditsEligible`, so a FUNDED
    // guest (one holding leftover free credits) cannot resolve `available`
    // first. A gateway-only model is always billed by Canopy. The same order
    // keeps a signed-in non-payer's leftover free credits from clearing the
    // lock.
    if (libraryRecovery !== undefined) {
      return { kind: 'recoverable', recovery: libraryRecovery };
    }
    // Native auth cannot unlock a gateway-only model. Follow the credits probe
    // specifically so a failed native-auth probe cannot keep the row enabled.
    const gatewayLoading = availability
      ? (availability.creditsLoading ?? loading)
      : loading;
    const gatewayOnlyEnabled =
      gatewayLoading || (creditsEligible && isGatewayRoutableModel(model));
    if (gatewayOnlyEnabled) {
      return { kind: 'available' };
    }
    return gatingEnabled
      ? { kind: 'recoverable', recovery: { kind: 'needs-credits' } }
      : {
          kind: 'hard-disabled',
          cause: 'no-credits',
          reason: `Only available with AI Credits. Connect your ${brandText.appName} account to use this model.`,
        };
  }

  // 6. Case A — nothing can pay for this provider's models. Credit-routed
  // models are enabled silently (no per-row badge); the account-level routing
  // status is surfaced by the shared chat banner instead.
  const needsCreditsRoute =
    !isOllama && !nativeAuth && !loading && isGatewayRoutableModel(model);
  const creditRouted = needsCreditsRoute && creditsEligible;
  // CAN-3026 — the other half of "Canopy is paying": no provider subscription,
  // so this native-registry model bills AI Credits. This is why gating
  // gateway-only rows alone would be insufficient — `gpt-6-luna` is itself a
  // native Codex model that routes through credits for a guest with no Codex
  // login, and so is every expensive Claude model beside it.
  // CAN-5211: an unfunded guest still needs this account gate. Funding is
  // what the offered guest fallback recovers; it cannot decide whether the
  // advanced model's account requirement is shown in the first place.
  if (
    (creditRouted || (isGuest === true && needsCreditsRoute)) &&
    libraryRecovery !== undefined
  ) {
    return { kind: 'recoverable', recovery: libraryRecovery };
  }
  const availabilityDisabled = !(
    isOllama ||
    nativeAuth ||
    loading ||
    creditRouted
  );
  if (availabilityDisabled) {
    if (gatingEnabled && (provider === 'claude' || provider === 'codex')) {
      return {
        kind: 'recoverable',
        recovery: { kind: 'needs-billing-source', provider },
      };
    }
    return {
      kind: 'hard-disabled',
      cause: 'no-billing-source',
      reason: `${connectProviderLabel(getProviderLabel(provider))} or buy AI Credits to use these models.`,
    };
  }

  // 7. Available. This includes the `currentModel` that step 3 refused to hide:
  // it is the selection the picker must keep showing as checked, and the
  // billing toggle is already locked OFF for it upstream.
  return { kind: 'available' };
}
