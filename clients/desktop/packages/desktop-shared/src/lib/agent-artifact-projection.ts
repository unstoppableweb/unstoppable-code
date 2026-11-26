/**
 * Pure attribution of agent artifact receipts to chat turns (CAN-3619).
 *
 * The desktop renderer's Agent activity panel and Electron main's Portal
 * `pipeline_run` chat-turn links share this single implementation, so a run
 * appears under exactly the turns desktop shows it under. It parses receipts
 * from successful action-dispatch tool results, assigns each to the user turn
 * that made the call (including late results), and merges persisted watcher
 * carry per turn. Browser-safe: no Node, Electron, React or store imports.
 * Host instrumentation and presentation selection stay with each host.
 */
import type {
  AgentArtifactCarryByTurn,
  AgentArtifactCarryReceiptV1,
  AgentArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '../types/agent-artifacts';
import type { PersistedChatMessage } from '../types';
import {
  buildPipelineRunArtifactReceipt,
  buildSkillArtifactReceipt,
  collapseAgentArtifactsByItem,
  serializeAgentArtifactReceipts,
  mergeAgentArtifactsByPrecedence,
} from './agent-artifacts';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  getCanonicalCanopyToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getCanonicalAppAdvisorToolKey,
} from './app-advisor-tools';
import { getCanonicalPipelineEditorToolKey } from './pipeline-editor-tools';

export interface AgentArtifactProjection {
  byTurn: Record<string, AgentArtifactReceiptV1[]>;
  chatInitiatedPipelineRuns: Record<string, PipelineRunArtifactReceiptV1>;
}

