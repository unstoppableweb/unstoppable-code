import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  SpeechModelInstallError,
  type CoreDictationHost,
  type SpeechModelInstallProgress,
  type SpeechModelManifestEntry,
} from '@canopy/core-runtime/dictation';

/*
 * Stores the Linux dictation helper's speech models (CAN-7231):
 *
 *   <models dir>/<model id>/            a verified model, with .verified.json
 *   <models dir>/.staging/<model id>/   a download in progress
 *
 * Files download into staging, each is checked against its pinned sha256,
 * and only then does the directory move into place in one rename. The helper
 * is only ever given a directory whose marker matches this version's
 * manifest, so a partial or corrupt download never reaches it.
 */

/** The marker that says a directory holds a verified copy of one model. */
export const VERIFIED_MARKER = '.verified.json';
const STAGING_DIR = '.staging';
const PARTIAL_SUFFIX = '.partial';
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Report download progress at most this often. */
const PROGRESS_INTERVAL_MS = 250;

export type SpeechModelFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface DesktopDictationHostOptions {
  /** Whether this host runs a helper that needs a model: Linux only. */
  readonly supported: boolean;
  /** `<data dir>/dictation/models`. */
  readonly modelsDir: string;
  /** The download location, or null when this build has none. */
  readonly baseUrl: string | null;
  /** Fetches with the user's network settings. */
  readonly fetch: SpeechModelFetch;
}

