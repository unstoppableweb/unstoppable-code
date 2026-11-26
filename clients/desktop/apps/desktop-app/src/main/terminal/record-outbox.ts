import { constants as bufferConstants } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  writeFileAtomically,
  writeFileAtomicallySync,
  syncDirectory,
} from '@canopy/execution-engine/node/lib/atomic-file';
import { damagedCopyPath } from '@canopy/execution-engine/node/lib/damaged-copies';
import type {
  WorkerTerminalRecordClient,
  WorkerTerminalRecordOp,
  WorkerTerminalRecordRetireParams,
} from '@canopy/protocol/canopy-core';
import { isRecord } from '../lib/type-guards';

/**
 * Electron main's durable outbox of in-process terminal record writes
 * (CAN-7051): what it could not hand to the daemon's record authority, in
 * order, until a drain applies it. Main never writes the daemon's record; it
 * writes only here. It holds sessions, output tails, exits and layout
 * membership; never terminal input or launch environments. One file in
 * main's data root, so the synchronous quit seal needs no directory. The file
 * is one JSON document with each queued batch on a line of its own: retained
 * histories together can outgrow the longest string V8 builds, so neither a
 * write nor a read ever holds the whole outbox as one string.
 */

/** One producer batch, applied at most once under its run's watermark. */
export interface TerminalRecordOutboxEntry {
  readonly seq: number;
  readonly runId: string;
  readonly generation?: number;
  /** Exact admission identity before the first send; absent in older outboxes. */
  client?: WorkerTerminalRecordClient;
  sealed?: { reason: string };
  ops: WorkerTerminalRecordOp[];
  /**
   * Sent at least once with an unknown outcome: never merged into, so a
   * retry is the same batch under the same seq.
   */
  attempted?: boolean;
}

export interface TerminalRecordScopeOutbox {
  readonly client: WorkerTerminalRecordClient;
  entries: TerminalRecordOutboxEntry[];
}

export interface TerminalRecordOutboxFile {
  readonly version: 1;
  readonly producer: 'electron_main';
  scopes: TerminalRecordScopeOutbox[];
  retirements: WorkerTerminalRecordRetireParams[];
  /**
   * When the run that wrote it started (epoch ms): runs' own files replay
   * in this order, not their random names' (R5-F2).
   */
  readonly runStartedAt?: number;
  /**
   * Shared file only: runs' own files it holds already, until they are
   * discarded. A later read never merges them again, so their retirements
   * never drop the newer writes merged after them.
   */
  merged?: string[];
  /** Generation of one asynchronous publication, referenced by its quit image. */
  readonly publicationId?: string;
  /** Immutable quit image of the named publication's remaining custody. */
  seal?: { source?: { file: string; publicationId: string } };
}

const ADMITTED = {
  namespace: 'terminal_record_outbox',
  writer: 'electron_main',
  module: 'main/terminal/record-outbox',
} as const;
const FILE_NAME = 'terminal-record-outbox.json';
const RUN_FILE_PREFIX = 'terminal-record-outbox.run-';
const FILE_MODE = 0o600;

export function terminalRecordOutboxFileName(runId: string | null): string {
  return runId === null ? FILE_NAME : `${RUN_FILE_PREFIX}${runId}.json`;
}

function isRunFileName(name: string): boolean {
  return (
    name === basename(name) &&
    name.startsWith(RUN_FILE_PREFIX) &&
    name.endsWith('.json') &&
    !name.includes('.damaged-')
  );
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function isEntry(value: unknown): value is TerminalRecordOutboxEntry {
  return (
    isRecord(value) &&
    typeof value.seq === 'number' &&
    typeof value.runId === 'string' &&
    Array.isArray(value.ops) &&
    (value.client === undefined || isClient(value.client))
  );
}

function isClient(value: unknown): value is WorkerTerminalRecordClient {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    (value.legacyLayout === 'workspaces' ||
      value.legacyLayout === 'app-workspaces') &&
    (value.incarnation === null || typeof value.incarnation === 'string') &&
    (value.lifetimeId === undefined || typeof value.lifetimeId === 'string') &&
    (value.generation === undefined || typeof value.generation === 'number')
  );
}

function isScope(value: unknown): value is TerminalRecordScopeOutbox {
  return (
    isRecord(value) &&
    isClient(value.client) &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntry)
  );
}

