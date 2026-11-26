import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Job, Pipeline, Step } from '@canopy/pipeline-interop/document';
import { assignStepIds } from '@canopy/pipeline-interop/normalize-pipeline';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import {
  projectWorkflowStack,
  workflowStackEditableKeys,
} from '@canopy/pipeline-interop/workflow-designer';
import {
  insertWorkflowStep,
  moveWorkflowStep,
  newWorkflowStepId,
  removeWorkflowStep,
  setWorkflowStepId,
  type WorkflowDesignerEditResult,
} from '@canopy/pipeline-interop/workflow-designer-edits';
import { dependencyStepIds } from '@canopy/pipeline-interop/workflow-designer-edits';
import { workflowJobStructure } from '@canopy/pipeline-interop/workflow-designer-job-edits';
import * as workflowDesignerSplitEdits from '@canopy/pipeline-interop/workflow-designer-split-edits';

const { splitWorkflowJob } = workflowDesignerSplitEdits;

const ROOT = resolve(__dirname, '../../../../../..');
const CORPUS_DIRS = [
  'packages/desktop-shared/resources/pipelines',
  'example-pipelines',
];

function renderBrandTokens(text: string): string {
  return text
    .replaceAll('{{BRAND_EXPRESSION_ROOT}}', 'canopy')
    .replaceAll('{{BRAND_REPORT_ACTION_ID}}', 'pipeline-report')
    .replaceAll('{{BRAND_OUTPUT_VARIABLE_NAME}}', 'brandOutput')
    .replace(/\{\{BRAND_[A-Z_]+\}\}/g, 'BRAND');
}

const corpus = CORPUS_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      file: `${dir}/${name}`,
      pipeline: parsePipelineText(
        renderBrandTokens(readFileSync(join(ROOT, dir, name), 'utf8')),
      ),
    })),
);

/**
 * An oracle written apart from the edit module: the step each `steps.<id>`
 * and `steps['<id>']` in a reader names, by position, before and after.
 */
