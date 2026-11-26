'use client';

import { ListRowLinkFrame } from '../primitives/ListRow';
import { TextLink } from '../primitives/TextLink';
import {
  forwardRef,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ChevronDownIcon,
  ExternalIcon,
  GitMergeQueueIcon,
  WarningIcon,
} from '../icons/AppIcons';
import { EmptyStateText } from '../primitives/StatusBlocks';
import { formatRelativeTime } from '../lib/format-relative-time';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import {
  formatEstimateClock,
  formatEstimateMinutes,
  mergeQueueStep,
  type MergeQueueEntryPhase,
  type MergeQueueLabel,
  type MergeQueueStep,
} from '../lib/merge-queue-display';
import { ControlButton, Button } from '../primitives/Button';
import { FloatingMenu } from '../primitives/FloatingMenu';
import { Notice } from '../primitives/Notice';
import { RunSpinner } from './RunSpinner';
import { Stack } from '../primitives/Stack';

/** One pull request in a queue list. */
export interface MergeQueuePopoverEntry {
  readonly position: number;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** Author login; null when GitHub withheld it. */
  readonly author: string | null;
  readonly phase: MergeQueueEntryPhase;
  /** Seconds left, already counted down; null without an estimate. */
  readonly remainingSeconds: number | null;
  /** The worktree's own pull request. */
  readonly isCurrent: boolean;
}

export type MergeQueuePopoverList =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      /** Pull requests in the queue; may exceed the loaded `entries`. */
      readonly totalCount: number;
      /** How many entries GitHub tests together; null when unknown. */
      readonly buildCount: number | null;
      readonly entries: readonly MergeQueuePopoverEntry[];
    };

/** One queue the worktree has a pull request in. */
export interface MergeQueuePopoverSection {
  readonly key: string;
  /** Shown only when the popover lists several queues. */
  readonly repoName: string;
  readonly baseBranch: string;
  readonly phase: MergeQueueEntryPhase | undefined;
  readonly position: number | null;
  /** The worktree pull request's seconds left; null without an estimate. */
  readonly remainingSeconds: number | null;
  readonly list: MergeQueuePopoverList;
  /** The queue's page on GitHub. */
  readonly queueUrl: string | null;
}

export interface MergeQueueStatusProps {
  readonly label: MergeQueueLabel;
  readonly sections: readonly MergeQueuePopoverSection[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Clock for "around HH:MM" and "Updated" (epoch ms); the host ticks it. */
  readonly now: number;
  /** When the lists were last read (epoch ms); null before the first read. */
  readonly updatedAt: number | null;
  /**
   * Display classes for the label's position segment (default
   * `inline-flex`). A host with a narrow tier (the desktop header) hides it
   * there and keeps the estimate.
   */
  readonly positionClassName?: string;
  readonly 'data-testid'?: string;
}

type Tone = 'pending' | 'merging';

/** Rows shown after the worktree's own row before "Show more". */
const ROWS_AFTER_CURRENT = 2;

function Separator(): JSX.Element {
  return (
    <span aria-hidden="true" className="fg-quaternary">
      ·
    </span>
  );
}

function SpinnerGlyph(): JSX.Element {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <RunSpinner />
    </span>
  );
}

function stepLabel(step: MergeQueueStep): string {
  switch (step) {
    case 'queued':
      return 'Queued';
    case 'testing':
      return 'Testing';
    case 'merging':
      return 'Merging';
  }
}

function pluralPullRequests(count: number): string {
  return `${count} pull ${count === 1 ? 'request' : 'requests'}`;
}

function listNumbers(
  numbers: readonly number[],
  conjunction: 'and' | 'or',
): string {
  const refs = numbers.map((number) => `#${number}`);
  if (refs.length <= 1) return refs.join('');
  return `${refs.slice(0, -1).join(', ')} ${conjunction} ${refs[refs.length - 1]}`;
}

interface LabelParts {
  readonly tone: Tone;
  readonly glyph: 'merge' | 'spinner' | 'warning';
  readonly text: string;
  readonly position: number | null;
  readonly remainingSeconds: number | null;
  readonly accessibleName: string;
}

