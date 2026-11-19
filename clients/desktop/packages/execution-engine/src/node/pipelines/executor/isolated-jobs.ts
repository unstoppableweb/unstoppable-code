// ---------------------------------------------------------------------------
// Read-only jobs in sandboxes of their own (CAN-6892, plan CP-65).
//
// A job that declares `isolation: read_only` only reads its workspace. When
// its runtime has an isolated job port (a cloud runner's pipeline host), the
// executor hands each of its variants to the port instead of running the
// steps here: the port runs the variant in a sandbox of its own, cut from the
// commit this workspace is at, and returns the job's result with the files
// its outputs name. The executor's scheduling around the call is unchanged:
// a variant holds its `max_parallel` slot while the port runs it, a
// `fail_fast` cancel aborts the call, and its outputs merge as a local
// variant's do. Without a port (desktop, the CLI, the daemon's own launches)
// the job runs here as any job does.
//
// The two sides:
//
// - `runIsolatedJob` (the parent): pins the commit, packs the files under the
//   run's folders that the variant's needs, inputs and environment name,
//   calls the port, writes the files the variant returns where this run keeps
//   its own, and records the result with every path moved to this run's
//   folders. A workspace with changes that are not committed can't be cut
//   from a commit, so its variants run here, as does a variant the port
//   can't place.
// - `runIsolatedJobVariant` (the child, in the variant's sandbox): checks the
//   checkout is at the commit, writes the request's files, runs the job, and
//   refuses any step that changes the checkout: the step fails, the job ends
//   failed, and nothing the step wrote leaves the sandbox.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import type {
  JobResult,
  MatrixContext,
  NormalizedJob,
  PipelineInputValue,
  PipelineJsonValue,
  ReportOutputs,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';
import type {
  CanopyEventData,
  ExpressionCanopyContext,
  ExpressionNeedsState,
} from './execution-context';
import {
  isExecutionFailureCode,
  isExecutionFailureOrigin,
} from './execution-failure';
import { runJob, type RunJobOptions } from './job-runner';
import { createPendingStep } from './retry-utils';

/** The most files a variant's request or result may carry. */
export const ISOLATED_JOB_MAX_FILES = 1_000;
/** The most bytes those files may hold, in all. */
export const ISOLATED_JOB_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The folders a side of the call keeps its files in: `workspace` is the
 * checkout's root, the others the runtime's executions and temporary roots
 * and the run's output folder. They never cross the port: a path under one
 * crosses as the same path under the wire's root of that name
 * (`isolated-root:workspace/src/a.ts`), and each side reads it under its own.
 */
interface PipelineIsolatedJobRoots {
  readonly workspace: string;
  readonly executionsDir: string;
  readonly tempRootDir: string;
  readonly outputDir: string;
}

/** The roots paths cross the port under. */
const WIRE_ROOTS: PipelineIsolatedJobRoots = {
  workspace: 'isolated-root:workspace',
  executionsDir: 'isolated-root:executions',
  tempRootDir: 'isolated-root:temp',
  outputDir: 'isolated-root:output',
};

/** A file one side sends the other, at its path under the wire's roots. */
export interface PipelineIsolatedJobFile {
  readonly path: string;
  readonly contentBase64: string;
  /** Set for a file someone may run, which is written executable. */
  readonly executable?: true;
}

/** One variant of a read-only job, as the port runs it. */
export interface PipelineIsolatedJobRequest {
  readonly version: 1;
  /** The run's execution id; the variant runs under it. */
  readonly executionId: string;
  /** The variant's physical job id. */
  readonly jobId: string;
  readonly logicalJobId: string;
  /** The commit the parent's workspace is at, with nothing uncommitted. */
  readonly commit: string;
  readonly job: NormalizedJob;
  readonly matrix?: MatrixContext;
  /** The working folder, under the wire's workspace root. */
  readonly cwd: string;
  readonly needs: Record<string, ExpressionNeedsState>;
  readonly inputs: Record<string, PipelineInputValue>;
  /** The job's environment, without secrets: the variant's runtime has its own. */
  readonly env: Record<string, string>;
  readonly canopy?: ExpressionCanopyContext;
  /** The files under the run's folders that the request's values name. */
  readonly files: readonly PipelineIsolatedJobFile[];
}

/**
 * What the port did. `unavailable` runs the variant in the parent's sandbox
 * instead, as a run with no port would; `completed` carries the variant's
 * result and the files it names, their paths under the wire's roots.
 */
