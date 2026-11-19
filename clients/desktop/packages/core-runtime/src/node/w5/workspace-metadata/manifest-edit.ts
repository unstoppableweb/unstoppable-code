import { normalizeWorkspacePlanDetection } from '@canopy/protocol/plan-detection';
import {
  isScriptDefinition,
  normalizeScriptInputMap,
  type ScriptInputMap,
  type ScriptOverrides,
} from '@canopy/protocol/scripts';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { classifyPersistedWorkspaceOwner } from '@canopy/protocol/workspace-owner';
import { isJsonObject } from '../file-store';
import {
  WorkspaceConfigUnreadableError,
  type WorkspaceManifestRead,
  type WorkspaceManifestRepository,
} from '../workspace-manifest-repository';
import {
  WORKSPACE_MANIFEST_KEYS,
  WORKSPACE_MANIFEST_REPOSITORY_KEYS,
} from './manifest-keys';
import type {
  W5ManifestEdit,
  W5ManifestEditOutcome,
  W5ManifestEditRead,
  W5ManifestRepositoryView,
  W5WorkspaceManifestChange,
  W5WorkspaceManifestEditor,
  W5WorkspaceManifestView,
} from './ports';

/*
 * The daemon's `workspace.json` edit port (W5d1, CAN-5522). The daemon cannot
 * run Electron's config normalization, so it parses only the fields the
 * metadata commands decide from, with the desktop read's rules, and writes
 * only the keys a change names into the stored document: every other byte,
 * the plugin-default fields included, stays as stored. A key it adds goes
 * where Electron's config write puts it (`WORKSPACE_MANIFEST_KEYS` order), so
 * a manifest Electron wrote canonically gets the bytes Electron would write.
 * A manifest Electron would also canonicalize (legacy account MCP refs,
 * hand-edited hooks, keys out of order) keeps those spellings.
 */

const LEGACY_SCRIPT_FIELDS = [
  'setupScript',
  'teardownScript',
  'runScript',
  'launchScript',
] as const;

const UNREADABLE_MESSAGE = new WorkspaceConfigUnreadableError().message;

/** The desktop read of an absent manifest: the default configuration. */
const DEFAULT_VIEW: W5WorkspaceManifestView = {
  type: 'multi-repo',
  repos: [],
};

/** The desktop's `normalizeScriptValue` for a legacy string field. */
function legacyScriptValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The desktop's `normalizeLegacyScriptFields`. */
export function readW5ManifestScripts(
  raw: Readonly<Record<string, unknown>>,
): ScriptOverrides | undefined {
  const merged: ScriptInputMap = {};
  const embedded = raw.scripts;
  if (isJsonObject(embedded)) {
    const scripts: ScriptInputMap = {};
    for (const [name, value] of Object.entries(embedded)) {
      if (
        typeof value === 'string' ||
        isScriptDefinition(value) ||
        value === null ||
        value === undefined
      )
        scripts[name] = value;
    }
    Object.assign(merged, normalizeScriptInputMap(scripts));
  }
  const legacy = (name: string, value: unknown): void => {
    if (merged[name] !== undefined) return;
    const normalized = legacyScriptValue(value);
    if (normalized !== undefined) merged[name] = normalized;
  };
  legacy('setup', raw.setupScript);
  legacy('teardown', raw.teardownScript);
  legacy('launch', raw.launchScript);
  if (merged.launch === undefined) legacy('launch', raw.runScript);
  return normalizeScriptInputMap(merged);
}

/** The desktop's `normalizeWorkspaceType`. */
function readType(
  document: Readonly<Record<string, unknown>>,
): W5WorkspaceManifestView['type'] {
  const { type } = document;
  if (type === 'single-repo' || type === 'multi-repo' || type === 'cowork')
    return type;
  return typeof document.repoPath === 'string' ? 'single-repo' : 'multi-repo';
}

/** The desktop's `normalizeWorkspaceRepo`, without the hooks no command reads. */
function readRepository(raw: unknown): W5ManifestRepositoryView | null {
  if (!isJsonObject(raw)) return null;
  const { id, name, repoPath, source, manifestUrl } = raw;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof repoPath !== 'string'
  )
    return null;
  return {
    id,
    name,
    repoPath,
    source: source === 'local' || source === 'manifest' ? source : undefined,
    manifestUrl: typeof manifestUrl === 'string' ? manifestUrl : undefined,
    scripts: readW5ManifestScripts(raw),
  };
}

