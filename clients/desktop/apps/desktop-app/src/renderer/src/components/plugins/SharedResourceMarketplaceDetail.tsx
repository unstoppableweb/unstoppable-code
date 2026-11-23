import { type JSX, type ReactNode, useEffect, useState } from 'react';
import {
  AgentDefinitionSummary,
  AgentReadDetail,
  Button,
  CenteredLoadingSpinner,
  CustomizeRowSplitButton,
  DelayedLoadingPlaceholder,
  DetailActionBar,
  DetailFactError,
  sharedAgentDetailItems,
} from '@canopy/ui-shared/components';
import { customizeRowAction } from '@canopy/ui-app/capability';
import {
  describeAgentBaseModel,
  type SharedAgentDetail,
} from '@canopy/protocol/agents';
import { toAppError } from '@canopy/protocol/app-errors';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Stack,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
} from '@canopy/ui-shared/components';
import type { SharedAgentSummary } from '@canopy/execution-engine/types/agent-models';
import {
  getModelDisplayName,
  type DeepLinkShareOpenEvent,
} from '@canopy/desktop-shared/types';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { shareablePluginSourceLabel } from '@canopy/execution-engine/plugin-refs';
import {
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import {
  sharedBlueprintInstallLink,
  sharedResourceInstallLink,
} from '@/lib/sharedResourceInstallLink';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  openInAppAgentInstall,
  type InAppAgentRevision,
} from '../share/usePublicShareLanding';
import { AgentDetailsSection } from './LocalAgentMarketplaceDetail';

/**
 * Marketplace details for the kinds a recipient reaches only through a share:
 * an agent, a project template and a plugin reference. The page shell's
 * header (CAN-4266) says what each is, who shared it and with whom, from the
 * `*DetailHeader` builders in `sharedResourceDetailHeaders`; the body adds its facts and the one
 * `Install` action, which opens the shared install review (CAN-3710) and
 * lands on the result. An owner's Unshare lives in the header's ⋯ menu.
 */

/** Opens the install review for a shared resource listed in the app. */
function openInstallReview(link: DeepLinkShareOpenEvent): void {
  useNavigationStore.getState().openShareInstall(link, 'in-app');
}

/**
 * The revision a shared agent's page shows: the share's own read once it
 * landed, the list's summary until then.
 */
function shownAgentRevision(
  agent: SharedAgentSummary,
  detail: SharedAgentDetail | null,
): InAppAgentRevision {
  return detail
    ? {
        contentHash: detail.contentHash,
        packageDigest: detail.package?.digest ?? null,
      }
    : { contentHash: agent.contentHash };
}

/** The detail's one action: `Install`, when there is something to install. */
function InstallAction({
  link,
  name,
  testId,
  open = openInstallReview,
}: {
  link: DeepLinkShareOpenEvent | null;
  name: string;
  testId: string;
  /** Opens the review; a shared agent's pins the revision shown. */
  open?: (link: DeepLinkShareOpenEvent) => void;
}): JSX.Element | null {
  if (link === null) return null;
  return (
    <DetailPageActions
      primary={
        <ExecutionActionButton
          placement="detail"
          label="Install"
          ariaLabel={`Install ${name}`}
          variant="primary"
          onClick={(): void => open(link)}
          dataTestId={testId}
          stopKeyDownPropagation={false}
        />
      }
    />
  );
}

/**
 * A shared agent's full definition. The list's summary carries only a short
 * instructions preview, so the page reads the share itself, keyed by id so a
 * stale read never shows under another agent.
 */
function useSharedAgentRead(agentId: string): {
  readonly detail: SharedAgentDetail | null;
  readonly error: string | null;
  readonly retry: () => void;
} {
  const [read, setRead] = useState<{
    readonly id: string;
    readonly detail: SharedAgentDetail | null;
    readonly error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    window.agents
      .getShared(agentId)
      .then((detail) => {
        if (!cancelled) setRead({ id: agentId, detail, error: null });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setRead({
          id: agentId,
          detail: null,
          error:
            toAppError(failure)?.detail.message.trim() ||
            'Couldn’t load this agent',
        });
      });
    return (): void => {
      cancelled = true;
    };
  }, [agentId, attempt]);
  const current = read?.id === agentId ? read : null;
  return {
    detail: current?.detail ?? null,
    error: current?.error ?? null,
    retry: (): void => {
      setRead(null);
      setAttempt((count) => count + 1);
    },
  };
}

/** What stands in for a shared agent's definition until it can be read. */
function SharedAgentReadNotice({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}): JSX.Element {
  if (error) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
        <DetailFactError error={error} testId="shared-agent-detail-error" />
        <span aria-hidden>·</span>
        <Button variant="link" onClick={onRetry}>
          Try again
        </Button>
      </span>
    );
  }
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading agent…">
      <CenteredLoadingSpinner spacing="section" />
    </DelayedLoadingPlaceholder>
  );
}

export interface SharedAgentMarketplaceDetailProps {
  agent: SharedAgentSummary;
}

/**
 * A shared agent, laid out as an installed agent's page: Details, then
 * Instructions and Plugins from the share's own definition.
 */