export type PipelineIsolatedJobOutcome =
  | {
      readonly kind: 'completed';
      readonly job: JobResult;
      readonly files: readonly PipelineIsolatedJobFile[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Runs read-only job variants in sandboxes of their own (CAN-6892). An abort
 * of `signal` (a cancel, `fail_fast`, a checkpoint) must stop the variant and
 * settle the call; the executor then records the variant cancelled.
 */
export interface PipelineIsolatedJobPort {
  run(
    request: PipelineIsolatedJobRequest,
    signal: AbortSignal,
  ): Promise<PipelineIsolatedJobOutcome>;
}

/**
 * Where a variant placed as a child run of its own gets its request and
 * hands its outcome (CAN-6892 part 2): the child run's owner, which holds
 * both for the parent.
 */
export interface PipelineIsolatedJobVariantSource {
  request(
    jobId: string,
    signal: AbortSignal,
  ): Promise<PipelineIsolatedJobRequest>;
  report(
    jobId: string,
    outcome: Extract<PipelineIsolatedJobOutcome, { kind: 'completed' }>,
    signal: AbortSignal,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Moving paths between sides
// ---------------------------------------------------------------------------

type RootPair = readonly [from: string, to: string];

const ROOT_KEYS = [
  'workspace',
  'executionsDir',
  'tempRootDir',
  'outputDir',
] as const;

/** A side's folders, resolved. */
function resolvedRoots(
  roots: PipelineIsolatedJobRoots,
): PipelineIsolatedJobRoots {
  return {
    workspace: path.resolve(roots.workspace),
    executionsDir: path.resolve(roots.executionsDir),
    tempRootDir: path.resolve(roots.tempRootDir),
    outputDir: path.resolve(roots.outputDir),
  };
}

/** Root pairs, longest source first, so a nested root wins over its parent. */
function rootPairs(
  from: PipelineIsolatedJobRoots,
  to: PipelineIsolatedJobRoots,
): readonly RootPair[] {
  return ROOT_KEYS.map((key): RootPair => [from[key], to[key]]).sort(
    (left, right) => right[0].length - left[0].length,
  );
}

/** `value` with each root it names moved to the other side's. */
/**
 * `value` with each root it names moved to the other side's: a root followed
 * by a separator, the end, or a character no path name ends a word with
 * (space, quote, bracket, comma), so `/run/out` in `{"dir":"/run/out"}`
 * moves and `/run/outputs` doesn't.
 */
function movePaths(value: string, pairs: readonly RootPair[]): string {
  let moved = value;
  for (const [from, to] of pairs) {
    if (from === to || !moved.includes(from)) continue;
    const pattern = new RegExp(
      `${escapeRegExp(from)}(?=${escapeRegExp(path.sep)}|[\\s"'\`,;)\\]}>|]|$)`,
      'g',
    );
    moved = moved.replace(pattern, () => to);
  }
  return moved;
}

function moveRecord(
  record: Readonly<Record<string, string>>,
  pairs: readonly RootPair[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      movePaths(value, pairs),
    ]),
  );
}

function moveInput(
  value: PipelineInputValue,
  pairs: readonly RootPair[],
): PipelineInputValue {
  if (typeof value === 'string') return movePaths(value, pairs);
  if (Array.isArray(value)) return value.map((item) => moveInput(item, pairs));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, moveInput(item, pairs)]),
    );
  }
  return value;
}

function moveMatrix(
  matrix: MatrixContext,
  pairs: readonly RootPair[],
): MatrixContext {
  const move = (value: PipelineJsonValue): PipelineJsonValue => {
    if (typeof value === 'string') return movePaths(value, pairs);
    if (Array.isArray(value)) return value.map(move);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, move(item)]),
      );
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(matrix).map(([key, value]) => [key, move(value)]),
  );
}

function moveInputs(
  inputs: Readonly<Record<string, PipelineInputValue>>,
  pairs: readonly RootPair[],
): Record<string, PipelineInputValue> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [
      key,
      moveInput(value, pairs),
    ]),
  );
}

function moveNeeds(
  needs: Readonly<Record<string, ExpressionNeedsState>>,
  pairs: readonly RootPair[],
): Record<string, ExpressionNeedsState> {
  return Object.fromEntries(
    Object.entries(needs).map(([jobId, state]) => [
      jobId,
      {
        ...state,
        outputs: moveRecord(state.outputs, pairs),
        ...(state.children
          ? {
              children: state.children.map((child) => ({
                ...child,
                matrix: moveMatrix(child.matrix, pairs),
                outputs: moveRecord(child.outputs, pairs),
              })),
            }
          : {}),
      },
    ]),
  );
}

function moveReportOutputs(
  outputs: ReportOutputs | undefined,
  pairs: readonly RootPair[],
): ReportOutputs | undefined {
  if (!outputs) return undefined;
  return {
    ...(outputs.report_file === undefined
      ? {}
      : { report_file: movePaths(outputs.report_file, pairs) }),
    ...(outputs.report_json_file === undefined
      ? {}
      : { report_json_file: movePaths(outputs.report_json_file, pairs) }),
  };
}

/**
 * A variant's step as the parent records it: its state, outputs and log,
 * with paths moved. What only the variant's own host can act on (recovery
 * checkpoints, chat sends, child executions, Ledger sessions) stays there.
 */
function moveStep(step: StepResult, pairs: readonly RootPair[]): StepResult {
  const reportOutputs = moveReportOutputs(step.report_outputs, pairs);
  return {
    status: step.status,
    ...(step.conclusion === undefined ? {} : { conclusion: step.conclusion }),
    ...(step.outcome === undefined ? {} : { outcome: step.outcome }),
    outputs: moveRecord(step.outputs, pairs),
    dynamic_env: moveRecord(step.dynamic_env, pairs),
    ...(step.started_at === undefined ? {} : { started_at: step.started_at }),
    ...(step.completed_at === undefined
      ? {}
      : { completed_at: step.completed_at }),
    ...(step.exit_code === undefined ? {} : { exit_code: step.exit_code }),
    ...(step.error === undefined
      ? {}
      : { error: movePaths(step.error, pairs) }),
    // Closed values only: a value outside the closed sets is dropped.
    ...(isExecutionFailureOrigin(step.failure_origin)
      ? { failure_origin: step.failure_origin }
      : {}),
    ...(isExecutionFailureCode(step.failure_code)
      ? { failure_code: step.failure_code }
      : {}),
    ...(step.log_file === undefined
      ? {}
      : { log_file: movePaths(step.log_file, pairs) }),
    ...(step.resolved_run === undefined
      ? {}
      : { resolved_run: movePaths(step.resolved_run, pairs) }),
    ...(step.log_format_hint === undefined
      ? {}
      : { log_format_hint: step.log_format_hint }),
    ...(step.agent_provider === undefined
      ? {}
      : { agent_provider: step.agent_provider }),
    ...(step.agent_harness === undefined
      ? {}
      : { agent_harness: step.agent_harness }),
    ...(step.agent_model === undefined
      ? {}
      : { agent_model: step.agent_model }),
    ...(step.pause_requested === undefined
      ? {}
      : { pause_requested: step.pause_requested }),
    ...(reportOutputs ? { report_outputs: reportOutputs } : {}),
  };
}

