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
import type {
  PlatformOperatingSystem,
  PlatformPermissionAcceptance,
  PlatformPermissionCause,
} from '@canopy/core-runtime';
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

/** A node admitted with other accounts' allow entries (CAN-7915). */
export interface InternalRootAcceptedTrustees {
  /** Local log only, like the SIDs. */
  readonly path: string;
  /** The migration folder or one of its files, or the published data root. */
  readonly role: 'internal_migration' | 'data_root';
  readonly acceptance: PlatformPermissionAcceptance;
}

type AcceptedTrusteesSink = (accepted: InternalRootAcceptedTrustees) => void;

// The check runs at import time, before a host can log: hold a few until then.
const PENDING_ACCEPTED_LIMIT = 16;
const pendingAccepted: InternalRootAcceptedTrustees[] = [];
let acceptedSink: AcceptedTrusteesSink | undefined;

function reportAcceptedTrustees(accepted: InternalRootAcceptedTrustees): void {
  if (acceptedSink) acceptedSink(accepted);
  else if (pendingAccepted.length < PENDING_ACCEPTED_LIMIT)
    pendingAccepted.push(accepted);
}

/**
 * Receives every accepted node, starting with those checked before it was
 * installed. Returns a remover; nodes checked without a sink are held again.
 */
export function onInternalRootTrusteesAccepted(
  sink: AcceptedTrusteesSink,
): () => void {
  acceptedSink = sink;
  for (const accepted of pendingAccepted.splice(0)) sink(accepted);
  return () => {
    if (acceptedSink === sink) acceptedSink = undefined;
  };
}

interface StartupNodeCheck {
  readonly observation: InternalRootStartupObservation;
  readonly onRefused?: (cause: PlatformPermissionCause) => void;
  /** Set only for the migration folder, its files and the data root. */
  readonly accept?: {
    readonly role: InternalRootAcceptedTrustees['role'];
    readonly report: AcceptedTrusteesSink;
  };
}

/** Why a node is not private to this user, or `null` when it is. */
function startupNodeRefusal(
  path: string,
  stat: BigIntStats,
  kind: 'directory' | 'file',
  check: StartupNodeCheck,
): PlatformPermissionCause | null {
  const { observation } = check;
  if (observation.os === 'win32') {
    const acl = evaluateWindowsAcl(
      observation.readWindowsAcl(path),
      kind,
      check.accept ? 'accept' : 'refuse',
    );
    if (acl.state !== 'private') return acl.cause ?? 'unverifiable';
    const after = lstatSync(path, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino) return 'path_changed';
    if (after.isSymbolicLink()) return 'symlink';
    if (kind === 'directory' ? !after.isDirectory() : !after.isFile())
      return 'wrong_kind';
    if (kind === 'file' && after.nlink !== 1n) return 'hard_link';
    if (acl.accepted && check.accept)
      check.accept.report({
        path,
        role: check.accept.role,
        acceptance: acl.accepted,
      });
    return null;
  }
  const uid = observation.getuid();
  if (
    (observation.os !== 'darwin' && observation.os !== 'linux') ||
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  )
    return 'unverifiable';
  if (stat.uid !== BigInt(uid)) return 'foreign_owner';
  return (stat.mode & 0o077n) === 0n ? null : 'broad_mode';
}

function privateStartupNode(
  path: string,
  stat: BigIntStats,
  kind: 'directory' | 'file',
  check: StartupNodeCheck,
): boolean {
  let refusal: PlatformPermissionCause | null;
  try {
    refusal = startupNodeRefusal(path, stat, kind, check);
  } catch (error) {
    // The caller still refuses on the throw; only the cause is added.
    check.onRefused?.('unverifiable');
    throw error;
  }
  if (refusal !== null) check.onRefused?.(refusal);
  return refusal === null;
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
  /** Closed cause only, for diagnostics; the state alone decides admission. */
  readonly onPrivacyRefused?: (cause: PlatformPermissionCause) => void;
  /** Defaults to the process-wide sink `onInternalRootTrusteesAccepted` installs. */
  readonly onTrusteesAccepted?: (
    accepted: InternalRootAcceptedTrustees,
  ) => void;
}) => InternalRootStartupState;

/** The validator belongs to B; this adapter supplies only synchronous filesystem facts. */
export const readInternalRootStartup: InternalRootStartupReader = (options) => {
  const accepted: InternalRootAcceptedTrustees[] = [];
  const state = readInternalRootStartupState({
    ...options,
    onTrusteesAccepted: (node) => accepted.push(node),
  });
  // Only an admitted startup reports: a later refusal is the outcome to log.
  if (state !== 'unsupported') {
    const report = options.onTrusteesAccepted ?? reportAcceptedTrustees;
    for (const node of accepted) {
      try {
        report(node);
      } catch {
        // A warning never decides admission.
      }
    }
  }
  return state;
};

function readInternalRootStartupState({
  home: suppliedHome,
  identity,
  onValidatedSource,
  onCompletedMigration,
  onPrivacyRefused,
  onTrusteesAccepted,
  observation = {
    os: hostOperatingSystem(),
    getuid: () => process.getuid?.(),
    readWindowsAcl: readWindowsAclSync,
  },
}: Parameters<InternalRootStartupReader>[0] & {
  readonly onTrusteesAccepted: AcceptedTrusteesSink;
}): InternalRootStartupState {
  // The startup disposition record beside these stays strict.
  const strict: StartupNodeCheck = {
    observation,
    ...(onPrivacyRefused && { onRefused: onPrivacyRefused }),
  };
  const migrationFolder: StartupNodeCheck = {
    ...strict,
    accept: { role: 'internal_migration', report: onTrusteesAccepted },
  };
  const publishedRoot: StartupNodeCheck = {
    ...strict,
    accept: { role: 'data_root', report: onTrusteesAccepted },
  };
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
        !privateStartupNode(
          coordination,
          directory,
          'directory',
          migrationFolder,
        )
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
          !privateStartupNode(path, stat, 'file', migrationFolder)
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
            ? privateStartupNode(destination, root, 'directory', publishedRoot)
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
          !privateStartupNode(staging, stat, 'file', migrationFolder)
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
          !privateStartupNode(report, stat, 'file', migrationFolder) ||
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
        !privateStartupNode(disposition, stat, 'file', strict)
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
        !privateStartupNode(destination, root, 'directory', publishedRoot)
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
}

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
  let privacy: PlatformPermissionCause | undefined;
  const internalState = readInternalRoot({
    ...options,
    onValidatedSource: (source) => {
      customSource =
        source !== join(canonicalStoragePath(home), `.${identity.brandId}`);
    },
    onPrivacyRefused: (cause) => {
      privacy ??= cause;
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
    if (!(error instanceof BuildStorageStartupRefused)) throw error;
    // Every refused node ends the read, so a recorded cause decided the state.
    const cause =
      internalState === 'unsupported' || internalState === 'incomplete'
        ? privacy
        : undefined;
    if (customSource && isDevelopmentOrTestBuild())
      throw new BuildStorageStartupRefused(
        error.reason,
        `${error.message} This transaction used an explicit source; append the original --source-dir option when resuming.`,
        cause,
      );
    throw cause === undefined
      ? error
      : new BuildStorageStartupRefused(error.reason, error.message, cause);
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
