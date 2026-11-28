import {
  DEFAULT_LOCAL_MEMORY_FALLBACK_MODEL,
  DEFAULT_LOCAL_MEMORY_MODEL,
  type PreferencesData,
} from '@canopy/protocol/preferences';
import type { ChatModel } from '@canopy/protocol/chat-models';
import { isThinkingLevel, type ThinkingLevel } from '@canopy/protocol/thinking';
import type { PreferencesLoadError as PreferencesLoadErrorDetails } from '../codec';
import {
  createDefaultSidebarNavLayout,
  isLegacyDefaultSidebarNavLayout,
} from '@canopy/protocol/sidebar';
import type {
  PreferencesUpdater,
  StoredPreferencesPayloadRead,
} from '../repository';
import { normalizePersistableModelSelection } from './model-normalizers';
import { preferencesNormalizationEnvironment } from './normalization-environment';

export const APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY =
  'approval_defaults_full_access';

export const CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY =
  'claude_worker_modes_canopy';

export const SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY =
  'sidebar_remote_control_visible';

export const SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY =
  'sidebar_more_pages_to_main';

export const CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY =
  'chat_summary_model_selection';

/**
 * The chat-description default when legacy profiles were written. A legacy
 * profile without the selection marker chose its model only if it differs
 * from this one.
 */
const LEGACY_DEFAULT_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Chat-summary defaults seeded by earlier releases. A legacy profile without a
 * marker that still holds one of these never chose its summary model.
 */
const SEEDED_SUMMARY_MODELS: ReadonlySet<string> = new Set([
  'haiku',
  LEGACY_DEFAULT_SUMMARY_MODEL,
]);

export const LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY = 'local_memory_default_on';

export const SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY =
  'sidebar_manual_sort_default';

export const OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY =
  'open_app_links_in_built_in_browser_default';

export const LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY =
  'local_memory_model_from_summary';

export interface ChatSummaryModelSelectionMigrationSnapshot {
  hasPersistedPreferences: boolean;
  marker?: boolean;
  model?: unknown;
  readError?: boolean;
  source?: 'primary' | 'last-good';
}

export interface LocalMemoryModelMigrationSnapshot {
  hasPersistedPreferences: boolean;
  readError?: boolean;
  source?: 'primary' | 'last-good';
  /**
   * The stored explicit-choice marker. Normalized writes from earlier startup
   * migrations materialize the local memory fields with this set to false, so
   * only `true` is a choice this migration must keep.
   */
  localMemoryModelSetByUser?: unknown;
  summaryModel?: unknown;
  summaryModelSetByUser?: unknown;
  summaryThinkingLevel?: unknown;
}

export interface PreferenceMigrationSnapshots {
  chatSummaryModelSelection: ChatSummaryModelSelectionMigrationSnapshot;
  localMemoryModel: LocalMemoryModelMigrationSnapshot;
}

export interface PreferenceMigrationLedger {
  hasRun(key: string): Promise<boolean>;
  markRun(key: string): Promise<void>;
}
export interface PreferenceMigrationStore {
  read(): Promise<PreferencesData>;
  update(
    updater: PreferencesUpdater<PreferencesData>,
  ): Promise<PreferencesData>;
  peekLoadError(): PreferencesLoadErrorDetails | null;
  hasPersistedState(): Promise<boolean>;
  readStoredPayload(): Promise<StoredPreferencesPayloadRead>;
}
export interface PreferenceFormatMigrations {
  captureChatSummaryModelSelectionMigrationSnapshot(): Promise<ChatSummaryModelSelectionMigrationSnapshot>;
  captureLocalMemoryModelMigrationSnapshot(): Promise<LocalMemoryModelMigrationSnapshot>;
  capturePreferenceMigrationSnapshots(): Promise<PreferenceMigrationSnapshots>;
  migrateChatSummaryModelSelection(
    snapshot?: ChatSummaryModelSelectionMigrationSnapshot,
  ): Promise<void>;
  migrateApprovalDefaultsToFullAccess(
    hadPersistedPreferencesAtStartup?: boolean,
  ): Promise<void>;
  migrateClaudeWorkerModesToCanopy(): Promise<void>;
  migrateSidebarRemoteControlVisible(): Promise<void>;
  migrateSidebarMorePagesToMain(): Promise<void>;
  migrateLocalMemoryDefaultOn(): Promise<void>;
  migrateSidebarManualSortDefault(): Promise<void>;
  migrateOpenAppLinksInBuiltInBrowserDefault(): Promise<void>;
  migrateLocalMemoryModelFromSummary(
    snapshot?: LocalMemoryModelMigrationSnapshot,
  ): Promise<void>;
}

