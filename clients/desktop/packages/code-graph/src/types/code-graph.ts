export const CODE_GRAPH_SCHEMA_VERSION = 5;
// Bumped 4 -> 5: added the symbol FTS rowid map and empty W3 dependency-table
// schema. Existing graph facts are preserved; the ordinary engine build repairs
// both FTS indexes and publishes the map's schema/writer completion marker.
//
// Bumped 3 -> 4: index-only (partial edge target index, NOCASE symbol name
// index). A worktree graph migrates in place on its next build, which the
// scheduler requests because the stored schema version no longer matches;
// published bases with the old version are rejected and rebuilt.
//
// Bumped 2 -> 3: added the Unicode-folded trigram fragment index used by
// interactive symbol search so interior matches never scan every symbol.
// Existing graphs rebuild this derived index during their next graph build.
//
// Bumped 1 -> 2: added derived-analysis tables -- communities,
// community_memberships, flows, flow_memberships (Phase 6 Task 3; see
// store/migrations.ts's v2 migration) -- for the community detection and
// flow tracing that later Phase 6 tasks compute. Purely additive: no v1
// table or column changed, so an existing v1 database migrates in place
// with zero data loss, and store/migrations.ts's schema_version-vs-migrations
// out-of-sync guard still holds (the last migration's version and this
// constant stay in lockstep).
//
// CODE_GRAPH_EXTRACTOR_VERSION below has its own INDEPENDENT bump history --
// it tracks parser/extraction behavior changes (what facts get produced),
// not table schema changes (where facts get stored). The two version
// numbers are unrelated and are not expected to move together.
// Bumped 1 -> 2: corpus widened to non-code inputs (markdown, package.json,
// tsconfig*.json, mcp-config are now enumerated and extracted alongside
// grammar-backed source files). A stale extractor_version metadata value
// forces a full reparse so previously-built graphs pick up the new non-code
// file records.
//
// Bumped 2 -> 3: canopy-pattern extraction added (IPC channel declarations,
// IPC_HANDLES/IPC_INVOKES call-site edges, and injected-tool-registry
// mcp_tool/DECLARES_MCP_TOOL facts -- see extract/canopy-patterns.ts). A
// stale value forces a full reparse so previously-built graphs pick up these
// new facts. NOTE: Phase 5 Task 1 (ontology widening) deliberately left this
// at 2 with no bump -- it only widened the symbol/edge kind type surface,
// with no extraction behavior change -- so Task 2 (this bump) is the first
// real behavior change since 2. This is ONE bump, not two: nothing between
// Task 1 and this change justifies landing on 4.
//
// Bumped 3 -> 4: channel-registry extraction generalized from the single
// literal `IPC_CHANNELS` to any top-level `export const <NAME>` matching
// /^[A-Z][A-Z0-9_]*_CHANNELS$/ (SKILLS_CHANNELS, PLUGINS_CHANNELS,
// PIPELINE_CHANNELS, ...), with the registry constant name recorded in
// symbol `extra` / edge `evidence`. A stale value forces a full reparse so
// previously-built graphs pick up the secondary-registry channel symbols and
// their handler/invoker edges.
// Bumped 5 -> 6: Swift declarations, Prisma schema facts, Markdown reference
// links and relative config inheritance require re-extracting existing files.
export const CODE_GRAPH_EXTRACTOR_VERSION = 6;
export const CODE_GRAPH_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const CODE_GRAPH_SYMBOL_KINDS = [
  'file',
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'method',
  'variable',
  'module',
  'doc_section',
  'dependency',
  'script',
  'config',
  'rationale',
  'ipc_channel',
  'mcp_tool',
  'workflow',
  'workflow_job',
] as const;
export type CodeGraphSymbolKind = (typeof CODE_GRAPH_SYMBOL_KINDS)[number];

export const CODE_GRAPH_EDGE_KINDS = [
  'CONTAINS',
  'CALLS',
  'IMPORTS_FROM',
  'REFERENCES',
  'TESTED_BY',
  'DOCUMENTS',
  'DECLARES_DEPENDENCY',
  'DECLARES_SCRIPT',
  'CONFIGURES',
  'RATIONALE_FOR',
  'IPC_HANDLES',
  'IPC_INVOKES',
  'DECLARES_MCP_TOOL',
  'USES_PIPELINE_ACTION',
] as const;
export type CodeGraphEdgeKind = (typeof CODE_GRAPH_EDGE_KINDS)[number];

export const CODE_GRAPH_CONFIDENCE_TIERS = [
  'EXTRACTED',
  'RESOLVED',
  'INFERRED',
  'AMBIGUOUS',
] as const;
export type CodeGraphConfidenceTier =
  (typeof CODE_GRAPH_CONFIDENCE_TIERS)[number];

