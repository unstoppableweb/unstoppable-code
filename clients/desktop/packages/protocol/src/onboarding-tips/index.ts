/**
 * Onboarding tips (CAN-4904): the ids of the one-time tips the app can show,
 * in priority order, and the dismissal state every host shares.
 *
 * A tip the user dismissed (Got it, the close button, or acting on it) stays
 * gone until they choose "Show tips again" in Settings. The desktop keeps the
 * decision in its preferences, and a Portal session on the web reads and
 * writes it through the paired desktop, so both surfaces agree.
 */

/**
 * Every tip, highest priority first. When more than one tip applies to the
 * screen the user arrives on, the earliest one in this list shows.
 */
export const ONBOARDING_TIP_IDS = [
  'workflows',
  'worktree-chat',
  'workflows-schedule',
  // Not a slot tip: the one-time notice that a person's global connectors
  // stay out of organization projects (CAN-6230) keeps its dismissal here, so
  // the desktop and a Portal tab agree on it.
  'org-project-connectors',
  // Not a slot tip yet: the one-time tip that a send while a turn runs steers
  // it (CAN-7349). Shown only behind the Steer by default Labs experiment.
  'steer-by-default',
] as const;

export type OnboardingTipId = (typeof ONBOARDING_TIP_IDS)[number];

export const CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID = 'claude-connector-notice';
export const ONBOARDING_DISMISSAL_IDS = [
  ...ONBOARDING_TIP_IDS,
  CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID,
] as const;

export type OnboardingDismissalId = (typeof ONBOARDING_DISMISSAL_IDS)[number];

const TIP_ID_SET: ReadonlySet<string> = new Set(ONBOARDING_TIP_IDS);

export function isOnboardingTipId(value: unknown): value is OnboardingTipId {
  return typeof value === 'string' && TIP_ID_SET.has(value);
}

/** When each dismissed tip was dismissed (ISO 8601). */
export type OnboardingTipDismissals = Readonly<
  Partial<Record<OnboardingDismissalId, string>>
>;

/** The shared dismissal state. */
export interface OnboardingTipsState {
  readonly dismissed: OnboardingTipDismissals;
}

/** Dismiss one tip or notice, or bring resettable tips back ("Show tips again"). */
export type OnboardingTipsUpdate =
  | { readonly action: 'dismiss'; readonly tipId: OnboardingDismissalId }
  | { readonly action: 'reset' };

export const EMPTY_ONBOARDING_TIPS_STATE: OnboardingTipsState = {
  dismissed: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keeps only known tip ids with a parseable timestamp, so a value from an
 * older or newer release, or a hand-edited file, never breaks a reader.
 */
export function normalizeOnboardingTipDismissals(
  value: unknown,
): OnboardingTipDismissals {
  if (!isRecord(value)) return {};
  const dismissed: Partial<Record<OnboardingDismissalId, string>> = {};
  for (const id of ONBOARDING_DISMISSAL_IDS) {
    const at = value[id];
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
      dismissed[id] = at;
    }
  }
  return dismissed;
}

/** Parses a state received over a transport, or null when it is malformed. */
export function parseOnboardingTipsState(
  value: unknown,
): OnboardingTipsState | null {
  if (!isRecord(value) || !isRecord(value.dismissed)) return null;
  return { dismissed: normalizeOnboardingTipDismissals(value.dismissed) };
}

/** Parses an update request, or null when it is malformed. */
export function parseOnboardingTipsUpdate(
  value: unknown,
): OnboardingTipsUpdate | null {
  if (!isRecord(value)) return null;
  if (value.action === 'reset') return { action: 'reset' };
  if (
    value.action === 'dismiss' &&
    (isOnboardingTipId(value.tipId) ||
      value.tipId === CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID)
  ) {
    return { action: 'dismiss', tipId: value.tipId };
  }
  return null;
}

export function retainPermanentOnboardingDismissals(
  current: OnboardingTipDismissals,
): OnboardingTipDismissals {
  const dismissedAt = current[CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID];
  return dismissedAt === undefined
    ? {}
    : { [CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID]: dismissedAt };
}

/**
 * Applies an update to stored dismissals. A tip dismissed twice keeps its
 * first time, so the record says when the user first set it aside.
 */
export function applyOnboardingTipsUpdate(
  current: OnboardingTipDismissals,
  update: OnboardingTipsUpdate,
  now: Date,
): OnboardingTipDismissals {
  if (update.action === 'reset')
    return retainPermanentOnboardingDismissals(current);
  if (current[update.tipId] !== undefined) return current;
  return { ...current, [update.tipId]: now.toISOString() };
}

/**
 * The shared client operations (CAN-4904). A host that cannot keep the
 * dismissals leaves `CanopyCapabilities.onboardingTips` unset and rejects
 * both; shared UI then shows no tips.
 */
export interface OnboardingTipsQueryMap {
  'onboardingTips.get': {
    args: Record<string, never>;
    result: OnboardingTipsState;
  };
}

export interface OnboardingTipsCommandMap {
  'onboardingTips.update': {
    args: OnboardingTipsUpdate;
    result: OnboardingTipsState;
  };
}
