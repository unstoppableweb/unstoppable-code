// CAN-6169 (plan CP-18): cloud run preflight refuses, before a sandbox
// starts, the steps the pipeline host would refuse at start. The cloud runner
// is that host, and the web core cannot read the bundled action manifests,
// so preflight carries the host's verdict for each bundled action. This
// golden runs the host's own classifier over the real manifests and fails
// when the two disagree or a bundled action is missing from preflight.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import {
  CLOUD_RUN_BUNDLED_ACTIONS,
  CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL,
  CLOUD_RUN_COMPOSITE_MODEL_ACTIONS,
  CLOUD_RUN_HOST_ACTIONS,
  CLOUD_RUN_PORTABLE_MODEL_ACTIONS,
  preflightCloudRun,
} from '@canopy/pipeline-interop/cloud-preflight';
import {
  CLOUD_DEFAULT_STEP_MODEL,
  CLOUD_MODEL_ACTION_HARNESSES,
  CLOUD_NATIVE_MODEL_ALIASES,
  CLOUD_NATIVE_MODEL_GATEWAY_IDS,
  findCloudModelItems,
} from '@canopy/pipeline-interop/cloud-model-preflight';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isPipelineHostActionId } from '@canopy/execution-engine/pipelines/host-actions';
import {
  DEFAULT_CLAUDE_MODEL,
  OLLAMA_MODEL_PREFIX,
  isOllamaModel,
} from '@canopy/execution-engine/model-catalog';
import {
  isCopilotModel,
  toCopilotModelId,
} from '@canopy/execution-engine/lib/copilot-models';
import {
  isCursorModel,
  toCursorModelId,
} from '@canopy/execution-engine/lib/cursor-models';
import {
  isOpenCodeModel,
  toOpenCodeModelId,
} from '@canopy/execution-engine/lib/opencode-models';
import { resolveActionRuntime } from '@canopy/execution-engine/node/pipelines/action-resolver';
import {
  getProjectActionsDir,
  getProjectActionsDirCandidates,
} from '@canopy/execution-engine/node/pipelines/config-paths';
import {
  DAEMON_PORTABLE_MODEL_ACTIONS,
  classifyDaemonPipeline,
} from '@canopy/execution-engine/node/pipelines/daemon-eligibility';

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../resources/actions');

/** A global pipeline of one step, the shape preflight accepts. */
function oneStep(step: Step, extra: Partial<Pipeline> = {}): Pipeline {
  return {
    name: 't',
    scope: 'global',
    on: 'dispatch',
    jobs: { j: { steps: [step] } },
    ...extra,
  };
}

/**
 * What the cloud runner's host decides, with the options the web core owner
 * serves and the tsx CLI the runner stages (CAN-6316 G1).
 */
function hostVerdict(pipeline: Pipeline): string {
  const result = classifyDaemonPipeline(
    pipeline,
    {
      runtime: {
        bundledActionsDir: BUNDLED_ACTIONS,
        getProjectActionsDir,
        getProjectActionsDirCandidates,
        tsxCli: '/runner/tsx/node_modules/tsx/dist/cli.mjs',
      },
    },
    {
      modelSteps: 'claude_codex',
      hostSteps: 'owner',
      compositeModels: 'resolve',
    },
  );
  return result.eligible ? 'portable' : result.reason;
}

function preflightVerdict(pipeline: Pipeline): string {
  return preflightCloudRun(pipeline)[0]?.reason ?? 'portable';
}

