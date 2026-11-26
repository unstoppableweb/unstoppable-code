'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DialogModal,
  Notice,
  PrivateMemoryAdvancedOption,
  buttonClassName,
  DialogFormField,
  TextInput,
  CopyDetailsButton,
  Heading,
} from '@canopy/ui-shared/components';
import {
  ORG_PROJECT_LIMITS,
  organizationIntegrationsPath,
  type CreateOrgProjectOutcome,
  type OrgProjectDetail,
  type OrgProjectGrant,
} from '@canopy/protocol/org-projects';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsLink, useSettingsClient, useSettingsPrivacy } from '../host';
import {
  settingsErrorFacts,
  useSettingsErrorCopy,
  type SettingsFailure,
} from '../errors';
import { GITHUB_PICKER_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import {
  GitHubRepositoryMultiPicker,
  type GitHubRepositoryMultiPickerItem,
} from '../github/GitHubRepositoryMultiPicker';
import {
  createOrganizationProjects,
  listOrganizationGitHubRepositories,
} from './team-api';
import { TeamProjectsGrantsEditor } from './team-projects-grants-editor';

type Repository = GitHubRepositoryMultiPickerItem;

interface GitHubConnectionLinkProps {
  orgId: string;
}
/**
 * Opens the organization's Integrations tab through the host's link, so the
 * desktop settings overlay routes it in place instead of leaving the page.
 * A secondary capsule: it sits in a checklist row or a notice, never as a
 * dialog's primary action.
 */
export function GitHubConnectionLink({
  orgId,
}: GitHubConnectionLinkProps): JSX.Element {
  return (
    <SettingsLink
      href={organizationIntegrationsPath(orgId)}
      className={buttonClassName({ variant: 'secondary', size: 'compact' })}
      data-testid="team-projects-connect-github"
    >
      Connect GitHub
    </SettingsLink>
  );
}

/** Route codes that the organization's GitHub connection page can fix. */
const NEEDS_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'github-not-connected',
  'github-installation-suspended',
]);

/**
 * Logs scope for the Projects tab's GitHub and project requests, shared by
 * the create dialog, the repository picker and the Repositories dialog.
 */
export const PROJECTS_ERROR_SCOPE = 'settings.organization.projects';

/** A failed projects request as its notice shows it. Never server text. */
export interface RequestFailure extends SettingsFailure {
  /** The organization's GitHub connection needs fixing first. */
  readonly needsConnection: boolean;
}

/** The notice for a failed request, with its failure already chosen. */
export function requestFailure(
  error: unknown,
  failure: SettingsFailure,
): RequestFailure {
  const { serverCode } = settingsErrorFacts(error);
  return {
    ...failure,
    needsConnection:
      serverCode !== undefined && NEEDS_CONNECTION_CODES.has(serverCode),
  };
}

interface RequestNoticeProps {
  failure: RequestFailure;
  orgId: string;
}
export function RequestNotice({
  failure,
  orgId,
}: RequestNoticeProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      actions={
        failure.needsConnection || failure.details !== undefined ? (
          <>
            {failure.details !== undefined ? (
              <CopyDetailsButton details={failure.details} />
            ) : null}
            {failure.needsConnection ? (
              <GitHubConnectionLink orgId={orgId} />
            ) : null}
          </>
        ) : undefined
      }
    >
      {failure.copy}
    </Notice>
  );
}

