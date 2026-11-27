import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ConfigStoredUsageDataChoice } from '@canopy/protocol/canopy-core/core';
import { isRecord } from '../w5/commit-log/is-record';
import {
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
  assertAdmittedWriter,
  type StorageOwnershipRow,
} from '../../storage';
import { pruneDamagedCopies } from '../damaged-copies';
import { assertRowWritable } from '../storage-records';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type ClientLocalPreferenceKey,
} from './client-local-keys';
import type { PreferencesCodec } from './codec';
import {
  recordUsageDataRevocations,
  withUsageDataConsentJournal,
  type ConsentJournal,
} from './consent-journal';
import {
  isMissingDocumentError,
  type PreferencesDocument,
  type PreferencesDocumentSlot,
  type PreferencesLog,
} from './document';
import { PREFERENCES_NAMESPACE_ID } from './family';
import {
  preserveStoredKeys,
  type WithStoredKeys,
} from './preserve-stored-keys';
import {
  createPreferencesRepository,
  type PreferencesRepository,
  type PreferencesRepositoryHooks,
} from './repository';

/*
 * The daemon's preferences document (CAN-7956, slice D1 of CAN-5722): the
 * data root's `preferences.json` family, through the shared repository, with
 * the domain codec injected (it stays in desktop-shared until T33) and the
 * client-local keys frozen as stored. Inert: nothing composes it yet, and
 * every write is refused before any byte is written unless the ownership rows
 * name the daemon the row's writer and its owner record allows it. Under the
 * compiled rows the row is legacy, so `evaluateStorageWrite` refuses.
 */

/** The daemon's view of a preferences record: opaque top-level keys. */
export type DaemonPreferencesRecord = Record<string, unknown>;
export type DaemonStoredPreferences = WithStoredKeys<
  DaemonPreferencesRecord,
  ClientLocalPreferenceKey
>;

const CLAIM = {
  namespace: PREFERENCES_NAMESPACE_ID,
  writer: 'daemon',
  module: 'packages/core-runtime/src/node/preferences/daemon-document.ts',
} as const;

const SLOT_FILES: Record<PreferencesDocumentSlot, string> = {
  primary: 'preferences.json',
  lastGood: 'preferences.last-good.json',
  generation: 'preferences.generation.json',
};
const USAGE_DATA_DENIALS_FILE = 'preferences.json.usage-data-denied.json';
const BACKUP_PREFIX = 'preferences.backup-';

type SyncDirectory = (path: string) => Promise<'flushed' | 'unsupported'>;

export interface DaemonPreferencesOptions<K extends string> {
  /** The data root holding `preferences.json`. */
  readonly dataRoot: string;
  /** The domain codec, injected until it leaves desktop-shared. */
  readonly codec: PreferencesCodec<DaemonPreferencesRecord>;
  /** The usage-data switches the consent journal tracks. */
  readonly usageDataKeys: readonly K[];
  /** The host's folder flush; any answer but `flushed` leaves a write's outcome unknown. */
  readonly syncDirectory: SyncDirectory;
  /** Applies journaled denials to the host's live usage-data policy. */
  readonly onUsageDataDenied?: (denied: readonly K[]) => void;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly writeVersion?: number;
  readonly hooks?: Omit<
    PreferencesRepositoryHooks<DaemonStoredPreferences>,
    'beforeSave'
  >;
  readonly log: PreferencesLog;
}

/** Each tracked usage-data flow's stored choice, by its `usageData` key. */
export type StoredUsageDataChoices = Record<
  string,
  ConfigStoredUsageDataChoice
>;

export interface DaemonPreferences {
  readonly repository: PreferencesRepository<DaemonStoredPreferences>;
  /** The wrapped codec the repository merges with. */
  readonly codec: PreferencesCodec<DaemonStoredPreferences>;
  /**
   * The stored usage-data choices, from one authority read (after any save
   * in flight, without recovery writes) that also reports what the journal
   * and the saved text it read proved (CAN-7991). Electron's in-process
   * `readStoredProductAnalyticsChoice` judges the same way.
   */
  readStoredUsageData(): Promise<StoredUsageDataChoices>;
}

