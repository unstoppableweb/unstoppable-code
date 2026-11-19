import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  agentSecretRedactionPlaceholder,
  agentSecretValueForms,
} from '@canopy/protocol/agent-secrets';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { MergedSecretRedactor } from './merged-redactor';
import { refusedProjection } from './refused-projection';
import { getChatSecretStore, type ChatSecretScope } from './chat-secret-store';

/*
 * The storage backstop for chats with agent secrets (PLAN.md §10).
 * RunWithSecrets and WriteSecretsFile redact their own results; this catches
 * a value that reaches the chat another way, such as a native shell command
 * printing a file WriteSecretsFile wrote. The session event router applies
 * it to every provider event before any route stores, logs or forwards it,
 * so the canonical transcript, output artifacts, observability sidecars,
 * telemetry built from chat events and the live view all get the redacted
 * text. Its values are every value recorded, of every chat and secrets file,
 * as Canopy's views redact (`view-redaction.ts`).
 *
 * Providers stream text in pieces, so a value can be cut at an event
 * boundary. Claude's deltas go through one streaming redactor per stream
 * (the content block of a message, keyed by its parent tool call and index),
 * which holds back a trailing fragment as long as the longest value form
 * minus one and releases it, redacted, when the block, the message or the
 * turn ends; a session that closes mid-block drops it, never releasing it
 * unredacted (the provider's whole message still records the text). Codex
 * sends the whole text so far on each update: an item in progress is
 * redacted with its tail held back the same way, and a completed item is
 * redacted whole. Every other event, including the other providers'
 * assistant patches, is redacted whole: a value cut between two patches is
 * not matched (a known gap). A number is matched by its string form.
 *
 * Fails closed: when a value of the chat, its worktree or a secrets file
 * under its folder can't be read back, or the store couldn't be read, the
 * event is dropped and the router records a metadata-only drop. Only the
 * events that settle a turn or a route go on, kept to their kind's
 * allowlist (`refused-projection.ts`), so the turn still ends.
 *
 * It protects storage only: the provider already returned the text to the
 * model, which has seen the value.
 */

/** Why an event was withheld; a fixed code, never provider text. */
export type ChatSecretBackstopRefusal =
  | 'values_unreadable'
  | 'store_unread'
  /** A delegation that can't stay valid once redacted (an id is a value). */
  | 'delegation_unredactable';

export interface ChatSecretBackstopResult {
  readonly events: readonly unknown[];
  /**
   * Set when the event was dropped, or, when the values couldn't be read and
   * it settles a turn or a route, `events` holds it without conversation
   * text.
   */
  readonly refused?: ChatSecretBackstopRefusal;
}

/**
 * Fields that name the kind of an event or block (`type: 'text'`), kept so a
 * value that a token merely contains can't turn a block into something the
 * transcript no longer recognizes. Only a protocol-shaped token is kept,
 * only outside a tool's own input, arguments or output (see
 * {@link PAYLOAD_KEYS}), and never one that is wholly a value.
 */
const PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'role',
  'kind',
  'method',
  'status',
  'stop_reason',
  'terminal_reason',
  'provider',
  'phase',
]);
const PROTOCOL_TOKEN = /^[a-z][a-z0-9_.-]{0,40}$/;

/** Enum-like fields by name (`executionMode`, `transcriptStore`, `state`). */
const ENUM_KEY =
  /^(?:state|event|source)$|[a-z](?:Mode|Store|Status|Kind|State|Phase|Type|Source)$/;

function isProtocolKey(key: string): boolean {
  return PROTOCOL_KEYS.has(key) || ENUM_KEY.test(key);
}

/**
 * Fields holding what a tool was given or returned. Nothing under them is a
 * protocol field, whatever its key: a tool input `{ "status": <value> }` is
 * redacted like any other text.
 */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'input',
  'tool_input',
  'arguments',
  'params',
  'result',
  'output',
  'structuredContent',
  'aggregated_output',
  'changes',
  // A Claude tool result's structured form.
  'tool_use_result',
  'toolUseResult',
]);