export const CODE_GRAPH_PARSE_STATUSES = [
  'parsed',
  'failed',
  'skipped_too_large',
] as const;
export type CodeGraphParseStatus = (typeof CODE_GRAPH_PARSE_STATUSES)[number];

export interface CodeGraphRepositoryInput {
  repoId: string;
  rootPath: string;
}

export interface CodeGraphFileRecord {
  id: string;
  repositoryId: string;
  relativePath: string;
  absolutePath: string;
  language: string | null;
  contentHash: string | null;
  sizeBytes: number;
  mtimeNs: string;
  lineCount: number | null;
  grammarId: string | null;
  grammarAbi: number | null;
  parseStatus: CodeGraphParseStatus;
  hasErrors: boolean;
  updatedAt: number;
}

export interface CodeGraphSymbolRecord {
  id: string;
  repositoryId: string;
  fileId: string;
  kind: CodeGraphSymbolKind;
  name: string;
  qualifiedName: string;
  parentSymbolId: string | null;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  signature: string | null;
  exported: boolean;
  isTest: boolean;
  extra: Record<string, unknown>;
}

export interface CodeGraphEdgeRecord {
  id: string;
  repositoryId: string;
  kind: CodeGraphEdgeKind;
  sourceSymbolId: string | null;
  targetSymbolId: string | null;
  sourceFileId: string;
  targetRef: string | null;
  line: number | null;
  confidenceTier: CodeGraphConfidenceTier;
  confidenceScore: number;
  resolverId: string | null;
  evidence: Record<string, unknown>;
}

export interface CodeGraphFileFacts {
  file: CodeGraphFileRecord;
  symbols: CodeGraphSymbolRecord[];
  edges: CodeGraphEdgeRecord[];
}

// Options for `CodeGraphEngine.buildOrUpdate` (Phase 6 Task 6).
// `computeDerived` defaults to TRUE for every real build (CLI, the
// BuildOrUpdateCodeGraph tool, the background scheduler) -- the derived
// community/flow analysis is meant to always be current. The one caller that
// opts out is `impact/before-graph.ts`'s ephemeral scoped rebuild: it exists
// only to answer "what did this look like before", is thrown away in the same
// call, and paying Louvain + flow-tracing cost on every impact-radius/review
// call would be wasted work for a graph nothing ever reads derived data from.
export interface CodeGraphBuildOptions {
  computeDerived?: boolean;
  /** Read every eligible file to verify bytes even when its stat is unchanged. */
  verifyContent?: boolean;
  /** Recovery path: bypass both stat and extraction caches. */
  forceReparse?: boolean;
  /**
   * Publish the refreshed graph without waiting for derived analysis. When
   * facts changed (or derived data is missing), the build commits facts,
   * resolutions and the full-text index, clears `derived_at` and marks the
   * community and flow statuses `stale`; `CodeGraphEngine.completeDeferredDerived`
   * then runs exactly the inline computation. Ignored when `computeDerived`
   * is false.
   */
  deferDerived?: boolean;
  /**
   * Timings measured before the build started, persisted with its own. Only
   * observed: they never change what the build does.
   */
  prelude?: CodeGraphBuildPrelude;
}

/**
 * What callers measured before the engine's build transaction began. All
 * durations are milliseconds.
 */
export interface CodeGraphBuildPrelude {
  /** Time the build waited in the desktop worker queue. */
  queueWaitMs?: number;
  /** The worktree fingerprint read that decided the build was needed. */
  fingerprintMs?: number;
  /** Copying published base generations into seed or base staging. */
  seedCopyMs?: number;
  /** Fusing seed sources into the worktree database. */
  fusionMs?: number;
  /**
   * Epoch milliseconds of the first request for a graph this database has
   * never completed. Present only while no build has completed it.
   */
  firstGraphRequestedAt?: number;
}

/** Wall time of each resolver pass, summed over repositories. */
export interface CodeGraphResolverTimings {
  /** Clearing prior resolutions and dangling edge targets. */
  resetMs: number;
  importsMs: number;
  configExtendsMs: number;
  docLinksMs: number;
  ipcMs: number;
  workflowActionsMs: number;
  callsMs: number;
  testsMs: number;
}

/**
 * Where one build's time went, persisted as `build_timing:*` graph metadata
 * and reported to the caller. Durations are milliseconds rounded to 0.1.
 * Optional phases are absent when they did not run.
 */
export interface CodeGraphBuildTimings extends Omit<
  CodeGraphBuildPrelude,
  'firstGraphRequestedAt'
