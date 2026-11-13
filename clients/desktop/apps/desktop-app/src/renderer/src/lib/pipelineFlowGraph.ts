import dagre from 'dagre';
import { Position, type Edge, type Node } from '@xyflow/react';
import type {
  Pipeline,
  ExecutionState,
  JobGroupResult,
  Step,
} from '@canopy/execution-engine/types/pipeline';
import { normalizeNeeds } from '@canopy/execution-engine/types/pipeline';

export type PipelineFlowStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'queued'
  | 'pending'
  | 'paused'
  | 'restarting'
  | 'cancelled'
  | 'skipped'
  | 'none';

/** A step rendered as a nested card inside its job block. */
export interface PipelineFlowStep {
  stepIndex: number;
  stepId: string | undefined;
  label: string;
  status: PipelineFlowStatus;
}

/**
 * Variant summary rendered inside a logical matrix node.
 *
 * Variants never become graph nodes of their own — the DAG keeps exactly one
 * node per YAML job, and the matrix is summarized on that node.
 */
export interface PipelineFlowMatrixSummary {
  /** `5 variants` (absent before expansion). */
  variantCountLabel?: string;
  /** `3 / 5 complete`. */
  completionLabel?: string;
  /** `3 succeeded · 1 failed · 1 running`. */
  breakdownLabel?: string;
  /** `Max parallel: 3`, rendered from `resolved_max_parallel` verbatim. */
  maxParallelLabel?: string;
  /** Copy for a dynamic matrix whose expansion is still pending. */
  expandingLabel?: string;
  /** Copy for a successful matrix that generated no variants. */
  emptyLabel?: string;
}

export interface PipelineJobNodeData extends Record<string, unknown> {
  jobId: string;
  label: string;
  status: PipelineFlowStatus;
  steps: PipelineFlowStep[];
  /**
   * Present iff this node is a matrix job. Variants are summarized inside it.
   */
  matrix?: PipelineFlowMatrixSummary;
  /** Set by the diagram when this job is the active selection. */
  selected?: boolean;
  /** Set by the diagram when one of this job's steps is the active selection. */
  selectedStepIndex?: number;
  /**
   * The editable flow offers `Add step` under this job's steps (CAN-4319),
   * and its height already holds that row.
   */
  canAddStep?: boolean;
}

export interface DefinitionFlowOptions {
  /** The job whose block offers `Add step`: the selected one, when editable. */
  readonly addStepJobId?: string;
}

export type PipelineJobNode = Node<PipelineJobNodeData, 'pipelineJob'>;
export type PipelineFlowEdge = Edge;

/** Layout flow direction: top-to-bottom or left-to-right. */
export type PipelineFlowDirection = 'TB' | 'LR';

export interface PipelineFlowResult {
  nodes: PipelineJobNode[];
  edges: PipelineFlowEdge[];
}

// Job-block dimensions. Jobs are the primary flow blocks; steps render as
// nested cards inside them, so a job block's height grows with its step count.
export const PIPELINE_NODE_WIDTH = 240;
export const JOB_HEADER_HEIGHT = 34;
export const STEP_ROW_HEIGHT = 26;
export const STEP_ROW_GAP = 6;
export const STEP_LIST_PADDING_TOP = 6;
export const STEP_LIST_PADDING_BOTTOM = 8;
const EMPTY_BODY_PADDING = 6;
const RANK_SEP = 70;
const NODE_SEP = 40;
/** The editable flow's `Add step` row: a compact `Button`. */
export const ADD_STEP_ROW_HEIGHT = 28;
/** Height of one summary line inside a logical matrix node's body. */
export const MATRIX_SUMMARY_ROW_HEIGHT = 15;

/** Total pixel height of a job block holding `stepCount` nested step cards. */
export function jobNodeHeight(stepCount: number): number {
  if (stepCount === 0) {
    return JOB_HEADER_HEIGHT + EMPTY_BODY_PADDING;
  }
  return (
    JOB_HEADER_HEIGHT +
    STEP_LIST_PADDING_TOP +
    stepCount * STEP_ROW_HEIGHT +
    (stepCount - 1) * STEP_ROW_GAP +
    STEP_LIST_PADDING_BOTTOM
  );
}

