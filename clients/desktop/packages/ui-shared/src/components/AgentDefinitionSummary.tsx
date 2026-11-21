import { CodeBlock } from './CodeBlock';
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
        <CodeBlock
          variant="card"
          size="s"
          wrap="words"
          tone="inherit"
          replay="inherit"
          font="sans"
          overflow="visible"
        >
          {instructions || 'No additional instructions.'}
        </CodeBlock>
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
