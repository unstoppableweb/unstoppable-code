// CAN-5086: the model-step classifier that keeps workflows with model,
// host, child pipeline or tsx steps out of the daemon. Runs over the real
// bundled action manifests.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import {
  listBuiltinActions,
  resolveAction,
} from '@canopy/execution-engine/node/pipelines/action-resolver';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  classifyDaemonPipeline,
  type DaemonPipelineClassifierContext,
} from '@canopy/execution-engine/node/pipelines/daemon-eligibility';

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../resources/actions');

const context: DaemonPipelineClassifierContext = {
  runtime: {
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  },
};

function oneStep(step: Step): Pipeline {
  return { name: 't', on: 'dispatch', jobs: { j: { steps: [step] } } };
}

describe('classifyDaemonPipeline', () => {
  it('refuses every bundled action that declares an agent log format', () => {
    const agentActions = listBuiltinActions().filter(
      (name) => resolveAction(`builtin/${name}`)?.log_format_hint === 'agent',
    );
    expect(agentActions.length).toBeGreaterThan(0);
    for (const name of agentActions) {
      expect(
        classifyDaemonPipeline(oneStep({ uses: `builtin/${name}` }), context),
      ).toEqual({
        eligible: false,
        reason: 'model_step',
        jobId: 'j',
        stepIndex: 0,
        uses: `builtin/${name}`,
      });
    }
  });

  it('refuses the actions that call the Claude SDK directly', () => {
    for (const name of ['condenser', 'git-commit-push', 'github-create-pr']) {
      expect(
        classifyDaemonPipeline(oneStep({ uses: `builtin/${name}` }), context),
      ).toMatchObject({ eligible: false, reason: 'model_step' });
    }
    for (const uses of ['builtin/./condenser', 'builtin/condenser/']) {
      expect(classifyDaemonPipeline(oneStep({ uses }), context)).toMatchObject({
        eligible: false,
        reason: 'model_step',
      });
    }
    // Resolves on a case-insensitive volume (macOS); unresolved elsewhere.
    expect(
      classifyDaemonPipeline(oneStep({ uses: 'builtin/Condenser' }), context),
    ).toMatchObject({ eligible: false });
  });

  it('admits shell, node and python steps and actions', () => {
    const steps: Step[] = [
      { run: 'echo hi' },
      { run: 'console.log(1)', shell: 'node' },
      { uses: 'builtin/git-workspace-details' },
      { uses: 'builtin/hello-world-py' },
      // Electron main shows its desktop notification (CAN-5868).
      { uses: 'builtin/notify' },
    ];
    for (const step of steps) {
      expect(classifyDaemonPipeline(oneStep(step), context)).toEqual({
        eligible: true,
        modelSteps: 0,
        modelHarnesses: [],
      });
    }
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          jobs: {
            a: { steps: steps.slice(0, 2) },
            b: { steps: steps.slice(2) },
          },
        },
        context,
      ),
    ).toEqual({ eligible: true, modelSteps: 0, modelHarnesses: [] });
  });

  it('refuses host, child pipeline and tsx steps with their reason', () => {
    const cases: Array<[Step, string]> = [
      [{ uses: 'builtin/create-worktree' }, 'host_step'],
      [{ uses: 'builtin/move-to-group' }, 'host_step'],
      [{ uses: 'builtin/run-pipeline' }, 'child_pipeline'],
      [{ uses: 'builtin/hello-world-ts' }, 'tsx_runtime'],
      [{ run: 'x', shell: 'tsx' }, 'tsx_runtime'],
    ];
    for (const [step, reason] of cases) {
      expect(classifyDaemonPipeline(oneStep(step), context)).toMatchObject({
        eligible: false,
        reason,
        jobId: 'j',
        stepIndex: 0,
      });
    }
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          jobs: {
            first: { steps: [{ run: 'echo a' }] },
            second: {
              steps: [{ run: 'echo b' }, { uses: 'builtin/move-to-group' }],
            },
          },
        },
        context,
      ),
    ).toEqual({
      eligible: false,
      reason: 'host_step',
      jobId: 'second',
      stepIndex: 1,
      uses: 'builtin/move-to-group',
    });
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          defaults: { run: { shell: 'tsx' } },
          jobs: { j: { steps: [{ run: 'x' }] } },
        },
        context,
      ),
    ).toMatchObject({ eligible: false, reason: 'tsx_runtime' });
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          defaults: { run: { shell: 'bash' } },
          jobs: {
            j: { defaults: { run: { shell: 'tsx' } }, steps: [{ run: 'x' }] },
          },
        },
        context,
      ),
    ).toMatchObject({ eligible: false, reason: 'tsx_runtime' });
  });

  it('admits tsx steps and actions on a runtime that stages its own tsx (CAN-6316 G1)', () => {
    const staged: DaemonPipelineClassifierContext = {
      runtime: { ...context.runtime, tsxCli: '/runner/tsx/dist/cli.mjs' },
    };
    const portable = { eligible: true, modelSteps: 0, modelHarnesses: [] };
    expect(
      classifyDaemonPipeline(oneStep({ run: 'x', shell: 'tsx' }), staged),
    ).toEqual(portable);
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'builtin/hello-world-ts' }),
        staged,
      ),
    ).toEqual(portable);
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          defaults: { run: { shell: 'tsx' } },
          jobs: { j: { steps: [{ run: 'x' }] } },
        },
        staged,
        { modelSteps: 'claude_codex' },
      ),
    ).toEqual(portable);
  });

  it('refuses unresolved and expression actions', () => {
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: './.canopy/actions/missing' }),
        context,
      ),
    ).toMatchObject({ eligible: false, reason: 'unresolved_action' });
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: '${{ inputs.action }}' }),
        context,
      ),
    ).toMatchObject({ eligible: false, reason: 'dynamic_action' });
  });

  describe('composite actions', () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(
        mkdtempSync(join(tmpdir(), 'canopy-daemon-eligibility-')),
      );
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    function writeComposite(name: string, steps: string): void {
      const dir = join(getProjectActionsDir(repo), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'action.yml'),
        `name: ${name}\nruns:\n  using: composite\n  steps:\n${steps}`,
      );
    }

    it('walks composite actions', () => {
      const withRepo: DaemonPipelineClassifierContext = {
        ...context,
        repoPath: repo,
      };
      writeComposite(
        'wrap',
        '    - run: echo a\n    - uses: builtin/agent-prompt\n',
      );
      expect(
        classifyDaemonPipeline(oneStep({ uses: 'project/wrap' }), withRepo),
      ).toEqual({
        eligible: false,
        reason: 'model_step',
        jobId: 'j',
        stepIndex: 0,
        uses: 'project/wrap',
      });

      writeComposite(
        'wrap',
        '    - run: echo a\n    - uses: builtin/create-worktree\n',
      );
      for (const options of [
        undefined,
        { modelSteps: 'claude_codex' as const },
      ])
        expect(
          classifyDaemonPipeline(
            oneStep({ uses: 'project/wrap' }),
            withRepo,
            options,
          ),
        ).toEqual({
          eligible: false,
          reason: 'host_step',
          jobId: 'j',
          stepIndex: 0,
          uses: 'project/wrap',
        });

      writeComposite('wrap', '    - run: echo a\n');
      expect(
        classifyDaemonPipeline(oneStep({ uses: 'project/wrap' }), withRepo),
      ).toEqual({ eligible: true, modelSteps: 0, modelHarnesses: [] });
      expect(
        classifyDaemonPipeline(
          oneStep({ uses: 'project/wrap', shell: 'tsx' }),
          withRepo,
        ),
      ).toMatchObject({
        eligible: false,
        reason: 'tsx_runtime',
        uses: 'project/wrap',
      });

      writeComposite('nest-1', '    - run: echo leaf\n');
      for (let level = 2; level <= 10; level += 1) {
        writeComposite(
          `nest-${level}`,
          `    - uses: project/nest-${level - 1}\n`,
        );
      }
      // The executor runs a step nine composites deep and fails one ten
      // deep (MAX_NESTED_STEP_DEPTH); the host admits what it runs (G5).
      expect(
        classifyDaemonPipeline(oneStep({ uses: 'project/nest-9' }), withRepo),
      ).toEqual({ eligible: true, modelSteps: 0, modelHarnesses: [] });
      expect(
        classifyDaemonPipeline(oneStep({ uses: 'project/nest-10' }), withRepo),
      ).toMatchObject({ eligible: false, reason: 'too_deep', jobId: 'j' });
    });
  });
});
