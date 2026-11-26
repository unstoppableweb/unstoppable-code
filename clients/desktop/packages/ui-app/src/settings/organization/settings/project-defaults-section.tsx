'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Badge,
  DelayedLoadingPlaceholder,
  EmptyState,
  EmptyStateRow,
  ErrorBanner,
  Notice,
  PageSearchField,
  PageSearchRow,
  SearchEmptyState,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  CAPABILITY_SETUP_INVALID_ITEM_CODE,
  CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
} from '@canopy/protocol/settings/operations-organization';
import { useSettingsClient } from '../../host';
import {
  findKnownSettingsError,
  useSettingsErrorCopy,
  useSettingsLoadFailure,
  type KnownSettingsError,
  type SettingsFailure,
} from '../../errors';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  CapabilitySetupConnectorRef,
  CapabilitySetupItemRef,
} from '@canopy/protocol/canopy-core';
import {
  availableDefaultRefs,
  defaultConnectorsWith,
  matchesProjectDefaultSearch,
  projectDefaultConnectorRows,
  projectDefaultRows,
  projectDefaultsWith,
  type ProjectDefaultConnectorRow,
  type ProjectDefaultKind,
  type ProjectDefaultRow,
  type ProjectDefaultsState,
} from './project-defaults-model';

const PROJECT_DEFAULTS_ERROR_SCOPE = 'settings.organization.project-defaults';

/** A server that predates the page (desktop against an older web). */
const LOAD_KNOWN: readonly KnownSettingsError[] = [
  {
    code: 'unsupported_server',
    copy: "Project defaults aren't available yet.",
  },
];

/**
 * A refused save the page answers by reading the defaults again: they
 * changed since this page read them, or an item stopped being the
 * organization's. Both say what is shown now, since the reload replaces it.
 */
const SAVE_KNOWN: readonly KnownSettingsError[] = [
  {
    status: 409,
    serverCode: CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
    copy: "Couldn't update project defaults. Someone else changed them, and the latest are shown here.",
  },
  {
    status: 400,
    serverCode: CAPABILITY_SETUP_INVALID_ITEM_CODE,
    copy: "Couldn't update project defaults. An item is no longer shared with this organization, and the latest are shown here.",
  },
];

interface ProjectDefaultsSectionProps {
  detail: OrganizationDetail;
  /**
   * The organization's Agents (CAN-6237, phase 10a) and pipelines (phase
   * 10b) can be defaults while organization projects are on, the switch
   * that keeps a desktop's organization resources to the organization's
   * workspaces. Off, the page lists neither, and saves keep their defaults
   * as stored.
   */
  agentsAndPipelinesEnabled?: boolean;
}

/** The cards the page shows, in order. */
function shownKinds(
  agentsAndPipelinesEnabled: boolean,
): readonly ProjectDefaultKind[] {
  return agentsAndPipelinesEnabled
    ? ['skill', 'plugin', 'agent', 'pipeline']
    : ['skill', 'plugin'];
}

/**
 * The organization's project defaults (CAN-6237, spec FR-4.2): the skills
 * and plugins the organization owns, each with a switch that makes it a
 * default for every project in the organization, new ones included. Owners
 * and admins change them; members read them. The server decides `canEdit`
 * and re-checks every save. A page search row narrows every card at once by
 * name or description, as the organization's other searched lists do.
 */
