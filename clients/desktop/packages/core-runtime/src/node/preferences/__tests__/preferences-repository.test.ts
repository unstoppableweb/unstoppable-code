import { StorageOutcomeUnknownError } from '../../../storage';
import { createPreferencesRepository, type PreferencesCodec } from '..';
import { MemoryPreferencesDocument } from './fixtures/memory-document';

interface Value {
  count: number;
  tags: string[];
}

const codec: PreferencesCodec<Value> = {
  defaults: { count: 0, tags: [] },
  normalize: (payload) => ({
    count: Number(payload.count ?? 0),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
  }),
  project: (value) => value,
  inspect: () => null,
  merge: (existing, patch) => ({ ...existing, ...patch }),
};
const envelope = (count: number, generation: number): string =>
  JSON.stringify({ version: 1, generation, preferences: { count, tags: [] } });
const record = (generation: number): string =>
  JSON.stringify({ version: 1, generation });
const repository = (
  document: MemoryPreferencesDocument,
): ReturnType<typeof createPreferencesRepository<Value>> =>
  createPreferencesRepository({
    document: () => document,
    codec,
    log: { error: jest.fn() },
  });

describe('preference repository qualification (CAN-4471)', () => {
  it('serializes concurrent updates without losing either change', async () => {
    const document = new MemoryPreferencesDocument();
    const store = repository(document);
    await Promise.all([
      store.update((latest) => ({ count: latest.count + 1 })),
      store.update(() => ({ tags: ['a'] })),
    ]);
    await store.flush();
    expect(JSON.parse(document.slots.get('primary') ?? '')).toEqual({
      version: 1,
      generation: 2,
      preferences: { count: 1, tags: ['a'] },
    });
  });

  it('restores a current last-good over a corrupt primary, keeping the corrupt bytes first', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('primary', '{');
    const lastGood = envelope(3, 3);
    document.slots.set('lastGood', lastGood);
    document.slots.set('generation', record(3));
    const store = repository(document);
    await expect(store.read('persisted')).resolves.toEqual({
      count: 3,
      tags: [],
    });
    expect(document.installs.map(({ slot }) => slot)).toEqual([
      'backup',
      'primary',
    ]);
    expect(JSON.parse(document.installs[0]?.content ?? '')).toMatchObject({
      rawContent: '{',
    });
    expect(document.slots.get('lastGood')).toBe(lastGood);
    expect(store.peekLoadError()?.restoredFromPath).toBe(
      document.slotPath('lastGood'),
    );
  });

  it('never restores a last-good behind the generation record', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('primary', '{');
    document.slots.set('lastGood', envelope(4, 4));
    document.slots.set('generation', record(5));
    const onRecoveryLatched = jest.fn();
    const store = createPreferencesRepository({
      document: () => document,
      codec,
      log: { error: jest.fn() },
      hooks: { onRecoveryLatched },
    });
    await expect(store.read('persisted')).resolves.toEqual({
      count: 4,
      tags: [],
    });
    await expect(store.update(() => ({ count: 5 }))).rejects.toMatchObject({
      code: 'PREFERENCES_RECOVERY_REQUIRED',
    });
    expect(document.installs).toEqual([]);
    expect(store.isRecoveryLatched()).toBe(true);
    expect(onRecoveryLatched).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed recovery latched after its notice is acknowledged', async () => {
    const document = new MemoryPreferencesDocument();
    document.slots.set('primary', '{');
    const store = repository(document);
    await expect(store.read('runtime')).resolves.toBe(codec.defaults);
    expect(store.isRecoveryLatched()).toBe(true);
    // Acknowledging the notice clears the load error, not the latch.
    store.acknowledgeLoadError();
    expect(store.isRecoveryLatched()).toBe(true);
  });

  it('never writes over a newer-version primary', async () => {
    const document = new MemoryPreferencesDocument();
    // Version 2 is readable since CAN-7925; 3 is the first unknown version.
    const primary = JSON.stringify({ version: 3, preferences: {} });
    document.slots.set('primary', primary);
    document.slots.set('lastGood', envelope(3, 3));
    document.slots.set('generation', record(3));
    const store = repository(document);
    await store.read('persisted');
    await expect(store.readAuthority()).resolves.toMatchObject({
      authority: 'unreadable',
    });
    expect(document.installs).toEqual([]);
    expect(document.slots.get('primary')).toBe(primary);
  });

  it('starts fresh without writing when primary and last-good are missing', async () => {
    const document = new MemoryPreferencesDocument();
    const store = repository(document);
    await expect(store.read('persisted')).resolves.toBe(codec.defaults);
    await expect(store.readAuthority()).resolves.toEqual({
      preferences: codec.defaults,
      authority: 'absent',
    });
    expect(document.installs).toEqual([]);
  });

  it('a failed generation record write leaves the primary untouched', async () => {
    const document = new MemoryPreferencesDocument();
    const primary = envelope(1, 1);
    document.slots.set('primary', primary);
    document.slots.set('generation', record(1));
    document.installFailures.set('generation', new Error('record failed'));
    const onSaveDurable = jest.fn();
    const afterSave = jest.fn();
    const store = createPreferencesRepository({
      document: () => document,
      codec,
      log: { error: jest.fn() },
      hooks: { onSaveDurable, afterSave },
    });
    await expect(store.update(() => ({ count: 2 }))).rejects.toThrow(
      'record failed',
    );
    expect(document.slots.get('primary')).toBe(primary);
    expect(document.installs.map(({ slot }) => slot)).toEqual(['generation']);
    expect(onSaveDurable).not.toHaveBeenCalled();
    expect(afterSave).not.toHaveBeenCalled();
  });

  it('tracks the save from its record write and reports an unknown primary outcome', async () => {
    const document = new MemoryPreferencesDocument();
    const held = document.holdInstall('generation');
    const unknown = new StorageOutcomeUnknownError(
      'directory_flush',
      new Error('flush failed'),
      'preferences',
    );
    document.installFailures.set('primary', unknown);
    const trackSave = jest.fn((save: Promise<void>): Promise<void> => save);
    const onSaveOutcomeUnknown = jest.fn();
    const store = createPreferencesRepository({
      document: () => document,
      codec,
      log: { error: jest.fn() },
      hooks: { trackSave, onSaveOutcomeUnknown },
    });
    const update = store.update(() => ({ count: 1 }));
    const rejected = expect(update).rejects.toBe(unknown);
    await held.started;
    expect(trackSave).toHaveBeenCalledTimes(1);
    expect(onSaveOutcomeUnknown).not.toHaveBeenCalled();
    held.release();
    await rejected;
    expect(onSaveOutcomeUnknown).toHaveBeenCalledWith({
      previous: codec.defaults,
      next: { count: 1, tags: [] },
    });
  });

  it('commit observers run inside the queue before the next update reads', async () => {
    const document = new MemoryPreferencesDocument();
    const order: string[] = [];
    const store = createPreferencesRepository({
      document: () => document,
      codec,
      log: { error: jest.fn() },
      hooks: {
        onCommitted: (next) => {
          order.push(`committed-${next.count}`);
        },
      },
    });
    const first = store.update(
      () => ({ count: 1 }),
      () => {
        order.push('observer-1');
      },
    );
    const second = store.update((latest) => {
      order.push(`updater-${latest.count + 1}`);
      return { count: latest.count + 1 };
    });
    await Promise.all([first, second]);
    await store.flush();
    expect(order).toEqual([
      'committed-1',
      'observer-1',
      'updater-2',
      'committed-2',
    ]);
  });
});
