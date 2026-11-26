'use client';

import { CompositeListRow } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { useState, type JSX } from 'react';
import type { BackgroundTaskStopRequest } from '@canopy/app-core';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { Stack, AnsiOutput, Disclosure } from '@canopy/ui-shared/components';
import {
  backgroundProcessStatusBadgeTone,
  isTerminalBackgroundProcessStatus as isTerminalStatus,
} from '@canopy/ui-shared/lib';
import { WorkflowIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { TaskStopAction } from './TaskStopAction';
import { Surface } from '@canopy/ui-shared/components';

export interface BackgroundProcessesSectionBodyProps {
  readonly tasks: readonly BackgroundTask[];
  /** Where a task's Stop is sent; absent, or null for a task, means no Stop. */
  readonly stopTarget?: (
    task: BackgroundTask,
  ) => BackgroundTaskStopRequest | null;
  readonly onStopError?: (error: unknown) => void;
  readonly onOpenDetail: (task: BackgroundTask) => void;
}

/** Names what a background task's Stop ends; the card and its detail share it. */
export function backgroundTaskStopAccessibleLabel(
  kind: BackgroundTask['kind'],
): string {
  switch (kind) {
    case 'agent':
      return 'Stop agent';
    case 'workflow':
      return 'Stop workflow';
    case 'bash':
      return 'Stop shell command';
    case 'task':
      return 'Stop task';
  }
}

function RowStop({
  task,
  stopTarget,
  onStopError,
}: {
  readonly task: BackgroundTask;
  readonly stopTarget: (
    task: BackgroundTask,
  ) => BackgroundTaskStopRequest | null;
  readonly onStopError?: (error: unknown) => void;
}): JSX.Element | null {
  const target = stopTarget(task);
  if (!target) return null;
  return (
    <span className="shrink-0">
      <TaskStopAction
        target={target}
        live={!isTerminalStatus(task.status)}
        accessibleLabel={backgroundTaskStopAccessibleLabel(task.kind)}
        dataTestId="activity-bg-stop"
        onError={onStopError}
      />
    </span>
  );
}

export function BackgroundProcessesSectionBody({
  tasks,
  stopTarget,
  onStopError,
  onOpenDetail,
}: BackgroundProcessesSectionBodyProps): JSX.Element | null {
  const [stoppedExpanded, setStoppedExpanded] = useState(false);
  const sortedProcesses = [...tasks].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const activeProcesses = sortedProcesses.filter(
    (process) => !isTerminalStatus(process.status),
  );
  const stoppedProcesses = sortedProcesses.filter((process) =>
    isTerminalStatus(process.status),
  );
  const totalCount = activeProcesses.length + stoppedProcesses.length;

  if (totalCount === 0) {
    return null;
  }

  return (
    <Stack gap="inline" data-testid="activity-bg-body">
      {/* Active processes */}
      {activeProcesses.map((process) => (
        <Surface
          variant="group"
          interactive
          padding="compact"
          className="cursor-pointer"
          key={process.id}
          as={CompositeListRow}
          onClick={(): void => onOpenDetail(process)}
          data-testid="activity-bg-item"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {process.kind === 'workflow' && (
                    <span className="flex-shrink-0 fg-special">
                      <WorkflowIcon />
                    </span>
                  )}
                  <span className="text-xs font-medium fg-secondary">
                    {process.kind}
                  </span>
                  <Badge
                    tone={backgroundProcessStatusBadgeTone(process.status)}
                  >
                    {process.status}
                  </Badge>
                </div>
                {/* Descriptions fall back to the command or prompt, and
                  summaries quote agent output, so replay blocks them. */}
                <div
                  className={`${REPLAY_BLOCK_CLASS} pt-1 truncate text-xs font-medium fg-primary/80`}
                >
                  {process.title}
                </div>
                {process.lastDescription &&
                  process.lastDescription !== process.title && (
                    <div
                      className={`${REPLAY_BLOCK_CLASS} pt-1 truncate text-xs fg-secondary`}
                    >
                      {process.lastDescription}
                    </div>
                  )}
                {process.summary && (
                  <div
                    className={`${REPLAY_BLOCK_CLASS} pt-1 truncate text-xs fg-secondary`}
                  >
                    {process.summary}
                  </div>
                )}
              </div>

              {stopTarget && process.canStop && (
                <RowStop
                  task={process}
                  stopTarget={stopTarget}
                  onStopError={onStopError}
                />
              )}
            </div>

            {process.kind !== 'workflow' && (
              <AnsiOutput lines={process.outputLines} className="max-h-44" />
            )}
          </div>
        </Surface>
      ))}

      {/* Stopped processes (collapsible) */}
      {stoppedProcesses.length > 0 && (
        <div className="pt-1">
          <Disclosure
            label={`Stopped (${stoppedProcesses.length})`}
            open={stoppedExpanded}
            onOpenChange={setStoppedExpanded}
            dataTestId="activity-bg-stopped"
            toggleTestId="activity-bg-stopped-toggle"
          >
            <div className="flex flex-col gap-1.5">
              {stoppedProcesses.map((process) => (
                <Surface
                  variant="group"
                  interactive
                  className="cursor-pointer overflow-hidden"
                  key={process.id}
                  as={CompositeListRow}
                  onClick={(): void => onOpenDetail(process)}
                  data-testid="activity-bg-item"
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium fg-secondary/60">
                        {process.kind}
                      </span>
                      <Badge
                        tone={backgroundProcessStatusBadgeTone(process.status)}
                        muted
                      >
                        {process.status}
                      </Badge>
                    </div>
                    <div className="pt-1 truncate text-xs fg-secondary">
                      {process.title}
                    </div>
                    {process.summary && (
                      <div className="mt-0.5 truncate text-xs fg-secondary/60">
                        {process.summary}
                      </div>
                    )}
                  </div>
                </Surface>
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </Stack>
  );
}
