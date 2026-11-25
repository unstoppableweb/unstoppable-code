import { z } from 'zod';

import { canopyJsonValueSchemaWithin } from '../errors';
import { LedgerErrorDetailsSchema } from '../core/ledger/schemas';
import {
  PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH,
  PIPELINE_DEFINITION_FORMATS,
  PIPELINE_DEFINITION_SOURCES,
} from '../core/pipeline/schemas';
import {
  WorkerPipelineModelAliasResolutionsSchema,
  WorkerPipelinePluginCollectionSnapshotsSchema,
} from '../host-execution';

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
 *
 * `owner.codex.pluginRefs` (CAN-6168) applies the owner's own policy to a
 * Codex step's plugin selections before the worker resolves them, as in
 * process: collections expanded, disabled skills, plugins and MCP configs
 * left out, and every skill's workspace context checked. The worker resolves
 * only the refs it answers.
 *
 * `owner.precommit.failure` (CAN-6739) reports a top-level `git-commit-push`
 * step's pre-commit failures to the owner of a run whose host commits with
 * brokered credentials (`repositoryActions: 'brokered'`), so the owner can
 * fire its `worktree:precommit:failure` hooks. The step's identity is the
 * request's own; the report carries each failed repository's bounded,
 * redacted hook output, never a path outside the checkout.
 *
 * `owner.pipeline.childCapabilities` (CAN-6868 follow-up 3) asks a remote
 * owner to resolve the plugin collections and model aliases a same-target
 * child workflow declares, as it resolved its run's at launch, before the
 * child starts or resumes in its parent's host. The owner checks the
 * definition as the run's person under the run's owner, installs what the
 * collections need on the worker, and answers in the launch's shapes; the
 * host scopes them to that child. The host asks for every child it starts
 * (CAN-7044), and the answer carries the child's definition with the cloud
 * models chosen for it when the run started, which the child then runs. The child's first answer is the one every
 * later request for it gets, so a resume on another worker runs what the
 * child started with.
 *
 * `owner.isolatedJob.*` (CAN-6892) run one variant of a read-only job as a
 * child run in a sandbox of its own (`isolatedJobs` on the launch). The
 * variant's request and its outcome are JSON documents that cross in
 * chunks (`write`, `read`) into the owner's run storage; `run` names the
 * request's digest, and settles once the child ended. The parent names the
 * variant by the child's execution id; the variant's own host names none,
 * since the owner knows which variant it is.
 *
 * `owner.definition.*` (CAN-7522) belong to no run: a core that owns the
 * pipeline definitions store asks the owner to check a write before its
 * commit and to apply the owner's side effects of it, under the reserved
 * scope `core:pipeline-definitions`. Only an owner that serves them receives
 * them.
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
  'owner.codex.pluginRefs',
  'owner.precommit.failure',
  'owner.pipeline.childCapabilities',
  'owner.isolatedJob.write',
  'owner.isolatedJob.read',
  'owner.isolatedJob.run',
  'owner.definition.precheck',
  'owner.definition.effects',
] as const;
export type WorkerPipelineOwnerAction =
  (typeof WORKER_PIPELINE_OWNER_ACTIONS)[number];

/**
 * Owner requests only the worker's own host can answer (CAN-6161), so a
 * worker with a remote owner answers them itself and never raises them.
 * `owner.claude.modAdmission` reads the Claude config folder on the host the
 * step runs on, and its answer carries that folder's install paths.
 * `owner.mcp.*` present a credential the host's own app holds (CAN-6168),
 * and `owner.codex.pluginRefs` applies that app's own installed-item policy.
 */
export const WORKER_PIPELINE_LOCAL_OWNER_ACTIONS = [
  'owner.claude.modAdmission',
  'owner.mcp.bind',
  'owner.mcp.authorize',
  'owner.mcp.rejected',
  'owner.codex.pluginRefs',
] as const satisfies readonly WorkerPipelineOwnerAction[];
export type WorkerPipelineLocalOwnerAction =
  (typeof WORKER_PIPELINE_LOCAL_OWNER_ACTIONS)[number];

/**
 * Owner requests that belong to no run (CAN-7522): the core raises them under
 * one of these reserved execution ids, and a run id never takes one (start
 * refuses the `core:` prefix). A run's withdrawals, lookups and child fan-out
 * never apply to them.
 */
export const WORKER_PIPELINE_OWNER_SCOPES = [
  'core:pipeline-definitions',
  'core:operation-ledger',
] as const;
export type WorkerPipelineOwnerScope =
  (typeof WORKER_PIPELINE_OWNER_SCOPES)[number];