/**
 * Identifier fields that route an event to its thread, turn, message, item
 * or call (`id`, `uuid`, `generation`, `*_id`, `*Id`, such as the turn-owner stamp
 * `canopy_turn_user_message_id`). A short value can occur inside a
 * generated id by chance, which is no disclosure, and rewriting it would
 * detach the event from its route; only an id that is wholly a value's form
 * is replaced.
 */
const ID_KEY = /^(?:id|uuid|generation)$|_id$|[a-z]Id$/;

/** Lists of such ids (`parent_tool_use_ids`, `liveParentToolUseIds`). */
const ID_LIST_KEY = /_ids$|[a-z]Ids$/;

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}

/** Claude delta kinds whose text streams, and the field holding it. */
const CLAUDE_DELTA_FIELDS: Readonly<Record<string, string>> = {
  text_delta: 'text',
  thinking_delta: 'thinking',
  input_json_delta: 'partial_json',
};

/** Codex item fields that hold the item's whole text so far. */
const CODEX_CUMULATIVE_FIELDS = ['text', 'aggregated_output', 'summary_text'];

type Groups = Array<Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A stable key for a set of values, to tell when it changed. */
function fingerprint(groups: Groups): string {
  return JSON.stringify(groups.map((group) => Object.entries(group).sort()));
}

/**
 * Text that arrives over several events until a boundary ends it: a Claude
 * content block's deltas, a Codex plan's deltas (`delta`), or a Codex item
 * in progress, whose events each carry its whole text so far
 * (`cumulative`). Every stream ends only at its own boundary
 * ({@link endedStreams}), and releases what it held back then.
 */
interface Stream {
  kind: 'delta' | 'cumulative';
  redactor: MergedSecretRedactor;
  version: string;
  /** The last delta event released, redacted: the shape of a flush. */
  template: Record<string, unknown>;
  /**
   * The event a stream releases at its boundary, given its held text,
   * redacted; `undefined` for nothing. Claude's streams use `template`.
   */
  release?: (rest: string) => Record<string, unknown> | undefined;
  /**
   * The Codex thread a stream belongs to (empty when its events named
   * none): only that thread's turn ending ends it.
   */
  thread?: string;
  field: string;
  parent: string;
  /**
   * Set when what the stream held couldn't be redacted (the values couldn't
   * be read while it was open, or a value change met an open match too long
   * to carry): the rest of a delta stream is withheld until its boundary,
   * since a value it continues couldn't be matched.
   */
  withheld?: true;
}

/** A Codex item in progress' stream key. */
function codexItemStream(itemId: unknown): string {
  return `codex-item\0${typeof itemId === 'string' ? itemId : ''}`;
}

/** The delta stream `data` continues, if any: its key, parent and thread. */
function deltaStreamOf(
  data: unknown,
): { key: string; parent: string; thread?: string } | undefined {
  if (!isRecord(data) || !isRecord(data.event)) return undefined;
  const event = data.event;
  if (data.type === 'stream_event' && event.type === 'content_block_delta') {
    const parent =
      typeof data.parent_tool_use_id === 'string'
        ? data.parent_tool_use_id
        : '';
    return { key: `${parent}\0${String(event.index)}`, parent };
  }
  if (data.type === 'codex' && event.type === 'item.plan.delta') {
    const key = codexPlanStream(event.item_id);
    return {
      key,
      parent: key,
      thread: typeof event.thread_id === 'string' ? event.thread_id : '',
    };
  }
  return undefined;
}

/** Keys of one object (by identity) that a whole-text pass leaves alone. */
interface Skip {
  readonly target: object;
  readonly keys: readonly string[];
}

/**
 * The backstop for one chat session's provider events. Not shared between
 * sessions: it keeps each stream's held-back text.
 */
export class ChatSecretStorageBackstop {
  private readonly streams = new Map<string, Stream>();
  private version = '';
  private groups: Groups = [];
  private whole: MergedSecretRedactor | null = null;
  private wholeForms = new Map<string, string>();

