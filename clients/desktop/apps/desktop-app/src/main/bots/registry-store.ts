import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_BOT_ID,
  APP_ADVISOR_PROJECT_ID,
  isBotId,
  isBotProjectId,
  type BotId,
} from '@canopy/protocol/chat-targets';
import {
  BotDescriptionSchema,
  BotGlyphSchema,
  BotNameSchema,
  BotRecordSchema,
  type BotPin,
  type BotRecord,
} from '@canopy/protocol/canopy-core';
import type { BotGlyph } from '@canopy/protocol/bot-glyph';
import { writeFileAtomically } from '../lib/atomic-file';
import { createBotIdGenerator } from './id';
import { botRegistryHostDependencies } from './registry-host';

const REGISTRY_VERSION = 1;
const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const MAX_RECEIPTS = 256;
const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type BotRegistryOperation = 'create' | 'update' | 'pins.set' | 'delete';

export interface BotRegistryReceipt {
  scope: string;
  fingerprint: string;
}

export interface BotReceipt extends BotRegistryReceipt {
  operation: BotRegistryOperation;
  bot: BotRecord;
  completedAt: string;
}

interface PendingBotReceipt extends BotRegistryReceipt {
  operation: BotRegistryOperation;
  bot: BotRecord;
}

export type BotRegistryFailure =
  | 'unknown_bot'
  | 'revision_conflict'
  | 'name_conflict'
  | 'invalid_input'
  | 'unknown_project'
  | 'default_bot_protected'
  | 'experiment_off'
  | 'key_reused'
  | 'storage_failed';

export class BotRegistryError extends Error {
  /**
   * True when a write may have been installed before it failed (the durable
   * writer renamed the file, then could not confirm the directory flush), so a
   * keyed retry can still find its receipt.
   */
  readonly outcomeUnknown: boolean;

  constructor(
    readonly reason: BotRegistryFailure,
    options: { readonly outcomeUnknown?: boolean } = {},
  ) {
    super(reason);
    this.name = 'BotRegistryError';
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export interface BotCreateInput {
  name: string;
  description?: string | null;
  glyph?: BotGlyph;
  pins?: readonly string[];
  showInSidebar?: boolean;
  pinnedToTop?: boolean;
}

export interface BotUpdatePatch {
  name?: string;
  description?: string | null;
  glyph?: BotGlyph;
  showInSidebar?: boolean;
  pinnedToTop?: boolean;
}

export interface BotRegistryStore {
  load(): Promise<void>;
  snapshot(): readonly BotRecord[];
  create(
    input: BotCreateInput,
    receipt?: BotRegistryReceipt,
  ): Promise<BotRecord>;
  update(
    botId: string,
    expectedRevision: number,
    patch: BotUpdatePatch,
    receipt?: BotRegistryReceipt,
  ): Promise<BotRecord>;
  setPins(
    botId: string,
    expectedRevision: number,
    projectIds: readonly string[],
    receipt?: BotRegistryReceipt,
  ): Promise<BotRecord>;
  delete(
    botId: string,
    expectedRevision: number,
    receipt?: BotRegistryReceipt,
  ): Promise<BotRecord>;
}

export interface BotRegistryFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readdir?(directoryPath: string): Promise<string[]>;
  unlink?(filePath: string): Promise<void>;
}

export interface BotRegistryStoreDependencies {
  filePath: string;
  now: () => Date;
  isEnabled: () => boolean;
  projectExists: (projectId: string) => Promise<boolean>;
  log: (message: string, error: unknown) => void;
  fileSystem?: BotRegistryFileSystem;
  writeAtomically?: (filePath: string, contents: string) => Promise<void>;
}

let singleton: BotRegistryStore | null = null;

interface ParsedCreateInput {
  name: string;
  description: string | null;
  glyph: BotGlyph;
  projectIds: string[];
  showInSidebar: boolean | undefined;
  pinnedToTop: boolean | undefined;
}

interface ParsedUpdatePatch {
  fields: Record<string, unknown>;
  hasName: boolean;
  name: string | undefined;
}

type RegistryFileParseResult =
  | { kind: 'valid'; records: BotRecord[]; receipts: BotReceipt[] }
  | { kind: 'newer' }
  | { kind: 'corrupt'; error: Error };

function isBotRegistryOperation(value: unknown): value is BotRegistryOperation {
  return (
    value === 'create' ||
    value === 'update' ||
    value === 'pins.set' ||
    value === 'delete'
  );
}

function isValidBotRecord(record: BotRecord): boolean {
  return record.botId === APP_ADVISOR_BOT_ID || record.kind === 'custom';
}

function parseBotReceipt(value: unknown): BotReceipt | undefined {
  if (
    !hasOnlyKeys(value, [
      'scope',
      'operation',
      'fingerprint',
      'bot',
      'completedAt',
    ]) ||
    typeof value.scope !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.scope) ||
    !isBotRegistryOperation(value.operation) ||
    typeof value.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    return undefined;
  }
  const parsedBot = BotRecordSchema.safeParse(value.bot);
  if (
    !parsedBot.success ||
    !isValidBotRecord(parsedBot.data) ||
    new Date(value.completedAt).toISOString() !== value.completedAt
  ) {
    return undefined;
  }
  return {
    scope: value.scope,
    operation: value.operation,
    fingerprint: value.fingerprint,
    bot: parsedBot.data,
    completedAt: value.completedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeParseFailure(message: string): Error {
  return new Error(message);
}

function hasOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw new BotRegistryError('invalid_input');
  const result = BotNameSchema.safeParse(value);
  if (!result.success) throw new BotRegistryError('invalid_input');
  return result.data;
}

function parseDescription(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BotRegistryError('invalid_input');
  const result = BotDescriptionSchema.safeParse(value);
  if (!result.success) throw new BotRegistryError('invalid_input');
  return result.data;
}

function parseGlyph(value: unknown): BotGlyph {
  const result = BotGlyphSchema.safeParse(value);
  if (!result.success) throw new BotRegistryError('invalid_input');
  return result.data;
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BotRegistryError('invalid_input');
  const values: readonly unknown[] = value;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) {
      throw new BotRegistryError('invalid_input');
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!hasOwn(value, key)) return undefined;
  const field = value[key];
  if (typeof field !== 'boolean') throw new BotRegistryError('invalid_input');
  return field;
}