export function SharedAgentMarketplaceDetail({
  agent,
}: SharedAgentMarketplaceDetailProps): JSX.Element {
  const { detail, error, retry } = useSharedAgentRead(agent.id);
  return (
    <Stack gap="section" data-testid="shared-agent-marketplace-detail">
      <InstallAction
        link={sharedResourceInstallLink({
          entity: 'agent',
          externalId: agent.id,
          scope: agent.shareScope,
        })}
        name={agent.name}
        testId="shared-agent-detail-add"
        open={(link): void =>
          openInAppAgentInstall(link, shownAgentRevision(agent, detail))
        }
      />
      <AgentDetailsSection
        baseModel={describeAgentBaseModel(
          detail?.agent.baseModel ?? agent.baseModel,
          getModelDisplayName,
        )}
        // One record for every row: the revision Install pins (the share's own
        // read once landed), since a republish can change both under one id.
        modelId={(detail ?? agent).modelId}
        updatedAt={(detail ?? agent).updatedAt}
      />
      {detail ? (
        // Instructions are prompt content, not a label.
        <div className={POSTHOG_REPLAY_BLOCK_CLASS}>
          <AgentDefinitionSummary
            instructions={detail.agent.instructions}
            plugins={sharedAgentDetailItems(detail.agent.plugins)}
          />
        </div>
      ) : (
        <SharedAgentReadNotice error={error} onRetry={retry} />
      )}
    </Stack>
  );
}

/**
 * New Customize's page for a team-shared agent: the tile's identity and Add,
 * and the share's own definition (its plugins and skills, its instructions),
 * read as the Portal reads it.
 */
export function SharedAgentLayoutDetail({
  agent,
  identity,
  settings,
}: {
  agent: SharedAgentSummary;
  identity: {
    readonly entry: UnifiedPluginEntry;
    readonly logo: ReactNode;
    readonly publisher: ReactNode;
  };
  /** Shared by you, for the owner. */
  settings?: ReactNode;
}): JSX.Element {
  const { detail, error, retry } = useSharedAgentRead(agent.id);
  const link = sharedResourceInstallLink({
    entity: 'agent',
    externalId: agent.id,
    scope: agent.shareScope,
  });
  // The tile's primary: Add (the install review), or Installed for the
  // author's own linked copy.
  const installed = identity.entry.state === 'installed';
  const primary = customizeRowAction({
    entry: identity.entry,
    installed,
    ...(link
      ? {
          add: (): void =>
            openInAppAgentInstall(link, shownAgentRevision(agent, detail)),
        }
      : {}),
    statuses: [],
    pendingKeys: new Set(),
  });
  return (
    <AgentReadDetail
      dataTestId="shared-agent-marketplace-detail"
      name={identity.entry.name}
      entityId={identity.entry.id}
      description={identity.entry.description}
      logo={identity.logo}
      publisher={identity.publisher}
      actions={
        <DetailActionBar
          primary={
            <CustomizeRowSplitButton
              // The title names it; labels keep its name out of replay.
              entryName="this agent"
              idPrefix={`shared-agent-detail-${agent.id}`}
              action={{
                ...primary,
                accessibleName: installed
                  ? 'This agent is installed'
                  : 'Add this agent',
              }}
              items={[]}
            />
          }
        />
      }
      source={identity.entry.sourceLabel}
      // The share's own definition once read; the list's summary until then.
      baseModel={describeAgentBaseModel(
        detail?.agent.baseModel ?? agent.baseModel,
      )}
      items={detail ? sharedAgentDetailItems(detail.agent.plugins) : []}
      instructions={detail?.agent.instructions ?? ''}
      {...(detail
        ? {}
        : {
            contentsNotice: (
              <SharedAgentReadNotice error={error} onRetry={retry} />
            ),
          })}
      settings={settings}
    />
  );
}

export interface SharedBlueprintMarketplaceDetailProps {
  blueprint: WorkspaceTemplateShareSummary;
}

/** Member-authorized project-template detail and hash-pinned install flow. */
export function SharedBlueprintMarketplaceDetail({
  blueprint,
}: SharedBlueprintMarketplaceDetailProps): JSX.Element {
  return (
    <Stack gap="section" data-testid="shared-blueprint-marketplace-detail">
      <InstallAction
        link={sharedBlueprintInstallLink(blueprint)}
        name={blueprint.name}
        testId="shared-blueprint-detail-add"
      />
    </Stack>
  );
}

export interface SharedPluginMarketplaceDetailProps {
  plugin: SharedPluginSummary;
}

/**
 * A shared plugin reference. Nothing is copied with it: the share names a
 * plugin by its source, and Install installs that plugin from the local catalog.
 */
export function SharedPluginMarketplaceDetail({
  plugin,
}: SharedPluginMarketplaceDetailProps): JSX.Element {
  return (
    <Stack gap="section" data-testid="shared-plugin-marketplace-detail">
      <InstallAction
        link={sharedResourceInstallLink({
          entity: 'plugin',
          externalId: plugin.externalId,
          scope: plugin.shareScope,
        })}
        name={plugin.name}
        testId="shared-plugin-detail-add"
      />
      <SettingsRowsSection title="Details">
        <SettingsRowsGroup>
          <SettingsRowsRow
            fact
            label="Source"
            control={
              <SettingsRowsValue>
                {shareablePluginSourceLabel(plugin.ref)}
              </SettingsRowsValue>
            }
          />
        </SettingsRowsGroup>
      </SettingsRowsSection>
      <p className="text-xs fg-secondary">
        Only a reference to this plugin is shared. Adding it installs the plugin
        from its source; credentials and configuration are yours to set up.
      </p>
    </Stack>
  );
}
