'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsReplayPrivacy,
} from '@canopy/app-core/settings';
import {
  capabilitySetupItemKey,
  type CapabilitySetupItem,
} from '@canopy/protocol/canopy-core';
import {
  CAPABILITY_SETUP_INVALID_ITEM_CODE,
  CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
} from '@canopy/protocol/settings/operations-organization';
import {
  Badge,
  Button,
  DelayedLoadingPlaceholder,
  EmptyStateRow,
  ErrorBanner,
  Picker,
  Notice,
  PickerSearchList,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  findKnownSettingsError,
  logSettingsError,
  settingsActionErrorCopy,
  settingsErrorFacts,
  settingsFailure,
  settingsLoadErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../../settings/errors';
import type { SettingsLogger } from '../../settings/host/settings-host';
import {
  PROJECT_SETUP_SOURCE_LABEL,
  projectSetupSectionKinds,
  projectSetupCandidates,
  projectSetupRows,
  withDefaultSwitched,
  withItemAdded,
  withItemRemoved,
  type ProjectSetupRow,
  type ProjectSetupSectionKind,
  type ProjectSetupState,
  type ProjectSetupWrite,
} from './project-setup-model';
import {
  withConnectorAdded,
  withConnectorDefaultSwitched,
  withConnectorLimit,
  withConnectorRemoved,
} from './project-connectors-model';
import {
  PROJECT_CONNECTOR_ADD_KEY,
  ProjectConnectorsSection,
  projectConnectorLimitKey,
} from './ProjectConnectorsSection';
import { ProjectLocalSections } from './ProjectLocalSections';
import type { ProjectLocalSetupPort } from './project-local-setup';

/**
 * A server that predates the panel (desktop against an older web), and a
 * desktop signed out of its account, which reads the setup as that account.
 */
const LOAD_KNOWN: readonly KnownSettingsError[] = [
  {
    code: 'unsupported_server',
    copy: "This project's shared setup isn't available yet.",
  },
  {
    code: 'unauthenticated',
    copy: "Sign in to see this project's shared setup.",
  },
];

/**
 * A refused save the panel answers by reading the setup again: it changed
 * since the panel read it, or an item stopped being the organization's. Both
 * say what is shown now, since the reload replaces it.
 */
const SAVE_KNOWN: readonly KnownSettingsError[] = [
  {
    status: 409,
    serverCode: CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
    copy: "Couldn't update this project. Someone else changed its setup, and the latest is shown here.",
  },
  {
    status: 400,
    serverCode: CAPABILITY_SETUP_INVALID_ITEM_CODE,
    copy: "Couldn't update this project. An item is no longer shared with the organization, and the latest setup is shown here.",
  },
];

const SECTION_COPY: Record<
  ProjectSetupSectionKind,
  {
    readonly title: string;
    readonly empty: string;
    readonly add: string;
    readonly search: string;
    readonly none: string;
  }
> = {
  skill: {
    title: 'Skills',
    empty: 'No skills in this project yet',
    add: 'Add skill',
    search: 'Search skills',
    none: 'No other skills are shared with the organization.',
  },
  plugin: {
    title: 'Plugins',
    empty: 'No plugins in this project yet',
    add: 'Add plugin',
    search: 'Search plugins',
    none: 'No other plugins are shared with the organization.',
  },
  agent: {
    title: 'Model presets',
    empty: 'No model presets in this project yet',
    add: 'Add model preset',
    search: 'Search model presets',
    none: 'No other model presets are shared with the organization.',
  },
  // The `pipeline` kind is shown as a workflow, as the Workflows library
  // and Customize name it.
  pipeline: {
    title: 'Workflows',
    empty: 'No workflows in this project yet',
    add: 'Add workflow',
    search: 'Search workflows',
    none: 'No other workflows are shared with the organization.',
  },
};

export interface ProjectSetupPanelProps {
  /**
   * The host's hosted settings client: the settings page's on the web, the
   * `CanopyClient.settings` client in desktop project settings.
   */
  readonly client: AccountOrganizationSettingsClient;
  /** The organization project (tracked workspace external id). */
  readonly projectId: string;
  /** Where failures are logged; their raw reason never renders. */
  readonly logger?: SettingsLogger;
  /**
   * The project's scripts and hooks on this computer (CAN-6239), from a host
   * with its checkout. Without one the panel says to open the desktop app.
   */
  readonly localSetup?: ProjectLocalSetupPort;
  /**
   * The organization's Agents (CAN-6237, phase 10a) and pipelines (phase
   * 10b) can be shared with the project while organization projects are
   * on. Off, the panel lists neither, and saves keep them as stored.
   */
  readonly agentsAndPipelinesEnabled?: boolean;
  /** Session-replay privacy for commands; inert where replay is off. */
  readonly privacy?: SettingsReplayPrivacy;
  /**
   * Opens an organization sign-in (a same-origin web path) in the browser,
   * for "Share with this project" (CAN-6251). A host without one doesn't
   * offer it.
   */
  readonly openSignIn?: (signInPath: string) => void;
}

/**
 * An organization project's shared setup (CAN-6238, CAN-6239; spec FR-4.1,
 * FR-4.2): the skills and plugins every member of the project gets, each
 * with its source. Someone who may administer the project switches an
 * organization default off here, adds one of the organization's items, or
 * removes one the project added; everyone else reads it. The server decides
 * `canEdit` and re-checks every save.
 */
export function ProjectSetupPanel({
  client,
  projectId,
  logger,
  localSetup,
  privacy,
  openSignIn,
  agentsAndPipelinesEnabled = false,
}: ProjectSetupPanelProps): JSX.Element {
  const [state, setState] = useState<ProjectSetupState | null>(null);
  const [candidates, setCandidates] = useState<readonly CapabilitySetupItem[]>(
    [],
  );
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [saveError, setSaveError] = useState<SettingsFailure | null>(null);
  /** The row key being saved, while a save is out. */
  const [pending, setPending] = useState<string | null>(null);
  /**
   * Set when a save found the shown setup out of date, or its outcome is
   * unknown: edits stay off until a read replaces it, so nothing goes out at
   * the old revision and nothing is retried.
   */
  const [stale, setStale] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // A read started for an older attempt or project never lands.
  const generation = useRef(0);

  const reload = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    const fresh = (): boolean => active && current === generation.current;
    void (async (): Promise<void> => {
      try {
        const setup = await client.read('organization.projects.setup', {
          projectId,
        });
        // Only an editor adds items, so only an editor reads what it may add.
        const offered = setup.canEdit
          ? (
              await client.read('organization.settings.projectDefaults', {
                organizationId: setup.organizationId,
              })
            ).candidates
          : [];
        if (!fresh()) return;
        setState(setup);
        setCandidates(offered);
        setLoadError(null);
        setStale(false);
      } catch (error) {
        if (!fresh()) return;
        if (logger) logSettingsError(logger, 'load project setup', error);
        setLoadError(
          settingsFailure(error, settingsLoadErrorCopy(error, LOAD_KNOWN)),
        );
      }
    })();
    return (): void => {
      active = false;
    };
  }, [client, projectId, logger, loadAttempt]);

  /**
   * Saves one change, built from the setup as it stands; resolves whether it
   * saved. A connector change also needs `connectors.canEdit`.
   */
  const save = async (
    key: string,
    write: (current: ProjectSetupState) => ProjectSetupWrite,
    permitted: (current: ProjectSetupState) => boolean = (current) =>
      current.canEdit,
  ): Promise<boolean> => {
    if (state === null || pending !== null || stale || !permitted(state))
      return false;
    setPending(key);
    setSaveError(null);
    const readAt = generation.current;
    try {
      const saved = await client.write('organization.projects.setup.update', {
        projectId,
        expectedRevision: state.revision,
        ...write(state),
        idempotencyKey: crypto.randomUUID(),
      });
      if (readAt === generation.current) setState(saved);
      return true;
    } catch (error) {
      if (logger) logSettingsError(logger, 'update project setup', error);
      setSaveError(
        settingsFailure(
          error,
          settingsActionErrorCopy(error, {
            action: 'update this project',
            known: SAVE_KNOWN,
          }),
        ),
      );
      // A stale setup, or a save that may have landed: read it again rather
      // than resend anything.
      if (
        findKnownSettingsError(error, SAVE_KNOWN) !== undefined ||
        settingsErrorFacts(error).uncertain
      ) {
        setStale(true);
        reload();
      }
      return false;
    } finally {
      setPending(null);
    }
  };

  if (state === null) {
    if (loadError !== null)
      return (
        <ErrorBanner
          errorSource="project-setup-load"
          testId="project-setup-load-error"
          className=""
          error={loadError.copy}
          details={loadError.details}
          onRetry={() => {
            setLoadError(null);
            reload();
          }}
        />
      );
    return (
      <DelayedLoadingPlaceholder>
        <ProjectSetupSkeleton
          agentsAndPipelinesEnabled={agentsAndPipelinesEnabled}
        />
      </DelayedLoadingPlaceholder>
    );
  }

  const editable = state.canEdit && !stale && pending === null;
  const editsConnectors = (current: ProjectSetupState): boolean =>
    current.connectors?.canEdit === true;

  return (
    <div className="flex flex-col gap-8" data-testid="project-setup-panel">
      {!state.canEdit && (
        <Notice data-testid="project-setup-read-only">
          Only people who manage this project can change its shared setup.
        </Notice>
      )}
      {/* A reload that failed after a refused or unconfirmed save: the setup
          shown is out of date, and stays read-only until a retry reads it. */}
      {stale && loadError !== null && (
        <ErrorBanner
          errorSource="project-setup-load"
          testId="project-setup-load-error"
          className=""
          error={loadError.copy}
          details={loadError.details}
          onRetry={() => {
            setLoadError(null);
            reload();
          }}
        />
      )}
      <ErrorBanner
        errorSource="project-setup-save"
        testId="project-setup-error"
        className=""
        error={saveError?.copy}
        details={saveError?.details}
      />
      {projectSetupSectionKinds(agentsAndPipelinesEnabled).map((kind) => (
        <ProjectSetupSection
          key={kind}
          kind={kind}
          rows={projectSetupRows(state, kind)}
          offered={
            state.canEdit ? projectSetupCandidates(state, candidates, kind) : []
          }
          canEdit={state.canEdit}
          disabled={!editable}
          pendingKey={pending}
          onSwitch={(row, on) =>
            void save(row.key, (current) =>
              withDefaultSwitched(current, row.ref, on),
            )
          }
          onRemove={(row) =>
            void save(row.key, (current) => withItemRemoved(current, row.ref))
          }
          onAdd={(item) =>
            void save(`add:${kind}`, (current) =>
              withItemAdded(current, item.ref),
            )
          }
        />
      ))}
      {/* Absent from a server from before shared connections. */}
      {state.connectors !== undefined && (
        <ProjectConnectorsSection
          client={client}
          organizationId={state.organizationId}
          projectId={projectId}
          connectors={state.connectors}
          setupCanEdit={state.canEdit}
          disabled={!editable || !state.connectors.canEdit}
          pendingKey={pending}
          saveError={saveError}
          logger={logger}
          onSwitch={(row, on) =>
            void save(
              row.key,
              (current) => withConnectorDefaultSwitched(current, row.ref, on),
              editsConnectors,
            )
          }
          onRemove={(row) =>
            void save(
              row.key,
              (current) => withConnectorRemoved(current, row.ref),
              editsConnectors,
            )
          }
          onAdd={(item) =>
            void save(
              PROJECT_CONNECTOR_ADD_KEY,
              (current) => withConnectorAdded(current, item.ref),
              editsConnectors,
            )
          }
          onLimit={(row, limit) =>
            save(
              projectConnectorLimitKey(row),
              (current) => withConnectorLimit(current, row.ref, limit),
              editsConnectors,
            )
          }
          {...(openSignIn === undefined
            ? {}
            : { openSignIn, onShared: reload })}
        />
      )}
      <ProjectLocalSections port={localSetup} privacy={privacy} />
    </div>
  );
}

