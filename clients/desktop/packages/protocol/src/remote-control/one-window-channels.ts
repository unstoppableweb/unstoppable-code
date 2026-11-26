import { isHostedId } from './hosted-channels';
import {
  DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
  DESKTOP_ONE_WINDOW_MODE,
  type HelloParams,
  type HelloResult,
  type RemoteVersion,
} from './session';

/**
 * The reviewed channels a desktop controller in one-window mode may use
 * (CAN-7758): the main window of one computer showing the tasks and chats of
 * several paired computers, which update at different times. Such a
 * controller is admitted from a version floor instead of an exact protocol
 * match (`DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION`), so the host serves it
 * these channels and nothing else: invokes, sends, push forwarding and bridge
 * replay. The separate window per computer keeps the exact match and every
 * `tunnel` channel. See docs/remote-control-protocol.md, "One-window desktop
 * controllers".
 *
 * The list is a security boundary: once the separate window is removed
 * (CAN-7792) it is everything another desktop can reach on this computer.
 * Each group is a capability the host announces in
 * `HelloResult.features.oneWindow.capabilities`, so a controller can switch a
 * feature off for a computer that lacks it. The rules:
 *
 * - A channel joins in its own reviewed change, under a new capability when
 *   the feature it serves is new, so an older host simply does not announce
 *   it. Never move a channel between capabilities.
 * - A channel that changes anything joins only with an exact allowlist of the
 *   fields it may carry, checked on the host before replay.
 * - A channel leaves only when the floor is raised past every host that
 *   serves it, with the reason beside the floor.
 * - New features go to core operations with per-operation versions, not
 *   here, once the core route exists for them.
 *
 * The `sidebar`, `chats`, `composer` and `approvals` capabilities are
 * read-only: what the desktop chat backend (`stores/chat/backend.ts`) and the
 * sidebar read and follow (CAN-7758). The `send` capability changes
 * things, and every call in it carries only the
 * fields of its allowlist (`ONE_WINDOW_REQUEST_FIELDS`,
 * `ONE_WINDOW_CHAT_COMMAND_FIELDS`; CAN-7854); a call that changes anything
 * and has no allowlist is refused. Comments name the backend member each
 * channel serves.
 */
