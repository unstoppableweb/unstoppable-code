import { promises as fs } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  CodeGraphCustomLanguageFingerprint,
  CodeGraphCustomLanguageDiagnostic,
  CodeGraphCustomLanguagesReport,
  CodeGraphLoadedCustomLanguage,
} from '../types/code-graph';
import {
  CODE_GRAPH_GRAMMARS,
  CODE_GRAPH_SOURCE_EXTENSIONS,
  type CodeGraphGrammarDefinition,
} from '../grammars/registry';
import type { CodeGraphParserRuntime } from '../parser/runtime';

// Custom language config (Phase 6 Task 8).
//
// A worktree may map extra file extensions to caller-supplied tree-sitter
// grammars via `<worktree>/.canopy/code-graph/languages.json`. `.canopy` here
// is the LITERAL directory name inside the worktree checkout (matching the
// repo's other `.canopy/`-style conventions) -- it is deliberately NOT
// brand-derived.
//
// Validation is warn-and-skip per entry with structured diagnostics; only the
// config file itself being unreadable/malformed is a config-level error (the
// one condition the CLI `validate-languages` command exits 1 for). Valid
// entries join the engine's effective grammar list and the scanner's
// extension corpus; extraction uses ONLY the generic tags path
// (definitions/references -- `inlineQuerySuffix` is always '', no Canopy
// supplemental queries for custom languages).
//
// Semi-trusted input honesty: a custom grammar wasm runs inside the exact
// same web-tree-sitter WASM sandbox as the bundled grammars, and parsed
// custom-language files go through the same per-file guards
// (CODE_GRAPH_MAX_FILE_BYTES oversized skip) as built-in languages. The size
// cap below bounds the wasm itself.

export const CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH =
  '.canopy/code-graph/languages.json';

export const CODE_GRAPH_CUSTOM_WASM_MAX_BYTES = 32 * 1024 * 1024;

export const CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES = 1024 * 1024;

export const CODE_GRAPH_CUSTOM_TAGS_MAX_BYTES = 8 * 1024 * 1024;

export const CODE_GRAPH_CUSTOM_LANGUAGES_MAX = 10;

export const CODE_GRAPH_CUSTOM_LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// Normalized-extension shape after lowercasing: leading dot, then at least
// one alphanumeric, then any of [a-z0-9._-]. Multi-dot extensions like
// `.foo.bar` are allowed (matching is endsWith, same as grammarForPath).
const CUSTOM_EXTENSION_PATTERN = /^\.[a-z0-9][a-z0-9._-]*$/;

// Extensions the non-code extractor corpus depends on
// (extract/extractor-registry.ts): markdown plus the manifest/workflow
// extractors' file shapes. The engine consults the effective GRAMMAR list
// BEFORE `nonCodeExtractorForPath`, so a custom entry claiming any of these
// would silently steal e.g. every `package.json` from the manifest extractor.
// Deliberately hardcoded (the registry's matchers are opaque predicates, not
// extension lists), but pinned against the registry by the drift-guard test
// in __tests__/custom-config.test.ts — adding/renaming a non-code extractor
// fails that test until this list is reconciled with the new corpus.
export const CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS: readonly string[] = [
  '.prisma',
  '.md',
  '.mdx',
  '.json',
  '.yml',
  '.yaml',
];

/** Absolute path of a worktree's custom language config file. */
export function customLanguagesConfigPath(worktreeRootPath: string): string {
  return path.join(
    worktreeRootPath,
    ...CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH.split('/'),
  );
}

const CUSTOM_LANGUAGE_FINGERPRINT_VERSION = 'code-graph-custom-inputs-v1';

export const CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT = createHash('sha256')
  .update(CUSTOM_LANGUAGE_FINGERPRINT_VERSION)
  .update('\0')
  .update('config:absent')
  .digest('hex');

function filesystemErrorMarker(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  return 'unreadable';
}

function normalizedConfigRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath);
}

export type CodeGraphCustomLanguageFileRead =
  | { kind: 'present'; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'unreadable'; marker: string };

