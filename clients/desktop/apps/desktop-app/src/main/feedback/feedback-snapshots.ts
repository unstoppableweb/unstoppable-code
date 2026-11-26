import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { z } from 'zod';
import {
  FeedbackDiagnosticsSnapshotIdSchema,
  FeedbackReportContextSchema,
  FeedbackReportErrorSchema,
  MAX_FEEDBACK_ENTRY_PREVIEW_BYTES,
  MAX_FEEDBACK_ARCHIVE_ENTRIES,
  MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES,
  type FeedbackDiagnosticsSnapshot,
  type FeedbackDiagnosticsEntryContent,
} from '@canopy/protocol/feedback-report';
import type { FeedbackDiagnosticsPrepareRequest } from '@canopy/desktop-shared/types';
import {
  cleanupStaleTemporaryFeedbackBundles,
  prepareFeedbackBundle,
  releaseTemporaryFeedbackBundle,
} from './feedback-bundle';
import { buildFeedbackPrepareRequest } from './feedback-scope';
import {
  FeedbackArchiveSizeLimitError,
  MAX_FEEDBACK_MANIFEST_BYTES,
} from './feedback-archive';

const PrepareSchema = z
  .object({
    context: FeedbackReportContextSchema,
    error: FeedbackReportErrorSchema.optional(),
  })
  .strict();
const ManifestSchema = z.object({
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  inventorySummary: z
    .object({
      includedFilesOmitted: z.number().int().nonnegative(),
      skippedFilesOmitted: z.number().int().nonnegative(),
      skippedFileReasons: z.record(z.string(), z.number().int().nonnegative()),
    })
    .optional(),
});
const LIFETIME_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS = 8;

interface Snapshot {
  owner: string;
  scope: string;
  path: string;
  metadata: FeedbackDiagnosticsSnapshot;
  users: number;
  released: boolean;
  timer: ReturnType<typeof setTimeout>;
}
const snapshots = new Map<string, Snapshot>();
let preparing = 0;

function scopeKey(request: FeedbackDiagnosticsPrepareRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(PrepareSchema.parse(request)))
    .digest('hex');
}

function zipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    openZip(path, { lazyEntries: true, autoClose: false }, (error, zip) =>
      error || !zip
        ? reject(error ?? new Error('Diagnostics archive could not be opened'))
        : resolve(zip),
    ),
  );
}

