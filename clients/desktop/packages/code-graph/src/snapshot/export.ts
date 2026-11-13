import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION,
  type CodeGraphSnapshotEdge,
  type CodeGraphSnapshotEnvelope,
  type CodeGraphSnapshotFile,
  type CodeGraphSnapshotGrammar,
  type CodeGraphSnapshotSymbol,
} from '../types/code-graph-tools';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
} from '../types/code-graph';
import { getDefaultCodeGraphResourcesDir } from '../resources';
import { fileRowId, symbolRowId } from '../ids';
import { isRecord } from '../store/database';
import type {
  CodeGraphStore,
  CodeGraphSymbolSummary,
} from '../store/graph-store';

/**
 * Thrown by {@link exportCodeGraphSnapshotToFile} when the destination file
 * already exists and the new snapshot's symbol count is less than half the
 * existing snapshot's — a "refuse-to-shrink" guard against accidentally
 * overwriting a good committed snapshot with one built from a half-broken or
 * partially-scoped graph. Pass `force: true` to override.
 */
export class CodeGraphSnapshotShrinkError extends Error {
  public constructor(
    public readonly previousSymbolCount: number,
    public readonly nextSymbolCount: number,
    outPath: string,
  ) {
    super(
      `Refusing to overwrite ${outPath}: the new snapshot has ` +
        `${nextSymbolCount} symbol(s), down from ${previousSymbolCount} — ` +
        'more than a 50% shrink. Pass force: true to override.',
    );
    this.name = 'CodeGraphSnapshotShrinkError';
  }
}

// Duck-typed rather than `instanceof Error` — under Jest's per-test-file VM
// context, an error thrown by a native Node API (fs/promises here) can carry
// a DIFFERENT realm's `Error` prototype than the one this module's `Error`
// global resolves to, so `instanceof Error` unreliably returns `false` for a
// perfectly real `NodeJS.ErrnoException` in tests even though it is one.
function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Reads the bundled code-graph resources manifest's `grammars` array. Shared
 * by export (records what produced the snapshot) and import
 * (`snapshot/import.ts`'s grammar-mismatch warnings compare against this SAME
 * local manifest).
 */
export async function readBundledGrammarManifest(): Promise<
  CodeGraphSnapshotGrammar[]
> {
  const manifestPath = path.join(
    getDefaultCodeGraphResourcesDir(),
    'manifest.json',
  );
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.grammars)) {
    throw new Error(
      `Malformed code-graph resources manifest at ${manifestPath}`,
    );
  }
  return parsed.grammars.map((entry): CodeGraphSnapshotGrammar => {
    if (
      !isRecord(entry) ||
      typeof entry.package !== 'string' ||
      typeof entry.version !== 'string'
    ) {
      throw new Error(
        'Malformed grammar entry in code-graph resources manifest',
      );
    }
    const grammar: CodeGraphSnapshotGrammar = {
      package: entry.package,
      version: entry.version,
    };
    if (typeof entry.grammar === 'string') {
      grammar.grammar = entry.grammar;
    }
    if (typeof entry.built === 'boolean') {
      grammar.built = entry.built;
    }
    return grammar;
  });
}

function toSnapshotFile(file: CodeGraphFileRecord): CodeGraphSnapshotFile {
  return {
    relativePath: file.relativePath,
    language: file.language,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    mtimeNs: file.mtimeNs,
    lineCount: file.lineCount,
    grammarId: file.grammarId,
    grammarAbi: file.grammarAbi,
    parseStatus: file.parseStatus,
    hasErrors: file.hasErrors,
  };
}

function toSnapshotSymbol(
  symbol: CodeGraphSymbolSummary,
): CodeGraphSnapshotSymbol {
  return {
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature: symbol.signature,
    filePath: symbol.filePath,
  };
}

// Translates an operational-database symbol id (a hash of repoId+qualifiedName
// — see ids.ts) back to its portable qualifiedName using a map built from
// THIS SAME export's own symbol listing, so the snapshot never has to ship
// internal hash ids. Only `null` is a legitimate "no symbol" value; an edge
// carrying a non-null id this repo's own symbol listing cannot explain would
// mean the graph itself is inconsistent, so this throws rather than silently
// downgrading to `null` (which already has the distinct, real meaning
// "no bound symbol").
function resolveMappedSymbol(
  id: string | null,
  map: ReadonlyMap<string, string>,
  context: string,
): string | null {
  if (id === null) {
    return null;
  }
  const qualifiedName = map.get(id);
  if (qualifiedName === undefined) {
    throw new Error(
      `Snapshot export: ${context} references an unknown symbol id.`,
    );
  }
  return qualifiedName;
}

