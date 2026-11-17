import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import {
  markGlobalApprovalRulesChanged,
  markPreferencesAuthorityConfirmed,
  markPreferencesAuthorityUnconfirmed,
  narrowsFileWriteRules,
  trackPreferencesAuthoritySave,
} from '../approvals/rule-revisions';
import { resolveAvailableModel } from './model-availability';
import { readFile, stat } from 'node:fs/promises';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { dirname } from 'node:path';
import {
  USAGE_DATA_KEYS,
  type UsageDataKey,
} from '@canopy/desktop-shared/types';
import {
  withUsageDataConsentJournal,
  recordUsageDataRevocations,
  type ConsentJournal,
} from './usage-data-consent-document';
import { getUsageDataPolicy } from './usage-data-policy';
import {
  type PreferencesData,
  type PreferencesLoadErrorDetails,
  type PreferencesLoadResult,
  type PreferencesProjectionOptions,
} from '@canopy/desktop-shared/types';
import { getPreferencesFilePath } from '../lib/paths';
import {
  createUsageDataDenialsPath,
  createPreferencesBackupPath,
  createPreferencesGenerationPath,
  createPreferencesLastGoodPath,
} from './preferences-file-paths';
import { getResolvedCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import { commitSuggestionsGate } from './suggestions-gate';
import { publishCommittedPreferences } from './preferences-committed';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { toShortcutPlatform } from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { isRecord } from './type-guards';
import { normalizePreferences } from '@canopy/desktop-shared/node/preferences/normalize-preferences';
import {
  createPreferencesRepository,
  type PreferencesDocument as PreferencesDocumentPort,
  type PreferencesDocumentSlot,
  type PreferencesAuthorityRead as RepositoryAuthorityRead,
  type PreferencesGenerationStamp,
  type PreferencesRepositoryHooks,
  type PreferencesChange,
  type StoredPreferencesPayloadRead,
} from '@canopy/core-runtime/node/preferences';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';

export { normalizePreferences } from '@canopy/desktop-shared/node/preferences/normalize-preferences';

export { normalizeChatTabPluginSelections } from '@canopy/desktop-shared/node/preferences/record-normalizers';

export {
  normalizeCodeGraphPreferences,
  normalizePersistableModelSelection,
} from '@canopy/desktop-shared/node/preferences/model-normalizers';

export { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';

installPreferencesNormalizationEnvironment({
  resolveAvailableModel: (model) => resolveAvailableModel(model),
  ollamaEnabled: () => __CANOPY_OLLAMA_ENABLED__,
  shortcutPlatform: () => toShortcutPlatform(hostOperatingSystem() ?? 'linux'),
});

function slotFilePath(filePath: string, slot: PreferencesDocumentSlot): string {
  switch (slot) {
    case 'primary':
      return filePath;
    case 'lastGood':
      return createPreferencesLastGoodPath(filePath);
    case 'generation':
      return createPreferencesGenerationPath(filePath);
  }
}
function createDesktopPreferencesDocument(): PreferencesDocumentPort {
  const filePath = getPreferencesFilePath();
  const document: PreferencesDocumentPort = {
    key: filePath,
    readText: (slot) => readFile(slotFilePath(filePath, slot), 'utf8'),
    exists: (slot) =>
      stat(slotFilePath(filePath, slot))
        .then(() => true)
        .catch((error: unknown) => {
          if (isMissingFileError(error)) return false;
          throw error;
        }),
    install: (slot, content) => {
      switch (slot) {
        case 'primary':
          return writeTextFileAtomically(filePath, content);
        case 'lastGood':
          return writeTextFileAtomically(
            createPreferencesLastGoodPath(filePath),
            content,
          );
        case 'generation':
          return writeTextFileAtomically(
            createPreferencesGenerationPath(filePath),
            content,
          );
      }
    },
    ensureFolder: () => createPreferencesFolderDurably(filePath),
    slotPath: (slot) => slotFilePath(filePath, slot),
    backupLocation: (stamp) => createPreferencesBackupPath(filePath, stamp),
    installBackup: (location, content) =>
      writeTextFileAtomically(location, content),
    pruneBackups: async (): Promise<void> => {
      await pruneDamagedCopies({
        directory: dirname(filePath),
        prefix: 'preferences.backup-',
        suffix: '.json',
        uniqueTail: true,
      });
    },
  };
  return withUsageDataConsentJournal(
    document,
    createUsageDataConsentJournal(filePath),
  );
}

function createUsageDataConsentJournal(filePath: string): ConsentJournal {
  const journalPath = createUsageDataDenialsPath(filePath);
  return {
    async read(): Promise<readonly UsageDataKey[]> {
      try {
        const value: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
        if (
          !Array.isArray(value) ||
          value.some((key) => !USAGE_DATA_KEYS.some((known) => known === key))
        )
          return USAGE_DATA_KEYS;
        return USAGE_DATA_KEYS.filter((key) => value.includes(key));
      } catch (error) {
        return isMissingFileError(error) ? [] : USAGE_DATA_KEYS;
      }
    },
    write: async (denied): Promise<void> => {
      await createPreferencesFolderDurably(filePath);
      await writeFileAtomically(journalPath, JSON.stringify(denied), {
        encoding: 'utf8',
        mode: 0o600,
        durable: true,
        admittedWriter: PREFERENCES_WRITER,
      });
    },
    deny: (denied): void => {
      const policy = getUsageDataPolicy();
      const preferences = policy.getUsageDataPolicySnapshot().preferences;
      for (const key of denied) preferences[key] = false;
      policy.setPreferences(preferences);
    },
  };
}

/** Preferences sit in the data root itself (`getPreferencesFilePath`). */
function createPreferencesFolderDurably(filePath: string): Promise<void> {
  const dataRoot = dirname(filePath);
  return createDirectoryDurably(dataRoot, { dataRoot });
}

type PreferencesUpdater = (
  latest: PreferencesData,
) => Partial<PreferencesData> | null | Promise<Partial<PreferencesData> | null>;
type PreferencesCommitObserver = (committed: PreferencesData) => void;

// Setup rollback owns a committed enablement value, not a runtime generation.
// Track only durable changes to this field so unrelated preference saves do
// not prevent rollback and a newer disable/re-enable cannot be overwritten.
let openCodeEnabledRevision = 0;
export function getOpenCodeEnabledRevision(): number {
  return openCodeEnabledRevision;
}

let preferencesRendererLoadOperation: Promise<PreferencesLoadResult> | null =
  null;
let rendererPreferencesCache: PreferencesData | null = null;
let rendererRuntimeProjection: {
  source: PreferencesData;
  result: PreferencesData;
} | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    getErrorCode(error) === 'ENOENT' || getErrorMessage(error) === 'ENOENT'
  );
}