interface ParsedManifest {
  view: W5WorkspaceManifestView;
  read: W5ManifestEditRead;
  /** Each parsed repository's stored entry, so an unchanged one is kept as stored. */
  stored: WeakMap<W5ManifestRepositoryView, Record<string, unknown>>;
}

/** The fields the commands decide from, as the desktop read normalizes them. */
export function readW5ManifestView(
  document: Readonly<Record<string, unknown>>,
): ParsedManifest {
  const stored = new WeakMap<
    W5ManifestRepositoryView,
    Record<string, unknown>
  >();
  const repos: W5ManifestRepositoryView[] = [];
  if (Array.isArray(document.repos)) {
    const entries: readonly unknown[] = document.repos;
    for (const entry of entries) {
      const repo = readRepository(entry);
      if (!repo || !isJsonObject(entry)) continue;
      stored.set(repo, entry);
      repos.push(repo);
    }
  }
  const {
    privateMemory,
    privateMemoryManagedBy,
    owner,
    repoPath,
    sourceRepoPath,
    temporary,
  } = document;
  const type = readType(document);
  const classifiedOwner = classifyPersistedWorkspaceOwner(owner);
  return {
    view: {
      type,
      repos,
      scripts: readW5ManifestScripts(document),
      privateMemoryManagedBy:
        privateMemoryManagedBy === 'organization' ? 'organization' : undefined,
      // The desktop read's owner: a malformed binding reads as Personal.
      ...(classifiedOwner.kind === 'organization' && {
        owner: {
          type: 'organization',
          organizationId: classifiedOwner.owner.organizationId,
        },
      }),
      ...(typeof repoPath === 'string' && { repoPath }),
      ...(typeof sourceRepoPath === 'string' && { sourceRepoPath }),
      ...(type === 'multi-repo' &&
        typeof temporary === 'boolean' && { temporary }),
    },
    read: {
      authority: 'ok',
      // The desktop read's rule: an organization marker needs a boolean.
      memoryMalformed:
        (privateMemory !== undefined && typeof privateMemory !== 'boolean') ||
        (privateMemoryManagedBy !== undefined &&
          privateMemoryManagedBy !== 'organization') ||
        (privateMemoryManagedBy === 'organization' &&
          typeof privateMemory !== 'boolean'),
    },
    stored,
  };
}

/**
 * Sets `key` in `document`, in place when it is stored, else at its canonical
 * position: before the first stored key that the config write emits after it,
 * or before the first key it does not know, which it emits last. `undefined`
 * removes the key, as the config write omits it.
 */
function setKey(
  document: Record<string, unknown>,
  key: string,
  value: unknown,
  order: readonly string[],
): Record<string, unknown> {
  if (value === undefined) {
    const next = { ...document };
    delete next[key];
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(document, key))
    return { ...document, [key]: value };
  const rank = order.indexOf(key);
  const entries = Object.entries(document);
  const at = entries.findIndex(([existing]) => {
    const existingRank = order.indexOf(existing);
    return existingRank < 0 || existingRank > rank;
  });
  entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
  return Object.fromEntries(entries);
}

/** A scope's scripts, as the config write stores them; legacy fields fold in. */
function withScripts(
  document: Record<string, unknown>,
  scripts: ScriptOverrides | undefined,
  order: readonly string[],
): Record<string, unknown> {
  let next = setKey(
    document,
    'scripts',
    normalizeScriptInputMap(scripts),
    order,
  );
  for (const field of LEGACY_SCRIPT_FIELDS)
    next = setKey(next, field, undefined, order);
  return next;
}

function writtenRepository(
  repo: W5ManifestRepositoryView,
  parsed: ParsedManifest,
  storedById: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const kept = parsed.stored.get(repo);
  if (kept) return kept;
  const order = WORKSPACE_MANIFEST_REPOSITORY_KEYS;
  const previous = storedById.get(repo.id);
  const previousView = previous ? readRepository(previous) : null;
  let next: Record<string, unknown> = previous ? { ...previous } : {};
  next = setKey(next, 'id', repo.id, order);
  next = setKey(next, 'name', repo.name, order);
  next = setKey(next, 'repoPath', repo.repoPath, order);
  next = setKey(next, 'source', repo.source, order);
  next = setKey(next, 'manifestUrl', repo.manifestUrl, order);
  const scriptsChanged =
    !previousView ||
    JSON.stringify(previousView.scripts ?? null) !==
      JSON.stringify(normalizeScriptInputMap(repo.scripts) ?? null);
  return scriptsChanged ? withScripts(next, repo.scripts, order) : next;
}

