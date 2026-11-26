/**
 * The workflow designer's structural edits (CAN-4224 phase 02): insert,
 * remove and move a step within a job, and set a step's ID. Each edit is pure
 * and either returns the edited pipeline, or refuses it with the input
 * unchanged.
 *
 * The reference-integrity check keeps every step reference resolving to the
 * same step. Within a job, steps read each other through `steps.<id>`, and the
 * job's outputs publish those reads to other jobs. An edit that would change
 * which step a read resolves to, or whether it resolves at all, is refused.
 * The designer never rewrites an expression to make an edit fit.
 */
import type { Job, Pipeline, Step } from './document';
import { assignStepIds } from './normalize-pipeline';
import {
  projectWorkflowStack,
  workflowStackEditableKeys,
} from './workflow-designer';
import type { WorkflowPathLabelProblem } from './workflow-designer-split';

/** Something that reads a step, named for a refusal message. */
export type WorkflowDesignerReader =
  | {
      readonly kind: 'step';
      readonly stepIndex: number;
      readonly name?: string;
      readonly id?: string;
    }
  | { readonly kind: 'output'; readonly key: string }
  /** A pipeline dependency scoped to steps by their IDs. */
  | { readonly kind: 'dependency'; readonly id: string }
  /** A split's path, whose job reads what the router's job publishes. */
  | { readonly kind: 'path'; readonly label: string };

export type WorkflowDesignerRefusal =
  /** The job is shown read-only, or the position doesn't exist. */
  | { readonly kind: 'not-editable' }
  /** A step ID that the executor would reject. */
  | { readonly kind: 'invalid-id' }
  /** Another step in the job already has the ID. */
  | { readonly kind: 'duplicate-id' }
  /** The edit would change what `reader` reads. */
  | { readonly kind: 'reads'; readonly reader: WorkflowDesignerReader }
  /**
   * The edit would change which steps run before a step `reader` reads, or
   * their order, so a failure or the environment they write could change
   * what it gets.
   */
  | { readonly kind: 'order'; readonly reader: WorkflowDesignerReader }
  /**
   * The edit would change which steps run before `reader`, a step whose
   * condition checks whether earlier steps failed.
   */
  | { readonly kind: 'outcomes'; readonly reader: WorkflowDesignerReader }
  /** A path label the router or the guard can't carry. */
  | { readonly kind: 'path-label'; readonly problem: WorkflowPathLabelProblem }
  /** A split keeps at least two paths; Remove split removes them all. */
  | { readonly kind: 'too-few-paths' }
  /** The edit would make the workflow larger than the designer shows. */
  | { readonly kind: 'too-large' };

export type WorkflowDesignerEditResult =
  | {
      readonly ok: true;
      readonly pipeline: Pipeline;
      /** Where the edited step now is, when one remains. */
      readonly stepIndex?: number;
    }
  | { readonly ok: false; readonly refusal: WorkflowDesignerRefusal };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// What a job's expressions read of `steps`
// ---------------------------------------------------------------------------

type Token =
  | { readonly type: 'identifier'; readonly value: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'dot' | 'open-bracket' | 'close-bracket' | 'other' };

/**
 * `expression` as the executor's tokenizer reads it, or null where that
 * tokenizer would throw (an unterminated string, a character it doesn't
 * know). Only the token kinds a `steps` read needs are kept apart.
 */
function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const pair = expression.slice(index, index + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(pair)) {
      tokens.push({ type: 'other' });
      index += 2;
      continue;
    }
    if ('!<>(),'.includes(char)) {
      tokens.push({ type: 'other' });
      index += 1;
      continue;
    }
    if (char === '.') {
      tokens.push({ type: 'dot' });
      index += 1;
      continue;
    }
    if (char === '[' || char === ']') {
      tokens.push({ type: char === '[' ? 'open-bracket' : 'close-bracket' });
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      let value = '';
      index += 1;
      while (index < expression.length && expression[index] !== char) {
        if (expression[index] === '\\' && index + 1 < expression.length) {
          value += expression[index + 1];
          index += 2;
          continue;
        }
        value += expression[index];
        index += 1;
      }
      if (index >= expression.length) return null;
      tokens.push({ type: 'string', value });
      index += 1;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(expression.slice(index));
    if (number) {
      tokens.push({ type: 'other' });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * What some text reads of `steps`: named steps, or any step (computed). A
 * status function (`success()`, `failure()`, `cancelled()`) reads whether
 * any step before the reader failed.
 */
interface StepReads {
  readonly ids: Set<string>;
  computed: boolean;
  outcomes: boolean;
}

const STATUS_FUNCTIONS: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
]);

