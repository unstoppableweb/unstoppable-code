import {
  constants,
  type Dirent,
  type Stats,
  type ReadStream,
  type WriteStream,
} from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import {
  MAX_FEEDBACK_ARCHIVE_BYTES,
  MAX_FEEDBACK_ARCHIVE_ENTRIES,
  MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES,
  type FeedbackReportError,
} from '@canopy/protocol/feedback-report';
import type {
  FeedbackArea,
  FeedbackWorkspaceSelection,
} from '@canopy/desktop-shared/types';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export class FeedbackArchiveSizeLimitError extends Error {
  constructor(kind: 'contents' | 'archive') {
    super(
      kind === 'archive'
        ? 'Diagnostics archive exceeds the size limit'
        : 'Diagnostics contents exceed the size limit',
    );
    this.name = 'FeedbackArchiveSizeLimitError';
  }
}

const SENSITIVE_TOP_LEVEL_ZIP_PARTS: ReadonlySet<string> = new Set<string>([
  'secure',
  'repos',
  'plugin-cache',
  'chat-plugins',
  'attachments',
]);
const SENSITIVE_ANY_DEPTH_ZIP_PARTS: ReadonlySet<string> = new Set<string>([
  'artifacts',
  'foreign-activity-ledger.json',
]);

type SkippedReason =
  | 'missing'
  | 'changed'
  | 'symlink'
  | 'too-large'
  | 'inaccessible'
  | 'out-of-root'
  | 'policy-excluded';

interface SkippedFile {
  path: string;
  reason: SkippedReason;
}

export interface FeedbackManifest {
  error?: FeedbackReportError;
  version: 1;
  preparedAt: string;
  description: string;
  area: FeedbackArea;
  workspaceSelections: FeedbackWorkspaceSelection[];
  chatProjectIds: string[];
  includeChatDetails: boolean;
  includePipelineExecutions: boolean;
  app: {
    version: string;
    runtimeMode: 'dev' | 'prod';
    platform: NodeJS.Platform;
    arch: string;
    electron: string | undefined;
    node: string;
  };
  machine: {
    hostname: string;
    osType: string;
    osRelease: string;
    osVersion: string;
    totalMemoryBytes: number;
    cpuCount: number;
  };
  modelHarnessAssignments: {
    persistenceSchemaVersion: 1;
    revision: number;
    assignments: Record<
      string,
      {
        source: string;
        harness:
          | 'claude'
          | 'codex'
          | 'cursor'
          | 'copilot'
          | 'antigravity'
          | 'opencode';
        defaultHarness:
          | 'claude'
          | 'codex'
          | 'cursor'
          | 'copilot'
          | 'antigravity'
          | 'opencode';
        configurable: boolean;
        overridden: boolean;
      }
    >;
  };
  crashDumps?: {
    included: number;
    sidecarPath: string;
    mayContainMemoryContents: true;
  };
  includedFiles: string[];
  skippedFiles: SkippedFile[];
}

interface AddFileOptions {
  sourceRoot: string;
  allowChatContent?: boolean;
  allowTranscript?: boolean;
  excludedZipPathPrefixes?: readonly string[];
}

type LstatResult =
  | { status: 'ok'; stats: Stats }
  | { status: 'missing' }
  | { status: 'inaccessible' };

type StaticFeedbackManifest = Omit<
  FeedbackManifest,
  'includedFiles' | 'skippedFiles'
>;
type BundleEntry =
  | { kind: 'buffer'; path: string; bytes: Buffer; stats?: Stats }
  | {
      kind: 'file';
      path: string;
      source: string;
      sourceRoot: string;
      stats: Stats;
    };

export class FeedbackBundleBuilder {
  private sourceBytes = 0;
  constructor(private readonly bounded = false) {}

  private reserveBytes(size: number): void {
    if (
      this.bounded &&
      this.sourceBytes + size > MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES
    )
      throw new FeedbackArchiveSizeLimitError('contents');
    this.sourceBytes += size;
  }
  private readonly entries: BundleEntry[] = [];
  private manifest: StaticFeedbackManifest | undefined;
  private state: 'collecting' | 'writing' | 'succeeded' | 'failed' =
    'collecting';
  private readonly included = new Set<string>();
  private readonly reserved = new Set<string>();
  private readonly skipped: SkippedFile[] = [];

