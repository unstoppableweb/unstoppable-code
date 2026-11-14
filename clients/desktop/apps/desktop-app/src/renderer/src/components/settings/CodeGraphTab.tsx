import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  WORKSPACE_ROOT_REPO_ID,
  type CodeGraphPreferenceMode,
  type CodeGraphPreferences,
} from '@canopy/desktop-shared/types';
import { ErrorBanner, FieldError } from '@canopy/ui-shared/components';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  WorkspaceMultiSelectPicker,
  type WorkspacePickerOption,
} from '@/components/worktree/WorkspaceMultiSelectPicker';
import { CodeGraphGenerationQueue } from './CodeGraphGenerationQueue';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsTextField,
} from './SettingsLayout';
import {
  DEFAULT_CODE_GRAPH_PREFERENCES,
  MAX_GENERATION_TIMEOUT_MINUTES,
  MIN_GENERATION_TIMEOUT_MINUTES,
  isValidGenerationTimeoutMinutes,
  normalizeCodeGraphPreferences,
} from './code-graph-preferences';

const SAVE_ERROR_MESSAGE = 'Could not save Code Graph settings. Try again.';
const INVALID_TIMEOUT_MESSAGE = 'Enter a whole number from 1 to 1,440 minutes.';
const EMPTY_PICKER_MESSAGE = 'No code projects found.';
const PAGE_DESCRIPTION =
  'Generate local code graphs for richer code navigation, impact analysis, and agent tools.';

const MODE_OPTIONS: {
  mode: CodeGraphPreferenceMode;
  title: string;
  description: string;
}[] = [
  {
    mode: 'enabled',
    title: 'Enabled',
    description: 'Generate code graphs for every project.',
  },
  {
    mode: 'disabled',
    title: 'Disabled',
    description: 'Turn off code graph generation everywhere.',
  },
  {
    mode: 'selected-workspaces',
    title: 'Select projects',
    description: 'Generate code graphs only for the projects you choose.',
  },
];

/**
 * Settings → Code Graph tab. Surfaces the Code Graph availability preference
 * (Enabled / Disabled / Select projects), the generation timeout, and the
 * live generation queue.
 *
 * Every save sends the *complete* `codeGraph` object (mode, selection, and
 * timeout together) because the preferences write path shallow-merges then
 * re-normalizes — a partial patch would silently wipe the other sub-fields.
 * Saves are optimistic and roll back to the last persisted value on failure.
 */