  /**
   * @param scope the chat, and `root` the folder its commands run in.
   */
  /**
   * @param root the folder the session's commands run in, resolved through
   *   links (secrets files are recorded by their resolved paths); see
   *   {@link forSession}.
   */
  constructor(
    private readonly scope: ChatSecretScope,
    private readonly root?: string,
  ) {}

  /**
   * The backstop for a session whose commands run in `cwd`: the folder is
   * resolved through links first, as RunWithSecrets resolves its root, so
   * the secrets files under it match their recorded paths. One that can't
   * be resolved is used as given.
   */
  static async forSession(
    scope: ChatSecretScope,
    cwd: string,
  ): Promise<ChatSecretStorageBackstop> {
    const root = await realpath(cwd).catch(() => cwd);
    return new ChatSecretStorageBackstop(scope, root);
  }

  /**
   * The values to redact, or the reason they can't be read: the chat's own,
   * its worktree's and the secrets files under its folder must all be read
   * back; every other recorded value is added as far as it can be, so one
   * that can't be read elsewhere never stops this chat.
   */
  private values(): Groups | ChatSecretBackstopRefusal {
    const store = getChatSecretStore();
    if (!store.isLoaded()) return 'store_unread';
    try {
      return [
        ...store.redactionGroups(this.scope, {
          strict: true,
          ...(this.root !== undefined ? { root: this.root } : {}),
        }),
        ...store.viewRedactionGroups({ strict: false }),
      ];
    } catch {
      return 'values_unreadable';
    }
  }

  private refresh(groups: Groups): void {
    const version = fingerprint(groups);
    if (version === this.version && this.whole) return;
    this.version = version;
    this.groups = groups;
    this.whole = new MergedSecretRedactor(groups);
    this.wholeForms = new Map(
      groups.flatMap((group) =>
        Object.entries(group).flatMap(([name, value]) =>
          agentSecretValueForms(value).map((form): [string, string] => [
            form,
            name,
          ]),
        ),
      ),
    );
  }

  /**
   * The events to deliver in place of `data`: usually one, its redacted copy
   * (`data` itself when nothing matched); before an event that ends a
   * stream, the stream's held-back text as a delta of its own; none when the
   * values can't be read.
   */
  apply(data: unknown): ChatSecretBackstopResult {
    const values = this.values();
    if (typeof values === 'string') {
      // Nothing held back may be released without its redaction, and the
      // event is dropped; one that settles a turn or a route goes on without
      // its conversation text, so the turn still ends. Every open delta
      // stream, and one this event starts, is withheld until its boundary:
      // values readable again can't match a value it began before.
      this.quarantine(data);
      const settling = refusedProjection(data);
      return {
        events: settling === undefined ? [] : [settling],
        refused: values,
      };
    }
    if (values.length === 0 && this.streams.size === 0)
      return { events: [data] };
    this.refresh(values);
    const events: unknown[] = [];
    const ended = isRecord(data) ? endedStreams(data) : undefined;
    if (ended) this.flushWhere(ended, events);
    if (isRecord(data) && data.type === 'stream_event' && isRecord(data.event))
      this.applyClaudeStream(data, data.event, events);
    else if (
      isRecord(data) &&
      data.type === 'codex' &&
      isRecord(data.event) &&
      data.event.type === 'item.plan.delta'
    )
      this.applyCodexPlanDelta(data, data.event, events);
    else if (
      isRecord(data) &&
      data.type === 'codex' &&
      isRecord(data.event) &&
      isRecord(data.event.item)
    )
      this.applyCodexItem(data, data.event, data.event.item, events);
    else if (isRecord(data) && data.type === 'canopy_delegation') {
      const delegation = this.redactDelegation(data);
      // One that can't stay valid once redacted is dropped, never delivered
      // unredacted or malformed.
      if (delegation === undefined)
        return { events, refused: 'delegation_unredactable' };
      events.push(delegation);
    } else events.push(this.redactWhole(data));
    return { events };
  }

