import { parseMemoryDocumentInWorker } from './parse-runner';
import {
  backfillMemoryScopeBeforeRead,
  recordMemoryEdit,
  withMemoryWriteLock,
} from './edit-coordination';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  LocalMemoryDocument,
  LocalMemoryFileSummary,
  LocalMemoryItem,
} from '@canopy/desktop-shared/types';
import {
  assertMemoryScopeLockHeld,
  isMemoryMarkdownFileName,
  isMemoryPathContained,
} from './memory-files';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  MEMORY_SUMMARY_PROBE_BYTES,
  excerptFromProbeHead,
  titleFromProbeHead,
} from '@canopy/memory-consolidation/memory-summary';
import {
  memoryNoteId,
  memoryNoteIdAt,
  withMemoryNoteId,
  withMemoryNoteScalarFields,
} from './note-identity';
import {
  assertReplicaStillSyncing,
  LocalMemoryReplicaUnavailableError,
  localMemoryReplicaHooks,
  type LocalMemoryNoteChange,
} from './replica-hooks';
import type { ResolvedLocalMemoryScope } from './scope-resolver';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const FRONT_MATTER = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;
const CHANGED_SINCE_OPENED =
  'Memory changed since you opened it. Refresh before saving.';
function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

class ExcludedMemoryFileError extends Error {}

async function safePath(scopeDir: string, fileKey: string): Promise<string> {
  if (
    typeof fileKey !== 'string' ||
    fileKey.includes('..') ||
    !/^(?:MEMORY\.md|(?:topics|inbox)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/.test(
      fileKey,
    )
  )
    throw new ExcludedMemoryFileError('Invalid memory file.');
  const root = await realpath(scopeDir);
  const lexical = resolve(scopeDir, fileKey);
  const actual = await realpath(lexical);
  if (
    !inside(root, actual) ||
    (await lstat(lexical)).isSymbolicLink() ||
    (await realpath(
      join(scopeDir, fileKey === 'MEMORY.md' ? '.' : fileKey.split('/')[0]),
    )) !== resolve(root, fileKey === 'MEMORY.md' ? '.' : fileKey.split('/')[0])
  )
    throw new ExcludedMemoryFileError('Memory links cannot be edited.');
  return actual;
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to open.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to open.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

export {
  excerptFromProbeHead,
  titleFromProbeHead,
} from '@canopy/memory-consolidation/memory-summary';

/** Unquotes a front matter scalar written as JSON (`yamlString`) or bare. */
function frontMatterScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' && parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value || undefined;
}

/** The `source` block an inbox note's front matter records, when present. */
export function sourceFromProbeHead(
  probeHead: string,
): { provider: string; chatId: string } | undefined {
  const lines = probeHead.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (end === -1) return undefined;
  let inSource = false;
  let provider: string | undefined;
  let chatId: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (/^\S/.test(line)) {
      inSource = line.trim() === 'source:';
      continue;
    }
    if (!inSource) continue;
    const match = /^\s+(provider|chatId):(.*)$/.exec(line);
    if (match?.[1] === 'provider') provider = frontMatterScalar(match[2]);
    if (match?.[1] === 'chatId') chatId = frontMatterScalar(match[2]);
  }
  return provider && chatId ? { provider, chatId } : undefined;
}

/** The device a synced note was saved on, from its front matter. */
export function deviceLabelFromProbeHead(
  probeHead: string,
): string | undefined {
  const lines = probeHead.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (end === -1) return undefined;
  for (const line of lines.slice(1, end)) {
    const match = /^deviceLabel:(.*)$/.exec(line);
    if (match) return frontMatterScalar(match[1]);
  }
  return undefined;
}

