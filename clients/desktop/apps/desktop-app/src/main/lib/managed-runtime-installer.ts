import { ReadableStream } from 'node:stream/web';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'tar';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { verifyManagedExecutable } from '@canopy/desktop-shared/node/managed-runtime/verification';
import { allowsAutomaticCall } from '../local-only/policy';

export interface ManagedRuntimeArtifact {
  version: string;
  url: string;
  integrity: string;
  archiveBytes: number;
  executableSha256: string;
}

/**
 * Where a runtime is downloaded from. npm tarballs are fetched with redirects
 * refused. A GitHub release download always redirects to GitHub's release
 * storage, so those hops are followed by hand and each one is checked.
 */
export type ManagedRuntimeSource = 'npm' | 'github-release';
export type ManagedRuntimeArchiveFormat = 'tgz' | 'zip';

const GITHUB_RELEASE_STORAGE_HOSTS: ReadonlySet<string> = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const MAX_DOWNLOAD_REDIRECTS = 3;
const MAX_EXECUTABLE_BYTES = 600 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;

// Apply the same portable segment rules before either install or verify uses
// these components. Windows also treats trailing dots and device names specially.
function isSafeRuntimePathSegment(value: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !value.endsWith('.') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}

export class ManagedRuntimeInstaller {
  readonly directory: string;
  readonly executable: string;
  private installing?: Promise<string>;

  constructor(
    private readonly options: {
      root: string;
      artifact: ManagedRuntimeArtifact;
      executableName: string;
      label: string;
      archivePath?: string;
      /** Defaults to `npm`. */
      source?: ManagedRuntimeSource;
      /** Defaults to `tgz`. */
      archiveFormat?: ManagedRuntimeArchiveFormat;
      fetchArchive?: typeof fetch;
      allowLoopback?: boolean;
    },
  ) {
    if (!isSafeRuntimePathSegment(options.artifact.version))
      throw new Error(`Invalid ${this.options.label} runtime version.`);
    if (!isSafeRuntimePathSegment(options.executableName))
      throw new Error(`Invalid ${this.options.label} executable name.`);
    this.directory = join(options.root, options.artifact.version);
    this.executable = join(this.directory, options.executableName);
  }

  async isInstalled(): Promise<boolean> {
    try {
      return (
        (await lstat(this.directory)).isDirectory() &&
        (await lstat(this.executable)).isFile()
      );
    } catch {
      return false;
    }
  }

  async verify(signal: AbortSignal): Promise<string> {
    if (!(await this.isInstalled()))
      throw new Error(
        `Connect ${this.options.label} in Settings to install its runtime.`,
      );
    await verifyManagedExecutable(
      this.executable,
      this.options.artifact.executableSha256,
      signal,
      this.options.label,
    );
    return this.executable;
  }

  install(
    signal: AbortSignal,
    progress: (
      phase: 'downloading' | 'verifying' | 'installing',
      percent?: number,
    ) => void,
  ): Promise<string> {
    this.installing ??= this.installOnce(signal, progress)
      .then(async (executable) => {
        await this.pruneObsolete();
        return executable;
      })
      .finally(() => {
        this.installing = undefined;
      });
    return this.installing;
  }