  private applyClaudeStream(
    data: Record<string, unknown>,
    event: Record<string, unknown>,
    events: unknown[],
  ): void {
    const parent =
      typeof data.parent_tool_use_id === 'string'
        ? data.parent_tool_use_id
        : '';
    const key = `${parent}\0${String(event.index)}`;
    const delta = event.delta;
    const deltaType = isRecord(delta) ? delta.type : undefined;
    const field =
      typeof deltaType === 'string'
        ? CLAUDE_DELTA_FIELDS[deltaType]
        : undefined;
    const text = isRecord(delta) && field ? delta[field] : undefined;
    if (
      event.type === 'content_block_delta' &&
      isRecord(delta) &&
      field &&
      typeof text === 'string'
    ) {
      const released = this.push(key, parent, field, text);
      const nextDelta =
        released === text ? delta : { ...delta, [field]: released };
      const candidate =
        nextDelta === delta
          ? data
          : { ...data, event: { ...event, delta: nextDelta } };
      const out = this.redactWhole(candidate, {
        target: nextDelta,
        keys: [field],
      });
      const stream = this.streams.get(key);
      if (stream && isRecord(out)) stream.template = out;
      events.push(out);
      return;
    }
    events.push(this.redactWhole(data));
  }

  private push(
    key: string,
    parent: string,
    field: string,
    text: string,
  ): string {
    let stream = this.streams.get(key);
    if (stream?.withheld) return '';
    let carried = '';
    if (stream && stream.version !== this.version) {
      if (stream.redactor.heldOverflowed) {
        // Its open match is too long to carry whole: it goes as its
        // placeholder, and the rest of the stream is withheld.
        const placeholder = stream.redactor.takeHeld();
        this.streams.set(key, {
          ...stream,
          redactor: new MergedSecretRedactor(this.groups),
          version: this.version,
          withheld: true,
        });
        return placeholder;
      }
      // The values changed: what the old redactor held goes through the new
      // one as it was pushed, unredacted, so a new value it overlaps still
      // matches whole.
      carried = stream.redactor.takeHeld();
      stream = undefined;
    }
    if (!stream) {
      stream = {
        kind: 'delta',
        redactor: new MergedSecretRedactor(this.groups),
        version: this.version,
        template: {},
        field,
        parent,
      };
      this.streams.set(key, stream);
    }
    return stream.redactor.push(carried + text);
  }

  /**
   * While the values can't be read: what each delta stream held is
   * dropped, and the stream, and one `data` starts, is withheld until its
   * boundary, which `data` may be.
   */
  private quarantine(data: unknown): void {
    for (const [key, stream] of [...this.streams]) {
      if (stream.kind !== 'delta') {
        this.streams.delete(key);
        continue;
      }
      stream.redactor.takeHeld();
      stream.withheld = true;
      delete stream.release;
    }
    const opened = deltaStreamOf(data);
    if (opened && !this.streams.has(opened.key))
      this.streams.set(opened.key, {
        kind: 'delta',
        redactor: new MergedSecretRedactor([]),
        version: '',
        template: {},
        field: '',
        parent: opened.parent,
        ...(opened.thread !== undefined ? { thread: opened.thread } : {}),
        withheld: true,
      });
    const ended = isRecord(data) ? endedStreams(data) : undefined;
    if (ended)
      for (const [key, stream] of [...this.streams])
        if (ended(stream, key)) this.streams.delete(key);
  }

  private flushWhere(match: StreamMatch, events: unknown[]): void {
    for (const [key, stream] of [...this.streams]) {
      if (!match(stream, key)) continue;
      this.streams.delete(key);
      // The values may have changed since the stream's redactor was built:
      // then its held text, as pushed, is redacted with the current ones.
      if (stream.withheld) continue;
      const rest =
        stream.version === this.version || !this.whole
          ? stream.redactor.flush()
          : this.whole.redact(stream.redactor.takeHeld());
      const flush = stream.release
        ? stream.release(rest)
        : rest && isRecord(stream.template.event)
          ? withDeltaText(stream.template, stream.field, rest)
          : undefined;
      if (!flush) continue;
      // A fresh id: the flush is a delta of its own, not a repeat.
      events.push(
        typeof flush.uuid === 'string'
          ? { ...flush, uuid: randomUUID() }
          : flush,
      );
    }
  }

