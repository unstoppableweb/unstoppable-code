import {
  CANOPY_STREAM_DEFINITIONS,
  CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
  CORE_APPROVAL_QUERY_DEFINITIONS,
  CORE_APPROVAL_STREAM_DEFINITIONS,
  CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_ARCHIVE_QUERY_DEFINITIONS,
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CHAT_LIVE_STREAM_DEFINITIONS,
  CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_SECRET_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_SECRET_QUERY_DEFINITIONS,
  CORE_CHAT_TASK_QUERY_DEFINITIONS,
  CORE_CHAT_TASK_STREAM_DEFINITIONS,
  CORE_COST_CLOUD_RUN_QUERY_DEFINITIONS,
  CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS,
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS,
  CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS,
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COWORK_UPDATE_SCHEMA_REVISION,
  CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
  CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_SANDBOX_QUERY_DEFINITIONS,
  WORKER_ARTIFACT_INSTRUCTION_DEFINITIONS,
  WORKER_ARTIFACT_QUERY_DEFINITIONS,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_QUERY_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_QUERY_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  composeCanopyStreamRegistries,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  MAX_HOST_PORT,
  MAX_HOST_PORTS,
  MIN_HOST_PORT,
  parseEgressAllowedHosts,
  parseHostPorts,
} from '@canopy/protocol/canopy-core/core';
import type { RelayDefinitions } from './definitions';
import type { InterfaceRelayOperationKind } from './interface-allowlist.generated';
import type { RendererRelaySurface } from './surface-allowlist';

/**
 * The reads, live events and controls of the signed-in account's cloud
 * workflow runs (CAN-6326, served by CAN-6214). Unlike the cloud chat
 * operations they are not behind the cloud chats flag: the renderer offers
 * them only while the web core manifest reports cloud runs available
 * (CAN-6085), and the web core serves them to a run's owner only, behind its
 * own rollout flag. Starting a run stays in main (CAN-6187), which runs the
 * model preflight first.
 */
export const WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS: ReadonlySet<string> =
  new Set([
    'worker.pipeline.execution.list',
    'worker.pipeline.execution.get',
    'worker.pipeline.execution.events',
    'worker.pipeline.execution.cancel',
    'worker.pipeline.execution.resume',
    'worker.pipeline.execution.retry',
    'worker.pipeline.matrixJob.retry',
    'worker.pipeline.matrixVariant.cancel',
    'core.pipeline.execution.stepLog.read',
    'core.pipeline.execution.artifact.read',
    // A cloud run's cost, from its ledger (CAN-6881).
    'core.cost.cloudRun.get',
  ]);

/**
 * What the renderer may call on the web core (CAN-4185 D5): cloud cowork
 * chats, reads and writes of their sandbox's files (CAN-6175 R9), durable
 * terminals in it (R10; the web core serves those only with
 * canopy-cloud-durable-terminals on) and cloud workflow runs. No entry
 * copy (the web core serves none), Git, scripts or pull requests.
 */