function isRetirement(
  value: unknown,
): value is WorkerTerminalRecordRetireParams {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    (value.worktreeId === undefined || typeof value.worktreeId === 'string') &&
    (value.incarnation === undefined ||
      value.incarnation === null ||
      typeof value.incarnation === 'string') &&
    (value.lifetimeIds === undefined ||
      (Array.isArray(value.lifetimeIds) &&
        value.lifetimeIds.every((id) => typeof id === 'string'))) &&
    (value.worktreeIds === undefined ||
      (Array.isArray(value.worktreeIds) &&
        value.worktreeIds.every((id) => typeof id === 'string'))) &&
    (value.generation === undefined || typeof value.generation === 'number') &&
    (value.requestedAt === undefined || typeof value.requestedAt === 'number')
  );
}

export function emptyTerminalRecordOutbox(
  runStartedAt?: number,
): TerminalRecordOutboxFile {
  return {
    version: 1,
    producer: 'electron_main',
    scopes: [],
    retirements: [],
    ...(runStartedAt !== undefined && { runStartedAt }),
  };
}

/**
 * Appends a worktree's queued batches after the ones already queued for it,
 * and returns the outbox holding them. They join the worktree's last outbox
 * only when it has the same client incarnation (both unknown, or the same
 * one); otherwise they get an outbox of their own after it, so batches
 * never go out under another worktree's client and keep their order.
 */
export function appendScopeOutbox(
  scopes: TerminalRecordScopeOutbox[],
  outbox: TerminalRecordScopeOutbox,
): TerminalRecordScopeOutbox {
  const { client } = outbox;
  const last = scopes
    .filter(
      (candidate) =>
        candidate.client.projectId === client.projectId &&
        candidate.client.worktreeId === client.worktreeId,
    )
    .pop();
  if (
    last &&
    last.client.incarnation === client.incarnation &&
    last.client.lifetimeId === client.lifetimeId
  ) {
    for (const entry of outbox.entries) {
      const index = last.entries.findIndex(
        (held) => held.runId === entry.runId && held.seq === entry.seq,
      );
      if (index < 0) last.entries.push(entry);
      else last.entries[index] = entry;
    }
    return last;
  }
  scopes.push(outbox);
  return outbox;
}

/** Queued first requests can still reach the daemon after their producer dies. */
export function retainRetiredOutboxIdentities(
  retirement: WorkerTerminalRecordRetireParams,
  outbox: TerminalRecordScopeOutbox,
): boolean {
  if (
    retirement.projectId !== outbox.client.projectId ||
    (retirement.worktreeId !== undefined &&
      retirement.worktreeId !== outbox.client.worktreeId)
  )
    return false;
  const ids = new Set(retirement.lifetimeIds ?? []);
  for (const client of [
    outbox.client,
    ...outbox.entries.map((entry) => entry.client),
  ])
    if (client?.lifetimeId) ids.add(client.lifetimeId);
  if (ids.size > 0) retirement.lifetimeIds = Array.from(ids);
  if (retirement.worktreeId === undefined)
    retirement.worktreeIds = Array.from(
      new Set([...(retirement.worktreeIds ?? []), outbox.client.worktreeId]),
    );
  return true;
}

/** An intent's identities are frozen at capture, never enlarged during replay. */
export function dropRetiredOutboxEntries(
  retirement: WorkerTerminalRecordRetireParams,
  outbox: TerminalRecordScopeOutbox,
): boolean {
  outbox.entries = outbox.entries.filter((entry) => {
    const client = entry.client ?? outbox.client;
    if (
      retirement.projectId !== client.projectId ||
      (retirement.worktreeId !== undefined &&
        retirement.worktreeId !== client.worktreeId) ||
      (retirement.worktreeIds !== undefined &&
        !retirement.worktreeIds.includes(client.worktreeId))
    )
      return true;
    const lifetimeMatches =
      client.lifetimeId !== undefined &&
      retirement.lifetimeIds?.includes(client.lifetimeId) === true;
    const incarnationMatches =
      client.lifetimeId === undefined &&
      retirement.worktreeId !== undefined &&
      typeof retirement.incarnation === 'string' &&
      retirement.incarnation === client.incarnation;
    return !lifetimeMatches && !incarnationMatches;
  });
  return outbox.entries.length === 0;
}

/** Earlier runs' outbox: the shared file and every run's own file, merged. */
export interface TerminalRecordOutboxRead {
  readonly outbox: TerminalRecordOutboxFile;
  /** Runs' own files merged here, to discard once the shared file holds them. */
  readonly runFiles: string[];
}

export interface TerminalRecordOutboxOptions {
  /** The longest string the codec builds; V8's own limit by default. */
  readonly maxStringLength?: number;
}

const SCOPES_OPEN = ',"scopes":[';
const SCOPE_OPEN = '{"client":';
const ENTRIES_OPEN = ',"entries":[';

