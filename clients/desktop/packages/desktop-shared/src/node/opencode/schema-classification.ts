import Ajv, { type Options } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import draft7MetaSchema from 'ajv/dist/refs/json-schema-draft-07.json';
import { fullFormats } from 'ajv-formats/dist/formats';
import {
  SUBSCHEMA_KEYWORDS,
  SUBSCHEMA_MAP_KEYWORDS,
} from '../../json-schema-positions';

/**
 * - `valid` / `invalid`: the host compiled the schema and checked the input.
 * - `unsupported`: the host cannot enforce this schema (unknown dialect,
 *   uncompilable or asynchronous); the caller decides whether the upstream
 *   server may enforce it instead.
 * - `error`: evaluation itself failed; callers must refuse.
 */
export type McpSchemaInputClassification =
  | 'valid'
  | 'invalid'
  | 'unsupported'
  | 'error';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** MCP defaults to 2020-12; explicit older supported dialects keep their semantics. */
function ajvForDialect(declared: unknown): Ajv | undefined {
  const dialect =
    typeof declared === 'string' ? declared.replace(/#$/, '') : declared;
  const options: Options = {
    allErrors: false,
    strict: false,
    // Ajv logs unknown keywords in this mode but still throws for unknown formats.
    // Vendor annotations are legal JSON Schema; do not print server-supplied text.
    strictSchema: 'log',
    logger: false,
    ownProperties: true,
  };
  let ajv: Ajv | undefined;
  if (
    dialect === undefined ||
    dialect === 'https://json-schema.org/draft/2020-12/schema'
  )
    ajv = new Ajv2020(options);
  else if (dialect === 'https://json-schema.org/draft/2019-09/schema')
    ajv = new Ajv2019(options);
  else if (
    dialect === 'http://json-schema.org/draft-07/schema' ||
    dialect === 'https://json-schema.org/draft-07/schema'
  )
    ajv = new Ajv(options);
  if (!ajv) return undefined;
  if (dialect === 'https://json-schema.org/draft-07/schema')
    ajv.addMetaSchema(
      draft7MetaSchema,
      'https://json-schema.org/draft-07/schema',
    );
  for (const [name, format] of Object.entries(fullFormats))
    ajv.addFormat(name, format);
  return ajv;
}

/**
 * ASCII punctuation PCRE allows escaping but the `u` regex flag rejects as an
 * identity escape. Left out: `-` (valid escaped inside a class, a range when
 * bare), `,` (`a{2\,3}` is literal in PCRE but a quantifier unescaped), and
 * `= ! : < >`, which unescaped could form group syntax such as `(?=` or read
 * as word boundaries in some flavors; those stay unsupported.
 */
const PCRE_IDENTITY_ESCAPE = new Set('"#%&\';@_`~');
class PatternCollision extends Error {}

function defineEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Rewrites `\X` to `X` for those characters only; escape pairs are consumed in order. */
function normalizePattern(pattern: string): string {
  return pattern.replace(/\\([\s\S])/g, (escape: string, next: string) =>
    PCRE_IDENTITY_ESCAPE.has(next) ? next : escape,
  );
}

/**
 * Normalizes a `patternProperties` map: keys are patterns, values subschemas.
 * Two keys that normalize alike would silently drop one constraint, so that
 * throws `PatternCollision`.
 */
function normalizePatternKeys(
  map: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map)) {
    const key = normalizePattern(name);
    if (Object.prototype.hasOwnProperty.call(out, key))
      throw new PatternCollision();
    defineEntry(out, key, normalizeSchema(schema));
  }
  return out;
}

/** Normalizes the subschemas of a name-to-schema map; names stay as they are. */
function normalizeSchemaMap(
  map: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map))
    defineEntry(out, name, normalizeSchema(schema));
  return out;
}

function normalizeKeyword(key: string, value: unknown): unknown {
  if (key === 'pattern' && typeof value === 'string')
    return normalizePattern(value);
  if (key === 'patternProperties' && record(value))
    return normalizePatternKeys(value);
  if (SUBSCHEMA_MAP_KEYWORDS.has(key) && record(value))
    return normalizeSchemaMap(value);
  if (SUBSCHEMA_KEYWORDS.has(key))
    return Array.isArray(value)
      ? value.map(normalizeSchema)
      : normalizeSchema(value);
  // Instance data (`const`, `enum`, `default`, …) and unknown keywords.
  return value;
}

/**
 * Copies a schema with every `pattern` string and `patternProperties` key
 * normalized, walking schema positions only, as the Antigravity projection
 * does. Patterns still compile with the `u` flag, so no other escape changes
 * meaning; anything left unnormalized that fails to compile stays unsupported.
 */
function normalizeSchema(value: unknown): unknown {
  if (!record(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    defineEntry(copy, key, normalizeKeyword(key, child));
  return copy;
}

/** Runs inside the bounded validation worker; inputs are JSON text. */
export function classifyMcpSchemaInput(
  request: unknown,
): McpSchemaInputClassification {
  // The host always sends JSON text; anything else is a failed evaluation.
  if (
    !record(request) ||
    typeof request.schema !== 'string' ||
    typeof request.input !== 'string'
  )
    return 'error';
  let schema: unknown;
  let input: unknown;
  try {
    schema = JSON.parse(request.schema);
    input = JSON.parse(request.input);
  } catch {
    return 'error';
  }
  if (!record(schema) && typeof schema !== 'boolean') return 'unsupported';
  const ajv = ajvForDialect(record(schema) ? schema.$schema : undefined);
  if (!ajv) return 'unsupported';
  // PCRE-style identity escapes such as `\_` mean the literal character.
  let compiled: unknown = schema;
  try {
    if (request.lenientPatterns === true) compiled = normalizeSchema(schema);
  } catch {
    return 'unsupported';
  }
  let check: ReturnType<typeof ajv.compile>;
  try {
    if (!record(compiled) && typeof compiled !== 'boolean')
      return 'unsupported';
    check = ajv.compile(compiled);
  } catch {
    return 'unsupported';
  }
  // Async schemas and unresolved references cannot authorize a call.
  if ('$async' in check && check.$async) return 'unsupported';
  try {
    return check(input) === true ? 'valid' : 'invalid';
  } catch {
    return 'error';
  }
}
