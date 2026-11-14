import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import * as path from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  pipelineExecutionNotFoundError,
  pipelineHandoffBusyError,
  pipelineHandoffRefusedError,
  pipelineHandoffSnapshotGoneError,
} from '@canopy/core-runtime/node/pipeline';
import type { PipelineRunnerHandoffPort } from '@canopy/core-runtime/node/pipeline/host';
import {
  WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
  WORKER_PIPELINE_HANDOFF_ARCHIVE_MAX_BYTES,
  type WorkerPipelineExecutionHandoffExportParams,
  type WorkerPipelineExecutionHandoffExportResult,
  type WorkerPipelineExecutionHandoffImportParams,
  type WorkerPipelineExecutionHandoffImportResult,
  type WorkerPipelineHandoffArchive,
} from '@canopy/protocol/canopy-core';
import {
  exportExecutionHandoff,
  restoreExecutionHandoff,
} from '../executor/execution-handoff';
import {
  executionStoreEntries,
  isExecutionStateWriteRefusal,
} from '../executor/execution-state';
import {
  packArchive,
  parseArchive,
  sha256,
  unpackArchive,
  type ArchiveEntry,
  type ArchiveFormat,
} from './archive';

/*
 * One run's handoff between cloud runner incarnations (CAN-6376, cloud
 * pipelines CP-74). A runner's data root is lost with its sandbox, so once a
 * checkpoint paused a run, its owner exports it
 * (`worker.pipeline.execution.handoff.export`) and, on the next incarnation,
 * imports it (`worker.pipeline.execution.handoff.import`) before it sends
 * the run's portable start again. The archive holds:
 *
 * - `executions/`: the run as `exportExecutionHandoff` lays it out
 *   (CAN-6198), `<id>.json`, a pending `<id>.cancel` and `<id>/`, whose
 *   host-step journals, step logs and outputs make a replay safe.
 * - `providers/claude/projects/<project>/`: each Claude Code session the
 *   run's state names, `<session>.jsonl` and its `<session>/` folder, from
 *   the Claude configuration folder the runner's steps use.
 * - `providers/codex/sessions/`: each Codex rollout the run's state names,
 *   `**\/rollout-*-<session>.jsonl`, from the runner's Codex home.
 * - `temp/`: the run's own folder under the host's run temporary root
 *   (`<tmp>/canopy-exec/<id>/`), where steps keep files their outputs name,
 *   such as an agent step's `text_response_file`, so a step after the resume
 *   still reads them.
 *
 * Only the sessions the run recorded move, so a chat sharing a worktree
 * sandbox keeps its own to itself, and an import writes nothing in either
 * store but session files. State paths are absolute: every incarnation of
 * a delegation uses the same data root and checkout paths, and Claude Code
 * finds a session under the project its checkout path names.
 */

/** Where the runner's provider CLIs keep their sessions (CAN-6376). */
export interface PipelineRunnerProviderStores {
  /** The Claude Code configuration folder: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  readonly claude: string;
  /** The Codex home: `CODEX_HOME`, or `~/.codex`. */
  readonly codex: string;
}

/** Where one runner keeps what its runs leave outside its data root. */
export interface PipelineRunnerHandoffStoreOptions {
  /** The provider stores whose sessions a run's state names. */
  readonly providers?: PipelineRunnerProviderStores;
  /**
   * The pipeline host's run temporary root (`<tmp>/canopy-exec`), where each
   * run keeps files under its own id that its step outputs name.
   */
  readonly runTempRoot?: string;
}

/** What an import asks of the runner while it restores. */
export interface PipelineRunnerHandoffImportContext {
  /** Whether the incarnation still holds its delegation lease. */
  readonly leaseHeld?: () => boolean;
}

/** Where a runner keeps its runs: the pipeline host's executions folder. */
export const PIPELINE_RUNNER_EXECUTIONS_DIR = 'pipeline-executions';

