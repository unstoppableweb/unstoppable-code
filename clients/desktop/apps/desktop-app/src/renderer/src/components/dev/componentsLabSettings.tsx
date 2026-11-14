import { useContext, useState, type JSX } from 'react';
import { LabBrandDisplayNameContext } from './componentsLabStageContext';
import {
  AgentAccessEditor,
  Button,
  DiffSourceSelector,
  ErrorBanner,
  GoogleSubscriptionRow,
  LoadingButton,
  SettingsBackButton,
  SettingsButtonRow,
  SettingsRowsGroup,
  SettingsRowsSection,
  SettingsSaveBar,
  StatusLabel,
  type AgentAccessGroupRow,
  type AgentAccessLevel,
  type AgentAccessPreset,
  type DiffSource,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

/** Back button and button rows: the drill-in pieces of a Settings list. */
export function SettingsPagesSpecimen(): JSX.Element {
  const [environment, setEnvironment] = useState('work');
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="SettingsBackButton">
        <SpecimenGrid min={240}>
          <SpecimenCell label="Named for its list">
            <SettingsBackButton label="Environments" onClick={noop} />
          </SpecimenCell>
          <SpecimenCell label="Long list name">
            <SettingsBackButton
              label="Environments for the payments team in the staging organization"
              onClick={noop}
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="SettingsButtonRow, open">
        <SettingsRowsGroup>
          <SettingsButtonRow
            trailing="open"
            label="Production"
            description="Used by the deploy pipeline"
            meta={<span className="text-xs fg-tertiary">3 variables</span>}
            onClick={noop}
          />
          <SettingsButtonRow
            trailing="open"
            label="No description"
            onClick={noop}
          />
          <SettingsButtonRow
            trailing="open"
            label="An environment with a name so long it has to truncate somewhere"
            description="A description that is also long enough to wrap onto a second line in a narrow settings column"
            tooltip="An environment with a name so long it has to truncate somewhere"
            onClick={noop}
          />
          <SettingsButtonRow
            trailing="open"
            label="Disabled"
            description="Not available while a deploy runs"
            disabled
            onClick={noop}
          />
        </SettingsRowsGroup>
      </SpecimenPanel>
      <SpecimenPanel title="SettingsButtonRow, select">
        <SettingsRowsGroup>
          {(
            [
              ['work', 'Work profile'],
              ['personal', 'Personal profile'],
              ['guest', 'Guest profile'],
            ] as const
          ).map(([id, label]) => (
            <SettingsButtonRow
              key={id}
              trailing="select"
              label={label}
              selected={environment === id}
              onClick={() => setEnvironment(id)}
            />
          ))}
          <SettingsButtonRow
            trailing="select"
            label="Managed by your organization"
            disabled
            selected={false}
          />
        </SettingsRowsGroup>
      </SpecimenPanel>
    </div>
  );
}