function approvalChange({
  previous,
  next,
}: PreferencesChange<PreferencesData>): {
  globalRulesChanged: boolean;
  authorityChanged: boolean;
} {
  const globalRulesChanged =
    JSON.stringify(previous.globalApprovalRules) !==
    JSON.stringify(next.globalApprovalRules);
  return {
    globalRulesChanged,
    authorityChanged:
      globalRulesChanged ||
      JSON.stringify(previous.approvalDefaults) !==
        JSON.stringify(next.approvalDefaults),
  };
}
export type CopilotSelectionAuthorityChange =
  | { kind: 'changing'; selection: PreferencesData['copilotVaultSelection'] }
  | { kind: 'unavailable' };
const copilotSelectionObservers = new Set<
  (change: CopilotSelectionAuthorityChange) => void
>();
/** Synchronous invalidation only: observers must never await the credential or preferences queue. */
export function observeCopilotSelectionAuthority(
  observer: (change: CopilotSelectionAuthorityChange) => void,
): () => void {
  copilotSelectionObservers.add(observer);
  return () => {
    copilotSelectionObservers.delete(observer);
  };
}
function notifyCopilotSelectionAuthority(
  change: CopilotSelectionAuthorityChange,
): void {
  for (const observer of copilotSelectionObservers) observer(change);
}
const preferencesHooks: PreferencesRepositoryHooks<PreferencesData> = {
  beforeSave: async ({ previous, next }, document): Promise<void> => {
    if (
      copilotSelectionObservers.size > 0 &&
      JSON.stringify(previous.copilotVaultSelection) !==
        JSON.stringify(next.copilotVaultSelection)
    )
      notifyCopilotSelectionAuthority({
        kind: 'changing',
        selection: next.copilotVaultSelection,
      });
    await recordUsageDataRevocations(
      createUsageDataConsentJournal(document.key),
      next.usageData,
    );
  },
  trackSave: (save, change) =>
    approvalChange(change).authorityChanged
      ? trackPreferencesAuthoritySave(save, {
          narrowsFileWrites: narrowsFileWriteRules(
            change.previous.globalApprovalRules,
            change.next.globalApprovalRules,
          ),
        })
      : save,
  onSaveOutcomeUnknown: (change) => {
    notifyCopilotSelectionAuthority({ kind: 'unavailable' });
    if (approvalChange(change).authorityChanged)
      markPreferencesAuthorityUnconfirmed({
        globalApprovalRules: change.previous.globalApprovalRules,
        approvalDefaults: change.previous.approvalDefaults,
      });
    invalidateRendererPreferencesCache();
  },
  onSaveDurable: (change) => {
    if (approvalChange(change).globalRulesChanged)
      markGlobalApprovalRulesChanged();
    markPreferencesAuthorityConfirmed();
  },
  afterSave: async ({ previous, next }): Promise<void> => {
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
      const { notifyPortalModelCatalogChanged } =
        await import('../portal/portal-event-bus');
      broadcastModelRegistryUpdated();
      // Catalog projection may read preferences. Do not await it while this
      // serialized preferences commit still owns the write queue.
      trackDetachedWork(() => notifyPortalModelCatalogChanged());
    }
    if (previous.opencodeEnabled !== next.opencodeEnabled)
      openCodeEnabledRevision++;
    rendererPreferencesCache = next;
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
  },
  onCommitted: (next) => {
    commitSuggestionsGate(next);
    publishCommittedPreferences(next);
    getUsageDataPolicy().setPreferences(next.usageData);
  },
  onRecoveryLatched: () => {
    notifyCopilotSelectionAuthority({ kind: 'unavailable' });
    markGlobalApprovalRulesChanged();
    invalidateRendererPreferencesCache();
  },
  onRecovered: (restored) => {
    markGlobalApprovalRulesChanged();
    rendererPreferencesCache = restored;
  },
};
const preferencesRepository = createPreferencesRepository<PreferencesData>({
  document: () => createDesktopPreferencesDocument(),
  codec: DESKTOP_PREFERENCES_CODEC,
  hooks: preferencesHooks,
  log: {
    error: (message, error) => {
      // eslint-disable-next-line no-console
      console.error(message, error);
    },
  },
});

