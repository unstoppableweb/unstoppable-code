import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { extractIpcErrorMessage } from './errors';

/**
 * The shared sections show thrown messages verbatim; drop Electron's IPC
 * wrapper. A rejection main already recorded keeps that record as the new
 * error's `appError`, so the surface showing it links to the record instead of
 * recording the failure again.
 */
export async function withIpcErrorMessage<T>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const appError = toAppError(resolveClientAppError(error));
    throw Object.assign(
      new Error(extractIpcErrorMessage(error)),
      appError?.recordedBy === undefined ? {} : { appError },
    );
  }
}
