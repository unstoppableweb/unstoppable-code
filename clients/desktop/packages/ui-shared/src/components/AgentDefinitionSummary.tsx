import { DescriptionMarkdown } from './DescriptionMarkdown';
import { OverlayScrollArea } from './OverlayScrollArea';
import { Stack } from './Stack';
import type { JSX } from 'react';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
import { Fact, FactList } from './FactList';
import { Heading } from './Heading';
import { EmptyStateText } from './StatusBlocks';
import { Surface } from './Surface';

export interface AgentDefinitionSummaryPlugin {
  key: string;
  label: string;
}

/**
 * An agent's instructions read as sanitized Markdown (the same renderer share
 * descriptions use: raw HTML stays text, images show their alt text, headings
 * never compete with the page title). Long instructions scroll in place.
 */
export function AgentInstructionsMarkdown({
  instructions,
  dataTestId = 'agent-definition-instructions',
  scroll = true,
}: {
  readonly instructions: string;
  readonly dataTestId?: string;
  /** Long instructions scroll in a box; a detail page reads them in full. */
  readonly scroll?: boolean;
}): JSX.Element {
  if (instructions.trim() === '') {
    return (
      <p className="text-s" data-testid={dataTestId}>
        <EmptyStateText title="No additional instructions." tone="secondary" />
      </p>
    );
  }
  const markdown = (
    <DescriptionMarkdown tone="primary">{instructions}</DescriptionMarkdown>
  );
  if (!scroll) return <div data-testid={dataTestId}>{markdown}</div>;
  return (
    <OverlayScrollArea
      className="max-h-96"
      viewportClassName="overscroll-contain"
      viewportProps={{ 'data-testid': dataTestId }}
    >
      {markdown}
    </OverlayScrollArea>
  );
}

export interface AgentDefinitionSummaryProps {
  /** Omitted by portable documents that pin no model (workspace templates). */
  baseModel?: string;
  instructions: string;
  plugins: readonly AgentDefinitionSummaryPlugin[];
  /** Section heading over `plugins`. Defaults to `Plugins`. */
  pluginsLabel?: string;
  /** Empty-state copy for `plugins`. Defaults to `No plugins required.` */
  pluginsEmptyLabel?: string;
}

/**
 * Pure, portable definition display shared by public web and desktop. Used for
 * shared Agents and for workspace templates, which carry the same
 * instructions-plus-portable-capabilities shape without a pinned model.
 */
export function AgentDefinitionSummary({
  baseModel,
  instructions,
  plugins,
  pluginsLabel = 'Plugins',
  pluginsEmptyLabel = 'No plugins required.',
}: AgentDefinitionSummaryProps): JSX.Element {
  return (
    <Stack gap="section" data-testid="agent-definition-summary">
      {baseModel !== undefined && (
        <Surface variant="card" padding="default">
          <FactList layout="stacked" size="s">
            <Fact
              label={
                <span className="text-xs font-medium fg-secondary">
                  Base model
                </span>
              }
            >
              {describeAgentBaseModel(baseModel)}
            </Fact>
          </FactList>
        </Surface>
      )}

      <Stack as="section" gap="inline">
        <Heading level={2} variant="title">
          Instructions
        </Heading>
        <Surface variant="card" padding="default">
          <AgentInstructionsMarkdown instructions={instructions} />
        </Surface>
      </Stack>

      <Stack as="section" gap="inline">
        <Heading level={2} variant="title">
          {pluginsLabel}
        </Heading>
        {plugins.length === 0 ? (
          <p className="text-s">
            <EmptyStateText title={pluginsEmptyLabel} tone="secondary" />
          </p>
        ) : (
          <Stack as="ul" gap="inline">
            {plugins.map((plugin) => (
              <Surface
                as="li"
                key={plugin.key}
                variant="card"
                padding="compact"
              >
                <span className="text-s">{plugin.label}</span>
              </Surface>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