  isIncluded(zipPath: string): boolean {
    return this.included.has(zipPath);
  }

  includedFiles(): string[] {
    return Array.from(this.included).sort();
  }

  skippedFiles(): SkippedFile[] {
    return [...this.skipped];
  }

  async addFileIfSafe(
    sourcePath: string,
    zipPath: string,
    options: AddFileOptions,
  ): Promise<void> {
    this.assertCollecting();
    const normalizedZipPath = normalizeZipPath(zipPath);
    if (normalizedZipPath === null) {
      this.recordSkipped(zipPath, 'out-of-root');
      return;
    }
    if (!isPathWithinRoot(sourcePath, options.sourceRoot)) {
      this.recordSkipped(normalizedZipPath, 'out-of-root');
      return;
    }
    if (!isAllowedZipPath(normalizedZipPath, options)) {
      this.recordSkipped(normalizedZipPath, 'policy-excluded');
      return;
    }
    if (!this.reservePath(normalizedZipPath)) {
      return;
    }

    const fileStatResult = await safeLstat(sourcePath);
    if (fileStatResult.status === 'inaccessible') {
      this.releasePath(normalizedZipPath);
      this.recordSkipped(normalizedZipPath, 'inaccessible');
      return;
    }
    if (fileStatResult.status === 'missing') {
      this.releasePath(normalizedZipPath);
      this.recordSkipped(normalizedZipPath, 'missing');
      return;
    }
    const fileStat = fileStatResult.stats;
    if (fileStat.isSymbolicLink()) {
      this.releasePath(normalizedZipPath);
      this.recordSkipped(normalizedZipPath, 'symlink');
      return;
    }
    if (!fileStat.isFile()) {
      this.releasePath(normalizedZipPath);
      return;
    }
    if (fileStat.size > MAX_FILE_BYTES) {
      this.releasePath(normalizedZipPath);
      this.recordSkipped(normalizedZipPath, 'too-large');
      return;
    }

    this.reserveBytes(fileStat.size);
    this.entries.push(
      fileStat.size === 0
        ? {
            kind: 'buffer',
            path: normalizedZipPath,
            bytes: Buffer.alloc(0),
            stats: fileStat,
          }
        : {
            kind: 'file',
            path: normalizedZipPath,
            source: sourcePath,
            sourceRoot: options.sourceRoot,
            stats: fileStat,
          },
    );
    this.included.add(normalizedZipPath);
  }

