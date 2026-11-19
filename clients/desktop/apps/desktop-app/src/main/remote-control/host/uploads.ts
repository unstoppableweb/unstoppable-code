import { randomUUID } from 'node:crypto';
import { RpcPublicError } from '../transport/rpc-peer';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  REMOTE_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
} from '@canopy/desktop-shared/types';

/**
 * Files copied from another computer. On a host: files a controller sends
 * from its own disk, for example ones dropped onto a terminal; the controller
 * uploads them before the call that uses them and passes the returned paths,
 * so every path a call carries is already a path on this computer. On a
 * controller: copies of host files it opens in its own default apps.
 */
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Characters Windows rejects in file names, plus path separators.
const RESERVED_FILE_NAME_CHARACTERS = new Set([
  '\\',
  '/',
  ':',
  '*',
  '?',
  '"',
  '<',
  '>',
  '|',
]);

function isUnsafeFileNameCharacter(character: string): boolean {
  // C0 control characters (U+0000 to U+001F).
  return (
    character.charCodeAt(0) <= 0x1f ||
    RESERVED_FILE_NAME_CHARACTERS.has(character)
  );
}

/** The name a stored file is written under. */
export function safeFileName(name: string): string {
  const cleaned = name
    .split('')
    .map((character) =>
      isUnsafeFileNameCharacter(character) ? '_' : character,
    )
    .join('')
    .trim();
  const bounded = cleaned.slice(0, 200);
  return bounded.length > 0 && bounded !== '.' && bounded !== '..'
    ? bounded
    : 'attachment';
}

/** A stored file whose bytes arrive in parts. */
export interface RemoteStoredFile {
  readonly path: string;
  write: (bytes: Uint8Array) => Promise<void>;
  /** Finishes the file; its path stays valid until the files expire. */
  close: () => Promise<void>;
  /** Deletes the file and its directory. */
  discard: () => Promise<void>;
}

export interface RemoteFileStoreLimits {
  maxBytes: number;
  tooLargeMessage: string;
}

export class RemoteUploadStore {
  constructor(
    private readonly rootDir: string,
    private readonly limits: RemoteFileStoreLimits = {
      maxBytes: REMOTE_UPLOAD_MAX_BYTES,
      tooLargeMessage: REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
    },
  ) {}

  /** Stores one file and returns its path on this computer. */
  async put(
    deviceId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<string> {
    if (bytes.byteLength > this.limits.maxBytes) {
      throw new RpcPublicError(this.limits.tooLargeMessage);
    }
    const file = await this.create(deviceId, fileName);
    try {
      await file.write(bytes);
      await file.close();
    } catch (error) {
      await file.discard();
      throw error;
    }
    return file.path;
  }

  /** Creates an empty file, readable only by this user, in its own directory. */
  async create(deviceId: string, fileName: string): Promise<RemoteStoredFile> {
    // Each file gets its own directory, so files with the same name never
    // overwrite each other.
    const directory = join(this.rootDir, deviceId, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, safeFileName(fileName));
    const handle = await open(path, 'wx', 0o600);
    const { maxBytes, tooLargeMessage } = this.limits;
    let written = 0;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    return {
      path,
      write: async (bytes: Uint8Array): Promise<void> => {
        if (written + bytes.byteLength > maxBytes) {
          throw new RpcPublicError(tooLargeMessage);
        }
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.byteLength - offset,
          );
          offset += bytesWritten;
        }
        written += bytes.byteLength;
      },
      close,
      discard: async (): Promise<void> => {
        await close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  /** Deletes a file this store created, with its directory. */
  async remove(path: string): Promise<void> {
    const directory = dirname(path);
    const segments = relative(this.rootDir, directory).split(sep);
    if (segments.length !== 2 || segments.some((s) => s === '' || s === '..')) {
      throw new RpcPublicError('Not a stored file.');
    }
    await rm(directory, { recursive: true, force: true });
  }

  /** Deletes uploads older than a day. */
  async pruneExpired(now = Date.now()): Promise<void> {
    let controllers: string[];
    try {
      controllers = await readdir(this.rootDir);
    } catch {
      return;
    }
    for (const controller of controllers) {
      const controllerDir = join(this.rootDir, controller);
      let uploads: string[];
      try {
        uploads = await readdir(controllerDir);
      } catch {
        continue;
      }
      for (const upload of uploads) {
        const uploadDir = join(controllerDir, upload);
        try {
          const info = await stat(uploadDir);
          if (now - info.mtimeMs > RETENTION_MS) {
            await rm(uploadDir, { recursive: true, force: true });
          }
        } catch {
          // Removed concurrently.
        }
      }
    }
  }
}
