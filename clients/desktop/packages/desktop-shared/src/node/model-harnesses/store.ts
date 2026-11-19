import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { getModelHarnessOverridesFilePath } from '@canopy/execution-engine/canopy-paths';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  MODEL_HARNESS_OVERRIDES_VERSION,
  ModelHarnessPolicyError,
  applyModelHarnessOverrideMutation,
  isAssignableModelHarness,
  isSyntacticallyValidModelId,
  normalizeModelHarnessOverrides,
  type ModelHarness,
  type ModelHarnessCatalog,
  type ModelHarnessOverridesFile,
} from '@canopy/execution-engine/model-harnesses';

export class UnsupportedModelHarnessOverridesVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `Model harness overrides version ${String(version)} is newer than this application supports`,
    );
    this.name = 'UnsupportedModelHarnessOverridesVersionError';
  }
}

/**
 * The errno codes a refusal may report; any other code is `UNKNOWN`, so no
 * message or path leaves the store in one.
 */
const REPORTED_ERROR_CODES = [
  'EACCES',
  'EPERM',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EISDIR',
  'ENOTDIR',
  'EBUSY',
  'EAGAIN',
  'ELOOP',
  'ENAMETOOLONG',
  'EROFS',
  'ENOSPC',
  'EEXIST',
  'EXDEV',
  'ETIMEDOUT',
  'ESTALE',
  'ENOENT',
] as const;

export type ModelHarnessOverridesErrorCode =
  | (typeof REPORTED_ERROR_CODES)[number]
  | 'UNKNOWN';

