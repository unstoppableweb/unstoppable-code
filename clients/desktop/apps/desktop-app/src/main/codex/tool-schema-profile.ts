import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { AiGatewayToolSchemaProfile } from '@canopy/protocol/ai-gateway-models';
import { flattenToolJsonSchema } from '@canopy/protocol/tool-schemas';

/**
 * The `flat` profile strips JSON Schema combinators and conditionals. They are
 * only ever advisory hints to the model in Canopy's injected tools — the
 * authoritative validation is the zod `safeParse` in `canopy-tools/core.ts` —
 * so stripping them is safe: a model that sends a now-unconstrained argument
 * shape still hits the same runtime validation and gets the same graceful
 * `invalidArguments` response.
 */
export function applyToolSchemaProfile(
  schema: JsonValue,
  profile: AiGatewayToolSchemaProfile,
): JsonValue {
  return profile === 'flat' ? flattenToolJsonSchema(schema) : schema;
}
