'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Button,
  ControlButton,
  DetailMoreMenu,
  Disclosure,
  Divider,
  EmptyState,
  Notice,
  Surface,
  Tooltip,
  type DetailMoreMenuItem,
} from '@canopy/ui-shared/components';
import {
  ChevronDownMediumIcon,
  ChevronTopMediumIcon,
  PipelineIcon,
  PlayIcon,
  PlusIcon,
  SplitIcon,
  TrashIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_DESIGNER_ACTIONS,
  workflowStepDisplay,
  type WorkflowDesignerActionKind,
  type WorkflowStepChoice,
} from './step-catalog';
import { WorkflowStepPicker } from './WorkflowStepPicker';
import type { WorkflowDesignerEntry } from './WorkflowTriggerPanel';

// The designer's own structural model. The host passes a pipeline projection
// that matches it; the designer never reads a pipeline document itself.

export interface WorkflowDesignerStepCard {
  readonly kind: 'step';
  readonly key: string;
  readonly jobId: string;
  readonly stepIndex: number;
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly script: boolean;
  readonly condition?: string;
  readonly jobCondition?: string;
  /** The router of a split drawn as paths, which only split edits change. */
  readonly split?: true;
}

export interface WorkflowDesignerEmptyJob {
  readonly kind: 'empty-job';
  readonly key: string;
  readonly jobId: string;
  readonly name: string;
  readonly jobCondition?: string;
}

export interface WorkflowDesignerColumn {
  readonly key: string;
  readonly label: string;
  readonly jobIds: readonly string[];
  readonly nodes: readonly WorkflowDesignerNode[];
}

export interface WorkflowDesignerParallel {
  readonly kind: 'parallel';
  readonly key: string;
  readonly columns: readonly WorkflowDesignerColumn[];
}

export interface WorkflowDesignerPath {
  readonly key: string;
  /** The route's label: authored text. */
  readonly label: string;
  readonly jobId: string;
  readonly nodes: readonly WorkflowDesignerNode[];
}

/** A split's paths side by side, after its router's card. */
export interface WorkflowDesignerPaths {
  readonly kind: 'paths';
  readonly key: string;
  readonly jobId: string;
  readonly routerStepIndex: number;
  readonly paths: readonly WorkflowDesignerPath[];
  /** The router has nothing to decide on yet. */
  readonly missingInput: boolean;
}

export type WorkflowDesignerUnsupportedReason =
  | 'matrix'
  | 'condition'
  | 'graph'
  | 'invalid'
  | 'size';

/** A job in a group, with its steps (CAN-4224 phase 08). */
export interface WorkflowDesignerGroupJob {
  readonly jobId: string;
  /** Its steps edit as any card's do, and its settings from its name. */
  readonly editable: boolean;
  /** Authored. */
  readonly name: string;
  /** The names of the jobs it waits for: authored. */
  readonly after: readonly string[];
  readonly condition?: string;
  readonly cycle?: true;
  readonly matrix?: true;
  readonly unreadableSteps?: true;
  readonly nodes: readonly (
    | WorkflowDesignerStepCard
    | WorkflowDesignerEmptyJob
  )[];
}

export interface WorkflowDesignerUnsupported {
  readonly kind: 'unsupported';
  readonly key: string;
  readonly jobIds: readonly string[];
  readonly jobNames: readonly string[];
  readonly reason: WorkflowDesignerUnsupportedReason;
  /**
   * Its jobs in dependency layers, each with its steps, so nothing is hidden.
   * Empty only for a workflow too large to project.
   */
  readonly layers: readonly (readonly WorkflowDesignerGroupJob[])[];
}

/**
 * An automation's one action (CAN-4224 phase 06): a card the host builds
 * from its own record, with the host's selection, never a pipeline step.
 */
export interface WorkflowDesignerAction {
  readonly kind: 'action';
  readonly key: string;
  readonly action: WorkflowDesignerActionKind;
  /** What it does, as a prompt's first line or a workflow's name: authored. */
  readonly title: string;
  /** Where it does it, as a project's name: authored. */
  readonly detail?: string;
  readonly selected: boolean;
  /** Opens its panel; absent when there is nothing to open. */
  readonly onSelect?: () => void;
  /** What it points at, opened from a link under the card. */
  readonly link?: {
    readonly label: string;
    readonly onOpen: () => void;
  };
  /** Why nothing can follow it: the "+" after it shows disabled, with this. */
  readonly addBlockedReason?: string;
}

export type WorkflowDesignerNode =
  | WorkflowDesignerAction
  | WorkflowDesignerStepCard
  | WorkflowDesignerEmptyJob
  | WorkflowDesignerParallel
  | WorkflowDesignerPaths
  | WorkflowDesignerUnsupported;

export type WorkflowDesignerSelection =
  | { readonly type: 'none' }
  | { readonly type: 'job'; readonly jobId: string }
  | {
      readonly type: 'step';
      readonly jobId: string;
      readonly stepIndex: number;
    };

/** The stack's first card: how the workflow starts (CAN-4224 phase 04). */
export interface WorkflowDesignerTriggerCard {
  /** "Run · Approved plan", or "Choose a trigger" for a new workflow. */
  readonly title: string;
  /** Its schedules, as "2 schedules". */
  readonly detail?: string;
  readonly selected: boolean;
  /** Opens its panel; absent when the workflow is read-only. */
  readonly onSelect?: () => void;
  /** Closes the trigger's panel, from Escape in the stack. */
  readonly onDismiss: () => void;
  /** Steps that run for one entry only, by card key. */
  readonly stepEntries: ReadonlyMap<string, WorkflowDesignerEntry>;
}