  /**
   * A Codex plan delta carries the new piece (`delta`) and the whole plan so
   * far (`text`): the pieces stream through the item's redactor, and the
   * whole text is redacted with its tail held back, until the item
   * completes.
   */
  private applyCodexPlanDelta(
    data: Record<string, unknown>,
    event: Record<string, unknown>,
    events: unknown[],
  ): void {
    const stream = codexPlanStream(event.item_id);
    const delta =
      typeof event.delta === 'string'
        ? this.push(stream, stream, 'delta', event.delta)
        : event.delta;
    const text =
      typeof event.text === 'string'
        ? new MergedSecretRedactor(this.groups).push(event.text)
        : event.text;
    const next = { ...event, delta, text };
    events.push(
      this.redactWhole(
        { ...data, event: next },
        { target: next, keys: ['delta', 'text'] },
      ),
    );
    // A turn that ends without the plan's completed item (interrupted or
    // failed) releases the held tail as a last plan delta, its whole text
    // redacted with it.
    const plan = this.streams.get(stream);
    if (plan)
      plan.thread ??=
        typeof event.thread_id === 'string' ? event.thread_id : '';
    if (plan)
      plan.release = (rest: string): Record<string, unknown> | undefined => {
        if (!rest) return undefined;
        const last = {
          ...event,
          delta: rest,
          ...(typeof event.text === 'string'
            ? { text: this.whole?.redact(event.text) ?? '' }
            : {}),
        };
        const out = this.redactWhole(
          { ...data, event: last },
          { target: last, keys: ['delta', 'text'] },
        );
        return isRecord(out) ? out : undefined;
      };
  }

  private applyCodexItem(
    data: Record<string, unknown>,
    event: Record<string, unknown>,
    item: Record<string, unknown>,
    events: unknown[],
  ): void {
    const inProgress = event.type !== 'item.completed';
    // A completed item is redacted whole below: its streams are done.
    if (!inProgress) {
      this.streams.delete(codexPlanStream(item.id));
      this.streams.delete(codexItemStream(item.id));
    } else if (CODEX_CUMULATIVE_FIELDS.some((field) => item[field])) {
      // A turn that ends without the completed item (failed, interrupted)
      // releases the latest text whole, redacted, so its held tail isn't
      // lost.
      this.streams.set(codexItemStream(item.id), {
        kind: 'cumulative',
        redactor: new MergedSecretRedactor([]),
        version: this.version,
        template: {},
        field: '',
        parent: codexItemStream(item.id),
        thread: typeof event.thread_id === 'string' ? event.thread_id : '',
        release: (): Record<string, unknown> | undefined => {
          const whole = this.whole;
          if (!whole) return undefined;
          let last: Record<string, unknown> = item;
          for (const field of CODEX_CUMULATIVE_FIELDS) {
            const text = item[field];
            if (typeof text === 'string' && text)
              last = { ...last, [field]: whole.redact(text) };
          }
          const out = this.redactWhole(
            { ...data, event: { ...event, item: last } },
            { target: last, keys: CODEX_CUMULATIVE_FIELDS },
          );
          return isRecord(out) ? out : undefined;
        },
      });
    }
    let next: Record<string, unknown> = item;
    for (const field of CODEX_CUMULATIVE_FIELDS) {
      const text = item[field];
      if (typeof text !== 'string' || !text) continue;
      // The whole text so far: a fresh redactor holds back its tail while the
      // item is in progress, since the next update may complete a value.
      const redactor = new MergedSecretRedactor(this.groups);
      const redacted = inProgress ? redactor.push(text) : redactor.redact(text);
      if (redacted !== text) next = { ...next, [field]: redacted };
    }
    const candidate =
      next === item ? data : { ...data, event: { ...event, item: next } };
    events.push(
      this.redactWhole(candidate, {
        target: next,
        keys: CODEX_CUMULATIVE_FIELDS,
      }),
    );
  }

