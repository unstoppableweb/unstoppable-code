import {
  APP_ADVISOR_BOT_ID,
  botIdForProjectId,
  isBotId,
} from '@canopy/protocol/chat-targets';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  type Pipeline,
  type PipelineInputDef,
  type PipelineInputValue,
  type PipelineTriggerType,
  type Step,
} from './document';

export type WorkflowTarget =
  | { kind: 'bot'; botId: string }
  | { kind: 'project'; projectId: string; taskId?: string }
  | { kind: 'several' }
  | { kind: 'none' };

type Place = Extract<WorkflowTarget, { kind: 'bot' | 'project' }>;

// Keep projected IDs within the portable pipeline detail contract. This
// bounds the listing projection without changing step execution.
const MAX_TARGET_ID_LENGTH = 512;

const destinationSteps = new Set([
  'builtin/create-bot-entry',
  'builtin/create-project-entry',
  'builtin/create-worktree',
  'builtin/send-agent-message',
  'builtin/wait-for-agent-reply',
]);

const contextSteps = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/agent-loop',
  'builtin/parallel-agents',
  'builtin/plan-with-review',
]);

export function projectWorkflowTarget(
  projectId: string,
  taskId?: string,
): Place {
  const botId = botIdForProjectId(projectId);
  if (botId !== null) return { kind: 'bot', botId };
  return taskId === undefined
    ? { kind: 'project', projectId }
    : { kind: 'project', projectId, taskId };
}

function stepPlace(
  step: Step,
  resolve: (value: unknown) => string | undefined,
  contextProjectId: string | undefined,
): Place | undefined {
  const uses = step.uses;
  const values = step.with ?? {};
  const taskId = resolve(values.task_id) || undefined;
  if (uses && contextSteps.has(uses))
    return contextProjectId
      ? projectWorkflowTarget(contextProjectId, taskId)
      : undefined;

  const takesBot =
    uses === 'builtin/create-bot-entry' ||
    uses === 'builtin/send-agent-message' ||
    uses === 'builtin/wait-for-agent-reply';
  const projectKeys =
    uses === 'builtin/create-worktree'
      ? ['project_id', 'workspace_id']
      : ['project_id'];
  const projectValues = projectKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(values, key),
  );
  if (takesBot && Object.prototype.hasOwnProperty.call(values, 'bot_id')) {
    const botId = resolve(values.bot_id);
    if (uses === 'builtin/create-bot-entry') {
      if (projectValues.length > 0) return undefined;
      if (botId === '') return { kind: 'bot', botId: APP_ADVISOR_BOT_ID };
    }
    // Send and reply treat known blank destinations as absent. An unresolved
    // expression can still supply a conflicting destination.
    if (botId !== '') {
      if (projectValues.some((key) => resolve(values[key]) !== ''))
        return undefined;
      return botId && isBotId(botId) ? { kind: 'bot', botId } : undefined;
    }
  }
  if (uses === 'builtin/create-bot-entry')
    return projectValues.length === 0
      ? { kind: 'bot', botId: APP_ADVISOR_BOT_ID }
      : undefined;

  let projectId: string | undefined;
  for (const key of projectValues) {
    const value = resolve(values[key]);
    if (value === undefined) return undefined;
    if (value === '') continue;
    if (projectId !== undefined && value !== projectId) return undefined;
    projectId = value;
  }
  return projectId ? projectWorkflowTarget(projectId, taskId) : undefined;
}

function samePlace(left: Place, right: Place): boolean {
  return left.kind === 'bot'
    ? right.kind === 'bot' && left.botId === right.botId
    : right.kind === 'project' &&
        left.projectId === right.projectId &&
        left.taskId === right.taskId;
}

function unwrapExpressionGroups(expression: string): string | undefined {
  let left = 0;
  let right = expression.length;
  while (expression[left] === '(') {
    if (expression[right - 1] !== ')') return undefined;
    left += 1;
    right -= 1;
    while (left < right && /\s/.test(expression[left])) left += 1;
    while (right > left && /\s/.test(expression[right - 1])) right -= 1;
  }
  return expression.slice(left, right);
}

