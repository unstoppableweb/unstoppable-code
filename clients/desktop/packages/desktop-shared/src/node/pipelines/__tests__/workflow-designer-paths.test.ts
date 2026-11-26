import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluateCondition } from '@canopy/execution-engine/node/pipelines/executor/expression-evaluator';
import { buildExpressionContext } from '@canopy/execution-engine/node/pipelines/executor/execution-context';
import { parseRouterRoutes } from '@canopy/execution-engine/builtin-actions/_lib/host-helper-model';
import type { Job, Pipeline, Step } from '@canopy/pipeline-interop/document';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import {
  projectWorkflowStack,
  type WorkflowStackNode,
  type WorkflowStackPaths,
} from '@canopy/pipeline-interop/workflow-designer';
import {
  insertWorkflowStep,
  removeWorkflowStep,
  setWorkflowStepId,
  type WorkflowDesignerEditResult,
} from '@canopy/pipeline-interop/workflow-designer-edits';
import { readWorkflowSplit } from '@canopy/pipeline-interop/workflow-designer-split';
import {
  addWorkflowPath,
  canSplitWorkflowJob,
  removeWorkflowPath,
  removeWorkflowSplit,
  renameWorkflowPath,
  splitWorkflowJob,
} from '@canopy/pipeline-interop/workflow-designer-split-edits';

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

const kind = (result: WorkflowDesignerEditResult): string =>
  result.ok ? 'ok' : result.refusal.kind;

function applied(result: WorkflowDesignerEditResult): Pipeline {
  if (!result.ok) throw new Error(`refused: ${result.refusal.kind}`);
  return result.pipeline;
}

function pathsNodes(nodes: readonly WorkflowStackNode[]): WorkflowStackPaths[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'paths') return [node];
    if (node.kind === 'parallel')
      return node.columns.flatMap((column) => pathsNodes(column.nodes));
    return [];
  });
}

/** Every job the stack shows, by where it shows it. */
function shownJobs(nodes: readonly WorkflowStackNode[]): string[] {
  return [
    ...new Set(
      nodes.flatMap((node): string[] => {
        switch (node.kind) {
          case 'step':
          case 'empty-job':
            return [node.jobId];
          case 'unsupported':
            return [...node.jobIds];
          case 'parallel':
            return node.columns.flatMap((column) => shownJobs(column.nodes));
          case 'paths':
            return node.paths.flatMap((path) => shownJobs(path.nodes));
        }
      }),
    ),
  ];
}

function onlyPaths(pipeline: Pipeline): WorkflowStackPaths {
  const [paths, ...more] = pathsNodes(projectWorkflowStack(pipeline).nodes);
  if (!paths || more.length > 0) throw new Error('expected one split');
  return paths;
}

function single(steps: Step[], extra: Partial<Job> = {}): Pipeline {
  return {
    name: 'Split',
    on: 'dispatch',
    jobs: { build: { steps, ...extra } },
  };
}

const twoSteps = single([
  { id: 'a', run: 'echo a' },
  { id: 'b', run: 'echo b' },
]);

/** Whether a path's guard lets its job run, as the executor decides it. */
function runs(
  pipeline: Pipeline,
  pathJobId: string,
  needs: Record<string, { result: string; outputs: Record<string, string> }>,
): boolean {
  const condition = pipeline.jobs[pathJobId]?.if;
  if (typeof condition !== 'string') throw new Error('no guard');
  const results = Object.values(needs).map((need) => need.result);
  return evaluateCondition(condition, buildExpressionContext({ needs }), {
    success: () => results.every((result) => result === 'success'),
    failure: () => results.includes('failure'),
  });
}