/** As V8 refuses a string past its limit; a lower limit tests the same path. */
function boundedString(text: string, maxStringLength: number): string {
  if (text.length > maxStringLength)
    throw new RangeError('Invalid string length');
  return text;
}

/** The outbox as one JSON document, a line per batch (see the file comment). */
function encodeOutbox(
  outbox: TerminalRecordOutboxFile,
  maxStringLength: number,
): Buffer {
  const { scopes, ...header } = outbox;
  const chunks: Buffer[] = [];
  const push = (text: string): void => {
    chunks.push(Buffer.from(boundedString(text, maxStringLength), 'utf8'));
  };
  push(`${JSON.stringify(header).slice(0, -1)}${SCOPES_OPEN}\n`);
  scopes.forEach(({ client, entries }, scope) => {
    push(`${SCOPE_OPEN}${JSON.stringify(client)}${ENTRIES_OPEN}\n`);
    entries.forEach((entry, index) => {
      push(
        `${JSON.stringify(entry)}${index < entries.length - 1 ? ',' : ''}\n`,
      );
    });
    push(scope < scopes.length - 1 ? ']},\n' : ']}\n');
  });
  push(']}');
  return Buffer.concat(chunks);
}

/** The file's lines, split on bytes: no line is decoded before it is whole. */
async function* fileLines(
  handle: FileHandle,
  maxStringLength: number,
): AsyncGenerator<string> {
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let pending: Buffer[] = [];
  const line = (): string =>
    boundedString(Buffer.concat(pending).toString('utf8'), maxStringLength);
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    const read = chunk.subarray(0, bytesRead);
    let start = 0;
    for (
      let end = read.indexOf(0x0a);
      end >= 0;
      end = read.indexOf(0x0a, start)
    ) {
      pending.push(Buffer.from(read.subarray(start, end)));
      yield line();
      pending = [];
      start = end + 1;
    }
    if (start < bytesRead) pending.push(Buffer.from(read.subarray(start)));
  }
  if (pending.length > 0) yield line();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The document a file holds, a line at a time; `undefined` when it is not
 * one. A document without batch lines (an older or hand-written one) is
 * parsed whole.
 */
async function decodeOutbox(
  lines: AsyncGenerator<string>,
  maxStringLength: number,
): Promise<unknown> {
  const next = async (): Promise<string | undefined> => {
    const line = await lines.next();
    return line.done ? undefined : line.value;
  };
  const first = await next();
  if (first === undefined) return undefined;
  if (!first.endsWith(SCOPES_OPEN)) {
    const rest: string[] = [first];
    for (let line = await next(); line !== undefined; line = await next())
      rest.push(line);
    return parseJson(boundedString(rest.join('\n'), maxStringLength));
  }
  const header = parseJson(`${first.slice(0, -SCOPES_OPEN.length)}}`);
  if (!isRecord(header)) return undefined;
  // Separators are checked as the whole document's parse would check them.
  const scopes: { client: unknown; entries: unknown[] }[] = [];
  let scopeClosed: string | undefined = ']}';
  for (let line = await next(); line !== ']}'; line = await next()) {
    if (
      (scopes.length > 0 && scopeClosed !== ']},') ||
      line === undefined ||
      !line.startsWith(SCOPE_OPEN) ||
      !line.endsWith(ENTRIES_OPEN)
    )
      return undefined;
    const entries: unknown[] = [];
    scopes.push({
      client: parseJson(line.slice(SCOPE_OPEN.length, -ENTRIES_OPEN.length)),
      entries,
    });
    let separated = true;
    let entry = await next();
    for (; entry !== ']}' && entry !== ']},'; entry = await next()) {
      if (entry === undefined || !separated) return undefined;
      separated = entry.endsWith(',');
      const parsed = parseJson(separated ? entry.slice(0, -1) : entry);
      if (parsed === undefined) return undefined;
      entries.push(parsed);
    }
    if (entries.length > 0 && separated) return undefined;
    scopeClosed = entry;
  }
  if (scopes.length > 0 && scopeClosed !== ']}') return undefined;
  // Nothing follows the document's end.
  if ((await next()) !== undefined) return undefined;
  return { ...header, scopes };
}