/** A job block's height with the `Add step` row under its steps. */
export function jobNodeHeightWithAddStep(stepCount: number): number {
  return stepCount === 0
    ? JOB_HEADER_HEIGHT +
        STEP_LIST_PADDING_TOP +
        ADD_STEP_ROW_HEIGHT +
        STEP_LIST_PADDING_BOTTOM
    : jobNodeHeight(stepCount) + STEP_ROW_GAP + ADD_STEP_ROW_HEIGHT;
}

/** Number of summary lines a matrix node body will render. */
function countMatrixSummaryLines(
  summary: PipelineFlowMatrixSummary | undefined,
): number {
  if (!summary) {
    return 0;
  }
  return [
    summary.expandingLabel,
    summary.emptyLabel,
    summary.variantCountLabel,
    summary.completionLabel,
    summary.breakdownLabel,
    summary.maxParallelLabel,
  ].filter((line) => line !== undefined && line !== '').length;
}

/** Pixel height of a job block that renders a matrix summary. */
export function matrixJobNodeHeight(
  summary: PipelineFlowMatrixSummary | undefined,
): number {
  const lines = countMatrixSummaryLines(summary);
  if (lines === 0) {
    return jobNodeHeight(0);
  }
  return (
    JOB_HEADER_HEIGHT +
    STEP_LIST_PADDING_TOP +
    lines * MATRIX_SUMMARY_ROW_HEIGHT +
    STEP_LIST_PADDING_BOTTOM
  );
}

/** Build the compact runtime summary for one logical matrix group. */
export function buildMatrixFlowSummary(
  group: JobGroupResult | undefined,
  statuses: readonly string[],
): PipelineFlowMatrixSummary | undefined {
  if (group?.kind !== 'matrix') return undefined;
  if (group.expansion === 'pending') {
    return { expandingLabel: 'Waiting to expand' };
  }
  if (group.variant_job_ids.length === 0) {
    return { emptyLabel: 'No variants were generated for this job.' };
  }
  const complete = statuses.filter((status) =>
    ['success', 'failure', 'cancelled', 'skipped'].includes(status),
  ).length;
  return {
    variantCountLabel: `${String(statuses.length)} variants`,
    completionLabel: `${String(complete)} / ${String(statuses.length)} complete`,
    ...(group.resolved_max_parallel !== undefined
      ? {
          maxParallelLabel: `Max parallel: ${String(group.resolved_max_parallel)}`,
        }
      : {}),
  };
}

/** A job held for memory (CAN-6325) shows as queued in the flow. */
function flowJobStatus(
  status: Exclude<PipelineFlowStatus, 'none'> | 'waiting_for_capacity',
): PipelineFlowStatus {
  return status === 'waiting_for_capacity' ? 'queued' : status;
}

interface RawNodeEntry {
  id: string;
  height: number;
  data: PipelineJobNodeData;
}

interface RawEdgeEntry {
  source: string;
  target: string;
}

interface RawGraph {
  nodes: RawNodeEntry[];
  edges: RawEdgeEntry[];
}

