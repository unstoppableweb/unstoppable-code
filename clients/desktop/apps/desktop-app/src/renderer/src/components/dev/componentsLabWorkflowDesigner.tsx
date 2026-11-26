import type { JSX } from 'react';
import { Heading } from '@canopy/ui-shared/components';
import {
  WorkflowDesigner,
  WorkflowTriggerPanel,
  type WorkflowDesignerEditing,
  type WorkflowDesignerTriggerCard,
  type WorkflowDesignerNode,
  type WorkflowDesignerSelection,
  type WorkflowDesignerGroupJob,
} from '@canopy/ui-app/workflows';

const noop = (): void => undefined;

const EDITING: WorkflowDesignerEditing = {
  onInsertStep: noop,
  onRemoveStep: noop,
  onMoveStep: noop,
  onAddFirstStep: noop,
  onAddPath: noop,
  onRemovePath: noop,
  onRemoveSplit: noop,
};

const step = (
  jobId: string,
  stepIndex: number,
  fields: Omit<
    Extract<WorkflowDesignerNode, { kind: 'step' }>,
    'kind' | 'key' | 'jobId' | 'stepIndex' | 'script'
  > & { readonly script?: boolean },
): WorkflowDesignerNode => ({
  kind: 'step',
  key: `step:${jobId}:${String(stepIndex)}`,
  jobId,
  stepIndex,
  ...fields,
  script: fields.script ?? false,
});

/** A typical workflow: a chain, a parallel group, then a router. */
const TYPICAL: readonly WorkflowDesignerNode[] = [
  step('gather', 0, {
    name: 'Read the changes',
    uses: 'builtin/git-workspace-details',
  }),
  {
    kind: 'parallel',
    key: 'parallel:checks,review',
    columns: [
      {
        key: 'column:checks',
        label: 'Checks',
        jobIds: ['checks'],
        nodes: [
          step('checks', 0, {
            name: 'Run the tests',
            script: true,
            jobCondition: 'inputs.run_tests == true',
          }),
        ],
      },
      {
        key: 'column:review',
        label: 'Review',
        jobIds: ['review'],
        nodes: [
          step('review', 0, {
            name: 'Review the diff',
            uses: 'builtin/agent-prompt',
          }),
        ],
      },
    ],
  },
  step('decide', 0, {
    name: 'Ready to ship?',
    uses: 'builtin/router',
    split: true,
  }),
  {
    kind: 'paths',
    key: 'paths:decide',
    jobId: 'decide',
    routerStepIndex: 0,
    missingInput: false,
    paths: [
      {
        key: 'path:ship',
        label: 'Ship',
        jobId: 'ship',
        nodes: [
          step('ship', 0, { name: 'Merge the change', script: true }),
          step('ship', 1, { name: 'Tell the team', uses: 'builtin/notify' }),
        ],
      },
      {
        key: 'path:fix',
        label: 'Fix',
        jobId: 'fix',
        nodes: [
          step('fix', 0, {
            name: 'Address the review',
            uses: 'builtin/agent-prompt',
          }),
        ],
      },
    ],
  },
];

/** A new split: empty paths, and a router with nothing to decide on yet. */
const NEW_SPLIT: readonly WorkflowDesignerNode[] = [
  step('triage', 0, { name: 'Read the request', script: true }),
  step('triage', 1, {
    name: 'Split into paths',
    uses: 'builtin/router',
    split: true,
  }),
  {
    kind: 'paths',
    key: 'paths:triage',
    jobId: 'triage',
    routerStepIndex: 1,
    missingInput: true,
    paths: ['Path 1', 'Path 2', 'Path 3', 'Path 4'].map((label, index) => ({
      key: `path:p${String(index)}`,
      label,
      jobId: `p${String(index)}`,
      nodes: [
        {
          kind: 'empty-job',
          key: `job:p${String(index)}`,
          jobId: `p${String(index)}`,
          name: label,
        },
      ],
    })),
  },
];

/** Edge states: long text, unknown actions, an empty job, a wide group. */
const EDGES: readonly WorkflowDesignerNode[] = [
  step('long', 0, {
    name: 'Summarize every open pull request in the repository and post a digest to the team channel each morning',
    uses: 'builtin/agent-prompt',
    condition: "always() && inputs.mode != 'quiet'",
  }),
  step('custom', 0, { uses: 'acme/deploy-preview' }),
  step('unnamed', 0, { uses: 'builtin/notify' }),
  {
    kind: 'empty-job',
    key: 'job:later',
    jobId: 'later',
    name: 'Follow up',
  },
  {
    kind: 'parallel',
    key: 'parallel:reviewers',
    columns: ['Security', 'Style', 'Tests', 'Docs', 'Performance'].map(
      (label) => ({
        key: `column:${label}`,
        label,
        jobIds: [label.toLowerCase()],
        nodes: [
          step(label.toLowerCase(), 0, {
            name: `${label} review`,
            uses: 'builtin/agent-prompt',
          }),
        ],
      }),
    ),
  },
];

/** A read-only group's job with one step per name. */
function groupJob(
  jobId: string,
  name: string,
  after: readonly string[],
  steps: readonly string[],
  extra: Partial<WorkflowDesignerGroupJob> = {},
): WorkflowDesignerGroupJob {
  return {
    jobId,
    editable: !extra.unreadableSteps,
    name,
    after,
    nodes: steps.map((step, stepIndex) => ({
      kind: 'step',
      key: `step:${jobId}:${String(stepIndex)}`,
      jobId,
      stepIndex,
      name: step,
      script: true,
    })),
    ...extra,
  };
}

