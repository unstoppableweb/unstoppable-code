/**
 * JSON Schema keywords whose values hold subschemas. Every walk that must
 * agree on what counts as a schema uses these: the Antigravity advertised
 * projection, the MCP classifier's pattern normalizer and the external tool
 * ledger's `__proto__` check. Other keywords hold instance data (`const`,
 * `enum`, `default`, `examples`) or annotations and are never walked.
 */

/**
 * Values map names to subschemas; the names are never keywords. A draft-07
 * `dependencies` value may also be a property-name array, which holds no
 * schema. `patternProperties` names are themselves patterns.
 */
export const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);

/** Values are a subschema or an array of subschemas. */
export const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
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
