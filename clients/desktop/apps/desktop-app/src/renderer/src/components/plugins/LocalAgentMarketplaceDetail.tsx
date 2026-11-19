import type { JSX, ReactNode } from 'react';
import {
  Stack,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
} from '@canopy/ui-shared/components';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import { getAgentModelAvailability } from '@canopy/desktop-shared/types';
import {
  AgentDefinitionSummary,
  AgentReadDetail,
  Button,
  CustomizeRowSplitButton,
  DetailActionBar,
  DetailFact,
  DetailFactError,
  DetailFactList,
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import {
  MarketplaceEntityHeader,
  customizeRowAction,
} from '@canopy/ui-app/capability';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import { formatDateOrEmpty } from '@/lib/format';
import {
  agentBaseModelLabel,
  agentPluginLabels,
} from '@/lib/marketplaceAgents';

/**
 * A local agent's primary, as its tile draws it: an agent has no status to
 * change, so it reads Installed.
 */
export function LocalAgentInstalledAction({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element {
  const action = customizeRowAction({
    entry,
    installed: true,
    statuses: [],
    pendingKeys: new Set(),
  });
  return (
    <CustomizeRowSplitButton
      // The title names it; labels keep its name out of replay.
      entryName="this agent"
      idPrefix={`agent-detail-${entry.id}`}
      action={{ ...action, accessibleName: 'This agent is installed' }}
      items={[]}
    />
  );
}

export interface LocalAgentMarketplaceDetailProps {
  agent: AgentModelDefinition;
  onEdit: () => void;
  /**
   * While the agent list is loading or its last read failed, the cached
   * definition may be older than the agent, so Edit waits for a fresh one.
   */
  editDisabled?: boolean;
  /** The list's load failure and its Try again, above the detail. */
  notice?: ReactNode;
  onDelete: () => void;
  /**
   * New Customize: the shared layout with the tile's identity. Delete moves
   * to the shell's ⋯ menu, and the list's load failure is said under the
   * facts with its Try again.
   */
  layout?: {
    readonly entry: UnifiedPluginEntry;
    readonly logo: ReactNode;
    readonly publisher: ReactNode;
    readonly loadFailed: boolean;
    readonly onRetry?: () => void;
  };
}

/**
 * A local agent in the Marketplace (CAN-4266): what it runs and selects, with
 * Edit and Delete beside the shell's Share. The dialogs stay host-mounted.
 */
export function LocalAgentMarketplaceDetail({
  agent,
  onEdit,
  onDelete,
  editDisabled = false,
  notice,
  layout,
}: LocalAgentMarketplaceDetailProps): JSX.Element {
  const available = getAgentModelAvailability(agent.id).available;
  if (layout) {
    return (
      <AgentReadDetail
        dataTestId="local-agent-marketplace-detail"
        name={layout.entry.name}
        description={layout.entry.description}
        logo={layout.logo}
        publisher={layout.publisher}
        actions={
          <DetailActionBar
            secondary={
              <ExecutionActionButton
                placement="detail"
                label="Edit"
                ariaLabel="Edit this agent"
                onClick={onEdit}
                disabled={editDisabled}
                dataTestId="local-agent-detail-edit"
                stopKeyDownPropagation={false}
              />
            }
            primary={<LocalAgentInstalledAction entry={layout.entry} />}
          />
        }
        source={layout.entry.sourceLabel}
        baseModel={agentBaseModelLabel(agent)}
        model={agent.id}
        {...(available
          ? {}
          : {
              status: (
                <DetailFactList>
                  <DetailFact
                    label="Status"
                    testId="local-agent-detail-availability"
                  >
                    Unavailable
                  </DetailFact>
                </DetailFactList>
              ),
            })}
        notice={
          layout.loadFailed ? (
            <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
              <DetailFactError
                error="Couldn't load your agents"
                testId="local-agent-detail-error"
              />
              {layout.onRetry && (
                <>
                  <span aria-hidden>·</span>
                  <Button variant="link" onClick={layout.onRetry}>
                    Try again
                  </Button>
                </>
              )}
            </span>
          ) : undefined
        }
        items={agentPluginLabels(agent)}
        instructions={agent.instructions}
      />
    );
  }
  return (
    <Stack gap="section" data-testid="local-agent-marketplace-detail">
      <DetailPageActions
        secondary={
          <ExecutionActionButton
            placement="detail"
            label="Delete"
            ariaLabel={`Delete ${agent.name}`}
            onClick={onDelete}
            dataTestId="local-agent-detail-delete"
            stopKeyDownPropagation={false}
          />
        }
        primary={
          <ExecutionActionButton
            placement="detail"
            label="Edit"
            ariaLabel={`Edit ${agent.name}`}
            variant="primary"
            onClick={onEdit}
            disabled={editDisabled}
            dataTestId="local-agent-detail-edit"
            stopKeyDownPropagation={false}
          />
        }
      />
      {notice}
      <MarketplaceEntityHeader
        name={agent.name}
        McpServerLogoComponent={McpServerLogo}
        meta={
          <span data-testid="local-agent-detail-availability">
            {available ? 'Installed' : 'Unavailable'}
          </span>
        }
      />

      <SettingsRowsSection title="Details">
        <SettingsRowsGroup>
          <SettingsRowsRow
            fact
            label="Base model"
            control={
              <SettingsRowsValue>
                {agentBaseModelLabel(agent)}
              </SettingsRowsValue>
            }
          />
          <SettingsRowsRow
            fact
            label="Model ID"
            control={
              <SettingsRowsValue>
                <span className="font-mono text-xs">{agent.id}</span>
              </SettingsRowsValue>
            }
          />
          <SettingsRowsRow
            fact
            label="Updated"
            control={
              <SettingsRowsValue>
                {formatDateOrEmpty(agent.updatedAt) || '—'}
              </SettingsRowsValue>
            }
          />
        </SettingsRowsGroup>
      </SettingsRowsSection>

      {/* Instructions are prompt content, not a label. */}
      <div className={POSTHOG_REPLAY_BLOCK_CLASS}>
        <AgentDefinitionSummary
          instructions={agent.instructions}
          plugins={agentPluginLabels(agent)}
        />
      </div>
    </Stack>
  );
}