const bundled = readdirSync(BUNDLED_ACTIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

it('carries the host verdict for every bundled action and nothing else', () => {
  expect(Object.keys(CLOUD_RUN_BUNDLED_ACTIONS).sort()).toEqual(bundled);
  const host = Object.fromEntries(
    bundled.map((name) => [
      name,
      hostVerdict(oneStep({ uses: `builtin/${name}` })),
    ]),
  );
  expect(CLOUD_RUN_BUNDLED_ACTIONS).toEqual(host);
});

it('refuses the bundled actions whose scope leaves out global runs', () => {
  const runtime = {
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  };
  const outsideGlobal = bundled.filter((name) => {
    const resolved = resolveActionRuntime(`builtin/${name}`, runtime);
    if (resolved === null) throw new Error(`builtin/${name} does not resolve`);
    return !resolved.definition.scopes.includes('global');
  });
  expect([...CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL].sort()).toEqual(
    outsideGlobal,
  );
  const portable = outsideGlobal.filter(
    (name) => CLOUD_RUN_BUNDLED_ACTIONS[name] === 'portable',
  );
  for (const name of portable)
    expect(preflightVerdict(oneStep({ uses: `builtin/${name}` }))).toBe(
      'action_scope',
    );
});

it('checks the same host and model actions the host does', () => {
  expect(bundled.filter((name) => isPipelineHostActionId(name)).sort()).toEqual(
    [...CLOUD_RUN_HOST_ACTIONS].sort(),
  );
  expect([...CLOUD_RUN_PORTABLE_MODEL_ACTIONS].sort()).toEqual(
    [...DAEMON_PORTABLE_MODEL_ACTIONS.keys()].sort(),
  );
});

it("checks a composite's model as the model step inside it", () => {
  const runtime = {
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  };
  const composites: Record<
    string,
    { action: string; forwardsPermissionPreset: boolean }
  > = {};
  for (const name of bundled) {
    const resolved = resolveActionRuntime(`builtin/${name}`, runtime);
    if (resolved?.definition.runs.using !== 'composite') continue;
    const modelSteps = resolved.definition.runs.steps.filter((step) =>
      DAEMON_PORTABLE_MODEL_ACTIONS.has(
        step.uses?.slice('builtin/'.length) ?? '',
      ),
    );
    if (modelSteps.length === 0) continue;
    const [modelStep] = modelSteps;
    // One model step, running the composite's own model input.
    expect([name, modelSteps.length]).toEqual([name, 1]);
    expect([name, String(modelStep?.with?.model).trim()]).toEqual([
      name,
      '${{ inputs.model }}',
    ]);
    // Its preset is the composite step's, or fixed to one Codex runs.
    const preset = modelStep?.with?.permission_preset;
    const forwards =
      String(preset).trim() === '${{ inputs.permission_preset }}';
    if (forwards)
      expect([
        name,
        resolved.definition.inputs?.permission_preset?.default,
      ]).not.toEqual([name, 'none']);
    else expect([name, preset]).not.toEqual([name, 'none']);
    composites[name] = {
      action: modelStep?.uses?.slice('builtin/'.length) ?? '',
      forwardsPermissionPreset: forwards,
    };
  }
  expect(CLOUD_RUN_COMPOSITE_MODEL_ACTIONS).toEqual(composites);
});

it.each<[string, Pipeline]>([
  ['a tsx run step', oneStep({ run: 'console.log(1)', shell: 'tsx' })],
  [
    'a tsx job default',
    {
      name: 't',
      scope: 'global',
      on: 'dispatch',
      jobs: {
        j: { defaults: { run: { shell: 'tsx' } }, steps: [{ run: 'x' }] },
      },
    },
  ],
  ['an expression action', oneStep({ uses: '${{ inputs.action }}' })],
  ['an aliased bundled path', oneStep({ uses: 'builtin/./run-pipeline' })],
  ['a bundled name in another case', oneStep({ uses: 'builtin/Run-Pipeline' })],
  ['a name the table inherits', oneStep({ uses: 'builtin/constructor' })],
  ['an unknown bundled action', oneStep({ uses: 'builtin/no-such-action' })],
  [
    'an expression model',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', model: '${{ inputs.model }}' },
    }),
  ],
  [
    'a model alias the core did not resolve',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      { model_aliases: [{ id: 'fast', name: 'Fast' }] },
    ),
  ],
  [
    'a plugin collection on a model step',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', plugin_collection_id: 'tools' },
    }),
  ],
  [
    'message attachments',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', attachments: 'a.txt' },
    }),
  ],
  [
    'message file references',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', file_references: 'a.txt' },
    }),
  ],
  [
    'a message with its own model',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', model: 'sonnet' },
    }),
  ],
  [
    'an expression model on a composite',
    oneStep({ uses: 'builtin/coder', with: { model: '${{ inputs.model }}' } }),
  ],
  [
    "a composite's model alias the core did not resolve",
    oneStep(
      { uses: 'builtin/planner', with: { model: 'fast' } },
      { model_aliases: [{ id: 'fast', name: 'Fast' }] },
    ),
  ],
  [
    'a composite in a workflow with plugin collections',
    oneStep(
      { uses: 'builtin/spec-writer' },
      { plugin_collections: [{ id: 'c', name: 'C', defaults: [] }] },
    ),
  ],
  [
    "a composite's own plugin collection, which reaches no step",
    oneStep({
      uses: 'builtin/phase-compaction',
      with: { plugin_collection_id: 'tools' },
    }),
  ],
  ['an agent-hinted run step', oneStep({ run: 'x', log_format_hint: 'agent' })],
  ['a plain shell step', oneStep({ run: 'echo hi' })],
])('refuses %s for the reason the host does', (_name, pipeline) => {
  expect(preflightVerdict(pipeline)).toBe(hostVerdict(pipeline));
});

