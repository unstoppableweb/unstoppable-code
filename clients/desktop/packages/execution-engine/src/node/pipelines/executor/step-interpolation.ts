import type { NormalizedStep } from './types';
import type { buildExpressionContext } from './execution-context';
import { interpolateExpression } from './expression-evaluator';
import type {
  PipelineRunTarget,
  PipelineScalar,
} from '@canopy/execution-engine/types/pipeline';

type ExpressionContext = ReturnType<typeof buildExpressionContext>;

function interpolateScalars(
  values: Record<string, PipelineScalar>,
  context: ExpressionContext,
  literalKeys: ReadonlySet<string> = new Set(),
): Record<string, PipelineScalar> {
  const result: Record<string, PipelineScalar> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] =
      typeof value === 'string' && !literalKeys.has(key)
        ? interpolateExpression(value, context)
        : value;
  }
  return result;
}

/** `send-agent-message` inputs that `literal_text: true` keeps as written. */
const LITERAL_SEND_INPUTS: ReadonlySet<string> = new Set([
  'text',
  'text_references',
]);

/**
 * The `with` keys a step keeps unevaluated: a send step's text and references
 * when it sets `literal_text: true` as written, never as an expression
 * (CAN-4551). A converted automation's prompt then arrives as its author
 * typed it, `${{ ... }}` included.
 */
function literalWithKeys(step: NormalizedStep): ReadonlySet<string> {
  const literal = step.with?.literal_text;
  // A YAML `true` arrives as a boolean; the step's parser reads it as 'true'.
  return step.uses === 'builtin/send-agent-message' &&
    (literal === true ||
      (typeof literal === 'string' && literal.trim().toLowerCase() === 'true'))
    ? LITERAL_SEND_INPUTS
    : new Set();
}

function interpolateTarget(
  target: PipelineRunTarget | undefined,
  context: ExpressionContext,
): PipelineRunTarget | undefined {
  if (!target) {
    return undefined;
  }
  if (target.scope === 'directory') {
    return target.path
      ? {
          scope: 'directory',
          path: interpolateExpression(target.path, context),
        }
      : target;
  }
  if (target.scope !== 'worktree') {
    return target;
  }

  const interpolated = {
    ...target,
    workspace_id: interpolateExpression(target.workspace_id, context),
    worktree: {
      id: interpolateExpression(target.worktree.id, context),
    },
  };

  return interpolated;
}

export function interpolateNormalizedStep(
  step: NormalizedStep,
  context: ExpressionContext,
): NormalizedStep {
  const interpolated: NormalizedStep = { ...step };

  if (interpolated.run) {
    interpolated.run = interpolateExpression(interpolated.run, context);
  }

  if (interpolated.env) {
    interpolated.env = interpolateScalars(interpolated.env, context);
  }

  if (interpolated.with) {
    interpolated.with = interpolateScalars(
      interpolated.with,
      context,
      literalWithKeys(step),
    );
  }

  interpolated.target = interpolateTarget(interpolated.target, context);

  return interpolated;
}
