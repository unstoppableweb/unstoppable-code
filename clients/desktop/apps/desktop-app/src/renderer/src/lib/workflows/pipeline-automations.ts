import {
  getHookTriggerDisplayName,
  listRunnableHooks,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import type {
  ScheduledActivity,
  SidebarItem,
  WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineStartKind,
  PipelineTriggerHookRow,
  WorkflowRunRow,
} from '@canopy/ui-app/workflows';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import {
  automationTrigger,
  findTargetPipeline,
  pipelineLibraryKey,
} from './library-projection';

/**
 * A pipeline's Trigger and Runs sections in the edit shell (CAN-4072): pure
 * projections over what the Library and the Runs feed already load. An
 * automation runs a pipeline exactly when the Library says so, through the
 * same `findTargetPipeline` lookup, so the two never disagree.
 */

/**
 * The triggers a pipeline declares, as its Trigger section lists them. No
 * declared trigger means it is started by hand, as the engine reads it.
 */
export function pipelineStartKinds(
  types: readonly PipelineTriggerType[] | undefined,
): readonly PipelineStartKind[] {
  const kinds: PipelineStartKind[] = [];
  if (!types || types.length === 0 || types.includes('dispatch')) {
    kinds.push('manual');
  }
  if (types?.includes('plan_ready')) kinds.push('plan-approved');
  if (types?.includes('task_ready')) kinds.push('task-ready');
  if (types?.includes('workflow')) kinds.push('workflow');
  return kinds;
}

/** One hook listed in a pipeline's Trigger section. */
export interface PipelineHookRow extends PipelineTriggerHookRow {
  /** The project whose settings hold the hook. */
  readonly projectId: string;
}

function trimRelativePath(path: string): string {
  return path.replace(/^\.\//, '');
}

/**
 * Whether a hook action runs `pipeline`. A hook names its pipeline by source
 * and id, as the hook editor's picker writes it: a local pipeline is the
 * user's, and a project pipeline is its path under `.canopy/pipelines/`.
 */
function hookActionRunsPipeline(
  action: HookAction,
  pipeline: PipelineInfo,
): boolean {
  if (action.type !== 'pipeline') return false;
  switch (action.source) {
    case 'bundled':
      return pipeline.source === 'bundled' && action.id === pipeline.id;
    case 'local':
      return pipeline.source === 'user' && action.id === pipeline.id;
    case 'curated':
      return pipeline.source === 'curated' && action.id === pipeline.id;
    case 'project':
      return (
        pipeline.source === 'project' &&
        trimRelativePath(action.id) === trimRelativePath(pipeline.filename)
      );
  }
}

/** Checkouts a project's own pipelines can be read from. */
function projectRoots(project: SidebarItem): readonly string[] {
  switch (project.type) {
    case 'single-repo':
      return [project.repoPath];
    case 'multi-repo':
      return [
        ...(project.sourceRepoPath ? [project.sourceRepoPath] : []),
        ...project.repos.map((repo) => repo.repoPath),
      ];
    case 'cowork':
      return [];
  }
}

function underRoot(filePath: string, root: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  return filePath.startsWith(base);
}

interface HookScopeSource {
  readonly scope: string;
  readonly repoName?: string;
  /** The project's hooks, then each worktree's, which can differ by branch. */
  readonly overrides: readonly (HookOverrides | undefined)[];
}

function hookScopes(project: SidebarItem): readonly HookScopeSource[] {
  if (project.type === 'cowork') return [];
  const worktrees: readonly WorktreeEffectiveOverrides[] = Object.values(
    project.worktreeEffective ?? {},
  );
  switch (project.type) {
    case 'single-repo':
      return [
        {
          scope: 'project',
          overrides: [
            project.effectiveHooks,
            ...worktrees.map((entry) => entry.effectiveHooks),
          ],
        },
      ];
    case 'multi-repo':
      return [
        {
          scope: 'workspace-root',
          overrides: [
            project.effectiveHooks,
            ...worktrees.map((entry) => entry.effectiveHooks),
          ],
        },
        ...project.repos.map((repo) => ({
          scope: `workspace-repo:${repo.id}`,
          repoName: repo.name,
          overrides: [
            repo.effectiveHooks,
            ...worktrees.map((entry) => entry.repos?.[repo.id]?.effectiveHooks),
          ],
        })),
      ];
  }
}

/**
 * The hooks that run `pipeline`, one row per project, scope and event. A
 * project pipeline is read from one project's checkout; when its path names
 * that project, only that project's hooks count. Otherwise every project
 * with a hook for the same path is listed, named so the two can be told
 * apart.
 */
export function hooksRunningPipeline(
  projects: readonly SidebarItem[],
  pipeline: PipelineInfo,
  locale?: string,
): readonly PipelineHookRow[] {
  const filePath = pipeline.filePath;
  const owners =
    pipeline.source === 'project' && filePath
      ? projects.filter((project) =>
          projectRoots(project).some((root) => underRoot(filePath, root)),
        )
      : [];
  const candidates = owners.length > 0 ? owners : projects;
  const rows = new Map<string, PipelineHookRow>();
  for (const project of candidates) {
    const projectName = getWorkspaceDisplayName(project);
    for (const source of hookScopes(project)) {
      for (const overrides of source.overrides) {
        for (const hook of listRunnableHooks(overrides)) {
          if (
            !hook.actions.some((action) =>
              hookActionRunsPipeline(action, pipeline),
            )
          ) {
            continue;
          }
          const key = `${project.id}:${source.scope}:${hook.triggerName}`;
          if (rows.has(key)) continue;
          rows.set(key, {
            key,
            projectId: project.id,
            eventLabel: getHookTriggerDisplayName(hook.triggerName),
            where: source.repoName
              ? `${projectName} · ${source.repoName}`
              : projectName,
          });
        }
      }
    }
  }
  return Array.from(rows.values()).sort(
    (a, b) =>
      a.where.localeCompare(b.where, locale) ||
      a.eventLabel.localeCompare(b.eventLabel, locale) ||
      a.key.localeCompare(b.key),
  );
}

/** One automation listed in a pipeline's Trigger section. */
export interface PipelineAutomationRow {
  readonly activity: ScheduledActivity;
  /** The schedule as the automation's Library row shows it. */
  readonly scheduleText: string;
  readonly enabled: boolean;
}

export interface PipelineAutomationsOptions {
  /**
   * Every pipeline the Library lists. Ids are unique per source only, so an
   * automation that recorded no source runs the first listed match.
   */
  readonly pipelines: readonly PipelineInfo[];
  readonly locale?: string;
}

/** The listed pipeline `activity` runs, when its action runs one. */
function targetOf(
  activity: ScheduledActivity,
  pipelines: readonly PipelineInfo[],
): PipelineInfo | undefined {
  return activity.action.type === 'worktree_pipeline'
    ? findTargetPipeline(activity.action, pipelines)
    : undefined;
}

function runsPipeline(
  activity: ScheduledActivity,
  pipelineKey: string,
  pipelines: readonly PipelineInfo[],
): boolean {
  const target = targetOf(activity, pipelines);
  return target !== undefined && pipelineLibraryKey(target) === pipelineKey;
}

/** The automations that run `pipeline`, by name. */
export function automationsRunningPipeline(
  activities: readonly ScheduledActivity[],
  pipeline: PipelineInfo,
  { pipelines, locale }: PipelineAutomationsOptions,
): readonly PipelineAutomationRow[] {
  const key = pipelineLibraryKey(pipeline);
  return activities
    .filter((activity) => runsPipeline(activity, key, pipelines))
    .map((activity) => ({
      activity,
      scheduleText: automationTrigger(activity, locale).text,
      enabled: activity.enabled,
    }))
    .sort(
      (a, b) =>
        a.activity.name.localeCompare(b.activity.name, locale) ||
        a.activity.id.localeCompare(b.activity.id),
    );
}

export interface PipelineRunsOptions {
  /** Every pipeline the Library lists, as for the Trigger section. */
  readonly pipelines: readonly PipelineInfo[];
  /** The activities the rows were built from. */
  readonly activities: readonly ScheduledActivity[];
  /** The executions the rows were built from. */
  readonly executions: readonly ExecutionSummary[];
  /**
   * CAN-5782: a workflow page's schedule records. Every run of theirs is
   * listed, also one that started nothing (skipped or missed).
   */
  readonly scheduleIds?: ReadonlySet<string>;
}

/**
 * Whether an automation run's execution is one of `pipeline`'s. A retained
 * execution names its pipeline id; when the automation still runs that id,
 * its action also decides the source, since executions carry none. Once the
 * execution is no longer kept, the automation's current target is all that
 * is known.
 */
function linkedExecutionRunsPipeline(
  executionId: string,
  activity: ScheduledActivity | undefined,
  pipeline: PipelineInfo,
  executionsById: ReadonlyMap<string, ExecutionSummary>,
  pipelines: readonly PipelineInfo[],
): boolean {
  const key = pipelineLibraryKey(pipeline);
  const execution = executionsById.get(executionId);
  const target = activity ? targetOf(activity, pipelines) : undefined;
  if (execution === undefined) {
    return target !== undefined && pipelineLibraryKey(target) === key;
  }
  if (execution.pipeline_id !== pipeline.id) return false;
  return (
    target === undefined ||
    target.id !== execution.pipeline_id ||
    pipelineLibraryKey(target) === key
  );
}

/**
 * A pipeline's Runs section: the Runs feed rows for its executions plus the
 * automation runs that started one, in the feed's order. An automation run
 * that started nothing (skipped, missed, or not a pipeline run) is left out,
 * as are watchers, except a workflow page's schedule runs, which are all
 * listed (CAN-5782).
 */
export function runsForPipeline(
  rows: readonly WorkflowRunRow[],
  pipeline: PipelineInfo,
  { pipelines, activities, executions, scheduleIds }: PipelineRunsOptions,
): readonly WorkflowRunRow[] {
  const activitiesById = new Map(
    activities.map((activity) => [activity.id, activity]),
  );
  const executionsById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  return rows.filter((row) => {
    switch (row.kind) {
      case 'pipeline':
        // Executions carry the pipeline id but not its source, as in the
        // Library's Last run.
        return row.summary.pipeline_id === pipeline.id;
      case 'automation':
        if (scheduleIds?.has(row.activityId) === true) return true;
        return (
          row.linkedExecutionId !== undefined &&
          linkedExecutionRunsPipeline(
            row.linkedExecutionId,
            activitiesById.get(row.activityId),
            pipeline,
            executionsById,
            pipelines,
          )
        );
      case 'watcher':
        return false;
    }
  });
}

/**
 * How many workflows use `pipeline` (CAN-5782 phase 09): each automation
 * that runs it directly, each hook that runs it, each other workflow page
 * that calls it through `builtin/run-pipeline` (`workflowCallers`), and its
 * own workflow page once, however many schedules that page has.
 */
export function pipelineUserCount(
  pipeline: PipelineInfo,
  {
    activities,
    pipelines,
    hookCount,
  }: {
    readonly activities: readonly ScheduledActivity[];
    readonly pipelines: readonly PipelineInfo[];
    readonly hookCount: number;
  },
): number {
  // A converted owner's action is projected to its chat action, so the
  // page's own schedules are found by `workflowSchedule`, as the Library and
  // the Trigger section find them, not by the action they run.
  const own = new Set(
    pipeline.source === 'user'
      ? activities.flatMap((activity) =>
          activity.workflowSchedule?.pipelineId === pipeline.id
            ? [activity.id]
            : [],
        )
      : [],
  );
  const direct = automationsRunningPipeline(activities, pipeline, {
    pipelines,
  }).filter((row) => !own.has(row.activity.id)).length;
  return (
    direct +
    (own.size > 0 ? 1 : 0) +
    hookCount +
    (pipeline.workflowCallers ?? 0)
  );
}

/**
 * Whether the shared-pipeline notice offers Duplicate (CAN-4224 phase 07):
 * only where main would accept the copy. Main refuses a workflow page that
 * an install with a capability package owns, and that owner is among the
 * page's schedules, so the offer waits until the automations have loaded.
 */
export function sharedPipelineDuplicateOffered(
  pipeline: PipelineInfo,
  {
    activities,
    activitiesLoaded,
  }: {
    readonly activities: readonly ScheduledActivity[];
    readonly activitiesLoaded: boolean;
  },
): boolean {
  if (pipeline.source !== 'user' || !activitiesLoaded) return false;
  return !activities.some(
    (activity) =>
      activity.workflowSchedule?.pipelineId === pipeline.id &&
      activity.installedFrom?.capabilityPackage !== undefined,
  );
}
