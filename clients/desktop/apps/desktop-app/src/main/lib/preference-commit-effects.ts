import type { StoredDomainPreferences } from '@canopy/core-runtime/node/preferences';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { markGlobalApprovalRulesChanged } from '../approvals/rule-revisions';
import { applyOneWindowChoice } from './one-window-switch';
import type { PreferenceNativeEffects } from './preference-native-effects';
import { broadcastPreferencesChanged } from './preferences-broadcast';
import { publishCommittedPreferences } from './preferences-committed';
import { commitSuggestionsGate } from './suggestions-gate';
import {
  getUsageDataPolicy,
  usageDataConsentStateOf,
} from './usage-data-policy';

/**
 * The one consumer of committed domain preferences (CAN-5722, slice F): every
 * committed revision applies its effects here once, whether this process saved
 * it (`own`) or another client did (`foreign`: the CLI or an agent, through
 * the daemon). Effects that an own save gates on "key in patch" keep that
 * rule; a foreign commit gates them on the keys whose value changed.
 *
 * Client-local effects (the UI scale zoom, the native theme) are not here:
 * they follow the composite's client-local commits only, never a domain or
 * daemon commit. The pre-commit steps (Copilot "changing", save tracking, the
 * in-memory usage-data deny, the crash suspend) stay with the client.
 */
type PreferenceCommitGate =
  | { readonly origin: 'own'; readonly patchKeys: ReadonlySet<string> }
  | { readonly origin: 'foreign'; readonly changedKeys: ReadonlySet<string> };

type DomainValues = Readonly<StoredDomainPreferences>;

export interface DomainPreferenceChange {
  readonly previous: DomainValues;
  readonly next: DomainValues;
}

/** What a daemon committed event carries. */
export interface ForeignPreferenceCommit extends DomainPreferenceChange {
  /** The document revision; each one applies once. */
  readonly revision: number;
  readonly changedKeys: ReadonlySet<string>;
}

export type PreferenceHostEffectInput = {
  readonly next: Pick<
    PreferencesData,
    | 'keepSystemAwakeWhileAgentsActive'
    | 'closeToTray'
    | 'globalFocusShortcutEnabled'
    | 'globalFocusShortcut'
    | 'useAsSystemDefaultBrowser'
  >;
} & PreferenceCommitGate;

/** A commit's host effects over its merged values. */
export type PreferenceCommitEffectInput = {
  readonly next: PreferencesData;
} & PreferenceCommitGate;

/** A commit with the merged values it replaced, for effects that compare them. */
export type PreferenceCommitChange = PreferenceCommitEffectInput & {
  readonly previous: PreferencesData;
};

export type ForeignPreferenceCommitChange = Extract<
  PreferenceCommitChange,
  { readonly origin: 'foreign' }
>;

/** This computer's half of the commit effects. */
export interface PreferenceCommitHost {
  readonly native: PreferenceNativeEffects;
  /**
   * Writes `restored` through the preference port only while the stored chord
   * is still `refused`, so a newer choice is never overwritten. Resolves true
   * when it wrote.
   */
  correctFocusShortcut(refused: string, restored: string): Promise<boolean>;
  /** In commit order: what an own save's commit callback applies. */
  applyCommitOrdered(commit: ForeignPreferenceCommitChange): void;
  /** After the domain stages: what an own save applies after its commit, the window broadcast included. */
  applyCommitEffects(commit: ForeignPreferenceCommitChange): Promise<void>;
}

const NOTIFICATION_INPUT_KEYS = [
  'osNotifications',
  'activationQuietHours',
  'promotionalNotifications',
] as const;
const FOCUS_SHORTCUT_KEYS = [
  'globalFocusShortcutEnabled',
  'globalFocusShortcut',
] as const;

/** Whether the commit names any of `keys`: in its patch (own) or among its changed keys (foreign). */
export function commitTouches(
  gate: PreferenceCommitGate,
  keys: readonly (keyof PreferencesData)[],
): boolean {
  const named = gate.origin === 'own' ? gate.patchKeys : gate.changedKeys;
  return keys.some((key) => named.has(key));
}

/**
 * Whether the commit changed `key`: by value for an own save, as its effects
 * always compared, or among a foreign commit's changed keys.
 */