export const ONE_WINDOW_CAPABILITY_CHANNELS = {
  /** The sidebar's projects, tasks and chats with their live state. */
  sidebar: [
    // The session snapshot the sidebar renders, and its stale signal.
    'desktop:session-snapshot',
    'desktop:session-snapshot-stale',
  ],
  /**
   * A task's chat list, transcript, queue and live events. Reading a chat's
   * state runs the host's own chat recovery for it, as it does for this
   * computer's windows and for browser and phone controllers, which call the
   * same handlers: it settles state that is already this computer's and
   * resumes only work someone already queued here, never new work.
   */
  chats: [
    // chat.loadTabs and chat.activeSessions: a worktree's chats and which run.
    'chat:load-tabs',
    'chat:active-sessions',
    // chat.getState, chat.onStateChanged, chat.setStateScopes: chat state for
    // the scopes the window declares, and its pushes for those scopes only.
    // The declaration only filters this session's own pushes.
    'chat:get-state',
    'chat:state-changed',
    'chat:set-state-scopes',
    // chat.getTranscriptPage and chat.onChatEvent: the transcript and its live
    // events; chat:set-interest limits text deltas to the chats on screen.
    'chat:get-transcript-page',
    'chat:event',
    'chat:set-interest',
    // chat.getChatQueueSnapshot and chat.onChatQueueUpdated: the queue, read.
    'chat:queue-get-snapshot',
    'chat:queue-updated',
  ],
  /** What the composer shows: the model catalog and the approval mode. */
  composer: [
    // The model catalog the picker lists, read without options: `probe`
    // and `recheck` start provider discovery, so they are refused.
    'model-registry:get',
    // approvals.getResolvedDefault: the chat's approval mode, read only.
    'approval:resolved-default',
  ],
  /** Tool approval requests, shown on the controlling computer. */
  approvals: [
    // approvals.onRequest, onCancelled, onAutoResolved and pendingRequests.
    // Answering waits until the host ties a response to a chat's approval
    // and builds the saved rule from that approval itself (CAN-7865).
    'approval:request',
    'approval:cancelled',
    'approval:auto-resolved',
    'approval:pending-requests',
  ],
  /** Send and stop (CAN-7854). */
  send: [
    // chat.command for the store's typed commands, each held to its
    // reviewed fields. A send is its chat.send_message, which takes the
    // session, model and settings from this computer's saved chat, as a
    // hosted controller's send does. The older chat:send-message stays off:
    // it takes them from the caller, so a send without them would start the
    // provider conversation over.
    'chat:command',
    // chat.cancel: Stop of the named turn, which ends only the running
    // turn and sends no input. Its pairing re-check after the session's
    // lock, and the release of the next queued message when that turn ends,
    // move with the queue's writes and dispatches to CAN-7877. The queue's
    // actions stay off
    // until CAN-7877 holds them to the pairing: a queued message's edit,
    // steer and Run now (chat:queue-force) can change or deliver input, and
    // cancelling one (chat:queue-cancel) drains the queue, which can
    // dispatch the next message.
    'chat:cancel',
  ],
  // A chat's settings stay off for now (CAN-7854): the plan, thinking and
  // speed setters save after a lock without checking the session's pairing
  // again, and changing plan mode restarts a terminal-backed chat's
  // terminal, ending its running turn. The chat's model (chat:model-change)
  // waits until the host derives the chat's harness lock for a remote caller
  // (CAN-7868), and its approval mode (approval:mode-set) stays off: it
  // writes this computer's default for every chat.
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type OneWindowCapability = keyof typeof ONE_WINDOW_CAPABILITY_CHANNELS;

function isOneWindowCapability(name: string): name is OneWindowCapability {
  return Object.prototype.hasOwnProperty.call(
    ONE_WINDOW_CAPABILITY_CHANNELS,
    name,
  );
}

/** Every capability this build serves, sorted; a host announces all of them. */
export const ONE_WINDOW_CAPABILITIES: readonly OneWindowCapability[] =
  Object.keys(ONE_WINDOW_CAPABILITY_CHANNELS)
    .filter(isOneWindowCapability)
    .sort();

/** The whole reviewed list, sorted and without repeats, for fingerprinting. */
export const ONE_WINDOW_CONTROLLER_CHANNELS: readonly string[] = Array.from(
  new Set<string>(Object.values(ONE_WINDOW_CAPABILITY_CHANNELS).flat()),
).sort();

const ONE_WINDOW_CHANNEL_SET: ReadonlySet<string> = new Set(
  ONE_WINDOW_CONTROLLER_CHANNELS,
);

/**
 * Whether a one-window controller may use `channel` on a host of this build.
 * Anything not on the list is refused, unknown channels included. The host
 * still requires the channel's `tunnel` disposition as well.
 */
export function oneWindowChannelAllowed(channel: string): boolean {
  return ONE_WINDOW_CHANNEL_SET.has(channel);
}

const ONE_WINDOW_MODEL_REGISTRY_CHANNEL = 'model-registry:get';
const ONE_WINDOW_CHAT_COMMAND_CHANNEL = 'chat:command';

/** The read-only capabilities' channels: they carry no field allowlist. */
const ONE_WINDOW_READ_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...ONE_WINDOW_CAPABILITY_CHANNELS.sidebar,
  ...ONE_WINDOW_CAPABILITY_CHANNELS.chats,
  ...ONE_WINDOW_CAPABILITY_CHANNELS.composer,
  ...ONE_WINDOW_CAPABILITY_CHANNELS.approvals,
]);

/**
 * The only request fields a one-window controller may send on each call
 * that changes something, each taking one request object (CAN-7854). Every
 * field is required and every value is an ID-sized string. Stop names the
 * exact turn
 * (`expectedUserMessageId`), as for a hosted controller: without it the
 * host's plain Stop ends whatever turn runs when the request lands, and can
 * keep queue state for a chat that does not exist.
 */
export const ONE_WINDOW_REQUEST_FIELDS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    'chat:cancel',
    new Set(['projectId', 'worktreeId', 'chatId', 'expectedUserMessageId']),
  ],
]);