/** Where a runner packs and unpacks handoffs, beside its store. */
const HANDOFFS_DIR = 'pipeline-handoffs';

const EXECUTIONS = 'executions';
const TEMP = 'temp';
const CLAUDE_PROJECTS = ['providers', 'claude', 'projects'] as const;
const CODEX_SESSIONS = ['providers', 'codex', 'sessions'] as const;

/** The most rollout files an export reads to find a run's Codex sessions. */
const CODEX_ROLLOUTS_SCANNED_MAX = 50_000;

const HANDOFF_ARCHIVE: ArchiveFormat = {
  magic: Buffer.from('CANOPY-PIPELINE-HANDOFF/1\n'),
  maxBytes: WORKER_PIPELINE_HANDOFF_ARCHIVE_MAX_BYTES,
  refuse: {
    tooLarge: () =>
      pipelineHandoffRefusedError(
        'This workflow run is over its 64 MB handoff limit.',
      ),
    tooManyEntries: () =>
      pipelineHandoffRefusedError('This workflow run has too many files.'),
    unkeepablePath: (entryPath) =>
      pipelineHandoffRefusedError(
        `This workflow run has a file whose path can't be kept: ${entryPath}`,
      ),
    invalid: () =>
      pipelineHandoffRefusedError("This workflow run's handoff is invalid."),
  },
};

/**
 * A session id as both CLIs mint them, a UUID: nothing that could name a
 * path or a provider store's own folder, such as a Claude project's `memory`.
 */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/**
 * The provider sessions a run's state names: each step's `session_id`
 * output, which a later `agent-resume` step continues, and each paused
 * agent step's recovery checkpoint, which its resume continues. Steps at
 * any depth count, matrix variants and composite children included. A
 * Claude step's result records no harness, so each id is looked for in
 * both stores, and only a session file of that id moves.
 */
export function pipelineRunnerProviderSessions(state: unknown): string[] {
  const found = new Set<string>();
  const add = (sessionId: unknown): void => {
    if (typeof sessionId === 'string' && SESSION_ID.test(sessionId))
      found.add(sessionId);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const fields = record(value);
    if (fields === null) return;
    add(record(fields.outputs)?.session_id);
    add(record(fields.agent_recovery)?.session_id);
    for (const child of Object.values(fields)) visit(child, depth + 1);
  };
  visit(state, 0);
  return [...found];
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function kindOf(target: string): Promise<'file' | 'dir' | null> {
  try {
    const stats = await stat(target);
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

async function names(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
}

/** Copies a file or folder, keeping anything already at `to`. */
async function copyKeeping(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
}

/**
 * Copies each regular file under `from` that is not yet under `to`, keeping
 * every file already there. Each file it makes goes into `made` as soon as
 * it exists, so a copy that fails partway leaves the caller a full list to
 * remove. A missing `from` copies nothing.
 */
async function copyNewFiles(
  from: string,
  to: string,
  made: string[],
): Promise<void> {
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await names(path.join(from, relative))) {
      const member = path.join(relative, entry);
      const kind = await kindOf(path.join(from, member));
      if (kind === 'dir') await walk(member);
      else if (
        kind === 'file' &&
        (await kindOf(path.join(to, member))) === null
      ) {
        const target = path.join(to, member);
        await mkdir(path.dirname(target), { recursive: true });
        try {
          await copyFile(
            path.join(from, member),
            target,
            fsConstants.COPYFILE_EXCL,
          );
        } catch (error) {
          // A copy that failed partway may have left the file; one that
          // found a file already there leaves that file alone.
          if (errorCode(error) !== 'EEXIST') made.push(target);
          throw error;
        }
        made.push(target);
      }
    }
  };
  await walk('');
}

/** Copies each Claude session's transcript and folder into `into`, by project. */
async function exportClaudeSessions(
  configDir: string,
  sessionIds: readonly string[],
  into: string,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const projects = path.join(configDir, 'projects');
  for (const project of await names(projects)) {
    for (const sessionId of sessionIds)
      for (const member of [`${sessionId}.jsonl`, sessionId]) {
        const from = path.join(projects, project, member);
        if ((await kindOf(from)) !== null)
          await copyKeeping(from, path.join(into, project, member));
      }
  }
}

/** Copies each Codex session's rollouts into `into`, by their path under `sessions/`. */
async function exportCodexSessions(
  codexHome: string,
  sessionIds: readonly string[],
  into: string,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const sessions = path.join(codexHome, 'sessions');
  const suffixes = sessionIds.map((sessionId) => `-${sessionId}.jsonl`);
  let scanned = 0;
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await names(path.join(sessions, relative))) {
      if (scanned >= CODEX_ROLLOUTS_SCANNED_MAX) return;
      const member = path.join(relative, entry);
      const kind = await kindOf(path.join(sessions, member));
      if (kind === 'dir') await walk(member);
      else if (kind === 'file' && entry.endsWith('.jsonl')) {
        scanned += 1;
        if (
          entry.startsWith('rollout-') &&
          suffixes.some((suffix) => entry.endsWith(suffix))
        )
          await copyKeeping(
            path.join(sessions, member),
            path.join(into, member),
          );
      }
    }
  };
  await walk('');
}

