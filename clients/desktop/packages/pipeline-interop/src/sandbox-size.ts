import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';

/*
 * The sandbox a cloud run gets (CAN-6325, plan CP-64, decision D27). A run
 * uses one sandbox, so its size bounds everything the run does at once. The
 * size is whole vCPUs, the sizes run sandboxes come in, with memory at 2 GiB
 * per vCPU. Each run scope has a default; the organization's default raises
 * it, the author's `sandbox.vcpus` hint raises it further, and the
 * organization's maximum caps the result. Desktop reads no part of this.
 */

/** The sizes a run sandbox comes in, in vCPUs. */
export const PIPELINE_SANDBOX_VCPU_SIZES = [1, 2, 4, 8] as const;
export type PipelineSandboxVcpus = (typeof PIPELINE_SANDBOX_VCPU_SIZES)[number];

/** Memory a run sandbox gets per vCPU. */
export const PIPELINE_SANDBOX_MEMORY_BYTES_PER_VCPU = 2 * 1024 * 1024 * 1024;

/**
 * Each scope's default. A global run starts in an empty sandbox; a directory
 * or worktree run checks out and builds a project.
 */
export const PIPELINE_SANDBOX_DEFAULT_VCPUS: Readonly<
  Record<PipelineExecutionScope, PipelineSandboxVcpus>
> = {
  global: 2,
  directory: 4,
  worktree: 4,
};

/** An organization's run sandbox limits; each is absent when it sets none. */
export interface PipelineSandboxLimits {
  /** Raises every scope's default to at least this. */
  readonly defaultVcpus?: PipelineSandboxVcpus;
  /** No run of the organization gets more. */
  readonly maxVcpus?: PipelineSandboxVcpus;
}

/** What decided a run's size. */
export type PipelineSandboxSizeSource =
  | 'scope_default'
  | 'organization_default'
  | 'author_hint'
  | 'organization_max';

export interface PipelineSandboxSize {
  readonly vcpus: PipelineSandboxVcpus;
  readonly memoryBytes: number;
  readonly source: PipelineSandboxSizeSource;
}

export function isPipelineSandboxVcpus(
  value: unknown,
): value is PipelineSandboxVcpus {
  return PIPELINE_SANDBOX_VCPU_SIZES.some((size) => size === value);
}

/** The raw `sandbox` block of a pipeline's YAML. */
export interface PipelineSandboxHint {
  /** One of the run sandbox sizes. */
  vcpus?: number;
}

/**
 * Validate the raw `sandbox` value of a parsed pipeline; returns the problem,
 * or null when it is absent or valid.
 */
export function validatePipelineSandboxHint(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'Pipeline sandbox must be an object';
  for (const key of Object.keys(value))
    if (key !== 'vcpus') return `Pipeline sandbox has unknown field "${key}"`;
  const vcpus: unknown = Reflect.get(value, 'vcpus');
  if (vcpus !== undefined && !isPipelineSandboxVcpus(vcpus))
    return `Pipeline sandbox.vcpus must be one of ${PIPELINE_SANDBOX_VCPU_SIZES.join(', ')}`;
  return null;
}

export function resolvePipelineSandboxSize(input: {
  readonly scope: PipelineExecutionScope;
  /** The pipeline's `sandbox` block; an invalid one counts as none. */
  readonly hint?: unknown;
  readonly limits?: PipelineSandboxLimits | null;
}): PipelineSandboxSize {
  let vcpus: PipelineSandboxVcpus = PIPELINE_SANDBOX_DEFAULT_VCPUS[input.scope];
  let source: PipelineSandboxSizeSource = 'scope_default';
  const limits = input.limits ?? {};
  if (limits.defaultVcpus !== undefined && limits.defaultVcpus > vcpus) {
    vcpus = limits.defaultVcpus;
    source = 'organization_default';
  }
  const hinted: unknown =
    validatePipelineSandboxHint(input.hint) === null &&
    typeof input.hint === 'object' &&
    input.hint !== null
      ? Reflect.get(input.hint, 'vcpus')
      : undefined;
  if (isPipelineSandboxVcpus(hinted) && hinted > vcpus) {
    vcpus = hinted;
    source = 'author_hint';
  }
  if (limits.maxVcpus !== undefined && vcpus > limits.maxVcpus) {
    vcpus = limits.maxVcpus;
    source = 'organization_max';
  }
  return {
    vcpus,
    memoryBytes: vcpus * PIPELINE_SANDBOX_MEMORY_BYTES_PER_VCPU,
    source,
  };
}
