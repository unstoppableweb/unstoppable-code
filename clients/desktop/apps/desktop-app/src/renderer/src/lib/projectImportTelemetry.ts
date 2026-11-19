import {
  failClientOperation,
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type {
  AgentProviderAuthStatus,
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
  ExternalProjectImportResponse,
} from '@canopy/desktop-shared/types';
import type { ImportProjectsSource } from '@/stores/importProjectsModalStore';

/**
 * Project import telemetry (CAN-4635): the first-run page's visit
 * (`onboarding:first_run_import_view` / `_end`) and one `projects:import_end`
 * per submitted import request from either surface. Context is enums,
 * booleans and counts only: no names, paths, scan or workspace ids. Every
 * entry point is no-throw, so telemetry never changes import behavior.
 */

const VISIT_VIEW = 'canopy.first_run_import_view';
const VISIT_END = 'canopy.first_run_import';
const SUBMISSION = 'canopy.project_import';

export type ProviderConnection = 'connected' | 'not_connected' | 'unknown';

/** Unresolved, or a check that failed without an answer, is `unknown`. */
export function providerConnection(
  status: AgentProviderAuthStatus | null,
): ProviderConnection {
  if (status === null) return 'unknown';
  if (status.authenticated) return 'connected';
  return status.probeFailed === true ? 'unknown' : 'not_connected';
}

export interface ProviderConnections {
  readonly claude: ProviderConnection;
  readonly codex: ProviderConnection;
}

/**
 * The latest completed scan the surface shows. A failed rescan that leaves
 * an earlier result on screen (and importable) keeps that result; only a
 * surface with no successful scan reports `failed`.
 */
export type ImportScanState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'completed';
      readonly scan: ExternalProjectDiscoverResponse;
      /** What the surface offers to import from this scan. */
      readonly found: readonly ExternalProjectCandidate[];
    };

export const UNKNOWN_IMPORT_SCAN: ImportScanState = { kind: 'unknown' };

type Context = Record<string, string | number | boolean>;

function scanContext(state: ImportScanState): Context {
  if (state.kind !== 'completed')
    return { scan_outcome: state.kind === 'failed' ? 'failed' : 'unknown' };
  return {
    scan_outcome: state.found.length > 0 ? 'found' : 'empty',
    claude_data_detected: state.scan.providersDetected.claude === true,
    codex_data_detected: state.scan.providersDetected.codex === true,
  };
}

function foundCounts(state: ImportScanState): Context {
  if (state.kind !== 'completed') return {};
  return {
    found_count: state.found.length,
    found_claude_count: countProvider(state.found, 'claude'),
    found_codex_count: countProvider(state.found, 'codex'),
  };
}

function countProvider(
  candidates: readonly ExternalProjectCandidate[],
  provider: 'claude' | 'codex',
): number {
  return candidates.filter((c) => c.providers.includes(provider)).length;
}

function connectionContext(connections: ProviderConnections): Context {
  return {
    claude_connection: connections.claude,
    codex_connection: connections.codex,
  };
}

function randomKey(): string | undefined {
  try {
    return crypto.randomUUID();
  } catch {
    return undefined;
  }
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Telemetry must never change import behavior.
  }
}

export type ProjectImportOutcome =
  | 'imported'
  | 'partial'
  | 'none_imported'
  | 'request_failed';

export interface ProjectImportResultCounts {
  readonly outcome: ProjectImportOutcome;
  readonly selectedCount: number;
  readonly importedCount: number;
  readonly importedClaudeCount: number;
  readonly importedCodexCount: number;
  readonly failedCount: number;
  /**
   * `failedCount` split by a closed reason, from each result's status and
   * `retryable` flag only (never its message): skipped, failed but
   * retryable, failed for good, or a selection the response did not mention.
   */
  readonly skippedCount: number;
  readonly failedRetryableCount: number;
  readonly failedFinalCount: number;
  readonly unconfirmedCount: number;
  readonly chatsImportedCount: number;
}

/**
 * Derives a submission's counts from the import response's per-item
 * results. A project used with both providers counts in both provider
 * buckets but once in the totals; selections the response did not confirm
 * as imported count as failed. A thrown request is `request_failed` with no
 * confirmed imports, which is not proof the backend committed nothing.
 */