const UNSUPPORTED: readonly WorkflowDesignerNode[] = [
  {
    kind: 'unsupported',
    key: 'unsupported:matrix',
    jobIds: ['matrix'],
    jobNames: ['Test every platform'],
    reason: 'matrix',
    layers: [
      [
        groupJob('matrix', 'Test every platform', [], ['Run the tests'], {
          matrix: true,
        }),
      ],
    ],
  },
  {
    kind: 'unsupported',
    key: 'unsupported:condition',
    jobIds: ['gated'],
    jobNames: ['Plan from a new task'],
    reason: 'condition',
    layers: [
      [
        groupJob('gated', 'Plan from a new task', [], ['Write the plan'], {
          condition: "inputs.mode == 'plan' || inputs.force",
        }),
      ],
    ],
  },
  {
    kind: 'unsupported',
    key: 'unsupported:graph',
    jobIds: ['a', 'b', 'c', 'd'],
    jobNames: ['Repo compliance', 'Security review', 'Synthesize', 'Publish'],
    reason: 'graph',
    layers: [
      [
        groupJob('a', 'Repo compliance', ['Gather details'], ['Review']),
        groupJob('b', 'Security review', ['Gather details'], ['Review']),
      ],
      [
        groupJob(
          'c',
          'Synthesize',
          ['Repo compliance', 'Security review', 'Gather details'],
          ['Prepare', 'Aggregate'],
        ),
      ],
      [groupJob('d', 'Publish', ['Synthesize', 'Gather details'], ['Post'])],
    ],
  },
  {
    kind: 'unsupported',
    key: 'unsupported:invalid',
    jobIds: ['x', 'y'],
    jobNames: ['Build', 'Package'],
    reason: 'invalid',
    layers: [
      [groupJob('x', 'Build', ['Package'], ['Compile'])],
      [
        groupJob('y', 'Package', ['Build'], [], {
          unreadableSteps: true,
        }),
      ],
    ],
  },
  {
    kind: 'unsupported',
    key: 'unsupported:size',
    jobIds: ['huge'],
    jobNames: ['Release train'],
    reason: 'size',
    layers: [],
  },
];

const TRIGGER: WorkflowDesignerTriggerCard = {
  title: 'Run · New task',
  detail: '2 schedules',
  selected: false,
  onSelect: noop,
  onDismiss: noop,
  stepEntries: new Map([['step:review:0', 'new-task']]),
};

function Specimen({
  title,
  nodes,
  selection = { type: 'none' },
  editable = false,
  notice,
  trigger,
}: {
  readonly title: string;
  readonly nodes: readonly WorkflowDesignerNode[];
  readonly selection?: WorkflowDesignerSelection;
  readonly editable?: boolean;
  readonly notice?: string;
  readonly trigger?: WorkflowDesignerTriggerCard;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <Heading level={3} variant="label">
        {title}
      </Heading>
      <WorkflowDesigner
        stack={{ nodes }}
        selection={selection}
        onSelectStep={noop}
        onSelectJob={noop}
        onClearSelection={noop}
        onEditInYaml={noop}
        {...(editable ? { editing: EDITING } : {})}
        {...(notice !== undefined
          ? { notice: { message: notice, onDismiss: noop } }
          : {})}
        {...(trigger ? { trigger } : {})}
      />
    </section>
  );
}

/** The workflow designer's stack in each state (CAN-4224). */
export function WorkflowDesignerSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <Specimen title="Typical workflow" nodes={TYPICAL} />
      <Specimen
        title="Selected card"
        nodes={TYPICAL}
        selection={{ type: 'step', jobId: 'review', stepIndex: 0 }}
      />
      <Specimen
        title="Long text, unknown action, empty job, wide group"
        nodes={EDGES}
      />
      <Specimen title="Shapes shown read-only" nodes={UNSUPPORTED} />
      <Specimen title="Empty workflow" nodes={[]} />
      <Specimen
        title="Editable: add, move and remove"
        nodes={TYPICAL}
        editable
      />
      <Specimen
        title="Editable: a refused edit"
        nodes={TYPICAL}
        editable
        notice="Can’t remove this step: “Review the diff” reads it. Edit it in YAML instead."
      />
      <Specimen title="Editable: empty workflow" nodes={[]} editable />
      <Specimen
        title="Editable: a new split with four paths"
        nodes={NEW_SPLIT}
        editable
      />
      <Specimen
        title="Trigger card, and a step only a new task runs"
        nodes={TYPICAL}
        trigger={TRIGGER}
      />
      <Specimen
        title="Trigger card of a new workflow"
        nodes={[]}
        editable
        trigger={{
          ...TRIGGER,
          title: 'Choose a trigger',
          detail: undefined,
          stepEntries: new Map(),
        }}
      />
      <section className="flex max-w-sm flex-col gap-2">
        <Heading level={3} variant="label">
          Trigger panel
        </Heading>
        <WorkflowTriggerPanel
          entries={['run', 'new-task']}
          onToggleEntry={noop}
          entryError="“Draft Task-Ready Plan” runs only from New task, so New task stays on. Edit it in YAML instead."
          fromWorkflow
          schedules={[
            { key: 'a', summary: 'Weekdays at 9:00 AM', enabled: true },
            {
              key: 'b',
              summary: 'Every Monday at 8:00 AM',
              name: 'Weekly digest',
              enabled: false,
            },
          ]}
          onEditSchedule={noop}
          onAddSchedule={noop}
          scheduleNotice="Your schedule opens after you save the workflow."
        />
      </section>
    </div>
  );
}
