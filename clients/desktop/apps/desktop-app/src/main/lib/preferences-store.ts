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
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, stat } from 'node:fs/promises';
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
import { isOneWindowEnabled } from './one-window-switch';
import {
  applyCommittedDomainPreferences,
  applyForeignCommitOrdered,
  applyForeignHostEffects,
  applyPreferencesRecovered,
  applyPreferencesRecoveryLatched,
  claimPreferenceRevision,
  settleDomainPreferenceCommit,
  type DomainPreferenceChange,
  type ForeignPreferenceCommit,
  type ForeignPreferenceCommitChange,
} from './preference-commit-effects';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { toShortcutPlatform } from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { installPreferencesNormalizationEnvironment } from '@canopy/desktop-shared/node/preferences/normalization-environment';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import {
  assertPreferencesRowWritable,
  withPreferencesOwnerCheck,
} from './preferences-row-owner';
import { isRecord } from './type-guards';
import { normalizePreferences } from '@canopy/desktop-shared/node/preferences/normalize-preferences';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  createPreferencesRepository,
  preserveStoredKeys,
  type PreferencesDocument as PreferencesDocumentPort,
  type PreferencesDocumentSlot,
  type PreferencesAuthorityRead as RepositoryAuthorityRead,
  type PreferencesGenerationStamp,
  type PreferencesRepositoryHooks,
  type PreferencesChange,
  type StoredPreferencesPayloadRead,
} from '@canopy/core-runtime/node/preferences';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import {
  mergeClientLocalPreferences,
  splitPreferencesPatch,
  type ClientLocalPreferences,
  type DomainPreferencesData,
  type StoredDomainPreferences,
} from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import {
  selectDomainPreferences,
  type DomainPreferencesUpdateOptions,
  type StoredProductAnalyticsChoice,
} from './preferences-domain-port';
import {
  createClientLocalPreferencesStore,
  type LegacyClientLocalSource,
} from './client-preferences-store';
import {
  createDaemonPreferencesClient,
  type DaemonPreferencesClient,
  type DaemonPreferencesHooks,
  type PreferencesDocumentRoute,
} from '../canopy-runtime/preferences-daemon-client';

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
/**
 * What one stored-choice read saw: the state of every journal read it made
 * and the raw primary document text the repository read (before any journal
 * overlay). Scoped to that read's async context, so saves and other reads
 * running at the same time are never recorded here.
 */
interface StoredChoiceReadObservation {
  journal: Array<'readable' | 'unreadable'>;
  primaryText: string | null;
}
const storedChoiceReadObservation =
  new AsyncLocalStorage<StoredChoiceReadObservation>();

function createDesktopPreferencesDocument(): PreferencesDocumentPort {
  const observation = storedChoiceReadObservation.getStore();
  const filePath = getPreferencesFilePath();
  const document: PreferencesDocumentPort = {
    key: filePath,
    readText: async (slot) => {
      const text = await readFile(slotFilePath(filePath, slot), 'utf8');
      // The raw text, before the journal overlay can rewrite a malformed
      // section into a well-formed one.
      if (slot === 'primary' && observation !== undefined) {
        observation.primaryText = text;
      }
      return text;
    },
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
    createUsageDataConsentJournal(filePath, (status) => {
      observation?.journal.push(status);
    }),
  );
}

type UsageDataDenialJournalRead =
  | { kind: 'readable'; denied: readonly UsageDataKey[] }
  | { kind: 'unreadable' };

async function readUsageDataDenialJournal(
  journalPath: string,
): Promise<UsageDataDenialJournalRead> {
  try {
    const value: unknown = JSON.parse(await readFile(journalPath, 'utf8'));
    if (
      !Array.isArray(value) ||
      value.some((key) => !USAGE_DATA_KEYS.some((known) => known === key))
    )
      return { kind: 'unreadable' };
    return {
      kind: 'readable',
      denied: USAGE_DATA_KEYS.filter((key) => value.includes(key)),
    };
  } catch (error) {
    // A missing journal means nothing was revoked.
    return isMissingFileError(error)
      ? { kind: 'readable', denied: [] }
      : { kind: 'unreadable' };
  }
}

export type { StoredProductAnalyticsChoice };

/**
 * The member's stored Usage analytics choice, from one authority read of the
 * preferences (the repository's `readAuthority`: after any save in flight,
 * without recovery writes) that also reports the state of the write-ahead
 * revocation journal that same read saw. While the journal can't be read,
 * every usage-data key reads as denied, which says nothing about the member's
 * own choice, so that is its own `denial-journal-unreadable` answer and never
 * a `denied`. `unconfirmed` is every other case where no saved choice is
 * proven: a latched recovery, an unreadable file, a read that never reached
 * the journal, and a saved value that is present but not a boolean or a
 * usage-data section that isn't an object (the repository normalizes those to
 * the default, on), judged on the saved text before any journal denial is
 * applied, so a journal denial never repairs one. A missing file is a fresh
 * install, whose default is allowed, and so is a field that is absent.
 */