function labelParts(label: MergeQueueLabel): LabelParts {
  const eta = (seconds: number | null): string =>
    seconds === null ? '' : `, about ${formatEstimateMinutes(seconds)}`;
  switch (label.kind) {
    case 'queued':
      return {
        tone: 'pending',
        glyph: 'merge',
        text: 'Queued',
        position: label.position,
        remainingSeconds: label.remainingSeconds,
        accessibleName: `Queued in the merge queue${
          label.position === null ? '' : `, position ${label.position}`
        }${eta(label.remainingSeconds)}`,
      };
    case 'testing':
      return {
        tone: 'pending',
        glyph: 'spinner',
        text: 'Testing',
        position: null,
        remainingSeconds: label.remainingSeconds,
        accessibleName: `Testing in the merge queue${eta(label.remainingSeconds)}`,
      };
    case 'merging':
      return {
        tone: 'merging',
        glyph: 'spinner',
        text: 'Merging now',
        position: null,
        remainingSeconds: null,
        accessibleName: 'Merging now from the merge queue',
      };
    case 'blocked':
      return {
        tone: 'pending',
        glyph: 'warning',
        text: "Can't merge from queue",
        position: null,
        remainingSeconds: null,
        accessibleName: "Can't merge from queue",
      };
    case 'several':
      return {
        tone: 'pending',
        glyph: 'merge',
        text: `${label.count} queued`,
        position: null,
        remainingSeconds: label.remainingSeconds,
        accessibleName: `${label.count} queued: ${label.count} pull requests in merge queues${
          label.remainingSeconds === null
            ? ''
            : `, all merged in about ${formatEstimateMinutes(label.remainingSeconds)}`
        }`,
      };
  }
}

interface MergeQueueStatusTriggerProps {
  readonly label: MergeQueueLabel;
  readonly open: boolean;
  readonly controlsId: string;
  readonly onToggle: () => void;
  readonly positionClassName?: string;
  readonly 'data-testid'?: string;
}

const MergeQueueStatusTrigger = forwardRef<
  HTMLButtonElement,
  MergeQueueStatusTriggerProps
>(function MergeQueueStatusTrigger(
  {
    label,
    open,
    controlsId,
    onToggle,
    positionClassName = 'inline-flex',
    'data-testid': testId,
  },
  ref,
): JSX.Element {
  const parts = labelParts(label);

  return (
    <ControlButton
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      aria-label={parts.accessibleName}
      data-testid={testId}
      data-merge-queue-label={label.kind}
      onClick={onToggle}
      presentation="merge-queue-trigger"
      appearance={{ tone: parts.tone, open }}
    >
      {parts.glyph === 'merge' && (
        <GitMergeQueueIcon size="sm" className="shrink-0" />
      )}
      {parts.glyph === 'spinner' && <SpinnerGlyph />}
      {parts.glyph === 'warning' && (
        <WarningIcon size={16} className="shrink-0" />
      )}
      <span>{parts.text}</span>
      {parts.position !== null && (
        <span
          className={`${positionClassName} items-center gap-1.5`}
          data-testid={testId ? `${testId}-position` : undefined}
        >
          <Separator />
          <span className="tabular-nums">#{parts.position}</span>
        </span>
      )}
      {parts.remainingSeconds !== null && (
        <>
          <Separator />
          <span
            className="tabular-nums fg-primary"
            data-testid={testId ? `${testId}-eta` : undefined}
          >
            ~{formatEstimateMinutes(parts.remainingSeconds)}
          </span>
        </>
      )}
      <ChevronDownIcon size={12} className="shrink-0 fg-tertiary" />
    </ControlButton>
  );
});

