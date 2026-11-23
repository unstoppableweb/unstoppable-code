import type {
  CreditsPrompt,
  CreditsPromptCondition,
  CreditsPromptState,
} from '../billing/credits/resolve-credits-prompt';

/**
 * Every source a chat can bill a turn to. Adding a source is one union member
 * here and one entry in {@link PROVIDER_SOURCE_ORDER}; hosts supply its facts
 * and presentation.
 *
 * `@canopy/ui-shared` cannot import app-state, so its provider-choice copy
 * mirrors this union; keep the two in step.
 */
export type ProviderSourceId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'gateway'
  | 'credits';

/**
 * Tie-break only; no source is preferred. Rows sort by what they can do
 * (group, then outcome) and fall back to this order between equals, so
 * credits is never pinned, boosted or pushed down: it is one provider among
 * peers.
 */
export const PROVIDER_SOURCE_ORDER: readonly ProviderSourceId[] = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'gateway',
  'credits',
];

/** A subscription or gateway source: every source except credits. */
export type ProviderAccountSourceId = Exclude<ProviderSourceId, 'credits'>;

/** The minimum a model needs for a row to name it ("Stays on {label}"). */
export interface ProviderChoiceModel {
  readonly id: string;
  readonly label: string;
}

/** Where a source's connection stands, as the host last read it. */
export type ProviderConnection =
  | { readonly kind: 'ready' }
  /** Connected, but its usage limit is reached. `null` when no reset time is known. */
  | { readonly kind: 'limited'; readonly resetsAt: number | null }
  | { readonly kind: 'not-connected' }
  /** The read has not settled yet. A checking row is never usable. */
  | { readonly kind: 'checking' };

/**
 * Why a host cannot offer a source at all, independent of the model.
 *
 * - `desktop-only`: the host has no `subscriptionProviders` capability.
 * - `cross-harness`: the source exists but nothing it offers runs on this
 *   chat's harness, and this host cannot fork the chat.
 * - `policy`: the organization's policy rules the source out.
 */
export type ProviderUnsupportedReason =
  | 'desktop-only'
  | 'cross-harness'
  | 'policy';

/** Facts shared by every source's row. */
interface ProviderSourceFactsBase<TModel extends ProviderChoiceModel> {
  readonly unsupported?: ProviderUnsupportedReason;
  /**
   * The source can run the target's model: the chat's current model in
   * `continue-chat` mode, or the requested model in `run-model` mode.
   */
  readonly runsTargetModel: boolean;
  /**
   * The source's own route for the target's model (for example a gateway
   * slug for a native model, or the same id), as the host's model matcher
   * found it. `continue-chat` only; ignored for `run-model`. The row then
   * stays on the chat's model and dispatches this route.
   */
  readonly equivalentModel?: TModel;
  /**
   * The source's own default model, offered when it cannot run the target's
   * model in `continue-chat` mode. Omit when the source has no runnable model.
   */
  readonly defaultModel?: TModel;
  /**
   * A user-facing reason the chat cannot move to this source right now (for
   * example desktop's `canSwitchChatProvider` reason). Hosts re-check it when
   * the action runs, because a turn can start while the list is open.
   */
  readonly blockedReason?: string;
}

/** Facts for a subscription provider or an AI gateway. */
export interface ProviderSourceFacts<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> extends ProviderSourceFactsBase<TModel> {
  readonly source: ProviderAccountSourceId;
  readonly connection: ProviderConnection;
  /** The host can start this source's connect (or gateway set-up) flow. */
  readonly connectable: boolean;
  /**
   * The source lists its models only once connected (an own API key), so
   * before that "no runnable model" still offers Connect, the step that
   * would find one. A gateway always behaves this way.
   */
  readonly modelsAfterConnect?: boolean;
}

/** What the credits balance read found. A failed read is `unknown`, never empty. */
export type CreditsBalanceState = 'spendable' | 'empty' | 'unknown';

/**
 * Facts for the credits source. The purchase fields are
 * {@link CreditsPromptState} minus `condition`, which comes from the input,
 * so the guest, buyer, organization-member and pending rules stay in
 * `resolveCreditsPrompt`.
 */
export interface CreditsSourceFacts<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
>
  extends
    ProviderSourceFactsBase<TModel>,
    Omit<CreditsPromptState, 'condition'> {
  readonly source: 'credits';
  readonly balance: CreditsBalanceState;
}

export type AnyProviderSourceFacts<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> = ProviderSourceFacts<TModel> | CreditsSourceFacts<TModel>;

/** What the list is choosing a provider for. */
export type ProviderChoiceTarget<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> =
  /**
   * Recovery: keep this chat going, on its model where a source can run it.
   * `model` is the chat's current model, when the host knows it.
   */
  | { readonly kind: 'continue-chat'; readonly model?: TModel }
  /** A locked-model pick: only sources that run exactly this model are usable. */
  | { readonly kind: 'run-model'; readonly model: TModel }
  /**
   * Setting up providers before any chat (first run, the web first-visit
   * card): every source is listed in the host's order, connected ones
   * included, and no row is recommended. There is no model to keep.
   */
  | { readonly kind: 'set-up' };

