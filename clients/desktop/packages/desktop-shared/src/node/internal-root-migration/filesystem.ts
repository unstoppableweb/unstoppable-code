import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  chmod,
  chown,
  utimes,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  statfs,
  rm,
  rmdir,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import {
  isWithin,
  projectRelocationBacklinks,
} from '@canopy/core-runtime/node/relocation';
import {
  internalRootMigrationAbortSignal,
  internalRootMigrationProgress,
} from './progress';
import {
  DEFAULT_FILESYSTEM_HOST,
  copyInternalRootTree,
  createPrivateMigrationDirectory,
  qualifyCopyVolume,
  qualifyMigrationGroup,
  observeMigrationNode,
  migrationNodeIdentity,
  internalRootCopySpace,
  ownedMigrationNode,
  windowsFilesystem,
  type InternalRootFilesystemHost,
} from './filesystem-host';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { BrandCore } from '@canopy/protocol/brand';
import {
  resolveBuildStoragePaths,
  historicalSecureDataDir,
} from '@canopy/core-runtime/node/secure-data-dir';
import {
  InternalRootMigrationRefused,
  matchesInternalRootNodeIdentity,
  internalRootDestinationExistsRecovery,
  type InternalRootIdentity,
  type InternalRootInventory,
  type InternalRootJournal,
  type InternalRootExternalSnapshot,
  type InternalRootSpace,
} from '@canopy/core-runtime/node/internal-root-migration';

import { internalRootSourceIsSeparate } from '@canopy/core-runtime/node/internal-root-source';
import {
  validateInternalRootJournal,
  isInternalRootCleanupReport,
  isInternalRootCleanupStagingName,
} from '@canopy/core-runtime/node/internal-root-journal';

export function internalRootIdentity(
  home: string,
  brand: Pick<BrandCore, 'id' | 'displayName' | 'storage'>,
  sourceDirectory?: string,
): InternalRootIdentity {
  if (brand.id !== 'canopy' && brand.id !== 'unstoppable-code')
    throw new Error('Unsupported internal brand.');
  const trustedHome = observeStoragePathSync(home).canonicalPath;
  const pathFor = (build: 'stable' | 'internal'): string =>
    resolveBuildStoragePaths({
      home: trustedHome,
      brand,
      identity: { brandId: brand.id, build },
    }).dataRoot;
  const identity: InternalRootIdentity = {
    brandId: brand.id,
    brandDisplayName: brand.displayName,
    build: 'internal',
    source: sourceDirectory ?? pathFor('stable'),
    destination: pathFor('internal'),
    historicalSecure: historicalSecureDataDir(
      trustedHome,
      brand.storage.secureDataDirNames,
      'internal',
    ),
    coordination: join(trustedHome, `.${brand.id}-internal-migration`),
  };
  if (
    !internalRootSourceIsSeparate(identity.source, [
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      `${identity.destination}.migration-staging`,
      join(trustedHome, `.${brand.id}-internal-startup.json`),
    ])
  )
    refuseLayout(
      'The source must be an absolute canonical directory separate from the internal destination and maintenance paths.',
    );
  return identity;
}

function refuseLayout(detail: string): never {
  throw new InternalRootMigrationRefused('unsupported-layout', detail);
}

export async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}