  /**
   * A delegation event redacted whole. Its typed protocol numbers
   * (sequences, times, depths, usage counters) keep their numbers when a
   * value matched one; no other number does. A placeholder can
   * be longer than the text it replaces, so a bounded field (a task
   * description, say) can end up past the protocol's limit: it is cut back,
   * never inside a marker. One still invalid (an id that is wholly a value)
   * goes on as its refused projection, redacted; `undefined` when even that
   * isn't valid, and the event is dropped.
   */
  private redactDelegation(data: Record<string, unknown>): unknown {
    const valid = (event: unknown): boolean =>
      isRecord(event) && isAgentDelegationTranscript(event.delegation);
    const out = this.redactWhole(data);
    if (!isAgentDelegationTranscript(data.delegation) || valid(out)) return out;
    if (!isRecord(out)) return undefined;
    const clamped = {
      ...out,
      delegation: clampDelegation(
        withProtocolNumbers(data.delegation, out.delegation),
      ),
    };
    if (valid(clamped)) return clamped;
    const refused = this.redactWhole(refusedProjection(data));
    const restored = isRecord(refused)
      ? {
          ...refused,
          delegation: withProtocolNumbers(data.delegation, refused.delegation),
        }
      : undefined;
    return valid(restored) ? restored : undefined;
  }

  /** `value` with every string redacted whole; unchanged parts kept as is. */
  private redactWhole(value: unknown, skip?: Skip): unknown {
    const redactor = this.whole;
    if (!redactor) return value;
    return redactDeep(
      value,
      {
        redactString: (text) => redactor.redact(text),
        wholeForm: (text) => {
          const name = this.wholeForms.get(text);
          return name === undefined
            ? null
            : agentSecretRedactionPlaceholder(name);
        },
        skip,
      },
      false,
      0,
    );
  }
}

function withDeltaText(
  template: Record<string, unknown>,
  field: string,
  text: string,
): Record<string, unknown> {
  const event = isRecord(template.event) ? template.event : {};
  const delta = isRecord(event.delta) ? event.delta : {};
  return {
    ...template,
    event: { ...event, delta: { ...delta, [field]: text } },
  };
}

/** How deep a redaction pass goes; deeper subtrees are dropped. */
const REDACT_MAX_DEPTH = 64;

interface DeepOptions {
  redactString: (text: string) => string;
  wholeForm: (text: string) => string | null;
  skip: Skip | undefined;
}