const OWNER_SCOPES: ReadonlySet<string> = new Set(WORKER_PIPELINE_OWNER_SCOPES);

export function isWorkerPipelineOwnerScope(
  executionId: string,
): executionId is WorkerPipelineOwnerScope {
  return OWNER_SCOPES.has(executionId);
}

/** The prefix of every reserved scope; no run id may start with it. */
export const WORKER_PIPELINE_RESERVED_EXECUTION_ID_PREFIX = 'core:';

/** The most requests one reserved scope holds pending at once (CAN-7522). */
export const WORKER_PIPELINE_OWNER_SCOPE_PENDING_MAX = 64;

/**
 * Owner requests an owner answers only when it says so (CAN-7522): it names
 * each kind and the revision it serves when it subscribes, and a subscriber
 * that names none never receives them. Every other owner request goes to any
 * owner, as before.
 */
export const WORKER_PIPELINE_OWNER_SERVED_REVISIONS = Object.freeze({
  'owner.definition.precheck': 1,
  'owner.definition.effects': 1,
} as const satisfies Partial<Record<WorkerPipelineOwnerAction, number>>);

/** What a pipeline definition write is, to the owner that checks it. */
export const WORKER_PIPELINE_OWNER_DEFINITION_OPS = [
  'upsert',
  'delete',
  'duplicate',
] as const;

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
      installListUnreadable: z.literal(true).optional(),
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
/** The refusal reasons an owner names today; a reason outside them still refuses. */
export const WORKER_PIPELINE_MCP_REFUSALS = Object.freeze([
  'stale_route',
  'no_credential',
] as const);
export type WorkerPipelineMcpRefusal =
  (typeof WORKER_PIPELINE_MCP_REFUSALS)[number];
/** A refusal reason's shape, so a newer owner's reason still parses as a refusal. */
export const WORKER_PIPELINE_MCP_REFUSED_PATTERN = /^[a-z][a-z_]{0,31}$/;
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

/** The largest child definition `owner.pipeline.childCapabilities` carries, as JSON. */
export const WORKER_PIPELINE_OWNER_CHILD_DOCUMENT_MAX = 1_048_576;

/** The most repositories one `owner.precommit.failure` reports. */
export const WORKER_PIPELINE_OWNER_PRECOMMIT_REPOS_MAX = 64;
/** The longest pre-commit hook output one repository reports, in characters. */
export const WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX = 16_384;

/** One repository whose commit a pre-commit hook refused (CAN-6739). */
const precommitRepository = z.strictObject({
  repoId: text(512).optional(),
  repoName: text(512).optional(),
  /** The repository's folder, relative to the run's checkout. */
  relativePath: text(4096).optional(),
  branchName: text(512).optional(),
  /** The step's one-line error, redacted. */
  error: text(WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX),
  /** The hook's own output, redacted, its lines kept. */
  precommitFailureError: text(WORKER_PIPELINE_OWNER_PRECOMMIT_ERROR_MAX),
});

/**
 * The most one `owner.isolatedJob.write` carries, or one `read` answers
 * (CAN-6892): its base64 stays well under the relay's message limit.
 */
export const WORKER_PIPELINE_ISOLATED_JOB_CHUNK_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The largest variant request or outcome, as UTF-8 JSON: 64 MiB of files as
 * base64, and the values beside them.
 */
export const WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES = 96 * 1024 * 1024;
/** A variant's child run id: a lowercase UUID. */
export const WORKER_PIPELINE_ISOLATED_JOB_VARIANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const variantId = z
  .string()
  .regex(WORKER_PIPELINE_ISOLATED_JOB_VARIANT_ID_PATTERN);
/** Which document a chunk belongs to: the parent's request, or the variant's outcome. */
const isolatedJobSide = z.enum(['request', 'outcome']);
/** A whole request or outcome, by its digest. */
const isolatedJobPayload = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES),
});
const isolatedJobOffset = z
  .number()
  .int()
  .min(0)
  .max(WORKER_PIPELINE_ISOLATED_JOB_PAYLOAD_MAX_BYTES);