export async function privateDirectory(
  path: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== path ||
    (hostOperatingSystem() !== 'win32' && (stat.mode & 0o077) !== 0) ||
    !ownedMigrationNode(stat)
  )
    refuseLayout(
      `Expected an owner-only canonical directory: ${path}.${
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        ownedMigrationNode(stat) &&
        canonical === path &&
        hostOperatingSystem() !== 'win32' &&
        (stat.mode & 0o077) !== 0
          ? ` After verifying ownership, run: chmod 700 '${path.split("'").join("'\"'\"'")}'`
          : ''
      }`,
    );
  if (await observeMigrationNode(path, stat, host)) return;
  const os = hostOperatingSystem();
  if (
    !os ||
    (
      await hostPlatformServices(
        createPlatformEndpointServices(os),
      ).secureFiles.permissions({
        path,
        kind: 'directory',
        mode: 'owner-only',
        action: 'verify',
      })
    ).state !== 'private'
  )
    refuseLayout(
      `Directory privacy, including native ACLs, is unprovable: ${path}`,
    );
}

export async function flush(path: string): Promise<void> {
  if (hostOperatingSystem() === 'win32' && (await lstat(path)).isDirectory()) {
    await flushDirectory(path);
    return;
  }
  const handle = await open(
    path,
    hostOperatingSystem() === 'win32' ? 'r+' : 'r',
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableJson(
  path: string,
  value: unknown,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
  options: { readonly removeTempOnFailure?: boolean } = {},
): Promise<void> {
  if (hostOperatingSystem() === 'win32')
    await privateDirectory(dirname(path), host);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceMigrationFile(temp, path, host);
    await flush(dirname(path));
  } catch (error) {
    if (options.removeTempOnFailure) await rm(temp, { force: true });
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) {
    if (!Buffer.isBuffer(bytes)) throw new Error('Expected file bytes');
    hash.update(bytes);
    internalRootMigrationProgress('hashing W5 file');
  }
  return hash.digest('hex');
}

interface TreeManifest {
  readonly fingerprint: string;
  readonly files: number;
  readonly bytes: number;
}
async function manifest(
  root: string,
  durable = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
  omitted: (relative: string) => boolean = () => false,
  group: (relative: string, stat: Stats) => Promise<number> = (
    _relative,
    stat,
  ) => Promise.resolve(stat.gid),
): Promise<TreeManifest> {
  const rootDevice = (await lstat(root)).dev;
  const hash = createHash('sha256');
  const row = (value: unknown): void => {
    hash.update(JSON.stringify(value));
    hash.update('\n');
  };
  let files = 0;
  let bytes = 0;
  let entries = 0;
  async function visit(relative: string): Promise<void> {
    if (omitted(relative)) return;
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.dev !== rootDevice)
      refuseLayout(`Cross-filesystem tree entry: ${path}`);
    if (!ownedMigrationNode(stat))
      refuseLayout(`Foreign-owned tree entry: ${path}`);
    qualifyMigrationGroup(path, stat);
    const windows = await observeMigrationNode(path, stat, host);
    internalRootMigrationProgress('inspected manifest entry');
    const mode = stat.mode & 0o7777;
    const gid = await group(relative, stat);
    const metadata = [
      relative,
      mode,
      stat.uid,
      gid,
      stat.size,
      Math.floor(stat.mtimeMs),
    ];
    if (windows)
      row(['windows', relative, windows.attributes, windows.security]);
    if (stat.isSymbolicLink()) row(['link', ...metadata, await readlink(path)]);
    else if (stat.isDirectory()) {
      // Directory sizes are filesystem-specific, unlike file and symlink sizes.
      row([
        'directory',
        relative,
        mode,
        stat.uid,
        gid,
        Math.floor(stat.mtimeMs),
      ]);
      for (const child of (await readdir(path)).sort())
        await visit(join(relative, child));
      if (durable) await flush(path);
    } else if (stat.isFile()) {
      // Source hard links are copied as independent files; inode/link counts
      // intentionally do not participate in the source/copy fingerprint.
      // Only small W5 log/receipt records get byte hashes; never scan worktree
      // contents or opaque credential payloads. Other changes are metadata-only.
      const critical =
        relative.startsWith(`w5${sep}`) && stat.size <= 16 * 1024 * 1024;
      row([
        'file',
        ...metadata,
        critical
          ? hostOperatingSystem() === 'win32'
            ? createHash('sha256')
                .update(windowsFilesystem(host).read(path))
                .digest('hex')
            : await hashFile(path)
          : null,
      ]);
      files += 1;
      bytes += stat.size;
      if (durable) {
        if (windows && windows.attributes & 1) {
          if (!windowsFilesystem(host).hasReadonlyCopyFlush(path))
            throw new InternalRootMigrationRefused(
              'recovery-required',
              `Readonly construction file lacks a matching in-process copy-flush receipt: ${path}. Retain the journal and rerun to rebuild staging; never clear readonly to force a seal.`,
            );
        } else await flush(path);
      }
    } else if (!(stat.isSocket() && relative.startsWith(`runtime${sep}`)))
      // Sockets carry no recoverable data; C must discard stale runtime state.
      refuseLayout(`Special file: ${path}`);
    entries += 1;
    internalRootMigrationProgress(
      `${entries} entries; ${files} files; ${bytes} bytes`,
    );
  }
  await visit('');
  return {
    fingerprint: hash.digest('hex'),
    files,
    bytes,
  };
}

function inode(stat: Stats | null): string | null {
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

async function inodeAt(
  path: string,
  stat: Stats | null,
): Promise<string | null> {
  return stat ? migrationNodeIdentity(path, stat) : null;
}

export async function inspectInternalRoot(
  identity: InternalRootIdentity,
  inspectDestination = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootInventory> {
  const home = dirname(identity.destination);
  const observedHome = observeStoragePathSync(home);
  if (
    resolve(home) !== home ||
    observedHome.kind !== 'directory' ||
    observedHome.canonicalPath !== home
  )
    refuseLayout('HOME must be canonical, not an alias.');
  if (
    !internalRootSourceIsSeparate(identity.source, [
      identity.destination,
      identity.historicalSecure,
      identity.coordination,
      internalRootStaging(identity),
      join(home, `.${identity.brandId}-internal-startup.json`),
    ])
  )
    refuseLayout('The source overlaps internal storage or maintenance paths.');
  for (const path of [
    identity.source,
    identity.destination,
    identity.historicalSecure,
    identity.coordination,
    internalRootStaging(identity),
  ]) {
    if (path !== identity.source && dirname(path) !== home)
      refuseLayout(
        'Destination and maintenance paths must be canonical HOME siblings.',
      );
    const observed = observeStoragePathSync(path);
    if (
      observed.symbolicLinkComponents.length ||
      observed.canonicalPath !== path ||
      !['directory', 'missing'].includes(observed.kind)
    )
      refuseLayout(
        'Migration paths must be canonical directories, not aliases.',
      );
    if (observed.kind !== 'missing') await privateDirectory(path, host);
  }
  const source = observeStoragePathSync(identity.source).stat ?? null;
  const destination = observeStoragePathSync(identity.destination).stat ?? null;
  if (source && source.dev !== observedHome.stat?.dev)
    refuseLayout(
      'The source and internal destination must share the HOME volume. No cross-volume copying is supported.',
    );
  if (source && hostOperatingSystem() === 'linux')
    await qualifyCopyVolume(identity.source, identity.destination);
  const live = inspectDestination ? identity.destination : identity.source;
  const exists = inspectDestination ? destination : source;
  const tree = exists
    ? await manifest(live, false, host)
    : { fingerprint: '', files: 0, bytes: 0 };
  const ownerPath = join(live, 'build-storage-owner.json');
  let stableOwned = false;
  if (exists && (await statIfPresent(ownerPath))) {
    const metadata = await lstat(ownerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
      refuseLayout('Unsupported storage owner record.');
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(ownerPath, 'utf8'));
    } catch {
      refuseLayout('Unsupported storage owner record.');
    }
    const owner = z
      .object({
        version: z.literal(1),
        brandId: z.enum(['canopy', 'unstoppable-code']),
        build: z.enum(['stable', 'internal', 'rc', 'dev']),
      })
      .strict()
      .safeParse(raw);
    if (
      !owner.success ||
      owner.data.brandId !== identity.brandId ||
      !['stable', 'internal'].includes(owner.data.build)
    )
      refuseLayout('Unsupported storage owner record.');
    stableOwned = owner.data.build === 'stable';
  }
  return {
    sourceIdentity: await inodeAt(identity.source, source),
    destinationIdentity: await inodeAt(identity.destination, destination),
    ...tree,
    historicalSecure:
      observeStoragePathSync(identity.historicalSecure).kind !== 'missing',
    nestedSecure:
      exists !== null &&
      observeStoragePathSync(join(live, 'secure-storage')).kind !== 'missing' &&
      (identity.brandId !== 'canopy' ||
        (await readdir(join(live, 'secure-storage'))).length > 0),
    stableOwned,
  };
}

export async function assertPrivateMigrationFile(
  path: string,
  host: InternalRootFilesystemHost,
): Promise<Stats> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 16 * 1024 * 1024 ||
    !ownedMigrationNode(stat) ||
    (hostOperatingSystem() !== 'win32' && stat.mode & 0o077)
  )
    throw new Error('Unsafe migration evidence');
  await observeMigrationNode(path, stat, host);
  return stat;
}

async function readPrivateMigrationJson(
  path: string,
  host: InternalRootFilesystemHost,
): Promise<unknown> {
  await assertPrivateMigrationFile(path, host);
  return JSON.parse(
    hostOperatingSystem() === 'win32'
      ? windowsFilesystem(host).read(path).toString('utf8')
      : await readFile(path, 'utf8'),
  );
}

function repairPlanFingerprint(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function lifecycleEvidencePath(
  identity: InternalRootIdentity,
  transactionId: string,
  plan: unknown,
): string {
  return join(
    identity.coordination,
    `lifecycle-journals-${transactionId}-${repairPlanFingerprint(plan)}.json`,
  );
}

/** Keep the on-disk v7 plan readable by installed internal-478 validators. */
export async function saveInternalRootJournal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(journal)) + 1 > 16 * 1024 * 1024)
    throw new InternalRootMigrationRefused(
      'unsupported-layout',
      'Frozen repair evidence exceeds the journal limit. Preserve both roots and the existing journal for offline diagnosis.',
    );
  await privateDirectory(journal.identity.coordination, host);
  const { lifecycleJournals, abandonedPaths, abandonedCheckouts, ...plan } =
    journal.repairPlan ?? {};
  if (
    lifecycleJournals !== undefined ||
    abandonedPaths !== undefined ||
    abandonedCheckouts !== undefined
  ) {
    const path = lifecycleEvidencePath(
      journal.identity,
      journal.transactionId,
      plan,
    );
    const evidence = {
      version: 1,
      transactionId: journal.transactionId,
      planFingerprint: repairPlanFingerprint(plan),
      lifecycleJournals: lifecycleJournals ?? [],
      ...(abandonedPaths === undefined ? {} : { abandonedPaths }),
      ...(abandonedCheckouts === undefined ? {} : { abandonedCheckouts }),
    };
    // Never replace evidence still referenced by the last durable journal.
    if (await statIfPresent(path)) {
      if (
        !isDeepStrictEqual(await readPrivateMigrationJson(path, host), evidence)
      )
        throw new InternalRootMigrationRefused(
          'source-changed',
          'Frozen lifecycle evidence changed for the same plan. Preserve the journal and both roots for offline diagnosis.',
        );
    } else await durableJson(path, evidence, host);
  }
  await durableJson(
    join(journal.identity.coordination, 'journal.json'),
    journal.repairPlan ? { ...journal, repairPlan: plan } : journal,
    host,
  );
}

export async function readInternalRootJournal(
  identity: InternalRootIdentity,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootJournal | null> {
  const path = join(identity.coordination, 'journal.json');
  if (!(await statIfPresent(identity.coordination))) return null;
  await privateDirectory(identity.coordination, host);
  const stat = await statIfPresent(path);
  if (!stat) {
    const names = await readdir(identity.coordination);
    const retained = names.filter((name) =>
      /^restarted-[a-f0-9-]{36}$/i.test(name),
    );
    for (const name of retained) {
      const directory = join(identity.coordination, name);
      await privateDirectory(directory, host);
      const old = validateInternalRootJournal(
        await readPrivateMigrationJson(join(directory, 'journal.json'), host),
        identity,
      );
      if (
        name !== `restarted-${old.transactionId}` ||
        (old.phase === 'complete' && old.secureRelocation === 'complete')
      )
        refuseLayout(
          'Unrecognized retained transaction; preserve coordination for recovery.',
        );
    }
    const evidence = names.filter(
      (name) =>
        /^abandoned-w5-commits-[a-f0-9-]{36}\.json$/.test(name) ||
        (retained.length > 0 &&
          (/^external-[a-f0-9]{64}\.preimage$/.test(name) ||
            /^lifecycle-journals(?:-[a-f0-9-]{36}-[a-f0-9]{64})?\.json$/i.test(
              name,
            ))),
    );
    for (const name of evidence)
      await assertPrivateMigrationFile(join(identity.coordination, name), host);
    const isJournalStagingName = (name: string): boolean =>
      /^journal\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp(?![\s\S])/.test(
        name,
      );
    if (
      names.some(
        (name) =>
          ![
            'coordination.sqlite',
            'coordination.sqlite-journal',
            'cleanup-candidates.json',
            'restart.json',
          ].includes(name) &&
          !isInternalRootCleanupStagingName(name) &&
          !retained.includes(name) &&
          !evidence.includes(name) &&
          !isJournalStagingName(name),
      )
    )
      throw new InternalRootMigrationRefused(
        'journal-unsupported',
        'Nonempty coordination directory without a recognized journal; retain it for recovery.',
      );
    // A killed first save has no authoritative journal yet. Retain private
    // staging files as inert bytes; this read may precede coordination.
    for (const name of names.filter(
      (name) =>
        isInternalRootCleanupStagingName(name) || isJournalStagingName(name),
    )) {
      try {
        await assertPrivateMigrationFile(
          join(identity.coordination, name),
          host,
        );
        internalRootMigrationProgress('validated migration staging file');
      } catch {
        throw new InternalRootMigrationRefused(
          'journal-unsupported',
          'Unsafe migration staging file; retain it for recovery.',
        );
      }
    }
    const report = join(identity.coordination, 'cleanup-candidates.json');
    if (await statIfPresent(report)) {
      try {
        if (
          !isInternalRootCleanupReport(
            await readPrivateMigrationJson(report, host),
            report,
          )
        )
          throw new Error('Invalid report');
      } catch {
        throw new InternalRootMigrationRefused(
          'journal-unsupported',
          'Unrecognized or unsafe cleanup report; retain it for recovery.',
        );
      }
    }
    await readInternalRootAbandonmentPlan(identity, null, host);
    return null;
  }
  return readJournalFile(identity, path, host);
}

async function readJournalFile(
  identity: InternalRootIdentity,
  path: string,
  host: InternalRootFilesystemHost,
): Promise<InternalRootJournal> {
  try {
    let journal = validateInternalRootJournal(
      await readPrivateMigrationJson(path, host),
      identity,
    );
    const planEvidencePath = lifecycleEvidencePath(
      identity,
      journal.transactionId,
      journal.repairPlan ?? {},
    );
    const legacyPath = join(identity.coordination, 'lifecycle-journals.json');
    const candidates = [
      planEvidencePath,
      legacyPath,
      retainedEvidencePath(journal, planEvidencePath),
      retainedEvidencePath(journal, legacyPath),
    ];
    let evidencePath = planEvidencePath;
    for (const candidate of candidates)
      if (await statIfPresent(candidate)) {
        if (dirname(candidate) !== identity.coordination)
          await privateDirectory(dirname(candidate), host);
        evidencePath = candidate;
        break;
      }
    if (
      journal.repairPlan &&
      journal.repairPlan.lifecycleJournals === undefined &&
      (await statIfPresent(evidencePath))
    ) {
      const evidence = z
        .object({
          version: z.literal(1),
          transactionId: z.literal(journal.transactionId),
          planFingerprint: z.literal(repairPlanFingerprint(journal.repairPlan)),
          lifecycleJournals: z.array(z.unknown()),
          abandonedPaths: z.array(z.string()).optional(),
          abandonedCheckouts: z.array(z.string()).optional(),
        })
        .strict()
        .parse(await readPrivateMigrationJson(evidencePath, host));
      journal = validateInternalRootJournal(
        {
          ...journal,
          repairPlan: {
            ...journal.repairPlan,
            lifecycleJournals: evidence.lifecycleJournals,
            ...(evidence.abandonedCheckouts === undefined
              ? {}
              : { abandonedCheckouts: evidence.abandonedCheckouts }),
            ...(evidence.abandonedPaths === undefined
              ? {}
              : { abandonedPaths: evidence.abandonedPaths }),
          },
        },
        identity,
      );
    }
    await validateExternalRootFiles(
      identity,
      existingExternalFiles(journal),
      host,
    );
    return journal;
  } catch {
    throw new InternalRootMigrationRefused(
      'journal-unsupported',
      'Unknown, older (including v4/v5), malformed or newer journal. Preserve both roots and request teammate-assisted recovery.',
    );
  }
}

/** Only selections survive restart; the old plan must never drive new repairs. */
export async function readInternalRootAbandonmentPlan(
  identity: InternalRootIdentity,
  journal: InternalRootJournal | null,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootJournal['repairPlan']> {
  if (journal?.repairPlan) return journal.repairPlan;
  const path = join(identity.coordination, 'restart.json');
  if (!(await statIfPresent(path))) return undefined;
  try {
    await privateDirectory(identity.coordination, host);
    const marker = z
      .object({ version: z.literal(1), transactionId: z.uuid() })
      .strict()
      .parse(await readPrivateMigrationJson(path, host));
    const directory = join(
      identity.coordination,
      `restarted-${marker.transactionId}`,
    );
    await privateDirectory(directory, host);
    const prior = await readJournalFile(
      identity,
      join(directory, 'journal.json'),
      host,
    );
    if (prior.transactionId !== marker.transactionId || !prior.repairPlan)
      throw new Error('Restart selection does not match retained journal');
    return prior.repairPlan;
  } catch {
    throw new InternalRootMigrationRefused(
      'journal-unsupported',
      `Unrecognized restart selection at ${JSON.stringify(path)}; preserve coordination and both roots for recovery.`,
    );
  }
}

function retainedEvidencePath(
  journal: InternalRootJournal,
  path: string,
): string {
  return join(
    journal.identity.coordination,
    `restarted-${journal.transactionId}`,
    basename(path),
  );
}

/** Caller holds coordination and cold proof; checkOnly precedes external restoration. */
export async function preserveUnpublishedInternalRoot(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
  checkOnly = false,
): Promise<void> {
  const { identity } = journal;
  if (journal.phase === 'complete' && journal.secureRelocation === 'complete')
    refuseLayout(
      'Secure relocation is complete; restart cannot move credentials.',
    );
  const retained = join(
    identity.coordination,
    `restarted-${journal.transactionId}`,
  );
  const savedStaging = join(retained, 'staging');
  const savedDiscarding = join(retained, 'discarding');
  const paths = [
    internalRootStaging(identity),
    join(identity.coordination, 'staging'),
    identity.destination,
    join(identity.coordination, 'discarding'),
    savedStaging,
    savedDiscarding,
  ];
  const present: string[] = [];
  for (const path of paths) {
    const stat = await statIfPresent(path);
    if (!stat) continue;
    await privateDirectory(path, host);
    const sealed = journal.publicationIdentity !== undefined;
    const expected = sealed
      ? journal.publicationIdentity
      : journal.stagingIdentity;
    // An interrupted re-clone can replace unsealed private staging's inode.
    const unsealedPrivate =
      !sealed &&
      (path === join(identity.coordination, 'staging') ||
        path === savedStaging);
    if (
      (!unsealedPrivate &&
        expected &&
        !matchesInternalRootNodeIdentity(
          await migrationNodeIdentity(path, stat),
          expected,
          hostOperatingSystem(),
        )) ||
      (!expected &&
        path !== join(identity.coordination, 'staging') &&
        path !== savedStaging) ||
      (!sealed &&
        [
          identity.destination,
          join(identity.coordination, 'discarding'),
        ].includes(path))
    )
      throw new InternalRootMigrationRefused(
        'source-changed',
        `Migration tree identity changed at ${JSON.stringify(path)}; never move an independent destination.`,
      );
    if (
      [join(identity.coordination, 'discarding'), savedDiscarding].includes(
        path,
      ) &&
      journal.phase !== 'rebuilding'
    )
      refuseLayout(
        `Discarding tree ${JSON.stringify(path)} requires a recorded rebuilding intent; preserve it for recovery.`,
      );
    if (sealed) {
      if (
        path === identity.destination ||
        path === internalRootStaging(identity)
      )
        await internalRootPublicationRoot(journal, host);
      else if (
        path !== join(identity.coordination, 'discarding') &&
        path !== savedDiscarding &&
        (await manifest(path, false, host)).fingerprint !==
          journal.publicationFingerprint
      )
        throw new InternalRootMigrationRefused(
          'source-changed',
          `Retained sealed tree ${JSON.stringify(path)} changed; preserve it for recovery.`,
        );
    }
    present.push(path);
  }
  if (present.length > 1)
    refuseLayout(
      `Multiple migration trees exist: ${present.map((path) => JSON.stringify(path)).join(', ')}; preserve all for recovery.`,
    );
  if (checkOnly) return;
  if (!(await statIfPresent(retained))) {
    await createPrivateMigrationDirectory(retained, host);
    await flush(identity.coordination);
  }
  await privateDirectory(retained, host);
  // Keep opt-ins durable until the new settled repair plan replaces them.
  if (journal.repairPlan) {
    const marker = join(retained, 'restart.json');
    await durableJson(
      marker,
      {
        version: 1,
        transactionId: journal.transactionId,
      },
      host,
    );
    await replaceMigrationFile(
      marker,
      join(identity.coordination, 'restart.json'),
      host,
    );
    await flush(identity.coordination);
  }
  const path = present[0];
  if (path && path !== savedStaging && path !== savedDiscarding) {
    await renameMigrationDirectory(
      path,
      path === join(identity.coordination, 'discarding')
        ? savedDiscarding
        : savedStaging,
      await migrationNodeIdentity(path, await lstat(path)),
      host,
    );
    await flush(dirname(path));
    await flush(retained);
  }
  // Readers accept sidecars here if preservation stops before the journal move.
  for (const name of await readdir(identity.coordination)) {
    if (
      !/^external-[a-f0-9]{64}\.preimage$/.test(name) &&
      !/^lifecycle-journals(?:-[a-f0-9-]{36}-[a-f0-9]{64})?\.json$/i.test(name)
    )
      continue;
    const from = join(identity.coordination, name);
    await assertPrivateMigrationFile(from, host);
    if (await statIfPresent(join(retained, name)))
      refuseLayout(
        `Retained evidence already exists at ${JSON.stringify(join(retained, name))}; preserve it and ${JSON.stringify(from)} for recovery.`,
      );
    await rename(from, join(retained, name));
  }
  await flush(retained);
  if (await statIfPresent(join(retained, 'journal.json')))
    refuseLayout(
      `A retained journal already exists at ${JSON.stringify(join(retained, 'journal.json'))}; preserve both journals for recovery.`,
    );
  await rename(
    join(identity.coordination, 'journal.json'),
    join(retained, 'journal.json'),
  );
  await flush(retained);
  await flush(identity.coordination);
  process.stderr.write(
    `Migration: previous journal, evidence and tree retained at ${JSON.stringify(retained)}. Existing refs/canopy-migration-abandoned/* refs remain in their repositories.\n`,
  );
}

/** APFS-only primitive; portable construction is explicitly selected by build. */
export async function cloneInternalRoot(
  source: string,
  destination: string,
  root = source,
): Promise<void> {
  const from = await lstat(source);
  const parent = await lstat(dirname(destination));
  const filesystem = await statfs(source);
  if (
    hostOperatingSystem() !== 'darwin' ||
    from.dev !== parent.dev ||
    filesystem.type !== 26 // Darwin APFS statfs f_type (not the on-disk NX magic).
  )
    throw new InternalRootMigrationRefused(
      'clone-unavailable',
      'Destination staging requires macOS APFS on the source volume. No full-copy fallback is supported.',
    );
  try {
    const child = spawn(
      '/bin/cp',
      ['-c', '-R', '-p', '-v', source, destination],
      {
        timeout: 3_600_000,
        signal: internalRootMigrationAbortSignal(),
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Verbose output proves the clone is advancing without retaining paths or
    // buffering megabytes of file names in the operator process.
    let outputBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      internalRootMigrationProgress(
        `clone progress: ${outputBytes} output bytes`,
      );
    });
    let stderr = '';
    let outputLimitExceeded = false;
    await new Promise<void>((resolve, reject) => {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (
          Buffer.byteLength(stderr) + Buffer.byteLength(chunk) >
          1024 * 1024
        ) {
          outputLimitExceeded = true;
          child.kill('SIGKILL');
        } else stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (outputLimitExceeded)
          reject(new Error('Clone diagnostics exceed the output limit'));
        else if (code === 0) resolve();
        else
          reject(
            Object.assign(new Error('APFS clone failed'), { code, stderr }),
          );
      });
    });
  } catch (error) {
    // BSD cp may report skipped Unix sockets with exit 1. They have no destination
    // payload; accept ONLY that diagnostic, then verify the full data manifest.
    const stderr: unknown =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? error.stderr
        : null;
    const exit: unknown =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : null;
    const warnings =
      typeof stderr === 'string'
        ? stderr.trim().split('\n').filter(Boolean)
        : [];
    let socketsOnly = exit === 1 && warnings.length > 0;
    for (const line of warnings) {
      const match = /^cp: (.+) is a socket \(not copied\)\.$/.exec(line);
      const path = match?.[1];
      if (
        !path ||
        !path.startsWith(`${root}/runtime/`) ||
        !(await statIfPresent(path))?.isSocket()
      )
        socketsOnly = false;
    }
    if (socketsOnly) return;
    throw new InternalRootMigrationRefused(
      'clone-unavailable',
      'APFS clone failed. Retain the journal and partial staging tree; check same-volume clone support and free metadata space before retrying.',
    );
  }
}