  async addDirectoryIfSafe(
    sourceDir: string,
    zipDir: string,
    options: AddFileOptions,
  ): Promise<void> {
    this.assertCollecting();
    const normalizedZipDir = normalizeZipPath(zipDir);
    if (normalizedZipDir === null) {
      this.recordSkipped(zipDir, 'out-of-root');
      return;
    }
    if (!isPathWithinRoot(sourceDir, options.sourceRoot)) {
      this.recordSkipped(normalizedZipDir, 'out-of-root');
      return;
    }
    if (!isAllowedZipPath(normalizedZipDir, options)) {
      this.recordSkipped(normalizedZipDir, 'policy-excluded');
      return;
    }
    if (!this.reservePath(normalizedZipDir)) {
      return;
    }

    const dirStatResult = await safeLstat(sourceDir);
    if (dirStatResult.status === 'inaccessible') {
      this.releasePath(normalizedZipDir);
      this.recordSkipped(normalizedZipDir, 'inaccessible');
      return;
    }
    if (dirStatResult.status === 'missing') {
      this.releasePath(normalizedZipDir);
      this.recordSkipped(normalizedZipDir, 'missing');
      return;
    }
    const dirStat = dirStatResult.stats;
    if (dirStat.isSymbolicLink()) {
      this.releasePath(normalizedZipDir);
      this.recordSkipped(normalizedZipDir, 'symlink');
      return;
    }
    if (!dirStat.isDirectory()) {
      this.releasePath(normalizedZipDir);
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      this.releasePath(normalizedZipDir);
      this.recordSkipped(normalizedZipDir, 'inaccessible');
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const childSource = join(sourceDir, entry.name);
        const childZipPath = posix.join(normalizedZipDir, entry.name);
        if (entry.isSymbolicLink()) {
          this.recordSkipped(childZipPath, 'symlink');
          return;
        }
        if (entry.isDirectory()) {
          await this.addDirectoryIfSafe(childSource, childZipPath, options);
          return;
        }
        if (entry.isFile()) {
          await this.addFileIfSafe(childSource, childZipPath, options);
        }
      }),
    );
  }

  addManifest(manifest: StaticFeedbackManifest): void {
    this.assertCollecting();
    this.manifest = manifest;
  }

  addGeneratedJson(zipPath: string, value: unknown): void {
    this.assertCollecting();
    const normalizedZipPath = normalizeZipPath(zipPath);
    if (normalizedZipPath === null) {
      this.recordSkipped(zipPath, 'out-of-root');
      return;
    }
    if (!isAllowedZipPath(normalizedZipPath, { sourceRoot: '' })) {
      this.recordSkipped(normalizedZipPath, 'policy-excluded');
      return;
    }
    if (!this.reservePath(normalizedZipPath)) {
      return;
    }
    const json = `${JSON.stringify(value, null, 2)}\n`;
    this.reserveBytes(Buffer.byteLength(json, 'utf8'));
    this.entries.push({
      kind: 'buffer',
      path: normalizedZipPath,
      bytes: Buffer.from(json, 'utf8'),
    });
    this.included.add(normalizedZipPath);
  }

  async writeTo(fileHandle: FileHandle, bounded = false): Promise<void> {
    this.assertCollecting();
    this.state = 'writing';
    const zip = new ZipFile();
    const controller = new AbortController();
    const sources = new Set<ReadStream>();
    const pending = new Set<Promise<void>>();
    let previousClosed = Promise.resolve();
    let firstError: Error | undefined;
    let output: WriteStream | undefined;
    let outputClosed = Promise.resolve();
    const fail = (error: unknown): void => {
      if (firstError !== undefined) return;
      firstError =
        error instanceof Error ? error : new Error('Feedback archive failed');
      this.state = 'failed';
      controller.abort();
      output?.destroy();
      for (const source of Array.from(sources)) source.destroy();
    };
    // Lazy entry registration can start a producer immediately. All error
    // listeners and the observed pipeline must exist before the first entry.
    zip.on('error', fail);
    let archiveBytes = 0;
    if (bounded)
      zip.outputStream.on('data', (chunk: Buffer) => {
        archiveBytes += chunk.length;
        if (archiveBytes > MAX_FEEDBACK_ARCHIVE_BYTES)
          fail(new FeedbackArchiveSizeLimitError('archive'));
      });
    let streamDone: Promise<void> = Promise.resolve();
    try {
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- streams into the reserved feedback zip, never preferences; remove when the bundle stops naming preferences.
      output = fileHandle.createWriteStream({ autoClose: true });
      output.on('error', fail);
      outputClosed = new Promise<void>((resolveClosed) => {
        output?.once('close', resolveClosed);
      });
      streamDone = pipeline(zip.outputStream, output, {
        signal: controller.signal,
      }).catch(fail);
      for (const entry of this.entries) {
        if (firstError !== undefined) break;
        if (entry.kind === 'buffer') {
          zip.addBuffer(
            entry.bytes,
            entry.path,
            entry.stats === undefined
              ? undefined
              : {
                  mtime: entry.stats.mtime,
                  mode: entry.stats.mode,
                },
          );
          continue;
        }
        zip.addReadStreamLazy(
          entry.path,
          { mtime: entry.stats.mtime, mode: entry.stats.mode },
          (callback) => {
            let settled = false;
            const settle = (error: Error | null, source: Readable): void => {
              if (settled) return;
              settled = true;
              callback(error, source);
            };
            const task = (async (): Promise<void> => {
              // yazl sequences data, not asynchronous descriptor closure. Await
              // the preceding source's close before opening another descriptor.
              await previousClosed;
              if (firstError !== undefined) {
                settle(firstError, Readable.from([]));
                return;
              }
              const opened = await openFeedbackSource(entry, controller.signal);
              if (opened.status === 'skipped') {
                this.included.delete(entry.path);
                this.recordSkipped(entry.path, opened.reason);
                settle(null, Readable.from([]));
                return;
              }
              const handle = opened.handle;
              if (firstError !== undefined) {
                await closeFileHandle(handle);
                settle(firstError, Readable.from([]));
                return;
              }
              let source: ReadStream;
              try {
                source = handle.createReadStream({
                  start: 0,
                  end: entry.stats.size - 1,
                  autoClose: true,
                });
              } catch (error) {
                await closeFileHandle(handle);
                throw error;
              }
              sources.add(source);
              // Retain the listener even after close: late secondary errors must
              // remain handled and must never replace the original failure.
              source.on('error', fail);
              previousClosed = new Promise<void>((resolveClosed) => {
                source.once('close', () => {
                  sources.delete(source);
                  resolveClosed();
                });
              });
              settle(null, source);
            })().catch((error: unknown) => {
              fail(error);
              settle(
                firstError ?? new Error('Feedback source failed'),
                Readable.from([]),
              );
            });
            pending.add(task);
            void task.finally(() => pending.delete(task));
          },
        );
      }
      if (firstError === undefined) {
        zip.addReadStreamLazy('feedback.json', (callback) => {
          let settled = false;
          try {
            if (this.manifest === undefined)
              throw new Error('Feedback manifest is required');
            const manifest: FeedbackManifest = {
              ...this.manifest,
              includedFiles: this.includedFiles(),
              skippedFiles: this.skippedFiles(),
            };
            const bytes = Buffer.from(
              `${JSON.stringify(manifest, null, 2)}\n`,
              'utf8',
            );
            settled = true;
            callback(null, Readable.from([bytes]));
          } catch (error) {
            fail(error);
            if (!settled) callback(firstError, Readable.from([]));
          }
        });
        zip.end();
      }
    } catch (error) {
      fail(error);
    }
    await streamDone;
    // Aborting settles the destination independently of source opens. Wait
    // for those opens to transfer or close their handles before deletion.
    await Promise.all(pending);
    await previousClosed;
    await outputClosed;
    if (firstError !== undefined) throw firstError;
    this.state = 'succeeded';
  }

  private assertCollecting(): void {
    if (this.state !== 'collecting')
      throw new Error('Feedback builder is single-use');
  }

  recordSkipped(path: string, reason: SkippedReason): void {
    this.skipped.push({ path, reason });
  }

  private reservePath(path: string): boolean {
    if (this.reserved.has(path)) {
      return false;
    }
    if (this.bounded && this.reserved.size >= MAX_FEEDBACK_ARCHIVE_ENTRIES)
      throw new Error('Diagnostics contain too many entries');
    this.reserved.add(path);
    return true;
  }

  private releasePath(path: string): void {
    this.reserved.delete(path);
  }
}

