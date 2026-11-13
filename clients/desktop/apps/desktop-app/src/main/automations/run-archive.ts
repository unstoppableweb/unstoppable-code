import { isAutomationExecutionLocation } from '@canopy/protocol/automations';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_RUN_HISTORY_DEFAULT_PAGE_SIZE,
  AUTOMATION_RUN_HISTORY_MAX_PAGE_SIZE,
  type AutomationRunHistoryRequest,
  type AutomationRunHistoryResponse,
  type ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import { getAutomationRunArchiveFilePath } from '../lib/paths';

export const ARCHIVE_MAX_RUNS_PER_ACTIVITY = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOptionalStringFields(
  value: unknown,
  fields: readonly string[],
): boolean {
  if (!isRecord(value)) return false;
  return fields.every(
    (field) => value[field] === undefined || typeof value[field] === 'string',
  );
}

export function isAutomationRunArchiveRecord(
  value: unknown,
): value is ScheduledActivityRun {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.activityId !== 'string') return false;
  if (typeof value.activityName !== 'string') return false;
  if (
    typeof value.scheduledFor !== 'string' ||
    !Number.isFinite(Date.parse(value.scheduledFor))
  ) {
    return false;
  }
  if (typeof value.manual !== 'boolean') return false;
  if (
    value.status !== 'running' &&
    value.status !== 'success' &&
    value.status !== 'failure' &&
    value.status !== 'skipped' &&
    value.status !== 'canceled' &&
    value.status !== 'missed'
  ) {
    return false;
  }
  if (
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    return false;
  }
  if (
    value.completedAt !== undefined &&
    (typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt)))
  ) {
    return false;
  }
  if (
    value.trigger !== undefined &&
    value.trigger !== 'scheduled' &&
    value.trigger !== 'manual' &&
    value.trigger !== 'catch_up'
  ) {
    return false;
  }
  // CAN-6183: a run from a location this desktop doesn't know is kept.
  if (
    value.executionLocation !== undefined &&
    !isAutomationExecutionLocation(value.executionLocation)
  )
    delete value.executionLocation;
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0)
  ) {
    return false;
  }
  if (value.recovered !== undefined && typeof value.recovered !== 'boolean') {
    return false;
  }
  if (
    value.cancellable !== undefined &&
    typeof value.cancellable !== 'boolean'
  ) {
    return false;
  }
  if (
    value.target !== undefined &&
    !hasOptionalStringFields(value.target, [
      'workspaceId',
      'worktreeId',
      'chatId',
      'repoId',
    ])
  ) {
    return false;
  }
  if (
    value.ifCommandOutput !== undefined &&
    typeof value.ifCommandOutput !== 'string'
  ) {
    return false;
  }
  if (
    value.ifCommandError !== undefined &&
    typeof value.ifCommandError !== 'string'
  ) {
    return false;
  }
  if (
    value.omittedCount !== undefined &&
    (typeof value.omittedCount !== 'number' ||
      !Number.isInteger(value.omittedCount) ||
      value.omittedCount < 1)
  ) {
    return false;
  }
  if (
    value.missedOccurrencesTruncated !== undefined &&
    typeof value.missedOccurrencesTruncated !== 'boolean'
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    return false;
  }
  if (
    value.result !== undefined &&
    !hasOptionalStringFields(value.result, [
      'appAdvisorChatId',
      'standaloneChatId',
      'projectId',
      'worktreeId',
      'chatId',
      'userMessageId',
      'pipelineExecutionId',
    ])
  ) {
    return false;
  }
  if (
    value.skipReason !== undefined &&
    value.skipReason !== 'if_command_exit' &&
    value.skipReason !== 'idempotency' &&
    value.skipReason !== 'already_running'
  ) {
    return false;
  }
  if (
    value.idempotencyKey !== undefined &&
    typeof value.idempotencyKey !== 'string'
  ) {
    return false;
  }
  return (
    value.idempotencyScope === undefined ||
    value.idempotencyScope === 'global' ||
    value.idempotencyScope === 'self'
  );
}

