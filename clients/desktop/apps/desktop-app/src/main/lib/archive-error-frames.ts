import { appErrorNativeFrames } from '@canopy/protocol/app-errors/native-frames';

const restoredFrames = new WeakMap<object, readonly string[]>();

/** V8 source locations are the explicit exception to archive detail filtering. */
export function isArchiveErrorFrame(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\s+at /.test(value) && !/[\r\n]/.test(value)
  );
}

/**
 * V8 call sites for a native error, never lines parsed from its formatted
 * stack: a message (for example Git stderr) can contain frame-shaped text.
 * Empty once something formatted the stack before this was called.
 */
export function archiveErrorFrames(error: unknown): string[] {
  return appErrorNativeFrames(error).filter(isArchiveErrorFrame);
}

export function archiveErrorWithFrames(
  message: string,
  frames: readonly string[],
): Error {
  const error = new Error(message);
  const acceptedFrames = Object.freeze(frames.filter(isArchiveErrorFrame));
  restoredFrames.set(error, acceptedFrames);
  error.stack = [error.toString(), ...acceptedFrames].join('\n');
  return error;
}

/** Read only the snapshot supplied at reconstruction, never a later stack edit. */
export function restoredArchiveErrorFrames(
  error: unknown,
): readonly string[] | undefined {
  return typeof error === 'object' && error !== null
    ? restoredFrames.get(error)
    : undefined;
}
