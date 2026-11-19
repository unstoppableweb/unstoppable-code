import { randomUUID } from 'node:crypto';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { PersistedChatBlock } from '../../types';
import { OverlapMatcher } from '@canopy/execution-engine/lib/overlap-matcher';
import {
  normalizeSingleLine,
  redactNormalizedPreservingFormat,
  redactStructuredValue,
  withJsonEscapedVariants,
} from '@canopy/execution-engine/lib/redaction';
import { cursorToolDisplay, cursorToolOutputIsError } from './tool-display';

// Edit completions can include both full file snapshots. Leave room for
// several edits admitted by the 8 MiB hook without retaining unlimited output.
const MAX_TURN_BYTES = 64 * 1024 * 1024;
const MAX_NON_TOOL_BYTES = 8 * 1024 * 1024;

// Compatibility with the pinned CLI's ACP processPrompt catch handler. It
// emits one complete text notification, then reports end_turn even on failure.
// Match only its terminal error envelope, never arbitrary transcript/tool text.
// There is no structured error discriminator on this notification in this CLI;
// an identical terminal model-generated chunk is inherently indistinguishable.
const TERMINAL_ERROR =
  /^\n\nError: (?:RetriableError|NonRetriableError|ConnectError): \[(resource_exhausted|unavailable|deadline_exceeded|internal|unauthenticated|permission_denied)\] [^\r\n]+$/;

/** The account change Cursor asked for when it refused a turn. */
export type CursorTerminalAction = 'login' | 'upgrade' | 'payment' | 'config';

/** Host-only invocation identity; never included in persisted transcript data. */
export interface CursorToolInvocation {
  toolUseId: string;
  title: string;
  rawInput: unknown;
  kind?: string;
  status?: string;
}

// The same handler reports the backend's ActionRequiredError as one of these
// fixed sentences, dropping the backend's own title and detail, and the
// original error never reaches ACP. Only the complete chunk matches.
const TERMINAL_ACTIONS = new Map<string, CursorTerminalAction>([
  ['\n\nPlease sign in to continue', 'login'],
  ['\n\nUpgrade your plan to continue', 'upgrade'],
  ['\n\nAdd a payment method to continue', 'payment'],
  ['\n\nCheck your settings to continue', 'config'],
]);

const TERMINAL_ACTION_MESSAGES: Record<CursorTerminalAction, string> = {
  login: 'Reconnect Cursor in Settings and try again.',
  upgrade:
    "Your Cursor plan doesn't include this request. Upgrade your plan or choose another model.",
  payment: 'Add a payment method to your Cursor account, then try again.',
  config:
    "Your Cursor account settings don't allow this request. Check them in your Cursor dashboard, then try again, or choose another model.",
};

interface AssistantMessage {
  id: string;
  timestamp: number;
  kind: 'response' | 'activity' | 'notice';
  blocks: PersistedChatBlock[];
  /** `${type}:${toolUseId}` → block index within this message. */
  toolBlockIndex: Map<string, number>;
}

/** A text block text is released into. */
interface BlockRef {
  message: AssistantMessage;
  index: number;
}

/** Whether two references name the same block. */
function sameBlock(left: BlockRef, right: BlockRef): boolean {
  return left.message === right.message && left.index === right.index;
}

/** Text released for one block, in release order. */
interface Released {
  target: BlockRef;
  text: string;
}

/**
 * The model's response or thought text as one continuous stream, masked across
 * every block it was split into.
 *
 * A value can straddle a tool call, a host notice or the other kind of text:
 * each side is its own block, so masking each block alone leaves both halves
 * in the transcript. The stream keeps matching across those gaps instead.
 * Every character still held remembers the block it came from, so released
 * text returns to its own block, and a mask lands in the block where the value
 * began. Retention stays under one value length of matched characters; a
 * held whitespace run counts as one.
 */