export interface WorkflowDesignerProps {
  readonly stack: { readonly nodes: readonly WorkflowDesignerNode[] };
  readonly selection: WorkflowDesignerSelection;
  /**
   * Select a card to open its panel. Absent when the workflow is read-only:
   * its cards are then shown disabled, with nothing to open.
   */
  readonly onSelectStep?: (jobId: string, stepIndex: number) => void;
  readonly onSelectJob?: (jobId: string) => void;
  readonly onClearSelection: () => void;
  /**
   * Opens the YAML view, for shapes the stack shows read-only. Omitted for a
   * read-only workflow, which has no YAML view to edit in.
   */
  readonly onEditInYaml?: () => void;
  /**
   * Structural edits (CAN-4224 phase 02). Omitted when the workflow is
   * read-only: the designer then offers no "+" buttons or card menus.
   */
  readonly editing?: WorkflowDesignerEditing;
  /** Why the host refused the last edit, shown above the stack. */
  readonly notice?: {
    readonly message: string;
    readonly onDismiss: () => void;
  };
  /** The trigger card, shown first when the host provides one. */
  readonly trigger?: WorkflowDesignerTriggerCard;
}

export interface WorkflowDesignerEditing {
  /** Adds the chosen step to `jobId` at `index`. */
  readonly onInsertStep: (
    jobId: string,
    index: number,
    choice: WorkflowStepChoice,
  ) => void;
  readonly onRemoveStep: (jobId: string, stepIndex: number) => void;
  readonly onMoveStep: (jobId: string, from: number, to: number) => void;
  /** Adds the chosen step to a workflow that has none. */
  readonly onAddFirstStep: (choice: WorkflowStepChoice) => void;
  /**
   * Jobs that can end in paths. The "+" after such a job's last step also
   * offers "Split into paths", which reaches `onInsertStep` as a `split`.
   */
  readonly splittableJobs?: ReadonlySet<string>;
  readonly onAddPath: (jobId: string) => void;
  readonly onRemovePath: (jobId: string, pathJobId: string) => void;
  /** Removes a split, keeping `keepPathJobId`'s steps when it names one. */
  readonly onRemoveSplit: (jobId: string, keepPathJobId?: string) => void;
}

// What sets a group's jobs apart from the stack around it.
const UNSUPPORTED_REASON: Readonly<
  Record<WorkflowDesignerUnsupportedReason, string>
> = {
  matrix: 'Runs once for each matrix combination.',
  condition: 'Runs only when its condition is met.',
  graph: 'Each job runs once the jobs it waits for have finished.',
  invalid: 'Has a dependency or action the Designer can’t read.',
  size: 'Has too many jobs for the Designer to show.',
};

/** Groups that need fixing in YAML, rather than a different layout. */
const BROKEN: ReadonlySet<WorkflowDesignerUnsupportedReason> = new Set([
  'invalid',
  'size',
]);

/** Parallel groups wider than this start collapsed, listing their members. */
const COLLAPSE_GROUP_AFTER = 3;

const CARD_SELECTOR = '[data-workflow-card]';
/** A card's More actions button, which can open its job's settings. */
const CARD_MENU_SELECTOR = '[data-testid="workflow-designer-card-more"]';
/** The trigger card's `data-workflow-card`, beside the numbered cards. */
const TRIGGER_CARD = 'trigger';

function cardKeyOf(selection: WorkflowDesignerSelection): string | null {
  if (selection.type === 'step')
    return `step:${selection.jobId}:${String(selection.stepIndex)}`;
  if (selection.type === 'job') return `job:${selection.jobId}`;
  return null;
}

function containsKey(
  nodes: readonly WorkflowDesignerNode[],
  key: string | null,
): boolean {
  return nodes.some((node) =>
    node.kind === 'parallel'
      ? node.columns.some((column) => containsKey(column.nodes, key))
      : node.kind === 'paths'
        ? node.paths.some((path) => containsKey(path.nodes, key))
        : node.kind === 'unsupported'
          ? node.layers.some((layer) =>
              layer.some(
                (job) =>
                  `job:${job.jobId}` === key || containsKey(job.nodes, key),
              ),
            )
          : node.key === key ||
            // A job's settings belong to the column that holds its cards.
            (node.kind === 'step' && `job:${node.jobId}` === key),
  );
}

/** Numbers every card in reading order, columns left to right. */
function numberCards(
  nodes: readonly WorkflowDesignerNode[],
  numbers: Map<string, number> = new Map(),
): Map<string, number> {
  for (const node of nodes) {
    if (
      node.kind === 'step' ||
      node.kind === 'empty-job' ||
      node.kind === 'action'
    ) {
      numbers.set(node.key, numbers.size + 1);
    } else if (node.kind === 'parallel') {
      for (const column of node.columns) numberCards(column.nodes, numbers);
    } else if (node.kind === 'paths') {
      for (const path of node.paths) numberCards(path.nodes, numbers);
    } else if (node.kind === 'unsupported') {
      for (const layer of node.layers)
        for (const job of layer) numberCards(job.nodes, numbers);
    }
  }
  return numbers;
}

/**
 * Each group job's settings button by its selection key, as `job-N`: never
 * the key itself, whose authored job ID session replay would record.
 */