function parseCreateInput(value: unknown): ParsedCreateInput {
  if (
    !hasOnlyKeys(value, [
      'name',
      'description',
      'glyph',
      'pins',
      'showInSidebar',
      'pinnedToTop',
    ])
  ) {
    throw new BotRegistryError('invalid_input');
  }
  if (!hasOwn(value, 'name')) throw new BotRegistryError('invalid_input');

  const description = hasOwn(value, 'description')
    ? parseDescription(value.description)
    : null;
  const projectIds = hasOwn(value, 'pins') ? parseStringList(value.pins) : [];
  return {
    name: parseName(value.name),
    description,
    glyph: hasOwn(value, 'glyph')
      ? parseGlyph(value.glyph)
      : { kind: 'default' },
    projectIds,
    showInSidebar: parseOptionalBoolean(value, 'showInSidebar'),
    pinnedToTop: parseOptionalBoolean(value, 'pinnedToTop'),
  };
}

function parseUpdatePatch(value: unknown): ParsedUpdatePatch {
  if (
    !hasOnlyKeys(value, [
      'name',
      'description',
      'glyph',
      'showInSidebar',
      'pinnedToTop',
    ])
  ) {
    throw new BotRegistryError('invalid_input');
  }
  const keys = Object.keys(value);
  if (keys.length === 0) throw new BotRegistryError('invalid_input');

  const fields: Record<string, unknown> = {};
  const hasName = hasOwn(value, 'name');
  const name = hasName ? parseName(value.name) : undefined;
  if (hasName) fields.name = name;
  if (hasOwn(value, 'description')) {
    fields.description = parseDescription(value.description);
  }
  if (hasOwn(value, 'glyph')) fields.glyph = parseGlyph(value.glyph);
  if (hasOwn(value, 'showInSidebar')) {
    fields.showInSidebar = parseOptionalBoolean(value, 'showInSidebar');
  }
  if (hasOwn(value, 'pinnedToTop')) {
    fields.pinnedToTop = parseOptionalBoolean(value, 'pinnedToTop');
  }
  return { fields, hasName, name };
}

