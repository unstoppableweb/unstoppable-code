import { BRAND } from '@canopy/brand/current';
import { StoreReadRunner } from './store-read-runner';
import type { StoreReadRequest } from './store-read-contract';
import type { DiscoveryDiagnostic } from './types';

/**
 * Plumbing shared by the SQLite-backed discovery adapters (T3 Code,
 * OpenCode): asking the store read worker for a snapshot and turning every
 * failure into a diagnostic, so wording and failure handling live in one place.
 */

export type SnapshotResult<T> =
  | { kind: 'ok'; snapshot: T }
  | { kind: 'absent' }
  | { kind: 'failed'; diagnostic: DiscoveryDiagnostic };

export interface StoreSnapshotSpec<T> {
  /** Diagnostic source for read failures; schema misses use `<source>-schema`. */
  source: string;
  /** The provider's name as the user knows it, for diagnostic messages. */
  label: string;
  /** Narrows the worker's untyped `data` before the adapter trusts it. */
  guard: (value: unknown) => value is T;
}

/** Asks the worker for a store snapshot and turns every failure into a diagnostic. */
export async function readStoreSnapshot<T>(
  runner: StoreReadRunner,
  request: StoreReadRequest,
  spec: StoreSnapshotSpec<T>,
): Promise<SnapshotResult<T>> {
  const { source, label, guard } = spec;
  let response;
  try {
    response = await runner.read(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: 'failed',
      diagnostic: {
        source,
        message: `The ${label} store could not be read (${reason}).`,
      },
    };
  }
  if (response.ok) {
    return guard(response.data)
      ? { kind: 'ok', snapshot: response.data }
      : {
          kind: 'failed',
          diagnostic: {
            source,
            message: `The ${label} store returned data in an unexpected shape.`,
          },
        };
  }
  if (response.code === 'missing') return { kind: 'absent' };
  if (response.code === 'schema') {
    return {
      kind: 'failed',
      diagnostic: {
        source: `${source}-schema`,
        message: `This version of ${label} stores chats in a layout ${BRAND.displayName} cannot read. Update ${label} and scan again. ${response.message}`,
      },
    };
  }
  return { kind: 'failed', diagnostic: { source, message: response.message } };
}

/**
 * Runs `fn` with the injected runner, or with one created for the call and
 * closed afterwards whether `fn` succeeds or not.
 */
export async function withStoreRunner<T>(
  injected: StoreReadRunner | undefined,
  fn: (runner: StoreReadRunner) => Promise<T>,
): Promise<T> {
  const runner = injected ?? new StoreReadRunner();
  try {
    return await fn(runner);
  } finally {
    if (!injected) await runner.close();
  }
}
