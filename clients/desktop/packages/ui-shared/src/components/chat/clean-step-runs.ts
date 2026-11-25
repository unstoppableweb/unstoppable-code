import {
  describeStepCounts,
  type StepKind,
  type PlanWriteStatus,
} from './step-words';

/**
 * The clean chat look groups a turn's work between two replies into one
 * line. Hosts flatten their transcript into units (a message, or a piece of
 * one) and say what each unit is:
 *
 * - `step`: agent work that folds into the run (a tool call, failed ones
 *   included, a thought, a helper agent, a question still being asked);
 * - `silent`: draws nothing (an empty thinking shell, a blank text block),
 *   so it joins whatever run it sits in without splitting it;
 * - `break`: something the person reads or acts on (a reply, an answered
 *   question, a plan, a visual, an app notice), which ends the run.
 *
 * Every run of steps becomes one segment, however short, so a turn reads
 * "reply, one line of work, reply" rather than a list of rows.
 */
export type CleanUnitRole = 'step' | 'silent' | 'break';

export type CleanRunSegment<T> =
  | { readonly kind: 'item'; readonly item: T }
  | {
      readonly kind: 'run';
      /** Stable while the run grows: the key of its first unit. */
      readonly key: string;
      readonly items: readonly T[];
    };

export function groupCleanSteps<T>(
  units: readonly T[],
  roleOf: (unit: T) => CleanUnitRole,
  keyOf: (unit: T) => string,
): CleanRunSegment<T>[] {
  const segments: CleanRunSegment<T>[] = [];
  let run: T[] = [];
  let hasStep = false;
  const flush = (): void => {
    const first = run[0];
    if (first !== undefined && hasStep) {
      segments.push({ kind: 'run', key: keyOf(first), items: run });
    } else {
      for (const item of run) segments.push({ kind: 'item', item });
    }
    run = [];
    hasStep = false;
  };
  for (const unit of units) {
    const role = roleOf(unit);
    if (role === 'break') {
      flush();
      segments.push({ kind: 'item', item: unit });
      continue;
    }
    run.push(unit);
    if (role === 'step') hasStep = true;
  }
  flush();
  return segments;
}

/** One step of a run, as its line counts it. */
export interface CleanRunStep {
  readonly kind: StepKind;
  readonly failed?: boolean;
  /** No result has arrived; never claim a successful plan write. */
  readonly pending?: boolean;
  /** Stopped by an approval rule or the person before it ran. */
  readonly blocked?: boolean;
  /**
   * Cut off without a result (a restart, say). Exclusive with `failed`: an
   * interrupted step counts here, never as an error.
   */
  readonly interrupted?: boolean;
}

/**
 * The steps a running turn's line may count: the ones already done. A call
 * still waiting for its result, and the thought the run ends on, are what
 * the turn is doing now, which its status line says. Empty until a call has
 * finished, so the line never reads "Thought" and then changes its words.
 */
export function settledCleanRunSteps(
  steps: readonly CleanRunStep[],
): CleanRunStep[] {
  const settled = steps.filter(
    (step, index) =>
      step.pending !== true &&
      !(step.kind === 'thinking' && index === steps.length - 1),
  );
  return settled.some((step) => step.kind !== 'thinking') ? settled : [];
}

const RUN_PHRASES: Record<StepKind, (count: number) => string> = {
  thinking: () => 'thought',
  search: (count) => `searched ${count === 1 ? 'once' : `${count} times`}`,
  read: (count) => `read ${count} ${count === 1 ? 'file' : 'files'}`,
  edit: (count) => `edited ${count} ${count === 1 ? 'file' : 'files'}`,
  plan: (count) => `wrote plan${count === 1 ? '' : ` ${count} times`}`,
  command: (count) => `ran ${count} ${count === 1 ? 'command' : 'commands'}`,
  graph: () => 'checked the code graph',
  web: () => 'searched the web',
  tasks: () => 'updated the task list',
  agent: (count) => `ran ${count} ${count === 1 ? 'agent' : 'agents'}`,
  question: (count) =>
    `asked ${count === 1 ? 'a question' : `${count} questions`}`,
  secrets: (count) =>
    `requested secrets${count === 1 ? '' : ` ${count} times`}`,
  other: (count) => `used ${count} ${count === 1 ? 'tool' : 'tools'}`,
};

/**
 * A finished run's line: what it did, counted, kinds in the order they
 * first appear ("Ran 4 commands, read 2 files"), and how many steps failed,
 * were blocked or were interrupted, each step counted once. Thinking only shows when the run did nothing else
 * ("Thought").
 */
export function describeCleanRun(steps: readonly CleanRunStep[]): {
  label: string;
  failed: number;
  blocked: number;
  interrupted: number;
  /** The kind the line leads with: the first one its words name. */
  kind: StepKind | undefined;
} {
  const counts = new Map<StepKind | PlanWriteStatus, number>();
  let failed = 0;
  let blocked = 0;
  let interrupted = 0;
  for (const step of steps) {
    if (step.blocked === true) {
      blocked += 1;
      continue;
    }
    const key =
      step.kind !== 'plan'
        ? step.kind
        : step.interrupted
          ? 'interrupted'
          : step.failed
            ? 'failed'
            : step.pending
              ? 'pending'
              : step.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (step.interrupted === true) interrupted += 1;
    else if (step.failed === true) failed += 1;
  }
  if (counts.size > 1) counts.delete('thinking');
  const sentence = Array.from(counts, ([kind, count]) =>
    kind === 'pending' || kind === 'failed' || kind === 'interrupted'
      ? describeStepCounts([['plan', count, kind]]).toLowerCase()
      : RUN_PHRASES[kind](count),
  ).join(', ');
  const first = counts.keys().next().value;
  return {
    label:
      sentence === '' && blocked > 0
        ? 'No tools ran'
        : sentence.charAt(0).toUpperCase() + sentence.slice(1),
    failed,
    blocked,
    interrupted,
    kind:
      (first === 'pending' || first === 'failed' || first === 'interrupted'
        ? 'plan'
        : first) ?? steps[0]?.kind,
  };
}