describe('workflow designer splits into paths (CAN-4224)', () => {
  it.each(corpus.map(({ file, pipeline }) => [file, pipeline] as const))(
    '%s: every offered split draws two paths, shows every job once, and Remove split undoes it',
    (_file, pipeline) => {
      for (const jobId of Object.keys(pipeline.jobs)) {
        if (!canSplitWorkflowJob(pipeline, jobId)) continue;
        const split = applied(splitWorkflowJob(pipeline, jobId));
        const paths = onlyPaths(split);
        expect(paths.jobId).toBe(jobId);
        expect(paths.paths.map((path) => path.label)).toEqual([
          'Path 1',
          'Path 2',
        ]);
        const shown = shownJobs(projectWorkflowStack(split).nodes).sort();
        expect(shown).toEqual(Object.keys(split.jobs).sort());
        // Nothing else changed: only `jobId` and the new paths differ.
        for (const [otherId, other] of Object.entries(pipeline.jobs))
          if (otherId !== jobId) expect(split.jobs[otherId]).toBe(other);
        expect(applied(removeWorkflowSplit(split, jobId))).toEqual(pipeline);
      }
    },
  );

  it('offers a split only after a job nothing needs', () => {
    const chain: Pipeline = {
      name: 'Chain',
      on: 'dispatch',
      jobs: {
        first: { steps: [{ id: 'a', run: 'echo a' }] },
        second: { needs: ['first'], steps: [{ id: 'b', run: 'echo b' }] },
      },
    };
    expect(canSplitWorkflowJob(chain, 'first')).toBe(false);
    expect(canSplitWorkflowJob(chain, 'second')).toBe(true);
    expect(kind(splitWorkflowJob(chain, 'first'))).toBe('not-editable');
    // A matrix job is read-only, so it is never split.
    const matrix = single([{ run: 'echo m' }], {
      strategy: { matrix: { os: ['a', 'b'] } },
    });
    expect(canSplitWorkflowJob(matrix, 'build')).toBe(false);
  });

  it('writes the shape the executor runs, and runs only the chosen path', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const build = split.jobs.build;
    const router = build?.steps[2];
    expect(router).toEqual({
      id: 'split',
      name: 'Split into paths',
      uses: 'builtin/router',
      with: { text: '', routes: '["Path 1","Path 2"]' },
    });
    expect(build?.outputs).toEqual({
      route: '${{ steps.split.outputs.route }}',
    });
    expect(split.jobs.path).toEqual({
      name: 'Path 1',
      needs: ['build'],
      if: "success() && needs.build.outputs.route == 'Path 1'",
      steps: [],
    });
    expect(split.jobs.path_2?.if).toBe(
      "success() && needs.build.outputs.route == 'Path 2'",
    );
    // The router's own parser reads the routes the paths are guarded by.
    const routes = router?.with?.routes;
    expect(parseRouterRoutes(typeof routes === 'string' ? routes : '')).toEqual(
      ['Path 1', 'Path 2'],
    );
    const chose = (
      route: string,
      result = 'success',
    ): Record<string, { result: string; outputs: Record<string, string> }> => ({
      build: { result, outputs: { route } },
    });
    expect(runs(split, 'path', chose('Path 1'))).toBe(true);
    expect(runs(split, 'path_2', chose('Path 1'))).toBe(false);
    expect(runs(split, 'path_2', chose('Path 2'))).toBe(true);
    expect(runs(split, 'path', chose(''))).toBe(false);
    // A failed router job runs no path, whatever route it wrote.
    expect(runs(split, 'path', chose('Path 1', 'failure'))).toBe(false);
  });

  it('never overwrites an output or a step ID, and picks free names', () => {
    const solo = single([{ id: 'split', run: 'echo s' }], {
      outputs: { route: 'kept', route_2: 'kept too' },
    });
    const split = applied(splitWorkflowJob(solo, 'build'));
    expect(split.jobs.build?.outputs).toEqual({
      route: 'kept',
      route_2: 'kept too',
      route_3: '${{ steps.split_2.outputs.route }}',
    });
    expect(readWorkflowSplit(split, 'build')?.outputKey).toBe('route_3');
    expect(applied(removeWorkflowSplit(split, 'build'))).toEqual(solo);
  });

  it('draws paths only for the exact shape, and nothing after them', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    expect(pathsNodes(projectWorkflowStack(split).nodes)).toHaveLength(1);
    const variants: ((draft: Pipeline) => void)[] = [
      // A join after the paths could read a path that was removed.
      (draft) => {
        draft.jobs.join = {
          needs: ['path', 'path_2'],
          if: 'always()',
          steps: [{ run: 'echo join' }],
        };
      },
      // A later job's own condition could run it whatever the route.
      (draft) => {
        draft.jobs.after = {
          needs: ['build'],
          if: 'always()',
          steps: [{ run: 'echo after' }],
        };
      },
      // Without success(), a failed router job could still run a path.
      (draft) => {
        const path = draft.jobs.path;
        if (path) path.if = "needs.build.outputs.route == 'Path 1'";
      },
      (draft) => {
        const router = draft.jobs.build?.steps[2];
        if (router?.with) router.with.routes = 'Path 1, Path 2';
      },
      (draft) => {
        const router = draft.jobs.build?.steps[2];
        if (router?.with) router.with.routes = '["Path 1","Path 2","Path 3"]';
      },
      (draft) => {
        const router = draft.jobs.build?.steps[2];
        if (router) router.if = 'false';
      },
    ];
    for (const change of variants) {
      const draft = structuredClone(split);
      change(draft);
      expect(pathsNodes(projectWorkflowStack(draft).nodes)).toEqual([]);
      expect(shownJobs(projectWorkflowStack(draft).nodes).sort()).toEqual(
        Object.keys(draft.jobs).sort(),
      );
      expect(kind(addWorkflowPath(draft, 'build'))).toBe('not-editable');
      expect(kind(removeWorkflowSplit(draft, 'build'))).toBe('not-editable');
    }
  });

  it('keeps path labels unique, non-empty and safe to quote', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const rename = (label: string): WorkflowDesignerEditResult =>
      renameWorkflowPath(split, 'build', 'path', label);
    for (const [label, problem] of [
      ['', 'empty'],
      ['  ', 'empty'],
      [' Urgent', 'characters'],
      ["it's", 'characters'],
      ['a"b', 'characters'],
      ['a\\b', 'characters'],
      ['a\nb', 'characters'],
      ['path 2', 'duplicate'],
      ['x'.repeat(61), 'too-long'],
    ] as const) {
      const result = rename(label);
      expect(result.ok ? null : result.refusal).toEqual({
        kind: 'path-label',
        problem,
      });
    }
    const renamed = applied(rename('Urgent'));
    expect(renamed.jobs.build?.steps[2]?.with?.routes).toBe(
      '["Urgent","Path 2"]',
    );
    expect(renamed.jobs.path).toEqual({
      name: 'Urgent',
      needs: ['build'],
      if: "success() && needs.build.outputs.route == 'Urgent'",
      steps: [],
    });
    expect(onlyPaths(renamed).paths.map((path) => path.label)).toEqual([
      'Urgent',
      'Path 2',
    ]);
  });

  it('adds and removes paths, keeping two or more', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    expect(kind(removeWorkflowPath(split, 'build', 'path'))).toBe(
      'too-few-paths',
    );
    const three = applied(addWorkflowPath(split, 'build'));
    expect(onlyPaths(three).paths.map((path) => path.label)).toEqual([
      'Path 1',
      'Path 2',
      'Path 3',
    ]);
    expect(three.jobs.path_3?.if).toBe(
      "success() && needs.build.outputs.route == 'Path 3'",
    );
    const two = applied(removeWorkflowPath(three, 'build', 'path'));
    expect(two.jobs.path).toBeUndefined();
    expect(onlyPaths(two).paths.map((path) => path.label)).toEqual([
      'Path 2',
      'Path 3',
    ]);
    // A new path never reuses a label a path has.
    expect(
      onlyPaths(applied(addWorkflowPath(two, 'build'))).paths.map(
        (path) => path.label,
      ),
    ).toEqual(['Path 2', 'Path 3', 'Path 4']);
  });

  it('removes a split, or keeps one path as the steps that follow', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const filled = applied(
      insertWorkflowStep(split, 'path_2', 0, { id: 'p', run: 'echo p' }),
    );
    expect(onlyPaths(filled).paths[1]?.nodes).toHaveLength(1);
    const kept = applied(removeWorkflowSplit(filled, 'build', 'path_2'));
    expect(kept.jobs).toEqual({
      build: twoSteps.jobs.build,
      path_2: {
        name: 'Path 2',
        needs: ['build'],
        steps: [{ id: 'p', run: 'echo p' }],
      },
    });
    expect(pathsNodes(projectWorkflowStack(kept).nodes)).toEqual([]);
  });

  it('refuses edits that would leave a read of the router dangling', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const reading = applied(
      insertWorkflowStep(split, 'build', 3, {
        id: 'after',
        run: 'echo ${{ steps.split.outputs.reasoning }}',
      }),
    );
    expect(onlyPaths(reading).routerStepIndex).toBe(2);
    expect(kind(removeWorkflowSplit(reading, 'build'))).toBe('reads');
    // The router's own step edits are refused: its output reads it.
    expect(kind(removeWorkflowStep(split, 'build', 2))).toBe('reads');
    expect(kind(setWorkflowStepId(split, 'build', 2, 'other'))).toBe('reads');
  });

  it('edits a split only where the stack draws its paths', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const three = applied(addWorkflowPath(split, 'build'));
    // A path the stack can't show as cards: the whole split is read-only.
    const hidden = structuredClone(three);
    hidden.jobs.path_2 = {
      ...hidden.jobs.path_2,
      steps: [{ if: '${{ always() }}', run: 'echo kept' }],
    };
    expect(readWorkflowSplit(hidden, 'build')).not.toBeNull();
    expect(pathsNodes(projectWorkflowStack(hidden).nodes)).toEqual([]);
    expect(kind(addWorkflowPath(hidden, 'build'))).toBe('not-editable');
    expect(kind(removeWorkflowPath(hidden, 'build', 'path_2'))).toBe(
      'not-editable',
    );
    expect(kind(removeWorkflowSplit(hidden, 'build'))).toBe('not-editable');
    expect(kind(renameWorkflowPath(hidden, 'build', 'path', 'Renamed'))).toBe(
      'not-editable',
    );
  });

  it('never splits inside a path, or a job named like a literal', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    expect(canSplitWorkflowJob(split, 'path')).toBe(false);
    const filled = applied(
      insertWorkflowStep(split, 'path', 0, { id: 'p', run: 'echo p' }),
    );
    expect(canSplitWorkflowJob(filled, 'path')).toBe(false);
    expect(kind(splitWorkflowJob(filled, 'path'))).toBe('not-editable');
    for (const literal of ['true', 'false', 'null']) {
      const named: Pipeline = {
        name: 'Literal',
        on: 'dispatch',
        jobs: { [literal]: { steps: [{ id: 'a', run: 'echo a' }] } },
      };
      expect(canSplitWorkflowJob(named, literal)).toBe(false);
    }
  });

  it('refuses a label whose spaces the router would collapse', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    for (const label of ['Needs  review', 'Needs\u00a0review']) {
      const renamed = renameWorkflowPath(split, 'build', 'path', label);
      expect(renamed.ok ? null : renamed.refusal).toEqual({
        kind: 'path-label',
        problem: 'characters',
      });
    }
    expect(
      kind(renameWorkflowPath(split, 'build', 'path', 'Needs review')),
    ).toBe('ok');
  });

  it('refuses a split or path the stack could no longer draw', () => {
    const chain = (length: number): Pipeline => ({
      name: 'Chain',
      on: 'dispatch',
      jobs: Object.fromEntries(
        Array.from({ length }, (_, n) => [
          `j${String(n)}`,
          {
            ...(n > 0 ? { needs: [`j${String(n - 1)}`] } : {}),
            steps: [{ run: `echo ${String(n)}` }],
          },
        ]),
      ),
    });
    // The stack projects up to 400 jobs; a split's two paths would make 401.
    const full = chain(399);
    expect(canSplitWorkflowJob(full, 'j398')).toBe(true);
    expect(kind(splitWorkflowJob(full, 'j398'))).toBe('too-large');
    const room = applied(splitWorkflowJob(chain(397), 'j396'));
    const atLimit = applied(addWorkflowPath(room, 'j396'));
    expect(Object.keys(atLimit.jobs)).toHaveLength(400);
    expect(kind(addWorkflowPath(atLimit, 'j396'))).toBe('too-large');
  });

  it('refuses a label the router would evaluate', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const renamed = renameWorkflowPath(split, 'build', 'path', '${{ 1 }}');
    expect(renamed.ok ? null : renamed.refusal).toEqual({
      kind: 'path-label',
      problem: 'characters',
    });
    const evaluated = structuredClone(split);
    const router = evaluated.jobs.build?.steps[2];
    if (router?.with) router.with.routes = '["${{ 1 }}","Path 2"]';
    const first = evaluated.jobs.path;
    if (first)
      first.if = "success() && needs.build.outputs.route == '${{ 1 }}'";
    expect(readWorkflowSplit(evaluated, 'build')).toBeNull();
  });

  it('keeps a path only when nothing in it reads the removed route', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const reading = applied(
      insertWorkflowStep(split, 'path', 0, {
        id: 'p',
        run: 'echo ${{ needs.build.outputs.route }}',
      }),
    );
    const kept = removeWorkflowSplit(reading, 'build', 'path');
    expect(kept.ok ? null : kept.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'path', label: 'Path 1' },
    });
    // Its own guard goes with the split, and the other path keeps.
    expect(kind(removeWorkflowSplit(reading, 'build', 'path_2'))).toBe('ok');
    expect(kind(removeWorkflowSplit(reading, 'build'))).toBe('ok');
  });

  it('refuses a rename that an expression comparing the route would miss', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const inPath = applied(
      insertWorkflowStep(split, 'path_2', 0, {
        id: 'p',
        if: "needs.build.outputs.route == 'Path 2'",
        run: 'echo p',
      }),
    );
    const renamed = renameWorkflowPath(inPath, 'build', 'path', 'Urgent');
    expect(renamed.ok ? null : renamed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'path', label: 'Path 2' },
    });
    const afterRouter = applied(
      insertWorkflowStep(split, 'build', 3, {
        id: 'after',
        run: 'echo ${{ steps.split.outputs.route }}',
      }),
    );
    expect(
      kind(renameWorkflowPath(afterRouter, 'build', 'path', 'Urgent')),
    ).toBe('reads');
    // A step before the router can't read its choice.
    const before = applied(
      insertWorkflowStep(split, 'build', 0, {
        id: 'first',
        run: 'echo ${{ steps.a.outputs.x }}',
      }),
    );
    expect(kind(renameWorkflowPath(before, 'build', 'path', 'Urgent'))).toBe(
      'ok',
    );
  });

  it('refuses removing a path that a route comparison names', () => {
    const three = applied(
      addWorkflowPath(applied(splitWorkflowJob(twoSteps, 'build')), 'build'),
    );
    const compared = applied(
      insertWorkflowStep(three, 'build', 3, {
        id: 'after',
        if: "steps.split.outputs.route == 'Path 3'",
        run: 'echo three',
      }),
    );
    const removed = removeWorkflowPath(compared, 'build', 'path_3');
    expect(removed.ok ? null : removed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'step', stepIndex: 3, id: 'after' },
    });
    // A kept path that reads the route blocks it; the removed path's own
    // reads go with it.
    const inPath = (target: string): Pipeline =>
      applied(
        insertWorkflowStep(three, target, 0, {
          id: 'p',
          if: "needs.build.outputs.route == 'Path 3'",
          run: 'echo p',
        }),
      );
    expect(kind(removeWorkflowPath(inPath('path'), 'build', 'path_3'))).toBe(
      'reads',
    );
    expect(kind(removeWorkflowPath(inPath('path_3'), 'build', 'path_3'))).toBe(
      'ok',
    );
  });

  it('refuses a rename or removal that a job output comparing the route would miss', () => {
    const three = applied(
      addWorkflowPath(applied(splitWorkflowJob(twoSteps, 'build')), 'build'),
    );
    const build = three.jobs.build;
    if (!build) throw new Error('no build');
    const published: Pipeline = {
      ...three,
      jobs: {
        ...three.jobs,
        build: {
          ...build,
          outputs: {
            ...build.outputs,
            urgent: "${{ steps.split.outputs.route == 'Path 3' }}",
          },
        },
      },
    };
    const output = { kind: 'reads', reader: { kind: 'output', key: 'urgent' } };
    const renamed = renameWorkflowPath(published, 'build', 'path_3', 'Later');
    expect(renamed.ok ? null : renamed.refusal).toEqual(output);
    const removed = removeWorkflowPath(published, 'build', 'path_3');
    expect(removed.ok ? null : removed.refusal).toEqual(output);
  });

  it('counts a read of the route that spans lines', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    const filled = applied(
      insertWorkflowStep(split, 'path', 0, { id: 'p', run: 'echo p' }),
    );
    const job = filled.jobs.path;
    if (!job) throw new Error('no path');
    const multiline: Pipeline = {
      ...filled,
      jobs: {
        ...filled.jobs,
        path: {
          ...job,
          continue_on_error: "${{ needs.build.outputs.route ==\n 'Path 1' }}",
        },
      },
    };
    expect(kind(removeWorkflowSplit(multiline, 'build', 'path'))).toBe('reads');
  });

  it('refuses removing a path whose step a dependency names', () => {
    const three = applied(
      addWorkflowPath(applied(splitWorkflowJob(twoSteps, 'build')), 'build'),
    );
    const bound: Pipeline = {
      ...applied(
        insertWorkflowStep(three, 'path_2', 0, { id: 'push', run: 'echo p' }),
      ),
      dependencies: [
        {
          id: 'github',
          kind: 'connector',
          connector: 'github',
          steps: [' push '],
        },
      ],
    };
    const removed = removeWorkflowPath(bound, 'build', 'path_2');
    expect(removed.ok ? null : removed.refusal).toEqual({
      kind: 'reads',
      reader: { kind: 'dependency', id: 'github' },
    });
    expect(kind(removeWorkflowSplit(bound, 'build'))).toBe('reads');
    expect(kind(removeWorkflowSplit(bound, 'build', 'path_2'))).toBe('ok');
    expect(kind(removeWorkflowPath(bound, 'build', 'path'))).toBe('ok');
  });

  it('flags a router with nothing to decide on, never one that never runs', () => {
    const split = applied(splitWorkflowJob(twoSteps, 'build'));
    expect(onlyPaths(split).missingInput).toBe(true);
    const decided = structuredClone(split);
    const decidedRouter = decided.jobs.build?.steps[2];
    if (decidedRouter?.with) decidedRouter.with.text = '${{ inputs.request }}';
    expect(onlyPaths(decided).missingInput).toBe(false);
    // A router with `if: false` is no split the designer draws, and the flag
    // is only drawn on a split, never a save error.
    const never = structuredClone(split);
    const neverRouter = never.jobs.build?.steps[2];
    if (neverRouter) neverRouter.if = 'false';
    expect(pathsNodes(projectWorkflowStack(never).nodes)).toEqual([]);
  });
});
