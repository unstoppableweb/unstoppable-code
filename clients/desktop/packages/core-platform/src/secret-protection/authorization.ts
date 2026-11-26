import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  PlatformSupervisionServices,
  PlatformSecureFileServices,
} from '@canopy/core-runtime';
import {
  createHostTrustGeneration,
  type HostLocalCapability,
} from '../prepared-trust';
import {
  compiledNativeArtifactCatalog,
  NATIVE_VAULT_FILE,
  type NativeArtifactCatalog,
} from './catalog';

export type PreparedNativeArtifact = HostLocalCapability<'native-preparation'>;
const loaders = new WeakMap<object, () => unknown>();
// A failed binding cannot reconnect through another snapshot in this process.
const runOwners = new Map<string, object>();
const OWNER_FILE = 'owner.json';
const RUN_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Canonical application storage, never the descriptor/token runtime or TMPDIR. */
export function nativeArtifactSnapshotRoot(canonicalDataRoot: string): string {
  return join(canonicalDataRoot, 'native-artifacts');
}

export interface NativeArtifactPreparationOptions {
  readonly canonicalDataRoot: string;
  /** Trusted executable layout only. Defaults to the running daemon's directory. */
  readonly distributionDirectory?: string;
  readonly supervision: Pick<PlatformSupervisionServices, 'inspectProcess'>;
  readonly secureFiles: Pick<PlatformSecureFileServices, 'permissions'>;
}

export interface NativeArtifactAuthorizer {
  /** One snapshot/attempt per daemon run. No installation reload after failure. */
  prepare(): Promise<PreparedNativeArtifact | undefined>;
  /** Retires future use; it does not unload an already mapped native image. */
  invalidate(): void;
  /** Only before load. Mapped images are retained until a later dead-owner reap. */
  dispose(): Promise<void>;
  /** Unknown/replaced/insecure entries and unverifiable owners are retained. */
  reap(): Promise<void>;
}

function sameNode(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function canonicalDirectory(directory: string): void {
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    realpathSync(directory) !== directory
  )
    throw new Error('Native artifact directory is redirected.');
  let path = parse(directory).root;
  for (const part of relative(path, directory).split(sep).filter(Boolean)) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Native artifact directory is redirected.');
  }
}

/** Bounded descriptor read: no FIFOs, links, devices, hardlinks or path reopening. */
function capture(
  path: string,
  maximum: number,
): { bytes: Buffer; identity: Stats } {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > maximum
  )
    throw new Error('Native artifact is not a bounded regular file.');
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !sameNode(before, opened) ||
      opened.size !== before.size
    )
      throw new Error('Native artifact changed.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('Native artifact was truncated.');
      offset += count;
    }
    const extra = Buffer.alloc(1);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      readSync(fd, extra, 0, 1, offset) !== 0 ||
      !sameNode(opened, current) ||
      current.nlink !== 1 ||
      after.nlink !== 1 ||
      !sameNode(opened, after) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Native artifact changed.');
    return { bytes, identity: after };
  } finally {
    closeSync(fd);
  }
}

function verify(bytes: Buffer, catalog: NativeArtifactCatalog): void {
  const member = catalog.member;
  if (
    member.state !== 'present' ||
    bytes.length !== member.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== member.sha256
  )
    throw new Error('Native artifact does not match the compiled catalog.');
}

