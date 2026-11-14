import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES,
  WORKER_ARTIFACT_QUERY_DEFINITIONS,
  WorkerArtifactDownloadReadResultSchema,
  type WorkerArtifactDownloadReadParams,
} from '@canopy/protocol/canopy-core';
import { CLOUD_SESSION_FILE_DOWNLOAD_MAX_BYTES } from '@canopy/protocol/cloud-session';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type { CloudChatFileDownloadResult } from '@canopy/desktop-shared/types';
import { z } from 'zod';
import {
  cloudChatIdOfKey,
  validIds,
  withLeasedWebCoreClient,
} from './cloud-chat-attachments';
import type { WebCoreBindingOptions } from './web-core-connection';

/**
 * Saving a cloud chat's file from Electron main (CAN-6587, from CAN-6175 R8d).
 *
 * The renderer names a cloud chat (its `web-core:` key) and one of its files:
 * an attachment or a deliverable of that chat, or a shared file of its
 * project. Main asks the user where to save it and writes the bytes there and
 * nowhere else, once it holds them all. It reads them with
 * `worker.artifact.download.read` on its own web core connection, as the
 * signed-in account, scoped to that chat or project, so the web core refuses
 * another account's file and another chat's. The renderer never names a path
 * and never sees a credential.
 */

const DOWNLOAD_TIMEOUT_MS = 120_000;

const targetSchema = z.strictObject({
  key: z.string().min(1).max(1024),
  workspaceId: z.string().min(1).max(512),
  worktreeId: z.string().min(1).max(512),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fileSchema = z.strictObject({
  kind: z.enum(['attachment', 'deliverable', 'workspace-file']),
  id: z.string().regex(UUID),
  filename: z.string().min(1).max(1024),
});

/** Reads one range of a file, or throws its protocol error. */
export type CloudChatFileReader = (
  params: WorkerArtifactDownloadReadParams,
) => Promise<unknown>;

export interface CloudChatFileDownloadOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /**
   * Asks the user where to save a file, suggesting `filename`; answers the
   * absolute path they chose, or null when they cancelled.
   */
  readonly choosePath: (filename: string) => Promise<string | null>;
  /** Runs `read` for each range on one connection, held for the download. */
  readonly withReader: <T>(
    read: (reader: CloudChatFileReader) => Promise<T>,
  ) => Promise<T>;
}

/** A name the save dialog may suggest: the last segment, never a path. */
export function suggestedFilename(filename: string): string {
  const name = path.posix.basename(filename.split('\\').join('/')).trim();
  return name === '' || name === '.' || name === '..' ? 'download' : name;
}

/** The renderer-facing reason for a failed read. */
function readFailure(
  error: unknown,
): Exclude<CloudChatFileDownloadResult, { ok: true }>['reason'] {
  const payload =
    error instanceof CanopyClientError || error instanceof CanopyTransportError
      ? error.payload
      : null;
  if (payload === null) return 'offline';
  if (payload.kind === 'unauthenticated') return 'unauthenticated';
  if (payload.kind === 'capability_unavailable') return 'disabled';
  if (payload.kind === 'not_found') return 'not_found';
  if (
    payload.kind === 'unavailable' ||
    payload.kind === 'deadline_exceeded' ||
    payload.kind === 'cancelled'
  )
    return 'offline';
  return 'rejected';
}

const invalidRange = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'internal',
    message: 'The web core returned an invalid range.',
    retry: { kind: 'never' },
  });

/**
 * One download per call: validate the target, ask for a path, read the whole
 * file (at most 100 MiB) range by range, and only then write it to that path.
 * A failed read never touches the path, so a file the user chose to replace
 * survives it.
 */
export function createCloudChatFileDownload(
  options: CloudChatFileDownloadOptions,
): (target: unknown, file: unknown) => Promise<CloudChatFileDownloadResult> {
  return async (target, file) => {
    if (!options.isEnabled()) return { ok: false, reason: 'disabled' };
    const parsedTarget = targetSchema.safeParse(target);
    const chatId = parsedTarget.success
      ? cloudChatIdOfKey(parsedTarget.data.key)
      : null;
    const parsed = fileSchema.safeParse(file);
    if (
      !parsedTarget.success ||
      chatId === null ||
      !validIds(parsedTarget.data) ||
      !parsed.success
    )
      return { ok: false, reason: 'rejected' };
    const chosen = await options.choosePath(
      suggestedFilename(parsed.data.filename),
    );
    if (chosen === null) return { ok: false, reason: 'canceled' };
    if (!path.isAbsolute(chosen)) return { ok: false, reason: 'rejected' };

    let content: Buffer;
    try {
      content = await options.withReader(async (read) => {
        const ranges: Buffer[] = [];
        let offset: number | null = 0;
        let sizeBytes: number | null = null;
        while (offset !== null) {
          const value = await read({
            artifactId: `${parsed.data.kind}:${parsed.data.id}`,
            // A chat's attachments and deliverables are its own; a shared
            // file is its project's.
            scope:
              parsed.data.kind === 'workspace-file'
                ? { workspaceId: parsedTarget.data.workspaceId }
                : { chatId },
            offset,
            length: WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES,
          });
          const range = WorkerArtifactDownloadReadResultSchema.safeParse(value);
          if (
            !range.success ||
            range.data.offset !== offset ||
            range.data.sizeBytes > CLOUD_SESSION_FILE_DOWNLOAD_MAX_BYTES ||
            (sizeBytes !== null && range.data.sizeBytes !== sizeBytes)
          )
            throw invalidRange();
          sizeBytes = range.data.sizeBytes;
          const bytes = Buffer.from(range.data.data, 'base64');
          const end = offset + bytes.byteLength;
          const next = range.data.nextOffset;
          // Each range continues the file and stays inside it; the last one
          // ends it.
          if (
            end > sizeBytes ||
            (next === null
              ? end !== sizeBytes
              : next !== end || bytes.byteLength === 0)
          )
            throw invalidRange();
          ranges.push(bytes);
          offset = next;
        }
        return Buffer.concat(ranges);
      });
    } catch (error) {
      return { ok: false, reason: readFailure(error) };
    }
    try {
      await writeFile(chosen, content);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'write_failed' };
    }
  };
}

/** Reads ranges on a connection of its own, held for one download. */
export function createWebCoreFileReader(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudChatFileDownloadOptions['withReader'] {
  return (read) =>
    withLeasedWebCoreClient(
      binding,
      {
        clientName: 'canopy-desktop-cloud-chat-files',
        clientVersion,
        label: 'Desktop cloud chat download',
        definitions: {
          queries: WORKER_ARTIFACT_QUERY_DEFINITIONS,
          // The lease the connection holds for the download.
          instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      },
      (client) =>
        read((params) => client.query('worker.artifact.download.read', params)),
    );
}
