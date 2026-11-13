/**
 * Desktop main's `create-worktree` host step: creates the worktree through the
 * canonical keyed creation boundary, runs desktop setup, assigns a named
 * group, and keeps every output on failure, timeout and replay.
 *
 * Order: project resolution, owner check, project-type refusals, attempt
 * journal, base-task check, then the effects. Authorization precedes every
 * effect and every read of stored results.
 *
 * Finalization gate: normal completion and the executor's timeout finalizer
 * share one `finalizeOnce`; the first wins and the other gets its result. A
 * withdrawal (cancellation, or the timeout before its finalizer runs) closes
 * admission: no setup launch or grouping after it, and nothing under the
 * artifacts directory is written again unless the timeout finalizer
 * finalizes. Setup deliberately outlives the wait and only writes the
 * worktree's own script logs.
 *
 * Branch and group names are user text: never logged, and errors name only
 * IDs.
 */
import { access, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  PipelineHostRefusal,
  type PipelineHostFailureReason,
} from '@canopy/execution-engine/pipelines/host-actions';
import {
  createWorktreeIdentifierOutputs,
  emptyCreateWorktreeOutputs,
  type CreateWorktreeInputs,
  type WorktreeSetupState,
} from '@canopy/execution-engine/pipelines/host-create-worktree';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { writeFileAtomically } from '../lib/atomic-file';
import { getWorkspaceWorktreeDir, getWorktreeDir } from '../lib/paths';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import { IdentifierValidationError } from '../lib/validation';
import { WorktreeCreationRefusedError } from '../lib/worktree-creation-selection';
import type {
  WorktreeBaseSelection,
  WorktreeBranchSelection,
} from '../lib/worktree-creation-selection';
import {
  createWorktreeFromSelection,
  type WorktreeCreationOutcome,
} from '../lib/worktree-creation';
import type {
  ProjectWorktreePostCreateSetup,
  WorkspaceWorktreePostCreateSetup,
} from '../lib/worktree-service';
import { runProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { runWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { readScriptRun } from '../lib/script-execution';
import {
  snapshotScriptRunLog,
  type ScriptRunLogRef,
} from '../lib/script-log-store';
import type {
  WorktreeSetupObserver,
  WorktreeSetupRunResult,
  WorktreeSetupScriptRef,
  WorktreeSetupScriptResult,
} from '../lib/worktree-setup-result';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';
import {
  createWorktreeRequestFingerprint,
  newAttemptRecord,
  readAttemptRecord,
  writeAttemptRecord,
  type AttemptRecord,
  type AttemptScript,
} from './host-create-worktree-state';
import {
  hostProjectHasWorktree,
  hostProjectWorktreeCreatedAt,
  resolveHostProject,
  taskNotInProject,
  type PipelineHostOwnerCheck,
  type ResolvedHostProject,
} from './host-task-resolution';

export interface CreateWorktreeHostDeps {
  assertTargetOwner: PipelineHostOwnerCheck;
  getWindow: () => BrowserWindow | null;
}

export const SETUP_RESULTS_FILE = 'setup-results.json';
const SINGLE_REPO_LOG_FILE = 'setup.log';

type WorktreeKind = 'single-repo' | 'multi-repo';

type SetupLaunch =
  | { kind: 'project'; params: Parameters<ProjectWorktreePostCreateSetup>[0] }
  | {
      kind: 'workspace';
      params: Parameters<WorkspaceWorktreePostCreateSetup>[0];
    };

interface CapturedLaunch {
  launch: SetupLaunch;
  /** Settles the promise the service holds: resolve once launched, reject when not admitted. */
  settle(launched: boolean): void;
}

interface CreatedWorktree {
  taskId: string;
  branchName: string;
  createdAt: string;
  path: string;
  workspaceKind: WorktreeKind;
}

interface ScriptEntry {
  ref: WorktreeSetupScriptRef;
  seq: number;
  result?: WorktreeSetupScriptResult;
  /** Artifact file name once a copy was saved. */
  logFile?: string;
  copying?: Promise<void>;
}

const LIFECYCLE_RANK = { 'before-setup': 0, setup: 1, 'after-setup': 2 };

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function projectOutputs(projectId: string): Record<string, string> {
  return {
    ...emptyCreateWorktreeOutputs(),
    project_id: projectId,
    workspace_id: projectId,
  };
}

function failure(
  failureReason: PipelineHostFailureReason,
  error: string,
  outputs: Record<string, string>,
): PipelineHostActionResult {
  return { status: 'failure', failureReason, error, outputs };
}

function setupInterrupted(taskId: string): string {
  return `Setup for task \`${taskId}\` was interrupted; check its setup log`;
}

function toBranchSelection(
  branch: CreateWorktreeInputs['branch'],
): WorktreeBranchSelection {
  switch (branch.kind) {
    case 'default':
      return { kind: 'default' };
    case 'new':
      return { kind: 'new', branchName: branch.name };
    case 'existing':
      return { kind: 'existing', branchName: branch.name };
  }
}

function toBaseSelection(inputs: CreateWorktreeInputs): WorktreeBaseSelection {
  if (inputs.baseTaskId !== undefined) {
    return { kind: 'worktree', baseWorktreeId: inputs.baseTaskId };
  }
  if (inputs.baseBranch !== undefined) {
    return { kind: 'branch', baseBranch: inputs.baseBranch };
  }
  return { kind: 'repository-default' };
}

function safeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);
}

