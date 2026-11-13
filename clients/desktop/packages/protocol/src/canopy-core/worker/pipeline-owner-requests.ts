import { z } from 'zod';

import { canopyJsonValueSchemaWithin } from '../errors';
import { LedgerErrorDetailsSchema } from '../core/ledger/schemas';

/*
 * Pipeline owner requests (CAN-5095): what a model step asks the core that
 * owns its run while it runs, raised on worker.pipeline.hostRequests beside
 * host steps. They name a step's harness, model and route session, never a
 * key. Capabilities in an answer (route URLs, Ledger route tokens) return
 * host-locally in _execution.pipelineOwnerValues, never here. `cwd` is a host
 * path for the core on the worker's own host.
 *
 * A remote owner, the web core over the relay (CAN-6161, ADR 31), settles
 * them too, with three differences: it never receives the local-only
 * requests, the Ledger tool requests reach it without `cwd`, and its answers
 * name capabilities by non-secret `routeId`, which the worker resolves to
 * host-local values itself.
 *
 * `owner.plan.*` (CAN-6327) return what a run wrote to its `plan_path` to the
 * owner's plans: desktop's tracked plans, or the web core's cloud plans. The
 * owner knows the run's scope, so a request names no workspace or path, and
 * it refuses a plan id that is not the run's own.
 *
 * `owner.mcp.*` (CAN-6168) present a plugin MCP server's OAuth credential to
 * one upstream request without the token ever being stored in the worker. The
 * worker names a plugin server and the hash of the declaration it read; the
 * owner reads the declaration itself, refuses any difference, and decides the
 * credential and upstream from its own read. One authorization's header
 * returns host-locally in _execution.pipelineOwnerValues, never here.
 */

const id = z.string().min(1).max(512);
const model = z.string().min(1).max(512);
const routeSessionId = z.string().min(1).max(3072);
const text = (max: number): z.ZodString => z.string().max(max);
const harness = z.enum(['claude', 'codex']);
const hostPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));

export const WORKER_PIPELINE_OWNER_ACTIONS = [
  'owner.model.invocation',
  'owner.model.routing',
  'owner.model.release',
  'owner.model.policy',
  'owner.model.policyRefusal',
  'owner.ledger.open',
  'owner.ledger.subprocessTools',
  'owner.ledger.close',
  'owner.ledger.codexTools',
  'owner.ledger.codexToolAuthorize',
  'owner.ledger.codexToolExecute',
  'owner.ledger.codexToolsDispose',
  'owner.ledger.operation',
  'owner.claude.modAdmission',
  'owner.model.agentAlias',
  'owner.plan.create',
  'owner.plan.update',
  'owner.mcp.bind',
  'owner.mcp.authorize',
  'owner.mcp.rejected',
] as const;
export type WorkerPipelineOwnerAction =
  (typeof WORKER_PIPELINE_OWNER_ACTIONS)[number];

/**
 * Owner requests only the worker's own host can answer (CAN-6161), so a
 * worker with a remote owner answers them itself and never raises them.
 * `owner.claude.modAdmission` reads the Claude config folder on the host the
 * step runs on, and its answer carries that folder's install paths.
 * `owner.mcp.*` present a credential the host's own app holds (CAN-6168).
 */
export const WORKER_PIPELINE_LOCAL_OWNER_ACTIONS = [
  'owner.claude.modAdmission',
  'owner.mcp.bind',
  'owner.mcp.authorize',
  'owner.mcp.rejected',
] as const satisfies readonly WorkerPipelineOwnerAction[];
export type WorkerPipelineLocalOwnerAction =
  (typeof WORKER_PIPELINE_LOCAL_OWNER_ACTIONS)[number];

/**
 * A non-secret reference to a capability a remote owner granted (P9,
 * CAN-6161), such as an LLM proxy route: the worker resolves it with
 * credentials it holds from bootstrap. Never a key, URL or token.
 */
export const WORKER_PIPELINE_ROUTE_ID_PATTERN = /^route_[A-Za-z0-9_-]{8,128}$/;
const routeId = z.string().regex(WORKER_PIPELINE_ROUTE_ID_PATTERN);

