import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { PREFERENCES_ENVELOPE_READ_VERSIONS } from '@canopy/protocol/preferences';
import {
  namespaceBackupRecordPath,
  ownerFlipRecordPath,
  parseOwnerFlipRecord,
  type OwnerFlipRecordRead,
} from '../../storage/owner-records';
import type { StorageWriterPrincipal } from '../../storage/writer-authority';
import { damagedCopyPath } from '../damaged-copies';
import { COWORK_MANAGED_DIR_NAME_PATTERN } from '../filesystem/scope-reader';
import {
  PREFERENCES_BACKUPS_FOLDER,
  PREFERENCES_FAMILY_FILES,
  PREFERENCES_NAMESPACE_ID,
} from '../preferences/family';
import { documentGeneration } from '../preferences/generation';
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
  | 'cowork_managed_dir'
  | 'preferences';

/**
 * Inside the window `op` may set a store file aside but never delete it: it
 * renames the file to a sibling inside the same root. Existing `.damaged-*`
 * copies stay byte-identical.
 */
export interface ItemStoreSetAsideRule {
  readonly marker: '.damaged-';
  /**
   * The stores' own damaged-copy name: the next unused one, never a taken
   * one. Throws for a path the store does not let `op` set aside.
   */
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
  /** The `preferences` row only. */
  readonly preferences?: PreferencesStoreDiagnosis;
}

/** A generation, or why there is none. */
export type PreferencesGenerationState = number | 'absent' | 'unreadable';

/** A document's generation against the generation record's. */
export type PreferencesGenerationRelation =
  | 'current'
  /** Stale: last-good is never restored from behind the record. */
  | 'behind'
  /** The record never trails a saved document; this one is ahead of it. */
  | 'ahead'
  | 'unknown';

/** G's (CAN-7924) last verified backup record, `namespace-backup.json`. */
export type PreferencesNamespaceBackupState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | {
      readonly kind: 'record';
      /** Data-root-relative, under `backups/preferences`. */
      readonly backupPath: string;
      /** The record's `verifiedBy` sha256; not checked against the copy. */
      readonly digest: string;
      readonly folder: 'present' | 'absent' | 'unreadable';
    };

/** What the flip still lacks (CAN-5722 r4): G's backup, R's owner-flip record. */
export type PreferencesMissingRecord = 'namespace-backup' | 'owner-flip-record';

export interface PreferencesStoreDiagnosis {
  /**
   * The top-level `version` of each JSON file in `files` (a document's
   * envelope version), by path; null when it has none.
   */
  readonly versions: Readonly<Record<string, number | null>>;
  readonly generation: {
    /** `preferences.generation.json`. */
    readonly record: PreferencesGenerationState;
    /** `preferences.json`; 0 when it predates generations. */
    readonly primary: PreferencesGenerationState;
    /** `preferences.last-good.json`; 0 when it predates generations. */
    readonly lastGood: PreferencesGenerationState;
    readonly primaryVersusRecord: PreferencesGenerationRelation;
    readonly lastGoodVersusRecord: PreferencesGenerationRelation;
  };
  /** `storage-records/preferences/owner-flip.json`; absent until the flip. */
  readonly ownerFlip: OwnerFlipRecordRead;
  readonly namespaceBackup: PreferencesNamespaceBackupState;
  /** Backup folder names under `backups/preferences`, dotted ones left out. */
  readonly namespaceBackups: readonly string[];
  /** Absent only; an unreadable record shows in its own field. */
  readonly missing: readonly PreferencesMissingRecord[];
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

/** `store` or a set-aside copy of it; a `{}` inside `store` is a nonempty part. */
function isStoreName(store: string, name: string): boolean {
  if (name === store || name.startsWith(`${store}${SET_ASIDE.marker}`))
    return true;
  const [prefix, suffix, ...rest] = store.split('{}');
  return (
    suffix !== undefined &&
    rest.length === 0 &&
    name.length > prefix.length + suffix.length &&
    name.startsWith(prefix) &&
    name.endsWith(suffix)
  );
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

/** What the walk read, for a descriptor that reports more than its files. */
interface DiagnosisObserver {
  file(path: string, bytes: Uint8Array): void;
  folder(path: string): void;
}

async function diagnoseRoot(
  read: OfflineReadPort,
  root: HeldTargetRoot,
  row: ItemStoreRowId,
  entries: readonly string[],
  schemaVersion: number | undefined,
  signal: AbortSignal | undefined,
  observe?: DiagnosisObserver,
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
      observe?.folder(relative);
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
      if (bytes) {
        files.push({
          path: relative,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          damaged: isDamaged(relative),
          newer:
            !isDamaged(relative) && isNewer(relative, bytes, schemaVersion),
        });
        observe?.file(relative, bytes);
      }
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
        if (isStoreName(store, name)) {
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
  readonly setAside?: ItemStoreSetAsideRule;
  readonly diagnose?: ItemStoreMaintenanceTarget['diagnose'];
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
    setAside: options.setAside ?? SET_ASIDE,
    diagnose:
      options.diagnose ??
      ((read: OfflineReadPort, root: HeldTargetRoot, signal?: AbortSignal) =>
        diagnoseRoot(
          read,
          root,
          row,
          entries(root.declaredPath),
          schemaVersion,
          signal,
        )),
  });
}

// The row's manifest patterns: `<data>`'s own files, so `<data>` is the root.
const PREFERENCES_PATTERNS = [
  '<data>/preferences.json',
  '<data>/preferences.backup-{}.json',
  '<data>/preferences.generation.json',
  '<data>/preferences.last-good.json',
  '<data>/preferences.json.usage-data-denied.json',
];
const PREFERENCES_ENTRIES = PREFERENCES_PATTERNS.map((pattern) =>
  pattern.slice('<data>/'.length),
);
const PREFERENCES_ROTATING_BACKUP = 'preferences.backup-{}.json';
const OWNER_FLIP_RECORD = ownerFlipRecordPath(PREFERENCES_NAMESPACE_ID);
const NAMESPACE_BACKUP_RECORD = namespaceBackupRecordPath(
  PREFERENCES_NAMESPACE_ID,
);
const ENVELOPE_READ_VERSION = Math.max(...PREFERENCES_ENVELOPE_READ_VERSIONS);
const GENERATION_RECORD_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Only the four live files, spelled exactly as `<data>/<file>`: a `.` or a
 * `..` through a link may name another file. Never the store's own
 * `preferences.backup-*` copies, which it prunes to the newest five, so a
 * set-aside copy takes the `.damaged-` name instead.
 */
function preferencesSetAside(dataRoot: string): ItemStoreSetAsideRule {
  const live = new Set<string>(
    PREFERENCES_FAMILY_FILES.map((name) => join(dataRoot, name)),
  );
  return Object.freeze({
    marker: SET_ASIDE.marker,
    copyPath: (path: string, now?: number) => {
      if (!live.has(path))
        throw new Error('Only the live preferences files can be set aside.');
      return damagedCopyPath(path, now);
    },
  });
}

/** The highest `version` a reader accepts at `path`, if it has one. */
function readableVersion(path: string): number | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (
    name === 'preferences.json' ||
    name === 'preferences.last-good.json' ||
    isStoreName(PREFERENCES_ROTATING_BACKUP, name)
  )
    return ENVELOPE_READ_VERSION;
  return name === 'preferences.generation.json'
    ? GENERATION_RECORD_VERSION
    : undefined;
}

