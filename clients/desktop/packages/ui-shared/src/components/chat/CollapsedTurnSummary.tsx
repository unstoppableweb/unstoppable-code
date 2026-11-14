import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  forwardRef,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import {
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClaudeLogo,
  DocumentIcon,
  DocumentSearchIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  MessageIcon,
  PipelineIcon,
  PlanModeIcon,
  TerminalBorderedIcon,
  TerminalIcon,
  AgentIcon,
  QuestionMarkIcon,
  TaskIcon,
  WrenchIcon,
} from '../../icons';
import {
  DocumentPencilIcon,
  LightbulbIcon,
  PickIcon,
} from '../../icons/AppIcons';
import type {
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
} from '@canopy/protocol/portal';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { useIsPhone } from '../useMediaQuery';
import { describeStepCounts, type StepKind } from './step-words';
import { TurnOutcomeTooltip } from './TurnOutcomeTooltip';
import { TurnOutcomeWords } from './TurnOutcomeWords';
import {
  formatTurnOutcomeLabel,
  turnOutcomeEntries,
} from './turn-outcome-label';
import type { TurnCompletionStatus } from './turn-completion-status';
import { STEP_ROW_DETAIL_INK_CLASS } from './StepRow';
import { TurnWorkHeader } from './TurnWorkHeader';

/**
 * Tool-counts summary surfaced on collapsed turn groups. Mirrors the
 * `PortalChatTurnGroupEntity.summary` shape from `@canopy/protocol` so the
 * desktop and the web portal can pass the wire counts straight through.
 */
export interface TurnSummary {
  thinking?: number;
  messages?: number;
  bash?: number;
  read?: number;
  edit?: number;
  write?: number;
  plan?: number;
  grep?: number;
  glob?: number;
  todo?: number;
  web?: number;
  agent?: number;
  askUser?: number;
  scriptOutput?: number;
  claude?: number;
  watcher?: number;
  canopy?: number;
  graph?: number;
  appAdvisor?: number;
  pipelineEditor?: number;
  computerUse?: number;
  other?: number;
}

export interface CollapsedTurnSummaryProps {
  /** Aggregate tool counts produced by the host. */
  summary: TurnSummary;
  /** Whether the parent currently shows the expanded intermediate region. */
  isExpanded: boolean;
  /** Click handler. Hosts can leave this unset for read-only summaries. */
  onToggle?: () => void;
  /**
   * Optional host-provided branded app icon. Defaults to a neutral tool icon
   * because this shared package cannot know the active product brand.
   */
  appIcon?: ReactNode;
  /**
   * Optional wall-clock duration of the collapsed turn, in milliseconds.
   *
   * Deliberately a value, not a timer. Every host that could supply this
   * already owns the turn's start and end — the desktop transcript from its
   * turn records, the portal from the wire entity — and a clock started here
   * would be a second, disagreeing source of truth that also kept a collapsed
   * row re-rendering forever. Omit it and the row simply renders the step
   * count, which is what every current caller does.
   *
   * Non-finite or non-positive values render nothing rather than "0s" or
   * "NaNs", so a host can pass a computed difference through without guarding
   * it first.
   */
  elapsedMs?: number;
  /**
   * How the turn ended. The clean chat look's header says "Failed after …",
   * "Stopped after …" or "Interrupted after …" instead of "Worked for …".
   * Defaults to complete.
   */
  completionStatus?: TurnCompletionStatus;
  /**
   * How many counted steps a safety check blocked, ran into an error, or
   * were interrupted. Omit when the host has no outcome metadata; that is unknown, not
   * zero.
   */
  outcomes?: TurnOutcomeCounts;
  /**
   * The blocked, errored and interrupted steps behind `outcomes`, from loaded rows, for
   * the outcome tooltip. Omit when the rows aren't loaded; the tooltip then
   * says the counts only.
   */
  outcomeSteps?: readonly TurnOutcomeStepDetail[];
  /**
   * Bring an outcome step into view: the given one, or the first
   * affected step when `undefined`. Omit when the host can't reveal rows; the
   * outcome then only describes them.
   */
  onJumpToOutcome?: (toolUseId?: string) => void;
}

/**
 * One count chip of a collapsed turn summary. Hosts with their own tool
 * vocabulary (the desktop transcript) build these themselves; the key lands
 * on `data-tool-chip`.
 */
export interface TurnSummaryChip {
  key: string;
  icon: ReactNode;
  label: string;
  count: number;
}