// Content-based comparator, NOT the operational database's internal `id`
// ordering: `store.listEdges` happens to return rows `ORDER BY e.id`, but an
// edge's id is a hash that depends on the (sourceId, target) convention the
// ORIGINAL extractor used for that edge kind (see extract/*.ts) — an edge
// reconstructed by `snapshot/import.ts` re-hashes with one generic formula
// instead of replicating every kind's exact original convention (documented
// there), so relying on id-order would make "export -> import -> export"
// silently reorder edges even though nothing about the graph's CONTENT
// changed. Sorting on the edge's own portable fields keeps ordering stable
// across that round trip.
function compareSnapshotEdges(
  a: CodeGraphSnapshotEdge,
  b: CodeGraphSnapshotEdge,
): number {
  return (
    a.sourceFilePath.localeCompare(b.sourceFilePath) ||
    a.kind.localeCompare(b.kind) ||
    (a.line ?? -1) - (b.line ?? -1) ||
    (a.sourceQualifiedName ?? '').localeCompare(b.sourceQualifiedName ?? '') ||
    (a.targetQualifiedName ?? '').localeCompare(b.targetQualifiedName ?? '') ||
    (a.targetRef ?? '').localeCompare(b.targetRef ?? '') ||
    (typeof a.evidence.offset === 'number' ? a.evidence.offset : -1) -
      (typeof b.evidence.offset === 'number' ? b.evidence.offset : -1)
  );
}

function toSnapshotEdge(
  edge: CodeGraphEdgeRecord,
  maps: {
    fileIdToRelativePath: ReadonlyMap<string, string>;
    symbolIdToQualifiedName: ReadonlyMap<string, string>;
  },
): CodeGraphSnapshotEdge {
  const sourceFilePath = maps.fileIdToRelativePath.get(edge.sourceFileId);
  if (sourceFilePath === undefined) {
    throw new Error('Snapshot export: edge references an unknown source file.');
  }
  return {
    kind: edge.kind,
    sourceFilePath,
    sourceQualifiedName: resolveMappedSymbol(
      edge.sourceSymbolId,
      maps.symbolIdToQualifiedName,
      'edge source',
    ),
    targetQualifiedName: resolveMappedSymbol(
      edge.targetSymbolId,
      maps.symbolIdToQualifiedName,
      'edge target',
    ),
    targetRef: edge.targetRef,
    line: edge.line,
    confidenceTier: edge.confidenceTier,
    confidenceScore: edge.confidenceScore,
    resolverId: edge.resolverId,
    evidence: edge.evidence,
  };
}

/**
 * Builds the deterministic snapshot envelope + its serialized JSON for ONE
 * repository, with no filesystem side effects beyond reading the LOCAL
 * bundled grammar manifest (never the destination snapshot file — see
 * {@link exportCodeGraphSnapshotToFile} for the file-writing/refuse-to-shrink
 * wrapper). Kept side-effect-free on the destination so tests can assert
 * determinism (same inputs + `generatedAt` -> byte-identical `json`) without
 * touching disk beyond the read-only manifest lookup.
 *
 * Stable ordering: `store.listFiles`/`listSymbols` already return rows
 * ordered by `relative_path`/`qualified_name` respectively, so those two
 * arrays need no additional sort. Edges are explicitly re-sorted by
 * {@link compareSnapshotEdges} on their own portable content rather than
 * trusting `store.listEdges`'s `ORDER BY id` — see that comparator's doc
 * comment for why an id-based order is not stable across import/re-export.
 *
 * Derived analyses (schema v2's `communities`/`community_memberships`/
 * `flows`/`flow_memberships` tables — see store/migrations.ts) are
 * DELIBERATELY EXCLUDED from this envelope, on both sides of the snapshot
 * contract: this function only ever reads `listFiles`/`listSymbols`/
 * `listEdges`, never `CodeGraphStore`'s derived-analysis accessors, and
 * `CodeGraphSnapshotEnvelope` (types/code-graph-tools.ts) has no
 * communities/flows fields for `snapshot/import.ts` to populate either.
 * Community/flow data is repo-local computed analysis, not portable graph
 * fact data, and it never participates in the refuse-to-shrink guard below
 * (`exportCodeGraphSnapshotToFile`), which only ever compares
 * `symbols.length`.
 */
