import type { MemorySource } from '@canopy/desktop-shared/types';
import type { InboxNoteInput } from './store';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import { normalizeMemoryText as normalizeText } from '@canopy/memory-consolidation/text';
import {
  memoryNoteFileName,
  memoryNoteIdAt,
  withMemoryNoteId,
} from '@canopy/memory-store/note-identity';
import type { LocalMemoryNoteOrigin } from './replica-hooks';
export interface PreparedInboxNote {
  filename: string;
  noteId: string;
  content: string;
  origin?: LocalMemoryNoteOrigin;
}
const MAX_NOTE_TEXT_CHARS = 2_000;
const MAX_SOURCE_FIELD_CHARS = 500;
const yamlString = (value: string): string => JSON.stringify(value);
function normalizeSource(source: MemorySource): MemorySource {
  const normalized: MemorySource = {
    provider: normalizeText(source.provider).slice(0, MAX_SOURCE_FIELD_CHARS),
    chatId: normalizeText(source.chatId).slice(0, MAX_SOURCE_FIELD_CHARS),
  };
  const sessionId = normalizeText(source.sessionId ?? '').slice(
    0,
    MAX_SOURCE_FIELD_CHARS,
  );
  return sessionId ? { ...normalized, sessionId } : normalized;
}

export function prepareInboxNote(
  note: InboxNoteInput,
): PreparedInboxNote | null {
  // Normalize BEFORE redacting: normalization strips NUL and other control
  // bytes, so redacting first would let an obfuscated key like
  // `api\0_key=...` slip past the redaction regexes and be reconstituted
  // into a well-formed secret assignment afterwards. Both the persisted
  // body and the filename slug derive from this single normalized-then-
  // redacted value.
  const redactedText = redactMemoryContent(normalizeText(note.text)).slice(
    0,
    MAX_NOTE_TEXT_CHARS,
  );
  if (!redactedText) return null;
  const redactedSource = normalizeSource({
    provider: redactMemoryContent(normalizeText(note.source.provider)),
    chatId: redactMemoryContent(normalizeText(note.source.chatId)),
    ...(note.source.sessionId !== undefined
      ? { sessionId: redactMemoryContent(normalizeText(note.source.sessionId)) }
      : {}),
  });
  const createdMs = Date.now();
  const noteId = memoryNoteIdAt(createdMs);
  const created = new Date(createdMs).toISOString();
  const sourceLines = [
    'source:',
    `  provider: ${yamlString(redactedSource.provider)}`,
    `  chatId: ${yamlString(redactedSource.chatId)}`,
    ...(redactedSource.sessionId
      ? [`  sessionId: ${yamlString(redactedSource.sessionId)}`]
      : []),
  ];
  // The ID and the sync fields go in after redaction, which must never
  // rewrite them.
  const redactedContent = withMemoryNoteId(
    redactMemoryContent(
      [
        '---',
        ...sourceLines,
        `created: ${yamlString(created)}`,
        `modified: ${yamlString(created)}`,
        'type: inbox',
        '---',
        '',
        redactedText,
        '',
      ].join('\n'),
    ),
    noteId,
  );
  return {
    filename: memoryNoteFileName(createdMs, redactedText, noteId),
    noteId,
    content: redactedContent,
    ...(note.origin ? { origin: note.origin } : {}),
  };
}
