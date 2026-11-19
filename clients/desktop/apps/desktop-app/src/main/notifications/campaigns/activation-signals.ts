import type { ActivationCampaignId } from '@canopy/desktop-shared/types';
import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from '../../lib/chat-history-scan';
import { hasInstalledCapability } from './installed-capability';
import { migrateLegacyChecklistSignals } from './legacy-checklist-migration';
import {
  latchActivationSignal,
  readActivationJourneyState,
} from './journey-state';

/**
 * Test-only: clears the memoized backfill scan. Production never resets it —
 * scanning once per process is the point.
 */
export function resetActivationSignalsForTests(): void {
  resetChatHistoryScanForTests();
}

export function latchFirstTaskSubmitted(now: string): Promise<void> {
  return latchActivationSignal('first-task-submitted', now).then(
    () => undefined,
    () => undefined,
  );
}

export function latchMobilePaired(now: string): Promise<void> {
  return latchActivationSignal('mobile-paired', now).then(
    () => undefined,
    () => undefined,
  );
}

export async function hasSubmittedFirstTask(): Promise<boolean> {
  const state = await readActivationJourneyState();
  if (state.signals['first-task-submitted'] !== undefined) return true;
  return hasEverSentChatMessage();
}

/**
 * Mobile pairing has no backfill: nothing recorded pairing before this signal
 * existed, and a connected mobile Remote Control controller is the only
 * observation available.
 */
export async function hasEverPairedMobile(): Promise<boolean> {
  const state = await readActivationJourneyState();
  return state.signals['mobile-paired'] !== undefined;
}

/** Known positive observations win even when another probe is unavailable. */
export async function hasMeaningfullyActivated(
  campaignId?: ActivationCampaignId,
): Promise<boolean> {
  if (await hasSubmittedFirstTask()) return true;
  let state = await readActivationJourneyState();
  if (
    state.signals['tool-connected'] !== undefined ||
    state.signals['capability-installed'] !== undefined
  )
    return true;
  // A current installation is independent of a failed historical read.
  let capabilityError: Error | undefined;
  try {
    if (await hasInstalledCapability()) {
      // A confirmed installation suppresses even if the latch cannot be saved.
      await latchActivationSignal(
        'capability-installed',
        new Date().toISOString(),
      ).catch(() => undefined);
      return true;
    }
  } catch (error) {
    capabilityError =
      error instanceof Error
        ? error
        : new Error('Installed capability probe failed.');
  }
  try {
    await migrateLegacyChecklistSignals();
  } catch (error) {
    // Mobile's own fact is pairing, not checklist history. Keep its independent
    // offer available when history is uncertain; known activation still wins.
    if (campaignId === 'activation-mobile') return false;
    throw error;
  }
  state = await readActivationJourneyState();
  if (
    state.signals['first-task-submitted'] !== undefined ||
    state.signals['tool-connected'] !== undefined ||
    state.signals['capability-installed'] !== undefined
  )
    return true;
  if (capabilityError !== undefined && campaignId !== 'activation-mobile')
    throw capabilityError;
  return false;
}

/** Independent first-task/mobile predicates do not depend on the capability probe. */
export async function isCampaignEligible(
  campaignId: ActivationCampaignId,
): Promise<boolean> {
  switch (campaignId) {
    case 'activation-marketplace': {
      await migrateLegacyChecklistSignals();
      const state = await readActivationJourneyState();
      if (state.signals['capability-installed'] !== undefined) return false;
      if (!(await hasInstalledCapability())) return true;
      await latchActivationSignal(
        'capability-installed',
        new Date().toISOString(),
      );
      return false;
    }
    case 'activation-first-task':
      return !(await hasSubmittedFirstTask());
    case 'activation-mobile':
      return !(await hasEverPairedMobile());
    // Campaign 2 has no state predicate of its own: "no activation action"
    // is already enforced by the global activation gate, and the role
    // mapping decides reachability through the variant resolver.
    case 'activation-role-branch':
      return true;
  }
}
