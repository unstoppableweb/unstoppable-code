import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  REMOTE_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_TOO_LARGE_MESSAGE,
} from '@canopy/desktop-shared/types';
import { RpcPublicError } from '../transport/rpc-peer';

/**
 * Sends files picked on this computer to the other one and returns their
 * paths there. Sizes are checked before anything is read, and files are
 * read and sent one at a time, so a large selection holds at most one file
 * in memory.
 */
export async function uploadLocalFiles(
  paths: ReadonlyArray<string>,
  upload: (fileName: string, bytes: Uint8Array) => Promise<string>,
  maxBytes: number = REMOTE_UPLOAD_MAX_BYTES,
): Promise<string[]> {
  for (const path of paths) {
    if ((await stat(path)).size > maxBytes) {
      throw new RpcPublicError(REMOTE_UPLOAD_TOO_LARGE_MESSAGE);
    }
  }
  const remotePaths: string[] = [];
  for (const path of paths) {
    remotePaths.push(await upload(basename(path), await readFile(path)));
  }
  return remotePaths;
}
