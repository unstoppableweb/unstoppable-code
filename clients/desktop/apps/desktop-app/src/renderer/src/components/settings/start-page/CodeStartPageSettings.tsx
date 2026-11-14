import { Stack } from '@canopy/ui-shared/components';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { SettingsSaveState } from '@canopy/ui-shared/components';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsLayout';
import { ProjectSettingsScopeGroup } from '../../worktree/project-settings/ProjectSettingsScope';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartPageStore } from '@/stores/startPageStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  StartPageSettingControl,
  type StartPageSettingValue,
} from './StartPageSettingControl';
import {
  AddToWorktreeActionControls,
  SaveLocalButton,
  SourceLocalToggle,
  SourceWorktreePicker,
} from '../../worktree/WorktreeSettingsControls';
import type {
  AddToWorktreeFeedback,
  AddToWorktreeTarget,
} from '../../worktree/worktree-settings-controls-state';

// Settings never show an exception's text; main logs the details.
const START_PAGE_LOAD_ERROR = "Couldn't load the start page. Try again.";
const START_PAGE_SAVE_ERROR = "Couldn't save the start page. Try again.";

/** `undefined` (use the team setting) and `null` (new chat) stay distinct. */
function serializeStartPageValue(value: StartPageSettingValue): string {
  return value === undefined ? 'team' : JSON.stringify(value);
}

interface CodeStartPageSettingsProps {
  project: SingleRepoSidebarItem | MultiRepoSidebarItem;
  initialWorktreeId?: string;
  initialMode?: 'source' | 'local';
  prefill?: ProjectStartPage | null;
  /**
   * `panel` is the modal tab. `settings` is a page of grouped rows. Both
   * save a choice for this computer with Save local.
   */
  layout?: 'panel' | 'settings';
  /** Reports each save, for a page that shows one save line. */
  onSaveStateChange?: (state: SettingsSaveState) => void;
  /**
   * Gives the page a function that waits for this computer's writes and
   * resolves false when the last choice could not be written, so closing
   * the page can wait for it. Called with null on unmount.
   */
  onRegisterFlush?: (flush: (() => Promise<boolean>) | null) => void;
  /** Reports whether a choice for this computer waits for Save local. */
  onUnsavedChange?: (unsaved: boolean) => void;
}

