/** Compatibility path: this module lives in `@canopy/core-runtime/node/preferences/domain`. */
export {
  APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY,
  CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY,
  SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY,
  SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY,
  CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY,
  LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY,
  SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY,
  OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
  LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY,
  type ChatSummaryModelSelectionMigrationSnapshot,
  type LocalMemoryModelMigrationSnapshot,
  type PreferenceMigrationSnapshots,
  type PreferenceMigrationLedger,
  type PreferenceMigrationStore,
  type PreferenceFormatMigrations,
  createPreferenceFormatMigrations,
} from '@canopy/core-runtime/node/preferences/domain';
