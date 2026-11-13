import {
  LEDGER_ERROR_CODES,
  LEDGER_GRANTS,
  LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_QUERY_DEFINITIONS,
  LedgerErrorDetailsSchema,
  type CanopyCallerDescriptor,
  type LedgerErrorDetails,
  type LedgerGlobalOwner,
  type WorkerPipelineOwnerLedgerOperation,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  createCanopyDispatcher,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { buildLedgerToolPrompt } from '../../lib/ledger-tools/prompt';
import type { LedgerCallerBindingRegistration } from './caller-bindings';
import {
  LedgerChatToolsSession,
  type LedgerHarness,
  type LedgerPipelineAgentCaller,
  type LedgerToolsBindingRegistry,
  type LedgerToolsHost,
} from './runtime';

/*
 * The Feed tools of one pipeline agent attempt whose owner is remote: a cloud
 * run's web core (CAN-6422). The shared tools runtime runs here, beside the
 * step, as it runs in Electron main for desktop runs, and every Ledger
 * operation it dispatches becomes one `owner.ledger.operation` request for
 * the attempt the owner opened. The owner acts as that attempt, validates
 * each operation's params and enforces the Ledger's rules; the runner keeps
 * no Ledger of its own.
 *
 * The gate that decides whether a step gets Feed tools is the owner's: it
 * answered `owner.ledger.open` with an attempt. The runner checks no flag or
 * setting of its own.
 */

/** What the owner answers one Ledger operation with. */
export type RemoteLedgerOutcome =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'refused'; readonly error: LedgerErrorDetails };

/**
 * Sends one Ledger operation to the owner for the attempt. An abort of the
 * call withdraws the request, so a cancelled call writes nothing more.
 */
export type RemoteLedgerOperate = (
  operation: WorkerPipelineOwnerLedgerOperation,
  params: unknown,
  signal: AbortSignal,
) => Promise<RemoteLedgerOutcome>;

/** The owner's refusal, as the tools runtime renders a Ledger refusal. */
function refusal(details: LedgerErrorDetails): CanopyOperationError {
  // The runtime renders a refusal from its details alone.
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message: 'The Feed refused the request.',
    code: LEDGER_ERROR_CODES[details.reason],
    details: LedgerErrorDetailsSchema.parse(details),
    retry: { kind: 'never' },
  });
}

/** What an operation the cloud does not serve answers. */
function unserved(): CanopyOperationError {
  return refusal({ reason: 'WRITER_UNAVAILABLE' });
}

/**
 * A dispatcher over the owner: the Ledger operations the agent tools use,
 * each validated on the way out and back by the operation's own schemas.
 */
function remoteLedgerDispatcher(
  operate: RemoteLedgerOperate,
): LedgerToolsHost['dispatcher'] {
  const run = async <Result>(
    operation: WorkerPipelineOwnerLedgerOperation,
    params: unknown,
    context: CanopyHandlerContext,
    parse: (value: unknown) => Result,
  ): Promise<Result> => {
    const outcome = await operate(operation, params, context.signal);
    if (outcome.kind === 'refused') throw refusal(outcome.error);
    return parse(outcome.result);
  };
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: LEDGER_QUERY_DEFINITIONS,
      instructions: LEDGER_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {
        'core.ledger.entries.search': (params, context) =>
          run('core.ledger.entries.search', params, context, (value) =>
            LEDGER_QUERY_DEFINITIONS['core.ledger.entries.search'].result.parse(
              value,
            ),
          ),
        'core.ledger.entry.get': (params, context) =>
          run('core.ledger.entry.get', params, context, (value) =>
            LEDGER_QUERY_DEFINITIONS['core.ledger.entry.get'].result.parse(
              value,
            ),
          ),
        'core.ledger.owners.list': (params, context) =>
          run('core.ledger.owners.list', params, context, (value) =>
            LEDGER_QUERY_DEFINITIONS['core.ledger.owners.list'].result.parse(
              value,
            ),
          ),
        'core.ledger.changes.list': () => Promise.reject(unserved()),
        'core.ledger.rollups.list': () => Promise.reject(unserved()),
        'core.ledger.workSummary.get': () => Promise.reject(unserved()),
      },
      instructions: {
        'core.ledger.entry.add': (params, context) =>
          run('core.ledger.entry.add', params, context, (value) =>
            LEDGER_INSTRUCTION_DEFINITIONS[
              'core.ledger.entry.add'
            ].result.parse(value),
          ),
        'core.ledger.entry.update': (params, context) =>
          run('core.ledger.entry.update', params, context, (value) =>
            LEDGER_INSTRUCTION_DEFINITIONS[
              'core.ledger.entry.update'
            ].result.parse(value),
          ),
        'core.ledger.summary.publish': () => Promise.reject(unserved()),
      },
      streams: {},
    },
  });
  return () => dispatcher;
}

