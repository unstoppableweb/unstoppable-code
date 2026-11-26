/**
 * Projects a pipeline's job graph into the workflow designer's vertical stack
 * (CAN-4224). The projection is pure and read-only: it never changes the
 * pipeline, and every job appears in it exactly once. Shapes the stack can't
 * lay out become groups, which carry every job and step in dependency layers,
 * so the designer shows and edits everything (CAN-4224 phase 08).
 */
import {
  getJobOrder,
  normalizeNeeds,
  type Job,
  type Pipeline,
  type Step,
} from './document';
import { readWorkflowSplit, routerLacksInput } from './workflow-designer-split';

/** Why a job, or a group of jobs, renders read-only. */
export type WorkflowStackUnsupportedReason =
  /** The job runs once per matrix combination. */
  | 'matrix'
  /** The job's condition is not one the stack can describe. */
  | 'condition'
  /**
   * The jobs' dependencies don't form a chain or a closed group, or the jobs
   * that branch have conditions the stack can't show (a router's routes, for
   * one, until CAN-4224 phase 03 draws them as paths).
   */
  | 'graph'
  /** The jobs depend on each other in a cycle, or on a missing job. */
  | 'invalid'
  /** The workflow is too large to project on the interface thread. */
  | 'size';

/** One step of a job, shown as a card. */
export interface WorkflowStackStepCard {
  readonly kind: 'step';
  readonly key: string;
  readonly jobId: string;
  readonly stepIndex: number;
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  /** Whether the step runs a shell script (`run:`). */
  readonly script: boolean;
  /** The step's own `if`, shown as written. */
  readonly condition?: string;
  /** The owning job's simple condition, shown on the job's first card. */
  readonly jobCondition?: string;
  /**
   * Set on the router of a split the stack draws as paths. Only the split's
   * own edits change it, its routes and its paths' guards together.
   */
  readonly split?: true;
}

/** A job with no steps yet. */
export interface WorkflowStackEmptyJob {
  readonly kind: 'empty-job';
  readonly key: string;
  readonly jobId: string;
  readonly name: string;
  readonly jobCondition?: string;
}

/** One column inside a parallel group. */
export interface WorkflowStackColumn {
  readonly key: string;
  /** The column's first job's name. */
  readonly label: string;
  readonly jobIds: readonly string[];
  readonly nodes: readonly WorkflowStackNode[];
}

/** Jobs that run at the same time and join before the stack continues. */
export interface WorkflowStackParallel {
  readonly kind: 'parallel';
  readonly key: string;
  readonly columns: readonly WorkflowStackColumn[];
}

/** One path of a split: a route and the job that runs when it's chosen. */
export interface WorkflowStackPath {
  readonly key: string;
  /** The route's label, which is also the router's answer. */
  readonly label: string;
  readonly jobId: string;
  readonly nodes: readonly WorkflowStackNode[];
}

/** A split's paths side by side. Nothing follows them. */
export interface WorkflowStackPaths {
  readonly kind: 'paths';
  readonly key: string;
  /** The job whose router step chooses the path. */
  readonly jobId: string;
  readonly routerStepIndex: number;
  readonly paths: readonly WorkflowStackPath[];
  /** The router has no input to decide on, so it would fail when it runs. */
  readonly missingInput: boolean;
}

/** A job in a group, with its steps (CAN-4224 phase 08). */
export interface WorkflowStackGroupJob {
  readonly jobId: string;
  /**
   * Its steps are a list of step mappings with text names, so the designer
   * edits them as it does any card, and its settings in the job's panel.
   */
  readonly editable: boolean;
  readonly name: string;
  /** The names of the jobs it waits for, as declared. */
  readonly after: readonly string[];
  /** Its own `if`, exactly as written. */
  readonly condition?: string;
  /** Its needs lead back to it, so the executor never runs it. */
  readonly cycle?: true;
  /** It runs once for each matrix combination. */
  readonly matrix?: true;
  /** Its `steps` isn't a list, so there are no steps to show. */
  readonly unreadableSteps?: true;
  /** Its steps as cards, or its empty-job card. */
  readonly nodes: readonly (WorkflowStackStepCard | WorkflowStackEmptyJob)[];
}

