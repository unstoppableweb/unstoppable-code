import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  createPreferencesRepository,
  type PreferencesDocument,
  type PreferencesDocumentSlot,
} from '@canopy/core-runtime/node/preferences';
import {
  CLIENT_LOCAL_PREFERENCES_CODEC,
  normalizeClientLocalPreferences,
  type ClientLocalPreferences,
} from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import { isRecord } from './type-guards';
import { getClientPreferencesFilePath } from './paths';

/**
 * What the domain preferences document can seed this client's document from,
 * by the domain's own recovery verdict (CAN-4472): `read` only when its read
 * accepted the document, `missing` when there is none, and `pending` when it
 * is latched, on an unsupported version or unreadable. `pending` serves its
 * fallback values for this session and persists nothing.
 */
export type LegacyClientLocalRead =
  | { kind: 'read'; values: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'pending'; served: Record<string, unknown> };

export interface LegacyClientLocalSource {
  read(): Promise<LegacyClientLocalRead>;
}

/**
 * Window geometry, appearance and pure view state, in a document of its own
 * beside `preferences.json`. Never refuses: whatever can't be read or written
 * falls back to the last values that were readable, kept in memory.
 */
export interface ClientLocalPreferencesStore {
  /** Seeds or rebuilds once per process; never rejects. */
  ready(): Promise<void>;
  isReady(): boolean;
  current(): ClientLocalPreferences;
  /** Applies `patch` in memory, then persists the whole document; never rejects. */
  write(
    patch: Partial<ClientLocalPreferences>,
  ): Promise<ClientLocalPreferences>;
  flush(): Promise<void>;
  resetForTests(): void;
}

const CLIENT_PREFERENCES_WRITER: AdmittedWriterTarget = {
  namespace: 'client_preferences',
  writer: 'electron_main',
  module: 'main/lib/client-preferences-store',
};

const BACKUP_PREFIX = 'client-preferences.backup-';

