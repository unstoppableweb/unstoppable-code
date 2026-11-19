// CAN-6169 (plan CP-18): cloud run preflight refuses, before a sandbox
// starts, the steps the pipeline host would refuse at start. The cloud runner
// is that host, and the web core cannot read the bundled action manifests,
// so preflight carries the host's verdict for each bundled action. This
// golden runs the host's own classifier over the real manifests and fails
// when the two disagree or a bundled action is missing from preflight.
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import {
  CLOUD_RUN_ALIAS_MODEL_ACTIONS,
  CLOUD_RUN_BUNDLED_ACTIONS,
  CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_DIRECTORY,
  CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL,
  CLOUD_RUN_COMPOSITE_MODEL_ACTIONS,
  CLOUD_RUN_HOST_ACTIONS,
  CLOUD_RUN_PORTABLE_MODEL_ACTIONS,
  CLOUD_RUN_REPOSITORY_MODEL_INPUTS,
  cloudModelAliasOf,
  preflightCloudRun,
} from '@canopy/pipeline-interop/cloud-preflight';
import {
  CLOUD_DEFAULT_STEP_MODEL,
  CLOUD_MODEL_ACTION_HARNESSES,
  CLOUD_NATIVE_MODEL_ALIASES,
  CLOUD_NATIVE_MODEL_GATEWAY_IDS,
  CLOUD_NATIVE_MODEL_HARNESSES,
  applyCloudModelChoices,
  findCloudModelItems,
} from '@canopy/pipeline-interop/cloud-model-preflight';
import { readFileSync } from 'node:fs';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { BUNDLED_CLOUD_WORKFLOWS } from '@canopy/pipeline-interop/bundled-cloud-workflows.generated';
import {
  CLOUD_CHILD_WORKFLOWS_READ_MAX,
  CloudChildWorkflowsTooLarge,
  applyChildCloudModelChoices,
  applyCloudRunModelChoices,
  bundledChildWorkflow,
  childCloudModelChoices,
  cloudChildWorkflowResolver,
  cloudModelWorkflowProjection,
  findCloudRunModelItems,
  runPipelineStepIndexes,
} from '@canopy/pipeline-interop/cloud-child-workflows';
import { BUILTIN_APP_SKILL_TEMPLATES } from '@canopy/pipeline-interop/builtin-skills';
import { z } from 'zod';
import { isPipelineHostActionId } from '@canopy/execution-engine/pipelines/host-actions';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_CLAUDE_MODEL,
  OLLAMA_MODEL_PREFIX,
  getCurrentModelHarnessCatalog,
  getExecutionHarnessForModel,
  getGatewayModelEntry,
  getModelAliases,
  getModelSource,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  isOllamaModel,
} from '@canopy/execution-engine/model-catalog';
import {
  buildModelHarnessAssignmentSnapshot,
  getHydratedModelHarnessAssignment,
  initModelHarnessAssignments,
} from '@canopy/execution-engine/model-harnesses';
import { applyModelRegistrySnapshot } from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import { buildModelRegistrySnapshot } from '@canopy/execution-engine/node/pipelines/executor/model-registry-snapshot';
import {
  CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES,
  cloudRunModelRegistry,
} from '@canopy/pipeline-interop/cloud-model-registry';
import { WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES } from '@canopy/protocol/canopy-core';
import {
  AI_GATEWAY_MODEL_CATALOG_VERSION,
  type AiGatewayModel,
} from '@canopy/protocol/ai-gateway-models';
import { mergeAiGatewayModelCatalog } from '../../../ai-gateway-model-catalog';
import { parseModelPackageConfig } from '../../../model-config';
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
  DAEMON_ACTION_MODEL_INPUTS,
  DAEMON_ALIAS_MODEL_ACTIONS,
  DAEMON_BROKERED_REPOSITORY_MODEL_ACTIONS,
  DAEMON_PORTABLE_MODEL_ACTIONS,
  classifyDaemonPipeline,
  type DaemonModelAliasResolution,
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
 * What the web core resolves before a cloud run starts (CAN-6439): every
 * collection the workflow declares, and each inline model alias.
 */
function resolvedByWebCore(pipeline: Pipeline): {
  pluginCollections: ReadonlySet<string>;
  modelAliases: Record<string, DaemonModelAliasResolution>;
} {
  const modelAliases: Record<string, DaemonModelAliasResolution> = {};
  for (const alias of pipeline.model_aliases ?? []) {
    const resolved = cloudModelAliasOf(pipeline, alias.id);
    if (resolved)
      modelAliases[alias.id] = {
        base: resolved.base,
        plugins: resolved.pluginCollectionId !== undefined,
      };
  }
  return {
    pluginCollections: new Set(
      (pipeline.plugin_collections ?? []).map(({ id }) => id.trim()),
    ),
    modelAliases,
  };
}

