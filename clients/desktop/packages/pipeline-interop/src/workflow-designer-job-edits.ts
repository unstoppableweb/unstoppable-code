/**
 * What the designer's job panel may change on a job's dependencies (CAN-4224
 * phase 08). Its list editor rewrites `needs` lists but not the expressions
 * that read a need, so a need the job reads stays, a need that would form a
 * cycle can't be added, and a split's path changes only through the split.
 * A job's ID, outputs and removal aren't edited in the designer at all:
 * workflows that run this one read them by name, out of its sight.
 */
import { normalizeNeeds, type Pipeline } from './document';
import { parseRouterRoutes } from './router-step';
import {
  readWorkflowSplit,
  SPLIT_ROUTER_USES,
} from './workflow-designer-split';
import { reads } from './workflow-designer-split-edits';

export interface WorkflowJobStructure {
  /** Needs the job reads in an expression, so they stay. */
  readonly readNeeds: ReadonlySet<string>;
  /** Jobs that wait on this one, directly or not: needing one is a cycle. */
  readonly dependents: ReadonlySet<string>;
  /**
   * It's a path of a split, whose dependencies and condition change only
   * through the split's own edits, with its route.
   */
  readonly splitPath: boolean;
  /**
   * The workflow's split paths. None can become another job's need: nothing
   * runs after a path, and a job that did would hide its split.
   */
  readonly pathJobs: ReadonlySet<string>;
}

/**
 * Each need read as `needs.<jobId>` or `needs['<jobId>']`, as the executor
 * reads either, with its ID in the first or third group.
 */