/** The draft save bar in each state it has. */
export function SettingsSaveBarSpecimen(): JSX.Element {
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="SettingsSaveBar, without a card slot (sticks to the page bottom)">
        <div className="flex flex-col gap-4">
          {(
            [
              [
                'Clean: nothing to save',
                undefined,
                <Button key="s" size="compact" disabled>
                  Save
                </Button>,
              ],
              [
                'Unsaved changes',
                'Unsaved changes',
                <Button key="s" size="compact" variant="primary" onClick={noop}>
                  Save
                </Button>,
              ],
              [
                'Saved note',
                undefined,
                <span key="n" className="text-xs fg-secondary">
                  Saved
                </span>,
              ],
              [
                'Problem',
                <StatusLabel key="p">
                  Couldn&apos;t save the variables. Try again.
                </StatusLabel>,
                <Button key="s" size="compact" variant="primary" onClick={noop}>
                  Save
                </Button>,
              ],
            ] as const
          ).map(([label, status, actions]) => (
            <SpecimenCell key={label} label={label} wide>
              <div className="w-full">
                <SettingsSaveBar status={status} actions={actions} />
              </div>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Saving: Save is busy, status says so" wide>
            <div className="w-full">
              <SettingsSaveBar
                status={saving ? 'Saving…' : 'Unsaved changes'}
                actions={
                  <LoadingButton
                    size="compact"
                    variant="primary"
                    loading={saving}
                    loadingLabel="Saving…"
                    onClick={() => setSaving((current) => !current)}
                  >
                    Save
                  </LoadingButton>
                }
              />
            </div>
          </SpecimenCell>
        </div>
      </SpecimenPanel>
    </div>
  );
}

const SOURCES: DiffSource[] = ['uncommitted', 'committed', 'combined'];

/** The diff source selector with its default and a custom option list. */
export function DiffSourceSpecimen(): JSX.Element {
  const [source, setSource] = useState<DiffSource>('uncommitted');
  const [custom, setCustom] = useState<DiffSource>('committed');
  return (
    <SpecimenPanel title="DiffSourceSelector">
      <SpecimenGrid min={280}>
        {SOURCES.map((value) => (
          <SpecimenCell
            key={value}
            label={`Default options, ${value} selected`}
          >
            <DiffSourceSelector value={value} onChange={noop} />
          </SpecimenCell>
        ))}
        <SpecimenCell label="Interactive">
          <DiffSourceSelector value={source} onChange={setSource} />
        </SpecimenCell>
        <SpecimenCell label="Custom options (no combined)">
          <DiffSourceSelector
            value={custom}
            onChange={setCustom}
            options={[
              { value: 'uncommitted', label: 'Working tree' },
              { value: 'committed', label: 'Branch' },
            ]}
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function agentGroups(
  level: AgentAccessLevel,
  tools: number,
): readonly AgentAccessGroupRow[] {
  const available = level !== 'off';
  return [
    {
      id: 'chats',
      label: 'Chats',
      description: 'Read your chats and start new ones.',
      level,
      levels: ['off', 'read', 'write'],
      tools: [
        {
          name: 'list_chats',
          title: 'List chats',
          access: 'read',
          defaultOff: false,
          markers: [],
          enabled: available,
          available,
        },
        {
          name: 'start_cloud_task',
          title: 'Start a cloud task',
          access: 'write',
          defaultOff: true,
          markers: ['spendsCredits', 'actsOnRemote'],
          enabled: level === 'write' && tools > 1,
          available: level === 'write',
        },
      ],
      destructive:
        level === 'write'
          ? {
              label: 'Allow deleting chats',
              description: 'Lets the agent delete chats you can see.',
              enabled: false,
              warning: 'Deleted chats cannot be restored.',
            }
          : undefined,
    },
    {
      id: 'billing',
      label: 'Billing',
      description: 'See your plan and usage.',
      level: 'read',
      levels: ['off', 'read'],
      writeUnavailableReason: 'Agents can never change billing.',
      tools: [
        {
          name: 'get_usage',
          title: 'Get usage',
          access: 'read',
          defaultOff: false,
          markers: ['publicEffect', 'sendsEmail'],
          enabled: true,
          available: true,
        },
      ],
    },
    {
      id: 'automations',
      label: 'Automations',
      description: 'Create and run automations.',
      level: 'off',
      levels: ['off'],
      unavailableReason: 'Not available yet.',
      tools: [],
    },
  ];
}

function LiveAgentAccess({
  disabled,
  max,
  initial = 'write',
}: {
  readonly disabled?: boolean;
  readonly max: number;
  readonly initial?: AgentAccessLevel;
}): JSX.Element {
  const [preset, setPreset] = useState<AgentAccessPreset>('custom');
  const [level, setLevel] = useState<AgentAccessLevel>(initial);
  const groups = agentGroups(level, 2);
  return (
    <AgentAccessEditor
      preset={preset}
      onPresetChange={setPreset}
      groups={groups}
      onLevelChange={(_, next) => setLevel(next)}
      onDestructiveChange={noop}
      onToolChange={noop}
      toolCount={{ enabled: 4, total: 12, max }}
      disabled={disabled}
    />
  );
}

/** The external-agent access editor: every row state, over the limit, disabled. */
export function AgentAccessSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="AgentAccessEditor">
        <LiveAgentAccess max={40} />
      </SpecimenPanel>
      <SpecimenPanel title="AgentAccessEditor, groups off (tools unavailable)">
        <LiveAgentAccess max={40} initial="off" />
      </SpecimenPanel>
      <SpecimenPanel title="AgentAccessEditor, over the tool limit">
        <LiveAgentAccess max={2} />
      </SpecimenPanel>
      <SpecimenPanel title="AgentAccessEditor, disabled while saving">
        <LiveAgentAccess max={40} disabled />
      </SpecimenPanel>
      <SpecimenPanel title="AgentAccessEditor, no groups yet">
        <AgentAccessEditor
          preset="read"
          onPresetChange={noop}
          groups={[]}
          onLevelChange={noop}
          onDestructiveChange={noop}
          onToolChange={noop}
          toolCount={{ enabled: 0, total: 0, max: 40 }}
        />
      </SpecimenPanel>
    </div>
  );
}

/** One sheet for the settings, diff and external-agent controls. */
export function SettingsAndAgentsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <SettingsRowsSection title="Settings pages">
        <SettingsPagesSpecimen />
      </SettingsRowsSection>
      <SettingsRowsSection title="Save bar">
        <SettingsSaveBarSpecimen />
      </SettingsRowsSection>
      <SettingsRowsSection title="Diff source">
        <DiffSourceSpecimen />
      </SettingsRowsSection>
      <SettingsRowsSection title="Agent access">
        <AgentAccessSpecimen />
      </SettingsRowsSection>
    </div>
  );
}

/** All connection, refresh and error combinations of the shared Google row. */
export function GoogleSubscriptionSpecimen(): JSX.Element {
  const brandDisplayName = useContext(LabBrandDisplayNameContext);
  return (
    <div className="flex flex-col gap-6">
      {[
        { connected: false, disconnected: false, label: 'Not signed in' },
        { connected: true, disconnected: false, label: 'Connected' },
        { connected: false, disconnected: true, label: 'Disconnected' },
      ].flatMap(({ connected, disconnected, label }) =>
        [false, true].flatMap((busy) =>
          [false, true].map((failed) => (
            <SpecimenPanel
              key={`${label}-${busy}-${failed}`}
              title={`${label}, ${busy ? 'updating' : 'idle'}${failed ? ', error' : ''}`}
            >
              <SettingsRowsGroup>
                <GoogleSubscriptionRow
                  connected={connected}
                  disconnected={disconnected}
                  appName={brandDisplayName}
                  busy={busy}
                  onSignIn={noop}
                  onRefresh={noop}
                  onDisconnect={noop}
                  onReconnect={noop}
                  error={
                    failed ? (
                      <ErrorBanner
                        errorSource="preview-google-subscription-specimen"
                        error="Google sign-in failed. Try again."
                      />
                    ) : undefined
                  }
                />
              </SettingsRowsGroup>
            </SpecimenPanel>
          )),
        ),
      )}
    </div>
  );
}
