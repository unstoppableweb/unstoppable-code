import {
  AI_CREDITS_CHECK_AGAIN_LABEL,
  AI_CREDITS_GUEST_PURCHASE_LABEL,
  AI_CREDITS_PURCHASE_LABEL,
  CONTACT_ORG_ADMIN_COPY,
} from './creditsPromptCopy';

/**
 * Every word the provider-choice surfaces say: the recovery notices' single
 * button, the Switch provider dialog's header, group headings and rows
 * (each row's one outcome line), and the locked-model hints. Credits are one
 * provider among peers, so nothing here sells; the only purchase action is
 * the credits row's, in the purchase labels' words
 * (docs/ux-writing/labels.md#ai-credits-purchases).
 */

/**
 * The sources a chat can bill a turn to. Mirrors `ProviderSourceId` in
 * `@canopy/app-state/provider-choice`, which this display package can't
 * import; keep the two in step.
 */
export type ProviderChoiceSourceKey =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'gateway'
  | 'credits';

/**
 * Mirrors `ProviderChoiceAction` in `@canopy/app-state/provider-choice`. A
 * resolved row's `action` is assignable to it.
 */
export type ProviderChoiceActionKey =
  | 'use'
  | 'connect'
  | 'set-up'
  | 'buy'
  | 'sign-in-to-buy'
  | 'check-again'
  | 'ask-admin'
  | 'none';

/** The notice button when the chat has a current source. */
export const SWITCH_PROVIDER_LABEL = 'Switch provider';

/** The notice button when the chat has none, and every locked-model entry. */
export const CHOOSE_PROVIDER_LABEL = 'Choose provider';

/**
 * The notice's menu button when one other source is usable now. Its menu
 * offers "Continue with {provider}" and Choose provider, since a source that
 * still needs connecting or buying may be the one the user wants.
 */
export const CONTINUE_MENU_LABEL = 'Continue';

/**
 * Why a provider choice is open. Mirrors `CreditsPromptCondition` in
 * `@canopy/app-state/billing/credits`; keep the two in step.
 */
export type ProviderChoiceConditionKey =
  | 'out_of_credits'
  | 'quota_limit'
  | 'no_billing_source'
  | 'model_locked'
  | 'queued_held'
  | 'own_key_limit';

/**
 * Mirrors `ProviderChoiceGroup` in `@canopy/app-state/provider-choice`: how
 * a list groups its rows, by what each can do now.
 */
export type ProviderChoiceGroupKey = 'ready' | 'needs-setup' | 'unavailable';

/** Each group's heading in the Switch provider dialog. */
export const PROVIDER_CHOICE_GROUP_HEADINGS: Readonly<
  Record<ProviderChoiceGroupKey, string>
> = {
  ready: 'Ready now',
  'needs-setup': 'Needs setup',
  unavailable: 'Not available',
};

/**
 * The Switch provider dialog's title: naming the model in `run-model` mode,
 * otherwise from why it opened. A stopped chat reads "Keep this chat going";
 * a held message, no billing source or no condition at all (the Components
 * Lab, or one cleared while the dialog is open) reads "Choose a provider".
 */
export function switchProviderDialogTitle({
  condition,
  modelLabel,
}: {
  readonly condition?: ProviderChoiceConditionKey | null;
  readonly modelLabel?: string;
} = {}): string {
  const label = modelLabel?.trim();
  if (label) return `Choose a provider for ${label}`;
  return condition === 'quota_limit' || condition === 'out_of_credits'
    ? 'Keep this chat going'
    : 'Choose a provider';
}

/** The carryover promise every recovery subtitle ends on. */
const CARRIES_OVER = 'Choose another provider and this chat carries over.';

/**
 * The usage-limit subtitle after the limited provider's name, which the
 * dialog renders in front as a node (a gateway's name is user-written and
 * masked, so it is never interpolated here): "reached its usage limit and
 * resets at 3:00 PM. Choose another provider and this chat carries
 * over." Without a reset time the clause drops.
 */
export function usageLimitReasonAfterName(resetsLabel?: string): string {
  const resets = resetsLabel?.trim();
  return resets
    ? `reached its usage limit and resets at ${resets}. ${CARRIES_OVER}`
    : `reached its usage limit. ${CARRIES_OVER}`;
}

/**
 * The Switch provider dialog's subtitle when no provider name leads it, or
 * `undefined` when there is none (a locked-model pick, or no condition). A
 * usage limit with no limited current source names no one.
 */
