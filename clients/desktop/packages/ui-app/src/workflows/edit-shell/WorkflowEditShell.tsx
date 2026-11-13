'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  ConfirmDialog,
  DetailActionBar,
  LoadingSpinner,
  PageHeader,
  ShareActionButton,
  TabBar,
  Tooltip,
  type ButtonVariant,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  CopyIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { UnsavedChangesDialog } from '../unsaved-changes';
import {
  WorkflowEditMoreMenu,
  type WorkflowEditMenuItem,
} from './WorkflowEditMoreMenu';
import {
  WORKFLOW_EDIT_MENU_ACTIONS,
  WORKFLOW_EDIT_SAVE_STATE_LABELS,
  WORKFLOW_EDIT_SECTION_LABELS,
  WORKFLOW_EDIT_SECTIONS,
  type WorkflowEditActionId,
  type WorkflowEditActionState,
  type WorkflowEditKind,
  type WorkflowEditPlan,
  type WorkflowEditSection,
} from './workflow-edit-model';

/** Actions with a fixed label. The toggle reads `Turn on` or `Turn off`. */
type WorkflowEditLabeledActionId = Exclude<WorkflowEditActionId, 'toggle'>;

const DEFAULT_ACTION_LABELS: Readonly<
  Record<WorkflowEditLabeledActionId, string>
> = {
  save: 'Save',
  run: 'Run',
  share: 'Share',
  duplicate: 'Duplicate',
  delete: 'Delete',
};

const DELETE_FAILED_MESSAGE = 'This could not be deleted.';

export interface WorkflowEditAssistant {
  /** The drawer is showing. */
  readonly open: boolean;
  readonly onToggle: () => void;
}

export interface WorkflowEditUnsavedPrompt {
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  /** X, Escape or a click outside. */
  readonly onKeepEditing: () => void;
}

export interface WorkflowEditShellProps {
  readonly kind: WorkflowEditKind;
  /** Plain text: the heading, the dialog title and accessible names. */
  readonly name: string;
  /** An inline rename control shown in the heading instead of `name`. */
  readonly nameEditor?: ReactNode;
  /** One line under the name saying what the item does. */
  readonly description?: string;
  /** Where Back goes, e.g. `Library`. */
  readonly backLabel: string;
  readonly onBack: () => void;
  /**
   * The page shows its own bar above the shell (a pipeline's edit view,
   * CAN-4319). Its breadcrumb is the way back and names a new item, and the
   * shell's actions render into `actionsTarget` in it, so the header leaves
   * out Back, the actions and the `New` state.
   */
  readonly pageBar?: { readonly actionsTarget: HTMLElement | null };
  readonly plan: WorkflowEditPlan;
  readonly section: WorkflowEditSection;
  readonly onSectionChange: (section: WorkflowEditSection) => void;
  /** Renders one section; called for every visited section. */
  readonly renderSection: (section: WorkflowEditSection) => ReactNode;
  /**
   * Stable identity of the edited item. Changing it resets visited sections
   * and moves focus to the heading.
   */
  readonly targetKey: string;
  /**
   * An assistant drawer beside the editor (the pipeline assistant). Shown
   * as an `Assistant` action in the bar when the host has one.
   */
  readonly assistant?: WorkflowEditAssistant;
  /** Between the header and the tabs (a failed save, a review-needed state). */
  readonly notices?: ReactNode;
  readonly onSave?: () => void;
  readonly onRun?: () => void;
  readonly onShare?: () => void;
  readonly onDuplicate?: () => void;
  /**
   * Deletes the item once the shell's confirmation is accepted. Resolve to
   * close the confirmation (the host usually leaves the item); reject with an
   * `Error` to keep it open with that message so the user can retry.
   */
  readonly onDelete?: () => Promise<void>;
  /** Whether the item is turned on. `Off` shows beside the name when not. */
  readonly enabled?: boolean;
  readonly onToggleEnabled?: (next: boolean) => void;
  /** Overrides `Save`, `Run`, `Share`, `Duplicate`, `Delete`. */
  readonly actionLabels?: Partial<Record<WorkflowEditLabeledActionId, string>>;
  /**
   * Overrides `workflow-edit-{action}`, `workflow-edit-back` and
   * `workflow-edit-name`, so an adapter keeps the test ids its specs use.
   * The delete confirmation's button takes `{delete id}-confirm`.
   */
  readonly actionTestIds?: Partial<
    Record<WorkflowEditActionId | 'back' | 'name', string>
  >;
  /** Shows a spinner and `aria-busy` on those actions. */
  readonly busyActions?: Partial<Record<WorkflowEditActionId, boolean>>;
  /** When set, the unsaved-changes prompt is open. */
  readonly unsavedPrompt?: WorkflowEditUnsavedPrompt | null;
  /**
   * `page` (default) scrolls the shell as one page. `fill` gives the section
   * the remaining height, for an editor that owns its scrolling (the pipeline
   * flow editor).
   */
  readonly layout?: 'page' | 'fill';
}

