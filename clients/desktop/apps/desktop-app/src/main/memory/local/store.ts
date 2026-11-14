import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MemorySource, SearchHit } from '@canopy/desktop-shared/types';
import {
  clipAtBoundaries,
  LOCAL_MEMORY_MORE_MARKER,
  type BoundaryClip,
} from '@canopy/memory-consolidation/boundary-truncation';
import { fitMemoryIndex } from '@canopy/memory-consolidation/memory-index';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  clipMemoryReadContent,
  MEMORY_SEARCH_MAX_ARCHIVED_HITS,
  MEMORY_SEARCH_MAX_HITS,
  memoryContentLines,
  memorySearchHit,
  type MemorySearchTerms,
  memorySearchTerms,
} from '@canopy/memory-consolidation/search';
import { normalizeMemoryText as normalizeText } from '@canopy/memory-consolidation/text';
import { normalizeTopicName } from '@canopy/memory-consolidation/topic-identity';
import { withMemoryWriteLock } from './edit-coordination';
import {
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
  isNodeError,
  writeNewMemoryFile,
} from './memory-files';
import {
  memoryNoteCreatedMs,
  memoryNoteFileName,
  memoryNoteIdAt,
  withMemoryNoteId,
} from './note-identity';
import {
  LocalMemoryReplicaUnavailableError,
  localMemoryReplicaHooks,
  type LocalMemoryNoteOrigin,
} from './replica-hooks';
import { LocalMemoryScopeLockLostError } from './scope-lock';
import { LocalMemoryScopeReadOnlyError } from './scope-manifest';
import type { ResolvedLocalMemoryScope } from './scope-resolver';

const DEFAULT_RECENT_MAX_NOTES = 5;
const DEFAULT_RECENT_MAX_CHARS_PER_NOTE = 1_000;
const ARCHIVE_READ_BATCH_SIZE = 16;
const MAX_SOURCE_FIELD_CHARS = 500;
const MAX_NOTE_TEXT_CHARS = 2_000;

function clampInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

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

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function readNormalizedFile(path: string): Promise<string> {
  try {
    return normalizeText(await readFile(path, 'utf8'));
  } catch {
    return '';
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** A shared search hit for one file of a scope. */
function searchHitForFile(options: {
  fileKey: string;
  scope: 'user' | 'workspace';
  content: string;
  terms: MemorySearchTerms;
}): SearchHit | undefined {
  const hit = memorySearchHit(options);
  if (!hit) return undefined;
  const found: SearchHit = {
    fileKey: hit.fileKey,
    scope: options.scope,
    snippet: hit.snippet,
  };
  return hit.heading === undefined ? found : { ...found, heading: hit.heading };
}

/**
 * The scope's index within its line and byte limits, and whether those
 * limits cut it, so recall can say more is saved even when the clipped text
 * is small.
 */
export async function readMemoryIndex(scopeDir: string): Promise<BoundaryClip> {
  const content = await readNormalizedFile(join(scopeDir, 'MEMORY.md'));
  return content ? fitMemoryIndex(content) : { text: '', truncated: false };
}

function isAllowedMemoryFileKey(fileKey: string): boolean {
  if (fileKey === 'MEMORY.md') return true;
  if (fileKey.includes('..') || fileKey.includes('\\')) return false;
  if (/^(?:topics|inbox)\/[^/\\]+\.md$/.test(fileKey)) return true;
  const archive = /^(inbox|imported)\/\.consolidated\/([^/\\]+\.md)$/.exec(
    fileKey,
  );
  return (
    archive !== null &&
    isMemoryMarkdownFileName(archive[2]) &&
    !(archive[1] === 'inbox' && archive[2].toLowerCase().startsWith('topic-'))
  );
}

function isInsideDirectory(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * Read one exact file key returned by searchMemory. Both lexical and real paths
 * must remain under the scope directory so direct calls cannot escape through
 * traversal segments or symlinks.
 */
export async function readMemoryFile(
  scopeDir: string,
  fileKey: string,
): Promise<string | undefined> {
  const content = await readContainedMemoryFile(scopeDir, fileKey);
  return content === undefined ? undefined : clipMemoryReadContent(content);
}

/** The full file for search; tool reads apply their own output budget. */
async function readContainedMemoryFile(
  scopeDir: string,
  fileKey: string,
  canonicalScopePath?: string,
): Promise<string | undefined> {
  if (!isAllowedMemoryFileKey(fileKey)) return undefined;
  const scopePath = resolve(scopeDir);
  const filePath = resolve(scopePath, fileKey);
  if (!isInsideDirectory(scopePath, filePath)) return undefined;

  try {
    const [realScopePath, realFilePath] = await Promise.all([
      canonicalScopePath === undefined
        ? realpath(scopePath)
        : Promise.resolve(canonicalScopePath),
      realpath(filePath),
    ]);
    if (!isInsideDirectory(realScopePath, realFilePath)) return undefined;
    const content = normalizeText(await readFile(realFilePath, 'utf8'));
    return content;
  } catch {
    return undefined;
  }
}

const MAX_NOTE_NAME_ATTEMPTS = 100;

/**
 * Writes a new note create-only and whole, under the next free name. A
 * `synced` note is queued first; when its replica stopped syncing meanwhile,
 * queuing it rejects and nothing is written.
 */
async function writeNewInboxNote(
  scopeDir: string,
  filename: string,
  content: string,
  noteId: string,
  synced: boolean,
): Promise<string> {
  const inboxDir = join(scopeDir, 'inbox');
  const stem = filename.slice(0, -'.md'.length);
  for (let attempt = 1; attempt <= MAX_NOTE_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? filename : `${stem}-${attempt}.md`;
    const fileKey = `inbox/${name}`;
    // A synced note is queued under its final name before it is written.
    if (synced && (await isNameTaken(join(inboxDir, name)))) continue;
    if (synced) {
      const hooks = localMemoryReplicaHooks();
      if (hooks === null) throw new LocalMemoryReplicaUnavailableError();
      await hooks.queueNoteChange(scopeDir, { kind: 'put', fileKey, content });
    }
    try {
      await writeNewMemoryFile(scopeDir, join(inboxDir, name), content);
      return fileKey;
    } catch (error) {
      if (synced) {
        await localMemoryReplicaHooks()?.dropNoteChange(scopeDir, noteId);
      }
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
  return '';
}

async function isNameTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

/** A synced note's device and origin, after the front matter it has. */
function withReplicaNoteFields(
  content: string,
  fields: Readonly<Record<string, string>>,
  origin: LocalMemoryNoteOrigin | undefined,
): string {
  const lines = [
    ...Object.entries(fields).map(
      ([name, value]) => `${name}: ${yamlString(value)}`,
    ),
    ...(origin?.projectId === undefined && origin?.organizationId === undefined
      ? []
      : [
          'origin:',
          ...(origin.projectId === undefined
            ? []
            : [`  projectId: ${yamlString(origin.projectId)}`]),
          ...(origin.organizationId === undefined
            ? []
            : [`  organizationId: ${yamlString(origin.organizationId)}`]),
        ]),
  ];
  return content.replace('\n---\n', `\n${lines.join('\n')}\n---\n`);
}

export interface InboxNoteInput {
  text: string;
  source: MemorySource;
  /** Where the note was saved; recorded only in a synced replica. */
  origin?: LocalMemoryNoteOrigin;
}

/**
 * Saves a note into the scope's inbox under a new ID and returns its file
 * key, or '' when it could not be written. A scope a newer build made
 * read-only rejects with `LocalMemoryScopeReadOnlyError`, and a scope lock
 * another process took over before the note was written with
 * `LocalMemoryScopeLockLostError`.
 */
export function appendInboxNote(
  scopeDir: string,
  note: InboxNoteInput,
): Promise<string> {
  const target: InboxNoteTarget = {
    dir: scopeDir,
    location: 'device-local',
    signedInAccountId: null,
  };
  return saveInboxNote(() => target, note);
}

/** Where a save writes, and the signed-in account it was resolved for. */
export type InboxNoteTarget = Pick<
  ResolvedLocalMemoryScope,
  'dir' | 'location' | 'signedInAccountId'
>;

/**
 * Whether a save may follow its scope from `from` to `to`: only into the
 * replica of the account it was saved for, from that account's device-local
 * folder (its first registration) or from the copy a re-enable served
 * meanwhile (that first enable finishing). It never crosses accounts.
 */
function followsScopeMove(from: InboxNoteTarget, to: InboxNoteTarget): boolean {
  return (
    (from.location === 'device-local' || from.location === 'account-replica') &&
    to.location === 'account-replica' &&
    from.signedInAccountId !== null &&
    to.signedInAccountId === from.signedInAccountId
  );
}

/** Folder moves a save follows before it gives up. */
const MAX_SCOPE_MOVES = 2;

/**
 * {@link appendInboxNote} into the folder `resolveTarget()` names once that
 * folder's write lock is held. A save is bound to the folder and signed-in
 * account it started with: when the scope has moved meanwhile, it follows
 * only into that same account's replica (see {@link followsScopeMove}). Any
 * other move, such as a switch to another account, drops the note and
 * resolves '', so a note never reaches another account's replica or outbox.
 */
export async function saveInboxNote(
  resolveTarget: () => InboxNoteTarget,
  note: InboxNoteInput,
): Promise<string> {
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
  if (!redactedText) return '';
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
  let target = resolveTarget();
  for (let move = 0; move < MAX_SCOPE_MOVES; move += 1) {
    const { dir } = target;
    const replicaFields = localMemoryReplicaHooks()?.noteFields(dir) ?? null;
    const fileContent =
      replicaFields === null
        ? redactedContent
        : withReplicaNoteFields(redactedContent, replicaFields, note.origin);
    try {
      const outcome = await withMemoryWriteLock(
        dir,
        async (): Promise<
          { moved: InboxNoteTarget } | { moved: null; fileKey: string }
        > => {
          const current = resolveTarget();
          if (current.dir !== dir) return { moved: current };
          await ensureOwnerOnlyMemoryDir(dir, join(dir, 'inbox'));
          const fileKey = await writeNewInboxNote(
            dir,
            memoryNoteFileName(createdMs, redactedText, noteId),
            fileContent,
            noteId,
            replicaFields !== null,
          );
          return { moved: null, fileKey };
        },
      );
      if (outcome.moved !== null) {
        if (!followsScopeMove(target, outcome.moved)) {
          process.emitWarning(
            'A memory note was not saved: its scope moved while the save waited',
            { code: 'LOCAL_MEMORY_SAVE_SCOPE_MOVED' },
          );
          return '';
        }
        target = outcome.moved;
        continue;
      }
      if (outcome.fileKey && replicaFields !== null) {
        localMemoryReplicaHooks()?.noteChanged(dir);
      }
      return outcome.fileKey;
    } catch (error) {
      if (
        error instanceof LocalMemoryScopeReadOnlyError ||
        error instanceof LocalMemoryScopeLockLostError
      ) {
        throw error;
      }
      return '';
    }
  }
  return '';
}

export interface RecentInboxNote {
  fileKey: string;
  text: string;
}

/**
 * The newest inbox note bodies, each fitted to `maxCharsPerNote` at line or
 * sentence boundaries with a pointer to the full note when shortened.
 */
export async function readRecentInboxNotes(
  scopeDir: string,
  opts?: { maxNotes?: number; maxCharsPerNote?: number },
): Promise<string[]> {
  return (await readRecentInboxNoteEntries(scopeDir, opts)).map(
    (note) => note.text,
  );
}

/** {@link readRecentInboxNotes} with each note's file key. */
export async function readRecentInboxNoteEntries(
  scopeDir: string,
  opts?: { maxNotes?: number; maxCharsPerNote?: number },
): Promise<RecentInboxNote[]> {
  const maxNotes = clampInteger(opts?.maxNotes, DEFAULT_RECENT_MAX_NOTES, 100);
  const maxCharsPerNote = clampInteger(
    opts?.maxCharsPerNote,
    DEFAULT_RECENT_MAX_CHARS_PER_NOTE,
    100_000,
  );
  if (maxNotes === 0 || maxCharsPerNote === 0) return [];
  const inboxDir = join(scopeDir, 'inbox');
  // Filename timestamps only have second precision, so lexical order can
  // drop or misorder notes created within the same second; sort by mtime.
  const stamped = await Promise.all(
    (await listMarkdownFiles(inboxDir)).map(async (filename) => {
      try {
        const stats = await stat(join(inboxDir, filename));
        return { filename, modifiedMs: stats.mtimeMs };
      } catch {
        return { filename, modifiedMs: 0 };
      }
    }),
  );
  const filenames = stamped
    .sort(
      (left, right) =>
        right.modifiedMs - left.modifiedMs ||
        right.filename.localeCompare(left.filename),
    )
    .slice(0, maxNotes)
    .map((entry) => entry.filename);
  const notes: RecentInboxNote[] = [];
  for (const filename of filenames) {
    const content = await readNormalizedFile(join(inboxDir, filename));
    if (!content) continue;
    const body = memoryContentLines(content).join('\n').trim();
    if (!body) continue;
    const clipped = clipAtBoundaries(
      body,
      { maxChars: maxCharsPerNote },
      { marker: LOCAL_MEMORY_MORE_MARKER, sentences: true },
    ).text;
    if (clipped) notes.push({ fileKey: `inbox/${filename}`, text: clipped });
  }
  return notes;
}

export async function searchMemory(
  scopeDirs: { scope: 'user' | 'workspace'; dir: string }[],
  query: string,
): Promise<SearchHit[]> {
  const terms = memorySearchTerms(query);
  if (terms === null) return [];
  const hits: SearchHit[] = [];
  for (const scopeDir of scopeDirs) {
    const index = (await readMemoryIndex(scopeDir.dir)).text;
    const candidates: { fileKey: string; content: string }[] = index
      ? [{ fileKey: 'MEMORY.md', content: index }]
      : [];
    for (const folder of ['topics', 'inbox']) {
      const filenames = await listMarkdownFiles(join(scopeDir.dir, folder));
      for (const filename of filenames) {
        const content = await readNormalizedFile(
          join(scopeDir.dir, folder, filename),
        );
        if (content)
          candidates.push({ fileKey: `${folder}/${filename}`, content });
      }
    }
    for (const candidate of candidates) {
      const hit = searchHitForFile({
        fileKey: candidate.fileKey,
        scope: scopeDir.scope,
        content: candidate.content,
        terms,
      });
      if (hit) hits.push(hit);
      if (hits.length >= MEMORY_SEARCH_MAX_HITS) return hits;
    }
  }
  // Visit every live scope first: an archive in user memory must never
  // displace a live workspace match. Archives share the total result budget.
  const archiveLimit = Math.min(
    MEMORY_SEARCH_MAX_ARCHIVED_HITS,
    MEMORY_SEARCH_MAX_HITS - hits.length,
  );
  let archivedCount = 0;
  for (const scopeDir of scopeDirs) {
    // Resolve the trusted scope root once for this call, while still resolving
    // and checking every file. Never retain this across searches or accounts.
    const canonicalScopePath = await realpath(scopeDir.dir).catch(
      () => undefined,
    );
    if (canonicalScopePath === undefined) continue;
    for (const folder of ['inbox', 'imported']) {
      const archiveDir = join(scopeDir.dir, folder, '.consolidated');
      const filenames = (await listMarkdownFiles(archiveDir)).filter(
        (filename) =>
          isAllowedMemoryFileKey(`${folder}/.consolidated/${filename}`),
      );
      // Bounded parallel I/O avoids thousands of open files or retained bodies.
      // No content cache: edits, deletes and scope changes take effect next call.
      for (
        let start = 0;
        start < filenames.length;
        start += ARCHIVE_READ_BATCH_SIZE
      ) {
        const batch = await Promise.all(
          filenames
            .slice(start, start + ARCHIVE_READ_BATCH_SIZE)
            .map(async (filename) => {
              const fileKey = `${folder}/.consolidated/${filename}`;
              const content = await readContainedMemoryFile(
                scopeDir.dir,
                fileKey,
                canonicalScopePath,
              );
              if (!content) return undefined;
              const hit = searchHitForFile({
                fileKey,
                scope: scopeDir.scope,
                content,
                terms,
              });
              if (!hit) return undefined;
              try {
                // Imports and legacy notes may have no created field. Archive
                // moves preserve mtime, so it is a stable fallback, not prune time.
                const savedMs =
                  memoryNoteCreatedMs(content) ??
                  (await stat(join(archiveDir, filename))).mtimeMs;
                return {
                  ...hit,
                  archived: true,
                  savedAt: new Date(savedMs).toISOString(),
                };
              } catch {
                return undefined;
              }
            }),
        );
        for (const hit of batch) {
          if (hit) {
            hits.push(hit);
            archivedCount += 1;
            if (archivedCount >= archiveLimit) return hits;
          }
        }
      }
    }
  }
  return hits;
}

export async function listTopics(scopeDir: string): Promise<string[]> {
  // Only list names that are ALREADY in normalized form, so every listed
  // name round-trips through readTopic to the same file (a stem like
  // "release.md" from "release.md.md" normalizes to a different file and
  // must not be listed).
  return (await listMarkdownFiles(join(scopeDir, 'topics')))
    .map((filename) => filename.slice(0, -3))
    .filter((name) => normalizeTopicName(name) === name);
}

export async function readTopic(
  scopeDir: string,
  topic: string,
): Promise<string | undefined> {
  const normalizedTopic = normalizeTopicName(topic);
  if (!normalizedTopic) return undefined;
  const content = await readNormalizedFile(
    join(scopeDir, 'topics', `${normalizedTopic}.md`),
  );
  return content || undefined;
}