function exclusiveWrite(path: string, bytes: Uint8Array): Stats {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface SnapshotOwner {
  readonly schema: 1;
  readonly run: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly catalogGeneration: string;
  readonly byteLength: number;
  readonly sha256: string;
}
function isOwner(value: unknown, run: string): value is SnapshotOwner {
  if (typeof value !== 'object' || value === null) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  const get = (key: string): unknown => fields[key]?.value;
  const pid = get('pid');
  const start = get('startIdentity');
  const length = get('byteLength');
  const hash = get('sha256');
  return (
    get('schema') === 1 &&
    get('run') === run &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof start === 'string' &&
    start.length > 0 &&
    start.length < 512 &&
    typeof get('catalogGeneration') === 'string' &&
    typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    length > 0 &&
    length <= 32 * 1024 * 1024 &&
    typeof hash === 'string' &&
    /^[a-f0-9]{64}$/.test(hash)
  );
}

/** Only the registry-owning loader can project a capability to its private image. */
export function loadPreparedNativeArtifact(capability: unknown): unknown {
  return typeof capability === 'object' && capability !== null
    ? loaders.get(capability)?.()
    : undefined;
}

export function createNativeArtifactAuthorizer(
  options: NativeArtifactPreparationOptions,
): NativeArtifactAuthorizer {
  const trust = createHostTrustGeneration('native-preparation');
  const root = nativeArtifactSnapshotRoot(options.canonicalDataRoot);
  let preparing: Promise<PreparedNativeArtifact | undefined> | undefined;
  let retired = false;
  let mapped = false;
  let runDirectory: string | undefined;
  let ownedDirectory: Stats | undefined;
  let ownedFile: Stats | undefined;
  let ownerBytes: Buffer | undefined;
  let ownedOwnerFile: Stats | undefined;

  async function privateNode(
    path: string,
    kind: 'file' | 'directory',
  ): Promise<void> {
    if (
      (
        await options.secureFiles.permissions({
          path,
          kind,
          mode: 'owner-only',
          action: 'verify',
          // The data root admits other accounts; the snapshot stays strict (CAN-7915).
          foreignTrustees:
            path === options.canonicalDataRoot ? 'accept' : 'refuse',
        })
      ).state !== 'private'
    )
      throw new Error('Native artifact storage is not private.');
  }
  async function storage(): Promise<void> {
    if (retired) throw new Error('Native artifact owner retired.');
    canonicalDirectory(options.canonicalDataRoot);
    await privateNode(options.canonicalDataRoot, 'directory');
    if (retired) throw new Error('Native artifact owner retired.');
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
    }
    canonicalDirectory(root);
    await privateNode(root, 'directory');
  }
  function verifyOwnedRun(): void {
    if (!runDirectory || !ownedDirectory)
      throw new Error('Native snapshot ownership unavailable.');
    canonicalDirectory(root);
    canonicalDirectory(runDirectory);
    if (!sameNode(lstatSync(runDirectory), ownedDirectory))
      throw new Error('Native snapshot directory changed.');
  }
  function removeOwned(): void {
    if (!runDirectory || !ownedDirectory || !ownerBytes) return;
    canonicalDirectory(root);
    const current = lstatSync(runDirectory);
    if (
      !sameNode(current, ownedDirectory) ||
      !current.isDirectory() ||
      !readdirSync(runDirectory).every(
        (name) => name === OWNER_FILE || name === NATIVE_VAULT_FILE,
      )
    )
      return;
    const owner = capture(join(runDirectory, OWNER_FILE), 4096);
    if (
      !ownedOwnerFile ||
      !sameNode(owner.identity, ownedOwnerFile) ||
      !owner.bytes.equals(ownerBytes)
    )
      return;
    const path = join(runDirectory, NATIVE_VAULT_FILE);
    if (ownedFile) {
      if (!sameNode(lstatSync(path), ownedFile)) return;
      unlinkSync(path);
    } else if (readdirSync(runDirectory).includes(NATIVE_VAULT_FILE)) return;
    unlinkSync(join(runDirectory, OWNER_FILE));
    rmdirSync(runDirectory);
  }
  async function prepare(): Promise<PreparedNativeArtifact | undefined> {
    try {
      const catalog = compiledNativeArtifactCatalog();
      if (
        retired ||
        !catalog ||
        catalog.member.state !== 'present' ||
        catalog.member.platform !== process.platform ||
        !catalog.member.architectures.includes(process.arch)
      )
        return undefined;
      const priorOwner = runOwners.get(catalog.generation);
      if (priorOwner && priorOwner !== trust) return undefined;
      runOwners.set(catalog.generation, trust);
      const member = catalog.member;
      const directory =
        options.distributionDirectory ?? dirname(process.execPath);
      canonicalDirectory(directory);
      const captured = capture(
        join(directory, NATIVE_VAULT_FILE),
        member.byteLength,
      );
      verify(captured.bytes, catalog);
      await storage();
      if (retired) return undefined;
      const processIdentity = await options.supervision.inspectProcess({
        pid: process.pid,
      });
      if (retired || processIdentity.state !== 'running') return undefined;
      canonicalDirectory(root);
      const run = randomUUID();
      runDirectory = join(root, run);
      mkdirSync(runDirectory, { mode: 0o700 });
      ownedDirectory = lstatSync(runDirectory);
      await privateNode(runDirectory, 'directory');
      const owner: SnapshotOwner = {
        schema: 1,
        run,
        pid: process.pid,
        startIdentity: processIdentity.startIdentity,
        catalogGeneration: catalog.generation,
        byteLength: member.byteLength,
        sha256: member.sha256,
      };
      ownerBytes = Buffer.from(JSON.stringify(owner));
      verifyOwnedRun();
      const ownerPath = join(runDirectory, OWNER_FILE);
      ownedOwnerFile = exclusiveWrite(ownerPath, ownerBytes);
      const snapshot = join(runDirectory, NATIVE_VAULT_FILE);
      verifyOwnedRun();
      ownedFile = exclusiveWrite(snapshot, captured.bytes);
      await privateNode(snapshot, 'file');
      await privateNode(ownerPath, 'file');
      function verifyOwner(): void {
        verifyOwnedRun();
        const record = capture(ownerPath, 4096);
        if (
          !ownedOwnerFile ||
          !ownerBytes ||
          !sameNode(record.identity, ownedOwnerFile) ||
          !record.bytes.equals(ownerBytes)
        )
          throw new Error('Native snapshot owner changed.');
      }
      verifyOwner();
      const sealed = capture(snapshot, member.byteLength);
      if (!sameNode(sealed.identity, ownedFile))
        throw new Error('Native snapshot replaced during preparation.');
      verify(sealed.bytes, catalog);
      if (retired) return undefined;
      const capability = trust.issue();
      let attempted = false;
      let exports: unknown;
      loaders.set(capability, (): unknown => {
        if (!trust.accepts(capability)) return undefined;
        if (attempted) return exports;
        attempted = true;
        try {
          verifyOwner();
          if (
            !runDirectory ||
            !ownedDirectory ||
            !sameNode(lstatSync(runDirectory), ownedDirectory)
          )
            return undefined;
          const current = capture(snapshot, member.byteLength);
          if (!sameNode(current.identity, sealed.identity)) return undefined;
          if (
            process.platform !== 'win32' &&
            ((current.identity.mode & 0o7777) !== 0o600 ||
              current.identity.uid !== process.getuid?.() ||
              (lstatSync(runDirectory).mode & 0o7777) !== 0o700 ||
              (lstatSync(root).mode & 0o7777) !== 0o700 ||
              (lstatSync(options.canonicalDataRoot).mode & 0o022) !== 0)
          )
            return undefined;
          verify(current.bytes, catalog);
          const module = { exports: {} };
          // No await/callback between final validity check and native entry.
          if (!trust.accepts(capability)) return undefined;
          mapped = true;
          process.dlopen(module, snapshot);
          exports = module.exports;
        } catch {
          exports = undefined;
        }
        return exports;
      });
      return capability;
    } catch {
      return undefined;
    }
  }
  return {
    prepare: (): Promise<PreparedNativeArtifact | undefined> =>
      retired ? Promise.resolve(undefined) : (preparing ??= prepare()),
    invalidate: (): void => {
      retired = true;
      trust.invalidate();
    },
    dispose: async (): Promise<void> => {
      retired = true;
      trust.invalidate();
      await preparing;
      if (!mapped) {
        try {
          removeOwned();
        } catch {
          /* Unknown or replaced artifacts are retained. */
        }
      }
    },
    reap: async (): Promise<void> => {
      try {
        await storage();
      } catch {
        return;
      }
      for (const run of readdirSync(root).slice(0, 256)) {
        if (retired) return;
        if (!RUN_NAME.test(run)) continue;
        const directory = join(root, run);
        try {
          canonicalDirectory(directory);
          await privateNode(directory, 'directory');
          const identity = lstatSync(directory);
          const names = readdirSync(directory).sort();
          if (
            JSON.stringify(names) !==
            JSON.stringify([NATIVE_VAULT_FILE, OWNER_FILE].sort())
          )
            continue;
          await privateNode(join(directory, OWNER_FILE), 'file');
          await privateNode(join(directory, NATIVE_VAULT_FILE), 'file');
          const owner = capture(join(directory, OWNER_FILE), 4096);
          const parsed: unknown = JSON.parse(owner.bytes.toString('utf8'));
          if (!isOwner(parsed, run)) continue;
          if (retired) return;
          const observed = await options.supervision.inspectProcess({
            pid: parsed.pid,
          });
          if (retired) return;
          if (observed.state !== 'absent') continue;
          // PID reuse, an unknown observer and a live owner never authorize deletion.
          const snapshot = capture(
            join(directory, NATIVE_VAULT_FILE),
            parsed.byteLength,
          );
          if (
            snapshot.bytes.length !== parsed.byteLength ||
            createHash('sha256').update(snapshot.bytes).digest('hex') !==
              parsed.sha256 ||
            !sameNode(lstatSync(directory), identity) ||
            !capture(join(directory, OWNER_FILE), 4096).bytes.equals(
              owner.bytes,
            )
          )
            continue;
          unlinkSync(join(directory, NATIVE_VAULT_FILE));
          unlinkSync(join(directory, OWNER_FILE));
          rmdirSync(directory);
        } catch {
          /* Retain unknown ownership and sharing violations for a later run. */
        }
      }
    },
  };
}
