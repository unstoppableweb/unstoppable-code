import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import type { StorageWriterPrincipal } from '../../storage/writer-authority';
import { damagedCopyPath } from '../damaged-copies';
import { COWORK_MANAGED_DIR_NAME_PATTERN } from '../filesystem/scope-reader';
import { w5ManifestImagePath } from '../w5/record-image-repositories';
import type {
  ExclusiveMaintenanceTarget,
  ExclusiveMaintenanceTargetRoot,
  HeldTargetRoot,
  OfflineReadPort,
} from './exclusive-window';

/** The `storage-ownership.yaml` rows that have a maintenance descriptor. */
export type ItemStoreRowId =
  | 'file_annotations'
  | 'workspace_notes'
  | 'workspace_prompts'
  | 'workspace_claude_md'
  | 'workspace_repo_rules'
  | 'cowork_managed_dir';

/**
 * Inside the window `op` may set a store file aside but never delete it: it
 * renames the file to a sibling inside the same root. Existing `.damaged-*`
 * copies stay byte-identical.
 */
export interface ItemStoreSetAsideRule {
  readonly marker: '.damaged-';
  /** The stores' own damaged-copy name: the next unused one, never a taken one. */
  copyPath(path: string, now?: number): string;
}

const SET_ASIDE: ItemStoreSetAsideRule = Object.freeze({
  marker: '.damaged-',
  copyPath: damagedCopyPath,
});

export interface ItemStoreFileDiagnosis {
  /** Relative to the root, `/`-separated. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** A set-aside copy, or a file inside a set-aside folder. */
  readonly damaged: boolean;
  /** JSON whose `version` is newer than the store's schema. */
  readonly newer: boolean;
}

/** Typed only; never persisted (D4). */
export interface ItemStoreDiagnosis {
  readonly row: ItemStoreRowId;
  readonly root: string;
  readonly status: 'present' | 'absent' | 'unreadable';
  readonly files: readonly ItemStoreFileDiagnosis[];
  /** Relative paths that could not be read. */
  readonly unreadable: readonly string[];
  /** A folder deeper than the walk bound, or files past the file bound, were left out. */
  readonly truncated: boolean;
}

/** One store's maintenance descriptor; the port stays separate (D13). */
export interface ItemStoreMaintenanceTarget extends ExclusiveMaintenanceTarget {
  readonly key: {
    readonly row: ItemStoreRowId;
    readonly subpaths?: readonly string[];
  };
  /** The row's manifest path patterns, verbatim; no resolver import (D7). */
  readonly patterns: readonly string[];
  /**
   * Writers no lock sees, accepted as residuals by whoever exposes a caller;
   * the window checks `principals` only.
   */
  readonly residualWriters: readonly StorageWriterPrincipal[];
  /** Store paths under a root, `/`-separated; `{}` is one path component. */
  entries(rootPath: string): readonly string[];
  readonly setAside: ItemStoreSetAsideRule;
  /**
   * Read-only, through the same port the window enumerates roots with. Pass
   * `window.signal`: the walk stops with its reason once it aborts.
   */
  diagnose(
    read: OfflineReadPort,
    root: HeldTargetRoot,
    signal?: AbortSignal,
  ): Promise<ItemStoreDiagnosis>;
}

export interface ItemStoreTargetOptions {
  /** Canonical data root. */
  readonly dataRoot: string;
  /** The brand's Cowork folder names, primary first (`.canopy`). */
  readonly coworkDirNames: readonly string[];
}

/**
 * Stores with a descriptor later, listed as data only (D12). Their recovery
 * owners are unchanged.
 */
export const ITEM_STORE_LATER_TARGETS = Object.freeze([
  Object.freeze({
    row: 'preferences',
    placement: 'CAN-5722',
    recoveryOwners: Object.freeze(['CAN-4407', 'CAN-4471']),
  }),
]);

// Notes and prompts are flat. The port follows symlinks, so both bounds keep
// a link out of the store (or a loop) from walking a whole tree.
const WALK_DEPTH = 4;
const WALK_FILES = 20_000;

const FILE_ANNOTATIONS_PATTERNS = [
  '<data>/app-workspaces/{}/worktree-data/{}/file-annotations.json',
  '<data>/workspaces/{}/worktree-data/{}/file-annotations.json',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathComponent(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !/[/\\\0]/.test(name);
}

/** Each pattern's container under `<data>` is a root; the rest an entry. */
function dataLayout(
  dataRoot: string,
  patterns: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const layout = new Map<string, string[]>();
  for (const pattern of patterns) {
    const segments = pattern.split('/');
    const wildcard = segments.indexOf('{}');
    if (segments[0] !== '<data>' || wildcard < 2)
      throw new Error(`Unsupported item-store pattern: ${pattern}`);
    const root = join(dataRoot, ...segments.slice(1, wildcard));
    const entries = layout.get(root) ?? [];
    entries.push(segments.slice(wildcard).join('/'));
    layout.set(root, entries);
  }
  return layout;
}

function isDamaged(path: string): boolean {
  return path.split('/').some((part) => part.includes(SET_ASIDE.marker));
}

function isNewer(
  path: string,
  bytes: Uint8Array,
  schemaVersion?: number,
): boolean {
  if (schemaVersion === undefined || !path.endsWith('.json')) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return (
      isRecord(value) &&
      typeof value.version === 'number' &&
      value.version > schemaVersion
    );
  } catch {
    return false;
  }
}