interface TeamProjectsCreateDialogProps {
  detail: OrganizationDetail;
  growthDisabled: boolean;
  onClose: () => void;
  onCreated: (projects: OrgProjectDetail[]) => void;
}
export function TeamProjectsCreateDialog({
  detail,
  growthDisabled,
  onClose,
  onCreated,
}: TeamProjectsCreateDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [step, setStep] = useState<'repositories' | 'definition' | 'outcomes'>(
    'repositories',
  );
  const [selected, setSelected] = useState<Repository[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [grants, setGrants] = useState<OrgProjectGrant[]>([]);
  // Off unless the admin chooses it; members inherit the definition's value.
  const [privateMemory, setPrivateMemory] = useState(false);
  const [results, setResults] = useState<CreateOrgProjectOutcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestFailure | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const submit = async (): Promise<void> => {
    if (submitting.current || growthDisabled || selected.length === 0) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await createOrganizationProjects(client, detail.id, {
        repositories: selected.map((repository) => {
          const displayName = names[repository.id]?.trim();
          return {
            providerRepoId: String(repository.id),
            owner: repository.owner,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            ...(displayName && displayName !== repository.name
              ? { displayName }
              : {}),
          };
        }),
        grants,
        ...(privateMemory ? { privateMemory: true } : {}),
      });
      if (!alive.current) return;
      setResults(response.results);
      onCreated(
        response.results.flatMap((result) =>
          result.outcome === 'created' && result.project
            ? [result.project]
            : [],
        ),
      );
      setStep('outcomes');
    } catch (err) {
      if (alive.current)
        setError(
          requestFailure(
            err,
            errorCopy.actionFailure(err, {
              action: 'create projects',
              known: GITHUB_PICKER_KNOWN_ERRORS,
            }),
          ),
        );
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <DialogModal
      title="Create project"
      dataTestId="team-projects-create-dialog"
      maxWidth="2xl"
      trapFocus
      onClose={(): void => {
        if (!submitting.current) onClose();
      }}
    >
      <div className="flex flex-col gap-5">
        {error && <RequestNotice failure={error} orgId={detail.id} />}
        <div hidden={step !== 'repositories'}>
          <GitHubRepositoryMultiPicker
            listRepositories={(request) =>
              listOrganizationGitHubRepositories(client, detail.id, request)
            }
            selected={selected}
            onSelectionChange={setSelected}
            disabled={busy || growthDisabled}
            maxSelected={ORG_PROJECT_LIMITS.repositoriesPerCreate}
            errorScope={PROJECTS_ERROR_SCOPE}
            knownErrors={GITHUB_PICKER_KNOWN_ERRORS}
            renderError={(err, failure) => (
              <RequestNotice
                failure={requestFailure(err, failure)}
                orgId={detail.id}
              />
            )}
            testIdPrefix="team-projects-repo"
          />
        </div>
        {step === 'repositories' && (
          <Button
            variant="primary"
            size="compact"
            className="self-start"
            disabled={selected.length === 0 || growthDisabled}
            onClick={(): void => setStep('definition')}
          >
            Next
          </Button>
        )}
        {step === 'definition' && (
          <>
            <Heading level={3} variant="section">
              Definition
            </Heading>
            {selected.map((repository) => (
              <div key={repository.id} className={blockClassName}>
                <DialogFormField
                  label={repository.fullName}
                  htmlFor={`team-projects-name-${repository.id}`}
                >
                  <TextInput
                    id={`team-projects-name-${repository.id}`}
                    density="settings"
                    data-testid={`team-projects-name-${repository.id}`}
                    aria-label={`Name for ${repository.fullName}`}
                    placeholder={repository.name}
                    maxLength={ORG_PROJECT_LIMITS.nameLength}
                    disabled={busy}
                    value={names[repository.id] ?? ''}
                    onChange={(event): void =>
                      setNames((current) => ({
                        ...current,
                        [repository.id]: event.target.value,
                      }))
                    }
                  />
                </DialogFormField>
              </div>
            ))}
            <PrivateMemoryAdvancedOption
              checked={privateMemory}
              onChange={setPrivateMemory}
              disabled={busy}
              dataTestId="team-projects-create-private-memory"
              disclosureTestId="team-projects-create-advanced"
            />
            <Heading level={3} variant="section">
              Grants
            </Heading>
            <TeamProjectsGrantsEditor
              detail={detail}
              grants={grants}
              setGrants={setGrants}
              disabled={busy}
              growthDisabled={growthDisabled}
            />
            <div className="flex gap-3">
              <Button
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={(): void => {
                  setError(null);
                  setStep('repositories');
                }}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="compact"
                data-testid="team-projects-create-submit"
                loading={busy}
                disabled={growthDisabled}
                onClick={(): void => {
                  void submit();
                }}
              >
                Create {selected.length} projects
              </Button>
            </div>
          </>
        )}
        {step === 'outcomes' && (
          <>
            <ul className="flex flex-col gap-3 text-s">
              {results.map((result) => (
                <li
                  key={result.providerRepoId}
                  data-testid={`team-projects-create-outcome-${result.providerRepoId}`}
                >
                  <span className={blockClassName || undefined}>
                    {selected.find(
                      (repository) =>
                        String(repository.id) === result.providerRepoId,
                    )?.fullName ?? result.providerRepoId}
                  </span>
                  <span className="pl-3">
                    {result.outcome === 'created'
                      ? 'Created'
                      : result.outcome === 'exists'
                        ? 'Already exists'
                        : result.error === 'repository-not-in-installation'
                          ? 'Not in your GitHub installation'
                          : // Any other per-repository reason is server
                            // text, which settings never render.
                            "Couldn't create this project."}
                  </span>
                </li>
              ))}
            </ul>
            <p role="status">
              {results.filter((result) => result.outcome === 'created').length}{' '}
              created,{' '}
              {results.filter((result) => result.outcome === 'exists').length}{' '}
              already existed,{' '}
              {results.filter((result) => result.outcome === 'error').length}{' '}
              failed
            </p>
            <Button
              variant="secondary"
              size="compact"
              className="self-start"
              onClick={onClose}
            >
              Done
            </Button>
          </>
        )}
      </div>
    </DialogModal>
  );
}