async function readOutboxDocument(
  path: string,
  maxStringLength: number,
): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    return await decodeOutbox(
      fileLines(handle, maxStringLength),
      maxStringLength,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseOutbox(parsed: unknown): TerminalRecordOutboxFile | null {
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  // A partially readable seal cannot certify custody of its source publication.
  if (
    isRecord(parsed.seal) &&
    (!Array.isArray(parsed.scopes) ||
      !parsed.scopes.every(isScope) ||
      !Array.isArray(parsed.retirements) ||
      !parsed.retirements.every(isRetirement))
  )
    return null;
  return {
    version: 1,
    producer: 'electron_main',
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter(isScope) : [],
    retirements: Array.isArray(parsed.retirements)
      ? parsed.retirements.filter(isRetirement)
      : [],
    ...(typeof parsed.publicationId === 'string' && {
      publicationId: parsed.publicationId,
    }),
    ...(isRecord(parsed.seal) && {
      seal: {
        ...(isRecord(parsed.seal.source) &&
          typeof parsed.seal.source.file === 'string' &&
          (parsed.seal.source.file === FILE_NAME ||
            isRunFileName(parsed.seal.source.file)) &&
          typeof parsed.seal.source.publicationId === 'string' && {
            source: {
              file: parsed.seal.source.file,
              publicationId: parsed.seal.source.publicationId,
            },
          }),
      },
    }),
    ...(typeof parsed.runStartedAt === 'number' &&
      Number.isFinite(parsed.runStartedAt) && {
        runStartedAt: parsed.runStartedAt,
      }),
    ...(Array.isArray(parsed.merged) && {
      merged: parsed.merged.filter(
        (name): name is string =>
          typeof name === 'string' && isRunFileName(name),
      ),
    }),
  };
}

export class TerminalRecordOutbox {
  private operations: Promise<unknown> = Promise.resolve();
  private sealed = false;
  private active = false;
  private publication: { file: string; publicationId: string } | undefined;

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operations
      .catch(() => undefined)
      .then(async () => {
        this.assertMutable();
        this.active = true;
        try {
          return await run();
        } finally {
          this.active = false;
          this.publication = undefined;
        }
      });
    this.operations = result;
    return result;
  }

  private assertMutable(): void {
    if (this.sealed) throw new Error('Terminal outbox sealed');
  }

  private readonly maxStringLength: number;

  public constructor(
    private readonly root: () => string,
    options: TerminalRecordOutboxOptions = {},
  ) {
    this.maxStringLength =
      options.maxStringLength ?? bufferConstants.MAX_STRING_LENGTH;
  }

  /**
   * The shared file, or a run's own file: a run that could not merge the
   * shared file (unreadable, or a quit before it was read) queues beside it.
   */
  private path(runId: string | null = null): string {
    return join(this.root(), terminalRecordOutboxFileName(runId));
  }

  /** Reads one file; a damaged one is set aside as evidence and skipped. */
  private async readOne(path: string): Promise<TerminalRecordOutboxFile> {
    let document: unknown;
    try {
      document = await readOutboxDocument(path, this.maxStringLength);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyTerminalRecordOutbox();
      throw error;
    }
    const parsed = parseOutbox(document);
    if (parsed) return parsed;
    if (this.sealed) return emptyTerminalRecordOutbox();
    await rename(path, damagedCopyPath(path)).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    return emptyTerminalRecordOutbox();
  }

  /**
   * Every earlier run's queued writes, the shared file's first. Throws when
   * the shared file cannot be read; it is then left as it is.
   */
  public read(excludeRunId?: string): Promise<TerminalRecordOutboxRead> {
    return this.serialize(() => this.readNow(excludeRunId));
  }

  private async readNow(
    excludeRunId?: string,
  ): Promise<TerminalRecordOutboxRead> {
    const outbox = await this.readOne(this.path());
    let names: string[] = [];
    try {
      names = (await readdir(this.root())).filter(isRunFileName);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const held = new Set(outbox.merged ?? []);
    const runs: { path: string; run: TerminalRecordOutboxFile }[] = [];
    // Missing sources may have been unlinked before a failed directory flush.
    const runFiles = Array.from(held, (name) => join(this.root(), name));
    for (const name of names.sort()) {
      const path = join(this.root(), name);
      if (excludeRunId !== undefined && path === this.path(excludeRunId)) {
        runFiles.push(path);
        continue;
      }
      // Merged into the shared file by a run that ended before it discarded it.
      if (held.has(name)) {
        continue;
      }
      // An unresolved source may contain an older mutation of any scope.
      // Merge all sources, or none: newer writes cannot overtake it.
      runs.push({ path, run: await this.readOne(path) });
    }
    // Oldest run first, by start time, not by the random names; a file
    // without one predates them all. The sort is stable for ties.
    const startedAt = ({ run }: { run: TerminalRecordOutboxFile }): number =>
      run.runStartedAt ?? Number.NEGATIVE_INFINITY;
    runs.sort((a, b) =>
      startedAt(a) < startedAt(b)
        ? -1
        : startedAt(a) > startedAt(b)
          ? 1
          : Number(a.run.seal !== undefined) - Number(b.run.seal !== undefined),
    );
    const sources = new Map([
      [FILE_NAME, outbox],
      ...runs.map(({ path, run }): [string, TerminalRecordOutboxFile] => [
        basename(path),
        run,
      ]),
    ]);
    const replaced = new Set<string>();
    for (const { path, run } of runs) {
      const source = run.seal?.source;
      // The generation ties this final custody image to the exact stale file.
      // Missing, damaged or mismatched evidence only permits the ordinary merge.
      if (
        source &&
        source.file !== basename(path) &&
        sources.get(source.file)?.publicationId === source.publicationId
      )
        replaced.add(source.file);
    }
    if (replaced.has(FILE_NAME)) {
      outbox.scopes = [];
      outbox.retirements = [];
    }
    for (const { path, run } of runs) {
      if (replaced.has(basename(path))) {
        runFiles.push(path);
        continue;
      }
      // A run's own file is newer than the shared file it could not merge,
      // and than every run that started before it: its retirements drop
      // older writes, as they did in that run, and keep its own and later.
      for (const retirement of run.retirements)
        for (const scope of outbox.scopes)
          dropRetiredOutboxEntries(retirement, scope);
      for (const scope of run.scopes) appendScopeOutbox(outbox.scopes, scope);
      outbox.retirements.push(...run.retirements);
      runFiles.push(path);
    }
    outbox.merged = runFiles.map((path) => basename(path));
    return { outbox, runFiles };
  }

  /** Throws when the outbox cannot be written; the caller keeps the batch. */
  public write(
    outbox: TerminalRecordOutboxFile,
    runId: string | null = null,
    installed?: (image: TerminalRecordOutboxFile) => void,
  ): Promise<void> {
    const image = structuredClone(outbox);
    return this.serialize(async () => {
      // Only a complete publication from main is covered by its final custody
      // image. A read of an undiscovered source never grants supersession.
      if (image.publicationId)
        this.publication = {
          file: terminalRecordOutboxFileName(runId),
          publicationId: image.publicationId,
        };
      await writeFileAtomically(
        this.path(runId),
        encodeOutbox(image, this.maxStringLength),
        {
          mode: FILE_MODE,
          durable: true,
          admittedWriter: ADMITTED,
          beforeInstall: () => {
            this.assertMutable();
            return Promise.resolve();
          },
        },
      );
      if (!this.sealed) installed?.(image);
      this.assertMutable();
    });
  }

  /** Nothing is queued: the file goes. */
  public remove(runId: string | null = null): Promise<void> {
    return this.serialize(() => rm(this.path(runId), { force: true }));
  }

  /** Runs' own files the shared file now holds. */
  public discard(paths: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      for (const path of paths) {
        this.assertMutable();
        await rm(path, { force: true });
      }
      // The merge ledger may go only after source deletions survive a crash.
      if (paths.length > 0) await syncDirectory(this.root());
    });
  }

  /** Close mutation admission before transferring custody to an untargeted image. */
  public seal(
    outbox: TerminalRecordOutboxFile,
    runId: string | null,
    installed?: (image: TerminalRecordOutboxFile) => void,
  ): void {
    if (this.sealed) return;
    this.sealed = true;
    const image = structuredClone(outbox);
    let recovered = false;
    if (this.active) {
      // Already-issued rename/unlink cannot be retracted. No ordinary operation
      // knows this reserved name, and source suppression requires full coverage.
      try {
        this.installSealImage(
          {
            ...image,
            seal: { ...(this.publication && { source: this.publication }) },
          },
          `${runId ?? randomUUID()}-seal`,
          installed,
        );
        recovered = true;
      } catch {
        /* Still attempt the primary install. */
      }
    }
    try {
      this.installSealImage(image, runId, installed);
    } catch (error) {
      if (!recovered) throw error;
    }
  }

  /** Quit only: the process is ending and cannot wait. */
  private installSealImage(
    outbox: TerminalRecordOutboxFile,
    runId: string | null = null,
    installed?: (image: TerminalRecordOutboxFile) => void,
  ): void {
    writeFileAtomicallySync(
      this.path(runId),
      encodeOutbox(outbox, this.maxStringLength),
      {
        mode: FILE_MODE,
        durable: true,
        admittedWriter: ADMITTED,
      },
    );
    installed?.(outbox);
  }
}