// CAN-6316: each pipeline host gap that cloud runs refuse tells the user
// why and what to do instead, as the parity matrix's gap decisions say.
it.each<[string, Pipeline, string, string]>([
  [
    'a child workflow',
    oneStep({ uses: 'builtin/run-pipeline', with: { pipeline: 'p' } }),
    'G2',
    'Copy its jobs into this workflow',
  ],
  [
    'a commit',
    oneStep({ uses: 'builtin/git-commit-push' }),
    'G3',
    "Cloud runs can't commit, push or open pull requests yet.",
  ],
  [
    'a pull request',
    oneStep({ uses: 'builtin/github-create-pr' }),
    'G3',
    "Cloud runs can't commit, push or open pull requests yet.",
  ],
  [
    'an agent-hinted run step',
    oneStep({ run: 'x', log_format_hint: 'agent' }),
    'G3',
    'Use agent-prompt for this step',
  ],
  [
    'an expression action',
    oneStep({ uses: '${{ inputs.action }}' }),
    'G4',
    'Name the action in uses',
  ],
  [
    'an expression model',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', model: '${{ inputs.model }}' },
    }),
    'G4',
    'Name the model in this step',
  ],
  [
    'message attachments',
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', attachments: 'a.txt' },
    }),
    'G6',
    'Put the text in text or text_file',
  ],
  [
    'a plugin collection',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', plugin_collection_id: 'c' },
    }),
    'CP-25',
    'Remove the plugin collection',
  ],
])(
  'refuses %s with its gap and alternative',
  (_name, pipeline, parityId, says) => {
    const [refusal] = preflightCloudRun(pipeline);
    expect(refusal?.parityId).toBe(parityId);
    expect(refusal?.message).toContain(says);
  },
);

