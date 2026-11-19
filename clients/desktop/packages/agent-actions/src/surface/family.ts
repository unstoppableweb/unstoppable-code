import type { z } from 'zod';
import type { AgentActionBrand } from '../brand';
import type { AgentActionCatalogEntry } from '../catalog/types';
import type { AgentActionSearchResult } from '../catalog/search';
import type { AgentActionResponse, AgentJson } from '../response';
import type {
  AgentActionToolResult,
  AgentJsonSchema,
} from '../tools/definition';
import {
  findUiOnlyActionField,
  uiOnlyActionFieldMessage,
} from '../tools/dispatch-action';
import type { SearchActionsInput } from '../tools/search-actions';
import type { AgentActionHostCapabilities } from './capabilities';

export interface AgentActionPayload {
  type: string;
}

/** The caller scope fields the dispatch envelope strips from actions. */
export type AgentActionScopeField = 'projectId' | 'worktreeId';

export interface AgentActionCallScope {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
}

/** One tool call: the trusted caller identity plus the host's own context. */
export interface AgentActionCall<H> {
  scope?: AgentActionCallScope;
  turnKey?: string;
  actorKey?: string;
  toolUseId?: string;
  signal?: AbortSignal;
  /** The host's report of an unexpected (untyped) action failure; never given the error text. */
  reportUnexpectedError?: (error: unknown) => void;
  host: H;
}

/**
 * A dispatched action's outcome: a response the engine serializes, or a
 * finished tool result for outcomes that are not a single action response.
 */
export type AgentActionDispatchOutput =
  | AgentActionResponse<string>
  | AgentActionToolResult;

/** Advertised DispatchAction payload properties for a family's actions. */
export interface AgentActionFamilyJsonSchema {
  properties: AgentJsonSchema;
  allOf?: readonly AgentJson[];
}

/** A static schema or one projected from the host's capabilities. */
export type AgentActionFamilyJsonSchemaSource =
  | AgentActionFamilyJsonSchema
  | ((
      capabilities?: AgentActionHostCapabilities,
    ) => AgentActionFamilyJsonSchema);

interface AgentActionFamilyBase<H> {
  readonly id: string;
  /** Every action type the family defines, independent of capabilities. */
  readonly types: readonly string[];
  catalog(
    brand: AgentActionBrand,
    capabilities?: AgentActionHostCapabilities,
  ): readonly AgentActionCatalogEntry[];
  /** The action types the family offers under these capabilities. */
  supportedTypes(capabilities: AgentActionHostCapabilities): readonly string[];
  /** Replaces the generic catalog search for this family. */
  search?: (
    input: SearchActionsInput,
    call: AgentActionCall<H>,
    capabilities: AgentActionHostCapabilities,
  ) => AgentActionSearchResult;
  /** Action fields the trusted runtime supplies; search hides them. */
  readonly hiddenFields?: readonly string[];
  /**
   * Scope-named fields this family's actions take as explicit targets; search
   * shows them. Declaring it, even empty, makes the family explicit-target:
   * the dispatch envelope strips no scope field from its actions, so their
   * strict schemas reject the ones they do not take.
   */
  readonly targetFields?: readonly AgentActionScopeField[];
  /** Pins the advertised DispatchAction type enum order. */
  readonly jsonEnumOrder?: readonly string[];
  readonly dispatchJsonSchema?: AgentActionFamilyJsonSchemaSource;
}

export interface AgentActionFamilyDefinition<
  H,
  A extends AgentActionPayload,
> extends AgentActionFamilyBase<H> {
  /**
   * Whether this family parses an action with this `type`. Defaults to
   * membership in `types`; the first family that owns an action parses it.
   */
  ownsType?: (type: unknown) => boolean;
  actionSchema: z.ZodType<A>;
  /** Replaces the generic top-level UI-only field check. */
  findUiOnlyField?: (action: Record<string, unknown>) => string | null;
  dispatch(
    action: A,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
}

export type AgentActionFamilyParse<H> =
  | {
      ok: true;
      action: AgentActionPayload;
      dispatch(call: AgentActionCall<H>): Promise<AgentActionDispatchOutput>;
    }
  | { ok: false; issues: string[] };

/** A family with its action type erased, ready to plug into a surface. */
export interface AgentActionFamily<H> extends AgentActionFamilyBase<H> {
  /** Null when the family does not own the action. */
  parse(raw: unknown): AgentActionFamilyParse<H> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defineAgentActionFamily<H, A extends AgentActionPayload>(
  definition: AgentActionFamilyDefinition<H, A>,
): AgentActionFamily<H> {
  const ownsType =
    definition.ownsType ??
    ((type: unknown): boolean =>
      typeof type === 'string' && definition.types.includes(type));
  const findUiOnlyField =
    definition.findUiOnlyField ??
    ((action: Record<string, unknown>): string | null =>
      findUiOnlyActionField(action));
  return {
    id: definition.id,
    types: definition.types,
    catalog: (brand, capabilities) => definition.catalog(brand, capabilities),
    supportedTypes: (capabilities) => definition.supportedTypes(capabilities),
    ...(definition.search ? { search: definition.search } : {}),
    ...(definition.hiddenFields
      ? { hiddenFields: definition.hiddenFields }
      : {}),
    ...(definition.targetFields
      ? { targetFields: definition.targetFields }
      : {}),
    ...(definition.jsonEnumOrder
      ? { jsonEnumOrder: definition.jsonEnumOrder }
      : {}),
    ...(definition.dispatchJsonSchema
      ? { dispatchJsonSchema: definition.dispatchJsonSchema }
      : {}),
    parse: (raw): AgentActionFamilyParse<H> | null => {
      if (!ownsType(isRecord(raw) ? raw.type : undefined)) return null;
      const field = isRecord(raw) ? findUiOnlyField(raw) : null;
      if (field)
        return { ok: false, issues: [uiOnlyActionFieldMessage(field)] };
      const parsed = definition.actionSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          // A bare union or refinement failure names no field; add its path.
          issues: parsed.error.issues.map((issue) =>
            issue.message === 'Invalid input' && issue.path.length > 0
              ? `${issue.path.join('.')}: Invalid input`
              : issue.message,
          ),
        };
      }
      const action = parsed.data;
      return {
        ok: true,
        action,
        dispatch: (call) => definition.dispatch(action, call),
      };
    },
  };
}
