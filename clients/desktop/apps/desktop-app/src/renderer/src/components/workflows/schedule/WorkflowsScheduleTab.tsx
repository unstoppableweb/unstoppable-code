import { useCallback, useMemo, useState, type JSX } from 'react';
import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  FilterDropdown,
  type FilterOption,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { WORKFLOW_NO_PROJECT } from '@canopy/ui-app/workflows';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { matchesScheduleProject } from '@/lib/workflows/schedule-filter';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { AutomationsCalendar } from '../../automations/calendar/AutomationsCalendar';
import {
  loadCalendarView,
  saveCalendarView,
  type CalendarView,
} from '../../automations/calendar/calendarPreferences';

export interface WorkflowsScheduleTabProps {
  /** Automations in the selected context. */
  readonly activities: readonly ScheduledActivity[];
  readonly recentRuns: readonly ScheduledActivityRun[];
  readonly scope: AutomationScope;
  readonly describeAction: (action: AutomationAction) => string;
  /** An upcoming chip: opens that automation for editing. */
  readonly onEdit: (activity: ScheduledActivity) => void;
  /** A past or running chip: opens what that run did. */
  readonly onOpenRun: (run: ScheduledActivityRun) => void;
}

/**
 * Workflows → Schedule (CAN-3981): the calendar of scheduled automations and
 * their recorded runs as the whole tab. The Project filter narrows the
 * automations and their runs before they reach the calendar.
 */
export function WorkflowsScheduleTab({
  activities,
  recentRuns,
  scope,
  describeAction,
  onEdit,
  onOpenRun,
}: WorkflowsScheduleTabProps): JSX.Element {
  const project = useWorkflowsViewStore((state) => state.scheduleProject);
  const setProject = useWorkflowsViewStore((state) => state.setScheduleProject);
  const [calendarView, setCalendarView] =
    useState<CalendarView>(loadCalendarView);
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());
  const [showDisabled, setShowDisabled] = useState(false);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(
    null,
  );

  const shownActivities = useMemo(
    () =>
      activities.filter((activity) =>
        matchesScheduleProject(activity, project),
      ),
    [activities, project],
  );
  const shownRuns = useMemo(() => {
    const ids = new Set(shownActivities.map((activity) => activity.id));
    // A run whose automation was deleted has no project left to match, so it
    // shows only while no project is picked.
    return project === null
      ? recentRuns
      : recentRuns.filter((run) => ids.has(run.activityId));
  }, [project, recentRuns, shownActivities]);

  const options = useMemo<readonly FilterOption<string>[]>(() => {
    const count = (value: string): number =>
      activities.filter((activity) => matchesScheduleProject(activity, value))
        .length;
    return [
      ...scope.projectsInContext.map((entry) => ({
        value: entry.id,
        label: getWorkspaceDisplayName(entry),
        count: count(entry.id),
      })),
      {
        value: WORKFLOW_NO_PROJECT,
        label: 'No project',
        count: count(WORKFLOW_NO_PROJECT),
      },
    ];
  }, [activities, scope.projectsInContext]);
  const selectedLabel =
    project === null
      ? 'Any project'
      : (options.find((option) => option.value === project)?.label ??
        'Any project');

  const handleViewChange = useCallback((view: CalendarView): void => {
    setCalendarView(view);
    saveCalendarView(view);
  }, []);
  const handleOpenRun = useCallback(
    (runId: string): void => {
      const run = recentRuns.find((entry) => entry.id === runId);
      if (run) onOpenRun(run);
    },
    [onOpenRun, recentRuns],
  );

  return (
    <div className="pt-4" data-testid="workflows-schedule">
      <AutomationsCalendar
        activities={[...shownActivities]}
        recentRuns={[...shownRuns]}
        calendarView={calendarView}
        anchorDate={anchorDate}
        showDisabled={showDisabled}
        selectedActivityId={selectedActivityId}
        onCalendarViewChange={handleViewChange}
        onAnchorDateChange={setAnchorDate}
        onToggleShowDisabled={setShowDisabled}
        onEdit={onEdit}
        onOpenRun={handleOpenRun}
        onSelect={setSelectedActivityId}
        describeAction={describeAction}
        toolbarFilters={
          <FilterDropdown
            size="default"
            title="Project"
            label={selectedLabel}
            anyLabel="Any project"
            options={options}
            selected={project === null ? [] : [project]}
            onToggle={(value): void =>
              setProject(value === project ? null : value)
            }
            onClear={(): void => setProject(null)}
            testId="workflows-schedule-project"
            replayPrivacy={{ maskClassName: POSTHOG_REPLAY_MASK_CLASS }}
          />
        }
      />
    </div>
  );
}