/** Bindings kept for this attempt only; the owner holds the real one. */
function memoryRegistry(): LedgerToolsBindingRegistry {
  const bindings = new Map<string, LedgerCallerBindingRegistration>();
  let next = 0;
  return {
    register: (registration) => {
      next += 1;
      const id = `remote-ledger-binding-${String(next)}`;
      bindings.set(id, registration);
      return id;
    },
    resolve: (bindingId) => bindings.get(bindingId),
    revoke: (bindingId) => bindings.delete(bindingId),
  };
}

function callerFor(bindingId: string): CanopyCallerDescriptor {
  return {
    principalId: bindingId,
    clientInstanceId: 'pipeline-runner',
    authorityId: 'pipeline-runner',
    interfaceKind: 'daemon',
    grants: [LEDGER_GRANTS.read, LEDGER_GRANTS.write],
  };
}

/** A fixed creation time: the owner binds the real scope. */
const REMOTE_SCOPE_CREATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Opens the Feed tools of an attempt the remote owner opened, in the run
 * owner's global (workflow) Ledger: every cloud run is global today.
 */
export function openRemoteLedgerTools(options: {
  readonly executionId: string;
  readonly harness: LedgerHarness;
  readonly owner: LedgerGlobalOwner;
  readonly pipelineAgent: Omit<LedgerPipelineAgentCaller, 'executionId'>;
  readonly settings: {
    readonly model: string | null;
    readonly thinkingEffort: string | null;
    readonly mode: string;
  };
  readonly operate: RemoteLedgerOperate;
}): LedgerChatToolsSession {
  const registry = memoryRegistry();
  const host: LedgerToolsHost = {
    dispatcher: remoteLedgerDispatcher(options.operate),
    registry: () => registry,
    agentDispatcher: (dispatcher) => dispatcher,
    caller: callerFor,
    systemPrompt: (session) =>
      buildLedgerToolPrompt(session.harness, {
        ...(session.toolNames ? { toolNames: session.toolNames } : {}),
        planModeException: false,
        pipelineAgent: true,
        globalScope: true,
      }),
    isFlagEnabled: () => true,
    isRecordingEnabled: () => Promise.resolve(true),
    workspaceType: () => null,
    containerCreatedAt: () => Promise.resolve(REMOTE_SCOPE_CREATED_AT),
    chatTitle: () => Promise.resolve(null),
    databaseMayExist: () => Promise.resolve(true),
  };
  return new LedgerChatToolsSession({
    target: {
      projectId: 'pipeline-runner',
      worktreeId: options.executionId,
      chatId: `pipeline:${options.executionId}`,
    },
    scope: {
      container: { kind: 'global', owner: options.owner },
      containerCreatedAt: REMOTE_SCOPE_CREATED_AT,
    },
    harness: options.harness,
    readSettings: () => ({
      model: options.settings.model,
      thinkingEffort: options.settings.thinkingEffort,
      planMode: options.settings.mode === 'plan',
      mode: options.settings.mode,
    }),
    pipelineAgent: {
      ...options.pipelineAgent,
      executionId: options.executionId,
    },
    host,
  });
}