function ProjectSetupSection({
  kind,
  rows,
  offered,
  canEdit,
  disabled,
  pendingKey,
  onSwitch,
  onRemove,
  onAdd,
}: {
  kind: ProjectSetupSectionKind;
  rows: readonly ProjectSetupRow[];
  offered: readonly CapabilitySetupItem[];
  canEdit: boolean;
  disabled: boolean;
  pendingKey: string | null;
  onSwitch: (row: ProjectSetupRow, on: boolean) => void;
  onRemove: (row: ProjectSetupRow) => void;
  onAdd: (item: CapabilitySetupItem) => void;
}): JSX.Element {
  const copy = SECTION_COPY[kind];
  return (
    <SettingsCard title={copy.title} testId={`project-setup-section-${kind}s`}>
      {rows.length === 0 ? (
        <EmptyStateRow
          title={copy.empty}
          testId={`project-setup-section-${kind}s-empty`}
        />
      ) : (
        rows.map((row) => (
          <ProjectSetupRowView
            key={row.key}
            row={row}
            canEdit={canEdit}
            disabled={disabled}
            busy={pendingKey === row.key}
            onSwitch={(on) => onSwitch(row, on)}
            onRemove={() => onRemove(row)}
          />
        ))
      )}
      {canEdit && (
        <AddItemRow
          kind={kind}
          offered={offered}
          disabled={disabled}
          busy={pendingKey === `add:${kind}`}
          onAdd={onAdd}
        />
      )}
    </SettingsCard>
  );
}

