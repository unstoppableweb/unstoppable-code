import { normalize } from 'node:path';
import {
  StoredAnnotationCommentThreadSchema,
  StoredFileAnnotationSchema,
  type StoredAnnotationCommentThread,
  type StoredFileAnnotation,
} from '@canopy/protocol/canopy-core';

/*
 * The documents of the v1 file-annotations state file, as its host keeps
 * them: keyed by the normalized host file path. Validation keeps the original
 * objects, so fields this version does not know survive a rewrite.
 */

export interface StoredFileAnnotationDocument {
  filePath: string;
  revision: number;
  annotations: StoredFileAnnotation[];
  commentThreads: StoredAnnotationCommentThread[];
}

export interface FileAnnotationsStateV1 {
  version: 1;
  files: StoredFileAnnotationDocument[];
}

export function isStoredFileAnnotation(
  value: unknown,
): value is StoredFileAnnotation {
  return StoredFileAnnotationSchema.safeParse(value).success;
}

export function isStoredAnnotationCommentThread(
  value: unknown,
): value is StoredAnnotationCommentThread {
  return StoredAnnotationCommentThreadSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function emptyFileAnnotationDocument(
  filePath: string,
): StoredFileAnnotationDocument {
  return {
    filePath: normalize(filePath),
    revision: 0,
    annotations: [],
    commentThreads: [],
  };
}

/** Keeps the valid entries of a collection; anything else reads as empty. */
export function validFileAnnotations(value: unknown): StoredFileAnnotation[] {
  return Array.isArray(value) ? value.filter(isStoredFileAnnotation) : [];
}

export function validAnnotationCommentThreads(
  value: unknown,
): StoredAnnotationCommentThread[] {
  return Array.isArray(value)
    ? value.filter(isStoredAnnotationCommentThread)
    : [];
}

/**
 * How many stored entries reading `value` as a collection leaves out: each
 * invalid entry, or one for a value that is not a list. An absent collection
 * holds nothing.
 */
function unreadableIn(value: unknown, valid: readonly unknown[]): number {
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length - valid.length : 1;
}

/** A document, and how many of its stored entries this version cannot read. */
function readFileAnnotationDocument(value: unknown): {
  document: StoredFileAnnotationDocument | null;
  unreadableEntries: number;
} {
  if (!isRecord(value) || typeof value.filePath !== 'string')
    return { document: null, unreadableEntries: 1 };
  const annotations = validFileAnnotations(value.annotations);
  const commentThreads = validAnnotationCommentThreads(value.commentThreads);
  return {
    document: {
      filePath: normalize(value.filePath),
      revision: storedRevision(value.revision),
      annotations,
      commentThreads,
    },
    unreadableEntries:
      unreadableIn(value.annotations, annotations) +
      unreadableIn(value.commentThreads, commentThreads),
  };
}

/** A stored or submitted document, or null without a string file path. */
export function normalizeFileAnnotationDocument(
  value: unknown,
): StoredFileAnnotationDocument | null {
  return readFileAnnotationDocument(value).document;
}

export type FileAnnotationsStateRead =
  | {
      kind: 'ok';
      state: FileAnnotationsStateV1;
      /**
       * Stored entries this version cannot read (a document without a path,
       * an invalid annotation or thread). `state` leaves them out, so a write
       * built on it drops them.
       */
      unreadableEntries: number;
    }
  | { kind: 'damaged' };

/**
 * Parses state text. A file that is not JSON, not a v1 document (a newer
 * version wrote it) or has no file list is `damaged`. Inside a v1 file,
 * entries this version cannot read are left out and counted.
 */
export function readFileAnnotationsState(
  raw: string | null,
): FileAnnotationsStateRead {
  if (raw === null)
    return {
      kind: 'ok',
      state: { version: 1, files: [] },
      unreadableEntries: 0,
    };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'damaged' };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    return { kind: 'damaged' };
  }
  const files: StoredFileAnnotationDocument[] = [];
  let unreadableEntries = 0;
  for (const entry of value.files) {
    const read = readFileAnnotationDocument(entry);
    unreadableEntries += read.unreadableEntries;
    if (read.document) files.push(read.document);
  }
  return { kind: 'ok', state: { version: 1, files }, unreadableEntries };
}

/**
 * Parses state text for a read; a damaged state reads as empty. Writes use
 * {@link readFileAnnotationsState} and refuse a damaged state instead.
 */
export function parseFileAnnotationsState(
  raw: string | null,
): FileAnnotationsStateV1 {
  const read = readFileAnnotationsState(raw);
  return read.kind === 'ok' ? read.state : { version: 1, files: [] };
}

export function serializeFileAnnotationsState(
  state: FileAnnotationsStateV1,
): string {
  return JSON.stringify(state, null, 2);
}
