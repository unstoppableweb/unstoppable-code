import { useState, type JSX } from 'react';
import type {
  InstalledItemSnapshotEntry,
  InstalledItemStatus,
} from '@canopy/protocol/installed-items';
import {
  InstalledItemStatusControl,
  InstalledItemStatusIcon,
  InstalledItemStatusPicker,
  InstalledItemStatusRow,
  InstalledItemStatusUnavailable,
  InstalledStatusFilterDropdown,
} from '@canopy/ui-shared/components';
import type {
  InstalledEntryStatusState,
  InstalledItemMutationOutcome,
  InstalledStatusFilterValue,
} from '@canopy/ui-shared/lib/installed-item-status';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;
const OK: InstalledItemMutationOutcome = { ok: true, notices: [] };
const succeed = (): Promise<InstalledItemMutationOutcome> =>
  Promise.resolve(OK);

const PLUGIN: InstalledItemSnapshotEntry = {
  target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'linter' },
  status: 'active',
  removable: true,
  uninstallTarget: {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'linter',
  },
  removalScope: 'item',
  uninstallDescription:
    'Removes the provider installations, managed cache and saved selections.',
  notices: [],
};

function ready(
  item: InstalledItemSnapshotEntry,
  configurations: readonly InstalledItemSnapshotEntry[] = [],
): InstalledEntryStatusState {
  return { kind: 'ready', item, configurations };
}

const SERVER: InstalledItemSnapshotEntry = {
  ...PLUGIN,
  target: { kind: 'mcp-server', serverId: 'notion' },
  uninstallTarget: { kind: 'mcp-server', serverId: 'notion' },
};

function configuration(
  configId: string,
  status: InstalledItemStatus,
): InstalledItemSnapshotEntry {
  return {
    ...PLUGIN,
    target: { kind: 'mcp-config', serverId: 'notion', configId },
    status,
  };
}

const ROW_STATES: readonly {
  label: string;
  state: InstalledEntryStatusState;
}[] = [
  { label: 'Active, removable', state: ready(PLUGIN) },
  { label: 'Available', state: ready({ ...PLUGIN, status: 'available' }) },
  { label: 'Disabled', state: ready({ ...PLUGIN, status: 'disabled' }) },
  { label: 'Loading', state: { kind: 'loading' } },
  {
    label: 'Read-only: the reason replaces the picker',
    state: { kind: 'read-only', reason: 'Pair your desktop to see this.' },
  },
  {
    label: 'Fixed by the catalog row',
    state: {
      kind: 'fixed',
      status: 'available',
      reason:
        "Built-in workflows are always available and can't be turned off.",
    },
  },
  {
    label: 'Not removable: the reason shows instead of Uninstall',
    state: ready({
      ...PLUGIN,
      removable: false,
      reason: 'Managed by your organization.',
    }),
  },
  {
    label: 'Provider notices (attention and neutral)',
    state: ready({
      ...PLUGIN,
      notices: [
        {
          code: 'provider_pending',
          provider: 'codex',
          message: 'Codex will pick this up in a new chat.',
          retryable: false,
        },
        {
          code: 'session_recreation_required',
          message: 'Open chats keep the old status until you start a new one.',
          retryable: false,
        },
      ],
    }),
  },
  {
    label: 'A device server with several configurations',
    state: ready(SERVER, [
      configuration('work', 'active'),
      configuration('home', 'disabled'),
    ]),
  },
  {
    label: 'No status: the status could not be loaded',
    state: ready({
      ...PLUGIN,
      status: null,
      notices: [
        {
          code: 'provider_unavailable',
          message: 'The provider did not answer.',
          retryable: true,
        },
      ],
    }),
  },
];

function InteractivePicker(): JSX.Element {
  const [status, setStatus] = useState<InstalledItemStatus>('active');
  return (
    <InstalledItemStatusPicker
      itemName="Linter"
      status={status}
      onChange={setStatus}
      testId="lab-installed-status-live"
    />
  );
}

function FilterDropdownDemo(): JSX.Element {
  const [value, setValue] = useState<InstalledStatusFilterValue | null>(null);
  return (
    <InstalledStatusFilterDropdown
      value={value}
      onChange={setValue}
      includeUpdateAvailable
      testId="lab-installed-status-filter"
    />
  );
}

/**
 * The Active / Available / Disabled picker, the card control and detail Status
 * row built on it, and the Customize status filter. Hover and focus are real
 * pointer and keyboard states; menus open on click.
 */
