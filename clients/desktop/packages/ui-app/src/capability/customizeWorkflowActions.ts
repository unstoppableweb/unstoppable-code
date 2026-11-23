import type { CanopyCapabilities } from '@canopy/app-core';
import { meetsCapabilityRequirement } from '@canopy/app-core/gating';
import {
  alwaysAvailableReason,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import {
  WORKFLOW_MANAGE_UNAVAILABLE_REASON,
  WORKFLOW_RUN_UNAVAILABLE_HERE,
} from '../workflows/workflow-library-model';

/**
 * What a host can do from a Customize Workflows row (CAN-4845). The host
 * passes its capabilities as data and fills only the callbacks it can
 * perform; the shared row gates the rest instead of branching on the host.
 */
export interface CustomizeWorkflowActions {
  /** The host's full capabilities. */
  readonly capabilities: CanopyCapabilities;
  /** Pipelines. A returned promise keeps the row busy and rejects on failure. */
  readonly onRun?: (entry: UnifiedPluginEntry) => void | Promise<void>;
  /** Automations; rejects on failure. */
  readonly onSetEnabled?: (
    entry: UnifiedPluginEntry,
    enabled: boolean,
  ) => Promise<void>;
  /** Automations; rejects on failure. */
  readonly onRunNow?: (entry: UnifiedPluginEntry) => Promise<void>;
  readonly onEdit?: (entry: UnifiedPluginEntry) => void;
  readonly onViewRuns?: (entry: UnifiedPluginEntry) => void;
  /**
   * Resolves `null` once removed, or the error the dialog keeps showing.
   * `confirmationShown` tells, as the delete fails, whether that dialog is
   * still on screen to show and record the failure; a host that also keeps the
   * failure elsewhere records it there only once the dialog is gone.
   */
  readonly onDelete?: (
    entry: UnifiedPluginEntry,
    confirmationShown?: () => boolean,
  ) => Promise<string | null>;
  /** Reports a failed action, usually as a toast. */
  readonly onActionError?: (message: string) => void;
}

export interface CustomizeWorkflowActionState {
  readonly available: boolean;
  /** Why the action is unavailable; the disabled control's tooltip. */
  readonly reason?: string;
}

/**
 * A workflow page's Source row, from its Customize row: where it comes from
 * (Built-in, Yours, Project…) and, for a share, who shared it.
 */
export function customizeWorkflowSource(
  entry: Pick<UnifiedPluginEntry, 'sourceLabel' | 'workflow'>,
): string | undefined {
  const parts = [entry.sourceLabel, entry.workflow?.sourceText].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export interface CustomizeWorkflowAvailability {
  readonly run: CustomizeWorkflowActionState;
  readonly toggle: CustomizeWorkflowActionState;
  readonly runNow: CustomizeWorkflowActionState;
  readonly edit: CustomizeWorkflowActionState;
  readonly viewRuns: CustomizeWorkflowActionState;
  readonly delete: CustomizeWorkflowActionState;
}

const AVAILABLE: CustomizeWorkflowActionState = { available: true };

function unavailable(reason: string): CustomizeWorkflowActionState {
  return { available: false, reason };
}

const MANAGE_UNAVAILABLE = unavailable(WORKFLOW_MANAGE_UNAVAILABLE_REASON);
const RUN_UNAVAILABLE = unavailable(WORKFLOW_RUN_UNAVAILABLE_HERE);

function runState(
  entry: UnifiedPluginEntry,
  actions: CustomizeWorkflowActions,
): CustomizeWorkflowActionState {
  if (entry.kind !== 'pipeline') return RUN_UNAVAILABLE;
  if (entry.workflow?.runnable !== true) {
    return unavailable(
      entry.workflow?.runUnavailableLabel ?? WORKFLOW_RUN_UNAVAILABLE_HERE,
    );
  }
  if (
    actions.onRun === undefined ||
    !meetsCapabilityRequirement(actions.capabilities, { pipelines: 'execute' })
  ) {
    return RUN_UNAVAILABLE;
  }
  return AVAILABLE;
}

function manageState(
  actions: CustomizeWorkflowActions,
  callback: unknown,
): CustomizeWorkflowActionState {
  return actions.capabilities.workflowManagement === true &&
    callback !== undefined
    ? AVAILABLE
    : MANAGE_UNAVAILABLE;
}

/**
 * Which row controls and menu items a workflow row can use on this host, and
 * why the rest are disabled. The most specific reason wins.
 */
export function customizeWorkflowAvailability(
  entry: UnifiedPluginEntry,
  actions: CustomizeWorkflowActions,
): CustomizeWorkflowAvailability {
  const isAutomation = entry.kind === 'automation';
  if (
    entry.workflow === undefined ||
    (!isAutomation && entry.kind !== 'pipeline')
  ) {
    return {
      run: RUN_UNAVAILABLE,
      toggle: MANAGE_UNAVAILABLE,
      runNow: MANAGE_UNAVAILABLE,
      edit: MANAGE_UNAVAILABLE,
      viewRuns: MANAGE_UNAVAILABLE,
      delete: MANAGE_UNAVAILABLE,
    };
  }
  const automationsAvailable = actions.capabilities.automations === true;
  const bundledReason = alwaysAvailableReason(entry);
  return {
    run: runState(entry, actions),
    toggle:
      isAutomation &&
      entry.workflow.enabled !== undefined &&
      automationsAvailable &&
      actions.onSetEnabled !== undefined
        ? AVAILABLE
        : MANAGE_UNAVAILABLE,
    runNow:
      isAutomation && automationsAvailable && actions.onRunNow !== undefined
        ? AVAILABLE
        : MANAGE_UNAVAILABLE,
    edit: manageState(actions, actions.onEdit),
    viewRuns: manageState(actions, actions.onViewRuns),
    // A built-in workflow is never deletable, whatever the host can do.
    delete:
      bundledReason !== undefined
        ? unavailable(bundledReason)
        : entry.workflow.readonly === true &&
            manageState(actions, actions.onDelete).available
          ? unavailable('Defined in the project. Delete its file to remove it.')
          : manageState(actions, actions.onDelete),
  };
}
