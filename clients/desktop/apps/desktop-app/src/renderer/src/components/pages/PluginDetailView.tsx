import {
  DetailFactError,
  type DetailVersionUpdate,
  type PluginMcpNavigationTarget,
} from '@canopy/ui-shared/components';
import {
  marketplaceDisplayName,
  linkRecordedAppError,
  pluginDisplayName,
  Notice,
  type UnifiedEntryAlternative,
  type UnifiedEntryBundledServerRow,
} from '@canopy/ui-shared';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ClaudeModAdmissionControl,
  PluginDetailHost,
  type PluginDetailHostPlugin,
  type PluginDetailHostProps,
  type PluginDetailInstallRequest,
  type PluginDetailInstallResult,
} from '@canopy/ui-app/capability';
import type {
  PluginDetailComponentContent,
  PluginDetailComponentType,
  PluginDetailFacetSlot,
} from '@canopy/ui-shared/components';
import type {
  MarketplaceInfo,
  PluginInfo,
  SelectedOfficialCodexListing,
} from '@canopy/execution-engine/types/plugins';
import type { PluginStandInCandidate } from '@canopy/protocol/plugins';
import { pluginInfoHarnessRows } from '@canopy/plugin-interop/harness-support';
import { claudeModPluginId } from '@canopy/protocol/claude-mods';
import { brandText } from '@/lib/brand';
import {
  applyCodexCompatDisabledToMarketplaceCaches,
  applyHarnessInstallsToMarketplaceCaches,
  marketplaceSourceOperations,
} from '@/hooks/useMarketplaceList';
import { useShareAccess } from '@/hooks/useShareAccess';
import { usePluginMcpServerHealth } from '@/hooks/usePluginMcpServerHealth';
import { useItemHarnessInstall } from '@/hooks/useItemHarnessInstall';
import { useOfferedPluginHarnesses } from '@/hooks/useOfferedPluginHarnesses';
import { useCustomizeDiscoveryEnabled } from '@canopy/ui-app/customize-discovery';
import { computePluginShareableRef } from '@/hooks/useUnifiedTableData';
import { SharePluginModal } from '@/components/plugins/SharePluginModal';
import { pluginNeedsInstall } from '../../lib/pluginInstallStatus';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { officialMarketplaceProvider } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { formatDate } from '../../lib/format';
import { installDesktopCustomizeTelemetry } from '../../lib/customizeTelemetry';

// Customize analytics (CAN-6806); no visible effect.
installDesktopCustomizeTelemetry();

function resultError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Harness rows for an installed plugin, through the shared row rule. */
const installedPluginHarnessRows = pluginInfoHarnessRows;

