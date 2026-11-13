// CAN-5095: the classifier admits the Claude and Codex model steps the
// daemon's pipeline host runs, behind an option, and refuses every other
// model step with a reason that names why. Runs over the real bundled action
// manifests. CAN-5831: Ollama models on the agent actions are admitted too.
// CAN-5832: model alias steps are admitted by what their alias names for the
// run.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COPILOT_MODELS,
  CURSOR_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  OLLAMA_MODELS,
  OPENCODE_MODELS,
  getModelSource,
  initClaudeModels,
  initCodexModels,
  initCopilotModels,
  initModelHarnessAssignments,
  initOllamaModels,
  initOpenCodeModels,
} from '@canopy/desktop-shared/types';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { resolveModelAlias } from '@canopy/execution-engine/model-catalog';
import { STATIC_MODEL_REFERENCE_ALIASES } from '@canopy/pipeline-interop/static-model-reference-aliases';
import { toCopilotModelId } from '@canopy/execution-engine/lib/copilot-models';
import { toOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  DAEMON_PORTABLE_MODEL_ACTIONS,
  classifyDaemonPipeline,
  resolveDaemonPipelineInputs,
  type DaemonPipelineClassification,
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

const ADMIT = { modelSteps: 'claude_codex' } as const;

function oneStep(step: Step, extra: Partial<Pipeline> = {}): Pipeline {
  return {
    name: 't',
    on: 'dispatch',
    jobs: { j: { steps: [step] } },
    ...extra,
  };
}

function agentPrompt(model?: string): Step {
  return {
    uses: 'builtin/agent-prompt',
    with: { prompt: 'x', ...(model !== undefined ? { model } : {}) },
  };
}

describe('classifyDaemonPipeline with model steps', () => {
  beforeAll(() => {
    // `haiku` is git-commit-push's runner default (CAN-6012).
    initClaudeModels([
      { id: DEFAULT_CLAUDE_MODEL, label: 'Opus' },
      { id: resolveModelAlias('haiku'), label: 'Haiku' },
    ]);
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'Codex default' }]);
    const managed = { supportsVision: false, supportedThinkingLevels: [] };
    initCopilotModels([
      {
        id: toCopilotModelId('gpt-5'),
        rawModelId: 'gpt-5',
        label: 'GPT-5',
        ...managed,
      },
    ]);
    initOpenCodeModels([
      {
        id: toOpenCodeModelId('anthropic/claude-sonnet-4'),
        rawModelId: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        ...managed,
      },
    ]);
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
  });

  it('keeps refusing every model step by default', () => {
    const pipeline = oneStep(agentPrompt());
    for (const options of [undefined, { modelSteps: 'refuse' } as const]) {
      expect(classifyDaemonPipeline(pipeline, context, options)).toEqual({
        eligible: false,
        reason: 'model_step',
        jobId: 'j',
        stepIndex: 0,
        uses: 'builtin/agent-prompt',
      });
    }
  });

  it('admits Claude and Codex agent steps when model steps are admitted', () => {
    expect(
      classifyDaemonPipeline(oneStep(agentPrompt()), context, ADMIT),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(DEFAULT_CODEX_MODEL)),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    expect(
      classifyDaemonPipeline(
        {
          name: 't',
          on: 'dispatch',
          jobs: {
            a: { steps: [agentPrompt(DEFAULT_CODEX_MODEL)] },
            b: { steps: [agentPrompt()] },
          },
        },
        context,
        ADMIT,
      ),
    ).toEqual({
      eligible: true,
      modelSteps: 2,
      modelHarnesses: ['claude', 'codex'],
    });
    for (const name of [
      'agent-loop',
      'plan-with-review',
      'quality-gate',
      'router',
      'condenser',
    ]) {
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: `builtin/${name}`,
            with: { model: DEFAULT_CLAUDE_MODEL },
          }),
          context,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    }
  });

  it('admits Ollama agent steps on the Claude and Codex harnesses', () => {
    const ollama = OLLAMA_MODELS[0] ?? '';
    expect(getModelSource(ollama)).toBe('ollama');
    for (const uses of ['builtin/agent-prompt', 'builtin/agent-resume']) {
      expect(
        classifyDaemonPipeline(
          oneStep({ uses, with: { prompt: 'x', model: ollama } }),
          context,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    }
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: ollama,
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    try {
      expect(
        classifyDaemonPipeline(oneStep(agentPrompt(ollama)), context, ADMIT),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    } finally {
      initModelHarnessAssignments({ revision: 0, assignments: [] });
    }
  });

  it('refuses models the daemon does not run', () => {
    // An Ollama model resolves a local route only on the model-aware agent
    // actions, in process as in the daemon (CAN-5831 D1).
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/router',
          with: { model: OLLAMA_MODELS[0] ?? '' },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    const picks: Array<[string, string]> = [
      [CURSOR_MODELS[0] ?? '', 'cursor-managed'],
      [COPILOT_MODELS[0] ?? '', 'copilot-managed'],
      [OPENCODE_MODELS[0] ?? '', 'opencode-managed'],
    ];
    for (const [model, source] of picks) {
      expect(model).not.toBe('');
      expect(getModelSource(model)).toBe(source);
    }
    for (const model of picks.map(([model]) => model)) {
      expect(
        classifyDaemonPipeline(oneStep(agentPrompt(model)), context, ADMIT),
      ).toMatchObject({ eligible: false, reason: 'model_provider' });
    }
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/router',
          with: { model: DEFAULT_CODEX_MODEL },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
  });

  it('refuses model actions it does not run', () => {
    const steps: Step[] = [
      { uses: 'builtin/github-create-pr' },
      { run: 'claude -p hi', log_format_hint: 'agent' },
    ];
    for (const step of steps) {
      expect(
        classifyDaemonPipeline(oneStep(step), context, ADMIT),
      ).toMatchObject({ eligible: false, reason: 'model_action' });
    }
  });

  it('admits git-commit-push by its own model chain, on Claude only', () => {
    // CAN-6012 PR 2: `commit_model`, then the run's preference variable, then
    // the runner's Haiku default, as the action resolves it.
    const commit = (withInputs?: Record<string, string>): Pipeline =>
      oneStep({
        uses: 'builtin/git-commit-push',
        ...(withInputs && { with: withInputs }),
      });
    const withEnv = (
      env: Record<string, string>,
    ): DaemonPipelineClassifierContext => ({ ...context, env });
    // Only an owner that runs the precommit-failure hook admits it (D3).
    const OWNER = { ...ADMIT, commitHooks: 'owner' } as const;
    const claude = {
      eligible: true,
      modelSteps: 1,
      modelHarnesses: ['claude'],
    };
    expect(classifyDaemonPipeline(commit(), context, OWNER)).toEqual(claude);
    expect(
      classifyDaemonPipeline(
        commit({ commit_model: DEFAULT_CLAUDE_MODEL }),
        context,
        OWNER,
      ),
    ).toEqual(claude);
    // A blank input skips the preference and takes the default.
    expect(
      classifyDaemonPipeline(
        commit({ commit_model: '  ' }),
        withEnv({
          [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]: DEFAULT_CODEX_MODEL,
        }),
        OWNER,
      ),
    ).toEqual(claude);
    // A Codex commit model, named or preferred, stays in process.
    for (const [candidate, ctx] of [
      [commit({ commit_model: DEFAULT_CODEX_MODEL }), context],
      [
        commit(),
        withEnv({
          [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]: DEFAULT_CODEX_MODEL,
        }),
      ],
    ] as const)
      expect(classifyDaemonPipeline(candidate, ctx, OWNER)).toMatchObject({
        eligible: false,
        reason: 'model_provider',
      });
    expect(
      classifyDaemonPipeline(
        commit({ commit_model: '${{ inputs.model }}' }),
        { ...context, inputs: { model: DEFAULT_CLAUDE_MODEL } },
        OWNER,
      ),
    ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
    expect(classifyDaemonPipeline(commit(), context)).toMatchObject({
      eligible: false,
      reason: 'model_step',
    });
  });

  it('refuses git-commit-push for a host whose owner does not run its hook', () => {
    // CAN-6012 D3: the cloud runner (model and host steps, CAN-6169) and the
    // CLI route classify without `commitHooks`, so the step stays
    // `model_action` there until CP-30 brokers its credentials.
    const commit = oneStep({
      uses: 'builtin/git-commit-push',
      with: { commit_model: DEFAULT_CLAUDE_MODEL },
    });
    for (const options of [
      { modelSteps: 'claude_codex', hostSteps: 'owner' },
      ADMIT,
      { ...ADMIT, commitHooks: 'refuse' },
    ] as const)
      expect(classifyDaemonPipeline(commit, context, options)).toMatchObject({
        eligible: false,
        reason: 'model_action',
      });
    expect(DAEMON_PORTABLE_MODEL_ACTIONS.has('git-commit-push')).toBe(false);
  });

  it('admits parallel-agents on the Claude harness only', () => {
    // CAN-6012 D2: its prompts run on the step's one route and Ledger attempt.
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'builtin/parallel-agents', with: { prompts: '[]' } }),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/parallel-agents',
          with: { model: DEFAULT_CODEX_MODEL },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'builtin/parallel-agents' }),
        context,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_step' });
  });

  it('admits a top-level model that is exactly one run input', () => {
    // CAN-6012 D1: classified by the input's value, resolved as the
    // executor resolves it at start.
    const withInputs = (
      inputs: DaemonPipelineClassifierContext['inputs'],
    ): DaemonPipelineClassifierContext => ({ ...context, inputs });
    for (const [model, harness] of [
      [DEFAULT_CLAUDE_MODEL, 'claude'],
      [DEFAULT_CODEX_MODEL, 'codex'],
    ] as const) {
      for (const expression of [
        '${{ inputs.model }}',
        '${{inputs.model}}',
        ' ${{  inputs.model  }} ',
      ]) {
        expect(
          classifyDaemonPipeline(
            oneStep(agentPrompt(expression)),
            withInputs({ model }),
            ADMIT,
          ),
        ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: [harness] });
      }
    }
    // An input naming a provider the daemon does not run stays in process.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('${{ inputs.model }}')),
        withInputs({ model: CURSOR_MODELS[0] ?? '' }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    // An input naming an alias resolves through the run's aliases.
    const model_aliases = [
      { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CLAUDE_MODEL } },
    ];
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('${{ inputs.model }}'), { model_aliases }),
        {
          ...withInputs({ model: 'fast' }),
          modelAliases: {
            fast: { base: DEFAULT_CODEX_MODEL, plugins: false },
          },
        },
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('${{ inputs.model }}'), { model_aliases }),
        withInputs({ model: 'fast' }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_alias' });
    // Anything that is not exactly one resolved scalar input stays dynamic.
    for (const [model, inputs] of [
      ['${{ inputs.model }}', undefined],
      ['${{ inputs.model }}', {}],
      ['${{ inputs.model }}', { model: { id: DEFAULT_CLAUDE_MODEL } }],
      ['${{ inputs.other }}', { model: DEFAULT_CLAUDE_MODEL }],
      ['${{ steps.a.outputs.model }}', { model: DEFAULT_CLAUDE_MODEL }],
      ['${{ env.MODEL }}', { model: DEFAULT_CLAUDE_MODEL }],
      ['${{ inputs.model }}-x', { model: DEFAULT_CLAUDE_MODEL }],
      ['${{ inputs.model || inputs.other }}', { model: DEFAULT_CLAUDE_MODEL }],
    ] as const) {
      expect(
        classifyDaemonPipeline(
          oneStep(agentPrompt(model)),
          withInputs(inputs),
          ADMIT,
        ),
      ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
    }
  });

  it("resolves a run's inputs as its executor does at start", () => {
    const pipeline = oneStep(agentPrompt('${{ inputs.model }}'), {
      on: {
        dispatch: {
          inputs: {
            model: { type: 'string', default: DEFAULT_CLAUDE_MODEL },
            turns: { type: 'number' },
          },
        },
      },
    });
    expect(resolveDaemonPipelineInputs(pipeline, undefined)).toEqual({
      model: DEFAULT_CLAUDE_MODEL,
    });
    expect(
      resolveDaemonPipelineInputs(pipeline, {
        model: DEFAULT_CODEX_MODEL,
        turns: '3',
      }),
    ).toEqual({ model: DEFAULT_CODEX_MODEL, turns: 3 });
    // Inputs the executor would refuse resolve to nothing; the run stays
    // in process and fails there as before.
    expect(
      resolveDaemonPipelineInputs(pipeline, { other: 'x' }),
    ).toBeUndefined();
    expect(
      resolveDaemonPipelineInputs(pipeline, { turns: 'many' }),
    ).toBeUndefined();
    expect(
      resolveDaemonPipelineInputs(
        { ...pipeline, on: 'dispatch', inputs: { model: {} } } as Pipeline,
        { model: DEFAULT_CLAUDE_MODEL },
      ),
    ).toBeUndefined();
  });

  it('admits model alias steps by what their alias names for the run', () => {
    // CAN-5832: the run's core resolves each alias at launch.
    const model_aliases = [
      { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CLAUDE_MODEL } },
      { id: 'agent', name: 'Agent', defaults: { agent_id: 'agent_model_1' } },
    ];
    const resolved = (
      modelAliases: DaemonPipelineClassifierContext['modelAliases'],
    ): DaemonPipelineClassifierContext => ({ ...context, modelAliases });
    // A pipeline that declares aliases and uses none is eligible.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(), { model_aliases }),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        resolved({ fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('agent'), { model_aliases }),
        resolved({ agent: { base: DEFAULT_CODEX_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['codex'] });
    // An alias the core could not resolve, one on an action that does not
    // resolve aliases, one naming a provider the daemon does not run, and
    // one that adds plugins to a Codex step stay in process.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_alias' });
    expect(
      classifyDaemonPipeline(
        oneStep(
          { uses: 'builtin/router', with: { model: 'fast' } },
          { model_aliases },
        ),
        resolved({ fast: { base: DEFAULT_CLAUDE_MODEL, plugins: false } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_alias' });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), { model_aliases }),
        resolved({ fast: { base: CURSOR_MODELS[0] ?? '', plugins: false } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_provider' });
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('agent'), { model_aliases }),
        resolved({ agent: { base: DEFAULT_CODEX_MODEL, plugins: true } }),
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
  });

  it('admits plugin collections the core resolved, on Claude steps only', () => {
    // CAN-5832: collections resolve in the run's core at launch; Codex
    // plugins stay in process (CAN-6012).
    const plugin_collections = [{ id: 'review', name: 'Review', defaults: [] }];
    const withCollections: DaemonPipelineClassifierContext = {
      ...context,
      pluginCollections: new Set(['review']),
      modelAliases: {
        fast: { base: DEFAULT_CLAUDE_MODEL, plugins: true },
      },
    };
    const step = (model?: string): Step => ({
      uses: 'builtin/agent-prompt',
      with: {
        prompt: 'x',
        plugin_collection_id: 'review',
        ...(model !== undefined ? { model } : {}),
      },
    });
    expect(
      classifyDaemonPipeline(
        oneStep(step(), { plugin_collections }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // An alias that adds plugins runs on Claude too.
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('fast'), {
          plugin_collections,
          model_aliases: [
            {
              id: 'fast',
              name: 'Fast',
              defaults: {
                base: DEFAULT_CLAUDE_MODEL,
                plugin_collection_id: 'review',
              },
            },
          ],
        }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // The core keys its snapshots by the trimmed id the executor looks up.
    expect(
      classifyDaemonPipeline(
        oneStep(step(), {
          plugin_collections: [
            { id: ' review ', name: 'Review', defaults: [] },
          ],
        }),
        withCollections,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });
    // A Codex step with a collection, a collection the core did not resolve
    // (or one naming an MCP server, which it leaves out), and a collection on
    // an action that loads none stay in process.
    for (const [candidate, ctx] of [
      [
        oneStep(step(DEFAULT_CODEX_MODEL), { plugin_collections }),
        withCollections,
      ],
      [oneStep(step(), { plugin_collections }), context],
      [
        oneStep(
          {
            uses: 'builtin/router',
            with: {
              model: DEFAULT_CLAUDE_MODEL,
              plugin_collection_id: 'review',
            },
          },
          { plugin_collections },
        ),
        withCollections,
      ],
    ] as const)
      expect(classifyDaemonPipeline(candidate, ctx, ADMIT)).toMatchObject({
        eligible: false,
        reason: 'plugin_collections',
      });
  });

  it('refuses expression models and plugin collections', () => {
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt('${{ inputs.model }}')),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
    const model_aliases = [
      { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CLAUDE_MODEL } },
    ];
    expect(
      classifyDaemonPipeline(
        oneStep(agentPrompt(), {
          plugin_collections: [{ id: 'c', name: 'C', defaults: [] }],
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
    expect(
      classifyDaemonPipeline(
        oneStep({
          uses: 'builtin/agent-prompt',
          with: { prompt: 'x', plugin_collection_id: 'c' },
        }),
        context,
        ADMIT,
      ),
    ).toMatchObject({ eligible: false, reason: 'plugin_collections' });
    expect(
      classifyDaemonPipeline(
        oneStep({ run: 'echo hi' }, { model_aliases }),
        context,
        ADMIT,
      ),
    ).toEqual({ eligible: true, modelSteps: 0, modelHarnesses: [] });
  });

  describe('composite actions', () => {
    let repo: string;

    beforeEach(() => {
      repo = realpathSync(
        mkdtempSync(join(tmpdir(), 'canopy-daemon-eligibility-models-')),
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

    it('walks composite actions to the model steps inside them', () => {
      const withRepo: DaemonPipelineClassifierContext = {
        ...context,
        repoPath: repo,
      };
      writeComposite(
        'wrap',
        '    - run: echo a\n' +
          '    - uses: builtin/agent-prompt\n' +
          '      with:\n' +
          '        prompt: x\n' +
          `        model: '${DEFAULT_CLAUDE_MODEL}'\n`,
      );
      expect(
        classifyDaemonPipeline(
          oneStep({ uses: 'project/wrap' }),
          withRepo,
          ADMIT,
        ),
      ).toEqual({ eligible: true, modelSteps: 1, modelHarnesses: ['claude'] });

      writeComposite(
        'wrap',
        '    - run: echo a\n' +
          '    - uses: builtin/agent-prompt\n' +
          '      with:\n' +
          '        prompt: x\n' +
          "        model: '${{ inputs.model }}'\n",
      );
      // Inside a composite, `inputs` are the composite's, not the run's.
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: 'project/wrap',
            with: { model: DEFAULT_CLAUDE_MODEL },
          }),
          { ...withRepo, inputs: { model: DEFAULT_CLAUDE_MODEL } },
          ADMIT,
        ),
      ).toEqual({
        eligible: false,
        reason: 'dynamic_model',
        jobId: 'j',
        stepIndex: 0,
        uses: 'project/wrap',
      });
    });

    it("classifies a composite's model by its inputs under compositeModels (CAN-6316 G4)", () => {
      const withRepo: DaemonPipelineClassifierContext = {
        ...context,
        repoPath: repo,
      };
      const RESOLVE = { ...ADMIT, compositeModels: 'resolve' } as const;
      const promptOn = (model: string): string =>
        '    - uses: builtin/agent-prompt\n' +
        '      with:\n' +
        '        prompt: x\n' +
        `        model: '${model}'\n`;
      writeComposite('wrap', promptOn('${{ inputs.model }}'));
      const run = (
        step: Step,
        extra: Partial<DaemonPipelineClassifierContext> = {},
        pipeline: Partial<Pipeline> = {},
      ): DaemonPipelineClassification =>
        classifyDaemonPipeline(
          oneStep(step, pipeline),
          { ...withRepo, ...extra },
          RESOLVE,
        );
      const claude = {
        eligible: true,
        modelSteps: 1,
        modelHarnesses: ['claude'],
      };
      const codex = {
        eligible: true,
        modelSteps: 1,
        modelHarnesses: ['codex'],
      };

      // The step's own model, or none: an input it is not passed reads as ''.
      expect(
        run({ uses: 'project/wrap', with: { model: DEFAULT_CODEX_MODEL } }),
      ).toEqual(codex);
      expect(run({ uses: 'project/wrap' })).toEqual(claude);
      // A run input, as for a top-level step; unknown without the run's inputs.
      const fromRun: Step = {
        uses: 'project/wrap',
        with: { model: '${{ inputs.model }}' },
      };
      expect(run(fromRun, { inputs: { model: DEFAULT_CODEX_MODEL } })).toEqual(
        codex,
      );
      expect(run(fromRun)).toMatchObject({
        eligible: false,
        reason: 'dynamic_model',
      });
      // Anything but exactly one input is decided only when the step runs.
      expect(
        run({ uses: 'project/wrap', with: { model: 'x${{ inputs.model }}' } }),
      ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
      writeComposite('wrap', promptOn('${{ inputs.model || env.M }}'));
      expect(
        run({ uses: 'project/wrap', with: { model: DEFAULT_CLAUDE_MODEL } }),
      ).toMatchObject({ eligible: false, reason: 'dynamic_model' });

      // A declared default, passed as written.
      const dir = join(getProjectActionsDir(repo), 'defaulted');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'action.yml'),
        'name: defaulted\n' +
          'inputs:\n' +
          '  model:\n' +
          `    default: '${DEFAULT_CODEX_MODEL}'\n` +
          'runs:\n  using: composite\n  steps:\n' +
          promptOn('${{ inputs.model }}'),
      );
      expect(run({ uses: 'project/defaulted' })).toEqual(codex);
      expect(
        run({
          uses: 'project/defaulted',
          with: { model: DEFAULT_CLAUDE_MODEL },
        }),
      ).toEqual(claude);

      // A built-in `$` alias, resolved as normalization resolves the step's
      // own model, at the top level too.
      const staticCodex = Object.keys(STATIC_MODEL_REFERENCE_ALIASES).find(
        (alias) =>
          STATIC_MODEL_REFERENCE_ALIASES[alias] === DEFAULT_CODEX_MODEL,
      );
      expect(staticCodex).toBeDefined();
      writeComposite('wrap', promptOn('${{ inputs.model }}'));
      expect(
        run({ uses: 'project/wrap', with: { model: staticCodex ?? '' } }),
      ).toEqual(codex);
      expect(run(agentPrompt(staticCodex))).toEqual(codex);
      expect(
        run({ uses: 'project/wrap', with: { model: '$no-such-alias' } }),
      ).toMatchObject({ eligible: false, reason: 'model_provider' });

      // Through nested composites, and into a model alias.
      writeComposite(
        'outer',
        '    - uses: project/defaulted\n' +
          '      with:\n' +
          "        model: '${{ inputs.model }}'\n",
      );
      expect(
        run({ uses: 'project/outer', with: { model: DEFAULT_CLAUDE_MODEL } }),
      ).toEqual(claude);
      expect(run({ uses: 'project/outer' })).toEqual(claude);
      const model_aliases = [
        { id: 'fast', name: 'Fast', defaults: { base: DEFAULT_CODEX_MODEL } },
      ];
      expect(
        run(
          { uses: 'project/outer', with: { model: 'fast' } },
          {},
          { model_aliases },
        ),
      ).toMatchObject({ eligible: false, reason: 'model_alias' });
      expect(
        run(
          { uses: 'project/outer', with: { model: 'fast' } },
          {
            modelAliases: {
              fast: { base: DEFAULT_CODEX_MODEL, plugins: false },
            },
          },
          { model_aliases },
        ),
      ).toEqual(codex);

      // The bundled composites, on the harnesses their model step runs.
      expect(
        run({ uses: 'builtin/coder', with: { model: DEFAULT_CODEX_MODEL } }),
      ).toEqual(codex);
      expect(
        run({
          uses: 'builtin/phase-compaction',
          with: { model: DEFAULT_CODEX_MODEL },
        }),
      ).toMatchObject({ eligible: false, reason: 'model_provider' });
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: 'builtin/coder',
            with: { model: DEFAULT_CLAUDE_MODEL },
          }),
          context,
          ADMIT,
        ),
      ).toMatchObject({ eligible: false, reason: 'dynamic_model' });
    });

    it('keeps a git-commit-push inside a composite in process (CAN-6012 D3)', () => {
      // Its owner's hook reads persisted step results; a composite keeps its
      // nested results in memory, so only a top-level step is admitted.
      writeComposite(
        'commit',
        '    - uses: builtin/git-commit-push\n' +
          '      with:\n' +
          `        commit_model: '${DEFAULT_CLAUDE_MODEL}'\n`,
      );
      expect(
        classifyDaemonPipeline(
          oneStep({ uses: 'project/commit' }),
          { ...context, repoPath: repo },
          { ...ADMIT, commitHooks: 'owner' },
        ),
      ).toEqual({
        eligible: false,
        reason: 'model_action',
        jobId: 'j',
        stepIndex: 0,
        uses: 'project/commit',
      });
    });
  });
});