async function diagnoseRoot(
  read: OfflineReadPort,
  root: HeldTargetRoot,
  row: ItemStoreRowId,
  entries: readonly string[],
  schemaVersion: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ItemStoreDiagnosis> {
  const files: ItemStoreFileDiagnosis[] = [];
  const unreadable: string[] = [];
  let truncated = false;
  // Per store path, so one linked tree cannot crowd out the other stores.
  let budget = WALK_FILES;
  const at = (relative: string): string =>
    relative === '' ? root.path : join(root.path, ...relative.split('/'));
  const child = (parent: string, name: string): string =>
    parent === '' ? name : `${parent}/${name}`;
  async function list(
    relative: string,
  ): Promise<readonly string[] | undefined> {
    signal?.throwIfAborted();
    try {
      const names = await read.readDirectory(at(relative));
      return names && [...names].sort();
    } catch {
      unreadable.push(relative);
      return undefined;
    }
  }
  async function collect(relative: string, depth: number): Promise<void> {
    const names = await list(relative);
    if (names) {
      if (depth >= WALK_DEPTH) truncated = true;
      else
        for (const name of names)
          await collect(child(relative, name), depth + 1);
      return;
    }
    if (unreadable.includes(relative)) return;
    if (budget <= 0) {
      truncated = true;
      return;
    }
    budget -= 1;
    try {
      const bytes = await read.readFile(at(relative));
      if (bytes)
        files.push({
          path: relative,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          damaged: isDamaged(relative),
          newer:
            !isDamaged(relative) && isNewer(relative, bytes, schemaVersion),
        });
    } catch {
      unreadable.push(relative);
    }
  }
  if (root.state === 'absent')
    return {
      row,
      root: root.declaredPath,
      status: 'absent',
      files,
      unreadable,
      truncated,
    };
  if (!(await list(''))) {
    const status = unreadable.length ? 'unreadable' : 'absent';
    return {
      row,
      root: root.declaredPath,
      status,
      files,
      unreadable,
      truncated,
    };
  }
  for (const entry of entries) {
    const segments = entry.split('/');
    const store = segments[segments.length - 1];
    let parents = [''];
    for (const segment of segments.slice(0, -1)) {
      const next: string[] = [];
      for (const parent of parents)
        if (segment !== '{}') next.push(child(parent, segment));
        else
          for (const name of (await list(parent)) ?? [])
            if (isPathComponent(name)) next.push(child(parent, name));
      parents = next;
    }
    for (const parent of parents)
      for (const name of (await list(parent)) ?? [])
        if (name === store || name.startsWith(`${store}${SET_ASIDE.marker}`)) {
          budget = WALK_FILES;
          await collect(child(parent, name), 0);
        }
  }
  return {
    row,
    root: root.declaredPath,
    status: 'present',
    files,
    unreadable: [...new Set(unreadable)],
    truncated,
  };
}

function descriptor(options: {
  readonly row: ItemStoreRowId;
  readonly subpaths?: readonly string[];
  readonly patterns: readonly string[];
  readonly principals: readonly StorageWriterPrincipal[];
  readonly residualWriters?: readonly StorageWriterPrincipal[];
  readonly schemaVersion?: number;
  readonly roots: (
    read: OfflineReadPort,
  ) => Promise<readonly ExclusiveMaintenanceTargetRoot[]>;
  readonly entries: (rootPath: string) => readonly string[];
}): ItemStoreMaintenanceTarget {
  const { row, schemaVersion, entries } = options;
  return Object.freeze({
    key: Object.freeze({
      row,
      ...(options.subpaths && {
        subpaths: Object.freeze([...options.subpaths]),
      }),
    }),
    patterns: Object.freeze([...options.patterns]),
    principals: Object.freeze([...options.principals]),
    residualWriters: Object.freeze([...(options.residualWriters ?? [])]),
    roots: options.roots,
    entries,
    setAside: SET_ASIDE,
    diagnose: (
      read: OfflineReadPort,
      root: HeldTargetRoot,
      signal?: AbortSignal,
    ) =>
      diagnoseRoot(
        read,
        root,
        row,
        entries(root.declaredPath),
        schemaVersion,
        signal,
      ),
  });
}

function dataDescriptor(
  dataRoot: string,
  options: Omit<Parameters<typeof descriptor>[0], 'roots' | 'entries'>,
): ItemStoreMaintenanceTarget {
  const layout = dataLayout(dataRoot, options.patterns);
  const roots = [...layout.keys()].map(
    (path): ExclusiveMaintenanceTargetRoot => ({ path, placement: 'data' }),
  );
  return descriptor({
    ...options,
    roots: () => Promise.resolve(roots),
    entries: (rootPath) => layout.get(rootPath) ?? [],
  });
}

/**
 * Every Cowork folder this data root knows: each Cowork `workspace.json`'s
 * `externalPath`, else its managed `home/`, plus the App Advisor home. Reads
 * each on-disk `workspace.json` image as is, without the W5 commit log, and
 * every workspace folder whether indexed or not, so no bound folder is
 * missed. An unreadable manifest throws: the window refuses
 * `root-unavailable` and never treats the set as empty.
 */
async function coworkRoots(
  dataRoot: string,
  read: OfflineReadPort,
): Promise<readonly ExclusiveMaintenanceTargetRoot[]> {
  const workspaces = join(dataRoot, 'workspaces');
  const roots = new Map<string, ExclusiveMaintenanceTargetRoot>();
  const add = (path: string, placement: 'data' | 'external'): void => {
    if (!roots.has(path)) roots.set(path, { path, placement });
  };
  const ids = [...((await read.readDirectory(workspaces)) ?? [])].sort();
  for (const id of ids) {
    if (!isPathComponent(id)) continue;
    const bytes = await read.readFile(w5ManifestImagePath(workspaces, id));
    if (!bytes) continue;
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(manifest))
      throw new Error('A workspace manifest is unreadable.');
    if (manifest.type !== 'cowork') continue;
    const folder = manifest.externalPath ?? manifest.folderPath;
    if (folder === undefined || folder === null)
      add(join(workspaces, id, 'home'), 'data');
    else if (
      typeof folder === 'string' &&
      isAbsolute(folder) &&
      !folder.includes('\0')
    )
      add(resolve(folder), 'external');
    else throw new Error('A Cowork folder binding is unreadable.');
  }
  add(join(dataRoot, 'app-workspaces', APP_ADVISOR_PROJECT_ID, 'home'), 'data');
  return [...roots.values()];
}

