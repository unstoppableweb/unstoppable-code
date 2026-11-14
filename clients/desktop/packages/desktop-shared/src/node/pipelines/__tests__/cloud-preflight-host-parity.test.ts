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
  applyCloudModelChoices,
  findCloudModelItems,
} from '@canopy/pipeline-interop/cloud-model-preflight';
import { readFileSync } from 'node:fs';
import { BUILTIN_APP_SKILL_TEMPLATES } from '@canopy/pipeline-interop/builtin-skills';
import { z } from 'zod';
import { isPipelineHostActionId } from '@canopy/execution-engine/pipelines/host-actions';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
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
    'a child workflow',
    oneStep({ uses: 'builtin/run-pipeline', with: { pipeline: 'p' } }),
    'G2',
    'Copy its jobs into this workflow',
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
