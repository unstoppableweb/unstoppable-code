import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import {
  CoreArtifactListResultSchema,
  CoreChatListResultSchema,
  WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES,
  WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
  WorkerArtifactDownloadReadResultSchema,
  type WorkerArtifactDownloadReadResult,
  type WorkerFilesystemFileReadResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import { webCoreLocalId, type WebCoreFileLocation } from '../chat-authority';

/*
 * A cloud chat's deliverables by their saved copies (CAN-6587): a deliverable
 * sits in the task folder at deliverables/<session>/<name>, and the chat
 * lists its saved copy with `core.artifact.list`. While the sandbox is
 * asleep the viewer reads that copy instead, as the web's file tree does
 * (REG-2924).
 */

async function requestWebCore<Result>(
  relay: CanopyCoreRelayApi,
  method: string,
  params: Record<string, unknown>,
  schema: { parse(value: unknown): Result },
): Promise<Result> {
  const reply = await relay.invoke({
    kind: 'request',
    method,
    params,
    authority: 'web-core',
  });
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return schema.parse(reply.value);
}

const DELIVERABLE_PATH = /^deliverables\/[^/]+\/([^/]+)$/;

/** The file's name when it is one of the task's deliverables, else null. */
export function cloudDeliverableName(relativePath: string): string | null {
  return DELIVERABLE_PATH.exec(relativePath)?.[1] ?? null;
}

// The task folder's absolute path in its sandbox: Core mounts the workspace
// at /vercel/sandbox/workspace, as the web's CORE_MOUNT_ROOT reads it. No
// other absolute prefix is the task's.
const DELIVERABLE_LINK =
  /^(?:\.\/|\/vercel\/sandbox\/workspace\/)?(deliverables\/[^/]+\/[^/]+)$/;

/**
 * A transcript link's deliverable path in the workspace, for when the sandbox
 * can't resolve it: `deliverables/<session>/<name>`, relative or under the
 * sandbox's workspace folder. Anything else, another absolute folder or `..`
 * included, is null.
 */
export function deliverableLinkPath(href: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(href.trim().split(/[?#]/, 1)[0] ?? '');
  } catch (error) {
    // A malformed escape names no file.
    if (!(error instanceof URIError)) throw error;
    return null;
  }
  if (path.includes('\\') || path.split('/').some((part) => part === '..'))
    return null;
  return DELIVERABLE_LINK.exec(path)?.[1] ?? null;
}

/** A cloud task's scope, as the viewer and its file operations name it. */
export interface CloudTaskScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** One of the task's saved deliverables: the chat that saved it, and its id. */
export interface SavedDeliverable {
  readonly chatId: string;
  readonly id: string;
}

const CHAT_LIST_PAGES = 10;
type ChatList = ReturnType<typeof CoreChatListResultSchema.parse>;
type ArtifactList = ReturnType<typeof CoreArtifactListResultSchema.parse>;
const ARTIFACT_LIST_PAGES = 20;

/**
 * The chats whose saved deliverables can sit in the task folder: every chat of
 * the task when its scope is known, else only the chat the path names.
 */
async function taskChatIds(
  relay: CanopyCoreRelayApi,
  pathChatId: string,
  scope: CloudTaskScope | undefined,
): Promise<readonly string[]> {
  const workspaceId =
    scope === undefined ? null : webCoreLocalId(scope.projectId);
  const worktreeId =
    scope === undefined ? null : webCoreLocalId(scope.worktreeId);
  if (workspaceId === null || worktreeId === null) return [pathChatId];
  const ids = [pathChatId];
  let cursor: string | null = null;
  for (let page = 0; page < CHAT_LIST_PAGES; page += 1) {
    const listed: ChatList = await requestWebCore(
      relay,
      'core.chat.list',
      {
        scope: { workspaceId, worktreeId },
        ...(cursor === null ? {} : { cursor }),
      },
      CoreChatListResultSchema,
    );
    // The web core reads no archived chat's artifacts: it refuses the owner.
    for (const item of listed.items)
      if (item.state !== 'archived' && !ids.includes(item.chatId))
        ids.push(item.chatId);
    cursor = listed.nextCursor;
    if (cursor === null) break;
  }
  return ids;
}

/**
 * The task's saved deliverable named `name`: a deliverable is one chat's,
 * though it sits in the folder the task's chats share. Null when none of the
 * task's chats lists one by that name, and `ambiguous` when more than one
 * does: the lookup never picks one of them.
 */
export async function savedDeliverable(
  relay: CanopyCoreRelayApi,
  pathChatId: string,
  name: string,
  scope?: CloudTaskScope,
): Promise<SavedDeliverable | 'ambiguous' | null> {
  const matches: SavedDeliverable[] = [];
  for (const chatId of await taskChatIds(relay, pathChatId, scope)) {
    const prefix = `dlv:${chatId}:`;
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      // A list too long to read whole can't show the name is unique.
      if (page === ARTIFACT_LIST_PAGES) return null;
      const listed: ArtifactList = await requestWebCore(
        relay,
        'core.artifact.list',
        {
          owner: { kind: 'chat', id: chatId },
          kinds: ['file'],
          states: ['available'],
          cursor,
          limit: 500,
        },
        CoreArtifactListResultSchema,
      );
      for (const artifact of listed.artifacts)
        if (artifact.artifactId.startsWith(prefix) && artifact.name === name)
          matches.push({
            chatId,
            id: artifact.artifactId.slice(prefix.length),
          });
      cursor = listed.nextCursor;
      if (cursor === null) break;
    }
  }
  if (matches.length > 1) return 'ambiguous';
  return matches[0] ?? null;
}

/** `bytes` up to its last whole UTF-8 character. */
export function wholeUtf8Prefix(bytes: Uint8Array): Uint8Array {
  const last = Math.min(4, bytes.byteLength);
  for (let back = 1; back <= last; back += 1) {
    const byte = bytes[bytes.byteLength - back] ?? 0;
    // Continuation bytes are 10xxxxxx; the first byte that isn't one starts
    // the last character, which needs as many bytes as its lead says.
    if ((byte & 0xc0) !== 0x80) {
      const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      return size > back ? bytes.subarray(0, bytes.byteLength - back) : bytes;
    }
  }
  return bytes;
}

/** The details of a refusal for a name more than one chat saved. */
export const AMBIGUOUS_DELIVERABLE = 'deliverable_ambiguous';

/** What to say when more than one of the task's chats saved `name`. */
export function ambiguousDeliverableMessage(
  name: string,
  action: 'open' | 'download',
): string {
  return action === 'open'
    ? `More than one chat in this task saved ${name}. Send a message in the task to wake it, then open the file from its folder.`
    : `More than one chat in this task saved ${name}. Download it from its chat on the web.`;
}

/** A refusal for a saved name more than one of the task's chats share. */
export function ambiguousDeliverable(
  name: string,
  action: 'open' | 'download',
): CoreCoworkRequestError {
  return new CoreCoworkRequestError({
    kind: 'failed_precondition',
    message: ambiguousDeliverableMessage(name, action),
    details: { reason: AMBIGUOUS_DELIVERABLE },
    retry: { kind: 'never' },
  });
}

/** Whether a refusal is a saved name more than one chat shares. */
export function isAmbiguousDeliverable(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    typeof error.payload.details === 'object' &&
    error.payload.details !== null &&
    Reflect.get(error.payload.details, 'reason') === AMBIGUOUS_DELIVERABLE
  );
}

/** Whether a web core refusal is a sandbox that is asleep. */
export function isSandboxSleeping(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    Reflect.get(details, 'reason') === 'sandbox_sleeping'
  );
}