function buildChips(
  summary: TurnSummary,
  appIcon?: ReactNode,
): TurnSummaryChip[] {
  const chips: TurnSummaryChip[] = [];
  const push = (
    key: keyof TurnSummary,
    icon: ReactNode,
    label: string,
  ): void => {
    const count = summary[key];
    if (count != null && count > 0) {
      chips.push({ key, icon, label, count });
    }
  };

  push('messages', <MessageIcon />, 'messages');
  push('thinking', <LightbulbIcon />, 'thinking');
  push('bash', <TerminalIcon />, 'bash');
  push('read', <DocumentIcon />, 'read');
  push('edit', <DocumentPencilIcon />, 'edit');
  push('write', <DocumentPencilIcon />, 'write');
  push('plan', <PlanModeIcon />, 'plan');
  push('grep', <DocumentSearchIcon />, 'grep');
  push('glob', <MagnifyingGlassIcon />, 'glob');
  push('todo', <TaskIcon />, 'todo');
  push('web', <GlobeIcon />, 'web');
  push('agent', <AgentIcon />, 'agents');
  push('askUser', <QuestionMarkIcon />, 'questions');
  push('scriptOutput', <TerminalBorderedIcon />, 'script output');
  push('claude', <ClaudeLogo />, 'claude');
  push('watcher', <AppAdvisorWatcherIcon />, 'watcher');
  push('canopy', appIcon ?? <WrenchIcon />, 'app');
  push('graph', <GraphIcon />, 'code graph');
  push('appAdvisor', <AppAdvisorIcon />, ORCHESTRATOR_LABEL.toLowerCase());
  push('pipelineEditor', <PipelineIcon />, 'workflow');
  push('computerUse', <PickIcon />, 'computer use');
  push('other', <WrenchIcon />, 'other');

  return chips;
}

const SUMMARY_STEP_KINDS: Partial<Record<keyof TurnSummary, StepKind>> = {
  thinking: 'thinking',
  bash: 'command',
  scriptOutput: 'command',
  read: 'read',
  edit: 'edit',
  write: 'edit',
  grep: 'search',
  glob: 'search',
  todo: 'tasks',
  web: 'web',
  graph: 'graph',
};

/** Every counted summary key, in chip order. Messages are not steps. */
const SUMMARY_STEP_ORDER: readonly (keyof TurnSummary)[] = [
  'thinking',
  'bash',
  'read',
  'edit',
  'write',
  'plan',
  'grep',
  'glob',
  'todo',
  'web',
  'agent',
  'askUser',
  'scriptOutput',
  'claude',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'computerUse',
  'other',
];

/**
 * A turn summary's steps by kind, in chip order, for the clean chat look's
 * plain-words row. Tools without a kind of their own count as "used N
 * tools".
 */
export function turnSummaryStepCounts(
  summary: TurnSummary,
): [StepKind, number][] {
  const counts: [StepKind, number][] = [];
  for (const key of SUMMARY_STEP_ORDER) {
    const count = summary[key] ?? 0;
    if (count > 0) counts.push([SUMMARY_STEP_KINDS[key] ?? 'other', count]);
  }
  return counts;
}

/**
 * The leading label for the row: "1 step", "4 steps", or "Agent steps".
 *
 * WHY ZERO IS NOT "0 steps". `buildChips` only emits a family with `count > 0`,
 * so `totalSteps` is `0` for any turn whose intermediate messages carry no
 * `tool_use` parts — a reasoning-only turn, most commonly. Those turns still
 * pass `hasCollapsibleIntermediate`, so this row renders on top of content that
 * genuinely does expand. Labelling it "0 steps" tells the reader there is
 * nothing behind the chevron and actively discourages the click. The neutral
 * label keeps the row legible (the reason the label exists at all) without
 * making a false claim about what it contains.
 *
 * PLURALISATION is a naive `s`, which is correct for this one noun; there is no
 * localisation layer in this package to defer to, and inventing one for a
 * single word would be worse than the honest limitation.
 */
export function formatStepCount(total: number): string {
  if (total === 0) {
    return 'Agent steps';
  }
  return `${total} ${total === 1 ? 'step' : 'steps'}`;
}

/** Whether a turn has any blocked, errored or interrupted step to report. */
export function hasTurnOutcomes(
  outcomes: TurnOutcomeCounts | undefined,
): boolean {
  return turnOutcomeEntries(outcomes).length > 0;
}

