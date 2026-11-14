import { Stack } from '@canopy/ui-shared/components';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useCloudOrigin } from '@/lib/cloud-origin';
import {
  marketplaceShareLink,
  marketplaceLinkAccess,
  type SharedByYouFacts,
  type SharedLinkKind,
} from '@canopy/ui-app/sharing';
import { useMarketplaceCopyLinkMenuItem } from '@canopy/ui-app/capability';
import type { PluginMcpNavigationTarget } from '@canopy/ui-shared/components';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { CuratedMcpConnectionDetail } from './CuratedMcpConnectionDetail';
import { MarketplaceSkillDetail } from '../share/MarketplaceSkillDetail';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import { PluginDetailView } from '../pages/PluginDetailView';
import { SharedSkillDetailModal } from '../pages/SkillsTab';
import { InstalledSkillDetail } from '../skills/InstalledSkillDetail';
import {
  CollectionModal,
  SharedCollectionDetailModal,
} from '../pages/CollectionsTab';
import { CapabilityRelatedSections } from './CapabilityRelatedSections';
import { DetailBackButton } from '../shared/DetailBackButton';
import { DialogModal } from '../shared';
import { McpServerLogo } from '../shared/McpServerLogo';
import {
  MarketplaceDetailPageShell,
  McpAccountConnectionPicker,
  MarketplaceUnshareAction,
  PluginCatalogDetail,
  useMarketplaceUnshare,
  useResourceContext,
  type MarketplaceDetailPageHeader,
  type UseMarketplaceUnshareOptions,
} from '@canopy/ui-app/capability';
import {
  marketplaceUnsharedNotice,
  marketplaceUnshareMenuLabel,
  type MarketplaceUnshareKind,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import { publicLinkRemovedNotice } from '@canopy/ui-shared/lib/shared-by-you';
import {
  sharedByYouAudienceCount,
  type SharedByYouAudience,
} from '@canopy/ui-app/sharing';
import { SharedByYou } from './SharedByYou';
import {
  followMarketplaceUnshare,
  unshareMarketplaceResource,
  unshareOwnerName,
} from '@/lib/marketplaceUnshare';
import { postShareToast } from '@/lib/share-toast';
import {
  SHARED_AGENTS_CHANGED_EVENT,
  SHARED_PLUGINS_CHANGED_EVENT,
} from '@/hooks/useSharedMarketplaceShares';
import { DetailEntityTypeProvider } from '@canopy/ui-shared/components';
import {
  DetailActionBar,
  DetailActionSlotsProvider,
  DetailMoreItemsContributionProvider,
  DetailMoreItemsProvider,
  DetailMoreMenu,
  DetailPageActions,
  ExecutionActionButton,
  MarketplaceShareButton,
  useDetailActionSlots,
  useDetailMoreItemContributions,
  Notice,
  NoticeButton,
  type DetailMoreMenuItem,
} from '@canopy/ui-shared/components';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { applyPluginUpdateToMarketplaceCaches } from '../../hooks/useMarketplaceList';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { PipelineEditDeepLink } from '@/stores/navigationStore';
import type {
  UnifiedEntryRef,
  UnifiedPluginEntry,
} from '../../lib/unifiedPluginEntries';
import {
  CURATED_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
  type PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import type {
  McpServerIndexEntry,
  ProviderConnectorListResult,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  curatedMcpDesktopOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type {
  CollectionIndexEntry,
  SharedCollectionDetail,
  SharedCollectionSummary,
} from '@canopy/desktop-shared/types/collections';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
  SharedSkillSummary,
} from '@canopy/desktop-shared/types/skills';
import { ProviderConnectorDetail } from './ProviderConnectorDetail';
import { TryItPrimaryCta } from './TryItPrimaryCta';
import type { AccountMcpDetailSignIn } from '../mcp/useAccountMcpActionRequests';
import {
  accountMcpConnectionKey,
  accountMcpConfigurationKey,
} from '@/hooks/useAccountMcpActions';
import { pluginHarnessSupport } from '@/lib/tryItRuntime';
import {
  buildTryItPrompt,
  CURATED_MCP_TRY_IT_SOURCE_ID,
  LOCAL_MCP_TRY_IT_SOURCE_ID,
  type TryItCapability,
} from '@canopy/protocol/try-it';
import { CUSTOM_SKILL_SOURCE_ID } from '@/lib/sharedSkillImport';
import { entryIdForSelection } from '@/lib/relatedCapabilities';
import { PipelineCatalogDetail } from '../pipeline/PipelineCatalogDetail';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  AutomationCatalogDetail,
  CuratedAutomationMarketplaceDetail,
  SharedAutomationMarketplaceDetail,
} from '../automations/AutomationCatalogDetail';
import type { CuratedAutomationsController } from '@/hooks/useCuratedAutomations';
import type {
  AgentModelDefinition,
  SharedAgentSummary,
} from '@canopy/execution-engine/types/agent-models';
import { LocalAgentMarketplaceDetail } from './LocalAgentMarketplaceDetail';
import {
  getShareablePluginRefKey,
  type SharedPluginSummary,
} from '@canopy/protocol/plugins';
import { computePluginShareableRef } from '@/hooks/useUnifiedTableData';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import {
  SharedAgentMarketplaceDetail,
  SharedBlueprintMarketplaceDetail,
  SharedPluginMarketplaceDetail,
} from './SharedResourceMarketplaceDetail';
import {
  sharedAgentDetailHeader,
  sharedBlueprintDetailHeader,
  sharedPluginDetailHeader,
} from './sharedResourceDetailHeaders';
import {
  useNavigationStore,
  type CapabilityMarketplaceReturnTarget,
} from '@/stores/navigationStore';
import { sharedResourceInstallLink } from '@/lib/sharedResourceInstallLink';
import { InstalledEntryStatusSection } from './InstalledEntryStatusSection';

/**
 * Unified entry detail surface for the Plugins discovery page (API-2153,
 * design section 4).
 *
 * This is a **thin wrapper**: it resolves an entry's `ref` back to the source
 * object and hands it to the flow that already owns it. Nothing here reimplements
 * install, uninstall, provider-compatibility toggling, MCP add/auth, or skill
 * viewing — those live in `PluginDetailView`, `McpServerDialog`,
 * `CuratedDetail`, and `InstalledSkillDetail` respectively and are consumed
 * as-is.
 *
 * Shell-owned branches can render in a dialog or inline page presentation.
 * MCP editor branches continue to own their existing dialogs, and a custom
 * skill's editor replaces its detail page (CAN-3485).
 */
export interface PluginEntryDetailProps {
  entry: UnifiedPluginEntry;
  /** Render shell-owned branches as a dialog or as inline page content. */
  presentation?: 'modal' | 'page';
  /** Opens the add/configuration flow immediately when the card CTA initiated it. */
  initialIntent?: 'view' | 'add';
  mcpTarget?: PluginMcpNavigationTarget;
  /**
   * The entry's Share: the host's share flow for a resolved target (a plugin,
   * or the viewer's own skill, pipeline, automation or collection), or the
   * reason sharing is unavailable. Omitted on hosts that cannot share. Each
   * branch renders it once, beside the detail's primary action.
   */
  shareAction?: MarketplaceShareAction;
  /** Use the polished catalog summary before the plugin's install/details view. */
  preferCatalogDetail?: boolean;
  /** Every registered marketplace, used to resolve plugin refs. */
  marketplaces: MarketplaceInfo[];
  /** Local MCP server index, used to join a curated key to an installed server. */
  mcpServers: McpServerIndexEntry[];
  /** Whether the account connection list was read; drives the Add rule. */
  accountConnectionsAvailable?: boolean;
  /** The page's sign-in, which owns Connect for an account-backed card. */
  accountSignIn?: AccountMcpDetailSignIn;
  /**
   * Whether the host can edit a shared collection from its detail
   * (`marketplace-shared-collection-edit`, CAN-4263). Off hides Edit.
   */
  sharedCollectionEditAvailable?: boolean;
  /** Curated MCP catalog, used to resolve `curated-mcp` refs and rehydrate constraints. */
  curatedMcpServers: CuratedMcpServerEntry[];
  localCollections: CollectionIndexEntry[];
  sharedCollections: SharedCollectionSummary[];
  sharedSkills: SharedSkillSummary[];
  pipelines: PipelineInfo[];
  /**
   * Every local automation, in or out of the selected context. Resolves
   * `automation` refs and tells whether a shared or curated one is installed.
   */
  automationActivities: ScheduledActivity[];
  /** The curated automation catalog, which owns the selected curated detail. */
  curatedAutomations: Pick<
    CuratedAutomationsController,
    'selectedKey' | 'detail' | 'detailLoading' | 'detailError' | 'onSelectKey'
  >;
  /** Opens a local automation in the Automations editor. */
  onOpenAutomation: (activityId: string) => void;
  /**
   * Local agent definitions; resolves `local-agent` refs. Omitted by hosts
   * that list no local agents.
   */
  localAgents?: AgentModelDefinition[];
  /** True until the local agent inventory first settles. */
  localAgentsLoading?: boolean;
  localAgentsError?: string | null;
  onRetryLocalAgents?: () => void;
  /** Opens the host's agent editor over the detail. */
  onEditLocalAgent?: (agent: AgentModelDefinition) => void;
  /** Opens the host's delete confirmation for the agent. */
  onDeleteLocalAgent?: (agent: AgentModelDefinition) => void;
  /** Agents shared with the viewer; resolves `shared-agent` refs. */
  sharedAgents: SharedAgentSummary[];
  /** Plugin references shared with the viewer; resolves `shared-plugin` refs. */
  sharedPlugins: SharedPluginSummary[];
  /**
   * The viewer's own plugin shares, including link-only ones; the installed
   * plugin page's Shared by you reads its share from here (CAN-4842).
   */
  ownSharedPlugins?: SharedPluginSummary[];
  /** Project templates shared with the viewer. */
  sharedBlueprints?: WorkspaceTemplateShareSummary[];
  /** Per-provider connector reads, used to resolve `provider-connector` refs. */
  providerConnectors: ProviderConnectorListResult[];
  /** True while a connector read is in flight. */
  providerConnectorsLoading: boolean;
  /** Re-read connector state after the user returns from a provider's site. */
  onProviderConnectorsChanged: () => void;
  onClose: () => void;
  /**
   * Open another entry's detail in place (related-item navigation,
   * CAN-2382). The host swaps the selected entry and keeps a back stack.
   */
  onOpenEntry?: (entryId: string) => void;
  /** Opens a marketplace source's page, to manage what it installed. */
  onOpenMarketplaceSource?: (sourceId: string) => void;
  /** Open a related pipeline while preserving host-owned detail history. */
  onOpenPipeline?: (link: PipelineEditDeepLink) => void;
  returnToMarketplace?: CapabilityMarketplaceReturnTarget;
  /**
   * Where Back goes, whatever the host decides that is: pop its detail stack
   * (CAN-2382), reopen a pipeline editor, or close the detail. Do not read a
   * defined value as "a stack exists" — every page-presented entry gets one,
   * and a branch on that assumption is how the missing/double Back returns.
   */
  onNavigateBack?: () => void;
  /** Called after an MCP server is created or edited so the index reloads. */
  onServersChanged: () => Promise<void>;
  /**
   * The installed skill inventory. An installed skill's Share and
   * Delete/Remove eligibility is read from its record here (CAN-3483).
   */
  installedSkills: InstalledSkillInfo[];
  /**
   * An installed skill was renamed from its detail's Edit; the host moves the
   * open detail to the renamed skill in place.
   */
  onInstalledSkillRenamed?: (skill: { sourceId: string; name: string }) => void;
  /** Opens account settings from a share flow's sign-in prompt. */
  onOpenAccountSettings?: () => void;
  /** Supporting file an installed skill's detail opens on (deep links). */
  initialSkillFilePath?: string;
  /**
   * Whether a custom skill's edit page replaces its detail (CAN-3485). The
   * host owns it because the page breadcrumb gains an Edit level.
   */
  skillEditing?: boolean;
  onSkillEditingChange?: (editing: boolean) => void;
  onLocalCollectionsChanged: () => Promise<void>;
  onSharedSkillsChanged: () => Promise<void>;
  onSharedCollectionsChanged: () => Promise<void>;
  onSharedResourceUnshared?: (kind: MarketplaceUnshareKind, id: string) => void;
  /**
   * Reports the entry's current display name when a local override (e.g. a
   * rename saved from the edit overlay) changes it, so the host can keep its
   * breadcrumb in sync while the refreshed server-filtered inventory no
   * longer contains the row (CAN-2779 review round 5).
   */
  onDisplayNameChange?: (name: string) => void;
}

interface ResolvedPlugin {
  marketplace: MarketplaceInfo;
  plugin: PluginInfo;
}

function findMarketplace(
  marketplaces: MarketplaceInfo[],
  ref: UnifiedEntryRef,
): MarketplaceInfo | undefined {
  if (ref.type === 'marketplace-plugin') {
    return marketplaces.find(
      (marketplace) => marketplace.id === ref.marketplaceId,
    );
  }
  return marketplaces.find(
    (marketplace) =>
      marketplace.curated === true ||
      marketplace.id === CURATED_PLUGIN_MARKETPLACE_ID,
  );
}

/**
 * Resolve a plugin-shaped ref back to its `{ marketplace, plugin }` pair.
 *
 * Curated entries are keyed by the catalog `key`, which the projection derives
 * from `PluginInfo.name` — the same join key `buildUnifiedPluginEntries` uses —
 * so both ref shapes match on `plugin.name`.
 */
function resolvePlugin(
  marketplaces: MarketplaceInfo[],
  ref: UnifiedEntryRef,
): ResolvedPlugin | null {
  if (ref.type !== 'curated-plugin' && ref.type !== 'marketplace-plugin') {
    return null;
  }
  const marketplace = findMarketplace(marketplaces, ref);
  if (!marketplace) return null;
  const pluginName = ref.type === 'curated-plugin' ? ref.key : ref.pluginName;
  const plugin = marketplace.plugins.find(
    (candidate) => candidate.name === pluginName,
  );
  return plugin ? { marketplace, plugin } : null;
}

/** Installed and needs-auth both count as installed for the detail CTA. */
function entryInstallation(
  entry: Pick<UnifiedPluginEntry, 'state'>,
): 'installed' | 'not-installed' {
  return entry.state === 'available' ? 'not-installed' : 'installed';
}

/** Presentation shell shared by the branches that are not already dialogs. */
function DetailShell({
  title,
  presentation,
  onClose,
  onNavigateBack,
  shareAction,
  primaryAction,
  children,
  fluid = false,
  header,
  moreItems,
}: {
  fluid?: boolean;
  /**
   * A page's item header (CAN-4266): the shell shows the title, this
   * description and meta, and the actions beside them, with no Back row.
   */
  header?: MarketplaceDetailPageHeader;
  /** Rarer header actions, such as the owner's Unshare, in its ⋯ menu. */
  moreItems?: readonly DetailMoreMenuItem[];
  title: string;
  presentation: 'modal' | 'page';
  onClose: () => void;
  /** Renders a back chip pointing wherever the host's Back goes. */
  onNavigateBack?: () => void;
  /**
   * Share, in the standard action bar at the top right of the Back row:
   * `[secondary…] [Share] [Primary]`. Bodies declare their own page actions
   * with `DetailPageActions`, which join the same bar.
   */
  shareAction?: MarketplaceShareAction;
  /** A primary action the shell owns, such as the plugin summary's Add. */
  primaryAction?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  const slots = useDetailActionSlots();
  const contributedMore = useDetailMoreItemContributions();
  const fallbackMore =
    slots.moreDeclared === 0 && contributedMore.items.length > 0 ? (
      <DetailMoreMenu
        name={title}
        items={contributedMore.items}
        triggerTestId="plugins-entry-detail-more"
        menuTestId="plugins-entry-detail-menu"
        placement="bottom-right"
      />
    ) : undefined;
  const shareButton = shareAction ? (
    <MarketplaceShareButton
      action={shareAction}
      name={title}
      placement="detail"
      dataTestId="plugins-entry-detail-share"
    />
  ) : undefined;
  if (presentation === 'page') {
    return (
      <MarketplaceDetailPageShell
        title={title}
        onNavigateBack={onNavigateBack}
        share={shareButton}
        width={fluid ? 'fluid' : 'constrained'}
        header={header}
        moreItems={moreItems}
      >
        {primaryAction ? (
          <>
            <DetailPageActions primary={primaryAction} />
            {children}
          </>
        ) : (
          children
        )}
      </MarketplaceDetailPageShell>
    );
  }

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      titleId="plugins-entry-detail-title"
      maxWidth="3xl"
      headerBorder={false}
      dataTestId="plugins-entry-detail"
      scrollableBody={false}
    >
      {/* DialogModal pads only its header; body content pads itself (px to
          match the header's 24px inset, bottom padding to keep the scroll end off
          the rounded edge). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 pb-6">
        {(onNavigateBack ||
          shareButton ||
          primaryAction ||
          fallbackMore ||
          slots.declared > 0) && (
          <div className="flex items-start justify-between gap-2">
            {onNavigateBack ? (
              <DetailBackButton onNavigateBack={onNavigateBack} />
            ) : (
              <span />
            )}
            <DetailActionBar
              more={fallbackMore}
              share={shareButton}
              primary={primaryAction}
              slots={slots}
            />
          </div>
        )}
        <DetailActionSlotsProvider slots={slots}>
          <DetailMoreItemsContributionProvider
            contribute={contributedMore.contribute}
          >
            <DetailMoreItemsProvider items={contributedMore.items}>
              {children}
            </DetailMoreItemsProvider>
          </DetailMoreItemsContributionProvider>
        </DetailActionSlotsProvider>
      </div>
    </DialogModal>
  );
}

/**
 * A shared item's page (CAN-4266): its header with the owner's Unshare last in
 * the ⋯ menu, when the viewer may delete the share.
 */
function SharedDetailShell({
  unshare,
  audienceCount = 0,
  copyTarget,
  ...shell
}: Parameters<typeof DetailShell>[0] & {
  unshare: UseMarketplaceUnshareOptions | null;
  /** Rows in the Shared by you section; two read the item "Unshare all". */
  audienceCount?: number;
  copyTarget?: {
    kind: SharedLinkKind;
    itemId: string;
    facts: SharedByYouFacts;
  };
}): JSX.Element {
  const origin = useCloudOrigin();
  const { personalOrganizationId } = useResourceContext();
  const link = copyTarget
    ? marketplaceShareLink(origin, copyTarget.kind, copyTarget.itemId)
    : null;
  const access = copyTarget
    ? marketplaceLinkAccess(copyTarget.facts, personalOrganizationId)
    : null;
  const copy = useMarketplaceCopyLinkMenuItem(
    link && access ? { link, access } : null,
    { write: copyTextToClipboard, notify: postShareToast },
  );
  const moreItems = copy ? [copy] : [];
  if (unshare === null) return <DetailShell {...shell} moreItems={moreItems} />;
  return (
    <SharedDetailShellWithUnshare
      unshare={unshare}
      audienceCount={audienceCount}
      {...shell}
      moreItems={moreItems}
    />
  );
}

function SharedDetailShellWithUnshare({
  unshare: options,
  audienceCount,
  ...shell
}: Parameters<typeof DetailShell>[0] & {
  unshare: UseMarketplaceUnshareOptions;
  audienceCount: number;
}): JSX.Element {
  const unshare = useMarketplaceUnshare(options);
  return (
    <>
      <DetailShell
        {...shell}
        moreItems={[
          ...(shell.moreItems ?? []),
          {
            ...unshare.item,
            label: marketplaceUnshareMenuLabel(audienceCount),
          },
        ]}
      />
      {unshare.dialog}
    </>
  );
}

export function PluginEntryDetail(props: PluginEntryDetailProps): JSX.Element {
  return (
    <DetailEntityTypeProvider kind={props.entry.kind}>
      <PluginEntryDetailContent {...props} />
    </DetailEntityTypeProvider>
  );
}

function PluginEntryDetailContent({
  entry,
  presentation = 'modal',
  initialIntent = 'view',
  mcpTarget,
  shareAction,
  preferCatalogDetail = false,
  marketplaces,
  mcpServers,
  accountConnectionsAvailable,
  accountSignIn,
  sharedCollectionEditAvailable = false,
  curatedMcpServers,
  localCollections,
  sharedCollections,
  sharedSkills,
  pipelines,
  automationActivities,
  curatedAutomations,
  onOpenAutomation,
  localAgents = [],
  localAgentsLoading = false,
  localAgentsError = null,
  onRetryLocalAgents,
  onEditLocalAgent,
  onDeleteLocalAgent,
  sharedAgents,
  sharedPlugins,
  ownSharedPlugins = [],
  sharedBlueprints = [],
  onClose,
  onOpenEntry,
  onOpenMarketplaceSource,
  onOpenPipeline,
  returnToMarketplace,
  onNavigateBack,
  onServersChanged,
  installedSkills,
  onInstalledSkillRenamed,
  onOpenAccountSettings,
  initialSkillFilePath,
  skillEditing,
  onSkillEditingChange,
  onLocalCollectionsChanged,
  onSharedSkillsChanged,
  onSharedCollectionsChanged,
  onSharedResourceUnshared,
  onDisplayNameChange,
  providerConnectors,
  providerConnectorsLoading,
  onProviderConnectorsChanged,
}: PluginEntryDetailProps): JSX.Element | null {
  // Local overrides: an install or compatibility toggle re-renders the
  // detail immediately, while the shared cache write below keeps every other
  // surface (row states, install counters) in agreement.
  const [mcpSignInOpen, setMcpSignInOpen] = useState(false);
  const [pluginOverride, setPluginOverride] = useState<PluginInfo | null>(null);
  const [pluginAddOpen, setPluginAddOpen] = useState(false);
  const [curatedEditorOpen, setCuratedEditorOpen] = useState(false);
  const [curatedDetailBusy, setCuratedDetailBusy] = useState(false);
  const [selectedAccountConnectionId, setSelectedAccountConnectionId] =
    useState<string | null | undefined>(undefined);
  // Add through a folded provider connector installs the folded plugin as
  // that route starts or confirms; the connection detail owns the install.
  const [foldedPluginInstallRequest, setFoldedPluginInstallRequest] =
    useState(0);
  const foldedPluginKey = entry.integration?.plugin?.key;
  const connectorConnected = entry.integration?.connector?.connected === true;
  // Add through the connector route installs the folded plugin when the
  // route starts (the provider settings opened) or confirms (the connector
  // reads back as linked); a plain re-read installs nothing.
  useEffect(() => {
    if (initialIntent === 'add' && foldedPluginKey && connectorConnected)
      setFoldedPluginInstallRequest((count) => count + 1);
  }, [connectorConnected, foldedPluginKey, initialIntent]);
  const [editingSharedSkill, setEditingSharedSkill] = useState(false);
  const [editingCollection, setEditingCollection] = useState(false);
  const { personalOrganizationId } = useResourceContext();
  const [sharedSkillOverride, setSharedSkillOverride] =
    useState<SharedSkillDetail | null>(null);
  const [sharedCollectionOverride, setSharedCollectionOverride] =
    useState<SharedCollectionDetail | null>(null);

  // The owner's Unshare (CAN-4263), for a share whose current verdict is
  // `canDelete === true`. After main confirms the delete, the kind's shared
  // list re-reads (retiring any older read) and the detail closes back to the
  // Marketplace browse state it opened from.
  const refreshSharedList = (kind: MarketplaceUnshareKind): void => {
    if (kind === 'skill') void onSharedSkillsChanged().catch(() => {});
    if (kind === 'collection')
      void onSharedCollectionsChanged().catch(() => {});
    if (kind === 'agent')
      window.dispatchEvent(new Event(SHARED_AGENTS_CHANGED_EVENT));
    if (kind === 'plugin')
      window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
  };
  const afterUnshared = (
    kind: MarketplaceUnshareKind,
    shareId: string,
    name: string,
  ): void => {
    onSharedResourceUnshared?.(kind, shareId);
    followMarketplaceUnshare(kind, name, {
      sharedSkills: onSharedSkillsChanged,
      sharedCollections: onSharedCollectionsChanged,
    });
    onClose();
  };
  // Removing only the public link keeps the share, so the detail stays open.
  const afterPublicLinkRemoved = (
    kind: MarketplaceUnshareKind,
    name: string,
  ): void => {
    refreshSharedList(kind);
    postShareToast({
      tone: 'success',
      message: publicLinkRemovedNotice(name),
      blockMessageFromReplay: true,
    });
  };
  const sharedByYouUnshared =
    (kind: MarketplaceUnshareKind, shareId: string, name: string) =>
    (audience: SharedByYouAudience): void => {
      if (audience.id === 'public') afterPublicLinkRemoved(kind, name);
      else afterUnshared(kind, shareId, name);
    };
  const unshareOptions = (share: {
    kind: MarketplaceUnshareKind;
    shareId: string;
    name: string;
    owner: { type: string; name?: string | null };
    canDelete: boolean | undefined;
  }): UseMarketplaceUnshareOptions | null => {
    if (share.canDelete !== true) return null;
    const { kind, shareId, name } = share;
    return {
      kind,
      name,
      ownerName: unshareOwnerName(share.owner),
      onUnshare: () => unshareMarketplaceResource(kind, shareId),
      onUnshared: (): void => afterUnshared(kind, shareId, name),
    };
  };
  const renderUnshare = (
    share: Parameters<typeof unshareOptions>[0],
  ): JSX.Element | null => {
    const options = unshareOptions(share);
    return options === null ? null : (
      <MarketplaceUnshareAction
        key={`${options.kind}:${share.shareId}`}
        {...options}
      />
    );
  };

  // Overrides can rename the entry while the server-filtered inventory no
  // longer returns its row; surface the fresh name so the host breadcrumb
  // does not go stale alongside its retained entry. The callback rides in a
  // latest-ref so an inline host callback cannot retrigger this effect (and
  // re-render loop) on every parent render.
  const onDisplayNameChangeRef = useRef(onDisplayNameChange);
  useEffect(() => {
    onDisplayNameChangeRef.current = onDisplayNameChange;
  });
  const overrideDisplayName =
    sharedSkillOverride?.name ?? sharedCollectionOverride?.name ?? null;
  useEffect(() => {
    if (overrideDisplayName !== null) {
      onDisplayNameChangeRef.current?.(overrideDisplayName);
    }
  }, [overrideDisplayName]);

  const ref = entry.ref;
  // Pipelines, automations and collections keep their existing rule: Share
  // only when the viewer's own item resolved.
  const enabledShareAction =
    shareAction?.status === 'shareable' ? shareAction : undefined;

  // Identifiers and derived state only. The plugin manifest, MCP endpoint or
  // credentials, and skill body must never reach App Advisor's context.
  useCurrentUiStateReporter(
    'plugins.entryDetail',
    useMemo(
      () => ({
        open: true,
        entryId: entry.id,
        kind: entry.kind,
        state: entry.state,
        refType: ref.type,
        // The installed curated MCP sub-page can layer the config editor
        // dialog above itself (CAN-2768); App Advisor needs to know which
        // surface currently owns the interaction.
        mcpEditorOpen: curatedEditorOpen,
        editingSharedSkill,
        editingCollection,
      }),
      [
        curatedEditorOpen,
        editingCollection,
        editingSharedSkill,
        entry.id,
        entry.kind,
        entry.state,
        ref.type,
      ],
    ),
  );

  const resolved = useMemo(
    () => resolvePlugin(marketplaces, ref),
    [marketplaces, ref],
  );
  // The source list is these same rows, so a marketplace outside them has no
  // page to open and its name stays plain text.
  const openSource = (sourceId: string): (() => void) | undefined =>
    onOpenMarketplaceSource &&
    marketplaces.some((marketplace) => marketplace.id === sourceId)
      ? (): void => onOpenMarketplaceSource(sourceId)
      : undefined;
  // The viewer's own share of this installed plugin (an account share, a
  // public link or both), matched on its share key, for the Shared by you
  // section (CAN-4842).
  const ownPluginShare = useMemo(() => {
    if (!resolved) return undefined;
    const shareableRef = computePluginShareableRef(
      pluginOverride ?? resolved.plugin,
      resolved.marketplace,
    );
    if (!shareableRef) return undefined;
    const refKey = getShareablePluginRefKey(shareableRef);
    return ownSharedPlugins.find(
      (share) => share.canDelete === true && share.refKey === refKey,
    );
  }, [ownSharedPlugins, pluginOverride, resolved]);

  const localServer = useMemo(
    () =>
      ref.type === 'local-mcp'
        ? flattenMcpServerRows(mcpServers).find(
            (server) =>
              server.id === ref.serverId &&
              // Account rows for one key share the server id; the ref's
              // configuration picks the connection (REG-3033).
              (ref.configId === undefined ||
                server.accountConnection?.configId === ref.configId),
          )
        : undefined,
    [mcpServers, ref],
  );
  const curatedEntry = useMemo(() => {
    const key = ref.type === 'curated-mcp' ? ref.key : localServer?.curatedKey;
    return key
      ? curatedMcpServers.find((candidate) => candidate.key === key)
      : undefined;
  }, [curatedMcpServers, localServer, ref]);
  const accountConnections = useMemo(
    () =>
      ref.type === 'curated-mcp'
        ? flattenMcpServerRows(mcpServers).flatMap((row) =>
            row.scope === 'account' &&
            row.curatedKey === ref.key &&
            row.accountConnection
              ? [row.accountConnection]
              : [],
          )
        : [],
    [mcpServers, ref],
  );
  const selectedAccountConnection = accountConnections.find(
    (connection) => connection.id === selectedAccountConnectionId,
  );

  // Account rows carry no device file, so only a device-backed row (or a
  // device copy nested under an account row) may be loaded by the local
  // connection detail. Account-only rows continue to open account details.
  const installedCurated = useMemo(() => {
    if (ref.type !== 'curated-mcp') return { deviceId: null, accountId: null };
    const rows = flattenMcpServerRows(mcpServers).filter(
      (server) => server.curatedKey === ref.key,
    );
    return {
      deviceId: rows.find((server) => server.scope !== 'account')?.id ?? null,
      accountId: rows.find((server) => server.scope === 'account')?.id ?? null,
    };
  }, [mcpServers, ref]);
  const installedCuratedServerId = installedCurated.deviceId;
  // Only the desktop connects a desktop-only server, as a device server
  // (REG-3035). An account row for its key is a connection made before it
  // was marked: it never backs the card, so Add always reaches the device
  // server rather than the account's details or a cloud reconnect.
  const curatedDesktopOnly =
    ref.type === 'curated-mcp' &&
    curatedEntry !== undefined &&
    curatedMcpDesktopOnly(curatedEntry);
  const accountServerId =
    localServer?.scope === 'account'
      ? localServer.id
      : ref.type === 'curated-mcp' &&
          installedCurated.deviceId === null &&
          !curatedDesktopOnly
        ? installedCurated.accountId
        : null;

  if (
    ref.type === 'public-share' &&
    (ref.shareKind === 'skill' || ref.shareKind === 'plugin')
  ) {
    return (
      <MarketplaceSkillDetail
        entity={ref.shareKind}
        externalId={ref.externalId}
        name={entry.name}
        onClose={onClose}
        shareAction={shareAction}
      />
    );
  }
  if (ref.type === 'pipeline') {
    const pipeline = pipelines.find(
      (candidate) =>
        candidate.id === ref.pipelineId && candidate.source === ref.source,
    );
    if (!pipeline) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        shareAction={enabledShareAction}
      >
        <PipelineCatalogDetail
          pipeline={pipeline}
          onOpenEntry={onOpenEntry}
          onOpenEditor={() =>
            onOpenPipeline?.({
              pipelineId: ref.pipelineId,
              ...(ref.source === 'bundled' || ref.source === 'user'
                ? { source: ref.source }
                : {}),
              ...(ref.source === 'project' && ref.filePath
                ? { filePath: ref.filePath }
                : {}),
              ...(ref.source === 'shared' && ref.remoteId
                ? { sharedRemoteId: ref.remoteId }
                : {}),
              ...(returnToMarketplace ? { returnToMarketplace } : {}),
            })
          }
        />
      </DetailShell>
    );
  }

  if (ref.type === 'automation') {
    const activity = automationActivities.find(
      (candidate) => candidate.id === ref.activityId,
    );
    if (!activity) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        shareAction={enabledShareAction}
      >
        <AutomationCatalogDetail
          activity={activity}
          summary={entry.description}
          updateAvailable={entry.updateAvailable === true}
          onOpenInAutomations={() => onOpenAutomation(activity.id)}
        />
      </DetailShell>
    );
  }

  if (ref.type === 'shared-automation') {
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
      >
        <SharedAutomationMarketplaceDetail
          automationId={ref.automationId}
          activities={automationActivities}
          onOpenInAutomations={onOpenAutomation}
          // A share opened by id before the inventory lists it (a public-link
          // share outside "Shared by me") learns its name from the detail.
          onNameLoaded={(name): void => onDisplayNameChangeRef.current?.(name)}
        />
      </DetailShell>
    );
  }

  if (ref.type === 'local-agent') {
    const agent = localAgents.find((item) => item.id === ref.agentId);
    const loadError =
      localAgentsError && !localAgentsLoading ? (
        <Notice
          errorSource="local-agent-detail-error"
          intent="destructive"
          data-testid="local-agent-detail-error"
          actions={
            <NoticeButton onClick={onRetryLocalAgents}>Try again</NoticeButton>
          }
        >
          Couldn't load your agents.
        </Notice>
      ) : null;
    if (!agent) {
      if (loadError) {
        return (
          <DetailShell
            title={entry.name}
            presentation={presentation}
            onClose={onClose}
            onNavigateBack={onNavigateBack}
          >
            {loadError}
          </DetailShell>
        );
      }
      // A deep link can land before the inventory hydrates; only a settled
      // inventory without the agent means it is gone.
      if (localAgentsLoading) {
        return (
          <DetailShell
            title={entry.name}
            presentation={presentation}
            onClose={onClose}
            onNavigateBack={onNavigateBack}
          >
            <p
              className="text-s fg-secondary"
              data-testid="local-agent-detail-loading"
            >
              Loading agent…
            </p>
          </DetailShell>
        );
      }
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        shareAction={enabledShareAction}
      >
        <LocalAgentMarketplaceDetail
          agent={agent}
          onEdit={(): void => onEditLocalAgent?.(agent)}
          onDelete={(): void => onDeleteLocalAgent?.(agent)}
          // A cached definition may predate the agent while the list loads
          // or after its read failed; Edit waits for a fresh one.
          editDisabled={localAgentsLoading || Boolean(localAgentsError)}
          notice={loadError}
        />
      </DetailShell>
    );
  }

  if (ref.type === 'shared-agent') {
    const agent = sharedAgents.find((item) => item.id === ref.agentId);
    if (!agent) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    // Shared by you renders exactly these rows; the header defers to them.
    const agentAudienceCount = sharedByYouAudienceCount(
      agent,
      personalOrganizationId,
    );
    return (
      <SharedDetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        header={sharedAgentDetailHeader(agent, personalOrganizationId, {
          audienceListedBelow: agentAudienceCount > 0,
        })}
        unshare={unshareOptions({
          kind: 'agent',
          shareId: agent.id,
          name: agent.name,
          owner: agent.owner,
          canDelete: agent.canDelete,
        })}
        audienceCount={agentAudienceCount}
        copyTarget={{ kind: 'agent', itemId: agent.id, facts: agent }}
      >
        <Stack gap="section">
          <SharedAgentMarketplaceDetail agent={agent} />
          <SharedByYou
            kind="agent"
            shareId={agent.id}
            name={agent.name}
            facts={agent}
            onUnshared={sharedByYouUnshared('agent', agent.id, agent.name)}
          />
        </Stack>
      </SharedDetailShell>
    );
  }

  if (ref.type === 'shared-plugin') {
    const plugin = sharedPlugins.find(
      (item) => item.externalId === ref.pluginId,
    );
    if (!plugin) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    // Shared by you renders exactly these rows; the header defers to them.
    const pluginAudienceCount = sharedByYouAudienceCount(
      plugin,
      personalOrganizationId,
    );
    return (
      <SharedDetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        shareAction={shareAction}
        header={sharedPluginDetailHeader(plugin, personalOrganizationId, {
          audienceListedBelow: pluginAudienceCount > 0,
        })}
        unshare={unshareOptions({
          kind: 'plugin',
          shareId: plugin.externalId,
          name: plugin.name,
          owner: plugin.owner,
          canDelete: plugin.canDelete,
        })}
        audienceCount={pluginAudienceCount}
        copyTarget={{
          kind: 'plugin',
          itemId: plugin.externalId,
          facts: plugin,
        }}
      >
        <Stack gap="section">
          <SharedPluginMarketplaceDetail plugin={plugin} />
          <SharedByYou
            kind="plugin"
            shareId={plugin.externalId}
            name={plugin.name}
            facts={plugin}
            onUnshared={sharedByYouUnshared(
              'plugin',
              plugin.externalId,
              plugin.name,
            )}
          />
        </Stack>
      </SharedDetailShell>
    );
  }

  if (ref.type === 'shared-blueprint') {
    const blueprint = sharedBlueprints.find(
      (item) => item.externalId === ref.blueprintId,
    );
    if (!blueprint) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    return (
      <SharedDetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        header={sharedBlueprintDetailHeader(blueprint, personalOrganizationId)}
        unshare={null}
      >
        <SharedBlueprintMarketplaceDetail blueprint={blueprint} />
      </SharedDetailShell>
    );
  }

  if (ref.type === 'curated-automation') {
    // The catalog hook owns the detail; the host selects this entry's key, so
    // a detail left over from another key reads as still loading.
    const selected = curatedAutomations.selectedKey === ref.key;
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
      >
        <CuratedAutomationMarketplaceDetail
          name={entry.name}
          detail={selected ? curatedAutomations.detail : null}
          loading={!selected || curatedAutomations.detailLoading}
          error={selected ? curatedAutomations.detailError : null}
          onRetry={() => curatedAutomations.onSelectKey(ref.key)}
          activities={automationActivities}
          onOpenInAutomations={onOpenAutomation}
        />
      </DetailShell>
    );
  }

  const handlePluginUpdated = (
    marketplaceId: string,
    marketplacePluginName: string,
    updated: PluginInfo,
  ): void => {
    setPluginOverride(updated);
    // Keyed by the ORIGINAL marketplace plugin name: a provider install can
    // rename the returned plugin, and the cache row is still filed under the
    // name the marketplace advertises.
    applyPluginUpdateToMarketplaceCaches(
      marketplaceId,
      marketplacePluginName,
      updated,
    );
  };

  if (ref.type === 'provider-connector') {
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
      >
        <ProviderConnectorDetail
          displayName={ref.displayName}
          results={providerConnectors}
          curatedMcpServers={curatedMcpServers}
          loading={providerConnectorsLoading}
          onConnected={onProviderConnectorsChanged}
        />
      </DetailShell>
    );
  }

  if (ref.type === 'curated-plugin' || ref.type === 'marketplace-plugin') {
    if (!resolved) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    const marketplacePluginName = resolved.plugin.name;
    const pluginInstallation = entryInstallation(entry);
    const pluginTryIt = (
      onInstall: () => void = () => setPluginAddOpen(true),
      busy = false,
    ): JSX.Element => (
      <TryItPrimaryCta
        capability={{
          kind: 'plugin',
          sourceId: resolved.marketplace.id,
          catalogId: marketplacePluginName,
          name: entry.name,
        }}
        prompt={buildTryItPrompt({
          kind: 'plugin',
          name: entry.name,
          description: entry.description,
          tryNowPrompt: (pluginOverride ?? resolved.plugin).tryNowPrompt,
        })}
        installation={pluginInstallation}
        harnessSupport={pluginHarnessSupport(pluginOverride ?? resolved.plugin)}
        runtimeSelections={
          pluginInstallation === 'installed'
            ? {
                skillRefs: [],
                pluginRefs: [
                  {
                    marketplaceId: resolved.marketplace.id,
                    pluginName: marketplacePluginName,
                  },
                ],
              }
            : undefined
        }
        onInstall={onInstall}
        installBusy={busy}
        guestInstallAction={
          <ExecutionActionButton
            label="Install"
            ariaLabel={`Install ${entry.name}`}
            placement="detail"
            // On the summary this opens the add view. In the add view it is
            // the view's own install handler: reopening the view would not
            // retry a failed auto-install.
            onClick={onInstall}
            disabled={busy}
            dataTestId="plugin-catalog-detail-add"
            stopKeyDownPropagation={false}
          />
        }
      />
    );
    if (
      preferCatalogDetail &&
      mcpTarget === undefined &&
      initialIntent === 'view' &&
      !pluginAddOpen &&
      entry.state === 'available'
    ) {
      return (
        <DetailShell
          title={entry.name}
          presentation={presentation}
          onClose={onClose}
          onNavigateBack={onNavigateBack}
          shareAction={shareAction}
          primaryAction={pluginTryIt()}
        >
          <PluginCatalogDetail
            entry={{
              name: entry.name,
              // The entry already carries the product-over-publisher
              // attribution the card shows; reading the raw plugin here made
              // the detail contradict the tile the user just clicked.
              author:
                entry.authorName ?? (pluginOverride ?? resolved.plugin).author,
              description: entry.description,
              homepage: (pluginOverride ?? resolved.plugin).homepage,
              logoUrl: entry.logoUrl,
              bundledLogo: entry.bundledLogo,
              brandMark: entry.brandMark,
              categories: entry.categories,
              components: entry.components,
            }}
            alternatives={entry.alsoAvailableFrom}
            onOpenEntryId={onOpenEntry}
            McpServerLogoComponent={McpServerLogo}
          />
        </DetailShell>
      );
    }
    return (
      <DetailShell
        title={entry.name}
        presentation={presentation}
        onClose={onClose}
        // `PluginDetailView` draws its own Back; the shell must not stack a
        // second one above it (the web portal detail follows the same rule).
        // Its `onBack` below carries the destination instead.
      >
        <PluginDetailView
          mcpTarget={mcpTarget}
          autoInstall={initialIntent === 'add' || pluginAddOpen}
          plugin={pluginOverride ?? resolved.plugin}
          sharedContent={
            ownPluginShare ? (
              <SharedByYou
                kind="plugin"
                shareId={ownPluginShare.externalId}
                name={ownPluginShare.name}
                facts={ownPluginShare}
                // The installed plugin stays; only its share goes.
                onUnshared={(audience): void => {
                  if (audience.id === 'public') {
                    afterPublicLinkRemoved('plugin', ownPluginShare.name);
                    return;
                  }
                  onSharedResourceUnshared?.(
                    'plugin',
                    ownPluginShare.externalId,
                  );
                  refreshSharedList('plugin');
                  postShareToast({
                    tone: 'success',
                    message: marketplaceUnsharedNotice(ownPluginShare.name),
                    blockMessageFromReplay: true,
                  });
                }}
              />
            ) : undefined
          }
          headerIcon={
            <McpServerLogo
              logoUrl={entry.logoUrl}
              bundledLogo={entry.bundledLogo}
              brandMark={entry.brandMark}
              name={entry.name}
              size={40}
              fallback="monogram"
              fit="contain"
            />
          }
          marketplace={resolved.marketplace}
          shareAction={shareAction}
          renderPrimaryAction={({ onInstall, busy }) =>
            pluginTryIt(onInstall, busy)
          }
          alternatives={entry.alsoAvailableFrom}
          onOpenSource={openSource(resolved.marketplace.id)}
          onOpenEntryId={onOpenEntry}
          bundledServerRows={entry.bundledServerRows}
          // A page leaves through its breadcrumb (CAN-4261); the plugin's
          // own Back still closes an open component view.
          onBack={
            preferCatalogDetail && initialIntent === 'view'
              ? (): void => setPluginAddOpen(false)
              : (onNavigateBack ??
                (presentation === 'page' ? undefined : onClose))
          }
          onPluginUpdated={(updated) =>
            handlePluginUpdated(
              resolved.marketplace.id,
              marketplacePluginName,
              updated,
            )
          }
          statusContent={
            <InstalledEntryStatusSection
              entry={entry}
              onUninstalled={onClose}
              onManageSource={openSource(resolved.marketplace.id)}
            />
          }
          relatedContent={
            <CapabilityRelatedSections
              flush
              presentation="list"
              subject={{
                kind: 'plugin',
                marketplaceId: resolved.marketplace.id,
                pluginName: marketplacePluginName,
              }}
              subjectEntryId={entry.id}
              onBeforeNavigate={onClose}
              onOpenEntry={onOpenEntry}
              onOpenPipeline={onOpenPipeline}
            />
          }
        />
      </DetailShell>
    );
  }

  if (ref.type === 'skill') {
    return (
      <InstalledSkillDetail
        displayName={entry.name}
        skill={{
          sourceId: ref.sourceId,
          name: ref.skillName,
          ...(initialSkillFilePath ? { filePath: initialSkillFilePath } : {}),
        }}
        installedSkill={installedSkills.find(
          (skill) =>
            skill.sourceId === ref.sourceId && skill.name === ref.skillName,
        )}
        presentation={presentation}
        onClose={onClose}
        onNavigateBack={onNavigateBack}
        onRenamed={
          onInstalledSkillRenamed
            ? (name): void =>
                onInstalledSkillRenamed({ sourceId: ref.sourceId, name })
            : undefined
        }
        editing={skillEditing}
        onEditingChange={onSkillEditingChange}
        onSharedSkillsChanged={onSharedSkillsChanged}
        onOpenAccountSettings={onOpenAccountSettings}
        relatedContent={
          <>
            <InstalledEntryStatusSection
              entry={entry}
              onUninstalled={onClose}
              headerOwnsRemoval
            />
            <CapabilityRelatedSections
              presentation="list"
              subject={{
                kind: 'skill',
                sourceId: ref.sourceId,
                skillName: ref.skillName,
              }}
              subjectEntryId={entry.id}
              onBeforeNavigate={onClose}
              onOpenEntry={onOpenEntry}
              onOpenPipeline={onOpenPipeline}
            />
          </>
        }
      />
    );
  }

  if (ref.type === 'shared-skill') {
    const summary =
      sharedSkillOverride ??
      sharedSkills.find((skill) => skill.id === ref.skillId);
    if (!summary) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    const skillInstallLink = sharedResourceInstallLink({
      entity: 'skill',
      externalId: summary.id,
      scope: summary.shareScope,
    });
    return (
      <>
        <SharedSkillDetailModal
          key={`${summary.id}:${summary.contentHash}`}
          mode="view"
          summary={summary}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
          onUpdated={(updated) => setSharedSkillOverride(updated)}
          onSwitchToEdit={() => setEditingSharedSkill(true)}
          shareAction={shareAction}
          unshareOptions={(detail) =>
            unshareOptions({
              kind: 'skill',
              shareId: detail.id,
              name: detail.name,
              owner: detail.owner,
              canDelete: detail.canDelete,
            })
          }
          renderSharedByYou={(detail, refresh, refreshAfterPublish) => (
            <SharedByYou
              kind="skill"
              shareId={detail.id}
              name={detail.name}
              facts={detail}
              onRefresh={refreshAfterPublish}
              onUnshared={(audience): void => {
                if (audience.id === 'public') void refresh();
                sharedByYouUnshared('skill', detail.id, detail.name)(audience);
              }}
            />
          )}
          {...(skillInstallLink !== null
            ? {
                // The shared install review (CAN-3710) installs the skill and
                // lands on it.
                onAdd: (): void => {
                  useNavigationStore
                    .getState()
                    .openShareInstall(skillInstallLink, 'in-app');
                },
              }
            : {})}
          {...(onOpenEntry
            ? {
                onOpenInstalled: (skillName: string): void =>
                  onOpenEntry(
                    entryIdForSelection(
                      {
                        kind: 'skill',
                        sourceId: CUSTOM_SKILL_SOURCE_ID,
                        skillName,
                      },
                      marketplaces,
                    ),
                  ),
              }
            : {})}
        />
        {editingSharedSkill && (
          <SharedSkillDetailModal
            mode="edit"
            summary={summary}
            onClose={() => setEditingSharedSkill(false)}
            onUpdated={(updated) => {
              setSharedSkillOverride(updated);
              setEditingSharedSkill(false);
              void onSharedSkillsChanged();
            }}
            onSwitchToEdit={() => undefined}
          />
        )}
      </>
    );
  }

  if (ref.type === 'local-collection') {
    const collection = localCollections.find(
      (candidate) => candidate.id === ref.collectionId,
    );
    if (!collection) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    return (
      <CollectionModal
        key={`${collection.id}:${collection.updatedAt}`}
        collectionId={collection.id}
        presentation={presentation}
        readOnly
        onNavigateBack={onNavigateBack}
        onClose={onClose}
        onSaved={onLocalCollectionsChanged}
        onDeleted={onClose}
        onEditorOpenChange={setEditingCollection}
        onShare={enabledShareAction?.onShare}
      />
    );
  }

  if (ref.type === 'shared-collection') {
    const summary =
      sharedCollectionOverride ??
      sharedCollections.find(
        (collection) => collection.id === ref.collectionId,
      );
    if (!summary) {
      return (
        <MissingEntryDetail
          name={entry.name}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      );
    }
    const collectionInstallLink = sharedResourceInstallLink({
      entity: 'collection',
      externalId: summary.id,
      scope: summary.shareScope,
    });
    return (
      <>
        <SharedCollectionDetailModal
          key={`${summary.id}:${summary.contentHash}`}
          mode="view"
          summary={summary}
          presentation={presentation}
          onNavigateBack={onNavigateBack}
          onClose={onClose}
          onUpdated={(updated) => setSharedCollectionOverride(updated)}
          {...(sharedCollectionEditAvailable
            ? { onSwitchToEdit: (): void => setEditingCollection(true) }
            : {})}
          renderUnshare={(detail) =>
            renderUnshare({
              kind: 'collection',
              shareId: detail.id,
              name: detail.name,
              owner: detail.owner,
              canDelete: detail.canDelete,
            })
          }
          renderSharedByYou={(detail, refresh, refreshAfterPublish) => (
            <SharedByYou
              kind="collection"
              shareId={detail.id}
              name={detail.name}
              facts={detail}
              onRefresh={refreshAfterPublish}
              onUnshared={(audience): void => {
                if (audience.id === 'public') void refresh();
                sharedByYouUnshared(
                  'collection',
                  detail.id,
                  detail.name,
                )(audience);
              }}
            />
          )}
          {...(collectionInstallLink !== null
            ? {
                // The shared install review (CAN-3710) installs it and lands
                // on the installed collection.
                onAdd: (): Promise<void> => {
                  useNavigationStore
                    .getState()
                    .openShareInstall(collectionInstallLink, 'in-app');
                  return Promise.resolve();
                },
              }
            : {})}
        />
        {sharedCollectionEditAvailable && editingCollection && (
          <SharedCollectionDetailModal
            mode="edit"
            summary={summary}
            onClose={() => setEditingCollection(false)}
            onUpdated={(updated) => {
              setSharedCollectionOverride(updated);
              setEditingCollection(false);
              void onSharedCollectionsChanged();
            }}
          />
        )}
      </>
    );
  }

  // A card with a plugin or a provider connector folded into it keeps its
  // integrated detail even when an account connection backs it: that detail
  // is the only place the folded plugin's install and the connector route
  // live (REG-3033). Every other account row has no local device file and
  // uses its read-only account details instead. Device connections share a
  // summary before their editor.
  // The account connection backs the card only when the card resolved to
  // the account: a device file for the key keeps status, Connect, and the
  // editor on that one device server. A desktop-only card passes its account
  // connection whatever backs it, only so the detail can disconnect it.
  const accountConnection =
    selectedAccountConnection ??
    localServer?.accountConnection ??
    (ref.type === 'curated-mcp' &&
    (accountServerId !== null || curatedDesktopOnly)
      ? flattenMcpServerRows(mcpServers).find(
          (server) =>
            server.scope === 'account' && server.curatedKey === ref.key,
        )?.accountConnection
      : undefined);
  const accountConnectionBehindDevice =
    ref.type === 'curated-mcp' &&
    installedCurated.deviceId !== null &&
    !curatedDesktopOnly
      ? flattenMcpServerRows(mcpServers).find(
          (server) =>
            server.scope === 'account' && server.curatedKey === ref.key,
        )?.accountConnection
      : undefined;

  const connectionSource = curatedEntry
    ? { entry: curatedEntry }
    : localServer
      ? { localServer }
      : null;
  if (!connectionSource) {
    return (
      <MissingEntryDetail
        name={entry.name}
        presentation={presentation}
        onNavigateBack={onNavigateBack}
        onClose={onClose}
      />
    );
  }
  // A provider connector folded into this card (REG-3033) signs in through a
  // Claude or Codex account instead of a connection of the app's own. It
  // renders as its own Provider connections section: after the app's MCP
  // server and its tools when the catalog offers an app connection path, and
  // alone for provider-only entries (Gmail, Calendar, Drive). Add from the
  // card lands here rather than starting the direct sign-in, so the user
  // picks the route; starting the provider route also installs the folded
  // plugin. Add shows only while nothing on the card is connected, when the
  // app's section has no projects or tools yet, so both routes sit near the
  // top of the detail.
  const foldedConnector = entry.integration?.connector;
  const mcpName = localServer?.name ?? curatedEntry?.name ?? entry.name;
  const mcpCapability: TryItCapability = curatedEntry
    ? {
        kind: 'mcp',
        sourceId: CURATED_MCP_TRY_IT_SOURCE_ID,
        catalogId: curatedEntry.key,
        name: mcpName,
      }
    : {
        kind: 'mcp',
        sourceId: LOCAL_MCP_TRY_IT_SOURCE_ID,
        catalogId: localServer?.id ?? entry.id,
        name: mcpName,
      };
  const mcpPrompt = buildTryItPrompt({
    kind: 'mcp',
    name: mcpName,
    description: curatedEntry?.shortDescription ?? entry.description,
    tryNowPrompt: curatedEntry?.tryNowPrompt,
  });
  const requestFoldedPluginInstall = (): void => {
    if (initialIntent === 'add' && foldedPluginKey)
      setFoldedPluginInstallRequest((count) => count + 1);
  };
  return (
    <DetailShell
      title={mcpName}
      presentation={presentation}
      onClose={onClose}
      onNavigateBack={onNavigateBack}
      shareAction={shareAction}
      fluid={mcpSignInOpen}
    >
      <>
        <McpAccountConnectionPicker
          connections={accountConnections}
          value={
            selectedAccountConnection?.id ??
            (installedCuratedServerId ? null : (accountConnection?.id ?? null))
          }
          onChange={setSelectedAccountConnectionId}
          deviceAvailable={installedCuratedServerId !== null}
          disabled={
            curatedDetailBusy ||
            accountSignIn?.isPending(
              accountConnection
                ? accountMcpConnectionKey(accountConnection)
                : (installedCuratedServerId ??
                    (curatedEntry
                      ? accountMcpConfigurationKey(curatedEntry.key)
                      : '')),
            )
          }
        />
        <CuratedMcpConnectionDetail
          // Keyed by the entry that was opened (an account row's id carries its
          // configuration), never by the binding behind it: the connection Add
          // creates must not remount the detail and replay its Add (REG-3033).
          key={`${entry.id}:${selectedAccountConnection?.id ?? 'primary'}`}
          {...connectionSource}
          onSignInBrowserChange={setMcpSignInOpen}
          statusContent={
            <InstalledEntryStatusSection
              entry={entry}
              onUninstalled={onClose}
              onManageSource={
                entry.ref.type === 'marketplace-plugin'
                  ? openSource(entry.ref.marketplaceId)
                  : undefined
              }
            />
          }
          installedServerId={
            selectedAccountConnection && !curatedDesktopOnly
              ? null
              : ref.type === 'local-mcp'
                ? localServer?.scope === 'account'
                  ? null
                  : ref.serverId
                : installedCuratedServerId
          }
          // Add on an existing account binding that is not connected
          // reconnects it at once; a connected binding never reaches Add. A
          // desktop-only card's account connection binds nothing, so Add
          // always creates (or signs in) its device server.
          autoConnect={
            initialIntent === 'add' &&
            selectedAccountConnectionId === undefined &&
            foldedConnector === undefined &&
            (curatedDesktopOnly || accountConnection?.status !== 'CONNECTED')
          }
          accountConnectionsAvailable={accountConnectionsAvailable}
          accountSignIn={accountSignIn}
          accountConnection={accountConnection}
          accountConnectionBehindDevice={accountConnectionBehindDevice}
          foldedPlugin={entry.integration?.plugin}
          installFoldedPluginRequest={foldedPluginInstallRequest}
          providerConnections={
            foldedConnector && (
              <div
                className="min-w-0"
                data-testid="plugins-entry-connector-binding"
              >
                <ProviderConnectorDetail
                  variant="section"
                  displayName={foldedConnector.displayName}
                  results={providerConnectors}
                  curatedMcpServers={curatedMcpServers}
                  loading={providerConnectorsLoading}
                  onConnectStarted={requestFoldedPluginInstall}
                  onConnected={onProviderConnectorsChanged}
                />
              </div>
            )
          }
          renderPrimaryAction={(primary) => (
            <TryItPrimaryCta
              capability={mcpCapability}
              prompt={mcpPrompt}
              installation={primary.installation}
              runtimeSelections={
                primary.mcpServerRef
                  ? {
                      skillRefs: [],
                      pluginRefs: [],
                      mcpServerRefs: [primary.mcpServerRef],
                    }
                  : undefined
              }
              onInstall={primary.onInstall}
              installLabel={primary.installLabel}
              installBusy={primary.installBusy}
              installBusyLabel="Connecting…"
              guestInstallAction={primary.secondaryInstallAction}
            />
          )}
          onServersChanged={onServersChanged}
          onEditorOpenChange={setCuratedEditorOpen}
          onBusyChange={setCuratedDetailBusy}
          onDeleted={onNavigateBack ?? onClose}
        />
      </>
    </DetailShell>
  );
}

/**
 * The source object disappeared between the projection and the click — e.g. a
 * marketplace was removed, or the curated catalog refreshed. Say so instead of
 * rendering nothing, which would look like a dead row.
 */
function MissingEntryDetail({
  name,
  presentation,
  onNavigateBack,
  onClose,
}: {
  name: string;
  presentation: 'modal' | 'page';
  /**
   * A stale entry is the state most in need of an exit — there is nothing on
   * the page to act on — so it takes the same Back as every other branch
   * rather than leaving the breadcrumb and Escape as the only routes.
   */
  onNavigateBack?: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <DetailShell
      title={name}
      presentation={presentation}
      onNavigateBack={onNavigateBack}
      onClose={onClose}
    >
      <p className="text-s fg-secondary">
        This item is no longer available. Refresh and try again.
      </p>
    </DetailShell>
  );
}
