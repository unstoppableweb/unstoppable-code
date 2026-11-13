import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open } from 'node:fs/promises';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  WindowsColdInspectionError,
} from '@canopy/core-platform';
import { daemonName, type BrandCore } from '@canopy/protocol/brand';
import {
  listW5HostPeers,
  inspectW5MaintenanceOwner,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { basename, dirname, join } from 'node:path';
import {
  createPrivateMigrationDirectory,
  internalRootFilesystemHost,
  migrationNodeIdentity,
  observeMigrationNode,
  type InternalRootFilesystemHost,
} from './filesystem-host';
import { DatabaseSync } from 'node:sqlite';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  InternalRootMigrationRefused,
  matchesInternalRootNodeIdentity,
  type InternalRootIdentity,
  type InternalRootColdRecovery,
  type InternalRootMigrationWorker,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  inspectInternalRoot,
  isWithinInternalRoot,
  captureInternalRootExternal,
  sealInternalRootExternal,
  assertInternalRootExternalPostimages,
  assertInternalRootExternalPreimages,
  restoreInternalRootExternal,
  readInternalRootJournal,
  saveInternalRootJournal,
  buildInternalRoot,
  internalRootBuildSpace,
  publishInternalRoot,
  sealInternalRoot,
  internalRootPublicationRoot,
  discardInternalRootDestination,
  preserveUnpublishedInternalRoot,
  internalRootStaging,
  validateInternalRootStaging,
  exposeInternalRootStaging,
  validateExternalRootFiles,
  privateDirectory,
  statIfPresent,
  flush,
} from './filesystem';
export {
  internalRootIdentity,
  readInternalRootJournal,
  isWithinInternalRoot,
} from './filesystem';
import {
  assertInternalRootNativeCold,
  assertInternalRootNativeDaemonStopped,
  internalRootColdHost,
  readInternalRootManagedPids,
} from './native-cold';
import { relocateSecureStorage } from '@canopy/core-platform/secure-storage-relocation';

const run = promisify(execFile);

type ExecutableBrand = Pick<BrandCore, 'displayName' | 'cliName'>;

export function assertInternalRootColdProcesses(
  stdout: string,
  selfPid: number,
  selfParent: number,
  brands: readonly ExecutableBrand[],
): void {
  if (!brands.length) throw new Error('Missing trusted executable identities');
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error('Unrecognized process table');
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        executable: match[3] ?? '',
      };
    });
  if (!rows.some((row) => row.pid === selfPid && row.parent === selfParent))
    throw new Error('Incomplete process table');
  const active = rows.filter((row) => {
    if (row.pid === selfPid) return false;
    if (
      row.parent === selfPid &&
      ['/bin/ps', '/usr/sbin/lsof'].includes(row.executable)
    )
      return false;
    const name = basename(row.executable);
    // Product names/channels follow generate-electron-builder-config.mjs;
    // Electron derives Helper names from productName. No arguments are read.
    return brands.some(
      (brand) =>
        name === brand.cliName ||
        name === daemonName(brand) ||
        [
          brand.displayName,
          `${brand.displayName} (Internal)`,
          `${brand.displayName} (RC)`,
        ].some(
          (product) =>
            name === product ||
            name === `${product} Helper` ||
            (name.startsWith(`${product} Helper (`) && name.endsWith(')')) ||
            row.executable.includes(`/${product}.app/Contents/`),
        ),
    );
  });
  const crashReporters = active.filter(
    (row) => basename(row.executable) === 'chrome_crashpad_handler',
  );
  const crashPattern = crashReporters
    .map((row) =>
      row.executable
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/chrome_crashpad_handler$/, '[c]hrome_crashpad_handler'),
    )
    .join('|')
    .replace(/'/g, "'\\''");
  const crashRecovery = crashReporters.length
    ? ` Crash reporter remains (PIDs ${crashReporters.map((row) => row.pid).join(', ')}). After quitting the app, run: pkill -f '${crashPattern}'`
    : '';
  if (active.length)
    throw new InternalRootMigrationRefused(
      'writer-active',
      `Product executables remain (PIDs ${active.map((row) => `${row.pid} (${row.executable})`).join(', ')}). Stop the app, CLI, daemon and helpers before retrying.${crashRecovery}`,
    );
}

function under(path: string, root: string): boolean {
  return isWithinInternalRoot(root, path);
}

