import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { logMainProcessWarn } from '../lib/main-process-logging';

export interface InstalledPackageBackend {
  readonly watchPaths: {
    dirs: readonly string[];
    statPollPaths: readonly string[];
  };
  isRelevantEvent(dir: string, name: string | null): boolean;
  read(): Promise<{ raw: string; settled: boolean } | null>;
  toAppVersion(raw: string): string;
  readonly transactionProcessNames: readonly string[];
}

export type InstalledPackageReadResult =
  | 'installed-changed'
  | 'baseline'
  | 'unsettled'
  | null;

export interface InstalledPackageWatch {
  dispose(): void;
  readNow(): Promise<InstalledPackageReadResult>;
  /** Cached authorization only; an outstanding read invalidates the old result. */
  isRelaunchReady(): boolean;
}

interface InstalledPackageWatchOptions {
  backend: InstalledPackageBackend;
  runningVersion: string;
  onInstalledChange: (rawVersion: string) => void;
  onBaselineRestored: () => void;
  /** Runs after observation completes, including unsettled/unreadable reads. */
  onReadinessChange?: (result: InstalledPackageReadResult) => void;
  /** Deferred relaunch backstop, even when the package database is unchanged. */
  onPoll?: () => void;
  pollMs?: number;
  debounceMs?: number;
}

/** Local observation only: independent of network update-check preferences. */
export function watchInstalledPackage(
  options: InstalledPackageWatchOptions,
): InstalledPackageWatch {
  const { backend, runningVersion } = options;
  let disposed = false;
  let baseline: string | null = null;
  let installedRaw: string | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let pendingRead: Promise<InstalledPackageReadResult> = Promise.resolve(null);
  let pendingReads = 0;
  let latestResult: InstalledPackageReadResult = null;
  const watchers: FSWatcher[] = [];

  async function read(): Promise<InstalledPackageReadResult> {
    if (disposed) return null;
    let installed: Awaited<ReturnType<InstalledPackageBackend['read']>>;
    try {
      installed = await backend.read();
    } catch {
      // An unreadable database is not proof of an installed change.
      return null;
    }
    if (disposed || installed === null) return null;
    if (!installed.settled) return 'unsettled';
    const version = backend.toAppVersion(installed.raw);
    if (baseline === null) {
      baseline = installed.raw;
      if (version !== runningVersion) {
        logMainProcessWarn(
          'Installed package baseline does not map to the running app version',
          {
            installedVersion: installed.raw,
            mappedVersion: version,
            runningVersion,
          },
        );
      }
    }
    if (installed.raw === baseline) {
      if (installedRaw !== null) {
        installedRaw = null;
        options.onBaselineRestored();
      }
      return 'baseline';
    }
    if (version === runningVersion) return 'baseline';
    if (
      installedRaw !== installed.raw ||
      latestResult !== 'installed-changed'
    ) {
      installedRaw = installed.raw;
      options.onInstalledChange(installed.raw);
    }
    return 'installed-changed';
  }

  function readNow(): Promise<InstalledPackageReadResult> {
    // Serialize startup, manual and watch reads so only the first settled
    // observation can establish the baseline, even across slow filesystem I/O.
    pendingReads += 1;
    const next = pendingRead.then(
      async (): Promise<InstalledPackageReadResult> => {
        let result: InstalledPackageReadResult = null;
        try {
          result = await read();
          return result;
        } finally {
          latestResult = result;
          pendingReads -= 1;
          if (!disposed) options.onReadinessChange?.(result);
        }
      },
    );
    pendingRead = next.catch(() => null);
    return next;
  }

  function scheduleRead(): void {
    if (disposed) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void readNow().catch((error: unknown) => {
        logMainProcessWarn('Installed package observation failed', error);
      });
    }, options.debounceMs ?? 2_000);
  }

  async function statSignature(): Promise<string> {
    const values = await Promise.all(
      backend.watchPaths.statPollPaths.map(async (path): Promise<string> => {
        try {
          const value = await stat(path);
          return `${value.mtimeMs}:${value.size}`;
        } catch {
          return 'unreadable';
        }
      }),
    );
    return JSON.stringify(values);
  }

  let previousStat = statSignature();
  let polling = false;
  const poll = setInterval(() => {
    if (disposed || polling) return;
    polling = true;
    void (async (): Promise<void> => {
      const previous = await previousStat;
      const next = await statSignature();
      previousStat = Promise.resolve(next);
      if (disposed) return;
      if (previous !== next) scheduleRead();
      options.onPoll?.();
    })()
      .catch((error: unknown) => {
        logMainProcessWarn('Installed package poll failed', error);
      })
      .finally(() => {
        polling = false;
      });
  }, options.pollMs ?? 60_000);

  for (const dir of backend.watchPaths.dirs) {
    try {
      const watcher = watch(dir, (_event, name): void => {
        if (backend.isRelevantEvent(dir, name)) scheduleRead();
      });
      watcher.on('error', (): void => {
        watcher.close();
      });
      watchers.push(watcher);
    } catch {
      // Missing directories and exhausted inotify limits keep the stat fallback.
    }
  }
  void readNow().catch((error: unknown) => {
    logMainProcessWarn('Installed package baseline read failed', error);
  });

  return {
    readNow,
    isRelaunchReady: (): boolean =>
      !disposed && pendingReads === 0 && latestResult === 'installed-changed',
    dispose(): void {
      disposed = true;
      clearInterval(poll);
      if (debounce !== null) clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
    },
  };
}