/** The sessions the state among `entries` names, or null when it has none. */
function sessionsOfState(
  entries: readonly ArchiveEntry[],
  executionId: string,
): ReadonlySet<string> | null {
  const statePath = path.join(EXECUTIONS, `${executionId}.json`);
  const entry = entries.find(
    (candidate) => candidate.path === statePath && candidate.type === 'file',
  );
  if (!entry?.bytes) return null;
  let state: unknown;
  try {
    state = JSON.parse(entry.bytes.toString('utf8'));
  } catch {
    return null;
  }
  return new Set(pipelineRunnerProviderSessions(state));
}

/**
 * Whether every entry is the named run or one of the sessions its state
 * names, as an export lays them out: the run's own store entries under
 * `executions/`, a Claude project's `<session>.jsonl` and `<session>/`, and
 * a Codex `rollout-*-<session>.jsonl`. An archive with anything else, such
 * as a Claude project's memory or settings, is not a handoff: an import
 * writes nothing into a provider store but a session the run recorded.
 */
function isHandoffOf(
  entries: readonly ArchiveEntry[],
  executionId: string,
): boolean {
  const sessions = sessionsOfState(entries, executionId);
  if (sessions === null) return false;
  const own = new Set([`${executionId}.json`, `${executionId}.cancel`]);
  const folders = new Set([
    EXECUTIONS,
    'providers',
    path.join('providers', 'claude'),
    path.join('providers', 'codex'),
    path.join(...CLAUDE_PROJECTS),
    path.join(...CODEX_SESSIONS),
  ]);
  // The segments below `prefix`, or null for a path outside it.
  const under = (
    prefix: readonly string[],
    segments: readonly string[],
  ): string[] | null =>
    prefix.every((segment, index) => segments[index] === segment)
      ? segments.slice(prefix.length)
      : null;
  const codexRollout = (name: string): boolean =>
    name.startsWith('rollout-') &&
    [...sessions].some((sessionId) => name.endsWith(`-${sessionId}.jsonl`));
  for (const entry of entries) {
    if (entry.type === 'dir' && folders.has(entry.path)) continue;
    const segments = entry.path.split(path.sep);
    const [top, first, ...rest] = segments;
    // The run's temporary folder: whatever its steps left there.
    if (top === TEMP) continue;
    if (top === EXECUTIONS && first !== undefined) {
      if (rest.length === 0 && own.has(first)) {
        if (entry.type !== 'file') return false;
        continue;
      }
      if (first === executionId) continue;
      return false;
    }
    const claude = under(CLAUDE_PROJECTS, segments);
    if (claude !== null) {
      const [, member] = claude;
      // A project folder, or one of the run's sessions in it.
      if (member === undefined) {
        if (entry.type === 'dir') continue;
        return false;
      }
      const sessionId =
        claude.length === 2 &&
        entry.type === 'file' &&
        member.endsWith('.jsonl')
          ? member.slice(0, -'.jsonl'.length)
          : member;
      if (sessions.has(sessionId)) continue;
      return false;
    }
    const codex = under(CODEX_SESSIONS, segments);
    if (codex !== null) {
      const name = codex[codex.length - 1] ?? '';
      if (entry.type === 'dir' || codexRollout(name)) continue;
      return false;
    }
    return false;
  }
  return true;
}

