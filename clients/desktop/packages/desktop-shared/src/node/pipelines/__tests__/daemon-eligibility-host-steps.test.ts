// CAN-5771: under `hostSteps: 'owner'` the classifier admits the bundled
// host actions, which the daemon's owner settles; everything else it
// refused still stays in process. Runs over the real bundled action manifests.
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

const OWNER = { hostSteps: 'owner' } as const;

const HOST_ACTIONS = [
  'move-to-group',
  'create-worktree',
  'create-project-entry',
  'create-bot-entry',
  'send-agent-message',
  'wait-for-agent-reply',
];

describe('classifyDaemonPipeline host steps (CAN-5771)', () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-host-steps-')));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('host steps are refused by default and admitted under owner', () => {
    for (const name of HOST_ACTIONS) {
      const pipeline = oneStep({ uses: `builtin/${name}` });
      expect(classifyDaemonPipeline(pipeline, context)).toMatchObject({
        eligible: false,
        reason: 'host_step',
      });
      expect(classifyDaemonPipeline(pipeline, context, OWNER)).toEqual({
        eligible: true,
        modelSteps: 0,
        modelHarnesses: [],
        hostSteps: 1,
      });
    }
    const dir = join(getProjectActionsDir(repo), 'wrap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'action.yml'),
      'name: wrap\nruns:\n  using: composite\n  steps:\n    - run: echo a\n    - uses: builtin/create-worktree\n',
    );
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'project/wrap' }),
        { ...context, repoPath: repo },
        OWNER,
      ),
    ).toMatchObject({ eligible: true, hostSteps: 1 });
  });

  it('a send-agent-message step with host-path inputs stays in process', () => {
    for (const input of [
      'attachments',
      'attachment_paths',
      'attachment_prompt_contexts',
      'file_references',
    ]) {
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: 'builtin/send-agent-message',
            with: { [input]: '[]' },
          }),
          context,
          OWNER,
        ),
      ).toMatchObject({ eligible: false, reason: 'host_paths' });
    }
  });

  it('a send-agent-message step with a named model or a plugin collection stays in process', () => {
    // The executor checks a named model against the org model policy and
    // resolves a plugin collection before the host step; only the app can.
    const extras: Record<string, string>[] = [
      { model: 'sonnet' },
      { plugin_collection_id: 'security' },
    ];
    for (const extra of extras)
      expect(
        classifyDaemonPipeline(
          oneStep({
            uses: 'builtin/send-agent-message',
            with: {
              project_id: 'p',
              task_id: 't',
              chat_id: 'c',
              text: 'Hi',
              ...extra,
            },
          }),
          context,
          OWNER,
        ),
      ).toMatchObject({ eligible: false, reason: 'host_inputs' });
  });

  it('child pipelines, tsx and model steps are still refused under owner', () => {
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'builtin/run-pipeline' }),
        context,
        OWNER,
      ),
    ).toMatchObject({ eligible: false, reason: 'child_pipeline' });
    expect(
      classifyDaemonPipeline(
        oneStep({ run: 'console.log(1)', shell: 'tsx' }),
        context,
        OWNER,
      ),
    ).toMatchObject({ eligible: false, reason: 'tsx_runtime' });
    expect(
      classifyDaemonPipeline(
        oneStep({ uses: 'builtin/agent-prompt' }),
        context,
        OWNER,
      ),
    ).toMatchObject({ eligible: false, reason: 'model_step' });
  });
});