/** The stored document with `change`'s keys written as the config write would. */
export function applyW5ManifestChange(
  document: Readonly<Record<string, unknown>>,
  parsed: ParsedManifest,
  change: W5WorkspaceManifestChange,
): Record<string, unknown> {
  const order = WORKSPACE_MANIFEST_KEYS;
  let next: Record<string, unknown> = { ...document };
  const has = (key: keyof W5WorkspaceManifestChange): boolean =>
    Object.prototype.hasOwnProperty.call(change, key);
  if (has('privateMemory') && change.privateMemory !== undefined)
    next = setKey(next, 'privateMemory', change.privateMemory, order);
  if (has('repos') && change.repos) {
    const storedById = new Map<string, Record<string, unknown>>();
    const entries: readonly unknown[] = Array.isArray(document.repos)
      ? document.repos
      : [];
    for (const entry of entries)
      if (
        isJsonObject(entry) &&
        typeof entry.id === 'string' &&
        !storedById.has(entry.id)
      )
        storedById.set(entry.id, entry);
    next = setKey(
      next,
      'repos',
      change.repos.map((repo) => writtenRepository(repo, parsed, storedById)),
      order,
    );
  }
  if (has('itemSortMode'))
    next = setKey(
      next,
      'itemSortMode',
      change.itemSortMode === 'last-updated' ? 'last-updated' : undefined,
      order,
    );
  if (has('scripts')) next = withScripts(next, change.scripts, order);
  if (has('alwaysShow'))
    next = setKey(next, 'alwaysShow', change.alwaysShow, order);
  if (has('planDetection'))
    next = setKey(
      next,
      'planDetection',
      normalizeWorkspacePlanDetection(change.planDetection),
      order,
    );
  if (has('startPage'))
    next = setKey(
      next,
      'startPage',
      change.startPage === null || isProjectStartPage(change.startPage)
        ? change.startPage
        : undefined,
      order,
    );
  return next;
}

/**
 * The daemon's manifest editor over its own manifest repository. Each edit
 * reads and writes inside the repository's write queue and the caller's
 * commit scope, so the decision's preflight fences the bytes it read. Unlike
 * the desktop write, a change to a manifest that is absent is refused rather
 * than written from the default configuration: no metadata command creates a
 * manifest, and the daemon cannot build Electron's default one.
 */
export function createW5DaemonManifestEditor(
  repository: Pick<
    WorkspaceManifestRepository,
    'read' | 'serialize' | 'replaceDocument'
  >,
): W5WorkspaceManifestEditor {
  return {
    async readAuthority(workspaceId) {
      return (await repository.read(workspaceId)).authority;
    },
    edit<T>(
      workspaceId: string,
      apply: (
        view: W5WorkspaceManifestView,
        read: W5ManifestEditRead,
      ) => W5ManifestEdit<T> | Promise<W5ManifestEdit<T>>,
    ): Promise<W5ManifestEditOutcome<T>> {
      return repository.serialize(
        workspaceId,
        async (): Promise<W5ManifestEditOutcome<T>> => {
          const read: WorkspaceManifestRead =
            await repository.read(workspaceId);
          if (read.authority === 'unreadable')
            return { status: 'unreadable', message: UNREADABLE_MESSAGE };
          const parsed =
            read.authority === 'ok'
              ? readW5ManifestView(read.document)
              : undefined;
          const decided = await apply(
            parsed?.view ?? DEFAULT_VIEW,
            parsed?.read ?? { authority: 'absent', memoryMalformed: false },
          );
          if (!decided.change)
            return { status: 'edited', result: decided.result };
          if (read.authority !== 'ok' || !parsed)
            return { status: 'unreadable', message: UNREADABLE_MESSAGE };
          await repository.replaceDocument(
            workspaceId,
            applyW5ManifestChange(read.document, parsed, decided.change),
            read,
          );
          return { status: 'edited', result: decided.result };
        },
      );
    },
  };
}