interface DeleteConfirmation {
  readonly busy: boolean;
  readonly error: string | null;
}

interface VisitedSections {
  readonly key: string;
  readonly sections: readonly WorkflowEditSection[];
}

interface ActionButtonProps {
  readonly state: WorkflowEditActionState;
  readonly label: string;
  readonly testId: string;
  readonly variant: ButtonVariant;
  readonly busy: boolean;
  readonly icon?: ReactNode;
  readonly onClick: () => void;
}

/**
 * One header action. A disabled action with a reason stays focusable
 * (`aria-disabled`) so its tooltip and description explain what to do.
 */
function WorkflowEditActionButton({
  state,
  label,
  testId,
  variant,
  busy,
  icon,
  onClick,
}: ActionButtonProps): JSX.Element {
  const explained = state.disabled && state.reason !== undefined;
  const button = (
    <Button
      variant={variant}
      size="compact"
      data-testid={testId}
      disabled={state.disabled && !explained}
      aria-disabled={explained ? true : undefined}
      aria-description={explained ? state.reason : undefined}
      aria-busy={busy || undefined}
      onClick={(event): void => {
        if (state.disabled) {
          event.preventDefault();
          return;
        }
        onClick();
      }}
    >
      {busy ? <LoadingSpinner className="shrink-0" decorative /> : icon}
      {label}
    </Button>
  );
  if (!explained) return button;
  return <Tooltip label={state.reason}>{button}</Tooltip>;
}

function useVisitedSections(
  targetKey: string,
  section: WorkflowEditSection,
): readonly WorkflowEditSection[] {
  const [visited, setVisited] = useState<VisitedSections>({
    key: targetKey,
    sections: [section],
  });
  let next = visited;
  if (visited.key !== targetKey) {
    next = { key: targetKey, sections: [section] };
  } else if (!visited.sections.includes(section)) {
    next = { key: targetKey, sections: [...visited.sections, section] };
  }
  // Adjusting state while rendering: React re-renders before committing, so
  // a newly shown section mounts in the same pass.
  if (next !== visited) setVisited(next);
  return next.sections;
}

/**
 * The one full-page editing shell for a pipeline or an automation
 * (CAN-4072): the shared page header (Back above the name, the save state,
 * the action bar and the Definition / Trigger / Runs tabs), then any notices. Visited sections stay mounted and
 * hidden, so a section's own state (undo, raw text, run paging) survives a
 * tab switch. What each action shows comes from `plan` alone.
 */

/** The ⋯ menu row's leading icon: Turn off pauses, Turn on plays. */
function workflowEditMenuIcon(
  id: (typeof WORKFLOW_EDIT_MENU_ACTIONS)[number],
  enabled: boolean,
): ReactNode {
  switch (id) {
    case 'toggle':
      return enabled ? <PauseIcon /> : <PlayIcon />;
    case 'duplicate':
      return <CopyIcon />;
    case 'delete':
      return <TrashIcon />;
  }
}

