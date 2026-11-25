import type {
  DataModelDiffDiagram,
  DataModelDiffGenerationResult,
  LogicDiffDiagram,
  ParsedPlanGraph,
  PlanDiagramArtifact,
  PlanDiagramArtifacts,
} from '@canopy/protocol/plans';
import type { PlanDiagramKey } from './engine';

/*
 * Plan diagram scheduling (CAN-4167): which diagrams a plan gets, when they
 * are generated, and how each generated artifact is stored. The host runs
 * the generators (worker helper runs), owns the diagram model settings and
 * the helper-task bookkeeping, and tells its windows about each change.
 */

const DEBOUNCE_MS = 2500;
const DATA_MODEL_PLAN_HINT_PATTERN =
  /\b(data model|database|schema|migration|migrate|table|column|entity|relationship|prisma|drizzle|sequelize|typeorm|postgres|mysql|sqlite|mongodb|sql|ddl|orm|foreign key|primary key)\b/i;

export interface PlanDiagramSubject {
  projectId: string;
  worktreeId: string;
  id: string;
  content: string;
  latestRevisionNumber: number;
  diagrams?: PlanDiagramArtifacts;
}

export interface PlanDiagramRef {
  projectId: string;
  worktreeId: string;
  planId: string;
}

export interface PlanDiagramGeneration<
  Plan extends PlanDiagramSubject,
  Settings,
> {
  ref: PlanDiagramRef;
  plan: Plan;
  taskKey: string;
  /** What the host resolved for this run: the diagram model and where it runs. */
  settings: Settings;
  /**
   * True only for a person's request. It alone lets a generation fall back
   * to AI Credits (ECW-9091); a content change never does.
   */
  attended: boolean;
}

export interface PlanDiagramGenerated<Value, Usage> {
  value: Value | null | undefined;
  usage?: Usage;
}

export interface PlanDiagramSchedulerHost<
  Plan extends PlanDiagramSubject,
  Target,
  Settings,
  Usage,
> {
  getPlan(ref: PlanDiagramRef): Promise<Plan | null>;
  /** Resolves the diagram model for a run; throws when no harness serves it. */
  prepare(ref: PlanDiagramRef): Promise<Settings>;
  generateSequence(
    run: PlanDiagramGeneration<Plan, Settings>,
  ): Promise<PlanDiagramGenerated<ParsedPlanGraph, Usage>>;
  generateLogicDiff(
    run: PlanDiagramGeneration<Plan, Settings>,
  ): Promise<PlanDiagramGenerated<LogicDiffDiagram, Usage>>;
  generateDataModelDiff(
    run: PlanDiagramGeneration<Plan, Settings>,
  ): Promise<PlanDiagramGenerated<DataModelDiffGenerationResult, Usage>>;
  startTask(
    kind: PlanDiagramKey,
    run: PlanDiagramGeneration<Plan, Settings>,
  ): void;
  finishTask(
    taskKey: string,
    outcome: 'success' | 'failure',
    message?: string,
    usage?: Usage,
  ): void;
  writeArtifact(
    ref: PlanDiagramRef,
    kind: PlanDiagramKey,
    artifact: PlanDiagramArtifact<unknown>,
  ): Promise<Plan | null>;
  removeDataModelArtifact(
    ref: PlanDiagramRef,
    expectedRevision: number,
  ): Promise<Plan | null>;
  /** The plan as stored after a diagram write, for the scheduling caller's windows. */
  planUpdated(plan: Plan, target: Target): void;
}

export interface PlanDiagramScheduleOptions {
  /** A request runs at once; a content change debounces. */
  immediate?: boolean;
  /** Only with `immediate`: whether a person asked. A debounced run never is. */
  attended?: boolean;
}

export type PlanDiagramScheduleStatus = 'started' | 'queued' | 'debounced';

export interface PlanDiagramScheduler<Plan extends PlanDiagramSubject, Target> {
  schedule(
    plan: Plan,
    target: Target,
    options?: PlanDiagramScheduleOptions,
  ): PlanDiagramScheduleStatus;
}

function planKey(ref: PlanDiagramRef): string {
  return `${ref.projectId}/${ref.worktreeId}/${ref.planId}`;
}

