import {
  CLOUD_MODEL_CHILD_DEPTH_MAX,
  CLOUD_MODEL_PREFLIGHT_ITEMS_MAX,
  type CloudModelChoice,
  type CloudModelPreflightItem,
} from '@canopy/protocol/canopy-core';
import {
  applyCloudModelChoices,
  findCloudModelItems,
  type CloudModelChoicesOutcome,
  type CloudModelContext,
} from './cloud-model-preflight';
import type { Job, Pipeline, PipelineScalar, Step } from './document';
import { assignStepIds } from './normalize-pipeline';
import { parsePipelineText } from './parse-pipeline';

/*
 * Cloud model preflight for child workflows (CAN-7044).
 *
 * A `run-pipeline` step starts a child workflow whose model steps the cloud
 * may not run as written either. The start check lists them with the run's
 * own: each child item is the child's own item, its key prefixed with the
 * parent step's (`<jobId>#<stepIndex>/`), and `workflows` names the child
 * workflows it sits in, outermost first. The person confirms each as any
 * other; the run's pinned definition keeps its own replacements, and its
 * start records the children's choices with the rest.
 *
 * A child's definition is read only when its step runs, on the runner. So
 * preflight lists a child it can name before the run: a step's inline
 * `pipeline_yaml`, or a `pipeline` reference to a bundled workflow (the
 * runner stages the same ones). A reference written as an expression, or to
 * a workflow file of the run's checkout, lists nothing here. When the child
 * starts, the run's owner applies the choices under the step's prefix to the
 * definition the runner resolved (`childCloudModelChoices`), and refuses the
 * child when one of its items has no choice: nobody is there to confirm one.
 */

/** Separates a parent step's key from its child's item key. */
export const CLOUD_CHILD_ITEM_SEPARATOR = '/';

/** The deepest nesting of child workflows preflight follows. */
export const CLOUD_CHILD_WORKFLOW_DEPTH_MAX = CLOUD_MODEL_CHILD_DEPTH_MAX;

const BUILTIN_RUN_PIPELINE = /^builtin\/(?:\.\/)?run-pipeline$/;

/** Whether a step starts a child workflow. */
export function isRunPipelineStep(step: Pick<Step, 'uses'>): boolean {
  return (
    typeof step.uses === 'string' && BUILTIN_RUN_PIPELINE.test(step.uses.trim())
  );
}

/** A child workflow as preflight reads it: its name and definition. */
export interface CloudChildWorkflow {
  readonly name: string;
  readonly pipeline: Pipeline;
}

/** Finds the child a step names, or null when it can't be named before the run. */
export type CloudChildWorkflowResolver = (
  step: Step,
) => CloudChildWorkflow | null;

/** `<jobId>#<stepIndex>/`: the prefix of a step's child items and choices. */
export function cloudChildItemPrefix(jobId: string, stepIndex: number): string {
  return `${jobId}#${String(stepIndex)}${CLOUD_CHILD_ITEM_SEPARATOR}`;
}

/**
 * The model steps of `pipeline` and of every child it names that a cloud run
 * can't run as written (`findCloudModelItems`), the run's own first, each
 * child's after its run's, children followed `CLOUD_CHILD_WORKFLOW_DEPTH_MAX`
 * deep. A child that names itself, directly or through another, is listed
 * once. Throws `CloudChildWorkflowsTooLarge` as soon as the check would read
 * more than `CLOUD_CHILD_WORKFLOWS_READ_MAX` children or list more than
 * `CLOUD_MODEL_PREFLIGHT_ITEMS_MAX` items.
 */
export function findCloudRunModelItems(
  pipeline: Pipeline,
  context: CloudModelContext,
  resolve: CloudChildWorkflowResolver,
): CloudModelPreflightItem[] {
  return itemsWithChildren(pipeline, context, resolve, [], {
    children: CLOUD_CHILD_WORKFLOWS_READ_MAX,
    items: CLOUD_MODEL_PREFLIGHT_ITEMS_MAX,
  });
}

/** The most child-starting steps one start check reads a child for. */
export const CLOUD_CHILD_WORKFLOWS_READ_MAX = 64;

/**
 * A start check that would read more children, or list more items, than it
 * may: refused as a whole, before it reads further, since a few nested
 * steps can name a child many times over.
 */
export class CloudChildWorkflowsTooLarge extends Error {
  constructor() {
    super(
      'This workflow has too many agent steps or child workflows to check for a cloud run.',
    );
  }
}

/** What one start check may still read: children, and items to list. */
interface ReadBudget {
  children: number;
  items: number;
}

