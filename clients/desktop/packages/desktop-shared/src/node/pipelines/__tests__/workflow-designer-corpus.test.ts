import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pipeline } from '@canopy/pipeline-interop/document';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { serializePipelineDocument } from '@canopy/pipeline-interop/serialize-pipeline';
import {
  projectWorkflowStack,
  workflowStackEditableKeys,
  type WorkflowStackNode,
  type WorkflowStackParallel,
} from '@canopy/pipeline-interop/workflow-designer';

const ROOT = resolve(__dirname, '../../../../../..');
const CORPUS_DIRS = [
  'packages/desktop-shared/resources/pipelines',
  'example-pipelines',
];

/**
 * The brand tokens bundled pipelines are written with, rendered as
 * `replaceTokens` in scripts/brand/render-branded-resources.mjs renders them
 * for the canopy brand. Values the projection never reads stay neutral.
 */
function renderBrandTokens(text: string): string {
  return text
    .replaceAll('{{BRAND_EXPRESSION_ROOT}}', 'canopy')
    .replaceAll('{{BRAND_REPORT_ACTION_ID}}', 'pipeline-report')
    .replaceAll('{{BRAND_OUTPUT_VARIABLE_NAME}}', 'brandOutput')
    .replace(/\{\{BRAND_[A-Z_]+\}\}/g, 'BRAND');
}

function loadCorpus(): ReadonlyArray<{ file: string; pipeline: Pipeline }> {
  return CORPUS_DIRS.flatMap((dir) =>
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
}

/** Every place a node shows a job: its cards, an empty card, or a group. */
function jobPlacements(
  nodes: readonly WorkflowStackNode[],
  out: { jobs: string[]; steps: string[] } = { jobs: [], steps: [] },
): { jobs: string[]; steps: string[] } {
  for (const node of nodes) {
    switch (node.kind) {
      case 'step':
        if (node.stepIndex === 0) out.jobs.push(node.jobId);
        out.steps.push(`${node.jobId}#${String(node.stepIndex)}`);
        break;
      case 'empty-job':
        out.jobs.push(node.jobId);
        break;
      case 'unsupported':
        out.jobs.push(...node.jobIds);
        break;
      case 'parallel':
        for (const column of node.columns) jobPlacements(column.nodes, out);
        break;
    }
  }
  return out;
}

/**
 * The jobs read-only groups lay out in their layers, with each job's step
 * cards, at any depth (CAN-4224 phase 08).
 */
function groupLayerSteps(
  nodes: readonly WorkflowStackNode[],
  out: Map<string, string[]> = new Map(),
): Map<string, string[]> {
  for (const node of nodes) {
    if (node.kind === 'unsupported') {
      for (const layer of node.layers)
        for (const job of layer) {
          expect(out.has(job.jobId)).toBe(false);
          out.set(
            job.jobId,
            job.nodes.flatMap((card) =>
              card.kind === 'step'
                ? [`${card.jobId}#${String(card.stepIndex)}`]
                : [],
            ),
          );
        }
    } else if (node.kind === 'parallel') {
      for (const column of node.columns) groupLayerSteps(column.nodes, out);
    }
  }
  return out;
}

/** Jobs in read-only groups, at any depth. */
function unsupportedJobIds(nodes: readonly WorkflowStackNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'unsupported') return [...node.jobIds];
    if (node.kind === 'parallel')
      return node.columns.flatMap((column) => unsupportedJobIds(column.nodes));
    return [];
  });
}

function findParallel(
  nodes: readonly WorkflowStackNode[],
): WorkflowStackParallel | undefined {
  return nodes.find(
    (node): node is WorkflowStackParallel => node.kind === 'parallel',
  );
}

const corpus = loadCorpus();

const ROUTES = JSON.stringify(['Fix', 'Ship']);

/** A router job and two jobs gated on its routes `Fix` and `Ship`. */
function routedJobs(router: Pipeline['jobs'][string]): Pipeline['jobs'] {
  return {
    decide: router,
    fix: {
      needs: 'decide',
      if: "needs.decide.outputs.route == 'Fix'",
      steps: [{ run: 'echo fix' }],
    },
    ship: {
      needs: 'decide',
      if: "needs.decide.outputs.route == 'Ship'",
      steps: [{ run: 'echo ship' }],
    },
  };
}