/**
 * CAN-4498: the six item-store descriptors for one data root. Adding a store
 * adds a descriptor and a golden case; the window does not change.
 */
export function createItemStoreMaintenanceTargets(
  options: ItemStoreTargetOptions,
): readonly ItemStoreMaintenanceTarget[] {
  const { dataRoot, coworkDirNames } = options;
  if (
    !coworkDirNames.length ||
    coworkDirNames.some((name) => !COWORK_MANAGED_DIR_NAME_PATTERN.test(name))
  )
    throw new Error('Cowork folder names must be brand config folder names.');
  const coworkSubpaths = ['notes', 'prompts'] as const;
  // Attachments and artifacts-index.json stay outside the target (D10).
  const coworkEntries = coworkDirNames.flatMap((dir) =>
    coworkSubpaths.map((subpath) => `${dir}/${subpath}`),
  );
  return Object.freeze([
    dataDescriptor(dataRoot, {
      row: 'file_annotations',
      patterns: FILE_ANNOTATIONS_PATTERNS,
      // desktop_cli: the routed delete, outside Electron's delete gate (W6).
      principals: ['electron_main', 'desktop_cli'],
      schemaVersion: 1,
    }),
    dataDescriptor(dataRoot, {
      row: 'workspace_notes',
      patterns: ['<data>/workspaces/{}/notes'],
      principals: ['electron_main'],
      schemaVersion: 1,
    }),
    dataDescriptor(dataRoot, {
      row: 'workspace_prompts',
      patterns: ['<data>/workspaces/{}/prompts'],
      principals: ['electron_main'],
      schemaVersion: 1,
    }),
    // Local-only workspaces; source-backed ones write to the repository.
    dataDescriptor(dataRoot, {
      row: 'workspace_claude_md',
      patterns: [
        '<data>/workspaces/{}/CLAUDE.md',
        '<data>/workspaces/{}/AGENTS.md',
      ],
      // desktop_cli: multi-repo create writes the workspace CLAUDE.md.
      principals: ['electron_main', 'desktop_cli'],
    }),
    dataDescriptor(dataRoot, {
      row: 'workspace_repo_rules',
      patterns: ['<data>/workspaces/{}/repo-rules.json'],
      principals: ['electron_main'],
      schemaVersion: 1,
    }),
    // The manifest row's `{}/{}` patterns narrowed by the subpaths (D18).
    descriptor({
      row: 'cowork_managed_dir',
      subpaths: coworkSubpaths,
      patterns: coworkEntries.map((entry) => `{}/${entry}`),
      principals: ['electron_main'],
      // Agents run in the folder with their own file tools (W9).
      residualWriters: ['provider_native'],
      schemaVersion: 1,
      roots: (read) => coworkRoots(dataRoot, read),
      entries: () => coworkEntries,
    }),
  ]);
}