/** Installs `text` at `path` atomically; a failed folder flush is an unknown outcome. */
async function installDurably(
  path: string,
  text: string,
  syncDirectory: SyncDirectory,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  let flushed: 'flushed' | 'unsupported';
  try {
    flushed = await syncDirectory(dirname(path));
  } catch (error) {
    throw new StorageOutcomeUnknownError(
      'directory_flush',
      error,
      CLAIM.namespace,
    );
  }
  if (flushed !== 'flushed')
    throw new StorageOutcomeUnknownError(
      'directory_flush',
      new Error('The folder flush is unsupported.'),
      CLAIM.namespace,
    );
}

/**
 * What one stored-choice read saw: each journal read's state and the raw
 * primary text (before the journal overlay). Scoped to that read's async
 * context, so saves and other reads running beside it are never recorded.
 */
interface StoredChoiceObservation {
  journal: Array<'readable' | 'unreadable'>;
  primaryText: string | null;
}
const storedChoiceObservation =
  new AsyncLocalStorage<StoredChoiceObservation>();

function createConsentJournal<K extends string>(
  options: DaemonPreferencesOptions<K>,
  path: string,
  write: (text: string) => Promise<void>,
): ConsentJournal<K> {
  const { usageDataKeys } = options;
  const parse = (value: unknown): readonly K[] | null => {
    if (!Array.isArray(value)) return null;
    const stored: unknown[] = value;
    if (stored.some((key) => !usageDataKeys.some((known) => known === key)))
      return null;
    return usageDataKeys.filter((key) => stored.includes(key));
  };
  return {
    async read(): Promise<readonly K[]> {
      // A missing journal revoked nothing; an unreadable one denies all.
      const value = await readFile(path, 'utf8').then(
        (text): unknown => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        },
        (error: unknown) => (isMissingDocumentError(error) ? [] : null),
      );
      const denied = parse(value);
      storedChoiceObservation
        .getStore()
        ?.journal.push(denied === null ? 'unreadable' : 'readable');
      return denied ?? usageDataKeys;
    },
    write: (denied) => write(JSON.stringify(denied)),
    deny: (denied): void => options.onUsageDataDenied?.(denied),
  };
}

