import type { PreferencesCodec } from '../../codec';
import { CLIENT_LOCAL_PREFERENCE_KEYS, preserveStoredKeys } from '../../index';
import {
  runStoredKeysConformance,
  StoredKeysConformanceFailure,
} from '../index';

interface StandIn {
  readonly fileAutoSave: boolean;
}

const STORED: Record<string, unknown> = Object.fromEntries(
  CLIENT_LOCAL_PREFERENCE_KEYS.map((key, index) => [key, { stored: index }]),
);

// The daemon-port case: a codec that knows nothing of the moved keys.
const dropsUnknownKeys: PreferencesCodec<StandIn> = {
  defaults: { fileAutoSave: false },
  normalize: (payload) => ({ fileAutoSave: payload.fileAutoSave === true }),
  project: (value) => ({ fileAutoSave: value.fileAutoSave }),
  inspect: () => null,
  merge: (existing, patch) => ({
    fileAutoSave: patch.fileAutoSave ?? existing.fileAutoSave,
  }),
};

// A codec that still defaults and passes through every moved key, as the
// desktop codec did before CAN-4472: the wrapper must override all of it.
const writesMovedKeys: PreferencesCodec<Record<string, unknown>> = {
  defaults: { fileAutoSave: false },
  normalize: (payload) => ({
    ...Object.fromEntries(
      CLIENT_LOCAL_PREFERENCE_KEYS.map((key) => [key, 'default']),
    ),
    ...payload,
  }),
  project: (value) => ({ ...value }),
  inspect: () => null,
  merge: (existing, patch) => ({ ...existing, ...patch, theme: 'default' }),
};

runStoredKeysConformance(
  { describe, it },
  'an inner codec that drops unknown keys',
  {
    inner: dropsUnknownKeys,
    keys: CLIENT_LOCAL_PREFERENCE_KEYS,
    storedValues: STORED,
    unrelatedPatch: { fileAutoSave: true },
  },
);

runStoredKeysConformance(
  { describe, it },
  'an inner codec that writes moved keys',
  {
    inner: writesMovedKeys,
    keys: CLIENT_LOCAL_PREFERENCE_KEYS,
    storedValues: STORED,
    unrelatedPatch: { fileAutoSave: true },
  },
);

describe('the kit itself', () => {
  it('fails a format conversion that loses a stored key (G13)', async () => {
    const failures: unknown[] = [];
    const cases: Array<() => Promise<void>> = [];
    runStoredKeysConformance(
      {
        describe: (_name, body) => body(),
        it: (name, body) => {
          if (name.includes('G13')) cases.push(body);
        },
      },
      'a lossy conversion',
      {
        inner: dropsUnknownKeys,
        keys: CLIENT_LOCAL_PREFERENCE_KEYS,
        storedValues: STORED,
        unrelatedPatch: { fileAutoSave: true },
        convertFormat: (stored) => {
          const converted = { ...stored };
          delete converted.theme;
          return converted;
        },
      },
    );
    expect(cases).toHaveLength(1);
    for (const run of cases) {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(StoredKeysConformanceFailure);
  });

  it('the wrapper keeps the inner defaults and inspection', () => {
    const codec = preserveStoredKeys(
      dropsUnknownKeys,
      CLIENT_LOCAL_PREFERENCE_KEYS,
    );
    expect(codec.defaults).toBe(dropsUnknownKeys.defaults);
    expect(codec.inspect({})).toBeNull();
  });
});
