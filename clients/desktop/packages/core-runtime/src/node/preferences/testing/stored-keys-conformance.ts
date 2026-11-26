import { isDeepStrictEqual } from 'node:util';
import type { PreferencesCodec, PreferencesMergeContext } from '../codec';
import type { PreferencesDocument, PreferencesDocumentSlot } from '../document';
import {
  createPreferencesRepository,
  type PreferencesRepository,
} from '../repository';
import {
  preserveStoredKeys,
  type WithStoredKeys,
} from '../preserve-stored-keys';

export interface StoredKeysConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

export class StoredKeysConformanceFailure extends Error {
  override readonly name = 'StoredKeysConformanceFailure';
}

export interface StoredKeysConformanceOptions<
  T extends object,
  K extends string,
> {
  /** The domain codec the wrapper composes, desktop or daemon. */
  readonly inner: PreferencesCodec<T>;
  readonly keys: readonly K[];
  /** A value for every key, as an older build stored them. */
  readonly storedValues: Readonly<Record<string, unknown>>;
  /** A patch of one key outside `keys` that the inner codec accepts. */
  readonly unrelatedPatch: Partial<T>;
  /**
   * The format conversion a later owner ships (CAN-5722): the stored
   * preferences record in, the record it writes out. Without one the case
   * checks a re-save through the wrapped codec.
   */
  readonly convertFormat?: (
    stored: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new StoredKeysConformanceFailure(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function keysOf(
  value: object,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys)
    if (hasOwn(value, key)) picked[key] = Reflect.get(value, key);
  return picked;
}

function sameKeys(
  value: object,
  expected: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  message: string,
): void {
  const actual = keysOf(value, keys);
  check(
    isDeepStrictEqual(actual, { ...expected }),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function noKeys(value: object, keys: readonly string[], message: string): void {
  const present = keys.filter((key) => hasOwn(value, key));
  check(present.length === 0, `${message}: found ${present.join(', ')}`);
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

const missing = (): Error =>
  Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/** An in-memory document: the slots and backups, nothing else. */
class MemoryDocument implements PreferencesDocument {
  readonly slots = new Map<PreferencesDocumentSlot, string>();
  readonly backups = new Map<string, string>();
  readonly key = 'stored-keys-conformance';
  readText(slot: PreferencesDocumentSlot): Promise<string> {
    const value = this.slots.get(slot);
    return value === undefined
      ? Promise.reject(missing())
      : Promise.resolve(value);
  }
  exists(slot: 'primary' | 'lastGood'): Promise<boolean> {
    return Promise.resolve(this.slots.has(slot));
  }
  install(slot: PreferencesDocumentSlot, content: string): Promise<void> {
    this.slots.set(slot, content);
    return Promise.resolve();
  }
  ensureFolder(): Promise<void> {
    return Promise.resolve();
  }
  slotPath(slot: PreferencesDocumentSlot): string {
    return `${this.key}/${slot}`;
  }
  backupLocation(stamp: string): string {
    return `${this.key}/backup-${stamp}`;
  }
  installBackup(location: string, content: string): Promise<void> {
    this.backups.set(location, content);
    return Promise.resolve();
  }
  pruneBackups(): Promise<void> {
    return Promise.resolve();
  }
  storedPreferences(): Record<string, unknown> {
    const text = this.slots.get('primary');
    check(text !== undefined, 'the primary document must exist');
    const parsed: unknown = JSON.parse(text);
    check(
      isObject(parsed) && isObject(parsed.preferences),
      'the primary document must hold a preferences record',
    );
    return parsed.preferences;
  }
}

const CONTEXT: PreferencesMergeContext = {
  loadError: null,
  migrationTimestamp: () => '2026-11-25T00:00:00.000Z',
};

/**
 * The stored-keys contract a domain codec must keep once wrapped with
 * `preserveStoredKeys` (CAN-4472): every read, write, recovery and format
 * conversion keeps the stored copy of `keys` exactly and never adds one.
 * Run it over each inner codec; the daemon's port runs it over its own.
 */
export function runStoredKeysConformance<T extends object, K extends string>(
  api: StoredKeysConformanceTestApi,
  name: string,
  options: StoredKeysConformanceOptions<T, K>,
): void {
  const { keys, storedValues } = options;
  const codec = preserveStoredKeys(options.inner, keys);
  type Stored = WithStoredKeys<T, K>;
  /** Every key with a value no stored document holds. */
  const changed = (): Partial<Stored> => {
    const patch: Partial<Stored> = {};
    for (const key of keys) Reflect.set(patch, key, `changed-${key}`);
    return patch;
  };
  const withChanged = (patch: Partial<T>): Partial<Stored> => ({
    ...patch,
    ...changed(),
  });
  const defaults = toRecord(options.inner.defaults);
  const storedPayload = (): Record<string, unknown> => ({
    ...defaults,
    ...storedValues,
  });
  const open = (document: MemoryDocument): PreferencesRepository<Stored> =>
    createPreferencesRepository({
      document: () => document,
      codec,
      log: { error: (): void => undefined },
    });
  const seededDocument = (): MemoryDocument => {
    const document = new MemoryDocument();
    document.slots.set(
      'primary',
      JSON.stringify({ version: 1, preferences: storedPayload() }),
    );
    return document;
  };

  api.describe(`${name}: stored client-local keys`, () => {
    api.it(
      'reads keep every stored key exactly in both views, and add none',
      () => {
        for (const view of ['persisted', 'runtime'] as const) {
          const read = codec.normalize(storedPayload(), view);
          sameKeys(read, storedValues, keys, `normalize(${view})`);
          sameKeys(codec.project(read), storedValues, keys, 'project');
          noKeys(
            codec.normalize({ ...defaults }, view),
            keys,
            `normalize(${view}) without stored keys`,
          );
        }
        noKeys(codec.defaults, keys, 'defaults');
        return Promise.resolve();
      },
    );

    api.it(
      'a merge never takes a key from a patch and never drops the stored copy',
      () => {
        const existing = codec.normalize(storedPayload(), 'persisted');
        const next = codec.merge(
          existing,
          withChanged(options.unrelatedPatch),
          CONTEXT,
        );
        sameKeys(next, storedValues, keys, 'merge over a stored copy');
        const fresh = codec.normalize({}, 'persisted');
        noKeys(
          codec.merge(fresh, changed(), CONTEXT),
          keys,
          'merge without a stored copy',
        );
        return Promise.resolve();
      },
    );

    api.it(
      'every repository write keeps the stored copy, recovery included',
      async () => {
        const document = seededDocument();
        const repository = open(document);
        await repository.update(() => options.unrelatedPatch);
        sameKeys(document.storedPreferences(), storedValues, keys, 'save');
        await repository.update(() => ({}));
        sameKeys(
          document.storedPreferences(),
          storedValues,
          keys,
          'empty save',
        );
        await repository.update(() => changed());
        sameKeys(
          document.storedPreferences(),
          storedValues,
          keys,
          'save of the keys themselves',
        );
        await repository.stampGeneration();
        await repository.flush();
        sameKeys(document.storedPreferences(), storedValues, keys, 'stamp');

        // A damaged primary recovers from last-good with the copy intact.
        document.slots.set('primary', '{ not json');
        const recovered = open(document);
        sameKeys(
          await recovered.read('persisted'),
          storedValues,
          keys,
          'recovered read',
        );
        check(!recovered.isRecoveryLatched(), 'recovery must not latch');
        sameKeys(
          document.storedPreferences(),
          storedValues,
          keys,
          'recovered primary',
        );
      },
    );

    api.it('a document without the keys never gains them', async () => {
      const document = new MemoryDocument();
      const repository = open(document);
      await repository.update(() => withChanged(options.unrelatedPatch));
      await repository.update(() => changed());
      await repository.stampGeneration();
      await repository.flush();
      noKeys(document.storedPreferences(), keys, 'fresh document');
      noKeys(await repository.read('runtime'), keys, 'fresh read');
    });

    api.it(
      'a format conversion keeps the stored keys deep-equal (G13)',
      async () => {
        const convert =
          options.convertFormat ??
          ((stored: Record<string, unknown>): Record<string, unknown> =>
            codec.merge(codec.normalize(stored, 'persisted'), {}, CONTEXT));
        const converted = await convert(storedPayload());
        sameKeys(converted, storedValues, keys, 'converted record');
      },
    );
  });
}