/** Deterministic private location, never an ordinary resolver candidate. */
export function internalRootStaging(identity: InternalRootIdentity): string {
  return `${identity.destination}.migration-staging`;
}

/** A sibling is ours only after its exact inode has been durably journaled. */
export async function validateInternalRootStaging(
  identity: InternalRootIdentity,
  journal: InternalRootJournal | null,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const path = internalRootStaging(identity);
  const stat = await statIfPresent(path);
  if (!stat) return;
  if (
    !journal ||
    !matchesInternalRootNodeIdentity(
      await inodeAt(path, stat),
      journal.stagingIdentity,
      hostOperatingSystem(),
    ) ||
    (journal.phase !== 'building' && journal.phase !== 'publishing')
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Unknown or replaced migration staging tree. Preserve it and the journal for teammate-assisted recovery.',
    );
  await privateDirectory(path, host);
  if (hostOperatingSystem() !== 'win32' && (stat.mode & 0o7777) !== 0o700)
    refuseLayout('Migration staging requires mode 0700.');
  if (stat.dev !== (await lstat(identity.source)).dev)
    refuseLayout('Migration staging must remain on the source volume.');
}

export async function validateExternalRootFiles(
  identity: InternalRootIdentity,
  files: readonly string[],
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  let checked = 0;
  for (const path of files) {
    if (
      resolve(path) !== path ||
      (await realpath(path)) !== path ||
      [
        identity.source,
        identity.destination,
        identity.coordination,
        internalRootStaging(identity),
        identity.historicalSecure,
      ].some((root) => isWithin(root, path))
    )
      refuseLayout(
        'External repair files must be canonical and outside both roots, coordination and secure history.',
      );
    if (hostOperatingSystem() === 'win32')
      await privateDirectory(dirname(path), host);
    const stat = await lstat(path);
    await observeMigrationNode(path, stat, host);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !ownedMigrationNode(stat) ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o7000) !== 0
    )
      refuseLayout(
        'External metadata must be regular, owner-held, unaliased records no larger than 1 MiB.',
      );
    internalRootMigrationProgress(
      `${++checked}/${files.length} external files validated`,
    );
  }
}