export function providerChoiceReason(
  condition: ProviderChoiceConditionKey | null | undefined,
): string | undefined {
  switch (condition) {
    case 'quota_limit':
      return `You reached a usage limit. ${CARRIES_OVER}`;
    case 'out_of_credits':
      return "You're out of credits. Buy more or choose another provider. This chat carries over.";
    case 'no_billing_source':
    case 'queued_held':
      return 'Choose one to send your message.';
    case 'model_locked':
    case 'own_key_limit':
    case null:
    case undefined:
      return undefined;
  }
}

/**
 * What choosing a row does to the chat's model, split around the model so
 * the row can set the model apart. Reads as a sentence without the markup:
 * "Stays on Opus 4.7", or "Stays on your current model" when the label is
 * unknown (then `model` is absent).
 */
export interface ProviderChoiceOutcomeWords {
  /** The words before the model: "Stays on" or "Switches to". */
  readonly lead: string;
  /** The model's label; absent when `lead` already names it. */
  readonly model?: string;
}

/** A row that keeps the chat on its model. */
export function staysOn(modelLabel?: string): ProviderChoiceOutcomeWords {
  const model = modelLabel?.trim();
  return model
    ? { lead: 'Stays on', model }
    : { lead: 'Stays on your current model' };
}

/** A row that moves the chat to the source's own model. */
export function switchesTo(modelLabel: string): ProviderChoiceOutcomeWords {
  return { lead: 'Switches to', model: modelLabel };
}

/** The step a row needs before its outcome applies, after the outcome. */
export type ProviderChoiceSetupStep =
  | 'connect'
  | 'reconnect'
  | 'add-credits'
  | 'credits-arrive';

/** The words after an outcome for a row that needs a step first. */
export const PROVIDER_CHOICE_SETUP_SUFFIXES: Readonly<
  Record<ProviderChoiceSetupStep, string>
> = {
  // A gateway's setup reads the same as a subscription's connect.
  connect: 'after you connect',
  reconnect: 'after you reconnect',
  'add-credits': 'after you buy credits',
  'credits-arrive': 'once your credits arrive',
};

/**
 * The notice button when exactly one other source can keep the chat going.
 * The credits source reads "credits"; the credits row itself keeps the brand
 * app name the host passes.
 */
export function continueWithLabel(
  source: ProviderChoiceSourceKey,
  providerName: string,
): string {
  return source === 'credits'
    ? 'Continue with credits'
    : `Continue with ${providerName}`;
}

/**
 * The Switch provider dialog's error when choosing a row didn't move the
 * chat (a refused model change, or routing that couldn't be saved). The
 * credits source reads "credits", as in {@link continueWithLabel}.
 */
export function providerSwitchFailedMessage(
  source: ProviderChoiceSourceKey,
  providerName: string,
): string {
  const name = source === 'credits' ? 'credits' : providerName;
  return `Couldn't switch to ${name}.`;
}

/** The usage-limit notice's Resume action. */
export function resumeAtLabel(timeLabel?: string): string {
  return timeLabel ? `Resume at ${timeLabel}` : 'Resume at reset';
}

/** The usage-limit notice's message. */
export function usageLimitMessage(resetsLabel?: string): string {
  return resetsLabel
    ? `Your limit resets at ${resetsLabel}. You can wait, or keep going with another provider.`
    : 'You can wait for your limit to reset, or keep going with another provider.';
}

/**
 * The usage-limit notice's copy for a resume that waits on provider usage
 * (CAN-7483). Only hosts that can schedule a resume use it; the Remote
 * Control mirror keeps {@link usageLimitMessage} and {@link resumeAtLabel}.
 * A pending check names when it looks again, never a promised send.
 */
export const USAGE_LIMIT_RESUME_COPY = {
  /** The message when the provider gave no reset time. */
  unknownReset: (providerName: string): string =>
    `${providerName} didn't say when it resets.`,
  /** The Resume action when the reset time is unknown. */
  resumeWhenBack: (providerName: string): string =>
    `Resume when ${providerName} is back`,
  /** A timed resume is pending. */
  scheduled: (timeLabel: string): string =>
    `This chat resumes automatically at ${timeLabel}.`,
  /** A usage check is pending; the time is the next check. */
  checking: (timeLabel: string, providerName: string): string =>
    `We'll check again at ${timeLabel} and resume this chat once ${providerName} is back.`,
  cancel: 'Cancel resume',
  canceled: 'Resume canceled.',
  cancelFailed: "Couldn't cancel the resume.",
  noLongerPending: 'No resume is scheduled now.',
  scheduleFailed: "Couldn't schedule the resume.",
  resumeFailed: "Couldn't resume this chat. Switch provider to keep going.",
  /** Usage for the interrupted account can't be read, so nothing waits. */
  unreadable: (providerName: string): string =>
    `Couldn't check ${providerName}'s usage, so this chat won't resume by itself. Switch provider to keep going.`,
  /** The check stopped after its seven-day limit. */
  expired: (providerName: string): string =>
    `${providerName} was still limited after 7 days, so this chat didn't resume. Resume when ${providerName} is back, or switch provider.`,
} as const;