export function deriveProjectImportResult(
  selectedIds: readonly string[],
  candidates: readonly ExternalProjectCandidate[],
  response: ExternalProjectImportResponse | null,
): ProjectImportResultCounts {
  const selected = new Set(selectedIds);
  if (response === null)
    return {
      outcome: 'request_failed',
      selectedCount: selected.size,
      importedCount: 0,
      importedClaudeCount: 0,
      importedCodexCount: 0,
      failedCount: selected.size,
      skippedCount: 0,
      failedRetryableCount: 0,
      failedFinalCount: 0,
      unconfirmedCount: selected.size,
      chatsImportedCount: 0,
    };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const imported = new Set<string>();
  let claude = 0;
  let codex = 0;
  let chats = 0;
  for (const result of response.results) {
    if (result.status !== 'imported') continue;
    if (!selected.has(result.candidateId) || imported.has(result.candidateId))
      continue;
    imported.add(result.candidateId);
    const providers = byId.get(result.candidateId)?.providers ?? [];
    if (providers.includes('claude')) claude += 1;
    if (providers.includes('codex')) codex += 1;
    chats += result.chatsImported + result.chatsReadOnly;
  }
  const importedCount = imported.size;
  const failedCount = selected.size - importedCount;
  const notImported = new Map<string, ExternalProjectImportItemResult>();
  for (const result of response.results) {
    if (
      selected.has(result.candidateId) &&
      !imported.has(result.candidateId) &&
      !notImported.has(result.candidateId)
    )
      notImported.set(result.candidateId, result);
  }
  let skipped = 0;
  let failedRetryable = 0;
  let failedFinal = 0;
  for (const result of notImported.values()) {
    if (result.status === 'skipped') skipped += 1;
    else if (result.retryable) failedRetryable += 1;
    else failedFinal += 1;
  }
  return {
    outcome:
      importedCount === 0
        ? 'none_imported'
        : failedCount === 0
          ? 'imported'
          : 'partial',
    selectedCount: selected.size,
    importedCount,
    importedClaudeCount: claude,
    importedCodexCount: codex,
    failedCount,
    skippedCount: skipped,
    failedRetryableCount: failedRetryable,
    failedFinalCount: failedFinal,
    unconfirmedCount: failedCount - notImported.size,
    chatsImportedCount: chats,
  };
}

/** The modal's opening entry, normalized; other entries are omitted. */
export function projectImportModalEntry(
  source: ImportProjectsSource | undefined,
): 'invite' | 'settings' | 'app_advisor' | undefined {
  if (source === 'invite' || source === 'settings') return source;
  if (source === 'app-advisor') return 'app_advisor';
  return undefined;
}

export type ProjectImportSurface =
  | {
      readonly source: 'first_run';
      readonly connections: ProviderConnections;
    }
  | {
      readonly source: 'import_modal';
      readonly modalEntry?: ImportProjectsSource;
    };

export interface ProjectImportSubmissionSnapshot {
  readonly surface: ProjectImportSurface;
  readonly scan: ImportScanState;
  readonly selectedIds: readonly string[];
  readonly pickedFolder: boolean;
}

export interface ProjectImportSubmissionTracker {
  /** Records the response; returns its derived counts. */
  settle(response: ExternalProjectImportResponse): ProjectImportResultCounts;
  /** Records a thrown request; returns its derived counts. */
  fail(): ProjectImportResultCounts;
}

/**
 * Starts one `projects:import_end` lifecycle for a submitted request, with
 * its own operation key and duration. Scan, selection and connection
 * context are snapshotted now, so later selection changes do not leak into
 * the result. Only the first settle or fail emits.
 */
