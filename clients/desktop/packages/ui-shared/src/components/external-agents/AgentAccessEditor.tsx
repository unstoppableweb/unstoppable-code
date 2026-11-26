'use client';

import { DisclosureToggle } from '../../primitives/Disclosure';
import { Stack } from '../../primitives/Stack';
import { useState, type JSX } from 'react';
import { Notice } from '../../primitives/Notice';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '../../primitives/SegmentedControl';
import { Badge } from '../../primitives/Badge';
import { SettingsRowsRow } from '../settings/SettingsRows';
import { ToggleSwitch } from '../../primitives/ToggleSwitch';
import type {
  AgentAccessGroupRow,
  AgentAccessLevel,
  AgentAccessPreset,
  AgentAccessToolCount,
  AgentAccessToolRow,
  AgentToolMarker,
} from './agent-access-types';

const SETTINGS_GROUP_CLASS_NAME =
  'flex flex-col divide-y rounded-lg bg-secondary px-4 ring-[length:var(--border-hairline)] ring-line-base *:py-3';

const ACCESS_LEVEL_LABELS: Record<AgentAccessLevel, string> = {
  off: 'Off',
  read: 'Read',
  write: 'Write',
};

const PRESET_OPTIONS: readonly SegmentedControlOption<AgentAccessPreset>[] = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read and write' },
  { value: 'custom', label: 'Custom' },
];

const TOOL_MARKER_LABELS: Record<AgentToolMarker, string> = {
  spendsCredits: 'Spends AI credits',
  sendsEmail: 'Sends email',
  publicEffect: 'Public',
  actsOnRemote: 'Acts on your computer',
};

export interface AgentAccessEditorProps {
  readonly preset: AgentAccessPreset;
  readonly onPresetChange: (preset: AgentAccessPreset) => void;
  readonly groups: readonly AgentAccessGroupRow[];
  readonly onLevelChange: (groupId: string, level: AgentAccessLevel) => void;
  readonly onDestructiveChange: (groupId: string, enabled: boolean) => void;
  readonly onToolChange: (
    groupId: string,
    toolName: string,
    enabled: boolean,
  ) => void;
  readonly toolCount: AgentAccessToolCount;
  /** Disables every control, e.g. while the form submits. */
  readonly disabled?: boolean;
}

/** Whether the selected tools exceed the connection's tool limit. */
export function agentToolCountOverLimit(count: AgentAccessToolCount): boolean {
  return count.enabled > count.max;
}

/** A concise explanation of a tool's effect, shared by each access surface. */
export function AgentToolMarkerLabel({
  marker,
}: {
  readonly marker: AgentToolMarker;
}): JSX.Element {
  return <Badge>{TOOL_MARKER_LABELS[marker]}</Badge>;
}

function levelOptions(
  group: AgentAccessGroupRow,
): readonly SegmentedControlOption<AgentAccessLevel>[] {
  const options: SegmentedControlOption<AgentAccessLevel>[] = group.levels.map(
    (level): SegmentedControlOption<AgentAccessLevel> => ({
      value: level,
      label: ACCESS_LEVEL_LABELS[level],
    }),
  );

  if (
    group.writeUnavailableReason !== undefined &&
    !group.levels.includes('write')
  ) {
    options.push({
      value: 'write',
      label: 'Write',
      unavailable: true,
      tooltip: group.writeUnavailableReason,
    });
  }

  return options;
}

function enabledToolCount(tools: readonly AgentAccessToolRow[]): number {
  return tools.reduce(
    (enabled, tool): number => enabled + (tool.enabled ? 1 : 0),
    0,
  );
}

