import type { PreferencesCodec } from './codec';

/** A document value with a frozen copy of whatever it stored for `K`. */
export type WithStoredKeys<T extends object, K extends string> = T &
  Partial<Record<K, unknown>>;

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

/**
 * Wraps a document codec so that `keys` keep exactly the values the stored
 * document holds (CAN-4472). No read, recovery, migration or save can change
 * them, add them where the document has none, or default them: a patch's
 * values for them are dropped, and whatever the inner codec does with them is
 * replaced by the stored copy. Users who skip releases keep the copy for
 * whichever build seeds from it, in any order of writers.
 */
export function preserveStoredKeys<T extends object, K extends string>(
  inner: PreferencesCodec<T>,
  keys: readonly K[],
): PreferencesCodec<WithStoredKeys<T, K>> {
  function withStored(value: T, stored: object): WithStoredKeys<T, K> {
    const result: WithStoredKeys<T, K> = { ...value };
    for (const key of keys) {
      if (hasOwn(stored, key)) {
        result[key] = Reflect.get(stored, key);
      } else {
        delete result[key];
      }
    }
    return result;
  }
  function withoutKeys(patch: Partial<WithStoredKeys<T, K>>): Partial<T> {
    const result: Partial<WithStoredKeys<T, K>> = { ...patch };
    for (const key of keys) delete result[key];
    return result;
  }
  return {
    defaults: inner.defaults,
    normalize: (payload, view) =>
      withStored(inner.normalize(payload, view), payload),
    project: (value) => withStored(inner.project(value), value),
    inspect: (payload) => inner.inspect(payload),
    merge: (existing, patch, context) =>
      withStored(inner.merge(existing, withoutKeys(patch), context), existing),
  };
}