/** Mirrors scripts/release/linux-apt-contract.mjs (apt-v1 and legacy mapping). */
export function appVersionFromDebianVersion(debVersion: string): string {
  const internal = /^0\.0\.0~internal\.([1-9]\d*)$/.exec(debVersion);
  return internal
    ? `9999.0.0-internal.${internal[1]}`
    : debVersion.replace(/~/g, '-');
}

const MAX_DPKG_STATUS_BYTES = 64 * 1024 * 1024;

/** Bounded streaming stanza reader: no subprocess, elevation or database writes. */
async function readDpkgStatus(
  statusPath: string,
  packageName: string,
): Promise<{ raw: string; settled: boolean } | null> {
  try {
    if ((await stat(statusPath)).size > MAX_DPKG_STATUS_BYTES) return null;
  } catch {
    return null;
  }
  const input = createReadStream(statusPath, {
    encoding: 'utf8',
    // Bound the read even if the database grows after stat.
    end: MAX_DPKG_STATUS_BYTES,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let bytes = 0;
  let name: string | null = null;
  let version: string | null = null;
  let status: string | null = null;
  function stanza(): { raw: string; settled: boolean } | null {
    return name === packageName && version !== null && status !== null
      ? { raw: version, settled: status === 'install ok installed' }
      : null;
  }
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > MAX_DPKG_STATUS_BYTES) return null;
      if (line === '') {
        const found = stanza();
        if (found) return found;
        name = version = status = null;
      } else if (line.startsWith('Package: ')) {
        name = line.slice('Package: '.length).trim();
      } else if (line.startsWith('Version: ')) {
        version = line.slice('Version: '.length).trim() || null;
      } else if (line.startsWith('Status: ')) {
        status = line.slice('Status: '.length).trim();
      }
    }
    return stanza();
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

export function createDpkgBackend({
  packageName,
  dpkgDir = '/var/lib/dpkg',
}: {
  packageName: string;
  dpkgDir?: string;
}): InstalledPackageBackend {
  const statusPath = join(dpkgDir, 'status');
  return {
    watchPaths: { dirs: [dpkgDir], statPollPaths: [statusPath] },
    transactionProcessNames: ['sudo', 'apt', 'apt-get', 'dpkg'],
    isRelevantEvent(_dir, name): boolean {
      return name === null || name === 'status' || name === 'status-new';
    },
    read: (): Promise<{ raw: string; settled: boolean } | null> =>
      readDpkgStatus(statusPath, packageName),
    toAppVersion: appVersionFromDebianVersion,
  };
}