export function WorkflowEditShell({
  kind,
  name,
  nameEditor,
  description,
  backLabel,
  onBack,
  pageBar,
  plan,
  section,
  onSectionChange,
  renderSection,
  targetKey,
  assistant,
  notices,
  onSave,
  onRun,
  onShare,
  onDuplicate,
  onDelete,
  enabled = false,
  onToggleEnabled,
  actionLabels,
  actionTestIds,
  busyActions,
  unsavedPrompt = null,
  layout = 'page',
}: WorkflowEditShellProps): JSX.Element {
  const baseId = useId();
  const tabId = (id: WorkflowEditSection): string => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;
  const rootRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const visited = useVisitedSections(targetKey, section);
  const [confirmingDelete, setConfirmingDelete] =
    useState<DeleteConfirmation | null>(null);
  const [confirmingKey, setConfirmingKey] = useState(targetKey);
  // A confirmation belongs to the item it was opened on. Reset while
  // rendering, as `useVisitedSections` does, so a confirmation for the
  // previous item never paints over the next one.
  if (confirmingKey !== targetKey) {
    setConfirmingKey(targetKey);
    setConfirmingDelete(null);
  }
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Focus lands on the heading when the shell opens on an item, never on a
  // section change.
  useEffect(() => {
    headingRef.current?.focus();
  }, [targetKey]);

  // Read through a ref so the key listener binds once per mount.
  const saveRef = useRef({ state: plan.actions.save, onSave });
  saveRef.current = { state: plan.actions.save, onSave };
  useEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView ?? window;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      // An overlay (a dialog, the palette) that handled the key keeps it, and
      // so does a modal one with focus: ⌘S there must not save the item
      // behind it. A picker popover in the form is not modal and still saves.
      if (event.defaultPrevented) return;
      const { target } = event;
      if (
        target instanceof view.Element &&
        target.closest('[aria-modal="true"], [role="alertdialog"]') !== null
      ) {
        return;
      }
      if (event.key.toLowerCase() !== 's') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      const { state, onSave: save } = saveRef.current;
      // The shell owns ⌘S while its item is editable; a read-only item leaves
      // the key to the host.
      if (!state.visible) return;
      event.preventDefault();
      // A held key saves once.
      if (!state.disabled && !event.repeat) save?.();
    };
    view.addEventListener('keydown', onKeyDown);
    return (): void => view.removeEventListener('keydown', onKeyDown);
  }, []);

  const label = (id: WorkflowEditLabeledActionId): string =>
    actionLabels?.[id] ?? DEFAULT_ACTION_LABELS[id];
  const testId = (id: WorkflowEditActionId | 'back' | 'name'): string =>
    actionTestIds?.[id] ?? `workflow-edit-${id}`;
  const busy = (id: WorkflowEditActionId): boolean =>
    busyActions?.[id] === true;

  const actionButton = (
    id: 'save' | 'run' | 'duplicate',
    handler: (() => void) | undefined,
    variant: ButtonVariant,
    icon?: ReactNode,
  ): ReactNode => {
    const state = plan.actions[id];
    if (!state.visible || !handler) return null;
    return (
      <WorkflowEditActionButton
        state={state}
        label={label(id)}
        testId={testId(id)}
        variant={variant}
        busy={busy(id)}
        icon={icon}
        onClick={handler}
      />
    );
  };

  const confirmDelete = (): void => {
    if (!onDelete) return;
    setConfirmingDelete({ busy: true, error: null });
    // A host that throws instead of rejecting still lands in the error path,
    // so the busy confirmation never sticks.
    Promise.resolve()
      .then(onDelete)
      .then(
        () => {
          if (mountedRef.current) setConfirmingDelete(null);
        },
        (error: unknown) => {
          if (!mountedRef.current) return;
          setConfirmingDelete({
            busy: false,
            error:
              error instanceof Error ? error.message : DELETE_FAILED_MESSAGE,
          });
        },
      );
  };

  const menuHandlers: Readonly<
    Record<(typeof WORKFLOW_EDIT_MENU_ACTIONS)[number], (() => void) | null>
  > = {
    toggle: onToggleEnabled ? (): void => onToggleEnabled(!enabled) : null,
    // Duplicate is the primary action on a read-only item, not a menu row.
    duplicate: plan.primary === 'duplicate' ? null : (onDuplicate ?? null),
    delete: onDelete
      ? (): void => setConfirmingDelete({ busy: false, error: null })
      : null,
  };
  const menuItems: WorkflowEditMenuItem[] = [];
  for (const id of WORKFLOW_EDIT_MENU_ACTIONS) {
    const state = plan.actions[id];
    const onSelect = menuHandlers[id];
    if (!state.visible || !onSelect) continue;
    menuItems.push({
      id,
      label: id === 'toggle' ? (enabled ? 'Turn off' : 'Turn on') : label(id),
      icon: workflowEditMenuIcon(id, enabled),
      testId: testId(id),
      state,
      onSelect,
    });
  }
  const menu =
    menuItems.length > 0 ? (
      <WorkflowEditMoreMenu name={name} items={menuItems} size="compact" />
    ) : null;
  const run = actionButton(
    'run',
    onRun,
    'secondary',
    <PlayIcon size="sm" aria-hidden="true" />,
  );
  const shareState = plan.actions.share;
  const share =
    shareState.visible && onShare ? (
      <ShareActionButton
        placement="detail"
        size="compact"
        ariaLabel={actionLabels?.share ?? `Share ${name}`}
        dataTestId={testId('share')}
        disabled={shareState.disabled}
        disabledReason={shareState.reason}
        onClick={onShare}
      />
    ) : null;
  const primary =
    plan.primary === 'duplicate'
      ? actionButton('duplicate', onDuplicate, 'primary')
      : actionButton('save', onSave, 'primary');
  // A view toggle, not an action on the item: it keeps its label and holds
  // its hover look while the drawer shows (`aria-pressed`).
  const assistantToggle = assistant ? (
    <Button
      variant="secondary"
      size="compact"
      pressedHover
      aria-pressed={assistant.open}
      data-testid="workflow-edit-assistant"
      onClick={assistant.onToggle}
    >
      <ChatIcon size="sm" aria-hidden="true" />
      Assistant
    </Button>
  ) : null;
  // The menu leads the secondaries: it holds Delete, which DESIGN.md puts
  // first.
  const secondary =
    menu || assistantToggle || run ? (
      <>
        {menu}
        {assistantToggle}
        {run}
      </>
    ) : undefined;
  // Only a host that can turn the item on and off reports its state.
  const off =
    plan.actions.toggle.visible && onToggleEnabled !== undefined && !enabled;

  const saveStateLabel =
    pageBar && plan.saveState === 'new'
      ? null
      : WORKFLOW_EDIT_SAVE_STATE_LABELS[plan.saveState];
  const actionBar = (
    <DetailActionBar
      dataTestId="workflow-edit-actions"
      secondary={secondary}
      share={share ?? undefined}
      primary={primary ?? undefined}
    />
  );

  return (
    <section
      ref={rootRef}
      className={
        layout === 'fill'
          ? 'flex h-full min-h-0 w-full flex-col'
          : 'flex min-h-0 w-full flex-col'
      }
      aria-label={name}
      data-testid="workflow-edit-shell"
      data-kind={kind}
      data-readonly={plan.saveState === 'read-only' ? 'true' : 'false'}
      data-dirty={plan.dirty ? 'true' : 'false'}
    >
      <PageHeader
        className="shrink-0"
        {...(pageBar
          ? {}
          : {
              back: {
                label: backLabel,
                onClick: onBack,
                testId: testId('back'),
              },
            })}
        title={nameEditor ?? <span className={REPLAY_MASK_CLASS}>{name}</span>}
        titleTestId={testId('name')}
        headingRef={headingRef}
        description={description}
        badge={
          off || saveStateLabel !== null ? (
            <>
              {off ? (
                <span data-testid="workflow-edit-enabled-state">Off</span>
              ) : null}
              {off && saveStateLabel !== null ? (
                <span aria-hidden="true">·</span>
              ) : null}
              {saveStateLabel !== null ? (
                <span data-testid="workflow-edit-save-state">
                  {saveStateLabel}
                </span>
              ) : null}
            </>
          ) : undefined
        }
        {...(pageBar ? {} : { actions: actionBar })}
        tabs={
          <TabBar
            items={WORKFLOW_EDIT_SECTIONS.map((id) => ({
              id,
              label: WORKFLOW_EDIT_SECTION_LABELS[id],
              dataTestId: `workflow-edit-tab-${id}`,
              tabId: tabId(id),
            }))}
            value={section}
            onChange={(next): void => onSectionChange(next)}
            label={`${name} sections`}
            panelId={panelId}
            dataTestId="workflow-edit-tabs"
          />
        }
      />
      {notices ? (
        <div className="mt-4 flex shrink-0 flex-col gap-2">{notices}</div>
      ) : null}
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(section)}
        className={
          layout === 'fill' ? 'flex min-h-0 flex-1 flex-col pt-6' : 'pt-6'
        }
      >
        {WORKFLOW_EDIT_SECTIONS.filter((id) => visited.includes(id)).map(
          (id) => (
            <div
              key={id}
              data-testid={`workflow-edit-section-${id}`}
              hidden={id !== section}
              className={
                layout === 'fill' && id === section
                  ? 'flex min-h-0 flex-1 flex-col'
                  : undefined
              }
            >
              {renderSection(id)}
            </div>
          ),
        )}
      </div>
      {pageBar?.actionsTarget
        ? createPortal(actionBar, pageBar.actionsTarget)
        : null}
      {confirmingDelete ? (
        <ConfirmDialog
          title={
            <>
              Delete "<span className={REPLAY_MASK_CLASS}>{name}</span>"?
            </>
          }
          message="This cannot be undone."
          confirmLabel={label('delete')}
          busyLabel="Deleting…"
          busy={confirmingDelete.busy}
          errorMessage={confirmingDelete.error}
          destructive
          dataTestId="workflow-edit-delete-dialog"
          confirmTestId={`${testId('delete')}-confirm`}
          onCancel={(): void => setConfirmingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
      {unsavedPrompt ? (
        <UnsavedChangesDialog
          name={name}
          saving={unsavedPrompt.saving}
          onSave={unsavedPrompt.onSave}
          onDiscard={unsavedPrompt.onDiscard}
          onKeepEditing={unsavedPrompt.onKeepEditing}
        />
      ) : null}
    </section>
  );
}
