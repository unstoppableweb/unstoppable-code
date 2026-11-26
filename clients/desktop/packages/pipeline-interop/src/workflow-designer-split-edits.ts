/**
 * The workflow designer's split edits (CAN-4224 phase 03). Each one writes
 * the split shape `readWorkflowSplit` reads, and changes the router's routes
 * and its paths' guards together. Step edits go through the designer's step
 * check, so a step that reads the router refuses the edit.
 */
import { normalizeNeeds, type Job, type Pipeline, type Step } from './document';
import { assignStepIds } from './normalize-pipeline';
import {
  projectWorkflowStack,
  workflowStackEditableKeys,
  workflowStackGroupJobs,
  workflowStackPathJobs,
  workflowStackPathsOf,
  type WorkflowStack,
} from './workflow-designer';
import {
  dependencyStepIds,
  insertWorkflowStep,
  literalWithKeys,
  newWorkflowStepId,
  removeWorkflowStep,
  type WorkflowDesignerEditResult,
  type WorkflowDesignerReader,
} from './workflow-designer-edits';
import {
  isExpressionIdentifier,
  readWorkflowSplit,
  routeGuard,
  routeOutputTemplate,
  routesInput,
  SPLIT_ROUTER_USES,
  workflowPathLabelProblem,
  type WorkflowSplit,
} from './workflow-designer-split';

const NOT_EDITABLE: WorkflowDesignerEditResult = {
  ok: false,
  refusal: { kind: 'not-editable' },
};

/**
 * `edited`, if the stack still draws the split at `jobId` as paths. A split
 * or a new path can take the workflow past the sizes the stack projects,
 * which would leave the split with no controls right after it applied.
 */
function drawn(
  edited: Pipeline,
  jobId: string,
  stepIndex?: number,
): WorkflowDesignerEditResult {
  if (workflowStackPathsOf(projectWorkflowStack(edited), jobId) === null)
    return { ok: false, refusal: { kind: 'too-large' } };
  return {
    ok: true,
    pipeline: edited,
    ...(stepIndex !== undefined ? { stepIndex } : {}),
  };
}

/** `base`, or `base_2`, `base_3`…: the first that `taken` doesn't hold. */
function freeName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) {
    const name = `${base}_${String(n)}`;
    if (!taken(name)) return name;
  }
}

function hasJob(pipeline: Pipeline, jobId: string): boolean {
  return Object.prototype.hasOwnProperty.call(pipeline.jobs, jobId);
}

/** `Path N` for the first N from `from` that no label holds. */
function freeLabel(labels: readonly string[], from: number): string {
  for (let n = from; ; n += 1) {
    const label = `Path ${String(n)}`;
    if (workflowPathLabelProblem(label, labels) === null) return label;
  }
}

function pathJob(jobId: string, key: string, label: string): Job {
  return {
    name: label,
    needs: [jobId],
    if: routeGuard(jobId, key, label),
    steps: [],
  };
}

/**
 * The jobs a split may end, from one projection: shown as cards, ending
 * the stack (nothing needs them, so no job or step moves), and not a path,
 * since the stack can't draw a split inside a path.
 */
export function splittableWorkflowJobs(
  pipeline: Pipeline,
  stack: WorkflowStack = projectWorkflowStack(pipeline),
): ReadonlySet<string> {
  const needed = new Set<string>();
  for (const job of Object.values(pipeline.jobs))
    for (const need of normalizeNeeds(job.needs)) needed.add(need);
  const paths = workflowStackPathJobs(stack);
  // A group job's split couldn't be drawn as paths, so it isn't offered.
  const grouped = workflowStackGroupJobs(stack);
  const splittable = new Set<string>();
  for (const key of workflowStackEditableKeys(stack)) {
    const jobId = /^(?:step|job):([^:]+)/.exec(key)?.[1];
    if (
      jobId !== undefined &&
      isExpressionIdentifier(jobId) &&
      !needed.has(jobId) &&
      !paths.has(jobId) &&
      !grouped.has(jobId)
    )
      splittable.add(jobId);
  }
  return splittable;
}

export function canSplitWorkflowJob(
  pipeline: Pipeline,
  jobId: string,
): boolean {
  return splittableWorkflowJobs(pipeline).has(jobId);
}

/**
 * Adds a router as the last step of `jobId` and two empty paths after it.
 * The router's step is selected, to choose what it decides on.
 */