async function openFeedbackSource(
  entry: Extract<BundleEntry, { kind: 'file' }>,
  signal: AbortSignal,
): Promise<
  | { status: 'opened'; handle: FileHandle }
  | { status: 'skipped'; reason: SkippedReason }
> {
  let handle: FileHandle | undefined;
  try {
    // Reject symlinks at every component below the trusted root, including the
    // root itself. realpath also checks containment; O_NOFOLLOW protects the
    // final component on platforms that support it. Node has no portable
    // openat traversal, so concurrent ancestor substitution is not atomic.
    if (await feedbackSourceHasSymlink(entry))
      return { status: 'skipped', reason: 'symlink' };
    const root = await realpath(entry.sourceRoot);
    if (!isPathWithinRoot(await realpath(entry.source), root))
      return { status: 'skipped', reason: 'out-of-root' };
    const before = await lstat(entry.source);
    if (!before.isFile())
      throw new Error('Feedback source is not a regular file');
    signal.throwIfAborted();
    // eslint-disable-next-line admitted-writers/no-unadmitted-write -- opens a bundle source such as preferences O_RDONLY to copy it into the zip; remove when the bundle stops naming preferences.
    handle = await open(
      entry.source,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error('Feedback source changed identity during open');
    }
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      // Atomic preference/log replacement is expected during collection. Omit
      // the unstable source rather than reading a replacement or losing the ZIP.
      await closeFileHandle(handle);
      return { status: 'skipped', reason: 'changed' };
    }
    if (await feedbackSourceHasSymlink(entry)) {
      await closeFileHandle(handle);
      return { status: 'skipped', reason: 'symlink' };
    }
    const after = await lstat(entry.source);
    if (
      !after.isFile() ||
      !isPathWithinRoot(await realpath(entry.source), root)
    ) {
      throw new Error('Feedback source changed during validation');
    }
    if (after.dev !== opened.dev || after.ino !== opened.ino) {
      await closeFileHandle(handle);
      return { status: 'skipped', reason: 'changed' };
    }
    return { status: 'opened', handle };
  } catch (error) {
    if (handle !== undefined) await closeFileHandle(handle);
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return { status: 'skipped', reason: 'missing' };
    if (code === 'EACCES' || code === 'EPERM')
      return { status: 'skipped', reason: 'inaccessible' };
    if (code === 'ELOOP') return { status: 'skipped', reason: 'symlink' };
    throw error;
  }
}