function scriptStateOf(
  entry: ScriptEntry,
): 'running' | WorktreeSetupScriptResult['status'] {
  return entry.result?.status ?? 'running';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, text, { encoding: 'utf8' });
}

type GateState = 'open' | 'withdrawn' | 'finalized';

/**
 * One live `create-worktree` attempt, shared by concurrent calls with the
 * same idempotency key. It withdraws only when every caller has withdrawn.
 */
class CreateWorktreeOperation {
  readonly fingerprint: string;
  readonly result: Promise<PipelineHostActionResult>;
  private gate: GateState = 'open';
  private finalizing: Promise<PipelineHostActionResult> | undefined;
  /** True only while the winning finalization writes its artifacts. */
  private finalizationActive = false;
  private attached = 0;
  private readonly withdrawListeners = new Set<() => void>();
  private record: AttemptRecord | undefined;
  private project: ResolvedHostProject | undefined;
  private worktree: CreatedWorktree | undefined;
  private captured: CapturedLaunch | undefined;
  private replayed = false;
  /** A stored journal was still at `creating`: setup and grouping never ran. */
  private recordedCreating = false;
  private setupAdmitted = false;
  private setupConfigured: boolean | undefined;
  private readonly scripts = new Map<string, ScriptEntry>();
  private scriptSeq = 0;
  private repoOrder: readonly string[] = [];
  private groupOutputs: Record<string, string> | undefined;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly inputs: CreateWorktreeInputs,
    private readonly caller: PipelineHostActionCaller,
    private readonly deps: CreateWorktreeHostDeps,
    private readonly artifactsDir: string,
  ) {
    this.fingerprint = createWorktreeRequestFingerprint(inputs);
    this.result = this.run();
    // Callers that withdrew no longer await it.
    this.result.catch(() => undefined);
  }

  attach(): void {
    this.attached += 1;
  }

  /** A caller stopped waiting; the last one to withdraw closes admission. */
  detach(withdrawn: boolean): void {
    this.attached -= 1;
    if (withdrawn && this.attached === 0 && this.gate === 'open') {
      this.gate = 'withdrawn';
      for (const listener of Array.from(this.withdrawListeners)) listener();
    }
  }

  /** Every caller withdrew: a new call acts again instead of sharing it. */
  get withdrawn(): boolean {
    return this.gate === 'withdrawn';
  }

  /** The executor's timeout finalizer: snapshot what is known and return every output. */
  finalizeOnDeadline(): Promise<PipelineHostActionResult> {
    return this.finalizeOnce(() => this.deadlineResult());
  }

  private get admitted(): boolean {
    return this.gate === 'open';
  }

  private assertAdmitted(): void {
    if (!this.admitted) throw abortError();
  }

  /** Waits for `work` unless the gate closes first. */
  private untilWithdrawn<T>(work: Promise<T>): Promise<T> {
    if (!this.admitted) {
      work.catch(() => undefined);
      return Promise.reject(abortError());
    }
    let onWithdraw: (() => void) | undefined;
    const withdrawn = new Promise<never>((_resolve, reject) => {
      onWithdraw = (): void => reject(abortError());
      this.withdrawListeners.add(onWithdraw);
    });
    return Promise.race([work, withdrawn]).finally(() => {
      if (onWithdraw) this.withdrawListeners.delete(onWithdraw);
      work.catch(() => undefined);
    });
  }

  private track<T>(work: Promise<T>): void {
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  private async settlePending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  /** Journal writes happen only while admission is open (or while finalizing). */
  private async journal(
    update: (record: AttemptRecord) => void,
  ): Promise<void> {
    if (!this.record || this.record.phase === 'finalized') return;
    if (!this.admitted && !this.finalizationActive) return;
    update(this.record);
    await writeAttemptRecord(this.artifactsDir, this.record);
  }

  private finalizeOnce(
    build: () => Promise<PipelineHostActionResult>,
  ): Promise<PipelineHostActionResult> {
    if (this.finalizing) return this.finalizing;
    this.gate = 'finalized';
    for (const listener of Array.from(this.withdrawListeners)) listener();
    this.finalizationActive = true;
    this.finalizing = (async (): Promise<PipelineHostActionResult> => {
      try {
        const result = await build();
        if (this.record) {
          this.record.phase = 'finalized';
          this.record.result = result;
          await writeAttemptRecord(this.artifactsDir, this.record);
        }
        return result;
      } finally {
        // Nothing under the artifacts dir is written after this.
        this.finalizationActive = false;
      }
    })();
    return this.finalizing;
  }

  /** Normal completion: finalizes only while admission is open. */
  private complete(
    build: () => Promise<PipelineHostActionResult>,
  ): Promise<PipelineHostActionResult> {
    if (this.finalizing) return this.finalizing;
    if (!this.admitted) return Promise.reject(abortError());
    return this.finalizeOnce(build);
  }

  /** {@link complete} with a result that is already known. */
  private completeWith(
    result: PipelineHostActionResult,
  ): Promise<PipelineHostActionResult> {
    return this.complete(() => Promise.resolve(result));
  }

  private async run(): Promise<PipelineHostActionResult> {
    try {
      return await this.execute();
    } catch (error) {
      // Another caller's deadline finalized the shared attempt: its result stands.
      if (this.finalizing) return this.finalizing;
      await this.markUncertain(error);
      throw error;
    } finally {
      this.captured?.settle(false);
    }
  }

  /**
   * An unexpected error after `setup_starting` leaves the launch unknowable,
   * so a replay fails closed instead of guessing. Best effort: the original
   * error is what the caller sees.
   */
  private async markUncertain(error: unknown): Promise<void> {
    if (this.record?.phase !== 'setup_starting') return;
    if (error instanceof Error && error.name === 'AbortError') return;
    try {
      await this.journal((record) => {
        record.phase = 'uncertain';
      });
    } catch (journalError) {
      logMainProcessWarn('[pipeline-host] create-worktree journal not saved', {
        errorType: errorType(journalError),
      });
    }
  }

  private async execute(): Promise<PipelineHostActionResult> {
    const { inputs } = this;
    const project = await resolveHostProject(inputs.projectId);
    this.project = project;
    await this.deps.assertTargetOwner(this.caller, {
      kind: 'project',
      projectId: inputs.projectId,
      workspaceType: project.workspaceType,
    });
    if (project.workspaceType === 'cowork') {
      throw new PipelineHostRefusal(
        'unsupported_action',
        `Project \`${inputs.projectId}\` doesn't support worktrees. Use create-project-entry.`,
      );
    }
    const workspaceKind: WorktreeKind = project.workspaceType;

    const stored = await readAttemptRecord(this.artifactsDir);
    if (stored.kind === 'corrupt') {
      return this.completeWith(
        failure(
          'target_not_ready',
          `This step's earlier attempt in project \`${inputs.projectId}\` can't be checked; check the project`,
          projectOutputs(inputs.projectId),
        ),
      );
    }
    if (stored.kind === 'ok') {
      const replay = await this.replayStored(stored.record);
      if (replay) return replay;
    }

    if (inputs.baseTaskId !== undefined) {
      if (!(await hostProjectHasWorktree(project, inputs.baseTaskId))) {
        throw new PipelineHostRefusal(
          'not_found',
          taskNotInProject(inputs.baseTaskId, inputs.projectId),
        );
      }
    }

    // Withdrawn before admission: no effects and no journal.
    this.assertAdmitted();
    this.record ??= newAttemptRecord(inputs, this.caller);
    this.record.phase = 'creating';
    await writeAttemptRecord(this.artifactsDir, this.record);
    // A cancel or the deadline can land during that write; creation takes no
    // signal, so nothing else would stop it.
    this.assertAdmitted();

    const outcome = await this.create(project, workspaceKind);
    if (outcome.kind === 'refused') {
      return this.completeWith(outcome.result);
    }
    return this.afterCreation(outcome.outcome);
  }

  /** Returns the replay's result, or `undefined` when creation should run (W5 decides). */
  private async replayStored(
    record: AttemptRecord,
  ): Promise<PipelineHostActionResult | undefined> {
    const projectId = this.inputs.projectId;
    if (record.fingerprint !== this.fingerprint) {
      return failure(
        'authorization_conflict',
        'This step already ran with different inputs',
        projectOutputs(projectId),
      );
    }
    if (record.phase === 'finalized' && record.result) {
      // Stored terminal results are returned unchanged; nothing is written.
      this.gate = 'finalized';
      this.finalizing = Promise.resolve(record.result);
      return record.result;
    }
    this.record = record;
    if (record.phase === 'creating') {
      this.recordedCreating = true;
      return undefined;
    }
    const worktree = record.worktree;
    if (
      record.phase === 'uncertain' ||
      record.phase === 'finalized' ||
      !worktree
    ) {
      return this.completeWith(
        failure(
          'target_not_ready',
          `This step's earlier attempt in project \`${projectId}\` can't be checked; check the project`,
          worktree ? this.identityOutputs(worktree) : projectOutputs(projectId),
        ),
      );
    }
    this.worktree = worktree;
    this.groupOutputs = record.group;
    const replaced = await this.replacedResult(worktree);
    if (replaced) return this.completeWith(replaced);
    if (record.phase === 'created') {
      // The only resumable phase: setup was never admitted.
      const launch =
        this.inputs.setup === 'skip'
          ? undefined
          : await this.rebuildLaunch(worktree);
      return this.continueAfterCreation(launch);
    }
    return this.reconcileRecordedSetup(record, worktree);
  }

  private async create(
    project: ResolvedHostProject,
    workspaceKind: WorktreeKind,
  ): Promise<
    | { kind: 'created'; outcome: WorktreeCreationOutcome }
    | { kind: 'refused'; result: PipelineHostActionResult }
  > {
    const { inputs } = this;
    const capture = (launch: SetupLaunch): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        this.captured = {
          launch,
          settle: (launched): void => {
            this.captured = undefined;
            // A rejection releases the service's post-setup refresh deferral.
            if (launched) resolve();
            else reject(new Error('Setup was not started for this step'));
          },
        };
      });
    try {
      const outcome = await createWorktreeFromSelection({
        workspaceId: project.workspaceId,
        workspaceKind,
        branch: toBranchSelection(inputs.branch),
        base: toBaseSelection(inputs),
        idempotencyKey: this.caller.idempotencyKey,
        callerSource: 'pipeline-host',
        onKeyedReplay: () => {
          this.replayed = true;
        },
        deferGitSetup: false,
        surfaceNeedsRepairInResponse: true,
        repairWorkspaceRoot: inputs.repair,
        ...(inputs.restoreClaudeMd !== undefined
          ? { restoreClaudeMd: inputs.restoreClaudeMd }
          : {}),
        startPostCreateSetup: inputs.setup !== 'skip',
        startProjectPostCreateSetup: (params) =>
          capture({ kind: 'project', params }),
        startWorkspacePostCreateSetup: (params) =>
          capture({ kind: 'workspace', params }),
        getWindow: this.deps.getWindow,
        ...(inputs.branch.kind === 'default'
          ? { defaultBranchNaming: 'worktree-id' as const }
          : {}),
      });
      return { kind: 'created', outcome };
    } catch (error) {
      const refused = this.mapCreationError(error);
      if (refused) return { kind: 'refused', result: refused };
      throw error;
    }
  }

  private mapCreationError(
    error: unknown,
  ): PipelineHostActionResult | undefined {
    const outputs = projectOutputs(this.inputs.projectId);
    if (
      error instanceof WorktreeCreationRefusedError ||
      error instanceof IdentifierValidationError
    ) {
      return failure('validation_failed', error.message, outputs);
    }
    if (error instanceof W5CommitRefusedError) {
      switch (error.reason) {
        case 'key-reused':
          return failure(
            'authorization_conflict',
            'This step already ran with different inputs',
            outputs,
          );
        case 'in-progress':
        case 'outcome-expired':
        case 'recovery-required':
          return failure(
            'target_not_ready',
            `Task creation in project \`${this.inputs.projectId}\` can't continue right now; check the project and try again`,
            outputs,
          );
        default:
          return undefined;
      }
    }
    return undefined;
  }

  private identityOutputs(worktree: {
    taskId: string;
    branchName: string;
    createdAt?: string;
    path?: string;
  }): Record<string, string> {
    return {
      ...emptyCreateWorktreeOutputs(),
      ...createWorktreeIdentifierOutputs(
        this.inputs.projectId,
        worktree.taskId,
      ),
      branch_name: worktree.branchName,
      path: worktree.path ?? '',
      created_at: worktree.createdAt ?? '',
    };
  }

  private async afterCreation(
    outcome: WorktreeCreationOutcome,
  ): Promise<PipelineHostActionResult> {
    const projectId = this.inputs.projectId;
    if (outcome.status === 'needs-repair') {
      this.captured?.settle(false);
      return this.completeWith(
        failure(
          'target_not_ready',
          `Project \`${projectId}\` needs its workspace root repaired; run again with repair: true or repair it in the app`,
          this.identityOutputs({
            taskId: outcome.worktreeId,
            branchName: outcome.branchName,
          }),
        ),
      );
    }
    const workspaceId = this.project?.workspaceId ?? projectId;
    const worktree: CreatedWorktree = {
      taskId: outcome.record.worktreeId,
      branchName: outcome.record.branchName,
      createdAt: outcome.record.createdAt,
      path:
        outcome.workspaceKind === 'multi-repo'
          ? getWorkspaceWorktreeDir(workspaceId, outcome.record.worktreeId)
          : getWorktreeDir(workspaceId, outcome.record.worktreeId),
      workspaceKind: outcome.workspaceKind,
    };
    this.worktree = worktree;
    // The row exists whether or not this step still waits for it. Runs
    // started outside a desktop window (Portal, agents) have none to notify,
    // and main's own write doesn't wake the file watcher, so broadcast.
    const update = { workspaceId };
    if (
      !sendToWindow(
        this.deps.getWindow(),
        IPC_CHANNELS.workspaceWorktreesUpdated,
        update,
      )
    ) {
      sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, update);
    }
    const captured = this.captured;
    if (!this.admitted) {
      captured?.settle(false);
      throw abortError();
    }

    if (this.replayed && !this.recordedCreating) {
      // A saved creation with no journal: setup and grouping can't be
      // verified, so neither runs again. The resumable `created` phase is
      // never written; the record goes straight to `finalized`.
      captured?.settle(false);
      if (this.record) this.record.worktree = worktree;
      return this.completeWith(this.unverifiedReplayResult(worktree));
    }
    if (this.replayed) {
      const replaced = await this.replacedResult(worktree);
      if (replaced) {
        captured?.settle(false);
        if (this.record) this.record.worktree = worktree;
        return this.completeWith(replaced);
      }
    }
    await this.journal((record) => {
      record.phase = 'created';
      record.worktree = worktree;
    });
    if (this.replayed) {
      // The journal stopped at `creating`, which is written before both setup
      // launch and grouping: resume exactly as from `created`.
      captured?.settle(false);
      const launch =
        this.inputs.setup === 'skip'
          ? undefined
          : await this.rebuildLaunch(worktree);
      return this.continueAfterCreation(launch);
    }
    return this.continueAfterCreation(captured?.launch, captured);
  }

  /**
   * A resumed replay acts on a recorded task ID. If that task was removed and
   * its ID reused since, setup and grouping would land on the replacement, so
   * the listed task must still carry the recorded creation time.
   */
  private async replacedResult(
    worktree: CreatedWorktree,
  ): Promise<PipelineHostActionResult | undefined> {
    const project = this.project;
    if (!project) throw new Error('create-worktree resolved no project');
    const createdAt = await hostProjectWorktreeCreatedAt(
      project,
      worktree.taskId,
    );
    if (createdAt === worktree.createdAt) return undefined;
    return failure(
      'target_not_ready',
      `Task \`${worktree.taskId}\` in project \`${this.inputs.projectId}\` was removed or replaced after this step created it; check the project`,
      this.identityOutputs(worktree),
    );
  }

  private unverifiedReplayResult(
    worktree: CreatedWorktree,
  ): PipelineHostActionResult {
    const outputs = {
      ...this.identityOutputs(worktree),
      ...(this.inputs.group !== undefined
        ? { not_grouped_reason: 'replay_uncertain' }
        : {}),
    };
    if (this.inputs.setup === 'skip') {
      return {
        status: 'success',
        outputs: { ...outputs, setup_state: 'skipped' },
      };
    }
    return failure('setup_failed', setupInterrupted(worktree.taskId), {
      ...outputs,
      setup_state: 'failed',
    });
  }

  private async rebuildLaunch(worktree: CreatedWorktree): Promise<SetupLaunch> {
    const project = this.project;
    if (!project) throw new Error('create-worktree resolved no project');
    const detail = await readWorkspaceConfigDetailed(project.workspaceId);
    if (detail.authority !== 'ok') {
      throw new Error(`Project \`${project.projectId}\` couldn't be read`);
    }
    const { config } = detail;
    if (worktree.workspaceKind === 'single-repo') {
      if (!config.repoPath) {
        throw new Error(`Project \`${project.projectId}\` has no repository`);
      }
      return {
        kind: 'project',
        params: {
          projectId: project.workspaceId,
          worktreeId: worktree.taskId,
          project: { repoPath: config.repoPath, scripts: config.scripts },
          getWindow: this.deps.getWindow,
        },
      };
    }
    return {
      kind: 'workspace',
      params: {
        workspaceId: project.workspaceId,
        worktreeId: worktree.taskId,
        workspaceRootPath: getWorkspaceWorktreeDir(
          project.workspaceId,
          worktree.taskId,
        ),
        repos: config.repos,
        getWindow: this.deps.getWindow,
      },
    };
  }

  private async continueAfterCreation(
    launch: SetupLaunch | undefined,
    captured?: CapturedLaunch,
  ): Promise<PipelineHostActionResult> {
    const worktree = this.worktree;
    if (!worktree) throw new Error('create-worktree has no created worktree');
    const { setup } = this.inputs;

    let running: Promise<WorktreeSetupRunResult> | undefined;
    let resolved: Promise<void> | undefined;
    if (setup !== 'skip' && launch) {
      if (!this.admitted) {
        captured?.settle(false);
        throw abortError();
      }
      await this.journal((record) => {
        record.phase = 'setup_starting';
      });
      if (!this.admitted) {
        captured?.settle(false);
        throw abortError();
      }
      ({ running, resolved } = this.launchSetup(launch));
      captured?.settle(true);
    } else {
      captured?.settle(false);
    }

    // After setup launch so a slow group service can't delay setup, and
    // before waiting so a withdrawn wait still leaves the row grouped.
    await this.assignGroup(worktree);

    if (setup === 'skip') {
      return this.completeWith({
        status: 'success',
        outputs: this.outputs(worktree, 'skipped'),
      });
    }
    if (!running || !resolved) {
      return this.completeWith(
        failure(
          'setup_failed',
          `Setup for task \`${worktree.taskId}\` couldn't start`,
          this.outputs(worktree, 'failed'),
        ),
      );
    }
    const settledRun = running.then(
      (result) => ({ kind: 'settled' as const, result }),
      () => ({ kind: 'rejected' as const }),
    );
    if (setup === 'run') {
      const first = await this.untilWithdrawn(
        Promise.race([
          resolved.then(() => ({ kind: 'resolved' as const })),
          settledRun,
        ]),
      );
      if (first.kind === 'resolved') {
        return this.complete(() => this.startedResult(worktree));
      }
      return this.complete(() => this.completedResult(worktree, first));
    }
    const done = await this.untilWithdrawn(settledRun);
    if (done.kind === 'settled') {
      await this.journal((record) => {
        record.setupSettled = true;
        if (done.result.status === 'failed') record.setupRunFailed = true;
      });
    }
    return this.complete(() => this.completedResult(worktree, done));
  }

  private launchSetup(launch: SetupLaunch): {
    running: Promise<WorktreeSetupRunResult>;
    resolved: Promise<void>;
  } {
    this.setupAdmitted = true;
    let markResolved: () => void = () => undefined;
    const resolved = new Promise<void>((resolve) => {
      markResolved = resolve;
    });
    this.repoOrder =
      launch.kind === 'workspace'
        ? launch.params.repos.map((repo) => repo.id)
        : [];
    const observer: WorktreeSetupObserver = {
      onResolved: (configured) => {
        this.setupConfigured = configured;
        markResolved();
        this.track(
          this.journal((record) => {
            if (record.phase === 'setup_starting') {
              record.phase = 'setup_running';
            }
            record.setupConfigured = configured;
          }),
        );
      },
      onScriptStarted: (ref) => {
        this.scriptSeq += 1;
        this.scripts.set(ref.runId, { ref, seq: this.scriptSeq });
        this.track(this.journalScripts());
      },
      onScriptCompleted: (result) => {
        const entry = this.scripts.get(result.runId) ?? {
          ref: result,
          seq: ++this.scriptSeq,
        };
        entry.result = result;
        this.scripts.set(result.runId, entry);
        // Copy promptly: the canonical log is overwritten by the next run.
        if (this.admitted) this.copyLog(entry);
      },
    };
    // The step's signal is never passed: stopping the wait leaves setup running.
    const running: Promise<WorktreeSetupRunResult> =
      launch.kind === 'project'
        ? runProjectWorktreePostCreateSetup({
            ...launch.params,
            observer,
          }).then((result) => ({
            status: result.status,
            scripts: result.script ? [result.script] : [],
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          }))
        : runWorkspaceWorktreePostCreateSetup({ ...launch.params, observer });
    running.catch((error: unknown) => {
      logMainProcessWarn('[pipeline-host] create-worktree setup failed', {
        errorType: errorType(error),
      });
    });
    return { running, resolved };
  }

  private journalScripts(): Promise<void> {
    return this.journal((record) => {
      record.scripts = this.sortedScripts().map((entry) =>
        this.toAttemptScript(entry),
      );
    });
  }

  private toAttemptScript(entry: ScriptEntry): AttemptScript {
    return {
      scriptKey: entry.ref.scriptKey,
      runId: entry.ref.runId,
      target: entry.ref.target,
      lifecycle: entry.ref.lifecycle,
      ...(entry.ref.repoId !== undefined ? { repoId: entry.ref.repoId } : {}),
      ...(entry.ref.logRef ? { logProjectId: entry.ref.logRef.projectId } : {}),
      ...(entry.logFile !== undefined ? { logFile: entry.logFile } : {}),
    };
  }

  private logFileName(entry: ScriptEntry): string {
    if (this.worktree?.workspaceKind === 'single-repo')
      return SINGLE_REPO_LOG_FILE;
    const repo = entry.ref.repoId
      ? `-${safeFileSegment(entry.ref.repoId)}`
      : '';
    return `${String(entry.seq).padStart(2, '0')}-${entry.ref.lifecycle}${repo}.log`;
  }

  /** At most one copy per script; a copy failure keeps the verdict and leaves the path empty. */
  private copyLog(entry: ScriptEntry): void {
    const ref = entry.ref.logRef;
    if (!ref || entry.copying || entry.logFile !== undefined) return;
    const name = this.logFileName(entry);
    entry.copying = this.snapshot(ref, name).then((copied) => {
      if (copied) entry.logFile = name;
    });
    this.track(entry.copying);
  }

  private async snapshot(ref: ScriptRunLogRef, name: string): Promise<boolean> {
    const copy = await snapshotScriptRunLog({
      ref,
      targetPath: path.join(this.artifactsDir, name),
    });
    if (copy.status === 'copied') return true;
    logMainProcessWarn('[pipeline-host] create-worktree setup log not saved', {
      status: copy.status,
      ...(copy.status === 'error' ? { message: copy.message } : {}),
    });
    return false;
  }

  private sortedScripts(): ScriptEntry[] {
    const repoRank = (repoId: string | undefined): number =>
      repoId === undefined ? -1 : this.repoOrder.indexOf(repoId);
    return Array.from(this.scripts.values()).sort(
      (left, right) =>
        LIFECYCLE_RANK[left.ref.lifecycle] -
          LIFECYCLE_RANK[right.ref.lifecycle] ||
        repoRank(left.ref.repoId) - repoRank(right.ref.repoId) ||
        left.seq - right.seq,
    );
  }

  private async assignGroup(worktree: CreatedWorktree): Promise<void> {
    const name = this.inputs.group;
    if (name === undefined || this.groupOutputs || !this.admitted) return;
    let outputs: Record<string, string>;
    try {
      const { group, created } =
        await sidebarItemGroupsService.assignItemToNamedGroup({
          scope: { workspaceLocalId: this.inputs.projectId },
          itemId: worktree.taskId,
          name,
        });
      outputs = {
        group_id: group.id,
        group_created: String(created),
        grouped: 'true',
        not_grouped_reason: '',
      };
    } catch (error) {
      if (!(error instanceof SidebarItemGroupRefusalError)) {
        logMainProcessWarn(
          '[pipeline-host] create-worktree group assignment failed',
          {
            errorType: errorType(error),
          },
        );
      }
      outputs = {
        group_id: '',
        group_created: 'false',
        grouped: 'false',
        not_grouped_reason:
          error instanceof SidebarItemGroupRefusalError
            ? error.code
            : 'group_assignment_failed',
      };
    }
    this.groupOutputs = outputs;
    await this.journal((record) => {
      record.group = outputs;
    });
  }

  private outputs(
    worktree: CreatedWorktree,
    setupState: WorktreeSetupState | '',
    setup: {
      exitCode?: number | null;
      logFile?: string;
      resultsFile?: string;
    } = {},
  ): Record<string, string> {
    return {
      ...this.identityOutputs(worktree),
      ...(this.groupOutputs ?? {}),
      setup_state: setupState,
      setup_exit_code:
        setup.exitCode === undefined || setup.exitCode === null
          ? ''
          : String(setup.exitCode),
      setup_log_file: setup.logFile
        ? path.join(this.artifactsDir, setup.logFile)
        : '',
      setup_results_file: setup.resultsFile
        ? path.join(this.artifactsDir, setup.resultsFile)
        : '',
    };
  }

  /** Writes `setup-results.json` when any script started; returns its name. */
  private async writeSetupResults(
    worktree: CreatedWorktree,
    setupState: string,
  ): Promise<string | undefined> {
    const entries = this.sortedScripts();
    if (entries.length === 0) return undefined;
    const body = {
      version: 1,
      project_id: this.inputs.projectId,
      task_id: worktree.taskId,
      setup_state: setupState,
      scripts: entries.map((entry) => ({
        script_key: entry.ref.scriptKey,
        run_id: entry.ref.runId,
        target: entry.ref.target,
        lifecycle: entry.ref.lifecycle,
        repo_id: entry.ref.repoId ?? null,
        state: scriptStateOf(entry),
        exit_code: entry.result?.exitCode ?? null,
        timed_out: entry.result?.timedOut ?? false,
        log_file: entry.logFile ?? '',
      })),
    };
    try {
      await writeFileAtomic(
        path.join(this.artifactsDir, SETUP_RESULTS_FILE),
        `${JSON.stringify(body, null, 2)}\n`,
      );
      return SETUP_RESULTS_FILE;
    } catch (error) {
      logMainProcessWarn(
        '[pipeline-host] create-worktree setup results not saved',
        {
          errorType: errorType(error),
        },
      );
      return undefined;
    }
  }

  /** `run` mode: setup resolved its scripts and keeps running. */
  private async startedResult(
    worktree: CreatedWorktree,
  ): Promise<PipelineHostActionResult> {
    await this.settlePending();
    const state: WorktreeSetupState = this.setupConfigured
      ? 'started'
      : 'none_configured';
    const resultsFile = await this.writeSetupResults(worktree, state);
    await this.journalScripts();
    return {
      status: 'success',
      outputs: this.outputs(worktree, state, {
        ...(resultsFile ? { resultsFile } : {}),
      }),
    };
  }

  private async completedResult(
    worktree: CreatedWorktree,
    done:
      | { kind: 'settled'; result: WorktreeSetupRunResult }
      | { kind: 'rejected' },
  ): Promise<PipelineHostActionResult> {
    if (done.kind === 'rejected') {
      await this.settlePending();
      return failure(
        'setup_failed',
        `Setup for task \`${worktree.taskId}\` couldn't start`,
        this.outputs(worktree, 'failed'),
      );
    }
    // The runner's results are authoritative; fold in any the observer missed.
    for (const script of done.result.scripts) {
      const entry = this.scripts.get(script.runId) ?? {
        ref: script,
        seq: ++this.scriptSeq,
      };
      entry.result = script;
      this.scripts.set(script.runId, entry);
      this.copyLog(entry);
    }
    await this.settlePending();
    return this.aggregateResult(worktree, done.result.status === 'failed');
  }

  /**
   * The verdict from per-script results, in stable order. `runFailed` is the
   * runner's own verdict: a lifecycle that stopped on an error fails even when
   * every recorded script succeeded or none started.
   */
  private async aggregateResult(
    worktree: CreatedWorktree,
    runFailed = false,
  ): Promise<PipelineHostActionResult> {
    const entries = this.sortedScripts();
    if (entries.length === 0 && runFailed) {
      return failure(
        'setup_failed',
        `Setup for task \`${worktree.taskId}\` failed; check its setup log`,
        this.outputs(worktree, 'failed'),
      );
    }
    if (entries.length === 0) {
      return {
        status: 'success',
        outputs: this.outputs(worktree, 'none_configured'),
      };
    }
    const firstBad = entries.find(
      (entry) => scriptStateOf(entry) !== 'succeeded',
    );
    const state: WorktreeSetupState = !firstBad
      ? runFailed
        ? 'failed'
        : 'succeeded'
      : firstBad.result?.timedOut
        ? 'timed_out'
        : 'failed';
    const resultsFile = await this.writeSetupResults(worktree, state);
    await this.journalScripts();
    const results = resultsFile ? { resultsFile } : {};
    if (!firstBad && runFailed) {
      return failure(
        'setup_failed',
        `Setup for task \`${worktree.taskId}\` failed; check its setup log`,
        this.outputs(worktree, state, results),
      );
    }
    if (!firstBad) {
      const single = worktree.workspaceKind === 'single-repo';
      const logFile = single ? entries[0]?.logFile : undefined;
      return {
        status: 'success',
        outputs: this.outputs(worktree, state, {
          exitCode: 0,
          ...(logFile ? { logFile } : {}),
          ...results,
        }),
      };
    }
    const outputs = this.outputs(worktree, state, {
      exitCode: firstBad.result?.exitCode ?? null,
      ...(firstBad.logFile ? { logFile: firstBad.logFile } : {}),
      ...results,
    });
    return state === 'timed_out'
      ? failure(
          'setup_timed_out',
          `Setup for task \`${worktree.taskId}\` timed out; check its setup log`,
          outputs,
        )
      : failure(
          'setup_failed',
          `Setup for task \`${worktree.taskId}\` failed; check its setup log`,
          outputs,
        );
  }

  /**
   * The deadline's verdict from what is durably known: before the creation
   * outcome is known, `target_not_ready` with no setup state; after it,
   * `setup_timed_out`. Copies the running scripts' partial logs.
   */
  private async deadlineResult(): Promise<PipelineHostActionResult> {
    await this.settlePending();
    const worktree = this.worktree;
    const projectId = this.inputs.projectId;
    if (!worktree) {
      return failure(
        'target_not_ready',
        `Task creation in project \`${projectId}\` didn't finish before the step timed out; check the project`,
        projectOutputs(projectId),
      );
    }
    for (const entry of Array.from(this.scripts.values())) {
      // Finalizing: the gate is closed, so copy directly. This covers running
      // scripts (partial logs) and any that completed after withdrawal.
      const ref = entry.ref.logRef;
      if (ref && !entry.copying && entry.logFile === undefined) {
        const name = this.logFileName(entry);
        if (await this.snapshot(ref, name)) entry.logFile = name;
      }
    }
    const state: WorktreeSetupState | '' = this.setupAdmitted
      ? 'timed_out'
      : this.inputs.setup === 'skip'
        ? 'skipped'
        : '';
    const resultsFile = await this.writeSetupResults(worktree, state);
    if (this.record) {
      this.record.scripts = this.sortedScripts().map((entry) =>
        this.toAttemptScript(entry),
      );
    }
    const firstBad = this.sortedScripts().find(
      (entry) => scriptStateOf(entry) !== 'succeeded',
    );
    return failure(
      'setup_timed_out',
      this.setupAdmitted
        ? `Setup for task \`${worktree.taskId}\` didn't finish before the step timed out; it keeps running in the app`
        : `The step timed out after task \`${worktree.taskId}\` was created, before setup started`,
      this.outputs(worktree, state, {
        exitCode: firstBad?.result?.exitCode ?? null,
        ...(firstBad?.logFile ? { logFile: firstBad.logFile } : {}),
        ...(resultsFile ? { resultsFile } : {}),
      }),
    );
  }

  /**
   * `setup_starting`/`setup_running` replay: never relaunch. Recorded runs
   * whose canonical metadata still matches and completed are reused; anything
   * else is an interrupted setup.
   */
  private async reconcileRecordedSetup(
    record: AttemptRecord,
    worktree: CreatedWorktree,
  ): Promise<PipelineHostActionResult> {
    await this.assignGroup(worktree);
    if (record.setupConfigured === false) {
      return this.completeWith({
        status: 'success',
        outputs: this.outputs(worktree, 'none_configured'),
      });
    }
    const interrupted = (): Promise<PipelineHostActionResult> =>
      this.complete(async () => {
        const resultsFile = await this.writeSetupResults(worktree, 'failed');
        return failure('setup_failed', setupInterrupted(worktree.taskId), {
          ...this.outputs(worktree, 'failed', {
            ...(resultsFile ? { resultsFile } : {}),
          }),
        });
      });
    const workspaceId = this.project?.workspaceId ?? this.inputs.projectId;
    if (this.inputs.setup === 'run' && record.phase === 'setup_running') {
      // `run` returns once setup resolves; the launch itself is recorded.
      return this.completeWith({
        status: 'success',
        outputs: this.outputs(worktree, 'started'),
      });
    }
    if (!record.setupSettled || record.scripts.length === 0) {
      return interrupted();
    }
    this.repoOrder = [];
    for (let index = 0; index < record.scripts.length; index += 1) {
      const script = record.scripts[index];
      const meta = (
        await readScriptRun({
          projectId: script.logProjectId ?? workspaceId,
          worktreeId: worktree.taskId,
          scriptKey: script.scriptKey,
          tailLines: 0,
        })
      ).run?.execution;
      // A run still running, or lost to a restart, did not settle setup.
      if (
        !meta ||
        meta.executionId !== script.runId ||
        meta.status === 'running' ||
        meta.status === 'lost'
      ) {
        return interrupted();
      }
      const ref: WorktreeSetupScriptRef = {
        scriptKey: script.scriptKey,
        runId: script.runId,
        target: script.target,
        lifecycle: script.lifecycle,
        ...(script.repoId !== undefined ? { repoId: script.repoId } : {}),
        logRef: {
          projectId: script.logProjectId ?? workspaceId,
          worktreeId: worktree.taskId,
          script: meta.script,
          runId: script.runId,
        },
      };
      this.scripts.set(script.runId, {
        ref,
        seq: index + 1,
        result: {
          ...ref,
          status:
            meta.status === 'success'
              ? 'succeeded'
              : meta.timedOut
                ? 'timed_out'
                : meta.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
          exitCode: meta.exitCode,
          timedOut: meta.timedOut,
        },
        ...(script.logFile !== undefined ? { logFile: script.logFile } : {}),
      });
    }
    this.scriptSeq = record.scripts.length;
    return this.complete(async () => {
      // A crash after `setupSettled` can lose the journaled copy names. A copy
      // already on disk is complete (copies land by rename) and is never
      // overwritten, so adopt it; otherwise the canonical log still matches
      // this run, so copy it now.
      for (const entry of Array.from(this.scripts.values())) {
        if (!entry.ref.logRef || entry.logFile !== undefined) continue;
        const name = this.logFileName(entry);
        if (await fileExists(path.join(this.artifactsDir, name))) {
          entry.logFile = name;
        } else {
          this.copyLog(entry);
        }
      }
      await this.settlePending();
      return this.aggregateResult(worktree, record.setupRunFailed === true);
    });
  }
}

