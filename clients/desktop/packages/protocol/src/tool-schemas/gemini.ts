import type { JsonSchemaValue, StrictToolSchemaOptions } from './index';
import {
  CHARS_PER_WORK_UNIT,
  copyCost,
  jsonWorkUnits,
  MAX_TOOL_SCHEMA_DEPTH,
  measureJson,
  toolSchemaWorkLimit,
} from './work-budget';

/**
 * Gemini function-declaration projection. Vertex AI and the Gemini API accept
 * a subset of JSON Schema for tool parameters. Outside `allOf` members they
 * reject:
 *
 * - a union (`anyOf`/`oneOf`) beside any other keyword;
 * - object keywords (`properties`, `required`, …) on a schema not typed
 *   `object`, and `required` naming a property the schema does not declare;
 * - an array with `prefixItems` but no `items`;
 * - a root schema that is not typed `object` (Vertex AI only);
 * - a union with a bare `{ type: 'null' }` branch beside a branch without a
 *   top-level `type` (Vertex AI only: it reads such a union as a nullable
 *   schema that must carry a type);
 * - any `$ref` key in a tool that reaches the model as a function response,
 *   which is how both send the tools of a `tool_search_output` item.
 *
 * Both accept `allOf`, nested in union branches and with `$ref` members, and
 * check none of these rules inside an `allOf` member. Every rewrite below is
 * therefore a conjunction: keywords move into `allOf` members and are never
 * merged with each other, so the result accepts exactly the instances the
 * input accepts. An `unevaluatedProperties` or `unevaluatedItems` keyword
 * only sees what keywords in its own schema evaluated, so it moves together
 * with them. There are two exceptions. Typing an untyped root as an object
 * only changes the verdict for arguments that are not objects. Retyping an
 * `enum` or `const` whose `type` rejects every value (`enumTypedByValues`)
 * accepts those values, where the input accepted none of them.
 *
 * The rewrites model one schema resource addressed by JSON pointers. A schema
 * using anything else is forwarded unchanged, because moving or inlining its
 * subschemas would change what its references resolve to:
 *
 * - `$id` anywhere but the root, which starts a nested resource;
 * - `$anchor`, `$dynamicAnchor`, `$dynamicRef`, `$recursiveAnchor` and
 *   `$recursiveRef`;
 * - a `$ref` that is not `#` or a JSON pointer (`#/…`) to a subschema
 *   position, including remote, relative, anchor and percent-encoded refs;
 * - draft-07 `dependencies` with a schema value, which no rewrite visits.
 */

type JsonSchemaObject = { [key in string]?: JsonSchemaValue };

const UNION_KEYWORDS = ['anyOf', 'oneOf'] as const;

/** Kept where they are: definitions must stay resolvable from the root. */
const DEFINITION_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  '$schema',
  '$id',
]);

/** Keywords that constrain only object instances. */
const OBJECT_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'required',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'dependentSchemas',
]);

/**
 * Keywords outside `OBJECT_KEYWORDS` whose evaluated properties an
 * `unevaluatedProperties` beside them sees.
 */
const PROPERTY_ANNOTATING_APPLICATORS = [
  'allOf',
  '$ref',
  '$dynamicRef',
  'if',
  'then',
  'else',
] as const;

const UNEVALUATED_KEYWORDS = [
  'unevaluatedProperties',
  'unevaluatedItems',
] as const;

const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

const SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);

const SINGLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
]);

/** Keywords outside the modeled subset wherever a schema declares them. */
const UNSUPPORTED_KEYWORDS = [
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
] as const;

const MAX_DEPTH = 64;

/**
 * Work allowed for one conversion: a fixed base plus a multiple of the input's
 * size in work units (`jsonWorkUnits`: a unit per JSON node and per 64
 * characters of strings and keys), capped by `MAX_TOOL_SCHEMA_WORK` and by the
 * request's shared budget. Measuring the input spends its size; visiting a
 * schema node spends one unit plus one per keyword; resolving a `$ref` spends
 * its length and segments; a report spends its path's length; and every copy
 * of a subschema (an inlined or moved `$ref` target) spends its own size
 * first. Each pass does constant work per unit it spends, so both the time
 * and the output size of a conversion are linear in its budget.
 */
const WORK_BUDGET_BASE = 20_000;
const WORK_PER_INPUT_UNIT = 8;