/** Shared and desktop chip keys with a plain-language step equivalent. */
const CHIP_STEP_KINDS: Partial<Record<string, StepKind>> = {
  ...SUMMARY_STEP_KINDS,
  agent: 'agent',
  askUser: 'question',
  writeEdit: 'edit',
  fileEdit: 'edit',
  fileAdd: 'edit',
  search: 'search',
  tasks: 'tasks',
};

function describeTurnSummaryChip(chip: TurnSummaryChip): string {
  const kind = CHIP_STEP_KINDS[chip.key];
  return kind
    ? describeStepCounts([[kind, chip.count]])
    : `${chip.count} ${chip.label}`;
}

/** The nonzero outcomes in words, blocked first: `1 blocked, 2 errors, 1 interrupted`. */
function formatTurnOutcomeWords(
  outcomes: TurnOutcomeCounts | undefined,
): string {
  return turnOutcomeEntries(outcomes)
    .map((entry) => formatTurnOutcomeLabel(entry.key, entry.count))
    .join(', ');
}

/**
 * The summary control's accessible name:
 * `Agent steps: Ran 4 commands, 1 blocked, 2 errors`. Outcomes follow the chips,
 * blocked first. With neither, the name is the bare `Agent steps`, never a
 * dangling colon.
 */
export function formatTurnSummaryAriaLabel(
  chips: readonly TurnSummaryChip[],
  outcomes?: TurnOutcomeCounts,
): string {
  const detail = [
    ...chips.map(describeTurnSummaryChip),
    ...turnOutcomeEntries(outcomes).map((entry) =>
      formatTurnOutcomeLabel(entry.key, entry.count),
    ),
  ].join(', ');
  return detail === '' ? 'Agent steps' : `Agent steps: ${detail}`;
}

export interface TurnOutcomeControlProps {
  outcomes?: TurnOutcomeCounts;
  /** Start with a `·` separator, for words that follow other words. */
  leadingSeparator?: boolean;
  /** The steps behind the counts, for the tooltip; omit when not loaded. */
  outcomeSteps?: readonly TurnOutcomeStepDetail[];
  /**
   * Bring a step into view: the given one, or the first affected step. When
   * omitted the control only describes the steps.
   */
  onJumpToOutcome?: (toolUseId?: string) => void;
}

/** Keys that move focus from the outcome button into its tooltip's entries. */
const OUTCOME_TOOLTIP_OPEN_KEYS: readonly string[] = ['ArrowDown'];

/**
 * "· 1 blocked · 2 errors · 1 interrupted": what went wrong in a finished
 * turn, said quietly in {@link TurnOutcomeWords}, the same words a run of
 * steps ends with. No glyph and no color: the words carry the meaning.
 *
 * The words are a control of their own beside the turn's
 * toggle, never inside it. Hover or keyboard focus shows
 * {@link TurnOutcomeTooltip}: which steps were blocked or ran into an error
 * and why. With `onJumpToOutcome` the words are a button that brings the
 * first affected step into view, and each tooltip entry brings its own;
 * ArrowDown moves into the entries. Without it the words are a focusable
 * span, so the tooltip stays reachable and nothing promises a jump.
 *
 * Jumping (or Escape) closes the tooltip until the pointer, focus or ArrowDown
 * brings it back, so focus is on the document before the host lands on the
 * row. Renders
 * nothing when the turn has no outcome to report.
 */