interface CodeGraphCustomLanguageInputCapture {
  fingerprint: CodeGraphCustomLanguageFingerprint;
  canonicalConfigPath: string;
  configRead: CodeGraphCustomLanguageFileRead;
  fileReads: ReadonlyMap<string, CodeGraphCustomLanguageFileRead>;
}

export async function readBoundedCodeGraphCustomLanguageFile(
  filePath: string,
  expectedRealPath: string,
  maxBytes: number,
): Promise<CodeGraphCustomLanguageFileRead> {
  let fileInfo: Stats;
  try {
    fileInfo = await fs.lstat(filePath);
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return { kind: 'absent' };
    }
    return { kind: 'unreadable', marker: filesystemErrorMarker(error) };
  }
  if (fileInfo.isSymbolicLink()) {
    return { kind: 'unreadable', marker: 'symlink' };
  }
  if (!fileInfo.isFile()) {
    return { kind: 'unreadable', marker: 'not-regular-file' };
  }
  if (fileInfo.size > maxBytes) {
    return { kind: 'unreadable', marker: 'oversize' };
  }

  let verifiedRealPath: string;
  try {
    verifiedRealPath = await fs.realpath(filePath);
    if (path.resolve(verifiedRealPath) !== path.resolve(expectedRealPath)) {
      return { kind: 'unreadable', marker: 'symlink' };
    }
  } catch (error) {
    return { kind: 'unreadable', marker: filesystemErrorMarker(error) };
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      verifiedRealPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) {
      return { kind: 'unreadable', marker: 'not-regular-file' };
    }
    if (openedInfo.size > maxBytes) {
      return { kind: 'unreadable', marker: 'oversize' };
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return {
          kind: 'present',
          bytes: Buffer.concat(chunks, totalBytes),
        };
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return { kind: 'unreadable', marker: 'oversize' };
  } catch (error) {
    return { kind: 'unreadable', marker: filesystemErrorMarker(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Hashes the exact custom-language inputs that can affect extracted facts.
 * Invalid config entries contribute through the raw config bytes but their
 * untrusted paths are never followed; only statically valid entries have
 * referenced wasm/tag files read.
 */
async function captureCustomLanguageInputs(
  worktreeRootPath: string,
): Promise<CodeGraphCustomLanguageInputCapture> {
  const configPath = customLanguagesConfigPath(worktreeRootPath);
  const hash = createHash('sha256');
  hash.update(CUSTOM_LANGUAGE_FINGERPRINT_VERSION);
  hash.update('\0');

  const realWorktreeRoot = await fs
    .realpath(worktreeRootPath)
    .catch(() => path.resolve(worktreeRootPath));
  const canonicalConfigPath = customLanguagesConfigPath(realWorktreeRoot);
  const configRead = await readBoundedCodeGraphCustomLanguageFile(
    configPath,
    canonicalConfigPath,
    CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
  );
  if (configRead.kind === 'absent') {
    return {
      fingerprint: {
        value: CODE_GRAPH_NO_CUSTOM_LANGUAGES_FINGERPRINT,
        configPresent: false,
      },
      canonicalConfigPath,
      configRead,
      fileReads: new Map(),
    };
  }
  if (configRead.kind === 'unreadable') {
    hash.update('config:unreadable');
    hash.update('\0');
    hash.update(configRead.marker);
    return {
      fingerprint: { value: hash.digest('hex'), configPresent: true },
      canonicalConfigPath,
      configRead,
      fileReads: new Map(),
    };
  }
  const rawConfig = configRead.bytes;

  hash.update('config:present\0');
  hash.update(rawConfig);
  const parsed = parseCustomLanguagesConfig(rawConfig.toString('utf8'));
  if (!parsed.ok) {
    hash.update('\0config:statically-invalid');
    return {
      fingerprint: { value: hash.digest('hex'), configPresent: true },
      canonicalConfigPath,
      configRead,
      fileReads: new Map(),
    };
  }

  const { entries } = validateCustomLanguageEntries(parsed.rawEntries);
  const references = entries
    .flatMap((entry) => [
      {
        entryId: entry.id,
        kind: 'wasm' as const,
        relativePath: normalizedConfigRelativePath(entry.wasmFile),
      },
      ...entry.tagsFiles.map((tagsFile) => ({
        entryId: entry.id,
        kind: 'tags' as const,
        relativePath: normalizedConfigRelativePath(tagsFile),
      })),
    ])
    .sort((a, b) =>
      `${a.entryId}\0${a.kind}\0${a.relativePath}`.localeCompare(
        `${b.entryId}\0${b.kind}\0${b.relativePath}`,
      ),
    );
  const configDir = path.dirname(configPath);
  const realConfigDir = path.dirname(await fs.realpath(configPath));
  const fileReads = new Map<string, Promise<CodeGraphCustomLanguageFileRead>>();
  const capturedReads = new Map<string, CodeGraphCustomLanguageFileRead>();
  for (const reference of references) {
    hash.update('\0entry:');
    hash.update(reference.entryId);
    hash.update('\0kind:');
    hash.update(reference.kind);
    hash.update('\0path:');
    hash.update(reference.relativePath);
    const maxBytes =
      reference.kind === 'wasm'
        ? CODE_GRAPH_CUSTOM_WASM_MAX_BYTES
        : CODE_GRAPH_CUSTOM_TAGS_MAX_BYTES;
    const readKey = `${reference.kind}\0${reference.relativePath}`;
    let pendingRead = fileReads.get(readKey);
    if (pendingRead === undefined) {
      pendingRead = readBoundedCodeGraphCustomLanguageFile(
        path.resolve(configDir, reference.relativePath),
        path.resolve(realConfigDir, reference.relativePath),
        maxBytes,
      );
      fileReads.set(readKey, pendingRead);
    }
    const fileRead = await pendingRead;
    capturedReads.set(readKey, fileRead);
    if (fileRead.kind === 'present') {
      hash.update('\0file:present\0');
      hash.update(fileRead.bytes);
    } else {
      hash.update('\0file:unreadable\0');
      hash.update(fileRead.kind === 'absent' ? 'absent' : fileRead.marker);
    }
  }
  return {
    fingerprint: { value: hash.digest('hex'), configPresent: true },
    canonicalConfigPath,
    configRead,
    fileReads: capturedReads,
  };
}

export async function fingerprintCustomLanguageInputs(
  worktreeRootPath: string,
): Promise<CodeGraphCustomLanguageFingerprint> {
  return (await captureCustomLanguageInputs(worktreeRootPath)).fingerprint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Config-level parsing ----------------------------------------------------

export interface CodeGraphCustomConfigEntryCandidate {
  index: number;
  value: unknown;
}

export type CodeGraphCustomConfigParseResult =
  | { ok: true; rawEntries: CodeGraphCustomConfigEntryCandidate[] }
  | { ok: false; error: string };

/**
 * Parses the raw config text into per-entry candidates. Only problems with
 * the config file ITSELF (invalid JSON, non-object root, wrong `version`,
 * non-array `languages`) are config-level failures; every per-entry problem
 * is handled downstream as a warn-and-skip diagnostic.
 */
export function parseCustomLanguagesConfig(
  rawText: string,
): CodeGraphCustomConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${errorMessage(error)}` };
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { ok: false, error: 'config root must be a JSON object' };
  }
  if (parsed.version !== 1) {
    return {
      ok: false,
      error: `unsupported config version ${JSON.stringify(parsed.version)} (expected 1)`,
    };
  }
  if (!Array.isArray(parsed.languages)) {
    return { ok: false, error: '"languages" must be an array' };
  }
  // Explicit unknown[] annotation: Array.isArray narrows to any[], which the
  // no-unsafe-assignment rule (correctly) refuses to let flow onward.
  const languages: unknown[] = parsed.languages;
  return {
    ok: true,
    rawEntries: languages.map((value, index) => ({ index, value })),
  };
}

// --- Per-entry static validation (pure -- no filesystem) ---------------------

export interface CodeGraphValidatedCustomEntry {
  index: number;
  id: string;
  /** Normalized (lowercased) extensions, each with a leading dot. */
  extensions: string[];
  /** Config-dir-relative, traversal-safe as written in the config. */
  wasmFile: string;
  tagsFiles: string[];
}

export interface CodeGraphCustomStaticValidationResult {
  entries: CodeGraphValidatedCustomEntry[];
  diagnostics: CodeGraphCustomLanguageDiagnostic[];
}

// Mirrors snapshot/import.ts's `requireSafeRelativePath` hardening: reject
// empty, absolute (leading `/` or Windows drive prefix), any backslash, and
// any `..` segment -- these paths are joined under the config's own
// directory and must never resolve outside it.
function isSafeConfigRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split('/').includes('..')
  );
}

// Two extensions shadow each other exactly when one is a string-suffix of the
// other: extension matching is `path.endsWith(ext)` (see grammarForPath), so
// e.g. a custom `.on` claims every `x.json`, and a custom `.notes.md` file
// set is a subset of what the markdown extractor matches.
function extensionsShadow(a: string, b: string): boolean {
  return a.endsWith(b) || b.endsWith(a);
}

function findShadowedProtectedExtension(extension: string): string | undefined {
  const protectedExtensions = [
    ...CODE_GRAPH_SOURCE_EXTENSIONS,
    ...CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS,
  ];
  return protectedExtensions.find((candidate) =>
    extensionsShadow(extension, candidate),
  );
}

/**
 * Pure static validation for every config entry: shape, cap, id, extension
 * normalization + shadow protection, and wasm/tags traversal safety. Returns
 * the surviving entries in config order plus one diagnostic per skipped
 * entry. Filesystem existence/size and wasm/query loading are separate,
 * later stages (see {@link resolveCustomLanguages}) so these failure classes
 * stay unit-testable without touching disk or the WASM runtime.
 */
export function validateCustomLanguageEntries(
  rawEntries: readonly CodeGraphCustomConfigEntryCandidate[],
): CodeGraphCustomStaticValidationResult {
  const entries: CodeGraphValidatedCustomEntry[] = [];
  const diagnostics: CodeGraphCustomLanguageDiagnostic[] = [];
  const builtinIds = new Set(CODE_GRAPH_GRAMMARS.map((grammar) => grammar.id));
  const seenIds = new Set<string>();

  const skip = (
    index: number,
    entryId: string | null,
    message: string,
  ): void => {
    diagnostics.push({ entryId, index, message });
  };

  for (const { index, value } of rawEntries) {
    if (index >= CODE_GRAPH_CUSTOM_LANGUAGES_MAX) {
      skip(
        index,
        isRecord(value) && typeof value.id === 'string' ? value.id : null,
        `exceeds the ${CODE_GRAPH_CUSTOM_LANGUAGES_MAX}-language cap`,
      );
      continue;
    }
    if (!isRecord(value) || Array.isArray(value)) {
      skip(index, null, 'entry must be a JSON object');
      continue;
    }

    // id
    const rawId = value.id;
    if (typeof rawId !== 'string') {
      skip(index, null, '"id" must be a string');
      continue;
    }
    if (!CODE_GRAPH_CUSTOM_LANGUAGE_ID_PATTERN.test(rawId)) {
      skip(
        index,
        null,
        `"id" ${JSON.stringify(rawId)} must match ${String(CODE_GRAPH_CUSTOM_LANGUAGE_ID_PATTERN)}`,
      );
      continue;
    }
    if (builtinIds.has(rawId)) {
      skip(
        index,
        rawId,
        `"id" ${JSON.stringify(rawId)} collides with a built-in grammar id`,
      );
      continue;
    }
    if (seenIds.has(rawId)) {
      skip(
        index,
        rawId,
        `"id" ${JSON.stringify(rawId)} duplicates an earlier custom entry`,
      );
      continue;
    }

    // extensions
    const rawExtensions = value.extensions;
    if (!Array.isArray(rawExtensions) || rawExtensions.length === 0) {
      skip(index, rawId, '"extensions" must be a non-empty array');
      continue;
    }
    const extensions: string[] = [];
    let extensionProblem: string | null = null;
    for (const rawExtension of rawExtensions) {
      if (typeof rawExtension !== 'string') {
        extensionProblem = 'every extension must be a string';
        break;
      }
      const normalized = rawExtension.toLowerCase();
      if (!CUSTOM_EXTENSION_PATTERN.test(normalized)) {
        extensionProblem = `extension ${JSON.stringify(rawExtension)} must match ${String(CUSTOM_EXTENSION_PATTERN)} (leading dot required)`;
        break;
      }
      if (extensions.includes(normalized)) {
        extensionProblem = `duplicate extension ${JSON.stringify(normalized)}`;
        break;
      }
      const shadowedProtected = findShadowedProtectedExtension(normalized);
      if (shadowedProtected !== undefined) {
        extensionProblem =
          `extension ${JSON.stringify(normalized)} shadows the protected ` +
          `extension ${JSON.stringify(shadowedProtected)} (built-in grammar or non-code corpus)`;
        break;
      }
      const shadowingEntry = entries.find((accepted) =>
        accepted.extensions.some((acceptedExtension) =>
          extensionsShadow(normalized, acceptedExtension),
        ),
      );
      if (shadowingEntry !== undefined) {
        extensionProblem =
          `extension ${JSON.stringify(normalized)} shadows custom entry ` +
          `"${shadowingEntry.id}"`;
        break;
      }
      extensions.push(normalized);
    }
    if (extensionProblem !== null) {
      skip(index, rawId, extensionProblem);
      continue;
    }

    // wasmFile / tagsFiles (traversal-hardened, config-dir-relative)
    const rawWasmFile = value.wasmFile;
    if (typeof rawWasmFile !== 'string') {
      skip(index, rawId, '"wasmFile" must be a string');
      continue;
    }
    if (!isSafeConfigRelativePath(rawWasmFile)) {
      skip(
        index,
        rawId,
        `"wasmFile" ${JSON.stringify(rawWasmFile)} must be a config-relative path ` +
          'without ".." segments, backslashes, or an absolute prefix',
      );
      continue;
    }
    const rawTagsFiles = value.tagsFiles;
    if (!Array.isArray(rawTagsFiles) || rawTagsFiles.length === 0) {
      skip(index, rawId, '"tagsFiles" must be a non-empty array');
      continue;
    }
    const tagsFiles: string[] = [];
    let tagsProblem: string | null = null;
    for (const rawTagsFile of rawTagsFiles) {
      if (typeof rawTagsFile !== 'string') {
        tagsProblem = 'every tags file must be a string';
        break;
      }
      if (!isSafeConfigRelativePath(rawTagsFile)) {
        tagsProblem =
          `tags file ${JSON.stringify(rawTagsFile)} must be a config-relative path ` +
          'without ".." segments, backslashes, or an absolute prefix';
        break;
      }
      tagsFiles.push(rawTagsFile);
    }
    if (tagsProblem !== null) {
      skip(index, rawId, tagsProblem);
      continue;
    }

    seenIds.add(rawId);
    entries.push({
      index,
      id: rawId,
      extensions,
      wasmFile: rawWasmFile,
      tagsFiles,
    });
  }

  return { entries, diagnostics };
}

// --- Filesystem + wasm/query resolution --------------------------------------

export type CodeGraphCustomLanguagesOutcome =
  | { kind: 'absent'; fingerprint: CodeGraphCustomLanguageFingerprint }
  | {
      kind: 'config-error';
      configPath: string;
      error: string;
      fingerprint: CodeGraphCustomLanguageFingerprint;
    }
  | {
      kind: 'resolved';
      report: CodeGraphCustomLanguagesReport;
      fingerprint: CodeGraphCustomLanguageFingerprint;
      /**
       * One definition per successfully loaded entry, in config order, with
       * `wasmFile`/`tagsFiles` resolved to ABSOLUTE paths (the contract
       * {@link CodeGraphParserRuntime.getCustomGrammar} requires) and
       * `inlineQuerySuffix` always '' (no Canopy supplemental queries for
       * custom languages).
       */
      grammars: CodeGraphGrammarDefinition[];
    };

/**
 * Reads and fully validates a worktree's custom language config, loading each
 * surviving entry's grammar through `runtime.getCustomGrammar` (which caches
 * by absolute paths plus asset bytes, so later extraction reuses the loaded
 * instance while in-place asset changes cannot retain stale grammar state).
 *
 * The absent check doubles as the per-build zero-cost fastpath: when no
 * config file exists this is a single failed bounded-read lookup and nothing
 * else. Config and asset reads share the fingerprint path's no-follow and
 * size limits so the parser never consumes bytes the fingerprint rejected.
 */
export async function resolveCustomLanguages(input: {
  configPath: string;
  runtime: CodeGraphParserRuntime;
}): Promise<CodeGraphCustomLanguagesOutcome> {
  const worktreeRootPath = path.resolve(
    path.dirname(input.configPath),
    '..',
    '..',
  );
  const capture = await captureCustomLanguageInputs(worktreeRootPath);
  const { configRead } = capture;
  if (configRead.kind === 'absent') {
    return { kind: 'absent', fingerprint: capture.fingerprint };
  }
  if (configRead.kind === 'unreadable') {
    return {
      kind: 'config-error',
      configPath: input.configPath,
      error: `config file is unreadable: ${configRead.marker}`,
      fingerprint: capture.fingerprint,
    };
  }

  const rawText = configRead.bytes.toString('utf8');
  const parsed = parseCustomLanguagesConfig(rawText);
  if (!parsed.ok) {
    return {
      kind: 'config-error',
      configPath: input.configPath,
      error: parsed.error,
      fingerprint: capture.fingerprint,
    };
  }

  // Reuse the path checked during capture so aliases produce identical grammar
  // metadata and diagnostics without another filesystem read.
  const configDir = path.dirname(capture.canonicalConfigPath);
  const { entries, diagnostics } = validateCustomLanguageEntries(
    parsed.rawEntries,
  );
  const loaded: CodeGraphLoadedCustomLanguage[] = [];
  const grammars: CodeGraphGrammarDefinition[] = [];

  for (const entry of entries) {
    const wasmPath = path.resolve(configDir, entry.wasmFile);
    const wasmRead = capture.fileReads.get(
      `wasm\0${normalizedConfigRelativePath(entry.wasmFile)}`,
    );
    if (wasmRead === undefined) {
      throw new Error(`Missing captured wasm input for ${entry.wasmFile}.`);
    }
    if (wasmRead.kind !== 'present') {
      diagnostics.push({
        entryId: entry.id,
        index: entry.index,
        message:
          wasmRead.kind === 'absent'
            ? `wasm file not found: ${entry.wasmFile}`
            : wasmRead.marker === 'oversize'
              ? `wasm file ${entry.wasmFile} is over the ${CODE_GRAPH_CUSTOM_WASM_MAX_BYTES / (1024 * 1024)} MiB (32 MiB) cap`
              : `wasm file ${entry.wasmFile} is unreadable: ${wasmRead.marker}`,
      });
      continue;
    }
    const tagsPaths: string[] = [];
    const tagsSources: string[] = [];
    let tagsProblem: string | null = null;
    for (const tagsFile of entry.tagsFiles) {
      const tagsPath = path.resolve(configDir, tagsFile);
      const tagsRead = capture.fileReads.get(
        `tags\0${normalizedConfigRelativePath(tagsFile)}`,
      );
      if (tagsRead === undefined) {
        throw new Error(`Missing captured tags input for ${tagsFile}.`);
      }
      if (tagsRead.kind !== 'present') {
        tagsProblem =
          tagsRead.kind === 'absent'
            ? `tags file not found: ${tagsFile}`
            : tagsRead.marker === 'oversize'
              ? `tags file ${tagsFile} is over the ${CODE_GRAPH_CUSTOM_TAGS_MAX_BYTES / (1024 * 1024)} MiB cap`
              : `tags file ${tagsFile} is unreadable: ${tagsRead.marker}`;
        break;
      }
      tagsPaths.push(tagsPath);
      tagsSources.push(tagsRead.bytes.toString('utf8'));
    }
    if (tagsProblem !== null) {
      diagnostics.push({
        entryId: entry.id,
        index: entry.index,
        message: tagsProblem,
      });
      continue;
    }

    const definition: CodeGraphGrammarDefinition = {
      id: entry.id,
      extensions: entry.extensions,
      wasmFile: wasmPath,
      tagsFiles: tagsPaths,
      inlineQuerySuffix: '',
    };
    try {
      const grammar = await input.runtime.getCustomGrammar(definition, {
        wasmBytes: wasmRead.bytes,
        tagsSources,
      });
      loaded.push({
        index: entry.index,
        id: entry.id,
        extensions: entry.extensions,
        abiVersion: grammar.abiVersion,
      });
      grammars.push(definition);
    } catch (error) {
      diagnostics.push({
        entryId: entry.id,
        index: entry.index,
        message: errorMessage(error),
      });
    }
  }

  diagnostics.sort((a, b) => a.index - b.index);
  return {
    kind: 'resolved',
    report: { configPath: input.configPath, loaded, diagnostics },
    grammars,
    fingerprint: capture.fingerprint,
  };
}

// --- Persisted-report round trip ----------------------------------------------

function parseDiagnostic(
  value: unknown,
): CodeGraphCustomLanguageDiagnostic | null {
  if (!isRecord(value)) {
    return null;
  }
  const { entryId, index, message } = value;
  if (
    (entryId !== null && typeof entryId !== 'string') ||
    typeof index !== 'number' ||
    typeof message !== 'string'
  ) {
    return null;
  }
  return {
    entryId: typeof entryId === 'string' ? entryId : null,
    index,
    message,
  };
}

function parseLoadedLanguage(
  value: unknown,
): CodeGraphLoadedCustomLanguage | null {
  if (!isRecord(value)) {
    return null;
  }
  const { index, id, extensions, abiVersion } = value;
  if (
    typeof index !== 'number' ||
    typeof id !== 'string' ||
    typeof abiVersion !== 'number' ||
    !Array.isArray(extensions) ||
    !extensions.every((extension) => typeof extension === 'string')
  ) {
    return null;
  }
  const stringExtensions: string[] = [];
  for (const extension of extensions) {
    if (typeof extension === 'string') {
      stringExtensions.push(extension);
    }
  }
  return { index, id, extensions: stringExtensions, abiVersion };
}

/**
 * Narrows a persisted graph-metadata JSON string back into a
 * {@link CodeGraphCustomLanguagesReport}. Returns null for anything that
 * does not round-trip cleanly (corrupt/legacy metadata degrades to "no
 * report" instead of throwing out of `getStatus`).
 */
export function parseCustomLanguagesReport(
  raw: string,
): CodeGraphCustomLanguagesReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.configPath !== 'string') {
    return null;
  }
  if (!Array.isArray(parsed.loaded) || !Array.isArray(parsed.diagnostics)) {
    return null;
  }
  const loaded: CodeGraphLoadedCustomLanguage[] = [];
  for (const value of parsed.loaded) {
    const entry = parseLoadedLanguage(value);
    if (entry === null) {
      return null;
    }
    loaded.push(entry);
  }
  const diagnostics: CodeGraphCustomLanguageDiagnostic[] = [];
  for (const value of parsed.diagnostics) {
    const diagnostic = parseDiagnostic(value);
    if (diagnostic === null) {
      return null;
    }
    diagnostics.push(diagnostic);
  }
  return { configPath: parsed.configPath, loaded, diagnostics };
}
