import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Parser, t, x } from 'tar';
import { hashCursorRuntime } from './runtime-hash';
import {
  MAX_RUNTIME_ENTRIES,
  MAX_UNPACKED_BYTES,
} from '@canopy/desktop-shared/lib/cursor-runtime-limits';
import type { CursorRuntimeTarget } from '@canopy/desktop-shared/lib/cursor-runtime-targets';
import type { CursorLaunch } from '@canopy/desktop-shared/node/cursor/runtime-launch';
import { extractCursorZip } from '@canopy/desktop-shared/node/cursor/zip-archive';
import type { CursorRuntimeArtifact } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { allowsAutomaticCall } from '../local-only/policy';

export type { CursorRuntimeArtifact };
export type CursorInstallPhase = 'downloading' | 'verifying' | 'installing';

/**
 * How to start the installed runtime. Windows ships no `cursor-agent` binary,
 * so its launcher is `node.exe` plus the `index.js` its `.cmd`/`.ps1` wrappers
 * would have run; modelling that as command + prefix keeps every spawn site on
 * an argv array instead of a shell string.
 *
 * Re-exported rather than redeclared. Two structurally identical declarations
 * compile, which is exactly why the duplicate survived the extraction — and
 * why the next field added to one of them would not.
 */
export type { CursorLaunch };

interface InstallerOptions {
  root: string;
  artifact: CursorRuntimeArtifact;
  target: CursorRuntimeTarget;
  fetchArchive?: typeof fetch;
  /** Only supplied by the compiled Electron test harness. */
  allowLoopback?: boolean;
}
const MAX_FILES = MAX_RUNTIME_ENTRIES;
const ARCHIVE_ROOT = 'dist-package';
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Inert until install/verify is requested. Does not use the vendor's global installer. */
export class CursorRuntimeInstaller {
  private installing?: Promise<CursorLaunch>;
  readonly directory: string;
  constructor(private readonly options: InstallerOptions) {
    if (!/^[a-zA-Z0-9.-]+$/.test(options.artifact.version))
      throw new Error('Invalid Cursor runtime version.');
    this.directory = join(options.root, options.artifact.version);
  }

  private get launch(): CursorLaunch {
    const resolved = this.options.target.launch.map((name) =>
      join(this.directory, name),
    );
    const [command, ...prefix] = resolved;
    if (!command) throw new Error('Cursor runtime target has no launcher.');
    return { command, prefix };
  }