interface VerifiedMarker {
  readonly id: string;
  readonly files: readonly {
    readonly path: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }[];
  readonly verifiedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fileName(path: string): string {
  const name = posix.basename(path);
  if (!FILE_NAME.test(name)) {
    throw new SpeechModelInstallError(
      'storage',
      `The speech model lists an unusable file name: ${name}`,
    );
  }
  return name;
}

function checkId(id: string): string {
  if (!MODEL_ID.test(id)) {
    throw new SpeechModelInstallError(
      'storage',
      `The speech model has an unusable id: ${id}`,
    );
  }
  return id;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function sha256Of(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) {
    if (chunk instanceof Buffer) hash.update(chunk);
  }
  return hash.digest('hex');
}

function abortError(): Error {
  const error = new Error('The download was stopped.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted || (error instanceof Error && error.name === 'AbortError')
  );
}

/** A `file:` download location, for local development only. */
async function* fileChunks(
  path: string,
  start: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path, { start, signal })) {
    if (chunk instanceof Buffer) yield chunk;
  }
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function createDesktopDictationHost(
  options: DesktopDictationHostOptions,
): CoreDictationHost {
  const { modelsDir, baseUrl } = options;
  const stagingRoot = join(modelsDir, STAGING_DIR);

  async function readMarker(directory: string): Promise<VerifiedMarker | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, VERIFIED_MARKER), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'id' in parsed &&
        'files' in parsed &&
        typeof parsed.id === 'string' &&
        Array.isArray(parsed.files)
      ) {
        const files: unknown[] = parsed.files;
        return {
          id: parsed.id,
          files: files.flatMap((file) =>
            isRecord(file) &&
            typeof file.path === 'string' &&
            typeof file.sizeBytes === 'number' &&
            typeof file.sha256 === 'string'
              ? [
                  {
                    path: file.path,
                    sizeBytes: file.sizeBytes,
                    sha256: file.sha256,
                  },
                ]
              : [],
          ),
          verifiedAt: 'verifiedAt' in parsed ? String(parsed.verifiedAt) : '',
        };
      }
    } catch {
      // Missing or unreadable: not verified.
    }
    return null;
  }

  async function isInstalled(
    entry: SpeechModelManifestEntry,
  ): Promise<boolean> {
    if (!MODEL_ID.test(entry.id)) return false;
    const directory = join(modelsDir, entry.id);
    const marker = await readMarker(directory);
    if (!marker || marker.id !== entry.id) return false;
    if (marker.files.length !== entry.files.length) return false;
    for (const [index, file] of entry.files.entries()) {
      const recorded = marker.files[index];
      if (
        !recorded ||
        recorded.path !== file.path ||
        recorded.sizeBytes !== file.sizeBytes ||
        recorded.sha256 !== file.sha256
      ) {
        return false;
      }
      // The marker's own check stands for the content; a missing or
      // truncated file still disqualifies the directory.
      if (
        (await sizeOf(join(directory, fileName(file.path)))) !== file.sizeBytes
      ) {
        return false;
      }
    }
    return true;
  }

  async function listIds(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && MODEL_ID.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async function download(
    url: string,
    partial: string,
    offset: number,
    fileSize: number,
    signal: AbortSignal,
    onBytes: (count: number, restarted: boolean) => void,
  ): Promise<void> {
    let append: boolean;
    let chunks: AsyncGenerator<Uint8Array>;
    // A failed write also stops the read: the pipeline can't settle while
    // the source waits on a stalled network read, and only cancelling the
    // reader releases it.
    const stopReading = new AbortController();
    const readSignal = AbortSignal.any([signal, stopReading.signal]);
    if (url.startsWith('file:')) {
      const path = fileURLToPath(url);
      if ((await sizeOf(path)) === null) {
        throw new SpeechModelInstallError(
          'network',
          `The speech model download has no file at ${url}.`,
        );
      }
      append = offset > 0;
      chunks = fileChunks(path, offset, readSignal);
    } else {
      const headers: Record<string, string> =
        offset > 0 ? { Range: `bytes=${offset}-` } : {};
      let response: Response;
      try {
        response = await options.fetch(url, { headers, signal });
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        throw new SpeechModelInstallError(
          'network',
          `Couldn't reach the speech model download: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const rangeStart = Number(
        /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1],
      );
      if (offset > 0 && response.status === 206 && rangeStart === offset) {
        append = true;
      } else if (offset > 0 && response.status === 206) {
        // A range from somewhere else: drop it and fetch the whole file.
        await response.body?.cancel().catch(() => {});
        await rm(partial, { force: true });
        onBytes(-offset, true);
        await download(url, partial, 0, fileSize, signal, onBytes);
        return;
      } else if (
        response.status === 200 ||
        (response.status === 206 && rangeStart === 0)
      ) {
        // The whole file: a server that ignored the range starts it again.
        append = false;
        onBytes(-offset, true);
      } else {
        throw new SpeechModelInstallError(
          'network',
          `The speech model download answered HTTP ${response.status}.`,
        );
      }
      if (!response.body) {
        throw new SpeechModelInstallError(
          'network',
          'The speech model download returned no data.',
        );
      }
      // A captive portal or proxy page answers with something else entirely;
      // catch it before it is written over the partial file.
      const length = response.headers.get('content-length');
      const remaining = fileSize - (append ? offset : 0);
      if (length !== null && Number(length) !== remaining) {
        await response.body.cancel().catch(() => {});
        throw new SpeechModelInstallError(
          'network',
          `The speech model download sent ${length} bytes where ${remaining} were expected. Check the network connection and try again.`,
        );
      }
      chunks = responseChunks(response.body, readSignal);
    }
    // A failure reading the download is a network failure; anything the
    // pipeline reports otherwise came from writing the file.
    // Never write past the file's pinned size, whatever the source sends.
    const limit = fileSize - (append ? offset : 0);
    async function* counted(): AsyncGenerator<Uint8Array> {
      let written = 0;
      try {
        for await (const chunk of chunks) {
          const room = limit - written;
          const piece =
            chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          written += piece.byteLength;
          onBytes(piece.byteLength, false);
          yield piece;
          if (piece.byteLength < chunk.byteLength) {
            throw new SpeechModelInstallError(
              'network',
              'The speech model download sent more data than expected.',
            );
          }
        }
      } catch (error) {
        if (error instanceof SpeechModelInstallError) throw error;
        if (isAbort(error, signal)) throw abortError();
        throw new SpeechModelInstallError(
          'network',
          `The speech model download stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      // The pipeline settles on a write error (a full disk, say) or an
      // abort as well as at the end, so an install can always be cancelled.
      const output = createWriteStream(partial, { flags: append ? 'a' : 'w' });
      output.once('error', () => stopReading.abort());
      await pipeline(Readable.from(counted()), output, { signal });
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      if (error instanceof SpeechModelInstallError) throw error;
      throw new SpeechModelInstallError(
        'storage',
        `Couldn't save the speech model: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function install(
    entry: SpeechModelManifestEntry,
    { signal, onProgress }: Parameters<CoreDictationHost['install']>[1],
  ): Promise<void> {
    if (!baseUrl) {
      throw new SpeechModelInstallError(
        'sourceUnavailable',
        'This build has no download location for the speech model.',
      );
    }
    const id = checkId(entry.id);
    const staging = join(stagingRoot, id);
    const target = join(modelsDir, id);
    try {
      await mkdir(staging, { recursive: true });
    } catch (error) {
      throw new SpeechModelInstallError(
        'storage',
        `Couldn't create the speech model folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Count what an earlier attempt already has, so progress and resume
    // start from there.
    let received = 0;
    for (const file of entry.files) {
      const name = fileName(file.path);
      const done = await sizeOf(join(staging, name));
      const partial = await sizeOf(join(staging, name + PARTIAL_SUFFIX));
      received +=
        done === file.sizeBytes ? done : Math.min(partial ?? 0, file.sizeBytes);
    }
    let progress: SpeechModelInstallProgress = {
      phase: 'downloading',
      receivedBytes: received,
      totalBytes: entry.sizeBytes,
    };
    let reportedAt = 0;
    // A report held back by the interval still goes out when the interval
    // ends, so a download that stalls after a burst shows what it has.
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      reportedAt = Date.now();
      onProgress(progress);
    };
    const report = (
      phase: SpeechModelInstallProgress['phase'],
      force: boolean,
    ): void => {
      const now = Date.now();
      progress = {
        phase,
        receivedBytes: received,
        totalBytes: entry.sizeBytes,
      };
      if (force || now - reportedAt >= PROGRESS_INTERVAL_MS) {
        flush();
      } else {
        trailing ??= setTimeout(
          flush,
          PROGRESS_INTERVAL_MS - (now - reportedAt),
        );
      }
    };
    report('downloading', true);

    try {
      for (const file of entry.files) {
        if (signal.aborted) throw abortError();
        const name = fileName(file.path);
        const finished = join(staging, name);
        // A file only gets its final name after its sha256 matched.
        if ((await sizeOf(finished)) === file.sizeBytes) continue;
        const partial = finished + PARTIAL_SUFFIX;
        let offset = (await sizeOf(partial)) ?? 0;
        if (offset > file.sizeBytes) {
          received -= file.sizeBytes;
          await rm(partial, { force: true });
          offset = 0;
        }
        if (offset < file.sizeBytes) {
          await download(
            joinUrl(baseUrl, file.path),
            partial,
            offset,
            file.sizeBytes,
            signal,
            (count) => {
              received += count;
              report('downloading', false);
            },
          );
        }
        const size = await sizeOf(partial);
        if (size !== file.sizeBytes) {
          if (size !== null && size > file.sizeBytes) {
            await rm(partial, { force: true });
            received -= size;
          }
          throw new SpeechModelInstallError(
            'network',
            `The speech model download of ${name} ended early.`,
          );
        }
        report('verifying', true);
        let digest: string;
        try {
          digest = await sha256Of(partial, signal);
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
          throw new SpeechModelInstallError(
            'storage',
            `Couldn't read ${name} to check it: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (digest !== file.sha256) {
          // Start the file over next time; never keep bytes that failed.
          await rm(partial, { force: true });
          received -= file.sizeBytes;
          report('downloading', true);
          throw new SpeechModelInstallError(
            'checksum',
            `${name} didn't match its expected checksum, so it was deleted. Try again.`,
          );
        }
        await rename(partial, finished);
        report('downloading', true);
      }

      try {
        const marker: VerifiedMarker = {
          id,
          files: entry.files.map(({ path, sizeBytes, sha256 }) => ({
            path,
            sizeBytes,
            sha256,
          })),
          verifiedAt: new Date().toISOString(),
        };
        await writeFile(
          join(staging, VERIFIED_MARKER),
          `${JSON.stringify(marker, null, 2)}\n`,
        );
        // A directory left at the target without a matching marker is stale.
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
      } catch (error) {
        throw new SpeechModelInstallError(
          'storage',
          `Couldn't install the speech model: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (trailing) clearTimeout(trailing);
    }
  }

  return {
    supported: () => options.supported,
    sourceConfigured: () => options.supported && baseUrl !== null,
    isInstalled,
    installedModelIds: async () => {
      // A directory counts only when its marker names it: a model some
      // version verified, not a leftover.
      const ids: string[] = [];
      for (const id of await listIds(modelsDir)) {
        if ((await readMarker(join(modelsDir, id)))?.id === id) ids.push(id);
      }
      return ids;
    },
    storedModelIds: async () => [
      ...new Set([
        ...(await listIds(modelsDir)),
        ...(await listIds(stagingRoot)),
      ]),
    ],
    install,
    remove: async (modelId) => {
      const id = checkId(modelId);
      await rm(join(modelsDir, id), { recursive: true, force: true });
      await rm(join(stagingRoot, id), { recursive: true, force: true });
    },
  };
}