/** Lossy changes reported one by one; the rest are reported as a count. */
const MAX_LOSSY_REPORTS = 20;

export interface GeminiToolSchemaOptions extends StrictToolSchemaOptions {
  /**
   * Inline every local `$ref`, for a tool sent to the model as a function
   * response (the tools of a `tool_search_output` item), where Gemini reads a
   * `$ref` key as a reference to a response part.
   */
  inlineRefs?: boolean;
}

/** A JSON pointer built one key at a time and formatted only when reported. */
interface SchemaPath {
  readonly parent: SchemaPath | undefined;
  readonly key: string;
}

interface GeminiContext {
  /** Lossy changes, reported only if the whole conversion succeeds. */
  reports: [string, string][];
  unreported: number;
  remaining: number;
  /**
   * Whether the input has an `unevaluatedItems` keyword, which would see an
   * `items` schema the conversion adds to a tuple.
   */
  unevaluatedItems: boolean;
  /** The input node each output node was converted from, for the root's pass. */
  sources: Map<object, JsonSchemaObject> | undefined;
  /** Output nodes that carry a `$ref`. */
  refNodes: JsonSchemaObject[];
}

/** Ends a conversion that would recurse or grow without bound. */
class GeminiConversionAborted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'GeminiConversionAborted';
  }
}

function spend(context: GeminiContext, units = 1): void {
  context.remaining -= units;
  if (context.remaining < 0) {
    throw new GeminiConversionAborted('work budget exceeded');
  }
}

/** Charge for emitting a copy of a value, including its string and key lengths. */
function spendCopy(context: GeminiContext, value: JsonSchemaValue): void {
  spend(context, copyCost(value, context.remaining + 1));
}

function isJsonObject(value: JsonSchemaValue): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Assign without triggering the `__proto__` setter for user-named keys. */
function setOwn(
  target: JsonSchemaObject,
  key: string,
  value: JsonSchemaValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function definedEntries(node: JsonSchemaObject): [string, JsonSchemaValue][] {
  const entries: [string, JsonSchemaValue][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (value !== undefined) entries.push([key, value]);
  }
  return entries;
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPath(parent: SchemaPath | undefined, key: string): SchemaPath {
  return { parent, key };
}

/** Format a path as a JSON pointer, after paying for its length. */
function formatPath(
  path: SchemaPath | undefined,
  context: GeminiContext,
): string {
  let segments = 0;
  let chars = 1;
  for (let at = path; at !== undefined; at = at.parent) {
    segments += 1;
    chars += at.key.length + 1;
  }
  spend(context, segments + Math.ceil(chars / CHARS_PER_WORK_UNIT));
  const keys: string[] = [];
  for (let at = path; at !== undefined; at = at.parent) {
    keys.push(escapeSegment(at.key));
  }
  return ['#', ...keys.reverse()].join('/');
}

function reportLossy(
  context: GeminiContext,
  path: SchemaPath | undefined,
  reason: string,
): void {
  if (context.reports.length >= MAX_LOSSY_REPORTS) {
    spend(context);
    context.unreported += 1;
    return;
  }
  context.reports.push([formatPath(path, context), reason]);
}

function isTypedObject(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  return Array.isArray(type) ? type.includes('object') : type === 'object';
}

function stringList(value: JsonSchemaValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The decoded segments of a local `$ref`, after paying for its length. */
function refSegments(ref: string, context: GeminiContext): string[] {
  spend(context, 1 + Math.ceil(ref.length / CHARS_PER_WORK_UNIT));
  if (ref === '#') return [];
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  spend(context, segments.length);
  return segments;
}

function resolveSegments(
  root: JsonSchemaValue,
  segments: readonly string[],
): JsonSchemaValue | undefined {
  let current: JsonSchemaValue | undefined = root;
  for (const segment of segments) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) {
      current = current[Number(segment)];
    } else if (
      current !== undefined &&
      isJsonObject(current) &&
      hasOwn(current, segment)
    ) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function isLocalRef(ref: string): boolean {
  return ref === '#' || ref.startsWith('#/');
}

/**
 * Whether a local ref's segments name a subschema position: a member of a
 * schema map or list, or a single-schema keyword, at every step.
 */
function isSubschemaPointer(segments: readonly string[]): boolean {
  let index = 0;
  while (index < segments.length) {
    const key = segments[index] ?? '';
    const member = segments[index + 1];
    if (
      SCHEMA_MAP_KEYWORDS.has(key) ||
      SCHEMA_LIST_KEYWORDS.has(key) ||
      (key === 'items' && member !== undefined && /^[0-9]+$/.test(member))
    ) {
      if (member === undefined) return false;
      index += 2;
    } else if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
      index += 1;
    } else {
      return false;
    }
  }
  return true;
}

/** Queue the subschemas under a node, in the positions conversion visits. */
function pushChildSchemas(
  node: JsonSchemaObject,
  pending: JsonSchemaValue[],
): void {
  for (const [key, value] of definedEntries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      for (const [, member] of definedEntries(value)) pending.push(member);
    } else if (
      (SCHEMA_LIST_KEYWORDS.has(key) || key === 'items') &&
      Array.isArray(value)
    ) {
      for (const member of value) pending.push(member);
    } else if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
      pending.push(value);
    }
  }
}