/** Adds what one expression reads of `steps` to `reads`. */
function addExpressionReads(expression: string, reads: StepReads): void {
  const tokens = tokenize(expression);
  if (tokens === null) {
    // The executor can't read it either, but it may still be read some other
    // way at run time; count it as reading any step.
    if (/(?<![A-Za-z0-9_])steps(?![A-Za-z0-9_])/.test(expression))
      reads.computed = true;
    if (
      /(?<![A-Za-z0-9_])(?:success|failure|cancelled)(?![A-Za-z0-9_])/.test(
        expression,
      )
    )
      reads.outcomes = true;
    return;
  }
  tokens.forEach((token, index) => {
    if (token.type !== 'identifier') return;
    // After a dot it is a property name, not a context or function.
    if (tokens[index - 1]?.type === 'dot') return;
    if (STATUS_FUNCTIONS.has(token.value)) {
      reads.outcomes = true;
      return;
    }
    if (token.value !== 'steps') return;
    const next = tokens[index + 1];
    const name = tokens[index + 2];
    if (next?.type === 'dot' && name?.type === 'identifier') {
      reads.ids.add(name.value);
      return;
    }
    if (
      next?.type === 'open-bracket' &&
      name?.type === 'string' &&
      tokens[index + 3]?.type === 'close-bracket'
    ) {
      reads.ids.add(name.value);
      return;
    }
    // `steps[name]`, `toJSON(steps)` and the like: any step.
    reads.computed = true;
  });
}

/**
 * An embedded `${{ }}` as the executor interpolates it: on one line, so a
 * multiline one in literal text such as a heredoc stays text.
 */
const TEMPLATE = /\$\{\{\s*(.*?)\s*\}\}/g;

/** Adds what a templated value reads: the text inside each `${{ }}`. */
function addTemplateReads(value: unknown, reads: StepReads): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TEMPLATE))
      addExpressionReads(match[1] ?? '', reads);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addTemplateReads(item, reads);
    return;
  }
  if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) addTemplateReads(item, reads);
}

/**
 * The `with` keys the executor keeps unevaluated: a send step's text and
 * references when it sets `literal_text: true`.
 */
export function literalWithKeys(step: {
  readonly uses?: unknown;
  readonly with?: unknown;
}): ReadonlySet<string> {
  const inputs: unknown = step.with;
  const literal: unknown =
    typeof inputs === 'object' && inputs !== null && 'literal_text' in inputs
      ? inputs.literal_text
      : undefined;
  return step.uses === 'builtin/send-agent-message' &&
    (literal === true ||
      (typeof literal === 'string' && literal.trim().toLowerCase() === 'true'))
    ? new Set(['text', 'text_references'])
    : new Set();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a step reads: its `if` as a whole expression, and every template. */
function stepReads(step: Step): StepReads {
  const reads: StepReads = { ids: new Set(), computed: false, outcomes: false };
  const literal = literalWithKeys(step);
  for (const [key, field] of Object.entries(step)) {
    const value: unknown = field;
    if (key === 'if' && typeof value === 'string') {
      const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value);
      addExpressionReads(wrapped?.[1] ?? value, reads);
    } else if (key === 'with' && isRecord(value)) {
      for (const [input, inputValue] of Object.entries(value))
        if (!literal.has(input)) addTemplateReads(inputValue, reads);
    } else {
      addTemplateReads(value, reads);
    }
  }
  return reads;
}

