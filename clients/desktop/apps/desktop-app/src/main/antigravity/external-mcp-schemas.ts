import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import { SUBSCHEMA_MAP_KEYWORDS } from '@canopy/desktop-shared/json-schema-positions';
import type { McpSchemaInputClassifier } from '@canopy/desktop-shared/node/opencode/schema-validation';
import { antigravityAdvertisedSchema } from './mcp-schema';

const MAX_TOOLS_PER_SERVER = 5000;

/** One selected external tool as the native runtime last listed it through the host. */
export interface AntigravityExternalToolSchema {
  readonly server: string;
  readonly tool: string;
  /** The upstream server's schema; calls are checked against this. */
  readonly inputSchema: JsonValue;
  /** What the native runtime received. */
  readonly advertisedSchema: JsonValue;
  /** True when the advertised schema omits an upstream constraint. */
  readonly projected: boolean;
  /**
   * The server's list generation (1 for the turn's first cursor-less list)
   * in which this schema was recorded; an identical re-list keeps it.
   */
  readonly listGeneration: number;
}

export type AntigravityExternalToolCallCheck =
  | { readonly ok: true; readonly entry: AntigravityExternalToolSchema }
  | { readonly ok: false; readonly refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copies parsed JSON; anything else is not a schema this host can relay. */
function jsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 128) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const copy = jsonValue(item, depth + 1);
      if (copy === undefined) return undefined;
      items.push(copy);
    }
    return items;
  }
  if (!isRecord(value)) return undefined;
  const copy: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const child = jsonValue(item, depth + 1);
    if (child === undefined) return undefined;
    // A parsed "__proto__" key is data, never the prototype setter.
    Object.defineProperty(copy, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** Keywords whose values are instance data, never schemas Ajv evaluates. */
const VALUE_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

/** Resolves a local JSON Pointer reference (`#/a/b`) within `root`. */
function resolvePointer(
  root: JsonValue,
  reference: string,
): JsonValue | undefined {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let target: JsonValue | undefined = root;
  for (const raw of reference.slice(2).split('/')) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (target === null || typeof target !== 'object') return undefined;
    target = Array.isArray(target)
      ? target[Number(token)]
      : Object.prototype.hasOwnProperty.call(target, token)
        ? target[token]
        : undefined;
  }
  return target;
}

/**
 * Whether a reference may resolve somewhere `resolvePointer` cannot follow:
 * anything but a root pointer (`#` or `#/…`), or any nested `$id`, which
 * re-bases `#/…` references inside it (Ajv resolves them against it).
 */
function hasUnfollowedReference(value: JsonValue, root = true): boolean {
  if (Array.isArray(value))
    return value.some((child) => hasUnfollowedReference(child, false));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (child === undefined) return false;
    if (key === '$id' && !root) return true;
    if (REFERENCE_KEYWORDS.has(key) && typeof child === 'string')
      return child !== '#' && !child.startsWith('#/');
    return hasUnfollowedReference(child, false);
  });
}

/**
 * True when the key "__proto__" appears anywhere Ajv may evaluate as a schema
 * (for example as a property name); Ajv skips constraints there. Unknown
 * keywords are walked too, and local `$ref` targets are followed even into
 * literal values, because Ajv evaluates whatever a reference points at.
 * Literal values are otherwise not walked, and keys of a shared subschema map
 * are names, never keywords. Each referenced target is walked once.
 */