function moveSteps(
  steps: Readonly<Record<string, StepResult>>,
  pairs: readonly RootPair[],
): Record<string, StepResult> {
  return Object.fromEntries(
    Object.entries(steps).map(([id, step]) => [id, moveStep(step, pairs)]),
  );
}

/** A job result with its paths moved, keeping what `moveStep` keeps. */
function moveJob(job: JobResult, pairs: readonly RootPair[]): JobResult {
  const reportOutputs = moveReportOutputs(job.report_outputs, pairs);
  return {
    status: job.status,
    ...(job.conclusion === undefined ? {} : { conclusion: job.conclusion }),
    ...(job.outcome === undefined ? {} : { outcome: job.outcome }),
    steps: moveSteps(job.steps, pairs),
    outputs: moveRecord(job.outputs, pairs),
    ...(job.started_at === undefined ? {} : { started_at: job.started_at }),
    ...(job.completed_at === undefined
      ? {}
      : { completed_at: job.completed_at }),
    retry_count: job.retry_count ?? 0,
    retry_history: (job.retry_history ?? []).map((attempt) => ({
      ...attempt,
      steps: moveSteps(attempt.steps, pairs),
      ...(attempt.iteration_history
        ? {
            iteration_history: attempt.iteration_history.map((snapshot) => ({
              ...snapshot,
              steps: moveSteps(snapshot.steps, pairs),
            })),
          }
        : {}),
    })),
    iteration_count: job.iteration_count ?? 1,
    ...(job.iteration_history
      ? {
          iteration_history: job.iteration_history.map((snapshot) => ({
            ...snapshot,
            steps: moveSteps(snapshot.steps, pairs),
          })),
        }
      : {}),
    ...(reportOutputs ? { report_outputs: reportOutputs } : {}),
  };
}

/** The event's files, plan and task, with their paths moved. */
function moveEvent(
  event: CanopyEventData,
  pairs: readonly RootPair[],
): CanopyEventData {
  return {
    ...(event.plan_ready
      ? {
          plan_ready: {
            ...event.plan_ready,
            plan_path: movePaths(event.plan_ready.plan_path, pairs),
          },
        }
      : {}),
    ...(event.task_ready
      ? {
          task_ready: {
            task_path: movePaths(event.task_ready.task_path, pairs),
            plan_path: movePaths(event.task_ready.plan_path, pairs),
          },
        }
      : {}),
  };
}

/** The files the event names. */
function eventPaths(event: CanopyEventData): string[] {
  return [
    event.plan_ready?.plan_path,
    event.task_ready?.task_path,
    event.task_ready?.plan_path,
  ].filter((value): value is string => value !== undefined && value !== '');
}

/**
 * The run's canopy context with its event's paths moved and without its
 * pipeline data folder, which is the parent's own state: a variant's
 * sandbox has its own, or none.
 */
function portableCanopy(
  canopy: ExpressionCanopyContext | undefined,
  pairs: readonly RootPair[],
): ExpressionCanopyContext | undefined {
  if (!canopy) return undefined;
  return {
    event_name: canopy.event_name,
    event: moveEvent(canopy.event, pairs),
    project_id: canopy.project_id,
    task_id: canopy.task_id,
    owner: canopy.owner,
    initiator: canopy.initiator,
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Every string a value holds. */
function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
    // A structured output is JSON text: the strings in it count too.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) yield* stringsOf(parsed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* stringsOf(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) yield* stringsOf(item);
  }
}