const PREFERENCES_WRITER: AdmittedWriterTarget = {
  namespace: 'preferences',
  writer: 'electron_main',
  module: 'main/lib/preferences-store',
};

/**
 * Main, last-good, backups and the generation record: resolves once the file
 * and its folder are flushed. An installed write whose folder flush failed
 * rejects with `StorageOutcomeUnknownError`; no caller proceeds past one.
 */
async function writeTextFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  const existingMode = await stat(filePath)
    .then((stats) => stats.mode & 0o7777)
    .catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    });
  await writeFileAtomically(filePath, content, {
    encoding: 'utf8',
    mode: existingMode,
    durable: true,
    admittedWriter: PREFERENCES_WRITER,
  });
}

/** Execution projection only. Mutations must use the stored view in updatePreferencesFile. */
export async function readPreferencesFile(): Promise<PreferencesData> {
  return preferencesRepository.read('runtime');
}

export type PreferencesAuthorityRead = RepositoryAuthorityRead<PreferencesData>;

/**
 * Read authority without recovery writes, for decisions that can delete
 * persisted state. `preferences` is defaults unless authority is `ok`;
 * `includeServed` adds the served fallback for non-authority settings.
 */
export async function readPreferencesFileDetailed(
  options: { includeServed?: boolean } = {},
): Promise<PreferencesAuthorityRead> {
  return preferencesRepository.readAuthority(options);
}

async function readPersistedPreferencesFile(): Promise<PreferencesData> {
  return preferencesRepository.read('persisted');
}

/**
 * Whether this data directory already contains durable preferences state.
 *
 * Startup migrations use this before reading normalized defaults so a truly
 * new install (no primary or last-good file) stays distinguishable from an
 * existing user whose older file simply lacks a newly introduced field.
 */
export async function hasPersistedPreferencesFile(): Promise<boolean> {
  return preferencesRepository.hasPersistedState();
}

/**
 * Resolve `localMemoryEnabled` for launch paths that gate harness-native
 * memory suppression. Missing or unreadable preferences use the application
 * default; an explicitly persisted `false` remains an opt-out.
 */
export async function readLocalMemoryEnabledPreference(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.localMemoryEnabled === true;
  } catch {
    return DEFAULT_PREFERENCES.localMemoryEnabled;
  }
}

