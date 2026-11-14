import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isErrnoException, isRecord } from '../lib/type-guards';
import { messageId, type ProjectedTranscript } from './chat-projection';
import type {
  T3Attachment,
  T3Message,
  T3ThreadTranscript,
  T3TurnItem,
} from './t3code-store';

/**
 * Projects T3 Code's own text copy of a thread (the history tier) into
 * Canopy's persisted chat shape. Messages carry the user and assistant text;
 * command runs, file changes, web searches, and errors from the thread's turn
 * items are interleaved as the same tool-call blocks the Codex projection
 * writes, so the history reads like an imported Codex chat. Attachment files
 * are copied out of T3's `attachments/` folder; T3's store is never written.
 */

/** Command text and output shown per command run; longer text ends in `…`. */
export const T3_COMMAND_TEXT_LIMIT = 4096;

export interface T3ProjectionOptions {
  /** The destination chat's attachments directory. */
  attachmentsDir: string;
  /** `<T3 state dir>/attachments`, where T3 keeps attachment files. */
  t3AttachmentsDir: string;
}

function truncate(text: string): string {
  return text.length > T3_COMMAND_TEXT_LIMIT
    ? `${text.slice(0, T3_COMMAND_TEXT_LIMIT)}…`
    : text;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function itemTime(item: T3TurnItem): number | null {
  return timeOf(item.payload.startedAt) ?? timeOf(item.payload.updatedAt);
}

function toolUse(
  id: string,
  toolUseId: string,
  toolName: string,
  input: string,
  timestamp: number,
): PersistedChatMessage {
  const block: PersistedChatBlock = {
    type: 'tool_use',
    toolUseId,
    toolName,
    input,
  };
  return { id, role: 'assistant', timestamp, blocks: [block] };
}

function toolResult(
  id: string,
  toolUseId: string,
  toolName: string,
  output: string,
  isError: boolean,
  timestamp: number,
): PersistedChatMessage {
  const block: PersistedChatBlock = {
    type: 'tool_result',
    toolUseId,
    toolName,
    output,
    isError,
  };
  return { id, role: 'system', timestamp, blocks: [block] };
}

function fileChangeInput(payload: Record<string, unknown>): string | null {
  const lines: string[] = [];
  if (Array.isArray(payload.changes)) {
    for (const change of payload.changes) {
      if (!isRecord(change)) continue;
      const changedPath = nonEmpty(change.path);
      if (!changedPath) continue;
      const operation = nonEmpty(change.operation);
      lines.push(operation ? `${operation} ${changedPath}` : changedPath);
    }
  }
  const fileName = nonEmpty(payload.fileName);
  if (lines.length === 0 && fileName) lines.push(fileName);
  if (lines.length === 0) return null;
  const summary = nonEmpty(payload.summary) ?? nonEmpty(payload.title);
  if (summary) lines.push(summary);
  return lines.join('\n');
}

function webSearchInput(payload: Record<string, unknown>): string | null {
  const query = nonEmpty(payload.query);
  if (query) return query;
  if (!Array.isArray(payload.patterns)) return null;
  const patterns = payload.patterns.filter(
    (pattern): pattern is string =>
      typeof pattern === 'string' && pattern.trim() !== '',
  );
  return patterns.length > 0 ? patterns.join('\n') : null;
}

function errorText(payload: Record<string, unknown>): string | null {
  if (isRecord(payload.failure)) {
    const message = nonEmpty(payload.failure.message);
    if (message) return message;
  }
  return nonEmpty(payload.failure) ?? nonEmpty(payload.message);
}

/** The messages one turn item renders as; an item missing its fields renders as none. */
function itemMessages(
  item: T3TurnItem,
  timestamp: number,
): PersistedChatMessage[] {
  const { payload } = item;
  const id = (index: number): string => messageId(`t3:${item.id}`, index);
  switch (item.type) {
    case 'command_execution': {
      const command = nonEmpty(payload.command) ?? nonEmpty(payload.input);
      if (!command) return [];
      const use = toolUse(
        id(0),
        item.id,
        'command_execution',
        truncate(command),
        timestamp,
      );
      const failed =
        payload.status === 'failed' ||
        (typeof payload.exitCode === 'number' && payload.exitCode !== 0);
      if (typeof payload.output !== 'string' && !failed) return [use];
      const output = typeof payload.output === 'string' ? payload.output : '';
      return [
        use,
        toolResult(
          id(1),
          item.id,
          'command_execution',
          truncate(output),
          failed,
          timestamp,
        ),
      ];
    }
    case 'file_change': {
      const input = fileChangeInput(payload);
      return input
        ? [toolUse(id(0), item.id, 'file_change', input, timestamp)]
        : [];
    }
    case 'web_search': {
      const input = webSearchInput(payload);
      return input
        ? [toolUse(id(0), item.id, 'web_search', input, timestamp)]
        : [];
    }
    case 'error': {
      const text = errorText(payload);
      return text
        ? [
            {
              id: id(0),
              role: 'system',
              timestamp,
              blocks: [{ type: 'text', text }],
            },
          ]
        : [];
    }
    default: {
      const unhandled: never = item.type;
      return unhandled;
    }
  }
}

/** Largest T3 Code attachment file copied into an imported chat. */
const MAX_T3_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const COPY_CHUNK_BYTES = 256 * 1024;

// Windows defines neither flag; there the source gets an `lstat` before it is
// opened instead, which leaves a window a POSIX open does not.
const NO_FOLLOW: number | undefined = constants.O_NOFOLLOW;
const NON_BLOCKING: number | undefined = constants.O_NONBLOCK;

/** A source that is a symlink, a directory, a FIFO, or a device. */
class NotRegularFileError extends Error {}

/**
 * Opens an attachment source for reading without following a symlink. The
 * open is non-blocking so a FIFO planted in T3's folder cannot stall the
 * import waiting for a writer; the caller checks the handle is a regular file.
 */
async function openSource(source: string): Promise<FileHandle> {
  if (NO_FOLLOW === undefined && (await lstat(source)).isSymbolicLink())
    throw new NotRegularFileError();
  try {
    return await open(
      source,
      constants.O_RDONLY | (NO_FOLLOW ?? 0) | (NON_BLOCKING ?? 0),
    );
  } catch (error) {
    // `O_NOFOLLOW` refuses a symlink with ELOOP.
    if (isErrnoException(error) && error.code === 'ELOOP')
      throw new NotRegularFileError();
    throw error;
  }
}

/**
 * Copies a thread's attachment files out of T3's folder on first use. T3
 * names a file `<id>.<ext>`; the extension is whatever T3 chose, so files are
 * matched by their name without it. Only names the directory listing returned
 * are ever joined to a path, so an id from the store cannot point elsewhere.
 * The source is opened once without following symlinks, and the checks (a
 * regular file of at most {@link MAX_T3_ATTACHMENT_BYTES}) and the copy both
 * use that handle, so the file cannot be swapped between check and copy.
 */
class AttachmentCopier {
  private files: Promise<Map<string, string>> | undefined;

  constructor(
    private readonly options: T3ProjectionOptions,
    private readonly warnings: string[],
  ) {}

  private listing(): Promise<Map<string, string>> {
    this.files ??= readdir(this.options.t3AttachmentsDir)
      .then((names) => {
        const byStem = new Map<string, string>();
        for (const name of names) {
          const stem = name.slice(0, name.length - path.extname(name).length);
          if (stem && !byStem.has(stem)) byStem.set(stem, name);
        }
        return byStem;
      })
      .catch(() => new Map<string, string>());
    return this.files;
  }

  /** The copied file's path, or `null` when T3 no longer has the file. */
  async copy(attachment: T3Attachment): Promise<string | null> {
    const name = (await this.listing()).get(attachment.id);
    if (!name) return null;
    const source = path.join(this.options.t3AttachmentsDir, name);
    const destination = path.join(this.options.attachmentsDir, name);
    let handle: FileHandle | undefined;
    try {
      handle = await openSource(source);
      const stats = await handle.stat();
      if (!stats.isFile()) throw new NotRegularFileError();
      if (stats.size > MAX_T3_ATTACHMENT_BYTES) {
        this.warnings.push(
          `A T3 Code attachment was skipped because it is larger than ${MAX_T3_ATTACHMENT_BYTES / (1024 * 1024)} MB: ${name}.`,
        );
        return null;
      }
      await mkdir(this.options.attachmentsDir, { recursive: true });
      await copyThroughHandle(handle, destination);
      return destination;
    } catch (error) {
      if (error instanceof NotRegularFileError) {
        this.warnings.push(
          `A T3 Code attachment was skipped because it is not a regular file: ${name}.`,
        );
        return null;
      }
      if (isErrnoException(error) && error.code === 'EEXIST')
        return destination;
      this.warnings.push(
        `A T3 Code attachment could not be copied: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return null;
    } finally {
      await handle?.close().catch((): void => undefined);
    }
  }
}

/**
 * Copies an open source into a new file. Exclusive (`wx`, the counterpart of
 * `COPYFILE_EXCL`), so a re-import reuses the copy an earlier run made and
 * gets EEXIST; a copy that fails partway is removed so it is never reused.
 * At most {@link MAX_T3_ATTACHMENT_BYTES} are read even if the file grows.
 */
async function copyThroughHandle(
  source: FileHandle,
  destination: string,
): Promise<void> {
  const target = await open(destination, 'wx');
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    while (position < MAX_T3_ATTACHMENT_BYTES) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, MAX_T3_ATTACHMENT_BYTES - position),
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += (await target.write(buffer, written, bytesRead - written))
          .bytesWritten;
      }
      position += bytesRead;
    }
  } catch (error) {
    await target.close().catch((): void => undefined);
    await rm(destination, { force: true });
    throw error;
  }
  await target.close();
}

async function messageFrom(
  message: T3Message,
  attachments: ReadonlyMap<string, T3Attachment>,
  copier: AttachmentCopier,
  timestamp: number,
): Promise<PersistedChatMessage | null> {
  const attachmentPaths: string[] = [];
  const unavailable: string[] = [];
  for (const attachmentId of message.attachmentIds) {
    const attachment = attachments.get(attachmentId);
    const copied = attachment ? await copier.copy(attachment) : null;
    if (copied) attachmentPaths.push(copied);
    else
      unavailable.push(
        `Attachment unavailable: ${attachment?.name ?? attachment?.mimeType ?? attachmentId}`,
      );
  }
  const text = [message.text.trim(), ...unavailable].filter(Boolean).join('\n');
  if (!text && attachmentPaths.length === 0) return null;
  return {
    id: messageId(`t3:${message.id}`, 0),
    role: message.role,
    timestamp,
    blocks: [{ type: 'text', text }],
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
  };
}

/**
 * Projects one thread. Messages keep their `created_at` order and turn items
 * their `ordinal` order; the two are merged by time, a message first on a tie
 * (a prompt precedes the commands it started). The title is `null`: the
 * thread's own title comes from discovery.
 */
export async function projectT3Thread(
  thread: T3ThreadTranscript,
  options: T3ProjectionOptions,
): Promise<ProjectedTranscript> {
  const warnings: string[] = [];
  const copier = new AttachmentCopier(options, warnings);
  const attachments = new Map(
    thread.attachments.map((attachment) => [attachment.id, attachment]),
  );
  const messages: PersistedChatMessage[] = [];
  let clock = Date.now();
  let nextMessage = 0;
  let nextItem = 0;
  while (
    nextMessage < thread.messages.length ||
    nextItem < thread.items.length
  ) {
    const message = thread.messages[nextMessage];
    const item = thread.items[nextItem];
    const messageAt = message ? (timeOf(message.createdAt) ?? clock) : null;
    const itemAt = item ? (itemTime(item) ?? clock) : null;
    if (
      message &&
      messageAt !== null &&
      (itemAt === null || messageAt <= itemAt)
    ) {
      nextMessage += 1;
      clock = messageAt;
      const projected = await messageFrom(
        message,
        attachments,
        copier,
        messageAt,
      );
      if (projected) messages.push(projected);
    } else if (item && itemAt !== null) {
      nextItem += 1;
      clock = itemAt;
      messages.push(...itemMessages(item, itemAt));
    }
  }
  return {
    messages,
    title: null,
    firstTimestamp: messages[0]?.timestamp ?? null,
    warnings,
  };
}