/**
 * What the cloud runner's host decides, with the options the web core owner
 * serves, what it resolves before the start, and the tsx CLI the runner
 * stages (CAN-6316 G1). A folder or worktree run's launch is brokered
 * (CAN-6739); a global run's scope refuses the repository actions anyway.
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
      ...resolvedByWebCore(pipeline),
    },
    {
      modelSteps: 'claude_codex',
      hostSteps: 'owner',
      compositeModels: 'resolve',
      repositoryActions: 'brokered',
      // The web core gets a copy of each file a message attaches (CAN-6857).
      hostAttachments: 'copy',
      // A cloud runner's host runs same-target children, and hands children
      // on another worktree or the global scope to its owner (CAN-6868).
      childPipelines: 'host',
      delegatedChildren: 'owner',
      // Preflight checked a matrix axis model's values (CAN-7018).
      matrixModels: 'owner',
    },
  );
  return result.eligible ? 'portable' : result.reason;
}

function preflightVerdict(pipeline: Pipeline): string {
  return preflightCloudRun(pipeline)[0]?.reason ?? 'portable';
}

// The models a run's catalog names (CAN-6439): a model alias names its base
// model, which the host resolves against the run's catalog. It names the
// repository actions' default commit and PR models too (CAN-6739), which the
// cloud routes.
const RUN_MODELS: [string[], string][] = [
  [CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL],
  [CLAUDE_MODELS, 'haiku'],
  [CLAUDE_MODELS, 'sonnet'],
  [CODEX_MODELS, 'gpt-6.1-terra'],
];
beforeAll(() => {
  for (const [models, model] of RUN_MODELS) models.push(model);
});
afterAll(() => {
  for (const [models, model] of RUN_MODELS)
    models.splice(models.lastIndexOf(model), 1);
});

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

// CAN-6868: a child workflow runs in its run's host on the run's own target;
// one on another target is still refused (G2), by both.
it('admits a child workflow on the run’s own target only, as the host does', () => {
  const child: Step = { uses: 'builtin/run-pipeline' };
  for (const pipeline of [
    oneStep(child),
    oneStep({ ...child, target: { scope: 'inherit' } }),
  ]) {
    expect(preflightVerdict(pipeline)).toBe('portable');
    expect(hostVerdict(pipeline)).toBe('portable');
  }
  // Another worktree or the global scope: a run of its own (part 3b).
  for (const target of [
    { scope: 'worktree', workspace_id: 'w', worktree: { id: 't' } },
    { scope: 'global' },
  ] as const) {
    const pipeline = oneStep({ ...child, target });
    expect(preflightVerdict(pipeline)).toBe('portable');
    expect(hostVerdict(pipeline)).toBe('portable');
  }
  // A folder of the run isn't served yet.
  for (const target of [
    { scope: 'directory', path: 'sub' },
    { scope: 'directory' },
  ] as const) {
    const pipeline = oneStep({ ...child, target });
    expect(preflightVerdict(pipeline)).toBe('child_pipeline');
    expect(hostVerdict(pipeline)).toBe('child_pipeline');
  }
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
  // And those whose scope leaves out folder runs, refused there (CAN-6739).
  const outsideDirectory = bundled.filter((name) => {
    const resolved = resolveActionRuntime(`builtin/${name}`, runtime);
    return !resolved?.definition.scopes.includes('directory');
  });
  expect([...CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_DIRECTORY].sort()).toEqual(
    outsideDirectory,
  );
  for (const name of outsideDirectory)
    expect(
      preflightCloudRun(
        oneStep({ uses: `builtin/${name}` }, { scope: 'directory' }),
        { scope: 'directory' },
      ).map((refusal) => refusal.reason),
    ).toEqual(['action_scope']);
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
  // The repository actions and the input each names its model in (CAN-6739).
  expect(CLOUD_RUN_REPOSITORY_MODEL_INPUTS).toEqual(
    Object.fromEntries(
      [...DAEMON_BROKERED_REPOSITORY_MODEL_ACTIONS.keys()].map((name) => {
        const spec = DAEMON_ACTION_MODEL_INPUTS.get(name);
        return [
          name,
          { input: spec?.input, runnerDefault: spec?.runnerDefault },
        ];
      }),
    ),
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
    'a plugin collection the workflow does not declare',
    oneStep({
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', plugin_collection_id: 'tools' },
    }),
  ],
  [
    'a declared plugin collection on an agent step',
    oneStep(
      {
        uses: 'builtin/agent-prompt',
        with: { prompt: 'x', plugin_collection_id: 'tools' },
      },
      { plugin_collections: [{ id: 'tools', name: 'Tools', defaults: [] }] },
    ),
  ],
  [
    'a plugin collection on a model action the host takes none on',
    oneStep(
      {
        uses: 'builtin/router',
        with: { prompt: 'x', plugin_collection_id: 'tools' },
      },
      { plugin_collections: [{ id: 'tools', name: 'Tools', defaults: [] }] },
    ),
  ],
  [
    'an inline model alias',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          {
            id: 'fast',
            name: 'Fast',
            defaults: { base: DEFAULT_CLAUDE_MODEL },
          },
        ],
      },
    ),
  ],
  [
    'an inline model alias that adds a collection, on a Claude model',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          {
            id: 'fast',
            name: 'Fast',
            defaults: {
              base: DEFAULT_CLAUDE_MODEL,
              plugin_collection_id: 'tools',
            },
          },
        ],
        plugin_collections: [{ id: 'tools', name: 'Tools', defaults: [] }],
      },
    ),
  ],
  [
    'an Agent model alias',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          { id: 'fast', name: 'Fast', defaults: { agent_id: 'agent-1' } },
        ],
      },
    ),
  ],
  [
    'an inline model alias on a built-in $ alias',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          { id: 'fast', name: 'Fast', defaults: { base: '$opus' } },
        ],
      },
    ),
  ],
  [
    'an inline model alias on a model action the host takes none on',
    oneStep(
      { uses: 'builtin/router', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          {
            id: 'fast',
            name: 'Fast',
            defaults: { base: DEFAULT_CLAUDE_MODEL },
          },
        ],
      },
    ),
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

// The runner's host is case-sensitive Linux, where `builtin/Run-Pipeline`
// names no bundled action. On a case-insensitive volume (macOS) the host
// classifier here would find `run-pipeline`, so there it stands in for the
// runner with a name no volume resolves (CAN-6409).
const caseInsensitiveVolume = existsSync(
  resolve(BUNDLED_ACTIONS, 'RUN-PIPELINE'),
);

it('refuses a bundled name in another case for the reason the host does', () => {
  const pipeline = oneStep({ uses: 'builtin/Run-Pipeline' });
  const runnerHost = caseInsensitiveVolume
    ? oneStep({ uses: 'builtin/no-such-bundled-action' })
    : pipeline;
  expect(preflightVerdict(pipeline)).toBe(hostVerdict(runnerHost));
});

// CAN-6316: each pipeline host gap that cloud runs refuse tells the user
// why and what to do instead, as the parity matrix's gap decisions say.
it.each<[string, Pipeline, string, string]>([
  [
    'a child workflow in a folder of the run',
    oneStep({
      uses: 'builtin/run-pipeline',
      with: { pipeline: 'p' },
      target: { scope: 'directory', path: 'sub' },
    }),
    'G2',
    "Remove the step's target",
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
  // A step's own attachments run since CAN-6857 (G6 lifted); a desktop
  // task's files never leave it.
  [
    "a desktop task's files",
    oneStep({
      uses: 'builtin/send-agent-message',
      with: { project_id: 'p', text: 'x', attachment_paths: '/a/b.txt' },
    }),
    'R11',
    'attach files from the run folder with attachments',
  ],
  [
    'a plugin collection on a model action the host takes none on',
    oneStep(
      {
        uses: 'builtin/condenser',
        with: { prompt: 'x', plugin_collection_id: 'c' },
      },
      { plugin_collections: [{ id: 'c', name: 'C', defaults: [] }] },
    ),
    'CP-25',
    'only in agent-prompt and agent-resume steps',
  ],
  [
    'an Agent model alias',
    oneStep(
      { uses: 'builtin/agent-prompt', with: { prompt: 'x', model: 'fast' } },
      {
        model_aliases: [
          { id: 'fast', name: 'Fast', defaults: { agent_id: 'agent-1' } },
        ],
      },
    ),
    'CP-25',
    'names an Agent',
  ],
])(
  'refuses %s with its gap and alternative',
  (_name, pipeline, parityId, says) => {
    const [refusal] = preflightCloudRun(pipeline);
    expect(refusal?.parityId).toBe(parityId);
    expect(refusal?.message).toContain(says);
  },
);

// CAN-6439: the host loads plugins in Claude steps only (CAN-6012), so a
// step that loads a collection on a Codex model is refused there; the model
// preflight lists it for a Claude replacement instead of refusing the run.
it('lists a collection on a Codex model for a Claude model, as the host refuses it', () => {
  const pipeline = oneStep(
    {
      uses: 'builtin/agent-prompt',
      with: { prompt: 'x', model: 'gpt-6.1-terra', plugin_collection_id: 'c' },
    },
    { plugin_collections: [{ id: 'c', name: 'C', defaults: [] }] },
  );
  expect(hostVerdict(pipeline)).toBe('plugin_collections');
  expect(preflightVerdict(pipeline)).toBe('portable');
  const [item] = findCloudModelItems(pipeline, {
    catalog: [
      { modelId: 'openai/gpt-6.1-terra', harness: 'codex', label: 'Terra' },
      {
        modelId: 'anthropic/claude-opus-5.5',
        harness: 'claude',
        label: 'Opus',
      },
    ],
    isBlocked: () => false,
  });
  expect(item).toMatchObject({
    reason: 'action_harness',
    parityId: 'CAN-6012',
  });
  expect(
    item?.alternatives.every((option) => option.harness === 'claude'),
  ).toBe(true);
});

// CAN-6439: the web core checks a builtin:app default against the skills
// the runner stages from brand-templates/skills.
it('names the builtin:app skills every brand ships', () => {
  const templates = readdirSync(
    resolve(__dirname, '../../../../../../brand-templates/skills'),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect([...BUILTIN_APP_SKILL_TEMPLATES].sort()).toEqual(templates);
});

it('takes aliases and step collections on the model actions the host does', () => {
  expect([...CLOUD_RUN_ALIAS_MODEL_ACTIONS].sort()).toEqual(
    [...DAEMON_ALIAS_MODEL_ACTIONS].sort(),
  );
});

// CAN-6174 (plan CP-26): the cloud model preflight runs in the web core,
// which can't read the desktop's model catalog, so it carries the host's
// harnesses per model action, the default step model and the local-only
// model id formats. These fail when the host or the catalog drifts.
describe('cloud model preflight', () => {
  it('offers each model action only the harnesses the host runs it on', () => {
    expect(CLOUD_MODEL_ACTION_HARNESSES).toEqual(
      Object.fromEntries([
        ...DAEMON_PORTABLE_MODEL_ACTIONS,
        ...DAEMON_BROKERED_REPOSITORY_MODEL_ACTIONS,
      ]),
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
    const harnesses: Record<string, string> = {};
    const aliases: Record<string, string> = {};
    for (const [config, harness] of [
      [manifest['claude-code'], 'claude'],
      [manifest.codex, 'codex'],
    ] as const) {
      for (const model of config.models)
        if (model.gatewayId !== undefined) {
          ids[model.id] = model.gatewayId;
          harnesses[model.id] = harness;
        }
      Object.assign(aliases, config.modelAliases);
    }
    expect(CLOUD_NATIVE_MODEL_GATEWAY_IDS).toEqual(ids);
    expect(CLOUD_NATIVE_MODEL_HARNESSES).toEqual(harnesses);
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
    // The cloud runner starts Codex steps (CAN-7235): one runs as written.
    expect(
      findCloudModelItems(
        oneStep({
          uses: 'builtin/agent-prompt',
          with: { model: 'gpt-6-luna' },
        }),
        context,
      ),
    ).toEqual([]);
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

  it("checks a repository action's own model input (CAN-6739)", () => {
    const context = {
      catalog: [
        {
          modelId: 'anthropic/claude-sonnet-5.5',
          label: 'Sonnet',
          harness: 'claude' as const,
        },
        {
          modelId: 'anthropic/claude-haiku-5.5',
          label: 'Haiku',
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
    // Their defaults run as written.
    for (const uses of ['builtin/git-commit-push', 'builtin/github-create-pr'])
      expect(findCloudModelItems(oneStep({ uses }), context)).toEqual([]);
    // A Codex PR model is listed against its own input, with Claude models.
    const pipeline = oneStep({
      uses: 'builtin/github-create-pr',
      with: { pr_model: 'gpt-6-luna' },
    });
    const items = findCloudModelItems(pipeline, context);
    expect(items).toMatchObject([
      { reason: 'action_harness', model: 'gpt-6-luna', harness: 'codex' },
    ]);
    expect(
      items[0]?.alternatives.every((option) => option.harness === 'claude'),
    ).toBe(true);
    const applied = applyCloudModelChoices(pipeline, items, [
      {
        itemKey: items[0]?.itemKey ?? '',
        modelId: 'anthropic/claude-haiku-5.5',
      },
    ]);
    expect(applied.ok && applied.pipeline.jobs.j?.steps[0]?.with).toEqual({
      pr_model: 'anthropic/claude-haiku-5.5',
    });
    // In a worktree, preflight refuses what the host refuses: an expression
    // model, an alias, a plugin collection; the rest runs.
    const inWorktree = (step: Step, extra: Partial<Pipeline> = {}): string[] =>
      preflightCloudRun(oneStep(step, { scope: 'worktree', ...extra }), {
        scope: 'worktree',
      }).map((refusal) => refusal.reason);
    expect(inWorktree({ uses: 'builtin/git-commit-push' })).toEqual([]);
    expect(inWorktree({ uses: 'builtin/github-create-pr' })).toEqual([]);
    expect(
      inWorktree({
        uses: 'builtin/git-commit-push',
        with: { commit_model: '${{ inputs.model }}' },
      }),
    ).toEqual(['dynamic_model']);
    expect(
      inWorktree(
        { uses: 'builtin/git-commit-push', with: { commit_model: 'fast' } },
        {
          model_aliases: [
            { id: 'fast', name: 'Fast', defaults: { base: 'sonnet' } },
          ],
        },
      ),
    ).toEqual(['model_alias']);
    expect(
      inWorktree(
        {
          uses: 'builtin/github-create-pr',
          with: { plugin_collection_id: 'c' },
        },
        { plugin_collections: [{ id: 'c', name: 'C', defaults: [] }] },
      ),
    ).toEqual(['plugin_collections']);
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

// CAN-6747: a cloud run's start carries the model registry snapshot the web
// core builds from the run owner's cloud catalog. It must resolve the run's
// models as desktop's own snapshot (`buildModelRegistrySnapshot`) does for
// the same models: the same harness, source, gateway route and harness
// assignment for each, and desktop's aliases of them.
describe('a cloud run’s model registry (CAN-6747)', () => {
  const KIMI = 'moonshotai/kimi-k3.1-pro';
  const LEVELS = ['low', 'medium', 'high'] as const;
  const manifest = z
    .object({ 'claude-code': z.unknown(), codex: z.unknown() })
    .parse(
      JSON.parse(
        readFileSync(
          resolve(__dirname, '../../../../../../package.json'),
          'utf8',
        ),
      ),
    );
  /** The models the cloud offers: every desktop model it can route, and a gateway-only one. */
  const catalog = [
    ...Object.entries(CLOUD_NATIVE_MODEL_GATEWAY_IDS).map(
      ([modelId, gatewayId]) => ({
        gatewayId,
        harness: CLOUD_NATIVE_MODEL_HARNESSES[modelId] ?? 'claude',
      }),
    ),
    { gatewayId: KIMI, harness: 'claude' as const },
  ];
  const familyOf = (gatewayId: string): string =>
    gatewayId.split('/')[0] ?? 'custom';
  /** The same models in the AI Gateway catalog desktop reads. */
  const hosted: AiGatewayModel[] = catalog.map(({ gatewayId, harness }) => ({
    id: gatewayId,
    gatewayId,
    label: gatewayId,
    family: familyOf(gatewayId),
    familyLabel: familyOf(gatewayId),
    recommendedHarness: harness,
    contextWindow: 200_000,
    supportsPromptCaching: false,
    requiresLocalHarnessSupport: false,
    showMoreOnly: false,
    supportedThinkingLevels: [...LEVELS],
    thinkingLevelsExact: true,
    toolSchemaProfile: 'standard',
  }));

  /** Desktop's snapshot with that catalog, as Electron main builds it. */
  function desktopSnapshot(): ReturnType<typeof buildModelRegistrySnapshot> {
    const merged = mergeAiGatewayModelCatalog({
      packageConfig: parseModelPackageConfig(manifest),
      catalog: { version: AI_GATEWAY_MODEL_CATALOG_VERSION, models: hosted },
    });
    initClaudeModels(merged.claudeModels);
    initCodexModels(merged.codexModels);
    initAiGatewayModels(merged.aiGatewayModels, merged.gatewayRoutes);
    initModelAliases(merged.modelAliases);
    initModelHarnessAssignments(
      buildModelHarnessAssignmentSnapshot({
        catalog: getCurrentModelHarnessCatalog(),
      }),
    );
    return buildModelRegistrySnapshot();
  }

  /** How the host resolves each model once `snapshot` is applied. */
  function resolved(
    snapshot: Parameters<typeof applyModelRegistrySnapshot>[0],
    models: readonly string[],
  ): Record<string, unknown> {
    expect(applyModelRegistrySnapshot(snapshot)).toBe(true);
    return Object.fromEntries(
      models.map((model) => {
        const route = getGatewayModelEntry(model);
        // Through the registry's aliases, as the host resolves a step's model.
        const assignment = getHydratedModelHarnessAssignment(
          model,
          getModelAliases(),
        );
        return [
          model,
          {
            harness: getExecutionHarnessForModel(model),
            source: getModelSource(model),
            route: route && {
              gatewayId: route.gatewayId,
              family: route.family,
              recommendedHarness: route.recommendedHarness,
              gatewayOnly: route.gatewayOnly,
              contextWindow: route.contextWindow,
              supportedThinkingLevels: route.supportedThinkingLevels,
            },
            assignment: assignment && {
              harness: assignment.harness,
              source: assignment.source,
              defaultHarness: assignment.defaultHarness,
              configurable: assignment.configurable,
              overridden: assignment.overridden,
              availableHarnesses: assignment.availableHarnesses,
            },
          },
        ];
      }),
    );
  }

  let before: ReturnType<typeof buildModelRegistrySnapshot>;
  beforeAll(() => {
    before = buildModelRegistrySnapshot();
  });
  afterAll(() => {
    applyModelRegistrySnapshot(before);
  });

  it('resolves each model as desktop’s snapshot does for the same models', () => {
    const cloud = cloudRunModelRegistry(
      {
        catalog: catalog.map(({ gatewayId, harness }) => ({
          modelId: gatewayId,
          label: gatewayId,
          harness,
        })),
        isBlocked: () => false,
      },
      new Map(
        catalog.map(({ gatewayId }) => [
          gatewayId,
          {
            contextWindow: 200_000,
            thinkingLevels: [...LEVELS],
            family: familyOf(gatewayId),
          },
        ]),
      ),
    );
    const desktop = desktopSnapshot();
    // Every model the cloud lists, and desktop's aliases of them.
    const listed = [
      ...Object.keys(CLOUD_NATIVE_MODEL_GATEWAY_IDS),
      KIMI,
      ...Object.keys(CLOUD_NATIVE_MODEL_ALIASES).filter((alias) => {
        const target = CLOUD_NATIVE_MODEL_ALIASES[alias] ?? '';
        return target in CLOUD_NATIVE_MODEL_GATEWAY_IDS;
      }),
    ];
    const expected = resolved(desktop, listed);
    expect(resolved(cloud, listed)).toEqual(expected);
    // A replacement the user confirmed names the catalog id: it runs as the
    // desktop model it is.
    const confirmed = resolved(
      cloud,
      Object.values(CLOUD_NATIVE_MODEL_GATEWAY_IDS),
    );
    for (const [model, gatewayId] of Object.entries(
      CLOUD_NATIVE_MODEL_GATEWAY_IDS,
    ))
      expect(confirmed[gatewayId]).toEqual(expected[model]);
  });

  it('stays within the launch limit, keeping first the models the run names', () => {
    const padded = (index: number): string =>
      `vendor/model-${String(index).padStart(4, '0')}-${'x'.repeat(480)}`;
    const named = padded(2_999);
    const cloud = cloudRunModelRegistry(
      {
        catalog: [
          ...Array.from({ length: 3_000 }, (_, index) => ({
            modelId: padded(index),
            label: 'Model',
            harness: 'claude' as const,
          })),
          {
            modelId: 'anthropic/claude-sonnet-5.5',
            label: 'S',
            harness: 'claude',
          },
        ],
        isBlocked: () => false,
      },
      new Map(),
      {
        jobs: {
          j: {
            steps: [{ uses: 'builtin/agent-prompt', with: { model: named } }],
          },
        },
      },
    );
    const sizes = Object.values(cloud).map((value) =>
      Buffer.byteLength(value ?? '', 'utf8'),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(
      WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES,
    );
    // Each value fits one environment entry of an action subprocess.
    for (const size of sizes)
      expect(size).toBeLessThanOrEqual(
        CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES,
      );
    expect(Math.max(...sizes)).toBeGreaterThan(
      CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES / 2,
    );
    const models = resolved(cloud, [named, padded(2_998), 'opus[1m]']);
    // The host exports the registry it applied to every action subprocess:
    // each of those values fits one environment entry too.
    for (const value of Object.values(buildModelRegistrySnapshot()))
      expect(Buffer.byteLength(value ?? '', 'utf8')).toBeLessThanOrEqual(
        CLOUD_RUN_MODEL_REGISTRY_VALUE_MAX_BYTES,
      );
    // What the run names, then the catalog in order while it fits.
    expect(models[named]).toMatchObject({ harness: 'claude' });
    expect(models[padded(2_998)]).toMatchObject({ harness: undefined });
  });

  it('runs a desktop model Core binds to another harness as its catalog model', () => {
    // Core binds Sonnet's catalog id to Codex: preflight and routes map
    // `sonnet` and its aliases there, and so must the host.
    const cloud = cloudRunModelRegistry({
      catalog: [
        {
          modelId: 'anthropic/claude-sonnet-5.5',
          label: 'S',
          harness: 'codex',
        },
      ],
      isBlocked: () => false,
    });
    const models = resolved(cloud, [
      'sonnet',
      'sonnet[1m]',
      'claude-sonnet-5-5',
      'anthropic/claude-sonnet-5.5',
    ]);
    for (const model of Object.values(models))
      expect(model).toMatchObject({
        harness: 'codex',
        source: 'ai-gateway',
        route: {
          gatewayId: 'anthropic/claude-sonnet-5.5',
          recommendedHarness: 'codex',
          gatewayOnly: true,
        },
      });
  });

  it('leaves out what the owner’s policy blocks', () => {
    const cloud = cloudRunModelRegistry({
      catalog: [
        {
          modelId: 'anthropic/claude-sonnet-5.5',
          label: 'S',
          harness: 'claude',
        },
        { modelId: 'anthropic/claude-opus-5.5', label: 'O', harness: 'claude' },
      ],
      isBlocked: (modelId) => modelId === 'anthropic/claude-opus-5.5',
    });
    const models = resolved(cloud, ['sonnet', 'opus[1m]', 'opus']);
    expect(models.sonnet).toMatchObject({ harness: 'claude' });
    expect(models['opus[1m]']).toMatchObject({ harness: undefined });
    expect(models.opus).toMatchObject({ harness: undefined });
  });
});

