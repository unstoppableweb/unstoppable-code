/**
 * The one split shape the workflow designer draws as paths and edits
 * (CAN-4224 phase 03). The designer writes exactly this YAML, and reads back
 * only this YAML, comparing it as text, so it never predicts how the
 * executor would run some other shape:
 *
 * ```yaml
 * J:
 *   steps:
 *     - id: split
 *       uses: builtin/router
 *       with: { text: '…', routes: '["Path 1","Path 2"]' }
 *   outputs:
 *     route: ${{ steps.split.outputs.route }}
 * path_1:
 *   needs: [J]
 *   if: success() && needs.J.outputs.route == 'Path 1'
 * ```
 *
 * A job with an `if` gets no implicit `success()` from the executor, so the
 * guard says it, and a failed `J` runs no path.
 */
import { normalizeNeeds, type Job, type Pipeline, type Step } from './document';
import { parseRouterRoutes } from './router-step';

export const SPLIT_ROUTER_USES = 'builtin/router';

/** Path labels longer than this are refused. */
export const MAX_PATH_LABEL_LENGTH = 60;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Words the executor's expression tokenizer reads as literals, not names. */
const LITERAL_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'null']);

/**
 * Whether `value` can follow a dot in an expression: `needs.<value>`. The
 * executor reads `true`, `false` and `null` as literals even there.
 */
export function isExpressionIdentifier(value: string): boolean {
  return IDENTIFIER.test(value) && !LITERAL_WORDS.has(value);
}

/** The job output that publishes the router's choice. */
export function routeOutputTemplate(routerId: string): string {
  return `\${{ steps.${routerId}.outputs.route }}`;
}

/** The condition on a path's job: the router's job succeeded and chose it. */
export function routeGuard(jobId: string, key: string, label: string): string {
  return `success() && needs.${jobId}.outputs.${key} == '${label}'`;
}

/** The router's `routes` input as the designer writes it. */
export function routesInput(labels: readonly string[]): string {
  return JSON.stringify(labels);
}

const ROUTE_OUTPUT =
  /^\$\{\{ steps\.([A-Za-z_][A-Za-z0-9_]*)\.outputs\.route \}\}$/;
const GUARD =
  /^success\(\) && needs\.([A-Za-z_][A-Za-z0-9_]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*) == '([^'\\]*)'$/;

export type WorkflowPathLabelProblem =
  | 'empty'
  | 'too-long'
  | 'characters'
  | 'duplicate';

/**
 * Why `label` can't be written as a route, whatever the other paths: it is
 * trimmed, at most `MAX_PATH_LABEL_LENGTH` long, and free of quotes,
 * backslashes, control characters, `${{`, which the router's input would
 * evaluate, and runs of whitespace, which it collapses, so the route it
 * publishes is the guard's literal as written.
 */
function labelTextProblem(label: string): WorkflowPathLabelProblem | null {
  if (label.trim() === '') return 'empty';
  if (label.length > MAX_PATH_LABEL_LENGTH) return 'too-long';
  const control = [...label].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    label !== label.trim() ||
    control ||
    /['"\\]/.test(label) ||
    label.includes('${{') ||
    // The router normalizes whitespace in the route it publishes, so only
    // single plain spaces survive as written.
    /\s{2}|[^\S ]/.test(label)
  )
    return 'characters';
  return null;
}

/**
 * Why `label` can't name a path beside `others`, or null. A label is the
 * router's route and the guard's quoted literal, and differs from the other
 * paths' ignoring case.
 */
export function workflowPathLabelProblem(
  label: string,
  others: readonly string[],
): WorkflowPathLabelProblem | null {
  const problem = labelTextProblem(label);
  if (problem !== null) return problem;
  const folded = label.toLowerCase();
  if (others.some((other) => other.toLowerCase() === folded))
    return 'duplicate';
  return null;
}

/** One path of a split: its route label and the job that runs it. */
export interface WorkflowSplitPath {
  readonly label: string;
  readonly jobId: string;
}

/** A split the designer recognizes at the end of job `jobId`. */
export interface WorkflowSplit {
  readonly jobId: string;
  readonly routerStepIndex: number;
  readonly routerId: string;
  /** The job output the paths' guards read. */
  readonly outputKey: string;
  /** In the router's route order. */
  readonly paths: readonly WorkflowSplitPath[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** For each job, the jobs that list it in their `needs`, in one pass. */
function dependentsByJob(pipeline: Pipeline): ReadonlyMap<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const [id, job] of Object.entries(pipeline.jobs))
    for (const need of new Set(normalizeNeeds(job.needs))) {
      const list = dependents.get(need) ?? [];
      list.push(id);
      dependents.set(need, list);
    }
  return dependents;
}

