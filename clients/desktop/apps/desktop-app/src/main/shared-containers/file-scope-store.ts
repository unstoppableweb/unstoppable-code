import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import type { SharedContainerFileScope } from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import {
  MAX_SHARED_CONTAINER_RUN_COMMANDS,
  SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN,
  isSharedContainerWebPageUrl,
} from '@canopy/protocol/shared-containers';
import { loadWorktreeBrowserState } from '../browser/browser-persistence';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getWorktreeDataRootDir,
  getWorktreeShareFileScopePath,
} from '../lib/paths';
import { isErrnoException, isRecord } from '../lib/type-guards';
import { panelLayoutPersistenceStore } from '../panels/persistence';

export const MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS = 200;
export const MAX_SHARED_CONTAINER_APPROVED_FILE_PATH_LENGTH = 1024;
export const MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS = 1000;

/** A local-file or web page browser session the pinned layout may reference. */
export interface SharedContainerPreferredLayoutBrowser {
  id: string;
  url: string;
}

/**
 * The publisher's pinned preferred layout. It holds the raw local layout and
 * the local-file and web page browser sessions that layout references, so host paths stay
 * on this machine exactly as they do in `panel-layout.json`. It is sanitized
 * at each publish and never reaches the renderer.
 */
export interface SharedContainerPreferredLayoutSnapshot {
  pinnedAt: string;
  layout: SerializablePanelLayoutFile;
  browsers?: SharedContainerPreferredLayoutBrowser[];
}

/**
 * Absent, or `enabled: true` with no snapshot, means on and not pinned yet.
 * Only an explicit `enabled: false` turns the preferred layout off, and that
 * never carries a snapshot.
 *
 * Item-id rewrites (`replaceSharedContainerScopeItemId`,
 * `removeSharedContainerScopeItemId`) carry this field through unchanged and
 * do not rewrite ids inside the snapshot layout: the publish sanitizer drops
 * panels whose chat or file is no longer published.
 */
interface PersistedSharedContainerPreferredLayout {
  enabled: boolean;
  snapshot?: SharedContainerPreferredLayoutSnapshot;
}

interface PersistedSharedContainerFileScope extends Omit<
  SharedContainerFileScope,
  'preferredLayout'
> {
  version: 1;
  includedPaths: string[];
  excludedPaths?: string[];
  legacyAllowlist?: boolean;
  includedNoteIds: string[];
  excludedNoteIds?: string[];
  includedPromptIds: string[];
  excludedPromptIds?: string[];
  runSharingEnabled: boolean;
  runSharingDisabled?: boolean;
  includedRunScripts: string[];
  excludedRunScripts?: string[];
  preferredLayout?: PersistedSharedContainerPreferredLayout;
}

type NormalizedSharedContainerFileScope = Required<
  Omit<
    SharedContainerFileScope,
    'excludedPaths' | 'legacyAllowlist' | 'preferredLayout'
  >
> &
  Pick<SharedContainerFileScope, 'excludedPaths' | 'legacyAllowlist'>;

function createEmptyState(): PersistedSharedContainerFileScope {
  return {
    version: 1,
    includedPaths: [],
    includedNoteIds: [],
    includedPromptIds: [],
    runSharingEnabled: false,
    includedRunScripts: [],
  };
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        // A note or prompt id is a file stem, so a longer one names nothing.
        .filter((item) => item.length <= 255 && /^[A-Za-z0-9_-]+$/.test(item)),
    ),
  )
    .sort()
    .slice(0, MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS);
}

/**
 * Persisted run-script names.
 *
 * Kept apart from {@link normalizeIds} because a script name is not an id: it
 * is the publisher's own `canopy.json` key, which routinely carries spaces,
 * parentheses, and dots. It is validated against the same pattern the wire
 * contract enforces, so a name that survives here cannot fail revision
 * validation later. Legacy inclusions use the wire command limit; exclusions
 * use the broader persisted-selection bound so repeatedly promoting the next
 * default script remains representable.
 */
