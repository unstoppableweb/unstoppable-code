import {
  MEMORY_SYNC_LIMITS,
  MemoryNoteSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  isMemoryUlid,
  type MemoryDeviceRef,
  type MemoryNote,
  type MemoryNoteOrigin,
  type MemoryNoteRecord,
} from '@canopy/protocol/memory-sync';
import { readMemoryNoteFrontMatter } from '../local/note-identity';
import { sha256Hex } from './replica-files';

/*
 * Inbox notes on disk and on the wire (design §10.1, §16.3). The wire body is
 * the Markdown after the front matter, line endings normalized, without the
 * blank line that separates it; the front matter fields travel as the note's
 * own fields. A pulled note is written back in the same layout, so its body
 * and hash survive the round trip.
 */

type FrontMatterValue = string | Record<string, string>;

function scalar(value: FrontMatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function block(
  value: FrontMatterValue | undefined,
): Record<string, string> | undefined {
  return typeof value === 'object' ? value : undefined;
}

function isoTime(value: string | undefined, fallbackMs: number): string {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : fallbackMs).toISOString();
}

function normalizedBody(rest: string): string {
  return rest.replace(/\r\n?/g, '\n').replace(/\0/g, '').replace(/^\n/, '');
}

function sourceField(value: string | undefined): string {
  return (value ?? '').slice(0, MEMORY_SYNC_LIMITS.sourceFieldMaxChars);
}

function noteSource(
  fields: Record<string, FrontMatterValue>,
): MemoryNote['source'] {
  const source = block(fields.source);
  if (source?.provider === undefined || source.chatId === undefined) {
    return null;
  }
  return {
    provider: sourceField(source.provider),
    chatId: sourceField(source.chatId),
    ...(source.sessionId === undefined
      ? {}
      : { sessionId: sourceField(source.sessionId) }),
  };
}

function noteOrigin(
  fields: Record<string, FrontMatterValue>,
): MemoryNoteOrigin {
  const origin = block(fields.origin);
  const projectId = MemoryProjectIdSchema.safeParse(origin?.projectId);
  const organizationId = MemoryOrganizationIdSchema.safeParse(
    origin?.organizationId,
  );
  return {
    projectId: projectId.success ? projectId.data : null,
    organizationId: organizationId.success ? organizationId.data : null,
  };
}

/** An inbox note file's wire body, or null without front matter. */
export function inboxNoteBody(content: string): string | null {
  const frontMatter = readMemoryNoteFrontMatter(content);
  return frontMatter === null ? null : normalizedBody(frontMatter.rest);
}

/**
 * The wire note for an inbox note file, or null when it cannot travel (no
 * ID, an empty body, a name a replica cannot carry).
 *
 * `device` is always `thisDevice`, the one sending the note: the server pins
 * it to the sending session and refuses any other, and `MemoryDeviceRef` is
 * the sender, not provenance. So a note this device sends that another one
 * wrote, a peer note a re-enable sends again or an edit of one made here,
 * travels as this device's. The file keeps the `device` and `deviceLabel`
 * front matter it arrived with, which is where that provenance stays and
 * what the replica reads to tell its own notes from a peer's.
 */
export function inboxNoteToWire(input: {
  fileKey: string;
  content: string;
  modifiedMs: number;
  thisDevice: MemoryDeviceRef;
}): MemoryNote | null {
  const frontMatter = readMemoryNoteFrontMatter(input.content);
  if (frontMatter === null) return null;
  const { fields } = frontMatter;
  const noteId = scalar(fields.id);
  if (!isMemoryUlid(noteId)) return null;
  const body = normalizedBody(frontMatter.rest);
  const createdAt = isoTime(scalar(fields.created), input.modifiedMs);
  const supersedes = scalar(fields.supersedes);
  const parsed = MemoryNoteSchema.safeParse({
    noteId,
    kind: 'inbox',
    fileKey: input.fileKey,
    body,
    contentHash: sha256Hex(body),
    createdAt,
    modifiedAt: isoTime(scalar(fields.modified), Date.parse(createdAt)),
    device: input.thisDevice,
    source: noteSource(fields),
    origin: noteOrigin(fields),
    ...(isMemoryUlid(supersedes) && supersedes !== noteId
      ? { supersedes }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

/** The file a pulled inbox note is written as; imports keep their body. */
export function renderPulledNote(note: MemoryNote | MemoryNoteRecord): string {
  if (note.kind === 'import') return note.body;
  const lines = [
    '---',
    `id: ${yaml(note.noteId)}`,
    ...(note.source === null
      ? []
      : [
          'source:',
          `  provider: ${yaml(note.source.provider)}`,
          `  chatId: ${yaml(note.source.chatId)}`,
          ...(note.source.sessionId === undefined
            ? []
            : [`  sessionId: ${yaml(note.source.sessionId)}`]),
        ]),
    `created: ${yaml(note.createdAt)}`,
    `modified: ${yaml(note.modifiedAt)}`,
    'type: inbox',
    `device: ${yaml(note.device.deviceId)}`,
    `deviceLabel: ${yaml(note.device.label)}`,
    ...(note.origin.projectId === null && note.origin.organizationId === null
      ? []
      : [
          'origin:',
          ...(note.origin.projectId === null
            ? []
            : [`  projectId: ${yaml(note.origin.projectId)}`]),
          ...(note.origin.organizationId === null
            ? []
            : [`  organizationId: ${yaml(note.origin.organizationId)}`]),
        ]),
    ...(note.supersedes === undefined
      ? []
      : [`supersedes: ${yaml(note.supersedes)}`]),
    '---',
  ];
  return `${lines.join('\n')}\n\n${note.body}`;
}
