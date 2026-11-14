import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import type {
  ExternalProjectCandidate,
  ExternalProjectDetectedPlugin,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
  ExternalProjectImportProgressEvent,
  ExternalProjectImportResponse,
  ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import {
  Badge,
  Stack,
  Button,
  Checkbox,
  ChoiceField,
  Disclosure,
  ErrorBanner,
  ProgressBar,
  StatusPill,
  SourceBranchCommitHint,
  Surface,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { brandText } from '@/lib/brand';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ImportedCursorRulesOffer } from '@/components/repo-rules/ImportedCursorRulesOffer';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import {
  captureProjectImportSubmission,
  openImportedProject,
} from '@/lib/importedProjectNavigation';
import {
  startProjectImportSubmission,
  UNKNOWN_IMPORT_SCAN,
} from '@/lib/projectImportTelemetry';
import type { ImportProjectsSource } from '@/stores/importProjectsModalStore';
import {
  chatCountLabel,
  chatTierCounts,
  CODE_PROJECT_LABEL,
  COWORK_PROJECT_LABEL,
  detectedSources,
  HISTORY_ONLY,
  HISTORY_ONLY_EXPLANATION,
  HISTORY_ONLY_TAG,
  IMPORT_SAFETY_NOTE,
  IMPORT_SOURCE_ORDER,
  importChatsLabel,
  importSourcesLabel,
  importSourcesList,
  listedChats,
  sourceData,
  sourceProjects,
  tierNote,
} from './importProjectsCopy';
import { ImportLocation } from './ImportLocation';
import { ImportSourceLogos } from './ImportSourceLogos';
import {
  bulkSelection,
  CAPPED_SCAN_NOTE,
  conflictingIds,
  containedRepositoriesLabel,
  INCOMPLETE_SCAN_NOTE,
  isBulkSelectable,
  isCappedParent,
  isDirectPick,
  isCurrentSelection,
  isUncertainPickedFolder,
  PLAIN_FOLDER_DETAIL,
  reconcileSelection,
  selectAllExclusive,
} from './pickedFolders';

/**
 * Shared body of the bulk project import flow (CAN-2439): Claude, Codex,
 * T3 Code, and OpenCode. The app-wide modal and the onboarding wizard step
 * both render this panel; the host only decides the chrome around it.
 *
 * Phases: `scanning` → `choose` → `importing` → `results`, with `error` for a
 * failed scan. The flow never blocks the user: the choose, error, and results
 * phases carry their own "Skip for now" or "Done" exits, and the scanning and
 * importing phases rely on the host's close button or the wizard's Skip. The
 * results phase reports each project on its own so one unreadable folder
 * never hides what did succeed.
 */

export type ImportProjectsPhase =
  | 'scanning'
  | 'choose'
  | 'importing'
  | 'results'
  | 'error';

export interface ImportProjectsPanelProps {
  providers?: ExternalProjectProvider[];
  /** Compact chrome for the onboarding wizard body. */
  embedded?: boolean;
  onSkip: () => void;
  onDone: () => void;
  onPhaseChange?: (phase: ImportProjectsPhase) => void;
  /** Where the hosting modal was opened from, for import telemetry. */
  modalEntry?: ImportProjectsSource;
}

interface SelectionState {
  selected: Set<string>;
  chats: Set<string>;
  explicitlySelected: Set<string>;
}

function isEligible(candidate: ExternalProjectCandidate): boolean {
  return (
    candidate.status === 'available' ||
    (candidate.status !== 'unavailable' && candidate.importableSessionCount > 0)
  );
}

function defaultSelection(
  candidates: ExternalProjectCandidate[],
): SelectionState {
  // Repositories found in a picked folder start selected; the folder holding
  // them, or one whose scan is uncertain, waits for an explicit choice.
  const selected = reconcileSelection(
    candidates.map((candidate) => candidate.id),
    candidates,
    (candidate) =>
      candidate.status === 'available' && isBulkSelectable(candidate),
  );
  const chats = new Set<string>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.id)) continue;
    // Chats follow the row: only a selected project defaults to importing
    // them, so no row ever shows chats checked while the project is not.
    if (candidate.importableSessionCount > 0) chats.add(candidate.id);
  }
  return { selected, chats, explicitlySelected: new Set() };
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

