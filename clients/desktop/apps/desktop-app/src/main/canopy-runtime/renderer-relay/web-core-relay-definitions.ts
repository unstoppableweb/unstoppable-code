import {
  CANOPY_STREAM_DEFINITIONS,
  CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
  CORE_APPROVAL_QUERY_DEFINITIONS,
  CORE_APPROVAL_STREAM_DEFINITIONS,
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CHAT_LIVE_STREAM_DEFINITIONS,
  CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_TASK_QUERY_DEFINITIONS,
  CORE_CHAT_TASK_STREAM_DEFINITIONS,
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
  CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
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
  'core.chat.task.list',
  'core.chat.task.events',
  'core.chat.list',
  'core.chat.snapshot.get',
  'core.chat.transcript.page',
  'core.chat.events',
  'core.chat.live.events',
  'core.chat.create',
  'core.chat.update',
  'core.chat.archive',
  'core.chat.message.send',
  'core.chat.send.receipt',
  'core.chat.turn.cancel',
  'core.chat.queue.entry.cancel',
  'core.chat.queue.entry.update',
  'core.chat.queue.entry.force',
  'core.chat.question.respond',
  'core.approval.request.list',
  'core.approval.request.events',
  'core.approval.request.respond',
  'core.catalog.snapshot.get',
  'core.catalog.selection.get',
  'core.catalog.selection.update',
  'core.artifact.list',
  'core.artifact.get',
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
  queries: allowed(
    composeCanopyQueryRegistries(
      CORE_QUERY_DEFINITIONS,
      CORE_CHAT_TASK_QUERY_DEFINITIONS,
      CORE_CATALOG_QUERY_DEFINITIONS,
      CORE_ARTIFACT_QUERY_DEFINITIONS,
      CORE_APPROVAL_QUERY_DEFINITIONS,
      CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
      WORKER_FILESYSTEM_QUERY_DEFINITIONS,
      WORKER_TERMINAL_QUERY_DEFINITIONS,
      WORKER_PIPELINE_QUERY_DEFINITIONS,
    ),
  ),
  instructions: allowed(
    composeCanopyInstructionRegistries(
      CORE_INSTRUCTION_DEFINITIONS,
      CORE_CATALOG_INSTRUCTION_DEFINITIONS,
      CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
      CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
      CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
      CORE_WORKSPACE_METADATA_INSTRUCTION_DEFINITIONS,
      WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
      WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
    ),
  ),
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

/** The project fields the desktop edits on the web core: a cloud project's name and colour. */
const WEB_CORE_WORKSPACE_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'color',
]);

/**
 * What a renderer may send with an allowed web core operation, narrower than
 * the operation itself (CAN-6099): `core.workspace.update` changes only a
 * project's name and colour, as the web app's settings do.
 */
export function webCoreRelayRefuseParams(
  method: string,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (method !== 'core.workspace.update') return null;
  const patch = params.patch;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    return 'A project update needs a patch.';
  return Object.keys(patch).every((field) =>
    WEB_CORE_WORKSPACE_PATCH_FIELDS.has(field),
  )
    ? null
    : "Only a cloud project's name and colour can be changed here.";
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
 * file operations (CAN-6114). Main never carries the same-origin wake proof,
 * so the web core would refuse a relayed wake; the call goes as a non-waking
 * one, and a sleeping sandbox answers its `sandbox_sleeping` refusal.
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
