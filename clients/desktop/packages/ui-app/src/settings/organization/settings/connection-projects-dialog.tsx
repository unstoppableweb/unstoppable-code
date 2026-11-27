'use client';

import { useEffect, useState, type JSX } from 'react';
import {
  Button,
  ChoiceField,
  ChoiceList,
  DialogModal,
  EmptyStateRow,
  ErrorBanner,
  Notice,
  Skeleton,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { OrganizationConnection } from '@canopy/protocol/canopy-core';
import { useSettingsClient } from '../../host';
import {
  useSettingsErrorCopy,
  useSettingsLoadFailure,
  type KnownSettingsError,
  type SettingsFailure,
} from '../../errors';
import { listOrganizationProjects } from '../team-api';
import {
  initialChosenProjects,
  saveConnectionProjects,
  type ConnectionProject,
  type ConnectionProjectsMode,
} from './connection-projects-model';

const ERROR_SCOPE = 'settings.organization.connectors.projects';

const PROJECT_PAGE_LIMIT = 500;
/**
 * A guard against a cursor that never ends, far above any organization's
 * projects. Reaching it fails the load rather than offer a partial list,
 * since saving from one would change projects the person never saw.
 */
const PROJECT_PAGES_MAX = 200;

/** The organization's active projects, every page of them. */
async function activeProjects(
  client: ReturnType<typeof useSettingsClient>,
  organizationId: string,
): Promise<ConnectionProject[]> {
  const projects: ConnectionProject[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === PROJECT_PAGES_MAX)
      throw new Error('The project list did not end.');
    const result = await listOrganizationProjects(
      client,
      organizationId,
      'management',
      {
        limit: PROJECT_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    for (const project of result.data)
      if (
        project.state === 'ACTIVE' &&
        project.organizationId === organizationId
      )
        projects.push({ id: project.id, name: project.name });
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A refused save the dialog answers by reading where it is used again: the
 * default or a changed project moved since it opened, or the connection was
 * deleted. Each says what is shown now, since the reload replaces it.
 */
const SAVE_KNOWN: readonly KnownSettingsError[] = [
  {
    status: 409,
    serverCode: 'core.integration.sharedConnection.changed',
    copy: "Couldn't save. Someone else changed where it's used, and the latest is shown here.",
  },
  {
    status: 409,
    serverCode: 'core.integration.sharedConnection.tooMany',
    copy: "Couldn't save. A project or the organization's defaults can't hold more connectors, or the connector is already in as many projects as it can be.",
  },
  {
    status: 404,
    copy: "Couldn't save. It was deleted from the organization, or a project was.",
  },
];

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export interface ConnectionProjectsDialogProps {
  readonly organizationId: string;
  readonly connection: OrganizationConnection;
  readonly onClose: () => void;
  /** Something was saved; the page reads its connections again. */
  readonly onSaved: () => void;
}

/**
 * Where one of the organization's connections is used: every project (the
 * organization default, which new projects get too) or only the projects
 * chosen here. It saves in one update the server applies in one
 * transaction, sending only the projects changed here.
 */
export function ConnectionProjectsDialog({
  organizationId,
  connection,
  onClose,
  onSaved,
}: ConnectionProjectsDialogProps): JSX.Element {
  const client = useSettingsClient();
  const loadFailure = useSettingsLoadFailure(ERROR_SCOPE);
  const errorCopy = useSettingsErrorCopy(ERROR_SCOPE);
  /**
   * What the dialog opened from, read fresh from the server: the listed
   * projects, the connection, and the projects that used it. Read again
   * only on a retry or after a refused save, never when the page behind
   * reloads, so unsaved choices survive a background refresh.
   */
  const [baseline, setBaseline] = useState<{
    readonly connection: OrganizationConnection;
    readonly projects: readonly ConnectionProject[];
    readonly initial: ReadonlySet<string>;
  } | null>(null);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mode, setMode] = useState<ConnectionProjectsMode>(
    connection.organizationDefault ? 'every' : 'chosen',
  );
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SettingsFailure | null>(null);
  const connectionId = connection.id;

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      try {
        const [listed, connections] = await Promise.all([
          activeProjects(client, organizationId),
          client.read('organization.settings.connections', { organizationId }),
        ]);
        const current = connections.connections.find(
          (item) => item.id === connectionId,
        );
        if (current === undefined)
          throw new Error('The connection is no longer the organization’s.');
        if (!active) return;
        const initial = initialChosenProjects(current, listed);
        setBaseline({ connection: current, projects: listed, initial });
        setMode(current.organizationDefault ? 'every' : 'chosen');
        setChosen(initial);
        setLoadError(null);
      } catch (error) {
        if (active) setLoadError(loadFailure(error));
      }
    })();
    return (): void => {
      active = false;
    };
  }, [client, organizationId, connectionId, loadFailure, loadAttempt]);

  const projects = baseline?.projects ?? null;
  const changed =
    baseline !== null &&
    (mode !== (baseline.connection.organizationDefault ? 'every' : 'chosen') ||
      !sameSet(chosen, baseline.initial));

  const chooseMode = (next: ConnectionProjectsMode): void => {
    // The selected option again changes nothing, so clearings stand.
    if (next === mode) return;
    setSaveError(null);
    setMode(next);
    // Every project starts with all of them ticked; the person clears the
    // ones to leave out. Choosing projects keeps what is ticked.
    if (next === 'every' && projects !== null)
      setChosen(new Set(projects.map((project) => project.id)));
  };

  const toggle = (projectId: string): void => {
    setSaveError(null);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (baseline === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveConnectionProjects({
        client,
        organizationId,
        connectionId: baseline.connection.id,
        projects: baseline.projects,
        mode,
        chosen,
        initial: baseline.initial,
        initialDefault: baseline.connection.organizationDefault,
      });
      onSaved();
      onClose();
    } catch (error) {
      // Project names stay out of the logged action.
      setSaveError(
        errorCopy.actionFailure(error, {
          action: 'update project access',
          known: SAVE_KNOWN,
        }),
      );
      // A refused or unconfirmed save: show where it is used now. The old
      // state goes first, so nothing can be edited or saved over it until
      // the fresh read lands (or fails, and offers to try again).
      setBaseline(null);
      onSaved();
      setLoadAttempt((attempt) => attempt + 1);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogModal
      title={
        <>
          Choose projects for{' '}
          <span className={REPLAY_MASK_CLASS}>{connection.name}</span>
        </>
      }
      subtitle="People on these projects can use it without seeing its sign-in."
      dataTestId="organization-connector-projects-dialog"
      maxWidth="md"
      trapFocus
      closeOnBackdrop={!saving}
      closeButtonDisabled={saving}
      onClose={(): void => {
        if (!saving) onClose();
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={saving}
            onClick={onClose}
            data-testid="organization-connector-projects-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            loadingLabel="Saving…"
            disabled={!changed || saving}
            onClick={(): void => void save()}
            data-testid="organization-connector-projects-save"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <ChoiceList
          kind="radio"
          aria-label="Where it's used"
          data-testid="organization-connector-projects-mode"
        >
          <ChoiceField
            layout="row"
            kind="radio"
            checked={mode === 'every'}
            disabled={saving || projects === null}
            onChange={(): void => chooseMode('every')}
            data-testid="organization-connector-projects-mode-every"
            label="Every project"
            description="Projects created later get it too"
          />
          <ChoiceField
            layout="row"
            kind="radio"
            checked={mode === 'chosen'}
            disabled={saving || projects === null}
            onChange={(): void => chooseMode('chosen')}
            data-testid="organization-connector-projects-mode-chosen"
            label="Only the projects you choose"
            description="Projects created later don't get it"
          />
        </ChoiceList>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-pretty fg-secondary">
            {mode === 'every'
              ? 'Clear a project to leave it out.'
              : 'Choose the projects that can use it.'}
          </p>
          {loadError !== null ? (
            <ErrorBanner
              errorSource="organization-connector-projects-load"
              testId="organization-connector-projects-load-error"
              className=""
              error={loadError.copy}
              details={loadError.details}
              onRetry={(): void => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
              }}
            />
          ) : projects === null ? (
            <ProjectListSkeleton />
          ) : projects.length === 0 ? (
            <EmptyStateRow
              title="The organization doesn't have any projects yet"
              testId="organization-connector-projects-empty"
            />
          ) : (
            <ChoiceList
              aria-label="Projects"
              height="bounded"
              data-testid="organization-connector-projects-list"
            >
              {projects.map((project) => (
                <ChoiceField
                  key={project.id}
                  layout="row"
                  checked={chosen.has(project.id)}
                  disabled={saving}
                  onChange={(): void => toggle(project.id)}
                  data-testid={`organization-connector-projects-row-${project.id}`}
                  label={
                    <span className={`block truncate ${REPLAY_MASK_CLASS}`}>
                      {project.name}
                    </span>
                  }
                />
              ))}
            </ChoiceList>
          )}
        </div>
        <Notice data-testid="organization-connector-projects-access">
          Only people added to a project can use it there. Add them from the
          project&apos;s Access. Existing projects not listed here, such as
          private ones, never get it from here. Projects created later, private
          ones too, get it while it&apos;s on for every project.
        </Notice>
        <ErrorBanner
          errorSource="organization-connector-projects-save"
          testId="organization-connector-projects-error"
          className=""
          error={saveError?.copy}
          details={saveError?.details}
        />
      </div>
    </DialogModal>
  );
}

const SAMPLE_PROJECTS = ['Sample project', 'Another project', 'Third project'];

function ProjectListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading projects"
      testId="organization-connector-projects-loading"
      className="w-full"
    >
      <ChoiceList aria-label="Projects">
        {SAMPLE_PROJECTS.map((name) => (
          <ChoiceField
            key={name}
            layout="row"
            checked={false}
            disabled
            label={name}
          />
        ))}
      </ChoiceList>
    </Skeleton>
  );
}
