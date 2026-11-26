export type {
  PreferencesDocument,
  PreferencesDocumentSlot,
  PreferencesLog,
} from './document';
export type {
  PreferencesCodec,
  PreferencesReadView,
  PreferencesLoadError,
  PreferencesLoadErrorReason,
  PreferencesMergeContext,
} from './codec';
export type {
  StoredPreferencesPayloadRead,
  PreferencesChange,
  PreferencesUpdater,
  PreferencesAuthorityRead,
  PreferencesGenerationStamp,
  PreferencesRepositoryHooks,
  PreferencesRepositoryOptions,
  PreferencesRepository,
} from './repository';
export { createPreferencesRepository } from './repository';
export {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type ClientLocalPreferenceKey,
} from './client-local-keys';
export {
  preserveStoredKeys,
  type WithStoredKeys,
} from './preserve-stored-keys';
export {
  storedClientLocalValues,
  type DomainPreferencesData,
  type StoredDomainPreferences,
} from './domain-preferences';
export {
  PREFERENCES_BACKUPS_FOLDER,
  PREFERENCES_FAMILY_FILES,
  PREFERENCES_NAMESPACE_ID,
  PREFERENCES_OWNER_RECORDS_FOLDER,
} from './family';
export type {
  PreferencesBackupOptions,
  PreferencesNewerLoss,
  PreferencesRestoreOptions,
  PreferencesRestoreResult,
} from './preferences-backup';
export {
  PREFERENCES_ROLLBACK_MIGRATION,
  backupPreferences,
  restorePreferencesBackup,
} from './preferences-backup';
