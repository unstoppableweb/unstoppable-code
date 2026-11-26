import { useId, useState, type JSX, type ReactNode } from 'react';
import { CHAT_DETAILS, type ChatDetail } from '@canopy/protocol/chat-detail';
import type { AutoResumeMetadata } from '@canopy/protocol/remote-control/shell';
import {
  InlineCode,
  Surface,
  AutoResumeMarker,
  Button,
  ChatAppNameProvider,
  ChatComposerToolbarChip,
  ChatDetailProvider,
  ShimmerCopies,
  StepBadgeLine,
  StepRow,
  StepTenseProvider,
  buildPlanModeChip,
  buildWorkflowChip,
  WorkflowChipDescription,
  buildQuestionReadyChip,
  useChatAppName,
  useChatDetail,
  useGroupToolCalls,
  useStepBadges,
  useStepTense,
  useTurnCollapse,
  type StepTense,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

/**
 * Sheets for `chat-look` (the detail, app name and step tense
 * providers with the hooks that read them) and for `composer-plan-chip`.
 * The providers have no markup of their own, so each one wraps the real
 * transcript parts that read it, next to a live readout of what the hooks
 * return.
 */

const noop = (): void => undefined;
const RESUMED_AT = Date.UTC(2026, 9, 25, 16, 41, 0);

const TENSES: readonly StepTense[] = [
  'done',
  'running',
  'failed',
  'blocked',
  'interrupted',
  'waiting',
];

function Readout({ children }: { readonly children: ReactNode }): JSX.Element {
  return <InlineCode>{children}</InlineCode>;
}

// ---------------------------------------------------------------------------
// Chat presentation contexts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ChatDetailProvider
// ---------------------------------------------------------------------------

function DetailReadout(): JSX.Element {
  const detail = useChatDetail();
  const grouped = useGroupToolCalls();
  return (
    <Readout>
      {`useChatDetail: ${detail} · useGroupToolCalls: ${String(grouped)}`}
    </Readout>
  );
}

function CollapseDemo({
  detail,
}: {
  readonly detail: ChatDetail;
}): JSX.Element {
  const [complete, setComplete] = useState(false);
  const [collapsed, setCollapsed] = useTurnCollapse(complete, detail);
  return (
    <div className="flex flex-col gap-2">
      <Readout>
        {`turn ${complete ? 'complete' : 'running'} · ${collapsed ? 'folded' : 'open'}`}
      </Readout>
      <div className="flex gap-2">
        <Button
          size="compact"
          variant="secondary"
          disabled={complete}
          onClick={() => setComplete(true)}
        >
          Finish turn
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!complete}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? 'Reopen turn' : 'Fold turn'}
        </Button>
      </div>
    </div>
  );
}

function DetailColumn({
  detail,
}: {
  readonly detail: ChatDetail;
}): JSX.Element {
  return (
    <ChatDetailProvider value={detail}>
      <div className="flex w-full min-w-0 flex-col gap-3">
        <DetailReadout />
        <StepRow
          step
          label={detail === 'detailed' ? 'Ran git status' : 'Ran 3 commands'}
          expandable={detail !== 'detailed'}
          isOpen={false}
          onToggle={noop}
        />
        <CollapseDemo detail={detail} />
      </div>
    </ChatDetailProvider>
  );
}

// ---------------------------------------------------------------------------
// ChatAppNameProvider
// ---------------------------------------------------------------------------

function AppNameReadout(): JSX.Element {
  const name = useChatAppName();
  return <Readout>{`useChatAppName: ${name ?? 'undefined'}`}</Readout>;
}

const RESUME_REASONS: readonly {
  readonly label: string;
  readonly resume: AutoResumeMetadata | undefined;
}[] = [
  {
    label: 'App closed, then resumed',
    resume: { reason: 'app_shutdown', resendsUserMessage: false },
  },
  {
    label: 'Usage limit, with the provider named',
    resume: {
      reason: 'usage_limit',
      providerName: 'Provider A',
      resendsUserMessage: false,
    },
  },
  {
    label: 'Signed in again, last message re-sent',
    resume: { reason: 'provider_sign_in', resendsUserMessage: true },
  },
  {
    label: 'Account change',
    resume: { reason: 'authentication', resendsUserMessage: false },
  },
  {
    label: 'Sign-in recovery',
    resume: { reason: 'auth_recovery', resendsUserMessage: false },
  },
  { label: 'No recorded reason', resume: undefined },
];

// ---------------------------------------------------------------------------
// StepTenseProvider and StepBadgeLine
// ---------------------------------------------------------------------------

function TenseReadout(): JSX.Element {
  const tense = useStepTense();
  return <Readout>{`useStepTense: ${tense ?? 'none'}`}</Readout>;
}