/** The real path of the deepest folder of `folder` that exists. */
async function existingAncestor(folder: string): Promise<string> {
  let current = path.resolve(folder);
  for (;;) {
    const real = await fsp.realpath(current).catch(() => null);
    if (real !== null) return real;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** The run folders' real paths, or their paths when they don't exist yet. */
function realFolders(bases: readonly string[]): Promise<string[]> {
  return Promise.all(
    bases.map((base) => fsp.realpath(base).catch(() => path.resolve(base))),
  );
}

/** The run folders a side may send files from and write them to. */
function fileRoots(roots: PipelineIsolatedJobRoots): readonly string[] {
  return [roots.executionsDir, roots.tempRootDir, roots.outputDir];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The paths `text` names under `bases`: the whole text when it is one, and
 * each one it holds, up to a space, quote or separator.
 */
function* pathsIn(text: string, bases: readonly string[]): Generator<string> {
  const trimmed = text.trim();
  if (path.isAbsolute(trimmed)) yield trimmed;
  for (const base of bases) {
    const pattern = new RegExp(
      `${escapeRegExp(base)}${escapeRegExp(path.sep)}[^\\s"'\`<>|;,()\\[\\]{}]+`,
      'g',
    );
    for (const match of text.matchAll(pattern)) yield match[0];
  }
}

/** Text a file holds, or null for one that isn't UTF-8 text. */
function textOf(content: Buffer): string | null {
  if (content.includes(0)) return null;
  const text = content.toString('utf8');
  return Buffer.from(text, 'utf8').equals(content) ? text : null;
}

/** `content` with the paths a text file names moved; other files as they are. */
function moveContent(content: Buffer, pairs: readonly RootPair[]): Buffer {
  const text = textOf(content);
  return text === null ? content : Buffer.from(movePaths(text, pairs), 'utf8');
}

class FileBudget {
  private count = 0;
  private bytes = 0;

  /** Takes every file, by its encoded content's size. */
  takeAll(files: readonly PipelineIsolatedJobFile[]): void {
    for (const file of files)
      this.take(Buffer.byteLength(file.contentBase64, 'base64'));
  }

  take(size: number): void {
    this.count += 1;
    this.bytes += size;
    if (this.count > ISOLATED_JOB_MAX_FILES) {
      throw new Error(
        `A read-only job's variant can carry at most ${String(ISOLATED_JOB_MAX_FILES)} files`,
      );
    }
    if (this.bytes > ISOLATED_JOB_MAX_FILE_BYTES) {
      throw new Error(
        `A read-only job's variant can carry at most ${String(ISOLATED_JOB_MAX_FILE_BYTES / (1024 * 1024))} MiB of files`,
      );
    }
  }
}

/** Whether a file found to send is left out, before it counts to the budget. */
type SkipFile = (filePath: string) => Promise<boolean>;

async function addFile(
  filePath: string,
  files: Map<string, PipelineIsolatedJobFile>,
  budget: FileBudget,
  realBases: readonly string[],
  skip: SkipFile | undefined,
): Promise<void> {
  if (files.has(filePath)) return;
  // A link is never followed: it could name a file outside the run's folders.
  const stat = await fsp.lstat(filePath).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    for (const entry of await fsp.readdir(filePath)) {
      await addFile(path.join(filePath, entry), files, budget, realBases, skip);
    }
    return;
  }
  if (!stat.isFile()) return;
  // The path as written is in a run folder; a link on the way could still
  // lead out of it. Only a file really inside one is sent.
  const real = await fsp.realpath(filePath).catch(() => null);
  if (real === null || !realBases.some((base) => isPathInside(base, real)))
    return;
  if (skip && (await skip(filePath))) return;
  budget.take(stat.size);
  files.set(filePath, {
    path: filePath,
    contentBase64: (await fsp.readFile(filePath)).toString('base64'),
    ...((stat.mode & 0o111) !== 0 ? { executable: true } : {}),
  });
}

/**
 * The files and folders under `roots`' run folders that `value`'s strings
 * name, whole or within them, JSON text included. A folder sends every file
 * in it. Each file crosses at its wire path, a text file with the paths it
 * names moved to the wire's roots too.
 */
async function collectFiles(
  value: unknown,
  roots: PipelineIsolatedJobRoots,
  toWire: readonly RootPair[],
  /**
   * The run folders a value may name whole to send what is in them. The
   * environment names the run's output folder for every step, so it walks
   * none; a value a job set (an output, an input) walks any.
   */
  walkFolders: readonly string[],
  skip?: SkipFile,
): Promise<PipelineIsolatedJobFile[]> {
  const files = new Map<string, PipelineIsolatedJobFile>();
  const budget = new FileBudget();
  const bases = fileRoots(roots);
  const realBases = await realFolders(bases);
  const candidates = new Set<string>();
  for (const text of stringsOf(value)) {
    for (const candidate of pathsIn(text, bases)) candidates.add(candidate);
  }
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!bases.some((base) => isPathInside(base, resolved))) continue;
    if (
      bases.some((base) => path.resolve(base) === resolved) &&
      !walkFolders.some((folder) => path.resolve(folder) === resolved)
    )
      continue;
    await addFile(resolved, files, budget, realBases, skip);
  }
  return [...files.values()].map((file) => ({
    ...file,
    path: movePaths(file.path, toWire),
    contentBase64: moveContent(
      Buffer.from(file.contentBase64, 'base64'),
      toWire,
    ).toString('base64'),
  }));
}

/** Writes the other side's files at their paths here; each must land in a run folder. */
async function writeFiles(
  files: readonly PipelineIsolatedJobFile[],
  pairs: readonly RootPair[],
  roots: PipelineIsolatedJobRoots,
): Promise<void> {
  const bases = fileRoots(roots);
  const budget = new FileBudget();
  for (const file of files) {
    const target = path.resolve(movePaths(file.path, pairs));
    if (
      !bases.some(
        (base) => isPathInside(base, target) && target !== path.resolve(base),
      )
    ) {
      throw new Error(
        "A read-only job's variant sent a file outside the run's folders",
      );
    }
    const content = moveContent(
      Buffer.from(file.contentBase64, 'base64'),
      pairs,
    );
    budget.take(content.byteLength);
    // The deepest folder already there must really be in a run folder, or
    // on the way to one not made yet, before any folder is made under it.
    const realBases = await realFolders(bases);
    const ancestor = await existingAncestor(path.dirname(target));
    if (
      !realBases.some(
        (base) => isPathInside(base, ancestor) || isPathInside(ancestor, base),
      )
    ) {
      throw new Error(
        "A read-only job's variant sent a file outside the run's folders",
      );
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // The check above is on the path as written: a link on the way (one an
    // earlier step left in a run folder) could still lead out. The folder
    // must really be in a run folder, and the file is never a link.
    const folder = await fsp.realpath(path.dirname(target));
    if (!realBases.some((base) => isPathInside(base, folder))) {
      throw new Error(
        "A read-only job's variant sent a file outside the run's folders",
      );
    }
    const destination = path.join(folder, path.basename(target));
    // A file that is already here as sent stays as it is: other variants
    // may be reading it.
    const mode = file.executable ? 0o700 : 0o600;
    const existing = await fsp.lstat(destination).catch(() => null);
    if (
      existing?.isFile() &&
      ((existing.mode & 0o111) !== 0) === (file.executable === true)
    ) {
      const current = await fsp.readFile(destination).catch(() => null);
      if (current?.equals(content)) continue;
    }
    // Written beside it and renamed over it, so no reader sees part of it;
    // the rename replaces a link rather than following it.
    const temporary = path.join(
      folder,
      `.${path.basename(target)}.${randomUUID()}.isolated`,
    );
    const handle = await fsp.open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(content);
      // The process's umask may have narrowed the mode it was created with.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, destination);
  }
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

function git(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

interface WorkspaceState {
  readonly root: string;
  readonly commit: string;
  /** Each uncommitted change as porcelain `XY path`, sorted. */
  readonly changes: readonly string[];
}

/**
 * The checkout's root, its commit, and what in it is uncommitted, leaving
 * out the run's own folders should they lie inside it.
 */
async function workspaceState(
  cwd: string,
  runFolders: readonly string[],
): Promise<WorkspaceState | null> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  const commit = (await git(cwd, ['rev-parse', '--verify', 'HEAD']))?.trim();
  const status = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
  ]);
  if (!root || !commit || status === null) return null;
  const changes = status
    .split('\0')
    .filter((entry) => entry.length > 3)
    .filter(
      (entry) =>
        !runFolders.some((folder) =>
          isPathInside(folder, path.join(root, entry.slice(3))),
        ),
    )
    .sort();
  return { root, commit, changes };
}

