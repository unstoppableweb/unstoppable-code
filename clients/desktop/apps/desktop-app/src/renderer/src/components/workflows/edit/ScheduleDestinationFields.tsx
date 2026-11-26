/**
 * CAN-5782: where one of a workflow's schedules runs. Every user workflow
 * takes schedules, so a schedule picks its project (or none, when the
 * workflow can run without one) and, on a project, what it runs in. The rest
 * of the schedule (its pipeline, inputs and time) is untouched.
 */
import { useId, type JSX } from 'react';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import {
  AutomationPipelineTargetFields,
  FormField,
  Select,
} from '@canopy/ui-shared/components';
import { SearchableSelect } from '@/components/shared/SearchableSelect';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import {
  applyGlobalPipelineSelection,
  applyPipelineRunInSelection,
  displayedPipelineRunIn,
  getAutomationWorktreeLabel,
  type FormState,
} from '@/components/automations/form/automationFormState';
import { projectPickerOption } from '@/components/automations/form/projectPickerOption';
import { usePipelineTaskList } from '@/components/automations/usePipelineTaskList';
import type { useProjectsStore } from '@/stores/projectsStore';

type Project = ReturnType<typeof useProjectsStore.getState>['projects'][number];

export interface ScheduleDestinationFieldsProps {
  readonly state: FormState;
  readonly projects: readonly Project[];
  /** Where the workflow declares it can run. */
  readonly scopes: readonly PipelineExecutionScope[];
  readonly disabled: boolean;
  readonly onChange: (next: FormState) => void;
}

/**
 * The schedule moved onto `project`, in what the workflow can run in there:
 * a new worktree each run when it runs in worktrees, else the project folder.
 */
function scheduleOnProject(
  state: FormState,
  project: Project,
  scopes: readonly PipelineExecutionScope[],
): FormState {
  const runIn =
    project.type !== 'cowork' && scopes.includes('worktree')
      ? 'new_worktree'
      : 'project';
  // A multi-repo project with no source root runs in one of its
  // repositories: the first until the person picks another.
  const repoId =
    project.type === 'multi-repo' && !project.sourceRepoPath
      ? (project.repos[0]?.id ?? '')
      : '';
  return {
    ...state,
    actionType: 'worktree_pipeline',
    workspaceId: project.id,
    chatProjectId: '',
    repoId,
    baseWorktreeId: '',
    baseBranch: '',
    sidebarGroupName: '',
    targetRequirement: undefined,
    pipelineTargetKind: runIn,
    pipelineTaskId: '',
    pipelineTargetExplicit: true,
  };
}

export function ScheduleDestinationFields({
  state,
  projects,
  scopes,
  disabled,
  onChange: onDestinationChange,
}: ScheduleDestinationFieldsProps): JSX.Element {
  // A schedule on this page runs this user workflow: a destination edit
  // names its source, so an older sourceless record moved onto a project
  // keeps running it, not that project's workflow of the same ID.
  const onChange = (next: FormState): void =>
    onDestinationChange({ ...next, pipelineSource: 'user' });
  const runsWithoutProject = scopes.includes('global');
  const global = state.pipelineTargetKind === 'global';
  const project = global
    ? undefined
    : projects.find((candidate) => candidate.id === state.workspaceId);
  const projectKind = project?.type === 'cowork' ? 'cowork' : 'code';
  const runIn = displayedPipelineRunIn(state, projectKind === 'cowork');
  const taskList = usePipelineTaskList(
    project !== undefined && runIn === 'task' ? project.id : undefined,
  );
  const repoLabelId = useId();
  // A project-folder run on a multi-repo project runs in its source root or
  // one of its repositories, as the automation editor offers.
  const repoOptions =
    project?.type === 'multi-repo' && runIn === 'project'
      ? [
          ...(project.sourceRepoPath
            ? [
                {
                  value: WORKSPACE_ROOT_REPO_ID,
                  label: WORKSPACE_ROOT_REPO_NAME,
                },
              ]
            : []),
          ...project.repos.map((repo) => ({
            value: repo.id,
            label: repo.name,
          })),
        ]
      : undefined;
  const repoValue =
    state.repoId !== ''
      ? state.repoId
      : project?.type === 'multi-repo' && project.sourceRepoPath
        ? WORKSPACE_ROOT_REPO_ID
        : null;
  const choose = (id: string): void => {
    if (id === '') {
      if (!global) onChange(applyGlobalPipelineSelection(state));
      return;
    }
    if (!global && id === state.workspaceId) return;
    const picked = projects.find((candidate) => candidate.id === id);
    if (picked !== undefined)
      onChange(scheduleOnProject(state, picked, scopes));
  };
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="workflow-schedule-destination"
    >
      <FormField label="Project">
        {(control) => (
          <SearchableSelect
            id={control.id}
            value={project?.id ?? ''}
            options={projects.map(projectPickerOption)}
            onChange={choose}
            placeholder="Choose a project"
            {...(runsWithoutProject
              ? {
                  emptyOption: {
                    id: '' as const,
                    label: 'No project',
                    subtitle: 'Runs without a project',
                  },
                }
              : {})}
            searchPlaceholder="Search projects"
            emptyListMessage="No matching projects"
            disabled={disabled}
            testId="workflow-schedule-project"
          />
        )}
      </FormField>
      {project !== undefined ? (
        <AutomationPipelineTargetFields
          projectKind={projectKind}
          value={runIn}
          onChange={(kind): void =>
            onChange(applyPipelineRunInSelection(state, kind, runIn))
          }
          taskId={state.pipelineTaskId}
          tasks={taskList.tasks}
          onTaskChange={(taskId): void =>
            onChange({ ...state, pipelineTaskId: taskId })
          }
          onRetryTasks={taskList.retry}
          disabled={disabled}
          testIdPrefix="workflow-schedule"
        />
      ) : null}
      {project !== undefined &&
      project.type !== 'cowork' &&
      runIn === 'new_worktree' ? (
        <FormField label={`Base ${WORKTREE_UNIT_LABEL}`}>
          {(control) => (
            <SearchableSelect
              id={control.id}
              value={state.baseWorktreeId}
              options={project.worktrees.map((worktree) => ({
                id: worktree.id,
                label: getAutomationWorktreeLabel(worktree),
                maskInReplay: true,
              }))}
              onChange={(baseWorktreeId): void =>
                onChange({
                  ...state,
                  baseWorktreeId,
                  ...(baseWorktreeId ? { baseBranch: '' } : {}),
                })
              }
              placeholder="Project default"
              emptyOption={{
                id: '',
                label: 'Project default',
                subtitle: "Use the project's default branch",
              }}
              searchPlaceholder="Search worktrees"
              emptyListMessage="No matching worktrees"
              disabled={disabled}
              testId="workflow-schedule-base-worktree"
            />
          )}
        </FormField>
      ) : null}
      {repoOptions !== undefined ? (
        <div className="flex flex-col gap-1 text-xs fg-secondary">
          <span id={repoLabelId}>Repository</span>
          <Select
            options={repoOptions}
            value={repoValue}
            onValueChange={(repoId): void => onChange({ ...state, repoId })}
            placeholder="Choose a repository"
            disabled={disabled || repoOptions.length === 0}
            aria-labelledby={repoLabelId}
            data-testid="workflow-schedule-repo"
          />
        </div>
      ) : null}
    </div>
  );
}
