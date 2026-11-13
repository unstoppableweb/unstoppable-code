'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MIN_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
} from '@canopy/protocol/archive-retention';
import { WORKSPACE_LABEL } from '@canopy/protocol';
import { Button } from './Button';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { DialogModal } from './DialogModal';
import { InstructionsEditor } from './InstructionsEditor';
import { Select, TextArea, TextInput } from './Field';
import { SegmentedControl } from './SegmentedControl';
import { SettingsDangerConfirmBlock } from './SettingsDangerConfirmBlock';
import { SettingsSaveStatus } from './SettingsSaveStatus';
import { ErrorBanner } from './StatusBlocks';
import { StatusLabel } from './StatusLabel';
import { SettingsRowsGroup, SettingsRowsRow } from './settings/SettingsRows';
import { WORKSPACE_COLOR_PALETTE } from './workspace-color-palette';

export { WORKSPACE_COLOR_PALETTE };

export const WORKSPACE_SCRIPT_PHASES = [
  { key: 'setup', label: 'Setup' },
  { key: 'launch', label: 'Launch' },
  { key: 'teardown', label: 'Teardown' },
] as const;

export type WorkspaceSettingsTab =
  | 'details'
  | 'claude-md'
  | 'scripts'
  | 'danger';

export interface WorkspaceSettingsValues {
  readonly defaultModelDefinitionId?: string | null;
  readonly deletionRetentionDays?: number;
  readonly name: string;
  readonly description?: string;
  readonly color?: string;
  readonly content: string;
  readonly scripts: Record<string, string>;
}

export interface WorkspaceSettingsExtraTab {
  readonly id: string;
  readonly label: string;
  readonly content:
    | ReactNode
    | ((values: WorkspaceSettingsValues) => ReactNode);
}

export interface WorkspaceSettingsContentCopy {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly placeholder?: string;
}

export interface WorkspaceSettingsDangerCopy {
  readonly title?: string;
  readonly description?: ReactNode;
  /** Shown while the removal awaits confirmation. */
  readonly confirmDescription?: ReactNode;
  readonly triggerLabel?: string;
  readonly confirmLabel?: string;
  readonly confirmInProgressLabel?: string;
}

export interface WorkspaceSettingsDialogTestIds {
  readonly defaultModel?: string;
  readonly dialog?: string;
  readonly nameInput?: string;
  readonly descriptionInput?: string;
  readonly colorSwatches?: string;
  readonly claudeMdTextarea?: string;
  readonly scriptInput?: (key: string) => string;
  readonly danger?: string;
  readonly secondaryDanger?: string;
  readonly retentionInput?: string;
  readonly error?: string;
  readonly save?: string;
  readonly saved?: string;
}

export interface WorkspaceSettingsDialogProps {
  readonly modelOptions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
  readonly modelsLoading?: boolean;
  readonly modelsError?: string;
  readonly workspaceName: string;
  readonly initialValues: WorkspaceSettingsValues;
  readonly tabs?: readonly WorkspaceSettingsTab[];
  readonly showDescription?: boolean;
  readonly tabLabels?: Partial<Record<WorkspaceSettingsTab, string>>;
  readonly claudeMdCopy?: WorkspaceSettingsContentCopy;
  readonly extraTabs?: readonly WorkspaceSettingsExtraTab[];
  /**
   * Tab to open on. Used by entry points that route straight to one tab (the
   * sidebar's `Share template` item). Ignored when it names no visible tab.
   */
  readonly initialTab?: string;
  readonly dangerCopy?: WorkspaceSettingsDangerCopy;
  readonly dangerVariant?: 'destructive' | 'warning';
  readonly secondaryDanger?: {
    copy: WorkspaceSettingsDangerCopy;
    onConfirm: () => Promise<void>;
  };
  readonly palette?: readonly string[];
  readonly scriptPhases?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
  }>;
  /** Host content after the lifecycle commands on the Scripts tab. */
  readonly scriptsAccessory?: ReactNode;
  readonly onSave: (values: WorkspaceSettingsValues) => Promise<void>;
  readonly onDelete?: () => Promise<void>;
  readonly onClose: () => void;
  readonly testIds?: WorkspaceSettingsDialogTestIds;
}