function numberGroupJobs(
  nodes: readonly WorkflowDesignerNode[],
  marks: Map<string, string> = new Map(),
): Map<string, string> {
  for (const node of nodes) {
    if (node.kind === 'unsupported') {
      for (const layer of node.layers)
        for (const job of layer)
          if (job.editable)
            marks.set(`job:${job.jobId}`, `job-${String(marks.size + 1)}`);
    } else if (node.kind === 'parallel') {
      for (const column of node.columns) numberGroupJobs(column.nodes, marks);
    }
  }
  return marks;
}

/** How many step cards each job shows, so a card knows its job's length. */
function countJobSteps(
  nodes: readonly WorkflowDesignerNode[],
  counts: Map<string, number> = new Map(),
): Map<string, number> {
  for (const node of nodes) {
    if (node.kind === 'step')
      counts.set(
        node.jobId,
        Math.max(counts.get(node.jobId) ?? 0, node.stepIndex + 1),
      );
    else if (node.kind === 'parallel')
      for (const column of node.columns) countJobSteps(column.nodes, counts);
    else if (node.kind === 'paths')
      for (const path of node.paths) countJobSteps(path.nodes, counts);
    else if (node.kind === 'unsupported')
      for (const layer of node.layers)
        for (const job of layer) countJobSteps(job.nodes, counts);
  }
  return counts;
}

/**
 * A named "+" that opens the step picker. `label` names its place by card
 * number, never by an authored name, which replay would record.
 */
function InsertStepButton({
  label,
  onChoose,
  offerSplit = false,
}: {
  readonly label: string;
  readonly onChoose: (choice: WorkflowStepChoice) => void;
  readonly offerSplit?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <span ref={anchorRef} className="inline-flex">
      <Tooltip label="Add a step">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="compact"
          iconOnly
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="workflow-designer-insert"
          onClick={() => setOpen((current) => !current)}
        >
          <PlusIcon size="sm" aria-hidden="true" />
        </Button>
      </Tooltip>
      <WorkflowStepPicker
        anchorRef={anchorRef}
        returnFocusRef={triggerRef}
        open={open}
        onOpenChange={setOpen}
        onChoose={onChoose}
        offerSplit={offerSplit}
      />
    </span>
  );
}

function Connector(): JSX.Element {
  return (
    <span aria-hidden="true" className="flex h-4 shrink-0 justify-center">
      <Divider orientation="vertical" />
    </span>
  );
}

interface CardCondition {
  readonly source: 'job' | 'step';
  readonly text: string;
}