interface Staging {
  readonly archive: WorkerPipelineHandoffArchive;
  readonly chunks: Buffer[];
  received: number;
}

interface Snapshot {
  readonly sha256: string;
  readonly bytes: Buffer;
}

function decodeChunk(chunk: string): Buffer {
  const bytes = Buffer.from(chunk, 'base64');
  if (bytes.byteLength > WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES)
    throw pipelineHandoffRefusedError(
      'A chunk of a workflow run handoff is too large.',
    );
  return bytes;
}

function sameArchive(
  a: WorkerPipelineHandoffArchive,
  b: WorkerPipelineHandoffArchive,
): boolean {
  return a.sha256 === b.sha256 && a.byteSize === b.byteSize;
}

/**
 * The runs one runner hands off: what its exports packed and its imports
 * restored. The host module refuses either call while the run is pending
 * or running, an export of a run the runner does not hold, and an import
 * once the lease ended.
 */
export class PipelineRunnerHandoffStore implements PipelineRunnerHandoffPort {
  readonly #dataRoot: string;
  readonly #providers: PipelineRunnerProviderStores | undefined;
  readonly #runTempRoot: string | undefined;
  /** Imports still receiving chunks or restoring, by execution. */
  readonly #staging = new Map<string, Staging>();
  /** Executions a start or control launched on this incarnation. */
  readonly #launched = new Set<string>();
  /** Executions whose import is checking and restoring its last chunk. */
  readonly #finishing = new Set<string>();
  /** The archive each execution's last import completed with. */
  readonly #imported = new Map<string, WorkerPipelineHandoffArchive>();
  /** The last snapshot each execution's export packed, until the next. */
  readonly #snapshots = new Map<string, Snapshot>();

  constructor(
    dataRoot: string,
    options: PipelineRunnerHandoffStoreOptions = {},
  ) {
    this.#dataRoot = dataRoot;
    this.#providers = options.providers;
    this.#runTempRoot = options.runTempRoot;
  }

  /**
   * Whether an import of the run is unfinished: a start of it meanwhile
   * would run it again from its first step, and the restore would then keep
   * that run instead of the one handed off.
   */
  restoring(executionId: string): boolean {
    return this.#staging.has(executionId) || this.#finishing.has(executionId);
  }

  /**
   * Records that this incarnation launched the run, as a start or a control
   * resolves it: its store may hold the launched run before it reports, so
   * an import of it from then on is refused rather than reported restored
   * over a run that started here.
   */
  noteLaunch(executionId: string): void {
    this.#launched.add(executionId);
  }

  get #executionsDir(): string {
    return path.join(this.#dataRoot, PIPELINE_RUNNER_EXECUTIONS_DIR);
  }

