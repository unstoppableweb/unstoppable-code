import type { JSX } from 'react';
import { AgentActivitySection } from '@canopy/ui-app/agent-activity';
import {
  GitHubWorkflowRunActivityRow,
  type GitHubWorkflowRunRowData,
} from '@canopy/ui-app';
import {
  Button,
  CapabilityTile,
  type CapabilityTileModel,
} from '@canopy/ui-shared/components';
import { EyeIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

// Relative to when the lab loads, so the rows' ages read as written here.
const NOW = Date.now();
const minutesAgo = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString();

function job(
  name: string,
  status: string,
  conclusion: string | null,
  createdMinutesAgo: number,
): NonNullable<GitHubWorkflowRunRowData['jobs']>[number] {
  return {
    jobId: name,
    name,
    status,
    conclusion,
    htmlUrl: 'https://github.com/acme/app/actions',
    createdAt: minutesAgo(createdMinutesAgo),
  };
}

const RUN_BASE = {
  repository: 'acme/app',
  runAttempt: 1,
  htmlUrl: 'https://github.com/acme/app/actions',
  observedAt: minutesAgo(0),
} as const;

const RUNS: readonly GitHubWorkflowRunRowData[] = [
  {
    ...RUN_BASE,
    runId: '101',
    workflowName: 'CI',
    runNumber: 4821,
    state: { kind: 'intermediate', status: 'in_progress' },
    startedAt: minutesAgo(3),
    jobs: [
      job('Lint', 'completed', 'success', 3),
      job('Type check', 'completed', 'success', 3),
      job('Unit tests', 'in_progress', null, 2),
      job('Build', 'queued', null, 1),
    ],
  },
  {
    ...RUN_BASE,
    runId: '102',
    workflowName: 'Release',
    runNumber: 318,
    state: { kind: 'intermediate', status: 'queued' },
  },
  {
    ...RUN_BASE,
    runId: '103',
    workflowName: 'CI',
    runNumber: 4820,
    state: { kind: 'terminal', conclusion: 'success' },
    startedAt: minutesAgo(42),
    jobs: [
      job('Lint', 'completed', 'success', 42),
      job('Unit tests', 'completed', 'success', 41),
      job('Build', 'completed', 'success', 40),
    ],
  },
  {
    ...RUN_BASE,
    runId: '104',
    workflowName: 'UI automation',
    runNumber: 977,
    runAttempt: 2,
    state: { kind: 'terminal', conclusion: 'failure' },
    startedAt: minutesAgo(95),
    jobs: [
      job('Build', 'completed', 'success', 95),
      job('Electron specs', 'completed', 'failure', 94),
      job('Web specs', 'completed', 'cancelled', 94),
      job('Docs', 'completed', 'skipped', 94),
      job('Preview', 'completed', 'neutral', 94),
    ],
  },
  {
    ...RUN_BASE,
    runId: '106',
    workflowName: 'Matrix',
    runNumber: 64,
    state: { kind: 'intermediate', status: 'in_progress' },
    startedAt: minutesAgo(8),
    jobs: Array.from({ length: 24 }, (_, index) =>
      job(
        `Shard ${index + 1}`,
        index < 14 ? 'completed' : 'in_progress',
        index < 14 ? 'success' : null,
        8,
      ),
    ),
  },
  {
    ...RUN_BASE,
    runId: '107',
    workflowName: 'Docs',
    runNumber: 9,
    state: { kind: 'terminal', conclusion: 'skipped' },
  },
  {
    ...RUN_BASE,
    runId: '108',
    workflowName: 'Preview',
    runNumber: 3,
    state: { kind: 'terminal', conclusion: 'neutral' },
  },
  {
    ...RUN_BASE,
    runId: '105',
    repository: 'acme/a-repository-with-a-much-longer-name-than-usual',
    workflowName: 'Nightly performance comparison against the baseline',
    runNumber: 12,
    state: { kind: 'terminal', conclusion: 'cancelled' },
    startedAt: minutesAgo(600),
  },
];

const SKILL: CapabilityTileModel = {
  iconKind: 'skill',
  kindLabel: 'Skill',
  operationLabel: 'Created',
  kindPhrase: 'Created skill',
  name: 'release-notes',
  summary: 'Drafts release notes from merged pull requests',
  external: false,
  removed: false,
};

function runRows(withWatcher: boolean): readonly JSX.Element[] {
  return RUNS.map((run, index) => (
    <GitHubWorkflowRunActivityRow
      key={run.runId}
      run={run}
      onOpen={(): void => undefined}
      onJobClick={(): void => undefined}
      renderWatcherButton={
        withWatcher && index === 0
          ? (): JSX.Element => (
              <Button
                size="compact"
                variant="ghost"
                iconOnly
                aria-label="Manage GitHub workflow watchers"
              >
                <EyeIcon size="sm" aria-hidden="true" />
              </Button>
            )
          : undefined
      }
    />
  ));
}

function AgentActivitySheet(): JSX.Element {
  return (
    <SpecimenPanel
      title="AgentActivitySection"
      hint="A turn's created items and watched GitHub runs, as rows under one header"
    >
      <SpecimenCell
        label="A created skill, then watched runs: running, queued, passed, failed, 24 jobs, skipped, neutral, cancelled"
        wide
      >
        <div className="w-full max-w-180">
          <AgentActivitySection
            variant="completed"
            artifactItems={[
              <CapabilityTile
                key="skill"
                model={SKILL}
                testId="lab-agent-activity-skill"
                action={{ kind: 'action', onActivate: (): void => undefined }}
              />,
            ]}
            githubRunItems={runRows(true)}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Narrow: the details cut off and a job count stands in for the dots"
        wide
      >
        <div className="w-80">
          <AgentActivitySection
            variant="completed"
            githubRunItems={runRows(false)}
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

/** A turn's Agent activity, for the components lab. */
export const AGENT_ACTIVITY_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'agent-activity',
    name: 'Agent activity',
    group: 'Unified',
    note: 'What a turn made and the GitHub runs it watches, as rows under the section header.',
    source: 'packages/ui-app/src/code/agent-activity/AgentActivitySection.tsx',
    prs: [8608],
    View: AgentActivitySheet,
  },
];