function statusPill(candidate: ExternalProjectCandidate): JSX.Element | null {
  if (candidate.status === 'available') return null;
  const label =
    candidate.status === 'already-tracked'
      ? 'Already added'
      : candidate.status === 'already-imported'
        ? 'Imported'
        : 'Unavailable';
  return (
    <StatusPill
      tone={candidate.status === 'unavailable' ? 'warning' : 'tertiary'}
      data-testid={`import-projects-status-${candidate.status}`}
    >
      {label}
    </StatusPill>
  );
}

function resultTone(result: ExternalProjectImportItemResult): string {
  if (result.status === 'imported') return 'fg-success';
  if (result.status === 'failed') return 'fg-destructive';
  return 'fg-tertiary';
}

function resultLabel(result: ExternalProjectImportItemResult): string {
  if (result.status === 'imported') return 'Added';
  if (result.status === 'failed') return 'Failed';
  return 'Skipped';
}

function resultDetail(result: ExternalProjectImportItemResult): string | null {
  const parts: string[] = [];
  const chatsTotal = result.chatsImported + result.chatsReadOnly;
  if (chatsTotal > 0) {
    parts.push(
      result.chatsReadOnly > 0
        ? `${chatCountLabel(chatsTotal)} imported, ${result.chatsReadOnly} ${HISTORY_ONLY}`
        : `${chatCountLabel(chatsTotal)} imported`,
    );
  }
  if (result.chatsSkipped > 0) {
    parts.push(`${chatCountLabel(result.chatsSkipped)} skipped`);
  }
  if (result.message) parts.push(result.message);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function ImportProjectsPanel({
  providers,
  embedded = false,
  onSkip,
  onDone,
  onPhaseChange,
  modalEntry,
}: ImportProjectsPanelProps): JSX.Element {
  const scopingContext = useSidebarScopingContext();
  const [phase, setPhaseState] = useState<ImportProjectsPhase>('scanning');
  const [scan, setScan] = useState<ExternalProjectDiscoverResponse | null>(
    null,
  );
  const [selection, setSelection] = useState<SelectionState>({
    selected: new Set(),
    chats: new Set(),
    explicitlySelected: new Set(),
  });
  const [customRoots, setCustomRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] =
    useState<ExternalProjectImportProgressEvent | null>(null);
  const [results, setResults] = useState<ExternalProjectImportItemResult[]>([]);
  const [pluginsAdded, setPluginsAdded] = useState(false);
  const [pluginsBusy, setPluginsBusy] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  // The tools found on this computer, named while the scan runs; null until
  // the presence check answers (or when it can't).
  const [present, setPresent] = useState<ExternalProjectProvider[] | null>(
    null,
  );
  const mountedRef = useRef(true);
  const scanRequestRef = useRef(0);
  const acceptedCandidatesRef = useRef<ExternalProjectCandidate[] | null>(null);
  const customRootsRef = useRef<string[]>([]);
  // Telemetry only: this opening's entry, and whether a folder was picked.
  const [entry] = useState(modalEntry);
  const pickedFolderRef = useRef(false);
  const importing = useRef(false);

  const setPhase = useCallback(
    (next: ImportProjectsPhase): void => {
      setPhaseState(next);
      onPhaseChange?.(next);
    },
    [onPhaseChange],
  );

  const skipFlow = useCallback((): void => {
    onSkip();
  }, [onSkip]);
  const finishFlow = useCallback((): void => {
    onDone();
  }, [onDone]);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const runScan = useCallback(
    async (roots: string[]): Promise<void> => {
      const requestId = ++scanRequestRef.current;
      setPhase('scanning');
      setError(null);
      try {
        const response = await window.api.externalProjects.discover({
          ...(providers ? { providers } : {}),
          ...(roots.length > 0 ? { customRoots: roots } : {}),
        });
        if (!mountedRef.current || requestId !== scanRequestRef.current) return;
        const previous = acceptedCandidatesRef.current;
        acceptedCandidatesRef.current = response.candidates;
        setScan(response);
        setSelection((current) => {
          const defaults = defaultSelection(response.candidates);
          if (previous === null) return defaults;
          const known = new Set(previous.map((candidate) => candidate.id));
          const selected = reconcileSelection(
            current.selected,
            response.candidates,
            (candidate) =>
              isEligible(candidate) &&
              (defaults.selected.has(candidate.id) ||
                current.explicitlySelected.has(candidate.id)),
          );
          const chats = new Set(
            Array.from(current.chats).filter((id) => selected.has(id)),
          );
          // Keep both explicit opt-ins and opt-outs. Defaults apply only to
          // new rows, and never displace a retained manual parent selection.
          for (const id of defaults.selected) {
            if (
              known.has(id) ||
              conflictingIds(id, response.candidates).some((conflict) =>
                selected.has(conflict),
              )
            )
              continue;
            selected.add(id);
            if (defaults.chats.has(id)) chats.add(id);
          }
          const explicitlySelected = new Set(
            Array.from(current.explicitlySelected).filter((id) =>
              selected.has(id),
            ),
          );
          return { selected, chats, explicitlySelected };
        });
        setPhase('choose');
      } catch (scanError) {
        if (!mountedRef.current || requestId !== scanRequestRef.current) return;
        setError(extractIpcErrorMessage(scanError));
        setPhase('error');
      }
    },
    [providers, setPhase],
  );

  useEffect(() => {
    void runScan([]);
    // Initial scan only; rescans are user-triggered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.externalProjects
      .readProviderPresence()
      .then((presence) => {
        if (!cancelled) setPresent(detectedSources(presence.providers));
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Subscribed for the panel's lifetime, not just the importing phase: the
  // import IPC fires in the same tick as the phase change, so a phase-gated
  // subscription could miss the first progress events.
  useEffect(
    () =>
      window.api.externalProjects.onImportProgress((event) => {
        if (!scan || event.scanId !== scan.scanId) return;
        setProgress(event);
      }),
    [scan],
  );

  const candidates = useMemo(() => scan?.candidates ?? [], [scan]);
  const eligible = useMemo(() => candidates.filter(isEligible), [candidates]);
  const selectedCount = selection.selected.size;
  // Select all skips folders holding repositories and uncertain picks.
  const bulk = useMemo(() => bulkSelection(eligible), [eligible]);
  const allEligibleSelected =
    bulk.size > 0 && Array.from(bulk).every((id) => selection.selected.has(id));

  const toggleSelected = (id: string): void => {
    const candidate = candidates.find((entry) => entry.id === id);
    setSelection((current) => {
      const selected = new Set(current.selected);
      const chats = new Set(current.chats);
      const explicitlySelected = new Set(current.explicitlySelected);
      if (selected.has(id)) {
        selected.delete(id);
        chats.delete(id);
        explicitlySelected.delete(id);
      } else {
        // A folder and the repositories found in it are exclusive.
        for (const conflict of conflictingIds(id, candidates)) {
          selected.delete(conflict);
          chats.delete(conflict);
          explicitlySelected.delete(conflict);
        }
        selected.add(id);
        explicitlySelected.add(id);
        // Selecting a project opts its chats in by default, as the initial
        // selection does; the chats checkbox stays available to opt out.
        if ((candidate?.importableSessionCount ?? 0) > 0) chats.add(id);
      }
      return { selected, chats, explicitlySelected };
    });
  };

  const toggleChats = (id: string): void => {
    setSelection((current) => {
      const chats = new Set(current.chats);
      if (chats.has(id)) chats.delete(id);
      else chats.add(id);
      return { ...current, chats };
    });
  };

  const toggleAll = (): void => {
    setSelection((current) => {
      if (allEligibleSelected) {
        const selected = new Set(current.selected);
        for (const id of bulk) selected.delete(id);
        return {
          selected,
          chats: current.chats,
          explicitlySelected: new Set(
            Array.from(current.explicitlySelected).filter((id) =>
              selected.has(id),
            ),
          ),
        };
      }
      const selected = selectAllExclusive(current.selected, bulk, candidates);
      const chats = new Set(
        Array.from(current.chats).filter((id) => selected.has(id)),
      );
      for (const candidate of eligible) {
        if (bulk.has(candidate.id) && candidate.importableSessionCount > 0)
          chats.add(candidate.id);
      }
      return {
        selected,
        chats,
        explicitlySelected: new Set(
          Array.from(current.explicitlySelected).filter((id) =>
            selected.has(id),
          ),
        ),
      };
    });
  };

  const pickFolder = async (): Promise<void> => {
    const folder = await window.api.externalProjects.pickFolder();
    if (!folder || !mountedRef.current) return;
    pickedFolderRef.current = true;
    const currentRoots = customRootsRef.current;
    const nextRoots = currentRoots.includes(folder)
      ? currentRoots
      : [...currentRoots, folder];
    customRootsRef.current = nextRoots;
    setCustomRoots(nextRoots);
    await runScan(nextRoots);
  };

  const runImport = async (candidateIds: string[]): Promise<void> => {
    if (!scan || candidateIds.length === 0 || importing.current) return;
    if (!isCurrentSelection(new Set(candidateIds), candidates, isEligible)) {
      setError('Your project choices changed. Review them before importing.');
      return;
    }
    importing.current = true;
    const submission = captureProjectImportSubmission();
    const tracking = startProjectImportSubmission({
      surface: { source: 'import_modal', modalEntry: entry },
      scan: scan
        ? { kind: 'completed', scan, found: eligible }
        : UNKNOWN_IMPORT_SCAN,
      selectedIds: candidateIds,
      pickedFolder: pickedFolderRef.current,
    });
    setPhase('importing');
    setProgress(null);
    setError(null);
    let response: ExternalProjectImportResponse;
    try {
      response = await window.api.externalProjects.importProjects({
        scanId: scan.scanId,
        selections: candidateIds.map((candidateId) => ({
          candidateId,
          importChats: selection.chats.has(candidateId),
        })),
      });
    } catch (importError) {
      tracking.fail();
      if (!mountedRef.current) return;
      setError(extractIpcErrorMessage(importError));
      setPhase('error');
      return;
    } finally {
      importing.current = false;
    }
    tracking.settle(response);

    // A retry only carries the retried ids. Record the import response before
    // follow-through so a reload or navigation failure cannot hide successes
    // or invite the user to import the same project again.
    if (mountedRef.current) {
      setResults((current) => {
        const byId = new Map(
          response.results.map((result) => [result.candidateId, result]),
        );
        const merged = current.map(
          (result) => byId.get(result.candidateId) ?? result,
        );
        const known = new Set(current.map((result) => result.candidateId));
        return [
          ...merged,
          ...response.results.filter(
            (result) => !known.has(result.candidateId),
          ),
        ];
      });
      setPhase('results');
    }

    // Durable follow-through must not depend on this panel still being
    // mounted, since the wizard can move on while the import is in flight.
    const firstImported = response.results.find(
      (result) => result.status === 'imported' && result.workspaceId,
    );
    try {
      await useProjectsStore.getState().loadProjects({ silent: true });
      if (firstImported?.workspaceId) {
        await openImportedProject(submission, firstImported.workspaceId);
      }
    } catch (followThroughError) {
      if (!mountedRef.current) return;
      setError(
        `Import finished, but the app could not refresh or open the imported project. ${extractIpcErrorMessage(followThroughError)}`,
      );
    }
  };

  const retryFailed = (): Promise<void> =>
    runImport(
      results
        .filter((result) => result.retryable)
        .map((result) => result.candidateId),
    );

  const addDetectedPlugins = async (
    plugins: ExternalProjectDetectedPlugin[],
  ): Promise<void> => {
    setPluginsBusy(true);
    setPluginsError(null);
    try {
      const prefs = await window.api.loadPreferences();
      if (prefs.__error) {
        // A degraded read resolves with defaults; merging those and saving
        // would replace the user's real plugin list with an empty one.
        setPluginsError('Preferences could not be read. Try again.');
        return;
      }
      const current = prefs.globalPluginSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      };
      const existing = new Set(
        current.pluginRefs.map(
          (ref) => `${ref.marketplaceId} ${ref.pluginName}`,
        ),
      );
      const pluginRefs = [
        ...current.pluginRefs,
        ...plugins
          .filter(
            (plugin) =>
              !existing.has(`${plugin.marketplaceId} ${plugin.pluginName}`),
          )
          .map((plugin) => ({
            marketplaceId: plugin.marketplaceId,
            pluginName: plugin.pluginName,
          })),
      ];
      await window.api.savePreferences({
        globalPluginSelections: { ...current, pluginRefs },
      });
      if (mountedRef.current) setPluginsAdded(true);
    } catch (pluginError) {
      if (mountedRef.current) {
        setPluginsError(extractIpcErrorMessage(pluginError));
      }
    } finally {
      if (mountedRef.current) setPluginsBusy(false);
    }
  };

  const nothingToImport = phase === 'choose' && eligible.length === 0;
  const detectedPlugins = scan?.detectedPlugins ?? [];
  // What this opening searches: the host's provider filter, else every tool.
  const searched = providers ?? IMPORT_SOURCE_ORDER;
  const searchedPresent = (present ?? []).filter((provider) =>
    searched.includes(provider),
  );
  const found = scan
    ? detectedSources(scan.providersDetected).filter((provider) =>
        searched.includes(provider),
      )
    : [];
  const wrapperClass = embedded ? 'flex flex-col gap-3' : 'flex flex-col gap-4';

  if (phase === 'scanning') {
    return (
      <div
        className={`${wrapperClass} py-6 text-center`}
        data-testid="import-projects-scanning"
      >
        <LoadingSpinner sizePx={20} className="mx-auto" />
        <p
          className="text-s fg-secondary"
          role="status"
          data-testid="import-projects-scanning-label"
        >
          Looking for {sourceProjects(importSourcesLabel(searchedPresent))}…
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className={wrapperClass} data-testid="import-projects-error">
        <ErrorBanner
          errorSource="import-projects-panel"
          className=""
          error={error ?? 'Projects could not be scanned.'}
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onSkip}
            data-testid="import-projects-skip"
          >
            Skip for now
          </Button>
          <Button
            variant="primary"
            onClick={(): void => {
              void runScan(customRoots);
            }}
            data-testid="import-projects-rescan"
          >
            Scan again
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'importing') {
    const totalItems = progress?.totalItems ?? selectedCount;
    const completedItems = progress?.completedItems ?? 0;
    const percent =
      totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    const detail =
      progress?.phase === 'chats' && progress.chatsTotal
        ? `Importing chats ${progress.chatsCompleted ?? 0} of ${progress.chatsTotal}`
        : progress
          ? `Adding ${progress.displayName}`
          : 'Starting import';
    return (
      <div className={wrapperClass} data-testid="import-projects-importing">
        <p className="text-s fg-primary" role="status">
          Importing project {Math.min(completedItems + 1, totalItems)} of{' '}
          {totalItems}…
        </p>
        <ProgressBar
          value={percent}
          label="Import progress"
          hideLabel
          dataTestId="import-projects-progress"
        />
        <p className="text-xs fg-secondary">{detail}…</p>
      </div>
    );
  }

  if (phase === 'results') {
    const imported = results.filter((result) => result.status === 'imported');
    const failed = results.filter((result) => result.status === 'failed');
    // Partial chat failures on an otherwise-added project are retryable too.
    const retryable = results.filter((result) => result.retryable);
    return (
      <div className={wrapperClass} data-testid="import-projects-results">
        <p className="text-s fg-primary">
          {imported.length === 0
            ? 'No projects were added.'
            : imported.length === 1
              ? `1 project is ready in ${brandText.appName}.`
              : `${imported.length} projects are ready in ${brandText.appName}.`}
          {failed.length > 0 && ` ${failed.length} could not be added.`}
        </p>
        <ErrorBanner
          errorSource="import-projects-follow-through-error"
          className=""
          error={error}
          testId="import-projects-follow-through-error"
        />
        <ul
          className="flex flex-col max-h-72 overflow-y-auto gap-1 [&>*]:shrink-0"
          role="list"
        >
          {results.map((result) => {
            const detail = resultDetail(result);
            return (
              <Surface
                as="li"
                variant="group"
                size="small"
                key={result.candidateId}
                data-testid={`import-projects-result-${result.candidateId}`}
                data-status={result.status}
              >
                <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`min-w-0 truncate text-s font-medium fg-primary ${POSTHOG_REPLAY_MASK_CLASS}`}
                    >
                      {result.displayName}
                    </span>
                    <span
                      className={`shrink-0 text-xs font-medium ${resultTone(result)}`}
                    >
                      {resultLabel(result)}
                    </span>
                  </div>
                  {detail && (
                    <p className="mt-0.5 text-xs fg-secondary">{detail}</p>
                  )}
                </div>
              </Surface>
            );
          })}
        </ul>
        <ImportedCursorRulesOffer
          workspaces={imported.flatMap((result) =>
            result.workspaceId
              ? [
                  {
                    workspaceId: result.workspaceId,
                    displayName: result.displayName,
                  },
                ]
              : [],
          )}
          onReview={(workspaceId): void => {
            finishFlow();
            openRepoRulesModal({ source: 'import-results', workspaceId });
          }}
        />
        {detectedPlugins.length > 0 && (
          <Surface
            variant="outline"
            gap="inline"
            size="small"
            data-testid="import-projects-plugins"
          >
            <div className="flex flex-col gap-2 px-3 py-2">
              <p className="text-s fg-primary">
                {detectedPlugins.length === 1
                  ? `1 plugin from ${importSourcesList(detectedPlugins[0]?.providers ?? [], 'and')} is not on your plugin list yet.`
                  : `${detectedPlugins.length} plugins installed in ${importSourcesList(
                      detectedPlugins.flatMap((plugin) => plugin.providers),
                      'or',
                    )} are not on your plugin list yet.`}
              </p>
              <p className="mt-0.5 text-xs fg-secondary">
                Adding them keeps your preferred plugins in one place. Plugins
                that need sign-in ask for it in {CUSTOMIZE_LABEL}.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pluginsBusy || pluginsAdded}
                  onClick={(): void => {
                    void addDetectedPlugins(detectedPlugins);
                  }}
                  data-testid="import-projects-add-plugins"
                >
                  {pluginsAdded ? 'Plugins added' : 'Add plugins'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(): void => {
                    useNavigationStore.getState().navigate('plugins');
                    finishFlow();
                  }}
                  data-testid="import-projects-open-plugins"
                >
                  Set up plugins
                </Button>
              </div>
              <ErrorBanner
                errorSource="import-projects-plugins-error"
                className=""
                error={pluginsError}
                testId="import-projects-plugins-error"
              />
            </div>
          </Surface>
        )}
        <div className="flex items-center justify-end gap-2">
          {retryable.length > 0 && (
            <Button
              variant="secondary"
              onClick={(): void => {
                void retryFailed();
              }}
              data-testid="import-projects-retry"
            >
              Try again
            </Button>
          )}
          <Button
            variant="primary"
            onClick={finishFlow}
            data-testid="import-projects-done"
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={wrapperClass} data-testid="import-projects-choose">
      {scopingContext?.kind === 'organization' && (
        <Surface
          variant="group"
          size="small"
          role="note"
          data-testid="import-projects-personal-notice"
        >
          <div className="px-3 py-2 text-xs fg-secondary">
            Imported projects are Personal. You’ll switch to Personal after
            they’re added.
          </div>
        </Surface>
      )}
      {nothingToImport ? (
        <Stack gap="inline" data-testid="import-projects-empty">
          <p className="text-s fg-primary">
            {candidates.length === 0
              ? found.length === 0
                ? // Nothing found: names what was searched for.
                  `No ${sourceData(importSourcesLabel(searched))} found on this computer.`
                : `No ${sourceProjects(importSourcesLabel(found))} found on this computer.`
              : `Everything found is already in ${brandText.appName}.`}
          </p>
          <p className="text-xs fg-secondary">
            Choose a folder to add it as a project, or come back after using{' '}
            {importSourcesList(searched, 'or')}.
          </p>
        </Stack>
      ) : (
        <p
          className="text-s fg-secondary"
          data-testid="import-projects-choose-note"
        >
          {IMPORT_SAFETY_NOTE}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <ChoiceField
            label="Select all eligible"
            checked={allEligibleSelected}
            disabled={bulk.size === 0}
            onChange={toggleAll}
            data-testid="import-projects-select-all"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={(): void => {
                void runScan(customRoots);
              }}
              data-testid="import-projects-rescan"
            >
              Scan again
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={(): void => {
                void pickFolder();
              }}
              data-testid="import-projects-pick-folder"
            >
              Choose folder…
            </Button>
          </div>
        </div>
      )}

      {candidates.length === 0 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={(): void => {
            void pickFolder();
          }}
          data-testid="import-projects-pick-folder"
        >
          Choose folder…
        </Button>
      )}

      {candidates.length > 0 && (
        <ul
          className={`${embedded ? 'max-h-64' : 'max-h-80'} flex flex-col gap-1 overflow-y-auto [&>*]:shrink-0`}
          role="list"
          data-testid="import-projects-list"
          data-row-count={candidates.length}
        >
          {candidates.map((candidate) => {
            const eligibleRow = isEligible(candidate);
            const checked = selection.selected.has(candidate.id);
            const relative = formatRelative(candidate.lastActivityAt);
            const chats = listedChats(candidate);
            const tierCounts = chatTierCounts(candidate);
            const note = tierNote(tierCounts);
            const explainsHistory = (tierCounts?.historyOnly ?? 0) > 0;
            const kindLabel =
              candidate.kind === 'git'
                ? CODE_PROJECT_LABEL
                : COWORK_PROJECT_LABEL;
            const pickedFolder =
              isDirectPick(candidate) && candidate.kind === 'folder';
            const contained = containedRepositoriesLabel(candidate);
            const linked = candidate.linkedWorktreePaths.length;
            // One line of plain facts; the checkbox for chats sits at its end.
            const meta = [
              kindLabel,
              ...(pickedFolder ? [PLAIN_FOLDER_DETAIL] : []),
              ...(pickedFolder && contained ? [contained] : []),
              ...(candidate.sessionCount > 0
                ? [chatCountLabel(candidate.sessionCount)]
                : []),
              ...(linked > 0
                ? [
                    linked === 1
                      ? '1 linked worktree'
                      : `${linked} linked worktrees`,
                  ]
                : []),
              ...(relative ? [`last used ${relative}`] : []),
            ].join(' · ');
            const scanNotes = pickedFolder
              ? [
                  ...(isUncertainPickedFolder(candidate)
                    ? [INCOMPLETE_SCAN_NOTE]
                    : []),
                  ...(isCappedParent(candidate, candidates)
                    ? [CAPPED_SCAN_NOTE]
                    : []),
                ]
              : [];
            return (
              <Surface
                as="li"
                key={candidate.id}
                variant="outline"
                size="small"
                selected={checked}
                data-testid={`import-projects-row-${candidate.id}`}
                data-status={candidate.status}
                data-kind={candidate.kind}
              >
                <div className={`px-3 py-2 ${eligibleRow ? '' : 'opacity-70'}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      disabled={!eligibleRow}
                      onChange={(): void => toggleSelected(candidate.id)}
                      aria-label={`Import ${candidate.displayName}`}
                      data-testid={`import-projects-row-checkbox-${candidate.id}`}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`truncate text-s font-medium fg-primary ${POSTHOG_REPLAY_MASK_CLASS}`}
                          data-testid={`import-projects-row-name-${candidate.id}`}
                        >
                          {candidate.displayName}
                        </span>
                        <ImportSourceLogos
                          providers={candidate.providers}
                          dataTestId={`import-projects-row-tools-${candidate.id}`}
                        />
                        <span className="ml-auto shrink-0">
                          {statusPill(candidate)}
                        </span>
                      </div>
                      <ImportLocation
                        rootPath={candidate.rootPath}
                        className="text-xs fg-tertiary"
                        dataTestId={`import-projects-row-location-${candidate.id}`}
                      />
                      <div className="flex min-w-0 items-center gap-3 text-xs fg-tertiary">
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={meta}
                          data-testid={`import-projects-row-meta-${candidate.id}`}
                        >
                          {meta}
                        </span>
                        {candidate.kind === 'git' && (
                          <SourceBranchCommitHint
                            headUnborn={candidate.headUnborn}
                            className="shrink-0"
                            testId={`import-projects-row-no-commits-${candidate.id}`}
                          />
                        )}
                        {candidate.importableSessionCount > 0 && (
                          <span className="shrink-0">
                            <ChoiceField
                              label={importChatsLabel(candidate)}
                              checked={selection.chats.has(candidate.id)}
                              disabled={!checked}
                              onChange={(): void => toggleChats(candidate.id)}
                              data-testid={`import-projects-row-chats-${candidate.id}`}
                            />
                          </span>
                        )}
                      </div>
                      {note && (
                        <p className="text-2xs fg-tertiary">
                          {explainsHistory ? (
                            <Tooltip label={HISTORY_ONLY_EXPLANATION}>
                              {/* Focusable so the explanation reaches the keyboard too. */}
                              <span
                                tabIndex={0}
                                className="focus-ring"
                                data-testid={`import-projects-row-chat-tiers-${candidate.id}`}
                              >
                                {note}
                              </span>
                            </Tooltip>
                          ) : (
                            <span
                              data-testid={`import-projects-row-chat-tiers-${candidate.id}`}
                            >
                              {note}
                            </span>
                          )}
                        </p>
                      )}
                      {candidate.statusReason && (
                        <p
                          className="text-xs fg-tertiary"
                          data-testid="import-projects-row-reason"
                        >
                          {candidate.statusReason}
                        </p>
                      )}
                      {scanNotes.length > 0 && (
                        <p className="text-xs fg-tertiary">
                          {scanNotes
                            .map((scanNote) => `${scanNote}.`)
                            .join(' ')}
                        </p>
                      )}
                      {chats && (
                        <Disclosure
                          label="Show chats"
                          className="mt-0.5"
                          dataTestId={`import-projects-row-chat-list-${candidate.id}`}
                        >
                          <ul className="flex flex-col gap-0.5 text-xs fg-secondary">
                            {chats.chats.map((chat) => (
                              <li
                                key={chat.title}
                                className="flex min-w-0 items-center gap-2"
                                data-history-only={chat.historyOnly}
                              >
                                {/* Session titles fall back to the first prompt's text. */}
                                <span
                                  className={`min-w-0 flex-1 truncate ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                                >
                                  {chat.title}
                                </span>
                                {chat.historyOnly && (
                                  <Badge className="shrink-0">
                                    {HISTORY_ONLY_TAG}
                                  </Badge>
                                )}
                              </li>
                            ))}
                            {chats.more > 0 && (
                              <li className="fg-tertiary">{chats.more} more</li>
                            )}
                          </ul>
                        </Disclosure>
                      )}
                    </div>
                  </div>
                </div>
              </Surface>
            );
          })}
        </ul>
      )}

      {scan && scan.diagnostics.length > 0 && (
        <ul
          className="flex flex-col text-xs fg-tertiary gap-0.5"
          data-testid="import-projects-diagnostics"
        >
          {scan.diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.source}-${index}`}>{diagnostic.message}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          onClick={skipFlow}
          data-testid="import-projects-skip"
        >
          Skip for now
        </Button>
        {nothingToImport ? (
          <Button
            variant="primary"
            onClick={finishFlow}
            data-testid="import-projects-done"
          >
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={selectedCount === 0}
            onClick={(): void => {
              void runImport(Array.from(selection.selected));
            }}
            data-testid="import-projects-submit"
          >
            {selectedCount === 1
              ? 'Import 1 project'
              : `Import ${selectedCount} projects`}
          </Button>
        )}
      </div>
    </div>
  );
}
