import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';

const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const schemaChildren = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/**
 * agy 1.5.1 rejects negative lookahead in advertised string patterns, aborting
 * even prompts that do not call a tool. Omit that constraint only on the wire;
 * canonical tool parsers still validate every call on the host. Walk schema
 * positions only so property names and literal defaults/examples stay intact.
 */
export function antigravityAdvertisedSchema(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) return schema.map(antigravityAdvertisedSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) =>
          !(
            key === 'pattern' &&
            typeof value === 'string' &&
            value.includes('(?!')
          ),
      )
      .map(([key, value]) => [
        key,
        value === undefined ? value : projectSchemaChild(key, value),
      ]),
  );
}

function projectSchemaChild(key: string, value: JsonValue): JsonValue {
  if (schemaChildren.has(key)) return antigravityAdvertisedSchema(value);
  if (
    schemaMaps.has(key) &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        child === undefined ? child : antigravityAdvertisedSchema(child),
      ]),
    );
  }
  return value;
}
