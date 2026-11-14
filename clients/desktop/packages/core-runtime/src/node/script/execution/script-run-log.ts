import {
  isScriptRunChildIdentified,
  type ScriptRunChildStop,
  type ScriptRunChildStopMode,
  type ScriptRunGroupListing,
  type ScriptRunGroupStop,
} from './script-run-stop';
import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  CoreScriptCommandShellSchema,
  WorkerScriptDescriptorSchema,
  type WorkerScriptDescriptor,
  type WorkerScriptExecution,
} from '@canopy/protocol/canopy-core';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
} from '@canopy/protocol/scripts';

import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  readRunLogTailLines,
  startRunLogFiles,
  writeRunLogMeta,
  type RunLogFiles,
} from './run-log-files';

export type ScriptRunInvocation = WorkerScriptExecution['invocation'];

export interface PersistedScriptRunFile {
  version: 1;
  runId: string;
  script: WorkerScriptDescriptor;
  invocation: ScriptRunInvocation;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  // This advances when metadata changes, not on every log append.
  updatedAt: string;
  completedAt?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /**
   * The store instance that started the run. A running run another instance
   * started was interrupted by a restart.
   */
  instanceId?: string;
  /** The process that started the run (CAN-5087). Earlier versions ignore it. */
  writer?: ScriptRunWriter;
  /**
   * `lost`: a restart interrupted the run, so its outcome is unknown. Its
   * status reads `failed`, which earlier versions show without this field.
   */
  outcome?: 'lost';
  /**
   * The script's own process, identified as it started (CAN-6482). The run
   * id is its marker: a reap after a restart must find this process
   * unchanged. Earlier versions ignore it.
   */
  child?: ScriptRunChild;
  /**
   * A restart left the run's process running and its identity could not be
   * proven, so nothing was killed (CAN-6482). The status stays `running`,
   * which earlier versions show without this field.
   */
  orphaned?: true;
}

/**
 * A script's own process as it started (CAN-6482): its PID, and what the OS
 * reported for its process group, start identity and executable path. A part
 * the OS could not report is absent, and such a record is never reaped.
 */
export interface ScriptRunChild {
  readonly pid: number;
  readonly processGroupId?: number;
  readonly startIdentity?: string;
  readonly executablePath?: string;
}

/**
 * What a reap of a recorded child did: `reaped` ended a group whose every
 * recorded part matched, `gone` found no process, and `unproven` killed
 * nothing because a part was missing or differed (a reused PID included).
 */
export type ScriptRunChildReap = 'reaped' | 'gone' | 'unproven';

/** The process that started a run: its PID and the start identity the host's process inspector reports. */
export interface ScriptRunWriter {
  readonly pid: number;
  readonly startIdentity: string;
}

/** `unverifiable`: the inspector could not tell; the run is left as it is. */
export type ScriptRunWriterState = 'running' | 'gone' | 'unverifiable';

/**
 * How a run-log store tells a run another live process writes from one a
 * restart interrupted (CAN-5087). Electron main and the daemon both write
 * `script_runs`.
 */
export interface ScriptRunWriterFence {
  /** This process; `null` when its identity cannot be read. Called once per store. */
  self(): Promise<ScriptRunWriter | null>;
  inspect(writer: ScriptRunWriter): Promise<ScriptRunWriterState>;
  /** A script process's identity as it starts; null when it cannot be read (CAN-6482). */
  identifyChild?(pid: number): Promise<ScriptRunChild | null>;
  /**
   * Ends a recorded child's process group only when everything recorded
   * matches what the OS reports now for that PID and group (CAN-6482).
   */
  reapChild?(child: ScriptRunChild): Promise<ScriptRunChildReap>;
  /**
   * Stops an orphaned run's recorded process on a user's request (CAN-6482
   * part 2), as `stopScriptRunChild` does over the host's process services.
   */
  stopChild?(
    child: ScriptRunChild,
    mode: ScriptRunChildStopMode,
  ): Promise<ScriptRunChildStop>;
  /**
   * An orphaned run's live group members once its leader has exited, as
   * `listScriptRunGroup` reads them (CAN-6601). Absent without process groups.
   */
  listGroup?(
    child: ScriptRunChild,
    runStartedAtMs: number,
    runId: string,
  ): Promise<ScriptRunGroupListing>;
  /** A user's confirmed group Force stop, as `forceStopScriptRunGroup` does it (CAN-6601). */
  stopGroup?(
    child: ScriptRunChild,
    runStartedAtMs: number,
    runId: string,
    members: readonly {
      readonly pid: number;
      readonly startIdentity: string;
    }[],
  ): Promise<ScriptRunGroupStop>;
}

