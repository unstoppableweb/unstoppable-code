import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExecutionWakeLock,
  type PlatformOperatingSystem,
  type PlatformPowerServices,
  WakeLockPolicy,
} from '@canopy/core-runtime';
import { readDesktopPreferencesRecord } from '@canopy/core-runtime/node';

/*
 * The daemon's wake lock (CAN-5872): the CAN-5066 core holder policy over
 * the daemon's gated power port, so a workflow running in the daemon keeps
 * the computer out of idle sleep while keep awake is on, after the app
 * quits too. Electron main still holds its own while it follows a run; the
 * two assertions are harmless together.
 */

/** How often a held wake lock rereads the keep-awake preference. */
export const DAEMON_WAKE_LOCK_REFRESH_MS = 15_000;

const PRIMARY_PREFERENCES_FILE_NAME = 'preferences.json';
const LAST_GOOD_PREFERENCES_FILE_NAME = 'preferences.last-good.json';
/** The desktop default (`DEFAULT_PREFERENCES.keepSystemAwakeWhileAgentsActive`). */
const KEEP_AWAKE_DEFAULT = true;

export interface KeepAwakePreferenceSource {
  read(this: void): Promise<boolean>;
}

/**
 * Read-only projection of the desktop's keep-awake preference:
 * `preferences.json`, else `preferences.last-good.json`, else on. Never
 * writes, repairs or caches; Electron main stays the single writer.
 */
export function createKeepAwakePreferenceSource(options: {
  readonly canonicalDataRoot: string;
  readonly readFile?: (absolutePath: string) => Promise<string>;
}): KeepAwakePreferenceSource {
  const readText =
    options.readFile ??
    ((absolutePath: string): Promise<string> => readFile(absolutePath, 'utf8'));
  const readCandidate = async (name: string): Promise<boolean | null> => {
    let raw: string;
    try {
      raw = await readText(join(options.canonicalDataRoot, name));
    } catch {
      return null;
    }
    const record = readDesktopPreferencesRecord(raw);
    if (!record) return null;
    const value = record.keepSystemAwakeWhileAgentsActive;
    return typeof value === 'boolean' ? value : KEEP_AWAKE_DEFAULT;
  };
  return {
    read: async (): Promise<boolean> =>
      (await readCandidate(PRIMARY_PREFERENCES_FILE_NAME)) ??
      (await readCandidate(LAST_GOOD_PREFERENCES_FILE_NAME)) ??
      KEEP_AWAKE_DEFAULT,
  };
}

export interface DaemonWakeLock extends ExecutionWakeLock {
  /** Releases the assertion and clears holders; later acquires do nothing. */
  shutdown(this: void): Promise<void>;
}

function warnToStderr(reason: string): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', message: 'Wake lock unavailable', reason })}\n`,
  );
}

/**
 * Holds one power assertion while any holder remains and keep awake is on.
 * It starts off: each acquire reads the preference, and only a read that
 * says on enables it, so keep awake off never starts a helper. While holders
 * remain it rereads on an interval, because the daemon hears of no saves. A
 * missing helper or a lost assertion is a warning, never an error to the
 * holder. Windows sets the thread execution state through the owned-child
 * addon (CAN-5091).
 */
export function createDaemonWakeLock(options: {
  readonly os: PlatformOperatingSystem;
  readonly power: PlatformPowerServices;
  readonly preference: KeepAwakePreferenceSource;
  readonly warn?: (reason: string) => void;
  readonly refreshMs?: number;
}): DaemonWakeLock | undefined {
  const policy = new WakeLockPolicy(options.power, {
    warn: options.warn ?? warnToStderr,
  });
  let enabled = false;
  policy.setEnabled(enabled);
  const refreshMs = options.refreshMs ?? DAEMON_WAKE_LOCK_REFRESH_MS;
  let stopped = false;
  /** Counts last releases; a read applies only if none came after it began. */
  let generation = 0;
  let reading: { readonly generation: number } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = (): void => {
    if (stopped || reading?.generation === generation) return;
    const current = { generation };
    reading = current;
    void options.preference
      .read()
      .then(
        (next) => {
          // Only a change reconciles, so a missing helper is not retried
          // on every read.
          if (stopped || current.generation !== generation || next === enabled)
            return;
          enabled = next;
          policy.setEnabled(enabled);
        },
        () => undefined,
      )
      .finally(() => {
        if (reading === current) reading = null;
      });
  };
  const stopRefreshing = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    acquire: (key, reason): void => {
      if (stopped) return;
      policy.acquire(key, reason);
      refresh();
      if (timer === undefined) {
        timer = setInterval(refresh, refreshMs);
        timer.unref();
      }
    },
    release: (key): void => {
      policy.release(key);
      if (policy.getState().holderCount > 0) return;
      // The next run waits for a fresh read, and no read started before now
      // applies, so a preference turned off between runs never starts a helper.
      generation += 1;
      stopRefreshing();
      enabled = false;
      policy.setEnabled(enabled);
    },
    shutdown: async (): Promise<void> => {
      stopped = true;
      stopRefreshing();
      await policy.shutdown();
    },
  };
}
