import {
  ResolutionCandidateBuildSession,
  ResolutionCandidateNeedsFullPass,
  type ResolutionCandidateMode,
} from './resolve/resolution-candidate-session';

export interface CodeGraphInternalBuildOptions extends CodeGraphBuildOptions {
  resolutionMode?: ResolutionCandidateMode;
  captureResolutionDependencies?: boolean;
}

import { SqliteResolutionDependencyWriter } from './resolve/resolution-dependency-store';

export interface CodeGraphCaptureBuildOptions extends CodeGraphResolutionBuildOptions {
  captureResolutionDependencies?: boolean;
}

import { resolveConfigExtendsEdges } from './resolve/config-extends-resolver';
import {
  markGraphDiagnosticsStale,
  recordGraphDiagnostics,
  readGraphDiagnostics,
  type ScanDiagnostics,
} from './diagnostics';
import {
  clearDeferredDerived,
  completeDeferredCodeGraphDerived,
  recordDeferredDerived,
  type CodeGraphDeferredDerivedResult,
} from './deferred-derived';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_MAX_FILE_BYTES,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphBuildOptions,
  type CodeGraphBuildResult,
  type CodeGraphCustomLanguagesReport,
  type CodeGraphDerivedRepoStats,
  type CodeGraphFileFacts,
  type CodeGraphRepositoryInput,
  type CodeGraphStatus,
  type CodeGraphSymbolRecord,
} from './types/code-graph';
import { fileQualifiedName, fileRowId, symbolRowId } from './ids';
import { computeDerivedForRepo } from './analysis/derived';
import {
  deleteMetadataValue,
  getMetadataValue,
  hasActiveCodeGraphWriteTransaction,
  openCodeGraphDatabase,
  setMetadataValue,
  withImmediateTransactionAsync,
  type CodeGraphDatabase,
} from './store/database';
import { runCodeGraphMigrations } from './store/migrations';
import {
  CodeGraphStore,
  type CodeGraphSymbolSummary,
} from './store/graph-store';
import { isSymbolFtsMappingTrusted, rebuildSymbolFts } from './store/fts';
import {
  backfillCodeGraphSummaryProjection,
  publishCodeGraphSummaryProjection,
  readCodeGraphSummaryProjectionFromDatabase,
  type BackfillCodeGraphSummaryProjectionResult,
  type CodeGraphSummaryProjectionV1,
} from './summary-projection';
import {
  effectiveGrammarForPath,
  mergeEffectiveGrammars,
  type CodeGraphEffectiveGrammar,
  type CodeGraphGrammarDefinition,
} from './grammars/registry';
import {
  CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
  customLanguagesConfigPath,
  parseCustomLanguagesReport,
  resolveCustomLanguages,
} from './languages/custom-config';
import { CodeGraphParserRuntime } from './parser/runtime';
import { extractFileFacts, isTestFilePath } from './extract/tags-extractor';
import {
  extractImportsFromTree,
  importsToEdges,
  type ExtractedImport,
} from './extract/imports';
import {
  extractRationale,
  isRationaleExcludedPath,
  type ExtractRationaleResult,
} from './extract/rationale';
import {
  extractCanopyPatterns,
  type ExtractCanopyPatternsResult,
} from './extract/canopy-patterns';
import {
  nonCodeExtractorForPath,
  type NonCodeExtractorDefinition,
} from './extract/extractor-registry';
import {
  computeContentHash,
  enumerateSourceFiles,
  planFileWork,
  type ScannedSourceFile,
} from './scan/scanner';
import {
  TsModuleResolver,
  resolutionInputsChanged,
} from './resolve/ts-module-resolver';
import { resolveImportEdges } from './resolve/import-edge-resolver';
import { resolveDocLinkEdges } from './resolve/doc-link-resolver';
import { resolveIpcEdges } from './resolve/ipc-resolver';
import { resolveWorkflowActionEdges } from './resolve/workflow-action-resolver';
import { resolveCallEdges } from './resolve/call-resolver';
import { linkTests } from './resolve/test-linker';
import { runFullResolutionDiff } from './resolve/full-resolution-diff';
import type { ResolutionProjectionCounters } from './resolve/resolution-projection';
import { CodeGraphQueryService } from './query/queries';
import { CodeGraphBuildTimer } from './build-timings';
import { isMissingPathError, isResourceExhaustionError } from './io-failure';

const execFileAsync = promisify(execFile);

async function gitHeadFor(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', rootPath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

// Facts for a file too large to parse. Built without reading the file so we
// never load an oversized (or >512MB, ERR_STRING_TOO_LONG) file into a string.
// contentHash is null (unread), only the file symbol is stored, and there are
// no edges.
function buildOversizedFileFacts(input: {
  repoId: string;
  relativePath: string;
  absolutePath: string;
  grammarId: string;
  sizeBytes: number;
  mtimeNs: string;
}): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const qualifiedName = fileQualifiedName(input.relativePath);
  const fileSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, qualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: input.relativePath.split('/').pop() ?? input.relativePath,
    qualifiedName,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 1,
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: isTestFilePath(input.relativePath),
    extra: {},
  };
  return {
    file: {
      id: fileId,
      repositoryId: input.repoId,
      relativePath: input.relativePath,
      absolutePath: input.absolutePath,
      language: input.grammarId,
      contentHash: null,
      sizeBytes: input.sizeBytes,
      mtimeNs: input.mtimeNs,
      lineCount: null,
      grammarId: input.grammarId,
      grammarAbi: null,
      parseStatus: 'skipped_too_large',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols: [fileSymbol],
    edges: [],
  };
}

// Facts for a non-code file whose extractor threw. Mirrors
// `buildOversizedFileFacts`'s file-symbol-only shape, but the file was
// already read and hashed by the time extraction ran (unlike the oversized
// case, which never reads the file), so `contentHash` is populated and
// `parseStatus` is 'failed' rather than 'skipped_too_large'. Extraction
// failures never kill the build — the file is still recorded, just without
// any extracted facts beyond its own file symbol.
function buildFailedNonCodeFileFacts(input: {
  repoId: string;
  relativePath: string;
  absolutePath: string;
  extractorId: string;
  source: string;
  sizeBytes: number;
  mtimeNs: string;
  contentHash: string;
}): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const qualifiedName = fileQualifiedName(input.relativePath);
  const fileSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, qualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: input.relativePath.split('/').pop() ?? input.relativePath,
    qualifiedName,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: Math.max(1, input.source.split('\n').length),
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: isTestFilePath(input.relativePath),
    extra: {},
  };
  return {
    file: {
      id: fileId,
      repositoryId: input.repoId,
      relativePath: input.relativePath,
      absolutePath: input.absolutePath,
      language: input.extractorId,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      mtimeNs: input.mtimeNs,
      lineCount: null,
      grammarId: input.extractorId,
      grammarAbi: null,
      parseStatus: 'failed',
      hasErrors: true,
      updatedAt: Date.now(),
    },
    symbols: [fileSymbol],
    edges: [],
  };
}