export interface ScriptRunLogRef {
  projectId: string;
  worktreeId: string;
  script: WorkerScriptDescriptor;
  runId: string;
}

/** How a finished run is written to its log. */
export interface ScriptRunCompletion {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type ScriptRunLogSnapshotResult =
  | { status: 'copied' }
  | { status: 'superseded' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** Where a worktree's run logs live; the host owns the layout's root. */
export interface ScriptRunLogPaths {
  runDir(projectId: string, worktreeId: string): string;
  fileStem(scriptKey: string): string;
}

/**
 * Holds `work` while no other process writes the same worktree's run logs
 * (CAN-5839). Electron main and the daemon both write `script_runs`; a lock
 * that cannot be taken rejects, and the write is dropped rather than made
 * unlocked.
 */
export interface RunLogProcessLock {
  run<T>(runDir: string, work: () => Promise<T>): Promise<T>;
}

export interface ScriptRunLogStoreOptions {
  paths: ScriptRunLogPaths;
  files: RunLogFiles;
  warn?: (message: string, details: Record<string, unknown>) => void;
  clock?: () => number;
  writerFence?: ScriptRunWriterFence;
  processLock?: RunLogProcessLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScriptRunWriter(value: unknown): ScriptRunWriter | null {
  if (
    !isRecord(value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startIdentity !== 'string' ||
    value.startIdentity.length === 0 ||
    value.startIdentity.length > 512
  )
    return null;
  return { pid: value.pid, startIdentity: value.startIdentity };
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function parseScriptRunChild(value: unknown): ScriptRunChild | null {
  if (
    !isRecord(value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1
  )
    return null;
  const group = value.processGroupId;
  const startIdentity = boundedText(value.startIdentity, 512);
  const executablePath = boundedText(value.executablePath, 4096);
  return {
    pid: value.pid,
    ...(typeof group === 'number' && Number.isSafeInteger(group) && group > 1
      ? { processGroupId: group }
      : {}),
    ...(startIdentity ? { startIdentity } : {}),
    ...(executablePath ? { executablePath } : {}),
  };
}

function isScriptInvocation(value: unknown): value is ScriptRunInvocation {
  return (
    value === 'automatic-setup' ||
    value === 'manual-run' ||
    value === 'manual-lifecycle' ||
    value === 'workspace-lifecycle'
  );
}

const SCRIPT_LIFECYCLES: ReadonlySet<unknown> = new Set([
  'custom',
  'setup',
  'launch',
  'teardown',
  'before-setup',
  'after-setup',
  'before-launch',
  'after-launch',
  'before-teardown',
  'after-teardown',
]);

function isDevServerPatternSource(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const pattern = value.trim();
  if (
    pattern.length === 0 ||
    pattern.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH
  )
    return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isDevServerPatternEntry(value: unknown): boolean {
  if (typeof value === 'string') return isDevServerPatternSource(value);
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value))
    if (
      key !== 'pattern' &&
      key !== 'label' &&
      key !== 'openTarget' &&
      key !== 'autoOpen'
    )
      return false;
  if (!isDevServerPatternSource(value.pattern)) return false;
  if (value.label !== undefined) {
    if (typeof value.label !== 'string') return false;
    const label = value.label.trim();
    if (label.length === 0 || label.length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH)
      return false;
  }
  if (
    value.openTarget !== undefined &&
    value.openTarget !== 'in-app' &&
    value.openTarget !== 'external'
  )
    return false;
  return value.autoOpen === undefined || typeof value.autoOpen === 'boolean';
}

function isDevServerPattern(value: unknown): boolean {
  if (Array.isArray(value))
    return (
      value.length > 0 &&
      value.length <= MAX_SCRIPT_DEV_SERVER_PATTERNS &&
      value.every(isDevServerPatternEntry)
    );
  return isDevServerPatternEntry(value);
}

/**
 * The descriptor a run log names, read as leniently as earlier versions
 * wrote it and projected onto the protocol's fields; anything the protocol
 * cannot carry is dropped rather than making the run unreadable.
 */
function parseScriptDescriptor(value: unknown): WorkerScriptDescriptor | null {
  if (
    !isRecord(value) ||
    typeof value.scriptKey !== 'string' ||
    typeof value.scriptName !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.command !== 'string' ||
    !SCRIPT_LIFECYCLES.has(value.lifecycle) ||
    !(
      value.target === 'project' ||
      value.target === 'workspace-root' ||
      value.target === 'workspace-repo'
    ) ||
    (value.repoId !== undefined && typeof value.repoId !== 'string') ||
    (value.repoName !== undefined && typeof value.repoName !== 'string') ||
    (value.devServerPattern !== undefined &&
      !isDevServerPattern(value.devServerPattern))
  )
    return null;
  const parsed = WorkerScriptDescriptorSchema.safeParse({
    scriptKey: value.scriptKey,
    scriptName: value.scriptName,
    label: value.label,
    command: value.command,
    lifecycle: value.lifecycle,
    target: value.target,
    ...(value.repoId !== undefined ? { repoId: value.repoId } : {}),
    ...(value.repoName !== undefined ? { repoName: value.repoName } : {}),
    ...(value.devServerPattern !== undefined
      ? { devServerPattern: value.devServerPattern }
      : {}),
    ...(CoreScriptCommandShellSchema.safeParse(value.shell).success
      ? { shell: value.shell }
      : {}),
    ...(value.interactive === true ? { interactive: true } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parsePersistedScriptRunFile(
  value: unknown,
): PersistedScriptRunFile | null {
  if (!isRecord(value)) return null;
  const script = parseScriptDescriptor(value.script);
  if (
    value.version !== 1 ||
    typeof value.runId !== 'string' ||
    script === null ||
    !isScriptInvocation(value.invocation) ||
    !(
      value.status === 'running' ||
      value.status === 'success' ||
      value.status === 'failed' ||
      value.status === 'cancelled'
    ) ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    (value.completedAt !== undefined &&
      typeof value.completedAt !== 'string') ||
    !(value.exitCode === null || typeof value.exitCode === 'number') ||
    typeof value.timedOut !== 'boolean' ||
    typeof value.durationMs !== 'number' ||
    (value.instanceId !== undefined && typeof value.instanceId !== 'string') ||
    (value.outcome !== undefined && value.outcome !== 'lost')
  )
    return null;
  const writer = parseScriptRunWriter(value.writer);
  const child = parseScriptRunChild(value.child);
  return {
    version: 1,
    runId: value.runId,
    script,
    invocation: value.invocation,
    status: value.status,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(typeof value.completedAt === 'string'
      ? { completedAt: value.completedAt }
      : {}),
    exitCode: value.exitCode,
    timedOut: value.timedOut,
    durationMs: value.durationMs,
    ...(typeof value.instanceId === 'string'
      ? { instanceId: value.instanceId }
      : {}),
    ...(writer ? { writer } : {}),
    ...(value.outcome === 'lost' ? { outcome: value.outcome } : {}),
    ...(child ? { child } : {}),
    ...(value.orphaned === true && child ? { orphaned: true as const } : {}),
  };
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function describeFileError(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function completionStatus(
  completion: ScriptRunCompletion,
): PersistedScriptRunFile['status'] {
  if (completion.success) return 'success';
  return completion.exitCode === null && !completion.timedOut
    ? 'cancelled'
    : 'failed';
}

/** A run log's metadata as an execution record. */
export function toWorkerScriptExecution(
  meta: PersistedScriptRunFile,
): WorkerScriptExecution {
  return {
    executionId: meta.runId,
    script: meta.script,
    invocation: meta.invocation,
    status:
      meta.outcome === 'lost'
        ? 'lost'
        : meta.orphaned
          ? 'orphaned'
          : meta.status,
    ...(meta.orphaned && meta.child && meta.outcome !== 'lost'
      ? { pid: meta.child.pid }
      : {}),
    ...(meta.outcome === 'lost' && meta.child === undefined
      ? { lostFrom: 'unrecorded' as const }
      : {}),
    ...(meta.orphaned && meta.child && meta.outcome !== 'lost'
      ? {
          orphanIdentity: isScriptRunChildIdentified(meta.child)
            ? ('recorded' as const)
            : ('unverifiable' as const),
        }
      : {}),
    startedAt: meta.startedAt,
    completedAt: meta.completedAt ?? null,
    exitCode: meta.exitCode,
    timedOut: meta.timedOut,
    durationMs: Math.max(0, Math.round(meta.durationMs)),
  };
}

/**
 * The durable script run log (worker-owned, CAN-4143): each script key in a
 * worktree keeps its latest run as `{stem}.json` metadata and a `{stem}.log`
 * of at most 2000 lines and 1 MiB. Writes for one key are serialized, a
 * worktree's logs can be deleted while runs append, and a run that a restart
 * interrupted reads as lost instead of running forever.
 */
export class ScriptRunLogStore {
  private instance: string | undefined;
  private selfWriter: Promise<ScriptRunWriter | null> | undefined;
  private readonly runLogs;
  private readonly clock: () => number;

  /**
   * Runs this instance started; any other running run was interrupted.
   * Minted on first use, so constructing a store has no effect.
   */
  get instanceId(): string {
    this.instance ??= randomUUID();
    return this.instance;
  }

  constructor(private readonly options: ScriptRunLogStoreOptions) {
    const lock = options.processLock;
    this.runLogs = createRunLogCoordinator(
      options.files,
      lock
        ? {
            exclusive: <T>(
              projectId: string,
              worktreeId: string,
              work: () => Promise<T>,
            ): Promise<T> =>
              lock.run(options.paths.runDir(projectId, worktreeId), work),
          }
        : {},
    );
    this.clock = options.clock ?? Date.now;
  }

  private paths(
    projectId: string,
    worktreeId: string,
    scriptKey: string,
  ): { dirPath: string; metaPath: string; logPath: string } {
    const dirPath = this.options.paths.runDir(projectId, worktreeId);
    const stem = this.options.paths.fileStem(scriptKey);
    return {
      dirPath,
      metaPath: join(dirPath, `${stem}.json`),
      logPath: join(dirPath, `${stem}.log`),
    };
  }

  private async readMeta(
    metaPath: string,
  ): Promise<PersistedScriptRunFile | null> {
    try {
      const raw = await readFile(metaPath, 'utf8');
      return parsePersistedScriptRunFile(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Keep metadata this version cannot read, with its log, as
   * `{stem}.json.unreadable-<ms>` / `{stem}.log.unreadable-<ms>` instead of
   * overwriting it. Only the newest pair is kept per script.
   */
  private async setAsideUnreadable(paths: {
    dirPath: string;
    metaPath: string;
    logPath: string;
  }): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(paths.metaPath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && parsePersistedScriptRunFile(parsed) !== null)
      return;

    const metaAsidePrefix = `${basename(paths.metaPath)}.unreadable-`;
    const logAsidePrefix = `${basename(paths.logPath)}.unreadable-`;
    const names = await readdir(paths.dirPath);
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(metaAsidePrefix) || name.startsWith(logAsidePrefix),
        )
        .map((name) => rm(join(paths.dirPath, name), { force: true })),
    );

    const suffix = `.unreadable-${this.clock()}`;
    await rename(paths.metaPath, `${paths.metaPath}${suffix}`);
    try {
      await rename(paths.logPath, `${paths.logPath}${suffix}`);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  /**
   * A running run this instance did not start was interrupted by a restart:
   * record it as lost, on its key's write chain, unless a run took its place.
   * A run whose process was recorded is first reaped (CAN-6482): it is lost
   * once its process is proven gone or ended, and orphaned, still running
   * with nothing killed, while its identity cannot be proven. Each read
   * checks again, so an orphaned run reads lost once its process exits.
   */
  private async reconcile(
    projectId: string,
    worktreeId: string,
    meta: PersistedScriptRunFile,
  ): Promise<PersistedScriptRunFile> {
    if (meta.status !== 'running' || meta.instanceId === this.instanceId)
      return meta;
    if (meta.writer !== undefined && this.options.writerFence !== undefined) {
      const state = await this.options.writerFence
        .inspect(meta.writer)
        .catch((): ScriptRunWriterState => 'unverifiable');
      if (state !== 'gone') return meta;
    }
    const { metaPath } = this.paths(
      projectId,
      worktreeId,
      meta.script.scriptKey,
    );
    const now = new Date(this.clock()).toISOString();
    // A lost run is no longer orphaned, whatever it was before.
    const interrupted: PersistedScriptRunFile = { ...meta };
    delete interrupted.orphaned;
    let next: PersistedScriptRunFile = {
      ...interrupted,
      status: 'failed',
      outcome: 'lost',
      updatedAt: now,
      completedAt: now,
      exitCode: null,
    };
    if (meta.child !== undefined) {
      const { writerFence } = this.options;
      const reaped = writerFence?.reapChild
        ? await writerFence
            .reapChild(meta.child)
            .catch((): ScriptRunChildReap => 'unproven')
        : 'unproven';
      if (reaped === 'unproven') {
        if (meta.orphaned) return meta;
        next = { ...meta, orphaned: true, updatedAt: now };
      }
    }
    const lost = next;
    if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) return lost;
    return this.runLogs.withWriteChain(
      this.runLogs.getWriteKey(projectId, worktreeId, meta.script.scriptKey),
      async (): Promise<PersistedScriptRunFile> => {
        const current = await this.readMeta(metaPath);
        if (
          !current ||
          current.runId !== meta.runId ||
          current.status !== 'running'
        )
          return current ?? lost;
        await writeRunLogMeta(this.options.files, metaPath, lost).catch(
          (error: unknown) => {
            this.options.warn?.(
              '[script-run-log] Failed to record an interrupted script run',
              { error: describeFileError(error) },
            );
          },
        );
        return lost;
      },
    );
  }

  async start(args: {
    projectId: string;
    worktreeId: string;
    script: WorkerScriptDescriptor;
    invocation: ScriptRunInvocation;
    runId?: string;
  }): Promise<ScriptRunLogRef> {
    const runId = args.runId ?? randomUUID();
    this.selfWriter ??=
      this.options.writerFence?.self().catch(() => null) ??
      Promise.resolve(null);
    const writer = await this.selfWriter;
    const { dirPath, metaPath, logPath } = this.paths(
      args.projectId,
      args.worktreeId,
      args.script.scriptKey,
    );
    const now = new Date(this.clock()).toISOString();
    const payload: PersistedScriptRunFile = {
      version: 1,
      runId,
      script: args.script,
      invocation: args.invocation,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      instanceId: this.instanceId,
      ...(writer ? { writer } : {}),
    };

    await startRunLogFiles({
      coordinator: this.runLogs,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      runKey: args.script.scriptKey,
      runId,
      paths: { dirPath, metaPath, logPath },
      meta: payload,
      beforeStart: async () => {
        await this.setAsideUnreadable({ dirPath, metaPath, logPath }).catch(
          (error: unknown) => {
            this.options.warn?.(
              '[script-log-store] Failed to set aside unreadable script run metadata',
              { error: error instanceof Error ? error.message : String(error) },
            );
          },
        );
      },
    });

    return {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      script: args.script,
      runId,
    };
  }

  /**
   * Records the run's own process (CAN-6482), with what the writer fence
   * reads for it, so a later restart can prove it before a reap. A process
   * the fence cannot fully identify is recorded by PID alone, so a restart
   * reports it orphaned rather than lost while it runs. A later call
   * refreshes the record, as when a shell execs its command, only for the
   * same process: the same PID and the same start identity. A refresh needs
   * a record with a start identity, since nothing else proves a later process
   * with that PID is the one the run started.
   */
  async recordChild(args: {
    ref: ScriptRunLogRef;
    pid: number;
    refresh?: boolean;
  }): Promise<void> {
    const child = await this.options.writerFence
      ?.identifyChild?.(args.pid)
      .catch(() => null);
    if (!child) return;
    const { projectId, worktreeId, script, runId } = args.ref;
    if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) return;
    const { metaPath } = this.paths(projectId, worktreeId, script.scriptKey);
    await this.runLogs.withWriteChain(
      this.runLogs.getWriteKey(projectId, worktreeId, script.scriptKey),
      async (): Promise<void> => {
        const current = await this.readMeta(metaPath);
        if (!current || current.runId !== runId || current.status !== 'running')
          return;
        const recorded = current.child;
        if (args.refresh === true && !recorded) return;
        if (
          recorded &&
          (recorded.pid !== child.pid ||
            recorded.startIdentity === undefined ||
            recorded.startIdentity !== child.startIdentity)
        )
          return;
        await writeRunLogMeta(this.options.files, metaPath, {
          ...current,
          child,
        }).catch((error: unknown) => {
          this.options.warn?.(
            '[script-run-log] Failed to record a script process',
            { error: describeFileError(error) },
          );
        });
      },
    );
  }

  async append(args: { ref: ScriptRunLogRef; lines: string[] }): Promise<void> {
    const { metaPath, logPath } = this.paths(
      args.ref.projectId,
      args.ref.worktreeId,
      args.ref.script.scriptKey,
    );
    await appendRunLogLines({
      coordinator: this.runLogs,
      projectId: args.ref.projectId,
      worktreeId: args.ref.worktreeId,
      runKey: args.ref.script.scriptKey,
      runId: args.ref.runId,
      logPath,
      lines: args.lines,
      isCurrentRun: async () => {
        const meta = await this.readMeta(metaPath);
        return Boolean(meta && meta.runId === args.ref.runId);
      },
    });
  }

  async complete(args: {
    ref: ScriptRunLogRef;
    response: ScriptRunCompletion;
  }): Promise<void> {
    const { metaPath, logPath } = this.paths(
      args.ref.projectId,
      args.ref.worktreeId,
      args.ref.script.scriptKey,
    );
    await completeRunLogFiles({
      coordinator: this.runLogs,
      projectId: args.ref.projectId,
      worktreeId: args.ref.worktreeId,
      runKey: args.ref.script.scriptKey,
      runId: args.ref.runId,
      paths: { metaPath, logPath },
      readMeta: () => this.readMeta(metaPath),
      buildNextMeta: (meta, now): PersistedScriptRunFile => ({
        ...meta,
        status: completionStatus(args.response),
        updatedAt: now,
        completedAt: now,
        exitCode: args.response.exitCode,
        timedOut: args.response.timedOut,
        durationMs: args.response.durationMs,
      }),
    });
  }

  async readTail(args: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    maxLines: number;
  }): Promise<{ meta: PersistedScriptRunFile | null; lines: string[] }> {
    await this.runLogs.awaitPendingWrite(
      args.projectId,
      args.worktreeId,
      args.scriptKey,
    );
    const { metaPath, logPath } = this.paths(
      args.projectId,
      args.worktreeId,
      args.scriptKey,
    );
    const meta = await this.readMeta(metaPath);
    if (!meta) {
      return { meta: null, lines: [] };
    }
    return {
      meta: await this.reconcile(args.projectId, args.worktreeId, meta),
      lines: await readRunLogTailLines(logPath, args.maxLines),
    };
  }

  async listTails(args: {
    projectId: string;
    worktreeId: string;
    maxLines: number;
  }): Promise<Array<{ meta: PersistedScriptRunFile; lines: string[] }>> {
    const dirPath = this.options.paths.runDir(args.projectId, args.worktreeId);
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(
      () => [],
    );

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const metaPath = join(dirPath, entry.name);
          const listed = await this.readMeta(metaPath);
          if (!listed) {
            return null;
          }

          await this.runLogs.awaitPendingWrite(
            args.projectId,
            args.worktreeId,
            listed.script.scriptKey,
          );
          // The pending write may have completed the run (CAN-6057): read
          // it again rather than report the run as it was before.
          const meta = await this.readMeta(metaPath);
          if (!meta) {
            return null;
          }

          const logPath = join(
            dirPath,
            `${entry.name.slice(0, -'.json'.length)}.log`,
          );
          return {
            meta: await this.reconcile(args.projectId, args.worktreeId, meta),
            lines: await readRunLogTailLines(logPath, args.maxLines),
          };
        }),
    );

    return runs.flatMap((run) => (run ? [run] : []));
  }

  /**
   * Removes one finished run's metadata and log (CAN-6482 part 2), decided
   * under the key's write chain from the record as written: `absent` when the
   * key's latest run is not `runId`, `active` when it is recorded running
   * (orphaned included). It never reconciles the run, so it never reaps or
   * otherwise touches a process.
   */
  async clear(args: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    runId: string;
  }): Promise<'cleared' | 'absent' | 'active'> {
    const { projectId, worktreeId, scriptKey, runId } = args;
    if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId))
      return 'absent';
    const { metaPath, logPath } = this.paths(projectId, worktreeId, scriptKey);
    return this.runLogs.withWriteChain(
      this.runLogs.getWriteKey(projectId, worktreeId, scriptKey),
      async (): Promise<'cleared' | 'absent' | 'active'> => {
        const current = await this.readMeta(metaPath);
        if (!current || current.runId !== runId) return 'absent';
        if (current.status === 'running') return 'active';
        await rm(logPath, { force: true });
        await rm(metaPath, { force: true });
        return 'cleared';
      },
    );
  }

  /**
   * Stops an orphaned run's recorded process on a user's request (CAN-6482
   * part 2), admitted from the record as written, never reconciling it
   * first; once its process is stopped or gone, it records the run as lost
   * itself. `absent` when the key's latest run is not `runId`, `not_orphaned`
   * when it is not orphaned now, `unconfirmed` when the record cannot be
   * verified (PID only) or the stop is forced without the user's confirmation,
   * `unsupported` when this host cannot stop it.
   */
  async stopOrphan(args: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    runId: string;
    mode: ScriptRunChildStopMode;
    confirmed: boolean;
  }): Promise<
    | ScriptRunChildStop
    | 'absent'
    | 'not_orphaned'
    | 'unconfirmed'
    | 'unsupported'
  > {
    const { projectId, worktreeId, scriptKey, runId } = args;
    const found = await this.orphanedChild(
      projectId,
      worktreeId,
      scriptKey,
      runId,
    );
    if (typeof found === 'string') return found;
    const { child } = found;
    const identified = isScriptRunChildIdentified(child);
    if ((args.mode === 'force' || !identified) && !args.confirmed)
      return 'unconfirmed';
    const fence = this.options.writerFence;
    if (!fence?.stopChild) return 'unsupported';
    const outcome = await fence.stopChild(
      child,
      identified ? 'stop' : args.mode,
    );
    // A record that no longer matches named a process that has ended: the
    // run is lost, and nothing was signalled (coordinator, 12 Nov 2026).
    if (outcome === 'stopped' || outcome === 'gone' || outcome === 'not_same')
      await this.recordStopped(projectId, worktreeId, scriptKey, runId);
    return outcome;
  }

  /**
   * The orphaned run's record as written, never reconciled first: reading it
   * never reaps. `absent` when the key's latest run is not `runId`.
   */
  private async orphanedChild(
    projectId: string,
    worktreeId: string,
    scriptKey: string,
    runId: string,
  ): Promise<
    { child: ScriptRunChild; startedAtMs: number } | 'absent' | 'not_orphaned'
  > {
    await this.runLogs.awaitPendingWrite(projectId, worktreeId, scriptKey);
    const meta = await this.readMeta(
      this.paths(projectId, worktreeId, scriptKey).metaPath,
    );
    if (!meta || meta.runId !== runId) return 'absent';
    const child = meta.child;
    if (
      meta.status !== 'running' ||
      meta.orphaned !== true ||
      child === undefined
    )
      return 'not_orphaned';
    return { child, startedAtMs: Date.parse(meta.startedAt) };
  }

  /**
   * The live members of an orphaned run's process group once its recorded
   * leader has exited, for the user's confirmation (CAN-6601).
   */
  async groupMembers(args: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    runId: string;
  }): Promise<ScriptRunGroupListing | 'absent' | 'not_orphaned'> {
    const found = await this.orphanedChild(
      args.projectId,
      args.worktreeId,
      args.scriptKey,
      args.runId,
    );
    if (typeof found === 'string') return found;
    const fence = this.options.writerFence;
    if (!fence?.listGroup) return { kind: 'unsupported' };
    if (!Number.isFinite(found.startedAtMs)) return { kind: 'unverifiable' };
    return fence.listGroup(found.child, found.startedAtMs, args.runId);
  }

  /**
   * A user's confirmed group Force stop of an orphaned run (CAN-6601): the
   * members are exactly those the user confirmed. The run is recorded lost
   * only once its whole group is empty.
   */
  async stopOrphanGroup(args: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
    runId: string;
    confirmed: boolean;
    members: readonly {
      readonly pid: number;
      readonly startIdentity: string;
    }[];
  }): Promise<ScriptRunGroupStop | 'absent' | 'not_orphaned' | 'unconfirmed'> {
    const { projectId, worktreeId, scriptKey, runId } = args;
    if (!args.confirmed || args.members.length === 0) return 'unconfirmed';
    const found = await this.orphanedChild(
      projectId,
      worktreeId,
      scriptKey,
      runId,
    );
    if (typeof found === 'string') return found;
    const fence = this.options.writerFence;
    if (!fence?.stopGroup) return { kind: 'unsupported' };
    if (!Number.isFinite(found.startedAtMs)) return { kind: 'unverifiable' };
    const outcome = await fence.stopGroup(
      found.child,
      found.startedAtMs,
      runId,
      args.members,
    );
    if (outcome.kind === 'done' && outcome.outcome === 'stopped')
      await this.recordStopped(projectId, worktreeId, scriptKey, runId);
    return outcome;
  }

  /**
   * Records the Stop's own result: the run is lost, written under the key's
   * write chain while the record is still this orphaned run. A later read
   * cannot prove it once the PID is reused, so it is never left to one.
   */
  private async recordStopped(
    projectId: string,
    worktreeId: string,
    scriptKey: string,
    runId: string,
  ): Promise<void> {
    if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) return;
    const { metaPath } = this.paths(projectId, worktreeId, scriptKey);
    await this.runLogs.withWriteChain(
      this.runLogs.getWriteKey(projectId, worktreeId, scriptKey),
      async (): Promise<void> => {
        const current = await this.readMeta(metaPath);
        if (
          !current ||
          current.runId !== runId ||
          current.status !== 'running' ||
          current.orphaned !== true
        )
          return;
        const now = new Date(this.clock()).toISOString();
        const lost: PersistedScriptRunFile = {
          ...current,
          status: 'failed',
          outcome: 'lost',
          updatedAt: now,
          completedAt: now,
          exitCode: null,
        };
        delete lost.orphaned;
        // The process is already stopped: a failed write keeps the run
        // orphaned, for a later Stop or read, and is not the Stop's failure.
        await writeRunLogMeta(this.options.files, metaPath, lost).catch(
          (error: unknown) => {
            this.options.warn?.(
              '[script-run-log] Failed to record a stopped script run',
              { error: describeFileError(error) },
            );
          },
        );
      },
    );
  }

