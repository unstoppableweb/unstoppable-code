import { APP_ADVISOR_BOT_ID } from '@canopy/agent-actions/families/bots/actions';
import type { Pipeline } from '@canopy/pipeline-interop/document';
import type { SharedAutomationAction } from '@canopy/protocol/automations';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';

/**
 * How the install review binds a shared workflow's dispatch input (CAN-6548).
 * Workflow inputs carry no project type, so the kind is read from the steps
 * that consume the input: an input passed as a builtin step's `project_id`
 * names a project, one passed as `bot_id` names the Orchestrator.
 */
export type SharedWorkflowInputKind =
  | { kind: 'project'; projectKind: SharedWorkflowProjectKind }
  | { kind: 'orchestrator'; value: string }
  | { kind: 'text' };

/**
 * `code` when the input creates a worktree, `cowork` when it creates a Cowork
 * entry, `any` when no step settles it.
 */
export type SharedWorkflowProjectKind = 'code' | 'cowork' | 'any';

/** Refusal when a project input is left empty. */
export const SHARED_WORKFLOW_PROJECT_REQUIRED_MESSAGE =
  'Choose a project for this automation before installing.';

const PROJECT_KIND_BY_STEP: Readonly<Record<string, 'code' | 'cowork'>> = {
  'builtin/create-worktree': 'code',
  'builtin/create-project-entry': 'cowork',
};

const INPUT_REFERENCE = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

function referencedInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return INPUT_REFERENCE.exec(value.trim())?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every step with a `with` map. Parsing checks only the top level, so a job,
 * its `steps` or a step can be any YAML value; anything else is skipped
 * rather than crashing the install review.
 */
function declaredSteps(
  pipeline: Pipeline | null,
): { uses: unknown; with: Record<string, unknown> }[] {
  const jobs: unknown = pipeline?.jobs;
  if (!isRecord(jobs)) return [];
  const steps: { uses: unknown; with: Record<string, unknown> }[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      const candidate: unknown = step;
      if (!isRecord(candidate) || !isRecord(candidate.with)) continue;
      steps.push({ uses: candidate.uses, with: candidate.with });
    }
  }
  return steps;
}

function parseRaw(rawPipeline: string): Pipeline | null {
  try {
    return parsePipelineText(rawPipeline);
  } catch {
    return null;
  }
}

/**
 * Classify each of a shared workflow's `inputKeys` from its raw definition.
 * Without a readable definition every input stays a text field.
 */
export function sharedWorkflowInputKinds(
  rawPipeline: string | undefined,
  inputKeys: readonly string[],
): Record<string, SharedWorkflowInputKind> {
  // The project kinds each input's creation steps need.
  const projectKinds = new Map<string, Set<'code' | 'cowork'>>();
  const botInputs = new Set<string>();
  const pipeline =
    rawPipeline !== undefined && rawPipeline.trim() !== ''
      ? parseRaw(rawPipeline)
      : null;
  for (const step of declaredSteps(pipeline)) {
    const projectInput = referencedInput(step.with.project_id);
    if (projectInput !== null) {
      const kinds = projectKinds.get(projectInput) ?? new Set();
      const created =
        typeof step.uses === 'string'
          ? PROJECT_KIND_BY_STEP[step.uses]
          : undefined;
      if (created !== undefined) kinds.add(created);
      projectKinds.set(projectInput, kinds);
    }
    const botInput = referencedInput(step.with.bot_id);
    if (botInput !== null) botInputs.add(botInput);
  }
  const result: Record<string, SharedWorkflowInputKind> = {};
  for (const key of inputKeys) {
    const kinds = projectKinds.get(key);
    if (kinds !== undefined) {
      // A creation step decides the kind; other consumers take either.
      const [only, ...rest] = [...kinds];
      result[key] = {
        kind: 'project',
        projectKind: only !== undefined && rest.length === 0 ? only : 'any',
      };
    } else if (botInputs.has(key)) {
      result[key] = { kind: 'orchestrator', value: APP_ADVISOR_BOT_ID };
    } else {
      result[key] = { kind: 'text' };
    }
  }
  return result;
}

/**
 * {@link sharedWorkflowInputKinds} for a shared workflow action. Only a
 * bundled (`inline`) definition travels with the document; any other source
 * keeps text inputs.
 */
export function sharedPipelineInputKinds(
  action: Extract<SharedAutomationAction, { type: 'worktree_pipeline' }>,
): Record<string, SharedWorkflowInputKind> {
  return sharedWorkflowInputKinds(
    action.pipeline.source === 'inline'
      ? action.pipeline.rawPipeline
      : undefined,
    action.inputKeys,
  );
}

/**
 * The inputs an install stores: the recipient's values, with every
 * Orchestrator input filled in. Returns the refusal when a project input is
 * empty.
 */
export function completeSharedWorkflowInputs(
  kinds: Readonly<Record<string, SharedWorkflowInputKind>>,
  inputs: Readonly<Record<string, string>> | undefined,
): { ok: true; inputs: Record<string, string> } | { ok: false; error: string } {
  const completed: Record<string, string> = { ...inputs };
  for (const [key, kind] of Object.entries(kinds)) {
    if (kind.kind === 'orchestrator') completed[key] = kind.value;
    else if (kind.kind === 'project' && !completed[key]?.trim())
      return { ok: false, error: SHARED_WORKFLOW_PROJECT_REQUIRED_MESSAGE };
  }
  return { ok: true, inputs: completed };
}