function normalizeRunScriptNames(
  value: unknown,
  limit = MAX_SHARED_CONTAINER_RUN_COMMANDS,
): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN.test(item)),
    ),
  )
    .sort()
    .slice(0, limit);
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = posix
    .normalize(value.trim().split('\\').join('/'))
    .normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SHARED_CONTAINER_APPROVED_FILE_PATH_LENGTH ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:($|\/)/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function normalizeSharedContainerFileScope(
  value: unknown,
): NormalizedSharedContainerFileScope {
  if (!isRecord(value) || !Array.isArray(value.includedPaths)) {
    return {
      includedPaths: [],
      includedNoteIds: [],
      excludedNoteIds: [],
      includedPromptIds: [],
      excludedPromptIds: [],
      runSharingEnabled: false,
      runSharingDisabled: false,
      includedRunScripts: [],
      excludedRunScripts: [],
    };
  }
  const normalizePaths = (paths: unknown[]): string[] =>
    Array.from(
      new Set(
        paths
          .map(normalizePath)
          .filter((path): path is string => path !== null),
      ),
    )
      .sort()
      .slice(0, MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS);
  return {
    includedPaths: normalizePaths(value.includedPaths),
    ...(Array.isArray(value.excludedPaths)
      ? { excludedPaths: normalizePaths(value.excludedPaths) }
      : {}),
    ...(value.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
    includedNoteIds: normalizeIds(value.includedNoteIds),
    excludedNoteIds: normalizeIds(value.excludedNoteIds),
    includedPromptIds: normalizeIds(value.includedPromptIds),
    excludedPromptIds: normalizeIds(value.excludedPromptIds),
    runSharingEnabled: value.runSharingEnabled === true,
    runSharingDisabled: value.runSharingDisabled === true,
    includedRunScripts: normalizeRunScriptNames(value.includedRunScripts),
    excludedRunScripts: normalizeRunScriptNames(
      value.excludedRunScripts,
      MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS,
    ),
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

function normalizePreferredLayoutBrowsers(
  value: unknown,
): SharedContainerPreferredLayoutBrowser[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((browser) =>
    isRecord(browser) &&
    typeof browser.id === 'string' &&
    typeof browser.url === 'string' &&
    (browser.url.startsWith('file:') ||
      isSharedContainerWebPageUrl(browser.url))
      ? [{ id: browser.id, url: browser.url }]
      : [],
  );
}

/**
 * Returns `undefined` for the default (on, not pinned yet). A snapshot that
 * does not validate is dropped, which returns the scope to the default and
 * re-pins at the next publish.
 */
function normalizePreferredLayout(
  value: unknown,
): PersistedSharedContainerPreferredLayout | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined;
  if (!value.enabled) return { enabled: false };
  const snapshot = value.snapshot;
  if (snapshot === undefined) return undefined;
  const layout = isRecord(snapshot)
    ? migratePanelLayout(snapshot.layout)
    : null;
  if (!isRecord(snapshot) || !layout || !isIsoTimestamp(snapshot.pinnedAt)) {
    logMainProcessWarn(
      '[shared-containers] dropped an invalid preferred layout snapshot',
    );
    return undefined;
  }
  const browsers = normalizePreferredLayoutBrowsers(snapshot.browsers);
  return {
    enabled: true,
    snapshot: {
      pinnedAt: snapshot.pinnedAt,
      layout,
      ...(browsers.length > 0 ? { browsers } : {}),
    },
  };
}

function normalizeState(value: unknown): PersistedSharedContainerFileScope {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.includedPaths)
  ) {
    throw new Error('Unsupported shared-container file scope');
  }
  const scope = normalizeSharedContainerFileScope(value);
  const preferredLayout = normalizePreferredLayout(value.preferredLayout);
  return {
    version: 1,
    includedPaths: scope.includedPaths,
    ...(scope.excludedPaths !== undefined
      ? { excludedPaths: scope.excludedPaths }
      : {}),
    ...(scope.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
    includedNoteIds: scope.includedNoteIds,
    ...(scope.excludedNoteIds.length > 0
      ? { excludedNoteIds: scope.excludedNoteIds }
      : {}),
    includedPromptIds: scope.includedPromptIds,
    ...(scope.excludedPromptIds.length > 0
      ? { excludedPromptIds: scope.excludedPromptIds }
      : {}),
    runSharingEnabled: scope.runSharingEnabled,
    ...(scope.runSharingDisabled ? { runSharingDisabled: true } : {}),
    includedRunScripts: scope.includedRunScripts,
    ...(scope.excludedRunScripts.length > 0
      ? { excludedRunScripts: scope.excludedRunScripts }
      : {}),
    ...(preferredLayout ? { preferredLayout } : {}),
  };
}

/**
 * Serializes read-modify-write cycles per scope file, so a pin and a scope
 * save cannot overwrite each other's preferred-layout change.
 */
const scopeFileWriteTails = new Map<string, Promise<void>>();

/** A scope write whose caller abandoned it before it took the write lock. */
export class SharedContainerScopeWriteAbandonedError extends Error {
  constructor() {
    super('The scope save was abandoned before it wrote.');
    this.name = 'SharedContainerScopeWriteAbandonedError';
  }
}

async function withScopeFileWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = scopeFileWriteTails.get(filePath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  scopeFileWriteTails.set(filePath, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (scopeFileWriteTails.get(filePath) === tail) {
      scopeFileWriteTails.delete(filePath);
    }
  }
}

async function readPersistedState(
  projectId: string,
  worktreeId: string,
): Promise<PersistedSharedContainerFileScope | null> {
  let serialized: string;
  try {
    serialized = await readFile(
      getWorktreeShareFileScopePath(projectId, worktreeId),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
  return normalizeState(JSON.parse(serialized));
}

export function readSharedContainerFileScope(
  projectId: string,
  worktreeId: string,
): Promise<SharedContainerFileScope> {
  return readSharedContainerFileScopeFile(projectId, worktreeId);
}

async function readSharedContainerFileScopeFile(
  projectId: string,
  worktreeId: string,
): Promise<SharedContainerFileScope> {
  return projectFileScope(await readPersistedState(projectId, worktreeId));
}

/** A persisted scope as the public read answers it; null is no stored scope. */
function projectFileScope(
  state: PersistedSharedContainerFileScope | null,
): SharedContainerFileScope {
  if (!state) {
    const empty = createEmptyState();
    return {
      includedPaths: empty.includedPaths,
      includedNoteIds: empty.includedNoteIds,
      includedPromptIds: empty.includedPromptIds,
      runSharingEnabled: empty.runSharingEnabled,
      includedRunScripts: empty.includedRunScripts,
    };
  }
  return {
    includedPaths: state.includedPaths,
    ...(state.excludedPaths !== undefined
      ? { excludedPaths: state.excludedPaths }
      : {}),
    ...(state.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
    includedNoteIds: state.includedNoteIds,
    ...(state.excludedNoteIds
      ? { excludedNoteIds: state.excludedNoteIds }
      : {}),
    includedPromptIds: state.includedPromptIds,
    ...(state.excludedPromptIds
      ? { excludedPromptIds: state.excludedPromptIds }
      : {}),
    runSharingEnabled: state.runSharingEnabled,
    ...(state.runSharingDisabled ? { runSharingDisabled: true } : {}),
    includedRunScripts: state.includedRunScripts,
    ...(state.excludedRunScripts
      ? { excludedRunScripts: state.excludedRunScripts }
      : {}),
    ...(state.preferredLayout
      ? {
          preferredLayout: {
            enabled: state.preferredLayout.enabled,
            ...(state.preferredLayout.snapshot
              ? { pinnedAt: state.preferredLayout.snapshot.pinnedAt }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The pinned snapshot for the publish path, or `null` when the preferred
 * layout is off or not pinned yet. Main-only: the snapshot holds host paths.
 */
export async function readSharedContainerPreferredLayoutSnapshot(
  projectId: string,
  worktreeId: string,
): Promise<SharedContainerPreferredLayoutSnapshot | null> {
  // Under the write lock: the publish path reads this on every publish, and
  // an unlocked read could see a scope write that is only partly on disk.
  return withScopeFileWriteLock(
    getWorktreeShareFileScopePath(projectId, worktreeId),
    async () => {
      const state = await readPersistedState(projectId, worktreeId);
      return state?.preferredLayout?.snapshot ?? null;
    },
  );
}

function captureCurrentLayoutSnapshot(
  projectId: string,
  worktreeId: string,
): SharedContainerPreferredLayoutSnapshot | null {
  const layout = migratePanelLayout(
    panelLayoutPersistenceStore.loadWorktreeLayout(projectId, worktreeId),
  );
  if (!layout) return null;
  const browsers = normalizePreferredLayoutBrowsers(
    loadWorktreeBrowserState(projectId, worktreeId).state?.browsers,
  );
  return {
    pinnedAt: new Date().toISOString(),
    layout,
    ...(browsers.length > 0 ? { browsers } : {}),
  };
}

async function pinPreferredLayout(
  projectId: string,
  worktreeId: string,
  replaceExisting: boolean,
): Promise<{ pinned: boolean; fileScope: SharedContainerFileScope }> {
  const filePath = getWorktreeShareFileScopePath(projectId, worktreeId);
  return withScopeFileWriteLock(filePath, () =>
    pinPreferredLayoutLocked(projectId, worktreeId, filePath, replaceExisting),
  );
}

/** The pin itself, for a caller that holds the scope file's write lock. */
async function pinPreferredLayoutLocked(
  projectId: string,
  worktreeId: string,
  filePath: string,
  replaceExisting: boolean,
): Promise<{ pinned: boolean; fileScope: SharedContainerFileScope }> {
  const persisted = await readPersistedState(projectId, worktreeId);
  const state = persisted ?? createEmptyState();
  const unchanged = {
    pinned: false,
    fileScope: projectFileScope(persisted),
  };
  if (!replaceExisting) {
    if (state.preferredLayout?.enabled === false) return unchanged;
    if (state.preferredLayout?.snapshot) return unchanged;
  }
  const snapshot = captureCurrentLayoutSnapshot(projectId, worktreeId);
  if (!snapshot) {
    // Nothing to capture. An existing pin stays in place; only an off scope
    // is written, to turn it back on and not pinned.
    if (state.preferredLayout?.enabled !== false) return unchanged;
    return {
      pinned: false,
      fileScope: projectFileScope(
        await writePersistedState(filePath, {
          ...state,
          preferredLayout: undefined,
        }),
      ),
    };
  }
  return {
    pinned: true,
    fileScope: projectFileScope(
      await writePersistedState(filePath, {
        ...state,
        preferredLayout: { enabled: true, snapshot },
      }),
    ),
  };
}

/**
 * Pins the publisher's current layout when the preferred layout is on and not
 * pinned yet. A no-op when it is off or already pinned. With no local layout
 * file there is nothing to pin, and the scope stays on and not pinned.
 *
 * The invite path and the publish path both pin through this one function, so
 * the two writers cannot disagree on the rule. Returns whether it pinned.
 */
export function pinSharedContainerPreferredLayoutIfMissing(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  return pinPreferredLayout(projectId, worktreeId, false).then(
    ({ pinned }) => pinned,
  );
}

/**
 * Writes the public scope. `preferredLayout` follows these rules, so a writer
 * that only holds the public shape cannot destroy a pin by accident:
 * absent leaves the persisted value unchanged, `enabled: false` turns it off
 * and drops the pin, and `enabled: true` keeps an existing pin (or turns an
 * off scope back on, not pinned). `pinCurrentLayout` then pins the
 * publisher's current layout under the same lock, replacing any earlier pin;
 * with no local layout file an earlier pin is kept. `onWritten` runs once the
 * scope write has persisted, before the pin.
 */
export function writeSharedContainerFileScope(
  projectId: string,
  worktreeId: string,
  scope: SharedContainerFileScope,
  options: ScopeWriteOptions = {},
): Promise<SharedContainerFileScope> {
  return writeSharedContainerFileScopeFile(
    projectId,
    worktreeId,
    scope,
    options,
  );
}

/**
 * The public scope without `preferredLayout`. Writing it back keeps the
 * persisted value, so a toggle that lands after this read is not undone.
 */
async function readScopeForItemIdRewrite(
  projectId: string,
  worktreeId: string,
): Promise<SharedContainerFileScope> {
  const scope = {
    ...(await readSharedContainerFileScope(projectId, worktreeId)),
  };
  delete scope.preferredLayout;
  return scope;
}

export async function replaceSharedContainerScopeItemId(
  projectId: string,
  kind: 'note' | 'prompt',
  previousId: string,
  nextId: string,
): Promise<void> {
  if (previousId === nextId) return;
  let entries;
  try {
    entries = await readdir(getWorktreeDataRootDir(projectId), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const scope = await readScopeForItemIdRewrite(projectId, entry.name);
        const ids =
          kind === 'note'
            ? (scope.includedNoteIds ?? [])
            : (scope.includedPromptIds ?? []);
        const excludedIds =
          kind === 'note'
            ? (scope.excludedNoteIds ?? [])
            : (scope.excludedPromptIds ?? []);
        if (!ids.includes(previousId) && !excludedIds.includes(previousId))
          return;
        await writeSharedContainerFileScope(projectId, entry.name, {
          ...scope,
          ...(kind === 'note'
            ? {
                includedNoteIds: ids.map((id) =>
                  id === previousId ? nextId : id,
                ),
                excludedNoteIds: excludedIds.map((id) =>
                  id === previousId ? nextId : id,
                ),
              }
            : {
                includedPromptIds: ids.map((id) =>
                  id === previousId ? nextId : id,
                ),
                excludedPromptIds: excludedIds.map((id) =>
                  id === previousId ? nextId : id,
                ),
              }),
        });
      }),
  );
}

export async function removeSharedContainerScopeItemId(
  projectId: string,
  kind: 'note' | 'prompt',
  itemId: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(getWorktreeDataRootDir(projectId), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const scope = await readScopeForItemIdRewrite(projectId, entry.name);
        const ids =
          kind === 'note'
            ? (scope.includedNoteIds ?? [])
            : (scope.includedPromptIds ?? []);
        const excludedIds =
          kind === 'note'
            ? (scope.excludedNoteIds ?? [])
            : (scope.excludedPromptIds ?? []);
        if (!ids.includes(itemId) && !excludedIds.includes(itemId)) return;
        await writeSharedContainerFileScope(projectId, entry.name, {
          ...scope,
          ...(kind === 'note'
            ? {
                includedNoteIds: ids.filter((id) => id !== itemId),
                excludedNoteIds: excludedIds.filter((id) => id !== itemId),
              }
            : {
                includedPromptIds: ids.filter((id) => id !== itemId),
                excludedPromptIds: excludedIds.filter((id) => id !== itemId),
              }),
        });
      }),
  );
}

interface ScopeWriteOptions {
  signal?: AbortSignal;
  pinCurrentLayout?: boolean;
  onWritten?: () => void;
}

async function writeSharedContainerFileScopeFile(
  projectId: string,
  worktreeId: string,
  scope: SharedContainerFileScope,
  { signal, pinCurrentLayout = false, onWritten }: ScopeWriteOptions,
): Promise<SharedContainerFileScope> {
  const filePath = getWorktreeShareFileScopePath(projectId, worktreeId);
  return withScopeFileWriteLock(filePath, async () => {
    // A save its caller abandoned never writes, so it cannot overwrite a
    // newer save that took the lock first; once it writes, it finishes.
    if (signal?.aborted) throw new SharedContainerScopeWriteAbandonedError();
    const { preferredLayout: requested, ...rest } = scope;
    // A malformed scope file is replaced by this write, as it always was,
    // which drops its pin. A file that could not be read at all is not
    // malformed: failing the save keeps the pin it may hold.
    const persisted =
      requested?.enabled === false
        ? null
        : await readPersistedState(projectId, worktreeId).catch(
            (error: unknown) => {
              if (isErrnoException(error)) throw error;
              logMainProcessWarn(
                '[shared-containers] replaced a malformed share file scope',
                error,
              );
              return null;
            },
          );
    const preferredLayout =
      requested?.enabled === false
        ? { enabled: false }
        : requested?.enabled === true &&
            persisted?.preferredLayout?.enabled === false
          ? undefined
          : persisted?.preferredLayout;
    // Answered from what this write and its pin persisted, under one lock,
    // so a save that commits next cannot change this one's answer or undo it.
    const written = projectFileScope(
      await writePersistedState(
        filePath,
        {
          version: 1,
          ...rest,
          ...(preferredLayout ? { preferredLayout } : {}),
        },
        signal,
      ),
    );
    onWritten?.();
    if (!pinCurrentLayout) return written;
    return (
      await pinPreferredLayoutLocked(projectId, worktreeId, filePath, true)
    ).fileScope;
  });
}

// A save abandoned before its atomic rename or removal writes nothing; the
// pins, which follow a committed write, pass no signal.
async function writePersistedState(
  filePath: string,
  state: unknown,
  signal?: AbortSignal,
): Promise<PersistedSharedContainerFileScope | null> {
  const normalized = normalizeState(state);
  if (
    normalized.includedPaths.length === 0 &&
    (normalized.excludedPaths?.length ?? 0) === 0 &&
    !normalized.legacyAllowlist &&
    (normalized.excludedNoteIds?.length ?? 0) === 0 &&
    (normalized.excludedPromptIds?.length ?? 0) === 0 &&
    !normalized.runSharingDisabled &&
    (normalized.excludedRunScripts?.length ?? 0) === 0 &&
    // A pin or an explicit off is not a default: deleting the file would make
    // the next publish pin a different layout, or turn the layout back on.
    normalized.preferredLayout === undefined
  ) {
    if (signal?.aborted) throw new SharedContainerScopeWriteAbandonedError();
    await rm(filePath, { force: true });
    return null;
  }
  await mkdir(dirname(filePath), { recursive: true });
  // Renamed into place: the file can hold a whole layout snapshot, and the
  // public scope read does not take the write lock, so it must never see a
  // partly written file.
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    if (signal?.aborted) throw new SharedContainerScopeWriteAbandonedError();
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return normalized;
}
