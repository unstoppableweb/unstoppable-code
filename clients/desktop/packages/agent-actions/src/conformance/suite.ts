import { z } from 'zod';
import {
  settingsRouteToPath,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import { MANAGED_DELEGATION_PARENT_TOOL_KEYS } from '../tools/managed-delegation';
import { TRANSCRIPT_READ_ACTION_TYPES } from '../families/transcript-read/actions';
import { transcriptReadActionCatalog } from '../families/transcript-read/catalog';
import {
  CHAT_HISTORY_ACTION_TYPES,
  chatHistoryActionCatalog,
} from '../families/chat-history';
import {
  ENVIRONMENT_ACTION_TYPES,
  ENVIRONMENT_CHAT_CREATE_PLACEMENTS,
} from '../families/environment/actions';
import { environmentActionCatalog } from '../families/environment/catalog';
import {
  EXPERIMENT_ACTION_TYPES,
  experimentActionCatalog,
} from '../families/experiments';
import {
  SETTINGS_ACTION_TYPES,
  settingsActionCatalog,
} from '../families/settings';
import {
  AI_GATEWAY_ACTION_TYPES,
  aiGatewayActionCatalog,
} from '../families/settings/ai-gateway';
import {
  PULL_REQUEST_ACTION_TYPES,
  pullRequestActionCatalog,
} from '../families/pull-request';
import { PROJECT_ACTION_TYPES } from '../families/projects/actions';
import { PROJECT_ACTION_CATALOG } from '../families/projects/catalog';
import { PIPELINES_ACTION_TYPES } from '../families/pipelines/actions';
import { pipelinesActionCatalogFor } from '../families/pipelines/catalog';
import { PIPELINE_EXECUTIONS_ACTION_TYPES } from '../families/pipeline-executions/actions';
import { pipelineExecutionsActionCatalogFor } from '../families/pipeline-executions/catalog';
import {
  CHAT_CONTROL_ACTION_TYPES,
  chatControlActionCatalog,
} from '../families/chat-control';
import {
  environmentSupportedTypes,
  INLINE_WATCHERS_UNAVAILABLE_MESSAGE,
  offersInlineChatWatchers,
  unavailablePlacementMessage,
} from '../families/environment/dispatch';
import { IDEMPOTENCY_CONFLICT_MESSAGE } from '../action-support';
import type { AgentActionCatalogEntry } from '../catalog/types';
import { AGENT_ACTION_LIMITS, type AgentActionLimitValues } from '../limits';
import type { AgentActionHostCapabilities } from '../surface/capabilities';
import type { AgentActionSurface } from '../surface/engine';
import type { AgentActionCall } from '../surface/family';
import type { AgentActionToolKey } from '../tool-keys';
import type {
  AgentActionToolDefinition,
  AgentActionToolResult,
  AgentJsonSchema,
} from '../tools/definition';
import type { AgentWatcherTriggerType } from '../watchers/catalog';
import {
  deleteWatchersDescription,
  dispatchActionDescription,
  searchActionsDescription,
  searchWatchersDescription,
  setupWatchersDescription,
  startForkedAgentDescription,
  type AgentActionDescriptionCapabilities,
  type AgentActionDescriptionOffer,
} from '../tools/descriptions';
import { buildDispatchActionJsonSchema } from '../tools/dispatch-action';
import { buildSearchActionsJsonSchema } from '../tools/search-actions';
import { startSplitAgentJsonSchema } from '../tools/split-agent';
import { offersCanonicalChatWatchers } from '../watchers/chat-watchers';
import {
  buildDeleteWatchersJsonSchema,
  buildSearchWatchersJsonSchema,
  buildSetupWatchersJsonSchema,
  SEARCHABLE_WATCHER_TRIGGERS,
  SETUP_WATCHER_TRIGGERS,
} from '../tools/watchers';
import {
  arrayAt,
  at,
  canonicalJson,
  check,
  checkEqual,
  checkSubset,
  isJsonRecord,
  stringAt,
} from './assert';
import goldenJson from './golden/surface.json';
import scenarioJson from './scenarios/environment-basic.json';
import { loadConformanceWorld, type ConformanceWorld } from './world';

/** The test framework the suite registers with; no globals are assumed. */
export interface AgentConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

export interface AgentConformanceCallIdentity {
  /** Absent when the call carries no turn. */
  turnKey?: string;
  /** Absent when the call carries no tool-use id. */
  toolUseId?: string;
  actorKey: string;
  /**
   * A seeded chat other than the world's current chat that makes the call.
   * The host builds the call's trusted scope from that chat's workspace and
   * worktree. Absent: the world's current chat.
   */
  callingChatId?: string;
}

/**
 * Changes to the seeded world that happen outside the agent's tool calls,
 * such as a user archiving a chat between a call and its retry.
 */
export interface AgentConformanceWorldControl {
  /** Counts transcript body reads, excluding metadata and rejected cursors. */
  transcriptReadCount(): number;
  /**
   * Counts GitHub requests behind GetGitHubPullRequestStatus. Hosts that
   * offer the tool supply it, so the suite can check that repeated and
   * concurrent reads share one request.
   */
  pullRequestReadCount?(): number;
  /**
   * Disconnects the owner's GitHub credential, so the next pull request read
   * is refused. Hosts that offer the tool supply it.
   */
  disconnectGitHub?(): Promise<void>;
  /**
   * Counts the Feed entry revisions the host's Ledger wrote. Hosts that offer
   * the Feed tools supply it, so the suite can check that refused and
   * replayed writes write nothing.
   */
  feedWriteCount?(): number;
  /**
   * Counts the AI gateway changes the host applied. A host that cannot ask
   * the user to confirm a gateway change (a cloud chat) supplies it; the
   * suite then checks `connect` and `update` are refused with
   * `missing_capability` and change nothing.
   */
  gatewayWriteCount?(): number;
  archiveChat(chatId: string): Promise<void>;
  /**
   * Makes a seeded chat one the host cannot deliver chat.send_message to,
   * or deliverable again. Hosts that never refuse a listed chat omit it.
   */
  setChatMessageable?(chatId: string, messageable: boolean): Promise<void>;
  /** Makes a seeded model unavailable to models.list and chat.create. */
  withdrawModel(modelId: string): Promise<void>;
  /** Moves the clock the host's limits read forward. */
  advanceClock(ms: number): Promise<void>;
  /**
   * Holds the next chat start once it begins, until the hold finishes it.
   * Hosts apply it where the environment port starts a chat.
   */
  holdNextChatStart(): AgentConformanceWriteHold;
  /** Holds the next message post the same way (`createWriteHolds`). */
  holdNextMessagePost(): AgentConformanceWriteHold;
  /**
   * Makes the next commit of a limits reservation reject without counting
   * it, as a lost limits-store write would, after the write it covers
   * happened. Hosts apply it where their limits port commits
   * (`createLimitCommitFailures`); a host without limits ignores it.
   */
  failNextLimitCommit(): Promise<void>;
  /**
   * Finishes the oldest running or queued turn of a chat, as its provider
   * would, and returns the ids of the chat-completion watchers that fired.
   */
  completeTurn(chatId: string): Promise<readonly string[]>;
  /**
   * Every chat-completion watcher that has fired so far, in firing order:
   * those `completeTurn` fired, and those a host fired when they were armed
   * for a write whose turn had already finished.
   */
  firedWatchers(): Promise<readonly string[]>;
  /**
   * A person starts a chat in the world's project with a first message, in
   * the task named or as a new task. Returns the chat's canonical address
   * and the ids of the new-chat watchers its start fired. Hosts that serve
   * canonical project chat watchers through `createChatWatcherTools`
   * provide it; the suite runs the project watcher cases only with it.
   */
  startProjectChat?(taskId: string | null): Promise<{
    readonly address: {
      readonly projectId: string;
      readonly taskId: string;
      readonly chatId: string;
    };
    readonly firedWatchers: readonly string[];
  }>;
  /**
   * Delivers the scheduled wakeups due by the host's clock
   * (`advanceClock`), each once, and returns their watcher ids in due order.
   * Hosts that offer `scheduled_wakeup` provide it; the suite runs the
   * wakeup cases only with it.
   */
  fireDueWakeups?(): Promise<readonly string[]>;
  /**
   * Every settings destination the host asked its UI to open, in order.
   * Hosts that cannot observe their UI omit it; the suite then checks only
   * the action results.
   */
  openedSettings?(): Promise<readonly unknown[]>;
}

export interface AgentConformanceWriteHold {
  /** Resolves when the held start has begun. */
  started: Promise<void>;
  /**
   * Lets the held write complete, or fails it. `fail` fails it before it
   * writes anything; `timeout` lets the write happen and then reports a
   * retryable `timeout`, an outcome the caller cannot know.
   */
  finish(outcome: AgentConformanceHoldOutcome): void;
}

export type AgentConformanceHoldOutcome = 'succeed' | 'fail' | 'timeout';

/** A host under test, seeded with the conformance world. */
export interface AgentConformanceHost<H> {
  surface: AgentActionSurface<H>;
  capabilities: AgentActionHostCapabilities;
  /** A call from the world's current chat with this identity. */
  call(identity: AgentConformanceCallIdentity): AgentActionCall<H>;
  control: AgentConformanceWorldControl;
  /**
   * The caps the host's limits port applies, when they differ from
   * `AGENT_ACTION_LIMITS`. An infinite `perUserPerHour` or `perParentTurn`
   * is no such cap, and the suite skips the cases that need it.
   */
  limitValues?: AgentActionLimitValues;
}

/** One of the host's caps, or null when it has none. */
function hostCap(
  host: { limitValues?: AgentActionLimitValues },
  cap: 'perParentTurn' | 'perUserPerHour',
): number | null {
  const value = (host.limitValues ?? AGENT_ACTION_LIMITS)[cap];
  return Number.isFinite(value) ? value : null;
}

/** The host's hourly cap, or null when it has none. */
function hourlyCap(host: {
  limitValues?: AgentActionLimitValues;
}): number | null {
  return hostCap(host, 'perUserPerHour');
}

/** The host's per-turn cap, or null when it has none. */
function perTurnCap(host: {
  limitValues?: AgentActionLimitValues;
}): number | null {
  return hostCap(host, 'perParentTurn');
}

export type MakeAgentConformanceHost<H> = (
  world: ConformanceWorld,
) => AgentConformanceHost<H> | Promise<AgentConformanceHost<H>>;

const goldenSchema = z.object({
  capabilities: z.object({
    actionTypes: z.array(z.string()),
    hiddenInstructions: z.boolean(),
    watcherTargetScope: z.enum(['any', 'current_workspace']),
  }),
  tools: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
});

const scenarioSchema = z.object({
  steps: z.array(
    z.strictObject({
      group: z.enum(['reads', 'envelope', 'scoping']),
      name: z.string(),
      requires: z.array(z.string()).optional(),
      args: z.record(z.string(), z.unknown()),
      expect: z.strictObject({
        isError: z.boolean(),
        json: z.unknown().optional(),
        text: z.string().optional(),
        textPrefix: z.string().optional(),
        errorCodes: z.array(z.string()).optional(),
      }),
    }),
  ),
});

type ScenarioStep = z.output<typeof scenarioSchema>['steps'][number];

const HOUR_MS = 60 * 60 * 1000;

/** One write that counts against the limits, keyed by its tool-use id. */
interface LimitedWrite {
  label: string;
  run: (
    toolUseId: string,
    turnKey?: string,
    actorKey?: string,
  ) => Promise<{ result: AgentActionToolResult; json: unknown }>;
}

const ENVIRONMENT_TYPES: ReadonlySet<string> = new Set(
  ENVIRONMENT_ACTION_TYPES,
);

const MINIMAL_PAYLOADS: Record<string, Record<string, unknown>> = {
  'workspace.get': { type: 'workspace.get' },
  'worktree.list': { type: 'worktree.list' },
  'chat.list': { type: 'chat.list' },
  'chat.get': { type: 'chat.get', chatId: 'c2' },
  'chat.create': { type: 'chat.create', message: 'Hello' },
  'chat.send_message': {
    type: 'chat.send_message',
    chatId: 'c2',
    message: 'Hello',
  },
  'models.list': { type: 'models.list' },
};

interface Session<H> {
  host: AgentConformanceHost<H>;
  supports: (type: string) => boolean;
  execute: (
    key: AgentActionToolKey,
    args: unknown,
    identity?: Partial<AgentConformanceCallIdentity>,
  ) => Promise<AgentActionToolResult>;
  dispatch: (
    action: Record<string, unknown>,
    identity?: Partial<AgentConformanceCallIdentity>,
  ) => Promise<{ result: AgentActionToolResult; json: unknown }>;
  /** Dispatches with exactly this identity, without default ids. */
  dispatchAs: (
    action: Record<string, unknown>,
    identity: AgentConformanceCallIdentity,
  ) => Promise<{ result: AgentActionToolResult; json: unknown }>;
}

/**
 * Structural JSON Schema problems every validator rejects or that make a
 * property impossible: an empty `enum`, or `required` naming a property the
 * same object schema does not declare.
 */
function schemaProblems(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      schemaProblems(entry, `${path}/${index}`),
    );
  }
  if (!isJsonRecord(schema)) return [];
  const problems: string[] = [];
  const { enum: values, required, properties } = schema;
  if (Array.isArray(values) && values.length === 0) {
    problems.push(`${path || '/'} has an empty enum`);
  }
  if (Array.isArray(required) && isJsonRecord(properties)) {
    for (const name of required) {
      if (typeof name === 'string' && !(name in properties)) {
        problems.push(`${path || '/'} requires undeclared ${name}`);
      }
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    problems.push(...schemaProblems(value, `${path}/${key}`));
  }
  return problems;
}

/**
 * A chat.create without a placement gets one the host advertises, preferring
 * `current`, so cases that do not test placement run on every host.
 */