function redactDeep(
  value: unknown,
  options: DeepOptions,
  inPayload: boolean,
  depth: number,
): unknown {
  if (typeof value === 'string') return options.redactString(value);
  if (typeof value === 'number' || typeof value === 'bigint') {
    // A value that is a number (a PIN, a port) is matched by its string
    // form: inside a tool's payload wherever it occurs, elsewhere only when
    // the number is wholly the value, so counts and sizes stay numbers.
    const text = String(value);
    const redacted = inPayload
      ? options.redactString(text)
      : options.wholeForm(text);
    return redacted !== null && redacted !== text ? redacted : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  // Past this depth nothing is redacted, so the subtree is dropped.
  if (depth > REDACT_MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item: unknown) => {
      const next = redactDeep(item, options, inPayload, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (!isPlainObject(value)) return value;
  const skipped = options.skip?.target === value ? options.skip.keys : [];
  let changed = false;
  const result: Record<string, unknown> = {};
  const names = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    // A tool's payload can use a value as a property name: it is redacted
    // like any text, and a name it then shares gets a numbered suffix.
    let name = inPayload ? options.redactString(key) : key;
    if (name !== key) {
      changed = true;
      for (let index = 2; names.has(name); index++) name = `${name}#${index}`;
    }
    let next: unknown;
    if (skipped.includes(key)) next = item;
    else if (
      !inPayload &&
      isProtocolKey(key) &&
      typeof item === 'string' &&
      PROTOCOL_TOKEN.test(item)
    )
      // Kept unless wholly a value, like an id.
      next = options.wholeForm(item) ?? item;
    else if (!inPayload && ID_KEY.test(key) && typeof item === 'string')
      next = options.wholeForm(item) ?? item;
    else if (!inPayload && ID_LIST_KEY.test(key) && isStringList(item)) {
      const ids = item.map((id) => options.wholeForm(id) ?? id);
      next = ids.some((id, index) => id !== item[index]) ? ids : item;
    } else
      next = redactDeep(
        item,
        options,
        inPayload || PAYLOAD_KEYS.has(key),
        depth + 1,
      );
    if (next !== item) changed = true;
    names.add(name);
    result[name] = next;
  }
  return changed ? result : value;
}

/** The stream key of a Codex plan item's deltas. */
function codexPlanStream(itemId: unknown): string {
  return `codex-plan\0${typeof itemId === 'string' ? itemId : ''}`;
}

type StreamMatch = (stream: Stream, key: string) => boolean;

/**
 * The streams an event ends, flushing their held text first: the only
 * events that do are a content block's stop (its stream), a conversation's
 * message stop or whole message (that conversation's streams), and the
 * turn's end (the root conversation's streams: a background child keeps
 * streaming after it, and ends at its own message's end). Every other event, `message_start`,
 * `tool_progress` and system events included, passes without ending any:
 * releasing held text while its stream goes on would release the start of
 * a value its next delta completes. A Codex plan's stream ends with its
 * item, which is then redacted whole.
 */
function endedStreams(data: Record<string, unknown>): StreamMatch | undefined {
  const parent =
    typeof data.parent_tool_use_id === 'string' ? data.parent_tool_use_id : '';
  if (data.type === 'stream_event' && isRecord(data.event)) {
    const event = data.event;
    if (event.type === 'content_block_stop') {
      const key = `${parent}\0${String(event.index)}`;
      return (_stream, streamKey) => streamKey === key;
    }
    if (event.type === 'message_stop')
      return (stream) => stream.parent === parent;
    return undefined;
  }
  if (
    (data.type === 'assistant' || data.type === 'user') &&
    'parent_tool_use_id' in data
  )
    return (stream) => stream.parent === parent;
  // A task notification's result while a foreground turn runs ends nothing:
  // its streams go on.
  // A turn's result ends the root conversation's streams (and a Codex
  // stream that named no thread); a Claude child's go on to their own end.
  if (data.type === 'result')
    return data.canopy_session_continues === true
      ? undefined
      : (stream) =>
          stream.thread === undefined
            ? stream.parent === ''
            : stream.thread === '';
  if (
    data.type === 'codex' &&
    isRecord(data.event) &&
    (data.event.type === 'turn.completed' ||
      data.event.type === 'turn.failed' ||
      data.event.type === 'turn.cancelled')
  ) {
    // A thread's turn ends its own plan streams: a subagent's turn ending
    // on its thread leaves the root's open. One that names no thread ends
    // every stream.
    const thread = data.event.thread_id;
    return typeof thread === 'string' && thread
      ? (stream) => stream.thread === thread
      : () => true;
  }
  return undefined;
}

/**
 * The typed protocol numbers of a delegation: sequences, times, depths,
 * positions and usage counters. A number a value matched there keeps its
 * number; any other number stays redacted.
 */
const DELEGATION_NUMBERS = {
  transcript: ['runGeneration', 'sequence', 'createdAt'],
  snapshot: ['depth', 'runGeneration', 'resultIndex'],
  usage: [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'costUsd',
  ],
  queue: ['position', 'running', 'waiting', 'limit'],
  item: ['sequence', 'occurredAt'],
  author: ['depth'],
} as const;

/** `into` with each of `keys` that is a number in `from` set back to it. */
function keepNumbers(
  from: unknown,
  into: unknown,
  keys: readonly string[],
): unknown {
  if (!isRecord(from) || !isRecord(into)) return into;
  const out: Record<string, unknown> = { ...into };
  for (const key of keys)
    if (typeof from[key] === 'number' && key in out) out[key] = from[key];
  return out;
}

/**
 * A redacted delegation with its typed protocol numbers
 * ({@link DELEGATION_NUMBERS}) back from `original`.
 */
function withProtocolNumbers(original: unknown, redacted: unknown): unknown {
  if (!isRecord(original) || !isRecord(redacted)) return redacted;
  const out = keepNumbers(original, redacted, DELEGATION_NUMBERS.transcript);
  if (!isRecord(out)) return out;
  const before = original.snapshot;
  if (isRecord(before) && isRecord(out.snapshot)) {
    const snapshot = keepNumbers(
      before,
      out.snapshot,
      DELEGATION_NUMBERS.snapshot,
    );
    if (isRecord(snapshot)) {
      for (const [field, keys] of [
        ['usage', DELEGATION_NUMBERS.usage],
        ['queue', DELEGATION_NUMBERS.queue],
        ['stoppedBy', DELEGATION_NUMBERS.author],
      ] as const)
        if (field in snapshot)
          snapshot[field] = keepNumbers(before[field], snapshot[field], keys);
      out.snapshot = snapshot;
    }
  }
  const items = original.transcript;
  if (Array.isArray(items) && Array.isArray(out.transcript))
    out.transcript = out.transcript.map((item: unknown, index: number) => {
      const kept = keepNumbers(items[index], item, DELEGATION_NUMBERS.item);
      const author: unknown = isRecord(items[index])
        ? items[index].author
        : undefined;
      return isRecord(kept) && 'author' in kept
        ? {
            ...kept,
            author: keepNumbers(author, kept.author, DELEGATION_NUMBERS.author),
          }
        : kept;
    });
  return out;
}

/** Protocol limits on a delegation's free-text fields, in characters. */
const DELEGATION_TEXT_LIMITS = {
  description: 200,
  prompt: 32768,
  parentDescription: 200,
  errorMessage: 4096,
  commandError: 512,
} as const;

/** `text` cut to `limit`, never inside a `[secret:NAME]` marker. */
function cutToLimit(text: unknown, limit: number): unknown {
  if (typeof text !== 'string' || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const open = cut.lastIndexOf('[secret:');
  return open !== -1 && !cut.slice(open).includes(']')
    ? cut.slice(0, open)
    : cut;
}

/** A redacted delegation with its bounded text fields back within limits. */
function clampDelegation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const task = isRecord(value.task)
    ? {
        ...value.task,
        description: cutToLimit(
          value.task.description,
          DELEGATION_TEXT_LIMITS.description,
        ),
        prompt: cutToLimit(value.task.prompt, DELEGATION_TEXT_LIMITS.prompt),
      }
    : value.task;
  if (!isRecord(value.snapshot)) return { ...value, task };
  const snapshot: Record<string, unknown> = { ...value.snapshot };
  if ('parentDescription' in snapshot)
    snapshot.parentDescription = cutToLimit(
      snapshot.parentDescription,
      DELEGATION_TEXT_LIMITS.parentDescription,
    );
  if (isRecord(snapshot.error))
    snapshot.error = {
      ...snapshot.error,
      message: cutToLimit(
        snapshot.error.message,
        DELEGATION_TEXT_LIMITS.errorMessage,
      ),
    };
  if (isRecord(snapshot.stoppedBy) && 'description' in snapshot.stoppedBy)
    snapshot.stoppedBy = {
      ...snapshot.stoppedBy,
      description: cutToLimit(
        snapshot.stoppedBy.description,
        DELEGATION_TEXT_LIMITS.description,
      ),
    };
  for (const field of ['control', 'stopRequested'] as const) {
    const command = snapshot[field];
    if (isRecord(command) && 'error' in command)
      snapshot[field] = {
        ...command,
        error: cutToLimit(command.error, DELEGATION_TEXT_LIMITS.commandError),
      };
  }
  return { ...value, task, snapshot };
}
