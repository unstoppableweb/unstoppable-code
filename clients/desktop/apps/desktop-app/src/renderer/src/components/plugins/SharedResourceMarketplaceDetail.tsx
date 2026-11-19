import { type JSX, type ReactNode, useEffect, useState } from 'react';
import {
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
import {
  Stack,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
} from '@canopy/ui-shared/components';
import type { SharedAgentSummary } from '@canopy/execution-engine/types/agent-models';
import type { DeepLinkShareOpenEvent } from '@canopy/desktop-shared/types';
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

/** The detail's one action: `Install`, when there is something to install. */
function InstallAction({
  link,
  name,
  testId,
}: {
  link: DeepLinkShareOpenEvent | null;
  name: string;
  testId: string;
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
          onClick={(): void => openInstallReview(link)}
          dataTestId={testId}
          stopKeyDownPropagation={false}
        />
      }
    />
  );
}

export interface SharedAgentMarketplaceDetailProps {
  agent: SharedAgentSummary;
}

/** A shared agent; Install opens the install review. */
export function SharedAgentMarketplaceDetail({
  agent,
}: SharedAgentMarketplaceDetailProps): JSX.Element {
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
      />
      {agent.instructionsPreview.trim() !== '' && (
        <SettingsRowsSection title="Details">
          <SettingsRowsGroup>
            <SettingsRowsRow fact label="Instructions">
              <p className="whitespace-pre-wrap text-s fg-secondary">
                {agent.instructionsPreview}
              </p>
            </SettingsRowsRow>
          </SettingsRowsGroup>
        </SettingsRowsSection>
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
  const [read, setRead] = useState<{
    readonly id: string;
    readonly detail: SharedAgentDetail | null;
    readonly error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    window.agents
      .getShared(agent.id)
      .then((detail) => {
        if (!cancelled) setRead({ id: agent.id, detail, error: null });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setRead({
          id: agent.id,
          detail: null,
          error:
            toAppError(failure)?.detail.message.trim() ||
            'Couldn’t load this agent',
        });
      });
    return (): void => {
      cancelled = true;
    };
  }, [agent.id, attempt]);
  const current = read?.id === agent.id ? read : null;
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
    ...(link ? { add: (): void => openInstallReview(link) } : {}),
    statuses: [],
    pendingKeys: new Set(),
  });
  return (
    <AgentReadDetail
      dataTestId="shared-agent-marketplace-detail"
      name={identity.entry.name}
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
        current?.detail?.agent.baseModel ?? agent.baseModel,
      )}
      items={
        current?.detail
          ? sharedAgentDetailItems(current.detail.agent.plugins)
          : []
      }
      instructions={current?.detail?.agent.instructions ?? ''}
      {...(current?.detail
        ? {}
        : {
            contentsNotice: current?.error ? (
              <span className="inline-flex flex-wrap items-center gap-1.5 text-s">
                <DetailFactError
                  error={current.error}
                  testId="shared-agent-detail-error"
                />
                <span aria-hidden>·</span>
                <Button
                  variant="link"
                  onClick={() => {
                    setRead(null);
                    setAttempt((count) => count + 1);
                  }}
                >
                  Try again
                </Button>
              </span>
            ) : (
              <DelayedLoadingPlaceholder slowNote="Still loading agent…">
                <CenteredLoadingSpinner spacing="section" />
              </DelayedLoadingPlaceholder>
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
