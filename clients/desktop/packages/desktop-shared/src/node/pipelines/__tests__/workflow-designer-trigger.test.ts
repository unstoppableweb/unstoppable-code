import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  type Pipeline,
} from '@canopy/pipeline-interop/document';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { BRAND } from '@canopy/brand/current';
import { buildExpressionContext } from '@canopy/execution-engine/node/pipelines/executor/execution-context';
import {
  projectWorkflowTrigger,
  runContextRoots,
  setManualEntries,
  WORKFLOW_MANUAL_ENTRIES,
  type WorkflowManualEntry,
  type WorkflowTriggerEditResult,
} from '@canopy/pipeline-interop/workflow-designer-trigger';
import {
  setTriggerInputDefs,
  setTriggerTypes,
} from '@canopy/execution-engine/types/pipeline';

const ROOT = resolve(__dirname, '../../../../../..');
const CORPUS_DIRS = [
  'packages/desktop-shared/resources/pipelines',
  'example-pipelines',
];
// The corpus golden renders the brand's expression root as `canopy`, the
// name the executor also always registers the run context under.
const ROOTS = ['canopy'];

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

const kind = (result: WorkflowTriggerEditResult): string =>
  result.ok ? 'ok' : result.refusal.kind;

function applied(result: WorkflowTriggerEditResult): Pipeline {
  if (!result.ok) throw new Error(`refused: ${result.refusal.kind}`);
  return result.pipeline;
}

/** `on:` as the executor reads it: its types, and each type's inputs. */
function triggerMeaning(pipeline: Pipeline): unknown {
  return getTriggerTypes(pipeline.on)
    .slice()
    .sort()
    .map((type) => [type, getTriggerInputDefs(pipeline.on, type) ?? null]);
}

const TYPE_OF = {
  run: 'dispatch',
  'approved-plan': 'plan_ready',
  'new-task': 'task_ready',
} as const;

const autopilot = corpus.find(({ file }) =>
  file.endsWith('implementation-autopilot.yaml'),
)?.pipeline;