/** Reads at most the first 4 KiB of a memory file. */
async function readProbeHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MEMORY_SUMMARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function listLocalMemoryFiles(
  scopeDir: string,
): Promise<LocalMemoryFileSummary[]> {
  const folders: string[] = [];
  for (const folder of ['topics', 'inbox']) {
    if (await isMemoryPathContained(scopeDir, join(scopeDir, folder)))
      folders.push(folder);
  }
  await backfillMemoryScopeBeforeRead(scopeDir);
  const candidates = ['MEMORY.md'];
  for (const folder of folders) {
    try {
      const entries = await readdir(join(scopeDir, folder), {
        withFileTypes: true,
      });
      candidates.push(
        ...entries
          .filter(
            (entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name),
          )
          .map((entry) => `${folder}/${entry.name}`),
      );
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  if (candidates.length > MAX_FILES)
    throw new Error('There are too many memory files to browse.');
  const files: LocalMemoryFileSummary[] = [];
  for (const fileKey of candidates.sort()) {
    try {
      const path = await safePath(scopeDir, fileKey);
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      const head = await readProbeHead(path);
      const inbox = fileKey.startsWith('inbox/');
      const title = titleFromProbeHead(head, { inbox });
      const excerpt = excerptFromProbeHead(head, {
        titled: title !== undefined,
      });
      const source = inbox ? sourceFromProbeHead(head) : undefined;
      const deviceLabel = inbox ? deviceLabelFromProbeHead(head) : undefined;
      files.push({
        fileKey,
        kind:
          fileKey === 'MEMORY.md'
            ? 'index'
            : fileKey.startsWith('topics/')
              ? 'topic'
              : 'inbox',
        modifiedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        ...(title === undefined ? {} : { title }),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(source === undefined ? {} : { source }),
        ...(deviceLabel === undefined ? {} : { deviceLabel }),
      });
    } catch (error) {
      if (
        !(error instanceof ExcludedMemoryFileError) &&
        !hasErrorCode(error, 'ENOENT')
      )
        throw error;
    }
  }
  return files;
}

/** The Markdown after a file's front matter and byte order mark. */
function bodyMarkdown(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .replace(FRONT_MATTER, '')
    .replace(/^\uFEFF/, '');
}

export async function readLocalMemoryDocument(
  scopeDir: string,
  fileKey: string,
): Promise<LocalMemoryDocument> {
  await safePath(scopeDir, fileKey);
  await backfillMemoryScopeBeforeRead(scopeDir);
  const content = await readBounded(await safePath(scopeDir, fileKey));
  return {
    ...(await parseMemoryDocumentInWorker(fileKey, content)),
    markdown: bodyMarkdown(content),
  };
}

/**
 * Where an explorer write goes: the folder, and the account whose synced
 * replica it was resolved as (null for device-local memory). A bare folder
 * is bound to the replica it is when the write starts.
 */
export type LocalMemoryWriteTarget = Pick<
  ResolvedLocalMemoryScope,
  'dir' | 'accountId'
>;

function writeTarget(
  target: string | LocalMemoryWriteTarget,
): LocalMemoryWriteTarget {
  return typeof target === 'string'
    ? {
        dir: target,
        accountId: localMemoryReplicaHooks()?.replicaAccountId(target) ?? null,
      }
    : target;
}

export function mutateLocalMemoryItem(
  scope: string | LocalMemoryWriteTarget,
  request: { fileKey: string; itemId: string; revision: string; text?: string },
): Promise<LocalMemoryDocument> {
  const target = writeTarget(scope);
  const scopeDir = target.dir;
  return withMemoryWriteLock(scopeDir, async () => {
    const path = await safePath(scopeDir, request.fileKey);
    const content = await readBounded(path);
    if (revision(content) !== request.revision)
      throw new Error(CHANGED_SINCE_OPENED);
    const find = (items: LocalMemoryItem[]): LocalMemoryItem | undefined => {
      for (const item of items) {
        if (item.id === request.itemId) return item;
        const child = find(item.children);
        if (child) return child;
      }
      return undefined;
    };
    const document = await parseMemoryDocumentInWorker(
      request.fileKey,
      content,
    );
    const item = find(document.items);
    if (!item)
      throw new Error(
        'This memory item no longer exists. Refresh before saving.',
      );
    const [start, end] = item.id.split(':').map(Number);
    let replacement = '';
    if (request.text !== undefined) {
      if (
        typeof request.text !== 'string' ||
        !request.text.trim() ||
        Buffer.byteLength(request.text, 'utf8') > MAX_FILE_BYTES
      )
        throw new Error('Enter a memory item smaller than 512 KiB.');
      replacement = redactMemoryContent(
        request.text.replace(/\r\n?/g, '\n').replace(/\0/g, ''),
      );
      if (content.includes('\r\n'))
        replacement = replacement.replace(/\n/g, '\r\n');
    }
    const edited = content.slice(0, start) + replacement + content.slice(end);
    if (Buffer.byteLength(edited, 'utf8') > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to save.');
    const { result, change } = syncedNoteEdit(
      target,
      request.fileKey,
      content,
      edited,
    );
    const updatedDocument = await parseMemoryDocumentInWorker(
      request.fileKey,
      result,
    );
    await replaceAtRevision(target, request, path, result, change);
    notifySyncedChange(scopeDir);
    return { ...updatedDocument, markdown: bodyMarkdown(result) };
  });
}

/**
 * The front matter a note edited in a synced replica takes on, or null for a
 * document or a device-local scope.
 */
function syncedNoteFields(
  scopeDir: string,
  fileKey: string,
): Readonly<Record<string, string>> | null {
  if (!fileKey.startsWith('inbox/')) return null;
  return localMemoryReplicaHooks()?.noteFields(scopeDir) ?? null;
}

/**
 * A synced note never changes once written (design §10.3): its edit becomes
 * a new note, under a new ID, that supersedes it.
 */
function asReplacementNote(
  previous: string,
  next: string,
  fields: Readonly<Record<string, string>>,
): string {
  const previousId = memoryNoteId(previous);
  return withMemoryNoteScalarFields(
    withMemoryNoteId(next, memoryNoteIdAt(Date.now())),
    previousId === null ? fields : { ...fields, supersedes: previousId },
  );
}

/** Writes `result` over the file, only while it still has the read revision. */
async function replaceAtRevision(
  target: LocalMemoryWriteTarget,
  request: { fileKey: string; revision: string },
  path: string,
  result: string,
  change?: LocalMemoryNoteChange,
): Promise<void> {
  const scopeDir = target.dir;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    // An edit cut short is finished first, so this one never builds on it.
    if (change !== undefined) {
      await localMemoryReplicaHooks()?.settleNoteChanges(scopeDir);
    }
    await mkdir(dirname(temporaryPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, result, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (
      (await safePath(scopeDir, request.fileKey)) !== path ||
      revision(await readBounded(path)) !== request.revision
    )
      throw new Error(CHANGED_SINCE_OPENED);
    assertReplicaStillSyncing(target);
    // Queued first: a synced note's edit sync cannot carry is refused
    // before anything changes.
    if (change !== undefined) {
      const hooks = localMemoryReplicaHooks();
      if (hooks === null) throw new LocalMemoryReplicaUnavailableError();
      await hooks.queueNoteChange(scopeDir, change);
    }
    await recordMemoryEdit(scopeDir);
    await assertMemoryScopeLockHeld();
    if (change === undefined) assertReplicaStillSyncing(target);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/**
 * A note edit in a synced replica: its replacement and the change to queue.
 * Decided once the lock is held, so it rejects when the replica the write
 * resolved stopped syncing while it waited.
 */
function syncedNoteEdit(
  target: LocalMemoryWriteTarget,
  fileKey: string,
  previous: string,
  next: string,
): { result: string; change?: LocalMemoryNoteChange } {
  assertReplicaStillSyncing(target);
  const fields = syncedNoteFields(target.dir, fileKey);
  if (fields === null) return { result: next };
  const result = asReplacementNote(previous, next, fields);
  return {
    result,
    change: {
      kind: 'replace',
      fileKey,
      previousContent: previous,
      content: result,
    },
  };
}

/** A synced replica commits its document edits and pushes its notes soon. */
function notifySyncedChange(scopeDir: string): void {
  localMemoryReplicaHooks()?.noteChanged(scopeDir);
}

function deletableFileKey(fileKey: string): void {
  if (!fileKey.startsWith('topics/') && !fileKey.startsWith('inbox/'))
    throw new Error('Only topics and notes can be deleted.');
}

/**
 * Replaces a memory file's Markdown body: the index, a topic or a note. The front matter block is
 * kept (an inbox note's `modified` time moves to now), and a given title
 * becomes the level-1 heading that starts the body.
 */
export async function updateLocalMemoryFile(
  scope: string | LocalMemoryWriteTarget,
  request: { fileKey: string; revision: string; title?: string; body: string },
): Promise<LocalMemoryDocument> {
  const target = writeTarget(scope);
  const scopeDir = target.dir;
  return withMemoryWriteLock(scopeDir, async () => {
    const path = await safePath(scopeDir, request.fileKey);
    const content = await readBounded(path);
    if (revision(content) !== request.revision)
      throw new Error(CHANGED_SINCE_OPENED);
    const normalize = (text: string): string =>
      text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
    const title =
      request.title === undefined
        ? undefined
        : normalize(request.title)
            .replace(/\n+/g, ' ')
            .replace(/^[ \t]+|[ \t]+$/g, '');
    // Leading blank lines and trailing newlines go; indentation and a hard
    // break's trailing spaces are Markdown and stay.
    const body = normalize(request.body)
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\n+$/, '');
    if (title === '') throw new Error('Add a title.');
    if (!body.trim() && title === undefined)
      throw new Error('Add the memory text.');
    let markdown = redactMemoryContent(
      title === undefined
        ? `${body}\n`
        : body
          ? `# ${title}\n\n${body}\n`
          : `# ${title}\n`,
    );
    const frontMatter = (FRONT_MATTER.exec(content)?.[0] ?? '').replace(
      /^(modified:)[^\r\n]*$/m,
      `$1 ${JSON.stringify(new Date().toISOString())}`,
    );
    // The blank lines between the front matter and the body stay as they were.
    const lead = /^(?:[ \t]*\r?\n)*/.exec(bodyMarkdown(content))?.[0] ?? '';
    markdown = `${frontMatter}${normalize(lead)}${markdown}`;
    if (content.includes('\r\n')) markdown = markdown.replace(/\r?\n/g, '\r\n');
    if (Buffer.byteLength(markdown, 'utf8') > MAX_FILE_BYTES)
      throw new Error('This memory file is too large to save.');
    const bom = content.startsWith('\uFEFF') && !frontMatter ? '\uFEFF' : '';
    const { result, change } = syncedNoteEdit(
      target,
      request.fileKey,
      content,
      `${bom}${markdown}`,
    );
    const updatedDocument = await parseMemoryDocumentInWorker(
      request.fileKey,
      result,
    );
    await replaceAtRevision(target, request, path, result, change);
    notifySyncedChange(scopeDir);
    return { ...updatedDocument, markdown: bodyMarkdown(result) };
  });
}

/**
 * Deletes a topic or inbox note, only while it still has the read revision.
 * A synced note's delete is queued first (a note never sent is recorded as
 * deleted here), so when removing the file fails, or the app quits before,
 * the next push finishes it.
 */
export async function deleteLocalMemoryFile(
  scope: string | LocalMemoryWriteTarget,
  request: { fileKey: string; revision: string },
): Promise<void> {
  deletableFileKey(request.fileKey);
  const target = writeTarget(scope);
  const scopeDir = target.dir;
  return withMemoryWriteLock(scopeDir, async () => {
    const path = await safePath(scopeDir, request.fileKey);
    const synced = syncedNoteFields(scopeDir, request.fileKey) !== null;
    if (synced) await localMemoryReplicaHooks()?.settleNoteChanges(scopeDir);
    const content = await readBounded(path);
    if (revision(content) !== request.revision)
      throw new Error(
        'Memory changed since you opened it. Refresh before deleting.',
      );
    assertReplicaStillSyncing(target);
    if (synced) {
      await localMemoryReplicaHooks()?.queueNoteChange(scopeDir, {
        kind: 'tombstone',
        fileKey: request.fileKey,
        content,
      });
    }
    await recordMemoryEdit(scopeDir);
    try {
      await assertMemoryScopeLockHeld();
      if (!synced) assertReplicaStillSyncing(target);
      await unlink(path);
    } finally {
      notifySyncedChange(scopeDir);
    }
  });
}