async function inventory(path: string): Promise<Entry[]> {
  const zip = await zipFile(path);
  try {
    return await new Promise((resolve, reject) => {
      const entries: Entry[] = [];
      let size = 0;
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        size += entry.uncompressedSize;
        if (
          entries.length >= MAX_FEEDBACK_ARCHIVE_ENTRIES ||
          size > MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES ||
          entry.fileName.startsWith('/') ||
          entry.fileName.includes('\\') ||
          entry.fileName.split('/').some((part) => part === '..') ||
          entries.some((item) => item.fileName === entry.fileName)
        ) {
          reject(
            new Error('Diagnostics archive exceeds the inspection limits'),
          );
          return;
        }
        entries.push(entry);
        zip.readEntry();
      });
      zip.once('end', () => resolve(entries));
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function readEntry(
  path: string,
  name: string,
  limit: number,
): Promise<Buffer> {
  const zip = await zipFile(path);
  try {
    return await new Promise((resolve, reject) => {
      let found = false;
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName !== name) {
          zip.readEntry();
          return;
        }
        found = true;
        if (entry.uncompressedSize > limit) {
          reject(new Error('Diagnostics entry exceeds the inspection limit'));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error('Diagnostics entry could not be read'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              stream.destroy(
                new Error('Diagnostics entry exceeds the inspection limit'),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.once('error', reject);
          stream.once('end', () => resolve(Buffer.concat(chunks)));
        });
      });
      zip.once('end', () => {
        if (!found) reject(new Error('Diagnostics entry not found'));
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function dispose(id: string, snapshot: Snapshot): Promise<void> {
  if (snapshot.users > 0 || snapshots.get(id) !== snapshot) return;
  snapshots.delete(id);
  clearTimeout(snapshot.timer);
  try {
    await rm(snapshot.path, { force: true });
  } finally {
    releaseTemporaryFeedbackBundle(snapshot.path);
  }
}

/** Process-local opaque tokens expire across restart; leftover archives use the existing stale sweep. */
export async function prepareFeedbackDiagnostics(
  owner: string,
  input: FeedbackDiagnosticsPrepareRequest,
): Promise<FeedbackDiagnosticsSnapshot> {
  const request = PrepareSchema.parse(input);
  if (snapshots.size + preparing >= MAX_SNAPSHOTS)
    throw new Error(
      'Close an existing diagnostics preview before preparing another.',
    );
  preparing += 1;
  let bundlePath: string | undefined;
  try {
    await cleanupStaleTemporaryFeedbackBundles().catch(() => undefined);
    const prepareRequest = buildFeedbackPrepareRequest(request);
    const bundle = await prepareFeedbackBundle(prepareRequest, {
      destination: 'temp',
      allowEmptyDescription: true,
      bounded: true,
    }).catch((error: unknown) => {
      if (!(error instanceof FeedbackArchiveSizeLimitError)) throw error;
      // The collector removes failed output before rejecting. Retry before
      // previewing anything; an inspected snapshot is never rebuilt at send.
      return prepareFeedbackBundle(prepareRequest, {
        destination: 'temp',
        allowEmptyDescription: true,
        bounded: true,
        includeCrashDumps: false,
      }).catch((retryError: unknown) => {
        if (!(retryError instanceof FeedbackArchiveSizeLimitError))
          throw retryError;
        return prepareFeedbackBundle(prepareRequest, {
          destination: 'temp',
          allowEmptyDescription: true,
          bounded: true,
          includeCrashDumps: false,
          oversizedRetryContext: request.context,
        });
      });
    });
    bundlePath = bundle.absolutePath;
    const entries = await inventory(bundlePath);
    const manifest = new TextDecoder('utf-8', { fatal: true }).decode(
      await readEntry(bundlePath, 'feedback.json', MAX_FEEDBACK_MANIFEST_BYTES),
    );
    const parsed = ManifestSchema.parse(JSON.parse(manifest));
    const skippedEntries = parsed.skippedFiles;
    if (parsed.inventorySummary) {
      const summary = parsed.inventorySummary;
      const reasons = Object.entries(summary.skippedFileReasons)
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(', ');
      // Names omitted from the manifest still appear in the ZIP inventory.
      skippedEntries.push({
        path: 'Inventory summary',
        reason: `List shortened: ${summary.includedFilesOmitted} included file names and ${summary.skippedFilesOmitted} skipped-path records omitted from the manifest lists. Full included file list is in the archive. Skip reason totals: ${reasons || 'none'}.`,
      });
    }
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + LIFETIME_MS).toISOString();
    const metadata: FeedbackDiagnosticsSnapshot = {
      id,
      preparedAt: bundle.createdAt,
      expiresAt,
      sizeBytes: bundle.sizeBytes,
      entries: entries.map((entry) => ({
        path: entry.fileName,
        sizeBytes: entry.uncompressedSize,
      })),
      skippedEntries,
      manifest,
    };
    const snapshot: Snapshot = {
      owner,
      scope: scopeKey(request),
      path: bundlePath,
      metadata,
      users: 0,
      released: false,
      timer: setTimeout(() => {
        snapshot.released = true;
        void dispose(id, snapshot).catch(() => undefined);
      }, LIFETIME_MS),
    };
    snapshot.timer.unref();
    snapshots.set(id, snapshot);
    bundlePath = undefined;
    return structuredClone(metadata);
  } finally {
    preparing -= 1;
    if (bundlePath) {
      await rm(bundlePath, { force: true }).catch(() => undefined);
      releaseTemporaryFeedbackBundle(bundlePath);
    }
  }
}

/** Leases pin an immutable archive through concurrent save/upload/release. */
export async function withFeedbackDiagnostics<T>(
  owner: string,
  id: string,
  action: (path: string, metadata: FeedbackDiagnosticsSnapshot) => Promise<T>,
  scope?: FeedbackDiagnosticsPrepareRequest,
): Promise<T> {
  FeedbackDiagnosticsSnapshotIdSchema.parse(id);
  const snapshot = snapshots.get(id);
  if (
    !snapshot ||
    snapshot.owner !== owner ||
    snapshot.released ||
    Date.parse(snapshot.metadata.expiresAt) <= Date.now()
  )
    throw new Error(
      'Diagnostics expired or are unavailable. Prepare a new preview.',
    );
  if (scope && scopeKey(scope) !== snapshot.scope)
    throw new Error(
      'Report context changed. Prepare a new diagnostics preview.',
    );
  snapshot.users += 1;
  try {
    return await action(snapshot.path, structuredClone(snapshot.metadata));
  } finally {
    snapshot.users -= 1;
    if (snapshot.released) await dispose(id, snapshot).catch(() => undefined);
  }
}

export async function readFeedbackDiagnosticsEntry(
  owner: string,
  id: string,
  entryPath: string,
): Promise<FeedbackDiagnosticsEntryContent> {
  return withFeedbackDiagnostics(owner, id, async (path, metadata) => {
    const entry = metadata.entries.find((item) => item.path === entryPath);
    if (!entry) throw new Error('Diagnostics entry not found');
    if (entry.sizeBytes > MAX_FEEDBACK_ENTRY_PREVIEW_BYTES)
      return { kind: 'download-required', reason: 'too-large' };
    const bytes = await readEntry(
      path,
      entry.path,
      MAX_FEEDBACK_ENTRY_PREVIEW_BYTES,
    );
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (
        Array.from(text).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 && code !== 9 && code !== 10 && code !== 13;
        })
      )
        return { kind: 'download-required', reason: 'binary' };
      return { kind: 'text', text };
    } catch {
      return { kind: 'download-required', reason: 'binary' };
    }
  });
}

export async function saveFeedbackDiagnostics(
  owner: string,
  id: string,
): Promise<void> {
  await withFeedbackDiagnostics(owner, id, async (path) => {
    // Destination is host-owned Downloads; callers supply no filesystem path.
    const destination = join(
      app.getPath('downloads'),
      `diagnostics-${id}-${randomUUID()}.zip`,
    );
    await copyFile(path, destination, constants.COPYFILE_EXCL);
  });
}

export async function releaseFeedbackDiagnostics(
  owner: string,
  id: string,
): Promise<void> {
  FeedbackDiagnosticsSnapshotIdSchema.parse(id);
  const snapshot = snapshots.get(id);
  if (!snapshot) return;
  if (snapshot.owner !== owner) throw new Error('Diagnostics are unavailable');
  snapshot.released = true;
  await dispose(id, snapshot);
}

/** Identity changes revoke tokens even if the same account later signs back in. */
export async function revokeFeedbackDiagnostics(): Promise<void> {
  await Promise.all(
    Array.from(snapshots, async ([id, snapshot]) => {
      snapshot.released = true;
      await dispose(id, snapshot).catch(() => undefined);
    }),
  );
}