  private async pruneObsolete(): Promise<void> {
    const entries = await readdir(this.options.root).catch(() => []);
    for (const name of entries) {
      if (name === this.options.artifact.version) continue;
      await rm(join(this.options.root, name), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  private async installOnce(
    signal: AbortSignal,
    progress: (
      phase: 'downloading' | 'verifying' | 'installing',
      percent?: number,
    ) => void,
  ): Promise<string> {
    signal.throwIfAborted();
    if (await this.isInstalled()) {
      try {
        return await this.verify(signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    // A local-only build never downloads a runtime, so reconnecting can't
    // repair a missing one; say so instead of pointing at Settings.
    if (!allowsAutomaticCall('runtime.npm-download')) {
      throw new Error(
        `${this.options.label} runtime isn't installed, and this build doesn't download it.`,
      );
    }
    const { artifact, label } = this.options;
    const url = new URL(artifact.url);
    if (
      !this.isTrustedDownload(url, 'start') ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.integrity) ||
      !Number.isSafeInteger(artifact.archiveBytes) ||
      artifact.archiveBytes <= 0 ||
      artifact.archiveBytes > 350 * 1024 * 1024
    )
      throw new Error(
        `Invalid ${this.options.label} runtime download metadata.`,
      );
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.options.root)).isDirectory())
      throw new Error(`Invalid ${this.options.label} runtime directory.`);
    const stage = await mkdtemp(join(this.options.root, '.install-'));
    const backup = join(this.options.root, `.previous-${randomUUID()}`);
    let movedPrevious = false;
    try {
      progress('downloading', 0);
      const response = await this.fetchArchive(url, signal);
      if (!response.ok || !(response.body instanceof ReadableStream))
        throw new Error(`${label} download failed. Try connecting again.`);
      const archive = join(stage, `runtime.${this.archiveFormat}`);
      const hash = createHash('sha512');
      let bytes = 0;
      let lastPercent = -1;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            bytes += chunk.length;
            if (bytes > artifact.archiveBytes)
              return callback(
                new Error(`${label} archive exceeds its pinned size.`),
              );
            hash.update(chunk);
            const percent = Math.floor((bytes * 100) / artifact.archiveBytes);
            if (percent !== lastPercent) {
              lastPercent = percent;
              progress('downloading', percent);
            }
            callback(null, chunk);
          },
        }),
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      progress('verifying');
      if (
        bytes !== artifact.archiveBytes ||
        `sha512-${hash.digest('base64')}` !== artifact.integrity
      )
        throw new Error(
          `${label} download checksum did not match. Try connecting again.`,
        );
      const slot = join(stage, 'runtime');
      await mkdir(slot, { mode: 0o700 });
      const native = join(slot, this.options.executableName);
      if (this.archiveFormat === 'zip') {
        await this.extractZipExecutable(archive, native, signal);
      } else {
        await this.extractTarExecutable(archive, native, signal);
      }
      await verifyManagedExecutable(
        native,
        artifact.executableSha256,
        signal,
        label,
      );
      progress('installing');
      signal.throwIfAborted();
      try {
        await rename(this.directory, backup);
        movedPrevious = true;
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      try {
        await rename(slot, this.directory);
      } catch (error) {
        if (movedPrevious) {
          await rename(backup, this.directory);
          movedPrevious = false;
        }
        throw error;
      }
      return this.executable;
    } finally {
      await rm(stage, { recursive: true, force: true });
      if (movedPrevious) await rm(backup, { recursive: true, force: true });
    }
  }

  private get archiveFormat(): ManagedRuntimeArchiveFormat {
    return this.options.archiveFormat ?? 'tgz';
  }

  private get archiveEntryName(): string {
    return this.options.archivePath ?? `package/${this.options.executableName}`;
  }