export function projectPreferencesForRuntime(
  preferences: PreferencesData,
): PreferencesData {
  if (rendererRuntimeProjection?.source === preferences) {
    return rendererRuntimeProjection.result;
  }
  const result = normalizePreferences(preferences);
  rendererRuntimeProjection = { source: preferences, result };
  return result;
}

export function invalidateRendererRuntimePreferencesCache(): void {
  rendererRuntimeProjection = null;
}

export async function readPreferencesFileForRenderer(
  options?: PreferencesProjectionOptions,
): Promise<PreferencesLoadResult> {
  const persisted = await readPersistedPreferencesForRenderer();
  if (options?.view === 'persisted') return persisted;
  return {
    ...projectPreferencesForRuntime(rendererPreferencesCache ?? persisted),
    ...(persisted.__dataDir ? { __dataDir: persisted.__dataDir } : {}),
    ...(persisted.__error ? { __error: persisted.__error } : {}),
  };
}

async function readPersistedPreferencesForRenderer(): Promise<PreferencesLoadResult> {
  if (rendererPreferencesCache) {
    const loadError = preferencesRepository.peekLoadError();
    return {
      ...rendererPreferencesCache,
      __dataDir: getResolvedCanopyDataDir(),
      ...(loadError ? { __error: loadError } : {}),
    };
  }
  if (preferencesRendererLoadOperation) {
    return preferencesRendererLoadOperation;
  }

  const loadOperation = (async (): Promise<PreferencesLoadResult> => {
    let preferences = await readPersistedPreferencesFile();
    if (
      preferencesRepository.peekLoadError() === null &&
      !preferencesRepository.isRecoveryLatched() &&
      preferences.osNotifications.enabled &&
      preferences.osNotificationOfferAnsweredAt === undefined
    ) {
      // The renderer must receive durable suppression for enabled profiles.
      // Re-read inside the existing queue so a concurrent answer or Settings
      // change wins. The normalizer itself remains free of writes and clocks.
      preferences = await updatePreferencesFile((current) => {
        if (preferencesRepository.peekLoadError() !== null) {
          throw new Error(
            'Preferences could not be read for notification offer migration.',
          );
        }
        if (
          !current.osNotifications.enabled ||
          current.osNotificationOfferAnsweredAt !== undefined
        ) {
          return null;
        }
        return {
          osNotificationOfferAnsweredAt: notificationOfferMigrationTimestamp(),
        };
      });
    }
    rendererPreferencesCache = preferences;
    const dataDir = getResolvedCanopyDataDir();
    const loadError = preferencesRepository.peekLoadError();
    if (loadError) {
      return {
        ...preferences,
        __dataDir: dataDir,
        __error: loadError,
      };
    }
    return {
      ...preferences,
      __dataDir: dataDir,
    };
  })();

  preferencesRendererLoadOperation = loadOperation;
  try {
    return await loadOperation;
  } finally {
    if (preferencesRendererLoadOperation === loadOperation) {
      preferencesRendererLoadOperation = null;
    }
  }
}

export async function writePreferencesFile(
  preferences: Partial<PreferencesData>,
): Promise<PreferencesData> {
  return updatePreferencesFile(() => preferences);
}