function externalFingerprint(bytes: Buffer, mode: number): string {
  return createHash('sha256').update(`${mode}:`).update(bytes).digest('hex');
}

async function readExternalMetadata(
  path: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<{ bytes: Buffer; mode: number }> {
  if (hostOperatingSystem() === 'win32') {
    const before = await lstat(path);
    await observeMigrationNode(path, before, host);
    const beforeIdentity = await migrationNodeIdentity(path, before);
    const bytes = windowsFilesystem(host).read(path);
    const after = await lstat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      bytes.length > 1024 * 1024 ||
      before.size !== bytes.length ||
      beforeIdentity !== (await migrationNodeIdentity(path, after)) ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      refuseExternalRecovery('External metadata changed while being read.');
    internalRootMigrationProgress(
      `${bytes.length} external metadata bytes read`,
    );
    return { bytes, mode: before.mode & 0o777 };
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !ownedMigrationNode(before) ||
      before.size > 1024 * 1024
    )
      refuseExternalRecovery('Unsafe or oversized external metadata.');
    // Bound the read itself, not just a racy pre-read stat.
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (
      size > 1024 * 1024 ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      inode(await lstat(path)) !== inode(after)
    )
      refuseExternalRecovery('External metadata changed while being read.');
    internalRootMigrationProgress(`${size} external metadata bytes read`);
    return { bytes: buffer.subarray(0, size), mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function preimagePath(journal: InternalRootJournal, path: string): string {
  const name = createHash('sha256').update(path).digest('hex');
  return join(journal.identity.coordination, `external-${name}.preimage`);
}

async function writeDurableBytes(
  path: string,
  bytes: Buffer,
  mode: number,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  if (hostOperatingSystem() === 'win32')
    await privateDirectory(dirname(path), host);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    if (hostOperatingSystem() !== 'win32') await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceMigrationFile(temp, path, host);
  await flush(dirname(path));
}

async function readPreimage(
  journal: InternalRootJournal,
  entry: InternalRootExternalSnapshot,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<Buffer> {
  await privateDirectory(journal.identity.coordination, host);
  const original = preimagePath(journal, entry.path);
  const path = (await statIfPresent(original))
    ? original
    : retainedEvidencePath(journal, original);
  const stat = await statIfPresent(path);
  if (
    !stat ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !ownedMigrationNode(stat) ||
    (hostOperatingSystem() !== 'win32' && (stat.mode & 0o7777) !== 0o600) ||
    stat.size > 1024 * 1024
  )
    refuseExternalRecovery('Missing or unsafe external preimage.');
  if (path !== original) await privateDirectory(dirname(path), host);
  await observeMigrationNode(path, stat, host);
  const { bytes } = await readExternalMetadata(path, host);
  if (externalFingerprint(bytes, entry.mode) !== entry.preimage)
    refuseExternalRecovery('External preimage changed.');
  return bytes;
}

function refuseExternalRecovery(detail: string): never {
  throw new InternalRootMigrationRefused(
    'recovery-required',
    `${detail} Preserve both roots, external metadata and the journal for teammate-assisted recovery; do not start either build.`,
  );
}

/** Small opaque metadata copies only; never a root backup or credential decoder. */
export async function captureInternalRootExternal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  const entries: InternalRootExternalSnapshot[] = [];
  for (const path of journal.externalFiles) {
    const { bytes, mode } = await readExternalMetadata(path, host);
    const entry = { path, mode, preimage: externalFingerprint(bytes, mode) };
    const backup = preimagePath(journal, path);
    if (await statIfPresent(backup)) await readPreimage(journal, entry, host);
    else {
      await writeDurableBytes(backup, bytes, 0o600, host);
      await readPreimage(journal, entry, host);
    }
    entries.push(entry);
  }
  return entries;
}

export async function sealInternalRootExternal(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<readonly InternalRootExternalSnapshot[]> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  const entries: InternalRootExternalSnapshot[] = [];
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    // C syncs replacement contents; B also makes their directory entries durable
    // before the journal can seal these external postimages for publication.
    if (
      hostOperatingSystem() === 'win32' &&
      windowsFilesystem(host).inspect(entry.path).attributes & 1
    ) {
      const windows = windowsFilesystem(host);
      if (!windows.hasReadonlyCopyFlush(entry.path)) {
        // Unchanged readonly backlinks need no new content flush. A changed
        // postimage must carry the private replacement's retained flush receipt.
        const original = await readExternalMetadata(entry.path, host);
        if (
          externalFingerprint(original.bytes, original.mode) !== entry.preimage
        )
          refuseExternalRecovery(
            'Readonly external replacement lacks a matching flush receipt.',
          );
      }
    } else await flush(entry.path);
    await flush(dirname(entry.path));
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
    entries.push({
      ...entry,
      postimage: externalFingerprint(bytes, mode),
    });
  }
  return entries;
}

/** Missing admin records are not evidence of a changed backlink after Git prunes them. */
function existingExternalFiles(journal: InternalRootJournal): string[] {
  const existing: string[] = [];
  for (const path of journal.externalFiles) {
    const observed = observeStoragePathSync(path);
    if (observed.kind !== 'missing') {
      existing.push(path);
      continue;
    }
    if (
      observed.canonicalPath !== path ||
      observed.symbolicLinkComponents.length
    )
      refuseExternalRecovery(
        `Aliased missing external metadata: ${JSON.stringify(path)}.`,
      );
    const plan = journal.repairPlan?.gitPlan;
    const known = plan?.backlinks.find((image) => image.path === path);
    const removedCheckout = plan?.checkouts.some(
      (row) =>
        join(row.path, '.git') === path &&
        observeStoragePathSync(row.path).kind === 'missing',
    );
    const prunedAdmin =
      ['gitdir', 'commondir'].includes(basename(path)) &&
      observeStoragePathSync(dirname(path)).kind === 'missing' &&
      plan?.checkouts.some((row) => {
        const dotGit = plan.backlinks.find(
          (image) => image.path === join(row.path, '.git'),
        );
        return (
          dotGit?.contents.startsWith('gitdir: ') &&
          resolve(
            dirname(dotGit.path),
            dotGit.contents.slice(8).replace(/\r?\n$/, ''),
          ) === dirname(path) &&
          dirname(dirname(path)) === join(row.commonDirectory, 'worktrees')
        );
      });
    if (!known || (!removedCheckout && !prunedAdmin))
      refuseExternalRecovery(
        `Missing external metadata: ${JSON.stringify(path)}.`,
      );
  }
  return existing;
}

/** Carry the files, but do not pretend a checkout whose Git index was pruned still works. */
export async function isPrunedInternalRootCheckout(
  path: string,
): Promise<boolean> {
  const dotGit = join(path, '.git');
  const state = await statIfPresent(dotGit);
  if (
    !state?.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.size > 1024 * 1024
  )
    return false;
  const contents = await readFile(dotGit, 'utf8');
  if (!contents.startsWith('gitdir: ')) return false;
  const admin = resolve(path, contents.slice(8).replace(/\r?\n$/, ''));
  const observed = observeStoragePathSync(admin);
  const common = dirname(dirname(admin));
  return (
    observed.kind === 'missing' &&
    observed.canonicalPath === admin &&
    !observed.symbolicLinkComponents.length &&
    basename(dirname(admin)) === 'worktrees' &&
    (await statIfPresent(join(common, 'HEAD')))?.isFile() === true
  );
}

async function externalRestoreJournal(
  journal: InternalRootJournal,
): Promise<InternalRootJournal> {
  const files = existingExternalFiles(journal);
  const projected = journal.repairPlan
    ? await projectRelocationBacklinks(
        journal.repairPlan.transition,
        {
          ...journal.repairPlan.gitPlan,
          backlinks: journal.repairPlan.gitPlan.backlinks.filter((image) =>
            files.includes(image.path),
          ),
        },
        true,
      )
    : [];
  const snapshots: InternalRootExternalSnapshot[] = [];
  for (const entry of journal.externalSnapshots ?? []) {
    if (!files.includes(entry.path)) continue;
    const image = projected.find((image) => image.path === entry.path);
    let mode = entry.mode;
    if (!entry.postimage && image && hostOperatingSystem() !== 'win32') {
      // Older POSIX writers let umask strip bits from unsealed postimages.
      const maskedMode = entry.mode & ~process.umask();
      if ((await readExternalMetadata(entry.path)).mode === maskedMode)
        mode = maskedMode;
    }
    snapshots.push({
      ...entry,
      postimage:
        entry.postimage ??
        (image
          ? externalFingerprint(Buffer.from(image.contents), mode)
          : undefined),
    });
  }
  return {
    ...journal,
    externalFiles: files,
    externalSnapshots: journal.externalSnapshots ? snapshots : undefined,
  };
}

async function inspectExternalRestore(
  journal: InternalRootJournal,
  allowRestored: boolean,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  // Validate every file before writing any, including mixed unsealed repair images.
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
    const actual = externalFingerprint(bytes, mode);
    if (
      actual !== entry.postimage &&
      !(allowRestored && actual === entry.preimage)
    )
      refuseExternalRecovery(
        `External metadata changed since repair: ${JSON.stringify(entry.path)}.`,
      );
  }
}

export async function assertInternalRootExternalPostimages(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  await inspectExternalRestore(journal, false, host);
}

export async function assertInternalRootExternalPreimages(
  original: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const journal = await externalRestoreJournal(original);
  await validateExternalRootFiles(
    journal.identity,
    journal.externalFiles,
    host,
  );
  if (!journal.externalSnapshots)
    refuseExternalRecovery('Missing external preimages.');
  for (const entry of journal.externalSnapshots) {
    await readPreimage(journal, entry, host);
    const { bytes, mode } = await readExternalMetadata(entry.path, host);
    if (externalFingerprint(bytes, mode) !== entry.preimage)
      refuseExternalRecovery(
        `External metadata changed after restore: ${JSON.stringify(entry.path)}.`,
      );
  }
}

export async function restoreInternalRootExternal(
  original: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const journal = await externalRestoreJournal(original);
  await inspectExternalRestore(journal, true, host);
  for (const path of original.externalFiles.filter(
    (path) => !journal.externalFiles.includes(path),
  ))
    process.stderr.write(
      `Migration: missing removed/pruned Git metadata ${JSON.stringify(path)}; retained checkouts may need Git recovery. See docs/internal-root-migration-troubleshooting.md#pruned-git-worktree-records.\n`,
    );
  for (const entry of journal.externalSnapshots ?? []) {
    const bytes = await readPreimage(journal, entry, host);
    await validateExternalRootFiles(journal.identity, [entry.path], host);
    const current = await readExternalMetadata(entry.path, host);
    const actual = externalFingerprint(current.bytes, current.mode);
    if (actual === entry.preimage) {
      await flush(entry.path);
      await flush(dirname(entry.path));
      continue;
    }
    if (actual !== entry.postimage)
      refuseExternalRecovery(
        `External metadata changed during restore: ${JSON.stringify(entry.path)}.`,
      );
    await writeDurableBytes(entry.path, bytes, entry.mode, host);
  }
}

/** Capacity estimate credits only recorded trees the next build will discard. */
export async function internalRootBuildSpace(
  identity: InternalRootIdentity,
  bytes: number,
  journal: InternalRootJournal | undefined,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<InternalRootSpace> {
  const space = await internalRootCopySpace(identity.destination, bytes);
  // APFS payload blocks can be shared with the source; deletion need not free them.
  if (
    !journal ||
    hostOperatingSystem() === 'darwin' ||
    space.availableBytes >= space.requiredBytes
  )
    return space;
  await validateInternalRootStaging(identity, journal, host);
  const staging = join(identity.coordination, 'staging');
  const privateStaging = await statIfPresent(staging);
  if (privateStaging) {
    await privateDirectory(staging, host);
    if (
      !journal.stagingIdentity ||
      (await migrationNodeIdentity(staging, privateStaging)) !==
        journal.stagingIdentity
    )
      refuseLayout('Private staging was replaced. Preserve it for recovery.');
    if (await statIfPresent(internalRootStaging(identity)))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Both private clone and sibling staging exist. Preserve both for recovery.',
      );
  }
  const roots = [staging, internalRootStaging(identity)];
  if (
    ['complete', 'restoring-external', 'rebuilding'].includes(journal.phase)
  ) {
    await discardInternalRootDestination(journal, true, host);
    roots.push(identity.destination, join(identity.coordination, 'discarding'));
  }
  const device = (await lstat(dirname(identity.destination))).dev;
  const allocated = async (path: string): Promise<number> => {
    const stat = await statIfPresent(path);
    internalRootMigrationProgress('inspected staging allocation');
    if (!stat || stat.dev !== device || stat.isSymbolicLink()) return 0;
    if (stat.isDirectory()) {
      let total = 0;
      for (const name of await readdir(path))
        total += await allocated(join(path, name));
      return total;
    }
    if (!stat.isFile() || stat.nlink !== 1) return 0;
    // Windows construction refuses sparse/compressed files; POSIX reports allocated blocks.
    return hostOperatingSystem() === 'win32' ? stat.size : stat.blocks * 512;
  };
  let reclaimed = 0;
  for (const root of roots) reclaimed += await allocated(root);
  return { ...space, availableBytes: space.availableBytes + reclaimed };
}

async function removeTreeWithProgress(path: string): Promise<void> {
  const stat = await lstat(path);
  internalRootMigrationProgress('inspected staging entry for removal');
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await readdir(path))
      await removeTreeWithProgress(join(path, name));
    await rmdir(path);
  } else await rm(path);
  internalRootMigrationProgress('removed staging entry');
}