/** The largest tool call or tool response that crosses, as UTF-8 JSON. */
export const WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES = 1024 * 1024;

const toolJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_TOOL_JSON_MAX_BYTES,
);
const toolSpec = canopyJsonValueSchemaWithin(65_536);

/**
 * The Ledger operations a remote owner serves for an open attempt
 * (`owner.ledger.operation`, CAN-6422): what the Feed tools runtime
 * dispatches when it runs beside the step instead of in its owner.
 */
export const WORKER_PIPELINE_OWNER_LEDGER_OPERATIONS = [
  'core.ledger.entries.search',
  'core.ledger.entry.get',
  'core.ledger.owners.list',
  'core.ledger.entry.add',
  'core.ledger.entry.update',
] as const;
export type WorkerPipelineOwnerLedgerOperation =
  (typeof WORKER_PIPELINE_OWNER_LEDGER_OPERATIONS)[number];

/** The longest Ledger operation params or result that crosses, as UTF-8 JSON. */
export const WORKER_PIPELINE_OWNER_LEDGER_JSON_MAX_BYTES = 1024 * 1024;
const ledgerJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_LEDGER_JSON_MAX_BYTES,
);

/** The longest plan content a plan request carries, as UTF-8: a shared plan's limit. */
export const WORKER_PIPELINE_OWNER_PLAN_CONTENT_MAX_BYTES = 1024 * 1024;

const planContent = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <=
      WORKER_PIPELINE_OWNER_PLAN_CONTENT_MAX_BYTES,
    'The plan exceeds its limit.',
  );

/** At most this many Mod admissions, ambient plugins or session Mod ids cross. */
export const WORKER_PIPELINE_OWNER_MOD_LIST_MAX = 1024;
const modPluginId = z.string().min(1).max(512);
const modList = <T extends z.ZodType>(item: T): z.ZodArray<T> =>
  z.array(item).max(WORKER_PIPELINE_OWNER_MOD_LIST_MAX);

/**
 * A Claude step's Mod policy and the ambient plugins of its Claude config
 * folder (CAN-5095): flags, admission records, plugin ids and install paths.
 * No secret crosses.
 */
const ClaudeModAdmissionContextSchema = z.strictObject({
  enabled: z.boolean(),
  claudeConfigDir: hostPath.optional(),
  authority: z.enum(['ok', 'absent', 'unreadable']),
  admissions: modList(
    z.strictObject({
      pluginId: modPluginId,
      contentDigest: z.string().min(1).max(256),
      admittedAt: z.string().min(1).max(64),
    }),
  ),
  modsDisabled: z.boolean(),
  ambientPlugins: modList(
    z.strictObject({
      pluginId: modPluginId,
      installPath: hostPath.nullable(),
      notLoaded: z.literal(true).optional(),
    }),
  ),
  sessionModIds: modList(modPluginId).optional(),
});

/** An Agent model id, as a workflow model alias names it (CAN-5832). */
const agentModelId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.startsWith('agent_model_'));

/** An owner's opaque handle on one MCP route it bound for one run (CAN-6168). */
export const WORKER_PIPELINE_MCP_ROUTE_REF_PATTERN =
  /^mcpr1_[A-Za-z0-9_-]{22}$/;
/** An owner's handle on one authorization it presented (CAN-6168). */
export const WORKER_PIPELINE_MCP_GRANT_ID_PATTERN = /^mcpg1_[A-Za-z0-9_-]{22}$/;
/** SHA-256 of a plugin MCP server's declaration, as lowercase hex. */
export const WORKER_PIPELINE_MCP_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const mcpRouteRef = z.string().regex(WORKER_PIPELINE_MCP_ROUTE_REF_PATTERN);
const mcpGrantId = z.string().regex(WORKER_PIPELINE_MCP_GRANT_ID_PATTERN);