function sameChanges(left: WorkspaceState, right: WorkspaceState): boolean {
  return (
    left.changes.length === right.changes.length &&
    left.changes.every((change, index) => change === right.changes[index])
  );
}

// ---------------------------------------------------------------------------
// The parent side
// ---------------------------------------------------------------------------

function failedJob(
  options: RunJobOptions,
  message: string,
  conclusion: 'failure' | 'cancelled',
): JobResult {
  const now = new Date().toISOString();
  const [first, ...rest] = options.job.steps;
  const steps: Record<string, StepResult> = {};
  if (first) {
    steps[first.id] = {
      status: conclusion,
      conclusion,
      outcome: conclusion,
      outputs: {},
      dynamic_env: {},
      ...(conclusion === 'failure' ? { error: message } : {}),
      completed_at: now,
    };
  }
  // As here: a failure leaves the steps after it pending, a cancel cancels them.
  for (const step of rest) {
    steps[step.id] =
      conclusion === 'failure'
        ? createPendingStep()
        : {
            status: 'cancelled',
            conclusion: 'cancelled',
            outcome: 'cancelled',
            outputs: {},
            dynamic_env: {},
            completed_at: now,
          };
  }
  Object.assign(options.jobResult, {
    status: conclusion,
    conclusion: toleratedConclusion(options, conclusion),
    outcome: conclusion,
    steps,
    outputs: {},
    completed_at: now,
  });
  return options.jobResult;
}

/**
 * A failed job's conclusion as `runJob` finalizes it: a job that tolerates
 * failure (`continue_on_error`) concludes success, so its dependents run.
 */
function toleratedConclusion(
  options: RunJobOptions,
  outcome: 'failure' | 'cancelled',
): 'success' | 'failure' | 'cancelled' {
  return outcome === 'failure' && options.job.continue_on_error
    ? 'success'
    : outcome;
}

/**
 * The job's definition alone: an executor's job also carries the variant's
 * materialized matrix (host paths included), which the request sends moved.
 */