export async function buildInternalRoot(
  journal: InternalRootJournal,
  cloneTree?: (source: string, destination: string) => Promise<void>,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const { identity } = journal;
  const excluded = (journal.repairPlan?.abandonedPaths ?? []).filter((path) =>
    isWithin(identity.source, path),
  );
  const omitted = (relative: string): boolean =>
    excluded.some((path) => isWithin(path, join(identity.source, relative)));
  let constructionIdentity: string | null = null;
  const portableCopy =
    !cloneTree && ['linux', 'win32'].includes(hostOperatingSystem() ?? '');
  if (await statIfPresent(identity.destination))
    throw new InternalRootMigrationRefused(
      'destination-exists',
      internalRootDestinationExistsRecovery(identity.destination),
    );
  await validateInternalRootStaging(identity, journal, host);
  const sibling = internalRootStaging(identity);
  const staging = join(identity.coordination, 'staging');
  if (await statIfPresent(sibling)) {
    if (await statIfPresent(staging))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Both private clone and sibling staging exist. Preserve both for recovery.',
      );
    // Re-enter private coordination before discarding a partial repaired tree.
    await renameMigrationDirectory(
      sibling,
      staging,
      journal.stagingIdentity,
      host,
    );
    await flush(dirname(sibling));
    await flush(identity.coordination);
  }
  if (await statIfPresent(staging)) {
    await privateDirectory(staging, host);
    if (
      portableCopy &&
      (!journal.stagingIdentity ||
        (await migrationNodeIdentity(staging, await lstat(staging))) !==
          journal.stagingIdentity)
    )
      refuseLayout('Private staging was replaced. Preserve it for recovery.');
    if (portableCopy) await manifest(staging, false, host);
    if (hostOperatingSystem() === 'win32') {
      if (!journal.stagingIdentity)
        refuseLayout('Missing recorded staging identity.');
      windowsFilesystem(host).removeRecordedTree(
        staging,
        journal.stagingIdentity,
      );
    } else await removeTreeWithProgress(staging);
  }
  if (portableCopy) {
    await createPrivateMigrationDirectory(staging, host);
    const stagingIdentity = await migrationNodeIdentity(
      staging,
      await lstat(staging),
    );
    constructionIdentity = stagingIdentity;
    if (!stagingIdentity) refuseLayout('Construction identity is unavailable.');
    await flush(identity.coordination);
    await saveInternalRootJournal({ ...journal, stagingIdentity }, host);
    await copyInternalRootTree(identity.source, staging, host, true, omitted);
  } else if (excluded.length) {
    const clone =
      cloneTree ??
      ((from: string, to: string): Promise<void> =>
        cloneInternalRoot(from, to, identity.source));
    const visit = async (from: string, to: string): Promise<void> => {
      if (excluded.some((path) => isWithin(path, from))) return;
      if (!excluded.some((path) => isWithin(from, path))) {
        await clone(from, to);
        return;
      }
      const stat = await lstat(from);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        refuseLayout(`Aliased omission parent: ${from}`);
      await mkdir(to, { mode: 0o700 });
      internalRootMigrationProgress('created omission parent');
      for (const name of await readdir(from))
        await visit(join(from, name), join(to, name));
      const gid =
        hostOperatingSystem() === 'darwin' &&
        process.geteuid?.() !== 0 &&
        stat.gid !== process.getegid?.() &&
        !process.getgroups?.().includes(stat.gid)
          ? -1
          : stat.gid;
      await chown(to, stat.uid, gid);
      await chmod(to, stat.mode & 0o7777);
      await utimes(
        to,
        stat.atimeMs / 1000,
        (Math.floor(stat.mtimeMs) + 0.5) / 1000,
      );
    };
    await visit(identity.source, staging);
  } else await (cloneTree ?? cloneInternalRoot)(identity.source, staging);
  if (
    constructionIdentity &&
    (await inodeAt(staging, await statIfPresent(staging))) !==
      constructionIdentity
  )
    refuseLayout(
      'Private staging was replaced during construction. Preserve it for recovery.',
    );
  await privateDirectory(staging, host);
  const expected = await manifest(
    identity.source,
    false,
    host,
    omitted,
    async (relative, stat) => {
      if (
        hostOperatingSystem() !== 'darwin' ||
        process.geteuid?.() === 0 ||
        stat.gid === process.getegid?.() ||
        process.getgroups?.().includes(stat.gid) ||
        stat.isSocket()
      )
        return stat.gid;
      const copied = await statIfPresent(join(staging, relative));
      if (!copied || copied.gid === stat.gid) return stat.gid;
      process.stderr.write(
        `Migration: ${JSON.stringify(join(identity.source, relative))}: source group ${stat.gid} cannot be assigned; copy received group ${copied.gid}.\n`,
      );
      return copied.gid;
    },
  );
  if (
    (await manifest(staging, false, host)).fingerprint !==
      expected.fingerprint ||
    (await inspectInternalRoot(identity, false, host)).fingerprint !==
      journal.settledFingerprint
  )
    throw new InternalRootMigrationRefused(
      'source-changed',
      'Clone differs from settled source. Retain the original; after diagnosis, use --apply --restart to preserve this unpublished attempt and restart.',
    );
  const stat = await lstat(staging);
  if (
    constructionIdentity &&
    (await migrationNodeIdentity(staging, stat)) !== constructionIdentity
  )
    refuseLayout(
      'Private staging changed during verification. Preserve it for recovery.',
    );
  await flush(staging);
  await flush(identity.coordination);
  return migrationNodeIdentity(staging, stat);
}

