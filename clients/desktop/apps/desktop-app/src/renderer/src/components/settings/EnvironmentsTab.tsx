import {
  type ChangeEvent,
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
  EnvironmentRuntimeAssignments,
  UserEnvironmentEntryView,
  UserEnvironmentUiMode,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_ENVIRONMENT_ID_SET,
  resolveEnvironmentVariables,
  validateEnvironmentConfig,
} from '@canopy/desktop-shared/lib/user-environment';
import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyStateRow,
  ErrorState,
  CopyDetailsButton,
  Notice,
  SearchField,
  SettingsButtonRow,
  SettingsSaveBar,
  FormField,
  DialogModal,
  FieldError,
} from '@canopy/ui-shared/components';
import { Tooltip } from '@canopy/ui-shared';
import {
  environmentEditorBaseline,
  useEnvironmentsStore,
} from '@/stores/environmentsStore';
import { unknownSecureStorageFailure } from '@/lib/secureStorageNotice';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { brandText } from '@/lib/brand';
import {
  EnvironmentEncryptionStatusText,
  EnvironmentEncryptionUnavailableNotice,
  EnvironmentVariableEditor,
} from '@/components/environments/EnvironmentVariableEditor';
import { EnvironmentRuntimeSelect } from '@/components/environments/EnvironmentRuntimeSelect';
import {
  EnvironmentUsageList,
  type EnvironmentUsageWorkspace,
} from '@/components/environments/EnvironmentUsageList';
import {
  ParentSelect,
  ResolvedVariablesList,
  UsageKindIndicators,
} from '@/components/environments/EnvironmentListParts';
import {
  ENVIRONMENT_RUNTIMES,
  ENVIRONMENT_RUNTIME_LABEL,
  buildUsageIndicators,
  countUsagesFor,
  descendantIds,
  isReferencedAsParent,
  isReferencedByAssignment,
  makeUntitledEnvironmentId,
  sortEnvironments,
} from '@/components/environments/environment-list-helpers';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

const PAGE_TITLE = 'Environments';
const PAGE_TEST_ID = 'settings-tab-environment';

/** The variable editor's last validation problem, kept with its environment. */
interface EditorValidation {
  readonly environmentId: string;
  readonly message: string;
}

/**
 * Settings → Environments (CAN-4269): the list of environments, and a
 * drill-in detail for one. The config saves as a whole, so one save bar
 * serves both views and edits survive moving between them.
 */