/** The first keyword on a schema node outside the modeled subset, if any. */
function unsupportedKeyword(
  node: JsonSchemaObject,
  isRoot: boolean,
  context: GeminiContext,
): string | undefined {
  for (const key of UNSUPPORTED_KEYWORDS) {
    if (node[key] !== undefined) return key;
  }
  if (!isRoot && node.$id !== undefined) return '$id';
  const ref = node.$ref;
  if (
    typeof ref === 'string' &&
    !(
      ref === '#' ||
      (ref.startsWith('#/') &&
        !ref.includes('%') &&
        !ref.includes('#', 1) &&
        isSubschemaPointer(refSegments(ref, context)))
    )
  ) {
    return '$ref';
  }
  const dependencies = node.dependencies;
  if (
    dependencies !== undefined &&
    isJsonObject(dependencies) &&
    definedEntries(dependencies).some(([, value]) => !Array.isArray(value))
  ) {
    return 'dependencies';
  }
  return undefined;
}

/**
 * Check, without recursion, that every subschema stays within the modeled
 * subset, and return whether any declares `unevaluatedItems`. The input's
 * size, spent before this runs, pays for the walk; a ref's segments are
 * charged as it is checked.
 */
function checkSubset(schema: JsonSchemaValue, context: GeminiContext): boolean {
  let unevaluatedItems = false;
  const seen = new Set<object>();
  const pending: JsonSchemaValue[] = [schema];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!isJsonObject(node) || seen.has(node)) continue;
    seen.add(node);
    const keyword = unsupportedKeyword(node, node === schema, context);
    if (keyword !== undefined) {
      throw new GeminiConversionAborted(`unsupported keyword "${keyword}"`);
    }
    if (node.unevaluatedItems !== undefined) unevaluatedItems = true;
    pushChildSchemas(node, pending);
  }
  return unevaluatedItems;
}

/**
 * Where a node sits: the root, an `allOf` member (or a branch of a union that
 * is one), or anywhere else.
 */
type NodeRole = 'root' | 'conjunct' | 'plain';

/** The role of a subschema under `key` of a node with role `role`. */
function childRole(key: string, role: NodeRole): NodeRole {
  if (key === 'allOf') return 'conjunct';
  return (key === 'anyOf' || key === 'oneOf') && role === 'conjunct'
    ? 'conjunct'
    : 'plain';
}

function unionKeywords(node: JsonSchemaObject): ('anyOf' | 'oneOf')[] {
  return UNION_KEYWORDS.filter((keyword) => Array.isArray(node[keyword]));
}

function hasSiblingKeys(node: JsonSchemaObject): boolean {
  return Object.keys(node).some(
    (key) =>
      node[key] !== undefined &&
      key !== 'anyOf' &&
      key !== 'oneOf' &&
      !DEFINITION_KEYWORDS.has(key),
  );
}

function hasUnevaluatedKeyword(node: JsonSchemaObject): boolean {
  return UNEVALUATED_KEYWORDS.some((key) => node[key] !== undefined);
}

/**
 * Whether conversion rewrites the unions on this node: one beside other
 * keywords, two on the same node, or any at the root.
 */
function rewritesUnion(node: JsonSchemaObject, role: NodeRole): boolean {
  const unions = unionKeywords(node).length;
  return unions > 0 && (role === 'root' || unions > 1 || hasSiblingKeys(node));
}