export const WEB_CORE_RELAY_OPERATIONS: ReadonlySet<string> = new Set([
  'core.workspace.list',
  'core.workspace.get',
  // Cloud project reorder, rename and colour, and delete to Trash in the
  // sidebar (CAN-6099).
  'core.workspace.reorder',
  'core.workspace.update',
  'core.workspace.delete',
  // A cloud project's instructions, default plugins, and description, default
  // model and Trash retention in its settings (CAN-7053); each narrowed by
  // `webCoreRelayRefuseParams`.
  'core.workspace.instructions.update',
  'core.workspace.plugins.update',
  'core.workspace.cowork.update',
  // The Host tab's live forwarded URLs (CAN-7053).
  'core.workspace.sandboxRoutes.get',
  'core.chat.task.list',
  'core.chat.task.events',
  'core.chat.list',
  'core.chat.snapshot.get',
  'core.chat.transcript.page',
  // Find in a cloud chat over pages not loaded (CAN-6175 R12).
  'core.chat.transcript.search',
  'core.chat.events',
  'core.chat.live.events',
  'core.chat.create',
  'core.chat.update',
  'core.chat.archive',
  // Deleting a cloud task to the Trash from the sidebar (CAN-7052): its own
  // chat closes in discard mode only (`webCoreRelayRefuseParams`).
  'core.chat.delete',
  // Fork a cowork cloud chat whole into a new task under the renderer's UUID
  // claim (CAN-7007); the web core checks the source chat is the caller's.
  'core.chat.fork',
  // A cloud project's archived tasks, and restoring one in place (CAN-6511).
  // The rest of the archive (update, delete, chat.get) stays off the relay.
  'core.archive.container.list',
  'core.archive.container.restore',
  'core.chat.message.send',
  'core.chat.send.receipt',
  'core.chat.turn.cancel',
  'core.chat.queue.entry.cancel',
  'core.chat.queue.entry.update',
  'core.chat.queue.entry.force',
  'core.chat.question.respond',
  // A cloud chat's secret request answers and its Secrets chip (agent
  // secret requests). The submit carries values; main never logs params.
  'core.chat.secretRequest.submit',
  'core.chat.secret.list',
  'core.chat.secret.revoke',
  'core.approval.request.list',
  'core.approval.request.events',
  'core.approval.request.respond',
  'core.catalog.snapshot.get',
  'core.catalog.selection.get',
  'core.catalog.selection.update',
  'core.artifact.list',
  'core.artifact.get',
  // Deleting a cloud chat's attachment from the activity rail (CAN-6175
  // R8d); its bytes download through main, never the relay.
  'worker.artifact.delete',
  // A sleeping sandbox's deliverable reads from its saved copy in the viewer
  // (CAN-6587). Read only: downloads to disk go through main's own
  // connection, and the web core checks the chat it is scoped to.
  'worker.artifact.download.read',
  'worker.filesystem.roots.list',
  'worker.filesystem.directory.list',
  'worker.filesystem.file.read',
  'worker.filesystem.search',
  'worker.filesystem.link.resolve',
  'worker.terminal.create',
  'worker.terminal.get',
  'worker.terminal.list',
  'worker.terminal.attach',
  'worker.terminal.write',
  'worker.terminal.resize',
  'worker.terminal.kill',
  'worker.terminal.release',
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.delete',
  'worker.filesystem.entry.move',
  // A cloud task's Cost (CAN-6180): the renderer offers it only while the
  // manifest lists both reads as available. Behind the cloud chats flag, as
  // the rest of a cloud task. The cost index refresh and pipeline run cost
  // stay local.
  'core.runtime.manifest.get',
  'core.cost.scope.get',
  'core.cost.chat.get',
  // A cloud chat's own delegates: their live state and Stop, Stop all
  // (CAN-7245), each narrowed by `webCoreRelayRefuseParams`. The web core
  // checks the chat is the caller's and the delegate in its tree; spawn,
  // message, steering and the rest stay off the relay.
  'core.managedDelegation.list',
  'core.managedDelegation.get',
  'core.managedDelegation.stop',
  'core.managedDelegation.stopAll',
  ...WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS,
]);

function allowed<D>(map: Readonly<Record<string, D>>): Record<string, D> {
  return Object.fromEntries(
    Object.entries(map).filter(([name]) => WEB_CORE_RELAY_OPERATIONS.has(name)),
  );
}

/**
 * The protocol definitions of `WEB_CORE_RELAY_OPERATIONS`. Task, live reply,
 * catalog, artifact, approval, question and cloud run storage operations live
 * in web-core-only registries, kept out of the composed core ones the desktop
 * dispatcher must serve.
 */