const DEFAULT_TABS: readonly WorkspaceSettingsTab[] = [
  'details',
  'claude-md',
  'scripts',
  'danger',
];

interface WorkspaceSettingsPageTab {
  readonly id: string;
  readonly label: string;
}

const TAB_LABELS: Readonly<
  Record<WorkspaceSettingsTab, WorkspaceSettingsPageTab>
> = {
  details: { id: 'details', label: 'General' },
  'claude-md': { id: 'claude-md', label: 'CLAUDE.md' },
  scripts: { id: 'scripts', label: 'Scripts' },
  // Removing lives in the last rows of General, not in a tab of its own.
  danger: { id: 'danger', label: 'Danger' },
};

function isBuiltInTabId(id: string): id is WorkspaceSettingsTab {
  return Object.prototype.hasOwnProperty.call(TAB_LABELS, id);
}

/**
 * A host's settings failure that carries a server's reason. `message` is our
 * own sentence and renders; `details` is the raw reason, which never renders
 * and is offered through `Copy details` (settings never show server text).
 * Hosts throw a plain `Error` for copy of their own, such as validation.
 */
export class WorkspaceSettingsFailure extends Error {
  readonly details: string | undefined;

  constructor(message: string, details?: string) {
    super(message);
    this.name = 'WorkspaceSettingsFailure';
    this.details = details;
  }
}

interface DialogFailure {
  readonly message: string;
  readonly details?: string;
}

function failureFrom(error: unknown, fallback: string): DialogFailure {
  const message =
    error instanceof Error && error.message.trim() ? error.message : fallback;
  return error instanceof WorkspaceSettingsFailure &&
    error.details !== undefined
    ? { message, details: error.details }
    : { message };
}

/**
 * The dialog's resting height, never more than DialogModal lets its card be
 * (min(80vh, 85dvh)), so Save stays on a short screen. The built-in pages
 * fit inside it, so switching between them does not resize the dialog.
 */
export const WORKSPACE_SETTINGS_DIALOG_MIN_HEIGHT = 'min(30rem, 80vh, 85dvh)';