/**
 * Keywords conversion moves into an `allOf` member: all object keywords on a
 * schema not typed `object`, otherwise only `required` when it names an
 * undeclared property. A moved `unevaluatedProperties` takes the applicators
 * whose evaluated properties it sees along. `allOf` members are never
 * rewritten this way.
 */
function movedKeywords(
  node: JsonSchemaObject,
  role: NodeRole,
): ReadonlySet<string> {
  if (role === 'conjunct') return new Set();
  if (role !== 'root' && !isTypedObject(node)) {
    const moved = new Set(
      Object.keys(node).filter(
        (key) => node[key] !== undefined && OBJECT_KEYWORDS.has(key),
      ),
    );
    if (moved.has('unevaluatedProperties')) {
      for (const key of PROPERTY_ANNOTATING_APPLICATORS) {
        if (node[key] !== undefined) moved.add(key);
      }
    }
    return moved;
  }
  const properties = node.properties;
  const declared =
    properties !== undefined && isJsonObject(properties) ? properties : {};
  return stringList(node.required).some((name) => !hasOwn(declared, name))
    ? new Set(['required'])
    : new Set();
}

function isBareNull(member: JsonSchemaValue): boolean {
  return (
    isJsonObject(member) &&
    member.type === 'null' &&
    Object.keys(member).every((key) => key === 'type' || key === 'description')
  );
}

/**
 * Whether a union's bare null branches move into `allOf` members: when another
 * branch has, or after conversion will have, no top-level `type`.
 */
function wrapsNull(members: readonly JsonSchemaValue[]): boolean {
  return (
    members.some(isBareNull) &&
    members.some(
      (member) =>
        isJsonObject(member) &&
        !isBareNull(member) &&
        (member.type === undefined || rewritesUnion(member, 'plain')),
    )
  );
}

/** What every step of inlining shares. */
interface InlineScope {
  root: JsonSchemaValue;
  /** The `$ref`s being inlined on the current path. */
  expanding: Set<string>;
  context: GeminiContext;
}

/** A `$ref`'s target with its own refs inlined, or `{}` when it has none. */
function inlineTarget(
  ref: string,
  path: SchemaPath | undefined,
  depth: number,
  scope: InlineScope,
): JsonSchemaValue {
  const { context, expanding } = scope;
  if (expanding.has(ref)) {
    reportLossy(
      context,
      path,
      'replaced a recursive "$ref" with an unconstrained schema',
    );
    return {};
  }
  const resolved = resolveSegments(scope.root, refSegments(ref, context));
  if (resolved === undefined) {
    reportLossy(context, path, 'replaced an unresolvable "$ref" with {}');
    return {};
  }
  spendCopy(context, resolved);
  expanding.add(ref);
  const target = inlineLocalRefs(resolved, path, depth + 1, scope);
  expanding.delete(ref);
  return target;
}

/** Inline the subschemas under one keyword of a node. */
function inlineKeyword(
  key: string,
  value: JsonSchemaValue,
  path: SchemaPath,
  depth: number,
  scope: InlineScope,
): JsonSchemaValue {
  if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
    const members: JsonSchemaObject = {};
    for (const [name, member] of definedEntries(value)) {
      setOwn(
        members,
        name,
        inlineLocalRefs(member, childPath(path, name), depth + 1, scope),
      );
    }
    return members;
  }
  if (
    (SCHEMA_LIST_KEYWORDS.has(key) || key === 'items') &&
    Array.isArray(value)
  ) {
    return value.map((member, index) =>
      inlineLocalRefs(member, childPath(path, String(index)), depth + 1, scope),
    );
  }
  return SINGLE_SCHEMA_KEYWORDS.has(key)
    ? inlineLocalRefs(value, path, depth + 1, scope)
    : value;
}

/**
 * Replace every local `$ref` with its target, so the schema carries no `$ref`
 * key. Keywords beside a `$ref` stay as the node, with the target as an
 * `allOf` member, so nothing is merged. A `$ref` already being inlined on the
 * current path cannot be expanded, so it becomes `{}` and is reported. Every
 * definition map is dropped: the subset check admits only refs this pass
 * rewrites, so nothing refers to one any more.
 */