describe('workflow designer stack projection (CAN-4224)', () => {
  it('lays out an irregular dependency graph in layers with every step', () => {
    const stack = projectWorkflowStack({
      name: 'Review',
      on: 'dispatch',
      jobs: {
        gather: { steps: [{ run: 'gather' }] },
        context: { needs: 'gather', steps: [{ run: 'context' }] },
        claude: {
          needs: ['gather', 'context'],
          if: 'inputs.claude == true',
          steps: [{ run: 'review' }, { run: 'validate' }],
        },
        codex: { needs: 'context', steps: [{ run: 'review' }] },
        synthesize: {
          needs: ['claude', 'codex', 'gather'],
          if: 'always()',
          steps: [{ run: 'aggregate' }],
        },
      },
    });
    const group = stack.nodes.find((node) => node.kind === 'unsupported');
    expect(group?.kind === 'unsupported' ? group.reason : null).toBe('graph');
    const layers =
      group?.kind === 'unsupported'
        ? group.layers.map((layer) => layer.map((job) => job.jobId))
        : [];
    // context's dependents don't follow it as a chain, so it starts the group.
    expect(layers).toEqual([['context'], ['claude', 'codex'], ['synthesize']]);
    const claude =
      group?.kind === 'unsupported' ? group.layers[1]?.[0] : undefined;
    expect(claude).toMatchObject({
      after: ['gather', 'context'],
      condition: 'inputs.claude == true',
    });
    expect(claude?.nodes.map((card) => card.key)).toEqual([
      'step:claude:0',
      'step:claude:1',
    ]);
  });

  it('marks a dependency cycle instead of laying it out as an order', () => {
    const stack = projectWorkflowStack({
      name: 'Cycle',
      on: 'dispatch',
      jobs: {
        a: { needs: 'b', steps: [{ run: 'a' }] },
        b: { needs: 'a', steps: [{ run: 'b' }] },
        c: { needs: 'b', steps: [{ run: 'c' }] },
      },
    });
    const [group] = stack.nodes;
    const layers =
      group?.kind === 'unsupported'
        ? group.layers.map((layer) =>
            layer.map((job) => `${job.jobId}${job.cycle ? '*' : ''}`),
          )
        : [];
    // a and b share a layer, marked as a cycle; c still follows b.
    expect(layers).toEqual([['a*', 'b*'], ['c']]);
  });

  it('marks a grouped job it cannot read as not editable', () => {
    const pipeline = parsePipelineText(`pipeline:
  name: Mixed group
  on: dispatch
  jobs:
    setup:
      steps:
        - run: setup
    lint:
      needs: setup
      steps:
        - uses: 123
    test:
      needs: setup
      steps:
        - run: test
`);
    const stack = projectWorkflowStack(pipeline);
    const group = stack.nodes.find((node) => node.kind === 'unsupported');
    const jobs =
      group?.kind === 'unsupported'
        ? group.layers.flat().map((job) => [job.jobId, job.editable])
        : [];
    expect(jobs).toEqual([
      ['lint', false],
      ['test', true],
    ]);
  });

  it('lays a cycle out as one unit, below the needs that enter it', () => {
    const stack = projectWorkflowStack({
      name: 'Entered cycle',
      on: 'dispatch',
      jobs: {
        start: { steps: [{ run: 'start' }] },
        a: { needs: ['start', 'b'], steps: [{ run: 'a' }] },
        b: { needs: 'a', steps: [{ run: 'b' }] },
      },
    });
    const [group] = stack.nodes;
    const layers =
      group?.kind === 'unsupported'
        ? group.layers.map((layer) =>
            layer.map((job) => `${job.jobId}${job.cycle ? '*' : ''}`),
          )
        : [];
    expect(layers).toEqual([['start'], ['a*', 'b*']]);
  });

  it('shows a read-only condition exactly as written', () => {
    const stack = projectWorkflowStack({
      name: 'Wrapped',
      on: 'dispatch',
      jobs: {
        one: {
          if: '${{ inputs.go }}',
          steps: [{ run: 'echo', if: '${{ inputs.step }}' }],
        },
      },
    });
    const [group] = stack.nodes;
    const job =
      group?.kind === 'unsupported' ? group.layers[0]?.[0] : undefined;
    expect(job?.condition).toBe('${{ inputs.go }}');
    expect(job?.nodes[0]).toMatchObject({ condition: '${{ inputs.step }}' });
  });

  it('loads the bundled and example corpus', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30);
  });

  it.each(corpus.map(({ file, pipeline }) => [file, pipeline] as const))(
    '%s: shows every job and step exactly once, unchanged on a no-edit save',
    (_file, pipeline) => {
      const before = structuredClone(pipeline);
      const savedBefore = serializePipelineDocument(before);

      const stack = projectWorkflowStack(pipeline);

      // The projection never edits the draft, so a no-edit save is identical.
      expect(pipeline).toEqual(before);
      expect(serializePipelineDocument(pipeline)).toBe(savedBefore);
      // Deterministic for the same input.
      expect(projectWorkflowStack(pipeline)).toEqual(stack);

      const placements = jobPlacements(stack.nodes);
      const jobIds = Object.keys(pipeline.jobs);
      expect([...placements.jobs].sort()).toEqual([...jobIds].sort());

      const unsupported = new Set(unsupportedJobIds(stack.nodes));
      const grouped = groupLayerSteps(stack.nodes);
      expect([...grouped.keys()].sort()).toEqual([...unsupported].sort());
      for (const [jobId, job] of Object.entries(pipeline.jobs)) {
        if (job.strategy !== undefined) {
          // Matrix jobs are never drawn as plain cards.
          expect(placements.steps.some((s) => s.startsWith(`${jobId}#`))).toBe(
            false,
          );
        }
        const expected = job.steps.map((_, i) => `${jobId}#${String(i)}`);
        if (unsupported.has(jobId)) {
          // A read-only group still shows every step, in order, in its
          // layers: nothing is hidden (CAN-4224 phase 08).
          expect(grouped.get(jobId)).toEqual(expected);
          continue;
        }
        // Every step of a job shown as cards appears, in order; a job with
        // no steps is an empty-job card.
        const shown = placements.steps.filter((s) => s.startsWith(`${jobId}#`));
        expect(shown).toEqual(expected);
      }
    },
  );

  it('shows simple.yaml build and test as one parallel group after setup', () => {
    const entry = corpus.find(({ file }) => file.endsWith('/simple.yaml'));
    if (!entry) throw new Error('simple.yaml is missing from the corpus');
    const stack = projectWorkflowStack(entry.pipeline);
    const first = stack.nodes[0];
    expect(first?.kind === 'step' ? first.jobId : undefined).toBe('setup');
    const group = findParallel(stack.nodes);
    expect(group?.columns.map((column) => column.jobIds[0]).sort()).toEqual([
      'build',
      'test',
    ]);
  });

  // Paths for a router's routes arrive in phase 03. Until then the jobs a
  // route gates are read-only, so nothing the designer draws depends on
  // predicting which route a router picks.
  it('shows the jobs a router gates as an editable group, and the router as a card', () => {
    const stack = projectWorkflowStack({
      name: 'Routed',
      on: 'dispatch',
      jobs: {
        ...routedJobs({
          outputs: { route: '${{ steps.pick.outputs.route }}' },
          steps: [
            {
              id: 'pick',
              uses: 'builtin/router',
              with: { text: 'x', routes: ROUTES },
            },
          ],
        }),
        report: {
          needs: ['fix', 'ship'],
          if: 'always()',
          steps: [{ run: 'echo report' }],
        },
      },
    });
    expect(stack.nodes).toEqual([
      expect.objectContaining({ kind: 'step', key: 'step:decide:0' }),
      expect.objectContaining({
        kind: 'unsupported',
        reason: 'graph',
        jobIds: ['fix', 'ship', 'report'],
      }),
    ]);
    // A group's jobs edit as any card does (CAN-4224 phase 08).
    expect([...workflowStackEditableKeys(stack)]).toEqual([
      'step:decide:0',
      'job:decide',
      'job:fix',
      'step:fix:0',
      'job:ship',
      'step:ship:0',
      'job:report',
      'step:report:0',
    ]);
  });

  it('groups the jobs after a route-guarded job with it, editable', () => {
    const stack = projectWorkflowStack({
      name: 'Guarded chain',
      on: 'dispatch',
      jobs: {
        decide: {
          outputs: { route: '${{ steps.pick.outputs.route }}' },
          steps: [
            {
              id: 'pick',
              uses: 'builtin/router',
              with: { text: 'x', routes: ROUTES },
            },
          ],
        },
        fix: {
          needs: 'decide',
          if: "needs.decide.outputs.route == 'Fix'",
          steps: [{ run: 'echo fix' }],
        },
        // Runs only on the Fix route, through its need on fix.
        verify: { needs: 'fix', steps: [{ run: 'echo verify' }] },
      },
    });
    expect(stack.nodes).toEqual([
      expect.objectContaining({ kind: 'step', key: 'step:decide:0' }),
      expect.objectContaining({
        kind: 'unsupported',
        reason: 'condition',
        jobIds: ['fix', 'verify'],
      }),
    ]);
    expect([...workflowStackEditableKeys(stack)]).toEqual([
      'step:decide:0',
      'job:decide',
      'job:fix',
      'step:fix:0',
      'job:verify',
      'step:verify:0',
    ]);
  });

  it.each([
    ['a mapping', '{}'],
    ['a scalar', 'echo'],
    ['empty', ''],
    ['a list with a null entry', '\n        - null'],
  ])('shows a job whose steps are %s read-only', (_label, steps) => {
    const pipeline = parsePipelineText(`pipeline:
  name: Bad steps
  on: dispatch
  jobs:
    one:
      steps: ${steps}
`);
    expect(projectWorkflowStack(pipeline).nodes).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['one'],
        reason: 'invalid',
      }),
    ]);
  });

  // The executor's tokenizer reads a backslash as taking the next character.
  it.each([
    ['an escaped quote inside', "inputs.name == 'it\\'s'", 'step'],
    ['an escaped closing quote', "inputs.name == 'open\\'", 'unsupported'],
    ['a quoted dotted reserved word', "inputs.f == 'a\\'.true'", 'step'],
  ])(
    'reads a condition with %s as the executor does',
    (_l, condition, kind) => {
      const stack = projectWorkflowStack({
        name: 'Escapes',
        on: 'dispatch',
        jobs: { one: { if: condition, steps: [{ run: 'echo' }] } },
      });
      expect(stack.nodes.map((node) => node.kind)).toEqual([kind]);
    },
  );

  it('reads a long unterminated condition as read-only, quickly', () => {
    const condition = `inputs.name == '${"\\'".repeat(50_000)}`;
    const started = performance.now();
    const stack = projectWorkflowStack({
      name: 'Long condition',
      on: 'dispatch',
      jobs: { one: { if: condition, steps: [{ run: 'echo' }] } },
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(stack.nodes.map((node) => node.kind)).toEqual(['unsupported']);
  });

  it('reads a repeated need as one need', () => {
    const chain = (needs: string[]): Pipeline => ({
      name: 'Repeated needs',
      on: 'dispatch',
      jobs: {
        setup: { steps: [{ run: 'echo setup' }] },
        build: { needs, steps: [{ run: 'echo build' }] },
        test: { needs, steps: [{ run: 'echo test' }] },
        ship: {
          needs: [...needs.map(() => 'build'), 'test', 'test'],
          steps: [{ run: 'echo ship' }],
        },
      },
    });
    const repeated = projectWorkflowStack(chain(['setup', 'setup']));
    expect(repeated).toEqual(projectWorkflowStack(chain(['setup'])));
    expect(repeated.nodes.map((node) => node.kind)).toEqual([
      'step',
      'parallel',
      'step',
    ]);
  });

  it('groups no branches whose conditions it can’t show', () => {
    const stack = projectWorkflowStack({
      name: 'Branches',
      on: 'dispatch',
      jobs: {
        start: { steps: [{ run: 'echo start' }] },
        left: {
          needs: 'start',
          if: "inputs.a == 'x' && inputs.b == 'y'",
          steps: [{ run: 'echo left' }],
        },
        right: { needs: 'start', steps: [{ run: 'echo right' }] },
        end: { needs: ['left', 'right'], steps: [{ run: 'echo end' }] },
      },
    });
    expect(stack.nodes.map((node) => node.kind)).toEqual([
      'step',
      'unsupported',
    ]);
    expect(unsupportedJobIds(stack.nodes)).toEqual(['left', 'right', 'end']);
  });

  it('reads an empty job condition as no condition', () => {
    const chain = (condition?: string): Pipeline => ({
      name: 'Chain',
      on: 'dispatch',
      jobs: {
        a: { steps: [{ run: 'echo a' }] },
        b: {
          needs: 'a',
          ...(condition === undefined ? {} : { if: condition }),
          steps: [
            {
              run: 'echo b',
              ...(condition === undefined ? {} : { if: condition }),
            },
          ],
        },
      },
    });
    expect(projectWorkflowStack(chain(''))).toEqual(
      projectWorkflowStack(chain()),
    );
  });

  it('reads boolean and empty conditions as YAML parses them', () => {
    const pipeline = parsePipelineText(`pipeline:
  name: Conditions
  on: dispatch
  jobs:
    off:
      if: false
      steps:
        - run: echo off
          if: true
    on:
      needs: off
      if:
      steps:
        - run: echo on
          if:
`);
    const stack = projectWorkflowStack(pipeline);
    expect(stack.nodes).toEqual([
      expect.objectContaining({
        kind: 'step',
        jobId: 'off',
        jobCondition: 'false',
        condition: 'true',
      }),
      expect.objectContaining({ kind: 'step', jobId: 'on' }),
    ]);
    expect(stack.nodes[1]).not.toHaveProperty('condition');
    expect(stack.nodes[1]).not.toHaveProperty('jobCondition');
  });

  it('closes a group only at the one job that follows every column', () => {
    const pipeline: Pipeline = {
      name: 'Two followers',
      on: 'dispatch',
      jobs: {
        setup: { steps: [{ run: 'setup' }] },
        build: { needs: 'setup', steps: [{ run: 'build' }] },
        test: { needs: 'setup', steps: [{ run: 'test' }] },
        deploy: { needs: ['build', 'test'], steps: [{ run: 'deploy' }] },
        notify: { needs: ['build', 'test'], steps: [{ run: 'notify' }] },
      },
    };
    const stack = projectWorkflowStack(pipeline);
    // With two followers the group never closes, so its branches are read-only.
    expect(stack.nodes.map((node) => node.kind)).toEqual([
      'step',
      'unsupported',
    ]);
    expect(stack.nodes[1]).toMatchObject({
      jobIds: ['build', 'test', 'deploy', 'notify'],
      reason: 'graph',
    });
  });

  it('lists every card it can read as editable, grouped jobs included', () => {
    const simple = corpus.find(({ file }) => file.endsWith('/simple.yaml'));
    const review = corpus.find(({ file }) =>
      file.endsWith('/code-review-multi-provider.yaml'),
    );
    if (!simple || !review) throw new Error('corpus pipeline missing');
    expect(
      workflowStackEditableKeys(projectWorkflowStack(simple.pipeline)).has(
        'step:setup:0',
      ),
    ).toBe(true);
    const reviewKeys = workflowStackEditableKeys(
      projectWorkflowStack(review.pipeline),
    );
    expect(
      [...reviewKeys].some((key) => key.includes('custom_review_tracks')),
    ).toBe(true);
    // A job whose steps aren't a list can't be edited as cards.
    const unreadable = parsePipelineText(`pipeline:
  name: Bad steps
  on: dispatch
  jobs:
    one:
      steps: {}
`);
    expect([
      ...workflowStackEditableKeys(projectWorkflowStack(unreadable)),
    ]).toEqual([]);
  });

  it('shows a job with a non-string action read-only', () => {
    const pipeline = parsePipelineText(`pipeline:
  name: Bad uses
  on: dispatch
  jobs:
    one:
      steps:
        - uses: 123
    two:
      needs: one
      steps:
        - uses:
`);
    expect(projectWorkflowStack(pipeline).nodes).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['one'],
        reason: 'invalid',
      }),
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['two'],
        reason: 'invalid',
      }),
    ]);
  });

  function chainOfJobs(count: number): Pipeline['jobs'] {
    const jobs: Pipeline['jobs'] = {};
    for (let index = 0; index < count; index += 1)
      jobs[`job_${String(index)}`] = {
        ...(index > 0 ? { needs: `job_${String(index - 1)}` } : {}),
        steps: [{ run: 'echo' }],
      };
    return jobs;
  }

  it.each<[string, Pipeline['jobs']]>([
    ['jobs', chainOfJobs(401)],
    [
      'steps',
      {
        many: {
          steps: Array.from({ length: 4001 }, () => ({ run: 'echo' })),
        },
      },
    ],
    [
      'outputs',
      {
        many: {
          outputs: Object.fromEntries(
            Array.from({ length: 4001 }, (_, index) => [
              `out_${String(index)}`,
              '${{ steps.pick.outputs.route }}',
            ]),
          ),
          steps: [{ id: 'pick', uses: 'builtin/router' }],
        },
      },
    ],
  ])(
    'shows a workflow with too many %s as one read-only group',
    (_label, jobs) => {
      expect(
        projectWorkflowStack({ name: 'Huge', on: 'dispatch', jobs }).nodes,
      ).toEqual([
        expect.objectContaining({ kind: 'unsupported', reason: 'size' }),
      ]);
    },
  );

  it('keeps a need that still decides whether a job runs', () => {
    // publish needs report and fix; report runs anyway (always()), so it
    // implies nothing, and fix still decides whether publish runs.
    const pipeline: Pipeline = {
      name: 'Publish after report',
      on: 'dispatch',
      jobs: {
        decide: {
          outputs: { route: '${{ steps.pick.outputs.route }}' },
          steps: [
            {
              id: 'pick',
              uses: 'builtin/router',
              with: { text: 'x', routes: ROUTES },
            },
          ],
        },
        fix: {
          needs: 'decide',
          if: "needs.decide.outputs.route == 'Fix'",
          steps: [{ run: 'echo fix' }],
        },
        ship: {
          needs: 'decide',
          if: "needs.decide.outputs.route == 'Ship'",
          steps: [{ run: 'echo ship' }],
        },
        report: {
          needs: ['fix', 'ship'],
          if: 'always()',
          steps: [{ run: 'echo report' }],
        },
        publish: { needs: ['report', 'fix'], steps: [{ run: 'echo publish' }] },
      },
    };
    const stack = projectWorkflowStack(pipeline);
    const cards = stack.nodes.flatMap((node) =>
      node.kind === 'step' ? [node.jobId] : [],
    );
    // publish never shows as a plain card that follows report unconditionally.
    expect(cards).not.toContain('publish');
    const last = stack.nodes.at(-1);
    expect(last?.kind === 'unsupported' ? last.jobIds : []).toContain(
      'publish',
    );
  });

  it('shows a step with a wrapped condition read-only', () => {
    const pipeline: Pipeline = {
      name: 'Wrapped step if',
      on: 'dispatch',
      jobs: {
        one: { steps: [{ run: 'echo', if: '${{ true }}' }] },
      },
    };
    expect(projectWorkflowStack(pipeline).nodes).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['one'],
        reason: 'condition',
      }),
    ]);
  });

  it.each([['constructor'], ['__proto__'], ['toString']])(
    'shows a need on a missing job named %s read-only',
    (need) => {
      const pipeline: Pipeline = {
        name: 'Missing need',
        on: 'dispatch',
        jobs: { one: { needs: need, steps: [{ run: 'echo' }] } },
      };
      expect(projectWorkflowStack(pipeline).nodes).toEqual([
        expect.objectContaining({
          kind: 'unsupported',
          jobIds: ['one'],
          reason: 'invalid',
        }),
      ]);
    },
  );

  it('groups parallel branches that never rejoin, editable', () => {
    const pipeline: Pipeline = {
      name: 'Fan out',
      on: 'dispatch',
      jobs: {
        setup: { steps: [{ run: 'setup' }] },
        lint: { needs: 'setup', steps: [{ run: 'lint' }] },
        test: { needs: 'setup', steps: [{ run: 'test' }] },
      },
    };
    const stack = projectWorkflowStack(pipeline);
    expect(stack.nodes.map((n) => n.kind)).toEqual(['step', 'unsupported']);
    expect([...workflowStackEditableKeys(stack)]).toEqual([
      'step:setup:0',
      'job:setup',
      'job:lint',
      'step:lint:0',
      'job:test',
      'step:test:0',
    ]);
  });

  it('keeps every need of a job with its own condition', () => {
    // recover runs when setup fails and build is skipped, so its need on
    // setup still matters and the chain setup → build → recover is wrong.
    const pipeline: Pipeline = {
      name: 'Recover',
      on: 'dispatch',
      jobs: {
        setup: { steps: [{ run: 'setup' }] },
        build: { needs: 'setup', steps: [{ run: 'build' }] },
        recover: {
          needs: ['setup', 'build'],
          if: 'failure()',
          steps: [{ run: 'recover' }],
        },
      },
    };
    const stack = projectWorkflowStack(pipeline);
    const cards = stack.nodes.flatMap((n) =>
      n.kind === 'step' ? [n.jobId] : [],
    );
    expect(cards).not.toContain('recover');
    const last = stack.nodes.at(-1);
    expect(last?.kind === 'unsupported' ? last.jobIds : []).toContain(
      'recover',
    );
  });

  it.each([['inputs.threshold == -1'], ['inputs.true == 1']])(
    'shows a job condition the executor rejects (%s) read-only',
    (condition) => {
      const pipeline: Pipeline = {
        name: 'Rejected condition',
        on: 'dispatch',
        jobs: { one: { if: condition, steps: [{ run: 'echo' }] } },
      };
      expect(projectWorkflowStack(pipeline).nodes).toEqual([
        expect.objectContaining({
          kind: 'unsupported',
          jobIds: ['one'],
          reason: 'condition',
        }),
      ]);
    },
  );

  it('shows jobs whose names are not text read-only, with text names', () => {
    const pipeline = parsePipelineText(`pipeline:
  name: Object names
  on: dispatch
  jobs:
    one:
      steps:
        - name: {title: Build}
          run: echo
    two:
      needs: one
      name: [Deploy]
      steps:
        - run: echo
`);
    const stack = projectWorkflowStack(pipeline);
    expect(stack.nodes).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['one'],
        reason: 'invalid',
        jobNames: ['one'],
      }),
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['two'],
        reason: 'invalid',
        jobNames: ['two'],
      }),
    ]);
  });

  it('keeps a condition with a dotted quoted value editable', () => {
    const pipeline: Pipeline = {
      name: 'Quoted value',
      on: 'dispatch',
      jobs: {
        one: {
          if: 'inputs.file == "report.true.json"',
          steps: [{ run: 'echo' }],
        },
      },
    };
    expect(projectWorkflowStack(pipeline).nodes).toEqual([
      expect.objectContaining({ kind: 'step', jobId: 'one' }),
    ]);
  });

  it('puts a dependency cycle in one read-only group', () => {
    const pipeline: Pipeline = {
      name: 'Cycle',
      on: 'dispatch',
      jobs: {
        a: { needs: 'b', steps: [{ run: 'a' }] },
        b: { needs: 'a', steps: [{ run: 'b' }] },
      },
    };
    expect(projectWorkflowStack(pipeline).nodes).toEqual([
      expect.objectContaining({
        kind: 'unsupported',
        jobIds: ['a', 'b'],
        reason: 'invalid',
      }),
    ]);
  });
});
