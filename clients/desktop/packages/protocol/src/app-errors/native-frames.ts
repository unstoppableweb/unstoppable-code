// Leaf module: no dependencies, so worker bundles (archive I/O) can use it
// without pulling the app-error handler and its schemas.

/** V8 can attach a native stack accessor to objects without the Error brand. */
export function hasNativeErrorBrand(value: unknown): value is Error {
  try {
    const isError: unknown = Reflect.get(Error, 'isError');
    return (
      typeof isError === 'function' &&
      Reflect.apply(isError, Error, [value]) === true
    );
  } catch {
    return false;
  }
}

const nativeFrames = new WeakMap<object, readonly string[]>();
const STACK_FORMATTER = 'prepareStackTrace';

function ownStackGetter(error: Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
  return descriptor && Reflect.get(descriptor, 'get');
}

const readV8Stack = ownStackGetter(new Error());

/** Remember only frames supplied by V8 before it caches the formatted stack. */
export function rememberAppErrorNativeFrames(error: unknown): void {
  try {
    if (!hasNativeErrorBrand(error) || nativeFrames.has(error)) return;
    nativeFrames.set(error, []);
    if (
      typeof readV8Stack !== 'function' ||
      typeof ownStackGetter(error) !== 'function'
    )
      return;
    const previous = Object.getOwnPropertyDescriptor(Error, STACK_FORMATTER);
    if (previous && !('value' in previous)) return;
    const format: unknown = Reflect.get(Error, STACK_FORMATTER);
    const capture = (
      target: Error,
      sites: readonly { toString(): string }[],
    ): unknown => {
      const lines = sites.map((site) => `    at ${site.toString()}`);
      if (target === error) {
        nativeFrames.set(
          error,
          lines.filter((line) => !/[\r\n]/.test(line)),
        );
      }
      return typeof format === 'function'
        ? Reflect.apply(format, Error, [target, sites])
        : [Error.prototype.toString.call(target), ...lines].join('\n');
    };
    if (
      !Reflect.defineProperty(Error, STACK_FORMATTER, {
        ...previous,
        value: capture,
        configurable: true,
      })
    )
      return;
    try {
      // Use our intrinsic even when the Error comes from another V8 realm.
      // Only V8 calling the formatter for this object proves its frames.
      Reflect.apply(readV8Stack, error, []);
    } finally {
      if (previous) Object.defineProperty(Error, STACK_FORMATTER, previous);
      else Reflect.deleteProperty(Error, STACK_FORMATTER);
    }
  } catch {
    // Hostile or unavailable stack access must not prevent recording.
  }
}

/** V8 frames for a native error; empty once something formatted its stack. */
export function appErrorNativeFrames(error: unknown): readonly string[] {
  rememberAppErrorNativeFrames(error);
  return typeof error === 'object' && error !== null
    ? (nativeFrames.get(error) ?? [])
    : [];
}

/** Frames already remembered for this error, without capturing new ones. */
export function rememberedAppErrorNativeFrames(
  error: object,
): readonly string[] | undefined {
  return nativeFrames.get(error);
}