export function splitWorkflowJob(
  pipeline: Pipeline,
  jobId: string,
): WorkflowDesignerEditResult {
  const job = pipeline.jobs[jobId];
  if (!job || !canSplitWorkflowJob(pipeline, jobId)) return NOT_EDITABLE;
  const labels = ['Path 1', 'Path 2'];
  const routerId = newWorkflowStepId(pipeline, jobId, 'split');
  const router: Step = {
    id: routerId,
    name: 'Split into paths',
    uses: SPLIT_ROUTER_USES,
    with: { text: '', routes: routesInput(labels) },
  };
  const inserted = insertWorkflowStep(
    pipeline,
    jobId,
    job.steps.length,
    router,
  );
  if (!inserted.ok) return inserted;
  const withRouter = inserted.pipeline.jobs[jobId];
  if (!withRouter) return NOT_EDITABLE;
  const outputs = withRouter.outputs ?? {};
  const key = freeName('route', (name) =>
    Object.prototype.hasOwnProperty.call(outputs, name),
  );
  const jobs: Record<string, Job> = {
    ...inserted.pipeline.jobs,
    [jobId]: {
      ...withRouter,
      outputs: { ...outputs, [key]: routeOutputTemplate(routerId) },
    },
  };
  for (const label of labels) {
    const pathId = freeName('path', (name) =>
      Object.prototype.hasOwnProperty.call(jobs, name),
    );
    jobs[pathId] = pathJob(jobId, key, label);
  }
  return drawn({ ...inserted.pipeline, jobs }, jobId, inserted.stepIndex);
}

/**
 * The split at `jobId` and its router step, when the stack draws it as
 * paths: a split whose jobs the stack shows read-only is never edited.
 */
function editableSplit(
  pipeline: Pipeline,
  jobId: string,
): { readonly split: WorkflowSplit; readonly router: Step } | null {
  if (workflowStackPathsOf(projectWorkflowStack(pipeline), jobId) === null)
    return null;
  const split = readWorkflowSplit(pipeline, jobId);
  const router = split
    ? pipeline.jobs[jobId]?.steps[split.routerStepIndex]
    : undefined;
  return split && router ? { split, router } : null;
}

/** `pipeline` with the router's routes set to `labels`. */
function withRoutes(
  pipeline: Pipeline,
  split: WorkflowSplit,
  router: Step,
  labels: readonly string[],
): Record<string, Job> {
  const job = pipeline.jobs[split.jobId];
  if (!job) return { ...pipeline.jobs };
  const steps = [...job.steps];
  steps[split.routerStepIndex] = {
    ...router,
    with: { ...router.with, routes: routesInput(labels) },
  };
  return { ...pipeline.jobs, [split.jobId]: { ...job, steps } };
}

/** Adds a path, named `Path N`, after the split's last path. */
export function addWorkflowPath(
  pipeline: Pipeline,
  jobId: string,
): WorkflowDesignerEditResult {
  const found = editableSplit(pipeline, jobId);
  if (!found) return NOT_EDITABLE;
  const { split, router } = found;
  const labels = split.paths.map((path) => path.label);
  const label = freeLabel(labels, labels.length + 1);
  const jobs = withRoutes(pipeline, split, router, [...labels, label]);
  const pathId = freeName('path', (name) =>
    hasJob({ ...pipeline, jobs }, name),
  );
  jobs[pathId] = pathJob(jobId, split.outputKey, label);
  return drawn({ ...pipeline, jobs }, jobId);
}

const NEEDS = /(?<![A-Za-z0-9_])needs(?![A-Za-z0-9_])/;
const STEPS = /(?<![A-Za-z0-9_])steps(?![A-Za-z0-9_])/;

/**
 * Whether a kept path reads `needs`, in a step's `if` or any `${{ }}`: its
 * only need is the router's job, whose route output Remove split removes.
 */
function readsNeeds(job: Job): boolean {
  const unguarded: Job = { ...job };
  delete unguarded.if;
  return reads(unguarded, NEEDS);
}

/**
 * The texts a template in `text` could read, as pieces: from each `${{` to
 * the next `${{` or the first `}}` after it, on one line or across lines.
 * A read holds no `${{`, so every read a template could make lies whole in
 * one piece, whatever opener the executor starts from, and the pieces never
 * overlap, so the scan and the pieces are linear in the text's length.
 */
function templateBodies(text: string): readonly string[] {
  const bodies: string[] = [];
  let close = text.indexOf('}}');
  let open = text.indexOf('${{');
  while (open !== -1 && close !== -1) {
    while (close !== -1 && close < open + 3)
      close = text.indexOf('}}', close + 1);
    if (close === -1) break;
    const next = text.indexOf('${{', open + 3);
    const end = next !== -1 && next < close ? next : close;
    bodies.push(text.slice(open + 3, end));
    open = next;
  }
  return bodies;
}