  /**
   * Whether `url` may be fetched. `start` is the pinned address; `redirect`
   * is a hop a GitHub release download was sent to.
   */
  private isTrustedDownload(url: URL, hop: 'start' | 'redirect'): boolean {
    if (url.username || url.password) return false;
    if (
      this.options.allowLoopback === true &&
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1'
    )
      return true;
    if (url.protocol !== 'https:') return false;
    if ((this.options.source ?? 'npm') === 'npm') {
      return hop === 'start' && url.hostname === 'registry.npmjs.org';
    }
    return hop === 'start'
      ? url.hostname === 'github.com' &&
          /^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname)
      : GITHUB_RELEASE_STORAGE_HOSTS.has(url.hostname);
  }

  private async fetchArchive(url: URL, signal: AbortSignal): Promise<Response> {
    const fetchArchive = this.options.fetchArchive ?? fetch;
    if ((this.options.source ?? 'npm') === 'npm') {
      return fetchArchive(url, { signal, redirect: 'error' });
    }
    let next = url;
    for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
      const response = await fetchArchive(next, {
        signal,
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      const target = location ? new URL(location, next) : null;
      if (!target || !this.isTrustedDownload(target, 'redirect'))
        throw new Error(
          `Invalid ${this.options.label} runtime download metadata.`,
        );
      next = target;
    }
    throw new Error(
      `${this.options.label} download redirected too many times.`,
    );
  }

  private async extractTarExecutable(
    archive: string,
    native: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { label } = this.options;
    const archiveName = this.archiveEntryName;
    let extraction: Promise<void> | undefined;
    const parser = new Parser({
      strict: true,
      onReadEntry(entry): void {
        // Extract exactly one regular file to a host-selected destination;
        // archive paths, links, metadata files and npm scripts never execute.
        if (entry.path !== archiveName) {
          entry.resume();
          return;
        }
        if (
          extraction ||
          entry.type !== 'File' ||
          entry.size > MAX_EXECUTABLE_BYTES
        ) {
          parser.abort(new Error(`Invalid ${label} executable archive entry.`));
          entry.resume();
          return;
        }
        extraction = pipeline(
          entry,
          createWriteStream(native, { flags: 'wx', mode: 0o700 }),
          { signal },
        );
        void extraction.catch((error: unknown) =>
          parser.abort(
            error instanceof Error
              ? error
              : new Error(`${label} extraction failed.`),
          ),
        );
      },
    });
    try {
      await pipeline(createReadStream(archive), parser, { signal });
    } finally {
      await extraction;
    }
    if (!extraction)
      throw new Error(`${label} archive did not contain its executable.`);
  }

  /**
   * The zip counterpart of the tar path: read the whole central directory,
   * then extract the one regular file named `archiveEntryName`. Nothing else
   * in the archive is written.
   */
  private async extractZipExecutable(
    archive: string,
    native: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { label } = this.options;
    const invalid = (): Error =>
      new Error(`Invalid ${label} executable archive entry.`);
    const zip = await new Promise<ZipFile>((resolve, reject) => {
      openZip(
        archive,
        {
          lazyEntries: true,
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        },
        (error, opened) => {
          if (error || !opened) reject(error ?? invalid());
          else resolve(opened);
        },
      );
    });
    try {
      const entries = await new Promise<Entry[]>((resolve, reject) => {
        const found: Entry[] = [];
        zip.on('entry', (entry: Entry) => {
          if (found.length >= MAX_ZIP_ENTRIES) {
            reject(invalid());
            return;
          }
          found.push(entry);
          zip.readEntry();
        });
        zip.once('end', () => resolve(found));
        zip.once('error', reject);
        zip.readEntry();
      });
      const matches = entries.filter(
        (entry) => entry.fileName === this.archiveEntryName,
      );
      if (matches.length === 0)
        throw new Error(`${label} archive did not contain its executable.`);
      const [entry] = matches;
      if (
        matches.length > 1 ||
        !entry ||
        entry.fileName.endsWith('/') ||
        entry.uncompressedSize > MAX_EXECUTABLE_BYTES ||
        // A Unix-made entry must be a regular file; links are refused.
        (entry.versionMadeBy >> 8 === 3 &&
          ((entry.externalFileAttributes >>> 16) & 0o170000) !== 0 &&
          ((entry.externalFileAttributes >>> 16) & 0o170000) !== 0o100000)
      )
        throw invalid();
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (error, opened) => {
          if (error || !opened) reject(error ?? invalid());
          else resolve(opened);
        });
      });
      await pipeline(
        stream,
        createWriteStream(native, { flags: 'wx', mode: 0o700 }),
        { signal },
      );
    } finally {
      zip.close();
    }
  }
}
