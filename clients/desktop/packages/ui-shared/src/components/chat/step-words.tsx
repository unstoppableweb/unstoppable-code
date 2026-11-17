import type { JSX } from 'react';
import type { PortalChatToolFamily } from './tool-display-info';
import { isPlanFileWrite } from './exit-plan-mode-plan';
import {
  AgentIcon,
  DocumentIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  QuestionMarkIcon,
  TaskIcon,
  TerminalIcon,
  WrenchIcon,
} from '../../icons';
import {
  DocumentPencilIcon,
  KeyIcon,
  LightbulbIcon,
  PlanModeIcon,
} from '../../icons/AppIcons';
import { isRequestSecretsToolName } from './request-secrets-display';

/** The kinds of agent step a plain-words summary counts. */
export type StepKind =
  | 'thinking'
  | 'search'
  | 'read'
  | 'edit'
  | 'plan'
  | 'command'
  | 'graph'
  | 'web'
  | 'tasks'
  | 'agent'
  | 'question'
  | 'secrets'
  | 'other';

/** A plan write whose result does not establish successful execution. */
export type PlanWriteStatus = 'pending' | 'failed' | 'interrupted';
type StepPhraseKind = StepKind | PlanWriteStatus;
type StepCount = readonly [StepKind, number, PlanWriteStatus?];

const PLAN_STATUS_PHRASES: Record<PlanWriteStatus, (count: number) => string> =
  {
    pending: (count) => `writing plan${timesSuffix(count)}`,
    failed: (count) => `couldn't write plan${timesSuffix(count)}`,
    interrupted: (count) => `plan write interrupted${timesSuffix(count)}`,
  };

function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function timesSuffix(count: number): string {
  return count === 1 ? '' : ` ${count} times`;
}

const STEP_PHRASES: Record<StepPhraseKind, (count: number) => string> = {
  ...PLAN_STATUS_PHRASES,
  thinking: (count) => `thought${timesSuffix(count)}`,
  search: (count) => `searched ${countOf(count, 'time', 'times')}`,
  read: (count) => `read ${countOf(count, 'file', 'files')}`,
  edit: (count) => `edited ${countOf(count, 'file', 'files')}`,
  plan: (count) => `wrote plan${timesSuffix(count)}`,
  command: (count) => `ran ${countOf(count, 'command', 'commands')}`,
  graph: (count) => `checked the code graph${timesSuffix(count)}`,
  web: (count) => `used the web${timesSuffix(count)}`,
  tasks: (count) => `updated the task list${timesSuffix(count)}`,
  agent: (count) => `ran ${countOf(count, 'agent', 'agents')}`,
  question: (count) => `asked ${countOf(count, 'question', 'questions')}`,
  secrets: (count) => `requested secrets${timesSuffix(count)}`,
  other: (count) => `used ${countOf(count, 'tool', 'tools')}`,
};

/**
 * Plain-words summary of agent steps, kinds in the order given: "Searched 3
 * times, read 4 files, checked the code graph". Live step groups and, under
 * the clean chat look, finished turns read the same way on every host.
 */
export function describeStepCounts(counts: Iterable<StepCount>): string {
  const merged = new Map<StepPhraseKind, number>();
  for (const [kind, count, status] of counts) {
    const key = kind === 'plan' && status ? status : kind;
    if (count > 0) merged.set(key, (merged.get(key) ?? 0) + count);
  }
  const sentence = Array.from(merged, ([kind, count]) =>
    STEP_PHRASES[kind](count),
  ).join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function oneOrMany(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

const STEP_KIND_PHRASES: Record<StepPhraseKind, (count: number) => string> = {
  ...PLAN_STATUS_PHRASES,
  thinking: () => 'thought',
  search: () => 'searched the code',
  read: (count) => oneOrMany(count, 'read a file', 'read files'),
  edit: (count) => oneOrMany(count, 'edited a file', 'edited files'),
  plan: (count) => `wrote plan${timesSuffix(count)}`,
  command: (count) => oneOrMany(count, 'ran a command', 'ran commands'),
  graph: () => 'checked the code graph',
  web: () => 'searched the web',
  tasks: () => 'updated the task list',
  agent: (count) => oneOrMany(count, 'ran an agent', 'ran agents'),
  question: (count) => oneOrMany(count, 'asked a question', 'asked questions'),
  secrets: () => 'requested secrets',
  other: (count) => oneOrMany(count, 'used a tool', 'used tools'),
};

/**
 * The clean chat look's summary of a run of steps: what was done, without
 * counting it, like "Ran commands, read a file, searched the code". Thinking
 * only shows when the run did nothing else ("Thought").
 */
export function describeStepKinds(counts: Iterable<StepCount>): string {
  const merged = new Map<StepPhraseKind, number>();
  for (const [kind, count, status] of counts) {
    const key = kind === 'plan' && status ? status : kind;
    if (count > 0) merged.set(key, (merged.get(key) ?? 0) + count);
  }
  if (merged.size > 1) merged.delete('thinking');
  const sentence = Array.from(merged, ([kind, count]) =>
    STEP_KIND_PHRASES[kind](count),
  ).join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The kind of step a tool family's call counts as. */
export function stepKindOfToolFamily(family: PortalChatToolFamily): StepKind {
  switch (family) {
    case 'grep':
    case 'glob':
      return 'search';
    case 'read':
      return 'read';
    case 'edit':
    case 'write':
      return 'edit';
    case 'bash':
    case 'script-output':
      return 'command';
    case 'graph':
      return 'graph';
    case 'web':
      return 'web';
    case 'todo':
      return 'tasks';
    case 'ask-user':
      return 'question';
    default:
      return 'other';
  }
}

/**
 * The kind of step one tool call counts as. A Write to the plan file
 * (`.claude/plans/<name>.md`) reads "wrote plan" rather than as a project
 * edit; the path convention names the artifact, not the turn's mode, and an
 * input too broken to read stays an ordinary edit. Hosts pass their own
 * tool name, family and input, as their transcript carries them.
 */
export function stepKindOfToolCall({
  toolName,
  family,
  input,
}: {
  readonly toolName: string;
  readonly family: PortalChatToolFamily;
  readonly input: unknown;
}): StepKind {
  if (isPlanFileWrite(toolName, input)) return 'plan';
  if (isRequestSecretsToolName(toolName)) return 'secrets';
  return stepKindOfToolFamily(family);
}

/** The icon a step row of this kind leads with. */
export function stepKindIcon(kind: StepKind): JSX.Element {
  switch (kind) {
    case 'thinking':
      return <LightbulbIcon />;
    case 'search':
      return <MagnifyingGlassIcon />;
    case 'read':
      return <DocumentIcon />;
    case 'edit':
      return <DocumentPencilIcon />;
    case 'plan':
      return <PlanModeIcon />;
    case 'command':
      return <TerminalIcon />;
    case 'graph':
      return <GraphIcon />;
    case 'web':
      return <GlobeIcon />;
    case 'tasks':
      return <TaskIcon />;
    case 'agent':
      return <AgentIcon />;
    case 'question':
      return <QuestionMarkIcon />;
    case 'secrets':
      return <KeyIcon />;
    default:
      return <WrenchIcon />;
  }
}