// CAN-7018: a step whose model is `${{ matrix.<axis> }}` runs the models its
// job's matrix gives the axis. Preflight checks each value a written-out
// matrix gives it as a fixed model, and has the person pick the model of a
// matrix built while the run runs; the host admits the reference, and the
// owner admits each model when its step asks for a route.
describe('matrix models (CAN-7018)', () => {
  const CATALOG = {
    catalog: [
      {
        modelId: 'anthropic/claude-haiku-5.5',
        harness: 'claude' as const,
        label: 'Haiku',
      },
      {
        modelId: 'openai/gpt-6.1-terra',
        harness: 'codex' as const,
        label: 'Terra',
      },
    ],
    isBlocked: (): boolean => false,
  };
  const matrixJob = (
    matrix: NonNullable<Pipeline['jobs'][string]['strategy']>['matrix'],
    steps: Step[],
  ): Pipeline => ({
    name: 't',
    scope: 'global',
    on: 'dispatch',
    jobs: { tracks: { strategy: { matrix }, steps } },
  });
  const review = (model = '${{ matrix.model }}'): Step => ({
    uses: 'builtin/agent-prompt',
    with: { prompt: 'x', model },
  });

  it.each<[string, Pipeline]>([
    [
      'a written-out matrix',
      matrixJob({ model: ['haiku', '$sol'] }, [review()]),
    ],
    [
      'a matrix built while the run runs',
      matrixJob('${{ parseJson(inputs.tracks) }}', [review()]),
    ],
    [
      'a composite step, whose model step reads it as its input',
      matrixJob({ model: ['haiku'] }, [
        { uses: 'builtin/coder', with: { model: '${{ matrix.model }}' } },
      ]),
    ],
  ])(
    'admits a matrix axis model in %s, as the host does',
    (_name, pipeline) => {
      expect(preflightVerdict(pipeline)).toBe('portable');
      expect(hostVerdict(pipeline)).toBe('portable');
    },
  );

  it('refuses an expression model outside a matrix job, and a matrix value written as one', () => {
    expect(preflightVerdict(oneStep(review()))).toBe('dynamic_model');
    expect(preflightVerdict(oneStep(review('${{ matrix.model }} ')))).toBe(
      'dynamic_model',
    );
    expect(
      preflightVerdict(
        matrixJob({ model: ['${{ inputs.model }}'] }, [review()]),
      ),
    ).toBe('dynamic_model');
    expect(
      preflightVerdict(
        matrixJob({ model: ['haiku'] }, [review('${{ matrix.model || 1 }}')]),
      ),
    ).toBe('dynamic_model');
  });

  it('lists each written-out value the cloud cannot run and replaces it in the matrix', () => {
    const pipeline = matrixJob(
      {
        model: ['haiku', '$sol', 'cursor:auto'],
        include: [{ model: '$sol', effort: 'high' }],
        exclude: [{ model: 'cursor:auto' }],
      },
      [review(), review()],
    );
    const items = findCloudModelItems(pipeline, CATALOG);
    expect(
      items.map(({ itemKey, reason, model, matrix }) => ({
        itemKey,
        reason,
        model,
        matrix,
      })),
    ).toEqual([
      {
        itemKey: 'tracks#matrix.model[1]',
        reason: 'subscription_model',
        model: '$sol',
        matrix: { axis: 'model', value: '$sol' },
      },
    ]);
    const outcome = applyCloudModelChoices(pipeline, items, [
      { itemKey: 'tracks#matrix.model[1]', modelId: 'openai/gpt-6.1-terra' },
    ]);
    // Written out as the variants it runs, each with its own settings.
    expect(outcome.ok && outcome.pipeline.jobs.tracks?.strategy).toEqual({
      matrix: {
        include: [
          { model: 'haiku' },
          { model: 'openai/gpt-6.1-terra', effort: 'high' },
        ],
      },
    });
    // The excluded value runs nowhere, so it needs no replacement.
    expect(
      outcome.ok && findCloudModelItems(outcome.pipeline, CATALOG),
    ).toEqual([]);
  });

  it('keeps an inline alias a matrix value names, with the confirmed base model', () => {
    const pipeline: Pipeline = {
      ...matrixJob({ model: ['reviewer'] }, [review()]),
      model_aliases: [
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { base: '$sol', instructions: 'Be strict.' },
        },
      ],
    };
    const items = findCloudModelItems(pipeline, CATALOG);
    expect(items.map((item) => item.itemKey)).toEqual([
      'tracks#matrix.model[0]',
    ]);
    const outcome = applyCloudModelChoices(pipeline, items, [
      {
        itemKey: 'tracks#matrix.model[0]',
        modelId: 'anthropic/claude-haiku-5.5',
      },
    ]);
    if (!outcome.ok) throw new Error('not applied');
    expect(outcome.pipeline.jobs.tracks?.strategy?.matrix).toEqual({
      include: [{ model: 'reviewer-cloud-1' }],
    });
    expect(outcome.pipeline.model_aliases).toContainEqual({
      id: 'reviewer-cloud-1',
      name: 'Reviewer',
      defaults: {
        base: 'anthropic/claude-haiku-5.5',
        instructions: 'Be strict.',
      },
    });
  });

  it('keeps every variant and its settings, whatever model replaces a value', () => {
    // One model for two values, a model another variant already runs, and
    // one an exclude entry names: each variant keeps its place.
    const pipeline = matrixJob(
      {
        model: ['anthropic/claude-haiku-5.5', '$sol', 'cursor:auto'],
        os: ['a', 'b'],
        include: [{ model: '$sol', effort: 'high' }],
        exclude: [
          { model: '$sol', os: 'a' },
          { model: 'openai/gpt-6.1-terra' },
        ],
      },
      [review()],
    );
    const items = findCloudModelItems(pipeline, CATALOG);
    expect(items.map((item) => item.itemKey)).toEqual([
      'tracks#matrix.model[1]',
      'tracks#matrix.model[2]',
    ]);
    const variants = (modelId: string): unknown => {
      const outcome = applyCloudModelChoices(
        pipeline,
        items,
        items.map((item) => ({ itemKey: item.itemKey, modelId })),
      );
      return outcome.ok && outcome.pipeline.jobs.tracks?.strategy?.matrix;
    };
    expect(variants('anthropic/claude-haiku-5.5')).toEqual({
      include: [
        { model: 'anthropic/claude-haiku-5.5', os: 'a' },
        { model: 'anthropic/claude-haiku-5.5', os: 'b' },
        { model: 'anthropic/claude-haiku-5.5', os: 'b', effort: 'high' },
        { model: 'anthropic/claude-haiku-5.5', os: 'a' },
        { model: 'anthropic/claude-haiku-5.5', os: 'b' },
      ],
    });
    expect(variants('openai/gpt-6.1-terra')).toMatchObject({
      include: [
        { model: 'anthropic/claude-haiku-5.5', os: 'a' },
        { model: 'anthropic/claude-haiku-5.5', os: 'b' },
        { model: 'openai/gpt-6.1-terra', os: 'b', effort: 'high' },
        { model: 'openai/gpt-6.1-terra', os: 'a' },
        { model: 'openai/gpt-6.1-terra', os: 'b' },
      ],
    });
  });

  it('offers no Codex model to a step whose preset is an expression, which may be none', () => {
    const pipeline = matrixJob({ model: ['$sol'], preset: ['none'] }, [
      {
        uses: 'builtin/agent-prompt',
        with: {
          prompt: 'x',
          model: '${{ matrix.model }}',
          permission_preset: '${{ matrix.preset }}',
        },
      },
    ]);
    const [item] = findCloudModelItems(pipeline, CATALOG);
    expect(item?.alternatives.map((option) => option.modelId)).toEqual([
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it('keeps a model every step runs, however far down the catalog it is', () => {
    const codex = Array.from({ length: 60 }, (_, index) => ({
      modelId: `openai/codex-${String(index)}`,
      harness: 'codex' as const,
      label: `Codex ${String(index)}`,
    }));
    const pipeline = matrixJob({ model: ['$sol'] }, [
      review(),
      {
        uses: 'builtin/agent-loop',
        with: { prompt: 'x', model: '${{ matrix.model }}' },
      },
    ]);
    const [item] = findCloudModelItems(pipeline, {
      catalog: [...codex, ...CATALOG.catalog],
      isBlocked: (): boolean => false,
    });
    expect(item?.alternatives.map((option) => option.modelId)).toEqual([
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it('offers a matrix value only models every step that names the axis runs', () => {
    const pipeline = matrixJob({ model: ['$sol'] }, [
      review(),
      {
        uses: 'builtin/agent-loop',
        with: { prompt: 'x', model: '${{ matrix.model }}' },
      },
    ]);
    const [item] = findCloudModelItems(pipeline, CATALOG);
    expect(item?.alternatives.map((option) => option.modelId)).toEqual([
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it("lists a matrix built while the run runs once, and fixes its steps' model", () => {
    const pipeline = matrixJob(
      '${{ parseJson(needs.discover.outputs.matrix) }}',
      [{ run: 'echo ${{ matrix.model }}' }, review(), review()],
    );
    const items = findCloudModelItems(pipeline, CATALOG);
    expect(items).toEqual([
      expect.objectContaining({
        itemKey: 'tracks#matrix.model',
        reason: 'run_time_model',
        parityId: 'G4',
        stepIndex: 1,
        matrix: { axis: 'model' },
        alternatives: CATALOG.catalog,
      }),
    ]);
    expect(applyCloudModelChoices(pipeline, items, []).ok).toBe(false);
    const outcome = applyCloudModelChoices(pipeline, items, [
      { itemKey: 'tracks#matrix.model', modelId: 'anthropic/claude-haiku-5.5' },
    ]);
    if (!outcome.ok) throw new Error('not applied');
    expect(
      outcome.pipeline.jobs.tracks?.steps.map((step) => step.with?.model),
    ).toEqual([
      undefined,
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-haiku-5.5',
    ]);
    expect(outcome.pipeline.jobs.tracks?.strategy).toEqual(
      pipeline.jobs.tracks?.strategy,
    );
  });

  it('starts the stock multi-provider review once its matrix model is chosen', () => {
    const pipeline = parsePipelineText(
      readFileSync(
        resolve(
          __dirname,
          '../../../../resources/pipelines/code-review-multi-provider.yaml',
        ),
        'utf8',
      ),
    );
    // The bundled text keeps its brand tokens until the brand renders them.
    const refused = preflightCloudRun(pipeline, { scope: 'worktree' }).filter(
      (refusal) => !refusal.uses?.includes('{{BRAND_'),
    );
    expect(refused).toEqual([]);
    const items = findCloudModelItems(pipeline, CATALOG);
    expect(items).toContainEqual(
      expect.objectContaining({
        itemKey: 'custom_review_tracks#matrix.model',
        reason: 'run_time_model',
      }),
    );
    const outcome = applyCloudModelChoices(
      pipeline,
      items,
      items.map((item) => ({
        itemKey: item.itemKey,
        modelId: item.alternatives[0]?.modelId ?? '',
      })),
    );
    expect(
      outcome.ok && findCloudModelItems(outcome.pipeline, CATALOG),
    ).toEqual([]);
  });
});

// CAN-7044: the web core lists a bundled child workflow's model steps before
// a cloud run starts, from what preflight reads of each bundled workflow;
// the runner stages the files themselves. This fails when the two drift:
// run `pnpm run cloud:bundled-workflows:generate` after changing one.
describe('bundled child workflows (CAN-7044)', () => {
  const CATALOG_FOR_CHILDREN = {
    catalog: [
      {
        modelId: 'anthropic/claude-haiku-5.5',
        harness: 'claude' as const,
        label: 'Haiku',
      },
    ],
    isBlocked: (): boolean => false,
  };
  const PIPELINES = resolve(__dirname, '../../../../resources/pipelines');
  const index = z
    .object({
      pipelines: z.array(z.object({ id: z.string(), filename: z.string() })),
    })
    .parse(JSON.parse(readFileSync(resolve(PIPELINES, 'index.json'), 'utf8')));

  it('reads each bundled workflow as its file says', () => {
    expect(BUNDLED_CLOUD_WORKFLOWS).toEqual(
      index.pipelines.map(({ id, filename }) => ({
        id,
        filename,
        pipeline: cloudModelWorkflowProjection(
          parsePipelineText(readFileSync(resolve(PIPELINES, filename), 'utf8')),
        ),
      })),
    );
  });

  it('lists a child’s items as its full file would, under the step that starts it', () => {
    const catalog = {
      catalog: [
        {
          modelId: 'anthropic/claude-haiku-5.5',
          harness: 'claude' as const,
          label: 'Haiku',
        },
      ],
      isBlocked: (): boolean => false,
    };
    const autopilot = parsePipelineText(
      readFileSync(resolve(PIPELINES, 'implementation-autopilot.yaml'), 'utf8'),
    );
    const review = parsePipelineText(
      readFileSync(
        resolve(PIPELINES, 'code-review-multi-provider.yaml'),
        'utf8',
      ),
    );
    const items = findCloudRunModelItems(
      autopilot,
      catalog,
      cloudChildWorkflowResolver(BUNDLED_CLOUD_WORKFLOWS),
    );
    const steps = runPipelineStepIndexes(autopilot);
    expect(steps).toHaveLength(1);
    const [jobId = '', , stepIndex = -1] = steps[0] ?? [];
    const prefix = `${jobId}#${String(stepIndex)}/`;
    const children = items.filter((item) => item.itemKey.startsWith(prefix));
    expect(
      children.map((item) => ({
        ...item,
        itemKey: item.itemKey.slice(prefix.length),
        workflows: undefined,
      })),
    ).toEqual(
      findCloudModelItems(review, catalog).map((item) => ({
        ...item,
        workflows: undefined,
      })),
    );
    expect(children[0]?.workflows).toEqual([review.name]);
    // Each child's choices reach it alone, by the step that starts it.
    const choices = items.map((item) => ({
      itemKey: item.itemKey,
      modelId: 'anthropic/claude-haiku-5.5',
    }));
    const run = applyCloudRunModelChoices(autopilot, items, choices);
    expect(run.ok).toBe(true);
    const own = childCloudModelChoices(choices, jobId, stepIndex);
    expect(own).toHaveLength(children.length);
    const child = applyChildCloudModelChoices(review, catalog, own);
    expect(child.ok && findCloudModelItems(child.pipeline, catalog)).toEqual(
      [],
    );
    expect(applyChildCloudModelChoices(review, catalog, []).ok).toBe(false);
  });

  it('reads an inline child whose fields hold expressions, but not one that is an expression', () => {
    const resolve = cloudChildWorkflowResolver(BUNDLED_CLOUD_WORKFLOWS);
    const inline = (pipeline_yaml: string): Step => ({
      uses: 'builtin/run-pipeline',
      with: { pipeline_yaml },
    });
    const child = resolve(
      inline(
        [
          'name: Fixer',
          'on: workflow',
          'jobs:',
          '  fix:',
          '    steps:',
          '      - uses: builtin/agent-prompt',
          "        with: { model: '$sol', prompt: 'Fix ${{ inputs.issue }}' }",
        ].join('\n'),
      ),
    );
    expect(child?.name).toBe('Fixer');
    expect(
      child &&
        findCloudModelItems(child.pipeline, CATALOG_FOR_CHILDREN).map(
          (item) => item.itemKey,
        ),
    ).toEqual(['fix#0']);
    expect(resolve(inline('${{ steps.plan.outputs.yaml }}'))).toBeNull();
  });

  it('stops reading children once a start check would read too many', () => {
    // Ten steps that each start a child of ten such steps, four deep: ten
    // thousand reads without a budget.
    const fanOut: Pipeline = {
      name: 'Fan out',
      on: 'dispatch',
      jobs: {
        j: {
          steps: Array.from({ length: 10 }, () => ({
            uses: 'builtin/run-pipeline',
            with: { pipeline_yaml: 'x' },
          })),
        },
      },
    };
    let reads = 0;
    expect(() =>
      findCloudRunModelItems(
        fanOut,
        { catalog: [], isBlocked: (): boolean => false },
        () => {
          reads += 1;
          // A fresh copy each time, as a parsed inline child is.
          return { name: 'Fan out', pipeline: structuredClone(fanOut) };
        },
      ),
    ).toThrow(CloudChildWorkflowsTooLarge);
    expect(reads).toBe(CLOUD_CHILD_WORKFLOWS_READ_MAX);
  });

  it('names a bundled workflow by its file, with or without its extension', () => {
    for (const reference of [
      'code-review-multi-provider.yaml',
      'code-review-multi-provider',
      ' code-review-multi-provider ',
    ])
      expect(
        bundledChildWorkflow(BUNDLED_CLOUD_WORKFLOWS, reference)?.filename,
      ).toBe('code-review-multi-provider.yaml');
    for (const reference of ['bundled-code-review-multi-provider', 'x.yaml'])
      expect(bundledChildWorkflow(BUNDLED_CLOUD_WORKFLOWS, reference)).toBe(
        null,
      );
  });
});
