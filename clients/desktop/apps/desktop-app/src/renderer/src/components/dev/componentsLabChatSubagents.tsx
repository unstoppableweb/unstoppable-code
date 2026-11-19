import type { JSX } from 'react';
import {
  SubagentChangesLabel,
  SubagentHarnessMark,
  SubagentIcon,
  SubagentLineageDetails,
  SubagentWorkflowDetails,
  SubagentWorktreeDetails,
} from '@canopy/ui-shared/components';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  SubagentBannerSheet,
  SubagentSetupSheet,
  SubagentTranscriptSheet,
} from './componentsLabChatSubagentsConversation';
import {
  CHAT_TREE,
  DOCS,
  EXPLORE,
  IMPLEMENT,
  LONG_TITLE_CHILD,
  LONG_TITLE_PARENT,
  LONG_TREE,
  PLAN,
  REVIEW,
  WORKFLOW_SPECIMENS,
  WORKTREE_SPECIMENS,
} from './componentsLabChatSubagentsData';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

function SubagentMarksSheet(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Subagent icon"
        hint="One glyph for every subagent surface"
      >
        <SpecimenGrid min={140}>
          <SpecimenCell label="12px">
            <SubagentIcon size={12} />
          </SpecimenCell>
          <SpecimenCell label="14px, the default">
            <SubagentIcon />
          </SpecimenCell>
          <SpecimenCell label="20px">
            <SubagentIcon size={20} />
          </SpecimenCell>
          <SpecimenCell label="Tinted with a color class">
            <SubagentIcon size={20} className="fg-accent" />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Harness mark and change totals">
        <SpecimenGrid min={160}>
          <SpecimenCell label="Harness mark, known harness">
            <SubagentHarnessMark harnessId="claude" />
            <SubagentHarnessMark harnessId="codex" size={16} />
          </SpecimenCell>
          <SpecimenCell label="Harness unknown: nothing is drawn">
            <SubagentHarnessMark harnessId={undefined} />
            <span className="text-2xs fg-tertiary">(empty)</span>
          </SpecimenCell>
          <SpecimenCell label="Changes label">
            <SubagentChangesLabel additions={12} deletions={4} />
          </SpecimenCell>
          <SpecimenCell label="Changes label, none">
            <SubagentChangesLabel additions={0} deletions={0} />
          </SpecimenCell>
          <SpecimenCell label="Changes label, large totals">
            <SubagentChangesLabel additions={12480} deletions={9021} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

function SubagentLineageSheet(): JSX.Element {
  return (
    <SpecimenPanel
      title="Lineage"
      hint="Root chat, ancestors, this task, its children, then Alongside"
    >
      <SpecimenGrid min={280}>
        <SpecimenCell label="Middle of a tree, with a child and a sibling" wide>
          <div className="w-full max-w-sm">
            <SubagentLineageDetails
              tree={CHAT_TREE}
              node={IMPLEMENT}
              ancestors={[PLAN]}
              onOpenLineage={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Leaf: no children, no siblings">
          <div className="w-full max-w-sm">
            <SubagentLineageDetails
              tree={CHAT_TREE}
              node={REVIEW}
              ancestors={[PLAN, IMPLEMENT]}
              onOpenLineage={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Top level: siblings come from the root chat">
          <div className="w-full max-w-sm">
            <SubagentLineageDetails
              tree={CHAT_TREE}
              node={PLAN}
              ancestors={[]}
              onOpenLineage={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Siblings in every status (queued, idle with active tasks below)">
          <div className="w-full max-w-sm">
            <SubagentLineageDetails
              tree={CHAT_TREE}
              node={EXPLORE}
              ancestors={[PLAN]}
              onOpenLineage={noop}
            />
            <SubagentLineageDetails
              tree={CHAT_TREE}
              node={DOCS}
              ancestors={[]}
              onOpenLineage={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long titles truncate" wide>
          <div className="w-full max-w-sm">
            <SubagentLineageDetails
              tree={LONG_TREE}
              node={LONG_TITLE_CHILD}
              ancestors={[LONG_TITLE_PARENT]}
              onOpenLineage={noop}
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SubagentWorkflowSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Workflow details for a workflow agent's chat">
      <SpecimenGrid min={280}>
        {WORKFLOW_SPECIMENS.map((specimen) => (
          <SpecimenCell key={specimen.label} label={specimen.label} wide>
            <div className="w-full max-w-sm">
              <SubagentWorkflowDetails
                tree={specimen.tree}
                node={specimen.node}
                onOpenWorkflow={specimen.openable ? noop : undefined}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SubagentWorktreeSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Worktree details" hint="Every state">
      <SpecimenGrid min={280}>
        {WORKTREE_SPECIMENS.map((specimen) => (
          <SpecimenCell key={specimen.label} label={specimen.label} wide>
            <div className="w-full max-w-sm">
              <SubagentWorktreeDetails
                state={specimen.state}
                onShowChanges={specimen.showChanges ? noop : undefined}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const SOURCE = 'packages/ui-shared/src/components/chat/subagents';

export const CHAT_SUBAGENTS_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'chat-subagent-marks',
    name: 'Subagent marks',
    group: 'Unified',
    note: 'The one subagent icon, the harness mark beside a model name and the change totals; each draws nothing or a zero when it has no data.',
    source: `${SOURCE}/common/{SubagentIcon,SubagentHarnessMark,SubagentChangesLabel}.tsx`,
    prs: [],
    View: SubagentMarksSheet,
  },
  {
    id: 'chat-subagent-lineage',
    name: 'Subagent lineage',
    group: 'Unified',
    note: 'Root-down path to a subagent with its children and Alongside siblings; every entry but the current task opens that chat.',
    source: `${SOURCE}/conversation/SubagentLineageDetails.tsx`,
    prs: [],
    View: SubagentLineageSheet,
  },
  {
    id: 'chat-subagent-workflow',
    name: 'Subagent workflow details',
    group: 'Unified',
    note: 'Run, status, position and usage for a workflow agent, with Open workflow only when the host can open it.',
    source: `${SOURCE}/conversation/SubagentWorkflowDetails.tsx`,
    prs: [],
    View: SubagentWorkflowSheet,
  },
  {
    id: 'chat-subagent-worktree',
    name: 'Subagent worktree details',
    group: 'Unified',
    note: 'An isolated subagent’s checkout: loading, failed, unavailable and ready, with every checkout and apply state.',
    source: `${SOURCE}/conversation/SubagentWorktreeDetails.tsx`,
    prs: [],
    View: SubagentWorktreeSheet,
  },
  {
    id: 'chat-subagent-setup',
    name: 'Subagent setup details',
    group: 'Unified',
    note: 'Setup facts for managed, native and workflow subagents: permissions with a Show more toggle, a long error with Show full error, and usage.',
    source: `${SOURCE}/conversation/SubagentSetupDetails.tsx`,
    prs: [],
    View: SubagentSetupSheet,
  },
  {
    id: 'chat-subagent-banner',
    name: 'Subagent banner',
    group: 'Unified',
    note: 'The sticky identity and facts header of a subagent chat: breadcrumb, status, model and workspace, with a details disclosure.',
    source: `${SOURCE}/conversation/SubagentBanner.tsx`,
    prs: [],
    View: SubagentBannerSheet,
  },
  {
    id: 'chat-subagent-transcript',
    name: 'Subagent transcript parts',
    group: 'Unified',
    note: 'The task and follow-up bubbles from the parent, the Run divider before a later run, and the To capsule that picks who a message goes to.',
    source: `${SOURCE}/conversation/{SubagentTaskBubble,SubagentRunDivider,SubagentRecipientTrigger}.tsx`,
    prs: [],
    View: SubagentTranscriptSheet,
  },
];