// CAN-6174 (plan CP-26): the cloud model preflight runs in the web core,
// which can't read the desktop's model catalog, so it carries the host's
// harnesses per model action, the default step model and the local-only
// model id formats. These fail when the host or the catalog drifts.
describe('cloud model preflight', () => {
  it('offers each model action only the harnesses the host runs it on', () => {
    expect(CLOUD_MODEL_ACTION_HARNESSES).toEqual(
      Object.fromEntries(DAEMON_PORTABLE_MODEL_ACTIONS),
    );
  });

  it('routes the desktop models and aliases the desktop catalog pins', () => {
    const section = z.object({
      models: z.array(
        z.object({ id: z.string(), gatewayId: z.string().optional() }),
      ),
      modelAliases: z.record(z.string(), z.string()).default({}),
    });
    const manifest = z
      .object({ 'claude-code': section, codex: section })
      .parse(
        JSON.parse(
          readFileSync(
            resolve(__dirname, '../../../../../../package.json'),
            'utf8',
          ),
        ),
      );
    const ids: Record<string, string> = {};
    const aliases: Record<string, string> = {};
    for (const config of [manifest['claude-code'], manifest.codex]) {
      for (const model of config.models)
        if (model.gatewayId !== undefined) ids[model.id] = model.gatewayId;
      Object.assign(aliases, config.modelAliases);
    }
    expect(CLOUD_NATIVE_MODEL_GATEWAY_IDS).toEqual(ids);
    expect(CLOUD_NATIVE_MODEL_ALIASES).toEqual(aliases);
  });

  it('checks the model a step without one runs', () => {
    expect(CLOUD_DEFAULT_STEP_MODEL).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("lists a composite's model with the harnesses its model step runs", () => {
    const context = {
      catalog: [
        {
          modelId: 'anthropic/claude-sonnet-5.5',
          label: 'Sonnet',
          harness: 'claude' as const,
        },
        {
          modelId: 'openai/gpt-6-luna',
          label: 'Luna',
          harness: 'codex' as const,
        },
      ],
      isBlocked: (): boolean => false,
    };
    const [cursor] = findCloudModelItems(
      oneStep({
        uses: 'builtin/coder',
        with: { model: toCursorModelId('gpt-5') },
      }),
      context,
    );
    expect(cursor).toMatchObject({
      reason: 'local_harness',
      harness: 'cursor',
    });
    expect(cursor?.alternatives.map((option) => option.harness)).toEqual([
      'claude',
      'codex',
    ]);
    const [codex] = findCloudModelItems(
      oneStep({
        uses: 'builtin/phase-compaction',
        with: { model: 'gpt-6-luna' },
      }),
      context,
    );
    expect(codex).toMatchObject({ reason: 'action_harness', harness: 'codex' });
    expect(
      findCloudModelItems(
        oneStep({ uses: 'builtin/planner', with: { model: 'sonnet' } }),
        context,
      ),
    ).toEqual([]);
    // A composite that fixes its model step's preset ignores the step's own;
    // one that forwards it can't run Codex with `none`.
    const codexWithNone = (uses: string): Pipeline =>
      oneStep({
        uses,
        with: { model: 'gpt-6-luna', permission_preset: 'none' },
      });
    expect(
      findCloudModelItems(codexWithNone('builtin/planner'), context),
    ).toEqual([]);
    expect(
      findCloudModelItems(codexWithNone('builtin/coder'), context),
    ).toMatchObject([{ reason: 'action_harness', harness: 'codex' }]);
  });

  it.each<[string, string]>([
    [toCursorModelId('gpt-5'), 'cursor'],
    ['cursor-default', 'cursor'],
    [toCopilotModelId('gpt-5'), 'copilot'],
    [toOpenCodeModelId('openai/gpt-5'), 'opencode'],
    [`${OLLAMA_MODEL_PREFIX}llama3`, 'ollama'],
  ])('reads %s as a %s model', (model, harness) => {
    const [item] = findCloudModelItems(
      oneStep({ uses: 'builtin/agent-prompt', with: { prompt: 'x', model } }),
      { catalog: [], isBlocked: () => false },
    );
    expect(item?.harness).toBe(harness);
    expect(isCursorModel(model)).toBe(harness === 'cursor');
    expect(isCopilotModel(model)).toBe(harness === 'copilot');
    expect(isOpenCodeModel(model)).toBe(harness === 'opencode');
    expect(isOllamaModel(model)).toBe(harness === 'ollama');
  });
});
