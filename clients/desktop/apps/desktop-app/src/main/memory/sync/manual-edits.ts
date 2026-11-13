import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeMemoryDocumentContent } from '@canopy/memory-consolidation/document-merge';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  MEMORY_INDEX_PATH,
  MEMORY_SYNC_LIMITS,
  isMemoryDocumentPath,
  memoryDocumentContentRefusal,
  memoryDocumentIdentity,
  memorySyncJsonBytes,
  type MemoryDocumentChange,
} from '@canopy/protocol/memory-sync';
import { withMemoryWriteLock } from '../local/edit-coordination';
import {
  isMemoryMarkdownFileName,
  isNodeError,
  readMemoryFile,
} from '../local/memory-files';
import { readMemorySyncState, sha256Hex } from './replica-files';

/*
 * The documents edited in a replica and not yet committed (design §13.1): an
 * explorer save, a snapshot restore or an edit in another editor all leave a
 * document whose bytes differ from the base this replica last applied. Each
 * pass commits them as one `manual_edit` at the replica's base revision, as
 * many as one commit request carries; the rest wait for the next pass.
 */

export type MemoryReplicaEditRefusal =
  /** A topic name a replica cannot carry. */
  | 'name'
  | 'too_large'
  /** Bytes that are not UTF-8 text, which a commit cannot carry. */
  | 'not_text'
  /** Content the cloud would refuse as a secret (design §10.5). */
  | 'secret'
  /** A new topic past the scope's topic limit (design §19). */
  | 'topic_limit';

export interface MemoryReplicaEdits {
  changes: MemoryDocumentChange[];
  refused: Array<{ path: string; reason: MemoryReplicaEditRefusal }>;
  /** Edits left for a later commit because this one is full. */
  deferred: number;
}

/** What one commit may carry (design §19). */
export interface MemoryCommitBudget {
  maxChanges: number;
  /** The serialized request, envelope included. */
  maxBytes: number;
  maxTopics: number;
}

const COMMIT_BUDGET: MemoryCommitBudget = {
  maxChanges: MEMORY_SYNC_LIMITS.commitChangesMax,
  maxBytes: MEMORY_SYNC_LIMITS.commitRequestMaxBytes,
  maxTopics: MEMORY_SYNC_LIMITS.topicDocumentsPerScopeMax,
};

/** Bytes of a manual edit's request without its changes, with room to spare. */
const COMMIT_ENVELOPE_BYTES = 1024;

/** A change and what it does to the scope's topic count. */
export interface MemoryCommitCandidate {
  change: MemoryDocumentChange;
  topics: -1 | 0 | 1;
}

/**
 * The candidates one commit carries, in order, within `budget`. A change
 * no request could carry is refused, and so is a new topic the scope has no
 * room for once the deletes before it are counted; whatever else does not
 * fit is deferred, so one large document never holds back the others.
 */
export function fitMemoryCommit(
  candidates: readonly MemoryCommitCandidate[],
  baseTopics: number,
  budget: MemoryCommitBudget = COMMIT_BUDGET,
): MemoryReplicaEdits {
  const fitted: MemoryReplicaEdits = { changes: [], refused: [], deferred: 0 };
  let bytes = COMMIT_ENVELOPE_BYTES;
  let topics = baseTopics;
  for (const { change, topics: added } of candidates) {
    const size = memorySyncJsonBytes(change) + 1;
    if (COMMIT_ENVELOPE_BYTES + size > budget.maxBytes) {
      fitted.refused.push({ path: change.path, reason: 'too_large' });
    } else if (added > 0 && topics + added > budget.maxTopics) {
      fitted.refused.push({ path: change.path, reason: 'topic_limit' });
    } else if (
      fitted.changes.length >= budget.maxChanges ||
      bytes + size > budget.maxBytes
    ) {
      fitted.deferred += 1;
    } else {
      fitted.changes.push(change);
      bytes += size;
      topics += added;
    }
  }
  return fitted;
}

