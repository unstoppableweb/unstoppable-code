import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import { pullRequestReviewDispatchJsonSchema } from '@canopy/agent-actions';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type {
  ApprovalCheck,
  ApprovalRule,
} from '@canopy/execution-engine/types/approvals';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';
import type { WorktreeActionRuntime } from './worktree-actions';

/*
 * The agent actions a pipeline agent step may use (CAN-7742): posting a code
 * review as the GitHub App, and nothing else. Every host that serves a
 * pipeline agent (the terminal worker's route, the Ledger route of a Claude
 * action subprocess, a Codex step's dynamic tools and the daemon's owner
 * request) builds its runtime and tool definitions here, so the restriction
 * is the same on each. This module imports nothing from `mcp/` or
 * `pipelines/`: both import it.
 */

/** The only action types a pipeline agent step may search for or dispatch. */
export const PIPELINE_AGENT_ACTION_TYPES = [
  'pull_request.review.publish',
] as const;

/** The two agent action tools a pipeline agent step may list. */
export const PIPELINE_AGENT_ACTION_TOOL_KEYS = [
  'search_actions',
  'dispatch_action',
] as const;

export type PipelineAgentActionToolKey =
  (typeof PIPELINE_AGENT_ACTION_TOOL_KEYS)[number];

/** The step providers whose agent steps may receive the tools. */
export type PipelineAgentActionProvider = 'claude' | 'codex';

export function isPipelineAgentActionToolKey(
  key: unknown,
): key is PipelineAgentActionToolKey {
  return PIPELINE_AGENT_ACTION_TOOL_KEYS.some((candidate) => candidate === key);
}

/**
 * The scope of one pipeline agent's action calls. Every field comes from the
 * host's own run state, never from a tool call's arguments or a daemon's
 * request.
 */
export interface PipelineAgentActionScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly cwd: string;
  readonly executionId: string;
  readonly signal?: AbortSignal;
}

/** The chat id a pipeline agent's calls run under: no real chat. */
export function pipelineAgentActionChatId(executionId: string): string {
  return `pipeline:${executionId}`;
}

/**
 * The restricted worktree-action runtime of a pipeline agent: search returns
 * only the publish type and dispatch refuses every other type with
 * `unsupported_action` before any handler runs. It has no window and no
 * interface, so nothing it does reaches the UI.
 */
export function pipelineAgentActionRuntime(
  scope: PipelineAgentActionScope,
): WorktreeActionRuntime {
  return {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
    cwd: scope.cwd,
    allowedActionTypes: PIPELINE_AGENT_ACTION_TYPES,
    pipelineExecutionId: scope.executionId,
    ...(scope.signal ? { signal: scope.signal } : {}),
    getWindow: () => null,
    interfacePort: windowAgentInterfacePort(() => null),
  };
}

const SEARCH_ACTIONS_DESCRIPTION = `Find the ${BRAND.displayName} actions this workflow step may run. Only posting a code review to a GitHub pull request as the GitHub App (pull_request.review.publish) is available here.`;

/**
 * The Codex host bounds each dynamic tool call's arguments at 32 KiB
 * (`MAX_ARGUMENT_BYTES` in `codex-runtime/host-tools.ts`) and denies a larger
 * call with a message that doesn't name the cause, so the description does.
 */
const CODEX_ARGUMENT_LIMIT_NOTE =
  ' Keep the whole call under 32 KiB of arguments: a larger call is denied before anything is posted, so posting another way is then safe.';

function dispatchActionDescription(
  provider: PipelineAgentActionProvider,
): string {
  return `Post a code review to a GitHub pull request as the GitHub App, for this workflow step's project. Only pull_request.review.publish is available here; every other action is refused. Call ${CANOPY_INJECTED_TOOL_REGISTRY.search_actions.displayName} first for the payload's rules. A failed result whose reason is outcome_unknown may already have posted: never post the same review again another way.${provider === 'codex' ? CODEX_ARGUMENT_LIMIT_NOTE : ''}`;
}

const SEARCH_ACTIONS_SCHEMA: JsonValue = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search terms such as "publish review".',
    },
    actionType: { type: 'string', enum: [...PIPELINE_AGENT_ACTION_TYPES] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
};

const DISPATCH_ACTION_SCHEMA: JsonValue = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'object',
      required: [
        'type',
        'pullRequest',
        'body',
        'reviewedHead',
        'reviewedUncommitted',
        'verdict',
        'score',
        'complete',
      ],
      properties: {
        type: { type: 'string', enum: [...PIPELINE_AGENT_ACTION_TYPES] },
        ...pullRequestReviewDispatchJsonSchema.properties,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** One restricted tool, named for its provider. */
export interface PipelineAgentActionToolDefinition {
  readonly key: PipelineAgentActionToolKey;
  /** The MCP short name (Claude) or the dynamic tool name (Codex). */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

/**
 * The restricted SearchActions and DispatchAction definitions. Never the full
 * `dispatchActionJsonSchema`: every spec that crosses the daemon owner
 * channel must fit its 65,536-byte tool spec bound.
 */
export function pipelineAgentActionToolDefinitions(
  provider: PipelineAgentActionProvider,
): readonly PipelineAgentActionToolDefinition[] {
  return PIPELINE_AGENT_ACTION_TOOL_KEYS.map((key) => ({
    key,
    name:
      provider === 'codex'
        ? CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName
        : CANOPY_INJECTED_TOOL_REGISTRY[key].displayName,
    description:
      key === 'search_actions'
        ? SEARCH_ACTIONS_DESCRIPTION
        : dispatchActionDescription(provider),
    inputSchema:
      key === 'search_actions' ? SEARCH_ACTIONS_SCHEMA : DISPATCH_ACTION_SCHEMA,
  }));
}

/** The Claude names of the two tools on the brand's injected server. */
export function pipelineAgentActionClaudeToolNames(): string[] {
  return PIPELINE_AGENT_ACTION_TOOL_KEYS.map(
    (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
  );
}

/**
 * How a step's provider names one of the two tools to the approval policy:
 * Codex as an exact tool, Claude as a tool on the brand's injected server.
 */
export function pipelineAgentActionApprovalTarget(
  provider: PipelineAgentActionProvider,
  key: PipelineAgentActionToolKey,
): Extract<ApprovalCheck, { kind: 'tool' | 'mcp' }> {
  const tool = CANOPY_INJECTED_TOOL_REGISTRY[key];
  return provider === 'codex'
    ? { kind: 'tool', toolName: tool.codexToolName }
    : { kind: 'mcp', server: BRAND.tools.namespace, tool: tool.displayName };
}

/** Session rules allowing exactly the two tools for an unattended step. */
export function pipelineAgentActionApprovalRules(
  provider: PipelineAgentActionProvider,
): ApprovalRule[] {
  const createdAt = new Date().toISOString();
  return PIPELINE_AGENT_ACTION_TOOL_KEYS.map(
    (key): ApprovalRule => ({
      id: randomUUID(),
      behavior: 'allow',
      target: pipelineAgentActionApprovalTarget(provider, key),
      createdAt,
      origin: 'settings',
    }),
  );
}
