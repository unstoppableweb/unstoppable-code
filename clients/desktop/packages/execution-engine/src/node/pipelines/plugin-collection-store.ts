import * as fs from 'node:fs';
import { copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  writeFileAtomically,
  type AdmittedWriterTarget,
} from '../lib/atomic-file';
import {
  damagedCopyPath,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  ensurePrivateLockDirectory,
  withOwnerLockFile,
} from '@canopy/execution-engine/node/lib/owner-lock-file';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { ChatTabPluginSelections } from '@canopy/execution-engine/execution-types';
import type {
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import { serializePipelinePreferenceLocator } from '@canopy/execution-engine/pipelines/plugin-collections';

interface PipelinePreferenceEntry {
  plugin_collections?: Record<string, PipelinePluginCollectionPreference>;
  model_aliases?: Record<string, PipelineModelAliasPreference>;
}

interface PipelinePreferencesFile {
  version: 2;
  entries: Record<string, PipelinePreferenceEntry>;
}

/** The processes that write pipeline preferences: the desktop and the CLI. */
export type PipelinePreferenceWriter = Extract<
  AdmittedWriterTarget['writer'],
  'electron_main' | 'desktop_cli'
>;

type PreferencesFileStatus =
  | 'ok'
  | 'missing'
  | 'damaged'
  | 'newer'
  | 'unreadable';

interface PreferencesFileRead {
  status: PreferencesFileStatus;
  file: PipelinePreferencesFile;
}

/** A preference write that would destroy a file this process cannot read. */
export class PipelinePreferencesWriteRefusedError extends Error {
  public constructor(
    public readonly reason: 'newer' | 'unreadable' | 'damaged-copy-failed',
  ) {
    super(
      reason === 'newer'
        ? 'Pipeline preferences were saved by a newer version. Update to change them.'
        : reason === 'unreadable'
          ? 'Pipeline preferences could not be read, so they were not changed.'
          : 'Pipeline preferences are damaged and could not be set aside, so they were not changed.',
    );
    this.name = 'PipelinePreferencesWriteRefusedError';
  }
}

const PREFERENCES_FILE_VERSION = 2;
const WRITER_MODULE =
  'packages/execution-engine/src/node/pipelines/plugin-collection-store.ts';
const LOCK_MAX_WAIT_MS = 30_000;

const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  mcpHttpAuthPreferences: [],
};

function warn(message: string): void {
  process.stderr.write(`[pipeline-plugin-preferences] ${message}\n`);
}

const warnedStatuses = new Set<PreferencesFileStatus>();

function warnOnce(status: PreferencesFileStatus, message: string): void {
  if (warnedStatuses.has(status)) return;
  warnedStatuses.add(status);
  warn(message);
}

/** `<data>/pipeline-plugin-preferences.json`, the only preference file. */
export function getPipelinePluginPreferencesFilePath(): string {
  return path.join(getCanopyDataDir(), 'pipeline-plugin-preferences.json');
}

function getPipelinePluginPreferencesLockDir(): string {
  return path.join(getCanopyDataDir(), 'locks', 'pipeline-plugin-preferences');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function normalizeCollectionIds(value: unknown): string[] {
  return normalizeStringArray(value);
}

function normalizeSkillRefs(
  value: unknown,
): ChatTabPluginSelections['skillRefs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: ChatTabPluginSelections['skillRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const sourceId =
      typeof entry.sourceId === 'string' ? entry.sourceId.trim() : '';
    const skillName =
      typeof entry.skillName === 'string' ? entry.skillName.trim() : '';
    if (!sourceId || !skillName) {
      continue;
    }
    const key = `${sourceId}\0${skillName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ sourceId, skillName });
  }
  return result;
}

function normalizePluginRefs(
  value: unknown,
): ChatTabPluginSelections['pluginRefs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: ChatTabPluginSelections['pluginRefs'] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const marketplaceId =
      typeof entry.marketplaceId === 'string' ? entry.marketplaceId.trim() : '';
    const pluginName =
      typeof entry.pluginName === 'string' ? entry.pluginName.trim() : '';
    if (!marketplaceId || !pluginName) {
      continue;
    }
    const key = `${marketplaceId}\0${pluginName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ marketplaceId, pluginName });
  }
  return result;
}