/**
 * Jobs the stack can't lay out as a chain, columns or paths: shown in
 * dependency layers, each job editable unless its steps can't be read.
 */
export interface WorkflowStackUnsupported {
  readonly kind: 'unsupported';
  readonly key: string;
  readonly jobIds: readonly string[];
  readonly jobNames: readonly string[];
  readonly reason: WorkflowStackUnsupportedReason;
  /**
   * The same jobs in dependency layers: a layer's jobs wait only on earlier
   * layers or on jobs before the group. Empty when the workflow is too large
   * to project.
   */
  readonly layers: readonly (readonly WorkflowStackGroupJob[])[];
}

export type WorkflowStackNode =
  | WorkflowStackStepCard
  | WorkflowStackEmptyJob
  | WorkflowStackParallel
  | WorkflowStackPaths
  | WorkflowStackUnsupported;

export interface WorkflowStack {
  readonly nodes: readonly WorkflowStackNode[];
}

const WRAPPED_EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/;

/** `${{ expr }}` → `expr`; a bare expression is returned trimmed. */
function expressionBody(value: string): string {
  const trimmed = value.trim();
  const match = WRAPPED_EXPRESSION.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * An authored condition as text. YAML can parse `if: false` as a boolean, or
 * an empty `if:` as null, so the value is not always a string at run time.
 * The executor reads an empty `if: ''` as no condition at all.
 */
function conditionText(value: unknown): string | undefined {
  if (value === '') return undefined;
  if (typeof value === 'string') return expressionBody(value);
  if (typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  return undefined;
}

// A quoted literal as the executor's tokenizer reads it: a backslash takes
// the next character as is, so `\'` doesn't end the string.
const QUOTED = String.raw`'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"`;
// The executor's tokenizer has no minus sign, so numbers are unsigned.
const LITERAL = String.raw`(?:${QUOTED}|true|false|\d+(?:\.\d+)?)`;
// The executor's expression tokenizer reads a property name as
// `[A-Za-z_][A-Za-z0-9_]*`, and reads `true`, `false` and `null` as literals.
const IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
// It skips whitespace between tokens, so `needs . build` is a property access.
const DOT = String.raw`\s*\.\s*`;

const SIMPLE_CONDITIONS: readonly RegExp[] = [
  /^(?:always|success|failure|cancelled)\(\)$/,
  /^(?:true|false)$/,
  new RegExp(String.raw`^inputs${DOT}${IDENTIFIER}\s*(?:==|!=)\s*${LITERAL}$`),
  new RegExp(
    String.raw`^needs${DOT}${IDENTIFIER}${DOT}result\s*(?:==|!=)\s*'[a-z_]+'$`,
  ),
];

/** A property access the executor rejects: a literal word after a dot. */
const RESERVED_PROPERTY = /\.\s*(?:true|false|null)(?![A-Za-z0-9_])/;

/** Longer conditions aren't simple, and aren't scanned further. */
const MAX_SIMPLE_CONDITION_LENGTH = 1000;

/**
 * `body` with each quoted literal replaced by `''`, read left to right as the
 * executor's tokenizer reads it (a backslash takes the next character), or
 * null when a literal is never closed. One pass, so linear in its length.
 */
function blankQuotedLiterals(body: string): string | null {
  let out = '';
  let index = 0;
  while (index < body.length) {
    const quote = body[index];
    if (quote !== "'" && quote !== '"') {
      out += quote;
      index += 1;
      continue;
    }
    index += 1;
    while (index < body.length && body[index] !== quote)
      index += body[index] === '\\' ? 2 : 1;
    if (index >= body.length) return null;
    out += "''";
    index += 1;
  }
  return out;
}

/** Whether a job `if` is one the stack shows as a plain condition line. */
function isSimpleCondition(body: string): boolean {
  if (body.length > MAX_SIMPLE_CONDITION_LENGTH) return false;
  // Quoted literals are text, not property access: `"report.true.json"`.
  const blanked = blankQuotedLiterals(body);
  return (
    blanked !== null &&
    !RESERVED_PROPERTY.test(blanked) &&
    SIMPLE_CONDITIONS.some((pattern) => pattern.test(body))
  );
}

/** Whether a job `if` is written as `${{ ... }}`, which the executor rejects. */
function isWrappedCondition(value: unknown): boolean {
  return typeof value === 'string' && WRAPPED_EXPRESSION.test(value.trim());
}

/** Whether a job sets its own `if`, which can run it after a skipped need. */
function hasOwnCondition(job: Job | undefined): boolean {
  return conditionText(job?.if) !== undefined;
}

/** Whether a job's own `if` is absent, or one the stack shows as a line. */
function hasShowableCondition(job: Job | undefined): boolean {
  if (isWrappedCondition(job?.if)) return false;
  const text = conditionText(job?.if);
  return text === undefined || isSimpleCondition(text);
}

/** Whether a list entry is a step mapping, as YAML can hold anything there. */
function isStepRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value the designer renders as text is text, or absent. */
function isTextOrAbsent(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** A job's name as text, falling back to its id when it has none. */
function jobNameOf(job: Job | undefined, jobId: string): string {
  const name: unknown = job?.name;
  return typeof name === 'string' ? name : jobId;
}

/**
 * A step's condition exactly as written; wrapped ones are refused earlier.
 * A blank one runs the step as no condition does, so it shows none.
 */
function stepCondition(step: Step): { condition?: string } {
  if (typeof step.if === 'string' && step.if.trim() === '') return {};
  const condition = conditionText(step.if);
  return condition === undefined ? {} : { condition };
}

/**
 * An authored condition exactly as written, `${{ }}` and all, so a read-only
 * card shows what the executor reads. A blank one is no condition.
 */
function authoredCondition(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'boolean' || typeof value === 'number')
    return String(value);
  return undefined;
}

/** A step mapping's field as text, when it is text. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A job's steps as read-only cards, whatever shape they're in: anything the
 * designer can read shows, and a step it can't is a card with no name.
 */
function readOnlyCards(
  job: Job | undefined,
  jobId: string,
): readonly (WorkflowStackStepCard | WorkflowStackEmptyJob)[] {
  const steps: unknown = job?.steps;
  if (!Array.isArray(steps)) return [];
  if (steps.length === 0)
    return [
      {
        kind: 'empty-job',
        key: `job:${jobId}`,
        jobId,
        name: jobNameOf(job, jobId),
      },
    ];
  return steps.map((step: unknown, stepIndex): WorkflowStackStepCard => {
    const record = isStepRecord(step) ? step : {};
    const id = textOf(record['id']);
    const name = textOf(record['name']);
    const uses = textOf(record['uses']);
    const condition = authoredCondition(record['if']);
    return {
      kind: 'step',
      key: `step:${jobId}:${String(stepIndex)}`,
      jobId,
      stepIndex,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(uses !== undefined ? { uses } : {}),
      script: record['run'] !== undefined,
      ...(condition !== undefined ? { condition } : {}),
    };
  });
}

/** A job's own needs, each once, keeping only names the workflow defines. */
function ownNeeds(pipeline: Pipeline, jobId: string): readonly string[] {
  return [...new Set(normalizeNeeds(pipeline.jobs[jobId]?.needs))].filter(
    (need) => Object.prototype.hasOwnProperty.call(pipeline.jobs, need),
  );
}

function groupJob(
  pipeline: Pipeline,
  jobId: string,
  cyclic: ReadonlySet<string>,
): WorkflowStackGroupJob {
  const job = pipeline.jobs[jobId];
  const condition = authoredCondition(job?.if);
  const steps: unknown = job?.steps;
  return {
    jobId,
    editable:
      isTextOrAbsent(job?.name) &&
      Array.isArray(steps) &&
      steps.every(
        (step: unknown) =>
          isStepRecord(step) &&
          isTextOrAbsent(step['uses']) &&
          isTextOrAbsent(step['name']) &&
          isTextOrAbsent(step['id']),
      ),
    name: jobNameOf(job, jobId),
    after: [...new Set(normalizeNeeds(job?.needs))].map((need) =>
      Object.prototype.hasOwnProperty.call(pipeline.jobs, need)
        ? jobNameOf(pipeline.jobs[need], need)
        : need,
    ),
    ...(condition !== undefined ? { condition } : {}),
    ...(cyclic.has(jobId) ? { cycle: true as const } : {}),
    ...(job?.strategy !== undefined ? { matrix: true as const } : {}),
    ...(Array.isArray(job?.steps) ? {} : { unreadableSteps: true as const }),
    nodes: readOnlyCards(job, jobId),
  };
}

/**
 * `jobIds` grouped into strongly connected components over the needs inside
 * the group (Tarjan's algorithm), each job mapped to its component's first
 * member, and the jobs whose needs lead back to themselves.
 */
function componentsOf(
  pipeline: Pipeline,
  jobIds: readonly string[],
): {
  readonly componentOf: ReadonlyMap<string, string>;
  readonly cyclic: ReadonlySet<string>;
} {
  const inGroup = new Set(jobIds);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentOf = new Map<string, string>();
  const cyclic = new Set<string>();
  const visit = (jobId: string): void => {
    index.set(jobId, index.size);
    low.set(jobId, index.get(jobId) ?? 0);
    stack.push(jobId);
    onStack.add(jobId);
    for (const need of ownNeeds(pipeline, jobId)) {
      if (!inGroup.has(need)) continue;
      if (need === jobId) cyclic.add(jobId);
      if (!index.has(need)) {
        visit(need);
        low.set(jobId, Math.min(low.get(jobId) ?? 0, low.get(need) ?? 0));
      } else if (onStack.has(need)) {
        low.set(jobId, Math.min(low.get(jobId) ?? 0, index.get(need) ?? 0));
      }
    }
    if (low.get(jobId) !== index.get(jobId)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === jobId) break;
    }
    for (const member of component) componentOf.set(member, jobId);
    if (component.length > 1)
      for (const member of component) cyclic.add(member);
  };
  for (const jobId of jobIds) if (!index.has(jobId)) visit(jobId);
  return { componentOf, cyclic };
}

/**
 * `jobIds` in dependency layers: a job sits one layer below the deepest of
 * its needs in the group, and a job whose needs are all outside the group is
 * in the first. A cycle's jobs share one layer, below every need that enters
 * the cycle, and are marked as a cycle rather than read as an order.
 */
function groupLayers(
  pipeline: Pipeline,
  jobIds: readonly string[],
): readonly (readonly WorkflowStackGroupJob[])[] {
  const { componentOf, cyclic } = componentsOf(pipeline, jobIds);
  const members = new Map<string, string[]>();
  for (const jobId of jobIds) {
    const component = componentOf.get(jobId) ?? jobId;
    members.set(component, [...(members.get(component) ?? []), jobId]);
  }
  // Components form no cycle among themselves, so this recursion ends.
  const depths = new Map<string, number>();
  const depthOf = (component: string): number => {
    const known = depths.get(component);
    if (known !== undefined) return known;
    let depth = 0;
    for (const member of members.get(component) ?? [])
      for (const need of ownNeeds(pipeline, member)) {
        const from = componentOf.get(need);
        if (from !== undefined && from !== component)
          depth = Math.max(depth, depthOf(from) + 1);
      }
    depths.set(component, depth);
    return depth;
  };
  const layers: WorkflowStackGroupJob[][] = [];
  for (const jobId of jobIds) {
    const depth = depthOf(componentOf.get(jobId) ?? jobId);
    while (layers.length <= depth) layers.push([]);
    layers[depth]?.push(groupJob(pipeline, jobId, cyclic));
  }
  return layers.filter((layer) => layer.length > 0);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

class StackBuilder {
  private readonly pipeline: Pipeline;
  private readonly jobs: Readonly<Record<string, Job>>;
  private readonly order: readonly string[];
  private readonly reducedNeeds = new Map<string, readonly string[]>();
  private readonly dependents = new Map<string, string[]>();
  private readonly placed = new Set<string>();
  /** Whether the stack stopped at a condition it can't show. */
  private stoppedAtCondition = false;

  constructor(pipeline: Pipeline, order: readonly string[]) {
    this.pipeline = pipeline;
    this.jobs = pipeline.jobs;
    this.order = order;
    // `implied` holds the jobs that must have succeeded for a job to run.
    // A job with its own `if` can run after a need was skipped, so it implies
    // nothing; a need is only dropped when another need implies it, which
    // keeps every need that still decides whether the job runs.
    const implied = new Map<string, ReadonlySet<string>>();
    for (const jobId of order) {
      const needs = this.needsOf(jobId);
      const all = new Set<string>();
      if (!hasOwnCondition(this.jobs[jobId])) {
        for (const need of needs) {
          all.add(need);
          for (const ancestor of implied.get(need) ?? []) all.add(ancestor);
        }
      }
      implied.set(jobId, all);
      // A job with its own `if` sees every need it declares (`failure()`
      // watches each one), so none of its needs is dropped.
      const reduced = hasOwnCondition(this.jobs[jobId])
        ? needs
        : needs.filter(
            (need) =>
              !needs.some(
                (other) =>
                  other !== need && (implied.get(other)?.has(need) ?? false),
              ),
          );
      this.reducedNeeds.set(jobId, reduced);
      for (const need of reduced) {
        const list = this.dependents.get(need) ?? [];
        list.push(jobId);
        this.dependents.set(need, list);
      }
    }
  }

  build(): WorkflowStack {
    const roots = this.order.filter(
      (jobId) => this.needsOf(jobId).length === 0,
    );
    const nodes: WorkflowStackNode[] = [];
    const [root] = roots;
    if (roots.length === 1 && root !== undefined) {
      nodes.push(...this.sequence(root).nodes);
    } else if (roots.length > 1 && this.canBranch(roots)) {
      const group = this.group(roots);
      if (group.join === null) {
        // Parallel branches that never rejoin aren't a shape the stack owns.
        this.restorePlaced(group.placedBefore);
      } else {
        nodes.push(group.node);
        nodes.push(...this.sequence(group.join).nodes);
      }
    }
    const rest = this.order.filter((jobId) => !this.placed.has(jobId));
    if (rest.length > 0)
      nodes.push(
        this.unsupported(rest, this.stoppedAtCondition ? 'condition' : 'graph'),
      );
    return { nodes };
  }

  /**
   * Whether `jobIds` can be drawn as columns side by side. A column job with a
   * condition the stack can't show, such as a router's route, may never run
   * alongside the others, so those jobs go to the read-only group instead.
   */
  private canBranch(jobIds: readonly string[]): boolean {
    return jobIds.every((jobId) => hasShowableCondition(this.jobs[jobId]));
  }

  private restorePlaced(snapshot: ReadonlySet<string>): void {
    this.placed.clear();
    for (const jobId of snapshot) this.placed.add(jobId);
  }

  /** A job's needs, each once: the executor reads a repeat as one need. */
  private needsOf(jobId: string): readonly string[] {
    return [...new Set(normalizeNeeds(this.jobs[jobId]?.needs))];
  }

  private reduced(jobId: string): readonly string[] {
    return this.reducedNeeds.get(jobId) ?? [];
  }

  private openDependents(jobId: string): readonly string[] {
    return (this.dependents.get(jobId) ?? []).filter(
      (dependent) => !this.placed.has(dependent),
    );
  }

  private nameOf(jobId: string): string {
    return jobNameOf(this.jobs[jobId], jobId);
  }

  private unsupported(
    jobIds: readonly string[],
    reason: WorkflowStackUnsupportedReason,
  ): WorkflowStackUnsupported {
    for (const jobId of jobIds) this.placed.add(jobId);
    return {
      kind: 'unsupported',
      key: `unsupported:${jobIds.join(',')}`,
      jobIds,
      jobNames: jobIds.map((jobId) => this.nameOf(jobId)),
      reason,
      layers: groupLayers(this.pipeline, jobIds),
    };
  }

  /**
   * Why the stack can't show a job's steps as cards, whatever its own `if`,
   * or null when it can.
   */
  private stepsProblem(jobId: string): WorkflowStackUnsupportedReason | null {
    const job = this.jobs[jobId];
    if (!job) return 'invalid';
    if (job.strategy !== undefined) return 'matrix';
    // YAML can hold other values where a list of steps or text belongs; the
    // designer can't name or render that job.
    if (
      !Array.isArray(job.steps) ||
      !isTextOrAbsent(job.name) ||
      job.steps.some(
        (step: unknown) =>
          !isStepRecord(step) ||
          !isTextOrAbsent(step.uses) ||
          !isTextOrAbsent(step.name) ||
          !isTextOrAbsent(step.id),
      )
    )
      return 'invalid';
    // The executor evaluates an `if` as written and rejects a `${{ }}`
    // wrapper, so a step's can't be shown as usable.
    if (job.steps.some((step) => isWrappedCondition(step.if)))
      return 'condition';
    return null;
  }

  /**
   * One job's cards, or a read-only group when the stack can't show it. A
   * path's job is `guarded`: its `if` is the split's route guard, which the
   * path's header shows instead.
   */
  private emitJob(jobId: string, guarded = false): WorkflowStackNode[] {
    const job = this.jobs[jobId];
    const problem = this.stepsProblem(jobId);
    if (!job || problem !== null)
      return [this.unsupported([jobId], problem ?? 'invalid')];
    if (!guarded && isWrappedCondition(job.if))
      return [this.unsupported([jobId], 'condition')];
    let jobCondition: string | undefined;
    const jobIf = guarded ? undefined : conditionText(job.if);
    if (jobIf !== undefined) {
      if (!isSimpleCondition(jobIf))
        return [this.unsupported([jobId], 'condition')];
      jobCondition = jobIf;
    }
    this.placed.add(jobId);
    if (job.steps.length === 0) {
      return [
        {
          kind: 'empty-job',
          key: `job:${jobId}`,
          jobId,
          name: this.nameOf(jobId),
          ...(jobCondition !== undefined ? { jobCondition } : {}),
        },
      ];
    }
    return job.steps.map(
      (step: Step, stepIndex): WorkflowStackStepCard => ({
        kind: 'step',
        key: `step:${jobId}:${String(stepIndex)}`,
        jobId,
        stepIndex,
        ...(step.id !== undefined ? { id: step.id } : {}),
        ...(step.name !== undefined ? { name: step.name } : {}),
        ...(step.uses !== undefined ? { uses: step.uses } : {}),
        script: step.run !== undefined,
        ...stepCondition(step),
        ...(stepIndex === 0 && jobCondition !== undefined
          ? { jobCondition }
          : {}),
      }),
    );
  }

  /**
   * Follows a column from `start`: chains continue it, and closed parallel
   * groups nest inside it. Returns the job the column ends on.
   */
  private sequence(start: string): { nodes: WorkflowStackNode[]; end: string } {
    const nodes: WorkflowStackNode[] = [];
    let current = start;
    let previous = start;
    for (;;) {
      // A job whose own condition the stack can't show, such as a router's
      // route guard, decides whether everything after it runs too. It and
      // its dependents go to the read-only group together.
      if (!hasShowableCondition(this.jobs[current])) {
        this.stoppedAtCondition = true;
        return { nodes, end: previous };
      }
      const cards = this.emitJob(current);
      nodes.push(...cards);
      previous = current;
      const paths = cards.some((card) => card.kind === 'unsupported')
        ? null
        : this.paths(current);
      if (paths !== null) {
        const routerKey = `step:${current}:${String(paths.routerStepIndex)}`;
        for (const [index, card] of nodes.entries())
          if (card.kind === 'step' && card.key === routerKey)
            nodes[index] = { ...card, split: true };
        nodes.push(paths);
        return { nodes, end: current };
      }
      const dependents = this.openDependents(current);
      if (dependents.length === 0) return { nodes, end: current };
      const from = current;
      const pure = dependents.every((dependent) =>
        sameSet(this.reduced(dependent), [from]),
      );
      if (!pure) return { nodes, end: current };
      const [only] = dependents;
      if (dependents.length === 1 && only !== undefined) {
        current = only;
        continue;
      }
      if (!this.canBranch(dependents)) return { nodes, end: current };
      const group = this.group(dependents);
      if (group.join === null) {
        // Parallel branches that never rejoin aren't a shape the stack owns;
        // they go to the read-only group.
        this.restorePlaced(group.placedBefore);
        return { nodes, end: current };
      }
      nodes.push(group.node);
      current = group.join;
    }
  }

  /**
   * The split that ends `jobId` as a paths node, or null when its jobs
   * aren't the shape the designer draws as paths.
   */
  private paths(jobId: string): WorkflowStackPaths | null {
    const split = readWorkflowSplit(this.pipeline, jobId);
    if (split === null) return null;
    if (
      split.paths.some(
        (path) =>
          this.placed.has(path.jobId) || this.stepsProblem(path.jobId) !== null,
      )
    )
      return null;
    const routerStep = this.jobs[jobId]?.steps[split.routerStepIndex];
    if (!routerStep) return null;
    return {
      kind: 'paths',
      key: `paths:${jobId}`,
      jobId,
      routerStepIndex: split.routerStepIndex,
      missingInput: routerLacksInput(routerStep),
      paths: split.paths.map((path) => ({
        key: `path:${path.jobId}`,
        label: path.label,
        jobId: path.jobId,
        nodes: this.emitJob(path.jobId, true),
      })),
    };
  }

  /**
   * Builds a parallel group from `starts`, one column each, and finds the job
   * that joins every column.
   */
  private group(starts: readonly string[]): {
    node: WorkflowStackParallel;
    join: string | null;
    /** Jobs placed before the group, to undo it when it can't be shown. */
    placedBefore: ReadonlySet<string>;
  } {
    const placedBefore = new Set(this.placed);
    const columns: WorkflowStackColumn[] = [];
    const ends: string[] = [];
    for (const start of starts) {
      const before = new Set(this.placed);
      const column = this.sequence(start);
      columns.push({
        key: `column:${start}`,
        label: this.nameOf(start),
        jobIds: [...this.placed].filter((jobId) => !before.has(jobId)),
        nodes: column.nodes,
      });
      ends.push(column.end);
    }
    // The group closes only when exactly one job follows it, and that job
    // needs every column's end. Anything else is shown read-only after it.
    const endSet = new Set(ends);
    const followers = this.order.filter(
      (jobId) =>
        !this.placed.has(jobId) &&
        this.reduced(jobId).some((need) => endSet.has(need)),
    );
    const [join] = followers;
    return {
      node: { kind: 'parallel', key: `parallel:${starts.join(',')}`, columns },
      placedBefore,
      join:
        followers.length === 1 &&
        join !== undefined &&
        sameSet(this.reduced(join), ends)
          ? join
          : null,
    };
  }
}

/**
 * The jobs in dependency order, or null when the jobs depend on each other in
 * a cycle or on a job the workflow doesn't define. Every need must be one of
 * the workflow's own jobs: a name such as `constructor` would otherwise
 * resolve an inherited object property.
 */
function jobOrderOf(pipeline: Pipeline): string[] | null {
  const known = (need: string): boolean =>
    Object.prototype.hasOwnProperty.call(pipeline.jobs, need);
  const allKnown = Object.values(pipeline.jobs).every((job) =>
    normalizeNeeds(job.needs).every(known),
  );
  if (!allKnown) return null;
  try {
    return getJobOrder(pipeline);
  } catch {
    return null;
  }
}

/** Larger workflows show as one read-only group instead of being projected. */
const MAX_PROJECTED_JOBS = 400;
const MAX_PROJECTED_NEEDS = 4000;
const MAX_PROJECTED_STEPS = 4000;
const MAX_PROJECTED_OUTPUTS = 4000;

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === 'object' && value !== null
    ? Object.keys(value).length
    : 0;
}

/** Whether the workflow is within the sizes the projection walks. */
function withinProjectionBudget(pipeline: Pipeline): boolean {
  const jobs = Object.values(pipeline.jobs);
  if (jobs.length > MAX_PROJECTED_JOBS) return false;
  let needs = 0;
  let steps = 0;
  let outputs = 0;
  for (const job of jobs) {
    needs += normalizeNeeds(job.needs).length;
    steps += countOf(job.steps);
    outputs += countOf(job.outputs);
  }
  return (
    needs <= MAX_PROJECTED_NEEDS &&
    steps <= MAX_PROJECTED_STEPS &&
    outputs <= MAX_PROJECTED_OUTPUTS
  );
}

/**
 * Projects `pipeline` into the designer's stack. Never mutates its input;
 * every job appears exactly once, in a card, a column, or an unsupported group.
 */
export function projectWorkflowStack(pipeline: Pipeline): WorkflowStack {
  const allJobIds = Object.keys(pipeline.jobs);
  if (!withinProjectionBudget(pipeline)) {
    return {
      nodes: [
        {
          kind: 'unsupported',
          key: 'unsupported:size',
          jobIds: allJobIds,
          jobNames: allJobIds.map((jobId) =>
            jobNameOf(pipeline.jobs[jobId], jobId),
          ),
          reason: 'size',
          layers: [],
        },
      ],
    };
  }
  const order = jobOrderOf(pipeline);
  if (order === null) {
    if (allJobIds.length === 0) return { nodes: [] };
    return {
      nodes: [
        {
          kind: 'unsupported',
          key: `unsupported:${allJobIds.join(',')}`,
          jobIds: allJobIds,
          jobNames: allJobIds.map((jobId) =>
            jobNameOf(pipeline.jobs[jobId], jobId),
          ),
          reason: 'invalid',
          layers: groupLayers(pipeline, allJobIds),
        },
      ],
    };
  }
  return new StackBuilder(pipeline, order).build();
}

/**
 * What a stack lets a host edit: `step:<job>:<index>` for each step card and
 * `job:<job>` for the job of any card, whose settings panel stays open
 * wherever an edit moves it. A group job whose steps can't be read is
 * absent, so a host can refuse to edit it through its details panel.
 */
export function workflowStackEditableKeys(
  stack: WorkflowStack,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (nodes: readonly WorkflowStackNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'step' || node.kind === 'empty-job') {
        keys.add(node.key);
        // Its settings stay open wherever an edit moves the job.
        keys.add(`job:${node.jobId}`);
      } else if (node.kind === 'parallel')
        for (const column of node.columns) visit(column.nodes);
      else if (node.kind === 'paths')
        for (const path of node.paths) visit(path.nodes);
      else if (node.kind === 'unsupported')
        for (const layer of node.layers)
          for (const job of layer)
            if (job.editable) {
              keys.add(`job:${job.jobId}`);
              visit(job.nodes);
            }
    }
  };
  visit(stack.nodes);
  return keys;
}

