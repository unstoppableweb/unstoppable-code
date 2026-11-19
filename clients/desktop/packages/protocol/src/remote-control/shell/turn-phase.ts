export type ChatTurnPhase = 'idle' | 'background' | 'foreground';

/** Transient host-owned reason an explicit queued retry cannot send yet. */
export type QueuedMessageRetryBlockedReason = 'insufficient_credits';

/**
 * Why a queued message is waiting when the host can say. `steer_unavailable`:
 * a turn is running and it cannot take a new message right now.
 * `background_work`: sending it would restart the agent with changed settings
 * and stop background work that is still running, so it waits for that work.
 */
export type QueuedMessageWaitingReason =
  | 'steer_unavailable'
  | 'background_work';

/**
 * The kinds of setting a held send can wait to apply, in display order.
 * Names only; never the old or new values.
 */
export const SETTINGS_HELD_CHANGES = [
  'model',
  'thinking_level',
  'agent',
  'plan_mode',
  'plugins',
  'tools',
  'instructions',
  'approval_rules',
  'delegation',
  'codex_preferences',
  'account',
  'organization',
] as const;

/**
 * A kind of setting that differs from the one the chat's live agent runs
 * with, named so a host can say what a held send is waiting to apply.
 */
export type SettingsHeldChange = (typeof SETTINGS_HELD_CHANGES)[number];

/**
 * The known kinds among `names`, each once, in display order. Names a newer
 * host sends that this build does not know are dropped.
 */
export function orderedSettingsHeldChanges(
  names: Iterable<string>,
): SettingsHeldChange[] {
  const present = new Set(names);
  return SETTINGS_HELD_CHANGES.filter((change) => present.has(change));
}