function outputReads(value: unknown): StepReads {
  const reads: StepReads = { ids: new Set(), computed: false, outcomes: false };
  addTemplateReads(value, reads);
  return reads;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** A step's ID as the executor assigns it, generated ones included. */
function assignedIds(job: Job, jobId: string): readonly string[] | null {
  try {
    return assignStepIds(job.steps, jobId).map((step) => step.id);
  } catch {
    return null;
  }
}

/**
 * Where a step of the edited job came from: for each position after the
 * edit, the position it held before, or -1 for a new step. Steps are tracked
 * by position, not by object, because YAML aliases can put one step object
 * at several positions.
 */
type Origins = readonly number[];

/**
 * What a reader at `reader` sees of the step at `at`: its position before
 * (-1 for a new step), and whether it has run. The executor enters every
 * step of the job as pending before the first one runs, so a reader sees
 * the steps at and after it too, as pending.
 */
function seen(at: number, reader: number, origins: Origins | null): string {
  const origin = origins === null ? at : (origins[at] ?? -1);
  return `${String(origin)}${at < reader ? '' : ' pending'}`;
}

/** What `id` names for a reader at `reader`, or `missing`. */
function resolve(
  id: string,
  reader: number,
  ids: readonly string[],
  origins: Origins | null,
): string {
  const at = ids.indexOf(id);
  return at < 0 ? 'missing' : seen(at, reader, origins);
}

/** Every step a whole-context read sees, in run order. */
function visible(
  reader: number,
  ids: readonly string[],
  origins: Origins | null,
): string {
  return ids.map((id, at) => `${id}@${seen(at, reader, origins)}`).join(',');
}

function readerOf(step: Step, stepIndex: number): WorkflowDesignerReader {
  const name: unknown = step.name;
  return {
    kind: 'step',
    stepIndex,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof step.id === 'string' && step.id !== '' ? { id: step.id } : {}),
  };
}

/** The step IDs a pipeline's dependency manifest scopes entries to. */
export function dependencyStepIds(
  pipeline: Pipeline,
): readonly { readonly dependency: string; readonly stepId: string }[] {
  const found: { dependency: string; stepId: string }[] = [];
  // A draft can hold a manifest that isn't a list; it names no steps.
  const entries: unknown = pipeline.dependencies;
  if (!Array.isArray(entries)) return found;
  for (const entry of entries) {
    // A draft can hold entries that aren't mappings; they scope no steps.
    if (!isRecord(entry)) continue;
    const steps: unknown = entry.steps;
    if (!Array.isArray(steps)) continue;
    const dependency: unknown = entry.id;
    for (const raw of steps) {
      // Normalization trims these IDs before it resolves them.
      const stepId = typeof raw === 'string' ? raw.trim() : '';
      if (stepId !== '')
        found.push({
          dependency: typeof dependency === 'string' ? dependency : stepId,
          stepId,
        });
    }
  }
  return found;
}

/**
 * The first reader whose reads the edit changes, or null when every read
 * resolves to the same step, seen at the same point in the run.
 */