function normalizeExtraSelections(value: unknown): ChatTabPluginSelections {
  if (!isRecord(value)) {
    return { ...EMPTY_SELECTIONS };
  }

  // Migrate legacy `bundleIds` into the canonical `collectionIds` field on
  // every read so older persisted preference files round-trip cleanly.
  const collectionIds = normalizeCollectionIds(value.collectionIds);
  const legacyBundleIds = normalizeCollectionIds(value.bundleIds);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...collectionIds, ...legacyBundleIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  // A chat automation's local MCP servers, their sign-in choices and its
  // not-yet-installed capabilities convert as these preferences (CAN-5479).
  const { mcpServerRefs, mcpHttpAuthPreferences, unresolvedCapabilities } =
    normalizePluginSelections({
      mcpServerRefs: value.mcpServerRefs ?? [],
      mcpHttpAuthPreferences: value.mcpHttpAuthPreferences ?? [],
      unresolvedCapabilities: value.unresolvedCapabilities,
    });
  return {
    collectionIds: merged,
    skillRefs: normalizeSkillRefs(value.skillRefs),
    pluginRefs: normalizePluginRefs(value.pluginRefs),
    mcpServerRefs: mcpServerRefs ?? [],
    mcpHttpAuthPreferences: mcpHttpAuthPreferences ?? [],
    ...(unresolvedCapabilities !== undefined ? { unresolvedCapabilities } : {}),
  };
}

function normalizePipelinePluginCollectionPreference(
  raw: unknown,
): PipelinePluginCollectionPreference {
  const source = isRecord(raw) ? raw : {};
  return {
    disabledDefaultKeys: normalizeStringArray(source.disabledDefaultKeys),
    extraSelections: normalizeExtraSelections(source.extraSelections),
  };
}

export function normalizePipelinePluginCollectionPreferences(
  raw: unknown,
): Record<string, PipelinePluginCollectionPreference> {
  if (!isRecord(raw)) {
    return {};
  }

  const result: Record<string, PipelinePluginCollectionPreference> = {};
  for (const [collectionId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      warn(
        `Dropping invalid preference entry for collection "${collectionId}".`,
      );
      continue;
    }
    const trimmedCollectionId = collectionId.trim();
    if (!trimmedCollectionId) {
      continue;
    }
    result[trimmedCollectionId] =
      normalizePipelinePluginCollectionPreference(entry);
  }
  return result;
}

function normalizePipelineModelAliasPreference(
  raw: unknown,
): PipelineModelAliasPreference | undefined {
  if (!isRecord(raw) || typeof raw.mode !== 'string') {
    return undefined;
  }

  if (raw.mode === 'reset') {
    return undefined;
  }

  if (raw.mode === 'agent') {
    const agentId = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
    if (!agentId || !agentId.startsWith('agent_model_')) {
      return undefined;
    }
    return { mode: 'agent', agent_id: agentId };
  }

  if (raw.mode === 'inline') {
    const base = typeof raw.base === 'string' ? raw.base.trim() : '';
    if (!base) {
      return undefined;
    }
    if (
      raw.instructions !== undefined &&
      typeof raw.instructions !== 'string'
    ) {
      return undefined;
    }
    const pluginCollectionId =
      raw.plugin_collection_id === undefined
        ? undefined
        : typeof raw.plugin_collection_id === 'string'
          ? raw.plugin_collection_id.trim()
          : '';
    if (raw.plugin_collection_id !== undefined && !pluginCollectionId) {
      return undefined;
    }
    return {
      mode: 'inline',
      base,
      ...(raw.instructions !== undefined
        ? { instructions: raw.instructions }
        : {}),
      ...(pluginCollectionId
        ? { plugin_collection_id: pluginCollectionId }
        : {}),
    };
  }

  return undefined;
}