export function InstalledStatusSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="InstalledItemStatusIcon">
        <SpecimenGrid min={140}>
          {(['active', 'available', 'disabled', 'unavailable'] as const).map(
            (status) => (
              <SpecimenCell key={status} label={status}>
                <InstalledItemStatusIcon status={status} />
              </SpecimenCell>
            ),
          )}
          <SpecimenCell label="size 20">
            <InstalledItemStatusIcon status="active" size={20} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="InstalledItemStatusPicker (click to open)">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Live: choose a status">
            <InteractivePicker />
          </SpecimenCell>
          <SpecimenCell label="Active">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="active"
              onChange={noop}
              testId="lab-installed-status-active"
            />
          </SpecimenCell>
          <SpecimenCell label="Available">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="available"
              onChange={noop}
              testId="lab-installed-status-available"
            />
          </SpecimenCell>
          <SpecimenCell label="Disabled">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="disabled"
              onChange={noop}
              testId="lab-installed-status-disabled"
            />
          </SpecimenCell>
          <SpecimenCell label="Busy: a write is in flight">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="active"
              busy
              onChange={noop}
              testId="lab-installed-status-busy"
            />
          </SpecimenCell>
          <SpecimenCell label="Read-only: no change handler">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="available"
              testId="lab-installed-status-readonly"
            />
          </SpecimenCell>
          <SpecimenCell label="Cannot change: the reason shows on hover">
            <InstalledItemStatusPicker
              itemName="Linter"
              status="active"
              disabledReason="Active in chats through your connected provider account."
              onChange={noop}
              testId="lab-installed-status-reason"
            />
          </SpecimenCell>
          <SpecimenCell label="Unavailable">
            <InstalledItemStatusUnavailable
              itemName="Linter"
              reason="Pair your desktop to see this."
              testId="lab-installed-status-unavailable"
            />
          </SpecimenCell>
          <SpecimenCell label="Skill: Available explains how to use it">
            <InstalledItemStatusPicker
              itemName="Review"
              status="available"
              targetKind="skill"
              onChange={noop}
              testId="lab-installed-status-skill"
            />
          </SpecimenCell>
          <SpecimenCell label="Long item name stays in the accessible name">
            <InstalledItemStatusPicker
              itemName="A plugin with an extremely long name that nobody would read in full"
              status="active"
              onChange={noop}
              testId="lab-installed-status-long"
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="InstalledItemStatusControl (the card picker)">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Ready">
            <InstalledItemStatusControl
              itemName="Linter"
              state={ready(PLUGIN)}
              pendingKeys={new Set()}
              onSetStatus={succeed}
              testId="lab-control-ready"
            />
          </SpecimenCell>
          <SpecimenCell label="Loading">
            <InstalledItemStatusControl
              itemName="Linter"
              state={{ kind: 'loading' }}
              pendingKeys={new Set()}
              testId="lab-control-loading"
            />
          </SpecimenCell>
          <SpecimenCell label="Read-only">
            <InstalledItemStatusControl
              itemName="Linter"
              state={{ kind: 'read-only', reason: 'Pair to see.' }}
              pendingKeys={new Set()}
              testId="lab-control-readonly"
            />
          </SpecimenCell>
          <SpecimenCell label="Uninstall incomplete">
            <InstalledItemStatusControl
              itemName="Linter"
              state={ready({
                ...PLUGIN,
                status: null,
                notices: [
                  {
                    code: 'partial_removal',
                    message: 'Some files remain.',
                    retryable: true,
                  },
                ],
              })}
              pendingKeys={new Set()}
              testId="lab-control-partial"
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="InstalledItemStatusRow (the detail Status section)">
        {ROW_STATES.map(({ label, state }, index) => (
          <SpecimenCell key={label} label={label} wide>
            <div className="w-full">
              <InstalledItemStatusRow
                itemName="Linter"
                state={state}
                pendingKeys={new Set()}
                onSetStatus={succeed}
                onUninstall={succeed}
                configurationLabel={(ref) =>
                  ref.kind === 'mcp-config'
                    ? `Config ${ref.configId}`
                    : 'Config'
                }
                testId={`lab-installed-status-row-${index}`}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>

      <SpecimenPanel title="InstalledStatusFilterDropdown (click to open)">
        <SpecimenGrid min={220}>
          <SpecimenCell label="Live: any status, then each one">
            <FilterDropdownDemo />
          </SpecimenCell>
          {(['active', 'available', 'disabled'] as const).map((value) => (
            <SpecimenCell key={value} label={`Filtered to ${value}`}>
              <InstalledStatusFilterDropdown
                value={value}
                onChange={noop}
                testId={`lab-installed-status-filter-${value}`}
              />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