function changedReader(
  pipeline: Pipeline,
  jobId: string,
  before: Job,
  after: Job,
  origins: Origins,
): WorkflowDesignerRefusal | 'invalid' | null {
  const beforeIds = assignedIds(before, jobId);
  const afterIds = assignedIds(after, jobId);
  if (beforeIds === null || afterIds === null) return 'invalid';
  const readers: {
    readonly reads: StepReads;
    readonly before: number;
    readonly after: number;
    readonly reader: WorkflowDesignerReader;
  }[] = [];
  before.steps.forEach((step, index) => {
    const afterIndex = origins.indexOf(index);
    // A removed step reads nothing any more.
    if (afterIndex < 0) return;
    readers.push({
      reads: stepReads(after.steps[afterIndex] ?? step),
      before: index,
      after: afterIndex,
      // Named where it is now: the edit is refused, so nothing moves.
      reader: readerOf(step, index),
    });
  });
  // Job outputs read once every step has run.
  for (const [key, value] of Object.entries(before.outputs ?? {}))
    readers.push({
      reads: outputReads(value),
      before: Number.POSITIVE_INFINITY,
      after: Number.POSITIVE_INFINITY,
      reader: { kind: 'output', key },
    });
  // The steps something reads, by position before, with who reads them.
  const readSteps = new Map<number, WorkflowDesignerReader>();
  // The steps whose conditions read earlier steps' outcomes.
  const observers = new Map<number, WorkflowDesignerReader>();
  for (const { reads, before: b, after: a, reader } of readers) {
    for (const id of reads.ids) {
      if (resolve(id, b, beforeIds, null) !== resolve(id, a, afterIds, origins))
        return { kind: 'reads', reader };
      // Only a step that has run can have a value that depends on order.
      const producer = beforeIds.indexOf(id);
      if (producer >= 0 && producer < b && !readSteps.has(producer))
        readSteps.set(producer, reader);
    }
    // A whole-context read sees which steps ran, and in what order.
    if (reads.computed) {
      if (visible(b, beforeIds, null) !== visible(a, afterIds, origins))
        return { kind: 'reads', reader };
      for (let at = 0; at < Math.min(b, beforeIds.length); at += 1)
        if (!readSteps.has(at)) readSteps.set(at, reader);
    }
    // A status function sees whether any step before the reader failed.
    if (reads.outcomes && Number.isFinite(b)) observers.set(b, reader);
  }
  // A dependency scoped to steps names them by ID across the workflow.
  for (const { dependency, stepId } of dependencyStepIds(pipeline)) {
    const was = beforeIds.flatMap((id, at) => (id === stepId ? [at] : []));
    const now = afterIds.flatMap((id, at) =>
      id === stepId ? [origins[at] ?? -1] : [],
    );
    if (was.join(',') !== now.join(','))
      return { kind: 'reads', reader: { kind: 'dependency', id: dependency } };
  }
  // A step skips once an earlier one fails, so a read step must keep the
  // steps that run before it, in their order: otherwise a failure or a
  // changed environment could leave it unrun where it ran, or run where it
  // didn't. New and removed steps are the edit
  // itself: a step the user adds or removes may fail or not, and refusing
  // every insert before a read step would block most inserts.
  const kept = new Set(origins.filter((origin) => origin >= 0));
  const keepsPredecessors = (step: number): boolean => {
    const at = origins.indexOf(step);
    if (at < 0) return true;
    const was = positions(step).filter((origin) => kept.has(origin));
    // In run order: each step can write the dynamic environment that later
    // conditions read, and which steps write it can't be told statically.
    const now = origins.slice(0, at).filter((origin) => origin >= 0);
    return was.join(',') === now.join(',');
  };
  for (const [producer, reader] of readSteps)
    if (!keepsPredecessors(producer)) return { kind: 'order', reader };
  for (const [step, reader] of observers)
    if (!keepsPredecessors(step)) return { kind: 'outcomes', reader };
  return null;
}

/** Whether the designer shows `jobId` as cards it may edit. */
export function isEditableJob(pipeline: Pipeline, jobId: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(pipeline.jobs, jobId)) return false;
  const keys = workflowStackEditableKeys(projectWorkflowStack(pipeline));
  for (const key of keys)
    if (key === `job:${jobId}` || key.startsWith(`step:${jobId}:`)) return true;
  return false;
}

/**
 * Applies `steps` to `jobId` if every read still resolves the same way.
 * `origins` gives each new position's old position (-1 for a new step).
 */
function withSteps(
  pipeline: Pipeline,
  jobId: string,
  steps: Step[],
  origins: Origins,
  stepIndex?: number,
): WorkflowDesignerEditResult {
  const job = pipeline.jobs[jobId];
  if (!job) return { ok: false, refusal: { kind: 'not-editable' } };
  const edited: Job = { ...job, steps };
  const changed = changedReader(pipeline, jobId, job, edited, origins);
  if (changed === 'invalid')
    return { ok: false, refusal: { kind: 'not-editable' } };
  if (changed !== null) return { ok: false, refusal: changed };
  return {
    ok: true,
    pipeline: { ...pipeline, jobs: { ...pipeline.jobs, [jobId]: edited } },
    ...(stepIndex !== undefined ? { stepIndex } : {}),
  };
}

function stepsOf(pipeline: Pipeline, jobId: string): Step[] | null {
  if (!isEditableJob(pipeline, jobId)) return null;
  const job = pipeline.jobs[jobId];
  return job && Array.isArray(job.steps) ? [...job.steps] : null;
}

