import type {
  PipelinePackageEnvironmentRequirement,
  PipelinePackageResource,
  PipelinePackageSummary,
} from '@canopy/protocol/pipelines';
import { SCHEDULED_WORKFLOW_ITEM_LABEL } from './workflow-labels';

/**
 * Pure display helpers for self-contained pipeline packages, shared by the
 * desktop publisher/recipient surfaces and the public web share page so both
 * describe the same package with identical wording. Display only — no fetching,
 * no stores, no Node/Electron/Next APIs.
 */

/** Section headings and standing copy, kept identical across surfaces. */
export const PIPELINE_PACKAGE_INCLUDED_HEADING = 'Included dependencies';
export const PIPELINE_PACKAGE_SETUP_HEADING = 'Setup required';
export const PIPELINE_PACKAGE_PUBLISHER_SETUP_HEADING =
  'Recipient setup required';
export const PIPELINE_PACKAGE_NO_CREDENTIALS_NOTE =
  'Credentials and external runtimes are not included.';
export const PIPELINE_PACKAGE_PUBLISHER_NO_CREDENTIALS_NOTE =
  'Credentials and external runtimes are never included.';
export const PIPELINE_PACKAGE_DEFINITION_ONLY_WARNING =
  'This share contains the workflow definition only. Required dependencies are not included.';
export const PIPELINE_PACKAGE_EMPTY_DEPENDENCIES =
  'No dependency files are included.';
/**
 * Automation-share counterpart to the pipeline warning. An automation share
 * without a capability package installs the schedule and the prompt only.
 */
export const AUTOMATION_PACKAGE_DEFINITION_ONLY_WARNING =
  'This share contains the scheduled workflow definition only. Required dependencies are not included.';
/**
 * Bundling disclosure for a `worktree_pipeline` automation whose pipeline
 * definition rides along inside the share.
 */
export const AUTOMATION_PACKAGE_BUNDLED_NOTE =
  'The workflow definition travels with this share.';
/**
 * Bundling disclosure for a legacy automation that points at a separately
 * shared pipeline instead of carrying its definition.
 */
export const AUTOMATION_PACKAGE_NOT_BUNDLED_NOTE =
  'The workflow definition is not included. You need access to the shared workflow it points to.';
/** Short distribution line rendered beside an automation's requirements. */
export const AUTOMATION_PACKAGE_DEPENDENCIES_INCLUDED_NOTE =
  'Required dependencies are included in this share.';
/** Short distribution line for a definition-only automation share. */
export const AUTOMATION_PACKAGE_DEPENDENCIES_EXCLUDED_NOTE =
  'Required dependencies are not included in this share.';
/** Heading for what the publisher deliberately left out of the package. */
export const PIPELINE_PACKAGE_NOT_INCLUDED_HEADING = 'Not included';
/** Recipient-facing explanation of a publisher "not a command" note. */
export const PIPELINE_PACKAGE_PUBLISHER_NOTE =
  'The publisher marked these as not commands, so they are not copied.';

const KIND_LABELS: Record<PipelinePackageResource['kind'], string> = {
  standalone_skill: 'Skill',
  plugin_skill: 'Skill',
  plugin_command: 'Command',
  plugin_agent: 'Agent',
  pipeline_action: 'Workflow action',
  child_pipeline: 'Child workflow',
  automation_pipeline: 'Workflow',
  file_asset: 'Files',
  pipeline_definition: 'Workflow',
  automation_definition: SCHEDULED_WORKFLOW_ITEM_LABEL,
  agent_definition: 'Agent',
  hook_definition: 'Hook',
};

/** Human label for a packaged resource kind ("Skill", "Command", "Agent"). */
export function pipelinePackageKindLabel(
  kind: PipelinePackageResource['kind'],
): string {
  return KIND_LABELS[kind];
}

const REQUIREMENT_KIND_LABELS: Record<
  PipelinePackageEnvironmentRequirement['kind'],
  string
> = {
  connector: 'Connection',
  mcp: 'MCP server',
  model: 'Model',
  command: 'Command',
  runtime: 'Runtime',
};

/** Human label for a recipient environment requirement kind. */
export function pipelinePackageRequirementKindLabel(
  kind: PipelinePackageEnvironmentRequirement['kind'],
): string {
  return REQUIREMENT_KIND_LABELS[kind];
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Compact size label for package/file byte counts. Deterministic (no locale
 * dependency) so desktop, web, and their snapshots agree.
 */
export function formatPipelinePackageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded =
    unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${BYTE_UNITS[unitIndex]}`;
}

/** `3 files · 12.4 KB` — the per-resource and package-total size line. */
export function formatPipelinePackageFileSummary(
  fileCount: number,
  totalBytes: number,
): string {
  const files = `${String(fileCount)} ${fileCount === 1 ? 'file' : 'files'}`;
  return `${files} · ${formatPipelinePackageBytes(totalBytes)}`;
}

const EXECUTABLE_FILES_SHOWN = 5;

/**
 * `Runnable scripts: scripts/zip.sh, run.py` — the line every share and
 * install surface shows under a resource that carries files which run as
 * programs, or `null` when it has none. Named on its own line, never folded
 * into the file count.
 */
export function formatPipelinePackageExecutableFiles(
  paths: readonly string[],
): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, EXECUTABLE_FILES_SHOWN).join(', ');
  const hidden = paths.length - EXECUTABLE_FILES_SHOWN;
  return `Runnable scripts: ${shown}${
    hidden > 0 ? `, and ${String(hidden)} more` : ''
  }`;
}

/** `job.step, other.step` — the affected-step list rendered under a row. */
export function formatPipelinePackageSteps(
  steps: ReadonlyArray<{ jobId: string; stepId: string }>,
): string {
  return steps.map((step) => `${step.jobId}.${step.stepId}`).join(', ');
}

/**
 * `Installed with 5 dependencies.` / `Installed with 1 dependency.` — the
 * desktop terminal status after a package install.
 */
export function formatPipelinePackageInstalledStatus(count: number): string {
  return `Installed with ${String(count)} ${
    count === 1 ? 'dependency' : 'dependencies'
  }.`;
}

/** `Installing 2 of 5 dependencies…` — the desktop in-flight transfer label. */
export function formatPipelinePackageTransferLabel(
  completed: number,
  total: number,
): string {
  return `Installing ${String(completed)} of ${String(total)} ${
    total === 1 ? 'dependency' : 'dependencies'
  }…`;
}

/**
 * True when a package summary carries nothing worth reviewing, so callers can
 * fall back to the empty-dependency copy rather than rendering a bare heading.
 */
export function isEmptyPipelinePackageSummary(
  summary: Pick<
    PipelinePackageSummary,
    'resources' | 'environmentRequirements'
  >,
): boolean {
  return (
    summary.resources.length === 0 &&
    summary.environmentRequirements.length === 0
  );
}