/** Work counters reported to host instrumentation after each projection. */
export interface AgentArtifactProjectionStats {
  turns: number;
  segments: number;
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function isActivePipelineRunStatus(
  value: string | undefined,
): value is PipelineRunArtifactReceiptV1['initialStatus'] {
  return value === 'pending' || value === 'running' || value === 'paused';
}

function isSkillShareScope(
  value: string | undefined,
): value is 'private' | 'team' | 'organization' {
  return value === 'private' || value === 'team' || value === 'organization';
}

function isSkillOwnerType(
  value: string | undefined,
): value is 'user' | 'team' | 'organization' {
  return value === 'user' || value === 'team' || value === 'organization';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ARTIFACT_DISPATCH_TOOL_NAMES = new Set([
  CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.displayName,
  CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.claudeToolName,
  CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName,
  ...CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.legacyToolNames,
  APP_ADVISOR_TOOL_REGISTRY.dispatch_action.displayName,
  APP_ADVISOR_TOOL_REGISTRY.dispatch_action.claudeToolName,
  APP_ADVISOR_TOOL_REGISTRY.dispatch_action.codexToolName,
]);

/**
 * True for the action-dispatch tool names whose successful results may carry
 * artifact receipts. Hosts use it to decide which externalized tool outputs
 * are worth resolving before projection.
 */
export function isArtifactDispatchTool(toolName: string): boolean {
  const pipelineEditorKey = getCanonicalPipelineEditorToolKey(toolName);
  return (
    ARTIFACT_DISPATCH_TOOL_NAMES.has(toolName) ||
    getCanonicalAppAdvisorToolKey(toolName) === 'dispatch_action' ||
    getCanonicalAppAdvisorToolKey(toolName) === 'show_capabilities' ||
    getCanonicalCanopyToolKey(toolName) === 'show_capabilities' ||
    // The workflow assistant's automation tools return the same action
    // response, receipts included, as DispatchAction's automation.* actions.
    pipelineEditorKey === 'automation_get' ||
    pipelineEditorKey === 'automation_create' ||
    pipelineEditorKey === 'automation_update'
  );
}

function textField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function actionFromInput(input: string): Record<string, unknown> | undefined {
  const parsed = parseJson(input);
  if (!isRecord(parsed)) return undefined;
  return isRecord(parsed.action) ? parsed.action : parsed;
}

function legacyReceipts(
  result: Record<string, unknown>,
  input: string,
): AgentArtifactReceiptV1[] {
  const action = actionFromInput(input);
  const operation = action ? textField(action, 'type') : undefined;
  if (!action || !operation) return [];

  try {
    if (
      [
        'skills.create_custom',
        'skills.update_custom',
        'skills.import_shared',
      ].includes(operation) &&
      isRecord(result.skill)
    ) {
      const installedName =
        textField(result.skill, 'name') ?? textField(result.skill, 'skillName');
      if (!installedName) return [];
      const sharedSkillId = textField(result, 'sharedSkillId');
      const description = textField(action, 'description');
      const originalName = textField(action, 'originalName');
      return [
        buildSkillArtifactReceipt({
          operation,
          source: 'installed',
          sourceId: 'custom:app',
          installedName,
          ...(sharedSkillId ? { sharedSkillId } : {}),
          name: installedName,
          ...(description ? { description } : {}),
          canUpdate: true,
          ...(operation === 'skills.update_custom' &&
          originalName &&
          originalName !== installedName
            ? {
                aliases: [
                  `canopy:skill:installed:custom%3Aapp:${encodeURIComponent(
                    originalName,
                  )}`,
                ],
              }
            : {}),
          navigationTarget: {
            kind: 'installed_skill',
            sourceId: 'custom:app',
            skillName: installedName,
          },
        }),
      ];
    }

    if (
      ['skills.share_custom', 'skills.update_shared'].includes(operation) &&
      isRecord(result.skill)
    ) {
      const sharedSkillId = textField(result.skill, 'id');
      const name = textField(result.skill, 'name');
      if (!sharedSkillId || !name) return [];
      const description = textField(result.skill, 'description');
      const rawShareScope = textField(result.skill, 'shareScope');
      const shareScope = isSkillShareScope(rawShareScope)
        ? rawShareScope
        : undefined;
      const rawOwner = result.skill.owner;
      const ownerType = isRecord(rawOwner)
        ? textField(rawOwner, 'type')
        : undefined;
      const ownerId = isRecord(rawOwner)
        ? textField(rawOwner, 'id')
        : undefined;
      const ownerName = isRecord(rawOwner)
        ? textField(rawOwner, 'name')
        : undefined;
      const owner =
        ownerId && isSkillOwnerType(ownerType)
          ? {
              type: ownerType,
              id: ownerId,
              ...(ownerName ? { name: ownerName } : {}),
            }
          : undefined;
      return [
        buildSkillArtifactReceipt({
          operation,
          source: 'shared',
          sharedSkillId,
          name,
          ...(description ? { description } : {}),
          ...(shareScope ? { shareScope } : {}),
          ...(owner ? { owner } : {}),
          canUpdate: result.skill.canUpdate === true,
          navigationTarget: { kind: 'shared_skill', skillId: sharedSkillId },
        }),
      ];
    }

    if (
      operation === 'pipeline.run' ||
      operation === 'pipeline.execution_retry' ||
      operation === 'pipeline.execution_resume'
    ) {
      const execution = isRecord(result.execution)
        ? result.execution
        : result.success === true && isRecord(result.data)
          ? result.data
          : operation !== 'pipeline.run' && textField(result, 'id')
            ? result
            : undefined;
      if (!execution) return [];
      const pipelineSnapshot = isRecord(execution.pipeline_snapshot)
        ? execution.pipeline_snapshot
        : undefined;
      const executionId = textField(execution, 'id');
      const pipelineId =
        textField(execution, 'pipelineId') ??
        textField(execution, 'pipeline_id');
      const pipelineName =
        textField(execution, 'name') ??
        (pipelineSnapshot ? textField(pipelineSnapshot, 'name') : undefined);
      const startedAt =
        textField(execution, 'startedAt') ?? textField(execution, 'started_at');
      const projectId =
        textField(execution, 'projectId') ??
        textField(execution, 'project_id') ??
        textField(action, 'projectId');
      const worktreeId =
        textField(execution, 'worktreeId') ??
        textField(execution, 'worktree_id') ??
        textField(action, 'worktreeId');
      const status = textField(execution, 'status');
      if (
        !executionId ||
        !pipelineId ||
        !pipelineName ||
        !startedAt ||
        !projectId ||
        !worktreeId ||
        !isActivePipelineRunStatus(status)
      ) {
        return [];
      }
      const repoId = textField(action, 'repoId');
      return [
        buildPipelineRunArtifactReceipt({
          operation,
          executionId,
          pipelineId,
          pipelineName,
          initialStatus: status,
          queuedAt: startedAt,
          createdAt: startedAt,
          ...(status === 'running' ? { startedAt } : {}),
          projectId,
          worktreeId,
          ...(repoId ? { repoId } : {}),
          navigationTarget: {
            kind: 'pipeline_execution',
            executionId,
            projectId,
            worktreeId,
          },
        }),
      ];
    }
  } catch {
    return [];
  }
  return [];
}

function receiptsFromResult(
  output: string,
  input: string,
): AgentArtifactReceiptV1[] {
  const parsed = parseJson(output);
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) {
    return [];
  }
  const canonical = serializeAgentArtifactReceipts(
    parsed.result.agentArtifacts,
  );
  if (canonical.length > 0) return canonical;

  // Narrow compatibility for early receipt-producing builds which returned a
  // singular receipt before the additive array contract was finalized. This
  // deliberately does not infer snapshots from response prose or arbitrary ids.
  const singular = serializeAgentArtifactReceipts([
    parsed.result.agentArtifact ?? parsed.result.artifactReceipt,
  ]);
  return singular.length > 0 ? singular : legacyReceipts(parsed.result, input);
}

interface ToolOwner {
  turnId: string;
  recognized: boolean;
  input: string;
}

interface ArtifactContribution {
  /** Turn that owns the dispatch call; may precede the segment's own turn. */
  turnId: string;
  toolUseId: string;
  /** Inputs the receipts were parsed from, so a recompute can reuse them. */
  output: string;
  input: string;
  receipts: AgentArtifactReceiptV1[];
  metadata?: AgentArtifactReceiptV1[];
}

/**
 * The projection of one user turn's message span (its user message through
 * the message before the next user message). A segment is reused verbatim
 * while its span still matches on artifact-relevant content and every tool
 * owner it resolved from earlier turns still resolves the same way.
 */
interface AgentArtifactSegment {
  messages: readonly PersistedChatMessage[];
  /** Tool calls declared inside this span, in declaration order. */
  ownersAdded: ReadonlyMap<string, ToolOwner>;
  /** Owners looked up from earlier turns (the carry this span consumed). */
  foreignOwners: ReadonlyMap<string, ToolOwner | undefined>;
  contributions: readonly ArtifactContribution[];
}

interface MergedTurnArtifacts {
  parts: readonly (readonly AgentArtifactReceiptV1[])[];
  carry: readonly AgentArtifactCarryReceiptV1[] | undefined;
  merged: AgentArtifactReceiptV1[];
}

/**
 * Per-transcript memo for `projectAgentArtifactsWithCarry`. The caller owns
 * it (for example via `useRef`) and the projection mutates it in place, the
 * same way `TurnGroupCache` works for `computeIncrementalTurnGroups`: a
 * streaming delta in the live turn must hand every completed turn the same
 * `agentArtifacts` array reference so `React.memo` can skip it.
 */
export interface AgentArtifactProjectionCache {
  segments: Map<string, AgentArtifactSegment>;
  turns: Map<string, MergedTurnArtifacts>;
  pipelineRuns: Record<string, PipelineRunArtifactReceiptV1>;
}

export function createEmptyAgentArtifactProjectionCache(): AgentArtifactProjectionCache {
  return { segments: new Map(), turns: new Map(), pipelineRuns: {} };
}

function toolOwnersMatch(
  a: ToolOwner | undefined,
  b: ToolOwner | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.turnId === b.turnId &&
    a.recognized === b.recognized &&
    a.input === b.input
  );
}

