import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * Reuses a sidebar row's element while nothing it shows or does has changed
 * (CAN-8047), so React skips rendering it when the list around it renders
 * again. A paired computer's rows are unchanged by almost everything that
 * re-renders the sidebar here (this computer's own chats streaming, its own
 * snapshot refreshes), and rendering every one of them again froze the
 * window for 100 to 200 ms with a few hundred rows.
 *
 * The row's whole element tree is its key: every value in it is compared
 * except functions, so its data, selection, slots and nested elements all
 * count. Functions are replaced by stable stand-ins that call the newest
 * render's function at the same place in the tree, so a reused row's
 * handlers, refs and render props always reach the current ones. The row's
 * own subscriptions (its live status) still re-render it by themselves.
 *
 * Plain objects and arrays are compared by their contents; any other object
 * (a class instance, a DOM node, a ref object) by identity. A function prop
 * must be called, not rendered as a component class.
 */
export interface StableRowElements {
  /** `element`, or the row's previous element when nothing in it changed. */
  stabilize(key: string, element: ReactNode): ReactNode;
  /** Forgets every row not stabilized since the previous sweep. */
  sweep(): void;
}

type Callable = (...args: unknown[]) => unknown;

interface RowEntry {
  readonly latest: Map<string, unknown>;
  readonly standIns: Map<string, Callable>;
  signature: unknown;
  element: ReactNode;
  touched: boolean;
}

interface Stabilized {
  readonly value: unknown;
  readonly signature: unknown;
  /** Whether `value` differs from the input (it holds a stand-in). */
  readonly replaced: boolean;
}

const FUNCTION_SIGNATURE = Symbol('function');

/**
 * Signatures of plain data (records and arrays without functions), by
 * identity. Every paired row carries the same workspace object, so its
 * signature is built once, not once per row. The sidebar's snapshot data is
 * never changed in place, so an object's signature never goes stale.
 */
const dataSignatures = new WeakMap<object, Stabilized>();
/** Comparisons already made between two signature objects. */
const comparedSignatures = new WeakMap<object, WeakMap<object, boolean>>();

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `{ current }` is a ref: React writes to it, so its identity is what counts. */
function isRefObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'current';
}

function standInFor(entry: RowEntry, path: string): Callable {
  let standIn = entry.standIns.get(path);
  if (!standIn) {
    standIn = (...args: unknown[]): unknown => {
      const current = entry.latest.get(path);
      return typeof current === 'function'
        ? Reflect.apply(current, undefined, args)
        : undefined;
    };
    entry.standIns.set(path, standIn);
  }
  return standIn;
}

function stabilizeRecord(
  record: Record<string, unknown>,
  path: string,
  entry: RowEntry,
): {
  readonly value: Record<string, unknown>;
  readonly signature: Record<string, unknown>;
  readonly replaced: boolean;
} {
  const value: Record<string, unknown> = {};
  const signature: Record<string, unknown> = {};
  let replaced = false;
  for (const [key, item] of Object.entries(record)) {
    const result = stabilizeValue(item, `${path}.${key}`, entry);
    value[key] = result.value;
    signature[key] = result.signature;
    replaced ||= result.replaced;
  }
  return { value: replaced ? value : record, signature, replaced };
}

function stabilizeValue(
  value: unknown,
  path: string,
  entry: RowEntry,
): Stabilized {
  if (typeof value === 'function') {
    entry.latest.set(path, value);
    return {
      value: standInFor(entry, path),
      signature: FUNCTION_SIGNATURE,
      replaced: true,
    };
  }
  if (value === null || typeof value !== 'object')
    return { value, signature: value, replaced: false };
  if (isValidElement<Record<string, unknown>>(value)) {
    const props = stabilizeRecord(value.props, `${path}<>`, entry);
    return {
      value: props.replaced ? cloneWithProps(value, props.value) : value,
      signature: { type: value.type, key: value.key, props: props.signature },
      replaced: props.replaced,
    };
  }
  const known = dataSignatures.get(value);
  if (known) return known;
  let result: Stabilized;
  if (Array.isArray(value)) {
    const items = value.map((item: unknown, index) =>
      stabilizeValue(item, `${path}[${index}]`, entry),
    );
    const replaced = items.some((item) => item.replaced);
    result = {
      value: replaced ? items.map((item) => item.value) : value,
      signature: items.map((item) => item.signature),
      replaced,
    };
  } else if (isPlainRecord(value) && !isRefObject(value)) {
    result = stabilizeRecord(value, path, entry);
  } else {
    return { value, signature: value, replaced: false };
  }
  // A function anywhere inside has a stand-in of this row's own, at this
  // path, so only plain data is shared.
  if (!result.replaced) dataSignatures.set(value, result);
  return result;
}

/**
 * `element` with `props`. Several children pass as separate arguments, as
 * JSX passed them, so React keeps treating them as static children rather
 * than a list that needs keys.
 */
function cloneWithProps(
  element: ReactElement<Record<string, unknown>>,
  props: Record<string, unknown>,
): ReactElement {
  const { children, ...rest } = props;
  return isNodeList(children)
    ? cloneElement(element, rest, ...children)
    : cloneElement(element, props);
}

/** An element's children list: React nodes, as JSX passed them. */
function isNodeList(value: unknown): value is ReactNode[] {
  return Array.isArray(value);
}

function sameSignature(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  )
    return false;
  const known = comparedSignatures.get(a)?.get(b);
  if (known !== undefined) return known;
  const same = sameObjectSignature(a, b);
  let compared = comparedSignatures.get(a);
  if (!compared) {
    compared = new WeakMap();
    comparedSignatures.set(a, compared);
  }
  compared.set(b, same);
  return same;
}

function sameObjectSignature(a: object, b: object): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item: unknown, index) => sameSignature(item, b[index]))
    );
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        sameSignature(a[key], b[key]),
    )
  );
}

export function createStableRowElements(): StableRowElements {
  const entries = new Map<string, RowEntry>();
  return {
    stabilize(key, element): ReactNode {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          latest: new Map(),
          standIns: new Map(),
          signature: undefined,
          element: undefined,
          touched: false,
        };
        entries.set(key, entry);
      }
      entry.touched = true;
      // Always walked, so every stand-in reaches this render's function.
      const next = stabilizeValue(element, 'row', entry);
      if (
        entry.element !== undefined &&
        sameSignature(entry.signature, next.signature)
      )
        return entry.element;
      entry.signature = next.signature;
      entry.element = isValidElement(next.value) ? next.value : element;
      return entry.element;
    },
    sweep(): void {
      for (const [key, entry] of entries) {
        if (entry.touched) entry.touched = false;
        else entries.delete(key);
      }
    },
  };
}
