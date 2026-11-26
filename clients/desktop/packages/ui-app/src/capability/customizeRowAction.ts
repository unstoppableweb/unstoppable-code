import type {
  CustomizeRowSplitAction,
  CustomizeRowSplitStatus,
  InstalledItemSetStatus,
} from '@canopy/ui-shared/components';
import {
  INSTALLED_ITEM_STATUS_COPY,
  installedItemTargetKey,
  type InstalledEntryStatusState,
} from '@canopy/ui-shared/lib/installed-item-status';
import type {
  InstalledItemStatus,
  InstalledItemTarget,
} from '@canopy/protocol/installed-items';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import type { CustomizeWorkflowAvailability } from './customizeWorkflowActions';

/**
 * New Customize's one row action (CAN-6813): which state a row's split
 * control shows and what its main segment runs. Every action here is one the
 * row already offered; the caret adds the row's existing ⋯ menu items. The
 * control always shows the item's real state (Sergii's QA, item 4): a
 * pending sign-in or an update is said on the row's own lines instead.
 */

/** A listing's status, as the row's status slot read it before. */
export interface CustomizeRowActionStatus {
  readonly listing: UnifiedPluginEntry;
  /** The marketplace provider, when a grouped row has several listings. */
  readonly provider?: string;
  readonly state: InstalledEntryStatusState;
}

export interface CustomizeRowActionInput {
  readonly entry: UnifiedPluginEntry;
  /** A Workflows row's controls: an automation's switch or a pipeline's Run. */
  readonly workflow?: {
    readonly availability: CustomizeWorkflowAvailability;
    readonly busy: boolean;
    readonly onRun: () => void;
    readonly onToggle: () => void;
  };
  /** A skill inside a plugin: its plugin's status, which it cannot change. */
  readonly bundledSkill?: {
    readonly state: InstalledEntryStatusState | undefined;
    readonly reason: string;
  };
  /** A Browse row installed through a plugin, with the way to open it. */
  readonly installedVia?: {
    readonly pluginName: string;
    readonly open: (() => void) | undefined;
  };
  /** Browse and not installed: the host's install flow, when it has one. */
  readonly add?: (listing: UnifiedPluginEntry) => void;
  readonly installed: boolean;
  readonly statuses: readonly CustomizeRowActionStatus[];
  readonly pendingKeys: ReadonlySet<string>;
  readonly onSetStatus?: InstalledItemSetStatus;
  readonly onError?: (message: string) => void;
  /**
   * New Customize: a status change's outcome for this row alone, so its
   * failure shows on the tile instead of `onError`'s page banner. `retry`
   * repeats the same change.
   */
  readonly onStatusOutcome?: (
    outcome:
      | { readonly ok: true }
      | {
          readonly ok: false;
          readonly target: InstalledItemTarget;
          readonly listingId: string;
          readonly statusEntryId: string;
          readonly next: InstalledItemStatus;
          readonly message: string;
          readonly retry: (setStatus?: InstalledItemSetStatus) => void;
        },
  ) => void;
}

/** Shown when a Browse row cannot be added from this host. */
export const CUSTOMIZE_ROW_ADD_UNAVAILABLE_REASON = 'Can’t be added here.';

/**
 * The listings a row's Add can install, as the tile offers them: one per
 * marketplace provider with an installable listing for a grouped row, or
 * the row itself.
 */
function customizeAddChoices(
  entry: UnifiedPluginEntry,
): { provider: string | undefined; listing: UnifiedPluginEntry }[] {
  if (entry.marketplaceListings?.length)
    return (entry.marketplaceProviders ?? []).flatMap((provider) => {
      const listing = entry.marketplaceListings?.find(
        (item) =>
          item.marketplaceProvider === provider &&
          item.state === 'available' &&
          item.browseInstallAvailable !== false,
      );
      return listing ? [{ provider, listing }] : [];
    });
  return entry.browseInstallAvailable === false
    ? []
    : [{ provider: undefined, listing: entry }];
}

function addAction(
  entry: UnifiedPluginEntry,
  add: ((listing: UnifiedPluginEntry) => void) | undefined,
): CustomizeRowSplitAction {
  const base = {
    label: 'Add',
    tone: 'add' as const,
    accessibleName: `Add ${entry.name}`,
    primaryTestId: `plugins-entry-add-${entry.id}`,
  };
  const choices = customizeAddChoices(entry);
  if (add === undefined || choices.length === 0)
    return { ...base, reason: CUSTOMIZE_ROW_ADD_UNAVAILABLE_REASON };
  const [only] = choices;
  if (choices.length === 1 && only !== undefined)
    return { ...base, onPrimary: () => add(only.listing) };
  return {
    ...base,
    leadingItems: choices.map(({ provider, listing }) => ({
      id: `add-${(provider ?? listing.id).toLowerCase()}`,
      label: `Add from ${provider ?? listing.name}`,
      onSelect: () => add(listing),
    })),
  };
}

function statusLabel(state: InstalledEntryStatusState): {
  readonly label: string;
  readonly glyph?: CustomizeRowSplitAction['glyph'];
  readonly tone?: CustomizeRowSplitAction['tone'];
  readonly reason?: string;
  readonly busy?: boolean;
} {
  switch (state.kind) {
    case 'loading':
      return { label: 'Installed', busy: true };
    case 'read-only':
      return {
        label: 'Unavailable',
        glyph: 'unavailable',
        reason: state.reason,
      };
    case 'fixed':
      return {
        label: INSTALLED_ITEM_STATUS_COPY[state.status].label,
        glyph: state.status,
        reason: state.reason,
      };
    case 'ready': {
      const status = state.item.status;
      if (status === null)
        return {
          label: state.item.notices.some(
            (notice) => notice.code === 'partial_removal',
          )
            ? 'Uninstall incomplete'
            : 'Installed',
          tone: 'installed',
        };
      return { label: INSTALLED_ITEM_STATUS_COPY[status].label, glyph: status };
    }
  }
}