function slotFilePath(filePath: string, slot: PreferencesDocumentSlot): string {
  switch (slot) {
    case 'primary':
      return filePath;
    case 'lastGood':
      return join(dirname(filePath), 'client-preferences.last-good.json');
    case 'generation':
      return join(dirname(filePath), 'client-preferences.generation.json');
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function createClientPreferencesFolderDurably(filePath: string): Promise<void> {
  const dataRoot = dirname(filePath);
  return createDirectoryDurably(dataRoot, { dataRoot });
}

async function writeTextFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFileAtomically(filePath, content, {
    encoding: 'utf8',
    durable: true,
    admittedWriter: CLIENT_PREFERENCES_WRITER,
  });
}

/** The engine's document port, resolved per operation like the domain's. */
function createClientPreferencesDocument(): PreferencesDocument {
  const filePath = getClientPreferencesFilePath();
  return {
    key: filePath,
    readText: (slot) => readFile(slotFilePath(filePath, slot), 'utf8'),
    exists: (slot) =>
      stat(slotFilePath(filePath, slot)).then(
        () => true,
        (error: unknown) => {
          if (isMissingFileError(error)) return false;
          throw error;
        },
      ),
    install: (slot, content) => {
      switch (slot) {
        case 'primary':
          return writeTextFileAtomically(filePath, content);
        case 'lastGood':
          return writeTextFileAtomically(
            join(dirname(filePath), 'client-preferences.last-good.json'),
            content,
          );
        case 'generation':
          return writeTextFileAtomically(
            join(dirname(filePath), 'client-preferences.generation.json'),
            content,
          );
      }
    },
    ensureFolder: () => createClientPreferencesFolderDurably(filePath),
    slotPath: (slot) => slotFilePath(filePath, slot),
    backupLocation: (stamp) =>
      join(
        dirname(filePath),
        `${BACKUP_PREFIX}${stamp.replace(/[:.]/g, '-')}.json`,
      ),
    installBackup: (location, content) =>
      writeTextFileAtomically(location, content),
    pruneBackups: async (): Promise<void> => {
      await pruneDamagedCopies({
        directory: dirname(filePath),
        prefix: BACKUP_PREFIX,
        suffix: '.json',
        uniqueTail: true,
      });
    },
  };
}

type SlotRead =
  | { kind: 'readable'; payload: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unreadable'; text: string | null };

async function readSlot(
  document: PreferencesDocument,
  slot: 'primary' | 'lastGood',
): Promise<SlotRead> {
  let text: string;
  try {
    text = await document.readText(slot);
  } catch (error) {
    return isMissingFileError(error)
      ? { kind: 'missing' }
      : { kind: 'unreadable', text: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      isRecord(parsed.preferences)
    )
      return { kind: 'readable', payload: parsed.preferences };
  } catch {
    // Unparseable: moved aside below.
  }
  return { kind: 'unreadable', text };
}

function hasAnyValue(values: Record<string, unknown>): boolean {
  return Object.keys(values).length > 0;
}

export function createClientLocalPreferencesStore(options: {
  readonly legacy: LegacyClientLocalSource;
  readonly warn: (message: string, error?: unknown) => void;
}): ClientLocalPreferencesStore {
  const resolveDocument = (): PreferencesDocument =>
    createClientPreferencesDocument();
  const repository = createPreferencesRepository<ClientLocalPreferences>({
    document: resolveDocument,
    codec: CLIENT_LOCAL_PREFERENCES_CODEC,
    log: { error: (message, error) => options.warn(message, error) },
  });
  let currentValue: ClientLocalPreferences =
    CLIENT_LOCAL_PREFERENCES_CODEC.defaults;
  // False while the domain is `pending`: this session's values stay in memory.
  let persisting = false;
  let prepared = false;
  let preparation: Promise<void> | null = null;

  async function persist(value: ClientLocalPreferences): Promise<void> {
    try {
      // The whole document: the engine merges over what is on disk, which
      // may not hold the seed yet.
      await repository.update(() => value);
    } catch (error) {
      options.warn(
        'Client-local preferences could not be saved; this session keeps them in memory.',
        error,
      );
    }
  }

  async function legacyRead(): Promise<LegacyClientLocalRead> {
    try {
      return await options.legacy.read();
    } catch (error) {
      options.warn(
        'Preferences could not be read to seed client-local preferences.',
        error,
      );
      return { kind: 'pending', served: {} };
    }
  }

  /** Seeds from the domain's verdict; persists only what the domain accepted. */
  async function seed(source: LegacyClientLocalRead): Promise<void> {
    if (source.kind === 'pending') {
      serveInMemory(source.served);
      return;
    }
    const values = source.kind === 'read' ? source.values : {};
    currentValue = normalizeClientLocalPreferences(values);
    persisting = true;
    // A fresh profile writes nothing until a client-local save.
    if (hasAnyValue(values)) await persist(currentValue);
  }

  /** Serves `values` for this session only; the next launch retries. */
  function serveInMemory(values: Record<string, unknown>): void {
    currentValue = normalizeClientLocalPreferences(values);
    persisting = false;
  }

  /**
   * Replaces an unreadable document with `values`, in an order that loses
   * nothing at any crash point: damaged bytes are backed up first, the
   * rebuilt primary is durable before any slot is removed, and the stale
   * last-good and generation go last so the engine starts from the rebuilt
   * primary. A failed backup or install replaces nothing.
   */
  async function rebuild(
    document: PreferencesDocument,
    damaged: readonly SlotRead[],
    values: Record<string, unknown>,
  ): Promise<void> {
    const rebuilt = normalizeClientLocalPreferences(values);
    try {
      for (const slot of damaged) {
        if (slot.kind !== 'unreadable' || slot.text === null) continue;
        await document.installBackup(
          document.backupLocation(new Date().toISOString()),
          slot.text,
        );
      }
      await document.install(
        'primary',
        JSON.stringify({ version: 1, preferences: rebuilt }, null, 2),
      );
    } catch (error) {
      options.warn(
        'Client-local preferences could not be rebuilt; this session keeps them in memory.',
        error,
      );
      serveInMemory(rebuilt);
      return;
    }
    currentValue = rebuilt;
    persisting = true;
    try {
      await document.pruneBackups();
      for (const slot of ['lastGood', 'generation'] as const)
        await rm(document.slotPath(slot), { force: true });
    } catch (error) {
      options.warn(
        'Stale client-local preference files could not be removed.',
        error,
      );
    }
    // Records a generation and refreshes last-good through the engine.
    await persist(rebuilt);
  }

  async function prepare(): Promise<void> {
    const document = resolveDocument();
    const primary = await readSlot(document, 'primary');
    if (primary.kind === 'readable') {
      // Client wins once seeded.
      currentValue = await repository.read('persisted');
      persisting = true;
      return;
    }
    const lastGood = await readSlot(document, 'lastGood');
    if (primary.kind === 'missing' && lastGood.kind === 'missing') {
      await seed(await legacyRead());
      return;
    }
    // Seeded before, unreadable now: rebuild from the client's last-good,
    // else the domain's copy, never defaults while either exists. View state
    // carries no authority, so an unproven last-good is acceptable here.
    const source: LegacyClientLocalRead =
      lastGood.kind === 'readable'
        ? { kind: 'read', values: lastGood.payload }
        : await legacyRead();
    if (source.kind === 'pending') {
      // The domain gave no verdict: replace nothing, retry next launch.
      serveInMemory(source.served);
      return;
    }
    const values = source.kind === 'read' ? source.values : {};
    if (primary.kind === 'unreadable' && primary.text === null) {
      // Bytes that couldn't be read are no evidence to replace: serve the
      // source in memory and leave the file for the next launch.
      serveInMemory(values);
      return;
    }
    await rebuild(document, [primary, lastGood], values);
  }

  return {
    ready: (): Promise<void> => {
      preparation ??= prepare()
        .catch((error: unknown) => {
          options.warn(
            'Client-local preferences could not be prepared; this session keeps them in memory.',
            error,
          );
        })
        .finally(() => {
          prepared = true;
        });
      return preparation;
    },
    isReady: (): boolean => prepared,
    current: (): ClientLocalPreferences => currentValue,
    write: async (patch): Promise<ClientLocalPreferences> => {
      const next = normalizeClientLocalPreferences({
        ...currentValue,
        ...patch,
      });
      currentValue = next;
      if (persisting) await persist(next);
      return next;
    },
    flush: (): Promise<void> => repository.flush(),
    resetForTests: (): void => {
      repository.resetForTests();
      currentValue = CLIENT_LOCAL_PREFERENCES_CODEC.defaults;
      persisting = false;
      prepared = false;
      preparation = null;
    },
  };
}