type ExistingFileIndexEntry = ReturnType<
  CodeGraphStore['listFileIndex']
>[number];

// Per-file result of the grammar/non-code processing helpers below: how the
// caller's running `buildOrUpdate` counters should change. Files that cannot
// be read after the scan return all-zero counters but explicitly mark content
// verification incomplete so persisted freshness never overstates the build.
interface FileProcessOutcome {
  parsed: number;
  skipped: number;
  unchanged: number;
  failures: number;
  /** 1 when the file exists but could not be read; its prior facts stay. */
  unreadable: number;
  factsChanged: boolean;
  contentReadFailed: boolean;
}

const NO_OP_FILE_OUTCOME: FileProcessOutcome = {
  parsed: 0,
  skipped: 0,
  unchanged: 0,
  failures: 0,
  unreadable: 0,
  factsChanged: false,
  contentReadFailed: true,
};

const UNREADABLE_FILE_OUTCOME: FileProcessOutcome = {
  ...NO_OP_FILE_OUTCOME,
  unreadable: 1,
};

/**
 * A file read after the scan failed. Only a missing path means it vanished
 * (the next build's scan removes it); any other error keeps its prior facts
 * and counts it unreadable. Resource exhaustion fails the build instead.
 */
function failedReadOutcome(error: unknown): FileProcessOutcome {
  if (isResourceExhaustionError(error)) throw error;
  return isMissingPathError(error)
    ? NO_OP_FILE_OUTCOME
    : UNREADABLE_FILE_OUTCOME;
}

/** Internal qualification mode; never persisted or exposed by a protocol. */
export interface CodeGraphResolutionBuildOptions extends CodeGraphBuildOptions {
  resolutionMode?: 'full-reset' | 'full-diff';
}

/**
 * Strictly increasing per database, so successive builds (including
 * no-change builds within one millisecond) always get distinct stamps.
 */
function nextLastBuildAt(previous: string | null): number {
  const prior = previous === null ? Number.NaN : Number(previous);
  const now = Date.now();
  return Number.isFinite(prior) && prior >= now ? prior + 1 : now;
}

export class CodeGraphEngine {
  private constructor(
    private readonly db: CodeGraphDatabase,
    private readonly dbPath: string,
    private readonly store: CodeGraphStore,
    private readonly runtime: CodeGraphParserRuntime,
    private readonly repositories: readonly CodeGraphRepositoryInput[],
    // False when `runtime` was injected by the caller (see `open`'s
    // `parserRuntime` option): `close()` must then NOT dispose it — ownership,
    // and the responsibility to eventually dispose, stays with the injector.
    private readonly ownsRuntime: boolean,
    private readonly customLanguagesRootPath: string | undefined,
    private repositorySetChanged: boolean,
    // Monotonic clock for build phase timings, and the WAL file they sample.
    private readonly now: () => number,
    private readonly walPath: string,
  ) {}

  /** The running build's timer, for per-file hash timing. */
  private activeTimer: CodeGraphBuildTimer | undefined;
  private activeDeferredAnalyses = 0;
  private lastResolutionProjectionCounters: ResolutionProjectionCounters | null =
    null;
  private closed = false;

