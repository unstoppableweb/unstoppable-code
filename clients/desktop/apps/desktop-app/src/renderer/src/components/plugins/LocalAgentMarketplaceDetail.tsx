import type { JSX, ReactNode } from 'react';
import {
  Stack,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
} from '@canopy/ui-shared/components';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import {
  getAgentModelAvailability,
  getProviderForModel,
} from '@canopy/desktop-shared/types';
import { isAgentDefaultBaseModel } from '@canopy/protocol/agents';
import {
  AgentDefinitionSummary,
  AgentReadDetail,
  Button,
  ModelProviderIcon,
  CustomizeRowSplitButton,
  DetailActionBar,
  DetailFactError,
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import {
  MarketplaceEntityHeader,
  customizeRowAction,
} from '@canopy/ui-app/capability';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import { formatDateOrEmpty } from '@/lib/format';
import {
  agentBaseModelLabel,
  agentPluginLabels,
  agentSelectionEntries,
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
      entryName="this model preset"
      idPrefix={`agent-detail-${entry.id}`}
      action={{ ...action, accessibleName: 'This model preset is installed' }}
      items={[]}
    />
  );
}

/**
 * The Details card of a local and a shared agent's page: the same rows for
 * both, with any the record lacks left out rather than shown empty.
 */
export function AgentDetailsSection({
  baseModel,
  modelId,
  updatedAt,
}: {
  baseModel: string;
  modelId?: string | undefined;
  updatedAt?: string | undefined;
}): JSX.Element {
  const updated = formatDateOrEmpty(updatedAt);
  return (
    <SettingsRowsSection title="Details">
      <SettingsRowsGroup>
        <SettingsRowsRow
          fact
          label="Base model"
          control={<SettingsRowsValue>{baseModel}</SettingsRowsValue>}
        />
        {modelId && (
          <SettingsRowsRow
            fact
            label="Model ID"
            control={
              <SettingsRowsValue>
                {/* Derived from the agent's own name: masked with it. */}
                <span
                  className={`font-mono text-xs ${POSTHOG_REPLAY_MASK_CLASS}`}
                >
                  {modelId}
                </span>
              </SettingsRowsValue>
            }
          />
        )}
        {updated && (
          <SettingsRowsRow
            fact
            label="Updated"
            control={<SettingsRowsValue>{updated}</SettingsRowsValue>}
          />
        )}
      </SettingsRowsGroup>
    </SettingsRowsSection>
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
    /** The list's entries, which the agent's plugins and skills resolve in. */
    readonly entries?: readonly UnifiedPluginEntry[];
    /** Publisher skills whose installed copy the list folds into their entry. */
    readonly publisherSkills?: readonly DesktopPublisherSkill[];
    /** Opens a plugin or skill's own page. */
    readonly onOpenEntry?: (entry: UnifiedPluginEntry) => void;
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
  const provider = isAgentDefaultBaseModel(agent.baseModel)
    ? undefined
    : getProviderForModel(agent.baseModel);
  const selectionTiles =
    layout?.entries && layout.onOpenEntry
      ? agentSelectionEntries(agent, layout.entries, layout.publisherSkills)
      : undefined;
  if (layout) {
    return (
      <AgentReadDetail
        dataTestId="local-agent-marketplace-detail"
        name={layout.entry.name}
        entityId={layout.entry.id}
        description={layout.entry.description}
        logo={layout.logo}
        publisher={layout.publisher}
        actions={
          <DetailActionBar
            secondary={
              <ExecutionActionButton
                placement="detail"
                label="Edit"
                ariaLabel="Edit this model preset"
                onClick={onEdit}
                disabled={editDisabled}
                dataTestId="local-agent-detail-edit"
                stopKeyDownPropagation={false}
              />
            }
          />
        }
        source={layout.entry.sourceLabel}
        baseModel={agentBaseModelLabel(agent)}
        baseModelIcon={
          provider ? <ModelProviderIcon provider={provider} size="sm" /> : null
        }
        notice={
          layout.loadFailed ? (
            <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
              <DetailFactError
                error="Couldn't load your model presets"
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
          ) : !available ? (
            <span
              className="text-s fg-secondary"
              data-testid="local-agent-detail-availability"
            >
              Its default model isn’t available right now, so it can’t be picked
              in chat.
            </span>
          ) : undefined
        }
        items={agentPluginLabels(agent)}
        {...(selectionTiles
          ? {
              itemEntries: selectionTiles.entries,
              unresolvedItems: selectionTiles.unresolved,
              ...(layout.onOpenEntry ? { onOpenItem: layout.onOpenEntry } : {}),
              McpServerLogoComponent: McpServerLogo,
            }
          : {})}
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

      <AgentDetailsSection
        baseModel={agentBaseModelLabel(agent)}
        modelId={agent.id}
        updatedAt={agent.updatedAt}
      />

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