export function readStoredProductAnalyticsChoice(): Promise<StoredProductAnalyticsChoice> {
  return domainPreferences.readStoredProductAnalyticsChoice();
}

/** The in-process port's source: what one authority read of the document saw. */
async function observeStoredProductAnalyticsChoice(): Promise<StoredProductAnalyticsChoice> {
  const observation: StoredChoiceReadObservation = {
    journal: [],
    primaryText: null,
  };
  // Only the in-process document can record what this read saw.
  const read = await storedChoiceReadObservation.run(observation, () =>
    preferencesRepository.readAuthority(),
  );
  if (observation.journal.includes('unreadable')) {
    return 'denial-journal-unreadable';
  }
  // Every read of the document reads the journal; none leaves it unknown.
  if (read.authority === 'unreadable' || observation.journal.length === 0) {
    return 'unconfirmed';
  }
  // Judged on the saved text before the journal overlay, which can rewrite a
  // malformed section into a well-formed one. A malformed section proves no
  // choice, even when the journal denies a key; only once the saved section
  // is well formed does the overlaid value decide.
  if (
    read.authority === 'ok' &&
    !holdsWellFormedProductAnalyticsChoice(observation.primaryText)
  ) {
    return 'unconfirmed';
  }
  return read.preferences.usageData.productAnalytics ? 'allowed' : 'denied';
}

/**
 * Whether the saved `usageData.productAnalytics`, in the raw document text the
 * authority read saw (before the journal overlay), is a boolean or absent,
 * rather than a value that normalization replaced with the default.
 */
function holdsWellFormedProductAnalyticsChoice(text: string | null): boolean {
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.preferences)) return false;
  const usageData = parsed.preferences.usageData;
  if (usageData === undefined) return true;
  if (!isRecord(usageData)) return false;
  const choice = usageData.productAnalytics;
  return choice === undefined || typeof choice === 'boolean';
}

function createUsageDataConsentJournal(
  filePath: string,
  onRead?: (status: 'readable' | 'unreadable') => void,
): ConsentJournal {
  const journalPath = createUsageDataDenialsPath(filePath);
  return {
    async read(): Promise<readonly UsageDataKey[]> {
      const journal = await readUsageDataDenialJournal(journalPath);
      onRead?.(journal.kind);
      // An unreadable journal denies every usage-data flow.
      return journal.kind === 'unreadable' ? USAGE_DATA_KEYS : journal.denied;
    },
    write: async (denied): Promise<void> => {
      await assertPreferencesRowWritable(filePath);
      await createPreferencesFolderDurably(filePath);
      await writeFileAtomically(journalPath, JSON.stringify(denied), {
        encoding: 'utf8',
        mode: 0o600,
        durable: true,
        admittedWriter: PREFERENCES_WRITER,
      });
    },
    deny: denyUsageData,
  };
}

