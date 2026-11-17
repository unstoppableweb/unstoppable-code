import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCodeReviewRegistryFilePath } from './paths';
import { isErrnoException, isRecord } from './type-guards';
import { writeFileAtomically } from './atomic-file';
import {
  assertCodeReviewStorageWriter,
  withCodeReviewTargetLifecycle,
} from './code-review-storage-admission';

/**
 * The real project/worktree a code-review chat scope runs against. The
 * code-review sentinel scope uses `projectId = CODE_REVIEW_CHAT_PROJECT_ID` and
 * `worktreeId = <scopeKey>` (the `projectId--worktreeId` composite, because
 * worktree ids are only unique within a workspace). This ref maps that
 * composite scope key back to the REAL `(projectId, worktreeId)` whose checkout
 * the code-review session runs in. The registry maps `scopeKey -> ref`; the ref
 * stores both real ids so no callsite ever has to parse the composite.
 */
export interface CodeReviewTargetRef {
  projectId: string;
  worktreeId: string;
}

export interface CodeReviewTargetEntry extends CodeReviewTargetRef {
  incarnation?: string;
  state?: 'active' | 'retiring';
}

export class CodeReviewTargetOwnershipError extends Error {
  public constructor(public readonly reason: 'owner_changed' | 'retiring') {
    super(`Code review target refused: ${reason}`);
    this.name = 'CodeReviewTargetOwnershipError';
  }
}

interface CodeReviewRegistryFile {
  version: 1;
  targets: Record<string, CodeReviewTargetEntry>;
}

function isCodeReviewTargetRef(value: unknown): value is CodeReviewTargetRef {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    (value.incarnation === undefined ||
      (typeof value.incarnation === 'string' &&
        value.incarnation.length > 0)) &&
    (value.state === undefined ||
      value.state === 'active' ||
      value.state === 'retiring')
  );
}

function isCodeReviewRegistryFile(
  value: unknown,
): value is CodeReviewRegistryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.targets)) {
    return false;
  }
  return Object.values(value.targets).every(isCodeReviewTargetRef);
}

function emptyRegistry(): CodeReviewRegistryFile {
  return { version: 1, targets: {} };
}

function parseRegistry(raw: string): CodeReviewRegistryFile {
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed) && parsed.version !== 1) {
    throw new Error('Code review registry has an unsupported version.');
  }
  if (!isCodeReviewRegistryFile(parsed)) {
    throw new Error('Code review registry contains invalid data.');
  }
  return parsed;
}

/**
 * Cache keyed by resolved path and last-modified time (ms).
 * `resolveWorktreeCwd` is synchronous and may be called per turn, so
 * the synchronous read below avoids re-parsing the (tiny) registry file unless
 * it has actually changed on disk.
 */
let cachedRegistry: {
  filePath: string;
  mtimeMs: number;
  file: CodeReviewRegistryFile;
} | null = null;

async function readRegistryText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return JSON.stringify(emptyRegistry());
    }
    throw error;
  }
}