/**
 * Whether `value` (a job, a step, or one value) reads `context`, in the
 * job's or a step's `if`, which the executor evaluates as an expression, or
 * in any `${{ }}`. Another field named `if`, such as an environment
 * variable, is text like any other. `context` is a pattern, or a test given
 * each expression's text.
 */
export function reads(
  value: unknown,
  context: RegExp | ((expression: string, condition: boolean) => boolean),
): boolean {
  // `condition` marks a whole `if` expression, rather than a template piece.
  const test = (text: string, condition = false): boolean =>
    typeof context === 'function'
      ? context(text, condition)
      : context.test(text);
  // `holder` marks a job or a step, whose own `if` is an expression.
  const visit = (item: unknown, holder: boolean): boolean => {
    if (typeof item === 'string')
      return templateBodies(item).some((body) => test(body));
    if (Array.isArray(item)) return item.some((entry) => visit(entry, false));
    if (typeof item === 'object' && item !== null) {
      // A send step's literal text is passed on as written, never read.
      const literal = holder ? literalWithKeys(item) : new Set<string>();
      return Object.entries(item).some(([field, entry]: [string, unknown]) => {
        if (holder && field === 'if' && typeof entry === 'string')
          return test(entry, true);
        if (holder && field === 'steps' && Array.isArray(entry))
          return entry.some((step) => visit(step, true));
        if (
          field === 'with' &&
          literal.size > 0 &&
          typeof entry === 'object' &&
          entry !== null
        )
          return Object.entries(entry).some(
            ([key, value]: [string, unknown]) =>
              !literal.has(key) && visit(value, false),
          );
        return visit(entry, false);
      });
    }
    return false;
  };
  return visit(value, true);
}

/**
 * Who reads what the split chose, by a label that renaming or removing a
 * path changes: a step after the router or another of its job's outputs
 * that reads `steps`, or a kept path that reads `needs`. `removing` names a
 * path whose own reads go with it.
 */
function routeReader(
  pipeline: Pipeline,
  split: WorkflowSplit,
  removing?: string,
): WorkflowDesignerReader | null {
  const steps = pipeline.jobs[split.jobId]?.steps ?? [];
  for (
    let index = split.routerStepIndex + 1;
    index < steps.length;
    index += 1
  ) {
    const step = steps[index];
    if (step && reads(step, STEPS))
      return {
        kind: 'step',
        stepIndex: index,
        ...(typeof step.name === 'string' ? { name: step.name } : {}),
        ...(typeof step.id === 'string' && step.id !== ''
          ? { id: step.id }
          : {}),
      };
  }
  // Published to a caller when another workflow runs this one.
  for (const [key, value] of Object.entries(
    pipeline.jobs[split.jobId]?.outputs ?? {},
  ))
    if (key !== split.outputKey && reads(value, STEPS))
      return { kind: 'output', key };
  for (const path of split.paths) {
    if (path.jobId === removing) continue;
    const job = pipeline.jobs[path.jobId];
    if (job && readsNeeds(job)) return { kind: 'path', label: path.label };
  }
  return null;
}

/** Renames a path: its route, its guard, and its job's name if it showed it. */
export function renameWorkflowPath(
  pipeline: Pipeline,
  jobId: string,
  pathJobId: string,
  label: string,
): WorkflowDesignerEditResult {
  const found = editableSplit(pipeline, jobId);
  if (!found) return NOT_EDITABLE;
  const { split, router } = found;
  const index = split.paths.findIndex((path) => path.jobId === pathJobId);
  const current = split.paths[index];
  const job = pipeline.jobs[pathJobId];
  if (!current || !job) return NOT_EDITABLE;
  if (label === current.label) return { ok: true, pipeline };
  const others = split.paths
    .filter((path) => path.jobId !== pathJobId)
    .map((path) => path.label);
  const problem = workflowPathLabelProblem(label, others);
  if (problem !== null)
    return { ok: false, refusal: { kind: 'path-label', problem } };
  // The designer never rewrites an expression: one that compares the
  // route with the old label would stop matching.
  const reader = routeReader(pipeline, split);
  if (reader !== null) return { ok: false, refusal: { kind: 'reads', reader } };
  const labels = split.paths.map((path) =>
    path.jobId === pathJobId ? label : path.label,
  );
  const jobs = withRoutes(pipeline, split, router, labels);
  const name: unknown = job.name;
  jobs[pathJobId] = {
    ...job,
    ...(name === undefined || name === current.label ? { name: label } : {}),
    if: routeGuard(jobId, split.outputKey, label),
  };
  return { ok: true, pipeline: { ...pipeline, jobs } };
}

/**
 * A manifest dependency that names a step of a job `removed` holds, which
 * would no longer resolve; null when none does.
 */
