import {
  SUBSCHEMA_KEYWORDS,
  SUBSCHEMA_MAP_KEYWORDS,
} from '@canopy/desktop-shared/json-schema-positions';
import { agyAcceptsPattern } from './re2-pattern';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';

/**
 * A pattern agy 1.5.1 would reject aborts the whole turn, even for prompts
 * that call no tool, so such patterns are omitted from what is advertised.
 */
function unsupportedPattern(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && !agyAcceptsPattern(value);
}

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface Projected {
  readonly value: JsonValue;
  readonly changed: boolean;
}

/**
 * Whether references count as changed. Once anything in a schema changed, a
 * reference may reach the changed part, so every reference counts as changed
 * and the keywords above it are relaxed. Linear, and never stricter.
 */
type ChangedRefs = boolean;

const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

function projectArray(items: JsonValue[], refs: ChangedRefs): Projected {
  const projected = items.map((item) => project(item, refs));
  return {
    value: projected.map((item) => item.value),
    changed: projected.some((item) => item.changed),
  };
}

function projectMap(
  key: string,
  map: JsonObject,
  refs: ChangedRefs,
): Projected & { readonly droppedNames: boolean } {
  let changed = false;
  let droppedNames = false;
  const out: JsonObject = {};
  for (const [name, child] of Object.entries(map)) {
    if (child === undefined) continue;
    // A patternProperties key is itself a pattern.
    if (key === 'patternProperties' && unsupportedPattern(name)) {
      changed = droppedNames = true;
      continue;
    }
    const projected = project(child, refs);
    changed ||= projected.changed;
    out[name] = projected.value;
  }
  return { value: out, changed, droppedNames };
}

/**
 * Keeps the advertised object looser than the original once something beneath
 * it changed: a keyword whose meaning inverts or narrows when a subschema
 * loosens is dropped or relaxed.
 */
function relax(
  out: JsonObject,
  changedKeys: ReadonlySet<string>,
  droppedPatternNames: boolean,
): void {
  // not(looser) is stricter than not(original).
  if (changedKeys.has('not')) delete out.not;
  // A looser branch can match where another already does; anyOf cannot fail so.
  if (changedKeys.has('oneOf')) {
    if (out.anyOf === undefined) out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  // A changed condition can select the other branch.
  if (changedKeys.has('if')) {
    delete out.if;
    delete out.then;
    delete out.else;
  }
  // A looser contains matches more items, which can exceed maxContains but
  // never falls below minContains. Removing minContains would also restore its
  // default of 1, rejecting an explicit 0 the original accepts.
  if (changedKeys.has('contains')) delete out.maxContains;
  // Names a dropped pattern allowed must not fall to a closed remainder.
  if (droppedPatternNames) delete out.additionalProperties;
  // Unevaluated keywords depend on what the changed subschemas evaluate.
  delete out.unevaluatedProperties;
  delete out.unevaluatedItems;
}

function project(schema: JsonValue, refs: ChangedRefs): Projected {
  if (Array.isArray(schema)) return projectArray(schema, refs);
  if (!isObject(schema)) return { value: schema, changed: false };
  const out: JsonObject = {};
  const changedKeys = new Set<string>();
  let droppedPatternNames = false;
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue;
    if (key === 'pattern' && unsupportedPattern(value)) {
      changedKeys.add(key);
      continue;
    }
    let projected: Projected = { value, changed: false };
    if (SUBSCHEMA_KEYWORDS.has(key)) projected = project(value, refs);
    else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
      const map = projectMap(key, value, refs);
      droppedPatternNames ||= map.droppedNames;
      projected = map;
    } else if (refs && REFERENCE_KEYWORDS.has(key))
      projected = { value, changed: true };
    if (projected.changed) changedKeys.add(key);
    out[key] = projected.value;
  }
  if (changedKeys.size === 0) return { value: schema, changed: false };
  relax(out, changedKeys, droppedPatternNames);
  return { value: out, changed: true };
}

/**
 * Omits patterns agy 1.5.1 cannot accept, as `pattern` values and as
 * `patternProperties` keys, only on the wire; the host still validates every
 * call against the original (canonical parsers for app tools, the external
 * schema ledger for selected servers). The advertised schema is always looser
 * than the original: keywords that would narrow once a subschema loosens are
 * relaxed. Walk schema positions only so property names and literal
 * defaults/examples stay intact.
 */
export function antigravityAdvertisedSchema(schema: JsonValue): JsonValue {
  const first = project(schema, false);
  return first.changed ? project(schema, true).value : schema;
}