export function commitChanged<Key extends keyof PreferencesData>(
  commit: PreferenceCommitChange,
  key: Key,
  same: (
    previous: PreferencesData[Key],
    next: PreferencesData[Key],
  ) => boolean = (previous, next) => previous === next,
): boolean {
  if (commit.origin === 'foreign') return commit.changedKeys.has(key);
  return !same(commit.previous[key], commit.next[key]);
}

/** Every own save re-applies keep-awake and close-to-tray, as it always has. */
function reapplies(
  gate: PreferenceCommitGate,
  key: keyof PreferencesData,
): boolean {
  return gate.origin === 'own' || gate.changedKeys.has(key);
}

let registeredHost: PreferenceCommitHost | null = null;
let committedSequence = 0;
let lastAppliedRevision = Number.NEGATIVE_INFINITY;

/** The host foreign commits apply through; registered with the preference handlers. */
export function registerPreferenceCommitHost(host: PreferenceCommitHost): void {
  registeredHost = host;
}

/**
 * Claims a revision for its one application: false when it, or a later one,
 * already applied.
 */
export function claimPreferenceRevision(revision: number): boolean {
  if (revision <= lastAppliedRevision) return false;
  lastAppliedRevision = revision;
  return true;
}

/**
 * Counts commits applied in commit order, so a save can tell whether its own
 * commit already reached the consumer.
 */
export function committedPreferencesSequence(): number {
  return committedSequence;
}

/** In the commit queue, before the commit settles. */
export async function settleDomainPreferenceCommit({
  previous,
  next,
}: DomainPreferenceChange): Promise<void> {
  if (
    previous.googleSubscriptionDisconnected !==
    next.googleSubscriptionDisconnected
  ) {
    // All admitted writers invalidate in serialized commit order. A late
    // discovery or sign-in cannot restore a disconnected model catalog.
    const { retireAntigravityConnection } =
      await import('../antigravity/connection-generation');
    // The generation changes before this commit settles. A disconnect
    // notifies running delegates synchronously; they stop themselves.
    retireAntigravityConnection(next.googleSubscriptionDisconnected === true);
    const { invalidateAntigravityModels } =
      await import('../antigravity/models');
    invalidateAntigravityModels();
    const { broadcastModelRegistryUpdated } =
      await import('../models/model-registry');
    const { notifyModelCatalogChanged } =
      await import('../remote-projection/agent-catalog-compatibility');
    broadcastModelRegistryUpdated();
    // Catalog projection may read preferences. Do not await it while this
    // serialized preferences commit still owns the write queue.
    trackDetachedWork(() => notifyModelCatalogChanged());
  }
  if (
    JSON.stringify(previous.disabledInstalledItems ?? []) !==
      JSON.stringify(next.disabledInstalledItems ?? []) ||
    JSON.stringify(previous.parkedCodexPlugins ?? []) !==
      JSON.stringify(next.parkedCodexPlugins ?? [])
  ) {
    const { notifyInstalledItemsChanged } =
      await import('../installed-items/installed-item-events');
    notifyInstalledItemsChanged();
  }
}

/**
 * Synchronous, in commit order, before any caller hears of the commit.
 * `merged` is `next` with this client's client-local values.
 */
export function applyCommittedDomainPreferences(
  next: DomainValues,
  merged: Readonly<PreferencesData>,
  unconfirmed: boolean,
): void {
  committedSequence += 1;
  commitSuggestionsGate(next);
  publishCommittedPreferences(merged);
  // Every durable commit, whichever writer made it, carries the stored
  // one-window choice, so main's read follows the file even when an
  // earlier save's own callback never ran.
  applyOneWindowChoice(next.oneWindowEnabled, unconfirmed);
  // Consent and choices from the same committed object, in one recompute.
  getUsageDataPolicy().setStored(next.usageData, usageDataConsentStateOf(next));
}

/** Recovery failed and latched until restart. */
export function applyPreferencesRecoveryLatched(): void {
  markGlobalApprovalRulesChanged();
  // The one-window switch reads off while unconfirmed; a switch that was
  // on turns off now, and windows re-read it.
  applyOneWindowChoice(undefined, true);
  broadcastPreferencesChanged();
}