const liveOperations = new Map<string, CreateWorktreeOperation>();

function waitOrAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export async function runCreateWorktreeHostAction(
  inputs: CreateWorktreeInputs,
  caller: PipelineHostActionCaller,
  deps: CreateWorktreeHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  // Internal contract errors: no effects, not typed refusals.
  if (!controls) throw new Error('create-worktree needs execution controls');
  if (!caller.idempotencyKey) {
    throw new Error('create-worktree needs an idempotency key');
  }
  if (signal.aborted) throw abortError();
  const key = caller.idempotencyKey;
  let operation = liveOperations.get(key);
  // A finalized operation still answers with its result; a withdrawn one
  // admits nothing more, so this call acts again.
  if (operation && operation.withdrawn) operation = undefined;
  if (
    operation &&
    operation.fingerprint !== createWorktreeRequestFingerprint(inputs)
  ) {
    throw new PipelineHostRefusal(
      'authorization_conflict',
      'This step already ran with different inputs',
    );
  }
  if (!operation) {
    const created = new CreateWorktreeOperation(
      inputs,
      caller,
      deps,
      controls.artifactsDir,
    );
    liveOperations.set(key, created);
    void created.result
      .catch(() => undefined)
      .finally(() => {
        if (liveOperations.get(key) === created) liveOperations.delete(key);
      });
    operation = created;
  }
  const live = operation;
  // Registered before the first await, so a deadline always reaches it.
  controls.registerTimeoutFinalizer(() => live.finalizeOnDeadline());
  live.attach();
  try {
    return await waitOrAbort(live.result, signal);
  } finally {
    live.detach(signal.aborted);
  }
}