/**
 * A deliverable's text read from its saved copy, for when the sandbox is
 * asleep: the web's file tree serves deliverables the same way (REG-2924).
 * Null when the file isn't a deliverable the chat lists, or isn't text.
 */
export async function readSavedDeliverable(
  relay: CanopyCoreRelayApi,
  location: WebCoreFileLocation,
  scope?: CloudTaskScope,
): Promise<WorkerFilesystemFileReadResult | null> {
  const name = cloudDeliverableName(location.relativePath);
  if (name === null) return null;
  const saved = await savedDeliverable(relay, location.chatId, name, scope);
  if (saved === 'ambiguous') throw ambiguousDeliverable(name, 'open');
  if (saved === null) return null;
  const { id } = saved;
  const ranges: Uint8Array[] = [];
  let read = 0;
  let sizeBytes = 0;
  for (let offset: number | null = 0; offset !== null; ) {
    const range: WorkerArtifactDownloadReadResult = await requestWebCore(
      relay,
      'worker.artifact.download.read',
      {
        artifactId: `deliverable:${id}`,
        scope: { chatId: saved.chatId },
        offset,
        length: Math.min(
          WORKER_ARTIFACT_DOWNLOAD_CHUNK_MAX_BYTES,
          WORKER_FILESYSTEM_FILE_READ_MAX_BYTES - read,
        ),
      },
      WorkerArtifactDownloadReadResultSchema,
    );
    const bytes = Uint8Array.from(atob(range.data), (char) =>
      char.charCodeAt(0),
    );
    ranges.push(bytes);
    read += bytes.byteLength;
    sizeBytes = range.sizeBytes;
    offset =
      range.nextOffset !== null && read < WORKER_FILESYSTEM_FILE_READ_MAX_BYTES
        ? range.nextOffset
        : null;
  }
  const all = new Uint8Array(read);
  let at = 0;
  for (const bytes of ranges) {
    all.set(bytes, at);
    at += bytes.byteLength;
  }
  // A read the cap cut off may end inside a character; keep whole ones.
  const text = read < sizeBytes ? wholeUtf8Prefix(all) : all;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(text);
  } catch (error) {
    // Not UTF-8: the viewer shows no binary saved copy.
    // By name: Node's decoder throws a TypeError from another realm.
    if (
      typeof error !== 'object' ||
      error === null ||
      Reflect.get(error, 'name') !== 'TypeError'
    )
      throw error;
    return null;
  }
  return {
    fileRootId: location.fileRootId,
    relativePath: location.relativePath,
    name,
    contentKind: name.toLowerCase().endsWith('.md') ? 'markdown' : 'text',
    encoding: 'utf8',
    content,
    sizeBytes,
    returnedBytes: text.byteLength,
    truncated: read < sizeBytes,
    modifiedAt: new Date(0).toISOString(),
    version: `deliverable:${id}`,
  };
}
