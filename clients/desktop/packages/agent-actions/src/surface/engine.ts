import { z } from 'zod';
import type { AgentActionBrand } from '../brand';
import { clampLimit } from '../catalog/limit';
import { hideAgentActionFields } from '../catalog/scope';
import {
  scoreAgentActionCatalogEntry,
  searchAgentActionCatalog,
  type AgentActionSearchResult,
  type AgentActionSearchResultAction,
} from '../catalog/search';
import type { AgentActionCatalogEntry } from '../catalog/types';
import {
  AGENT_ACTION_TOOL_DISPLAY_NAMES,
  AGENT_ACTION_TOOL_KEYS,
  type AgentActionToolKey,
} from '../tool-keys';
import {
  invalidAgentActionArguments,
  type AgentActionToolDefinition,
  type AgentActionToolResult,
  type AgentJsonSchema,
} from '../tools/definition';
import {
  dispatchActionDescription,
  deleteWatchersDescription,
  searchActionsDescription,
  searchWatchersDescription,
  setupWatchersDescription,
  START_BRANCHED_AGENT_DESCRIPTION,
  startForkedAgentDescription,
  type AgentActionDescriptionOffer,
} from '../tools/descriptions';
import { createDispatchActionInputSchema } from '../tools/dispatch-action';
import {
  buildSearchActionsJsonSchema,
  searchActionsInputSchema,
  type SearchActionsInput,
} from '../tools/search-actions';
import { agentActionDispatchJsonSchema } from './dispatch-schema';
import {
  START_SPLIT_AGENT_JSON_SCHEMA,
  startSplitAgentInputSchema,
  startSplitAgentJsonSchema,
  type StartSplitAgentInput,
} from '../tools/split-agent';
import {
  buildDeleteWatchersJsonSchema,
  buildSearchWatchersJsonSchema,
  buildSetupWatchersJsonSchema,
  createSearchWatchersInputSchema,
  createSetupWatchersInputSchema,
  deleteWatchersInputSchema,
  SEARCHABLE_WATCHER_TRIGGERS,
  SETUP_WATCHER_TRIGGERS,
  type DeleteWatchersInput,
  type SearchWatchersInput,
  type SetupWatchersInput,
} from '../tools/watchers';
import type { AgentActionHostCapabilities } from './capabilities';
import type {
  AgentActionCall,
  AgentActionFamily,
  AgentActionFamilyParse,
  AgentActionScopeField,
} from './family';