/** Called only after the clone's inode is durable in the non-moving journal. */
export async function exposeInternalRootStaging(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const { identity } = journal;
  const from = join(identity.coordination, 'staging');
  const to = internalRootStaging(identity);
  if (
    (await statIfPresent(to)) ||
    (await inodeAt(from, await statIfPresent(from))) !== journal.stagingIdentity
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging changed before exposure. Preserve the journal and both trees for recovery.',
    );
  await privateDirectory(from, host);
  if (
    hostOperatingSystem() !== 'win32' &&
    ((await lstat(from)).mode & 0o7777) !== 0o700
  )
    refuseLayout('Migration staging requires mode 0700.');
  if ((await lstat(from)).dev !== (await lstat(dirname(to))).dev)
    refuseLayout('Migration staging must remain on the source volume.');
  await renameMigrationDirectory(from, to, journal.stagingIdentity, host);
  await flush(identity.coordination);
  await flush(dirname(to));
}

/** Seal the repaired staging tree only if it is still the clone we built. */
export async function sealInternalRoot(
  journal: InternalRootJournal,
  publicationIdentity: string,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  await privateDirectory(staging, host);
  if (
    (await inodeAt(staging, await statIfPresent(staging))) !==
    publicationIdentity
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Staging was replaced during repair. Preserve the journal and request recovery.',
    );
  // clonefile/cp exit alone does not durably publish every nested entry.
  return (await manifest(staging, true, host)).fingerprint;
}