export const WEB_CORE_RELAY_DEFINITIONS: RelayDefinitions = {
  queries: {
    ...allowed(
      composeCanopyQueryRegistries(
        CORE_QUERY_DEFINITIONS,
        // Only the manifest, which offers a cloud task's Cost (CAN-6180).
        CORE_TRANSPORT_QUERY_DEFINITIONS,
        CORE_CHAT_TASK_QUERY_DEFINITIONS,
        CORE_CATALOG_QUERY_DEFINITIONS,
        CORE_ARTIFACT_QUERY_DEFINITIONS,
        CORE_ARCHIVE_QUERY_DEFINITIONS,
        CORE_APPROVAL_QUERY_DEFINITIONS,
        CORE_CHAT_SECRET_QUERY_DEFINITIONS,
        CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
        CORE_COST_CLOUD_RUN_QUERY_DEFINITIONS,
        WORKER_FILESYSTEM_QUERY_DEFINITIONS,
        WORKER_TERMINAL_QUERY_DEFINITIONS,
        WORKER_PIPELINE_QUERY_DEFINITIONS,
        WORKER_ARTIFACT_QUERY_DEFINITIONS,
      ),
    ),
    // The web core serves this read alone, so it stays out of the workspace
    // registry the desktop dispatcher serves (CAN-7053).
    'core.workspace.sandboxRoutes.get':
      CORE_WORKSPACE_SANDBOX_QUERY_DEFINITIONS[
        'core.workspace.sandboxRoutes.get'
      ],
    // A cloud chat's delegates' live state (CAN-7245); the rest of the
    // registry stays off the relay.
    'core.managedDelegation.list':
      CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS['core.managedDelegation.list'],
    'core.managedDelegation.get':
      CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS['core.managedDelegation.get'],
  },
  instructions: {
    ...allowed(
      composeCanopyInstructionRegistries(
        CORE_INSTRUCTION_DEFINITIONS,
        CORE_CATALOG_INSTRUCTION_DEFINITIONS,
        CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS,
        CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
        CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
        CORE_CHAT_SECRET_INSTRUCTION_DEFINITIONS,
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
        CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
        WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
        WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
        WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
        WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
        WORKER_ARTIFACT_INSTRUCTION_DEFINITIONS,
      ),
    ),
    // Only the default plugins and Cowork settings saves of the guarded
    // settings commands (CAN-7053); the rest of that registry stays off the
    // relay.
    'core.workspace.plugins.update':
      CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS[
        'core.workspace.plugins.update'
      ],
    // Stop and Stop all for a cloud chat's delegates (CAN-7245).
    'core.managedDelegation.stop':
      CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS[
        'core.managedDelegation.stop'
      ],
    'core.managedDelegation.stopAll':
      CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS[
        'core.managedDelegation.stopAll'
      ],
    'core.workspace.cowork.update':
      CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS[
        'core.workspace.cowork.update'
      ],
  },
  streams: allowed(
    composeCanopyStreamRegistries(
      CANOPY_STREAM_DEFINITIONS,
      CORE_CHAT_TASK_STREAM_DEFINITIONS,
      CORE_CHAT_LIVE_STREAM_DEFINITIONS,
      CORE_APPROVAL_STREAM_DEFINITIONS,
      WORKER_TERMINAL_STREAM_DEFINITIONS,
    ),
  ),
};

/**
 * What main itself calls on a web core connection: the client lease it holds
 * for the session, the acknowledgement of delivered stream items, and the
 * unsubscribe the shared client sends when a stream is released. Never in
 * `WEB_CORE_RELAY_OPERATIONS`, so the renderer can call none of them.
 */
export const WEB_CORE_HOST_DEFINITIONS: RelayDefinitions = {
  queries: {},
  instructions: {
    'core.client.lease.acquire':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.acquire'],
    'core.client.lease.renew':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.renew'],
    'core.client.lease.release':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.release'],
    'core.events.ack':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
    'core.events.unsubscribe':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.unsubscribe'],
  },
  streams: {},
};

/**
 * Ending a cloud terminal still reaches the web core after cloud chats are
 * turned off. The renderer kills its open cloud shells when the flag turns
 * off, after main's flag snapshot has already changed, and without this the
 * shells would run on until the sandbox idles them (CAN-6175 R10). The web
 * core still kills only the caller's own terminals.
 */
export const WEB_CORE_TEARDOWN_RELAY_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.terminal.kill',
]);

const CLOUD_CHATS_UNAVAILABLE: CanopyErrorPayload = {
  kind: 'capability_unavailable',
  message: 'Cloud chats are not available.',
  retry: { kind: 'never' },
};

/**
 * The refusal for a web core call while its feature is off, or null. The
 * cloud chat operations need `canopyDesktopCloudChats`; the cloud run
 * operations don't (see `WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS`), nor does
 * ending a terminal (`WEB_CORE_TEARDOWN_RELAY_OPERATIONS`). Checked on every
 * call, so the one connection serves both while either is on.
 */
