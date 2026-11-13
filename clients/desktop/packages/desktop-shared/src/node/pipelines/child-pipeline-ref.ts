import type { PipelineScalar } from '@canopy/pipeline-interop/document';
import {
  buildExpressionContext,
  cascadeEnv,
} from '@canopy/execution-engine/node/pipelines/executor/execution-context';
import { interpolateExpression } from '@canopy/execution-engine/node/pipelines/executor/expression-evaluator';

/**
 * Why a child pipeline ref cannot be resolved before a run.
 *
 * - `non_env_reference`: an expression reads something other than a named
 *   `env` value (an input, a step output, a function call).
 * - `runtime_env`: it reads an env name the pipeline YAML does not define, so
 *   only the run's environment can supply it.
 * - `expression_env_value`: the effective definition of the name is itself an
 *   expression.
 * - `step_env`: the name is defined on the step. A run interpolates `with`
 *   before the step's own `env` applies, so that value never selects the child.
 * - `empty`: the ref evaluates to an empty string.
 */
export type ChildPipelineRefUnresolvedReason =
  | 'non_env_reference'
  | 'runtime_env'
  | 'expression_env_value'
  | 'step_env'
  | 'empty';

export type ChildPipelineRefResolution =
  | { kind: 'literal'; raw: string }
  | { kind: 'resolved'; raw: string; evaluated: string }
  | {
      kind: 'unresolved';
      raw: string;
      reason: ChildPipelineRefUnresolvedReason;
    };

type EnvLayer = Readonly<Record<string, PipelineScalar | string>> | undefined;

export interface ResolveChildPipelineRefInput {
  /** The authored `with.pipeline` value. */
  ref: string;
  /** The pipeline's `env`, with any env a parent run passes down applied first. */
  pipelineEnv?: EnvLayer;
  jobEnv?: EnvLayer;
  stepEnv?: EnvLayer;
}

/**
 * An embedded `${{ }}` expression, as the run-time interpolation matches it.
 * Kept identical to the evaluator's pattern so analysis and a run agree on
 * what is an expression.
 */
const TEMPLATE_EXPRESSION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g;

/** `env.NAME`, `env['NAME']` or `env["NAME"]`, and nothing else. */
const ENV_REFERENCE_PATTERN =
  /^env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([^'\\]+)'\s*\]|\[\s*"([^"\\]+)"\s*\])$/;

/** The env name an expression reads, when reading one env name is all it does. */
function envReferenceName(expression: string): string | undefined {
  const match = ENV_REFERENCE_PATTERN.exec(expression.trim());
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasOwn(layer: EnvLayer, name: string): boolean {
  return (
    layer !== undefined && Object.prototype.hasOwnProperty.call(layer, name)
  );
}

/**
 * Resolve a child pipeline `with.pipeline` value the way a run will, using
 * only what the pipeline YAML fixes before it runs.
 *
 * A ref without `${{` is a literal. A ref whose every expression reads one
 * `env` name, each defined in the YAML as a literal (no `${{`), is resolved
 * to the value a run interpolates. Anything else depends on inputs, steps or
 * the run's environment and is unresolved. Expressions are never evaluated
 * unguarded: the evaluator yields `''` for a missing context, which would
 * look like a resolved empty ref.
 *
 * Both `raw` and `evaluated` are trimmed, as the child resolver trims the
 * interpolated ref before matching it.
 */
export function resolveChildPipelineRef(
  input: ResolveChildPipelineRefInput,
): ChildPipelineRefResolution {
  const raw = input.ref.trim();
  if (!raw.includes('${{')) return { kind: 'literal', raw };
  const names: string[] = [];
  const outside = raw.replace(
    TEMPLATE_EXPRESSION_PATTERN,
    (_match, expression: string) => {
      const name = envReferenceName(expression);
      names.push(name ?? '');
      return '';
    },
  );
  // An expression the run would not interpolate (it spans lines or is never
  // closed), or one that reads anything but a named env value.
  if (outside.includes('${{') || names.some((name) => name === '')) {
    return { kind: 'unresolved', raw, reason: 'non_env_reference' };
  }
  const env = cascadeEnv(input.pipelineEnv, input.jobEnv);
  for (const name of names) {
    if (hasOwn(input.stepEnv, name)) {
      return { kind: 'unresolved', raw, reason: 'step_env' };
    }
    const value = env[name];
    if (value === undefined) {
      return { kind: 'unresolved', raw, reason: 'runtime_env' };
    }
    if (value.includes('${{')) {
      return { kind: 'unresolved', raw, reason: 'expression_env_value' };
    }
  }
  let evaluated: string;
  try {
    evaluated = interpolateExpression(
      raw,
      buildExpressionContext({ env }),
    ).trim();
  } catch {
    return { kind: 'unresolved', raw, reason: 'non_env_reference' };
  }
  if (!evaluated) return { kind: 'unresolved', raw, reason: 'empty' };
  return { kind: 'resolved', raw, evaluated };
}
