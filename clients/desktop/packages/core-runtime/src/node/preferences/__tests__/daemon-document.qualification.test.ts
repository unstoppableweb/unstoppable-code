import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { StorageWriteRefusedError } from '../../../storage';
import { StorageRowOwnerError } from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import { ownerFlipRecordFile } from '../../storage-records';
import type { PreferencesCodec } from '../codec';
import {
  createDaemonPreferences,
  type DaemonPreferencesOptions,
} from '../daemon-document';
import { CLIENT_LOCAL_PREFERENCE_KEYS, createPreferencesRepository } from '..';
import { runStoredKeysConformance } from '../testing';
import { MemoryPreferencesDocument } from './fixtures/memory-document';

const USAGE = ['productAnalytics', 'errorReports'] as const;
type Usage = (typeof USAGE)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = isObject(payload.usageData) ? payload.usageData : {};
  return {
    ...payload,
    fileAutoSave: payload.fileAutoSave === true,
    usageData: Object.fromEntries(
      USAGE.map((key) => [key, usage[key] !== false]),
    ),
  };
}

/** A stand-in domain codec that passes every key through, the moved ones included. */
const codec: PreferencesCodec<Record<string, unknown>> = {
  defaults: normalize({}),
  normalize,
  project: (value) => normalize(value),
  inspect: () => null,
  merge: (existing, patch) => normalize({ ...existing, ...patch }),
};

/** The compiled rows with the preferences row flipped to the daemon. */
const FLIPPED = STORAGE_OWNERSHIP.map((row) =>
  row.id === 'preferences'
    ? { ...row, transitionOwner: 'daemon' as const }
    : row,
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-preferences-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function open(
  at: string,
  overrides: Partial<DaemonPreferencesOptions<Usage>> = {},
): ReturnType<typeof createDaemonPreferences> {
  return createDaemonPreferences({
    dataRoot: at,
    codec,
    usageDataKeys: USAGE,
    syncDirectory: () => Promise.resolve('flushed'),
    ownership: FLIPPED,
    log: { error: jest.fn() },
    ...overrides,
  });
}

const primary = (at: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(at, 'preferences.json'), 'utf8'),
  );
  if (!isObject(parsed)) throw new Error('primary is not a record');
  return parsed;
};

const seed = (at: string, preferences: Record<string, unknown>): void =>
  writeFileSync(
    join(at, 'preferences.json'),
    JSON.stringify({ version: 1, preferences }),
  );