function createDefaultBot(): BotRecord {
  return BotRecordSchema.parse({
    botId: APP_ADVISOR_BOT_ID,
    kind: 'default',
    name: ORCHESTRATOR_LABEL,
    description: null,
    glyph: { kind: 'default' },
    pins: [],
    showInSidebar: true,
    pinnedToTop: false,
    primaryChatId: null,
    primaryRevision: 0,
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP,
    revision: 0,
    deletedAt: null,
  });
}

function normalizeDefaultBot(record: BotRecord): BotRecord {
  const result = BotRecordSchema.safeParse({
    ...record,
    kind: 'default',
    name: ORCHESTRATOR_LABEL,
    createdAt: DEFAULT_TIMESTAMP,
    primaryChatId: null,
    primaryRevision: 0,
    deletedAt: null,
  });
  return result.success ? result.data : createDefaultBot();
}

function withDefaultBot(records: readonly BotRecord[]): BotRecord[] {
  const storedDefault = records.find(
    (record) => record.botId === APP_ADVISOR_BOT_ID,
  );
  const defaultBot =
    storedDefault === undefined
      ? createDefaultBot()
      : normalizeDefaultBot(storedDefault);
  return [
    defaultBot,
    ...records.filter((record) => record.botId !== APP_ADVISOR_BOT_ID),
  ];
}

function parseRegistryFile(value: unknown): RegistryFileParseResult {
  if (!isRecord(value)) {
    return {
      kind: 'corrupt',
      error: safeParseFailure('Registry root must be an object'),
    };
  }
  if (typeof value.version === 'number' && value.version > REGISTRY_VERSION) {
    return { kind: 'newer' };
  }
  if (
    value.version !== REGISTRY_VERSION ||
    !Array.isArray(value.bots) ||
    !Object.keys(value).every(
      (key) => key === 'version' || key === 'bots' || key === 'receipts',
    ) ||
    (hasOwn(value, 'receipts') && !Array.isArray(value.receipts))
  ) {
    return {
      kind: 'corrupt',
      error: safeParseFailure('Registry file schema is invalid'),
    };
  }

  const candidates: readonly unknown[] = value.bots;
  const records: BotRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const parsed = BotRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        kind: 'corrupt',
        error: safeParseFailure('Registry contains an invalid Bot'),
      };
    }
    if (ids.has(parsed.data.botId)) {
      return {
        kind: 'corrupt',
        error: safeParseFailure('Registry contains a duplicate Bot ID'),
      };
    }
    if (!isValidBotRecord(parsed.data)) {
      return {
        kind: 'corrupt',
        error: safeParseFailure('Custom Bot IDs must use the custom kind'),
      };
    }
    ids.add(parsed.data.botId);
    records.push(parsed.data);
  }
  const receipts: BotReceipt[] = [];
  const scopes = new Set<string>();
  if (Array.isArray(value.receipts)) {
    for (const candidate of value.receipts) {
      const receipt = parseBotReceipt(candidate);
      if (receipt === undefined) {
        return {
          kind: 'corrupt',
          error: safeParseFailure('Registry contains an invalid Bot receipt'),
        };
      }
      if (scopes.has(receipt.scope)) {
        return {
          kind: 'corrupt',
          error: safeParseFailure(
            'Registry contains a duplicate Bot receipt scope',
          ),
        };
      }
      scopes.add(receipt.scope);
      receipts.push(receipt);
    }
  }
  return { kind: 'valid', records: withDefaultBot(records), receipts };
}

function cloneRecord(record: BotRecord): BotRecord {
  return structuredClone(record);
}