function inlineLocalRefs(
  node: JsonSchemaValue,
  path: SchemaPath | undefined,
  depth: number,
  scope: InlineScope,
): JsonSchemaValue {
  if (!isJsonObject(node)) return node;
  if (depth > MAX_TOOL_SCHEMA_DEPTH) {
    throw new GeminiConversionAborted('schema nested too deeply');
  }
  const entries = definedEntries(node);
  spend(scope.context, 1 + entries.length);
  const ref = node.$ref;
  if (typeof ref === 'string' && isLocalRef(ref)) {
    const target = inlineTarget(ref, path, depth, scope);
    const rest: JsonSchemaObject = {};
    for (const [key, value] of entries) {
      if (key !== '$ref') setOwn(rest, key, value);
    }
    if (Object.keys(rest).length === 0) return target;
    const inlinedRest = inlineLocalRefs(rest, path, depth + 1, scope);
    return isJsonObject(inlinedRest)
      ? withConjuncts(inlinedRest, [target])
      : inlinedRest;
  }
  const result: JsonSchemaObject = {};
  for (const [key, value] of entries) {
    if (key === '$defs' || key === 'definitions') continue;
    setOwn(
      result,
      key,
      inlineKeyword(key, value, childPath(path, key), depth, scope),
    );
  }
  return result;
}

function transformKeyword(
  key: string,
  value: JsonSchemaValue,
  depth: number,
  parentRole: NodeRole,
  context: GeminiContext,
): JsonSchemaValue {
  if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
    const result: JsonSchemaObject = {};
    for (const [name, member] of definedEntries(value)) {
      setOwn(result, name, transform(member, depth + 1, 'plain', context));
    }
    return result;
  }
  if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
    const role = childRole(key, parentRole);
    const wrapNull = (key === 'anyOf' || key === 'oneOf') && wrapsNull(value);
    return value.map((member) =>
      wrapNull && isBareNull(member)
        ? { allOf: [member] }
        : transform(member, depth + 1, role, context),
    );
  }
  if (SINGLE_SCHEMA_KEYWORDS.has(key) && !Array.isArray(value)) {
    return transform(value, depth + 1, 'plain', context);
  }
  return value;
}

/** Append conjuncts to a node's `allOf`, in place. */
function withConjuncts(
  node: JsonSchemaObject,
  conjuncts: readonly JsonSchemaValue[],
): JsonSchemaObject {
  if (conjuncts.length === 0) return node;
  const allOf = node.allOf;
  setOwn(node, 'allOf', [...(Array.isArray(allOf) ? allOf : []), ...conjuncts]);
  return node;
}

/**
 * Draft-07 tuple `items: [...]` becomes `prefixItems` with `additionalItems`
 * as `items`, and `prefixItems` alone gets `items: {}`, which accepts what it
 * already accepted. Gemini requires an `items` schema on every tuple. An
 * `unevaluatedItems` would read an added `items` as evaluating every item, so
 * none is added to a schema that has one.
 */
function normalizeTuple(
  node: JsonSchemaObject,
  context: GeminiContext,
): JsonSchemaObject {
  const items = node.items;
  const added: JsonSchemaValue | undefined = context.unevaluatedItems
    ? undefined
    : {};
  if (Array.isArray(items)) {
    const result: JsonSchemaObject = {};
    for (const [key, value] of definedEntries(node)) {
      if (key === 'additionalItems') continue;
      if (key === 'items') {
        setOwn(result, 'prefixItems', value);
        const rest = node.additionalItems ?? added;
        if (rest !== undefined) setOwn(result, 'items', rest);
      } else {
        setOwn(result, key, value);
      }
    }
    return result;
  }
  if (
    Array.isArray(node.prefixItems) &&
    items === undefined &&
    added !== undefined
  ) {
    return { ...node, items: added };
  }
  return node;
}

/** Remember an output node that carries a `$ref`. */
function noteRef(node: JsonSchemaObject, context: GeminiContext): void {
  if (typeof node.$ref === 'string') context.refNodes.push(node);
}

/**
 * A node without a union to rewrite. Its object keywords move into an `allOf`
 * member when it is not typed `object`; on an object, only `required` names
 * that are not declared properties move.
 */