export function EnvironmentsTab(): JSX.Element {
  const data = useEnvironmentsStore((s) => s.data);
  const status = useEnvironmentsStore((s) => s.status);
  const error = useEnvironmentsStore((s) => s.error);
  const secureStorageFailure = useEnvironmentsStore(
    (s) => s.secureStorageFailure,
  );
  const pendingSave = useEnvironmentsStore((s) => s.pendingSave);
  const storageNoticeFailure =
    secureStorageFailure ??
    (pendingSave && error ? unknownSecureStorageFailure('write') : null);
  const encryptionAvailable = useEnvironmentsStore(
    (s) => s.encryptionAvailable,
  );
  const load = useEnvironmentsStore((s) => s.load);
  const save = useEnvironmentsStore((s) => s.save);
  const retryStorageFailure = useEnvironmentsStore(
    (s) => s.retryStorageFailure,
  );
  const selectEnvironment = useEnvironmentsStore((s) => s.selectEnvironment);
  const setLocal = useEnvironmentsStore((s) => s.setLocal);
  const baseline = useEnvironmentsStore((s) => s.environmentBaseline);
  const environmentSaveVersion = useEnvironmentsStore(
    (s) => s.environmentSaveVersion,
  );
  const projects = useProjectsStore((s) => s.projects);
  const openWorkspaceSettings = useNavigationStore(
    (s) => s.openWorkspaceSettings,
  );

  // The store auto-selects an environment on load, so its selection cannot
  // tell the list from the detail. The open environment is local instead.
  const [openEnvironmentId, setOpenEnvironmentId] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  // The raw save failure, offered through Copy details and never shown.
  const [saveErrorDetails, setSaveErrorDetails] = useState<string | null>(null);
  const [editorValidation, setEditorValidation] =
    useState<EditorValidation | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [globalDefaultsOpen, setGlobalDefaultsOpen] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const observedSaveVersionRef = useRef(environmentSaveVersion);

  useEffect(() => {
    if (status === 'idle') {
      void load();
    }
  }, [load, status]);

  useEffect(
    () => (): void => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (observedSaveVersionRef.current === environmentSaveVersion) return;
    observedSaveVersionRef.current = environmentSaveVersion;
    const { data: currentData, lastSavedEnvironmentData } =
      useEnvironmentsStore.getState();
    if (!lastSavedEnvironmentData) return;
    const savedBaseline = environmentEditorBaseline(lastSavedEnvironmentData);
    if (savedTimerRef.current !== null)
      window.clearTimeout(savedTimerRef.current);
    if (
      currentData &&
      environmentEditorBaseline(currentData) === savedBaseline
    ) {
      setSaveStatus('saved');
      savedTimerRef.current = window.setTimeout(() => {
        savedTimerRef.current = null;
        setSaveStatus((current) => (current === 'saved' ? 'idle' : current));
      }, 1500);
    } else {
      setSaveStatus('idle');
    }
    setSaveError(null);
    setSaveErrorDetails(null);
  }, [environmentSaveVersion]);

  const sortedEnvironments = useMemo(
    () => (data ? sortEnvironments(data.environments) : []),
    [data],
  );

  const filteredEnvironments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return sortedEnvironments;
    return sortedEnvironments.filter((environment) =>
      environment.name.toLowerCase().includes(query),
    );
  }, [searchQuery, sortedEnvironments]);

  // Derived on every render, so a reload, retry, or delete that removes the
  // open environment falls back to the list.
  const openEnvironment = useMemo<EnvironmentDefinitionView | undefined>(
    () =>
      openEnvironmentId === null
        ? undefined
        : data?.environments.find(
            (environment) => environment.id === openEnvironmentId,
          ),
    [data, openEnvironmentId],
  );

  const cycleBlockedIds = useMemo(() => {
    if (!data || !openEnvironment) return new Set<string>();
    return descendantIds(data.environments, openEnvironment.id);
  }, [data, openEnvironment]);

  const resolvedPreview = useMemo(() => {
    if (!data || !openEnvironment) return null;
    return resolveEnvironmentVariables(data, openEnvironment.id);
  }, [data, openEnvironment]);

  const resolvedSources = useMemo(() => {
    if (!data || !resolvedPreview) return new Map<string, string>();
    const map = new Map<string, string>();
    // Walk from leaf to ancestor so the closest source wins.
    const chain = [
      ...(resolvedPreview.environmentId ? [resolvedPreview.environmentId] : []),
      ...resolvedPreview.inheritedEnvironmentIds,
    ];
    for (const id of chain) {
      const environment = data.environments.find(
        (candidate) => candidate.id === id,
      );
      if (!environment) continue;
      for (const entry of environment.variables) {
        if (!map.has(entry.key)) {
          map.set(entry.key, environment.name);
        }
      }
    }
    return map;
  }, [data, resolvedPreview]);

  // Compared with the store's saved config, not a mount-time snapshot: edits
  // outlive this tab, which remounts on every Settings open.
  const dirty = useMemo(() => {
    if (!data || baseline === null) return false;
    return environmentEditorBaseline(data) !== baseline;
  }, [baseline, data]);

  // A validation problem outlives its editor: backing out of the detail
  // keeps save blocked, and the message names the environment. Reopening
  // the environment remounts the editor, which reports afresh.
  const validationEnvironment = useMemo(
    () =>
      editorValidation === null
        ? undefined
        : data?.environments.find(
            (environment) => environment.id === editorValidation.environmentId,
          ),
    [data, editorValidation],
  );
  const validationMessage =
    editorValidation === null || validationEnvironment === undefined
      ? null
      : openEnvironment?.id === validationEnvironment.id
        ? editorValidation.message
        : `${validationEnvironment.name}: ${editorValidation.message}`;

  const openDetail = useCallback(
    (id: string): void => {
      setOpenEnvironmentId(id);
      selectEnvironment(id);
    },
    [selectEnvironment],
  );

  const backToList = useCallback((): void => {
    setOpenEnvironmentId(null);
  }, []);

  const updateLocal = useCallback(
    (mutator: (current: EnvironmentConfigView) => EnvironmentConfigView) => {
      const current = useEnvironmentsStore.getState().data;
      if (!current) return;
      const next = mutator(current);
      setLocal(next);
    },
    [setLocal],
  );

  const updateOpenEnvironment = useCallback(
    (
      patch: (
        environment: EnvironmentDefinitionView,
      ) => EnvironmentDefinitionView,
    ): void => {
      if (!openEnvironment) return;
      const now = new Date().toISOString();
      updateLocal((current) => ({
        ...current,
        environments: current.environments.map((environment) =>
          environment.id === openEnvironment.id
            ? { ...patch(environment), updatedAt: now }
            : environment,
        ),
      }));
    },
    [openEnvironment, updateLocal],
  );

  const handleCreate = useCallback((): void => {
    if (!data) return;
    const now = new Date().toISOString();
    const newEnvironment: EnvironmentDefinitionView = {
      id: makeUntitledEnvironmentId(),
      name: 'Untitled environment',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value',
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    updateLocal((current) => ({
      ...current,
      environments: [...current.environments, newEnvironment],
    }));
    openDetail(newEnvironment.id);
  }, [data, openDetail, updateLocal]);

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const nextName = event.target.value;
      updateOpenEnvironment((environment) => ({
        ...environment,
        name: nextName,
      }));
    },
    [updateOpenEnvironment],
  );

  const handleParentChange = useCallback(
    (nextParentId: string | null): void => {
      updateOpenEnvironment((environment) => ({
        ...environment,
        parentId: nextParentId,
      }));
    },
    [updateOpenEnvironment],
  );

  const handleVariablesChange = useCallback(
    (entries: UserEnvironmentEntryView[]): void => {
      updateOpenEnvironment((environment) => ({
        ...environment,
        variables: entries,
      }));
    },
    [updateOpenEnvironment],
  );

  const handleUiModeChange = useCallback(
    (mode: UserEnvironmentUiMode): void => {
      updateOpenEnvironment((environment) => ({
        ...environment,
        uiMode: mode,
      }));
    },
    [updateOpenEnvironment],
  );

  const openEnvironmentIdForValidation = openEnvironment?.id;
  const handleValidationChange = useCallback(
    (message: string | null): void => {
      if (openEnvironmentIdForValidation === undefined) return;
      // An editor that mounts clean only clears its own environment's problem.
      setEditorValidation((current) =>
        message !== null
          ? { environmentId: openEnvironmentIdForValidation, message }
          : current?.environmentId === openEnvironmentIdForValidation
            ? null
            : current,
      );
    },
    [openEnvironmentIdForValidation],
  );

  const handleGlobalRuntimeChange = useCallback(
    (runtime: EnvironmentRuntime, nextId: string | null): void => {
      if (nextId === null) return;
      updateLocal((current) => {
        const globalRuntimes: EnvironmentRuntimeAssignments = {
          ...current.globalRuntimes,
          [runtime]: nextId,
        };
        return {
          ...current,
          globalRuntimes,
        };
      });
    },
    [updateLocal],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!data) return;
    const validation = validateEnvironmentConfig(data);
    if (!validation.ok) {
      setSaveStatus('error');
      setSaveError(validation.message);
      setSaveErrorDetails(null);
      return;
    }
    setSaveStatus('saving');
    setSaveError(null);
    setSaveErrorDetails(null);
    try {
      await save(data);
    } catch (err) {
      setSaveStatus('error');
      setSaveErrorDetails(err instanceof Error ? err.message : null);
    }
  }, [data, save]);

  const handleRetry = useCallback((): void => {
    void load();
  }, [load]);

  const confirmDelete = useCallback((): void => {
    if (!pendingDeleteId) return;
    updateLocal((current) => ({
      ...current,
      environments: current.environments.filter(
        (environment) => environment.id !== pendingDeleteId,
      ),
      workspaceAssignments: current.workspaceAssignments.map((assignment) => {
        const nextRuntimes = { ...assignment.runtimes };
        for (const runtime of ENVIRONMENT_RUNTIMES) {
          if (nextRuntimes[runtime] === pendingDeleteId) {
            delete nextRuntimes[runtime];
          }
        }
        return { ...assignment, runtimes: nextRuntimes };
      }),
    }));
    selectEnvironment(null);
    setOpenEnvironmentId(null);
    setPendingDeleteId(null);
  }, [pendingDeleteId, selectEnvironment, updateLocal]);

  const deleteBlockedReason = useMemo(() => {
    if (!openEnvironment || !data) return null;
    if (
      DEFAULT_ENVIRONMENT_ID_SET.has(openEnvironment.id) ||
      openEnvironment.isDefault
    ) {
      return 'Default environments cannot be deleted.';
    }
    if (isReferencedByAssignment(data, openEnvironment.id)) {
      return 'Assigned environments cannot be deleted. Remove its runtime assignments first.';
    }
    if (isReferencedAsParent(data, openEnvironment.id)) {
      return 'Parent environments cannot be deleted while another environment inherits from them.';
    }
    return null;
  }, [data, openEnvironment]);

  const workspaceList = useMemo<EnvironmentUsageWorkspace[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: getWorkspaceDisplayName(project),
        workspaceKind: project.type === 'cowork' ? 'cowork' : 'code',
      })),
    [projects],
  );

  const handleOpenWorkspaceSettings = useCallback(
    (workspaceId: string): void => {
      // The project dialog would open behind the Settings overlay.
      useNavigationStore.getState().closeSettings();
      openWorkspaceSettings({ workspaceId, initialTab: 'environment' });
    },
    [openWorkspaceSettings],
  );

  const storageNotice = (
    <SecureStorageNotice
      failure={storageNoticeFailure}
      retrying={status === 'saving' || status === 'loading'}
      onRetry={(): void => {
        setSaveStatus('idle');
        setSaveError(null);
        setSaveErrorDetails(null);
        void retryStorageFailure().catch((err: unknown) => {
          setSaveStatus('error');
          setSaveErrorDetails(err instanceof Error ? err.message : null);
        });
      }}
    />
  );

  if (!data) {
    return (
      <SettingsPage title={PAGE_TITLE} dataTestId={PAGE_TEST_ID}>
        {secureStorageFailure ? (
          storageNotice
        ) : status === 'error' ? (
          <ErrorState
            message={
              <span data-testid="environments-error">
                Couldn't load environments.{error ? ` ${error}` : ''}
              </span>
            }
            onRetry={handleRetry}
            retryTestId="environments-retry"
          />
        ) : (
          <SettingsLoading dataTestId="environments-loading" />
        )}
      </SettingsPage>
    );
  }

  const saveBar = (
    <SettingsSaveBar
      dataTestId="environments-save-bar"
      status={
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <span data-testid="environments-unsaved">Unsaved changes</span>
          )}
          {validationMessage !== null && (
            <FieldError
              id="environments-validation"
              data-testid="environments-validation"
            >
              {validationMessage}
            </FieldError>
          )}
        </div>
      }
      actions={
        <>
          {saveStatus === 'saved' && (
            <span
              className="text-xs fg-secondary"
              data-testid="environments-save-status"
            >
              Saved.
            </span>
          )}
          {saveStatus === 'error' && !storageNoticeFailure && (
            <Notice
              intent="attention"
              data-testid="environments-save-error"
              {...(saveErrorDetails === null
                ? {}
                : {
                    actions: (
                      <CopyDetailsButton
                        details={saveErrorDetails}
                        data-testid="environments-save-error-copy-details"
                      />
                    ),
                  })}
            >
              {saveError ?? "Couldn't save environment changes."}
            </Notice>
          )}
          <Button
            size="compact"
            variant="primary"
            onClick={() => {
              void handleSave();
            }}
            disabled={
              saveStatus === 'saving' ||
              validationMessage !== null ||
              status === 'loading'
            }
            data-testid="environments-save"
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    />
  );

  const modals = (
    <>
      {globalDefaultsOpen && (
        <DialogModal
          onClose={() => setGlobalDefaultsOpen(false)}
          title="Global runtime defaults"
          subtitle="Used when a project does not assign its own environment."
          maxWidth="md"
          dataTestId="environments-global-defaults-modal"
          footer={
            <Button
              size="compact"
              variant="secondary"
              onClick={() => setGlobalDefaultsOpen(false)}
              data-testid="environments-global-defaults-close"
            >
              Done
            </Button>
          }
        >
          <div
            className="flex flex-col gap-4"
            data-testid="environments-global-runtimes"
          >
            {ENVIRONMENT_RUNTIMES.map((runtime) => (
              <FormField
                key={runtime}
                label={ENVIRONMENT_RUNTIME_LABEL[runtime]}
              >
                <EnvironmentRuntimeSelect
                  variant="settings"
                  environments={sortedEnvironments}
                  value={data.globalRuntimes[runtime]}
                  onChange={(next) => handleGlobalRuntimeChange(runtime, next)}
                  testId={`environments-global-runtime-${runtime}`}
                  ariaLabel={`${ENVIRONMENT_RUNTIME_LABEL[runtime]} global default`}
                />
              </FormField>
            ))}
          </div>
        </DialogModal>
      )}
      {pendingDeleteId && openEnvironment && (
        <ConfirmDialog
          title={`Delete environment “${openEnvironment.name}”?`}
          message="This cannot be undone."
          confirmLabel="Delete environment"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setPendingDeleteId(null)}
          confirmTestId="environments-delete-confirm"
          cancelTestId="environments-delete-cancel"
        />
      )}
    </>
  );

  if (openEnvironment) {
    return (
      <SettingsPage
        title={openEnvironment.name}
        back={{ label: PAGE_TITLE, onClick: backToList }}
        dataTestId={PAGE_TEST_ID}
      >
        {storageNotice}
        <SettingsGroup dataTestId="environments-detail">
          <SettingsRow
            label="Name"
            htmlFor="environments-name"
            control={
              <SettingsTextField
                id="environments-name"
                width="md"
                value={openEnvironment.name}
                onChange={handleNameChange}
                data-testid="environments-name-input"
              />
            }
          />
          <SettingsRow
            label="Inherits from"
            htmlFor="environments-parent"
            control={
              <ParentSelect
                id="environments-parent"
                environments={data.environments}
                blockedIds={cycleBlockedIds}
                currentId={openEnvironment.id}
                value={openEnvironment.parentId}
                onChange={handleParentChange}
              />
            }
          />
        </SettingsGroup>

        <SettingsSection
          title="Environment variables"
          description={
            !secureStorageFailure && encryptionAvailable ? (
              <EnvironmentEncryptionStatusText />
            ) : undefined
          }
        >
          {!secureStorageFailure && !encryptionAvailable ? (
            <EnvironmentEncryptionUnavailableNotice />
          ) : null}
          {/* The editor sits in the section's settings group, like the
              Name and Inherits from rows above; its status line is the
              section description, outside the card. */}
          <SettingsGroup dataTestId="environments-variables-group">
            <EnvironmentVariableEditor
              encryptionStatus="host"
              key={openEnvironment.id}
              variables={openEnvironment.variables}
              uiMode={openEnvironment.uiMode}
              encryptionAvailable={encryptionAvailable}
              storageFailure={secureStorageFailure}
              onVariablesChange={handleVariablesChange}
              onUiModeChange={handleUiModeChange}
              onValidationChange={handleValidationChange}
              testId="environments-variable-editor"
            />
          </SettingsGroup>
        </SettingsSection>

        <SettingsSection
          title="Resolved variables"
          description="Inherited values are applied first. This environment overrides matching keys."
        >
          <ResolvedVariablesList
            resolved={resolvedPreview}
            sources={resolvedSources}
          />
        </SettingsSection>

        <SettingsSection title="Usage">
          <EnvironmentUsageList
            environmentId={openEnvironment.id}
            config={data}
            workspaces={workspaceList}
            onSelectEnvironment={openDetail}
            onOpenGlobalDefaults={() => setGlobalDefaultsOpen(true)}
            onOpenWorkspaceSettings={handleOpenWorkspaceSettings}
          />
        </SettingsSection>

        <SettingsGroup>
          <SettingsRow
            label="Delete environment"
            description={
              deleteBlockedReason !== null ? (
                <span data-testid="environments-delete-blocked-reason">
                  {deleteBlockedReason}
                </span>
              ) : (
                'Removes the environment and its variables.'
              )
            }
            control={
              <Tooltip
                label={deleteBlockedReason}
                suppressed={deleteBlockedReason === null}
              >
                <Button
                  size="compact"
                  variant="destructive"
                  onClick={() => setPendingDeleteId(openEnvironment.id)}
                  disabled={deleteBlockedReason !== null}
                  data-testid="environments-delete"
                >
                  Delete
                </Button>
              </Tooltip>
            }
          />
        </SettingsGroup>

        {saveBar}
        {modals}
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={PAGE_TITLE}
      description={
        <>
          Manage environment variables and assign them to {brandText.shortName},
          Agent, and Workflow runtimes.
        </>
      }
      dataTestId={PAGE_TEST_ID}
      headerTrailing={
        <>
          <Button
            size="compact"
            variant="secondary"
            onClick={() => setGlobalDefaultsOpen(true)}
            data-testid="environments-open-global-defaults"
          >
            Global runtime defaults
          </Button>
          <Button
            size="compact"
            variant="primary"
            onClick={handleCreate}
            data-testid="environments-new-environment"
          >
            New environment
          </Button>
        </>
      }
    >
      {storageNotice}
      <SettingsSection>
        {/* A settings list's search: the 28px field, filling the column. */}
        <SearchField
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search environments"
          aria-label="Search environments"
          data-testid="environments-search"
          className="w-full"
        />
        <SettingsGroup dataTestId="environments-list">
          {data.environments.length === 0 ? (
            <EmptyStateRow
              testId="environments-list-empty"
              title="No environments yet"
            />
          ) : filteredEnvironments.length === 0 ? (
            <EmptyStateRow
              testId="environments-list-no-matches"
              title="No environments match your search."
            />
          ) : (
            filteredEnvironments.map((environment) => (
              <EnvironmentListRow
                key={environment.id}
                environment={environment}
                config={data}
                workspaces={workspaceList}
                onOpen={openDetail}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      {saveBar}
      {modals}
    </SettingsPage>
  );
}

interface EnvironmentListRowProps {
  environment: EnvironmentDefinitionView;
  config: EnvironmentConfigView;
  workspaces: ReadonlyArray<EnvironmentUsageWorkspace>;
  onOpen: (id: string) => void;
}

/** One environment in the list. The whole row opens its detail. */
function EnvironmentListRow({
  environment,
  config,
  workspaces,
  onOpen,
}: EnvironmentListRowProps): JSX.Element {
  const usageCount = countUsagesFor(config, environment.id);
  const indicators = buildUsageIndicators(config, environment.id, workspaces);
  const parent = config.environments.find(
    (candidate) => candidate.id === environment.parentId,
  );
  return (
    <SettingsButtonRow
      trailing="open"
      onClick={() => onOpen(environment.id)}
      data-testid={`environments-list-row-${environment.id}`}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{environment.name}</span>
          {environment.isDefault && <Badge>Default</Badge>}
        </span>
      }
      description={parent ? `Inherits ${parent.name}` : undefined}
      meta={
        <>
          <UsageKindIndicators
            environmentId={environment.id}
            indicators={indicators}
          />
          <span className="text-xs fg-secondary">
            {usageCount} {usageCount === 1 ? 'use' : 'uses'}
          </span>
        </>
      }
    />
  );
}