function removedDependency(
  pipeline: Pipeline,
  removed: ReadonlySet<string>,
): string | null {
  const named = dependencyStepIds(pipeline);
  if (named.length === 0) return null;
  const gone = new Set<string>();
  for (const jobId of removed) {
    const job = pipeline.jobs[jobId];
    if (!job || !Array.isArray(job.steps)) continue;
    try {
      for (const step of assignStepIds(job.steps, jobId)) gone.add(step.id);
    } catch {
      // Steps the executor can't number: count every name as gone.
      return named[0]?.dependency ?? null;
    }
  }
  return named.find(({ stepId }) => gone.has(stepId))?.dependency ?? null;
}

function withoutJobs(
  jobs: Readonly<Record<string, Job>>,
  remove: ReadonlySet<string>,
): Record<string, Job> {
  return Object.fromEntries(
    Object.entries(jobs).filter(([id]) => !remove.has(id)),
  );
}

/** Removes a path's job and its route. A split keeps two paths or more. */
export function removeWorkflowPath(
  pipeline: Pipeline,
  jobId: string,
  pathJobId: string,
): WorkflowDesignerEditResult {
  const found = editableSplit(pipeline, jobId);
  if (!found) return NOT_EDITABLE;
  const { split, router } = found;
  if (!split.paths.some((path) => path.jobId === pathJobId))
    return NOT_EDITABLE;
  if (split.paths.length <= 2)
    return { ok: false, refusal: { kind: 'too-few-paths' } };
  // A step that compares the route with the removed label would never run.
  const reader = routeReader(pipeline, split, pathJobId);
  if (reader !== null) return { ok: false, refusal: { kind: 'reads', reader } };
  const dependency = removedDependency(pipeline, new Set([pathJobId]));
  if (dependency !== null)
    return {
      ok: false,
      refusal: {
        kind: 'reads',
        reader: { kind: 'dependency', id: dependency },
      },
    };
  const labels = split.paths
    .filter((path) => path.jobId !== pathJobId)
    .map((path) => path.label);
  const jobs = withoutJobs(
    withRoutes(pipeline, split, router, labels),
    new Set([pathJobId]),
  );
  return { ok: true, pipeline: { ...pipeline, jobs } };
}

/**
 * Removes the router, its output and its paths. `keep` names a path whose
 * job stays, without its guard, to run after `jobId` as before the split.
 */
export function removeWorkflowSplit(
  pipeline: Pipeline,
  jobId: string,
  keep?: string,
): WorkflowDesignerEditResult {
  const found = editableSplit(pipeline, jobId);
  const job = pipeline.jobs[jobId];
  if (!found || !job) return NOT_EDITABLE;
  const { split } = found;
  const kept = split.paths.find((path) => path.jobId === keep);
  if (keep !== undefined && kept === undefined) return NOT_EDITABLE;
  const keptJob = kept ? pipeline.jobs[kept.jobId] : undefined;
  // The kept path's only need is this job, whose route output goes.
  if (kept && keptJob && readsNeeds(keptJob))
    return {
      ok: false,
      refusal: { kind: 'reads', reader: { kind: 'path', label: kept.label } },
    };
  const dependency = removedDependency(
    pipeline,
    new Set(split.paths.map((path) => path.jobId).filter((id) => id !== keep)),
  );
  if (dependency !== null)
    return {
      ok: false,
      refusal: {
        kind: 'reads',
        reader: { kind: 'dependency', id: dependency },
      },
    };
  // The output goes first: it reads the router, which the step check would
  // otherwise refuse to remove.
  const outputs = Object.fromEntries(
    Object.entries(job.outputs ?? {}).filter(
      ([key]) => key !== split.outputKey,
    ),
  );
  const edited: Job = { ...job, outputs };
  // A job the split gave its only output goes back to having none.
  if (Object.keys(outputs).length === 0) delete edited.outputs;
  const withoutOutput: Pipeline = {
    ...pipeline,
    jobs: { ...pipeline.jobs, [jobId]: edited },
  };
  const removed = removeWorkflowStep(
    withoutOutput,
    jobId,
    split.routerStepIndex,
  );
  if (!removed.ok) return removed;
  const jobs = withoutJobs(
    removed.pipeline.jobs,
    new Set(split.paths.map((path) => path.jobId).filter((id) => id !== keep)),
  );
  const keptAfter = keep === undefined ? undefined : jobs[keep];
  if (keep !== undefined && keptAfter) {
    const unguarded: Job = { ...keptAfter };
    delete unguarded.if;
    jobs[keep] = unguarded;
  }
  return { ok: true, pipeline: { ...removed.pipeline, jobs } };
}