interface TextStream {
  matcher: OverlapMatcher;
  /**
   * Where each character the matcher holds came from. A collapsed whitespace
   * run is one matcher character but can span blocks, so it keeps a piece per
   * block.
   */
  held: Released[][];
  heldHead: number;
  /** True while the last character pushed is a whitespace run's space. */
  inSpace: boolean;
  /**
   * The current run's own exact matcher, when a configured value is only
   * whitespace. Its normalized form is empty and can never be matched, so the
   * run's raw characters are masked here and ride on its one matched space.
   */
  run?: { matcher: OverlapMatcher; targets: BlockRef[]; head: number };
  released: Released[];
}

/** Separate response and activity rows; only changed blocks cross IPC/JSONL. */
/** The interactive wording; headless steps supply their own. */
export const CURSOR_CHAT_LIMIT_MESSAGE =
  'Cursor response exceeded the local chat limit.';

/** The projection refused a turn past its bound; the message is the surface's copy. */
export class CursorProjectionLimitError extends Error {}

/**
 * Bounds one turn's projection at 8 MiB of notification JSON or 4,096 blocks,
 * because every block is held in memory until the turn ends. The bound is the
 * same for chat and pipeline steps; only the message differs by surface.
 */
export class CursorEventProjection {
  /**
   * Configured values to mask, eligible by their own length. Empty for
   * interactive chat, where nothing is configured and every delta and tool
   * value passes through exactly as received.
   */
  private readonly secretValues: readonly string[];
  /**
   * What streamed text is matched against: each value's whitespace-normalized
   * form, longest first. The stream collapses every whitespace run to one
   * space as it matches, so a value echoed with its spacing reflowed is still
   * found, while the text it releases keeps its original layout. A normalized
   * form may be shorter than six characters: the value it came from already
   * qualified.
   */
  private readonly streamValues: readonly string[];
  /** Configured values that are only whitespace, matched exactly in runs. */
  private readonly runValues: readonly string[];

  constructor(
    private readonly limitMessage = CURSOR_CHAT_LIMIT_MESSAGE,
    private readonly options: {
      secretValues?: readonly string[];
      onToolInvocation?: (invocation: CursorToolInvocation) => void;
      toolDisplay?: typeof cursorToolDisplay;
      recognizeCursorErrors?: boolean;
    } = {},
  ) {
    this.onToolInvocation = options.onToolInvocation;
    // The same eligibility the transcript masking applies to each record:
    // values under six characters are too likely to collide with prose.
    this.secretValues = Array.from(
      new Set(
        (options.secretValues ?? []).filter((value) => value.length >= 6),
      ),
    );
    this.streamValues = Array.from(
      new Set(
        withJsonEscapedVariants(this.secretValues)
          .map((value) => normalizeSingleLine(value))
          .filter((value) => value.length > 0),
      ),
    ).sort((left, right) => right.length - left.length);
    this.runValues = this.secretValues
      .filter((value) => normalizeSingleLine(value).length === 0)
      .sort((left, right) => right.length - left.length);
  }

  /** Response and thought text are masked as separate streams. */
  private readonly streams = new Map<'text' | 'thinking', TextStream>();
  private readonly onToolInvocation?: (
    invocation: CursorToolInvocation,
  ) => void;
  /** Released text of earlier messages, for the caller to emit first. */
  private readonly flushed: Record<string, unknown>[] = [];

  private currentMessage: AssistantMessage | undefined;
  private readonly toolMessages = new Map<
    string,
    { message: AssistantMessage; toolUseId: string }
  >();
  private blockCount = 0;
  // Raw provider facts are used by approval correlation, never display values.
  private readonly tools = new Map<
    string,
    { name: string; input: unknown; kind?: string }
  >();
  private revision = 0;
  private bytes = 0;
  private nonToolBytes = 0;
  private terminalError:
    | { message: string; action?: CursorTerminalAction }
    | undefined;
  private responseText = '';
  /** Response text since the last tool call or plan opened a block. */
  private finalResponseText = '';
  /** The turn's one plan list, updated in place by each ACP `plan` update. */
  private plan: { message: AssistantMessage; toolUseId: string } | undefined;
  /** The session mode last confirmed or reported; announced only on change. */
  private mode: string | undefined;
  /**
   * Counts one NEW block against the limit, refusing the one that would pass
   * it.
   *
   * The count used to be compared once on entry, before the update added its
   * block, so the 4,097th distinct block was admitted. Checking where a block
   * is actually added also keeps an update that adds none - a completion for a
   * tool whose blocks already exist - working at capacity, which a blanket
   * pre-update guard would have rejected.
   */
  private admitBlock(): void {
    if (this.blockCount >= 4096)
      throw new CursorProjectionLimitError(this.limitMessage);
    this.blockCount += 1;
  }

