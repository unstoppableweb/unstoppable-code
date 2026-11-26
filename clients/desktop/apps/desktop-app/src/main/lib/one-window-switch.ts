import { resolveOneWindowEnabled } from '@canopy/desktop-shared/lib/one-window';
import { getCanopyReleaseFlavor } from './app-identity';
import { logMainProcessWarn } from './main-process-logging';

// Main's read of the one-window switch (CAN-7755), Settings → Labs → One
// window for all computers. The window reads the same switch through
// `oneWindowStore`. Startup applies the saved choice, and every durable
// preferences commit applies it again in commit order (the preferences
// store's commit hook, whichever writer committed, and the save's own commit
// callback), before the window hears of the save. It reads off until startup has read the saved choice,
// so nothing starts one-window work for a person who turned it off. It
// also reads off while preferences are unconfirmed (a failed recovery is
// latched until restart): those values aren't proven to be the person's
// choice, and the window store treats them the same way. The preferences
// store applies that as soon as the latch holds, so a switch that was on
// turns off and its listeners hear of it.
//
// The switch belongs to this computer. It isn't part of the hello, and
// receiving-side behavior is gated by hello capability flags instead, so
// two paired computers can differ.

let enabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isOneWindowEnabled(): boolean {
  return enabled;
}

/**
 * Applies the saved `oneWindowEnabled` choice; absent means the build
 * default. `unconfirmed` is `arePreferencesUnconfirmed()`, which reads off.
 */
export function applyOneWindowChoice(
  choice: boolean | undefined,
  unconfirmed: boolean,
): void {
  const next =
    !unconfirmed && resolveOneWindowEnabled(choice, getCanopyReleaseFlavor());
  if (next === enabled) return;
  enabled = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch (error) {
      logMainProcessWarn('[one-window] change listener failed', error);
    }
  }
}

/** Calls `listener` whenever the switch changes; returns an unsubscribe. */
export function onOneWindowEnabledChanged(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