export function normalizePipelineModelAliasPreferences(
  preferences: unknown,
): Record<string, PipelineModelAliasPreference> {
  if (!isRecord(preferences)) {
    return {};
  }

  const result: Record<string, PipelineModelAliasPreference> = {};
  for (const [aliasId, entry] of Object.entries(preferences)) {
    const trimmedAliasId = aliasId.trim();
    if (!trimmedAliasId) {
      continue;
    }
    const normalized = normalizePipelineModelAliasPreference(entry);
    if (!normalized) {
      if (isRecord(entry) && entry.mode !== 'reset') {
        warn(`Dropping invalid model alias preference for "${aliasId}".`);
      }
      continue;
    }
    result[trimmedAliasId] = normalized;
  }
  return result;
}

function normalizePreferenceEntry(raw: unknown): PipelinePreferenceEntry {
  if (!isRecord(raw)) {
    return {};
  }
  return {
    plugin_collections: normalizePipelinePluginCollectionPreferences(
      raw.plugin_collections,
    ),
    model_aliases: normalizePipelineModelAliasPreferences(raw.model_aliases),
  };
}

function omitEmptyEntry(
  entry: PipelinePreferenceEntry,
): PipelinePreferenceEntry {
  const result: PipelinePreferenceEntry = {};
  if (
    entry.plugin_collections &&
    Object.keys(entry.plugin_collections).length > 0
  ) {
    result.plugin_collections = entry.plugin_collections;
  }
  if (entry.model_aliases && Object.keys(entry.model_aliases).length > 0) {
    result.model_aliases = entry.model_aliases;
  }
  return result;
}

function emptyFile(): PipelinePreferencesFile {
  return { version: PREFERENCES_FILE_VERSION, entries: {} };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function parsePreferencesFile(text: string): PreferencesFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'damaged', file: emptyFile() };
  }
  if (!isRecord(parsed)) {
    return { status: 'damaged', file: emptyFile() };
  }
  // A newer version may change the whole layout, so check it before shape.
  if (
    typeof parsed.version === 'number' &&
    parsed.version > PREFERENCES_FILE_VERSION
  ) {
    return { status: 'newer', file: emptyFile() };
  }
  if (!isRecord(parsed.entries)) {
    return { status: 'damaged', file: emptyFile() };
  }

  const entries: Record<string, PipelinePreferenceEntry> = {};
  if (parsed.version === 1) {
    for (const [locatorKey, rawPreferences] of Object.entries(parsed.entries)) {
      entries[locatorKey] = {
        plugin_collections:
          normalizePipelinePluginCollectionPreferences(rawPreferences),
      };
    }
    return { status: 'ok', file: { version: 2, entries } };
  }

  if (parsed.version !== PREFERENCES_FILE_VERSION) {
    return { status: 'damaged', file: emptyFile() };
  }

  for (const [locatorKey, rawEntry] of Object.entries(parsed.entries)) {
    entries[locatorKey] = normalizePreferenceEntry(rawEntry);
  }
  return { status: 'ok', file: { version: 2, entries } };
}