function statusChoice(
  status: CustomizeRowActionStatus,
  input: CustomizeRowActionInput,
  heading: string | undefined,
): CustomizeRowSplitStatus | undefined {
  const { state } = status;
  const onSetStatus = input.onSetStatus;
  if (state.kind !== 'ready' || state.item.status === null || !onSetStatus)
    return undefined;
  const target = state.item.target;
  function change(
    next: InstalledItemStatus,
    setStatus: InstalledItemSetStatus,
  ): void {
    void setStatus(target, next).then((outcome) => {
      if (input.onStatusOutcome) {
        input.onStatusOutcome(
          outcome.ok
            ? { ok: true }
            : {
                ok: false,
                target,
                listingId: status.listing.id,
                statusEntryId:
                  status.listing.installedEntryId ?? status.listing.id,
                next,
                message: outcome.message ?? 'The status did not change.',
                retry: (currentSetStatus): void =>
                  change(next, currentSetStatus ?? setStatus),
              },
        );
        return;
      }
      if (!outcome.ok && outcome.message) input.onError?.(outcome.message);
    });
  }
  return {
    current: state.item.status,
    ...(heading !== undefined ? { heading } : {}),
    targetKind: target.kind,
    retryCurrent: state.item.notices.some((notice) => notice.retryable),
    busy: input.pendingKeys.has(installedItemTargetKey(target)),
    onChange: (next): void => change(next, onSetStatus),
  };
}

/** The row's split control: its state, main action and leading choices. */
export function customizeRowAction(
  input: CustomizeRowActionInput,
): CustomizeRowSplitAction {
  const { entry } = input;
  const workflow = input.workflow;
  if (workflow && entry.workflow) {
    const enabled = entry.workflow.enabled;
    if (entry.kind === 'automation' && enabled !== undefined) {
      const { toggle } = workflow.availability;
      return {
        label: enabled ? 'On' : 'Off',
        accessibleName: `${entry.name} is ${enabled ? 'on' : 'off'}`,
        tone: enabled ? 'active' : 'disabled',
        busy: workflow.busy,
        primaryTestId: `customize-workflow-toggle-${entry.id}`,
        leadingItems: [
          {
            id: 'toggle',
            label: enabled ? 'Turn off' : 'Turn on',
            disabled: workflow.busy || !toggle.available,
            disabledReason: toggle.reason,
            onSelect: workflow.onToggle,
          },
        ],
      };
    }
    if (entry.kind === 'pipeline') {
      const { run } = workflow.availability;
      return {
        label: 'Run',
        tone: 'run',
        accessibleName: `Run ${entry.name}`,
        busy: workflow.busy,
        primaryTestId: `customize-workflow-run-${entry.id}`,
        ...(run.available
          ? { onPrimary: workflow.onRun }
          : run.reason !== undefined
            ? { reason: run.reason }
            : {}),
      };
    }
  }
  if (input.bundledSkill) {
    const state = input.bundledSkill.state;
    const shown = state ? statusLabel(state) : undefined;
    return {
      label: shown?.label ?? 'Unavailable',
      accessibleName: `Status for ${entry.name}: ${shown?.label ?? 'Unavailable'}`,
      glyph: shown?.busy ? undefined : (shown?.glyph ?? 'unavailable'),
      busy: shown?.busy,
      reason: input.bundledSkill.reason,
      primaryTestId: `plugins-entry-status-${entry.id}`,
    };
  }
  if (input.installedVia) {
    const { pluginName, open } = input.installedVia;
    return {
      label: 'Installed',
      tone: 'installed',
      accessibleName: `${entry.name} is installed with ${pluginName}`,
      primaryTestId: `plugins-entry-installed-via-${entry.id}`,
      leadingItems: [
        {
          id: 'open-installed-via',
          label: `Open the ${pluginName} plugin`,
          disabled: open === undefined,
          onSelect: () => open?.(),
        },
      ],
    };
  }
  if (!input.installed) return addAction(entry, input.add);
  const several = input.statuses.length > 1;
  const statuses = input.statuses.flatMap((status) => {
    const choice = statusChoice(
      status,
      input,
      several ? (status.provider ?? status.listing.name) : undefined,
    );
    return choice ? [choice] : [];
  });
  // A grouped row reads its first listing that has a status.
  const first =
    input.statuses.find(
      (status) =>
        status.state.kind === 'ready' && status.state.item.status !== null,
    ) ?? input.statuses[0];
  if (first === undefined)
    return {
      label: 'Installed',
      tone: 'installed',
      accessibleName: `${entry.name} is installed`,
      primaryTestId: `plugins-entry-status-${entry.id}`,
    };
  const shown = statusLabel(first.state);
  return {
    label: shown.label,
    accessibleName: `Status for ${entry.name}: ${shown.label}`,
    ...(shown.glyph !== undefined ? { glyph: shown.glyph } : {}),
    ...(shown.tone !== undefined ? { tone: shown.tone } : {}),
    // A status change in flight: this row's control alone shows it.
    ...(shown.busy || statuses.some((status) => status.busy)
      ? { busy: true }
      : {}),
    ...(shown.reason !== undefined ? { reason: shown.reason } : {}),
    primaryTestId: `plugins-entry-status-${first.listing.id}`,
    statuses,
  };
}