/**
 * The `chat:command` commands a one-window controller may send, each with
 * the only fields it may carry: a send.
 * They follow the hosted controller's reviewed
 * commands and value checks (`HOSTED_CHAT_COMMAND_FIELDS`, CAN-5985 and
 * CAN-7445), narrower, and are kept here so neither profile widens the
 * other. A send carries its text only: the host takes the chat's model and
 * settings from its saved chat, so a send cannot change them, and this
 * controller's settings setters stay off (see `ONE_WINDOW_CAPABILITY_CHANNELS`).
 * `chat:command`
 * is a generic dispatcher, so every other command is refused, unknown ones
 * included, until a reviewed change adds it:
 *
 * - archive, restore, fork, reset, close, reorder, file tabs, seeded tabs,
 *   approval mode, plan exit and dismissals (CAN-7767, one at a time);
 * - question answers, until the host refuses a remote answer to a secret
 *   or person-only question at settlement (CAN-7865);
 * - read and attention state, until the host checks the version a remote
 *   acknowledgement names (CAN-7866);
 * - `chat.set_model`, which takes the provider from its caller, never;
 * - settings patches (`chat.patch_tab_settings`), CAN-7868: turning on
 *   Auto lets a later send route a chat to another provider with its
 *   transcript, unasked; plugin selections replace the saved ones whole,
 *   dropping this computer's MCP auth preferences; and plan mode and model
 *   settings skip the live-session update their dedicated setters make;
 * - a new chat (`chat.create_tab`), until the host gives it this computer's
 *   defaults without a write before the create commits and keeps a retried
 *   create's receipt (CAN-7907);
 * - a queued message's edit, steer (`chat.steer_queued_message`), Run now
 *   (`chat.force_queued_message`) and cancel, until CAN-7877 holds the
 *   queue's writes and dispatches to the pairing.
 *
 * Values are checked here as for a hosted controller (IDs, bounded text,
 * booleans), so nothing larger or of another type reaches the host; its own
 * validation still checks every value.
 */
export const ONE_WINDOW_CHAT_COMMAND_FIELDS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['chat.send_message', new Set(['type', 'chatId', 'userMessageId', 'text'])],
]);

/** The command types of {@link ONE_WINDOW_CHAT_COMMAND_FIELDS}, sorted. */
export const ONE_WINDOW_CHAT_COMMANDS: readonly string[] = Array.from(
  ONE_WINDOW_CHAT_COMMAND_FIELDS.keys(),
).sort();

/**
 * `chat:command` envelope fields: the desktop envelope without `origin`,
 * which only the host sets, and without the revision guards
 * (`expectedRevision`, `expectedTabRevision`): the host checks them on none
 * of these commands from this caller, so a request naming one would look
 * guarded and not be. A command that needs one joins with it.
 */
const ONE_WINDOW_CHAT_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'commandId',
  'projectId',
  'worktreeId',
  'command',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** The longest message a one-window send carries, as for a hosted one. */
const ONE_WINDOW_MAX_TEXT_LENGTH = 200_000;

/** One reviewed command's values, after its field names are checked. */
function oneWindowCommandValuesAllowed(
  command: Record<string, unknown>,
): boolean {
  switch (command.type) {
    case 'chat.send_message':
      return (
        isHostedId(command.chatId) &&
        isHostedId(command.userMessageId) &&
        typeof command.text === 'string' &&
        command.text.length > 0 &&
        command.text.length <= ONE_WINDOW_MAX_TEXT_LENGTH
      );
    default:
      return false;
  }
}

/** One reviewed `chat:command` with only its reviewed fields and values. */
function oneWindowChatCommandAllowed(args: readonly unknown[]): boolean {
  const request = args[0];
  if (
    args.length !== 1 ||
    !isRecord(request) ||
    !onlyFields(request, ONE_WINDOW_CHAT_ENVELOPE_FIELDS) ||
    request.schemaVersion !== 1 ||
    !isHostedId(request.commandId) ||
    !isHostedId(request.projectId) ||
    !isHostedId(request.worktreeId)
  )
    return false;
  const command = request.command;
  if (!isRecord(command) || typeof command.type !== 'string') return false;
  const fields = ONE_WINDOW_CHAT_COMMAND_FIELDS.get(command.type);
  return (
    fields !== undefined &&
    onlyFields(command, fields) &&
    oneWindowCommandValuesAllowed(command)
  );
}