  private admitBytes(bytes: number, tool = false): void {
    this.bytes += bytes;
    if (!tool) this.nonToolBytes += bytes;
    if (this.bytes > MAX_TURN_BYTES || this.nonToolBytes > MAX_NON_TOOL_BYTES)
      throw new CursorProjectionLimitError(this.limitMessage);
  }

  update(
    notification: SessionNotification,
  ): Record<string, unknown> | undefined {
    const update = notification.update;
    this.admitBytes(
      Buffer.byteLength(JSON.stringify(update)),
      update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update',
    );
    let message: AssistantMessage;
    const patches: {
      index: number;
      block?: PersistedChatBlock;
      appendText?: string;
    }[] = [];
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      this.terminalError = undefined;
      if (update.content.type !== 'text') return undefined;
      if (
        this.options.recognizeCursorErrors !== false &&
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.text.length <= 4096
      ) {
        const code = TERMINAL_ERROR.exec(update.content.text)?.[1];
        const action = TERMINAL_ACTIONS.get(update.content.text);
        if (code) {
          const recovery =
            code === 'unauthenticated'
              ? 'Reconnect Cursor in Settings and try again.'
              : 'Try again shortly.';
          this.terminalError = {
            message: `Cursor could not complete the request (${code}). ${recovery}`,
          };
        } else if (action) {
          this.terminalError = {
            message: TERMINAL_ACTION_MESSAGES[action],
            action,
          };
        }
      }
      const type =
        update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking';
      message = this.messageFor(type === 'text' ? 'response' : 'activity');
      const lastIndex = message.blocks.length - 1;
      const last = message.blocks[lastIndex];
      const opens = last?.type !== type;
      const block: PersistedChatBlock = { type, text: update.content.text };
      if (opens) {
        this.admitBlock();
        message.blocks.push(block);
      }
      const target = {
        message,
        index: opens ? message.blocks.length - 1 : lastIndex,
      };
      let text = '';
      for (const released of this.maskStreamed(
        type,
        target,
        update.content.text,
      )) {
        if (sameBlock(released.target, target)) text += released.text;
        else if (released.target.message === message)
          // An earlier block of this message, still ahead of this one.
          patches.push({
            index: released.target.index,
            appendText: released.text,
          });
        else this.flush([released]);
      }
      // The renderer owns accumulated text; the host only needs its block
      // type. The stored block keeps what the provider sent; only what leaves
      // this projection is masked.
      patches.push(
        opens
          ? {
              index: target.index,
              block: text === update.content.text ? block : { type, text },
            }
          : { index: target.index, appendText: text },
      );
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.responseText += update.content.text;
        this.finalResponseText += update.content.text;
      }
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.terminalError = undefined;
      if (update.sessionUpdate === 'tool_call') this.finalResponseText = '';
      const previous = this.tools.get(update.toolCallId);
      const name = update.title ?? previous?.name ?? 'Cursor tool';
      const input = update.rawInput ?? previous?.input ?? {};
      const tool = {
        name,
        input,
        kind: update.kind ?? previous?.kind,
      };
      this.tools.set(update.toolCallId, tool);
      const display = (this.options.toolDisplay ?? cursorToolDisplay)(tool);
      // Each tool_call starts an invocation, even when Cursor reuses an ACP
      // ID (Read then Write). Partial updates target the current invocation;
      // distinct IDs also prevent cross-turn result-map collisions on replay.
      let invocation =
        update.sessionUpdate === 'tool_call_update'
          ? this.toolMessages.get(update.toolCallId)
          : undefined;
      if (!invocation) {
        invocation = {
          message: this.messageFor('activity'),
          toolUseId: randomUUID(),
        };
        this.toolMessages.set(update.toolCallId, invocation);
      }
      // Late completions of other tools never interrupt a streaming answer.
      message = invocation.message;
      const toolUseId = invocation.toolUseId;
      const upsert = (
        block: PersistedChatBlock,
        type: 'tool_use' | 'tool_result',
      ): void => {
        const key = `${type}:${toolUseId}`;
        const index = message.toolBlockIndex.get(key) ?? message.blocks.length;
        if (index === message.blocks.length) this.admitBlock();
        message.toolBlockIndex.set(key, index);
        message.blocks[index] = block;
        patches.push({ index, block });
      };
      // Tool values leave as JSON strings nested in the record, which the
      // step's record masking decodes only once: a value with a newline, quote
      // or backslash is still escaped there and never matches. They are masked
      // here, before that inner serialization. `tools` keeps the raw input.
      upsert(
        {
          type: 'tool_use',
          toolUseId,
          toolName: name,
          input: JSON.stringify(this.maskToolValue(input)),
          display: {
            toolName: display.name,
            input: JSON.stringify(this.maskToolValue(display.input)),
          },
        },
        'tool_use',
      );
      if (update.status === 'completed' || update.status === 'failed') {
        upsert(
          {
            type: 'tool_result',
            toolUseId,
            toolName: name,
            output: JSON.stringify(
              this.maskToolValue(update.rawOutput ?? update.content ?? []),
            ),
            isError:
              update.status === 'failed' ||
              cursorToolOutputIsError(update.rawOutput),
          },
          'tool_result',
        );
      }
      this.onToolInvocation?.({
        toolUseId,
        title: name,
        rawInput: input,
        kind: tool.kind,
        status: update.status ?? undefined,
      });
    } else if (update.sessionUpdate === 'plan') {
      this.terminalError = undefined;
      // A malformed or blank entry is skipped rather than failing the turn.
      const entries = update.entries.filter(
        (entry) =>
          typeof entry.content === 'string' && entry.content.trim().length > 0,
      );
      // Only a plan with entries supersedes the reply before it; an empty
      // one must not erase a plan the agent wrote as text.
      if (entries.length > 0) this.finalResponseText = '';
      // Each plan replaces the last, so the turn keeps one TodoWrite-style
      // list and updates it in place.
      this.plan ??= {
        message: this.messageFor('activity'),
        toolUseId: randomUUID(),
      };
      message = this.plan.message;
      const input = JSON.stringify(
        this.maskToolValue({
          todos: entries.map((entry) => ({
            content: entry.content,
            activeForm: entry.content,
            status: entry.status,
          })),
        }),
      );
      const blocks: PersistedChatBlock[] = [
        {
          type: 'tool_use',
          toolUseId: this.plan.toolUseId,
          toolName: 'TodoWrite',
          input,
        },
        {
          type: 'tool_result',
          toolUseId: this.plan.toolUseId,
          toolName: 'TodoWrite',
          output: '',
          isError: false,
        },
      ];
      for (const block of blocks) {
        const key: string = `${block.type}:${this.plan.toolUseId}`;
        const index = message.toolBlockIndex.get(key) ?? message.blocks.length;
        if (index === message.blocks.length) this.admitBlock();
        message.toolBlockIndex.set(key, index);
        message.blocks[index] = block;
        patches.push({ index, block });
      }
    } else if (update.sessionUpdate === 'current_mode_update') {
      const previous = this.mode;
      this.mode = update.currentModeId;
      return previous === undefined || previous === update.currentModeId
        ? undefined
        : this.notice(`Switched to ${update.currentModeId} mode.`);
    } else return undefined;
    this.revision += 1;
    return {
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: message.id,
      timestamp: message.timestamp,
      revision: this.revision,
      patches,
    };
  }

  /**
   * Records the mode the host applied, without a notice, so only a later
   * change reported by `current_mode_update` is announced.
   */
  observeMode(modeId: string): void {
    this.mode = modeId;
  }

  /** Host-authored guidance must never merge into collapsible model commentary. */
  notice(text: string): Record<string, unknown> {
    this.admitBytes(Buffer.byteLength(text));
    this.admitBlock();
    this.currentMessage = undefined;
    const message = this.messageFor('notice');
    const block: PersistedChatBlock = { type: 'text', text };
    message.blocks.push(block);
    return {
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      role: 'system',
      messageId: message.id,
      timestamp: message.timestamp,
      revision: ++this.revision,
      patches: [{ index: 0, block }],
    };
  }

  /**
   * Events carrying held-back text released into an earlier message during
   * the last `update`. The caller emits these BEFORE that call's own event, so
   * text always precedes anything that followed it in its own stream.
   */
  takeFlushed(): Record<string, unknown>[] {
    return this.flushed.splice(0, this.flushed.length);
  }

  /**
   * Releases whatever the streams still hold. Call once the turn has ended,
   * however it ended: held text is the provider's output and is never
   * dropped, and a value it completes is masked.
   */
  finish(): Record<string, unknown>[] {
    this.streams.forEach((stream) => {
      this.closeRun(stream);
      stream.matcher.end();
      this.flush(stream.released.splice(0, stream.released.length));
    });
    this.streams.clear();
    return this.takeFlushed();
  }

  /** Masks one delta of `kind` text, returning what it released and where. */
  private maskStreamed(
    kind: 'text' | 'thinking',
    target: BlockRef,
    text: string,
  ): Released[] {
    if (this.streamValues.length === 0 && this.runValues.length === 0)
      return [{ target, text }];
    let stream = this.streams.get(kind);
    if (!stream) {
      const opened: TextStream = {
        held: [],
        heldHead: 0,
        inSpace: false,
        released: [],
        matcher: new OverlapMatcher(
          this.streamValues,
          (piece, consumed) => {
            if (consumed === 0) {
              // The mask for a match that starts at the oldest held
              // character: it belongs to that character's block.
              const first = opened.held[opened.heldHead]?.[0];
              if (first) this.release(opened, first.target, piece);
              return;
            }
            for (const pieces of this.takeHeld(opened, consumed))
              for (const one of pieces)
                this.release(opened, one.target, one.text);
          },
          undefined,
          (consumed) => {
            this.takeHeld(opened, consumed);
          },
        ),
      };
      stream = opened;
      this.streams.set(kind, opened);
    }
    for (let unit = 0; unit < text.length; unit += 1) {
      const character = text.charAt(unit);
      if (/\s/.test(character)) {
        if (!stream.inSpace) {
          // A run is one matched space; its characters follow onto it.
          stream.inSpace = true;
          stream.held.push([{ target, text: '' }]);
          stream.matcher.push(' ', '');
          if (this.runValues.length > 0) stream.run = this.openRun(stream);
        }
        const run = stream.run;
        if (run) {
          run.targets.push(target);
          run.matcher.push(character, character);
        } else this.extendRun(stream, target, character);
        continue;
      }
      this.closeRun(stream);
      stream.inSpace = false;
      stream.held.push([{ target, text: character }]);
      stream.matcher.push(character, character);
    }
    return stream.released.splice(0, stream.released.length);
  }

  /**
   * Adds run text to the run's matched space, or sends it straight out once
   * that space has been released: everything before it has gone too.
   */
  private extendRun(stream: TextStream, target: BlockRef, text: string): void {
    if (!stream.matcher.extendLast(text)) {
      this.release(stream, target, text);
      return;
    }
    const pieces = stream.held[stream.held.length - 1] ?? [];
    const last = pieces[pieces.length - 1];
    if (last && sameBlock(last.target, target)) last.text += text;
    else pieces.push({ target, text });
  }

  /** An exact matcher for one whitespace run's raw characters. */
  private openRun(stream: TextStream): NonNullable<TextStream['run']> {
    const run: NonNullable<TextStream['run']> = {
      targets: [],
      head: 0,
      matcher: new OverlapMatcher(
        this.runValues,
        (piece, consumed) => {
          if (consumed === 0) {
            const target = run.targets[run.head];
            if (target) this.extendRun(stream, target, piece);
            return;
          }
          // Each raw run character is one pushed character.
          for (let at = 0; at < consumed; at += 1) {
            const target = run.targets[run.head];
            run.head += 1;
            if (target) this.extendRun(stream, target, piece.charAt(at));
          }
        },
        undefined,
        (consumed) => {
          run.head += consumed;
        },
      ),
    };
    return run;
  }

  /** Ends the current whitespace run, releasing what its matcher held. */
  private closeRun(stream: TextStream): void {
    const run = stream.run;
    if (!run) return;
    stream.run = undefined;
    run.matcher.end();
  }

  /** The source pieces of the oldest `count` held characters. */
  private takeHeld(stream: TextStream, count: number): Released[][] {
    const taken = stream.held.slice(stream.heldHead, stream.heldHead + count);
    stream.heldHead += count;
    if (stream.heldHead >= 4096 && stream.heldHead * 2 >= stream.held.length) {
      stream.held = stream.held.slice(stream.heldHead);
      stream.heldHead = 0;
    }
    return taken;
  }

  private release(stream: TextStream, target: BlockRef, text: string): void {
    const last = stream.released[stream.released.length - 1];
    if (last && sameBlock(last.target, target)) last.text += text;
    else stream.released.push({ target, text });
  }

  /** Queues released text as events of its own messages, in order. */
  private flush(released: readonly Released[]): void {
    for (const { target, text } of released) {
      if (text.length === 0) continue;
      const previous = this.flushed[this.flushed.length - 1];
      const patch = { index: target.index, appendText: text };
      if (
        previous?.messageId === target.message.id &&
        Array.isArray(previous.patches)
      )
        previous.patches.push(patch);
      else
        this.flushed.push({
          type: 'canopy_assistant_patch',
          provider: 'cursor',
          messageId: target.message.id,
          timestamp: target.message.timestamp,
          revision: ++this.revision,
          patches: [patch],
        });
    }
  }

  /**
   * A tool value with every configured value masked, structure and layout
   * kept: exact matches in keys, strings and numbers, then reflowed matches
   * inside strings, as the step masks its other outputs.
   */
  private maskToolValue(value: unknown): unknown {
    if (this.secretValues.length === 0) return value;
    const reflowed = (node: unknown): unknown => {
      if (typeof node === 'string')
        return redactNormalizedPreservingFormat(node, this.secretValues);
      if (Array.isArray(node)) return node.map(reflowed);
      if (node !== null && typeof node === 'object')
        return Object.fromEntries(
          Object.entries(node).map(([key, entry]) => [key, reflowed(entry)]),
        );
      return node;
    };
    return reflowed(redactStructuredValue(value, this.secretValues));
  }

  private messageFor(kind: AssistantMessage['kind']): AssistantMessage {
    if (this.currentMessage?.kind !== kind) {
      this.currentMessage = {
        id: randomUUID(),
        timestamp: Date.now(),
        kind,
        blocks: [],
        toolBlockIndex: new Map(),
      };
    }
    return this.currentMessage;
  }

  getTool(
    id: string,
  ): { name: string; input: unknown; kind?: string } | undefined {
    return this.tools.get(id);
  }

  /** Read only after prompt completion; later agent/tool output clears it. */
  getTerminalError(): string | undefined {
    return this.terminalError?.message;
  }

  /** Set only alongside a terminal error that is an account action notice. */
  getTerminalAction(): CursorTerminalAction | undefined {
    return this.terminalError?.action;
  }

  /**
   * Concatenated assistant response text; thoughts and notices are excluded.
   * Raw, as the provider sent it: configured values are NOT masked here, so a
   * caller that configures them must redact whatever it derives from this (the
   * step runner masks `text_response` and its files).
   */
  getResponseText(): string {
    return this.responseText;
  }

  /**
   * The response text after the turn's last tool call or plan update: the
   * agent's final answer, without the commentary that preceded its tools.
   */
  getFinalResponseText(): string {
    return this.finalResponseText;
  }
}