  async isInstalled(): Promise<boolean> {
    try {
      for (const name of this.options.target.required) {
        const launcher = join(this.directory, name);
        const entry = await lstat(launcher);
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        // Zip archives carry no mode bits, so only targets that declare an
        // executable expect the execute bit to survive extraction.
        if (this.options.target.executables.includes(name))
          await access(launcher, constants.X_OK);
      }
      return true;
    } catch (error) {
      if (missing(error)) return false;
      // A slot left as a file or a symlink loop is "not installed" so the
      // atomic replacement path can repair it.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' ||
          error.code === 'ENOTDIR' ||
          error.code === 'ELOOP')
      )
        return false;
      throw error;
    }
  }

  /**
   * Best-effort removal of previous versions and backups orphaned by an
   * interrupted repair. Only the pinned version and the live stage survive.
   */
  private async pruneObsolete(stage: string): Promise<void> {
    const keep = new Set([this.options.artifact.version, basename(stage)]);
    try {
      for (const entry of await readdir(this.options.root)) {
        if (keep.has(entry)) continue;
        await rm(join(this.options.root, entry), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      /* Cleanup must never fail a successful installation. */
    }
  }

  private async fingerprint(
    directory: string,
    signal: AbortSignal,
  ): Promise<string> {
    return hashCursorRuntime(
      {
        path: directory,
        kind: 'directory',
        maxBytes: MAX_UNPACKED_BYTES,
        maxEntries: MAX_FILES,
        executables: this.options.target.executables,
      },
      signal,
    );
  }

  async verify(signal: AbortSignal): Promise<CursorLaunch> {
    try {
      if (
        (await this.fingerprint(this.directory, signal)) ===
        this.options.artifact.filesSha256
      )
        return this.launch;
    } catch {
      // Missing versions and unreadable files need the same explicit repair flow
      // as a digest mismatch. Never surface private filesystem paths in chat.
      signal.throwIfAborted();
    }
    throw new Error(
      'Cursor runtime verification failed. Reconnect Cursor to restore it.',
    );
  }

  private validateDownload(url: string): void {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      !(
        (parsed.protocol === 'https:' &&
          parsed.hostname === 'downloads.cursor.com') ||
        (this.options.allowLoopback &&
          parsed.protocol === 'http:' &&
          parsed.hostname === '127.0.0.1')
      )
    )
      throw new Error('Cursor download address is invalid.');
  }

  private async download(
    file: string,
    signal: AbortSignal,
    progress: (phase: CursorInstallPhase, percent?: number) => void,
  ): Promise<void> {
    let url = this.options.artifact.url;
    const fetchArchive = this.options.fetchArchive ?? fetch;
    for (let redirect = 0; redirect <= 3; redirect++) {
      this.validateDownload(url);
      const response = await fetchArchive(url, { signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Cursor download redirect is invalid.');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(
          'Could not download Cursor. Check your connection and try again.',
        );
      }
      let bytes = 0;
      let lastPercent = -1;
      const limit = this.options.artifact.archiveBytes;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          bytes += chunk.length;
          if (bytes > limit) {
            callback(new Error('Cursor download verification failed.'));
            return;
          }
          const percent = Math.floor((bytes / limit) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            progress('downloading', percent);
          }
          callback(null, chunk);
        },
      });
      const reader = response.body.getReader();
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            if (result.done) return;
            yield result.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      };
      await pipeline(
        Readable.from(chunks()),
        meter,
        createWriteStream(file, { mode: 0o600, flags: 'wx' }),
        { signal },
      );
      progress('verifying');
      if (
        (await hashCursorRuntime(
          { path: file, kind: 'file', maxBytes: limit, maxEntries: MAX_FILES },
          signal,
        )) !== this.options.artifact.sha256
      )
        throw new Error(
          'Cursor download verification failed. Try connecting again.',
        );
      return;
    }
    throw new Error('Cursor download redirected too many times.');
  }

  install(
    signal: AbortSignal,
    progress: (phase: CursorInstallPhase, percent?: number) => void,
  ): Promise<CursorLaunch> {
    this.installing ??= this.performInstall(signal, progress).finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }

  private async performInstall(
    signal: AbortSignal,
    progress: (phase: CursorInstallPhase, percent?: number) => void,
  ): Promise<CursorLaunch> {
    signal.throwIfAborted();
    if (await this.isInstalled()) {
      try {
        return await this.verify(signal);
      } catch {
        signal.throwIfAborted();
      }
    }
    // A local-only build never downloads the Cursor runtime, so reconnecting
    // can't repair it; say so instead of pointing at reconnect.
    if (!allowsAutomaticCall('runtime.cursor-download')) {
      throw new Error(
        "Cursor runtime isn't installed, and this build doesn't download it.",
      );
    }
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.options.root)).isSymbolicLink())
      throw new Error('Cursor runtime directory is invalid.');
    await this.sweepStaleStages();
    const stage = await mkdtemp(join(this.options.root, '.install-'));
    const archive = join(stage, `download.${this.options.target.archive}`);
    const unpacked = join(stage, 'runtime');
    try {
      progress('downloading', 0);
      await this.download(archive, signal, progress);
      signal.throwIfAborted();
      if (this.options.target.archive === 'zip') {
        progress('installing');
        // The zip extractor creates its own destination and applies the same
        // entry policy as the tar path, writing nothing until every entry has
        // passed it.
        await extractCursorZip({
          archive,
          destination: unpacked,
          root: ARCHIVE_ROOT,
          maxEntries: MAX_FILES,
          maxBytes: MAX_UNPACKED_BYTES,
          signal,
        });
        return await this.promote(unpacked, stage, signal);
      }
      let invalid = false;
      let entries = 0;
      let size = 0;
      const paths = new Set<string>();
      // tar's parsers expose abort() but no destroy(): the pipeline signal
      // stops the read, and the abort listener stops the parser itself.
      await this.stream(
        archive,
        t({
          strict: true,
          onReadEntry(entry): void {
            const name = entry.path.replace(/\/$/, '');
            size += entry.size;
            if (
              ++entries > MAX_FILES ||
              size > MAX_UNPACKED_BYTES ||
              !['File', 'Directory'].includes(entry.type) ||
              !(name === ARCHIVE_ROOT || name.startsWith(`${ARCHIVE_ROOT}/`)) ||
              name.includes('\\') ||
              name.split('/').includes('..') ||
              posix.normalize(name) !== name ||
              paths.has(name)
            )
              invalid = true;
            paths.add(name);
          },
        }),
        signal,
      );
      if (invalid) throw new Error('Cursor archive contains invalid entries.');
      signal.throwIfAborted();
      progress('installing');
      await mkdir(unpacked, { mode: 0o700 });
      // Download digest and entry topology are checked before extracting any entry.
      await this.stream(
        archive,
        x({ cwd: unpacked, strip: 1, strict: true, noChmod: false }),
        signal,
      );
      return await this.promote(unpacked, stage, signal);
    } finally {
      // Entries already handed to the filesystem may still be flushing after
      // an abort; retry rather than let ENOTEMPTY replace the real outcome.
      await rm(stage, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }).catch(() => undefined);
    }
  }

  /**
   * Verify the staged tree and swap it into place atomically. Shared by both
   * archive formats so a zip install gets the same digest gate, backup, and
   * rollback as a tarball.
   */
  private async promote(
    unpacked: string,
    stage: string,
    signal: AbortSignal,
  ): Promise<CursorLaunch> {
    signal.throwIfAborted();
    if (
      (await this.fingerprint(unpacked, signal)) !==
      this.options.artifact.filesSha256
    )
      throw new Error('Cursor runtime verification failed.');
    signal.throwIfAborted();
    const backup = join(this.options.root, `.replaced-${randomUUID()}`);
    let replaced = false;
    try {
      await rename(this.directory, backup);
      replaced = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      await rename(unpacked, this.directory);
    } catch (error) {
      if (replaced) await rename(backup, this.directory);
      throw error;
    }
    if (replaced) await rm(backup, { recursive: true, force: true });
    await this.pruneObsolete(stage);
    return this.launch;
  }

  /**
   * Drive a tar parser from the archive file. The pipeline signal destroys the
   * read stream, and because tar parsers offer abort() rather than destroy(),
   * the same signal aborts the parser so no further entries are written. The
   * parser is awaited to settle before returning so cleanup never races it.
   */
  private async stream(
    archive: string,
    parser: Parser,
    signal: AbortSignal,
  ): Promise<void> {
    const settled = new Promise<void>((resolve) => {
      for (const event of ['end', 'finish', 'close', 'error', 'abort'])
        parser.once(event, () => resolve());
    });
    const stop = (): void => {
      parser.abort(new Error('Cursor setup stopped.'));
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      await pipeline(createReadStream(archive), parser, { signal });
    } finally {
      signal.removeEventListener('abort', stop);
      await Promise.race([
        settled,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }

  /** Reclaim stage directories orphaned by an earlier crash or cancel. */
  private async sweepStaleStages(): Promise<void> {
    try {
      for (const entry of await readdir(this.options.root)) {
        if (!entry.startsWith('.install-')) continue;
        await rm(join(this.options.root, entry), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    } catch {
      /* Cleanup must never block a fresh installation attempt. */
    }
  }
}
