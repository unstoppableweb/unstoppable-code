import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import {
  Surface,
  Stack,
  Button,
  FormField,
  CopyDetailsButton,
  Heading,
  Notice,
  type SettingsSaveState,
} from '@canopy/ui-shared/components';
import { ArrowUpRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ErrorState } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  EnvironmentConfigView,
  EnvironmentDefinitionView,
  EnvironmentRuntime,
  WorkspaceEnvironmentAssignment,
} from '@canopy/desktop-shared/types';
import { compareEnvironmentDefinitions } from '@canopy/desktop-shared/lib/user-environment';
import { useEnvironmentsStore } from '@/stores/environmentsStore';
import { EnvironmentRuntimeSelect } from '@/components/environments/EnvironmentRuntimeSelect';
import { brandText } from '@/lib/brand';

const RUNTIMES: EnvironmentRuntime[] = ['canopy', 'agent', 'pipeline'];

const RUNTIME_META: Record<
  EnvironmentRuntime,
  { label: string; helper: string }
> = {
  canopy: {
    label: `${brandText.shortName} Runtime`,
    helper:
      'Project scripts, hooks, terminals, setup, launch, and background processes.',
  },
  agent: {
    label: 'Agent runtime',
    helper: 'Interactive agent sessions and helper agents.',
  },
  pipeline: {
    label: 'Workflow runtime',
    helper: 'Workflow runs and agent steps launched inside workflows.',
  },
};

export interface WorkspaceEnvironmentTabProps {
  workspaceId: string;
  workspaceName: string;
  workspaceKind?: 'code' | 'cowork';
  onManageEnvironments: () => void;
  /**
   * `panel` is the modal tab with its own Save button. `settings` is a page
   * of grouped rows where each choice saves as it is made.
   */
  layout?: 'panel' | 'settings';
  /** Reports each save, for a page that shows one save line. */
  onSaveStateChange?: (state: SettingsSaveState) => void;
  /**
   * Whether a choice is waiting and cannot be written now: a failed save,
   * or one held while secure storage waits for Retry.
   */
  onUnsavedChange?: (unsaved: boolean) => void;
  /**
   * Gives the page a function that waits for running saves and resolves
   * false when the last one failed with a choice still waiting, so closing
   * the page can wait for it. Called with null on unmount.
   */
  onRegisterFlush?: (flush: (() => Promise<boolean>) | null) => void;
}

/** Settings-page copy: "workflow" in the interface, never "pipeline". */
const SETTINGS_RUNTIME_LABELS: Record<EnvironmentRuntime, string> = {
  canopy: `${brandText.shortName} runtime`,
  agent: 'Agent runtime',
  pipeline: 'Workflow runtime',
};

function settingsRuntimeHelper(
  runtime: EnvironmentRuntime,
  workspaceKind: 'code' | 'cowork',
): string {
  if (runtime === 'pipeline') {
    return 'Workflow runs and the agent steps inside them.';
  }
  if (runtime === 'canopy' && workspaceKind === 'code') {
    return 'Scripts, hooks, terminals and background processes.';
  }
  return runtimeHelper(runtime, workspaceKind);
}

function runtimeHelper(
  runtime: EnvironmentRuntime,
  workspaceKind: 'code' | 'cowork',
): string {
  if (runtime === 'canopy' && workspaceKind === 'cowork') {
    return 'Project terminals, setup, and background processes.';
  }
  return RUNTIME_META[runtime].helper;
}

function findAssignment(
  data: EnvironmentConfigView,
  workspaceId: string,
): WorkspaceEnvironmentAssignment | undefined {
  return data.workspaceAssignments.find(
    (assignment) => assignment.workspaceId === workspaceId,
  );
}

function getEffectiveEnvironmentId(
  data: EnvironmentConfigView,
  assignment: WorkspaceEnvironmentAssignment | undefined,
  runtime: EnvironmentRuntime,
): string | null {
  const override = assignment?.runtimes[runtime];
  if (override === undefined) return null;
  return override ?? null;
}