function AgentAccessGroup({
  group,
  disabled,
  onLevelChange,
  onDestructiveChange,
  onToolChange,
}: {
  readonly group: AgentAccessGroupRow;
  readonly disabled: boolean;
  readonly onLevelChange: AgentAccessEditorProps['onLevelChange'];
  readonly onDestructiveChange: AgentAccessEditorProps['onDestructiveChange'];
  readonly onToolChange: AgentAccessEditorProps['onToolChange'];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const unavailable = group.unavailableReason !== undefined;
  const options: readonly SegmentedControlOption<AgentAccessLevel>[] =
    unavailable ? [{ value: 'off', label: 'Off' }] : levelOptions(group);
  const level = unavailable ? 'off' : group.level;
  const toolsListId = `agent-access-tools-list-${group.id}`;
  const toolCount = enabledToolCount(group.tools);
  const destructive = group.destructive;
  const destructiveSwitchId = `agent-access-destructive-switch-${group.id}`;
  const destructiveNoteId = `agent-access-destructive-note-${group.id}`;
  const destructiveWarningId = `agent-access-destructive-warning-${group.id}`;

  return (
    <div
      data-testid={`agent-access-group-${group.id}`}
      aria-disabled={unavailable || undefined}
      className={`flex flex-col gap-3 ${unavailable ? 'pointer-events-none opacity-50' : ''}`}
    >
      <div
        {...(unavailable
          ? { 'data-testid': `agent-access-unavailable-${group.id}` }
          : {})}
      >
        <div
          className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 ${
            unavailable ? 'pointer-events-none' : ''
          }`}
        >
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <div className="text-s font-medium fg-primary">{group.label}</div>
            <div className="text-xs text-pretty fg-secondary">
              {group.description}
            </div>
            {group.unavailableReason !== undefined ? (
              <div className="text-xs text-pretty fg-secondary">
                {group.unavailableReason}
              </div>
            ) : null}
          </div>
          <div className="w-full sm:w-fit sm:min-w-52 [&>div]:w-full [&>div]:min-w-0 sm:[&>div]:w-auto sm:[&>div]:min-w-52">
            <SegmentedControl
              label={`${group.label} access`}
              value={level}
              options={options}
              onChange={(next): void => onLevelChange(group.id, next)}
              width="control"
              disabled={disabled || unavailable}
              dataTestId={`agent-access-level-${group.id}`}
            />
          </div>
        </div>
      </div>
      {destructive !== undefined ? (
        <div
          data-testid={`agent-access-destructive-${group.id}`}
          className="flex flex-col gap-2"
        >
          <SettingsRowsRow
            label={destructive.label}
            htmlFor={destructiveSwitchId}
            description={
              <div id={destructiveNoteId} data-testid={destructiveNoteId}>
                {destructive.description}
              </div>
            }
            control={
              <ToggleSwitch
                id={destructiveSwitchId}
                label={destructive.label}
                checked={destructive.enabled}
                disabled={disabled || unavailable}
                describedBy={`${destructiveNoteId}${
                  destructive.warning === undefined
                    ? ''
                    : ` ${destructiveWarningId}`
                }`}
                dataTestId={destructiveSwitchId}
                onChange={(next): void => onDestructiveChange(group.id, next)}
              />
            }
          />
          {destructive.warning !== undefined ? (
            <Notice
              id={destructiveWarningId}
              intent="attention"
              title={destructive.warning}
              data-testid={destructiveWarningId}
              className="w-full"
            >
              {null}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {!unavailable ? (
        <>
          <DisclosureToggle
            variant="tool-count"
            open={expanded}
            bodyId={toolsListId}
            disabled={disabled}
            data-testid={`agent-access-tools-toggle-${group.id}`}
            onClick={(): void =>
              setExpanded((current: boolean): boolean => !current)
            }
          >
            {`Tools · ${toolCount} of ${group.tools.length} on`}
          </DisclosureToggle>
          <div
            id={toolsListId}
            role="group"
            aria-label={`${group.label} tools`}
            data-testid={`agent-access-tools-list-${group.id}`}
            hidden={!expanded}
            className="flex flex-col divide-y"
          >
            {group.tools.map(
              (tool): JSX.Element => (
                <AgentAccessTool
                  key={tool.name}
                  groupId={group.id}
                  tool={tool}
                  disabled={disabled}
                  onToolChange={onToolChange}
                />
              ),
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function AgentAccessTool({
  groupId,
  tool,
  disabled,
  onToolChange,
}: {
  readonly groupId: string;
  readonly tool: AgentAccessToolRow;
  readonly disabled: boolean;
  readonly onToolChange: AgentAccessEditorProps['onToolChange'];
}): JSX.Element {
  return (
    <div
      data-testid={`agent-access-tool-${tool.name}`}
      className="flex items-center justify-between gap-6 py-2.5"
    >
      <Stack gap="tight" className="min-w-0 flex-1">
        <div className="text-s fg-primary">{tool.title}</div>
        {tool.defaultOff || tool.markers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tool.defaultOff ? (
              <span className="text-xs fg-secondary">Off by default</span>
            ) : null}
            {tool.markers.map(
              (marker): JSX.Element => (
                <AgentToolMarkerLabel key={marker} marker={marker} />
              ),
            )}
          </div>
        ) : null}
      </Stack>
      <ToggleSwitch
        label={tool.title}
        checked={tool.enabled}
        disabled={disabled || !tool.available}
        onChange={(next): void => onToolChange(groupId, tool.name, next)}
      />
    </div>
  );
}

/** The callback-driven editor for an outside agent's access choices. */
export function AgentAccessEditor({
  preset,
  onPresetChange,
  groups,
  onLevelChange,
  onDestructiveChange,
  onToolChange,
  toolCount,
  disabled = false,
}: AgentAccessEditorProps): JSX.Element {
  const overLimit = agentToolCountOverLimit(toolCount);

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Access preset"
        value={preset}
        options={PRESET_OPTIONS}
        onChange={onPresetChange}
        width="fill"
        disabled={disabled}
        dataTestId="agent-access-preset"
      />
      {groups.length > 0 ? (
        <div className={SETTINGS_GROUP_CLASS_NAME}>
          {groups.map(
            (group): JSX.Element => (
              <AgentAccessGroup
                key={group.id}
                group={group}
                disabled={disabled}
                onLevelChange={onLevelChange}
                onDestructiveChange={onDestructiveChange}
                onToolChange={onToolChange}
              />
            ),
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        <div
          data-testid="agent-access-tool-count"
          className="text-xs tabular-nums fg-secondary"
        >
          {`${toolCount.enabled} of ${toolCount.total} tools on`}
          {toolCount.total > toolCount.max ? ` (${toolCount.max} max)` : null}
        </div>
        {overLimit ? (
          <Notice
            intent="attention"
            title="Too many tools."
            data-testid="agent-access-over-limit"
            className="w-full"
          >
            {`An agent can use at most ${toolCount.max} tools. Turn off ${toolCount.enabled - toolCount.max} to connect.`}
          </Notice>
        ) : null}
      </div>
    </div>
  );
}