/** Host-side watcher operations behind the watcher tools. */
export interface AgentActionWatcherPort<H, THook extends string = string> {
  /** Hook triggers `worktree_hook_triggered` watchers may name. */
  hookTriggerNames: readonly THook[];
  search(
    input: SearchWatchersInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
  setup(
    input: SetupWatchersInput<THook>,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
  delete(
    input: DeleteWatchersInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
}

export type AgentSplitAgentKind = 'forked' | 'branched';

type SplitAgentToolKey = 'start_forked_agent' | 'start_branched_agent';

const SPLIT_AGENT_KINDS: Readonly<
  Record<SplitAgentToolKey, AgentSplitAgentKind>
> = {
  start_forked_agent: 'forked',
  start_branched_agent: 'branched',
};

/** Host-side start of an independent forked or branched agent. */
export interface AgentActionSplitPort<H> {
  start(
    kind: AgentSplitAgentKind,
    input: StartSplitAgentInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
}

export interface AgentActionSurfaceOptions<H, THook extends string> {
  brand: AgentActionBrand;
  capabilities: AgentActionHostCapabilities;
  families: readonly AgentActionFamily<H>[];
  watchers?: AgentActionWatcherPort<H, THook>;
  split?: AgentActionSplitPort<H>;
}

export interface AgentActionSurface<H> {
  toolDefinitions(): readonly AgentActionToolDefinition<AgentActionToolKey>[];
  execute(
    key: AgentActionToolKey,
    rawArgs: unknown,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult>;
}

const SCOPE_FIELDS: readonly AgentActionScopeField[] = [
  'projectId',
  'worktreeId',
];

type RoutedAction<H> =
  | { owned: true; bound: Extract<AgentActionFamilyParse<H>, { ok: true }> }
  | { owned: false; type: unknown };

function unavailable(key: AgentActionToolKey): AgentActionToolResult {
  return {
    text: `${AGENT_ACTION_TOOL_DISPLAY_NAMES[key]} is not available in this chat.`,
    isError: true,
  };
}

function unsupportedAction(
  type: string,
  availableTypes: readonly string[],
): AgentActionToolResult {
  const response = {
    requestId: '',
    ok: false,
    error: {
      code: 'unsupported_action',
      message:
        availableTypes.length > 0
          ? `${type} is not available here. Available actions: ${availableTypes.join(', ')}.`
          : `${type} is not available here.`,
    },
  };
  return { text: JSON.stringify(response, null, 2), isError: true };
}

function actionTypeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'type' in value
    ? value.type
    : undefined;
}

/**
 * Project a generic catalog search onto the surface: the runtime-supplied
 * fields are hidden from every action and each of its examples.
 */
function hideActionFields(
  result: AgentActionSearchResult,
  hiddenFields: ReadonlySet<string>,
): AgentActionSearchResult {
  return {
    ...result,
    actions: result.actions.map((action) =>
      hideAgentActionFields(action, hiddenFields),
    ),
  };
}

interface FamilySearchResult {
  result: AgentActionSearchResult;
  catalog: readonly AgentActionCatalogEntry[];
}

/**
 * Interleave several families' results by their generic score. Each family
 * keeps its own order; ties go to the earlier family.
 */
function rankAcrossFamilies(
  input: SearchActionsInput,
  results: readonly FamilySearchResult[],
  limit: number,
): AgentActionSearchResultAction[] {
  const queues = results.map(({ result, catalog }) => {
    const entries = new Map(catalog.map((entry) => [entry.type, entry]));
    return result.actions.map((action) => {
      const entry = entries.get(action.type);
      return {
        action,
        score: entry ? scoreAgentActionCatalogEntry(entry, input) : 0,
      };
    });
  });
  const positions = queues.map(() => 0);
  const ranked: AgentActionSearchResultAction[] = [];
  while (ranked.length < limit) {
    let best = -1;
    let bestScore = -Infinity;
    queues.forEach((queue, index) => {
      const head = queue[positions[index] ?? 0];
      if (head && head.score > bestScore) {
        best = index;
        bestScore = head.score;
      }
    });
    const head = best >= 0 ? queues[best]?.[positions[best] ?? 0] : undefined;
    if (!head) break;
    ranked.push(head.action);
    positions[best] = (positions[best] ?? 0) + 1;
  }
  return ranked;
}

function mergeSearchResults(
  input: SearchActionsInput,
  familyResults: readonly FamilySearchResult[],
): AgentActionSearchResult {
  const [first, ...rest] = familyResults;
  if (first && rest.length === 0) return first.result;
  const results = familyResults.map((entry) => entry.result);
  const actions = rankAcrossFamilies(
    input,
    familyResults,
    clampLimit(input.limit, 20, 50),
  );
  return {
    query: input.query ?? '',
    ...(input.category ? { category: input.category } : {}),
    ...(input.actionType ? { actionType: input.actionType } : {}),
    totalMatches: results.reduce((sum, result) => sum + result.totalMatches, 0),
    returned: actions.length,
    categories: Array.from(
      new Set(results.flatMap((result) => result.categories)),
    ),
    actions,
  };
}

/**
 * Claude Code replaces a tool result over 50,000 characters with a file path
 * and a 2 KB preview, so the agent would not see the actions it searched for.
 */
const SEARCH_RESULT_MAX_CHARS = 40_000;

/** The search result as tool text, dropping its lowest-ranked actions to fit. */
function searchResultText(result: AgentActionSearchResult): string {
  let actions = result.actions;
  for (;;) {
    const text = JSON.stringify(
      { ...result, returned: actions.length, actions },
      null,
      2,
    );
    if (text.length <= SEARCH_RESULT_MAX_CHARS || actions.length <= 1) {
      return text;
    }
    actions = actions.slice(0, -1);
  }
}

/**
 * The agent action tool surface for one host: tool definitions and the
 * execution of SearchActions, DispatchAction, the watcher tools, and the
 * split-agent tools over the host's action families and ports.
 */
export function createAgentActionSurface<H, THook extends string = string>(
  options: AgentActionSurfaceOptions<H, THook>,
): AgentActionSurface<H> {
  const { brand, capabilities, families, watchers, split } = options;
  const availableTypes = new Set(
    families.flatMap((family) => family.supportedTypes(capabilities)),
  );
  const actionTypes = capabilities.actionTypes.filter((type) =>
    availableTypes.has(type),
  );
  const searchableTriggers = SEARCHABLE_WATCHER_TRIGGERS.filter((trigger) =>
    capabilities.watcherTriggers.includes(trigger),
  );
  const setupTriggers = SETUP_WATCHER_TRIGGERS.filter((trigger) =>
    capabilities.watcherTriggers.includes(trigger),
  );
  const searchWatchersInputSchema =
    createSearchWatchersInputSchema(searchableTriggers);
  const setupWatchersInputSchema = createSetupWatchersInputSchema({
    triggers: setupTriggers,
    hookTriggerNames: watchers?.hookTriggerNames ?? [],
  });
  // Action types of explicit-target families. Types are unique across
  // families, so only the families that declare target fields are read.
  const explicitTargetTypes = new Set(
    families.flatMap((family) => (family.targetFields ? family.types : [])),
  );
  const dispatchActionInputSchema = createDispatchActionInputSchema(
    z.unknown().transform((value, context): RoutedAction<H> => {
      for (const family of families) {
        const parsed = family.parse(value);
        if (parsed === null) continue;
        if (parsed.ok) return { owned: true, bound: parsed };
        for (const message of parsed.issues) {
          context.addIssue({ code: 'custom', message });
        }
        return z.NEVER;
      }
      return { owned: false, type: actionTypeOf(value) };
    }),
    {
      keepScopeFields: (value) => {
        const type = actionTypeOf(value);
        return typeof type === 'string' && explicitTargetTypes.has(type)
          ? SCOPE_FIELDS
          : [];
      },
    },
  );

  function dispatchJsonSchema(): AgentJsonSchema {
    return agentActionDispatchJsonSchema(brand, families, actionTypes);
  }

  function descriptionOffer(): AgentActionDescriptionOffer {
    const entries = new Map(
      families.flatMap((family) =>
        family
          .catalog(brand)
          .map((entry): [string, AgentActionCatalogEntry] => [
            entry.type,
            entry,
          ]),
      ),
    );
    return {
      capabilities,
      actions: actionTypes.flatMap((type) => {
        const entry = entries.get(type);
        return entry ? [entry] : [];
      }),
    };
  }

  function offersSplitAgent(key: SplitAgentToolKey): boolean {
    return split !== undefined && capabilities.split[SPLIT_AGENT_KINDS[key]];
  }

  function definitionFor(
    key: AgentActionToolKey,
  ): AgentActionToolDefinition<AgentActionToolKey> | null {
    const name = AGENT_ACTION_TOOL_DISPLAY_NAMES[key];
    const actionsOffered = families.length > 0 && actionTypes.length > 0;
    switch (key) {
      case 'search_actions':
        return actionsOffered
          ? {
              key,
              name,
              description: searchActionsDescription(brand, descriptionOffer()),
              inputSchema: buildSearchActionsJsonSchema(descriptionOffer()),
            }
          : null;
      case 'dispatch_action':
        return actionsOffered
          ? {
              key,
              name,
              description: dispatchActionDescription(brand, descriptionOffer()),
              inputSchema: dispatchJsonSchema(),
            }
          : null;
      case 'search_watchers':
        return watchers
          ? {
              key,
              name,
              description: searchWatchersDescription(brand, capabilities),
              inputSchema: buildSearchWatchersJsonSchema(
                searchableTriggers,
                capabilities,
              ),
            }
          : null;
      case 'setup_watchers':
        return watchers
          ? {
              key,
              name,
              description: setupWatchersDescription(brand, capabilities),
              inputSchema: buildSetupWatchersJsonSchema(
                brand,
                setupTriggers,
                capabilities,
              ),
            }
          : null;
      case 'delete_watchers':
        return watchers
          ? {
              key,
              name,
              description: deleteWatchersDescription(brand, capabilities),
              inputSchema: buildDeleteWatchersJsonSchema(capabilities),
            }
          : null;
      case 'start_forked_agent':
        return offersSplitAgent(key)
          ? {
              key,
              name,
              description: startForkedAgentDescription(capabilities),
              inputSchema: startSplitAgentJsonSchema(capabilities),
            }
          : null;
      case 'start_branched_agent':
        return offersSplitAgent(key)
          ? {
              key,
              name,
              description: START_BRANCHED_AGENT_DESCRIPTION,
              inputSchema: START_SPLIT_AGENT_JSON_SCHEMA,
            }
          : null;
    }
  }

  function searchActions(
    rawArgs: unknown,
    call: AgentActionCall<H>,
  ): AgentActionToolResult {
    const parsed = searchActionsInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return invalidAgentActionArguments(
        AGENT_ACTION_TOOL_DISPLAY_NAMES.search_actions,
      );
    }
    const input = parsed.data;
    const hidden = new Set(capabilities.searchHiddenActionTypes ?? []);
    const searchable = (type: string): boolean =>
      !hidden.has(type) || input.actionType === type;
    // A family that offers no action here contributes no category either.
    const offering = families.filter(
      (family) =>
        family.search !== undefined ||
        family
          .supportedTypes(capabilities)
          .some((type) => actionTypes.includes(type)),
    );
    const results = offering.map((family): FamilySearchResult => {
      const catalog = family.catalog(brand);
      if (family.search) {
        return { result: family.search(input, call, capabilities), catalog };
      }
      const familyTypes = new Set(family.supportedTypes(capabilities));
      return {
        result: hideActionFields(
          searchAgentActionCatalog(catalog, {
            ...input,
            allowedActionTypes: actionTypes.filter(
              (type) => familyTypes.has(type) && searchable(type),
            ),
          }),
          new Set([
            ...SCOPE_FIELDS.filter(
              (field) => !family.targetFields?.includes(field),
            ),
            ...(family.hiddenFields ?? []),
          ]),
        ),
        catalog,
      };
    });
    return { text: searchResultText(mergeSearchResults(input, results)) };
  }

  async function dispatchAction(
    rawArgs: unknown,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult> {
    const parsed = dispatchActionInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return invalidAgentActionArguments(
        AGENT_ACTION_TOOL_DISPLAY_NAMES.dispatch_action,
        parsed.error.issues.map((issue) => issue.message),
      );
    }
    const routed = parsed.data.action;
    if (!routed.owned) {
      return typeof routed.type === 'string'
        ? unsupportedAction(routed.type, actionTypes)
        : invalidAgentActionArguments(
            AGENT_ACTION_TOOL_DISPLAY_NAMES.dispatch_action,
            ['action.type must be a string.'],
          );
    }
    const { bound } = routed;
    if (!actionTypes.includes(bound.action.type)) {
      return unsupportedAction(bound.action.type, actionTypes);
    }
    const output = await bound.dispatch(call);
    if ('text' in output) return output;
    const { toolImageDataUrl, ...textResponse } = output;
    return {
      text: JSON.stringify(textResponse, null, 2),
      isError: output.ok !== true,
      ...(toolImageDataUrl ? { imageDataUrl: toolImageDataUrl } : {}),
    };
  }

  async function startSplitAgent(
    key: SplitAgentToolKey,
    rawArgs: unknown,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult> {
    if (!split || !offersSplitAgent(key)) return unavailable(key);
    const parsed = startSplitAgentInputSchema.safeParse(rawArgs);
    if (!parsed.success) return invalidAgentActionArguments(key);
    return split.start(SPLIT_AGENT_KINDS[key], parsed.data, call);
  }

  return {
    toolDefinitions: () =>
      AGENT_ACTION_TOOL_KEYS.flatMap(
        (key): AgentActionToolDefinition<AgentActionToolKey>[] => {
          const definition = definitionFor(key);
          return definition ? [definition] : [];
        },
      ),
    execute: async (key, rawArgs, call): Promise<AgentActionToolResult> => {
      switch (key) {
        case 'search_actions':
          return searchActions(rawArgs, call);
        case 'dispatch_action':
          return dispatchAction(rawArgs, call);
        case 'search_watchers': {
          const parsed = searchWatchersInputSchema.safeParse(rawArgs);
          if (!parsed.success) {
            return invalidAgentActionArguments(
              AGENT_ACTION_TOOL_DISPLAY_NAMES.search_watchers,
            );
          }
          return watchers
            ? watchers.search(parsed.data, call)
            : unavailable(key);
        }
        case 'setup_watchers': {
          const parsed = setupWatchersInputSchema.safeParse(rawArgs);
          if (!parsed.success) {
            return invalidAgentActionArguments(
              AGENT_ACTION_TOOL_DISPLAY_NAMES.setup_watchers,
              parsed.error.issues
                .filter((issue) => issue.code === 'custom')
                .map((issue) => issue.message),
            );
          }
          return watchers
            ? watchers.setup(parsed.data, call)
            : unavailable(key);
        }
        case 'delete_watchers': {
          const parsed = deleteWatchersInputSchema.safeParse(rawArgs);
          if (!parsed.success) {
            return invalidAgentActionArguments(
              AGENT_ACTION_TOOL_DISPLAY_NAMES.delete_watchers,
            );
          }
          return watchers
            ? watchers.delete(parsed.data, call)
            : unavailable(key);
        }
        case 'start_forked_agent':
        case 'start_branched_agent':
          return startSplitAgent(key, rawArgs, call);
      }
    },
  };
}