export function startProjectImportSubmission(
  snapshot: ProjectImportSubmissionSnapshot,
): ProjectImportSubmissionTracker {
  const operationKey = randomKey();
  const selectedIds = [...snapshot.selectedIds];
  const candidates =
    snapshot.scan.kind === 'completed' ? snapshot.scan.scan.candidates : [];
  const base: Context = {};
  safely(() => {
    if (operationKey === undefined) return;
    const entry =
      snapshot.surface.source === 'import_modal'
        ? projectImportModalEntry(snapshot.surface.modalEntry)
        : undefined;
    Object.assign(
      base,
      { source: snapshot.surface.source },
      entry ? { modal_entry: entry } : {},
      scanContext(snapshot.scan),
      foundCounts(snapshot.scan),
      snapshot.surface.source === 'first_run'
        ? connectionContext(snapshot.surface.connections)
        : {},
      { picked_folder: snapshot.pickedFolder },
    );
    startClientOperation(SUBMISSION, { operationKey });
  });
  let settled = false;
  const finish = (
    response: ExternalProjectImportResponse | null,
  ): ProjectImportResultCounts => {
    const counts = deriveProjectImportResult(selectedIds, candidates, response);
    if (settled) return counts;
    settled = true;
    safely(() => {
      if (operationKey === undefined) return;
      const context: Context = {
        ...base,
        outcome: counts.outcome,
        selected_count: counts.selectedCount,
        imported_count: counts.importedCount,
        imported_claude_count: counts.importedClaudeCount,
        imported_codex_count: counts.importedCodexCount,
        failed_count: counts.failedCount,
        skipped_count: counts.skippedCount,
        failed_retryable_count: counts.failedRetryableCount,
        failed_final_count: counts.failedFinalCount,
        unconfirmed_count: counts.unconfirmedCount,
        chats_imported_count: counts.chatsImportedCount,
      };
      // A partial import is neither a success nor a total failure: it fails
      // as `other`, so each of the three outcomes is separable downstream.
      if (counts.outcome === 'imported')
        succeedClientOperation(SUBMISSION, { operationKey, context });
      else
        failClientOperation(
          SUBMISSION,
          counts.outcome === 'partial' ? 'other' : 'error',
          { operationKey, context },
        );
    });
    return counts;
  };
  return {
    settle: (response): ProjectImportResultCounts => finish(response),
    fail: (): ProjectImportResultCounts => finish(null),
  };
}

export interface FirstRunImportVisit {
  /** Emits the view and starts completion timing; once per visit. */
  begin(connections: ProviderConnections): void;
  markPickedFolder(): void;
  /** The AI Credits account row was shown, in any of its states. */
  markCreditsOffered(): void;
  readonly pickedFolder: boolean;
  /** Folds a settled submission into the visit's totals. */
  recordSubmission(counts: ProjectImportResultCounts): void;
  /** Emits the completion once, on the visit's first `finish()`. */
  complete(scan: ImportScanState, connections: ProviderConnections): void;
}

/**
 * One logical first-run page visit. The page holds it for its mount, so
 * React effect replay reuses it and a real remount gets a fresh key. An
 * unmount without `complete` emits nothing.
 */
export function createFirstRunImportVisit(): FirstRunImportVisit {
  const operationKey = randomKey();
  let begun = false;
  let completed = false;
  let pickedFolder = false;
  let creditsOffered = false;
  let importedCount = 0;
  let submissionCount = 0;
  let failedSubmissionCount = 0;
  return {
    begin(connections): void {
      if (begun || operationKey === undefined) return;
      begun = true;
      safely(() => {
        const context = connectionContext(connections);
        startClientOperation(VISIT_VIEW, { context });
        succeedClientOperation(VISIT_VIEW, { context });
        startClientOperation(VISIT_END, { operationKey });
      });
    },
    markPickedFolder(): void {
      pickedFolder = true;
    },
    markCreditsOffered(): void {
      creditsOffered = true;
    },
    get pickedFolder(): boolean {
      return pickedFolder;
    },
    recordSubmission(counts): void {
      submissionCount += 1;
      importedCount += counts.importedCount;
      if (
        counts.outcome === 'none_imported' ||
        counts.outcome === 'request_failed'
      )
        failedSubmissionCount += 1;
    },
    complete(scan, connections): void {
      if (!begun || completed) return;
      completed = true;
      safely(() => {
        const scanned = scanContext(scan);
        const context: Context = {
          outcome:
            importedCount > 0
              ? 'imported'
              : scanned.scan_outcome === 'empty'
                ? 'continued_empty'
                : 'skipped',
          ...scanned,
          ...connectionContext(connections),
          ...(scan.kind === 'completed'
            ? { found_count: scan.found.length }
            : {}),
          credits_offered: creditsOffered,
          imported_count: importedCount,
          submission_count: submissionCount,
          failed_submission_count: failedSubmissionCount,
          picked_folder: pickedFolder,
        };
        succeedClientOperation(VISIT_END, { operationKey, context });
      });
    },
  };
}
