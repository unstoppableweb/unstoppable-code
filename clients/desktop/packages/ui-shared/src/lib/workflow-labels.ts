/**
 * User-facing names for workflows (CAN-4651). Pipelines and automations are
 * one thing in the UX, a workflow; where both kinds appear side by side they
 * are told apart by how they start. The ids (`pipeline`, `automation`,
 * `watcher`) are unchanged; only the names live here, so desktop and web
 * render the same words.
 */

/** The workflow kinds the Runs feed and type pickers tell apart. */
export type WorkflowKind = 'automation' | 'pipeline' | 'watcher';

/** The item noun for one workflow. */
export const WORKFLOW_ITEM_LABEL = 'Workflow';

/** The item noun for more than one workflow. */
export const WORKFLOW_ITEM_LABEL_PLURAL = 'Workflows';

/** Each kind named by how it starts, for a Kind column or chip. */
export const WORKFLOW_KIND_LABELS: Readonly<Record<WorkflowKind, string>> = {
  automation: 'Scheduled',
  pipeline: 'On demand',
  watcher: 'Watcher',
};

/**
 * The item noun for one automation where it stands alone, such as a shared
 * item's install review: a workflow named by how it starts, so it stays
 * distinguishable from an on-demand workflow.
 */
export const SCHEDULED_WORKFLOW_ITEM_LABEL = `${WORKFLOW_KIND_LABELS.automation} ${WORKFLOW_ITEM_LABEL.toLowerCase()}`;

/**
 * The list name for each browsable kind: Marketplace and Customize type tabs,
 * browse sections, and command palette groups.
 */
export const WORKFLOW_TYPE_TAB_LABELS: Readonly<
  Record<Exclude<WorkflowKind, 'watcher'>, string>
> = {
  pipeline: 'Workflows',
  automation: 'Scheduled workflows',
};

/**
 * Former names a search still matches, so someone typing "pipeline" or
 * "automation" keeps finding workflows. Never rendered.
 */
const WORKFLOW_SEARCH_ALIASES: Readonly<
  Record<Exclude<WorkflowKind, 'watcher'>, string>
> = {
  pipeline: 'pipeline',
  automation: 'automation',
};

/** The hidden search alias for an entry kind, if it is a workflow kind. */
export function workflowSearchAlias(kind: string): string | undefined {
  return kind === 'pipeline' || kind === 'automation'
    ? WORKFLOW_SEARCH_ALIASES[kind]
    : undefined;
}