/** Positions 0 to `count - 1`, to splice alongside a job's steps. */
function positions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

/**
 * An ID for a new step in `jobId`, from `base`: not taken by any step and not
 * read anywhere in the job, so adding it changes no read.
 */
export function newWorkflowStepId(
  pipeline: Pipeline,
  jobId: string,
  base: string,
): string {
  const job = pipeline.jobs[jobId];
  const taken = new Set<string>(job ? (assignedIds(job, jobId) ?? []) : []);
  for (const step of job?.steps ?? [])
    for (const id of stepReads(step).ids) taken.add(id);
  for (const value of Object.values(job?.outputs ?? {}))
    for (const id of outputReads(value).ids) taken.add(id);
  for (const { stepId } of dependencyStepIds(pipeline)) taken.add(stepId);
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const stem = IDENTIFIER.test(cleaned) ? cleaned : 'step';
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}_${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Inserts `step` into `jobId` at `index` (0 to the job's step count). */
export function insertWorkflowStep(
  pipeline: Pipeline,
  jobId: string,
  index: number,
  step: Step,
): WorkflowDesignerEditResult {
  const steps = stepsOf(pipeline, jobId);
  if (
    steps === null ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > steps.length
  )
    return { ok: false, refusal: { kind: 'not-editable' } };
  const origins = positions(steps.length);
  steps.splice(index, 0, step);
  origins.splice(index, 0, -1);
  return withSteps(pipeline, jobId, steps, origins, index);
}

/** Removes the step at `index` from `jobId`. */
export function removeWorkflowStep(
  pipeline: Pipeline,
  jobId: string,
  index: number,
): WorkflowDesignerEditResult {
  const steps = stepsOf(pipeline, jobId);
  if (steps === null || !Number.isInteger(index) || steps[index] === undefined)
    return { ok: false, refusal: { kind: 'not-editable' } };
  const origins = positions(steps.length);
  steps.splice(index, 1);
  origins.splice(index, 1);
  return withSteps(pipeline, jobId, steps, origins);
}

/** Moves the step at `from` to `to` within `jobId`. */
export function moveWorkflowStep(
  pipeline: Pipeline,
  jobId: string,
  from: number,
  to: number,
): WorkflowDesignerEditResult {
  const steps = stepsOf(pipeline, jobId);
  if (
    steps === null ||
    !Number.isInteger(from) ||
    steps[from] === undefined ||
    !Number.isInteger(to) ||
    to < 0 ||
    to >= steps.length
  )
    return { ok: false, refusal: { kind: 'not-editable' } };
  const origins = positions(steps.length);
  const [moved] = steps.splice(from, 1);
  const [movedOrigin] = origins.splice(from, 1);
  if (moved === undefined || movedOrigin === undefined)
    return { ok: false, refusal: { kind: 'not-editable' } };
  steps.splice(to, 0, moved);
  origins.splice(to, 0, movedOrigin);
  return withSteps(pipeline, jobId, steps, origins, to);
}

/**
 * Sets, or with `undefined` clears, the ID of the step at `index`. Refused
 * when anything reads the step by its current ID, or would start reading it
 * by the new one: the designer doesn't rewrite those reads.
 */
export function setWorkflowStepId(
  pipeline: Pipeline,
  jobId: string,
  index: number,
  id: string | undefined,
): WorkflowDesignerEditResult {
  const steps = stepsOf(pipeline, jobId);
  const step = Number.isInteger(index) ? steps?.[index] : undefined;
  if (steps === null || step === undefined)
    return { ok: false, refusal: { kind: 'not-editable' } };
  if (id !== undefined && !IDENTIFIER.test(id))
    return { ok: false, refusal: { kind: 'invalid-id' } };
  if (
    id !== undefined &&
    steps.some((other, otherIndex) => otherIndex !== index && other.id === id)
  )
    return { ok: false, refusal: { kind: 'duplicate-id' } };
  const renamed: Step = { ...step };
  if (id === undefined) delete renamed.id;
  else renamed.id = id;
  steps[index] = renamed;
  return withSteps(pipeline, jobId, steps, positions(steps.length), index);
}