function relation(
  document: PreferencesGenerationState,
  record: PreferencesGenerationState,
): PreferencesGenerationRelation {
  if (typeof document !== 'number' || typeof record !== 'number')
    return 'unknown';
  return document === record
    ? 'current'
    : document < record
      ? 'behind'
      : 'ahead';
}

/**
 * The generic walk over the row's files, G's backups and the row's owner
 * records, plus what each says: envelope versions, the generation against
 * its record, the owner-flip and backup records, and which of them is
 * missing. Reads only through `read`.
 */
async function diagnosePreferences(
  read: OfflineReadPort,
  root: HeldTargetRoot,
  signal: AbortSignal | undefined,
): Promise<ItemStoreDiagnosis> {
  const parsed = new Map<string, unknown>();
  const versions = new Map<string, number | null>();
  const folders = new Set<string>();
  let ownerFlipText: string | undefined;
  const base = await diagnoseRoot(
    read,
    root,
    'preferences',
    [
      ...PREFERENCES_ENTRIES,
      OWNER_FLIP_RECORD,
      NAMESPACE_BACKUP_RECORD,
      PREFERENCES_BACKUPS_FOLDER,
    ],
    undefined,
    signal,
    {
      folder: (path) => folders.add(path),
      file: (path, bytes) => {
        const text = new TextDecoder().decode(bytes);
        if (path === OWNER_FLIP_RECORD) ownerFlipText = text;
        let value: unknown = null;
        try {
          value = JSON.parse(text);
        } catch {
          // Not JSON: no version, and no record or generation either.
        }
        parsed.set(path, value);
        versions.set(
          path,
          isRecord(value) && typeof value.version === 'number'
            ? value.version
            : null,
        );
      },
    },
  );
  const unreadable = [...base.unreadable];
  // A folder where a file belongs, or a path below an unreadable folder.
  const blocked = (path: string): boolean =>
    folders.has(path) ||
    unreadable.some(
      (entry) => entry === '' || entry === path || path.startsWith(`${entry}/`),
    );
  const state = (path: string): 'present' | 'absent' | 'unreadable' =>
    parsed.has(path) ? 'present' : blocked(path) ? 'unreadable' : 'absent';

  const generationOf = (
    path: string,
    isRecordFile: boolean,
  ): PreferencesGenerationState => {
    const found = state(path);
    if (found !== 'present') return found;
    const value = parsed.get(path);
    if (!isRecord(value)) return 'unreadable';
    // The record needs its own version and a generation; a document
    // without one predates generations (0).
    if (
      isRecordFile &&
      (value.version !== GENERATION_RECORD_VERSION ||
        value.generation === undefined)
    )
      return 'unreadable';
    return documentGeneration(value) ?? 'unreadable';
  };
  const record = generationOf('preferences.generation.json', true);
  const primary = generationOf('preferences.json', false);
  const lastGood = generationOf('preferences.last-good.json', false);

  const flipState = state(OWNER_FLIP_RECORD);
  const ownerFlip: OwnerFlipRecordRead =
    flipState === 'absent'
      ? { kind: 'absent' }
      : flipState === 'unreadable' || ownerFlipText === undefined
        ? { kind: 'unreadable', reason: 'The owner record could not be read.' }
        : parseOwnerFlipRecord(ownerFlipText, PREFERENCES_NAMESPACE_ID);

  let namespaceBackups: readonly string[] = [];
  let backupsFolder: 'listed' | 'unreadable' =
    base.status === 'unreadable' ? 'unreadable' : 'listed';
  if (base.status === 'present')
    try {
      const names = await read.readDirectory(
        join(root.path, ...PREFERENCES_BACKUPS_FOLDER.split('/')),
      );
      // G's backup names have no dot; what sits beside a backup does.
      namespaceBackups = [...(names ?? [])]
        .filter((name) => !name.includes('.'))
        .sort();
    } catch {
      backupsFolder = 'unreadable';
      unreadable.push(PREFERENCES_BACKUPS_FOLDER);
    }

  const backupState = state(NAMESPACE_BACKUP_RECORD);
  const backupValue = parsed.get(NAMESPACE_BACKUP_RECORD);
  const backupName =
    isRecord(backupValue) && typeof backupValue.backupPath === 'string'
      ? backupValue.backupPath.slice(PREFERENCES_BACKUPS_FOLDER.length + 1)
      : '';
  let namespaceBackup: PreferencesNamespaceBackupState;
  if (backupState === 'absent') namespaceBackup = { kind: 'absent' };
  else if (
    backupState === 'present' &&
    isRecord(backupValue) &&
    backupValue.namespaceId === PREFERENCES_NAMESPACE_ID &&
    typeof backupValue.backupPath === 'string' &&
    backupValue.backupPath === `${PREFERENCES_BACKUPS_FOLDER}/${backupName}` &&
    isPathComponent(backupName) &&
    isRecord(backupValue.verifiedBy) &&
    typeof backupValue.verifiedBy.digest === 'string' &&
    SHA256.test(backupValue.verifiedBy.digest)
  )
    namespaceBackup = {
      kind: 'record',
      backupPath: backupValue.backupPath,
      digest: backupValue.verifiedBy.digest,
      folder:
        backupsFolder === 'unreadable'
          ? 'unreadable'
          : namespaceBackups.includes(backupName)
            ? 'present'
            : 'absent',
    };
  else
    namespaceBackup = {
      kind: 'unreadable',
      reason:
        backupState === 'unreadable'
          ? 'The backup record could not be read.'
          : 'The backup record does not name a preferences backup.',
    };

  const missing: PreferencesMissingRecord[] = [];
  if (
    namespaceBackup.kind === 'absent' ||
    (namespaceBackup.kind === 'record' && namespaceBackup.folder === 'absent')
  )
    missing.push('namespace-backup');
  if (ownerFlip.kind === 'absent') missing.push('owner-flip-record');

  return {
    ...base,
    files: base.files.map((file) => {
      const limit = readableVersion(file.path);
      const version = versions.get(file.path) ?? null;
      // The store's copies of a damaged document, and the live files a
      // restore set aside beside its backup (`<backup>.pre-restore-*`).
      const damaged =
        file.damaged ||
        (!file.path.includes('/') &&
          isStoreName(PREFERENCES_ROTATING_BACKUP, file.path)) ||
        (file.path.startsWith(`${PREFERENCES_BACKUPS_FOLDER}/`) &&
          file.path.split('/')[2].includes('.pre-restore-'));
      return {
        ...file,
        damaged,
        newer:
          !damaged &&
          limit !== undefined &&
          version !== null &&
          version > limit,
      };
    }),
    unreadable: [...new Set(unreadable)],
    preferences: {
      versions: Object.fromEntries(versions),
      generation: {
        record,
        primary,
        lastGood,
        primaryVersusRecord: relation(primary, record),
        lastGoodVersusRecord: relation(lastGood, record),
      },
      ownerFlip,
      namespaceBackup,
      namespaceBackups,
      missing,
    },
  };
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
 * CAN-4498: the item-store descriptors for one data root, and the
 * preferences one (CAN-7995). Adding a store adds a descriptor and a golden
 * case; the window does not change.
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
    // Restore before the flip and diagnosis only; not the flip backup (D22).
    // The client_preferences row stays with the client.
    descriptor({
      row: 'preferences',
      patterns: PREFERENCES_PATTERNS,
      // daemon: the admitted daemon document (CAN-7956).
      principals: ['electron_main', 'daemon'],
      roots: () => Promise.resolve([{ path: dataRoot, placement: 'data' }]),
      entries: () => PREFERENCES_ENTRIES,
      setAside: preferencesSetAside(dataRoot),
      diagnose: diagnosePreferences,
    }),
  ]);
}