export function ProjectDefaultsSection({
  detail,
  agentsAndPipelinesEnabled = false,
}: ProjectDefaultsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const orgId = detail.id;
  const loadFailure = useSettingsLoadFailure(PROJECT_DEFAULTS_ERROR_SCOPE);
  const errorCopy = useSettingsErrorCopy(PROJECT_DEFAULTS_ERROR_SCOPE);
  const [state, setState] = useState<ProjectDefaultsState | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [saveError, setSaveError] = useState<SettingsFailure | null>(null);
  /** The row being saved and the value it was switched to. */
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly on: boolean;
  } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  /**
   * Set when a save found the shown defaults out of date: the switches stay
   * off until a read replaces them, so no save goes out at the old revision.
   */
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  // A read started for an older attempt or organization never lands.
  const generation = useRef(0);

  const reload = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    void (async (): Promise<void> => {
      try {
        const result = await client.read(
          'organization.settings.projectDefaults',
          {
            organizationId: orgId,
          },
        );
        if (!active || current !== generation.current) return;
        setState({
          revision: result.revision,
          items: result.items,
          candidates: result.candidates,
          canEdit: result.canEdit,
          connectors: result.connectors ?? null,
        });
        setLoadError(null);
        setStale(false);
      } catch (error) {
        if (!active || current !== generation.current) return;
        setLoadError(loadFailure(error, LOAD_KNOWN));
      }
    })();
    return (): void => {
      active = false;
    };
  }, [client, orgId, loadFailure, loadAttempt]);

  /**
   * Saves one switch: the items to store, and the default connections when
   * a connection's switch changed (left out otherwise, which keeps them).
   */
  const save = async (
    key: string,
    on: boolean,
    write: {
      readonly items: CapabilitySetupItemRef[];
      readonly connectors?: CapabilitySetupConnectorRef[];
    },
  ): Promise<void> => {
    if (state === null || pending !== null) return;
    setPending({ key, on });
    setSaveError(null);
    const readAt = generation.current;
    try {
      const saved = await client.write(
        'organization.settings.projectDefaults.update',
        {
          organizationId: orgId,
          expectedRevision: state.revision,
          ...write,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (readAt === generation.current)
        setState((previous) =>
          previous === null
            ? previous
            : {
                ...previous,
                revision: saved.revision,
                items: saved.items,
                connectors:
                  previous.connectors === null || !saved.connectors
                    ? previous.connectors
                    : { ...previous.connectors, items: saved.connectors.items },
              },
        );
    } catch (error) {
      setSaveError(
        errorCopy.actionFailure(error, {
          action: 'update project defaults',
          known: SAVE_KNOWN,
        }),
      );
      if (findKnownSettingsError(error, SAVE_KNOWN) !== undefined) {
        setStale(true);
        reload();
      }
    } finally {
      setPending(null);
    }
  };

  const toggle = (row: ProjectDefaultRow, on: boolean): Promise<void> =>
    state === null
      ? Promise.resolve()
      : save(row.key, on, {
          items: projectDefaultsWith(state.items, row.ref, on),
        });

  const toggleConnector = (
    row: ProjectDefaultConnectorRow,
    on: boolean,
  ): Promise<void> =>
    state === null || state.connectors === null
      ? Promise.resolve()
      : save(row.key, on, {
          items: availableDefaultRefs(state.items),
          connectors: defaultConnectorsWith(
            state.connectors.items,
            row.ref,
            on,
          ),
        });

  if (state === null) {
    if (loadError !== null)
      return (
        <ErrorBanner
          errorSource="organization-project-defaults-load"
          testId="organization-project-defaults-load-error"
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
        <ProjectDefaultsSkeleton />
      </DelayedLoadingPlaceholder>
    );
  }

  const kinds = shownKinds(agentsAndPipelinesEnabled);
  const rowsByKind = kinds.map(
    (kind) => [kind, projectDefaultRows(state, kind)] as const,
  );
  const total = rowsByKind.reduce((sum, [, rows]) => sum + rows.length, 0);
  // While searching, a card keeps only its matching rows, and a card with
  // none is left out rather than saying it has nothing shared. With nothing
  // shared the search row is gone, so a query kept from before a reload
  // applies to nothing and every empty card stays.
  const searching = total > 0 && query.trim() !== '';
  const matchedByKind = rowsByKind
    .map(
      ([kind, rows]) =>
        [
          kind,
          rows.filter((row) => matchesProjectDefaultSearch(row, query)),
        ] as const,
    )
    .filter(([, rows]) => !searching || rows.length > 0);
  const matchCount = matchedByKind.reduce(
    (sum, [, rows]) => sum + rows.length,
    0,
  );
  const busy = pending !== null || !state.canEdit || stale;
  const shown = (row: ProjectDefaultRow): ProjectDefaultRow =>
    pending?.key === row.key ? { ...row, isDefault: pending.on } : row;
  const cards = (
    <div className="flex flex-col gap-10">
      {matchedByKind.map(([kind, rows]) => (
        <ProjectDefaultsCard
          key={kind}
          kind={kind}
          rows={rows.map(shown)}
          disabled={busy}
          pendingKey={pending?.key ?? null}
          onToggle={(row, on) => void toggle(row, on)}
        />
      ))}
    </div>
  );

  return (
    <div
      className="flex flex-col gap-10"
      data-testid="organization-project-defaults"
    >
      {!state.canEdit && (
        <Notice data-testid="organization-project-defaults-read-only">
          Only owners and admins can change project defaults.
        </Notice>
      )}
      {/* A reload that failed after a save conflict: the list shown is out of
          date, and stays read-only until a retry reads it again. */}
      {stale && loadError !== null && (
        <ErrorBanner
          errorSource="organization-project-defaults-load"
          testId="organization-project-defaults-load-error"
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
        errorSource="organization-project-defaults-save"
        testId="organization-project-defaults-error"
        className=""
        error={saveError?.copy}
        details={saveError?.details}
      />
      {/* With nothing shared, the page is only empty when it has no
          connectors either. Beside the Connectors card, each card keeps its
          place with an empty row, as it looks once something is shared. */}
      {total === 0 && state.connectors !== null ? (
        cards
      ) : total === 0 ? (
        agentsAndPipelinesEnabled ? (
          <EmptyState
            testId="organization-project-defaults-empty"
            title="No skills, plugins, model presets or workflows are shared with this organization yet"
            subtitle="Share one with this organization to make it a default for every project."
          />
        ) : (
          <EmptyState
            testId="organization-project-defaults-empty"
            title="No skills or plugins are shared with this organization yet"
            subtitle="Share a skill or plugin with this organization to make it a default for every project."
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          <PageSearchRow>
            <PageSearchField
              aria-label="Search project defaults"
              placeholder="Search project defaults"
              data-testid="organization-project-defaults-search"
              clearTestId="organization-project-defaults-search-clear"
              value={query}
              onValueChange={setQuery}
              count={searching ? `${matchCount} of ${total}` : undefined}
            />
          </PageSearchRow>
          {matchedByKind.length === 0 ? (
            <SearchEmptyState
              testId="organization-project-defaults-no-results"
              title="Nothing matches your search."
              actionLabel="Clear search"
              onAction={() => setQuery('')}
              actionTestId="organization-project-defaults-clear-search"
            />
          ) : (
            cards
          )}
        </div>
      )}
      {state.connectors !== null && (
        <ProjectDefaultConnectorsCard
          rows={projectDefaultConnectorRows(state.connectors).map((row) =>
            pending?.key === row.key ? { ...row, isDefault: pending.on } : row,
          )}
          disabled={busy}
          pendingKey={pending?.key ?? null}
          onToggle={(row, on) => void toggleConnector(row, on)}
        />
      )}
    </div>
  );
}

/**
 * The organization's connections (CAN-6246): a connection that is on is
 * a default for every project, so people on each project can use it.
 */
function ProjectDefaultConnectorsCard({
  rows,
  disabled,
  pendingKey,
  onToggle,
}: {
  rows: readonly ProjectDefaultConnectorRow[];
  disabled: boolean;
  pendingKey: string | null;
  onToggle: (row: ProjectDefaultConnectorRow, on: boolean) => void;
}): JSX.Element {
  return (
    <SettingsCard
      title="Connectors"
      subtitle="A connector that is on is in every project, including new ones. People on a project can use it."
      testId="organization-project-defaults-connectors"
    >
      {rows.length === 0 ? (
        <EmptyStateRow
          title="The organization doesn't hold any connections yet"
          testId="organization-project-defaults-connectors-empty"
        />
      ) : (
        rows.map((row) => (
          <div
            key={row.key}
            className={SETTINGS_CARD_ROW_CLASS}
            data-testid={`organization-project-default-row-${row.key}`}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <p
                  className={`truncate text-s font-medium fg-primary ${REPLAY_MASK_CLASS}`}
                >
                  {row.name}
                </p>
                {!row.available && <Badge>Unavailable</Badge>}
                {row.needsSignIn && <Badge tone="warning">Needs sign-in</Badge>}
              </div>
              {!row.available && (
                <p className="text-xs text-pretty fg-secondary">
                  It was deleted from the organization.
                </p>
              )}
            </div>
            <SettingsCardSwitch
              checked={row.isDefault}
              disabled={disabled || (!row.available && !row.isDefault)}
              busy={pendingKey === row.key}
              label={`Default for every project: ${row.name}`}
              onChange={(on) => onToggle(row, on)}
              dataTestId={`organization-project-default-toggle-${row.key}`}
            />
          </div>
        ))
      )}
    </SettingsCard>
  );
}

const CARD_COPY: Record<
  ProjectDefaultKind,
  { title: string; subtitle: string; empty: string }
> = {
  skill: {
    title: 'Skills',
    subtitle:
      'A skill that is on is a default for every project, including new ones.',
    empty: 'No skills are shared with this organization yet',
  },
  plugin: {
    title: 'Plugins',
    subtitle:
      'A plugin that is on is a default for every project, including new ones.',
    empty: 'No plugins are shared with this organization yet',
  },
  agent: {
    title: 'Model presets',
    subtitle:
      'A model preset that is on is available in every project, including new ones.',
    empty: 'No model presets are shared with this organization yet',
  },
  // The `pipeline` kind is shown as a workflow, as the Workflows library
  // and Customize name it.
  pipeline: {
    title: 'Workflows',
    subtitle:
      'A workflow that is on is in every project’s workflow library, including new ones. Its schedules stay with whoever set them up.',
    empty: 'No workflows are shared with this organization yet',
  },
};

function ProjectDefaultsCard({
  kind,
  rows,
  disabled,
  pendingKey,
  onToggle,
}: {
  kind: ProjectDefaultKind;
  rows: readonly ProjectDefaultRow[];
  disabled: boolean;
  pendingKey: string | null;
  onToggle: (row: ProjectDefaultRow, on: boolean) => void;
}): JSX.Element {
  const copy = CARD_COPY[kind];
  return (
    <SettingsCard
      title={copy.title}
      subtitle={copy.subtitle}
      testId={`organization-project-defaults-${kind}s`}
    >
      {rows.length === 0 ? (
        <EmptyStateRow
          title={copy.empty}
          testId={`organization-project-defaults-${kind}s-empty`}
        />
      ) : (
        rows.map((row) => (
          <ProjectDefaultRowView
            key={row.key}
            row={row}
            disabled={disabled}
            busy={pendingKey === row.key}
            onToggle={(on) => onToggle(row, on)}
          />
        ))
      )}
    </SettingsCard>
  );
}

function ProjectDefaultRowView({
  row,
  disabled,
  busy,
  onToggle,
}: {
  row: ProjectDefaultRow;
  disabled: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  const testKey = `${row.ref.kind}-${row.ref.id}`;
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`organization-project-default-row-${testKey}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-s font-medium fg-primary">{row.name}</p>
          {!row.available && (
            <Badge
              data-testid={`organization-project-default-unavailable-${testKey}`}
            >
              Unavailable
            </Badge>
          )}
        </div>
        {!row.available ? (
          <p className="text-xs text-pretty fg-secondary">
            It was deleted or is no longer shared with this organization.
          </p>
        ) : row.description !== null ? (
          <p className="line-clamp-2 text-xs text-pretty fg-secondary">
            {row.description}
          </p>
        ) : null}
      </div>
      <SettingsCardSwitch
        checked={row.isDefault}
        disabled={disabled}
        busy={busy}
        label={`Default for every project: ${row.name}`}
        onChange={onToggle}
        dataTestId={`organization-project-default-toggle-${testKey}`}
      />
    </div>
  );
}

const noop = (): void => undefined;

/** Sample rows for the loading state: plain, of the loaded shape. */
const SAMPLE_STATE: ProjectDefaultsState = {
  revision: 0,
  canEdit: false,
  connectors: null,
  items: [],
  candidates: [
    {
      ref: { kind: 'skill', id: 'sample-skill-1' },
      name: 'Sample skill',
      description: 'What the skill does, in a sentence.',
      available: true,
    },
    {
      ref: { kind: 'skill', id: 'sample-skill-2' },
      name: 'Another skill',
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
 * The page while it loads: the real cards with sample rows inside
 * `Skeleton`, so it measures them into bars in place.
 */
function ProjectDefaultsSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading project defaults"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <div className="flex flex-col gap-10">
        <ProjectDefaultsCard
          kind="skill"
          rows={projectDefaultRows(SAMPLE_STATE, 'skill')}
          disabled
          pendingKey={null}
          onToggle={noop}
        />
        <ProjectDefaultsCard
          kind="plugin"
          rows={projectDefaultRows(SAMPLE_STATE, 'plugin')}
          disabled
          pendingKey={null}
          onToggle={noop}
        />
      </div>
    </Skeleton>
  );
}
