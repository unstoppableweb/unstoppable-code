'use client';

import { CodeBlock } from '@canopy/ui-shared/components/CodeBlock';
import {
  PipelineDetailTag,
  PipelineDetailJobHeader,
} from '@canopy/ui-shared/components';
import { Count } from '@canopy/ui-shared/components/Badge';
import { type JSX, type ReactNode, useState } from 'react';
import type { RemoteControlPipelineDefinitionViewModel } from '@canopy/protocol/remote-control/shell';
import { PipelineIcon } from '@canopy/ui-shared';
import {
  Stack,
  Button,
  Heading,
  CapabilityDetailLayout,
  ComponentSection,
  DataTable,
  DetailFact,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { EmptyStateRow } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';
import { PipelineStepRow } from './PipelineStepRow';

export interface PipelineReadDetailProps {
  definition: RemoteControlPipelineDefinitionViewModel;
  onOpenEditor?: () => void;
  /**
   * Drop the top padding because the host already spaced this panel — the
   * marketplace detail shell's Back row owns that gap. A typed flag rather
   * than a `className` override: both `py-6` and a `pt-0` passed in emit
   * `padding-top`, so which one wins would come down to stylesheet order,
   * not the order they appear in the class attribute.
   */
  flushTop?: boolean;
  /**
   * New Customize: the shared detail layout, with the tile's identity, the
   * page's actions (Run, Open in editor) and its Related section.
   */
  layout?: PipelineReadDetailLayout;
}

export interface PipelineReadDetailLayout {
  /**
   * The tile's name and description, so the header matches the list row;
   * the definition's own fill in when the host has no row.
   */
  readonly title?: string;
  readonly description?: string;
  readonly logo?: ReactNode;
  readonly publisher?: ReactNode;
  /** `[⋯] [Open in editor] [Share] [Run]`, as a `DetailActionBar`. */
  readonly actions?: ReactNode;
  /** Where it comes from: Built-in, Yours, Shared by X, a project file. */
  readonly source?: string;
  /** The Source names a person ("Shared by …"): masked in session replay. */
  readonly sourceIsPerson?: boolean;
  /** A failure of the page's own reads, said under the facts. */
  readonly notice?: ReactNode;
  /** When it last changed, formatted; omitted when unknown. */
  readonly updated?: string;
  /** A header action's outcome (Run), said beside the actions. */
  readonly actionsNotice?: ReactNode;
  /**
   * Shown in the Jobs section instead of the table while the definition
   * loads, or when it could not be read (with its retry).
   */
  readonly jobsNotice?: ReactNode;
  /** Said above the Jobs table, which still shows (a truncated read). */
  readonly jobsCaption?: ReactNode;
  /**
   * Why this host shows no raw YAML (the Portal never receives a workflow's
   * raw file); the YAML section says so instead of disappearing.
   */
  readonly yamlUnavailable?: string;
  readonly related?: ReactNode;
}

function scopeLabel(
  scope: RemoteControlPipelineDefinitionViewModel['scopes'][number],
): string {
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

export function PipelineReadDetail({
  definition,
  onOpenEditor,
  flushTop = false,
  layout,
}: PipelineReadDetailProps): JSX.Element {
  const [showYaml, setShowYaml] = useState(false);
  if (layout) {
    return <PipelineLayoutDetail definition={definition} layout={layout} />;
  }

  return (
    <article
      className={`mx-auto w-full max-w-4xl flex flex-col gap-6 px-6 ${
        flushTop ? 'pb-6' : 'py-6'
      }`}
      data-testid="pipeline-read-detail"
    >
      <Surface
        as="header"
        variant="card"
        padding="default"
        data-testid="pipeline-read-detail-meta"
      >
        <div className="flex items-start gap-3">
          <Surface variant="group" className="w-10 shrink-0">
            <div className="flex h-10 items-center justify-center fg-secondary">
              {definition.icon ? (
                <span className="text-lg">{definition.icon}</span>
              ) : (
                <PipelineIcon size="xl" />
              )}
            </div>
          </Surface>
          <div className="min-w-0 flex-1 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Heading level={1} variant="page">
                {definition.name}
              </Heading>
              {definition.version && (
                <span className="text-xs fg-tertiary">
                  v{definition.version}
                </span>
              )}
            </div>
            {definition.description && (
              <p className="text-s fg-secondary">{definition.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {/* A run's recorded snapshot keeps no triggers. */}
              {definition.triggerSummary !== '' && (
                <PipelineDetailTag kind="trigger">
                  {definition.triggerSummary}
                </PipelineDetailTag>
              )}
              {definition.scopes.map((scope) => (
                <PipelineDetailTag key={scope} kind="scope">
                  {scopeLabel(scope)}
                </PipelineDetailTag>
              ))}
            </div>
          </div>
          {onOpenEditor && (
            <Button
              type="button"
              size="compact"
              onClick={onOpenEditor}
              data-testid="pipeline-read-detail-open-editor"
            >
              Open in editor
            </Button>
          )}
        </div>
      </Surface>

      <Stack
        as="section"
        gap="item"
        aria-labelledby="pipeline-read-detail-jobs-heading"
      >
        <div className="flex items-center justify-between">
          <Heading
            level={2}
            variant="title"
            id="pipeline-read-detail-jobs-heading"
          >
            Jobs ({definition.jobs.length})
          </Heading>
          {definition.canonicalYaml !== undefined && (
            <Button
              type="button"
              size="compact"
              aria-expanded={showYaml}
              onClick={() => setShowYaml((visible) => !visible)}
              data-testid="pipeline-read-detail-yaml-toggle"
            >
              Raw
            </Button>
          )}
        </div>

        {showYaml && definition.canonicalYaml !== undefined ? (
          <Stack gap="inline">
            {definition.canonicalYamlTruncated === true && (
              <p className="text-xs fg-secondary">
                YAML truncated in transfer.
              </p>
            )}
            {/* Raw YAML holds prompts, scripts, and env values. */}
            <Surface variant="group" className="overflow-hidden">
              <CodeBlock
                variant="document"
                inset="roomy"
                size="xs"
                wrap="none"
                tone="primary"
                replay="block"
                className="max-h-144"
                data-testid="pipeline-read-detail-yaml"
              >
                <code>{definition.canonicalYaml}</code>
              </CodeBlock>
            </Surface>
          </Stack>
        ) : (
          <Stack gap="item">
            {definition.jobs.map((job) => (
              <Surface
                key={job.id}
                as="article"
                variant="outline"
                className="overflow-hidden"
                data-testid="pipeline-read-detail-job"
              >
                <PipelineDetailJobHeader>
                  <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
                    {job.name}
                  </span>
                  {job.dependencies.map((dependency) => (
                    <span
                      key={dependency}
                      className="font-mono text-xs fg-secondary"
                    >
                      {dependency}
                    </span>
                  ))}
                  <Count value={job.steps.length} />
                </PipelineDetailJobHeader>
                {/* 2px inside the job's 12px corners keeps the 10px rows concentric. */}
                <ol className="flex flex-col p-0.5">
                  {job.steps.length === 0 && (
                    <li>
                      <EmptyStateRow title="No steps yet" />
                    </li>
                  )}
                  {job.steps.map((step) => (
                    <li key={step.id}>
                      <PipelineStepRow
                        name={step.name}
                        kind={step.kind}
                        summary={step.usesSummary}
                        data-testid="pipeline-read-detail-step"
                      />
                    </li>
                  ))}
                </ol>
              </Surface>
            ))}
          </Stack>
        )}
      </Stack>
    </article>
  );
}

/** New Customize's workflow page on the shared detail layout. */
function PipelineLayoutDetail({
  definition,
  layout,
}: {
  readonly definition: RemoteControlPipelineDefinitionViewModel;
  readonly layout: PipelineReadDetailLayout;
}): JSX.Element {
  return (
    <CapabilityDetailLayout
      dataTestId="pipeline-detail"
      // A monogram shows the workflow name's first letter: masked with it.
      logo={
        layout.logo ? (
          <span className={`inline-flex shrink-0 ${REPLAY_MASK_CLASS}`}>
            {layout.logo}
          </span>
        ) : undefined
      }
      // The workflow file's own name and description: session replay masks
      // the title and keeps a placeholder for the description.
      title={
        <span className={REPLAY_MASK_CLASS}>
          {layout.title || definition.name}
        </span>
      }
      titleId="plugin-detail-title"
      publisher={layout.publisher}
      actions={layout.actions}
      actionsNotice={layout.actionsNotice}
      description={
        (layout.title ? layout.description : definition.description) ||
        undefined
      }
      descriptionReplay="block"
      factsFooter={layout.notice}
      facts={{
        source: layout.source ? (
          <DetailFact label="Source" testId="pipeline-detail-source">
            <span
              className={layout.sourceIsPerson ? REPLAY_MASK_CLASS : undefined}
            >
              {layout.source}
            </span>
          </DetailFact>
        ) : undefined,
        updated: layout.updated ? (
          <DetailFact label="Updated" testId="pipeline-detail-updated">
            {layout.updated}
          </DetailFact>
        ) : undefined,
        entity: (
          <>
            {/* A run's recorded snapshot keeps no triggers. */}
            {definition.triggerSummary !== '' && (
              <DetailFact label="Triggers" testId="pipeline-detail-triggers">
                {definition.triggerSummary}
              </DetailFact>
            )}
            {definition.scopes.length > 0 && (
              <DetailFact label="Scopes" testId="pipeline-detail-scopes">
                {definition.scopes.map(scopeLabel).join(', ')}
              </DetailFact>
            )}
          </>
        ),
      }}
      contents={
        <ComponentSection title="Jobs">
          {layout.jobsCaption}
          {layout.jobsNotice ?? (
            <DataTable
              caption="Jobs"
              testId="pipeline-detail-jobs"
              rows={definition.jobs}
              rowKey={(job) => job.id}
              emptyLabel="No jobs yet"
              columns={[
                {
                  key: 'name',
                  header: 'Job',
                  overflow: 'wrap',
                  render: (job) => (
                    <span
                      className={`font-medium fg-primary ${REPLAY_BLOCK_CLASS}`}
                    >
                      {job.name}
                    </span>
                  ),
                },
                {
                  key: 'needs',
                  header: 'Runs after',
                  overflow: 'wrap',
                  render: (job) =>
                    job.dependencies.length > 0 ? (
                      <span
                        className={`font-mono text-xs ${REPLAY_BLOCK_CLASS}`}
                      >
                        {job.dependencies.join(', ')}
                      </span>
                    ) : (
                      <span className="fg-tertiary">—</span>
                    ),
                },
                {
                  key: 'steps',
                  header: 'Steps',
                  align: 'right',
                  render: (job) => job.steps.length,
                },
              ]}
            />
          )}
        </ComponentSection>
      }
      docs={
        definition.canonicalYaml !== undefined ? (
          <div data-testid="pipeline-detail-yaml-section">
            <ComponentSection title="YAML" collapsible>
              {definition.canonicalYamlTruncated === true && (
                <p className="pb-2 text-xs fg-secondary">
                  YAML truncated in transfer.
                </p>
              )}
              {/* Raw YAML holds prompts, scripts, and env values. */}
              <div className={REPLAY_BLOCK_CLASS}>
                <CodeBlock
                  variant="bare"
                  className="max-h-144 overflow-auto"
                  data-testid="pipeline-read-detail-yaml"
                >
                  {definition.canonicalYaml}
                </CodeBlock>
              </div>
            </ComponentSection>
          </div>
        ) : layout.yamlUnavailable ? (
          <div data-testid="pipeline-detail-yaml-section">
            <ComponentSection title="YAML" collapsible>
              <p className="text-s fg-secondary">{layout.yamlUnavailable}</p>
            </ComponentSection>
          </div>
        ) : undefined
      }
      related={layout.related}
    />
  );
}