async function readRegistry(filePath: string): Promise<CodeReviewRegistryFile> {
  return parseRegistry(await readRegistryText(filePath));
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutateRegistry(
  filePath: string,
  update: (
    current: CodeReviewRegistryFile,
    raw: string,
  ) => CodeReviewRegistryFile | string,
): Promise<void> {
  const operation = mutationQueue.then(async () => {
    try {
      assertCodeReviewStorageWriter(
        'code_review_registry',
        'main/lib/code-review-registry',
      );
      assertCodeReviewStorageWriter(
        'code_review_chats_dir',
        'main/lib/code-review-registry',
      );
      const raw = await readRegistryText(filePath);
      const next = update(parseRegistry(raw), raw);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFileAtomically(
        filePath,
        typeof next === 'string' ? next : JSON.stringify(next, null, 2),
        {
          encoding: 'utf8',
          durable: true,
          admittedWriter: {
            namespace: 'code_review_registry',
            writer: 'electron_main',
            module: 'main/lib/code-review-registry',
          },
        },
      );
    } finally {
      // A failed post-install sync can leave the new file visible, not rolled back.
      cachedRegistry = null;
    }
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function registerCodeReviewTarget(
  scopeKey: string,
  ref: CodeReviewTargetRef,
): Promise<void> {
  const filePath = getCodeReviewRegistryFilePath();
  // Copy before waiting: callers cannot change ownership behind the lease.
  const owner = { projectId: ref.projectId, worktreeId: ref.worktreeId };
  return withCodeReviewTargetLifecycle(filePath, scopeKey, async (waited) => {
    const existing = ownTarget(await readRegistry(filePath), scopeKey);
    if (existing && !sameOwner(existing, owner))
      throw new CodeReviewTargetOwnershipError('owner_changed');
    if (existing?.state === 'retiring') {
      if (waited) throw new CodeReviewTargetOwnershipError('retiring');
      // Approved q-18 policy: only the persisted retirement authorizes recovery.
      const { retireCodeReviewTarget } = await import('./code-review-cleanup');
      await retireCodeReviewTarget(filePath, scopeKey, existing);
    }
    await mutateRegistry(filePath, (current, raw) => {
      const target = ownTarget(current, scopeKey);
      if (target) {
        if (!sameOwner(target, owner))
          throw new CodeReviewTargetOwnershipError('owner_changed');
        if (target.state === 'retiring')
          throw new CodeReviewTargetOwnershipError('retiring');
        // Presence can follow an outcome-unknown flush. Reconfirm durability
        // without changing the incarnation, extensions or original bytes.
        return raw;
      }
      // Define an own key even when downlevel compilation would invoke __proto__.
      Object.defineProperty(current.targets, scopeKey, {
        value: { ...owner, incarnation: randomUUID(), state: 'active' },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return current;
    });
  });
}

function sameOwner(a: CodeReviewTargetRef, b: CodeReviewTargetRef): boolean {
  return a.projectId === b.projectId && a.worktreeId === b.worktreeId;
}

function sameEntry(
  a: CodeReviewTargetEntry,
  b: CodeReviewTargetEntry,
): boolean {
  return (
    sameOwner(a, b) &&
    (a.incarnation ?? 'legacy') === (b.incarnation ?? 'legacy')
  );
}

/** Compare before any destructive effect, and again before retiring the row. */
export function markCodeReviewTargetRetiring(
  filePath: string,
  scopeKey: string,
  expected: CodeReviewTargetEntry,
): Promise<void> {
  return mutateRegistry(filePath, (current) => {
    const target = ownTarget(current, scopeKey);
    if (!target || !sameEntry(target, expected))
      throw new CodeReviewTargetOwnershipError('owner_changed');
    // A visible marker may follow an outcome-unknown flush. Reconfirm durability
    // on every retry before teardown, even if it already says retiring.
    target.state = 'retiring';
    target.incarnation ??= 'legacy';
    return current;
  });
}

function ownTarget(
  file: CodeReviewRegistryFile,
  scopeKey: string,
): CodeReviewTargetEntry | null {
  return Object.prototype.hasOwnProperty.call(file.targets, scopeKey)
    ? file.targets[scopeKey]
    : null;
}

function activeTarget(
  file: CodeReviewRegistryFile,
  scopeKey: string,
): CodeReviewTargetRef | null {
  const target = ownTarget(file, scopeKey);
  return target && target.state !== 'retiring'
    ? { projectId: target.projectId, worktreeId: target.worktreeId }
    : null;
}

export async function getCodeReviewTarget(
  scopeKey: string,
): Promise<CodeReviewTargetRef | null> {
  try {
    return activeTarget(
      await readRegistry(getCodeReviewRegistryFilePath()),
      scopeKey,
    );
  } catch {
    // Lookup compatibility is permissive; mutation and cleanup reads are not.
    return null;
  }
}

/**
 * Synchronous registry read for `resolveWorktreeCwd`, which is synchronous.
 * Reads the tiny registry file via `readFileSync` and caches the parsed result
 * keyed by path and mtime so repeated cwd resolutions avoid re-reading and
 * re-parsing unless the registry changed.
 */
export function getCodeReviewTargetSync(
  scopeKey: string,
): CodeReviewTargetRef | null {
  const filePath = getCodeReviewRegistryFilePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    cachedRegistry = null;
    return null;
  }

  if (
    !cachedRegistry ||
    cachedRegistry.filePath !== filePath ||
    cachedRegistry.mtimeMs !== mtimeMs
  ) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      cachedRegistry = { filePath, mtimeMs, file: parseRegistry(raw) };
    } catch {
      cachedRegistry = null;
      return null;
    }
  }

  return activeTarget(cachedRegistry.file, scopeKey);
}

/** Keep service admission closed after a failed cleanup, including restart. */
export function isCodeReviewTargetRetiringSync(scopeKey: string): boolean {
  getCodeReviewTargetSync(scopeKey);
  return (
    cachedRegistry !== null &&
    ownTarget(cachedRegistry.file, scopeKey)?.state === 'retiring'
  );
}

/** Unknown ownership must reject cleanup, not masquerade as an empty sweep. */
export async function listCodeReviewTargets(
  filePath = getCodeReviewRegistryFilePath(),
): Promise<Record<string, CodeReviewTargetEntry>> {
  return (await readRegistry(filePath)).targets;
}

export async function removeCodeReviewTarget(
  scopeKey: string,
  expected: CodeReviewTargetEntry,
  filePath: string,
): Promise<void> {
  return mutateRegistry(filePath, (current) => {
    const target = ownTarget(current, scopeKey);
    if (!target || !sameEntry(target, expected) || target.state !== 'retiring')
      throw new CodeReviewTargetOwnershipError('owner_changed');
    delete current.targets[scopeKey];
    return current;
  });
}