/** Reads have no side effects; a write installs a whole file atomically. */
function readPreferencesFile(): PreferencesFileRead {
  let text: string;
  try {
    text = fs.readFileSync(getPipelinePluginPreferencesFilePath(), 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { status: 'missing', file: emptyFile() }
      : { status: 'unreadable', file: emptyFile() };
  }
  return parsePreferencesFile(text);
}

function readPreferencesForDisplay(): PipelinePreferencesFile {
  const read = readPreferencesFile();
  if (read.status === 'damaged') {
    warnOnce(
      read.status,
      'Failed to parse preference file; using empty defaults.',
    );
  } else if (read.status === 'newer') {
    warnOnce(
      read.status,
      'Preference file is from a newer version; using empty defaults.',
    );
  } else if (read.status === 'unreadable') {
    warnOnce(
      read.status,
      'Preference file could not be read; using empty defaults.',
    );
  }
  return read.file;
}

function serializePreferencesFile(file: PipelinePreferencesFile): string {
  const normalizedEntries: PipelinePreferencesFile['entries'] = {};
  for (const [locatorKey, entry] of Object.entries(file.entries)) {
    const normalized = omitEmptyEntry(normalizePreferenceEntry(entry));
    if (Object.keys(normalized).length > 0) {
      normalizedEntries[locatorKey] = normalized;
    }
  }
  return `${JSON.stringify(
    { version: PREFERENCES_FILE_VERSION, entries: normalizedEntries },
    null,
    2,
  )}\n`;
}

let pendingMutation: Promise<unknown> = Promise.resolve();

/**
 * The one write path: a read-modify-write that holds this process's queue
 * and the cross-process writer lock, so desktop and CLI writes never
 * interleave, then installs the result durably before it resolves.
 */
function mutatePreferencesFile(
  writer: PipelinePreferenceWriter,
  mutate: (file: PipelinePreferencesFile) => boolean | void,
): Promise<void> {
  const run = async (): Promise<void> => {
    const lockDir = getPipelinePluginPreferencesLockDir();
    await ensurePrivateLockDirectory(lockDir);
    await withOwnerLockFile(
      path.join(lockDir, 'writer.lock'),
      () => applyMutation(writer, mutate),
      {
        maxWaitMs: LOCK_MAX_WAIT_MS,
        timeoutMessage:
          'Timed out waiting for another process to finish saving pipeline preferences.',
      },
    );
  };
  const operation = pendingMutation.then(run, run);
  pendingMutation = operation.catch(() => undefined);
  return operation;
}

async function applyMutation(
  writer: PipelinePreferenceWriter,
  mutate: (file: PipelinePreferencesFile) => boolean | void,
): Promise<void> {
  const filePath = getPipelinePluginPreferencesFilePath();
  const read = readPreferencesFile();
  if (read.status === 'newer' || read.status === 'unreadable') {
    throw new PipelinePreferencesWriteRefusedError(read.status);
  }
  if (mutate(read.file) === false) {
    return;
  }
  if (read.status === 'damaged') {
    // The damaged file stays in place until its replacement is installed.
    try {
      await copyFile(
        filePath,
        damagedCopyPath(filePath),
        fs.constants.COPYFILE_EXCL,
      );
    } catch {
      throw new PipelinePreferencesWriteRefusedError('damaged-copy-failed');
    }
    await pruneDamagedCopies(filePath);
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, serializePreferencesFile(read.file), {
    encoding: 'utf8',
    durable: true,
    admittedWriter: {
      namespace: 'pipeline_plugin_preferences',
      writer,
      module: WRITER_MODULE,
    },
  });
}

function getLegacyStoredPreferenceKey(
  locator: PipelinePreferenceLocator,
): string | undefined {
  if (locator.type !== 'stored') {
    return undefined;
  }
  return `stored:${locator.value}`;
}

function entryWithLegacyFallback(
  file: PipelinePreferencesFile,
  locatorKey: string,
  legacyKey: string | undefined,
): PipelinePreferenceEntry {
  if (!legacyKey || legacyKey === locatorKey) {
    return file.entries[locatorKey] ?? {};
  }
  return {
    ...file.entries[legacyKey],
    ...file.entries[locatorKey],
  };
}

function storedEntry(
  file: PipelinePreferencesFile,
  locator: PipelinePreferenceLocator,
): PipelinePreferenceEntry {
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const stored = file.entries[locatorKey];
  if (stored) {
    return stored;
  }
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  return (legacyKey ? file.entries[legacyKey] : undefined) ?? {};
}

/** Replaces one field of the locator's entry, folding in its legacy key. */
function replaceEntryField(
  file: PipelinePreferencesFile,
  locator: PipelinePreferenceLocator,
  update: (entry: PipelinePreferenceEntry) => PipelinePreferenceEntry,
): void {
  const locatorKey = serializePipelinePreferenceLocator(locator);
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  file.entries[locatorKey] = update(
    entryWithLegacyFallback(file, locatorKey, legacyKey),
  );
  if (legacyKey && legacyKey !== locatorKey) {
    delete file.entries[legacyKey];
  }
}

function deleteEntryField(
  file: PipelinePreferencesFile,
  locator: PipelinePreferenceLocator,
  field: keyof PipelinePreferenceEntry,
): void {
  const locatorKey = serializePipelinePreferenceLocator(locator);
  if (file.entries[locatorKey]) {
    delete file.entries[locatorKey][field];
  }
  const legacyKey = getLegacyStoredPreferenceKey(locator);
  if (legacyKey && legacyKey !== locatorKey && file.entries[legacyKey]) {
    delete file.entries[legacyKey][field];
  }
}

export function loadPipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
): Record<string, PipelinePluginCollectionPreference> {
  return (
    storedEntry(readPreferencesForDisplay(), locator).plugin_collections ?? {}
  );
}