export function createPreferenceFormatMigrations(ports: {
  ledger: PreferenceMigrationLedger;
  store: PreferenceMigrationStore;
}): PreferenceFormatMigrations {
  const { ledger, store } = ports;
  function chatSummaryModelSelectionSnapshot(
    read: StoredPreferencesPayloadRead,
  ): ChatSummaryModelSelectionMigrationSnapshot {
    if (read.kind === 'missing') return { hasPersistedPreferences: false };
    if (read.kind === 'unreadable') {
      return { hasPersistedPreferences: true, readError: true };
    }
    return {
      hasPersistedPreferences: true,
      source: read.source,
      marker:
        typeof read.payload.summaryModelSetByUser === 'boolean'
          ? read.payload.summaryModelSetByUser
          : undefined,
      model: read.payload.summaryModel,
    };
  }

  /** Capture legacy fields before any earlier startup migration normalizes them. */
  async function captureChatSummaryModelSelectionMigrationSnapshot(): Promise<ChatSummaryModelSelectionMigrationSnapshot> {
    return chatSummaryModelSelectionSnapshot(await store.readStoredPayload());
  }

  /**
   * Materialize whether a legacy chat-summary model was user-selected before
   * every subsequent preference write serializes the full normalized object.
   */
  async function migrateChatSummaryModelSelection(
    capturedSnapshot?: ChatSummaryModelSelectionMigrationSnapshot,
  ): Promise<void> {
    if (await ledger.hasRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY)) {
      return;
    }

    const snapshot =
      capturedSnapshot ??
      (await captureChatSummaryModelSelectionMigrationSnapshot());
    if (!snapshot.hasPersistedPreferences) {
      await ledger.markRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY);
      return;
    }
    if (snapshot.readError) {
      return;
    }
    await store.read();
    if (store.peekLoadError() && snapshot.source !== 'last-good') {
      return;
    }
    const normalizedPersistedModel = normalizePersistableModelSelection(
      snapshot.model,
    );

    await store.update(() => ({
      ...(normalizedPersistedModel === null
        ? {}
        : { summaryModel: normalizedPersistedModel }),
      summaryModelSetByUser:
        normalizedPersistedModel === null
          ? false
          : (snapshot.marker ??
            !SEEDED_SUMMARY_MODELS.has(normalizedPersistedModel)),
    }));
    await ledger.markRun(CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY);
  }

  /**
   * Restore Full Access for profiles that persisted an explicit Ask/Auto value
   * during an intermediate release. Full Access is now the product default, so
   * fresh installs already start there and are marked as not applicable
   * immediately; this migration only exists so an upgrading profile is not left
   * behind on a stricter persisted posture.
   */
  async function migrateApprovalDefaultsToFullAccess(
    hadPersistedPreferencesAtStartup?: boolean,
  ): Promise<void> {
    if (await ledger.hasRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY)) {
      return;
    }

    const hadPersistedPreferences =
      hadPersistedPreferencesAtStartup ?? (await store.hasPersistedState());
    if (!hadPersistedPreferences) {
      await ledger.markRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY);
      return;
    }

    await store.read();
    if (store.peekLoadError()) {
      return;
    }

    // Deliberately replace all persisted surface selections. Before approval
    // defaults shipped, every existing profile behaved as unrestricted; this
    // one-time compatibility migration preserves that posture even when an
    // intermediate release already serialized newly introduced Ask/Auto values.
    //
    // Re-arm the one-time disclosure notice whenever that replacement actually
    // changes something. This migration overwrites a posture the user may have
    // chosen deliberately, and a profile old enough to still need it has almost
    // certainly dismissed the earlier notice already — so without the re-arm the
    // escalation would ship with no disclosure at all. When the posture was
    // already Full Access there is nothing to disclose or write, so the user's
    // dismissal and the file are left alone.
    await store.update((latest) =>
      latest.approvalDefaults.worktree === 'full-access' &&
      latest.approvalDefaults.cowork === 'full-access' &&
      latest.approvalDefaults.appAdvisor === 'full-access'
        ? null
        : {
            approvalDefaults: {
              worktree: 'full-access',
              cowork: 'full-access',
              appAdvisor: 'full-access',
            },
            approvalsUpgradeNoticeDismissed: false,
          },
    );
    await ledger.markRun(APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY);
  }

  async function migrateClaudeWorkerModesToCanopy(): Promise<void> {
    if (await ledger.hasRun(CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY)) {
      return;
    }

    const preferences = await store.read();
    if (
      preferences.canopyBackgroundProcessesMode !== 'terminal' &&
      preferences.pipelinesMode !== 'terminal'
    ) {
      return;
    }

    await store.update(() => ({
      ...(preferences.canopyBackgroundProcessesMode === 'terminal'
        ? { canopyBackgroundProcessesMode: 'canopy' as const }
        : {}),
      ...(preferences.pipelinesMode === 'terminal'
        ? { pipelinesMode: 'canopy' as const }
        : {}),
    }));
    await ledger.markRun(CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY);
  }

  async function migrateSidebarRemoteControlVisible(): Promise<void> {
    if (await ledger.hasRun(SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY)) {
      return;
    }

    const preferences = await store.read();

    // A degraded read (unreadable/corrupt/wrong-version file, with or without a
    // successful recovery) hands back defaults rather than what the user
    // actually had stored. Marking the migration done here would burn the one
    // shot we get: their real legacy layout would never be inspected, even after
    // the file is repaired on a later launch. Bail and retry next startup.
    if (store.peekLoadError()) {
      return;
    }

    if (isLegacyDefaultSidebarNavLayout(preferences.sidebarNavLayout)) {
      await store.update(() => ({
        sidebarNavLayout: createDefaultSidebarNavLayout(),
      }));
    }

    await ledger.markRun(SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY);
  }

  /**
   * CAN-3678 empties the sidebar's More menu: every More key except Environments
   * moves to the end of main nav, keeping its relative order, so the previous
   * default layout becomes exactly the current one. The five Labs page keys then
   * render only while their experiment is on. CAN-4269 removes Environments
   * during reconciliation, so current layouts have no retained More keys.
   * Must run after
   * {@link migrateSidebarRemoteControlVisible}, which first upgrades a legacy
   * default layout to the current default.
   */
  async function migrateSidebarMorePagesToMain(): Promise<void> {
    if (await ledger.hasRun(SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY)) {
      return;
    }

    const preferences = await store.read();

    // A degraded read hands back the default layout instead of the stored one;
    // marking the migration done on it would burn the one shot. Bail and retry
    // next startup (same contract as migrateSidebarRemoteControlVisible).
    if (store.peekLoadError()) {
      return;
    }

    // The store reconciles the layout on read, so `moreStartIndex` is in range.
    const { order, moreStartIndex } = preferences.sidebarNavLayout;
    const main = order.slice(0, moreStartIndex);
    const more = order.slice(moreStartIndex);
    const keepsEnvironments = more.includes('environments');
    const moved = more.filter((key) => key !== 'environments');
    if (moved.length > 0) {
      const nextOrder = [
        ...main,
        ...moved,
        ...(keepsEnvironments ? ['environments'] : []),
      ];
      await store.update(() => ({
        sidebarNavLayout: {
          order: nextOrder,
          moreStartIndex: nextOrder.length - (keepsEnvironments ? 1 : 0),
        },
      }));
    }

    await ledger.markRun(SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY);
  }

  // CAN-2657 product decision (Nick, 2026-09-01): local memory turns ON for
  // everyone at upgrade. Preferences serialize as a full object, so opt-in-era
  // profiles carry a materialized `localMemoryEnabled: false`; this one-shot
  // lift applies to every persisted `false` — deliberate opt-in-era opt-outs
  // included — because the two are indistinguishable on disk and the accepted
  // remedy is the visible Experiments toggle. The explicit-choice marker
  // (`localMemoryEnabledSetByUser`, written from this release on) is honored so
  // an opt-out made after the decision is never overridden, and the migration
  // never re-runs.
  async function migrateLocalMemoryDefaultOn(): Promise<void> {
    if (await ledger.hasRun(LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY)) {
      return;
    }

    const preferences = await store.read();

    // A degraded read hands back defaults rather than the stored value; marking
    // the migration done on it would burn the one shot. Bail and retry next
    // startup (same contract as migrateSidebarRemoteControlVisible).
    if (store.peekLoadError()) {
      return;
    }

    if (
      preferences.localMemoryEnabled === false &&
      preferences.localMemoryEnabledSetByUser !== true
    ) {
      await store.update(() => ({ localMemoryEnabled: true }));
    }

    await ledger.markRun(LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY);
  }

  // Product decision (2026-09-25): the left nav defaults to manual order at
  // every level, so rows stop jumping as activity lands. Preferences serialize
  // as a full object, so recency-default-era profiles carry a materialized
  // `sidebarProjectSortMode: 'last-updated'` whether or not the user picked it;
  // this one-shot moves every such value to manual, because the two are
  // indistinguishable on disk and the Sort by menu restores recency in one
  // click. It never re-runs, so a later choice of Last updated persists.
  // Workspace-level `itemSortMode` needs no migration: that field was only ever
  // written for an explicit manual choice, and a missing value now reads as
  // manual.
  async function migrateSidebarManualSortDefault(): Promise<void> {
    if (await ledger.hasRun(SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY)) {
      return;
    }

    const preferences = await store.read();

    // A degraded read hands back defaults rather than the stored value; marking
    // the migration done on it would burn the one shot. Bail and retry next
    // startup (same contract as migrateSidebarRemoteControlVisible).
    if (store.peekLoadError()) {
      return;
    }

    if (preferences.sidebarProjectSortMode === 'last-updated') {
      await store.update(() => ({ sidebarProjectSortMode: 'manual' }));
    }

    await ledger.markRun(SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY);
  }

  // Product decision (2026-10-21): links clicked in the app open in the
  // built-in browser by default. Preferences serialize as a full object, so
  // every earlier profile carries a materialized
  // `openAppLinksInBuiltInBrowser: false` whether or not the user chose it; this
  // one-shot turns all of them on, because the two are indistinguishable on
  // disk and Settings → Browser turns it off in one click. It never re-runs, so
  // a later choice of off persists.
  async function migrateOpenAppLinksInBuiltInBrowserDefault(): Promise<void> {
    if (
      await ledger.hasRun(
        OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
      )
    ) {
      return;
    }

    const preferences = await store.read();

    // A degraded read hands back defaults rather than the stored value; marking
    // the migration done on it would burn the one shot. Bail and retry next
    // startup (same contract as migrateSidebarRemoteControlVisible).
    if (store.peekLoadError()) {
      return;
    }

    if (preferences.openAppLinksInBuiltInBrowser === false) {
      await store.update(() => ({ openAppLinksInBuiltInBrowser: true }));
    }

    await ledger.markRun(
      OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
    );
  }

  function localMemoryModelSnapshot(
    read: StoredPreferencesPayloadRead,
  ): LocalMemoryModelMigrationSnapshot {
    if (read.kind === 'missing') return { hasPersistedPreferences: false };
    if (read.kind === 'unreadable') {
      return { hasPersistedPreferences: true, readError: true };
    }
    return {
      hasPersistedPreferences: true,
      source: read.source,
      localMemoryModelSetByUser: read.payload.localMemoryModelSetByUser,
      summaryModel: read.payload.summaryModel,
      summaryModelSetByUser: read.payload.summaryModelSetByUser,
      summaryThinkingLevel: read.payload.summaryThinkingLevel,
    };
  }

  /**
   * Capture the old memory model before any startup write materializes the new
   * local memory fields with their defaults.
   */
  async function captureLocalMemoryModelMigrationSnapshot(): Promise<LocalMemoryModelMigrationSnapshot> {
    return localMemoryModelSnapshot(await store.readStoredPayload());
  }

  /**
   * Every startup snapshot from one read of the stored preferences, taken before
   * any startup service or migration writes the normalized object.
   */
  async function capturePreferenceMigrationSnapshots(): Promise<PreferenceMigrationSnapshots> {
    const read = await store.readStoredPayload();
    return {
      chatSummaryModelSelection: chatSummaryModelSelectionSnapshot(read),
      localMemoryModel: localMemoryModelSnapshot(read),
    };
  }

  // CAN-3529: local memory used to run on the chat summary model. The
  // migration never moves saved memory to a provider the user did not choose:
  // - An Ollama summary model keeps memory on that exact local model, so a
  //   memory run refuses rather than send saved memory to another provider
  //   while it is unavailable.
  // - A remote summary model the user chose keeps memory on that provider, on
  //   its strong default: GPT 6.1 Sol for Codex, the Opus default for Claude,
  //   both at high thinking. A model from any other provider is kept as is.
  // - A summary model the user never chose gets the provider-aware default.
  // Whether a legacy model was chosen follows the chat summary migration: the
  // stored marker, or, without one, any model other than the old default.
  async function migrateLocalMemoryModelFromSummary(
    capturedSnapshot?: LocalMemoryModelMigrationSnapshot,
  ): Promise<void> {
    if (await ledger.hasRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY)) {
      return;
    }

    const snapshot =
      capturedSnapshot ?? (await captureLocalMemoryModelMigrationSnapshot());
    if (!snapshot.hasPersistedPreferences) {
      await ledger.markRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY);
      return;
    }
    if (snapshot.readError) {
      return;
    }
    // A degraded read hands back defaults; writing over them would burn the one
    // shot (same contract as migrateChatSummaryModelSelection).
    await store.read();
    if (store.peekLoadError() && snapshot.source !== 'last-good') {
      return;
    }

    // Completion is decided by the migration ledger alone. The local memory
    // fields can already be on disk with their defaults when an earlier
    // startup stopped after another migration wrote the normalized object, so
    // only an explicit choice (made in Settings, or written by this migration
    // before it could record completion) is kept.
    const choice =
      snapshot.localMemoryModelSetByUser === true
        ? null
        : localMemoryModelFromSummary(snapshot);
    if (choice !== null) {
      await store.update(() => ({
        localMemoryModel: choice.model,
        localMemoryModelSetByUser: true,
        ...(choice.thinkingLevel === undefined
          ? {}
          : { localMemoryThinkingLevel: choice.thinkingLevel }),
      }));
    }
    await ledger.markRun(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY);
  }

  /**
   * The local memory model a legacy profile keeps, or null when it takes the
   * provider-aware default (see {@link migrateLocalMemoryModelFromSummary}).
   */
  function localMemoryModelFromSummary(
    snapshot: LocalMemoryModelMigrationSnapshot,
  ): { model: ChatModel; thinkingLevel?: ThinkingLevel } | null {
    const summaryModel = normalizePersistableModelSelection(
      snapshot.summaryModel,
    );
    if (summaryModel === null) return null;
    const summaryThinkingLevel = isThinkingLevel(snapshot.summaryThinkingLevel)
      ? snapshot.summaryThinkingLevel
      : undefined;
    const facts = preferencesNormalizationEnvironment();
    if (facts.isOllamaModel(summaryModel)) {
      return { model: summaryModel, thinkingLevel: summaryThinkingLevel };
    }
    const chosen =
      typeof snapshot.summaryModelSetByUser === 'boolean'
        ? snapshot.summaryModelSetByUser
        : !SEEDED_SUMMARY_MODELS.has(summaryModel);
    if (!chosen) return null;
    switch (facts.provider(summaryModel)) {
      case 'codex':
        return { model: DEFAULT_LOCAL_MEMORY_MODEL, thinkingLevel: 'high' };
      case 'claude':
        return {
          model: DEFAULT_LOCAL_MEMORY_FALLBACK_MODEL,
          thinkingLevel: 'high',
        };
      default:
        return { model: summaryModel, thinkingLevel: summaryThinkingLevel };
    }
  }
  return {
    captureChatSummaryModelSelectionMigrationSnapshot,
    migrateChatSummaryModelSelection,
    migrateApprovalDefaultsToFullAccess,
    migrateClaudeWorkerModesToCanopy,
    migrateSidebarRemoteControlVisible,
    migrateSidebarMorePagesToMain,
    migrateLocalMemoryDefaultOn,
    migrateSidebarManualSortDefault,
    migrateOpenAppLinksInBuiltInBrowserDefault,
    captureLocalMemoryModelMigrationSnapshot,
    capturePreferenceMigrationSnapshots,
    migrateLocalMemoryModelFromSummary,
  };
}
