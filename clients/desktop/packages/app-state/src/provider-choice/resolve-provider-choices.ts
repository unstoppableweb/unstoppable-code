import {
  resolveCreditsPrompt,
  type CreditsPrompt,
  type CreditsPromptAction,
} from '../billing/credits/resolve-credits-prompt';
import {
  PROVIDER_CHOICE_GROUP_ORDER,
  PROVIDER_SOURCE_ORDER,
  type AnyProviderSourceFacts,
  type CreditsSourceFacts,
  type ProviderChoiceAction,
  type ProviderChoiceGroup,
  type ProviderChoiceInput,
  type ProviderChoiceModel,
  type ProviderChoiceOutcome,
  type ProviderChoicePrimary,
  type ProviderChoiceRow,
  type ProviderChoices,
  type ProviderChoiceTarget,
  type ProviderConnection,
  type ProviderSourceFacts,
} from './types';

const READY: ProviderConnection = { kind: 'ready' };
const NOT_CONNECTED: ProviderConnection = { kind: 'not-connected' };

/** A row before its group is derived from its action and outcome. */
type UngroupedRow<TModel extends ProviderChoiceModel> = Omit<
  ProviderChoiceRow<TModel>,
  'group'
>;

/** The target's model, when the target names one. */
function targetModel<TModel extends ProviderChoiceModel>(
  target: ProviderChoiceTarget<TModel>,
): TModel | undefined {
  return target.model;
}

/**
 * "Stays on the target's model", labelled with it when known. A matched
 * `route` is always kept, even under the target's own id, so the host
 * dispatches it on that source.
 */
function sameModel<TModel extends ProviderChoiceModel>(
  target: ProviderChoiceTarget<TModel>,
  route?: TModel,
): ProviderChoiceOutcome<TModel> {
  const model = targetModel(target);
  return {
    kind: 'same-model',
    ...(model !== undefined ? { model } : {}),
    ...(route !== undefined ? { route } : {}),
  };
}

/**
 * What choosing a source does to the chat's model, before its connection is
 * considered. Unsupported and blocked sources are unavailable whatever the
 * model; otherwise the source runs the target's model, offers its default
 * (`continue-chat` only), or cannot help.
 */
function modelOutcome<TModel extends ProviderChoiceModel>(
  facts: AnyProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
): ProviderChoiceOutcome<TModel> {
  if (facts.unsupported !== undefined) {
    return { kind: 'unavailable', reason: facts.unsupported };
  }
  if (facts.blockedReason !== undefined) {
    return {
      kind: 'unavailable',
      reason: 'blocked',
      detail: facts.blockedReason,
    };
  }
  if (facts.runsTargetModel) return sameModel(target);
  if (target.kind === 'run-model') {
    return { kind: 'unavailable', reason: 'model-not-offered' };
  }
  // The source's own route for the chat's model under another id: the chat
  // stays on its model, and the host dispatches `route`.
  if (facts.equivalentModel !== undefined) {
    return sameModel(target, facts.equivalentModel);
  }
  // Never a switch to an empty target: no default means nothing to offer.
  return facts.defaultModel !== undefined
    ? { kind: 'switch-model', target: facts.defaultModel }
    : { kind: 'unavailable', reason: 'no-runnable-model' };
}

/**
 * The current row's outcome: it already bills the chat, so only a
 * `run-model` pick for a model it does not offer changes anything.
 */
function currentOutcome<TModel extends ProviderChoiceModel>(
  facts: AnyProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
): ProviderChoiceOutcome<TModel> {
  return target.kind === 'run-model' && !facts.runsTargetModel
    ? { kind: 'unavailable', reason: 'model-not-offered' }
    : sameModel(target);
}