// Resolve only static dot keys and quoted bracket keys, optionally grouped.
function staticInputKey(expression: string): string | undefined {
  const unwrapped = unwrapExpressionGroups(expression);
  if (unwrapped === undefined) return undefined;
  const reference = /^inputs\s*(?:\.\s*([A-Za-z_]\w*)|\[(.*)\])$/.exec(
    unwrapped,
  );
  if (reference?.[2] === undefined) return reference?.[1];
  const key = unwrapExpressionGroups(reference[2].trim());
  return key === undefined ? undefined : /^(['"])([\w-]+)\1$/.exec(key)?.[2];
}

function resolveTargetString(
  raw: unknown,
  definitions: Record<string, PipelineInputDef> | undefined,
  resolvedInputs: Readonly<Record<string, PipelineInputValue>> | undefined,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  let start = value.indexOf('${{');
  if (start === -1)
    return value.length <= MAX_TARGET_ID_LENGTH ? value : undefined;
  // Scan each span once. An unresolved expression makes the entire
  // destination ambiguous, so there is no need to search past it.
  const parts: string[] = [];
  let remaining = MAX_TARGET_ID_LENGTH;
  let offset = 0;
  while (start !== -1) {
    const end = value.indexOf('}}', start + 3);
    if (end === -1) return undefined;
    const expression = value.slice(start + 3, end).trim();
    if (/[\r\n\u2028\u2029]/.test(expression)) return undefined;
    const key = staticInputKey(expression);
    if (
      key === undefined ||
      !definitions ||
      !Object.prototype.hasOwnProperty.call(definitions, key)
    )
      return undefined;
    const input = resolvedInputs
      ? Object.prototype.hasOwnProperty.call(resolvedInputs, key)
        ? resolvedInputs[key]
        : undefined
      : definitions[key]?.default;
    if (input === undefined && !resolvedInputs) return undefined;
    const replacement =
      typeof input === 'string' ||
      typeof input === 'number' ||
      typeof input === 'boolean'
        ? String(input)
        : '';
    remaining -= start - offset + replacement.length;
    if (remaining < 0) return undefined;
    if (offset < start) parts.push(value.slice(offset, start));
    if (replacement) parts.push(replacement);
    offset = end + 2;
    start = value.indexOf('${{', offset);
  }
  if (value.length - offset > remaining) return undefined;
  parts.push(value.slice(offset));
  const resolved = parts.join('');
  return resolved.includes('${{') ? undefined : resolved.trim();
}

/** Derive a definition-wide target, or restrict it to a schedule's actual trigger. */
export function deriveWorkflowTarget(
  pipeline: Pipeline,
  options: {
    projectId?: string;
    resolvedInputs?: Readonly<Record<string, PipelineInputValue>>;
    trigger?: PipelineTriggerType;
  } = {},
): WorkflowTarget {
  const triggers = options.trigger
    ? [options.trigger]
    : getTriggerTypes(pipeline.on);
  const definitions = triggers.map((trigger) =>
    getTriggerInputDefs(pipeline.on, trigger),
  );
  if (!definitions.length) definitions.push(undefined);

  let target: Place | undefined;
  let namedTaskId: string | undefined;
  for (const job of Object.values(pipeline.jobs)) {
    // Persisted documents can still hydrate with a malformed job or step.
    if (!Array.isArray(job?.steps)) return { kind: 'several' };
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step))
        return { kind: 'several' };
      if (
        !step.uses ||
        (!destinationSteps.has(step.uses) && !contextSteps.has(step.uses))
      )
        continue;
      let place: Place | undefined;
      for (const inputDefs of definitions) {
        const next = stepPlace(
          step,
          (value) =>
            resolveTargetString(value, inputDefs, options.resolvedInputs),
          options.projectId,
        );
        if (!next || (place && !samePlace(place, next)))
          return { kind: 'several' };
        place = next;
      }
      if (!place) return { kind: 'several' };
      if (!target) {
        target = place;
      } else if (target.kind === 'bot') {
        if (place.kind !== 'bot' || place.botId !== target.botId)
          return { kind: 'several' };
      } else {
        if (place.kind !== 'project' || place.projectId !== target.projectId)
          return { kind: 'several' };
        if (place.taskId && namedTaskId && place.taskId !== namedTaskId)
          return { kind: 'several' };
        if (place.taskId !== target.taskId)
          target = { kind: 'project', projectId: target.projectId };
      }
      if (place.kind === 'project') namedTaskId ??= place.taskId;
    }
  }
  return target ?? { kind: 'none' };
}

export function workflowTargetsBot(
  target: WorkflowTarget | undefined,
  botId: string,
): boolean {
  return target?.kind === 'bot' && target.botId === botId;
}
