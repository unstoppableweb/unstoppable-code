/**
 * The workflow designer's trigger card (CAN-4224 phase 04): how a workflow
 * starts, read from `on:`, and which steps run only for one entry. Its one
 * edit writes `on:` and nothing else, and never adds or removes `workflow`,
 * whose two-release rollout CAN-5782 owns.
 */
import {
  getTriggerInputDefs,
  getTriggerTypes,
  setTriggerTypes,
  type Pipeline,
  type PipelineTriggerType,
} from './document';

/** A brand's internal name as the expression root it is read under. */
export function toExpressionRoot(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join('');
}

/**
 * The names the executor puts a run's context under, `event_name` with it:
 * `canopy`, the brand's internal name, and that name as an expression root.
 */
export function runContextRoots(brandInternalName: string): readonly string[] {
  return [
    ...new Set([
      'canopy',
      brandInternalName,
      toExpressionRoot(brandInternalName),
    ]),
  ];
}

/** The entries a person can start a workflow from by hand. */
export type WorkflowManualEntry = 'run' | 'approved-plan' | 'new-task';

export const WORKFLOW_MANUAL_ENTRIES: readonly WorkflowManualEntry[] = [
  'run',
  'approved-plan',
  'new-task',
];

const TRIGGER_OF: Readonly<Record<WorkflowManualEntry, PipelineTriggerType>> = {
  run: 'dispatch',
  'approved-plan': 'plan_ready',
  'new-task': 'task_ready',
};

const ENTRY_OF: Readonly<Partial<Record<string, WorkflowManualEntry>>> = {
  dispatch: 'run',
  plan_ready: 'approved-plan',
  task_ready: 'new-task',
};