export function createBotRegistryStore(
  dependencies: BotRegistryStoreDependencies,
): BotRegistryStore {
  const fileSystem: BotRegistryFileSystem = dependencies.fileSystem ?? {
    readFile: async (filePath: string, encoding: 'utf8'): Promise<string> =>
      readFile(filePath, encoding),
    rename: async (oldPath: string, newPath: string): Promise<void> =>
      rename(oldPath, newPath),
    readdir: async (directoryPath: string): Promise<string[]> =>
      readdir(directoryPath),
    unlink: async (filePath: string): Promise<void> => unlink(filePath),
  };
  const atomicWrite =
    dependencies.writeAtomically ??
    (async (filePath: string, contents: string): Promise<void> =>
      writeFileAtomically(filePath, contents, { mode: 0o600, durable: true }));
  const nextBotId = createBotIdGenerator(dependencies.now);

  let records: BotRecord[] = [createDefaultBot()];
  let receipts: BotReceipt[] = [];
  let loaded = false;
  let needsReload = false;
  let readOnly: 'retry' | 'permanent' | null = null;
  let queue: Promise<void> = Promise.resolve();

  function log(message: string, error: unknown): void {
    try {
      dependencies.log(message, error);
    } catch {
      // Logging must not change whether a registry mutation is safe.
    }
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function setDefaultState(): void {
    exposeDefaultOnly();
    loaded = true;
    needsReload = false;
    readOnly = null;
  }

  function exposeDefaultOnly(): void {
    records = [createDefaultBot()];
    receipts = [];
  }

  async function quarantine(cause: Error): Promise<void> {
    log('Found a corrupt Bot registry', cause);
    let timestamp: number;
    try {
      timestamp = dependencies.now().getTime();
    } catch (error) {
      exposeDefaultOnly();
      loaded = true;
      needsReload = true;
      readOnly = 'retry';
      log('Could not timestamp the corrupt Bot registry quarantine', error);
      return;
    }
    const quarantinePath = join(
      dirname(dependencies.filePath),
      `bots.corrupt-${timestamp}.json`,
    );
    try {
      await fileSystem.rename(dependencies.filePath, quarantinePath);
      setDefaultState();
    } catch (error) {
      exposeDefaultOnly();
      loaded = true;
      needsReload = true;
      readOnly = 'retry';
      log('Could not quarantine the corrupt Bot registry', error);
    }
  }

  async function loadIfNeeded(): Promise<void> {
    if (readOnly === 'permanent') return;
    if (loaded && !needsReload && readOnly !== 'retry') return;
    needsReload = false;

    await cleanOrphanTemporaryFiles();

    let contents: string;
    try {
      contents = await fileSystem.readFile(dependencies.filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        setDefaultState();
        return;
      }
      exposeDefaultOnly();
      loaded = true;
      needsReload = true;
      readOnly = 'retry';
      log('Could not read the Bot registry', error);
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(contents);
    } catch (error) {
      await quarantine(asError(error));
      return;
    }

    const parsed = parseRegistryFile(decoded);
    if (parsed.kind === 'newer') {
      exposeDefaultOnly();
      loaded = true;
      needsReload = false;
      readOnly = 'permanent';
      log(
        'Bot registry uses a newer unsupported version',
        new Error('Unsupported registry version'),
      );
      return;
    }
    if (parsed.kind === 'corrupt') {
      await quarantine(parsed.error);
      return;
    }

    records = parsed.records;
    receipts = parsed.receipts;
    loaded = true;
    needsReload = false;
    readOnly = null;
  }

  async function cleanOrphanTemporaryFiles(): Promise<void> {
    if (fileSystem.readdir === undefined || fileSystem.unlink === undefined)
      return;
    const directoryPath = dirname(dependencies.filePath);
    let names: string[];
    try {
      names = await fileSystem.readdir(directoryPath);
    } catch (error) {
      log('Could not list Bot registry temporary files', error);
      return;
    }
    for (const name of names) {
      const match = /^\.bots\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/.exec(name);
      if (match === null || match[1] === String(process.pid)) continue;
      try {
        await fileSystem.unlink(join(directoryPath, name));
      } catch (error) {
        log('Could not remove an abandoned Bot registry temporary file', error);
      }
    }
  }

  function currentTime(): string {
    try {
      return dependencies.now().toISOString();
    } catch (error) {
      log('Could not create a Bot registry timestamp', error);
      throw new BotRegistryError('storage_failed');
    }
  }

  function updatedTimestamp(record: BotRecord, now: string): string {
    try {
      const timestamp = Math.max(
        Date.parse(now),
        Date.parse(record.updatedAt) + 1,
      );
      return new Date(timestamp).toISOString();
    } catch (error) {
      log('Could not create a monotonic Bot registry timestamp', error);
      throw new BotRegistryError('storage_failed');
    }
  }

  function validateReceipt(receipt: BotRegistryReceipt): void {
    if (
      !/^[0-9a-f]{64}$/.test(receipt.scope) ||
      !/^[0-9a-f]{64}$/.test(receipt.fingerprint)
    ) {
      throw new BotRegistryError('invalid_input');
    }
  }

  function requireExperimentEnabled(): void {
    let enabled: boolean;
    try {
      enabled = dependencies.isEnabled();
    } catch (error) {
      log('Could not evaluate the Bot experiment', error);
      throw new BotRegistryError('storage_failed');
    }
    if (!enabled) throw new BotRegistryError('experiment_off');
  }

  function requireStorageWritable(): void {
    if (readOnly !== null) throw new BotRegistryError('storage_failed');
  }

  async function requirePinsExist(
    projectIds: readonly string[],
  ): Promise<void> {
    for (const projectId of projectIds) {
      if (projectId === APP_ADVISOR_PROJECT_ID || isBotProjectId(projectId)) {
        throw new BotRegistryError('unknown_project');
      }
      let exists: boolean;
      try {
        exists = await dependencies.projectExists(projectId);
      } catch (error) {
        log('Could not check a Bot pin project', error);
        throw new BotRegistryError('storage_failed');
      }
      if (!exists) throw new BotRegistryError('unknown_project');
    }
  }

  /** True when a stored pin's project no longer exists; writes stay strict. */
  async function pinProjectRemoved(projectId: string): Promise<boolean> {
    try {
      return !(await dependencies.projectExists(projectId));
    } catch (error) {
      log('Could not check a stored Bot pin project', error);
      throw new BotRegistryError('storage_failed');
    }
  }

  function requireBot(botId: string): BotRecord {
    if (!isBotId(botId)) throw new BotRegistryError('invalid_input');
    const record = records.find((candidate) => candidate.botId === botId);
    if (record === undefined || record.deletedAt !== null) {
      throw new BotRegistryError('unknown_bot');
    }
    return record;
  }

  function requireRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new BotRegistryError('invalid_input');
    }
  }

  function assertRevision(record: BotRecord, expectedRevision: number): void {
    requireRevision(expectedRevision);
    if (record.revision !== expectedRevision) {
      throw new BotRegistryError('revision_conflict');
    }
  }

  function assertNameAvailable(name: string, exceptBotId?: string): void {
    const normalizedName = name.toLowerCase();
    const conflict = records.some(
      (record) =>
        record.deletedAt === null &&
        record.botId !== exceptBotId &&
        record.name.toLowerCase() === normalizedName,
    );
    if (conflict) throw new BotRegistryError('name_conflict');
  }

  async function persist(
    nextRecords: BotRecord[],
    pendingReceipt?: PendingBotReceipt,
  ): Promise<void> {
    const now = currentTime();
    const cutoff = Date.parse(now) - RECEIPT_MAX_AGE_MS;
    const nextReceipts = receipts.filter(
      (receipt) =>
        Date.parse(receipt.completedAt) >= cutoff &&
        receipt.scope !== pendingReceipt?.scope,
    );
    if (pendingReceipt !== undefined) {
      nextReceipts.push({ ...pendingReceipt, completedAt: now });
    }
    const boundedReceipts = nextReceipts.slice(-MAX_RECEIPTS);
    const serializedFile = `${JSON.stringify(
      {
        version: REGISTRY_VERSION,
        bots: nextRecords,
        receipts: boundedReceipts,
      },
      null,
      2,
    )}\n`;
    requireExperimentEnabled();
    requireStorageWritable();
    try {
      await atomicWrite(dependencies.filePath, serializedFile);
    } catch (error) {
      needsReload = true;
      log('Could not durably write the Bot registry', error);
      throw new BotRegistryError('storage_failed', {
        outcomeUnknown: isStorageOutcomeUnknownError(error),
      });
    }
    records = nextRecords;
    receipts = boundedReceipts;
    loaded = true;
    needsReload = false;
    readOnly = null;
  }

  function mutate(
    operationName: BotRegistryOperation,
    receipt: BotRegistryReceipt | undefined,
    validate: () => void,
    operation: () => Promise<BotRecord>,
  ): Promise<BotRecord> {
    return serialize(async () => {
      requireExperimentEnabled();
      await loadIfNeeded();
      requireExperimentEnabled();
      requireStorageWritable();
      if (receipt !== undefined) {
        validateReceipt(receipt);
        const cutoff = Date.parse(currentTime()) - RECEIPT_MAX_AGE_MS;
        const activeReceipts = receipts
          .filter((candidate) => Date.parse(candidate.completedAt) >= cutoff)
          .slice(-MAX_RECEIPTS);
        const existing = activeReceipts.find(
          (candidate) => candidate.scope === receipt.scope,
        );
        if (existing !== undefined) {
          if (
            existing.operation !== operationName ||
            existing.fingerprint !== receipt.fingerprint
          ) {
            throw new BotRegistryError('key_reused');
          }
          return cloneRecord(existing.bot);
        }
      }
      validate();
      return operation();
    });
  }

  return {
    load: (): Promise<void> => serialize(loadIfNeeded),
    snapshot: (): readonly BotRecord[] => records.map(cloneRecord),
    create: (
      input: BotCreateInput,
      receipt?: BotRegistryReceipt,
    ): Promise<BotRecord> =>
      mutate(
        'create',
        receipt,
        (): void => undefined,
        async (): Promise<BotRecord> => {
          const parsedInput = parseCreateInput(input);
          assertNameAvailable(parsedInput.name);
          await requirePinsExist(parsedInput.projectIds);
          const timestamp = currentTime();
          let botId: BotId;
          try {
            botId = nextBotId();
          } catch (error) {
            log('Could not generate a Bot ID', error);
            throw new BotRegistryError('storage_failed');
          }
          if (records.some((record) => record.botId === botId)) {
            throw new BotRegistryError('storage_failed');
          }
          const candidate: unknown = {
            botId,
            kind: 'custom',
            name: parsedInput.name,
            description: parsedInput.description,
            glyph: parsedInput.glyph,
            pins: parsedInput.projectIds.map((projectId) => ({
              projectId,
              pinnedAt: timestamp,
            })),
            showInSidebar:
              parsedInput.showInSidebar ?? parsedInput.projectIds.length === 0,
            pinnedToTop: parsedInput.pinnedToTop ?? false,
            primaryChatId: null,
            primaryRevision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            revision: 1,
            deletedAt: null,
          };
          const parsedRecord = BotRecordSchema.safeParse(candidate);
          if (!parsedRecord.success)
            throw new BotRegistryError('invalid_input');
          await persist(
            [...records.map(cloneRecord), parsedRecord.data],
            receipt === undefined
              ? undefined
              : {
                  ...receipt,
                  operation: 'create',
                  bot: parsedRecord.data,
                },
          );
          return cloneRecord(parsedRecord.data);
        },
      ),
    update: (
      botId: string,
      expectedRevision: number,
      patch: BotUpdatePatch,
      receipt?: BotRegistryReceipt,
    ): Promise<BotRecord> =>
      mutate(
        'update',
        receipt,
        (): void => {
          if (
            botId === APP_ADVISOR_BOT_ID &&
            isRecord(patch) &&
            hasOwn(patch, 'name')
          ) {
            throw new BotRegistryError('default_bot_protected');
          }
        },
        async (): Promise<BotRecord> => {
          const parsedPatch = parseUpdatePatch(patch);
          const record = requireBot(botId);
          assertRevision(record, expectedRevision);
          if (parsedPatch.hasName && parsedPatch.name !== undefined) {
            assertNameAvailable(parsedPatch.name, botId);
          }
          const timestamp = currentTime();
          const updatedAt = updatedTimestamp(record, timestamp);
          const candidate: unknown = {
            ...record,
            ...parsedPatch.fields,
            updatedAt,
            revision: record.revision + 1,
          };
          const parsedRecord = BotRecordSchema.safeParse(candidate);
          if (!parsedRecord.success)
            throw new BotRegistryError('invalid_input');
          const nextRecords = records.map((existing) =>
            existing.botId === botId
              ? parsedRecord.data
              : cloneRecord(existing),
          );
          await persist(
            nextRecords,
            receipt === undefined
              ? undefined
              : {
                  ...receipt,
                  operation: 'update',
                  bot: parsedRecord.data,
                },
          );
          return cloneRecord(parsedRecord.data);
        },
      ),
    setPins: (
      botId: string,
      expectedRevision: number,
      projectIds: readonly string[],
      receipt?: BotRegistryReceipt,
    ): Promise<BotRecord> =>
      mutate(
        'pins.set',
        receipt,
        (): void => undefined,
        async (): Promise<BotRecord> => {
          const parsedProjectIds = parseStringList(projectIds);
          const record = requireBot(botId);
          assertRevision(record, expectedRevision);
          await requirePinsExist(parsedProjectIds);
          const timestamp = currentTime();
          const previousPinnedAt = new Map<string, string>();
          for (const pin of record.pins) {
            previousPinnedAt.set(pin.projectId, pin.pinnedAt);
          }
          // Reads hide pins to removed projects, so a caller can't keep them.
          // Retain them in their order, so a returning project's pin comes back.
          const requested = new Set(parsedProjectIds);
          const hiddenPins: BotPin[] = [];
          for (const pin of record.pins) {
            if (requested.has(pin.projectId)) continue;
            if (await pinProjectRemoved(pin.projectId))
              hiddenPins.push({ ...pin });
          }
          const updatedAt = updatedTimestamp(record, timestamp);
          const candidate: unknown = {
            ...record,
            pins: [
              ...parsedProjectIds.map((projectId) => ({
                projectId,
                pinnedAt: previousPinnedAt.get(projectId) ?? timestamp,
              })),
              ...hiddenPins,
            ],
            updatedAt,
            revision: record.revision + 1,
          };
          const parsedRecord = BotRecordSchema.safeParse(candidate);
          if (!parsedRecord.success)
            throw new BotRegistryError('invalid_input');
          const nextRecords = records.map((existing) =>
            existing.botId === botId
              ? parsedRecord.data
              : cloneRecord(existing),
          );
          await persist(
            nextRecords,
            receipt === undefined
              ? undefined
              : {
                  ...receipt,
                  operation: 'pins.set',
                  bot: parsedRecord.data,
                },
          );
          return cloneRecord(parsedRecord.data);
        },
      ),
    delete: (
      botId: string,
      expectedRevision: number,
      receipt?: BotRegistryReceipt,
    ): Promise<BotRecord> =>
      mutate(
        'delete',
        receipt,
        (): void => {
          if (botId === APP_ADVISOR_BOT_ID) {
            throw new BotRegistryError('default_bot_protected');
          }
        },
        async (): Promise<BotRecord> => {
          const record = requireBot(botId);
          assertRevision(record, expectedRevision);
          const timestamp = currentTime();
          const updatedAt = updatedTimestamp(record, timestamp);
          const candidate: unknown = {
            ...record,
            updatedAt,
            revision: record.revision + 1,
            deletedAt: timestamp,
          };
          const parsedRecord = BotRecordSchema.safeParse(candidate);
          if (!parsedRecord.success)
            throw new BotRegistryError('storage_failed');
          const nextRecords = records.map((existing) =>
            existing.botId === botId
              ? parsedRecord.data
              : cloneRecord(existing),
          );
          await persist(
            nextRecords,
            receipt === undefined
              ? undefined
              : {
                  ...receipt,
                  operation: 'delete',
                  bot: parsedRecord.data,
                },
          );
          return cloneRecord(parsedRecord.data);
        },
      ),
  };
}

export function getBotRegistryStore(): BotRegistryStore {
  return (singleton ??= createBotRegistryStore(botRegistryHostDependencies()));
}