const NEEDS_READ =
  /(?<![A-Za-z0-9_])(?<!\.\s*)needs\s*(?:\.\s*([A-Za-z0-9_-]+)|\[\s*(['"])([^'"\\]*)\2\s*\])/g;

/**
 * `needs` read whole (`toJson(needs)`), by a key computed at run time, or by
 * a quoted key with an escape the executor decodes: any can reach every
 * need, so none can go.
 */
const WHOLE_NEEDS =
  /(?<![A-Za-z0-9_])(?<!\.\s*)needs(?!\s*\.\s*[A-Za-z_][A-Za-z0-9_-]*|\s*\[\s*(['"])[^'"\\]*\1\s*\])(?![A-Za-z0-9_])/;

/**
 * `expression` with each quoted literal emptied, as the executor's tokenizer
 * reads them (a backslash takes the next character), except, with
 * `keepNeedsKeys`, a key quoted right after `needs[`, which names a need.
 * Text inside a string is never a read, nor part of the expression's shape.
 */
function withoutLiterals(expression: string, keepNeedsKeys = true): string {
  let out = '';
  let index = 0;
  while (index < expression.length) {
    const quote = expression[index];
    if (quote !== "'" && quote !== '"') {
      out += quote;
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < expression.length && expression[index] !== quote)
      index += expression[index] === '\\' ? 2 : 1;
    index += 1;
    out +=
      keepNeedsKeys && followsNeedsBracket(out)
        ? expression.slice(start, index)
        : `${quote}${quote}`;
  }
  return out;
}

/**
 * Whether `text` ends with `needs[`, spaces allowed, read back from its end
 * so the check costs only what it reads.
 */
function followsNeedsBracket(text: string): boolean {
  let at = text.length - 1;
  while (at >= 0 && /\s/.test(text[at] ?? '')) at -= 1;
  if (text[at] !== '[') return false;
  at -= 1;
  while (at >= 0 && /\s/.test(text[at] ?? '')) at -= 1;
  return text.slice(at - 4, at + 1) === 'needs';
}

/**
 * The needs a job reads, in one pass over it, and whether it reads them all.
 * A condition is read outside its string literals; a template piece
 * anywhere, since it can start inside a literal, so its quotes can't be told
 * apart, and reading too much there only holds a need back.
 */
function needsReadBy(job: unknown): {
  readonly ids: ReadonlySet<string>;
  readonly whole: boolean;
} {
  const ids = new Set<string>();
  let whole = false;
  reads(job, (expression, condition) => {
    const text = condition ? withoutLiterals(expression) : expression;
    if (WHOLE_NEEDS.test(text)) whole = true;
    for (const match of text.matchAll(NEEDS_READ)) {
      const id = match[1] ?? match[3];
      if (id !== undefined) ids.add(id);
    }
    // Once every need is read, the rest can't add one.
    return whole;
  });
  return { ids, whole };
}

/**
 * A route guard exactly as the designer writes it, and nothing else: the
 * router's job, the output and the route label.
 */
const ROUTE_GUARD =
  /^\s*success\(\)\s*&&\s*needs\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*outputs\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*==\s*'([^'\\]*)'\s*$/;
/** A job output that carries a router step's chosen route. */
const ROUTE_OUTPUT =
  /^\$\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_]*)\.outputs\.route\s*\}\}$/;

/**
 * Whether `jobId` is a path of a split: the split reads as one, or the job's
 * own guard compares the route output of a router job it needs. The guard
 * keeps a path recognized when an edit elsewhere stops the split reading
 * as one.
 */
function isPathJob(
  pipeline: Pipeline,
  jobId: string,
  splitOf: (routerJobId: string) => ReturnType<typeof readWorkflowSplit>,
): boolean {
  const needs = needsOf(pipeline, jobId);
  if (
    needs.some(
      (need) =>
        splitOf(need)?.paths.some((path) => path.jobId === jobId) ?? false,
    )
  )
    return true;
  const condition: unknown = pipeline.jobs[jobId]?.if;
  const guard =
    typeof condition === 'string' ? ROUTE_GUARD.exec(condition) : null;
  const router = guard?.[1];
  const key = guard?.[2];
  const label = guard?.[3];
  if (
    router === undefined ||
    key === undefined ||
    label === undefined ||
    !needs.includes(router)
  )
    return false;
  const outputs: unknown = pipeline.jobs[router]?.outputs;
  const template: unknown =
    typeof outputs === 'object' && outputs !== null && key in outputs
      ? Object.entries(outputs).find(([name]) => name === key)?.[1]
      : undefined;
  const routerId =
    typeof template === 'string' ? ROUTE_OUTPUT.exec(template)?.[1] : undefined;
  const steps: unknown = pipeline.jobs[router]?.steps;
  const routerStep: unknown =
    routerId !== undefined && Array.isArray(steps)
      ? steps.find(
          (step: unknown) =>
            typeof step === 'object' &&
            step !== null &&
            'id' in step &&
            step.id === routerId &&
            'uses' in step &&
            step.uses === SPLIT_ROUTER_USES,
        )
      : undefined;
  return routeLabels(routerStep).includes(label);
}

/** A router step's route labels, or none when it has none it can read. */
function routeLabels(step: unknown): readonly string[] {
  if (typeof step !== 'object' || step === null || !('with' in step)) return [];
  const inputs: unknown = step.with;
  const routes: unknown =
    typeof inputs === 'object' && inputs !== null && 'routes' in inputs
      ? inputs.routes
      : undefined;
  if (typeof routes !== 'string') return [];
  try {
    return parseRouterRoutes(routes);
  } catch {
    // Routes the router itself would refuse name no path.
    return [];
  }
}

/**
 * A status call, which reads how the job's needs ended, with or without
 * arguments (`failure('build')`).
 */
const NEEDS_STATUS = /(?<![A-Za-z0-9_.])(?:success|failure|cancelled)\s*\(/;
/**
 * A leading `success()` on its own, or ANDed with the rest: what a job with
 * no condition does, so dropping a need there is the edit asked for. Only
 * when it gates the whole condition: an `||` after it leaves part ungated.
 */
const DEFAULT_SUCCESS = /^\s*success\s*\(\s*\)\s*(?:&&|$)/;

/**
 * Whether a job's own condition runs on how its needs ended, beyond the
 * default of all of them succeeding: `failure()`, `cancelled()`, or a
 * `success()` other than a leading one (negated, compared, ORed). Each need
 * then decides it, so none can go.
 */
function readsNeedsStatus(condition: unknown): boolean {
  if (typeof condition !== 'string') return false;
  // Every literal emptied, keys included: its text is no status call, nor
  // a parenthesis or bracket.
  const bare = withoutLiterals(condition, false);
  const rest = bare.replace(DEFAULT_SUCCESS, '');
  if (rest === bare) return NEEDS_STATUS.test(bare);
  return NEEDS_STATUS.test(rest) || hasTopLevelOr(rest);
}

/** Whether `expression` has an `||` outside every parenthesis and bracket. */
function hasTopLevelOr(expression: string): boolean {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === '|' && expression[index + 1] === '|')
      return true;
  }
  return false;
}

/** A job's needs that are job IDs, each once. */
function needsOf(pipeline: Pipeline, jobId: string): readonly string[] {
  return [
    ...new Set(
      normalizeNeeds(pipeline.jobs[jobId]?.needs).filter(
        (need: unknown): need is string => typeof need === 'string',
      ),
    ),
  ];
}

export function workflowJobStructure(
  pipeline: Pipeline,
  jobId: string,
): WorkflowJobStructure {
  const job = pipeline.jobs[jobId];
  const needs = needsOf(pipeline, jobId);
  const read = needsReadBy(job);
  const readsAll = read.whole || readsNeedsStatus(job?.if);
  const readNeeds = new Set(
    needs.filter((need) => readsAll || read.ids.has(need)),
  );
  const waiting = new Map<string, string[]>();
  for (const otherId of Object.keys(pipeline.jobs))
    for (const need of needsOf(pipeline, otherId))
      waiting.set(need, [...(waiting.get(need) ?? []), otherId]);
  const dependents = new Set<string>();
  const pending = [...(waiting.get(jobId) ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (dependents.has(next)) continue;
    dependents.add(next);
    pending.push(...(waiting.get(next) ?? []));
  }
  // One split read per router job, however many paths need it.
  const splits = new Map<string, ReturnType<typeof readWorkflowSplit>>();
  const splitOf = (
    routerJobId: string,
  ): ReturnType<typeof readWorkflowSplit> => {
    if (!splits.has(routerJobId))
      splits.set(routerJobId, readWorkflowSplit(pipeline, routerJobId));
    return splits.get(routerJobId) ?? null;
  };
  const pathJobs = new Set(
    Object.keys(pipeline.jobs).filter((otherId) =>
      isPathJob(pipeline, otherId, splitOf),
    ),
  );
  return {
    readNeeds,
    dependents,
    splitPath: pathJobs.has(jobId),
    pathJobs,
  };
}