function reportedErrorCode(error: unknown): ModelHarnessOverridesErrorCode {
  // Not `instanceof Error`: fs errors can come from another realm.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return REPORTED_ERROR_CODES.find((listed) => listed === code) ?? 'UNKNOWN';
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * A change refused because the saved overrides could not be read, or a
 * corrupt overrides file could not be set aside, so writing would replace
 * overrides this process never saw (CAN-7094).
 */
export class ModelHarnessOverridesUnreadableError extends Error {
  constructor(
    readonly code: ModelHarnessOverridesErrorCode,
    readonly stage: 'read' | 'repair',
  ) {
    super(
      stage === 'read'
        ? `The saved model harness overrides could not be read (${code}), so they were left unchanged`
        : `The damaged model harness overrides file could not be set aside (${code}), so it was left unchanged`,
    );
    this.name = 'ModelHarnessOverridesUnreadableError';
  }
}

export interface ModelHarnessOverrideStoreOptions {
  filePath?: string;
  getCatalog: () => ModelHarnessCatalog;
  now?: () => Date;
  /** Optional recovery backend, primarily for deterministic fault injection. */
  healCorruptFile?: () => Promise<void>;
}

export interface ModelHarnessOverrideMutationResult {
  modelId: string;
  overrides: Record<string, ModelHarness>;
  changed: boolean;
}

function cloneOverrides(
  overrides: Readonly<Record<string, ModelHarness>>,
): Record<string, ModelHarness> {
  return { ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyValidOverrideEntries(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([modelId, harness]) =>
        isSyntacticallyValidModelId(modelId) &&
        isAssignableModelHarness(harness),
    )
  );
}

function serialize(overrides: Record<string, ModelHarness>): string {
  const document: ModelHarnessOverridesFile = {
    version: MODEL_HARNESS_OVERRIDES_VERSION,
    overrides: Object.fromEntries(
      Object.entries(overrides).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export class ModelHarnessOverrideStore {
  readonly filePath: string;
  private readonly getCatalog: () => ModelHarnessCatalog;
  private readonly now: () => Date;
  private readonly healCorruptFile?: () => Promise<void>;
  private loaded = false;
  private loadPromise: Promise<Record<string, ModelHarness>> | undefined;
  private overrides: Record<string, ModelHarness> = {};
  private needsCleanup = false;
  /** Why the last load could not read the file; the next load reads again. */
  private readFailure: ModelHarnessOverridesErrorCode | undefined;
  /**
   * Why the last load could not set a corrupt file aside. The file may still
   * be in place, so the next load reads it again before anything is written.
   */
  private repairFailure: ModelHarnessOverridesErrorCode | undefined;
  private unsupportedVersion: number | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ModelHarnessOverrideStoreOptions) {
    this.filePath = options.filePath ?? getModelHarnessOverridesFilePath();
    this.getCatalog = options.getCatalog;
    this.now = options.now ?? ((): Date => new Date());
    this.healCorruptFile = options.healCorruptFile;
  }

  async load(): Promise<Record<string, ModelHarness>> {
    if (this.loaded) return cloneOverrides(this.overrides);
    this.loadPromise ??= this.loadFromDisk();
    return cloneOverrides(await this.loadPromise);
  }

  getCachedOverrides(): Record<string, ModelHarness> {
    return cloneOverrides(this.overrides);
  }

  getUnsupportedVersion(): number | undefined {
    return this.unsupportedVersion;
  }

  set(
    modelId: string,
    harness: ModelHarness,
  ): Promise<ModelHarnessOverrideMutationResult> {
    return this.enqueueMutation(() =>
      this.mutate({ modelId, harness, reset: false }),
    );
  }

  reset(modelId: string): Promise<ModelHarnessOverrideMutationResult> {
    return this.enqueueMutation(() => this.mutate({ modelId, reset: true }));
  }

  private async loadFromDisk(): Promise<Record<string, ModelHarness>> {
    this.repairFailure = undefined;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      // Harness overrides are optional user preferences: an unreadable file
      // must not abort desktop startup, so it loads as no overrides. Only a
      // missing file is known to hold none. Any other failure (EACCES, EIO,
      // EMFILE, ...) refuses changes until a later load reads the file, so a
      // change never replaces overrides this process could not read.
      if (isMissingFile(error)) {
        this.readFailure = undefined;
        this.loaded = true;
      } else {
        this.readFailure = reportedErrorCode(error);
        this.loadPromise = undefined;
      }
      return this.overrides;
    }
    this.readFailure = undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.recoverCorruptFile();
    }

    if (
      isRecord(parsed) &&
      typeof parsed.version === 'number' &&
      Number.isInteger(parsed.version) &&
      parsed.version > MODEL_HARNESS_OVERRIDES_VERSION
    ) {
      this.unsupportedVersion = parsed.version;
      this.loaded = true;
      return this.overrides;
    }

    if (
      !isRecord(parsed) ||
      parsed.version !== MODEL_HARNESS_OVERRIDES_VERSION ||
      !isRecord(parsed.overrides)
    ) {
      return this.recoverCorruptFile();
    }

    this.overrides = normalizeModelHarnessOverrides(
      parsed.overrides,
      this.getCatalog().modelAliases,
    );
    this.needsCleanup = !hasOnlyValidOverrideEntries(parsed.overrides);
    this.loaded = true;
    return this.overrides;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async mutate(input: {
    modelId: string;
    harness?: ModelHarness;
    reset: boolean;
  }): Promise<ModelHarnessOverrideMutationResult> {
    await this.load();
    if (this.readFailure !== undefined) {
      throw new ModelHarnessOverridesUnreadableError(this.readFailure, 'read');
    }
    if (this.repairFailure !== undefined) {
      throw new ModelHarnessOverridesUnreadableError(
        this.repairFailure,
        'repair',
      );
    }
    if (this.unsupportedVersion !== undefined) {
      throw new UnsupportedModelHarnessOverridesVersionError(
        this.unsupportedVersion,
      );
    }
    const result = applyModelHarnessOverrideMutation({
      ...input,
      catalog: this.getCatalog(),
      overrides: this.overrides,
    });
    const changed =
      JSON.stringify(result.overrides) !== JSON.stringify(this.overrides);
    if (changed || this.needsCleanup) {
      await this.atomicWrite(result.overrides);
      this.overrides = result.overrides;
      this.needsCleanup = false;
    }
    return {
      modelId: result.modelId,
      overrides: cloneOverrides(this.overrides),
      changed,
    };
  }

  private async backupAndReplaceCorruptFile(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.filePath}.corrupt-${stamp}.bak`;
    await rename(this.filePath, backupPath);
    await pruneDamagedCopies(
      damagedCopiesOf(this.filePath, '.corrupt-', { suffix: '.bak' }),
    );
    await this.atomicWrite({});
    this.overrides = {};
    this.needsCleanup = false;
  }

  /**
   * Sets a corrupt file aside and loads as no overrides. A failure must not
   * abort startup or poison the memoized load, so it also loads as no
   * overrides; but the corrupt file may still be in place, so the load is
   * not kept. The next load, and so the next change, reads the file again:
   * it sets aside what is still corrupt, builds on a file that was repaired
   * meanwhile, and a change is refused while neither works.
   */
  private async recoverCorruptFile(): Promise<Record<string, ModelHarness>> {
    try {
      await (this.healCorruptFile?.() ?? this.backupAndReplaceCorruptFile());
      this.loaded = true;
    } catch (error) {
      this.repairFailure = reportedErrorCode(error);
      this.loadPromise = undefined;
    }
    return this.overrides;
  }

  private async atomicWrite(
    overrides: Record<string, ModelHarness>,
  ): Promise<void> {
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialize(overrides), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await chmod(this.filePath, 0o600);
    // Make the write contract explicit for tests and unusual filesystems.
    await access(this.filePath, constants.R_OK | constants.W_OK);
  }
}

export function isModelHarnessPolicyError(
  error: unknown,
): error is ModelHarnessPolicyError {
  return error instanceof ModelHarnessPolicyError;
}
