'use client';

import { type JSX, useId } from 'react';
import type { PersonalProject } from '@canopy/protocol/organizations';
import type { PersonalProjectListState } from '@canopy/app-state/personal-organization-upgrade';
import {
  Fieldset,
  Stack,
  FormField,
  Notice,
  NoticeButton,
  TextInput,
} from '@canopy/ui-shared/components';
import { ShareCheckbox } from './ShareCheckbox';
import { TEAM_UPGRADE_COPY as COPY } from './personal-organization-upgrade-copy';

export interface CreateTeamStepProps {
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  /** `false` when this host cannot list Personal projects (web without a desktop). */
  readonly canBringProjects: boolean;
  readonly projects: PersonalProjectListState;
  readonly selection: readonly string[];
  readonly onProjectSelected: (workspaceId: string, selected: boolean) => void;
  readonly withoutProjects: boolean;
  readonly onRetryProjects: () => void;
  readonly onContinueWithoutProjects: () => void;
  readonly testIdPrefix: string;
}

function ProjectRow({
  project,
  selected,
  onChange,
  testIdPrefix,
}: {
  readonly project: PersonalProject;
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
  readonly testIdPrefix: string;
}): JSX.Element {
  return (
    <ShareCheckbox
      checked={selected}
      onChange={onChange}
      testId={`${testIdPrefix}-project-${project.workspaceId}`}
      inputTestId={`${testIdPrefix}-project-${project.workspaceId}-input`}
    >
      <span className="block">{project.name}</span>
      {project.kind === 'multi-repo' && (
        <span className="block text-xs fg-tertiary">{COPY.multiRepoHint}</span>
      )}
    </ShareCheckbox>
  );
}

/**
 * The inline step that turns Personal into a team: a name, the Personal
 * projects to include (all chosen at first).
 * Loading and failure never read as an empty project list, and a refresh
 * keeps the person's choices.
 */
export function CreateTeamStep({
  name,
  onNameChange,
  canBringProjects,
  projects,
  selection,
  onProjectSelected,
  withoutProjects,
  onRetryProjects,
  onContinueWithoutProjects,
  testIdPrefix: p,
}: CreateTeamStepProps): JSX.Element {
  const nameId = useId();
  const chosen = new Set(selection);

  const projectSection = ((): JSX.Element => {
    if (!canBringProjects) {
      return (
        <p
          className="text-s fg-secondary"
          data-testid={`${p}-projects-unavailable`}
        >
          {COPY.projectsUnavailable}
        </p>
      );
    }
    if (withoutProjects) {
      return (
        <p
          className="text-s fg-secondary"
          data-testid={`${p}-projects-skipped`}
        >
          {COPY.projectsSkipped}
        </p>
      );
    }
    const failed = projects.status === 'error';
    const loading = projects.status === 'loading' || projects.status === 'idle';
    return (
      <Fieldset
        gap="inline"
        legend={
          <span className="text-s font-medium fg-primary">
            {COPY.projectsLegend}
          </span>
        }
      >
        {failed && (
          <Notice
            errorSource="create-team-step-projects-failed"
            intent="destructive"
            data-testid={`${p}-projects-error`}
            actions={
              <>
                <NoticeButton onClick={onRetryProjects}>
                  {COPY.projectsRetry}
                </NoticeButton>
                <NoticeButton onClick={onContinueWithoutProjects}>
                  {COPY.projectsSkip}
                </NoticeButton>
              </>
            }
          >
            {COPY.projectsFailed}
          </Notice>
        )}
        {loading && projects.items.length === 0 && (
          <p
            className="text-s fg-secondary"
            role="status"
            data-testid={`${p}-projects-loading`}
          >
            {COPY.projectsLoading}
          </p>
        )}
        {projects.status === 'ready' && projects.items.length === 0 && (
          <p
            className="text-s fg-secondary"
            data-testid={`${p}-projects-empty`}
          >
            {COPY.projectsEmpty}
          </p>
        )}
        {projects.items.length > 0 && (
          <Stack gap="inline" data-testid={`${p}-projects`}>
            {projects.items.map((project) => (
              <ProjectRow
                key={project.workspaceId}
                project={project}
                selected={chosen.has(project.workspaceId)}
                onChange={(selected) =>
                  onProjectSelected(project.workspaceId, selected)
                }
                testIdPrefix={p}
              />
            ))}
          </Stack>
        )}
      </Fieldset>
    );
  })();

  return (
    <Stack gap="group" data-testid={`${p}-create-team`}>
      <FormField id={nameId} label={COPY.nameLabel}>
        {(control) => (
          <TextInput
            {...control}
            value={name}
            maxLength={256}
            placeholder={COPY.namePlaceholder}
            autoComplete="organization"
            onChange={(event) => onNameChange(event.target.value)}
            data-testid={`${p}-team-name`}
          />
        )}
      </FormField>
      {projectSection}
    </Stack>
  );
}
