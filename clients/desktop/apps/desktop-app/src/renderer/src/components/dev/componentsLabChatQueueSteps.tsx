import { useState, type JSX } from 'react';
import {
  Button,
  PlanCopyAction,
  STEP_GROUP_BODY_CLASS,
  STEP_ROW_BODY_CLASS,
  StatusAnnouncer,
  StepRow,
  SteeringRequestTitle,
  TaskStopButton,
  planCopyStateFromMarkdown,
  planCopyStateFromResolution,
  stepKindIcon,
  type PlanCopyAppearance,
  type PlanCopyState,
  type StatusAnnouncement,
  type StepKind,
} from '@canopy/ui-shared/components';
import {
  FocusOnMount,
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const PLAN = '# Plan\n\n1. Add retry handling\n2. Cover it with tests';

const READY: PlanCopyState = planCopyStateFromMarkdown(PLAN);
const LOADING: PlanCopyState = planCopyStateFromMarkdown(undefined, {
  loading: true,
});
const MISSING: PlanCopyState = planCopyStateFromMarkdown('   ');
const TRUNCATED: PlanCopyState = planCopyStateFromResolution({
  kind: 'incomplete',
  reason: 'truncated',
});

const COPIES_OK = (): Promise<boolean> => Promise.resolve(true);
const COPY_FAILS = (): Promise<boolean> => Promise.resolve(false);

const APPEARANCES: readonly {
  appearance: PlanCopyAppearance;
  label: string;
  compact?: boolean;
}[] = [
  { appearance: 'footer', label: 'footer: quiet icon beside a turn’s stamp' },
  { appearance: 'composer', label: 'composer: labeled capsule' },
  { appearance: 'control', label: 'control: 28px secondary button' },
  {
    appearance: 'control',
    label: 'control, compact: icon only',
    compact: true,
  },
  { appearance: 'card', label: 'card: the plan card’s action' },
];

const PLAN_STATES: readonly { label: string; state: PlanCopyState }[] = [
  { label: 'ready', state: READY },
  { label: 'loading: inert, reason in the tooltip', state: LOADING },
  { label: 'text missing: inert, reason in the tooltip', state: MISSING },
  { label: 'text truncated: inert, reason in the tooltip', state: TRUNCATED },
];

export function PlanCopyActionSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {PLAN_STATES.map(({ label, state }, index) => (
        <SpecimenPanel key={label} title={`State: ${label}`}>
          <SpecimenGrid min={180}>
            {APPEARANCES.map(({ appearance, label: where, compact }) => (
              <SpecimenCell key={where} label={where}>
                <PlanCopyAction
                  state={state}
                  appearance={appearance}
                  compact={compact}
                  dataTestId={`lab-plan-copy-${appearance}${compact ? '-compact' : ''}-${String(index)}`}
                  write={COPIES_OK}
                />
              </SpecimenCell>
            ))}
          </SpecimenGrid>
        </SpecimenPanel>
      ))}
      <SpecimenPanel title="Feedback (click to try)">
        <SpecimenGrid min={220}>
          <SpecimenCell label="Copy succeeds: the control reads Copied">
            <PlanCopyAction
              state={READY}
              appearance="composer"
              dataTestId="lab-plan-copy-succeeds"
              write={COPIES_OK}
            />
          </SpecimenCell>
          <SpecimenCell label="Copy fails: tooltip says it could not copy">
            <PlanCopyAction
              state={READY}
              appearance="control"
              dataTestId="lab-plan-copy-fails"
              write={COPY_FAILS}
            />
          </SpecimenCell>

          <SpecimenCell label="Focused (keyboard ring)">
            <FocusOnMount>
              <PlanCopyAction
                state={READY}
                appearance="control"
                dataTestId="lab-plan-copy-focus"
                write={COPIES_OK}
              />
            </FocusOnMount>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const MESSAGES: readonly string[] = [
  'Saved the draft',
  'Saved the draft',
  'Could not save: the disk is full',
];

export function StatusAnnouncerSpecimen(): JSX.Element {
  const [count, setCount] = useState(0);
  const [announcement, setAnnouncement] = useState<StatusAnnouncement | null>(
    null,
  );
  const announce = (): void => {
    setAnnouncement({
      id: count,
      text: MESSAGES[count % MESSAGES.length] ?? 'Saved the draft',
    });
    setCount(count + 1);
  };
  return (
    <SpecimenPanel title="A polite live region (invisible: it only speaks)">
      <SpecimenGrid min={300}>
        <SpecimenCell
          label="Idle: mounted and empty so assistive technology knows it"
          wide
        >
          <StatusAnnouncer
            announcement={null}
            privacy="mask"
            data-testid="lab-status-announcer-idle"
          />
          <span className="text-s fg-secondary">Nothing announced</span>
        </SpecimenCell>
        <SpecimenCell
          label="Each press announces again, even with the same text; it clears after four seconds"
          wide
        >
          <Button size="compact" onClick={announce}>
            Announce
          </Button>
          <StatusAnnouncer
            announcement={announcement}
            privacy="mask"
            data-testid="lab-status-announcer-mask"
          />
          <span className="text-s fg-secondary">
            {announcement
              ? `Announced #${String(count)}: ${announcement.text}`
              : 'Press to announce'}
          </span>
        </SpecimenCell>
        <SpecimenCell
          label="Conversation content is blocked from session replay (privacy: block)"
          wide
        >
          <StatusAnnouncer
            announcement={{ id: 'path', text: 'Opened src/upload/retry.ts' }}
            privacy="block"
            data-testid="lab-status-announcer-block"
          />
          <span className="text-s fg-secondary">
            Announces “Opened src/upload/retry.ts”
          </span>
        </SpecimenCell>
        <SpecimenCell label="Withdrawn: an empty announcement just clears" wide>
          <StatusAnnouncer
            announcement={{ id: 'empty', text: '' }}
            privacy="mask"
            data-testid="lab-status-announcer-empty"
          />
          <span className="text-s fg-secondary">Nothing announced</span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function TaskStopButtonSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {(['chip', 'row', 'drawer'] as const).map((appearance) => (
        <SpecimenPanel key={appearance} title={`Appearance: ${appearance}`}>
          <SpecimenGrid min={200}>
            <SpecimenCell label="Running">
              <div className={appearance === 'row' ? 'w-24' : undefined}>
                <TaskStopButton
                  stopping={false}
                  onStop={noop}
                  accessibleLabel="Stop agent"
                  dataTestId={`lab-task-stop-${appearance}`}
                />
              </div>
            </SpecimenCell>
            <SpecimenCell label="With hover help">
              <div className={appearance === 'row' ? 'w-24' : undefined}>
                <TaskStopButton
                  stopping={false}
                  onStop={noop}
                  accessibleLabel="Stop agent"
                  title="Ends this agent and keeps its work"
                  dataTestId={`lab-task-stop-title-${appearance}`}
                />
              </div>
            </SpecimenCell>
            <SpecimenCell label="Stopping: disabled so it cannot be sent twice">
              <div className={appearance === 'row' ? 'w-24' : undefined}>
                <TaskStopButton
                  stopping
                  onStop={noop}
                  accessibleLabel="Stop agent"
                  dataTestId={`lab-task-stopping-${appearance}`}
                />
              </div>
            </SpecimenCell>
          </SpecimenGrid>
        </SpecimenPanel>
      ))}
      <SpecimenPanel title="Focus and keys">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Focused chip (keyboard ring)">
            <FocusOnMount>
              <TaskStopButton
                stopping={false}
                onStop={noop}
                accessibleLabel="Stop agent"
                dataTestId="lab-task-stop-focus"
              />
            </FocusOnMount>
          </SpecimenCell>
          <SpecimenCell label="Key presses reach the row around it (stopKeyDownPropagation off)">
            <TaskStopButton
              stopping={false}
              onStop={noop}
              accessibleLabel="Stop agent"
              dataTestId="lab-task-stop-propagate"
              stopKeyDownPropagation={false}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const STEP_KINDS: readonly { kind: StepKind; label: string }[] = [
  { kind: 'thinking', label: 'Thought' },
  { kind: 'search', label: 'Searched the code' },
  { kind: 'read', label: 'Read a file' },
  { kind: 'edit', label: 'Edited a file' },
  { kind: 'plan', label: 'Wrote plan' },
  { kind: 'command', label: 'Ran a command' },
  { kind: 'graph', label: 'Checked the code graph' },
  { kind: 'web', label: 'Searched the web' },
  { kind: 'tasks', label: 'Updated the task list' },
  { kind: 'agent', label: 'Ran an agent' },
  { kind: 'question', label: 'Asked a question' },
  { kind: 'other', label: 'Used a tool' },
];

const LONG_STEP =
  'Ran a command that rewrites every import in the upload package to use the shared retry client';

function ExpandableStep(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full min-w-0">
      <StepRow
        icon={stepKindIcon('command')}
        label="Ran 2 commands"
        expandable
        isOpen={open}
        onToggle={() => setOpen((value) => !value)}
        dataTestId="lab-step-row-toggle"
      />
      {open ? (
        <div
          className={`${STEP_ROW_BODY_CLASS} ${STEP_GROUP_BODY_CLASS} fg-tertiary`}
        >
          <span>pnpm install</span>
          <span>pnpm test</span>
        </div>
      ) : null}
    </div>
  );
}

export function StepRowSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Icons by step kind">
        <SpecimenGrid min={220}>
          {STEP_KINDS.map(({ kind, label }) => (
            <SpecimenCell key={kind} label={kind}>
              <StepRow icon={stepKindIcon(kind)} label={label} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="States">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Default">
            <StepRow icon={stepKindIcon('read')} label="Read file" />
          </SpecimenCell>
          <SpecimenCell label="With detail in a lighter ink">
            <StepRow
              icon={stepKindIcon('command')}
              label="Ran"
              detail="pnpm test packages/ui-shared"
            />
          </SpecimenCell>
          <SpecimenCell label="Running: the words shimmer">
            <StepRow
              icon={stepKindIcon('search')}
              label="Searching the code"
              running
            />
          </SpecimenCell>
          <SpecimenCell label="Failed: said in words after the label">
            <StepRow
              icon={stepKindIcon('command')}
              label="Ran a command"
              failed
            />
          </SpecimenCell>
          <SpecimenCell label="Trailing change counts">
            <StepRow
              icon={stepKindIcon('edit')}
              label="Edited a file"
              trailing={<span className="fg-tertiary">+12 −3</span>}
            />
          </SpecimenCell>
          <SpecimenCell label="No icon">
            <StepRow label="Worked for 2 minutes" />
          </SpecimenCell>
          <SpecimenCell label="Expandable, closed: chevron on hover">
            <StepRow
              icon={stepKindIcon('command')}
              label="Ran 2 commands"
              expandable
              onToggle={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Expandable, open: chevron turned down">
            <StepRow
              icon={stepKindIcon('command')}
              label="Ran 2 commands"
              expandable
              isOpen
              onToggle={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Chevron at rest">
            <StepRow
              icon={stepKindIcon('read')}
              label="Read 4 files"
              expandable
              chevronAtRest
              onToggle={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Focused (keyboard ring)">
            <FocusOnMount>
              <StepRow
                icon={stepKindIcon('read')}
                label="Read 4 files"
                expandable
                onToggle={noop}
              />
            </FocusOnMount>
          </SpecimenCell>
          <SpecimenCell label="Running and expandable">
            <StepRow
              icon={stepKindIcon('agent')}
              label="Running an agent"
              running
              expandable
              onToggle={noop}
            />
          </SpecimenCell>
          <SpecimenCell label="Click to open and close">
            <ExpandableStep />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Long text">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Truncates with an ellipsis only when wider than its column">
            <div className="w-full min-w-0">
              <StepRow
                icon={stepKindIcon('command')}
                label={LONG_STEP}
                detail="pnpm exec codemod --all"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Long text, expandable">
            <div className="w-full min-w-0">
              <StepRow
                icon={stepKindIcon('command')}
                label={LONG_STEP}
                expandable
                onToggle={noop}
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Tool call rows (step)">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Words on a badge line">
            <>
              <div className="w-full min-w-0">
                <StepRow
                  step
                  icon={stepKindIcon('read')}
                  label="Read"
                  detail="packages/ui-shared/src/components/chat/StepRow.tsx"
                />
              </div>
            </>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

export function SteeringRequestTitleSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Title above a delegate’s steering request">
      <SpecimenGrid min={260}>
        <SpecimenCell label="Block, delegate named">
          <SteeringRequestTitle requestedBy="Upload worker" />
        </SpecimenCell>
        <SpecimenCell label="Block, sender unknown">
          <SteeringRequestTitle />
        </SpecimenCell>
        <SpecimenCell label="Inline, leads a queued row">
          <SteeringRequestTitle requestedBy="Upload worker" layout="inline" />
        </SpecimenCell>
        <SpecimenCell label="Inline, sender unknown">
          <SteeringRequestTitle layout="inline" />
        </SpecimenCell>
        <SpecimenCell label="Inline, long delegate name truncates">
          <div className="flex w-56 min-w-0">
            <SteeringRequestTitle
              requestedBy="Rewrite every import in the upload package to use the shared retry client"
              layout="inline"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Block, long delegate name wraps">
          <div className="w-56 min-w-0">
            <SteeringRequestTitle requestedBy="Rewrite every import in the upload package to use the shared retry client" />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