async function feedbackSourceHasSymlink(
  entry: Extract<BundleEntry, { kind: 'file' }>,
): Promise<boolean> {
  const parts = relative(
    resolve(entry.sourceRoot),
    resolve(entry.source),
  ).split(sep);
  let path = resolve(entry.sourceRoot);
  for (const part of ['', ...parts]) {
    if (part !== '') path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) return true;
  }
  return false;
}

export function normalizeZipPath(zipPath: string): string | null {
  const normalized = posix.normalize(zipPath.split('\\').join('/'));
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }
  return normalized;
}

export function isPathWithinRoot(
  sourcePath: string,
  sourceRoot: string,
): boolean {
  const resolvedPath = resolve(sourcePath);
  const resolvedRoot = resolve(sourceRoot);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  );
}

function isAllowedZipPath(zipPath: string, options: AddFileOptions): boolean {
  if (
    options.excludedZipPathPrefixes?.some(
      (prefix) => zipPath === prefix || zipPath.startsWith(`${prefix}/`),
    )
  )
    return false;
  const parts = zipPath.split('/');
  const firstPart = parts[0];
  if (firstPart !== undefined && SENSITIVE_TOP_LEVEL_ZIP_PARTS.has(firstPart)) {
    return false;
  }
  if (parts.some((part) => SENSITIVE_ANY_DEPTH_ZIP_PARTS.has(part))) {
    return false;
  }
  if (basename(zipPath) === 'mcp-oauth-tokens.json') {
    return false;
  }
  if (
    (basename(zipPath) === 'conversation.json' ||
      basename(zipPath) === 'chat-tabs.json' ||
      parts.includes('chat-storage-v2') ||
      parts.includes('chat-storage-manifests')) &&
    options.allowChatContent !== true
  ) {
    return false;
  }
  if (
    (zipPath === 'agent-observability/transcripts' ||
      zipPath.startsWith('agent-observability/transcripts/')) &&
    options.allowTranscript !== true
  ) {
    return false;
  }
  return !isSqlitePath(zipPath);
}

function isSqlitePath(zipPath: string): boolean {
  return (
    zipPath.endsWith('.sqlite') ||
    zipPath.endsWith('.sqlite-shm') ||
    zipPath.endsWith('.sqlite-wal') ||
    zipPath.endsWith('.db') ||
    zipPath.endsWith('.db-shm') ||
    zipPath.endsWith('.db-wal')
  );
}

export async function safeLstat(sourcePath: string): Promise<LstatResult> {
  try {
    return { status: 'ok', stats: await lstat(sourcePath) };
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' };
    }
    return { status: 'inaccessible' };
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if (!('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function closeFileHandle(fileHandle: FileHandle): Promise<void> {
  try {
    await fileHandle.close();
  } catch (error) {
    if (getErrorCode(error) !== 'EBADF') throw error;
  }
}
