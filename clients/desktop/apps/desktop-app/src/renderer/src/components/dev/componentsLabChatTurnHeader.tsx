import { useState, type JSX } from 'react';
import type {
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
} from '@canopy/protocol/remote-control/shell';
import {
  Button,
  DropdownMenuItem,
  Surface,
  TurnMoreMenu,
  TurnOutcomeControl,
  TurnOutcomeTooltip,
  TurnResumeNotice,
  TurnWorkHeader,
  type TurnWorkHeaderProps,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// A fixed start keeps every finished header's words the same on each visit.
const START = Date.UTC(2026, 9, 30, 12, 0, 0);

const OUTCOMES: TurnOutcomeCounts = { blocked: 1, failed: 2, interrupted: 1 };

function step(
  toolUseId: string,
  outcome: TurnOutcomeStepDetail['outcome'],
  description: string,
  output: string,
): TurnOutcomeStepDetail {
  return {
    toolUseId,
    outcome,
    toolName: 'Bash',
    input: JSON.stringify({ command: `run ${toolUseId}`, description }),
    output,
  };
}

const OUTCOME_STEPS: readonly TurnOutcomeStepDetail[] = [
  step('lint', 'failed', 'Run the linter', 'Exit code 1\n3 problems found'),
  step('read', 'blocked', 'Read the env file', 'The user denied this action'),
  step('build', 'interrupted', 'Build the app', 'Interrupted'),
  step(
    'long',
    'failed',
    'Run the full integration suite against the staging environment',
    `Exit code 1\n${'The remote host closed the connection before the suite finished. '.repeat(4)}`,
  ),
];

const MANY_STEPS: readonly TurnOutcomeStepDetail[] = Array.from(
  { length: 8 },
  (_, index) =>
    step(
      `step-${index + 1}`,
      'failed',
      `Check package ${index + 1}`,
      'Exit code 1\nType error',
    ),
);

function Wide({ children }: { readonly children: JSX.Element }): JSX.Element {
  return <div className="w-full">{children}</div>;
}

/** A header whose chevron folds and unfolds like the transcript's. */
function ToggleHeader(props: TurnWorkHeaderProps): JSX.Element {
  const [open, setOpen] = useState(props.isOpen ?? false);
  return (
    <TurnWorkHeader
      {...props}
      expandable
      isOpen={open}
      onToggle={(): void => setOpen((value) => !value)}
    />
  );
}

/** A running header, started 28 seconds before the sheet mounted. */
function LiveHeader(props: TurnWorkHeaderProps): JSX.Element {
  const [startedAt] = useState(() => Date.now() - 28_000);
  return <TurnWorkHeader startedAt={startedAt} {...props} />;
}

export function TurnWorkHeaderSpecimen(): JSX.Element {
  const [setupStartedAt] = useState(() => Date.now() - 12_000);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="While the turn runs">
        <SpecimenCell label="Starting: submitted, nothing visible yet" wide>
          <Wide>
            <TurnWorkHeader starting />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Setting up the chat’s worktree, with a clock" wide>
          <Wide>
            <TurnWorkHeader
              starting
              setup={{
                projectName: 'billing-service',
                startedAtMs: setupStartedAt,
              }}
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Setting up a project with no name" wide>
          <Wide>
            <TurnWorkHeader starting setup={{ startedAtMs: setupStartedAt }} />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Working: the time ticks" wide>
          <Wide>
            <LiveHeader />
          </Wide>
        </SpecimenCell>
        <SpecimenCell
          label="Working, with actions pinned at the end of the row"
          wide
        >
          <Wide>
            <LiveHeader
              trailing={
                <Button variant="ghost" size="compact">
                  Stop
                </Button>
              }
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Paused: waiting on a request to the person" wide>
          <Wide>
            <LiveHeader waitingForUser />
          </Wide>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="When the turn ends">
        <SpecimenCell label="Worked for 3m 24s" wide>
          <Wide>
            <TurnWorkHeader startedAt={START} finishedAt={START + 204_000} />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Worked for 1h 5m" wide>
          <Wide>
            <TurnWorkHeader startedAt={START} finishedAt={START + 3_900_000} />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Failed after 28s" wide>
          <Wide>
            <TurnWorkHeader
              startedAt={START}
              finishedAt={START + 28_000}
              completionStatus="failed"
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Stopped after 28s" wide>
          <Wide>
            <TurnWorkHeader
              startedAt={START}
              finishedAt={START + 28_000}
              completionStatus="cancelled"
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Interrupted after 28s" wide>
          <Wide>
            <TurnWorkHeader
              startedAt={START}
              finishedAt={START + 28_000}
              completionStatus="interrupted"
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Only the total is known (a web summary)" wide>
          <Wide>
            <TurnWorkHeader elapsedMs={95_000} live={false} />
          </Wide>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Folding, detail and outcomes">
        <SpecimenCell label="Foldable, closed: click to open the steps" wide>
          <Wide>
            <ToggleHeader
              startedAt={START}
              finishedAt={START + 204_000}
              detail="3 commands, 2 files"
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Foldable, open" wide>
          <Wide>
            <ToggleHeader
              startedAt={START}
              finishedAt={START + 204_000}
              detail="3 commands, 2 files"
              isOpen
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell
          label="With blocked, error and interrupted counts beside the toggle"
          wide
        >
          <Wide>
            <ToggleHeader
              startedAt={START}
              finishedAt={START + 204_000}
              outcome={
                <TurnOutcomeControl
                  outcomes={OUTCOMES}
                  outcomeSteps={OUTCOME_STEPS}
                  onJumpToOutcome={noop}
                />
              }
            />
          </Wide>
        </SpecimenCell>
        <SpecimenCell label="Long detail truncates instead of wrapping" wide>
          <Wide>
            <ToggleHeader
              startedAt={START}
              finishedAt={START + 204_000}
              detail={`Read ${'a-very-long-file-name-that-keeps-going-'.repeat(4)}.ts`}
              trailing={
                <Button variant="ghost" size="compact">
                  Fork
                </Button>
              }
            />
          </Wide>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

export function TurnResumeNoticeSpecimen(): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <SpecimenPanel title="Offer to resume a turn that did not finish">
      <SpecimenCell label="Resume alone" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="Turn stopped"
            message="The agent picks up where it stopped."
            resumeLabel="Resume"
            onResume={noop}
            data-testid="lab-resume-plain"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="With a dismiss action before Resume" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="The app closed before this chat finished"
            message="The agent picks up where it stopped."
            resumeLabel="Resume chat"
            onResume={noop}
            onDismiss={noop}
            data-testid="lab-resume-dismiss"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Attention intent" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="Usage limit reached mid-turn"
            message="Resume after the limit resets, or switch models."
            intent="attention"
            resumeLabel="Resume"
            onResume={noop}
            onDismiss={noop}
            data-testid="lab-resume-attention"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Busy: Resume spins and both actions stop" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="Turn stopped"
            message="The agent picks up where it stopped."
            resumeLabel="Resume"
            busy
            busyLabel="Resuming…"
            onResume={noop}
            onDismiss={noop}
            data-testid="lab-resume-busy"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Error from the last attempt; Resume stays" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="Turn stopped"
            message="The agent picks up where it stopped."
            resumeLabel="Try again"
            error="Couldn’t reach the agent. Check your connection."
            onResume={noop}
            onDismiss={noop}
            data-testid="lab-resume-error"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Long copy wraps" wide>
        <div className="w-full">
          <TurnResumeNotice
            title="The app closed before this chat finished running its checks"
            message={`The agent picks up where it stopped, with the same context and plan. ${'It will not repeat steps that already finished. '.repeat(3)}`}
            resumeLabel="Resume chat"
            onResume={noop}
            onDismiss={noop}
            dismissLabel="Not now"
            data-testid="lab-resume-long"
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Try it: Resume busies the notice for two seconds"
        wide
      >
        <div className="w-full">
          <TurnResumeNotice
            title="Turn stopped"
            message="The agent picks up where it stopped."
            resumeLabel="Resume"
            busy={busy}
            busyLabel="Resuming…"
            onResume={(): void => {
              setBusy(true);
              window.setTimeout(() => setBusy(false), 2_000);
            }}
            onDismiss={noop}
            data-testid="lab-resume-live"
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

function TooltipSurface({
  children,
}: {
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <Surface variant="card" padding="tight" className="w-80 max-w-full">
      <div className="text-xs fg-secondary">{children}</div>
    </Surface>
  );
}

export function TurnOutcomeTooltipSpecimen(): JSX.Element {
  const [jumped, setJumped] = useState<string | null>(null);
  return (
    <SpecimenPanel title="What the outcome control shows on hover">
      <SpecimenGrid min={300}>
        <SpecimenCell label="Counts only: the turn’s rows are not loaded">
          <TooltipSurface>
            <TurnOutcomeTooltip outcomes={OUTCOMES} />
          </TooltipSurface>
        </SpecimenCell>
        <SpecimenCell label="Counts only, a single blocked step">
          <TooltipSurface>
            <TurnOutcomeTooltip
              outcomes={{ blocked: 1, failed: 0, interrupted: 0 }}
            />
          </TooltipSurface>
        </SpecimenCell>
        <SpecimenCell label="Empty: no counts and no steps">
          <TooltipSurface>
            <TurnOutcomeTooltip
              outcomes={{ blocked: 0, failed: 0, interrupted: 0 }}
              steps={[]}
            />
          </TooltipSurface>
        </SpecimenCell>
        <SpecimenCell label="Steps in blocked, error, interrupted order (plain rows)">
          <TooltipSurface>
            <TurnOutcomeTooltip outcomes={OUTCOMES} steps={OUTCOME_STEPS} />
          </TooltipSurface>
        </SpecimenCell>
        <SpecimenCell
          label={`Selectable rows${jumped ? `: jumped to ${jumped}` : ''}`}
        >
          <TooltipSurface>
            <TurnOutcomeTooltip
              outcomes={OUTCOMES}
              steps={OUTCOME_STEPS}
              onSelectStep={setJumped}
            />
          </TooltipSurface>
        </SpecimenCell>
        <SpecimenCell label="Five steps, then +3 more">
          <TooltipSurface>
            <TurnOutcomeTooltip
              outcomes={{ blocked: 0, failed: 8, interrupted: 0 }}
              steps={MANY_STEPS}
              onSelectStep={noop}
            />
          </TooltipSurface>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function MoreMenuDemo({
  forcedOpen = false,
  label,
}: {
  readonly forcedOpen?: boolean;
  readonly label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(forcedOpen);
  return (
    <TurnMoreMenu
      open={open}
      onOpenChange={setOpen}
      {...(label !== undefined ? { label } : {})}
      dataTestId={`lab-more-${forcedOpen ? 'open' : 'closed'}`}
    >
      <DropdownMenuItem>Branch into a new worktree</DropdownMenuItem>
      <DropdownMenuItem>Share this reply</DropdownMenuItem>
      <DropdownMenuItem disabled>Run comments</DropdownMenuItem>
    </TurnMoreMenu>
  );
}

export function TurnMoreMenuSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="The … at the end of a reply’s action row">
      <SpecimenGrid min={260}>
        <SpecimenCell label="Closed: click to open (hover shows the tooltip)">
          <MoreMenuDemo />
        </SpecimenCell>
        <SpecimenCell label="Custom label">
          <MoreMenuDemo label="Reply actions" />
        </SpecimenCell>
        <SpecimenCell label="Open, with a disabled row">
          <div className="min-h-44">
            <MoreMenuDemo forcedOpen />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