/** What a whole-field save installed. */
export interface PipelinePreferenceSaveResult<T> {
  /** The field as saved. */
  preferences: Record<string, T>;
  /**
   * The stored field had changed since the caller's `base`, so the caller's
   * changes were merged into it entry by entry.
   */
  merged: boolean;
}

export interface PipelinePreferenceSaveOptions<T> {
  /**
   * The stored field the caller's view started from: a compare-and-set base.
   * When the stored field still matches it, the save replaces the field. When
   * another writer changed it since, only the entries the caller changed
   * from `base` are applied; the others keep their stored values. Without a
   * base the save replaces the field.
   */
  base?: Record<string, T>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A three-way merge of one normalized field; see {@link PipelinePreferenceSaveOptions}. */
function applyFieldSave<T>(
  stored: Record<string, T>,
  next: Record<string, T>,
  base: Record<string, T> | undefined,
  removed: ReadonlySet<string> = new Set(),
): PipelinePreferenceSaveResult<T> {
  if (base === undefined || sameValue(stored, base)) {
    return { preferences: next, merged: false };
  }
  const preferences = { ...stored };
  const keys = [...Object.keys(base), ...Object.keys(next), ...removed];
  for (const key of new Set(keys)) {
    // An explicit removal is a change even where the base had no entry.
    if (!removed.has(key) && sameValue(next[key], base[key])) continue;
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      preferences[key] = next[key];
    } else {
      delete preferences[key];
    }
  }
  return { preferences, merged: true };
}

export async function savePipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelinePluginCollectionPreference>,
  writer: PipelinePreferenceWriter,
  options: PipelinePreferenceSaveOptions<PipelinePluginCollectionPreference> = {},
): Promise<PipelinePreferenceSaveResult<PipelinePluginCollectionPreference>> {
  const normalized = normalizePipelinePluginCollectionPreferences(preferences);
  const base =
    options.base === undefined
      ? undefined
      : normalizePipelinePluginCollectionPreferences(options.base);
  let result: PipelinePreferenceSaveResult<PipelinePluginCollectionPreference> =
    { preferences: normalized, merged: false };
  await mutatePreferencesFile(writer, (file) =>
    replaceEntryField(file, locator, (entry) => {
      result = applyFieldSave(
        normalizePipelinePluginCollectionPreferences(entry.plugin_collections),
        normalized,
        base,
      );
      return { ...entry, plugin_collections: result.preferences };
    }),
  );
  return result;
}

/** Saves `preferences` over the stored ones collection by collection. */
export function mergePipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelinePluginCollectionPreference>,
  writer: PipelinePreferenceWriter,
): Promise<void> {
  const normalized = normalizePipelinePluginCollectionPreferences(preferences);
  return mutatePreferencesFile(writer, (file) =>
    replaceEntryField(file, locator, (entry) => ({
      ...entry,
      plugin_collections: { ...entry.plugin_collections, ...normalized },
    })),
  );
}

export function deletePipelinePluginCollectionPreferences(
  locator: PipelinePreferenceLocator,
  writer: PipelinePreferenceWriter,
): Promise<void> {
  return mutatePreferencesFile(writer, (file) =>
    deleteEntryField(file, locator, 'plugin_collections'),
  );
}