function PhaseStrip({
  step,
  position,
}: {
  readonly step: MergeQueueStep;
  readonly position: number | null;
}): JSX.Element {
  const steps: readonly MergeQueueStep[] = ['queued', 'testing', 'merging'];
  const current = steps.indexOf(step);
  return (
    <ol className="grid grid-cols-3 gap-1 text-xs" aria-label="Queue phase">
      {steps.map((item, index) => (
        <li
          key={item}
          className="flex min-w-0 flex-col gap-1.5"
          aria-current={index === current ? 'step' : undefined}
        >
          <span
            aria-hidden="true"
            className={`block h-0.75 rounded-full ${
              index < current
                ? 'bg-warning opacity-45'
                : index === current
                  ? 'bg-warning'
                  : 'bg-line-secondary'
            }`}
          />
          <span
            className={`block truncate ${
              index === current
                ? 'fg-primary'
                : index < current
                  ? 'fg-secondary'
                  : 'fg-tertiary'
            }`}
          >
            {stepLabel(item)}
            {index === current && item === 'queued' && position !== null
              ? `, #${position}`
              : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function QueueRow({
  entry,
}: {
  readonly entry: MergeQueuePopoverEntry;
}): JSX.Element {
  return (
    <ListRowLinkFrame
      layout={entry.isCurrent ? 'queue-position-current' : 'queue-position'}
      href={entry.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-current={entry.isCurrent ? 'true' : undefined}
      data-testid="merge-queue-popover-row"
      data-pr-number={entry.number}
    >
      <span
        className={`text-right font-mono text-2xs tabular-nums ${
          entry.isCurrent ? 'fg-warning' : 'fg-tertiary'
        }`}
      >
        {entry.position}
      </span>
      <span className="min-w-0">
        <span
          className="block truncate text-xs fg-primary"
          title={entry.title || `#${entry.number}`}
        >
          {entry.title || `#${entry.number}`}
        </span>
        <span className="block truncate text-2xs fg-tertiary">
          <span className="font-mono">#{entry.number}</span>
          {entry.isCurrent ? (
            <>
              {' · '}
              <span className="fg-warning">This pull request</span>
            </>
          ) : entry.author !== null ? (
            <>
              {' · '}
              <span className={REPLAY_BLOCK_CLASS}>{entry.author}</span>
            </>
          ) : null}
        </span>
      </span>
      <span
        className={`font-mono text-2xs tabular-nums ${
          entry.isCurrent ? 'fg-warning' : 'fg-secondary'
        }`}
      >
        {entry.remainingSeconds === null
          ? ''
          : formatEstimateMinutes(entry.remainingSeconds)}
      </span>
    </ListRowLinkFrame>
  );
}

function GroupLabel({
  children,
  trailing,
}: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between px-2 pt-2 pb-1 text-2xs fg-tertiary">
      <span>{children}</span>
      {trailing !== undefined && <span>{trailing}</span>}
    </div>
  );
}

function QueueList({
  list,
  collapsible,
}: {
  readonly list: MergeQueuePopoverList;
  readonly collapsible: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (list.status === 'loading') {
    return (
      <div
        role="status"
        className="flex h-24 items-center px-2 text-xs fg-tertiary"
        data-testid="merge-queue-popover-loading"
      >
        Loading the queue…
      </div>
    );
  }
  if (list.status === 'error') {
    return (
      <Notice
        intent="destructive"
        shape="menu"
        surface="none"
        errorSource="merge-queue-popover"
        data-testid="merge-queue-popover-error"
      >
        Couldn't load the queue.
      </Notice>
    );
  }
  if (list.entries.length === 0) {
    return (
      <div className="px-2 py-3 text-xs fg-secondary">
        No pull requests in the queue right now.
      </div>
    );
  }
  const testing = list.entries.filter(
    (entry) => mergeQueueStep(entry.phase) !== 'queued',
  );
  const waiting = list.entries.filter(
    (entry) => mergeQueueStep(entry.phase) === 'queued',
  );
  const currentIndex = waiting.findIndex((entry) => entry.isCurrent);
  const collapsedCount = Math.max(currentIndex, 0) + ROWS_AFTER_CURRENT + 1;
  const visibleWaiting =
    expanded || !collapsible ? waiting : waiting.slice(0, collapsedCount);
  const hidden = waiting.length - visibleWaiting.length;
  const unloaded = list.totalCount - list.entries.length;
  return (
    <div data-testid="merge-queue-popover-list">
      {testing.length > 0 && (
        <>
          <GroupLabel
            trailing={
              list.buildCount === null
                ? undefined
                : `${list.buildCount} at a time`
            }
          >
            Testing now
          </GroupLabel>
          {testing.map((entry) => (
            <QueueRow key={entry.number} entry={entry} />
          ))}
        </>
      )}
      {waiting.length > 0 && (
        <>
          <GroupLabel>Waiting</GroupLabel>
          {visibleWaiting.map((entry) => (
            <QueueRow key={entry.number} entry={entry} />
          ))}
        </>
      )}
      {hidden > 0 && (
        <div className="px-2 py-1.5 text-2xs">
          <Button
            variant="link"
            onClick={() => setExpanded(true)}
            data-testid="merge-queue-popover-show-more"
          >
            Show {hidden} more
          </Button>
        </div>
      )}
      {(expanded || !collapsible || hidden === 0) && unloaded > 0 && (
        <div className="px-2 py-1.5 text-2xs fg-tertiary">
          {pluralPullRequests(unloaded)} more on GitHub
        </div>
      )}
    </div>
  );
}

function OpenQueueLink({
  url,
  label,
  iconOnly = false,
}: {
  readonly url: string;
  readonly label: string;
  readonly iconOnly?: boolean;
}): JSX.Element {
  return (
    <TextLink
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={iconOnly ? label : undefined}
      data-testid="merge-queue-popover-github"
      variant="merge-queue-github"
      iconOnly={iconOnly}
    >
      {iconOnly ? null : 'Open queue on GitHub'}
      <ExternalIcon size={12} className="fg-secondary" />
    </TextLink>
  );
}

/** The note under the estimate while the pull request is in a merge group. */
function testingNote(section: MergeQueuePopoverSection): string | null {
  if (section.list.status !== 'ready') return null;
  const current = section.list.entries.find((entry) => entry.isCurrent);
  if (!current) return null;
  const others = section.list.entries.filter(
    (entry) => !entry.isCurrent && mergeQueueStep(entry.phase) === 'testing',
  );
  if (others.length === 0) return null;
  const ahead = others
    .filter((entry) => entry.position < current.position)
    .map((entry) => entry.number);
  const named =
    others.length <= 3
      ? listNumbers(
          others.map((entry) => entry.number),
          'and',
        )
      : pluralPullRequests(others.length);
  const running = `Checks are running with ${named}.`;
  if (ahead.length === 0) return running;
  return `${running} If ${
    ahead.length <= 3 ? listNumbers(ahead, 'or') : 'one ahead of it'
  } fails, this pull request is tested again.`;
}

function EstimateHeadline({
  remainingSeconds,
  step,
  now,
}: {
  readonly remainingSeconds: number | null;
  readonly step: MergeQueueStep;
  readonly now: number;
}): JSX.Element {
  if (step === 'merging') {
    return <div className="text-m font-medium fg-primary">Merging now</div>;
  }
  if (remainingSeconds === null) {
    return (
      <div className="text-m font-medium">
        <EmptyStateText title="No estimate yet" tone="secondary" />
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="text-m font-medium tabular-nums fg-primary"
        data-testid="merge-queue-popover-eta"
      >
        About {formatEstimateMinutes(remainingSeconds)}
      </span>
      <span className="text-xs tabular-nums fg-secondary">
        around {formatEstimateClock(remainingSeconds, now)}
      </span>
    </div>
  );
}

function SingleQueue({
  section,
  now,
}: {
  readonly section: MergeQueuePopoverSection;
  readonly now: number;
}): JSX.Element {
  const step = mergeQueueStep(section.phase);
  const note = step === 'testing' ? testingNote(section) : null;
  return (
    <>
      <div className="px-2 pt-2 pb-3">
        <Stack gap="item">
          <Stack gap="inline">
            <div className="flex items-center justify-between gap-3 text-2xs fg-secondary">
              <span className="min-w-0 truncate" title={section.baseBranch}>
                Merge queue <Separator />{' '}
                <span className="font-mono fg-primary">
                  {section.baseBranch}
                </span>
              </span>
              {section.list.status === 'ready' && (
                <span className="shrink-0 tabular-nums">
                  {pluralPullRequests(section.list.totalCount)}
                </span>
              )}
            </div>
            <div>
              <EstimateHeadline
                remainingSeconds={section.remainingSeconds}
                step={step}
                now={now}
              />
              {note !== null && (
                <p
                  className="mt-0.5 text-xs text-pretty fg-secondary"
                  data-testid="merge-queue-popover-testing-note"
                >
                  {note}
                </p>
              )}
            </div>
          </Stack>
          <PhaseStrip step={step} position={section.position} />
        </Stack>
      </div>
      <div className="-mx-1 border-t border-line-base" />
      <div className="max-h-80 overflow-y-auto py-1">
        <QueueList list={section.list} collapsible />
      </div>
    </>
  );
}

function SeveralQueues({
  sections,
  now,
}: {
  readonly sections: readonly MergeQueuePopoverSection[];
  readonly now: number;
}): JSX.Element {
  const estimates = sections.map((section) => section.remainingSeconds);
  const latest = estimates.every(
    (estimate): estimate is number => estimate !== null,
  )
    ? sections.reduce((last, section) =>
        (section.remainingSeconds ?? 0) > (last.remainingSeconds ?? 0)
          ? section
          : last,
      )
    : null;
  return (
    <>
      <div className="px-2 pt-2 pb-3">
        <Stack gap="inline">
          <div className="text-2xs fg-secondary">
            {pluralPullRequests(sections.length)} in merge queues
          </div>
          {latest !== null && latest.remainingSeconds !== null && (
            <div>
              <div
                className="text-m font-medium tabular-nums fg-primary"
                data-testid="merge-queue-popover-eta"
              >
                All merged in about{' '}
                {formatEstimateMinutes(latest.remainingSeconds)}
              </div>
              <div className="mt-0.5 text-xs text-pretty tabular-nums fg-secondary">
                around {formatEstimateClock(latest.remainingSeconds, now)}, when
                the {latest.repoName} pull request lands
              </div>
            </div>
          )}
        </Stack>
      </div>
      <div className="-mx-1 max-h-105 overflow-y-auto">
        {sections.map((section) => {
          const step = mergeQueueStep(section.phase);
          return (
            <section
              key={section.key}
              aria-label={`${section.repoName} merge queue`}
              className="border-t border-line-base px-1 pb-1"
              data-testid="merge-queue-popover-section"
            >
              <div className="flex items-center justify-between gap-3 px-2 pt-2.5 pb-1 text-xs">
                <span className="min-w-0 truncate fg-primary">
                  {section.repoName} <Separator />{' '}
                  <span className="font-mono text-2xs fg-secondary">
                    {section.baseBranch}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 tabular-nums fg-secondary">
                  {stepLabel(step)}
                  {step === 'queued' && section.position !== null
                    ? `, #${section.position}`
                    : ''}
                  {section.remainingSeconds !== null && step !== 'merging' && (
                    <>
                      {' '}
                      <Separator />{' '}
                      <span className="fg-primary">
                        About {formatEstimateMinutes(section.remainingSeconds)}
                      </span>
                    </>
                  )}
                  {section.queueUrl !== null && (
                    <OpenQueueLink
                      url={section.queueUrl}
                      label={`Open the ${section.repoName} queue on GitHub`}
                      iconOnly
                    />
                  )}
                </span>
              </div>
              <QueueList list={section.list} collapsible />
            </section>
          );
        })}
      </div>
    </>
  );
}

/**
 * The PR bar's merge queue label and the popover it opens: when the pull
 * request lands, what can still push it back, and who is ahead. Hosts read
 * the queue only while the popover is open and pass the lists in.
 */
export function MergeQueueStatus({
  label,
  sections,
  open,
  onOpenChange,
  now,
  updatedAt,
  positionClassName,
  'data-testid': testId = 'merge-queue-status',
}: MergeQueueStatusProps): JSX.Element {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [single] = sections;
  const several = sections.length > 1;
  return (
    <>
      <MergeQueueStatusTrigger
        ref={triggerRef}
        label={label}
        open={open}
        controlsId={popoverId}
        onToggle={() => onOpenChange(!open)}
        positionClassName={positionClassName}
        data-testid={testId}
      />
      <FloatingMenu
        id={popoverId}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={triggerRef}
        placement="bottom-right"
        interaction="manual"
        trapFocus
        initialFocusRef={headerRef}
        role="dialog"
        aria-label="Merge queue"
        data-testid={`${testId}-popover`}
        className="flex w-100 flex-col"
      >
        <div ref={headerRef} tabIndex={-1} className="outline-none">
          {several ? (
            <SeveralQueues sections={sections} now={now} />
          ) : single ? (
            <SingleQueue section={single} now={now} />
          ) : null}
        </div>
        <div className="-mx-1 -mb-1 flex items-center justify-between border-t border-line-base py-1.5 pr-1.5 pl-3 text-2xs fg-tertiary">
          <span className="tabular-nums" data-testid={`${testId}-updated`}>
            {updatedAt === null
              ? ''
              : `Updated ${formatRelativeTime(updatedAt, now)}`}
          </span>
          {!several && single?.queueUrl ? (
            <OpenQueueLink url={single.queueUrl} label="Open queue on GitHub" />
          ) : null}
        </div>
      </FloatingMenu>
    </>
  );
}