function applyDagreLayout(
  raw: RawGraph,
  direction: PipelineFlowDirection,
): PipelineFlowResult {
  const horizontal = direction === 'LR';
  const sourcePosition = horizontal ? Position.Right : Position.Bottom;
  const targetPosition = horizontal ? Position.Left : Position.Top;
  const known = new Set(raw.nodes.map((n) => n.id));
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 16,
    marginy: 16,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of raw.nodes) {
    g.setNode(node.id, {
      width: PIPELINE_NODE_WIDTH,
      height: node.height,
    });
  }
  const validEdges = raw.edges.filter(
    (e) => known.has(e.source) && known.has(e.target),
  );
  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  const nodes: PipelineJobNode[] = raw.nodes.map((node) => {
    const positioned = g.node(node.id);
    const x =
      positioned === undefined ? 0 : positioned.x - PIPELINE_NODE_WIDTH / 2;
    const y = positioned === undefined ? 0 : positioned.y - node.height / 2;
    return {
      id: node.id,
      type: 'pipelineJob',
      position: { x, y },
      data: node.data,
      sourcePosition,
      targetPosition,
      draggable: false,
      connectable: false,
      style: { width: PIPELINE_NODE_WIDTH, height: node.height },
    };
  });
  const edges: PipelineFlowEdge[] = validEdges.map((edge, index) => ({
    id: `${edge.source}->${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
  }));
  return { nodes, edges };
}

function stepLabel(step: Step, index: number): string {
  return step.name ?? step.id ?? `Step ${String(index + 1)}`;
}

function buildDependencyEdges(
  jobIds: string[],
  needsOf: (jobId: string) => string | string[] | undefined,
): RawEdgeEntry[] {
  const edges: RawEdgeEntry[] = [];
  for (const jobId of jobIds) {
    for (const dep of normalizeNeeds(needsOf(jobId))) {
      edges.push({ source: dep, target: jobId });
    }
  }
  return edges;
}

export function buildExecutionFlow(
  state: ExecutionState,
  jobOrder: string[],
  direction: PipelineFlowDirection = 'LR',
): PipelineFlowResult {
  const snapshot = state.pipeline_snapshot;
  const presentJobs = jobOrder.filter((id) => snapshot.jobs[id] !== undefined);
  // The details-modal flow is job-level only: each node is a job block colored
  // by job status, with no nested step cards (per-step status is shown in the
  // job view). The editor flow keeps nested steps via `buildDefinitionFlow`.
  const nodes: RawNodeEntry[] = presentJobs.map((jobId) => {
    const job = snapshot.jobs[jobId];
    const group = state.job_groups?.[jobId];
    const isMatrixJob = group?.kind === 'matrix';
    const variants = (group?.variant_job_ids ?? []).map(
      (physicalJobId) => state.jobs[physicalJobId],
    );
    const matrix = isMatrixJob
      ? buildMatrixFlowSummary(
          group,
          variants.map((variant) => variant.status),
        )
      : undefined;
    return {
      id: jobId,
      height:
        matrix !== undefined ? matrixJobNodeHeight(matrix) : jobNodeHeight(0),
      data: {
        jobId,
        label: job.name ?? jobId,
        status: flowJobStatus(
          group?.outcome ??
            state.jobs[jobId]?.outcome ??
            group?.status ??
            state.jobs[jobId]?.status ??
            'pending',
        ),
        steps: [],
        ...(matrix !== undefined ? { matrix } : {}),
      },
    };
  });
  const edges = buildDependencyEdges(
    presentJobs,
    (jobId) => snapshot.jobs[jobId]?.needs,
  );
  return applyDagreLayout({ nodes, edges }, direction);
}

export function buildDefinitionFlow(
  pipeline: Pipeline,
  jobOrder: string[],
  direction: PipelineFlowDirection = 'TB',
  options: DefinitionFlowOptions = {},
): PipelineFlowResult {
  const presentJobs = jobOrder.filter((id) => pipeline.jobs[id] !== undefined);
  const nodes: RawNodeEntry[] = presentJobs.map((jobId) => {
    const job = pipeline.jobs[jobId];
    const steps: PipelineFlowStep[] = job.steps.map((step, index) => ({
      stepIndex: index,
      stepId: step.id,
      label: stepLabel(step, index),
      status: 'none',
    }));
    const isMatrixJob = job.strategy !== undefined;
    const canAddStep = options.addStepJobId === jobId;
    return {
      id: jobId,
      height: canAddStep
        ? jobNodeHeightWithAddStep(steps.length)
        : jobNodeHeight(steps.length),
      data: {
        jobId,
        label: job.name ?? jobId,
        status: 'none',
        steps,
        ...(isMatrixJob ? { matrix: {} } : {}),
        ...(canAddStep ? { canAddStep } : {}),
      },
    };
  });
  const edges = buildDependencyEdges(
    presentJobs,
    (jobId) => pipeline.jobs[jobId]?.needs,
  );
  return applyDagreLayout({ nodes, edges }, direction);
}