export function webCoreRelayRefuseCall(
  method: string,
  cloudChatsEnabled: () => boolean,
): CanopyErrorPayload | null {
  return WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS.has(method) ||
    WEB_CORE_TEARDOWN_RELAY_OPERATIONS.has(method) ||
    cloudChatsEnabled()
    ? null
    : CLOUD_CHATS_UNAVAILABLE;
}

/**
 * Only the main window reaches the web core (CAN-4185 D4). Documented
 * exception to App Advisor parity: App Advisor reaches desktop capabilities
 * through agent actions, not this relay, and cloud chat agent actions are a
 * CAN-4186 follow-up (CAN-4185 D12). Pinned by web-core-relay.test.ts.
 */
export function webCoreRelayAllows(
  surface: RendererRelaySurface,
  _kind: InterfaceRelayOperationKind,
  method: string,
): boolean {
  return surface === 'main' && WEB_CORE_RELAY_OPERATIONS.has(method);
}

/**
 * The project fields the desktop edits on the web core: a cloud project's
 * name and colour (CAN-6099), and its sandbox's egress hosts and host mode
 * and ports (CAN-7053).
 */
const WEB_CORE_WORKSPACE_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'color',
  'hostModeEnabled',
  'hostPorts',
  'egressAllowedHosts',
]);

/** The params a project update takes, `_meta` aside. */
const WEB_CORE_WORKSPACE_UPDATE_PARAMS: ReadonlySet<string> = new Set([
  'workspaceId',
  'expectedRevision',
  'patch',
]);

/** The params a project's sandbox routes read takes. */
const WEB_CORE_SANDBOX_ROUTES_PARAMS: ReadonlySet<string> = new Set([
  'workspaceId',
]);

/**
 * The parsers the relay checks a project's sandbox fields with: the web
 * core's own, imported from @canopy/protocol, never a copy (CAN-7053).
 */
export const WEB_CORE_SANDBOX_FIELD_PARSERS = Object.freeze({
  parseHostPorts,
  parseEgressAllowedHosts,
});

const sameList = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Why a project patch's sandbox fields can't be sent, or null. They pass the
 * web core's own parsers, the same functions, and must already be in their
 * canonical form: a value the parser would change (a duplicate, an upper-case
 * host) is refused rather than rewritten. The web core still checks them.
 */
function refuseSandboxFields(
  patch: Readonly<Record<string, unknown>>,
): string | null {
  if ('hostModeEnabled' in patch && typeof patch.hostModeEnabled !== 'boolean')
    return 'Host mode must be on or off.';
  if ('hostPorts' in patch) {
    const parsed = parseHostPorts(patch.hostPorts);
    if (!parsed.ok)
      return parsed.reason === 'too_many'
        ? `At most ${MAX_HOST_PORTS} ports can be exposed.`
        : `Ports must be whole numbers between ${MIN_HOST_PORT} and ${MAX_HOST_PORT}.`;
    if (
      !Array.isArray(patch.hostPorts) ||
      !sameList(parsed.ports, patch.hostPorts)
    )
      return 'Each port can be listed once.';
  }
  if ('egressAllowedHosts' in patch) {
    const parsed = parseEgressAllowedHosts(patch.egressAllowedHosts);
    if (!parsed.ok) return parsed.error;
    if (
      !Array.isArray(patch.egressAllowedHosts) ||
      !sameList(parsed.hosts, patch.egressAllowedHosts)
    )
      return 'Enter each hostname once, in lower case, without spaces.';
  }
  return null;
}

/** The only `core.chat.delete` action the desktop sends: one task to the Trash. */
const WEB_CORE_CHAT_DELETE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'tabId',
  'mode',
]);

function refuseChatDelete(
  params: Readonly<Record<string, unknown>>,
): string | null {
  const action = params.action;
  if (typeof action !== 'object' || action === null || Array.isArray(action))
    return 'A chat delete needs an action.';
  return 'type' in action &&
    action.type === 'chat.close_tab' &&
    'mode' in action &&
    action.mode === 'discard' &&
    Object.keys(action).every((field) => WEB_CORE_CHAT_DELETE_FIELDS.has(field))
    ? null
    : 'Only a cloud task can be deleted here, one at a time.';
}

/** The params a cloud project's instructions save takes: its whole text. */
const WEB_CORE_INSTRUCTIONS_PARAMS: ReadonlySet<string> = new Set([
  'workspaceId',
  'content',
  'revision',
]);