function staticReads(value: unknown): string[] {
  const text = JSON.stringify(value) ?? '';
  return [
    ...[...text.matchAll(/\bsteps\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (match) => match[1] ?? '',
    ),
    ...[...text.matchAll(/\bsteps\s*\[\s*\\?'([^'\\]*)\\?'\s*\]/g)].map(
      (match) => match[1] ?? '',
    ),
  ];
}

/**
 * The step `id` names for a reader at `reader`, and whether it has run: the
 * executor enters every step as pending before the first one runs.
 */
function producerAt(
  job: Job,
  jobId: string,
  id: string,
  reader: number,
): { readonly step: Step; readonly ran: boolean } | undefined {
  const ids = assignStepIds(job.steps, jobId).map((step) => step.id);
  const at = ids.indexOf(id);
  const step = job.steps[at];
  return step ? { step, ran: at < reader } : undefined;
}

function sameProducer(
  before: ReturnType<typeof producerAt>,
  after: ReturnType<typeof producerAt>,
  origin: (step: Step) => Step,
): void {
  expect(
    after === undefined ? undefined : { ...after, step: origin(after.step) },
  ).toEqual(before);
}

/** Fails when an applied edit changed what a kept reader reads. */
function expectReadsKept(
  before: Pipeline,
  after: Pipeline,
  jobId: string,
  origin: (step: Step) => Step,
): void {
  const was = before.jobs[jobId];
  const now = after.jobs[jobId];
  if (!was || !now) throw new Error(`missing job ${jobId}`);
  for (const [otherId, other] of Object.entries(before.jobs))
    if (otherId !== jobId) expect(after.jobs[otherId]).toBe(other);
  const nowOrigins = now.steps.map(origin);
  was.steps.forEach((step, beforeIndex) => {
    const afterIndex = nowOrigins.indexOf(step);
    if (afterIndex < 0) return;
    for (const id of staticReads(step)) {
      sameProducer(
        producerAt(was, jobId, id, beforeIndex),
        producerAt(now, jobId, id, afterIndex),
        origin,
      );
    }
  });
  for (const value of Object.values(was.outputs ?? {}))
    for (const id of staticReads(value)) {
      sameProducer(
        producerAt(was, jobId, id, Infinity),
        producerAt(now, jobId, id, Infinity),
        origin,
      );
    }
}

const kind = (result: WorkflowDesignerEditResult): string =>
  result.ok ? 'ok' : result.refusal.kind;

describe('workflow designer edits keep every step read (CAN-4224)', () => {
  it.each(corpus.map(({ file, pipeline }) => [file, pipeline] as const))(
    '%s: every offered edit keeps every read, or is refused unchanged',
    (_file, pipeline) => {
      const snapshot = JSON.stringify(pipeline);
      const keys = workflowStackEditableKeys(projectWorkflowStack(pipeline));
      for (const key of keys) {
        const match = /^step:(.+):(\d+)$/.exec(key);
        if (!match) continue;
        const jobId = match[1] ?? '';
        const index = Number(match[2]);
        const job = pipeline.jobs[jobId];
        if (!job) throw new Error(key);
        const same = (step: Step): Step => step;
        const renamed = (step: Step): Step =>
          job.steps.includes(step) ? step : (job.steps[index] ?? step);
        const edits: [WorkflowDesignerEditResult, (step: Step) => Step][] = [
          [removeWorkflowStep(pipeline, jobId, index), same],
          [moveWorkflowStep(pipeline, jobId, index, index - 1), same],
          [moveWorkflowStep(pipeline, jobId, index, index + 1), same],
          [
            insertWorkflowStep(pipeline, jobId, index + 1, {
              id: newWorkflowStepId(pipeline, jobId, 'added'),
              run: 'echo added',
            }),
            same,
          ],
          [setWorkflowStepId(pipeline, jobId, index, 'renamed_step'), renamed],
        ];
        for (const [result, origin] of edits) {
          expect(JSON.stringify(pipeline)).toBe(snapshot);
          if (result.ok)
            expectReadsKept(pipeline, result.pipeline, jobId, origin);
        }
      }
    },
  );

  const job = (steps: Step[], outputs?: Record<string, string>): Pipeline => ({
    name: 'Edits',
    on: 'dispatch',
    jobs: { build: { steps, ...(outputs ? { outputs } : {}) } },
  });

  it('refuses removing or moving a step another step reads', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'b', run: 'echo ${{ steps.a.outputs.x }}' },
    ]);
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('reads');
    expect(kind(moveWorkflowStep(pipeline, 'build', 0, 1))).toBe('reads');
    expect(kind(removeWorkflowStep(pipeline, 'build', 1))).toBe('ok');
    const removed = removeWorkflowStep(pipeline, 'build', 0);
    expect(removed.ok ? null : removed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'step', stepIndex: 1, id: 'b' },
    });
  });

  it.each<[string, Partial<Step>]>([
    ['outcome in a step condition', { if: "steps.a.outcome == 'failure'" }],
    [
      'conclusion in a step condition',
      { if: "steps.a.conclusion == 'success'" },
    ],
    ['a bracketed name', { run: "${{ steps['a'].outputs.x }}" }],
    ['a working directory', { working_directory: '${{ steps.a.outputs.d }}' }],
    [
      'a target',
      { target: { scope: 'directory', path: '${{ steps.a.outputs.d }}' } },
    ],
    [
      'an input',
      { uses: 'builtin/notify', with: { title: '${{ steps.a.outputs.t }}' } },
    ],
    ['an environment variable', { env: { T: '${{ steps.a.outputs.t }}' } }],
  ])('sees a read through %s', (_label, reader) => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'b', run: 'echo b', ...reader },
    ]);
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('reads');
  });

  it('keeps what job outputs publish to other jobs', () => {
    const pipeline = job(
      [
        { id: 'a', run: 'echo a' },
        { id: 'b', run: 'echo b' },
      ],
      { result: '${{ steps.a.outputs.r }}' },
    );
    const refused = removeWorkflowStep(pipeline, 'build', 0);
    expect(refused.ok ? null : refused.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'output', key: 'result' },
    });
    // If b fails before a runs, the output would publish nothing where it
    // published a's result, so a may not move below b.
    const moved = moveWorkflowStep(pipeline, 'build', 0, 1);
    expect(moved.ok ? null : moved.refusal).toEqual({
      kind: 'order',
      reader: { kind: 'output', key: 'result' },
    });
  });

  it('moves steps that cross no step anything reads', () => {
    const pipeline = job(
      [
        { id: 'a', run: 'echo a' },
        { id: 'b', run: 'echo b' },
        { id: 'c', run: 'echo c' },
      ],
      { result: '${{ steps.a.outputs.r }}' },
    );
    expect(kind(moveWorkflowStep(pipeline, 'build', 2, 1))).toBe('ok');
    // Moving b above a changes what must succeed before a runs.
    expect(kind(moveWorkflowStep(pipeline, 'build', 1, 0))).toBe('order');
  });

  it('keeps the steps a status function checks', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'b', run: 'exit 1' },
      { id: 'report', if: 'failure()', run: 'echo failed' },
      { id: 'after', run: 'echo after' },
    ]);
    // Above b, the report runs before the failure it reports.
    const moved = moveWorkflowStep(pipeline, 'build', 2, 1);
    expect(moved.ok ? null : moved.refusal).toEqual({
      kind: 'outcomes',
      reader: { kind: 'step', stepIndex: 2, id: 'report' },
    });
    expect(kind(moveWorkflowStep(pipeline, 'build', 1, 3))).toBe('outcomes');
    // Their order counts too: each can write what the report's run sees.
    expect(kind(moveWorkflowStep(pipeline, 'build', 0, 1))).toBe('outcomes');
    expect(kind(moveWorkflowStep(pipeline, 'build', 3, 2))).toBe('outcomes');
    // `cancelled()` and `success()` read outcomes too.
    for (const condition of ['cancelled()', 'success() || inputs.force']) {
      const watched = job([
        { id: 'a', run: 'echo a' },
        { id: 'check', if: condition, run: 'echo check' },
      ]);
      expect(kind(moveWorkflowStep(watched, 'build', 1, 0))).toBe('outcomes');
    }
    // A new step is the edit itself.
    expect(
      kind(
        insertWorkflowStep(pipeline, 'build', 1, { id: 'n', run: 'echo n' }),
      ),
    ).toBe('ok');
  });

  it('counts a read of a later step, which is pending when it is read', () => {
    const pipeline = job([
      { id: 'early', if: 'steps.late', run: 'echo early' },
      { id: 'mid', run: 'echo mid' },
      { id: 'late', run: 'echo late' },
    ]);
    // Before the edit early sees late pending; after it, late is missing.
    const removed = removeWorkflowStep(pipeline, 'build', 2);
    expect(removed.ok ? null : removed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'step', stepIndex: 0, id: 'early' },
    });
    expect(kind(setWorkflowStepId(pipeline, 'build', 2, 'later'))).toBe(
      'reads',
    );
    // Moved above early, late has run by the time early reads it.
    expect(kind(moveWorkflowStep(pipeline, 'build', 2, 0))).toBe('reads');
    // Still pending, so this move reads the same.
    expect(kind(moveWorkflowStep(pipeline, 'build', 2, 1))).toBe('ok');
    // A whole-context read sees the pending steps too.
    const whole = job([
      { id: 'dump', run: 'echo ${{ toJson(steps) }}' },
      { id: 'a', run: 'echo a' },
    ]);
    expect(kind(removeWorkflowStep(whole, 'build', 1))).toBe('reads');
    expect(
      kind(insertWorkflowStep(whole, 'build', 2, { id: 'n', run: 'echo n' })),
    ).toBe('reads');
  });

  it('keeps the run order of the steps before a read step', () => {
    const pipeline = job(
      [
        { id: 'one', run: 'echo "MODE=1" >> "$GITHUB_ENV"' },
        { id: 'two', run: 'echo "MODE=2" >> "$GITHUB_ENV"' },
        { id: 'p', if: "env.MODE == '2'", run: 'echo r=1 >> "$GITHUB_OUTPUT"' },
        { id: 'tail', run: 'echo tail' },
      ],
      { result: '${{ steps.p.outputs.r }}' },
    );
    // Swapped, the last write before p is MODE=1, so p no longer runs.
    const swapped = moveWorkflowStep(pipeline, 'build', 0, 1);
    expect(swapped.ok ? null : swapped.refusal).toEqual({
      kind: 'order',
      reader: { kind: 'output', key: 'result' },
    });
    expect(kind(moveWorkflowStep(pipeline, 'build', 3, 2))).toBe('order');
  });

  it('reads templates on one line, as the executor interpolates them', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      {
        id: 'doc',
        // Its expression spans lines, so the executor leaves it as text.
        run: "cat <<'EOF'\n${{ steps.a.outputs.x\n  || 'none' }}\nEOF",
      },
    ]);
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('ok');
  });

  it('skips dependency entries that are not mappings', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'b', run: 'echo b' },
    ]);
    Reflect.set(pipeline, 'dependencies', [null]);
    expect(kind(removeWorkflowStep(pipeline, 'build', 1))).toBe('ok');
  });

  it('reads manifest step IDs as normalization trims them', () => {
    const pipeline: Pipeline = {
      ...job([{ id: 'a', run: 'echo a' }]),
      dependencies: [
        {
          id: 'github',
          kind: 'connector',
          connector: 'github',
          steps: [' a '],
        },
      ],
    };
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('reads');
    expect(newWorkflowStepId(pipeline, 'build', 'a')).toBe('a_2');
  });

  it('keeps generated step ids resolving to the same step', () => {
    const pipeline = job([
      { run: 'echo zero' },
      { run: 'echo one' },
      { id: 'r', run: 'echo ${{ steps.__auto_step_1.outputs.x }}' },
    ]);
    // Each of these shifts which unnamed step is __auto_step_1.
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('reads');
    expect(kind(moveWorkflowStep(pipeline, 'build', 0, 1))).toBe('reads');
    expect(kind(setWorkflowStepId(pipeline, 'build', 0, 'named'))).toBe(
      'reads',
    );
    const named = job([
      { id: 'zero', run: 'echo zero' },
      { run: 'echo one' },
      { id: 'r', run: 'echo ${{ steps.__auto_step_0.outputs.x }}' },
    ]);
    expect(kind(setWorkflowStepId(named, 'build', 0, undefined))).toBe('reads');
  });

  it('ignores job conditions and environment, which see no step state', () => {
    const pipeline: Pipeline = {
      name: 'Job level',
      on: 'dispatch',
      jobs: {
        build: {
          if: "inputs.go == 'yes'",
          env: { NOTE: 'steps.a.outputs.x' },
          steps: [
            { id: 'a', run: 'echo a' },
            { id: 'b', run: 'echo b' },
          ],
        },
      },
    };
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('ok');
  });

  it('refuses any edit a step that picks its step at run time could see', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'pick', run: 'echo ${{ steps[inputs.which].outputs.x }}' },
      { id: 'z', run: 'echo z' },
    ]);
    expect(
      kind(insertWorkflowStep(pipeline, 'build', 1, { id: 'n', run: 'x' })),
    ).toBe('reads');
    expect(kind(removeWorkflowStep(pipeline, 'build', 0))).toBe('reads');
    // A step after the reader is in its sight too, as pending.
    expect(kind(removeWorkflowStep(pipeline, 'build', 2))).toBe('reads');
    const whole = job([
      { id: 'a', run: 'echo a' },
      { id: 'dump', run: 'echo ${{ toJson(steps) }}' },
    ]);
    expect(kind(removeWorkflowStep(whole, 'build', 0))).toBe('reads');
  });

  it('refuses a new step that a dangling read would start naming', () => {
    const pipeline = job([
      { id: 'b', run: 'echo ${{ steps.ghost.outputs.x }}' },
    ]);
    expect(
      kind(insertWorkflowStep(pipeline, 'build', 0, { id: 'ghost', run: 'x' })),
    ).toBe('reads');
    expect(newWorkflowStepId(pipeline, 'build', 'ghost')).toBe('ghost_2');
  });

  it('renames only a step nothing reads, to a valid unique ID', () => {
    const pipeline = job([
      { id: 'a', run: 'echo a' },
      { id: 'b', run: 'echo ${{ steps.a.outputs.x }}' },
    ]);
    expect(kind(setWorkflowStepId(pipeline, 'build', 0, 'renamed'))).toBe(
      'reads',
    );
    expect(kind(setWorkflowStepId(pipeline, 'build', 1, 'renamed'))).toBe('ok');
    expect(kind(setWorkflowStepId(pipeline, 'build', 1, 'a'))).toBe(
      'duplicate-id',
    );
    expect(kind(setWorkflowStepId(pipeline, 'build', 1, 'bad-id'))).toBe(
      'invalid-id',
    );
  });

  it('tracks a step YAML repeats through an alias by its position', () => {
    const pipeline = parsePipelineText(`pipeline:
  name: Aliases
  on: dispatch
  jobs:
    build:
      steps:
        - &echo
          run: echo \${{ steps.c.outputs.x }}
        - id: a
          run: echo a
        - *echo
        - id: c
          run: echo c
`);
    const steps = pipeline.jobs.build?.steps ?? [];
    expect(steps[0]).toBe(steps[2]);
    // Moving c up puts it before the second copy, which then starts reading
    // it; the first copy still reads nothing.
    expect(kind(moveWorkflowStep(pipeline, 'build', 3, 1))).toBe('reads');
    expect(kind(moveWorkflowStep(pipeline, 'build', 1, 0))).toBe('ok');
  });

  it('keeps the order a whole-context read sees', () => {
    const pipeline = job([
      { id: 'x', run: 'echo x' },
      { id: 'y', run: 'echo y' },
      { id: 'dump', run: 'echo ${{ toJson(steps) }}' },
    ]);
    // The same steps have run, but toJSON would list them the other way.
    expect(kind(moveWorkflowStep(pipeline, 'build', 0, 1))).toBe('reads');
  });

  it('skips a send step’s literal text, which the executor never evaluates', () => {
    const send = (literal: boolean): Pipeline =>
      job([
        { id: 'a', run: 'echo a' },
        {
          id: 'send',
          uses: 'builtin/send-agent-message',
          with: {
            text: 'Ask ${{ steps.a.outputs.x }}',
            ...(literal ? { literal_text: true } : {}),
          },
        },
      ]);
    expect(kind(removeWorkflowStep(send(true), 'build', 0))).toBe('ok');
    expect(kind(removeWorkflowStep(send(false), 'build', 0))).toBe('reads');
  });

  it('keeps the steps a dependency manifest names', () => {
    const pipeline: Pipeline = {
      ...job([
        { id: 'a', run: 'echo a' },
        { id: 'b', run: 'echo b' },
      ]),
      dependencies: [
        { id: 'github', kind: 'connector', connector: 'github', steps: ['a'] },
      ],
    };
    const removed = removeWorkflowStep(pipeline, 'build', 0);
    expect(removed.ok ? null : removed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'dependency', id: 'github' },
    });
    expect(kind(setWorkflowStepId(pipeline, 'build', 0, 'renamed'))).toBe(
      'reads',
    );
    expect(kind(removeWorkflowStep(pipeline, 'build', 1))).toBe('ok');
    expect(newWorkflowStepId(pipeline, 'build', 'a')).toBe('a_2');
  });

  it('edits a grouped job, and only jobs whose steps it can read', () => {
    const pipeline: Pipeline = {
      name: 'Matrix',
      on: 'dispatch',
      jobs: {
        m: {
          strategy: { matrix: { size: [1, 2] } },
          steps: [{ run: 'echo m' }],
        },
      },
    };
    // A matrix job is grouped, and its steps edit as any card's do
    // (CAN-4224 phase 08).
    expect(removeWorkflowStep(pipeline, 'm', 0).ok).toBe(true);
    expect(insertWorkflowStep(pipeline, 'm', 0, { id: 'n', run: 'x' }).ok).toBe(
      true,
    );
    const unreadable = parsePipelineText(`pipeline:
  name: Bad steps
  on: dispatch
  jobs:
    one:
      steps: {}
`);
    expect(
      kind(insertWorkflowStep(unreadable, 'one', 0, { id: 'n', run: 'x' })),
    ).toBe('not-editable');
    expect(kind(removeWorkflowStep(pipeline, 'constructor', 0))).toBe(
      'not-editable',
    );
  });
});