export function loadPipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
): Record<string, PipelineModelAliasPreference> {
  return storedEntry(readPreferencesForDisplay(), locator).model_aliases ?? {};
}

export interface PipelineModelAliasSaveOptions extends PipelinePreferenceSaveOptions<PipelineModelAliasPreference> {
  /** When non-empty, only these aliases are kept in the saved field. */
  aliasIds?: readonly string[];
}

function keepAliases<T>(
  preferences: Record<string, T>,
  aliasIds: ReadonlySet<string>,
): Record<string, T> {
  if (aliasIds.size === 0) return preferences;
  return Object.fromEntries(
    Object.entries(preferences).filter(([aliasId]) => aliasIds.has(aliasId)),
  );
}

/**
 * Saves the locator's model aliases; a `reset` entry removes its stored
 * alias. See {@link PipelinePreferenceSaveOptions} for `base`.
 */
export async function savePipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelineModelAliasPreference>,
  writer: PipelinePreferenceWriter,
  options: PipelineModelAliasSaveOptions = {},
): Promise<PipelinePreferenceSaveResult<PipelineModelAliasPreference>> {
  const aliasIds = new Set(
    (options.aliasIds ?? []).map((aliasId) => aliasId.trim()).filter(Boolean),
  );
  const normalized = keepAliases(
    normalizePipelineModelAliasPreferences(preferences),
    aliasIds,
  );
  const resets = new Set(
    Object.entries(preferences)
      .filter(([, entry]) => isRecord(entry) && entry.mode === 'reset')
      .map(([aliasId]) => aliasId.trim())
      .filter(
        (aliasId) => aliasId && (aliasIds.size === 0 || aliasIds.has(aliasId)),
      ),
  );
  const base =
    options.base === undefined
      ? undefined
      : keepAliases(
          normalizePipelineModelAliasPreferences(options.base),
          aliasIds,
        );
  let result: PipelinePreferenceSaveResult<PipelineModelAliasPreference> = {
    preferences: normalized,
    merged: false,
  };
  await mutatePreferencesFile(writer, (file) =>
    replaceEntryField(file, locator, (entry) => {
      result = applyFieldSave(
        keepAliases(
          normalizePipelineModelAliasPreferences(entry.model_aliases),
          aliasIds,
        ),
        normalized,
        base,
        resets,
      );
      return { ...entry, model_aliases: result.preferences };
    }),
  );
  return result;
}

/**
 * Saves `preferences` over the stored ones alias by alias; a `reset` entry
 * removes its stored alias.
 */
export function mergePipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
  preferences: Record<string, PipelineModelAliasPreference>,
  writer: PipelinePreferenceWriter,
): Promise<void> {
  return mutatePreferencesFile(writer, (file) =>
    replaceEntryField(file, locator, (entry) => ({
      ...entry,
      model_aliases: normalizePipelineModelAliasPreferences({
        ...entry.model_aliases,
        ...preferences,
      }),
    })),
  );
}

export function deletePipelineModelAliasPreferences(
  locator: PipelinePreferenceLocator,
  writer: PipelinePreferenceWriter,
): Promise<void> {
  return mutatePreferencesFile(writer, (file) =>
    deleteEntryField(file, locator, 'model_aliases'),
  );
}

/**
 * Removes saved selections that name a deleted plugin, skill or marketplace.
 * `prune` edits the stored entries in place and reports whether it changed
 * anything; nothing is written when it did not. A file from a newer version,
 * or one that cannot be read, is left alone rather than failing the removal.
 */
export async function prunePipelinePreferenceSelections(
  prune: (entries: Record<string, unknown>) => boolean,
  writer: PipelinePreferenceWriter,
): Promise<void> {
  try {
    await mutatePreferencesFile(writer, (file) => prune(file.entries));
  } catch (error) {
    if (
      error instanceof PipelinePreferencesWriteRefusedError &&
      error.reason !== 'damaged-copy-failed'
    ) {
      return;
    }
    throw error;
  }
}