function ConditionLine({
  text,
  wrap = false,
}: {
  readonly text: string;
  /** Show it whole, wrapping, where nothing else opens to show the rest. */
  readonly wrap?: boolean;
}): JSX.Element {
  return (
    <span
      className={`text-xs fg-tertiary ${wrap ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
    >
      Only if{' '}
      {/* Conditions can hold private values, so replay never records them. */}
      <code className={`font-mono ${REPLAY_BLOCK_CLASS}`}>{text}</code>
    </span>
  );
}

function StackCard({
  number,
  task,
  title,
  detail,
  detailFont = 'mono',
  conditions,
  entryNote,
  icon,
  selected,
  onSelect,
}: {
  readonly number: number;
  readonly task: string;
  readonly title: string;
  readonly detail?: string;
  /** A step's action ref shows in mono; an automation's place doesn't. */
  readonly detailFont?: 'mono' | 'sans';
  /** Keyed by where each comes from: a job and its step can match. */
  readonly conditions: readonly CardCondition[];
  /** Which entry alone runs the step, in place of its condition. */
  readonly entryNote?: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  /** Absent on a read-only workflow: the card shows, disabled. */
  readonly onSelect?: () => void;
}): JSX.Element {
  return (
    <ControlButton
      presentation="workflow-stack-card"
      appearance={{ selected }}
      aria-current={selected ? 'true' : undefined}
      // The card's number, never its key: keys hold authored job IDs, which
      // session replay would record from an attribute.
      data-workflow-card={String(number)}
      data-testid="workflow-designer-card"
      disabled={onSelect === undefined}
      {...(onSelect ? { onClick: onSelect } : {})}
    >
      <Surface as="span" variant="workflow-icon">
        {icon}
      </Surface>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs fg-tertiary">
          {number}. {task}
        </span>
        {/* Authored names are private, as on the pipeline's Details view. */}
        <span
          className={`truncate text-s font-medium fg-primary ${REPLAY_BLOCK_CLASS}`}
        >
          {title}
        </span>
        {detail ? (
          // An action ref can name a private path, and a place a project:
          // never recorded.
          <span
            className={`truncate text-xs fg-secondary ${detailFont === 'mono' ? 'font-mono ' : ''}${REPLAY_BLOCK_CLASS}`}
          >
            {detail}
          </span>
        ) : null}
        {conditions.map((condition) => (
          <ConditionLine key={condition.source} text={condition.text} />
        ))}
        {entryNote !== undefined ? (
          <span className="truncate text-xs fg-tertiary">{entryNote}</span>
        ) : null}
      </span>
    </ControlButton>
  );
}

/** The stack's first card: how the workflow starts. */
function TriggerCard({
  trigger,
}: {
  readonly trigger: WorkflowDesignerTriggerCard;
}): JSX.Element {
  return (
    <ControlButton
      presentation="workflow-stack-card"
      appearance={{ selected: trigger.selected }}
      aria-current={trigger.selected ? 'true' : undefined}
      // Reached by the arrow keys with the numbered cards.
      data-workflow-card={TRIGGER_CARD}
      data-testid="workflow-designer-trigger"
      disabled={trigger.onSelect === undefined}
      {...(trigger.onSelect ? { onClick: trigger.onSelect } : {})}
    >
      <Surface as="span" variant="workflow-icon">
        <PlayIcon size="sm" aria-hidden="true" />
      </Surface>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs fg-tertiary">Trigger</span>
        <span className="truncate text-s font-medium fg-primary">
          {trigger.title}
        </span>
        {trigger.detail ? (
          <span className="truncate text-xs fg-secondary">
            {trigger.detail}
          </span>
        ) : null}
      </span>
    </ControlButton>
  );
}

/**
 * A "+" that can't add here, with the host's reason beside it, so the stack
 * says why it ends instead of hiding the place a step would go.
 */
function BlockedInsert({ reason }: { readonly reason: string }): JSX.Element {
  const reasonId = useId();
  return (
    <span className="flex flex-col items-center gap-1">
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        disabled
        aria-label="Add a step"
        aria-describedby={reasonId}
        data-testid="workflow-designer-insert-blocked"
      >
        <PlusIcon size="sm" aria-hidden="true" />
      </Button>
      <span
        id={reasonId}
        className="w-64 max-w-full text-center text-xs fg-tertiary"
        data-testid="workflow-designer-insert-blocked-reason"
      >
        {reason}
      </span>
    </span>
  );
}

function ActionCard({
  node,
  number,
}: {
  readonly node: WorkflowDesignerAction;
  readonly number: number;
}): JSX.Element {
  const known = WORKFLOW_DESIGNER_ACTIONS[node.action];
  const Icon = known.icon;
  return (
    <span className="flex w-full flex-col items-start gap-1">
      <StackCard
        number={number}
        task={known.label}
        title={node.title}
        {...(node.detail !== undefined ? { detail: node.detail } : {})}
        detailFont="sans"
        conditions={[]}
        icon={<Icon size="sm" aria-hidden="true" />}
        selected={node.selected}
        {...(node.onSelect ? { onSelect: node.onSelect } : {})}
      />
      {node.link ? (
        <Button
          variant="ghost"
          size="compact"
          data-testid="workflow-designer-action-link"
          onClick={node.link.onOpen}
        >
          {node.link.label}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * One job of a group: its name, which opens its settings, what it waits for,
 * and its steps, edited as any card's are.
 */
function GroupJobColumn({
  job,
  context,
}: {
  readonly job: WorkflowDesignerGroupJob;
  readonly context: RenderContext;
}): JSX.Element {
  const onSelectJob = job.editable ? context.onSelectJob : undefined;
  const selected = context.selectedKey === `job:${job.jobId}`;
  // A job whose steps the Designer can't read shows them with nothing to
  // open, add, move or remove.
  const columnContext: RenderContext = job.editable
    ? { ...context, nested: true }
    : {
        nested: true,
        numbers: context.numbers,
        jobMarks: context.jobMarks,
        selectedKey: context.selectedKey,
        onClearSelection: context.onClearSelection,
        jobSteps: context.jobSteps,
        root: context.root,
        stepEntries: context.stepEntries,
      };
  return (
    <div
      className="flex w-64 min-w-0 max-w-full flex-col items-center"
      data-testid="workflow-designer-group-job"
    >
      <span className="flex w-full flex-col gap-0.5 px-1 pb-1">
        {onSelectJob ? (
          <ControlButton
            presentation="workflow-stack-card"
            appearance={{ selected }}
            aria-current={selected ? 'true' : undefined}
            data-workflow-card={context.jobMarks.get(`job:${job.jobId}`)}
            data-testid="workflow-designer-group-job-settings"
            onClick={() => onSelectJob(job.jobId)}
          >
            {/* Job names are authored: never recorded. */}
            <span
              className={`truncate text-xs font-medium fg-secondary ${REPLAY_BLOCK_CLASS}`}
            >
              {job.name}
            </span>
          </ControlButton>
        ) : (
          <span
            className={`truncate text-xs font-medium fg-secondary ${REPLAY_BLOCK_CLASS}`}
          >
            {job.name}
          </span>
        )}
        {job.after.length > 0 ? (
          // Whole, wrapping: nothing else opens to show the rest.
          <span
            className={`break-words text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
          >
            After {job.after.join(', ')}
          </span>
        ) : null}
        {job.condition !== undefined ? (
          <ConditionLine text={job.condition} wrap />
        ) : null}
        {job.cycle ? (
          <span className="text-xs fg-attention">
            Its needs lead back to it, so it never runs.
          </span>
        ) : null}
        {job.matrix ? (
          <span className="text-xs fg-tertiary">
            Runs once for each matrix combination
          </span>
        ) : null}
        {!job.editable ? (
          <span className="text-xs fg-tertiary">
            Its steps can’t be read here. Fix them in YAML.
          </span>
        ) : null}
      </span>
      <StackNodes nodes={job.nodes} context={columnContext} />
    </div>
  );
}