export interface ProviderChoiceInput<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> {
  /** The source this chat bills now, or `null` when it has none. */
  readonly current: ProviderSourceId | null;
  /** Why the list is shown; passed to `resolveCreditsPrompt` for the credits row. */
  readonly condition: CreditsPromptCondition;
  readonly target: ProviderChoiceTarget<TModel>;
  /** One entry per source the host offers. Sources without facts get no row. */
  readonly sources: readonly AnyProviderSourceFacts<TModel>[];
}

/** Why a row cannot be chosen. */
export type ProviderChoiceUnavailableReason =
  | ProviderUnsupportedReason
  /** `run-model` mode: the source does not offer the requested model. */
  | 'model-not-offered'
  /** The source cannot run the chat's model and has no default to offer. */
  | 'no-runnable-model'
  /** The source's usage limit is reached. */
  | 'limited'
  /** The chat cannot move to this source right now; see `detail`. */
  | 'blocked';

/** What choosing a row does to the chat's model. */
export type ProviderChoiceOutcome<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> =
  /**
   * Stays on the target's model ("Stays on {label}"). `model` is the
   * target's model, for the label, when known. `route` is the source's own
   * route to dispatch, set whenever the source matched one (its id may equal
   * the target's); without it the host runs the target's model as is.
   */
  | {
      readonly kind: 'same-model';
      readonly model?: TModel;
      readonly route?: TModel;
    }
  /** Moves to the source's default model ("Switches to {label}"). */
  | { readonly kind: 'switch-model'; readonly target: TModel }
  | {
      readonly kind: 'unavailable';
      readonly reason: ProviderChoiceUnavailableReason;
      /** The host's blocked reason, for `blocked`. */
      readonly detail?: string;
      /** The reset time, for `limited`; `null` when unknown. */
      readonly resetsAt?: number | null;
    };

/**
 * The one action a row offers. `buy`, `sign-in-to-buy`, `check-again` and
 * `ask-admin` only ever appear on the credits row.
 */
export type ProviderChoiceAction =
  | 'use'
  | 'connect'
  | 'set-up'
  | 'buy'
  | 'sign-in-to-buy'
  | 'check-again'
  | 'ask-admin'
  | 'none';

/**
 * How a list presents a row, by what it can do now:
 *
 * - `ready`: choosing it continues the chat now.
 * - `needs-setup`: it needs a connect, set up or credits step first.
 * - `unavailable`: it offers nothing now, is still being checked, or needs
 *   an admin.
 *
 * `@canopy/ui-shared` mirrors this union for its headings; keep the two in
 * step.
 */
export type ProviderChoiceGroup = 'ready' | 'needs-setup' | 'unavailable';

/** The groups in the order a list shows them. */
export const PROVIDER_CHOICE_GROUP_ORDER: readonly ProviderChoiceGroup[] = [
  'ready',
  'needs-setup',
  'unavailable',
];

export interface ProviderChoiceRow<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> {
  readonly source: ProviderSourceId;
  /**
   * The chat bills this source now. It offers `none`, except Reconnect
   * (`connect` or `set-up`) when it is signed out, and the credits purchase
   * when its balance is empty.
   */
  readonly isCurrent: boolean;
  /** Credits report `ready` while spendable and `not-connected` otherwise. */
  readonly connection: ProviderConnection;
  readonly outcome: ProviderChoiceOutcome<TModel>;
  readonly action: ProviderChoiceAction;
  readonly group: ProviderChoiceGroup;
  /** The credits row's full prompt, for its completion controls (Reopen billing). */
  readonly creditsPrompt?: CreditsPrompt;
}

/** The single button a recovery notice shows. */
export type ProviderChoicePrimary =
  /** Exactly one other row is usable now: "Continue with {provider}". */
  | { readonly kind: 'continue-with'; readonly source: ProviderSourceId }
  /** The chat has a current source: "Switch provider" opens the list. */
  | { readonly kind: 'switch-provider' }
  /** The chat has no current source, or a `run-model` pick: "Choose provider". */
  | { readonly kind: 'choose-provider' };

export interface ProviderChoices<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
> {
  /**
   * The rows a list shows, sorted by group, then outcome, then
   * {@link PROVIDER_SOURCE_ORDER}. In `continue-chat` mode the current row
   * is listed only when it offers an action (Reconnect, Buy, Ask admin).
   */
  readonly rows: readonly ProviderChoiceRow<TModel>[];
  /**
   * The current source's row, listed or not, so a header can explain it.
   * `null` when the chat has no current source or the host gave no facts for it.
   */
  readonly current: ProviderChoiceRow<TModel> | null;
  /**
   * The one row a list emphasizes: the first `ready` row with a `use`
   * action, preferring one that keeps the chat's model. `null` when nothing
   * is ready, so no button is primary.
   */
  readonly recommended: ProviderSourceId | null;
  readonly primary: ProviderChoicePrimary;
}