/**
 * True when two messages project to the same artifacts: same identity and
 * role, and identical tool_use / tool_result fields. Other block types never
 * feed the projection, so a streamed text delta does not bust the cache.
 */
function artifactInputsMatch(
  a: PersistedChatMessage,
  b: PersistedChatMessage,
): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.role !== b.role) return false;
  if (a.blocks.length !== b.blocks.length) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    const blockA = a.blocks[i];
    const blockB = b.blocks[i];
    if (blockA === blockB) continue;
    if (blockA.type !== blockB.type) return false;
    if (blockA.type === 'tool_use' && blockB.type === 'tool_use') {
      if (
        blockA.toolUseId !== blockB.toolUseId ||
        blockA.toolName !== blockB.toolName ||
        blockA.input !== blockB.input
      ) {
        return false;
      }
    }
    if (blockA.type === 'tool_result' && blockB.type === 'tool_result') {
      if (
        blockA.toolUseId !== blockB.toolUseId ||
        blockA.output !== blockB.output ||
        blockA.isError !== blockB.isError ||
        blockA.agentArtifacts !== blockB.agentArtifacts
      ) {
        return false;
      }
    }
  }
  return true;
}

function segmentReusable(
  segment: AgentArtifactSegment,
  messages: readonly PersistedChatMessage[],
  start: number,
  end: number,
  resolveOwner: (toolUseId: string) => ToolOwner | undefined,
): boolean {
  if (segment.messages.length !== end - start) return false;
  for (let i = 0; i < segment.messages.length; i++) {
    if (!artifactInputsMatch(segment.messages[i], messages[start + i])) {
      return false;
    }
  }
  let carryUnchanged = true;
  segment.foreignOwners.forEach((owner, toolUseId) => {
    if (carryUnchanged && !toolOwnersMatch(owner, resolveOwner(toolUseId))) {
      carryUnchanged = false;
    }
  });
  return carryUnchanged;
}