function jobDefinition(job: NormalizedJob): NormalizedJob {
  return {
    name: job.name,
    needs: job.needs,
    ...(job.if === undefined ? {} : { if: job.if }),
    ...(job.env === undefined ? {} : { env: job.env }),
    ...(job.outputs === undefined ? {} : { outputs: job.outputs }),
    timeout_minutes: job.timeout_minutes,
    max_retries: job.max_retries,
    ...(job.max_iterations === undefined
      ? {}
      : { max_iterations: job.max_iterations }),
    ...(job.max_iterations_expression === undefined
      ? {}
      : { max_iterations_expression: job.max_iterations_expression }),
    continue_on_error: job.continue_on_error,
    ...(job.continue_on_error_expression === undefined
      ? {}
      : { continue_on_error_expression: job.continue_on_error_expression }),
    ...(job.isolation === undefined ? {} : { isolation: job.isolation }),
    steps: job.steps,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one variant of a read-only job through `port`, or here when its
 * workspace can't be cut from a commit or the port can't place it. Records
 * the variant's result in `options.jobResult` as `runJob` would.
 */
export async function runIsolatedJob(
  options: RunJobOptions,
  port: PipelineIsolatedJobPort,
  run: { readonly outputDir: string; readonly logicalJobId: string },
): Promise<JobResult> {
  const workspace = await workspaceState(options.repoPath ?? options.cwd, [
    options.runtime.executionsDir,
    options.runtime.tempRootDir,
    run.outputDir,
  ]);
  if (!workspace || workspace.changes.length > 0) return runJob(options);

  const roots = resolvedRoots({
    workspace: workspace.root,
    executionsDir: options.runtime.executionsDir,
    tempRootDir: options.runtime.tempRootDir,
    outputDir: run.outputDir,
  });
  const toWire = rootPairs(roots, WIRE_ROOTS);
  const fromWire = rootPairs(WIRE_ROOTS, roots);
  // An event file outside the checkout and the run's folders can't reach
  // another sandbox: such a variant runs here.
  const reachable = [roots.workspace, ...fileRoots(roots)];
  const eventFiles = options.canopy ? eventPaths(options.canopy.event) : [];
  if (
    eventFiles.some(
      (file) =>
        !reachable.some((root) => isPathInside(root, path.resolve(file))),
    )
  )
    return runJob(options);
  // The files the variant needs: what its needs, inputs, matrix and event
  // name, and what its environment names under the run's folders. More than
  // a variant can carry runs it here.
  let files: PipelineIsolatedJobFile[];
  try {
    const named = await collectFiles(
      {
        needs: options.needs,
        inputs: options.inputs,
        matrix: options.matrix,
        event: eventFiles,
      },
      roots,
      toWire,
      fileRoots(roots),
    );
    const fromEnv = await collectFiles(options.env, roots, toWire, []);
    const byPath = new Map(named.map((file) => [file.path, file]));
    for (const file of fromEnv) byPath.set(file.path, file);
    files = [...byPath.values()];
    new FileBudget().takeAll(files);
  } catch {
    return runJob(options);
  }
  // The variant starts afresh in its sandbox: its steps show pending until
  // it answers. An unavailable port puts the job back as it was.
  const pristine = structuredClone(options.jobResult);
  options.jobResult.started_at ??= new Date().toISOString();
  options.jobResult.status = 'running';
  options.jobResult.completed_at = undefined;
  options.jobResult.steps = Object.fromEntries(
    options.job.steps.map((step) => [step.id, createPendingStep()]),
  );
  options.jobResult.outputs = {};
  await options.saveState();

  let outcome: PipelineIsolatedJobOutcome;
  try {
    const canopy = portableCanopy(options.canopy, toWire);
    outcome = await port.run(
      {
        version: 1,
        executionId: options.executionId,
        jobId: options.jobId,
        logicalJobId: run.logicalJobId,
        commit: workspace.commit,
        job: jobDefinition(options.job),
        ...(options.matrix
          ? { matrix: moveMatrix(options.matrix, toWire) }
          : {}),
        // git names the checkout by its real path; so does the folder here.
        cwd: movePaths(
          await fsp
            .realpath(options.cwd)
            .catch(() => path.resolve(options.cwd)),
          toWire,
        ),
        needs: moveNeeds(options.needs, toWire),
        inputs: moveInputs(options.inputs, toWire),
        env: moveRecord(options.env, toWire),
        ...(canopy ? { canopy } : {}),
        files,
      },
      options.signal,
    );
  } catch (error) {
    const result = options.signal.aborted
      ? failedJob(options, '', 'cancelled')
      : failedJob(
          options,
          `The read-only job's sandbox failed: ${errorMessage(error)}`,
          'failure',
        );
    await options.saveState();
    return result;
  }

  if (outcome.kind === 'unavailable') {
    for (const key of Object.keys(options.jobResult)) {
      if (!(key in pristine)) Reflect.deleteProperty(options.jobResult, key);
    }
    Object.assign(options.jobResult, pristine);
    return runJob(options);
  }
  if (options.signal.aborted) {
    const result = failedJob(options, '', 'cancelled');
    await options.saveState();
    return result;
  }

  try {
    await writeFiles(outcome.files, fromWire, roots);
  } catch (error) {
    const result = failedJob(options, errorMessage(error), 'failure');
    await options.saveState();
    return result;
  }
  // A cancel while the files were written still cancels the variant.
  if (options.signal.aborted) {
    const result = failedJob(options, '', 'cancelled');
    await options.saveState();
    return result;
  }

  const variant = moveJob(outcome.job, fromWire);
  Object.assign(options.jobResult, {
    ...variant,
    // The job's steps in order; one the variant never reached stays
    // pending, as it would here.
    steps: Object.fromEntries(
      options.job.steps.map((step) => [
        step.id,
        variant.steps[step.id] ?? createPendingStep(),
      ]),
    ),
    started_at: options.jobResult.started_at,
    completed_at: variant.completed_at ?? new Date().toISOString(),
  });
  if (variant.status === 'paused') {
    // A variant pauses only in its own sandbox, which the parent can't resume.
    // The step that paused it (paused itself, or one that asked to pause and
    // succeeded) carries the reason.
    const pausedId = Object.entries(outcome.job.steps).find(
      ([, step]) => step.status === 'paused' || step.pause_requested === true,
    )?.[0];
    const paused =
      pausedId === undefined
        ? undefined
        : Object.entries(options.jobResult.steps).find(
            ([id]) => id === pausedId,
          );
    const message =
      "A read-only job's variant can't pause in its own sandbox; run the job without isolation to pause it";
    if (!paused) {
      const result = failedJob(options, message, 'failure');
      await options.saveState();
      return result;
    }
    {
      paused[1].status = 'failure';
      paused[1].conclusion = 'failure';
      paused[1].outcome = 'failure';
      paused[1].error = message;
      paused[1].completed_at = new Date().toISOString();
    }
    options.jobResult.status = 'failure';
    options.jobResult.conclusion = toleratedConclusion(options, 'failure');
    options.jobResult.outcome = 'failure';
    options.jobResult.completed_at = new Date().toISOString();
  } else if (
    variant.status !== 'success' &&
    variant.status !== 'failure' &&
    variant.status !== 'cancelled' &&
    variant.status !== 'skipped'
  ) {
    const result = failedJob(
      options,
      `A read-only job's variant ended unfinished (${variant.status})`,
      'failure',
    );
    await options.saveState();
    return result;
  }
  await options.saveState();
  return options.jobResult;
}

// ---------------------------------------------------------------------------
// The child side
// ---------------------------------------------------------------------------

/** The message a step that changed a read-only job's checkout fails with. */
export const READ_ONLY_WORKSPACE_WRITE_MESSAGE =
  "This step changed the workspace, which a read-only job may not do; its changes stay in the job's own sandbox";

export interface IsolatedJobVariantContext extends Pick<
  RunJobOptions,
  | 'runtime'
  | 'secretEnv'
  | 'signal'
  | 'modelConfig'
  | 'modelAliases'
  | 'modelAliasPreferences'
  | 'resolvedPluginCollections'
  | 'pipelineId'
  | 'pipelineName'
  | 'pipelineAssets'
  | 'projectId'
  | 'worktreeId'
  | 'initiationSource'
  | 'scope'
  | 'onStepOutput'
  | 'onEvent'
  | 'capacity'
  | 'pipelinePackageOverlay'
  | 'pipelinePackageBindings'
> {
  /** The variant's own checkout. */
  readonly workspace: string;
  /** The variant's own output folder. */
  readonly outputDir: string;
  /** The variant's own pipeline data folder, when its sandbox has one. */
  readonly pipelineDataDir?: string;
  /**
   * The execution the variant's steps run as: a child run of its own
   * (part 2), whose owner answers its model routes and Ledger under that
   * id, with its output folder that execution's. The request's, the
   * parent's, by default.
   */
  readonly executionId?: string;
}

/**
 * Runs one read-only job variant in the sandbox the port placed it in (the
 * child side). The checkout must be at the request's commit; a step that
 * changes it fails and ends the job failed.
 */
export async function runIsolatedJobVariant(
  request: PipelineIsolatedJobRequest,
  context: IsolatedJobVariantContext,
): Promise<Extract<PipelineIsolatedJobOutcome, { kind: 'completed' }>> {
  return (await runVariant(request, context)).outcome;
}

/** The variant's outcome, and its result with this sandbox's own paths. */
async function runVariant(
  request: PipelineIsolatedJobRequest,
  context: IsolatedJobVariantContext,
): Promise<{
  readonly outcome: Extract<PipelineIsolatedJobOutcome, { kind: 'completed' }>;
  readonly local: JobResult;
}> {
  const runFolders = [
    context.runtime.executionsDir,
    context.runtime.tempRootDir,
    context.outputDir,
  ];
  const before = await workspaceState(context.workspace, runFolders);
  if (!before) {
    throw new Error("The read-only job's sandbox has no git checkout");
  }
  if (before.commit !== request.commit) {
    throw new Error(
      `The read-only job's sandbox is at ${before.commit}, not the run's ${request.commit}`,
    );
  }
  const roots = resolvedRoots({
    workspace: before.root,
    executionsDir: context.runtime.executionsDir,
    tempRootDir: context.runtime.tempRootDir,
    outputDir: context.outputDir,
  });
  // Run as an execution of its own, its steps' temporary folder is that
  // execution's: it crosses as the parent's, so the parent reads its files
  // where its own variant would have written them.
  const runAs = context.executionId ?? request.executionId;
  const ownTemp: readonly RootPair[] =
    runAs === request.executionId
      ? []
      : [
          [
            path.join(roots.tempRootDir, runAs),
            `${WIRE_ROOTS.tempRootDir}/${request.executionId}`,
          ],
        ];
  const inbound: readonly RootPair[] = [
    ...ownTemp.map(([local, wire]): RootPair => [wire, local]),
    ...rootPairs(WIRE_ROOTS, roots),
  ];
  const toWire: readonly RootPair[] = [
    ...ownTemp,
    ...rootPairs(roots, WIRE_ROOTS),
  ];
  await writeFiles(request.files, inbound, roots);
  // What the request delivered, as delivered: an input the variant left as
  // it was is not sent back.
  const delivered = new Map(
    await Promise.all(
      request.files.map(async (file): Promise<[string, string | null]> => {
        const local = path.resolve(movePaths(file.path, inbound));
        return [local, await fileDigest(local)];
      }),
    ),
  );
  await fsp.mkdir(context.outputDir, { recursive: true });

  let refused = false;
  const jobResult: JobResult = {
    status: 'pending',
    steps: {},
    outputs: {},
    retry_count: 0,
    retry_history: [],
    iteration_count: 0,
  };
  const canopy = request.canopy
    ? {
        ...request.canopy,
        event: moveEvent(request.canopy.event, inbound),
        ...(context.pipelineDataDir === undefined
          ? {}
          : { pipeline_data_dir: context.pipelineDataDir }),
      }
    : undefined;
  await runJob({
    executionId: runAs,
    jobId: request.jobId,
    pipeline: {
      name: context.pipelineName ?? request.jobId,
      scope: ['directory'],
      jobs: {},
    },
    job: request.job,
    jobResult,
    cwd: movePaths(request.cwd, inbound),
    env: moveRecord(request.env, inbound),
    secretEnv: context.secretEnv,
    runtime: context.runtime,
    repoPath: roots.workspace,
    ...(context.scope ? { scope: context.scope } : {}),
    ...(context.modelConfig ? { modelConfig: context.modelConfig } : {}),
    needs: moveNeeds(request.needs, inbound),
    inputs: moveInputs(request.inputs, inbound),
    ...(canopy ? { canopy } : {}),
    ...(context.pipelineAssets
      ? { pipelineAssets: context.pipelineAssets }
      : {}),
    signal: context.signal,
    saveState: () => Promise.resolve(),
    ...(context.onStepOutput ? { onStepOutput: context.onStepOutput } : {}),
    ...(context.onEvent ? { onEvent: context.onEvent } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
    ...(context.initiationSource
      ? { initiationSource: context.initiationSource }
      : {}),
    ...(context.pipelineId ? { pipelineId: context.pipelineId } : {}),
    ...(context.pipelineName ? { pipelineName: context.pipelineName } : {}),
    ...(context.resolvedPluginCollections
      ? { resolvedPluginCollections: context.resolvedPluginCollections }
      : {}),
    ...(context.modelAliases ? { modelAliases: context.modelAliases } : {}),
    ...(context.modelAliasPreferences
      ? { modelAliasPreferences: context.modelAliasPreferences }
      : {}),
    ...(request.matrix ? { matrix: moveMatrix(request.matrix, inbound) } : {}),
    pipelinePackageLogicalJobId: request.logicalJobId,
    ...(context.pipelinePackageOverlay
      ? { pipelinePackageOverlay: context.pipelinePackageOverlay }
      : {}),
    ...(context.pipelinePackageBindings
      ? { pipelinePackageBindings: context.pipelinePackageBindings }
      : {}),
    ...(context.capacity ? { capacity: context.capacity } : {}),
    afterStep: async (): Promise<string | null> => {
      const after = await workspaceState(context.workspace, runFolders);
      if (after && after.commit === before.commit && sameChanges(before, after))
        return null;
      refused = true;
      if (!after) return READ_ONLY_WORKSPACE_WRITE_MESSAGE;
      if (after.commit !== before.commit)
        return `${READ_ONLY_WORKSPACE_WRITE_MESSAGE} (it moved HEAD to ${after.commit})`;
      const changed = after.changes
        .filter((change) => !before.changes.includes(change))
        .map((change) => change.slice(3));
      const named = changed.slice(0, 5).join(', ');
      return named
        ? `${READ_ONLY_WORKSPACE_WRITE_MESSAGE} (${named}${changed.length > 5 ? ', …' : ''})`
        : READ_ONLY_WORKSPACE_WRITE_MESSAGE;
    },
  });
  if (refused) {
    // A refused write fails the job whatever its continue_on_error says.
    jobResult.status = 'failure';
    jobResult.conclusion = 'failure';
    jobResult.outcome = 'failure';
  }
  const result = moveJob(jobResult, toWire);
  // An input left as it was delivered never counts to the return budget.
  const returned = await collectFiles(
    moveJob(jobResult, []),
    roots,
    toWire,
    [roots.outputDir],
    async (filePath) => {
      const before = delivered.get(path.resolve(filePath));
      return before !== undefined && before === (await fileDigest(filePath));
    },
  );
  return {
    outcome: { kind: 'completed', job: result, files: returned },
    local: jobResult,
  };
}

/**
 * Runs this child run's one job as the variant its owner holds (CAN-6892
 * part 2): reads the request, runs it in this sandbox as
 * `runIsolatedJobVariant` does, as this run, and hands the outcome back.
 * The run's own record keeps the variant's steps; a variant that asked to
 * pause is recorded failed, since a variant's run never pauses.
 */
export async function runIsolatedJobAsVariant(
  options: RunJobOptions,
  source: PipelineIsolatedJobVariantSource,
  run: { readonly outputDir: string },
): Promise<JobResult> {
  options.jobResult.started_at ??= new Date().toISOString();
  options.jobResult.status = 'running';
  await options.saveState();
  let job: JobResult;
  try {
    const request = await source.request(options.jobId, options.signal);
    const pipelineDataDir = options.canopy?.pipeline_data_dir;
    const ran = await runVariant(request, {
      runtime: options.runtime,
      signal: options.signal,
      // Its steps run as this run, whose owner answers its model routes and
      // Ledger; its output folder is this run's, so what they write there
      // returns to the parent's.
      executionId: options.executionId,
      workspace: options.repoPath ?? options.cwd,
      outputDir: run.outputDir,
      ...(pipelineDataDir === undefined ? {} : { pipelineDataDir }),
      ...(options.secretEnv ? { secretEnv: options.secretEnv } : {}),
      ...(options.modelConfig ? { modelConfig: options.modelConfig } : {}),
      ...(options.modelAliases ? { modelAliases: options.modelAliases } : {}),
      ...(options.modelAliasPreferences
        ? { modelAliasPreferences: options.modelAliasPreferences }
        : {}),
      ...(options.resolvedPluginCollections
        ? { resolvedPluginCollections: options.resolvedPluginCollections }
        : {}),
      ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options.pipelineName ? { pipelineName: options.pipelineName } : {}),
      ...(options.pipelineAssets
        ? { pipelineAssets: options.pipelineAssets }
        : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
      ...(options.initiationSource
        ? { initiationSource: options.initiationSource }
        : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.onStepOutput ? { onStepOutput: options.onStepOutput } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.capacity ? { capacity: options.capacity } : {}),
      ...(options.pipelinePackageOverlay
        ? { pipelinePackageOverlay: options.pipelinePackageOverlay }
        : {}),
      ...(options.pipelinePackageBindings
        ? { pipelinePackageBindings: options.pipelinePackageBindings }
        : {}),
    });
    await source.report(options.jobId, ran.outcome, options.signal);
    job = ran.local;
  } catch (error) {
    const result = options.signal.aborted
      ? failedJob(options, '', 'cancelled')
      : failedJob(options, errorMessage(error), 'failure');
    await options.saveState();
    return result;
  }
  const paused = job.status === 'paused';
  Object.assign(options.jobResult, {
    ...job,
    steps: Object.fromEntries(
      options.job.steps.map((step) => [
        step.id,
        job.steps[step.id] ?? createPendingStep(),
      ]),
    ),
    started_at: options.jobResult.started_at,
    completed_at: job.completed_at ?? new Date().toISOString(),
    ...(paused
      ? { status: 'failure', conclusion: 'failure', outcome: 'failure' }
      : {}),
  });
  await options.saveState();
  return options.jobResult;
}

/** A file's SHA-256 and whether it is executable, or null when it can't be read. */
async function fileDigest(filePath: string): Promise<string | null> {
  const [content, stat] = await Promise.all([
    fsp.readFile(filePath).catch(() => null),
    fsp.lstat(filePath).catch(() => null),
  ]);
  if (content === null || stat === null) return null;
  const executable = (stat.mode & 0o111) !== 0 ? 'x' : '-';
  return `${createHash('sha256').update(content).digest('hex')}:${executable}`;
}