function transformNode(
  input: JsonSchemaObject,
  depth: number,
  role: NodeRole,
  context: GeminiContext,
  result: JsonSchemaObject = {},
): JsonSchemaObject {
  const moved = movedKeywords(input, role);
  const typedObject = role === 'root' || isTypedObject(input);
  const conjunct: JsonSchemaObject = {};
  for (const [key, value] of definedEntries(normalizeTuple(input, context))) {
    const transformed = transformKeyword(key, value, depth, role, context);
    if (!moved.has(key)) {
      setOwn(result, key, transformed);
    } else if (key === 'required' && typedObject) {
      const properties = input.properties;
      const declared =
        properties !== undefined && isJsonObject(properties) ? properties : {};
      const names = stringList(transformed);
      const kept = names.filter((name) => hasOwn(declared, name));
      if (kept.length > 0) setOwn(result, key, kept);
      setOwn(
        conjunct,
        key,
        names.filter((name) => !hasOwn(declared, name)),
      );
    } else {
      setOwn(conjunct, key, transformed);
    }
  }
  enumTypedByValues(result);
  noteRef(result, context);
  noteRef(conjunct, context);
  return moved.size === 0 ? result : withConjuncts(result, [conjunct]);
}

/** The one Gemini type all values share, or undefined when they are mixed. */
function sharedPrimitiveType(
  values: readonly JsonSchemaValue[],
): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === 'string')) return 'string';
  if (values.every((value) => typeof value === 'boolean')) return 'boolean';
  if (
    values.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return values.every((value) => Number.isInteger(value))
      ? 'integer'
      : 'number';
  }
  return undefined;
}

/**
 * Gemini rejects an `enum` (or `const`) unless its non-null values share one
 * primitive type that the node's `type` allows. Codex sends `{ const: true }`
 * as `{ type: 'string', enum: [true] }`, so a node whose `type` rejects every
 * non-null value takes its values' type, keeping `null` when the old type
 * allowed it. A node with mixed values, or a value its type accepts, is left
 * alone.
 */
function enumTypedByValues(node: JsonSchemaObject): void {
  const type = node.type;
  if (type === undefined) return;
  const values = Array.isArray(node.enum)
    ? node.enum
    : hasOwn(node, 'const')
      ? [node.const ?? null]
      : undefined;
  if (values === undefined) return;
  const present = values.filter((value) => value !== null);
  const types = Array.isArray(type) ? type : [type];
  const accepted = (value: JsonSchemaValue): boolean =>
    types.includes(typeof value) ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      types.includes('integer'));
  if (present.some(accepted)) return;
  const valueType = sharedPrimitiveType(present);
  if (valueType === undefined) return;
  setOwn(
    node,
    'type',
    types.includes('null') ? [valueType, 'null'] : valueType,
  );
}

/**
 * Rewrite a node's unions so each is the only keyword on its node: the node
 * becomes `{ allOf: [<its other keywords>, { anyOf: [...] }] }`, with one
 * `allOf` member per union. Every keyword appears once, so the output grows
 * linearly with the input. When the other keywords include
 * `unevaluatedProperties` or `unevaluatedItems`, which must see what the
 * unions evaluate, the unions go into the `allOf` of that member instead. At
 * the root, which Vertex AI requires to stay a typed object, the other
 * keywords stay in place and only the unions move into its `allOf`.
 */
function transformUnionNode(
  input: JsonSchemaObject,
  depth: number,
  role: NodeRole,
  context: GeminiContext,
): JsonSchemaObject {
  const siblings: JsonSchemaObject = {};
  const kept: JsonSchemaObject = {};
  for (const [key, value] of definedEntries(input)) {
    if (key === 'anyOf' || key === 'oneOf') continue;
    setOwn(DEFINITION_KEYWORDS.has(key) ? kept : siblings, key, value);
  }
  // Every union lands in an `allOf` member, whose contents Gemini does not
  // check for the rules above.
  const unions = unionKeywords(input).map((keyword): JsonSchemaObject => {
    const list = input[keyword];
    const branches = (Array.isArray(list) ? list : []).map((member) =>
      transform(member, depth + 1, 'conjunct', context),
    );
    const union: JsonSchemaObject = {};
    setOwn(union, keyword, branches);
    return union;
  });
  const result: JsonSchemaObject = {};
  for (const [key, value] of definedEntries(kept)) {
    setOwn(result, key, transformKeyword(key, value, depth, 'plain', context));
  }
  if (role === 'root') {
    return withConjuncts(
      transformNode(siblings, depth, role, context, result),
      unions,
    );
  }
  if (!hasSiblingKeys(input)) return withConjuncts(result, unions);
  const own = transform(siblings, depth + 1, 'conjunct', context);
  if (hasUnevaluatedKeyword(siblings) && isJsonObject(own)) {
    return withConjuncts(result, [withConjuncts(own, unions)]);
  }
  return withConjuncts(result, [own, ...unions]);
}