describe('daemon preference module (CAN-7956): admission', () => {
  it('under the compiled rows refuses every write before any byte', async () => {
    const onUsageDataDenied = jest.fn();
    const { repository } = open(root, {
      ownership: STORAGE_OWNERSHIP,
      onUsageDataDenied,
    });
    await expect(
      repository.update(() => ({ fileAutoSave: true })),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
    // A denial would be journaled and applied first; it is refused too.
    await expect(
      repository.update(() => ({ usageData: { errorReports: false } })),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
    expect(onUsageDataDenied).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);

    seed(root, { fileAutoSave: false });
    const before = readFileSync(join(root, 'preferences.json'), 'utf8');
    await expect(
      repository.update(() => ({ fileAutoSave: true })),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
    expect(readFileSync(join(root, 'preferences.json'), 'utf8')).toBe(before);
    expect(readdirSync(root)).toEqual(['preferences.json']);
    // Reads stay open.
    await expect(repository.read('runtime')).resolves.toMatchObject({
      fileAutoSave: false,
    });
  });

  it('refuses while the row owner record cannot be read, even when flipped', async () => {
    const record = ownerFlipRecordFile(root, 'preferences');
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, '{ not json');
    const { repository } = open(root);
    await expect(
      repository.update(() => ({ fileAutoSave: true })),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
    expect(existsSync(join(root, 'preferences.json'))).toBe(false);
  });

  it('once flipped, saves the family durably at the write version', async () => {
    const syncDirectory = jest.fn(() => Promise.resolve('flushed' as const));
    const { repository } = open(root, { syncDirectory });
    await repository.update(() => ({ fileAutoSave: true }));
    expect(primary(root)).toMatchObject({
      version: 1,
      generation: 1,
      preferences: { fileAutoSave: true },
    });
    expect(syncDirectory).toHaveBeenCalledWith(root);

    const v2 = open(root, { writeVersion: 2 }).repository;
    await v2.update(() => ({ fileAutoSave: false }));
    expect(primary(root)).toMatchObject({ version: 2, generation: 2 });
    expect(() => open(root, { writeVersion: 3 })).toThrow(RangeError);
  });
});

describe('daemon preference module (CAN-7956): repository write version (T23)', () => {
  it('defaults to the envelope write version and writes a readable one when asked', async () => {
    const written = async (writeVersion?: number): Promise<unknown> => {
      const document = new MemoryPreferencesDocument();
      await createPreferencesRepository({
        document: () => document,
        codec,
        log: { error: jest.fn() },
        ...(writeVersion !== undefined && { writeVersion }),
      }).update(() => ({ fileAutoSave: true }));
      const text = document.slots.get('primary');
      return text === undefined
        ? undefined
        : Reflect.get(JSON.parse(text), 'version');
    };
    await expect(written()).resolves.toBe(1);
    await expect(written(2)).resolves.toBe(2);
    expect(() =>
      createPreferencesRepository({
        document: () => new MemoryPreferencesDocument(),
        codec,
        log: { error: jest.fn() },
        writeVersion: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('daemon preference module (CAN-7956): usage-data consent journal', () => {
  it('journals a revocation before the primary and applies it to the live policy', async () => {
    const onUsageDataDenied = jest.fn();
    // The journal precedes the save's folder step, so it creates the folder.
    const at = join(root, 'not-yet', 'data');
    const { repository } = open(at, { onUsageDataDenied });
    await repository.update(() => ({ usageData: { errorReports: false } }));
    expect(
      JSON.parse(
        readFileSync(
          join(at, 'preferences.json.usage-data-denied.json'),
          'utf8',
        ),
      ),
    ).toEqual(['errorReports']);
    expect(primary(at)).toMatchObject({
      preferences: { usageData: { errorReports: false } },
    });
    expect(onUsageDataDenied).toHaveBeenCalledWith(['errorReports']);
  });

  it('a journaled denial overrides the document and lifts only after an allowing save', async () => {
    seed(root, { usageData: { productAnalytics: true, errorReports: true } });
    const journal = join(root, 'preferences.json.usage-data-denied.json');
    writeFileSync(journal, JSON.stringify(['productAnalytics']));
    const { repository } = open(root);
    await expect(repository.read('runtime')).resolves.toMatchObject({
      usageData: { productAnalytics: false, errorReports: true },
    });
    await repository.update(() => ({
      usageData: { productAnalytics: true, errorReports: true },
    }));
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual([]);
    await expect(repository.read('runtime')).resolves.toMatchObject({
      usageData: { productAnalytics: true },
    });

    // An unreadable journal denies every flow.
    writeFileSync(journal, '{ damaged');
    await expect(open(root).repository.read('runtime')).resolves.toMatchObject({
      usageData: { productAnalytics: false, errorReports: false },
    });
  });
});

const STORED = Object.fromEntries(
  CLIENT_LOCAL_PREFERENCE_KEYS.map((key, index) => [key, { stored: index }]),
);

// The prior cases over the daemon's own document: the conversion is a daemon
// save, at envelope version 2, of what an older build stored at version 1.
runStoredKeysConformance(
  { describe, it },
  'daemon preference module (CAN-7956)',
  {
    inner: codec,
    keys: CLIENT_LOCAL_PREFERENCE_KEYS,
    storedValues: STORED,
    unrelatedPatch: { fileAutoSave: true },
    convertFormat: async (stored) => {
      const at = mkdtempSync(join(tmpdir(), 'daemon-preferences-convert-'));
      try {
        seed(at, stored);
        await open(at, { writeVersion: 2 }).repository.update(() => ({
          fileAutoSave: true,
        }));
        const converted = primary(at).preferences;
        if (!isObject(converted)) throw new Error('no converted record');
        return converted;
      } finally {
        rmSync(at, { recursive: true, force: true });
      }
    },
  },
);
