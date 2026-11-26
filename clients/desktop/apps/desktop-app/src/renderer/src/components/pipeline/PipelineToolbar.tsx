import { Surface } from '@canopy/ui-shared/components';
import {
  ShareIcon,
  SettingsIcon as AppCatalogSettingsIcon,
  RevertIcon as AppCatalogRevertIcon,
  RedoIcon as AppCatalogRedoIcon,
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { type JSX, type ReactNode } from 'react';
import { Divider, InlineTextInput } from '@canopy/ui-shared/components';
import type {
  ActivePanel,
  MainView,
  ReadView,
} from '../../hooks/usePipelineEditor';
import { Tooltip } from '@canopy/ui-shared';
import {
  Button,
  ControlButton,
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';

interface PipelineToolbarProps {
  name: string;
  onNameChange: (name: string) => void;
  activePanel: ActivePanel;
  onActivePanelChange: (panel: ActivePanel) => void;
  mainView: MainView;
  onMainViewChange: (view: MainView) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isDirty: boolean;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
  onAddJob: () => void;
  readonly?: boolean;
  /** Read-only definition detail owns its own content toggle controls. */
  readDetail?: boolean;
  readDetailView?: ReadView;
  onReadDetailViewChange?: (view: ReadView) => void;
  /**
   * When provided the toolbar renders a `Share` button. Only `source: 'user'`
   * pipelines get the entry point — bundled / project / shared pipelines are
   * either read-only or already remote.
   */
  onShare?: () => void;
  headerAction?: ReactNode;
}

export type PipelineViewModeControlsProps =
  | {
      /** A read-only definition toggles its Flow and Details views. */
      readonly mode: 'read';
      readonly view: ReadView;
      readonly onViewChange: (view: ReadView) => void;
    }
  | {
      /** An editable pipeline toggles Flow, Designer, List and Raw. */
      readonly mode: 'edit';
      readonly view: MainView;
      readonly onViewChange: (view: MainView) => void;
    };

// The Designer is every pipeline's default view (CAN-4224 phase 05). Map is
// the job graph, and YAML the raw text; their test IDs are unchanged.
const DESIGNER_OPTION = {
  value: 'designer',
  label: 'Designer',
  dataTestId: 'pipeline-mode-designer',
} as const;
const MAP_OPTION = {
  value: 'map',
  label: 'Map',
  dataTestId: 'pipeline-mode-map',
} as const;

const READ_VIEW_OPTIONS: readonly SegmentedControlOption<ReadView>[] = [
  DESIGNER_OPTION,
  MAP_OPTION,
  { value: 'details', label: 'Details', dataTestId: 'pipeline-mode-details' },
];

const EDIT_VIEW_OPTIONS: readonly SegmentedControlOption<MainView>[] = [
  DESIGNER_OPTION,
  MAP_OPTION,
  { value: 'list', label: 'List', dataTestId: 'pipeline-mode-visual' },
  { value: 'raw', label: 'YAML', dataTestId: 'pipeline-mode-raw' },
];

/** The segmented view switch: Designer/Map/Details when read-only, else Designer/Map/List/YAML. */
export function PipelineViewModeControls(
  props: PipelineViewModeControlsProps,
): JSX.Element {
  if (props.mode === 'read') {
    return (
      <SegmentedControl
        label="Workflow view"
        value={props.view}
        options={READ_VIEW_OPTIONS}
        onChange={props.onViewChange}
        width="content"
      />
    );
  }
  return (
    <SegmentedControl
      label="Workflow view"
      value={props.view}
      options={EDIT_VIEW_OPTIONS}
      onChange={props.onViewChange}
      width="content"
    />
  );
}

export interface PipelineAddJobButtonProps {
  readonly onAddJob: () => void;
}

export function PipelineAddJobButton({
  onAddJob,
}: PipelineAddJobButtonProps): JSX.Element {
  return (
    <Button size="compact" onClick={onAddJob}>
      Add job
    </Button>
  );
}

export interface PipelineSettingsToggleProps {
  /** The settings panel is open. */
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function PipelineSettingsToggle({
  open,
  onToggle,
}: PipelineSettingsToggleProps): JSX.Element {
  return (
    <Tooltip label="Workflow settings" delay="long">
      <ControlButton
        presentation="icon-toggle"
        appearance={{ pressed: open }}
        aria-pressed={open}
        aria-label="Workflow settings"
        onClick={onToggle}
        data-testid="pipeline-editor-settings-toggle"
      >
        {<AppCatalogSettingsIcon size="sm" />}
      </ControlButton>
    </Tooltip>
  );
}

export interface PipelineHistoryControlsProps {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

/** Undo and Redo, labelled with their shortcuts. */
export function PipelineHistoryControls({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: PipelineHistoryControlsProps): JSX.Element {
  const modKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  return (
    <>
      <Tooltip label={`Undo (${modKey}+Z)`}>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
        >
          <AppCatalogRevertIcon size="sm" />
        </Button>
      </Tooltip>
      <Tooltip label={`Redo (${modKey}+Shift+Z)`}>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
        >
          <AppCatalogRedoIcon size="sm" />
        </Button>
      </Tooltip>
    </>
  );
}

export function PipelineToolbar({
  name,
  onNameChange,
  activePanel,
  onActivePanelChange,
  mainView,
  onMainViewChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isDirty,
  saving,
  onSave,
  onBack,
  onAddJob,
  readonly = false,
  readDetail = false,
  readDetailView = 'designer',
  onReadDetailViewChange,
  onShare,
  headerAction,
}: PipelineToolbarProps): JSX.Element {
  return (
    <Surface variant="workflow-toolbar">
      {/* Back button */}
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        onClick={onBack}
        data-testid="pipeline-editor-back"
        aria-label="Back"
      >
        <AppCatalogChevronLeftMediumIcon size="xl" />
      </Button>

      {/* Pipeline name (inline editable, or static label when readonly) */}
      {readonly ? (
        <span className="text-s font-medium fg-primary px-1 py-0.5">
          {name || 'Untitled workflow'}
        </span>
      ) : (
        <div className="w-64 min-w-0 shrink">
          <InlineTextInput
            aria-label="Workflow name"
            value={name}
            onCommit={onNameChange}
            placeholder="Untitled workflow"
          />
        </div>
      )}

      <div className="flex-1" />

      {headerAction}

      {/* View toggles */}
      {readDetail ? (
        <PipelineViewModeControls
          mode="read"
          view={readDetailView}
          onViewChange={(view) => onReadDetailViewChange?.(view)}
        />
      ) : (
        <PipelineViewModeControls
          mode="edit"
          view={mainView}
          onViewChange={onMainViewChange}
        />
      )}

      {/* Add Job (hidden in Raw, and in the Designer until CAN-4224 phase 02) */}
      {!readonly && mainView !== 'raw' && mainView !== 'designer' && (
        <PipelineAddJobButton onAddJob={onAddJob} />
      )}

      {/* Settings toggle */}
      {!readDetail && (
        <PipelineSettingsToggle
          open={activePanel === 'settings'}
          onToggle={() =>
            onActivePanelChange(
              activePanel === 'settings' ? 'steps' : 'settings',
            )
          }
        />
      )}

      {/* Sharing is offered for any pipeline when enabled; non-user pipelines
          share a snapshot copy. */}
      {onShare && (
        <Button size="compact" onClick={onShare} data-testid="pipeline-share">
          <ShareIcon size="sm" />
          Share
        </Button>
      )}

      {!readonly && (
        <>
          <div className="flex h-5">
            <Divider orientation="vertical" />
          </div>

          {/* Undo/Redo (hidden in raw mode — textarea has native undo) */}
          {mainView !== 'raw' && (
            <PipelineHistoryControls
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={onUndo}
              onRedo={onRedo}
            />
          )}

          {/* Save */}
          <Button
            variant="primary"
            size="compact"
            onClick={onSave}
            data-testid="pipeline-save"
            disabled={!isDirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      )}
    </Surface>
  );
}