/** Recovery restored last-good over the primary. */
export function applyPreferencesRecovered(
  restored: DomainValues,
  unconfirmed: boolean,
): void {
  markGlobalApprovalRulesChanged();
  applyOneWindowChoice(restored.oneWindowEnabled, unconfirmed);
}

/** Keep-awake, close-to-tray and the activation schedule: synchronous. */
export function applyImmediateHostEffects(
  input: PreferenceHostEffectInput,
  native: PreferenceNativeEffects,
): void {
  if (reapplies(input, 'keepSystemAwakeWhileAgentsActive'))
    native.keepAwake.setEnabled(input.next.keepSystemAwakeWhileAgentsActive);
  if (reapplies(input, 'closeToTray'))
    native.backgroundPresence.applyCloseToTray(input.next.closeToTray);
  // Notification preferences are an event-driven suppression input: the
  // scheduler no longer polls for `notifications-disabled`/`category-disabled`,
  // so enabling them has to re-arm it here.
  //
  // Gated on the three keys the scheduler actually reads. Unconditional would be
  // worse than the poll it replaced: ~101 renderer save sites include
  // drag/resize-frequency ones, and each evaluation costs an uncached
  // preferences read plus, per due campaign, a checklist derivation that does
  // its own filesystem reads.
  if (commitTouches(input, NOTIFICATION_INPUT_KEYS))
    native.activationSchedule.notificationInputsChanged();
}

/**
 * Re-syncs the OS registration after a commit. A commit is persisted before it
 * applies, so it cannot be try-then-save on its own: when the committed chord
 * is refused, the service has already restored the previous working
 * registration, and the file must follow it, or the next launch would come up
 * blocked on a chord that never worked. The dedicated
 * `global-focus-shortcut:update` IPC is the intended writer.
 */
async function syncFocusShortcut(
  next: PreferenceHostEffectInput['next'],
  host: PreferenceCommitHost,
): Promise<void> {
  const service = host.native.focusShortcut();
  if (service === null) return;
  const config = {
    enabled: next.globalFocusShortcutEnabled,
    accelerator: next.globalFocusShortcut,
  };
  if (service.apply(config).ok) return;
  const restored = service.getActiveAccelerator();
  if (restored === null || restored === config.accelerator) return;
  if (!(await host.correctFocusShortcut(config.accelerator, restored))) return;
  // Report against the value that is actually on disk now.
  service.apply({ enabled: config.enabled, accelerator: restored });
}

/**
 * The focus shortcut, then the default browser. An own save that already
 * requested its registration inside the commit passes that request.
 */
export async function applySettledHostEffects(
  input: PreferenceHostEffectInput,
  host: PreferenceCommitHost,
  defaultBrowserRegistration?: Promise<unknown>,
): Promise<void> {
  if (commitTouches(input, FOCUS_SHORTCUT_KEYS)) {
    // A committed save must not look failed because the corrective write did.
    try {
      await syncFocusShortcut(input.next, host);
    } catch {
      // The registration state is still broadcast on the next status push.
    }
  }
  if (commitTouches(input, ['useAsSystemDefaultBrowser'])) {
    // Registration is reconciled after persistence. OS refusal must not make
    // the committed preference save look failed; verified status is exposed
    // separately for Settings to render recovery guidance.
    try {
      await (defaultBrowserRegistration ??
        host.native.defaultBrowser.requestRegistration(
          input.next.useAsSystemDefaultBrowser === true,
        ));
    } catch {
      // Keep the saved preference and surface the service's status instead.
    }
  }
}

/*
 * A foreign commit's host stages. Before the preference handlers register
 * there is no host; E2 subscribes to daemon events after they do.
 */

/** In the write queue, after the commit-order stage. */
export function applyForeignCommitOrdered(
  commit: ForeignPreferenceCommitChange,
): void {
  registeredHost?.applyCommitOrdered(commit);
}

/** After the write queue: the corrective focus-shortcut write waits on it. */
export async function applyForeignHostEffects(
  commit: ForeignPreferenceCommitChange,
): Promise<void> {
  await registeredHost?.applyCommitEffects(commit);
}