/** The params a cloud project's default plugins save takes. */
const WEB_CORE_PLUGINS_PARAMS: ReadonlySet<string> = new Set([
  'workspaceId',
  'expectedRevision',
  'change',
  '_meta',
]);

/** A `setDefaults` change's fields, the only plugins change the relay sends. */
const WEB_CORE_PLUGINS_SET_DEFAULTS_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'defaultPluginSelections',
  'expectedDefaultPluginSelectionsRevision',
]);

/** The params a cloud project's Cowork settings save takes. */
const WEB_CORE_COWORK_PARAMS: ReadonlySet<string> = new Set([
  'workspaceId',
  'expectedRevision',
  'revision',
  'settings',
]);

const onlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The params each cloud delegate read or stop takes from a renderer. */
const WEB_CORE_MANAGED_DELEGATION_PARAMS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['core.managedDelegation.list', new Set(['scope', 'chatId', 'cursor'])],
  ['core.managedDelegation.get', new Set(['scope', 'chatId', 'delegationId'])],
  ['core.managedDelegation.stop', new Set(['scope', 'chatId', 'delegationId'])],
  ['core.managedDelegation.stopAll', new Set(['scope', 'chatId'])],
]);

const WEB_CORE_MANAGED_DELEGATION_SCOPE: ReadonlySet<string> = new Set([
  'workspaceId',
  'worktreeId',
]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Refuses a cloud delegate read or stop that carries anything a chat's own
 * cards don't send: its task's scope, the chat, and the delegate or the
 * list's cursor (CAN-7245). Which chat and delegate are the caller's is the
 * web core's to check; the relay can't see which chat the window shows.
 */
function refuseManagedDelegationParams(
  allowed: ReadonlySet<string>,
  params: Readonly<Record<string, unknown>>,
): string | null {
  const refusal = "Only this chat's own delegates can be read or stopped here.";
  if (!onlyKeys(params, allowed)) return refusal;
  const scope = params.scope;
  if (
    !isPlainRecord(scope) ||
    !onlyKeys(scope, WEB_CORE_MANAGED_DELEGATION_SCOPE) ||
    !isNonEmptyString(scope.workspaceId) ||
    !isNonEmptyString(scope.worktreeId) ||
    !isNonEmptyString(params.chatId)
  )
    return refusal;
  if (allowed.has('delegationId') && !isNonEmptyString(params.delegationId))
    return refusal;
  if (params.cursor !== undefined && !isNonEmptyString(params.cursor))
    return refusal;
  return null;
}

/**
 * Each Cowork setting the desktop saves on the web core, and the values it
 * takes: a cloud project's description, its default model (null clears it)
 * and its Trash retention (CAN-7053). Its start page, presets, starter
 * prompts and archive settings stay on the web.
 */
const WEB_CORE_COWORK_SETTINGS: ReadonlyMap<
  string,
  (value: unknown) => boolean
> = new Map<string, (value: unknown) => boolean>([
  ['description', (value) => typeof value === 'string'],
  ['defaultModel', (value) => value === null || typeof value === 'string'],
  ['deletionRetentionDays', (value) => Number.isInteger(value)],
]);

function refuseCoworkSettings(
  params: Readonly<Record<string, unknown>>,
): string | null {
  const settings = params.settings;
  return onlyKeys(params, WEB_CORE_COWORK_PARAMS) &&
    (params.revision === undefined ||
      params.revision === CORE_WORKSPACE_COWORK_UPDATE_SCHEMA_REVISION) &&
    isPlainRecord(settings) &&
    Object.keys(settings).length > 0 &&
    Object.entries(settings).every(
      ([key, value]) => WEB_CORE_COWORK_SETTINGS.get(key)?.(value) === true,
    )
    ? null
    : "Only a cloud project's description, default model and Trash retention can be changed here.";
}

/** Refuses a delegate's pages read for a chat other than its scope's. */
function refuseOtherChatDelegationPage(
  params: Readonly<Record<string, unknown>>,
): string | null {
  const target = params.target;
  if (!isPlainRecord(target) || target.kind !== 'delegation') return null;
  const scope = params.scope;
  return isPlainRecord(scope) &&
    typeof scope.chatId === 'string' &&
    target.chatId === scope.chatId
    ? null
    : "Only this chat's own delegates can be read here.";
}

/**
 * What a renderer may send with an allowed web core operation, narrower than
 * the operation itself:
 * - `core.workspace.update` changes only a project's name and colour
 *   (CAN-6099) and its sandbox's egress hosts, host mode and host ports
 *   (CAN-7053), each sandbox field valid and canonical for the web core's own
 *   parser.
 * - `core.workspace.sandboxRoutes.get` reads one project's routes and takes
 *   nothing else (CAN-7053).
 * - `core.workspace.instructions.update` overwrites a project's instructions
 *   and nothing else (CAN-7053).
 * - `core.workspace.plugins.update` only sets a project's default plugins;
 *   its other changes, such as recommended selections, stay on the web
 *   (CAN-7053).
 * - `core.workspace.cowork.update` changes only a project's description,
 *   default model and Trash retention, each of its type (CAN-7053).
 * - `core.chat.delete` only moves one task to the Trash (CAN-7052).
 *   Archiving goes through `core.chat.archive`, and the web core decides
 *   whether the chat is a task.
 * - `core.chat.transcript.page` reads a delegate's pages only for the chat
 *   the read is scoped to (CAN-7027). The web core also checks the delegate
 *   is that chat's own.
 * - `core.managedDelegation.list`, `.get`, `.stop` and `.stopAll` take only
 *   a chat's task scope, the chat, and the delegate or the list's cursor
 *   (CAN-7245).
 */
export function webCoreRelayRefuseParams(
  method: string,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (method === 'core.chat.delete') return refuseChatDelete(params);
  const delegationParams = WEB_CORE_MANAGED_DELEGATION_PARAMS.get(method);
  if (delegationParams !== undefined)
    return refuseManagedDelegationParams(delegationParams, params);
  if (method === 'core.chat.transcript.page')
    return refuseOtherChatDelegationPage(params);
  if (method === 'core.workspace.instructions.update')
    return onlyKeys(params, WEB_CORE_INSTRUCTIONS_PARAMS)
      ? null
      : "Only a cloud project's instructions can be saved here.";
  if (method === 'core.workspace.plugins.update') {
    const change = params.change;
    return onlyKeys(params, WEB_CORE_PLUGINS_PARAMS) &&
      isPlainRecord(change) &&
      change.kind === 'setDefaults' &&
      onlyKeys(change, WEB_CORE_PLUGINS_SET_DEFAULTS_FIELDS)
      ? null
      : "Only a cloud project's default plugins can be changed here.";
  }
  if (method === 'core.workspace.cowork.update')
    return refuseCoworkSettings(params);
  if (method === 'core.workspace.sandboxRoutes.get')
    return onlyKeys(params, WEB_CORE_SANDBOX_ROUTES_PARAMS)
      ? null
      : "Only a cloud project's sandbox routes can be read here.";
  if (method !== 'core.workspace.update') return null;
  if (!onlyKeys(params, WEB_CORE_WORKSPACE_UPDATE_PARAMS))
    return 'A project update takes only its project, revision and patch.';
  const patch = params.patch;
  if (!isPlainRecord(patch) || Object.keys(patch).length === 0)
    return 'A project update needs a patch.';
  if (!onlyKeys(patch, WEB_CORE_WORKSPACE_PATCH_FIELDS))
    return "Only a cloud project's name, colour, egress hosts and host settings can be changed here.";
  return refuseSandboxFields(patch);
}

/** The file operations that take `wake` (CAN-6114). */
const WEB_CORE_WAKING_FILE_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.filesystem.directory.list',
  'worker.filesystem.file.read',
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.delete',
  'worker.filesystem.entry.move',
]);

/**
 * The params a renderer's web core call is sent with: without `wake` on the
 * file operations (CAN-6114). The relay's connection never carries the
 * same-origin wake proof, so the web core would refuse a relayed wake; the
 * call goes as a non-waking one, and a sleeping sandbox answers its
 * `sandbox_sleeping` refusal. Files wakes through main's own call instead
 * (CAN-6724, `cloud-files-wake.ts`).
 */
export function webCoreRelayNarrowParams(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!WEB_CORE_WAKING_FILE_OPERATIONS.has(method) || !('wake' in params))
    return params;
  const rest = { ...params };
  delete rest.wake;
  return rest;
}