function transform(
  input: JsonSchemaValue,
  depth: number,
  role: NodeRole,
  context: GeminiContext,
): JsonSchemaValue {
  if (!isJsonObject(input)) return input;
  if (depth > MAX_DEPTH) {
    throw new GeminiConversionAborted('schema nested too deeply');
  }
  spend(context, 1 + Object.keys(input).length);
  const output = rewritesUnion(input, role)
    ? transformUnionNode(input, depth, role, context)
    : transformNode(input, depth, role, context);
  context.sources?.set(output, input);
  return output;
}

/** `base`, or `base_<n>` with the first free `n`, without rescanning names. */
function uniqueName(
  base: string,
  taken: Set<string>,
  next: Map<string, number>,
  context: GeminiContext,
): string {
  const cost = 1 + Math.ceil(base.length / CHARS_PER_WORK_UNIT);
  spend(context, cost);
  let name = base;
  let suffix = next.get(base) ?? 2;
  while (taken.has(name)) {
    spend(context, cost);
    name = `${base}_${String(suffix)}`;
    suffix += 1;
  }
  next.set(base, suffix);
  taken.add(name);
  return name;
}

/**
 * Point every local `$ref` whose target the conversion moved at a converted
 * copy of that target in the root `$defs`. A target stayed put when the
 * output holds, at the ref's pointer, exactly the node converted from it, so
 * no relocation needs predicting. Copies are converted the same way and their
 * refs are pointed the same way, so every ref resolves to the conversion of
 * the subschema it named in the input.
 */
function stabilizeRefs(
  root: JsonSchemaValue,
  output: JsonSchemaValue,
  context: GeminiContext,
): void {
  const sources = context.sources;
  context.sources = undefined;
  if (!isJsonObject(output) || context.refNodes.length === 0) return;
  const existing = output.$defs;
  const taken = new Set<string>(
    existing !== undefined && isJsonObject(existing)
      ? Object.keys(existing)
      : [],
  );
  spend(context, taken.size);
  const targets = new Map<string, string>();
  const moved: { ref: string; segments: string[]; target: JsonSchemaValue }[] =
    [];
  const classify = (ref: string): void => {
    if (targets.has(ref) || !isLocalRef(ref) || ref === '#') return;
    const segments = refSegments(ref, context);
    const target = resolveSegments(root, segments);
    if (target === undefined) {
      // An unresolvable ref into `$defs` must not come to name a copy.
      const [first, name] = segments;
      if (first === '$defs' && name !== undefined) taken.add(name);
      targets.set(ref, ref);
      return;
    }
    const placed = resolveSegments(output, segments);
    const stayed =
      placed !== undefined &&
      (isJsonObject(target)
        ? isJsonObject(placed) && sources?.get(placed) === target
        : placed === target);
    if (stayed) {
      targets.set(ref, ref);
      return;
    }
    targets.set(ref, ref);
    moved.push({ ref, segments, target });
  };
  let classified = 0;
  const classifyNew = (): void => {
    for (; classified < context.refNodes.length; classified += 1) {
      const ref = context.refNodes[classified]?.$ref;
      if (typeof ref === 'string') classify(ref);
    }
  };
  classifyNew();
  if (moved.length === 0) return;
  if (existing !== undefined && !isJsonObject(existing)) {
    throw new GeminiConversionAborted('a moved "$ref" needs a root "$defs"');
  }
  const definitions: JsonSchemaObject = existing ?? {};
  const suffixes = new Map<string, number>();
  for (let index = 0; index < moved.length; index += 1) {
    const entry = moved[index];
    if (entry === undefined) continue;
    const name = uniqueName(entry.segments.join('.'), taken, suffixes, context);
    spendCopy(context, entry.target);
    setOwn(definitions, name, transform(entry.target, 0, 'plain', context));
    targets.set(entry.ref, `#/$defs/${escapeSegment(name)}`);
    classifyNew();
  }
  if (existing === undefined) setOwn(output, '$defs', definitions);
  for (const node of context.refNodes) {
    const ref = node.$ref;
    const target = typeof ref === 'string' ? targets.get(ref) : undefined;
    if (target !== undefined && target !== ref) setOwn(node, '$ref', target);
  }
}