/**
 * Recompute one span. Tool results whose owner, input, and output are
 * unchanged from `previous` keep their parsed receipts array, so a span that
 * recomputes because a neighbour changed still hands unaffected turns the
 * same identities and skips the JSON parse.
 */
function computeSegment(
  messages: readonly PersistedChatMessage[],
  turnId: string,
  resolveOwner: (toolUseId: string) => ToolOwner | undefined,
  previous: AgentArtifactSegment | undefined,
): AgentArtifactSegment {
  const ownersAdded = new Map<string, ToolOwner>();
  const foreignOwners = new Map<string, ToolOwner | undefined>();
  const contributions: ArtifactContribution[] = [];
  const reusable = new Map<string, ArtifactContribution[]>();
  for (const contribution of previous?.contributions ?? []) {
    const queue = reusable.get(contribution.toolUseId) ?? [];
    queue.push(contribution);
    reusable.set(contribution.toolUseId, queue);
  }
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        ownersAdded.set(block.toolUseId, {
          turnId,
          recognized: isArtifactDispatchTool(block.toolName),
          input: block.input,
        });
        continue;
      }
      if (block.type !== 'tool_result' || block.isError) continue;
      let owner = ownersAdded.get(block.toolUseId);
      if (!owner) {
        owner = resolveOwner(block.toolUseId);
        foreignOwners.set(block.toolUseId, owner);
      }
      if (!owner?.recognized) continue;
      const queue = reusable.get(block.toolUseId);
      const cached = queue?.[0];
      if (
        cached &&
        cached.turnId === owner.turnId &&
        cached.input === owner.input &&
        cached.output === block.output &&
        cached.metadata === block.agentArtifacts
      ) {
        queue?.shift();
        contributions.push(cached);
        continue;
      }
      const retained = serializeAgentArtifactReceipts(block.agentArtifacts);
      const receipts = retained.length
        ? retained
        : receiptsFromResult(block.output, owner.input);
      if (receipts.length === 0) continue;
      contributions.push({
        turnId: owner.turnId,
        toolUseId: block.toolUseId,
        output: block.output,
        metadata: block.agentArtifacts,
        input: owner.input,
        receipts,
      });
    }
  }
  return { messages, ownersAdded, foreignOwners, contributions };
}