function ProjectSetupRowView({
  row,
  canEdit,
  disabled,
  busy,
  onSwitch,
  onRemove,
}: {
  row: ProjectSetupRow;
  canEdit: boolean;
  disabled: boolean;
  busy: boolean;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  const detail = !row.available
    ? 'It was deleted or is no longer shared with the organization.'
    : row.description;
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`project-setup-row-${row.testKey}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-s font-medium fg-primary">{row.name}</p>
          {!row.available && (
            <Badge data-testid={`project-setup-unavailable-${row.testKey}`}>
              Unavailable
            </Badge>
          )}
        </div>
        <p
          className="text-xs text-pretty fg-secondary"
          data-testid={`project-setup-source-${row.testKey}`}
        >
          {PROJECT_SETUP_SOURCE_LABEL[row.source]}
        </p>
        {detail !== null && (
          <p className="line-clamp-2 text-xs text-pretty fg-tertiary">
            {detail}
          </p>
        )}
      </div>
      {row.source === 'organization' ? (
        <SettingsCardSwitch
          checked={row.on}
          disabled={disabled}
          busy={busy}
          label={`On in this project: ${row.name}`}
          onChange={onSwitch}
          dataTestId={`project-setup-toggle-${row.testKey}`}
        />
      ) : canEdit ? (
        <Button
          variant="secondary"
          size="compact"
          disabled={disabled}
          aria-label={`Remove ${row.name} from this project`}
          data-testid={`project-setup-remove-${row.testKey}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function AddItemRow({
  kind,
  offered,
  disabled,
  busy,
  onAdd,
}: {
  kind: ProjectSetupSectionKind;
  offered: readonly CapabilitySetupItem[];
  disabled: boolean;
  busy: boolean;
  onAdd: (item: CapabilitySetupItem) => void;
}): JSX.Element {
  const copy = SECTION_COPY[kind];
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <p className="text-xs text-pretty fg-secondary">
        {offered.length === 0
          ? copy.none
          : 'Add one of the organization’s items for everyone in this project.'}
      </p>
      <Button
        ref={anchorRef}
        variant="secondary"
        size="compact"
        disabled={disabled || offered.length === 0}
        aria-busy={busy}
        aria-expanded={open}
        data-testid={`project-setup-add-${kind}`}
        onClick={() => setOpen((current) => !current)}
      >
        {copy.add}
      </Button>
      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        role="dialog"
        aria-label={copy.add}
      >
        <PickerSearchList
          items={offered}
          getKey={(item) => capabilitySetupItemKey(item.ref)}
          getLabel={(item) => item.name}
          searchLabel={copy.search}
          listLabel={copy.add}
          emptyLabel="No matches."
          listMaxHeight="md"
          optionTestId={(item) =>
            `project-setup-add-option-${'id' in item.ref ? item.ref.id : item.name}`
          }
          onPick={(item) => {
            setOpen(false);
            onAdd(item);
          }}
          renderItem={(item) => (
            <PickerOptionContent>
              <PickerOptionLabel>{item.name}</PickerOptionLabel>
              {item.description !== null ? (
                <PickerOptionDescription>
                  {item.description}
                </PickerOptionDescription>
              ) : null}
            </PickerOptionContent>
          )}
        />
      </Picker>
    </div>
  );
}

const noop = (): void => undefined;

/** Sample rows for the loading state: plain, of the loaded shape. */
const SAMPLE_STATE: ProjectSetupState = {
  projectId: 'sample-project',
  organizationId: 'sample-organization',
  revision: 0,
  canEdit: false,
  removed: [],
  dismissedRecommendations: [],
  added: [],
  organizationDefaults: [
    {
      ref: { kind: 'skill', id: 'sample-skill-1' },
      name: 'Sample skill',
      description: 'What the skill does, in a sentence.',
      available: true,
    },
    {
      ref: { kind: 'plugin', id: 'sample-plugin-1' },
      name: 'Sample plugin',
      description: 'What the plugin does, in a sentence.',
      available: true,
    },
  ],
};

/**
 * The panel while it loads: the real sections with sample rows inside
 * `Skeleton`, so it measures them into bars in place.
 */
function ProjectSetupSkeleton({
  agentsAndPipelinesEnabled,
}: {
  agentsAndPipelinesEnabled: boolean;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading this project's shared setup"
      testId="project-setup-loading"
      className="w-full"
    >
      <div className="flex flex-col gap-8">
        {projectSetupSectionKinds(agentsAndPipelinesEnabled).map((kind) => (
          <ProjectSetupSection
            key={kind}
            kind={kind}
            rows={projectSetupRows(SAMPLE_STATE, kind)}
            offered={[]}
            canEdit={false}
            disabled
            pendingKey={null}
            onSwitch={noop}
            onRemove={noop}
            onAdd={noop}
          />
        ))}
      </div>
    </Skeleton>
  );
}