/** The jobs a stack lays out in groups rather than as a chain or columns. */
export function workflowStackGroupJobs(
  stack: WorkflowStack,
): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (nodes: readonly WorkflowStackNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'unsupported')
        for (const jobId of node.jobIds) found.add(jobId);
      else if (node.kind === 'parallel')
        for (const column of node.columns) visit(column.nodes);
    }
  };
  visit(stack.nodes);
  return found;
}

/** The paths node a stack draws for the split ending `jobId`, if any. */
export function workflowStackPathsOf(
  stack: WorkflowStack,
  jobId: string,
): WorkflowStackPaths | null {
  const visit = (
    nodes: readonly WorkflowStackNode[],
  ): WorkflowStackPaths | null => {
    for (const node of nodes) {
      if (node.kind === 'paths' && node.jobId === jobId) return node;
      if (node.kind === 'parallel')
        for (const column of node.columns) {
          const found = visit(column.nodes);
          if (found) return found;
        }
    }
    return null;
  };
  return visit(stack.nodes);
}

/** The jobs a stack's drawn splits run as paths. */
export function workflowStackPathJobs(
  stack: WorkflowStack,
): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (nodes: readonly WorkflowStackNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'paths')
        for (const path of node.paths) found.add(path.jobId);
      else if (node.kind === 'parallel')
        for (const column of node.columns) visit(column.nodes);
    }
  };
  visit(stack.nodes);
  return found;
}
