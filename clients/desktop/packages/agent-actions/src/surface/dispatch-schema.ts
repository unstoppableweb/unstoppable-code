import type { AgentActionBrand } from '../brand';
import type { AgentJsonSchema } from '../tools/definition';
import { composeDispatchActionJsonSchema } from '../tools/dispatch-action';
import type { AgentActionHostCapabilities } from './capabilities';
import type { AgentActionFamilyJsonSchemaSource } from './family';

/** The parts of an action family that shape the advertised DispatchAction. */
export interface AgentActionFamilyDispatchSchema {
  readonly types: readonly string[];
  /** Pins the advertised DispatchAction type enum order. */
  readonly jsonEnumOrder?: readonly string[];
  readonly dispatchJsonSchema?: AgentActionFamilyJsonSchemaSource;
  readonly targetFields?: readonly string[];
}

/**
 * The DispatchAction input schema of a host's families, offering only
 * `actionTypes`: the type enum in family order, each family's payload
 * properties reconciled by {@link composeDispatchActionJsonSchema}, and their
 * conditionals. The surface engine advertises exactly this,
 * so a host that also needs the schema statically calls it with the same
 * families instead of composing its own.
 */
export function agentActionDispatchJsonSchema(
  brand: AgentActionBrand,
  families: readonly AgentActionFamilyDispatchSchema[],
  actionTypes: readonly string[],
  capabilities?: AgentActionHostCapabilities,
): AgentJsonSchema {
  return composeDispatchActionJsonSchema(
    brand,
    families.map((family) => {
      const schema =
        typeof family.dispatchJsonSchema === 'function'
          ? family.dispatchJsonSchema(capabilities)
          : family.dispatchJsonSchema;
      return {
        actionTypes: (family.jsonEnumOrder ?? family.types).filter((type) =>
          actionTypes.includes(type),
        ),
        ...(schema?.properties ? { properties: schema.properties } : {}),
        ...(schema?.allOf ? { allOf: schema.allOf } : {}),
        ...(family.targetFields ? { targetFields: family.targetFields } : {}),
      };
    }),
  );
}
