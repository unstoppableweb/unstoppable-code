import { useState, type JSX } from 'react';
import {
  SubagentBanner,
  type SubagentNode,
  SubagentRecipientTrigger,
  SubagentRunDivider,
  SubagentSetupDetails,
  SubagentTaskBubble,
  Surface,
} from '@canopy/ui-shared/components';
import {
  CHAT_TREE,
  EXPLORE,
  IMPLEMENT,
  LONG_TITLE_CHILD,
  LONG_TITLE_PARENT,
  LONG_TREE,
  PLAN,
  REVIEW,
  node,
} from './componentsLabChatSubagentsData';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const WRITE_PATHS = Array.from(
  { length: 9 },
  (_, index) => `packages/billing/src/handlers/handler-${index}.ts`,
);
const LONG_ERROR = `The handler failed to apply: ${'the ledger rejected the update and rolled the change back. '.repeat(6).trim()}`;

function snapshot(
  overrides: Partial<NonNullable<SubagentNode['snapshot']>>,
): NonNullable<SubagentNode['snapshot']> {
  return {
    delegationId: 'specimen',
    status: 'completed',
    outputTruncated: false,
    ...overrides,
  };
}

const SETUP_SPECIMENS: readonly {
  readonly label: string;
  readonly node: SubagentNode;
  readonly executionMode?: 'foreground' | 'background';
  readonly showUsage?: boolean;
}[] = [
  {
    label: 'Managed, isolated, background, with usage',
    node: node('s1', 'Port the handlers', 'plan', ['a', 'b'], {
      modelLabel: 'Large model',
      harnessId: 'claude',
      thinkingLevel: 'high',
      workspace: 'isolated',
      runs: [{ runGeneration: 1 }, { runGeneration: 2 }],
      snapshot: snapshot({
        permissions: { writePaths: ['src/billing/ledger.ts'] },
        usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 },
      }),
    }),
    executionMode: 'background',
  },
  {
    label: 'Same, with usage hidden',
    node: node('s2', 'Port the handlers', 'plan', [], {
      modelLabel: 'Large model',
      workspace: 'shared',
      snapshot: snapshot({
        permissions: { writePaths: [] },
        usage: { inputTokens: 1200, outputTokens: 340 },
      }),
    }),
    executionMode: 'foreground',
    showUsage: false,
  },
  {
    label: 'Nine write paths: five shown, Show more for the rest',
    node: node('s3', 'Port the handlers', 'plan', [], {
      workspace: 'shared',
      snapshot: snapshot({ permissions: { writePaths: WRITE_PATHS } }),
    }),
  },
  {
    label: 'Failed with a long error: Show full error',
    node: node('s4', 'Port the handlers', 'plan', [], {
      status: 'failed',
      errorMessage: LONG_ERROR,
      snapshot: snapshot({ status: 'failed' }),
    }),
  },
  {
    label: 'Native subagent: only provider facts',
    node: node('s5', 'Explore', 'plan', [], {
      kind: 'claude-native',
      subagentType: 'Explore',
      modelLabel: 'Fast model',
      runs: [],
    }),
  },
  {
    label: 'Workflow agent',
    node: node('s6', 'Agent 5', 'plan', [], {
      kind: 'workflow-agent',
      runs: [],
    }),
  },
];