function itemsWithChildren(
  pipeline: Pipeline,
  context: CloudModelContext,
  resolve: CloudChildWorkflowResolver,
  within: readonly CloudChildWorkflow[],
  budget: ReadBudget,
): CloudModelPreflightItem[] {
  const items = findCloudModelItems(pipeline, context);
  budget.items -= items.length;
  if (budget.items < 0) throw new CloudChildWorkflowsTooLarge();
  if (within.length >= CLOUD_CHILD_WORKFLOW_DEPTH_MAX) return items;
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    // Raw text is parsed, not normalized, so a job may lack its steps.
    if (!Array.isArray(job.steps)) continue;
    for (const [stepIndex, step] of job.steps.entries()) {
      if (!isRunPipelineStep(step)) continue;
      budget.children -= 1;
      if (budget.children < 0) throw new CloudChildWorkflowsTooLarge();
      const child = resolve(step);
      if (
        child === null ||
        within.some((outer) => outer.pipeline === child.pipeline)
      )
        continue;
      const prefix = cloudChildItemPrefix(jobId, stepIndex);
      for (const item of itemsWithChildren(
        child.pipeline,
        context,
        resolve,
        [...within, child],
        budget,
      ))
        items.push({
          ...item,
          itemKey: `${prefix}${item.itemKey}`,
          workflows: [child.name, ...(item.workflows ?? [])],
        });
    }
  }
  return items;
}

/** Whether a key or choice is a child's (names a parent step first). */
function isChildKey(itemKey: string): boolean {
  return itemKey.includes(CLOUD_CHILD_ITEM_SEPARATOR);
}

/**
 * The choices for the child a step starts, their keys without the step's
 * prefix: its own and its children's.
 */
export function childCloudModelChoices(
  choices: readonly CloudModelChoice[],
  jobId: string,
  stepIndex: number,
): CloudModelChoice[] {
  const prefix = cloudChildItemPrefix(jobId, stepIndex);
  return choices
    .filter((choice) => choice.itemKey.startsWith(prefix))
    .map((choice) => ({
      itemKey: choice.itemKey.slice(prefix.length),
      modelId: choice.modelId,
    }));
}

/**
 * `applyCloudModelChoices` for a run and the children preflight listed: the
 * run's own items are replaced in its definition, and each child item needs
 * exactly one choice of a model it lists, as the run's own do. The applied
 * choices hold the children's too, for the run's record, from which each
 * child's are applied as it starts.
 */
export function applyCloudRunModelChoices(
  pipeline: Pipeline,
  items: readonly CloudModelPreflightItem[],
  choices: readonly CloudModelChoice[],
): CloudModelChoicesOutcome {
  const own = applyCloudModelChoices(
    pipeline,
    items.filter((item) => !isChildKey(item.itemKey)),
    choices.filter((choice) => !isChildKey(choice.itemKey)),
  );
  const children = applyCloudModelChoices(
    pipeline,
    // Checked as the run's own, never applied here: a child is replaced
    // when it starts.
    items.filter((item) => isChildKey(item.itemKey)),
    choices.filter((choice) => isChildKey(choice.itemKey)),
    { checkOnly: true },
  );
  if (!own.ok || !children.ok)
    return {
      ok: false,
      unconfirmed: [
        ...(own.ok ? [] : own.unconfirmed),
        ...(children.ok ? [] : children.unconfirmed),
      ],
      unknown: [
        ...(own.ok ? [] : own.unknown),
        ...(children.ok ? [] : children.unknown),
      ],
    };
  return {
    ok: true,
    pipeline: own.pipeline,
    applied: [...own.applied, ...children.applied],
  };
}

/**
 * A child's definition with the choices its run's person made for it
 * (`childCloudModelChoices`), as it starts: every item it has needs one, and
 * a choice for an item it doesn't have (another version of the child than
 * preflight read) is left unused. Unchanged when it has no items, as a
 * resumed child's stored definition has none.
 */
export function applyChildCloudModelChoices(
  pipeline: Pipeline,
  context: CloudModelContext,
  choices: readonly CloudModelChoice[],
): CloudModelChoicesOutcome {
  const items = findCloudModelItems(pipeline, context);
  const keys = new Set(items.map((item) => item.itemKey));
  return applyCloudModelChoices(
    pipeline,
    items,
    choices.filter(
      (choice) => !isChildKey(choice.itemKey) && keys.has(choice.itemKey),
    ),
  );
}