function BadgeReadout(): JSX.Element {
  const inLine = useStepBadges();
  return <Readout>{`useStepBadges: ${String(inLine)}`}</Readout>;
}

function tenseLabel(tense: StepTense): string {
  switch (tense) {
    case 'done':
      return 'Ran git status';
    case 'running':
      return 'Running git status';
    case 'failed':
      return 'Couldn’t run git status';
    case 'blocked':
      return 'Blocked git status';
    case 'interrupted':
      return 'Interrupted git status';
    case 'waiting':
      return 'Waiting to run git status';
  }
}

export function ChatLookSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="ChatDetailProvider"
        hint="How much of the work shows"
      >
        <SpecimenGrid min={280}>
          {CHAT_DETAILS.map((detail) => (
            <SpecimenCell key={detail} label={detail}>
              <DetailColumn detail={detail} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="ChatAppNameProvider"
        hint="The product name in resume markers"
      >
        <SpecimenGrid min={320}>
          {RESUME_REASONS.map(({ label, resume }) => (
            <SpecimenCell key={label} label={label}>
              <ChatAppNameProvider value="Atlas">
                <div className="flex w-full flex-col gap-2">
                  <AutoResumeMarker
                    autoResume={resume}
                    timestamp={RESUMED_AT}
                    text="Continue"
                  />
                </div>
              </ChatAppNameProvider>
            </SpecimenCell>
          ))}
          <SpecimenCell label="No app name provided: the marker says “The app”">
            <ChatAppNameProvider value={undefined}>
              <div className="flex w-full flex-col gap-2">
                <AppNameReadout />
                <AutoResumeMarker
                  autoResume={{
                    reason: 'app_shutdown',
                    resendsUserMessage: false,
                  }}
                  timestamp={RESUMED_AT}
                  text="Continue"
                />
              </div>
            </ChatAppNameProvider>
          </SpecimenCell>
          <SpecimenCell label="Provided at the root, read by the hook">
            <ChatAppNameProvider value="Atlas">
              <AppNameReadout />
            </ChatAppNameProvider>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="StepTenseProvider and StepBadgeLine"
        hint="A step in each tense"
      >
        <SpecimenGrid min={280}>
          {TENSES.map((tense) => (
            <SpecimenCell key={tense} label={tense}>
              <StepTenseProvider value={tense}>
                <div className="flex w-full min-w-0 flex-col gap-2">
                  <TenseReadout />
                  <StepRow
                    step
                    label={tenseLabel(tense)}
                    running={tense === 'running'}
                    failed={tense === 'failed'}
                  />
                  {tense === 'running' && (
                    <span className="min-w-0 truncate canopy-text-shimmer-strong">
                      Waiting for the build to finish
                      <ShimmerCopies>
                        Waiting for the build to finish
                      </ShimmerCopies>
                    </span>
                  )}
                </div>
              </StepTenseProvider>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Inside a step row's badge line">
            <>
              <StepBadgeLine>
                <BadgeReadout />
              </StepBadgeLine>
            </>
          </SpecimenCell>
          <SpecimenCell label="Outside a badge line: plain text, no badges">
            <>
              <BadgeReadout />
            </>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// composer-plan-chip
// ---------------------------------------------------------------------------

/**
 * Sheet for <composer-plan-chip> builders (buildPlanModeChip,
 * buildQuestionReadyChip). The chip config has no forced hover, press or
 * focus state, so those show only by hovering, pressing or tabbing to a chip.
 */

function ComposerBox({
  children,
  narrow = false,
}: {
  readonly children: ReactNode;
  readonly narrow?: boolean;
}): JSX.Element {
  return (
    <Surface
      variant="group"
      padding="section-compact"
      className={`max-w-full ${narrow ? 'w-60' : 'w-160'}`}
    >
      <div className="flex min-h-8 items-center gap-2">{children}</div>
    </Surface>
  );
}

function ToggleChipDemo({
  initial,
  disabled,
}: {
  readonly initial: boolean;
  readonly disabled?: boolean;
}): JSX.Element {
  const [active, setActive] = useState(initial);
  return (
    <ChatComposerToolbarChip
      {...buildPlanModeChip({
        presentation: 'toggle',
        active,
        onToggle: () => setActive((current) => !current),
        ...(disabled === undefined ? {} : { disabled }),
      })}
    />
  );
}

function DismissibleChipDemo({
  readOnly,
  compact,
  disabled,
}: {
  readonly readOnly: boolean;
  readonly compact?: boolean;
  readonly disabled: boolean;
}): JSX.Element {
  const [on, setOn] = useState(true);
  return on ? (
    <ChatComposerToolbarChip
      {...buildPlanModeChip({
        readOnly,
        disabled,
        onDisable: () => setOn(false),
        ...(compact === undefined ? {} : { compact }),
      })}
    />
  ) : (
    <Button size="compact" variant="secondary" onClick={() => setOn(true)}>
      Turn on again
    </Button>
  );
}

function WorkflowChipDemo({
  workflowName,
  compact,
  disabled,
}: {
  readonly workflowName: string | null;
  readonly compact?: boolean;
  readonly disabled: boolean;
}): JSX.Element {
  const [on, setOn] = useState(true);
  const nameId = useId();
  return on ? (
    <>
      <ChatComposerToolbarChip
        {...buildWorkflowChip({
          workflowName,
          descriptionId: nameId,
          disabled,
          onDisable: () => setOn(false),
          ...(compact === undefined ? {} : { compact }),
        })}
      />
      <WorkflowChipDescription id={nameId} workflowName={workflowName} />
    </>
  ) : (
    <Button size="compact" variant="secondary" onClick={() => setOn(true)}>
      Turn on again
    </Button>
  );
}

export function PlanChipSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Plan chip, dismissible"
        hint="buildPlanModeChip: shown only while Plan is on; click removes it"
      >
        <SpecimenGrid min={340}>
          <SpecimenCell label="Plan, on" wide>
            <ComposerBox>
              <DismissibleChipDemo readOnly={false} disabled={false} />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Read only (Cursor and Copilot)" wide>
            <ComposerBox>
              <DismissibleChipDemo readOnly disabled={false} />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Compact: the glyph alone, in a circle">
            <ComposerBox narrow>
              <DismissibleChipDemo readOnly={false} compact disabled={false} />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Disabled while the turn runs">
            <ComposerBox>
              <DismissibleChipDemo readOnly={false} disabled />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Long label">
            <ComposerBox>
              <ChatComposerToolbarChip
                {...buildPlanModeChip({
                  readOnly: false,
                  disabled: false,
                  onDisable: noop,
                })}
                label="Plan: review every file before any change is made"
              />
            </ComposerBox>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Plan chip, toggle"
        hint="buildPlanModeChip: stays mounted; click flips Plan"
      >
        <SpecimenGrid min={340}>
          <SpecimenCell label="Off: icon only" wide>
            <ComposerBox>
              <ToggleChipDemo initial={false} />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="On: the amber capsule with its label" wide>
            <ComposerBox>
              <ToggleChipDemo initial />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Disabled, off">
            <ComposerBox>
              <ToggleChipDemo initial={false} disabled />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Disabled, on">
            <ComposerBox>
              <ToggleChipDemo initial disabled />
            </ComposerBox>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Workflow chip"
        hint="buildWorkflowChip: shown only while workflow mode is on; names the workflow Send runs; click turns it off"
      >
        <SpecimenGrid min={340}>
          <SpecimenCell label="A workflow picked" wide>
            <ComposerBox>
              <WorkflowChipDemo
                workflowName="Bug fix with repro"
                disabled={false}
              />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Choose when sending" wide>
            <ComposerBox>
              <WorkflowChipDemo workflowName={null} disabled={false} />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Compact: the glyph alone, in a circle">
            <ComposerBox narrow>
              <WorkflowChipDemo
                workflowName="Bug fix with repro"
                compact
                disabled={false}
              />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Disabled while the send target loads">
            <ComposerBox>
              <WorkflowChipDemo workflowName="Bug fix with repro" disabled />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Long name truncates">
            <ComposerBox>
              <WorkflowChipDemo
                workflowName="Implementation plan, autopilot build, tests and a pull request for review"
                disabled={false}
              />
            </ComposerBox>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Question chip"
        hint="buildQuestionReadyChip: a question waits with its prompt closed"
      >
        <SpecimenGrid min={340}>
          <SpecimenCell label="Question" wide>
            <ComposerBox>
              <ChatComposerToolbarChip
                {...buildQuestionReadyChip({ onOpen: noop })}
              />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Compact: the glyph alone">
            <ComposerBox narrow>
              <ChatComposerToolbarChip
                {...buildQuestionReadyChip({ onOpen: noop, compact: true })}
              />
            </ComposerBox>
          </SpecimenCell>
          <SpecimenCell label="Beside the Plan chip, as in the composer">
            <ComposerBox>
              <ChatComposerToolbarChip
                {...buildPlanModeChip({
                  readOnly: false,
                  disabled: false,
                  onDisable: noop,
                })}
              />
              <ChatComposerToolbarChip
                {...buildQuestionReadyChip({ onOpen: noop })}
              />
            </ComposerBox>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