> {
  /** Repository heads, resolution inputs and custom-language config. */
  prepareMs: number;
  /** Enumerating files and planning their work, summed over repositories. */
  scanMs: number;
  /** Reading and hashing the files the plan selected. */
  hashMs: number;
  /** Parsing, extracting and storing the files whose content changed. */
  parseMs: number;
  /** Present when facts changed and the resolvers ran. */
  resolveMs?: CodeGraphResolverTimings;
  ftsMs?: number;
  /** Present when derived communities and flows were recomputed. */
  derivedMs?: number;
  diagnosticsMs: number;
  /** Committing the build transaction: when the graph becomes visible. */
  commitMs: number;
  /** Base builds: checkpoint, sync and integrity check before publication. */
  finalizeMs?: number;
  /** Rows the build inserted, updated or deleted (`total_changes()`). */
  rowsWritten: number;
  /**
   * Size of the `-wal` file when the build began. SQLite reuses the file
   * without shrinking it, so `peakWalBytes` is a high-water mark an earlier
   * transaction may have set; this build grew it by the difference.
   */
  walStartBytes?: number;
  /** Largest `-wal` file size seen at a phase boundary or after commit. */
  peakWalBytes?: number;
  /** Peak resident size of the process that ran the build. */
  peakRssBytes?: number;
  /** First request to this database's first completed graph. */
  timeToFirstGraphMs?: number;
}

// Per-repository outcome of the derived-analysis phase (Phase 6 Task 6) --
// one entry per repository `CodeGraphEngine.buildOrUpdate` processed, in the
// same order as its `repositories` input. `computed: false` means the phase
// either did not run for this repo (computeDerived: false) or its analysis
// pass threw and was caught non-fatally -- in the caught-error case,
// `communityCount`/`flowCount` still reflect whatever derived data is
// CURRENTLY in the store (which `replaceDerivedForRepo` never reached, so a
// prior successful build's rows survive untouched) rather than being
// hardcoded to 0, and `warnings` carries the error message.
export interface CodeGraphDerivedRepoStats {
  repoId: string;
  computed: boolean;
  communityCount: number;
  flowCount: number;
  communitiesSkipped: boolean;
  flowsGlobalCapReached: boolean;
  warnings: string[];
}

// --- Custom language config (Phase 6 Task 8) --------------------------------
// One structured warn-and-skip diagnostic for a custom-language config entry
// (or, with `index: -1` and `entryId: null`, for the config file itself when
// it is unreadable/malformed). Diagnostics never fail a build -- the entry is
// skipped and the message surfaces in build result warnings, `CodeGraphStatus`,
// and the CLI `code-graph validate-languages` output.
export interface CodeGraphCustomLanguageDiagnostic {
  // The entry's `id` when it got far enough to have a usable string id; null
  // for config-level problems and entries whose id itself is missing/invalid.
  entryId: string | null;
  // Index into the config's `languages` array; -1 for config-level problems.
  index: number;
  message: string;
}

export interface CodeGraphLoadedCustomLanguage {
  index: number;
  id: string;
  extensions: string[];
  abiVersion: number;
}

// Outcome of reading + validating `<worktree>/.canopy/code-graph/languages.json`
// for one build. `null` (on the fields carrying this type) means no config
// file existed at build time -- the zero-cost no-op path.
export interface CodeGraphCustomLanguagesReport {
  configPath: string;
  loaded: CodeGraphLoadedCustomLanguage[];
  diagnostics: CodeGraphCustomLanguageDiagnostic[];
}

/**
 * Content identity for every input that can affect custom-language extraction.
 * `value` covers the raw config plus the referenced grammar/query bytes;
 * `configPresent` distinguishes the common absent-config case for callers that
 * need to decide whether a snapshot directory is required.
 */
export interface CodeGraphCustomLanguageFingerprint {
  value: string;
  configPresent: boolean;
}

export interface CodeGraphBuildResult {
  filesScanned: number;
  filesParsed: number;
  filesUnchanged: number;
  filesSkipped: number;
  filesRemoved: number;
  parseFailures: number;
  /**
   * Files that exist but could not be read or stat'ed (not missing): their
   * prior facts were kept and the build's freshness is not content-verified.
   * A count only, never paths; present only when non-zero.
   */
  filesUnreadable?: number;
  symbolCount: number;
  edgeCount: number;
  durationMs: number;
  // Empty when `computeDerived: false` was passed; one entry per repository
  // otherwise. See `CodeGraphDerivedRepoStats`'s doc comment above.
  derived: CodeGraphDerivedRepoStats[];
  // Null when the engine has no worktree root or no
  // `.canopy/code-graph/languages.json` existed at build time.
  customLanguages: CodeGraphCustomLanguagesReport | null;
  /** Internal build diagnostic: false means graph-wide post-processing was reused. */
  factsChanged?: boolean;
  /** The `last_build_at` stamp this build wrote, captured in its transaction. */
  lastBuildAt?: number;
  /** Internal build diagnostic: where the build's time went. */
  timings?: CodeGraphBuildTimings;
  /**
   * Present (true) when the build published without derived analysis because
   * `deferDerived` was set; `derived` is then empty and the analysis is
   * pending until `CodeGraphEngine.completeDeferredDerived` runs.
   */
  derivedDeferred?: true;
}