async function liveDocumentPaths(scopeDir: string): Promise<string[]> {
  const paths =
    (await readMemoryFile(join(scopeDir, MEMORY_INDEX_PATH))) === null
      ? []
      : [MEMORY_INDEX_PATH];
  try {
    for (const entry of await readdir(join(scopeDir, 'topics'), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && isMemoryMarkdownFileName(entry.name)) {
        paths.push(`topics/${entry.name}`);
      }
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  return paths;
}

const INDEX_IDENTITY = memoryDocumentIdentity(MEMORY_INDEX_PATH);

/** A live document's bytes, and as the cloud would hold it when it is text. */
async function readNormalized(
  scopeDir: string,
  path: string,
): Promise<{ text: string | null } | null> {
  const file = await readMemoryFile(join(scopeDir, path));
  if (file === null) return null;
  return {
    text: file.text === null ? null : normalizeMemoryDocumentContent(file.text),
  };
}

/** Why the cloud would refuse `content` as a document, if it would. */
function documentRefusal(content: string): MemoryReplicaEditRefusal | null {
  const outside = memoryDocumentContentRefusal(content);
  if (outside !== null) return outside;
  return redactMemoryContent(content) === content ? null : 'secret';
}

/**
 * The replica's uncommitted document edits that one commit carries. Each
 * document is compared and sent with LF line endings, as the cloud stores
 * them, so a document saved with CRLF elsewhere is no edit, and its file is
 * left as it was saved. A topic's
 * spellings are one document: a spelling holding what the replica last
 * applied under any of them is no edit, and a commit carries one change per
 * document, so a second edited spelling waits for the next commit. Deletes
 * go first, then edits of documents the cloud holds, then new topics, so a
 * topic deleted here makes room for a new one in the same commit.
 */
export function collectReplicaEdits(
  scopeDir: string,
): Promise<MemoryReplicaEdits> {
  return withMemoryWriteLock(scopeDir, async () => {
    const refused: MemoryReplicaEdits['refused'] = [];
    const state = await readMemorySyncState(scopeDir);
    if (state === undefined || state === null) {
      return { changes: [], refused, deferred: 0 };
    }
    const base = new Map<string, { path: string; hashes: Set<string> }>();
    for (const [path, document] of Object.entries(state.baseDocuments)) {
      const identity = memoryDocumentIdentity(path);
      const known = base.get(identity) ?? { path, hashes: new Set() };
      known.hashes.add(document.contentHash);
      base.set(identity, known);
    }
    const deletes: MemoryCommitCandidate[] = [];
    const edits: MemoryCommitCandidate[] = [];
    const created: MemoryCommitCandidate[] = [];
    let respellings = 0;
    const seen = new Set<string>();
    const changed = new Set<string>();
    for (const path of (await liveDocumentPaths(scopeDir)).sort()) {
      const identity = memoryDocumentIdentity(path);
      seen.add(identity);
      if (!isMemoryDocumentPath(path)) {
        refused.push({ path, reason: 'name' });
        continue;
      }
      const read = await readNormalized(scopeDir, path);
      if (read === null) continue;
      const { text: content } = read;
      // Bytes no UTF-8 decode can round-trip: the lossy U+FFFD text a decode
      // leaves is not the document, so the file stays here untouched and the
      // scope reports it, as the cloud carries UTF-8 LF text only.
      if (content === null) {
        refused.push({ path, reason: 'not_text' });
        continue;
      }
      const contentHash = sha256Hex(content);
      if (base.get(identity)?.hashes.has(contentHash)) continue;
      if (changed.has(identity)) {
        respellings += 1;
        continue;
      }
      const reason = documentRefusal(content);
      if (reason !== null) {
        refused.push({ path, reason });
        continue;
      }
      const change: MemoryDocumentChange = {
        op: 'put',
        path,
        content,
        contentHash,
      };
      if (base.has(identity) || identity === INDEX_IDENTITY) {
        edits.push({ change, topics: 0 });
      } else {
        created.push({ change, topics: 1 });
      }
      changed.add(identity);
    }
    for (const [identity, document] of base) {
      if (!seen.has(identity)) {
        deletes.push({
          change: { op: 'delete', path: document.path },
          topics: identity === INDEX_IDENTITY ? 0 : -1,
        });
      }
    }
    const baseTopics = [...base.keys()].filter(
      (identity) => identity !== INDEX_IDENTITY,
    ).length;
    const fitted = fitMemoryCommit(
      [...deletes, ...edits, ...created],
      baseTopics,
    );
    return {
      changes: fitted.changes,
      refused: [...refused, ...fitted.refused],
      deferred: fitted.deferred + respellings,
    };
  });
}