/** Revalidate a sealed tree on BOTH sides of the publication crash window. */
export async function internalRootPublicationRoot(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<string> {
  const staging = internalRootStaging(journal.identity);
  const to = await statIfPresent(journal.identity.destination);
  const from = await statIfPresent(staging);
  const path =
    !to &&
    matchesInternalRootNodeIdentity(
      await inodeAt(staging, from),
      journal.publicationIdentity,
      hostOperatingSystem(),
    )
      ? staging
      : !from &&
          matchesInternalRootNodeIdentity(
            await inodeAt(journal.identity.destination, to),
            journal.publicationIdentity,
            hostOperatingSystem(),
          )
        ? journal.identity.destination
        : null;
  if (!path)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      `Destination ${JSON.stringify(journal.identity.destination)} or staging ${JSON.stringify(staging)} identity changed. Preserve the journal and request recovery.`,
    );
  await privateDirectory(path, host);
  if (
    (await manifest(path, false, host)).fingerprint !==
    journal.publicationFingerprint
  )
    throw new InternalRootMigrationRefused(
      'source-changed',
      `Sealed tree ${JSON.stringify(path)} changed during publication. Preserve both roots and the journal for teammate-assisted recovery.`,
    );
  // The recursive scan can be long; do not use its pre-scan path observations.
  if (
    !matchesInternalRootNodeIdentity(
      await inodeAt(path, await statIfPresent(path)),
      journal.publicationIdentity,
      hostOperatingSystem(),
    ) ||
    (await statIfPresent(
      path === staging ? journal.identity.destination : staging,
    ))
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      `Destination ${JSON.stringify(journal.identity.destination)} or staging ${JSON.stringify(staging)} changed during verification. Preserve both trees for recovery.`,
    );
  return path;
}