function accountRow<TModel extends ProviderChoiceModel>(
  facts: ProviderSourceFacts<TModel>,
  target: ProviderChoiceTarget<TModel>,
  isCurrent: boolean,
): UngroupedRow<TModel> {
  const { connection } = facts;
  const connectAction: ProviderChoiceAction =
    facts.source === 'gateway' ? 'set-up' : 'connect';
  if (isCurrent) {
    // A signed-out current source offers Reconnect: reconnecting is how
    // this chat keeps going on the same model. Otherwise it offers nothing;
    // a header explains why it stopped.
    const outcome = currentOutcome(facts, target);
    const reconnect =
      connection.kind === 'not-connected' &&
      facts.connectable &&
      outcome.kind === 'same-model';
    return {
      source: facts.source,
      isCurrent,
      connection,
      outcome,
      action: reconnect ? connectAction : 'none',
    };
  }
  const outcome = modelOutcome(facts, target);
  // A gateway lists its models only once set up, so before that "no runnable
  // model" still offers Set up, the step that would find one. Subscription
  // rows know their default without signing in, so signing in would not
  // find one: they keep "no runnable model".
  const notConnectedYet =
    facts.source === 'gateway' &&
    connection.kind === 'not-connected' &&
    facts.connectable &&
    outcome.kind === 'unavailable' &&
    outcome.reason === 'no-runnable-model';
  if (outcome.kind === 'unavailable' && !notConnectedYet) {
    return {
      source: facts.source,
      isCurrent,
      connection,
      outcome,
      action: 'none',
    };
  }
  switch (connection.kind) {
    case 'ready':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: 'use',
      };
    case 'limited':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome: {
          kind: 'unavailable',
          reason: 'limited',
          resetsAt: connection.resetsAt,
        },
        action: 'none',
      };
    case 'not-connected': {
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: facts.connectable ? connectAction : 'none',
      };
    }
    case 'checking':
      return {
        source: facts.source,
        isCurrent,
        connection,
        outcome,
        action: 'none',
      };
  }
}

function creditsAction(prompt: CreditsPrompt): ProviderChoiceAction {
  const map: Record<CreditsPromptAction, ProviderChoiceAction> = {
    buy: 'buy',
    'sign-in': 'sign-in-to-buy',
    'check-again': 'check-again',
    'contact-admin': 'ask-admin',
    'reopen-billing': 'none',
    'retry-queued': 'none',
    none: 'none',
  };
  return map[prompt.primary];
}

function creditsRow<TModel extends ProviderChoiceModel>(
  facts: CreditsSourceFacts<TModel>,
  input: ProviderChoiceInput<TModel>,
  isCurrent: boolean,
): UngroupedRow<TModel> {
  const spendable = facts.balance === 'spendable';
  const connection = spendable ? READY : NOT_CONNECTED;
  // The purchase decision is resolveCreditsPrompt's, unchanged: guest,
  // buyer, organization member and pending rules live there alone.
  const creditsPrompt = resolveCreditsPrompt({
    billingEnabled: facts.billingEnabled,
    viewer: facts.viewer,
    owner: facts.owner,
    purchaseMode: facts.purchaseMode,
    pending: facts.pending,
    ...(facts.pendingFeedback !== undefined
      ? { pendingFeedback: facts.pendingFeedback }
      : {}),
    ...(facts.purchaseOnUnknownOwner !== undefined
      ? { purchaseOnUnknownOwner: facts.purchaseOnUnknownOwner }
      : {}),
    condition: input.condition,
  });
  const outcome: ProviderChoiceOutcome<TModel> = isCurrent
    ? currentOutcome(facts, input.target)
    : modelOutcome(facts, input.target);
  if (isCurrent && spendable) {
    return {
      source: 'credits',
      isCurrent,
      connection,
      outcome,
      action: 'none',
      creditsPrompt,
    };
  }
  // The current source with an empty balance still offers its purchase:
  // buying is how this chat keeps going on the same model.
  if (outcome.kind === 'unavailable') {
    return {
      source: 'credits',
      isCurrent,
      connection,
      outcome,
      action: 'none',
      creditsPrompt,
    };
  }
  return {
    source: 'credits',
    isCurrent,
    connection,
    outcome,
    action: spendable ? 'use' : creditsAction(creditsPrompt),
    creditsPrompt,
  };
}

function isUsableNow(row: UngroupedRow<ProviderChoiceModel>): boolean {
  return (
    !row.isCurrent &&
    row.action === 'use' &&
    (row.outcome.kind === 'same-model' || row.outcome.kind === 'switch-model')
  );
}

/** Which group a row belongs to, by what it can do now; first match wins. */
function rowGroup(row: UngroupedRow<ProviderChoiceModel>): ProviderChoiceGroup {
  if (row.connection.kind === 'checking') return 'unavailable';
  switch (row.action) {
    case 'ask-admin':
      return 'unavailable';
    case 'connect':
    case 'set-up':
    case 'buy':
    case 'sign-in-to-buy':
    case 'check-again':
      return 'needs-setup';
    case 'use':
    case 'none':
      return isUsableNow(row) || isUsableCurrent(row) ? 'ready' : 'unavailable';
  }
}

/**
 * The current source still runs the target (a `run-model` pick of a model
 * it offers): ready, though it offers no button and is never recommended.
 */