export async function buildCodeGraphSnapshot(input: {
  store: CodeGraphStore;
  repoId: string;
  generatedAt: string;
}): Promise<{ envelope: CodeGraphSnapshotEnvelope; json: string }> {
  const repository = input.store
    .listRepositories()
    .find((candidate) => candidate.repoId === input.repoId);
  if (repository === undefined) {
    throw new Error(
      `No repository "${input.repoId}" found in this code graph.`,
    );
  }

  const files = input.store.listFiles(input.repoId);
  const symbols = input.store.listSymbols(input.repoId);
  const edges = input.store.listEdges({ repoId: input.repoId });

  const fileIdToRelativePath = new Map<string, string>();
  for (const file of files) {
    fileIdToRelativePath.set(
      fileRowId(input.repoId, file.relativePath),
      file.relativePath,
    );
  }
  const symbolIdToQualifiedName = new Map<string, string>();
  for (const symbol of symbols) {
    symbolIdToQualifiedName.set(
      symbolRowId(input.repoId, symbol.qualifiedName),
      symbol.qualifiedName,
    );
  }

  const envelope: CodeGraphSnapshotEnvelope = {
    schemaVersion: CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    repository: { repoId: repository.repoId, gitHead: repository.gitHead },
    grammars: await readBundledGrammarManifest(),
    files: files.map(toSnapshotFile),
    symbols: symbols.map(toSnapshotSymbol),
    edges: edges
      .map((edge) =>
        toSnapshotEdge(edge, { fileIdToRelativePath, symbolIdToQualifiedName }),
      )
      .sort(compareSnapshotEdges),
  };
  return { envelope, json: serializeCodeGraphSnapshot(envelope) };
}

/**
 * A snapshot's file text: 2-space indent + trailing newline, per the
 * source-controlled-snapshot contract
 * (docs/planning/2026-07-07-code-graph-asts/README.md) — a trailing newline
 * keeps the committed file POSIX-text-file-clean.
 */
export function serializeCodeGraphSnapshot(snapshot: unknown): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function readPreviousSnapshotSymbolCount(
  outPath: string,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(outPath, 'utf8');
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Not valid JSON — nothing sensible to compare against.
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.symbols)) {
    return null;
  }
  return parsed.symbols.length;
}

/**
 * Writes a serialized snapshot to `outPath`, enforcing the refuse-to-shrink
 * guard first: if a snapshot already exists at `outPath` with N symbols and
 * the new snapshot has fewer than N/2, this throws
 * {@link CodeGraphSnapshotShrinkError} unless `force: true` is passed. A
 * destination that does not exist yet, or is not a valid snapshot, is never
 * protected (nothing to refuse-to-shrink FROM).
 */
export async function writeCodeGraphSnapshotFile(input: {
  json: string;
  symbolCount: number;
  outPath: string;
  force?: boolean;
}): Promise<void> {
  const previousSymbolCount = await readPreviousSnapshotSymbolCount(
    input.outPath,
  );
  if (
    previousSymbolCount !== null &&
    previousSymbolCount > 0 &&
    !(input.force ?? false) &&
    input.symbolCount < previousSymbolCount * 0.5
  ) {
    throw new CodeGraphSnapshotShrinkError(
      previousSymbolCount,
      input.symbolCount,
      input.outPath,
    );
  }
  await fs.mkdir(path.dirname(input.outPath), { recursive: true });
  await fs.writeFile(input.outPath, input.json, 'utf8');
}

/**
 * Builds a snapshot (via {@link buildCodeGraphSnapshot}) and writes it to
 * `outPath` through {@link writeCodeGraphSnapshotFile}.
 */
export async function exportCodeGraphSnapshotToFile(input: {
  store: CodeGraphStore;
  repoId: string;
  generatedAt: string;
  outPath: string;
  force?: boolean;
}): Promise<{ envelope: CodeGraphSnapshotEnvelope; json: string }> {
  const built = await buildCodeGraphSnapshot(input);
  await writeCodeGraphSnapshotFile({
    json: built.json,
    symbolCount: built.envelope.symbols.length,
    outPath: input.outPath,
    ...(input.force === undefined ? {} : { force: input.force }),
  });
  return built;
}