export function TurnOutcomeControl({
  outcomes,
  outcomeSteps,
  onJumpToOutcome,
  leadingSeparator = true,
}: TurnOutcomeControlProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const shownRef = useRef(false);
  if (!outcomes || !hasTurnOutcomes(outcomes)) return null;

  const words = formatTurnOutcomeWords(outcomes);
  const jump = (toolUseId?: string): void => {
    setDismissed(true);
    onJumpToOutcome?.(toolUseId);
  };
  const reopen = (): void => setDismissed(false);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The open keys reopen a surface Escape closed; the tooltip then opens
    // it and moves focus in.
    if (OUTCOME_TOOLTIP_OPEN_KEYS.includes(event.key)) {
      reopen();
      return;
    }
    // An interactive surface only handles Escape while focus is inside it;
    // from the trigger, close it here and keep focus where it is. Once
    // closed, Escape belongs to whoever handles it next.
    if (event.key !== 'Escape' || dismissed || !shownRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    setDismissed(true);
  };
  const triggerProps = {
    className: 'focus-ring rounded-sm whitespace-nowrap',
    'data-turn-outcomes': '',
    'data-turn-blocked': outcomes.blocked || undefined,
    'data-turn-failed': outcomes.failed || undefined,
    'data-turn-interrupted': outcomes.interrupted || undefined,
    'data-testid': 'turn-outcome-control',
    // The pointer coming back or focus arriving again reopens it; leaving
    // doesn't, or the surface would flash during its close grace period.
    onMouseEnter: reopen,
    onFocus: reopen,
    onKeyDown,
  };
  const content = (
    <TurnOutcomeWords outcomes={outcomes} leadingSeparator={leadingSeparator} />
  );
  const trigger = onJumpToOutcome ? (
    <button
      type="button"
      {...triggerProps}
      className={`${triggerProps.className} transition-colors hover:fg-secondary`}
      aria-label={`${words}, show steps`}
      onClick={(event): void => {
        event.stopPropagation();
        jump(undefined);
      }}
    >
      {content}
    </button>
  ) : (
    <span tabIndex={0} {...triggerProps}>
      {content}
    </span>
  );

  return (
    <span className={`inline-flex flex-shrink-0 ${STEP_ROW_DETAIL_INK_CLASS}`}>
      <RichHoverTooltip
        content={
          <TurnOutcomeTooltip
            outcomes={outcomes}
            steps={outcomeSteps}
            onSelectStep={onJumpToOutcome ? jump : undefined}
          />
        }
        deferUntilInteraction
        // Without a jump the entries are plain rows, and without loaded steps
        // there are only count sentences: a description to read, not a
        // surface to move into.
        interactive={
          onJumpToOutcome !== undefined && (outcomeSteps?.length ?? 0) > 0
        }
        containEvents
        open={dismissed ? false : undefined}
        onOpenChange={(open): void => {
          shownRef.current = open;
        }}
        triggerOpenKeys={OUTCOME_TOOLTIP_OPEN_KEYS}
        surfaceClassName="w-max min-w-45 max-w-80"
        triggerWrapperClassName="z-10 flex-shrink-0"
        dataTestId="turn-outcome-tooltip-surface"
      >
        {trigger}
      </RichHoverTooltip>
    </span>
  );
}

export interface CollapsedTurnSummaryRowProps {
  /** Whether the parent currently shows the expanded intermediate region. */
  isExpanded: boolean;
  /** Click handler. Hosts can leave this unset for read-only summaries. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Accessible name, conventionally `Agent steps: …`. */
  ariaLabel: string;
  /** Test ID hook for automation, on the toggle button. */
  dataTestId?: string;
  /**
   * Positioning classes only, such as `ml-auto`. The row has no surface of
   * its own, so hosts must not add a background, border, radius, or shadow.
   */
  className?: string;
  /**
   * Whether the row takes the 44px phone-tier touch target. Defaults to
   * `true`; the desktop transcript opts out to keep its existing geometry.
   */
  phoneTouchTarget?: boolean;
  /** The toggle's content after the chevron: the step-count words. */
  children: ReactNode;
  /**
   * A control of its own after the toggle, such as
   * {@link TurnOutcomeControl}. It sits above the toggle's stretched hit
   * area, so its clicks never toggle the turn.
   */
  outcome?: ReactNode;
  /** Content at the row's end, such as the count chips; clicks toggle. */
  trailing?: ReactNode;
}

/**
 * The clickable shell of a collapsed turn summary: the toggle button, its
 * chevron, and the common row layout, with an optional outcome control and
 * trailing chips beside the toggle. Hosts supply the accessible name and the
 * content, so desktop and shared chip vocabularies can differ while the
 * control itself is defined once.
 *
 * WHY THE TOGGLE IS NOT THE ROW. The outcome is a control of its own (a
 * click jumps to the errored step), and interactive content can't nest in a
 * button. So the row is a wrapper: the toggle's `::before` stretches its hit
 * area and focus ring over the whole row, the outcome sits above it, and the
 * chips (which keep their `title`s) pass their clicks to the toggle. The
 * forwarded ref is the wrapper, the element whose width the row takes.
 *
 * The row sits directly on the chat background: no fill, border, radius, or
 * shadow, at rest, hovered, or expanded. Hover lifts the foreground instead,
 * and keyboard focus draws the shared `focus-ring` outline.
 */
export const CollapsedTurnSummaryRow = forwardRef<
  HTMLDivElement,
  CollapsedTurnSummaryRowProps