function UnsupportedGroup({
  node,
  context,
}: {
  readonly node: WorkflowDesignerUnsupported;
  readonly context: RenderContext;
}): JSX.Element {
  const count = node.jobNames.length;
  const shown = node.layers.length > 0;
  // A job it can't read needs YAML too, whatever sets the group apart.
  const broken =
    BROKEN.has(node.reason) ||
    node.layers.some((layer) => layer.some((job) => !job.editable));
  const Icon = broken ? WarningIcon : PipelineIcon;
  return (
    <Surface
      variant="dashed"
      padding="compact"
      className="w-full"
      data-testid="workflow-designer-unsupported"
    >
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-s font-medium fg-primary">
          <Icon size="sm" aria-hidden="true" />
          {count === 1 ? (
            <span className={REPLAY_BLOCK_CLASS}>{node.jobNames[0]}</span>
          ) : (
            `${String(count)} jobs`
          )}
        </span>
        <span className="text-xs fg-secondary">
          {UNSUPPORTED_REASON[node.reason]}
        </span>
        {!shown && count > 1 ? (
          <span
            className={`line-clamp-2 text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
          >
            {node.jobNames.join(', ')}
          </span>
        ) : null}
        {broken && context.onEditInYaml ? (
          <span>
            <Button
              variant="secondary"
              size="compact"
              onClick={context.onEditInYaml}
            >
              Edit in YAML
            </Button>
          </span>
        ) : null}
        {shown ? (
          // A layer's jobs can run once the layers above them have. Wide
          // layers wrap rather than scroll, so no job sits out of view.
          <div className="flex w-full flex-col items-center pt-2">
            {node.layers.map((layer, index) => (
              <div
                key={layer.map((job) => job.jobId).join(',')}
                className="flex w-full flex-col items-center gap-2"
                data-testid="workflow-designer-group-layer"
              >
                {index > 0 ? <Connector /> : null}
                {layer.length > 1 ? (
                  <span className="flex items-center gap-1.5 text-xs fg-tertiary">
                    <PipelineIcon size="sm" aria-hidden="true" />
                    Run at the same time
                  </span>
                ) : null}
                <div className="flex w-full flex-wrap items-start justify-center gap-4">
                  {layer.map((job) => (
                    <GroupJobColumn
                      key={job.jobId}
                      job={job}
                      context={context}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}

interface RenderContext {
  /** Cards inside a column fill it; top-level cards keep the stack's width. */
  readonly nested: boolean;
  readonly numbers: ReadonlyMap<string, number>;
  /** Each group job's settings button, for the arrow keys and focus return. */
  readonly jobMarks: ReadonlyMap<string, string>;
  readonly selectedKey: string | null;
  readonly onSelectStep?: (jobId: string, stepIndex: number) => void;
  readonly onSelectJob?: (jobId: string) => void;
  readonly onClearSelection: () => void;
  readonly onEditInYaml?: () => void;
  readonly editing?: WorkflowDesignerEditing;
  readonly jobSteps: ReadonlyMap<string, number>;
  /** The whole stack, to find the split a router card chooses between. */
  readonly root: readonly WorkflowDesignerNode[];
  readonly stepEntries: ReadonlyMap<string, WorkflowDesignerEntry>;
}

const ONLY_FROM: Readonly<Record<WorkflowDesignerEntry, string>> = {
  run: 'Only from a run',
  'approved-plan': 'Only from an approved plan',
  'new-task': 'Only from a new task',
};

/** Where a "+" after `node` inserts, or null when it offers none. */
function insertionAfter(
  node: WorkflowDesignerNode,
): { readonly jobId: string; readonly index: number } | null {
  if (node.kind === 'step')
    return { jobId: node.jobId, index: node.stepIndex + 1 };
  if (node.kind === 'empty-job') return { jobId: node.jobId, index: 0 };
  return null;
}

function Columns({
  heading,
  icon,
  columns,
  context,
}: {
  readonly heading: string;
  readonly icon: ReactNode;
  readonly columns: readonly WorkflowDesignerColumn[];
  readonly context: RenderContext;
}): JSX.Element {
  const containsSelected =
    context.selectedKey !== null &&
    columns.some((column) => containsKey(column.nodes, context.selectedKey));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (containsSelected) setOpen(true);
  }, [containsSelected]);
  const body = (
    <div className="flex items-start gap-4">
      {columns.map((column) => (
        <div
          key={column.key}
          className="flex w-64 min-w-48 shrink flex-col items-center"
          data-testid="workflow-designer-column"
        >
          <span className="w-full truncate px-1 pb-1 text-xs font-medium fg-secondary">
            {/* Job names are authored: never recorded. */}
            <span className={REPLAY_BLOCK_CLASS}>{column.label}</span>
          </span>
          <StackNodes
            nodes={column.nodes}
            context={{ ...context, nested: true }}
          />
        </div>
      ))}
    </div>
  );
  return (
    <div className="flex max-w-full flex-col items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs fg-tertiary">
        {icon}
        {heading}
      </span>
      <div className="max-w-full overflow-x-auto">
        {columns.length > COLLAPSE_GROUP_AFTER ? (
          <Disclosure
            dataTestId="workflow-designer-group"
            label={`${String(columns.length)} jobs`}
            hint={
              <span className={REPLAY_BLOCK_CLASS}>
                {columns.map((column) => column.label).join(', ')}
              </span>
            }
            // A selected card's group stays open, so its card stays mounted
            // and focus can return to it when the panel closes. Collapsing
            // that group closes the panel too, leaving focus on the toggle.
            open={open || containsSelected}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next && containsSelected) context.onClearSelection();
            }}
          >
            {body}
          </Disclosure>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

function StackNodes({
  nodes,
  context,
}: {
  readonly nodes: readonly WorkflowDesignerNode[];
  readonly context: RenderContext;
}): JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        const insertion = context.editing ? insertionAfter(node) : null;
        const number = context.numbers.get(node.key);
        return (
          <div key={node.key} className="flex w-full flex-col items-center">
            {index > 0 ? <Connector /> : null}
            {node.kind === 'parallel' ||
            node.kind === 'paths' ||
            (node.kind === 'unsupported' && node.layers.length > 0) ? (
              <StackNode node={node} context={context} />
            ) : (
              <div className={context.nested ? 'w-full' : 'w-80 max-w-full'}>
                <StackNode node={node} context={context} />
              </div>
            )}
            {node.kind === 'action' && node.addBlockedReason !== undefined ? (
              <>
                <Connector />
                <BlockedInsert reason={node.addBlockedReason} />
              </>
            ) : null}
            {insertion !== null && context.editing && number !== undefined ? (
              <>
                <Connector />
                <InsertStepButton
                  label={`Add a step after step ${String(number)}`}
                  offerSplit={
                    (context.editing.splittableJobs?.has(insertion.jobId) ??
                      false) &&
                    insertion.index ===
                      (context.jobSteps.get(insertion.jobId) ?? 0)
                  }
                  onChoose={(choice) =>
                    context.editing?.onInsertStep(
                      insertion.jobId,
                      insertion.index,
                      choice,
                    )
                  }
                />
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function StackNode({
  node,
  context,
}: {
  readonly node: WorkflowDesignerNode;
  readonly context: RenderContext;
}): JSX.Element {
  switch (node.kind) {
    case 'action':
      return (
        <ActionCard node={node} number={context.numbers.get(node.key) ?? 0} />
      );
    case 'step': {
      const display = workflowStepDisplay(node);
      const Icon = display.icon;
      const conditions: CardCondition[] = [];
      if (node.jobCondition !== undefined)
        conditions.push({ source: 'job', text: node.jobCondition });
      const entry = context.stepEntries.get(node.key);
      if (node.condition !== undefined && entry === undefined)
        conditions.push({ source: 'step', text: node.condition });
      const number = context.numbers.get(node.key) ?? 0;
      const card = (
        <StackCard
          number={number}
          task={display.task}
          title={display.title}
          {...(display.actionId !== undefined
            ? { detail: display.actionId }
            : {})}
          conditions={conditions}
          {...(entry !== undefined ? { entryNote: ONLY_FROM[entry] } : {})}
          icon={<Icon size="sm" aria-hidden="true" />}
          selected={context.selectedKey === node.key}
          {...(context.onSelectStep
            ? {
                onSelect: (): void =>
                  context.onSelectStep?.(node.jobId, node.stepIndex),
              }
            : {})}
        />
      );
      const editing = context.editing;
      if (!editing) return card;
      const count = context.jobSteps.get(node.jobId) ?? 0;
      const items: DetailMoreMenuItem[] = [];
      // Every job's settings open from its first card, in any layout.
      const onSelectJob = context.onSelectJob;
      if (node.stepIndex === 0 && onSelectJob)
        items.push({
          id: 'job-settings',
          label: 'Job settings',
          icon: <PipelineIcon size="sm" aria-hidden="true" />,
          testId: 'workflow-designer-job-settings',
          onSelect: () => onSelectJob(node.jobId),
        });
      if (node.stepIndex > 0)
        items.push({
          id: 'move-up',
          label: 'Move up',
          icon: <ChevronTopMediumIcon size="sm" aria-hidden="true" />,
          testId: 'workflow-designer-move-up',
          onSelect: () =>
            editing.onMoveStep(node.jobId, node.stepIndex, node.stepIndex - 1),
        });
      if (node.stepIndex < count - 1)
        items.push({
          id: 'move-down',
          label: 'Move down',
          icon: <ChevronDownMediumIcon size="sm" aria-hidden="true" />,
          testId: 'workflow-designer-move-down',
          onSelect: () =>
            editing.onMoveStep(node.jobId, node.stepIndex, node.stepIndex + 1),
        });
      if (node.split) items.push(...removeSplitItems(node.jobId, context));
      else
        items.push({
          id: 'remove',
          label: 'Remove step',
          icon: <TrashIcon size="sm" aria-hidden="true" />,
          testId: 'workflow-designer-remove',
          destructive: true,
          onSelect: () => editing.onRemoveStep(node.jobId, node.stepIndex),
        });
      return (
        <div className="flex w-full items-center gap-1">
          <div className="min-w-0 flex-1">{card}</div>
          <DetailMoreMenu
            name={`step ${String(number)}`}
            items={items}
            variant="ghost"
            placement="bottom-right"
            triggerTestId="workflow-designer-card-more"
            menuTestId="workflow-designer-card-menu"
          />
        </div>
      );
    }
    case 'empty-job':
      return (
        <StackCard
          number={context.numbers.get(node.key) ?? 0}
          task="Job"
          title={node.name}
          detail="No steps yet"
          conditions={
            node.jobCondition
              ? [{ source: 'job', text: node.jobCondition }]
              : []
          }
          icon={<PipelineIcon size="sm" aria-hidden="true" />}
          selected={context.selectedKey === node.key}
          {...(context.onSelectJob
            ? { onSelect: (): void => context.onSelectJob?.(node.jobId) }
            : {})}
        />
      );
    case 'parallel':
      return (
        <Columns
          heading="Run at the same time"
          icon={<PipelineIcon size="sm" aria-hidden="true" />}
          columns={node.columns}
          context={context}
        />
      );
    case 'paths':
      return <PathsGroup node={node} context={context} />;
    case 'unsupported':
      return <UnsupportedGroup node={node} context={context} />;
  }
}

/** The split that a router card in `jobId` chooses between. */
function splitOf(
  jobId: string,
  nodes: readonly WorkflowDesignerNode[],
): WorkflowDesignerPaths | undefined {
  for (const node of nodes) {
    if (node.kind === 'paths' && node.jobId === jobId) return node;
    if (node.kind === 'parallel')
      for (const column of node.columns) {
        const found = splitOf(jobId, column.nodes);
        if (found) return found;
      }
  }
  return undefined;
}

/** What deleting `paths` removes, counted: "2 paths with 3 steps". */
function deletedCount(paths: readonly WorkflowDesignerPath[]): string {
  const steps = paths.reduce(
    (total, path) =>
      total + path.nodes.filter((node) => node.kind === 'step').length,
    0,
  );
  const pathCount = `${String(paths.length)} ${paths.length === 1 ? 'path' : 'paths'}`;
  if (steps === 0)
    return `${String(paths.length)} empty ${paths.length === 1 ? 'path' : 'paths'}`;
  return `${pathCount} with ${String(steps)} ${steps === 1 ? 'step' : 'steps'}`;
}

/**
 * The router card's "Remove split" choices, in place of Remove step: delete
 * every path, or keep one path's steps. Each says what it deletes, and names
 * paths by number, as cards are, so the menu never carries an authored label.
 */
function removeSplitItems(
  jobId: string,
  context: RenderContext,
): DetailMoreMenuItem[] {
  const editing = context.editing;
  const split = splitOf(jobId, context.root);
  if (!editing || !split) return [];
  return [
    {
      id: 'remove-split',
      label: `Delete the split and ${deletedCount(split.paths)}`,
      icon: <TrashIcon size="sm" aria-hidden="true" />,
      testId: 'workflow-designer-remove-split',
      destructive: true,
      onSelect: () => editing.onRemoveSplit(jobId),
    },
    ...split.paths.map(
      (path, index): DetailMoreMenuItem => ({
        id: `remove-split-keep-${String(index)}`,
        label: `Keep path ${String(index + 1)}, delete the split and ${deletedCount(
          split.paths.filter((other) => other !== path),
        )}`,
        icon: <SplitIcon size="sm" aria-hidden="true" />,
        testId: 'workflow-designer-remove-split-keep',
        onSelect: () => editing.onRemoveSplit(jobId, path.jobId),
      }),
    ),
  ];
}

/**
 * A split's paths side by side: each with its label, its own steps and
 * "+", and "Add path" after the last one. Nothing follows a split.
 */
function PathsGroup({
  node,
  context,
}: {
  readonly node: WorkflowDesignerPaths;
  readonly context: RenderContext;
}): JSX.Element {
  const editing = context.editing;
  const canRemove = node.paths.length > 2;
  return (
    <div
      className="flex max-w-full flex-col items-center gap-2"
      data-testid="workflow-designer-paths"
    >
      <span className="flex items-center gap-1.5 text-xs fg-tertiary">
        <SplitIcon size="sm" aria-hidden="true" />
        Split into paths
      </span>
      {node.missingInput ? (
        <span
          className="flex items-center gap-1.5 text-xs fg-attention"
          data-testid="workflow-designer-paths-missing-input"
        >
          <WarningIcon size="sm" aria-hidden="true" />
          Choose what the split decides on in its step.
        </span>
      ) : null}
      <div className="flex max-w-full items-start gap-4 overflow-x-auto">
        {node.paths.map((path, index) => (
          <div
            key={path.key}
            className="flex w-64 min-w-48 shrink flex-col items-center"
            data-testid="workflow-designer-path"
          >
            <span className="flex w-full items-center gap-1 px-1 pb-1">
              <span className="min-w-0 flex-1 truncate text-xs font-medium fg-secondary">
                {/* Path labels are authored: never recorded. */}
                <span className={REPLAY_BLOCK_CLASS}>{path.label}</span>
              </span>
              {editing && canRemove ? (
                <DetailMoreMenu
                  name={`path ${String(index + 1)}`}
                  items={[
                    {
                      id: 'remove-path',
                      label: 'Remove path',
                      icon: <TrashIcon size="sm" aria-hidden="true" />,
                      testId: 'workflow-designer-remove-path',
                      destructive: true,
                      onSelect: () =>
                        editing.onRemovePath(node.jobId, path.jobId),
                    },
                  ]}
                  variant="ghost"
                  placement="bottom-right"
                  triggerTestId="workflow-designer-path-more"
                  menuTestId="workflow-designer-path-menu"
                />
              ) : null}
            </span>
            <StackNodes
              nodes={path.nodes}
              context={{ ...context, nested: true }}
            />
          </div>
        ))}
        {editing ? (
          <span className="shrink-0 pt-6">
            <Button
              variant="secondary"
              size="compact"
              data-testid="workflow-designer-add-path"
              onClick={() => editing.onAddPath(node.jobId)}
            >
              <PlusIcon size="sm" aria-hidden="true" />
              Add path
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The workflow designer's vertical stack (CAN-4224): numbered step cards,
 * "Run at the same time" groups, and read-only groups for shapes it can't
 * show, and a split's paths side by side. Selection opens the host's details
 * panel. With `editing`, "+" buttons add steps, each card's More menu moves
 * or removes it, and a split's paths can be added and removed.
 */
export function WorkflowDesigner({
  stack,
  selection,
  onSelectStep,
  onSelectJob,
  onClearSelection,
  onEditInYaml,
  editing,
  notice,
  trigger,
}: WorkflowDesignerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedKey = cardKeyOf(selection);
  const lastSelectedKey = useRef<string | null>(selectedKey);
  const numbers = useMemo(() => numberCards(stack.nodes), [stack.nodes]);
  const jobMarks = useMemo(() => numberGroupJobs(stack.nodes), [stack.nodes]);
  const jobSteps = useMemo(() => countJobSteps(stack.nodes), [stack.nodes]);

  // When the panel closes from outside the stack, focus returns to the card
  // it was editing.
  useEffect(() => {
    const previous = lastSelectedKey.current;
    lastSelectedKey.current = selectedKey;
    if (selectedKey !== null || previous === null) return;
    // Only return focus a closing panel lost: when it is already on a card,
    // or outside the stack such as the view switcher, leave it there. A
    // card's menu button that opened Job settings isn't a card the arrow
    // keys reach, so focus moves on from it.
    const active = document.activeElement;
    const onMenu =
      active !== null &&
      containerRef.current?.contains(active) === true &&
      active.matches(CARD_MENU_SELECTOR);
    if (active !== null && active !== document.body && !onMenu) return;
    // A job's settings return to its name in a group, else its first card.
    const number =
      numbers.get(previous) ??
      (previous.startsWith('job:')
        ? numbers.get(`step:${previous.slice(4)}:0`)
        : undefined);
    const mark =
      jobMarks.get(previous) ??
      (number === undefined ? undefined : String(number));
    const card =
      mark === undefined
        ? undefined
        : Array.from(
            containerRef.current?.querySelectorAll<HTMLElement>(
              CARD_SELECTOR,
            ) ?? [],
          ).find((element) => element.dataset['workflowCard'] === mark);
    // If the card is gone (its job was removed), keep focus in the stack.
    (card ?? containerRef.current)?.focus();
  }, [selectedKey, numbers, jobMarks]);

  // The same for the trigger's panel, which the host opens and closes.
  const triggerSelected = trigger?.selected ?? false;
  const triggerWasSelected = useRef(triggerSelected);
  useEffect(() => {
    const was = triggerWasSelected.current;
    triggerWasSelected.current = triggerSelected;
    if (triggerSelected || !was) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-workflow-card="${TRIGGER_CARD}"]`)
      ?.focus();
  }, [triggerSelected]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // A picker or menu portaled from a card handled this key already;
      // React still bubbles it here through the portal.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && trigger?.selected === true) {
        event.preventDefault();
        trigger.onDismiss();
        return;
      }
      if (event.key === 'Escape' && selectedKey !== null) {
        event.preventDefault();
        onClearSelection();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // A card with nothing to open can't take focus, so it isn't a stop.
      const cards = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(CARD_SELECTOR) ??
          [],
      ).filter((card) => !card.hasAttribute('disabled'));
      const current = cards.findIndex(
        (card) => card === document.activeElement,
      );
      if (current < 0) return;
      const next = cards[current + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
    },
    [onClearSelection, selectedKey, trigger],
  );

  const noticeBlock = notice ? (
    <div className="w-80 max-w-full pb-4">
      <Notice
        intent="attention"
        role="status"
        onDismiss={notice.onDismiss}
        dismissTestId="workflow-designer-notice-dismiss"
        data-testid="workflow-designer-notice"
      >
        {/* It can quote a step's authored name. */}
        <span className={REPLAY_BLOCK_CLASS}>{notice.message}</span>
      </Notice>
    </div>
  ) : null;

  const triggerBlock = trigger ? (
    <>
      <div className="w-80 max-w-full">
        <TriggerCard trigger={trigger} />
      </div>
      {stack.nodes.length > 0 ? <Connector /> : null}
    </>
  ) : null;

  const context: RenderContext = {
    nested: false,
    numbers,
    jobMarks,
    selectedKey,
    ...(onSelectStep ? { onSelectStep } : {}),
    ...(onSelectJob ? { onSelectJob } : {}),
    onClearSelection,
    ...(onEditInYaml ? { onEditInYaml } : {}),
    jobSteps,
    root: stack.nodes,
    stepEntries: trigger?.stepEntries ?? new Map(),
    ...(editing ? { editing } : {}),
  };

  // One container for an empty stack too, so the trigger card keeps its
  // keyboard handling and focus return on a new workflow.
  return (
    <div
      ref={containerRef}
      className="flex min-h-full w-full justify-center px-4 py-6"
      data-testid="workflow-designer"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="flex w-full flex-col items-center">
        {noticeBlock}
        {triggerBlock}
        {stack.nodes.length > 0 ? (
          <StackNodes nodes={stack.nodes} context={context} />
        ) : editing ? (
          <EmptyState
            title="No steps yet"
            subtitle="Add the first step to start the workflow."
            action={<AddFirstStepButton onChoose={editing.onAddFirstStep} />}
          />
        ) : (
          <EmptyState
            title="No steps yet"
            subtitle="Add a job in YAML or with the assistant to start."
          />
        )}
      </div>
    </div>
  );
}

function AddFirstStepButton({
  onChoose,
}: {
  readonly onChoose: (choice: WorkflowStepChoice) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <span ref={anchorRef} className="inline-flex">
      <Button
        ref={triggerRef}
        variant="primary"
        size="compact"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="workflow-designer-add-first"
        onClick={() => setOpen((current) => !current)}
      >
        Add the first step
      </Button>
      <WorkflowStepPicker
        anchorRef={anchorRef}
        returnFocusRef={triggerRef}
        open={open}
        onOpenChange={setOpen}
        onChoose={onChoose}
      />
    </span>
  );
}