export interface WorkflowTrigger {
  /** The manual entries `on:` turns on, in the card's order. */
  readonly entries: readonly WorkflowManualEntry[];
  /** `on:` names `workflow`, which the card shows and never changes. */
  readonly fromWorkflow: boolean;
  /**
   * Steps that run for one entry only, keyed `step:<job>:<index>` like the
   * stack's cards: their `if` is exactly an `event_name` test for it.
   */
  readonly stepEntries: ReadonlyMap<string, WorkflowManualEntry>;
  /** Jobs whose own `if` runs them for one entry only, by job ID. */
  readonly jobEntries: ReadonlyMap<string, WorkflowManualEntry>;
  /**
   * Steps and jobs whose `if` reads `event_name` some other way: the card
   * can't tell which entries they need, so turning any entry off is
   * refused while they exist. `stepIndex` is absent for a job.
   */
  readonly entryReaders: readonly {
    readonly jobId: string;
    readonly stepIndex?: number;
    readonly name?: string;
  }[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The trigger types a step condition tests for, when it is exactly
 * `<root>.event_name == '<type>'` (either quote, as the executor's tokenizer
 * reads both) on one of `expressionRoots`, the names the executor registers
 * the run context under. Anything else isn't read.
 */
function entryOnly(
  condition: unknown,
  expressionRoots: ReadonlySet<string>,
): WorkflowManualEntry | null {
  if (typeof condition !== 'string') return null;
  const match =
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*event_name\s*==\s*(['"])([a-z_]+)\2\s*$/.exec(
      condition,
    );
  const root = match?.[1];
  const type = match?.[3];
  if (root === undefined || type === undefined) return null;
  if (!IDENTIFIER.test(root) || !expressionRoots.has(root)) return null;
  return ENTRY_OF[type] ?? null;
}

/**
 * `text` with each quoted literal emptied, read as the executor's tokenizer
 * reads them (a backslash takes the next character), so a word inside a
 * string isn't taken for a name.
 */
function withoutLiterals(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote !== "'" && quote !== '"') {
      out += quote;
      index += 1;
      continue;
    }
    index += 1;
    while (index < text.length && text[index] !== quote)
      index += text[index] === '\\' ? 2 : 1;
    out += "''";
    index += 1;
  }
  return out;
}

/**
 * Whether `condition` reads `event_name` from the run context: under one of
 * `roots`, by a dot or a quoted bracket. `env.event_name`, an input of that
 * name, or the words inside a string read something else.
 */
function readsEventName(
  condition: string,
  roots: ReadonlySet<string>,
): boolean {
  const bare = withoutLiterals(condition);
  for (const root of roots) {
    if (!IDENTIFIER.test(root)) continue;
    const dot = new RegExp(
      String.raw`(?<![A-Za-z0-9_.])${root}\s*\.\s*event_name(?![A-Za-z0-9_])`,
    );
    const bracket = new RegExp(
      String.raw`(?<![A-Za-z0-9_.])${root}\s*\[\s*(['"])event_name\1\s*\]`,
    );
    if (dot.test(bare) || bracket.test(condition)) return true;
  }
  return false;
}

/**
 * How `pipeline` starts. `expressionRoots` are the identifiers the executor
 * puts the run context under (`canopy` and the brand's expression root).
 */
export function projectWorkflowTrigger(
  pipeline: Pipeline,
  expressionRoots: readonly string[],
): WorkflowTrigger {
  const types = getTriggerTypes(pipeline.on);
  const roots = new Set(expressionRoots);
  const stepEntries = new Map<string, WorkflowManualEntry>();
  const jobEntries = new Map<string, WorkflowManualEntry>();
  const entryReaders: {
    jobId: string;
    stepIndex?: number;
    name?: string;
  }[] = [];
  // Any other read of the run context's `event_name` may test an entry.
  const readsEntry = (condition: unknown): boolean =>
    typeof condition === 'string' && readsEventName(condition, roots);
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const jobEntry = entryOnly(job.if, roots);
    if (jobEntry !== null) jobEntries.set(jobId, jobEntry);
    else if (readsEntry(job.if)) {
      const name: unknown = job.name;
      entryReaders.push({
        jobId,
        ...(typeof name === 'string' ? { name } : {}),
      });
    }
    const steps: unknown = job.steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step: unknown, index) => {
      if (typeof step !== 'object' || step === null || !('if' in step)) return;
      const entry = entryOnly(step.if, roots);
      if (entry !== null)
        stepEntries.set(`step:${jobId}:${String(index)}`, entry);
      else if (readsEntry(step.if)) {
        const name: unknown = 'name' in step ? step.name : undefined;
        entryReaders.push({
          jobId,
          stepIndex: index,
          ...(typeof name === 'string' ? { name } : {}),
        });
      }
    });
  }
  return {
    entries: WORKFLOW_MANUAL_ENTRIES.filter((entry) =>
      types.includes(TRIGGER_OF[entry]),
    ),
    fromWorkflow: types.includes('workflow'),
    stepEntries,
    jobEntries,
    entryReaders,
  };
}

export type WorkflowTriggerRefusal =
  /** A workflow keeps at least one way to start. */
  | { readonly kind: 'no-entry' }
  /** Schedules start the workflow as a run, so Run stays on. */
  | { readonly kind: 'scheduled' }
  /** A worktree hook starts the workflow as a run, so Run stays on. */
  | { readonly kind: 'hooked' }
  /** What starts the workflow isn't known yet, so Run stays on. */
  | { readonly kind: 'starters-unknown' }
  /**
   * A step or job's condition reads which entry started the workflow in a
   * way the card can't follow, so no entry is turned off.
   */
  | {
      readonly kind: 'entry-read';
      readonly entry: WorkflowManualEntry;
      readonly jobId: string;
      readonly stepIndex?: number;
      readonly name?: string;
    }
  /**
   * The entry has inputs, which turning it off would delete: turning it
   * back on wouldn't bring them back.
   */
  | { readonly kind: 'entry-inputs'; readonly entry: WorkflowManualEntry }
  /**
   * A step or a job runs only for this entry, so turning it off would leave
   * it never running. `stepIndex` is absent for a job.
   */
  | {
      readonly kind: 'entry-used';
      readonly entry: WorkflowManualEntry;
      readonly jobId: string;
      readonly stepIndex?: number;
      readonly name?: string;
    };