function hasProtoKey(root: JsonValue): boolean {
  // A reference that cannot be followed here can reach any value, so literal
  // values are walked as well when one is present.
  const walkLiterals = hasUnfollowedReference(root);
  const seen = new Set<JsonValue>();
  const pending: JsonValue[] = [root];
  const walk = (value: JsonValue, names: boolean): boolean => {
    if (Array.isArray(value)) return value.some((child) => walk(child, false));
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => {
      if (key === '__proto__') return true;
      if (child === undefined) return false;
      if (!names && REFERENCE_KEYWORDS.has(key) && typeof child === 'string') {
        const target = resolvePointer(root, child);
        if (target !== undefined) pending.push(target);
        return false;
      }
      if (!names && !walkLiterals && VALUE_KEYWORDS.has(key)) return false;
      return walk(child, !names && SUBSCHEMA_MAP_KEYWORDS.has(key));
    });
  };
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (walk(next, false)) return true;
  }
  return false;
}

interface Recorded {
  readonly entry: AntigravityExternalToolSchema;
  /** A projected schema the host validator cannot evaluate faithfully. */
  readonly uncheckable: boolean;
  /** The upstream schema serialized once, for re-list comparisons. */
  readonly serialized: string;
}

type Slot = Recorded | 'ambiguous';

/**
 * Adds one listed tool to the page's map and returns what to relay for it, or
 * `undefined` for a tool that is not a valid MCP tool. Such a tool is neither
 * relayed nor recorded, so its calls refuse as unlisted while the server's
 * other tools keep working. An identical tool already recorded is kept, so a
 * re-list that changes nothing does not invalidate an approval in flight.
 */
function recordTool(
  tools: Map<string, Slot>,
  previous: ReadonlyMap<string, Slot> | undefined,
  server: string,
  listGeneration: number,
  tool: unknown,
): unknown {
  if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name)
    return undefined;
  const inputSchema = jsonValue(tool.inputSchema);
  if (!isRecord(inputSchema)) return undefined;
  const advertisedSchema = antigravityAdvertisedSchema(inputSchema);
  // An unchanged projection returns the same object.
  const projected = advertisedSchema !== inputSchema;
  // Key-order sensitive: an equal but reordered schema only counts as a new
  // entry, which costs a re-check, never a skipped one.
  const original = JSON.stringify(inputSchema);
  const prior = previous?.get(tool.name);
  const recorded: Recorded =
    prior !== undefined &&
    prior !== 'ambiguous' &&
    prior.serialized === original
      ? prior
      : {
          entry: {
            server,
            tool: tool.name,
            inputSchema,
            advertisedSchema,
            projected,
            listGeneration,
          },
          uncheckable: projected && hasProtoKey(inputSchema),
          serialized: original,
        };
  const existing = tools.get(tool.name);
  // A repeated page may list a tool again; two schemas for one name refuse both.
  const repeated =
    existing === undefined ||
    (existing !== 'ambiguous' && existing.serialized === original);
  tools.set(tool.name, repeated ? recorded : 'ambiguous');
  // An unprojected tool is relayed exactly as the server sent it.
  return projected ? { ...tool, inputSchema: advertisedSchema } : tool;
}

/**
 * Turn-scoped record of the selected external MCP tool lists the native
 * runtime received through the host's HTTP proxy or stdio broker. Each
 * instance belongs to one Antigravity turn's selection; entries are keyed by
 * that turn's selected server name and are never shared across turns.
 *
 * agy 1.5.1 aborts a whole turn when an advertised pattern is not Go RE2
 * syntax, so the advertised schema reuses the app-tool projection.
 * A projected schema omits an upstream constraint from what the runtime sees,
 * so the host checks those calls against the upstream schema before approval
 * and refuses any it cannot evaluate. For a tool whose schema was relayed
 * unchanged the host adds no argument check, exactly as before this ledger
 * existed; whether the server enforces its own schema is up to the server.
 * The host only confirms it was listed this turn (accepted for CAN-6708 and
 * tracked under CAN-6709). A call to a tool this turn never listed, or listed
 * twice with different schemas, is refused.
 */