const isolatedJobChunk = z
  .string()
  .max(Math.ceil(WORKER_PIPELINE_ISOLATED_JOB_CHUNK_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** The parent names its variant's request; the variant names nothing. */
const sideNamesVariant = (value: {
  side: 'request' | 'outcome';
  variantId?: string;
}): boolean => (value.side === 'request') === (value.variantId !== undefined);

/** Members added to WorkerPipelineHostActionRequestSchema's union. */
/** Where a copied definition comes from (CAN-7522). */
const definitionOrigin = z.strictObject({
  source: z.enum(PIPELINE_DEFINITION_SOURCES),
  definitionId: id,
});

/** A copy's source document, as only the owner can read it (CAN-7522). */
const definitionSourceDocument = z.strictObject({
  name: text(4096),
  description: text(65_536),
  icon: text(4096),
  format: z.enum(PIPELINE_DEFINITION_FORMATS),
  text: z.string().max(PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH),
});

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
    /** Local owners validate the tool's folder; remote owners never receive it. */
    cwd: hostPath.optional(),
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
  /** A Codex step's plugin selections, as data, for the owner's policy. */
  z.strictObject({
    action: z.literal('owner.codex.pluginRefs'),
    selections: canopyJsonValueSchemaWithin(
      WORKER_PIPELINE_OWNER_AGENT_PLUGINS_MAX_BYTES,
    ),
  }),
  /** A `git-commit-push` step's pre-commit failures (CAN-6739). */
  z.strictObject({
    action: z.literal('owner.precommit.failure'),
    repositories: z
      .array(precommitRepository)
      .min(1)
      .max(WORKER_PIPELINE_OWNER_PRECOMMIT_REPOS_MAX),
  }),
  /**
   * A same-target child's own collections and aliases (CAN-6868): its id and
   * its definition as JSON, as the step resolved it.
   */
  z.strictObject({
    action: z.literal('owner.pipeline.childCapabilities'),
    childExecutionId: id,
    document: z.string().min(1).max(WORKER_PIPELINE_OWNER_CHILD_DOCUMENT_MAX),
  }),
  /**
   * One chunk of a variant's request (the parent, naming the variant) or of
   * its outcome (the variant's own host), at `offset`, in order (CAN-6892).
   */
  z
    .strictObject({
      action: z.literal('owner.isolatedJob.write'),
      side: isolatedJobSide,
      variantId: variantId.optional(),
      payload: isolatedJobPayload,
      offset: isolatedJobOffset,
      chunk: isolatedJobChunk,
    })
    .refine(sideNamesVariant, 'Only the request side names its variant.'),
  /** One chunk of a variant's request (the variant) or outcome (the parent). */
  z
    .strictObject({
      action: z.literal('owner.isolatedJob.read'),
      side: isolatedJobSide,
      variantId: variantId.optional(),
      offset: isolatedJobOffset,
    })
    .refine(
      (value) => (value.side === 'outcome') === (value.variantId !== undefined),
      'Only the outcome side names its variant.',
    ),
  /**
   * Runs the variant whose request was written as a child run in a sandbox
   * of its own, cut from `commit`, and settles once it ended (CAN-6892).
   * The child starts as the run started, from the run's own recorded
   * workflow, inputs and event; it runs only `logicalJobId`, from the
   * request.
   */
  z.strictObject({
    action: z.literal('owner.isolatedJob.run'),
    variantId,
    commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    request: isolatedJobPayload,
    logicalJobId: id,
  }),
  /**
   * Whether a definition write may go ahead (CAN-7522), raised in the
   * `core:pipeline-definitions` scope before the commit: the owner runs the
   * checks it runs in process, and for a copy reads the source only it can
   * read. A read, so a resend changes nothing.
   */
  z
    .strictObject({
      action: z.literal('owner.definition.precheck'),
      op: z.enum(WORKER_PIPELINE_OWNER_DEFINITION_OPS),
      /** The definition written; null for a copy, whose id is the core's. */
      definitionId: id.nullable(),
      /** A copy's source. */
      origin: definitionOrigin.optional(),
      /**
       * The scope the write's caller is in: a project copy's check reads its
       * workspace, and a project source's read its worktree.
       */
      scope: z.strictObject({
        workspaceId: id.optional(),
        worktreeId: id.optional(),
      }),
    })
    .refine(
      (value) =>
        (value.op === 'duplicate') === (value.definitionId === null) &&
        (value.op === 'duplicate') === (value.origin !== undefined),
      'Only a copy names its source, and only a copy names no definition.',
    ),
  /**
   * The owner's side effects of a definition write (CAN-7522), keyed by the
   * definition so applying one twice changes nothing. `reconcile` asks for
   * one pass that removes what no stored definition needs any more.
   */
  z
    .strictObject({
      action: z.literal('owner.definition.effects'),
      op: z.enum([...WORKER_PIPELINE_OWNER_DEFINITION_OPS, 'reconcile']),
      phase: z.enum(['beforeCommit', 'afterCommit', 'reconcile']),
      definitionId: id.nullable(),
      origin: definitionOrigin.optional(),
    })
    .refine(
      (value) =>
        (value.op === 'reconcile') === (value.phase === 'reconcile') &&
        (value.op === 'reconcile') === (value.definitionId === null) &&
        (value.op === 'duplicate') === (value.origin !== undefined),
      'Only a reconcile names no definition, and only a copy names its source.',
    ),
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
    /**
     * Why there is no grant (CAN-6168), for the owning daemon only, never an
     * agent or tool. `stale_route`: the route was bound under an earlier owner
     * subscription, so the run may bind it again once and ask once more.
     * `no_credential` and any other reason refuse.
     */
    refused: z.string().regex(WORKER_PIPELINE_MCP_REFUSED_PATTERN).optional(),
  }),
  z.strictObject({ kind: z.literal('mcp.rejected') }),
  /** Whether the owner recorded the report; false when it keeps none. */
  z.strictObject({
    kind: z.literal('precommit.failure'),
    recorded: z.boolean(),
  }),
  /**
   * The child's collections and aliases in the launch's shapes, installed
   * on the worker; absent when it declares none of that kind.
   */
  z.strictObject({
    kind: z.literal('pipeline.childCapabilities'),
    pluginCollectionSnapshots:
      WorkerPipelinePluginCollectionSnapshotsSchema.optional(),
    modelAliasResolutions: WorkerPipelineModelAliasResolutionsSchema.optional(),
    /**
     * The child's definition as JSON with the cloud models its run's person
     * chose for it when the run started (CAN-7044), which it runs instead of
     * the one its step resolved; absent when no step's model changes. A
     * resumed child runs its stored definition, which has them already.
     */
    document: z
      .string()
      .min(1)
      .max(WORKER_PIPELINE_OWNER_CHILD_DOCUMENT_MAX)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('isolatedJob.write'),
    /** How much of the document the owner holds. */
    received: isolatedJobOffset,
    complete: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('isolatedJob.read'),
    payload: isolatedJobPayload,
    offset: isolatedJobOffset,
    chunk: isolatedJobChunk,
    complete: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('isolatedJob.run'),
    /**
     * `completed`: the variant wrote its outcome, which the parent reads
     * back. `unavailable`: the owner can't place it (a commit it can't check
     * out, a run with no checkout), so the parent runs it in its own
     * sandbox. A child that ended without an outcome settles as a failure.
     */
    outcome: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('completed'),
        payload: isolatedJobPayload,
      }),
      z.strictObject({ kind: z.literal('unavailable'), reason: text(1024) }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('codex.pluginRefs'),
    /**
     * The selections the step may load, collections expanded and none
     * disabled; the owner fails the request when a skill's context check
     * fails, as the step fails in process. Null: the answerer applies no
     * policy (a remote owner), so the step loads nothing and fails.
     */
    selections: canopyJsonValueSchemaWithin(
      WORKER_PIPELINE_OWNER_AGENT_PLUGINS_MAX_BYTES,
    ),
    warnings: z.array(text(4096)).max(256),
  }),
  z.strictObject({
    kind: z.literal('definition.precheck'),
    /**
     * Allowed, with a copy's source when only the owner can read it; or
     * refused with the code the in-process check refuses with.
     */
    answer: z.discriminatedUnion('allowed', [
      z.strictObject({
        allowed: z.literal(true),
        source: definitionSourceDocument.optional(),
      }),
      z.strictObject({
        allowed: z.literal(false),
        code: z.enum(['contextMismatch', 'definitionNotFound']),
        message: text(1024),
      }),
    ]),
  }),
  z.strictObject({ kind: z.literal('definition.effects') }),
]);
export type WorkerPipelineOwnerResult = z.output<
  typeof WorkerPipelineOwnerResultSchema
>;
export const WorkerPipelineOwnerRequestSchema = z.discriminatedUnion(
  'action',
  WORKER_PIPELINE_OWNER_REQUEST_MEMBERS,
);
export type WorkerPipelineOwnerRequest = z.output<
  typeof WorkerPipelineOwnerRequestSchema
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
  'owner.codex.pluginRefs': 'codex.pluginRefs',
  'owner.precommit.failure': 'precommit.failure',
  'owner.pipeline.childCapabilities': 'pipeline.childCapabilities',
  'owner.isolatedJob.write': 'isolatedJob.write',
  'owner.isolatedJob.read': 'isolatedJob.read',
  'owner.isolatedJob.run': 'isolatedJob.run',
  'owner.definition.precheck': 'definition.precheck',
  'owner.definition.effects': 'definition.effects',
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