/** Turns `denied` off in main's live usage-data policy. */
function denyUsageData(denied: readonly UsageDataKey[]): void {
  const policy = getUsageDataPolicy();
  const preferences = policy.getUsageDataPolicySnapshot().preferences;
  for (const key of denied) preferences[key] = false;
  policy.setPreferences(preferences);
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
}: PreferencesChange<DomainPreferencesData>): {
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
/**
 * The merged view of a domain value, client-local part last (CAN-4472). Until
 * the client-local document is ready its values aren't known, so callers that
 * cache a merged value skip it then.
 */
function withClientLocal(domain: StoredDomainPreferences): PreferencesData {
  return mergeClientLocalPreferences(domain, clientLocalPreferences.current());
}

/** The store's own state for a domain commit, then the consumer's settle stage. */
async function settleDomainCommit(
  change: DomainPreferenceChange,
): Promise<void> {
  if (change.previous.opencodeEnabled !== change.next.opencodeEnabled)
    openCodeEnabledRevision++;
  rendererPreferencesCache = clientLocalPreferences.isReady()
    ? withClientLocal(change.next)
    : null;
  await settleDomainPreferenceCommit(change);
}

function applyDomainCommitted(next: StoredDomainPreferences): void {
  applyCommittedDomainPreferences(
    next,
    withClientLocal(next),
    arePreferencesUnconfirmed(),
  );
}

/** An own save is about to change the Copilot selection: its pre-commit notice. */
function noticeCopilotSelectionChanging({
  previous,
  next,
}: DomainPreferenceChange): void {
  if (
    copilotSelectionObservers.size > 0 &&
    JSON.stringify(previous.copilotVaultSelection) !==
      JSON.stringify(next.copilotVaultSelection)
  )
    notifyCopilotSelectionAuthority({
      kind: 'changing',
      selection: next.copilotVaultSelection,
    });
}

/** What every own save runs around its commit, on either port. */
const saveHooks: Omit<
  DaemonPreferencesHooks<StoredDomainPreferences>,
  'beforeSave'
> = {
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
  afterSave: (change) => settleDomainCommit(change),
  onCommitted: (next) => applyDomainCommitted(next),
};

const preferencesHooks: PreferencesRepositoryHooks<StoredDomainPreferences> = {
  ...saveHooks,
  beforeSave: async (change, document): Promise<void> => {
    noticeCopilotSelectionChanging(change);
    await recordUsageDataRevocations(
      createUsageDataConsentJournal(document.key),
      change.next.usageData,
    );
  },
  onRecoveryLatched: () => {
    notifyCopilotSelectionAuthority({ kind: 'unavailable' });
    invalidateRendererPreferencesCache();
    applyPreferencesRecoveryLatched();
  },
  onRecovered: (restored) => {
    rendererPreferencesCache = clientLocalPreferences.isReady()
      ? withClientLocal(restored)
      : null;
    applyPreferencesRecovered(restored, arePreferencesUnconfirmed());
  },
};
// The domain document keeps a frozen copy of whatever it stored for the
// client-local keys and never writes them otherwise (CAN-4472): users who skip
// releases still seed from it, in any order of writers.
const preferencesRepository =
  createPreferencesRepository<StoredDomainPreferences>({
    document: () =>
      withPreferencesOwnerCheck(createDesktopPreferencesDocument()),
    codec: preserveStoredKeys(
      DESKTOP_PREFERENCES_CODEC,
      CLIENT_LOCAL_PREFERENCE_KEYS,
    ),
    hooks: preferencesHooks,
    log: {
      error: (message, error) => {
        // eslint-disable-next-line no-console
        console.error(message, error);
      },
    },
  });
/**
 * An own save's pre-commit steps on the daemon client (CAN-7991). The
 * in-process `beforeSave` splits in two: the Copilot notice and the live
 * policy's denial are main's, so they run here before each send; the
 * revocation journal is the document's, which the daemon's module writes in
 * its own `beforeSave` (core-runtime `consent-journal.ts`).
 */
const daemonPreferencesHooks: DaemonPreferencesHooks<StoredDomainPreferences> =
  {
    ...saveHooks,
    beforeSave: (change): Promise<void> => {
      noticeCopilotSelectionChanging(change);
      // As the in-process journal's `deny`: a revoked flow stops in main
      // before the save can land, so an unknown outcome never leaves it on.
      const revoked = USAGE_DATA_KEYS.filter(
        (key) => change.next.usageData[key] === false,
      );
      if (revoked.length > 0) denyUsageData(revoked);
      return Promise.resolve();
    },
  };

/**
 * The daemon-backed domain port over `route`, with the store's own hooks
 * and commit consumer (CAN-5722 E2). Nothing selects it yet: the flip passes
 * it to `selectDomainPreferences`.
 */
export function createDaemonDomainPreferences(
  route: PreferencesDocumentRoute,
): DaemonPreferencesClient<StoredDomainPreferences> {
  const filePath = getPreferencesFilePath();
  return createDaemonPreferencesClient<StoredDomainPreferences>({
    route,
    codec: preserveStoredKeys(
      DESKTOP_PREFERENCES_CODEC,
      CLIENT_LOCAL_PREFERENCE_KEYS,
    ),
    hooks: daemonPreferencesHooks,
    applyForeignCommit: applyForeignPreferenceCommit,
    paths: {
      document: filePath,
      lastGood: createPreferencesLastGoodPath(filePath),
    },
    log: {
      error: (message, error) => {
        // eslint-disable-next-line no-console
        console.error(message, error);
      },
    },
  });
}

// Every domain read and write goes through the port (CAN-5722, slice E1).
const domainPreferences = selectDomainPreferences(preferencesRepository, {
  readStoredProductAnalyticsChoice: observeStoredProductAnalyticsChoice,
});

const legacyClientLocalSource: LegacyClientLocalSource = {
  read: () => domainPreferences.readLegacyClientLocal(),
};

const clientLocalPreferences = createClientLocalPreferencesStore({
  legacy: legacyClientLocalSource,
  warn: (message, error) => {
    // eslint-disable-next-line no-console
    console.warn(message, error);
  },
});

/**
 * Serializes writes across both documents. Reads don't wait on it: hook code
 * that reads must never wait on a commit.
 */
let compositeWriteQueue: Promise<void> = Promise.resolve();
function enqueueCompositeWrite<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = compositeWriteQueue.then(operation);
  compositeWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function hasKeys(patch: object): boolean {
  return Object.keys(patch).length > 0;
}

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
  await clientLocalPreferences.ready();
  return withClientLocal(await domainPreferences.read('runtime'));
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
  await clientLocalPreferences.ready();
  const read = await domainPreferences.readAuthority(options);
  return {
    preferences: withClientLocal(read.preferences),
    authority: read.authority,
    ...(read.served === undefined
      ? {}
      : { served: withClientLocal(read.served) }),
  };
}