/** At most this much plugin selection JSON crosses for one Agent (CAN-5832). */
export const WORKER_PIPELINE_OWNER_AGENT_PLUGINS_MAX_BYTES = 65_536;

const routingContext = {
  allowNoNativeAuthFallback: z.boolean().optional(),
  checkpointProxyQuota: z.boolean().optional(),
  requiredAccountProxyConnectionId: id.optional(),
};

/** Members added to WorkerPipelineHostActionRequestSchema's union. */
export const WORKER_PIPELINE_OWNER_REQUEST_MEMBERS = [
  z.strictObject({
    action: z.literal('owner.model.invocation'),
    harness,
    model: model.optional(),
    routeSessionId: routeSessionId.optional(),
    ...routingContext,
  }),
  z.strictObject({
    action: z.literal('owner.model.routing'),
    provider: harness,
    model: model.optional(),
    routeSessionId: routeSessionId.optional(),
    ...routingContext,
  }),
  z.strictObject({
    action: z.literal('owner.model.release'),
    routeSessionId,
  }),
  z
    .strictObject({
      action: z.literal('owner.model.policy'),
      check: z.enum(['blocked', 'active']),
      modelId: model.optional(),
    })
    .refine(
      (value) => (value.check === 'blocked') === (value.modelId !== undefined),
    ),
  z.strictObject({
    action: z.literal('owner.model.policyRefusal'),
    modelId: model,
  }),
  z.strictObject({
    action: z.literal('owner.ledger.open'),
    pipelineId: id.optional(),
    pipelineName: text(1024).optional(),
    physicalJobId: id,
    logicalJobId: id,
    jobName: text(1024),
    stepId: id,
    stepName: text(1024),
    attempt: z.number().int().min(0),
    iteration: z.number().int().min(0),
    resumedAgentSessionId: id.optional(),
    predecessorAgentSessionId: id.optional(),
    checkpointId: id.optional(),
    harness,
    model: model.optional(),
    thinkingEffort: text(64).optional(),
    permissionPreset: z.string().min(1).max(64),
  }),
  z.strictObject({
    action: z.literal('owner.ledger.subprocessTools'),
    attemptKey: id,
    /** The step's folder; absent for a remote owner, whose tools are hosted (CAN-6161). */
    cwd: hostPath.optional(),
  }),
  z.strictObject({
    action: z.literal('owner.ledger.close'),
    attemptKey: id,
    outcome: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('settled') }),
      z.strictObject({
        kind: z.literal('paused'),
        checkpointId: id,
        pausedAt: z.iso.datetime({ offset: true }),
      }),
    ]),
  }),
  z.strictObject({
    action: z.literal('owner.ledger.codexTools'),
    attemptKey: id,
    /** The step's folder; absent for a remote owner, whose tools are hosted (CAN-6161). */
    cwd: hostPath.optional(),
  }),
  z.strictObject({
    action: z.literal('owner.ledger.codexToolAuthorize'),
    toolsKey: id,
    threadId: id,
    call: toolJson,
  }),
  z.strictObject({
    action: z.literal('owner.ledger.codexToolExecute'),
    toolsKey: id,
    threadId: id,
    call: toolJson,
  }),
  z.strictObject({
    action: z.literal('owner.ledger.codexToolsDispose'),
    toolsKey: id,
  }),
  /**
   * One Ledger operation for an open attempt, as the attempt's agent
   * (CAN-6422). Only a remote owner receives it: the runner's Feed tools
   * dispatch through it. The owner validates `params` with the operation's
   * own params schema, and acts as the attempt's binding, never as anyone
   * the params name.
   */
  z.strictObject({
    action: z.literal('owner.ledger.operation'),
    attemptKey: id,
    operation: z.enum(WORKER_PIPELINE_OWNER_LEDGER_OPERATIONS),
    params: ledgerJson,
  }),
  z.strictObject({
    action: z.literal('owner.claude.modAdmission'),
    cwd: hostPath,
    settingSources: z.array(z.enum(['user', 'project', 'local'])).max(3),
    claudeConfigDir: hostPath.optional(),
  }),
  z.strictObject({
    action: z.literal('owner.model.agentAlias'),
    agentId: agentModelId,
  }),
  /** Keeps the plan a run produced, which it had no plan for (CAN-6327). */
  z.strictObject({
    action: z.literal('owner.plan.create'),
    content: planContent,
    /**
     * Raised as the run starts: keeps the plan only while the run keeps none
     * yet, so a start-time write that lands late never replaces the plan the
     * run's end kept. Without it a run that already keeps a plan records the
     * content as its new revision.
     */
    initial: z.literal(true).optional(),
  }),
  /**
   * Links the run to its plan, records `content` as a new revision when the
   * run changed it, and approves the plan once the run ends (`approve`).
   */
  z.strictObject({
    action: z.literal('owner.plan.update'),
    planId: id,
    content: planContent.optional(),
    approve: z.boolean(),
  }),
  /**
   * Binds the OAuth credential of one plugin HTTP MCP server for the run
   * (CAN-6168). Names the server and the hash of the declaration the worker
   * read; nothing else, so no OAuth definition, URL or client crosses.
   */
  z.strictObject({
    action: z.literal('owner.mcp.bind'),
    marketplaceId: id,
    pluginName: id,
    serverName: z.string().min(1).max(256),
    contentHash: z.string().regex(WORKER_PIPELINE_MCP_CONTENT_HASH_PATTERN),
  }),
  /** One authorization for one upstream request on a bound route. */
  z.strictObject({
    action: z.literal('owner.mcp.authorize'),
    routeRef: mcpRouteRef,
  }),
  /** The upstream answered 401 to the authorization `grantId` presented. */
  z.strictObject({
    action: z.literal('owner.mcp.rejected'),
    grantId: mcpGrantId,
  }),
] as const;

