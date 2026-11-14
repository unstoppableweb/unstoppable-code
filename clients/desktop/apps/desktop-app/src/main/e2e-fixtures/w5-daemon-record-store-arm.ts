import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5RecordAuthorityOptions } from '@canopy/core-runtime/node/w5/record-port';
import { isE2eBuild } from '../lib/e2e-gate';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import { markE2eStartup } from '../lib/e2e-startup-marks';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../lib/w5-daemon-record-store';
import { countingW5HostPort } from '../lib/w5-work-counters';
import { startW5RecordPortLoopback } from './w5-record-port-loopback';

/*
 * CAN-5532 (B6): the W5 store arm of a desktop performance launch, chosen by
 * `CANOPY_PERFORMANCE_W5_STORE` in E2E builds only. `in-process` is the
 * shipped store; main loads this module for either explicit selection so
 * a flip build refuses both arms. An unset selection loads no module.
 * `daemon-record-port` installs the daemon-backed store over the record-port
 * loopback, whose authority decides on this process's own commit-log host:
 * the qualification composition, with no socket and no daemon process.
 *
 * Without daemon-owned storage rows the authority refuses every W5 write as
 * `daemon`; each refusal is a typed failure the `w5` work counters name
 * (`port.commit.refused.writeRefused.<reason>`), never a fallback write.
 */

export const W5_STORE_ARMS = ['in-process', 'daemon-record-port'] as const;
export type W5StoreArm = (typeof W5_STORE_ARMS)[number];

export function isW5StoreArm(value: unknown): value is W5StoreArm {
  return W5_STORE_ARMS.some((arm) => arm === value);
}

/** The options the arm's record-port authority is built from. */
export function w5StoreArmAuthorityOptions(
  host: W5CommitLogHostPort,
): W5RecordAuthorityOptions {
  return { host };
}

export interface W5StoreArmHandle {
  readonly arm: W5StoreArm;
  /**
   * Closes the loopback at quit, after every W5 writer drained. The store
   * stays installed, so a late call fails instead of reaching another store.
   */
  shutdown(): Promise<void>;
  /** Jest only: restores admission routing and the retry bound. */
  restore(): void;
}

export type W5StoreArmStart =
  | { readonly handle: W5StoreArmHandle | null }
  | { readonly refusal: string };

/** {@link installW5StoreArm}, with a failure as the message main exits with. */
export async function startW5StoreArm(arm: string): Promise<W5StoreArmStart> {
  try {
    return { handle: await installW5StoreArm(arm) };
  } catch (error) {
    return {
      refusal: `The W5 store arm did not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Installs `arm` as desktop main's W5 store before any W5 I/O. Resolves once
 * the authority answered its recovery read, the `w5StoreReady` mark; null for
 * the in-process arm. Refuses outside E2E builds, on flip builds and for an
 * unknown arm.
 */
export async function installW5StoreArm(
  arm: string,
  getHost?: () => W5CommitLogHostPort,
): Promise<W5StoreArmHandle | null> {
  if (!isE2eBuild())
    throw new Error('The W5 store arm exists only in E2E builds.');
  if (!isW5StoreArm(arm))
    throw new Error(
      `Unknown W5 store arm "${arm}"; expected ${W5_STORE_ARMS.join(' or ')}.`,
    );
  if (isW5DaemonFlipCompiled())
    throw new Error(
      'The W5 store performance arm cannot run on a W5 flip build; the startup handoff owns the store.',
    );
  if (arm === 'in-process') return null;
  if (!getHost)
    throw new Error(
      'An explicit test host is required; ordinary in-process hosting is retired.',
    );
  const loopback = await startW5RecordPortLoopback(
    w5StoreArmAuthorityOptions(countingW5HostPort(getHost())),
  );
  try {
    const transport = w5RecordPortTransport(
      await loopback.connect('electron-main'),
    );
    // Recovered before install, so a failed attempt leaves no store behind.
    await transport.recovery();
    const restore = installW5DaemonRecordStoreForTests(
      createW5DaemonRecordStore({ transport }),
    );
    markE2eStartup('w5StoreReady');
    return { arm, shutdown: () => loopback.close(), restore };
  } catch (error) {
    await loopback.close().catch(() => undefined);
    throw error;
  }
}