export async function publishInternalRoot(
  journal: InternalRootJournal,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const path = await internalRootPublicationRoot(journal, host);
  if (path !== journal.identity.destination)
    await renameMigrationDirectory(
      path,
      journal.identity.destination,
      journal.publicationIdentity,
      host,
    );
  await flush(dirname(journal.identity.destination));
  await flush(journal.identity.coordination);
}

/** Only an explicitly journaled rebuild may discard the previous destination. */
export async function discardInternalRootDestination(
  journal: InternalRootJournal,
  checkOnly = false,
  host: InternalRootFilesystemHost = DEFAULT_FILESYSTEM_HOST,
): Promise<void> {
  const destination = journal.identity.destination;
  const discarded = join(journal.identity.coordination, 'discarding');
  const to = await statIfPresent(destination);
  const old = await statIfPresent(discarded);
  if (to && old)
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Both destination and discarded tree exist. Preserve them for recovery.',
    );
  const path = to ? destination : discarded;
  const stat = to ?? old;
  if (!stat) return; // Interrupted deletion; rebuild intent is already durable.
  if (
    !matchesInternalRootNodeIdentity(
      await migrationNodeIdentity(path, stat),
      journal.publicationIdentity,
      hostOperatingSystem(),
    )
  )
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'Recorded destination was replaced. Never discard another installation.',
    );
  await privateDirectory(path, host);
  if (await statIfPresent(join(path, 'secure-storage')))
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Destination contains secure storage absent from the restore source. Preserve it and obtain CAN-5786 secure-relocation recovery before rebuilding.',
    );
  if (checkOnly) return;
  if (to) {
    // Never leave a partially deleted resolver candidate after interrupted rm.
    await renameMigrationDirectory(
      destination,
      discarded,
      journal.publicationIdentity,
      host,
    );
    await flush(dirname(destination));
    await flush(journal.identity.coordination);
  }
  if (hostOperatingSystem() !== 'darwin')
    await manifest(discarded, false, host);
  if (hostOperatingSystem() === 'win32') {
    if (!journal.publicationIdentity)
      refuseLayout('Missing recorded publication identity.');
    windowsFilesystem(host).removeRecordedTree(
      discarded,
      journal.publicationIdentity,
    );
  } else await removeTreeWithProgress(discarded);
  await flush(journal.identity.coordination);
}

async function replaceMigrationFile(
  from: string,
  to: string,
  host: InternalRootFilesystemHost,
): Promise<void> {
  if (hostOperatingSystem() !== 'win32') {
    await rename(from, to);
    return;
  }
  if (await statIfPresent(to)) {
    const windows = windowsFilesystem(host);
    windows.finish(to, from);
    windows.replace(from, to);
    return;
  }
  const result = await hostPlatformServices(
    createPlatformEndpointServices('win32'),
  ).secureFiles.rename({ from, to, mode: 'replace' });
  if (result.kind !== 'renamed' || result.sourceState !== 'removed')
    refuseLayout(
      'Metadata replacement could not be confirmed. Preserve the journal.',
    );
}

/** Shared with classification in the repair composition; no lexical slash test. */
export { isWithin as isWithinInternalRoot } from '@canopy/core-runtime/node/relocation/transition';

async function renameMigrationDirectory(
  from: string,
  to: string,
  identity: string | undefined,
  host: InternalRootFilesystemHost,
): Promise<void> {
  if (hostOperatingSystem() !== 'linux') {
    await rename(from, to);
    return;
  }
  if (!host.renameNoReplace || !identity)
    refuseLayout(
      'Linux no-replace directory publication is unavailable. Preserve both trees.',
    );
  try {
    host.renameNoReplace(from, to, identity);
  } catch {
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'No-replace directory rename refused. Preserve both trees and the journal for recovery.',
    );
  }
}