/** The schema typed as an object, with `type` first and every other keyword kept. */
function typedAsObject(schema: JsonSchemaObject): JsonSchemaObject {
  const result: JsonSchemaObject = { type: 'object' };
  for (const [key, value] of definedEntries(schema)) {
    if (key !== 'type') setOwn(result, key, value);
  }
  return result;
}

/**
 * Project a tool's JSON Schema into the subset Gemini function declarations
 * accept, without changing which instances it accepts:
 *
 * - every `anyOf`/`oneOf` is the only keyword on its node: a node with other
 *   keywords becomes `{ allOf: [<its other keywords>, { anyOf: [...] }] }`,
 *   and at the root the unions move into `allOf`;
 * - object keywords on a schema not typed `object`, and `required` names that
 *   are not declared properties, move into an `allOf` member;
 * - tuples get an `items` schema (draft-07 `items: [...]` becomes
 *   `prefixItems`), unless the schema uses `unevaluatedItems`;
 * - local `$ref`s whose targets move are pointed at converted copies in the
 *   root `$defs`;
 * - a bare `{ type: 'null' }` branch beside an untyped branch becomes
 *   `{ allOf: [{ type: 'null' }] }`;
 * - with `inlineRefs`, every local `$ref` is replaced by its target, and a
 *   recursive one by `{}`, which is reported through `onLossy`;
 * - a root not typed `object` is typed as one, reported through `onLossy`.
 *
 * Pure, never mutates its input, and idempotent; a schema with none of those
 * shapes is returned deeply equal. At most 20 lossy changes are reported one
 * by one, followed by a count of the rest.
 *
 * A schema outside the modeled subset (see the top of this file) is returned
 * unchanged with one `onLossy` at `#` naming the keyword. Tool schemas arrive
 * in requests, so conversion is also bounded: JSON nested deeper than
 * `MAX_TOOL_SCHEMA_DEPTH`, subschemas nested deeper than 64 levels, or work
 * beyond the budget returns the input unchanged and reports a single
 * `onLossy` at `#` instead of the partial result's reports. The work spent,
 * or the whole allowance when it runs out, is taken from `options.budget`
 * when one is shared across a request.
 */
export function toGeminiToolSchema(
  schema: JsonSchemaValue,
  options: GeminiToolSchemaOptions = {},
): JsonSchemaValue {
  const shape = measureJson(schema);
  if (shape.depth > MAX_TOOL_SCHEMA_DEPTH) {
    options.onLossy?.('#', 'schema nested too deeply; schema left unchanged');
    return schema;
  }
  const size = jsonWorkUnits(shape);
  const limit = toolSchemaWorkLimit(
    WORK_BUDGET_BASE + WORK_PER_INPUT_UNIT * size,
    options.budget,
  );
  const context: GeminiContext = {
    reports: [],
    unreported: 0,
    remaining: limit,
    unevaluatedItems: false,
    sources: new Map(),
    refNodes: [],
  };
  let result: JsonSchemaValue;
  try {
    spend(context, size);
    context.unevaluatedItems = checkSubset(schema, context);
    let root = schema;
    if (isJsonObject(root) && !isTypedObject(root)) {
      reportLossy(
        context,
        childPath(undefined, 'type'),
        'typed the root as an object, which Vertex AI requires',
      );
      root = typedAsObject(root);
    }
    if (options.inlineRefs) {
      root = inlineLocalRefs(root, undefined, 0, {
        root,
        expanding: new Set(),
        context,
      });
    }
    result = transform(root, 0, 'root', context);
    stabilizeRefs(root, result, context);
  } catch (error) {
    if (!(error instanceof GeminiConversionAborted)) throw error;
    options.budget?.consume(limit - Math.max(0, context.remaining));
    options.onLossy?.('#', `${error.reason}; schema left unchanged`);
    return schema;
  }
  options.budget?.consume(limit - context.remaining);
  for (const [path, reason] of context.reports) options.onLossy?.(path, reason);
  if (context.unreported > 0) {
    options.onLossy?.(
      '#',
      `${String(context.unreported)} more lossy changes not reported`,
    );
  }
  return result;
}