export async function updatePreferencesFile(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<PreferencesData> {
  const result = await updatePreferencesFileWithPrevious(updater, onCommitted);
  return result.next;
}

function notificationOfferMigrationTimestamp(): string {
  return preferencesRepository.migrationTimestamp();
}

export async function updatePreferencesFileWithPrevious(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
): Promise<{ previous: PreferencesData; next: PreferencesData }> {
  return preferencesRepository.update(updater, onCommitted);
}

/**
 * Waits for queued saves and the last-good refreshes they started, again for
 * saves queued meanwhile. Bounded, so a steady writer cannot hold quit open.
 */
export async function flushPreferencesWrites(): Promise<void> {
  return preferencesRepository.flush();
}

export type { PreferencesGenerationStamp } from '@canopy/core-runtime/node/preferences';

/**
 * One save of the stored preferences, unless a save already landed under the
 * record. For a profile without a record, that save writes it and retires the
 * legacy last-good as a starting point. Queued like any save; rechecked inside
 * the queue, so a user save that got there first ends it. A latched recovery
 * refuses it until restart. `isStopped` is checked with no await before the
 * save is queued; a queued save completes like any save.
 */
export async function stampPreferencesGeneration(
  isStopped: () => boolean = (): boolean => false,
): Promise<PreferencesGenerationStamp> {
  return preferencesRepository.stampGeneration(isStopped);
}

/** Waits before each attempt; the last delay repeats. */
const PREFERENCES_GENERATION_STAMP_DELAYS_MS = [
  30_000, 30_000, 60_000, 120_000, 300_000,
] as const;

type StampWait = (delayMs: number) => Promise<boolean>;

let preferencesGenerationStamp: {
  run: Promise<PreferencesGenerationStamp>;
  stop: () => void;
} | null = null;

/**
 * Starts the background save that records the generation (Mike, 2026-10-31:
 * the save must be guaranteed). Off the startup path: it waits first, then
 * retries until a save lands under the record. Each launch starts it again,
 * so a quit only defers it. `wait` resolves false once stopped; tests
 * replace it.
 */
export function startPreferencesGenerationStamp(
  wait?: StampWait,
): Promise<PreferencesGenerationStamp> {
  if (preferencesGenerationStamp) return preferencesGenerationStamp.run;
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let cancelTimer = (): void => undefined;
  const waitForTimer: StampWait = (delayMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), delayMs);
      timer.unref();
      cancelTimer = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  const waitBeforeAttempt = wait ?? waitForTimer;
  const run = (async (): Promise<PreferencesGenerationStamp> => {
    for (let attempt = 0; ; attempt += 1) {
      const delayMs =
        PREFERENCES_GENERATION_STAMP_DELAYS_MS[
          Math.min(attempt, PREFERENCES_GENERATION_STAMP_DELAYS_MS.length - 1)
        ];
      if (stopped || !(await waitBeforeAttempt(delayMs)) || stopped)
        return 'stopped';
      const outcome = await stampPreferencesGeneration(isStopped);
      if (outcome !== 'failed') return outcome;
      // eslint-disable-next-line no-console
      console.error(
        'Failed to record the preferences generation; retrying in the background.',
      );
    }
  })();
  const stamp = {
    run,
    stop: (): void => {
      stopped = true;
      cancelTimer();
      release();
    },
  };
  function release(): void {
    if (preferencesGenerationStamp === stamp) preferencesGenerationStamp = null;
  }
  preferencesGenerationStamp = stamp;
  void run.then(release, release);
  return run;
}

/**
 * Quit stops future attempts. An attempt already queued completes, and quit's
 * flush waits for it, as for any save.
 */
export function stopPreferencesGenerationStamp(): void {
  preferencesGenerationStamp?.stop();
}

export async function readLatestPreferencesFile(): Promise<PreferencesData> {
  await preferencesRepository.idle();
  return rendererPreferencesCache ?? readPreferencesFile();
}

export function invalidateRendererPreferencesCache(): void {
  rendererPreferencesCache = null;
  invalidateRendererRuntimePreferencesCache();
}

/**
 * Read the pending preferences load/recovery error WITHOUT consuming it.
 *
 * `readPreferencesFile()` silently falls back to defaults (or to a recovered
 * last-known-good file) when the real preferences file is unreadable, corrupt,
 * or on an unsupported version — callers cannot otherwise tell a genuine
 * "user has no such preference" from "we never managed to read their file".
 * Startup migrations use this to avoid acting on, and permanently marking
 * themselves against, preferences that were never actually observed.
 *
 * Non-clearing on purpose: the app shell acknowledges the error only after it
 * has surfaced the recovery notification to the user.
 */
export function peekPreferencesLoadError(): PreferencesLoadErrorDetails | null {
  return preferencesRepository.peekLoadError();
}

/**
 * Whether a failed recovery is latched, so reads serve defaults or a
 * last-good copy that may predate the latest save. Either way they are not
 * proven to be the member's current choices: callers that gate data leaving
 * the device must not treat them as consent. The latch refuses saves and
 * outlives `acknowledgePreferencesLoadError`, so this holds until restart.
 */
export function arePreferencesUnconfirmed(): boolean {
  return preferencesRepository.isRecoveryLatched();
}

/** Clear a recovery error after the app shell has surfaced it to the user. */
export function acknowledgePreferencesLoadError(): void {
  preferencesRepository.acknowledgeLoadError();
}

export function resetPreferencesLoadErrorForTests(): void {
  stopPreferencesGenerationStamp();
  preferencesRepository.resetForTests();
  preferencesRendererLoadOperation = null;
  markPreferencesAuthorityConfirmed();
  invalidateRendererPreferencesCache();
}

export function readStoredPreferencesPayload(): Promise<StoredPreferencesPayloadRead> {
  return preferencesRepository.readStoredPayload();
}