const TASK_NAMES: Record<PlanDiagramKey, string> = {
  sequence: 'plan-sequence-diagram',
  logicDiff: 'plan-logic-diagram',
  dataModelDiff: 'plan-data-model-diagram',
};

function taskKeyFor(
  kind: PlanDiagramKey,
  ref: PlanDiagramRef,
  revision: number,
): string {
  return `helper:${TASK_NAMES[kind]}:${ref.projectId}/${ref.worktreeId}/${ref.planId}:${revision}`;
}

function buildErrorArtifact<T>(
  revision: number,
  previousArtifact: PlanDiagramArtifact<T> | undefined,
  error: string,
): PlanDiagramArtifact<T> {
  return {
    data: previousArtifact?.data ?? null,
    derivedFromRevision: revision,
    status: 'error',
    error,
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPlanDiagramScheduler<
  Plan extends PlanDiagramSubject,
  Target,
  Settings,
  Usage,
>(
  host: PlanDiagramSchedulerHost<Plan, Target, Settings, Usage>,
): PlanDiagramScheduler<Plan, Target> {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const pending = new Set<string>();
  /**
   * Whether a person queued the pending rerun, tracked apart from the run in
   * flight: replaying the in-flight run's flag would let a background
   * regeneration fall back to AI Credits, or turn a person's request into a silent
   * one. Sticky-true (ECW-9091 review round 9).
   */
  const pendingAttended = new Set<string>();

  const persist = async (
    ref: PlanDiagramRef,
    kind: PlanDiagramKey,
    artifact: PlanDiagramArtifact<unknown>,
    target: Target,
  ): Promise<void> => {
    const updated = await host.writeArtifact(ref, kind, artifact);
    if (updated) host.planUpdated(updated, target);
  };

  const runDataModelDiff = async (
    run: PlanDiagramGeneration<Plan, Settings>,
    target: Target,
  ): Promise<void> => {
    const { ref, plan, taskKey } = run;
    const previousArtifact = plan.diagrams?.dataModelDiff;

    if (previousArtifact) {
      const generating: PlanDiagramArtifact<DataModelDiffDiagram> = {
        data: previousArtifact.data,
        derivedFromRevision: previousArtifact.derivedFromRevision,
        status: 'generating',
        ...(previousArtifact.generatedAt
          ? { generatedAt: previousArtifact.generatedAt }
          : {}),
      };
      await persist(ref, 'dataModelDiff', generating, target);
    }

    host.startTask('dataModelDiff', run);

    try {
      const { value, usage } = await host.generateDataModelDiff(run);

      if (value?.applicable === true && value.diagram) {
        const ready: PlanDiagramArtifact<DataModelDiffDiagram> = {
          data: value.diagram,
          derivedFromRevision: plan.latestRevisionNumber,
          status: 'ready',
          generatedAt: new Date().toISOString(),
        };
        await persist(ref, 'dataModelDiff', ready, target);
        host.finishTask(taskKey, 'success', undefined, usage);
        return;
      }

      if (value?.applicable === false) {
        if (previousArtifact) {
          const updated = await host.removeDataModelArtifact(
            ref,
            plan.latestRevisionNumber,
          );
          if (updated) host.planUpdated(updated, target);
        }
        host.finishTask(taskKey, 'success', undefined, usage);
        return;
      }

      const message =
        value?.applicable === true
          ? 'Data model diagram generation returned no diagram'
          : 'Data model diagram generation returned no result';
      if (previousArtifact) {
        await persist(
          ref,
          'dataModelDiff',
          buildErrorArtifact(
            plan.latestRevisionNumber,
            previousArtifact,
            message,
          ),
          target,
        );
      }
      host.finishTask(taskKey, 'failure', message, usage);
    } catch (error) {
      const message = errorMessage(error);
      if (previousArtifact) {
        await persist(
          ref,
          'dataModelDiff',
          buildErrorArtifact(
            plan.latestRevisionNumber,
            previousArtifact,
            message,
          ),
          target,
        );
      }
      host.finishTask(taskKey, 'failure', message);
    }
  };

  const runGraph = async <Value>(
    kind: 'sequence' | 'logicDiff',
    generate: (
      run: PlanDiagramGeneration<Plan, Settings>,
    ) => Promise<PlanDiagramGenerated<Value, Usage>>,
    run: PlanDiagramGeneration<Plan, Settings>,
    target: Target,
  ): Promise<void> => {
    const { ref, plan, taskKey } = run;
    const previousArtifact: PlanDiagramArtifact<unknown> | undefined =
      plan.diagrams?.[kind];

    // Mark the artifact 'generating' up front, keeping any prior data and
    // revision, so both a first generation and a refresh show feedback.
    const generating: PlanDiagramArtifact<unknown> = {
      data: previousArtifact?.data ?? null,
      derivedFromRevision:
        previousArtifact?.derivedFromRevision ?? plan.latestRevisionNumber,
      status: 'generating',
      ...(previousArtifact?.generatedAt
        ? { generatedAt: previousArtifact.generatedAt }
        : {}),
    };
    await persist(ref, kind, generating, target);

    host.startTask(kind, run);

    try {
      const { value, usage } = await generate(run);

      if (value) {
        const ready: PlanDiagramArtifact<Value> = {
          data: value,
          derivedFromRevision: plan.latestRevisionNumber,
          status: 'ready',
          generatedAt: new Date().toISOString(),
        };
        await persist(ref, kind, ready, target);
        host.finishTask(taskKey, 'success', undefined, usage);
      } else {
        const message = 'Diagram generation returned no graph';
        await persist(
          ref,
          kind,
          buildErrorArtifact(
            plan.latestRevisionNumber,
            previousArtifact,
            message,
          ),
          target,
        );
        host.finishTask(taskKey, 'failure', message, usage);
      }
    } catch (error) {
      const message = errorMessage(error);
      await persist(
        ref,
        kind,
        buildErrorArtifact(
          plan.latestRevisionNumber,
          previousArtifact,
          message,
        ),
        target,
      );
      host.finishTask(taskKey, 'failure', message);
    }
  };

  const runGeneration = async (
    ref: PlanDiagramRef,
    target: Target,
    attended: boolean,
  ): Promise<void> => {
    const key = planKey(ref);

    if (inFlight.has(key)) {
      pending.add(key);
      // Record this caller's intent, not the in-flight run's.
      if (attended) pendingAttended.add(key);
      return;
    }

    inFlight.add(key);

    try {
      const plan = await host.getPlan(ref);
      if (!plan) return;

      const settings = await host.prepare(ref);

      const runFor = (
        kind: PlanDiagramKey,
      ): PlanDiagramGeneration<Plan, Settings> => ({
        ref,
        plan,
        settings,
        attended,
        taskKey: taskKeyFor(kind, ref, plan.latestRevisionNumber),
      });

      // Each kind settles on its own: one failure never affects the others.
      const shouldRunDataModelDiff =
        Boolean(plan.diagrams?.dataModelDiff) ||
        DATA_MODEL_PLAN_HINT_PATTERN.test(plan.content);
      const generations: Array<Promise<void>> = [
        runGraph(
          'sequence',
          (run) => host.generateSequence(run),
          runFor('sequence'),
          target,
        ),
        runGraph(
          'logicDiff',
          (run) => host.generateLogicDiff(run),
          runFor('logicDiff'),
          target,
        ),
      ];
      if (shouldRunDataModelDiff) {
        generations.push(runDataModelDiff(runFor('dataModelDiff'), target));
      }

      await Promise.allSettled(generations);
    } finally {
      inFlight.delete(key);
      if (pending.has(key)) {
        pending.delete(key);
        const queuedAttended = pendingAttended.delete(key);
        void runGeneration(ref, target, queuedAttended);
      }
    }
  };

  return {
    schedule(plan, target, options = {}) {
      const ref: PlanDiagramRef = {
        projectId: plan.projectId,
        worktreeId: plan.worktreeId,
        planId: plan.id,
      };
      const key = planKey(ref);

      const existingTimer = debounceTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
        debounceTimers.delete(key);
      }

      if (options.immediate) {
        const status = inFlight.has(key) ? 'queued' : 'started';
        void runGeneration(ref, target, options.attended === true);
        return status;
      }

      const timer = setTimeout(() => {
        debounceTimers.delete(key);
        void runGeneration(ref, target, false);
      }, DEBOUNCE_MS);
      debounceTimers.set(key, timer);
      return 'debounced';
    },
  };
}
