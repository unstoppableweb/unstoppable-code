import {
  ANNOTATION_GRANTS,
  CONFIG_GRANTS,
  CORE_CHAT_VISUAL_STAGE_GRANTS,
  CORE_PULL_REQUEST_GRANTS,
  CORE_INITIATED_WORK_WATCHER_GRANTS,
  CORE_AGENT_DEFERRED_TOOLS_GRANTS,
  LEDGER_GRANTS,
  MEMORY_GRANTS,
  WORKER_GIT_GRANTS,
  PIPELINE_GRANTS,
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_SCRIPT_GRANTS,
  WORKER_VISUAL_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';

export type AgentCoreOperationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/**
 * The only canonical operations Canopy agent tools may call (CAN-4125), by
 * tool family, with the grants each call carries. Adding a row is a
 * security-boundary change: it needs the CAN-4125 grant-diff review.
 */
export const AGENT_CORE_TOOL_OPERATIONS = {
  annotation: {
    'core.annotation.thread.get': [ANNOTATION_GRANTS.read],
    'core.annotation.thread.list': [ANNOTATION_GRANTS.read],
    'core.annotation.thread.reply': [ANNOTATION_GRANTS.write],
  },
  ledger: {
    'core.ledger.entries.search': [LEDGER_GRANTS.read],
    'core.ledger.entry.get': [LEDGER_GRANTS.read],
    'core.ledger.owners.list': [LEDGER_GRANTS.read],
    'core.ledger.workSummary.get': [LEDGER_GRANTS.read],
    'core.ledger.entry.add': [LEDGER_GRANTS.write],
    'core.ledger.entry.update': [LEDGER_GRANTS.write],
  },
  chatActions: {
    'core.chat.message.send': ['core.chat.write'],
  },
  baseBranch: {
    'worker.git.branch.list': [WORKER_GIT_GRANTS.read],
    'core.pullRequest.get': [CORE_PULL_REQUEST_GRANTS.read],
    'core.pullRequest.update': [CORE_PULL_REQUEST_GRANTS.write],
  },
  scriptOutput: {
    'worker.script.execution.get': [WORKER_SCRIPT_GRANTS.read],
  },
  codeGraph: {
    'worker.codeGraph.query': [WORKER_CODE_GRAPH_GRANTS.read],
    'worker.codeGraph.status.get': [WORKER_CODE_GRAPH_GRANTS.read],
    'worker.codeGraph.build': [WORKER_CODE_GRAPH_GRANTS.write],
  },
  pipelineYaml: {
    'core.pipeline.definition.get': [PIPELINE_GRANTS.read],
  },
  gitPreferences: {
    'core.config.get': [CONFIG_GRANTS.read],
  },
  memory: {
    'core.memory.search': [MEMORY_GRANTS.read],
    'core.memory.entry.get': [MEMORY_GRANTS.read],
    'core.memory.entry.append': [MEMORY_GRANTS.write],
  },
  watchers: {
    'core.initiatedWork.watcher.list': [
      CORE_INITIATED_WORK_WATCHER_GRANTS.read,
    ],
    'core.initiatedWork.watcher.create': [
      CORE_INITIATED_WORK_WATCHER_GRANTS.write,
    ],
    'core.initiatedWork.watcher.delete': [
      CORE_INITIATED_WORK_WATCHER_GRANTS.write,
    ],
  },
  deferredTools: {
    'core.agent.deferredTools.search': [
      CORE_AGENT_DEFERRED_TOOLS_GRANTS.search,
    ],
    'core.agent.deferredTools.load': [CORE_AGENT_DEFERRED_TOOLS_GRANTS.load],
  },
  visuals: {
    'core.chat.visual.stage': [CORE_CHAT_VISUAL_STAGE_GRANTS.write],
    'worker.visual.render': [WORKER_VISUAL_GRANTS.render],
  },
  autoArchive: {
    'core.chat.update': ['core.chat.write'],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type AgentToolFamily = keyof typeof AGENT_CORE_TOOL_OPERATIONS;

export class AgentToolOperationRefusedError extends Error {
  constructor(
    readonly family: AgentToolFamily,
    readonly operation: string,
  ) {
    super('This tool cannot call that operation.');
    this.name = 'AgentToolOperationRefusedError';
  }
}

function narrowed<Options extends { caller: CanopyCallerDescriptor }>(
  grants: readonly string[],
  options: Options,
): Options {
  return {
    ...options,
    caller: {
      ...options.caller,
      grants: options.caller.grants.filter((grant) => grants.includes(grant)),
    },
  };
}

/**
 * A dispatcher for one tool family: an operation outside the family's row
 * rejects with AgentToolOperationRefusedError before the dispatcher is
 * called; an allowed call goes through with the caller's grants narrowed to
 * that operation's row. It never adds a grant. A function is resolved on
 * each call.
 */
export function agentCoreOperations(
  family: AgentToolFamily,
  dispatcher:
    | AgentCoreOperationDispatcher
    | (() => AgentCoreOperationDispatcher),
): AgentCoreOperationDispatcher {
  const target = (): AgentCoreOperationDispatcher =>
    typeof dispatcher === 'function' ? dispatcher() : dispatcher;
  const row: Readonly<Record<string, readonly string[]>> =
    AGENT_CORE_TOOL_OPERATIONS[family];
  const granted = (name: string): readonly string[] | undefined =>
    Object.prototype.hasOwnProperty.call(row, name) ? row[name] : undefined;
  return {
    query: (name, params, options) => {
      const grants = granted(name);
      return grants === undefined
        ? Promise.reject(new AgentToolOperationRefusedError(family, name))
        : target().query(name, params, narrowed(grants, options));
    },
    instruction: (name, params, options) => {
      const grants = granted(name);
      return grants === undefined
        ? Promise.reject(new AgentToolOperationRefusedError(family, name))
        : target().instruction(name, params, narrowed(grants, options));
    },
  };
}

/**
 * As {@link agentCoreOperations}, for a dispatcher that only sends
 * instructions; every query is refused before dispatch.
 */
export function agentCoreInstructions(
  family: AgentToolFamily,
  dispatcher: Pick<AgentCoreOperationDispatcher, 'instruction'>,
): Pick<AgentCoreOperationDispatcher, 'instruction'> {
  return agentCoreOperations(family, {
    query: (name) =>
      Promise.reject(new AgentToolOperationRefusedError(family, name)),
    instruction: (name, params, options) =>
      dispatcher.instruction(name, params, options),
  });
}