describe('workflow designer trigger card (CAN-4224)', () => {
  it('reads entries under exactly the roots the executor registers', () => {
    const context = buildExpressionContext({});
    const roots = runContextRoots(BRAND.internalName);
    expect(roots).toContain('canopy');
    for (const root of roots) expect(context[root]).toBe(context.canopy);
    expect(runContextRoots('acme-labs')).toEqual([
      'canopy',
      'acme-labs',
      'acmeLabs',
    ]);
  });

  it('keeps the moved trigger helpers at their old import path', () => {
    expect(setTriggerTypes('dispatch', ['dispatch', 'task_ready'])).toEqual({
      dispatch: {},
      task_ready: {},
    });
    expect(
      setTriggerInputDefs('dispatch', 'dispatch', {
        topic: { type: 'string' },
      }),
    ).toEqual({ dispatch: { inputs: { topic: { type: 'string' } } } });
  });

  it.each(corpus.map(({ file, pipeline }) => [file, pipeline] as const))(
    '%s: setting the entries it has changes nothing, and each toggle round-trips on:',
    (_file, pipeline) => {
      const trigger = projectWorkflowTrigger(pipeline, ROOTS);
      const options = { scheduled: false, expressionRoots: ROOTS };
      expect(
        applied(setManualEntries(pipeline, trigger.entries, options)),
      ).toBe(pipeline);
      for (const entry of WORKFLOW_MANUAL_ENTRIES) {
        const has = trigger.entries.includes(entry);
        const toggled = has
          ? trigger.entries.filter((other) => other !== entry)
          : [...trigger.entries, entry];
        const once = setManualEntries(pipeline, toggled, options);
        if (!once.ok) {
          // Only turning an entry off is ever refused, and only for a cause
          // the pipeline shows.
          expect(has).toBe(true);
          const usedBy = [
            ...trigger.stepEntries.values(),
            ...trigger.jobEntries.values(),
          ].includes(entry);
          const inputs = Object.keys(
            getTriggerInputDefs(pipeline.on, TYPE_OF[entry]) ?? {},
          ).length;
          const expected =
            toggled.length === 0 && !trigger.fromWorkflow
              ? 'no-entry'
              : trigger.entryReaders.length > 0
                ? 'entry-read'
                : usedBy
                  ? 'entry-used'
                  : inputs > 0
                    ? 'entry-inputs'
                    : 'none';
          expect(once.refusal.kind).toBe(expected);
          continue;
        }
        // The toggle took: exactly the asked entries, in the card's order.
        expect(projectWorkflowTrigger(once.pipeline, ROOTS).entries).toEqual(
          WORKFLOW_MANUAL_ENTRIES.filter((other) => toggled.includes(other)),
        );
        // Only `on:` changes, and `workflow` stays as it was.
        for (const key of Object.keys(pipeline))
          if (key !== 'on')
            expect(once.pipeline[key as keyof Pipeline]).toBe(
              pipeline[key as keyof Pipeline],
            );
        expect(projectWorkflowTrigger(once.pipeline, ROOTS).fromWorkflow).toBe(
          trigger.fromWorkflow,
        );
        const back = applied(
          setManualEntries(once.pipeline, trigger.entries, options),
        );
        expect(triggerMeaning(back)).toEqual(triggerMeaning(pipeline));
      }
    },
  );

  it("annotates autopilot's two task-only steps, and guards their entry", () => {
    if (!autopilot) throw new Error('no autopilot');
    const trigger = projectWorkflowTrigger(autopilot, ROOTS);
    expect(trigger.entries).toEqual(['approved-plan', 'new-task']);
    expect([...trigger.stepEntries]).toEqual([
      ['step:prepare_plan:0', 'new-task'],
      ['step:prepare_plan:1', 'new-task'],
    ]);
    const steps = autopilot.jobs.prepare_plan?.steps;
    expect(steps?.[0]?.id).toBe('create_task_ready_plan');
    expect(steps?.[1]?.id).toBe('publish_task_ready_plan');
    // A root the executor doesn't register reads nothing.
    expect(projectWorkflowTrigger(autopilot, ['other']).stepEntries.size).toBe(
      0,
    );
    const off = setManualEntries(autopilot, ['approved-plan'], {
      scheduled: false,
      expressionRoots: ROOTS,
    });
    expect(off.ok ? null : off.refusal).toEqual({
      kind: 'entry-used',
      entry: 'new-task',
      jobId: 'prepare_plan',
      stepIndex: 0,
      name: 'Draft Task-Ready Plan',
    });
    // Turning off an entry with inputs would delete them.
    const noPlan = setManualEntries(autopilot, ['new-task'], {
      scheduled: false,
      expressionRoots: ROOTS,
    });
    expect(noPlan.ok ? null : noPlan.refusal).toEqual({
      kind: 'entry-inputs',
      entry: 'approved-plan',
    });
    // Adding Run is fine; it strands nothing.
    expect(
      getTriggerTypes(
        applied(
          setManualEntries(autopilot, ['run', 'approved-plan', 'new-task'], {
            scheduled: false,
            expressionRoots: ROOTS,
          }),
        ).on,
      ),
    ).toEqual(['dispatch', 'plan_ready', 'task_ready']);
  });

  it('keeps one entry, keeps Run while schedules start it, and never writes workflow', () => {
    const plain: Pipeline = {
      name: 'Plain',
      on: 'dispatch',
      jobs: { build: { steps: [{ run: 'echo b' }] } },
    };
    const options = { scheduled: false, expressionRoots: ROOTS };
    const none = setManualEntries(plain, [], options);
    expect(none.ok ? null : none.refusal).toEqual({ kind: 'no-entry' });
    const scheduled = setManualEntries(plain, ['new-task'], {
      scheduled: true,
      expressionRoots: ROOTS,
    });
    const hooked = setManualEntries(plain, ['new-task'], {
      scheduled: false,
      hooked: true,
      expressionRoots: ROOTS,
    });
    expect(hooked.ok ? null : hooked.refusal).toEqual({ kind: 'hooked' });
    // Until schedules and hooks load, nothing shows that Run isn't needed.
    const loading = setManualEntries(plain, ['new-task'], {
      scheduled: false,
      startersKnown: false,
      expressionRoots: ROOTS,
    });
    expect(loading.ok ? null : loading.refusal).toEqual({
      kind: 'starters-unknown',
    });
    expect(
      setManualEntries(plain, ['run', 'new-task'], {
        scheduled: false,
        startersKnown: false,
        expressionRoots: ROOTS,
      }).ok,
    ).toBe(true);
    expect(scheduled.ok ? null : scheduled.refusal).toEqual({
      kind: 'scheduled',
    });
    expect(applied(setManualEntries(plain, ['new-task'], options)).on).toBe(
      'task_ready',
    );
    // A workflow entry keeps the workflow startable, and is never removed.
    const fromWorkflow: Pipeline = {
      ...plain,
      on: { dispatch: {}, workflow: { inputs: { topic: { type: 'string' } } } },
    };
    const onlyWorkflow = applied(setManualEntries(fromWorkflow, [], options));
    expect(onlyWorkflow.on).toEqual({
      workflow: { inputs: { topic: { type: 'string' } } },
    });
    const entries: WorkflowManualEntry[] = ['run', 'new-task'];
    expect(
      getTriggerTypes(applied(setManualEntries(plain, entries, options)).on),
    ).not.toContain('workflow');
  });

  it('reads either quote, and refuses entry changes a condition it cannot read may need', () => {
    const quoted: Pipeline = {
      name: 'Quoted',
      on: { dispatch: {}, task_ready: {} },
      jobs: {
        build: {
          steps: [
            {
              name: 'Task only',
              if: 'canopy.event_name == "task_ready"',
              run: 'echo t',
            },
            { name: 'Always', run: 'echo a' },
          ],
        },
      },
    };
    const options = { scheduled: false, expressionRoots: ROOTS };
    expect([...projectWorkflowTrigger(quoted, ROOTS).stepEntries]).toEqual([
      ['step:build:0', 'new-task'],
    ]);
    const off = setManualEntries(quoted, ['run'], options);
    expect(off.ok ? null : off.refusal).toEqual({
      kind: 'entry-used',
      entry: 'new-task',
      jobId: 'build',
      stepIndex: 0,
      name: 'Task only',
    });
    const other: Pipeline = {
      ...quoted,
      jobs: {
        build: {
          steps: [
            {
              name: 'Not a plan',
              if: "canopy.event_name != 'plan_ready'",
              run: 'echo n',
            },
          ],
        },
      },
    };
    const read = setManualEntries(other, ['new-task'], options);
    expect(read.ok ? null : read.refusal).toEqual({
      kind: 'entry-read',
      entry: 'run',
      jobId: 'build',
      stepIndex: 0,
      name: 'Not a plan',
    });
    // Other roots, inputs and string literals don't read the run entry.
    for (const condition of [
      "env.event_name == 'x'",
      "inputs.event_name == 'x'",
      "inputs.mode == 'event_name'",
    ]) {
      const unrelated: Pipeline = {
        ...quoted,
        jobs: {
          build: { steps: [{ name: 'Other', if: condition, run: 'echo o' }] },
        },
      };
      expect(projectWorkflowTrigger(unrelated, ROOTS).entryReaders).toEqual([]);
      expect(setManualEntries(unrelated, ['run'], options).ok).toBe(true);
    }
    const bracket: Pipeline = {
      ...quoted,
      jobs: {
        build: {
          steps: [
            { name: 'B', if: "canopy['event_name'] != 'dispatch'", run: 'b' },
          ],
        },
      },
    };
    expect(kind(setManualEntries(bracket, ['run'], options))).toBe(
      'entry-read',
    );
    // Adding an entry is still fine.
    expect(
      setManualEntries(other, ['run', 'approved-plan', 'new-task'], options).ok,
    ).toBe(true);
  });

  it('reads a job that runs for one entry only, and guards it', () => {
    const gated: Pipeline = {
      name: 'Gated',
      on: { dispatch: {}, plan_ready: {} },
      jobs: {
        build: { steps: [{ run: 'echo b' }] },
        plan: {
          name: 'Use the plan',
          needs: ['build'],
          if: "canopy.event_name == 'plan_ready'",
          steps: [{ run: 'echo p' }],
        },
      },
    };
    const trigger = projectWorkflowTrigger(gated, ROOTS);
    expect([...trigger.jobEntries]).toEqual([['plan', 'approved-plan']]);
    const off = setManualEntries(gated, ['run'], {
      scheduled: false,
      expressionRoots: ROOTS,
    });
    expect(off.ok ? null : off.refusal).toEqual({
      kind: 'entry-used',
      entry: 'approved-plan',
      jobId: 'plan',
      name: 'Use the plan',
    });
  });
});