describe('workflow designer job structure (CAN-4224 phase 08)', () => {
  const pipeline: Pipeline = {
    name: 'Structure',
    on: 'dispatch',
    jobs: {
      build: { outputs: { tag: 'v1' }, steps: [{ run: 'make' }] },
      lint: { steps: [{ run: 'lint' }] },
      test: {
        needs: ['build', 'lint'],
        steps: [{ run: 'echo ${{ needs.build.outputs.tag }}' }],
      },
      ship: {
        needs: 'test',
        if: "needs['test'].result == 'success'",
        steps: [{ run: 'ship' }],
      },
    },
  };

  it('keeps a need a job reads by name, and frees the rest', () => {
    expect([...workflowJobStructure(pipeline, 'test').readNeeds]).toEqual([
      'build',
    ]);
  });

  it('lists the jobs that wait on a job, directly or not', () => {
    expect(
      [...workflowJobStructure(pipeline, 'build').dependents].sort(),
    ).toEqual(['ship', 'test']);
  });

  it('keeps every need of a job that reads needs whole', () => {
    const whole: Pipeline = {
      name: 'Whole',
      on: 'dispatch',
      jobs: {
        a: { steps: [{ run: 'a' }] },
        b: { steps: [{ run: 'b' }] },
        synth: {
          needs: ['a', 'b'],
          steps: [{ run: 'echo ${{ toJson(needs) }}' }],
        },
      },
    };
    expect([...workflowJobStructure(whole, 'synth').readNeeds]).toEqual([
      'a',
      'b',
    ]);
  });

  it('skips a need that is not a job ID', () => {
    const odd = parsePipelineText(`pipeline:
  name: Odd needs
  on: dispatch
  jobs:
    a:
      steps:
        - run: a
    b:
      needs: [a, 7]
      steps:
        - run: b
`);
    expect(() => workflowJobStructure(odd, 'b')).not.toThrow();
    expect([...workflowJobStructure(odd, 'a').dependents]).toEqual(['b']);
  });

  it('keeps every need of a job that reads a need by an escaped key', () => {
    const escapedKey: Pipeline = {
      name: 'Escaped',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ run: 'b' }] },
        lint: { steps: [{ run: 'l' }] },
        test: {
          needs: ['build', 'lint'],
          if: "needs['b\\uild'].result == 'success'",
          steps: [{ run: 't' }],
        },
      },
    };
    expect([...workflowJobStructure(escapedKey, 'test').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
  });

  it('reads a manifest that is not a list as naming no steps', () => {
    const bad = parsePipelineText(`pipeline:
  name: Bad manifest
  on: dispatch
  dependencies: {}
  jobs:
    build:
      steps:
        - id: compile
          run: make
`);
    expect(dependencyStepIds(bad)).toEqual([]);
  });

  it('marks a split path, whose structure changes only through the split', () => {
    const split = splitWorkflowJob(
      {
        name: 'Split',
        on: 'dispatch',
        jobs: { decide: { steps: [{ run: 'echo' }] } },
      },
      'decide',
    );
    if (!split.ok) throw new Error('split refused');
    const [path] = Object.keys(split.pipeline.jobs).filter(
      (jobId) => jobId !== 'decide',
    );
    expect(workflowJobStructure(split.pipeline, path ?? '').splitPath).toBe(
      true,
    );
    expect(workflowJobStructure(split.pipeline, 'decide').splitPath).toBe(
      false,
    );
  });

  it('reads no need from the text of a string', () => {
    const literal: Pipeline = {
      name: 'Literal',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ run: 'b' }] },
        test: {
          needs: 'build',
          if: "inputs.label == 'needs.build' || inputs.label == 'needs'",
          steps: [{ run: 't' }],
        },
      },
    };
    expect([...workflowJobStructure(literal, 'test').readNeeds]).toEqual([]);
  });

  it('reads a template in a field named if that is not a condition', () => {
    const envIf: Pipeline = {
      name: 'Env if',
      on: 'dispatch',
      jobs: {
        build: { outputs: { tag: 'v1' }, steps: [{ run: 'b' }] },
        ship: {
          needs: 'build',
          env: { if: "'${{ needs.build.outputs.tag }}'" },
          steps: [{ run: 's' }],
        },
      },
    };
    expect([...workflowJobStructure(envIf, 'ship').readNeeds]).toEqual([
      'build',
    ]);
  });

  it('reads an input named needs as an input', () => {
    const input: Pipeline = {
      name: 'Input needs',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ run: 'b' }] },
        test: {
          needs: 'build',
          if: 'inputs.needs == true',
          steps: [{ run: 't' }],
        },
      },
    };
    expect([...workflowJobStructure(input, 'test').readNeeds]).toEqual([]);
  });

  it('keeps a path a path when a job is added after it', () => {
    const split = splitWorkflowJob(
      {
        name: 'Split',
        on: 'dispatch',
        jobs: { decide: { steps: [{ run: 'echo' }] } },
      },
      'decide',
    );
    if (!split.ok) throw new Error('split refused');
    const [path] = Object.keys(split.pipeline.jobs).filter(
      (jobId) => jobId !== 'decide',
    );
    const after: Pipeline = {
      ...split.pipeline,
      jobs: {
        ...split.pipeline.jobs,
        report: { needs: [path ?? ''], steps: [{ run: 'r' }] },
      },
    };
    expect(workflowJobStructure(after, path ?? '').splitPath).toBe(true);
    // And no job can be given a path as a need.
    expect(workflowJobStructure(after, 'report').pathJobs.has(path ?? '')).toBe(
      true,
    );
  });

  it('finds a read on a later line after a literal ${{ in a heredoc', () => {
    const heredoc: Pipeline = {
      name: 'Heredoc',
      on: 'dispatch',
      jobs: {
        build: { outputs: { ok: 'yes' }, steps: [{ run: 'b' }] },
        ship: {
          needs: 'build',
          steps: [
            {
              run: "cat <<'EOF'\nliteral ${{ it's\nEOF\necho \"${{ needs.build.outputs.ok }}\"",
            },
          ],
        },
      },
    };
    expect([...workflowJobStructure(heredoc, 'ship').readNeeds]).toEqual([
      'build',
    ]);
  });

  it('finds a template across lines after a literal ${{', () => {
    const multiline: Pipeline = {
      name: 'Multiline',
      on: 'dispatch',
      jobs: {
        build: { outputs: { ok: 'yes' }, steps: [{ run: 'b' }] },
        ship: {
          needs: 'build',
          steps: [
            {
              run: "cat <<'EOF'\nliteral ${{ it's\nEOF\necho ${{\n  needs.build.outputs.ok\n}}",
            },
          ],
        },
      },
    };
    expect([...workflowJobStructure(multiline, 'ship').readNeeds]).toEqual([
      'build',
    ]);
  });

  it('scans many openers, unclosed or sharing one }}, quickly', () => {
    const many: Pipeline = {
      name: 'Many',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ run: 'b' }] },
        ship: {
          needs: 'build',
          steps: [
            { run: '${{ '.repeat(20_000) },
            { run: `${'${{ '.repeat(20_000)}}}` },
          ],
        },
      },
    };
    const started = performance.now();
    workflowJobStructure(many, 'ship');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('leaves a compound condition on a route editable', () => {
    const split = splitWorkflowJob(
      {
        name: 'Split',
        on: 'dispatch',
        jobs: { decide: { steps: [{ run: 'echo' }] } },
      },
      'decide',
    );
    if (!split.ok) throw new Error('split refused');
    const [path] = Object.keys(split.pipeline.jobs).filter(
      (jobId) => jobId !== 'decide',
    );
    const guard = String(split.pipeline.jobs[path ?? '']?.if);
    const compound: Pipeline = {
      ...split.pipeline,
      jobs: {
        ...split.pipeline.jobs,
        extra: {
          needs: ['decide'],
          if: `${guard} || inputs.force`,
          steps: [{ run: 'e' }],
        },
      },
    };
    expect(workflowJobStructure(compound, 'extra').splitPath).toBe(false);
    expect(workflowJobStructure(compound, path ?? '').splitPath).toBe(true);
  });

  it('keeps every need of a job that runs on how its needs ended', () => {
    const recovery: Pipeline = {
      name: 'Recovery',
      on: 'dispatch',
      jobs: {
        build: { steps: [{ run: 'b' }] },
        lint: { steps: [{ run: 'l' }] },
        recover: {
          needs: ['build', 'lint'],
          if: 'failure()',
          steps: [{ run: 'r' }],
        },
        tidy: {
          needs: ['build', 'lint'],
          if: "inputs.note == 'failure()'",
          steps: [{ run: 't' }],
        },
        rescue: {
          needs: ['build', 'lint'],
          if: '!success()',
          steps: [{ run: 'r' }],
        },
        gated: {
          needs: ['build', 'lint'],
          if: 'success() && inputs.go',
          steps: [{ run: 'g' }],
        },
        forced: {
          needs: ['build', 'lint'],
          if: 'success() && inputs.go || inputs.force',
          steps: [{ run: 'f' }],
        },
        nested: {
          needs: ['build', 'lint'],
          if: 'success() && (inputs.go || inputs.force)',
          steps: [{ run: 'n' }],
        },
        indexed: {
          needs: ['build', 'lint'],
          if: 'success() && inputs.flags[inputs.primary || inputs.fallback]',
          steps: [{ run: 'i' }],
        },
        keyed: {
          needs: ['build', 'lint'],
          if: "success() && inputs.needs['('] || inputs.force",
          steps: [{ run: 'k' }],
        },
        named: {
          needs: ['build', 'lint'],
          if: "failure('build')",
          steps: [{ run: 'n' }],
        },
      },
    };
    expect([...workflowJobStructure(recovery, 'recover').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
    // Inside a string it's text.
    expect([...workflowJobStructure(recovery, 'tidy').readNeeds]).toEqual([]);
    // A negated success() runs on a need failing, so each stays.
    expect([...workflowJobStructure(recovery, 'rescue').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
    // A leading success() is the default, so needs can go.
    expect([...workflowJobStructure(recovery, 'gated').readNeeds]).toEqual([]);
    // An || inside parentheses stays gated by it.
    expect([...workflowJobStructure(recovery, 'nested').readNeeds]).toEqual([]);
    expect([...workflowJobStructure(recovery, 'indexed').readNeeds]).toEqual(
      [],
    );
    // A bracket inside a quoted key is text, so the || is still top level.
    expect([...workflowJobStructure(recovery, 'keyed').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
    // A status call with an argument reads how the needs ended too.
    expect([...workflowJobStructure(recovery, 'named').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
    // Unless an || leaves part of the condition ungated by it.
    expect([...workflowJobStructure(recovery, 'forced').readNeeds]).toEqual([
      'build',
      'lint',
    ]);
  });

  it('works out a large workflow quickly', () => {
    const jobs: Pipeline['jobs'] = {};
    for (let index = 0; index < 400; index += 1)
      jobs[`job_${String(index)}`] = {
        needs: Array.from(
          { length: Math.min(index, 10) },
          (_, back) => `job_${String(index - back - 1)}`,
        ),
        outputs: { value: 'x' },
        steps: [{ run: 'echo' }],
      };
    // One job needs every other, with long step text. That text is scanned
    // once. Scanning it once per need calls `reads` 401 times here and still
    // finishes in the same half-second range, so a wall-clock budget cannot
    // tell the two apart.
    jobs.fan_in = {
      needs: Object.keys(jobs),
      steps: Array.from({ length: 40 }, (_, index) => ({
        run: `echo \${{ needs.job_${String(index)}.outputs.value }} ${'x'.repeat(2000)}`,
      })),
    };
    const reads = jest.spyOn(workflowDesignerSplitEdits, 'reads');
    try {
      workflowJobStructure({ name: 'Large', on: 'dispatch', jobs }, 'job_200');
      reads.mockClear();
      const fanIn = workflowJobStructure(
        { name: 'Large', on: 'dispatch', jobs },
        'fan_in',
      );
      expect(reads).toHaveBeenCalledTimes(1);
      expect(fanIn.readNeeds.size).toBe(40);
    } finally {
      reads.mockRestore();
    }
  });

  it('marks a job a path only when it reads the router route', () => {
    const constant: Pipeline = {
      name: 'Constant',
      on: 'dispatch',
      jobs: {
        decide: {
          outputs: { ready: 'yes' },
          steps: [{ id: 'pick', uses: 'builtin/router' }],
        },
        follow: {
          needs: 'decide',
          if: "success() && needs.decide.outputs.ready == 'yes'",
          steps: [{ run: 'f' }],
        },
      },
    };
    expect(workflowJobStructure(constant, 'follow').splitPath).toBe(false);
  });

  it('reads no need from a literal agent prompt', () => {
    const literal: Pipeline = {
      name: 'Literal prompt',
      on: 'dispatch',
      jobs: {
        build: { outputs: { tag: 'v1' }, steps: [{ run: 'b' }] },
        tell: {
          needs: 'build',
          steps: [
            {
              uses: 'builtin/send-agent-message',
              with: {
                literal_text: true,
                text: 'Use ${{ needs.build.outputs.tag }} as written.',
              },
            },
          ],
        },
      },
    };
    expect([...workflowJobStructure(literal, 'tell').readNeeds]).toEqual([]);
  });
});