export function WorkspaceSettingsDialog({
  workspaceName,
  modelOptions,
  modelsLoading = false,
  modelsError,
  initialValues,
  tabs = DEFAULT_TABS,
  showDescription = false,
  tabLabels,
  claudeMdCopy,
  extraTabs = [],
  initialTab,
  dangerCopy,
  dangerVariant,
  secondaryDanger,
  palette = WORKSPACE_COLOR_PALETTE,
  scriptPhases = WORKSPACE_SCRIPT_PHASES,
  scriptsAccessory,
  onSave,
  onDelete,
  onClose,
  testIds,
}: WorkspaceSettingsDialogProps): JSX.Element {
  const validExtraTabs = extraTabs.filter((tab) => !isBuiltInTabId(tab.id));
  const builtInTabs = tabs
    .filter((tab) => tab !== 'danger')
    .map((tab) => ({
      ...TAB_LABELS[tab],
      label: tabLabels?.[tab] ?? TAB_LABELS[tab].label,
    }));
  const visibleTabs: ReadonlyArray<WorkspaceSettingsPageTab> = [
    ...builtInTabs,
    ...validExtraTabs.map(({ id, label }) => ({ id, label })),
  ];
  // The old Danger tab now opens General, where removing lives.
  const requestedTab = initialTab === 'danger' ? 'details' : initialTab;
  const [activeTab, setActiveTab] = useState<string>(
    (requestedTab !== undefined &&
    visibleTabs.some((tab) => tab.id === requestedTab)
      ? requestedTab
      : visibleTabs[0]?.id) ?? 'details',
  );
  const idPrefix = useId();
  const nameInputId = `${idPrefix}-name`;
  const descriptionInputId = `${idPrefix}-description`;
  const retentionInputId = `${idPrefix}-retention`;
  const scriptInputIdPrefix = `${idPrefix}-script`;
  const [defaultModelDefinitionId, setDefaultModelDefinitionId] = useState(
    initialValues.defaultModelDefinitionId ?? null,
  );
  const [name, setName] = useState(initialValues.name);
  const metadataBaselineRef = useRef({
    name: initialValues.name,
    color: initialValues.color,
  });
  const nameValueRef = useRef(initialValues.name);
  const colorValueRef = useRef(initialValues.color);
  const nameDirtyRef = useRef(false);
  const colorDirtyRef = useRef(false);
  const nameEditVersionRef = useRef(0);
  const colorEditVersionRef = useRef(0);
  const nameSavingVersionRef = useRef<number | null>(null);
  const colorSavingVersionRef = useRef<number | null>(null);
  const includeDescription =
    showDescription || initialValues.description !== undefined;
  const [description, setDescription] = useState(
    initialValues.description ?? '',
  );
  const [deletionRetentionDays, setDeletionRetentionDays] = useState(
    initialValues.deletionRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
  );
  const [secondaryConfirming, setSecondaryConfirming] = useState(false);
  const [secondaryWorking, setSecondaryWorking] = useState(false);
  const [color, setColor] = useState(initialValues.color);
  const [content, setContent] = useState(initialValues.content);
  const [scripts, setScripts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      scriptPhases.map(({ key }) => [key, initialValues.scripts[key] ?? '']),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<DialogFailure | null>(null);

  useEffect(() => {
    metadataBaselineRef.current = {
      name: initialValues.name,
      color: initialValues.color,
    };
    if (
      !nameDirtyRef.current ||
      nameValueRef.current.trim() === initialValues.name
    ) {
      nameDirtyRef.current = false;
      nameValueRef.current = initialValues.name;
      setName(initialValues.name);
    }
    if (
      !colorDirtyRef.current ||
      colorValueRef.current === initialValues.color
    ) {
      colorDirtyRef.current = false;
      colorValueRef.current = initialValues.color;
      setColor(initialValues.color);
    }
  }, [initialValues.color, initialValues.name]);

  const working = saving || deleting || secondaryWorking;
  const trimmedName = name.trim();
  const displayedRetentionDays = Number.isFinite(deletionRetentionDays)
    ? deletionRetentionDays
    : DEFAULT_ARCHIVE_RETENTION_DAYS;
  const currentValues: WorkspaceSettingsValues = {
    ...(modelOptions === undefined ? {} : { defaultModelDefinitionId }),
    name: trimmedName,
    ...(includeDescription ? { description } : {}),
    color,
    content,
    scripts,
    ...(initialValues.deletionRetentionDays !== undefined
      ? { deletionRetentionDays: displayedRetentionDays }
      : {}),
  };
  const activeExtraTab = validExtraTabs.find((tab) => tab.id === activeTab);

  // Saving deliberately does NOT close the dialog. These settings span several
  // tabs and switching tabs does not persist anything, so closing on Save made
  // every multi-tab edit a reopen-and-save-again loop. The dialog stays put and
  // confirms in place; Done is the only thing that dismisses it.
  const save = async (): Promise<void> => {
    if (working || !trimmedName) return;
    setSaving(true);
    setFailure(null);
    setJustSaved(false);
    const nameEditVersion = nameEditVersionRef.current;
    const colorEditVersion = colorEditVersionRef.current;
    nameSavingVersionRef.current = nameEditVersion;
    colorSavingVersionRef.current = colorEditVersion;
    const metadataBaseline = metadataBaselineRef.current;
    try {
      if (
        initialValues.deletionRetentionDays !== undefined &&
        (!Number.isInteger(deletionRetentionDays) ||
          deletionRetentionDays < MIN_ARCHIVE_RETENTION_DAYS ||
          deletionRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
      )
        throw new Error(
          `Enter a whole number from ${MIN_ARCHIVE_RETENTION_DAYS} to ${MAX_ARCHIVE_RETENTION_DAYS}.`,
        );
      await onSave({
        ...(modelOptions === undefined ? {} : { defaultModelDefinitionId }),
        name: trimmedName,
        ...(includeDescription ? { description } : {}),
        color,
        content,
        scripts,
        ...(initialValues.deletionRetentionDays !== undefined
          ? { deletionRetentionDays }
          : {}),
      });
      if (nameEditVersionRef.current === nameEditVersion) {
        nameDirtyRef.current = false;
        if (metadataBaselineRef.current.name !== metadataBaseline.name) {
          nameValueRef.current = metadataBaselineRef.current.name;
          setName(metadataBaselineRef.current.name);
        }
      }
      if (colorEditVersionRef.current === colorEditVersion) {
        colorDirtyRef.current = false;
        if (metadataBaselineRef.current.color !== metadataBaseline.color) {
          colorValueRef.current = metadataBaselineRef.current.color;
          setColor(metadataBaselineRef.current.color);
        }
      }
      setJustSaved(true);
    } catch (saveError: unknown) {
      setFailure(failureFrom(saveError, "Couldn't save settings."));
    } finally {
      nameSavingVersionRef.current = null;
      colorSavingVersionRef.current = null;
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!onDelete || working) return;
    setDeleting(true);
    setFailure(null);
    try {
      await onDelete();
      onClose();
    } catch (deleteError: unknown) {
      setFailure(
        failureFrom(
          deleteError,
          `Couldn't delete ${WORKSPACE_LABEL.toLowerCase()}.`,
        ),
      );
      setDeleting(false);
      setConfirming(false);
    }
  };

  const activeLabel =
    visibleTabs.find((tab) => tab.id === activeTab)?.label ?? '';
  const showManage =
    onDelete !== undefined &&
    (activeTab === 'details' ||
      (!visibleTabs.some((tab) => tab.id === 'details') &&
        activeTab === visibleTabs[0]?.id));

  const nameField = (
    <TextInput
      id={nameInputId}
      density="settings"
      value={name}
      onChange={(event) => {
        const nextName = event.target.value;
        setJustSaved(false);
        nameEditVersionRef.current += 1;
        nameValueRef.current = nextName;
        nameDirtyRef.current =
          nextName.trim() !== metadataBaselineRef.current.name ||
          (nameSavingVersionRef.current !== null &&
            nameEditVersionRef.current !== nameSavingVersionRef.current);
        setName(nextName);
      }}
      data-testid={testIds?.nameInput}
    />
  );

  // Removing is the quiet last row of General: a danger text button that
  // confirms in place, never a titled card of its own.
  const removeRows = showManage ? (
    <>
      <div data-testid={testIds?.danger}>
        <SettingsDangerConfirmBlock
          surface="row"
          title={dangerCopy?.title ?? `Delete ${WORKSPACE_LABEL.toLowerCase()}`}
          description={
            confirming
              ? (dangerCopy?.confirmDescription ?? "This can't be undone.")
              : (dangerCopy?.description ??
                `Removes it and every worktree, chat and summary it owns on the desktop.`)
          }
          triggerLabel={dangerCopy?.triggerLabel ?? 'Delete…'}
          confirmLabel={dangerCopy?.confirmLabel ?? 'Delete'}
          confirmInProgressLabel={
            dangerCopy?.confirmInProgressLabel ?? 'Deleting…'
          }
          variant={dangerVariant}
          triggerDisabled={working}
          confirming={confirming}
          onConfirmStart={() => setConfirming(true)}
          onConfirmCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
          isWorking={deleting}
        />
      </div>
      {secondaryDanger && (
        <div data-testid={testIds?.secondaryDanger}>
          <SettingsDangerConfirmBlock
            surface="row"
            title={secondaryDanger.copy.title ?? 'Delete workspace'}
            description={secondaryDanger.copy.description}
            triggerLabel={secondaryDanger.copy.triggerLabel ?? 'Delete…'}
            confirmLabel={secondaryDanger.copy.confirmLabel ?? 'Delete'}
            confirmInProgressLabel={
              secondaryDanger.copy.confirmInProgressLabel ?? 'Deleting…'
            }
            triggerDisabled={working}
            confirming={secondaryConfirming}
            onConfirmStart={() => setSecondaryConfirming(true)}
            onConfirmCancel={() => setSecondaryConfirming(false)}
            isWorking={secondaryWorking}
            onConfirm={() => {
              if (working) return;
              setSecondaryWorking(true);
              setFailure(null);
              void secondaryDanger
                .onConfirm()
                .then(onClose)
                .catch((error: unknown) => {
                  setFailure(failureFrom(error, "Couldn't delete workspace."));
                  setSecondaryConfirming(false);
                })
                .finally(() => setSecondaryWorking(false));
            }}
          />
        </div>
      )}
    </>
  ) : null;

  return (
    <DialogModal
      inset="flush"
      onClose={working ? (): void => undefined : onClose}
      closeOnBackdrop={!working}
      closeOnEscape={!working}
      title={`${WORKSPACE_LABEL} settings`}
      subtitle={workspaceName}
      maxWidth="2xl"
      minHeight={WORKSPACE_SETTINGS_DIALOG_MIN_HEIGHT}
      headerBorder={false}
      headerSpacing="tight"
      scrollableBody={false}
      dataTestId={testIds?.dialog}
    >
      {/* Pages are simple tabs under the title; a phone-width screen scrolls
          them sideways rather than wrapping. */}
      {visibleTabs.length > 1 ? (
        <div
          className="shrink-0 overflow-x-auto border-b px-6 pb-3 pt-1"
          data-testid="workspace-settings-pages"
        >
          <SegmentedControl
            semantics="tabs"
            label={`${WORKSPACE_LABEL} settings pages`}
            width="content"
            value={activeTab}
            options={visibleTabs.map((tab) => ({
              value: tab.id,
              label: tab.label,
            }))}
            onChange={(next): void => {
              setActiveTab(next);
              setConfirming(false);
              setSecondaryConfirming(false);
            }}
          />
        </div>
      ) : null}
      <div
        role="tabpanel"
        aria-label={activeLabel}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-6 py-2"
      >
        <div className="flex flex-1 flex-col gap-4">
          {activeTab === 'details' && (
            <SettingsRowsGroup surface="plain">
              <SettingsRowsRow
                label="Name"
                htmlFor={nameInputId}
                control={<span className="inline-flex w-52">{nameField}</span>}
              />
              {includeDescription && (
                <SettingsRowsRow
                  label="Description"
                  htmlFor={descriptionInputId}
                >
                  <TextArea
                    id={descriptionInputId}
                    rows={3}
                    value={description}
                    onChange={(event) => {
                      setJustSaved(false);
                      setDescription(event.target.value);
                    }}
                    data-testid={testIds?.descriptionInput}
                  />
                </SettingsRowsRow>
              )}
              <SettingsRowsRow
                label="Color"
                control={
                  <ColorSwatchPicker
                    size="compact"
                    value={color}
                    palette={palette}
                    testId={testIds?.colorSwatches}
                    label="Project color"
                    onChange={(swatch) => {
                      setJustSaved(false);
                      colorEditVersionRef.current += 1;
                      colorValueRef.current = swatch;
                      colorDirtyRef.current =
                        swatch !== metadataBaselineRef.current.color ||
                        (colorSavingVersionRef.current !== null &&
                          colorEditVersionRef.current !==
                            colorSavingVersionRef.current);
                      setColor(swatch);
                    }}
                  />
                }
              />
              {modelOptions !== undefined && (
                <SettingsRowsRow
                  label="Default model"
                  description="Used for new chats. You can choose a different model in each chat."
                  control={
                    <span className="inline-flex w-52">
                      <Select
                        aria-label="Default model"
                        value={defaultModelDefinitionId ?? ''}
                        disabled={working || modelsLoading}
                        onValueChange={(value): void => {
                          setDefaultModelDefinitionId(value || null);
                          setJustSaved(false);
                        }}
                        data-testid={testIds?.defaultModel}
                        options={[
                          {
                            value: '',
                            label: modelsLoading
                              ? 'Loading models…'
                              : 'Use account default',
                          },
                          ...(defaultModelDefinitionId !== null &&
                          !modelOptions.some(
                            (option) => option.id === defaultModelDefinitionId,
                          )
                            ? [
                                {
                                  value: defaultModelDefinitionId,
                                  label: 'Saved model unavailable',
                                  disabled: true,
                                },
                              ]
                            : []),
                          ...modelOptions.map((option) => ({
                            value: option.id,
                            label: option.label,
                            disabled: option.disabled,
                          })),
                        ]}
                      />
                    </span>
                  }
                >
                  {modelsError && (
                    <StatusLabel size="xs">{modelsError}</StatusLabel>
                  )}
                </SettingsRowsRow>
              )}
              {initialValues.deletionRetentionDays !== undefined && (
                <SettingsRowsRow
                  label="Keep deleted chats for"
                  htmlFor={retentionInputId}
                  description={`Deleted chats are kept for ${displayedRetentionDays} days, then removed. Archived chats are kept until you delete them.`}
                  control={
                    <>
                      <span className="inline-flex w-20">
                        <TextInput
                          id={retentionInputId}
                          density="settings"
                          type="number"
                          aria-label="Keep deleted chats for"
                          min={MIN_ARCHIVE_RETENTION_DAYS}
                          max={MAX_ARCHIVE_RETENTION_DAYS}
                          value={
                            Number.isNaN(deletionRetentionDays)
                              ? ''
                              : deletionRetentionDays
                          }
                          onChange={(event) => {
                            setJustSaved(false);
                            setDeletionRetentionDays(
                              event.target.valueAsNumber,
                            );
                          }}
                          data-testid={testIds?.retentionInput}
                        />
                      </span>
                      <span className="text-s fg-secondary">days</span>
                    </>
                  }
                />
              )}
              {removeRows}
            </SettingsRowsGroup>
          )}
          {activeTab === 'claude-md' && (
            // The editor fills the page, so its insets match on every side.
            <div className="my-2 flex min-h-48 flex-1 flex-col">
              <InstructionsEditor
                value={content}
                label={
                  typeof claudeMdCopy?.title === 'string'
                    ? claudeMdCopy.title
                    : 'CLAUDE.md'
                }
                onChange={(next) => {
                  setJustSaved(false);
                  setContent(next);
                }}
                spellCheck={false}
                textareaTestId={testIds?.claudeMdTextarea}
                placeholder={
                  claudeMdCopy?.placeholder ??
                  `# ${WORKSPACE_LABEL} instructions\n\nGuidance for agents working in this ${WORKSPACE_LABEL.toLowerCase()}…`
                }
              />
            </div>
          )}
          {activeTab === 'scripts' && (
            <SettingsRowsGroup surface="plain">
              {scriptPhases.map(({ key, label }) => (
                <SettingsRowsRow
                  key={key}
                  label={label}
                  htmlFor={`${scriptInputIdPrefix}-${key}`}
                  control={
                    <span className="inline-flex w-96 max-w-full">
                      <TextInput
                        id={`${scriptInputIdPrefix}-${key}`}
                        density="settings"
                        mono
                        value={scripts[key] ?? ''}
                        onChange={(event) => {
                          setJustSaved(false);
                          setScripts((previous) => ({
                            ...previous,
                            [key]: event.target.value,
                          }));
                        }}
                        spellCheck={false}
                        data-testid={testIds?.scriptInput?.(key)}
                        placeholder={`${label} command…`}
                      />
                    </span>
                  }
                />
              ))}
              {scriptsAccessory}
            </SettingsRowsGroup>
          )}
          {activeExtraTab &&
            (typeof activeExtraTab.content === 'function'
              ? activeExtraTab.content(currentValues)
              : activeExtraTab.content)}
          {activeTab !== 'details' && removeRows && (
            <SettingsRowsGroup surface="plain">{removeRows}</SettingsRowsGroup>
          )}
          <ErrorBanner
            className=""
            error={failure?.message}
            details={failure?.details}
            testId={testIds?.error}
          />
        </div>
      </div>
      {/* One action: Save writes every page at once and keeps the dialog
          open; the title bar's close button leaves. */}
      <div className="flex shrink-0 items-center justify-end gap-3 border-t px-6 py-3">
        <span className="mr-auto">
          <SettingsSaveStatus
            state={saving ? 'saving' : justSaved ? 'saved' : 'idle'}
            idleLabel={null}
            dataTestId={testIds?.saved ?? 'workspace-settings-saved'}
          />
        </span>
        <Button
          size="compact"
          variant="primary"
          onClick={() => void save()}
          disabled={working || !trimmedName}
          data-testid={testIds?.save}
        >
          Save
        </Button>
      </div>
    </DialogModal>
  );
}
