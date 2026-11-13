import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { hostOperatingSystem } from './host-platform';
import {
  evaluateWindowsAcl,
  readWindowsAclSync,
} from './secure-files/windows-acl';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { isDevelopmentOrTestBuild } from '@canopy/core-runtime/node/build-identity';
import { matchesInternalRootNodeIdentity } from '@canopy/core-runtime/node/internal-root-migration';
import {
  observeStoragePathSync,
  type StoragePathObservation,
} from './storage-path-observation';
import {
  validateInternalRootJournal,
  isInternalRootCleanupReport,
  isInternalRootCleanupStagingName,
} from '@canopy/core-runtime/node/internal-root-journal';
import {
  assertBuildStorageStartup,
  BuildStorageStartupRefused,
  type InternalRootStartupState,
  type BrandBuildIdentity,
} from '@canopy/core-runtime/node/build-storage-startup';

/** Compatibility projections; directory and alias policy require the observation. */
export function canonicalStoragePath(path: string): string {
  return observeStoragePathSync(path).canonicalPath;
}

export function storagePathPresent(path: string): boolean {
  return observeStoragePathSync(path).kind !== 'missing';
}

/** Trusted HOME is normalized first; owned directories beneath it cannot alias. */
export function assertOwnedStorageDirectory(
  path: string,
): StoragePathObservation {
  const observation = observeStoragePathSync(path);
  if (
    !['directory', 'missing'].includes(observation.kind) ||
    observation.symbolicLinkComponents.length > 0
  )
    throw new BuildStorageStartupRefused(
      'secure-relocation-unsafe',
      'Storage contains an alias or unsupported folder. Resolve it explicitly before starting.',
    );
  return observation;
}

/** Trusted host facts only; POSIX ownership never substitutes for a Windows ACL. */
export interface InternalRootStartupObservation {
  readonly os: PlatformOperatingSystem | null;
  readonly getuid: () => number | undefined;
  readonly readWindowsAcl: (path: string) => string;
}

function privateStartupNode(
  path: string,
  stat: BigIntStats,
  kind: 'directory' | 'file',
  observation: InternalRootStartupObservation,
): boolean {
  if (observation.os === 'win32') {
    if (
      evaluateWindowsAcl(observation.readWindowsAcl(path), kind).state !==
      'private'
    )
      return false;
    const after = lstatSync(path, { bigint: true });
    return (
      stat.dev === after.dev &&
      stat.ino === after.ino &&
      !after.isSymbolicLink() &&
      (kind === 'directory'
        ? after.isDirectory()
        : after.isFile() && after.nlink === 1n)
    );
  }
  const uid = observation.getuid();
  return (
    (observation.os === 'darwin' || observation.os === 'linux') &&
    uid !== undefined &&
    Number.isSafeInteger(uid) &&
    uid >= 0 &&
    stat.uid === BigInt(uid) &&
    (stat.mode & 0o077n) === 0n
  );
}

/** B supplies this only after strict journal and secure-completion validation. */
export type InternalRootStartupReader = (options: {
  readonly home: string;
  readonly identity: BrandBuildIdentity;
  readonly observation?: InternalRootStartupObservation;
  readonly onValidatedSource?: (source: string) => void;
  readonly onCompletedMigration?: (migration: {
    source: string;
    destination: string;
    transactionId: string;
    completedAtMs: number;
  }) => void;
}) => InternalRootStartupState;