>(function CollapsedTurnSummaryRow(
  {
    isExpanded,
    onClick,
    ariaLabel,
    dataTestId,
    className = '',
    phoneTouchTarget = true,
    children,
    outcome,
    trailing,
  },
  ref,
): JSX.Element {
  // PHONE-TIER TOUCH TARGET. The compact `py-2` row is a ~30px tap target,
  // below the 44px floor the rest of the phone surface holds itself to, and it
  // is one of the few controls in a transcript a thumb actually has to hit.
  // Gated on the phone tier rather than on `pointer-coarse` so a touchscreen
  // laptop keeps the dense transcript it has room for.
  //
  // The gate is viewport-based, not host-based. The desktop main window sets
  // `minWidth: 800` (`apps/desktop-app/src/main/index.ts`), so the Code tab —
  // which reaches this component through `packages/ui-app`'s `TurnGroupView` —
  // never matches and keeps its dense row. The App Advisor popout can go down
  // to `APP_ADVISOR_MIN_WIDTH = 360`, where the larger target is wanted for the
  // same thumb-reach reason. See the matching note in `UserBubble`.
  const isPhone = useIsPhone();
  const toggleRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      ref={ref}
      data-turn-summary-row=""
      className={`relative flex w-full items-center gap-3 px-3 py-2 text-xs fg-secondary transition-colors hover:fg-primary${
        className === '' ? '' : ` ${className}`
      }${phoneTouchTarget && isPhone ? ' min-h-11' : ''}`}
    >
      <button
        ref={toggleRef}
        type="button"
        onClick={onClick}
        aria-expanded={isExpanded}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className="focus-ring focus-ring-stretched flex flex-shrink-0 items-center gap-3 text-left before:absolute before:inset-0 before:content-['']"
      >
        <span className="flex-shrink-0 fg-secondary" aria-hidden="true">
          {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        {children}
      </button>
      {outcome}
      {trailing != null && (
        // Pointer clicks on the chips toggle the turn; keyboard and screen
        // readers use the toggle itself, so this span needs no role or keys.
        <span
          className="relative flex items-center gap-3"
          data-turn-summary-trailing=""
          onClick={(): void => toggleRef.current?.click()}
        >
          {trailing}
        </span>
      )}
    </div>
  );
});

/**
 * Pure display summary of a collapsed turn: a step count, an optional elapsed
 * time, and the per-tool-family count chips. Click toggles a parent's expanded
 * state via `onToggle`. State is owned by the caller so this stays a leaf
 * component.
 *
 * WHY THERE IS A TEXT LABEL AT ALL. This row used to be chips and nothing
 * else, so a turn that ran one tool rendered as a ~30px strip reading "wrench
 * 1" — an unlabelled glyph next to a bare integer, with the entire meaning
 * carried by an `aria-label` that a sighted user never sees. Leading with "4
 * steps · 12s" makes the row legible at a glance, and the chips become the
 * detail behind the summary rather than the whole of it. The chips, the
 * `aria-label`, the `data-tool-chip` keys, and `dataTestId` are all unchanged:
 * desktop UI automation selects on them.
 */
export function CollapsedTurnSummary({
  summary,
  isExpanded,
  onToggle,
  appIcon,
  elapsedMs,
  completionStatus = 'complete',
  outcomes,
  outcomeSteps,
  onJumpToOutcome,
}: CollapsedTurnSummaryProps): JSX.Element {
  const chips = buildChips(summary, appIcon);
  const ariaLabel = formatTurnSummaryAriaLabel(chips, outcomes);

  // Clean chat look: the finished turn's header, "Worked for 3m 24s", opens
  // the steps; what they did reads as words on hover.
  return (
    <TurnWorkHeader
      elapsedMs={elapsedMs}
      live={false}
      completionStatus={completionStatus}
      expandable
      isOpen={isExpanded}
      onToggle={onToggle}
      ariaLabel={ariaLabel}
      title={describeStepCounts(turnSummaryStepCounts(summary)) || undefined}
      stepCount={chips.reduce((total, chip) => total + chip.count, 0)}
      outcome={
        hasTurnOutcomes(outcomes) ? (
          <TurnOutcomeControl
            outcomes={outcomes}
            outcomeSteps={outcomeSteps}
            onJumpToOutcome={onJumpToOutcome}
          />
        ) : undefined
      }
      dataTestId="turn-work-header"
    />
  );
}