function partsMatch(
  a: readonly (readonly AgentArtifactReceiptV1[])[],
  b: readonly (readonly AgentArtifactReceiptV1[])[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function pipelineRunsMatch(
  a: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
  b: Readonly<Record<string, PipelineRunArtifactReceiptV1>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Project presentation-safe receipts from a persisted transcript. Tool calls
 * are owned by the most recent user turn; only successful, recognized action
 * dispatch results participate.
 */
export function projectAgentArtifacts(
  messages: readonly PersistedChatMessage[],
): AgentArtifactProjection {
  return projectAgentArtifactsWithCarry(messages);
}

/**
 * One turn's receipts: carry merged over the projected ones, then collapsed
 * so each item shows once (run > created/updated > recommended > found).
 */
export function mergeAgentArtifactTurn(
  projected: readonly AgentArtifactReceiptV1[] | undefined,
  carried: readonly AgentArtifactCarryReceiptV1[] | undefined,
): AgentArtifactReceiptV1[] {
  const merged = mergeAgentArtifactsByPrecedence(
    projected ?? [],
    carried ?? [],
  );
  const collapsed = collapseAgentArtifactsByItem(merged);
  return collapsed === merged ? merged : [...collapsed];
}

/**
 * Project the transcript one user turn at a time, merging persisted carry
 * into each owning turn. With a `cache`, turns whose artifact inputs are
 * unchanged keep their previous array identity; a turn is recomputed only
 * when its own span changes or an earlier turn it resolved a tool owner
 * from changes. Late tool results that land in a later span still attribute
 * to the turn that made the call, exactly as the uncached walk did.
 */
export function projectAgentArtifactsWithCarry(
  messages: readonly PersistedChatMessage[],
  carryByTurn?: AgentArtifactCarryByTurn,
  cache: AgentArtifactProjectionCache = createEmptyAgentArtifactProjectionCache(),
  onProjected?: (stats: AgentArtifactProjectionStats) => void,
): AgentArtifactProjection {
  const owners = new Map<string, ToolOwner>();
  const resolveOwner = (toolUseId: string): ToolOwner | undefined =>
    owners.get(toolUseId);
  const nextSegments = new Map<string, AgentArtifactSegment>();
  const orderedSegments: AgentArtifactSegment[] = [];
  let turnId: string | undefined;
  let start = 0;
  const flush = (end: number): void => {
    if (turnId === undefined) return;
    const cached = cache.segments.get(turnId);
    const segment =
      cached && segmentReusable(cached, messages, start, end, resolveOwner)
        ? cached
        : computeSegment(
            messages.slice(start, end),
            turnId,
            resolveOwner,
            cached,
          );
    segment.ownersAdded.forEach((owner, toolUseId) => {
      owners.set(toolUseId, owner);
    });
    nextSegments.set(turnId, segment);
    orderedSegments.push(segment);
  };
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role !== 'user' || messages[index].hidden) continue;
    flush(index);
    turnId = messages[index].id;
    start = index;
  }
  flush(messages.length);
  cache.segments = nextSegments;

  const partsByTurn = new Map<string, AgentArtifactReceiptV1[][]>();
  const pipelineRuns: Record<string, PipelineRunArtifactReceiptV1> = {};
  for (const segment of orderedSegments) {
    for (const contribution of segment.contributions) {
      const parts = partsByTurn.get(contribution.turnId) ?? [];
      parts.push(contribution.receipts);
      partsByTurn.set(contribution.turnId, parts);
      for (const receipt of contribution.receipts) {
        if (receipt.kind === 'pipeline_run') {
          pipelineRuns[receipt.executionId] = receipt;
        }
      }
    }
  }

  const turnIds: string[] = [];
  partsByTurn.forEach((_parts, id) => {
    turnIds.push(id);
  });
  for (const ownerId of Object.keys(carryByTurn ?? {})) {
    if (nextSegments.has(ownerId) && !partsByTurn.has(ownerId)) {
      turnIds.push(ownerId);
    }
  }
  const byTurn: Record<string, AgentArtifactReceiptV1[]> = {};
  const nextTurns = new Map<string, MergedTurnArtifacts>();
  for (const id of turnIds) {
    const parts = partsByTurn.get(id) ?? [];
    const carry = carryByTurn?.[id];
    const cached = cache.turns.get(id);
    const merged =
      cached && cached.carry === carry && partsMatch(cached.parts, parts)
        ? cached.merged
        : mergeAgentArtifactTurn(
            parts.reduce<AgentArtifactReceiptV1[]>(
              mergeAgentArtifactsByPrecedence,
              [],
            ),
            carry,
          );
    nextTurns.set(id, { parts, carry, merged });
    byTurn[id] = merged;
  }
  cache.turns = nextTurns;

  const chatInitiatedPipelineRuns = pipelineRunsMatch(
    cache.pipelineRuns,
    pipelineRuns,
  )
    ? cache.pipelineRuns
    : pipelineRuns;
  cache.pipelineRuns = chatInitiatedPipelineRuns;
  onProjected?.({
    turns: turnIds.length,
    segments: orderedSegments.length,
  });
  return { byTurn, chatInitiatedPipelineRuns };
}

/** How a chat turn relates to a pipeline run it lists. */
export type PipelineRunChatTurnRelation = 'launched' | 'watching';

export interface PipelineRunTurnLink {
  executionId: string;
  /** The owning (non-hidden) user message id. */
  userMessageId: string;
  relation: PipelineRunChatTurnRelation;
}

/**
 * One link per (run, turn) from a projection's merged per-turn receipts.
 * The merged receipt's operation decides the relation: a carried
 * `pipeline.watch` receipt is `watching`; run, resume and retry receipts are
 * `launched`. Turns follow `turnOrder` (transcript order); receipts outside
 * `scope` are ignored so links never cross a workspace/worktree.
 */
export function projectPipelineRunTurnLinks(
  projection: Pick<AgentArtifactProjection, 'byTurn'>,
  turnOrder: readonly string[],
  scope?: { projectId: string; worktreeId: string },
): PipelineRunTurnLink[] {
  const links: PipelineRunTurnLink[] = [];
  for (const userMessageId of turnOrder) {
    const receipts = projection.byTurn[userMessageId];
    if (!receipts) continue;
    const seen = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.kind !== 'pipeline_run') continue;
      if (
        scope &&
        (receipt.projectId !== scope.projectId ||
          receipt.worktreeId !== scope.worktreeId)
      ) {
        continue;
      }
      if (seen.has(receipt.executionId)) continue;
      seen.add(receipt.executionId);
      links.push({
        executionId: receipt.executionId,
        userMessageId,
        relation:
          receipt.operation === 'pipeline.watch' ? 'watching' : 'launched',
      });
    }
  }
  return links;
}