export class AntigravityExternalToolSchemas {
  private readonly servers = new Map<string, ReadonlyMap<string, Slot>>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly classify: McpSchemaInputClassifier) {}

  /**
   * Records one `tools/list` result page and returns the result to relay.
   * A page without a cursor starts the server's list again, so a list changed
   * upstream replaces the previous one. Throws for a result that is not an
   * MCP tool list, leaving the previous list in force; the transport then
   * answers with an error and the runtime keeps its previous list too.
   */
  advertise(
    server: string,
    page: { cursor?: string; result: unknown },
  ): unknown {
    const { result } = page;
    if (!isRecord(result) || !Array.isArray(result.tools))
      throw new Error('The MCP tool list is invalid.');
    if (result.tools.length > MAX_TOOLS_PER_SERVER)
      throw new Error('The MCP tool list exceeds its limit.');
    const previous = this.servers.get(server);
    const prior = this.generations.get(server) ?? 0;
    const generation =
      page.cursor === undefined ? prior + 1 : Math.max(prior, 1);
    // A cursor-less list replaces the server's entries, even mid-pagination:
    // the newest first page wins and later cursor pages append to it.
    const tools = new Map<string, Slot>(
      page.cursor === undefined ? [] : (previous ?? []),
    );
    const advertised = result.tools
      .map((tool) => recordTool(tools, previous, server, generation, tool))
      .filter((tool) => tool !== undefined);
    // Repeated pages re-list names; only distinct names count toward the cap.
    if (tools.size > MAX_TOOLS_PER_SERVER)
      throw new Error('The MCP tool list exceeds its limit.');
    this.servers.set(server, tools);
    this.generations.set(server, generation);
    return { ...result, tools: advertised };
  }

  /** Checks a call before approval; only `ok` may reach the approval prompt. */
  async check(
    server: string,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<AntigravityExternalToolCallCheck> {
    const slot = this.servers.get(server)?.get(tool);
    if (slot === undefined)
      return refuse('This MCP server did not list that tool in this session.');
    if (slot === 'ambiguous')
      return refuse('This MCP server listed that tool more than once.');
    const { entry } = slot;
    // Relayed unchanged: no host argument check, as before this ledger.
    if (!entry.projected) return { ok: true, entry };
    if (slot.uncheckable) return refuse(UNCHECKABLE);
    const outcome = await this.classify(entry.inputSchema, args, signal);
    if (!this.isCurrent(entry))
      return refuse('The tool list changed while the call was checked.');
    if (outcome === 'valid') return { ok: true, entry };
    if (outcome === 'invalid')
      return refuse("The arguments do not match the tool's input schema.");
    return refuse(
      outcome === 'unsupported'
        ? UNCHECKABLE
        : "The arguments couldn't be checked against the tool's input schema.",
    );
  }

  /** Keeps an earlier decision while its schema is current, else checks again. */
  confirm(
    checked: AntigravityExternalToolSchema,
    args: unknown,
    signal: AbortSignal,
  ): Promise<AntigravityExternalToolCallCheck> {
    return this.isCurrent(checked)
      ? Promise.resolve({ ok: true, entry: checked })
      : this.check(checked.server, checked.tool, args, signal);
  }

  /** False once a newer list changed the schema a check used. */
  isCurrent(checked: AntigravityExternalToolSchema): boolean {
    const slot = this.servers.get(checked.server)?.get(checked.tool);
    return slot !== undefined && slot !== 'ambiguous' && slot.entry === checked;
  }

  /**
   * The current lists, for the persisted capability snapshot (CAN-6684 /
   * CAN-6707 binds these beside snapshot.mcp). Not persisted here.
   */
  entries(): AntigravityExternalToolSchema[] {
    return [...this.servers.values()].flatMap((tools) =>
      [...tools.values()].flatMap((slot) =>
        slot === 'ambiguous' ? [] : [slot.entry],
      ),
    );
  }
}

const UNCHECKABLE =
  "This tool's input schema can't be checked here, so the call was not sent.";

function refuse(refusal: string): AntigravityExternalToolCallCheck {
  return { ok: false, refusal };
}