export function createDaemonPreferences<K extends string>(
  options: DaemonPreferencesOptions<K>,
): DaemonPreferences {
  const { syncDirectory, usageDataKeys } = options;
  // Normalized, so the folder flush below meets the folder mkdir created.
  const dataRoot = resolve(options.dataRoot);
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  const slotPath = (slot: PreferencesDocumentSlot): string =>
    join(dataRoot, SLOT_FILES[slot]);
  // Before any effect: every byte, the folder, and a journaled denial.
  const admit = async (): Promise<void> => {
    assertAdmittedWriter(
      CLAIM.namespace,
      CLAIM.writer,
      CLAIM.module,
      ownership,
    );
    await assertRowWritable(dataRoot, CLAIM.namespace, CLAIM.writer);
  };
  const install = async (path: string, text: string): Promise<void> => {
    await admit();
    await installDurably(path, text, syncDirectory);
  };
  const files: PreferencesDocument = {
    key: slotPath('primary'),
    readText: async (slot) => {
      const text = await readFile(slotPath(slot), 'utf8');
      // The raw text, before the journal overlay can rewrite a malformed
      // section into a well-formed one.
      const observation = storedChoiceObservation.getStore();
      if (slot === 'primary' && observation !== undefined)
        observation.primaryText = text;
      return text;
    },
    exists: (slot) =>
      stat(slotPath(slot)).then(
        () => true,
        (error: unknown) => {
          if (isMissingDocumentError(error)) return false;
          throw error;
        },
      ),
    install: (slot, content) => install(slotPath(slot), content),
    ensureFolder: async (): Promise<void> => {
      await admit();
      const created = await mkdir(dataRoot, { recursive: true });
      if (created === undefined) return;
      for (let folder = dataRoot; ; folder = dirname(folder)) {
        if ((await syncDirectory(dirname(folder))) !== 'flushed')
          throw new Error('The preferences folder could not be made durable.');
        if (folder === created || dirname(folder) === folder) return;
      }
    },
    slotPath,
    backupLocation: (stamp) =>
      join(dataRoot, `${BACKUP_PREFIX}${stamp.replace(/[:.]/g, '-')}.json`),
    installBackup: (location, content) => install(location, content),
    pruneBackups: async (): Promise<void> => {
      await admit();
      await pruneDamagedCopies({
        directory: dataRoot,
        prefix: BACKUP_PREFIX,
        suffix: '.json',
        uniqueTail: true,
      });
    },
  };
  const journalPath = join(dataRoot, USAGE_DATA_DENIALS_FILE);
  // The journal is written ahead of the save's own folder step.
  const journal = createConsentJournal(options, journalPath, async (text) => {
    await files.ensureFolder();
    await installDurably(journalPath, text, syncDirectory);
  });
  const document = withUsageDataConsentJournal(files, journal, usageDataKeys);
  const codec = preserveStoredKeys(options.codec, CLIENT_LOCAL_PREFERENCE_KEYS);
  const repository = createPreferencesRepository<DaemonStoredPreferences>({
    document: () => document,
    codec,
    writeVersion: options.writeVersion,
    log: options.log,
    hooks: {
      ...options.hooks,
      beforeSave: async ({ next }): Promise<void> => {
        await admit();
        await recordUsageDataRevocations(
          journal,
          usageDataKeys,
          next.usageData,
        );
      },
    },
  });
  const readStoredUsageData = async (): Promise<StoredUsageDataChoices> => {
    const observation: StoredChoiceObservation = {
      journal: [],
      primaryText: null,
    };
    const read = await storedChoiceObservation.run(observation, () =>
      repository.readAuthority(),
    );
    const every = (
      choice: ConfigStoredUsageDataChoice,
    ): StoredUsageDataChoices =>
      Object.fromEntries(usageDataKeys.map((key) => [key, choice]));
    if (observation.journal.includes('unreadable'))
      return every('denial-journal-unreadable');
    // Every read of the document reads the journal; none leaves it unknown.
    if (read.authority === 'unreadable' || observation.journal.length === 0)
      return every('unconfirmed');
    // A missing document is a fresh profile, whose defaults decide.
    const saved =
      read.authority === 'ok'
        ? savedUsageDataSection(observation.primaryText)
        : { kind: 'absent' as const };
    const overlaid = read.preferences.usageData;
    return Object.fromEntries(
      usageDataKeys.map((key): [string, ConfigStoredUsageDataChoice] => {
        if (saved.kind === 'malformed') return [key, 'unconfirmed'];
        const choice =
          saved.kind === 'present' ? saved.section[key] : undefined;
        if (choice !== undefined && typeof choice !== 'boolean')
          return [key, 'unconfirmed'];
        // Well formed as saved: the overlaid value decides, journal included.
        const value = isRecord(overlaid) ? overlaid[key] : undefined;
        if (value === true) return [key, 'allowed'];
        if (value === false) return [key, 'denied'];
        return [key, 'unconfirmed'];
      }),
    );
  };
  return { repository, codec, readStoredUsageData };
}

type SavedUsageDataSection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'present'; readonly section: Record<string, unknown> };

/**
 * The saved `usageData` section in the raw primary text the authority read
 * saw, before the journal overlay. Absent is the default; a section that is
 * not an object, or text that is not a preferences envelope, is malformed.
 */
function savedUsageDataSection(text: string | null): SavedUsageDataSection {
  if (text === null) return { kind: 'malformed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.preferences))
    return { kind: 'malformed' };
  const section = parsed.preferences.usageData;
  if (section === undefined) return { kind: 'absent' };
  return isRecord(section)
    ? { kind: 'present', section }
    : { kind: 'malformed' };
}
