import { isDeepStrictEqual } from 'node:util';
import type {
  WorkerAgentSubagentRunResult,
  WorkerAgentTurnRunParams,
  WorkerAgentTurnRunResult,
} from '@canopy/protocol/canopy-core';
import { canonicalizeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/execution-engine/lib/codex-multi-agent';
import {
  agentRunLaunchUnavailableError,
  type SubagentExecutionWorker,
  type TurnEventSink,
  type TurnExecutionWorker,
} from '@canopy/core-runtime/node/agent/turns';
import type { AgentSessionOptions } from '../agents/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  stageAgentRun,
  takeStagedAgentRun,
  type StagedAgentRun,
} from './staged-agent-run';
import {
  TURN_LAUNCH_MEMBERS,
  resolveTurnLaunch,
  type PortableTurnSessionOptions,
  type TurnLaunchHostPort,
} from './turn-launch';

/** What the worker checks a turn's launch against while it serves the staged run (CAN-6995). */
export interface TurnLaunchShadow {
  /** The session options the staged run serves. */
  readonly options: AgentSessionOptions;
  readonly port: TurnLaunchHostPort;
}

export interface StagedTurn {
  readonly run: StagedAgentRun;
  /** Set by the worker handler before it serves. */
  attach(sink: TurnEventSink): void;
  /** Resolves with the host's settlement; see turn-runs.ts. */
  readonly settlement: Promise<WorkerAgentTurnRunResult>;
  /** The exact-turn Stop, called once when the worker signal aborts. */
  stop(): Promise<void>;
  readonly shadow?: TurnLaunchShadow;
}

export interface StagedSubagent {
  readonly run: StagedAgentRun;
  readonly settlement: Promise<WorkerAgentSubagentRunResult>;
}

// The staged run is the key, so a discarded stage leaves nothing behind.
const stagedTurns = new WeakMap<StagedAgentRun, StagedTurn>();
const stagedSubagents = new WeakMap<StagedAgentRun, StagedSubagent>();

export function stageTurn(turnRunId: string, turn: StagedTurn): void {
  if (turn.run.context.runId !== turnRunId || turn.run.context.kind !== 'turn')
    throw new Error('A staged turn must use its own turn run id.');
  stageAgentRun(turn.run);
  stagedTurns.set(turn.run, turn);
}

export function stageSubagent(
  subagentRunId: string,
  subagent: StagedSubagent,
): void {
  if (
    subagent.run.context.runId !== subagentRunId ||
    subagent.run.context.kind !== 'subagent'
  )
    throw new Error('A staged subagent must use its own subagent run id.');
  stageAgentRun(subagent.run);
  stagedSubagents.set(subagent.run, subagent);
}

const HOST_MEMBERS = new Set(
  Object.entries(TURN_LAUNCH_MEMBERS)
    .filter(([, kind]) => kind === 'host')
    .map(([member]) => member),
);

/**
 * The staged options as a session served from the launch reads them: no host
 * members or unset ones, both thinking fields in one canonical model config,
 * the subagent limit normalised, and no legacy fast-mode alias.
 */
function servedView(options: AgentSessionOptions): Map<string, unknown> {
  const view = new Map<string, unknown>(
    Object.entries(options).filter(
      ([member, value]) =>
        value !== undefined &&
        !HOST_MEMBERS.has(member) &&
        member !== 'codexFastModeEnabled',
    ),
  );
  const modelConfig = {
    ...options.modelConfig,
    ...(options.thinkingLevel !== undefined
      ? { thinkingLevel: options.thinkingLevel }
      : {}),
  };
  if (Object.keys(modelConfig).length > 0)
    view.set('modelConfig', canonicalizeAgentModelConfig(modelConfig));
  if (options.codexMaxConcurrentSubagents !== undefined)
    view.set(
      'codexMaxConcurrentSubagents',
      normalizeCodexMaxConcurrentSubagents(options.codexMaxConcurrentSubagents),
    );
  return view;
}

function differingMembers(
  staged: AgentSessionOptions,
  served: PortableTurnSessionOptions,
): string[] {
  const expected = servedView(staged);
  const actual = new Map<string, unknown>(Object.entries(served));
  return Array.from(new Set([...expected.keys(), ...actual.keys()]))
    .filter(
      (member) => !isDeepStrictEqual(expected.get(member), actual.get(member)),
    )
    .sort();
}

/**
 * Resolves the launch as a serving worker would and logs where it differs
 * from the staged run, by member name only. The staged run is served either
 * way (CAN-6995 S1b-2a).
 */
function checkLaunchShadow(
  params: WorkerAgentTurnRunParams,
  shadow: TurnLaunchShadow,
): void {
  if (!params.launch) return;
  const resolved = resolveTurnLaunch(params.launch, params, shadow.port);
  if (!resolved.ok) {
    logMainProcessWarn('[turn-worker] launch shadow mismatch', {
      turnRunId: params.turnRunId,
      unresolved: resolved.reason,
    });
    return;
  }
  const members = differingMembers(shadow.options, resolved.options);
  if (members.length > 0)
    logMainProcessWarn('[turn-worker] launch shadow mismatch', {
      turnRunId: params.turnRunId,
      members,
    });
}

function warnStopFailed(error: unknown): void {
  logMainProcessWarn('[turn-worker] The exact-turn Stop failed', error);
}

export const desktopTurnWorker: TurnExecutionWorker = {
  run: async (params, signal, sink): Promise<WorkerAgentTurnRunResult> => {
    const run = takeStagedAgentRun(params.turnRunId);
    const turn = run ? stagedTurns.get(run) : undefined;
    if (!turn) throw agentRunLaunchUnavailableError();
    if (turn.shadow) checkLaunchShadow(params, turn.shadow);
    turn.attach(sink);
    const onAbort = (): void => {
      void turn.stop().catch(warnStopFailed);
    };
    try {
      if (signal.aborted) {
        // Cancelled before serving: nothing reached a provider, so the run
        // is never taken and its expressions never run.
        await turn.stop().catch(warnStopFailed);
        return await turn.settlement;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      turn.run.take();
      return await turn.settlement;
    } finally {
      turn.run.close();
      signal.removeEventListener('abort', onAbort);
    }
  },
};

export const desktopSubagentWorker: SubagentExecutionWorker = {
  run: async (params): Promise<WorkerAgentSubagentRunResult> => {
    const run = takeStagedAgentRun(params.subagentRunId);
    const subagent = run ? stagedSubagents.get(run) : undefined;
    if (!subagent) throw agentRunLaunchUnavailableError();
    // The broker's own stop path stops a subagent (CAN-4115 D13).
    subagent.run.take();
    try {
      return await subagent.settlement;
    } finally {
      subagent.run.close();
    }
  },
};