  public static async open(options: {
    dbPath: string;
    repositories: readonly CodeGraphRepositoryInput[];
    resourcesDir?: string;
    // Root of the worktree checkout this graph covers. When provided, every
    // build reads `<worktreeRootPath>/.canopy/code-graph/languages.json`
    // (custom language config, Phase 6 Task 8); when the file does not exist
    // that read is a single failed syscall — the zero-cost no-op path.
    worktreeRootPath?: string;
    /** Root containing custom-language config/assets. Defaults to the scanned
     * worktree root; base builds may point this at an immutable snapshot. */
    customLanguagesRootPath?: string;
    // Optional caller-owned parser runtime to reuse instead of creating a
    // fresh one. web-tree-sitter `Language` instances (loaded grammar wasm)
    // have no `.delete()`, so a caller that opens many short-lived engines
    // (e.g. impact/before-graph.ts, once per change-impact call) can inject a
    // single shared runtime to avoid re-loading — and leaking — grammar wasm
    // per engine. When injected, `close()` leaves it intact; the injector owns
    // its lifetime. When omitted, this method creates its own runtime and
    // disposes it on `close()`.
    parserRuntime?: CodeGraphParserRuntime;
    /** Monotonic clock for build phase timings; tests inject one. */
    now?: () => number;
  }): Promise<CodeGraphEngine> {
    const db = openCodeGraphDatabase(options.dbPath);
    try {
      runCodeGraphMigrations(db);
      let engine: CodeGraphEngine | undefined = undefined;
      const store = new CodeGraphStore(db, (work) => {
        const timer = engine?.activeTimer;
        if (timer === undefined) work();
        else timer.measure('fts', work);
      });
      const repositoriesWithHeads = await Promise.all(
        options.repositories.map(async (repository) => ({
          ...repository,
          gitHead: await gitHeadFor(repository.rootPath),
        })),
      );
      const repositorySetChanged = store.repositoryMembershipDiffers(
        repositoriesWithHeads,
      );
      const ownsRuntime = options.parserRuntime === undefined;
      const runtime =
        options.parserRuntime ??
        (await CodeGraphParserRuntime.create(options.resourcesDir));
      engine = new CodeGraphEngine(
        db,
        options.dbPath,
        store,
        runtime,
        options.repositories,
        ownsRuntime,
        options.customLanguagesRootPath ?? options.worktreeRootPath,
        repositorySetChanged,
        options.now ?? ((): number => performance.now()),
        `${options.dbPath}-wal`,
      );
      return engine;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the initialization failure; callers cannot use this engine.
      }
      throw error;
    }
  }

  public queries(): CodeGraphQueryService {
    return new CodeGraphQueryService(this.db);
  }

  /** Test-only diagnostics, never persisted or exposed remotely. */
  public getLastResolutionProjectionCounters(): ResolutionProjectionCounters | null {
    return this.lastResolutionProjectionCounters;
  }

  // Every symbol in a repo's ENTIRE built graph (see
  // `CodeGraphStore.listSymbols`'s comment) — a passthrough purely so
  // external callers never need direct access to the private `store` field.
  // Used by the before-graph builder (`impact/before-graph.ts`) to snapshot
  // an ephemeral base-ref graph's full symbol set keyed by qualifiedName.
  public listSymbols(repoId: string): CodeGraphSymbolSummary[] {
    return this.store.listSymbols(repoId);
  }

  // Grammar-backed path: oversized check, hash fastpath, then tags-extraction
  // parse. Unchanged in behavior from before non-code routing existed — only
  // extracted out of `buildOrUpdate` to keep that method's branching flat.
  //
  // Custom grammars (`origin: 'custom'`, Phase 6 Task 8) run ONLY the generic
  // tags extraction — definitions/references. The onTree extras below
  // (import, rationale, and canopy-pattern extraction) walk TS/JS-shaped node
  // kinds and are skipped for customs, matching the documented
  // "definitions/references only" contract for custom languages.
  private async processGrammarFile(input: {
    repoId: string;
    entry: ScannedSourceFile;
    effectiveGrammar: CodeGraphEffectiveGrammar;
    prior: ExistingFileIndexEntry | undefined;
    forceFullReparse: boolean;
  }): Promise<FileProcessOutcome> {
    const { repoId, entry, effectiveGrammar, prior, forceFullReparse } = input;
    const grammarDefinition: CodeGraphGrammarDefinition =
      effectiveGrammar.definition;
    const isCustomGrammar = effectiveGrammar.origin === 'custom';
    if (entry.sizeBytes > CODE_GRAPH_MAX_FILE_BYTES) {
      // Check size BEFORE reading: never pull an oversized (or >512MB, which
      // throws ERR_STRING_TOO_LONG) file into a string just to discard it or
      // misclassify the throw as "vanished".
      if (
        !forceFullReparse &&
        prior?.parseStatus === 'skipped_too_large' &&
        prior.sizeBytes === entry.sizeBytes
      ) {
        this.store.touchFileStat(
          fileRowId(repoId, entry.relativePath),
          entry.absolutePath,
          entry.sizeBytes,
          entry.mtimeNs,
        );
        return {
          parsed: 0,
          skipped: 1,
          unchanged: 0,
          failures: 0,
          unreadable: 0,
          factsChanged: false,
          contentReadFailed: false,
        };
      }
      this.store.replaceFileFacts(
        buildOversizedFileFacts({
          repoId,
          relativePath: entry.relativePath,
          absolutePath: entry.absolutePath,
          grammarId: grammarDefinition.id,
          sizeBytes: entry.sizeBytes,
          mtimeNs: entry.mtimeNs,
        }),
      );
      return {
        parsed: 0,
        skipped: 1,
        unchanged: 0,
        failures: 0,
        unreadable: 0,
        factsChanged: true,
        contentReadFailed: false,
      };
    }
    const readStartedAt = this.now();
    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, 'utf8');
    } catch (error) {
      return failedReadOutcome(error);
    }
    const contentHash = computeContentHash(source);
    this.activeTimer?.add('hash', this.now() - readStartedAt);
    if (
      prior !== undefined &&
      prior.contentHash === contentHash &&
      !forceFullReparse
    ) {
      this.store.touchFileStat(
        fileRowId(repoId, entry.relativePath),
        entry.absolutePath,
        entry.sizeBytes,
        entry.mtimeNs,
      );
      return {
        parsed: 0,
        skipped: 0,
        unchanged: 1,
        failures: 0,
        unreadable: 0,
        factsChanged: false,
        contentReadFailed: false,
      };
    }
    // Custom grammars load by their definition's ABSOLUTE paths (never by id
    // against the built-in registry); the runtime's custom cache includes the
    // absolute asset paths and bytes, so this is a cache hit after validation
    // unless a fingerprint-triggering in-place asset change occurred.
    const grammar = isCustomGrammar
      ? await this.runtime.getResolvedCustomGrammar(grammarDefinition)
      : await this.runtime.getGrammar(grammarDefinition.id);
    const isTestFile = isTestFilePath(entry.relativePath);
    // fileId/fileSymbolId are pure hashes of (repoId, relativePath) — the
    // same values extractFileFacts computes internally for its own file
    // record/file symbol — so they can be precomputed here without waiting
    // for `facts` to come back.
    const fileId = fileRowId(repoId, entry.relativePath);
    const fileSymbolId = symbolRowId(
      repoId,
      fileQualifiedName(entry.relativePath),
    );
    const skipRationale = isRationaleExcludedPath(
      entry.relativePath,
      isTestFile,
    );
    let capturedImports: ExtractedImport[] = [];
    // Defaults to the empty/zero shape rather than `null` so reading it below
    // never depends on TypeScript narrowing a `let` variable that's only ever
    // reassigned inside a nested closure (that reassignment happens inside
    // `onTree`, invisible to this function's own control-flow analysis) —
    // this default is also exactly correct as-is when rationale extraction is
    // skipped (test file, generated dir) or the parse failed (onTree never
    // runs).
    let capturedRationale: ExtractRationaleResult = {
      symbols: [],
      edges: [],
      truncatedFacts: 0,
    };
    // Same default-shape reasoning as capturedRationale above, but this pass
    // has no skip condition (see the onTree callback below) -- it always
    // runs when the parse succeeds, so this default is only ever observed
    // when the parse itself fails and onTree never runs.
    let capturedCanopyPatterns: ExtractCanopyPatternsResult = {
      symbols: [],
      edges: [],
      truncatedFacts: 0,
    };
    const facts = extractFileFacts({
      grammar,
      runtime: this.runtime,
      repoId,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      source,
      sizeBytes: entry.sizeBytes,
      mtimeNs: entry.mtimeNs,
      contentHash,
      isTestFile,
      // One parse serves fact, import, and rationale-comment extraction (no
      // reparse). Rationale binding needs both the tree AND the in-progress
      // definitions list, which only exist together inside this callback
      // (see the ExtractFileInput.onTree comment in tags-extractor.ts) — it
      // cannot be deferred until after extractFileFacts returns because the
      // tree is deleted once withTree's scope closes.
      onTree: (tree, definitions) => {
        if (isCustomGrammar) {
          // Custom languages get the generic tags path ONLY: the import,
          // rationale, and canopy-pattern walkers below all assume TS/JS
          // node shapes. The captured* defaults above are already the
          // correct empty shapes for this early return.
          return;
        }
        capturedImports = extractImportsFromTree(tree);
        if (!skipRationale) {
          capturedRationale = extractRationale({
            tree,
            source,
            repoId,
            relativePath: entry.relativePath,
            fileId,
            fileSymbolId,
            definitions,
          });
        }
        // Unlike rationale, canopy-pattern extraction has no test-file /
        // generated-dir skip -- a test file that legitimately references an
        // IPC channel still produces a real invoker edge (see
        // extract/canopy-patterns.ts's module comment and the contract it
        // implements).
        capturedCanopyPatterns = extractCanopyPatterns({
          tree,
          source,
          repoId,
          relativePath: entry.relativePath,
          fileId,
          fileSymbolId,
          definitions,
        });
      },
    });
    const fileSymbol = facts.symbols.find((symbol) => symbol.kind === 'file');
    const imports =
      facts.file.parseStatus === 'parsed' && fileSymbol !== undefined
        ? importsToEdges({
            repoId,
            relativePath: entry.relativePath,
            fileSymbolId: fileSymbol.id,
            fileId: facts.file.id,
            imports: capturedImports,
          })
        : [];
    // The file symbol is built inside extractFileFacts, so recording the
    // rationale truncation count on its `extra` means mutating the already-
    // built record in place before it goes to replaceFileFacts — `fileSymbol`
    // here is the same object referenced from `facts.symbols`, so this
    // mutation is visible in the spread below. This mirrors how
    // manifest-extractors.ts / markdown-extractor.ts set `extra.truncatedFacts`
    // on a freshly-built file symbol; the only difference is this one is
    // built by a different module and handed back to us.
    // Combined additively (not overwritten) because both passes can
    // independently truncate on the SAME file: a code file can have both
    // rationale comments over RATIONALE_MAX_PER_FILE and (in principle) an
    // IPC_CHANNELS declaration over IPC_CHANNEL_MAX_PER_FILE.
    const totalTruncatedFacts =
      capturedRationale.truncatedFacts + capturedCanopyPatterns.truncatedFacts;
    if (totalTruncatedFacts > 0 && fileSymbol !== undefined) {
      fileSymbol.extra = {
        ...fileSymbol.extra,
        truncatedFacts: totalTruncatedFacts,
      };
    }
    this.store.replaceFileFacts({
      ...facts,
      symbols: [
        ...facts.symbols,
        ...capturedRationale.symbols,
        ...capturedCanopyPatterns.symbols,
      ],
      edges: [
        ...facts.edges,
        ...imports,
        ...capturedRationale.edges,
        ...capturedCanopyPatterns.edges,
      ],
    });
    return {
      parsed: 1,
      skipped: 0,
      unchanged: 0,
      failures: facts.file.parseStatus === 'failed' ? 1 : 0,
      unreadable: 0,
      factsChanged: true,
      contentReadFailed: false,
    };
  }

  // Non-code path: mirrors processGrammarFile's oversized check and hash
  // fastpath exactly, then hands the already-read source to the matched
  // extractor. Extraction failures never kill the build — a throwing
  // extractor downgrades to a file-symbol-only `failed` record instead of
  // aborting the whole repository scan.
  private async processNonCodeFile(input: {
    repoId: string;
    entry: ScannedSourceFile;
    extractor: NonCodeExtractorDefinition;
    prior: ExistingFileIndexEntry | undefined;
    forceFullReparse: boolean;
  }): Promise<FileProcessOutcome> {
    const { repoId, entry, extractor, prior, forceFullReparse } = input;
    if (entry.sizeBytes > CODE_GRAPH_MAX_FILE_BYTES) {
      if (
        !forceFullReparse &&
        prior?.parseStatus === 'skipped_too_large' &&
        prior.sizeBytes === entry.sizeBytes
      ) {
        this.store.touchFileStat(
          fileRowId(repoId, entry.relativePath),
          entry.absolutePath,
          entry.sizeBytes,
          entry.mtimeNs,
        );
        return {
          parsed: 0,
          skipped: 1,
          unchanged: 0,
          failures: 0,
          unreadable: 0,
          factsChanged: false,
          contentReadFailed: false,
        };
      }
      this.store.replaceFileFacts(
        buildOversizedFileFacts({
          repoId,
          relativePath: entry.relativePath,
          absolutePath: entry.absolutePath,
          grammarId: extractor.id,
          sizeBytes: entry.sizeBytes,
          mtimeNs: entry.mtimeNs,
        }),
      );
      return {
        parsed: 0,
        skipped: 1,
        unchanged: 0,
        failures: 0,
        unreadable: 0,
        factsChanged: true,
        contentReadFailed: false,
      };
    }
    const readStartedAt = this.now();
    let source: string;
    try {
      source = await fs.readFile(entry.absolutePath, 'utf8');
    } catch (error) {
      return failedReadOutcome(error);
    }
    const contentHash = computeContentHash(source);
    this.activeTimer?.add('hash', this.now() - readStartedAt);
    if (
      prior !== undefined &&
      prior.contentHash === contentHash &&
      !forceFullReparse
    ) {
      this.store.touchFileStat(
        fileRowId(repoId, entry.relativePath),
        entry.absolutePath,
        entry.sizeBytes,
        entry.mtimeNs,
      );
      return {
        parsed: 0,
        skipped: 0,
        unchanged: 1,
        failures: 0,
        unreadable: 0,
        factsChanged: false,
        contentReadFailed: false,
      };
    }
    let facts: CodeGraphFileFacts;
    try {
      facts = await extractor.extract({
        repoId,
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        source,
        sizeBytes: entry.sizeBytes,
        mtimeNs: entry.mtimeNs,
        contentHash,
        runtime: this.runtime,
      });
    } catch {
      this.store.replaceFileFacts(
        buildFailedNonCodeFileFacts({
          repoId,
          relativePath: entry.relativePath,
          absolutePath: entry.absolutePath,
          extractorId: extractor.id,
          source,
          sizeBytes: entry.sizeBytes,
          mtimeNs: entry.mtimeNs,
          contentHash,
        }),
      );
      return {
        parsed: 1,
        skipped: 0,
        unchanged: 0,
        failures: 1,
        unreadable: 0,
        factsChanged: true,
        contentReadFailed: false,
      };
    }
    // Storage errors must reach the owned build transaction, not become
    // extraction failures followed by a file-symbol-only replacement.
    this.store.replaceFileFacts(facts);
    return {
      parsed: 1,
      skipped: 0,
      unchanged: 0,
      failures: 0,
      unreadable: 0,
      factsChanged: true,
      contentReadFailed: false,
    };
  }

  // Reads + validates the worktree's custom language config for ONE build
  // (Phase 6 Task 8). No worktree root, or no config file, is the documented
  // zero-cost no-op (a single failed readFile syscall in the latter case).
  // A malformed config never fails the build — it degrades to a report whose
  // one config-level diagnostic (index -1) surfaces in build warnings/status.
  private async resolveCustomLanguagesForBuild(): Promise<{
    report: CodeGraphCustomLanguagesReport | null;
    customGrammars: readonly CodeGraphGrammarDefinition[];
    fingerprint: string;
  }> {
    if (this.customLanguagesRootPath === undefined) {
      return {
        report: null,
        customGrammars: [],
        fingerprint: CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
      };
    }
    const configPath = customLanguagesConfigPath(this.customLanguagesRootPath);
    const outcome = await resolveCustomLanguages({
      configPath,
      runtime: this.runtime,
    });
    if (outcome.kind === 'absent') {
      return {
        report: null,
        customGrammars: [],
        fingerprint: outcome.fingerprint.value,
      };
    }
    if (outcome.kind === 'config-error') {
      return {
        report: {
          configPath,
          loaded: [],
          diagnostics: [{ entryId: null, index: -1, message: outcome.error }],
        },
        customGrammars: [],
        fingerprint: outcome.fingerprint.value,
      };
    }
    return {
      report: outcome.report,
      customGrammars: outcome.grammars,
      fingerprint: outcome.fingerprint.value,
    };
  }

  public async buildOrUpdate(
    options?: CodeGraphInternalBuildOptions,
  ): Promise<CodeGraphBuildResult> {
    const forcedFull = new Set<string>();
    while (true) {
      const membershipBeforeAttempt = this.repositorySetChanged;
      try {
        return await this.buildOrUpdateAttempt(options, Array.from(forcedFull));
      } catch (error) {
        if (!(error instanceof ResolutionCandidateNeedsFullPass)) throw error;
        this.repositorySetChanged = membershipBeforeAttempt;
        const before = forcedFull.size;
        for (const repoId of error.repositoryIds) forcedFull.add(repoId);
        if (
          forcedFull.size === before ||
          forcedFull.size > this.repositories.length
        )
          throw error;
        // All publication rolled back. Retry only in a NEW owned transaction.
      }
    }
  }

  private async buildOrUpdateAttempt(
    options: CodeGraphInternalBuildOptions | undefined,
    forcedFullRepositoryIds: readonly string[],
  ): Promise<CodeGraphBuildResult> {
    this.lastResolutionProjectionCounters = null;
    // Phase timings observe the build; they never change what it does.
    const timer = new CodeGraphBuildTimer({
      db: this.db,
      now: this.now,
      walPath: this.walPath,
      prelude: options?.prelude,
    });
    let commitStartedAt: number | undefined;
    this.activeTimer = timer;
    let result: CodeGraphBuildResult;
    try {
      result = await withImmediateTransactionAsync(this.db, async () => {
        const mode = options?.resolutionMode ?? 'full-reset';
        const candidate =
          options?.captureResolutionDependencies === true ||
          mode === 'incremental'
            ? new ResolutionCandidateBuildSession(
                this.db,
                this.store,
                this.repositories,
                mode,
                forcedFullRepositoryIds,
              )
            : undefined;
        try {
          const built = await this.buildOrUpdateInTransaction(
            options,
            timer,
            candidate,
          );
          const diagnostics = candidate?.getResult();
          if (diagnostics !== undefined && diagnostics !== null) {
            this.lastResolutionProjectionCounters = diagnostics.projection;
            setMetadataValue(
              this.db,
              'resolution_candidate_diagnostics',
              JSON.stringify({
                ...diagnostics,
                fullRepositoryRetries: forcedFullRepositoryIds.length,
              }),
            );
          }
          commitStartedAt = timer.now();
          return built;
        } finally {
          candidate?.close();
        }
      });
    } finally {
      this.activeTimer = undefined;
    }
    timer.persistAfterCommit(
      commitStartedAt === undefined ? 0 : timer.now() - commitStartedAt,
      Date.now(),
    );
    return { ...result, timings: timer.result() };
  }

  private async buildOrUpdateInTransaction(
    options: CodeGraphInternalBuildOptions | undefined,
    timer: CodeGraphBuildTimer,
    candidate?: ResolutionCandidateBuildSession,
  ): Promise<CodeGraphBuildResult> {
    const startedAt = Date.now();
    // Read the portable projection before timer/metadata writes can alter the
    // view. The outer build transaction keeps this read consistent with the
    // facts later published below.
    const priorSummaryProjection = readCodeGraphSummaryProjectionFromDatabase(
      this.db,
    );
    const prepareStartedAt = timer.now();
    // Read before this build writes anything: whether this database has ever
    // completed a graph, for time to first graph.
    timer.begin(
      getMetadataValue(this.db, 'completed_build_at') === null &&
        getMetadataValue(this.db, 'last_build_at') === null,
    );
    let filesScanned = 0;
    let filesParsed = 0;
    let filesUnchanged = 0;
    let filesSkipped = 0;
    let filesRemoved = 0;
    let parseFailures = 0;
    let filesUnreadable = 0;
    let contentVerificationIncomplete = false;
    const repositoriesWithHeads = await Promise.all(
      this.repositories.map(async (repository) => ({
        ...repository,
        gitHead: await gitHeadFor(repository.rootPath),
      })),
    );
    const repositoryMembershipChanged = this.store.reconcileRepositories(
      repositoriesWithHeads,
    );
    let factsChanged = this.repositorySetChanged || repositoryMembershipChanged;
    if (factsChanged) candidate?.markAllGlobal('repository-membership');
    this.repositorySetChanged = false;
    for (const repository of this.repositories) {
      if (
        await resolutionInputsChanged(
          repository.rootPath,
          getMetadataValue(this.db, `resolution_inputs:${repository.repoId}`),
        )
      ) {
        factsChanged = true;
        candidate?.markGlobal(repository.repoId, 'external-resolution-input');
      }
    }

    // Custom language config: read + validated once per build; the effective
    // grammar list (built-ins + validated customs) and the scanner's custom
    // extension set both derive from it. Persisted to graph metadata so
    // `getStatus` reports the LAST build's outcome even from a fresh engine.
    const customLanguages = await this.resolveCustomLanguagesForBuild();
    const extractorChanged =
      getMetadataValue(this.db, 'extractor_version') !==
      String(CODE_GRAPH_EXTRACTOR_VERSION);
    const customLanguagesChanged =
      getMetadataValue(this.db, 'custom_languages_fingerprint') !==
      customLanguages.fingerprint;
    // The extractor or grammar configuration moves forward with this build, so
    // every prior fact is stale: an unreadable file cannot keep its rows (its
    // unchanged size/mtime would later hide that it was never reparsed).
    const configurationChanged = extractorChanged || customLanguagesChanged;
    const forceFullReparse =
      configurationChanged || options?.forceReparse === true;
    factsChanged ||= extractorChanged || customLanguagesChanged;
    if (
      extractorChanged ||
      customLanguagesChanged ||
      options?.forceReparse === true
    )
      candidate?.markAllGlobal('extractor-configuration');
    if (customLanguages.customGrammars.length > 0)
      candidate?.markAllGlobal('custom-grammar');
    const effectiveGrammars = mergeEffectiveGrammars(
      customLanguages.customGrammars,
    );
    const customExtensions = customLanguages.customGrammars.flatMap(
      (definition) => definition.extensions,
    );
    setMetadataValue(
      this.db,
      'custom_languages',
      customLanguages.report === null
        ? ''
        : JSON.stringify(customLanguages.report),
    );
    setMetadataValue(
      this.db,
      'custom_languages_fingerprint',
      customLanguages.fingerprint,
    );

    timer.add('prepare', timer.now() - prepareStartedAt - timer.total('fts'));
    timer.persist('prepare');

    const scans = new Map<string, ScanDiagnostics>();
    for (const repository of this.repositories) {
      const scanStartedAt = timer.now();
      const scan: ScanDiagnostics = {
        eligibleFiles: 0,
        unsupportedFiles: 0,
        excludedFiles: 0,
        examples: [],
      };
      // Listed files that exist but could not be stat'ed: they keep their
      // facts (they are not removed) and count as unreadable, unless the
      // extractor configuration changed (then they are removed and re-added
      // once readable).
      const unreadablePaths = new Set<string>();
      const scanned = await enumerateSourceFiles(repository.rootPath, {
        customExtensions,
        onUnreadable: (relativePath) => unreadablePaths.add(relativePath),
        onDisposition: (relativePath, disposition) => {
          if (disposition === 'eligible') scan.eligibleFiles++;
          else {
            if (disposition === 'unsupported') scan.unsupportedFiles++;
            else scan.excludedFiles++;
            if (scan.examples.length < 10) scan.examples.push(relativePath);
          }
        },
      });
      scans.set(repository.repoId, scan);
      filesScanned += scanned.length;
      const existing = this.store.listFileIndex(repository.repoId);
      const existingByPath = new Map(
        existing.map((candidate) => [candidate.relativePath, candidate]),
      );
      const plan = planFileWork(
        scanned,
        configurationChanged
          ? existing
          : existing.filter(
              (entry) => !unreadablePaths.has(entry.relativePath),
            ),
        {
          forceFullReparse: forceFullReparse || options?.verifyContent === true,
        },
      );
      if (unreadablePaths.size > 0) {
        filesUnreadable += unreadablePaths.size;
        contentVerificationIncomplete = true;
        candidate?.markGlobal(repository.repoId, 'content-read-failed');
      }
      filesUnchanged += plan.unchanged;
      const toRemove = [...plan.toRemove];
      const toParsePaths = new Set(
        plan.toParse.map((entry) => entry.relativePath),
      );
      for (const entry of scanned) {
        if (!toParsePaths.has(entry.relativePath)) {
          this.store.touchFileStat(
            fileRowId(repository.repoId, entry.relativePath),
            entry.absolutePath,
            entry.sizeBytes,
            entry.mtimeNs,
          );
        }
      }
      timer.add('scan', timer.now() - scanStartedAt);

      for (const entry of plan.toParse) {
        const fileStartedAt = timer.now();
        const hashBefore = timer.total('hash');
        const ftsBefore = timer.total('fts');
        const effectiveGrammar = effectiveGrammarForPath(
          effectiveGrammars,
          entry.relativePath,
        );
        const prior = existingByPath.get(entry.relativePath);
        candidate?.preserve(fileRowId(repository.repoId, entry.relativePath));
        let outcome: FileProcessOutcome;
        if (effectiveGrammar !== undefined) {
          outcome = await this.processGrammarFile({
            repoId: repository.repoId,
            entry,
            effectiveGrammar,
            prior,
            forceFullReparse:
              forceFullReparse ||
              (options?.verifyContent === true &&
                prior?.parseStatus === 'failed'),
          });
        } else {
          const nonCodeExtractor = nonCodeExtractorForPath(entry.relativePath);
          if (nonCodeExtractor === undefined) {
            continue;
          }
          outcome = await this.processNonCodeFile({
            repoId: repository.repoId,
            entry,
            extractor: nonCodeExtractor,
            prior,
            forceFullReparse:
              forceFullReparse ||
              (options?.verifyContent === true &&
                prior?.parseStatus === 'failed'),
          });
        }
        filesParsed += outcome.parsed;
        filesSkipped += outcome.skipped;
        filesUnchanged += outcome.unchanged;
        parseFailures += outcome.failures;
        filesUnreadable += outcome.unreadable;
        // A read failure keeps prior facts, except under a changed extractor
        // configuration, where they are stale (see `configurationChanged`).
        if (outcome.unreadable > 0 && configurationChanged)
          toRemove.push(entry.relativePath);
        factsChanged ||= outcome.factsChanged;
        if (outcome.factsChanged)
          candidate?.changed(
            repository.repoId,
            fileRowId(repository.repoId, entry.relativePath),
          );
        if (outcome.contentReadFailed)
          candidate?.markGlobal(repository.repoId, 'content-read-failed');
        contentVerificationIncomplete ||= outcome.contentReadFailed;
        // File processing excluding its separately measured hashing and FTS work.
        timer.add(
          'parse',
          timer.now() -
            fileStartedAt -
            (timer.total('hash') - hashBefore) -
            (timer.total('fts') - ftsBefore),
        );
      }

      for (const relativePath of toRemove)
        candidate?.preserve(fileRowId(repository.repoId, relativePath));
      const removalFtsBefore = timer.total('fts');
      timer.measure('scan', () =>
        this.store.removeFiles(repository.repoId, toRemove),
      );
      timer.add('scan', -(timer.total('fts') - removalFtsBefore));
      for (const relativePath of toRemove)
        candidate?.changed(
          repository.repoId,
          fileRowId(repository.repoId, relativePath),
          true,
        );
      filesRemoved += toRemove.length;
      factsChanged ||= toRemove.length > 0;
    }
    timer.persist('scan', 'hash', 'parse');

    const computeDerived = options?.computeDerived ?? true;
    const derivedNeedsRefresh =
      computeDerived &&
      (factsChanged || getMetadataValue(this.db, 'derived_at') === null);
    // Deferral moves derived analysis and its diagnostics out of this
    // transaction (see deferred-derived.ts); only a build that would run
    // them defers.
    const deferDerived = derivedNeedsRefresh && options?.deferDerived === true;
    const derived: CodeGraphDerivedRepoStats[] = [];
    if (candidate !== undefined && candidate.needsResolution(factsChanged))
      candidate.run(timer);
    if (factsChanged && candidate === undefined) {
      const dependencies = new SqliteResolutionDependencyWriter(this.db);
      for (const repository of this.repositories)
        dependencies.invalidateMetadata(repository.repoId);
    }
    if (
      factsChanged &&
      candidate === undefined &&
      options?.resolutionMode === 'full-diff'
    ) {
      this.lastResolutionProjectionCounters = runFullResolutionDiff(
        this.db,
        this.store,
        this.repositories,
        timer,
      );
    }
    if (
      factsChanged &&
      candidate === undefined &&
      options?.resolutionMode !== 'full-diff'
    ) {
      // Shared post-processing: identical for full builds and incremental updates.
      timer.measure('resetMs', () => {
        this.store.resetResolutions();
        this.store.nullDanglingEdgeTargets();
      });
      for (const repository of this.repositories) {
        const resolver = new TsModuleResolver(repository.rootPath);
        timer.measure('importsMs', () =>
          resolveImportEdges({
            store: this.store,
            resolver,
            repoId: repository.repoId,
            rootPath: repository.rootPath,
          }),
        );
        setMetadataValue(
          this.db,
          `resolution_inputs:${repository.repoId}`,
          JSON.stringify(resolver.getInputFingerprints()),
        );
        // Doc-link resolution runs after import-edge resolution (so any future
        // shared-target-resolution refactor stays consistent with the
        // "code first, then docs" order) and before call resolution — call
        // binding only ever looks at CALLS/REFERENCES edges, so the relative
        // order between doc-link and call resolution is not actually
        // load-bearing, but is fixed here for a single documented pass order.
        timer.measure('configExtendsMs', () =>
          resolveConfigExtendsEdges({
            store: this.store,
            repoId: repository.repoId,
            rootPath: repository.rootPath,
          }),
        );
        timer.measure('docLinksMs', () =>
          resolveDocLinkEdges({
            store: this.store,
            repoId: repository.repoId,
            rootPath: repository.rootPath,
          }),
        );
        // IPC resolution runs after doc-link and before call resolution, same
        // "fixed for one documented pass order" reasoning as above: it only
        // touches IPC_HANDLES/IPC_INVOKES edges, which no other resolver in
        // this pipeline reads or writes, so the ordering relative to its
        // neighbors is not load-bearing either.
        timer.measure('ipcMs', () =>
          resolveIpcEdges({ store: this.store, repoId: repository.repoId }),
        );
        // Workflow-action resolution runs after IPC resolution and before call
        // resolution, same "fixed for one documented pass order" reasoning as
        // its neighbors above: it only touches USES_PIPELINE_ACTION edges
        // (workflow_job source, action.yml/action.yaml file-symbol target)
        // that no other resolver in this pipeline reads or writes, so its
        // position relative to its neighbors is not load-bearing either.
        timer.measure('workflowActionsMs', () =>
          resolveWorkflowActionEdges({
            store: this.store,
            repoId: repository.repoId,
          }),
        );
        timer.measure('callsMs', () =>
          resolveCallEdges({ store: this.store, repoId: repository.repoId }),
        );
        timer.measure('testsMs', () =>
          linkTests({ store: this.store, repoId: repository.repoId }),
        );
      }
      timer.persist(
        'resetMs',
        'importsMs',
        'configExtendsMs',
        'docLinksMs',
        'ipcMs',
        'workflowActionsMs',
        'callsMs',
        'testsMs',
      );
    }
    // Store fact writers maintain trusted file projections. Repair legacy or
    // cold mappings once even when no source facts changed.
    const mappingRepairNeeded = !isSymbolFtsMappingTrusted(this.db);
    if (mappingRepairNeeded) {
      timer.measure('fts', () => rebuildSymbolFts(this.db));
    }
    if (factsChanged || mappingRepairNeeded) timer.persist('fts');
    setMetadataValue(
      this.db,
      'extractor_version',
      String(CODE_GRAPH_EXTRACTOR_VERSION),
    );
    const lastBuildAt = nextLastBuildAt(
      getMetadataValue(this.db, 'last_build_at'),
    );
    setMetadataValue(this.db, 'last_build_at', String(lastBuildAt));

    // Derived analysis (communities + flows) runs after every resolver pass
    // and the FTS rebuild above, on the fresh post-resolution graph. Gated on
    // `computeDerived` (default TRUE for every real build) so the one caller
    // that opts out -- impact/before-graph.ts's ephemeral scoped rebuild --
    // never pays this cost. `computeDerivedForRepo` itself yields once
    // between its two O(graph) analysis stages (see analysis/derived.ts's
    // module comment); by the time each iteration's `await` resolves, the
    // event loop has already had a turn, so this loop does not need its own
    // additional per-repo yield on top of that.
    // Changed facts invalidate any previously recorded derived freshness even
    // when this caller opted out of derived work or every analysis fails. A
    // later normal build can then repair the derived tables on an otherwise
    // zero-mutation pass. Snapshot import uses the same missing-marker
    // contract after clearing its derived rows.
    if (factsChanged) {
      deleteMetadataValue(this.db, 'derived_at');
    }
    const freshness = contentVerificationIncomplete
      ? 'stat'
      : forceFullReparse
        ? 'reparsed'
        : options?.verifyContent === true
          ? 'content'
          : 'stat';
    const reusableProjection =
      !factsChanged &&
      !derivedNeedsRefresh &&
      priorSummaryProjection.state === 'ready'
        ? priorSummaryProjection.projection
        : undefined;
    if (deferDerived) {
      // Publish now: the graph is complete and searchable; communities,
      // flows and diagnostics follow in `completeDeferredDerived`. Until
      // then the earlier analysis is reported as stale.
      const diagnosticsStartedAt = timer.now();
      recordDeferredDerived({
        db: this.db,
        repoIds: this.repositories.map((repository) => repository.repoId),
        scans,
        freshness,
        factsChanged,
      });
      markGraphDiagnosticsStale({ db: this.db, scans, freshness });
      timer.add('diagnostics', timer.now() - diagnosticsStartedAt);
      timer.persist('diagnostics');
      timer.persistTransactionTotals();
      setMetadataValue(this.db, 'completed_build_at', String(Date.now()));
      this.publishSummaryProjection(reusableProjection);
      return {
        filesScanned,
        filesParsed,
        filesUnchanged,
        filesSkipped,
        filesRemoved,
        parseFailures,
        ...(filesUnreadable > 0 ? { filesUnreadable } : {}),
        symbolCount: this.store.countSymbols(),
        edgeCount: this.store.countEdges(),
        durationMs: Date.now() - startedAt,
        derived,
        customLanguages: customLanguages.report,
        factsChanged,
        lastBuildAt,
        derivedDeferred: true,
      };
    }
    if (derivedNeedsRefresh) {
      clearDeferredDerived(this.db);
      const derivedStartedAt = timer.now();
      for (const repository of this.repositories) {
        try {
          derived.push(
            await computeDerivedForRepo({
              store: this.store,
              repoId: repository.repoId,
            }),
          );
        } catch (error) {
          // Defensive total-guarantee: `computeDerivedForRepo` catches its
          // own analysis failures, but its error-REPORTING path reads
          // `getDerivedStats` from the store -- if THAT read throws too (a
          // genuinely broken db handle), the rejection lands here instead
          // of failing the whole build. Counts are hardcoded to 0 because
          // the one honest source for them is exactly what just threw.
          derived.push({
            repoId: repository.repoId,
            computed: false,
            communityCount: 0,
            flowCount: 0,
            communitiesSkipped: false,
            flowsGlobalCapReached: false,
            warnings: [
              `derived analysis failed unexpectedly for ${repository.repoId}: ${error instanceof Error ? error.message : String(error)}`,
            ],
          });
        }
      }
      // Only stamp `derived_at` when at least one repository's derived
      // analysis actually completed -- an all-failed build (every repo's
      // analysis stage threw) must not claim derived data is fresh.
      if (derived.some((entry) => entry.computed)) {
        setMetadataValue(this.db, 'derived_at', String(Date.now()));
      }
      timer.add('derived', timer.now() - derivedStartedAt);
      timer.persist('derived');
    } else if (computeDerived) {
      for (const repository of this.repositories) {
        const stats = this.store.getDerivedStats(repository.repoId);
        derived.push({
          repoId: repository.repoId,
          computed: false,
          communityCount: stats.communityCount,
          flowCount: stats.flowCount,
          communitiesSkipped: false,
          flowsGlobalCapReached: false,
          warnings: [],
        });
      }
    }
    const diagnosticsStartedAt = timer.now();
    recordGraphDiagnostics({
      db: this.db,
      scans,
      derived,
      derivedRefreshed: derivedNeedsRefresh,
      computeDerived,
      factsChanged,
      freshness,
    });
    timer.add('diagnostics', timer.now() - diagnosticsStartedAt);
    timer.persist('diagnostics');
    timer.persistTransactionTotals();
    setMetadataValue(this.db, 'completed_build_at', String(Date.now()));
    this.publishSummaryProjection(reusableProjection);

    return {
      filesScanned,
      filesParsed,
      filesUnchanged,
      filesSkipped,
      filesRemoved,
      parseFailures,
      ...(filesUnreadable > 0 ? { filesUnreadable } : {}),
      symbolCount: this.store.countSymbols(),
      edgeCount: this.store.countEdges(),
      durationMs: Date.now() - startedAt,
      derived,
      customLanguages: customLanguages.report,
      factsChanged,
      lastBuildAt,
    };
  }

  private publishSummaryProjection(
    reuseProjection?: CodeGraphSummaryProjectionV1,
  ): void {
    publishCodeGraphSummaryProjection(this.db, {
      ...(reuseProjection === undefined ? {} : { reuseProjection }),
      ...(this.customLanguagesRootPath === undefined
        ? {}
        : { worktreeRootPath: this.customLanguagesRootPath }),
    });
  }

  /**
   * Runs the derived analysis a `deferDerived` build left pending, exactly
   * as that build would have run it inline; a no-op when nothing is pending.
   */
  public async completeDeferredDerived(): Promise<CodeGraphDeferredDerivedResult> {
    // Track every outstanding call without changing existing concurrency policy.
    this.activeDeferredAnalyses += 1;
    try {
      return await completeDeferredCodeGraphDerived({
        db: this.db,
        store: this.store,
        now: this.now,
        ...(this.customLanguagesRootPath === undefined
          ? {}
          : { worktreeRootPath: this.customLanguagesRootPath }),
      });
    } finally {
      this.activeDeferredAnalyses -= 1;
    }
  }

  /** Synchronously repair metadata through this engine's existing idle writer. */
  public repairSummaryProjection(): BackfillCodeGraphSummaryProjectionResult {
    if (this.closed) return { state: 'error', classification: 'io' };
    if (
      this.activeTimer !== undefined ||
      this.activeDeferredAnalyses > 0 ||
      hasActiveCodeGraphWriteTransaction(this.db)
    ) {
      return { state: 'error', classification: 'busy' };
    }
    return backfillCodeGraphSummaryProjection(this.dbPath, {
      db: this.db,
      ...(this.customLanguagesRootPath === undefined
        ? {}
        : { worktreeRootPath: this.customLanguagesRootPath }),
    });
  }

  public getStatus(): CodeGraphStatus {
    const lastBuildRaw = getMetadataValue(this.db, 'last_build_at');
    const derivedAtRaw = getMetadataValue(this.db, 'derived_at');
    const derivedStats = this.store.getDerivedStats();
    // '' is the persisted "last build saw no config" marker (see
    // buildOrUpdate); parseCustomLanguagesReport degrades corrupt/legacy
    // metadata to null rather than throwing out of a status read.
    const customLanguagesRaw = getMetadataValue(this.db, 'custom_languages');
    const customLanguages =
      customLanguagesRaw === null || customLanguagesRaw === ''
        ? null
        : parseCustomLanguagesReport(customLanguagesRaw);
    return {
      diagnostics: readGraphDiagnostics(this.db),
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
      repositories: this.store.listRepositories().map((repository) => ({
        repoId: repository.repoId,
        rootPath: repository.rootPath,
        gitHead: repository.gitHead,
        fileCount: this.store.countFiles(repository.repoId),
      })),
      symbolCount: this.store.countSymbols(),
      edgeCount: this.store.countEdges(),
      unresolvedEdgeCount: this.store.countUnresolvedEdges(),
      filesWithErrors: this.store.countFilesWithErrors(),
      lastBuildAt: lastBuildRaw === null ? null : Number(lastBuildRaw),
      communityCount: derivedStats.communityCount,
      flowCount: derivedStats.flowCount,
      derivedAt: derivedAtRaw === null ? null : Number(derivedAtRaw),
      customLanguages,
    };
  }

  public close(): void {
    this.closed = true;
    // Only dispose a runtime this engine created; an injected (caller-owned)
    // runtime is left intact for the injector to keep reusing.
    if (this.ownsRuntime) {
      this.runtime.dispose();
    }
    // A desktop read worker may keep a read-only connection open between
    // requests, and any open connection stops this close from checkpointing
    // and deleting the WAL. Empty it explicitly so a build's WAL, up to its
    // whole transaction, never outlives the build. Without other connections
    // the close below still removes the file. A reader mid-transaction can
    // make this a partial checkpoint (it waits up to busy_timeout); that
    // leaves the WAL as it was before this step, never wrong data.
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Closing must not fail on a checkpoint; SQLite retries it later.
    }
    this.db.close();
  }
}
