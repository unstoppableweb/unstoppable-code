import { useState, type JSX, type ReactNode } from 'react';
import { CHAT_DETAILS, type ChatDetail } from '@canopy/protocol/chat-detail';
import type { AutoResumeMetadata } from '@canopy/protocol/portal';
import {
  AutoResumeMarker,
  Button,
  ChatAppNameProvider,
  ChatComposerToolbarChip,
  ChatCopyAction,
  ChatDetailProvider,
  ChatLookProvider,
  StepBadgeLine,
  StepRow,
  StepTenseProvider,
  TurnTimer,
  buildPlanModeChip,
  buildQuestionReadyChip,
  useChatAppName,
  useChatDetail,
  useChatLook,
  useCleanChatLook,
  useGroupToolCalls,
  useStepBadgeRows,
  useStepBadges,
  useStepTense,
  useTurnCollapse,
  type ChatLook,
  type StepTense,
} from '@canopy/ui-shared/components';
import { PlanModeIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

/**
 * Sheets for `chat-look` (the chat look, detail, app name and step tense
 * providers with the hooks that read them) and for `composer-plan-chip`.
 * The providers have no markup of their own, so each one wraps the real
 * transcript parts that read it, next to a live readout of what the hooks
 * return.
 */

const noop = (): void => undefined;

// Fixed so the markers and timers read the same on every render.
const TURN_START = Date.UTC(2026, 9, 25, 16, 38, 0);
const TURN_END = TURN_START + 204_000;
const RESUMED_AT = Date.UTC(2026, 9, 25, 16, 41, 0);

const LOOKS: readonly ChatLook[] = ['clean', 'classic'];
const TENSES: readonly StepTense[] = [
  'done',
  'running',
  'failed',
  'blocked',
  'interrupted',
  'waiting',
];

function Readout({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <code className="rounded-md bg-depth px-2 py-1 font-mono text-2xs fg-secondary">
      {children}
    </code>
  );
}

// ---------------------------------------------------------------------------
// ChatLookProvider
// ---------------------------------------------------------------------------

function LookReadout(): JSX.Element {
  const look = useChatLook();
  const clean = useCleanChatLook();
  const badgeRows = useStepBadgeRows();
  return (
    <Readout>
      {`useChatLook: ${look} · useCleanChatLook: ${String(clean)} · useStepBadgeRows: ${String(badgeRows)}`}
    </Readout>
  );
}

function LookColumn({ look }: { readonly look: ChatLook }): JSX.Element {
  return (
    <ChatLookProvider value={look}>
      <div className="flex w-full min-w-0 flex-col gap-3">
        <LookReadout />
        <StepRow
          step
          label="Ran git status"
          detail="in the project root"
          icon={<PlanModeIcon size="sm" />}
        />
        <StepRow
          step
          running
          label="Reading file.ts"
          icon={<PlanModeIcon size="sm" />}
        />
        <TurnTimer
          startedAt={TURN_START}
          finishedAt={TURN_END}
          copyText="The change is ready for review."
          alwaysVisible
        />
        <div className="flex items-center gap-1">
          <ChatCopyAction text="The change is ready for review." />
          <span className="text-2xs fg-tertiary">
            {look === 'clean'
              ? 'Copy action: the shared ghost-quiet Button'
              : 'Copy action: the classic quiet button class'}
          </span>
        </div>
      </div>
    </ChatLookProvider>
  );
}

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
  clean,
}: {
  readonly detail: ChatDetail;
  readonly clean: boolean;
}): JSX.Element {
  const [complete, setComplete] = useState(false);
  const [collapsed, setCollapsed] = useTurnCollapse(complete, clean, detail);
  return (
    <div className="flex flex-col gap-2">
      <Readout>
        {`${clean ? 'clean' : 'classic'} · turn ${complete ? 'complete' : 'running'} · ${collapsed ? 'folded' : 'open'}`}
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
        <CollapseDemo detail={detail} clean />
        <CollapseDemo detail={detail} clean={false} />
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
      <SpecimenPanel title="ChatLookProvider: the same parts under each look">
        <SpecimenGrid min={320}>
          {LOOKS.map((look) => (
            <SpecimenCell
              key={look}
              label={
                look === 'clean'
                  ? 'clean: the one chat look'
                  : 'classic: retired, its parts stay until they are removed'
              }
            >
              <LookColumn look={look} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ChatDetailProvider: how much of the work shows">
        <SpecimenGrid min={280}>
          {CHAT_DETAILS.map((detail) => (
            <SpecimenCell key={detail} label={detail}>
              <DetailColumn detail={detail} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ChatAppNameProvider: the product name in resume markers">
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
      <SpecimenPanel title="StepTenseProvider and StepBadgeLine: a step in each tense">
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
                </div>
              </StepTenseProvider>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Inside a step row's badge line (clean look)">
            <ChatLookProvider value="clean">
              <StepBadgeLine>
                <BadgeReadout />
              </StepBadgeLine>
            </ChatLookProvider>
          </SpecimenCell>
          <SpecimenCell label="Outside a badge line: plain text, no badges">
            <ChatLookProvider value="clean">
              <BadgeReadout />
            </ChatLookProvider>
          </SpecimenCell>
          <SpecimenCell label="Classic look: never badges, even inside a line">
            <ChatLookProvider value="classic">
              <StepBadgeLine>
                <BadgeReadout />
              </StepBadgeLine>
            </ChatLookProvider>
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
    <div
      className={`flex h-12 max-w-full items-center gap-2 rounded-2xl bg-secondary px-3 ${
        narrow ? 'w-60' : 'w-160'
      }`}
    >
      {children}
    </div>
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

export function PlanChipSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="buildPlanModeChip, dismissible: shown only while Plan is on; click removes it">
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
      <SpecimenPanel title="buildPlanModeChip, toggle: stays mounted; click flips Plan">
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
      <SpecimenPanel title="buildQuestionReadyChip: a question waits with its prompt closed">
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