function canonicalOpenFilePath(path: string): string {
  let ancestor = path;
  const remainder: string[] = [];
  for (;;) {
    try {
      return join(observeStoragePathSync(ancestor).canonicalPath, ...remainder);
    } catch (error) {
      const parent = dirname(ancestor);
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        (error.code !== 'EACCES' &&
          error.code !== 'EPERM' &&
          error.code !== 'ENOENT') ||
        parent === ancestor
      )
        throw error;
      // lsof can name protected or deleted mappings; retain ancestor aliases.
      remainder.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** NUL-delimited lsof fields preserve whitespace/newlines in file names. */
export function assertInternalRootColdOpenFiles(
  stdout: string,
  stderr: string,
  roots: readonly string[],
  exemptPids: ReadonlySet<number>,
): void {
  // Only a specifically identified skipped mount outside every affected tree
  // is harmless. Permission/process-table errors and unknown diagnostics refuse.
  let skippedMount = false;
  for (const line of stderr.trim().split('\n').filter(Boolean)) {
    const warning =
      /^lsof: WARNING: can't stat\(\) .+ file system (\/.+)$/.exec(line.trim());
    if (warning?.[1]) {
      const path = canonicalOpenFilePath(warning[1]);
      if (roots.some((root) => under(path, root) || under(root, path)))
        throw new InternalRootMigrationRefused(
          'writer-active',
          'Affected mount inspection incomplete. Stop processes using the affected trees and restore inspection access before retrying.',
        );
      skippedMount = true;
    } else if (
      !(
        skippedMount &&
        /^\s*Output information may be incomplete\.?$/.test(line)
      )
    )
      throw new Error('Incomplete open-file inspection');
  }
  let pid = 0;
  let command = '';
  let sawSelf = false;
  const blockers = new Map<number, string>();
  try {
    for (const raw of stdout.split('\0')) {
      const field = raw.replace(/^\n/, '');
      if (!field) continue;
      if (field.startsWith('p')) {
        if (!/^p[1-9]\d*$/.test(field)) throw new Error('Invalid lsof PID');
        pid = Number(field.slice(1));
        command = '';
        if (exemptPids.has(pid)) sawSelf = true;
      } else if (field.startsWith('c')) {
        command = field.slice(1);
      } else if (field.startsWith('n')) {
        if (!pid) throw new Error('Missing lsof PID');
        if (exemptPids.has(pid) || !field.startsWith('n/')) continue;
        let path: string;
        try {
          path = canonicalOpenFilePath(
            field.slice(1).replace(/ \(deleted\)$/, ''),
          );
        } catch (error) {
          if (!blockers.size) throw error;
          continue;
        }
        if (roots.some((root) => under(path, root)) && !blockers.has(pid))
          blockers.set(
            pid,
            `Process ${pid} (${command || 'unknown executable'}) has an open file or working directory under an affected tree: ${JSON.stringify(path)}.`,
          );
      } else if (!field.startsWith('f'))
        throw new Error('Unrecognized lsof field');
    }
  } catch (error) {
    // A known writer still takes precedence over a later inspection failure.
    if (!blockers.size) throw error;
  }
  if (blockers.size)
    throw new InternalRootMigrationRefused(
      'writer-active',
      [...blockers.values()].join(' '),
    );
  if (!sawSelf) throw new Error('Incomplete user open-file table');
}

export async function assertInternalRootDaemonStopped(
  root: string,
): Promise<void> {
  // The platform probe reaches a long root's socket through its alias (CAN-5694).
  const endpoints = createPlatformEndpointServices(
    hostPlatformOperatingSystem(),
  );
  if (endpoints.semantics !== 'filesystem-socket')
    throw new Error('Daemon socket inspection is POSIX only');
  const result = await endpoints.probe(
    endpoints.address({ dataRoot: root, endpointName: 'core' }),
  );
  if (result.state === 'live')
    throw new InternalRootMigrationRefused(
      'writer-active',
      'The root daemon socket still accepts connections. Stop the daemon before retrying.',
    );
  if (result.state === 'ambiguous')
    throw new Error('Daemon socket inspection incomplete');
}

/** Read-only targeted snapshot, not an exclusion guarantee against old writers. */
export async function proveInternalRootCold(
  identity: InternalRootIdentity,
  externalFiles: readonly string[],
  brands: readonly ExecutableBrand[],
): Promise<void> {
  if (hostOperatingSystem() !== 'darwin')
    throw new InternalRootMigrationRefused(
      'cold-proof-unavailable',
      'Native migration composition is not installed; CAN-5786 must qualify and enable it.',
    );
  try {
    const { stdout } = await run(
      '/bin/ps',
      ['-ww', '-U', String(process.getuid?.()), '-o', 'pid=,ppid=,comm='],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assertInternalRootColdProcesses(stdout, process.pid, process.ppid, brands);
    const roots = [
      identity.source,
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      internalRootStaging(identity),
      ...externalFiles.map((path) =>
        path.includes('/.git/') ? `${path.split('/.git/')[0]}/.git` : path,
      ),
    ].map((path) => observeStoragePathSync(path).canonicalPath);
    const script = process.argv[1]
      ? observeStoragePathSync(process.argv[1]).canonicalPath
      : process.cwd();
    if (roots.some((root) => under(process.cwd(), root) || under(script, root)))
      throw new InternalRootMigrationRefused(
        'writer-active',
        'Run from a checkout outside both roots and the affected maintenance trees.',
      );
    const inspection = run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-u', String(process.getuid?.()), '-F0pcfn'],
      { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 },
    );
    const exemptPids = new Set([process.pid]);
    if (inspection.child.pid) exemptPids.add(inspection.child.pid);
    const result = await inspection;
    assertInternalRootColdOpenFiles(
      result.stdout,
      result.stderr,
      roots,
      exemptPids,
    );
    const services = hostPlatformServices(
      createPlatformEndpointServices('darwin'),
    );
    for (const dataRoot of [identity.source, identity.destination]) {
      const options = {
        dataRoot,
        inspect: (
          pid: number,
          signal?: AbortSignal,
        ): ReturnType<typeof services.supervision.inspectProcess> =>
          services.supervision.inspectProcess({ pid, signal }),
        secureFiles: services.secureFiles,
      };
      // Existing read-only cohort/maintenance parsers retain PID-reuse rules.
      if (
        (await listW5HostPeers(options)).length ||
        (await inspectW5MaintenanceOwner(options))
      )
        throw new InternalRootMigrationRefused(
          'writer-active',
          'A W5 cohort or maintenance owner is live or unprovable. Use W5 offline diagnosis before retrying.',
        );
    }
    // Held W5 SQLite process locks have open files under runtime/locks and were
    // covered by the same user-scoped lsof pass; never create locks in inventory.
    await assertInternalRootDaemonStopped(identity.source);
    await assertInternalRootDaemonStopped(identity.destination);
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    throw new InternalRootMigrationRefused(
      'cold-proof-unavailable',
      'Process/open-file inspection failed or was incomplete. Preserve the installation; retry with native macOS inspection access.',
    );
  }
}

/** Inactive until a trusted offline host supplies the complete native composition. */
async function proveNativeCold(
  identity: InternalRootIdentity,
  externalFiles: readonly string[],
  brands: readonly ExecutableBrand[],
  native: ReturnType<typeof internalRootColdHost>,
  maintenanceRoot?: string,
): Promise<void> {
  const os = hostOperatingSystem();
  if (os !== 'linux' && os !== 'win32')
    throw new InternalRootMigrationRefused(
      'cold-proof-unavailable',
      'Native host mismatch.',
    );
  try {
    const roots = [
      identity.source,
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      internalRootStaging(identity),
      ...externalFiles.map((file): string => {
        const gitName = (value: string): string =>
          os === 'win32' ? value.toLowerCase() : value;
        if (gitName(basename(file)) === '.git') return dirname(file);
        for (
          let parent = dirname(file);
          parent !== dirname(parent);
          parent = dirname(parent)
        )
          if (
            (os === 'win32'
              ? basename(parent).toLowerCase()
              : basename(parent)) === '.git'
          )
            return parent;
        return file;
      }),
    ];
    // CAN-5901 consumes this scope; the legacy no-argument host still ignores it.
    const observe: (
      roots: readonly string[],
    ) => ReturnType<typeof native.observe> = native.observe;
    await assertInternalRootNativeCold({
      os,
      roots,
      brands,
      managedPids: await readInternalRootManagedPids([
        identity.source,
        identity.destination,
      ]),
      rows: await observe(roots),
    });
    for (const dataRoot of [identity.source, identity.destination]) {
      await assertInternalRootNativeDaemonStopped(dataRoot, os);
      const options = {
        dataRoot,
        inspect: (
          pid: number,
          signal?: AbortSignal,
        ): ReturnType<typeof native.services.supervision.inspectProcess> =>
          native.services.supervision.inspectProcess({ pid, signal }),
        secureFiles: native.services.secureFiles,
      };
      // W5 validates its own held record/claim, never the other root's owner.
      if (
        (await listW5HostPeers(options)).length ||
        (dataRoot !== maintenanceRoot &&
          (await inspectW5MaintenanceOwner(options)))
      )
        throw new InternalRootMigrationRefused(
          'writer-active',
          'A W5 host or maintenance owner is live or unprovable.',
        );
    }
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    throw Object.assign(
      new InternalRootMigrationRefused(
        'cold-proof-unavailable',
        `Native process, endpoint or W5 inspection is incomplete${error instanceof WindowsColdInspectionError ? ` (${error.reason})` : ''}. ${error instanceof Error ? error.message : 'Unknown failure.'}`,
      ),
      { cause: error },
    );
  }
}

/** SQLite's OS lock is outside both resolver candidates and released on crash. */
export async function coordinateInternalRootMigration(
  identity: InternalRootIdentity,
  host: InternalRootFilesystemHost,
): Promise<() => Promise<void>> {
  if (hostOperatingSystem() === 'win32') {
    if (!(await statIfPresent(identity.coordination))) {
      try {
        await createPrivateMigrationDirectory(identity.coordination, host);
      } catch (error) {
        if (!(await statIfPresent(identity.coordination))) throw error;
      }
    }
  } else await mkdir(identity.coordination, { mode: 0o700, recursive: true });
  await privateDirectory(identity.coordination, host);
  const path = join(identity.coordination, 'coordination.sqlite');
  let stat = await statIfPresent(path);
  if (hostOperatingSystem() === 'win32') {
    if (!stat) {
      try {
        const file = await open(path, 'wx', 0o600);
        await file.close();
      } catch (error) {
        if (!(await statIfPresent(path))) throw error;
      }
      stat = await statIfPresent(path);
    }
    try {
      if (!stat) throw new Error('Missing coordination file');
      await observeMigrationNode(path, stat, host);
    } catch (error) {
      throw new InternalRootMigrationRefused(
        'coordination-held',
        `Coordination database is locked or its native privacy/identity is unprovable. Retain it for recovery. ${error instanceof Error ? error.message : 'Native observation failed.'}`,
      );
    }
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new InternalRootMigrationRefused(
      'coordination-held',
      'Unsafe coordination database; retain it for recovery.',
    );
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    db.close();
    throw new InternalRootMigrationRefused(
      'coordination-held',
      'Another migration holds coordination. Never remove the lock database.',
    );
  }
  try {
    await flush(identity.coordination);
    await flush(dirname(identity.coordination));
  } catch (error) {
    db.close();
    throw error;
  }
  return (): Promise<void> =>
    Promise.resolve().then(() => {
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    });
}

export function createInternalRootMigrationWorker(options: {
  readonly diagnose?: (source: string) => Promise<readonly string[]>;
  /** Trusted offline host only; required for Windows custody and Linux publication. */
  readonly ownedChildPath?: string;
  readonly filesystemHost?: InternalRootFilesystemHost;
  /** Explicit trusted selection, never inferred by the unpublished bootstrap. */
  readonly nativeColdHost?: Parameters<typeof internalRootColdHost>[1];
  readonly executableBrands?: readonly ExecutableBrand[];
  /** Test-only substitute; Darwin production still requires APFS clonefile. */
  readonly cloneTree?: (source: string, destination: string) => Promise<void>;
  readonly recoverW5: (
    source: string,
    qualification: InternalRootColdRecovery,
  ) => Promise<void>;
  /** Test-only substitute: the installed composition always uses native proof. */
  readonly proveCold?: (
    identity: InternalRootIdentity,
    externalFiles?: readonly string[],
  ) => Promise<void>;
}): InternalRootMigrationWorker {
  const host =
    options.filesystemHost ??
    internalRootFilesystemHost(options.ownedChildPath);
  const os = hostOperatingSystem();
  const native =
    options.nativeColdHost && (os === 'linux' || os === 'win32')
      ? internalRootColdHost(os, options.nativeColdHost)
      : undefined;
  const coordinationTokens = new Map<string, symbol>();
  const worker: InternalRootMigrationWorker = {
    os,
    diagnose: options.diagnose,
    space: (identity, bytes, reclaim) =>
      internalRootBuildSpace(identity, bytes, reclaim, host),
    inventory: (identity, destination) =>
      inspectInternalRoot(identity, destination, host),
    readJournal: (identity) => readInternalRootJournal(identity, host),
    coordinate: async (
      identity,
    ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
      const release = await coordinateInternalRootMigration(identity, host);
      const token = Symbol('internal-root-migration');
      coordinationTokens.set(identity.coordination, token);
      return async (): Promise<void> => {
        if (coordinationTokens.get(identity.coordination) === token)
          coordinationTokens.delete(identity.coordination);
        await release();
      };
    },
    saveJournal: (journal) => saveInternalRootJournal(journal, host),
    proveCold:
      options.proveCold ??
      ((identity, externalFiles = []) =>
        native
          ? proveNativeCold(
              identity,
              externalFiles,
              options.executableBrands ?? [],
              native,
            )
          : proveInternalRootCold(
              identity,
              externalFiles,
              options.executableBrands ?? [],
            )),
    stagingRoot: internalRootStaging,
    validateStaging: (identity, value) =>
      validateInternalRootStaging(identity, value, host),
    validateExternal: (identity, value) =>
      validateExternalRootFiles(identity, value, host),
    build: (journal) => buildInternalRoot(journal, options.cloneTree, host),
    exposeStaging: (journal) => exposeInternalRootStaging(journal, host),
    seal: (journal, identity) => sealInternalRoot(journal, identity, host),
    publicationRoot: (journal) => internalRootPublicationRoot(journal, host),
    publish: (journal) => publishInternalRoot(journal, host),
    validateRebuild: (journal) =>
      discardInternalRootDestination(journal, true, host),
    discardDestination: (journal) =>
      discardInternalRootDestination(journal, false, host),
    preserveUnpublished: (journal, checkOnly) =>
      preserveUnpublishedInternalRoot(journal, host, checkOnly),
    captureExternal: (journal) => captureInternalRootExternal(journal, host),
    sealExternal: (journal) => sealInternalRootExternal(journal, host),
    assertExternalPostimages: (journal) =>
      assertInternalRootExternalPostimages(journal, host),
    assertExternalPreimages: (journal) =>
      assertInternalRootExternalPreimages(journal, host),
    restoreExternal: (journal) => restoreInternalRootExternal(journal, host),
    recoverW5: async (journal): Promise<void> => {
      const token = coordinationTokens.get(journal.identity.coordination);
      let recovering = true;
      const assertHeld = async (): Promise<void> => {
        const loaded = await readInternalRootJournal(journal.identity, host);
        const stat = await statIfPresent(journal.identity.source);
        if (
          !recovering ||
          !token ||
          coordinationTokens.get(journal.identity.coordination) !== token ||
          loaded?.transactionId !== journal.transactionId ||
          loaded.phase !== 'prepared' ||
          !stat ||
          !matchesInternalRootNodeIdentity(
            await migrationNodeIdentity(journal.identity.source, stat),
            journal.inventory.sourceIdentity,
            hostOperatingSystem(),
          )
        )
          throw new InternalRootMigrationRefused(
            'recovery-required',
            'Migration qualification lost. Retain the original root and journal; retry only while cold.',
          );
      };
      try {
        await assertHeld();
        await worker.proveCold(journal.identity, journal.externalFiles);
        await options.recoverW5(journal.identity.source, {
          identity: journal.identity,
          transactionId: journal.transactionId,
          assertHeld,
          ...(native
            ? {
                assertCold: async (): Promise<void> => {
                  await assertHeld();
                  await proveNativeCold(
                    journal.identity,
                    journal.externalFiles,
                    options.executableBrands ?? [],
                    native,
                    journal.identity.source,
                  );
                  await assertHeld();
                },
              }
            : {}),
        });
        await assertHeld();
      } finally {
        recovering = false;
      }
    },
    validateSecureResume: async (journal): Promise<void> => {
      await privateDirectory(journal.identity.destination, host);
      const stat = await statIfPresent(journal.identity.destination);
      if (
        !stat ||
        !matchesInternalRootNodeIdentity(
          await migrationNodeIdentity(journal.identity.destination, stat),
          journal.publicationIdentity,
          hostOperatingSystem(),
        )
      )
        throw new InternalRootMigrationRefused(
          'recovery-required',
          'Published destination was replaced. Preserve both roots and the journal for recovery.',
        );
    },
    relocateSecure: async (journal): Promise<void> => {
      await relocateSecureStorage({
        historical: journal.identity.historicalSecure,
        dataRoot: journal.identity.destination,
        assertCold: () =>
          worker.proveCold(journal.identity, journal.externalFiles),
      });
      // A rename can precede the journal write. Sync both parents; resume also
      // syncs a previously moved destination before recording secure completion.
      await flush(journal.identity.destination);
      await flush(dirname(journal.identity.destination));
    },
    transactionId: randomUUID,
  };
  return worker;
}