function getFallbackEnvironment(
  data: EnvironmentConfigView,
  runtime: EnvironmentRuntime,
): EnvironmentDefinitionView | undefined {
  const globalId = data.globalRuntimes[runtime];
  if (!globalId) return undefined;
  return data.environments.find((environment) => environment.id === globalId);
}

function sortEnvironments(
  environments: ReadonlyArray<EnvironmentDefinitionView>,
): EnvironmentDefinitionView[] {
  return [...environments].sort(compareEnvironmentDefinitions);
}

/**
 * Shared assignment tab rendered by both single-repo
 * (`ProjectSettingsModal`) and multi-repo (`WorkspaceSettingsModal`)
 * settings modals. Selecting a runtime's "Global default (...)" option
 * removes the per-runtime key; clearing all three drops the workspace
 * entry entirely so the global default is the single source of truth.
 */
export function WorkspaceEnvironmentTab({
  workspaceId,
  workspaceName,
  workspaceKind = 'code',
  onManageEnvironments,
  layout = 'panel',
  onSaveStateChange,
  onUnsavedChange,
  onRegisterFlush,
}: WorkspaceEnvironmentTabProps): JSX.Element {
  const data = useEnvironmentsStore((s) => s.data);
  const status = useEnvironmentsStore((s) => s.status);
  const secureStorageFailure = useEnvironmentsStore(
    (s) => s.secureStorageFailure,
  );
  const pendingSave = useEnvironmentsStore((s) => s.pendingSave);
  const retryStorageFailure = useEnvironmentsStore(
    (s) => s.retryStorageFailure,
  );
  const load = useEnvironmentsStore((s) => s.load);
  const saveWorkspaceAssignments = useEnvironmentsStore(
    (s) => s.saveWorkspaceAssignments,
  );

  const [pendingOverrides, setPendingOverrides] = useState<
    Partial<Record<EnvironmentRuntime, string | null>>
  >({});
  const pendingOverridesRef = useRef(pendingOverrides);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  // The raw save failure, offered through Copy details and never shown.
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  onSaveStateChangeRef.current = onSaveStateChange;
  const handleSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // The save running now (a follow-up replaces it), and whether the last
  // save failed.
  const savingRef = useRef<Promise<void> | null>(null);
  const lastSaveFailedRef = useRef(false);
  const runSave = useCallback((): Promise<void> => {
    const run = handleSaveRef.current();
    savingRef.current = run;
    void run.finally(() => {
      if (savingRef.current === run) savingRef.current = null;
    });
    return run;
  }, []);
  const onRegisterFlushRef = useRef(onRegisterFlush);
  onRegisterFlushRef.current = onRegisterFlush;
  useEffect(() => {
    const flush = async (): Promise<boolean> => {
      for (;;) {
        while (savingRef.current !== null) await savingRef.current;
        const waiting = Object.keys(pendingOverridesRef.current).length > 0;
        if (!waiting) return true;
        if (lastSaveFailedRef.current) return false;
        // A choice made during the last save: write it now rather than
        // leave it to an autosave that may not run before the page closes.
        // One held for secure storage Retry is reported through
        // onUnsavedChange instead.
        const store = useEnvironmentsStore.getState();
        if (store.secureStorageFailure !== null || store.pendingSave !== null) {
          return true;
        }
        const before = pendingOverridesRef.current;
        await runSave();
        // Nothing could be written (no loaded config): do not spin.
        if (pendingOverridesRef.current === before) return false;
      }
    };
    onRegisterFlushRef.current?.(flush);
    return (): void => onRegisterFlushRef.current?.(null);
  }, [runSave]);

  useEffect(() => {
    if (status === 'idle') {
      void load();
    }
  }, [load, status]);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const assignment = useMemo(
    () => (data ? findAssignment(data, workspaceId) : undefined),
    [data, workspaceId],
  );

  // Only a different workspace invalidates all local overrides.
  useEffect(() => {
    pendingOverridesRef.current = {};
    setPendingOverrides({});
    setSaveStatus('idle');
    setSaveError(null);
  }, [workspaceId]);

  useEffect(() => {
    const remaining = { ...pendingOverridesRef.current };
    for (const runtime of RUNTIMES) {
      if (
        runtime in remaining &&
        remaining[runtime] === (assignment?.runtimes[runtime] ?? null)
      ) {
        delete remaining[runtime];
      }
    }
    pendingOverridesRef.current = remaining;
    setPendingOverrides(remaining);
  }, [assignment]);

  const sortedEnvironments = useMemo(
    () => (data ? sortEnvironments(data.environments) : []),
    [data],
  );

  const dirty = Object.keys(pendingOverrides).length > 0;

  const resolveValue = useCallback(
    (runtime: EnvironmentRuntime): string | null => {
      if (runtime in pendingOverrides) {
        return pendingOverrides[runtime] ?? null;
      }
      if (!data) return null;
      return getEffectiveEnvironmentId(data, assignment, runtime);
    },
    [assignment, data, pendingOverrides],
  );

  const handleChange = useCallback(
    (runtime: EnvironmentRuntime, nextId: string | null): void => {
      pendingOverridesRef.current = {
        ...pendingOverridesRef.current,
        [runtime]: nextId,
      };
      setPendingOverrides((current) => ({
        ...current,
        [runtime]: nextId,
      }));
    },
    [],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!data) return;
    // The choices this save writes. A choice made meanwhile stays pending
    // and is written by the next save.
    const writing = pendingOverridesRef.current;
    setSaveStatus('saving');
    setSaveError(null);

    try {
      const response = await window.api.loadEnvironmentConfig();
      if (!('data' in response)) {
        useEnvironmentsStore.setState({
          status: 'error',
          error: response.error,
          secureStorageFailure: response.secureStorageFailure ?? null,
          storageFailureAction: 'load',
        });
        throw new Error(response.error);
      }
      const persisted = response.data;
      const persistedAssignment = findAssignment(persisted, workspaceId);
      // Merge persisted runtimes with pending overrides into the canonical
      // "what should be saved" map. `null` removes the runtime from the
      // assignment.
      const mergedRuntimes: Partial<Record<EnvironmentRuntime, string | null>> =
        {
          ...persistedAssignment?.runtimes,
        };
      for (const runtime of RUNTIMES) {
        if (runtime in writing) {
          const next = writing[runtime] ?? null;
          if (next === null) {
            delete mergedRuntimes[runtime];
          } else {
            mergedRuntimes[runtime] = next;
          }
        }
      }

      const filteredRuntimes: Partial<
        WorkspaceEnvironmentAssignment['runtimes']
      > = {};
      for (const runtime of RUNTIMES) {
        const value = mergedRuntimes[runtime];
        if (value !== undefined && value !== null) {
          filteredRuntimes[runtime] = value;
        }
      }
      const keepEntry = Object.keys(filteredRuntimes).length > 0;
      const now = new Date().toISOString();
      const nextWorkspaceAssignments = persisted.workspaceAssignments.filter(
        (existing) => existing.workspaceId !== workspaceId,
      );
      if (keepEntry) {
        nextWorkspaceAssignments.push({
          workspaceId,
          runtimes: filteredRuntimes,
          updatedAt: now,
        });
      }
      const nextConfig: EnvironmentConfigView = {
        ...persisted,
        workspaceAssignments: nextWorkspaceAssignments,
      };
      await saveWorkspaceAssignments(nextConfig);
      const remaining = { ...pendingOverridesRef.current };
      for (const runtime of RUNTIMES) {
        if (runtime in writing && remaining[runtime] === writing[runtime]) {
          delete remaining[runtime];
        }
      }
      pendingOverridesRef.current = remaining;
      setPendingOverrides(remaining);
      lastSaveFailedRef.current = false;
      const queued = Object.keys(remaining).length > 0;
      if (!mountedRef.current) {
        // The page moved on while this save ran: nothing else will pick up a
        // choice made meanwhile, so write it now and report to the page.
        // Only where choices save as they are made; with a Save button, a
        // choice the user never saved is dropped on leaving, as before.
        const store = useEnvironmentsStore.getState();
        if (
          queued &&
          layoutRef.current === 'settings' &&
          store.secureStorageFailure === null &&
          store.pendingSave === null
        ) {
          void runSave();
          return;
        }
        onSaveStateChangeRef.current?.(queued ? 'idle' : 'saved');
        return;
      }
      setSaveStatus(queued ? 'idle' : 'saved');
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => {
        savedTimerRef.current = null;
        setSaveStatus((current) => (current === 'saved' ? 'idle' : current));
      }, 1500);
    } catch (err) {
      lastSaveFailedRef.current = true;
      if (!mountedRef.current) onSaveStateChangeRef.current?.('error');
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : null);
    }
  }, [data, runSave, saveWorkspaceAssignments, workspaceId]);
  handleSaveRef.current = handleSave;

  // On a settings page each choice saves as it is made. A failed save keeps
  // the choice pending until the next change, so it does not retry in a loop.
  // While a failed environment save waits for Retry, the choice stays
  // pending: writing assignments then would replace the waiting save and
  // drop the environment it holds. It saves once Retry clears the failure.
  const storageBlocked = secureStorageFailure !== null || pendingSave !== null;
  const autosaveRef = useRef({ handleSave, saving: false });
  autosaveRef.current = { handleSave, saving: saveStatus === 'saving' };
  useEffect(() => {
    if (layout !== 'settings' || storageBlocked) return;
    if (Object.keys(pendingOverrides).length === 0) return;
    if (autosaveRef.current.saving) return;
    void runSave();
  }, [layout, pendingOverrides, runSave, storageBlocked]);

  useEffect(() => {
    onSaveStateChangeRef.current?.(saveStatus === 'idle' ? 'idle' : saveStatus);
  }, [saveStatus]);

  const unsaved =
    Object.keys(pendingOverrides).length > 0 &&
    (storageBlocked || saveStatus === 'error');
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  onUnsavedChangeRef.current = onUnsavedChange;
  useEffect(() => {
    onUnsavedChangeRef.current?.(unsaved);
  }, [unsaved]);
  useEffect(() => (): void => onUnsavedChangeRef.current?.(false), []);

  if (!data) {
    return (
      <div
        className="flex flex-col p-2 gap-4"
        data-testid={`workspace-environment-tab-${workspaceId}`}
      >
        {secureStorageFailure ? (
          <SecureStorageNotice
            failure={secureStorageFailure}
            retrying={status === 'loading'}
            onRetry={(): void => void load()}
          />
        ) : status === 'error' ? (
          <ErrorState
            space="panel"
            message="Couldn’t load environment assignments."
            onRetry={() => {
              void useEnvironmentsStore.getState().load();
            }}
            testId="workspace-environment-error"
            retryTestId="workspace-environment-retry"
          />
        ) : (
          <p
            className="text-s fg-secondary"
            data-testid="workspace-environment-loading"
          >
            Loading environment assignments…
          </p>
        )}
      </div>
    );
  }

  const storageNotice = (
    <SecureStorageNotice
      failure={secureStorageFailure}
      retrying={saveStatus === 'saving' || status === 'loading'}
      onRetry={(): void => {
        void retryStorageFailure()
          .then(() => {
            setSaveStatus(
              pendingSave?.kind === 'workspaceAssignments' &&
                Object.keys(pendingOverridesRef.current).length === 0
                ? 'saved'
                : 'idle',
            );
            setSaveError(null);
          })
          .catch((err: unknown) => {
            setSaveStatus('error');
            setSaveError(err instanceof Error ? err.message : null);
          });
      }}
    />
  );

  if (layout === 'settings') {
    return (
      <Stack
        gap="hero"
        data-testid={`workspace-environment-tab-${workspaceId}`}
      >
        {storageNotice}
        <SettingsSection title="Runtimes">
          <SettingsGroup>
            {RUNTIMES.map((runtime) => {
              const fallback = getFallbackEnvironment(data, runtime);
              return (
                <SettingsRow
                  key={runtime}
                  label={SETTINGS_RUNTIME_LABELS[runtime]}
                  description={settingsRuntimeHelper(runtime, workspaceKind)}
                  control={
                    <EnvironmentRuntimeSelect
                      variant="settings"
                      environments={sortedEnvironments}
                      value={resolveValue(runtime)}
                      onChange={(next) => handleChange(runtime, next)}
                      fallbackOption={{
                        id: null,
                        label: `Default (${fallback?.name ?? 'unassigned'})`,
                      }}
                      testId={`workspace-environment-${runtime}`}
                      ariaLabel={`${SETTINGS_RUNTIME_LABELS[runtime]} assignment`}
                    />
                  }
                />
              );
            })}
          </SettingsGroup>
          {saveStatus === 'error' && !secureStorageFailure && (
            <Notice
              intent="attention"
              data-testid="workspace-environment-error"
              {...(saveError === null
                ? {}
                : {
                    actions: (
                      <CopyDetailsButton
                        details={saveError}
                        data-testid="workspace-environment-error-copy-details"
                      />
                    ),
                  })}
            >
              Couldn&apos;t save environment assignments.
            </Notice>
          )}
        </SettingsSection>
        <SettingsGroup>
          <SettingsRow
            label="Environments"
            description="Add or edit Docker and remote environments in Settings."
            control={
              <Button
                size="compact"
                onClick={onManageEnvironments}
                data-testid="workspace-environment-manage"
              >
                Manage environments
                <ArrowUpRightIcon size={14} aria-hidden={true} />
              </Button>
            }
          />
        </SettingsGroup>
      </Stack>
    );
  }

  return (
    <div
      className="flex flex-col p-2 gap-4"
      data-testid={`workspace-environment-tab-${workspaceId}`}
    >
      {storageNotice}
      <Stack gap="tight">
        <Heading level={3} variant="title">
          Environment
        </Heading>
        <p className="text-xs fg-secondary">
          Assign environments for{' '}
          <span className="font-medium fg-primary">{workspaceName}</span>.
          Unassigned runtimes use the global defaults in Settings →
          Environments.
        </p>
      </Stack>

      <Stack gap="group">
        {RUNTIMES.map((runtime) => {
          const fallback = getFallbackEnvironment(data, runtime);
          const fallbackLabel = `Global default (${fallback?.name ?? 'unassigned'})`;
          return (
            <FormField
              key={runtime}
              label={RUNTIME_META[runtime].label}
              description={runtimeHelper(runtime, workspaceKind)}
            >
              <EnvironmentRuntimeSelect
                environments={sortedEnvironments}
                value={resolveValue(runtime)}
                onChange={(next) => handleChange(runtime, next)}
                fallbackOption={{ id: null, label: fallbackLabel }}
                testId={`workspace-environment-${runtime}`}
                ariaLabel={`${RUNTIME_META[runtime].label} assignment`}
              />
            </FormField>
          );
        })}
      </Stack>

      <Surface variant="section" boundary="top">
        <div className="flex items-center justify-between gap-3 pt-3">
          <Button
            size="compact"
            onClick={onManageEnvironments}
            data-testid="workspace-environment-manage"
          >
            Manage environments
          </Button>
          <div className="flex items-center justify-end gap-3">
            {saveStatus === 'saved' && (
              <span
                className="text-xs fg-secondary"
                data-testid="workspace-environment-saved"
              >
                Saved.
              </span>
            )}
            {saveStatus === 'error' && !secureStorageFailure && (
              <Notice
                intent="attention"
                data-testid="workspace-environment-error"
                {...(saveError === null
                  ? {}
                  : {
                      actions: (
                        <CopyDetailsButton
                          details={saveError}
                          data-testid="workspace-environment-error-copy-details"
                        />
                      ),
                    })}
              >
                Couldn&apos;t save environment assignments.
              </Notice>
            )}
            <Button
              variant="primary"
              size="compact"
              onClick={() => {
                void handleSave();
              }}
              disabled={!dirty || saveStatus === 'saving'}
              data-testid="workspace-environment-save"
            >
              {saveStatus === 'saving'
                ? 'Saving…'
                : 'Save environment assignments'}
            </Button>
          </div>
        </div>
      </Surface>
    </div>
  );
}