  /** A new folder beside the store, removed by `work` when it ends. */
  async #scratch<T>(work: (folder: string) => Promise<T>): Promise<T> {
    const folder = path.join(this.#dataRoot, HANDOFFS_DIR, randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      return await work(folder);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async exportHandoff(
    params: WorkerPipelineExecutionHandoffExportParams,
  ): Promise<WorkerPipelineExecutionHandoffExportResult> {
    const { executionId } = params;
    let snapshot: Snapshot | undefined;
    let offset = 0;
    if (params.snapshot) {
      snapshot = this.#snapshots.get(executionId);
      if (!snapshot || snapshot.sha256 !== params.snapshot.sha256)
        throw pipelineHandoffSnapshotGoneError();
      offset = params.snapshot.offset;
      if (offset > snapshot.bytes.byteLength)
        throw pipelineHandoffRefusedError(
          "This workflow run's handoff snapshot is shorter than that.",
        );
    } else {
      const bytes = await this.#scratch((folder) =>
        this.#pack(executionId, folder),
      );
      snapshot = { sha256: sha256(bytes), bytes };
      this.#snapshots.set(executionId, snapshot);
    }
    const end = Math.min(
      offset + WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
      snapshot.bytes.byteLength,
    );
    return {
      archive: { sha256: snapshot.sha256, byteSize: snapshot.bytes.byteLength },
      offset,
      chunk: snapshot.bytes.subarray(offset, end).toString('base64'),
      complete: end === snapshot.bytes.byteLength,
    };
  }

  /** The run's own folder under the host's run temporary root, if known. */
  #runTempDir(executionId: string): string | null {
    return this.#runTempRoot === undefined
      ? null
      : path.join(this.#runTempRoot, executionId);
  }

  /** The run, its temporary folder and its sessions, laid out in `folder` and packed. */
  async #pack(executionId: string, folder: string): Promise<Buffer> {
    const executions = path.join(folder, EXECUTIONS);
    try {
      await exportExecutionHandoff(
        this.#executionsDir,
        executionId,
        executions,
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw pipelineExecutionNotFoundError();
      throw error;
    }
    const runTemp = this.#runTempDir(executionId);
    if (runTemp !== null && (await kindOf(runTemp)) === 'dir')
      await copyKeeping(runTemp, path.join(folder, TEMP));
    const providers = this.#providers;
    if (providers) {
      const state: unknown = JSON.parse(
        await readFile(path.join(executions, `${executionId}.json`), 'utf8'),
      );
      const sessions = pipelineRunnerProviderSessions(state);
      await exportClaudeSessions(
        providers.claude,
        sessions,
        path.join(folder, ...CLAUDE_PROJECTS),
      );
      await exportCodexSessions(
        providers.codex,
        sessions,
        path.join(folder, ...CODEX_SESSIONS),
      );
    }
    return packArchive(folder, HANDOFF_ARCHIVE);
  }

  async importHandoff(
    params: WorkerPipelineExecutionHandoffImportParams,
    context: PipelineRunnerHandoffImportContext = {},
  ): Promise<WorkerPipelineExecutionHandoffImportResult> {
    const { executionId, archive, offset } = params;
    // One import of a run at a time: nothing replaces an import's staging
    // while it restores, so an older import never lands over a newer one.
    if (this.#finishing.has(executionId) || this.#launched.has(executionId))
      throw pipelineHandoffBusyError();
    const chunk = decodeChunk(params.chunk);
    const imported = this.#imported.get(executionId);
    // The last chunk sent again after it completed the import.
    if (
      imported &&
      sameArchive(imported, archive) &&
      !this.#staging.has(executionId) &&
      offset + chunk.byteLength === archive.byteSize
    )
      return { received: archive.byteSize, complete: true };
    let staging = this.#staging.get(executionId);
    if (offset === 0 && (!staging || !sameArchive(staging.archive, archive))) {
      staging = { archive, chunks: [], received: 0 };
      this.#staging.set(executionId, staging);
    }
    if (!staging || !sameArchive(staging.archive, archive))
      throw pipelineHandoffRefusedError(
        "This workflow run's handoff must be restored from its first chunk.",
      );
    // A chunk sent again after its reply was lost.
    if (
      offset + chunk.byteLength <= staging.received &&
      offset < staging.received
    )
      return { received: staging.received, complete: false };
    if (offset !== staging.received)
      throw pipelineHandoffRefusedError(
        "This workflow run's handoff arrived out of order.",
      );
    if (staging.received + chunk.byteLength > archive.byteSize) {
      this.#staging.delete(executionId);
      throw pipelineHandoffRefusedError(
        "This workflow run's handoff is longer than its archive.",
      );
    }
    staging.chunks.push(chunk);
    staging.received += chunk.byteLength;
    if (staging.received < archive.byteSize)
      return { received: staging.received, complete: false };
    this.#finishing.add(executionId);
    try {
      const bytes = Buffer.concat(staging.chunks, staging.received);
      if (sha256(bytes) !== archive.sha256)
        throw pipelineHandoffRefusedError(
          "This workflow run's handoff does not match its digest.",
        );
      // A start may have launched the run while its chunks arrived.
      if (this.#launched.has(executionId)) throw pipelineHandoffBusyError();
      const entries = parseArchive(bytes, HANDOFF_ARCHIVE);
      if (!isHandoffOf(entries, executionId))
        throw pipelineHandoffRefusedError(
          'This handoff holds something other than this workflow run.',
        );
      await this.#scratch((folder) =>
        this.#restore(executionId, entries, folder, context),
      );
    } finally {
      this.#staging.delete(executionId);
      this.#finishing.delete(executionId);
    }
    this.#imported.set(executionId, archive);
    this.#snapshots.delete(executionId);
    return { received: archive.byteSize, complete: true };
  }

  /**
   * Unpacks `entries` into `folder`, then restores the run and its sessions,
   * each only while the lease holds: this process writes outside the host's
   * lease fence, so it asks the supervisor before the run's temporary folder
   * and directory, after them, as the state is installed, and after each
   * provider store. A lease that ended meanwhile undoes what this restore
   * installed, so the import never reports a run it did not keep.
   */
  async #restore(
    executionId: string,
    entries: readonly ArchiveEntry[],
    folder: string,
    { leaseHeld }: PipelineRunnerHandoffImportContext,
  ): Promise<void> {
    const ended = (): boolean => leaseHeld?.() === false;
    const lapsed = (): Error =>
      pipelineHandoffRefusedError("This runner's lease has ended.");
    // What this restore made, which a refused restore removes again.
    const made: string[] = [];
    try {
      await unpackArchive(entries, folder);
      const runTemp = this.#runTempDir(executionId);
      const temp = path.join(folder, TEMP);
      if (runTemp !== null && (await kindOf(temp)) === 'dir') {
        if (ended()) throw lapsed();
        if ((await kindOf(runTemp)) === null) made.push(runTemp);
        // Files the run's step outputs name, at the paths they name.
        await copyKeeping(temp, runTemp);
      }
      // The store keeps a run it already holds, directory and all.
      const restored = await restoreExecutionHandoff(
        path.join(folder, EXECUTIONS),
        this.#executionsDir,
        executionId,
        leaseHeld ? { leaseHeld } : {},
      );
      if (restored === 'installed') {
        const store = executionStoreEntries(executionId, this.#executionsDir);
        made.push(store.state, store.cancellation, store.directory);
      }
      const providers = this.#providers;
      if (providers) {
        // Sessions land beside what the stores hold; nothing there is replaced.
        for (const [from, to] of [
          [CLAUDE_PROJECTS, path.join(providers.claude, 'projects')],
          [CODEX_SESSIONS, path.join(providers.codex, 'sessions')],
        ] as const) {
          if (ended()) throw lapsed();
          await copyNewFiles(path.join(folder, ...from), to, made);
        }
      }
      if (ended()) throw lapsed();
    } catch (error) {
      await Promise.all(
        made.map((target) => rm(target, { recursive: true, force: true })),
      );
      if (error instanceof CanopyOperationError) throw error;
      if (isExecutionStateWriteRefusal(error, 'owner_fenced'))
        throw pipelineHandoffRefusedError(
          "This runner's lease has ended.",
          error,
        );
      throw pipelineHandoffRefusedError(
        'This workflow run could not be restored.',
        error,
      );
    }
  }
}