export type WorkflowTriggerEditResult =
  | { readonly ok: true; readonly pipeline: Pipeline }
  | { readonly ok: false; readonly refusal: WorkflowTriggerRefusal };

/**
 * Sets the manual entries `pipeline` starts from, writing only `on:` and
 * keeping `workflow` as it is. `scheduled` says schedules or automations
 * start it, and `hooked` that worktree hooks do: both start it as a run,
 * and fail without one, so Run can't go while they exist.
 */
export function setManualEntries(
  pipeline: Pipeline,
  entries: readonly WorkflowManualEntry[],
  {
    scheduled,
    hooked = false,
    startersKnown = true,
    expressionRoots,
  }: {
    readonly scheduled: boolean;
    readonly hooked?: boolean;
    /**
     * Whether the schedules and hooks above are loaded: until they are, no
     * edit can show that nothing needs Run.
     */
    readonly startersKnown?: boolean;
    readonly expressionRoots: readonly string[];
  },
): WorkflowTriggerEditResult {
  const current = projectWorkflowTrigger(pipeline, expressionRoots);
  const next = new Set(entries);
  if (next.size === 0 && !current.fromWorkflow)
    return { ok: false, refusal: { kind: 'no-entry' } };
  const dropsRun = current.entries.includes('run') && !next.has('run');
  if (dropsRun && scheduled)
    return { ok: false, refusal: { kind: 'scheduled' } };
  if (dropsRun && hooked) return { ok: false, refusal: { kind: 'hooked' } };
  if (dropsRun && !startersKnown)
    return { ok: false, refusal: { kind: 'starters-unknown' } };
  const dropped = (entry: WorkflowManualEntry): boolean =>
    !next.has(entry) && current.entries.includes(entry);
  // A condition that reads the entry some other way may need any entry.
  const droppedEntry = WORKFLOW_MANUAL_ENTRIES.find(dropped);
  const [reader] = current.entryReaders;
  if (droppedEntry !== undefined && reader !== undefined)
    return {
      ok: false,
      refusal: { kind: 'entry-read', entry: droppedEntry, ...reader },
    };
  for (const [jobId, entry] of current.jobEntries) {
    if (!dropped(entry)) continue;
    const name: unknown = pipeline.jobs[jobId]?.name;
    return {
      ok: false,
      refusal: {
        kind: 'entry-used',
        entry,
        jobId,
        ...(typeof name === 'string' ? { name } : {}),
      },
    };
  }
  for (const [key, entry] of current.stepEntries) {
    if (!dropped(entry)) continue;
    const [, jobId = '', index = '0'] = key.split(':');
    const stepIndex = Number(index);
    const name: unknown = pipeline.jobs[jobId]?.steps[stepIndex]?.name;
    return {
      ok: false,
      refusal: {
        kind: 'entry-used',
        entry,
        jobId,
        stepIndex,
        ...(typeof name === 'string' ? { name } : {}),
      },
    };
  }
  for (const entry of WORKFLOW_MANUAL_ENTRIES)
    if (
      dropped(entry) &&
      Object.keys(getTriggerInputDefs(pipeline.on, TRIGGER_OF[entry]) ?? {})
        .length > 0
    )
      return { ok: false, refusal: { kind: 'entry-inputs', entry } };
  const types: PipelineTriggerType[] = WORKFLOW_MANUAL_ENTRIES.filter((entry) =>
    next.has(entry),
  ).map((entry) => TRIGGER_OF[entry]);
  if (current.fromWorkflow) types.push('workflow');
  const unchanged =
    current.entries.length === next.size &&
    current.entries.every((entry) => next.has(entry));
  if (unchanged) return { ok: true, pipeline };
  return {
    ok: true,
    pipeline: {
      ...pipeline,
      on: setTriggerTypes(pipeline.on ?? 'dispatch', types),
    },
  };
}