/**
 * The route labels the router at `step` offers, as the designer writes them,
 * when there are `count` of them. Checked in one pass, so a long `routes`
 * costs no more than reading it.
 */
function routerLabels(step: Step, count: number): readonly string[] | null {
  const input: unknown = step.with;
  if (!isRecord(input)) return null;
  const raw = input.routes;
  if (typeof raw !== 'string') return null;
  let labels: string[];
  try {
    labels = parseRouterRoutes(raw);
  } catch {
    return null;
  }
  if (labels.length !== count || labels.length < 2) return null;
  // Only the designer's own form: a JSON array, written as it writes it.
  if (routesInput(labels) !== raw) return null;
  const seen = new Set<string>();
  for (const label of labels) {
    const folded = label.toLowerCase();
    if (labelTextProblem(label) !== null || seen.has(folded)) return null;
    seen.add(folded);
  }
  return labels;
}

/**
 * The split that ends job `jobId`, or null when the job and the jobs after
 * it aren't exactly the shape the designer writes.
 */
export function readWorkflowSplit(
  pipeline: Pipeline,
  jobId: string,
): WorkflowSplit | null {
  if (!isExpressionIdentifier(jobId) || !own(pipeline.jobs, jobId)) return null;
  const job: Job | undefined = pipeline.jobs[jobId];
  if (!job || !Array.isArray(job.steps)) return null;
  const outputs: unknown = job.outputs;
  if (!isRecord(outputs)) return null;

  const dependentsOf = dependentsByJob(pipeline);
  const dependents = dependentsOf.get(jobId) ?? [];
  let outputKey: string | null = null;
  const byLabel = new Map<string, string>();
  for (const dependent of dependents) {
    const path = pipeline.jobs[dependent];
    if (!path || path.strategy !== undefined) return null;
    const needs = [...new Set(normalizeNeeds(path.needs))];
    if (needs.length !== 1 || needs[0] !== jobId) return null;
    // Nothing runs after a path: a join could read one that was removed.
    if ((dependentsOf.get(dependent) ?? []).length > 0) return null;
    const condition: unknown = path.if;
    const guard = typeof condition === 'string' ? GUARD.exec(condition) : null;
    if (!guard || guard[1] !== jobId) return null;
    const key = guard[2] ?? '';
    const label = guard[3] ?? '';
    if (!isExpressionIdentifier(key)) return null;
    if (outputKey !== null && outputKey !== key) return null;
    outputKey = key;
    if (byLabel.has(label)) return null;
    byLabel.set(label, dependent);
  }
  if (outputKey === null || !own(outputs, outputKey)) return null;
  const template = outputs[outputKey];
  const routerMatch =
    typeof template === 'string' ? ROUTE_OUTPUT.exec(template) : null;
  const routerId = routerMatch?.[1];
  if (routerId === undefined || !isExpressionIdentifier(routerId)) return null;

  const routerIndexes = job.steps.flatMap((step: unknown, index) =>
    isRecord(step) && step.id === routerId ? [index] : [],
  );
  const [routerStepIndex] = routerIndexes;
  if (routerIndexes.length !== 1 || routerStepIndex === undefined) return null;
  const router = job.steps[routerStepIndex];
  if (
    !router ||
    router.uses !== SPLIT_ROUTER_USES ||
    router.if !== undefined ||
    router.continue_on_error !== undefined
  )
    return null;
  const labels = routerLabels(router, byLabel.size);
  if (!labels) return null;
  const paths: WorkflowSplitPath[] = [];
  for (const label of labels) {
    const pathJob = byLabel.get(label);
    if (pathJob === undefined) return null;
    paths.push({ label, jobId: pathJob });
  }
  return { jobId, routerStepIndex, routerId, outputKey, paths };
}

/**
 * Whether the router has no input to decide on: neither `text` nor
 * `text_file`. The router fails such a step when it runs, but a router that
 * never runs is valid, so this is a notice, never a save error.
 */
export function routerLacksInput(step: Step): boolean {
  const input: unknown = step.with;
  if (!isRecord(input)) return true;
  const blank = (value: unknown): boolean =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '');
  return blank(input.text) && blank(input.text_file);
}