/** Desktop IPC adapter for the browser-safe shared full-plugin composition. */
export function PluginDetailView({
  plugin,
  marketplace,
  onBack,
  onPluginUpdated,
  relatedContent,
  statusContent,
  sharedContent,
  headerActions,
  headerIcon,
  autoInstall = false,
  shareAction,
  mcpTarget,
  renderPrimaryAction,
  renderProviderCatalog,
  alternatives,
  onOpenEntryId,
  onOpenSource,
  bundledServerRows,
  standIn,
  publisher,
  versionUpdate,
}: {
  /** New Customize: the tile's publisher line. */
  publisher?: ReactNode;
  /** New Customize: an available update, for the Version row. */
  versionUpdate?: DetailVersionUpdate;
  onOpenSource?: () => void;
  /**
   * The publisher's MCP server one Add installs where this plugin's ChatGPT
   * app doesn't run (CAN-6818), as the catalog grouping picked it.
   */
  standIn?: PluginStandInCandidate;
  mcpTarget?: PluginMcpNavigationTarget;
  plugin: PluginInfo;
  marketplace: MarketplaceInfo;
  /** Omitted on a page, whose breadcrumb is the way back (CAN-4261). */
  onBack?: () => void;
  onPluginUpdated: (updated: PluginInfo) => void;
  relatedContent?: ReactNode;
  /** The installed-item Status row, right under the plugin's metadata. */
  statusContent?: ReactNode;
  /** The owner's "Shared by you" section, after the install area. */
  sharedContent?: ReactNode;
  headerActions?: ReactNode;
  headerIcon?: ReactNode;
  /** Install right away, for the Marketplace's Add. Nothing signs in here. */
  autoInstall?: boolean;
  /**
   * The Marketplace's resolved Share (CAN-3704), whose flow the page owns.
   * Omitted elsewhere, where the detail shares a plugin with a public source.
   */
  shareAction?: MarketplaceShareAction;
  /** The shared Try it CTA, shown while the detail has no Install action. */
  renderPrimaryAction?: (action: {
    onInstall: () => void;
    busy: boolean;
  }) => ReactNode;
  renderProviderCatalog?: PluginDetailHostProps['renderProviderCatalog'];
  /** The same app from other catalogs (CAN-3653). */
  alternatives?: readonly UnifiedEntryAlternative[];
  onOpenEntryId?: (entryId: string) => void;
  /** Installed MCP rows hidden behind this plugin; each opens its settings. */
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
}): JSX.Element {
  const [shareOpen, setShareOpen] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState('');
  const { requestShare, shareGateModal } = useShareAccess();
  const shareableRef = useMemo(
    () => computePluginShareableRef(plugin, marketplace),
    [marketplace, plugin],
  );
  const needsInstall = pluginNeedsInstall(plugin);
  const showingProviderCatalog = renderProviderCatalog !== undefined;
  const mcpConnectTarget = useMemo(
    () =>
      needsInstall || showingProviderCatalog
        ? undefined
        : { marketplaceId: marketplace.id, pluginName: plugin.name },
    [marketplace.id, needsInstall, plugin.name, showingProviderCatalog],
  );
  const mcpServerHealth = usePluginMcpServerHealth(
    bundledServerRows,
    mcpConnectTarget,
  );
  // List only the harnesses this build offers; the gates are its own flags.
  const harnesses = useOfferedPluginHarnesses();
  const autoInstallStarted = useRef(false);
  const onPluginUpdatedRef = useRef(onPluginUpdated);
  onPluginUpdatedRef.current = onPluginUpdated;
  const [autoInstalling, setAutoInstalling] = useState(false);
  const [autoInstallError, setAutoInstallError] = useState('');
  // The auto-install failure text main already recorded; its notice records nothing.
  const [recordedAutoInstallError, setRecordedAutoInstallError] = useState('');
  // One Add for every harness (CAN-6816): New Customize only.
  const installForHarnesses = useItemHarnessInstall();
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const [harnessInstallNotice, setHarnessInstallNotice] = useState('');
  // The plugin as this page last rendered it: a change made while harness
  // discovery runs (Codex compatibility turned off, say) must survive the
  // record landing.
  const latestPluginRef = useRef(plugin);
  latestPluginRef.current = plugin;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const runHarnessInstalls = useCallback(
    (installed: PluginInfo): Promise<void> =>
      installForHarnesses(
        {
          kind: 'plugin',
          marketplaceId: installed.marketplaceId,
          pluginName: installed.name,
        },
        standIn,
      ).then((outcome) => {
        // Only the record joins the rows: every mounted cache gets it on the
        // plugin's current row, so a record landing after this page closed
        // never replaces a newer row. While this page still shows the plugin,
        // its own copy gets the record too.
        if (outcome.kind === 'recorded' && outcome.record !== null) {
          applyHarnessInstallsToMarketplaceCaches(
            installed.marketplaceId,
            installed.name,
            outcome.record,
          );
          const latest = latestPluginRef.current;
          if (
            mountedRef.current &&
            latest.marketplaceId === installed.marketplaceId &&
            latest.name.toLowerCase() === installed.name.toLowerCase()
          )
            onPluginUpdatedRef.current({
              ...latest,
              harnessInstalls: outcome.record,
            });
        } else if (outcome.kind === 'failed')
          setHarnessInstallNotice(outcome.message);
      }),
    [installForHarnesses, standIn],
  );
  const recordHarnessInstalls = useCallback(
    (installed: PluginInfo): void => {
      void runHarnessInstalls(installed);
    },
    [runHarnessInstalls],
  );
  // The page's own Add for missing copies: held until it settles, so a
  // second click never starts an overlapping Add.
  const [addingCopies, setAddingCopies] = useState(false);
  const addingCopiesRef = useRef(false);
  const addHarnessCopies = useCallback((): void => {
    if (addingCopiesRef.current) return;
    addingCopiesRef.current = true;
    setAddingCopies(true);
    void runHarnessInstalls(latestPluginRef.current).finally(() => {
      addingCopiesRef.current = false;
      if (mountedRef.current) setAddingCopies(false);
    });
  }, [runHarnessInstalls]);
  const sourceUrl =
    typeof plugin.externalSource === 'string'
      ? plugin.externalSource
      : (plugin.externalSource?.url ?? '');
  useEffect(() => {
    if (!autoInstall || !needsInstall || autoInstallStarted.current) return;
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release) return;
    autoInstallStarted.current = true;
    let cancelled = false;
    setAutoInstalling(true);
    void window.plugins
      .installPlugin(marketplace.id, plugin.name, sourceUrl)
      .then((result) => {
        // Leaving details does not cancel installation. Keep the marketplace
        // cache in sync even after this view has unmounted.
        if (result.success && result.data) {
          onPluginUpdatedRef.current(result.data);
          recordHarnessInstalls(result.data);
        } else if (!cancelled) {
          const message = result.error ?? 'Unable to install. Try again.';
          // Main recorded it; the notice records nothing but links it to this session.
          linkRecordedAppError(result.appError, 'plugin-detail-auto-install');
          setRecordedAutoInstallError(
            result.appError?.recordedBy !== undefined ? message : '',
          );
          setAutoInstallError(message);
        }
      })
      .catch((cause) => {
        if (!cancelled) setAutoInstallError(resultError(cause).message);
      })
      .finally(() => {
        release();
        if (!cancelled) setAutoInstalling(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    autoInstall,
    needsInstall,
    marketplace.id,
    plugin.name,
    sourceUrl,
    recordHarnessInstalls,
  ]);

  useEffect(() => {
    setCompatibilityError('');
    if (
      showingProviderCatalog ||
      needsInstall ||
      plugin.providerSupport.codex !== 'compat' ||
      plugin.codexCompatDisabled === true ||
      plugin.facets.codex ||
      plugin.facets.codexCompatibility
    )
      return;
    let cancelled = false;
    void window.plugins
      .prepareCodexCompatibilityPlugin(plugin.marketplaceId, plugin.name)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          onPluginUpdated(result.data);
        } else {
          setCompatibilityError(
            result.error ?? 'Failed to prepare Codex compatibility details.',
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setCompatibilityError(resultError(error).message);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsInstall, onPluginUpdated, plugin, showingProviderCatalog]);

  const readComponent = useCallback(
    async (
      _componentType: PluginDetailComponentType,
      componentFile: string,
      activeFacet: PluginDetailFacetSlot | undefined,
    ): Promise<PluginDetailComponentContent | null> => {
      const facet = activeFacet?.facet;
      const facetInstallRoot = facet?.cachePath ?? facet?.installLocation;
      const effectiveInstallLocation =
        facetInstallRoot ?? plugin.cachePath ?? marketplace.installLocation;
      const effectiveSourcePath = facetInstallRoot
        ? ''
        : (facet?.sourcePath ?? (plugin.cachePath ? '' : plugin.sourcePath));
      const result = await window.plugins.readComponentContent(
        effectiveInstallLocation,
        effectiveSourcePath,
        componentFile,
      );
      if (result.success && result.data) return result.data;
      if (result.error) throw new Error(result.error);
      return null;
    },
    [marketplace.installLocation, plugin.cachePath, plugin.sourcePath],
  );

  const install = async (
    request: PluginDetailInstallRequest,
  ): Promise<PluginDetailInstallResult> => {
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release)
      throw new Error(
        'This marketplace is busy. Try again when the current operation finishes.',
      );
    try {
      setAutoInstallError('');
      if (request.kind === 'providers') {
        let selectedOfficialCodexListing:
          | SelectedOfficialCodexListing
          | undefined;
        if (
          discoveryEnabled &&
          plugin.marketplaceId === marketplace.id &&
          officialMarketplaceProvider(marketplace.id) === 'Codex' &&
          request.providers.length === 1 &&
          request.providers[0] === 'codex'
        ) {
          const facet = plugin.facets?.codex;
          const { marketplacePath, marketplaceName } =
            marketplace.providerStatus?.codex ?? {};
          if (
            facet?.mode === 'native' &&
            facet.name &&
            marketplacePath &&
            marketplaceName &&
            (facet.marketplacePath === undefined ||
              facet.marketplacePath === marketplacePath)
          ) {
            selectedOfficialCodexListing = {
              marketplacePath,
              marketplaceName,
              pluginName: facet.name,
            };
          }
        }
        const result = await window.plugins.installBuiltInPlugin({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          providers: request.providers,
          ...(selectedOfficialCodexListing
            ? { selectedOfficialCodexListing }
            : {}),
        });
        if (!result.success || !result.data)
          throw Object.assign(new Error(result.error ?? 'Unknown error.'), {
            appError: result.appError,
          });
        onPluginUpdated(result.data.plugin);
        recordHarnessInstalls(result.data.plugin);
        return result.data;
      }
      if (!plugin.externalSource)
        throw new Error('Plugin has no external source.');
      const sourceUrl =
        typeof plugin.externalSource === 'string'
          ? plugin.externalSource
          : (plugin.externalSource.url ?? '');
      const result = await window.plugins.installPlugin(
        marketplace.id,
        plugin.name,
        sourceUrl,
      );
      if (!result.success || !result.data)
        throw Object.assign(
          new Error(result.error ?? 'Failed to install plugin.'),
          { appError: result.appError },
        );
      onPluginUpdated(result.data);
      recordHarnessInstalls(result.data);
      return { plugin: result.data };
    } finally {
      release();
    }
  };

  const toggleCodexCompat = async (
    disabled: boolean,
  ): Promise<PluginDetailHostPlugin> => {
    try {
      const result = await window.plugins.setCodexCompatDisabled(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      if (!result.success || !result.data)
        throw new Error(
          result.error ?? 'Failed to update Codex compatibility setting.',
        );
      applyCodexCompatDisabledToMarketplaceCaches(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      onPluginUpdated(result.data);
      return result.data;
    } catch (error) {
      throw resultError(error);
    }
  };

  // A Marketplace host resolves Share itself, so the card, detail and click
  // agree. Other hosts keep the local rule: Share only with a public source.
  const resolvedShareAction: MarketplaceShareAction | undefined =
    shareAction ??
    (shareableRef
      ? {
          status: 'shareable',
          onShare: (): void => {
            requestShare(
              {
                title: 'Sign in to share plugins',
                description:
                  'Connect your account to create a public plugin link.',
              },
              () => setShareOpen(true),
            );
          },
        }
      : undefined);

  return (
    <>
      <PluginDetailHost
        plugin={plugin}
        modsControl={
          <ClaudeModAdmissionControl
            pluginId={claudeModPluginId(
              plugin.facets?.claude?.name ?? plugin.name,
              plugin.marketplaceId,
            )}
          />
        }
        mcpTarget={mcpTarget}
        onBack={onBack}
        loadDetail={(): Promise<PluginInfo> => Promise.resolve(plugin)}
        readComponent={readComponent}
        onInstall={install}
        shareAction={resolvedShareAction}
        onToggleCodexCompat={toggleCodexCompat}
        relatedContent={relatedContent}
        headerActions={headerActions}
        renderPrimaryAction={renderPrimaryAction}
        renderProviderCatalog={renderProviderCatalog}
        alternatives={alternatives}
        // New Customize: an installed plugin's missing native copies, added
        // through the same one Add for every harness.
        {...(discoveryEnabled && !needsInstall && !addingCopies
          ? { onAddHarnessCopies: addHarnessCopies }
          : {})}
        onOpenSource={onOpenSource}
        sourceName={marketplaceDisplayName(marketplace.name)}
        onOpenEntryId={onOpenEntryId}
        bundledServerRows={bundledServerRows}
        mcpServerHealth={mcpServerHealth}
        headerIcon={headerIcon}
        publisher={publisher}
        versionUpdate={versionUpdate}
        // New Customize: Add's failures sit under Works with, not below
        // the page.
        worksWithNotice={
          discoveryEnabled && (autoInstallError || harnessInstallNotice) ? (
            <div className="flex flex-col gap-1 text-s">
              {autoInstallError && (
                <DetailFactError
                  error={autoInstallError}
                  testId="plugin-detail-auto-install-error"
                />
              )}
              {harnessInstallNotice && (
                <DetailFactError
                  error={harnessInstallNotice}
                  tone="attention"
                  testId="plugin-detail-harness-install-error"
                />
              )}
            </div>
          ) : undefined
        }
        statusContent={statusContent}
        sharedContent={sharedContent}
        // Where an installed plugin runs: every offered harness, signed in or not.
        harnessRows={
          !needsInstall
            ? installedPluginHarnessRows(plugin, harnesses, discoveryEnabled)
            : undefined
        }
        needsInstall={needsInstall}
        loading={autoInstalling}
        brandName={brandText.appName}
        compatibilityError={compatibilityError}
        formatDate={formatDate}
      />
      {autoInstallError && !discoveryEnabled && (
        <Notice
          errorSource="plugin-detail-auto-install"
          errorRecordingDisabled={autoInstallError === recordedAutoInstallError}
          intent="destructive"
        >
          {autoInstallError}
        </Notice>
      )}
      {harnessInstallNotice && !discoveryEnabled && (
        <Notice errorSource="plugin-detail-harness-install" intent="attention">
          {harnessInstallNotice}
        </Notice>
      )}
      {shareOpen && shareableRef && (
        <SharePluginModal
          pluginRef={shareableRef}
          name={pluginDisplayName(plugin)}
          description={plugin.description}
          onClose={() => setShareOpen(false)}
        />
      )}
      {shareGateModal}
    </>
  );
}