export function CodeGraphTab(): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);

  const [codeGraph, setCodeGraph] = useState<CodeGraphPreferences>(
    DEFAULT_CODE_GRAPH_PREFERENCES,
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [timeoutDraft, setTimeoutDraft] = useState(
    String(DEFAULT_CODE_GRAPH_PREFERENCES.generationTimeoutMinutes),
  );
  const [timeoutError, setTimeoutError] = useState<string | null>(null);

  const codeGraphRef = useRef<CodeGraphPreferences>(codeGraph);
  useEffect(() => {
    codeGraphRef.current = codeGraph;
  }, [codeGraph]);

  // Keep the timeout text field in sync with the persisted value: on load, on a
  // successful save, and on rollback. Invalid drafts never reach here (they are
  // not persisted), so a bad draft stays put with its error until the user
  // fixes it or the persisted value changes underneath.
  useEffect(() => {
    setTimeoutDraft(String(codeGraph.generationTimeoutMinutes));
    setTimeoutError(null);
  }, [codeGraph.generationTimeoutMinutes]);

  // Code workspaces (single- and multi-repo, including temporary multi-repo),
  // excluding cowork chat-only workspaces. A source-backed workspace whose
  // only repository is the synthetic workspace root is still a code workspace.
  const workspaceOptions = useMemo<WorkspacePickerOption[]>(() => {
    return projects
      .filter((project) => {
        if (project.type === 'single-repo') {
          return true;
        }
        if (project.type === 'cowork') {
          return false;
        }
        return (
          Boolean(project.sourceRepoPath) ||
          project.repos.some((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
        );
      })
      .map((project) => ({
        id: project.id,
        name: project.name,
        color: project.color,
        isMultiRepo: project.type === 'multi-repo',
        repoCount:
          project.type === 'multi-repo'
            ? Math.max(
                1,
                project.repos.filter(
                  (repo) => repo.id !== WORKSPACE_ROOT_REPO_ID,
                ).length,
              )
            : 1,
        temporary: project.type === 'multi-repo' && project.temporary === true,
        repoPath: project.type === 'single-repo' ? project.repoPath : undefined,
      }));
  }, [projects]);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) {
          return;
        }
        const normalized = normalizeCodeGraphPreferences(prefs.codeGraph);
        setCodeGraph(normalized);
        codeGraphRef.current = normalized;
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const persistCodeGraph = useCallback(
    async (next: CodeGraphPreferences): Promise<void> => {
      const previous = codeGraphRef.current;
      setCodeGraph(next);
      codeGraphRef.current = next;
      setSaving(true);
      setSaveError(null);
      try {
        const prefs = await window.api.savePreferences({ codeGraph: next });
        const normalized = normalizeCodeGraphPreferences(prefs.codeGraph);
        setCodeGraph(normalized);
        codeGraphRef.current = normalized;
      } catch {
        setCodeGraph(previous);
        codeGraphRef.current = previous;
        setSaveError(SAVE_ERROR_MESSAGE);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleSelectMode = useCallback(
    (mode: CodeGraphPreferenceMode): void => {
      if (saving || mode === codeGraphRef.current.mode) {
        return;
      }
      void persistCodeGraph({ ...codeGraphRef.current, mode });
    },
    [persistCodeGraph, saving],
  );

  const handleToggleWorkspace = useCallback(
    (workspaceId: string): void => {
      if (saving) {
        return;
      }
      const current = codeGraphRef.current;
      const selectedWorkspaceIds = current.selectedWorkspaceIds.includes(
        workspaceId,
      )
        ? current.selectedWorkspaceIds.filter((id) => id !== workspaceId)
        : [...current.selectedWorkspaceIds, workspaceId];
      void persistCodeGraph({ ...current, selectedWorkspaceIds });
    },
    [persistCodeGraph, saving],
  );

  const commitTimeout = useCallback((): void => {
    if (saving) {
      return;
    }
    const trimmed = timeoutDraft.trim();
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !isValidGenerationTimeoutMinutes(parsed)) {
      setTimeoutError(INVALID_TIMEOUT_MESSAGE);
      return;
    }
    setTimeoutError(null);
    if (parsed === codeGraphRef.current.generationTimeoutMinutes) {
      setTimeoutDraft(String(parsed));
      return;
    }
    void persistCodeGraph({
      ...codeGraphRef.current,
      generationTimeoutMinutes: parsed,
    });
  }, [persistCodeGraph, saving, timeoutDraft]);

  const controlsDisabled = !loaded || saving;
  const parsedTimeoutDraft = Number(timeoutDraft.trim());
  const timeoutDraftIsNumeric =
    /^\d+$/.test(timeoutDraft.trim()) && Number.isFinite(parsedTimeoutDraft);

  useCurrentUiStateReporter('settings.codeGraph', {
    loaded,
    mode: codeGraph.mode,
    selectedWorkspaceIds: codeGraph.selectedWorkspaceIds,
    generationTimeoutMinutes: codeGraph.generationTimeoutMinutes,
    ...(timeoutDraftIsNumeric
      ? { timeoutDraftMinutes: parsedTimeoutDraft }
      : {}),
    saving,
    saveErrorVisible: saveError !== null,
    timeoutErrorVisible: timeoutError !== null,
  });

  if (!loaded) {
    return (
      <SettingsPage
        title="Code Graph"
        description={PAGE_DESCRIPTION}
        dataTestId="settings-tab-code-graph"
      >
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Code Graph"
      description={PAGE_DESCRIPTION}
      dataTestId="settings-tab-code-graph"
    >
      <SettingsSection title="Generation">
        <ErrorBanner
          errorSource="code-graph-tab-save"
          className=""
          error={saveError}
        />
        <SettingsGroup>
          <SettingsRow
            label="Availability"
            description={
              MODE_OPTIONS.find((option) => option.mode === codeGraph.mode)
                ?.description
            }
            control={
              <SettingsSegmentedControl
                label="Code Graph availability"
                value={codeGraph.mode}
                disabled={controlsDisabled}
                onChange={handleSelectMode}
                options={MODE_OPTIONS.map((option) => ({
                  value: option.mode,
                  label: option.title,
                  dataTestId: `code-graph-mode-${option.mode}`,
                }))}
              />
            }
          >
            {codeGraph.mode === 'selected-workspaces' &&
              (workspaceOptions.length > 0 ? (
                <WorkspaceMultiSelectPicker
                  options={workspaceOptions}
                  selectedWorkspaceIds={codeGraph.selectedWorkspaceIds}
                  onToggleWorkspace={handleToggleWorkspace}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  label="Projects"
                  testIdPrefix="code-graph-workspace-picker"
                  listHeight="medium"
                />
              ) : (
                <p
                  className="text-s fg-secondary"
                  data-testid="code-graph-workspace-picker-empty"
                >
                  {EMPTY_PICKER_MESSAGE}
                </p>
              ))}
          </SettingsRow>
          <SettingsRow
            label="Generation timeout"
            htmlFor="code-graph-generation-timeout"
            description="Stops a generation whose worker runs longer than this. Applies from the next worker start, and time waiting in the queue does not count."
            control={
              <>
                <SettingsTextField
                  id="code-graph-generation-timeout"
                  type="number"
                  width="xs"
                  inputMode="numeric"
                  min={MIN_GENERATION_TIMEOUT_MINUTES}
                  max={MAX_GENERATION_TIMEOUT_MINUTES}
                  step={1}
                  value={timeoutDraft}
                  disabled={controlsDisabled}
                  onChange={(event): void => {
                    setTimeoutDraft(event.target.value);
                    if (timeoutError) {
                      setTimeoutError(null);
                    }
                  }}
                  onBlur={commitTimeout}
                  onKeyDown={(event): void => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitTimeout();
                    }
                  }}
                  aria-invalid={timeoutError !== null}
                  aria-describedby={
                    timeoutError
                      ? 'code-graph-generation-timeout-error'
                      : undefined
                  }
                  data-testid="code-graph-generation-timeout"
                />
                <span className="text-xs fg-secondary">minutes</span>
              </>
            }
          >
            {timeoutError && (
              <FieldError
                id="code-graph-generation-timeout-error"
                announce
                data-testid="code-graph-generation-timeout-error"
              >
                {timeoutError}
              </FieldError>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <CodeGraphGenerationQueue />
    </SettingsPage>
  );
}