export interface CodeGraphRepositoryStatus {
  repoId: string;
  rootPath: string;
  gitHead: string | null;
  fileCount: number;
}

export interface CodeGraphRepositoryDiagnostics {
  symbolCount: number;
  edgeCount: number;
  communityLimits: {
    symbolResolution: number;
    fileProjection: number;
    maxSymbols: number;
    maxEdges: number;
  };
  repoId: string;
  eligibleFiles: number;
  unsupportedFiles: number;
  excludedFiles: number;
  /** At most ten local paths, from the enumerated corpus (Git-ignored files are not enumerated). */
  examples: string[];
  filesWithErrors: number;
  oversizedFiles: number;
  /**
   * `stale`: derived analysis computed for an earlier build is still stored
   * while analysis of the latest published build is pending.
   */
  communityStatus:
    | 'complete'
    | 'coarse'
    | 'skipped'
    | 'failed'
    | 'not-computed'
    | 'stale';
  flowStatus: 'complete' | 'partial' | 'failed' | 'not-computed' | 'stale';
  warnings: string[];
  /** Includes resolved rows, providing the eligible denominator for each kind/language. */
  edges: Array<{
    kind: string;
    language: string;
    reason: string;
    count: number;
  }>;
}

export interface CodeGraphDiagnostics {
  freshness: 'stat' | 'content' | 'reparsed';
  recordedAt: number;
  repositories: CodeGraphRepositoryDiagnostics[];
}

export interface CodeGraphStatus {
  diagnostics?: CodeGraphDiagnostics | null;
  schemaVersion: number;
  extractorVersion: number;
  repositories: CodeGraphRepositoryStatus[];
  symbolCount: number;
  edgeCount: number;
  unresolvedEdgeCount: number;
  filesWithErrors: number;
  lastBuildAt: number | null;
  // Aggregated across every repository this graph holds -- same convention
  // as `symbolCount`/`edgeCount` above (contrast `CodeGraphRepositoryStatus`,
  // which is per-repo).
  communityCount: number;
  flowCount: number;
  // Null means derived analysis has never completed for this graph (either
  // no build has run yet, or every build so far used
  // `computeDerived: false`) -- the same "never happened yet" idiom
  // `lastBuildAt` already uses, rather than a separate discriminant field.
  derivedAt: number | null;
  // The LAST build's custom-language report, persisted in graph metadata so a
  // freshly reopened engine still reports it. Null when the last build saw no
  // config (or no build has run since the report was introduced).
  customLanguages: CodeGraphCustomLanguagesReport | null;
}

export interface CodeGraphSearchResult {
  matchKind?: 'exact' | 'prefix' | 'token-prefix' | 'fragment';
  symbolId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  lineStart: number;
}

// --- Derived analyses (Phase 6): communities + flows ------------------------
//
// Schema v2 storage shapes only (see CODE_GRAPH_SCHEMA_VERSION's bump
// comment above and store/migrations.ts's v2 migration). Nothing in this
// file computes these -- later Phase 6 tasks add the pure computation
// modules (analysis/communities.ts, analysis/flows.ts) that produce these
// shapes, plus the orchestrator that writes them via
// `CodeGraphStore.replaceDerivedForRepo`. Both record types carry a raw
// (un-hashed) `repositoryId`, matching every other *Record type in this
// file (CodeGraphFileRecord/CodeGraphSymbolRecord/CodeGraphEdgeRecord) --
// see graph-store.ts's read-side joins through `repositories` for why.
// These four tables are intentionally EXCLUDED from the snapshot
// export/import contract (see snapshot/export.ts's comment).

// A community is a Louvain-style partition of symbols (each symbol belongs
// to at most one community; membership is enforced at the application
// layer via `community_memberships`, not a sqlite FK).
export interface CodeGraphCommunityRecord {
  id: string;
  repositoryId: string;
  label: string;
  cohesion: number;
  size: number;
  fingerprint: string;
  extra: Record<string, unknown>;
}

export interface CodeGraphCommunityMembershipRecord {
  communityId: string;
  symbolId: string;
}

// A flow traces reachability forward from one entry-point symbol over
// resolved CALLS edges (see analysis/flows.ts, added by a later Phase 6
// task). Unlike community membership, flow membership is NOT a partition --
// one symbol can appear in multiple flows.
export interface CodeGraphFlowRecord {
  id: string;
  repositoryId: string;
  entrySymbolId: string;
  name: string;
  criticality: number;
  symbolCount: number;
  fileSpread: number;
  maxDepth: number;
  extra: Record<string, unknown>;
}

export interface CodeGraphFlowMembershipRecord {
  flowId: string;
  symbolId: string;
  depth: number;
}