function parseLines(raw: string): ScheduledActivityRun[] {
  const runs: ScheduledActivityRun[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isAutomationRunArchiveRecord(value)) runs.push(value);
    } catch {
      // A crash may leave one partial JSONL line. Earlier valid rows survive.
    }
  }
  return runs;
}

function foldRuns(lines: ScheduledActivityRun[]): ScheduledActivityRun[] {
  const byId = new Map<string, ScheduledActivityRun>();
  for (const run of lines) byId.set(run.id, run);
  return Array.from(byId.values()).sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      right.id.localeCompare(left.id),
  );
}

function encodeCursor(run: ScheduledActivityRun): string {
  return Buffer.from(JSON.stringify([run.startedAt, run.id])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // Fall through to the stable public error below.
  }
  throw new Error('Invalid automation run history cursor.');
}

export class AutomationRunArchive {
  private queues = new Map<string, Promise<unknown>>();
  private lineCounts = new Map<string, number>();
  private runIds = new Map<string, Set<string>>();

  private enqueue<T>(activityId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(activityId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(activityId, tracked);
    void tracked.finally(() => {
      if (this.queues.get(activityId) === tracked) {
        this.queues.delete(activityId);
      }
    });
    return next;
  }

  async appendRun(run: ScheduledActivityRun): Promise<void> {
    let shouldCompact = false;
    await this.enqueue(run.activityId, async () => {
      const filePath = getAutomationRunArchiveFilePath(run.activityId);
      await mkdir(dirname(filePath), { recursive: true });
      let needsLeadingNewline = false;
      if (!this.lineCounts.has(run.activityId)) {
        try {
          const existing = await readFile(filePath, 'utf8');
          needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
          this.lineCounts.set(
            run.activityId,
            existing.split('\n').filter((line) => line.trim()).length,
          );
          this.runIds.set(
            run.activityId,
            new Set(parseLines(existing).map((entry) => entry.id)),
          );
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          this.lineCounts.set(run.activityId, 0);
          this.runIds.set(run.activityId, new Set());
        }
      }
      await appendFile(
        filePath,
        `${needsLeadingNewline ? '\n' : ''}${JSON.stringify(run)}\n`,
        'utf8',
      );
      const lineCount = (this.lineCounts.get(run.activityId) ?? 0) + 1;
      this.lineCounts.set(run.activityId, lineCount);
      const runIds = this.runIds.get(run.activityId) ?? new Set<string>();
      runIds.add(run.id);
      this.runIds.set(run.activityId, runIds);
      shouldCompact =
        runIds.size > ARCHIVE_MAX_RUNS_PER_ACTIVITY ||
        lineCount > ARCHIVE_MAX_RUNS_PER_ACTIVITY * 2 ||
        lineCount > runIds.size * 2;
    });
    if (shouldCompact) await this.compactActivityArchive(run.activityId);
  }

  async readRuns(
    activityId: string,
    options: Omit<AutomationRunHistoryRequest, 'activityId'> = {},
  ): Promise<AutomationRunHistoryResponse> {
    await this.queues.get(activityId);
    const filePath = getAutomationRunArchiveFilePath(activityId);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return { runs: [], nextCursor: null, totalCount: 0 };
      }
      throw error;
    }
    let runs = foldRuns(parseLines(raw));
    if (options.statuses?.length) {
      const statuses = new Set(options.statuses);
      runs = runs.filter((run) => statuses.has(run.status));
    }
    if (options.triggers?.length) {
      const triggers = new Set(options.triggers);
      runs = runs.filter((run) =>
        triggers.has(run.trigger ?? (run.manual ? 'manual' : 'scheduled')),
      );
    }
    const totalCount = runs.length;
    let start = 0;
    if (options.cursor) {
      const [startedAt, id] = decodeCursor(options.cursor);
      const index = runs.findIndex(
        (run) => run.startedAt === startedAt && run.id === id,
      );
      if (index === -1)
        throw new Error('Automation run history cursor expired.');
      start = index + 1;
    }
    const limit = Math.min(
      options.limit ?? AUTOMATION_RUN_HISTORY_DEFAULT_PAGE_SIZE,
      AUTOMATION_RUN_HISTORY_MAX_PAGE_SIZE,
    );
    const page = runs.slice(start, start + limit);
    const hasMore = start + page.length < runs.length;
    const lastRun = page[page.length - 1];
    return {
      runs: page,
      nextCursor: hasMore && lastRun ? encodeCursor(lastRun) : null,
      totalCount,
    };
  }

  async deleteActivityArchive(activityId: string): Promise<void> {
    await this.enqueue(activityId, async () => {
      await unlink(getAutomationRunArchiveFilePath(activityId)).catch(
        (error: unknown) => {
          if (!isMissingFile(error)) throw error;
        },
      );
      this.lineCounts.delete(activityId);
      this.runIds.delete(activityId);
    });
  }

  async findRun(
    activityId: string,
    runId: string,
  ): Promise<ScheduledActivityRun | null> {
    await this.queues.get(activityId);
    const filePath = getAutomationRunArchiveFilePath(activityId);
    try {
      const runs = parseLines(await readFile(filePath, 'utf8'));
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        const candidate = runs[index];
        if (candidate?.id === runId) return candidate;
      }
      return null;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  /** The latest record of the run that started a pipeline execution. */
  async findRunByPipelineExecution(
    activityId: string,
    executionId: string,
  ): Promise<ScheduledActivityRun | null> {
    await this.queues.get(activityId);
    const filePath = getAutomationRunArchiveFilePath(activityId);
    try {
      const runs = parseLines(await readFile(filePath, 'utf8'));
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        const candidate = runs[index];
        if (candidate?.result?.pipelineExecutionId === executionId)
          return candidate;
      }
      return null;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async compactActivityArchive(
    activityId: string,
    options: { retentionDays?: number; now?: Date } = {},
  ): Promise<void> {
    await this.enqueue(activityId, async () => {
      const filePath = getAutomationRunArchiveFilePath(activityId);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
      const now = options.now ?? new Date();
      const cutoff =
        options.retentionDays === undefined
          ? Number.NEGATIVE_INFINITY
          : now.getTime() - options.retentionDays * DAY_MS;
      const retained = foldRuns(parseLines(raw))
        .filter((run) => Date.parse(run.startedAt) >= cutoff)
        .slice(0, ARCHIVE_MAX_RUNS_PER_ACTIVITY);
      const tempPath = join(
        dirname(filePath),
        `.automation-runs-${process.pid}-${randomUUID()}.tmp`,
      );
      let renamed = false;
      try {
        await writeFile(
          tempPath,
          retained.length
            ? `${retained.map((run) => JSON.stringify(run)).join('\n')}\n`
            : '',
          'utf8',
        );
        await rename(tempPath, filePath);
        renamed = true;
        this.lineCounts.set(activityId, retained.length);
        this.runIds.set(activityId, new Set(retained.map((run) => run.id)));
      } finally {
        if (!renamed) await unlink(tempPath).catch(() => undefined);
      }
    });
  }

  async pruneAll(retentionDays: number): Promise<void> {
    const directory = dirname(getAutomationRunArchiveFilePath('archive-root'));
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    await Promise.all(
      files
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) =>
          this.compactActivityArchive(name.slice(0, -'.jsonl'.length), {
            retentionDays,
          }),
        ),
    );
  }
}

let singleton: AutomationRunArchive | null = null;

export function getAutomationRunArchive(): AutomationRunArchive {
  singleton ??= new AutomationRunArchive();
  return singleton;
}
