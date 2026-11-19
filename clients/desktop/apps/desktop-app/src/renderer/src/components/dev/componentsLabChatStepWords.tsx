import type { JSX } from 'react';
import {
  describeStepCounts,
  describeStepKinds,
  stepKindIcon,
  stepKindOfToolCall,
  type PlanWriteStatus,
  type StepKind,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

type Counts = readonly (readonly [StepKind, number, PlanWriteStatus?])[];

// The module has no component of its own: its helpers fill the words and the
// icon of every step row and step group, so the sheet reads them live.
// Captions name the module as <step-words>.
const MODULE_TAG = '<step-words>';

const KINDS: readonly StepKind[] = [
  'thinking',
  'search',
  'read',
  'edit',
  'plan',
  'command',
  'graph',
  'web',
  'tasks',
  'agent',
  'question',
  'other',
];

const RUNS: readonly { readonly label: string; readonly counts: Counts }[] = [
  {
    label: 'One of each',
    counts: [
      ['read', 1],
      ['edit', 1],
      ['command', 1],
    ],
  },
  {
    label: 'Several of each',
    counts: [
      ['search', 3],
      ['read', 4],
      ['graph', 2],
    ],
  },
  { label: 'Thinking alone', counts: [['thinking', 1]] },
  {
    label: 'Thinking with work',
    counts: [
      ['thinking', 2],
      ['command', 2],
      ['read', 1],
    ],
  },
  { label: 'A plan write that failed', counts: [['plan', 1, 'failed']] },
  {
    label: 'A plan write still pending, twice',
    counts: [['plan', 2, 'pending']],
  },
  { label: 'An interrupted plan write', counts: [['plan', 1, 'interrupted']] },
  {
    label: 'Every kind',
    counts: KINDS.map((kind): readonly [StepKind, number] => [kind, 2]),
  },
  { label: 'Nothing counted', counts: [['read', 0]] },
];

const CALLS: readonly {
  readonly label: string;
  readonly toolName: string;
  readonly family: Parameters<typeof stepKindOfToolCall>[0]['family'];
  readonly input: string;
}[] = [
  {
    label: 'A write to the plan file counts as a plan',
    toolName: 'Write',
    family: 'write',
    input: JSON.stringify({ file_path: '/home/me/.claude/plans/ship.md' }),
  },
  {
    label: 'A write to the project is an edit',
    toolName: 'Write',
    family: 'write',
    input: JSON.stringify({ file_path: '/repo/src/index.ts' }),
  },
  {
    label: 'Only Write is a plan write',
    toolName: 'Edit',
    family: 'edit',
    input: JSON.stringify({ file_path: '/home/me/.claude/plans/ship.md' }),
  },
  {
    label: 'Broken input stays an edit',
    toolName: 'Write',
    family: 'write',
    input: '{"file_path": "/home/me/.claude/plans/ship.md"',
  },
  {
    label: 'A shell call is a command',
    toolName: 'Bash',
    family: 'bash',
    input: JSON.stringify({ command: 'pnpm test' }),
  },
];

export function StepWordsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Icon per step kind"
        hint={`${MODULE_TAG}: the icon each kind leads with`}
      >
        <SpecimenGrid min={140}>
          {KINDS.map((kind) => (
            <SpecimenCell key={kind} label={kind}>
              <span className="fg-secondary">{stepKindIcon(kind)}</span>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Summaries"
        hint={`${MODULE_TAG}: counted and plain summaries`}
      >
        {RUNS.map(({ label, counts }) => (
          <SpecimenCell key={label} label={label} wide>
            <div className="flex w-full flex-col gap-1 text-s">
              <span>
                <span className="fg-tertiary">Counted: </span>
                {describeStepCounts(counts) || '(empty)'}
              </span>
              <span>
                <span className="fg-tertiary">Clean look: </span>
                {describeStepKinds(counts) || '(empty)'}
              </span>
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel
        title="Tool call kinds"
        hint={`${MODULE_TAG}: the kind a tool call counts as`}
      >
        {CALLS.map(({ label, toolName, family, input }) => {
          const kind = stepKindOfToolCall({ toolName, family, input });
          return (
            <SpecimenCell key={label} label={label} wide>
              <span className="flex items-center gap-2 text-s">
                <span className="fg-secondary">{stepKindIcon(kind)}</span>
                {toolName} → {kind}
              </span>
            </SpecimenCell>
          );
        })}
      </SpecimenPanel>
    </div>
  );
}