/**
 * Where each child-starting step of a definition is, by the id the executor
 * gives it (`<jobId>` and `<stepId>`), so a child's request, which names its
 * step by id, finds the step's choices. Empty for a definition the executor
 * would refuse.
 */
export function runPipelineStepIndexes(
  pipeline: Pick<Pipeline, 'jobs'>,
): [jobId: string, stepId: string, stepIndex: number][] {
  const indexes: [string, string, number][] = [];
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    if (!Array.isArray(job.steps)) continue;
    let ids: readonly { readonly id: string }[];
    try {
      ids = assignStepIds(job.steps, jobId);
    } catch {
      continue;
    }
    for (const [stepIndex, step] of job.steps.entries()) {
      const id = ids[stepIndex]?.id;
      if (isRunPipelineStep(step) && id !== undefined)
        indexes.push([jobId, id, stepIndex]);
    }
  }
  return indexes;
}

/** The inputs of a step that cloud model preflight reads. */
const PROJECTED_INPUTS = [
  'model',
  'commit_model',
  'pr_model',
  'permission_preset',
  'plugin_collection_id',
  'pipeline',
  'pipeline_yaml',
] as const;

/**
 * What cloud model preflight reads of a workflow (`findCloudRunModelItems`):
 * its name, model aliases and, for each step in its place, the action and
 * the inputs that name a model, its preset, its plugin collection or its
 * child. Every other step keeps its place with nothing in it.
 * `bundled-cloud-workflows.generated.ts` holds the bundled workflows so,
 * since the web core can't read the files the runner stages.
 */
export function cloudModelWorkflowProjection(pipeline: Pipeline): Pipeline {
  const jobs: Record<string, Job> = {};
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const steps = Array.isArray(job.steps)
      ? job.steps.map((step): Step => {
          const kept: Record<string, PipelineScalar> = {};
          for (const input of PROJECTED_INPUTS) {
            const value = step.with?.[input];
            if (value !== undefined) kept[input] = value;
          }
          const named =
            typeof step.uses === 'string' &&
            step.uses.startsWith('builtin/') &&
            !step.uses.includes('{{');
          return {
            ...(step.id === undefined ? {} : { id: step.id }),
            ...(named ? { uses: step.uses } : {}),
            ...(step.target === undefined ? {} : { target: step.target }),
            ...(named && Object.keys(kept).length > 0 ? { with: kept } : {}),
          };
        })
      : [];
    jobs[jobId] = {
      ...(job.strategy === undefined ? {} : { strategy: job.strategy }),
      steps,
    };
  }
  return {
    name: pipeline.name,
    on: 'dispatch',
    jobs,
    ...(pipeline.model_aliases === undefined
      ? {}
      : { model_aliases: pipeline.model_aliases }),
  };
}

/** One bundled workflow, as the runner stages it. */
export interface BundledCloudWorkflow {
  readonly id: string;
  readonly filename: string;
  readonly pipeline: Pipeline;
}

/**
 * The bundled workflow a `run-pipeline` reference names as the runner
 * resolves it in the bundled folder: its file name, with or without
 * `.yaml` or `.yml`. Null for any other reference.
 */
export function bundledChildWorkflow(
  bundled: readonly BundledCloudWorkflow[],
  reference: string,
): BundledCloudWorkflow | null {
  const ref = reference.trim();
  const named = /\.ya?ml$/.test(ref) ? [ref] : [`${ref}.yaml`, `${ref}.yml`];
  return bundled.find((workflow) => named.includes(workflow.filename)) ?? null;
}

/**
 * The child a step names before the run (`CloudChildWorkflowResolver`): its
 * inline `pipeline_yaml`, expressions in its fields and all, or a bundled
 * workflow its `pipeline` names. A reference or document written as an
 * expression, or a reference to any other file, names none.
 */
export function cloudChildWorkflowResolver(
  bundled: readonly BundledCloudWorkflow[],
): CloudChildWorkflowResolver {
  return (step) => {
    const reference = step.with?.pipeline;
    const inline = step.with?.pipeline_yaml;
    if (typeof reference === 'string' && reference.trim() !== '') {
      if (reference.includes('${{')) return null;
      const found = bundledChildWorkflow(bundled, reference);
      return found === null
        ? null
        : { name: found.pipeline.name, pipeline: found.pipeline };
    }
    // An expression in a field of the document (a prompt's, say) is the
    // child's own; only a document that is wholly an expression names none.
    if (typeof inline !== 'string' || inline.trim().startsWith('${{'))
      return null;
    try {
      const pipeline = parsePipelineText(inline);
      return { name: pipeline.name, pipeline };
    } catch {
      return null;
    }
  };
}