/**
 * A row's status and outcome lines. A row's outcome otherwise comes from
 * {@link staysOn} or {@link switchesTo}; the current source's limit is the
 * dialog's subtitle, not a row line.
 */
export const PROVIDER_CHOICE_ROW_COPY = {
  /** The current row's badge, after its name. */
  current: 'Current',
  checking: 'Checking…',
  notConnected: 'Not connected',
  /** Another provider's limit, on its own row. */
  limited: (resetsLabel?: string): string =>
    resetsLabel ? `Limit reached, resets at ${resetsLabel}` : 'Limit reached',
  modelNotOffered: (modelLabel: string): string =>
    `Doesn't offer ${modelLabel}`,
  desktopOnly: 'Available in the desktop app',
  crossHarness: 'Not available for this chat yet',
  policy: 'Turned off by your organization',
  noRunnableModel: 'No model available',
  /** A gateway not set up yet: its models are unknown until it is. */
  pickModelOnceConnected: "Choose a model once it's connected",
  /** A row that offers nothing and has no other reason to give. */
  notAvailableNow: 'Not available right now',
  askAdmin: CONTACT_ORG_ADMIN_COPY,
} as const;

/**
 * The label of each row action that is a plain button. A gateway's set up
 * reads Connect, like a subscription's; the action key stays apart because
 * hosts route it to the gateway's own setup.
 */
export const PROVIDER_CHOICE_ACTION_LABELS: Readonly<
  Record<Exclude<ProviderChoiceActionKey, 'ask-admin' | 'none'>, string>
> = {
  use: 'Continue',
  connect: 'Connect',
  'set-up': 'Connect',
  buy: AI_CREDITS_PURCHASE_LABEL,
  'sign-in-to-buy': AI_CREDITS_GUEST_PURCHASE_LABEL,
  'check-again': AI_CREDITS_CHECK_AGAIN_LABEL,
};

/** The AI gateway row's name before a gateway is set up. */
export const GATEWAY_ROW_NAME = 'AI gateway';

/** The AI gateway row's description before a gateway is set up. */
export const GATEWAY_ROW_DESCRIPTION =
  'Use your own AI gateway, such as OpenRouter or LiteLLM.';

/**
 * The current row's Connect or Set up once it is signed out: connecting it
 * again is how the chat keeps going on the same source.
 */
export const PROVIDER_CHOICE_RECONNECT_LABEL = 'Reconnect';

/**
 * The credits row's description, on first run and in the Switch provider
 * dialog alike; the row itself carries the brand name. A known state
 * replaces it (the signed-in account on first run, an empty balance here).
 */
export const CREDITS_ROW_DESCRIPTION =
  'Pay as you go for top models from many providers.';

/** The credits row's description once its balance is known to be empty. */
export const CREDITS_ROW_EMPTY_DESCRIPTION = 'No credits';

/** How a locked-model hint names each source that can run the model. */
const RUNS_ON_NAMES: Readonly<Record<ProviderChoiceSourceKey, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gateway: 'your AI gateway',
  credits: 'credits',
};

/**
 * A locked model's hint, naming what can run it: "Runs on credits or your
 * AI gateway". Empty input reads as credits, the one source every locked
 * library model runs on.
 */
export function runsOnHint(
  sources: readonly ProviderChoiceSourceKey[],
): string {
  const names = (sources.length > 0 ? sources : ['credits' as const]).map(
    (source) => RUNS_ON_NAMES[source],
  );
  if (names.length === 1) return `Runs on ${names[0]}`;
  const head = names.slice(0, -1).join(', ');
  return `Runs on ${head} or ${names[names.length - 1]}`;
}

/**
 * A signed-out provider row's description: what connecting gets the user.
 * The credits row's description is the host's, since it names the brand.
 */
export const PROVIDER_ROW_DESCRIPTIONS: Readonly<
  Record<Exclude<ProviderChoiceSourceKey, 'credits'>, string>
> = {
  claude: 'Use your Claude subscription.',
  codex: 'Use your ChatGPT subscription.',
  cursor: 'Use your Cursor subscription.',
  copilot: 'Use your GitHub Copilot subscription.',
  gateway: GATEWAY_ROW_DESCRIPTION,
};