function isUsableCurrent(row: UngroupedRow<ProviderChoiceModel>): boolean {
  return (
    row.isCurrent &&
    row.connection.kind === 'ready' &&
    row.outcome.kind !== 'unavailable'
  );
}

const OUTCOME_ORDER: readonly ProviderChoiceOutcome['kind'][] = [
  'same-model',
  'switch-model',
  'unavailable',
];

function compareRows(
  a: ProviderChoiceRow<ProviderChoiceModel>,
  b: ProviderChoiceRow<ProviderChoiceModel>,
): number {
  return (
    PROVIDER_CHOICE_GROUP_ORDER.indexOf(a.group) -
      PROVIDER_CHOICE_GROUP_ORDER.indexOf(b.group) ||
    OUTCOME_ORDER.indexOf(a.outcome.kind) -
      OUTCOME_ORDER.indexOf(b.outcome.kind) ||
    PROVIDER_SOURCE_ORDER.indexOf(a.source) -
      PROVIDER_SOURCE_ORDER.indexOf(b.source)
  );
}

/**
 * The one decision every provider-choice surface makes: which sources a chat
 * can move to, what each does to its model, which action each row offers,
 * which row a list emphasizes, and the single button a recovery notice
 * shows. Pure; each host supplies the facts it already reads and renders the
 * rows in its own placement.
 *
 * - Outcome (`continue-chat`): a source that runs the chat's model, or has
 *   its own route for it under another id (`equivalentModel`, dispatched as
 *   `route`), stays on the model; otherwise it switches to its default, or
 *   cannot help. Unsupported and blocked sources are unavailable first.
 * - Groups: `ready` when it can be used now (or, for a `run-model` pick, is
 *   the current source and runs the model); `needs-setup` for connect, set
 *   up and the credits purchase steps (including a gateway not set up yet,
 *   whose model is unknown); `unavailable` for a row still checking, one that
 *   needs an admin, or one that offers nothing.
 * - Rows: sorted by group, then same-model before switch-model before
 *   unavailable, then {@link PROVIDER_SOURCE_ORDER} as a tie-break only.
 *   No source is boosted; credits gets no boost and no penalty. Between two
 *   rows with the same outcome, that fixed order alone decides which is
 *   `recommended`.
 * - Current: always returned as `current`. In `continue-chat` mode it stays
 *   in `rows` only when it offers an action (Reconnect when signed out, the
 *   credits purchase when empty), because the list's header explains it
 *   otherwise. A `run-model` pick keeps it listed with action `none`.
 * - Recommended: the first `ready` row with a `use` action, so a same-model
 *   row wins over a switch; `null` when nothing is ready. It is set even when
 *   several rows are ready, so the list still shows one primary button while
 *   `primary` reads Switch provider.
 * - Primary, `continue-chat` only: "Continue with X" when exactly one row
 *   other than `current` can be used now; X is always `recommended`. Rows
 *   that need connecting, setting up or buying never count, and a `checking`
 *   row never counts, so the label can settle from Switch to Continue once
 *   but not back after a click. Otherwise Switch provider, or Choose
 *   provider when the chat has no current source. `run-model` entry points
 *   always open the list (Choose provider).
 */
export function resolveProviderChoices<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
>(input: ProviderChoiceInput<TModel>): ProviderChoices<TModel> {
  const grouped = input.sources.map((facts): ProviderChoiceRow<TModel> => {
    const isCurrent = facts.source === input.current;
    const row =
      facts.source === 'credits'
        ? creditsRow(facts, input, isCurrent)
        : accountRow(facts, input.target, isCurrent);
    return { ...row, group: rowGroup(row) };
  });
  const current = grouped.find((row) => row.isCurrent) ?? null;
  const listed =
    input.target.kind === 'continue-chat'
      ? grouped.filter((row) => !row.isCurrent || row.action !== 'none')
      : grouped;
  const rows = [...listed].sort(compareRows);
  const recommended =
    rows.find((row) => row.group === 'ready' && row.action === 'use')?.source ??
    null;

  let primary: ProviderChoicePrimary;
  const usable = rows.filter(isUsableNow);
  if (input.target.kind === 'run-model') {
    primary = { kind: 'choose-provider' };
  } else if (usable.length === 1 && recommended !== null) {
    primary = { kind: 'continue-with', source: recommended };
  } else {
    primary =
      input.current === null
        ? { kind: 'choose-provider' }
        : { kind: 'switch-provider' };
  }
  return { rows, current, recommended, primary };
}