export function CodeStartPageSettings({
  project,
  initialWorktreeId,
  initialMode = 'local',
  prefill,
  layout = 'panel',
  onSaveStateChange,
  onRegisterFlush,
  onUnsavedChange,
}: CodeStartPageSettingsProps): JSX.Element {
  const [mode, setMode] = useState<'source' | 'local'>(initialMode);
  const [worktreeId, setWorktreeId] = useState(initialWorktreeId);
  // `prefill` seeds the canopy.json draft ("Share with team"); this
  // computer's value is always the stored one.
  const [value, setValue] = useState<StartPageSettingValue>(
    initialMode === 'source' && prefill !== undefined
      ? prefill
      : project.startPage,
  );
  // Which scope `value` was loaded for. Right after the scope changes, the
  // value still belongs to the other one until the effect below loads it.
  const [valueMode, setValueMode] = useState<'source' | 'local' | null>(
    initialMode === 'local' ? 'local' : null,
  );
  // Set by a choice the user makes; cleared when the scope or project
  // changes. A refreshed saved value (after a save) then leaves that choice
  // on screen instead of replacing it.
  const editedRef = useRef(false);
  // The last choice for this computer, kept across scope switches until it
  // is written, for a save that finishes after the page moved on.
  // Keyed by project: a choice is only ever written to its own project.
  const latestLocalRef = useRef<{
    projectId: string;
    key: string;
    value: StartPageSettingValue;
  } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;
  const changeValue = useCallback((next: StartPageSettingValue): void => {
    editedRef.current = true;
    if (modeRef.current === 'local') {
      latestLocalRef.current = {
        projectId: projectIdRef.current,
        key: serializeStartPageValue(next),
        value: next,
      };
    }
    setValue(next);
  }, []);
  const loadedForRef = useRef<{ mode: string; projectId: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [startPageValid, setStartPageValid] = useState(true);
  const [error, setError] = useState('');
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  const [existingWorktreePickerOpen, setExistingWorktreePickerOpen] =
    useState(false);
  const [addFeedback, setAddFeedback] = useState<AddToWorktreeFeedback>({
    phase: 'idle',
  });

  useEffect(() => {
    const previous = loadedForRef.current;
    loadedForRef.current = { mode, projectId: project.id };
    const refresh =
      previous !== null &&
      previous.mode === mode &&
      previous.projectId === project.id;
    if (!refresh) editedRef.current = false;
    if (mode === 'local') {
      const unsaved = latestLocalRef.current;
      if (!refresh && unsaved !== null && unsaved.projectId === project.id) {
        // Back on this computer with a choice not written yet: show it
        // again, as an edit, so it is saved.
        editedRef.current = true;
        setValue(unsaved.value);
      } else if (!(refresh && editedRef.current)) {
        setValue(project.startPage);
      }
      setValueMode('local');
      setStartPageValid(true);
      return;
    }
    setValueMode(null);
    setStartPageValid(false);
    let canceled = false;
    void window.api
      .getWorkspaceSettingsData({ workspaceId: project.id, worktreeId })
      .then((response) => {
        if (!canceled) {
          setValue(
            prefill !== undefined
              ? prefill
              : (response.manifest?.startPage ?? null),
          );
          setValueMode('source');
          setStartPageValid(true);
        }
      })
      .catch(() => {
        if (!canceled) setError(START_PAGE_LOAD_ERROR);
      });
    return (): void => {
      canceled = true;
    };
  }, [mode, prefill, project.id, project.startPage, worktreeId]);

  const onSaveStateChangeRef = useRef(onSaveStateChange);
  onSaveStateChangeRef.current = onSaveStateChange;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // The write running now (a follow-up write replaces it), and whether the
  // last write failed.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastWriteFailedRef = useRef(false);
  const onRegisterFlushRef = useRef(onRegisterFlush);
  onRegisterFlushRef.current = onRegisterFlush;
  useEffect(() => {
    const flush = async (): Promise<boolean> => {
      while (inFlightRef.current !== null) await inFlightRef.current;
      return !(lastWriteFailedRef.current && latestLocalRef.current !== null);
    };
    onRegisterFlushRef.current?.(flush);
    return (): void => onRegisterFlushRef.current?.(null);
  }, []);

  const writeLocalOnce = async (
    next: StartPageSettingValue,
    projectId: string,
  ): Promise<void> => {
    const sentKey = serializeStartPageValue(next);
    let written = false;
    setSaving(true);
    setError('');
    onSaveStateChangeRef.current?.('saving');
    try {
      await window.api.setWorkspaceStartPage({
        workspaceId: projectId,
        ...(next === undefined ? {} : { startPage: next }),
      });
      await useProjectsStore.getState().loadProjects();
      await useStartPageStore.getState().refreshProject(projectId);
      written = true;
      lastWriteFailedRef.current = false;
      if (layout === 'settings') {
        onSaveStateChangeRef.current?.('saved');
      } else {
        useGitHubStore.getState().addToast('Start page saved', 'success');
      }
    } catch {
      lastWriteFailedRef.current = true;
      onSaveStateChangeRef.current?.('error');
      setError(START_PAGE_SAVE_ERROR);
    } finally {
      setSaving(false);
    }
    const latest = latestLocalRef.current;
    if (latest === null || latest.projectId !== projectId) return;
    if (latest.key === sentKey) {
      // The last choice is stored: later refreshes show outside changes.
      if (written) {
        latestLocalRef.current = null;
        editedRef.current = false;
      }
      return;
    }
  };
  // The choice the running write is storing, so one choice is written once.
  const inFlightKeyRef = useRef<{ projectId: string; key: string } | null>(
    null,
  );
  /** Writes this computer's start page for a project. */
  const writeLocal = (
    next: StartPageSettingValue,
    projectId: string,
  ): Promise<void> => {
    const key = serializeStartPageValue(next);
    const running = inFlightRef.current;
    const runningKey = inFlightKeyRef.current;
    if (
      running !== null &&
      runningKey !== null &&
      runningKey.projectId === projectId &&
      runningKey.key === key
    ) {
      return running;
    }
    const run = writeLocalOnce(next, projectId);
    inFlightRef.current = run;
    inFlightKeyRef.current = { projectId, key };
    void run.finally(() => {
      if (inFlightRef.current === run) {
        inFlightRef.current = null;
        inFlightKeyRef.current = null;
      }
    });
    return run;
  };

  const save = async (sourceTarget?: AddToWorktreeTarget): Promise<void> => {
    if (!startPageValid) return;
    if (mode === 'local') {
      await writeLocal(value, project.id);
      return;
    }
    setSaving(true);
    setError('');
    onSaveStateChangeRef.current?.('saving');
    const targetLabel =
      sourceTarget?.mode === 'existing'
        ? (project.worktrees.find(
            (worktree) => worktree.id === sourceTarget.worktreeId,
          )?.branchName ?? sourceTarget.worktreeId)
        : 'new worktree';
    setAddFeedback({ phase: 'applying', targetLabel });
    try {
      const selectedTarget =
        sourceTarget ??
        (worktreeId
          ? { mode: 'existing' as const, worktreeId }
          : { mode: 'new' as const });
      const target =
        selectedTarget.mode === 'existing'
          ? selectedTarget
          : {
              mode: 'new' as const,
              existingWorktreeIds: project.worktrees.map(
                (worktree) => worktree.id,
              ),
            };
      if (project.type === 'multi-repo') {
        await window.api.applyWorkspaceSourceChanges({
          workspaceId: project.id,
          target,
          startPage: value ?? null,
        });
      } else {
        await window.api.applyProjectSourceChanges({
          projectId: project.id,
          target,
          startPage: value ?? null,
        });
      }
      await useProjectsStore.getState().loadProjects();
      await useStartPageStore.getState().refreshProject(project.id);
      if (layout === 'settings') {
        onSaveStateChangeRef.current?.('saved');
      } else {
        useGitHubStore.getState().addToast('Start page saved', 'success');
      }
    } catch {
      onSaveStateChangeRef.current?.('error');
      setError(START_PAGE_SAVE_ERROR);
    } finally {
      setSaving(false);
      setAddFeedback({ phase: 'idle' });
    }
  };

  // A choice for this computer waits for Save local.
  const localChanged =
    mode === 'local' &&
    valueMode === 'local' &&
    serializeStartPageValue(value) !==
      serializeStartPageValue(project.startPage);
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  onUnsavedChangeRef.current = onUnsavedChange;
  // A choice kept while the Source controlled tab is shown is still unsaved.
  const pendingLocal = latestLocalRef.current;
  const hiddenLocalChange =
    mode !== 'local' &&
    pendingLocal !== null &&
    pendingLocal.projectId === project.id &&
    pendingLocal.key !== serializeStartPageValue(project.startPage);
  // A running write is not unsaved: closing waits for it instead.
  // While a write runs, a choice made after it started is unsaved even when
  // it matches the value stored before that write.
  const localUnsaved = saving
    ? pendingLocal !== null &&
      pendingLocal.projectId === project.id &&
      pendingLocal.key !== inFlightKeyRef.current?.key
    : localChanged || hiddenLocalChange;
  useEffect(() => {
    onUnsavedChangeRef.current?.(localUnsaved);
  }, [localUnsaved]);
  useEffect(
    () => (): void => {
      onUnsavedChangeRef.current?.(false);
    },
    [],
  );

  if (layout === 'settings') {
    return (
      <Stack gap="hero">
        <ProjectSettingsScopeGroup scope={mode} onScopeChange={setMode}>
          {mode === 'local' ? (
            <SettingsRow
              label="Local override"
              description={
                localChanged
                  ? 'Unsaved change. It overrides canopy.json on this computer once saved.'
                  : 'Saved on this computer. Local overrides take priority over canopy.json.'
              }
              control={
                <Button
                  variant="primary"
                  size="compact"
                  disabled={saving || !startPageValid || !localChanged}
                  onClick={() => void save()}
                  data-testid="start-page-save-local"
                >
                  {saving ? 'Saving…' : 'Save local'}
                </Button>
              }
            />
          ) : null}
          {mode === 'source' ? (
            <>
              <SettingsRow
                label="Read canopy.json from"
                description="The worktree whose canopy.json you see and change."
                control={
                  <SourceWorktreePicker
                    selectedWorktreeId={worktreeId}
                    onChange={setWorktreeId}
                    worktrees={project.worktrees}
                    open={worktreePickerOpen}
                    onOpenChange={setWorktreePickerOpen}
                    helpTooltipId="start-page-source-help"
                  />
                }
              />
              <SettingsRow
                label="Add the change to a worktree"
                description="canopy.json is part of the repository, so a change goes into a worktree."
                control={
                  <AddToWorktreeActionControls
                    show
                    sourceInspectWorktreeId={worktreeId}
                    worktrees={project.worktrees}
                    feedback={addFeedback}
                    buttonLabel="Add to worktree"
                    disabled={saving || !startPageValid}
                    existingDropdownOpen={existingWorktreePickerOpen}
                    onExistingDropdownOpenChange={setExistingWorktreePickerOpen}
                    onAddToWorktree={(target) => void save(target)}
                  />
                }
              />
            </>
          ) : null}
        </ProjectSettingsScopeGroup>
        <SettingsSection title="First tab">
          <SettingsGroup>
            <StartPageSettingControl
              layout="row"
              workspaceId={project.id}
              target={
                mode === 'source' && worktreeId
                  ? { kind: 'worktree', worktreeId }
                  : { kind: 'baseline' }
              }
              projectType={project.type}
              value={value}
              onChange={changeValue}
              onValidityChange={setStartPageValid}
              allowUseTeamSetting={mode === 'local'}
            />
          </SettingsGroup>
          <ErrorBanner
            errorSource="code-start-page-settings"
            className=""
            error={error}
          />
        </SettingsSection>
      </Stack>
    );
  }

  return (
    <Stack gap="group">
      <Stack gap="group">
        <SourceLocalToggle mode={mode} onChange={setMode} />
        <SettingsGroup>
          <StartPageSettingControl
            layout="row"
            workspaceId={project.id}
            target={
              mode === 'source' && worktreeId
                ? { kind: 'worktree', worktreeId }
                : { kind: 'baseline' }
            }
            projectType={project.type}
            value={value}
            onChange={changeValue}
            onValidityChange={setStartPageValid}
            allowUseTeamSetting={mode === 'local'}
          />
        </SettingsGroup>
      </Stack>
      <ErrorBanner
        errorSource="code-start-page-settings"
        className=""
        error={error}
      />
      <div
        className={`flex items-center ${mode === 'source' ? 'justify-between' : 'justify-end'}`}
      >
        {mode === 'source' && (
          <SourceWorktreePicker
            selectedWorktreeId={worktreeId}
            onChange={setWorktreeId}
            worktrees={project.worktrees}
            open={worktreePickerOpen}
            onOpenChange={setWorktreePickerOpen}
            helpTooltipId="start-page-source-help"
          />
        )}
        {mode === 'source' ? (
          <AddToWorktreeActionControls
            show
            sourceInspectWorktreeId={worktreeId}
            worktrees={project.worktrees}
            feedback={addFeedback}
            buttonLabel="Add to worktree"
            disabled={saving || !startPageValid}
            existingDropdownOpen={existingWorktreePickerOpen}
            onExistingDropdownOpenChange={setExistingWorktreePickerOpen}
            onAddToWorktree={(target) => void save(target)}
          />
        ) : (
          <SaveLocalButton
            disabled={saving || !startPageValid}
            isSaving={saving}
            onClick={() => void save()}
          />
        )}
      </div>
    </Stack>
  );
}