/** The validator belongs to B; this adapter supplies only synchronous filesystem facts. */
export const readInternalRootStartup: InternalRootStartupReader = ({
  home: suppliedHome,
  identity,
  onValidatedSource,
  onCompletedMigration,
  observation = {
    os: hostOperatingSystem(),
    getuid: () => process.getuid?.(),
    readWindowsAcl: readWindowsAclSync,
  },
}) => {
  if (identity.brandId !== 'canopy' && identity.brandId !== 'unstoppable-code')
    return 'unsupported';
  const home = canonicalStoragePath(suppliedHome);
  const source = join(home, `.${identity.brandId}`);
  const destination = join(home, `.${identity.brandId}-internal`);
  const coordination = join(home, `.${identity.brandId}-internal-migration`);
  if (storagePathPresent(coordination)) {
    try {
      assertOwnedStorageDirectory(coordination);
      const directory = lstatSync(coordination, { bigint: true });
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync.native(coordination) !== coordination ||
        !privateStartupNode(coordination, directory, 'directory', observation)
      )
        return 'unsupported';
      const path = join(coordination, 'journal.json');
      if (storagePathPresent(path)) {
        const stat = lstatSync(path, { bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1n ||
          stat.size > 16n * 1024n * 1024n ||
          !privateStartupNode(path, stat, 'file', observation)
        )
          return 'unsupported';
        const journal = validateInternalRootJournal(
          JSON.parse(readFileSync(path, 'utf8')),
          {
            brandId: identity.brandId,
            build: 'internal',
            source,
            destination,
            coordination,
            historicalSecure: join(
              home,
              `.${identity.brandId}-internal-secure`,
            ),
          },
          { recordedSource: true },
        );
        onValidatedSource?.(journal.identity.source);
        if (
          journal.phase !== 'complete' ||
          journal.secureRelocation !== 'complete'
        )
          return 'incomplete';
        // Do not inspect the retained predecessor or a payload fingerprint: normal
        // writes are allowed after completion. Only the published root is authoritative.
        if (!storagePathPresent(destination)) return 'incomplete';
        const published = assertOwnedStorageDirectory(destination).stat;
        if (!published) return 'incomplete';
        const root = lstatSync(destination, { bigint: true });
        // B's POSIX identity remains numeric; NTFS file IDs must never round.
        const publicationIdentity =
          observation.os === 'win32'
            ? `${root.dev}:${root.ino}`
            : `${published.dev}:${published.ino}`;
        const complete =
          root.isDirectory() &&
          !root.isSymbolicLink() &&
          realpathSync.native(destination) === destination &&
          (observation.os === 'win32'
            ? privateStartupNode(destination, root, 'directory', observation)
            : published.uid === observation.getuid()) &&
          matchesInternalRootNodeIdentity(
            publicationIdentity,
            journal.publicationIdentity,
            observation.os,
          )
            ? 'complete'
            : 'incomplete';
        if (complete === 'complete') {
          onCompletedMigration?.({
            source: journal.identity.source,
            destination: journal.identity.destination,
            transactionId: journal.transactionId,
            // Completion is the journal's last write; ordinary root/chat writes
            // do not advance this cutoff. Rebuild requires a stopped host.
            completedAtMs: Number(stat.mtimeMs),
          });
        }
        return complete;
      }
      const names = readdirSync(coordination);
      if (
        names.some(
          (name) =>
            ![
              'coordination.sqlite',
              'coordination.sqlite-journal',
              'cleanup-candidates.json',
            ].includes(name) && !isInternalRootCleanupStagingName(name),
        )
      )
        return 'unsupported';
      for (const name of names.filter(isInternalRootCleanupStagingName)) {
        const staging = join(coordination, name);
        const stat = lstatSync(staging, { bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1n ||
          stat.size > 16n * 1024n * 1024n ||
          !privateStartupNode(staging, stat, 'file', observation)
        )
          return 'unsupported';
      }
      const report = join(coordination, 'cleanup-candidates.json');
      if (storagePathPresent(report)) {
        const stat = lstatSync(report, { bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1n ||
          stat.size > 16n * 1024n * 1024n ||
          !privateStartupNode(report, stat, 'file', observation) ||
          !isInternalRootCleanupReport(
            JSON.parse(readFileSync(report, 'utf8')),
            report,
          )
        )
          return 'unsupported';
      }
    } catch {
      return 'unsupported';
    }
  }
  // B refuses unjournaled staging too: absence of the predecessor is not a
  // fresh-install signal when a discarded/missing journal left a migration tree.
  if (
    assertOwnedStorageDirectory(`${destination}.migration-staging`).kind !==
    'missing'
  )
    return 'unsupported';
  const disposition = join(home, `.${identity.brandId}-internal-startup.json`);
  if (storagePathPresent(disposition)) {
    try {
      const stat = lstatSync(disposition, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        stat.size > 4096n ||
        !privateStartupNode(disposition, stat, 'file', observation)
      )
        return 'unsupported';
      const record: unknown = JSON.parse(readFileSync(disposition, 'utf8'));
      const root = lstatSync(destination, { bigint: true });
      const acl: unknown =
        observation.os === 'win32'
          ? JSON.parse(observation.readWindowsAcl(disposition))
          : null;
      const principal =
        observation.os === 'win32'
          ? typeof acl === 'object' && acl !== null && 'owner' in acl
            ? acl.owner
            : null
          : String(observation.getuid());
      if (
        typeof record !== 'object' ||
        record === null ||
        !('version' in record) ||
        record.version !== 1 ||
        !('choice' in record) ||
        record.choice !== 'empty-internal' ||
        !('brandId' in record) ||
        record.brandId !== identity.brandId ||
        !('destination' in record) ||
        record.destination !== destination ||
        !('principal' in record) ||
        record.principal !== principal ||
        !('publicationIdentity' in record) ||
        !matchesInternalRootNodeIdentity(
          `${root.dev}:${root.ino}`,
          record.publicationIdentity,
          observation.os,
        ) ||
        assertOwnedStorageDirectory(destination).kind !== 'directory' ||
        !privateStartupNode(destination, root, 'directory', observation)
      )
        return 'unsupported';
      return 'fresh';
    } catch {
      return 'unsupported';
    }
  }
  // A standalone destination is an independently created internal installation.
  // Only an absent or truly empty predecessor has no history to migrate. Check
  // this after migration/startup-choice evidence, without creating either root.
  // If predecessor history also exists, neither is automatically merged/adopted.
  if (
    assertOwnedStorageDirectory(source).kind === 'missing' ||
    readdirSync(source).length === 0
  )
    return 'fresh';
  if (
    identity.brandId === 'unstoppable-code' &&
    assertOwnedStorageDirectory(join(source, 'secure-storage')).kind !==
      'missing'
  )
    return 'stable-owned';
  return 'required';
};

let readInternalRoot: InternalRootStartupReader = readInternalRootStartup;

export function installInternalRootStartupReader(
  reader: InternalRootStartupReader,
): void {
  readInternalRoot = reader;
}

/** Read-only, synchronous guard so import-time writers cannot precede admission. */
export function assertHostBuildStorageStartup(options: {
  readonly home: string;
  readonly identity: BrandBuildIdentity;
}): void {
  const { home, identity } = options;
  if (
    identity.build !== 'internal' &&
    (identity.build !== 'stable' ||
      (!storagePathPresent(
        join(home, `.${identity.brandId}-internal-migration`),
      ) &&
        !storagePathPresent(
          join(home, `.${identity.brandId}-internal.migration-staging`),
        )))
  )
    return;
  let customSource = false;
  const internalState = readInternalRoot({
    ...options,
    onValidatedSource: (source) => {
      customSource =
        source !== join(canonicalStoragePath(home), `.${identity.brandId}`);
    },
  });
  if (
    identity.build === 'stable' &&
    internalState !== 'incomplete' &&
    internalState !== 'unsupported'
  )
    return;
  try {
    assertBuildStorageStartup({
      build: 'internal',
      internalState,
      ...(isDevelopmentOrTestBuild()
        ? {
            migrationCommand: `node --import tsx apps/desktop-app/scripts/internal-root-migration.ts --brand=${identity.brandId} --apply${identity.brandId === 'unstoppable-code' ? ' --declare-internal' : ''}`,
          }
        : {}),
    });
  } catch (error) {
    if (
      customSource &&
      error instanceof BuildStorageStartupRefused &&
      isDevelopmentOrTestBuild()
    )
      throw new BuildStorageStartupRefused(
        error.reason,
        `${error.message} This transaction used an explicit source; append the original --source-dir option when resuming.`,
      );
    throw error;
  }
}

/** Any accepting daemon or unqualified probe refuses a cold relocation. */
export async function assertSecureStorageDaemonStopped(
  address: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(address);
    const refuse = (): void => {
      socket.destroy();
      reject(
        new BuildStorageStartupRefused(
          'secure-relocation-unsafe',
          'Secure storage is in use or its daemon could not be checked. Quit all app, CLI and daemon processes, then start the app or CLI again.',
        ),
      );
    };
    socket.once('connect', refuse);
    socket.setTimeout(1_000, refuse);
    socket.once('error', (error: NodeJS.ErrnoException): void => {
      socket.destroy();
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve();
      else refuse();
    });
  });
}