export function SubagentSetupSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Setup facts">
      <SpecimenGrid min={280}>
        {SETUP_SPECIMENS.map((specimen) => (
          <SpecimenCell key={specimen.label} label={specimen.label} wide>
            <div className="w-full max-w-sm">
              <SubagentSetupDetails
                node={specimen.node}
                executionMode={specimen.executionMode}
                showUsage={specimen.showUsage}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function BannerSpecimen({
  label,
  target,
  ancestors,
  tree = CHAT_TREE,
  changeTotals,
  startExpanded = false,
}: {
  readonly label: string;
  readonly target: SubagentNode;
  readonly ancestors: readonly SubagentNode[];
  readonly tree?: typeof CHAT_TREE;
  readonly changeTotals?: {
    readonly filesChanged: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly startExpanded?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(startExpanded);
  return (
    <SpecimenCell label={label} wide>
      <Surface variant="outline" className="relative w-full overflow-hidden">
        <SubagentBanner
          tree={tree}
          node={target}
          ancestors={ancestors}
          changeTotals={changeTotals}
          expanded={expanded}
          onToggle={(): void => setExpanded((current) => !current)}
          onOpenLineage={noop}
        >
          <p className="px-4 pb-3 text-xs fg-secondary">
            Details sit here when the disclosure is open.
          </p>
        </SubagentBanner>
      </Surface>
    </SpecimenCell>
  );
}

export function SubagentBannerSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Banner" hint="Breadcrumb, then the facts line">
      <BannerSpecimen
        label="Running, collapsed (press the chevron to open)"
        target={node('b1', 'Port the handlers', 'plan', [], {
          status: 'running',
          modelLabel: 'Large model',
          harnessId: 'claude',
          thinkingLevel: 'high',
          workspace: 'shared',
        })}
        ancestors={[PLAN]}
      />
      <BannerSpecimen
        label="Isolated worktree with change totals, expanded"
        target={node('b2', 'Port the handlers', 'plan', [], {
          modelLabel: 'Large model',
          workspace: 'isolated',
        })}
        ancestors={[PLAN]}
        changeTotals={{ filesChanged: 3, additions: 12, deletions: 4 }}
        startExpanded
      />
      <BannerSpecimen
        label="Failed with a short error inline"
        target={REVIEW}
        ancestors={[PLAN, IMPLEMENT]}
      />
      <BannerSpecimen
        label="Failed with a long error: the facts line leaves it to Setup"
        target={node('b3', 'Port the handlers', 'plan', [], {
          status: 'failed',
          errorMessage: LONG_ERROR,
        })}
        ancestors={[PLAN]}
      />
      <BannerSpecimen
        label="Queued, idle with active tasks below"
        target={node('b4', 'Coordinate the rollout', 'plan', [], {
          status: 'idle',
          liveDescendantCount: 3,
        })}
        ancestors={[PLAN]}
      />
      <BannerSpecimen
        label="Long titles"
        target={LONG_TITLE_CHILD}
        ancestors={[LONG_TITLE_PARENT]}
        tree={LONG_TREE}
      />
      <BannerSpecimen
        label="Top level queued task"
        target={EXPLORE}
        ancestors={[PLAN]}
      />
    </SpecimenPanel>
  );
}

const WATCHER_TEXT = [
  '<system_instruction>',
  'Watcher event details.',
  '<canopy_watcher_event>',
  JSON.stringify({
    watcherId: 'watcher-1',
    label: 'Delegate completion',
    target: { kind: 'managed_delegation', outcome: 'completed' },
  }),
  '</canopy_watcher_event>',
  '</system_instruction>',
].join('\n');

const STEERING_TEXT = [
  '<system_instruction>',
  'A managed subordinate (Write the notes) requested steering from its direct parent.',
  '<subordinate_request>',
  'Which tone should the notes use?',
  '</subordinate_request>',
  '</system_instruction>',
].join('\n');

export function SubagentTranscriptSheet(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Parent messages">
        <SpecimenCell label="Task from the parent" wide>
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="task"
              text="Port the **billing handlers** to the new ledger API and keep the tests green."
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Follow-up" wide>
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="follow_up"
              text="Also cover the refund path."
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Only hidden instructions: a placeholder" wide>
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="task"
              text="<system_instruction>Reload the tools.</system_instruction>"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Watcher notification" wide>
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="follow_up"
              text={WATCHER_TEXT}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Steering request from a delegate" wide>
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="follow_up"
              text={STEERING_TEXT}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="A message the transcript already shows is left out (nothing below)"
          wide
        >
          <div className="w-full">
            <SubagentTaskBubble
              sender="Plan the slices"
              kind="task"
              text="Already shown"
              shownTexts={['Already shown']}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Run divider and recipient">
        <SpecimenCell label="Run divider" wide>
          <div className="w-full">
            <SubagentRunDivider runGeneration={2} />
          </div>
        </SpecimenCell>
        <SpecimenGrid min={200}>
          <SpecimenCell label="To capsule, a subagent, closed">
            <SubagentRecipientTrigger
              recipient={{
                id: 'self',
                kind: 'self',
                title: 'Port the handlers',
                levelsUp: 0,
                canMessage: true,
              }}
              open={false}
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="To capsule, root chat, open">
            <SubagentRecipientTrigger
              recipient={{
                id: 'root-chat',
                kind: 'root',
                title: 'Billing cleanup',
                levelsUp: 2,
                canMessage: true,
              }}
              open
              onClick={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="To capsule, long title truncates">
            <SubagentRecipientTrigger
              recipient={{
                id: 'long',
                kind: 'ancestor',
                title:
                  'Reconcile every invoice line against the ledger export and report the differences',
                levelsUp: 1,
                canMessage: true,
              }}
              open={false}
              onClick={noop}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