  async deleteWorktree(projectId: string, worktreeId: string): Promise<void> {
    await this.runLogs.deleteWorktreeLogs(projectId, worktreeId, async () => {
      await rm(this.options.paths.runDir(projectId, worktreeId), {
        recursive: true,
        force: true,
      });
    });
  }

  /**
   * Copy one script run's canonical log to `targetPath` without letting a
   * later run substitute its output.
   *
   * - Runs on the script key's write chain, so pending appends and
   *   completion for this run land first, and no new run can replace the log
   *   mid-copy.
   * - `superseded` when the canonical metadata now names a different run;
   *   `missing` when no metadata or log exists (or the worktree's logs are
   *   being deleted). A running script yields a partial copy.
   * - The copy is written to a sibling temp file and renamed into place. An
   *   existing `targetPath` is never overwritten: finalized copies are
   *   immutable, so the call returns `error` and leaves the file untouched.
   *   Callers use a fresh target per attempt; the existence check and rename
   *   are not atomic against a concurrent writer of the same target.
   * - Any filesystem failure, including a source the writer holds open on
   *   Windows (`EBUSY`/`EPERM`), resolves as `error` with the error code; it
   *   never throws. Messages carry error codes only, never paths or log
   *   text.
   */
  async snapshot(args: {
    ref: ScriptRunLogRef;
    targetPath: string;
  }): Promise<ScriptRunLogSnapshotResult> {
    const { projectId, worktreeId, script, runId } = args.ref;
    const { metaPath, logPath } = this.paths(
      projectId,
      worktreeId,
      script.scriptKey,
    );
    const tempPath = join(
      dirname(args.targetPath),
      `.${basename(args.targetPath)}.${randomUUID()}.tmp`,
    );
    try {
      if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) {
        return { status: 'missing' };
      }
      return await this.runLogs.withWriteChain(
        this.runLogs.getWriteKey(projectId, worktreeId, script.scriptKey),
        async (): Promise<ScriptRunLogSnapshotResult> => {
          if (this.runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) {
            return { status: 'missing' };
          }
          const meta = await this.readMeta(metaPath);
          if (!meta) {
            return { status: 'missing' };
          }
          if (meta.runId !== runId) {
            return { status: 'superseded' };
          }
          if (!(await pathExists(logPath))) {
            return { status: 'missing' };
          }
          if (await pathExists(args.targetPath)) {
            return {
              status: 'error',
              message: 'script log copy target already exists',
            };
          }
          await mkdir(dirname(args.targetPath), { recursive: true });
          await copyFile(logPath, tempPath);
          await rename(tempPath, args.targetPath);
          return { status: 'copied' };
        },
      );
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return {
        status: 'error',
        message: `script log copy failed: ${describeFileError(error)}`,
      };
    }
  }

  /**
   * Read a script key's canonical run metadata after its pending writes
   * settle. Callers compare `runId` with their recorded run and read
   * `status` (`running` until completion) and `exitCode`.
   */
  async readMetaFor(ref: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
  }): Promise<PersistedScriptRunFile | null> {
    await this.runLogs.awaitPendingWrite(
      ref.projectId,
      ref.worktreeId,
      ref.scriptKey,
    );
    const { metaPath } = this.paths(
      ref.projectId,
      ref.worktreeId,
      ref.scriptKey,
    );
    const meta = await this.readMeta(metaPath);
    return meta === null
      ? null
      : this.reconcile(ref.projectId, ref.worktreeId, meta);
  }
}