/** What core answers an owner request with, apart from host-local values. */
export const WorkerPipelineOwnerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('model.invocation'),
    source: z.string().min(1).max(64),
    harness: z.string().min(1).max(64),
    runtimeModel: z.string().max(512),
    aiCreditsRouted: z.boolean(),
    modelGatewayRouted: z.boolean(),
    accountProxyRouted: z.boolean(),
    accountProxyConnectionId: id.optional(),
    /** A remote owner's route (P9, CP-68): the worker resolves it to the step's provider environment. */
    routeId: routeId.optional(),
  }),
  z.strictObject({
    kind: z.literal('model.routing'),
    override: z
      .strictObject({
        provider: harness,
        model,
        modelGatewayRouted: z.boolean(),
        accountProxyRouted: z.boolean(),
        accountProxyConnectionId: id.optional(),
        /** A remote owner's route (P9): the worker resolves it to the step's provider environment. */
        routeId: routeId.optional(),
      })
      .nullable(),
  }),
  z.strictObject({ kind: z.literal('model.release') }),
  z.strictObject({ kind: z.literal('model.policy'), answer: z.boolean() }),
  z.strictObject({ kind: z.literal('model.policyRefusal') }),
  z.strictObject({
    kind: z.literal('ledger.open'),
    attempt: z
      .strictObject({
        attemptKey: id,
        agentSessionId: id,
        instructions: text(65_536),
      })
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('ledger.subprocessTools'),
    /** A remote owner's hosted Feed tools (CAN-6161): the worker resolves them to the step's MCP servers. */
    routeId: routeId.optional(),
  }),
  z.strictObject({ kind: z.literal('ledger.close') }),
  z.strictObject({
    kind: z.literal('ledger.codexTools'),
    tools: z
      .strictObject({
        toolsKey: id,
        instructions: text(65_536),
        specs: z.array(toolSpec).max(64),
        allowedTools: z
          .array(
            z.strictObject({
              namespace: z.string().max(256).nullable(),
              tool: z.string().min(1).max(256),
            }),
          )
          .max(64),
        timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      })
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('ledger.codexToolAuthorize'),
    authorized: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('ledger.codexToolExecute'),
    response: toolJson,
  }),
  z.strictObject({ kind: z.literal('ledger.codexToolsDispose') }),
  z.strictObject({
    kind: z.literal('ledger.operation'),
    /** The operation's result, or the Ledger's typed refusal of it. */
    outcome: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('result'), result: ledgerJson }),
      z.strictObject({
        kind: z.literal('refused'),
        error: LedgerErrorDetailsSchema,
      }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('claude.modAdmission'),
    /** Null while Claude Mod admission is off for this app. */
    context: ClaudeModAdmissionContextSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('model.agentAlias'),
    /** Null when the Agent is not available locally (CAN-5832). */
    alias: z
      .strictObject({
        agentId: agentModelId,
        name: text(4096),
        base: model,
        instructions: text(65_536).optional(),
        /** The Agent's plugin selections, as data; no secret crosses. */
        pluginSelections: canopyJsonValueSchemaWithin(
          WORKER_PIPELINE_OWNER_AGENT_PLUGINS_MAX_BYTES,
        ).optional(),
      })
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal('plan.create'),
    /** The plan the owner keeps; null when it keeps none for this run. */
    planId: id.nullable(),
  }),
  z.strictObject({ kind: z.literal('plan.update') }),
  z.strictObject({
    kind: z.literal('mcp.bind'),
    /** Null when the owner refuses: the step does not reach that server. */
    routeRef: mcpRouteRef.nullable(),
  }),
  z.strictObject({
    kind: z.literal('mcp.authorize'),
    /** Null when the owner holds no usable credential; the header is a host-local value. */
    grantId: mcpGrantId.nullable(),
  }),
  z.strictObject({ kind: z.literal('mcp.rejected') }),
]);
export type WorkerPipelineOwnerResult = z.output<
  typeof WorkerPipelineOwnerResultSchema