function withSupportedPlacement(
  action: Record<string, unknown>,
  capabilities: AgentActionHostCapabilities,
): Record<string, unknown> {
  if (action.type !== 'chat.create' || action.placement !== undefined) {
    return action;
  }
  const placements = capabilities.chatCreatePlacements;
  const placement = placements.includes('current') ? 'current' : placements[0];
  return placement === undefined ? action : { ...action, placement };
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function expectedToolKeys(
  capabilities: AgentActionHostCapabilities,
): AgentActionToolKey[] {
  const keys: AgentActionToolKey[] = ['search_actions', 'dispatch_action'];
  if (capabilities.watcherTriggers.length > 0) {
    keys.push('search_watchers', 'setup_watchers', 'delete_watchers');
  }
  if (capabilities.split.forked) keys.push('start_forked_agent');
  if (capabilities.split.branched) keys.push('start_branched_agent');
  if (capabilities.pullRequestStatus === true)
    keys.push('get_github_pull_request_status');
  if (
    capabilities.scheduleWakeup === true &&
    capabilities.watcherTriggers.includes('scheduled_wakeup')
  )
    keys.push('schedule_wakeup');
  if (capabilities.memory !== undefined)
    keys.push('save_memory', 'search_memory', 'read_memory');
  if (capabilities.feed === true)
    keys.push(
      'add_ledger_entry',
      'search_ledger_entries',
      'update_ledger_entry',
    );
  // The world's chat may delegate; it is not itself a delegate.
  if (capabilities.managedDelegation === true)
    keys.push(...MANAGED_DELEGATION_PARENT_TOOL_KEYS);
  return keys;
}

function withoutTriggerEnum(schema: unknown, path: string[]): unknown {
  if (!isJsonRecord(schema)) return schema;
  const [head, ...rest] = path;
  if (head === undefined) {
    const { enum: _enum, ...remainder } = schema;
    void _enum;
    return remainder;
  }
  return { ...schema, [head]: withoutTriggerEnum(schema[head], rest) };
}

const SEARCH_TRIGGER_PATH = ['properties', 'trigger'];
const SETUP_TRIGGER_PATH = [
  'properties',
  'watchers',
  'items',
  'properties',
  'trigger',
];

type GoldenTool = z.output<typeof goldenSchema>['tools'][number];

function withoutDescription(value: unknown): unknown {
  if (!isJsonRecord(value)) return value;
  const { description: _description, ...rest } = value;
  void _description;
  return rest;
}

/**
 * Whether an advertised property still offers the golden property after the
 * host's families were merged: the same schema, possibly with a longer
 * description, or one `anyOf` branch of it.
 */
function advertisesProperty(actual: unknown, expected: unknown): boolean {
  const sameSchema = (candidate: unknown): boolean => {
    if (
      canonicalJson(withoutDescription(candidate)) !==
      canonicalJson(withoutDescription(expected))
    ) {
      return false;
    }
    const description = at(expected, 'description');
    const advertised = at(candidate, 'description');
    return (
      typeof description !== 'string' ||
      (typeof advertised === 'string' && advertised.includes(description))
    );
  };
  if (sameSchema(actual)) return true;
  if (
    arrayAt(actual, 'anyOf').some((branch) =>
      advertisesProperty(branch, expected),
    )
  )
    return true;
  const expectedBranches = arrayAt(expected, 'anyOf');
  return (
    expectedBranches.length > 0 &&
    expectedBranches.every((branch) => advertisesProperty(actual, branch))
  );
}

/** The shared actions a host offers, in its advertised order. */
function sharedActionOffer(
  world: ConformanceWorld,
  capabilities: AgentActionHostCapabilities,
  aiGateway = false,
): AgentActionDescriptionOffer {
  // The settings family offers the AI gateway actions only while its host
  // enables them, whatever its capability list says.
  const supported = new Set<string>([
    ...(aiGateway ? AI_GATEWAY_ACTION_TYPES : []),
    ...environmentSupportedTypes(capabilities),
    ...TRANSCRIPT_READ_ACTION_TYPES,
    ...CHAT_HISTORY_ACTION_TYPES,
    ...EXPERIMENT_ACTION_TYPES,
    ...SETTINGS_ACTION_TYPES.filter(
      (type) => aiGateway || !type.startsWith('settings.ai_gateway.'),
    ),
    ...PULL_REQUEST_ACTION_TYPES,
    ...PROJECT_ACTION_TYPES,
    ...CHAT_CONTROL_ACTION_TYPES,
    ...PIPELINES_ACTION_TYPES,
    ...PIPELINE_EXECUTIONS_ACTION_TYPES,
  ]);
  const catalog = new Map(
    [
      ...environmentActionCatalog(world.brand),
      ...transcriptReadActionCatalog(),
      ...chatHistoryActionCatalog,
      ...experimentActionCatalog(),
      ...settingsActionCatalog(),
      ...(aiGateway ? aiGatewayActionCatalog : []),
      ...pullRequestActionCatalog(),
      ...PROJECT_ACTION_CATALOG,
      ...chatControlActionCatalog(),
      ...pipelinesActionCatalogFor(capabilities),
      ...pipelineExecutionsActionCatalogFor(capabilities),
    ].map((entry): [string, AgentActionCatalogEntry] => [entry.type, entry]),
  );
  return {
    capabilities,
    actions: capabilities.actionTypes.flatMap((type) => {
      const entry = supported.has(type) ? catalog.get(type) : undefined;
      return entry ? [entry] : [];
    }),
  };
}

/**
 * The wording of a tool whose description depends on capabilities or
 * offered actions the golden's host does not share, built by the shared
 * builders instead.
 */
function capabilityWordedTool(
  key: AgentActionToolKey,
  world: ConformanceWorld,
  capabilities: AgentActionHostCapabilities,
  aiGateway: boolean,
): Partial<Pick<GoldenTool, 'description' | 'inputSchema'>> | null {
  const offered = (trigger: AgentWatcherTriggerType): boolean =>
    capabilities.watcherTriggers.includes(trigger);
  switch (key) {
    case 'search_actions': {
      const offer = sharedActionOffer(world, capabilities, aiGateway);
      return {
        description: searchActionsDescription(world.brand, offer),
        inputSchema: buildSearchActionsJsonSchema(offer),
      };
    }
    case 'dispatch_action':
      return {
        description: dispatchActionDescription(
          world.brand,
          sharedActionOffer(world, capabilities, aiGateway),
        ),
      };
    case 'search_watchers':
      return {
        description: searchWatchersDescription(world.brand, capabilities),
        inputSchema: buildSearchWatchersJsonSchema(
          SEARCHABLE_WATCHER_TRIGGERS.filter(offered),
          capabilities,
        ),
      };
    case 'setup_watchers':
      return {
        description: setupWatchersDescription(world.brand, capabilities),
        inputSchema: buildSetupWatchersJsonSchema(
          world.brand,
          SETUP_WATCHER_TRIGGERS.filter(offered),
          capabilities,
        ),
      };
    case 'delete_watchers':
      return {
        description: deleteWatchersDescription(world.brand, capabilities),
        inputSchema: buildDeleteWatchersJsonSchema(capabilities),
      };
    case 'start_forked_agent':
      return {
        description: startForkedAgentDescription(capabilities),
        inputSchema: startSplitAgentJsonSchema(capabilities),
      };
    default:
      return null;
  }
}

function sameDescriptionCapabilities(
  a: AgentActionDescriptionCapabilities,
  b: AgentActionDescriptionCapabilities,
): boolean {
  return (
    a.hiddenInstructions === b.hiddenInstructions &&
    a.watcherTargetScope === b.watcherTargetScope &&
    offersCanonicalChatWatchers(a.watcherTriggers) ===
      offersCanonicalChatWatchers(b.watcherTriggers)
  );
}

const ACTION_PATH = ['properties', 'action'];

function checkDispatchSchema(
  schema: AgentJsonSchema,
  expected: GoldenTool['inputSchema'],
  capabilities: AgentActionHostCapabilities,
  world: ConformanceWorld,
): void {
  const supported = new Set(environmentSupportedTypes(capabilities));
  checkEqual(
    arrayAt(schema, ...ACTION_PATH, 'properties', 'type', 'enum').filter(
      (type) => typeof type === 'string' && ENVIRONMENT_TYPES.has(type),
    ),
    ENVIRONMENT_ACTION_TYPES.filter(
      (type) => supported.has(type) && capabilities.actionTypes.includes(type),
    ),
    'DispatchAction environment action types',
  );
  const transcriptTypes = TRANSCRIPT_READ_ACTION_TYPES.filter((type) =>
    capabilities.actionTypes.includes(type),
  );
  checkEqual(
    arrayAt(schema, ...ACTION_PATH, 'properties', 'type', 'enum').filter(
      (type) => TRANSCRIPT_READ_ACTION_TYPES.some((read) => read === type),
    ),
    transcriptTypes,
    'DispatchAction transcript action types',
  );
  const hasTranscripts = transcriptTypes.length > 0;
  const historyTypes = CHAT_HISTORY_ACTION_TYPES.filter((type) =>
    capabilities.actionTypes.includes(type),
  );
  checkEqual(
    arrayAt(schema, ...ACTION_PATH, 'properties', 'type', 'enum').filter(
      (type) => CHAT_HISTORY_ACTION_TYPES.some((history) => history === type),
    ),
    historyTypes,
    'DispatchAction history action types',
  );
  const hasHistory = historyTypes.length > 0;
  const transcriptOnly = new Set([
    'target',
    'messageId',
    'blockOrdinal',
    'field',
    'fieldSource',
    'offset',
    'firstBlockOrdinal',
  ]);
  const properties = at(expected, ...ACTION_PATH, 'properties');
  const placementSchema = {
    type: 'string',
    enum: ENVIRONMENT_CHAT_CREATE_PLACEMENTS.filter((placement) =>
      capabilities.chatCreatePlacements.includes(placement),
    ),
  };
  for (const [name, property] of Object.entries(
    isJsonRecord(properties) ? properties : {},
  )) {
    if (
      name === 'type' ||
      (!hasTranscripts && transcriptOnly.has(name)) ||
      (!hasHistory && (name === 'query' || name === 'matchId'))
    )
      continue;
    const actualProperty = at(schema, ...ACTION_PATH, 'properties', name);
    if (name === 'placement' && placementSchema.enum.length === 0) {
      check(
        actualProperty === undefined,
        `DispatchAction offers placement without a placement: ${canonicalJson(actualProperty)}`,
      );
      continue;
    }
    // The reference host merges environment, transcript and history limits,
    // in that order. Compare only the families this host advertises.
    const limitBranches = arrayAt(property, 'anyOf').filter(
      (_, index) =>
        index === 0 ||
        (index === 1 && hasTranscripts) ||
        (index === 2 && hasHistory),
    );
    let expectedProperty = property;
    if (name === 'placement') expectedProperty = placementSchema;
    else if (name === 'limit' && limitBranches.length > 0)
      expectedProperty =
        limitBranches.length === 1
          ? limitBranches[0]
          : { anyOf: limitBranches };
    check(
      advertisesProperty(actualProperty, expectedProperty),
      `DispatchAction property ${name}\nexpected to accept: ${canonicalJson(expectedProperty)}\nreceived: ${canonicalJson(actualProperty)}`,
    );
  }
  const allOf = new Set(
    arrayAt(schema, ...ACTION_PATH, 'allOf').map(canonicalJson),
  );
  for (const rule of arrayAt(expected, ...ACTION_PATH, 'allOf')) {
    const ruleType = at(rule, 'if', 'properties', 'type', 'const');
    if (
      !hasTranscripts &&
      TRANSCRIPT_READ_ACTION_TYPES.some((type) => type === ruleType)
    )
      continue;
    // A host that does not offer chat control need not compose its family.
    if (
      CHAT_CONTROL_ACTION_TYPES.some(
        (type) => type === ruleType && !capabilities.actionTypes.includes(type),
      )
    )
      continue;
    if (
      !hasHistory &&
      CHAT_HISTORY_ACTION_TYPES.some(
        (type) => type === at(rule, 'if', 'properties', 'type', 'const'),
      )
    )
      continue;
    check(
      allOf.has(canonicalJson(rule)),
      `DispatchAction is missing the conditional ${canonicalJson(rule)}`,
    );
  }
  // A family that keeps a scope field as an explicit target advertises it,
  // and the description then names it.
  const targetFields = ['projectId', 'worktreeId'].filter(
    (field) => at(schema, ...ACTION_PATH, 'properties', field) !== undefined,
  );
  checkEqual(
    at(schema, ...ACTION_PATH, 'description'),
    targetFields.length > 0
      ? at(
          buildDispatchActionJsonSchema(world.brand, {
            actionTypes: [],
            targetFields,
          }),
          ...ACTION_PATH,
          'description',
        )
      : at(expected, ...ACTION_PATH, 'description'),
    'DispatchAction action description',
  );
}

function checkWatcherSchema(
  label: string,
  schema: AgentJsonSchema,
  expected: GoldenTool['inputSchema'],
  triggerPath: string[],
  triggers: readonly string[],
): void {
  // Canonical watchers add a strict entry branch; the shared builder's schema
  // for these triggers is the expectation, enum included.
  if (offersCanonicalChatWatchers(triggers)) {
    checkEqual(schema, expected, `${label} schema`);
    return;
  }
  checkEqual(
    withoutTriggerEnum(schema, triggerPath),
    withoutTriggerEnum(expected, triggerPath),
    `${label} schema`,
  );
  checkEqual(
    arrayAt(schema, ...triggerPath, 'enum'),
    triggers,
    `${label} triggers`,
  );
}

/**
 * Compare one tool schema with the golden. Parts that depend on capabilities
 * are compared with the golden filtered by the host's capabilities; action
 * types other families add are ignored.
 */
function checkToolSchema(
  definition: AgentActionToolDefinition<AgentActionToolKey>,
  expected: GoldenTool['inputSchema'],
  capabilities: AgentActionHostCapabilities,
  world: ConformanceWorld,
): void {
  const offered = (trigger: AgentWatcherTriggerType): boolean =>
    capabilities.watcherTriggers.includes(trigger);
  switch (definition.key) {
    case 'dispatch_action':
      checkDispatchSchema(
        definition.inputSchema,
        expected,
        capabilities,
        world,
      );
      return;
    case 'search_watchers':
      checkWatcherSchema(
        'SearchWatchers',
        definition.inputSchema,
        expected,
        SEARCH_TRIGGER_PATH,
        SEARCHABLE_WATCHER_TRIGGERS.filter(offered),
      );
      return;
    case 'setup_watchers':
      checkWatcherSchema(
        'SetupWatchers',
        definition.inputSchema,
        expected,
        SETUP_TRIGGER_PATH,
        SETUP_WATCHER_TRIGGERS.filter(offered),
      );
      return;
    default:
      checkEqual(definition.inputSchema, expected, `${definition.key} schema`);
  }
}

/**
 * Register the agent action conformance suite. Every host runs it against
 * the neutral world; groups whose capability a host lacks assert the
 * identical structured error instead.
 */
export function runAgentActionConformance<H>(
  t: AgentConformanceTestApi,
  makeHost: MakeAgentConformanceHost<H>,
): void {
  const world = loadConformanceWorld();
  const golden = goldenSchema.parse(goldenJson);
  const scenario = scenarioSchema.parse(scenarioJson);
  let sessions = 0;

  async function session(override?: ConformanceWorld): Promise<Session<H>> {
    const host = await makeHost(override ?? world);
    sessions += 1;
    const turnKey = `conformance-turn-${sessions}`;
    let toolUses = 0;
    const dispatchDefinition = host.surface
      .toolDefinitions()
      .find((definition) => definition.key === 'dispatch_action');
    const advertised = new Set(
      arrayAt(
        dispatchDefinition?.inputSchema,
        'properties',
        'action',
        'properties',
        'type',
        'enum',
      ).filter((entry): entry is string => typeof entry === 'string'),
    );
    const execute: Session<H>['execute'] = (key, args, identity) => {
      toolUses += 1;
      return host.surface.execute(
        key,
        args,
        host.call({
          turnKey: identity?.turnKey ?? turnKey,
          toolUseId: identity?.toolUseId ?? `${turnKey}-tool-${toolUses}`,
          actorKey: identity?.actorKey ?? 'conformance-actor',
        }),
      );
    };
    return {
      host,
      dispatchAs: async (
        action,
        identity,
      ): Promise<{ result: AgentActionToolResult; json: unknown }> => {
        const result = await host.surface.execute(
          'dispatch_action',
          { action: withSupportedPlacement(action, host.capabilities) },
          host.call(identity),
        );
        return { result, json: parseJson(result.text) };
      },
      supports: (type) => advertised.has(type),
      execute,
      dispatch: async (
        action,
        identity,
      ): Promise<{ result: AgentActionToolResult; json: unknown }> => {
        const result = await execute(
          'dispatch_action',
          { action: withSupportedPlacement(action, host.capabilities) },
          identity,
        );
        return { result, json: parseJson(result.text) };
      },
    };
  }

  t.describe('experiments preference contract', () => {
    t.it(
      'validates the portable payload, preserves historical receipts, and refuses unsupported hosts',
      async () => {
        const current = await session();
        const action = {
          type: 'experiments.set_enabled',
          experimentId: 'early-access',
          enabled: true,
        };
        if (!current.supports(action.type)) {
          checkErrorCode(
            await current.dispatch(action),
            ['unsupported_action'],
            'experiments on an unsupported host',
          );
          return;
        }
        for (const invalid of [
          { ...action, enabled: 'true' },
          { ...action, userId: 'other' },
        ]) {
          const rejected = await current.dispatch(invalid);
          check(
            rejected.result.isError === true &&
              rejected.result.text.includes('Invalid arguments'),
            'invalid experiment payload is refused before dispatch',
          );
        }
        const identity = {
          toolUseId: 'experiment-write',
          turnKey: 'experiment-turn',
          actorKey: 'experiment-actor',
        };
        const first = await current.dispatch(action, identity);
        check(at(first.json, 'ok') === true, 'experiment write succeeds');
        checkEqual(
          at(first.json, 'result', 'storedChoice'),
          true,
          'stored experiment choice',
        );
        check(
          typeof at(first.json, 'result', 'effectiveEnabledAtCommit') ===
            'boolean',
          'effective state is explicit',
        );
        check(
          typeof at(first.json, 'result', 'listedAtCommit') === 'boolean',
          'listed state is explicit',
        );
        await current.dispatch({ ...action, enabled: false });
        const replay = await current.dispatch(action, identity);
        checkEqual(
          replay.json,
          first.json,
          'receipt describes the historical commit after a later opt-out',
        );
      },
    );
  });

  t.describe('pull request contract', () => {
    t.it(
      'refuses payload fields before dispatch and unsupported hosts',
      async () => {
        const current = await session();
        const action = { type: 'pull_request.create' };
        if (!current.supports(action.type)) {
          checkErrorCode(
            await current.dispatch(action),
            ['unsupported_action'],
            'pull requests on an unsupported host',
          );
          return;
        }
        const rejected = await current.dispatch({ ...action, title: 'x' });
        check(
          rejected.result.isError === true &&
            rejected.result.text.includes('Invalid arguments'),
          'pull request fields are refused before dispatch',
        );
      },
    );
  });

  t.describe('pull request status contract', () => {
    const key = 'get_github_pull_request_status';
    const offered = (current: Session<H>): boolean =>
      current.host.surface
        .toolDefinitions()
        .some((definition) => definition.key === key);
    const read = async (
      current: Session<H>,
      args: unknown,
    ): Promise<{ result: AgentActionToolResult; json: unknown }> => {
      const result = await current.execute(key, args);
      return { result, json: parseJson(result.text) };
    };
    const failureCode = (outcome: { json: unknown }): unknown =>
      at(outcome.json, 'code');
    const record = (value: unknown): Record<string, unknown> =>
      isJsonRecord(value) ? value : {};

    t.it('refuses the tool on a host that does not offer it', async () => {
      const current = await session();
      if (offered(current)) return;
      const outcome = await current.execute(key, {
        pullRequest: 'conformance/app#42',
      });
      check(outcome.isError === true, 'unoffered pull request status fails');
    });

    t.it('reads a pull request by URL or owner/repository#number', async () => {
      const current = await session();
      if (!offered(current)) return;
      for (const row of world.pullRequests.readable) {
        const expected = {
          repository: row.repository,
          number: row.number,
          ...row.status,
        };
        for (const pullRequest of [
          `https://github.com/${row.repository}/pull/${row.number}`,
          `${row.repository}#${row.number}`,
        ]) {
          const outcome = await read(current, { pullRequest });
          check(
            outcome.result.isError !== true,
            `${pullRequest} reads without an error`,
          );
          checkEqual(at(outcome.json, 'ok'), true, `${pullRequest} ok`);
          const fetchedAt = at(outcome.json, 'pullRequest', 'fetchedAt');
          check(
            typeof fetchedAt === 'string' &&
              !Number.isNaN(Date.parse(fetchedAt)),
            `${pullRequest} carries fetchedAt`,
          );
          checkEqual(
            { ...record(at(outcome.json, 'pullRequest')), fetchedAt: 0 },
            { ...expected, fetchedAt: 0 },
            `${pullRequest} status`,
          );
        }
      }
    });

    t.it(
      'shares one GitHub request across repeated and concurrent reads',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const { control } = current.host;
        check(
          control.pullRequestReadCount !== undefined,
          'a host offering pull request status counts its GitHub requests',
        );
        const reads = (): number => control.pullRequestReadCount?.() ?? 0;
        const [row] = world.pullRequests.readable;
        if (!row) return;
        const before = reads();
        const reference = `${row.repository}#${row.number}`;
        const outcomes = await Promise.all([
          read(current, { pullRequest: reference }),
          read(current, {
            pullRequest: `https://github.com/${row.repository}/pull/${row.number}`,
          }),
        ]);
        const again = await read(current, { pullRequest: reference });
        for (const outcome of [...outcomes, again])
          checkEqual(at(outcome.json, 'ok'), true, 'shared read succeeds');
        checkEqual(reads() - before, 1, 'GitHub requests for three reads');
      },
    );

    t.it('refuses invalid input and references before GitHub', async () => {
      const current = await session();
      if (!offered(current)) return;
      const before = current.host.control.pullRequestReadCount?.();
      for (const args of [
        {},
        { pullRequest: '' },
        { pullRequest: 'conformance/app#42', repository: 'conformance/app' },
      ]) {
        const outcome = await read(current, args);
        check(outcome.result.isError === true, 'invalid input is an error');
        checkEqual(failureCode(outcome), 'invalid_input', 'invalid input');
      }
      for (const pullRequest of [
        'not a pull request',
        'https://gitlab.com/conformance/app/-/merge_requests/42',
        'conformance/app#0',
      ]) {
        const outcome = await read(current, { pullRequest });
        check(outcome.result.isError === true, `${pullRequest} is an error`);
        checkEqual(
          failureCode(outcome),
          'invalid_reference',
          `${pullRequest} reference`,
        );
      }
      checkEqual(
        current.host.control.pullRequestReadCount?.(),
        before,
        'no GitHub request for refused input',
      );
    });

    t.it(
      'answers not_found for a pull request the owner cannot read',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const { repository, number } = world.pullRequests.inaccessible;
        const outcome = await read(current, {
          pullRequest: `${repository}#${number}`,
        });
        check(outcome.result.isError === true, 'inaccessible is an error');
        checkEqual(failureCode(outcome), 'not_found', 'inaccessible code');
        check(
          typeof at(outcome.json, 'message') === 'string',
          'inaccessible message',
        );
      },
    );

    t.it('answers not_authenticated once GitHub is disconnected', async () => {
      const current = await session();
      if (!offered(current)) return;
      const { control } = current.host;
      check(
        control.disconnectGitHub !== undefined,
        'a host offering pull request status can disconnect GitHub',
      );
      await control.disconnectGitHub?.();
      const [row] = world.pullRequests.readable;
      if (!row) return;
      const outcome = await read(current, {
        pullRequest: `${row.repository}#${row.number}`,
      });
      check(outcome.result.isError === true, 'disconnected is an error');
      checkEqual(
        failureCode(outcome),
        'not_authenticated',
        'disconnected code',
      );
    });
  });

  t.describe('feed contract', () => {
    const offered = (current: Session<H>): boolean =>
      current.host.surface
        .toolDefinitions()
        .some((definition) => definition.key === 'add_ledger_entry');
    const call = async (
      current: Session<H>,
      key: 'add_ledger_entry' | 'search_ledger_entries' | 'update_ledger_entry',
      args: unknown,
      identity?: Partial<AgentConformanceCallIdentity>,
    ): Promise<{ result: AgentActionToolResult; json: unknown }> => {
      const result = await current.execute(key, args, identity);
      return { result, json: parseJson(result.text.split('\n')[0] ?? '') };
    };
    const add = (
      current: Session<H>,
      args: Record<string, unknown>,
      identity?: Partial<AgentConformanceCallIdentity>,
    ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
      call(
        current,
        'add_ledger_entry',
        { content: 'Conformance details.', ...args },
        identity,
      );
    const errorCodeOf = (outcome: { json: unknown }): unknown =>
      at(outcome.json, 'error', 'code');
    const writes = (current: Session<H>): number | undefined =>
      current.host.control.feedWriteCount?.();

    t.it(
      'refuses the Feed tools on a host that does not offer them',
      async () => {
        const current = await session();
        if (offered(current)) return;
        for (const key of [
          'add_ledger_entry',
          'search_ledger_entries',
          'update_ledger_entry',
        ] as const) {
          const outcome = await current.execute(key, {});
          check(outcome.isError === true, `unoffered ${key} fails`);
        }
      },
    );

    t.it(
      'adds an entry the calling chat owns, with the default status',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        check(
          current.host.control.feedWriteCount !== undefined,
          'a host offering the Feed tools counts its Ledger writes',
        );
        const task = await add(current, {
          type: 'OPERATION',
          title: 'Ship it',
        });
        check(task.result.isError !== true, 'add succeeds');
        checkEqual(at(task.json, 'ok'), true, 'add ok');
        checkEqual(at(task.json, 'changed'), true, 'add changed');
        checkEqual(
          at(task.json, 'entry', 'status'),
          'TODO',
          'operation status',
        );
        checkEqual(at(task.json, 'entry', 'revision'), 1, 'first revision');
        checkEqual(
          at(task.json, 'entry', 'owner', 'isSelf'),
          true,
          'owner is self',
        );
        checkEqual(
          at(task.json, 'entry', 'content'),
          undefined,
          'a receipt leaves out the content the agent wrote',
        );
        const note = await add(current, {
          type: 'OBSERVATION',
          title: 'Noted',
        });
        checkEqual(
          at(note.json, 'entry', 'status'),
          'INFO',
          'observation status',
        );
      },
    );

    t.it('refuses invalid arguments before the Ledger', async () => {
      const current = await session();
      if (!offered(current)) return;
      const before = writes(current);
      for (const args of [
        {},
        { type: 'TASK', content: 'No title.' },
        { type: 'TASK', title: 'T', content: 'C', projectId: 'p1' },
      ]) {
        const outcome = await current.execute('add_ledger_entry', args);
        check(outcome.isError === true, 'invalid add is an error');
        check(
          outcome.text.startsWith('Invalid arguments for AddFeedEntry.'),
          `invalid add text: ${outcome.text}`,
        );
      }
      const update = await current.execute('update_ledger_entry', {
        entryId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
      });
      check(
        update.text.startsWith('Invalid arguments for UpdateFeedEntry.'),
        `update with no change: ${update.text}`,
      );
      checkEqual(writes(current), before, 'no write for invalid arguments');
    });

    t.it('replays a requestKey once and refuses its reuse', async () => {
      const current = await session();
      if (!offered(current)) return;
      const args = { type: 'TASK', title: 'Once', requestKey: 'feed-once' };
      const first = await add(current, args);
      const before = writes(current);
      const again = await add(current, args);
      checkEqual(
        at(again.json, 'entry', 'entryId'),
        at(first.json, 'entry', 'entryId'),
        'a retry with the same requestKey answers the same entry',
      );
      checkEqual(writes(current), before, 'a replay writes nothing');
      const reused = await add(current, { ...args, title: 'Another' });
      checkEqual(errorCodeOf(reused), 'IDEMPOTENCY_KEY_REUSED', 'reused key');
    });

    t.it(
      "searches the chat's own open entries with owners to assign",
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const added = await add(current, { type: 'TASK', title: 'Find me' });
        const entryId = at(added.json, 'entry', 'entryId');
        const search = await call(current, 'search_ledger_entries', {
          owner: 'self',
          statuses: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW'],
          includeAssignableOwners: true,
        });
        check(search.result.isError !== true, 'search succeeds');
        const found = arrayAt(search.json, 'entries').find(
          (entry) => at(entry, 'entryId') === entryId,
        );
        check(found !== undefined, 'search finds the added entry');
        checkEqual(at(found, 'revision'), 1, 'search shows the revision');
        checkEqual(
          at(found, 'content'),
          'Conformance details.',
          'search content',
        );
        checkEqual(at(found, 'author', 'isSelf'), true, 'author is self');
        const owners = arrayAt(search.json, 'owners', 'candidates');
        check(
          owners.some((owner) => at(owner, 'isSelf') === true) &&
            owners.some((owner) => at(owner, 'isSelf') === false),
          'owners list the chat and another assignable owner',
        );
        check(
          owners.every(
            (owner) => typeof at(owner, 'eligibilityToken') === 'string',
          ),
          'every owner carries an eligibility token',
        );
      },
    );

    t.it(
      'updates with revisions, refusing a stale one and a closed entry',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const added = await add(current, { type: 'TASK', title: 'Update me' });
        const entryId = at(added.json, 'entry', 'entryId');
        const started = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
        });
        checkEqual(at(started.json, 'entry', 'revision'), 2, 'second revision');
        checkEqual(
          at(started.json, 'entry', 'status'),
          'IN_PROGRESS',
          'started',
        );
        const stale = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 1,
          status: 'BLOCKED',
        });
        check(stale.result.isError === true, 'a stale revision is an error');
        checkEqual(errorCodeOf(stale), 'REVISION_CONFLICT', 'stale revision');
        checkEqual(
          at(stale.json, 'currentEntry', 'revision'),
          2,
          'the conflict answers the current entry',
        );
        const done = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 2,
          status: 'COMPLETED',
        });
        checkEqual(at(done.json, 'entry', 'status'), 'COMPLETED', 'completed');
        const closed = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 3,
          status: 'IN_PROGRESS',
        });
        checkEqual(errorCodeOf(closed), 'TERMINAL_ENTRY', 'closed entry');
        const missing = await call(current, 'update_ledger_entry', {
          entryId: '00000000-0000-4000-8000-00000000dead',
          expectedRevision: 1,
          status: 'COMPLETED',
        });
        checkEqual(errorCodeOf(missing), 'NOT_FOUND', 'unknown entry');
      },
    );

    t.it(
      'closes a parent only with a choice for its open children',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const operation = await add(current, {
          type: 'OPERATION',
          title: 'Parent',
        });
        const parentId = at(operation.json, 'entry', 'entryId');
        const child = await add(current, {
          type: 'TASK',
          title: 'Child',
          parentEntryId: parentId,
        });
        const childId = at(child.json, 'entry', 'entryId');
        checkEqual(
          at(child.json, 'entry', 'parentEntryId'),
          parentId,
          'parent',
        );
        const refused = await call(current, 'update_ledger_entry', {
          entryId: parentId,
          expectedRevision: 1,
          status: 'COMPLETED',
        });
        checkEqual(errorCodeOf(refused), 'OPEN_CHILDREN', 'open children');
        checkEqual(
          at(refused.json, 'openChildEntryIds'),
          [childId],
          'the refusal names the open child',
        );
        const closed = await call(current, 'update_ledger_entry', {
          entryId: parentId,
          expectedRevision: 1,
          status: 'COMPLETED',
          openChildren: 'complete',
        });
        checkEqual(at(closed.json, 'entry', 'status'), 'COMPLETED', 'closed');
      },
    );

    t.it(
      'hands an entry over with an eligibility token, then leaves it to its owner',
      async () => {
        const current = await session();
        if (!offered(current)) return;
        const added = await add(current, { type: 'TASK', title: 'Hand over' });
        const entryId = at(added.json, 'entry', 'entryId');
        const forged = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 1,
          owner: {
            actorId: '00000000-0000-4000-8000-00000000beef',
            eligibilityToken: 'forged',
          },
        });
        checkEqual(errorCodeOf(forged), 'OWNER_UNAVAILABLE', 'forged token');
        const search = await call(current, 'search_ledger_entries', {
          entryIds: [entryId],
          includeAssignableOwners: true,
        });
        const other = arrayAt(search.json, 'owners', 'candidates').find(
          (owner) => at(owner, 'isSelf') === false,
        );
        const handed = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 1,
          owner: {
            actorId: at(other, 'actorId'),
            eligibilityToken: at(other, 'eligibilityToken'),
          },
        });
        check(handed.result.isError !== true, 'hand-over succeeds');
        checkEqual(
          at(handed.json, 'entry', 'owner', 'actorId'),
          at(other, 'actorId'),
          'the new owner',
        );
        checkEqual(
          at(handed.json, 'entry', 'owner', 'isSelf'),
          undefined,
          "no longer the chat's",
        );
        const after = await call(current, 'update_ledger_entry', {
          entryId,
          expectedRevision: 2,
          status: 'COMPLETED',
        });
        checkEqual(errorCodeOf(after), 'FORBIDDEN', 'not the owner any more');
      },
    );
  });

  t.describe('chat control contract', () => {
    const CONTROL_TYPES = [
      'chat.interrupt',
      'chat.cancel',
      'chat.archive',
    ] as const;
    // c1 is the world's running current chat, c2 idle, c3 archived.
    const fromIdle = (toolUseId: string): AgentConformanceCallIdentity => ({
      actorKey: 'conformance-actor',
      turnKey: 'chat-control-turn',
      toolUseId,
      callingChatId: 'c2',
    });
    const fromCurrent = (toolUseId: string): AgentConformanceCallIdentity => ({
      actorKey: 'conformance-actor',
      turnKey: 'chat-control-turn',
      toolUseId,
    });
    const stateOf = async (
      current: Session<H>,
      chatId: string,
      identity: AgentConformanceCallIdentity,
    ): Promise<unknown> =>
      at(
        (await current.dispatchAs({ type: 'chat.get', chatId }, identity)).json,
        'result',
        'chat',
        'state',
      );

    t.it(
      'refuses unsupported hosts, malformed payloads, the calling chat, and chats outside the workspace',
      async () => {
        const current = await session();
        for (const type of CONTROL_TYPES) {
          if (!current.supports(type)) {
            checkErrorCode(
              await current.dispatch({ type, chatId: 'c2' }),
              ['unsupported_action'],
              `${type} on an unsupported host`,
            );
            continue;
          }
          for (const invalid of [
            { type },
            { type, chatId: 'c2', reason: 'user' },
          ]) {
            const rejected = await current.dispatch(invalid);
            check(
              rejected.result.isError === true &&
                rejected.result.text.includes('Invalid arguments'),
              `${type}: a malformed payload is refused before dispatch`,
            );
          }
          for (const chatId of [
            world.current.chatId,
            ` ${world.current.chatId} `,
          ])
            checkErrorCode(
              await current.dispatch({ type, chatId }),
              ['invalid_target'],
              `${type} on the calling chat as ${JSON.stringify(chatId)}`,
            );
          checkErrorCode(
            await current.dispatch({ type, chatId: world.foreign.chatId }),
            ['invalid_target', 'not_found'],
            `${type} on a chat in another workspace`,
          );
          checkErrorCode(
            await current.dispatch({ type, chatId: 'missing-chat' }),
            ['not_found'],
            `${type} on an unknown chat`,
          );
        }
      },
    );

    t.it(
      'interrupts the running turn, replays the recorded result, and takes no limits slot',
      async () => {
        const current = await session();
        if (!current.supports('chat.interrupt')) return;
        const action = { type: 'chat.interrupt', chatId: 'c1' };
        const first = await current.dispatchAs(action, fromIdle('interrupt-1'));
        checkEqual(
          at(first.json, 'result'),
          { chatId: 'c1', interrupted: true },
          'the running turn is interrupted',
        );
        checkEqual(
          await stateOf(current, 'c1', fromIdle('interrupt-read')),
          'idle',
          'the interrupted chat is idle',
        );
        const replay = await current.dispatchAs(
          action,
          fromIdle('interrupt-1'),
        );
        checkEqual(
          replay.json,
          first.json,
          'a retried call replays its result',
        );
        // More calls than any per-turn cap allows: stopping work is not
        // counted against the limits.
        const cap =
          perTurnCap(current.host) ?? AGENT_ACTION_LIMITS.perParentTurn;
        for (let index = 0; index <= cap; index += 1) {
          const again = await current.dispatchAs(
            action,
            fromIdle(`interrupt-again-${String(index)}`),
          );
          checkEqual(
            at(again.json, 'result'),
            { chatId: 'c1', interrupted: false },
            'an idle chat has nothing to interrupt',
          );
        }
        const archived = await current.dispatchAs(
          { type: 'chat.interrupt', chatId: 'c3' },
          fromIdle('interrupt-archived'),
        );
        checkEqual(
          at(archived.json, 'result'),
          { chatId: 'c3', interrupted: false },
          'an archived chat runs no turn',
        );
      },
    );

    t.it('cancels the queued messages and the running turn', async () => {
      const current = await session();
      if (!current.supports('chat.cancel')) return;
      if (current.supports('chat.send_message')) {
        const queued = await current.dispatchAs(
          {
            type: 'chat.send_message',
            chatId: 'c1',
            message: 'Queued behind the running turn.',
          },
          fromIdle('cancel-queue'),
        );
        check(at(queued.json, 'ok') === true, 'a message queues behind c1');
      }
      const queuedCount = current.supports('chat.send_message') ? 1 : 0;
      const first = await current.dispatchAs(
        { type: 'chat.cancel', chatId: 'c1' },
        fromIdle('cancel-1'),
      );
      checkEqual(
        at(first.json, 'result'),
        { chatId: 'c1', interrupted: true, cancelledQueued: queuedCount },
        'the queued message and the running turn are cancelled',
      );
      checkEqual(
        await stateOf(current, 'c1', fromIdle('cancel-read')),
        'idle',
        'the cancelled chat is idle',
      );
      const again = await current.dispatchAs(
        { type: 'chat.cancel', chatId: 'c1' },
        fromIdle('cancel-2'),
      );
      checkEqual(
        at(again.json, 'result'),
        { chatId: 'c1', interrupted: false, cancelledQueued: 0 },
        'an idle chat has nothing to cancel',
      );
    });

    t.it('archives an idle chat once and refuses a running one', async () => {
      const current = await session();
      if (!current.supports('chat.archive')) return;
      checkErrorCode(
        await current.dispatchAs(
          { type: 'chat.archive', chatId: 'c1' },
          fromIdle('archive-running'),
        ),
        ['invalid_target'],
        'a running chat is not archived',
      );
      const action = { type: 'chat.archive', chatId: 'c2' };
      const first = await current.dispatchAs(action, fromCurrent('archive-1'));
      checkEqual(
        at(first.json, 'result'),
        { chatId: 'c2', archived: true },
        'the idle chat is archived',
      );
      checkEqual(
        await stateOf(current, 'c2', fromCurrent('archive-read')),
        'archived',
        'the archived chat reads as archived',
      );
      const replay = await current.dispatchAs(action, fromCurrent('archive-1'));
      checkEqual(replay.json, first.json, 'a retried call replays its result');
      for (const [chatId, toolUseId] of [
        ['c2', 'archive-2'],
        ['c3', 'archive-3'],
      ] as const) {
        const again = await current.dispatchAs(
          { type: 'chat.archive', chatId },
          fromCurrent(toolUseId),
        );
        checkEqual(
          at(again.json, 'result'),
          { chatId, archived: false },
          `${chatId} was already archived`,
        );
      }
    });
  });

  t.describe('settings navigation contract', () => {
    t.it(
      'opens validated routes and refuses malformed routes and organizations outside membership',
      async () => {
        const current = await session();
        const open = (
          destination: unknown,
        ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
          current.dispatch({ type: 'settings.open', destination });
        if (!current.supports('settings.open')) {
          checkErrorCode(
            await open({ scope: 'account', page: 'account' }),
            ['unsupported_action'],
            'settings on an unsupported host',
          );
          return;
        }
        const opened = async (): Promise<readonly unknown[] | null> =>
          (await current.host.control.openedSettings?.()) ?? null;
        const before = await opened();
        for (const invalid of [
          undefined,
          'https://example.com/account',
          { scope: 'account', page: 'unknown' },
          { scope: 'account', page: 'profile', invoiceId: 'i1' },
          { scope: 'organization', page: 'feed' },
          { scope: 'organization', organizationId: '../o1', page: 'feed' },
          {
            scope: 'organization',
            organizationId: world.foreign.organizationId,
            page: 'members',
            subtab: 'billing',
          },
          { scope: 'account', page: 'account', url: '/account' },
        ]) {
          const rejected = await open(invalid);
          check(
            rejected.result.isError === true &&
              rejected.result.text.includes('Invalid arguments'),
            `malformed settings route ${canonicalJson(invalid ?? null)} is refused before dispatch`,
          );
        }
        if (before !== null)
          checkEqual(await opened(), before, 'malformed routes open nothing');
        const accounts: SettingsRoute[] = (
          ['security', 'plugins', 'mcp'] as const
        ).map((page) => ({ scope: 'account', page }));
        for (const account of accounts) {
          const accountResult = await open(account);
          check(at(accountResult.json, 'ok') === true, 'account settings open');
          checkOpened(at(accountResult.json, 'result'), account);
        }
        // Every current membership opens; none is singled out.
        const organizations: SettingsRoute[] = world.organizations.map(
          (membership) => ({
            scope: 'organization',
            organizationId: membership.organizationId,
            page: 'settings',
            subtab: 'billing',
          }),
        );
        for (const organization of organizations) {
          const organizationResult = await open(organization);
          check(
            at(organizationResult.json, 'ok') === true,
            `member organization ${canonicalJson(organization)} settings open`,
          );
          checkOpened(at(organizationResult.json, 'result'), organization);
        }
        const outside = await open({
          scope: 'organization',
          organizationId: world.foreign.organizationId,
          page: 'members',
        });
        checkErrorCode(
          outside,
          ['invalid_target'],
          'organization outside membership',
        );
        checkEqual(
          at(outside.json, 'result'),
          { status: 'rejected', reason: 'organization_not_member' },
          'organization outside membership reason',
        );
        const finalOpened = await opened();
        if (before !== null)
          checkEqual(
            finalOpened,
            [...before, ...accounts, ...organizations],
            'only validated member destinations were opened',
          );
      },
    );
  });

  t.describe('AI gateway settings contract', () => {
    t.it(
      'reads the Personal gateway without keys, refuses organizations outside membership, and changes nothing a host cannot confirm',
      async () => {
        const current = await session();
        const dispatch = (
          action: Record<string, unknown>,
        ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
          current.dispatch({ type: 'settings.ai_gateway.get', ...action });
        if (!current.supports('settings.ai_gateway.get')) {
          checkErrorCode(
            await dispatch({ scope: { kind: 'personal' } }),
            ['unsupported_action'],
            'AI gateway on an unsupported host',
          );
          return;
        }
        const personal = await dispatch({ scope: { kind: 'personal' } });
        check(at(personal.json, 'ok') === true, 'Personal gateway reads');
        const personalId = stringAt(
          personal.json,
          'result',
          'scope',
          'expectedOrganizationId',
        );
        check(
          stringAt(personal.json, 'result', 'scope', 'kind') === 'personal' &&
            personalId !== undefined,
          'the Personal read names its organization',
        );
        check(
          !personal.result.text.toLowerCase().includes('apikey'),
          'a gateway read carries no key',
        );
        checkErrorCode(
          await dispatch({
            scope: {
              kind: 'organization',
              // Gateway scopes take UUIDs; the account belongs to no
              // organization with this one.
              organizationId: '00000000-0000-4000-8000-0000000000ff',
            },
          }),
          ['invalid_target', 'not_found'],
          'organization outside membership gateway',
        );
        const control = current.host.control;
        if (!control.gatewayWriteCount || personalId === undefined) return;
        const scope = { kind: 'personal', expectedOrganizationId: personalId };
        for (const change of [
          {
            type: 'settings.ai_gateway.connect',
            scope,
            baseUrl: 'https://gateway.example',
          },
          {
            type: 'settings.ai_gateway.update',
            scope,
            expectedRevision: 'absent',
            patch: { enabled: false },
          },
        ]) {
          checkErrorCode(
            await current.dispatch(change),
            ['missing_capability'],
            `${change.type} without a confirmation`,
          );
        }
        checkEqual(
          control.gatewayWriteCount(),
          0,
          'refused gateway changes change nothing',
        );
      },
    );
  });

  t.describe('project and bot target contract', () => {
    t.it(
      'advertises explicit targets, refuses invalid payloads before the port, and refuses unsupported hosts',
      async () => {
        const current = await session();
        const action = {
          type: 'projects.list_tasks',
          projectId: 'conformance-project',
        };
        if (!current.supports(action.type)) {
          checkErrorCode(
            await current.dispatch(action),
            ['unsupported_action'],
            'projects on an unsupported host',
          );
          return;
        }
        // The family keeps its explicit target: search advertises it as a
        // required field instead of hiding it as runtime scope.
        const searched = await current.execute('search_actions', {
          actionType: action.type,
        });
        const entry = arrayAt(parseJson(searched.text), 'actions').find(
          (candidate) => stringAt(candidate, 'type') === action.type,
        );
        check(
          arrayAt(entry, 'requiredFields').includes('projectId'),
          'projects.list_tasks advertises projectId as a target field',
        );
        const invalid: Record<string, unknown>[] = [
          { type: action.type },
          { ...action, projectId: '' },
          { ...action, unexpected: true },
        ];
        if (current.supports('projects.send_message'))
          invalid.push({
            type: 'projects.send_message',
            projectId: 'conformance-project',
            taskId: 'conformance-task',
            chatId: 'conformance-chat',
            text: '   ',
          });
        for (const payload of invalid) {
          const rejected = await current.dispatch(payload);
          check(
            rejected.result.isError === true &&
              rejected.result.text.includes('Invalid arguments'),
            `invalid project payload ${JSON.stringify(payload)} is refused before dispatch`,
          );
        }
      },
    );
  });

  /**
   * The environment writes that count against the limits and this host
   * offers. Forks are covered by the split-port tests: a host's split
   * runtime need not go through the limits.
   */
  function limitedWrites(current: Session<H>): LimitedWrite[] {
    const writes: LimitedWrite[] = [];
    if (current.supports('chat.create')) {
      writes.push({
        label: 'chat.create',
        run: (toolUseId, turnKey, actorKey) =>
          current.dispatch(
            { type: 'chat.create', message: `Task for ${toolUseId}` },
            {
              toolUseId,
              ...(turnKey ? { turnKey } : {}),
              ...(actorKey ? { actorKey } : {}),
            },
          ),
      });
    }
    if (current.supports('chat.send_message')) {
      writes.push({
        label: 'chat.send_message',
        run: (toolUseId, turnKey, actorKey) =>
          current.dispatch(
            {
              type: 'chat.send_message',
              chatId: 'c2',
              message: `Message for ${toolUseId}`,
            },
            {
              toolUseId,
              ...(turnKey ? { turnKey } : {}),
              ...(actorKey ? { actorKey } : {}),
            },
          ),
      });
    }
    return writes;
  }

  /** The writes this host offers, as actions whose request text varies. */
  function reusableWrites(current: Session<H>): {
    label: string;
    action: (text: string) => Record<string, unknown>;
  }[] {
    const writes: {
      label: string;
      action: (text: string) => Record<string, unknown>;
    }[] = [];
    if (current.supports('chat.create')) {
      writes.push({
        label: 'chat.create',
        action: (text) => ({ type: 'chat.create', message: text }),
      });
    }
    if (current.supports('chat.send_message')) {
      const target = world.chats.find(
        (chat) =>
          chat.chatId !== world.current.chatId && chat.state !== 'archived',
      );
      if (target) {
        writes.push({
          label: 'chat.send_message',
          action: (text) => ({
            type: 'chat.send_message',
            chatId: target.chatId,
            message: text,
          }),
        });
      }
    }
    return writes;
  }

  /**
   * A settings destination a host opened, or, for a host with no UI to
   * navigate, the web settings link it answered: the route's own path.
   */
  function checkOpened(result: unknown, destination: SettingsRoute): void {
    if (stringAt(result, 'status') !== 'link') {
      checkEqual(
        result,
        { status: 'opened', destination },
        'opened settings destination',
      );
      return;
    }
    checkEqual(
      at(result, 'destination'),
      destination,
      'linked settings destination',
    );
    const url = stringAt(result, 'url');
    let path: string | undefined;
    try {
      const parsed = new URL(url ?? '');
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      path = undefined;
    }
    checkEqual(
      path,
      settingsRouteToPath(destination),
      'settings link is the route web path',
    );
  }

  function checkErrorCode(
    outcome: { result: AgentActionToolResult; json: unknown },
    codes: readonly string[],
    label: string,
  ): void {
    check(
      outcome.result.isError === true,
      `${label}: expected an error result`,
    );
    const code = stringAt(outcome.json, 'error', 'code');
    check(
      code !== undefined && codes.includes(code),
      `${label}: expected error code ${codes.join(' or ')}, received ${code ?? outcome.result.text}`,
    );
  }

  function runStep(current: Session<H>, step: ScenarioStep): Promise<void> {
    return current.execute('dispatch_action', step.args).then((result) => {
      const expect = step.expect;
      checkEqual(
        result.isError === true,
        expect.isError,
        `${step.name}: isError`,
      );
      if (expect.text !== undefined) {
        checkEqual(result.text, expect.text, `${step.name}: text`);
      }
      if (expect.textPrefix !== undefined) {
        check(
          result.text.startsWith(expect.textPrefix),
          `${step.name}: expected text to start with ${JSON.stringify(expect.textPrefix)}, received ${JSON.stringify(result.text)}`,
        );
      }
      const json = parseJson(result.text);
      if (expect.json !== undefined) {
        checkSubset(json, expect.json, `${step.name}: result`);
      }
      if (expect.errorCodes) {
        checkErrorCode({ result, json }, expect.errorCodes, step.name);
      }
    });
  }

  t.describe('agent action conformance', () => {
    t.describe('tool surface', () => {
      t.it('advertises the tools its capabilities offer', async () => {
        const current = await session();
        checkEqual(
          current.host.surface
            .toolDefinitions()
            .map((definition) => definition.key),
          expectedToolKeys(current.host.capabilities),
          'tool keys',
        );
      });

      t.it('emits no empty enum or unknown required property', async () => {
        const current = await session();
        for (const definition of current.host.surface.toolDefinitions()) {
          for (const problem of schemaProblems(definition.inputSchema, '')) {
            check(false, `${definition.key} schema: ${problem}`);
          }
        }
      });

      t.it('matches the golden tool descriptions and schemas', async () => {
        const current = await session();
        const capabilities = current.host.capabilities;
        const aiGateway = current.supports('settings.ai_gateway.get');
        const goldenWording =
          sameDescriptionCapabilities(capabilities, golden.capabilities) &&
          canonicalJson(
            sharedActionOffer(world, capabilities, aiGateway).actions.map(
              (action) => action.type,
            ),
          ) === canonicalJson(golden.capabilities.actionTypes);
        for (const definition of current.host.surface.toolDefinitions()) {
          const frozen = golden.tools.find(
            (tool) => tool.key === definition.key,
          );
          if (!frozen) continue;
          const reworded = goldenWording
            ? null
            : capabilityWordedTool(
                definition.key,
                world,
                capabilities,
                aiGateway,
              );
          const expected = reworded ? { ...frozen, ...reworded } : frozen;
          checkEqual(definition.name, expected.name, `${definition.key} name`);
          checkEqual(
            definition.description,
            expected.description,
            `${definition.key} description`,
          );
          checkToolSchema(
            definition,
            expected.inputSchema,
            capabilities,
            world,
          );
        }
      });
    });

    t.describe('search', () => {
      t.it('ranks an exact action type first', async () => {
        const current = await session();
        for (const type of ENVIRONMENT_ACTION_TYPES.filter(current.supports)) {
          const result = await current.execute('search_actions', {
            actionType: type,
          });
          checkEqual(
            stringAt(parseJson(result.text), 'actions', 0, 'type'),
            type,
            `SearchActions actionType ${type}`,
          );
        }
      });

      t.it(
        'lists environment actions of a category in catalog order',
        async () => {
          const current = await session();
          // Search-hidden aliases appear only for an exact actionType lookup.
          const hidden = new Set(
            current.host.capabilities.searchHiddenActionTypes ?? [],
          );
          for (const category of ['workspace', 'worktree', 'chat', 'models']) {
            const result = await current.execute('search_actions', {
              category,
              limit: 50,
            });
            checkEqual(
              arrayAt(parseJson(result.text), 'actions')
                .map((action) => stringAt(action, 'type'))
                .filter(
                  (type) => type !== undefined && ENVIRONMENT_TYPES.has(type),
                ),
              environmentActionCatalog(world.brand)
                .filter((entry) => entry.category === category)
                .map((entry) => entry.type)
                .filter((type) => current.supports(type) && !hidden.has(type)),
              `SearchActions category ${category}`,
            );
          }
        },
      );

      t.it('hides the runtime scope fields', async () => {
        const current = await session();
        const result = await current.execute('search_actions', { limit: 50 });
        for (const action of arrayAt(parseJson(result.text), 'actions')) {
          const type = stringAt(action, 'type');
          if (type === undefined || !ENVIRONMENT_TYPES.has(type)) continue;
          for (const hidden of ['projectId', 'worktreeId']) {
            check(
              !arrayAt(action, 'fields').some(
                (field) => stringAt(field, 'name') === hidden,
              ) && at(action, 'example', hidden) === undefined,
              `SearchActions ${type} exposes ${hidden}`,
            );
          }
        }
      });
    });

    for (const group of ['reads', 'envelope', 'scoping'] as const) {
      t.describe(group, () => {
        for (const step of scenario.steps.filter(
          (entry) => entry.group === group,
        )) {
          t.it(step.name, async () => {
            const current = await session();
            if (!(step.requires ?? []).every(current.supports)) return;
            await runStep(current, step);
          });
        }
      });
    }

    t.describe('transcript reads', () => {
      const target = world.transcript.target;
      const contentAction = {
        type: 'chat.content.read',
        target,
        messageId: 'retained-older',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
        limit: 48,
      };
      const blocksAction = {
        type: 'chat.transcript.blocks.page',
        target,
        messageId: 'retained-older',
        limit: 2,
      };
      const payload = (type: string): Record<string, unknown> =>
        type === 'chat.transcript.page'
          ? { type, target }
          : type === 'chat.content.read'
            ? contentAction
            : blocksAction;
      const offered = (current: Session<H>, type: string): boolean =>
        current.host.capabilities.actionTypes.includes(type);
      const invalidArguments = async (
        current: Session<H>,
        action: Record<string, unknown>,
        label: string,
      ): Promise<void> => {
        const { result } = await current.dispatch(action);
        check(
          result.isError === true &&
            result.text.startsWith('Invalid arguments for '),
          label,
        );
      };

      t.it(
        'pages retained child rows with the returned opaque cursor',
        async () => {
          const current = await session();
          if (!offered(current, 'chat.transcript.page')) return;
          const first = await current.dispatch({
            type: 'chat.transcript.page',
            target,
          });
          checkEqual(at(first.json, 'ok'), true, 'first child page success');
          checkEqual(
            arrayAt(first.json, 'result', 'messages').map((row) =>
              at(row, 'id'),
            ),
            ['retained-third', 'retained-newest'],
            'newest child page',
          );
          const cursor = stringAt(first.json, 'result', 'cursor');
          check(
            typeof cursor === 'string' && cursor.length > 0,
            'first child page cursor',
          );
          const second = await current.dispatch({
            type: 'chat.transcript.page',
            target,
            cursor,
          });
          checkEqual(at(second.json, 'ok'), true, 'older child page success');
          checkEqual(
            arrayAt(second.json, 'result', 'messages').map((row) =>
              at(row, 'id'),
            ),
            ['retained-older', 'retained-second'],
            'older child page',
          );
          checkSubset(
            at(second.json, 'result'),
            { totalMessages: 4, transcriptRevision: 7 },
            'retained page metadata',
          );
          checkEqual(
            at(second.json, 'result', 'cursor'),
            undefined,
            'oldest child page has no continuation',
          );
        },
      );

      t.it(
        'reconstructs exact Unicode content using byte offsets and nextOffset',
        async () => {
          const current = await session();
          if (!offered(current, 'chat.content.read')) return;
          const first = await current.dispatch(contentAction);
          checkEqual(at(first.json, 'ok'), true, 'first content range success');
          checkSubset(
            at(first.json, 'result'),
            {
              text: 'début 🌿 retained child -- VCONF-MIDDLE -- ca',
              nextOffset: 48,
              byteLength: 71,
            },
            'first byte range',
          );
          const second = await current.dispatch({
            ...contentAction,
            offset: at(first.json, 'result', 'nextOffset'),
          });
          checkEqual(
            at(second.json, 'ok'),
            true,
            'second content range success',
          );
          checkSubset(
            at(second.json, 'result'),
            { text: 'fé 漢字 -- VCONF-END', byteLength: 71 },
            'second byte range',
          );
          checkEqual(
            at(second.json, 'result', 'nextOffset'),
            undefined,
            'last range has no nextOffset',
          );
          checkEqual(
            `${stringAt(first.json, 'result', 'text')}${stringAt(second.json, 'result', 'text')}`,
            'début 🌿 retained child -- VCONF-MIDDLE -- café 漢字 -- VCONF-END',
            'exact Unicode reconstruction',
          );
        },
      );

      t.it(
        'continues bounded-v1 block pages without dropping blocks',
        async () => {
          const current = await session();
          if (!offered(current, 'chat.transcript.blocks.page')) return;
          const first = await current.dispatch(blocksAction);
          checkEqual(at(first.json, 'ok'), true, 'first block page success');
          checkSubset(
            at(first.json, 'result'),
            {
              projection: 'bounded-v1',
              firstBlockOrdinal: 0,
              nextBlockOrdinal: 2,
              blockCount: 3,
              transcriptRevision: 7,
            },
            'bounded first block page',
          );
          checkEqual(
            arrayAt(first.json, 'result', 'entries').map((entry) =>
              at(entry, 'ordinal'),
            ),
            [0, 1],
            'first block ordinals',
          );
          const cursor = stringAt(first.json, 'result', 'cursor');
          check(
            typeof cursor === 'string' && cursor.length > 0,
            'block continuation cursor',
          );
          const second = await current.dispatch({ ...blocksAction, cursor });
          checkEqual(
            at(second.json, 'ok'),
            true,
            `second block page success: ${canonicalJson(second.json)}`,
          );
          checkSubset(
            at(second.json, 'result'),
            {
              projection: 'bounded-v1',
              firstBlockOrdinal: 2,
              entries: [
                {
                  kind: 'block',
                  ordinal: 2,
                  block: { type: 'text', text: 'Final block.' },
                },
              ],
              blockCount: 3,
            },
            'last block page',
          );
          checkEqual(
            at(second.json, 'result', 'cursor'),
            undefined,
            'last block page has no cursor',
          );
          checkEqual(
            at(second.json, 'result', 'nextBlockOrdinal'),
            undefined,
            'last block page has no ordinal continuation',
          );
        },
      );

      t.it(
        'rejects unknown and foreign owners and hidden scope without body reads',
        async () => {
          const current = await session();
          for (const type of TRANSCRIPT_READ_ACTION_TYPES) {
            if (!offered(current, type)) continue;
            for (const chatId of [
              'unknown-transcript-chat',
              world.foreign.chatId,
            ]) {
              checkErrorCode(
                await current.dispatch({
                  ...payload(type),
                  target: { ...target, chatId },
                }),
                ['not_found'],
                `${type} inaccessible owner`,
              );
            }
            for (const hidden of [
              { scope: world.current },
              { workspaceId: world.foreign.workspaceId },
              { grants: ['core.chat.read'] },
              { accountId: 'foreign-account' },
            ]) {
              await invalidArguments(
                current,
                { ...payload(type), ...hidden },
                `${type} hidden scope`,
              );
            }
          }
          if (offered(current, 'chat.content.read'))
            await invalidArguments(
              current,
              { ...contentAction, field: 'unknown-field' },
              'unknown content field',
            );
          checkEqual(
            current.host.control.transcriptReadCount(),
            0,
            'invalid reads never reach body storage',
          );
        },
      );

      t.it(
        'rejects stale and wrong-kind cursors and cursor plus firstBlockOrdinal without reads',
        async () => {
          const current = await session();
          for (const type of [
            'chat.transcript.page',
            'chat.transcript.blocks.page',
          ]) {
            if (!offered(current, type)) continue;
            checkErrorCode(
              await current.dispatch({
                ...payload(type),
                cursor: 'stale-retained-cursor',
              }),
              ['invalid_target'],
              `${type} stale cursor`,
            );
          }
          if (offered(current, 'chat.transcript.blocks.page'))
            await invalidArguments(
              current,
              {
                ...blocksAction,
                cursor: 'stale-retained-cursor',
                firstBlockOrdinal: 0,
              },
              'cursor excludes firstBlockOrdinal',
            );
          checkEqual(
            current.host.control.transcriptReadCount(),
            0,
            'stale and invalid cursors read nothing',
          );
          if (
            !offered(current, 'chat.transcript.page') ||
            !offered(current, 'chat.transcript.blocks.page')
          )
            return;
          const first = await current.dispatch(blocksAction);
          const cursor = stringAt(first.json, 'result', 'cursor');
          check(typeof cursor === 'string', 'cursor used for wrong-kind check');
          const before = current.host.control.transcriptReadCount();
          checkErrorCode(
            await current.dispatch({
              type: 'chat.transcript.page',
              target,
              cursor,
            }),
            ['invalid_target'],
            'block cursor cannot page rows',
          );
          checkErrorCode(
            await current.dispatch({
              ...blocksAction,
              target: { ...target, runGeneration: 2 },
              cursor,
            }),
            ['invalid_target'],
            'cursor bound to retained run',
          );
          checkEqual(
            current.host.control.transcriptReadCount(),
            before,
            'foreign cursors read nothing',
          );
        },
      );

      t.it(
        'omits unsupported transcript types from search and rejects every dispatch before reads',
        async () => {
          const current = await session();
          for (const type of TRANSCRIPT_READ_ACTION_TYPES) {
            if (offered(current, type)) continue;
            const search = await current.execute('search_actions', {
              actionType: type,
            });
            checkEqual(
              arrayAt(parseJson(search.text), 'actions'),
              [],
              `${type} unsupported search`,
            );
            checkErrorCode(
              await current.dispatch(payload(type)),
              ['unsupported_action'],
              `${type} unsupported dispatch`,
            );
          }
          checkEqual(
            current.host.control.transcriptReadCount(),
            0,
            'unsupported reads never reach backend',
          );
        },
      );
    });

    t.describe('chat.create', () => {
      t.it('starts an independent chat in the current worktree', async () => {
        const current = await session();
        if (
          !current.supports('chat.create') ||
          !current.host.capabilities.chatCreatePlacements.includes('current')
        )
          return;
        const created = await current.dispatch({
          type: 'chat.create',
          message: 'Summarize the open work.',
        });
        checkSubset(
          created.json,
          {
            ok: true,
            result: {
              worktreeId: world.current.worktreeId,
              placement: 'current',
              delivery: 'submitted',
              independent: true,
              watchers: null,
            },
          },
          'chat.create current receipt',
        );
        const chatId = stringAt(created.json, 'result', 'chatId');
        check(
          chatId !== undefined && chatId !== world.current.chatId,
          'chat.create returns a new chat id',
        );
        if (chatId !== undefined && current.supports('chat.get')) {
          const read = await current.dispatch({ type: 'chat.get', chatId });
          checkSubset(
            read.json,
            {
              ok: true,
              result: {
                chat: { chatId, worktreeId: world.current.worktreeId },
              },
            },
            'chat.get of the created chat',
          );
        }
      });

      t.it(
        'returns the same receipt when the same tool call is retried',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const action = { type: 'chat.create', message: 'Run the checks.' };
          const first = await current.dispatch(action, {
            toolUseId: 'retry-tool',
          });
          const retry = await current.dispatch(action, {
            toolUseId: 'retry-tool',
          });
          const other = await current.dispatch(action, {
            toolUseId: 'other-tool',
          });
          const firstId = stringAt(first.json, 'result', 'chatId');
          check(firstId !== undefined, 'chat.create returns a chat id');
          checkEqual(retry.result, first.result, 'retried chat.create');
          check(
            stringAt(other.json, 'result', 'chatId') !== firstId,
            'a different tool call starts a different chat',
          );
        },
      );

      t.it(
        'starts a chat in a new worktree, or fails identically',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const created = await current.dispatch(
            {
              type: 'chat.create',
              message: 'Prototype the parser.',
              placement: 'new_worktree',
              title: 'Parser spike',
            },
            { toolUseId: 'new-worktree-tool' },
          );
          const capabilities = current.host.capabilities;
          if (!capabilities.chatCreatePlacements.includes('new_worktree')) {
            checkEqual(
              created.json,
              {
                requestId: 'new-worktree-tool',
                ok: false,
                error: {
                  code: 'missing_capability',
                  message: unavailablePlacementMessage(
                    'new_worktree',
                    capabilities,
                  ),
                },
              },
              'chat.create new_worktree without the placement',
            );
            return;
          }
          checkSubset(
            created.json,
            {
              ok: true,
              result: { placement: 'new_worktree', independent: true },
            },
            'chat.create new_worktree receipt',
          );
          const delivery = stringAt(created.json, 'result', 'delivery');
          check(
            delivery === 'queued_for_setup' || delivery === 'submitted',
            `chat.create new_worktree delivery: expected queued_for_setup or submitted, received ${delivery ?? 'none'}`,
          );
          const worktreeId = stringAt(created.json, 'result', 'worktreeId');
          check(
            worktreeId !== undefined && worktreeId !== world.current.worktreeId,
            'chat.create new_worktree returns a new worktree id',
          );
          if (current.supports('worktree.list')) {
            const listed = await current.dispatch({ type: 'worktree.list' });
            check(
              arrayAt(listed.json, 'result', 'worktrees').some(
                (worktree) => stringAt(worktree, 'worktreeId') === worktreeId,
              ),
              'worktree.list includes the new worktree',
            );
          }
        },
      );

      t.it(
        'returns the original receipt when a retry follows the model becoming unavailable',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const action = { type: 'chat.create', message: 'Hi', model: 'M2' };
          const first = await current.dispatch(action, {
            toolUseId: 'withdrawn-model-tool',
          });
          checkSubset(first.json, { ok: true }, 'chat.create with M2');
          await current.host.control.withdrawModel('M2');
          checkEqual(
            (
              await current.dispatch(action, {
                toolUseId: 'withdrawn-model-tool',
              })
            ).result,
            first.result,
            'chat.create retried after M2 became unavailable',
          );
          checkErrorCode(
            await current.dispatch(action, {
              toolUseId: 'withdrawn-model-new-tool',
            }),
            ['not_found'],
            'chat.create with M2 after it became unavailable',
          );
        },
      );

      t.it(
        'validates the model and thinking level before starting',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          checkErrorCode(
            await current.dispatch({
              type: 'chat.create',
              message: 'Hi',
              model: 'M9',
            }),
            ['not_found'],
            'chat.create with an unknown model',
          );
          checkErrorCode(
            await current.dispatch({
              type: 'chat.create',
              message: 'Hi',
              model: 'M1',
              thinkingLevel: 'ultra',
            }),
            ['validation_failed'],
            'chat.create with an unsupported thinking level',
          );
          checkSubset(
            (
              await current.dispatch({
                type: 'chat.create',
                message: 'Hi',
                model: 'M1',
                thinkingLevel: 'high',
              })
            ).json,
            { ok: true },
            'chat.create with a supported thinking level',
          );
          checkErrorCode(
            await current.dispatch({
              type: 'chat.create',
              message: 'Hi',
              model: 'M2',
              thinkingLevel: 'off',
            }),
            ['validation_failed'],
            'chat.create with a thinking level for a model that declares none',
          );
          checkSubset(
            (
              await current.dispatch({
                type: 'chat.create',
                message: 'Hi',
                model: 'M2',
              })
            ).json,
            { ok: true },
            'chat.create without a thinking level for a model that declares none',
          );
        },
      );
    });

    t.describe('chat.send_message', () => {
      t.it('delivers a message to another chat in the workspace', async () => {
        const current = await session();
        if (!current.supports('chat.send_message')) return;
        checkSubset(
          (
            await current.dispatch({
              type: 'chat.send_message',
              chatId: 'c2',
              message: 'Also check the docs.',
            })
          ).json,
          { ok: true, result: { chatId: 'c2', watchers: null } },
          'chat.send_message to c2',
        );
      });

      t.it(
        'returns the original receipt when a retry follows the target being archived',
        async () => {
          const current = await session();
          if (!current.supports('chat.send_message')) return;
          const action = {
            type: 'chat.send_message',
            chatId: 'c2',
            message: 'Pick up the review.',
          };
          const first = await current.dispatch(action, {
            toolUseId: 'archived-later-tool',
          });
          checkSubset(first.json, { ok: true }, 'chat.send_message to c2');
          await current.host.control.archiveChat('c2');
          checkEqual(
            (
              await current.dispatch(action, {
                toolUseId: 'archived-later-tool',
              })
            ).result,
            first.result,
            'chat.send_message retried after c2 was archived',
          );
          checkEqual(
            (
              await current.dispatch(action, {
                toolUseId: 'archived-later-new-tool',
              })
            ).json,
            {
              requestId: 'archived-later-new-tool',
              ok: false,
              error: {
                code: 'invalid_target',
                message: 'Chat c2 is archived.',
              },
            },
            'chat.send_message to c2 after it was archived',
          );
        },
      );

      t.it(
        'retry after target becomes non-messageable replays the original receipt',
        async () => {
          const current = await session();
          const control = current.host.control;
          if (!current.supports('chat.send_message')) return;
          if (!control.setChatMessageable) return;
          const action = {
            type: 'chat.send_message',
            chatId: 'c2',
            message: 'Pick up the deploy.',
          };
          const first = await current.dispatch(action, {
            toolUseId: 'unmessageable-later-tool',
          });
          checkSubset(first.json, { ok: true }, 'chat.send_message to c2');
          await control.setChatMessageable('c2', false);
          checkEqual(
            (
              await current.dispatch(action, {
                toolUseId: 'unmessageable-later-tool',
              })
            ).result,
            first.result,
            'chat.send_message retried after c2 became unmessageable',
          );
          checkErrorCode(
            await current.dispatch(action, {
              toolUseId: 'unmessageable-later-new-tool',
            }),
            ['invalid_target'],
            'chat.send_message to c2 after it became unmessageable',
          );
        },
      );

      t.it(
        'refuses a chat the host cannot message without recording, reserving, or arming anything',
        async () => {
          const current = await session();
          const control = current.host.control;
          if (!current.supports('chat.send_message')) return;
          if (!control.setChatMessageable) return;
          await control.setChatMessageable('c2', false);
          checkSubset(
            (await current.dispatch({ type: 'chat.list' })).json,
            {
              ok: true,
              result: {
                chats: [
                  { chatId: 'c1', messageable: true },
                  { chatId: 'c2', messageable: false },
                ],
              },
            },
            'chat.list with c2 unmessageable',
          );
          checkSubset(
            (await current.dispatch({ type: 'chat.get', chatId: 'c2' })).json,
            {
              ok: true,
              result: { chat: { chatId: 'c2', messageable: false } },
            },
            'chat.get of unmessageable c2',
          );
          const hold = control.holdNextMessagePost();
          hold.finish('succeed');
          let posted = false;
          void hold.started.then(() => {
            posted = true;
          });
          const refused = await current.dispatch(
            {
              type: 'chat.send_message',
              chatId: 'c2',
              message: 'Run the deploy.',
              ...(offersInlineChatWatchers(current.host.capabilities)
                ? { watchers: [{ label: 'Deploy finished' }] }
                : {}),
            },
            { toolUseId: 'unmessageable-tool' },
          );
          checkErrorCode(
            refused,
            ['invalid_target'],
            'chat.send_message to unmessageable c2',
          );
          check(
            at(refused.json, 'error', 'retryable') !== true,
            'chat.send_message to unmessageable c2: the refusal is retryable',
          );
          await Promise.resolve();
          check(
            !posted,
            'chat.send_message to unmessageable c2 reached the host write',
          );

          // The same tool call with another message would conflict with a
          // claimed receipt, and a watcher the refusal armed would fire with
          // this write's turn.
          await control.setChatMessageable('c2', true);
          checkSubset(
            (
              await current.dispatch(
                {
                  type: 'chat.send_message',
                  chatId: 'c2',
                  message: 'Run the deploy now.',
                },
                { toolUseId: 'unmessageable-tool' },
              )
            ).json,
            { ok: true, result: { chatId: 'c2', watchers: null } },
            'chat.send_message to c2 once it is messageable',
          );
          await hold.started;
          checkEqual(
            [...(await control.completeTurn('c2'))],
            [],
            'watchers fired by the refused chat.send_message',
          );
        },
      );

      t.it(
        'rejects the calling chat, archived chats, and unknown chats',
        async () => {
          const current = await session();
          if (!current.supports('chat.send_message')) return;
          checkEqual(
            (
              await current.dispatch(
                {
                  type: 'chat.send_message',
                  chatId: world.current.chatId,
                  message: 'Hi',
                },
                { toolUseId: 'self-tool' },
              )
            ).json,
            {
              requestId: 'self-tool',
              ok: false,
              error: {
                code: 'invalid_target',
                message: 'A chat cannot send a message to itself.',
              },
            },
            'chat.send_message to itself',
          );
          checkEqual(
            (
              await current.dispatch(
                { type: 'chat.send_message', chatId: 'c3', message: 'Hi' },
                { toolUseId: 'archived-tool' },
              )
            ).json,
            {
              requestId: 'archived-tool',
              ok: false,
              error: {
                code: 'invalid_target',
                message: 'Chat c3 is archived.',
              },
            },
            'chat.send_message to an archived chat',
          );
          checkErrorCode(
            await current.dispatch({
              type: 'chat.send_message',
              chatId: 'missing-chat',
              message: 'Hi',
            }),
            ['not_found'],
            'chat.send_message to an unknown chat',
          );
        },
      );
    });

    t.describe('limits', () => {
      t.it(
        'refuses a write without a turn key instead of counting it in a shared turn',
        async () => {
          const current = await session();
          if (!current.host.capabilities.limits) return;
          for (const write of reusableWrites(current)) {
            const label = write.label;
            const action = write.action(`${label} without a turn.`);
            for (
              let attempt = 0;
              attempt <= AGENT_ACTION_LIMITS.perParentTurn;
              attempt += 1
            ) {
              checkSubset(
                (
                  await current.dispatchAs(action, {
                    actorKey: 'conformance-actor',
                    toolUseId: `no-turn-${label}-${attempt}`,
                  })
                ).json,
                {
                  ok: false,
                  error: { code: 'surface_unavailable', retryable: true },
                },
                `${label} without a turn key on a host with limits`,
              );
            }
            checkSubset(
              (
                await current.dispatch(action, {
                  toolUseId: `no-turn-${label}-0`,
                  turnKey: `turn-after-no-turn-${label}`,
                })
              ).json,
              { ok: true },
              `${label} under the same tool-use id once a turn key is known`,
            );
          }
        },
      );

      t.it('caps chats per parent turn', async () => {
        const current = await session();
        const perParentTurn = perTurnCap(current.host);
        if (perParentTurn === null) return;
        if (
          !current.host.capabilities.limits ||
          !current.supports('chat.create')
        )
          return;
        for (let index = 0; index < perParentTurn; index += 1) {
          checkSubset(
            (
              await current.dispatch({
                type: 'chat.create',
                message: `Task ${index}`,
              })
            ).json,
            { ok: true },
            `chat.create ${index + 1} in one turn`,
          );
        }
        checkSubset(
          (
            await current.dispatch({
              type: 'chat.create',
              message: 'One too many',
            })
          ).json,
          {
            ok: false,
            result: {
              reason: 'per_turn',
              limit: perParentTurn,
            },
            error: { code: 'quota_exceeded' },
          },
          'chat.create past the per-turn limit',
        );
      });

      for (const retry of ['none', 'fail', 'succeed'] as const) {
        t.it(
          `counts a write that timed out once against the per-turn cap (retry: ${retry})`,
          async () => {
            const current = await session();
            const perParentTurn = perTurnCap(current.host);
            if (perParentTurn === null) return;
            if (!current.host.capabilities.limits) return;
            for (const write of limitedWrites(current)) {
              const turnKey = `timed-out-turn-${write.label}`;
              const toolUseId = `timed-out-${write.label}`;
              const hold = (): AgentConformanceWriteHold =>
                write.label === 'chat.create'
                  ? current.host.control.holdNextChatStart()
                  : current.host.control.holdNextMessagePost();
              const timeoutHold = hold();
              const timedOut = write.run(toolUseId, turnKey);
              await timeoutHold.started;
              timeoutHold.finish('timeout');
              checkErrorCode(
                await timedOut,
                ['timeout'],
                `${write.label} whose outcome is unknown`,
              );
              if (retry === 'fail') {
                const failHold = hold();
                const failed = write.run(toolUseId, turnKey);
                await failHold.started;
                failHold.finish('fail');
                checkErrorCode(
                  await failed,
                  ['execution_failed'],
                  `${write.label} retried after the timeout, failing`,
                );
              }
              if (retry === 'succeed') {
                const retried = await write.run(toolUseId, turnKey);
                checkSubset(
                  retried.json,
                  { ok: true },
                  `${write.label} retried after the timeout`,
                );
                checkEqual(
                  (await write.run(toolUseId, turnKey)).result,
                  retried.result,
                  `${write.label} replayed after its retry succeeded`,
                );
              }
              for (let index = 1; index < perParentTurn; index += 1) {
                checkSubset(
                  (
                    await write.run(
                      `after-timeout-${write.label}-${index}`,
                      turnKey,
                    )
                  ).json,
                  { ok: true },
                  `${write.label} ${index + 1} in the turn after the timed-out write`,
                );
              }
              checkSubset(
                (await write.run(`after-timeout-${write.label}-over`, turnKey))
                  .json,
                {
                  ok: false,
                  result: {
                    reason: 'per_turn',
                    limit: perParentTurn,
                  },
                  error: { code: 'quota_exceeded' },
                },
                `${write.label} past the per-turn limit counting the timed-out write`,
              );
            }
          },
        );
      }

      for (const retry of ['none', 'fail', 'succeed'] as const) {
        t.it(
          `counts a write whose limits commit failed once against the per-turn cap (retry: ${retry})`,
          async () => {
            const current = await session();
            const perParentTurn = perTurnCap(current.host);
            if (perParentTurn === null) return;
            if (!current.host.capabilities.limits) return;
            for (const write of limitedWrites(current)) {
              const turnKey = `commit-failed-turn-${write.label}`;
              const toolUseId = `commit-failed-${write.label}`;
              await current.host.control.failNextLimitCommit();
              checkErrorCode(
                await write.run(toolUseId, turnKey),
                ['execution_failed'],
                `${write.label} that happened but whose limits commit failed`,
              );
              if (retry === 'fail') {
                const failHold =
                  write.label === 'chat.create'
                    ? current.host.control.holdNextChatStart()
                    : current.host.control.holdNextMessagePost();
                const failed = write.run(toolUseId, turnKey);
                await failHold.started;
                failHold.finish('fail');
                checkErrorCode(
                  await failed,
                  ['execution_failed'],
                  `${write.label} retried after its limits commit failed, failing`,
                );
              }
              if (retry === 'succeed') {
                const retried = await write.run(toolUseId, turnKey);
                checkSubset(
                  retried.json,
                  { ok: true },
                  `${write.label} retried after its limits commit failed`,
                );
                checkEqual(
                  (await write.run(toolUseId, turnKey)).result,
                  retried.result,
                  `${write.label} replayed after its retry succeeded`,
                );
              }
              for (let index = 1; index < perParentTurn; index += 1) {
                checkSubset(
                  (
                    await write.run(
                      `after-commit-failure-${write.label}-${index}`,
                      turnKey,
                    )
                  ).json,
                  { ok: true },
                  `${write.label} ${index + 1} in the turn after the write whose limits commit failed`,
                );
              }
              checkSubset(
                (
                  await write.run(
                    `after-commit-failure-${write.label}-over`,
                    turnKey,
                  )
                ).json,
                {
                  ok: false,
                  result: {
                    reason: 'per_turn',
                    limit: perParentTurn,
                  },
                  error: { code: 'quota_exceeded' },
                },
                `${write.label} past the per-turn limit counting the write whose limits commit failed`,
              );
            }
          },
        );
      }

      t.it(
        'returns the original receipt for every write retried at the per-turn cap',
        async () => {
          const current = await session();
          const perParentTurn = perTurnCap(current.host);
          if (perParentTurn === null) return;
          if (!current.host.capabilities.limits) return;
          const writes = limitedWrites(current);
          if (writes.length === 0) return;
          const receipts: {
            write: LimitedWrite;
            toolUseId: string;
            result: AgentActionToolResult;
          }[] = [];
          for (let index = 0; index < perParentTurn; index += 1) {
            const write = writes[index % writes.length];
            if (!write) continue;
            const toolUseId = `capped-tool-${index}`;
            const outcome = await write.run(toolUseId);
            checkSubset(
              outcome.json,
              { ok: true },
              `${write.label} ${index + 1} in one turn`,
            );
            receipts.push({ write, toolUseId, result: outcome.result });
          }
          for (const receipt of receipts) {
            const retry = await receipt.write.run(receipt.toolUseId);
            checkEqual(
              retry.result,
              receipt.result,
              `retried ${receipt.write.label} at the per-turn cap`,
            );
          }
          const [first] = writes;
          if (!first) return;
          checkSubset(
            (await first.run('capped-tool-new')).json,
            {
              ok: false,
              result: {
                reason: 'per_turn',
                limit: perParentTurn,
              },
              error: { code: 'quota_exceeded' },
            },
            `${first.label} past the per-turn limit after retries`,
          );
        },
      );

      t.it('does not count retried tool calls against the limits', async () => {
        const current = await session();
        const perParentTurn = perTurnCap(current.host);
        if (perParentTurn === null) return;
        if (!current.host.capabilities.limits) return;
        const writes = limitedWrites(current);
        if (writes.length === 0) return;
        for (const write of writes) {
          const first = await write.run(`retried-${write.label}`);
          checkSubset(first.json, { ok: true }, `${write.label} once`);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            checkEqual(
              (await write.run(`retried-${write.label}`)).result,
              first.result,
              `${write.label} retry ${attempt + 1}`,
            );
          }
        }
        const [write] = writes;
        if (!write) return;
        for (let index = writes.length; index < perParentTurn; index += 1) {
          checkSubset(
            (await write.run(`distinct-tool-${index}`)).json,
            { ok: true },
            `${write.label} ${index + 1} after retries`,
          );
        }
        checkSubset(
          (await write.run('distinct-tool-last')).json,
          {
            ok: false,
            result: {
              reason: 'per_turn',
              limit: perParentTurn,
            },
            error: { code: 'quota_exceeded' },
          },
          `${write.label} past the per-turn limit`,
        );
      });

      t.it(
        'returns the original receipt for calls replayed from earlier turns in the hour',
        async () => {
          const current = await session();
          const perUserPerHour = hourlyCap(current.host);
          if (!current.host.capabilities.limits || perUserPerHour === null)
            return;
          const writes = limitedWrites(current);
          if (writes.length === 0) return;
          const { perParentTurn } = AGENT_ACTION_LIMITS;
          const receipts: {
            write: LimitedWrite;
            toolUseId: string;
            turnKey: string;
            result: AgentActionToolResult;
          }[] = [];
          let lastTurnKey = '';
          for (let started = 0; started < perUserPerHour - 1; started += 1) {
            const write = writes[started % writes.length];
            if (!write) continue;
            lastTurnKey = `replayed-turn-${Math.floor(started / perParentTurn)}`;
            const toolUseId = `replayed-tool-${started}`;
            const outcome = await write.run(toolUseId, lastTurnKey);
            checkSubset(
              outcome.json,
              { ok: true },
              `${write.label} ${started + 1} in the hour`,
            );
            receipts.push({
              write,
              toolUseId,
              turnKey: lastTurnKey,
              result: outcome.result,
            });
          }
          const earlier = receipts.filter(
            (receipt) => receipt.turnKey !== lastTurnKey,
          );
          check(
            new Set(earlier.map((receipt) => receipt.turnKey)).size >= 2,
            'replays span at least two earlier turns',
          );
          for (const receipt of earlier) {
            checkEqual(
              (await receipt.write.run(receipt.toolUseId, receipt.turnKey))
                .result,
              receipt.result,
              `${receipt.write.label} replayed from ${receipt.turnKey}`,
            );
          }
          const [first] = writes;
          if (!first) return;
          checkSubset(
            (await first.run('replayed-tool-last', lastTurnKey)).json,
            { ok: true },
            `${first.label} filling the hour after replays`,
          );
          checkSubset(
            (await first.run('replayed-tool-over', 'replayed-turn-next')).json,
            {
              ok: false,
              result: { reason: 'per_hour', limit: perUserPerHour },
              error: { code: 'quota_exceeded' },
            },
            `${first.label} past the hourly limit after replays`,
          );
        },
      );

      t.it(
        'returns the original fork receipt after its hour passed and the hour is full',
        async () => {
          const current = await session();
          if (!current.host.capabilities.split.forked) return;
          const fork = (
            toolUseId: string,
            turnKey: string,
          ): Promise<AgentActionToolResult> =>
            current.execute(
              'start_forked_agent',
              { followUpInstruction: 'Finish the migration.' },
              { toolUseId, turnKey },
            );
          const first = await fork('fork-replay-tool', 'fork-replay-turn');
          checkSubset(
            parseJson(first.text),
            { ok: true },
            'StartForkedAgent once',
          );
          await current.host.control.advanceClock(HOUR_MS + 1);
          const perUserPerHour =
            current.host.capabilities.limits && current.supports('chat.create')
              ? hourlyCap(current.host)
              : null;
          const overHour = (): Promise<{
            result: AgentActionToolResult;
            json: unknown;
          }> =>
            current.dispatch(
              { type: 'chat.create', message: 'Past the hour' },
              { turnKey: 'fork-fill-turn-last' },
            );
          if (perUserPerHour !== null) {
            const { perParentTurn } = AGENT_ACTION_LIMITS;
            for (let started = 0; started < perUserPerHour; started += 1) {
              checkSubset(
                (
                  await current.dispatch(
                    { type: 'chat.create', message: `Fill ${started}` },
                    {
                      turnKey: `fork-fill-turn-${Math.floor(started / perParentTurn)}`,
                    },
                  )
                ).json,
                { ok: true },
                `chat.create ${started + 1} in the next hour`,
              );
            }
            checkErrorCode(
              await overHour(),
              ['quota_exceeded'],
              'chat.create past the hourly limit before the fork replay',
            );
          }
          checkEqual(
            await fork('fork-replay-tool', 'fork-replay-turn'),
            first,
            'StartForkedAgent replayed after its hour with the hour full',
          );
          if (perUserPerHour !== null) {
            checkSubset(
              (await overHour()).json,
              {
                ok: false,
                result: { reason: 'per_hour', limit: perUserPerHour },
              },
              'the hour stays full after the fork replay',
            );
          }
        },
      );

      t.it(
        'keeps the current turn at its cap when a call from an earlier turn lands late',
        async () => {
          const current = await session();
          const perParentTurn = perTurnCap(current.host);
          if (perParentTurn === null) return;
          if (
            !current.host.capabilities.limits ||
            !current.supports('chat.create')
          )
            return;
          const create = (
            turnKey: string,
            message: string,
          ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
            current.dispatch({ type: 'chat.create', message }, { turnKey });
          checkSubset(
            (await create('late-turn-old', 'Earlier turn')).json,
            { ok: true },
            'chat.create in the earlier turn',
          );
          for (let index = 0; index < perParentTurn; index += 1) {
            checkSubset(
              (await create('late-turn-new', `Current turn ${index}`)).json,
              { ok: true },
              `chat.create ${index + 1} in the current turn`,
            );
          }
          checkSubset(
            (await create('late-turn-old', 'Late call from the earlier turn'))
              .json,
            { ok: true },
            'chat.create landing late in the earlier turn',
          );
          checkSubset(
            (await create('late-turn-new', 'One too many')).json,
            {
              ok: false,
              result: { reason: 'per_turn', limit: perParentTurn },
              error: { code: 'quota_exceeded' },
            },
            'chat.create past the current turn cap after the late call',
          );
        },
      );

      t.it(
        'keeps the current turn at its cap when a turn older than an hour calls late',
        async () => {
          const current = await session();
          const perParentTurn = perTurnCap(current.host);
          if (perParentTurn === null) return;
          if (
            !current.host.capabilities.limits ||
            !current.supports('chat.create')
          )
            return;
          const create = (
            turnKey: string,
            message: string,
          ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
            current.dispatch({ type: 'chat.create', message }, { turnKey });
          checkSubset(
            (await create('pruned-turn-old', 'Earlier turn')).json,
            { ok: true },
            'chat.create in the earlier turn',
          );
          await current.host.control.advanceClock(HOUR_MS / 2);
          for (let index = 0; index < perParentTurn; index += 1) {
            checkSubset(
              (await create('pruned-turn-current', `Current ${index}`)).json,
              { ok: true },
              `chat.create ${index + 1} in the current turn`,
            );
          }
          await current.host.control.advanceClock((3 * HOUR_MS) / 2);
          checkSubset(
            (await create('pruned-turn-old', 'Late call from the earlier turn'))
              .json,
            { ok: true },
            'chat.create landing late in a turn older than an hour',
          );
          checkSubset(
            (await create('pruned-turn-current', 'One too many')).json,
            {
              ok: false,
              result: { reason: 'per_turn', limit: perParentTurn },
              error: { code: 'quota_exceeded' },
            },
            'chat.create past the current turn cap after the late call',
          );
        },
      );

      t.it('caps chats per user per hour', async () => {
        const current = await session();
        const perUserPerHour = hourlyCap(current.host);
        if (
          !current.host.capabilities.limits ||
          !current.supports('chat.create') ||
          perUserPerHour === null
        )
          return;
        const turns = Math.ceil(
          perUserPerHour / AGENT_ACTION_LIMITS.perParentTurn,
        );
        let started = 0;
        for (let turn = 0; turn < turns; turn += 1) {
          for (
            let index = 0;
            index < AGENT_ACTION_LIMITS.perParentTurn &&
            started < perUserPerHour;
            index += 1
          ) {
            started += 1;
            checkSubset(
              (
                await current.dispatch(
                  { type: 'chat.create', message: `Task ${started}` },
                  { turnKey: `hourly-turn-${turn}` },
                )
              ).json,
              { ok: true },
              `chat.create ${started} in the hour`,
            );
          }
        }
        checkSubset(
          (
            await current.dispatch(
              { type: 'chat.create', message: 'One too many' },
              { turnKey: 'hourly-turn-last' },
            )
          ).json,
          {
            ok: false,
            result: {
              reason: 'per_hour',
              limit: perUserPerHour,
            },
            error: { code: 'quota_exceeded' },
          },
          'chat.create past the hourly limit',
        );
      });

      t.it('caps how deep agent-started chats nest', async () => {
        const current = await session({
          ...world,
          callerDepth: AGENT_ACTION_LIMITS.maxDepth,
        });
        if (
          !current.host.capabilities.limits ||
          !current.supports('chat.create')
        )
          return;
        checkSubset(
          (await current.dispatch({ type: 'chat.create', message: 'Nested' }))
            .json,
          {
            ok: false,
            result: { reason: 'depth', limit: AGENT_ACTION_LIMITS.maxDepth },
            error: { code: 'quota_exceeded' },
          },
          'chat.create beyond the depth limit',
        );
        if (current.supports('chat.send_message')) {
          checkSubset(
            (
              await current.dispatch({
                type: 'chat.send_message',
                chatId: 'c2',
                message: 'Messaging does not nest.',
              })
            ).json,
            { ok: true },
            'chat.send_message at the depth limit',
          );
        }
      });
    });

    t.describe('watchers', () => {
      t.it(
        'arms inline watchers with chat.create, or fails identically',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const created = await current.dispatch(
            {
              type: 'chat.create',
              message: 'Review the change.',
              watchers: [{ label: 'Review finished' }],
            },
            { toolUseId: 'inline-watcher-tool' },
          );
          if (!offersInlineChatWatchers(current.host.capabilities)) {
            checkEqual(
              created.json,
              {
                requestId: 'inline-watcher-tool',
                ok: false,
                error: {
                  code: 'missing_capability',
                  message: INLINE_WATCHERS_UNAVAILABLE_MESSAGE,
                },
              },
              'chat.create with inline watchers on a host without them',
            );
            return;
          }
          checkSubset(
            created.json,
            { ok: true, result: { watchers: [{ ok: true }] } },
            'chat.create inline watcher',
          );
          const watcherId = stringAt(
            created.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          check(watcherId !== undefined, 'inline watchers return a watcher id');
          const searched = await current.execute('search_watchers', {});
          check(
            arrayAt(parseJson(searched.text), 'activeWatchers').some(
              (watcher) => stringAt(watcher, 'watcherId') === watcherId,
            ),
            'SearchWatchers lists the inline watcher',
          );
        },
      );

      t.it(
        'replays chat.create with its original watcher outcomes and arms nothing',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.create') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const action = {
            type: 'chat.create',
            message: 'Review the change.',
            watchers: [{ label: 'Review finished' }],
          };
          const identity = { toolUseId: 'inline-watcher-replay-tool' };
          const first = await current.dispatch(action, identity);
          const watcherId = stringAt(
            first.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          check(watcherId !== undefined, 'inline watchers return a watcher id');
          if (watcherId === undefined) return;
          const activeWatcherIds = async (): Promise<string[]> =>
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ).flatMap((watcher) => {
              const id = stringAt(watcher, 'watcherId');
              return id === undefined ? [] : [id];
            });
          const before = await activeWatcherIds();
          checkEqual(
            (await current.dispatch(action, identity)).result,
            first.result,
            'chat.create with inline watchers retried',
          );
          checkEqual(
            await activeWatcherIds(),
            before,
            'active watchers after the retry',
          );
          await current.execute('delete_watchers', { watcherIds: [watcherId] });
          checkEqual(
            (await current.dispatch(action, identity)).result,
            first.result,
            'chat.create retried after its watcher was deleted',
          );
          check(
            !(await activeWatcherIds()).includes(watcherId),
            'a retry does not arm the deleted watcher again',
          );
          checkEqual(
            (await activeWatcherIds()).length,
            before.length - 1,
            'a retry arms no watcher',
          );
        },
      );

      t.it(
        'returns an identical active watcher unless allowDuplicate is set',
        async () => {
          const current = await session();
          if (
            !current.host.capabilities.watcherTriggers.includes(
              'worktree_chat_completion',
            )
          )
            return;
          const other = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state !== 'archived',
          );
          if (!other) return;
          const setup = async (
            extra: Record<string, unknown>,
          ): Promise<string | undefined> =>
            stringAt(
              parseJson(
                (
                  await current.execute('setup_watchers', {
                    watchers: [
                      {
                        trigger: 'worktree_chat_completion',
                        target: {
                          projectId: world.workspace.workspaceId,
                          worktreeId: other.worktreeId,
                          chatId: other.chatId,
                        },
                        label: 'Dedupe check',
                        followUpInstruction: 'Summarize the result.',
                        armForNextCompletion: true,
                        ...extra,
                      },
                    ],
                  })
                ).text,
              ),
              'watchers',
              0,
              'result',
              'watcherId',
            );
          const activeIds = async (): Promise<string[]> =>
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ).flatMap((watcher) => {
              const id = stringAt(watcher, 'watcherId');
              return id === undefined ? [] : [id];
            });
          const first = await setup({});
          check(first !== undefined, 'SetupWatchers arms the first watcher');
          checkEqual(
            await setup({}),
            first,
            'an identical SetupWatchers call returns the active watcher',
          );
          checkEqual(
            await setup({ allowDuplicate: false }),
            first,
            'allowDuplicate: false returns the active watcher',
          );
          checkEqual(
            (await activeIds()).filter((id) => id === first).length,
            1,
            'the identical watcher is active once',
          );
          const duplicate = await setup({ allowDuplicate: true });
          check(
            duplicate !== undefined && duplicate !== first,
            'allowDuplicate: true arms another watcher',
          );
          const active = await activeIds();
          check(
            first !== undefined &&
              duplicate !== undefined &&
              active.includes(first) &&
              active.includes(duplicate),
            'both watchers are active after allowDuplicate',
          );
        },
      );

      t.it(
        'arms inline watchers privately and keeps a SetupWatchers watcher when the message fails',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state !== 'archived',
          );
          if (!target) return;
          const inline = {
            label: 'Reply ready',
            followUpInstruction: 'Read the reply.',
          };
          const setup = parseJson(
            (
              await current.execute('setup_watchers', {
                watchers: [
                  {
                    trigger: 'worktree_chat_completion',
                    target: {
                      projectId: world.workspace.workspaceId,
                      worktreeId: target.worktreeId,
                      chatId: target.chatId,
                    },
                    ...inline,
                    armForNextCompletion: true,
                  },
                ],
              })
            ).text,
          );
          const existing = stringAt(
            setup,
            'watchers',
            0,
            'result',
            'watcherId',
          );
          check(existing !== undefined, 'SetupWatchers arms the watcher');
          const activeIds = async (): Promise<string[]> =>
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            )
              .flatMap((watcher) => {
                const id = stringAt(watcher, 'watcherId');
                return id === undefined ? [] : [id];
              })
              .sort();
          const before = await activeIds();
          const hold = current.host.control.holdNextMessagePost();
          const sent = current.dispatch({
            type: 'chat.send_message',
            chatId: target.chatId,
            message: 'Check this.',
            watchers: [inline, { label: 'Also tell me' }],
          });
          await hold.started;
          hold.finish('fail');
          checkErrorCode(
            await sent,
            ['execution_failed'],
            'chat.send_message whose post failed',
          );
          checkEqual(
            await activeIds(),
            before,
            'active watchers after the failed message',
          );
          check(
            existing !== undefined && before.includes(existing),
            'the existing watcher is still active',
          );
          const delivered = await current.dispatch({
            type: 'chat.send_message',
            chatId: target.chatId,
            message: 'Check this too.',
            watchers: [inline],
          });
          const inlineId = stringAt(
            delivered.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          check(
            inlineId !== undefined && inlineId !== existing,
            'an inline watcher identical to a SetupWatchers watcher is its own watcher',
          );
        },
      );

      t.it(
        "keeps an overlapping message's inline watcher when another message fails",
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state !== 'archived',
          );
          if (!target) return;
          const inline = { label: 'Reply ready' };
          const hold = current.host.control.holdNextMessagePost();
          const first = current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'First message.',
              watchers: [inline],
            },
            { toolUseId: 'overlap-watcher-a' },
          );
          await hold.started;
          const second = await current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'Second message.',
              watchers: [inline],
            },
            { toolUseId: 'overlap-watcher-b' },
          );
          checkSubset(
            second.json,
            { ok: true, result: { watchers: [{ ok: true }] } },
            'the overlapping message with an identical inline watcher',
          );
          const secondWatcher = stringAt(
            second.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          hold.finish('fail');
          checkErrorCode(
            await first,
            ['execution_failed'],
            'the held message whose post failed',
          );
          const active = arrayAt(
            parseJson((await current.execute('search_watchers', {})).text),
            'activeWatchers',
          ).map((watcher) => stringAt(watcher, 'watcherId'));
          check(
            secondWatcher !== undefined && active.includes(secondWatcher),
            "the overlapping message's inline watcher is still active",
          );
        },
      );

      t.it(
        'fires an inline watcher on the turn its message submitted, not a turn already running',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state === 'idle',
          );
          if (!target) return;
          checkSubset(
            (
              await current.dispatch(
                {
                  type: 'chat.send_message',
                  chatId: target.chatId,
                  message: 'Start the review.',
                },
                { toolUseId: 'busy-first-tool' },
              )
            ).json,
            { ok: true, result: { delivery: 'submitted' } },
            'the message that makes the target busy',
          );
          const setupWatcher = stringAt(
            parseJson(
              (
                await current.execute('setup_watchers', {
                  watchers: [
                    {
                      trigger: 'worktree_chat_completion',
                      target: {
                        projectId: world.workspace.workspaceId,
                        worktreeId: target.worktreeId,
                        chatId: target.chatId,
                      },
                      label: 'Next completion',
                    },
                  ],
                })
              ).text,
            ),
            'watchers',
            0,
            'result',
            'watcherId',
          );
          const queued = await current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'Then check the docs.',
              watchers: [{ label: 'Docs checked' }],
            },
            { toolUseId: 'busy-second-tool' },
          );
          checkSubset(
            queued.json,
            {
              ok: true,
              result: { delivery: 'queued', watchers: [{ ok: true }] },
            },
            'the message queued behind the running turn',
          );
          const inlineWatcher = stringAt(
            queued.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          check(
            setupWatcher !== undefined && inlineWatcher !== undefined,
            'both watchers were armed',
          );
          checkEqual(
            [...(await current.host.control.completeTurn(target.chatId))],
            [setupWatcher],
            'watchers fired when the running turn finished',
          );
          checkEqual(
            [...(await current.host.control.completeTurn(target.chatId))],
            [inlineWatcher],
            'watchers fired when the queued turn finished',
          );
        },
      );

      t.it(
        'never dedupes a SetupWatchers watcher onto an inline watcher bound to a queued message',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state === 'idle',
          );
          if (!target) return;
          const watcher = {
            label: 'Reply ready',
            followUpInstruction: 'Read it.',
          };
          await current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'Start the review.',
            },
            { toolUseId: 'dedupe-busy-first-tool' },
          );
          const queued = await current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'Then check the docs.',
              watchers: [watcher],
            },
            { toolUseId: 'dedupe-busy-second-tool' },
          );
          const inlineWatcher = stringAt(
            queued.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          const setupWatcher = stringAt(
            parseJson(
              (
                await current.execute('setup_watchers', {
                  watchers: [
                    {
                      trigger: 'worktree_chat_completion',
                      target: {
                        projectId: world.workspace.workspaceId,
                        worktreeId: target.worktreeId,
                        chatId: target.chatId,
                      },
                      ...watcher,
                    },
                  ],
                })
              ).text,
            ),
            'watchers',
            0,
            'result',
            'watcherId',
          );
          check(
            inlineWatcher !== undefined &&
              setupWatcher !== undefined &&
              setupWatcher !== inlineWatcher,
            'SetupWatchers armed its own watcher beside the inline one',
          );
          checkEqual(
            [...(await current.host.control.completeTurn(target.chatId))],
            [setupWatcher],
            'watchers fired when the running turn finished',
          );
          checkEqual(
            [...(await current.host.control.completeTurn(target.chatId))],
            [inlineWatcher],
            'watchers fired when the queued turn finished',
          );
        },
      );

      t.it(
        'keeps a SetupWatchers watcher armed beside a held message when that message fails',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state === 'idle',
          );
          if (!target) return;
          const watcher = {
            label: 'Reply ready',
            followUpInstruction: 'Read it.',
          };
          const hold = current.host.control.holdNextMessagePost();
          const held = current.dispatch(
            {
              type: 'chat.send_message',
              chatId: target.chatId,
              message: 'Check the docs.',
              watchers: [watcher],
            },
            { toolUseId: 'held-dedupe-tool' },
          );
          await hold.started;
          const setupWatcher = stringAt(
            parseJson(
              (
                await current.execute('setup_watchers', {
                  watchers: [
                    {
                      trigger: 'worktree_chat_completion',
                      target: {
                        projectId: world.workspace.workspaceId,
                        worktreeId: target.worktreeId,
                        chatId: target.chatId,
                      },
                      armForNextCompletion: true,
                      ...watcher,
                    },
                  ],
                })
              ).text,
            ),
            'watchers',
            0,
            'result',
            'watcherId',
          );
          check(setupWatcher !== undefined, 'SetupWatchers armed a watcher');
          hold.finish('fail');
          checkErrorCode(
            await held,
            ['execution_failed'],
            'the held message whose post failed',
          );
          const active = arrayAt(
            parseJson((await current.execute('search_watchers', {})).text),
            'activeWatchers',
          ).map((entry) => stringAt(entry, 'watcherId'));
          checkEqual(
            active,
            [setupWatcher],
            'active watchers after the held message failed',
          );
        },
      );

      t.it(
        'rejects a SetupWatchers label over 200 characters and arms nothing',
        async () => {
          const current = await session();
          if (!offersInlineChatWatchers(current.host.capabilities)) return;
          const other = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state !== 'archived',
          );
          if (!other) return;
          const setup = (label: string): Promise<AgentActionToolResult> =>
            current.execute('setup_watchers', {
              watchers: [
                {
                  trigger: 'worktree_chat_completion',
                  target: {
                    projectId: world.workspace.workspaceId,
                    worktreeId: other.worktreeId,
                    chatId: other.chatId,
                  },
                  label,
                  armForNextCompletion: true,
                },
              ],
            });
          const tooLong = await setup('x'.repeat(201));
          check(
            tooLong.isError === true &&
              tooLong.text.startsWith('Invalid arguments for '),
            `a 201-character label is invalid arguments, received ${tooLong.text}`,
          );
          checkEqual(
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ),
            [],
            'active watchers after the rejected label',
          );
          checkSubset(
            parseJson((await setup('x'.repeat(200))).text),
            { watchers: [{ ok: true }] },
            'a 200-character label',
          );
        },
      );

      t.it(
        "keeps a message's inline watcher when its post times out, and its retry reuses it",
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state === 'idle',
          );
          if (!target) return;
          const action = {
            type: 'chat.send_message',
            chatId: target.chatId,
            message: 'Review the parser.',
            watchers: [{ label: 'Review finished' }],
          };
          const hold = current.host.control.holdNextMessagePost();
          const timedOut = current.dispatch(action, {
            toolUseId: 'timeout-watcher-tool',
          });
          await hold.started;
          hold.finish('timeout');
          const first = await timedOut;
          checkErrorCode(
            first,
            ['timeout'],
            'the post whose outcome is unknown',
          );
          check(
            at(first.json, 'error', 'retryable') === true,
            'the timed-out post is retryable',
          );
          // The message landed: its turn finishes and the kept watcher fires.
          const fired = [
            ...(await current.host.control.completeTurn(target.chatId)),
          ];
          checkEqual(fired.length, 1, 'watchers fired by the delivered turn');
          const retried = await current.dispatch(action, {
            toolUseId: 'timeout-watcher-tool',
          });
          checkSubset(
            retried.json,
            { ok: true, result: { watchers: [{ ok: true }] } },
            'the retried post',
          );
          checkEqual(
            stringAt(retried.json, 'result', 'watchers', 0, 'watcherId'),
            fired[0],
            'the retry reports the watcher that already fired',
          );
          checkEqual(
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ),
            [],
            'active watchers after the retry',
          );
        },
      );

      t.it(
        "keeps a timed-out message's inline watcher when a retry of its post fails",
        async () => {
          const current = await session();
          if (
            !current.supports('chat.send_message') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const target = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state === 'idle',
          );
          if (!target) return;
          const action = {
            type: 'chat.send_message',
            chatId: target.chatId,
            message: 'Review the parser.',
            watchers: [{ label: 'Review finished' }],
          };
          const identity = { toolUseId: 'timeout-then-fail-watcher-tool' };
          const timeoutHold = current.host.control.holdNextMessagePost();
          const timedOut = current.dispatch(action, identity);
          await timeoutHold.started;
          timeoutHold.finish('timeout');
          checkErrorCode(
            await timedOut,
            ['timeout'],
            'the post whose outcome is unknown',
          );
          const failHold = current.host.control.holdNextMessagePost();
          const failed = current.dispatch(action, identity);
          await failHold.started;
          failHold.finish('fail');
          checkErrorCode(
            await failed,
            ['execution_failed'],
            'the retried post that failed',
          );
          const active = arrayAt(
            parseJson((await current.execute('search_watchers', {})).text),
            'activeWatchers',
          ).map((watcher) => stringAt(watcher, 'watcherId'));
          checkEqual(
            active.length,
            1,
            'active watchers after the failed retry',
          );
          checkEqual(
            [...(await current.host.control.completeTurn(target.chatId))],
            active,
            "watchers fired by the timed-out message's turn",
          );
        },
      );

      t.it(
        'completes a chat.create watcher once when its start timed out and its turn finished before the retry',
        async () => {
          const current = await session();
          if (
            !current.supports('chat.create') ||
            !current.supports('worktree.list') ||
            !current.supports('chat.list') ||
            !offersInlineChatWatchers(current.host.capabilities)
          )
            return;
          const chatIds = async (): Promise<string[]> => {
            const worktrees = arrayAt(
              (await current.dispatch({ type: 'worktree.list' })).json,
              'result',
              'worktrees',
            );
            const ids: string[] = [];
            for (const worktree of worktrees) {
              const inWorktreeId = stringAt(worktree, 'worktreeId');
              if (inWorktreeId === undefined) continue;
              const chats = arrayAt(
                (await current.dispatch({ type: 'chat.list', inWorktreeId }))
                  .json,
                'result',
                'chats',
              );
              for (const chat of chats) {
                const chatId = stringAt(chat, 'chatId');
                if (chatId !== undefined) ids.push(chatId);
              }
            }
            return ids;
          };
          const action = {
            type: 'chat.create',
            message: 'Review the parser.',
            watchers: [{ label: 'Review finished' }],
          };
          const identity = { toolUseId: 'timed-out-start-watcher-tool' };
          const before = new Set(await chatIds());
          const firedBefore = [...(await current.host.control.firedWatchers())];
          const hold = current.host.control.holdNextChatStart();
          const timedOut = current.dispatch(action, identity);
          await hold.started;
          hold.finish('timeout');
          checkErrorCode(
            await timedOut,
            ['timeout'],
            'the chat.create whose start timed out',
          );
          const started = (await chatIds()).filter((id) => !before.has(id));
          checkEqual(started.length, 1, 'chats the timed-out start created');
          const [chatId] = started;
          if (chatId === undefined) return;
          await current.host.control.completeTurn(chatId);
          const retried = await current.dispatch(action, identity);
          checkSubset(
            retried.json,
            { ok: true, result: { chatId, watchers: [{ ok: true }] } },
            'the retried chat.create',
          );
          const watcherId = stringAt(
            retried.json,
            'result',
            'watchers',
            0,
            'watcherId',
          );
          check(watcherId !== undefined, 'the retry reports its watcher');
          await current.host.control.completeTurn(chatId);
          checkEqual(
            (await current.host.control.firedWatchers()).slice(
              firedBefore.length,
            ),
            [watcherId],
            'watchers fired for the started chat',
          );
          checkEqual(
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ),
            [],
            'active watchers after the retry',
          );
        },
      );

      t.it('validates chat-completion watcher targets', async () => {
        const current = await session();
        const capabilities = current.host.capabilities;
        if (!capabilities.watcherTriggers.includes('worktree_chat_completion'))
          return;
        const setup = async (
          target: Record<string, string>,
          armForNextCompletion?: boolean,
        ): Promise<unknown> =>
          parseJson(
            (
              await current.execute('setup_watchers', {
                watchers: [
                  {
                    trigger: 'worktree_chat_completion',
                    target,
                    ...(armForNextCompletion ? { armForNextCompletion } : {}),
                  },
                ],
              })
            ).text,
          );
        const local = {
          projectId: world.current.workspaceId,
          worktreeId: world.current.worktreeId,
        };
        checkSubset(
          await setup({ ...local, chatId: world.current.chatId }),
          { watchers: [{ ok: false, error: { code: 'invalid_target' } }] },
          'SetupWatchers on the calling chat',
        );
        checkSubset(
          await setup({ ...local, chatId: 'c2' }),
          { watchers: [{ ok: false, error: { code: 'invalid_target' } }] },
          'SetupWatchers on an idle chat without armForNextCompletion',
        );
        if (capabilities.watcherTargetScope === 'current_workspace') {
          checkSubset(
            await setup({
              projectId: world.foreign.workspaceId,
              worktreeId: world.foreign.worktreeId,
              chatId: world.foreign.chatId,
            }),
            {
              watchers: [
                {
                  ok: false,
                  error: {
                    code: 'invalid_target',
                    message:
                      'Watchers here may only target chats in the current project.',
                  },
                },
              ],
            },
            'SetupWatchers outside the project',
          );
        }
        const armed = await setup({ ...local, chatId: 'c2' }, true);
        checkSubset(armed, { watchers: [{ ok: true }] }, 'SetupWatchers armed');
        const watcherId = stringAt(armed, 'watchers', 0, 'result', 'watcherId');
        check(watcherId !== undefined, 'SetupWatchers returns a watcher id');
        if (watcherId === undefined) return;
        checkSubset(
          parseJson(
            (
              await current.execute('delete_watchers', {
                watcherIds: [watcherId],
              })
            ).text,
          ),
          { results: [{ watcherId, status: 'deleted' }] },
          'DeleteWatchers deletes an owned watcher',
        );
        checkSubset(
          parseJson(
            (
              await current.execute('delete_watchers', {
                watcherIds: [watcherId],
              })
            ).text,
          ),
          { results: [{ watcherId, status: 'not_found' }] },
          'DeleteWatchers reports a deleted watcher as not_found',
        );
      });

      t.it(
        'arms project chat-completion watchers on the owner’s project chats',
        async () => {
          const current = await session();
          const { capabilities, control } = current.host;
          if (
            !capabilities.watcherTriggers.includes(
              'project_task_chat_completion',
            ) ||
            control.startProjectChat === undefined
          )
            return;
          const setup = async (
            target: Record<string, string>,
            entry: Record<string, unknown> = {},
          ): Promise<unknown> =>
            parseJson(
              (
                await current.execute('setup_watchers', {
                  watchers: [
                    {
                      trigger: 'project_task_chat_completion',
                      target,
                      ...entry,
                    },
                  ],
                })
              ).text,
            );
          const project = world.current.workspaceId;
          const task = world.current.worktreeId;
          checkSubset(
            await setup({
              projectId: project,
              taskId: task,
              chatId: world.current.chatId,
            }),
            {
              watchers: [
                {
                  ok: false,
                  error: {
                    code: 'invalid_target',
                    message: 'A chat cannot watch itself.',
                  },
                },
              ],
            },
            'a project watcher on the calling chat',
          );
          const foreign = await setup({
            projectId: world.foreign.workspaceId,
            taskId: world.foreign.worktreeId,
            chatId: world.foreign.chatId,
          });
          const missing = await setup({
            projectId: 'conformance-missing-project',
            taskId: task,
            chatId: 'c2',
          });
          checkSubset(
            foreign,
            { watchers: [{ ok: false, error: { code: 'not_found' } }] },
            'a project watcher on another owner’s project',
          );
          checkEqual(
            at(foreign, 'watchers', 0, 'error'),
            at(missing, 'watchers', 0, 'error'),
            'another owner’s project answers as a missing one',
          );
          checkSubset(
            await setup({ projectId: project, taskId: task, chatId: 'c2' }),
            { watchers: [{ ok: false, error: { code: 'invalid_target' } }] },
            'a project watcher on an idle chat without armForNextCompletion',
          );
          const armed = await setup(
            { projectId: project, taskId: task, chatId: 'c2' },
            { armForNextCompletion: true, label: 'Idle chat finished' },
          );
          const watcherId = stringAt(
            armed,
            'watchers',
            0,
            'result',
            'watcherId',
          );
          check(watcherId !== undefined, 'a project watcher is armed');
          if (watcherId === undefined) return;
          const listed = parseJson(
            (
              await current.execute('search_watchers', {
                targetChatId: 'c2',
              })
            ).text,
          );
          checkSubset(
            listed,
            {
              activeWatchers: [
                {
                  watcherId,
                  trigger: 'project_task_chat_completion',
                  target: { projectId: project, taskId: task, chatId: 'c2' },
                  label: 'Idle chat finished',
                },
              ],
              activeReturned: 1,
              activeTotalMatches: 1,
            },
            'SearchWatchers lists the project watcher by its canonical target',
          );
          checkEqual(
            stringAt(
              await setup(
                { projectId: project, taskId: task, chatId: 'c2' },
                { armForNextCompletion: true, label: 'Idle chat finished' },
              ),
              'watchers',
              0,
              'result',
              'watcherId',
            ),
            watcherId,
            'an identical project watcher is deduped',
          );
          await current.dispatch({
            type: 'chat.send_message',
            chatId: 'c2',
            message: 'Run the checks again.',
          });
          checkEqual(
            await control.completeTurn('c2'),
            [watcherId],
            'the project watcher fires when the chat’s turn ends',
          );
          checkEqual(
            await control.completeTurn('c2'),
            [],
            'a project watcher fires once',
          );
        },
      );

      t.it(
        'fires a new-chat watcher once, on another chat starting in its scope',
        async () => {
          const current = await session();
          const { capabilities, control } = current.host;
          if (
            !capabilities.watcherTriggers.includes(
              'project_new_chat_started',
            ) ||
            control.startProjectChat === undefined
          )
            return;
          const start = (
            taskId: string | null,
          ): ReturnType<
            NonNullable<AgentConformanceWorldControl['startProjectChat']>
          > =>
            control.startProjectChat?.(taskId) ??
            Promise.reject(new Error('startProjectChat is not available.'));
          const setup = async (
            target: Record<string, string>,
          ): Promise<unknown> =>
            parseJson(
              (
                await current.execute('setup_watchers', {
                  watchers: [{ trigger: 'project_new_chat_started', target }],
                })
              ).text,
            );
          checkSubset(
            await setup({ projectId: world.foreign.workspaceId }),
            { watchers: [{ ok: false, error: { code: 'not_found' } }] },
            'a new-chat watcher on another owner’s project',
          );
          const project = world.current.workspaceId;
          const inTask = stringAt(
            await setup({ projectId: project, taskId: 't2' }),
            'watchers',
            0,
            'result',
            'watcherId',
          );
          const anywhere = stringAt(
            await setup({ projectId: project }),
            'watchers',
            0,
            'result',
            'watcherId',
          );
          check(
            inTask !== undefined && anywhere !== undefined,
            'new-chat watchers are armed',
          );
          if (inTask === undefined || anywhere === undefined) return;
          checkSubset(
            parseJson(
              (
                await current.execute('search_watchers', {
                  targetProjectId: project,
                  activePageSize: 1,
                })
              ).text,
            ),
            {
              activeWatchers: [
                {
                  watcherId: inTask,
                  trigger: 'project_new_chat_started',
                  target: { projectId: project, taskId: 't2' },
                },
              ],
              activeReturned: 1,
              activeTotalMatches: 2,
            },
            'SearchWatchers pages new-chat watchers by their project',
          );
          checkEqual(
            (await start(null)).firedWatchers,
            [anywhere],
            'a chat starting elsewhere in the project fires the project watcher',
          );
          checkEqual(
            (await start('t2')).firedWatchers,
            [inTask],
            'a chat starting in the task fires the task watcher',
          );
          checkEqual(
            (await start('t2')).firedWatchers,
            [],
            'a new-chat watcher fires once',
          );
        },
      );

      t.it(
        'schedules a wakeup that arrives once when due, deduped while pending',
        async () => {
          const current = await session();
          const { capabilities, control } = current.host;
          if (
            !expectedToolKeys(capabilities).includes('schedule_wakeup') ||
            control.fireDueWakeups === undefined
          )
            return;
          const fireDue = (): Promise<readonly string[]> =>
            control.fireDueWakeups?.() ??
            Promise.reject(new Error('fireDueWakeups is not available.'));
          // Each call is its own tool call in its own turn, so the turns'
          // limits never refuse one; a retry reuses its call's ids.
          let calls = 0;
          const schedule = async (
            args: Record<string, unknown>,
            id = `wakeup-${String((calls += 1))}`,
          ): Promise<AgentActionToolResult> =>
            current.execute('schedule_wakeup', args, {
              toolUseId: `${id}-tool`,
              turnKey: `${id}-turn`,
            });
          for (const delaySeconds of [59, 3601, 90.5]) {
            check(
              (await schedule({ delaySeconds })).isError === true,
              `ScheduleWakeup refuses delaySeconds ${String(delaySeconds)}`,
            );
          }
          check(
            (await schedule({ delaySeconds: 60, projectId: 'p' })).isError ===
              true,
            'ScheduleWakeup refuses fields it does not define',
          );
          const first = parseJson(
            (
              await schedule(
                { delaySeconds: 120, followUpInstruction: 'Check the build.' },
                'wakeup-first',
              )
            ).text,
          );
          const watcherId = stringAt(first, 'result', 'watcherId');
          const scheduledFor = stringAt(
            first,
            'result',
            'target',
            'scheduledFor',
          );
          check(
            watcherId !== undefined && scheduledFor !== undefined,
            'ScheduleWakeup arms a wakeup with its due time',
          );
          if (watcherId === undefined || scheduledFor === undefined) return;
          checkSubset(
            first,
            {
              ok: true,
              result: {
                trigger: 'scheduled_wakeup',
                target: { delaySeconds: 120 },
                deduped: false,
              },
            },
            'the armed wakeup',
          );
          const replay = await schedule(
            { delaySeconds: 120, followUpInstruction: 'Check the build.' },
            'wakeup-first',
          );
          checkEqual(
            parseJson(replay.text),
            first,
            'a retried ScheduleWakeup call replays its result',
          );
          await control.advanceClock(30_000);
          checkSubset(
            parseJson(
              (
                await schedule({
                  delaySeconds: 120,
                  followUpInstruction: 'Check the build.',
                })
              ).text,
            ),
            {
              ok: true,
              result: { watcherId, target: { scheduledFor }, deduped: true },
            },
            'the same delay and instruction while pending returns the pending wakeup',
          );
          const other = stringAt(
            parseJson((await schedule({ delaySeconds: 120 })).text),
            'result',
            'watcherId',
          );
          const cancelled = stringAt(
            parseJson((await schedule({ delaySeconds: 600 })).text),
            'result',
            'watcherId',
          );
          check(
            other !== undefined &&
              other !== watcherId &&
              cancelled !== undefined &&
              cancelled !== other,
            'another instruction or delay arms its own wakeup',
          );
          if (other === undefined || cancelled === undefined) return;
          checkSubset(
            parseJson(
              (
                await current.execute('search_watchers', {
                  trigger: 'scheduled_wakeup',
                })
              ).text,
            ),
            {
              activeWatchers: [
                {
                  watcherId,
                  trigger: 'scheduled_wakeup',
                  target: { delaySeconds: 120, scheduledFor },
                },
                { watcherId: other, trigger: 'scheduled_wakeup' },
                { watcherId: cancelled, trigger: 'scheduled_wakeup' },
              ],
            },
            'SearchWatchers lists the pending wakeups',
          );
          checkSubset(
            parseJson(
              (
                await current.execute('delete_watchers', {
                  watcherIds: [cancelled],
                })
              ).text,
            ),
            { results: [{ watcherId: cancelled, status: 'deleted' }] },
            'DeleteWatchers cancels a pending wakeup',
          );
          await control.advanceClock(89_000);
          checkEqual(await fireDue(), [], 'no wakeup arrives before it is due');
          await control.advanceClock(31_000);
          checkEqual(
            await fireDue(),
            [watcherId, other],
            'the due wakeups arrive, in due order',
          );
          await control.advanceClock(600_000);
          checkEqual(
            await fireDue(),
            [],
            'a wakeup arrives once, and a cancelled one never',
          );
          checkSubset(
            parseJson(
              (
                await schedule({
                  delaySeconds: 120,
                  followUpInstruction: 'Check the build.',
                })
              ).text,
            ),
            { ok: true, result: { deduped: false } },
            'a wakeup that already arrived no longer dedupes a new one',
          );
        },
      );

      t.it('saves, searches and reads memory', async () => {
        const current = await session();
        const { capabilities } = current.host;
        if (!expectedToolKeys(capabilities).includes('save_memory')) return;
        let calls = 0;
        const run = (
          key: 'save_memory' | 'search_memory' | 'read_memory',
          args: Record<string, unknown>,
          id = `memory-${String((calls += 1))}`,
        ): Promise<AgentActionToolResult> =>
          current.execute(key, args, {
            toolUseId: `${id}-tool`,
            turnKey: `${id}-turn`,
          });
        check(
          (await run('save_memory', { text: '', scope: 'user' })).isError ===
            true,
          'SaveMemory refuses empty text',
        );
        check(
          (await run('read_memory', { scope: 'user', file: '../MEMORY.md' }))
            .isError === true,
          'ReadMemory refuses a traversal file key',
        );
        const text = 'Prefers pnpm over npm in every repository.';
        const saved = await run(
          'save_memory',
          { text, scope: 'user' },
          'memory-save',
        );
        const fileKey = /^Saved user memory to (inbox\/\S+\.md)$/.exec(
          saved.text,
        )?.[1];
        check(
          saved.isError !== true && fileKey !== undefined,
          `SaveMemory saves a user note: ${saved.text}`,
        );
        if (fileKey === undefined) return;
        checkEqual(
          (await run('save_memory', { text, scope: 'user' }, 'memory-save'))
            .text,
          saved.text,
          'a retried SaveMemory call replays the note it saved',
        );
        const found = await run('search_memory', { query: 'pnpm' });
        check(
          found.isError !== true &&
            found.text.includes(`[user] ${fileKey}`) &&
            found.text.includes('Prefers pnpm'),
          `SearchMemory finds the saved note: ${found.text}`,
        );
        const missing = await run('search_memory', {
          query: 'no such memory anywhere',
        });
        check(
          missing.isError !== true && !missing.text.includes(fileKey),
          'SearchMemory finds nothing for an unknown query',
        );
        const read = await run('read_memory', { scope: 'user', file: fileKey });
        check(
          read.isError !== true && read.text.includes(text),
          'ReadMemory opens the saved note',
        );
        check(
          (
            await run('read_memory', {
              scope: 'user',
              file: 'topics/no-such-topic.md',
            })
          ).isError === true,
          'ReadMemory refuses a file it does not have',
        );
        if (capabilities.memory === 'synced_user') {
          check(
            (await run('save_memory', { text, scope: 'workspace' })).isError ===
              true,
            'SaveMemory refuses workspace scope without workspace memory',
          );
          check(
            (await run('read_memory', { scope: 'workspace', file: fileKey }))
              .isError === true,
            'ReadMemory refuses workspace scope without workspace memory',
          );
        }
      });
    });

    t.describe('overlapping calls', () => {
      const overlap = async (
        current: Session<H>,
        outcome: 'succeed' | 'fail',
        toolUseId: string,
      ): Promise<{ result: AgentActionToolResult; json: unknown }> => {
        const action = { type: 'chat.create', message: `Overlap ${outcome}` };
        const hold = current.host.control.holdNextChatStart();
        const original = current.dispatch(action, { toolUseId });
        await hold.started;
        const overlapping = await current.dispatch(action, { toolUseId });
        checkSubset(
          overlapping.json,
          {
            ok: false,
            error: { code: 'in_progress', retryable: true },
          },
          `chat.create overlapping its in-flight call (${outcome})`,
        );
        hold.finish(outcome);
        return original;
      };

      const fillTurn = async (
        current: Session<H>,
        used: number,
      ): Promise<void> => {
        const perParentTurn = perTurnCap(current.host);
        if (!current.host.capabilities.limits || perParentTurn === null) return;
        for (let index = used; index < perParentTurn; index += 1) {
          checkSubset(
            (
              await current.dispatch({
                type: 'chat.create',
                message: `Fill ${index}`,
              })
            ).json,
            { ok: true },
            `chat.create ${index + 1} in the turn after an overlap`,
          );
        }
        checkSubset(
          (await current.dispatch({ type: 'chat.create', message: 'Over' }))
            .json,
          {
            ok: false,
            result: { reason: 'per_turn', limit: perParentTurn },
          },
          'chat.create past the per-turn limit after an overlap',
        );
      };

      t.it(
        'writes once when a call overlaps the same in-flight call',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const original = await overlap(current, 'succeed', 'overlap-tool');
          checkSubset(original.json, { ok: true }, 'the in-flight chat.create');
          checkEqual(
            (
              await current.dispatch(
                { type: 'chat.create', message: 'Overlap succeed' },
                { toolUseId: 'overlap-tool' },
              )
            ).result,
            original.result,
            'chat.create retried after the overlap',
          );
          await fillTurn(current, 1);
        },
      );

      t.it(
        'counts one write when the in-flight call fails under an overlap',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const original = await overlap(current, 'fail', 'overlap-fail-tool');
          checkErrorCode(
            original,
            ['execution_failed'],
            'the failed chat.create',
          );
          checkSubset(
            (
              await current.dispatch(
                { type: 'chat.create', message: 'Overlap fail' },
                { toolUseId: 'overlap-fail-tool' },
              )
            ).json,
            { ok: true },
            'chat.create retried after the failed call',
          );
          await fillTurn(current, 1);
        },
      );
    });

    t.describe('reused keys', () => {
      t.it(
        'refuses a timed-out tool call reused for a different request',
        async () => {
          const current = await session();
          for (const write of reusableWrites(current)) {
            const toolUseId = `timed-out-reused-${write.label}`;
            const hold =
              write.label === 'chat.create'
                ? current.host.control.holdNextChatStart()
                : current.host.control.holdNextMessagePost();
            const timedOut = current.dispatch(write.action('Original.'), {
              toolUseId,
            });
            await hold.started;
            hold.finish('timeout');
            checkErrorCode(
              await timedOut,
              ['timeout'],
              `${write.label} whose outcome is unknown`,
            );
            checkEqual(
              (
                await current.dispatch(write.action('Something else.'), {
                  toolUseId,
                })
              ).json,
              {
                requestId: toolUseId,
                ok: false,
                error: {
                  code: 'idempotency_conflict',
                  message: IDEMPOTENCY_CONFLICT_MESSAGE,
                },
              },
              `${write.label} reusing its timed-out tool call for a different request`,
            );
            checkSubset(
              (
                await current.dispatch(write.action('Original.'), {
                  toolUseId,
                })
              ).json,
              { ok: true },
              `${write.label} retried with its original request`,
            );
          }
        },
      );

      t.it(
        'refuses a tool call reused for a different request instead of replaying',
        async () => {
          const current = await session();
          for (const write of reusableWrites(current)) {
            const toolUseId = `reused-${write.label}`;
            const first = await current.dispatch(write.action('Original.'), {
              toolUseId,
            });
            checkSubset(first.json, { ok: true }, `${write.label} once`);
            checkEqual(
              (
                await current.dispatch(write.action('Something else.'), {
                  toolUseId,
                })
              ).json,
              {
                requestId: toolUseId,
                ok: false,
                error: {
                  code: 'idempotency_conflict',
                  message: IDEMPOTENCY_CONFLICT_MESSAGE,
                },
              },
              `${write.label} reusing its tool call for a different request`,
            );
            checkEqual(
              (
                await current.dispatch(write.action('Original.'), {
                  toolUseId,
                })
              ).result,
              first.result,
              `${write.label} retried with its original request`,
            );
          }
        },
      );
    });

    t.describe('replay ownership', () => {
      t.it(
        'runs identical calls without tool-use ids from two chats on their own',
        async () => {
          const current = await session();
          if (!current.supports('chat.create')) return;
          const turn = current.host.capabilities.limits
            ? { turnKey: 'replay-ownership-turn' }
            : {};
          const other = world.chats.find(
            (chat) =>
              chat.chatId !== world.current.chatId && chat.state !== 'archived',
          );
          check(other !== undefined, 'the world has a second live chat');
          if (!other) return;
          const action = { type: 'chat.create', message: 'Same task.' };
          const from = (
            callingChatId?: string,
          ): Promise<{ result: AgentActionToolResult; json: unknown }> =>
            current.dispatchAs(action, {
              actorKey: 'conformance-actor',
              ...turn,
              ...(callingChatId ? { callingChatId } : {}),
            });
          const first = await from();
          const second = await from(other.chatId);
          const firstChatId = stringAt(first.json, 'result', 'chatId');
          const secondChatId = stringAt(second.json, 'result', 'chatId');
          check(
            firstChatId !== undefined,
            `chat.create from ${world.current.chatId} without ids`,
          );
          check(
            secondChatId !== undefined && secondChatId !== firstChatId,
            `chat.create from ${other.chatId} with the same payload starts its own chat`,
          );
          checkEqual(
            (await from()).result,
            first.result,
            `chat.create retried from ${world.current.chatId} without ids`,
          );
          checkEqual(
            (await from(other.chatId)).result,
            second.result,
            `chat.create retried from ${other.chatId} without ids`,
          );
        },
      );

      t.it(
        "never answers one actor's tool call with another actor's receipt",
        async () => {
          const current = await session();
          const identity = {
            toolUseId: 'shared-tool',
            turnKey: 'shared-turn',
          };
          const chatIdOf = (
            result: AgentActionToolResult,
          ): string | undefined =>
            stringAt(parseJson(result.text), 'result', 'chatId') ??
            stringAt(parseJson(result.text), 'chatId');
          const runs: {
            label: string;
            run: (actorKey: string) => Promise<AgentActionToolResult>;
          }[] = [];
          if (current.supports('chat.create')) {
            runs.push({
              label: 'chat.create',
              run: async (actorKey) =>
                (
                  await current.dispatch(
                    { type: 'chat.create', message: 'Shared work.' },
                    { ...identity, actorKey },
                  )
                ).result,
            });
          }
          if (current.host.capabilities.split.forked) {
            runs.push({
              label: 'StartForkedAgent',
              run: (actorKey) =>
                current.execute(
                  'start_forked_agent',
                  { followUpInstruction: 'Shared work.' },
                  { ...identity, actorKey },
                ),
            });
          }
          for (const { label, run } of runs) {
            const first = await run('actor-a');
            const firstChatId = chatIdOf(first);
            check(firstChatId !== undefined, `${label} by actor-a`);
            const other = await run('actor-b');
            const otherChatId = chatIdOf(other);
            check(
              otherChatId !== undefined && otherChatId !== firstChatId,
              `${label} by actor-b with actor-a's tool call starts its own chat`,
            );
            checkEqual(
              await run('actor-a'),
              first,
              `${label} retried by actor-a`,
            );
            checkEqual(
              await run('actor-b'),
              other,
              `${label} retried by actor-b`,
            );
          }
        },
      );
    });

    t.describe('capability gating', () => {
      t.it(
        'answers environment actions outside the capabilities as unsupported_action',
        async () => {
          const current = await session();
          for (const type of ENVIRONMENT_ACTION_TYPES) {
            if (current.supports(type)) continue;
            checkErrorCode(
              await current.dispatch(MINIMAL_PAYLOADS[type] ?? { type }),
              ['unsupported_action'],
              `${type} without the capability`,
            );
          }
        },
      );

      t.it('refuses split agent kinds outside the capabilities', async () => {
        const current = await session();
        const kinds = [
          ['start_forked_agent', current.host.capabilities.split.forked],
          ['start_branched_agent', current.host.capabilities.split.branched],
        ] as const;
        for (const [key, offered] of kinds) {
          if (offered) continue;
          const result = await current.execute(key, {
            followUpInstruction: 'Continue the task.',
          });
          check(
            result.isError === true && /is not available/.test(result.text),
            `${key} without the capability is not available`,
          );
        }
      });

      t.it(
        'refuses a watcher whose implied trigger is outside the capabilities',
        async () => {
          const current = await session();
          const triggers = current.host.capabilities.watcherTriggers;
          if (
            triggers.length === 0 ||
            triggers.includes('worktree_pipeline_completion')
          )
            return;
          const result = await current.execute('setup_watchers', {
            watchers: [{ target: { executionId: 'execution-1' } }],
          });
          check(
            result.isError === true &&
              result.text.includes(
                'implies the worktree_pipeline_completion trigger',
              ),
            'a pipeline-shaped target without a trigger is refused',
          );
          checkEqual(
            arrayAt(
              parseJson((await current.execute('search_watchers', {})).text),
              'activeWatchers',
            ),
            [],
            'active watchers after the refused setup',
          );
        },
      );
    });
  });
}