async function readPersistedPreferencesFile(): Promise<PreferencesData> {
  await clientLocalPreferences.ready();
  return withClientLocal(await domainPreferences.read('persisted'));
}

/**
 * Whether this data directory already contains durable preferences state.
 *
 * Startup migrations use this before reading normalized defaults so a truly
 * new install (no primary or last-good file) stays distinguishable from an
 * existing user whose older file simply lacks a newly introduced field.
 */
export async function hasPersistedPreferencesFile(): Promise<boolean> {
  return domainPreferences.hasPersistedState();
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
  const mainState = {
    ...(arePreferencesUnconfirmed() ? { __preferencesUnconfirmed: true } : {}),
    __oneWindowEnabled: isOneWindowEnabled(),
  };
  if (options?.view === 'persisted') return { ...persisted, ...mainState };
  return {
    ...projectPreferencesForRuntime(rendererPreferencesCache ?? persisted),
    ...(persisted.__dataDir ? { __dataDir: persisted.__dataDir } : {}),
    ...(persisted.__error ? { __error: persisted.__error } : {}),
    ...mainState,
  };
}

async function readPersistedPreferencesForRenderer(): Promise<PreferencesLoadResult> {
  if (rendererPreferencesCache) {
    const loadError = domainPreferences.peekLoadError();
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
      domainPreferences.peekLoadError() === null &&
      !domainPreferences.isRecoveryLatched() &&
      preferences.osNotifications.enabled &&
      preferences.osNotificationOfferAnsweredAt === undefined
    ) {
      // The renderer must receive durable suppression for enabled profiles.
      // Re-read inside the existing queue so a concurrent answer or Settings
      // change wins. The normalizer itself remains free of writes and clocks.
      preferences = await updatePreferencesFile((current) => {
        if (domainPreferences.peekLoadError() !== null) {
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
    const loadError = domainPreferences.peekLoadError();
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
  options?: DomainPreferencesUpdateOptions,
): Promise<PreferencesData> {
  const result = await updatePreferencesFileWithPrevious(
    updater,
    onCommitted,
    options,
  );
  return result.next;
}

function notificationOfferMigrationTimestamp(): string {
  return domainPreferences.migrationTimestamp();
}

/**
 * One save, split by document (CAN-4472): the domain part commits first, then
 * the client-local part, so a domain refusal (a latch, a corrupt record)
 * refuses the whole save with no client-local change, as before the split.
 * `previous` and `next` are distinct merged values; `onCommitted` sees the
 * merged commit once, in commit order, for every non-null patch, except a
 * client-only save the port answered `unread`: its domain part is the
 * defaults standing in for an unread document, and the result says so with
 * `domainUnread` (`arePreferencesUnconfirmed()` may already be false by
 * then). `route` defaults to `internal`; only a caller-supplied patch passes
 * `caller`. The updater may run more than once (see `DomainPreferencesPort`).
 */
export async function updatePreferencesFileWithPrevious(
  updater: PreferencesUpdater,
  onCommitted?: PreferencesCommitObserver,
  { route }: DomainPreferencesUpdateOptions = { route: 'internal' },
): Promise<{
  previous: PreferencesData;
  next: PreferencesData;
  domainUnread?: true;
}> {
  // Queued synchronously, as the engine queues its saves: from here quit's
  // flush waits for this save, seed included.
  return enqueueCompositeWrite(async () => {
    await clientLocalPreferences.ready();
    const clientBefore = clientLocalPreferences.current();
    let clientPatch: Partial<ClientLocalPreferences> = {};
    let patched = false;
    let clientOnly = false;
    const change = await domainPreferences.update(
      async (latest) => {
        clientPatch = {};
        patched = false;
        clientOnly = false;
        const patch = await updater(
          mergeClientLocalPreferences(latest, clientBefore),
        );
        if (patch === null) return null;
        patched = true;
        const split = splitPreferencesPatch(patch);
        clientPatch = split.clientLocal;
        // A purely client-local save leaves preferences.json untouched; an
        // empty patch still saves it, as `stampGeneration` relies on. The
        // port gets the whole patch: it drops client-local keys itself.
        clientOnly = hasKeys(split.clientLocal) && !hasKeys(split.domain);
        return clientOnly ? null : patch;
      },
      undefined,
      { route, isClientOnly: () => clientOnly },
    );
    const clientAfter = hasKeys(clientPatch)
      ? await clientLocalPreferences.write(clientPatch)
      : clientBefore;
    const result = {
      previous: mergeClientLocalPreferences(change.previous, clientBefore),
      next: mergeClientLocalPreferences(change.next, clientAfter),
    };
    // A port refuses every save while latched, except a remote port's
    // client-only save on a domain document it has not read: that answers
    // the codec's defaults (see `PreferencesPort`), which no observer or
    // cache may take as the stored preferences. Judged by this save's own
    // answer: a read landing during the client write ends the latch.
    if (change.unread === true) return { ...result, domainUnread: true };
    if (patched) {
      rendererPreferencesCache = result.next;
      onCommitted?.(result.next);
    }
    return result;
  });
}

/**
 * Another client's committed revision (CAN-5722, slice F): its domain stages
 * in order with this process's writes, then its host effects, once per
 * revision. The daemon-backed port (E2) feeds it; nothing in process does.
 */
export async function applyForeignPreferenceCommit(
  commit: ForeignPreferenceCommit,
): Promise<void> {
  if (!claimPreferenceRevision(commit.revision)) return;
  const change = await enqueueCompositeWrite(async () => {
    await clientLocalPreferences.ready();
    // What an own save's pre-commit and durability hooks apply, once durable.
    if (
      JSON.stringify(commit.previous.copilotVaultSelection) !==
      JSON.stringify(commit.next.copilotVaultSelection)
    )
      notifyCopilotSelectionAuthority({
        kind: 'changing',
        selection: commit.next.copilotVaultSelection,
      });
    if (approvalChange(commit).authorityChanged)
      markGlobalApprovalRulesChanged();
    markPreferencesAuthorityConfirmed();
    await settleDomainCommit(commit);
    applyDomainCommitted(commit.next);
    const merged: ForeignPreferenceCommitChange = {
      origin: 'foreign',
      previous: withClientLocal(commit.previous),
      next: withClientLocal(commit.next),
      changedKeys: commit.changedKeys,
    };
    applyForeignCommitOrdered(merged);
    return merged;
  });
  await applyForeignHostEffects(change);
}

/**
 * Waits for queued saves and the last-good refreshes they started, again for
 * saves queued meanwhile. Bounded, so a steady writer cannot hold quit open.
 */
export async function flushPreferencesWrites(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const queue = compositeWriteQueue;
    await queue;
    await domainPreferences.flush();
    await clientLocalPreferences.flush();
    if (queue === compositeWriteQueue) return;
  }
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
  return domainPreferences.stampGeneration(isStopped);
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
      if (outcome === 'refused') {
        // eslint-disable-next-line no-console
        console.warn(
          'Another owner keeps the preferences, so the generation stays unrecorded.',
        );
      }
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
  await clientLocalPreferences.ready();
  await compositeWriteQueue;
  await domainPreferences.idle();
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
  return domainPreferences.peekLoadError();
}

/**
 * Whether a failed recovery is latched, so reads serve defaults or a
 * last-good copy that may predate the latest save. Either way they are not
 * proven to be the member's current choices: callers that gate data leaving
 * the device must not treat them as consent. The latch refuses saves and
 * outlives `acknowledgePreferencesLoadError`, so this holds until restart.
 */
export function arePreferencesUnconfirmed(): boolean {
  return domainPreferences.isRecoveryLatched();
}

/** Clear a recovery error after the app shell has surfaced it to the user. */
export function acknowledgePreferencesLoadError(): void {
  domainPreferences.acknowledgeLoadError();
}

export function resetPreferencesLoadErrorForTests(): void {
  stopPreferencesGenerationStamp();
  domainPreferences.resetForTests();
  clientLocalPreferences.resetForTests();
  preferencesRendererLoadOperation = null;
  markPreferencesAuthorityConfirmed();
  invalidateRendererPreferencesCache();
}

export function readStoredPreferencesPayload(): Promise<StoredPreferencesPayloadRead> {
  return domainPreferences.readStoredPayload();
}