>;
export type WorkerPipelineOwnerRequest = z.output<
  (typeof WORKER_PIPELINE_OWNER_REQUEST_MEMBERS)[number]
>;

/** The result kind each owner action is answered with. */
export const WORKER_PIPELINE_OWNER_RESULT_KIND: Readonly<
  Record<WorkerPipelineOwnerAction, WorkerPipelineOwnerResult['kind']>
> = Object.freeze({
  'owner.model.invocation': 'model.invocation',
  'owner.model.routing': 'model.routing',
  'owner.model.release': 'model.release',
  'owner.model.policy': 'model.policy',
  'owner.model.policyRefusal': 'model.policyRefusal',
  'owner.ledger.open': 'ledger.open',
  'owner.ledger.subprocessTools': 'ledger.subprocessTools',
  'owner.ledger.close': 'ledger.close',
  'owner.ledger.codexTools': 'ledger.codexTools',
  'owner.ledger.codexToolAuthorize': 'ledger.codexToolAuthorize',
  'owner.ledger.codexToolExecute': 'ledger.codexToolExecute',
  'owner.ledger.codexToolsDispose': 'ledger.codexToolsDispose',
  'owner.ledger.operation': 'ledger.operation',
  'owner.claude.modAdmission': 'claude.modAdmission',
  'owner.model.agentAlias': 'model.agentAlias',
  'owner.plan.create': 'plan.create',
  'owner.plan.update': 'plan.update',
  'owner.mcp.bind': 'mcp.bind',
  'owner.mcp.authorize': 'mcp.authorize',
  'owner.mcp.rejected': 'mcp.rejected',
});

const OWNER_ACTIONS: ReadonlySet<string> = new Set(
  WORKER_PIPELINE_OWNER_ACTIONS,
);

export function isWorkerPipelineOwnerAction(
  action: string,
): action is WorkerPipelineOwnerAction {
  return OWNER_ACTIONS.has(action);
}

const LOCAL_OWNER_ACTIONS: ReadonlySet<string> = new Set(
  WORKER_PIPELINE_LOCAL_OWNER_ACTIONS,
);

export function isWorkerPipelineLocalOwnerAction(
  action: string,
): action is WorkerPipelineLocalOwnerAction {
  return LOCAL_OWNER_ACTIONS.has(action);
}