/** The model catalog, read without the options that start discovery. */
function oneWindowModelRegistryReadAllowed(args: readonly unknown[]): boolean {
  if (args.length === 0) return true;
  const [request] = args;
  return (
    args.length === 1 &&
    (request === undefined ||
      (isRecord(request) && Object.keys(request).length === 0))
  );
}

/**
 * Whether a one-window controller may invoke or send on `channel` with these
 * arguments. A read-only channel's arguments only select what to read, so the
 * host's own handler validates them; the model catalog is read without
 * options. A call that changes anything must carry only the fields of its
 * allowlist (`ONE_WINDOW_REQUEST_FIELDS`, `ONE_WINDOW_CHAT_COMMAND_FIELDS`),
 * and one with no allowlist is refused.
 */
export function oneWindowInvocationAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  if (!oneWindowChannelAllowed(channel)) return false;
  if (channel === ONE_WINDOW_MODEL_REGISTRY_CHANNEL)
    return oneWindowModelRegistryReadAllowed(args);
  if (ONE_WINDOW_READ_CHANNELS.has(channel)) return true;
  if (channel === ONE_WINDOW_CHAT_COMMAND_CHANNEL)
    return oneWindowChatCommandAllowed(args);
  const fields = ONE_WINDOW_REQUEST_FIELDS.get(channel);
  const request = args[0];
  return (
    fields !== undefined &&
    args.length === 1 &&
    isRecord(request) &&
    onlyFields(request, fields) &&
    Array.from(fields).every((field) => isHostedId(request[field]))
  );
}

/**
 * Whether a one-window controller may send (`ipc.send`, no reply) on
 * `channel` with these arguments. Every call that changes something is an
 * invoke on this computer, so a send of one would be dropped without a
 * reply; it is refused instead, and only the read-only channels may be sent.
 */
export function oneWindowSendAllowed(
  channel: string,
  args: readonly unknown[],
): boolean {
  return (
    ONE_WINDOW_READ_CHANNELS.has(channel) &&
    oneWindowInvocationAllowed(channel, args)
  );
}

/**
 * The channels a host serves to this controller, from the capabilities it
 * announced: what the controlling side may call on that computer. Names this
 * build does not know are ignored, so a newer host never widens an older
 * controller's list.
 */
export function oneWindowChannelsFor(
  capabilities: readonly string[],
): ReadonlySet<string> {
  const channels = new Set<string>();
  for (const name of capabilities) {
    if (!isOneWindowCapability(name)) continue;
    for (const channel of ONE_WINDOW_CAPABILITY_CHANNELS[name])
      channels.add(channel);
  }
  return channels;
}

/**
 * The `session.hello.controller` a desktop sends to connect in one-window
 * mode: the oldest protocol it works with, and the mode. Without it a
 * desktop controller is the separate window, held to the exact match.
 */
export function oneWindowControllerProfile(): NonNullable<
  HelloParams['controller']
> {
  return {
    kind: 'desktop',
    minVersion: DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION,
    mode: DESKTOP_ONE_WINDOW_MODE,
  };
}

/**
 * What a one-window controller may call on a host, from the host's answer to
 * its hello; null when it may call nothing but the core operations, so the
 * host (or this computer) needs an update first.
 *
 * - A host that admitted the mode announces its capabilities: their channels.
 * - A host released before the mode, on this computer's exact protocol,
 *   serves the full tunnel, so the read-only capabilities read the same on
 *   both sides. It offers none of the calls that change something: it has
 *   no field allowlists or one-window checks to hold them to (CAN-7854).
 * - Any other host, below the floor or on another protocol without the mode,
 *   serves nothing.
 */
export function oneWindowHostChannels(
  hello: HelloResult,
  local: RemoteVersion,
): ReadonlySet<string> | null {
  const hostVersion = hello.version?.protocolVersion;
  if (
    hostVersion === undefined ||
    hostVersion < DESKTOP_ONE_WINDOW_MIN_PROTOCOL_VERSION
  )
    return null;
  const announced = hello.features?.oneWindow;
  if (announced !== undefined)
    return oneWindowChannelsFor(announced.capabilities);
  return hostVersion === local.protocolVersion
    ? new Set(ONE_WINDOW_READ_CHANNELS)
    : null;
}
